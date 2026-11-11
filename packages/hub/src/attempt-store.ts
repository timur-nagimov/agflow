// The attempt rows (design 6.1, 6.4): reads, inserts and updates, fences, numbers and the per-attempt log. The
// modules that start, stop and end attempts build on it.
import type {
  AgentRole,
  Attempt,
  AttemptEndReason,
  AttemptFacts,
  AttemptLogEntry,
  AttemptPhase,
  AttemptStatus,
  FailureClass,
  Fence,
  Task,
  Vendor,
} from '@agflow/core';
import type { HubContext } from './context';
import { nextId } from './db';
import { notFound } from './errors';
import { hubEpoch } from './hub-state';
import { writeTask } from './task-store';
import { clip } from './text';

/**
 * A resume after a runner restart, or an unrequested exit of a lead; repeated ones within resumeWindowMs or
 * leadExitWindowMs end the attempt.
 */
export interface ResumeLogEntry {
  at: number;
  cause: 'runner_restart' | 'lead_exit';
}

export interface AttemptRow {
  id: string;
  task_id: string | null;
  number: number;
  role: AgentRole;
  agent_id: string;
  runner_id: string | null;
  vendor: Vendor;
  model: string | null;
  session_ref: string | null;
  fence_epoch: number;
  fence_counter: number;
  status: AttemptStatus;
  end_reason: AttemptEndReason | null;
  failure_class: FailureClass | null;
  failure_signature: string | null;
  start_ref: string | null;
  start_sha: string | null;
  wip_ref: string | null;
  wip_sha: string | null;
  submitted_sha: string | null;
  resumable: number;
  review_rounds: number;
  wakeups: number;
  active_ms: number;
  resume_log: string | null;
  phase: AttemptPhase | null;
  facts: string | null;
  facts_at: number | null;
  stop_requested: string | null;
  takeover: string | null;
  final_sha: string | null;
  compaction_summary: string | null;
  transcript_tail: string | null;
  lease_expires_at: number | null;
  quota_resets_at: number | null;
  started_at: number;
  ended_at: number | null;
  last_activity_at: number;
}

const parseJson = <T>(text: string | null): T | null => (text === null ? null : (JSON.parse(text) as T));

export function rowToAttempt(row: AttemptRow): Attempt {
  return {
    id: row.id,
    taskId: row.task_id,
    number: row.number,
    role: row.role,
    agentId: row.agent_id,
    runnerId: row.runner_id,
    vendor: row.vendor,
    model: row.model,
    sessionRef: row.session_ref,
    fence: { epoch: row.fence_epoch, counter: row.fence_counter },
    status: row.status,
    endReason: row.end_reason,
    failureClass: row.failure_class,
    failureSignature: row.failure_signature,
    startRef: row.start_ref,
    startSha: row.start_sha,
    wipRef: row.wip_ref,
    wipSha: row.wip_sha,
    submittedSha: row.submitted_sha,
    resumable: row.resumable === 1,
    reviewRounds: row.review_rounds,
    wakeups: row.wakeups,
    activeMs: row.active_ms,
    phase: row.phase,
    facts: parseJson<AttemptFacts>(row.facts),
    stopRequested: parseJson<Attempt['stopRequested']>(row.stop_requested),
    takeover: parseJson<Attempt['takeover']>(row.takeover),
    leaseExpiresAt: row.lease_expires_at,
    quotaResetsAt: row.quota_resets_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    lastActivityAt: row.last_activity_at,
  };
}

export function findAttempt(ctx: HubContext, id: string): Attempt | null {
  const row = ctx.db.query('SELECT * FROM attempts WHERE id = $id').get({ id }) as AttemptRow | null;
  return row ? rowToAttempt(row) : null;
}

export function getAttempt(ctx: HubContext, id: string): Attempt {
  const attempt = findAttempt(ctx, id);
  if (!attempt) throw notFound(`attempt ${id}`);
  return attempt;
}

