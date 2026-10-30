// The runner's turn policy (design 6.8, 6.10, 7.1), one per live agent. It reads the agent's events after the pump
// and decides what the runner sends on its own:
// - Continuation: a worker whose turn completed normally, with no successful submit, declare_blocked,
//   declare_impossible or release_task, gets a continuation prompt listing the task's acceptance ids once
//   continuationWait has passed with no hold or stop arriving and no new turn. Never after a failed or interrupted
//   turn, for leads, or after a tool answered "hub unreachable". One due while the link is down waits for the next
//   welcome.
// - The outage nudge (X-38): an attempt whose turn ended because of an outage (a hub-unreachable answer, or the
//   runner's own interrupt in needs_login) gets one "the agflow hub is reachable again; retry the tool that failed"
//   once the hub is back: at the next welcome, or as soon as the turn ends when the link is up by then or a welcome
//   came during the turn. It is the only message after an outage, once per welcome.
// - Vendor errors: phase vendor_error, and the turn retried after a delay that doubles from 30 s to 10 minutes; such
//   turns count toward no continuation, no-progress or loop (the facts leave them out).
// - Quota (X-14): a limit hit, or paid usage in use while allowPaidUsage is false for the vendor, interrupts the
//   turn, sets quota_wait and reports attempt.quota; at resetsAt, however far ahead, or every quotaUnknown when the
//   reset is unknown or already past, the wait ends, attempt.quota reports state ok and the turn resumes. Until then
//   the wait holds: nothing is sent, and a turn that starts (a delivery's) is interrupted. A hit that is only paid
//   usage is reported with no account, since the account itself is not exhausted and allowPaidUsage is per runner.
// - Other vendor outcomes (auth, context, policy, denials, session_budget) are reported as attempt.vendor_outcome.
import { randomUUID } from 'node:crypto';
import {
  type AttemptPhase,
  type AttemptSpec,
  VENDOR_OUTCOME_KINDS,
  type VendorOutcomeKind,
  type VendorQuota,
} from '@agflow/core';
import type { AgentEvent, AgentSession, TerminalTool } from '../adapters/types';
import { doublingDelay } from '../backoff';
import type { RunnerTimings } from '../config';
import type { Logger } from '../log';
import { clip, LONG_TEXT_MAX, type PumpEvent } from './pump';

/** The one message after an outage (X-38). */
export const OUTAGE_NUDGE = 'the agflow hub is reachable again; retry the tool that failed';

/** What resumes a turn once the usage limit has reset. */
export const QUOTA_RESUME_PROMPT = 'The usage limit has reset. Continue where you stopped.';

/** The longest delay a timer takes (2^31 - 1 ms, about 24.8 days): a longer one fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** The terminal tools whose success ends continuations: the handoff note does not. */
const ENDING_TOOLS: readonly TerminalTool[] = ['submit', 'blocked', 'impossible', 'released'];

/** The continuation prompt (design 6.8), naming the task's acceptance criteria. */
export function continuationPrompt(acceptanceIds: readonly string[]): string {
  const criteria =
    acceptanceIds.length === 0 ? 'its acceptance criteria' : `acceptance criteria ${acceptanceIds.join(', ')}`;
  return (
    `Continue working on your task until ${criteria} hold. Then call submit; if you cannot finish it, call ` +
    'declare_blocked or declare_impossible, or release_task to give it back.'
  );
}

/** The retry after a turn the vendor failed. */
export function vendorRetryPrompt(vendor: AttemptSpec['vendor']): string {
  return `Your last turn failed with an error from ${vendor}. Continue where you stopped.`;
}

/** The delay before vendor-error retry number attempt (from 0): 30 s doubling to 10 minutes by default. */
export function vendorRetryDelay(attempt: number, timings: Pick<RunnerTimings, 'vendorErrorBackoff'>): number {
  return doublingDelay(attempt, timings.vendorErrorBackoff);
}

/** A limit hit: an exhausted window, or paid usage in use where the owner does not allow it (design 6.10). */
export function isLimitHit(quota: VendorQuota, allowPaidUsage: boolean): boolean {
  return quota.state === 'exhausted' || (quota.paidUsage === 'in_use' && !allowPaidUsage);
}

