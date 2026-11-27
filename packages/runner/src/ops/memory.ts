// Admission only: never signal a running agent. Reservations are growth headroom, in addition to its current RAM.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { freemem, totalmem } from 'node:os';
import { dirname, posix } from 'node:path';

export const MEMORY_GB = 1_000_000_000;
export const DEFAULT_MEMORY_RESERVE_GB = 2;
export const DEFAULT_MEMORY_PER_AGENT_GB = 2;

export interface MemorySample {
  totalBytes: number;
  availableBytes: number;
}

type Read = (path: string) => string;
const read: Read = (path) => readFileSync(path, 'utf8');

function valid(sample: MemorySample): boolean {
  return (
    Number.isSafeInteger(sample.totalBytes) && sample.totalBytes > 0 &&
    Number.isSafeInteger(sample.availableBytes) && sample.availableBytes >= 0 &&
    sample.availableBytes <= sample.totalBytes
  );
}

export function parseMeminfo(text: string): MemorySample | null {
  const value = (key: string) => Number(text.match(new RegExp(`^${key}:\\s+(\\d+) kB$`, 'm'))?.[1]) * 1024;
  const sample = { totalBytes: value('MemTotal'), availableBytes: value('MemAvailable') };
  return valid(sample) ? sample : null;
}

export function parseVmStat(text: string, totalBytes: number): MemorySample | null {
  const pageSize = Number(text.match(/^Mach Virtual Memory Statistics: \(page size of (\d+) bytes\)$/m)?.[1]);
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0) return null;
  const pages = ['free', 'inactive', 'purgeable', 'speculative'].reduce((sum, kind) =>
    sum + Number(text.match(new RegExp(`^Pages ${kind}:\\s+(\\d+)\\.$`, 'm'))?.[1]), 0);
  const sample = { totalBytes, availableBytes: pages * pageSize };
  return valid(sample) ? sample : null;
}

const unescapeMount = (path: string) =>
  path.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));

/** Apply every visible ancestor's cgroup limit, including a parent shared with other processes. No swap credit. */
export function linuxMemory(readFile: Read): MemorySample | null {
  const sample = parseMeminfo(readFile('/proc/meminfo'));
  if (!sample) return null;
  const memberships = readFile('/proc/self/cgroup').trim().split('\n');
  const mounts = readFile('/proc/self/mountinfo').trim().split('\n');
  for (const line of memberships) {
    const match = line.match(/^\d+:([^:]*):(\/.*)$/);
    if (!match) continue;
    const v2 = match[1] === '';
    if (!v2 && !match[1].split(',').includes('memory')) continue;
    const group = match[2];
    let found = false;
    for (const mount of mounts) {
      const [before, after] = mount.split(' - ');
      const fields = before.split(' ');
      const [type, , flags = ''] = (after ?? '').split(' ');
      if (v2 ? type !== 'cgroup2' : type !== 'cgroup' || !flags.split(',').includes('memory')) continue;
      const root = unescapeMount(fields[3] ?? '');
      const point = unescapeMount(fields[4] ?? '');
      if (!point.startsWith('/') || !(root === '/' || group === root || group.startsWith(root + '/'))) continue;
      // Do not let a cgroup namespace's inaccessible ../ membership escape the mount.
      const relative = root === '/' ? group.slice(1) : group.slice(root.length).replace(/^\//, '');
      if (relative.split('/').includes('..')) continue;
      let directory = posix.join(point, relative);
      found = true;
      for (;;) {
        let limit: string | null = null;
        try {
          limit = readFile(posix.join(directory, v2 ? 'memory.max' : 'memory.limit_in_bytes')).trim();
        } catch (error) {
          // A v2 root (or a cgroup without the memory controller) has no memory.max.
          if (!v2 || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        if (limit !== null && limit !== 'max') {
          if (!/^\d+$/.test(limit)) return null;
          const maximum = Number(limit);
          // v1's unlimited sentinel exceeds safe integers; a limit above host RAM cannot constrain it.
          if (Number.isSafeInteger(maximum)) {
            const usage = readFile(posix.join(directory, v2 ? 'memory.current' : 'memory.usage_in_bytes')).trim();
            if (!/^\d+$/.test(usage)) return null;
            const current = Number(usage);
            if (!Number.isSafeInteger(current)) return null;
            sample.totalBytes = Math.min(sample.totalBytes, maximum);
            sample.availableBytes = Math.min(sample.availableBytes, Math.max(0, maximum - current));
          }
        }
        if (directory === point) break;
        directory = dirname(directory);
      }
    }
    if (!found) return null;
  }
  return valid(sample) ? sample : null;
}

/** macOS includes reclaimable pages from vm_stat; Linux uses MemAvailable bounded by cgroups v1/v2. A failure closes admission. */
export function sampleMemory(): MemorySample | null {
  try {
    if (process.platform === 'linux') return linuxMemory(read);
    if (process.platform === 'darwin') {
      return parseVmStat(execFileSync('/usr/bin/vm_stat', { encoding: 'utf8', timeout: 1000 }), totalmem());
    }
    const sample = { totalBytes: totalmem(), availableBytes: freemem() };
    return valid(sample) ? sample : null;
  } catch {
    return null;
  }
}

export interface MemoryConfig {
  memoryReserveGb?: number;
  memoryPerAgentGb?: number;
}

export class MemoryAdmission {
  private readonly reservations = new Map<string, number>();

  constructor(
    private readonly config: () => MemoryConfig,
    private readonly sample: () => MemorySample | null = sampleMemory,
  ) {}

  release(attemptId: string): void {
    this.reservations.delete(attemptId);
  }

  /** A second check of the same attempt reuses its reservation. Check and reserve are synchronous. */
  admit(attemptId: string): boolean {
    const decision = this.check(attemptId);
    if (decision.detail !== null) return false;
    this.reservations.set(attemptId, decision.budget);
    return true;
  }

  check(attemptId?: string): { detail: string | null; budget: number } {
    const config = this.config();
    const budget = (config.memoryPerAgentGb ?? DEFAULT_MEMORY_PER_AGENT_GB) * MEMORY_GB;
    let memory: MemorySample | null;
    try {
      memory = this.sample();
    } catch {
      memory = null;
    }
    if (!memory || !valid(memory)) return { detail: 'RAM measurement unavailable; new agents are waiting', budget };
    const reserve = Math.max(
      (config.memoryReserveGb ?? DEFAULT_MEMORY_RESERVE_GB) * MEMORY_GB,
      memory.totalBytes * 0.1,
    );
    const committed = [...this.reservations].reduce((sum, [id, bytes]) => sum + (id === attemptId ? 0 : bytes), 0);
    const detail = memory.availableBytes >= reserve + committed + budget
      ? null
      : `Not enough RAM for another agent: reserve ${(reserve / MEMORY_GB).toFixed(1)} GB, ` +
        `${budget / MEMORY_GB} GB growth budget per agent`;
    return { detail, budget };
  }
}