export interface AttemptFilter {
  task?: string | undefined;
  role?: AgentRole | undefined;
  status?: AttemptStatus[] | undefined;
  runner?: string | undefined;
  limit?: number | undefined;
}

/** Newest first: by start, then by insertion for attempts started in the same millisecond. */
export function listAttempts(ctx: HubContext, filter: AttemptFilter = {}): Attempt[] {
  const where: string[] = [];
  const params: Record<string, string | number> = {};
  if (filter.task !== undefined) {
    where.push('task_id = $task');
    params.task = filter.task;
  }
  if (filter.role !== undefined) {
    where.push('role = $role');
    params.role = filter.role;
  }
  if (filter.runner !== undefined) {
    where.push('runner_id = $runner');
    params.runner = filter.runner;
  }
  if (filter.status !== undefined) {
    where.push(`status IN (${filter.status.map((_, index) => `$status${index}`).join(', ') || 'NULL'})`);
    filter.status.forEach((status, index) => {
      params[`status${index}`] = status;
    });
  }
  if (filter.limit !== undefined) params.limit = filter.limit;
  const rows = ctx.db
    .query(
      `SELECT * FROM attempts ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY started_at DESC, rowid DESC ${filter.limit !== undefined ? 'LIMIT $limit' : ''}`,
    )
    .all(params) as AttemptRow[];
  return rows.map(rowToAttempt);
}

/** The task's attempt that has not ended; the attempts_one_open index allows at most one. */
export function openAttemptOf(ctx: HubContext, taskId: string): Attempt | null {
  const row = ctx.db
    .query("SELECT * FROM attempts WHERE task_id = $taskId AND status != 'ended'")
    .get({ taskId }) as AttemptRow | null;
  return row ? rowToAttempt(row) : null;
}

/** A new fence: the hub epoch and the next value of a counter that never goes back, so a later fence is newer. */
export function issueFence(ctx: HubContext): Fence {
  return { epoch: hubEpoch(ctx), counter: nextId(ctx.db, 'fence') };
}

/**
 * The next attempt number: one past the task's highest, or, for the lead seat (taskId null), the next value of the
 * lead_attempt counter. Call it in the transaction that inserts the attempt.
 */
export function nextAttemptNumber(ctx: HubContext, taskId: string | null): number {
  if (taskId === null) return nextId(ctx.db, 'lead_attempt');
  const row = ctx.db.query('SELECT MAX(number) AS n FROM attempts WHERE task_id = $taskId').get({ taskId }) as {
    n: number | null;
  };
  return (row.n ?? 0) + 1;
}

export interface NewAttempt {
  /** From naming.ts: attemptId(taskId, number, fence.epoch), or leadAttemptId(number, fence.epoch). */
  id: string;
  taskId: string | null;
  number: number;
  role: AgentRole;
  agentId: string;
  runnerId: string | null;
  vendor: Vendor;
  fence: Fence;
  status: AttemptStatus;
  startRef?: string | null | undefined;
  startSha?: string | null | undefined;
  wipRef?: string | null | undefined;
  leaseExpiresAt?: number | null | undefined;
}

/** Inserts the attempt, which becomes its task's current attempt (design 6.4). */
export function insertAttempt(ctx: HubContext, input: NewAttempt): Attempt {
  const now = ctx.now();
  ctx.db
    .query(
      `INSERT INTO attempts (id, task_id, number, role, agent_id, runner_id, vendor, fence_epoch, fence_counter, status,
         start_ref, start_sha, wip_ref, lease_expires_at, started_at, last_activity_at)
       VALUES ($id, $taskId, $number, $role, $agentId, $runnerId, $vendor, $fenceEpoch, $fenceCounter, $status,
         $startRef, $startSha, $wipRef, $leaseExpiresAt, $now, $now)`,
    )
    .run({
      id: input.id,
      taskId: input.taskId,
      number: input.number,
      role: input.role,
      agentId: input.agentId,
      runnerId: input.runnerId,
      vendor: input.vendor,
      fenceEpoch: input.fence.epoch,
      fenceCounter: input.fence.counter,
      status: input.status,
      startRef: input.startRef ?? null,
      startSha: input.startSha ?? null,
      wipRef: input.wipRef ?? null,
      leaseExpiresAt: input.leaseExpiresAt ?? null,
      now,
    });
  if (input.taskId !== null) writeTask(ctx, input.taskId, { currentAttempt: input.id });
  return getAttempt(ctx, input.id);
}

