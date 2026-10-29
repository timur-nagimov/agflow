// What a runner card says (design 11's Runners row; 6.1, 6.3, 6.10, 7.6, 7.8, 7.9). Free of the DOM so the rules are
// unit-tested; placement itself stays in core's scheduling.ts, and the card only reports what the hub sends.
import {
  type AccountQuota,
  type AccountView,
  freeSlots,
  type ProfileSummary,
  type Runner,
  type RunnerState,
  type RunnerVendor,
  reportHolds,
  utilization,
  type Vendor,
} from '@agflow/core';
import type { Me } from './api';
import { ago, percent, type Tone, untilText, VENDOR_NAMES } from './format';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export const RUNNER_STATE_LABELS: Record<RunnerState, string> = {
  online: 'Online',
  offline: 'Offline',
  needs_login: 'Needs login',
  incompatible: 'Incompatible',
  crash_loop: 'Crash loop',
  disk_low: 'Disk low',
};

/** An offline runner is simply away; the other states need someone at that laptop. Draining is chosen, so it waits. */
export function runnerTone(runner: Pick<Runner, 'state' | 'draining'>): Tone {
  if (runner.state === 'online') return runner.draining ? 'wait' : 'done';
  return runner.state === 'offline' ? 'closed' : 'trouble';
}

/**
 * One line saying why a runner is not simply working: the hub's own line when it gave one, in any state (a refused
 * start sets it on an online runner), otherwise a default for the state. A crash loop always names its way out, with
 * the hub's line or the last error in it, because the runner stays drained until a person runs undrain.
 */
export function runnerWhy(
  runner: Pick<Runner, 'state' | 'stateDetail' | 'lastError' | 'draining' | 'disk' | 'lastSeenAt'>,
  now: number,
): string | null {
  if (runner.state === 'crash_loop') {
    const error = runner.stateDetail ?? runner.lastError;
    const why = `It crashed three times in ten minutes${error ? ` (${error})` : ''} and drained itself`;
    return `${why}; agflow runner undrain clears it`;
  }
  if (runner.stateDetail) return runner.stateDetail;
  switch (runner.state) {
    case 'online':
      return runner.draining ? 'Draining: it finishes its work but starts nothing new' : null;
    case 'offline':
      return `Last seen ${ago(runner.lastSeenAt, now)}`;
    case 'needs_login':
      return 'Its login to the hub expired: run agflow login on that laptop';
    case 'incompatible':
      return 'Its agflow is too old for this hub: update agflow on that laptop';
    case 'disk_low':
      return `${
        runner.disk ? `Only ${formatBytes(runner.disk.freeBytes)} free` : 'Its disk is nearly full'
      }: it takes no new work until there is more`;
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A local time of day ("14:05"), with the date in front when it is not today ("Oct 30, 09:00"). */
export function clockTime(ts: number, now: number): string {
  const date = new Date(ts);
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return date.toDateString() === new Date(now).toDateString()
    ? time
    : `${MONTHS[date.getMonth()]} ${date.getDate()}, ${time}`;
}

/** While acceptingUntil is ahead (waking, low battery, low disk), placement passes the runner over. */
export function acceptingText(runner: Pick<Runner, 'acceptingUntil'>, now: number): string | null {
  if (runner.acceptingUntil === null || runner.acceptingUntil <= now) return null;
  return `takes no new work until ${clockTime(runner.acceptingUntil, now)}`;
}

// ---------------------------------------------------------------------------
// Slots, power, disk, keep-awake and git
// ---------------------------------------------------------------------------

/** activeAttempts counts starting, running and quota_wait attempts, a lead's included: placement's openAttempts. */
export function slotsText(runner: Pick<Runner, 'capacity' | 'activeAttempts'>): string {
  const free = freeSlots({ capacity: runner.capacity, openAttempts: runner.activeAttempts });
  return `${free} of ${runner.capacity} slot${runner.capacity === 1 ? '' : 's'} free`;
}

export function powerText(power: Runner['power']): string {
  if (!power) return 'No power report';
  const lowPower = power.lowPowerMode ? ', low power mode' : '';
  switch (power.source) {
    case 'ac':
      return `On AC power${lowPower}`;
    case 'battery':
      return `On battery${power.batteryPercent === null ? '' : `, ${Math.round(power.batteryPercent)}%`}${lowPower}`;
    case 'unknown':
      return `Power source unknown${lowPower}`;
  }
}

/** Decimal units, as macOS shows disk space: "6.2 GB", "120 GB", "512 MB". */
export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) {
    const gb = bytes / 1e9;
    return `${gb < 100 ? gb.toFixed(1) : Math.round(gb)} GB`;
  }
  return `${Math.round(bytes / 1e6)} MB`;
}

export function diskText(disk: Runner['disk']): string {
  if (!disk) return 'No disk report';
  return `${formatBytes(disk.freeBytes)} free, ${formatBytes(disk.agflowBytes)} used by agflow`;
}

