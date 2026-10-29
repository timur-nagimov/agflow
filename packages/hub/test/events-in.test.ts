import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { type Fence, type RawRunnerEvent, type RunnerEventType, formatFence } from '@agflow/core';
import { appendAttemptLog, attemptLog, updateAttempt } from '../src/attempt-store';
import { createSession, sessionHashOf } from '../src/auth';
import { findCommand, pendingCommands } from '../src/commands';
import { tx } from '../src/context';
import { listEvents } from '../src/events';
import {
  EVENT_HANDLERS,
  type EventContext,
  type EventHandler,
  STALE_EVENT_TYPES,
  applyRunnerEvents,
} from '../src/events-in';
import { Gateway, type LinkSocket } from '../src/gateway';
import { findRunnerRow, getRunner, markVendorNotReady, vendorHolds } from '../src/runners';
import { FakeConnection, FakeRunner, connectFakeRunner, settle } from './fake-runner';
import { addRunnerAttempt, createTestContext, testVendor } from './helpers';

type Ctx = ReturnType<typeof createTestContext>['ctx'];

/** What the test handlers saw: each event's seq, type and standing. */
let seen: [number, string, EventContext['standing']][] = [];
let registered: typeof EVENT_HANDLERS = {};

beforeEach(() => {
  seen = [];
  registered = { ...EVENT_HANDLERS };
});

afterEach(() => {
  for (const type of Object.keys(EVENT_HANDLERS) as RunnerEventType[]) delete EVENT_HANDLERS[type];
  Object.assign(EVENT_HANDLERS, registered);
});

/** Records the events of these types as they apply. */
function watch(...types: RunnerEventType[]): void {
  const record: EventHandler = (_ctx, event, context) => {
    seen.push([event.seq, event.type, context.standing]);
  };
  for (const type of types) EVENT_HANDLERS[type] = record as never;
}

/** A hub with a runner attempt on R-1 (runner-key-1, machine-1), the key FakeRunner uses by default. */
function setup() {
  const { ctx, clock } = createTestContext();
  const held = addRunnerAttempt(ctx);
  const gateway = new Gateway(ctx);
  const token = createSession(ctx, 'alice', 'cli');
  return { ctx, clock, held, gateway, token };
}

const activity = (summary: string) => ({ kind: 'note', summary }) as const;
const at = (attempt: { id: string; fence: Fence }) => ({ attemptId: attempt.id, fence: attempt.fence });

const rejects = (ctx: Ctx) =>
  ctx.db.query('SELECT runner_id, outbox_epoch, seq, type, error FROM runner_event_rejects ORDER BY id').all() as {
    runner_id: string;
    outbox_epoch: string;
    seq: number;
    type: string;
    error: string;
  }[];

const rejectedEvents = (ctx: Ctx) =>
  listEvents(ctx.db)
    .filter((event) => event.type === 'runner.event_rejected')
    .map((event) => event.data);

