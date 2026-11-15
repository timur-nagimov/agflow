// The scheduler (design 6.6). Each tick first checks the clock (step 0: downtime opens a recovery window, in which
// the tick does nothing more), then reconciles (step 1: leases, approvals, stalls, stop and submission
// timeouts, holding leads, the Codex reset probe, quota_wait replacements, the lead review, the idle nudge and
// rotation), fills an empty lead seat (step 2, lead.ts), then reads the database into core's terms and leaves the
// rules to core's scheduling.ts (X-46): which ready tasks qualify and in what order, how many workers may start, and
// where each one goes. Every claim and start is its own transaction, so one that fails rolls back only itself,
// and the tick's placement snapshot is updated after each start, so a runner's slots and an account's probing start
// are not handed out twice. Retention and remote-ref cleanup are not the tick's: they run on a daily timer (X-39).
import {
  type AccountQuota,
  type AgentRole,
  type Attempt,
  type EndedAttemptView,
  type Message,
  type Placement,
  type PlacementSnapshot,
  type RefusedPlacement,
  type Task,
  type TaskCandidate,
  type TaskStatus,
  type Vendor,
  candidateRunners,
  countedAttempts,
  freeSlots,
  minutesUntil,
  orderReady,
  pathsOverlap,
  place,
  placeLead,
  placementWords,
  reportHolds,
  runnerToAvoid,
  usableVendors,
  utilization,
  whyNotDispatchable,
  workerSlotsFree,
} from '@agflow/core';
import { expireApprovals } from './approvals';
import { listAttempts, unpushedHead } from './attempt-store';
import { expireRunnerLeases, expireStops, ladderRequirement, requestStop, startRunnerAttempt } from './attempts';
import { type HubContext, tx } from './context';
import { reachDeadline } from './deadline';
import { ensureDemoCheck } from './demo-check';
import { currentGoalVersion } from './goal';
import { churnPaused, getHubState, inRecovery, leadSeat } from './hub-state';
import { checkHoldingLeads, ensureLead, periodicLeadReview, rotateLeadIfDue } from './lead';
import { parkedLine, parkedTasks, queueMainCheck, retryFixTask } from './main-check';
import { failedMerges, queueMerges } from './merges';
import { insertMessage } from './messages';
import { placementSnapshot } from './placement';
import { getProject, getStaffing, setVendorPreference, setWorkerTarget } from './project';
import { listAccounts, markOwnerAwayTold, probeUnknownResets } from './quota';
import { type ClockCheck, checkClock } from './recovery';
import { expireReviews, tasksUnderReview } from './review';
import { TAKES_SLOT_SQL } from './runners';
import { expireSubmissions } from './submissions';
import { type StallDecisions, judgeStalls } from './supervisor';
import { expireHandbacks } from './takeover';
import { getTask, isPathHolder, listTasks, unmetDependencies } from './task-store';
import { sweepLeases } from './tasks';

/**
 * Runner workers that take one of the project's worker slots (design 6.6, step 4), as they take one of their runner's
 * (TAKES_SLOT_SQL): starting or running, or in quota_wait and asked to stop. Leads, live chats and workers waiting for
 * their quota do not count.
 */
export function runningWorkers(ctx: HubContext): number {
  return (
    ctx.db
      .query(`SELECT COUNT(*) AS n FROM attempts WHERE runner_id IS NOT NULL AND ${TAKES_SLOT_SQL}`)
      .get() as { n: number }
  ).n;
}

/** What the tasks table keeps for dispatch beyond the Task: the late-work hold and the ladder's floor. */
function dispatchColumns(ctx: HubContext): Map<string, { holdUntil: number | null; floor: number }> {
  const rows = ctx.db
    .query("SELECT id, dispatch_hold_until, ladder_floor FROM tasks WHERE status = 'ready'")
    .all() as { id: string; dispatch_hold_until: number | null; ladder_floor: number }[];
  return new Map(rows.map((row) => [row.id, { holdUntil: row.dispatch_hold_until, floor: row.ladder_floor }]));
}

/** An ended attempt as the runner preference reads it; its final push failed while its runner alone has the work. */
function endedView(ctx: HubContext, task: Task, attempt: Attempt): EndedAttemptView {
  return {
    number: attempt.number,
    runnerId: attempt.runnerId,
    failureClass: attempt.failureClass,
    finalPushFailed: unpushedHead(ctx, task, attempt) !== null,
  };
}

/**
 * What steers where a task's next attempt goes: the ladder's vendor, the task's hint, the runner to avoid, the paths it
 * owns, since greenfield files need a runner with the open profile, and its tier, since a strong task runs on the
 * lead's model, whose limits then hold.
 */
type PlacementPrefs = Pick<
  TaskCandidate,
  'vendorHint' | 'requirement' | 'avoidRunner' | 'ownedPaths' | 'kind' | 'createdBy' | 'tier'
>;

function placementPrefs(ctx: HubContext, task: Task, attempts: readonly Attempt[]): PlacementPrefs {
  const ended = attempts.filter((attempt) => attempt.status === 'ended');
  return {
    vendorHint: task.vendorHint ?? null,
    requirement: ladderRequirement(ctx, task.id),
    avoidRunner: runnerToAvoid(ended.map((attempt) => endedView(ctx, task, attempt))),
    ownedPaths: task.ownedPaths,
    kind: task.kind,
    createdBy: task.createdBy,
    tier: task.tier,
  };
}

