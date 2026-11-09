import { describe, expect, test } from 'bun:test';
import { VendorQuotaSchema } from '@agflow/core';
import { loadRecording } from '@agflow/testkit/src/fake-claude';
import type { SDKControlGetUsageResponse, SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk';
import {
  isLimitHitText,
  isPaidUsageNotice,
  QuotaBook,
  quotaFromUsage,
  toVendorQuota,
  USAGE_LIMIT_PREFIXES,
  USAGE_TRANSITION_PREFIXES,
} from '../../../src/adapters/claude/quota';
import { isLimitHit } from '../../../src/attempt/turns';

const NOW = 1_800_000_000_000;
const RESET_S = 1_800_003_600;
const RESET_MS = RESET_S * 1000;

const info = (fields: Partial<SDKRateLimitInfo> & Record<string, unknown>): SDKRateLimitInfo =>
  ({ status: 'allowed', ...fields }) as SDKRateLimitInfo;

describe('toVendorQuota', () => {
  test('status rejected gives exhausted, with resetsAt in epoch ms (seconds are converted)', () => {
    const quota = toVendorQuota(info({ status: 'rejected', resetsAt: RESET_S, rateLimitType: 'five_hour' }), NOW);
    expect(quota).toEqual({
      state: 'exhausted',
      resetsAt: RESET_MS,
      windows: { fiveHour: null, weekly: null },
      paidUsage: 'unknown',
      updatedAt: NOW,
    });
    expect(toVendorQuota(info({ status: 'rejected', resetsAt: RESET_MS }), NOW).resetsAt).toBe(RESET_MS);
    expect(VendorQuotaSchema.parse(quota)).toEqual(quota);
  });

  test('a limit hit without a reset time gives exhausted with resetsAt null', () => {
    expect(toVendorQuota(info({ status: 'rejected' }), NOW)).toMatchObject({ state: 'exhausted', resetsAt: null });
  });

  test('allowed and allowed_warning stay ok; utilization lands in fiveHour or weekly by rateLimitType', () => {
    const five = toVendorQuota(info({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.4 }), NOW);
    expect(five).toMatchObject({ state: 'ok', windows: { fiveHour: 0.4, weekly: null } });
    const weeklyTypes = ['seven_day', 'seven_day_opus', 'seven_day_sonnet', 'seven_day_overage_included'] as const;
    for (const rateLimitType of weeklyTypes) {
      const weekly = toVendorQuota(info({ status: 'allowed_warning', rateLimitType, utilization: 0.9 }), NOW);
      expect(weekly).toMatchObject({ state: 'ok', windows: { fiveHour: null, weekly: 0.9 } });
    }
    expect(toVendorQuota(info({ rateLimitType: 'five_hour', utilization: 1.7 }), NOW).windows.fiveHour).toBe(1);
  });

  test('without utilization the unifiedWindows give the windows, the largest weekly one for weekly', () => {
    const unifiedWindows = {
      five_hour: { utilization: 0.25, resetsAt: RESET_S },
      seven_day: { utilization: 0.5, resetsAt: RESET_S },
      seven_day_overage_included: { utilization: 0.75, resetsAt: RESET_S },
    };
    expect(toVendorQuota(info({ rateLimitType: 'five_hour', unifiedWindows }), NOW).windows).toEqual({
      fiveHour: 0.25,
      weekly: 0.75,
    });
    // The event's own utilization wins for its window.
    expect(toVendorQuota(info({ rateLimitType: 'five_hour', utilization: 0.3, unifiedWindows }), NOW).windows).toEqual({
      fiveHour: 0.3,
      weekly: 0.75,
    });
    for (const odd of [null, 'x', { five_hour: 'x', seven_day: { utilization: 'high' } }]) {
      expect(toVendorQuota(info({ unifiedWindows: odd }), NOW).windows).toEqual({ fiveHour: null, weekly: null });
    }
  });

  test('isUsingOverage, overageInUse or rateLimitType overage gives paidUsage in_use; using it is not exhaustion', () => {
    // The CLI sets isUsingOverage exactly when the plan window is rejected and overage allowed.
    const overage = toVendorQuota(
      info({ status: 'rejected', resetsAt: RESET_S, overageStatus: 'allowed', isUsingOverage: true }),
      NOW,
    );
    expect(overage).toMatchObject({ state: 'ok', paidUsage: 'in_use', resetsAt: RESET_MS });
    expect(toVendorQuota(info({ overageInUse: true }), NOW).paidUsage).toBe('in_use');
    expect(toVendorQuota(info({ rateLimitType: 'overage', utilization: 0.2 }), NOW)).toMatchObject({
      paidUsage: 'in_use',
      windows: { fiveHour: null, weekly: null },
    });
    // The overage limit itself hit: exhausted.
    expect(toVendorQuota(info({ status: 'rejected', rateLimitType: 'overage' }), NOW)).toMatchObject({
      state: 'exhausted',
      paidUsage: 'in_use',
    });
  });

  test('overageStatus allowed gives enabled; an overageDisabledReason gives disabled; neither gives unknown', () => {
    expect(toVendorQuota(info({ overageStatus: 'allowed' }), NOW).paidUsage).toBe('enabled');
    expect(toVendorQuota(info({ overageStatus: 'allowed_warning' }), NOW).paidUsage).toBe('enabled');
    expect(toVendorQuota(info({ overageDisabledReason: 'out_of_credits' }), NOW).paidUsage).toBe('disabled');
    expect(toVendorQuota(info({ overageStatus: 'rejected' }), NOW).paidUsage).toBe('disabled');
    expect(toVendorQuota(info({}), NOW).paidUsage).toBe('unknown');
  });
});

describe('QuotaBook', () => {
  test('keeps the last value per account between sparse rate_limit_events, and merges windows', () => {
    let now = NOW;
    const book = new QuotaBook(() => now);
    expect(book.last('a')).toBeNull();
    book.rateLimit(
      'a',
      info({ rateLimitType: 'five_hour', utilization: 0.5, resetsAt: RESET_S, overageStatus: 'allowed' }),
    );
    now += 1000;
    const merged = book.rateLimit('a', info({ rateLimitType: 'seven_day', utilization: 0.2 }));
    expect(merged).toEqual({
      state: 'ok',
      resetsAt: RESET_MS,
      windows: { fiveHour: 0.5, weekly: 0.2 },
      paidUsage: 'enabled',
      updatedAt: NOW + 1000,
    });
    expect(book.last('a')).toEqual(merged);
    expect(book.last('b')).toBeNull();
    book.rateLimit('b', info({ status: 'rejected' }));
    expect(book.last('b')?.state).toBe('exhausted');
    expect(book.last('a')?.state).toBe('ok');
  });

  test('a new state replaces the old one, and its reset time with it', () => {
    const book = new QuotaBook(() => NOW);
    book.rateLimit('a', info({ status: 'rejected', resetsAt: RESET_S }));
    expect(book.rateLimit('a', info({ status: 'allowed' }))).toMatchObject({ state: 'ok', resetsAt: null });
  });

  test('a rejected report without a reset time is exhausted with resetsAt null, whatever came before', () => {
    let now = NOW;
    const book = new QuotaBook(() => now);
    book.rateLimit('a', info({ status: 'rejected', resetsAt: RESET_S }));
    now = RESET_MS + 1000;
    expect(book.rateLimit('a', info({ status: 'rejected' }))).toMatchObject({ state: 'exhausted', resetsAt: null });
    now = NOW;
    book.rateLimit('b', info({ status: 'rejected', resetsAt: RESET_S }));
    expect(book.rateLimit('b', info({ status: 'rejected' }))).toMatchObject({ state: 'exhausted', resetsAt: null });
  });

  test('a reset time that has passed is never carried into a report without one', () => {
    let now = NOW;
    const book = new QuotaBook(() => now);
    book.rateLimit('a', info({ rateLimitType: 'five_hour', utilization: 0.5, resetsAt: RESET_S }));
    now = RESET_MS + 1000;
    expect(book.rateLimit('a', info({ rateLimitType: 'seven_day', utilization: 0.2 }))).toMatchObject({
      state: 'ok',
      resetsAt: null,
    });
    book.rateLimit('b', info({ status: 'rejected', resetsAt: RESET_S }));
    expect(book.paidUsageInUse('b')).toMatchObject({ state: 'exhausted', resetsAt: null });
    now = NOW;
    book.rateLimit('c', info({ status: 'rejected', resetsAt: RESET_S }));
    expect(book.paidUsageInUse('c')).toMatchObject({ state: 'exhausted', resetsAt: RESET_MS });
  });

  test('a report that paid usage is not in use ends an in_use the book held', () => {
    const book = new QuotaBook(() => NOW);
    const warning = info({
      status: 'allowed_warning',
      rateLimitType: 'five_hour',
      utilization: 0.9,
      isUsingOverage: false,
      resetsAt: RESET_S,
    });
    book.rateLimit('a', info({ status: 'rejected', rateLimitType: 'five_hour', isUsingOverage: true }));
    expect(book.last('a')).toMatchObject({ state: 'ok', paidUsage: 'in_use' });
    const after = book.rateLimit('a', warning);
    expect(after).toMatchObject({ state: 'ok', paidUsage: 'enabled', resetsAt: RESET_MS });
    expect(isLimitHit(after, false)).toBe(false);

    book.paidUsageInUse('b');
    const notice = book.rateLimit('b', warning);
    expect(notice.paidUsage).toBe('enabled');
    expect(isLimitHit(notice, false)).toBe(false);

    // The report's own overage facts win, and without a held in_use nothing is made up.
    book.paidUsageInUse('c');
    expect(book.rateLimit('c', { ...warning, overageDisabledReason: 'out_of_credits' }).paidUsage).toBe('disabled');
    expect(book.rateLimit('d', warning).paidUsage).toBe('unknown');
  });

  test('a usage-transition notice sets paidUsage in_use and keeps the rest', () => {
    const book = new QuotaBook(() => NOW);
    expect(book.paidUsageInUse('a')).toEqual({
      state: 'unknown',
      resetsAt: null,
      windows: { fiveHour: null, weekly: null },
      paidUsage: 'in_use',
      updatedAt: NOW,
    });
    book.rateLimit('b', info({ rateLimitType: 'five_hour', utilization: 0.9 }));
    expect(book.paidUsageInUse('b')).toMatchObject({ state: 'ok', paidUsage: 'in_use', windows: { fiveHour: 0.9 } });
  });

  test('update stores a quota from elsewhere, such as the usage call', () => {
    const book = new QuotaBook(() => NOW);
    const quota = quotaFromUsage(usage({ five_hour: window(10, '2027-01-15T10:00:00.000Z') }), NOW);
    if (quota === null) throw new Error('no quota');
    expect(book.update('a', quota)).toEqual(quota);
    expect(book.last('a')).toEqual(quota);
  });
});

type RateLimits = NonNullable<SDKControlGetUsageResponse['rate_limits']>;
const window = (utilization: number | null, resets_at: string | null) => ({ utilization, resets_at });
const usage = (rate_limits: RateLimits | null | Record<string, unknown>): Record<string, unknown> => ({
  subscription_type: 'max',
  rate_limits_available: rate_limits !== null,
  rate_limits,
});

describe('quotaFromUsage', () => {
  test('maps five_hour and seven_day (percent / 100; ISO resets to epoch ms; the limiting window reset)', () => {
    const quota = quotaFromUsage(
      usage({
        five_hour: window(42, '2027-01-15T10:00:00.000Z'),
        seven_day: window(64, '2027-01-20T00:00:00Z'),
        extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
      }),
      NOW,
    );
    expect(quota).toEqual({
      state: 'ok',
      resetsAt: Date.parse('2027-01-20T00:00:00Z'),
      windows: { fiveHour: 0.42, weekly: 0.64 },
      paidUsage: 'disabled',
      updatedAt: NOW,
    });
    expect(VendorQuotaSchema.parse(quota)).toEqual(quota as NonNullable<typeof quota>);
  });

  test('extra_usage.is_enabled gives enabled or disabled, and its absence unknown', () => {
    const base = { five_hour: window(10, null) };
    expect(quotaFromUsage(usage({ ...base, extra_usage: { is_enabled: true } }), NOW)?.paidUsage).toBe('enabled');
    expect(quotaFromUsage(usage({ ...base, extra_usage: null }), NOW)?.paidUsage).toBe('unknown');
    expect(quotaFromUsage(usage(base), NOW)).toMatchObject({
      resetsAt: null,
      windows: { fiveHour: 0.1, weekly: null },
      paidUsage: 'unknown',
    });
  });

  test('a full window is exhausted until its reset, unless extra usage would carry the work', () => {
    const full = { five_hour: window(100, '2027-01-15T10:00:00.000Z'), seven_day: window(80, null) };
    expect(quotaFromUsage(usage(full), NOW)).toMatchObject({
      state: 'exhausted',
      resetsAt: Date.parse('2027-01-15T10:00:00.000Z'),
      windows: { fiveHour: 1, weekly: 0.8 },
    });
    expect(quotaFromUsage(usage({ ...full, extra_usage: { is_enabled: true } }), NOW)).toMatchObject({
      state: 'ok',
      paidUsage: 'enabled',
    });
  });

  test("the preflight-ok capture's usage answer (rate_limits null) gives null", () => {
    const answer = loadRecording('preflight-ok').answers.get_usage;
    if (answer === undefined || !('response' in answer)) throw new Error('preflight-ok has no get_usage answer');
    expect(quotaFromUsage(answer.response, NOW)).toBeNull();
  });

  test('rate_limits null or another shape gives null', () => {
    for (const odd of [
      null,
      undefined,
      'x',
      { rate_limits: 'x' },
      usage(null),
      usage({}),
      usage({ five_hour: null, seven_day: null }),
      usage({ five_hour: 'x' }),
      usage({ five_hour: { utilization: '42%', resets_at: null } }),
      usage({ five_hour: window(10, 'not a date') }),
      usage({ five_hour: { utilization: 10, resets_at: 1_800_000_000 } }),
      usage({ five_hour: window(10, null), extra_usage: { is_enabled: 'yes' } }),
    ]) {
      expect(quotaFromUsage(odd, NOW)).toBeNull();
    }
  });
});

describe('the CLI texts', () => {
  test('usage-limit texts are limit hits; warnings and transition notices are not', () => {
    for (const text of [
      "You've hit your session limit · resets 3pm",
      "You've reached your weekly limit",
      "You're out of extra usage · resets Feb 1",
      'Your org is out of usage · add funds to continue',
      'Fable requires usage credits.',
      'Fable 5 Max requires usage credits. Switch models.',
      `  ${USAGE_LIMIT_PREFIXES[0]} limit`,
      // The text of a rejected status whose overage the organisation's service level disables.
      'This service is disabled for your org',
    ]) {
      expect(isLimitHitText(text)).toBe(true);
    }
    for (const text of [
      "You've used 90% of your session limit",
      "You're close to your weekly limit",
      'Now using extra usage',
      'API Error: 429 rate_limit_error',
      'the model said "You\'ve hit your limit" mid-sentence',
      '',
    ]) {
      expect(isLimitHitText(text)).toBe(false);
    }
  });

  test('usage-transition notices are paid-usage notices', () => {
    for (const text of USAGE_TRANSITION_PREFIXES) expect(isPaidUsageNotice(`${text} · resets 3pm`)).toBe(true);
    expect(isPaidUsageNotice("You're now using extra usage")).toBe(true);
    expect(isPaidUsageNotice("You've hit your session limit")).toBe(false);
    expect(isPaidUsageNotice('We are now using extra usage')).toBe(false);
  });
});
