import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { VendorQuotaSchema, type VendorQuota } from '@agflow/core';
import {
  type CodexErrorKind, isFinalError, mergeRateLimits, quotaFromRateLimits, turnErrorKind,
} from '../../src/adapters/codex/classify';
import type { ParamsOf } from '../../src/adapters/codex/methods';
import type { CodexErrorInfo, RateLimitSnapshot, RateLimitWindow } from '../../src/adapters/codex/protocol/v2';

const now = 1_794_226_000_000;
const reset = 1_794_228_000;

function snapshot(overrides: Partial<RateLimitSnapshot> = {}): RateLimitSnapshot {
  return {
    limitId: 'codex', limitName: null, normalModelSlug: null, primary: null, secondary: null,
    credits: null, individualLimit: null, spendControlReached: null, planType: null,
    rateLimitReachedType: null, ...overrides,
  };
}

function window(
  usedPercent: number,
  windowDurationMins: number | null = 300,
  resetsAt: number | null = reset,
): RateLimitWindow {
  return { usedPercent, windowDurationMins, resetsAt };
}

function quota(input: RateLimitSnapshot, at: number | undefined = now): VendorQuota {
  const result = quotaFromRateLimits(input, at);
  expect(VendorQuotaSchema.parse(result)).toEqual(result);
  return result;
}

function error(codexErrorInfo: CodexErrorInfo | null, willRetry = false): ParamsOf<'error'> {
  return {
    threadId: 'thread', turnId: 'turn', willRetry,
    error: { message: 'failed', codexErrorInfo, additionalDetails: null, misalignment: null },
  };
}

describe('turnErrorKind', () => {
  test('maps the generated string variants to runner outcomes', () => {
    const cases: [CodexErrorInfo, CodexErrorKind][] = [
      ['usageLimitExceeded', 'quota'], ['unauthorized', 'auth'], ['contextWindowExceeded', 'context'],
      ['cyberPolicy', 'policy'], ['misalignmentPolicyViolation', 'policy'], ['tooManyDenials', 'denials'],
      ['sessionBudgetExceeded', 'session_budget'], ['rateLimitExceeded', 'vendor'], ['serverOverloaded', 'vendor'],
      ['internalServerError', 'vendor'], ['sandboxError', 'vendor'], ['badRequest', 'vendor'], ['other', 'vendor'],
      ['flexUnavailable', 'vendor'], ['threadRollbackFailed', 'vendor'],
    ];
    for (const [info, expected] of cases) expect(turnErrorKind(info)).toBe(expected);
  });

  test('recognizes provider 401s only on the connection error variants', () => {
    for (const httpStatusCode of [401, 403, 429, 500, null]) {
      const connection = [
        { httpConnectionFailed: { httpStatusCode } },
        { responseStreamConnectionFailed: { httpStatusCode } },
      ];
      for (const info of connection) {
        expect(turnErrorKind(info)).toBe(httpStatusCode === 401 ? 'auth' : 'vendor');
      }
      expect(turnErrorKind({ responseStreamDisconnected: { httpStatusCode } })).toBe('vendor');
      expect(turnErrorKind({ responseTooManyFailedAttempts: { httpStatusCode } })).toBe('vendor');
    }
  });

  test('unknown runtime strings, objects and null remain vendor errors', () => {
    for (const info of ['futureError', 'toString', '__proto__', { futureError: {} }, null]) {
      expect(turnErrorKind(info as CodexErrorInfo | null, null)).toBe('vendor');
    }
  });

  test('a reached type turns only generic vendor failures into quota, and never a steer rejection', () => {
    const reached = snapshot({ rateLimitReachedType: 'workspace_owner_credits_depleted' });
    const generic = ['other', 'internalServerError', null, 'futureError', { futureError: {} }];
    for (const info of generic) {
      expect(turnErrorKind(info as CodexErrorInfo | null, reached)).toBe('quota');
    }
    const specific: [CodexErrorInfo, CodexErrorKind][] = [
      ['unauthorized', 'auth'], [{ httpConnectionFailed: { httpStatusCode: 401 } }, 'auth'],
      ['contextWindowExceeded', 'context'], ['cyberPolicy', 'policy'], ['misalignmentPolicyViolation', 'policy'],
      ['tooManyDenials', 'denials'], ['sessionBudgetExceeded', 'session_budget'], ['usageLimitExceeded', 'quota'],
    ];
    for (const [info, expected] of specific) expect(turnErrorKind(info, reached)).toBe(expected);
    for (const turnKind of ['review', 'compact'] as const) {
      const info = { activeTurnNotSteerable: { turnKind } };
      expect(turnErrorKind(info)).toBeNull();
      expect(turnErrorKind(info, reached)).toBeNull();
    }
  });
});

