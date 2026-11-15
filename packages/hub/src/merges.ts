// Merging inside agflow (AGFLOW_AUTO_MERGE). An accepted task waits in merging, and one merge at a time goes to a
// runner as merge_task: the runner merges the accepted head into main in its vault and pushes main with its owner's
// git credentials, the ones that push task branches. The author's runner merges when it can, else any online runner
// whose git is ready and whose protocol knows merge_task; after a merge failed on a runner, the next try goes to
// another one when it can, and each try waits longer than the one before (mergeDue). A merge_task left with a runner
// that went offline, or for a task no longer merging, is cancelled, and the next one goes out. tasks.ts records what
// a merge gave.
import { COMMAND_MIN_PROTOCOL, CommitShaSchema, type Task, isTaskBranch } from '@agflow/core';
import { type CommandRow, enqueueCommand } from './commands';
import { type HubContext, tx } from './context';
import { getProject } from './project';
import { findRunnerRows, runnerInfo } from './runners';
import { TASK_SELECT, type TaskRow, findTask, rowToTask } from './task-store';

/** What a runner merges for a task: its submitted branch and head, when the branch is the task's own. */
export function mergeableHead(task: Task): { branch: string; headSha: string } | null {
  const branch = task.submission?.branch ?? null;
  const headSha = task.submission?.headSha ?? null;
  if (branch === null || headSha === null || !isTaskBranch(task.id, branch)) return null;
  return CommitShaSchema.safeParse(headSha).success ? { branch, headSha } : null;
}

/** The merge_task commands still waiting for a result: their task, and whether their runner can still answer. */
function pendingMerges(ctx: HubContext): { id: string; taskId: string; answerable: boolean }[] {
  const rows = ctx.db
    .query(
      `SELECT runner_commands.id, json_extract(runner_commands.payload, '$.taskId') AS task_id,
         runners.state = 'online' AND runners.retired_at IS NULL AS answerable
       FROM runner_commands JOIN runners ON runners.id = runner_commands.runner_id
       WHERE runner_commands.kind = 'merge_task' AND runner_commands.status = 'pending'`,
    )
    .all() as { id: string; task_id: string; answerable: number }[];
  return rows.map((row) => ({ id: row.id, taskId: row.task_id, answerable: row.answerable === 1 }));
}

/**
 * The tasks waiting in merging, the one whose last merge went out longest ago first, then in the order they were
 * accepted: a merge that keeps failing never holds up the others.
 */
function mergingTasks(ctx: HubContext): Task[] {
  const rows = ctx.db
    .query(
      `${TASK_SELECT} WHERE status = 'merging'
       ORDER BY COALESCE((SELECT MAX(created_at) FROM runner_commands WHERE kind = 'merge_task'
           AND json_extract(payload, '$.taskId') = tasks.id), 0),
         (SELECT MAX(id) FROM events WHERE subject = tasks.id AND type = 'task.merging'), seq`,
    )
    .all() as TaskRow[];
  return rows.map((row) => rowToTask(ctx, row));
}

/** A failed merge's next try waits this long, and twice as long after each further failure (mergeDue). */
export const MERGE_RETRY_MS = 15_000;
/** The longest wait between two tries of a merge that keeps failing. */
export const MERGE_RETRY_MAX_MS = 10 * 60_000;

/** The merges of a task that failed since it last began merging: how many, and the newest one's time and error. */
export interface FailedMerges {
  count: number;
  lastAt: number;
  lastError: string;
}

/** The task's failed merges since it last began merging (task.merge_failed); null while none failed. */
export function failedMerges(ctx: HubContext, taskId: string): FailedMerges | null {
  const row = ctx.db
    .query(
      `SELECT COUNT(*) OVER () AS count, ts, json_extract(data, '$.error') AS error FROM events
       WHERE subject = $taskId AND type = 'task.merge_failed'
         AND id > (SELECT COALESCE(MAX(id), 0) FROM events WHERE subject = $taskId AND type = 'task.merging')
       ORDER BY id DESC LIMIT 1`,
    )
    .get({ taskId }) as { count: number; ts: number; error: string | null } | null;
  return row && { count: row.count, lastAt: row.ts, lastError: row.error ?? 'no reason given' };
}

