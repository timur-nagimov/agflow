import { describe, expect, test } from 'bun:test';
import { type Attempt, type RunnerEventData, failureSignature } from '@agflow/core';
import { getAgent } from '../src/agents';
import { getAttempt, updateAttempt } from '../src/attempt-store';
import {
  endAttempt,
  expireStops,
  exitedInTurn,
  recentResumes,
  requestStop,
  resumeAttempt,
  startRunnerAttempt,
} from '../src/attempts';
import { createSession } from '../src/auth';
import { enqueueCommand } from '../src/commands';
import { type HubContext, tx } from '../src/context';
import { listEvents } from '../src/events';
import { Gateway } from '../src/gateway';
import { getHubState } from '../src/hub-state';
import { ackMessages, listMessages, markDelivered, sendMessage } from '../src/messages';
import { getTask, listTaskNotes } from '../src/task-store';
import { createTasks } from '../src/tasks';
import { type FakeConnection, type FakeRunner, connectFakeRunner, settle } from './fake-runner';
import { addRunner, createTestContext, newTask } from './helpers';

const FINAL_SHA = 'c'.repeat(40);

type Exited = RunnerEventData['attempt.exited'];

/** A hub with runner R-1 (the key FakeRunner uses) connected, and a ready task. */
async function setup() {
  const { ctx, clock } = createTestContext();
  const runnerId = addRunner(ctx, { vendors: ['claude', 'codex'] });
  const [task] = createTasks(ctx, [newTask({ title: 'Fix the parser' })], 'user:alice');
  if (!task) throw new Error('no task');
  const gateway = new Gateway(ctx);
  const runner = await connectFakeRunner(ctx, gateway, { token: createSession(ctx, 'alice', 'cli') });
  return { ctx, clock, runnerId, task, runner };
}

/** An attempt on R-1 whose session is live: a worker at the task, or the lead when taskId is null. */
async function running(ctx: HubContext, runner: FakeRunner<FakeConnection>, runnerId: string, taskId: string | null) {
  const { attempt } = startRunnerAttempt(ctx, { runnerId, taskId, role: taskId ? 'worker' : 'lead', vendor: 'claude' });
  await settle();
  runner.startRunning(attempt.id);
  await settle();
  return getAttempt(ctx, attempt.id);
}

/** The runner reports the attempt's process gone, at the attempt's fence as the hub has it now. */
async function exit(ctx: HubContext, runner: FakeRunner<FakeConnection>, attemptId: string, data: Partial<Exited> = {}) {
  runner.emit(
    'attempt.exited',
    {
      code: 0,
      signal: null,
      stoppedBy: 'none',
      handoffWritten: false,
      cause: null,
      finalSha: FINAL_SHA,
      finalWip: null,
      pushError: null,
      ...data,
    },
    { attemptId, fence: getAttempt(ctx, attemptId).fence },
  );
  await settle();
  return getAttempt(ctx, attemptId);
}

const rejects = (ctx: HubContext) => ctx.db.query('SELECT type, error FROM runner_event_rejects').all();
const finalSha = (ctx: HubContext, attempt: Attempt) =>
  (ctx.db.query('SELECT final_sha FROM attempts WHERE id = $id').get({ id: attempt.id }) as { final_sha: string | null })
    .final_sha;

