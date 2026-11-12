// The runner runtime (design 6.3, 7.1, 7.2, 13): createRunner composes one runner from runner.json, runner.db, the
// awake clock, the link, the command executor and one attempt controller per attempt, with what its caller passes in:
// the adapters (M2c's host calls createAdapters, X-6), the dependency preparer, the health seam, the notifier, the
// credentials provider, the agflow command and the logger (X-7).
// - Start: startup recovery settles what a previous run left (recovery.ts) before anything else, signed in or not.
//   The project's name and repo come from GET /api/status and are cached in runner.db with the hub that gave them,
//   so a runner that starts while its hub is down still finds its vault, which projectKey names; another hub's cache
//   is never used. The vault's main branch is the one the hub's last start named (AttemptSpec.repo.mainBranch), kept
//   in runner.db too. Every adapter's preflight runs, and the link says hello.
// - Every HTTP call goes to the hub this runner serves: after a login to another hub they fail as signed out, as the
//   link's own connections do, so no transcript of one hub's project ever reaches another.
// - hello: the protocol, the runner's identity, the confirmed settings snapshot (never a local edit, X-12), the
//   vendors, quota and profile from vendorReport, git readiness (not ready when the vault could not be made, or after
//   three consecutive failed WIP pushes) and the last push, the health seam's state, the outbox's position
//   (outboxEpoch, firstSeq, lastSeq; X-1), the last hub epoch, and every recorded attempt. Each hello starts a new
//   lineage of commands in the executor, so no update_settings taken before it moves the snapshot it reported (X-12).
// - welcome: its wipRefPrefix and hub epoch are stored, and its timings (handoffMs, wipGraceMs) read from the link.
//   The executor applies its stop list before any command that follows it (X-28); after the first one, the journal
//   rows a previous run left running are settled, and late work it left pending (AttemptRecord.lateWorkSha) is
//   retried until it lands. Each controller then gets its outage nudge and held WIP, and every field runner.json
//   changed since the snapshot goes out as runner.settings (X-12).
// - Settings sync (settings-sync.ts, X-12): exact answers settle local edits, including refusals. Hello carries the
//   contiguous answer cutoff included in its snapshot. Every retained event is replayed; the hub alone skips edits
//   covered by a snapshot it adopted. A welcome of another hub epoch records that epoch and reconnects before any
//   command runs. runner.json's write may fail; the runner goes on with the settings it holds.
// - After a welcome, a runner.state or runner.vendors the outbox replays that differs from the hello goes out again
//   as it is now, so the hub's last word on each is current.
// - Heartbeats carry every live attempt's facts, a start still preparing included, which renews its lease, and the
//   health seam's power, disk and acceptingUntil; a change of the health seam's state since the last hello or report
//   goes out as runner.state.
// - Preflight runs again every preflightEvery; runner.vendors goes out only when the report changed.
// The runtime schedules no outbox pruning: M2c's retention calls pruneAcked (X-7).
// What M2c drives (design 7.1, X-7, X-41) is the RunnerHandle: status, local settings edits, the runner's own stops,
// the outage interrupt, WIP pushes, the executor's pause, waitAcked on the outbox, the vault and close. What it hears
// are the RunnerEvents callbacks: link, gap, welcome, needsLogin and attemptState, and done for the link's end.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  AGFLOW_VERSION,
  type AgentRole,
  type AttemptFacts,
  type AttemptPhase,
  DEFAULT_WIP_REF_PREFIX,
  type ExitCause,
  type Fence,
  PROTOCOL_VERSION,
  type Runner,
  type RunnerEvent,
  type RunnerVendor,
  type Vendor,
} from '@agflow/core';
import type { AgflowCommand, PreflightResult, VendorAdapter } from './adapters/types';
import { isCleanedUp } from './attempt/cleanup';
import { AttemptController, type ControllerDeps, type WipOutcome } from './attempt/controller';
import { pinnedCliVersion } from './attempt/launch';
import { WipFailures, wipGateOf } from './attempt/work';
import { AttemptStore, type LocalAttemptState } from './attempt-store';
import { AwakeClock, type ClockGap } from './clock';
import {
  localSettingsOf,
  loadRunnerConfig,
  type RunnerConfig,
  type SettingsEdits,
  type SettingsValues,
  saveRunnerConfig,
  settingsOf,
} from './config';
import { openRunnerDb, type RunnerDb } from './db';
import { CommandExecutor } from './executor';
import { ensureRunnerGitFiles, type GitEnvironment, localGitEnv, remoteGitEnv } from './git/run';
import { Vault } from './git/vault';
import { type FetchFn, RunnerHubHttp } from './hub-http';
import { Journal } from './journal';
import {
  type CredentialsProvider,
  type HeartbeatContent,
  type HelloMessage,
  LinkClient,
  type LinkState,
  sameHubUrl,
  type WelcomeMessage,
} from './link';
import { type Logger, noopLogger } from './log';
import { Outbox } from './outbox';
import { projectKey, type RunnerPaths } from './paths';
import type { ProcessIdentity } from './processes';
import { SerialQueue } from './queue';
import { liveAttemptsForHello, recoverOnStart } from './recovery';
import {
  defaultHealth,
  type DependencyPreparer,
  type Notifier,
  type RunnerHealth,
  silentNotifier,
  skipDependencyPreparer,
} from './seams';
import { vendorPlatform } from './vendor/pins';
import { type VendorReport, vendorReport } from './vendors';

