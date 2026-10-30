import { describe, expect, test } from 'bun:test';
import { type Agent, compareFence } from '@agflow/core';
import { ACTIVE_MS } from '../src/agents';
import { getAttempt, listAttempts } from '../src/attempt-store';
import { endAttempt, ladderRequirement } from '../src/attempts';
import type { HubContext } from '../src/context';
import { listEvents } from '../src/events';
import { getTask, writeTask } from '../src/task-store';
import {
  acceptTask,
  blockTask,
  cancelTask,
  claimTask,
  createTasks,
  declareImpossible,
  forceRelease,
  listTaskNotes,
  rejectTask,
  releaseTask,
  reportProgress,
  resumeClaim,
  submitTask,
  sweepLeases,
} from '../src/tasks';
import { addAgent, addRunnerAttempt, createTestContext, newTask } from './helpers';

const SHA = 'c'.repeat(40);

/** A ready task and a live agent of alice's that claimed it. */
function claimed() {
  const { ctx, clock } = createTestContext();
  const [task] = createTasks(ctx, [newTask({ title: 'Login' })], 'user:alice');
  const taskId = task?.id as string;
  const agent = addAgent(ctx);
  claimTask(ctx, taskId, agent, 'agflow/T-1-login');
  return { ctx, clock, taskId, agent };
}

const current = (ctx: HubContext, taskId: string) => getAttempt(ctx, getTask(ctx, taskId).currentAttempt as string);

/** The task's attempt.* events, in order. */
const attemptEvents = (ctx: HubContext, taskId: string) =>
  listEvents(ctx.db, { subject: taskId }).filter((event) => event.type.startsWith('attempt.'));

function submit(ctx: HubContext, taskId: string, agent: Agent): void {
  submitTask(ctx, taskId, agent, { summary: 'Done.', evidence: [], headSha: SHA });
}

describe('live claims', () => {
  test('a claim creates a running attempt with a fence and no runner or lease, from the work position', () => {
    const { ctx, taskId, agent } = claimed();
    const attempt = current(ctx, taskId);
    expect(attempt).toMatchObject({
      taskId,
      number: 1,
      role: 'worker',
      agentId: agent.id,
      runnerId: null,
      vendor: 'claude',
      status: 'running',
      leaseExpiresAt: null,
      startRef: 'refs/heads/main',
      startSha: null,
    });
    expect(attempt.fence.counter).toBeGreaterThan(0);
    expect(getTask(ctx, taskId)).toMatchObject({ attemptCount: 1, assignee: agent.id });
    expect(getTask(ctx, taskId).leaseExpiresAt).not.toBeNull();
    expect(listEvents(ctx.db, { subject: taskId }).some((event) => event.type === 'attempt.started')).toBe(true);
    // Notes the live agent writes carry its attempt.
    reportProgress(ctx, taskId, agent, 'half done');
    expect(listTaskNotes(ctx, taskId).map((note) => note.attemptId)).toEqual([attempt.id]);
  });

  test("a claim starts from the task's work position", () => {
    const { ctx } = createTestContext();
    const [task] = createTasks(ctx, [newTask()], 'user:alice');
    writeTask(ctx, task?.id as string, { workRef: 'refs/agflow/T-1/a1', workSha: SHA });
    claimTask(ctx, task?.id as string, addAgent(ctx));
    expect(current(ctx, task?.id as string)).toMatchObject({ startRef: 'refs/agflow/T-1/a1', startSha: SHA });
  });

  test('resume_claim ends the old attempt superseded and starts another', () => {
    const { ctx, taskId, agent } = claimed();
    const first = current(ctx, taskId);
    const next = addAgent(ctx);
    resumeClaim(ctx, taskId, next);
    expect(getAttempt(ctx, first.id)).toMatchObject({ status: 'ended', endReason: 'superseded', failureClass: null });
    expect(current(ctx, taskId)).toMatchObject({ number: 2, agentId: next.id, status: 'running', runnerId: null });
    expect(agent.id).not.toBe(next.id);
  });
});

