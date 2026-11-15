// Reviews (AGFLOW_REVIEW, with AGFLOW_AUTO_ACCEPT): the hub does not accept a task's first submission whose check
// passed at once. It creates a review task, by system, that starts at the submitted head, and the task stays
// submitted, its author's attempt holding, until the reviewer submits a verdict. The hub takes the verdict in the
// reviewer's submit, with no push, applies it as hub:review and cancels the review task, which is never merged. A
// review that does not finish lets the hub accept as before (expireReviews, from the tick). A review is found by the
// title in its task.created event, as a demo check is, so the reads below use nothing from tasks.ts.
import {
  type Attempt,
  type NewTask,
  NewTaskSchema,
  type SubmissionRecord,
  type Task,
  type TaskStatus,
  type Vendor,
  isClosed,
  quoteLines,
} from '@agflow/core';
import { attemptSubject, findAttempt } from './attempt-store';
import { composeTaskPack } from './brief';
import { type HubContext, tx } from './context';
import { badRequest } from './errors';
import type { Emit } from './events';
import { insertMessage } from './messages';
import { placementSnapshot } from './placement';
import { AUTO_ACCEPT, findSubmission, insertSubmission, submissionData } from './submission-store';
import { findTask, listTasks, writeTask } from './task-store';
import { acceptTask, cancelTask, createTasks, creationGuard, rejectTask } from './tasks';
import { clip, oneLine } from './text';

/** A task the system created with a title that starts so is a review, whatever its title is now. */
export const REVIEW_TITLE = 'Review of';

/** Who applies a reviewer's verdict. */
export const REVIEW = 'hub:review';

/**
 * A review with no attempt this long after it was created, or after the project last ran again (lastResumed), lets
 * the hub accept its task as before.
 */
export const REVIEW_START_MS = 5 * 60_000;

/** The same for a review with no verdict this long after it was created, or after the project last ran again. */
export const REVIEW_FINISH_MS = 20 * 60_000;

/** core's limit on a title. */
const TITLE_MAX = 200;

/** The neighbouring tasks a review's pack lists at most, and the most of each one's summary it quotes. */
const NEIGHBOURS_SHOWN = 30;
const NEIGHBOUR_SUMMARY = 300;

/** What a review reviews: a task and the submission of it that passed its check. */
export interface ReviewTarget {
  taskId: string;
  submissionId: string;
}

/** The title reviewContract gives: "Review of T-12 (S-34): <the task's title>". */
const TARGET = /^Review of (T-\d+) \((S-\d+)\): /;

function targetOf(title: string | null | undefined): ReviewTarget | null {
  const match = title?.match(TARGET);
  return match ? { taskId: match[1] as string, submissionId: match[2] as string } : null;
}

/** What the task reviews, when the system created it as a review; null for any other task. */
export function reviewTarget(ctx: HubContext, taskId: string): ReviewTarget | null {
  const row = ctx.db
    .query(
      `SELECT json_extract(data, '$.title') AS title FROM events
       WHERE type = 'task.created' AND actor = 'system' AND subject = $taskId`,
    )
    .get({ taskId }) as { title: string | null } | null;
  return targetOf(row?.title);
}

interface Review extends ReviewTarget {
  id: string;
  status: TaskStatus;
  createdAt: number;
  /** Whether an attempt of the review was ever started. */
  started: boolean;
}

/** Every review, oldest first. */
function reviews(ctx: HubContext): Review[] {
  const rows = ctx.db
    .query(
      `SELECT tasks.id, tasks.status, tasks.created_at, tasks.current_attempt,
         json_extract(events.data, '$.title') AS title
       FROM events JOIN tasks ON tasks.id = events.subject
       WHERE events.type = 'task.created' AND events.actor = 'system'
         AND json_extract(events.data, '$.title') LIKE $title
       ORDER BY events.id`,
    )
    .all({ title: `${REVIEW_TITLE} T-%` }) as {
    id: string;
    status: TaskStatus;
    created_at: number;
    current_attempt: string | null;
    title: string | null;
  }[];
  return rows.flatMap((row) => {
    const target = targetOf(row.title);
    if (!target) return [];
    const started = row.current_attempt !== null;
    return [{ ...target, id: row.id, status: row.status, createdAt: row.created_at, started }];
  });
}

/** The submitted tasks, each with the submission it waits on. */
function waitingSubmissions(ctx: HubContext): Map<string, string | null> {
  const rows = ctx.db
    .query("SELECT id, json_extract(submission, '$.submissionId') AS submission FROM tasks WHERE status = 'submitted'")
    .all() as { id: string; submission: string | null }[];
  return new Map(rows.map((row) => [row.id, row.submission]));
}

