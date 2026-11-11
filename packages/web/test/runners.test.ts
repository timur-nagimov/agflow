import { describe, expect, test } from 'bun:test';
import {
  type AccountQuota,
  type Runner,
  RunnerPatchInputSchema,
  RunnerSchema,
  type RunnerState,
  type RunnerVendor,
} from '@agflow/core';
import {
  accountOf,
  acceptingText,
  clockTime,
  diskText,
  draftFromRunner,
  formatBytes,
  gitText,
  isOwner,
  KEEP_AWAKE_LABELS,
  paidUsageText,
  powerText,
  profileLines,
  quotaMeters,
  RUNNER_STATE_LABELS,
  runnerTone,
  runnerWhy,
  type SettingsDraft,
  settingsPatch,
  settingsProblem,
  slotsText,
  sortRunners,
  vendorView,
} from '../src/runners';

const MINUTE = 60_000;
// 14:00 local time, so the clock times below read the same in every time zone.
const NOW = new Date(2026, 9, 29, 14, 0).getTime();

function vendor(overrides: Partial<RunnerVendor> = {}): RunnerVendor {
  return {
    vendor: 'claude',
    cliVersion: '2.1.285',
    ownerCliVersion: '2.1.285',
    ready: true,
    problem: null,
    accountId: 'a1b2c3d4e5f60718',
    plan: 'Claude Max',
    managedPolicy: false,
    models: { lead: 'claude-opus', worker: 'claude-sonnet' },
    ceilings: { fiveHour: 0.85, weekly: 0.85 },
    allowPaidUsage: false,
    degraded: false,
    preflightAt: NOW - 10 * MINUTE,
    ...overrides,
  };
}

function runner(overrides: Partial<Runner> = {}): Runner {
  return {
    id: 'R-1',
    owner: 'demo',
    name: "demo's MacBook Pro",
    state: 'online',
    stateDetail: null,
    lastError: null,
    capacity: 3,
    keepAwake: 'ac',
    draining: false,
    settingsVersion: 2,
    protocol: 1,
    agflowVersion: '0.1.0',
    platform: 'darwin-arm64',
    vendors: [vendor()],
    profile: { name: 'standard', weakened: [], dependencyPrep: true },
    git: { ready: true, problem: null, lastPushAt: NOW - 5 * MINUTE },
    power: { source: 'ac', batteryPercent: 88, lowPowerMode: false },
    disk: { freeBytes: 120_000_000_000, agflowBytes: 3_400_000_000 },
    acceptingUntil: null,
    activeAttempts: 2,
    lastSeenAt: NOW,
    createdAt: NOW - 86_400_000,
    ...overrides,
  };
}

function account(overrides: Partial<AccountQuota> = {}, quota: Partial<AccountQuota['quota']> = {}): AccountQuota {
  return {
    owner: 'demo',
    vendor: 'claude',
    accountId: 'a1b2c3d4e5f60718',
    quota: {
      state: 'ok',
      resetsAt: new Date(2026, 9, 29, 16, 30).getTime(),
      windows: { fiveHour: 0.42, weekly: 0.3 },
      paidUsage: 'disabled',
      updatedAt: NOW - MINUTE,
      ...quota,
    },
    ownerAway: false,
    ...overrides,
  };
}

