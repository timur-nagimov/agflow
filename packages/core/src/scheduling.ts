// Placement (design 6.6, steps 3 to 5): which runners may take an attempt, how many slots they have free, and which
// of their vendors are usable, with a named refusal for each one that is not; then which ready tasks qualify, in what
// order, and where each goes, and where a runner lead goes (6.11). This is the only copy of these rules (X-46): the
// hub builds the snapshot from its database, and the scheduler and rejectTask's ladder step 1 read it through these
// functions. Pure, with no zod at run time, so the web UI may import it too (X-48).
import type { VendorRequirement } from './ladder';
import { pathsOverlap } from './paths';
import { liveChatOnly } from './protected-paths';
import type { StartRefusal } from './runner-protocol';
import type { AccountQuota, FailureClass, Runner, RunnerState, Task, Vendor } from './types';

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

// ---------------------------------------------------------------------------
// The ready set (design 6.6, step 3)
// ---------------------------------------------------------------------------

/** The task's own fields the ready set and its order read. */
type CandidateFields = 'id' | 'status' | 'priority' | 'createdAt' | 'ownedPaths' | 'kind' | 'createdBy';

/** A ready task as the scheduler reads it: its own fields and what the hub knows about its attempts. */
export interface TaskCandidate extends Pick<Task, CandidateFields | 'nextDispatchAt'> {
  vendorHint: Vendor | null;
  /** Every task it depends on is done. */
  dependenciesDone: boolean;
  /** The attempt tasks.current_attempt names has not ended. */
  openAttempt: boolean;
  /** tasks.dispatch_hold_until: dispatch waits for a runner's late work until then (design 6.4, 6.8). */
  dispatchHoldUntil: number | null;
  /** Its counted attempts since the last re-plan (countedAttempts). */
  counted: number;
  /** The ladder's vendor requirement (vendorRequirement), which lapses vendorRequirementMs after the last ending. */
  requirement: VendorRequirement | null;
  /** The runner its next attempt should not use (runnerToAvoid). */
  avoidRunner: string | null;
}

export interface DispatchContext {
  now: number;
  /** HubConfig.maxAttempts: the ladder's limit of counted attempts. */
  maxAttempts: number;
  /** The tasks that hold their paths (task-store's isPathHolder); the candidate itself may be among them. */
  pathHolders: readonly Pick<Task, 'id' | 'ownedPaths'>[];
}

/**
 * Whether a task is in the ready set (design 6.6, step 3): ready with its dependencies done; no open attempt; no path
 * a runner agent may not change (such a task stays ready for live chats); no overlap with a path holder;
 * next_dispatch_at and dispatch_hold_until come; and counted attempts below the ladder's limit.
 */
export function isDispatchable(task: TaskCandidate, context: DispatchContext): boolean {
  const { now } = context;
  return (
    task.status === 'ready' &&
    task.dependenciesDone &&
    !task.openAttempt &&
    !liveChatOnly(task) &&
    !context.pathHolders.some((holder) => holder.id !== task.id && pathsOverlap(task.ownedPaths, holder.ownedPaths)) &&
    (task.nextDispatchAt === null || task.nextDispatchAt <= now) &&
    (task.dispatchHoldUntil === null || task.dispatchHoldUntil <= now) &&
    task.counted < context.maxAttempts
  );
}

/** The ready set in dispatch order: by priority (0 the most urgent), then age, oldest first. A new array. */
export function orderReady<T extends Pick<TaskCandidate, 'priority' | 'createdAt'>>(tasks: readonly T[]): T[] {
  return [...tasks].sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);
}

// ---------------------------------------------------------------------------
// Slots and preferences (design 6.6, steps 4 and 5)
// ---------------------------------------------------------------------------

/**
 * How many more workers may start (design 6.6, step 4): running workers (starting, running and quota_wait) stay below
 * project.worker_target, or maxWorkers without one. Leads and live chats do not count.
 */
export function workerSlotsFree(input: {
  workerTarget: number | null;
  maxWorkers: number;
  runningWorkers: number;
}): number {
  return Math.max(0, (input.workerTarget ?? input.maxWorkers) - input.runningWorkers);
}

