// What the hub does when a runner comes back (design 6.3, Reconciliation on hello; 6.4, Lease expiry): it decides,
// in the hello transaction, every attempt it believes open on that runner from the state the runner reports, builds
// the list of attempts the runner must stop before it runs any command, and asks for the transcripts of attempts that
// ended lost while it was away. Resumes that wait for the runner to be ok, and transcript tails uploaded over HTTP,
// are here too.
import type { Attempt, HubMessage, LiveAttempt } from '@agflow/core';
import { findAttempt, getAttempt, listAttempts, updateAttempt } from './attempt-store';
import { endAttempt, recentResumes, resumeAttempt } from './attempts';
import { enqueueCommand } from './commands';
import { type HubContext, tx } from './context';
import { forbidden } from './errors';
import { type HelloMessage, findRunnerRow, setDeferredResumes, takeDeferredResumes } from './runners';
import { getTask, writeTask } from './task-store';

type WelcomeStop = Extract<HubMessage, { t: 'welcome' }>['stop'][number];

/** What reconciliation did to one open attempt, by the row that matched. */
export type ReconcileAction =
  /** The process is gone and a stop was recorded: it ended with the requested cause. */
  | 'ended'
  /** A take-over in flight with a clone: its pending prepare_takeover goes out again after welcome. */
  | 'takeover'
  /**
   * The runner still runs it, it stays holding, or its stop waits for a submission the replay may decide: its pending
   * commands go out again after welcome.
   */
  | 'kept'
  /** Stopped or suspended with a clone: resumed at a new fence. */
  | 'resumed'
  /** The same, while the runner is not ok: the resume waits for runner.state ok, and the lease keeps running. */
  | 'deferred'
  /** Not reported while its start_attempt is still pending: the start goes out again, with a fresh token. */
  | 'resent'
  /** Lost on the runner while it held a process, or restarted too often: it ended crashed. */
  | 'crashed'
  /** A holding attempt the runner no longer has: it cannot be resumed. */
  | 'unresumable';

export interface ReconcileResult {
  /** The attempts the runner must stop: reported, but ended, unknown or not this runner's. */
  stop: WelcomeStop[];
  /** What happened to each attempt the hub had open on the runner, in the order they were decided. */
  actions: { attemptId: string; action: ReconcileAction }[];
}

/** What a reconciliation resume tells the agent (design 6.3, resume_attempt). */
export const RESTART_PROMPT = 'the runner restarted; continue from your last step';

/** Runner-restart resumes within resumeWindowMs: the one that would reach this count ends the attempt crashed. */
const RESTART_RESUMES_LIMIT = 2;

const gone = (live: LiveAttempt | undefined): live is LiveAttempt =>
  live?.state === 'stopped' || live?.state === 'suspended';

/** The attempt's start_attempt has not been answered: the runner may never have had it. */
function startPending(ctx: HubContext, attemptId: string): boolean {
  const row = ctx.db
    .query(
      `SELECT 1 FROM runner_commands
       WHERE attempt_id = $attemptId AND kind = 'start_attempt' AND status = 'pending'`,
    )
    .get({ attemptId });
  return row !== null;
}

const actorOf = (attempt: Attempt): string => `runner:${attempt.runnerId}`;

/**
 * The process is gone, so a recorded stop is complete (invariant a): the attempt ends with the requested cause. While
 * the replay that may still hold its exit is pending, a task the ending made ready waits dispatchHoldMs, so that a
 * successor starts from the final WIP the exit reports (invariant b); that WIP, late work by then, ends the wait.
 */
function completeStop(ctx: HubContext, attempt: Attempt, replayPending = false): ReconcileAction {
  const cause = (attempt.stopRequested as NonNullable<Attempt['stopRequested']>).cause;
  const ending = endAttempt(ctx, { attemptId: attempt.id, trigger: cause, actor: actorOf(attempt) });
  if (replayPending && ending?.task?.status === 'ready') {
    writeTask(ctx, ending.task.id, { dispatchHoldUntil: ctx.now() + ctx.config.dispatchHoldMs });
  }
  return 'ended';
}

