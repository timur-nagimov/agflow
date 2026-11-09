import { describe, expect, test } from 'bun:test';
import { type RunnerEventData, TakeoverResponseSchema, takeoverAnywhereCommand } from '@agflow/core';
import { getAgent } from '../src/agents';
import { getAttempt, updateAttempt } from '../src/attempt-store';
import { expireRunnerLeases, expireStops, requestStop, startRunnerAttempt } from '../src/attempts';
import { createSession, mintAgentToken } from '../src/auth';
import { pendingCommands } from '../src/commands';
import { listEvents } from '../src/events';
import { Gateway } from '../src/gateway';
import { requestSubmission } from '../src/submissions';
import { getTask, isPathHolder } from '../src/task-store';
import { cancelTask, createTasks, unblockTask } from '../src/tasks';
import { type AnswerHooks, type FakeConnection, type FakeRunner, connectFakeRunner, settle } from './fake-runner';
import { addRunner, newTask } from './helpers';
import { createTestHub } from './http-helpers';

const WIP_SHA = 'a'.repeat(40);
const TAKEN_SHA = 'b'.repeat(40);
const TAKEOVER_REF = 'refs/agflow/T-1/takeover-alice';

type Hub = ReturnType<typeof createTestHub>;
type Link = FakeRunner<FakeConnection>;

const asPerson = (user = 'alice') => ({ user, via: 'web' }) as const;

const LOCAL = 'cd /clone && claude --resume session-1';
const ANYWHERE = 'git fetch origin refs/agflow/T-1/a1 && git switch -c agflow/T-1-fix-the-parser FETCH_HEAD';

/** What a runner reports once it prepared the clone for the person (design 6.12). */
const takenOver = (local: string | null = LOCAL): RunnerEventData['attempt.taken_over'] => ({
  commands: { local, anywhere: ANYWHERE },
  wipSha: TAKEN_SHA,
  error: null,
});

/**
 * A hub with runner R-1 connected and a worker attempt at T-1 running there, which has pushed a WIP. The fake runner
 * answers prepare_takeover with attempt.taken_over when reportTakeover is set, as a runner does once the clone is
 * ready.
 */
async function setup(options: { reportTakeover?: boolean; answers?: AnswerHooks } = {}) {
  const hub = createTestHub();
  const runnerId = addRunner(hub.ctx);
  const gateway = new Gateway(hub.ctx);
  const answers: AnswerHooks = { ...options.answers };
  if (options.reportTakeover) {
    answers.prepare_takeover = (command, runner) => {
      runner.emit('attempt.taken_over', takenOver(), { attemptId: command.attemptId, fence: command.fence });
      return { ok: true };
    };
  }
  const token = createSession(hub.ctx, 'alice', 'cli');
  const runner = await connectFakeRunner(hub.ctx, gateway, { token, answers });
  const [task] = createTasks(hub.ctx, [newTask({ title: 'Fix the parser' })], 'user:alice');
  if (!task) throw new Error('no task');
  const { attempt } = startRunnerAttempt(hub.ctx, { runnerId, taskId: task.id, role: 'worker', vendor: 'claude' });
  await settle();
  runner.startRunning(attempt.id);
  const wip = { ref: attempt.wipRef as string, sha: WIP_SHA, stripped: [], skipped: [], embedded: [], logStat: '' };
  runner.emit('attempt.wip', wip, { attemptId: attempt.id, fence: attempt.fence });
  await settle();
  return { hub, runnerId, runner, task, attemptId: attempt.id };
}

async function takeOver(hub: Hub, taskId = 'T-1', user = 'alice') {
  const answer = await hub.call('POST', `/api/tasks/${taskId}/takeover`, asPerson(user));
  await settle();
  return answer;
}

const sent = (runner: Link, kind: string) =>
  runner.commands.map((message) => message.command).filter((command) => command.kind === kind);
const eventsOf = (hub: Hub, type: string) => listEvents(hub.ctx.db).filter((event) => event.type === type);