/** Both vendors, in the order that settles a tie. */
const VENDORS: readonly Vendor[] = ['claude', 'codex'];

export interface VendorPreferenceInput {
  requirement: VendorRequirement | null;
  vendorHint: Vendor | null;
  /** project.vendor_pref, which counts until vendor_pref_until. */
  projectPref: { vendor: Vendor; until: number } | null;
  now: number;
  /** The vendors some online runner offers: ready, with no not-ready mark. A step-3 requirement binds only to these. */
  offered: readonly Vendor[];
  /** The lowest account utilization of each vendor usable now, 0..1; a vendor usable nowhere has none. */
  utilization: Partial<Record<Vendor, number>>;
}

/**
 * The vendors a task may use, most preferred first (design 6.6, step 5). The ladder's requirement binds first: step 2
 * to the same vendor, step 3 to the other while a runner offers it. Otherwise vendorHint, then the project's
 * preference until it expires, then the lower account utilization; a vendor usable nowhere now comes last.
 */
export function preferredVendors(input: VendorPreferenceInput): Vendor[] {
  const { requirement } = input;
  if (requirement !== null && (requirement.step === 2 || input.offered.includes(requirement.vendor))) {
    return [requirement.vendor];
  }
  const level = (vendor: Vendor) => input.utilization[vendor] ?? Number.POSITIVE_INFINITY;
  const byUtilization = [...VENDORS].sort((a, b) => level(a) - level(b));
  const pref = input.projectPref !== null && input.now < input.projectPref.until ? input.projectPref.vendor : null;
  const first = [input.vendorHint, pref].filter((vendor): vendor is Vendor => vendor !== null);
  return [...new Set([...first, ...byUtilization])];
}

/** An ended attempt of the task, as the runner preference reads it. */
export interface EndedAttemptView {
  number: number;
  runnerId: string | null;
  failureClass: FailureClass | null;
  /** Its final push failed, so its harvested head is only in that runner's vault (design 6.8, Replacement step 4). */
  finalPushFailed: boolean;
}

/** The classes whose ending sends the next attempt elsewhere. */
const AVOIDING_CLASSES: readonly FailureClass[] = ['agent', 'review', 'infra'];

/**
 * The runner a task's next attempt should not use (design 6.6, step 5, runner preference 1): that of its last attempt
 * that ended with class agent, review or infra, unless that attempt's final push failed, when the runner holds the
 * work. Null for none, or for a live chat's attempt.
 */
export function runnerToAvoid(attempts: readonly EndedAttemptView[]): string | null {
  const last = [...attempts]
    .sort((a, b) => b.number - a.number)
    .find((attempt) => attempt.failureClass !== null && AVOIDING_CLASSES.includes(attempt.failureClass));
  if (last === undefined || last.finalPushFailed) return null;
  return last.runnerId;
}

const onAc = (runner: RunnerSlot): number => (runner.power?.source === 'ac' ? 0 : 1);

/** Runner ids by their number, so R-2 comes before R-10. */
const byId = (a: RunnerSlot, b: RunnerSlot): number => a.id.localeCompare(b.id, 'en', { numeric: true });

/**
 * Runners in preference order (design 6.6, step 5): not the runner to avoid, then on AC power, then the most free
 * slots, then the lowest id. A new array.
 */
export function orderRunners(runners: readonly RunnerSlot[], avoid: string | null): RunnerSlot[] {
  const avoided = (runner: RunnerSlot): number => (runner.id === avoid ? 1 : 0);
  return [...runners].sort(
    (a, b) => avoided(a) - avoided(b) || onAc(a) - onAc(b) || freeSlots(b) - freeSlots(a) || byId(a, b),
  );
}

// ---------------------------------------------------------------------------
// Placement (design 6.6, step 5; 6.11)
// ---------------------------------------------------------------------------

/** Where an attempt goes: a runner, the vendor on it, and the account it draws on when the hub knows it. */
export interface Placement {
  runnerId: string;
  vendor: Vendor;
  account: AccountView | null;
}

