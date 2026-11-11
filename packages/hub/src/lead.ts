// The lead on runners (design 6.11): the tick starts a runner lead when the seat is empty, a holding lead is woken by
// its next delivery or ended lost when it cannot be, and a lead that fails over starts on another runner. The tick
// also sends the periodic review and rotates a lead that is due. The seat itself is hub-state.ts's; the lead handoff a
// successor starts from is assembled at the ending (handoff.ts).
import {
  type Agent,
  type Attempt,
  type AttemptEndReason,
  type LeadNote,
  type Message,
  type Project,
  type RunnerState,
  type TaskStatus,
  placeLead,
} from '@agflow/core';
import { getAttempt, listAttempts } from './attempt-store';
import { endAttempt, requestStop, resumeAttempt, startRunnerAttempt } from './attempts';
import type { CommandRow } from './commands';
import { type HubContext, tx } from './context';
import { countWakeup, injectedMessage, leadReport } from './delivery';
import { forbidden } from './errors';
import {
  type LeadNoteRow,
  getHubState,
  holdsSeat,
  insertLeadNote,
  leadNoteFromRow,
  leadSeat,
  seatHolderId,
  updateHubState,
} from './hub-state';
import { insertMessage } from './messages';
import { placementSnapshot } from './placement';
import { getProject, storeRunnerLeads } from './project';
import { findRunnerRow } from './runners';
import { listTasks } from './task-store';

/** The endings after which the next lead avoids the runner the last one ran on (design 6.11, Failover). */
const FAILOVER_ENDINGS: readonly AttemptEndReason[] = ['lost', 'crashed'];

/** How the newest runner lead attempt ended, and where it ran; null while it is open or before the first. */
function lastLeadEnding(ctx: HubContext): { endReason: AttemptEndReason; runnerId: string | null } | null {
  const [last] = listAttempts(ctx, { role: 'lead', limit: 1 });
  return last && last.status === 'ended' && last.endReason !== null
    ? { endReason: last.endReason, runnerId: last.runnerId }
    : null;
}

/**
 * Step 2 of a tick (design 6.11, Starting a runner lead): with the seat empty and runner leads on, a lead attempt
 * starts on the runner core's placeLead prefers (Claude, then AC power, then the most free slots), and takes the seat,
 * demoting any other lead row, in startRunnerAttempt's transaction. After a lead ended lost or crashed, another runner
 * is preferred, and the same one is used only when no other can take it; after a rotation, the same runner is
 * preferred. Its brief quotes the newest lead handoff. The tick skips this step while the project is paused. Returns
 * the attempt, or null when none started.
 */
export function ensureLead(ctx: HubContext): Attempt | null {
  if (!getProject(ctx).runnerLeads || seatHolderId(ctx) !== null) return null;
  const snapshot = placementSnapshot(ctx);
  const last = lastLeadEnding(ctx);
  const avoid = last && FAILOVER_ENDINGS.includes(last.endReason) ? last.runnerId : null;
  const rotatingFrom = last?.endReason === 'rotated' ? last.runnerId : null;
  const others = { ...snapshot, runners: snapshot.runners.filter((runner) => runner.id !== avoid) };
  const elsewhere = avoid === null ? null : placeLead(others, { rotatingFrom: null }).placement;
  const placement = elsewhere ?? placeLead(snapshot, { rotatingFrom }).placement;
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
    // The resume is the delivery, so it starts with the situation report and counts as a wake-up.
    countWakeup(ctx, current.id);
    return resumeAttempt(ctx, {
      attemptId: current.id,
      cause: 'lead_exit',
      prompt: WAKE_PROMPT,
      messages: [leadReport(ctx), ...unread.map(injectedMessage)],
    }).command;
  });
}

// ---------------------------------------------------------------------------
// The periodic review and rotation (design 6.11)
// ---------------------------------------------------------------------------

/** Task statuses that keep the review going: work an agent holds, and work waiting for the lead's review. */
const UNDER_REVIEW: readonly TaskStatus[] = ['claimed', 'working', 'submitted'];

/** How many tasks a review message names; the situation report before it gives the rest. */
const REVIEW_LIST_LIMIT = 20;

/**
 * The periodic review (design 6.11, Wake-ups are deliveries): while any task is held or submitted, a message goes to
 * the lead every leadReviewMs, tracked in hub_state.last_lead_review_at. The clock starts when work is first held, so
 * the first review comes leadReviewMs later, and stops when none is. While the seat is empty nothing is sent and the
 * clock keeps running, so a lead that takes the seat gets the review that is due. Part of the tick's reconcile step.
 * Returns the message, or null.
 */
export function periodicLeadReview(ctx: HubContext): Message | null {
  return tx(ctx, (emit) => {
    const { lastLeadReviewAt } = getHubState(ctx);
    const tasks = listTasks(ctx).filter((task) => UNDER_REVIEW.includes(task.status));
    if (tasks.length === 0) {
      if (lastLeadReviewAt !== null) updateHubState(ctx, { lastLeadReviewAt: null });
      return null;
    }
    const now = ctx.now();
    if (lastLeadReviewAt === null) {
      updateHubState(ctx, { lastLeadReviewAt: now });
      return null;
    }
    if (now - lastLeadReviewAt < ctx.config.leadReviewMs || seatHolderId(ctx) === null) return null;
    updateHubState(ctx, { lastLeadReviewAt: now });
    const listed = tasks.slice(0, REVIEW_LIST_LIMIT).map((task) => `${task.id} [${task.status}]`);
    const rest = tasks.length - listed.length;
    const minutes = Math.round(ctx.config.leadReviewMs / 60_000);
    return insertMessage(ctx, emit, {
      from: 'system',
      to: 'lead',
      body:
        `Periodic review (every ${minutes} min while work is held or submitted): ${listed.join(', ')}` +
        `${rest > 0 ? ` and ${rest} more` : ''}. Check that held work is moving, and review what is submitted.`,
    });
  });
}