describe('POST /api/tasks/:id/takeover', () => {
  test('a person in the browser gets 202 { attemptId }: stop and block recorded, prepare_takeover sent', async () => {
    const { hub, runner, attemptId } = await setup();
    const answer = await takeOver(hub);
    expect(answer.status).toBe(202);
    expect(TakeoverResponseSchema.parse(answer.json)).toEqual({ attemptId });
    // X-49: the requester is the actor string of a person.
    expect(getAttempt(hub.ctx, attemptId)).toMatchObject({
      status: 'running',
      stopRequested: { cause: 'takeover', reason: 'taken over by alice', by: 'user:alice', deferred: false },
    });
    expect(getTask(hub.ctx, 'T-1')).toMatchObject({
      status: 'blocked',
      blockedKind: 'takeover',
      blockedReason: 'taken over by alice',
    });
    const fence = getAttempt(hub.ctx, attemptId).fence;
    expect(sent(runner, 'prepare_takeover')).toEqual([{ kind: 'prepare_takeover', attemptId, fence, person: 'alice' }]);
    // The take-over asks for the handoff itself: no stop_attempt goes out.
    expect(sent(runner, 'stop_attempt')).toEqual([]);
  });

  test('an agent in quota_wait may be taken over too', async () => {
    const { hub, runner, attemptId } = await setup();
    updateAttempt(hub.ctx, attemptId, { status: 'quota_wait', quotaResetsAt: null });
    const answer = await takeOver(hub);
    expect(answer.status).toBe(202);
    expect(getAttempt(hub.ctx, attemptId).stopRequested).toMatchObject({ cause: 'takeover', by: 'user:alice' });
    expect(getTask(hub.ctx, 'T-1')).toMatchObject({ status: 'blocked', blockedKind: 'takeover' });
    expect(sent(runner, 'prepare_takeover')).toHaveLength(1);
  });

  test('409 submission_pending while a submission is pending', async () => {
    const { hub, attemptId } = await setup();
    const attempt = getAttempt(hub.ctx, attemptId);
    requestSubmission(hub.ctx, 'T-1', getAgent(hub.ctx, attempt.agentId), { summary: 'Done.', evidence: [] });
    const answer = await takeOver(hub);
    expect([answer.status, answer.json.error]).toEqual([409, 'submission_pending']);
    expect(getAttempt(hub.ctx, attemptId).stopRequested).toBeNull();
  });

  test('409 runner_offline once the runner has no link', async () => {
    const { hub, runner } = await setup();
    runner.disconnect();
    await settle();
    const answer = await takeOver(hub);
    expect([answer.status, answer.json.error]).toEqual([409, 'runner_offline']);
    expect(getTask(hub.ctx, 'T-1').status).toBe('claimed');
  });

  test('409 not_running with no running agent, and while any stop is recorded', async () => {
    const { hub, runnerId, attemptId } = await setup();
    const [ready] = createTasks(hub.ctx, [newTask({ title: 'Nobody works on it' })], 'user:alice');
    expect((await takeOver(hub, ready?.id)).json.error).toBe('not_running');
    // An attempt that has not spawned yet has nothing to hand over.
    const [other] = createTasks(hub.ctx, [newTask({ title: 'Starting' })], 'user:alice');
    startRunnerAttempt(hub.ctx, { runnerId, taskId: other?.id as string, role: 'worker', vendor: 'claude' });
    expect((await takeOver(hub, other?.id)).json.error).toBe('not_running');
    requestStop(hub.ctx, { attemptId, cause: 'stop', reason: 'enough', by: 'user:bob' });
    const answer = await takeOver(hub);
    expect([answer.status, answer.json.error]).toEqual([409, 'not_running']);
    expect(getAttempt(hub.ctx, attemptId).stopRequested?.cause).toBe('stop');
  });

  test('agents and CLI tokens are refused', async () => {
    const { hub, attemptId } = await setup();
    const cli = await hub.call('POST', '/api/tasks/T-1/takeover', { user: 'alice', via: 'cli' });
    expect(cli.status).toBe(403);
    const token = mintAgentToken(hub.ctx, getAttempt(hub.ctx, attemptId));
    const agent = await hub.call('POST', '/api/tasks/T-1/takeover', { headers: { authorization: `Bearer ${token}` } });
    expect([agent.status, agent.json.error]).toEqual([403, 'agent_not_allowed']);
    expect(getAttempt(hub.ctx, attemptId).stopRequested).toBeNull();
  });
});

