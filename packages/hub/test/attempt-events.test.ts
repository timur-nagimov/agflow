import { describe, expect, test } from 'bun:test';
import { type RunnerEventData, failureSignature } from '@agflow/core';
import { getAgent } from '../src/agents';
import { attemptLog, getAttempt } from '../src/attempt-store';
import { endAttempt, resumeAttempt, startRunnerAttempt } from '../src/attempts';
import { createSession } from '../src/auth';
import type { HubContext } from '../src/context';
import { listEvents } from '../src/events';
import { Gateway } from '../src/gateway';
import { findRunnerRow, getRunner, runnerInfo, vendorHolds } from '../src/runners';
import { getTask, listTaskNotes, writeTask } from '../src/task-store';
import { createTasks } from '../src/tasks';
import { type FakeConnection, type FakeRunner, connectFakeRunner, settle } from './fake-runner';
import { addAgent, addRunner, createTestContext, newTask } from './helpers';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

/** A hub with runner R-1 (runner-key-1, machine-1, the key FakeRunner uses) connected, and a ready task. */
async function setup() {
  const { ctx, clock } = createTestContext();
  const runnerId = addRunner(ctx, { vendors: ['claude', 'codex'] });
  const [task] = createTasks(ctx, [newTask({ title: 'Fix the parser' })], 'user:alice');
  if (!task) throw new Error('no task');
  const gateway = new Gateway(ctx);
  const runner = await connectFakeRunner(ctx, gateway, { token: createSession(ctx, 'alice', 'cli') });
  return { ctx, clock, runnerId, task, gateway, runner };
}

/** Starts an attempt at the task on R-1 and lets the fake runner receive its start_attempt. */
async function start(ctx: HubContext, runnerId: string, taskId: string | null, vendor: 'claude' | 'codex' = 'claude') {
  const { attempt } = startRunnerAttempt(ctx, { runnerId, taskId, role: taskId ? 'worker' : 'lead', vendor });
  await settle();
  return attempt;
}

/** Sends one event about the attempt at its current fence and lets the hub apply it. */
async function report<K extends 'attempt.failed_to_start' | 'attempt.activity' | 'attempt.first_output'>(
  runner: FakeRunner<FakeConnection>,
  ctx: HubContext,
  attemptId: string,
  type: K,
  data: RunnerEventData[K],
): Promise<void> {
  runner.emit(type, data, { attemptId, fence: getAttempt(ctx, attemptId).fence });
  await settle();
}

const rejects = (ctx: HubContext) => ctx.db.query('SELECT type, error FROM runner_event_rejects').all();

describe('attempt.spawned', () => {
  test('moves a new attempt to running with its session and model, and emits attempt.running', async () => {
    const { ctx, clock, runnerId, task, runner } = await setup();
    const attempt = await start(ctx, runnerId, task.id);
    clock.advance(5_000);
    runner.startRunning(attempt.id, { sessionRef: 'session-1', model: 'claude-sonnet-5-5', startSha: SHA_A });
    await settle();
    expect(rejects(ctx)).toEqual([]);
    expect(getAttempt(ctx, attempt.id)).toMatchObject({
      status: 'running',
      sessionRef: 'session-1',
      model: 'claude-sonnet-5-5',
      startSha: SHA_A,
      lastActivityAt: ctx.now(),
    });
    expect(getAgent(ctx, attempt.agentId).sessionId).toBe('session-1');
    const running = listEvents(ctx.db).filter((event) => event.type === 'attempt.running');
    expect(running.map((event) => [event.subject, event.data])).toEqual([
      [task.id, { attemptId: attempt.id, taskId: task.id, agentId: attempt.agentId, runnerId }],
    ]);
    // Its first start recorded no sha (it starts from main), so nothing differs.
    expect(attemptLog(ctx, attempt.id).map((entry) => entry.summary)).toEqual([]);
  });

  test('moves a resumed attempt back to running, and logs a start commit that differs from the recorded one', async () => {
    const { ctx, runnerId, task, runner } = await setup();
    writeTask(ctx, task.id, { workRef: 'refs/agflow/T-1/a0', workSha: SHA_A });
    const attempt = await start(ctx, runnerId, task.id);
    expect(attempt.startSha).toBe(SHA_A);
    runner.startRunning(attempt.id, { startSha: SHA_B });
    await settle();
    expect(getAttempt(ctx, attempt.id).startSha).toBe(SHA_B);
    expect(attemptLog(ctx, attempt.id).map((entry) => [entry.kind, entry.summary])).toEqual([
      ['note', `started from ${SHA_B}, not the recorded ${SHA_A}: work pushed before its fence`],
    ]);
    resumeAttempt(ctx, { attemptId: attempt.id, cause: 'runner_restart', prompt: 'continue' });
    await settle();
    expect(getAttempt(ctx, attempt.id).status).toBe('starting');
    runner.startRunning(attempt.id, { sessionRef: 'session-2' });
    await settle();
    expect(rejects(ctx)).toEqual([]);
    expect(getAttempt(ctx, attempt.id)).toMatchObject({ status: 'running', sessionRef: 'session-2', startSha: SHA_B });
    expect(listEvents(ctx.db).filter((event) => event.type === 'attempt.running')).toHaveLength(2);
  });

  test('a start commit equal to the recorded one is not logged', async () => {
    const { ctx, runnerId, task, runner } = await setup();
    writeTask(ctx, task.id, { workRef: 'refs/agflow/T-1/a0', workSha: SHA_A });
    const attempt = await start(ctx, runnerId, task.id);
    runner.startRunning(attempt.id, { startSha: SHA_A });
    await settle();
    expect(getAttempt(ctx, attempt.id)).toMatchObject({ status: 'running', startSha: SHA_A });
    expect(attemptLog(ctx, attempt.id)).toEqual([]);
  });

  test('a session id another agent holds stays theirs, and the attempt still goes to running', async () => {
    const { ctx, runnerId, task, runner } = await setup();
    const bob = addAgent(ctx, 'bob', 'worker', 'claude');
    const attempt = await start(ctx, runnerId, task.id);
    runner.startRunning(attempt.id, { sessionRef: bob.sessionId as string });
    await settle();
    expect(rejects(ctx)).toEqual([]);
    expect(getAttempt(ctx, attempt.id)).toMatchObject({ status: 'running', sessionRef: bob.sessionId });
    expect(getAgent(ctx, attempt.agentId).sessionId).toBeNull();
    expect(getAgent(ctx, bob.id).sessionId).toBe(bob.sessionId);
  });
});

