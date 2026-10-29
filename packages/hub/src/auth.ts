import { type Agent, type Attempt, fenceEquals } from '@agflow/core';
import { findAgent } from './agents';
import { findAttempt } from './attempt-store';
import { type HubContext, tx } from './context';
import { attemptEnded, attemptRefenced, conflict, forbidden } from './errors';
import { getHubState, hubEpoch } from './hub-state';

export type SessionKind = 'web' | 'cli';

const DAY = 24 * 60 * 60_000;
export const SESSION_TTL: Record<SessionKind, number> = { web: 14 * DAY, cli: 90 * DAY };
export const CLI_LOGIN_TTL = 10 * 60_000;
export const OAUTH_STATE_TTL = 10 * 60_000;

export interface SessionInfo {
  user: string;
  kind: SessionKind;
}

export function randomToken(bytes = 32): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString('base64url');
}

export function hashToken(token: string): string {
  return new Bun.CryptoHasher('sha256').update(token).digest('hex');
}

export function isAllowed(ctx: HubContext, user: string): boolean {
  const login = user.toLowerCase();
  return ctx.config.allowedUsers.some((allowed) => allowed.toLowerCase() === login);
}

export function createSession(ctx: HubContext, user: string, kind: SessionKind, label?: string): string {
  if (!isAllowed(ctx, user)) throw forbidden(`${user} is not on this hub's allowlist`);
  // resolvePrincipal reads every bearer with the agent prefix as an agent token, so no session token may have it.
  let token = randomToken();
  while (isAgentToken(token)) token = randomToken();
  const now = ctx.now();
  ctx.db
    .query(
      'INSERT INTO sessions (token_hash, login, kind, label, created_at, expires_at) VALUES ($hash, $login, $kind, $label, $now, $expires)',
    )
    .run({
      hash: hashToken(token),
      login: user.toLowerCase(),
      kind,
      label: label ?? null,
      now,
      expires: now + SESSION_TTL[kind],
    });
  return token;
}

export function verifySession(ctx: HubContext, token: string): SessionInfo | null {
  const hash = hashToken(token);
  const row = ctx.db.query('SELECT login, kind, expires_at FROM sessions WHERE token_hash = $hash').get({ hash }) as {
    login: string;
    kind: SessionKind;
    expires_at: number;
  } | null;
  if (!row) return null;
  if (row.expires_at <= ctx.now()) {
    ctx.db.query('DELETE FROM sessions WHERE token_hash = $hash').run({ hash });
    return null;
  }
  if (!isAllowed(ctx, row.login)) return null;
  return { user: row.login, kind: row.kind };
}

export function deleteSession(ctx: HubContext, token: string): void {
  ctx.db.query('DELETE FROM sessions WHERE token_hash = $hash').run({ hash: hashToken(token) });
}

/** The key a session is stored under, which runners.session_hash records for a runner's link. */
export function sessionHashOf(token: string): string {
  return hashToken(token);
}

/**
 * Moves a CLI session's expiry to a full TTL from now, so a runner in use never loses its login to the 90-day limit
 * (design 6.3). False when no unexpired CLI session has this hash.
 */
