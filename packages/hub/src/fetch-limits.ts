// The limits on what the hub fetches for agents (design 5, Unattended options), kept in memory: a restart forgets
// them, which only ever allows a little more. Pure: the clock is passed in, and the caller turns a refusal into an
// answer and does the waiting.

export interface FetchLimits {
  /** An attempt's requests in any window of attemptWindowMs. */
  attemptRequests: number;
  attemptWindowMs: number;
  /** The least time between two requests to one host, whoever asks. */
  hostGapMs: number;
  /** The longest a request waits for its host's slot; beyond it the caller is told to retry. */
  hostWaitMaxMs: number;
  /** Requests under way at once, per attempt and for the hub: each holds up to the size cap in memory. */
  attemptInFlight: number;
  inFlight: number;
}

export const FETCH_LIMITS: Readonly<FetchLimits> = Object.freeze({
  attemptRequests: 120,
  attemptWindowMs: 10 * 60_000,
  hostGapMs: 1000,
  hostWaitMaxMs: 3000,
  attemptInFlight: 2,
  inFlight: 8,
});

export class FetchLimiter {
  /** When each of the attempt's requests in the window was admitted, oldest first. */
  private readonly admitted = new Map<string, number[]>();
  /** The earliest time the host's next request may go out. */
  private readonly hostFreeAt = new Map<string, number>();
  private readonly flying = new Map<string, number>();
  private flyingTotal = 0;

  constructor(
    private readonly now: () => number,
    private readonly limits: Readonly<FetchLimits> = FETCH_LIMITS,
  ) {}

  /**
   * Counts one request of the attempt. Null when it is within the limit; otherwise the milliseconds until the oldest
   * counted request leaves the window, and nothing is counted.
   */
  admit(attemptId: string): number | null {
    const now = this.now();
    this.forget(now);
    const times = this.admitted.get(attemptId) ?? [];
    if (times.length >= this.limits.attemptRequests) return (times[0] as number) + this.limits.attemptWindowMs - now;
    times.push(now);
    this.admitted.set(attemptId, times);
    return null;
  }

  /**
   * Reserves the host's next slot and answers how long to wait for it. Null when the wait would be longer than
   * hostWaitMaxMs: no slot is reserved then.
   */
  reserveHost(host: string): number | null {
    const now = this.now();
    this.forget(now);
    const slot = Math.max(now, this.hostFreeAt.get(host) ?? 0);
    if (slot - now > this.limits.hostWaitMaxMs) return null;
    this.hostFreeAt.set(host, slot + this.limits.hostGapMs);
    return slot - now;
  }

  /** A request of the attempt starts; false when the attempt or the hub has as many under way as it may. */
  enter(attemptId: string): boolean {
    const mine = this.flying.get(attemptId) ?? 0;
    if (mine >= this.limits.attemptInFlight || this.flyingTotal >= this.limits.inFlight) return false;
    this.flying.set(attemptId, mine + 1);
    this.flyingTotal += 1;
    return true;
  }

  /** A request that entered has ended, however it went. */
  leave(attemptId: string): void {
    const mine = this.flying.get(attemptId) ?? 0;
    if (mine <= 0) return;
    if (mine === 1) this.flying.delete(attemptId);
    else this.flying.set(attemptId, mine - 1);
    this.flyingTotal -= 1;
  }

  /** How much the limiter remembers. */
  tracked(): { attempts: number; hosts: number; inFlight: number } {
    return { attempts: this.admitted.size, hosts: this.hostFreeAt.size, inFlight: this.flyingTotal };
  }

  /** Drops the requests that left the window and the hosts whose slot has passed, so the maps do not grow for ever. */
  private forget(now: number): void {
    const oldest = now - this.limits.attemptWindowMs;
    for (const [attemptId, times] of this.admitted) {
      const kept = times.filter((time) => time > oldest);
      if (kept.length === 0) this.admitted.delete(attemptId);
      else if (kept.length !== times.length) this.admitted.set(attemptId, kept);
    }
    for (const [host, freeAt] of this.hostFreeAt) {
      if (freeAt <= now) this.hostFreeAt.delete(host);
    }
  }
}
