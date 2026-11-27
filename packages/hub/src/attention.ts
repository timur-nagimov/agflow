// The board's Needs attention queue, presented to the lead before new planning work.
import type { Task } from '@agflow/core';
import type { HubContext } from './context';
import { failedMerges } from './merges';
import { listTasks } from './task-store';
import { quotedWithin } from './text';

/** Shorter than the ordinary 45-minute review, without waking the lead on every tick. */
export const ATTENTION_REVIEW_MS = 15 * 60_000;
export const ATTENTION_BATCH_SIZE = 10;

/** Same membership as the board: dependency waits and human takeovers are not attention items. */
export function attentionTasks(ctx: HubContext, tasks: readonly Task[] = listTasks(ctx)): Task[] {
  const pending = tasks.flatMap((task) => {
    if (task.status === 'blocked') return task.blockedKind === 'deps' || task.blockedKind === 'takeover' ? [] : [task];
    if (task.status === 'rejected' || task.status === 'stale') return [task];
    if (task.status !== 'merging') return [];
    const failure = failedMerges(ctx, task.id);
    return failure ? [{ ...task, waitReason: failure.lastError }] : [];
  });
  if (pending.length === 0) return [];
  // Persisted in the normal event log: a restart or lead rotation must not keep restarting at the same first page.
  const rows = ctx.db.query(`
    SELECT item.value AS taskId, MAX(events.ts) AS at
    FROM events JOIN json_each(events.data, '$.taskIds') AS item
    WHERE events.type = 'lead.attention_reminded' GROUP BY item.value
  `).all() as { taskId: string; at: number }[];
  const lastShown = new Map(rows.map((row) => [row.taskId, row.at]));
  return pending.sort((a, b) =>
    (lastShown.get(a.id) ?? -1) - (lastShown.get(b.id) ?? -1) ||
    a.priority - b.priority || a.updatedAt - b.updatedAt || a.id.localeCompare(b.id, 'en', { numeric: true }),
  );
}

/** A bounded summary, with task-authored reasons quoted rather than promoted to hub instructions. */
export function attentionLines(tasks: readonly Task[], limit: number): string[] {
  if (tasks.length === 0) return [];
  const lines = [
    `Needs attention (${tasks.length}): give these decisions priority over planning more work; keep independent urgent work moving.`,
  ];
  for (const task of tasks.slice(0, limit)) {
    const status = task.status === 'blocked' ? `blocked/${task.blockedKind ?? 'unknown'}` : task.status;
    lines.push(`- ${task.id} [${status}] P${task.priority}:`);
    const reason = task.status === 'blocked' ? task.blockedReason : task.status === 'merging' ? task.waitReason : task.feedback;
    if (reason) lines.push(quotedWithin(reason, 150));
  }
  if (tasks.length > limit) lines.push(`and ${tasks.length - limit} more; the periodic review rotates through the queue.`);
  return lines;
}