export interface TurnPolicyOptions {
  attemptId: string;
  /** The attempt's spec as of its last start or resume: role, vendor and acceptance ids. */
  spec(): Pick<AttemptSpec, 'role' | 'vendor' | 'acceptanceIds'>;
  session: Pick<AgentSession, 'send' | 'interrupt'>;
  /** Whether a turn runs now. */
  inTurn(): boolean;
  /** A stop or hold arrived: nothing more is sent. */
  stopping(): boolean;
  /** Whether the link to the hub is up. */
  linkUp(): boolean;
  /** runner.json's allowPaidUsage for the attempt's vendor, as it is now. */
  allowPaidUsage(): boolean;
  timings(): Pick<RunnerTimings, 'continuationWait' | 'vendorErrorBackoff' | 'quotaUnknown'>;
  setPhase(phase: AttemptPhase): void;
  report(event: PumpEvent): void;
  /** Counts a continuation in the facts. */
  continuationSent(): void;
  logger: Logger;
  /** Date.now by default: resetsAt is epoch ms. */
  now?: () => number;
}

/** A limit hit the attempt waits on, and the account its reports name. */
interface QuotaWait {
  quota: VendorQuota;
  /** null for a hit that is only paid usage. */
  accountId: string | null;
}

export class TurnPolicy {
  private readonly options: TurnPolicyOptions;
  /** A continuation, a vendor-error retry or the outage nudge. */
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** The end of a quota wait; a new turn does not cancel it. */
  private quotaTimer: ReturnType<typeof setTimeout> | null = null;
  /** A submit, declare_blocked, declare_impossible or release_task succeeded: no continuation ever follows. */
  private ended = false;
  /** A tool of the running turn answered "hub unreachable". */
  private unreachable = false;
  /** A welcome arrived since that answer: the hub is back before the turn ends. */
  private returned = false;
  /** A turn ended because of an outage: the next welcome sends the nudge. */
  private outage = false;
  /** The nudge went out since the last welcome: a hub that fails again waits for the next one. */
  private nudged = false;
  /** A continuation fell due while the link was down: the next welcome sends it. */
  private owed = false;
  private vendorErrors = 0;
  /** The wait of a limit hit; null when not waiting. */
  private waiting: QuotaWait | null = null;
  private lastQuota: { accountId: string | null; quota: VendorQuota } | null = null;
  private closed = false;

  constructor(options: TurnPolicyOptions) {
    this.options = options;
  }

  /** Every agent event, after the pump has handled it; nothing once the process is gone. */
  observe(event: AgentEvent): void {
    if (this.closed) return;
    switch (event.type) {
      case 'turn_started':
        // Whatever was scheduled, a turn runs now; only a quota wait goes on.
        this.cancel();
        this.unreachable = false;
        this.returned = false;
        this.owed = false;
        if (this.waiting !== null) this.interruptInWait();
        return;
      case 'tool_ended':
        if (event.hubUnreachable) {
          this.unreachable = true;
          this.returned = false;
        }
        if (event.terminal !== null && ENDING_TOOLS.includes(event.terminal)) this.ended = true;
        return;
      case 'quota':
        this.lastQuota = { accountId: event.accountId, quota: event.quota };
        if (isLimitHit(event.quota, this.options.allowPaidUsage())) this.limitHit(this.lastQuota);
        return;
      case 'turn_ended':
        this.turnEnded(event);
        return;
      default:
        return;
    }
  }

  /** The runner's own interrupt in needs_login: the turn ended because of the outage (X-38). */
  async interruptForOutage(): Promise<void> {
    if (!this.options.inTurn()) return;
    this.outage = true;
    this.cancel();
    await this.options.session.interrupt();
  }

  /**
   * After each welcome: the one nudge, for an attempt whose turn ended because of the outage, or the continuation
   * that fell due while the link was down. A turn still running after a hub-unreachable answer gets its nudge when it
   * ends.
   */
  async onWelcome(): Promise<void> {
    if (this.closed) return;
    this.nudged = false;
    if (this.unreachable) this.returned = true;
    if (this.options.stopping()) return;
    if (this.outage) {
      this.outage = false;
      this.owed = false;
      this.nudged = true;
      await this.send(OUTAGE_NUDGE, 'the outage nudge');
      return;
    }
    if (this.owed) {
      this.owed = false;
      await this.sendContinuation();
    }
  }

