// The process that runs a runner (design 7.1, X-41): `agflow runner start` in the foreground and `--service` under
// launchd. One lock holder, one run record, and one exit path for every end: a refusal that needs a person, the hub
// replacing the link, a stop, or an error.
import { existsSync } from 'node:fs';
import type { Credentials } from '@agflow/core';
import { createAdapters } from '../adapters';
import type { AgflowCommand, VendorAdapter } from '../adapters/types';
import { AttemptStore } from '../attempt-store';
import { type ClockSource, systemClock } from '../clock';
import { editLocalSettings, isTestMode, loadRunnerConfig, type RunnerConfig, saveRunnerConfig } from '../config';
import { openRunnerDb, type RunnerDb } from '../db';
import type { FetchFn } from '../hub-http';
import { Journal } from '../journal';
import { sameHubUrl, type WelcomeMessage } from '../link';
import { createServiceHealth, type ServiceHealth } from '../ops/health';
import { KeepAwake } from '../ops/keep-awake';
import type { PowerSample } from '../ops/power';
import { RETENTION, sweepRetention } from '../ops/retention';
import { Outbox } from '../outbox';
import { type RunnerPaths, runnerPaths } from '../paths';
import { createDependencyPreparer } from '../prep/preparer';
import { PrepSandbox } from '../prep/sandbox';
import { standardProfile } from '../profile';
import { killRegisteredGroups } from '../recovery';
import { createRunner, type RunnerEvents, type RunnerHandle, type RunnerOptions } from '../runner';
import type { DependencyPreparer, Notifier } from '../seams';
import { runServiceChecks } from './checks';
import { type ControlRoutes, type ControlServer, startControlServer } from './control';
import { readCliCredentials } from './credentials';
import { applyCrashLoopGuard } from './drain';
import { AlreadyRunningError, acquireRunnerLock, type RunnerLock, type RunnerMode } from './lock';
import { RotatingLog } from './log';
import { machineMismatch, readMachineId } from './machine';
import { NeedsLogin } from './needs-login';
import { createMacNotifier } from './notify';
import { ServiceRuns } from './runs';
import { buildStatusReport } from './status';
import { suspendRunner } from './suspend';
import { defaultExec, type Exec } from './system';

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
   * The CLI owns its process: SIGTERM and SIGINT suspend the service, as SIGHUP does in the foreground, and an uncaught
   * error ends it unclean. Off for a host embedded in another process, such as a test.
   */
  signals?: boolean;
  lockPollMs?: number;
  fetch?: FetchFn;
  tmpRoot?: string;
  /** Operations' timers; runner heartbeats retain their own clock. */
  clock?: ClockSource;
  /** Retention's age checks; Date.now by default. */
  now?: () => number;
  /** Retention pin table; native vendorPlatform() by default. Tests may install another platform's fake pins. */
  retentionPlatform?: string;
  /** Notification command runner; defaultExec by default. */
  exec?: Exec;
  /** Notification and keep-awake platform; process.platform by default. */
  platform?: NodeJS.Platform;
  /** Machine samplers; pmset, diskFreeBytes and AgflowUsage by default. */
  power?: () => Promise<PowerSample | null>;
  freeBytes?: () => number | null;
  usage?: { current(): number };
  /** Keep-awake command; /usr/bin/caffeinate on macOS by default. */
  caffeinate?: string;
  /** Shared preparation sandbox; checked once at service start. */
  prepSandbox?: PrepSandbox;
  /** Setup checks wait up to 30 s for the first hub welcome. */
  checksWelcomeTimeoutMs?: number;
}

export interface RunnerService {
  readonly paths: RunnerPaths;
  readonly mode: RunnerMode;
  /** The running runner; null when the service ended before it started. */
  readonly runner: RunnerHandle | null;
  /** Login hold and its reason, including the service's initial wait for credentials. */
  readonly needsLogin: NeedsLogin | null;
  /** Resolves after teardown, once runner.lock, released last, is free. */
  readonly exited: Promise<ServiceExit>;
  /** Suspends agents within timings.suspend, then exits cleanly; concurrent shutdowns get the same exit. */
  suspend(reason: string): Promise<ServiceExit>;
  /** Stops the agents with no handoff within timings.suspend, then exits cleanly; a second call gets the same exit. */
  stop(reason: string): Promise<ServiceExit>;
}

/** A start refused for a reason a person must fix (X-41). */
class Refusal extends Error {}

/**
 * How teardown ends the agents: a suspend (SIGTERM, SIGINT, POST /suspend), a stop without a handoff (a link that
 * ended for good, a refusal, a stop), or only the kill after an uncaught error.
 */
