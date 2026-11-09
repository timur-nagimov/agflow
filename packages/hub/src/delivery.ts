// Message delivery to runner agents (design 6.7). The hub pushes a runner agent's unread messages to its runner in
// deliver commands, and a pending_deliveries row per message keeps each one out of the agent's unreadFor and
// check_inbox while it is in flight. attempt.delivered turns a row into M1's delivery record; attempt.acknowledged
// marks it acknowledged.
import { type Attempt, type AttemptStatus, type InjectedMessage, type Message, formatMessage } from '@agflow/core';
import { getAgent } from './agents';
import { getAttempt } from './attempt-store';
import { type CommandRow, RESULT_HANDLERS, enqueueCommand } from './commands';
import { type HubContext, tx } from './context';
import type { Emit } from './events';
import { type MessageRow, insertMessage, markDelivered, rowToMessage, unreadFor } from './messages';

/** The most characters of message text one deliver command carries (design 6.7, Batching). */
export const DELIVERY_CHAR_LIMIT = 6000;

/** Runner attempts that take deliveries; starting ones wait for attempt.spawned, holding ones for their resume. */
const DELIVERABLE: readonly AttemptStatus[] = ['running', 'quota_wait'];

/** Whether the hub pushes messages to this attempt now: from stop_requested on, nothing (design 6.7, Endings). */
function deliverable(attempt: Attempt): boolean {
  return attempt.runnerId !== null && DELIVERABLE.includes(attempt.status) && attempt.stopRequested === null;
}

/** Who a message's authority is: people, the hub, or agents (design 6.7, Authority). */
function authorityOf(sender: string): InjectedMessage['authority'] {
  if (sender === 'system') return 'system';
  return sender.startsWith('user:') ? 'person' : 'agent';
}

/** A message as a runner injects it, formatted with M1's quoting rules. */
export function injectedMessage(message: Message): InjectedMessage {
  return { messageId: message.id, authority: authorityOf(message.from), text: formatMessage(message) };
}

/**
 * The messages that fit in one command, in order, and how many are left over. The first always goes, however long:
 * a message the limit alone cannot hold would otherwise never be pushed.
 */
function fitBatch(messages: readonly Message[]): { batch: InjectedMessage[]; more: number } {
  const batch: InjectedMessage[] = [];
  let size = 0;
  for (const message of messages) {
    const injected = injectedMessage(message);
    if (batch.length > 0 && size + injected.text.length > DELIVERY_CHAR_LIMIT) break;
    batch.push(injected);
    size += injected.text.length;
  }
  return { batch, more: messages.length - batch.length };
}

/** Records the messages as in flight to the attempt under the command that carries them. */
function addRows(ctx: HubContext, attemptId: string, commandId: string, messages: readonly InjectedMessage[]): void {
  const insert = ctx.db.query(
    `INSERT OR REPLACE INTO pending_deliveries (message_id, attempt_id, command_id, created_at)
     VALUES ($messageId, $attemptId, $commandId, $now)`,
  );
  for (const message of messages) {
    // Id 0 is hub text with no message row.
    if (message.messageId === 0) continue;
    insert.run({ messageId: message.messageId, attemptId, commandId, now: ctx.now() });
  }
}

/** Sends the messages that fit in one deliver command at the attempt's fence; more counts the rest. */
function deliver(ctx: HubContext, attempt: Attempt, unread: readonly Message[]): CommandRow {
  const { batch, more } = fitBatch(unread);
  const command = enqueueCommand(ctx, attempt.runnerId as string, {
    kind: 'deliver',
    attemptId: attempt.id,
    fence: attempt.fence,
    messages: batch,
    more,
  });
  addRows(ctx, attempt.id, command.id, batch);
  return command;
}

/**
 * Delivers the attempt's whole unread backlog at once, as it enters running (design 6.7, Backlog): what is in flight
 * already, such as the messages its resume carried, is left out by unreadFor. Null when nothing is unread or the
 * attempt takes no deliveries.
 */
export function deliverBacklog(ctx: HubContext, attempt: Attempt): CommandRow | null {
  if (!deliverable(attempt)) return null;
  const unread = unreadFor(ctx, getAgent(ctx, attempt.agentId));
  return unread.length === 0 ? null : deliver(ctx, attempt, unread);
}

export interface FlushResult {
  /** The deliver commands queued, one per attempt at most. */
  commands: CommandRow[];
  /** When the earliest batch still waiting is due; null when none waits. */
  dueAt: number | null;
}

/**
 * Wakes a holding runner lead for its unread messages (lead.ts's wakeHoldingLead): it resumes the lead with them, or
 * ends it lost when it cannot be resumed. Returns the resume_attempt, or null. delivery.ts takes it as an argument,
 * since lead.ts resumes through attempts.ts, which imports this module.
 */
export type HoldingLeadWaker = (attempt: Attempt, unread: readonly Message[]) => CommandRow | null;

