import { describe, expect, test } from 'bun:test';
import { TEST_ACCOUNT_ID } from '../src/runner-protocol';
import { vendorRequirement } from '../src/ladder';
import {
  type AccountView,
  PLACEMENT_REFUSALS,
  type PlacementRefusal,
  type PlacementSnapshot,
  type RunnerSlot,
  type TaskCandidate,
  type VendorSlot,
  candidateRunners,
  freeSlots,
  isDispatchable,
  orderReady,
  orderRunners,
  place,
  placeLead,
  preferredVendors,
  reportHolds,
  runnerToAvoid,
  usableVendors,
  utilization,
  workerSlotsFree,
} from '../src/scheduling';
import type { Vendor, VendorQuota } from '../src/types';

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const CODEX_ACCOUNT = '0123456789abcdef';

function vendorSlot(overrides: Partial<VendorSlot> = {}): VendorSlot {
  return {
    vendor: 'claude',
    ready: true,
    notReadySince: null,
    degradedUntil: null,
    accountId: TEST_ACCOUNT_ID,
    ceilings: { fiveHour: 0.85, weekly: 0.85 },
    allowPaidUsage: false,
    ...overrides,
  };
}

function runner(overrides: Partial<RunnerSlot> = {}): RunnerSlot {
  return {
    id: 'R-1',
    owner: 'ann',
    state: 'online',
    draining: false,
    gitReady: true,
    acceptingUntil: null,
    startRefusal: null,
    capacity: 2,
    openAttempts: 0,
    power: { source: 'ac', batteryPercent: null, lowPowerMode: false },
    vendors: [vendorSlot()],
    ...overrides,
  };
}

function quota(overrides: Partial<VendorQuota> = {}): VendorQuota {
  return {
    state: 'ok',
    resetsAt: NOW + HOUR,
    windows: { fiveHour: 0.2, weekly: 0.1 },
    paidUsage: 'disabled',
    updatedAt: NOW - MINUTE,
    ...overrides,
  };
}

function account(overrides: Partial<AccountView> = {}): AccountView {
  return {
    owner: 'ann',
    vendor: 'claude',
    accountId: TEST_ACCOUNT_ID,
    quota: quota(),
    ownerAway: false,
    openAttempts: 0,
    ...overrides,
  };
}

function snapshot(runners: RunnerSlot[], accounts: AccountView[] = []): PlacementSnapshot {
  return { now: NOW, quotaUnknownMs: 30 * MINUTE, runners, accounts };
}

/** How usableVendors judges one vendor on a runner of ann's: null when it is usable, else its refusal. */
function judge(slot: Partial<VendorSlot> = {}, accounts: AccountView[] = [account()]): PlacementRefusal | null {
  const one = runner({ vendors: [vendorSlot(slot)] });
  const { usable, refused } = usableVendors(snapshot([one], accounts), one);
  expect(usable.length + refused.length).toBe(1);
  return refused[0]?.refusal ?? null;
}

