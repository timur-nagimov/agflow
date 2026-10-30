// What the hub does when a runner comes back (design 6.3, Reconciliation on hello): it decides, in the hello
// transaction, every attempt it believes open on that runner from the state the runner reports, and builds the list
// of attempts the runner must stop before it runs any command.
import type { Attempt, HubMessage, LiveAttempt } from '@agflow/core';
import { findAttempt, listAttempts, updateAttempt } from './attempt-store';
import { endAttempt, recentResumes, resumeAttempt } from './attempts';
import type { HubContext } from './context';
import { writeTask } from './task-store';

type WelcomeStop = Extract<HubMessage, { t: 'welcome' }>['stop'][number];

/** What reconciliation did to one open attempt, by the row that matched. */
export type ReconcileAction =
  /** The process is gone and a stop was recorded: it ended with the requested cause. */
  | 'ended'
  /** A take-over in flight with a clone: its pending prepare_takeover goes out again after welcome. */
  | 'takeover'
  /** The runner still runs it, or it stays holding: its pending commands go out again after welcome. */
  | 'kept'
  /** Stopped or suspended with a clone: resumed at a new fence. */
  | 'resumed'
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

/**
 * The process is gone, so a recorded stop is complete (invariant a): the attempt ends with the requested cause. While
 * the replay that may still hold its exit is pending, a task the ending made ready waits dispatchHoldMs, so that a
 * successor starts from the final WIP the exit reports (invariant b); that WIP, late work by then, ends the wait.
 */
function completeStop(ctx: HubContext, attempt: Attempt, replayPending = false): ReconcileAction {
  const cause = (attempt.stopRequested as NonNullable<Attempt['stopRequested']>).cause;
  const ending = endAttempt(ctx, { attemptId: attempt.id, trigger: cause, actor: `runner:${attempt.runnerId}` });
  if (replayPending && ending?.task?.status === 'ready') {
    writeTask(ctx, ending.task.id, { dispatchHoldUntil: ctx.now() + ctx.config.dispatchHoldMs });
  }
  return 'ended';
}

/** What a hello says beyond its attempts. */
export interface ReconcileOptions {
  /** The runner holds events after the acknowledged position, which it replays once welcomed. */
  replayPending?: boolean | undefined;
}

/** Decides one open attempt by the first row of the table that matches (the restore rows aside). */
function decide(
  ctx: HubContext,
  attempt: Attempt,
  live: LiveAttempt | undefined,
  options: ReconcileOptions,
): ReconcileAction {
  const actor = `runner:${attempt.runnerId}`;
  const stop = attempt.stopRequested;
  if (gone(live) && stop) {
    if (stop.cause === 'takeover' && live.clone) return 'takeover';
    return completeStop(ctx, attempt, options.replayPending);
  }
  if (live && !gone(live)) return 'kept';
  if (gone(live) && live.clone) {
    if (attempt.status === 'holding') return 'kept';
    const earlier = recentResumes(ctx, attempt.id, 'runner_restart', ctx.config.resumeWindowMs);
    if (earlier + 1 >= RESTART_RESUMES_LIMIT) {
      const error = `the runner restarted ${earlier + 1} times while the attempt ran`;
      endAttempt(ctx, { attemptId: attempt.id, trigger: 'crashed', error, actor });
      return 'crashed';
    }
    resumeAttempt(ctx, { attemptId: attempt.id, cause: 'runner_restart', prompt: RESTART_PROMPT, actor });
    return 'resumed';
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
 * restore are decided elsewhere. Then every reported attempt that is ended by now, unknown, or not this runner's goes
 * to welcome.stop. Pending commands of the attempts that stay are sent again after welcome, as every pending command
 * is, and the runner's journal keeps it from running one twice.
 */
export function reconcileOnHello(
  ctx: HubContext,
  runnerId: string,
  reported: readonly LiveAttempt[],
  options: ReconcileOptions = {},
): ReconcileResult {
  const byId = new Map(reported.map((live) => [live.attemptId, live]));
  const open = listAttempts(ctx, { runner: runnerId, status: ['starting', 'running', 'quota_wait', 'holding'] });
  // Oldest first, so endings and resumes follow the order the attempts started in.
  const actions = [...open]
    .reverse()
    .map((attempt) => ({ attemptId: attempt.id, action: decide(ctx, attempt, byId.get(attempt.id), options) }));
  const stop: WelcomeStop[] = [];
  for (const live of reported) {
    const reason = stopReason(ctx, runnerId, live.attemptId);
    if (reason !== null) stop.push({ attemptId: live.attemptId, reason });
  }
  return { stop, actions };
}
