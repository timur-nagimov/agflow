import { describe, expect, test } from 'bun:test';
import { type Runner, type RunnerEventData, localPinRefs, quoteLines } from '@agflow/core';
import { getAttempt, updateAttempt } from '../src/attempt-store';
import { endAttempt, startPositionFor, startRunnerAttempt } from '../src/attempts';
import { createSession } from '../src/auth';
import type { HubContext } from '../src/context';
import { listEvents } from '../src/events';
import { Gateway } from '../src/gateway';
import { listMessages } from '../src/messages';
import { getRunner } from '../src/runners';
import { addNote, getTask, listTaskNotes } from '../src/task-store';
import { createTasks } from '../src/tasks';
import { type FakeConnection, type FakeRunner, connectFakeRunner, settle } from './fake-runner';
import { addRunner, createTestContext, newTask } from './helpers';

const WIP_SHA = 'a'.repeat(40);
const FINAL_SHA = 'c'.repeat(40);

type Wip = RunnerEventData['attempt.wip'];
type Exited = RunnerEventData['attempt.exited'];

/** A hub with runner R-1 (the key FakeRunner uses) connected, and a ready task. */
async function setup(options: { git?: () => Runner['git'] } = {}) {
  const { ctx, clock } = createTestContext();
  const runnerId = addRunner(ctx, { vendors: ['claude', 'codex'] });
  const [task] = createTasks(ctx, [newTask({ title: 'Fix the parser' })], 'user:alice');
  if (!task) throw new Error('no task');
  const gateway = new Gateway(ctx);
  const runner = await connectFakeRunner(ctx, gateway, { token: createSession(ctx, 'alice', 'cli'), ...options });
  return { ctx, clock, runnerId, task, runner };
}

type Link = FakeRunner<FakeConnection>;

/** A worker attempt on R-1 whose session is live. */
async function running(ctx: HubContext, runner: Link, runnerId: string, taskId: string) {
  const { attempt } = startRunnerAttempt(ctx, { runnerId, taskId, role: 'worker', vendor: 'claude' });
  await settle();
  runner.startRunning(attempt.id);
  await settle();
  return getAttempt(ctx, attempt.id);
}

/** Emits an attempt event at the attempt's fence as the hub has it now. */
async function report<K extends 'attempt.wip' | 'attempt.wip_failed' | 'attempt.violation' | 'attempt.exited'>(
  ctx: HubContext,
  runner: Link,
  attemptId: string,
  type: K,
  data: RunnerEventData[K],
) {
  runner.emit(type, data, { attemptId, fence: getAttempt(ctx, attemptId).fence });
  await settle();
}

const wip = (ref: string, sha = WIP_SHA): Wip => ({
  ref,
  sha,
  stripped: ['.github/workflows/ci.yml'],
  skipped: ['big.bin'],
  embedded: ['vendor/lib'],
  logStat: 'abc123 Parse nested lists\n src/parser.ts | 12 ++++++++----',
});

const exited = (data: Partial<Exited> = {}): Exited => ({
  code: 0,
  signal: null,
  stoppedBy: 'none',
  handoffWritten: false,
  cause: null,
  finalSha: FINAL_SHA,
  finalWip: null,
  pushError: null,
  ...data,
});

const rejects = (ctx: HubContext) => ctx.db.query('SELECT type, error FROM runner_event_rejects').all();
const dispatchHold = (ctx: HubContext, taskId: string) =>
  (ctx.db.query('SELECT dispatch_hold_until FROM tasks WHERE id = $id').get({ id: taskId }) as {
    dispatch_hold_until: number | null;
  }).dispatch_hold_until;