/** A ready task in core's terms (design 6.6, step 3). */
function candidateOf(ctx: HubContext, task: Task, columns: { holdUntil: number | null; floor: number }): TaskCandidate {
  const attempts = listAttempts(ctx, { task: task.id });
  const current = task.currentAttempt === null ? undefined : attempts.find((one) => one.id === task.currentAttempt);
  return {
    ...placementPrefs(ctx, task, attempts),
    id: task.id,
    status: task.status,
    priority: task.priority,
    createdAt: task.createdAt,
    ownedPaths: task.ownedPaths,
    kind: task.kind,
    createdBy: task.createdBy,
    nextDispatchAt: task.nextDispatchAt,
    dependenciesDone: unmetDependencies(ctx, task.dependsOn).length === 0,
    openAttempt: current !== undefined && current.status !== 'ended',
    dispatchHoldUntil: columns.holdUntil,
    counted: countedAttempts(attempts, columns.floor),
    // listAttempts answers newest first. A quota replacement's wait was for the vendor already.
    readySince: attempts[0]?.stopRequested?.cause === 'quota' ? 0 : task.updatedAt,
  };
}

/**
 * The ready set in dispatch order (design 6.6, step 3): by priority, then age. A task parked while main's check fails
 * waits too (parkedTasks). Each ready task left out goes into waiting, when given, with why.
 */
export function readySet(ctx: HubContext, waiting?: Map<string, string>): TaskCandidate[] {
  const tasks = listTasks(ctx);
  const columns = dispatchColumns(ctx);
  const pathHolders = tasks.filter((task) => isPathHolder(task, ctx.config.autoMerge === true));
  const context = { now: ctx.now(), maxAttempts: ctx.config.maxAttempts, pathHolders };
  const parked = parkedTasks(ctx);
  const ready = tasks.flatMap((task) => {
    const stored = columns.get(task.id);
    return task.status === 'ready' && stored ? [candidateOf(ctx, task, stored)] : [];
  });
  return orderReady(
    ready.filter((candidate) => {
      const why = whyNotDispatchable(candidate, context) ?? parked.get(candidate.id) ?? null;
      if (why !== null) waiting?.set(candidate.id, why);
      return why === null;
    }),
  );
}

/** Counts a placement in the snapshot: an open attempt more on its account, and a worker's slot less on its runner. */
function recordPlacement(snapshot: PlacementSnapshot, placement: Placement, role: AgentRole): void {
  const runner = snapshot.runners.find((slot) => slot.id === placement.runnerId);
  if (runner && role === 'worker') runner.openAttempts += 1;
  if (placement.account) placement.account.openAttempts += 1;
}

/** A ready task that found no placement because its owner's account was marked away. */
interface AwayRefusal {
  taskId: string;
  owner: string;
  vendor: Vendor;
  accountId: string;
}

/** The away accounts among a task's refusals: the runner's owner and the account the vendor is logged in to there. */
function awayRefusals(
  snapshot: PlacementSnapshot,
  taskId: string,
  refused: readonly RefusedPlacement[],
): AwayRefusal[] {
  return refused.flatMap((refusal) => {
    if (refusal.refusal !== 'owner_away' || refusal.vendor === null) return [];
    const runner = snapshot.runners.find((slot) => slot.id === refusal.runnerId);
    const accountId = runner?.vendors.find((slot) => slot.vendor === refusal.vendor)?.accountId ?? null;
    if (!runner || accountId === null) return [];
    return [{ taskId, owner: runner.owner, vendor: refusal.vendor, accountId }];
  });
}

/**
 * Tells the lead, once per away period of each account, that ready work waits because its owner let an approval
 * expire (design 6.10, Owner away): one notice, not one per request or per tick.
 */
function tellLeadOwnerAway(ctx: HubContext, refusals: readonly AwayRefusal[]): void {
  const accounts = new Map<string, AwayRefusal[]>();
  for (const refusal of refusals) {
    const key = JSON.stringify([refusal.owner, refusal.vendor, refusal.accountId]);
    accounts.set(key, [...(accounts.get(key) ?? []), refusal]);
  }
  for (const [first, ...rest] of accounts.values()) {
    if (!first) continue;
    const taskIds = [...new Set([first, ...rest].map((refusal) => refusal.taskId))];
    tx(ctx, (emit) => {
      if (!markOwnerAwayTold(ctx, first)) return;
      insertMessage(ctx, emit, {
        from: 'system',
        to: 'lead',
        body:
          `${first.owner} did not answer an approval in time, so agflow starts no new ${first.vendor} attempts on ` +
          `their runners until they answer an approval or change one of their runners. Ready work that waits on ` +
          `it: ${taskIds.join(', ')}. This is the only notice until they are back.`,
      });
    });
  }
}

export interface DispatchResult {
  /** The attempts started, in dispatch order. */
  started: Attempt[];
  /** Ready tasks that no runner could take now. */
  unplaced: string[];
  /** Every ready task that did not start, with why in one line; the board shows it (withWaitReason). */
  waiting: Map<string, string>;
}

