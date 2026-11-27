// Placement (design 6.6, steps 3 to 5): which runners may take an attempt, how many slots they have free, and which
// of their vendors are usable, with a named refusal for each one that is not; then which ready tasks qualify, in what
// order, and where each goes, and where a runner lead goes (6.11). This is the only copy of these rules (X-46): the
// hub builds the snapshot from its database, and the scheduler and rejectTask's ladder step 1 read it through these
// functions. Pure, with no zod at run time, so the web UI may import it too (X-48).
import type { VendorRequirement } from './ladder';
import { pathsOverlap } from './paths';
import { liveChatOnly, needsOpenProfile, openProfileReason } from './protected-paths';
import type { StartRefusal } from './runner-protocol';
import type {
  AccountQuota,
  AgentRole,
  FailureClass,
  ProfileSummary,
  Runner,
  RunnerState,
  Task,
  TaskTier,
  Vendor,
} from './types';

/**
 * Why placement passes over a runner, then over a vendor on it, in the order they are checked:
 * - offline: the runner's state is not online (offline, needs_login, incompatible, crash_loop or disk_low);
 * - draining: it takes no new work;
 * - git: it cannot fetch or push (git.ready is false);
 * - accepting: its last heartbeat asked for no new attempt before acceptingUntil (waking, low battery, low disk);
 * - refused_start: it refused a start since its last heartbeat (X-3);
 * - full: the workers that take a slot fill its capacity (a worker's placement only: a lead takes no slot);
 * - not_ready: the vendor is not ready there, by the runner's report or by a hub mark;
 * - degraded: continuous vendor errors marked the vendor degraded there;
 * - exhausted: the vendor's account has no quota left until its reset, or none for the model (limitedUntil);
 * - paid_usage: work would draw on paid usage, which the runner does not allow;
 * - owner_away: an approval of the runner's owner timed out (design 6.10);
 * - ceiling: the account's utilization reached the runner's ceiling for the vendor.
 */