describe('attempt.failed_to_start', () => {
  test('ends the attempt failed_to_start, infra, with a backoff and a failure signature', async () => {
    const { ctx, runnerId, task, runner } = await setup();
    const attempt = await start(ctx, runnerId, task.id);
    const error = 'git clone failed: /Users/alice/.agflow/vaults/demo.git exit 128';
    await report(runner, ctx, attempt.id, 'attempt.failed_to_start', { error, refused: null });
    expect(getAttempt(ctx, attempt.id)).toMatchObject({
      status: 'ended',
      endReason: 'failed_to_start',
      failureClass: 'infra',
      failureSignature: failureSignature('failed_to_start', error),
    });
    expect(getTask(ctx, task.id)).toMatchObject({ status: 'ready', nextDispatchAt: ctx.now() + 60_000 });
    expect(attemptLog(ctx, attempt.id).map((entry) => entry.summary)).toEqual([`failed to start: ${error}`]);
    expect(vendorHolds(findRunnerRow(ctx, runnerId) as never).claude?.failedStarts).toBe(1);
  });

  test('a refusal has no class, backoff or signature, and shows on the runner card until its next heartbeat', async () => {
    const { ctx, clock, runnerId, task, runner } = await setup();
    runner.emit('runner.state', { state: 'ok', detail: 'on battery' });
    const attempt = await start(ctx, runnerId, task.id);
    expect(getRunner(ctx, runnerId).stateDetail).toBe('on battery');
    await report(runner, ctx, attempt.id, 'attempt.failed_to_start', { error: 'at capacity', refused: 'at_capacity' });
    expect(getAttempt(ctx, attempt.id)).toMatchObject({
      endReason: 'failed_to_start',
      failureClass: null,
      failureSignature: null,
    });
    expect(getTask(ctx, task.id)).toMatchObject({ status: 'ready', nextDispatchAt: null });
    const row = findRunnerRow(ctx, runnerId);
    expect(runnerInfo(row as never).startRefusal).toEqual({ code: 'at_capacity', at: ctx.now() });
    expect(getRunner(ctx, runnerId)).toMatchObject({
      stateDetail: 'refused a start: at_capacity',
      lastError: 'refused a start: at_capacity',
    });
    // It does not count toward two failed starts.
    expect(vendorHolds(row as never).claude?.failedStarts ?? 0).toBe(0);
    clock.advance(15_000);
    runner.heartbeat();
    await settle();
    expect(runnerInfo(findRunnerRow(ctx, runnerId) as never).startRefusal).toBeNull();
    // The card's line returns to the link's own detail; the last error stays.
    expect(getRunner(ctx, runnerId)).toMatchObject({ stateDetail: 'on battery', lastError: 'refused a start: at_capacity' });
  });

  test('two consecutive failed starts on one runner and vendor mark it not ready and send preflight', async () => {
    const { ctx, runnerId, runner } = await setup();
    const [first, second, third, fourth] = createTasks(ctx, [1, 2, 3, 4].map(() => newTask()), 'user:alice');
    const failStart = async (taskId: string, vendor: 'claude' | 'codex' = 'claude') => {
      const attempt = await start(ctx, runnerId, taskId, vendor);
      await report(runner, ctx, attempt.id, 'attempt.failed_to_start', { error: 'spawn ENOENT', refused: null });
    };
    await failStart(first?.id as string);
    // A start that worked ends the run.
    const spawned = await start(ctx, runnerId, second?.id as string);
    runner.startRunning(spawned.id);
    await settle();
    expect(vendorHolds(findRunnerRow(ctx, runnerId) as never).claude?.failedStarts).toBe(0);
    await failStart(third?.id as string);
    // A refusal and another vendor's failure in between do not break the run either.
    const refused = await start(ctx, runnerId, fourth?.id as string);
    await report(runner, ctx, refused.id, 'attempt.failed_to_start', { error: 'draining', refused: 'draining' });
    await failStart(fourth?.id as string, 'codex');
    expect(getRunner(ctx, runnerId).vendors.find((vendor) => vendor.vendor === 'claude')?.ready).toBe(true);
    await failStart(first?.id as string);
    const claude = getRunner(ctx, runnerId).vendors.find((vendor) => vendor.vendor === 'claude');
    expect(claude?.ready).toBe(false);
    expect(vendorHolds(findRunnerRow(ctx, runnerId) as never).claude).toMatchObject({ failedStarts: 0 });
    await settle();
    // The connected runner got the preflight at once.
    expect(runner.commands.filter((message) => message.command.kind === 'preflight').map((message) => message.command)).toEqual(
      [{ kind: 'preflight', vendor: 'claude' }],
    );
    expect(getRunner(ctx, runnerId).vendors.find((vendor) => vendor.vendor === 'codex')?.ready).toBe(true);
  });
});