describe('attempt.taken_over', () => {
  test('ends the attempt taken_over with its commands and ref, the WIP as the position, and no cleanup', async () => {
    const { hub, runner, attemptId } = await setup({ reportTakeover: true });
    await takeOver(hub);
    await settle();
    const attempt = getAttempt(hub.ctx, attemptId);
    const ofAttempt = { attemptId, taskId: 'T-1', agentId: attempt.agentId, runnerId: 'R-1' };
    expect(attempt).toMatchObject({ status: 'ended', endReason: 'taken_over', wipSha: TAKEN_SHA });
    expect(attempt.takeover).toMatchObject({
      local: LOCAL,
      anywhere: ANYWHERE,
      ref: TAKEOVER_REF,
      error: null,
    });
    expect(getTask(hub.ctx, 'T-1')).toMatchObject({
      status: 'blocked',
      blockedKind: 'takeover',
      workRef: attempt.wipRef,
      workSha: TAKEN_SHA,
    });
    // The clone waits for the hand-back.
    expect(sent(runner, 'cleanup_attempt')).toEqual([]);
    expect(pendingCommands(hub.ctx, 'R-1', 1).filter((row) => row.kind === 'cleanup_attempt')).toEqual([]);
    expect(eventsOf(hub, 'task.taken_over').map((event) => [event.subject, event.data])).toEqual([
      ['T-1', { ...ofAttempt, person: 'alice', ref: TAKEOVER_REF }],
    ]);
  });

  test('a failed take-over stores local null and the error', async () => {
    const failed: AnswerHooks = {
      prepare_takeover: (command, runner) => {
        const data = { ...takenOver(null), error: 'cannot rebuild the git directory' };
        runner.emit('attempt.taken_over', data, { attemptId: command.attemptId, fence: command.fence });
        return { ok: true };
      },
    };
    const { hub, attemptId } = await setup({ answers: failed });
    await takeOver(hub);
    await settle();
    expect(getAttempt(hub.ctx, attemptId).takeover).toMatchObject({
      local: null,
      ref: TAKEOVER_REF,
      error: 'cannot rebuild the git directory',
    });
  });

  test('a late one, after the stop timeout ended the attempt, still stores its commands', async () => {
    const { hub, runner, attemptId } = await setup();
    await takeOver(hub);
    const { fence } = getAttempt(hub.ctx, attemptId);
    hub.clock.advance(hub.ctx.config.stopGraceMs);
    expect(expireStops(hub.ctx)).toBe(1);
    expect(getAttempt(hub.ctx, attemptId).takeover?.local).toBeNull();
    runner.emit('attempt.taken_over', takenOver(), { attemptId, fence });
    await settle();
    expect(getAttempt(hub.ctx, attemptId)).toMatchObject({
      endReason: 'taken_over',
      takeover: { local: LOCAL, anywhere: ANYWHERE, ref: TAKEOVER_REF },
    });
    expect(getTask(hub.ctx, 'T-1')).toMatchObject({ status: 'blocked', blockedKind: 'takeover', workSha: TAKEN_SHA });
    // The ending told the pages once.
    expect(eventsOf(hub, 'task.taken_over')).toHaveLength(1);
  });
});

