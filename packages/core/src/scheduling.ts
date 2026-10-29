// Placement, the first half of design 6.6's step 5: which runners may take an attempt, how many slots they have free,
// and which of their vendors are usable, with a named refusal for each one that is not. This is the only copy of these
// rules (X-46): the hub builds the snapshot from its database, and both the scheduler and rejectTask's ladder step 1
// read it through these functions. Pure, with no zod at run time, so the web UI may import it too (X-48).
import type { StartRefusal } from './runner-protocol';
import type { AccountQuota, Runner, RunnerState, Vendor } from './types';

/**
 * Why placement passes over a runner, then over a vendor on it, in the order they are checked:
 * - offline: the runner's state is not online (offline, needs_login, incompatible, crash_loop or disk_low);
 * - draining: it takes no new work;
 * - git: it cannot fetch or push (git.ready is false);
 * - accepting: its last heartbeat asked for no new attempt before acceptingUntil (waking, low battery, low disk);
 * - refused_start: it refused a start since its last heartbeat (X-3);
 * - full: its starting, running and quota_wait attempts fill its capacity;
 * - not_ready: the vendor is not ready there, by the runner's report or by a hub mark;
 * - degraded: continuous vendor errors marked the vendor degraded there;
 * - exhausted: the vendor's account has no quota left until its reset;
 * - paid_usage: work would draw on paid usage, which the runner does not allow;
 * - owner_away: an approval of the runner's owner timed out (design 6.10);
 * - ceiling: the account's utilization reached the runner's ceiling for the vendor.
 */
export const PLACEMENT_REFUSALS = [
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
] as const;
export type PlacementRefusal = (typeof PLACEMENT_REFUSALS)[number];

/** A vendor on a runner, as placement sees it. */
export interface VendorSlot {
  vendor: Vendor;
  /** The runner's report: its binary is there, it is logged in and its preflight passed. */
  ready: boolean;
  /** The hub's not-ready mark (two failed starts, an expired login), which a later passing preflight clears. */
  notReadySince: number | null;
  /** The hub's degraded mark after continuous vendor errors: no placement before this time. */
  degradedUntil: number | null;
  /** The account the vendor is logged in to; null when the runner does not know it. */
  accountId: string | null;
  /** The runner's ceilings for the vendor: the account utilization, 0..1, at which it gets no new attempts there. */
  ceilings: { fiveHour: number; weekly: number };
  /** Whether work on this runner may draw on paid usage. */
  allowPaidUsage: boolean;
}

/** A runner, as placement sees it. */
export interface RunnerSlot {
  id: string;
  owner: string;
  state: RunnerState;
  draining: boolean;
  /** git.ready: the runner can fetch and push. */
  gitReady: boolean;
  /** Epoch ms from its last heartbeat: no placement before it. */
  acceptingUntil: number | null;
  /** A start it refused since its last heartbeat, which the next heartbeat clears (X-3). */
  startRefusal: { code: StartRefusal; at: number } | null;
  capacity: number;
  /** Its starting, running and quota_wait attempts, a lead's included. */
  openAttempts: number;
  /** Its power source, for the runner preference. */
  power: Runner['power'];
  vendors: VendorSlot[];
}

/** An account of one owner on one vendor, shared by the owner's runners logged in to it. */
export interface AccountView extends AccountQuota {
  /** The vendor's starting, running and quota_wait attempts on the owner's runners logged in to the account. */
  openAttempts: number;
}

/** What placement reads, as the hub builds it from its database; it is rebuilt or updated after each placement. */
export interface PlacementSnapshot {
  now: number;
  /** HubConfig.quotaUnknownMs: how long an exhaustion with an unknown reset holds before a Claude probe. */
  quotaUnknownMs: number;
  runners: RunnerSlot[];
  accounts: AccountView[];
}

/** A runner placement passed over, or one vendor on it, and why. */
export interface RefusedPlacement {
  runnerId: string;
  /** Null when the runner itself was refused. */
  vendor: Vendor | null;
  refusal: PlacementRefusal;
}

/** A vendor usable on a runner, with its account when the hub has a quota report for it. */
export interface UsableVendor {
  slot: VendorSlot;
  account: AccountView | null;
}

/** The slots a runner has left: its capacity less its open attempts, and never fewer than none. */
export function freeSlots(runner: Pick<RunnerSlot, 'capacity' | 'openAttempts'>): number {
  return Math.max(0, runner.capacity - runner.openAttempts);
}

function runnerRefusal(snapshot: PlacementSnapshot, runner: RunnerSlot): PlacementRefusal | null {
  if (runner.state !== 'online') return 'offline';
  if (runner.draining) return 'draining';
  if (!runner.gitReady) return 'git';
  if (runner.acceptingUntil !== null && snapshot.now < runner.acceptingUntil) return 'accepting';
  if (runner.startRefusal !== null) return 'refused_start';
  if (freeSlots(runner) < 1) return 'full';
  return null;
}