describe('runner state', () => {
  test('every runner state has a label and a tone', () => {
    const states: RunnerState[] = ['online', 'offline', 'needs_login', 'incompatible', 'crash_loop', 'disk_low'];
    expect(Object.keys(RUNNER_STATE_LABELS).sort()).toEqual([...states].sort());
    // The typecheck makes the labels cover RunnerState; core's schema confirms each is a state the hub sends.
    for (const state of states) expect(RunnerSchema.safeParse(runner({ state })).success).toBe(true);
    expect(RunnerSchema.safeParse(runner({ state: 'asleep' as RunnerState })).success).toBe(false);
    expect(states.map((state) => [state, RUNNER_STATE_LABELS[state], runnerTone(runner({ state }))])).toEqual([
      ['online', 'Online', 'done'],
      ['offline', 'Offline', 'closed'],
      ['needs_login', 'Needs login', 'trouble'],
      ['incompatible', 'Incompatible', 'trouble'],
      ['crash_loop', 'Crash loop', 'trouble'],
      ['disk_low', 'Disk low', 'trouble'],
    ]);
    expect(runnerTone(runner({ draining: true }))).toBe('wait');
  });

  test('every state but online has a one-line why', () => {
    expect(runnerWhy(runner(), NOW)).toBeNull();
    expect(runnerWhy(runner({ state: 'offline', lastSeenAt: NOW - 20 * MINUTE }), NOW)).toBe('Last seen 20 min ago');
    expect(runnerWhy(runner({ state: 'needs_login' }), NOW)).toBe(
      'Its login to the hub expired: run agflow login on that laptop',
    );
    expect(runnerWhy(runner({ state: 'incompatible' }), NOW)).toBe(
      'Its agflow is too old for this hub: update agflow on that laptop',
    );
    expect(runnerWhy(runner({ state: 'crash_loop', lastError: 'exit 1: bad config' }), NOW)).toBe(
      'It crashed three times in ten minutes (exit 1: bad config) and drained itself; agflow runner undrain clears it',
    );
    expect(runnerWhy(runner({ state: 'crash_loop' }), NOW)).toBe(
      'It crashed three times in ten minutes and drained itself; agflow runner undrain clears it',
    );
    expect(runnerWhy(runner({ state: 'disk_low', disk: { freeBytes: 6_200_000_000, agflowBytes: 1e9 } }), NOW)).toBe(
      'Only 6.2 GB free: it takes no new work until there is more',
    );
    expect(runnerWhy(runner({ state: 'disk_low', disk: null }), NOW)).toBe(
      'Its disk is nearly full: it takes no new work until there is more',
    );
    expect(runnerWhy(runner({ draining: true }), NOW)).toBe('Draining: it finishes its work but starts nothing new');
  });

  test("the hub's own line wins in any state, which covers a refused start", () => {
    expect(runnerWhy(runner({ stateDetail: 'refused a start: battery low' }), NOW)).toBe('refused a start: battery low');
    expect(runnerWhy(runner({ state: 'needs_login', stateDetail: 'the CLI login expired' }), NOW)).toBe(
      'the CLI login expired',
    );
    expect(runnerWhy(runner({ state: 'disk_low', stateDetail: '4.1 GB free, below 10 GB' }), NOW)).toBe(
      '4.1 GB free, below 10 GB',
    );
  });

  test('a crash loop always names the way out, with the hub line in place of the last error', () => {
    expect(runnerWhy(runner({ state: 'crash_loop', stateDetail: 'exit 2', lastError: 'exit 1' }), NOW)).toBe(
      'It crashed three times in ten minutes (exit 2) and drained itself; agflow runner undrain clears it',
    );
  });

  test('takes no new work until a time in the future, and says nothing once it passed', () => {
    const until = new Date(2026, 9, 29, 14, 5).getTime();
    expect(acceptingText(runner({ acceptingUntil: until }), NOW)).toBe('takes no new work until 14:05');
    expect(acceptingText(runner({ acceptingUntil: until }), until)).toBeNull();
    expect(acceptingText(runner({ acceptingUntil: null }), NOW)).toBeNull();
    const tomorrow = new Date(2026, 9, 30, 9, 0).getTime();
    expect(acceptingText(runner({ acceptingUntil: tomorrow }), NOW)).toBe('takes no new work until Oct 30, 09:00');
  });

  test('clockTime gives the time of day, with the date when it is another day', () => {
    expect(clockTime(new Date(2026, 9, 29, 9, 7).getTime(), NOW)).toBe('09:07');
    expect(clockTime(new Date(2026, 0, 3, 23, 59).getTime(), NOW)).toBe('Jan 3, 23:59');
  });
});