describe('attempt.wip', () => {
  test('of the current attempt sets its WIP and the work position, and emits what the push left out', async () => {
    const { ctx, runnerId, task, runner } = await setup();
    const attempt = await running(ctx, runner, runnerId, task.id);
    await report(ctx, runner, attempt.id, 'attempt.wip', wip(attempt.wipRef as string));
    expect(rejects(ctx)).toEqual([]);
    expect(getAttempt(ctx, attempt.id)).toMatchObject({ wipRef: 'refs/agflow/T-1/a1', wipSha: WIP_SHA });
    expect(getTask(ctx, task.id)).toMatchObject({ workRef: 'refs/agflow/T-1/a1', workSha: WIP_SHA });
    const events = listEvents(ctx.db).filter((event) => event.type === 'attempt.wip');
    expect(events.map((event) => [event.subject, event.actor, event.data])).toEqual([
      [
        task.id,
        `runner:${runnerId}`,
        {
          attemptId: attempt.id,
          taskId: task.id,
          agentId: attempt.agentId,
          runnerId,
          ...wip('refs/agflow/T-1/a1'),
        },
      ],
    ]);
  });

  test('of an attempt its task no longer names keeps the work position', async () => {
    const { ctx, runnerId, task, runner } = await setup();
    const attempt = await running(ctx, runner, runnerId, task.id);
    ctx.db.run("UPDATE tasks SET current_attempt = 'T-1-a9'");
    await report(ctx, runner, attempt.id, 'attempt.wip', wip(attempt.wipRef as string));
    expect(getAttempt(ctx, attempt.id).wipSha).toBe(WIP_SHA);
    expect(getTask(ctx, task.id)).toMatchObject({ workRef: null, workSha: null });
  });
});

