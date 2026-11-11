import { describe, expect, test } from 'bun:test';
import { type Attempt, type AttemptFacts, attemptId } from '@agflow/core';
import { getAgent } from '../src/agents';
import { getAttempt, insertAttempt, issueFence, nextAttemptNumber, updateAttempt } from '../src/attempt-store';
import { expireRunnerLeases, expireStops, factsAreFresh, requestStop, startRunnerAttempt } from '../src/attempts';
import { createSession, mintAgentToken, resolveAgentToken } from '../src/auth';
import type { HubContext } from '../src/context';
import { listEvents } from '../src/events';
import { Gateway } from '../src/gateway';
import { getHubState } from '../src/hub-state';
import { listMessages } from '../src/messages';
import { getTask, listTaskNotes } from '../src/task-store';
import { createTasks } from '../src/tasks';
import { type FakeConnection, type FakeRunner, connectFakeRunner, settle } from './fake-runner';
import { addAgent, addRunner, createTestContext, newTask } from './helpers';

const MINUTE = 60_000;

/** The facts a runner reports for one attempt; the fence is the attempt's unless given. */
function factsOf(attempt: Attempt, overrides: Partial<AttemptFacts> = {}): AttemptFacts {
  return {
    attemptId: attempt.id,
    fence: attempt.fence,
    phase: 'turn',
    eventAgeMs: 5_000,
    tool: null,
    fsAgeMs: 20_000,
    commitAgeMs: null,
    turns: 3,
    turnsWithoutProgress: 0,
    repeatedCalls: 0,
    continuations: 1,
    vendorErrorMs: 0,
    activeMs: 90_000,
    contextUsed: 0.42,
    ...overrides,
  };
}

/**
 * A hub with runner R-1 (the key FakeRunner uses) connected; the runner's heartbeats carry whatever facts the test
 * puts in `reported`.
 */
async function setup() {
  const { ctx, clock } = createTestContext();
  const runnerId = addRunner(ctx, { vendors: ['claude', 'codex'] });
  const gateway = new Gateway(ctx);
  const reported: { facts: AttemptFacts[] } = { facts: [] };
  const runner = await connectFakeRunner(ctx, gateway, {
    token: createSession(ctx, 'alice', 'cli'),
    facts: () => reported.facts,
  });
  return { ctx, clock, runnerId, runner, reported, gateway };
}

/** A worker attempt on R-1 at a new task, its session live unless told otherwise. */
async function attemptOn(ctx: HubContext, runner: FakeRunner<FakeConnection>, runnerId: string, spawn = true) {
  const [task] = createTasks(ctx, [newTask({ title: 'Fix the parser' })], 'user:alice');
  const { attempt } = startRunnerAttempt(ctx, { runnerId, taskId: task?.id as string, role: 'worker', vendor: 'claude' });
  await settle();
  if (spawn) {
    runner.startRunning(attempt.id);
    await settle();
  }
  return getAttempt(ctx, attempt.id);
}

async function heartbeat(runner: FakeRunner<FakeConnection>): Promise<void> {
  runner.heartbeat();
  await settle();
}

const factsRow = (ctx: HubContext, attemptId: string) =>
  ctx.db.query('SELECT facts, facts_at, phase, active_ms FROM attempts WHERE id = $id').get({ id: attemptId }) as {
    facts: string | null;
    facts_at: number | null;
    phase: string | null;
    active_ms: number;
  };