  /** The agent's process is gone: nothing more is scheduled. */
  close(): void {
    this.closed = true;
    this.cancel();
    if (this.quotaTimer !== null) clearTimeout(this.quotaTimer);
    this.quotaTimer = null;
  }

  private turnEnded(event: Extract<AgentEvent, { type: 'turn_ended' }>): void {
    const outage = this.unreachable;
    this.unreachable = false;
    if (this.waiting !== null) {
      // The limit still holds, however the turn ended: no continuation and no retry until the wait ends.
      if (outage) this.outage = true;
      this.options.setPhase('quota_wait');
      return;
    }
    if (outage) this.outageEnded();
    if (event.outcome === 'completed') {
      this.vendorErrors = 0;
      if (!outage) this.continueLater();
      return;
    }
    if (event.outcome !== 'failed') return;
    if (event.errorKind === 'vendor') {
      this.vendorError(event.error);
    } else if (event.errorKind === 'quota') {
      this.limitHit(this.quotaAtLimit());
    } else if (event.errorKind !== null && (VENDOR_OUTCOME_KINDS as readonly string[]).includes(event.errorKind)) {
      const kind = event.errorKind as VendorOutcomeKind;
      const detail = event.error === null ? null : clip(event.error, LONG_TEXT_MAX);
      this.options.report({ type: 'attempt.vendor_outcome', data: { kind, detail } });
    }
  }

  /**
   * A turn ended because a tool could not reach the hub. When the hub is back already (the link is up, or a welcome
   * came during the turn), the nudge goes at once, once per welcome; otherwise the next welcome sends it.
   */
  private outageEnded(): void {
    const back = this.returned || this.options.linkUp();
    this.returned = false;
    if (!back || this.nudged) {
      this.outage = true;
      return;
    }
    this.nudged = true;
    this.schedule(0, async () => {
      await this.send(OUTAGE_NUDGE, 'the outage nudge');
    });
  }

  /**
   * What a turn that failed at its limit reports: the last quota report when it was a hit whose reset is still
   * ahead, else the reset unknown.
   */
  private quotaAtLimit(): { accountId: string | null; quota: VendorQuota } {
    const last = this.lastQuota;
    if (last !== null && isLimitHit(last.quota, this.options.allowPaidUsage()) && !this.resetPassed(last.quota)) {
      return last;
    }
    const windows = last?.quota.windows ?? { fiveHour: null, weekly: null };
    const paidUsage = last?.quota.paidUsage ?? 'unknown';
    return {
      accountId: last?.accountId ?? null,
      quota: { state: 'exhausted', resetsAt: null, windows, paidUsage, updatedAt: this.now() },
    };
  }

  /** Whether a report's reset time has come: the limit outlasted it, so the reset is unknown now. */
  private resetPassed(quota: VendorQuota): boolean {
    return quota.resetsAt !== null && quota.resetsAt <= this.now();
  }

  /** A worker's continuation, once continuationWait has passed with no hold, stop or new turn. */
  private continueLater(): void {
    const { spec, timings } = this.options;
    if (spec().role !== 'worker' || this.ended || this.outage) return;
    this.schedule(timings().continuationWait, async () => {
      if (this.ended || this.outage || this.options.inTurn()) return;
      if (!this.options.linkUp()) {
        this.owed = true;
        return;
      }
      await this.sendContinuation();
    });
  }

  private async sendContinuation(): Promise<void> {
    if (this.ended || this.options.inTurn()) return;
    const prompt = continuationPrompt(this.options.spec().acceptanceIds);
    if (await this.send(prompt, 'a continuation')) this.options.continuationSent();
  }

  private vendorError(error: string | null): void {
    this.options.setPhase('vendor_error');
    const delayMs = vendorRetryDelay(this.vendorErrors, this.options.timings());
    this.vendorErrors += 1;
    const { attemptId, logger } = this.options;
    logger.warn('the vendor failed the turn; retrying', { attemptId, delayMs, error });
    this.schedule(delayMs, async () => {
      if (this.options.inTurn()) return;
      await this.send(vendorRetryPrompt(this.options.spec().vendor), 'a vendor-error retry');
    });
  }