export interface RunnerOptions {
  /** The runner's files: runnerPaths(AGFLOW_HOME). */
  paths: RunnerPaths;
  /** runner.json as the caller loaded it; read from paths.config when absent. The runtime writes it back. */
  config?: RunnerConfig;
  /** runner.db, opened by the caller with its own migrations; opened here, and closed by close(), when absent. */
  db?: RunnerDb;
  /** The CLI's credentials (M2c's readCliCredentials): the hub this runner serves, and its token. */
  credentials: CredentialsProvider;
  /** One per vendor this runner runs: createAdapters' in the service, fakes in tests. */
  adapters: VendorAdapter[];
  /** How the runner runs agflow itself: the bridge is `<agflow> mcp --vendor <v> --runner`. */
  agflow: AgflowCommand;
  /**
   * The CLI version a new attempt of the vendor starts with: this platform's pin (pinnedCliVersion) when absent, which
   * throws where VENDOR_PINS has none. Tests give fixtureCliVersion, so the runtime runs on CI's linux-x64 too.
   */
  cliVersion?: (vendor: Vendor) => string;
  /** The seams' defaults, which change nothing, when absent. */
  health?: RunnerHealth;
  preparer?: DependencyPreparer;
  notifier?: Notifier;
  logger?: Logger;
  /** The fetch of the HTTP calls: the global one by default. */
  fetch?: FetchFn;
  /** Where Claude attempts' private temporary directories go: /tmp by default. */
  tmpRoot?: string;
  /** What the runner tells its host as it happens. */
  events?: RunnerEvents;
}

/** An attempt's phase changed: null once no start, process or exit holds it; live counts the attempts that do. */
export interface AttemptStateChange {
  attemptId: string;
  phase: AttemptPhase | null;
  live: number;
}

/**
 * What the runner tells its host (X-7), exactly these callbacks, each called as it happens; one that throws is logged.
 * welcome is called before the executor runs any command that follows that welcome, resent ones included.
 */
export interface RunnerEvents {
  /** Each link state change, with the close code and reason of the socket that ended (null and '' otherwise). */
  link?(state: LinkState, detail: { code: number | null; reason: string }): void;
  /** A clock gap: the Mac slept, or the process froze. */
  gap?(gap: ClockGap): void;
  welcome?(welcome: WelcomeMessage): void;
  /** The hub refuses the CLI's token: once each time the link enters needs_login. */
  needsLogin?(): void;
  attemptState?(change: AttemptStateChange): void;
}

/** One attempt the runner still has (not cleaned up), as runner status shows it. */
export interface AttemptStatus {
  attemptId: string;
  taskId: string | null;
  role: AgentRole;
  vendor: Vendor;
  state: LocalAttemptState;
  /** Null when no start, process or exit holds it. */
  phase: AttemptPhase | null;
  /** The newest harvested work, and what the WIP ref holds as last pushed. */
  wipSha: string | null;
  pushedSha: string | null;
  lastPushAt: number | null;
  pushError: string | null;
  /**
   * Work that waits for a late-work ref (AttemptRecord.lateWorkSha): not on the origin yet. Null once all the
   * attempt's work is there, so it is what tells unpushed work.
   */
  lateWorkSha: string | null;
  /** The agent's process group as recorded: M2g and runner status --json find agents through it. */
  process: ProcessIdentity | null;
}

/** What `agflow runner status` reports of the running runner. */
export interface RunnerStatus {
  /** The runner's id on the hub, from the last welcome; null before one. */
  runnerId: string | null;
  link: LinkState;
  /** The health seam's state, as hello and runner.state report it. */
  state: ReturnType<RunnerHealth['state']>;
  /** runner.json's settings as they apply now, local edits included. */
  settings: SettingsValues;
  vendors: RunnerVendor[];
  git: Runner['git'];
  attempts: AttemptStatus[];
}

/**
 * How the runner ended: replaced (4409, another process uses its key), refused (4403), incompatible (4426), each with
 * the hub's reason, or closed by close().
 */
