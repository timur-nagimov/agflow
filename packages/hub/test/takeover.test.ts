import { describe, expect, test } from 'bun:test';
import { type RunnerEventData, TakeoverResponseSchema, lateWorkRef, takeoverAnywhereCommand } from '@agflow/core';
import { getAgent } from '../src/agents';
import { getAttempt, updateAttempt } from '../src/attempt-store';
import { endAttempt, expireRunnerLeases, expireStops, requestStop, startRunnerAttempt } from '../src/attempts';
import { createSession, mintAgentToken } from '../src/auth';
import { pendingCommands } from '../src/commands';
import { listEvents } from '../src/events';
import { Gateway } from '../src/gateway';
import { setReportedState } from '../src/runners';
import { reconcile } from '../src/scheduler';
import { requestSubmission } from '../src/submissions';
import { getTask, isPathHolder, listTaskNotes } from '../src/task-store';
import { expireHandbacks } from '../src/takeover';
import { cancelTask, createTasks, unblockTask } from '../src/tasks';
import { type AnswerHooks, type FakeConnection, type FakeRunner, connectFakeRunner, settle } from './fake-runner';
import { addRunner, newTask } from './helpers';
import { createTestHub } from './http-helpers';

const WIP_SHA = 'a'.repeat(40);
const TAKEN_SHA = 'b'.repeat(40);
const TAKEOVER_REF = 'refs/agflow/T-1/takeover-alice';
const HANDED_SHA = 'c'.repeat(40);
const PUSHED_SHA = 'd'.repeat(40);

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

/** The runner's answer to hand_back: refused while a process runs in the clone, else the clone's work handed back. */
interface Clone {
  pids: number[] | null;
  /** Whether the runner reports attempt.handed_back; else it answers ok and is never heard from again. */
  reports: boolean;
}

/** A task taken over by alice, whose runner answers hand_back as the clone says. */
async function takenOverTask(clone: Clone = { pids: null, reports: true }) {
  const answers: AnswerHooks = {
    hand_back: (command, runner) => {
      if (clone.pids) return { ok: false, error: 'process_running', data: { pids: clone.pids } };
      if (clone.reports) {
        const ref = lateWorkRef('refs/agflow/', command.attemptId, 1);
        const { fence } = getAttempt(hub.ctx, command.attemptId);
        runner.emit('attempt.handed_back', { ref, sha: HANDED_SHA }, { attemptId: command.attemptId, fence });
      }
      return { ok: true };
    },
  };
  const { hub, ...rest } = await setup({ reportTakeover: true, answers });
  await takeOver(hub);
  await settle();
  expect(getAttempt(hub.ctx, rest.attemptId).endReason).toBe('taken_over');
  return { hub, clone, ...rest };
}

async function handBack(hub: Hub, source: unknown, user = 'alice') {
  const answer = await hub.call('POST', '/api/tasks/T-1/handback', { ...asPerson(user), body: { source } });
  await settle();
  return answer;
}