describe('a take-over the runner never completes', () => {
  /** The take-over command the hub builds itself, from the task's work position and the person's take-over ref. */
  const anywhere = (hub: Hub) => {
    const task = getTask(hub.ctx, 'T-1');
    const work = { ref: task.workRef as string, branch: task.branch as string };
    return takeoverAnywhereCommand({ ...work, takeoverRef: TAKEOVER_REF });
  };

  for (const [name, expire] of [
    ['the stop timeout', (hub: Hub) => {
      hub.clock.advance(hub.ctx.config.stopGraceMs);
      return expireStops(hub.ctx);
    }],
    ['the lease expiry', (hub: Hub) => {
      hub.clock.advance(hub.ctx.config.runnerLeaseMs);
      return expireRunnerLeases(hub.ctx);
    }],
  ] as const) {
    test(`ends it taken_over at ${name}, with the anywhere command and the ref`, async () => {
      const { hub, attemptId } = await setup();
      await takeOver(hub);
      expect(expire(hub)).toBe(1);
      expect(getAttempt(hub.ctx, attemptId)).toMatchObject({
        status: 'ended',
        endReason: 'taken_over',
        takeover: { local: null, anywhere: anywhere(hub), ref: TAKEOVER_REF, error: null },
      });
      // The WIP the attempt pushed, onto the task branch: what the runner's own command fetches.
      expect(anywhere(hub).split('\n')[0]).toBe(ANYWHERE);
      expect(eventsOf(hub, 'task.taken_over').map((event) => event.data.ref)).toEqual([TAKEOVER_REF]);
      // The task holds its paths for the person, and the lead cannot unblock it.
      const task = getTask(hub.ctx, 'T-1');
      expect(task).toMatchObject({ status: 'blocked', blockedKind: 'takeover' });
      expect(isPathHolder(task)).toBe(true);
      expect(() => unblockTask(hub.ctx, 'T-1', 'agent:A-9')).toThrow(expect.objectContaining({ status: 409 }));
    });
  }
});

describe('a take-over the runner lost', () => {
  test('ends taken_over when the runner comes back without it, with the anywhere command and the ref', async () => {
    const { hub, runner, attemptId } = await setup();
    await takeOver(hub);
    runner.disconnect();
    await settle();
    await runner.reconnect();
    await settle();
    expect(getAttempt(hub.ctx, attemptId)).toMatchObject({
      status: 'ended',
      endReason: 'taken_over',
      takeover: { local: null, ref: TAKEOVER_REF, error: null },
    });
    expect(getTask(hub.ctx, 'T-1')).toMatchObject({ status: 'blocked', blockedKind: 'takeover' });
    expect(sent(runner, 'cleanup_attempt')).toEqual([]);
  });
});

describe('cancelling a taken-over task', () => {
  test('in the middle of the take-over: the ending cleans the clone up and tells no page', async () => {
    const { hub, runner, attemptId } = await setup();
    await takeOver(hub);
    const { fence } = getAttempt(hub.ctx, attemptId);
    cancelTask(hub.ctx, 'T-1', 'not needed any more', 'user:alice');
    // The take-over stands: a cancel does not replace it (X-34).
    expect(getAttempt(hub.ctx, attemptId).stopRequested?.cause).toBe('takeover');
    runner.emit('attempt.taken_over', takenOver(), { attemptId, fence });
    await settle();
    expect(getAttempt(hub.ctx, attemptId)).toMatchObject({ status: 'ended', endReason: 'taken_over' });
    expect(getTask(hub.ctx, 'T-1')).toMatchObject({ status: 'cancelled', workSha: WIP_SHA });
    expect(sent(runner, 'cleanup_attempt')).toEqual([{ kind: 'cleanup_attempt', attemptId }]);
    expect(eventsOf(hub, 'task.taken_over')).toEqual([]);
  });

  test('after the take-over: the clone that waited for the hand-back is cleaned up', async () => {
    const { hub, runner, attemptId } = await setup({ reportTakeover: true });
    await takeOver(hub);
    await settle();
    expect(sent(runner, 'cleanup_attempt')).toEqual([]);
    cancelTask(hub.ctx, 'T-1', 'not needed any more', 'user:alice');
    await settle();
    expect(getTask(hub.ctx, 'T-1').status).toBe('cancelled');
    expect(sent(runner, 'cleanup_attempt')).toEqual([{ kind: 'cleanup_attempt', attemptId }]);
  });
});
