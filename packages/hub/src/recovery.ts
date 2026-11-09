// What the hub does when a runner comes back (design 6.3, Reconciliation on hello; 6.4, Lease expiry): it decides,
// in the hello transaction, every attempt it believes open on that runner from the state the runner reports, builds
// the list of attempts the runner must stop before it runs any command, and asks for the transcripts of attempts that
// ended lost while it was away; after a restore, it ends what the restored hub no longer names and re-fences the rest
// once the runner's replay is complete. Resumes that wait for the runner to be ok, and transcript tails uploaded over
// HTTP, are here too. So is what the hub does when it comes back itself (design 6.14): the clock check that finds
// downtime, and the pid file that keeps two hubs, or a hub and a restore, off one database.
import { linkSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { uptime } from 'node:os';
import { type Attempt, type HubMessage, type LiveAttempt, formatFence } from '@agflow/core';
import { appendAttemptLog, findAttempt, getAttempt, issueFence, listAttempts, updateAttempt } from './attempt-store';
import { endAttempt, recentResumes, resumeAttempt, stopCommand } from './attempts';
import { revokeAgentTokens } from './auth';
import { cancelPendingCommands, enqueueCommand } from './commands';
import { type HubContext, tx } from './context';
import { forbidden } from './errors';
import { getHubState, hubEpoch, updateHubState } from './hub-state';
import {
  type HelloMessage,
  findRunnerRow,
  isRestorePending,
  setDeferredResumes,
  setRestorePending,
  takeDeferredResumes,
} from './runners';
import { getTask, writeTask } from './task-store';

type WelcomeStop = Extract<HubMessage, { t: 'welcome' }>['stop'][number];

/** What reconciliation did to one open attempt, by the row that matched. */
export type ReconcileAction =
  /** The process is gone and a stop was recorded: it ended with the requested cause. */
  | 'ended'
  /** A take-over in flight with a clone: its pending prepare_takeover goes out again after welcome. */
  | 'takeover'
  /**
   * The runner still runs it, it stays holding, or its stop waits for a submission the replay may decide: its pending
   * commands go out again after welcome.
   */
  | 'kept'
  /** Stopped or suspended with a clone: resumed at a new fence. */
  | 'resumed'
  /** The same, while the runner is not ok: the resume waits for runner.state ok, and the lease keeps running. */
  | 'deferred'
  /**
   * Not reported while its start_attempt is still pending: the start goes out again, with a fresh token, and at a new
   * fence when its fence is of an epoch before a restore.
   */
  | 'resent'
  /** Lost on the runner while it held a process, or restarted too often: it ended crashed. */
  | 'crashed'
  /** A holding attempt the runner no longer has: it cannot be resumed. */
  | 'unresumable'
  /** After a restore: reported, but its task or the lead seat no longer names it, so it ended superseded. */
  | 'superseded'
  /** After a restore: reported and still named, so it gets a new fence once the runner's replay is complete. */
  | 'refence';

export interface ReconcileResult {
  /** The attempts the runner must stop: reported, but ended, unknown or not this runner's. */
  stop: WelcomeStop[];
  /** What happened to each attempt the hub had open on the runner, in the order they were decided. */
  actions: { attemptId: string; action: ReconcileAction }[];
}

/** What a reconciliation resume tells the agent (design 6.3, resume_attempt). */
export const RESTART_PROMPT = 'the runner restarted; continue from your last step';

/** Runner-restart resumes within resumeWindowMs: the one that would reach this count ends the attempt crashed. */
const RESTART_RESUMES_LIMIT = 2;

const gone = (live: LiveAttempt | undefined): live is LiveAttempt =>
  live?.state === 'stopped' || live?.state === 'suspended';

/** The attempt's start_attempt has not been answered: the runner may never have had it. */
function startPending(ctx: HubContext, attemptId: string): boolean {
  const row = ctx.db
    .query(
      `SELECT 1 FROM runner_commands
       WHERE attempt_id = $attemptId AND kind = 'start_attempt' AND status = 'pending'`,
    )
    .get({ attemptId });
  return row !== null;
}

const actorOf = (attempt: Attempt): string => `runner:${attempt.runnerId}`;

/**
 * A start the runner never had, queued at a fence of an epoch before a restore: the restored hub accepts no token of
 * that fence (design 6.5), so the start goes out again at a new fence, with the attempt's tokens revoked and a recorded
 * stop queued again after it. As the runner does not report the attempt, it never ran the old start, so a fresh one is
 * safe. Keyed on the fence, not on the hello, so a runner whose restore-pending flag is cleared is covered too.
 */
function restartAtNewFence(ctx: HubContext, attempt: Attempt): void {
  const cancelled = cancelPendingCommands(ctx, attempt.id);
  revokeAgentTokens(ctx, attempt.id);
  const fence = issueFence(ctx);
  updateAttempt(ctx, attempt.id, { fence });
  appendAttemptLog(ctx, attempt.id, 'note', `started again at fence ${formatFence(fence)}: the hub was restored from a backup`);
  for (const row of cancelled) {
    if (row.command.kind !== 'start_attempt') continue;
    enqueueCommand(ctx, attempt.runnerId as string, { ...row.command, attempt: { ...row.command.attempt, fence } });
  }
  const stop = attempt.stopRequested;
  if (stop && !stop.deferred) {
    // The process the stop is for has not started yet: it gets the whole grace, as after a resume.
    updateAttempt(ctx, attempt.id, { stopRequested: { ...stop, at: ctx.now() } });
    enqueueCommand(ctx, attempt.runnerId as string, stopCommand(getAttempt(ctx, attempt.id)));
  }
}

/**
 * The process is gone, so a recorded stop is complete (invariant a): the attempt ends with the requested cause. While
 * the replay that may still hold its exit is pending, a task the ending made ready waits dispatchHoldMs, so that a
 * successor starts from the final WIP the exit reports (invariant b); that WIP, late work by then, ends the wait.
 */
function completeStop(ctx: HubContext, attempt: Attempt, replayPending = false): ReconcileAction {
  const cause = (attempt.stopRequested as NonNullable<Attempt['stopRequested']>).cause;
  const ending = endAttempt(ctx, { attemptId: attempt.id, trigger: cause, actor: actorOf(attempt) });
  if (replayPending && ending?.task?.status === 'ready') {
    writeTask(ctx, ending.task.id, { dispatchHoldUntil: ctx.now() + ctx.config.dispatchHoldMs });
  }
  return 'ended';
}

/**
 * A runner-restart resume at a new fence, or, when it would be the second within resumeWindowMs, the end of the
 * attempt: crashed.
 */
function restartResume(ctx: HubContext, attempt: Attempt): ReconcileAction {
  const actor = actorOf(attempt);
  const earlier = recentResumes(ctx, attempt.id, 'runner_restart', ctx.config.resumeWindowMs);
  if (earlier + 1 >= RESTART_RESUMES_LIMIT) {
    const error = `the runner restarted ${earlier + 1} times while the attempt ran`;
    endAttempt(ctx, { attemptId: attempt.id, trigger: 'crashed', error, actor });
    return 'crashed';
  }
  resumeAttempt(ctx, { attemptId: attempt.id, cause: 'runner_restart', prompt: RESTART_PROMPT, actor });
  return 'resumed';
}

/** What a hello says beyond its attempts. */
export interface ReconcileOptions {
  /** The runner holds events after the acknowledged position, which it replays once welcomed. */
  replayPending?: boolean | undefined;
  /** The hub was restored since this runner's last welcome, or its re-fences are still pending (afterRestore). */
  afterRestore?: boolean | undefined;
}

/** The statuses whose process a resume brings back. */
const RESUMABLE = new Set<Attempt['status']>(['starting', 'running', 'quota_wait']);

/** Whether the attempt's task, or for a lead the lead seat, still names it. */
function stillNamed(ctx: HubContext, attempt: Attempt): boolean {
  if (attempt.taskId === null) return getHubState(ctx).leadAgentId === attempt.agentId;
  return getTask(ctx, attempt.taskId).currentAttempt === attempt.id;
}

/**
 * The two rows after a restore (design 6.3), for an attempt the runner reports: one its task or the seat no longer
 * names ends superseded at once, and welcome.stop lists it; one still named waits for the replay, which cannot change
 * what names it, and is then re-fenced (reconcileAfterRestore). A holding attempt has no process to re-fence, and a
 * take-over in flight is the take-over's to finish: both go on to the other rows, and the next resume of a holding
 * one brings a fence of the new epoch. Null when no restore row applies.
 */
function decideAfterRestore(ctx: HubContext, attempt: Attempt): ReconcileAction | null {
  if (!stillNamed(ctx, attempt)) {
    endAttempt(ctx, { attemptId: attempt.id, trigger: 'superseded', actor: actorOf(attempt) });
    return 'superseded';
  }
  if (!RESUMABLE.has(attempt.status) || attempt.stopRequested?.cause === 'takeover') return null;
  return 'refence';
}

/**
 * Decides one open attempt by the first row of the table that matches, the restore rows first after a restore. ok:
 * the hello's state; while the runner is not ok, the resume row waits (X-36).
 */
function decide(
  ctx: HubContext,
  attempt: Attempt,
  live: LiveAttempt | undefined,
  ok: boolean,
  options: ReconcileOptions,
): ReconcileAction {
  if (options.afterRestore && live) {
    const restored = decideAfterRestore(ctx, attempt);
    if (restored !== null) return restored;
  }
  const actor = actorOf(attempt);
  const stop = attempt.stopRequested;
  if (gone(live) && stop) {
    if (stop.cause === 'takeover' && live.clone) return 'takeover';
    // A deferred stop completes too: the ending fails its submission and applies it, and a success the replay still
    // holds records only the branch head (design 6.13).
    return completeStop(ctx, attempt, options.replayPending);
  }
  // A take-over the runner no longer has ends as the take-over it was: its task waits for a hand-back from a ref.
  if (!live && stop?.cause === 'takeover') return completeStop(ctx, attempt, options.replayPending);
  if (live && !gone(live)) return 'kept';
  if (gone(live) && live.clone) {
    if (attempt.status === 'holding') return 'kept';
    return ok ? restartResume(ctx, attempt) : 'deferred';
  }
  if (!live && attempt.status === 'starting' && startPending(ctx, attempt.id)) {
    if (attempt.fence.epoch < hubEpoch(ctx)) restartAtNewFence(ctx, attempt);
    return 'resent';
  }
  if (attempt.status === 'holding') {
    updateAttempt(ctx, attempt.id, { resumable: false });
    return 'unresumable';
  }
  const error = live ? "the runner lost the attempt's clone" : 'the runner no longer had the attempt';
  endAttempt(ctx, { attemptId: attempt.id, trigger: 'crashed', error, actor });
  return 'crashed';
}

/** Why the runner must stop a reported attempt, or null when it is the runner's to keep. */
function stopReason(ctx: HubContext, runnerId: string, attemptId: string): string | null {
  const attempt = findAttempt(ctx, attemptId);
  if (!attempt) return 'the hub does not know this attempt';
  if (attempt.runnerId !== runnerId) return `the attempt runs on ${attempt.runnerId ?? 'no runner'}`;
  if (attempt.status === 'ended') return `the attempt ended (${attempt.endReason ?? 'unknown reason'})`;
  return null;
}

/**
 * Reconciliation on hello (design 6.3), in the hello transaction: each attempt the hub has open on the runner is
 * decided from what the hello reports about it (X-36), by the first row of the table that matches. After a restore,
 * superseded attempts end here, and the re-fences wait for the replay (reconcileAfterRestore). While the hello's state
 * is not ok, resumes wait for runner.state ok (resumeDeferred).
 * Then every reported attempt that is ended by now, unknown, or not this runner's goes to welcome.stop, and those that
 * ended lost bring their transcripts (onRunnerBack). Pending commands of the attempts that stay are sent again after
 * welcome, as every pending command is, and the runner's journal keeps it from running one twice.
 */
export function reconcileOnHello(
  ctx: HubContext,
  runnerId: string,
  hello: Pick<HelloMessage, 'attempts' | 'state'>,
  options: ReconcileOptions = {},
): ReconcileResult {
  const byId = new Map(hello.attempts.map((live) => [live.attemptId, live]));
  const open = listAttempts(ctx, { runner: runnerId, status: ['starting', 'running', 'quota_wait', 'holding'] });
  // Oldest first, so endings and resumes follow the order the attempts started in.
  const actions = [...open].reverse().map((attempt) => ({
    attemptId: attempt.id,
    action: decide(ctx, attempt, byId.get(attempt.id), hello.state === 'ok', options),
  }));
  setDeferredResumes(
    ctx,
    runnerId,
    actions.filter((entry) => entry.action === 'deferred').map((entry) => entry.attemptId),
  );
  const stop: WelcomeStop[] = [];
  for (const live of hello.attempts) {
    const reason = stopReason(ctx, runnerId, live.attemptId);
    if (reason !== null) stop.push({ attemptId: live.attemptId, reason });
  }
  onRunnerBack(ctx, runnerId, stop);
  return { stop, actions };
}

/**
 * runner.state ok after a hello that was not (X-36): the resumes that waited apply now, to the attempts still open on
 * the runner. One whose stop was requested meanwhile ends with that cause instead, as its process is gone.
 */
export function resumeDeferred(ctx: HubContext, runnerId: string): void {
  for (const attemptId of takeDeferredResumes(ctx, runnerId)) {
    const attempt = findAttempt(ctx, attemptId);
    if (!attempt || attempt.runnerId !== runnerId || !RESUMABLE.has(attempt.status)) continue;
    if (attempt.stopRequested) completeStop(ctx, attempt);
    else restartResume(ctx, attempt);
  }
}

/**
 * Whether a hello comes after a restore (design 6.3, X-1): its lastHubEpoch is below the hub's epoch, or an earlier
 * hello after the restore left the runner's re-fences pending, as a link that drops before the replay is complete does.
 */
export function isAfterRestore(ctx: HubContext, runnerId: string, lastHubEpoch: number | null): boolean {
  return (lastHubEpoch !== null && lastHubEpoch < hubEpoch(ctx)) || isRestorePending(ctx, runnerId);
}

/**
 * The re-fences after a restore (design 6.3, 6.14), once the runner's replay is complete (X-1), so that the events it
 * sent after the backup are applied first: each attempt the hello reported and decided 'refence' that is still open
 * on this runner, and can be resumed, gets resume_attempt with a new fence of the new epoch. It is cause restore, not
 * a runner-restart resume, so the restart limit does not count it. Then the runner is no longer restore-pending.
 * Returns the attempts re-fenced.
 */
export function reconcileAfterRestore(ctx: HubContext, runnerId: string, attemptIds: readonly string[]): string[] {
  return tx(ctx, () => {
    const refenced: string[] = [];
    for (const attemptId of attemptIds) {
      const attempt = findAttempt(ctx, attemptId);
      if (!attempt || attempt.runnerId !== runnerId || !RESUMABLE.has(attempt.status)) continue;
      if (attempt.stopRequested?.cause === 'takeover') continue;
      resumeAttempt(ctx, { attemptId, cause: 'restore', prompt: RESTART_PROMPT, actor: actorOf(attempt) });
      refenced.push(attemptId);
    }
    setRestorePending(ctx, runnerId, false);
    return refenced;
  });
}

/** Whether the attempt's transcript was asked for already. */
function transcriptAsked(ctx: HubContext, attemptId: string): boolean {
  const row = ctx.db
    .query(
      `SELECT 1 FROM runner_commands
       WHERE attempt_id = $attemptId AND kind = 'upload_transcript' AND status != 'cancelled'`,
    )
    .get({ attemptId });
  return row !== null;
}

/**
 * A runner back with attempts that ended lost while it was away (design 6.4, Lease expiry). welcome.stop names them,
 * so the runner stops each without a handoff turn and pushes its late work. The first time, each also gets
 * upload_transcript, and its task, while still ready and naming it, waits dispatchHoldMs for that late work.
 */
export function onRunnerBack(ctx: HubContext, runnerId: string, stop: readonly WelcomeStop[]): void {
  for (const { attemptId } of stop) {
    const attempt = findAttempt(ctx, attemptId);
    if (!attempt || attempt.runnerId !== runnerId || attempt.endReason !== 'lost') continue;
    if (transcriptAsked(ctx, attempt.id)) continue;
    enqueueCommand(ctx, runnerId, { kind: 'upload_transcript', attemptId: attempt.id });
    if (attempt.taskId === null) continue;
    const task = getTask(ctx, attempt.taskId);
    if (task.status === 'ready' && task.currentAttempt === attempt.id) {
      writeTask(ctx, task.id, { dispatchHoldUntil: ctx.now() + ctx.config.dispatchHoldMs });
    }
  }
}

/**
 * POST /api/runner/attempts/:id/transcript (design 6.16): the end of the attempt's transcript, from the runner that ran
 * it, for assembled handoff notes, which quote it. Only the owner of that runner may upload it.
 */
export function storeTranscriptTail(ctx: HubContext, user: string, attemptId: string, tail: string): void {
  tx(ctx, () => {
    const attempt = getAttempt(ctx, attemptId);
    const runner = attempt.runnerId === null ? null : findRunnerRow(ctx, attempt.runnerId);
    if (!runner || runner.owner !== user.toLowerCase()) {
      throw forbidden(`only the owner of the runner attempt ${attempt.id} ran on uploads its transcript`);
    }
    updateAttempt(ctx, attempt.id, { transcriptTail: tail });
  });
}

// ---------------------------------------------------------------------------
// Downtime and clock jumps (design 6.6 step 0, 6.14)
// ---------------------------------------------------------------------------

/** A gap of more than this many ticks since the last one is downtime: a hub freeze, a stop or a forward clock jump. */
const DOWNTIME_TICKS = 3;

/** What one clock check found. */
export interface ClockCheck {
  /** now − last_alive_at; negative after a backward clock step. */
  gapMs: number;
  /** The gap was downtime: the leases were extended by it and a recovery window started. */
  downtime: boolean;
  /** The recovery window was over, and this check closed it. */
  recoveryEnded: boolean;
}

/**
 * Extends every runner lease and every M1 task lease of a live claim by the gap, so that nobody loses work for the
 * time the hub could not hear from them.
 */
function extendLeases(ctx: HubContext, gapMs: number): void {
  ctx.db
    .query(
      `UPDATE attempts SET lease_expires_at = lease_expires_at + $gapMs
       WHERE status IN ('starting', 'running', 'quota_wait') AND lease_expires_at IS NOT NULL`,
    )
    .run({ gapMs });
  ctx.db
    .query(
      `UPDATE tasks SET lease_expires_at = lease_expires_at + $gapMs
       WHERE status IN ('claimed', 'working') AND lease_expires_at IS NOT NULL`,
    )
    .run({ gapMs });
}

/**
 * Step 0 of every tick, and the hub's start (design 6.6, 6.14): a gap of more than three ticks since last_alive_at is
 * downtime, so the leases are extended by the gap and a recovery window of recoveryMs starts, for runners to reconnect
 * and replay; a window that is over is closed (system.recovery_ended). A backward clock step is no downtime, and as
 * leases are times, it shortens none; an open window is cut back to end within recoveryMs of now, so that the step does
 * not stretch it. The first check after a restore moves restored_at to now. Then last_alive_at becomes now.
 */
export function checkClock(ctx: HubContext): ClockCheck {
  return tx(ctx, (emit) => {
    const now = ctx.now();
    const state = getHubState(ctx);
    const gapMs = now - state.lastAliveAt;
    const downtime = gapMs > DOWNTIME_TICKS * ctx.config.tickMs;
    let recoveryEnded = false;
    if (downtime) {
      extendLeases(ctx, gapMs);
      const until = now + ctx.config.recoveryMs;
      updateHubState(ctx, { recoveryUntil: until });
      emit({ type: 'system.recovery_started', actor: 'system', data: { gapMs, until } });
    } else if (state.recoveryUntil !== null && now >= state.recoveryUntil) {
      updateHubState(ctx, { recoveryUntil: null });
      emit({ type: 'system.recovery_ended', actor: 'system', data: {} });
      recoveryEnded = true;
    } else if (state.recoveryUntil !== null && gapMs < 0) {
      updateHubState(ctx, { recoveryUntil: Math.min(state.recoveryUntil, now + ctx.config.recoveryMs) });
    }
    // The first check after a restore, whose last_alive_at is the backup's: the time unknown agent tokens answer
    // attempt_refenced counts from the restored hub's start, not from the restore command, which may be long before.
    if (state.restoredAt !== null && state.restoredAt > state.lastAliveAt) updateHubState(ctx, { restoredAt: now });
    updateHubState(ctx, { lastAliveAt: now });
    return { gapMs, downtime, recoveryEnded };
  });
}

// ---------------------------------------------------------------------------
// The database lock (design 6.14): Bun has no flock, so a pid file with a liveness check
// ---------------------------------------------------------------------------

const lockFile = (dbPath: string): string => `${dbPath}.pid`;

/** Boot times that differ by at most this much are one boot: the one computed from the uptime moves by a second. */
const BOOT_SLACK_SECONDS = 60;

/**
 * This boot of the machine: Linux's boot id, or else the boot time in seconds, which macOS keeps when the clock is
 * set. A lock file of an earlier boot is stale whatever its pid names now, as pids start again at a reboot.
 */
function currentBoot(): string {
  try {
    return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  } catch {
    return String(Math.round(Date.now() / 1000 - uptime()));
  }
}

function sameBoot(a: string, b: string): boolean {
  const numeric = /^[0-9]+$/;
  if (numeric.test(a) && numeric.test(b)) return Math.abs(Number(a) - Number(b)) <= BOOT_SLACK_SECONDS;
  return a === b;
}

/** What <db>.pid holds for a process of this boot: its pid and the boot. */
export function dbLockRecord(pid: number): string {
  return `${pid} ${currentBoot()}\n`;
}

/** Whether a process with this pid runs; one of another user's that may not be signalled runs too. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** A lock file's text, or null when there is none. */
function readLock(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** The pid a lock file's text names for this boot, or null when it names none or was written in an earlier boot. */
function lockHolder(text: string | null): number | null {
  const match = text?.trim().match(/^([1-9][0-9]*) (\S+)$/);
  if (!match || !sameBoot(match[2] as string, currentBoot())) return null;
  return Number(match[1]);
}

/** A breaking file older than this was left by a process that died while it removed a stale lock. */
const BREAKING_STALE_MS = 10_000;

/**
 * Removes a lock file judged stale from its text, under <db>.pid.breaking, which one process at a time creates: so of
 * two processes that judged the same file stale, the later one finds the lock the earlier one put in its place and
 * leaves it. Nothing else replaces a stale file, so while it reads the same it is the one judged.
 */
function removeStale(path: string, text: string): void {
  const breaking = `${path}.breaking`;
  try {
    writeFileSync(breaking, `${process.pid}\n`, { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    try {
      if (Date.now() - statSync(breaking).mtimeMs > BREAKING_STALE_MS) rmSync(breaking, { force: true });
    } catch {
      // It went away meanwhile.
    }
    return;
  }
  try {
    if (readLock(path) === text) rmSync(path, { force: true });
  } finally {
    rmSync(breaking, { force: true });
  }
}

/**
 * Takes <db>.pid for this process (design 6.14): the hub keeps it while it runs, and a restore while it restores. A
 * file that names another live process of this boot is a refusal; one left by a process that is gone, by an earlier
 * boot, or naming no pid, is stale and replaced. One that names this process is its own lock already: main.ts takes it
 * before it opens the database, and startHub keeps it. The record is written to a file of this process's and linked
 * into place, so the lock file is never seen half written, and of two starts racing for it one fails.
 */
export function acquireDbLock(dbPath: string): void {
  if (dbPath === '' || dbPath === ':memory:') throw new Error('dbLock needs a database file, not an in-memory database');
  const path = lockFile(dbPath);
  const own = `${path}.${process.pid}`;
  for (let tries = 0; tries < 3; tries++) {
    writeFileSync(own, dbLockRecord(process.pid));
    try {
      linkSync(own, path);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    } finally {
      rmSync(own, { force: true });
    }
    const text = readLock(path);
    if (text === null) continue;
    const holder = lockHolder(text);
    if (holder === process.pid) return;
    if (holder !== null && processAlive(holder)) {
      throw new Error(`the database ${dbPath} is in use by process ${holder} (${path}); stop that hub first`);
    }
    removeStale(path, text);
  }
  throw new Error(`could not take ${path}: another process took it or is replacing a stale one; try again`);
}

/** Gives up <db>.pid, only while it names this process. */
export function releaseDbLock(dbPath: string): void {
  const path = lockFile(dbPath);
  if (lockHolder(readLock(path)) === process.pid) rmSync(path, { force: true });
}
