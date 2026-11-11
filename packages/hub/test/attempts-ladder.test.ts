import { describe, expect, test } from 'bun:test';
import { type EndingTrigger, type Vendor, failureSignature } from '@agflow/core';
import { getAttempt } from '../src/attempt-store';
import { applyLadder, endAttempt, ladderRequirement, requestStop } from '../src/attempts';
import { type HubContext, tx } from '../src/context';
import { listEvents } from '../src/events';
import { listMessages } from '../src/messages';
import { getTask, move, writeTask } from '../src/task-store';
import { createTasks } from '../src/tasks';
import { type RunnerAttempt, addRunnerAttempt, createTestContext, newTask } from './helpers';

const MINUTE = 60_000;

/** A new attempt at the task, which must be ready, on a runner offering the vendor. */
const attemptAt = (ctx: HubContext, taskId: string, vendor: Vendor = 'claude'): RunnerAttempt =>
  addRunnerAttempt(ctx, { taskId, vendor });

/** Starts an attempt at the task and ends it at once with the trigger. */
function fail(ctx: HubContext, taskId: string, trigger: EndingTrigger, options: { vendor?: Vendor; error?: string } = {}) {
  const held = attemptAt(ctx, taskId, options.vendor);
  const ending = endAttempt(ctx, { attemptId: held.attempt.id, trigger, error: options.error });
  if (!ending) throw new Error('the attempt had ended already');
  return ending;
}

function readyTask(ctx: HubContext): string {
  const [task] = createTasks(ctx, [newTask({ title: 'Parse the config' })], 'user:alice');
  return task?.id as string;
}

/** The messages to a target, oldest first. */
const messagesTo = (ctx: HubContext, to: string) =>
  listMessages(ctx, {})
    .filter((message) => message.to === to)
    .reverse();

/** The data of the task's newest event of this type. */
function eventData(ctx: HubContext, taskId: string, type: string): Record<string, unknown> | undefined {
  return listEvents(ctx.db, { subject: taskId, limit: 1000 })
    .filter((event) => event.type === type)
    .at(-1)?.data;
}

/** A re-plan, as unblocking a replan task does (design 6.9, step 4): the floor rises to the highest attempt number. */
function replan(ctx: HubContext, taskId: string): void {
  const task = getTask(ctx, taskId);
  writeTask(ctx, taskId, { ladderFloor: task.attemptCount, nextDispatchAt: null });
  tx(ctx, (emit) => move(ctx, emit, task, 'ready', 'user:alice', { changes: { blockedKind: null, blockedReason: null } }));
}

