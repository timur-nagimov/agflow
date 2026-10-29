import { describe, expect, test } from 'bun:test';
import {
  CLOSE_CODES,
  PROTOCOL_VERSION,
  type RunnerMessage,
  RunnerSchema,
  type RunnerState,
  type RunnerVendor,
  TEST_ACCOUNT_ID,
} from '@agflow/core';
import { createSession, sessionHashOf } from '../src/auth';
import { tx } from '../src/context';
import { listEvents } from '../src/events';
import {
  checkRunnerIdentity,
  deriveRunnerState,
  findRunner,
  findRunnerByKey,
  getRunner,
  identifyRunner,
  listRunners,
  markLinked,
  markRetired,
  markUnlinked,
  refreshNeedsLogin,
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