describe('heartbeats and runner leases', () => {
  test("renew the leases of listed starting, running and quota_wait attempts at their fence, and their agents' last_seen_at", async () => {
    const { ctx, clock, runnerId, runner, reported } = await setup();
    const starting = await attemptOn(ctx, runner, runnerId, false);
    const running = await attemptOn(ctx, runner, runnerId);
    const waiting = await attemptOn(ctx, runner, runnerId);
    updateAttempt(ctx, waiting.id, { status: 'quota_wait' });
    const unlisted = await attemptOn(ctx, runner, runnerId);
    const otherFence = await attemptOn(ctx, runner, runnerId);
    clock.advance(5 * MINUTE);
    reported.facts = [
      factsOf(starting, { phase: 'starting' }),
      factsOf(running),
      factsOf(waiting, { phase: 'quota_wait' }),
      factsOf(otherFence, { fence: { ...otherFence.fence, counter: otherFence.fence.counter - 1 } }),
    ];
    await heartbeat(runner);
    const renewed = ctx.now() + ctx.config.runnerLeaseMs;
    for (const attempt of [starting, running, waiting]) {
      expect(getAttempt(ctx, attempt.id).leaseExpiresAt).toBe(renewed);
      expect(getAgent(ctx, attempt.agentId).lastSeenAt).toBe(ctx.now());
    }
    for (const attempt of [unlisted, otherFence]) {
      expect(getAttempt(ctx, attempt.id).leaseExpiresAt).toBe(attempt.leaseExpiresAt);
      expect(getAgent(ctx, attempt.agentId).lastSeenAt).toBe(ctx.now() - 5 * MINUTE);
    }
  });

  test('store facts, facts_at, phase, active_ms and contextUsed; facts of another fence are ignored', async () => {
    const { ctx, clock, runnerId, runner, reported } = await setup();
    const attempt = await attemptOn(ctx, runner, runnerId);
    reported.facts = [factsOf(attempt, { phase: 'waiting_approval', activeMs: 120_000, contextUsed: 0.71 })];
    await heartbeat(runner);
    const stored = factsRow(ctx, attempt.id);
    expect(stored).toMatchObject({ facts_at: ctx.now(), phase: 'waiting_approval', active_ms: 120_000 });
    expect(getAttempt(ctx, attempt.id)).toMatchObject({
      phase: 'waiting_approval',
      activeMs: 120_000,
      facts: reported.facts[0],
    });
    expect(getAttempt(ctx, attempt.id).facts?.contextUsed).toBe(0.71);
    clock.advance(15_000);
    reported.facts = [factsOf(attempt, { fence: { epoch: attempt.fence.epoch, counter: 9999 }, phase: 'idle' })];
    await heartbeat(runner);
    expect(factsRow(ctx, attempt.id)).toEqual(stored);
  });

  test('facts are fresh for two heartbeat intervals, and only from the current connection', async () => {
    const { ctx, clock, runnerId, runner, reported } = await setup();
    const attempt = await attemptOn(ctx, runner, runnerId);
    expect(factsAreFresh(ctx, attempt.id)).toBe(false);
    reported.facts = [factsOf(attempt)];
    await heartbeat(runner);
    clock.advance(2 * ctx.config.heartbeatMs);
    expect(factsAreFresh(ctx, attempt.id)).toBe(true);
    clock.advance(1);
    expect(factsAreFresh(ctx, attempt.id)).toBe(false);
    await heartbeat(runner);
    expect(factsAreFresh(ctx, attempt.id)).toBe(true);
    // A new link: what the old one reported is no longer fresh, though the facts themselves stay for the pages.
    await runner.reconnect();
    await settle();
    expect(factsAreFresh(ctx, attempt.id)).toBe(false);
    expect(factsRow(ctx, attempt.id)).toMatchObject({ facts_at: null, phase: 'turn' });
    expect(getAttempt(ctx, attempt.id).facts).not.toBeNull();
  });

  test('a link that closes with no new one leaves the runner unheard: its facts are no longer fresh', async () => {
    const { ctx, runnerId, runner, reported } = await setup();
    const attempt = await attemptOn(ctx, runner, runnerId);
    reported.facts = [factsOf(attempt)];
    await heartbeat(runner);
    expect(factsAreFresh(ctx, attempt.id)).toBe(true);
    runner.disconnect();
    await settle();
    expect(factsAreFresh(ctx, attempt.id)).toBe(false);
    expect(getAttempt(ctx, attempt.id)).toMatchObject({ status: 'running', phase: 'turn' });
  });

  test("another runner's hello and heartbeat leave this runner's attempts alone", async () => {
    const { ctx, clock, runnerId, runner, reported, gateway } = await setup();
    const attempt = await attemptOn(ctx, runner, runnerId);
    reported.facts = [factsOf(attempt)];
    await heartbeat(runner);
    const before = getAttempt(ctx, attempt.id);
    addRunner(ctx);
    clock.advance(1_000);
    const other = await connectFakeRunner(ctx, gateway, {
      token: createSession(ctx, 'alice', 'cli'),
      runnerKey: 'runner-key-2',
      machineId: 'machine-2',
      facts: () => [factsOf(attempt, { phase: 'idle', activeMs: 1 })],
    });
    expect(factsAreFresh(ctx, attempt.id)).toBe(true);
    await heartbeat(other);
    expect(getAttempt(ctx, attempt.id)).toMatchObject({
      leaseExpiresAt: before.leaseExpiresAt,
      phase: 'turn',
      activeMs: 90_000,
      facts: before.facts,
    });
  });

  test('holding, ended and live attempts hold no runner lease', async () => {
    const { ctx, clock, runnerId, runner, reported } = await setup();
    const holding = await attemptOn(ctx, runner, runnerId);
    updateAttempt(ctx, holding.id, { status: 'holding', leaseExpiresAt: null });
    const ended = await attemptOn(ctx, runner, runnerId);
    expireRunnerLeasesNow(ctx, clock, ended);
    const live = liveAttempt(ctx);
    clock.advance(MINUTE);
    reported.facts = [factsOf(holding, { phase: 'idle' }), factsOf(getAttempt(ctx, ended.id)), factsOf(live)];
    await heartbeat(runner);
    expect(getAttempt(ctx, holding.id).leaseExpiresAt).toBeNull();
    expect(getAttempt(ctx, ended.id).leaseExpiresAt).toBeNull();
    expect(factsRow(ctx, holding.id).facts_at).toBeNull();
    expect(getAttempt(ctx, live.id)).toMatchObject({ leaseExpiresAt: null, facts: null });
    clock.advance(ctx.config.runnerLeaseMs * 2);
    expect(expireRunnerLeases(ctx)).toBe(0);
    expect(getAttempt(ctx, holding.id).status).toBe('holding');
    expect(getAttempt(ctx, live.id)).toMatchObject({ status: 'running', leaseExpiresAt: null });
  });
});

