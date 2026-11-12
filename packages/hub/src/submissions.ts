// Submissions from runner agents (design 6.13). Runner agents cannot push, so a submit has two phases: the request
// here creates a pending submission and sends push_submission, and the runner's attempt.submitted records the outcome.
import {
  type Agent,
  type Attempt,
  FIXABLE_SUBMIT_ERRORS,
  type RunnerEventData,
  type SubmissionRecord,
  type Task,
  parseAttemptId,
  plannedTaskMove,
  quoteLines,
} from '@agflow/core';
import {
  appendAttemptLog,
  attemptSubject,
  getAttempt,
  openAttemptOf,
  updateAttempt,
} from './attempt-store';
import { attemptData, requestStop } from './attempts';
import { cancelPendingOfKind, enqueueCommand } from './commands';
import { type HubContext, tx } from './context';
import { badRequest, conflict, forbidden, notFound } from './errors';
import type { Emit } from './events';
import { refreshLeadSubmission, submissionReviewInstruction } from './lead-review';
import { insertMessage } from './messages';
import {
  type SubmissionRow,
  adoptableShas,
  branchHeadOf,
  failSubmission,
  findSubmission,
  insertSubmission,
  pendingSubmissionOf,
  rowToSubmission,
  submissionData,
} from './submission-store';
import { findTask, getTask, move, setAgentTask, writeTask } from './task-store';
import { requireHolder } from './tasks';
import { clip } from './text';

// The reads live in submission-store.ts, below the modules that end attempts; callers import them from here.
export { adoptableShas, listSubmissions, pendingSubmissionOf } from './submission-store';

export interface RunnerSubmitInput {
  summary: string;
  evidence: string[];
}

/**
 * A runner agent's submit (design 6.13, Request), in one transaction. A second submit while one is pending returns
 * the pending one, whatever it says. Otherwise the holder test applies, with no stop or take-over recorded, and the
 * hub creates a pending S-<n> and sends push_submission at the attempt's fence: the task branch, the head the hub
 * recorded for it as the expected one, and the shas it may adopt as the remote head. The task does not move until the
 * outcome arrives. token is the agent token the request came with (requireHolder).
 */
export function requestSubmission(
  ctx: HubContext,
  taskId: string,
  agent: Agent,
  input: RunnerSubmitInput,
  token: string | null = null,
): SubmissionRecord {
  return tx(ctx, (emit) => {
    if (agent.origin !== 'runner') throw badRequest('a live chat submits its branch and head with the task');
    const task = getTask(ctx, taskId);
    const attempt = requireHolder(ctx, task, agent, 'attempt', token);
    if (!attempt || attempt.runnerId === null) throw forbidden(`you do not hold ${task.id}`);
    const pending = pendingSubmissionOf(ctx, attempt.id);
    if (pending) return pending;
    requireHolder(ctx, task, agent, 'claim', token);
    if (task.branch === null) throw conflict(`${task.id} has no branch to push`);
    const submission = insertSubmission(ctx, {
      taskId: task.id,
      attemptId: attempt.id,
      summary: input.summary,
      evidence: input.evidence,
    });
    enqueueCommand(ctx, attempt.runnerId, {
      kind: 'push_submission',
      attemptId: attempt.id,
      fence: attempt.fence,
      submissionId: submission.id,
      branch: task.branch,
      expectedBranchSha: branchHeadOf(ctx, task.id),
      adoptable: adoptableShas(ctx, task.id),
    });
    emit({
      type: 'submission.pending',
      actor: `agent:${agent.id}`,
      subject: attemptSubject(attempt),
      data: submissionData(submission, attempt),
    });
    return submission;
  });
}

/**
 * GET /api/submissions/:id (design 6.16): the submitting agent polls it, and people read it. agentId is the calling
 * agent's, null for a person; any other agent is refused.
 */
export function getSubmission(ctx: HubContext, id: string, agentId: string | null): SubmissionRecord {
  const submission = findSubmission(ctx, id);
  if (!submission) throw notFound(`submission ${id}`);
  if (agentId !== null) {
    const row = ctx.db.query('SELECT agent_id FROM attempts WHERE id = $id').get({ id: submission.attemptId }) as {
      agent_id: string;
    } | null;
    if (row?.agent_id !== agentId) throw forbidden(`submission ${id} is another agent's`);
  }
  return submission;
}