describe('attempt.exited after a stop request', () => {
  test("ends the attempt with the cause's reason and class and makes the on-exit move", async () => {
    const { ctx, runnerId, task, runner } = await setup();
    const attempt = await running(ctx, runner, runnerId, task.id);
    requestStop(ctx, { attemptId: attempt.id, cause: 'stall_silent', reason: 'no events for 10 min', by: 'system' });
    await settle();
    const ended = await exit(ctx, runner, attempt.id, { stoppedBy: 'close', code: null, signal: 'SIGTERM' });
    expect(rejects(ctx)).toEqual([]);
    expect(ended).toMatchObject({ status: 'ended', endReason: 'stalled', failureClass: 'agent', failureSignature: null });
    expect(finalSha(ctx, ended)).toBe(FINAL_SHA);
    expect(getTask(ctx, task.id)).toMatchObject({ status: 'ready', assignee: null, nextDispatchAt: null });
    // The agent wrote no handoff, so the hub assembled one.
    expect(listTaskNotes(ctx, task.id).map((note) => [note.kind, note.author, note.attemptId])).toEqual([
      ['handoff', 'system', attempt.id],
    ]);
  });

  test("the hub's own request decides, whatever the runner says caused the exit", async () => {
    const { ctx, runnerId, task, runner } = await setup();
    const attempt = await running(ctx, runner, runnerId, task.id);
    requestStop(ctx, { attemptId: attempt.id, cause: 'replace', reason: 'try codex', by: 'user:alice' });
    expect((await exit(ctx, runner, attempt.id, { cause: 'runner_stop' })).endReason).toBe('replaced');
  });

  test("an infra stop's failure signature names its cause, so only one cause repeated blocks the task", async () => {
    const { ctx, runnerId, task, runner } = await setup();
    const replaceFor = async (cause: 'quota' | 'vendor_error' | 'context') => {
      const attempt = await running(ctx, runner, runnerId, task.id);
      requestStop(ctx, { attemptId: attempt.id, cause, reason: `${cause} on ${attempt.id}`, by: 'system' });
      await settle();
      return exit(ctx, runner, attempt.id, { stoppedBy: 'close' });
    };
    const signatures = [];
    for (const cause of ['quota', 'vendor_error', 'context'] as const) {
      signatures.push((await replaceFor(cause)).failureSignature);
    }
    expect(signatures).toEqual(['replaced: quota', 'replaced: vendor_error', 'replaced: context']);
    expect(getTask(ctx, task.id).status).toBe('ready');
    await replaceFor('quota');
    expect(getTask(ctx, task.id).status).toBe('ready');
    await replaceFor('quota');
    expect(getTask(ctx, task.id)).toMatchObject({ status: 'blocked', blockedKind: 'replan' });
    const [notice] = listMessages(ctx, {}).filter((message) => message.to === 'lead');
    expect(notice?.body).toContain('> replaced: quota');
  });

  test('a stop that times out gets the same signature', async () => {
    const { ctx, clock, runnerId, task, runner } = await setup();
    const attempt = await running(ctx, runner, runnerId, task.id);
    requestStop(ctx, { attemptId: attempt.id, cause: 'auth', reason: 'the claude login expired', by: 'system' });
    clock.advance(ctx.config.stopGraceMs);
    expect(expireStops(ctx)).toBe(1);
    expect(getAttempt(ctx, attempt.id)).toMatchObject({ endReason: 'crashed', failureSignature: 'crashed: auth' });
  });
});

describe('attempt.exited without a stop request', () => {
  test("a runner's own stop ends it stopped, infra, without a backoff or a signature", async () => {
    const { ctx, runnerId, task, runner } = await setup();
    const attempt = await running(ctx, runner, runnerId, task.id);
    const ended = await exit(ctx, runner, attempt.id, { cause: 'runner_stop', stoppedBy: 'interrupt' });
    expect(ended).toMatchObject({ endReason: 'stopped', failureClass: 'infra', failureSignature: null });
    expect(getTask(ctx, task.id)).toMatchObject({ status: 'ready', nextDispatchAt: null });
  });

  test('a suspend keeps the attempt open, its lease running without renewal', async () => {
    const { ctx, clock, runnerId, task, runner } = await setup();
    const attempt = await running(ctx, runner, runnerId, task.id);
    clock.advance(60_000);
    const kept = await exit(ctx, runner, attempt.id, { cause: 'suspend', stoppedBy: 'sigterm', code: null });
    expect(kept).toMatchObject({ status: 'running', endReason: null, leaseExpiresAt: attempt.leaseExpiresAt });
    expect(finalSha(ctx, kept)).toBe(FINAL_SHA);
    expect(getTask(ctx, task.id).status).toBe('claimed');
  });

  test('an unrequested worker exit ends it crashed, infra, with a backoff and a signature', async () => {
    const { ctx, runnerId, task, runner } = await setup();
    const attempt = await running(ctx, runner, runnerId, task.id);
    const ended = await exit(ctx, runner, attempt.id, { code: 137 });
    expect(ended).toMatchObject({
      endReason: 'crashed',
      failureClass: 'infra',
      failureSignature: failureSignature('crashed', 'the agent exited with code 137'),
    });
    expect(getTask(ctx, task.id)).toMatchObject({ status: 'ready', nextDispatchAt: ctx.now() + 60_000 });
    const killed = await running(ctx, runner, runnerId, task.id);
    expect((await exit(ctx, runner, killed.id, { code: null, signal: 'SIGKILL' })).failureSignature).toBe(
      'crashed: the agent was killed by SIGKILL',
    );
  });
});

