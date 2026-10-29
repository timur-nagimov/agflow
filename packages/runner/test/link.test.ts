import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AGFLOW_VERSION,
  type AttemptFacts,
  type Credentials,
  PROTOCOL_VERSION,
  type RunnerCommand,
} from '@agflow/core';
import { AwakeClock, type ClockSource, systemClock } from '../src/clock';
import { DEFAULT_TIMINGS } from '../src/config';
import { openRunnerDb, type RunnerDb } from '../src/db';
import type { CommandResult } from '../src/journal';
import {
  type CommandMessage,
  hubWebSocketUrl,
  LinkClient,
  type LinkOptions,
  type LinkState,
  MAX_EVENTS_MESSAGE_BYTES,
  sameHubUrl,
} from '../src/link';
import { memoryLogger } from '../src/log';
import { Outbox } from '../src/outbox';
import { type FakeHub, type FakeHubOptions, startFakeHub, testWelcome } from './fake-hub';

// Each test serves a hub over real sockets, which take several times as long on a machine loaded by other suites.
setDefaultTimeout(30_000);

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const TOKEN = 'cli_secret_token';
const fence = { epoch: 1, counter: 3 };

const facts: AttemptFacts = {
  attemptId: 'T-4-a1',
  fence,
  phase: 'turn',
  eventAgeMs: 120,
  tool: null,
  fsAgeMs: null,
  commitAgeMs: null,
  turns: 2,
  turnsWithoutProgress: 0,
  repeatedCalls: 0,
  continuations: 0,
  vendorErrorMs: 0,
  activeMs: 4_000,
  contextUsed: null,
};

/** Wall time the test can move forward, so the awake clock sees a sleep; timers stay real. */
class ShiftedClock implements ClockSource {
  offset = 0;
  now = (): number => Date.now() + this.offset;
  setTimeout = systemClock.setTimeout;
  clearTimeout = systemClock.clearTimeout;
  setInterval = systemClock.setInterval;
  clearInterval = systemClock.clearInterval;
}

function note(summary: string) {
  return { type: 'attempt.activity', attemptId: 'T-4-a1', fence, data: { kind: 'note', summary } } as const;
}

type Overrides = Omit<Partial<LinkOptions>, 'timings'> & {
  timings?: Partial<LinkOptions['timings']>;
  /** Runs on the outbox before the link starts. */
  before?: (outbox: Outbox) => void;
};

interface Setup {
  hub: FakeHub;
  link: LinkClient;
  outbox: Outbox;
  db: RunnerDb;
  wall: ShiftedClock;
  clock: AwakeClock;
  logger: ReturnType<typeof memoryLogger>;
  commands: CommandMessage[];
}

