// Test-only ownership: environment markers plus recorded detached groups. macOS hides the environment of platform
// binaries, so group records also cover orphaned shells after their instrumented Bun parent has exited.
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { constants, tmpdir } from 'node:os';
import { parsePs, PS_COLUMNS, PS_ENV, sameProcess, type PsRow } from '../../runner/src/processes';

export const PROCESS_SCOPE = 'AGFLOW_TEST_PROCESS_SCOPE';
const GROUP_REGISTRY = 'AGFLOW_TEST_PROCESS_GROUP_REGISTRY';
interface GroupRecord { scope: string; pid: number; lstart: string }
export interface CleanupHost {
  snapshot(): PsRow[];
  signal(pid: number, signal: NodeJS.Signals): void;
  groups?(): ReadonlyMap<string, GroupRecord>;
  forgetGroup?(id: string): void;
}

function inScope(owner: string, scope: string): boolean {
  return owner === scope || owner.startsWith(`${scope}.`);
}

function marked(row: PsRow, scope: string): boolean {
  return row.command.split(/\s+/).some(word => {
    const prefix = `${PROCESS_SCOPE}=`;
    if (!word.startsWith(prefix)) return false;
    const value = word.slice(prefix.length);
    return inScope(value, scope);
  });
}

function sameOwnedProcess(before: PsRow, now: PsRow, scope: string): boolean {
  return sameProcess(before, now) && before.pgid === now.pgid &&
    (!marked(before, scope) || marked(now, scope));
}

function ownedIn(rows: PsRow[], scope: string, ownPid: number, host: CleanupHost,
  records: ReadonlyMap<string, GroupRecord>, known: Map<number, PsRow>) {
  const live = rows.filter(row => row.pid > 1 && row.pid !== ownPid && !row.stat.startsWith('Z'));
  const recorded = new Set<number>();
  for (const [id, group] of records) {
    if (!inScope(group.scope, scope)) continue;
    const members = rows.filter(row => row.pgid === group.pid && !row.stat.startsWith('Z'));
    const leader = rows.find(row => row.pid === group.pid);
    const start = Date.parse(`${group.lstart} GMT`);
    // An existing group reserves its pgid, even without its leader. Retire the record as soon as it empties;
    // also reject reused leaders and members predating the launch. Never claim our own group.
    if (group.pid <= 1 || !members.length || members.some(row => row.pid === ownPid) ||
      (leader && (!sameProcess(leader, group) || leader.pgid !== group.pid)) ||
      members.some(row => !(Date.parse(`${row.lstart} GMT`) >= start))) {
      host.forgetGroup?.(id);
      continue;
    }
    for (const row of members) recorded.add(row.pid);
  }
  const owned = new Map(live.filter(row => marked(row, scope) ||
    recorded.has(row.pid) ||
    (known.has(row.pid) && sameOwnedProcess(known.get(row.pid)!, row, scope))).map(row => [row.pid, row]));
  for (;;) {
    const children = live.filter(row => !owned.has(row.pid) && owned.has(row.ppid));
    if (!children.length) return owned;
    for (const row of children) owned.set(row.pid, row);
  }
}

/** Freeze before the final descendant scan, then kill groups only when all their live members belong to us. */
export function killOwnedProcesses(scope: string, host: CleanupHost, ownPid = process.pid): number {
  const scan = (known = new Map<number, PsRow>()): Map<number, PsRow> => {
    for (;;) {
      const before = new Map(host.groups?.());
      const rows = host.snapshot();
      const after = new Map(host.groups?.());
      // A writer may publish after ps captured the process table. Do not retire that new record using old rows.
      if ([...after].some(([id, group]) => inScope(group.scope, scope) && !before.has(id))) continue;
      return ownedIn(rows, scope, ownPid, host, after, known);
    }
  };
  let owned = scan();
  if (!owned.size) return 0;
  const frozen = new Set<string>();
  for (;;) {
    const fresh = host.snapshot();
    const current = new Map(fresh.map(row => [row.pid, row]));
    for (const row of owned.values()) {
      const now = current.get(row.pid);
      if (!now || !sameOwnedProcess(row, now, scope)) continue;
      const key = `${row.pid}:${row.lstart}`;
      if (frozen.has(key)) continue;
      host.signal(row.pid, 'SIGSTOP');
      frozen.add(key);
    }
    const next = scan(owned);
    owned = next;
    if ([...next.values()].every(row => frozen.has(`${row.pid}:${row.lstart}`))) break;
  }
  const rows = host.snapshot();
  const current = new Map(rows.map(row => [row.pid, row]));
  const valid = new Map([...owned].filter(([pid, row]) => {
    const now = current.get(pid);
    return now && sameOwnedProcess(row, now, scope);
  }));
  const groups = new Set<number>();
  for (const row of valid.values()) {
    const members = rows.filter(member => member.pgid === row.pgid && !member.stat.startsWith('Z'));
    if (row.pgid > 1 && members.every(member => valid.has(member.pid))) {
      if (!groups.has(row.pgid)) host.signal(-row.pgid, 'SIGKILL');
      groups.add(row.pgid);
    } else {
      host.signal(row.pid, 'SIGKILL');
    }
  }
  return valid.size;
}

