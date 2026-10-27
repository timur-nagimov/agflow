import {
  type Agent,
  type BlockedKind,
  type NewTask,
  type Task,
  type TaskContract,
  type TaskDetail,
  type TaskNote,
  type TaskPatch,
  type TaskStatus,
  assertTransition,
  isClosed,
  isDone,
  isHeld,
  pathsOverlap,
} from '@agflow/core';
import { statusFor } from './agents';
import { type HubContext, tx } from './context';
import { nextId } from './db';
import { type Emit, listEvents } from './events';
import { badRequest, conflict, forbidden, notFound } from './errors';
import { currentGoalVersion } from './goal';
import { insertMessage, listMessages } from './messages';
import { getProject } from './project';
import { clip } from './text';

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
}

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
    submission: row.submission ? (JSON.parse(row.submission) as Task['submission']) : null,
    feedback: row.feedback,
    mergedSha: row.merged_sha,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function contractOf(task: Task): TaskContract {
  return {
    title: task.title,
    kind: task.kind,
    objective: task.objective,
    why: task.why,
    nonGoals: task.nonGoals,
    acceptance: task.acceptance,
    checks: task.checks,
    ownedPaths: task.ownedPaths,
    dependsOn: task.dependsOn,
    priority: task.priority,
  };
}

export function findTask(ctx: HubContext, id: string): Task | null {
  const row = ctx.db.query('SELECT * FROM tasks WHERE id = $id').get({ id }) as TaskRow | null;
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
  const rows = ctx.db.query('SELECT * FROM tasks ORDER BY seq').all() as TaskRow[];
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
  }[];
  return rows.map((row) => ({
    id: row.id,
    taskId: row.task_id,
    kind: row.kind,
    body: row.body,
    author: row.author,
    createdAt: row.created_at,
  }));
}