type AgentsEnd = 'suspend' | 'stop' | 'kill';

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
  const credentialsProvider = () => readCliCredentials(configDir);
  const firstWelcome = Promise.withResolvers<WelcomeMessage>();
  let currentWelcome: WelcomeMessage | null = null;
  let adapters: VendorAdapter[] = [];
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
  // The runner once createRunner returns; null when the service ends before that.
  const runnerUp = Promise.withResolvers<RunnerHandle | null>();
  const waiting = new AbortController();
  let lock: RunnerLock | null = null;
  let logger: RotatingLog | null = null;
  let runs: ServiceRuns | null = null;
  let runId: string | null = null;
  let control: ControlServer | null = null;
  let db: RunnerDb | null = null;
  let store: AttemptStore | null = null;
  let runner: RunnerHandle | null = null;
  let config: RunnerConfig;
  let hubUrl: string | null = null;
  const clock = options.clock ?? systemClock;
  let health: ServiceHealth | null = null;
  let keepAwake: KeepAwake | null = null;
  let notifier: Notifier | null = null;
  let needsLogin: NeedsLogin | null = null;
  let loginReason = 'the hub refused the CLI token';
  let preparer: DependencyPreparer | null = null;
  let sandbox: PrepSandbox | null = null;
  let heartbeatMs: number | null = null;
  let retentionTimer: unknown = null;
  let retention: Promise<void> | null = null;
  const sweeping = new AbortController();
  let ending = false;
  let suspendMs = 0;
  // The guard's verdict at start: createRunner then drains through changeSettings unless an undrain came first.
  let crashLoop = false;
  // While a --service start waits for credentials.json it holds the lock and runner.json, but has no runner yet.
  let awaitingCredentials = false;

  // A person must act: exit 0 under launchd so KeepAlive does not loop, 1 in the foreground.
  const refusal = (reason: string): ServiceExit => ({ code: mode === 'service' ? 0 : 1, clean: true, reason });
  const failure = (error: unknown): ServiceExit => ({ code: 1, clean: false, reason: describe(error) });

  function finish(input: ServiceExit, level: 'info' | 'error', agents: AgentsEnd = 'stop'): Promise<ServiceExit> {
    if (ending) return exited.promise;
    ending = true;
    runnerUp.resolve(null);
    const deadline = performance.now() + suspendMs;
    waiting.abort();
    // A retention sweep under way stops before its next step, so teardown waits only for the step it is in.
    sweeping.abort();
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
      await step(() => {
        if (retentionTimer !== null) clock.clearInterval(retentionTimer);
        retentionTimer = null;
      });
      const active = runner;
      if (agents === 'suspend' && active !== null && logger !== null) {
        const result = await suspendRunner(active, {
          deadlineMs: Math.max(0, deadline - performance.now()),
          logger,
        });
        logger.info('runner suspend finished', { ...result });
      } else if (agents === 'stop' && active !== null) {
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
      await step(() => health?.close());
      await step(() => keepAwake?.close());
      await step(() => {
        if (retention === null) return;
        // A suspend bounds the step under way, such as a repack, by its deadline (launchd's ExitTimeOut follows).
        return agents === 'suspend' ? within(retention, deadline - performance.now()) : retention;
      });
      await step(async () => {
        // With no runner yet, teardown can outrun the control request that cancelled the credential wait.
        await new Promise<void>((resolve) => setImmediate(resolve));
        control?.stop();
      });
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
    get needsLogin() {
      return needsLogin;
    },
    exited: exited.promise,
    suspend: (reason) => finish({ code: 0, clean: true, reason }, 'info', runner !== null ? 'suspend' : 'stop'),
    stop: (reason) => finish({ code: 0, clean: true, reason }, 'info'),
  };

  const onTerm = () => void service.suspend('received SIGTERM');
  const onInt = () => void service.suspend('received SIGINT');
  // A closed terminal tab hangs up a foreground runner; its agents run in their own sessions and never see it.
  const onHup = () => void service.suspend('received SIGHUP');
  const hangup = options.signals === true && mode === 'foreground';
  // The runner's state is unknown after an uncaught error: its agents are killed, not stopped.
  const onError = (error: unknown) => void finish(failure(error), 'error', 'kill');
  function removeHandlers() {
    if (!options.signals) return;
    process.off('SIGTERM', onTerm);
    process.off('SIGINT', onInt);
    if (hangup) process.off('SIGHUP', onHup);
    process.off('uncaughtException', onError);
    process.off('unhandledRejection', onError);
  }
  if (options.signals) {
    process.on('SIGTERM', onTerm);
    process.on('SIGINT', onInt);
    if (hangup) process.on('SIGHUP', onHup);
    process.on('uncaughtException', onError);
    process.on('unhandledRejection', onError);
  }

  // The control socket's routes; the commands of later tasks add theirs here.
  const routes: ControlRoutes = {
    'POST /checks': async () => {
      // Setup asks right after install, while the socket already answers but the runner may still be starting: the
      // wait for it counts against the welcome's budget.
      const budgetMs = options.checksWelcomeTimeoutMs ?? 30_000;
      const startedAt = performance.now();
      const waited = runner === null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const ready =
        runner ??
        (await Promise.race([
          runnerUp.promise,
          new Promise<'timeout'>((resolve) => {
            timer = setTimeout(() => resolve('timeout'), budgetMs);
          }),
        ]).finally(() => clearTimeout(timer)));
      if (ready === null) throw new Error('the runner service is stopping');
      if (ready === 'timeout') {
        const login = needsLogin?.state();
        const state = login?.on ? `needs_login: ${login.reason}; run agflow login` : 'still starting';
        throw new Error(`the runner did not start within ${budgetMs / 1000} s (${state})`);
      }
      return runServiceChecks({
        runner: ready,
        welcome: currentWelcome === null ? firstWelcome.promise : Promise.resolve(currentWelcome),
        adapters,
        sandbox: sandbox!,
        // Pinned like createRunner's: a sign-in to another hub must not pass the checks of this runner's.
        credentials: () => {
          const current = credentialsProvider();
          return current !== null && hubUrl !== null && sameHubUrl(current.hubUrl, hubUrl) ? current : null;
        },
        hubUrl,
        fetch: options.fetch,
        exec: options.exec ?? defaultExec,
        platform: options.platform ?? process.platform,
        welcomeTimeoutMs: waited ? Math.max(0, Math.round(budgetMs - (performance.now() - startedAt))) : budgetMs,
      });
    },
    'GET /status': () => {
      const status = runner?.status() ?? null;
      const records = store?.list() ?? [];
      return buildStatusReport({
        status,
        owner: lock!.owner,
        config,
        hubUrl,
        health: status?.state ?? health?.state() ?? { state: 'ok', detail: null },
        heartbeat: health?.heartbeat() ?? { power: null, disk: null, acceptingUntil: null },
        needsLogin: needsLogin?.state() ?? { on: false, reason: null, since: null },
        keepAwakeHeld: keepAwake?.isHeld() ?? false,
        dependencyPrep: preparer?.available ?? false,
        records,
        existingClones: records.flatMap((record) =>
          record.clone !== null && (record.pushError !== null || record.lateWorkSha !== null) && existsSync(record.clone)
            ? [record.clone]
            : [],
        ),
        now: clock.now(),
      });
    },
    'POST /drain': () => changeDraining(true),
    'POST /undrain': () => changeDraining(false),
    'POST /suspend': () => {
      void service.suspend('suspend requested');
    },
    'GET /health': () => {
      const status = runner?.status();
      return {
        pid: process.pid,
        mode,
        startedAt: lock?.owner.startedAt ?? null,
        runnerId: status?.runnerId ?? null,
        link: status?.link ?? (needsLogin?.state().on ? 'needs_login' : 'idle'),
      };
    },
  };
  async function changeDraining(draining: boolean): Promise<void> {
    if (runner !== null) await runner.changeSettings({ draining });
    else if (awaitingCredentials) {
      // The wait can last until the owner signs in: runner.json takes the edit, which createRunner then starts from,
      // and M2b sends it after the first welcome.
      config = editLocalSettings(config, { draining }).config;
      saveRunnerConfig(paths.config, config);
    } else throw new Error('the runner is starting; try again');
    if (draining) return;
    runs!.forgetUnclean({ current: runId! });
    health!.setCrashLoop(null);
    crashLoop = false;
  }

  // One observer object keeps operations attached across reconnects.
  const events: RunnerEvents = {
    link: (state, detail) => {
      logger?.info('runner link', { state, code: detail.code, reason: detail.reason });
      if (state === 'needs_login') loginReason = detail.reason;
    },
    gap: (gap) => health?.gap(gap),
    welcome: (welcome) => {
      currentWelcome = welcome;
      firstWelcome.resolve(welcome);
      heartbeatMs = welcome.timings.heartbeatMs;
      needsLogin?.leave();
    },
    needsLogin: () => needsLogin?.enter(loginReason),
    attemptState: () => keepAwake?.evaluate(),
  };

  // A credentials.json the service cannot read, or catches half-written by agflow login, is waited out like a missing
  // one, as M2b's link does; the foreground refuses, so a person repairs it without it counting as a crash.
  function readCredentials(): { credentials: Credentials | null; problem: string | null } {
    try {
      return { credentials: readCliCredentials(configDir), problem: null };
    } catch (error) {
      if (mode === 'foreground') throw new Refusal(describe(error));
      logger?.warn('cannot read the CLI credentials', { error: describe(error) });
      // needs_login adds the sign-in command with the hub's URL.
      return { credentials: null, problem: describe(error).replace(/; run agflow login$/, '') };
    }
  }

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
    const read = readCredentials();
    let credentials = read.credentials;
    if (credentials === null && mode === 'foreground') {
      throw new Refusal('not signed in; run agflow login --hub <url>');
    }
    db = openRunnerDb(paths.db);
    store = new AttemptStore(db);
    hubUrl = credentials?.hubUrl ?? db.meta('project')?.hubUrl ?? null;
    health = createServiceHealth({
      paths,
      config: () => config,
      heartbeatMs: () => heartbeatMs ?? config.timings.heartbeat,
      stopAgents: (cause, options) => {
        // health.close stops its timer; status/heartbeat reads and an in-flight sample can still evaluate guards.
        if (ending) return Promise.resolve([]);
        if (runner === null) throw new Error('the runner is not running yet');
        return runner.stopAgents(cause, options);
      },
      onSample: () => keepAwake?.evaluate(),
      samplePower: options.power,
      freeBytes: options.freeBytes,
      usage: options.usage,
      clock,
      logger,
    });
    crashLoop = applyCrashLoopGuard({ runs, config, health, logger });
    keepAwake = new KeepAwake({
      mode: () => runner?.status().settings.keepAwake ?? config.keepAwake,
      power: () => health?.power() ?? null,
      attempts: () => runner?.status().attempts ?? [],
      command: options.caffeinate,
      platform: options.platform,
      clock,
      logger,
    });
    notifier = createMacNotifier(options.exec ?? defaultExec, {
      testMode: isTestMode(config),
      logger,
      platform: options.platform,
    });
    needsLogin = new NeedsLogin({
      health,
      notifier,
      logger,
      runner: () => runner,
      hubUrl: () => hubUrl,
      now: () => clock.now(),
    });
    if (credentials === null) {
      needsLogin.enter(read.problem ?? 'not signed in');
      awaitingCredentials = true;
      while (!ending && credentials === null) {
        await new Promise<void>((resolve) => {
          const done = () => {
            clock.clearTimeout(timer);
            waiting.signal.removeEventListener('abort', done);
            resolve();
          };
          const timer = clock.setTimeout(done, config.timings.loginProbe);
          waiting.signal.addEventListener('abort', done, { once: true });
          if (waiting.signal.aborted) done();
        });
        if (ending) return;
        credentials = readCredentials().credentials;
      }
      awaitingCredentials = false;
      if (ending) return;
      hubUrl = credentials!.hubUrl;
    }
    adapters = options.adapters ?? (options.createAdapters ?? createAdapters)(config, paths, { agflow });
    sandbox =
      options.prepSandbox ?? new PrepSandbox({ allowedDomains: standardProfile.network.allowedDomains, logger });
    preparer = await createDependencyPreparer({ paths, store, config: () => config, logger, sandbox });
    // A sample before the runner starts: the first admission and the first heartbeat already see the battery.
    await health.sample();
    if (ending) return;
    runner = await createRunner({
      paths,
      config,
      db,
      credentials: credentialsProvider,
      adapters,
      cliVersion: options.cliVersion,
      agflow,
      health,
      notifier,
      preparer,
      logger,
      events,
      fetch: options.fetch,
      tmpRoot: options.tmpRoot,
    });
    runnerUp.resolve(runner);
    if (crashLoop) await runner.changeSettings({ draining: true });
    health.start();
    keepAwake.evaluate();
    const retentionInput = {
      paths,
      outbox: new Outbox(db),
      journal: new Journal(db),
      store,
      vaults: [runner.vault],
      adapters: new Map(adapters.map((adapter) => [adapter.vendor, adapter])),
      eventRetentionMs: config.timings.eventRetention,
      now: options.now,
      platform: options.retentionPlatform,
      logger,
      signal: sweeping.signal,
    };
    const sweep = () => {
      if (ending || retention !== null) return;
      retention = sweepRetention(retentionInput)
        .then((result) => {
          if (result.ran) logger?.info('retention sweep finished', { ...result });
        })
        .catch((error) => logger?.error('retention sweep failed', { error: describe(error) }))
        .finally(() => {
          retention = null;
        });
    };
    sweep();
    retentionTimer = clock.setInterval(sweep, RETENTION.checkIntervalMs);
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
