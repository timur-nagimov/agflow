// The submission rows of runner agents (design 6.13): reads, inserts, failures and the shas a push may adopt. The
// modules that end attempts and record outcomes build on it, so it imports none of them.
import { type Attempt, CommitShaSchema, type SubmissionRecord } from '@agflow/core';
import { attemptSubject, findAttempt, listAttempts } from './attempt-store';
import type { HubContext } from './context';
import { nextId } from './db';
import type { Emit } from './events';

export interface SubmissionRow {
  id: string;
  task_id: string;
  attempt_id: string;
  status: SubmissionRecord['status'];
  summary: string;
  evidence: string;
  head_sha: string | null;
  remote_head: string | null;
  error: string | null;
  requested_at: number;
  decided_at: number | null;
}

export function rowToSubmission(row: SubmissionRow): SubmissionRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    attemptId: row.attempt_id,
    status: row.status,
    summary: row.summary,
    evidence: JSON.parse(row.evidence) as string[],
    headSha: row.head_sha,
    error: row.error,
    requestedAt: row.requested_at,
    decidedAt: row.decided_at,
  };
}

export function findSubmission(ctx: HubContext, id: string): SubmissionRecord | null {
  const row = ctx.db.query('SELECT * FROM submissions WHERE id = $id').get({ id }) as SubmissionRow | null;
  return row ? rowToSubmission(row) : null;
}

/** The task's submissions, newest first, as the task detail lists them. */
export function listSubmissions(ctx: HubContext, taskId: string): SubmissionRecord[] {
  const rows = ctx.db
    .query('SELECT * FROM submissions WHERE task_id = $taskId ORDER BY requested_at DESC, rowid DESC')
    .all({ taskId }) as SubmissionRow[];
  return rows.map(rowToSubmission);
}

/** The attempt's pending submission; the submissions_one_pending index allows at most one. */
export function pendingSubmissionOf(ctx: HubContext, attemptId: string): SubmissionRecord | null {
  const row = ctx.db
    .query("SELECT * FROM submissions WHERE attempt_id = $attemptId AND status = 'pending'")
    .get({ attemptId }) as SubmissionRow | null;
  return row ? rowToSubmission(row) : null;
}

export interface NewSubmission {
  taskId: string;
  attemptId: string;
  summary: string;
  evidence: string[];
}

/** A pending submission S-<n>, requested now. */
export function insertSubmission(ctx: HubContext, input: NewSubmission): SubmissionRecord {
  const id = `S-${nextId(ctx.db, 'submission')}`;
  ctx.db
    .query(
      `INSERT INTO submissions (id, task_id, attempt_id, status, summary, evidence, requested_at)
       VALUES ($id, $taskId, $attemptId, 'pending', $summary, $evidence, $now)`,
    )
    .run({
      id,
      taskId: input.taskId,
      attemptId: input.attemptId,
      summary: input.summary,
      evidence: JSON.stringify(input.evidence),
      now: ctx.now(),
    });
  return findSubmission(ctx, id) as SubmissionRecord;
}

/** The data every event about one submission carries (design 6.17). */
export function submissionData(submission: SubmissionRecord, attempt: Attempt | null): Record<string, unknown> {
  return {
    submissionId: submission.id,
    attemptId: submission.attemptId,
    taskId: submission.taskId,
    agentId: attempt?.agentId ?? null,
    runnerId: attempt?.runnerId ?? null,
  };
}

/** Fails a pending submission with its error, and emits submission.failed. */
export function failSubmission(
  ctx: HubContext,
  emit: Emit,
  submission: SubmissionRecord,
  error: string,
  actor = 'system',
): SubmissionRecord {
  ctx.db
    .query("UPDATE submissions SET status = 'failed', error = $error, decided_at = $now WHERE id = $id")
    .run({ id: submission.id, error, now: ctx.now() });
  const attempt = findAttempt(ctx, submission.attemptId);
  emit({
    type: 'submission.failed',
    actor,
    subject: attempt ? attemptSubject(attempt) : submission.taskId,
    data: { ...submissionData(submission, attempt), error },
  });
  return findSubmission(ctx, submission.id) as SubmissionRecord;
}

/**
 * An attempt that ends with a submission pending fails it, "attempt ended: <reason>", in the ending's transaction
 * (design 6.13). The ending cancels its push_submission with the attempt's other commands.
 */
export function failPendingSubmission(ctx: HubContext, emit: Emit, attempt: Attempt, actor = 'system'): void {
  const pending = pendingSubmissionOf(ctx, attempt.id);
  if (pending) failSubmission(ctx, emit, pending, `attempt ended: ${attempt.endReason ?? 'unknown reason'}`, actor);
}

/** The head the hub recorded for the task's branch, which a push expects to find there; null when none is known. */
export function branchHeadOf(ctx: HubContext, taskId: string): string | null {
  const row = ctx.db.query('SELECT branch_head FROM tasks WHERE id = $taskId').get({ taskId }) as {
    branch_head: string | null;
  } | null;
  return row?.branch_head ?? null;
}

/**
 * The shas the hub knows as agflow work for the task (design 6.13), which a push accepts as the branch's remote head:
 * every attempt's start and WIP, oldest first, the heads of its recorded runner submissions and of M1's live
 * submissions, and the recorded branch head. Each once, in that order.
 */
export function adoptableShas(ctx: HubContext, taskId: string): string[] {
  const shas: (string | null)[] = [];
  for (const attempt of listAttempts(ctx, { task: taskId }).reverse()) shas.push(attempt.startSha, attempt.wipSha);
  const submitted = ctx.db
    .query(
      `SELECT head_sha FROM submissions WHERE task_id = $taskId AND status = 'submitted' AND head_sha IS NOT NULL
       ORDER BY requested_at, rowid`,
    )
    .all({ taskId }) as { head_sha: string }[];
  shas.push(...submitted.map((row) => row.head_sha));
  const live = ctx.db
    .query(
      `SELECT json_extract(data, '$.headSha') AS head_sha FROM events
       WHERE type = 'task.submitted' AND subject = $taskId AND json_extract(data, '$.headSha') IS NOT NULL ORDER BY id`,
    )
    .all({ taskId }) as { head_sha: string }[];
  shas.push(...live.map((row) => row.head_sha));
  shas.push(branchHeadOf(ctx, taskId));
  // push_submission takes commit shas only.
  const known = shas.filter((sha): sha is string => sha !== null && CommitShaSchema.safeParse(sha).success);
  return [...new Set(known)];
}