describe('a lead that exits on its own', () => {
  /** The lead resumed, as the next delivery or an exit in a turn resumes it, and its session live again. */
  const resume = async (ctx: HubContext, runner: FakeRunner<FakeConnection>, attemptId: string) => {
    resumeAttempt(ctx, { attemptId, cause: 'lead_exit', prompt: 'You exited; continue.' });
    await settle();
    runner.startRunning(attemptId);
    await settle();
  };

  test('goes to holding with the seat kept; the third exit within leadExitWindowMs ends it crashed', async () => {
    const { ctx, clock, runnerId, runner } = await setup();
    const lead = await running(ctx, runner, runnerId, null);
    const first = await exit(ctx, runner, lead.id);
    expect(first).toMatchObject({ status: 'holding', leaseExpiresAt: null, endReason: null });
    expect(getHubState(ctx).leadAgentId).toBe(lead.agentId);
    const holding = listEvents(ctx.db).filter((event) => event.type === 'attempt.holding');
    expect(holding.map((event) => [event.subject, event.data])).toEqual([
      [lead.id, { attemptId: lead.id, taskId: null, agentId: lead.agentId, runnerId, submissionId: null }],
    ]);
    // The exit is logged when it happens; the resume that follows adds nothing.
    expect(recentResumes(ctx, lead.id, 'lead_exit', ctx.config.leadExitWindowMs)).toBe(1);
    await resume(ctx, runner, lead.id);
    expect(recentResumes(ctx, lead.id, 'lead_exit', ctx.config.leadExitWindowMs)).toBe(1);
    expect((await exit(ctx, runner, lead.id, { code: 1 })).status).toBe('holding');
    clock.advance(10 * 60_000);
    await resume(ctx, runner, lead.id);
    const third = await exit(ctx, runner, lead.id, { code: 1 });
    expect(third).toMatchObject({ status: 'ended', endReason: 'crashed', failureClass: 'infra' });
    expect(getHubState(ctx).leadAgentId).toBeNull();
    expect(listEvents(ctx.db).filter((event) => event.type === 'lead.seat_changed').at(-1)?.data).toMatchObject({
      kind: 'none',
    });
  });

  test('exits are counted when they happen, not when the lead is resumed', async () => {
    const { ctx, clock, runnerId, runner } = await setup();
    const minute = 60_000;
    const lead = await running(ctx, runner, runnerId, null);
    // An idle exit at 0, resumed by a delivery at 59 minutes, then exits at 61 and 63: two within the hour.
    expect((await exit(ctx, runner, lead.id)).status).toBe('holding');
    clock.advance(59 * minute);
    await resume(ctx, runner, lead.id);
    clock.advance(2 * minute);
    expect((await exit(ctx, runner, lead.id)).status).toBe('holding');
    await resume(ctx, runner, lead.id);
    clock.advance(2 * minute);
    expect((await exit(ctx, runner, lead.id)).status).toBe('holding');
    expect(getHubState(ctx).leadAgentId).toBe(lead.agentId);
  });

  test('exits further apart than leadExitWindowMs never add up to a crash', async () => {
    const { ctx, clock, runnerId, runner } = await setup();
    const lead = await running(ctx, runner, runnerId, null);
    await exit(ctx, runner, lead.id);
    for (let n = 0; n < 3; n++) {
      clock.advance(ctx.config.leadExitWindowMs / 2 + 1);
      await resume(ctx, runner, lead.id);
      clock.advance(ctx.config.leadExitWindowMs / 2);
      expect((await exit(ctx, runner, lead.id)).status).toBe('holding');
    }
  });

  test("a lead's suspend keeps it running with its seat; the runner's own stop ends it stopped", async () => {
    const { ctx, runnerId, runner } = await setup();
    const lead = await running(ctx, runner, runnerId, null);
    const kept = await exit(ctx, runner, lead.id, { cause: 'suspend', stoppedBy: 'sigterm', code: null });
    expect(kept).toMatchObject({ status: 'running', endReason: null, leaseExpiresAt: lead.leaseExpiresAt });
    expect(getHubState(ctx).leadAgentId).toBe(lead.agentId);
    expect(listEvents(ctx.db).filter((event) => event.type === 'attempt.holding')).toEqual([]);
    expect(recentResumes(ctx, lead.id, 'lead_exit', ctx.config.leadExitWindowMs)).toBe(0);
    const stopped = await exit(ctx, runner, lead.id, { cause: 'runner_stop', stoppedBy: 'interrupt' });
    expect(stopped).toMatchObject({ status: 'ended', endReason: 'stopped', failureClass: 'infra' });
    expect(getHubState(ctx).leadAgentId).toBeNull();
  });

  test('exitedInTurn: the last phase was turn, or a message delivered to it is unacknowledged', async () => {
    const { ctx, runnerId, runner } = await setup();
    const lead = await running(ctx, runner, runnerId, null);
    updateAttempt(ctx, lead.id, { phase: 'idle' });
    expect(exitedInTurn(ctx, getAttempt(ctx, lead.id))).toBe(false);
    updateAttempt(ctx, lead.id, { phase: 'turn' });
    expect(exitedInTurn(ctx, getAttempt(ctx, lead.id))).toBe(true);
    updateAttempt(ctx, lead.id, { phase: 'idle' });
    const message = sendMessage(ctx, { from: 'user:bob', to: 'lead', body: 'Split T-1.' });
    tx(ctx, (emit) => markDelivered(ctx, emit, lead.agentId, [message.id]));
    expect(exitedInTurn(ctx, getAttempt(ctx, lead.id))).toBe(true);
    ackMessages(ctx, getAgent(ctx, lead.agentId), [message.id]);
    expect(exitedInTurn(ctx, getAttempt(ctx, lead.id))).toBe(false);
  });

  test('a stop the hub asked for ends a lead with its cause', async () => {
    const { ctx, runnerId, runner } = await setup();
    const lead = await running(ctx, runner, runnerId, null);
    requestStop(ctx, { attemptId: lead.id, cause: 'rotation', reason: '20 wake-ups', by: 'system' });
    expect(await exit(ctx, runner, lead.id)).toMatchObject({ status: 'ended', endReason: 'rotated' });
    expect(getHubState(ctx).leadAgentId).toBeNull();
  });
});

