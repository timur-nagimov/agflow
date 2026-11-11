// Local draining (design 6.3, 7.1, X-12, X-41): the live runner owns settings edits; offline edits hold its lock.
import { editLocalSettings, loadRunnerConfig, type RunnerConfig, saveRunnerConfig } from '../config';
import { type Logger, noopLogger } from '../log';
import type { ServiceHealth } from '../ops/health';
import { type RunnerPaths, runnerPaths } from '../paths';
import { controlRequest, ControlUnavailableError } from './control';
import { AlreadyRunningError, acquireRunnerLock, type RunnerLock } from './lock';
import { crashLoopVerdict, ServiceRuns } from './runs';

export interface DrainOptions {
  paths?: RunnerPaths;
  /** Bounds the control request before trying the lock; controlRequest's default otherwise. */
  timeoutMs?: number;
}

export interface DrainResult {
  via: 'runner' | 'config';
  draining: boolean;
}

async function changeDraining(options: DrainOptions, draining: boolean): Promise<DrainResult> {
  const paths = options.paths ?? runnerPaths();
  try {
    await controlRequest(paths, 'POST', draining ? '/drain' : '/undrain', undefined, {
      timeoutMs: options.timeoutMs,
    });
    return { via: 'runner', draining };
  } catch (error) {
    // A route error belongs to the running service; only an unavailable socket permits an offline edit.
    if (!(error instanceof ControlUnavailableError)) throw error;
  }
  let lock: RunnerLock;
  try {
    lock = await acquireRunnerLock(paths, { mode: 'foreground', wait: false });
  } catch (error) {
    if (!(error instanceof AlreadyRunningError)) throw error;
    // A runner still starting, or one that stopped answering: runner.json is its to write.
    throw new Error(
      `runner.lock is held by pid ${error.pid ?? 'unknown'}, but no runner answers on its control socket; ` +
        'try again in a moment, or check agflow runner status',
    );
  }
  try {
    const config = loadRunnerConfig(paths.config);
    saveRunnerConfig(paths.config, editLocalSettings(config, { draining }).config);
    if (!draining) new ServiceRuns(paths).forgetUnclean();
    return { via: 'config', draining };
  } finally {
    lock.release();
  }
}

export function drainRunner(options: DrainOptions = {}): Promise<DrainResult> {
  return changeDraining(options, true);
}

export function undrainRunner(options: DrainOptions = {}): Promise<DrainResult> {
  return changeDraining(options, false);
}

/** Set hello's health before createRunner; the host then self-drains through RunnerHandle.changeSettings. */
export function applyCrashLoopGuard(options: {
  runs: ServiceRuns;
  config: Pick<RunnerConfig, 'timings'>;
  health: Pick<ServiceHealth, 'setCrashLoop'>;
  now?: number;
  logger?: Logger;
}): boolean {
  const { runs, config, health } = options;
  const verdict = crashLoopVerdict(runs, { now: options.now ?? Date.now(), window: config.timings.crashLoopWindow });
  if (!verdict.crashLoop) return false;
  if (runs.crashLoop() === null) runs.markCrashLoop(verdict);
  const detail = (verdict.lastError ?? 'repeated unclean exits').replace(/[\r\n]+/g, ' ');
  health.setCrashLoop(detail);
  (options.logger ?? noopLogger).error(`crash_loop: ${detail}; run agflow runner undrain to clear`);
  return true;
}
