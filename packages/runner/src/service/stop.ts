// Stop drains before handing off; restart uses suspend so the hub keeps attempts open (design 7.1, X-41).
import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { loadRunnerConfig } from '../config';
import type { Logger } from '../log';
import { type RunnerPaths, runnerPaths } from '../paths';
import type { RunnerHandle } from '../runner';
import { controlRequest, ControlUnavailableError } from './control';
import { bootoutService, disableService, kickstartService, plistPath, serviceLoaded } from './launchd';
import { readLockOwner } from './lock';
import { ServiceRuns } from './runs';
import type { Exec } from './system';

type StopHandle = Pick<RunnerHandle, 'changeSettings' | 'pause' | 'stopAgents' | 'waitAcked' | 'status'>;

export interface StopAgentsOptions {
  logger: Logger;
  drainAckMs?: number;
  exitsAckMs?: number;
}

export interface StopAgentsResult {
  /** null means the settings did not change, so there was no drain event to acknowledge. */
  drainAcked: boolean | null;
  seqs: number[];
  /** null means there were no exits or the link was already down. */
  exitsAcked: boolean | null;
  errors: string[];
}

/** The runner owns the handoff and final pushes; failures here must not prevent the host's teardown. */
export async function drainAndStopAgents(runner: StopHandle, options: StopAgentsOptions): Promise<StopAgentsResult> {
  const result: StopAgentsResult = { drainAcked: null, seqs: [], exitsAcked: null, errors: [] };
  const warn = (message: string, error?: string) => {
    try {
      options.logger.warn(message, error === undefined ? undefined : { error });
    } catch {
      // A closed log cannot keep the runner alive.
    }
  };
  const failed = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    result.errors.push(message);
    warn('runner stop failed', message);
  };
  const ack = async (seq: number, ms: number): Promise<boolean> => {
    const deadline = performance.now() + ms;
    while (runner.status().link === 'online') {
      const remaining = deadline - performance.now();
      if (remaining <= 0) break;
      // Check the link between short waits, rather than spending the whole budget after a disconnect.
      if (await runner.waitAcked(seq, Math.min(remaining, 100))) return true;
    }
    return false;
  };
  try {
    const seq = await runner.changeSettings({ draining: true });
    if (runner.status().link !== 'online') result.drainAcked = false;
    else if (seq !== null) result.drainAcked = await ack(seq, options.drainAckMs ?? 60_000);
  } catch (error) {
    result.drainAcked = false;
    failed(error);
  }
  if (result.drainAcked === false) warn('the hub did not acknowledge the drain; stopping anyway');
  try {
    runner.pause();
  } catch (error) {
    failed(error);
  }
  try {
    result.seqs = await runner.stopAgents('runner_stop', { handoff: true });
    const last = result.seqs.at(-1);
    if (last !== undefined && runner.status().link === 'online') {
      result.exitsAcked = await ack(last, options.exitsAckMs ?? 30_000);
      if (!result.exitsAcked) warn('the hub did not acknowledge the exits; stopping anyway');
    }
  } catch (error) {
    failed(error);
  }
  return result;
}

/**
 * The exit reason of a runner stop, with what went wrong: the service's log is the only other place these warnings
 * appear, and agflow runner stop shows the reason to the person who asked.
 */
export function stopReason(reason: string, result: StopAgentsResult): string {
  const warnings = [
    ...(result.drainAcked === false ? ['the hub did not acknowledge the drain and may end the attempts as lost'] : []),
    ...(result.exitsAcked === false ? ['the hub did not acknowledge the exits'] : []),
    ...result.errors.map((error) => `runner stop failed: ${error}`),
  ];
  return [reason, ...warnings].join('; ');
}

/**
 * How long a stop may take: the drain ack (60 s), the handoff turn, the final pushes one attempt at a time, the exit
 * acks (30 s) and two minutes of teardown; 10 minutes at least, and when runner.json cannot be read.
 */
export function stopWaitMs(paths: RunnerPaths): number {
  const floor = 10 * 60_000;
  try {
    const config = loadRunnerConfig(paths.config);
    const { handoff, finalPush } = config.timings;
    return Math.max(floor, 60_000 + handoff + config.capacity * finalPush + 30_000 + 2 * 60_000);
  } catch {
    return floor;
  }
}

export interface StopRunnerOptions {
  /** Test mode never consults or mutates launchd or the installed plist. */
  env?: Record<string, string | undefined>;
  paths?: RunnerPaths;
  exec?: Exec;
  uid?: number;
  label?: string;
  /**
   * The user's home: an installed plist that launchd has not loaded is disabled too, or the next login would start
   * it. Uninstall, which removes the plist instead, leaves it out.
   */
  home?: string;
  /** stopWaitMs by default for a stop, two minutes for a restart. */
  lockWaitMs?: number;
  pollMs?: number;
  /** Progress lines, without trailing newlines. */
  log?: (line: string) => void;
}