describe('exits that end nothing', () => {
  test('a holding attempt and one being taken over stay open', async () => {
    const { ctx, runnerId, task, runner } = await setup();
    const attempt = await running(ctx, runner, runnerId, task.id);
    // A recorded submission moves the attempt to holding as it sends hold_attempt (design 6.13).
    updateAttempt(ctx, attempt.id, { status: 'holding', leaseExpiresAt: null });
    enqueueCommand(ctx, runnerId, { kind: 'hold_attempt', attemptId: attempt.id, fence: attempt.fence });
    await settle();
    const holding = await exit(ctx, runner, attempt.id, { stoppedBy: 'close' });
    expect(holding).toMatchObject({ status: 'holding', endReason: null });
    expect(finalSha(ctx, holding)).toBe(FINAL_SHA);

    const [other] = createTasks(ctx, [newTask()], 'user:alice');
    const taken = await running(ctx, runner, runnerId, other?.id as string);
    requestStop(ctx, { attemptId: taken.id, cause: 'takeover', reason: 'alice takes it over', by: 'user:alice' });
    expect((await exit(ctx, runner, taken.id)).status).toBe('running');
    expect(getTask(ctx, other?.id as string)).toMatchObject({ status: 'blocked', blockedKind: 'takeover' });
    expect(rejects(ctx)).toEqual([]);
  });

  test('an exit of an ended attempt keeps its ending and records the final sha', async () => {
    const { ctx, runnerId, task, runner } = await setup();
    const attempt = await running(ctx, runner, runnerId, task.id);
    endAttempt(ctx, { attemptId: attempt.id, trigger: 'lost' });
    const after = await exit(ctx, runner, attempt.id, { code: 1 });
    expect(after).toMatchObject({ status: 'ended', endReason: 'lost', failureClass: 'infra' });
    expect(finalSha(ctx, after)).toBe(FINAL_SHA);
    expect(rejects(ctx)).toEqual([]);
  });
});
