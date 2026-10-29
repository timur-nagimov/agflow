import { describe, expect, jest, test } from 'bun:test';
import {
  CLOSE_CODES,
  type HubMessage,
  HubMessageSchema,
  PROTOCOL_VERSION,
  RUNNER_COMMAND_KINDS,
  type RunnerCommandKind,
} from '@agflow/core';
import { SESSION_TTL, createSession, sessionHashOf } from '../src/auth';
import { type StoredCommand, enqueueCommand, pendingCommands } from '../src/commands';
import { tx } from '../src/context';
import { listEvents } from '../src/events';
import { BAD_MESSAGE_CLOSE, Gateway, type GatewayOptions, HUB_ERROR_CLOSE, type LinkSocket } from '../src/gateway';
import { findRunnerRow, getRunner, identifyRunner, markRetired, markVendorNotReady } from '../src/runners';
import { type AnswerHooks, FakeConnection, FakeRunner, connectFakeRunner, settle } from './fake-runner';
import { addRunnerAttempt, createTestContext, sampleCommands, testVendor } from './helpers';

type Ctx = ReturnType<typeof createTestContext>['ctx'];

function setup(overrides: Parameters<typeof createTestContext>[0] = {}, options: GatewayOptions = {}) {
  const { ctx, clock } = createTestContext(overrides);
  const gateway = new Gateway(ctx, options);
  const token = createSession(ctx, 'alice', 'cli');
  return { ctx, clock, gateway, token };
}

/** A hub-side socket that records what the gateway does with it. */
function recordingSocket() {
  const sent: HubMessage[] = [];
  const socket: LinkSocket & { closed: { code: number; reason: string } | null; terminated: boolean } = {
    closed: null,
    terminated: false,
    send: (text) => sent.push(JSON.parse(text) as HubMessage),
    close(code, reason) {
      this.closed = { code, reason };
    },
    terminate() {
      this.terminated = true;
    },
  };
  return { socket, sent };
}

const ackedSeq = (ctx: Ctx, runnerId: string, outboxEpoch: string) =>
  (
    ctx.db
      .query('SELECT acked_seq FROM runner_inbox WHERE runner_id = $runnerId AND outbox_epoch = $outboxEpoch')
      .get({ runnerId, outboxEpoch }) as { acked_seq: number } | null
  )?.acked_seq ?? null;