/** Why a task in the ready set waits once every worker slot is taken (design 6.6, step 4). */
function slotWords(ctx: HubContext, workerTarget: number | null): string {
  return workerTarget === null
    ? `it waits for a worker slot: AGFLOW_MAX_WORKERS is ${ctx.config.maxWorkers}`
    : `it waits for a worker slot: the worker target is ${workerTarget}`;
}

/**
 * Steps 4 to 6 of a tick (design 6.6): while worker slots are free (worker_target, or maxWorkers without one), each
 * ready task in order is placed by core's place over the snapshot, then claimed and started in its own transaction
 * (startRunnerAttempt). A start that fails is logged and leaves the others standing. The path holders are read once,
 * before the loop, so a task whose paths overlap one started in this tick waits for the next. Ready work that waits
 * because an owner is away is reported to the lead once per away period. Why each ready task did not start is kept
 * for the board until the next tick.
 */
export function dispatch(ctx: HubContext): DispatchResult {
  const staffing = getStaffing(ctx);
  let free = workerSlotsFree({
    workerTarget: staffing.workerTarget,
    maxWorkers: ctx.config.maxWorkers,
    runningWorkers: runningWorkers(ctx),
  });
  const result: DispatchResult = { started: [], unplaced: [], waiting: new Map() };
  memoryOf(ctx).waiting = result.waiting;
  const ready = readySet(ctx, result.waiting);
  // A task in the ready set waits for a slot, unless the loop below starts it or finds another reason.
  for (const task of ready) result.waiting.set(task.id, slotWords(ctx, staffing.workerTarget));
  if (free === 0) return result;
  if (ready.length === 0) return result;
  const snapshot = placementSnapshot(ctx);
  const away: AwayRefusal[] = [];
  const started: Pick<Task, 'id' | 'ownedPaths'>[] = [];
  for (const task of ready) {
    if (free === 0) break;
    const overlapping = started.find((one) => pathsOverlap(task.ownedPaths, one.ownedPaths));
    if (overlapping) {
      result.unplaced.push(task.id);
      result.waiting.set(task.id, `its owned paths overlap those of ${overlapping.id}, which just started`);
      continue;
    }
    const { placement, refused } = place(snapshot, task, { projectPref: staffing.vendorPref });
    if (!placement) {
      result.unplaced.push(task.id);
      result.waiting.set(task.id, placementWords(snapshot, task, refused));
      away.push(...awayRefusals(snapshot, task.id, refused));
      continue;
    }
    try {
      const { attempt } = startRunnerAttempt(ctx, {
        runnerId: placement.runnerId,
        taskId: task.id,
        role: 'worker',
        vendor: placement.vendor,
      });
      result.started.push(attempt);
      result.waiting.delete(task.id);
      started.push(task);
      recordPlacement(snapshot, placement, 'worker');
      free -= 1;
    } catch (error) {
      console.error(`starting ${task.id} on ${placement.runnerId} failed`, error);
      result.waiting.set(task.id, `its start on ${placement.runnerId} failed; the next tick tries again`);
    }
  }
  if (away.length > 0) tellLeadOwnerAway(ctx, away);
  return result;
}

// ---------------------------------------------------------------------------
// Step 1: reconcile
// ---------------------------------------------------------------------------

/** How far away a reset reads as unknown or too far, in words for the attempt's stop reason. */
function resetWords(ctx: HubContext, resetsAt: number | null): string {
  if (resetsAt === null) return 'its reset time is unknown';
  return `it resets in ${Math.round((resetsAt - ctx.now()) / 60_000)} min`;
}

/** Whether a placement draws on an exhausted account with an unknown reset, usable only for its probing start. */
const isProbe = (placement: Placement): boolean =>
  placement.account?.quota.state === 'exhausted' && placement.account.quota.resetsAt === null;

/**
 * The quota_wait replacement (design 6.10). A worker waiting for a reset more than quotaWaitMaxMs away, or unknown, is
 * replaced (cause quota: no handoff turn, and no failure: no backoff, no failure signature), but only while its
 * successor can start now: a placement for its task exists with quota, and is not an account's probing start, which
 * would only wait in turn; and the worker target and the churn guard let a worker start (design 6.15). The account the
 * attempt waits on offers no placement: its exhaustion, or the limit of the attempt's role (setLimited), keeps it off,
 * for this check and for dispatch alike. A wait holds no slot, so that placement counts the wait's own slot as free;
 * once asked to stop, the wait holds its slot again until it ends, so dispatch keeps it for the successor. A lead is
 * replaced at once, whatever its reset, while runner leads are on and another account can take the seat.
 * While the project is paused nothing starts, so nothing is replaced and the agents in quota_wait resume at their
 * reset (design 6.6, Pause). Otherwise a wait goes on: the runner resumes it at its reset, or retries its turn every
 * quotaUnknownMs. The oldest wait goes first, and each replacement holds its placement in the snapshot, so two waits
 * do not count on one free slot. Returns the attempts it asked to stop.
 */
