// The lead on runners (design 6.11): the tick starts a runner lead when the seat is empty, a holding lead is woken by
// its next delivery or ended lost when it cannot be, and a lead that fails over starts on another runner. The seat
// itself is hub-state.ts's; the lead handoff a successor starts from is assembled at the ending (handoff.ts).
import { type Attempt, type Message, type RunnerState, placeLead } from '@agflow/core';
import { getAttempt, listAttempts } from './attempt-store';
import { endAttempt, resumeAttempt, startRunnerAttempt } from './attempts';
import type { CommandRow } from './commands';
import { type HubContext, tx } from './context';
import { injectedMessage } from './delivery';
import { seatHolderId } from './hub-state';
import { placementSnapshot } from './placement';
import { getProject } from './project';
import { findRunnerRow } from './runners';

/** The endings after which the next lead avoids the runner the last one ran on (design 6.11, Failover). */
const FAILOVER_ENDINGS: readonly NonNullable<Attempt['endReason']>[] = ['lost', 'crashed'];

/** The runner of the newest runner lead when it ended lost or crashed; null otherwise. */
function failedLeadRunner(ctx: HubContext): string | null {
  const [last] = listAttempts(ctx, { role: 'lead', limit: 1 });
  if (!last || last.status !== 'ended' || last.endReason === null) return null;
  return FAILOVER_ENDINGS.includes(last.endReason) ? last.runnerId : null;
}

/**
 * Step 2 of a tick (design 6.11, Starting a runner lead): with the seat empty and runner leads on, a lead attempt
 * starts on the runner core's placeLead prefers (Claude, then AC power, then the most free slots), and takes the seat,
 * demoting any other lead row, in startRunnerAttempt's transaction. After a lead ended lost or crashed, another runner
 * is preferred, and the same one is used only when no other can take it. Its brief quotes the newest lead handoff.
 * The tick skips this step while the project is paused. Returns the attempt, or null when none started.
 */
export function ensureLead(ctx: HubContext): Attempt | null {
  if (!getProject(ctx).runnerLeads || seatHolderId(ctx) !== null) return null;
  const snapshot = placementSnapshot(ctx);
  const avoid = failedLeadRunner(ctx);
  const others = { ...snapshot, runners: snapshot.runners.filter((runner) => runner.id !== avoid) };
  const elsewhere = avoid === null ? null : placeLead(others, { rotatingFrom: null }).placement;
  const placement = elsewhere ?? placeLead(snapshot, { rotatingFrom: null }).placement;
  if (!placement) return null;
  return startRunnerAttempt(ctx, { runnerId: placement.runnerId, taskId: null, role: 'lead', vendor: placement.vendor })
    .attempt;
}

/**
 * The states of a runner with no link (runners.ts): offline, needs_login when its CLI session no longer verifies, and
 * incompatible after a refused hello. A lead's runner in any of them is offline to it; a linked runner is online,
 * crash_loop or disk_low.
 */
const UNLINKED: readonly RunnerState[] = ['offline', 'needs_login', 'incompatible'];

/** Why a holding lead can no longer be resumed, or null when it still can (design 6.11, Holding the seat). */
function unresumable(ctx: HubContext, attempt: Attempt): string | null {
  if (!attempt.resumable) return 'it can no longer be resumed';
  const runner = attempt.runnerId === null ? null : findRunnerRow(ctx, attempt.runnerId);
  if (!runner) return 'its runner is gone';
  if (UNLINKED.includes(runner.state) && ctx.now() - runner.last_seen_at >= ctx.config.runnerLeaseMs) {
    return `its runner ${runner.id} has been offline for the runner lease`;
  }
  return null;
}

/**
 * Ends every holding runner lead that can no longer be resumed lost (infra), each in its own transaction: its runner
 * has been offline for runnerLeaseMs, or it is not resumable. The seat empties, and the next tick fails over. Part of
 * the tick's reconcile step. Returns the attempts it ended.
 */
export function checkHoldingLeads(ctx: HubContext): string[] {
  const ended: string[] = [];
  for (const attempt of listAttempts(ctx, { role: 'lead', status: ['holding'] })) {
    try {
      const reason = unresumable(ctx, attempt);
      if (reason === null || attempt.runnerId === null) continue;
      if (endAttempt(ctx, { attemptId: attempt.id, trigger: 'lost', error: reason })) ended.push(attempt.id);
    } catch (error) {
      console.error(`ending holding lead ${attempt.id} failed`, error);
    }
  }
  return ended;
}

/** The prompt of a holding lead woken by a delivery; the messages follow it. */
const WAKE_PROMPT =
  'Your process exited while you were idle, and agflow started it again because new messages arrived for you. They ' +
  'follow.';

/**
 * Wakes a holding runner lead for its unread messages (design 6.11): it resumes with the delivery as its prompt, so
 * the messages go with the resume and are in flight from then on. A lead that cannot be resumed, or whose runner the
 * delivery finds offline (with no link, in any state), ends lost, its unacknowledged lead messages unread again for
 * the next lead. A linked runner that is not ready (crash_loop or disk_low) keeps it holding until it is. Returns
 * the resume_attempt, or null. flushDeliveries calls it for each holding lead whose batch is due (HoldingLeadWaker).
 */
export function wakeHoldingLead(ctx: HubContext, attempt: Attempt, unread: readonly Message[]): CommandRow | null {
  return tx(ctx, () => {
    const current = getAttempt(ctx, attempt.id);
    if (current.status !== 'holding' || current.role !== 'lead' || current.runnerId === null) return null;
    const runner = findRunnerRow(ctx, current.runnerId);
    const offline = runner && UNLINKED.includes(runner.state) ? `a delivery found runner ${runner.id} offline` : null;
    const reason = unresumable(ctx, current) ?? offline;
    if (reason !== null) {
      endAttempt(ctx, { attemptId: current.id, trigger: 'lost', error: reason });
      return null;
    }
    if (runner?.state !== 'online') return null;
    return resumeAttempt(ctx, {
      attemptId: current.id,
      cause: 'lead_exit',
      prompt: WAKE_PROMPT,
      messages: unread.map(injectedMessage),
    }).command;
  });
}
