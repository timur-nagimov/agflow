import { describe, expect, test } from 'bun:test';
import { getAgent } from '../src/agents';
import type { HubContext } from '../src/context';
import { HubError } from '../src/errors';
import {
  ackMessages,
  listMessages,
  listStandingRules,
  removeStandingRule,
  sendMessage,
  takeInbox,
  unreadFor,
} from '../src/messages';
import { addAgent, createTestContext } from './helpers';

function insertBareTask(ctx: HubContext, id: string): void {
  ctx.db
    .query(
      `INSERT INTO tasks (id, seq, status, contract, goal_version, created_by, created_at, updated_at)
       VALUES ($id, $seq, 'ready', '{}', 0, 'system', 0, 0)`,
    )
    .run({ id, seq: Number(id.slice(2)) });
}

describe('delivery rules', () => {
  test('a message to an agent is delivered once', () => {
    const { ctx } = createTestContext();
    const agent = addAgent(ctx);
    sendMessage(ctx, { from: 'user:alice', to: `agent:${agent.id}`, body: 'Use pnpm.' });
    expect(takeInbox(ctx, agent).map((m) => m.body)).toEqual(['Use pnpm.']);
    expect(takeInbox(ctx, agent)).toEqual([]);
  });

  test('a lead message waits for a lead and goes to the first lead that reads it', () => {
    const { ctx } = createTestContext();
    sendMessage(ctx, { from: 'system', to: 'lead', body: 'Plan the goal.' });
    const lead = addAgent(ctx, 'alice', 'lead');
    expect(takeInbox(ctx, lead).map((m) => m.body)).toEqual(['Plan the goal.']);
    expect(takeInbox(ctx, lead)).toEqual([]);
  });

  test('broadcasts reach agents that existed when they were sent', () => {
    const { ctx, clock } = createTestContext();
    const early = addAgent(ctx);
    clock.advance(1000);
    sendMessage(ctx, { from: 'user:alice', to: 'all', body: 'Freeze merges.' });
    clock.advance(1000);
    const late = addAgent(ctx, 'bob');
    expect(takeInbox(ctx, early).map((m) => m.body)).toEqual(['Freeze merges.']);
    expect(takeInbox(ctx, late)).toEqual([]);
  });

  test('task messages reach whoever holds the task', () => {
    const { ctx } = createTestContext();
    insertBareTask(ctx, 'T-1');
    const holder = addAgent(ctx);
    const other = addAgent(ctx, 'bob');
    ctx.db.query("UPDATE agents SET current_task = 'T-1' WHERE id = $id").run({ id: holder.id });
    sendMessage(ctx, { from: 'user:alice', to: 'task:T-1', body: 'Check the edge case.' });
    expect(takeInbox(ctx, getAgent(ctx, holder.id)).map((m) => m.taskId)).toEqual(['T-1']);
    expect(takeInbox(ctx, other)).toEqual([]);
  });

  test('agents do not receive their own messages', () => {
    const { ctx } = createTestContext();
    const lead = addAgent(ctx, 'alice', 'lead');
    sendMessage(ctx, { from: `agent:${lead.id}`, to: 'all', body: 'Hello team.' });
    expect(unreadFor(ctx, lead)).toEqual([]);
  });

  test('humans messages are never delivered to agents', () => {
    const { ctx } = createTestContext();
    const lead = addAgent(ctx, 'alice', 'lead');
    sendMessage(ctx, { from: 'system', to: 'humans', body: 'Need a decision.' });
    expect(unreadFor(ctx, lead)).toEqual([]);
  });
});

describe('validation, acknowledgement and listing', () => {
  test('unknown targets are rejected', () => {
    const { ctx } = createTestContext();
    expect(() => sendMessage(ctx, { from: 'user:alice', to: 'agent:A-99', body: 'x' })).toThrow(HubError);
    expect(() => sendMessage(ctx, { from: 'user:alice', to: 'nobody', body: 'x' })).toThrow('unknown message target');
  });

  test('acknowledging sets acked times visible in listings', () => {
    const { ctx } = createTestContext();
    const agent = addAgent(ctx);
    const message = sendMessage(ctx, { from: 'user:alice', to: `agent:${agent.id}`, body: 'ping' });
    takeInbox(ctx, agent);
    ackMessages(ctx, agent, [message.id]);
    const [view] = listMessages(ctx);
    expect(view?.deliveries).toHaveLength(1);
    expect(view?.deliveries[0]?.ackedAt).not.toBeNull();
  });

  test('listMessages filters by task, newest first', () => {
    const { ctx } = createTestContext();
    insertBareTask(ctx, 'T-1');
    sendMessage(ctx, { from: 'user:alice', to: 'lead', body: 'general' });
    sendMessage(ctx, { from: 'user:alice', to: 'task:T-1', body: 'first' });
    sendMessage(ctx, { from: 'user:alice', to: 'lead', taskId: 'T-1', body: 'second' });
    expect(listMessages(ctx, { taskId: 'T-1' }).map((m) => m.body)).toEqual(['second', 'first']);
  });
});

describe('standing rules', () => {
  test('are listed until removed', () => {
    const { ctx } = createTestContext();
    const rule = sendMessage(ctx, { from: 'user:alice', to: 'all', body: 'Always use pnpm.', standingRule: true });
    expect(listStandingRules(ctx).map((m) => m.body)).toEqual(['Always use pnpm.']);
    removeStandingRule(ctx, rule.id, 'user:alice');
    expect(listStandingRules(ctx)).toEqual([]);
    expect(() => removeStandingRule(ctx, rule.id, 'user:alice')).toThrow(HubError);
  });
});