describe('hello and welcome', () => {
  test('hello gets welcome with the runner id, the hub epoch and time, the acked seq and the timings', async () => {
    const { ctx, gateway, token } = setup({ heartbeatMs: 10_000, deadLinkMs: 30_000, handoffMs: 120_000 });
    const runner = await connectFakeRunner(ctx, gateway, { token });
    expect(runner.welcome).toEqual({
      t: 'welcome',
      runnerId: 'R-1',
      hubEpoch: 1,
      hubTime: ctx.now(),
      ackedSeq: 0,
      wipRefPrefix: 'refs/agflow/',
      stop: [],
      timings: { heartbeatMs: 10_000, deadLinkMs: 30_000, handoffMs: 120_000, wipGraceMs: ctx.config.wipGraceMs },
    });
    expect(HubMessageSchema.parse(runner.welcome)).toEqual(runner.welcome as HubMessage);
    expect(gateway.connectionOf('R-1')).toBe(runner.transport?.connection ?? null);
  });

  test('ackedSeq is the larger of the stored position and firstSeq − 1, per outbox epoch', async () => {
    const { ctx, gateway, token } = setup();
    const runner = await connectFakeRunner(ctx, gateway, { token });
    expect(ackedSeq(ctx, 'R-1', 'outbox-1')).toBe(0);
    ctx.db.run("UPDATE runner_inbox SET acked_seq = 5 WHERE runner_id = 'R-1'");
    // The runner still keeps events from seq 3: the hub's position stands.
    for (let n = 0; n < 8; n++) runner.emit('runner.state', { state: 'ok', detail: null });
    runner.outbox = runner.outbox.filter((event) => event.seq >= 3);
    await runner.reconnect();
    expect(runner.welcome?.ackedSeq).toBe(5);
    // Its outbox now starts at 9: everything before was acknowledged and pruned.
    runner.outbox = [];
    await runner.reconnect();
    expect(runner.welcome?.ackedSeq).toBe(8);
    expect(ackedSeq(ctx, 'R-1', 'outbox-1')).toBe(8);
    // A new runner.db starts a new outbox epoch, with its own row, from seq 1.
    runner.disconnect();
    await settle();
    const fresh = await connectFakeRunner(ctx, gateway, { token, outboxEpoch: 'outbox-2' });
    expect(fresh.welcome?.ackedSeq).toBe(0);
    expect(ackedSeq(ctx, 'R-1', 'outbox-2')).toBe(0);
    expect(ackedSeq(ctx, 'R-1', 'outbox-1')).toBe(8);
  });

  test('hello stores info and vendors, confirms the settings, slides the session and emits runner.online', async () => {
    const { ctx, clock, gateway, token } = setup();
    clock.advance(30 * 24 * 60 * 60_000);
    const runner = await connectFakeRunner(ctx, gateway, {
      token,
      name: 'alice-mbp',
      agflowVersion: '0.3.1',
      vendors: ['codex'],
      settings: { capacity: 4 },
    });
    await settle();
    expect(getRunner(ctx, 'R-1')).toMatchObject({
      owner: 'alice',
      name: 'alice-mbp',
      state: 'online',
      agflowVersion: '0.3.1',
      capacity: 4,
      settingsVersion: 1,
      vendors: [{ vendor: 'codex', ready: true }],
    });
    // The new runner's settings come back as version 1, after the welcome.
    expect(runner.received.map((message) => message.t)).toEqual(['welcome', 'command']);
    expect(runner.settings).toMatchObject({ capacity: 4, version: 1 });
    const row = findRunnerRow(ctx, 'R-1');
    expect(row?.session_hash).toBe(sessionHashOf(token));
    const { expires_at } = ctx.db
      .query('SELECT expires_at FROM sessions WHERE token_hash = $hash')
      .get({ hash: sessionHashOf(token) }) as { expires_at: number };
    expect(expires_at).toBe(ctx.now() + SESSION_TTL.cli);
    expect(listEvents(ctx.db).filter((event) => event.type === 'runner.online')).toMatchObject([
      { subject: 'R-1', actor: 'runner:R-1', data: { runnerId: 'R-1', name: 'alice-mbp' } },
    ]);
    // A later hello with the confirmed snapshot queues no settings.
    await runner.reconnect();
    await settle();
    expect(pendingCommands(ctx, 'R-1', PROTOCOL_VERSION)).toHaveLength(1);
  });
});