describe('isFinalError', () => {
  test('ignores retries and steer rejections, accepting every other final error', () => {
    const infos = ['usageLimitExceeded', 'other', null, { httpConnectionFailed: { httpStatusCode: 401 } }] as const;
    for (const info of infos) {
      expect(isFinalError(error(info, true))).toBe(false);
      expect(isFinalError(error(info))).toBe(true);
    }
    for (const turnKind of ['review', 'compact'] as const) {
      expect(isFinalError(error({ activeTurnNotSteerable: { turnKind } }))).toBe(false);
    }
  });
});

describe('mergeRateLimits', () => {
  test('returns the initial snapshot unchanged', () => {
    const update = snapshot();
    expect(mergeRateLimits(null, update)).toBe(update);
  });

  test('retains only absent windows and credits, and clears the reached type', () => {
    const previous = snapshot({
      primary: window(100), secondary: window(7, 10080),
      credits: { hasCredits: true, unlimited: false, balance: '12.5' },
      limitName: 'Codex', normalModelSlug: 'model', planType: 'pro', spendControlReached: true,
      rateLimitReachedType: 'rate_limit_reached',
    });
    const update = snapshot();
    const original = structuredClone({ previous, update });
    expect(mergeRateLimits(previous, update)).toEqual({
      ...update, primary: previous.primary, secondary: previous.secondary, credits: previous.credits,
    });
    const recovery = mergeRateLimits(previous, snapshot({ primary: window(20) }));
    expect(quota(recovery).state).toBe('ok');
    expect(turnErrorKind('other', recovery)).toBe('vendor');
    expect({ previous, update }).toEqual(original);
  });

  test('ignores updates for other metered buckets', () => {
    const codex = snapshot({
      primary: window(100), secondary: window(40, 10080), credits: { hasCredits: false, unlimited: false, balance: null },
    });
    const other = snapshot({
      limitId: 'codex_other', primary: window(3), secondary: window(4, 10080),
      credits: { hasCredits: true, unlimited: false, balance: '5' }, rateLimitReachedType: 'rate_limit_reached',
    });
    expect(mergeRateLimits(codex, other)).toBe(codex);
    expect(mergeRateLimits(null, other)).toBeNull();
    expect(quota(mergeRateLimits(codex, other))).toEqual(quota(codex));
    expect(quota(codex)).toMatchObject({ state: 'exhausted', windows: { fiveHour: 1, weekly: 0.4 } });
    expect(turnErrorKind('other', mergeRateLimits(codex, other))).toBe('vendor');
    const unnamed = snapshot({ limitId: null, primary: window(20) });
    expect(mergeRateLimits(codex, unnamed)).toEqual({ ...unnamed, secondary: codex.secondary, credits: codex.credits });
  });

  test('replaces present windows and credits, including zero usage and disabled credits', () => {
    const previous = snapshot({
      primary: window(90), secondary: window(80, 10080),
      credits: { hasCredits: true, unlimited: true, balance: '12.5' },
    });
    const update = snapshot({
      primary: window(0), secondary: window(0, 10080),
      credits: { hasCredits: false, unlimited: false, balance: '0' },
      rateLimitReachedType: 'workspace_member_usage_limit_reached',
    });
    expect(mergeRateLimits(previous, update)).toEqual(update);
  });
});

