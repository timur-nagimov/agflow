import { describe, expect, test } from 'bun:test';
import { TRANSCRIPT_TAIL_MAX_BYTES } from '@agflow/core';
import { insertAttempt, issueFence } from '../src/attempt-store';
import { mintAgentToken } from '../src/auth';
import { tx } from '../src/context';
import { addAgent, addRunnerAttempt } from './helpers';
import { createTestHub } from './http-helpers';

type Hub = ReturnType<typeof createTestHub>;

const tailOf = (hub: Hub, attemptId: string) =>
  (hub.ctx.db.query('SELECT transcript_tail FROM attempts WHERE id = $id').get({ id: attemptId }) as {
    transcript_tail: string | null;
  }).transcript_tail;

const path = (attemptId: string) => `/api/runner/attempts/${attemptId}/transcript`;

describe('POST /api/runner/attempts/:id/transcript', () => {
  test("stores the tail for the CLI token of the runner's owner, up to 64 KB", async () => {
    const hub = createTestHub();
    const { attempt } = addRunnerAttempt(hub.ctx, { owner: 'alice' });
    const tail = 'assistant: I fixed the parser.\n'.repeat(100);
    const stored = await hub.call('POST', path(attempt.id), { user: 'alice', body: { tail } });
    expect([stored.status, stored.json]).toEqual([200, { ok: true }]);
    expect(tailOf(hub, attempt.id)).toBe(tail);
    // A later upload replaces it; 64 KB is the most it takes.
    const full = 'é'.repeat(TRANSCRIPT_TAIL_MAX_BYTES / 2);
    expect((await hub.call('POST', path(attempt.id), { user: 'alice', body: { tail: full } })).status).toBe(200);
    expect(tailOf(hub, attempt.id)).toBe(full);
    const over = await hub.call('POST', path(attempt.id), { user: 'alice', body: { tail: `${full}x` } });
    expect([over.status, over.json.error]).toEqual([400, 'bad_request']);
    expect(tailOf(hub, attempt.id)).toBe(full);
  });

  test('refuses other users, browsers, agent tokens, live attempts and unknown attempts', async () => {
    const hub = createTestHub();
    const { attempt } = addRunnerAttempt(hub.ctx, { owner: 'alice' });
    const body = { tail: 'secret work' };
    const answer = async (options: Parameters<Hub['call']>[2], id = attempt.id) => {
      const result = await hub.call('POST', path(id), { body, ...options });
      return [result.status, result.json.error];
    };
    expect(await answer({ user: 'bob' })).toEqual([403, 'forbidden']);
    expect(await answer({ user: 'alice', via: 'web', headers: { origin: 'http://hub.test' } })).toEqual([
      401,
      'unauthorized',
    ]);
    expect(await answer({ headers: { authorization: `Bearer ${mintAgentToken(hub.ctx, attempt)}` } })).toEqual([
      403,
      'agent_not_allowed',
    ]);
    expect(await answer({})).toEqual([401, 'unauthorized']);
    expect(await answer({ user: 'alice' }, 'T-9-a1')).toEqual([404, 'not_found']);
    // A live chat's attempt has no runner, so no runner uploads its transcript.
    const live = addAgent(hub.ctx, 'alice');
    const chat = tx(hub.ctx, () =>
      insertAttempt(hub.ctx, {
        id: 'lead-a1',
        taskId: null,
        number: 1,
        role: 'lead',
        agentId: live.id,
        runnerId: null,
        vendor: 'claude',
        fence: issueFence(hub.ctx),
        status: 'running',
      }),
    );
    expect(await answer({ user: 'alice' }, chat.id)).toEqual([403, 'forbidden']);
    expect(tailOf(hub, attempt.id)).toBeNull();
  });
});