describe('slots, power, disk, keep-awake and git', () => {
  test('free slots come from capacity and the open attempts, never below 0', () => {
    expect(slotsText(runner({ capacity: 3, activeAttempts: 2 }))).toBe('1 of 3 slots free');
    expect(slotsText(runner({ capacity: 2, activeAttempts: 4 }))).toBe('0 of 2 slots free');
    expect(slotsText(runner({ capacity: 1, activeAttempts: 0 }))).toBe('1 of 1 slot free');
    expect(slotsText(runner({ capacity: 0, activeAttempts: 0 }))).toBe('0 of 0 slots free');
  });

  test('power covers AC, battery, low power mode, an unknown source and no report', () => {
    expect(powerText({ source: 'ac', batteryPercent: 88, lowPowerMode: false })).toBe('On AC power');
    expect(powerText({ source: 'battery', batteryPercent: 64.4, lowPowerMode: false })).toBe('On battery, 64%');
    expect(powerText({ source: 'battery', batteryPercent: null, lowPowerMode: true })).toBe(
      'On battery, low power mode',
    );
    expect(powerText({ source: 'ac', batteryPercent: null, lowPowerMode: true })).toBe('On AC power, low power mode');
    expect(powerText({ source: 'unknown', batteryPercent: null, lowPowerMode: false })).toBe('Power source unknown');
    expect(powerText(null)).toBe('No power report');
  });

  test('disk space in GB and MB', () => {
    expect(formatBytes(120_000_000_000)).toBe('120 GB');
    expect(formatBytes(6_240_000_000)).toBe('6.2 GB');
    expect(formatBytes(1_000_000_000)).toBe('1.0 GB');
    expect(formatBytes(512_300_000)).toBe('512 MB');
    expect(formatBytes(0)).toBe('0 MB');
    expect(diskText({ freeBytes: 120_000_000_000, agflowBytes: 3_400_000_000 })).toBe(
      '120 GB free, 3.4 GB used by agflow',
    );
    expect(diskText(null)).toBe('No disk report');
  });

  test('keep-awake modes and git readiness', () => {
    expect(KEEP_AWAKE_LABELS).toEqual({
      off: 'Sleeps as usual',
      ac: 'Kept awake on AC power',
      always: 'Always kept awake',
    });
    expect(gitText(runner().git, NOW)).toBe('Git ready, last push 5 min ago');
    expect(gitText({ ready: true, problem: null, lastPushAt: null }, NOW)).toBe('Git ready, no push yet');
    expect(gitText({ ready: false, problem: 'cannot reach origin', lastPushAt: null }, NOW)).toBe(
      'Git not ready: cannot reach origin',
    );
    expect(gitText({ ready: false, problem: null, lastPushAt: null }, NOW)).toBe('Git not ready');
  });
});

describe('vendors', () => {
  test('a ready vendor with its version, plan and account', () => {
    const view = vendorView(vendor(), account());
    expect(view).toEqual({
      vendor: 'claude',
      name: 'Claude Code',
      ready: true,
      status: 'Ready',
      tone: 'done',
      version: '2.1.285',
      plan: 'Claude Max',
      managed: null,
      degraded: null,
      ownerAway: null,
    });
  });

  test("a vendor that is not ready shows its problem, and the owner's version when it differs", () => {
    const view = vendorView(
      vendor({
        vendor: 'codex',
        ready: false,
        problem: 'not logged in',
        cliVersion: '0.130.0',
        ownerCliVersion: '0.131.2',
        plan: null,
      }),
      null,
    );
    expect(view).toMatchObject({ name: 'Codex', ready: false, status: 'not logged in', tone: 'trouble', plan: null });
    expect(view.version).toBe("0.130.0 (the owner's own: 0.131.2)");
    expect(vendorView(vendor({ ready: false, problem: null }), null).status).toBe('Not ready');
    expect(vendorView(vendor({ cliVersion: null, ownerCliVersion: null }), null).version).toBe('not installed');
  });

  test('a managed policy is explained and a degraded vendor is marked', () => {
    const managed = vendorView(vendor({ vendor: 'codex', managedPolicy: true }), null);
    expect(managed.managed).toBe(
      'A managed device policy applies: commands outside the sandbox need the owner to approve them',
    );
    const degraded = vendorView(vendor({ degraded: true }), null);
    expect(degraded.tone).toBe('wait');
    expect(degraded.degraded).toBe('Degraded after an hour of vendor errors: placement prefers the other vendor for now');
  });

  test('owner away comes from the shared account', () => {
    expect(vendorView(vendor(), account({ ownerAway: true })).ownerAway).toBe(
      'demo seems away: an approval timed out, so this account takes no new work until demo acts',
    );
  });

  test('accountOf matches the owner, the vendor and the account id', () => {
    const mine = account();
    const accounts = [
      account({ owner: 'ann' }),
      account({ vendor: 'codex' }),
      account({ accountId: 'ffffffffffffffff' }),
      mine,
    ];
    const r = runner();
    expect(accountOf(r, vendor(), accounts)).toBe(mine);
    expect(accountOf(r, vendor({ accountId: null }), accounts)).toBeNull();
    expect(accountOf(runner({ owner: 'bob' }), vendor(), accounts)).toBeNull();
  });
});

