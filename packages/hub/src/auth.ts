import { type HubContext, tx } from './context';
import { conflict, forbidden } from './errors';

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
  const token = randomToken();
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
