import { type Agent, type Message, type MessageView, parseTarget } from '@agflow/core';
import { type HubContext, tx } from './context';
import type { Emit } from './events';
import { badRequest, notFound } from './errors';

export interface MessageRow {
  id: number;
  sender: string;
  target: string;
  body: string;
  task_id: string | null;
  reply_to: number | null;
  standing_rule: number;
  rule_active: number;
  created_at: number;
}

export function rowToMessage(row: MessageRow): Message {
  return {
    id: row.id,
    from: row.sender,
    to: row.target,
    body: row.body,
    taskId: row.task_id,
    replyTo: row.reply_to,
    standingRule: row.standing_rule === 1,
    ruleActive: row.rule_active === 1,
    createdAt: row.created_at,
  };
}

export interface NewMessage {
  from: string;
  to: string;
  body: string;
  taskId?: string | null | undefined;
  replyTo?: number | null | undefined;
  standingRule?: boolean | undefined;
}

const exists = (ctx: HubContext, table: 'agents' | 'tasks' | 'messages', id: string | number) =>
  ctx.db.query(`SELECT 1 FROM ${table} WHERE id = $id`).get({ id }) !== null;

export function insertMessage(ctx: HubContext, emit: Emit, message: NewMessage): Message {
  const target = parseTarget(message.to);
  if (!target) throw badRequest(`unknown message target ${message.to}`);
  if (target.kind === 'agent' && !exists(ctx, 'agents', target.id)) throw notFound(`agent ${target.id}`);
  if (target.kind === 'task' && !exists(ctx, 'tasks', target.id)) throw notFound(`task ${target.id}`);
  if (message.taskId && !exists(ctx, 'tasks', message.taskId)) throw notFound(`task ${message.taskId}`);
  if (message.replyTo != null && !exists(ctx, 'messages', message.replyTo)) throw notFound(`message ${message.replyTo}`);
  const taskId = message.taskId ?? (target.kind === 'task' ? target.id : null);
  const rule = message.standingRule === true ? 1 : 0;
  const row = ctx.db
    .query(
      `INSERT INTO messages (sender, target, body, task_id, reply_to, standing_rule, rule_active, created_at)
       VALUES ($sender, $target, $body, $taskId, $replyTo, $rule, $rule, $now) RETURNING *`,
    )
    .get({
      sender: message.from,
      target: message.to,
      body: message.body,
      taskId,
      replyTo: message.replyTo ?? null,
      rule,
      now: ctx.now(),
    }) as MessageRow;
  const stored = rowToMessage(row);
  emit({
    type: 'message.sent',
    actor: message.from,
    subject: taskId,
    data: { id: stored.id, to: message.to, standingRule: stored.standingRule },
  });
  return stored;
}

export function sendMessage(ctx: HubContext, message: NewMessage): Message {
  return tx(ctx, (emit) => insertMessage(ctx, emit, message));
}

const UNREAD_SQL = `
SELECT m.* FROM messages m
WHERE m.sender != $self AND (
  (m.target = $self AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.message_id = m.id AND d.agent_id = $id))
  OR ($isLead = 1 AND m.target = 'lead' AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.message_id = m.id))
  OR ($taskTarget IS NOT NULL AND m.target = $taskTarget
      AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.message_id = m.id AND d.agent_id = $id))
  OR (m.target = 'all' AND m.created_at >= $createdAt
      AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.message_id = m.id AND d.agent_id = $id))
)
ORDER BY m.id`;

export function unreadFor(ctx: HubContext, agent: Agent): Message[] {
  const rows = ctx.db.query(UNREAD_SQL).all({
    self: `agent:${agent.id}`,
    id: agent.id,
    isLead: agent.role === 'lead' ? 1 : 0,
    taskTarget: agent.currentTask ? `task:${agent.currentTask}` : null,
    createdAt: agent.createdAt,
  }) as MessageRow[];
  return rows.map(rowToMessage);
}

export function markDelivered(ctx: HubContext, emit: Emit, agentId: string, ids: number[]): void {
  if (ids.length === 0) return;
  const insert = ctx.db.query(
    'INSERT OR IGNORE INTO deliveries (message_id, agent_id, delivered_at, acked_at) VALUES ($messageId, $agentId, $now, NULL)',
  );
  for (const messageId of ids) insert.run({ messageId, agentId, now: ctx.now() });
  emit({ type: 'message.delivered', actor: `agent:${agentId}`, data: { ids } });
}

/** Returns all unread messages for the agent and marks them delivered. */
export function takeInbox(ctx: HubContext, agent: Agent): Message[] {
  return tx(ctx, (emit) => {
    const messages = unreadFor(ctx, agent);
    markDelivered(ctx, emit, agent.id, messages.map((message) => message.id));
    return messages;
  });
}

export function ackMessages(ctx: HubContext, agent: Agent, ids: number[]): void {
  tx(ctx, (emit) => {
    const update = ctx.db.query(
      'UPDATE deliveries SET acked_at = $now WHERE message_id = $messageId AND agent_id = $agentId AND acked_at IS NULL',
    );
    for (const messageId of ids) update.run({ now: ctx.now(), messageId, agentId: agent.id });
    emit({ type: 'message.acknowledged', actor: `agent:${agent.id}`, data: { ids } });
  });
}

export interface MessageFilter {
  taskId?: string | undefined;
  target?: string | undefined;
  limit?: number | undefined;
}

export function listMessages(ctx: HubContext, filter: MessageFilter = {}): MessageView[] {
  const limit = Math.max(1, Math.min(filter.limit ?? 100, 500));
  const rows = ctx.db
    .query(
      `SELECT * FROM messages WHERE ($taskId IS NULL OR task_id = $taskId) AND ($target IS NULL OR target = $target)
       ORDER BY id DESC LIMIT $limit`,
    )
    .all({ taskId: filter.taskId ?? null, target: filter.target ?? null, limit }) as MessageRow[];
  const deliveries = ctx.db.query('SELECT agent_id, delivered_at, acked_at FROM deliveries WHERE message_id = $messageId');
  return rows.map((row) => ({
    ...rowToMessage(row),
    deliveries: (deliveries.all({ messageId: row.id }) as { agent_id: string; delivered_at: number; acked_at: number | null }[]).map(
      (delivery) => ({ agentId: delivery.agent_id, deliveredAt: delivery.delivered_at, ackedAt: delivery.acked_at }),
    ),
  }));
}

export function listStandingRules(ctx: HubContext): Message[] {
  const rows = ctx.db
    .query('SELECT * FROM messages WHERE standing_rule = 1 AND rule_active = 1 ORDER BY id')
    .all() as MessageRow[];
  return rows.map(rowToMessage);
}

export function removeStandingRule(ctx: HubContext, id: number, actor: string): void {
  tx(ctx, (emit) => {
    const result = ctx.db
      .query('UPDATE messages SET rule_active = 0 WHERE id = $id AND standing_rule = 1 AND rule_active = 1')
      .run({ id });
    if (result.changes === 0) throw notFound(`standing rule ${id}`);
    emit({ type: 'rule.removed', actor, data: { id } });
  });
}
