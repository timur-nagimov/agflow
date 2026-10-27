import { describe, expect, test } from 'bun:test';
import { startLiveSession } from '../src/agents';
import { LIVE_INBOX_CHAR_LIMIT, liveInbox, stopCheck } from '../src/live';
import { sendMessage, unreadFor } from '../src/messages';
import { claimTask, createTasks } from '../src/tasks';
import { createTestContext, newTask } from './helpers';

function session(ctx: ReturnType<typeof createTestContext>['ctx'], user = 'alice') {
  return startLiveSession(ctx, user, { vendor: 'claude', sessionId: `s-${user}`, role: 'worker' }).agent;
}

describe('liveInbox', () => {
  test('an unknown session has an empty inbox', () => {
    const { ctx } = createTestContext();
    expect(liveInbox(ctx, 'alice', 'claude', 'nope')).toEqual({ messages: [], more: 0 });
  });

  test('returns unread messages within the size budget and marks them delivered', () => {
    const { ctx } = createTestContext();
    const agent = session(ctx);
    sendMessage(ctx, { from: 'user:bob', to: `agent:${agent.id}`, body: 'a'.repeat(LIVE_INBOX_CHAR_LIMIT - 20) });
    sendMessage(ctx, { from: 'user:bob', to: `agent:${agent.id}`, body: 'second' });
    const first = liveInbox(ctx, 'alice', 'claude', 's-alice');
    expect(first.messages).toHaveLength(1);
    expect(first.more).toBe(1);
    expect(liveInbox(ctx, 'alice', 'claude', 's-alice').messages.map((m) => m.body)).toEqual(['second']);
  });

  test("another user cannot read someone's session inbox", () => {
    const { ctx } = createTestContext();
    session(ctx);
    expect(() => liveInbox(ctx, 'bob', 'claude', 's-alice')).toThrow('another user');
  });
});

describe('stopCheck', () => {
  test('allows stopping when nothing is pending', () => {
    const { ctx } = createTestContext();
    session(ctx);
    expect(stopCheck(ctx, 'alice', { vendor: 'claude', sessionId: 's-alice', stopHookActive: false })).toEqual({ action: 'allow' });
  });

  test('blocks with a short notice and leaves the messages unread', () => {
    const { ctx } = createTestContext();
    const agent = session(ctx);
    sendMessage(ctx, { from: 'user:bob', to: `agent:${agent.id}`, body: 'Please also update the README.' });
    const result = stopCheck(ctx, 'alice', { vendor: 'claude', sessionId: 's-alice', stopHookActive: false });
    if (result.action !== 'block') throw new Error('expected block');
    expect(result.reason).toContain('1 new agflow message');
    expect(result.reason).toContain('check_inbox');
    expect(unreadFor(ctx, agent)).toHaveLength(1);
  });

  test('never blocks a stop that is already a hook-driven continuation', () => {
    const { ctx } = createTestContext();
    const agent = session(ctx);
    sendMessage(ctx, { from: 'user:bob', to: `agent:${agent.id}`, body: 'hi' });
    expect(stopCheck(ctx, 'alice', { vendor: 'claude', sessionId: 's-alice', stopHookActive: true })).toEqual({ action: 'allow' });
  });

  test('reminds a task holder once per reminder interval', () => {
    const { ctx, clock } = createTestContext();
    const agent = session(ctx);
    const [task] = createTasks(ctx, [newTask({ title: 'Parser' })], 'user:alice');
    claimTask(ctx, task.id, agent);
    const input = { vendor: 'claude' as const, sessionId: 's-alice', stopHookActive: false };
    const first = stopCheck(ctx, 'alice', input);
    if (first.action !== 'block') throw new Error('expected block');
    expect(first.reason).toContain(`you hold agflow task ${task.id}`);
    expect(stopCheck(ctx, 'alice', input)).toEqual({ action: 'allow' });
    clock.advance(ctx.config.reminderMs);
    expect(stopCheck(ctx, 'alice', input).action).toBe('block');
  });
});