describe('refusals and replacement', () => {
  test('a second connection with the same key and machine replaces the first with 4409', async () => {
    const { ctx, gateway, token } = setup();
    const first = await connectFakeRunner(ctx, gateway, { token });
    const oldLink = first.transport;
    const second = await connectFakeRunner(ctx, gateway, { token });
    expect(first.closedWith).toEqual({ code: CLOSE_CODES.replaced, reason: 'another connection replaced this one' });
    expect(second.welcome?.runnerId).toBe('R-1');
    expect(gateway.connectionOf('R-1')).toBe(second.transport?.connection ?? null);
    expect(findRunnerRow(ctx, 'R-1')?.connection_id).toBe(second.transport?.connection.id ?? '');
    // A message that still arrives on the replaced link is ignored.
    const before = oldLink?.connection.lastInboundAt;
    gateway.message(oldLink?.connection as NonNullable<typeof oldLink>['connection'], JSON.stringify(first.hello()));
    expect(oldLink?.connection.lastInboundAt).toBe(before as number);
    expect(gateway.connectionOf('R-1')).toBe(second.transport?.connection ?? null);
  });

  test('another owner or machine and a retired runner get 4403; a protocol out of range 4426', async () => {
    const { ctx, gateway, token } = setup();
    await connectFakeRunner(ctx, gateway, { token });
    const bob = createSession(ctx, 'bob', 'cli');
    const stranger = await connectFakeRunner(ctx, gateway, { token: bob });
    expect(stranger.welcome).toBeNull();
    expect(stranger.closedWith).toEqual({
      code: CLOSE_CODES.refused,
      reason: 'this runner belongs to alice on another machine; run agflow runner setup',
    });
    const newer = await connectFakeRunner(ctx, gateway, { token, runnerKey: 'key-2', protocol: PROTOCOL_VERSION + 1 });
    expect(newer.closedWith?.code).toBe(CLOSE_CODES.incompatible);
    expect(newer.closedWith?.reason).toContain(`this hub accepts protocol 1 to ${PROTOCOL_VERSION}`);
  });

  test('a hello the hub cannot read is refused with 4426 when its protocol is out of range', async () => {
    const { ctx, gateway, token } = setup();
    const session = { user: 'alice', sessionHash: sessionHashOf(token) };
    // A runner the hub knows, with no link.
    const known = new FakeRunner<FakeConnection>((endpoint) => new FakeConnection(gateway, session, endpoint));
    expect(identifyRunner(ctx, 'alice', known.hello()).ok).toBe(true);
    const { socket } = recordingSocket();
    const connection = gateway.open(socket, session);
    const unreadable = { t: 'hello', protocol: PROTOCOL_VERSION + 1, runnerKey: 'runner-key-1', machineId: 'machine-1' };
    gateway.message(connection, JSON.stringify(unreadable));
    expect(socket.closed?.code).toBe(CLOSE_CODES.incompatible);
    expect(getRunner(ctx, 'R-1').state).toBe('incompatible');
  });

  test('a first message that is not a readable hello closes the link', () => {
    const { ctx, gateway, token } = setup();
    const session = { user: 'alice', sessionHash: sessionHashOf(token) };
    for (const text of ['not json', JSON.stringify({ t: 'heartbeat', at: 1 }), JSON.stringify({ t: 'hello' })]) {
      const { socket, sent } = recordingSocket();
      gateway.message(gateway.open(socket, session), text);
      expect(socket.closed?.code).toBe(BAD_MESSAGE_CLOSE);
      expect(sent).toEqual([]);
    }
    const { socket } = recordingSocket();
    const heartbeat = { t: 'heartbeat', at: 1, attempts: [], power: null, disk: null, acceptingUntil: null };
    gateway.message(gateway.open(socket, session), JSON.stringify(heartbeat));
    expect(socket.closed).toEqual({ code: BAD_MESSAGE_CLOSE, reason: 'the first message must be hello' });
    expect(ctx.db.query('SELECT COUNT(*) AS n FROM runners').get()).toEqual({ n: 0 });
  });
});