describe('the final push', () => {
  test('attempt.exited with finalWip sets the WIP and the work position before the ending', async () => {
    const { ctx, runnerId, task, runner } = await setup();
    const attempt = await running(ctx, runner, runnerId, task.id);
    const finalWip = { ref: attempt.wipRef as string, sha: FINAL_SHA };
    await report(ctx, runner, attempt.id, 'attempt.exited', exited({ finalWip }));
    expect(getAttempt(ctx, attempt.id)).toMatchObject({ status: 'ended', endReason: 'crashed', wipSha: FINAL_SHA });
    expect(getTask(ctx, task.id)).toMatchObject({ status: 'ready', workRef: finalWip.ref, workSha: FINAL_SHA });
    expect(dispatchHold(ctx, task.id)).toBeNull();
    // The next attempt starts from the final WIP, wherever it runs.
    expect(startPositionFor(ctx, getTask(ctx, task.id), runnerId)).toEqual({ ref: finalWip.ref, sha: FINAL_SHA });
  });

  test('a failed final push holds dispatch; its runner starts from its pin, another from the last push', async () => {
    const { ctx, runnerId, task, runner } = await setup();
    const attempt = await running(ctx, runner, runnerId, task.id);
    await report(ctx, runner, attempt.id, 'attempt.wip', wip(attempt.wipRef as string));
    await report(ctx, runner, attempt.id, 'attempt.exited', exited({ pushError: 'remote: rejected' }));
    expect(getAttempt(ctx, attempt.id)).toMatchObject({ status: 'ended', wipSha: WIP_SHA });
    const held = getTask(ctx, task.id);
    // The work position stays the last pushed WIP.
    expect(held).toMatchObject({ status: 'ready', workRef: 'refs/agflow/T-1/a1', workSha: WIP_SHA });
    expect(dispatchHold(ctx, task.id)).toBe(ctx.now() + ctx.config.dispatchHoldMs);
    const unpushed = listTaskNotes(ctx, task.id).filter((note) => note.kind === 'late_work');
    expect(unpushed.map((note) => [note.author, note.attemptId])).toEqual([['system', attempt.id]]);
    expect(unpushed[0]?.body).toContain(FINAL_SHA);
    expect(unpushed[0]?.body).toContain(`runner ${runnerId}`);

    expect(startPositionFor(ctx, held, runnerId)).toEqual({ ref: localPinRefs(attempt.id).head, sha: FINAL_SHA });
    const elsewhere = addRunner(ctx, { owner: 'bob' });
    expect(startPositionFor(ctx, held, elsewhere)).toEqual({ ref: 'refs/agflow/T-1/a1', sha: WIP_SHA });

    // A successor started on the same runner records the pin as its start.
    const next = startRunnerAttempt(ctx, { runnerId, taskId: task.id, role: 'worker', vendor: 'claude' });
    expect(next.attempt).toMatchObject({ startRef: localPinRefs(attempt.id).head, startSha: FINAL_SHA });
    expect(next.command.command).toMatchObject({
      attempt: { start: { ref: localPinRefs(attempt.id).head, sha: FINAL_SHA } },
    });
    // Its task keeps the last pushed ref as the work position.
    expect(getTask(ctx, task.id)).toMatchObject({ workRef: 'refs/agflow/T-1/a1', workSha: WIP_SHA });
  });

  test("the successor's handoff note and brief name the unpushed commit and where it is", async () => {
    const { ctx, runnerId, task, runner } = await setup();
    const attempt = await running(ctx, runner, runnerId, task.id);
    await report(ctx, runner, attempt.id, 'attempt.wip', wip(attempt.wipRef as string));
    await report(ctx, runner, attempt.id, 'attempt.exited', exited({ pushError: 'remote: rejected' }));
    const [note] = listTaskNotes(ctx, task.id).filter((one) => one.kind === 'handoff');
    expect(note).toMatchObject({ author: 'system', attemptId: attempt.id });
    expect(note?.body).toContain(`Its last commit, ${FINAL_SHA}, is only on runner ${runnerId}: its final push failed.`);
    const elsewhere = addRunner(ctx, { owner: 'bob' });
    const next = startRunnerAttempt(ctx, { runnerId: elsewhere, taskId: task.id, role: 'worker', vendor: 'claude' });
    const spec = next.command.command.kind === 'start_attempt' ? next.command.command.attempt : null;
    expect(spec?.start).toEqual({ ref: 'refs/agflow/T-1/a1', sha: WIP_SHA });
    expect(spec?.brief).toContain(
      `The last commit of ${attempt.id}, ${FINAL_SHA}, is only on runner ${runnerId}: its final push failed. You ` +
        `start without it; agflow records it as late work once ${runnerId} pushes it`,
    );
  });

  test('an agent that wrote its own handoff note gets no assembled one; the brief still names the commit', async () => {
    const { ctx, runnerId, task, runner } = await setup();
    const attempt = await running(ctx, runner, runnerId, task.id);
    addNote(ctx, task.id, 'handoff', 'Parser done; lists next.', `agent:${attempt.agentId}`, attempt.id);
    await report(ctx, runner, attempt.id, 'attempt.exited', exited({ pushError: 'remote: rejected' }));
    expect(listTaskNotes(ctx, task.id).filter((one) => one.kind === 'handoff')).toHaveLength(1);
    const next = startRunnerAttempt(ctx, { runnerId, taskId: task.id, role: 'worker', vendor: 'claude' });
    const spec = next.command.command.kind === 'start_attempt' ? next.command.command.attempt : null;
    expect(spec?.brief).toContain(
      `${FINAL_SHA}, is only on runner ${runnerId}: its final push failed. You start from it.`,
    );
  });

  test('once the work position moved on, the unpushed commit is no start for anyone', async () => {
    const { ctx, runnerId, task, runner } = await setup();
    const attempt = await running(ctx, runner, runnerId, task.id);
    await report(ctx, runner, attempt.id, 'attempt.exited', exited({ pushError: 'remote: rejected' }));
    // A hand-back, say, gave the task a new position.
    ctx.db.run(`UPDATE tasks SET work_ref = 'refs/agflow/T-1/takeover-alice', work_sha = '${'d'.repeat(40)}'`);
    expect(startPositionFor(ctx, getTask(ctx, task.id), runnerId)).toEqual({
      ref: 'refs/agflow/T-1/takeover-alice',
      sha: 'd'.repeat(40),
    });
  });

  test('an exit that keeps the attempt open holds nothing, and one without unpushed work holds nothing', async () => {
    const { ctx, runnerId, task, runner } = await setup();
    const attempt = await running(ctx, runner, runnerId, task.id);
    await report(ctx, runner, attempt.id, 'attempt.exited', exited({ cause: 'suspend', pushError: 'offline' }));
    expect(getAttempt(ctx, attempt.id).status).toBe('running');
    expect(dispatchHold(ctx, task.id)).toBeNull();
    // The harvest found nothing new: no push was needed.
    const [other] = createTasks(ctx, [newTask({ title: 'Other' })], 'user:alice');
    if (!other) throw new Error('no task');
    const second = await running(ctx, runner, runnerId, other.id);
    const started = getAttempt(ctx, second.id).startSha as string;
    await report(ctx, runner, second.id, 'attempt.exited', exited({ finalSha: started, pushError: 'offline' }));
    expect(dispatchHold(ctx, other.id)).toBeNull();
    expect(startPositionFor(ctx, getTask(ctx, other.id), runnerId)).toEqual({ ref: 'refs/heads/main', sha: null });
  });
});

