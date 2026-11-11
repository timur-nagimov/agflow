// The awake clock (design 6.3, 7.5): a 1 s wall-clock tick notices sleep and freezes, so every age and activeMs the
// runner reports leaves them out, and the link reconnects at once after one.
import { type Logger, noopLogger } from './log';

/** Wall time and timers, injectable so tests never wait in real time. */
export interface ClockSource {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const systemClock: ClockSource = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as Timer),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as Timer),
};

export interface ClockGap {
  /** Wall time when the gap was noticed. */
  at: number;
  /** Wall time between the last observation before the gap and the first after it. */
  ms: number;
}

export interface AwakeClockOptions {
  source?: ClockSource;
  /** 1 s. */
  tickMs?: number;
  /** runner.json's timings.tickGap: a longer step between two observations is a sleep or a freeze. */
  gapMs: number;
  /** Where a throwing gap listener is reported. */
  logger?: Logger;
}

export class AwakeClock {
  private readonly source: ClockSource;
  private readonly tickMs: number;
  private readonly gapMs: number;
  private readonly logger: Logger;
  private readonly listeners = new Set<(gap: ClockGap) => void>();
  private lastWall: number;
  private awake: number;
  private timer: unknown = null;

  constructor(options: AwakeClockOptions) {
    this.source = options.source ?? systemClock;
    this.tickMs = options.tickMs ?? 1_000;
    this.gapMs = options.gapMs;
    this.logger = options.logger ?? noopLogger;
    this.lastWall = this.source.now();
    // Starts at wall time, so awake times read like timestamps; only differences between them mean anything.
    this.awake = this.lastWall;
  }

  start(): void {
    if (this.timer === null) this.timer = this.source.setInterval(() => this.observe(), this.tickMs);
  }

  stop(): void {
    if (this.timer !== null) this.source.clearInterval(this.timer);
    this.timer = null;
  }

  /** Called once per gap, from the tick or from the read that notices it first. Returns the unsubscribe. */
  onGap(listener: (gap: ClockGap) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The awake time in ms: it advances with wall time, but not across sleeps, freezes or backward steps. */
  awakeNow(): number {
    this.observe();
    return this.awake;
  }

  private observe(): void {
    const now = this.source.now();
    const step = now - this.lastWall;
    this.lastWall = now;
    // A backward step (an NTP correction, say) adds nothing; time runs on from the new wall time.
    if (step <= 0) return;
    if (step <= this.gapMs) {
      this.awake += step;
      return;
    }
    // Only the tick interval before the gap counts as awake; the rest was spent asleep or frozen.
    this.awake += this.tickMs;
    const gap = { at: now, ms: step };
    // Each listener hears the gap even if another throws: the gap is reported only once, and a throw would otherwise
    // escape into whatever read the clock, or out of the tick and end the process.
    for (const listener of [...this.listeners]) {
      try {
        listener(gap);
      } catch (error) {
        this.logger.error('a clock gap listener failed', { error: String(error) });
      }
    }
  }
}
