import { describe, expect, test } from 'bun:test';
import { getAgent, startLiveSession } from '../src/agents';
import { peekInbox } from '../src/live';
import { sendMessage, unreadFor } from '../src/messages';
import { createTestContext } from './helpers';
import { createTestHub } from './http-helpers';

describe('peekInbox', () => {
  test('counts unread messages without delivering them or touching the agent', () => {
    const { ctx, clock } = createTestContext();
    const { agent } = startLiveSession(ctx, 'alice', { vendor: 'claude', sessionId: 's1', role: 'worker' });
    sendMessage(ctx, { from: 'user:bob', to: `agent:${agent.id}`, body: 'Please also update the docs.' });
    clock.advance(5 * 60_000);
    expect(peekInbox(ctx, 'alice', 'claude', 's1')).toEqual({
      unread: 1,
      first: { from: 'user:bob' },
    });
    expect(unreadFor(ctx, getAgent(ctx, agent.id))).toHaveLength(1);
    expect(getAgent(ctx, agent.id).lastSeenAt).toBe(agent.lastSeenAt);
  });

  test('unknown sessions have nothing, and other people cannot peek', () => {
    const { ctx } = createTestContext();
    startLiveSession(ctx, 'alice', { vendor: 'claude', sessionId: 's1', role: 'worker' });
    expect(peekInbox(ctx, 'alice', 'codex', 'nope')).toEqual({ unread: 0, first: null });
    expect(() => peekInbox(ctx, 'bob', 'claude', 's1')).toThrow('another user');
  });

  test('is served at /api/live/peek', async () => {
    const hub = createTestHub();
    await hub.liveAgent('alice', 's1');
    const result = await hub.call('GET', '/api/live/peek?vendor=claude&sessionId=s1', { user: 'alice' });
    expect(result.json).toEqual({ unread: 0, first: null });
  });
});