/** Fields an update may change; undefined leaves a field as it is, null clears it. */
export interface AttemptChanges {
  model?: string | null;
  sessionRef?: string | null;
  fence?: Fence;
  status?: AttemptStatus;
  endReason?: AttemptEndReason | null;
  failureClass?: FailureClass | null;
  failureSignature?: string | null;
  startRef?: string | null;
  startSha?: string | null;
  wipRef?: string | null;
  wipSha?: string | null;
  submittedSha?: string | null;
  resumable?: boolean;
  reviewRounds?: number;
  wakeups?: number;
  activeMs?: number;
  resumeLog?: ResumeLogEntry[] | null;
  phase?: AttemptPhase | null;
  facts?: AttemptFacts | null;
  factsAt?: number | null;
  stopRequested?: Attempt['stopRequested'];
  takeover?: Attempt['takeover'];
  finalSha?: string | null;
  compactionSummary?: string | null;
  transcriptTail?: string | null;
  leaseExpiresAt?: number | null;
  quotaResetsAt?: number | null;
  endedAt?: number | null;
  lastActivityAt?: number;
}

const COLUMNS: Record<Exclude<keyof AttemptChanges, 'fence'>, keyof AttemptRow> = {
  model: 'model',
  sessionRef: 'session_ref',
  status: 'status',
  endReason: 'end_reason',
  failureClass: 'failure_class',
  failureSignature: 'failure_signature',
  startRef: 'start_ref',
  startSha: 'start_sha',
  wipRef: 'wip_ref',
  wipSha: 'wip_sha',
  submittedSha: 'submitted_sha',
  resumable: 'resumable',
  reviewRounds: 'review_rounds',
  wakeups: 'wakeups',
  activeMs: 'active_ms',
  resumeLog: 'resume_log',
  phase: 'phase',
  facts: 'facts',
  factsAt: 'facts_at',
  stopRequested: 'stop_requested',
  takeover: 'takeover',
  finalSha: 'final_sha',
  compactionSummary: 'compaction_summary',
  transcriptTail: 'transcript_tail',
  leaseExpiresAt: 'lease_expires_at',
  quotaResetsAt: 'quota_resets_at',
  endedAt: 'ended_at',
  lastActivityAt: 'last_activity_at',
};

const JSON_FIELDS = new Set<keyof AttemptChanges>(['resumeLog', 'facts', 'stopRequested', 'takeover']);

export function updateAttempt(ctx: HubContext, id: string, changes: AttemptChanges): void {
  const sets: string[] = [];
  const params: Record<string, string | number | null> = { id };
  for (const [key, value] of Object.entries(changes) as [keyof AttemptChanges, unknown][]) {
    if (value === undefined) continue;
    if (key === 'fence') {
      const fence = value as Fence;
      sets.push('fence_epoch = $fenceEpoch', 'fence_counter = $fenceCounter');
      params.fenceEpoch = fence.epoch;
      params.fenceCounter = fence.counter;
      continue;
    }
    sets.push(`${COLUMNS[key]} = $${key}`);
    if (JSON_FIELDS.has(key)) params[key] = value === null ? null : JSON.stringify(value);
    else if (typeof value === 'boolean') params[key] = value ? 1 : 0;
    else params[key] = value as string | number | null;
  }
  if (sets.length > 0) ctx.db.query(`UPDATE attempts SET ${sets.join(', ')} WHERE id = $id`).run(params);
}

