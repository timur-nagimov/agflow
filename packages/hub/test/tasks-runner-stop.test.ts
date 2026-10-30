import { describe, expect, test } from 'bun:test';
import type { RunnerEventData } from '@agflow/core';
import { getAgent, touchAgent } from '../src/agents';
import { getAttempt, updateAttempt } from '../src/attempt-store';
import { endAttempt, onExited } from '../src/attempts';
import { mintAgentToken } from '../src/auth';
import { pendingCommands } from '../src/commands';
import { type HubContext, tx } from '../src/context';
import { listEvents } from '../src/events';
import { listMessages } from '../src/messages';
import { getTask, move, writeTask } from '../src/task-store';
import {
  blockTask,
  cancelTask,
  claimTask,
  declareImpossible,
  forceRelease,
  listTaskNotes,
  releaseTask,
  reportProgress,
  sweepLeases,
  writeHandoff,
} from '../src/tasks';
import { type RunnerAttempt, addAgent, addRunnerAttempt, createTestContext } from './helpers';

/** The runner reports the attempt's process gone after its stop, with nothing to push. */
function exit(ctx: HubContext, attemptId: string): void {
  const data: RunnerEventData['attempt.exited'] = {
    code: 0,
    signal: null,
    stoppedBy: 'close',
    handoffWritten: false,
    cause: null,
    finalSha: null,
    finalWip: null,
    pushError: null,
  };
  tx(ctx, (emit) => onExited(ctx, emit, getAttempt(ctx, attemptId), data));
}

/** The commands queued for the attempt's runner, without their tokens. */
const queued = (ctx: HubContext, held: RunnerAttempt) =>
  pendingCommands(ctx, held.runner.id, 1).map((row) => row.command);

/** Messages to the runner agent: the stop flow replaces M1's "commit and push" messages. */
const toAgent = (ctx: HubContext, held: RunnerAttempt) =>
  listMessages(ctx, {}).filter((message) => message.to === `agent:${held.agent.id}`);

function setup() {
  const { ctx, clock } = createTestContext();
  const held = addRunnerAttempt(ctx);
  return { ctx, clock, held, taskId: held.task.id };
}

describe('forceRelease of a runner-held task', () => {
  test('requests a stop with a handoff and sends no M1 message; the task goes ready on exit', () => {
    const { ctx, held, taskId } = setup();
    const task = forceRelease(ctx, taskId, 'user:alice', 'wrong approach');
    expect(task).toMatchObject({ status: 'claimed', assignee: held.agent.id });
    expect(getAttempt(ctx, held.attempt.id).stopRequested).toMatchObject({
      cause: 'stop',
      reason: 'wrong approach',
      by: 'user:alice',
      handoff: true,
    });
    expect(queued(ctx, held)).toContainEqual(expect.objectContaining({ kind: 'stop_attempt', cause: 'stop', handoff: true }));
    expect(toAgent(ctx, held)).toEqual([]);
    exit(ctx, held.attempt.id);
    expect(getAttempt(ctx, held.attempt.id)).toMatchObject({ endReason: 'stopped', failureClass: null });
    expect(getTask(ctx, taskId)).toMatchObject({ status: 'ready', assignee: null, nextDispatchAt: null });
    expect(getAgent(ctx, held.agent.id).currentTask).toBeNull();
  });
});

describe('cancelTask of a runner-held task', () => {
  test('cancels at once, as in M1, and stops the running attempt without the M1 message', () => {
    const { ctx, held, taskId } = setup();
    const task = cancelTask(ctx, taskId, 'the goal changed', 'user:alice');
    // The holder fields stay until the attempt ends (invariant e).
    expect(task).toMatchObject({ status: 'cancelled', assignee: held.agent.id, currentAttempt: held.attempt.id });
    expect(listEvents(ctx.db, { subject: taskId }).find((event) => event.type === 'task.cancelled')?.data).toMatchObject({
      reason: 'the goal changed',
      attemptId: held.attempt.id,
    });
    expect(getAttempt(ctx, held.attempt.id)).toMatchObject({ status: 'running', stopRequested: { cause: 'cancel' } });
    expect(queued(ctx, held)).toContainEqual(
      expect.objectContaining({ kind: 'stop_attempt', cause: 'cancel', handoff: false }),
    );
    expect(toAgent(ctx, held)).toEqual([]);
    exit(ctx, held.attempt.id);
    expect(getAttempt(ctx, held.attempt.id)).toMatchObject({ status: 'ended', endReason: 'cancelled' });
    expect(getTask(ctx, taskId)).toMatchObject({ status: 'cancelled', assignee: null });
  });

  test('the holding attempt of a submitted task ends cancelled at once', () => {
    const { ctx, held, taskId } = setup();
    tx(ctx, (emit) => move(ctx, emit, getTask(ctx, taskId), 'submitted', `agent:${held.agent.id}`));
    updateAttempt(ctx, held.attempt.id, { status: 'holding', leaseExpiresAt: null });
    const task = cancelTask(ctx, taskId, 'not needed', 'agent:A-9');
    expect(task.status).toBe('cancelled');
    expect(getAttempt(ctx, held.attempt.id)).toMatchObject({ status: 'ended', endReason: 'cancelled' });
    expect(getTask(ctx, taskId).assignee).toBeNull();
    expect(queued(ctx, held).map((command) => command.kind)).toEqual(['cleanup_attempt']);
    expect(toAgent(ctx, held)).toEqual([]);
  });
});

