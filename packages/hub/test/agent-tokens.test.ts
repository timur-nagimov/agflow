import { describe, expect, test } from 'bun:test';
import { BRIDGE_ANSWERS } from '@agflow/core';
import { issueFence, updateAttempt } from '../src/attempt-store';
import {
  SESSION_TTL,
  createSession,
  hashToken,
  mintAgentToken,
  resolveAgentToken,
  revokeAgentTokens,
  sessionHashOf,
  slideSession,
} from '../src/auth';
import { tx } from '../src/context';
import { getAgent } from '../src/agents';
import { HubError } from '../src/errors';
import { updateHubState } from '../src/hub-state';
import { resolvePrincipal } from '../src/http/app';
import { sendMessage, unreadFor } from '../src/messages';
import { getTask, listTaskNotes, move, writeTask } from '../src/task-store';
import { reportProgress, submitTask } from '../src/tasks';
import { addAgent, addRunnerAttempt, createTestContext } from './helpers';
import { createTestHub } from './http-helpers';

type Hub = ReturnType<typeof createTestHub>;

const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

/** A request with an agent token, the way the bridge sends one. */
async function withToken(hub: Hub, token: string, method: string, path: string, body?: unknown) {
  return hub.call(method, path, { ...bearer(token), body });
}

function refusal(error: () => unknown): HubError {
  try {
    error();
  } catch (caught) {
    if (caught instanceof HubError) return caught;
    throw caught;
  }
  throw new Error('expected a refusal');
}

