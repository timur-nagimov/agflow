// Disk facts (design 6.3, 7.8): free space is cheap; walking agflow's files stays outside the heartbeat.
import { statfsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defaultExec, type Exec } from '../service/system';

/** Available to this user, or unknown when AGFLOW_HOME is missing or inaccessible. */
export function diskFreeBytes(path: string): number | null {
  try {
    const { bavail, bsize } = statfsSync(path);
    const bytes = bavail * bsize;
    return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null;
  } catch {
    return null;
  }
}

export interface AgflowUsageOptions {
  root: string;
  exec?: Exec;
  /** Ten minutes between starts, including failed measurements. */
  intervalMs?: number;
  /** Two minutes by default. */
  timeoutMs?: number;
  now?: () => number;
}

export class AgflowUsage {
  private readonly root: string;
  private readonly exec: Exec;
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private bytes = 0;
  private lastStarted: number | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(options: AgflowUsageOptions) {
    this.root = resolve(options.root);
    this.exec = options.exec ?? defaultExec;
    this.intervalMs = options.intervalMs ?? 10 * 60_000;
    this.timeoutMs = options.timeoutMs ?? 2 * 60_000;
    this.now = options.now ?? Date.now;
  }

  /** Last measured bytes (0 until the first success); starts due work without waiting for it. */
  current(): number {
    void this.refresh();
    return this.bytes;
  }

  /** Await due or in-flight work; this never bypasses the interval. */
  refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const now = this.now();
    if (this.lastStarted !== null && now - this.lastStarted < this.intervalMs) return Promise.resolve();
    this.lastStarted = now;
    this.inFlight = Promise.resolve()
      .then(() => this.measure())
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  private async measure(): Promise<void> {
    try {
      // -H follows a symlinked AGFLOW_HOME given as the operand (BSD and GNU default to -P), never links inside it.
      const result = await this.exec(['du', '-skH', this.root], { timeoutMs: this.timeoutMs });
      if (result.timedOut) return;
      // du can print its total but exit nonzero for unreadable files within a clone.
      const total = result.stdout.trim().match(/^(\d+)\s+[^\r\n]+$/);
      if (!total) return;
      const bytes = Number(total[1]) * 1024;
      if (Number.isSafeInteger(bytes) && bytes >= 0) this.bytes = bytes;
    } catch {
      // A failed measurement leaves the last value intact until the next interval.
    }
  }
}