/**
 * The tasks agents are reviewing now, each with its review: the review is open, and the task still waits on the
 * submission it reviews. The lead leaves these to their reviewers.
 */
export function tasksUnderReview(ctx: HubContext): Map<string, string> {
  const waiting = waitingSubmissions(ctx);
  const under = new Map<string, string>();
  for (const review of reviews(ctx)) {
    if (!isClosed(review.status) && waiting.get(review.taskId) === review.submissionId) {
      under.set(review.taskId, review.id);
    }
  }
  return under;
}

// ---------------------------------------------------------------------------
// Creating a review (recordSuccess)
// ---------------------------------------------------------------------------

const OTHER: Readonly<Record<Vendor, Vendor>> = { claude: 'codex', codex: 'claude' };

/** Whether an online runner that is not draining offers the vendor ready. */
function offered(ctx: HubContext, vendor: Vendor): boolean {
  return placementSnapshot(ctx).runners.some(
    (runner) =>
      runner.state === 'online' &&
      !runner.draining &&
      runner.vendors.some((slot) => slot.vendor === vendor && slot.ready && slot.notReadySince === null),
  );
}

/** Whether a review of the task was ever created. */
function everReviewed(ctx: HubContext, taskId: string): boolean {
  const row = ctx.db
    .query(
      `SELECT 1 FROM events WHERE type = 'task.created' AND actor = 'system'
         AND json_extract(data, '$.title') LIKE $title LIMIT 1`,
    )
    .get({ title: `${REVIEW_TITLE} ${taskId} (%` });
  return row !== null;
}

/** The verdict lines a reviewer may start its summary with, as the contract and the refusals name them. */
const VERDICTS = '`VERDICT: accept`, `VERDICT: accept with follow-ups` or `VERDICT: reject`';

/** The review's contract for a submission of the task; vendorHint is the vendor that should review it, if any. */
export function reviewContract(
  task: Pick<Task, 'id' | 'title'>,
  submissionId: string,
  vendorHint: Vendor | null,
): NewTask {
  const { id } = task;
  const objective = [
    `Review submission ${submissionId} of ${id} before agflow accepts it. Your clone is at its head, with the ` +
      "dependencies prepared. After this contract, this file holds the author's summary and evidence (claims to " +
      `test, not facts), the check's result, the neighbouring tasks and ${id}'s whole contract.`,
    `1. Read SPEC.md, AGENTS.md and ${id}'s contract, then the change: \`git diff origin/main...HEAD\` and ` +
      '`git log origin/main..HEAD`.',
    `2. Look for: behaviour that differs from SPEC.md or ${id}'s contract; logic fitted to the examples in the ` +
      'contract or SPEC.md (try inputs of your own); code nothing calls (a route, handler or job not registered, a ' +
      'feature not linked); tests that pin wrong behaviour or test below the real entry point; acceptance criteria ' +
      "not met; work that duplicates or breaks a neighbour's; plain security holes (a secret in the code, an " +
      'injection).',
    '3. Run commands of your own: tests, one-shot scripts, inputs through the real entry point. Do not start a ' +
      "server that keeps running, do not run the project's check again (it passed), do not merge main, and change, " +
      'commit and push nothing.',
    '4. Reject only for a blocking finding, and give for each the command or input that shows it and what came out. ' +
      'A finding without one is a follow-up. Style is not a finding.',
    '5. A question only the lead can decide (owned paths, an interface between tasks) goes to the lead with ' +
      'send_message; decide the verdict on the rest.',
    `6. Finish with submit. The summary's first line is exactly one of ${VERDICTS}; the lines after it are the ` +
      'findings (reject) or the follow-ups. Evidence lines: what you ran and what it showed.',
  ].join('\n');
  return NewTaskSchema.parse({
    title: clip(`${REVIEW_TITLE} ${id} (${submissionId}): ${task.title}`, TITLE_MAX),
    kind: 'review',
    objective,
    why:
      `${id}'s check passed, but a check does not see work that misses the spec, that nothing calls or that only ` +
      'fits the examples. A defect found now goes back to its author, whose session still knows the work.',
    nonGoals: ['Fixing what you find: a rejection sends it back to the author.', "Running the project's check again."],
    acceptance: [
      { id: 'A1', assertion: `The submit summary's first line is exactly ${VERDICTS}.` },
      { id: 'A2', assertion: 'Each blocking finding gives the command or input that shows it, and what came out.' },
    ],
    priority: 1,
    tier: 'strong',
    ...(vendorHint === null ? {} : { vendorHint }),
  });
}