export function replaceQuotaWaits(ctx: HubContext): string[] {
  const project = getProject(ctx);
  if (project.paused) return [];
  const cutoff = ctx.now() + ctx.config.quotaWaitMaxMs;
  const due = listAttempts(ctx, { status: ['quota_wait'] }).filter(
    (attempt) =>
      attempt.runnerId !== null &&
      attempt.stopRequested === null &&
      (attempt.role === 'lead' || attempt.quotaResetsAt === null || attempt.quotaResetsAt > cutoff),
  );
  if (due.length === 0) return [];
  const snapshot = placementSnapshot(ctx);
  const { workerTarget, vendorPref } = getStaffing(ctx);
  // Each successor needs a worker slot within the target, and no worker starts while the churn guard holds dispatch.
  let workerRoom = churnPaused(ctx)
    ? 0
    : workerSlotsFree({ workerTarget, maxWorkers: ctx.config.maxWorkers, runningWorkers: runningWorkers(ctx) });
  const replaced: string[] = [];
  // listAttempts answers newest first.
  for (const attempt of due.reverse()) {
    try {
      const task = attempt.taskId === null ? null : getTask(ctx, attempt.taskId);
      if (task ? workerRoom === 0 : !project.runnerLeads) continue;
      // The task waited in quota_wait already, so its vendorHint holds it back no longer.
      const prefs = task && { ...placementPrefs(ctx, task, listAttempts(ctx, { task: task.id })), readySince: 0 };
      const { placement } = prefs
        ? place(snapshot, prefs, { projectPref: vendorPref })
        : placeLead(snapshot, { rotatingFrom: null });
      if (!placement || isProbe(placement)) continue;
      requestStop(ctx, {
        attemptId: attempt.id,
        cause: 'quota',
        reason: `the ${attempt.vendor} quota is exhausted and ${resetWords(ctx, attempt.quotaResetsAt)}`,
        by: 'system',
      });
      recordPlacement(snapshot, placement, attempt.role);
      if (task) workerRoom -= 1;
      replaced.push(attempt.id);
    } catch (error) {
      console.error(`replacing attempt ${attempt.id} in quota_wait failed`, error);
    }
  }
  return replaced;
}

/** What step 1 did, duty by duty. */
export interface ReconcileResult {
  /** Live claims whose M1 lease ran out, back to ready (sweepLeases). */
  leases: string[];
  /** Runner attempts ended lost at their lease expiry (expireRunnerLeases). */
  runnerLeases: number;
  /** Approvals declined at approvalMs (expireApprovals). */
  approvals: number;
  /** Stall decisions from fresh facts (judgeStalls). */
  stalls: StallDecisions;
  /** Stops ended at their timeout (expireStops). */
  stops: number;
  /** Submissions failed at their timeout (expireSubmissions). */
  submissions: number;
  /** Hand-backs from the clone given up at handbackTimeoutMs (expireHandbacks). */
  handbacks: number;
  /** Holding runner leads ended lost because they can no longer be resumed (checkHoldingLeads). */
  holdingLeads: string[];
  /** Codex preflights sent for unknown resets (probeUnknownResets). */
  probes: number;
  /** quota_wait attempts asked to stop for a replacement (replaceQuotaWaits). */
  quotaWaits: string[];
  /** Whether a periodic review message went to the lead (periodicLeadReview). */
  leadReview: boolean;
  /** Whether an idle nudge went to the lead (nudgeIdleLead). */
  idleNudge: boolean;
  /** The runner lead asked to rotate (rotateLeadIfDue), or null. */
  rotated: string | null;
}

/** Runs one duty; a failure is logged and leaves the others to run, and the next tick runs it again. */
function duty<T>(name: string, run: () => T, fallback: T): T {
  try {
    return run();
  } catch (error) {
    console.error(`${name} failed`, error);
    return fallback;
  }
}

/**
 * Step 1 of a tick (design 6.6): every reconcile duty, each on its own. Leases come first, so that the stalls, stops
 * and replacements that follow read attempts that are still open, and all of them before dispatch, which then sees
 * the slots and tasks they freed.
 */
export function reconcile(ctx: HubContext): ReconcileResult {
  return {
    leases: duty('the lease sweep', () => sweepLeases(ctx), []),
    runnerLeases: duty('the runner lease expiry', () => expireRunnerLeases(ctx), 0),
    approvals: duty('the approval expiry', () => expireApprovals(ctx), 0),
    stalls: duty('the stall decisions', () => judgeStalls(ctx), { suspected: [], stopped: [] }),
    stops: duty('the stop timeouts', () => expireStops(ctx), 0),
    submissions: duty('the submission timeouts', () => expireSubmissions(ctx), 0),
    handbacks: duty('the hand-back timeouts', () => expireHandbacks(ctx), 0),
    holdingLeads: duty('the holding lead check', () => checkHoldingLeads(ctx), []),
    probes: duty('the Codex reset probe', () => probeUnknownResets(ctx), 0),
    quotaWaits: duty('the quota_wait replacement', () => replaceQuotaWaits(ctx), []),
    leadReview: duty('the lead review', () => periodicLeadReview(ctx) !== null, false),
    idleNudge: duty('the idle nudge', () => nudgeIdleLead(ctx) !== null, false),
    rotated: duty('the lead rotation', () => rotateLeadIfDue(ctx), null),
  };
}

export interface TickResult {
  /** What step 0 found. */
  clock: ClockCheck;
  /** The recovery window is open, so the tick did nothing after the clock check. */
  recovering: boolean;
  /** Null while recovering. */
  reconciled: ReconcileResult | null;
  /** The runner lead the tick started for an empty seat, or null. */
  lead: Attempt | null;
  /** The worker attempts the tick started. */
  started: Attempt[];
}