// ---------------------------------------------------------------------------
// Outcomes (design 6.13, Push, Recording, The agent's answer) and the timeout
// ---------------------------------------------------------------------------

type Outcome = RunnerEventData['attempt.submitted'];
type FixableError = (typeof FIXABLE_SUBMIT_ERRORS)[number];

const named = (task: Task): string => `${task.id} ("${clip(task.title, 120)}")`;

/**
 * A refusal as SubmissionRecord.error keeps it: the outcome's code, then the runner's detail as it came, after ': ',
 * so the bridge can tell the agent both (design 6.13, The agent's answer). core's splitSubmitError reads it back.
 */
const refusalText = (outcome: Outcome): string =>
  outcome.detail ? `${outcome.error ?? 'refused'}: ${outcome.detail}` : (outcome.error ?? 'refused');

/** The runner's detail, which may name the agent's files, quoted under a line naming where it came from. */
const detailOf = (runnerId: string | null, detail: string | null): string =>
  detail ? `\n[detail from runner ${runnerId ?? 'unknown'}]\n${quoteLines(detail)}` : '';

/** What the agent fixes after a refusal it can fix; the runner's detail, passed on with it, may say more. */
function whatToFix(error: FixableError, branch: string): string {
  switch (error) {
    case 'dirty':
      return 'your clone has uncommitted changes, and the runner pushes only commits. Commit them';
    case 'protected_paths':
      return 'your commits change protected paths, which runner agents never change. Follow the detail below';
    case 'needs_merge':
      return (
        `someone added commits to ${branch} on top of agflow work. Run \`git fetch origin && git merge ` +
        `origin/${branch}\` and resolve any conflicts`
      );
  }
}

/** What a failure the agent cannot fix tells it: its work is safe, and what it may do next (X-33). */
const safeWork = (attempt: Attempt): string =>
  `Your work is safe in your WIP ref ${attempt.wipRef ?? '(none)'}. You may submit again, or call declare_blocked.`;

function tellAgent(ctx: HubContext, emit: Emit, attempt: Attempt, taskId: string, body: string): void {
  insertMessage(ctx, emit, { from: 'system', to: `agent:${attempt.agentId}`, taskId, body });
}

/** The heads an outcome reports, kept on its submission whatever the outcome: a refusal's remote head shows people. */
function recordHeads(ctx: HubContext, submission: SubmissionRecord, outcome: Outcome): void {
  ctx.db
    .query(
      `UPDATE submissions SET head_sha = COALESCE($head, head_sha), remote_head = COALESCE($remote, remote_head)
       WHERE id = $id`,
    )
    .run({ id: submission.id, head: outcome.headSha, remote: outcome.remoteHead });
}

/** A stop held back while the submission was pending applies now that it failed, as a new request. */
function applyDeferredStop(ctx: HubContext, attemptId: string): void {
  const stop = getAttempt(ctx, attemptId).stopRequested;
  if (!stop?.deferred) return;
  requestStop(ctx, { attemptId, cause: stop.cause, reason: stop.reason, by: stop.by, deferred: false });
}

/**
 * Whether the success records the submission: it is pending and its attempt still the task's holder, which a stop
 * that moved the task when it was requested ended. A stop that moves the task only when the attempt ends does not
 * keep it from submitting (design 6.4).
 */
function recordable(task: Task, attempt: Attempt | null, submission: SubmissionRecord): attempt is Attempt {
  if (!attempt || submission.status !== 'pending' || attempt.status === 'ended') return false;
  return plannedTaskMove('submission', 'at_once', task, attempt.id) !== null;
}

/**
 * A success, in the outcome's transaction (design 6.13, Recording): the submission is recorded, the task submitted
 * with its branch head and its work position, and the attempt holds (hold_attempt). A recorded stop is dropped, with
 * its stop_attempt if the runner has not taken it; the requester of one held back for the submission is told. The lead
 * is told, as in M1.
 */
