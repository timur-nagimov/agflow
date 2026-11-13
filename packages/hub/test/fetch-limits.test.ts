import { describe, expect, test } from 'bun:test';
import { createContext } from '../src/context';
import { FETCH_LIMITS, FetchLimiter } from '../src/fetch-limits';
import { makeConfig } from './helpers';

const SECOND = 1000;
const MINUTE = 60 * SECOND;

function setup() {
  const clock = { t: 1_000_000 };
  return { clock, limiter: new FetchLimiter(() => clock.t) };
}

describe('the fetch limits', () => {
  test('the limits are 120 requests per attempt in any 10 minutes and a second between requests to one host', () => {
    expect(FETCH_LIMITS).toEqual({
      attemptRequests: 120,
      attemptWindowMs: 10 * MINUTE,
      hostGapMs: SECOND,
      hostWaitMaxMs: 3 * SECOND,
      attemptInFlight: 2,
      inFlight: 8,
    });
  });

  test('an attempt gets 120 requests in a window; the next is refused with the time until one leaves it', () => {
    const { clock, limiter } = setup();
    for (let n = 0; n < 120; n += 1) {
      expect([n, limiter.admit('T-1-a1')]).toEqual([n, null]);
      clock.t += SECOND;
    }
    // The first was admitted 120 seconds ago, so it leaves the window in 8 minutes.
    expect(limiter.admit('T-1-a1')).toBe(8 * MINUTE);
    // A refusal is not counted.
    expect(limiter.admit('T-1-a1')).toBe(8 * MINUTE);
    clock.t += 8 * MINUTE - 1;
    expect(limiter.admit('T-1-a1')).toBe(1);
    clock.t += 1;
    expect(limiter.admit('T-1-a1')).toBeNull();
    expect(limiter.admit('T-1-a1')).toBe(SECOND);
  });

  test('the window slides: any 10 minutes hold at most 120', () => {
    const { clock, limiter } = setup();
    for (let n = 0; n < 60; n += 1) expect(limiter.admit('T-1-a1')).toBeNull();
    clock.t += 5 * MINUTE;
    for (let n = 0; n < 60; n += 1) expect(limiter.admit('T-1-a1')).toBeNull();
    clock.t += 5 * MINUTE - 1;
    expect(limiter.admit('T-1-a1')).toBe(1);
    clock.t += 1;
    // The first sixty left; the second sixty are still inside.
    for (let n = 0; n < 60; n += 1) expect(limiter.admit('T-1-a1')).toBeNull();
    expect(limiter.admit('T-1-a1')).toBe(5 * MINUTE);
  });

  test('each attempt has its own count', () => {
    const { limiter } = setup();
    for (let n = 0; n < 120; n += 1) limiter.admit('T-1-a1');
    expect(limiter.admit('T-1-a1')).not.toBeNull();
    expect(limiter.admit('T-2-a1')).toBeNull();
    expect(limiter.admit('lead-a1')).toBeNull();
  });

  test('requests to one host are a second apart, hub-wide: each reserves the next slot and learns how long to wait', () => {
    const { clock, limiter } = setup();
    expect(limiter.reserveHost('example.com')).toBe(0);
    expect(limiter.reserveHost('example.com')).toBe(1 * SECOND);
    expect(limiter.reserveHost('example.com')).toBe(2 * SECOND);
    expect(limiter.reserveHost('example.com')).toBe(3 * SECOND);
    // The next slot is four seconds away: no slot is reserved, the caller is told to retry.
    expect(limiter.reserveHost('example.com')).toBeNull();
    expect(limiter.reserveHost('example.com')).toBeNull();
    clock.t += SECOND;
    expect(limiter.reserveHost('example.com')).toBe(3 * SECOND);
    // Another host is not held back.
    expect(limiter.reserveHost('example.org')).toBe(0);
    clock.t += 10 * SECOND;
    expect(limiter.reserveHost('example.com')).toBe(0);
    clock.t += 999;
    expect(limiter.reserveHost('example.com')).toBe(1);
  });

  test('an attempt has two requests in flight at most, and the hub eight', () => {
    const { limiter } = setup();
    expect(limiter.enter('T-1-a1')).toBe(true);
    expect(limiter.enter('T-1-a1')).toBe(true);
    expect(limiter.enter('T-1-a1')).toBe(false);
    limiter.leave('T-1-a1');
    expect(limiter.enter('T-1-a1')).toBe(true);
    for (const attempt of ['T-2-a1', 'T-3-a1', 'T-4-a1']) {
      expect(limiter.enter(attempt)).toBe(true);
      expect(limiter.enter(attempt)).toBe(true);
    }
    // Eight are in flight.
    expect(limiter.enter('T-5-a1')).toBe(false);
    limiter.leave('T-2-a1');
    expect(limiter.enter('T-5-a1')).toBe(true);
  });

  test('what is no longer needed is forgotten', () => {
    const { clock, limiter } = setup();
    for (let n = 0; n < 50; n += 1) {
      limiter.admit(`T-${n}-a1`);
      limiter.reserveHost(`site${n}.example.com`);
      limiter.enter(`T-${n}-a1`);
      limiter.leave(`T-${n}-a1`);
    }
    expect(limiter.tracked()).toEqual({ attempts: 50, hosts: 50, inFlight: 0 });
    clock.t += 10 * MINUTE;
    limiter.admit('T-99-a1');
    limiter.reserveHost('example.com');
    expect(limiter.tracked()).toEqual({ attempts: 1, hosts: 1, inFlight: 0 });
  });
});

describe("the hub's own limiter", () => {
  test('a hub given a clock limits by that clock', () => {
    const clock = { t: 5_000_000 };
    const ctx = createContext({ dbPath: ':memory:', config: makeConfig(), now: () => clock.t });
    try {
      const { limiter } = ctx.agentFetch;
      expect(limiter.reserveHost('example.com')).toBe(0);
      expect(limiter.reserveHost('example.com')).toBe(SECOND);
      clock.t += 10 * SECOND;
      expect(limiter.reserveHost('example.com')).toBe(0);
    } finally {
      ctx.db.close();
    }
  });

  test('a hub given none counts on a clock that never steps back: setting the wall clock back an hour holds no host back', () => {
    // As main.ts builds it. On the wall clock, the slot reserved below would stay an hour away after the step.
    const ctx = createContext({ dbPath: ':memory:', config: makeConfig() });
    const wallClock = Date.now;
    try {
      const { limiter } = ctx.agentFetch;
      expect(limiter.reserveHost('example.com')).toBe(0);
      Date.now = () => wallClock() - 60 * MINUTE;
      const wait = limiter.reserveHost('example.com');
      // The usual second, less the moment that passed since the first request.
      expect(wait).not.toBeNull();
      expect(wait as number).toBeGreaterThan(SECOND / 2);
      expect(wait as number).toBeLessThanOrEqual(SECOND);
      // The count of an attempt's requests ages the same way.
      for (let n = 0; n < FETCH_LIMITS.attemptRequests; n += 1) limiter.admit('T-1-a1');
      Date.now = () => wallClock() - 120 * MINUTE;
      const retryIn = limiter.admit('T-1-a1');
      expect(retryIn as number).toBeGreaterThan(9 * MINUTE);
      expect(retryIn as number).toBeLessThanOrEqual(FETCH_LIMITS.attemptWindowMs);
    } finally {
      Date.now = wallClock;
      ctx.db.close();
    }
  });
});