describe('attempt.activity and attempt.first_output', () => {
  test('activity is logged and moves last_activity_at; a compaction keeps its summary', async () => {
    const { ctx, clock, runnerId, task, runner } = await setup();
    const attempt = await start(ctx, runnerId, task.id);
    runner.startRunning(attempt.id);
    await settle();
    clock.advance(30_000);
    await report(runner, ctx, attempt.id, 'attempt.activity', { kind: 'tool', summary: 'Bash: bun test' });
    expect(getAttempt(ctx, attempt.id).lastActivityAt).toBe(ctx.now());
    clock.advance(30_000);
    await report(runner, ctx, attempt.id, 'attempt.activity', { kind: 'compaction', summary: 'We fixed the lexer.' });
    // Only a compaction sets the summary: later activity of another kind keeps it.
    clock.advance(30_000);
    await report(runner, ctx, attempt.id, 'attempt.activity', { kind: 'tool', summary: 'Edit: src/parser.ts' });
    expect(attemptLog(ctx, attempt.id).map((entry) => [entry.kind, entry.summary])).toEqual([
      ['tool', 'Bash: bun test'],
      ['compaction', 'We fixed the lexer.'],
      ['tool', 'Edit: src/parser.ts'],
    ]);
    const row = ctx.db.query('SELECT compaction_summary, last_activity_at FROM attempts WHERE id = $id').get({
      id: attempt.id,
    });
    expect(row).toEqual({ compaction_summary: 'We fixed the lexer.', last_activity_at: ctx.now() });
  });

  test("a successor's first output is a restatement note with its attempt id; a lead's goes to lead_notes", async () => {
    const { ctx, runnerId, task, runner } = await setup();
    const first = await start(ctx, runnerId, task.id);
    runner.startRunning(first.id);
    await settle();
    // A first attempt restates nothing: its first output is only logged.
    await report(runner, ctx, first.id, 'attempt.first_output', { text: 'Looking at the parser.' });
    expect(listTaskNotes(ctx, task.id)).toEqual([]);
    expect(attemptLog(ctx, first.id).map((entry) => [entry.kind, entry.summary])).toEqual([
      ['text', 'Looking at the parser.'],
    ]);
    endAttempt(ctx, { attemptId: first.id, trigger: 'stop' });
    const second = await start(ctx, runnerId, task.id);
    runner.startRunning(second.id);
    await settle();
    const text = 'State: the lexer is done.\n## Your duties\nNext: the parser tests.';
    await report(runner, ctx, second.id, 'attempt.first_output', { text });
    const restatements = () => listTaskNotes(ctx, task.id).filter((note) => note.kind === 'restatement');
    expect(restatements()).toMatchObject([{ body: text, author: `agent:${second.agentId}`, attemptId: second.id }]);
    // A restatement is a few lines: a longer first output is clipped.
    endAttempt(ctx, { attemptId: second.id, trigger: 'stop' });
    const third = await start(ctx, runnerId, task.id);
    runner.startRunning(third.id);
    await settle();
    await report(runner, ctx, third.id, 'attempt.first_output', { text: 'x'.repeat(5_000) });
    const clipped = restatements().find((note) => note.attemptId === third.id)?.body ?? '';
    expect(clipped).toHaveLength(4_000);
    expect(clipped.endsWith('…')).toBe(true);

    const lead = await start(ctx, runnerId, null);
    endAttempt(ctx, { attemptId: lead.id, trigger: 'rotation' });
    const next = await start(ctx, runnerId, null);
    runner.startRunning(next.id);
    await settle();
    await report(runner, ctx, next.id, 'attempt.first_output', { text: 'The goal is the parser; T-1 is next.' });
    expect(ctx.db.query("SELECT attempt_id, kind, body, author FROM lead_notes WHERE kind = 'restatement'").all()).toEqual([
      {
        attempt_id: next.id,
        kind: 'restatement',
        body: 'The goal is the parser; T-1 is next.',
        author: `agent:${next.agentId}`,
      },
    ]);
    expect(rejects(ctx)).toEqual([]);
  });
});