export interface RunnerEnd {
  kind: 'replaced' | 'refused' | 'incompatible' | 'closed';
  reason: string;
}

/** What createRunner gives: the running runner, which M2c drives (X-7, X-41). */
export interface RunnerHandle {
  status(): RunnerStatus;
  /**
   * A local edit: runner.json takes the patch, and the changed fields go out as runner.settings on the confirmed
   * snapshot's version. Resolves with that event's seq, for waitAcked; null when the patch changed nothing.
   */
  changeSettings(patch: SettingsEdits): Promise<number | null>;
  /**
   * The runner's own stops of every attempt, with a handoff turn or without: every agent is interrupted and stopped
   * at once, and their final harvests, pushes and attempt.exited go one at a time, the oldest unpushed work first.
   * Resolves with each attempt.exited's seq, in that order.
   */
  stopAgents(cause: ExitCause, options: { handoff: boolean }): Promise<number[]>;
  /** Interrupts every running turn without an exit; outage marks them for the one reconnect message (X-38). */
  interruptAgents(options: { outage: boolean }): Promise<void>;
  /**
   * A WIP push of every attempt's clone, each as canPushWip allows (held otherwise). Attempts a WIP push does not
   * apply to (leads, no clone, already exited) are left out; an unchanged clone is listed as unchanged.
   */
  pushWipNow(): Promise<{ attemptId: string; outcome: WipOutcome }[]>;
  /** Holds the commands that arrive, unjournaled, until resume(); work already dispatched goes on. */
  pause(): void;
  resume(): void;
  /** Whether the hub acknowledged the event with this seq within timeoutMs; true at once if it has. */
  waitAcked(seq: number, timeoutMs: number): Promise<boolean>;
  /** The project's vault, so M2c's daily consolidate shares its per-vault lock. */
  readonly vault: Vault;
  /** Ends the link and the runner's timers. Agents keep running: a suspend or a stop ends them first. */
  close(): Promise<void>;
  /** Resolves when the link ends for good (4409, 4403, 4426) or close() is called. */
  readonly done: Promise<RunnerEnd>;
}

