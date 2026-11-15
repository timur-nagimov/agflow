import { describe, expect, test } from 'bun:test';
import { TEST_ACCOUNT_ID, type VendorQuota } from '@agflow/core';
import type { PumpEvent } from '../src/attempt/pump';
import { QUOTA_READING_MS, TurnPolicy } from '../src/attempt/turns';
import { DEFAULT_TIMINGS } from '../src/config';
import { noopLogger } from '../src/log';

const HOUR = 60 * 60_000;

/** A Codex worker's turn policy in a running turn, on a clock the test moves. */
function policyAt(clock: { now: number }) {
  const reports: PumpEvent[] = [];
  const policy = new TurnPolicy({
    attemptId: 'T-4-a1',
    spec: () => ({ role: 'worker', vendor: 'codex', acceptanceIds: ['A1'] }),
    session: { send: async () => {}, interrupt: async () => {} },
    inTurn: () => true,
    stopping: () => false,
    linkUp: () => true,
    allowPaidUsage: () => false,
    timings: () => DEFAULT_TIMINGS,
    setPhase: () => {},
    report: (event) => reports.push(event),
    continuationSent: () => {},
    logger: noopLogger,
    now: () => clock.now,
  });
  const quotaReports = () => reports.flatMap((event) => (event.type === 'attempt.quota' ? [event.data] : []));
  return { policy, quotaReports };
}

const reading = (fiveHour: number, at: number, overrides: Partial<VendorQuota> = {}): VendorQuota => ({
  state: 'ok',
  resetsAt: at + HOUR,
  windows: { fiveHour, weekly: 0.1 },
  paidUsage: 'disabled',
  updatedAt: at,
  ...overrides,
});

describe('live quota readings', () => {
  test('a reading during a turn goes to the hub as attempt.quota with state ok, at most once a minute', () => {
    const clock = { now: 1_800_000_000_000 };
    const { policy, quotaReports } = policyAt(clock);
    const first = reading(0.3, clock.now);
    policy.observe({ type: 'quota', accountId: TEST_ACCOUNT_ID, quota: first });
    clock.now += QUOTA_READING_MS - 1;
    policy.observe({ type: 'quota', accountId: TEST_ACCOUNT_ID, quota: reading(0.4, clock.now) });
    clock.now += 1;
    const third = reading(0.5, clock.now);
    policy.observe({ type: 'quota', accountId: TEST_ACCOUNT_ID, quota: third });
    expect(quotaReports()).toEqual([
      { vendor: 'codex', accountId: TEST_ACCOUNT_ID, quota: first },
      { vendor: 'codex', accountId: TEST_ACCOUNT_ID, quota: third },
    ]);
    policy.close();
  });

  test('none names no account, is not ok, or comes while a wait holds; a limit hit is reported at once', () => {
    const clock = { now: 1_800_000_000_000 };
    const { policy, quotaReports } = policyAt(clock);
    policy.observe({ type: 'quota', accountId: null, quota: reading(0.3, clock.now) });
    policy.observe({ type: 'quota', accountId: TEST_ACCOUNT_ID, quota: reading(0.3, clock.now, { state: 'unknown' }) });
    expect(quotaReports()).toEqual([]);
    const hit = reading(1, clock.now, { state: 'exhausted' });
    policy.observe({ type: 'quota', accountId: TEST_ACCOUNT_ID, quota: hit });
    expect(policy.waitingForQuota).toBe(true);
    clock.now += 2 * QUOTA_READING_MS;
    policy.observe({ type: 'quota', accountId: TEST_ACCOUNT_ID, quota: reading(0.3, clock.now) });
    expect(quotaReports()).toEqual([{ vendor: 'codex', accountId: TEST_ACCOUNT_ID, quota: hit }]);
    policy.close();
  });
});