describe('agent tokens', () => {
  test('a token is agt_ and 43 base64url characters, and only its sha256 is stored', () => {
    const { ctx } = createTestContext();
    const { attempt, agent } = addRunnerAttempt(ctx);
    const token = mintAgentToken(ctx, attempt);
    expect(token).toMatch(/^agt_[A-Za-z0-9_-]{43}$/);
    const rows = ctx.db.query('SELECT * FROM agent_tokens').all();
    expect(rows).toEqual([
      {
        token_hash: hashToken(token),
        agent_id: agent.id,
        attempt_id: attempt.id,
        fence_epoch: attempt.fence.epoch,
        fence_counter: attempt.fence.counter,
        created_at: ctx.now(),
        revoked_at: null,
      },
    ]);
    expect(JSON.stringify(rows)).not.toContain(token.slice(4));
  });

  test('a valid token resolves to the runner owner, via agent, and several tokens of one fence all work', async () => {
    const hub = createTestHub();
    const { attempt, agent } = addRunnerAttempt(hub.ctx, { owner: 'bob' });
    const first = mintAgentToken(hub.ctx, attempt);
    const second = mintAgentToken(hub.ctx, attempt);
    expect(first).not.toBe(second);
    const grant = resolveAgentToken(hub.ctx, first);
    expect(grant.user).toBe('bob');
    expect(grant.agent.id).toBe(agent.id);
    expect(grant.attempt.id).toBe(attempt.id);
    expect(resolvePrincipal(hub.ctx, `Bearer ${second}`, undefined, undefined)).toMatchObject({
      user: 'bob',
      via: 'agent',
      agent: { id: agent.id, origin: 'runner' },
      token: second,
    });
    for (const token of [first, second]) {
      const tasks = await withToken(hub, token, 'GET', '/api/tasks');
      expect([tasks.status, tasks.json.tasks.length]).toEqual([200, 1]);
    }
  });

  test('revoked tokens, ended attempts, older fences and unknown tokens get 401 attempt_ended with the reason', async () => {
    const hub = createTestHub();
    const ended = (reason: string | null) => ({
      error: 'attempt_ended',
      message: BRIDGE_ANSWERS.attemptEnded(reason),
      reason,
    });

    const revoked = addRunnerAttempt(hub.ctx);
    const revokedToken = mintAgentToken(hub.ctx, revoked.attempt);
    revokeAgentTokens(hub.ctx, revoked.attempt.id);
    const revokedAnswer = await withToken(hub, revokedToken, 'GET', '/api/tasks');
    expect([revokedAnswer.status, revokedAnswer.json]).toEqual([401, ended(null)]);

    const finished = addRunnerAttempt(hub.ctx);
    const finishedToken = mintAgentToken(hub.ctx, finished.attempt);
    updateAttempt(hub.ctx, finished.attempt.id, { status: 'ended', endReason: 'stopped', endedAt: hub.ctx.now() });
    const finishedAnswer = await withToken(hub, finishedToken, 'GET', '/api/tasks');
    expect([finishedAnswer.status, finishedAnswer.json]).toEqual([401, ended('stopped')]);

    const refenced = addRunnerAttempt(hub.ctx);
    const oldToken = mintAgentToken(hub.ctx, refenced.attempt);
    const fence = issueFence(hub.ctx);
    updateAttempt(hub.ctx, refenced.attempt.id, { fence });
    const oldAnswer = await withToken(hub, oldToken, 'GET', '/api/tasks');
    expect([oldAnswer.status, oldAnswer.json]).toEqual([401, ended(null)]);
    const newToken = mintAgentToken(hub.ctx, { ...refenced.attempt, fence });
    expect((await withToken(hub, newToken, 'GET', '/api/tasks')).status).toBe(200);

    const unknown = await withToken(hub, `agt_${'A'.repeat(43)}`, 'GET', '/api/tasks');
    expect([unknown.status, unknown.json]).toEqual([401, ended(null)]);

    // An owner who leaves the allowlist takes the runner's agents along, with an answer the bridge knows.
    const removed = addRunnerAttempt(hub.ctx, { owner: 'bob' });
    const removedToken = mintAgentToken(hub.ctx, removed.attempt);
    expect((await withToken(hub, removedToken, 'GET', '/api/tasks')).status).toBe(200);
    hub.ctx.config.allowedUsers = ['alice'];
    const removedAnswer = await withToken(hub, removedToken, 'GET', '/api/tasks');
    expect([removedAnswer.status, removedAnswer.json]).toEqual([401, ended(null)]);
  });

  test('an older epoch on an open attempt gets 401 attempt_refenced', async () => {
    const hub = createTestHub();
    const { attempt } = addRunnerAttempt(hub.ctx);
    const token = mintAgentToken(hub.ctx, attempt);
    hub.ctx.db.run('UPDATE project SET epoch = 2');
    const answer = await withToken(hub, token, 'GET', '/api/tasks');
    expect([answer.status, answer.json]).toEqual([
      401,
      { error: 'attempt_refenced', message: BRIDGE_ANSWERS.attemptRefenced },
    ]);
    updateAttempt(hub.ctx, attempt.id, { status: 'ended', endReason: 'superseded' });
    expect((await withToken(hub, token, 'GET', '/api/tasks')).json.error).toBe('attempt_ended');
  });

  test('an unknown agt_ token gets attempt_refenced while the restore is less than runnerLeaseMs old', () => {
    const { ctx, clock } = createTestContext();
    const unknown = `agt_${'B'.repeat(43)}`;
    updateHubState(ctx, { restoredAt: ctx.now() });
    expect(refusal(() => resolveAgentToken(ctx, unknown)).code).toBe('attempt_refenced');
    clock.advance(ctx.config.runnerLeaseMs - 1);
    expect(refusal(() => resolveAgentToken(ctx, unknown)).code).toBe('attempt_refenced');
    clock.advance(1);
    const ended = refusal(() => resolveAgentToken(ctx, unknown));
    expect([ended.status, ended.code, ended.extra]).toEqual([401, 'attempt_ended', { reason: null }]);
  });

  test('an agt_ bearer is never looked up as a session', () => {
    const { ctx } = createTestContext();
    const token = `agt_${'C'.repeat(43)}`;
    ctx.db
      .query("INSERT INTO sessions (token_hash, login, kind, created_at, expires_at) VALUES ($hash, 'alice', 'cli', 0, $expires)")
      .run({ hash: hashToken(token), expires: ctx.now() + SESSION_TTL.cli });
    expect(refusal(() => resolvePrincipal(ctx, `Bearer ${token}`, undefined, undefined)).code).toBe('attempt_ended');
  });

  test('X-Agflow-Agent is refused with an agent token, and with a CLI token naming a runner agent', async () => {
    const hub = createTestHub();
    const { attempt, agent } = addRunnerAttempt(hub.ctx);
    const token = mintAgentToken(hub.ctx, attempt);
    const live = addAgent(hub.ctx, 'alice');
    const named = await hub.call('GET', '/api/tasks', { headers: { authorization: `Bearer ${token}` }, agent: live.id });
    expect([named.status, named.json.error]).toEqual([403, 'agent_not_allowed']);
    const impersonated = await hub.call('GET', '/api/tasks', { user: 'alice', via: 'cli', agent: agent.id });
    expect([impersonated.status, impersonated.json.error]).toEqual([403, 'forbidden']);
    expect((await hub.call('GET', '/api/tasks', { user: 'alice', via: 'cli', agent: live.id })).status).toBe(200);
  });

  test("the owner's CLI token cannot use a runner agent's session id on the live hook routes", async () => {
    const hub = createTestHub();
    const { agent, task } = addRunnerAttempt(hub.ctx);
    hub.ctx.db.query("UPDATE agents SET session_id = 'runner-session' WHERE id = $id").run({ id: agent.id });
    const message = sendMessage(hub.ctx, { from: 'user:bob', to: `agent:${agent.id}`, body: 'for the runner agent' });
    const session = 'vendor=claude&sessionId=runner-session';
    for (const [method, path, body] of [
      ['GET', `/api/live/inbox?${session}`, undefined],
      ['GET', `/api/live/peek?${session}`, undefined],
      ['POST', '/api/live/stop-check', { vendor: 'claude', sessionId: 'runner-session', stopHookActive: false }],
    ] as const) {
      const answer = await hub.call(method, path, { user: 'alice', body });
      expect([path, answer.status, answer.json.message]).toEqual([path, 409, 'this session belongs to a runner agent']);
    }
    expect(unreadFor(hub.ctx, getAgent(hub.ctx, agent.id)).map((unread) => unread.id)).toEqual([message.id]);
    expect(getTask(hub.ctx, task.id).leaseExpiresAt).toBeNull();
  });
});

