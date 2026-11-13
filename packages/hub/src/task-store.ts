// The task rows and the low-level moves every module shares, so attempts, the scheduler and runner events can move
// tasks without importing tasks.ts, which holds the operations of agents and people.
import {
  type BlockedKind,
  type Submission,
  type Task,
  type TaskContract,
  type TaskNote,
  type TaskStatus,
  assertTransition,
  isDone,
  pathsOverlap,
} from '@agflow/core';
import type { HubContext } from './context';
import type { Emit } from './events';
import { notFound } from './errors';

export interface TaskRow {
  id: string;
  seq: number;
  status: TaskStatus;
  contract: string;
  assignee: string | null;
  branch: string | null;
  goal_version: number;
  lease_expires_at: number | null;
  blocked_kind: BlockedKind | null;
  blocked_reason: string | null;
  submission: string | null;
  feedback: string | null;
  merged_sha: string | null;
  created_by: string;
  created_at: number;
  updated_at: number;
  last_reminded_at: number | null;
  current_attempt: string | null;
  ladder_floor: number;
  work_ref: string | null;
  work_sha: string | null;
  branch_head: string | null;
  next_dispatch_at: number | null;
  dispatch_hold_until: number | null;
  /** Not a column: TASK_SELECT counts the task's attempts. */
  attempt_count: number;
}

/** Selects task rows with their attempt count; add WHERE and ORDER BY clauses. */
export const TASK_SELECT =
  'SELECT tasks.*, (SELECT COUNT(*) FROM attempts WHERE attempts.task_id = tasks.id) AS attempt_count FROM tasks';

/** Submissions recorded before M2 carry no attempt or submission id. */
type StoredSubmission = Omit<Submission, 'attemptId' | 'submissionId'> & Partial<Submission>;

export function rowToTask(row: TaskRow): Task {
  const contract = JSON.parse(row.contract) as TaskContract;
  return {
    ...contract,
    id: row.id,
    status: row.status,
    assignee: row.assignee,
    branch: row.branch,
    goalVersion: row.goal_version,
    leaseExpiresAt: row.lease_expires_at,
    blockedKind: row.blocked_kind,
    blockedReason: row.blocked_reason,
    submission: row.submission
      ? { attemptId: null, submissionId: null, ...(JSON.parse(row.submission) as StoredSubmission) }
      : null,
    feedback: row.feedback,
    mergedSha: row.merged_sha,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    currentAttempt: row.current_attempt,
    attemptCount: row.attempt_count,
    workRef: row.work_ref,
    workSha: row.work_sha,
    nextDispatchAt: row.next_dispatch_at,
  };
}

export function findTask(ctx: HubContext, id: string): Task | null {
  const row = ctx.db.query(`${TASK_SELECT} WHERE id = $id`).get({ id }) as TaskRow | null;
  return row ? rowToTask(row) : null;
}

export function getTask(ctx: HubContext, id: string): Task {
  const task = findTask(ctx, id);
  if (!task) throw notFound(`task ${id}`);
  return task;
}

export interface TaskFilter {
  status?: TaskStatus[] | undefined;
  assignee?: string | undefined;
}

export function listTasks(ctx: HubContext, filter: TaskFilter = {}): Task[] {
  const rows = ctx.db.query(`${TASK_SELECT} ORDER BY seq`).all() as TaskRow[];
  return rows
    .map(rowToTask)
    .filter(
      (task) =>
        (!filter.status || filter.status.includes(task.status)) && (!filter.assignee || task.assignee === filter.assignee),
    );
}

export function listTaskNotes(ctx: HubContext, taskId: string): TaskNote[] {
  const rows = ctx.db.query('SELECT * FROM task_notes WHERE task_id = $taskId ORDER BY id').all({ taskId }) as {
    id: number;
    task_id: string;
    kind: TaskNote['kind'];
    body: string;
    author: string;
    created_at: number;
    attempt_id: string | null;
  }[];
  return rows.map((row) => ({
    id: row.id,
    taskId: row.task_id,
    kind: row.kind,
    body: row.body,
    author: row.author,
    createdAt: row.created_at,
    attemptId: row.attempt_id,
  }));
}

/** Columns a write may change; undefined leaves a column as it is, null clears it. */
export interface TaskChanges {
  status?: TaskStatus;
  assignee?: string | null;
  branch?: string | null;
  leaseExpiresAt?: number | null;
  blockedKind?: BlockedKind | null;
  blockedReason?: string | null;
  submission?: Task['submission'];
  feedback?: string | null;
  mergedSha?: string | null;
  contract?: TaskContract;
  lastRemindedAt?: number | null;
  /** Changes only when a new attempt is created (design 6.4). */
  currentAttempt?: string | null;
  workRef?: string | null;
  workSha?: string | null;
  branchHead?: string | null;
  nextDispatchAt?: number | null;
  dispatchHoldUntil?: number | null;
  ladderFloor?: number;
}

const COLUMNS: Record<keyof TaskChanges, string> = {
  status: 'status',
  assignee: 'assignee',
  branch: 'branch',
  leaseExpiresAt: 'lease_expires_at',
  blockedKind: 'blocked_kind',
  blockedReason: 'blocked_reason',
  submission: 'submission',
  feedback: 'feedback',
  mergedSha: 'merged_sha',
  contract: 'contract',
  lastRemindedAt: 'last_reminded_at',
  currentAttempt: 'current_attempt',
  workRef: 'work_ref',
  workSha: 'work_sha',
  branchHead: 'branch_head',
  nextDispatchAt: 'next_dispatch_at',
  dispatchHoldUntil: 'dispatch_hold_until',
  ladderFloor: 'ladder_floor',
};