describe('candidate runners', () => {
  test('are online, not draining, git ready, past acceptingUntil, without a refused start, with a free slot', () => {
    const runners = [
      runner({ id: 'R-1' }),
      runner({ id: 'R-2', state: 'offline' }),
      runner({ id: 'R-3', state: 'needs_login' }),
      runner({ id: 'R-4', state: 'incompatible' }),
      runner({ id: 'R-5', state: 'crash_loop' }),
      runner({ id: 'R-6', state: 'disk_low' }),
      runner({ id: 'R-7', draining: true }),
      runner({ id: 'R-8', gitReady: false }),
      runner({ id: 'R-9', acceptingUntil: NOW + 1 }),
      runner({ id: 'R-10', acceptingUntil: NOW }),
      // A start it refused since its last heartbeat, which the next heartbeat clears (X-3).
      runner({ id: 'R-11', startRefusal: { code: 'waking', at: NOW - MINUTE } }),
      // A lead and a worker fill two slots.
      runner({ id: 'R-12', capacity: 2, openAttempts: 2 }),
      runner({ id: 'R-13', capacity: 3, openAttempts: 2 }),
    ];
    const { candidates, refused } = candidateRunners(snapshot(runners));
    expect(candidates.map((candidate) => candidate.id)).toEqual(['R-1', 'R-10', 'R-13']);
    expect(refused).toEqual([
      { runnerId: 'R-2', vendor: null, refusal: 'offline' },
      { runnerId: 'R-3', vendor: null, refusal: 'offline' },
      { runnerId: 'R-4', vendor: null, refusal: 'offline' },
      { runnerId: 'R-5', vendor: null, refusal: 'offline' },
      { runnerId: 'R-6', vendor: null, refusal: 'offline' },
      { runnerId: 'R-7', vendor: null, refusal: 'draining' },
      { runnerId: 'R-8', vendor: null, refusal: 'git' },
      { runnerId: 'R-9', vendor: null, refusal: 'accepting' },
      { runnerId: 'R-11', vendor: null, refusal: 'refused_start' },
      { runnerId: 'R-12', vendor: null, refusal: 'full' },
    ]);
  });

  test('a runner that breaks several rules gets the first refusal in PLACEMENT_REFUSALS order', () => {
    const runners = [
      runner({ id: 'R-1', state: 'offline', draining: true, gitReady: false, openAttempts: 2 }),
      runner({ id: 'R-2', draining: true, gitReady: false, acceptingUntil: NOW + HOUR }),
      runner({ id: 'R-3', acceptingUntil: NOW + HOUR, startRefusal: { code: 'battery_low', at: NOW } }),
      runner({ id: 'R-4', startRefusal: { code: 'at_capacity', at: NOW }, openAttempts: 2 }),
    ];
    expect(candidateRunners(snapshot(runners)).refused.map((refused) => refused.refusal)).toEqual([
      'offline',
      'draining',
      'accepting',
      'refused_start',
    ]);
  });

  test('freeSlots is the capacity left after starting, running and quota_wait attempts, a lead included', () => {
    expect(freeSlots(runner({ capacity: 3, openAttempts: 0 }))).toBe(3);
    expect(freeSlots(runner({ capacity: 3, openAttempts: 2 }))).toBe(1);
    // A capacity lowered below the open attempts leaves no slot, not fewer.
    expect(freeSlots(runner({ capacity: 1, openAttempts: 3 }))).toBe(0);
  });
});