  /**
   * A limit hit: the turn is interrupted, quota_wait set and the wait reported, until the reset; a reset unknown or
   * already past is waited for quotaUnknown.
   */
  private limitHit(hit: { accountId: string | null; quota: VendorQuota }): void {
    if (this.waiting !== null) return;
    this.cancel();
    // Only an exhausted window is the account's: paid usage in use is this runner's refusal (allowPaidUsage).
    const wait: QuotaWait = { quota: hit.quota, accountId: hit.quota.state === 'exhausted' ? hit.accountId : null };
    this.waiting = wait;
    this.options.setPhase('quota_wait');
    const { vendor } = this.options.spec();
    // Paid usage in use counts as exhausted, so the hub moves the attempt to quota_wait too.
    const quota: VendorQuota = { ...hit.quota, state: 'exhausted' };
    this.options.report({ type: 'attempt.quota', data: { vendor, accountId: wait.accountId, quota } });
    if (this.options.inTurn()) this.interruptInWait();
    this.armWait(wait);
  }

  /**
   * The timer of a wait: at resetsAt, or quotaUnknown from now when the reset is unknown or already past. The wait
   * ends only once the runner's clock has passed that time: a reset further ahead than the longest timer (a monthly
   * window) is reached in steps of it, and a timer that fires early is armed again for what is left.
   */
  private armWait(wait: QuotaWait, until?: number): void {
    const { resetsAt } = wait.quota;
    const now = this.now();
    const end = until ?? (resetsAt !== null && resetsAt > now ? resetsAt : now + this.options.timings().quotaUnknown);
    this.quotaTimer = setTimeout(() => {
      this.quotaTimer = null;
      if (this.closed || this.options.stopping() || this.waiting !== wait) return;
      if (end > this.now()) {
        this.armWait(wait, end);
        return;
      }
      this.endWait(wait).catch((error) => {
        this.options.logger.error('the turn policy failed', { attemptId: this.options.attemptId, error: String(error) });
      });
    }, Math.min(Math.max(end - now, 0), MAX_TIMER_MS));
    this.quotaTimer.unref?.();
  }

  /** The wait is over: attempt.quota ok, and the turn resumes unless one runs already. */
  private async endWait(wait: QuotaWait): Promise<void> {
    if (this.waiting !== wait) return;
    this.waiting = null;
    const { vendor } = this.options.spec();
    const ok: VendorQuota = { ...wait.quota, state: 'ok', updatedAt: this.now() };
    this.options.report({ type: 'attempt.quota', data: { vendor, accountId: wait.accountId, quota: ok } });
    if (this.options.inTurn()) {
      this.options.setPhase('turn');
      return;
    }
    this.options.setPhase('idle');
    await this.send(QUOTA_RESUME_PROMPT, 'the resume after a quota wait');
  }

  /**
   * A turn runs while the limit holds (the hit's own turn, or one a delivery started): it is interrupted, so it uses
   * no exhausted or paid quota. A stop's handoff turn is left to run.
   */
  private interruptInWait(): void {
    if (this.options.stopping()) return;
    this.options.session.interrupt().catch((error) => {
      this.options.logger.warn('cannot interrupt a turn at its limit', {
        attemptId: this.options.attemptId,
        error: String(error),
      });
    });
  }

  private schedule(ms: number, run: () => Promise<void>): void {
    this.cancel();
    if (this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.closed || this.options.stopping()) return;
      run().catch((error) => {
        this.options.logger.error('the turn policy failed', { attemptId: this.options.attemptId, error: String(error) });
      });
    }, ms);
    this.timer.unref?.();
  }

  private cancel(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Sends a system message of the runner's; gives whether the agent took it. */
  private async send(text: string, what: string): Promise<boolean> {
    try {
      await this.options.session.send({ id: randomUUID(), text, authority: 'system' });
      return true;
    } catch (error) {
      this.options.logger.warn(`cannot send ${what}`, { attemptId: this.options.attemptId, error: String(error) });
      return false;
    }
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}