/** A vendor's last preflight and when it ran. */
interface Preflight {
  result: PreflightResult;
  at: number;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Three consecutive failed WIP pushes make git not ready on the hub (design 6.3, attempt.wip_failed). */
const WIP_FAILURES_NOT_READY = 3;

/**
 * The project's name and repo from GET /api/status, cached in runner.db with the hub's URL for a start while the hub
 * is down. Throws when neither the hub nor a cache of this hub has them: another hub's project is never used, since
 * its repository would get this hub's attempts' work.
 */
async function projectOf(
  http: RunnerHubHttp,
  db: RunnerDb,
  hubUrl: string,
  logger: Logger,
): Promise<{ name: string; repo: string }> {
  try {
    const { name, repo } = await http.projectStatus();
    db.setMeta('project', { hubUrl, name, repo });
    return { name, repo };
  } catch (error) {
    const cached = db.meta('project');
    if (cached === null || !sameHubUrl(cached.hubUrl, hubUrl)) {
      throw new Error(`cannot read the project from the hub: ${describe(error)}`);
    }
    logger.warn('cannot read the project from the hub; using the cached one', { error: describe(error) });
    return { name: cached.name, repo: cached.repo };
  }
}

/** The facts of a start or resume still under way: no agent event yet, so nothing for a stall rule to read. */
function startingFacts(attemptId: string, fence: Fence, phase: AttemptPhase): AttemptFacts {
  return {
    attemptId,
    fence,
    phase,
    eventAgeMs: 0,
    tool: null,
    fsAgeMs: null,
    commitAgeMs: null,
    turns: 0,
    turnsWithoutProgress: 0,
    repeatedCalls: 0,
    continuations: 0,
    vendorErrorMs: 0,
    activeMs: 0,
    contextUsed: null,
  };
}

/**
 * What a vendor report says, without when it was made: two preflights that found the same are the same report, and
 * runner.vendors goes out only when this changes.
 */
function reportSignature(report: Pick<VendorReport, 'vendors' | 'quota'>): string {
  const vendors = report.vendors.map(({ preflightAt: _at, ...facts }) => facts);
  const quota = report.quota.map((entry) => ({ ...entry, quota: { ...entry.quota, updatedAt: 0 } }));
  return JSON.stringify({ vendors, quota });
}

/** One adapter's preflight; one that throws is not ready, with its error as the problem. */
async function preflightOf(adapter: VendorAdapter): Promise<Preflight> {
  try {
    return { result: await adapter.preflight(), at: Date.now() };
  } catch (error) {
    const facts = {
      vendor: adapter.vendor,
      cliVersion: null,
      ownerCliVersion: null,
      ready: false,
      problem: `the preflight failed: ${describe(error)}`,
      accountId: null,
      plan: null,
      managedPolicy: false,
    };
    return { result: { facts, quota: null, weakened: [] }, at: Date.now() };
  }
}

export async function createRunner(options: RunnerOptions): Promise<RunnerHandle> {
  const logger = options.logger ?? noopLogger;
  const config = options.config ?? loadRunnerConfig(options.paths.config);
  const ownDb = options.db === undefined;
  if (ownDb) mkdirSync(dirname(options.paths.db), { recursive: true, mode: 0o700 });
  const db = options.db ?? openRunnerDb(options.paths.db);
  try {
    // Before anything that may fail: no agent or escaped tool of a previous run keeps writing, signed in or not.
    const store = new AttemptStore(db);
    await recoverOnStart(store, logger);
    const credentials = await options.credentials();
    if (credentials === null) throw new Error('not signed in to an agflow hub; run agflow login');
    const hubUrl = credentials.hubUrl;
    // Pinned to the hub this runner serves, as the link pins its own connections.
    const pinned: CredentialsProvider = async () => {
      const current = await options.credentials();
      return current !== null && sameHubUrl(current.hubUrl, hubUrl) ? current : null;
    };
    const http = new RunnerHubHttp({ credentials: pinned, fetch: options.fetch });
    const project = await projectOf(http, db, hubUrl, logger);
    ensureRunnerGitFiles(options.paths);
    const vault = new Vault({
      paths: options.paths,
      project: projectKey(hubUrl, project.name),
      // 'main' only until a start names the hub's main branch.
      repo: { url: project.repo, mainBranch: db.meta('mainBranch') ?? 'main' },
      mainBranchChanged: (mainBranch) => db.setMeta('mainBranch', mainBranch),
    });
    // A vault that cannot be made is reported in hello as git not ready; the starts that need it fail by themselves.
    const gitProblem = await vault.ensure().then(
      () => null,
      (error) => `cannot prepare the vault: ${describe(error)}`,
    );
    if (gitProblem !== null) logger.error('cannot prepare the vault', { error: gitProblem });
    const preflights = await Promise.all(options.adapters.map(preflightOf));
    const runtime = new Runtime({ options, logger, config, db, ownDb, hubUrl, http, vault, store });
    runtime.gitProblem = gitProblem;
    for (const preflight of preflights) runtime.preflights.set(preflight.result.facts.vendor, preflight);
    runtime.start();
    return runtime.handle();
  } catch (error) {
    if (ownDb) db.close();
    throw error;
  }
}

interface RuntimeInput {
  options: RunnerOptions;
  logger: Logger;
  config: RunnerConfig;
  db: RunnerDb;
  /** runner.db was opened here, so close() closes it. */
  ownDb: boolean;
  hubUrl: string;
  http: RunnerHubHttp;
  vault: Vault;
  store: AttemptStore;
}

/** One running runner: its parts, and how they meet the link. */
class Runtime {
  /** Why the vault could not be made at start; hello reports git as not ready then. */
  gitProblem: string | null = null;
  /** Each vendor's last preflight. */
  readonly preflights = new Map<Vendor, Preflight>();
  private config: RunnerConfig;
  private readonly options: RunnerOptions;
  private readonly logger: Logger;
  private readonly db: RunnerDb;
  private readonly ownDb: boolean;
  private readonly http: RunnerHubHttp;
  private readonly vault: Vault;
  private readonly store: AttemptStore;
  private readonly outbox: Outbox;
  private readonly local: GitEnvironment;
  private readonly queue = new SerialQueue();
  private readonly clock: AwakeClock;
  private readonly link: LinkClient;
  private readonly executor: CommandExecutor;
  private readonly controllers = new Map<string, AttemptController>();
  private readonly adapters: ReadonlyMap<Vendor, VendorAdapter>;
  private readonly wipFailures = new WipFailures();
  /** The journal rows a previous run left running were settled after the first welcome. */
  private recovered = false;
  private readonly events: RunnerEvents;
  private readonly ended = Promise.withResolvers<RunnerEnd>();
  /** The runner's id from the last welcome. */
  private runnerId: string | null = null;
  /** The health seam's state as the hub last heard it: in hello, or as runner.state. */
  private reportedState: ReturnType<RunnerHealth['state']> | null = null;
  /** The vendor report as the hub last heard it (reportSignature). */
  private reportedVendors: string | null = null;
  private preflightTimer: ReturnType<typeof setInterval> | null = null;
  private preflighting = false;
  private readonly stopGaps: () => void;