describe('usable vendors', () => {
  // Not exhausted, drawing no paid usage, its owner present, and below the runner's ceilings.
  test('a ready vendor on a healthy account is usable, with that account', () => {
    const one = runner({ vendors: [vendorSlot(), vendorSlot({ vendor: 'codex', accountId: CODEX_ACCOUNT })] });
    const accounts = [account(), account({ vendor: 'codex', accountId: CODEX_ACCOUNT })];
    expect(usableVendors(snapshot([one], accounts), one)).toEqual({
      usable: [
        { slot: one.vendors[0], account: accounts[0] },
        { slot: one.vendors[1], account: accounts[1] },
      ],
      refused: [],
    });
  });

  test('every vendor of the runner is listed, usable or refused with its runner', () => {
    const one = runner({
      id: 'R-4',
      vendors: [vendorSlot({ ready: false }), vendorSlot({ vendor: 'codex', accountId: CODEX_ACCOUNT })],
    });
    expect(usableVendors(snapshot([one], [account()]), one)).toEqual({
      usable: [{ slot: one.vendors[1], account: null }],
      refused: [{ runnerId: 'R-4', vendor: 'claude', refusal: 'not_ready' }],
    });
  });

  test('not ready by its own report or a hub mark; degraded until the mark runs out', () => {
    expect(judge()).toBeNull();
    expect(judge({ ready: false })).toBe('not_ready');
    expect(judge({ notReadySince: NOW - HOUR })).toBe('not_ready');
    expect(judge({ degradedUntil: NOW + 1 })).toBe('degraded');
    expect(judge({ degradedUntil: NOW })).toBeNull();
  });

  test("an exhausted account until resetsAt, on every runner of the owner, and not on another owner's", () => {
    expect(judge({}, [account({ quota: quota({ state: 'exhausted', resetsAt: NOW + 1 }) })])).toBe('exhausted');
    expect(judge({}, [account({ quota: quota({ state: 'exhausted', resetsAt: NOW }) })])).toBeNull();
    const runners = [runner({ id: 'R-1' }), runner({ id: 'R-2' }), runner({ id: 'R-3', owner: 'bob' })];
    const accounts = [account({ quota: quota({ state: 'exhausted' }) }), account({ owner: 'bob' })];
    const shared = snapshot(runners, accounts);
    expect(runners.map((each) => usableVendors(shared, each).refused)).toEqual([
      [{ runnerId: 'R-1', vendor: 'claude', refusal: 'exhausted' }],
      [{ runnerId: 'R-2', vendor: 'claude', refusal: 'exhausted' }],
      [],
    ]);
  });

  test('no paid usage unless the runner allows it', () => {
    const paying = [account({ quota: quota({ paidUsage: 'in_use' }) })];
    expect(judge({}, paying)).toBe('paid_usage');
    expect(judge({ allowPaidUsage: true }, paying)).toBeNull();
    // Paid usage that is only enabled, or unknown, draws nothing yet.
    expect(judge({}, [account({ quota: quota({ paidUsage: 'enabled' }) })])).toBeNull();
    expect(judge({}, [account({ quota: quota({ paidUsage: 'unknown' }) })])).toBeNull();
  });

  test('not while the owner is away', () => {
    expect(judge({}, [account({ ownerAway: true })])).toBe('owner_away');
    expect(judge({}, [account({ ownerAway: true, quota: quota({ resetsAt: NOW - 1 }) })])).toBe('owner_away');
  });

  test("below the runner's ceilings; unknown utilization counts as 0, so a ceiling of 0 keeps the vendor off", () => {
    const used = (fiveHour: number | null, weekly: number | null) => [
      account({ quota: quota({ windows: { fiveHour, weekly } }) }),
    ];
    expect(judge({}, used(0.84, 0.84))).toBeNull();
    expect(judge({}, used(0.85, 0.1))).toBe('ceiling');
    expect(judge({}, used(0.1, 0.9))).toBe('ceiling');
    expect(judge({ ceilings: { fiveHour: 0.95, weekly: 0.95 } }, used(0.9, 0.9))).toBeNull();
    expect(judge({}, used(null, null))).toBeNull();
    expect(judge({ ceilings: { fiveHour: 0, weekly: 0.85 } }, used(null, null))).toBe('ceiling');
    expect(judge({ ceilings: { fiveHour: 0.85, weekly: 0 } }, used(0, null))).toBe('ceiling');
  });

  test('a quota report holds until its resetsAt; after it, its limiting window counts as unknown', () => {
    // resetsAt is the reset of the limiting window, the more used one; the other window keeps its reading.
    const lapsed = (fiveHour: number | null, weekly: number | null) => [
      account({ quota: quota({ resetsAt: NOW, windows: { fiveHour, weekly }, paidUsage: 'in_use' }) }),
    ];
    // Its paid usage lapses with it, and so does the five-hour window that reset.
    expect(judge({}, lapsed(1, 0.5))).toBeNull();
    expect(judge({ ceilings: { fiveHour: 0, weekly: 0.85 } }, lapsed(1, 0.5))).toBe('ceiling');
    // The other window did not reset, and above the ceiling it still keeps the vendor off.
    expect(judge({}, lapsed(1, 0.9))).toBe('ceiling');
    expect(judge({}, lapsed(0.9, 1))).toBe('ceiling');
    expect(judge({}, lapsed(0.5, 1))).toBeNull();
    // The only known window is the limiting one.
    expect(judge({}, lapsed(null, 0.9))).toBeNull();
    // On a tie the five-hour window lapses and the weekly one keeps its reading.
    expect(judge({ ceilings: { fiveHour: 0.85, weekly: 0.95 } }, lapsed(0.9, 0.9))).toBeNull();
    expect(judge({ ceilings: { fiveHour: 0.95, weekly: 0.85 } }, lapsed(0.9, 0.9))).toBe('ceiling');
  });

  test('reportHolds and utilization, which the web reads too, give the same lapse (X-49)', () => {
    const holding = account({ quota: quota({ windows: { fiveHour: 0.9, weekly: 0.5 } }) });
    const lapsed = account({ quota: quota({ resetsAt: NOW, windows: { fiveHour: 0.9, weekly: 0.5 } }) });
    expect(reportHolds(snapshot([]), holding)).toBe(true);
    expect(reportHolds(snapshot([]), lapsed)).toBe(false);
    expect(utilization(holding, true)).toEqual({ fiveHour: 0.9, weekly: 0.5 });
    expect(utilization(lapsed, false)).toEqual({ fiveHour: 0, weekly: 0.5 });
    expect(utilization(null, false)).toEqual({ fiveHour: 0, weekly: 0 });
  });

  test('a vendor that breaks several rules gets the first refusal in PLACEMENT_REFUSALS order', () => {
    const worst = quota({ state: 'exhausted', paidUsage: 'in_use', windows: { fiveHour: 1, weekly: 1 } });
    const all = [account({ ownerAway: true, quota: worst })];
    expect(judge({ ready: false, degradedUntil: NOW + HOUR }, all)).toBe('not_ready');
    expect(judge({ degradedUntil: NOW + HOUR }, all)).toBe('degraded');
    expect(judge({}, all)).toBe('exhausted');
    const notExhausted = [account({ ownerAway: true, quota: { ...worst, state: 'ok' } })];
    expect(judge({}, notExhausted)).toBe('paid_usage');
    expect(judge({ allowPaidUsage: true }, notExhausted)).toBe('owner_away');
    expect(judge({ allowPaidUsage: true }, [account({ quota: { ...worst, state: 'ok' } })])).toBe('ceiling');
  });

  test('a vendor without an account id is usable with no account rules, and so is an account without a report', () => {
    // ann's account is exhausted and she is away, which binds no vendor that names no account.
    const bad = [account({ ownerAway: true, quota: quota({ state: 'exhausted', resetsAt: null }) })];
    const unnamed = runner({ vendors: [vendorSlot({ accountId: null })] });
    expect(usableVendors(snapshot([unnamed], bad), unnamed)).toEqual({
      usable: [{ slot: unnamed.vendors[0], account: null }],
      refused: [],
    });
    // An account the hub has no quota report for.
    expect(judge({ accountId: CODEX_ACCOUNT })).toBeNull();
    // The runner's ceilings still apply, with the utilization unknown.
    expect(judge({ accountId: null, ceilings: { fiveHour: 0, weekly: 0 } }, bad)).toBe('ceiling');
    expect(judge({ accountId: CODEX_ACCOUNT, ceilings: { fiveHour: 0.85, weekly: 0 } })).toBe('ceiling');
  });
});