/** A live chat's attempt: no runner and no runner lease; M1's task lease covers it (design 6.4). */
function liveAttempt(ctx: HubContext): Attempt {
  const [task] = createTasks(ctx, [newTask()], 'user:alice');
  const taskId = task?.id as string;
  const fence = issueFence(ctx);
  return insertAttempt(ctx, {
    id: attemptId(taskId, nextAttemptNumber(ctx, taskId), fence.epoch),
    taskId,
    number: 1,
    role: 'worker',
    agentId: addAgent(ctx).id,
    runnerId: null,
    vendor: 'claude',
    fence,
    status: 'running',
  });
}

/** Ends the attempt by letting its lease run out with nothing renewing it. */
function expireRunnerLeasesNow(ctx: HubContext, clock: { advance(ms: number): void }, attempt: Attempt): void {
  clock.advance((attempt.leaseExpiresAt as number) - ctx.now());
  expect(expireRunnerLeases(ctx)).toBe(1);
}

describe('expireRunnerLeases', () => {
  test('ends attempts lost, revokes their tokens, and sends a held task through stale to ready with a note', async () => {
    const { ctx, clock, runnerId, runner } = await setup();
    const attempt = await attemptOn(ctx, runner, runnerId);
    const token = mintAgentToken(ctx, attempt);
    clock.advance(ctx.config.runnerLeaseMs - 1);
    expect(expireRunnerLeases(ctx)).toBe(0);
    clock.advance(1);
    expect(expireRunnerLeases(ctx)).toBe(1);
    expect(getAttempt(ctx, attempt.id)).toMatchObject({
      status: 'ended',
      endReason: 'lost',
      failureClass: 'infra',
      failureSignature: null,
      leaseExpiresAt: null,
    });
    expect(() => resolveAgentToken(ctx, token)).toThrow(expect.objectContaining({ code: 'attempt_ended' }));
    const taskId = attempt.taskId as string;
    expect(getTask(ctx, taskId)).toMatchObject({ status: 'ready', assignee: null, nextDispatchAt: ctx.now() + MINUTE });
    expect(
      listEvents(ctx.db)
        .filter((event) => event.subject === taskId && event.type.startsWith('task.'))
        .map((event) => event.type),
    ).toEqual(['task.created', 'task.claimed', 'task.stale', 'task.ready']);
    const [note] = listTaskNotes(ctx, taskId);
    expect(note).toMatchObject({ kind: 'handoff', author: 'system', attemptId: attempt.id });
    expect(note?.body).toContain('ended lost');
    // The lead learns of it, as M1's lease sweep tells it of a stale task.
    expect(listMessages(ctx, {}).map((message) => [message.from, message.to, message.taskId, message.body])).toEqual([
      [
        'system',
        'lead',
        taskId,
        `${taskId} ("Fix the parser") went stale: its runner attempt ${attempt.id} on ${runnerId} was lost (no ` +
          'heartbeat for the runner lease). It is ready again.',
      ],
    ]);
  });

  test('a lease that runs out before the stop timeout ends the attempt lost, whatever stop was recorded', async () => {
    const { ctx, clock, runnerId, runner } = await setup();
    const attempt = await attemptOn(ctx, runner, runnerId);
    clock.advance(ctx.config.runnerLeaseMs - MINUTE);
    requestStop(ctx, { attemptId: attempt.id, cause: 'stop', reason: 'enough', by: 'user:alice' });
    clock.advance(MINUTE);
    expect(expireStops(ctx)).toBe(0);
    expect(expireRunnerLeases(ctx)).toBe(1);
    expect(getAttempt(ctx, attempt.id)).toMatchObject({ endReason: 'lost', failureClass: 'infra' });
    const taskId = attempt.taskId as string;
    expect(getTask(ctx, taskId)).toMatchObject({ status: 'ready', nextDispatchAt: ctx.now() + MINUTE });
    expect(listEvents(ctx.db, { subject: taskId }).some((event) => event.type === 'task.stale')).toBe(true);
  });

  test('a quota_wait attempt whose lease runs out ends lost', async () => {
    const { ctx, clock, runnerId, runner } = await setup();
    const attempt = await attemptOn(ctx, runner, runnerId);
    updateAttempt(ctx, attempt.id, { status: 'quota_wait' });
    clock.advance(ctx.config.runnerLeaseMs);
    expect(expireRunnerLeases(ctx)).toBe(1);
    expect(getAttempt(ctx, attempt.id)).toMatchObject({ status: 'ended', endReason: 'lost', failureClass: 'infra' });
  });

  test('a lead whose lease expires ends lost and empties the seat; a take-over in flight ends taken_over', async () => {
    const { ctx, clock, runnerId, runner } = await setup();
    const { attempt: lead } = startRunnerAttempt(ctx, { runnerId, taskId: null, role: 'lead', vendor: 'claude' });
    const taken = await attemptOn(ctx, runner, runnerId);
    requestStop(ctx, { attemptId: taken.id, cause: 'takeover', reason: 'alice takes it over', by: 'user:alice' });
    clock.advance(ctx.config.runnerLeaseMs);
    expect(expireRunnerLeases(ctx)).toBe(2);
    expect(getAttempt(ctx, lead.id)).toMatchObject({ status: 'ended', endReason: 'lost' });
    expect(getHubState(ctx).leadAgentId).toBeNull();
    expect(getAttempt(ctx, taken.id)).toMatchObject({ status: 'ended', endReason: 'taken_over', failureClass: null });
    expect(getTask(ctx, taken.taskId as string)).toMatchObject({ status: 'blocked', blockedKind: 'takeover' });
    // Neither ending sent a task through stale, so the lead is told nothing.
    expect(listMessages(ctx, {}).filter((message) => message.to === 'lead')).toEqual([]);
  });
});