describe('quotaFromRateLimits', () => {
  test('maps durations before positional fallbacks and clamps utilization', () => {
    const cases: [RateLimitWindow | null, RateLimitWindow | null, VendorQuota['windows']][] = [
      [window(42), window(7, 10080), { fiveHour: 0.42, weekly: 0.07 }],
      [window(42, 10080), window(7), { fiveHour: 0.07, weekly: 0.42 }],
      [window(-5, null), window(150, 60), { fiveHour: 0, weekly: 1 }],
      [window(10, 60), window(20), { fiveHour: 0.2, weekly: null }],
      [window(10, 10080), window(20, null), { fiveHour: null, weekly: 0.1 }],
      [null, window(25, null), { fiveHour: null, weekly: 0.25 }],
      [window(12.5, null), null, { fiveHour: 0.125, weekly: null }],
    ];
    for (const [primary, secondary, expected] of cases) {
      expect(quota(snapshot({ primary, secondary })).windows).toEqual(expected);
    }
  });

  test('uses the limiting window reset, converting seconds to milliseconds', () => {
    const cases: [RateLimitWindow | null, RateLimitWindow | null, number | null][] = [
      [window(80), window(90, 10080, reset + 10), (reset + 10) * 1000],
      [window(90), window(80, 10080, reset + 10), reset * 1000],
      [window(100), window(40, 10080, reset + 10), reset * 1000],
      [window(100), window(100, 10080, reset + 10), (reset + 10) * 1000],
      [window(100, 300, reset + 10), window(100, 10080), (reset + 10) * 1000],
      [window(110), window(100, 10080, reset + 10), (reset + 10) * 1000],
      [window(100, 300, null), window(20, 10080), null],
      [window(20), window(90, 10080, null), null],
      [window(100), window(100, 10080, null), null],
      [window(100, 300, null), window(100, 10080), null],
      [null, window(10, 10080, reset + 10), (reset + 10) * 1000],
      [null, null, null],
      // A window whose reset has passed is empty: it neither limits nor supplies the reset.
      [window(100, 300, 1), window(40, 10080), reset * 1000],
      [window(100, 300, now / 1000), window(100, 10080, reset + 10), (reset + 10) * 1000],
      [window(90, 300, 1), window(40, 10080), reset * 1000],
      [window(100, 300, 1), window(100, 10080, 0), null],
    ];
    for (const [primary, secondary, expected] of cases) {
      expect(quota(snapshot({ primary, secondary })).resetsAt).toBe(expected);
    }
  });

  test('reports paid usage facts independently of the runner policy', () => {
    const cases: [RateLimitSnapshot['credits'], VendorQuota['paidUsage'], VendorQuota['paidUsage']][] = [
      [null, 'unknown', 'unknown'],
      [{ hasCredits: false, unlimited: false, balance: '12.5' }, 'disabled', 'disabled'],
      [{ hasCredits: true, unlimited: false, balance: null }, 'enabled', 'in_use'],
      [{ hasCredits: false, unlimited: true, balance: null }, 'enabled', 'in_use'],
    ];
    for (const [credits, idle, full] of cases) {
      expect(quota(snapshot({ credits }))).toMatchObject({ state: 'unknown', paidUsage: idle });
      expect(quota(snapshot({ credits, primary: window(99) }))).toMatchObject({ state: 'ok', paidUsage: idle });
      for (const windows of [{ primary: window(100) }, { secondary: window(100, 10080) }]) {
        expect(quota(snapshot({ credits, ...windows }))).toMatchObject({
          state: full === 'in_use' ? 'ok' : 'exhausted', paidUsage: full,
        });
      }
      expect(quota(snapshot({ credits, primary: window(100), rateLimitReachedType: 'rate_limit_reached' })))
        .toMatchObject({ state: 'exhausted', paidUsage: full });
    }
    expect(quota(snapshot({ rateLimitReachedType: 'workspace_member_credits_depleted' })))
      .toMatchObject({ state: 'exhausted', resetsAt: null });
  });

  test('treats a full window whose reset has passed as empty', () => {
    const past = window(100, 300, now / 1000 - 60);
    for (const credits of [null, { hasCredits: true, unlimited: false, balance: null }]) {
      expect(quota(snapshot({ credits, primary: past, secondary: window(30, 10080) }))).toMatchObject({
        state: 'ok', resetsAt: reset * 1000, windows: { fiveHour: 0, weekly: 0.3 },
        paidUsage: credits === null ? 'unknown' : 'enabled',
      });
    }
    expect(quota(snapshot({ primary: window(100, 300, now / 1000 + 1) })).state).toBe('exhausted');
  });

  test('uses the supplied timestamp or the current time without mutating the snapshot', () => {
    const input = snapshot({ primary: window(42) });
    const original = structuredClone(input);
    expect(quota(input).updatedAt).toBe(now);
    const before = Date.now();
    const current = quotaFromRateLimits(input);
    expect(VendorQuotaSchema.parse(current)).toEqual(current);
    expect(current.updatedAt).toBeGreaterThanOrEqual(before);
    expect(current.updatedAt).toBeLessThanOrEqual(Date.now());
    expect(input).toEqual(original);
  });
});