const rawSpawn = Bun.spawn.bind(Bun);
const rawSpawnSync = Bun.spawnSync.bind(Bun);
const rawServe = Bun.serve.bind(Bun);
const inherited = process.env[PROCESS_SCOPE];
const rootScope = `${inherited ? `${inherited}.` : ''}${randomUUID()}`;
interface Scope { id: string; closed: boolean }
const root: Scope = { id: rootScope, closed: false };
const context = new AsyncLocalStorage<Scope>();
function activeScope(): Scope { return context.getStore() ?? root; }
function openScope(): string {
  const current = activeScope();
  if (current.closed) throw new Error('test scope already closed: refusing to start a late resource');
  return current.id;
}
let installed = false;
let exitHooked = false;
const dirty = new Set<string>();
const children = new Map<Bun.Subprocess, string>();
const resources = new Map<() => void | Promise<unknown>, string>();
let registry = process.env[GROUP_REGISTRY];
const inheritedRegistry = registry !== undefined;
function groupRegistry(): string {
  return registry ??= mkdtempSync(join(tmpdir(), 'agflow-test-groups-'));
}

function groupRecords(): Map<string, GroupRecord> {
  if (!registry) return new Map();
  return new Map(readdirSync(registry).filter(name => name.endsWith('.json')).flatMap(name => {
    try { return [[name, JSON.parse(readFileSync(join(registry!, name), 'utf8')) as GroupRecord]]; }
    catch (error) {
      // Another test process may retire the same shared record between readdir and readFile.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }));
}

function recordDetached(pid: number, scope: string, started: number): void {
  const rows = system.snapshot();
  const leader = rows.find(row => row.pid === pid);
  const members = rows.filter(row => row.pgid === pid && !row.stat.startsWith('Z'));
  if (!members.length) return;
  // A very short-lived leader may already have exited. Its spawn time (rounded like ps to seconds) is then
  // the lower bound for surviving members; a live leader always supplies the exact ps identity.
  const lstart = leader?.lstart ?? new Date(started).toUTCString().replace(',', '').replace(' GMT', '');
  const record: GroupRecord = { scope, pid, lstart };
  const file = join(groupRegistry(), randomUUID());
  writeFileSync(file, JSON.stringify(record), { mode: 0o600 });
  renameSync(file, `${file}.json`); // Readers never see a partial record, including when writers run concurrently.
}

/** Also used by the Node HTTP refusing proxy; Bun servers are enrolled by the preload automatically. */
export function registerTestCleanup(close: () => void | Promise<unknown>): () => void {
  if (!installed) return () => {};
  resources.set(close, openScope());
  return () => { resources.delete(close); };
}

const system: CleanupHost = {
  groups: groupRecords,
  forgetGroup(id) { rmSync(join(registry!, id), { force: true }); },
  snapshot() {
    // Never print this output: `ps e` contains environments. A clean ps environment keeps the scanner unmarked.
    const result = rawSpawnSync(['ps', 'eww', '-axo', PS_COLUMNS], {
      env: { PATH: process.env.PATH, ...PS_ENV }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    });
    if (result.exitCode !== 0) throw new Error(`test process cleanup: ps exited ${result.exitCode}`);
    return parsePs(result.stdout.toString());
  },
  signal(pid, signal) {
    try { process.kill(pid, signal); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  },
};

function optionsFor(command: string[], options: Record<string, unknown>) {
  const scope = openScope();
  const env = { ...(options.env as NodeJS.ProcessEnv | undefined ?? process.env),
    [PROCESS_SCOPE]: scope, [GROUP_REGISTRY]: groupRegistry() };
  let cmd = command;
  // Reinstall only the spawn instrumentation in child Bun programs. No test hooks or exit cleanup run there:
  // deliberately crashing an agent/runner must still exercise the production orphan recovery paths.
  if (command[0] === process.execPath || basename(command[0] ?? '') === 'bun') {
    const preload = ['--preload', join(import.meta.dir, 'process-cleanup-child.ts')];
    const sub = command[1] ?? '';
    // `bun test|run` take the flag after the subcommand; other subcommands (install, x, build...) run no user code.
    if (sub === 'test' || sub === 'run') cmd = [command[0]!, sub, ...preload, ...command.slice(2)];
    else if (/^[a-z]+$/.test(sub) && !/\.[a-z]+$/.test(sub) && sub !== '') cmd = command;
    else cmd = [command[0]!, ...preload, ...command.slice(1)];
  }
  dirty.add(scope);
  return { ...options, detached: options.detached === true, cmd, env };
}

/** Installed once by the test preload, and in child Bun programs to preserve ownership through clean envs. */
export function installProcessTracking(): void {
  if (installed) return;
  installed = true;
  Bun.spawn = ((command: string[] | Record<string, unknown>, options: Record<string, unknown> = {}) => {
    const input = Array.isArray(command) ? optionsFor(command, options) :
      optionsFor(command.cmd as string[], command);
    const started = Date.now();
    const proc = rawSpawn(input.cmd, input);
    children.set(proc, activeScope().id);
    void proc.exited.finally(() => children.delete(proc));
    if (input.detached) recordDetached(proc.pid, activeScope().id, started);
    return proc;
  }) as typeof Bun.spawn;
  Bun.spawnSync = ((command: string[] | Record<string, unknown>, options: Record<string, unknown> = {}) => {
    const input = Array.isArray(command) ? optionsFor(command, options) :
      optionsFor(command.cmd as string[], command);
    const started = Date.now();
    const result = rawSpawnSync(input.cmd, input);
    if (input.detached) recordDetached(result.pid, activeScope().id, started);
    return result;
  }) as typeof Bun.spawnSync;
  Bun.serve = ((options: Parameters<typeof Bun.serve>[0]) => {
    openScope();
    const server = rawServe(options);
    registerTestCleanup(() => server.stop(true));
    return server;
  }) as typeof Bun.serve;
}

export function beginTestProcessScope(): void {
  context.enterWith({ id: `${rootScope}.${randomUUID()}`, closed: false });
}

/** Hooks await reaping as well as killing. A timeout is a cleanup failure, never silently ignored. */
export async function cleanupTestProcesses(all = false): Promise<void> {
  const current = all ? root : activeScope();
  const finished = current.id;
  current.closed = true;
  try {
    const closing: Promise<unknown>[] = [];
    for (const [close, owner] of resources) {
      if (!all && owner !== finished) continue;
      resources.delete(close);
      closing.push(Promise.resolve().then(close));
    }
    const closed = Promise.allSettled(closing);
    if (all ? dirty.size > 0 : dirty.has(finished)) {
      const deadline = Date.now() + 3000;
      while (killOwnedProcesses(finished, system)) {
        if (Date.now() >= deadline) throw new Error('test processes survived SIGKILL');
        await Bun.sleep(10);
      }
      await Promise.all([...children].filter(([, owner]) => all || owner === finished).map(([proc]) => proc.exited));
      if (all) dirty.clear();
      else dirty.delete(finished);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const results = await Promise.race([closed, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('test resources did not close')), 3000);
      })]);
      const failures = results.filter(result => result.status === 'rejected');
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'test cleanup failed');
    } finally { clearTimeout(timer); }
  } finally {
    context.enterWith(root);
  }
}

/** Last resort for failed hooks, process.exit and signals. No promises can run in an exit listener. */
export function installProcessExitCleanup(): void {
  if (exitHooked) return;
  exitHooked = true;
  const cleanup = () => {
    if (!dirty.size) return;
    const deadline = Date.now() + 3000;
    try {
      while (killOwnedProcesses(rootScope, system)) {
        if (Date.now() >= deadline) throw new Error('test processes survived SIGKILL at exit');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    } catch (error) {
      console.error('test process cleanup failed:', error);
      process.exitCode = 1;
    }
  };
  process.on('exit', () => {
    cleanup();
    if (registry && !inheritedRegistry) rmSync(registry, { recursive: true, force: true });
  });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.once(signal, () => {
      cleanup();
      process.exit(128 + constants.signals[signal]);
    });
  }
}
