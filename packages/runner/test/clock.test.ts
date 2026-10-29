import { describe, expect, test } from 'bun:test';
import { Backoff, doublingDelay } from '../src/backoff';
import { AwakeClock, type ClockGap, type ClockSource, systemClock } from '../src/clock';
import { DEFAULT_TIMINGS } from '../src/config';
import { memoryLogger } from '../src/log';

/** A wall clock the test moves by hand, with intervals and timeouts that fire only when the test says so. */
class ManualClock implements ClockSource {
  t = Date.UTC(2026, 9, 29, 9, 0, 0);
  private nextId = 1;
  readonly timers = new Map<number, { fn: () => void; ms: number; repeat: boolean }>();
  now = (): number => this.t;
  setTimeout = (fn: () => void, ms: number): number => this.add(fn, ms, false);
  clearTimeout = (handle: unknown): void => void this.timers.delete(handle as number);
  setInterval = (fn: () => void, ms: number): number => this.add(fn, ms, true);
  clearInterval = (handle: unknown): void => void this.timers.delete(handle as number);
  private add(fn: () => void, ms: number, repeat: boolean): number {
    const id = this.nextId++;
    this.timers.set(id, { fn, ms, repeat });
    return id;
  }
  /** Moves wall time and runs every timer once, as a tick that arrives after the move would. */
  step(ms: number): void {
    this.t += ms;
    for (const [id, timer] of [...this.timers]) {
      if (!timer.repeat) this.timers.delete(id);
      timer.fn();
    }
  }
}

function started(source = new ManualClock()) {
  const clock = new AwakeClock({ source, tickMs: 1_000, gapMs: 5_000 });
  const gaps: ClockGap[] = [];
  clock.onGap((gap) => gaps.push(gap));
  clock.start();
  return { source, clock, gaps };
}

describe('AwakeClock', () => {
  test('reports a wall-clock jump larger than tickGap once, as one gap', () => {
    const { source, gaps } = started();
    source.step(1_000);
    source.step(1_000);
    source.step(60_000);
    source.step(1_000);
    expect(gaps).toEqual([{ at: source.t - 1_000, ms: 60_000 }]);
  });

  test('ignores jitter below tickGap', () => {
    const { source, gaps } = started();
    for (const ms of [1_000, 2_500, 4_900, 5_000, 300, 1_200]) source.step(ms);
    expect(gaps).toEqual([]);
  });

  test('awakeNow advances with wall time but not across a gap', () => {
    const { source, clock } = started();
    const start = clock.awakeNow();
    source.step(1_000);
    source.step(1_000);
    expect(clock.awakeNow() - start).toBe(2_000);
    // The laptop sleeps for an hour; the tick after it reports the gap.
    source.step(3_600_000);
    expect(clock.awakeNow() - start).toBe(3_000);
    source.t += 400;
    expect(clock.awakeNow() - start).toBe(3_400);
  });

  test('an age measured across a sleep excludes it, even before the next tick', () => {
    const { source, clock, gaps } = started();
    const since = clock.awakeNow();
    source.step(1_000);
    // Woken up, but no tick has run yet: reading the clock notices the gap itself.
    source.t += 30 * 60_000;
    expect(clock.awakeNow() - since).toBe(2_000);
    expect(gaps).toHaveLength(1);
    source.step(1_000);
    expect(gaps).toHaveLength(1);
    expect(clock.awakeNow() - since).toBe(3_000);
  });

  test('a backward clock step is not a gap and never makes awakeNow go backwards', () => {
    const { source, clock, gaps } = started();
    source.step(1_000);
    const before = clock.awakeNow();
    source.step(-120_000);
    expect(clock.awakeNow()).toBe(before);
    source.step(1_000);
    expect(clock.awakeNow()).toBe(before + 1_000);
    expect(gaps).toEqual([]);
  });

  test('stop() ends the tick; a later read still notices a gap, and an unsubscribed listener hears nothing', () => {
    const { source, clock, gaps } = started();
    const other: ClockGap[] = [];
    const unsubscribe = clock.onGap((gap) => other.push(gap));
    unsubscribe();
    clock.stop();
    expect(source.timers.size).toBe(0);
    source.step(60_000);
    expect(gaps).toEqual([]);
    expect(clock.awakeNow()).toBeGreaterThan(0);
    expect(gaps).toHaveLength(1);
    expect(other).toEqual([]);
  });

  test('ticks once a second by default', () => {
    const source = new ManualClock();
    new AwakeClock({ source, gapMs: DEFAULT_TIMINGS.tickGap }).start();
    expect([...source.timers.values()].map(({ ms, repeat }) => ({ ms, repeat }))).toEqual([
      { ms: 1_000, repeat: true },
    ]);
  });

  test('runs on the system clock when given no source', () => {
    const clock = new AwakeClock({ gapMs: DEFAULT_TIMINGS.tickGap });
    const before = clock.awakeNow();
    expect(clock.awakeNow()).toBeGreaterThanOrEqual(before);
    expect(systemClock.now()).toBeGreaterThanOrEqual(Date.now() - 1_000);
    clock.start();
    clock.stop();
  });

  test('a throwing listener neither stops the next one nor escapes from the tick or a read', () => {
    const source = new ManualClock();
    const logger = memoryLogger();
    const clock = new AwakeClock({ source, tickMs: 1_000, gapMs: 5_000, logger });
    const heard: ClockGap[] = [];
    clock.onGap(() => {
      throw new Error('listener broke');
    });
    clock.onGap((gap) => heard.push(gap));
    clock.start();
    expect(() => source.step(60_000)).not.toThrow();
    expect(heard).toHaveLength(1);
    source.t += 60_000;
    expect(() => clock.awakeNow()).not.toThrow();
    expect(heard).toHaveLength(2);
    expect(logger.entries.map(({ level, message }) => ({ level, message }))).toEqual([
      { level: 'error', message: 'a clock gap listener failed' },
      { level: 'error', message: 'a clock gap listener failed' },
    ]);
    expect(logger.entries[0]?.fields.error).toContain('listener broke');
  });
});