function recordSuccess(
  ctx: HubContext,
  emit: Emit,
  task: Task,
  attempt: Attempt,
  submission: SubmissionRecord,
  outcome: Outcome,
): void {
  const actor = `runner:${attempt.runnerId}`;
  const head = outcome.headSha;
  const now = ctx.now();
  ctx.db
    .query("UPDATE submissions SET status = 'submitted', error = NULL, decided_at = $now WHERE id = $id")
    .run({ id: submission.id, now });
  const branch = task.branch;
  move(ctx, emit, task, 'submitted', actor, {
    changes: {
      submission: {
        summary: submission.summary,
        evidence: submission.evidence,
        branch,
        headSha: head,
        submittedAt: now,
        by: attempt.agentId,
        attemptId: attempt.id,
        submissionId: submission.id,
      },
      ...(branch && head ? { workRef: `refs/heads/${branch}`, workSha: head } : {}),
    },
    data: { branch, headSha: head, attemptId: attempt.id, submissionId: submission.id },
  });
  setAgentTask(ctx, attempt.agentId, null);
  const stop = attempt.stopRequested;
  updateAttempt(ctx, attempt.id, { status: 'holding', leaseExpiresAt: null, submittedSha: head, stopRequested: null });
  if (stop) cancelPendingOfKind(ctx, attempt.id, 'stop_attempt');
  const hold = { kind: 'hold_attempt', attemptId: attempt.id, fence: attempt.fence } as const;
  enqueueCommand(ctx, attempt.runnerId as string, hold);
  if (stop?.deferred) {
    insertMessage(ctx, emit, {
      from: 'system',
      to: stop.by.startsWith('agent:') ? stop.by : 'humans',
      taskId: task.id,
      body:
        `The ${stop.cause} of attempt ${attempt.id} that ${stop.by} asked for was dropped: its submission ` +
        `${submission.id} was recorded, and ${task.id} is up for review.`,
    });
  }
  insertMessage(ctx, emit, {
    from: 'system',
    to: 'lead',
    taskId: task.id,
    body:
      `${named(task)} was submitted by ${attempt.agentId} for review on branch ${branch ?? '(none)'} at ` +
      `${head ?? 'an unknown head'}.\n${attempt.agentId} wrote:\n${quoteLines(clip(submission.summary, 1500))}\n` +
      submissionReviewInstruction(branch),
  });
  refreshLeadSubmission(ctx, task.id, branch);
  const recorded = findSubmission(ctx, submission.id) as SubmissionRecord;
  emit({
    type: 'submission.recorded',
    actor,
    subject: attemptSubject(attempt),
    data: { ...submissionData(recorded, attempt), headSha: head, branch },
  });
  emit({
    type: 'attempt.holding',
    actor,
    subject: attemptSubject(attempt),
    data: { ...attemptData(getAttempt(ctx, attempt.id)), submissionId: submission.id },
  });
}

/**
 * A success agflow no longer counts on (design 6.13): an attempt that is no longer current, or a submission that
 * failed. The push landed, so only the branch head is recorded; the lead, the agent of a submission
 * that had failed, and the task's current holder hear that the branch moved, the holder with what to merge.
 */
function recordLateSuccess(
  ctx: HubContext,
  emit: Emit,
  task: Task,
  attempt: Attempt | null,
  submission: SubmissionRecord,
  outcome: Outcome,
): void {
  const branch = task.branch ?? '(none)';
  const head = outcome.headSha ?? 'an unknown head';
  insertMessage(ctx, emit, {
    from: 'system',
    to: 'lead',
    taskId: task.id,
    body:
      `${named(task)}: its branch ${branch} moved to ${head}. Submission ${submission.id} of attempt ` +
      `${submission.attemptId} was pushed after agflow stopped counting on it, so it is not up for review.`,
  });
  let told: string | null = null;
  if (attempt && attempt.status !== 'ended' && submission.status === 'failed') {
    tellAgent(
      ctx,
      emit,
      attempt,
      task.id,
      `Submission ${submission.id} of ${task.id}, which had failed (${submission.error ?? 'no reason'}), was pushed ` +
        `after all: ${branch} is at ${head}. It is not up for review; submit again once your work is done.`,
    );
    told = attempt.agentId;
  }
  const holder = openAttemptOf(ctx, task.id);
  if (!holder || holder.agentId === told || holder.id === attempt?.id || task.branch === null) return;
  if (holder.runnerId !== null) {
    const refs = [`refs/heads/${task.branch}`];
    enqueueCommand(ctx, holder.runnerId, { kind: 'refresh_vault', taskId: task.id, refs });
  }
  insertMessage(ctx, emit, {
    from: 'system',
    to: `agent:${holder.agentId}`,
    taskId: task.id,
    body:
      `The branch ${branch} of ${task.id} moved to ${head}: an earlier attempt's submission was pushed late. Merge ` +
      `it before you go on: \`git fetch origin && git merge origin/${branch}\`.`,
  });
}