describe('POST /api/tasks/:id/handback from the clone', () => {
  test('the person who took over gets 202 { attemptId }; hand_back goes out, and the task stays blocked', async () => {
    const { hub, runner, attemptId } = await takenOverTask({ pids: null, reports: false });
    const answer = await handBack(hub, 'clone');
    expect(answer.status).toBe(202);
    expect(TakeoverResponseSchema.parse(answer.json)).toEqual({ attemptId });
    expect(sent(runner, 'hand_back')).toEqual([{ kind: 'hand_back', attemptId, source: { kind: 'clone' } }]);
    expect(getTask(hub.ctx, 'T-1')).toMatchObject({ status: 'blocked', blockedKind: 'takeover' });
    // X-49: the hand-back on its way, and nobody may start another meanwhile.
    expect(getAttempt(hub.ctx, attemptId).takeover?.handingBack).toEqual({ by: 'user:alice', at: hub.ctx.now() });
    for (const source of ['clone', { ref: TAKEOVER_REF, sha: PUSHED_SHA }]) {
      const again = await handBack(hub, source);
      expect([again.status, again.json.error]).toEqual([409, 'handback_pending']);
    }
    expect(sent(runner, 'hand_back')).toHaveLength(1);
  });

  test('process_running keeps the task blocked with the error and pids, stops the timer; retrying works', async () => {
    const { hub, runner, clone, attemptId } = await takenOverTask({ pids: [4121, 4188], reports: true });
    expect((await handBack(hub, 'clone')).status).toBe(202);
    expect(getAttempt(hub.ctx, attemptId).takeover).toMatchObject({
      local: LOCAL,
      error: 'process_running: pids 4121, 4188 still run in the clone',
      handingBack: null,
    });
    hub.clock.advance(hub.ctx.config.handbackTimeoutMs);
    expect(expireHandbacks(hub.ctx)).toBe(0);
    expect(getTask(hub.ctx, 'T-1')).toMatchObject({ status: 'blocked', blockedKind: 'takeover', workSha: TAKEN_SHA });
    clone.pids = null;
    expect((await handBack(hub, 'clone')).status).toBe(202);
    expect(sent(runner, 'hand_back')).toHaveLength(2);
    expect(getTask(hub.ctx, 'T-1')).toMatchObject({ status: 'ready', workSha: HANDED_SHA });
  });

  test('attempt.handed_back makes { ref, sha } the work position, readies the task, queues the cleanup', async () => {
    const { hub, runner, attemptId } = await takenOverTask();
    await handBack(hub, 'clone');
    const ref = lateWorkRef('refs/agflow/', attemptId, 1);
    expect(getTask(hub.ctx, 'T-1')).toMatchObject({
      status: 'ready',
      blockedKind: null,
      blockedReason: null,
      workRef: ref,
      workSha: HANDED_SHA,
    });
    // It is the position itself, not late work for someone to merge.
    expect(listTaskNotes(hub.ctx, 'T-1').filter((note) => note.kind === 'late_work')).toEqual([]);
    expect(eventsOf(hub, 'attempt.late_work')).toEqual([]);
    expect(getAttempt(hub.ctx, attemptId).takeover?.handingBack).toBeNull();
    expect(sent(runner, 'cleanup_attempt')).toEqual([{ kind: 'cleanup_attempt', attemptId }]);
    const ofAttempt = { attemptId, taskId: 'T-1', agentId: getAttempt(hub.ctx, attemptId).agentId, runnerId: 'R-1' };
    expect(eventsOf(hub, 'task.handed_back').map((event) => [event.subject, event.data])).toEqual([
      ['T-1', { ...ofAttempt, source: 'clone', ref, sha: HANDED_SHA }],
    ]);
  });

  test('with the runner offline the task goes ready from the last position; a later push is late work', async () => {
    const { hub, runner, attemptId } = await takenOverTask();
    runner.disconnect();
    await settle();
    // Anyone may hand back once the runner is not online (X-24).
    const answer = await handBack(hub, 'clone', 'bob');
    expect(answer.status).toBe(202);
    const position = { status: 'ready', blockedKind: null, workRef: getAttempt(hub.ctx, attemptId).wipRef };
    expect(getTask(hub.ctx, 'T-1')).toMatchObject({ ...position, workSha: TAKEN_SHA });
    expect(getAttempt(hub.ctx, attemptId).takeover?.handingBack).toBeNull();
    // The hand-back waits for the runner, and its push then comes as late work.
    await runner.reconnect();
    await settle();
    expect(eventsOf(hub, 'task.handed_back')).toEqual([]);
    expect(eventsOf(hub, 'attempt.late_work').map((event) => event.data.sha)).toEqual([HANDED_SHA]);
  });

  test('a runner that reports disk_low keeps its link: the task waits for what the clone pushes', async () => {
    const { hub, runner, attemptId } = await takenOverTask({ pids: null, reports: false });
    setReportedState(hub.ctx, 'R-1', 'disk_low', 'disk 98% full');
    expect((await handBack(hub, 'clone')).status).toBe(202);
    expect(getTask(hub.ctx, 'T-1')).toMatchObject({ status: 'blocked', blockedKind: 'takeover' });
    expect(getAttempt(hub.ctx, attemptId).takeover?.handingBack).toEqual({ by: 'user:alice', at: hub.ctx.now() });
    const ref = lateWorkRef('refs/agflow/', attemptId, 1);
    const { fence } = getAttempt(hub.ctx, attemptId);
    runner.emit('attempt.handed_back', { ref, sha: HANDED_SHA }, { attemptId, fence });
    await settle();
    expect(getTask(hub.ctx, 'T-1')).toMatchObject({ status: 'ready', workRef: ref, workSha: HANDED_SHA });
  });

  test('a late attempt.taken_over keeps the pending hand-back', async () => {
    const { hub, runner, attemptId } = await setup();
    await takeOver(hub);
    const { fence } = getAttempt(hub.ctx, attemptId);
    hub.clock.advance(hub.ctx.config.stopGraceMs);
    expect(expireStops(hub.ctx)).toBe(1);
    expect((await handBack(hub, 'clone')).status).toBe(202);
    runner.emit('attempt.taken_over', takenOver(), { attemptId, fence });
    await settle();
    expect(getAttempt(hub.ctx, attemptId).takeover).toMatchObject({
      local: LOCAL,
      handingBack: { by: 'user:alice', at: hub.ctx.now() },
    });
    const again = await handBack(hub, 'clone');
    expect([again.status, again.json.error]).toEqual([409, 'handback_pending']);
  });

  test('only a person in the browser hands back: CLI tokens and agents are refused', async () => {
    const { hub, runner, runnerId } = await takenOverTask();
    const body = { source: 'clone' };
    const cli = await hub.call('POST', '/api/tasks/T-1/handback', { user: 'alice', via: 'cli', body });
    expect(cli.status).toBe(403);
    // The taken-over attempt's tokens are revoked; another agent at work tries.
    const [other] = createTasks(hub.ctx, [newTask({ title: 'Another one' })], 'user:alice');
    const taskId = other?.id as string;
    const { attempt } = startRunnerAttempt(hub.ctx, { runnerId, taskId, role: 'worker', vendor: 'claude' });
    const token = mintAgentToken(hub.ctx, attempt);
    const headers = { authorization: `Bearer ${token}` };
    const agent = await hub.call('POST', '/api/tasks/T-1/handback', { headers, body });
    expect([agent.status, agent.json.error]).toEqual([403, 'agent_not_allowed']);
    await settle();
    expect(getTask(hub.ctx, 'T-1')).toMatchObject({ status: 'blocked', blockedKind: 'takeover' });
    expect(sent(runner, 'hand_back')).toEqual([]);
  });

  test('with nothing back within handbackTimeoutMs the task goes ready from the last position', async () => {
    const { hub, runner, attemptId } = await takenOverTask({ pids: null, reports: false });
    await handBack(hub, 'clone');
    hub.clock.advance(hub.ctx.config.handbackTimeoutMs - 1);
    expect(reconcile(hub.ctx).handbacks).toBe(0);
    expect(getTask(hub.ctx, 'T-1').status).toBe('blocked');
    hub.clock.advance(1);
    expect(reconcile(hub.ctx).handbacks).toBe(1);
    await settle();
    expect(getTask(hub.ctx, 'T-1')).toMatchObject({ status: 'ready', blockedKind: null, workSha: TAKEN_SHA });
    expect(getAttempt(hub.ctx, attemptId).takeover?.handingBack).toBeNull();
    expect(sent(runner, 'cleanup_attempt')).toEqual([{ kind: 'cleanup_attempt', attemptId }]);
    // The clone's work, pushed after the timeout, is late work.
    const ref = lateWorkRef('refs/agflow/', attemptId, 1);
    const { fence } = getAttempt(hub.ctx, attemptId);
    runner.emit('attempt.handed_back', { ref, sha: HANDED_SHA }, { attemptId, fence });
    await settle();
    expect(eventsOf(hub, 'task.handed_back')).toEqual([]);
    expect(eventsOf(hub, 'attempt.late_work').map((event) => event.data.ref)).toEqual([ref]);
  });
});