describe('known runners and broken links', () => {
  test("a known runner's hello refreshes its name, version, git and vendors", async () => {
    const { ctx, clock, gateway, token } = setup();
    const runner = await connectFakeRunner(ctx, gateway, { token });
    runner.disconnect();
    await settle();
    // Failed WIP pushes stopped its git, and two failed starts marked codex not ready.
    ctx.db.run(
      `UPDATE runners SET info = json_set(info, '$.git', json('{"ready":false,"problem":"push refused","lastPushAt":null}'))
       WHERE id = 'R-1'`,
    );
    tx(ctx, () => markVendorNotReady(ctx, 'R-1', 'codex'));
    clock.advance(5_000);
    const again = await connectFakeRunner(ctx, gateway, {
      token,
      name: 'alice-mbp',
      agflowVersion: '0.3.1',
      vendors: ['claude', { ...testVendor('codex'), preflightAt: ctx.now() - 1_000 }],
    });
    expect(again.welcome?.runnerId).toBe('R-1');
    expect(getRunner(ctx, 'R-1')).toMatchObject({
      name: 'alice-mbp',
      agflowVersion: '0.3.1',
      git: { ready: true, problem: null },
      vendors: [
        { vendor: 'claude', ready: true },
        { vendor: 'codex', ready: true },
      ],
      lastSeenAt: ctx.now(),
    });
  });

  test('a hello carries the platform, profile, git and quota the runner reports', async () => {
    const { ctx, gateway, token } = setup();
    const quota = [
      {
        vendor: 'claude' as const,
        accountId: testVendor('claude').accountId as string,
        quota: {
          state: 'ok' as const,
          resetsAt: null,
          windows: { fiveHour: 0.2, weekly: 0.4 },
          paidUsage: 'disabled' as const,
          updatedAt: ctx.now(),
        },
      },
    ];
    const runner = await connectFakeRunner(ctx, gateway, {
      token,
      platform: 'linux-x64',
      profile: { name: 'auto', weakened: ['network'], dependencyPrep: false },
      git: () => ({ ready: false, problem: 'no push credentials', lastPushAt: null }),
      quota: () => quota,
    });
    expect(runner.transport?.toHub[0]).toMatchObject({ t: 'hello', quota });
    expect(getRunner(ctx, 'R-1')).toMatchObject({
      platform: 'linux-x64',
      profile: { name: 'auto', weakened: ['network'], dependencyPrep: false },
      git: { ready: false, problem: 'no push credentials' },
    });
  });

  test('a second hello on a welcomed link closes it', async () => {
    const { ctx, gateway, token } = setup();
    const runner = await connectFakeRunner(ctx, gateway, { token });
    runner.sendRaw(JSON.stringify(runner.hello()));
    await settle();
    expect(runner.closedWith).toEqual({ code: BAD_MESSAGE_CLOSE, reason: 'hello was already received on this link' });
    expect(gateway.connectionOf('R-1')).toBeNull();
  });

  test('an unreadable message after hello is logged and ignored, so the runner does not reconnect in a loop', async () => {
    const logged: string[] = [];
    const { ctx, gateway, token } = setup({}, { log: (message) => logged.push(message) });
    const runner = await connectFakeRunner(ctx, gateway, { token });
    runner.sendRaw('not json');
    await settle();
    expect(runner.connected).toBe(true);
    expect(logged).toEqual([expect.stringContaining('runner R-1 sent a message the hub cannot read')]);
  });

  test('a hello the hub fails to process closes the link with 1011 and registers nothing', async () => {
    const logged: string[] = [];
    const { ctx, gateway, token } = setup({}, { log: (message) => logged.push(message) });
    ctx.db.run('DROP TABLE runner_inbox');
    const runner = await connectFakeRunner(ctx, gateway, { token });
    expect(runner.closedWith).toEqual({ code: HUB_ERROR_CLOSE, reason: 'the hub could not process hello' });
    expect(gateway.connectionOf('R-1')).toBeNull();
    expect(ctx.db.query('SELECT COUNT(*) AS n FROM runners').get()).toEqual({ n: 0 });
    expect(logged).toEqual(['hello from runner key runner-key-1 failed']);
  });

  test('retiring a connected runner closes its link with 4403, and its next hello is refused', async () => {
    const { ctx, gateway, token } = setup();
    const runner = await connectFakeRunner(ctx, gateway, { token });
    const retired = { code: CLOSE_CODES.refused, reason: 'this runner was retired; run agflow runner setup' };
    tx(ctx, (emit) => markRetired(ctx, emit, 'R-1', 'user:alice'));
    await settle();
    expect(runner.closedWith).toEqual(retired);
    expect(gateway.connectionOf('R-1')).toBeNull();
    expect(await runner.connect()).toBeNull();
    expect(runner.closedWith).toEqual(retired);
  });

  test('a command that cannot be built stops the flush there, and the link sends the others later', async () => {
    const logged: string[] = [];
    const { ctx, gateway, token } = setup({}, { log: (message) => logged.push(message) });
    const runner = await connectFakeRunner(ctx, gateway, { token });
    const kinds = () => runner.commands.map((message) => message.command.kind);
    const sentAt = (id: string | undefined) =>
      (ctx.db.query('SELECT sent_at FROM runner_commands WHERE id = $id').get({ id: id ?? '' }) as { sent_at: number | null })
        .sent_at;
    // A resume whose attempt the hub cannot find has no token to carry.
    const [preflight, broken] = tx(ctx, () => [
      enqueueCommand(ctx, 'R-1', { kind: 'preflight', vendor: 'claude' }),
      enqueueCommand(ctx, 'R-1', {
        kind: 'resume_attempt',
        attemptId: 'T-9-a1',
        fence: { epoch: 1, counter: 1 },
        prompt: 'Continue.',
        messages: [],
        taskPack: null,
        restore: { paths: [], base: 'refs/heads/main' },
        acceptanceIds: [],
      }),
      enqueueCommand(ctx, 'R-1', { kind: 'preflight', vendor: 'codex' }),
    ]);
    await settle();
    expect(kinds()).toEqual(['update_settings', 'preflight']);
    expect([sentAt(preflight?.id), sentAt(broken?.id)]).toEqual([ctx.now(), null]);
    expect(logged).toEqual([`building command ${broken?.id} for runner R-1 failed`]);
    // Once the broken command is cancelled, the next flush sends what waited behind it.
    tx(ctx, () => {
      ctx.db.query("UPDATE runner_commands SET status = 'cancelled' WHERE id = $id").run({ id: broken?.id ?? '' });
      enqueueCommand(ctx, 'R-1', { kind: 'cleanup_attempt', attemptId: 'T-1-a1' });
    });
    await settle();
    expect(kinds()).toEqual(['update_settings', 'preflight', 'preflight', 'cleanup_attempt']);
  });
});