describe('unknown reset times', () => {
  /** An account exhausted at a limit hit whose reset nobody knows, last reported quotaUnknownMs ago. */
  function unknownReset(vendor: Vendor, overrides: Partial<VendorQuota> = {}, openAttempts = 0): AccountView {
    return account({
      vendor,
      accountId: vendor === 'claude' ? TEST_ACCOUNT_ID : CODEX_ACCOUNT,
      openAttempts,
      quota: quota({
        state: 'exhausted',
        resetsAt: null,
        windows: { fiveHour: 1, weekly: 0.5 },
        updatedAt: NOW - 30 * MINUTE,
        ...overrides,
      }),
    });
  }

  test('an exhausted Claude account allows one probing start quotaUnknownMs after its last report', () => {
    expect(judge({}, [unknownReset('claude')])).toBeNull();
    expect(judge({}, [unknownReset('claude', { updatedAt: NOW - 30 * MINUTE + 1 })])).toBe('exhausted');
  });

  test('while no attempt of that vendor is open on the account', () => {
    expect(judge({}, [unknownReset('claude', {}, 1)])).toBe('exhausted');
  });

  test("the probe reads the limit hit's window as unknown, and the other window keeps its reading", () => {
    // The limit hit left the five-hour window at 1, above every ceiling.
    expect(judge({ ceilings: { fiveHour: 0.85, weekly: 0.85 } }, [unknownReset('claude')])).toBeNull();
    expect(judge({ ceilings: { fiveHour: 0, weekly: 0.85 } }, [unknownReset('claude')])).toBe('ceiling');
    // A weekly window above the ceiling keeps the probe off.
    expect(judge({}, [unknownReset('claude', { windows: { fiveHour: 1, weekly: 0.9 } })])).toBe('ceiling');
  });

  test('a Codex account stays exhausted until a report lifts it', () => {
    const codex = { vendor: 'codex' as const, accountId: CODEX_ACCOUNT };
    expect(judge(codex, [unknownReset('codex')])).toBe('exhausted');
    expect(judge(codex, [unknownReset('codex', { updatedAt: NOW - 10 * HOUR })])).toBe('exhausted');
    const lifted = quota({ state: 'ok', resetsAt: null, windows: { fiveHour: 0.1, weekly: 0.5 }, updatedAt: NOW });
    expect(judge(codex, [account({ ...codex, quota: lifted })])).toBeNull();
  });
});