  constructor(input: RuntimeInput) {
    const { options, logger, db } = input;
    this.options = options;
    this.logger = logger;
    this.config = input.config;
    this.db = db;
    this.ownDb = input.ownDb;
    this.http = input.http;
    this.vault = input.vault;
    this.store = input.store;
    // The marks of settings echoes count once the snapshot the runner holds has their version (X-12); an Outbox
    // built for retention alone counts them up to the version runner.json was last written with.
    this.outbox = new Outbox(db, { confirmedVersion: () => this.config.confirmedSettings.version });
    this.outbox.settingsSaved(this.config.confirmedSettings.version);
    this.local = localGitEnv(options.paths);
    this.adapters = new Map(options.adapters.map((adapter) => [adapter.vendor, adapter]));
    this.events = options.events ?? {};
    this.clock = new AwakeClock({ gapMs: this.config.timings.tickGap, logger });
    this.stopGaps = this.clock.onGap((gap) => this.emit('gap', () => this.events.gap?.(gap)));
    this.link = new LinkClient({
      credentials: options.credentials,
      hubUrl: input.hubUrl,
      outbox: this.outbox,
      clock: this.clock,
      timings: this.config.timings,
      // Each hello starts a new lineage of commands: the echoes taken before it answer nothing (X-12).
      hello: () => {
        this.executor.helloSent();
        return this.hello();
      },
      heartbeat: () => this.heartbeat(),
      handlers: {
        onCommand: (message) => this.executor.onCommand(message),
        onWelcome: (welcome) => this.welcomed(welcome),
        onState: (state, detail) => this.emit('link', () => this.events.link?.(state, detail)),
        onNeedsLogin: () => this.emit('needsLogin', () => this.events.needsLogin?.()),
        onReplaced: (reason) => this.ended.resolve({ kind: 'replaced', reason }),
        onRefused: (reason) => this.ended.resolve({ kind: 'refused', reason }),
        onIncompatible: (reason) => this.ended.resolve({ kind: 'incompatible', reason }),
      },
      http: this.http,
      logger,
    });
    this.executor = new CommandExecutor({
      journal: new Journal(db),
      controller: (attemptId) => this.controller(attemptId),
      known: (attemptId) => this.controllers.has(attemptId) || this.store.get(attemptId) !== null,
      config: () => this.config,
      // The runner holds the new settings even when runner.json cannot be written (SettingsSync).
      saveConfig: (config) => {
        this.config = config;
        saveRunnerConfig(options.paths.config, config);
      },
      outbox: this.outbox,
      vault: this.vault,
      local: this.local,
      remote: () => this.remote(),
      wipRefPrefix: () => this.wipRefPrefix(),
      adapters: this.adapters,
      preflighted: (result) => this.preflights.set(result.facts.vendor, { result, at: Date.now() }),
      // The executor sends it as runner.vendors: the hub hears this report.
      vendors: () => {
        const { vendors, quota } = this.vendorReport();
        this.reportedVendors = reportSignature({ vendors, quota });
        return { vendors, quota };
      },
      logger,
    });
  }

  start(): void {
    this.reportedVendors = reportSignature(this.vendorReport());
    this.clock.start();
    this.link.start();
    this.preflightTimer = setInterval(() => void this.preflightAgain(), this.config.timings.preflightEvery);
    this.preflightTimer.unref?.();
  }

  async close(): Promise<void> {
    this.link.close();
    this.executor.close();
    this.clock.stop();
    this.stopGaps();
    if (this.preflightTimer !== null) clearInterval(this.preflightTimer);
    this.preflightTimer = null;
    for (const controller of this.controllers.values()) controller.close();
    if (this.ownDb) this.db.close();
    this.ended.resolve({ kind: 'closed', reason: '' });
  }

  /** The handle createRunner gives. */
  handle(): RunnerHandle {
    return {
      status: () => this.status(),
      changeSettings: async (patch) => this.changeSettings(patch),
      stopAgents: (cause, options) => this.stopAgents(cause, options),
      interruptAgents: (options) => this.interruptAgents(options),
      pushWipNow: () => this.pushWipNow(),
      pause: () => this.executor.pause(),
      resume: () => this.executor.resume(),
      waitAcked: (seq, timeoutMs) => this.outbox.waitAcked(seq, timeoutMs),
      vault: this.vault,
      close: () => this.close(),
      done: this.ended.promise,
    };
  }