export function getTaskDetail(ctx: HubContext, id: string): TaskDetail {
  const task = getTask(ctx, id);
  return {
    task,
    notes: listTaskNotes(ctx, id),
    events: listEvents(ctx.db, { subject: id, limit: 500 }),
    messages: listMessages(ctx, { taskId: id }),
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface Changes {
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
}

const COLUMNS: Record<keyof Changes, string> = {
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
};

function writeTask(ctx: HubContext, id: string, changes: Changes): void {
  const sets = ['updated_at = $now'];
  const params: Record<string, string | number | null> = { id, now: ctx.now() };
  for (const [key, value] of Object.entries(changes) as [keyof Changes, unknown][]) {
    if (value === undefined) continue;
    sets.push(`${COLUMNS[key]} = $${key}`);
    const isJson = key === 'contract' || key === 'submission';
    params[key] = isJson ? (value === null ? null : JSON.stringify(value)) : (value as string | number | null);
  }
  ctx.db.query(`UPDATE tasks SET ${sets.join(', ')} WHERE id = $id`).run(params);
}

interface MoveOptions {
  changes?: Omit<Changes, 'status'>;
  event?: string;
  data?: Record<string, unknown>;
}

/** Moves a task to a new status, applies the changes and emits one event. */
function move(ctx: HubContext, emit: Emit, task: Task, to: TaskStatus, actor: string, options: MoveOptions = {}): Task {
  assertTransition(task.status, to);
  writeTask(ctx, task.id, { ...options.changes, status: to });
  emit({ type: options.event ?? `task.${to}`, actor, subject: task.id, data: { from: task.status, ...options.data } });
  return getTask(ctx, task.id);
}

function setAgentTask(ctx: HubContext, agentId: string, taskId: string | null): void {
  ctx.db.query('UPDATE agents SET current_task = $taskId WHERE id = $agentId').run({ taskId, agentId });
}

function addNote(ctx: HubContext, taskId: string, kind: TaskNote['kind'], body: string, author: string): void {
  ctx.db
    .query('INSERT INTO task_notes (task_id, kind, body, author, created_at) VALUES ($taskId, $kind, $body, $author, $now)')
    .run({ taskId, kind, body, author, now: ctx.now() });
}

function unmetDependencies(ctx: HubContext, dependsOn: string[]): string[] {
  return dependsOn.filter((id) => {
    const dependency = findTask(ctx, id);
    return !dependency || !isDone(dependency.status);
  });
}

const waitingReason = (ids: string[]) => `waiting on ${ids.join(', ')}`;

/** True when following dependsOn links from `from` reaches `target`. */
function reaches(ctx: HubContext, from: string, target: string, seen = new Set<string>()): boolean {
  if (from === target) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  const task = findTask(ctx, from);
  return task !== null && task.dependsOn.some((next) => reaches(ctx, next, target, seen));
}

const HOUR = 60 * 60_000;

function creationGuard(ctx: HubContext, count: number): string | null {
  const open = (
    ctx.db
      .query("SELECT COUNT(*) AS n FROM tasks WHERE status NOT IN ('accepted', 'merging', 'merged', 'cancelled', 'failed')")
      .get() as { n: number }
  ).n;
  if (open + count > ctx.config.maxOpenTasks) {
    return `creating ${count} more task(s) would exceed the limit of ${ctx.config.maxOpenTasks} open tasks`;
  }
  const recent = (
    ctx.db.query('SELECT COUNT(*) AS n FROM tasks WHERE created_at > $since').get({ since: ctx.now() - HOUR }) as { n: number }
  ).n;
  if (recent + count > ctx.config.maxTasksPerHour) {
    return `creating ${count} more task(s) would exceed the limit of ${ctx.config.maxTasksPerHour} new tasks per hour`;
  }
  return null;
}

function tripGuard(ctx: HubContext, reason: string, actor: string): never {
  tx(ctx, (emit) => {
    const alreadyTold =
      ctx.db.query("SELECT 1 FROM events WHERE type = 'guard.tripped' AND ts > $since").get({ since: ctx.now() - HOUR }) !==
      null;
    emit({ type: 'guard.tripped', actor, data: { reason } });
    if (!alreadyTold) {
      insertMessage(ctx, emit, {
        from: 'system',
        to: 'humans',
        body: `A safety limit stopped ${actor}: ${reason}. Check the plan. If this is expected, raise the limit in the hub configuration.`,
      });
    }
  });
  throw conflict(reason);
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export function createTasks(ctx: HubContext, inputs: NewTask[], actor: string): Task[] {
  const refusal = creationGuard(ctx, inputs.length);
  if (refusal) tripGuard(ctx, refusal, actor);
  return tx(ctx, (emit) => {
    const goalVersion = currentGoalVersion(ctx);
    const created: Task[] = [];
    inputs.forEach((input, index) => {
      const dependsOn = input.dependsOn.map((ref) => {
        if (!ref.startsWith('#')) {
          if (!findTask(ctx, ref)) throw badRequest(`task ${index + 1} depends on unknown task ${ref}`);
          return ref;
        }
        const position = Number(ref.slice(1));
        const earlier = created[position - 1];
        if (position < 1 || position > index || !earlier) {
          throw badRequest(`task ${index + 1}: ${ref} must refer to an earlier task in the same batch`);
        }
        return earlier.id;
      });
      const contract: TaskContract = {
        title: input.title,
        kind: input.kind,
        objective: input.objective,
        why: input.why,
        nonGoals: input.nonGoals,
        acceptance: input.acceptance,
        checks: input.checks,
        ownedPaths: input.ownedPaths,
        dependsOn,
        priority: input.priority,
      };
      const seq = nextId(ctx.db, 'task');
      const id = `T-${seq}`;
      const waiting = unmetDependencies(ctx, dependsOn);
      const status: TaskStatus = waiting.length > 0 ? 'blocked' : 'ready';
      const now = ctx.now();
      ctx.db
        .query(
          `INSERT INTO tasks (id, seq, status, contract, assignee, branch, goal_version, lease_expires_at, blocked_kind,
             blocked_reason, submission, feedback, merged_sha, created_by, created_at, updated_at, last_reminded_at)
           VALUES ($id, $seq, $status, $contract, NULL, NULL, $goalVersion, NULL, $blockedKind,
             $blockedReason, NULL, NULL, NULL, $actor, $now, $now, NULL)`,
        )
        .run({
          id,
          seq,
          status,
          contract: JSON.stringify(contract),
          goalVersion,
          blockedKind: waiting.length > 0 ? 'deps' : null,
          blockedReason: waiting.length > 0 ? waitingReason(waiting) : null,
          actor,
          now,
        });
      emit({ type: 'task.created', actor, subject: id, data: { title: contract.title, status } });
      created.push(getTask(ctx, id));
    });
    return created;
  });
}

export function updateTask(ctx: HubContext, id: string, patch: TaskPatch, actor: string): Task {
  return tx(ctx, (emit) => {
    const task = getTask(ctx, id);
    if (isClosed(task.status)) throw conflict(`${id} is ${task.status} and can no longer change`);
    for (const dependency of patch.dependsOn ?? []) {
      if (!findTask(ctx, dependency)) throw badRequest(`unknown task ${dependency}`);
      if (reaches(ctx, dependency, id)) throw badRequest(`depending on ${dependency} would create a dependency cycle`);
    }
    const contract: TaskContract = { ...contractOf(task), ...patch };
    writeTask(ctx, id, { contract });
    emit({ type: 'task.updated', actor, subject: id, data: { fields: Object.keys(patch) } });
    const fresh = getTask(ctx, id);
    const dependencyBlocked = fresh.status === 'blocked' && fresh.blockedKind === 'deps';
    if (patch.dependsOn && (fresh.status === 'ready' || dependencyBlocked)) {
      const waiting = unmetDependencies(ctx, fresh.dependsOn);
      if (waiting.length > 0 && fresh.status === 'ready') {
        move(ctx, emit, fresh, 'blocked', 'system', { changes: { blockedKind: 'deps', blockedReason: waitingReason(waiting) } });
      } else if (waiting.length === 0 && dependencyBlocked) {
        move(ctx, emit, fresh, 'ready', 'system', { changes: { blockedKind: null, blockedReason: null } });
      } else if (waiting.length > 0) {
        writeTask(ctx, id, { blockedReason: waitingReason(waiting) });
      }
    }
    return getTask(ctx, id);
  });
}

export function cancelTask(ctx: HubContext, id: string, reason: string, actor: string): Task {
  return tx(ctx, (emit) => {
    const task = getTask(ctx, id);
    const holder = isHeld(task.status) ? task.assignee : null;
    const cancelled = move(ctx, emit, task, 'cancelled', actor, {
      changes: { assignee: null, leaseExpiresAt: null },
      data: { reason },
    });
    if (holder) {
      setAgentTask(ctx, holder, null);
      insertMessage(ctx, emit, {
        from: actor,
        to: `agent:${holder}`,
        taskId: id,
        body: `Task ${id} was cancelled: ${reason}\nStop working on it. Commit and push anything worth keeping to ${task.branch ?? 'its branch'}.`,
      });
    }
    return cancelled;
  });
}
