// Merging inside agflow (AGFLOW_AUTO_MERGE). An accepted task waits in merging, and one merge at a time goes to a
// runner as merge_task: the runner merges the accepted head into main in its vault and pushes main with its owner's
// git credentials, the ones that push task branches. The author's runner merges when it can, else any online runner
// whose git is ready and whose protocol knows merge_task. A merge_task left with a runner that went offline, or for a
// task no longer merging, is cancelled, and the next one goes out. tasks.ts records what a merge gave.
import { COMMAND_MIN_PROTOCOL, CommitShaSchema, type Task, isTaskBranch } from '@agflow/core';
import { type CommandRow, enqueueCommand } from './commands';
import { type HubContext, tx } from './context';
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

/** Where a task's merge goes: the runner of its last attempt, when it can take merge_task now, else the first that can. */
function mergeRunner(ctx: HubContext, taskId: string): string | null {
  const able = findRunnerRows(ctx).filter(
    (row) => row.state === 'online' && row.protocol >= COMMAND_MIN_PROTOCOL.merge_task && runnerInfo(row).git.ready,
  );
  const last = ctx.db
    .query(
      'SELECT runner_id FROM attempts WHERE task_id = $taskId AND runner_id IS NOT NULL ORDER BY number DESC LIMIT 1',
    )
    .get({ taskId }) as { runner_id: string } | null;
  return (able.find((row) => row.id === last?.runner_id) ?? able[0])?.id ?? null;
}

/**
 * Sends the next merge when none is in flight: one merge at a time, so each leases on the main the one before it left.
 * Called when a task starts merging, when a merge's result arrives, and by every tick, which also retries a merge that
 * failed. A task with nothing a runner can merge stays merging until a person marks it merged. Gives the merge_task
 * it queued, or null.
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
    for (const task of mergingTasks(ctx)) {
      const head = mergeableHead(task);
      if (head === null) continue;
      const runnerId = mergeRunner(ctx, task.id);
      if (runnerId === null) return null;
      return enqueueCommand(ctx, runnerId, { kind: 'merge_task', taskId: task.id, title: task.title, ...head });
    }
    return null;
  });
}