export const PLACEMENT_REFUSALS = [
  'runner_constraint',
  'vendor_constraint',
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

/** Each refusal in a few words, for the board's wait reasons and the Load page. */
export const PLACEMENT_REFUSAL_WORDS: Readonly<Record<PlacementRefusal, string>> = {
  runner_constraint: 'outside the task runner allowlist',
  vendor_constraint: 'not the required vendor',
  offline: 'offline',
  draining: 'draining',
  git: 'git not ready',
  accepting: 'not taking work yet',
  refused_start: 'refused a start',
  full: 'full',
  not_ready: 'not ready',
  degraded: 'degraded',
  exhausted: 'quota used up',
  paid_usage: 'would use paid usage',
  owner_away: 'owner away',
  ceiling: 'at its quota ceiling',
};

/** A vendor on a runner, as placement sees it. */
export interface VendorSlot {
  vendor: Vendor;
  /** The runner's report: its binary is there, it is logged in and its preflight passed. */
  ready: boolean;
  /** The hub's not-ready mark (two failed starts, an expired login), which a later passing preflight clears. */
  notReadySince: number | null;
  /** The hub's degraded mark after continuous vendor errors: no placement before this time. */
  degradedUntil: number | null;
  /**
   * The hub's marks of limit hits that left the account usable (a limit of one model, or paid usage the runner
   * refuses), by the model that met them here (modelClass): no attempt on that model on the account before this time
   * (design 6.10).
   */
  limitedUntil: Partial<Record<AgentRole, number>>;
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
  /**
   * Its workers that take a slot: starting or running, or in quota_wait and asked to stop, whose slot is kept for its
   * successor. A lead, a holding attempt and a worker waiting for its quota take none; the runner's admission counts
   * no more.
   */
  openAttempts: number;
  /** Its power source, for the runner preference. */
  power: Runner['power'];
  /** The profile it reports: only an open one takes a task that owns greenfield files (needsOpenProfile). */
  profile: ProfileSummary['name'];
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

/** A vendor usable on a runner, with its account when the snapshot has it (the hub's has all that runners name). */
export interface UsableVendor {
  slot: VendorSlot;
  account: AccountView | null;
}

/** The slots a runner has left: its capacity less its open attempts, and never fewer than none. */
export function freeSlots(runner: Pick<RunnerSlot, 'capacity' | 'openAttempts'>): number {
  return Math.max(0, runner.capacity - runner.openAttempts);
}

function runnerRefusal(snapshot: PlacementSnapshot, runner: RunnerSlot, role: AgentRole): PlacementRefusal | null {
  if (runner.state !== 'online') return 'offline';
  if (runner.draining) return 'draining';
  if (!runner.gitReady) return 'git';
  if (runner.acceptingUntil !== null && snapshot.now < runner.acceptingUntil) return 'accepting';
  if (runner.startRefusal !== null) return 'refused_start';
  if (role === 'worker' && freeSlots(runner) < 1) return 'full';
  return null;
}

/**
 * The runners that may take an attempt of the role now (design 6.6, step 5): online, not draining, git ready, past
 * the acceptingUntil of their last heartbeat, without a refused start since that heartbeat, and, for a worker, with a
 * free slot. A lead takes no slot, so a runner runs its capacity of workers beside it. Every other runner comes with
 * its first refusal. Vendors are usableVendors' to judge.
 */
export function candidateRunners(
  snapshot: PlacementSnapshot,
  role: AgentRole = 'worker',
): {
  candidates: RunnerSlot[];
  refused: RefusedPlacement[];
} {
  const candidates: RunnerSlot[] = [];
  const refused: RefusedPlacement[] = [];
  for (const runner of snapshot.runners) {
    const refusal = runnerRefusal(snapshot, runner, role);
    if (refusal === null) candidates.push(runner);
    else refused.push({ runnerId: runner.id, vendor: null, refusal });
  }
  return { candidates, refused };
}

/** The owner's account a vendor on the runner draws on, when the runner names one and the snapshot has it. */
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

/**
 * Which of the runner's models an attempt runs on (runner.json's models[vendor]): the lead's for a lead and for a
 * strong task's worker, the worker's otherwise. A limit of one model is kept, and checked, under it (limitedUntil).
 */
export function modelClass(role: AgentRole, tier: TaskTier | undefined): AgentRole {
  return tier === 'strong' ? 'lead' : role;
}

/**
 * Until when a limit hit that left the account usable keeps the model (modelClass) off the vendor (design 6.10): the
 * latest mark of the model on this slot, or on the vendor of any runner of the owner logged in to the same account, as
 * an exhaustion of the account holds on all of them. 0 for none.
 */
function limitedUntil(snapshot: PlacementSnapshot, runner: RunnerSlot, slot: VendorSlot, model: AgentRole): number {
  const sameAccount = (other: RunnerSlot, each: VendorSlot): boolean =>
    slot.accountId !== null &&
    other.owner === runner.owner &&
    each.vendor === slot.vendor &&
    each.accountId === slot.accountId;
  const shared = snapshot.runners.flatMap((other) => other.vendors.filter((each) => sameAccount(other, each)));
  return Math.max(slot.limitedUntil[model] ?? 0, ...shared.map((each) => each.limitedUntil[model] ?? 0));
}

function vendorRefusal(
  snapshot: PlacementSnapshot,
  runner: RunnerSlot,
  slot: VendorSlot,
  account: AccountView | null,
  model: AgentRole,
): PlacementRefusal | null {
  if (!slot.ready || slot.notReadySince !== null) return 'not_ready';
  if (slot.degradedUntil !== null && snapshot.now < slot.degradedUntil) return 'degraded';
  // An exhaustion and paid usage in use lapse with their report.
  const quota = account !== null && reportHolds(snapshot, account) ? account.quota : null;
  if (quota?.state === 'exhausted' || snapshot.now < limitedUntil(snapshot, runner, slot, model)) return 'exhausted';
  if (quota?.paidUsage === 'in_use' && !slot.allowPaidUsage) return 'paid_usage';
  if (account?.ownerAway) return 'owner_away';
  const { fiveHour, weekly } = utilization(account, quota !== null);
  if (fiveHour >= slot.ceilings.fiveHour || weekly >= slot.ceilings.weekly) return 'ceiling';
  return null;
}

/**
 * The vendors on a runner that may take an attempt on the model (modelClass; a standard worker's by default; design
 * 6.6, step 5, and 6.10): ready, without a not-ready mark or a current degraded mark; on an account that is not
 * exhausted, nor limited for the model (limitedUntil), draws no paid usage unless the runner allows it and whose owner
 * is not away; and below the runner's ceilings, with unknown utilization counted as 0, so a ceiling of 0 keeps the
 * vendor off; once a report no longer holds, only its limiting window counts as unknown. A vendor without an account
 * id, or on an account without a quota report, meets no rule of a report. Every other vendor comes with its first
 * refusal. The runner itself is candidateRunners' to judge.
 */
export function usableVendors(
  snapshot: PlacementSnapshot,
  runner: RunnerSlot,
  model: AgentRole = 'worker',
): { usable: UsableVendor[]; refused: RefusedPlacement[] } {
  const usable: UsableVendor[] = [];
  const refused: RefusedPlacement[] = [];
  for (const slot of runner.vendors) {
    const account = accountOf(snapshot, runner, slot);
    const refusal = vendorRefusal(snapshot, runner, slot, account, model);
    if (refusal === null) usable.push({ slot, account });
    else refused.push({ runnerId: runner.id, vendor: slot.vendor, refusal });
  }
  return { usable, refused };
}

// ---------------------------------------------------------------------------
// The ready set (design 6.6, step 3)
// ---------------------------------------------------------------------------

/** The task's own fields the ready set, its order and its placement read. */
type CandidateFields = 'id' | 'status' | 'priority' | 'createdAt' | 'ownedPaths' | 'kind' | 'createdBy' | 'tier' | 'placement';

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
  /**
   * When it became ready: its last change (Task.updatedAt), which for a ready task is its move to ready; 0 after a
   * quota replacement, whose wait for the vendor counts, so its vendorHint holds it back no longer.
   */
  readySince: number;
}

export interface DispatchContext {
  now: number;
  /** HubConfig.maxAttempts: the ladder's limit of counted attempts. */
  maxAttempts: number;
  /** The tasks that hold their paths (task-store's isPathHolder); the candidate itself may be among them. */
  pathHolders: readonly Pick<Task, 'id' | 'ownedPaths'>[];
}

/** Whole minutes from now until a time, at least 1, for a reason people read. */
export const minutesUntil = (at: number, now: number): number => Math.max(1, Math.ceil((at - now) / 60_000));

/**
 * Why a task is not in the ready set (design 6.6, step 3), in one line for the board; null when it is. The ready set
 * holds a task that is ready with its dependencies done; with no open attempt; with no path that no runner agent may
 * change (such a task stays ready for live chats); with no overlap with a path holder; whose next_dispatch_at and
 * dispatch_hold_until have come; and with counted attempts below the ladder's limit. The first rule it fails is why.
 */
export function whyNotDispatchable(task: TaskCandidate, context: DispatchContext): string | null {
  const { now } = context;
  if (task.status !== 'ready') return `it is ${task.status}`;
  if (!task.dependenciesDone) return 'it waits for its dependencies';
  if (task.openAttempt) return 'its last attempt is still stopping';
  if (liveChatOnly(task)) return 'it owns paths runner agents may not change, so it waits for a live chat';
  const holder = context.pathHolders.find(
    (other) => other.id !== task.id && pathsOverlap(task.ownedPaths, other.ownedPaths),
  );
  if (holder) return `its owned paths overlap those of ${holder.id}`;
  if (task.nextDispatchAt !== null && task.nextDispatchAt > now) {
    return `it waits ${minutesUntil(task.nextDispatchAt, now)} min after an infrastructure failure`;
  }
  if (task.dispatchHoldUntil !== null && task.dispatchHoldUntil > now) {
    return `it waits up to ${minutesUntil(task.dispatchHoldUntil, now)} min for a runner's late work`;
  }
  if (task.counted >= context.maxAttempts) return `it used all ${context.maxAttempts} of its attempts`;
  return null;
}

/** Whether a task is in the ready set (design 6.6, step 3): whyNotDispatchable has nothing against it. */
export function isDispatchable(task: TaskCandidate, context: DispatchContext): boolean {
  return whyNotDispatchable(task, context) === null;
}

/** The ready set in dispatch order: by priority (0 the most urgent), then age, oldest first. A new array. */
export function orderReady<T extends Pick<TaskCandidate, 'priority' | 'createdAt'>>(tasks: readonly T[]): T[] {
  return [...tasks].sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);
}