function bounds(options: StopRunnerOptions, defaultMs: number) {
  const waitMs = options.lockWaitMs ?? defaultMs;
  const pollMs = options.pollMs ?? 100;
  if (!Number.isFinite(waitMs) || waitMs < 0) throw new Error('lockWaitMs must be nonnegative');
  if (!Number.isFinite(pollMs) || pollMs <= 0) throw new Error('pollMs must be positive');
  return { waitMs, pollMs };
}

async function requestExit(
  paths: RunnerPaths,
  route: '/stop' | '/suspend',
  options: StopRunnerOptions,
  budget: ReturnType<typeof bounds>,
): Promise<boolean> {
  let running = true;
  let pid: number | null = null;
  try {
    pid = (await controlRequest<{ pid?: number }>(paths, 'GET', '/health')).pid ?? null;
  } catch (error) {
    if (!(error instanceof ControlUnavailableError)) throw error;
    running = false;
  }
  if (!running) {
    const owner = readLockOwner(paths);
    if (owner !== null) {
      throw new Error(
        `runner.lock is held by pid ${owner.pid ?? 'unknown'}, but no runner answers on its control socket; ` +
          'try again in a moment, or check agflow runner status',
      );
    }
    options.log?.('no runner is running');
    return false;
  }
  options.log?.(
    route === '/stop' ? 'stopping the runner: draining, handing off and pushing final work' : 'suspending the runner',
  );
  await controlRequest(paths, 'POST', route);
  const deadline = performance.now() + budget.waitMs;
  let nextLog = 0;
  // A service waiting behind a foreground runner takes the lock next; it is launchd's to stop, not this request's.
  let owner = readLockOwner(paths);
  while (owner !== null && (pid === null || owner.pid === null || owner.pid === pid)) {
    const now = performance.now();
    if (now >= deadline) {
      throw new Error(`runner.lock is still held by pid ${owner.pid ?? 'unknown'} after ${budget.waitMs} ms`);
    }
    if (now >= nextLog) {
      options.log?.(`waiting for runner.lock held by pid ${owner.pid ?? 'unknown'}`);
      nextLog = now + 5_000;
    }
    await delay(Math.min(budget.pollMs, deadline - now));
    owner = readLockOwner(paths);
  }
  return true;
}

/** Stops through the live service, then leaves the LaunchAgent disabled until install. */
export async function stopRunner(
  options: StopRunnerOptions = {},
): Promise<{ wasRunning: boolean; bootedOut: boolean; disabled: boolean }> {
  const paths = options.paths ?? runnerPaths();
  const budget = bounds(options, options.lockWaitMs ?? stopWaitMs(paths));
  const wasRunning = await requestExit(paths, '/stop', options, budget);
  if (wasRunning) {
    // The stopped run's record, warnings included; a service waiting behind it may hold the lock by now.
    const exit = new ServiceRuns(paths).lastExit({ running: readLockOwner(paths) !== null });
    if (exit !== null) options.log?.(`the runner exited: ${exit.reason}`);
  }
  if ((options.env ?? process.env).AGFLOW_TEST === '1') return { wasRunning, bootedOut: false, disabled: false };
  let bootedOut = false;
  let disabled = false;
  if (await serviceLoaded(options)) {
    bootedOut = await bootoutService(options);
    // bootoutService tolerates an absent job; a still-loaded job is a real failure, not a successful stop.
    if (!bootedOut && (await serviceLoaded(options)))
      throw new Error('launchctl bootout failed; the service is still loaded');
    await disableService(options);
    bootedOut = true;
    disabled = true;
  } else if (options.home !== undefined && existsSync(plistPath({ home: options.home, label: options.label }))) {
    // launchctl disable also works on a label that is not loaded.
    await disableService(options);
    disabled = true;
  }
  return { wasRunning, bootedOut, disabled };
}

/** Checks launchd before touching a foreground runner; kickstart follows the suspend's lock release. */
export async function restartRunner(options: StopRunnerOptions = {}): Promise<void> {
  const budget = bounds(options, 120_000);
  if ((options.env ?? process.env).AGFLOW_TEST === '1' || !(await serviceLoaded(options))) {
    throw new Error(
      'no runner service is loaded; agflow runner install installs and starts the LaunchAgent; ' +
        'agflow runner start runs it in the foreground',
    );
  }
  await requestExit(options.paths ?? runnerPaths(), '/suspend', options, budget);
  options.log?.('starting the runner under launchd; launchd can hold a quick restart for up to a minute');
  await kickstartService(options);
}