  private status(): RunnerStatus {
    const attempts = this.store
      .list()
      .filter((record) => !isCleanedUp(record))
      .map((record): AttemptStatus => {
        const controller = this.controllers.get(record.attemptId);
        const groups = this.store.processes(record.attemptId);
        const pid = controller?.session?.pid;
        const group = groups.find((recorded) => recorded.pid === pid) ?? groups[0];
        return {
          attemptId: record.attemptId,
          taskId: record.spec.taskId,
          role: record.spec.role,
          vendor: record.spec.vendor,
          state: record.state,
          phase: controller?.phase ?? null,
          wipSha: record.wipSha,
          pushedSha: record.pushedSha,
          lastPushAt: record.lastPushAt,
          pushError: record.pushError,
          lateWorkSha: record.lateWorkSha,
          process: group === undefined ? null : { pid: group.pid, pgid: group.pgid, lstart: group.lstart },
        };
      });
    return {
      runnerId: this.runnerId,
      link: this.link.state,
      state: this.health.state(),
      settings: localSettingsOf(this.config),
      vendors: this.vendorReport().vendors,
      git: this.gitReport(),
      attempts,
    };
  }

  /** A local edit through runner.json, sent as runner.settings (SettingsSync.change, X-12); gives its seq, or null. */
  private changeSettings(patch: SettingsEdits): number | null {
    return this.executor.settings.change(patch);
  }

  /**
   * Every attempt that holds a slot, all stopped at once, so a suspend's deadline never leaves an agent unstopped
   * (design 7.1). Their final work goes one at a time, the oldest unpushed work first: the attempt whose last push
   * (or, never pushed, whose start) is oldest. Each waits for the stop before it, however that one ended.
   */
  private async stopAgents(cause: ExitCause, options: { handoff: boolean }): Promise<number[]> {
    const since = (controller: AttemptController) => {
      const record = this.store.get(controller.attemptId);
      return record === null ? Number.POSITIVE_INFINITY : (record.lastPushAt ?? record.createdAt);
    };
    const holding = [...this.controllers.values()].filter((controller) => controller.holdsSlot);
    holding.sort((a, b) => since(a) - since(b));
    let previous: Promise<unknown> = Promise.resolve();
    const stops = holding.map((controller) => {
      const after = previous.then(() => {});
      const stop = controller.stopForRunner(cause, { ...options, after }).catch((error) => {
        const fields = { attemptId: controller.attemptId, error: describe(error) };
        this.logger.error("cannot stop an attempt for the runner's stop", fields);
        return null;
      });
      previous = stop;
      return stop;
    });
    const outcomes = await Promise.all(stops);
    return outcomes.flatMap((outcome) => (outcome?.ok ? [outcome.exitedSeq] : []));
  }

  private async interruptAgents(options: { outage: boolean }): Promise<void> {
    const live = [...this.controllers.values()].filter((controller) => controller.session !== null);
    await Promise.all(
      live.map((controller) =>
        controller.interrupt({ outage: options.outage }).catch((error) => {
          this.logger.warn('cannot interrupt an agent', { attemptId: controller.attemptId, error: describe(error) });
        }),
      ),
    );
  }

  private async pushWipNow(): Promise<{ attemptId: string; outcome: WipOutcome }[]> {
    const pushes = [...this.controllers.values()].map(async (controller) => ({
      attemptId: controller.attemptId,
      outcome: await controller.pushWip(),
    }));
    return (await Promise.all(pushes)).filter((push) => push.outcome.status !== 'skipped');
  }

  /** Every adapter's preflight again; runner.vendors goes out only when the report changed. */
  private async preflightAgain(): Promise<void> {
    if (this.preflighting) return;
    this.preflighting = true;
    try {
      const preflights = await Promise.all(this.options.adapters.map(preflightOf));
      for (const preflight of preflights) this.preflights.set(preflight.result.facts.vendor, preflight);
      const { vendors, quota } = this.vendorReport();
      const signature = reportSignature({ vendors, quota });
      if (signature === this.reportedVendors) return;
      this.outbox.append({ type: 'runner.vendors', data: { vendors, quota } });
      this.reportedVendors = signature;
    } catch (error) {
      this.logger.error('the periodic preflight failed', { error: describe(error) });
    } finally {
      this.preflighting = false;
    }
  }

  /** Calls one of the host's callbacks; a throw is logged, never passed on. */
  private emit(name: keyof RunnerEvents, call: () => void): void {
    try {
      call();
    } catch (error) {
      this.logger.error('a runner event listener failed', { event: name, error: describe(error) });
    }
  }

  private get health(): RunnerHealth {
    return this.options.health ?? defaultHealth;
  }

  private get preparer(): DependencyPreparer {
    return this.options.preparer ?? skipDependencyPreparer;
  }

  /** The attempt's controller, made the first time a command or a welcome names it. */
  private controller(attemptId: string): AttemptController {
    let controller = this.controllers.get(attemptId);
    if (controller === undefined) {
      controller = new AttemptController(attemptId, this.deps(attemptId));
      this.controllers.set(attemptId, controller);
    }
    return controller;
  }