/**
 * Pushes unread messages to every runner attempt that takes deliveries, batched (design 6.7, Batching): an attempt's
 * messages wait until the oldest of them is deliveryBatchMs old, and then go together, so a burst is one command.
 * With wake, a holding runner lead's batch wakes it instead (design 6.11): its delivery is its resume. Each attempt's
 * delivery is its own transaction.
 */
export function flushDeliveries(ctx: HubContext, wake?: HoldingLeadWaker): FlushResult {
  const statuses = DELIVERABLE.map((status) => `'${status}'`).join(', ');
  const holding = wake ? "OR (status = 'holding' AND role = 'lead')" : '';
  const ids = ctx.db
    .query(
      `SELECT id FROM attempts
       WHERE runner_id IS NOT NULL AND (status IN (${statuses}) ${holding}) AND stop_requested IS NULL ORDER BY rowid`,
    )
    .all() as { id: string }[];
  const commands: CommandRow[] = [];
  let dueAt: number | null = null;
  for (const { id } of ids) {
    // One attempt failing to take its delivery must not hold up the others.
    try {
      const command = tx(ctx, () => {
        const attempt = getAttempt(ctx, id);
        const wakes = wake !== undefined && attempt.status === 'holding' && attempt.stopRequested === null;
        if (!wakes && !deliverable(attempt)) return null;
        const unread = unreadFor(ctx, getAgent(ctx, attempt.agentId));
        if (unread.length === 0) return null;
        const due = Math.min(...unread.map((message) => message.createdAt)) + ctx.config.deliveryBatchMs;
        if (due > ctx.now()) {
          dueAt = dueAt === null ? due : Math.min(dueAt, due);
          return null;
        }
        return wakes ? wake(attempt, unread) : deliver(ctx, attempt, unread);
      });
      if (command) commands.push(command);
    } catch (error) {
      console.error(`delivering to attempt ${id} failed`, error);
    }
  }
  return { commands, dueAt };
}

/** Refusals a runner answers before it injects anything: the deliver's messages reached no session. */
const REFUSED_BEFORE_SENDING: ReadonlySet<string> = new Set(['not_running', 'stale_fence']);

/**
 * A deliver the runner refused before sending frees its rows, so its messages are unread again for the next flush,
 * the next backlog or a holding lead's wake-up. Other failures, such as interrupted, may follow a partial injection
 * and keep their rows until the ending or a new fence settles them.
 */
RESULT_HANDLERS.deliver = (ctx, _emit, command, result) => {
  if (result.ok || result.error === undefined || !REFUSED_BEFORE_SENDING.has(result.error)) return;
  ctx.db.query('DELETE FROM pending_deliveries WHERE command_id = $commandId').run({ commandId: command.id });
};

/**
 * The messages in flight to the attempt, formatted, oldest first: a new fence carries them in its resume_attempt
 * (design 6.7, Backlog), as the runner may never have injected them at the old one.
 */
export function messagesInFlight(ctx: HubContext, attemptId: string): InjectedMessage[] {
  const rows = ctx.db
    .query(
      `SELECT m.* FROM messages m JOIN pending_deliveries p ON p.message_id = m.id
       WHERE p.attempt_id = $attemptId ORDER BY m.id`,
    )
    .all({ attemptId }) as MessageRow[];
  return rows.map((row) => injectedMessage(rowToMessage(row)));
}

/**
 * The messages delivered to the agent that it has not acknowledged, formatted, oldest first: a lead whose process
 * exited in a turn is resumed with them (design 6.11, Process exits).
 */
export function unacknowledgedDeliveries(ctx: HubContext, agentId: string): InjectedMessage[] {
  const rows = ctx.db
    .query(
      `SELECT m.* FROM messages m JOIN deliveries d ON d.message_id = m.id
       WHERE d.agent_id = $agentId AND d.acked_at IS NULL ORDER BY m.id`,
    )
    .all({ agentId }) as MessageRow[];
  return rows.map((row) => injectedMessage(rowToMessage(row)));
}

/**
 * Re-targets the attempt's deliveries to the resume_attempt that carries its messages at a new fence: its rows are
 * now exactly those messages, under the resume's command id.
 */
export function retargetDeliveries(
  ctx: HubContext,
  attemptId: string,
  commandId: string,
  messages: readonly InjectedMessage[],
): void {
  ctx.db.query('DELETE FROM pending_deliveries WHERE attempt_id = $attemptId').run({ attemptId });
  addRows(ctx, attemptId, commandId, messages);
}

/** The reported ids that are in flight to the attempt; id 0 and anything else is ignored (X-4). */
function inFlightIds(ctx: HubContext, attemptId: string, messageIds: readonly number[]): number[] {
  const inFlight = ctx.db.query('SELECT 1 FROM pending_deliveries WHERE attempt_id = $attemptId AND message_id = $id');
  return [...new Set(messageIds)].filter((id) => id !== 0 && inFlight.get({ attemptId, id }) !== null);
}