// ---------------------------------------------------------------------------
// Slots and preferences (design 6.6, steps 4 and 5)
// ---------------------------------------------------------------------------

/**
 * How many more workers may start (design 6.6, step 4): running workers (the ones that take a slot, as
 * RunnerSlot.openAttempts counts them) stay below project.worker_target, or maxWorkers without one. Leads, live chats
 * and workers waiting for their quota do not count.
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

/** How long a task's vendorHint holds it when no runner can take the hinted vendor: then the other vendor may. */
export const HINT_WAIT_MS = 60_000;

export interface VendorPreferenceInput {
  requirement: VendorRequirement | null;
  vendorHint: Vendor | null;
  /** project.vendor_pref, which counts until vendor_pref_until. */
  projectPref: { vendor: Vendor; until: number } | null;
  now: number;
  /** The vendors some online runner offers: ready, with no not-ready mark. A step-3 requirement binds only to these. */
  offered: readonly Vendor[];
  /** When the task became ready (TaskCandidate.readySince). */
  readySince: number;
}

/** The ladder's requirement while it binds: step 2's always, step 3's while a runner offers its vendor; else null. */
function bindingRequirement(
  requirement: VendorRequirement | null,
  offered: readonly Vendor[],
): VendorRequirement | null {
  return requirement !== null && (requirement.step === 2 || offered.includes(requirement.vendor)) ? requirement : null;
}

