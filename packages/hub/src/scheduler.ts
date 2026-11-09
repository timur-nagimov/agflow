// The scheduler (design 6.6). Each tick first reconciles (step 1: leases, approvals, stalls, stop and submission
// timeouts, holding leads, the Codex reset probe and quota_wait replacements), fills an empty lead seat (step 2,
// lead.ts), then reads the database into core's terms and leaves
// the rules to core's scheduling.ts (X-46): which ready tasks qualify and in what order, how many workers may start,
// and where each one goes. Every claim and start is its own transaction, so one that fails rolls back only itself,
// and the tick's placement snapshot is updated after each start, so a runner's slots and an account's probing start
// are not handed out twice. Retention and remote-ref cleanup are not the tick's: they run on a daily timer (X-39).
import {
  type Attempt,
  type EndedAttemptView,
  type Placement,
  type PlacementSnapshot,
  type RefusedPlacement,
  type Task,
  type TaskCandidate,
  type Vendor,
  countedAttempts,
  isDispatchable,
  orderReady,
  pathsOverlap,
  place,
  placeLead,
  runnerToAvoid,
  workerSlotsFree,
} from '@agflow/core';
import { expireApprovals } from './approvals';
import { listAttempts, unpushedHead } from './attempt-store';
import { expireRunnerLeases, expireStops, ladderRequirement, requestStop, startRunnerAttempt } from './attempts';
import { type HubContext, tx } from './context';
import { checkHoldingLeads, ensureLead } from './lead';
import { insertMessage } from './messages';
import { placementSnapshot } from './placement';
import { getProject, getStaffing, setVendorPreference, setWorkerTarget } from './project';
import { markOwnerAwayTold, probeUnknownResets } from './quota';
import { expireSubmissions } from './submissions';
import { type StallDecisions, judgeStalls } from './supervisor';
import { getTask, isPathHolder, listTasks, unmetDependencies } from './task-store';
import { sweepLeases } from './tasks';

/** Statuses of a runner worker that take one of the project's worker slots (design 6.6, step 4). */
const SLOT_STATUSES = "('starting', 'running', 'quota_wait')";