/**
 * Creates the review of a submission whose check passed, in place of the hub's accept (recordSuccess, AGFLOW_REVIEW):
 * for a task an agent or a person created, the first time one of its submissions passes, while the task limits allow
 * one more task. The review starts at the submitted head, and prefers the vendor other than the author's while a
 * runner offers it. It runs inside a runner event's transaction, where a throw would reject the event for good, so
 * any failure is caught and leaves no review, and the caller accepts as before. Returns whether it created one.
 */
export function requestReview(
  ctx: HubContext,
  task: Task,
  attempt: Attempt,
  submission: SubmissionRecord,
  headSha: string | null,
): boolean {
  const branch = task.branch;
  if (!ctx.config.review || task.createdBy === 'system' || branch === null || headSha === null) return false;
  try {
    if (everReviewed(ctx, task.id) || creationGuard(ctx, 1) !== null) return false;
    const other = OTHER[attempt.vendor];
    const contract = reviewContract(task, submission.id, offered(ctx, other) ? other : null);
    return tx(ctx, () => {
      const [review] = createTasks(ctx, [contract], 'system');
      if (!review) return false;
      writeTask(ctx, review.id, { workRef: `refs/heads/${branch}`, workSha: headSha });
      return true;
    });
  } catch (error) {
    console.error(`the review of ${task.id} could not be created; the hub accepts it as before`, error);
    return false;
  }
}

/**
 * Where every attempt of a review starts (startPositionFor): the reviewed task's branch at the submitted head. Never an
 * earlier reviewer's WIP or unpushed commit, which would show the next reviewer a file the earlier one left behind as
 * part of the change. Null for any other task.
 */
export function reviewStart(ctx: HubContext, taskId: string): { ref: string; sha: string } | null {
  const target = reviewTarget(ctx, taskId);
  const branch = target && findTask(ctx, target.taskId)?.branch;
  const head = target && findSubmission(ctx, target.submissionId)?.headSha;
  return branch && head ? { ref: `refs/heads/${branch}`, sha: head } : null;
}

// ---------------------------------------------------------------------------
// What the reviewer gets (buildAttemptSpec)
// ---------------------------------------------------------------------------

/** The tasks merged since the task was first claimed, then those submitted or merging now, but the task itself. */
function neighbours(ctx: HubContext, taskId: string): Task[] {
  const claimed = ctx.db
    .query("SELECT MIN(id) AS id FROM events WHERE type = 'task.claimed' AND subject = $taskId")
    .get({ taskId }) as { id: number | null };
  const merged = ctx.db
    .query(
      `SELECT subject FROM events WHERE type = 'task.merged' AND id > $since AND subject IS NOT NULL
       GROUP BY subject ORDER BY MIN(id)`,
    )
    .all({ since: claimed.id ?? 0 }) as { subject: string }[];
  const ids = new Set(merged.map((row) => row.subject));
  for (const task of listTasks(ctx, { status: ['submitted', 'merging'] })) ids.add(task.id);
  ids.delete(taskId);
  return [...ids].flatMap((id) => findTask(ctx, id) ?? []);
}

/** A neighbouring task for the reviewer: what it is, where its work is, the paths it owns, the start of its summary. */
function neighbourLines(task: Task): string[] {
  const branch = task.branch ? ` on ${task.branch}` : '';
  const owns = task.ownedPaths.length > 0 ? `; owns ${task.ownedPaths.join(', ')}` : '';
  const head = `- ${task.id} [${task.status}] "${task.title}"${branch}${owns}`;
  const summary = task.submission?.summary;
  return summary ? [head, quoteLines(clip(summary, NEIGHBOUR_SUMMARY))] : [head];
}

/**
 * What a review's task pack adds to its own (buildAttemptSpec), in agflow's words, with what agents wrote quoted: the
 * submission and its check, the author's whole summary and every evidence line (claims to test), the neighbouring
 * tasks, and the reviewed task's whole pack. Empty for any other task.
 */