describe('a runner agent that declares its task blocked, impossible or released', () => {
  test('declare_blocked blocks the task at once and stops the attempt, which ends blocked on exit', () => {
    const { ctx, held, taskId } = setup();
    const token = mintAgentToken(ctx, held.attempt);
    const task = blockTask(ctx, taskId, held.agent, 'needs an API key', 'agent', token);
    expect(task).toMatchObject({
      status: 'blocked',
      blockedKind: 'agent',
      blockedReason: 'needs an API key',
      assignee: held.agent.id,
    });
    expect(getAttempt(ctx, held.attempt.id).stopRequested).toMatchObject({ cause: 'blocked', handoff: false });
    const [toLead] = listMessages(ctx, {}).filter((message) => message.to === 'lead');
    expect(toLead?.body).toContain('is blocked, reported by');
    exit(ctx, held.attempt.id);
    expect(getAttempt(ctx, held.attempt.id)).toMatchObject({ endReason: 'blocked', failureClass: null });
    expect(getTask(ctx, taskId)).toMatchObject({ status: 'blocked', assignee: null });
  });

  test('declare_impossible blocks it as impossible', () => {
    const { ctx, held, taskId } = setup();
    const task = declareImpossible(ctx, taskId, held.agent, 'the library has no such hook');
    expect(task).toMatchObject({ status: 'blocked', blockedKind: 'impossible' });
    expect(listEvents(ctx.db, { subject: taskId }).some((event) => event.type === 'task.impossible')).toBe(true);
    expect(getAttempt(ctx, held.attempt.id).stopRequested?.cause).toBe('impossible');
  });

  test('release_task stops the attempt; the task goes ready on exit and the ladder counts it', () => {
    const { ctx, held, taskId } = setup();
    const task = releaseTask(ctx, taskId, held.agent, 'out of my depth');
    expect(task).toMatchObject({ status: 'claimed', assignee: held.agent.id });
    expect(getAttempt(ctx, held.attempt.id).stopRequested).toMatchObject({ cause: 'released', handoff: false });
    expect(listTaskNotes(ctx, taskId).map((note) => [note.kind, note.attemptId])).toEqual([
      ['release', held.attempt.id],
    ]);
    // Once it asked to stop, its holder test for submit, block and release fails.
    expect(() => releaseTask(ctx, taskId, held.agent, 'again')).toThrow('being stopped');
    exit(ctx, held.attempt.id);
    expect(getAttempt(ctx, held.attempt.id)).toMatchObject({ endReason: 'released', failureClass: 'agent' });
    expect(getTask(ctx, taskId)).toMatchObject({ status: 'ready', assignee: null });
  });
});

describe('leases and notes of runner attempts', () => {
  test('progress, touchAgent and claims never set lease_expires_at; sweepLeases skips runner-held tasks', () => {
    const { ctx, clock, held, taskId } = setup();
    expect(getTask(ctx, taskId).leaseExpiresAt).toBeNull();
    reportProgress(ctx, taskId, held.agent, 'lexer done');
    touchAgent(ctx, held.agent.id);
    expect(getTask(ctx, taskId)).toMatchObject({ status: 'working', leaseExpiresAt: null });
    // A lease from before, which no runner attempt should have, is no reason to sweep the task.
    writeTask(ctx, taskId, { leaseExpiresAt: ctx.now() });
    clock.advance(1);
    expect(sweepLeases(ctx)).toEqual([]);
    expect(getTask(ctx, taskId).status).toBe('working');
  });

  test("once the runner attempt has ended, a live claim of the task keeps M1's lease and its sweep", () => {
    const { ctx, clock, held, taskId } = setup();
    endAttempt(ctx, { attemptId: held.attempt.id, trigger: 'stop' });
    expect(getTask(ctx, taskId).status).toBe('ready');
    const agent = addAgent(ctx);
    claimTask(ctx, taskId, agent);
    clock.advance(60_000);
    touchAgent(ctx, agent.id);
    expect(getTask(ctx, taskId).leaseExpiresAt).toBe(ctx.now() + ctx.config.leaseMs);
    clock.advance(ctx.config.leaseMs);
    expect(sweepLeases(ctx)).toEqual([taskId]);
  });

  test("a handoff note written with an agent token carries the token's attempt id", () => {
    const { ctx, held, taskId } = setup();
    const token = mintAgentToken(ctx, held.attempt);
    writeHandoff(ctx, taskId, held.agent, 'Next: the parser tests.', token);
    reportProgress(ctx, taskId, held.agent, 'lexer done', token);
    expect(listTaskNotes(ctx, taskId).map((note) => [note.kind, note.attemptId])).toEqual([
      ['handoff', held.attempt.id],
      ['progress', held.attempt.id],
    ]);
  });
});