/** A random source that returns the given values in turn. */
function sequence(...values: number[]): () => number {
  let index = 0;
  return () => values[index++ % values.length] as number;
}

describe('Backoff', () => {
  test('gives full-jitter delays within [0, min(cap, base * 2^attempt)]', () => {
    const backoff = new Backoff({ base: 1_000, cap: 30_000, random: sequence(0.999999) });
    const delays = Array.from({ length: 8 }, () => backoff.next());
    expect(delays).toEqual([999, 1_999, 3_999, 7_999, 15_999, 29_999, 29_999, 29_999]);
    const low = new Backoff({ base: 1_000, cap: 30_000, random: sequence(0) });
    expect(Array.from({ length: 4 }, () => low.next())).toEqual([0, 0, 0, 0]);
  });

  test('stays within bounds for any random value and many attempts', () => {
    const backoff = new Backoff({ base: 1_000, cap: 30_000 });
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const delay = backoff.next();
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(Math.min(30_000, 1_000 * 2 ** attempt));
    }
  });

  test('resets after the link has been up for the reset interval', () => {
    const clock = new ManualClock();
    const backoff = new Backoff({
      base: 1_000,
      cap: 30_000,
      resetAfterMs: 60_000,
      now: clock.now,
      random: sequence(0.5),
    });
    backoff.next();
    backoff.next();
    backoff.next();
    expect(backoff.attempt).toBe(3);
    // Up for 59 s: still backing off from where it was.
    backoff.connected();
    clock.t += 59_000;
    backoff.disconnected();
    expect(backoff.attempt).toBe(3);
    expect(backoff.next()).toBe(4_000);
    // Up for a full minute: the next reconnect starts from base again.
    backoff.connected();
    clock.t += 60_000;
    backoff.disconnected();
    expect(backoff.attempt).toBe(0);
    expect(backoff.next()).toBe(500);
  });

  test('resets after a minute up by default', () => {
    const clock = new ManualClock();
    const backoff = new Backoff({ base: 1_000, cap: 30_000, now: clock.now, random: sequence(0.5) });
    backoff.next();
    backoff.connected();
    clock.t += 59_000;
    backoff.disconnected();
    expect(backoff.attempt).toBe(1);
    backoff.connected();
    clock.t += 60_000;
    backoff.disconnected();
    expect(backoff.attempt).toBe(0);
  });

  test('a link that never came up does not reset it', () => {
    const clock = new ManualClock();
    const backoff = new Backoff({ base: 1_000, cap: 30_000, now: clock.now, random: sequence(0.5) });
    backoff.next();
    clock.t += 120_000;
    backoff.disconnected();
    expect(backoff.attempt).toBe(1);
  });
});

describe('doublingDelay', () => {
  test('doubles from 30 s and stays at 10 min', () => {
    const delays = Array.from({ length: 8 }, (_, attempt) => doublingDelay(attempt, DEFAULT_TIMINGS.lateRetry));
    expect(delays).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000, 600_000]);
    expect(doublingDelay(1_000, DEFAULT_TIMINGS.vendorErrorBackoff)).toBe(600_000);
  });

  test('takes short test timings and refuses a negative attempt', () => {
    expect(doublingDelay(2, { base: 10, cap: 25 })).toBe(25);
    expect(() => doublingDelay(-1, { base: 10, cap: 25 })).toThrow('attempt');
  });
});