/**
 * Whether the task's next merge may go out: at once while none of its merges failed; after n failures since it began
 * merging, once min(MERGE_RETRY_MS * 2^(n-1), MERGE_RETRY_MAX_MS) has passed since the last one.
 */
function mergeDue(ctx: HubContext, taskId: string): boolean {
  const failed = failedMerges(ctx, taskId);
  if (failed === null) return true;
  return ctx.now() - failed.lastAt >= Math.min(MERGE_RETRY_MS * 2 ** (failed.count - 1), MERGE_RETRY_MAX_MS);
}

/** The runners a merge of the task failed on since it last began merging, each with its newest task.merge_failed. */
function mergeFailures(ctx: HubContext, taskId: string): Map<string, number> {
  const rows = ctx.db
    .query(
      `SELECT json_extract(data, '$.runnerId') AS runner_id, MAX(id) AS last FROM events
       WHERE subject = $taskId AND type = 'task.merge_failed'
         AND id > (SELECT COALESCE(MAX(id), 0) FROM events WHERE subject = $taskId AND type = 'task.merging')
       GROUP BY runner_id`,
    )
    .all({ taskId }) as { runner_id: string; last: number }[];
  return new Map(rows.map((row) => [row.runner_id, row.last]));
}

/**
 * Where a task's merge goes, among the runners that can take merge_task now: one where no merge of the task failed
 * since it began merging, the runner of its last attempt first; else the one where it failed longest ago. So a merge
 * that keeps failing on one runner moves on to the next.
 */
function mergeRunner(ctx: HubContext, taskId: string): string | null {
  const able = findRunnerRows(ctx).filter(
    (row) => row.state === 'online' && row.protocol >= COMMAND_MIN_PROTOCOL.merge_task && runnerInfo(row).git.ready,
  );
  const last = ctx.db
    .query(
      'SELECT runner_id FROM attempts WHERE task_id = $taskId AND runner_id IS NOT NULL ORDER BY number DESC LIMIT 1',
    )
    .get({ taskId }) as { runner_id: string } | null;
  const failures = mergeFailures(ctx, taskId);
  // Event ids start at 1, so a runner with no failure comes before every one with a failure.
  const rank = (runnerId: string): number => failures.get(runnerId) ?? (runnerId === last?.runner_id ? -1 : 0);
  return able.sort((a, b) => rank(a.id) - rank(b.id))[0]?.id ?? null;
}

/**
 * Sends the next merge when none is in flight: one merge at a time, so each leases on the main the one before it left.
 * Called when a task starts merging, when a merge's result arrives, and by every tick, which also retries a merge that
 * failed once its wait is over (mergeDue); a task that waits holds up no other. A task with nothing a runner can merge
 * stays merging until a person marks it merged. None goes out while the project is paused past its deadline
 * (deadline.ts); the one in flight still lands. Gives the merge_task it queued, or null.
 */
export function queueMerges(ctx: HubContext): CommandRow | null {
  return tx(ctx, () => {
    const cancel = ctx.db.query(
      "UPDATE runner_commands SET status = 'cancelled', done_at = $now WHERE id = $id AND status = 'pending'",
    );
    for (const pending of pendingMerges(ctx)) {
      if (pending.answerable && findTask(ctx, pending.taskId)?.status === 'merging') return null;
      cancel.run({ id: pending.id, now: ctx.now() });
    }
    // At its deadline the hub pauses the project: main takes no more merges until Resume, or a later deadline.
    const { paused, deadlineAt } = getProject(ctx);
    if (paused && deadlineAt !== null && deadlineAt <= ctx.now()) return null;
    for (const task of mergingTasks(ctx)) {
      const head = mergeableHead(task);
      if (head === null || !mergeDue(ctx, task.id)) continue;
      const runnerId = mergeRunner(ctx, task.id);
      if (runnerId === null) return null;
      return enqueueCommand(ctx, runnerId, { kind: 'merge_task', taskId: task.id, title: task.title, ...head });
    }
    return null;
  });
}
