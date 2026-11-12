import { describe, expect, test } from 'bun:test';
import {
  CLOSE_CODES,
  PROTOCOL_VERSION,
  type RunnerMessage,
  RunnerSchema,
  type RunnerSettings,
  type RunnerState,
  type RunnerVendor,
  TEST_ACCOUNT_ID,
} from '@agflow/core';
import { createSession, sessionHashOf } from '../src/auth';
import { pendingCommands } from '../src/commands';
import { tx } from '../src/context';
import { applyRunnerEvents, EVENT_HANDLERS } from '../src/events-in';
import { listEvents } from '../src/events';
import {
  type RunnerRow,
  applyRunnerSettings,
  applyVendorReport,
  checkRunnerIdentity,
  deriveRunnerState,
  findRunner,
  findRunnerByKey,
  findRunnerRow,
  getRunner,
  identifyRunner,
  listRunners,
  markLinked,
  markRetired,
  markUnlinked,
  markVendorNotReady,
  patchRunnerSettings,
  reconcileHelloSettings,
  recordFailedStart,
  refreshNeedsLogin,
  resetFailedStarts,
  runnerSettings,
  setDegraded,
  vendorHolds,
} from '../src/runners';
import { addRunnerAttempt, createTestContext } from './helpers';

type Ctx = ReturnType<typeof createTestContext>['ctx'];
type Hello = Extract<RunnerMessage, { t: 'hello' }>;

const DAY = 24 * 60 * 60_000;

const eventsOf = (ctx: Ctx, type: string) => listEvents(ctx.db).filter((event) => event.type === type);

function vendor(overrides: Partial<RunnerVendor> = {}): RunnerVendor {
  return {
    vendor: 'claude',
    cliVersion: '2.1.285',
    ownerCliVersion: '2.1.280',
    ready: true,
    problem: null,
    accountId: TEST_ACCOUNT_ID,
    plan: 'Claude Max',
    managedPolicy: false,
    models: { lead: 'claude-opus-5-5', worker: 'claude-sonnet-5-5' },
    ceilings: { fiveHour: 0.85, weekly: 0.85 },
    allowPaidUsage: false,
    degraded: false,
    preflightAt: 1_000,
    ...overrides,
  };
}

function hello(overrides: Partial<Hello> = {}): Hello {
  return {
    t: 'hello',
    protocol: PROTOCOL_VERSION,
    runnerKey: 'key-1',
    machineId: 'machine-1',
    name: 'alice-laptop',
    agflowVersion: '0.2.0',
    platform: 'darwin-arm64',
    settings: { capacity: 3, keepAwake: 'always', draining: false, ceilings: {}, allowPaidUsage: {}, version: 0 },
    vendors: [vendor()],
    quota: [],
    profile: { name: 'standard', weakened: ['/tmp/claude'], dependencyPrep: true },
    git: { ready: true, problem: null, lastPushAt: null },
    state: 'ok',
    stateDetail: null,
    outboxEpoch: 'outbox-1',
    firstSeq: 1,
    lastSeq: 0,
    lastHubEpoch: null,
    attempts: [],
    ...overrides,
  };
}

/** Registers a runner for alice and links it on a CLI session, the way a first hello does. */
function linkedRunner(ctx: Ctx, overrides: Partial<Hello> = {}) {
  const token = createSession(ctx, 'alice', 'cli');
  const result = identifyRunner(ctx, 'alice', hello(overrides));
  if (!result.ok) throw new Error(result.reason);
  tx(ctx, (emit) =>
    markLinked(ctx, emit, result.runner.id, {
      connectionId: 'conn-1',
      sessionHash: sessionHashOf(token),
      state: overrides.state ?? 'ok',
      stateDetail: overrides.stateDetail ?? null,
    }),
  );
  return { runner: getRunner(ctx, result.runner.id), token };
}

