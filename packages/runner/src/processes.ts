// Process tools (design 7.4): identities, recorded groups, descendant snapshots, clone sweeps and bounded pipe
// drains. macOS PIDs wrap at 99,999, so a group is signalled only while a process recorded in it still has the same
// pid and start time. Every ps and lsof call is async, so heartbeats never stall behind one. The parsers are pure
// and exported for M2g's harness (X-42).
import { realpathSync } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import type { AttemptStore, ProcessRecord } from './attempt-store';

/** A process as ps names it: lstart, ps's start time to the second, tells a reused pid apart. */
export interface ProcessIdentity {
  pid: number;
  pgid: number;
  /** ps's lstart in the C locale and UTC (PS_ENV), such as "Thu Oct  2 13:04:14 2026". */
  lstart: string;
}

/** One row of `ps -o PS_COLUMNS` run with PS_ENV; listProcesses gives these. */
export interface PsRow extends ProcessIdentity {
  ppid: number;
  stat: string;
  command: string;
}

/** The ps columns parsePs reads, in its order. */
export const PS_COLUMNS = 'pid=,ppid=,pgid=,stat=,lstart=,command=';

/**
 * The environment every ps call adds to its own: the C locale and UTC make lstart one fixed format, the same for the
 * service, a terminal's agflow and M2g's harness. Without it parsePs reads no rows in another locale, and in another
 * time zone lstart never matches a recorded identity.
 */
export const PS_ENV: Readonly<Record<'LC_ALL' | 'TZ', string>> = { LC_ALL: 'C', TZ: 'UTC' };

// pid, ppid, pgid, stat, then lstart ("Thu Oct  2 13:04:14 2026") and the command, which may hold any spaces.
const LSTART = '[A-Z][a-z]{2} [A-Z][a-z]{2} [ \\d]\\d \\d{2}:\\d{2}:\\d{2} \\d{4}';
const PS_ROW = new RegExp(`^\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(\\S+)\\s+(${LSTART})(?: +(.*))?$`);

/**
 * Reads the output of `ps -o PS_COLUMNS` run with PS_ENV (listProcesses runs it); lines it cannot read are skipped,
 * so output in another locale gives no rows.
 */
export function parsePs(output: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of output.split('\n')) {
    const match = line.match(PS_ROW);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      stat: match[4] as string,
      lstart: match[5] as string,
      command: (match[6] ?? '').trimEnd(),
    });
  }
  return rows;
}