export interface PlaceResult {
  /** Null when no runner can take it now. */
  placement: Placement | null;
  /** Every runner passed over, and every vendor on a candidate runner, with its first refusal. */
  refused: RefusedPlacement[];
}

/** A usable vendor on a candidate runner. */
interface Option {
  runner: RunnerSlot;
  usable: UsableVendor;
}

/** Every usable vendor on every candidate runner, and every refusal met on the way. */
function options(snapshot: PlacementSnapshot): { options: Option[]; refused: RefusedPlacement[] } {
  const { candidates, refused } = candidateRunners(snapshot);
  const found: Option[] = [];
  for (const runner of candidates) {
    const vendors = usableVendors(snapshot, runner);
    refused.push(...vendors.refused);
    for (const usable of vendors.usable) found.push({ runner, usable });
  }
  return { options: found, refused };
}

const toPlacement = (option: Option): Placement => ({
  runnerId: option.runner.id,
  vendor: option.usable.slot.vendor,
  account: option.usable.account,
});

/** An account's utilization for the vendor preference: its more used window, 0 when unknown. */
const accountLevel = (account: AccountView | null): number =>
  Math.max(account?.quota.windows.fiveHour ?? 0, account?.quota.windows.weekly ?? 0);

/** The vendors an online runner offers: ready, with no not-ready mark, whether or not it has room now. */
function offeredVendors(snapshot: PlacementSnapshot): Vendor[] {
  const offered = snapshot.runners.flatMap((runner) =>
    runner.state === 'online'
      ? runner.vendors.filter((slot) => slot.ready && slot.notReadySince === null).map((slot) => slot.vendor)
      : [],
  );
  return [...new Set(offered)];
}

/**
 * Places a ready task (design 6.6, step 5): the most preferred vendor (preferredVendors) usable on some candidate
 * runner, on the best of those runners (orderRunners, avoiding task.avoidRunner). With no placement, refused names
 * every runner and vendor passed over, owner_away included, which the scheduler tells the lead about.
 */
export function place(
  snapshot: PlacementSnapshot,
  task: Pick<TaskCandidate, 'vendorHint' | 'requirement' | 'avoidRunner'>,
  project: { projectPref: VendorPreferenceInput['projectPref'] },
): PlaceResult {
  const found = options(snapshot);
  const utilization: Partial<Record<Vendor, number>> = {};
  for (const { usable } of found.options) {
    const { vendor } = usable.slot;
    utilization[vendor] = Math.min(utilization[vendor] ?? Number.POSITIVE_INFINITY, accountLevel(usable.account));
  }
  const vendors = preferredVendors({
    requirement: task.requirement,
    vendorHint: task.vendorHint,
    projectPref: project.projectPref,
    now: snapshot.now,
    offered: offeredVendors(snapshot),
    utilization,
  });
  for (const vendor of vendors) {
    const onVendor = found.options.filter((option) => option.usable.slot.vendor === vendor);
    const [best] = orderRunners(onVendor.map((option) => option.runner), task.avoidRunner);
    const chosen = onVendor.find((option) => option.runner === best);
    if (chosen) return { placement: toPlacement(chosen), refused: found.refused };
  }
  return { placement: null, refused: found.refused };
}

/**
 * Places a runner lead (design 6.11): Claude before Codex, then, when rotating, the runner the lead ran on, then
 * runners on AC power, the most free slots and the lowest id.
 */
export function placeLead(snapshot: PlacementSnapshot, rotation: { rotatingFrom: string | null }): PlaceResult {
  const found = options(snapshot);
  const same = (option: Option): number => (option.runner.id === rotation.rotatingFrom ? 0 : 1);
  const claude = (option: Option): number => (option.usable.slot.vendor === 'claude' ? 0 : 1);
  const [best] = [...found.options].sort(
    (a, b) =>
      claude(a) - claude(b) ||
      same(a) - same(b) ||
      onAc(a.runner) - onAc(b.runner) ||
      freeSlots(b.runner) - freeSlots(a.runner) ||
      byId(a.runner, b.runner),
  );
  return { placement: best ? toPlacement(best) : null, refused: found.refused };
}
