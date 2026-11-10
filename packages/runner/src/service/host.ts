// The process that runs a runner (design 7.1, X-41): `agflow runner start` in the foreground and `--service` under
// launchd. One lock holder, one run record, and one exit path for every end: a refusal that needs a person, the hub
// replacing the link, a stop, or an error.
import { createAdapters } from '../adapters';
import type { AgflowCommand, VendorAdapter } from '../adapters/types';
import { AttemptStore } from '../attempt-store';
import { loadRunnerConfig, type RunnerConfig } from '../config';
import { openRunnerDb, type RunnerDb } from '../db';
import type { FetchFn } from '../hub-http';
import { type RunnerPaths, runnerPaths } from '../paths';
import { killRegisteredGroups } from '../recovery';
import { createRunner, type RunnerEvents, type RunnerHandle, type RunnerOptions } from '../runner';
import { type ControlRoutes, type ControlServer, startControlServer } from './control';
import { readCliCredentials } from './credentials';
import { AlreadyRunningError, acquireRunnerLock, type RunnerLock, type RunnerMode } from './lock';
import { RotatingLog } from './log';
import { machineMismatch, readMachineId } from './machine';
import { ServiceRuns } from './runs';

/** How the service ended: the process exit code, whether the run counts as clean (task 19's guard), and why. */
export interface ServiceExit {
  code: number;
  clean: boolean;
  reason: string;
}

export interface RunnerServiceOptions {
  mode: RunnerMode;
  /** The CLI's configuration directory: credentials.json is read from it on each use (X-8). */
  configDir: string;
  /** How the runner runs agflow itself (the CLI's selfCommand()). */
  agflow: AgflowCommand;
  /** runnerPaths(agflowHome()) by default. */
  paths?: RunnerPaths;
  /** The adapters to run; createAdapters' otherwise (X-6). */
  adapters?: VendorAdapter[];
  /** Test adapters may supply a platform-neutral version; production uses M2b's pinned version. */
  cliVersion?: RunnerOptions['cliVersion'];
  /** createAdapters by default; used only without injected adapters. */
  createAdapters?: typeof createAdapters;
  /** readMachineId by default. */
  machineId?: () => Promise<string>;
  /** The foreground's terminal, and where lines go before the log exists; stderr by default. */
  terminal?: (line: string) => void;
  /**
   * The CLI owns its process: SIGTERM and SIGINT stop the service, and an uncaught error ends it unclean. Off for a
   * host embedded in another process, such as a test.
   */
  signals?: boolean;
  lockPollMs?: number;
  fetch?: FetchFn;
  tmpRoot?: string;
}

export interface RunnerService {
  readonly paths: RunnerPaths;
  readonly mode: RunnerMode;
  /** The running runner; null when the service ended before it started. */
  readonly runner: RunnerHandle | null;
  /** Resolves after teardown, once runner.lock, released last, is free. */
  readonly exited: Promise<ServiceExit>;
  /**
   * Stops the agents with no handoff within timings.suspend, then exits cleanly, as SIGTERM and SIGINT do; a second
   * call gets the same exit.
   */
  stop(reason: string): Promise<ServiceExit>;
}

/** A start refused for a reason a person must fix (X-41). */
class Refusal extends Error {}

/**
 * How teardown ends the agents: a stop without a handoff (a link that ended for good, a refusal, a stop, a signal), or
 * only the kill after an uncaught error.
 */
type AgentsEnd = 'stop' | 'kill';

/** Waits for work up to ms; past that, teardown goes on and the work finishes unobserved. */
async function within(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.max(0, ms));
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Reasons are one line: service-runs.json and runner status show them so. */
function describe(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, ' ');
}

/**
 * Starts the runner; resolves once it runs, or once the service already ended (runner null). It never rejects: a
 * refusal or an error becomes the ServiceExit.
 */
