// The hub's supervision of running runner agents (design 6.8): stall decisions from fresh heartbeat facts, confirmed
// on the next fresh heartbeat before the stop goes out; the replacement after continuous vendor errors; and what a
// vendor outcome the runner reports does to the attempt (design 6.4's vendor rows).
import {
  type Attempt,
  type RunnerEventData,
  type StallLimits,
  type StopCause,
  type VendorOutcomeKind,
  formatFence,
  judgeStall,
} from '@agflow/core';
import { appendAttemptLog, getAttempt } from './attempt-store';
import { factsAreFresh, hasLiveProcess, requestStop } from './attempts';
import { type HubContext, tx } from './context';
import type { Emit } from './events';
import { insertMessage } from './messages';
import { markVendorNotReady, setDegraded } from './runners';
import { pendingSubmissionOf } from './submission-store';
import { getTask } from './task-store';
import { clip } from './text';

/** A rule that fired on one heartbeat's facts, waiting for the next fresh heartbeat to confirm it. */
interface Suspicion {
  /** When the hub received the facts it fired on. */
  factsAt: number;
  /** The fence they were reported at: a resume starts over. */
  fence: string;
}

/**
 * Suspected stalls, per hub context. Kept in memory: a restarted hub only waits one heartbeat more before it decides,
 * and a suspicion is never a reason to act on its own.
 */
const suspicions = new WeakMap<HubContext, Map<string, Suspicion>>();

function suspicionsOf(ctx: HubContext): Map<string, Suspicion> {
  let map = suspicions.get(ctx);
  if (!map) {
    map = new Map();
    suspicions.set(ctx, map);
  }
  return map;
}

const limitsOf = (ctx: HubContext): StallLimits => ({
  stallMs: ctx.config.stallMs,
  toolCapMs: ctx.config.toolCapMs,
  maxContinuations: ctx.config.maxContinuations,
  activeBudgetMs: ctx.config.activeBudgetMs,
});

/** The running runner attempts, oldest first. */
function runningOnRunners(ctx: HubContext): string[] {
  const rows = ctx.db
    .query(`SELECT id FROM attempts WHERE status = 'running' AND runner_id IS NOT NULL ORDER BY rowid`)
    .all() as { id: string }[];
  return rows.map((row) => row.id);
}

/** When the hub received the attempt's facts; null once they went stale with their link. */
function factsAtOf(ctx: HubContext, attemptId: string): number | null {
  const row = ctx.db.query('SELECT facts_at FROM attempts WHERE id = $id').get({ id: attemptId }) as {
    facts_at: number | null;
  };
  return row.facts_at;
}

/**
 * Whether the hub may decide about the attempt from its facts now: it is running with fresh facts (design 6.8,
 * Freshness), no stop is recorded, and no submission is pending (design 6.13: its outcome decides).
 */
function judgeable(ctx: HubContext, attempt: Attempt): boolean {
  return (
    attempt.status === 'running' &&
    attempt.runnerId !== null &&
    attempt.facts !== null &&
    attempt.stopRequested === null &&
    factsAreFresh(ctx, attempt.id) &&
    pendingSubmissionOf(ctx, attempt.id) === null
  );
}

/**
 * Replaces the attempt when its facts report vendor errors for vendorErrorReplaceMs (design 6.8, Vendor errors): it
 * ends replaced (infra, no handoff), and its vendor is degraded on the runner for degradedMs, so placement prefers the
 * other vendor. No second heartbeat is needed: the facts already measure an hour. Whether it did.
 */
function replaceIfVendorErrors(ctx: HubContext, attempt: Attempt): boolean {
  const facts = attempt.facts;
  if (facts === null || facts.vendorErrorMs < ctx.config.vendorErrorReplaceMs) return false;
  const minutes = Math.round(facts.vendorErrorMs / 60_000);
  requestStop(ctx, {
    attemptId: attempt.id,
    cause: 'vendor_error',
    reason: `the vendor has failed for ${minutes} min in a row`,
    by: 'system',
  });
  setDegraded(ctx, attempt.runnerId as string, attempt.vendor);
  return true;
}

/** replaceIfVendorErrors for every running runner attempt that may be judged now, each in its own transaction. */
export function replaceForVendorErrors(ctx: HubContext): string[] {
  const replaced: string[] = [];
  for (const id of runningOnRunners(ctx)) {
    try {
      if (tx(ctx, () => judgeable(ctx, getAttempt(ctx, id)) && replaceIfVendorErrors(ctx, getAttempt(ctx, id)))) {
        replaced.push(id);
      }
    } catch (error) {
      console.error(`replacing attempt ${id} after vendor errors failed`, error);
    }
  }
  return replaced;
}

export interface StallDecisions {
  /** Attempts a rule fired for on facts no earlier heartbeat had judged. */
  suspected: string[];
  /** Attempts stopped: a rule fired again on the next fresh heartbeat, or vendor errors replaced them. */
  stopped: string[];
}

/** What one attempt's judgement did. */
type Judgement = 'suspected' | 'stopped' | null;