describe('the holder test for agent tokens', () => {
  function setup() {
    const hub = createTestHub();
    const held = addRunnerAttempt(hub.ctx);
    const token = mintAgentToken(hub.ctx, held.attempt);
    return { hub, held, token, path: (action: string) => `/api/tasks/${held.task.id}/${action}` };
  }

  test('progress and handoff need the current attempt, and carry its id into the notes', async () => {
    const { hub, held, token, path } = setup();
    const progress = await withToken(hub, token, 'POST', path('progress'), { note: 'tests pass' });
    expect(progress.status).toBe(200);
    expect(progress.json.task).toMatchObject({ status: 'working', leaseExpiresAt: null });
    expect((await withToken(hub, token, 'POST', path('handoff'), { note: 'next: docs' })).status).toBe(200);
    expect(listTaskNotes(hub.ctx, held.task.id).map((note) => [note.kind, note.attemptId])).toEqual([
      ['progress', held.attempt.id],
      ['handoff', held.attempt.id],
    ]);
  });

  test('progress and handoff work in any task status; submit, block, impossible and release need claimed or working', async () => {
    const { hub, held, token, path } = setup();
    tx(hub.ctx, (emit) =>
      move(hub.ctx, emit, getTask(hub.ctx, held.task.id), 'blocked', 'user:alice', {
        changes: { blockedKind: 'paused', blockedReason: 'held by a person' },
      }),
    );
    expect((await withToken(hub, token, 'POST', path('progress'), { note: 'still here' })).status).toBe(200);
    expect((await withToken(hub, token, 'POST', path('handoff'), { note: 'stopping' })).status).toBe(200);
    for (const [action, body] of [
      ['submit', { summary: 'done', evidence: [] }],
      ['block', { reason: 'stuck' }],
      ['impossible', { evidence: 'cannot' }],
      ['release', { reason: 'bye' }],
    ] as const) {
      const answer = await withToken(hub, token, 'POST', path(action), body);
      expect([action, answer.status]).toEqual([action, 409]);
    }
    expect(getTask(hub.ctx, held.task.id).status).toBe('blocked');
  });

  test('an ended attempt holds nothing, even for a caller that passes no token', () => {
    const { hub, held } = setup();
    updateAttempt(hub.ctx, held.attempt.id, { status: 'ended', endReason: 'lost', endedAt: hub.ctx.now() });
    expect(() => reportProgress(hub.ctx, held.task.id, held.agent, 'late')).toThrow(`you do not hold ${held.task.id}`);
  });

  test('the token is checked again once the body has arrived, so a re-fence meanwhile refuses the action', async () => {
    const { hub, held, token, path } = setup();
    const send = (action: string, body: unknown, meanwhile: () => void) => {
      // The stream gives its body only when the route reads it, after the middleware has resolved the token.
      const stream = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            meanwhile();
            controller.enqueue(new TextEncoder().encode(JSON.stringify(body)));
            controller.close();
          },
        },
        { highWaterMark: 0 },
      );
      return hub.app.request(path(action), {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: stream,
      });
    };
    const refenced = await send('progress', { note: 'superseded' }, () => {
      revokeAgentTokens(hub.ctx, held.attempt.id);
      updateAttempt(hub.ctx, held.attempt.id, { fence: issueFence(hub.ctx) });
    });
    expect([refenced.status, ((await refenced.json()) as { error: string }).error]).toEqual([401, 'attempt_ended']);
    expect(listTaskNotes(hub.ctx, held.task.id)).toEqual([]);
    expect(getTask(hub.ctx, held.task.id).status).toBe('claimed');
    // A direct call with the stale token is refused the same way.
    expect(refusal(() => submitTask(hub.ctx, held.task.id, held.agent, { summary: 'x', evidence: [] }, token)).code).toBe(
      'attempt_ended',
    );
  });

  test('a recorded stop refuses submit, block, impossible and release but not progress or handoff', async () => {
    const { hub, held, token, path } = setup();
    updateAttempt(hub.ctx, held.attempt.id, {
      stopRequested: { cause: 'stop', reason: 'a person stopped it', by: 'user:alice', handoff: true, deferred: false, at: 0 },
    });
    for (const [action, body] of [
      ['submit', { summary: 'done', evidence: [] }],
      ['block', { reason: 'stuck' }],
      ['impossible', { evidence: 'cannot' }],
      ['release', { reason: 'bye' }],
    ] as const) {
      const answer = await withToken(hub, token, 'POST', path(action), body);
      expect([action, answer.status, answer.json.message]).toEqual([action, 409, expect.stringContaining('being stopped')]);
    }
    expect((await withToken(hub, token, 'POST', path('progress'), { note: 'wrapping up' })).status).toBe(200);
    expect((await withToken(hub, token, 'POST', path('handoff'), { note: 'handoff' })).status).toBe(200);
  });

  test('a claimed task lets its current attempt submit, and no other attempt act on it', async () => {
    const { hub, held, token, path } = setup();
    const other = addRunnerAttempt(hub.ctx, { runnerId: held.runner.id });
    const otherToken = mintAgentToken(hub.ctx, other.attempt);
    const foreign = await withToken(hub, otherToken, 'POST', path('progress'), { note: 'not mine' });
    expect([foreign.status, foreign.json.message]).toEqual([403, `you do not hold ${held.task.id}`]);
    writeTask(hub.ctx, held.task.id, { currentAttempt: other.attempt.id });
    expect((await withToken(hub, token, 'POST', path('handoff'), { note: 'x' })).status).toBe(403);
    writeTask(hub.ctx, held.task.id, { currentAttempt: held.attempt.id });
    const submitted = await withToken(hub, token, 'POST', path('submit'), { summary: 'done', evidence: ['bun test'] });
    expect([submitted.status, submitted.json.task.status]).toEqual([200, 'submitted']);
  });
});