export const KEEP_AWAKE_LABELS: Record<Runner['keepAwake'], string> = {
  off: 'Sleeps as usual',
  ac: 'Kept awake on AC power',
  always: 'Always kept awake',
};

export function gitText(git: Runner['git'], now: number): string {
  if (!git.ready) return git.problem ? `Git not ready: ${git.problem}` : 'Git not ready';
  return git.lastPushAt === null ? 'Git ready, no push yet' : `Git ready, last push ${ago(git.lastPushAt, now)}`;
}

// ---------------------------------------------------------------------------
// Vendors and their accounts
// ---------------------------------------------------------------------------

/**
 * The account a vendor on a runner is logged in to, which every runner of that owner on that account shares (6.10):
 * its quota and owner-away mark apply to all of them. A vendor whose account the runner does not know has none.
 */
export function accountOf(
  runner: Pick<Runner, 'owner'>,
  vendor: Pick<RunnerVendor, 'vendor' | 'accountId'>,
  accounts: AccountQuota[],
): AccountQuota | null {
  if (vendor.accountId === null) return null;
  return (
    accounts.find(
      (account) =>
        account.owner === runner.owner && account.vendor === vendor.vendor && account.accountId === vendor.accountId,
    ) ?? null
  );
}

export interface VendorView {
  vendor: Vendor;
  name: string;
  ready: boolean;
  /** "Ready", or the runner's problem ("not logged in", "binary missing", …). */
  status: string;
  tone: Tone;
  /** The runner's own pinned binary, with the owner's install when it differs. */
  version: string;
  plan: string | null;
  /** On a managed device: why so much there needs the owner. */
  managed: string | null;
  degraded: string | null;
  ownerAway: string | null;
}

export function vendorView(vendor: RunnerVendor, account: AccountQuota | null): VendorView {
  const runnerVersion = vendor.cliVersion ?? 'not installed';
  const ownerVersion =
    vendor.ownerCliVersion && vendor.ownerCliVersion !== vendor.cliVersion
      ? ` (the owner's own: ${vendor.ownerCliVersion})`
      : '';
  return {
    vendor: vendor.vendor,
    name: VENDOR_NAMES[vendor.vendor],
    ready: vendor.ready,
    status: vendor.ready ? 'Ready' : (vendor.problem ?? 'Not ready'),
    tone: !vendor.ready ? 'trouble' : vendor.degraded ? 'wait' : 'done',
    version: `${runnerVersion}${ownerVersion}`,
    plan: vendor.plan,
    // The runner never answers approvals itself, so a managed policy changes nothing but who gets asked (6.10).
    managed: vendor.managedPolicy
      ? 'A managed device policy applies: commands outside the sandbox need the owner to approve them'
      : null,
    degraded: vendor.degraded
      ? 'Degraded after an hour of vendor errors: placement prefers the other vendor for now'
      : null,
    ownerAway: account?.ownerAway
      ? `${account.owner} seems away: an approval timed out, so this account takes no new work until ${account.owner} acts`
      : null,
  };
}

// ---------------------------------------------------------------------------
// Quota
// ---------------------------------------------------------------------------

export interface QuotaMeter {
  window: 'fiveHour' | 'weekly';
  label: string;
  /** The account's utilization, 0..1; null when unknown. */
  used: number | null;
  /** This runner's ceiling for the window, 0..1. */
  ceiling: number;
  /** At or above the ceiling, the vendor gets no new attempts on this runner. */
  over: boolean;
  text: string;
}

export interface QuotaMeters {
  meters: QuotaMeter[];
  /** The account's state, with its one reset time: the limiting window's (X-22). */
  line: string;
  tone: Tone;
}

const WINDOW_LABELS: Record<QuotaMeter['window'], string> = { fiveHour: '5-hour window', weekly: 'Weekly window' };

/**
 * The account as placement reads it (core's scheduling.ts, X-49). The card does not see the account's open attempts,
 * which rule out the probing start of an exhausted Claude account whose reset is unknown, so it counts one: the card
 * keeps showing that report until the probe's outcome arrives as a newer one.
 */
const accountView = (account: AccountQuota): AccountView => ({ ...account, openAttempts: 1 });

/** Whether the account's report still holds, by placement's own rule. */
function reportHoldsNow(account: AccountQuota, now: number): boolean {
  return reportHolds({ now, quotaUnknownMs: 0, runners: [], accounts: [] }, accountView(account));
}

/**
 * Both quota windows of the shared account against this runner's own ceilings, compared as placement compares them:
 * an unknown window counts as 0, so only a ceiling of 0 keeps the vendor off while the utilization is unknown. Once the
 * report no longer holds, its limiting window has reset and reads unknown until a newer report.
 */