describe('identity', () => {
  test('an unknown key registers a runner owned by the session user and bound to its machine', () => {
    const { ctx } = createTestContext();
    const first = identifyRunner(ctx, 'alice', hello());
    expect(first).toMatchObject({ ok: true, registered: true, runner: { id: 'R-1', owner: 'alice' } });
    expect(findRunnerByKey(ctx, 'key-1')).toMatchObject({ id: 'R-1', machine_id: 'machine-1', owner: 'alice' });
    // The same key from the same user and machine is the same runner.
    expect(identifyRunner(ctx, 'alice', hello({ name: 'renamed' }))).toMatchObject({
      ok: true,
      registered: false,
      runner: { id: 'R-1' },
    });
    expect(identifyRunner(ctx, 'alice', hello({ runnerKey: 'key-2' }))).toMatchObject({ ok: true, runner: { id: 'R-2' } });
    const runner = getRunner(ctx, 'R-1');
    expect(runner).toMatchObject({
      owner: 'alice',
      name: 'alice-laptop',
      state: 'offline',
      capacity: 3,
      keepAwake: 'always',
      draining: false,
      // Settings sync assigns the first version.
      settingsVersion: 0,
      protocol: PROTOCOL_VERSION,
      agflowVersion: '0.2.0',
      platform: 'darwin-arm64',
      createdAt: ctx.now(),
    });
    expect(RunnerSchema.parse(runner)).toEqual(runner);
  });

  test('another user or another machine is refused, and the owner never changes', () => {
    const { ctx } = createTestContext();
    identifyRunner(ctx, 'alice', hello());
    const refusal = {
      ok: false,
      code: CLOSE_CODES.refused,
      reason: 'this runner belongs to alice on another machine; run agflow runner setup',
    } as const;
    expect(identifyRunner(ctx, 'bob', hello())).toEqual(refusal);
    expect(identifyRunner(ctx, 'alice', hello({ machineId: 'machine-2' }))).toEqual(refusal);
    expect(checkRunnerIdentity(ctx, 'bob', { protocol: 1, runnerKey: 'key-1', machineId: 'machine-1' })).toEqual(refusal);
    expect(getRunner(ctx, 'R-1').owner).toBe('alice');
  });

  test('a retired runner is refused', () => {
    const { ctx } = createTestContext();
    identifyRunner(ctx, 'alice', hello());
    tx(ctx, (emit) => markRetired(ctx, emit, 'R-1', 'user:alice'));
    expect(identifyRunner(ctx, 'alice', hello())).toEqual({
      ok: false,
      code: CLOSE_CODES.refused,
      reason: 'this runner was retired; run agflow runner setup',
    });
  });

  test('a protocol outside the range is refused naming the minimum, and the runner reads incompatible', () => {
    const { ctx } = createTestContext({ minProtocol: 1 });
    const newer = PROTOCOL_VERSION + 1;
    const reason = `runner protocol ${newer} is not supported: this hub accepts protocol 1 to ${PROTOCOL_VERSION}`;
    // An unknown runner is refused without registering it.
    expect(identifyRunner(ctx, 'alice', hello({ protocol: newer }))).toEqual({
      ok: false,
      code: CLOSE_CODES.incompatible,
      reason,
    });
    expect(listRunners(ctx)).toEqual([]);
    linkedRunner(ctx);
    tx(ctx, (emit) => markUnlinked(ctx, emit, 'R-1', 'conn-1'));
    // A hello the hub cannot read still gives its protocol, key and machine.
    expect(checkRunnerIdentity(ctx, 'alice', { protocol: newer, runnerKey: 'key-1', machineId: 'machine-1' })).toEqual({
      ok: false,
      code: CLOSE_CODES.incompatible,
      reason,
    });
    expect(getRunner(ctx, 'R-1')).toMatchObject({ state: 'incompatible', stateDetail: reason, protocol: newer });
    // A supported protocol links it again.
    linkedRunner(ctx);
    expect(getRunner(ctx, 'R-1')).toMatchObject({ state: 'online', protocol: PROTOCOL_VERSION });
  });

  test('a refused hello leaves a linked runner as it is', () => {
    const { ctx } = createTestContext();
    linkedRunner(ctx);
    // A second process with the same key and machine, at a protocol this hub does not speak yet.
    const newer = { protocol: PROTOCOL_VERSION + 1, runnerKey: 'key-1', machineId: 'machine-1' };
    expect(checkRunnerIdentity(ctx, 'alice', newer)).toMatchObject({ ok: false, code: CLOSE_CODES.incompatible });
    expect(getRunner(ctx, 'R-1')).toMatchObject({ state: 'online', stateDetail: null, protocol: PROTOCOL_VERSION });
  });

  test('a protocol below minProtocol is refused too', () => {
    const { ctx } = createTestContext({ minProtocol: 2 });
    expect(identifyRunner(ctx, 'alice', hello({ protocol: 1 }))).toMatchObject({
      ok: false,
      code: CLOSE_CODES.incompatible,
      reason: expect.stringContaining('this hub accepts protocol 2 to'),
    });
  });
});