describe('the retry ladder', () => {
  test('runs only when the ending moved the task to ready', () => {
    const { ctx } = createTestContext();
    // A stop and hold blocks the task at once, so the ending moves nothing and no ladder runs.
    const held = attemptAt(ctx, readyTask(ctx));
    requestStop(ctx, { attemptId: held.attempt.id, cause: 'stop_hold', reason: 'look at it', by: 'user:alice' });
    const ending = endAttempt(ctx, { attemptId: held.attempt.id, trigger: 'crashed', error: 'boom' });
    expect(ending?.moved).toEqual([]);
    expect(ending?.ladder).toBeNull();
    expect(getTask(ctx, held.task.id)).toMatchObject({ status: 'blocked', blockedKind: 'paused', nextDispatchAt: null });
    // A task that names another attempt by now keeps its status too.
    const taskId = readyTask(ctx);
    const first = attemptAt(ctx, taskId);
    writeTask(ctx, taskId, { currentAttempt: 'T-99-a1' });
    expect(endAttempt(ctx, { attemptId: first.attempt.id, trigger: 'stall_silent' })?.ladder).toBeNull();
    expect(getTask(ctx, taskId)).toMatchObject({ status: 'claimed', nextDispatchAt: null });
    // An ending whose row moves no task to ready: a cancel.
    const cancelled = attemptAt(ctx, readyTask(ctx));
    requestStop(ctx, { attemptId: cancelled.attempt.id, cause: 'cancel', reason: 'not needed', by: 'user:alice' });
    expect(endAttempt(ctx, { attemptId: cancelled.attempt.id, trigger: 'cancel' })?.ladder).toBeNull();
  });

  test('the first counted failure requires the same vendor, the second the other, until vendorRequirementMs', () => {
    const { ctx, clock } = createTestContext();
    const taskId = readyTask(ctx);
    expect(ladderRequirement(ctx, taskId)).toBeNull();
    // An infra ending counts for nothing.
    fail(ctx, taskId, 'crashed', { vendor: 'codex', error: 'exit 1' });
    expect(ladderRequirement(ctx, taskId)).toBeNull();
    clock.advance(10 * MINUTE);
    const first = fail(ctx, taskId, 'stall_silent', { vendor: 'codex' });
    expect(first.ladder?.step).toBe(2);
    expect(first.task?.status).toBe('ready');
    expect(ladderRequirement(ctx, taskId)).toEqual({ step: 2, vendor: 'codex' });
    // A counted failure gets no backoff.
    expect(getTask(ctx, taskId).nextDispatchAt).toBe(first.ladder?.nextDispatchAt ?? null);
    expect(first.ladder?.nextDispatchAt).toBeNull();
    const second = fail(ctx, taskId, 'released', { vendor: 'codex' });
    expect(second.ladder?.step).toBe(3);
    expect(ladderRequirement(ctx, taskId)).toEqual({ step: 3, vendor: 'claude' });
    clock.advance(ctx.config.vendorRequirementMs - 1);
    expect(ladderRequirement(ctx, taskId)).toEqual({ step: 3, vendor: 'claude' });
    clock.advance(1);
    expect(ladderRequirement(ctx, taskId)).toBeNull();
  });

  test('the third counted attempt blocks the task for a re-plan and tells the lead; after a re-plan it fails', () => {
    const { ctx } = createTestContext();
    const taskId = readyTask(ctx);
    fail(ctx, taskId, 'stall_silent');
    fail(ctx, taskId, 'stall_loop', { vendor: 'codex' });
    const third = fail(ctx, taskId, 'released');
    expect(third.ladder?.step).toBe(4);
    expect(third.moved).toEqual(['ready']);
    expect(third.task).toMatchObject({ status: 'blocked', blockedKind: 'replan' });
    expect(third.task?.blockedReason).toContain('3 attempts');
    expect(eventData(ctx, taskId, 'task.blocked')).toMatchObject({ attemptId: third.attempt.id, ladderStep: 4 });
    const [toLead] = messagesTo(ctx, 'lead');
    expect(toLead?.taskId).toBe(taskId);
    expect(toLead?.body).toContain(`${taskId} ("Parse the config") is blocked for a re-plan`);
    expect(toLead?.body).toContain('unblock_task');
    expect(messagesTo(ctx, 'humans')).toEqual([]);
    // After the re-plan, three more counted attempts are allowed; infra endings between them count for nothing.
    replan(ctx, taskId);
    expect(fail(ctx, taskId, 'stall_budget', { vendor: 'codex' }).ladder?.step).toBe(2);
    // The attempts before the re-plan no longer count: the next one must use the same vendor again.
    expect(ladderRequirement(ctx, taskId)).toEqual({ step: 2, vendor: 'codex' });
    fail(ctx, taskId, 'crashed', { error: 'segfault' });
    expect(fail(ctx, taskId, 'stall_no_progress', { vendor: 'codex' }).ladder?.step).toBe(3);
    const last = fail(ctx, taskId, 'released');
    expect(last.ladder?.step).toBe(5);
    expect(last.task?.status).toBe('failed');
    expect(eventData(ctx, taskId, 'task.failed')).toMatchObject({ attemptId: last.attempt.id, ladderStep: 5 });
    const [toPeople] = messagesTo(ctx, 'humans');
    expect(toPeople?.taskId).toBe(taskId);
    expect(toPeople?.body).toContain(`${taskId} ("Parse the config") failed`);
    expect(messagesTo(ctx, 'lead')).toHaveLength(1);
  });

  test('infra endings back off 1, 2, 5, 15 and 30 minutes; a runner stop and a refusal neither back off nor reset', () => {
    const { ctx, clock } = createTestContext();
    const taskId = readyTask(ctx);
    const waits: (number | null)[] = [];
    for (const [n, trigger] of (['crashed', 'lost', 'failed_to_start', 'auth', 'crashed', 'crashed'] as const).entries()) {
      const ending = fail(ctx, taskId, trigger, { error: `failure ${n} of a different kind each time ${'x'.repeat(n)}` });
      waits.push(ending.task?.nextDispatchAt === null ? null : (ending.task?.nextDispatchAt as number) - ctx.now());
      // lost passes through stale.
      expect(ending.moved.at(-1)).toBe('ready');
      clock.advance(MINUTE);
      if (n === 1) {
        // The runner's own stop and a refused start sit between two infra endings without breaking the run.
        expect(fail(ctx, taskId, 'runner_stop').task?.nextDispatchAt).toBeNull();
        expect(fail(ctx, taskId, 'refused_start').task?.nextDispatchAt).toBeNull();
      }
    }
    expect(waits).toEqual([1, 2, 5, 15, 30, 30].map((minutes) => minutes * MINUTE));
    // A counted failure ends the run of infra endings, so the next one waits a minute again.
    fail(ctx, taskId, 'stall_silent');
    expect((fail(ctx, taskId, 'crashed', { error: 'again' }).task?.nextDispatchAt as number) - ctx.now()).toBe(MINUTE);
    // So does an ending with no class, such as a person's stop.
    fail(ctx, taskId, 'crashed', { error: 'and again' });
    fail(ctx, taskId, 'stop');
    const after = fail(ctx, taskId, 'crashed', { error: 'once more' });
    expect((after.task?.nextDispatchAt as number) - ctx.now()).toBe(MINUTE);
  });

  test('the attempt limit and the infra backoff come from the config', () => {
    const { ctx } = createTestContext({ maxAttempts: 4, infraBackoffMs: [1_000, 2_000] });
    const taskId = readyTask(ctx);
    const waits = ['crashed', 'auth', 'crashed'].map((trigger, n) => {
      const ending = fail(ctx, taskId, trigger as EndingTrigger, { error: `failure ${'x'.repeat(n)}` });
      return (ending.task?.nextDispatchAt as number) - ctx.now();
    });
    expect(waits).toEqual([1_000, 2_000, 2_000]);
    const steps = ['stall_silent', 'released', 'stall_loop', 'released'].map(
      (trigger) => fail(ctx, taskId, trigger as EndingTrigger).ladder?.step,
    );
    expect(steps).toEqual([2, 3, 3, 4]);
    expect(getTask(ctx, taskId)).toMatchObject({ status: 'blocked', blockedKind: 'replan' });
  });

  test('a rejection without a resume runs the ladder from rejected', () => {
    const { ctx } = createTestContext();
    const taskId = readyTask(ctx);
    /** A runner attempt whose submission was rejected and not returned to its author, then the ladder. */
    const reject = () => {
      const held = attemptAt(ctx, taskId);
      tx(ctx, (emit) => {
        const submitted = move(ctx, emit, getTask(ctx, taskId), 'submitted', `agent:${held.agent.id}`);
        move(ctx, emit, submitted, 'rejected', 'user:alice');
      });
      const ending = endAttempt(ctx, { attemptId: held.attempt.id, trigger: 'rejected' });
      expect(ending?.attempt).toMatchObject({ endReason: 'rejected', failureClass: 'review' });
      expect(ending?.ladder).toBeNull();
      const attempt = ending?.attempt as NonNullable<typeof ending>['attempt'];
      const task = getTask(ctx, taskId);
      const ladder = tx(ctx, (emit) => applyLadder(ctx, emit, { task, attempt, trigger: 'rejected' }));
      return { attempt, ladder };
    };
    const first = reject();
    expect(first.ladder).toMatchObject({ step: 2, nextDispatchAt: null, task: { status: 'ready' } });
    expect(eventData(ctx, taskId, 'task.ready')).toMatchObject({
      from: 'rejected',
      attemptId: first.attempt.id,
      ladderStep: 2,
    });
    expect(reject().ladder.step).toBe(3);
    const third = reject();
    expect(third.ladder).toMatchObject({ step: 4, task: { status: 'blocked', blockedKind: 'replan' } });
    expect(eventData(ctx, taskId, 'task.blocked')).toMatchObject({ from: 'rejected', attemptId: third.attempt.id });
    replan(ctx, taskId);
    reject();
    reject();
    const last = reject();
    expect(last.ladder).toMatchObject({ step: 5, task: { status: 'failed' } });
    expect(eventData(ctx, taskId, 'task.failed')).toMatchObject({ from: 'rejected', attemptId: last.attempt.id });
  });

  test('lost attempts, runner stops and refusals get no failure signature; three infra endings with one block', () => {
    const { ctx, clock } = createTestContext();
    const taskId = readyTask(ctx);
    for (const trigger of ['lost', 'runner_stop', 'refused_start'] as const) {
      expect(fail(ctx, taskId, trigger, { error: 'connection reset' }).attempt.failureSignature).toBeNull();
    }
    const error = (n: number) => `git fetch failed for /Users/bob/.agflow/vaults/demo.git: exit ${n}`;
    expect(fail(ctx, taskId, 'failed_to_start', { error: error(128) }).ladder?.step).toBeNull();
    clock.advance(30 * MINUTE);
    // A different error in between: the rule counts endings with one signature, not consecutive ones.
    fail(ctx, taskId, 'crashed', { error: 'out of memory' });
    fail(ctx, taskId, 'failed_to_start', { error: error(1) });
    expect(messagesTo(ctx, 'humans')).toEqual([]);
    const third = fail(ctx, taskId, 'failed_to_start', { error: error(2) });
    expect(third.attempt.failureSignature).toBe(failureSignature('failed_to_start', error(3)));
    expect(third.ladder?.step).toBe(4);
    expect(third.task).toMatchObject({ status: 'blocked', blockedKind: 'replan' });
    const signature = third.attempt.failureSignature as string;
    expect(third.task?.blockedReason).toContain(signature);
    for (const to of ['lead', 'humans']) {
      // The lost attempt told the lead its task went stale first.
      const told = messagesTo(ctx, to).find((message) => message.body.includes('blocked for a re-plan'));
      expect(told?.body).toContain(`> ${signature}`);
      expect(told?.taskId).toBe(taskId);
    }
    // After a re-plan the earlier endings no longer count.
    replan(ctx, taskId);
    expect(fail(ctx, taskId, 'failed_to_start', { error: error(4) }).task?.status).toBe('ready');
    expect(getAttempt(ctx, getTask(ctx, taskId).currentAttempt as string).failureSignature).toBe(signature);
  });
});