describe('quota', () => {
  test("both windows against this runner's ceilings, with the account's one reset time", () => {
    const { meters, line, tone } = quotaMeters(vendor({ ceilings: { fiveHour: 0.85, weekly: 0.25 } }), account(), NOW);
    expect(meters).toEqual([
      { window: 'fiveHour', label: '5-hour window', used: 0.42, ceiling: 0.85, over: false, text: '42% used, ceiling 85%' },
      {
        window: 'weekly',
        label: 'Weekly window',
        used: 0.3,
        ceiling: 0.25,
        over: true,
        text: '30% used, over the ceiling of 25%: no new attempts here',
      },
    ]);
    expect(line).toBe('Resets at 16:30');
    expect(tone).toBe('wait');
  });

  test('a ceiling of 0 keeps the vendor off this runner; unknown windows read unknown', () => {
    const { meters, tone } = quotaMeters(
      vendor({ ceilings: { fiveHour: 0, weekly: 0.85 } }),
      account({}, { windows: { fiveHour: 0.1, weekly: null } }),
      NOW,
    );
    expect(meters.map((meter) => [meter.text, meter.over])).toEqual([
      ['no new attempts here (ceiling 0)', true],
      ['unknown, ceiling 85%', false],
    ]);
    expect(tone).toBe('wait');
  });

  test('a window at its ceiling is over it, as placement has it', () => {
    const { meters } = quotaMeters(vendor(), account({}, { windows: { fiveHour: 0.85, weekly: 0.3 } }), NOW);
    expect(meters[0]).toMatchObject({ used: 0.85, over: true, text: '85% used, over the ceiling of 85%: no new attempts here' });
    expect(meters[1]?.over).toBe(false);
  });

  test('a ceiling of 0 keeps the vendor off while the utilization is unknown, with or without an account', () => {
    const zero = vendor({ ceilings: { fiveHour: 0, weekly: 0.85 } });
    const unreported = { state: 'unknown', resetsAt: null, windows: { fiveHour: null, weekly: null } } as const;
    const unknown = quotaMeters(zero, account({}, unreported), NOW);
    expect(unknown.meters.map((meter) => meter.over)).toEqual([true, false]);
    expect(unknown.tone).toBe('wait');
    const none = quotaMeters(zero, null, NOW);
    expect(none.meters.map((meter) => meter.over)).toEqual([true, false]);
    expect(none.tone).toBe('wait');
    const overUnknown = quotaMeters(vendor(), account({}, { ...unreported, windows: { fiveHour: 0.9, weekly: null } }), NOW);
    expect(overUnknown.line).toBe('Quota unknown');
    expect(overUnknown.tone).toBe('wait');
  });

  test('an exhausted account, with and without a reset time', () => {
    const resetsAt = new Date(2026, 9, 29, 16, 30).getTime();
    const exhausted = quotaMeters(vendor(), account({}, { state: 'exhausted', resetsAt }), NOW);
    expect(exhausted.line).toBe('Used up until 16:30 (in 2 h 30 min)');
    expect(exhausted.tone).toBe('trouble');
    expect(quotaMeters(vendor(), account({}, { state: 'exhausted', resetsAt: null }), NOW).line).toBe(
      'Used up; the reset time is unknown',
    );
  });

  test('an unknown quota and a vendor without an account', () => {
    const unreported = { state: 'unknown', resetsAt: null, windows: { fiveHour: null, weekly: null } } as const;
    const unknown = quotaMeters(vendor(), account({}, unreported), NOW);
    expect(unknown.line).toBe('Quota unknown');
    expect(unknown.tone).toBe('closed');
    expect(unknown.meters.map((meter) => meter.text)).toEqual(['unknown, ceiling 85%', 'unknown, ceiling 85%']);
    const none = quotaMeters(vendor({ accountId: null }), null, NOW);
    expect(none.line).toBe('No account report yet');
    expect(none.meters.map((meter) => meter.used)).toEqual([null, null]);
    expect(quotaMeters(vendor(), account({}, { resetsAt: null }), NOW).line).toBe('Reset time unknown');
  });

  test('a report past its reset time no longer says the account is used up or its limiting window over', () => {
    const resetsAt = new Date(2026, 9, 29, 13, 50).getTime();
    // Until the reset the report holds.
    const before = quotaMeters(vendor(), account({}, { state: 'exhausted', resetsAt }), resetsAt - MINUTE);
    expect(before.line).toBe('Used up until 13:50 (in 1 min)');
    expect(before.tone).toBe('trouble');
    // With an unknown reset the card keeps the exhaustion until a newer report, a probing start's included.
    const unknownReset = account({}, { state: 'exhausted', resetsAt: null, updatedAt: NOW - 600 * MINUTE });
    expect(quotaMeters(vendor(), unknownReset, NOW).tone).toBe('trouble');
    const exhausted = quotaMeters(
      vendor(),
      account({}, { state: 'exhausted', resetsAt, windows: { fiveHour: 1, weekly: 0.3 } }),
      NOW,
    );
    expect(exhausted.line).toBe('Reset at 13:50; waiting for a new report');
    expect(exhausted.tone).toBe('closed');
    expect(exhausted.meters.map((meter) => [meter.used, meter.over, meter.text])).toEqual([
      [null, false, 'unknown, ceiling 85%'],
      [0.3, false, '30% used, ceiling 85%'],
    ]);
    // The weekly window is the limiting one here, so the 5-hour one keeps its reading and stays over.
    const over = quotaMeters(vendor(), account({}, { resetsAt, windows: { fiveHour: 0.9, weekly: 0.95 } }), NOW);
    expect(over.line).toBe('Reset at 13:50; waiting for a new report');
    expect(over.tone).toBe('wait');
    expect(over.meters.map((meter) => [meter.used, meter.over])).toEqual([
      [0.9, true],
      [null, false],
    ]);
    // On a tie the 5-hour window is the one that reset.
    const tie = quotaMeters(vendor(), account({}, { resetsAt, windows: { fiveHour: 0.9, weekly: 0.9 } }), NOW);
    expect(tie.meters.map((meter) => meter.used)).toEqual([null, 0.9]);
    expect(paidUsageText(vendor(), account({}, { resetsAt, paidUsage: 'in_use' }), NOW)).toBe(
      'The account was drawing on paid usage before its reset; no newer report yet',
    );
  });

  test("paid usage, by the account's state and this runner's setting", () => {
    const text = (paidUsage: AccountQuota['quota']['paidUsage'], allowPaidUsage: boolean) =>
      paidUsageText(vendor({ allowPaidUsage }), account({}, { paidUsage }), NOW);
    expect(text('disabled', false)).toBe('Paid usage is off for the account');
    expect(text('disabled', true)).toBe('Paid usage is off for the account');
    expect(text('enabled', false)).toBe('Paid usage is on for the account; this runner stops at the plan limit');
    expect(text('enabled', true)).toBe('Paid usage is on for the account, and this runner may draw on it');
    expect(text('in_use', false)).toBe('The account is drawing on paid usage, so this runner starts nothing new');
    expect(text('in_use', true)).toBe('The account is drawing on paid usage, which this runner allows');
    expect(text('unknown', false)).toBe('Paid usage unknown; this runner never draws on it');
    expect(text('unknown', true)).toBe('Paid usage unknown; this runner may draw on it');
    expect(paidUsageText(vendor(), null, NOW)).toBe('Paid usage unknown; this runner never draws on it');
  });
});