  private deps(attemptId: string): ControllerDeps {
    const { options } = this;
    return {
      config: () => this.config,
      paths: options.paths,
      store: this.store,
      outbox: this.outbox,
      queue: this.queue,
      vault: this.vault,
      local: this.local,
      adapters: this.adapters,
      health: this.health,
      preparer: this.preparer,
      notifier: options.notifier ?? silentNotifier,
      logger: this.logger,
      liveAttempts: () =>
        [...this.controllers.values()].filter((other) => other.attemptId !== attemptId && other.holdsSlot).length,
      vendorReady: (vendor) => this.preflights.get(vendor)?.result.facts.ready === true,
      wipRefPrefix: () => this.wipRefPrefix(),
      tmpRoot: options.tmpRoot ?? '/tmp',
      agflow: options.agflow,
      cliVersion: options.cliVersion ?? ((vendor) => pinnedCliVersion(vendor)),
      clock: this.clock,
      remote: () => this.remote(),
      wipGate: wipGateOf(this.link, this.clock),
      wipFailures: this.wipFailures,
      hub: this.http,
      handoffMs: () => this.link.welcome?.timings.handoffMs ?? this.config.timings.handoff,
      linkUp: () => this.link.state === 'online',
      phaseChanged: (phase) => {
        const live = [...this.controllers.values()].filter((controller) => controller.holdsSlot).length;
        this.emit('attemptState', () => this.events.attemptState?.({ attemptId, phase, live }));
      },
    };
  }

  private remote(): Promise<GitEnvironment> {
    return remoteGitEnv({ gitDir: this.vault.path });
  }

  /** The last welcome's prefix; the stored one before a welcome; the hub's default before any. */
  private wipRefPrefix(): string {
    return this.link.welcome?.wipRefPrefix ?? this.db.meta('wipRefPrefix') ?? DEFAULT_WIP_REF_PREFIX;
  }

  /** What hello says about the vendors: each one's facts as of its own preflight, and the merged profile. */
  private vendorReport(): VendorReport {
    const preflights = [...this.preflights.values()];
    const each = preflights.map(({ result, at }) =>
      vendorReport({ config: this.config, preflights: [result], at, preparer: this.preparer }),
    );
    const merged = vendorReport({
      config: this.config,
      preflights: preflights.map(({ result }) => result),
      at: Date.now(),
      preparer: this.preparer,
    });
    return {
      vendors: each.flatMap((report) => report.vendors),
      quota: each.flatMap((report) => report.quota),
      profile: merged.profile,
    };
  }

  /** Git readiness: the vault's problem at start, or WIP pushes that keep failing; and the last push of any attempt. */
  private gitReport(): Runner['git'] {
    const pushes = this.store.list().flatMap((record) => (record.lastPushAt === null ? [] : [record.lastPushAt]));
    const failures = this.wipFailures.consecutive;
    const problem =
      this.gitProblem ?? (failures >= WIP_FAILURES_NOT_READY ? `${failures} consecutive WIP pushes failed` : null);
    return { ready: problem === null, problem, lastPushAt: pushes.length === 0 ? null : Math.max(...pushes) };
  }

  private hello(): HelloMessage {
    const { vendors, quota, profile } = this.vendorReport();
    this.reportedVendors = reportSignature({ vendors, quota });
    const git = this.gitReport();
    const { state, detail } = this.health.state();
    this.reportedState = { state, detail };
    return {
      t: 'hello',
      protocol: PROTOCOL_VERSION,
      runnerKey: this.config.runnerKey,
      machineId: this.config.machineId,
      name: this.config.name,
      agflowVersion: AGFLOW_VERSION,
      platform: vendorPlatform(),
      settings: settingsOf(this.config),
      settingsAnsweredSeq: this.outbox.settingsAnsweredSeq(),
      settingsAnsweredSparse: this.outbox.settingsAnsweredSparse(),
      vendors,
      quota,
      profile,
      git,
      state,
      stateDetail: detail,
      outboxEpoch: this.outbox.epoch,
      firstSeq: this.outbox.firstSeq(),
      lastSeq: this.outbox.lastSeq(),
      lastHubEpoch: this.db.meta('lastHubEpoch'),
      attempts: liveAttemptsForHello(this.store, this.controllers),
    };
  }

