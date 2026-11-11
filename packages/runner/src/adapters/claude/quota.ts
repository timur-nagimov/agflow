// Claude's quota signals as one VendorQuota per account (design 8.3, 8.1, 6.10): rate_limit_event, the CLI's
// usage-limit and usage-transition texts, and preflight's usage call (X-29). The adapter reports facts only, such as
// paidUsage 'in_use'; the attempt controller applies allowPaidUsage (X-14).
import type { VendorQuota } from '@agflow/core';
import type { SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk';
import { isRecord } from './json';

/** The texts 2.1.285 starts a usage-limit message with; copied from the binary, so they change with the pin. */
export const USAGE_LIMIT_PREFIXES: readonly string[] = Object.freeze([
  "You've hit your",
  "You've reached your",
  "You're out of usage credits",
  'Your org is out of usage · add funds to continue',
  'Your org is out of usage · contact your admin',
  "Your seat type doesn't include usage credits",
  "Your seat type doesn't include usage",
  'Your usage allocation has been disabled by your admin',
  "Your group's usage limit is set to $0",
  'Fable 5 requires usage credits',
  "You're out of extra usage",
  "Your seat type doesn't include extra usage",
]);

/**
 * The text 2.1.285 gives a rejected status whose overage the organisation's service level disables; the binary keeps
 * it in a list of its own, but it is a limit hit like the texts above.
 */
export const USAGE_DISABLED_PREFIXES: readonly string[] = Object.freeze(['This service is disabled for your org']);

/** The usage-limit messages 2.1.285 matches by pattern rather than prefix. */
const USAGE_LIMIT_PATTERNS: readonly RegExp[] = [/^Fable(?: [^·\n]{1,40})? requires usage credits\./];

/** The texts 2.1.285 starts a usage-transition notice with: from here on the work draws on paid usage. */
export const USAGE_TRANSITION_PREFIXES: readonly string[] = Object.freeze([
  "You're now using usage credits",
  "You're now using your usage allocation",
  'Now using your usage allocation',
  'Now using usage credits',
  "You're now using extra usage",
  'Now using extra usage',
]);

/** Whether a message, such as a failed turn's result, is the CLI saying a usage limit was hit. */
export function isLimitHitText(text: string): boolean {
  const start = text.trimStart();
  return (
    USAGE_LIMIT_PREFIXES.some((prefix) => start.startsWith(prefix)) ||
    USAGE_DISABLED_PREFIXES.some((prefix) => start.startsWith(prefix)) ||
    USAGE_LIMIT_PATTERNS.some((pattern) => pattern.test(start))
  );
}

/** Whether a message is the CLI's notice that the work now draws on paid usage. */
export function isPaidUsageNotice(text: string): boolean {
  const start = text.trimStart();
  return USAGE_TRANSITION_PREFIXES.some((prefix) => start.startsWith(prefix));
}

/**
 * One rate_limit_event's info as a quota. A rejected status is exhausted unless the CLI goes on with paid usage
 * (isUsingOverage or overageInUse): the controller then decides by allowPaidUsage. The event's utilization fills the
 * window its rateLimitType names; the untyped unifiedWindows, when present, fill the others.
 */
export function toVendorQuota(info: SDKRateLimitInfo, now: number): VendorQuota {
  const unified = unifiedWindows((info as { unifiedWindows?: unknown }).unifiedWindows);
  const own = fraction(info.utilization);
  const type = info.rateLimitType;
  const usingPaid = info.isUsingOverage === true || info.overageInUse === true;
  let paidUsage: VendorQuota['paidUsage'] = 'unknown';
  if (usingPaid || type === 'overage') paidUsage = 'in_use';
  else if (info.overageDisabledReason !== undefined || info.overageStatus === 'rejected') paidUsage = 'disabled';
  else if (info.overageStatus === 'allowed' || info.overageStatus === 'allowed_warning') paidUsage = 'enabled';
  return {
    state: info.status === 'rejected' && !usingPaid ? 'exhausted' : 'ok',
    resetsAt: epochMs(info.resetsAt),
    windows: {
      fiveHour: type === 'five_hour' && own !== null ? own : unified.fiveHour,
      weekly: type?.startsWith('seven_day') && own !== null ? own : unified.weekly,
    },
    paidUsage,
    updatedAt: now,
  };
}

/**
 * The quota preflight's usage call gives (X-29): rate_limits.five_hour and seven_day in percent with ISO reset times,
 * and extra_usage.is_enabled. A window at 100% is exhausted until the limiting window's reset, unless extra usage is
 * enabled. Null for rate_limits null, no window, or any shape this pin does not produce.
 */
export function quotaFromUsage(usage: unknown, now: number): VendorQuota | null {
  if (!isRecord(usage) || !isRecord(usage.rate_limits)) return null;
  const limits = usage.rate_limits;
  const fiveHour = usageWindow(limits.five_hour);
  const weekly = usageWindow(limits.seven_day);
  if (fiveHour === undefined || weekly === undefined) return null;
  let paidUsage: VendorQuota['paidUsage'] = 'unknown';
  if (isRecord(limits.extra_usage)) {
    if (typeof limits.extra_usage.is_enabled !== 'boolean') return null;
    paidUsage = limits.extra_usage.is_enabled ? 'enabled' : 'disabled';
  } else if (limits.extra_usage !== undefined && limits.extra_usage !== null) {
    return null;
  }
  const known = [fiveHour, weekly].filter(
    (window): window is UsageWindow => window !== null && window.utilization !== null,
  );
  if (known.length === 0) return null;
  const limiting = known.reduce((a, b) => ((b.utilization ?? 0) > (a.utilization ?? 0) ? b : a));
  const full = (limiting.utilization ?? 0) >= 1;
  return {
    state: full && paidUsage !== 'enabled' ? 'exhausted' : 'ok',
    resetsAt: limiting.resetsAt,
    windows: { fiveHour: fiveHour?.utilization ?? null, weekly: weekly?.utilization ?? null },
    paidUsage,
    updatedAt: now,
  };
}

/**
 * The last quota per account. rate_limit_event fires only when something changes, so each report is merged into the
 * last: a window or paid-usage fact the report leaves unknown keeps its last value.
 */
export class QuotaBook {
  private readonly quotas = new Map<string | null, VendorQuota>();

  constructor(private readonly now: () => number = Date.now) {}

  last(accountId: string | null): VendorQuota | null {
    return this.quotas.get(accountId) ?? null;
  }

  /** Merges a report into the account's last quota, and gives the result. */
  update(accountId: string | null, quota: VendorQuota): VendorQuota {
    const previous = this.quotas.get(accountId);
    const merged: VendorQuota =
      previous === undefined
        ? quota
        : {
            state: quota.state === 'unknown' ? previous.state : quota.state,
            resetsAt: quota.resetsAt ?? carriedReset(previous, quota),
            windows: {
              fiveHour: quota.windows.fiveHour ?? previous.windows.fiveHour,
              weekly: quota.windows.weekly ?? previous.windows.weekly,
            },
            paidUsage: quota.paidUsage === 'unknown' ? previous.paidUsage : quota.paidUsage,
            updatedAt: quota.updatedAt,
          };
    this.quotas.set(accountId, merged);
    return merged;
  }

  rateLimit(accountId: string | null, info: SDKRateLimitInfo): VendorQuota {
    let quota = toVendorQuota(info, this.now());
    // isUsingOverage false is a fact even without overage fields: paid usage the book holds as in use has ended, and
    // since it was in use, extra usage is on.
    const notInUse = info.isUsingOverage === false && info.overageInUse !== true && info.rateLimitType !== 'overage';
    if (quota.paidUsage === 'unknown' && notInUse && this.last(accountId)?.paidUsage === 'in_use') {
      quota = { ...quota, paidUsage: 'enabled' };
    }
    return this.update(accountId, quota);
  }

  /** A usage-transition notice: the work draws on paid usage now. */
  paidUsageInUse(accountId: string | null): VendorQuota {
    return this.update(accountId, {
      state: 'unknown',
      resetsAt: null,
      windows: { fiveHour: null, weekly: null },
      paidUsage: 'in_use',
      updatedAt: this.now(),
    });
  }
}

/**
 * The reset time a report without one keeps from the last quota. A reset time belongs to its state: an exhausted report
 * without one is exhausted with resetsAt null (8.3), and a state change leaves it unknown. Only an unknown report, or
 * an ok one after ok, keeps the last reset, and only while it is still ahead.
 */
function carriedReset(previous: VendorQuota, quota: VendorQuota): number | null {
  const keeps = quota.state === 'unknown' || (quota.state === 'ok' && previous.state === 'ok');
  return keeps && previous.resetsAt !== null && previous.resetsAt > quota.updatedAt ? previous.resetsAt : null;
}

/** The untyped unifiedWindows of 2.1.285: five_hour, seven_day and seven_day_overage_included, each 0..1. */
function unifiedWindows(value: unknown): VendorQuota['windows'] {
  if (!isRecord(value)) return { fiveHour: null, weekly: null };
  const utilization = (key: string) => {
    const window = value[key];
    return isRecord(window) ? fraction(window.utilization) : null;
  };
  const weekly = [utilization('seven_day'), utilization('seven_day_overage_included')].filter((u) => u !== null);
  return { fiveHour: utilization('five_hour'), weekly: weekly.length > 0 ? Math.max(...weekly) : null };
}

interface UsageWindow {
  utilization: number | null;
  resetsAt: number | null;
}

/** A usage-call window: null when absent, undefined when its shape is not the pinned one. */
function usageWindow(value: unknown): UsageWindow | null | undefined {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) return undefined;
  const { utilization, resets_at } = value;
  if (utilization !== null && utilization !== undefined && typeof utilization !== 'number') return undefined;
  if (resets_at !== null && resets_at !== undefined && typeof resets_at !== 'string') return undefined;
  const resetsAt = typeof resets_at === 'string' ? Date.parse(resets_at) : null;
  if (Number.isNaN(resetsAt)) return undefined;
  return { utilization: typeof utilization === 'number' ? fraction(utilization / 100) : null, resetsAt };
}

/** 0..1, or null for anything that is not a finite number. */
function fraction(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(1, Math.max(0, value));
}

// Below this an epoch value is in seconds: 1e11 seconds is the year 5138, 1e11 ms early 1973.
const SECONDS_BELOW = 1e11;

/** Epoch ms from the CLI's epoch seconds (or ms), or null. */
function epochMs(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value < SECONDS_BELOW ? value * 1000 : value);
}
