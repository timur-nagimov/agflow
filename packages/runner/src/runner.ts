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
// - Settings sync (settings-sync.ts, X-12): each ack, and each welcome, checks for a settings edit the hub
//   acknowledged and never echoed, once the commands received before it have run. A welcome of another hub epoch is
//   a restored hub's: the runner records the events it holds then and says hello again at once, before it runs or
//   sends anything, so that hub reconciles against the runner's snapshot, not what its backup knew of it. The replays
//   to it leave out the edits held then whose answer the snapshot holds, which it would apply twice. runner.json's
//   write may fail; the runner goes on with the settings it holds.
// - Heartbeats carry every live attempt's facts, a start still preparing included, which renews its lease, and the
//   health seam's power, disk and acceptingUntil.
// The runtime schedules no outbox pruning: M2c's retention calls pruneAcked (X-7).
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  AGFLOW_VERSION,
  type AttemptFacts,
  type AttemptPhase,
  DEFAULT_WIP_REF_PREFIX,
  type Fence,
  PROTOCOL_VERSION,
  type Runner,
  type Vendor,
} from '@agflow/core';
import type { AgflowCommand, PreflightResult, VendorAdapter } from './adapters/types';
import { AttemptController, type ControllerDeps } from './attempt/controller';
import { pinnedCliVersion } from './attempt/launch';
import { WipFailures, wipGateOf } from './attempt/work';
import { AttemptStore } from './attempt-store';
import { AwakeClock } from './clock';
import { loadRunnerConfig, type RunnerConfig, saveRunnerConfig, settingsOf } from './config';
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
  sameHubUrl,
  type WelcomeMessage,
} from './link';
import { type Logger, noopLogger } from './log';
import { Outbox } from './outbox';
import { projectKey, type RunnerPaths } from './paths';
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
}

/** What createRunner gives: the running runner. */
export interface RunnerHandle {
  /** Ends the link and the runner's timers. Agents keep running: a suspend or a stop ends them first. */
  close(): Promise<void>;
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
    return { close: () => runtime.close() };
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
  private readonly stopAcks: () => void;

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
    this.clock = new AwakeClock({ gapMs: this.config.timings.tickGap, logger });
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
      resent: (event) => this.executor.settings.resent(event),
      handlers: {
        onCommand: (message) => this.executor.onCommand(message),
        onWelcome: (welcome) => this.welcomed(welcome),
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
      // The executor sends it as runner.vendors.
      vendors: () => {
        const { vendors, quota } = this.vendorReport();
        return { vendors, quota };
      },
      logger,
    });
    this.stopAcks = this.outbox.onAck(() => void this.executor.settingsAcknowledged({ welcome: false }));
  }

  start(): void {
    this.clock.start();
    this.link.start();
  }

  async close(): Promise<void> {
    this.link.close();
    this.executor.close();
    this.clock.stop();
    this.stopAcks();
    for (const controller of this.controllers.values()) controller.close();
    if (this.ownDb) this.db.close();
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
      health: options.health ?? defaultHealth,
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
    const git = this.gitReport();
    const { state, detail } = (this.options.health ?? defaultHealth).state();
    return {
      t: 'hello',
      protocol: PROTOCOL_VERSION,
      runnerKey: this.config.runnerKey,
      machineId: this.config.machineId,
      name: this.config.name,
      agflowVersion: AGFLOW_VERSION,
      platform: vendorPlatform(),
      settings: settingsOf(this.config),
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

  private heartbeat(): HeartbeatContent {
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
    return { attempts, ...(this.options.health ?? defaultHealth).heartbeat() };
  }

  /**
   * Each welcome, before any message that follows it. A hub epoch other than the last welcome's is a hub restored from
   * a backup (X-12): the runner records the events it holds then (Outbox.hubRestored), whose settings edits the replays
   * to that hub leave out when the snapshot holds their answer, and says hello again at once, before it runs or sends
   * anything. The hub reconciled the first hello against what it knew of the runner, perhaps nothing (a backup older
   * than the runner): the second finds its snapshot there, at its version or adopted, and whatever the first one made
   * the hub send cancelled. The epoch is written last, so a death before it records the events again.
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
        this.outbox.hubRestored();
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
      this.executor.settings.welcomed({ ackedSeq: welcome.ackedSeq });
    } catch (error) {
      this.logger.error('cannot send the settings edits after the welcome', { error: describe(error) });
    }
    void this.executor.settingsAcknowledged({ welcome: true });
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
}
