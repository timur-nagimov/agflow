import { describe, expect, test } from 'bun:test';
import { updateGoal } from '../src/goal';
import { sendMessage } from '../src/messages';
import { createTestHub } from './http-helpers';

describe('live-session routes', () => {
  test('a session registers through the hook endpoint and binds with hello', async () => {
    const hub = createTestHub();
    updateGoal(hub.ctx, { text: 'Ship it.', baseVersion: 0 }, 'user:alice');
    const start = await hub.call('POST', '/api/live/session-start', {
      user: 'alice',
      body: { vendor: 'codex', sessionId: 'thread-1', role: 'worker', label: 'demo' },
    });
    expect(start.json).toMatchObject({ agentId: 'A-1', role: 'worker' });
    expect(start.json.brief).toContain('Ship it.');
    const code = start.json.brief.match(/code "([A-Z2-9]{6})"/)?.[1];
    expect(code).toBeDefined();
    expect((await hub.call('POST', '/api/live/hello', { user: 'alice', body: { code } })).json).toEqual({
      agentId: 'A-1',
      role: 'worker',
      vendor: 'codex',
    });
    expect((await hub.call('POST', '/api/live/hello', { user: 'bob', body: { code } })).status).toBe(404);
    const agents = await hub.call('GET', '/api/agents', { user: 'alice', via: 'web' });
    expect(agents.json.agents.map((a: { id: string; status: string }) => `${a.id} ${a.status}`)).toEqual(['A-1 active']);
    // A live chat runs on no runner and, until it claims a task, in no attempt.
    expect(agents.json.agents[0]).toMatchObject({ origin: 'live', runnerId: null, attemptId: null });
  });

  test('a lead session gets the lead brief', async () => {
    const hub = createTestHub();
    const start = await hub.call('POST', '/api/live/session-start', {
      user: 'alice',
      body: { vendor: 'claude', sessionId: 'lead', role: 'lead' },
    });
    expect(start.json.role).toBe('lead');
    expect(start.json.brief).toContain('## Situation report');
  });

  test('hooks check for messages and fetch them by session', async () => {
    const hub = createTestHub();
    const id = await hub.liveAgent('alice', 's1');
    sendMessage(hub.ctx, { from: 'user:bob', to: `agent:${id}`, body: 'Use pnpm.' });
    const session = { vendor: 'claude', sessionId: 's1' };
    expect((await hub.call('POST', '/api/live/stop-check', { user: 'alice', body: session })).json.action).toBe('block');
    const inbox = await hub.call('GET', '/api/live/inbox?vendor=claude&sessionId=s1', { user: 'alice' });
    expect(inbox.json.messages.map((m: { body: string }) => m.body)).toEqual(['Use pnpm.']);
    expect((await hub.call('POST', '/api/live/stop-check', { user: 'alice', body: session })).json).toEqual({ action: 'allow' });
  });

  test('hook endpoints need a signed-in user', async () => {
    const hub = createTestHub();
    const result = await hub.call('POST', '/api/live/session-start', { body: { vendor: 'claude', sessionId: 's' } });
    expect(result.status).toBe(401);
  });
});