test('refusals are named', () => {
  expect(PLACEMENT_REFUSALS).toEqual([
    'offline',
    'draining',
    'git',
    'accepting',
    'refused_start',
    'full',
    'not_ready',
    'degraded',
    'exhausted',
    'paid_usage',
    'owner_away',
    'ceiling',
  ]);
});

// ---------------------------------------------------------------------------
// The ready set, preferences and placement (design 6.6 steps 3 to 5, 6.11)
// ---------------------------------------------------------------------------

function candidate(overrides: Partial<TaskCandidate> = {}): TaskCandidate {
  return {
    id: 'T-1',
    status: 'ready',
    priority: 5,
    createdAt: NOW - HOUR,
    ownedPaths: ['src/parser/**'],
    kind: 'code',
    createdBy: 'user:ann',
    nextDispatchAt: null,
    vendorHint: null,
    dependenciesDone: true,
    openAttempt: false,
    dispatchHoldUntil: null,
    counted: 0,
    requirement: null,
    avoidRunner: null,
    ...overrides,
  };
}

const dispatch = { now: NOW, maxAttempts: 3, pathHolders: [] };

describe('isDispatchable', () => {
  test('a ready task with its dependencies done, no open attempt and nothing holding it back qualifies', () => {
    expect(isDispatchable(candidate(), dispatch)).toBe(true);
  });

  test('each condition of the ready set keeps a task out', () => {
    const out: Partial<TaskCandidate>[] = [
      { status: 'claimed' },
      { status: 'blocked' },
      { dependenciesDone: false },
      { openAttempt: true },
      // An agent-config path is for live chats only.
      { ownedPaths: ['.claude/settings.json'] },
      { nextDispatchAt: NOW + 1 },
      { dispatchHoldUntil: NOW + 1 },
      { counted: 3 },
    ];
    for (const overrides of out) {
      expect([overrides, isDispatchable(candidate(overrides), dispatch)]).toEqual([overrides, false]);
    }
    // Times that have come qualify.
    expect(isDispatchable(candidate({ nextDispatchAt: NOW, dispatchHoldUntil: NOW - 1 }), dispatch)).toBe(true);
    expect(isDispatchable(candidate({ counted: 2 }), dispatch)).toBe(true);
  });

  test('a path holder with overlapping paths keeps the task out; the task itself and other paths do not', () => {
    const holders = [{ id: 'T-2', ownedPaths: ['src/parser/lexer.ts'] }];
    expect(isDispatchable(candidate(), { ...dispatch, pathHolders: holders })).toBe(false);
    const others = [
      { id: 'T-1', ownedPaths: ['src/parser/**'] },
      { id: 'T-3', ownedPaths: ['docs/**'] },
    ];
    expect(isDispatchable(candidate(), { ...dispatch, pathHolders: others })).toBe(true);
  });
});