describe('state', () => {
  test('offline without a link, needs_login when its session no longer verifies, as reported otherwise', () => {
    const cases: [Parameters<typeof deriveRunnerState>[0], RunnerState][] = [
      [{ linked: false, sessionValid: true, reported: 'ok' }, 'offline'],
      [{ linked: false, sessionValid: true, reported: 'crash_loop' }, 'offline'],
      [{ linked: false, sessionValid: false, reported: 'ok' }, 'needs_login'],
      [{ linked: true, sessionValid: true, reported: 'ok' }, 'online'],
      [{ linked: true, sessionValid: true, reported: 'crash_loop' }, 'crash_loop'],
      [{ linked: true, sessionValid: true, reported: 'disk_low' }, 'disk_low'],
    ];
    for (const [input, state] of cases) expect<unknown>([input, deriveRunnerState(input)]).toEqual([input, state]);
  });

  test('a link makes the runner online, or what it reports, and draining stays a flag', () => {
    const { ctx } = createTestContext();
    const { runner } = linkedRunner(ctx, { state: 'disk_low', stateDetail: '4 GB free' });
    expect(runner).toMatchObject({ state: 'disk_low', stateDetail: '4 GB free', lastError: '4 GB free' });
    expect(findRunner(ctx, runner.id)?.state).toBe('disk_low');
    const online = linkedRunner(ctx).runner;
    // The last report that was not ok stays readable.
    expect(online).toMatchObject({ state: 'online', stateDetail: null, lastError: '4 GB free', draining: false });
    ctx.db.run("UPDATE runners SET draining = 1 WHERE id = 'R-1'");
    expect(getRunner(ctx, 'R-1')).toMatchObject({ state: 'online', draining: true });
  });

  test('a closed link leaves the runner offline, or needs_login once its session no longer verifies', () => {
    const { ctx, clock } = createTestContext();
    const { runner } = linkedRunner(ctx);
    // A close from a connection that is not the runner's link changes nothing.
    expect(tx(ctx, (emit) => markUnlinked(ctx, emit, runner.id, 'conn-old'))).toBe(false);
    expect(getRunner(ctx, runner.id).state).toBe('online');
    expect(tx(ctx, (emit) => markUnlinked(ctx, emit, runner.id, 'conn-1'))).toBe(true);
    expect(getRunner(ctx, runner.id).state).toBe('offline');
    expect(eventsOf(ctx, 'runner.offline').map((event) => [event.subject, event.data])).toEqual([
      [runner.id, { runnerId: runner.id, name: 'alice-laptop', state: 'offline' }],
    ]);
    // The session expires while the runner is away: the auth sweep marks it.
    clock.advance(91 * DAY);
    expect(refreshNeedsLogin(ctx)).toEqual([runner.id]);
    expect(getRunner(ctx, runner.id).state).toBe('needs_login');
    expect(refreshNeedsLogin(ctx)).toEqual([]);
    expect(eventsOf(ctx, 'runner.offline').at(-1)?.data).toEqual({
      runnerId: runner.id,
      name: 'alice-laptop',
      state: 'needs_login',
    });
    // A link whose session expired while it was up reads needs_login at once when it closes.
    linkedRunner(ctx);
    clock.advance(91 * DAY);
    tx(ctx, (emit) => markUnlinked(ctx, emit, runner.id, 'conn-1'));
    expect(getRunner(ctx, runner.id).state).toBe('needs_login');
  });

  test('refreshNeedsLogin leaves linked, incompatible and retired runners alone', () => {
    const { ctx, clock } = createTestContext();
    linkedRunner(ctx);
    linkedRunner(ctx, { runnerKey: 'key-2' });
    linkedRunner(ctx, { runnerKey: 'key-3' });
    tx(ctx, (emit) => {
      markUnlinked(ctx, emit, 'R-2', 'conn-1');
      markRetired(ctx, emit, 'R-2', 'user:alice');
      markUnlinked(ctx, emit, 'R-3', 'conn-1');
    });
    const newer = { protocol: PROTOCOL_VERSION + 1, runnerKey: 'key-3', machineId: 'machine-1' };
    expect(checkRunnerIdentity(ctx, 'alice', newer)).toMatchObject({ ok: false });
    clock.advance(91 * DAY);
    expect(refreshNeedsLogin(ctx)).toEqual([]);
    expect(getRunner(ctx, 'R-1').state).toBe('online');
    expect(getRunner(ctx, 'R-3').state).toBe('incompatible');
  });
});