function judgeOne(ctx: HubContext, id: string): Judgement {
  const pending = suspicionsOf(ctx);
  const attempt = getAttempt(ctx, id);
  const factsAt = factsAtOf(ctx, id);
  if (!judgeable(ctx, attempt) || factsAt === null) {
    pending.delete(id);
    return null;
  }
  if (replaceIfVendorErrors(ctx, attempt)) {
    pending.delete(id);
    return 'stopped';
  }
  const verdict = judgeStall(attempt.role, attempt.facts as NonNullable<Attempt['facts']>, limitsOf(ctx));
  if (verdict === null) {
    pending.delete(id);
    return null;
  }
  const fence = formatFence(attempt.fence);
  const suspicion = pending.get(id);
  if (suspicion === undefined || suspicion.fence !== fence) {
    pending.set(id, { factsAt, fence });
    return 'suspected';
  }
  // The facts it fired on were judged already: confirming needs a heartbeat after them.
  if (factsAt <= suspicion.factsAt) return null;
  requestStop(ctx, { attemptId: id, cause: verdict.cause, reason: verdict.reason, by: 'system' });
  pending.delete(id);
  return 'stopped';
}

/**
 * Judges every running runner attempt by design 6.8's rules, each in its own transaction, from fresh facts only:
 * ages are as of their heartbeat and never extrapolated. A rule that fires is suspected; when a later fresh heartbeat
 * still fires one, the attempt is stopped with that rule's cause and its flags (agent.stalled). No decision is made
 * while a stop is recorded or a submission is pending, nor for a lead outside a turn (judgeStall). Vendor errors
 * past vendorErrorReplaceMs replace the attempt at once. The tick runs it.
 */
export function judgeStalls(ctx: HubContext): StallDecisions {
  const decisions: StallDecisions = { suspected: [], stopped: [] };
  const running = runningOnRunners(ctx);
  // Suspicions of attempts no longer running are dropped: they would never be judged again.
  const open = new Set(running);
  const pending = suspicionsOf(ctx);
  for (const id of pending.keys()) if (!open.has(id)) pending.delete(id);
  for (const id of running) {
    try {
      const judgement = tx(ctx, () => judgeOne(ctx, id));
      if (judgement) decisions[judgement].push(id);
    } catch (error) {
      console.error(`judging attempt ${id} for a stall failed`, error);
    }
  }
  return decisions;
}

/** The stop each vendor outcome asks for (design 6.4's vendor rows); denials and session budgets are the budget. */
const OUTCOME_CAUSES: Readonly<Record<VendorOutcomeKind, StopCause>> = {
  auth: 'auth',
  context: 'context',
  policy: 'policy',
  denials: 'stall_budget',
  session_budget: 'stall_budget',
};

/** The reason an outcome's stop gives, hub text first, with the vendor's detail clipped. */
function outcomeReason(kind: VendorOutcomeKind, detail: string | null): string {
  const text: Record<VendorOutcomeKind, string> = {
    auth: 'the vendor login expired',
    context: 'the context window is exhausted after a compaction',
    policy: 'the vendor refused the work under its usage policy',
    denials: 'the vendor denied too many requests',
    session_budget: 'the session reached its budget',
  };
  return detail === null ? text[kind] : `${text[kind]}: ${clip(detail, 500)}`;
}

/** What people are told of a policy refusal, from what the stop actually did to the attempt and its task. */
function policyNotice(ctx: HubContext, attempt: Attempt, reason: string): string {
  if (attempt.taskId === null) return `The lead attempt ${attempt.id} is stopping: ${reason}.`;
  const task = getTask(ctx, attempt.taskId);
  if (task.status === 'blocked' && task.blockedKind === 'policy') {
    return `${task.id} is blocked: ${reason}. Change the task or decide how to go on, then unblock it.`;
  }
  const now = getAttempt(ctx, attempt.id);
  const state =
    now.status === 'ended'
      ? 'It has ended'
      : now.stopRequested?.deferred
        ? 'It stops if its pending submission fails'
        : 'It is stopping';
  return `Attempt ${attempt.id} of ${task.id}: ${reason}. ${state}; ${task.id} keeps its status (${task.status}).`;
}

/**
 * attempt.vendor_outcome (design 6.4): auth stops the attempt crashed (infra, no handoff) and marks the vendor not
 * ready on the runner until a preflight passes; context replaces it with a handoff; policy blocks the task as policy
 * at once and tells people; denials and session_budget stop it as stall_budget. A stop already recorded follows the
 * second-request rules (requestStop). While a submission is pending its outcome decides (design 6.13): the stop is
 * recorded deferred, so it neither interrupts the push's retries nor replaces a stop already held back for it. An
 * attempt with no process is left alone: a holding worker's session and clone are its author's for a review return,
 * and a holding lead meets the outcome again when it resumes.
 */
export function onVendorOutcome(
  ctx: HubContext,
  emit: Emit,
  attempt: Attempt,
  data: RunnerEventData['attempt.vendor_outcome'],
): void {
  const reason = outcomeReason(data.kind, data.detail);
  if (data.kind === 'auth' && attempt.runnerId !== null) markVendorNotReady(ctx, attempt.runnerId, attempt.vendor);
  if (!hasLiveProcess(attempt)) {
    const summary = `vendor outcome ${data.kind} left alone: the attempt is ${attempt.status}`;
    appendAttemptLog(ctx, attempt.id, 'note', summary);
    return;
  }
  const pending = pendingSubmissionOf(ctx, attempt.id) !== null;
  if (pending && attempt.stopRequested?.deferred) return;
  const cause = OUTCOME_CAUSES[data.kind];
  const result = requestStop(ctx, { attemptId: attempt.id, cause, reason, by: 'system', deferred: pending });
  if (data.kind === 'policy' && (result.outcome === 'requested' || result.outcome === 'replaced')) {
    const body = policyNotice(ctx, attempt, reason);
    insertMessage(ctx, emit, { from: 'system', to: 'humans', taskId: attempt.taskId, body });
  }
}
