import { describe, expect, test } from 'bun:test';
import {
  clipPushError,
  FINAL_PUSH_RETRY_MS,
  LateWorkRetries,
  type LateWorkTry,
  PUSH_ERROR_MAX,
  pushWithRetries,
  type ScheduleFn,
} from '../src/attempt/exit';
import type { PushResult } from '../src/git/push';
import { memoryLogger } from '../src/log';

const remote: PushResult = { ok: false, error: 'remote', refs: [], detail: 'the remote hung up' };
const stale: PushResult = { ok: false, error: 'stale', refs: [], detail: 'stale info' };
const landed: PushResult = { ok: true, refs: [] };

/** A fake clock whose sleeps advance it and are recorded. */
function fakeTime() {
  const clock = { now: 0, sleeps: [] as number[] };
  return {
    clock,
    now: () => clock.now,
    sleep: async (ms: number) => {
      clock.sleeps.push(ms);
      clock.now += ms;
    },
  };
}

/** A push that gives the scripted results in order, the last one from then on. */
function scripted(results: PushResult[]) {
  let tries = 0;
  return {
    get tries() {
      return tries;
    },
    push: async () => results[Math.min(tries++, results.length - 1)] as PushResult,
  };
}

describe('pushWithRetries', () => {
  test('remote failures wait 1, 2, 4 seconds and so on until the budget runs out', async () => {
    const time = fakeTime();
    const push = scripted([remote]);
    const result = await pushWithRetries({ push: push.push, budgetMs: 10_000, sleep: time.sleep, now: time.now });
    expect(result).toEqual(remote);
    expect(time.clock.sleeps).toEqual([FINAL_PUSH_RETRY_MS, 2 * FINAL_PUSH_RETRY_MS, 4 * FINAL_PUSH_RETRY_MS]);
    expect(push.tries).toBe(4);
  });

  test('a stale lease returns after one try, with no wait', async () => {
    const time = fakeTime();
    const push = scripted([stale]);
    expect(await pushWithRetries({ push: push.push, budgetMs: 10_000, sleep: time.sleep, now: time.now })).toEqual(stale);
    expect(push.tries).toBe(1);
    expect(time.clock.sleeps).toEqual([]);
  });

  test('a success after failures returns it', async () => {
    const time = fakeTime();
    const push = scripted([remote, remote, landed]);
    expect(await pushWithRetries({ push: push.push, budgetMs: 10_000, sleep: time.sleep, now: time.now })).toEqual(landed);
    expect(push.tries).toBe(3);
    expect(time.clock.sleeps).toEqual([1_000, 2_000]);
  });

  test('a budget of 0 makes one try', async () => {
    const time = fakeTime();
    const push = scripted([remote]);
    expect(await pushWithRetries({ push: push.push, budgetMs: 0, sleep: time.sleep, now: time.now })).toEqual(remote);
    expect(push.tries).toBe(1);
  });

  test('the refusal is asked before every try: one that comes between retries ends them', async () => {
    const time = fakeTime();
    const push = scripted([remote]);
    const refusal = () => (push.tries >= 2 ? 'no welcome since the last clock gap' : null);
    const result = await pushWithRetries({ push: push.push, budgetMs: 10_000, refusal, sleep: time.sleep, now: time.now });
    expect(result).toEqual({ ok: false, error: 'refused', detail: 'no welcome since the last clock gap' });
    expect(push.tries).toBe(2);
  });

  test('a wait that overran the deadline (a sleeping laptop) pushes no more', async () => {
    const time = fakeTime();
    const push = scripted([remote]);
    const sleep = async (ms: number) => {
      time.clock.sleeps.push(ms);
      time.clock.now += 60_000;
    };
    expect(await pushWithRetries({ push: push.push, budgetMs: 10_000, sleep, now: time.now })).toEqual(remote);
    expect(push.tries).toBe(1);
  });
});

describe('clipPushError', () => {
  test('keeps a short error and cuts a long one to PUSH_ERROR_MAX characters', () => {
    expect(clipPushError('cannot push')).toBe('cannot push');
    const clipped = clipPushError('x'.repeat(PUSH_ERROR_MAX * 3));
    expect(clipped).toHaveLength(PUSH_ERROR_MAX);
    expect(clipped.endsWith('…')).toBe(true);
  });
});

/** A scheduler that only records what is due; the test runs it. */
function manualSchedule() {
  const pending: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  const schedule: ScheduleFn = (fn, ms) => {
    const entry = { fn, ms, cancelled: false };
    pending.push(entry);
    return () => {
      entry.cancelled = true;
    };
  };
  return {
    schedule,
    pending,
    /** Runs the next scheduled try and lets it finish. */
    async fire(): Promise<number> {
      const entry = pending.shift();
      if (!entry) throw new Error('nothing is scheduled');
      if (!entry.cancelled) entry.fn();
      await Bun.sleep(0);
      await Bun.sleep(0);
      return entry.ms;
    },
  };
}

function retries(results: (LateWorkTry | Error)[], schedule: ScheduleFn) {
  let tries = 0;
  const late = new LateWorkRetries({
    delay: { base: 200, cap: 400 },
    logger: memoryLogger(),
    attemptId: 'T-4-a1',
    schedule,
    attempt: async () => {
      const result = results[Math.min(tries++, results.length - 1)] as LateWorkTry | Error;
      if (result instanceof Error) throw result;
      return result;
    },
  });
  return {
    late,
    get tries() {
      return tries;
    },
  };
}

describe('LateWorkRetries', () => {
  const failed: LateWorkTry = { ok: false, error: 'the remote hung up' };

  test('the first try waits 200 ms, and failed ones are rescheduled after 400 and 400 ms', async () => {
    const timer = manualSchedule();
    const r = retries([failed], timer.schedule);
    r.late.start(false);
    expect(await timer.fire()).toBe(200);
    expect(await timer.fire()).toBe(400);
    expect(await timer.fire()).toBe(400);
    expect(r.tries).toBe(3);
    expect(r.late.active).toBe(true);
  });

  test('a try that lands ends the retries', async () => {
    const timer = manualSchedule();
    const r = retries([failed, { ok: true }], timer.schedule);
    r.late.start(true);
    await Bun.sleep(0);
    await timer.fire();
    expect(r.tries).toBe(2);
    expect(r.late.active).toBe(false);
    expect(timer.pending).toEqual([]);
  });

  test('cancel stops a pending retry', async () => {
    const timer = manualSchedule();
    const r = retries([failed], timer.schedule);
    r.late.start(false);
    r.late.cancel();
    await timer.fire();
    expect(r.tries).toBe(0);
    expect(r.late.active).toBe(false);
  });

  test('a try that throws counts as a failure and is rescheduled', async () => {
    const timer = manualSchedule();
    const r = retries([new Error('git crashed'), { ok: true }], timer.schedule);
    r.late.start(true);
    await Bun.sleep(0);
    expect(timer.pending.map((entry) => entry.ms)).toEqual([400]);
    await timer.fire();
    expect(r.tries).toBe(2);
    expect(r.late.active).toBe(false);
  });
});