describe('the runner view', () => {
  test('rowToRunner reports versions, platform, vendors, profile, git, power, disk and its open attempts', () => {
    const { ctx } = createTestContext();
    const { runner } = linkedRunner(ctx);
    expect(runner).toMatchObject({
      id: 'R-1',
      vendors: [vendor()],
      profile: { name: 'standard', weakened: ['/tmp/claude'], dependencyPrep: true },
      git: { ready: true, problem: null, lastPushAt: null },
      power: null,
      disk: null,
      acceptingUntil: null,
      activeAttempts: 0,
      lastSeenAt: ctx.now(),
    });
    ctx.db.run(
      `UPDATE runners SET accepting_until = 5000, info = json_set(info, '$.power', json('{"source":"battery","batteryPercent":40,"lowPowerMode":false}'),
         '$.disk', json('{"freeBytes":1000,"agflowBytes":10}')) WHERE id = 'R-1'`,
    );
    const first = addRunnerAttempt(ctx, { runnerId: 'R-1' });
    addRunnerAttempt(ctx, { runnerId: 'R-1' });
    // Holding and ended attempts take no slot.
    tx(ctx, () => ctx.db.query("UPDATE attempts SET status = 'holding' WHERE id = $id").run({ id: first.attempt.id }));
    const read = getRunner(ctx, 'R-1');
    expect(read).toMatchObject({
      power: { source: 'battery', batteryPercent: 40, lowPowerMode: false },
      disk: { freeBytes: 1000, agflowBytes: 10 },
      acceptingUntil: 5000,
      activeAttempts: 1,
    });
    expect(RunnerSchema.parse(read)).toEqual(read);
  });

  test("the hub's vendor holds decide degraded and not ready, whatever the runner reports", () => {
    const { ctx } = createTestContext();
    linkedRunner(ctx, { vendors: [vendor({ degraded: true }), vendor({ vendor: 'codex', models: { lead: 'g', worker: 'g' } })] });
    expect(getRunner(ctx, 'R-1').vendors.map((entry) => [entry.vendor, entry.degraded, entry.ready])).toEqual([
      ['claude', false, true],
      ['codex', false, true],
    ]);
    const holds = {
      claude: { degradedUntil: ctx.now() + 1, failedStarts: 0, notReadySince: null },
      codex: { degradedUntil: ctx.now(), failedStarts: 1, notReadySince: ctx.now() - 5 },
    };
    ctx.db.query("UPDATE runners SET vendor_holds = $holds WHERE id = 'R-1'").run({ holds: JSON.stringify(holds) });
    expect(getRunner(ctx, 'R-1').vendors).toMatchObject([
      { vendor: 'claude', degraded: true, ready: true },
      // A degraded mark ends at its time; a not-ready mark holds until a later preflight passes.
      { vendor: 'codex', degraded: false, ready: false, problem: 'marked not ready by the hub until a preflight passes' },
    ]);
  });

  test('settings with no column come from the hub-confirmed copy', () => {
    const { ctx } = createTestContext();
    linkedRunner(ctx, {
      settings: {
        capacity: 2,
        keepAwake: 'ac',
        draining: false,
        ceilings: { claude: { fiveHour: 0.5, weekly: 0.6 } },
        allowPaidUsage: { claude: true },
        version: 0,
      },
    });
    expect(getRunner(ctx, 'R-1').vendors[0]).toMatchObject({ ceilings: { fiveHour: 0.5, weekly: 0.6 }, allowPaidUsage: true });
  });

  test('listRunners leaves out retired runners unless asked; findRunner answers null for an unknown id', () => {
    const { ctx } = createTestContext();
    linkedRunner(ctx);
    linkedRunner(ctx, { runnerKey: 'key-2' });
    expect(tx(ctx, (emit) => markRetired(ctx, emit, 'R-1', 'user:alice'))).toBe(true);
    expect(tx(ctx, (emit) => markRetired(ctx, emit, 'R-1', 'user:alice'))).toBe(false);
    expect(listRunners(ctx).map((runner) => runner.id)).toEqual(['R-2']);
    expect(listRunners(ctx, { retired: true }).map((runner) => runner.id)).toEqual(['R-1', 'R-2']);
    expect(eventsOf(ctx, 'runner.retired').map((event) => event.data)).toEqual([
      { runnerId: 'R-1', name: 'alice-laptop' },
    ]);
    expect(findRunner(ctx, 'R-9')).toBeNull();
    expect(() => getRunner(ctx, 'R-9')).toThrow('runner R-9 not found');
  });

  test('retiring a runner closes its link with 4403 once the transaction commits', () => {
    const { ctx } = createTestContext();
    linkedRunner(ctx);
    const closed: [string, number, string][] = [];
    ctx.link = { flush: () => {}, closeRunner: (...args) => closed.push(args) };
    expect(() =>
      tx(ctx, (emit) => {
        markRetired(ctx, emit, 'R-1', 'user:alice');
        throw new Error('rolled back');
      }),
    ).toThrow('rolled back');
    expect(closed).toEqual([]);
    tx(ctx, (emit) => markRetired(ctx, emit, 'R-1', 'user:alice'));
    expect(closed).toEqual([['R-1', CLOSE_CODES.refused, 'this runner was retired; run agflow runner setup']]);
  });
});

