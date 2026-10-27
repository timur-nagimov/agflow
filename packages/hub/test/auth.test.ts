import { describe, expect, test } from 'bun:test';
import {
  CLI_LOGIN_TTL,
  SESSION_TTL,
  approveCliLogin,
  consumeOAuthState,
  createOAuthState,
  createSession,
  deleteSession,
  hashToken,
  pollCliLogin,
  sweepAuth,
  verifySession,
} from '../src/auth';
import { HubError } from '../src/errors';
import { createTestContext } from './helpers';

const count = (ctx: ReturnType<typeof createTestContext>['ctx'], table: string) =>
  (ctx.db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe('sessions', () => {
  test('a session token identifies its user', () => {
    const { ctx } = createTestContext();
    const token = createSession(ctx, 'alice', 'cli', 'laptop');
    expect(verifySession(ctx, token)).toEqual({ user: 'alice', kind: 'cli' });
  });

  test('only allowlisted users get sessions, and logins are lowercased', () => {
    const { ctx } = createTestContext();
    expect(() => createSession(ctx, 'mallory', 'web')).toThrow(HubError);
    expect(verifySession(ctx, createSession(ctx, 'ALICE', 'web'))?.user).toBe('alice');
  });

  test('tokens are stored hashed', () => {
    const { ctx } = createTestContext();
    const token = createSession(ctx, 'alice', 'web');
    const row = ctx.db.query('SELECT token_hash FROM sessions').get() as { token_hash: string };
    expect(row.token_hash).toBe(hashToken(token));
    expect(row.token_hash).not.toBe(token);
  });

  test('sessions expire', () => {
    const { ctx, clock } = createTestContext();
    const token = createSession(ctx, 'alice', 'web');
    clock.advance(SESSION_TTL.web + 1);
    expect(verifySession(ctx, token)).toBeNull();
  });

  test('removing a user from the allowlist invalidates their sessions', () => {
    const { ctx } = createTestContext();
    const token = createSession(ctx, 'bob', 'cli');
    ctx.config.allowedUsers = ['alice'];
    expect(verifySession(ctx, token)).toBeNull();
  });

  test('deleted sessions stop working', () => {
    const { ctx } = createTestContext();
    const token = createSession(ctx, 'alice', 'web');
    deleteSession(ctx, token);
    expect(verifySession(ctx, token)).toBeNull();
  });
});

describe('CLI login', () => {
  const code = 'c'.repeat(32);

  test('pending until approved, then returns the token exactly once', () => {
    const { ctx } = createTestContext();
    expect(pollCliLogin(ctx, code)).toEqual({ status: 'pending' });
    approveCliLogin(ctx, code, 'alice', 'laptop');
    const result = pollCliLogin(ctx, code);
    if (result.status !== 'approved') throw new Error(`expected approved, got ${result.status}`);
    expect(result.user).toBe('alice');
    expect(verifySession(ctx, result.token)).toEqual({ user: 'alice', kind: 'cli' });
    expect(pollCliLogin(ctx, code)).toEqual({ status: 'pending' });
  });

  test('an approval older than the TTL has expired', () => {
    const { ctx, clock } = createTestContext();
    approveCliLogin(ctx, code, 'alice');
    clock.advance(CLI_LOGIN_TTL + 1);
    expect(pollCliLogin(ctx, code)).toEqual({ status: 'expired' });
  });
});

describe('OAuth state', () => {
  test('a state can be consumed once', () => {
    const { ctx } = createTestContext();
    const state = createOAuthState(ctx, '/board');
    expect(consumeOAuthState(ctx, state)).toEqual({ returnTo: '/board' });
    expect(consumeOAuthState(ctx, state)).toBeNull();
  });

  test('sweepAuth removes expired rows', () => {
    const { ctx, clock } = createTestContext();
    createSession(ctx, 'alice', 'web');
    createOAuthState(ctx, '/');
    clock.advance(SESSION_TTL.web + 1);
    sweepAuth(ctx);
    expect(count(ctx, 'sessions')).toBe(0);
    expect(count(ctx, 'oauth_states')).toBe(0);
  });
});