/**
 * A refusal of a pending submission (design 6.13): it fails with the outcome's code and detail, and the agent hears
 * why. A fixable one says what to fix. branch_moved blocks the task for people with both shas and stops the attempt
 * with a handoff; remote and interrupted fail it as the timeout does (X-33). A stop held back for it applies.
 */
function recordRefusal(
  ctx: HubContext,
  emit: Emit,
  task: Task,
  attempt: Attempt,
  submission: SubmissionRecord,
  outcome: Outcome,
): void {
  const actor = `runner:${attempt.runnerId}`;
  failSubmission(ctx, emit, submission, refusalText(outcome), actor);
  const branch = task.branch ?? '(none)';
  const detail = detailOf(attempt.runnerId, outcome.detail);
  const error = outcome.error;
  if (error !== null && (FIXABLE_SUBMIT_ERRORS as readonly string[]).includes(error)) {
    const fix = whatToFix(error as FixableError, branch);
    tellAgent(
      ctx,
      emit,
      attempt,
      task.id,
      `Your submission ${submission.id} of ${task.id} was refused (${error}): ${fix}, then submit again.${detail}`,
    );
    applyDeferredStop(ctx, attempt.id);
    return;
  }
  if (error === 'branch_moved') {
    const remote = outcome.remoteHead ?? 'an unknown commit';
    const head = outcome.headSha ?? 'an unknown commit';
    tellAgent(
      ctx,
      emit,
      attempt,
      task.id,
      `Your submission ${submission.id} of ${task.id} was refused: ${branch} moved outside agflow, to ${remote}. ` +
        `${task.id} is blocked for people, and agflow stops this attempt: write a handoff note. Your work is safe ` +
        `in your WIP ref ${attempt.wipRef ?? '(none)'}.${detail}`,
    );
    const reason =
      `Its branch ${branch} moved outside agflow: the remote head is ${remote}, which is not agflow work, and ` +
      `submission ${submission.id} was ${head}. Look at the branch, keep what is worth keeping, then unblock it.`;
    requestStop(ctx, { attemptId: attempt.id, cause: 'branch_moved', reason, by: 'system' });
    insertMessage(ctx, emit, {
      from: 'system',
      to: 'humans',
      taskId: task.id,
      body: `${named(task)} is blocked. ${reason} Unblocking it makes agflow adopt ${remote} as the branch head.`,
    });
    return;
  }
  const why = error === 'interrupted' ? 'a stop or hold interrupted its push' : 'the runner could not push it';
  const failed = `Your submission ${submission.id} of ${task.id} failed: ${why}.`;
  tellAgent(ctx, emit, attempt, task.id, `${failed} ${safeWork(attempt)}${detail}`);
  applyDeferredStop(ctx, attempt.id);
}

/**
 * A success naming a submission the hub does not have, after a restore: the push landed, so the branch head of the
 * task the attempt works on is recorded, and nothing else (design 6.3).
 */
function recordUnknownSuccess(
  ctx: HubContext,
  attempt: Attempt | null,
  event: { attemptId: string; data: Outcome },
): void {
  const { submissionId, headSha } = event.data;
  if (attempt) appendAttemptLog(ctx, attempt.id, 'note', `pushed submission ${submissionId}, unknown to the hub`);
  const taskId = attempt ? attempt.taskId : (parseAttemptId(event.attemptId)?.taskId ?? null);
  if (headSha !== null && taskId !== null && findTask(ctx, taskId)) writeTask(ctx, taskId, { branchHead: headSha });
}

