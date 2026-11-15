import { describe, expect, test } from 'bun:test';
import type { AttemptPhase } from '@agflow/core';
import { ClaudeEventMapper } from '../../../src/adapters/claude/events';
import { QuotaBook } from '../../../src/adapters/claude/quota';
import type { AgentEvent } from '../../../src/adapters/types';
import type { PumpEvent } from '../../../src/attempt/pump';
import { TurnPolicy } from '../../../src/attempt/turns';
import { DEFAULT_TIMINGS } from '../../../src/config';
import { noopLogger } from '../../../src/log';

const NOW = 1_800_000_000_000;
const RESET_S = 1_800_300_000;
const ACCOUNT = 'acct-1';

const rateLimit = (info: Record<string, unknown>) => ({ type: 'rate_limit_event', rate_limit_info: info });

describe('a Claude limit on one model', () => {
  test('a rejected seven_day_opus or seven_day_sonnet event is a hit that names no account', () => {
    const book = new QuotaBook(() => NOW);
    const events = new ClaudeEventMapper({ accountId: ACCOUNT, quota: book });
    events.map(rateLimit({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.4 }));
    const account = book.last(ACCOUNT);
    for (const rateLimitType of ['seven_day_opus', 'seven_day_sonnet']) {
      const hit = rateLimit({ status: 'rejected', rateLimitType, utilization: 1, resetsAt: RESET_S });
      expect(events.map(hit)).toEqual([
        {
          type: 'quota',
          accountId: null,
          quota: {
            state: 'exhausted',
            resetsAt: RESET_S * 1000,
            windows: { fiveHour: null, weekly: 1 },
            paidUsage: 'unknown',
            updatedAt: NOW,
          },
        },
      ]);
    }
    // The account's own quota stays as it was, so its next report and preflight do not say it is exhausted.
    expect(book.last(ACCOUNT)).toEqual(account);
  });

  test("a reading of one model below its limit says nothing about the account", () => {
    const book = new QuotaBook(() => NOW);
    const events = new ClaudeEventMapper({ accountId: ACCOUNT, quota: book });
    const warning = rateLimit({ status: 'allowed_warning', rateLimitType: 'seven_day_opus', utilization: 0.9 });
    expect(events.map(warning)).toEqual([]);
    expect(book.last(ACCOUNT)).toBeNull();
  });

  test('the attempt that met it waits as for any limit, and its report leaves the account usable', () => {
    const reports: PumpEvent[] = [];
    const phases: AttemptPhase[] = [];
    const policy = new TurnPolicy({
      attemptId: 'lead-a1',
      spec: () => ({ role: 'lead', vendor: 'claude', acceptanceIds: [] }),
      session: { send: async () => {}, interrupt: async () => {} },
      inTurn: () => true,
      stopping: () => false,
      linkUp: () => true,
      allowPaidUsage: () => false,
      timings: () => DEFAULT_TIMINGS,
      setPhase: (phase) => phases.push(phase),
      report: (event) => reports.push(event),
      continuationSent: () => {},
      logger: noopLogger,
      now: () => NOW,
    });
    const events = new ClaudeEventMapper({ accountId: ACCOUNT, quota: new QuotaBook(() => NOW) });
    const hit = rateLimit({ status: 'rejected', rateLimitType: 'seven_day_opus', utilization: 1, resetsAt: RESET_S });
    for (const event of events.map(hit) as AgentEvent[]) policy.observe(event);
    expect(policy.waitingForQuota).toBe(true);
    expect(phases).toEqual(['quota_wait']);
    expect(reports).toEqual([
      {
        type: 'attempt.quota',
        data: {
          vendor: 'claude',
          accountId: null,
          quota: expect.objectContaining({ state: 'exhausted', resetsAt: RESET_S * 1000 }),
        },
      },
    ]);
    policy.close();
  });
});