describe('settings sync', () => {
  const settings = (overrides: Partial<RunnerSettings> = {}): RunnerSettings => ({
    capacity: 3,
    keepAwake: 'always',
    draining: false,
    ceilings: {},
    allowPaidUsage: {},
    version: 0,
    ...overrides,
  });
  const settingsCommands = (ctx: Ctx, runnerId = 'R-1') =>
    pendingCommands(ctx, runnerId, PROTOCOL_VERSION)
      .map((row) => row.command)
      .filter((command) => command.kind === 'update_settings');

  function registered(ctx: Ctx, reported = settings()) {
    const result = identifyRunner(ctx, 'alice', hello({ settings: reported }));
    if (!result.ok) throw new Error(result.reason);
    return result.runner.id;
  }

  test('a new runner is stored at version 1 and echoed', () => {
    const { ctx } = createTestContext();
    const reported = settings({ ceilings: { codex: { fiveHour: 0.5, weekly: 0.9 } }, allowPaidUsage: { codex: true } });
    const id = registered(ctx, reported);
    expect(tx(ctx, () => reconcileHelloSettings(ctx, id, reported))).toBe('stored');
    expect(runnerSettings(findRunnerRow(ctx, id) as RunnerRow)).toEqual({ ...reported, version: 1 });
    const { version: _, ...values } = reported;
    expect(settingsCommands(ctx)).toEqual([{ kind: 'update_settings', settings: values, version: 1 }]);
  });

  test('an equal version changes nothing; an older one gets the hub settings; a newer one is adopted', () => {
    const { ctx } = createTestContext();
    const id = registered(ctx);
    tx(ctx, () => reconcileHelloSettings(ctx, id, settings()));
    // Equal: the runner holds what the hub confirmed.
    expect(tx(ctx, () => reconcileHelloSettings(ctx, id, settings({ version: 1 })))).toBe('unchanged');
    expect(settingsCommands(ctx)).toHaveLength(1);
    // Newer: a hub restored from a backup adopts what the runner was confirmed since.
    const newer = settings({ capacity: 6, draining: true, allowPaidUsage: { claude: true }, version: 7 });
    expect(tx(ctx, () => reconcileHelloSettings(ctx, id, newer))).toBe('adopted');
    expect(runnerSettings(findRunnerRow(ctx, id) as RunnerRow)).toEqual(newer);
    // The echo still queued carried an older version: it is cancelled rather than sent after the welcome.
    expect(settingsCommands(ctx)).toEqual([]);
    // Older: the hub's settings go back to the runner.
    expect(tx(ctx, () => reconcileHelloSettings(ctx, id, settings({ version: 3 })))).toBe('sent');
    expect(settingsCommands(ctx).at(-1)).toEqual({
      kind: 'update_settings',
      settings: { capacity: 6, keepAwake: 'always', draining: true, ceilings: {}, allowPaidUsage: { claude: true } },
      version: 7,
    });
    expect(getRunner(ctx, id)).toMatchObject({ capacity: 6, draining: true, settingsVersion: 7 });
  });

  test("adopting a newer snapshot cancels the hub's queued echoes, so the runner keeps it", () => {
    const { ctx } = createTestContext();
    const id = registered(ctx);
    tx(ctx, () => reconcileHelloSettings(ctx, id, settings()));
    // A restored hub at version 1: the owner raises the capacity before the runner is back.
    tx(ctx, (emit) => patchRunnerSettings(ctx, emit, id, { capacity: 5 }, 'user:alice'));
    expect(settingsCommands(ctx).at(-1)).toMatchObject({ settings: { capacity: 5 }, version: 2 });
    const newer = settings({ capacity: 2, draining: true, version: 7 });
    expect(tx(ctx, () => reconcileHelloSettings(ctx, id, newer))).toBe('adopted');
    expect(settingsCommands(ctx)).toEqual([]);
    expect(getRunner(ctx, id)).toMatchObject({ capacity: 2, draining: true, settingsVersion: 7 });
    // Other kinds stay queued.
    tx(ctx, () => markVendorNotReady(ctx, id, 'claude'));
    tx(ctx, () => reconcileHelloSettings(ctx, id, settings({ version: 9 })));
    expect(pendingCommands(ctx, id, PROTOCOL_VERSION).map((row) => row.kind)).toEqual(['preflight']);
  });

  test('exact answers name the edit and epoch; refusals explicitly answer without changing the settings', () => {
    const { ctx } = createTestContext();
    const id = registered(ctx);
    tx(ctx, () => reconcileHelloSettings(ctx, id, settings()));
    const event = { seq: 1, at: 1, type: 'runner.settings', data: { settings: { draining: true }, baseVersion: 1 } };
    applyRunnerEvents(ctx, id, { outboxEpoch: 'box', events: [event] }, { restoreReplay: false });
    expect(settingsCommands(ctx).at(-1)).toMatchObject({ answers: { seq: 1, outboxEpoch: 'box' } });
    const handler = EVENT_HANDLERS['runner.settings'];
    EVENT_HANDLERS['runner.settings'] = () => { throw new Error('refused'); };
    try {
      applyRunnerEvents(ctx, id, { outboxEpoch: 'box', events: [{ ...event, seq: 2 }] }, { restoreReplay: false });
    } finally { EVENT_HANDLERS['runner.settings'] = handler; }
    expect(settingsCommands(ctx).at(-1)).toMatchObject({ version: 2, settings: {}, answers: { seq: 2, outboxEpoch: 'box', refused: true } });
    expect(getRunner(ctx, id)).toMatchObject({ draining: true, settingsVersion: 2 });
  });

  test.each([0, 1, 8])('restore at version %i skips answered edits only when it adopts the snapshot, durably and within the epoch', (version) => {
    const { ctx } = createTestContext();
    const id = registered(ctx);
    ctx.db.query('UPDATE runners SET settings_version = ? WHERE id = ?').run(version, id);
    const snapshot = settings({ capacity: 4, draining: false, version: 5 });
    tx(ctx, () => reconcileHelloSettings(ctx, id, snapshot, { outboxEpoch: 'box', settingsAnsweredSeq: 1, settingsAnsweredSparse: [3] }));
    // The replacement hello, or reconnect after a crash, must retain the adoption cutoff.
    tx(ctx, () => reconcileHelloSettings(ctx, id, runnerSettings(findRunnerRow(ctx, id)!), { outboxEpoch: 'box', settingsAnsweredSeq: 1, settingsAnsweredSparse: [3] }));
    const event = { seq: 1, at: 1, type: 'runner.settings', data: { settings: { draining: true }, baseVersion: 1 } };
    const replay = { outboxEpoch: 'box', events: [event, { ...event, seq: 2, data: { settings: { capacity: 6 }, baseVersion: 2 } }, { ...event, seq: 3 }] };
    expect(applyRunnerEvents(ctx, id, replay, { restoreReplay: true })).toBe(3);
    expect(getRunner(ctx, id)).toMatchObject(version < 5
      ? { capacity: 6, draining: false, settingsVersion: 6 }
      : { capacity: 6, draining: true, settingsVersion: 11 });
    // A fresh runner.db reuses seq 1; the previous epoch's cutoff cannot suppress it.
    applyRunnerEvents(ctx, id, { outboxEpoch: 'new-box', events: [event] }, { restoreReplay: false });
    expect(getRunner(ctx, id).draining).toBe(true);
  });

  test('runner.settings applies the changed fields at the hub version + 1 and echoes them', () => {
    const { ctx } = createTestContext();
    const id = registered(ctx, settings({ ceilings: { claude: { fiveHour: 0.85, weekly: 0.85 } } }));
    tx(ctx, () => reconcileHelloSettings(ctx, id, settings()));
    const echo = tx(ctx, (emit) =>
      applyRunnerSettings(ctx, emit, id, { draining: true, ceilings: { codex: { fiveHour: 0.4, weekly: 0.5 } } }),
    );
    expect(echo.command).toEqual({
      kind: 'update_settings',
      settings: { draining: true, ceilings: { codex: { fiveHour: 0.4, weekly: 0.5 } } },
      version: 2,
    });
    // Each vendor's entry is its own field: a change for one vendor keeps the other's.
    expect(runnerSettings(findRunnerRow(ctx, id) as RunnerRow)).toMatchObject({
      draining: true,
      ceilings: { claude: { fiveHour: 0.85, weekly: 0.85 }, codex: { fiveHour: 0.4, weekly: 0.5 } },
      version: 2,
    });
    expect(eventsOf(ctx, 'runner.updated').map((event) => [event.actor, event.data])).toEqual([
      [`runner:${id}`, { runnerId: id, name: 'alice-laptop', fields: ['draining', 'ceilings'] }],
    ]);
  });

  test('patchRunnerSettings bumps the version and queues update_settings', () => {
    const { ctx } = createTestContext();
    const id = registered(ctx);
    tx(ctx, () => reconcileHelloSettings(ctx, id, settings()));
    const runner = tx(ctx, (emit) => patchRunnerSettings(ctx, emit, id, { capacity: 5, keepAwake: 'off' }, 'user:alice'));
    expect(runner).toMatchObject({ capacity: 5, keepAwake: 'off', settingsVersion: 2 });
    expect(settingsCommands(ctx).at(-1)).toEqual({
      kind: 'update_settings',
      settings: { capacity: 5, keepAwake: 'off' },
      version: 2,
    });
    expect(eventsOf(ctx, 'runner.updated').at(-1)).toMatchObject({
      actor: 'user:alice',
      subject: id,
      data: { runnerId: id, name: 'alice-laptop', fields: ['capacity', 'keepAwake'] },
    });
  });

  test('a capacity change made in the browser and a drain made offline both survive', () => {
    const { ctx } = createTestContext();
    const id = registered(ctx);
    tx(ctx, () => reconcileHelloSettings(ctx, id, settings()));
    // The runner is away. Its owner raises the capacity in the browser; the runner drains itself meanwhile.
    tx(ctx, (emit) => patchRunnerSettings(ctx, emit, id, { capacity: 5 }, 'user:alice'));
    // Its next hello still carries the snapshot of version 1, never the local drain: the hub sends its settings.
    expect(tx(ctx, () => reconcileHelloSettings(ctx, id, settings({ version: 1 })))).toBe('sent');
    expect(settingsCommands(ctx).at(-1)).toMatchObject({ settings: { capacity: 5, draining: false }, version: 2 });
    // The drain is a pending local edit the echo leaves alone, so the runner sends it after the echo.
    const echo = tx(ctx, (emit) => applyRunnerSettings(ctx, emit, id, { draining: true }));
    expect(echo.command).toEqual({ kind: 'update_settings', settings: { draining: true }, version: 3 });
    expect(getRunner(ctx, id)).toMatchObject({ capacity: 5, draining: true, settingsVersion: 3 });
  });
});