describe('profile and order', () => {
  test('the profile, each weakened boundary and missing dependency preparation', () => {
    expect(profileLines({ name: 'standard', weakened: [], dependencyPrep: true })).toEqual([
      { text: 'Standard profile', tone: 'done' },
    ]);
    expect(profileLines({ name: 'auto', weakened: ['auto mode', '/tmp/claude'], dependencyPrep: false })).toEqual([
      { text: 'Auto profile', tone: 'done' },
      { text: 'Not enforced on this laptop: auto mode', tone: 'trouble' },
      { text: 'Not enforced on this laptop: /tmp/claude', tone: 'trouble' },
      {
        text: "No sandbox for dependency preparation: Claude agents install their own, and Codex agents need the owner's approval",
        tone: 'wait',
      },
    ]);
  });

  test("the signed-in person's runners first, then online ones, then by id", () => {
    expect(isOwner(runner(), { user: 'demo' })).toBe(true);
    expect(isOwner(runner(), { user: 'ann' })).toBe(false);
    expect(isOwner(runner(), null)).toBe(false);
    const runners = [
      runner({ id: 'R-10', owner: 'ann' }),
      runner({ id: 'R-3', owner: 'ann', state: 'offline' }),
      runner({ id: 'R-2', owner: 'ann' }),
      runner({ id: 'R-4', owner: 'demo', state: 'offline' }),
      runner({ id: 'R-11', owner: 'demo' }),
    ];
    expect(sortRunners(runners, { user: 'demo' }).map((r) => r.id)).toEqual(['R-11', 'R-4', 'R-2', 'R-10', 'R-3']);
    expect(runners[0]?.id).toBe('R-10');
    expect(sortRunners(runners, null).map((r) => r.id)).toEqual(['R-2', 'R-10', 'R-11', 'R-3', 'R-4']);
  });
});