  /** Each heartbeat's content; a health state the hub has not heard yet goes out first, as runner.state. */
  private heartbeat(): HeartbeatContent {
    const now = this.health.state();
    const reported = this.reportedState;
    if (reported === null || reported.state !== now.state || reported.detail !== now.detail) {
      this.reportedState = { state: now.state, detail: now.detail };
      const data: Extract<RunnerEvent, { type: 'runner.state' }>['data'] = { state: now.state, detail: now.detail };
      this.outbox.append({ type: 'runner.state', data });
    }
    const attempts = [...this.controllers.values()].flatMap((controller): AttemptFacts[] => {
      const facts = controller.facts();
      if (facts !== null) return [facts];
      // A start or resume with no process yet holds its lease through the heartbeats that list it (design 6.4).
      const { phase, fence } = controller;
      if ((phase === 'starting' || phase === 'preparing') && fence !== null) {
        return [startingFacts(controller.attemptId, fence, phase)];
      }
      return [];
    });
    return { attempts, ...this.health.heartbeat() };
  }

  /**
   * A restored hub gets a replacement hello before any command or replay. Record its epoch first; a failed write
   * backs off and retries at the next welcome. Settings replay cutoffs are persisted by the hub during adoption.
   */
  private welcomed(welcome: WelcomeMessage): void {
    const lastHubEpoch = this.db.meta('lastHubEpoch');
    try {
      this.db.setMeta('wipRefPrefix', welcome.wipRefPrefix);
    } catch (error) {
      this.logger.error('cannot record the WIP ref prefix', { error: describe(error) });
    }
    if (lastHubEpoch !== null && lastHubEpoch !== welcome.hubEpoch) {
      try {
        this.db.setMeta('lastHubEpoch', welcome.hubEpoch);
      } catch (error) {
        this.logger.error('cannot record the restored hub', { error: describe(error) });
        this.link.reconnectWithBackoff('cannot record the restored hub');
        return;
      }
      this.logger.warn('the hub was restored from a backup; saying hello again', {
        hubEpoch: welcome.hubEpoch,
        lastHubEpoch,
      });
      this.link.reconnectNow('a restored hub');
      return;
    }
    try {
      this.db.setMeta('lastHubEpoch', welcome.hubEpoch);
    } catch (error) {
      this.logger.error('cannot record the hub epoch', { error: describe(error) });
    }
    this.runnerId = welcome.runnerId;
    this.emit('welcome', () => this.events.welcome?.(welcome));
    // The attempts it ended are marked so at once; their stops run on their queues.
    void this.executor.onWelcome(welcome);
    if (!this.recovered) {
      this.recovered = true;
      this.executor.recover().catch((error) => {
        this.logger.error('cannot settle the commands a previous run left', { error: describe(error) });
      });
      this.resumeLateWork();
    }
    for (const controller of this.controllers.values()) {
      controller.onWelcome().catch((error) => {
        const fields = { attemptId: controller.attemptId, error: describe(error) };
        this.logger.error('a welcome failed for an attempt', fields);
      });
    }
    // A write that fails here is logged: the welcome's handling goes on, and the link replays the outbox after it.
    try {
      this.reportAfterReplay();
    } catch (error) {
      this.logger.error('cannot report the state after the replay', { error: describe(error) });
    }
    try {
      this.executor.settings.welcomed();
    } catch (error) {
      this.logger.error('cannot send the settings edits after the welcome', { error: describe(error) });
    }
  }

  /**
   * At the first welcome: late work a previous run left pending (AttemptRecord.lateWorkSha) is retried until it lands,
   * as that run's retries would have been, under the welcome's WIP ref prefix. A cleanup clears the record's.
   */
  private resumeLateWork(): void {
    for (const record of this.store.list()) {
      if (record.lateWorkSha === null) continue;
      try {
        this.controller(record.attemptId).resumeLateWork();
      } catch (error) {
        this.logger.error('cannot resume the late work', { attemptId: record.attemptId, error: describe(error) });
      }
    }
  }

  /**
   * The events the hub has not acknowledged are replayed after this welcome, so after the hello the hub has just
   * applied. A runner.state or runner.vendors among them that says something other than the hello would leave the
   * hub with the older report, and nothing would correct it: the current one goes out again, after them.
   */
  private reportAfterReplay(): void {
    const replayed = this.outbox.eventsAfter(this.outbox.ackedSeq());
    const state = replayed.findLast((event) => event.type === 'runner.state');
    const reported = this.reportedState;
    if (state?.type === 'runner.state' && reported !== null) {
      if (state.data.state !== reported.state || state.data.detail !== reported.detail) {
        this.outbox.append({ type: 'runner.state', data: { state: reported.state, detail: reported.detail } });
      }
    }
    const vendors = replayed.findLast((event) => event.type === 'runner.vendors');
    if (vendors?.type === 'runner.vendors' && reportSignature(vendors.data) !== this.reportedVendors) {
      const { vendors: current, quota } = this.vendorReport();
      this.reportedVendors = reportSignature({ vendors: current, quota });
      this.outbox.append({ type: 'runner.vendors', data: { vendors: current, quota } });
    }
  }
}