function setup(
  hubOptions: FakeHubOptions = {},
  overrides: Overrides = {},
): Setup {
  const hub = startFakeHub({ token: TOKEN, ...hubOptions });
  cleanups.push(() => hub.stop());
  const dir = mkdtempSync(join(tmpdir(), 'agflow-link-'));
  const db = openRunnerDb(join(dir, 'runner.db'));
  cleanups.push(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const outbox = new Outbox(db);
  overrides.before?.(outbox);
  const wall = new ShiftedClock();
  const clock = new AwakeClock({ source: wall, gapMs: 5_000 });
  const logger = memoryLogger();
  const commands: CommandMessage[] = [];
  const credentials: Credentials = { hubUrl: hub.url, token: TOKEN, user: 'alice' };
  const { timings, before: _before, ...rest } = overrides;
  const link = new LinkClient({
    credentials: () => credentials,
    hubUrl: hub.url,
    outbox,
    clock,
    logger,
    random: () => 0,
    timings: {
      heartbeat: 10_000,
      deadLink: 10_000,
      handshake: 10_000,
      backoffBase: 10,
      backoffCap: 50,
      ...timings,
    },
    hello: () => ({
      t: 'hello',
      protocol: PROTOCOL_VERSION,
      runnerKey: 'rk_test',
      machineId: 'MACHINE-1',
      name: 'laptop',
      agflowVersion: AGFLOW_VERSION,
      platform: 'darwin-arm64',
      settings: { capacity: 2, keepAwake: 'ac', draining: false, ceilings: {}, allowPaidUsage: {}, version: 1 },
      vendors: [],
      quota: [],
      profile: { name: 'standard', weakened: [], dependencyPrep: false },
      git: { ready: true, problem: null, lastPushAt: null },
      state: 'ok',
      stateDetail: null,
      outboxEpoch: outbox.epoch,
      firstSeq: outbox.firstSeq(),
      lastSeq: outbox.lastSeq(),
      lastHubEpoch: null,
      attempts: [],
    }),
    heartbeat: () => ({ attempts: [facts], power: null, disk: null, acceptingUntil: null }),
    handlers: {
      onCommand: async (command) => {
        commands.push(command);
        return { ok: true, data: { kind: command.command.kind } };
      },
    },
    ...rest,
  });
  cleanups.push(() => link.close());
  link.start();
  return { hub, link, outbox, db, wall, clock, logger, commands };
}

const seqs = (events: { seq: number }[]) => events.map((event) => event.seq);
const eventsMessages = (setupHub: FakeHub, index: number) =>
  setupHub.connections[index]?.messages.flatMap((message) => (message.t === 'events' ? [message] : [])) ?? [];
const kinds = (setupHub: FakeHub, index: number) => setupHub.connections[index]?.messages.map((message) => message.t);

describe('hubWebSocketUrl', () => {
  test('sameHubUrl compares origin and path, ignoring a trailing slash', () => {
    expect(sameHubUrl('http://127.0.0.1:7000', 'http://127.0.0.1:7000/')).toBe(true);
    expect(sameHubUrl('https://example.com/agflow/', 'https://EXAMPLE.com/agflow')).toBe(true);
    expect(sameHubUrl('http://127.0.0.1:7000', 'http://127.0.0.1:7001')).toBe(false);
    expect(sameHubUrl('https://example.com/a', 'https://example.com/b')).toBe(false);
    expect(sameHubUrl('not a url', 'not a url')).toBe(false);
  });

  test('maps the hub URL to the runner socket', () => {
    expect(hubWebSocketUrl('http://127.0.0.1:7000')).toBe('ws://127.0.0.1:7000/api/runner/ws');
    expect(hubWebSocketUrl('https://hub.example.com/')).toBe('wss://hub.example.com/api/runner/ws');
    expect(hubWebSocketUrl('https://example.com/agflow/')).toBe('wss://example.com/agflow/api/runner/ws');
    expect(() => hubWebSocketUrl('ftp://example.com')).toThrow(/http/);
  });
});

describe('LinkClient', () => {
  test('connects with the CLI token from the provider and sends a schema-valid hello first', async () => {
    const { hub, link } = setup();
    const connection = await hub.connection(0);
    await hub.waitFor(() => link.state === 'online');
    expect(connection.authorization).toBe(`Bearer ${TOKEN}`);
    expect(connection.messages[0]).toMatchObject({ t: 'hello', runnerKey: 'rk_test', firstSeq: 1, lastSeq: 0 });
    expect(hub.invalid).toEqual([]);
  });

  test('replays the outbox after welcome.ackedSeq, streams new events, applies acks and replays again', async () => {
    const welcomes = [{ ackedSeq: 1 }, { ackedSeq: 2 }];
    const { hub, link, outbox } = setup(
      { autoAck: false, welcome: (_hello, connection) => welcomes[connection.index] ?? {} },
      { before: (box) => ['one', 'two', 'three'].forEach((summary) => box.append(note(summary))) },
    );
    await hub.waitFor(() => hub.events().length === 2);
    expect(seqs(hub.events())).toEqual([2, 3]);
    outbox.append(note('four'));
    await hub.waitFor(() => hub.events().length === 3);
    expect(seqs(hub.events())).toEqual([2, 3, 4]);
    const first = await hub.connection(0);
    first.send({ t: 'ack', outboxEpoch: outbox.epoch, seq: 4 });
    expect(await outbox.waitAcked(4, 2_000)).toBe(true);
    first.terminate();
    await hub.waitFor(() => hub.events().length === 5);
    expect(seqs(hub.events())).toEqual([2, 3, 4, 3, 4]);
    expect(kinds(hub, 1)?.[0]).toBe('hello');
    // The cumulative ack never goes back, whatever a welcome says.
    expect(outbox.ackedSeq()).toBe(4);
    expect(link.state).toBe('online');
    expect(hub.invalid).toEqual([]);
  });

  test('a 1011 close reconnects with backoff and replays only after the acknowledged position', async () => {
    const { hub, link, outbox, logger } = setup(
      { autoAck: false, welcome: { ackedSeq: 1 } },
      { before: (box) => ['acked', 'failed batch', 'queued behind it'].forEach((text) => box.append(note(text))) },
    );
    await hub.waitFor(() => hub.events().length === 2);
    expect(outbox.ackedSeq()).toBe(1);
    (await hub.connection(0)).close(1011, 'the hub could not apply events');
    await hub.waitFor(() => eventsMessages(hub, 1).length > 0);
    expect(seqs(eventsMessages(hub, 1).flatMap((message) => message.events))).toEqual([2, 3]);
    expect(kinds(hub, 1)?.[0]).toBe('hello');
    expect(logger.entries).toContainEqual({
      level: 'info', message: 'the hub link closed',
      fields: { code: 1011, reason: 'the hub could not apply events' },
    });
    (await hub.connection(1)).send({ t: 'ack', outboxEpoch: outbox.epoch, seq: 3 });
    expect(await outbox.waitAcked(3, 2_000)).toBe(true);
    expect(link.state).toBe('online');
    expect(hub.invalid).toEqual([]);
  });

  test('a failed welcome reconnects with growing backoff and sends nothing before the retry', async () => {
    const retries: { fn: () => void; ms: number }[] = [];
    let state: LinkState = 'idle';
    const { hub, link } = setup({}, {
      before: (box) => box.append(note('not on the failed welcome')),
      random: () => 0.5,
      timings: { backoffBase: 200, backoffCap: 1_000 },
      timers: {
        ...systemClock,
        setTimeout: (fn, ms) => {
          if (state !== 'backoff') return systemClock.setTimeout(fn, ms);
          retries.push({ fn, ms });
          return null;
        },
      },
      handlers: {
        onCommand: async () => ({ ok: true }),
        onState: (next) => { state = next; },
        onWelcome: () => link.reconnectWithBackoff('failed restore write'),
      },
    });
    await hub.waitFor(() => retries.length === 1);
    expect(link.state).toBe('backoff');
    expect(link.welcomeSinceGap).toBe(false);
    expect(retries[0]?.ms).toBe(100);
    expect(hub.events()).toEqual([]);
    retries[0]?.fn();
    await hub.waitFor(() => retries.length === 2);
    expect(retries[1]?.ms).toBe(200);
    expect(link.state).toBe('backoff');
    expect(link.welcomeSinceGap).toBe(false);
    expect(hub.events()).toEqual([]);
  });

  test('failed ack writes are logged at welcome and ack, and a later ack persists the position', async () => {
    const { hub, link, outbox, db, logger } = setup(
      { welcome: false, autoAck: false },
      { before: (box) => box.append(note('replay me')) },
    );
    const connection = await hub.connection(0);
    db.sqlite.run("CREATE TRIGGER fail_ack BEFORE UPDATE ON outbox_ack BEGIN SELECT RAISE(ABORT, 'ack disk full'); END");
    connection.send(testWelcome(0));
    await hub.waitFor(() => hub.events().length === 1);
    connection.send({ t: 'ack', outboxEpoch: outbox.epoch, seq: 1 });
    await hub.waitFor(() => logger.entries.filter((entry) => entry.fields?.error === 'ack disk full').length === 2);
    expect(link.state).toBe('online');
    expect(outbox.ackedSeq()).toBe(0);
    db.sqlite.run('DROP TRIGGER fail_ack');
    connection.send({ t: 'ack', outboxEpoch: outbox.epoch, seq: 1 });
    expect(await outbox.waitAcked(1, 2_000)).toBe(true);
  });

  test('a throwing welcome handler is logged and the outbox still replays', async () => {
    const { hub, link, logger } = setup({}, {
      before: (box) => box.append(note('replay me')),
      handlers: {
        onCommand: async () => ({ ok: true }),
        onWelcome: () => { throw new Error('welcome handler failed'); },
      },
    });
    await hub.waitFor(() => hub.events().length === 1);
    expect(link.state).toBe('online');
    expect(logger.entries.some((entry) => entry.fields?.error === 'welcome handler failed')).toBe(true);
  });

  test('sends heartbeats every welcome heartbeatMs with the facts; heartbeat_ack keeps the link alive', async () => {
    const timings = { heartbeatMs: 30, deadLinkMs: 200, handoffMs: 1_000, wipGraceMs: 1_000 };
    const { hub, link } = setup({ welcome: { timings } }, { timings: { heartbeat: 60_000, deadLink: 60_000 } });
    await hub.waitFor(() => link.state === 'online');
    expect(link.timings).toEqual({ heartbeatMs: 30, deadLinkMs: 200 });
    await Bun.sleep(500);
    const heartbeats = hub.connections[0]?.messages.filter((message) => message.t === 'heartbeat') ?? [];
    expect(heartbeats.length).toBeGreaterThanOrEqual(5);
    expect(heartbeats[0]).toMatchObject({ attempts: [facts], power: null, disk: null, acceptingUntil: null });
    // Only heartbeat_acks came in for longer than deadLinkMs, and the link stayed up.
    expect(hub.connections).toHaveLength(1);
    expect(link.state).toBe('online');
    expect(hub.invalid).toEqual([]);
  });

  test('terminates a link silent for deadLink and reconnects with backoff', async () => {
    const timings = { heartbeatMs: 30, deadLinkMs: 120, handoffMs: 1_000, wipGraceMs: 1_000 };
    const states: string[] = [];
    const { hub } = setup(
      { heartbeatAck: false, welcome: { timings } },
      { handlers: { onCommand: async () => ({ ok: true }), onState: (state) => states.push(state) } },
    );
    const first = await hub.connection(0);
    await hub.waitFor(() => first.closed);
    // terminate(), not close(): the hub sees an abnormal closure, not a close frame.
    expect(first.closed?.code).toBe(1006);
    const second = await hub.connection(1);
    expect(second.authorization).toBe(`Bearer ${TOKEN}`);
    expect(states.slice(0, 4)).toEqual(['connecting', 'online', 'backoff', 'connecting']);
  });

  test('reconnect delays grow by backoff while the link stays up less than 60 s', async () => {
    const timings = { heartbeatMs: 30, deadLinkMs: 120, handoffMs: 1_000, wipGraceMs: 1_000 };
    const states: { state: LinkState; at: number; detail: { code: number | null; reason: string } }[] = [];
    const { hub } = setup(
      { heartbeatAck: false, welcome: { timings } },
      {
        random: () => 1,
        timings: { backoffBase: 100, backoffCap: 1_000 },
        handlers: {
          onCommand: async () => ({ ok: true }),
          onState: (state, detail) => states.push({ state, at: performance.now(), detail }),
        },
      },
    );
    await hub.connection(2, 5_000);
    const backoffs = states.filter((entry) => entry.state === 'backoff');
    const reconnects = states.filter((entry, index) => entry.state === 'connecting' && index > 0);
    expect(backoffs[0]?.detail).toEqual({ code: 1006, reason: 'dead link' });
    // random () => 1 takes the whole ceiling: base, then twice base, since the link was up for less than 60 s.
    expect((reconnects[0]?.at as number) - (backoffs[0]?.at as number)).toBeGreaterThanOrEqual(90);
    expect((reconnects[1]?.at as number) - (backoffs[1]?.at as number)).toBeGreaterThanOrEqual(180);
  });

  test('a handshake without welcome within the handshake timeout reconnects', async () => {
    const { hub, link } = setup({ welcome: false }, { timings: { handshake: 100 } });
    const first = await hub.connection(0);
    await hub.waitFor(() => first.closed);
    expect(first.closed?.code).toBe(1006);
    expect(first.messages.map((message) => message.t)).toEqual(['hello']);
    const second = await hub.connection(1);
    await hub.waitFor(() => second.messages.length > 0);
    expect(second.messages[0]?.t).toBe('hello');
    expect(link.welcomeSinceGap).toBe(false);
  });

  test('a clock gap reconnects at once and replays; welcomeSinceGap and lastAckAt follow the hub', async () => {
    const timings = { heartbeatMs: 40, deadLinkMs: 5_000, handoffMs: 1_000, wipGraceMs: 1_000 };
    const { hub, link, clock, wall, outbox } = setup(
      { autoAck: false, welcome: { timings } },
      {
        // A backoff would take seconds; the reconnect after a gap must not wait for it.
        random: () => 1,
        timings: { backoffBase: 5_000, backoffCap: 5_000 },
        before: (box) => box.append(note('one')),
      },
    );
    expect(link.welcomeSinceGap).toBe(false);
    expect(link.lastAckAt).toBeNull();
    await hub.waitFor(() => link.state === 'online');
    expect(link.welcomeSinceGap).toBe(true);
    const atWelcome = link.lastAckAt as number;
    expect(atWelcome).toBeGreaterThan(0);
    await hub.waitFor(() => (link.lastAckAt as number) > atWelcome);
    await hub.waitFor(() => hub.events().length === 1);
    wall.offset += 60_000;
    clock.awakeNow();
    expect(link.welcomeSinceGap).toBe(false);
    const started = Date.now();
    const second = await hub.connection(1, 2_000);
    expect(Date.now() - started).toBeLessThan(1_000);
    await hub.waitFor(() => link.welcomeSinceGap);
    await hub.waitFor(() => hub.events().length === 2);
    expect(seqs(hub.events())).toEqual([1, 1]);
    expect(second.messages[0]?.t).toBe('hello');
    expect(outbox.ackedSeq()).toBe(0);
    expect((await hub.connection(0)).closed?.code).toBe(1006);
  });

  test('a gap first seen by the close of the dropped socket reconnects at once, not after a backoff', async () => {
    const { hub, link, wall } = setup({}, { random: () => 1, timings: { backoffBase: 5_000, backoffCap: 5_000 } });
    await hub.waitFor(() => link.state === 'online');
    wall.offset += 60_000;
    const started = Date.now();
    (await hub.connection(0)).terminate();
    await hub.connection(1, 2_000);
    expect(Date.now() - started).toBeLessThan(2_000);
    await hub.waitFor(() => link.state === 'online' && link.welcomeSinceGap);
  });

  test('a gap first seen by a welcome drops that welcome and connects again', async () => {
    const { hub, link, wall } = setup(
      { welcome: (_hello, connection) => (connection.index === 0 ? false : {}) },
      { random: () => 1, timings: { backoffBase: 5_000, backoffCap: 5_000 } },
    );
    const first = await hub.connection(0);
    await hub.waitFor(() => first.messages.length > 0);
    wall.offset += 60_000;
    first.send(testWelcome(0));
    const second = await hub.connection(1, 2_000);
    await hub.waitFor(() => link.state === 'online' && link.welcomeSinceGap);
    expect(second.messages[0]?.t).toBe('hello');
    await hub.waitFor(() => first.closed);
    expect(first.closed?.code).toBe(1006);
  });

  test('welcomeSinceGap reads the clock, so a gap nothing noticed yet already clears it', async () => {
    const { hub, link, wall } = setup({}, { random: () => 1, timings: { backoffBase: 5_000, backoffCap: 5_000 } });
    await hub.waitFor(() => link.state === 'online');
    expect(link.welcomeSinceGap).toBe(true);
    wall.offset += 20 * 60_000;
    expect(link.welcomeSinceGap).toBe(false);
    await hub.connection(1, 2_000);
    await hub.waitFor(() => link.welcomeSinceGap);
  });

  test('stays with its hub: credentials for another hub open no socket until they name this hub again', async () => {
    const other = startFakeHub({ token: 'other_token' });
    cleanups.push(() => other.stop());
    // Signed out until the hub exists; the link backs off meanwhile.
    const credentials: { current: Credentials | null } = { current: null };
    const { hub, link, logger } = setup({}, { credentials: () => credentials.current });
    credentials.current = { hubUrl: `${hub.url}/`, token: TOKEN, user: 'alice' };
    await hub.waitFor(() => link.state === 'online');
    const before = hub.connections.length;
    credentials.current = { hubUrl: other.url, token: 'other_token', user: 'alice' };
    hub.connections[before - 1]?.terminate();
    await hub.waitFor(() => logger.entries.some((entry) => /signed in to/.test(entry.message)));
    await Bun.sleep(100);
    expect(other.connections).toHaveLength(0);
    expect(hub.connections).toHaveLength(before);
    expect(link.state).toBe('backoff');
    credentials.current = { hubUrl: hub.url, token: TOKEN, user: 'alice' };
    await hub.connection(before, 2_000);
    await hub.waitFor(() => link.state === 'online');
  });

  test('replays a long outbox in batches of 100 and counts welcome.ackedSeq as an ack', async () => {
    const { hub, link, outbox } = setup(
      { autoAck: false, welcome: { ackedSeq: 7 } },
      {
        before: (box) => {
          for (let index = 1; index <= 250; index += 1) box.append(note(`event ${index}`));
        },
      },
    );
    await hub.waitFor(() => link.state === 'online');
    expect(outbox.ackedSeq()).toBe(7);
    await hub.waitFor(() => hub.events().length === 243);
    expect(seqs(hub.events())).toEqual(Array.from({ length: 243 }, (_, index) => index + 8));
    expect(eventsMessages(hub, 0).map((message) => message.events.length)).toEqual([100, 100, 43]);
  });

  test('leaves out of the replay the events resent names, as if sent, so the ack of a later one covers them', async () => {
    const welcomes = [{ ackedSeq: 1 }, { ackedSeq: 3 }];
    const { hub, outbox } = setup(
      { welcome: (_hello, connection) => welcomes[connection.index] ?? {} },
      {
        before: (box) => ['one', 'two', 'three', 'four'].forEach((summary) => box.append(note(summary))),
        resent: (event) => event.seq === 2 || event.seq === 4,
      },
    );
    expect(await outbox.waitAcked(3, 2_000)).toBe(true);
    expect(seqs(hub.events())).toEqual([3]);
    // A replay of nothing but events it leaves out sends nothing, and goes on after them.
    (await hub.connection(0)).terminate();
    await hub.connection(1);
    outbox.append(note('five'));
    expect(await outbox.waitAcked(5, 2_000)).toBe(true);
    expect(seqs(eventsMessages(hub, 1).flatMap((message) => message.events))).toEqual([5]);
    expect(seqs(hub.events())).toEqual([3, 5]);
  });

  test('fills each events message only up to its byte budget, one event at least', async () => {
    const big = 'x'.repeat(Math.floor(MAX_EVENTS_MESSAGE_BYTES / 3));
    const { hub, link, outbox } = setup(
      {},
      {
        before: (box) => {
          for (let index = 0; index < 8; index += 1) box.append(note(`${index} ${big}`));
          box.append(note('small'));
        },
      },
    );
    await hub.waitFor(() => link.state === 'online');
    await hub.waitFor(() => hub.events().length === 9);
    const sizes = eventsMessages(hub, 0).map((message) => JSON.stringify(message.events).length);
    expect(sizes.length).toBeGreaterThan(3);
    for (const size of sizes) expect(size).toBeLessThanOrEqual(MAX_EVENTS_MESSAGE_BYTES);
    expect(await outbox.waitAcked(9, 2_000)).toBe(true);
    expect(seqs(hub.events())).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  test('never sends an event whose transaction rolled back', async () => {
    const { hub, link, outbox, db } = setup();
    await hub.waitFor(() => link.state === 'online');
    outbox.append(note('one'));
    const rolledBack = db.sqlite.transaction(() => {
      outbox.append(note('rolled back'));
      throw new Error('the record update failed');
    });
    expect(() => rolledBack()).toThrow(/record update/);
    outbox.append(note('two'));
    expect(await outbox.waitAcked(2, 2_000)).toBe(true);
    const sent = hub.events().map((event) => [event.seq, (event.data as { summary: string }).summary]);
    expect(sent).toEqual([
      [1, 'one'],
      [2, 'two'],
    ]);
  });

  test('hands commands to the handler in arrival order and sends each result as soon as it settles', async () => {
    const order: string[] = [];
    let releaseInterrupt = () => {};
    const interruptHeld = new Promise<void>((resolve) => {
      releaseInterrupt = resolve;
    });
    const { hub, link } = setup(
      {},
      {
        handlers: {
          onCommand: async (message): Promise<CommandResult> => {
            order.push(message.command.kind);
            if (message.command.kind === 'interrupt') await interruptHeld;
            if (message.command.kind === 'hold_attempt') throw new Error('the attempt is gone');
            return { ok: true, data: { seq: message.seq } };
          },
        },
      },
    );
    await hub.waitFor(() => link.state === 'online');
    const commands: RunnerCommand[] = [
      { kind: 'interrupt', attemptId: 'T-4-a1', fence },
      { kind: 'deliver', attemptId: 'T-4-a1', fence, messages: [], more: 0 },
      { kind: 'hold_attempt', attemptId: 'T-4-a1', fence },
    ];
    const ids = commands.map((command) => hub.command(command)) as [string, string, string];
    // A slow command never holds back the results of later ones.
    await hub.waitFor(() => hub.results.has(ids[1]) && hub.results.has(ids[2]));
    expect(hub.results.has(ids[0])).toBe(false);
    expect(order).toEqual(['interrupt', 'deliver', 'hold_attempt']);
    releaseInterrupt();
    await hub.waitFor(() => hub.results.has(ids[0]));
    expect(hub.results.get(ids[0])).toEqual({ t: 'result', commandId: ids[0], ok: true, data: { seq: 1 } });
    expect(hub.results.get(ids[1])).toEqual({ t: 'result', commandId: ids[1], ok: true, data: { seq: 2 } });
    expect(hub.results.get(ids[2])).toEqual({
      t: 'result',
      commandId: ids[2],
      ok: false,
      error: 'the attempt is gone',
    });
    expect(hub.invalid).toEqual([]);
  });

  test('sends no result for a command the handler answers null, so the hub sends it again after a welcome', async () => {
    const { hub, link } = setup(
      {},
      {
        handlers: {
          onCommand: async (message): Promise<CommandResult | null> =>
            message.command.kind === 'interrupt' ? null : { ok: true },
        },
      },
    );
    await hub.waitFor(() => link.state === 'online');
    const unanswered = hub.command({ kind: 'interrupt', attemptId: 'T-4-a1', fence });
    const answered = hub.command({ kind: 'hold_attempt', attemptId: 'T-4-a1', fence });
    await hub.waitFor(() => hub.results.has(answered));
    expect(hub.results.has(unanswered)).toBe(false);
    expect(hub.connections[0]?.messages.filter((message) => message.t === 'result')).toHaveLength(1);
    expect(hub.invalid).toEqual([]);
  });

  test('calls onWelcome on each welcome, before the messages that follow it', async () => {
    const calls: string[] = [];
    const { hub, link } = setup(
      { welcome: (_hello, connection) => (connection.index === 0 ? false : {}) },
      {
        handlers: {
          onWelcome: (welcome) => calls.push(`welcome ${welcome.stop.map((entry) => entry.attemptId).join(',')}`),
          onCommand: async (message) => {
            calls.push(`command ${message.command.kind}`);
            return { ok: true };
          },
        },
      },
    );
    const first = await hub.connection(0);
    await hub.waitFor(() => first.messages.length > 0);
    first.send(testWelcome(0, { stop: [{ attemptId: 'T-4-a1', reason: 'unknown' }] }));
    hub.command({ kind: 'cleanup_attempt', attemptId: 'T-4-a1' });
    await hub.waitFor(() => calls.length === 2);
    expect(calls).toEqual(['welcome T-4-a1', 'command cleanup_attempt']);
    expect(link.welcome?.stop).toEqual([{ attemptId: 'T-4-a1', reason: 'unknown' }]);
  });

  test('reconnectNow from onWelcome ends that connection before anything follows the welcome, and connects at once', async () => {
    const calls: string[] = [];
    let link: LinkClient | null = null;
    const { hub, outbox, link: started } = setup(
      {
        autoAck: false,
        welcome: (_hello, connection) => (connection.index === 0 ? false : { hubEpoch: 2 }),
      },
      {
        // A backoff would take seconds; this reconnect must not wait for one.
        random: () => 1,
        timings: { backoffBase: 5_000, backoffCap: 5_000 },
        before: (box) => box.append(note('one')),
        handlers: {
          onWelcome: (welcome) => {
            calls.push(`welcome ${welcome.hubEpoch}`);
            if (welcome.hubEpoch === 1) link?.reconnectNow('a restored hub');
          },
          onCommand: async (message) => {
            calls.push(`command ${message.command.kind}`);
            return { ok: true };
          },
        },
      },
    );
    link = started;
    const first = await hub.connection(0);
    await hub.waitFor(() => first.messages.length > 0);
    const at = Date.now();
    first.send(testWelcome(0));
    first.send({ t: 'command', id: '1-R-1-1', seq: 1, command: { kind: 'preflight', vendor: 'claude' } });
    const second = await hub.connection(1, 2_000);
    expect(Date.now() - at).toBeLessThan(2_000);
    await hub.waitFor(() => link?.state === 'online' && link.welcomeSinceGap);
    await hub.waitFor(() => eventsMessages(hub, 1).length > 0);
    // Nothing went out or was handled on the first connection after its welcome: no event, no command, no result.
    expect(kinds(hub, 0)).toEqual(['hello']);
    expect(calls).toEqual(['welcome 1', 'welcome 2']);
    expect(hub.results.size).toBe(0);
    expect(seqs(eventsMessages(hub, 1).flatMap((message) => message.events))).toEqual([1]);
    expect(second.messages[0]?.t).toBe('hello');
    expect(outbox.ackedSeq()).toBe(0);
    await hub.waitFor(() => first.closed);
    expect(first.closed?.code).toBe(1006);
  });

  test('logs and ignores a malformed hub message, and answers an unreadable command unsupported', async () => {
    const { hub, link, logger, commands } = setup();
    await hub.waitFor(() => link.state === 'online');
    const connection = await hub.connection(0);
    connection.sendRaw('not json');
    connection.sendRaw(JSON.stringify({ t: 'nonsense' }));
    connection.sendRaw(JSON.stringify({ t: 'command', id: '1-R-1-9', seq: 9, command: { kind: 'teleport' } }));
    await hub.waitFor(() => hub.results.get('1-R-1-9'));
    expect(hub.results.get('1-R-1-9')).toEqual({ t: 'result', commandId: '1-R-1-9', ok: false, error: 'unsupported' });
    expect(commands).toEqual([]);
    const warnings = logger.entries.filter((entry) => entry.level === 'warn').map((entry) => entry.message);
    expect(warnings).toHaveLength(3);
    expect(link.state).toBe('online');
    expect(hub.connections).toHaveLength(1);
  });

  test('close() closes the socket and never reconnects', async () => {
    const { hub, link } = setup();
    await hub.waitFor(() => link.state === 'online');
    link.close();
    const first = await hub.connection(0);
    await hub.waitFor(() => first.closed);
    expect(first.closed?.code).toBe(1000);
    await Bun.sleep(100);
    expect(hub.connections).toHaveLength(1);
    expect(link.state).toBe('closed');
  });

  test('uses runner.json timings until a welcome overrides them', () => {
    const link = new LinkClient({
      credentials: () => null,
      hubUrl: 'http://127.0.0.1:7000',
      outbox: {} as Outbox,
      clock: new AwakeClock({ gapMs: DEFAULT_TIMINGS.tickGap }),
      timings: DEFAULT_TIMINGS,
      hello: () => {
        throw new Error('not connected');
      },
      heartbeat: () => ({ attempts: [], power: null, disk: null, acceptingUntil: null }),
      handlers: { onCommand: async () => ({ ok: true }) },
    });
    expect(link.timings).toEqual({ heartbeatMs: 15_000, deadLinkMs: 45_000 });
    expect(link.state).toBe('idle');
  });
});