export async function startRunnerService(options: RunnerServiceOptions): Promise<RunnerService> {
  const paths = options.paths ?? runnerPaths();
  const { mode, configDir, agflow } = options;
  const terminal =
    options.terminal ??
    ((line: string) => {
      process.stderr.write(line);
    });
  const print = (line: string) => {
    try {
      terminal(`${line}\n`);
    } catch {
      // A closed terminal must not keep the lock held.
    }
  };
  const exited = Promise.withResolvers<ServiceExit>();
  const initialized = Promise.withResolvers<void>();
  const waiting = new AbortController();
  let lock: RunnerLock | null = null;
  let logger: RotatingLog | null = null;
  let runs: ServiceRuns | null = null;
  let runId: string | null = null;
  let control: ControlServer | null = null;
  let db: RunnerDb | null = null;
  let store: AttemptStore | null = null;
  let runner: RunnerHandle | null = null;
  let ending = false;
  let suspendMs = 0;

  // A person must act: exit 0 under launchd so KeepAlive does not loop, 1 in the foreground.
  const refusal = (reason: string): ServiceExit => ({ code: mode === 'service' ? 0 : 1, clean: true, reason });
  const failure = (error: unknown): ServiceExit => ({ code: 1, clean: false, reason: describe(error) });

  function finish(input: ServiceExit, level: 'info' | 'error', agents: AgentsEnd = 'stop'): Promise<ServiceExit> {
    if (ending) return exited.promise;
    ending = true;
    const deadline = performance.now() + suspendMs;
    waiting.abort();
    void (async () => {
      // A signal can arrive while the lock is awaited or createRunner runs: nothing is released beneath startup.
      await initialized.promise;
      let exit = { ...input, reason: describe(input.reason) };
      const step = async (action: () => unknown) => {
        try {
          await action();
        } catch (error) {
          const failed = failure(error);
          if (exit.clean) exit = failed;
          if (logger) logger.error(failed.reason);
          else print(failed.reason);
        }
      };
      // Every step runs; the lock goes last, so no second runner starts while this one still holds anything.
      const active = runner;
      if (agents === 'stop' && active !== null) {
        // runner.close leaves agents running, and under launchd nothing restarts this runner after a link end or a
        // refusal to recover them (X-41). The hub resends commands held meanwhile after a later welcome.
        await step(async () => {
          active.pause();
          await within(active.stopAgents('runner_stop', { handoff: false }), deadline - performance.now());
        });
      }
      // The backstop: no registered group outlives the lock, whatever a deadline or an error left running.
      await step(async () => {
        if (store !== null) await killRegisteredGroups(store, logger ?? undefined);
      });
      if (logger) logger[level](exit.reason);
      else print(exit.reason);
      await step(() => runner?.close());
      await step(() => control?.stop());
      await step(() => db?.close());
      await step(() => {
        if (runs !== null && runId !== null) runs.finish(runId, exit);
      });
      removeHandlers();
      await step(() => lock?.release());
      exited.resolve(exit);
    })();
    return exited.promise;
  }

  const service: RunnerService = {
    paths,
    mode,
    get runner() {
      return runner;
    },
    exited: exited.promise,
    stop: (reason) => finish({ code: 0, clean: true, reason }, 'info'),
  };

  const onTerm = () => void service.stop('received SIGTERM');
  const onInt = () => void service.stop('received SIGINT');
  // The runner's state is unknown after an uncaught error: its agents are killed, not stopped.
  const onError = (error: unknown) => void finish(failure(error), 'error', 'kill');
  function removeHandlers() {
    if (!options.signals) return;
    process.off('SIGTERM', onTerm);
    process.off('SIGINT', onInt);
    process.off('uncaughtException', onError);
    process.off('unhandledRejection', onError);
  }
  if (options.signals) {
    process.on('SIGTERM', onTerm);
    process.on('SIGINT', onInt);
    process.on('uncaughtException', onError);
    process.on('unhandledRejection', onError);
  }

  // The control socket's routes; the commands of later tasks add theirs here.
  const routes: ControlRoutes = {
    'GET /health': () => {
      const status = runner?.status();
      return {
        pid: process.pid,
        mode,
        startedAt: lock?.owner.startedAt ?? null,
        runnerId: status?.runnerId ?? null,
        link: status?.link ?? 'idle',
      };
    },
  };
  // What the host hears from the runner; the operations of later tasks listen here.
  const events: RunnerEvents = {
    link: (state, detail) => {
      logger?.info('runner link', { state, code: detail.code, reason: detail.reason });
    },
  };

  // Each await may meet a stop: startup then ends early, and finish releases what it made.
  async function start(): Promise<void> {
    lock = await acquireRunnerLock(paths, {
      mode,
      wait: mode === 'service',
      pollMs: options.lockPollMs,
      signal: waiting.signal,
      onWait: (holder) => print(`waiting for runner.lock held by pid ${holder.pid ?? 'unknown'}`),
    });
    if (ending) return;
    logger = new RotatingLog(paths, { foreground: mode === 'foreground', terminal });
    logger.info('runner service starting', { pid: process.pid, mode });
    runs = new ServiceRuns(paths);
    runId = runs.start({ pid: process.pid, mode });
    let config: RunnerConfig;
    try {
      config = loadRunnerConfig(paths.config);
      suspendMs = config.timings.suspend;
    } catch (error) {
      // A missing runner.json already says 'run agflow runner setup'.
      throw new Refusal(describe(error));
    }
    const mismatch = machineMismatch(config, await (options.machineId ?? readMachineId)());
    if (mismatch !== null) throw new Refusal(mismatch);
    if (ending) return;
    control = startControlServer({ paths, lock, routes });
    if (readCliCredentials(configDir) === null) throw new Refusal('not signed in; run agflow login --hub <url>');
    db = openRunnerDb(paths.db);
    store = new AttemptStore(db);
    const adapters = options.adapters ?? (options.createAdapters ?? createAdapters)(config, paths, { agflow });
    runner = await createRunner({
      paths,
      config,
      db,
      credentials: () => readCliCredentials(configDir),
      adapters,
      cliVersion: options.cliVersion,
      agflow,
      logger,
      events,
      fetch: options.fetch,
      tmpRoot: options.tmpRoot,
    });
    void runner.done.then((end) => {
      if (end.kind === 'refused' || end.kind === 'incompatible') return finish(refusal(end.reason), 'error');
      // 4409: another process with this key took over, which is no fault of this one.
      return finish({ code: 0, clean: true, reason: end.reason || 'runner closed' }, 'info');
    }, onError);
  }

  try {
    await start();
  } catch (error) {
    if (error instanceof Refusal) void finish(refusal(error.message), 'error');
    // Nothing recorded: only the lock holder writes the log and service-runs.json.
    else if (error instanceof AlreadyRunningError) void finish({ ...failure(error), clean: true }, 'error');
    else void finish(failure(error), 'error');
  } finally {
    initialized.resolve();
  }
  if (ending) await exited.promise;
  return service;
}