export function writeTask(ctx: HubContext, id: string, changes: TaskChanges): void {
  const sets = ['updated_at = $now'];
  const params: Record<string, string | number | null> = { id, now: ctx.now() };
  for (const [key, value] of Object.entries(changes) as [keyof TaskChanges, unknown][]) {
    if (value === undefined) continue;
    sets.push(`${COLUMNS[key]} = $${key}`);
    const isJson = key === 'contract' || key === 'submission';
    params[key] = isJson ? (value === null ? null : JSON.stringify(value)) : (value as string | number | null);
  }
  ctx.db.query(`UPDATE tasks SET ${sets.join(', ')} WHERE id = $id`).run(params);
}

export interface MoveOptions {
  changes?: Omit<TaskChanges, 'status'>;
  event?: string;
  data?: Record<string, unknown>;
}

/** Moves a task to a new status, applies the changes and emits one event. */
export function move(
  ctx: HubContext,
  emit: Emit,
  task: Task,
  to: TaskStatus,
  actor: string,
  options: MoveOptions = {},
): Task {
  assertTransition(task.status, to);
  writeTask(ctx, task.id, { ...options.changes, status: to });
  emit({ type: options.event ?? `task.${to}`, actor, subject: task.id, data: { from: task.status, ...options.data } });
  return getTask(ctx, task.id);
}

/**
 * SQL that holds for a task whose current attempt is open on a runner: its runner lease stands in for the task's M1
 * lease, which stays NULL (design 6.4). Once that attempt has ended, M1's lease rules apply again, as they do for
 * openRunnerAttempt.
 */
export const RUNNER_HELD_SQL =
  'EXISTS (SELECT 1 FROM attempts WHERE attempts.id = tasks.current_attempt AND attempts.runner_id IS NOT NULL' +
  " AND attempts.status != 'ended')";

export function setAgentTask(ctx: HubContext, agentId: string, taskId: string | null): void {
  ctx.db.query('UPDATE agents SET current_task = $taskId WHERE id = $agentId').run({ taskId, agentId });
}

/** attemptId: the attempt a handoff, restatement or late-work note belongs to. */
export function addNote(
  ctx: HubContext,
  taskId: string,
  kind: TaskNote['kind'],
  body: string,
  author: string,
  attemptId: string | null = null,
): void {
  ctx.db
    .query(
      `INSERT INTO task_notes (task_id, kind, body, author, created_at, attempt_id)
       VALUES ($taskId, $kind, $body, $author, $now, $attemptId)`,
    )
    .run({ taskId, kind, body, author, now: ctx.now(), attemptId });
}

/** The dependencies not done yet: accepted counts, unless the hub is set to wait for the merge (dependenciesNeedMerge). */
export function unmetDependencies(ctx: HubContext, dependsOn: string[]): string[] {
  const done = ctx.config.dependenciesNeedMerge ? (status: TaskStatus) => status === 'merged' : isDone;
  return dependsOn.filter((id) => {
    const dependency = findTask(ctx, id);
    return !dependency || !done(dependency.status);
  });
}

export const waitingReason = (ids: string[]) => `waiting on ${ids.join(', ')}`;

/**
 * Why a task is blocked on its dependencies. A cancelled dependency will never be done, so instead of
 * naming it among the tasks it waits on, the reason asks for a decision.
 */
export function dependencyReason(ctx: HubContext, waiting: string[]): string {
  const cancelled = waiting.filter((id) => findTask(ctx, id)?.status === 'cancelled');
  if (cancelled.length === 0) return waitingReason(waiting);
  return `${cancelled.join(', ')} ${cancelled.length === 1 ? 'was' : 'were'} cancelled; amend or cancel this task`;
}

// ---------------------------------------------------------------------------
// Path holders (design 6.6)
// ---------------------------------------------------------------------------

/**
 * Decision 8, owned paths: a task cannot be claimed, sent back to its author or given more paths while
 * it is held, if another task whose owned paths overlap it holds them. Held work and work waiting for review
 * hold their paths, because a second branch on the same paths would conflict with it. So does work a person
 * took over or stopped and held, and work whose branch moved outside agflow: each comes back to the same
 * branch. The overlap test is conservative: it may block a pair that a full glob engine would allow, never
 * the reverse.
 */
const HOLDING_STATUSES: readonly TaskStatus[] = ['claimed', 'working', 'submitted', 'checking', 'reviewing'];
const HOLDING_BLOCKS: readonly BlockedKind[] = ['takeover', 'paused', 'branch_moved'];

export function isPathHolder(task: Pick<Task, 'status' | 'blockedKind'>): boolean {
  if (HOLDING_STATUSES.includes(task.status)) return true;
  return task.status === 'blocked' && task.blockedKind !== null && HOLDING_BLOCKS.includes(task.blockedKind);
}

/** Another task that holds paths overlapping the given task's, or null. */
export function overlappingPathHolder(ctx: HubContext, task: Pick<Task, 'id' | 'ownedPaths'>): Task | null {
  if (task.ownedPaths.length === 0) return null;
  return (
    listTasks(ctx, { status: [...HOLDING_STATUSES, 'blocked'] }).find(
      (other) => other.id !== task.id && isPathHolder(other) && pathsOverlap(task.ownedPaths, other.ownedPaths),
    ) ?? null
  );
}
