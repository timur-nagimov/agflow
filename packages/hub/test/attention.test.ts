import { describe, expect, test } from 'bun:test';
import type { BlockedKind, TaskStatus } from '@agflow/core';
import { ATTENTION_REVIEW_MS, attentionTasks } from '../src/attention';
import { situationReport } from '../src/brief';
import { tx, type HubContext } from '../src/context';
import { listEvents } from '../src/events';
import { getHubState } from '../src/hub-state';
import { periodicLeadReview } from '../src/lead';
import { runTick } from '../src/scheduler';
import { setPaused } from '../src/project';
import { getTask, writeTask } from '../src/task-store';
import { createTasks } from '../src/tasks';
import { addAgent, addRunner, createTestContext, newTask } from './helpers';

const MINUTE = 60_000;
function task(ctx: HubContext, status: TaskStatus = 'blocked', blockedKind: BlockedKind | null = 'agent', priority = 5) {
  const [created] = createTasks(ctx, [newTask({ priority })], 'user:alice');
  writeTask(ctx, created!.id, { status, blockedKind, blockedReason: 'Waiting for a decision.' });
  return getTask(ctx, created!.id);
}
function setup(leadReviewMs = 45 * MINUTE) {
  const made = createTestContext({ leadReviewMs });
  addAgent(made.ctx, 'alice', 'lead');
  return made;
}
const batches = (ctx: HubContext) => listEvents(ctx.db)
  .filter((event) => event.type === 'lead.attention_reminded')
  .map((event) => event.data.taskIds as string[]);

describe('Needs attention priority', () => {
  test('matches board membership, including merge failures but excluding dependency waits and takeovers', () => {
    const { ctx } = setup();
    const attention = [
      task(ctx), task(ctx, 'blocked', 'paused'), task(ctx, 'blocked', 'policy'),
      task(ctx, 'rejected', null), task(ctx, 'stale', null),
    ];
    task(ctx, 'blocked', 'deps');
    task(ctx, 'blocked', 'takeover');
    for (const status of ['ready', 'working', 'submitted', 'checking', 'reviewing', 'accepted', 'merged', 'failed', 'cancelled', 'merging'] as const) {
      task(ctx, status, null);
    }
    const failed = task(ctx, 'merging', null);
    tx(ctx, (emit) => {
      emit({ type: 'task.merging', actor: 'system', subject: failed.id });
      emit({ type: 'task.merge_failed', actor: 'system', subject: failed.id, data: { error: 'Push refused' } });
    });
    expect(attentionTasks(ctx).map((item) => item.id)).toEqual([...attention.map((item) => item.id), failed.id]);
    expect(attentionTasks(ctx).at(-1)?.waitReason).toBe('Push refused');
    // A new merge cycle no longer carries the earlier failure into attention.
    tx(ctx, (emit) => emit({ type: 'task.merging', actor: 'system', subject: failed.id }));
    expect(attentionTasks(ctx).some((item) => item.id === failed.id)).toBe(false);
  });

  test.each([5, 45])('wakes the lead for a blocked-only backlog within min(%i, 15) minutes', (configured) => {
    const { ctx, clock } = setup(configured * MINUTE);
    const held = task(ctx);
    expect(periodicLeadReview(ctx)).toBeNull();
    const interval = Math.min(configured * MINUTE, ATTENTION_REVIEW_MS);
    clock.advance(interval - 1);
    expect(periodicLeadReview(ctx)).toBeNull();
    clock.advance(1);
    const message = periodicLeadReview(ctx);
    expect(message?.body).toStartWith('Needs attention (1):');
    expect(message?.body).toContain(`${held.id} [blocked/agent]`);
    expect(message?.body).toContain('priority over planning more work');
    expect(message?.body).toContain('Preserve people-only holds');
    expect(periodicLeadReview(ctx)).toBeNull();
    expect(batches(ctx)).toEqual([[held.id]]);
    expect(getTask(ctx, held.id)).toMatchObject({ status: 'blocked', priority: 5, attemptCount: 0 });
    // Once resolved, the old queue does not keep producing reminders.
    writeTask(ctx, held.id, { status: 'ready', blockedKind: null, blockedReason: null });
    clock.advance(interval);
    expect(periodicLeadReview(ctx)).toBeNull();
    expect(getHubState(ctx).lastLeadReviewAt).toBeNull();
  });

  test('rotates a large queue using persisted events instead of repeating its first page', () => {
    const { ctx, clock } = setup();
    const items = Array.from({ length: 21 }, () => task(ctx));
    // Priority matters within the next batch; old unresolved pages cannot starve the rest.
    const urgent = task(ctx, 'blocked', 'agent', 1);
    periodicLeadReview(ctx);
    for (let round = 0; round < 3; round++) {
      clock.advance(ATTENTION_REVIEW_MS);
      expect(periodicLeadReview(ctx)).not.toBeNull();
    }
    const [first, second] = batches(ctx);
    expect(first![0]).toBe(urgent.id);
    expect(first).toHaveLength(10);
    expect(second).toHaveLength(10);
    expect(second!.some((id) => first!.includes(id))).toBe(false);
    expect(new Set(batches(ctx).flat())).toEqual(new Set([...items.map((item) => item.id), urgent.id]));
    // A new context wrapper over the same persisted state retains the order.
    expect(attentionTasks({ ...ctx }).map((item) => item.id)).toEqual(attentionTasks(ctx).map((item) => item.id));
  });

  test('no reminders while paused or without a lead; people-only holds are never auto-cleared', () => {
    const { ctx, clock } = createTestContext();
    const paused = task(ctx, 'blocked', 'paused');
    task(ctx, 'blocked', 'policy');
    periodicLeadReview(ctx);
    clock.advance(ATTENTION_REVIEW_MS);
    expect(periodicLeadReview(ctx)).toBeNull();
    addAgent(ctx, 'alice', 'lead');
    setPaused(ctx, true, 'user:alice');
    expect(periodicLeadReview(ctx)).toBeNull();
    setPaused(ctx, false, 'user:alice');
    expect(periodicLeadReview(ctx)?.body).toContain('Preserve people-only holds, paused tasks');
    expect(getTask(ctx, paused.id).blockedKind).toBe('paused');
  });

  test('attention priority does not pause independent worker dispatch', () => {
    const { ctx } = setup();
    const blocked = task(ctx, 'blocked', 'agent', 0);
    const ready = task(ctx, 'ready', null);
    addRunner(ctx);
    expect(runTick(ctx).started.map((attempt) => attempt.taskId)).toEqual([ready.id]);
    expect(getTask(ctx, blocked.id).status).toBe('blocked');
  });

  test('attention precedes overdue work and cannot be buried at the end of a crowded situation report', () => {
    const { ctx, clock } = setup(5 * MINUTE);
    const waiting = task(ctx);
    task(ctx, 'submitted', null);
    for (let i = 0; i < 15; i++) task(ctx, 'ready', null);
    periodicLeadReview(ctx);
    clock.advance(6 * MINUTE);
    const message = periodicLeadReview(ctx)?.body ?? '';
    expect(message.indexOf('Needs attention')).toBeLessThan(message.indexOf('Periodic review'));
    const report = situationReport(ctx);
    expect(report.indexOf('Needs attention')).toBeLessThan(report.indexOf('Workers:'));
    expect(report).toContain(waiting.id);
    expect(report.length).toBeLessThanOrEqual(2500);
  });
});