describe('commands on the link', () => {
  test('pending commands follow every welcome in seq order; later ones arrive once their transaction commits', async () => {
    const { ctx, gateway, token } = setup();
    const runner = await connectFakeRunner(ctx, gateway, { token });
    // The runner answered the settings echo (seq 1).
    ctx.db.run("UPDATE runner_commands SET status = 'done'");
    runner.disconnect();
    await settle();
    tx(ctx, () => {
      enqueueCommand(ctx, 'R-1', { kind: 'preflight', vendor: 'claude' });
      enqueueCommand(ctx, 'R-1', { kind: 'preflight', vendor: 'codex' });
    });
    await runner.connect();
    await settle();
    const seqs = () => runner.commands.map((message) => message.seq);
    expect(seqs()).toEqual([1, 2, 3]);
    // Results are not recorded yet, so the next welcome resends them, and the journal answers the same.
    await runner.reconnect();
    await settle();
    expect(seqs()).toEqual([1, 2, 3, 2, 3]);
    // A command queued while connected goes out after its commit, and never after a rollback.
    expect(() =>
      tx(ctx, () => {
        enqueueCommand(ctx, 'R-1', { kind: 'preflight', vendor: 'claude' });
        throw new Error('rolled back');
      }),
    ).toThrow('rolled back');
    tx(ctx, () => enqueueCommand(ctx, 'R-1', { kind: 'cleanup_attempt', attemptId: 'T-1-a1' }));
    await settle();
    expect(seqs()).toEqual([1, 2, 3, 2, 3, 4]);
    expect(pendingCommands(ctx, 'R-1', PROTOCOL_VERSION).map((row) => row.sentAt)).toEqual([
      ctx.now(),
      ctx.now(),
      ctx.now(),
    ]);
  });
});