export function quotaMeters(vendor: RunnerVendor, account: AccountQuota | null, now: number): QuotaMeters {
  const holds = account !== null && reportHoldsNow(account, now);
  const windows = account?.quota.windows ?? { fiveHour: null, weekly: null };
  const placed = utilization(account && accountView(account), holds);
  const meters = (['fiveHour', 'weekly'] as const).map((window): QuotaMeter => {
    const reading = windows[window];
    // A reading placement no longer counts is a window that has reset.
    const used = reading === null || placed[window] !== reading ? null : reading;
    const ceiling = vendor.ceilings[window];
    const over = placed[window] >= ceiling;
    let text: string;
    if (ceiling === 0) text = 'no new attempts here (ceiling 0)';
    else if (used === null) text = `unknown, ceiling ${percent(ceiling)}`;
    else if (over) text = `${percent(used)} used, over the ceiling of ${percent(ceiling)}: no new attempts here`;
    else text = `${percent(used)} used, ceiling ${percent(ceiling)}`;
    return { window, label: WINDOW_LABELS[window], used, ceiling, over, text };
  });
  // A window over its ceiling keeps the vendor off this runner whatever else the account says.
  const over = meters.some((meter) => meter.over);
  if (!account) return { meters, line: 'No account report yet', tone: over ? 'wait' : 'closed' };
  const { state, resetsAt } = account.quota;
  if (!holds && resetsAt !== null) {
    const line = `Reset at ${clockTime(resetsAt, now)}; waiting for a new report`;
    return { meters, line, tone: over ? 'wait' : 'closed' };
  }
  if (state === 'exhausted') {
    const line =
      resetsAt === null
        ? 'Used up; the reset time is unknown'
        : `Used up until ${clockTime(resetsAt, now)} (${untilText(resetsAt, now)})`;
    return { meters, line, tone: 'trouble' };
  }
  if (state === 'unknown') return { meters, line: 'Quota unknown', tone: over ? 'wait' : 'closed' };
  const line = resetsAt === null ? 'Reset time unknown' : `Resets at ${clockTime(resetsAt, now)}`;
  return { meters, line, tone: over ? 'wait' : 'done' };
}

/**
 * The runner's allowPaidUsage decides whether paid usage in use counts as a limit hit there (6.10). Paid usage in use
 * lapses with its report, as placement has it.
 */
export function paidUsageText(
  vendor: Pick<RunnerVendor, 'allowPaidUsage'>,
  account: AccountQuota | null,
  now: number,
): string {
  const allowed = vendor.allowPaidUsage;
  const paidUsage = account?.quota.paidUsage ?? 'unknown';
  if (paidUsage === 'in_use' && account !== null && !reportHoldsNow(account, now)) {
    return 'The account was drawing on paid usage before its reset; no newer report yet';
  }
  switch (paidUsage) {
    case 'disabled':
      return 'Paid usage is off for the account';
    case 'enabled':
      return allowed
        ? 'Paid usage is on for the account, and this runner may draw on it'
        : 'Paid usage is on for the account; this runner stops at the plan limit';
    case 'in_use':
      return allowed
        ? 'The account is drawing on paid usage, which this runner allows'
        : 'The account is drawing on paid usage, so this runner starts nothing new';
    case 'unknown':
      return allowed
        ? 'Paid usage unknown; this runner may draw on it'
        : 'Paid usage unknown; this runner never draws on it';
  }
}

// ---------------------------------------------------------------------------
// Profile, ownership and order
// ---------------------------------------------------------------------------

/** The profile's name, then each boundary this laptop cannot enforce, then a missing preparation sandbox (7.7). */
export function profileLines(profile: ProfileSummary): { text: string; tone: Tone }[] {
  const lines: { text: string; tone: Tone }[] = [
    { text: profile.name === 'auto' ? 'Auto profile' : 'Standard profile', tone: 'done' },
    ...profile.weakened.map((item) => ({ text: `Not enforced on this laptop: ${item}`, tone: 'trouble' as const })),
  ];
  if (!profile.dependencyPrep) {
    lines.push({
      text: "No sandbox for dependency preparation: Claude agents install their own, and Codex agents need the owner's approval",
      tone: 'wait',
    });
  }
  return lines;
}

/** Only the owner changes a runner's settings or retires it; the hub checks too. */
export function isOwner(runner: Pick<Runner, 'owner'>, me: Pick<Me, 'user'> | null): boolean {
  return me !== null && runner.owner === me.user;
}

const runnerNumber = (id: string): number => Number(id.slice(2));

/** The signed-in person's runners first, then online ones, then by number (R-2 before R-10). */
export function sortRunners(runners: Runner[], me: Pick<Me, 'user'> | null): Runner[] {
  const rank = (runner: Runner) => (isOwner(runner, me) ? 0 : 2) + (runner.state === 'online' ? 0 : 1);
  return [...runners].sort((a, b) => rank(a) - rank(b) || runnerNumber(a.id) - runnerNumber(b.id));
}
