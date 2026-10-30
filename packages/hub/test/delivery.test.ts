import { describe, expect, spyOn, test } from 'bun:test';
import { type Attempt, type Message, type RawRunnerEvent, formatMessage } from '@agflow/core';
import { getAgent } from '../src/agents';
import { getAttempt, updateAttempt } from '../src/attempt-store';
import { onSpawned, resumeAttempt, startRunnerAttempt } from '../src/attempts';
import {
  type CommandRow,
  cancelPendingOfKind,
  findCommand,
  markSent,
  pendingCommands,
  recordResult,
} from '../src/commands';
import { type HubContext, tx } from '../src/context';
import {
  DELIVERY_CHAR_LIMIT,
  flushDeliveries,
  messagesInFlight,
  onAcknowledged,
  onDelivered,
  watchDeliveries,
} from '../src/delivery';
import { listEvents } from '../src/events';
import { applyRunnerEvents } from '../src/events-in';
import { type NewMessage, sendMessage, takeInbox, unreadFor } from '../src/messages';
import { claimTask, createTasks } from '../src/tasks';
import { addAgent, addRunner, addRunnerAttempt, addRunnerLead, createTestContext, newTask } from './helpers';

/** Polls until the predicate holds, failing at the deadline; for waits on real timers. */
async function until(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms`);
    await Bun.sleep(5);
  }
}

const SPAWNED = { sessionRef: 's-1', pid: 1, model: 'm', cliVersion: '1', permissionMode: null, startSha: null };

/** The attempt's deliver commands, oldest first. */
function delivers(ctx: HubContext, attempt: Pick<Attempt, 'id' | 'runnerId'>) {
  return pendingCommands(ctx, attempt.runnerId as string, 1)
    .filter((row) => row.command.kind === 'deliver' && row.attemptId === attempt.id)
    .map((row) => row as CommandRow & { command: Extract<CommandRow['command'], { kind: 'deliver' }> });
}

/** The attempt's pending_deliveries rows as [message id, command id]. */
const rowsOf = (ctx: HubContext, attemptId: string) =>
  (
    ctx.db
      .query('SELECT message_id, command_id FROM pending_deliveries WHERE attempt_id = $attemptId ORDER BY message_id')
      .all({ attemptId }) as { message_id: number; command_id: string }[]
  ).map((row) => [row.message_id, row.command_id]);

const deliveriesOf = (ctx: HubContext, agentId: string) =>
  ctx.db
    .query('SELECT message_id, acked_at FROM deliveries WHERE agent_id = $agentId ORDER BY message_id')
    .all({ agentId }) as { message_id: number; acked_at: number | null }[];

const send = (ctx: HubContext, message: NewMessage): Message => sendMessage(ctx, message);

/** A running runner worker, and the clock moved past the batch window of whatever is sent before flush(). */
function setup() {
  const { ctx, clock } = createTestContext();
  const held = addRunnerAttempt(ctx);
  const flush = () => {
    clock.advance(ctx.config.deliveryBatchMs);
    return flushDeliveries(ctx);
  };
  return { ctx, clock, held, flush };
}

describe('flushDeliveries', () => {
  test('a running runner agent gets its unread messages, quoted, with the authority of their sender', () => {
    const { ctx, held, flush } = setup();
    const fromPerson = send(ctx, { from: 'user:alice', to: `agent:${held.agent.id}`, body: 'Use the new API.\nNow.' });
    const fromAgent = send(ctx, { from: 'agent:A-9', to: `task:${held.task.id}`, body: 'I touched lexer.ts.' });
    const fromHub = send(ctx, { from: 'system', to: 'all', body: 'The project is paused.' });
    const { commands } = flush();
    expect(commands).toHaveLength(1);
    const [deliver] = delivers(ctx, held.attempt);
    expect(deliver?.command).toEqual({
      kind: 'deliver',
      attemptId: held.attempt.id,
      fence: held.attempt.fence,
      messages: [
        { messageId: fromPerson.id, authority: 'person', text: formatMessage(fromPerson) },
        { messageId: fromAgent.id, authority: 'agent', text: formatMessage(fromAgent) },
        { messageId: fromHub.id, authority: 'system', text: formatMessage(fromHub) },
      ],
      more: 0,
    });
    expect(deliver?.command.messages[0]?.text).toContain('> Use the new API.\n> Now.');
    expect(rowsOf(ctx, held.attempt.id)).toEqual([
      [fromPerson.id, deliver?.id],
      [fromAgent.id, deliver?.id],
      [fromHub.id, deliver?.id],
    ]);
    // Nothing is left to push.
    expect(flush().commands).toEqual([]);
  });

  test('an attempt in quota_wait gets deliveries too', () => {
    const { ctx, held, flush } = setup();
    updateAttempt(ctx, held.attempt.id, { status: 'quota_wait' });
    send(ctx, { from: 'user:alice', to: `agent:${held.agent.id}`, body: 'Wait for the reset.' });
    expect(flush().commands).toHaveLength(1);
  });

  test('a command holds at most 6000 characters of formatted text; more counts what is left, for the next one', () => {
    expect(DELIVERY_CHAR_LIMIT).toBe(6000);
    for (const over of [0, 1]) {
      const { ctx, held, flush } = setup();
      const to = `agent:${held.agent.id}`;
      const first = send(ctx, { from: 'user:alice', to, body: 'a'.repeat(2500) });
      // The second's header is as long as the first's: the same sender and an id with as many digits.
      const header = formatMessage(first).length - first.body.length;
      const body = 'b'.repeat(DELIVERY_CHAR_LIMIT - formatMessage(first).length - header + over);
      const second = send(ctx, { from: 'user:alice', to, body });
      expect(formatMessage(first).length + formatMessage(second).length).toBe(DELIVERY_CHAR_LIMIT + over);
      flush();
      const [command] = delivers(ctx, held.attempt);
      const counts = [command?.command.messages.length, command?.command.more];
      expect(counts).toEqual(over === 0 ? [2, 0] : [1, 1]);
      if (over === 0) continue;
      flush();
      expect(delivers(ctx, held.attempt).map((row) => row.command.messages.map((m) => m.messageId))).toEqual([
        [first.id],
        [second.id],
      ]);
    }
  });

  test('one message longer than a command can hold goes alone', () => {
    const { ctx, held, flush } = setup();
    send(ctx, { from: 'user:alice', to: `agent:${held.agent.id}`, body: 'x'.repeat(7000) });
    send(ctx, { from: 'user:alice', to: `agent:${held.agent.id}`, body: 'short' });
    flush();
    expect(delivers(ctx, held.attempt).map((row) => [row.command.messages.length, row.command.more])).toEqual([[1, 1]]);
  });

  test('messages wait until the oldest of them is deliveryBatchMs old, so a burst is one command', () => {
    const { ctx, clock, held } = setup();
    const to = `agent:${held.agent.id}`;
    const first = send(ctx, { from: 'user:alice', to, body: 'one' });
    clock.advance(1000);
    const second = send(ctx, { from: 'user:alice', to, body: 'two' });
    clock.advance(500);
    expect(flushDeliveries(ctx)).toEqual({ commands: [], dueAt: first.createdAt + ctx.config.deliveryBatchMs });
    clock.advance(500);
    const { commands, dueAt } = flushDeliveries(ctx);
    expect(dueAt).toBeNull();
    expect(commands.map((row) => row.command.kind === 'deliver' && row.command.messages.length)).toEqual([2]);
    expect(rowsOf(ctx, held.attempt.id).map(([id]) => id)).toEqual([first.id, second.id]);
  });

  test('messages in flight are left out of unreadFor and check_inbox', () => {
    const { ctx, held, flush } = setup();
    send(ctx, { from: 'user:alice', to: `agent:${held.agent.id}`, body: 'one' });
    flush();
    const agent = getAgent(ctx, held.agent.id);
    expect(unreadFor(ctx, agent)).toEqual([]);
    expect(takeInbox(ctx, agent)).toEqual([]);
    // Another agent's inbox is its own.
    const other = addRunnerAttempt(ctx);
    const all = send(ctx, { from: 'user:alice', to: 'all', body: 'everyone' });
    flush();
    expect(rowsOf(ctx, other.attempt.id).map(([id]) => id)).toEqual([all.id]);
    expect(rowsOf(ctx, held.attempt.id).map(([id]) => id)).toContain(all.id);
  });

  test('live chats get nothing pushed and keep their inbox; runner agents still get theirs', () => {
    const { ctx, flush } = setup();
    const live = addAgent(ctx);
    const [task] = createTasks(ctx, [newTask()], 'user:alice');
    claimTask(ctx, task?.id as string, live);
    const runner = addRunnerAttempt(ctx);
    const forLive = send(ctx, { from: 'user:alice', to: `agent:${live.id}`, body: 'for the live chat' });
    const forRunner = send(ctx, { from: 'user:alice', to: `agent:${runner.agent.id}`, body: 'for the runner agent' });
    flush();
    const all = ctx.db.query("SELECT attempt_id FROM runner_commands WHERE kind = 'deliver'").all();
    expect(all).toEqual([{ attempt_id: runner.attempt.id }]);
    expect(delivers(ctx, runner.attempt).map((row) => row.command.messages.map((m) => m.messageId))).toEqual([
      [forRunner.id],
    ]);
    expect(takeInbox(ctx, getAgent(ctx, live.id)).map((message) => message.id)).toEqual([forLive.id]);
  });

  test('one attempt failing to take its delivery leaves the others theirs', () => {
    const { ctx, held, flush } = setup();
    const other = addRunnerAttempt(ctx);
    send(ctx, { from: 'user:alice', to: `agent:${held.agent.id}`, body: 'one' });
    const message = send(ctx, { from: 'user:alice', to: `agent:${other.agent.id}`, body: 'two' });
    ctx.db.run(
      `CREATE TRIGGER no_deliver BEFORE INSERT ON runner_commands WHEN NEW.attempt_id = '${held.attempt.id}'
       BEGIN SELECT RAISE(ABORT, 'the disk is full'); END`,
    );
    const logged = spyOn(console, 'error').mockImplementation(() => {});
    let commands: CommandRow[];
    try {
      ({ commands } = flush());
      expect(logged).toHaveBeenCalledTimes(1);
    } finally {
      logged.mockRestore();
    }
    expect(commands.map((row) => row.attemptId)).toEqual([other.attempt.id]);
    expect(rowsOf(ctx, other.attempt.id).map(([id]) => id)).toEqual([message.id]);
  });

  test('lead messages reach the runner lead that holds the seat, and no worker', () => {
    const { ctx, held, flush } = setup();
    const lead = addRunnerLead(ctx);
    const message = send(ctx, { from: 'user:alice', to: 'lead', body: 'Plan the next step.' });
    flush();
    expect(delivers(ctx, lead.attempt).map((row) => row.command.messages.map((m) => m.messageId))).toEqual([
      [message.id],
    ]);
    expect(delivers(ctx, held.attempt)).toEqual([]);
  });
});

describe('the backlog', () => {
  test('a starting attempt waits for attempt.spawned, which delivers its whole backlog at once', () => {
    const { ctx, flush } = setup();
    const runnerId = addRunner(ctx);
    const [task] = createTasks(ctx, [newTask()], 'user:alice');
    const taskId = task?.id as string;
    const { attempt } = startRunnerAttempt(ctx, { runnerId, taskId, role: 'worker', vendor: 'claude' });
    const message = send(ctx, { from: 'user:alice', to: `agent:${attempt.agentId}`, body: 'Start with the lexer.' });
    flush();
    expect(delivers(ctx, attempt)).toEqual([]);
    const young = send(ctx, { from: 'user:alice', to: `agent:${attempt.agentId}`, body: 'And the tests.' });
    tx(ctx, (emit) => onSpawned(ctx, emit, getAttempt(ctx, attempt.id), SPAWNED));
    expect(delivers(ctx, attempt).map((row) => row.command.messages.map((m) => m.messageId))).toEqual([
      [message.id, young.id],
    ]);
  });

  test('a holding attempt gets nothing pushed', () => {
    const { ctx, held, flush } = setup();
    updateAttempt(ctx, held.attempt.id, { status: 'holding', leaseExpiresAt: null });
    send(ctx, { from: 'user:alice', to: `agent:${held.agent.id}`, body: 'Waiting for you.' });
    expect(flush().commands).toEqual([]);
  });

  test("a resume's messages get rows under the resume's id", () => {
    const { ctx } = setup();
    // A holding lead is resumed with the delivery that wakes it (design 6.11).
    const lead = addRunnerLead(ctx);
    updateAttempt(ctx, lead.attempt.id, { status: 'holding', leaseExpiresAt: null });
    const message = send(ctx, { from: 'user:alice', to: 'lead', body: 'Carried.' });
    const { command } = resumeAttempt(ctx, {
      attemptId: lead.attempt.id,
      cause: 'lead_exit',
      prompt: 'Go on.',
      messages: [{ messageId: message.id, authority: 'person', text: formatMessage(message) }],
    });
    expect(rowsOf(ctx, lead.attempt.id)).toEqual([[message.id, command.id]]);
    expect(unreadFor(ctx, getAgent(ctx, lead.agent.id))).toEqual([]);
  });

  test("a resumed attempt's backlog on spawned leaves out what its resume carried", () => {
    const { ctx, held, flush } = setup();
    const to = `agent:${held.agent.id}`;
    const carried = send(ctx, { from: 'user:alice', to, body: 'In flight at the old fence.' });
    flush();
    const { command: resume } = resumeAttempt(ctx, {
      attemptId: held.attempt.id,
      cause: 'runner_restart',
      prompt: 'Go on.',
    });
    const later = send(ctx, { from: 'user:alice', to, body: 'Sent while it restarts.' });
    tx(ctx, (emit) => onSpawned(ctx, emit, getAttempt(ctx, held.attempt.id), SPAWNED));
    const backlog = delivers(ctx, held.attempt);
    expect(backlog.map((row) => row.command.messages.map((m) => m.messageId))).toEqual([[later.id]]);
    expect(rowsOf(ctx, held.attempt.id)).toEqual([
      [carried.id, resume.id],
      [later.id, backlog[0]?.id],
    ]);
  });

  test('a holding attempt gets the messages it missed when its resume is spawned', () => {
    const { ctx, held, flush } = setup();
    updateAttempt(ctx, held.attempt.id, { status: 'holding', leaseExpiresAt: null });
    const missed = send(ctx, { from: 'user:alice', to: `agent:${held.agent.id}`, body: 'While you waited.' });
    expect(flush().commands).toEqual([]);
    resumeAttempt(ctx, { attemptId: held.attempt.id, cause: 'review', prompt: 'The review asks for changes.' });
    tx(ctx, (emit) => onSpawned(ctx, emit, getAttempt(ctx, held.attempt.id), SPAWNED));
    expect(delivers(ctx, held.attempt).map((row) => row.command.messages.map((m) => m.messageId))).toEqual([
      [missed.id],
    ]);
  });

  test('a new fence carries the messages in flight in its resume and re-targets their rows', () => {
    const { ctx, held, flush } = setup();
    const message = send(ctx, { from: 'user:alice', to: `agent:${held.agent.id}`, body: 'In flight.' });
    flush();
    const [deliver] = delivers(ctx, held.attempt);
    expect(messagesInFlight(ctx, held.attempt.id)).toEqual([
      { messageId: message.id, authority: 'person', text: formatMessage(message) },
    ]);
    const { command } = resumeAttempt(ctx, { attemptId: held.attempt.id, cause: 'runner_restart', prompt: 'Go on.' });
    expect(findCommand(ctx, deliver?.id as string)?.status).toBe('cancelled');
    expect(command.command.kind === 'resume_attempt' && command.command.messages).toEqual([
      { messageId: message.id, authority: 'person', text: formatMessage(message) },
    ]);
    expect(rowsOf(ctx, held.attempt.id)).toEqual([[message.id, command.id]]);
  });
});

describe('delivered and acknowledged', () => {
  test('attempt.delivered records deliveries and drops the rows; attempt.acknowledged sets acked_at', () => {
    const { ctx, clock, held, flush } = setup();
    const first = send(ctx, { from: 'user:alice', to: `agent:${held.agent.id}`, body: 'one' });
    const second = send(ctx, { from: 'user:alice', to: `agent:${held.agent.id}`, body: 'two' });
    flush();
    const attempt = getAttempt(ctx, held.attempt.id);
    // Id 0 is hub text with no message row.
    tx(ctx, (emit) => onDelivered(ctx, emit, attempt, [0, first.id]));
    expect(deliveriesOf(ctx, held.agent.id)).toEqual([{ message_id: first.id, acked_at: null }]);
    expect(rowsOf(ctx, held.attempt.id).map(([id]) => id)).toEqual([second.id]);
    clock.advance(1000);
    // Acknowledged implies delivered.
    tx(ctx, (emit) => onAcknowledged(ctx, emit, attempt, [0, first.id, second.id]));
    expect(deliveriesOf(ctx, held.agent.id)).toEqual([
      { message_id: first.id, acked_at: ctx.now() },
      { message_id: second.id, acked_at: ctx.now() },
    ]);
    expect(rowsOf(ctx, held.attempt.id)).toEqual([]);
    const types = listEvents(ctx.db).map((event) => event.type);
    expect(types).toContain('message.delivered');
    expect(types).toContain('message.acknowledged');
  });

  test("ids the attempt has no delivery in flight for are ignored, and other agents' deliveries stay", () => {
    const { ctx, held } = setup();
    const other = addRunnerAttempt(ctx);
    const message = send(ctx, { from: 'user:alice', to: `agent:${other.agent.id}`, body: 'not yours' });
    takeInbox(ctx, getAgent(ctx, other.agent.id));
    tx(ctx, (emit) => onDelivered(ctx, emit, getAttempt(ctx, held.attempt.id), [message.id, 12345]));
    tx(ctx, (emit) => onAcknowledged(ctx, emit, getAttempt(ctx, held.attempt.id), [message.id]));
    expect(deliveriesOf(ctx, held.agent.id)).toEqual([]);
    expect(deliveriesOf(ctx, other.agent.id)).toEqual([{ message_id: message.id, acked_at: null }]);
    const acknowledged = listEvents(ctx.db).filter((event) => event.type === 'message.acknowledged');
    expect(acknowledged).toEqual([]);
  });

  test('the runner reports them as attempt events, an id 0 among them', () => {
    const { ctx, held, flush } = setup();
    const message = send(ctx, { from: 'user:alice', to: `agent:${held.agent.id}`, body: 'one' });
    flush();
    const { id: attemptId, fence } = held.attempt;
    const events: RawRunnerEvent[] = [
      { seq: 1, at: 0, type: 'attempt.delivered', attemptId, fence, data: { messageIds: [0, message.id] } },
      { seq: 2, at: 0, type: 'attempt.acknowledged', attemptId, fence, data: { messageIds: [message.id, 0] } },
    ];
    applyRunnerEvents(ctx, held.runner.id, { outboxEpoch: 'outbox-1', events }, { restoreReplay: false });
    expect(ctx.db.query('SELECT type, error FROM runner_event_rejects').all()).toEqual([]);
    expect(deliveriesOf(ctx, held.agent.id)).toEqual([{ message_id: message.id, acked_at: ctx.now() }]);
  });

  test('a cancelled deliver frees its rows, and its messages are unread again', () => {
    const { ctx, held, flush } = setup();
    const message = send(ctx, { from: 'user:alice', to: `agent:${held.agent.id}`, body: 'one' });
    flush();
    cancelPendingOfKind(ctx, held.attempt.id, 'deliver');
    expect(rowsOf(ctx, held.attempt.id)).toEqual([]);
    expect(unreadFor(ctx, getAgent(ctx, held.agent.id)).map((unread) => unread.id)).toEqual([message.id]);
  });
});

describe('refused delivers', () => {
  test('a deliver the runner refuses before sending frees its rows; its messages are unread again', () => {
    for (const error of ['not_running', 'stale_fence']) {
      const { ctx, held, flush } = setup();
      const message = send(ctx, { from: 'user:alice', to: `agent:${held.agent.id}`, body: 'one' });
      flush();
      const [deliver] = delivers(ctx, held.attempt);
      markSent(ctx, deliver?.id as string);
      recordResult(ctx, held.runner.id, { commandId: deliver?.id as string, ok: false, error });
      expect(findCommand(ctx, deliver?.id as string)?.status).toBe('failed');
      expect(rowsOf(ctx, held.attempt.id)).toEqual([]);
      expect(unreadFor(ctx, getAgent(ctx, held.agent.id)).map((unread) => unread.id)).toEqual([message.id]);
    }
  });

  test('other failures keep the rows: the messages may have been injected in part', () => {
    const { ctx, held, flush } = setup();
    const message = send(ctx, { from: 'user:alice', to: `agent:${held.agent.id}`, body: 'one' });
    flush();
    const [deliver] = delivers(ctx, held.attempt);
    recordResult(ctx, held.runner.id, { commandId: deliver?.id as string, ok: false, error: 'interrupted' });
    expect(rowsOf(ctx, held.attempt.id)).toEqual([[message.id, deliver?.id]]);
    expect(unreadFor(ctx, getAgent(ctx, held.agent.id))).toEqual([]);
  });
});

describe('watchDeliveries', () => {
  test('a sent message is pushed once its batch window has passed', async () => {
    const { ctx, clock } = createTestContext({ deliveryBatchMs: 20 });
    const held = addRunnerAttempt(ctx);
    const stop = watchDeliveries(ctx);
    try {
      send(ctx, { from: 'user:alice', to: `agent:${held.agent.id}`, body: 'one' });
      expect(delivers(ctx, held.attempt)).toEqual([]);
      clock.advance(20);
      await Bun.sleep(60);
      expect(delivers(ctx, held.attempt)).toHaveLength(1);
    } finally {
      stop();
    }
  });

  test('a batch not yet due is scheduled again, and nothing runs once stopped', async () => {
    const { ctx, clock } = createTestContext({ deliveryBatchMs: 20 });
    const first = addRunnerAttempt(ctx);
    const second = addRunnerAttempt(ctx);
    const stop = watchDeliveries(ctx);
    try {
      send(ctx, { from: 'user:alice', to: `agent:${first.agent.id}`, body: 'one' });
      clock.advance(10);
      send(ctx, { from: 'user:alice', to: `agent:${second.agent.id}`, body: 'two' });
      clock.advance(10);
      await until(() => delivers(ctx, first.attempt).length === 1);
      expect(delivers(ctx, second.attempt)).toEqual([]);
      clock.advance(10);
      await until(() => delivers(ctx, second.attempt).length === 1);
    } finally {
      stop();
    }
    send(ctx, { from: 'user:alice', to: `agent:${first.agent.id}`, body: 'three' });
    clock.advance(20);
    await Bun.sleep(60);
    expect(delivers(ctx, first.attempt)).toHaveLength(1);
  });
});