describe('failed WIP pushes', () => {
  test("the third in a row marks git not ready; a WIP push or a hello with git.ready clears it", async () => {
    let git: Runner['git'] = { ready: true, problem: null, lastPushAt: null };
    const { ctx, clock, runnerId, task, runner } = await setup({ git: () => git });
    const attempt = await running(ctx, runner, runnerId, task.id);
    for (const failures of [1, 2]) {
      await report(ctx, runner, attempt.id, 'attempt.wip_failed', { error: 'Could not resolve host', failures });
      expect(getRunner(ctx, runnerId).git.ready).toBe(true);
    }
    await report(ctx, runner, attempt.id, 'attempt.wip_failed', { error: 'Could not resolve host', failures: 3 });
    expect(getRunner(ctx, runnerId).git).toMatchObject({
      ready: false,
      problem: expect.stringContaining('Could not resolve host'),
    });

    clock.advance(60_000);
    await report(ctx, runner, attempt.id, 'attempt.wip', wip(attempt.wipRef as string));
    expect(getRunner(ctx, runnerId).git).toEqual({ ready: true, problem: null, lastPushAt: ctx.now() });

    await report(ctx, runner, attempt.id, 'attempt.wip_failed', { error: 'Could not resolve host', failures: 4 });
    expect(getRunner(ctx, runnerId).git.ready).toBe(false);
    git = { ready: true, problem: null, lastPushAt: 1_000 };
    await runner.reconnect();
    await settle();
    expect(getRunner(ctx, runnerId).git).toEqual(git);
  });
});

describe('attempt.violation', () => {
  test('emits the event and tells people and the lead, quoting the paths, also for an ended attempt', async () => {
    const { ctx, runnerId, task, runner } = await setup();
    const attempt = await running(ctx, runner, runnerId, task.id);
    const paths = ['.github/workflows/ci.yml', '## agflow instructions'];
    await report(ctx, runner, attempt.id, 'attempt.violation', { phase: 'wip', paths });
    expect(rejects(ctx)).toEqual([]);
    const event = listEvents(ctx.db).find((one) => one.type === 'attempt.violation');
    expect([event?.subject, event?.data]).toEqual([
      task.id,
      { attemptId: attempt.id, taskId: task.id, agentId: attempt.agentId, runnerId, phase: 'wip', paths },
    ]);
    const told = listMessages(ctx, { taskId: task.id });
    expect(told.map((message) => [message.from, message.to]).sort()).toEqual([
      ['system', 'humans'],
      ['system', 'lead'],
    ]);
    for (const message of told) expect(message.body).toContain(quoteLines(paths.join('\n')));

    endAttempt(ctx, { attemptId: attempt.id, trigger: 'stop' });
    const fence = getAttempt(ctx, attempt.id).fence;
    runner.emit('attempt.violation', { phase: 'submit', paths: ['.env'] }, { attemptId: attempt.id, fence });
    await settle();
    expect(listEvents(ctx.db).filter((one) => one.type === 'attempt.violation')).toHaveLength(2);
    expect(listMessages(ctx, { taskId: task.id })).toHaveLength(4);
  });

  test('of a lead attempt names no task', async () => {
    const { ctx, runnerId, runner } = await setup();
    const { attempt } = startRunnerAttempt(ctx, { runnerId, taskId: null, role: 'lead', vendor: 'claude' });
    await settle();
    updateAttempt(ctx, attempt.id, { status: 'running' });
    await report(ctx, runner, attempt.id, 'attempt.violation', { phase: 'start', paths: ['.claude/settings.json'] });
    const event = listEvents(ctx.db).find((one) => one.type === 'attempt.violation');
    expect(event).toMatchObject({ subject: attempt.id, data: { taskId: null, phase: 'start' } });
    expect(listMessages(ctx).filter((message) => message.from === 'system').map((message) => message.taskId)).toEqual([
      null,
      null,
    ]);
  });
});