test('orderReady orders by priority, then age', () => {
  const tasks = [
    candidate({ id: 'T-1', priority: 5, createdAt: NOW - HOUR }),
    candidate({ id: 'T-2', priority: 1, createdAt: NOW - MINUTE }),
    candidate({ id: 'T-3', priority: 5, createdAt: NOW - 2 * HOUR }),
    candidate({ id: 'T-4', priority: 1, createdAt: NOW - HOUR }),
  ];
  expect(orderReady(tasks).map((task) => task.id)).toEqual(['T-4', 'T-2', 'T-3', 'T-1']);
  // The input stays as it was.
  expect(tasks.map((task) => task.id)).toEqual(['T-1', 'T-2', 'T-3', 'T-4']);
});

describe('preferredVendors', () => {
  const base = {
    requirement: null,
    vendorHint: null,
    projectPref: null,
    now: NOW,
    offered: ['claude', 'codex'] as Vendor[],
    utilization: { claude: 0.5, codex: 0.2 },
  };

  test('with no preference the vendor with the lower account utilization comes first', () => {
    expect(preferredVendors(base)).toEqual(['codex', 'claude']);
    expect(preferredVendors({ ...base, utilization: { claude: 0.1, codex: 0.2 } })).toEqual(['claude', 'codex']);
    // A vendor usable nowhere now comes last.
    expect(preferredVendors({ ...base, utilization: { claude: 0.9 } })).toEqual(['claude', 'codex']);
  });

  test('the project preference counts until it expires, and vendorHint counts before it', () => {
    const projectPref = { vendor: 'claude' as const, until: NOW + 1 };
    expect(preferredVendors({ ...base, projectPref })).toEqual(['claude', 'codex']);
    expect(preferredVendors({ ...base, projectPref: { ...projectPref, until: NOW } })).toEqual(['codex', 'claude']);
    expect(preferredVendors({ ...base, projectPref, vendorHint: 'codex' })).toEqual(['codex', 'claude']);
  });

  test('the ladder requirement binds before any preference, step 3 only while a runner offers the vendor', () => {
    const step2 = { step: 2 as const, vendor: 'claude' as const };
    expect(preferredVendors({ ...base, vendorHint: 'codex', requirement: step2 })).toEqual(['claude']);
    expect(preferredVendors({ ...base, requirement: step2, offered: ['codex'] })).toEqual(['claude']);
    const step3 = { step: 3 as const, vendor: 'claude' as const };
    expect(preferredVendors({ ...base, requirement: step3 })).toEqual(['claude']);
    expect(preferredVendors({ ...base, requirement: step3, offered: ['codex'] })).toEqual(['codex', 'claude']);
  });

  test('the requirement lapses vendorRequirementMs after the last attempt ended', () => {
    const ended = { number: 1, runnerId: 'R-1', failureClass: 'agent' as const, vendor: 'claude' as const };
    const options = { ladderFloor: 0, vendorRequirementMs: 10 * MINUTE };
    const requirementAt = (now: number) =>
      vendorRequirement([{ ...ended, endedAt: NOW - 10 * MINUTE + 1 }], { ...options, now });
    expect(preferredVendors({ ...base, requirement: requirementAt(NOW) })).toEqual(['claude']);
    expect(preferredVendors({ ...base, requirement: requirementAt(NOW + 1) })).toEqual(['codex', 'claude']);
  });
});