/**
 * A runner-restart resume at a new fence, or, when it would be the second within resumeWindowMs, the end of the
 * attempt: crashed.
 */
function restartResume(ctx: HubContext, attempt: Attempt): ReconcileAction {
  const actor = actorOf(attempt);
  const earlier = recentResumes(ctx, attempt.id, 'runner_restart', ctx.config.resumeWindowMs);
  if (earlier + 1 >= RESTART_RESUMES_LIMIT) {
    const error = `the runner restarted ${earlier + 1} times while the attempt ran`;
    endAttempt(ctx, { attemptId: attempt.id, trigger: 'crashed', error, actor });
    return 'crashed';
  }
  resumeAttempt(ctx, { attemptId: attempt.id, cause: 'runner_restart', prompt: RESTART_PROMPT, actor });
  return 'resumed';
}

/** What a hello says beyond its attempts. */
export interface ReconcileOptions {
  /** The runner holds events after the acknowledged position, which it replays once welcomed. */
  replayPending?: boolean | undefined;
}

/**
 * Decides one open attempt by the first row of the table that matches (the restore rows aside). ok: the hello's
 * state; while the runner is not ok, the resume row waits (X-36).
 */
function decide(
  ctx: HubContext,
  attempt: Attempt,
  live: LiveAttempt | undefined,
  ok: boolean,
  options: ReconcileOptions,
): ReconcileAction {
  const actor = actorOf(attempt);
  const stop = attempt.stopRequested;
  if (gone(live) && stop) {
    if (stop.cause === 'takeover' && live.clone) return 'takeover';
    // A deferred stop completes too: the ending fails its submission and applies it, and a success the replay still
    // holds records only the branch head (design 6.13).
    return completeStop(ctx, attempt, options.replayPending);
  }
  // A take-over the runner no longer has ends as the take-over it was: its task waits for a hand-back from a ref.
  if (!live && stop?.cause === 'takeover') return completeStop(ctx, attempt, options.replayPending);
  if (live && !gone(live)) return 'kept';
  if (gone(live) && live.clone) {
    if (attempt.status === 'holding') return 'kept';
    return ok ? restartResume(ctx, attempt) : 'deferred';
  }
  if (!live && attempt.status === 'starting' && startPending(ctx, attempt.id)) return 'resent';
  if (attempt.status === 'holding') {
    updateAttempt(ctx, attempt.id, { resumable: false });
    return 'unresumable';
  }
  const error = live ? "the runner lost the attempt's clone" : 'the runner no longer had the attempt';
  endAttempt(ctx, { attemptId: attempt.id, trigger: 'crashed', error, actor });
  return 'crashed';
}

/** Why the runner must stop a reported attempt, or null when it is the runner's to keep. */
function stopReason(ctx: HubContext, runnerId: string, attemptId: string): string | null {
  const attempt = findAttempt(ctx, attemptId);
  if (!attempt) return 'the hub does not know this attempt';
  if (attempt.runnerId !== runnerId) return `the attempt runs on ${attempt.runnerId ?? 'no runner'}`;
  if (attempt.status === 'ended') return `the attempt ended (${attempt.endReason ?? 'unknown reason'})`;
  return null;
}

/**
 * Reconciliation on hello (design 6.3), in the hello transaction: each attempt the hub has open on the runner is
 * decided from what the hello reports about it (X-36), by the first row of the table that matches. The rows after a
 * restore are decided elsewhere. While the hello's state is not ok, resumes wait for runner.state ok (resumeDeferred).
 * Then every reported attempt that is ended by now, unknown, or not this runner's goes to welcome.stop, and those that
 * ended lost bring their transcripts (onRunnerBack). Pending commands of the attempts that stay are sent again after
 * welcome, as every pending command is, and the runner's journal keeps it from running one twice.
 */
