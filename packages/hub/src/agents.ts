import type { Agent, AgentOrigin, AgentRole, AgentStatus, Vendor } from '@agflow/core';
import { type HubContext, tx } from './context';
import { nextId } from './db';
import { forbidden, notFound } from './errors';

export const ACTIVE_MS = 10 * 60_000;
export const IDLE_MS = 2 * 60 * 60_000;
export const LEAD_STALE_MS = 15 * 60_000;

interface AgentRow {
  id: string;
  seq: number;
  login: string;
  vendor: Vendor;
  role: AgentRole;
  origin: AgentOrigin;
  session_id: string | null;
  hello_code: string | null;
  label: string | null;
  current_task: string | null;
  last_seen_at: number;
  created_at: number;
}

export function statusFor(lastSeenAt: number, now: number): AgentStatus {
  const age = now - lastSeenAt;
  if (age < ACTIVE_MS) return 'active';
  if (age < IDLE_MS) return 'idle';
  return 'gone';
}

function toAgent(ctx: HubContext, row: AgentRow): Agent {
  return {
    id: row.id,
    user: row.login,
    vendor: row.vendor,
    role: row.role,
    origin: row.origin,
    sessionId: row.session_id,
    label: row.label,
    currentTask: row.current_task,
    status: statusFor(row.last_seen_at, ctx.now()),
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
  };
}

export function findAgent(ctx: HubContext, id: string): Agent | null {
  const row = ctx.db.query('SELECT * FROM agents WHERE id = $id').get({ id }) as AgentRow | null;
  return row ? toAgent(ctx, row) : null;
}

export function getAgent(ctx: HubContext, id: string): Agent {
  const agent = findAgent(ctx, id);
  if (!agent) throw notFound(`agent ${id}`);
  return agent;
}

export function findAgentBySession(ctx: HubContext, vendor: Vendor, sessionId: string): Agent | null {
  const row = ctx.db
    .query('SELECT * FROM agents WHERE vendor = $vendor AND session_id = $sessionId')
    .get({ vendor, sessionId }) as AgentRow | null;
  return row ? toAgent(ctx, row) : null;
}

export function listAgents(ctx: HubContext): Agent[] {
  return (ctx.db.query('SELECT * FROM agents ORDER BY seq').all() as AgentRow[]).map((row) => toAgent(ctx, row));
}

export function currentLead(ctx: HubContext): Agent | null {
  const row = ctx.db
    .query("SELECT * FROM agents WHERE role = 'lead' AND last_seen_at > $cutoff ORDER BY last_seen_at DESC LIMIT 1")
    .get({ cutoff: ctx.now() - LEAD_STALE_MS }) as AgentRow | null;
  return row ? toAgent(ctx, row) : null;
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function randomHelloCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('');
}

export interface SessionStartInput {
  vendor: Vendor;
  sessionId: string;
  role: AgentRole;
  label?: string | undefined;
}

export interface SessionStartResult {
  agent: Agent;
  helloCode: string;
  leadSeatTakenBy: Agent | null;
}

export function startLiveSession(ctx: HubContext, user: string, input: SessionStartInput): SessionStartResult {
  return tx(ctx, (emit) => {
    const now = ctx.now();
    const existing = findAgentBySession(ctx, input.vendor, input.sessionId);
    if (existing && existing.user !== user) throw forbidden('this session belongs to another user');
    const lead = currentLead(ctx);
    const leadSeatTakenBy = input.role === 'lead' && lead !== null && lead.id !== existing?.id ? lead : null;
    const role: AgentRole = input.role === 'lead' && leadSeatTakenBy === null ? 'lead' : 'worker';
    const helloCode = randomHelloCode();
    let id: string;
    if (existing) {
      id = existing.id;
      ctx.db
        .query('UPDATE agents SET role = $role, hello_code = $code, label = COALESCE($label, label), last_seen_at = $now WHERE id = $id')
        .run({ role, code: helloCode, label: input.label ?? null, now, id });
    } else {
      const seq = nextId(ctx.db, 'agent');
      id = `A-${seq}`;
      ctx.db
        .query(
          `INSERT INTO agents (id, seq, login, vendor, role, origin, session_id, hello_code, label, current_task, last_seen_at, created_at)
           VALUES ($id, $seq, $login, $vendor, $role, 'live', $sessionId, $code, $label, NULL, $now, $now)`,
        )
        .run({
          id,
          seq,
          login: user,
          vendor: input.vendor,
          role,
          sessionId: input.sessionId,
          code: helloCode,
          label: input.label ?? null,
          now,
        });
    }
    if (role === 'lead') {
      const demoted = ctx.db
        .query("UPDATE agents SET role = 'worker' WHERE role = 'lead' AND id != $id RETURNING id")
        .all({ id }) as { id: string }[];
      if (existing?.role !== 'lead') {
        emit({ type: 'agent.lead_changed', actor: `user:${user}`, subject: id, data: { previous: demoted.map((row) => row.id) } });
      }
    }
    emit({
      type: 'agent.session_started',
      actor: `user:${user}`,
      subject: id,
      data: { vendor: input.vendor, role, label: input.label ?? null },
    });
    return { agent: getAgent(ctx, id), helloCode, leadSeatTakenBy };
  });
}

export function helloAgent(ctx: HubContext, user: string, code: string): Agent {
  const row = ctx.db
    .query('SELECT * FROM agents WHERE hello_code = $code AND login = $login')
    .get({ code: code.trim().toUpperCase(), login: user }) as AgentRow | null;
  if (!row) throw notFound('hello code');
  touchAgent(ctx, row.id);
  return getAgent(ctx, row.id);
}

/** Records that the agent is alive and renews the lease of the task it holds. */
export function touchAgent(ctx: HubContext, id: string): void {
  const now = ctx.now();
  ctx.db.query('UPDATE agents SET last_seen_at = $now WHERE id = $id').run({ now, id });
  ctx.db
    .query("UPDATE tasks SET lease_expires_at = $lease WHERE assignee = $id AND status IN ('claimed', 'working')")
    .run({ lease: now + ctx.config.leaseMs, id });
}