/**
 * One scheduler tick (design 6.6): the clock check, reconcile, the lead seat, then dispatch. Within the recovery
 * window after downtime the tick stops after the clock check: no lease expires, no stall is judged and nothing
 * starts, while runners reconnect and replay (design 6.14); agents' bridge calls work meanwhile. The lead starts
 * before dispatch, so that dispatch sees the account it draws on; it takes no slot. A paused project skips the lead
 * seat and dispatch (steps 2 to 6); the agents already running go on under every stall, budget and lease rule. While
 * the churn guard holds dispatch (churnPaused), the lead seat step still runs and no worker starts. These three holds
 * are dispatchHold's, and a tick that one of them stops gives every ready task its reason (held). Once the deadline
 * has passed, the tick pauses the project, once per deadline (reachDeadline). Accepted work goes on merging into main
 * whatever the project's state, unless it is paused past its deadline: the merge queue sends a merge that waits, and
 * one that failed again, main's check follows the merges (queueMainCheck), and a fix of main that the task limits
 * refused is created once they allow it (retryFixTask). Just before dispatch, the demo check may add its task
 * (ensureDemoCheck). A review that will not finish lets the hub accept its task as before (expireReviews), while the
 * project is not paused.
 */
export function runTick(ctx: HubContext): TickResult {
  const clock = checkClock(ctx);
  if (inRecovery(ctx)) return held(ctx, { clock, recovering: true, reconciled: null, lead: null, started: [] });
  const reconciled = reconcile(ctx);
  duty('the deadline', () => reachDeadline(ctx), false);
  duty('the merge queue', () => queueMerges(ctx), null);
  duty("main's check", () => queueMainCheck(ctx), null);
  duty("main's fix task", () => retryFixTask(ctx), null);
  if (getProject(ctx).paused) return held(ctx, { clock, recovering: false, reconciled, lead: null, started: [] });
  duty('the review timeouts', () => expireReviews(ctx), 0);
  const lead = duty('starting a runner lead', () => ensureLead(ctx), null);
  // The churn guard holds worker dispatch only: the lead that changes the plan keeps its seat (design 6.15).
  if (churnPaused(ctx)) return held(ctx, { clock, recovering: false, reconciled, lead, started: [] });
  // Before dispatch, so that a new demo check can start in this tick.
  duty('the demo check', () => ensureDemoCheck(ctx), null);
  return { clock, recovering: false, reconciled, lead, started: dispatch(ctx).started };
}

/** How long the scheduler waits after an event that frees a slot or readies a task before its extra tick. */
const DEBOUNCE_MS = 1_000;

export interface SchedulerOptions {
  /** DEBOUNCE_MS by default; tests shorten it. */
  debounceMs?: number | undefined;
}

/** Whether an event frees a worker slot or readies a task, so a tick now may start something. */
const freesOrReadies = (event: { type: string; data: Record<string, unknown> }): boolean =>
  event.type === 'task.ready' ||
  event.type === 'task.unblocked' ||
  event.type === 'task.released' ||
  event.type === 'attempt.ended' ||
  event.type === 'attempt.holding' ||
  event.type === 'attempt.quota_wait' ||
  (event.type === 'task.created' && event.data.status === 'ready');

/**
 * The scheduler's timer (design 6.6; X-26): once started, a tick every tickMs, and one more, debounced, right after
 * a task gets ready (created, made ready, unblocked or released) or a worker slot frees (an attempt ends, holds or
 * waits for its quota).
 * tick() runs one tick now, started or not. startHub creates it started for 'auto' and stopped for 'manual'.
 */
export class Scheduler {
  private readonly ctx: HubContext;
  private readonly debounceMs: number;
  private interval: ReturnType<typeof setInterval> | null = null;
  private debounced: ReturnType<typeof setTimeout> | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(ctx: HubContext, options: SchedulerOptions = {}) {
    this.ctx = ctx;
    this.debounceMs = options.debounceMs ?? DEBOUNCE_MS;
  }

  get running(): boolean {
    return this.interval !== null;
  }

  /** Runs one tick now, then samples the free slots for the Load page. */
  tick(): TickResult {
    const result = runTick(this.ctx);
    duty('the slot sample', () => sampleSlots(this.ctx), undefined);
    return result;
  }

  /** Begins the timer and the extra ticks after events; nothing when it runs already. */
  start(): void {
    if (this.interval !== null) return;
    this.interval = setInterval(() => this.timed(), this.ctx.config.tickMs);
    this.unsubscribe = this.ctx.bus.subscribe((event) => {
      if (this.debounced === null && freesOrReadies(event)) {
        this.debounced = setTimeout(() => {
          this.debounced = null;
          this.timed();
        }, this.debounceMs);
      }
    });
  }

  /** Stops the timer and the extra ticks; tick() still runs one. */
  stop(): void {
    if (this.interval !== null) clearInterval(this.interval);
    if (this.debounced !== null) clearTimeout(this.debounced);
    this.unsubscribe?.();
    this.interval = null;
    this.debounced = null;
    this.unsubscribe = null;
  }

  /** A tick from the timer, which has no caller to throw to. */
  private timed(): void {
    try {
      this.tick();
    } catch (error) {
      console.error('the scheduler tick failed', error);
    }
  }
}

export interface StaffingRequest {
  count: number;
  vendor?: Vendor | undefined;
}