describe('runner preference', () => {
  const view = (overrides: Partial<Parameters<typeof runnerToAvoid>[0][number]> = {}) => ({
    number: 1,
    runnerId: 'R-1',
    failureClass: 'agent' as const,
    finalPushFailed: false,
    ...overrides,
  });

  test("the runner of the task's last agent, review or infra ending is avoided, unless its final push failed", () => {
    expect(runnerToAvoid([])).toBeNull();
    for (const failureClass of ['agent', 'review', 'infra'] as const) {
      expect(runnerToAvoid([view({ failureClass })])).toBe('R-1');
    }
    expect(runnerToAvoid([view({ finalPushFailed: true })])).toBeNull();
    // The last such ending counts; endings of no class are passed over.
    const attempts = [
      view({ number: 1, runnerId: 'R-1' }),
      view({ number: 2, runnerId: 'R-2', failureClass: 'infra' }),
      view({ number: 3, runnerId: 'R-3', failureClass: null }),
    ];
    expect(runnerToAvoid(attempts)).toBe('R-2');
    expect(runnerToAvoid([...attempts, view({ number: 4, runnerId: null })])).toBeNull();
  });

  test('orderRunners: not the avoided runner, then AC power, then most free slots, then lowest id', () => {
    const battery = { source: 'battery' as const, batteryPercent: 80, lowPowerMode: false };
    const runners = [
      runner({ id: 'R-10', openAttempts: 1 }),
      runner({ id: 'R-2', openAttempts: 1 }),
      runner({ id: 'R-3', capacity: 4 }),
      runner({ id: 'R-4', capacity: 8, power: battery }),
      runner({ id: 'R-5', capacity: 8 }),
    ];
    expect(orderRunners(runners, null).map((one) => one.id)).toEqual(['R-5', 'R-3', 'R-2', 'R-10', 'R-4']);
    expect(orderRunners(runners, 'R-5').map((one) => one.id)).toEqual(['R-3', 'R-2', 'R-10', 'R-4', 'R-5']);
  });

  test('workerSlotsFree keeps running workers below worker_target, or maxWorkers without one', () => {
    expect(workerSlotsFree({ workerTarget: null, maxWorkers: 4, runningWorkers: 1 })).toBe(3);
    expect(workerSlotsFree({ workerTarget: 2, maxWorkers: 4, runningWorkers: 1 })).toBe(1);
    expect(workerSlotsFree({ workerTarget: 0, maxWorkers: 4, runningWorkers: 0 })).toBe(0);
    expect(workerSlotsFree({ workerTarget: 1, maxWorkers: 4, runningWorkers: 3 })).toBe(0);
  });
});

describe('place', () => {
  const codexSlot = vendorSlot({ vendor: 'codex', accountId: CODEX_ACCOUNT });
  const codexQuota = quota({ windows: { fiveHour: 0.1, weekly: 0.1 } });
  const codexAccount = account({ vendor: 'codex', accountId: CODEX_ACCOUNT, quota: codexQuota });
  const both = (overrides: Partial<RunnerSlot> = {}) => runner({ vendors: [vendorSlot(), codexSlot], ...overrides });
  const noPref = { projectPref: null };

  test('places the task on the preferred vendor and the best runner for it', () => {
    const view = snapshot([both({ id: 'R-1' }), both({ id: 'R-2', capacity: 4 })], [account(), codexAccount]);
    // Codex has the lower utilization (0.1 against 0.2).
    const placement = { runnerId: 'R-2', vendor: 'codex' as const, account: codexAccount };
    expect(place(view, candidate(), noPref).placement).toEqual(placement);
    const hinted = place(view, candidate({ vendorHint: 'claude' }), noPref).placement;
    expect([hinted?.runnerId, hinted?.vendor]).toEqual(['R-2', 'claude']);
    const avoided = place(view, candidate({ avoidRunner: 'R-2' }), noPref).placement;
    expect([avoided?.runnerId, avoided?.vendor]).toEqual(['R-1', 'codex']);
    const preferred = place(view, candidate(), { projectPref: { vendor: 'claude', until: NOW + HOUR } }).placement;
    expect(preferred?.vendor).toBe('claude');
  });

  test('falls back to the next vendor when the preferred one is usable nowhere', () => {
    const view = snapshot([both()], [account(), { ...codexAccount, ownerAway: true }]);
    const { placement, refused } = place(view, candidate(), noPref);
    expect([placement?.runnerId, placement?.vendor]).toEqual(['R-1', 'claude']);
    expect(refused).toEqual([{ runnerId: 'R-1', vendor: 'codex', refusal: 'owner_away' }]);
  });

  test('a binding requirement places nothing when its vendor is usable nowhere, and names every refusal', () => {
    const away = { ...codexAccount, ownerAway: true };
    const view = snapshot([both(), runner({ id: 'R-2', state: 'offline' })], [account(), away]);
    const required = candidate({ requirement: { step: 2, vendor: 'codex' } });
    expect(place(view, required, noPref)).toEqual({
      placement: null,
      refused: [
        { runnerId: 'R-2', vendor: null, refusal: 'offline' },
        { runnerId: 'R-1', vendor: 'codex', refusal: 'owner_away' },
      ],
    });
  });

  test('step 3 does not bind when no online runner offers its vendor', () => {
    const view = snapshot([runner()], [account()]);
    const required = candidate({ requirement: { step: 3, vendor: 'codex' } });
    expect(place(view, required, noPref).placement?.vendor).toBe('claude');
  });

  test('no candidate runner: no placement', () => {
    const view = snapshot([runner({ openAttempts: 2 })], [account()]);
    expect(place(view, candidate(), noPref)).toEqual({
      placement: null,
      refused: [{ runnerId: 'R-1', vendor: null, refusal: 'full' }],
    });
  });
});