describe('applying a batch', () => {
  test('a stale-fence and a throwing event mid-batch are acknowledged with it, and the later events apply', async () => {
    const { ctx, held, gateway, token } = setup();
    watch('attempt.activity');
    // The throwing handler writes and emits first: its savepoint must undo both.
    EVENT_HANDLERS['attempt.first_output'] = (inner, event, context) => {
      appendAttemptLog(inner, event.attemptId, 'note', 'half applied');
      context.emit({
        type: 'attempt.running',
        actor: 'system',
        subject: held.task.id,
        data: { attemptId: event.attemptId, taskId: held.task.id },
      });
      throw new Error('handler broke');
    };
    const published: string[] = [];
    ctx.bus.subscribe((event) => published.push(event.type));
    const session = { user: 'alice', sessionHash: sessionHashOf(token) };
    const linked = new FakeRunner<FakeConnection>((endpoint) => new FakeConnection(gateway, session, endpoint), {
      now: ctx.now,
    });
    // The outbox fills while offline; the replay after welcome sends it as one batch.
    const stale = { attemptId: held.attempt.id, fence: { epoch: 1, counter: held.attempt.fence.counter + 5 } };
    linked.emit('attempt.activity', activity('first'), at(held.attempt));
    linked.emit('attempt.activity', activity('other fence'), stale);
    linked.emit('attempt.first_output', { text: 'I will fix the parser.' }, at(held.attempt));
    linked.emit('attempt.activity', activity('after'), at(held.attempt));
    await linked.connect();
    await settle();
    expect(linked.transport?.toHub.filter((message) => message.t === 'events')).toHaveLength(1);
    expect(linked.transport?.toRunner.filter((message) => message.t === 'ack')).toEqual([
      { t: 'ack', outboxEpoch: 'outbox-1', seq: 4 },
    ]);
    expect(linked.outbox).toEqual([]);
    expect(seen).toEqual([
      [1, 'attempt.activity', 'current'],
      [4, 'attempt.activity', 'current'],
    ]);
    expect(attemptLog(ctx, held.attempt.id).map((entry) => [entry.kind, entry.summary])).toEqual([
      [
        'rejected',
        `attempt.activity at fence ${formatFence(stale.fence)} ignored: ` +
          `the attempt's fence is ${formatFence(held.attempt.fence)}`,
      ],
    ]);
    expect(rejects(ctx)).toEqual([
      {
        runner_id: 'R-1',
        outbox_epoch: 'outbox-1',
        seq: 3,
        type: 'attempt.first_output',
        error: 'the hub failed to apply it: handler broke',
      },
    ]);
    expect(attemptLog(ctx, held.attempt.id).some((entry) => entry.summary === 'half applied')).toBe(false);
    expect(listEvents(ctx.db).some((event) => event.type === 'attempt.running')).toBe(false);
    expect(published.filter((type) => type.startsWith('attempt.') || type.startsWith('runner.event'))).toEqual([
      'runner.event_rejected',
    ]);
  });

  test('invalid, unknown and out-of-list events are acknowledged, stored as rejects and emitted', () => {
    const { ctx, held } = setup();
    const events: RawRunnerEvent[] = [
      { seq: 1, at: 0, type: 'attempt.failed_to_start', ...at(held.attempt), data: { error: 'x', refused: 'full' } },
      { seq: 2, at: 0, type: 'runner.teleported', data: {} },
      { seq: 3, at: 0, type: 'attempt.activity', ...at(held.attempt), data: { kind: 'note' } },
    ];
    expect(applyRunnerEvents(ctx, 'R-1', { outboxEpoch: 'outbox-1', events }, { restoreReplay: false })).toBe(3);
    expect(rejects(ctx).map((row) => [row.seq, row.type])).toEqual([
      [1, 'attempt.failed_to_start'],
      [2, 'runner.teleported'],
      [3, 'attempt.activity'],
    ]);
    expect(rejects(ctx)[0]?.error).toContain('refused');
    expect(rejects(ctx)[1]?.error).toBe('unknown event type "runner.teleported"');
    const raw = ctx.db.query('SELECT raw FROM runner_event_rejects WHERE seq = 2').get() as { raw: string };
    expect(JSON.parse(raw.raw)).toEqual(events[1] as RawRunnerEvent);
    expect(rejectedEvents(ctx)).toEqual([
      { runnerId: 'R-1', seq: 1, type: 'attempt.failed_to_start', error: expect.stringContaining('refused') },
      { runnerId: 'R-1', seq: 2, type: 'runner.teleported', error: 'unknown event type "runner.teleported"' },
      { runnerId: 'R-1', seq: 3, type: 'attempt.activity', error: expect.stringContaining('summary') },
    ]);
    expect(listEvents(ctx.db).find((event) => event.type === 'runner.event_rejected')?.subject).toBe('R-1');
  });

  test('events at or below the acknowledged seq are skipped', () => {
    const { ctx, held } = setup();
    watch('attempt.activity');
    const event = (seq: number): RawRunnerEvent => ({
      seq,
      at: 0,
      type: 'attempt.activity',
      ...at(held.attempt),
      data: activity(`event ${seq}`),
    });
    const apply = (events: RawRunnerEvent[]) =>
      applyRunnerEvents(ctx, 'R-1', { outboxEpoch: 'outbox-1', events }, { restoreReplay: false });
    expect(apply([event(1), event(2)])).toBe(2);
    expect(apply([event(1), event(2), event(3)])).toBe(3);
    expect(apply([event(2)])).toBe(3);
    // Each outbox epoch has its own position.
    const second = { outboxEpoch: 'outbox-2', events: [event(1)] };
    expect(applyRunnerEvents(ctx, 'R-1', second, { restoreReplay: false })).toBe(1);
    expect(seen.map(([seq]) => seq)).toEqual([1, 2, 3, 1]);
  });

  test('an event of an ended attempt or another fence is logged as rejected unless its type is an exception', () => {
    const { ctx, held } = setup();
    const types = [...STALE_EVENT_TYPES.keys(), 'attempt.activity'] as RunnerEventType[];
    watch(...types);
    const sha = 'a'.repeat(40);
    const dataOf = (type: RunnerEventType, taskId: string): unknown => {
      switch (type) {
        case 'attempt.wip':
          return { ref: `refs/agflow/${taskId}/a1`, sha, stripped: [], skipped: [], embedded: [], logStat: '' };
        case 'attempt.late_work':
          return { taskId, ref: `refs/agflow/${taskId}/late/a1`, sha };
        case 'attempt.exited':
          return {
            code: 0,
            signal: null,
            stoppedBy: 'none',
            handoffWritten: false,
            cause: null,
            finalSha: null,
            finalWip: null,
            pushError: null,
          };
        case 'attempt.violation':
          return { phase: 'wip', paths: ['.env'] };
        case 'attempt.taken_over':
          return { commands: { local: null, anywhere: 'git fetch' }, wipSha: null, error: null };
        case 'attempt.submitted':
          return { submissionId: 'S-1', ok: true, headSha: sha, remoteHead: sha, error: null, detail: null };
        case 'attempt.handed_back':
          return { ref: `refs/agflow/${taskId}/a1`, sha };
        default:
          return activity('late');
      }
    };
    // Four attempts on R-1: one ended stopped, one ended taken_over, one open at a newer fence, and one unknown.
    const endedOne = addRunnerAttempt(ctx, { runnerId: held.runner.id });
    updateAttempt(ctx, endedOne.attempt.id, { status: 'ended', endReason: 'stopped', endedAt: ctx.now() });
    const takenOver = addRunnerAttempt(ctx, { runnerId: held.runner.id });
    updateAttempt(ctx, takenOver.attempt.id, { status: 'ended', endReason: 'taken_over', endedAt: ctx.now() });
    const refenced = { epoch: 1, counter: held.attempt.fence.counter + 9 };
    updateAttempt(ctx, held.attempt.id, { fence: refenced });
    const targets = [
      { name: 'ended', id: endedOne.attempt.id, taskId: endedOne.task.id, fence: endedOne.attempt.fence },
      { name: 'taken_over', id: takenOver.attempt.id, taskId: takenOver.task.id, fence: takenOver.attempt.fence },
      { name: 'refenced', id: held.attempt.id, taskId: held.task.id, fence: held.attempt.fence },
      { name: 'unknown', id: 'T-9-a1', taskId: 'T-9', fence: held.attempt.fence },
    ];
    const events: RawRunnerEvent[] = [];
    const sent = new Map<number, string>();
    for (const target of targets) {
      for (const type of types) {
        const seq = events.length + 1;
        events.push({
          seq,
          at: 0,
          type,
          attemptId: target.id,
          fence: target.fence,
          data: dataOf(type, target.taskId),
        } as RawRunnerEvent);
        sent.set(seq, `${target.name} ${type}`);
      }
    }
    expect(applyRunnerEvents(ctx, 'R-1', { outboxEpoch: 'outbox-1', events }, { restoreReplay: false })).toBe(
      events.length,
    );
    const label = (seq: number) => sent.get(seq);
    expect(seen.map(([seq, , standing]) => `${label(seq)} (${standing})`).sort()).toEqual(
      [
        'ended attempt.wip (ended)',
        'ended attempt.late_work (ended)',
        'ended attempt.exited (ended)',
        'ended attempt.violation (ended)',
        'ended attempt.submitted (ended)',
        'ended attempt.handed_back (ended)',
        'taken_over attempt.wip (ended)',
        'taken_over attempt.late_work (ended)',
        'taken_over attempt.exited (ended)',
        'taken_over attempt.violation (ended)',
        'taken_over attempt.taken_over (ended)',
        'taken_over attempt.submitted (ended)',
        'taken_over attempt.handed_back (ended)',
        'refenced attempt.submitted (refenced)',
        'refenced attempt.handed_back (refenced)',
        'unknown attempt.wip (unknown)',
        'unknown attempt.late_work (unknown)',
        'unknown attempt.submitted (unknown)',
        'unknown attempt.handed_back (unknown)',
      ].sort(),
    );
    // The open attempt's old-fence events are only logged, whatever their type, apart from the two that always apply.
    const loggedTypes = (id: string) => attemptLog(ctx, id).map((entry) => entry.summary.split(' ')[0]);
    expect(loggedTypes(held.attempt.id)).toEqual([
      'attempt.wip',
      'attempt.late_work',
      'attempt.exited',
      'attempt.violation',
      'attempt.taken_over',
      'attempt.activity',
    ]);
    expect(attemptLog(ctx, held.attempt.id).map((entry) => entry.kind)).toEqual(Array(6).fill('rejected'));
    expect(attemptLog(ctx, held.attempt.id)[0]?.summary).toBe(
      `attempt.wip at fence ${formatFence(held.attempt.fence)} ignored: the attempt's fence is ${formatFence(refenced)}`,
    );
    expect(attemptLog(ctx, endedOne.attempt.id).map((entry) => entry.summary)).toEqual([
      `attempt.taken_over at fence ${formatFence(endedOne.attempt.fence)} ignored: the attempt ended (stopped)`,
      `attempt.activity at fence ${formatFence(endedOne.attempt.fence)} ignored: the attempt ended (stopped)`,
    ]);
    expect(loggedTypes(takenOver.attempt.id)).toEqual(['attempt.activity']);
    // An attempt the hub does not know has no log, so its other events become rejects.
    expect(rejects(ctx).map((row) => [row.type, row.error])).toEqual(
      ['attempt.exited', 'attempt.violation', 'attempt.taken_over', 'attempt.activity'].map((type) => [
        type,
        'unknown attempt T-9-a1',
      ]),
    );
  });

  test("another runner's attempt is never touched by this runner's events", () => {
    const { ctx, held } = setup();
    watch('attempt.activity');
    const elsewhere = addRunnerAttempt(ctx);
    const events: RawRunnerEvent[] = [
      { seq: 1, at: 0, type: 'attempt.activity', ...at(elsewhere.attempt), data: activity('forged') },
    ];
    applyRunnerEvents(ctx, held.runner.id, { outboxEpoch: 'outbox-1', events }, { restoreReplay: false });
    expect(seen).toEqual([]);
    expect(attemptLog(ctx, elsewhere.attempt.id)).toEqual([]);
    expect(rejects(ctx).map((row) => row.error)).toEqual([
      `attempt ${elsewhere.attempt.id} runs on ${elsewhere.runner.id}, not on ${held.runner.id}`,
    ]);
  });
});

