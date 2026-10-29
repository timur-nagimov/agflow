import { describe, expect, test } from 'bun:test';
import { TEST_ACCOUNT_ID } from '../src/runner-protocol';
import {
  type AccountView,
  PLACEMENT_REFUSALS,
  type PlacementRefusal,
  type PlacementSnapshot,
  type RunnerSlot,
  type VendorSlot,
  candidateRunners,
  freeSlots,
  reportHolds,
  usableVendors,
  utilization,
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