describe('POST /api/tasks/:id/handback from a pushed ref', () => {
  test('sets the position, readies the task and queues the cleanup in the request transaction', async () => {
    const { hub, runner, attemptId } = await takenOverTask();
    const answer = await handBack(hub, { ref: TAKEOVER_REF, sha: PUSHED_SHA });
    expect(answer.status).toBe(202);
    expect(TakeoverResponseSchema.parse(answer.json)).toEqual({ attemptId });
    expect(getTask(hub.ctx, 'T-1')).toMatchObject({ status: 'ready', workRef: TAKEOVER_REF, workSha: PUSHED_SHA });
    expect(sent(runner, 'cleanup_attempt')).toEqual([{ kind: 'cleanup_attempt', attemptId }]);
    expect(sent(runner, 'hand_back')).toEqual([]);
    expect(eventsOf(hub, 'task.handed_back').map((event) => event.data)).toMatchObject([
      { attemptId, source: 'ref', ref: TAKEOVER_REF, sha: PUSHED_SHA },
    ]);
  });

  test('a late attempt.taken_over leaves the handed-back position alone', async () => {
    const { hub, runner, attemptId } = await setup();
    await takeOver(hub);
    const { fence } = getAttempt(hub.ctx, attemptId);
    hub.clock.advance(hub.ctx.config.stopGraceMs);
    expect(expireStops(hub.ctx)).toBe(1);
    expect((await handBack(hub, { ref: TAKEOVER_REF, sha: PUSHED_SHA })).status).toBe(202);
    runner.emit('attempt.taken_over', takenOver(), { attemptId, fence });
    await settle();
    expect(getTask(hub.ctx, 'T-1')).toMatchObject({ status: 'ready', workRef: TAKEOVER_REF, workSha: PUSHED_SHA });
  });

  for (const [name, end] of [
    ['a crash', (hub: Hub, _runner: Link, attemptId: string) => {
      endAttempt(hub.ctx, { attemptId, trigger: 'crashed', error: 'the agent died' });
      return Promise.resolve();
    }],
    ['the runner losing it', async (_hub: Hub, runner: Link) => {
      runner.disconnect();
      await settle();
      await runner.reconnect();
      await settle();
    }],
  ] as const) {
    test(`a take-over ended by ${name} before it was done still hands back`, async () => {
      const { hub, runner, attemptId } = await setup();
      await takeOver(hub);
      await end(hub, runner, attemptId);
      expect(getAttempt(hub.ctx, attemptId)).toMatchObject({ status: 'ended', takeover: { ref: TAKEOVER_REF } });
      expect(getTask(hub.ctx, 'T-1')).toMatchObject({ status: 'blocked', blockedKind: 'takeover' });
      expect(sent(runner, 'cleanup_attempt')).toEqual([]);
      const answer = await handBack(hub, { ref: TAKEOVER_REF, sha: PUSHED_SHA });
      expect(answer.status).toBe(202);
      expect(getTask(hub.ctx, 'T-1')).toMatchObject({ status: 'ready', workRef: TAKEOVER_REF, workSha: PUSHED_SHA });
      expect(sent(runner, 'cleanup_attempt')).toEqual([{ kind: 'cleanup_attempt', attemptId }]);
    });
  }

  test('a short sha is a 400', async () => {
    const { hub } = await takenOverTask();
    const answer = await handBack(hub, { ref: TAKEOVER_REF, sha: 'ddddddd' });
    expect(answer.status).toBe(400);
    expect(getTask(hub.ctx, 'T-1').status).toBe('blocked');
  });

  test('others may hand back only once the runner is not online; unblock still gets 409', async () => {
    const { hub, runner } = await takenOverTask();
    expect(() => unblockTask(hub.ctx, 'T-1', 'user:alice')).toThrow(expect.objectContaining({ status: 409 }));
    const source = { ref: TAKEOVER_REF, sha: PUSHED_SHA };
    expect((await handBack(hub, source, 'bob')).status).toBe(403);
    expect(getTask(hub.ctx, 'T-1').status).toBe('blocked');
    runner.disconnect();
    await settle();
    expect((await handBack(hub, source, 'bob')).status).toBe(202);
    expect(getTask(hub.ctx, 'T-1')).toMatchObject({ status: 'ready', workSha: PUSHED_SHA });
  });

  test('nothing to hand back: a task not taken over, or a take-over still being prepared', async () => {
    const { hub } = await setup();
    const source = { ref: TAKEOVER_REF, sha: PUSHED_SHA };
    expect((await handBack(hub, source)).status).toBe(409);
    await takeOver(hub);
    const answer = await handBack(hub, source);
    expect(answer.status).toBe(409);
    expect(getTask(hub.ctx, 'T-1')).toMatchObject({ status: 'blocked', blockedKind: 'takeover' });
  });
});