/**
 * attempt.submitted, whatever the attempt's standing (design 6.3): the heads it reports are recorded on the submission
 * first, and a success also records the task's branch head, even after the attempt ended or for a submission the hub
 * does not have. A success of a pending submission whose attempt still holds the task is recorded (recordSuccess), a
 * repeat of a recorded one only records the heads, and any other success records only the head (recordLateSuccess). A
 * refusal fails a pending submission (recordRefusal). Every outcome of a submission that had already failed is told to
 * its agent, while its attempt is open: the bridge's poll may have answered before it.
 */
export function onSubmitted(
  ctx: HubContext,
  emit: Emit,
  runnerId: string,
  attempt: Attempt | null,
  event: { attemptId: string; data: Outcome },
): void {
  const outcome = event.data;
  const submission = findSubmission(ctx, outcome.submissionId);
  if (!submission) {
    if (outcome.ok) recordUnknownSuccess(ctx, attempt, event);
    else if (attempt) appendAttemptLog(ctx, attempt.id, 'note', `refused submission ${outcome.submissionId}, unknown`);
    return;
  }
  // An outcome names its own attempt's submission: dispatch checked only the attempt.
  if (submission.attemptId !== event.attemptId) {
    if (attempt) {
      appendAttemptLog(ctx, attempt.id, 'rejected', `an outcome for submission ${outcome.submissionId}, not its own`);
    }
    return;
  }
  recordHeads(ctx, submission, outcome);
  const task = getTask(ctx, submission.taskId);
  if (outcome.ok) {
    if (outcome.headSha !== null) writeTask(ctx, task.id, { branchHead: outcome.headSha });
    // The runner reports a push again when it re-runs a journaled command; the first report recorded it.
    if (submission.status === 'submitted' && submission.headSha === outcome.headSha) return;
    if (recordable(task, attempt, submission)) recordSuccess(ctx, emit, task, attempt, submission, outcome);
    else recordLateSuccess(ctx, emit, getTask(ctx, task.id), attempt, submission, outcome);
    return;
  }
  if (submission.status === 'pending' && attempt && attempt.status !== 'ended') {
    recordRefusal(ctx, emit, task, attempt, submission, outcome);
    return;
  }
  if (submission.status === 'failed' && attempt && attempt.status !== 'ended') {
    tellAgent(
      ctx,
      emit,
      attempt,
      task.id,
      `Submission ${submission.id} of ${task.id}, which had failed (${submission.error ?? 'no reason'}), was also ` +
        `refused by runner ${runnerId}: ${outcome.error ?? 'refused'}.${detailOf(runnerId, outcome.detail)}`,
    );
  }
}

/**
 * Fails every submission still pending after submitTimeoutMs (design 6.13, Timeout), each in its attempt transaction:
 * error remote, its push_submission cancelled, its agent told that its work is safe, and a stop held back for it
 * applied. Returns how many failed.
 */
export function expireSubmissions(ctx: HubContext): number {
  const rows = ctx.db
    .query("SELECT * FROM submissions WHERE status = 'pending' AND requested_at <= $cutoff ORDER BY requested_at")
    .all({ cutoff: ctx.now() - ctx.config.submitTimeoutMs }) as SubmissionRow[];
  let failed = 0;
  for (const row of rows) {
    try {
      tx(ctx, (emit) => {
        const submission = rowToSubmission(row);
        cancelPendingOfKind(ctx, submission.attemptId, 'push_submission');
        failSubmission(ctx, emit, submission, 'remote');
        const attempt = getAttempt(ctx, submission.attemptId);
        const minutes = Math.round(ctx.config.submitTimeoutMs / 60_000);
        tellAgent(
          ctx,
          emit,
          attempt,
          submission.taskId,
          `Your submission ${submission.id} of ${submission.taskId} failed: it was still pending after ${minutes} ` +
            `minutes. ${safeWork(attempt)}`,
        );
        applyDeferredStop(ctx, attempt.id);
      });
      failed += 1;
    } catch (error) {
      console.error(`failing submission ${row.id} at its timeout failed`, error);
    }
  }
  return failed;
}