export function reviewPack(ctx: HubContext, task: Task): string {
  const target = reviewTarget(ctx, task.id);
  const reviewed = target && findTask(ctx, target.taskId);
  const submission = target && findSubmission(ctx, target.submissionId);
  if (!target || !reviewed || !submission) return '';
  const author = findAttempt(ctx, submission.attemptId);
  const check = submission.check;
  const ran =
    check && check.command !== null
      ? `The runner's check \`${oneLine(clip(check.command, 300))}\` ${check.status} in ` +
        `${Math.round(check.durationMs / 1000)} s, with main merged in. Do not run it again.`
      : '';
  const others = neighbours(ctx, reviewed.id);
  const listed = others.slice(0, NEIGHBOURS_SHOWN).flatMap(neighbourLines);
  if (others.length > NEIGHBOURS_SHOWN) listed.push(`and ${others.length - NEIGHBOURS_SHOWN} more.`);
  const lines = [
    '',
    `# Review of ${reviewed.id}, submission ${submission.id}`,
    'agflow wrote this part too. What it quotes with ">" was written by agents: claims to test, not facts.',
    '',
    '## The submission',
    `${reviewed.id}'s branch ${reviewed.branch ?? '(none)'} at ${submission.headSha ?? 'an unknown head'}, where ` +
      'your clone starts.' +
      (author ? ` ${author.agentId} submitted it, on ${author.vendor}.` : ''),
    ...(ran ? [ran] : []),
    '',
    "## The author's summary",
    quoteLines(submission.summary),
    '',
    "## The author's evidence",
    ...(submission.evidence.length > 0 ? submission.evidence.map((line) => quoteLines(line)) : ['None.']),
    '',
    '## Neighbouring tasks',
    `Merged since ${reviewed.id} was claimed, or submitted or merging now: look for work that duplicates or breaks ` +
      'theirs.',
    ...(listed.length > 0 ? listed : ['None.']),
    '',
    `## ${reviewed.id}'s own task pack`,
    `What ${reviewed.id}'s author had as .agflow/run/task.md:`,
    '',
    composeTaskPack(reviewed),
  ];
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// The verdict (requestSubmission)
// ---------------------------------------------------------------------------

type Verdict = 'accept' | 'accept with follow-ups' | 'reject';

/**
 * A reviewer's summary as a verdict and what follows it: its first line, read whatever the surrounding whitespace,
 * markdown emphasis and case. Null when that line is no verdict.
 */
export function readVerdict(summary: string): { verdict: Verdict; rest: string } | null {
  const [first = '', ...rest] = summary.trim().split('\n');
  const line = first.replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  const match = line.match(/^verdict ?: ?(accept with follow[- ]?ups?|accept|reject)\.?$/);
  if (!match) return null;
  const verdict: Verdict = match[1] === 'accept' || match[1] === 'reject' ? match[1] : 'accept with follow-ups';
  return { verdict, rest: rest.join('\n').trim() };
}

/** The verdict applied to the task: as hub:review, with the follow-ups to the lead, or the findings to the author. */
function applyVerdict(
  ctx: HubContext,
  emit: Emit,
  task: Task,
  review: Task,
  reviewer: Attempt,
  read: { verdict: Verdict; rest: string },
): void {
  const submissionId = task.submission?.submissionId ?? 'unknown';
  if (read.verdict === 'reject') {
    rejectTask(ctx, task.id, REVIEW, `${review.id}, the review of submission ${submissionId}, found:\n${read.rest}`);
    return;
  }
  acceptTask(ctx, task.id, REVIEW, `its check passed, and ${review.id} reviewed it`);
  if (read.verdict === 'accept' || read.rest === '') return;
  insertMessage(ctx, emit, {
    from: 'system',
    to: 'lead',
    taskId: task.id,
    body:
      `${review.id} reviewed ${task.id} ("${clip(task.title, 120)}"), and the hub accepted it. The reviewer's ` +
      `follow-ups, for you to plan or drop:\n${reviewer.agentId} wrote:\n${quoteLines(read.rest)}`,
  });
}

/**
 * A reviewer's submit (requestSubmission), in its transaction: the hub takes the verdict and asks for no push. A
 * summary that does not start with a verdict, or a reject with no findings, is refused with the format, and nothing
 * changes. Otherwise the submission is recorded as submitted, and the verdict applies while the reviewed task still
 * waits on the submission reviewed; one that cannot apply is dropped. The review is then cancelled: cancelled, not
 * accepted, so that it is never merged nor counted as done. Returns the submission.
 */
export function recordVerdict(
  ctx: HubContext,
  emit: Emit,
  review: Task,
  reviewer: Attempt,
  target: ReviewTarget,
  input: { summary: string; evidence: string[] },
): SubmissionRecord {
  const read = readVerdict(input.summary);
  if (!read) {
    throw badRequest(
      `a review's summary starts with its verdict, alone on the first line: exactly ${VERDICTS}. Put the findings ` +
        '(reject) or the follow-ups on the lines after it, and submit again.',
    );
  }
  if (read.verdict === 'reject' && read.rest === '') {
    throw badRequest(
      '`VERDICT: reject` needs the blocking findings on the lines after it, each with the command or input that ' +
        'shows it and what came out. Submit again with them.',
    );
  }
  const pending = insertSubmission(ctx, {
    taskId: review.id,
    attemptId: reviewer.id,
    summary: input.summary,
    evidence: input.evidence,
  });
  ctx.db
    .query("UPDATE submissions SET status = 'submitted', decided_at = $now WHERE id = $id")
    .run({ id: pending.id, now: ctx.now() });
  const submission = findSubmission(ctx, pending.id) as SubmissionRecord;
  emit({
    type: 'submission.recorded',
    actor: `agent:${reviewer.agentId}`,
    subject: attemptSubject(reviewer),
    data: { ...submissionData(submission, reviewer), headSha: null, branch: review.branch },
  });
  const task = findTask(ctx, target.taskId);
  if (task?.status === 'submitted' && task.submission?.submissionId === target.submissionId) {
    try {
      tx(ctx, (inner) => applyVerdict(ctx, inner, task, review, reviewer, read));
    } catch (error) {
      console.error(`the verdict of ${review.id} on ${task.id} could not be applied`, error);
    }
  }
  cancelTask(ctx, review.id, `review done: ${read.verdict}`, 'system');
  return submission;
}

// ---------------------------------------------------------------------------
// A review that does not finish (the scheduler's tick)
// ---------------------------------------------------------------------------

/** Whether the reviewer gave a verdict: recordVerdict records it as the review's submission. */
function hasVerdict(ctx: HubContext, reviewId: string): boolean {
  const row = ctx.db
    .query("SELECT 1 FROM submissions WHERE task_id = $reviewId AND status = 'submitted' LIMIT 1")
    .get({ reviewId });
  return row !== null;
}

/**
 * When the project last ran again: its newest resume after a pause, or the end of the hub's recovery window after
 * downtime; 0 when neither happened. No review can start during a pause or downtime.
 */
function lastResumed(ctx: HubContext): number {
  const row = ctx.db
    .query("SELECT MAX(ts) AS ts FROM events WHERE type IN ('project.resumed', 'system.recovery_ended')")
    .get() as { ts: number | null };
  return row.ts ?? 0;
}

/**
 * Why a review its task still waits for will give no verdict, or null while it may. Its times count from its creation,
 * or from when the project last ran again if that came later, so that a pause or downtime uses none of them up.
 */
function unfinished(ctx: HubContext, review: Review, now: number, resumed: number): string | null {
  if (isClosed(review.status)) return hasVerdict(ctx, review.id) ? null : 'it was closed without a verdict';
  if (review.status === 'blocked') return 'it is blocked';
  const age = now - Math.max(review.createdAt, resumed);
  if (!review.started && age >= REVIEW_START_MS) return `it did not start within ${REVIEW_START_MS / 60_000} minutes`;
  if (age >= REVIEW_FINISH_MS) return `it gave no verdict within ${REVIEW_FINISH_MS / 60_000} minutes`;
  return null;
}

/**
 * The tick's duty for reviews (AGFLOW_REVIEW), while the project is not paused. An open review whose task no longer
 * waits on the submission it reviews (the lead or a person decided, the task was submitted again or cancelled) is
 * cancelled. While the task waits, a review closed without a verdict, a blocked one, one with no attempt
 * REVIEW_START_MS after it was created and one REVIEW_FINISH_MS old let the hub accept the task as before, and an
 * open one is cancelled; both times count from when the project last ran again instead, if that came later
 * (lastResumed). Each review in its own transaction. Returns how many it settled.
 */
export function expireReviews(ctx: HubContext): number {
  const waiting = waitingSubmissions(ctx);
  const now = ctx.now();
  const resumed = lastResumed(ctx);
  let settled = 0;
  for (const review of reviews(ctx)) {
    const open = !isClosed(review.status);
    const waits = waiting.get(review.taskId) === review.submissionId;
    const why = waits ? unfinished(ctx, review, now, resumed) : null;
    if (waits ? why === null : !open) continue;
    try {
      tx(ctx, () => {
        if (waits) acceptTask(ctx, review.taskId, AUTO_ACCEPT, 'its check passed; its review did not finish');
        if (!open) return;
        const reason = waits
          ? `the review did not finish (${why}), so the hub accepted ${review.taskId} as its check passed`
          : `${review.taskId} no longer waits on ${review.submissionId}`;
        cancelTask(ctx, review.id, reason, 'system');
      });
      settled += 1;
    } catch (error) {
      console.error(`settling the review ${review.id} failed`, error);
    }
  }
  return settled;
}
