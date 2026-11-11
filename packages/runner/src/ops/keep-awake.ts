// Keep-awake (design 7.9): one `caffeinate -i -w <runner pid>` while attempts need the Mac awake, ref-counted over
// them and re-evaluated on every attempt-state change, power sample and heartbeat, so a keepAwake change from
// update_settings applies within one heartbeat. A bad pid makes caffeinate exit 0 at once, so each spawn is checked.
import type { AgentRole, AttemptPhase, RunnerSettings } from '@agflow/core';
import type { Subprocess } from 'bun';
import { type ClockSource, systemClock } from '../clock';
import { type LogFields, type Logger, noopLogger } from '../log';
import type { PowerSample } from './power';

export type KeepAwakeMode = RunnerSettings['keepAwake'];
/** RunnerStatus's attempts fit it; phase null means holding, stopped or ended. */
export type KeepAwakeAttempt = { role: AgentRole; phase: AttemptPhase | null };

/**
 * Off never holds. On AC any attempt with a phase holds; otherwise only always holds, and only for an active attempt:
 * a lead idle between wake-ups holds on AC alone (a worker's idle between turns is active).
 */
export function wantsKeepAwake(input: {
  mode: KeepAwakeMode;
  power: PowerSample | null;
  attempts: readonly KeepAwakeAttempt[];
}): boolean {
  if (input.mode === 'off') return false;
  const ac = input.power?.source === 'ac';
  if (!ac && input.mode === 'ac') return false;
  return input.attempts.some(({ role, phase }) => phase !== null && (ac || role !== 'lead' || phase !== 'idle'));
}

export interface KeepAwakeOptions {
  /** runner.json's current keepAwake, read on every evaluation. */
  mode: () => KeepAwakeMode;
  /** The last power sample: ServiceHealth.power(). */
  power: () => PowerSample | null;
  /** The runner's attempts: RunnerHandle.status().attempts. */
  attempts: () => readonly KeepAwakeAttempt[];
  /** The runner's pid, process.pid by default. */
  pid?: number;
  /** /usr/bin/caffeinate; an injected command also runs off macOS. */
  command?: string;
  platform?: NodeJS.Platform;
  /** 1 s. */
  aliveCheckMs?: number;
  /** 1 s, doubling up to retryCapMs (60 s). */
  retryBaseMs?: number;
  retryCapMs?: number;
  clock?: ClockSource;
  logger?: Logger;
}

interface Assertion {
  process: Subprocess<'ignore', 'ignore', 'ignore'>;
  checked: boolean;
  stopping: boolean;
}

/** Holds at most one assertion; never throws from evaluate, so any event may call it. */
export class KeepAwake {
  private readonly clock: ClockSource;
  private readonly logger: Logger;
  private readonly enabled: boolean;
  private readonly retryBaseMs: number;
  private readonly retryCapMs: number;
  private retryMs: number;
  private child: Assertion | null = null;
  private checkTimer: unknown = null;
  private retryTimer: unknown = null;
  private closed = false;

  constructor(private readonly options: KeepAwakeOptions) {
    this.clock = options.clock ?? systemClock;
    this.logger = options.logger ?? noopLogger;
    this.enabled = options.command !== undefined || (options.platform ?? process.platform) === 'darwin';
    this.retryBaseMs = options.retryBaseMs ?? 1_000;
    this.retryCapMs = options.retryCapMs ?? 60_000;
    this.retryMs = Math.min(this.retryBaseMs, this.retryCapMs);
  }

  /** Called by the host on attempt changes, power samples and heartbeats. */
  evaluate(): void {
    if (this.closed) return;
    try {
      if (!this.wanted()) {
        this.cancelRetry();
        this.retryMs = Math.min(this.retryBaseMs, this.retryCapMs);
        this.release();
      } else if (this.child === null && this.retryTimer === null) {
        this.spawn();
      }
    } catch (error) {
      this.log('warn', 'keep-awake evaluation failed', {
        error: String(error),
      });
    }
  }

  isHeld(): boolean {
    try {
      return this.child !== null && !this.child.stopping && this.running(this.child) && this.wanted();
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.cancelRetry();
    this.release();
    await this.child?.process.exited;
  }

  private wanted(): boolean {
    return (
      !this.closed &&
      this.enabled &&
      wantsKeepAwake({
        mode: this.options.mode(),
        power: this.options.power(),
        attempts: this.options.attempts(),
      })
    );
  }

  private running(child: Assertion): boolean {
    return child.process.exitCode === null && child.process.signalCode === null;
  }

  private spawn(): void {
    let proc: Assertion['process'];
    try {
      // No detached flag: the assertion belongs to the runner's own process group.
      proc = Bun.spawn(
        [this.options.command ?? '/usr/bin/caffeinate', '-i', '-w', String(this.options.pid ?? process.pid)],
        {
          stdin: 'ignore',
          stdout: 'ignore',
          stderr: 'ignore',
        },
      );
    } catch (error) {
      this.log('warn', 'keep-awake command could not start', {
        error: String(error),
        exitCode: null,
      });
      this.retry();
      return;
    }
    const child: Assertion = { process: proc, checked: false, stopping: false };
    this.child = child;
    void proc.exited.then(() => this.exited(child));
    this.checkTimer = this.clock.setTimeout(() => {
      this.checkTimer = null;
      if (this.child !== child || child.stopping) return;
      if (!this.running(child)) {
        this.exited(child);
        return;
      }
      child.checked = true;
      this.retryMs = Math.min(this.retryBaseMs, this.retryCapMs);
      this.evaluate();
    }, this.options.aliveCheckMs ?? 1_000);
    this.log('info', 'keep-awake assertion taken', { pid: proc.pid });
  }

  private exited(child: Assertion): void {
    // The alive check and the exit promise may both observe the same exit.
    if (this.child !== child) return;
    this.cancelCheck();
    this.child = null;
    if (child.stopping) {
      this.evaluate();
      return;
    }
    this.log('warn', child.checked ? 'keep-awake command exited unexpectedly' : 'keep-awake command exited at once', {
      pid: child.process.pid,
      exitCode: child.process.exitCode,
      signal: child.process.signalCode,
    });
    if (child.checked) this.evaluate();
    else this.retry();
  }

  private retry(): void {
    try {
      if (!this.wanted()) {
        this.evaluate();
        return;
      }
      const delay = this.retryMs;
      this.retryMs = Math.min(this.retryCapMs, delay * 2);
      this.retryTimer = this.clock.setTimeout(() => {
        this.retryTimer = null;
        this.evaluate();
      }, delay);
    } catch (error) {
      this.log('warn', 'keep-awake retry failed', { error: String(error) });
    }
  }

  private release(): void {
    this.cancelCheck();
    const child = this.child;
    if (child === null || child.stopping) return;
    // Keep tracking it until reaped: a quick off/on must not spawn a second assertion.
    child.stopping = true;
    try {
      child.process.kill('SIGTERM');
    } catch (error) {
      this.log('warn', 'keep-awake release failed', {
        pid: child.process.pid,
        error: String(error),
      });
    }
    this.log('info', 'keep-awake assertion released', {
      pid: child.process.pid,
    });
  }

  private cancelCheck(): void {
    if (this.checkTimer !== null) this.clock.clearTimeout(this.checkTimer);
    this.checkTimer = null;
  }

  private cancelRetry(): void {
    if (this.retryTimer !== null) this.clock.clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private log(level: 'info' | 'warn', message: string, fields: LogFields): void {
    try {
      this.logger[level](message, fields);
    } catch {
      // Logging must not break an event callback or leave a child untracked.
    }
  }
}
