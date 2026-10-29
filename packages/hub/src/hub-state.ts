import type { AttemptStatus, LeadSeat } from '@agflow/core';
import type { HubContext } from './context';
import type { Emit } from './events';

/** The one hub_state row: the hub's clock check, recovery window, restore, churn guard and lead seat. */
export interface HubStateRow {
  /** The last time the tick ran, to tell downtime from a running hub (design 6.14). */
  lastAliveAt: number;
  recoveryUntil: number | null;
  restoredAt: number | null;
  /** The churn guard holds dispatch until then. */
  dispatchPausedUntil: number | null;
  lastLeadReviewAt: number | null;
  /** The lead seat. */
  leadAgentId: string | null;
  leadKind: 'live' | 'runner' | null;
  leadSince: number | null;
}

interface StoredHubState {
  last_alive_at: number;
  recovery_until: number | null;
  restored_at: number | null;
  dispatch_paused_until: number | null;
  last_lead_review_at: number | null;
  lead_agent_id: string | null;
  lead_kind: 'live' | 'runner' | null;
  lead_since: number | null;
}

const COLUMNS: Record<keyof HubStateRow, keyof StoredHubState> = {
  lastAliveAt: 'last_alive_at',
  recoveryUntil: 'recovery_until',
  restoredAt: 'restored_at',
  dispatchPausedUntil: 'dispatch_paused_until',
  lastLeadReviewAt: 'last_lead_review_at',
  leadAgentId: 'lead_agent_id',
  leadKind: 'lead_kind',
  leadSince: 'lead_since',
};

export function getHubState(ctx: HubContext): HubStateRow {
  // Schema version 2 inserts the row, and nothing deletes it.
  const row = ctx.db.query('SELECT * FROM hub_state WHERE id = 1').get() as StoredHubState;
  return {
    lastAliveAt: row.last_alive_at,
    recoveryUntil: row.recovery_until,
    restoredAt: row.restored_at,
    dispatchPausedUntil: row.dispatch_paused_until,
    lastLeadReviewAt: row.last_lead_review_at,
    leadAgentId: row.lead_agent_id,
    leadKind: row.lead_kind,
    leadSince: row.lead_since,
  };
}

/** Sets the given fields; undefined ones keep their value, null clears one. */
export function updateHubState(ctx: HubContext, changes: Partial<HubStateRow>): void {
  const sets: string[] = [];
  const params: Record<string, string | number | null> = {};
  for (const [key, value] of Object.entries(changes) as [keyof HubStateRow, string | number | null | undefined][]) {
    if (value === undefined) continue;
    sets.push(`${COLUMNS[key]} = $${key}`);
    params[key] = value;
  }
  if (sets.length > 0) ctx.db.query(`UPDATE hub_state SET ${sets.join(', ')} WHERE id = 1`).run(params);
}

/** The hub epoch, 1 until the first restore raises it (design 6.14). It goes into fences, attempt ids and branches. */
export function hubEpoch(ctx: HubContext): number {
  return (ctx.db.query('SELECT epoch FROM project WHERE id = 1').get() as { epoch: number }).epoch;
}

// ---------------------------------------------------------------------------
// The lead seat (design 6.11): the one record of who leads. Lead routes, lead messages, messages to all, the brief
// and HubStatus read it, never an agent's role column.
// ---------------------------------------------------------------------------

/** A runner lead holds the seat while its attempt is in one of these; holding is an idle process that exited. */
const RUNNER_SEAT_STATUSES: readonly AttemptStatus[] = ['starting', 'running', 'quota_wait', 'holding'];

interface SeatAgentRow {
  last_seen_at: number;
  attempt_id: string | null;
  runner_id: string | null;
  attempt_status: AttemptStatus | null;
  wakeups: number | null;
}