describe('owner settings', () => {
  const twoVendors = () =>
    runner({
      capacity: 3,
      keepAwake: 'ac',
      draining: false,
      vendors: [
        vendor(),
        vendor({ vendor: 'codex', ceilings: { fiveHour: 0.6, weekly: 0 }, allowPaidUsage: true }),
      ],
    });

  /** The runner's draft with some fields typed over. */
  const edited = (change: (draft: SettingsDraft) => void, from: Runner = twoVendors()): SettingsDraft => {
    const draft = draftFromRunner(from);
    change(draft);
    return draft;
  };

  test('draftFromRunner reads capacity, keep-awake, draining, the ceilings as whole percents and paid usage', () => {
    expect(draftFromRunner(twoVendors())).toEqual({
      capacity: '3',
      keepAwake: 'ac',
      draining: false,
      vendors: [
        { vendor: 'claude', fiveHour: '85', weekly: '85', allowPaidUsage: false },
        { vendor: 'codex', fiveHour: '60', weekly: '0', allowPaidUsage: true },
      ],
    });
    // A ceiling set by hand in runner.json reads as the nearest whole percent.
    const odd = runner({ vendors: [vendor({ ceilings: { fiveHour: 0.855, weekly: 0.004 } })] });
    expect(draftFromRunner(odd).vendors[0]).toMatchObject({ fiveHour: '86', weekly: '0' });
  });

  test('settingsPatch sends only what changed, with the ceilings back as 0..1, and null when nothing changed', () => {
    const before = twoVendors();
    expect(settingsPatch(before, draftFromRunner(before))).toBeNull();
    expect(settingsPatch(before, edited((draft) => (draft.capacity = '4')))).toEqual({ capacity: 4 });
    expect(settingsPatch(before, edited((draft) => (draft.capacity = ' 03 ')))).toBeNull();
    expect(settingsPatch(before, edited((draft) => (draft.keepAwake = 'always')))).toEqual({ keepAwake: 'always' });
    expect(settingsPatch(before, edited((draft) => (draft.draining = true)))).toEqual({ draining: true });
    // A vendor's ceilings go as a pair, the window left alone included; the other vendor is not sent.
    const codex = edited((draft) => {
      const entry = draft.vendors[1];
      if (entry) entry.weekly = '50';
    });
    expect(settingsPatch(before, codex)).toEqual({ ceilings: { codex: { fiveHour: 0.6, weekly: 0.5 } } });
    const paid = edited((draft) => {
      const entry = draft.vendors[0];
      if (entry) entry.allowPaidUsage = true;
    });
    expect(settingsPatch(before, paid)).toEqual({ allowPaidUsage: { claude: true } });
    const everything = edited((draft) => {
      draft.capacity = '16';
      draft.keepAwake = 'off';
      draft.vendors = draft.vendors.map((entry) => ({ ...entry, fiveHour: '100', allowPaidUsage: !entry.allowPaidUsage }));
    });
    expect(settingsPatch(before, everything)).toEqual({
      capacity: 16,
      keepAwake: 'off',
      ceilings: { claude: { fiveHour: 1, weekly: 0.85 }, codex: { fiveHour: 1, weekly: 0 } },
      allowPaidUsage: { claude: true, codex: false },
    });
    // An untouched ceiling set by hand is not rounded and sent back.
    const odd = runner({ vendors: [vendor({ ceilings: { fiveHour: 0.855, weekly: 0.85 } })] });
    expect(settingsPatch(odd, draftFromRunner(odd))).toBeNull();
    // Editing the other window sends the hand-set one back exactly, not as its rounded percent.
    const oddWeekly = draftFromRunner(odd);
    const claude = oddWeekly.vendors[0];
    if (claude) claude.weekly = '50';
    expect(settingsPatch(odd, oddWeekly)).toEqual({ ceilings: { claude: { fiveHour: 0.855, weekly: 0.5 } } });
  });

  test('settingsProblem refuses a capacity outside 1..16 or not whole, and a ceiling outside 0-100%', () => {
    expect(settingsProblem(draftFromRunner(twoVendors()))).toBeNull();
    for (const capacity of ['0', '17', '2.5', '-1', '', ' ', 'three']) {
      expect(settingsProblem(edited((draft) => (draft.capacity = capacity)))).toBe(
        'Capacity must be a whole number from 1 to 16',
      );
    }
    const ceiling = (value: string) =>
      settingsProblem(
        edited((draft) => {
          const entry = draft.vendors[1];
          if (entry) entry.weekly = value;
        }),
      );
    for (const value of ['0', '100', '42', '12.5']) expect(ceiling(value)).toBeNull();
    for (const value of ['-1', '101', '', 'most']) {
      expect(ceiling(value)).toBe("Codex's weekly ceiling must be a percentage from 0 to 100");
    }
  });

  test("settingsProblem agrees with core's RunnerPatchInputSchema on a table of values", () => {
    const capacities = [-1, 0, 0.5, 1, 2, 2.5, 8, 15.99, 16, 17, 100, Number.NaN];
    for (const value of capacities) {
      const accepted = settingsProblem(edited((draft) => (draft.capacity = String(value)))) === null;
      const schema = RunnerPatchInputSchema.safeParse({ capacity: value }).success;
      expect({ capacity: value, accepted }).toEqual({ capacity: value, accepted: schema });
    }
    const percents = [-50, -1, -0.5, 0, 0.5, 1, 42, 85, 99.5, 100, 100.5, 101, 1000, Number.NaN];
    for (const value of percents) {
      const draft = edited((entry) => {
        const claude = entry.vendors[0];
        if (claude) claude.fiveHour = String(value);
      });
      const accepted = settingsProblem(draft) === null;
      const patch = { ceilings: { claude: { fiveHour: value / 100, weekly: 0.85 } } };
      const schema = RunnerPatchInputSchema.safeParse(patch).success;
      expect({ percent: value, accepted }).toEqual({ percent: value, accepted: schema });
      // What the form sends for an accepted value passes the schema too.
      const sent = settingsPatch(twoVendors(), draft);
      if (accepted && sent) expect(RunnerPatchInputSchema.safeParse(sent).success).toBe(true);
    }
    expect(capacities.filter((value) => settingsProblem(edited((d) => (d.capacity = String(value)))) === null)).toEqual([
      1, 2, 8, 16,
    ]);
  });
});