describe('the replay after hello', () => {
  /** A hub-side socket that keeps what the gateway sends. */
  function socket(): LinkSocket & { sent: { t: string; seq?: number }[] } {
    const sent: { t: string; seq?: number }[] = [];
    return { sent, send: (text) => sent.push(JSON.parse(text)), close: () => {}, terminate: () => {} };
  }

  function helloOf(overrides: { firstSeq: number; lastSeq: number; lastHubEpoch?: number | null }) {
    const fake = new FakeRunner(() => {
      throw new Error('unused');
    });
    return JSON.stringify({ ...fake.hello(), ...overrides });
  }

  const events = (attempt: { id: string; fence: Fence }, seqs: number[]) =>
    JSON.stringify({
      t: 'events',
      outboxEpoch: 'outbox-1',
      events: seqs.map((seq) => ({ seq, at: 0, type: 'attempt.activity', ...at(attempt), data: activity(`${seq}`) })),
    });

  async function pending(promise: Promise<void>): Promise<boolean> {
    let done = false;
    void promise.then(() => {
      done = true;
    });
    await settle();
    return !done;
  }

  test('replayComplete fires once acked_seq reaches hello.lastSeq', async () => {
    const { ctx, held, gateway, token } = setup();
    const link = socket();
    const connection = gateway.open(link, { user: 'alice', sessionHash: sessionHashOf(token) });
    gateway.message(connection, helloOf({ firstSeq: 1, lastSeq: 5 }));
    expect(connection.replayed).toBe(false);
    gateway.message(connection, events(held.attempt, [1, 2, 3]));
    expect(await pending(connection.replayComplete)).toBe(true);
    gateway.message(connection, events(held.attempt, [4, 5]));
    expect(await pending(connection.replayComplete)).toBe(false);
    expect(connection.replayed).toBe(true);
    expect(link.sent.filter((message) => message.t === 'ack').map((message) => message.seq)).toEqual([3, 5]);
  });

  test('replayComplete fires at once when there is nothing to replay', async () => {
    const { gateway, token } = setup();
    const connection = gateway.open(socket(), { user: 'alice', sessionHash: sessionHashOf(token) });
    gateway.message(connection, helloOf({ firstSeq: 8, lastSeq: 7 }));
    expect(connection.replayed).toBe(true);
    expect(await pending(connection.replayComplete)).toBe(false);
  });

  test('replayComplete never fires on a closed connection', async () => {
    const { held, gateway, token } = setup();
    const connection = gateway.open(socket(), { user: 'alice', sessionHash: sessionHashOf(token) });
    gateway.message(connection, helloOf({ firstSeq: 1, lastSeq: 3 }));
    gateway.closed(connection);
    gateway.message(connection, events(held.attempt, [1, 2, 3]));
    expect(await pending(connection.replayComplete)).toBe(true);
    expect(connection.replayed).toBe(false);
  });

  test('after a restore, a replayed newer fence applies until replayComplete; otherwise it is rejected', async () => {
    const { ctx, held, gateway, token } = setup();
    watch('attempt.activity');
    ctx.db.run('UPDATE project SET epoch = 2');
    // The restored hub knows the attempt at a later fence than the one it started with.
    const { counter } = held.attempt.fence;
    const original = { id: held.attempt.id, fence: held.attempt.fence };
    updateAttempt(ctx, held.attempt.id, { fence: { epoch: 1, counter: counter + 2 } });
    // Sent after the backup: the attempt had a newer fence then than the restored hub knows.
    const newer = { id: held.attempt.id, fence: { epoch: 1, counter: counter + 3 } };
    const restored = gateway.open(socket(), { user: 'alice', sessionHash: sessionHashOf(token) });
    gateway.message(restored, helloOf({ firstSeq: 1, lastSeq: 3, lastHubEpoch: 1 }));
    expect(restored.afterRestore).toBe(true);
    gateway.message(restored, events(newer, [1, 2]));
    // Only a newer fence counts as current during the replay; an older one stays stale.
    gateway.message(restored, events(original, [3]));
    expect(restored.replayed).toBe(true);
    // Live events after the replay need the recorded fence again.
    gateway.message(restored, events(newer, [4]));
    expect(seen).toEqual([
      [1, 'attempt.activity', 'current'],
      [2, 'attempt.activity', 'current'],
    ]);
    expect(attemptLog(ctx, held.attempt.id).map((entry) => [entry.kind, entry.summary.split(' ').slice(0, 4).join(' ')])).toEqual([
      ['rejected', `attempt.activity at fence ${formatFence(original.fence)}`],
      ['rejected', `attempt.activity at fence ${formatFence(newer.fence)}`],
    ]);

    // Without a restore the same fence is stale from the start.
    seen = [];
    const plain = gateway.open(socket(), { user: 'alice', sessionHash: sessionHashOf(token) });
    gateway.message(plain, helloOf({ firstSeq: 5, lastSeq: 5, lastHubEpoch: 2 }));
    expect(plain.afterRestore).toBe(false);
    gateway.message(plain, events(newer, [5]));
    expect(seen).toEqual([]);
    expect(attemptLog(ctx, held.attempt.id).map((entry) => entry.kind)).toEqual(Array(3).fill('rejected'));
  });
});