function seatAgent(ctx: HubContext, id: string): SeatAgentRow | null {
  return ctx.db
    .query(
      `SELECT agents.last_seen_at, agents.attempt_id, agents.runner_id, attempts.status AS attempt_status, attempts.wakeups
       FROM agents LEFT JOIN attempts ON attempts.id = agents.attempt_id WHERE agents.id = $id`,
    )
    .get({ id }) as SeatAgentRow | null;
}

/** Whether the recorded holder still holds the seat: a live lead seen within liveLeadGraceMs, a runner lead's attempt open. */
function stillHeld(ctx: HubContext, kind: HubStateRow['leadKind'], agent: SeatAgentRow | null): boolean {
  if (!agent) return false;
  if (kind === 'runner') return agent.attempt_status !== null && RUNNER_SEAT_STATUSES.includes(agent.attempt_status);
  return ctx.now() - agent.last_seen_at < ctx.config.liveLeadGraceMs;
}

/** The agent holding the seat, or null when it is empty or its holder no longer qualifies. */
export function seatHolderId(ctx: HubContext): string | null {
  const { leadAgentId, leadKind } = getHubState(ctx);
  if (leadAgentId === null) return null;
  return stillHeld(ctx, leadKind, seatAgent(ctx, leadAgentId)) ? leadAgentId : null;
}

export function holdsSeat(ctx: HubContext, agentId: string): boolean {
  return seatHolderId(ctx) === agentId;
}

/** The seat as HubStatus shows it. */
export function leadSeat(ctx: HubContext): LeadSeat {
  const state = getHubState(ctx);
  const runnerLeads = (ctx.db.query('SELECT runner_leads FROM project WHERE id = 1').get() as { runner_leads: number })
    .runner_leads === 1;
  const agent = state.leadAgentId === null ? null : seatAgent(ctx, state.leadAgentId);
  if (state.leadAgentId === null || state.leadKind === null || !stillHeld(ctx, state.leadKind, agent)) {
    return { kind: 'none', agentId: null, attemptId: null, runnerId: null, since: null, wakeups: 0, runnerLeads };
  }
  const runner = state.leadKind === 'runner';
  return {
    kind: state.leadKind,
    agentId: state.leadAgentId,
    attemptId: runner ? (agent?.attempt_id ?? null) : null,
    runnerId: runner ? (agent?.runner_id ?? null) : null,
    since: state.leadSince,
    wakeups: runner ? (agent?.wakeups ?? 0) : 0,
    runnerLeads,
  };
}

function emitSeat(ctx: HubContext, emit: Emit, actor: string): void {
  const seat = leadSeat(ctx);
  emit({
    type: 'lead.seat_changed',
    actor,
    data: { kind: seat.kind, agentId: seat.agentId, attemptId: seat.attemptId, runnerId: seat.runnerId },
  });
}

/** Gives the agent the seat and demotes every other lead row to worker, in the caller's transaction. */
export function takeSeat(ctx: HubContext, emit: Emit, agentId: string, kind: 'live' | 'runner', actor: string): void {
  updateHubState(ctx, { leadAgentId: agentId, leadKind: kind, leadSince: ctx.now() });
  ctx.db.query("UPDATE agents SET role = 'worker' WHERE role = 'lead' AND id != $agentId").run({ agentId });
  ctx.db.query("UPDATE agents SET role = 'lead' WHERE id = $agentId").run({ agentId });
  emitSeat(ctx, emit, actor);
}

/**
 * Empties the seat; with holderId, only while the record names that agent. False when nothing changed. The agent's
 * role column stays as it was: it grants nothing without the seat.
 */
export function emptySeat(ctx: HubContext, emit: Emit, actor: string, holderId?: string): boolean {
  const { leadAgentId } = getHubState(ctx);
  if (leadAgentId === null || (holderId !== undefined && leadAgentId !== holderId)) return false;
  updateHubState(ctx, { leadAgentId: null, leadKind: null, leadSince: null });
  emitSeat(ctx, emit, actor);
  return true;
}