/**
 * The runners that may take an attempt now (design 6.6, step 5): online, not draining, git ready, past the
 * acceptingUntil of their last heartbeat, without a refused start since that heartbeat, and with a free slot. Every
 * other runner comes with its first refusal. Vendors are usableVendors' to judge.
 */
export function candidateRunners(snapshot: PlacementSnapshot): {
  candidates: RunnerSlot[];
  refused: RefusedPlacement[];
} {
  const candidates: RunnerSlot[] = [];
  const refused: RefusedPlacement[] = [];
  for (const runner of snapshot.runners) {
    const refusal = runnerRefusal(snapshot, runner);
    if (refusal === null) candidates.push(runner);
    else refused.push({ runnerId: runner.id, vendor: null, refusal });
  }
  return { candidates, refused };
}

/** The owner's account a vendor on the runner draws on, when the runner names one and the hub has a report for it. */
function accountOf(snapshot: PlacementSnapshot, runner: RunnerSlot, slot: VendorSlot): AccountView | null {
  if (slot.accountId === null) return null;
  const matches = (account: AccountView) =>
    account.owner === runner.owner && account.vendor === slot.vendor && account.accountId === slot.accountId;
  return snapshot.accounts.find(matches) ?? null;
}

/**
 * Whether an account's quota report still holds in full (design 6.10): its state, paid usage and both windows. A
 * report holds until its resetsAt, and with an unknown reset until a newer report, but for one probing start: an
 * exhausted Claude account whose reset is unknown gets the next start quotaUnknownMs after the report, while none of
 * its attempts is open, because that start is how the hub finds out. A Codex account waits for the hub's preflight
 * probe instead. Exported for the web's runner card (X-49), which shows the same lapse.
 */
export function reportHolds(snapshot: PlacementSnapshot, account: AccountView): boolean {
  const { quota } = account;
  if (quota.resetsAt !== null) return snapshot.now < quota.resetsAt;
  const probe =
    account.vendor === 'claude' &&
    quota.state === 'exhausted' &&
    snapshot.now >= quota.updatedAt + snapshot.quotaUnknownMs &&
    account.openAttempts === 0;
  return !probe;
}

/**
 * The account utilization that placement compares with the runner's ceilings, with unknown utilization as 0. A
 * report's resetsAt is the reset of its limiting window, the more used one (X-22), so a report that no longer holds
 * clears that window only: the other did not reset and keeps its reading until a newer report. On a tie the five-hour
 * window is cleared, and the weekly one, which lasts longer, keeps its reading. Exported with reportHolds (X-49).
 */
export function utilization(account: AccountView | null, holds: boolean): { fiveHour: number; weekly: number } {
  const fiveHour = account?.quota.windows.fiveHour ?? 0;
  const weekly = account?.quota.windows.weekly ?? 0;
  if (holds) return { fiveHour, weekly };
  return fiveHour >= weekly ? { fiveHour: 0, weekly } : { fiveHour, weekly: 0 };
}

function vendorRefusal(
  snapshot: PlacementSnapshot,
  slot: VendorSlot,
  account: AccountView | null,
): PlacementRefusal | null {
  if (!slot.ready || slot.notReadySince !== null) return 'not_ready';
  if (slot.degradedUntil !== null && snapshot.now < slot.degradedUntil) return 'degraded';
  // An exhaustion and paid usage in use lapse with their report.
  const quota = account !== null && reportHolds(snapshot, account) ? account.quota : null;
  if (quota?.state === 'exhausted') return 'exhausted';
  if (quota?.paidUsage === 'in_use' && !slot.allowPaidUsage) return 'paid_usage';
  if (account?.ownerAway) return 'owner_away';
  const { fiveHour, weekly } = utilization(account, quota !== null);
  if (fiveHour >= slot.ceilings.fiveHour || weekly >= slot.ceilings.weekly) return 'ceiling';
  return null;
}

/**
 * The vendors on a runner that may take an attempt (design 6.6, step 5, and 6.10): ready, without a not-ready mark or
 * a current degraded mark; on an account that is not exhausted, draws no paid usage unless the runner allows it and
 * whose owner is not away; and below the runner's ceilings, with unknown utilization counted as 0, so a ceiling of 0
 * keeps the vendor off; once a report no longer holds, only its limiting window counts as unknown. A vendor without an
 * account id, or on an account without a quota report, meets no account rule. Every other vendor comes with its first
 * refusal. The runner itself is candidateRunners' to judge.
 */
export function usableVendors(
  snapshot: PlacementSnapshot,
  runner: RunnerSlot,
): { usable: UsableVendor[]; refused: RefusedPlacement[] } {
  const usable: UsableVendor[] = [];
  const refused: RefusedPlacement[] = [];
  for (const slot of runner.vendors) {
    const account = accountOf(snapshot, runner, slot);
    const refusal = vendorRefusal(snapshot, slot, account);
    if (refusal === null) usable.push({ slot, account });
    else refused.push({ runnerId: runner.id, vendor: slot.vendor, refusal });
  }
  return { usable, refused };
}
