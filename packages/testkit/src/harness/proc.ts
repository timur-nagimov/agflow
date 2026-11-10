// Process control for the e2e faults (design 1, 7.4): freeze a runner's whole tree as a closed lid does, signal one
// process group, find what still runs in a directory, wait for a process to go. The ps and lsof readers are M2b's
// (X-42); only this file follows their names, and it adds the tree walk, the signals and the waits.
import { realpathSync } from 'node:fs';
import { constants } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import {
  findCloneProcesses,
  PS_COLUMNS,
  PS_ENV,
  parsePs,
  listProcesses as psRows,
  type PsRow,
} from '@agflow/runner/src/processes';

/** One process as ps shows it: pid, ppid, pgid, stat (T when stopped, Z for a zombie), lstart and command. */
export type ProcessInfo = PsRow;

/** Every process, or only the given pids, from one ps call. */
export function listProcesses(pids?: readonly number[]): Promise<ProcessInfo[]> {
  return psRows(pids);
}

/** True while the pid runs or is stopped; a zombie, exited but not yet reaped, counts as gone. */
export async function isAlive(pid: number): Promise<boolean> {
  const row = (await listProcesses([pid])).find((candidate) => candidate.pid === pid);
  return row !== undefined && !row.stat.startsWith('Z');
}

/** Every live descendant of pid in one ps snapshot, children before grandchildren; pid itself is left out. */
export async function descendantsOf(pid: number): Promise<ProcessInfo[]> {
  return descendantsIn(await listProcesses(), pid);
}

function descendantsIn(rows: ProcessInfo[], root: number): ProcessInfo[] {
  const children = new Map<number, ProcessInfo[]>();
  for (const row of rows) {
    if (row.stat.startsWith('Z')) continue;
    const siblings = children.get(row.ppid);
    if (siblings) siblings.push(row);
    else children.set(row.ppid, [row]);
  }
  const found: ProcessInfo[] = [];
  const queue = [...(children.get(root) ?? [])];
  const seen = new Set([root]);
  for (let row = queue.shift(); row !== undefined; row = queue.shift()) {
    if (seen.has(row.pid)) continue;
    seen.add(row.pid);
    found.push(row);
    queue.push(...(children.get(row.pid) ?? []));
  }
  return found;
}