/** Each attempt keeps its newest entries; older ones go as new ones come (design 6.18). */
const LOG_ENTRIES_KEPT = 500;
const LOG_SUMMARY_MAX = 2_000;

export function appendAttemptLog(
  ctx: HubContext,
  attemptId: string,
  kind: AttemptLogEntry['kind'],
  summary: string,
): void {
  ctx.db
    .query('INSERT INTO attempt_log (attempt_id, ts, kind, summary) VALUES ($attemptId, $ts, $kind, $summary)')
    .run({ attemptId, ts: ctx.now(), kind, summary: clip(summary, LOG_SUMMARY_MAX) });
  ctx.db
    .query(
      `DELETE FROM attempt_log WHERE attempt_id = $attemptId AND id <= (
         SELECT id FROM attempt_log WHERE attempt_id = $attemptId ORDER BY id DESC LIMIT 1 OFFSET $kept)`,
    )
    .run({ attemptId, kept: LOG_ENTRIES_KEPT });
}

/** The attempt's log, oldest first. */
export function attemptLog(ctx: HubContext, attemptId: string): AttemptLogEntry[] {
  const rows = ctx.db
    .query('SELECT id, attempt_id, ts, kind, summary FROM attempt_log WHERE attempt_id = $attemptId ORDER BY id')
    .all({ attemptId }) as {
    id: number;
    attempt_id: string;
    ts: number;
    kind: AttemptLogEntry['kind'];
    summary: string;
  }[];
  return rows.map((row) => ({
    id: row.id,
    attemptId: row.attempt_id,
    ts: row.ts,
    kind: row.kind,
    summary: row.summary,
  }));
}

/** The subject of an attempt's events (design 6.17): its task, or for a lead attempt the attempt itself. */
export function attemptSubject(attempt: Pick<Attempt, 'id' | 'taskId'>): string {
  return attempt.taskId ?? attempt.id;
}

// ---------------------------------------------------------------------------
// Unpushed work (design 6.4 Work position, 6.8 Replacement step 4)
// ---------------------------------------------------------------------------

/**
 * Whether the task's work position is still the attempt's own (design 6.4): its WIP, or, when it never pushed one,
 * where it started, which for an attempt that started from main is no position at all.
 */
export function positionIsOwn(task: Pick<Task, 'workSha'>, attempt: Pick<Attempt, 'wipSha' | 'startSha'>): boolean {
  if (attempt.wipSha !== null) return task.workSha === attempt.wipSha;
  return task.workSha === null || task.workSha === attempt.startSha;
}

/** A commit the attempt harvested that is neither its pushed WIP nor where it started: its final push failed. */
export const isUnpushed = (sha: string | null, attempt: Pick<Attempt, 'wipSha' | 'startSha'>): sha is string =>
  sha !== null && sha !== attempt.wipSha && sha !== attempt.startSha;

/** The harvested head an attempt reported at its exit, even when its push failed. */
function finalShaOf(ctx: HubContext, attemptId: string): string | null {
  const row = ctx.db.query('SELECT final_sha FROM attempts WHERE id = $id').get({ id: attemptId }) as {
    final_sha: string | null;
  } | null;
  return row?.final_sha ?? null;
}

/**
 * The runner attempt's harvested head while it is only in its runner's vault: its final push failed, no late work
 * brought it to the task yet, and the task's work position is still the attempt's own. Null otherwise.
 */
export function unpushedHead(
  ctx: HubContext,
  task: Pick<Task, 'workSha'>,
  attempt: Attempt,
): { runnerId: string; sha: string } | null {
  if (attempt.runnerId === null) return null;
  const sha = finalShaOf(ctx, attempt.id);
  if (!isUnpushed(sha, attempt) || sha === task.workSha || !positionIsOwn(task, attempt)) return null;
  return { runnerId: attempt.runnerId, sha };
}