describe('runner events', () => {
  const apply = (ctx: Ctx, events: RawRunnerEvent[]) =>
    applyRunnerEvents(ctx, 'R-1', { outboxEpoch: 'outbox-1', events }, { restoreReplay: false });

  test('runner.state sets crash_loop, disk_low or ok, with the detail as lastError', async () => {
    const { ctx, gateway, token } = setup();
    await connectFakeRunner(ctx, gateway, { token });
    apply(ctx, [{ seq: 1, at: 0, type: 'runner.state', data: { state: 'crash_loop', detail: '3 unclean exits' } }]);
    expect(getRunner(ctx, 'R-1')).toMatchObject({
      state: 'crash_loop',
      stateDetail: '3 unclean exits',
      lastError: '3 unclean exits',
    });
    apply(ctx, [{ seq: 2, at: 0, type: 'runner.state', data: { state: 'disk_low', detail: '4 GB free' } }]);
    expect(getRunner(ctx, 'R-1')).toMatchObject({ state: 'disk_low', lastError: '4 GB free' });
    apply(ctx, [{ seq: 3, at: 0, type: 'runner.state', data: { state: 'ok', detail: null } }]);
    expect(getRunner(ctx, 'R-1')).toMatchObject({ state: 'online', stateDetail: null, lastError: '4 GB free' });
    // runner.updated names changed settings (core's HUB_EVENT_TYPES); a reported state is none, so it emits nothing.
    expect(listEvents(ctx.db).filter((event) => event.type === 'runner.updated')).toEqual([]);
  });

  test('runner.settings applies the edits at the hub version + 1 and echoes them', async () => {
    const { ctx, gateway, token } = setup();
    await connectFakeRunner(ctx, gateway, { token });
    const before = getRunner(ctx, 'R-1').settingsVersion;
    apply(ctx, [{ seq: 1, at: 0, type: 'runner.settings', data: { settings: { draining: true }, baseVersion: 0 } }]);
    expect(getRunner(ctx, 'R-1')).toMatchObject({ draining: true, settingsVersion: before + 1 });
    const echo = pendingCommands(ctx, 'R-1', 1).at(-1);
    expect(echo?.command).toEqual({ kind: 'update_settings', settings: { draining: true }, version: before + 1 });
    expect(findCommand(ctx, echo?.id as string)?.status).toBe('pending');
  });

  test('runner.vendors updates the vendors and clears not-ready marks by preflightAt', async () => {
    const { ctx, clock, gateway, token } = setup();
    await connectFakeRunner(ctx, gateway, { token });
    tx(ctx, () => markVendorNotReady(ctx, 'R-1', 'codex'));
    const markedAt = ctx.now();
    clock.advance(1_000);
    const vendors = (preflightAt: number | null) => [testVendor('claude'), { ...testVendor('codex'), preflightAt }];
    apply(ctx, [{ seq: 1, at: 0, type: 'runner.vendors', data: { vendors: vendors(markedAt - 1), quota: [] } }]);
    expect(vendorHolds(findRunnerRow(ctx, 'R-1') as never).codex?.notReadySince).toBe(markedAt);
    expect(getRunner(ctx, 'R-1').vendors.map((vendor) => [vendor.vendor, vendor.ready])).toEqual([
      ['claude', true],
      ['codex', false],
    ]);
    apply(ctx, [{ seq: 2, at: 0, type: 'runner.vendors', data: { vendors: vendors(ctx.now()), quota: [] } }]);
    expect(vendorHolds(findRunnerRow(ctx, 'R-1') as never).codex?.notReadySince).toBeNull();
    expect(getRunner(ctx, 'R-1').vendors.every((vendor) => vendor.ready)).toBe(true);
  });
});