describe('FakeRunner', () => {
  test('replays the events after welcome.ackedSeq and drops acknowledged ones', async () => {
    const { ctx, gateway, token } = setup();
    const runner = await connectFakeRunner(ctx, gateway, { token });
    runner.disconnect();
    await settle();
    for (let n = 0; n < 3; n++) runner.emit('runner.state', { state: 'ok', detail: `event ${n + 1}` });
    expect(runner.hello()).toMatchObject({ firstSeq: 1, lastSeq: 3 });
    ctx.db.run("UPDATE runner_inbox SET acked_seq = 2 WHERE runner_id = 'R-1'");
    await runner.connect();
    await settle();
    const link = runner.transport;
    expect(link?.toHub.filter((message) => message.t === 'events')).toEqual([
      { t: 'events', outboxEpoch: 'outbox-1', events: [expect.objectContaining({ seq: 3, type: 'runner.state' })] },
    ]);
    expect(runner.outbox.map((event) => event.seq)).toEqual([3]);
    // A cumulative ack drops what it covers; events emitted on a live link go out at once.
    runner.emit('runner.state', { state: 'disk_low', detail: 'low' });
    link?.socket.send(JSON.stringify({ t: 'ack', outboxEpoch: 'outbox-1', seq: 3 }));
    await settle();
    expect(runner.outbox.map((event) => event.seq)).toEqual([4]);
    expect(runner.hello()).toMatchObject({ firstSeq: 4, lastSeq: 4 });
    expect(link?.toHub.at(-1)).toMatchObject({ t: 'events', events: [{ seq: 4 }] });
  });

  test('answers each of the 17 kinds by default, unless a hook replaces the answer', async () => {
    const { ctx, gateway, token } = setup();
    // The helper's runner has the FakeRunner's default key and machine; its settings are confirmed already.
    const { runner: owner, attempt } = addRunnerAttempt(ctx);
    ctx.db.run(`UPDATE runners SET settings_version = 1 WHERE id = '${owner.id}'`);
    const hooked: RunnerCommandKind[] = [];
    const answers: AnswerHooks = {
      preflight: (command, runner) => {
        hooked.push(command.kind);
        runner.emit('runner.state', { state: 'ok', detail: `preflight ${command.vendor}` });
        return { ok: false, error: 'binary missing' };
      },
    };
    const runner = await connectFakeRunner(ctx, gateway, { token, answers, settings: { version: 1 } });
    const commands = sampleCommands(attempt);
    tx(ctx, () => {
      for (const kind of RUNNER_COMMAND_KINDS) enqueueCommand(ctx, owner.id, commands[kind] as StoredCommand);
    });
    await settle();
    const results = runner.transport?.toHub.filter((message) => message.t === 'result') ?? [];
    const byKind = new Map(
      runner.commands.map((message) => [
        message.command.kind,
        results.find((result) => result.t === 'result' && result.commandId === message.id),
      ]),
    );
    expect([...byKind.keys()]).toEqual([...RUNNER_COMMAND_KINDS]);
    for (const kind of RUNNER_COMMAND_KINDS) {
      const expected =
        kind === 'preflight'
          ? { ok: false, error: 'binary missing' }
          : kind === 'decide_approval'
            ? { ok: true, data: { applied: true } }
            : { ok: true };
      expect([kind, byKind.get(kind)]).toEqual([kind, { t: 'result', commandId: expect.any(String), ...expected }]);
    }
    expect(hooked).toEqual(['preflight']);
    // Starts and resumes bring tokens, kept per attempt; settings echoes update the snapshot.
    expect(runner.tokens.get(attempt.id)).toStartWith('agt_');
    expect(runner.settings).toMatchObject({ capacity: 3, version: 2 });
    expect(runner.outbox.at(-1)).toMatchObject({ type: 'runner.state', data: { detail: 'preflight codex' } });
  });

  test('with automatic heartbeats it sends one every welcome.timings.heartbeatMs while linked', async () => {
    const { ctx, gateway, token } = setup({ heartbeatMs: 15_000 });
    const session = { user: 'alice', sessionHash: sessionHashOf(token) };
    jest.useFakeTimers();
    try {
      const runner = new FakeRunner<FakeConnection>((endpoint) => new FakeConnection(gateway, session, endpoint), {
        now: ctx.now,
        heartbeats: 'auto',
        acceptingUntil: () => 60_000,
      });
      // Connecting takes only microtasks, which fake timers leave alone.
      await runner.connect();
      const link = runner.transport;
      const heartbeats = () => link?.toHub.filter((message) => message.t === 'heartbeat') ?? [];
      jest.advanceTimersByTime(45_000);
      expect(heartbeats()).toHaveLength(3);
      expect(heartbeats()[0]).toMatchObject({ at: ctx.now(), attempts: [], acceptingUntil: 60_000 });
      runner.disconnect();
      jest.advanceTimersByTime(45_000);
      expect(heartbeats()).toHaveLength(3);
    } finally {
      jest.useRealTimers();
    }
  });

  test("welcome.stop ends an attempt's lifecycle commands, but not those that outlive it", async () => {
    const { ctx, gateway, token } = setup();
    const runner = await connectFakeRunner(ctx, gateway, { token });
    const link = runner.transport;
    const welcome = runner.welcome as NonNullable<typeof runner.welcome>;
    link?.socket.send(JSON.stringify({ ...welcome, stop: [{ attemptId: 'T-1-a1', reason: 'lost' }] }));
    const fence = { epoch: 1, counter: 1 };
    const commands = [
      { kind: 'interrupt', attemptId: 'T-1-a1', fence },
      { kind: 'upload_transcript', attemptId: 'T-1-a1' },
      { kind: 'hand_back', attemptId: 'T-1-a1', source: { kind: 'clone' } },
      { kind: 'cleanup_attempt', attemptId: 'T-1-a1' },
    ];
    commands.forEach((command, n) => {
      link?.socket.send(JSON.stringify({ t: 'command', id: `1-R-1-${90 + n}`, seq: 90 + n, command }));
    });
    await settle();
    expect(runner.stopped).toEqual(new Set(['T-1-a1']));
    const results = link?.toHub.filter((message) => message.t === 'result').slice(-4);
    expect(results).toEqual([
      { t: 'result', commandId: '1-R-1-90', ok: false, error: 'attempt_ended' },
      { t: 'result', commandId: '1-R-1-91', ok: true },
      { t: 'result', commandId: '1-R-1-92', ok: true },
      { t: 'result', commandId: '1-R-1-93', ok: true },
    ]);
  });

  test('a command it cannot read is answered unsupported', async () => {
    const { ctx, gateway, token } = setup();
    const runner = await connectFakeRunner(ctx, gateway, { token });
    const teleport = { t: 'command', id: '1-R-1-50', seq: 50, command: { kind: 'teleport' } };
    runner.transport?.socket.send(JSON.stringify(teleport));
    await settle();
    expect(runner.transport?.toHub.at(-1)).toEqual({ t: 'result', commandId: '1-R-1-50', ok: false, error: 'unsupported' });
  });

  test('its journal answers a resent command with the first result, and it keeps the hub epoch', async () => {
    const { ctx, gateway, token } = setup();
    let calls = 0;
    const runner = await connectFakeRunner(ctx, gateway, {
      token,
      answers: { preflight: () => ({ ok: true, data: { call: ++calls } }) },
    });
    expect(runner.hello().lastHubEpoch).toBe(runner.welcome?.hubEpoch ?? -1);
    const preflight = tx(ctx, () => enqueueCommand(ctx, 'R-1', { kind: 'preflight', vendor: 'claude' }));
    await settle();
    // The result was lost with the link: the command is pending again and goes out after the next welcome.
    ctx.db.query("UPDATE runner_commands SET status = 'pending' WHERE id = $id").run({ id: preflight.id });
    await runner.reconnect();
    await settle();
    expect(calls).toBe(1);
    const results = runner.transport?.toHub.filter((message) => message.t === 'result' && message.commandId === preflight.id);
    expect(results).toEqual([{ t: 'result', commandId: preflight.id, ok: true, data: { call: 1 } }]);
  });
});