async function run(argv: string[], env: Record<string, string | undefined> = process.env): Promise<string> {
  const proc = Bun.spawn(argv, { env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  // Both pipes are read, because Bun buffers unread pipes without limit.
  const [stdout] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  return stdout;
}

/** One ps call (about 17 ms) with PS_COLUMNS and PS_ENV: every process, or only the given pids. */
export async function listProcesses(pids?: readonly number[]): Promise<PsRow[]> {
  if (pids?.length === 0) return [];
  const select = pids ? ['-p', pids.join(',')] : ['-A'];
  return parsePs(await run(['ps', ...select, '-o', PS_COLUMNS], { ...process.env, ...PS_ENV }));
}

/** The pid's identity now, or null when no such process exists. */
export async function processIdentity(pid: number): Promise<ProcessIdentity | null> {
  const row = (await listProcesses([pid])).find((candidate) => candidate.pid === pid);
  return row ? { pid: row.pid, pgid: row.pgid, lstart: row.lstart } : null;
}

/** True when both name the same process: the same pid, started at the same time. */
export function sameProcess(a: Pick<ProcessIdentity, 'pid' | 'lstart'>, b: Pick<ProcessIdentity, 'pid' | 'lstart'>) {
  return a.pid === b.pid && a.lstart === b.lstart;
}

function signal(target: number, name: NodeJS.Signals): boolean {
  try {
    process.kill(target, name);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

/**
 * Signals the group of a recorded process (its leader, or a member a snapshot found) while that process still has
 * the same pid, start time and group. Gives whether it signalled. Groups 0 and 1 are never signalled: kill(0) is the
 * caller's own group and kill(-1) every process the user owns.
 */
export async function killGroup(identity: ProcessIdentity, name: NodeJS.Signals = 'SIGKILL'): Promise<boolean> {
  if (identity.pgid <= 1) return false;
  const now = await processIdentity(identity.pid);
  if (!now || !sameProcess(now, identity) || now.pgid !== identity.pgid) return false;
  return signal(-identity.pgid, name);
}

/** Signals one process while it still has the same pid and start time. */
export async function killProcess(identity: ProcessIdentity, name: NodeJS.Signals = 'SIGKILL'): Promise<boolean> {
  if (identity.pid <= 1) return false;
  const now = await processIdentity(identity.pid);
  if (!now || !sameProcess(now, identity)) return false;
  return signal(identity.pid, name);
}

/** Records a process group in the attempt's registry, before the agent's first output is read (design 7.4). */
export function recordGroup(
  store: AttemptStore,
  attemptId: string,
  clone: string | null,
  identity: ProcessIdentity,
): ProcessRecord {
  const record = { attemptId, pid: identity.pid, pgid: identity.pgid, lstart: identity.lstart, clone };
  store.recordProcess(record);
  return record;
}

/**
 * One attempt's descendants and their groups (design 7.4, "Descendant snapshots"). Each snapshot walks the process
 * tree from the attempt's recorded processes and from every process it saw before, so a group whose members were
 * reparented to launchd is still known through those members. A member counts only while its pid and start time
 * match, so a reused pid is never adopted; a group with no such member left is forgotten.
 */
export class DescendantTracker {
  // pgid -> pid -> lstart of the members seen.
  private members = new Map<number, Map<number, string>>();

  constructor(private readonly list: () => Promise<PsRow[]> = () => listProcesses()) {}

  async snapshot(roots: readonly ProcessIdentity[]): Promise<void> {
    const rows = await this.list();
    const byPid = new Map(rows.map((row) => [row.pid, row]));
    const children = new Map<number, PsRow[]>();
    for (const row of rows) {
      const siblings = children.get(row.ppid);
      if (siblings) siblings.push(row);
      else children.set(row.ppid, [row]);
    }
    const seenBefore = [...this.members.values()].flatMap((group) =>
      [...group].map(([pid, lstart]) => ({ pid, lstart })),
    );
    const queue = [...roots, ...seenBefore].flatMap((known) => {
      const row = byPid.get(known.pid);
      return row && sameProcess(row, known) ? [row] : [];
    });
    const next = new Map<number, Map<number, string>>();
    const seen = new Set<number>();
    while (queue.length > 0) {
      const row = queue.shift() as PsRow;
      if (seen.has(row.pid)) continue;
      seen.add(row.pid);
      const group = next.get(row.pgid) ?? new Map<number, string>();
      group.set(row.pid, row.lstart);
      next.set(row.pgid, group);
      queue.push(...(children.get(row.pid) ?? []));
    }
    this.members = next;
  }

  /** One identity per known group, for killGroup: its leader when the leader is still alive, else a member. */
  groups(): ProcessIdentity[] {
    return [...this.members]
      .sort(([a], [b]) => a - b)
      .map(([pgid, group]) => {
        const lstart = group.get(pgid);
        if (lstart !== undefined) return { pid: pgid, pgid, lstart };
        const [pid, memberStart] = [...group].sort(([a], [b]) => a - b)[0] as [number, string];
        return { pid, pgid, lstart: memberStart };
      });
  }
}

/** Reads `lsof -Fpn` output (p, f and n records) into each process's cwd; lsof gives resolved paths. */
export function parseLsofCwds(output: string): { pid: number; cwd: string }[] {
  const result: { pid: number; cwd: string }[] = [];
  let pid: number | null = null;
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid !== null && Number.isInteger(pid)) {
      result.push({ pid, cwd: line.slice(1) });
      pid = null;
    }
  }
  return result;
}

export interface SweepResult {
  /** The pids signalled. */
  killed: number[];
  /** Why no sweep ran, such as a missing lsof. */
  skipped: string | null;
}

function inside(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * Ladder step 4 (design 7.4): finds the user's processes whose cwd is inside the clone with
 * `lsof -a -d cwd -u <uid> -Fpn` and kills each one after an identity check. The clone must be an absolute path at
 * least two levels deep: a relative one would resolve against the runner's cwd, which is / under launchd, and a sweep
 * of / kills every process of the owner.
 */
export async function sweepCloneProcesses(
  clone: string,
  options: { signal?: NodeJS.Signals; lsof?: string } = {},
): Promise<SweepResult> {
  const lsof = options.lsof ?? 'lsof';
  if (!isAbsolute(clone)) throw new Error(`refusing to sweep a clone path that is not absolute: '${clone}'`);
  let root: string;
  try {
    root = realpathSync(clone);
  } catch {
    root = resolve(clone);
  }
  if (root.split(sep).filter(Boolean).length < 2) {
    throw new Error(`refusing to sweep processes under ${root}: too wide for a clone`);
  }
  let output: string;
  try {
    output = await run([lsof, '-w', '-a', '-d', 'cwd', '-u', String(process.getuid?.() ?? 0), '-Fpn']);
  } catch {
    return { killed: [], skipped: `lsof is not available (${lsof})` };
  }
  const found = parseLsofCwds(output).filter((entry) => inside(entry.cwd, root) && entry.pid !== process.pid);
  const pids = [...new Set(found.map((entry) => entry.pid))];
  const killed: number[] = [];
  for (const row of await listProcesses(pids)) {
    if (await killProcess(row, options.signal ?? 'SIGKILL')) killed.push(row.pid);
  }
  return { killed, skipped: null };
}

export interface DrainResult {
  /** Bytes read from the pipe. */
  bytes: number;
  /** Bytes written to the log. */
  kept: number;
}

/**
 * Reads a child's pipe to its end and appends at most maxBytes of it to the log, then a truncation note. It keeps
 * reading past the bound, so the child never blocks on a full pipe and Bun never buffers it. The log is opened for
 * appending, so the runner's own lines may share it.
 */
export async function drainToLog(
  stream: AsyncIterable<Uint8Array | string> | null,
  logPath: string,
  options: { maxBytes: number },
): Promise<DrainResult> {
  const result: DrainResult = { bytes: 0, kept: 0 };
  if (!stream) return result;
  await mkdir(dirname(logPath), { recursive: true });
  const file = await open(logPath, 'a');
  let noted = false;
  try {
    for await (const chunk of stream) {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      result.bytes += bytes.length;
      const room = options.maxBytes - result.kept;
      if (room > 0) {
        const part = bytes.subarray(0, room);
        await file.write(part);
        result.kept += part.length;
      }
      if (bytes.length > room && !noted) {
        noted = true;
        await file.write(`\n[agflow: output truncated after ${options.maxBytes} bytes]\n`);
      }
    }
  } catch {
    // A pipe that errors (its process killed mid-write) ends the drain like its end would.
  } finally {
    await file.close();
  }
  return result;
}

/**
 * Waits for a promise at most ms. A stop waits for the agent's pipes this way, because an escaped process that
 * inherited them can hold them open long after the agent exited.
 */
export async function boundedWait<T>(
  promise: Promise<T>,
  ms: number,
): Promise<{ done: true; value: T } | { done: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ done: false }>((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout({ done: false }), ms);
  });
  try {
    return await Promise.race([promise.then((value) => ({ done: true as const, value })), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
