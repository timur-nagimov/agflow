// Retry delays (design 6.3, 12): full-jitter backoff for reconnects, and the doubling delays of vendor-error retries,
// late-work pushes and submission retries.

export interface BackoffOptions {
  /** runner.json's timings.backoffBase. */
  base: number;
  /** runner.json's timings.backoffCap. */
  cap: number;
  /** A link that stayed up this long starts the next backoff from base again; 60 s. */
  resetAfterMs?: number;
  now?: () => number;
  random?: () => number;
}

// 2^30 times any base is far beyond every cap, and stopping there keeps the arithmetic finite.
const MAX_EXPONENT = 30;

export class Backoff {
  private readonly options: Required<BackoffOptions>;
  private attempts = 0;
  private upSince: number | null = null;

  constructor(options: BackoffOptions) {
    this.options = {
      base: options.base,
      cap: options.cap,
      resetAfterMs: options.resetAfterMs ?? 60_000,
      now: options.now ?? (() => Date.now()),
      random: options.random ?? Math.random,
    };
  }

  /** How many delays were given since the last reset. */
  get attempt(): number {
    return this.attempts;
  }

  /** The next reconnect delay: a uniform draw from [0, min(cap, base * 2^attempt)). */
  next(): number {
    const { base, cap, random } = this.options;
    const ceiling = Math.min(cap, base * 2 ** Math.min(this.attempts, MAX_EXPONENT));
    this.attempts += 1;
    return Math.floor(random() * ceiling);
  }

  /** The link is up. */
  connected(): void {
    this.upSince = this.options.now();
  }

  /** The link dropped; it resets the backoff when it had been up for resetAfterMs. */
  disconnected(): void {
    if (this.upSince !== null && this.options.now() - this.upSince >= this.options.resetAfterMs) this.reset();
    this.upSince = null;
  }

  reset(): void {
    this.attempts = 0;
  }
}

/** The delay before retry number `attempt` (from 0): base, doubling up to cap. */
export function doublingDelay(attempt: number, delay: { base: number; cap: number }): number {
  if (!Number.isInteger(attempt) || attempt < 0) {
    throw new Error(`attempt must be a whole number from 0, not ${attempt}`);
  }
  return Math.min(delay.cap, delay.base * 2 ** Math.min(attempt, MAX_EXPONENT));
}