export function reconcileOnHello(
  ctx: HubContext,
  runnerId: string,
  hello: Pick<HelloMessage, 'attempts' | 'state'>,
  options: ReconcileOptions = {},
): ReconcileResult {
  const byId = new Map(hello.attempts.map((live) => [live.attemptId, live]));
  const open = listAttempts(ctx, { runner: runnerId, status: ['starting', 'running', 'quota_wait', 'holding'] });
  // Oldest first, so endings and resumes follow the order the attempts started in.
  const actions = [...open].reverse().map((attempt) => ({
    attemptId: attempt.id,
    action: decide(ctx, attempt, byId.get(attempt.id), hello.state === 'ok', options),
  }));
  setDeferredResumes(
    ctx,
    runnerId,
    actions.filter((entry) => entry.action === 'deferred').map((entry) => entry.attemptId),
  );
  const stop: WelcomeStop[] = [];
  for (const live of hello.attempts) {
    const reason = stopReason(ctx, runnerId, live.attemptId);
    if (reason !== null) stop.push({ attemptId: live.attemptId, reason });
  }
  onRunnerBack(ctx, runnerId, stop);
  return { stop, actions };
}

/** The statuses whose process a resume brings back. */
const RESUMABLE = new Set<Attempt['status']>(['starting', 'running', 'quota_wait']);

/**
 * runner.state ok after a hello that was not (X-36): the resumes that waited apply now, to the attempts still open on
 * the runner. One whose stop was requested meanwhile ends with that cause instead, as its process is gone.
 */
export function resumeDeferred(ctx: HubContext, runnerId: string): void {
  for (const attemptId of takeDeferredResumes(ctx, runnerId)) {
    const attempt = findAttempt(ctx, attemptId);
    if (!attempt || attempt.runnerId !== runnerId || !RESUMABLE.has(attempt.status)) continue;
    if (attempt.stopRequested) completeStop(ctx, attempt);
    else restartResume(ctx, attempt);
  }
}

/** Whether the attempt's transcript was asked for already. */
function transcriptAsked(ctx: HubContext, attemptId: string): boolean {
  const row = ctx.db
    .query(
      `SELECT 1 FROM runner_commands
       WHERE attempt_id = $attemptId AND kind = 'upload_transcript' AND status != 'cancelled'`,
    )
    .get({ attemptId });
  return row !== null;
}

/**
 * A runner back with attempts that ended lost while it was away (design 6.4, Lease expiry). welcome.stop names them,
 * so the runner stops each without a handoff turn and pushes its late work. The first time, each also gets
 * upload_transcript, and its task, while still ready and naming it, waits dispatchHoldMs for that late work.
 */
export function onRunnerBack(ctx: HubContext, runnerId: string, stop: readonly WelcomeStop[]): void {
  for (const { attemptId } of stop) {
    const attempt = findAttempt(ctx, attemptId);
    if (!attempt || attempt.runnerId !== runnerId || attempt.endReason !== 'lost') continue;
    if (transcriptAsked(ctx, attempt.id)) continue;
    enqueueCommand(ctx, runnerId, { kind: 'upload_transcript', attemptId: attempt.id });
    if (attempt.taskId === null) continue;
    const task = getTask(ctx, attempt.taskId);
    if (task.status === 'ready' && task.currentAttempt === attempt.id) {
      writeTask(ctx, task.id, { dispatchHoldUntil: ctx.now() + ctx.config.dispatchHoldMs });
    }
  }
}

/**
 * POST /api/runner/attempts/:id/transcript (design 6.16): the end of the attempt's transcript, from the runner that ran
 * it, for assembled handoff notes, which quote it. Only the owner of that runner may upload it.
 */
export function storeTranscriptTail(ctx: HubContext, user: string, attemptId: string, tail: string): void {
  tx(ctx, () => {
    const attempt = getAttempt(ctx, attemptId);
    const runner = attempt.runnerId === null ? null : findRunnerRow(ctx, attempt.runnerId);
    if (!runner || runner.owner !== user.toLowerCase()) {
      throw forbidden(`only the owner of the runner attempt ${attempt.id} ran on uploads its transcript`);
    }
    updateAttempt(ctx, attempt.id, { transcriptTail: tail });
  });
}
