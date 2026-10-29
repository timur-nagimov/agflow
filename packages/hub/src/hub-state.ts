import type { HubContext } from './context';

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