describe('placeLead', () => {
  const codexSlot = vendorSlot({ vendor: 'codex', accountId: CODEX_ACCOUNT });
  const battery = { source: 'battery' as const, batteryPercent: 80, lowPowerMode: false };

  test('prefers Claude, then AC power, then free slots', () => {
    const view = snapshot(
      [
        runner({ id: 'R-1', vendors: [codexSlot], capacity: 8 }),
        runner({ id: 'R-2', power: battery, capacity: 8 }),
        runner({ id: 'R-3' }),
        runner({ id: 'R-4', capacity: 4 }),
      ],
      [account()],
    );
    expect(placeLead(view, { rotatingFrom: null }).placement).toMatchObject({ runnerId: 'R-4', vendor: 'claude' });
    // Without Claude anywhere, Codex.
    const codexOnly = snapshot([runner({ vendors: [codexSlot] })]);
    expect(placeLead(codexOnly, { rotatingFrom: null }).placement).toMatchObject({ runnerId: 'R-1', vendor: 'codex' });
  });

  test('a rotation prefers the runner the lead ran on', () => {
    const view = snapshot([runner({ id: 'R-1', capacity: 8 }), runner({ id: 'R-2', power: battery })], [account()]);
    expect(placeLead(view, { rotatingFrom: 'R-2' }).placement?.runnerId).toBe('R-2');
    expect(placeLead(view, { rotatingFrom: null }).placement?.runnerId).toBe('R-1');
  });

  test('Claude comes before the runner the lead ran on', () => {
    const view = snapshot([runner({ id: 'R-1', vendors: [codexSlot] }), runner({ id: 'R-2' })], [account()]);
    expect(placeLead(view, { rotatingFrom: 'R-1' }).placement).toMatchObject({ runnerId: 'R-2', vendor: 'claude' });
  });

  test('a tie goes to the lowest runner id', () => {
    const view = snapshot([runner({ id: 'R-10' }), runner({ id: 'R-2' })], [account()]);
    expect(placeLead(view, { rotatingFrom: null }).placement?.runnerId).toBe('R-2');
  });

  test('every refusal is named when no runner can take the lead', () => {
    const view = snapshot([runner({ draining: true })], [account()]);
    expect(placeLead(view, { rotatingFrom: null })).toEqual({
      placement: null,
      refused: [{ runnerId: 'R-1', vendor: null, refusal: 'draining' }],
    });
  });
});
