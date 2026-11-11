// The service's suspend budget (design 7.1, X-7). The runner owns stopping, final WIP and suspended records.
import type { Logger } from '../log';
import type { RunnerHandle } from '../runner';

type SuspendHandle = Pick<RunnerHandle, 'pause' | 'stopAgents' | 'waitAcked' | 'status'>;

export interface SuspendOptions {
  deadlineMs: number;
  logger: Logger;
  /** Monotonic milliseconds by default, so a wall-clock correction cannot extend a suspend. */
  now?: () => number;
}

export interface SuspendResult {
  /** Completed stopAgents' exits, in final-push order; empty when that operation did not finish. */
  seqs: number[];
  /** null when no acknowledgement was needed or the link was already down. */
  acked: boolean | null;
  deadlinePassed: boolean;
  error: string | null;
}

/** Pauses permanently, stops without a handoff, and waits for the last exit's cumulative ack within one budget. */
export async function suspendRunner(runner: SuspendHandle, options: SuspendOptions): Promise<SuspendResult> {
  const result: SuspendResult = { seqs: [], acked: null, deadlinePassed: false, error: null };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  const log = (message: string, error?: string) => {
    try {
      options.logger.warn(message, error === undefined ? undefined : { error });
    } catch {
      // Logging must not hold shutdown open or make it reject.
    }
  };
  try {
    const now = options.now ?? (() => performance.now());
    const deadline = now() + options.deadlineMs;
    const expired = () => {
      result.deadlinePassed = true;
      log('runner suspend deadline passed');
    };
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(
        () => {
          expired();
          resolve();
        },
        Math.max(0, options.deadlineMs),
      );
    });
    // The catch stays attached after the deadline: a late push failure must never become an unhandled rejection.
    const work = (async () => {
      runner.pause();
      const seqs = await runner.stopAgents('suspend', { handoff: false });
      if (finished) return;
      result.seqs = seqs;
      const last = seqs.at(-1);
      if (last === undefined) return;
      while (!finished && runner.status().link === 'online') {
        const remaining = deadline - now();
        if (remaining <= 0) {
          expired();
          return;
        }
        // Poll the link between bounded ack waits: a disconnect should not cost the rest of the budget.
        const acked = await runner.waitAcked(last, Math.min(remaining, 100));
        if (finished) return;
        result.acked = acked;
        if (acked) return;
      }
    })().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!finished) result.error = message;
      log('runner suspend failed', message);
    });
    await Promise.race([work, timeout]);
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    log('runner suspend failed', result.error);
  } finally {
    finished = true;
    if (timer !== undefined) clearTimeout(timer);
  }
  return result;
}