/**
 * request_agents (design 6.6): the worker target becomes count, clamped to [0, maxWorkers], and a vendor is preferred
 * for vendorPrefMs. Auto-fill is the scheduler itself, so nothing starts here. Returns the running workers and the
 * target.
 */
export function requestAgents(ctx: HubContext, request: StaffingRequest): { running: number; target: number } {
  return tx(ctx, () => {
    const target = setWorkerTarget(ctx, request.count);
    if (request.vendor) setVendorPreference(ctx, request.vendor);
    return { running: runningWorkers(ctx), target };
  });
}

// ---------------------------------------------------------------------------
// The worker load and the idle nudge: workers never wait for the plan
// ---------------------------------------------------------------------------

/** What the lead plans against: the workers, the slots dispatch could fill, and the tasks in each state. */
export interface WorkerLoad {
  /** Runner workers that take a slot (runningWorkers). */
  running: number;
  /** project.worker_target, which request_agents sets; null leaves the cap. */
  target: number | null;
  /** maxWorkers. */
  cap: number;
  /**
   * The workers dispatch could start now: the target or cap less the running workers, bounded by the free slots of the
   * runners that can place a worker (runnerSlots).
   */
  freeSlots: number;
  ready: number;
  /** The ready tasks dispatch may start now (readySet): none while dispatch is held (dispatchHold). */
  dispatchable: number;
  blockedOnDependencies: number;
  /** Submitted and waiting for the lead's verdict (SUBMITTED). */
  submitted: number;
  /** Accepted and not in main yet (ACCEPTED_NOT_MERGED). */
  acceptedNotMerged: number;
}

/** A task submitted and waiting for the lead's verdict. */
export const SUBMITTED: readonly TaskStatus[] = ['submitted', 'checking', 'reviewing'];

/** A task accepted and not in main yet: merging too, which AGFLOW_AUTO_MERGE moves accepted work to. */
export const ACCEPTED_NOT_MERGED: readonly TaskStatus[] = ['accepted', 'merging'];

/**
 * The slots of the runners that can take a worker now, or once one of their slots frees: placement refuses them
 * nothing but a full runner (candidateRunners), and one of their vendors is usable for a worker (usableVendors). All
 * their slots, the ones workers take (a lead and a quota wait take none: TAKES_SLOT_SQL), and the free ones. The
 * lead's report, the idle nudge, the Load page and its strip count free slots this way.
 */
export function runnerSlots(ctx: HubContext): { capacity: number; busy: number; idle: number } {
  const snapshot = placementSnapshot(ctx);
  const { candidates, refused } = candidateRunners(snapshot);
  const full = new Set(refused.filter((one) => one.refusal === 'full').map((one) => one.runnerId));
  const slots = { capacity: 0, busy: 0, idle: 0 };
  for (const runner of snapshot.runners) {
    if (!candidates.includes(runner) && !full.has(runner.id)) continue;
    if (usableVendors(snapshot, runner).usable.length === 0) continue;
    slots.capacity += runner.capacity;
    slots.busy += runner.openAttempts;
    slots.idle += freeSlots(runner);
  }
  return slots;
}

/** The worker load now, as dispatch computes it. */
export function workerLoad(ctx: HubContext): WorkerLoad {
  const { workerTarget } = getStaffing(ctx);
  const running = runningWorkers(ctx);
  const free = workerSlotsFree({ workerTarget, maxWorkers: ctx.config.maxWorkers, runningWorkers: running });
  const tasks = listTasks(ctx);
  const count = (statuses: readonly TaskStatus[]): number =>
    tasks.filter((task) => statuses.includes(task.status)).length;
  return {
    running,
    target: workerTarget,
    cap: ctx.config.maxWorkers,
    freeSlots: free === 0 ? 0 : Math.min(free, runnerSlots(ctx).idle),
    ready: count(['ready']),
    // None while dispatch is held, whatever the ready set holds.
    dispatchable: dispatchHold(ctx) === null ? readySet(ctx).length : 0,
    blockedOnDependencies: tasks.filter((task) => task.status === 'blocked' && task.blockedKind === 'deps').length,
    submitted: count(SUBMITTED),
    acceptedNotMerged: count(ACCEPTED_NOT_MERGED),
  };
}

const at = (ms: number): string => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