export function slideSession(ctx: HubContext, sessionHash: string): boolean {
  const now = ctx.now();
  const result = ctx.db
    .query("UPDATE sessions SET expires_at = $expires WHERE token_hash = $hash AND kind = 'cli' AND expires_at > $now")
    .run({ hash: sessionHash, now, expires: now + SESSION_TTL.cli });
  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// Agent tokens (design 6.5)
// ---------------------------------------------------------------------------

export const AGENT_TOKEN_PREFIX = 'agt_';

export function isAgentToken(token: string): boolean {
  return token.startsWith(AGENT_TOKEN_PREFIX);
}

/**
 * A new token for the attempt at the given fence: 'agt_' and 32 random bytes in base64url. Only its hash is stored;
 * the raw token goes into a wire command and nowhere else.
 */
export function mintAgentToken(ctx: HubContext, attempt: Pick<Attempt, 'id' | 'agentId' | 'fence'>): string {
  const token = `${AGENT_TOKEN_PREFIX}${randomToken(32)}`;
  ctx.db
    .query(
      `INSERT INTO agent_tokens (token_hash, agent_id, attempt_id, fence_epoch, fence_counter, created_at)
       VALUES ($hash, $agentId, $attemptId, $fenceEpoch, $fenceCounter, $now)`,
    )
    .run({
      hash: hashToken(token),
      agentId: attempt.agentId,
      attemptId: attempt.id,
      fenceEpoch: attempt.fence.epoch,
      fenceCounter: attempt.fence.counter,
      now: ctx.now(),
    });
  return token;
}

/** Every token of the attempt stops working: it ended, got a new fence, or the epoch changed. */
export function revokeAgentTokens(ctx: HubContext, attemptId: string): void {
  ctx.db
    .query('UPDATE agent_tokens SET revoked_at = $now WHERE attempt_id = $attemptId AND revoked_at IS NULL')
    .run({ attemptId, now: ctx.now() });
}

export interface AgentGrant {
  /** The runner's owner, whose user the runner agent belongs to. */
  user: string;
  agent: Agent;
  attempt: Attempt;
}

interface AgentTokenRow {
  agent_id: string;
  attempt_id: string;
  fence_epoch: number;
  fence_counter: number;
  revoked_at: number | null;
}

/**
 * The agent a token acts for. Valid means not revoked, the attempt not ended, and the token's fence the attempt's
 * current one, at the current hub epoch. Otherwise it throws 401 attempt_refenced when a restore is about to give the
 * attempt a new fence, and 401 attempt_ended for every other fault.
 */
export function resolveAgentToken(ctx: HubContext, token: string): AgentGrant {
  const row = ctx.db
    .query('SELECT agent_id, attempt_id, fence_epoch, fence_counter, revoked_at FROM agent_tokens WHERE token_hash = $hash')
    .get({ hash: hashToken(token) }) as AgentTokenRow | null;
  if (!row) {
    // Tokens minted after the backup are unknown to a restored hub, and their attempts are about to be re-fenced.
    const { restoredAt } = getHubState(ctx);
    if (restoredAt !== null && ctx.now() - restoredAt < ctx.config.runnerLeaseMs) throw attemptRefenced();
    throw attemptEnded(null);
  }
  const attempt = findAttempt(ctx, row.attempt_id);
  if (!attempt || attempt.status === 'ended') throw attemptEnded(attempt?.endReason ?? null);
  const fence = { epoch: row.fence_epoch, counter: row.fence_counter };
  if (row.revoked_at !== null || !fenceEquals(fence, attempt.fence)) throw attemptEnded(null);
  // The token's only fault is the epoch, so the attempt is waiting for its re-fence after a restore.
  if (fence.epoch !== hubEpoch(ctx)) throw attemptRefenced();
  const agent = findAgent(ctx, row.agent_id);
  if (!agent) throw attemptEnded(null);
  // Like a session, the token stops working once its owner leaves the allowlist. The answer stays in the closed set
  // the bridge knows (design 6.5), so the agent is told to stop.
  if (!isAllowed(ctx, agent.user)) throw attemptEnded(null);
  return { user: agent.user, agent, attempt };
}

/** Stores only the approval; pollCliLogin starts the session when the CLI collects it, so no raw token is stored. */
export function approveCliLogin(ctx: HubContext, code: string, user: string, label?: string): void {
  if (!isAllowed(ctx, user)) throw forbidden(`${user} is not on this hub's allowlist`);
  const result = ctx.db
    .query(
      'INSERT INTO cli_logins (code, created_at, login, label) VALUES ($code, $now, $login, $label) ON CONFLICT (code) DO NOTHING',
    )
    .run({ code, now: ctx.now(), login: user.toLowerCase(), label: label ?? null });
  if (result.changes === 0) throw conflict('this sign-in is already approved');
}

export type CliLoginPoll =
  | { status: 'pending' }
  | { status: 'expired' }
  | { status: 'approved'; token: string; user: string };

export function pollCliLogin(ctx: HubContext, code: string): CliLoginPoll {
  return tx(ctx, (): CliLoginPoll => {
    const row = ctx.db.query('SELECT created_at, login, label FROM cli_logins WHERE code = $code').get({ code }) as {
      created_at: number;
      login: string;
      label: string | null;
    } | null;
    if (!row) return { status: 'pending' };
    // Expired approvals stay until sweepAuth removes them, so a CLI that polls late still hears 'expired'.
    if (row.created_at + CLI_LOGIN_TTL <= ctx.now()) return { status: 'expired' };
    ctx.db.query('DELETE FROM cli_logins WHERE code = $code').run({ code });
    // createSession re-checks the allowlist; if it refuses, the transaction keeps the approval unconsumed.
    return { status: 'approved', token: createSession(ctx, row.login, 'cli', row.label ?? undefined), user: row.login };
  });
}

export function createOAuthState(ctx: HubContext, returnTo: string): string {
  const state = randomToken(16);
  ctx.db
    .query('INSERT INTO oauth_states (state, created_at, return_to) VALUES ($state, $now, $returnTo)')
    .run({ state, now: ctx.now(), returnTo });
  return state;
}

export function consumeOAuthState(ctx: HubContext, state: string): { returnTo: string } | null {
  const row = ctx.db.query('SELECT created_at, return_to FROM oauth_states WHERE state = $state').get({ state }) as {
    created_at: number;
    return_to: string;
  } | null;
  if (!row) return null;
  ctx.db.query('DELETE FROM oauth_states WHERE state = $state').run({ state });
  if (row.created_at + OAUTH_STATE_TTL <= ctx.now()) return null;
  return { returnTo: row.return_to };
}

export function sweepAuth(ctx: HubContext): void {
  const now = ctx.now();
  ctx.db.query('DELETE FROM sessions WHERE expires_at <= $now').run({ now });
  // Expired CLI approvals stay one more TTL: a CLI that resumes polling after a laptop sleeps still hears 'expired'.
  ctx.db.query('DELETE FROM cli_logins WHERE created_at <= $cutoff').run({ cutoff: now - 2 * CLI_LOGIN_TTL });
  ctx.db.query('DELETE FROM oauth_states WHERE created_at <= $cutoff').run({ cutoff: now - OAUTH_STATE_TTL });
}
