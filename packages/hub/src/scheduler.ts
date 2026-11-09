// The scheduler (design 6.6). Each tick reads the database into core's terms and leaves the rules to core's
// scheduling.ts (X-46): which ready tasks qualify and in what order, how many workers may start, and where each one
// goes. Every claim and start is its own transaction, so one that fails rolls back only itself, and the tick's
// placement snapshot is updated after each start, so a runner's slots and an account's probing start are not handed
// out twice.
import {
  type Attempt,
  type EndedAttemptView,
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
  runnerToAvoid,
  workerSlotsFree,
} from '@agflow/core';
import { listAttempts, unpushedHead } from './attempt-store';
import { ladderRequirement, startRunnerAttempt } from './attempts';
import { type HubContext, tx } from './context';
import { insertMessage } from './messages';
import { placementSnapshot } from './placement';
import { getProject, getStaffing, setVendorPreference, setWorkerTarget } from './project';
import { markOwnerAwayTold } from './quota';
import { isPathHolder, listTasks, unmetDependencies } from './task-store';

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

/** A ready task in core's terms (design 6.6, step 3). */
function candidateOf(ctx: HubContext, task: Task, columns: { holdUntil: number | null; floor: number }): TaskCandidate {
  const attempts = listAttempts(ctx, { task: task.id });
  const current = task.currentAttempt === null ? undefined : attempts.find((one) => one.id === task.currentAttempt);
  const ended = attempts.filter((attempt) => attempt.status === 'ended');
  return {
    id: task.id,
    status: task.status,
    priority: task.priority,
    createdAt: task.createdAt,
    ownedPaths: task.ownedPaths,
    kind: task.kind,
    createdBy: task.createdBy,
    nextDispatchAt: task.nextDispatchAt,
    vendorHint: task.vendorHint ?? null,
    dependenciesDone: unmetDependencies(ctx, task.dependsOn).length === 0,
    openAttempt: current !== undefined && current.status !== 'ended',
    dispatchHoldUntil: columns.holdUntil,
    counted: countedAttempts(attempts, columns.floor),
    requirement: ladderRequirement(ctx, task.id),
    avoidRunner: runnerToAvoid(ended.map((attempt) => endedView(ctx, task, attempt))),
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

/** Counts a start in the tick's snapshot: a slot less on its runner, an open attempt more on its account. */
function recordStart(snapshot: PlacementSnapshot, runnerId: string, accountId: string | null): void {
  const runner = snapshot.runners.find((slot) => slot.id === runnerId);
  if (!runner) return;
  runner.openAttempts += 1;
  const vendors = new Set(runner.vendors.filter((slot) => slot.accountId === accountId).map((slot) => slot.vendor));
  for (const account of snapshot.accounts) {
    if (account.owner === runner.owner && account.accountId === accountId && vendors.has(account.vendor)) {
      account.openAttempts += 1;
    }
  }
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
      recordStart(snapshot, placement.runnerId, placement.account?.accountId ?? null);
      free -= 1;
    } catch (error) {
      console.error(`starting ${task.id} on ${placement.runnerId} failed`, error);
    }
  }
  if (away.length > 0) tellLeadOwnerAway(ctx, away);
  return result;
}

export interface TickResult {
  /** The worker attempts the tick started. */
  started: Attempt[];
}

/**
 * One scheduler tick (design 6.6). A paused project skips the lead seat and dispatch (steps 2 to 6); the agents
 * already running go on under every stall, budget and lease rule.
 */
export function runTick(ctx: HubContext): TickResult {
  if (getProject(ctx).paused) return { started: [] };
  return { started: dispatch(ctx).started };
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