/** attempt.delivered: the vendor accepted the input, so M1's delivery record is written and the rows go. */
export function onDelivered(ctx: HubContext, emit: Emit, attempt: Attempt, messageIds: readonly number[]): void {
  const ids = inFlightIds(ctx, attempt.id, messageIds);
  if (ids.length === 0) return;
  markDelivered(ctx, emit, attempt.agentId, ids);
  const drop = ctx.db.query('DELETE FROM pending_deliveries WHERE attempt_id = $attemptId AND message_id = $id');
  for (const id of ids) drop.run({ attemptId: attempt.id, id });
}

/**
 * attempt.acknowledged: the turn that consumed the messages ended. An acknowledgement whose delivery report has not
 * been applied counts as one too.
 */
export function onAcknowledged(ctx: HubContext, emit: Emit, attempt: Attempt, messageIds: readonly number[]): void {
  onDelivered(ctx, emit, attempt, messageIds);
  const delivered = ctx.db.query('SELECT 1 FROM deliveries WHERE message_id = $id AND agent_id = $agentId');
  const ids = [...new Set(messageIds)].filter(
    (id) => id !== 0 && delivered.get({ id, agentId: attempt.agentId }) !== null,
  );
  if (ids.length === 0) return;
  const ack = ctx.db.query(
    'UPDATE deliveries SET acked_at = $now WHERE message_id = $id AND agent_id = $agentId AND acked_at IS NULL',
  );
  for (const id of ids) ack.run({ now: ctx.now(), id, agentId: attempt.agentId });
  emit({ type: 'message.acknowledged', actor: `agent:${attempt.agentId}`, data: { ids } });
}

/**
 * What a worker never acknowledged, oldest first: messages delivered to its agent with no acknowledgement, those in
 * flight to the attempt, and those it never got that were sent to the agent itself or to everyone since it was made
 * (unreadFor's rule; a successor is a new agent, so a broadcast it predates would reach nobody). Its task's own
 * thread is left out: the successor reads that anyway.
 */
const UNACKNOWLEDGED_SQL = `
SELECT m.* FROM messages m
WHERE m.target != $thread AND m.sender != $self AND (
  EXISTS (SELECT 1 FROM deliveries d WHERE d.message_id = m.id AND d.agent_id = $agentId AND d.acked_at IS NULL)
  OR EXISTS (SELECT 1 FROM pending_deliveries p WHERE p.message_id = m.id AND p.attempt_id = $attemptId)
  OR ((m.target = $self OR (m.target = 'all' AND m.created_at >= $createdAt))
    AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.message_id = m.id AND d.agent_id = $agentId))
)
ORDER BY m.id`;

/**
 * Settles a runner attempt's deliveries as it ends (design 6.7, Endings), before the ending's cancel frees the rows
 * of its pending commands. A worker's unacknowledged messages are copied, from their sender, to its task's thread
 * (task:<id>), so the successor reads them. A lead's unacknowledged deliveries of lead messages are deleted, so the
 * next seat holder gets them unread. Either way the attempt's rows go.
 */
export function settleDeliveriesOnEnd(ctx: HubContext, emit: Emit, attempt: Attempt): void {
  if (attempt.runnerId === null) return;
  const { agentId, taskId } = attempt;
  if (taskId !== null) {
    const thread = `task:${taskId}`;
    const { createdAt } = getAgent(ctx, agentId);
    const rows = ctx.db
      .query(UNACKNOWLEDGED_SQL)
      .all({ thread, self: `agent:${agentId}`, agentId, attemptId: attempt.id, createdAt }) as MessageRow[];
    for (const row of rows) insertMessage(ctx, emit, { from: row.sender, to: thread, body: row.body, taskId });
  } else {
    ctx.db
      .query(
        `DELETE FROM deliveries WHERE agent_id = $agentId AND acked_at IS NULL
           AND message_id IN (SELECT id FROM messages WHERE target = 'lead')`,
      )
      .run({ agentId });
  }
  ctx.db.query('DELETE FROM pending_deliveries WHERE attempt_id = $attemptId').run({ attemptId: attempt.id });
}

/**
 * Runs flushDeliveries when a sent message's batch is due, and again for as long as batches wait, waking holding
 * leads with wake. Returns the stop function. startHub runs it with its timers; the hub's housekeeping also flushes,
 * in case a timer's run failed.
 */
export function watchDeliveries(ctx: HubContext, wake?: HoldingLeadWaker): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const schedule = (delayMs: number) => {
    if (timer !== null || stopped) return;
    timer = setTimeout(run, Math.max(1, delayMs));
  };
  function run(): void {
    timer = null;
    try {
      const { dueAt } = flushDeliveries(ctx, wake);
      if (dueAt !== null) schedule(dueAt - ctx.now());
    } catch (error) {
      console.error('the delivery flush failed', error);
    }
  }
  const unsubscribe = ctx.bus.subscribe((event) => {
    if (event.type === 'message.sent') schedule(ctx.config.deliveryBatchMs);
  });
  return () => {
    stopped = true;
    unsubscribe();
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
}