describe('recorded Codex 0.159.2 notifications', () => {
  type Method = 'turn/started' | 'account/rateLimits/updated' | 'error' | 'turn/completed';
  type Notification = { [M in Method]: { method: M; params: ParamsOf<M>; emittedAtMs: number } }[Method];
  const recorded: Record<string, Notification[]> = JSON.parse(
    readFileSync(new URL('./fixtures/recorded-notifications.json', import.meta.url), 'utf8'),
  );
  const expectedErrors: Record<string, CodexErrorKind | null> = {
    usageLimit: 'quota', http500: 'vendor', http401: 'auth', responseFailed: 'vendor',
    contextFailed: 'context', headerUpdates: null,
  };

  for (const [scenario, expectedError] of Object.entries(expectedErrors)) {
    test(scenario, () => {
      let merged: RateLimitSnapshot | null = null;
      const quotas: VendorQuota[] = [];
      const errors: (CodexErrorKind | null)[] = [];
      const completedErrors: (CodexErrorKind | null)[] = [];
      for (const notification of recorded[scenario]) {
        switch (notification.method) {
          case 'account/rateLimits/updated':
            expect(notification.params.rateLimits.limitId).toBe('codex');
            merged = mergeRateLimits(merged, notification.params.rateLimits);
            quotas.push(quota(merged!));
            break;
          case 'error':
            expect(isFinalError(notification.params)).toBe(true);
            if (isFinalError(notification.params)) {
              errors.push(turnErrorKind(notification.params.error.codexErrorInfo, merged));
            }
            break;
          case 'turn/completed':
            if (notification.params.turn.status === 'failed') {
              expect(notification.params.turn.error).not.toBeNull();
              completedErrors.push(turnErrorKind(notification.params.turn.error!.codexErrorInfo, merged));
            } else {
              expect(notification.params.turn.status).toBe('completed');
              expect(notification.params.turn.error).toBeNull();
            }
            break;
        }
      }
      expect(errors).toEqual(expectedError === null ? [] : [expectedError]);
      expect(completedErrors).toEqual(errors);
      if (scenario === 'usageLimit') {
        expect(quotas).toEqual([{
          state: 'exhausted', resetsAt: merged!.primary!.resetsAt! * 1000,
          windows: { fiveHour: 1, weekly: 0.4 }, paidUsage: 'unknown', updatedAt: now,
        }]);
      } else if (scenario === 'headerUpdates') {
        expect(quotas).toEqual([
          {
            state: 'ok', resetsAt: 1_794_229_640_000, windows: { fiveHour: 0.42, weekly: 0.07 },
            paidUsage: 'enabled', updatedAt: now,
          },
          {
            state: 'ok', resetsAt: 1_794_229_040_000, windows: { fiveHour: 1, weekly: 0.07 },
            paidUsage: 'in_use', updatedAt: now,
          },
        ]);
      } else {
        const count = scenario === 'contextFailed' ? 2 : scenario === 'responseFailed' ? 1 : 0;
        expect(quotas).toEqual(Array.from({ length: count }, () => ({
          state: 'unknown', resetsAt: null, windows: { fiveHour: null, weekly: null },
          paidUsage: 'unknown', updatedAt: now,
        })));
      }
    });
  }
});
