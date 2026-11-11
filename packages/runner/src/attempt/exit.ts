// The end of an agent process (design 7.4, 7.3, 6.8, 6.10). Whatever ended it, the final work comes before
// attempt.exited: the final harvest, strip and push, with retries for up to finalPush; the transcript tail, uploaded
// for the handoff note; and every pending approval voided. A final push that canPushWip forbids, or that keeps
// failing, leaves attempt.exited with finalWip null and a pushError (none when the hub already ended the attempt),
// and the work then goes to a late-work ref, retried with lateRetry backoff until it lands and is reported as
// attempt.late_work. The WIP ref never moves after attempt.exited. Waiting on the agent's events after its exit is
// always bounded.
import { TRANSCRIPT_TAIL_MAX_BYTES } from '@agflow/core';
import type { VendorAdapter } from '../adapters/types';
import { doublingDelay } from '../backoff';
import type { RunnerTimings } from '../config';
import type { PushResult } from '../git/push';
import type { RunnerHubHttp } from '../hub-http';
import type { Logger } from '../log';

/** The first wait between final push tries; it doubles while the finalPush budget lasts. */
export const FINAL_PUSH_RETRY_MS = 1_000;

/**
 * How long an exited agent's last events are waited for, and how long events that ended are given for the process
 * to exit: an escaped process that inherited the agent's pipes can hold them open (design 7.4).
 */
export const EVENTS_AFTER_EXIT_MS = 2_000;

/** The longest pushError attempt.exited carries: a git failure's stderr can carry a line per ref. */
export const PUSH_ERROR_MAX = 4_000;

/** A pushError cut to PUSH_ERROR_MAX characters, an ellipsis marking the cut, so attempt.exited is never refused. */
export function clipPushError(text: string): string {
  return text.length <= PUSH_ERROR_MAX ? text : `${text.slice(0, PUSH_ERROR_MAX - 1)}…`;
}

/** What a final push with retries gave: the last push's result, or why canPushWip refused the next try. */
export type RetriedPush = PushResult | { ok: false; error: 'refused'; detail: string };

export interface PushRetryOptions {
  push(): Promise<PushResult>;
  budgetMs: number;
  /** Why a push to the WIP ref may not go now, asked before every try (canPushWip, X-11); null lets it go. */
  refusal?(): string | null;
  sleep?(ms: number): Promise<void>;
  now?(): number;
}

/**
 * Runs a push until it lands, retrying remote failures while the budget lasts, the waits doubling from
 * FINAL_PUSH_RETRY_MS; a stale lease is never retried, since only the hub can say what the ref should hold. The
 * refusal is asked before every try, and the deadline checked again after every wait, so a laptop that slept
 * meanwhile pushes nothing until a welcome. Gives the last result.
 */
export async function pushWithRetries(options: PushRetryOptions): Promise<RetriedPush> {
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const now = options.now ?? Date.now;
  const deadline = now() + options.budgetMs;
  for (let attempt = 0; ; attempt++) {
    const refusal = options.refusal?.() ?? null;
    if (refusal !== null) return { ok: false, error: 'refused', detail: refusal };
    const result = await options.push();
    if (result.ok || result.error === 'stale') return result;
    const wait = doublingDelay(attempt, { base: FINAL_PUSH_RETRY_MS, cap: options.budgetMs });
    if (now() + wait >= deadline) return result;
    await sleep(wait);
    if (now() >= deadline) return result;
  }
}

/**
 * Uploads the end of the session's transcript for the handoff note. Never fails the exit: the hub can still ask for
 * it with upload_transcript.
 */
export async function uploadTranscriptTail(input: {
  adapter: Pick<VendorAdapter, 'readTranscriptTail'>;
  hub: Pick<RunnerHubHttp, 'uploadTranscript'>;
  attemptId: string;
  sessionRef: string;
  clone: string;
  logger: Logger;
}): Promise<boolean> {
  const { adapter, hub, attemptId, sessionRef, clone, logger } = input;
  try {
    const tail = await adapter.readTranscriptTail({ sessionRef, clone, maxChars: TRANSCRIPT_TAIL_MAX_BYTES });
    if (tail === null || tail === '') return false;
    await hub.uploadTranscript(attemptId, tail);
    return true;
  } catch (error) {
    logger.warn('cannot upload the transcript tail', { attemptId, error: String(error) });
    return false;
  }
}

/** What one late-work try did: landed at ref, or failed with the reason. */
export type LateWorkTry = { ok: true } | { ok: false; error: string };

/** Runs fn after ms; gives the cancel. */
export type ScheduleFn = (fn: () => void, ms: number) => () => void;

/** setTimeout, unreferenced so a pending retry never keeps the process alive. */
const scheduleTimeout: ScheduleFn = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
};

/**
 * The late-work retries of one attempt: each try runs the given push (on the attempt's serial queue), and a failed
 * one, or one that throws, is tried again after lateRetry's doubling delay, until one lands or the retries are
 * cancelled.
 */
export class LateWorkRetries {
  private cancelPending: (() => void) | null = null;
  private failures = 0;
  private cancelled = false;

  constructor(
    private readonly options: {
      delay: RunnerTimings['lateRetry'];
      attempt: () => Promise<LateWorkTry>;
      logger: Logger;
      attemptId: string;
      /** setTimeout by default. */
      schedule?: ScheduleFn;
    },
  ) {}

  /** Starts the retries: the first try now, or after the first delay. */
  start(now: boolean): void {
    if (now) void this.run();
    else this.schedule();
  }

  cancel(): void {
    this.cancelled = true;
    this.cancelPending?.();
    this.cancelPending = null;
  }

  get active(): boolean {
    return !this.cancelled;
  }

  private schedule(): void {
    if (this.cancelled) return;
    const wait = doublingDelay(this.failures, this.options.delay);
    this.cancelPending = (this.options.schedule ?? scheduleTimeout)(() => void this.run(), wait);
  }

  private async run(): Promise<void> {
    this.cancelPending = null;
    if (this.cancelled) return;
    let result: LateWorkTry;
    try {
      result = await this.options.attempt();
    } catch (error) {
      result = { ok: false, error: String(error) };
    }
    if (result.ok) {
      this.cancelled = true;
      return;
    }
    this.failures += 1;
    this.options.logger.warn('a late-work push failed; retrying', {
      attemptId: this.options.attemptId,
      error: result.error,
    });
    this.schedule();
  }
}