/** A span of time for the lead: minutes, then hours and minutes. */
function span(ms: number): string {
  const minutes = Math.round(Math.abs(ms) / 60_000);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/**
 * An account's quota line for the lead, read as placement reads it (core's reportHolds and utilization), as the web's
 * runner card does: once its reset has passed, the reading is stale, and its limiting window reads unknown until a
 * newer report. The reset is told relative to now.
 */
function quotaLine(account: AccountQuota, now: number): string {
  const { state, windows, resetsAt } = account.quota;
  // As on the runner card, a probing start does not count: a reading with an unknown reset holds until a newer one.
  const view = { ...account, openAttempts: 1 };
  const holds = reportHolds({ now, quotaUnknownMs: 0, runners: [], accounts: [] }, view);
  const placed = utilization(view, holds);
  const use = (window: 'fiveHour' | 'weekly'): string => {
    const value = windows[window];
    return value === null || placed[window] !== value ? 'unknown' : `${Math.round(value * 100)}%`;
  };
  const head = `- ${account.owner} ${account.vendor}`;
  const read = `5-hour ${use('fiveHour')}, weekly ${use('weekly')}`;
  if (resetsAt === null) return `${head}: ${state}, ${read}, reset unknown`;
  if (holds) return `${head}: ${state}, ${read}, resets in ${span(resetsAt - now)}`;
  return `${head}: stale, ${read}, reset passed ${span(now - resetsAt)} ago`;
}

/**
 * The worker load, with how many submitted tasks agents review, the tasks parked while main's check fails, why worker
 * dispatch is held when it is, one quota line per account and the deadline with the time left, as lines for the lead.
 */
export function loadLines(ctx: HubContext, load: WorkerLoad): string[] {
  const reviewing = tasksUnderReview(ctx).size;
  const underReview = reviewing > 0 ? `, ${reviewing} of them under review by agents` : '';
  // Without a target of its own, the project's target is the cap.
  const lines = [
    `Workers: ${load.running} running (target ${load.target ?? load.cap}, cap ${load.cap}); ${load.freeSlots} free ` +
      'worker slot(s).',
    `Ready tasks: ${load.ready}, ${load.dispatchable} of them dispatchable now. Blocked on dependencies: ` +
      `${load.blockedOnDependencies}. Submitted: ${load.submitted}${underReview}. Accepted, not merged: ` +
      `${load.acceptedNotMerged}.`,
  ];
  const parked = parkedLine(ctx);
  if (parked !== null) lines.push(parked);
  const hold = dispatchHold(ctx);
  if (hold !== null) lines.push(`No worker starts now: ${hold}.`);
  const now = ctx.now();
  const accounts = listAccounts(ctx);
  if (accounts.length === 0) lines.push('Quota: no account has reported yet.');
  else lines.push('Quota:', ...accounts.map((account) => quotaLine(account, now)));
  const { deadlineAt } = getProject(ctx);
  if (deadlineAt === null) lines.push('Deadline: no deadline.');
  else {
    const left = deadlineAt - now;
    lines.push(`Deadline: ${at(deadlineAt)}, ${left >= 0 ? `${span(left)} left` : `passed ${span(left)} ago`}.`);
  }
  return lines;
}

/** What an idle nudge asks of the lead; its order of improvements is the lead guide's (brief.ts). */
const NUDGE_PLAN =
  'Plan the next batch now, so that ready, independent tasks are at least as many as the worker slots, running plus ' +
  'free. Tasks blocked on dependencies count as planned: while they wait for work in progress, such as the skeleton, ' +
  'add only tasks that need none of it. Work through SPEC.md (or the goal) until every requirement is covered. Once ' +
  'it is, plan in this order: requirements docs/STATUS.md does not show working, defects from the latest demo check ' +
  'and gaps agents named, missing tests, demo polish, then new features a jury would notice. In the last hour before ' +
  'the deadline, plan only fixes.';

/** The worker slots the lead plans for: those workers take now, and the free ones (WorkerLoad). */
const workerSlots = (load: WorkerLoad): number => load.running + load.freeSlots;

/**
 * When the dispatchable ready tasks, parked ones counted, became fewer than the worker slots, per hub context. Kept in
 * memory: a restarted hub only waits idleNudgeMs again before it nudges.
 */
const idleSince = new WeakMap<HubContext, number>();

/** When the newest idle nudge went to the lead, or null. */
function lastNudgeAt(ctx: HubContext): number | null {
  const row = ctx.db
    .query("SELECT MAX(ts) AS ts FROM events WHERE type = 'lead.idle_nudged'")
    .get() as { ts: number | null };
  return row.ts;
}

/**
 * The idle nudge: while a runner lead holds the seat and the dispatchable ready tasks, with those parked while main's
 * check fails (parkedTasks), are fewer than the worker slots, running plus free (workerSlots), for idleNudgeMs without
 * a break, the lead gets one system message with the load, each account's quota, the deadline and what to plan; then
 * none before idleNudgeIntervalMs has passed since the last (lead.idle_nudged), and none at all while it is 0. So a
 * lead whose every slot is busy hears too, before the slots run dry, and parking alone sets off none. While worker
 * dispatch is held (dispatchHold: a paused project, the churn guard) no worker starts, so none goes out. Without a
 * goal there is nothing to plan, and the work is planned until the deadline, so none goes out before the goal is set
 * or once the deadline has passed. Part of the tick's reconcile step. Returns the message, or null.
 */
export function nudgeIdleLead(ctx: HubContext): Message | null {
  if (ctx.config.idleNudgeIntervalMs === 0) return null;
  const { deadlineAt } = getProject(ctx);
  const due =
    dispatchHold(ctx) === null && currentGoalVersion(ctx) > 0 && (deadlineAt === null || ctx.now() < deadlineAt);
  const load = due && leadSeat(ctx).kind === 'runner' ? workerLoad(ctx) : null;
  // A task parked while main's check fails counts as dispatchable: it takes a slot by itself once main passes.
  const parked = load === null ? 0 : parkedTasks(ctx).size;
  if (load === null || load.dispatchable + parked >= workerSlots(load)) {
    idleSince.delete(ctx);
    return null;
  }
  const now = ctx.now();
  const since = idleSince.get(ctx) ?? now;
  idleSince.set(ctx, since);
  if (now - since < ctx.config.idleNudgeMs) return null;
  const last = lastNudgeAt(ctx);
  if (last !== null && now - last < ctx.config.idleNudgeIntervalMs) return null;
  const lines = loadLines(ctx, load);
  return tx(ctx, (emit) => {
    emit({ type: 'lead.idle_nudged', actor: 'system', data: { ...load, deadlineAt } });
    return insertMessage(ctx, emit, {
      from: 'system',
      to: 'lead',
      body:
        `Only ${load.dispatchable} ready task(s) are dispatchable${parked > 0 ? ` and ${parked} parked` : ''}, fewer ` +
        `than the ${workerSlots(load)} worker slot(s) (${load.running} running, ${load.freeSlots} free).\n` +
        `${lines.join('\n')}\n\n${NUDGE_PLAN}`,
    });
  });
}

// ---------------------------------------------------------------------------
// What the scheduler keeps between ticks: why ready tasks wait, and how many slots stood free
// ---------------------------------------------------------------------------

const HOUR = 60 * 60_000;

/** The free slots after one tick. */
interface SlotSample {
  at: number;
  idle: number;
}

/** Kept in memory only: a hub that restarts begins both afresh. */
interface TickMemory {
  /** Why each ready task did not start in the last tick (dispatch, or held when the tick started no worker). */
  waiting: Map<string, string>;
  /** The last hour's samples, oldest first. */
  samples: SlotSample[];
}

const memories = new WeakMap<HubContext, TickMemory>();

function memoryOf(ctx: HubContext): TickMemory {
  let memory = memories.get(ctx);
  if (!memory) {
    memory = { waiting: new Map(), samples: [] };
    memories.set(ctx, memory);
  }
  return memory;
}

/**
 * Forgets what the scheduler keeps in memory: why ready tasks waited, the free slot samples and when the slots went
 * idle (idleSince), so a new project (a reset) starts them all afresh.
 */
export function forgetSchedulerMemory(ctx: HubContext): void {
  memories.delete(ctx);
  idleSince.delete(ctx);
}

/**
 * Why no worker starts now, in one line for the board, the Load page and the lead; null when dispatch runs. Within the
 * recovery window the tick does nothing, a paused project starts nothing, and the churn guard holds worker dispatch
 * (runTick). The one rule for a held dispatch: the idle nudge and the dispatchable counts follow it too.
 */
export function dispatchHold(ctx: HubContext): string | null {
  const now = ctx.now();
  const { recoveryUntil, dispatchPausedUntil } = getHubState(ctx);
  const minutes = (until: number | null): number => minutesUntil(until ?? now, now);
  if (inRecovery(ctx)) {
    return `the hub is recovering after downtime: nothing starts for up to ${minutes(recoveryUntil)} min`;
  }
  if (getProject(ctx).paused) return 'the project is paused';
  if (churnPaused(ctx)) return `the churn guard holds worker dispatch for ${minutes(dispatchPausedUntil)} more min`;
  return null;
}

/** A tick that starts no worker: the ready set waits for dispatchHold's reason, other ready tasks for their own. */
function held(ctx: HubContext, result: TickResult): TickResult {
  const waiting = new Map<string, string>();
  const ready = readySet(ctx, waiting);
  const why = dispatchHold(ctx);
  if (why !== null) for (const task of ready) waiting.set(task.id, why);
  memoryOf(ctx).waiting = waiting;
  return result;
}

/**
 * Why each ready task did not start in the last tick, in the order the tick found them: those the rules hold back,
 * then the rest in dispatch order. Some may no longer be ready. Empty before the first tick. The lead's situation
 * report names them.
 */
export function waitReasons(ctx: HubContext): ReadonlyMap<string, string> {
  return memories.get(ctx)?.waiting ?? new Map();
}

/**
 * The task with its waitReason: why the last tick did not start it, while it is still ready; while it is merging and
 * its last merge failed, how many of its merges failed and the newest error (failedMerges); null otherwise.
 */
export function withWaitReason(ctx: HubContext, task: Task): Task {
  if (task.status === 'merging') {
    const failed = failedMerges(ctx, task.id);
    const times = failed?.count === 1 ? 'time' : 'times';
    return { ...task, waitReason: failed && `merge failed ${failed.count} ${times}: ${failed.lastError}` };
  }
  const reason = task.status === 'ready' ? memories.get(ctx)?.waiting.get(task.id) : undefined;
  return { ...task, waitReason: reason ?? null };
}

/** Keeps a sample of the free slots now (runnerSlots), and drops the samples older than an hour. */
export function sampleSlots(ctx: HubContext): void {
  const now = ctx.now();
  const memory = memoryOf(ctx);
  memory.samples = memory.samples.filter((sample) => sample.at > now - HOUR);
  memory.samples.push({ at: now, idle: runnerSlots(ctx).idle });
}

/**
 * Free slot minutes in the hour before now, to a tenth: each sample's free slots until the next sample, the last one's
 * until now, each for at most tickMs, so a stretch without ticks counts as one tick.
 */
export function idleSlotMinutes(ctx: HubContext): number {
  const now = ctx.now();
  const samples = memoryOf(ctx).samples.filter((sample) => sample.at > now - HOUR);
  let slotMs = 0;
  samples.forEach((sample, index) => {
    const next = samples[index + 1]?.at ?? now;
    slotMs += sample.idle * Math.min(Math.max(0, next - sample.at), ctx.config.tickMs);
  });
  return Math.round(slotMs / 6_000) / 10;
}