describe('vendor holds', () => {
  const holdsOf = (ctx: Ctx, id = 'R-1') => vendorHolds(findRunnerRow(ctx, id) as RunnerRow);
  const preflights = (ctx: Ctx) =>
    pendingCommands(ctx, 'R-1', PROTOCOL_VERSION)
      .map((row) => row.command)
      .filter((command) => command.kind === 'preflight');

  test('a degraded mark holds until its time, whatever the runner reports', () => {
    const { ctx, clock } = createTestContext({ degradedMs: 60_000 });
    linkedRunner(ctx);
    tx(ctx, () => setDegraded(ctx, 'R-1', 'claude'));
    expect(holdsOf(ctx).claude).toEqual({ degradedUntil: ctx.now() + 60_000, failedStarts: 0, notReadySince: null });
    tx(ctx, () => applyVendorReport(ctx, 'R-1', [vendor({ degraded: false, preflightAt: ctx.now() + 1 })]));
    expect(getRunner(ctx, 'R-1').vendors[0]?.degraded).toBe(true);
    clock.advance(60_000);
    expect(getRunner(ctx, 'R-1').vendors[0]?.degraded).toBe(false);
  });

  test('a not-ready mark asks for a preflight, and only a later preflight clears it', () => {
    const { ctx, clock } = createTestContext();
    linkedRunner(ctx);
    const since = ctx.now();
    expect(tx(ctx, () => markVendorNotReady(ctx, 'R-1', 'claude'))).toBe(true);
    expect(holdsOf(ctx).claude?.notReadySince).toBe(since);
    expect(preflights(ctx)).toEqual([{ kind: 'preflight', vendor: 'claude' }]);
    // Marked already: no second preflight.
    clock.advance(1_000);
    expect(tx(ctx, () => markVendorNotReady(ctx, 'R-1', 'claude'))).toBe(false);
    expect(preflights(ctx)).toHaveLength(1);
    expect(getRunner(ctx, 'R-1').vendors[0]).toMatchObject({ ready: false });
    // A report of a preflight from before the mark leaves it.
    tx(ctx, () => applyVendorReport(ctx, 'R-1', [vendor({ preflightAt: since - 1 })]));
    expect(holdsOf(ctx).claude?.notReadySince).toBe(since);
    // Nor does one from the very moment of the mark: only a later preflight saw what the mark was about.
    tx(ctx, () => applyVendorReport(ctx, 'R-1', [vendor({ preflightAt: since })]));
    expect(holdsOf(ctx).claude?.notReadySince).toBe(since);
    expect(getRunner(ctx, 'R-1').vendors[0]).toMatchObject({ ready: false });
    tx(ctx, () => applyVendorReport(ctx, 'R-1', [vendor({ preflightAt: since + 1, plan: 'Claude Pro' })]));
    expect(holdsOf(ctx).claude?.notReadySince).toBeNull();
    expect(getRunner(ctx, 'R-1').vendors[0]).toMatchObject({ ready: true, plan: 'Claude Pro', preflightAt: since + 1 });
  });

  test('failed starts count per vendor until reset', () => {
    const { ctx } = createTestContext();
    linkedRunner(ctx);
    expect(tx(ctx, () => recordFailedStart(ctx, 'R-1', 'claude'))).toBe(1);
    expect(tx(ctx, () => recordFailedStart(ctx, 'R-1', 'codex'))).toBe(1);
    expect(tx(ctx, () => recordFailedStart(ctx, 'R-1', 'claude'))).toBe(2);
    tx(ctx, () => resetFailedStarts(ctx, 'R-1', 'claude'));
    expect(holdsOf(ctx)).toEqual({
      claude: { degradedUntil: null, failedStarts: 0, notReadySince: null },
      codex: { degradedUntil: null, failedStarts: 1, notReadySince: null },
    });
    // The not-ready mark starts the count again.
    tx(ctx, () => markVendorNotReady(ctx, 'R-1', 'codex'));
    expect(holdsOf(ctx).codex?.failedStarts).toBe(0);
  });
});