describe('live submissions and reviews', () => {
  test('submit holds the attempt and records the branch head as the work position; accept ends it accepted', () => {
    const { ctx, taskId, agent } = claimed();
    submit(ctx, taskId, agent);
    expect(current(ctx, taskId).status).toBe('holding');
    expect(attemptEvents(ctx, taskId).map((event) => [event.type, event.data.attemptId])).toEqual([
      ['attempt.started', current(ctx, taskId).id],
      ['attempt.holding', current(ctx, taskId).id],
    ]);
    expect(getTask(ctx, taskId).submission?.attemptId).toBe(current(ctx, taskId).id);
    expect(getTask(ctx, taskId)).toMatchObject({ workRef: 'refs/heads/agflow/T-1-login', workSha: SHA });
    acceptTask(ctx, taskId, 'user:alice');
    expect(current(ctx, taskId)).toMatchObject({ status: 'ended', endReason: 'accepted', failureClass: null });
  });

  test('a rejection returned to the author makes it running with a new fence', () => {
    const { ctx, taskId, agent } = claimed();
    submit(ctx, taskId, agent);
    const before = current(ctx, taskId);
    expect(rejectTask(ctx, taskId, 'user:alice', 'Add a test.').status).toBe('claimed');
    const after = current(ctx, taskId);
    expect(after).toMatchObject({ id: before.id, status: 'running' });
    expect(compareFence(after.fence, before.fence)).toBe(1);
    const events = attemptEvents(ctx, taskId);
    expect(events.map((event) => [event.type, event.data.attemptId])).toEqual([
      ['attempt.started', before.id],
      ['attempt.holding', before.id],
      ['attempt.resumed', before.id],
    ]);
    expect(events.at(-1)?.data.fence).toEqual(after.fence);
  });

  test('a rejection not returned to the author ends it rejected, not counted', () => {
    const { ctx, clock, taskId, agent } = claimed();
    submit(ctx, taskId, agent);
    clock.advance(ACTIVE_MS + 1);
    expect(rejectTask(ctx, taskId, 'user:alice', 'Add a test.').status).toBe('ready');
    const attempt = listAttempts(ctx, { task: taskId })[0];
    expect(attempt).toMatchObject({ status: 'ended', endReason: 'rejected', failureClass: 'review' });
    expect(ladderRequirement(ctx, taskId)).toBeNull();
    // The first counted failure is the next runner attempt's.
    const held = addRunnerAttempt(ctx, { taskId });
    expect(endAttempt(ctx, { attemptId: held.attempt.id, trigger: 'stall_silent' })?.ladder?.step).toBe(2);
  });
});

describe('every other way a live attempt ends', () => {
  const endings: [string, string, (ctx: HubContext, taskId: string, agent: Agent) => void][] = [
    ['release', 'released', (ctx, taskId, agent) => releaseTask(ctx, taskId, agent, 'not mine')],
    ['declare_blocked', 'blocked', (ctx, taskId, agent) => blockTask(ctx, taskId, agent, 'needs a key')],
    ['declare_impossible', 'blocked', (ctx, taskId, agent) => declareImpossible(ctx, taskId, agent, 'no hook')],
    ['forceRelease', 'stopped', (ctx, taskId) => forceRelease(ctx, taskId, 'user:alice', 'wrong approach')],
    ['cancel', 'cancelled', (ctx, taskId) => cancelTask(ctx, taskId, 'not needed', 'user:alice')],
  ];
  for (const [operation, endReason, run] of endings) {
    test(`${operation} ends it ${endReason}`, () => {
      const { ctx, taskId, agent } = claimed();
      const attempt = current(ctx, taskId);
      run(ctx, taskId, agent);
      expect(getAttempt(ctx, attempt.id)).toMatchObject({ status: 'ended', endReason, leaseExpiresAt: null });
    });
  }

  test('the lease sweep ends it lost, and a lost live attempt adds nothing to the infra backoff', () => {
    const { ctx, clock, taskId } = claimed();
    const attempt = current(ctx, taskId);
    clock.advance(ctx.config.leaseMs);
    expect(sweepLeases(ctx)).toEqual([taskId]);
    expect(getAttempt(ctx, attempt.id)).toMatchObject({ status: 'ended', endReason: 'lost', failureClass: 'infra' });
    expect(getTask(ctx, taskId).status).toBe('ready');
    const held = addRunnerAttempt(ctx, { taskId });
    const ending = endAttempt(ctx, { attemptId: held.attempt.id, trigger: 'crashed', error: 'boom' });
    expect((ending?.task?.nextDispatchAt as number) - ctx.now()).toBe(ctx.config.infraBackoffMs[0] as number);
  });
});
