// Codex turn errors and rate-limit snapshots as the runner sees them (design 9.2 Errors and Quota, 6.10): the
// AgentEvent error kind of a failed turn and the account's VendorQuota. Pure: the session feeds it notifications, and
// the runner core applies allowPaidUsage to what it reports (X-14).
import type { VendorQuota } from '@agflow/core';
import type { AgentEvent } from '../types';
import type { ParamsOf } from './methods';
import type { CodexErrorInfo, RateLimitSnapshot, RateLimitWindow } from './protocol/v2';

export type CodexErrorKind = NonNullable<Extract<AgentEvent, { type: 'turn_ended' }>['errorKind']>;

// A protocol re-pin must place every new string variant, even though runtime unknowns stay vendor errors.
const ERROR_KINDS = {
  contextWindowExceeded: 'context',
  sessionBudgetExceeded: 'session_budget',
  usageLimitExceeded: 'quota',
  rateLimitExceeded: 'vendor',
  flexUnavailable: 'vendor',
  serverOverloaded: 'vendor',
  cyberPolicy: 'policy',
  misalignmentPolicyViolation: 'policy',
  tooManyDenials: 'denials',
  internalServerError: 'vendor',
  unauthorized: 'auth',
  badRequest: 'vendor',
  threadRollbackFailed: 'vendor',
  sandboxError: 'vendor',
  other: 'vendor',
} satisfies Record<Extract<CodexErrorInfo, string>, CodexErrorKind>;

/**
 * The error kind of a failed turn; null for activeTurnNotSteerable, which rejects a steer and never fails a turn.
 * rateLimits is the merged snapshot so far: a set rateLimitReachedType turns an otherwise generic vendor failure into
 * a quota one. It is account state, not this failure's cause, so it never overrides a specific kind.
 */
export function turnErrorKind(
  info: CodexErrorInfo | null,
  rateLimits?: RateLimitSnapshot | null,
): CodexErrorKind | null {
  const kind = errorInfoKind(info);
  return kind === 'vendor' && rateLimits?.rateLimitReachedType != null ? 'quota' : kind;
}

function errorInfoKind(info: CodexErrorInfo | null): CodexErrorKind | null {
  // A steer rejection never ends a turn, even while the account is exhausted.
  if (info !== null && typeof info === 'object' && 'activeTurnNotSteerable' in info) return null;
  if (typeof info === 'string') {
    return Object.hasOwn(ERROR_KINDS, info) ? ERROR_KINDS[info] : 'vendor';
  }
  if (info !== null && typeof info === 'object') {
    if ('httpConnectionFailed' in info && info.httpConnectionFailed?.httpStatusCode === 401) return 'auth';
    if ('responseStreamConnectionFailed' in info && info.responseStreamConnectionFailed?.httpStatusCode === 401) {
      return 'auth';
    }
  }
  return 'vendor';
}

/** The adapter acts only on the error Codex gives up on (design 9.2): willRetry true means it is still retrying. */
export function isFinalError(params: ParamsOf<'error'>): boolean {
  return !params.willRetry && turnErrorKind(params.error.codexErrorInfo) !== null;
}

/**
 * Folds a sparse account/rateLimits/updated into the snapshot so far: null windows and credits keep their values.
 * Only the 'codex' bucket is the account's quota (as account/rateLimits/read reports it); updates for other metered
 * buckets leave the snapshot as it was.
 */
export function mergeRateLimits(previous: RateLimitSnapshot, update: RateLimitSnapshot): RateLimitSnapshot;
export function mergeRateLimits(previous: RateLimitSnapshot | null, update: RateLimitSnapshot): RateLimitSnapshot | null;
export function mergeRateLimits(
  previous: RateLimitSnapshot | null,
  update: RateLimitSnapshot,
): RateLimitSnapshot | null {
  if (update.limitId !== null && update.limitId !== 'codex') return previous;
  if (previous === null) return update;
  return {
    ...update,
    primary: update.primary ?? previous.primary,
    secondary: update.secondary ?? previous.secondary,
    credits: update.credits ?? previous.credits,
    // rateLimitReachedType comes from update: retaining it would hide recovery after a reset.
  };
}

function durationSlot(window: RateLimitWindow): keyof VendorQuota['windows'] | null {
  if (window.windowDurationMins === 300) return 'fiveHour';
  if (window.windowDurationMins === 10080) return 'weekly';
  return null;
}

// A window whose reset has passed counts as empty until a fresh update replaces it: sparse updates keep old windows.
function isReset(window: RateLimitWindow, now: number): boolean {
  return window.resetsAt !== null && window.resetsAt * 1000 <= now;
}

function utilization(window: RateLimitWindow, now: number): number {
  return isReset(window, now) ? 0 : Math.max(0, Math.min(1, window.usedPercent / 100));
}

function isFull(window: RateLimitWindow, now: number): boolean {
  return !isReset(window, now) && window.usedPercent >= 100;
}

function limitingReset(windows: RateLimitWindow[], now: number): number | null {
  const current = windows.filter((window) => !isReset(window, now));
  const full = current.filter((window) => window.usedPercent >= 100);
  if (full.length > 0) {
    // Every full window must reset before included usage can resume.
    if (full.some((window) => window.resetsAt === null)) return null;
    return Math.max(...full.map((window) => window.resetsAt!));
  }
  let limiting: RateLimitWindow | null = null;
  for (const window of current) {
    if (limiting === null || window.usedPercent > limiting.usedPercent) limiting = window;
  }
  return limiting?.resetsAt ?? null;
}

/**
 * The VendorQuota of a snapshot. Windows map by duration, then by position; resetsAt is the limiting window's. A full
 * window with credits is paid usage in use, reported with state ok for the runner core to judge.
 */
export function quotaFromRateLimits(snapshot: RateLimitSnapshot, now = Date.now()): VendorQuota {
  const positions = [snapshot.primary, snapshot.secondary];
  const available = positions.filter((window): window is RateLimitWindow => window !== null);
  const windows: VendorQuota['windows'] = { fiveHour: null, weekly: null };
  for (const window of available) {
    const slot = durationSlot(window);
    if (slot !== null) windows[slot] = utilization(window, now);
  }
  // Known durations reserve their slots before unknown durations fall back to position.
  for (const [index, window] of positions.entries()) {
    const slot = index === 0 ? 'fiveHour' : 'weekly';
    if (window !== null && durationSlot(window) === null && windows[slot] === null) {
      windows[slot] = utilization(window, now);
    }
  }

  const full = available.some((window) => isFull(window, now));
  const credits = snapshot.credits;
  const paidUsage: VendorQuota['paidUsage'] = credits === null
    ? 'unknown'
    : credits.hasCredits || credits.unlimited
      ? full ? 'in_use' : 'enabled'
      : 'disabled';
  const state: VendorQuota['state'] = snapshot.rateLimitReachedType !== null || (full && paidUsage !== 'in_use')
    ? 'exhausted'
    : available.length === 0 ? 'unknown' : 'ok';
  const reset = limitingReset(available, now);
  return {
    state,
    // Codex sends epoch seconds; the runner and hub share epoch milliseconds.
    resetsAt: reset === null ? null : reset * 1000,
    windows,
    paidUsage,
    updatedAt: now,
  };
}