describe('CLI sessions', () => {
  test('slideSession moves a CLI session expiry forward by the CLI TTL, and never a web session', () => {
    const { ctx, clock } = createTestContext();
    const cli = createSession(ctx, 'alice', 'cli');
    const web = createSession(ctx, 'alice', 'web');
    const expiry = (token: string) =>
      (ctx.db.query('SELECT expires_at FROM sessions WHERE token_hash = $hash').get({ hash: sessionHashOf(token) }) as {
        expires_at: number;
      } | null)?.expires_at;
    expect(sessionHashOf(cli)).toBe(hashToken(cli));
    // The web session is still valid here, so only its kind keeps it from sliding.
    clock.advance(24 * 60 * 60_000);
    const webExpiry = expiry(web);
    expect(slideSession(ctx, sessionHashOf(web))).toBe(false);
    expect(expiry(web)).toBe(webExpiry);
    clock.advance(29 * 24 * 60 * 60_000);
    expect(slideSession(ctx, sessionHashOf(cli))).toBe(true);
    expect(expiry(cli)).toBe(ctx.now() + SESSION_TTL.cli);
    clock.advance(SESSION_TTL.cli);
    expect(slideSession(ctx, sessionHashOf(cli))).toBe(false);
    expect(slideSession(ctx, hashToken('unknown'))).toBe(false);
  });
});