/** contextUsed past this rotates the lead (design 6.11, Rotation). */
const ROTATE_CONTEXT_USED = 0.7;

/** Why the lead is due for rotation, as a clause for its stop reason and lead.rotated, or null when it is not. */
function rotationDue(ctx: HubContext, attempt: Attempt): string | null {
  if (attempt.wakeups >= ctx.config.leadRotateWakeups) return `after ${attempt.wakeups} wake-ups`;
  const used = attempt.facts?.contextUsed ?? 0;
  return used > ROTATE_CONTEXT_USED ? `with ${Math.round(used * 100)}% of its context used` : null;
}

/**
 * Asks the runner lead to write a lead handoff and stops it as rotation, in the caller's transaction or its own: it
 * ends rotated on exit, the seat empties, and the next tick starts a fresh lead, preferring the same runner, from that
 * handoff (design 6.11, Rotation). One with no process ends rotated at once, and the hub assembles its lead handoff.
 * The stop is the hub's, its text hub text: one clause, which the runner's handoff prompt quotes, adding only what the
 * runner cannot know, that this is a lead handoff. lead.rotated names the actor whose rule or setting asked for it. A
 * lead with a stop recorded is ending already and is left alone. Whether it was asked.
 */
function rotateLead(ctx: HubContext, attempt: Attempt, why: string, actor: string): boolean {
  return tx(ctx, (emit) => {
    const current = getAttempt(ctx, attempt.id);
    if (current.role !== 'lead' || current.status === 'ended' || current.stopRequested !== null) return false;
    const reason =
      `the lead rotates ${why}; write your lead handoff with write_handoff and no task id, since a fresh lead starts ` +
      'from it';
    requestStop(ctx, { attemptId: current.id, cause: 'rotation', reason, by: 'system' });
    emit({
      type: 'lead.rotated',
      actor,
      data: { attemptId: current.id, agentId: current.agentId, runnerId: current.runnerId, reason: why },
    });
    return true;
  });
}

/** The attempt of the runner lead holding the seat, or null when the seat is empty or a live lead holds it. */
function seatedRunnerLead(ctx: HubContext): Attempt | null {
  const seat = leadSeat(ctx);
  return seat.kind === 'runner' && seat.attemptId !== null ? getAttempt(ctx, seat.attemptId) : null;
}

/**
 * Rotates the runner lead holding the seat once it is due (design 6.11, Rotation): after leadRotateWakeups wake-ups,
 * or when its contextUsed passes 0.7. Only a running lead is: one starting, waiting for quota or holding is rotated
 * on a later tick, once it runs. While the project is paused, rotation waits for the unpause: step 2 could not start
 * the next lead, and the seat would stay empty. Part of the tick's reconcile step. Returns the attempt asked, or null.
 */
export function rotateLeadIfDue(ctx: HubContext): string | null {
  if (getProject(ctx).paused) return null;
  const attempt = seatedRunnerLead(ctx);
  if (attempt === null || attempt.status !== 'running') return null;
  const why = rotationDue(ctx, attempt);
  return why !== null && rotateLead(ctx, attempt, why, 'system') ? attempt.id : null;
}

// ---------------------------------------------------------------------------
// Lead notes and the runner-leads switch (design 6.11, 6.16)
// ---------------------------------------------------------------------------

/**
 * POST /api/lead/handoff: the seat holder's lead handoff for the lead after it, stored as written in lead_notes. A
 * runner lead's carries its attempt id, so its ending finds it written; a live lead's has none.
 */
export function writeLeadHandoff(ctx: HubContext, agent: Agent, note: string): void {
  tx(ctx, () => {
    if (!holdsSeat(ctx, agent.id)) throw forbidden('only the lead writes a lead handoff');
    const attemptId = agent.origin === 'runner' ? agent.attemptId : null;
    insertLeadNote(ctx, { attemptId, kind: 'handoff', body: note, author: `agent:${agent.id}` });
  });
}

/** How many lead notes GET /api/lead/notes answers: the newest; older ones only repeat what these build on. */
const LEAD_NOTES_LIMIT = 20;

/** GET /api/lead/notes: the newest lead notes, handoffs and restatements, newest first. Their bodies are agent text. */
export function listLeadNotes(ctx: HubContext): LeadNote[] {
  const rows = ctx.db
    .query('SELECT * FROM lead_notes ORDER BY id DESC LIMIT $limit')
    .all({ limit: LEAD_NOTES_LIMIT }) as LeadNoteRow[];
  return rows.map(leadNoteFromRow);
}

/**
 * PATCH /api/project { runnerLeads } (design 6.11, Runner leads off): may the scheduler start leads on runners.
 * Turning them off rotates the runner lead holding the seat out, with a lead handoff, so a person's live lead can take
 * the seat once it has ended; turning them on lets the next tick start one when the seat is empty. Returns the
 * project.
 */
export function setRunnerLeads(ctx: HubContext, runnerLeads: boolean, actor: string): Project {
  return tx(ctx, () => {
    if (storeRunnerLeads(ctx, runnerLeads) && !runnerLeads) {
      const lead = seatedRunnerLead(ctx);
      if (lead) rotateLead(ctx, lead, 'because people turned runner leads off', actor);
    }
    return getProject(ctx);
  });
}