test('a settings refusal and its cumulative acknowledgement commit together, including invalid edits', () => {
  const { ctx } = createTestContext();
  const identity = identifyRunner(ctx, 'alice', hello());
  if (!identity.ok) throw new Error('registration failed');
  const id = identity.runner.id;
  tx(ctx, () => reconcileHelloSettings(ctx, id, hello().settings));
  ctx.db.run(`CREATE TRIGGER fail_answer BEFORE INSERT ON runner_commands
    BEGIN SELECT RAISE(ABORT, 'cannot persist answer'); END`);
  const message = { outboxEpoch: 'box', events: [{ seq: 1, at: 1, type: 'runner.settings',
    data: { settings: { capacity: 0 }, baseVersion: 1 } }] };
  expect(() => applyRunnerEvents(ctx, id, message, { restoreReplay: false })).toThrow('cannot persist answer');
  expect(ctx.db.query('SELECT acked_seq FROM runner_inbox WHERE runner_id = ?').get(id)).toBeNull();
  expect(ctx.db.query('SELECT seq FROM runner_event_rejects').all()).toEqual([]);
  ctx.db.run('DROP TRIGGER fail_answer');
  expect(applyRunnerEvents(ctx, id, message, { restoreReplay: false })).toBe(1);
  expect(pendingCommands(ctx, id, PROTOCOL_VERSION).at(-1)?.command).toMatchObject({
    answers: { seq: 1, outboxEpoch: 'box', refused: true }, settings: {}, version: 1,
  });
});