/** Sends a signal to one pid; false when it is already gone. */
function signalPid(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

/**
 * Stops pid and everything under it, as a closed lid does. The root stops first, so it cannot start or reap anything
 * while its descendants are stopped one by one (each pid, not each group: agents lead groups of their own). It walks
 * the tree again until a pass finds nothing new, and gives the stopped pids, the root first.
 */
export async function freezeTree(pid: number): Promise<number[]> {
  if (!signalPid(pid, 'SIGSTOP')) throw new Error(`cannot freeze process ${pid}: it is not running`);
  const frozen = [pid];
  for (;;) {
    const fresh = (await descendantsOf(pid)).filter((row) => !frozen.includes(row.pid));
    if (fresh.length === 0) return frozen;
    for (const row of fresh) {
      if (signalPid(row.pid, 'SIGSTOP')) frozen.push(row.pid);
    }
  }
}

/** Resumes pid's descendants, then pid itself, and gives the resumed pids. */
export async function thawTree(pid: number): Promise<number[]> {
  const thawed: number[] = [];
  for (const row of (await descendantsOf(pid)).reverse()) {
    if (signalPid(row.pid, 'SIGCONT')) thawed.push(row.pid);
  }
  if (signalPid(pid, 'SIGCONT')) thawed.push(pid);
  return thawed;
}

/**
 * Signals every member of a process group, such as one attempt's agent. Gives false when the group is gone. Groups 0
 * and 1 and the test process's own group are refused: those signals would reach the test itself or every process the
 * user owns.
 */
export async function signalGroup(pgid: number, signal: NodeJS.Signals): Promise<boolean> {
  const own = (await listProcesses([process.pid])).find((row) => row.pid === process.pid)?.pgid;
  if (!Number.isInteger(pgid) || pgid <= 1 || pgid === own) {
    throw new Error(`refusing to signal group ${pgid}: it would reach the test process or every user process`);
  }
  try {
    process.kill(-pgid, signal);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // EPERM: on macOS, a group whose members are all zombies.
    if (code === 'ESRCH' || code === 'EPERM') return false;
    throw error;
  }
}

/**
 * The path with its nearest existing ancestor resolved: lsof reports resolved paths, even for a cwd that was removed,
 * so /tmp/x/gone must become /private/tmp/x/gone on macOS.
 */
function resolveExisting(path: string): string {
  const missing: string[] = [];
  for (let current = path; ; current = dirname(current)) {
    try {
      return join(realpathSync(current), ...missing.reverse());
    } catch {
      if (dirname(current) === current) return path;
      missing.push(basename(current));
    }
  }
}

/**
 * The user's processes whose cwd is dir or inside it, through M2b's clone search (X-42), zombies left out. dir may be
 * given by its /tmp or its /private/tmp path, and may already be removed while a process still has its cwd there.
 */
export async function processesInDir(dir: string): Promise<ProcessInfo[]> {
  const found = await findCloneProcesses(isAbsolute(dir) ? resolveExisting(dir) : dir);
  if (found.skipped !== null) throw new Error(found.skipped);
  return found.processes.filter((row) => !row.stat.startsWith('Z'));
}

export interface WaitOptions {
  /** 10 s by default. */
  timeoutMs?: number;
  /** 50 ms by default. */
  intervalMs?: number;
}

/** Resolves once pid is gone (a zombie counts as gone); rejects, naming the pid, after the timeout. */
export async function waitUntilGone(pid: number, options: WaitOptions = {}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const deadline = Date.now() + timeoutMs;
  while (await isAlive(pid)) {
    if (Date.now() >= deadline) throw new Error(`process ${pid} is still running after ${timeoutMs} ms`);
    await Bun.sleep(options.intervalMs ?? 50);
  }
}

// --- Tracked processes ----------------------------------------------------------------------------------------------

/** The hub and runner processes the harness started that still run. */
const tracked = new Set<Bun.Subprocess>();
let hooked = false;

/**
 * Tracks a hub or runner process until it exits. If the test process ends first (afterAll never ran: Ctrl-C, SIGTERM
 * or SIGHUP, a crash, a timed-out hook), an exit hook kills it and everything under it, frozen trees included: spawned
 * processes outlive bun, and a SIGSTOPped tree would stay stopped for good.
 */
export function trackProcess(proc: Bun.Subprocess): void {
  tracked.add(proc);
  void proc.exited.then(() => tracked.delete(proc));
  if (hooked) return;
  hooked = true;
  process.on('exit', killTracked);
  for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.once(name, () => {
      killTracked();
      process.exit(128 + constants.signals[name]);
    });
  }
}

/**
 * Synchronously, as an exit hook must: from one ps snapshot, SIGCONT and SIGKILL every descendant of a tracked
 * process, then SIGKILL the tracked process itself.
 */
function killTracked(): void {
  const live = [...tracked].filter((proc) => proc.exitCode === null && proc.signalCode === null);
  if (live.length === 0) return;
  const ps = Bun.spawnSync(['ps', '-A', '-o', PS_COLUMNS], { env: { ...process.env, ...PS_ENV } });
  const rows = parsePs(ps.stdout.toString());
  for (const proc of live) {
    for (const row of descendantsIn(rows, proc.pid)) {
      quietly(row.pid, 'SIGCONT');
      quietly(row.pid, 'SIGKILL');
    }
    quietly(proc.pid, 'SIGCONT');
    quietly(proc.pid, 'SIGKILL');
  }
}

function quietly(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Gone already, or never ours.
  }
}