/** Runner workers starting, running or in quota_wait. Leads and live chats do not count. */
export function runningWorkers(ctx: HubContext): number {
  return (
    ctx.db
      .query(
        `SELECT COUNT(*) AS n FROM attempts
         WHERE role = 'worker' AND runner_id IS NOT NULL AND status IN ${SLOT_STATUSES}`,
      )
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

/** What steers where a task's next attempt goes: the ladder's vendor, the task's hint and the runner to avoid. */
type PlacementPrefs = Pick<TaskCandidate, 'vendorHint' | 'requirement' | 'avoidRunner'>;

function placementPrefs(ctx: HubContext, task: Task, attempts: readonly Attempt[]): PlacementPrefs {
  const ended = attempts.filter((attempt) => attempt.status === 'ended');
  return {
    vendorHint: task.vendorHint ?? null,
    requirement: ladderRequirement(ctx, task.id),
    avoidRunner: runnerToAvoid(ended.map((attempt) => endedView(ctx, task, attempt))),
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
  };
}

/** The ready set in dispatch order (design 6.6, step 3): by priority, then age. */
export function readySet(ctx: HubContext): TaskCandidate[] {
  const tasks = listTasks(ctx);
  const columns = dispatchColumns(ctx);
  const pathHolders = tasks.filter(isPathHolder);
  const context = { now: ctx.now(), maxAttempts: ctx.config.maxAttempts, pathHolders };
  const ready = tasks.flatMap((task) => {
    const stored = columns.get(task.id);
    return task.status === 'ready' && stored ? [candidateOf(ctx, task, stored)] : [];
  });
  return orderReady(ready.filter((candidate) => isDispatchable(candidate, context)));
}

/** Counts a placement in the snapshot: a slot less on its runner, an open attempt more on its account. */
function recordPlacement(snapshot: PlacementSnapshot, placement: Placement): void {
  const runner = snapshot.runners.find((slot) => slot.id === placement.runnerId);
  if (runner) runner.openAttempts += 1;
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
}

/**
 * Steps 4 to 6 of a tick (design 6.6): while worker slots are free (worker_target, or maxWorkers without one), each
 * ready task in order is placed by core's place over the snapshot, then claimed and started in its own transaction
 * (startRunnerAttempt). A start that fails is logged and leaves the others standing. The path holders are read once,
 * before the loop, so a task whose paths overlap one started in this tick waits for the next. Ready work that waits
 * because an owner is away is reported to the lead once per away period.
 */
export function dispatch(ctx: HubContext): DispatchResult {
  const staffing = getStaffing(ctx);
  let free = workerSlotsFree({
    workerTarget: staffing.workerTarget,
    maxWorkers: ctx.config.maxWorkers,
    runningWorkers: runningWorkers(ctx),
  });
  const result: DispatchResult = { started: [], unplaced: [] };
  if (free === 0) return result;
  const ready = readySet(ctx);
  if (ready.length === 0) return result;
  const snapshot = placementSnapshot(ctx);
  const away: AwayRefusal[] = [];
  const started: Pick<Task, 'id' | 'ownedPaths'>[] = [];
  for (const task of ready) {
    if (free === 0) break;
    if (started.some((one) => pathsOverlap(task.ownedPaths, one.ownedPaths))) {
      result.unplaced.push(task.id);
      continue;
    }
    const { placement, refused } = place(snapshot, task, { projectPref: staffing.vendorPref });
    if (!placement) {
      result.unplaced.push(task.id);
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
      started.push(task);
      recordPlacement(snapshot, placement);
      free -= 1;
    } catch (error) {
      console.error(`starting ${task.id} on ${placement.runnerId} failed`, error);
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
 * The quota_wait replacement (design 6.10): an attempt waiting for a reset more than quotaWaitMaxMs away, or unknown,
 * is replaced (cause quota: class infra, no handoff turn), but only while its successor can start now: a placement
 * with quota exists for its task, or for a lead, and is not an account's probing start, which would only wait in turn.
 * A worker's successor needs the slot the wait frees to be within the worker target, and a lead's needs runner leads
 * on. While the project is paused nothing starts, so nothing is replaced and the agents in quota_wait resume at their
 * reset (design 6.6, Pause). Otherwise it keeps waiting, and the runner retries its turn every quotaUnknownMs. The
 * oldest wait goes first, and each replacement holds its placement in the snapshot, so two waits do not count on one
 * free slot. Returns the attempts it asked to stop.
 */
export function replaceQuotaWaits(ctx: HubContext): string[] {
  const project = getProject(ctx);
  if (project.paused) return [];
  const cutoff = ctx.now() + ctx.config.quotaWaitMaxMs;
  const due = listAttempts(ctx, { status: ['quota_wait'] }).filter(
    (attempt) =>
      attempt.runnerId !== null &&
      attempt.stopRequested === null &&
      (attempt.quotaResetsAt === null || attempt.quotaResetsAt > cutoff),
  );
  if (due.length === 0) return [];
  const snapshot = placementSnapshot(ctx);
  const { workerTarget, vendorPref } = getStaffing(ctx);
  // The wait holds a slot; its successor takes that slot, so it may start only when the slot is within the target.
  const workerRoom =
    workerSlotsFree({ workerTarget, maxWorkers: ctx.config.maxWorkers, runningWorkers: runningWorkers(ctx) - 1 }) > 0;
  const replaced: string[] = [];
  // listAttempts answers newest first.
  for (const attempt of due.reverse()) {
    try {
      const task = attempt.taskId === null ? null : getTask(ctx, attempt.taskId);
      if (task ? !workerRoom : !project.runnerLeads) continue;
      const { placement } = task
        ? place(snapshot, placementPrefs(ctx, task, listAttempts(ctx, { task: task.id })), { projectPref: vendorPref })
        : placeLead(snapshot, { rotatingFrom: null });
      if (!placement || isProbe(placement)) continue;
      requestStop(ctx, {
        attemptId: attempt.id,
        cause: 'quota',
        reason: `the ${attempt.vendor} quota is exhausted and ${resetWords(ctx, attempt.quotaResetsAt)}`,
        by: 'system',
      });
      recordPlacement(snapshot, placement);
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
  /** Holding runner leads ended lost because they can no longer be resumed (checkHoldingLeads). */
  holdingLeads: string[];
  /** Codex preflights sent for unknown resets (probeUnknownResets). */
  probes: number;
  /** quota_wait attempts asked to stop for a replacement (replaceQuotaWaits). */
  quotaWaits: string[];
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
    holdingLeads: duty('the holding lead check', () => checkHoldingLeads(ctx), []),
    probes: duty('the Codex reset probe', () => probeUnknownResets(ctx), 0),
    quotaWaits: duty('the quota_wait replacement', () => replaceQuotaWaits(ctx), []),
  };
}

export interface TickResult {
  reconciled: ReconcileResult;
  /** The runner lead the tick started for an empty seat, or null. */
  lead: Attempt | null;
  /** The worker attempts the tick started. */
  started: Attempt[];
}

/**
 * One scheduler tick (design 6.6): reconcile, the lead seat, then dispatch. The lead starts first, so that dispatch
 * sees the slot it takes. A paused project skips the lead seat and dispatch (steps 2 to 6); the agents already running
 * go on under every stall, budget and lease rule.
 */
export function runTick(ctx: HubContext): TickResult {
  const reconciled = reconcile(ctx);
  if (getProject(ctx).paused) return { reconciled, lead: null, started: [] };
  const lead = duty('starting a runner lead', () => ensureLead(ctx), null);
  return { reconciled, lead, started: dispatch(ctx).started };
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
  (event.type === 'task.created' && event.data.status === 'ready');

/**
 * The scheduler's timer (design 6.6; X-26): once started, a tick every tickMs, and one more, debounced, right after
 * a task gets ready (created, made ready, unblocked or released) or a worker slot frees (an attempt ends or holds).
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

  /** Runs one tick now. */
  tick(): TickResult {
    return runTick(this.ctx);
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