/**
 * The vendors a task may use now, in tiers tried in order (design 6.6, step 5): placement takes the best account of
 * the first tier that has a usable one. The ladder's requirement binds first (bindingRequirement): step 2 to the same
 * vendor, step 3 to the other while a runner offers it. Otherwise vendorHint comes first, and the other vendor only
 * once the task has been ready for HINT_WAIT_MS; then the project's preference until it expires, with the other vendor
 * after it. With no preference both vendors make one tier, so the accounts decide.
 */
export function preferredVendors(input: VendorPreferenceInput): Vendor[][] {
  const { vendorHint } = input;
  const requirement = bindingRequirement(input.requirement, input.offered);
  if (requirement !== null) return [[requirement.vendor]];
  const others = (vendor: Vendor): Vendor[] => VENDORS.filter((other) => other !== vendor);
  if (vendorHint !== null) {
    return input.now - input.readySince >= HINT_WAIT_MS ? [[vendorHint], others(vendorHint)] : [[vendorHint]];
  }
  const pref = input.projectPref !== null && input.now < input.projectPref.until ? input.projectPref.vendor : null;
  return pref === null ? [[...VENDORS]] : [[pref], others(pref)];
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

/**
 * Every usable vendor on every candidate runner for the role, and every refusal met on the way, among the given runners
 * (all of the snapshot's by default). The role decides whether a slot is needed; the model (modelClass, the role's own
 * by default) which limits hold. Vendors are judged against the whole snapshot: a limit of the model holds on every
 * runner of the owner logged in to the account (limitedUntil), the runners left out included.
 */
function options(
  snapshot: PlacementSnapshot,
  role: AgentRole,
  runners: RunnerSlot[] = snapshot.runners,
  model: AgentRole = role,
): { options: Option[]; refused: RefusedPlacement[] } {
  const { candidates, refused } = candidateRunners({ ...snapshot, runners }, role);
  const found: Option[] = [];
  for (const runner of candidates) {
    const vendors = usableVendors(snapshot, runner, model);
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

/**
 * How used an account is, for the account preference: the larger of its two windows, read as the ceilings read them
 * (utilization), so a window whose report has lapsed counts as 0. An option with no account report has no use.
 */
function accountUse(snapshot: PlacementSnapshot, account: AccountView | null): number {
  if (account === null) return 0;
  const { fiveHour, weekly } = utilization(account, reportHolds(snapshot, account));
  return Math.max(fiveHour, weekly);
}

/**
 * Options in placement order (design 6.6, step 5): not on the runner to avoid; then on the account (owner and vendor)
 * with the fewest open attempts, then on the least used one (accountUse); then in runner order (orderRunners), and
 * Claude before Codex on one runner. An option without an account in the snapshot has no open attempts. A new array.
 */
function orderOptions(snapshot: PlacementSnapshot, found: readonly Option[], avoid: string | null): Option[] {
  const runners = orderRunners([...new Set(found.map((option) => option.runner))], avoid);
  const avoided = (option: Option): number => (option.runner.id === avoid ? 1 : 0);
  const open = (option: Option): number => option.usable.account?.openAttempts ?? 0;
  const use = (option: Option): number => accountUse(snapshot, option.usable.account);
  const runner = (option: Option): number => runners.indexOf(option.runner);
  const vendor = (option: Option): number => VENDORS.indexOf(option.usable.slot.vendor);
  return [...found].sort(
    (a, b) =>
      avoided(a) - avoided(b) ||
      open(a) - open(b) ||
      use(a) - use(b) ||
      runner(a) - runner(b) ||
      vendor(a) - vendor(b),
  );
}

/** The vendors an online runner among these offers: ready, with no not-ready mark, whether or not it has room now. */
function offeredVendors(runners: readonly RunnerSlot[]): Vendor[] {
  const offered = runners.flatMap((runner) =>
    runner.state === 'online'
      ? runner.vendors.filter((slot) => slot.ready && slot.notReadySince === null).map((slot) => slot.vendor)
      : [],
  );
  return [...new Set(offered)];
}

/**
 * The runners a task may go to: a task that owns greenfield files (needsOpenProfile) only to one that reports the open
 * profile. They are the snapshot's own, so a placement recorded on them counts.
 */
function runnersFor(
  snapshot: PlacementSnapshot,
  task: Pick<TaskCandidate, 'ownedPaths' | 'kind' | 'createdBy'>,
): RunnerSlot[] {
  if (!needsOpenProfile(task)) return snapshot.runners;
  return snapshot.runners.filter((runner) => runner.profile === 'open');
}

/** Hard constraints also checked by the transactional start/resume entry points. */
export function taskPlacementRefusal(
  task: Pick<Task, 'placement'>,
  runner: RunnerSlot,
  vendor: Vendor,
): PlacementRefusal | null {
  const constraints = task.placement;
  if (constraints?.runnerIds && !constraints.runnerIds.includes(runner.id)) return 'runner_constraint';
  if (constraints?.vendor && constraints.vendor !== vendor) return 'vendor_constraint';
  return null;
}

/**
 * Places a ready task (design 6.6, step 5): the first tier of vendors (preferredVendors) usable on some candidate
 * runner, on its best option (orderOptions, avoiding task.avoidRunner); a task that owns greenfield files only on a
 * runner with the open profile (runnersFor); a strong task only where the lead's model is not limited (modelClass).
 * Without a preference that is the account with the fewest open attempts, so a tick's placements spread over every
 * account at once. With no placement, refused names every runner and vendor passed over among those the task may go
 * to, owner_away included, which the scheduler tells the lead about.
 */
export function place(
  snapshot: PlacementSnapshot,
  task: Pick<
    TaskCandidate,
    'vendorHint' | 'requirement' | 'avoidRunner' | 'readySince' | 'ownedPaths' | 'kind' | 'createdBy' | 'tier' | 'placement'
  >,
  project: { projectPref: VendorPreferenceInput['projectPref'] },
): PlaceResult {
  const runners = runnersFor(snapshot, task);
  const found = options(snapshot, 'worker', runners, modelClass('worker', task.tier));
  found.options = found.options.filter((option) => {
    const refusal = taskPlacementRefusal(task, option.runner, option.usable.slot.vendor);
    if (refusal === null) return true;
    found.refused.push({ runnerId: option.runner.id, vendor: option.usable.slot.vendor, refusal });
    return false;
  });
  // Explicit contract requirements override soft hints and automatic vendor rotation.
  const tiers = task.placement?.vendor
    ? [[task.placement.vendor]]
    : preferredVendors({
        requirement: task.requirement,
        vendorHint: task.vendorHint,
        projectPref: project.projectPref,
        now: snapshot.now,
        offered: offeredVendors(runners),
        readySince: task.readySince,
      });
  for (const vendors of tiers) {
    const onTier = found.options.filter((option) => vendors.includes(option.usable.slot.vendor));
    const [best] = orderOptions(snapshot, onTier, task.avoidRunner);
    if (best) return { placement: toPlacement(best), refused: found.refused };
  }
  return { placement: null, refused: found.refused };
}

/**
 * Why place found no runner for a task, in one line for the board: each runner passed over, with its own refusal or
 * its vendors'. A usable vendor has no refusal, so when the retry ladder's requirement binds, as place binds it
 * (bindingRequirement), the line names its vendor. A task that owns greenfield files looks only at runners with the
 * open profile (runnersFor), and says so; with none in the snapshot, it names the files that need one. A task its
 * vendorHint still holds (preferredVendors) says how long it waits for that vendor, and names only that vendor's
 * refusals.
 */
export function placementWords(
  snapshot: PlacementSnapshot,
  task: Pick<TaskCandidate, 'requirement' | 'ownedPaths' | 'kind' | 'createdBy' | 'vendorHint' | 'readySince' | 'placement'>,
  refused: readonly RefusedPlacement[],
): string {
  const constraints = task.placement;
  if (constraints?.runnerIds && !snapshot.runners.some((runner) => constraints.runnerIds!.includes(runner.id))) {
    return `it waits for required runner(s): ${constraints.runnerIds.join(', ')}`;
  }
  if (constraints?.vendor) {
    return `it requires ${constraints.vendor}: ${refusalWords(refused) || 'no eligible runner offers it'}`;
  }
  const open = openProfileReason(task);
  const candidates = runnersFor(snapshot, task);
  if (open !== null && candidates.length === 0) return `it ${open}, and no runner has that profile`;
  const needed = bindingRequirement(task.requirement, offeredVendors(candidates))?.vendor ?? null;
  const hint = needed === null ? task.vendorHint : null;
  const hintLeft = hint === null ? 0 : HINT_WAIT_MS - (snapshot.now - task.readySince);
  const runners = open === null ? 'no runner' : 'no runner with the open profile';
  const ladder = needed === null ? '' : ` (the retry ladder asks for ${needed})`;
  const head =
    hintLeft > 0
      ? `it waits up to ${Math.ceil(hintLeft / 1000)} s for its preferred vendor ${hint}`
      : `${runners} can take it${ladder}`;
  const shown = hintLeft > 0 ? refused.filter((one) => one.vendor === null || one.vendor === hint) : refused;
  const words = refusalWords(shown);
  if (words === '') return hintLeft > 0 ? head : `${head}: none offers ${needed ?? 'a vendor'}`;
  return `${head}: ${words}`;
}

/**
 * Each runner passed over, with its own refusal or its vendors', in PLACEMENT_REFUSAL_WORDS: "R-1 offline; R-2 claude
 * quota used up, codex not ready". Empty for none.
 */
export function refusalWords(refused: readonly RefusedPlacement[]): string {
  const byRunner = new Map<string, string[]>();
  for (const one of refused) {
    const words = PLACEMENT_REFUSAL_WORDS[one.refusal];
    const said = byRunner.get(one.runnerId) ?? [];
    byRunner.set(one.runnerId, [...said, one.vendor === null ? words : `${one.vendor} ${words}`]);
  }
  return [...byRunner].map(([runnerId, words]) => `${runnerId} ${words.join(', ')}`).join('; ');
}

/**
 * Places a runner lead (design 6.11): Claude before Codex, then, when rotating, the runner the lead ran on, then
 * runners on AC power, the most free slots and the lowest id. A lead takes no slot, so a full runner may take it.
 */
export function placeLead(snapshot: PlacementSnapshot, rotation: { rotatingFrom: string | null }): PlaceResult {
  const found = options(snapshot, 'lead');
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
