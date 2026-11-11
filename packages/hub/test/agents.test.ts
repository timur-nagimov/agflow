import { describe, expect, test } from 'bun:test';
import { ACTIVE_MS, IDLE_MS, getAgent, helloAgent, listAgents, startLiveSession } from '../src/agents';
import { HubError } from '../src/errors';
import { createTestContext } from './helpers';

describe('live sessions', () => {
  test('a new session becomes a worker agent with a hello code', () => {
    const { ctx } = createTestContext();
    const result = startLiveSession(ctx, 'alice', { vendor: 'claude', sessionId: 's1', role: 'worker' });
    expect(result.agent).toMatchObject({ id: 'A-1', user: 'alice', vendor: 'claude', role: 'worker', origin: 'live' });
    expect(result.helloCode).toMatch(/^[A-Z2-9]{6}$/);
    expect(result.leadSeatTakenBy).toBeNull();
  });

  test('restarting the same session keeps the agent and issues a new code', () => {
    const { ctx } = createTestContext();
    const first = startLiveSession(ctx, 'alice', { vendor: 'codex', sessionId: 's1', role: 'worker' });
    const second = startLiveSession(ctx, 'alice', { vendor: 'codex', sessionId: 's1', role: 'worker' });
    expect(second.agent.id).toBe(first.agent.id);
    expect(listAgents(ctx)).toHaveLength(1);
  });

  test('the same session id under another vendor is a different agent', () => {
    const { ctx } = createTestContext();
    startLiveSession(ctx, 'alice', { vendor: 'codex', sessionId: 's1', role: 'worker' });
    startLiveSession(ctx, 'alice', { vendor: 'claude', sessionId: 's1', role: 'worker' });
    expect(listAgents(ctx).map((agent) => agent.id)).toEqual(['A-1', 'A-2']);
  });

  test("another user cannot take over someone's session", () => {
    const { ctx } = createTestContext();
    startLiveSession(ctx, 'alice', { vendor: 'claude', sessionId: 's1', role: 'worker' });
    expect(() => startLiveSession(ctx, 'bob', { vendor: 'claude', sessionId: 's1', role: 'worker' })).toThrow(
      'this session belongs to another user',
    );
  });
});

// The lead seat has its own suite: lead-seat.test.ts.

describe('hello and liveness', () => {
  test('hello resolves a code for the same user only', () => {
    const { ctx } = createTestContext();
    const { agent, helloCode } = startLiveSession(ctx, 'alice', { vendor: 'claude', sessionId: 's1', role: 'worker' });
    expect(helloAgent(ctx, 'alice', helloCode.toLowerCase()).id).toBe(agent.id);
    expect(() => helloAgent(ctx, 'bob', helloCode)).toThrow(HubError);
  });

  test('status goes active, idle, gone', () => {
    const { ctx, clock } = createTestContext();
    const { agent } = startLiveSession(ctx, 'alice', { vendor: 'claude', sessionId: 's1', role: 'worker' });
    expect(getAgent(ctx, agent.id).status).toBe('active');
    clock.advance(ACTIVE_MS);
    expect(getAgent(ctx, agent.id).status).toBe('idle');
    clock.advance(IDLE_MS);
    expect(getAgent(ctx, agent.id).status).toBe('gone');
  });
});
