// The runner test fixture: everything an AttemptController needs, on local files only. A temporary AGFLOW_HOME
// with runner.db and the runner's git files, a local bare origin and the project's vault, a fake adapter per
// vendor, an outbox reader, a hub HTTP that records what the runner posts, and a spec builder. Each test file calls
// cleanupRunnerFixtures from afterEach, which kills every agent the fixture's controllers started and waits for
// their work to settle. M2d's tests reuse it.
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AttemptSpec, restoreSet, type RunnerEvent, type Vendor } from '@agflow/core';
import { FakeAdapter, type FakeScript, type OriginRepo, originRepo } from '@agflow/testkit';
import type { AgflowCommand, VendorAdapter } from '../src/adapters/types';
import { AttemptController, type ControllerDeps } from '../src/attempt/controller';
import { pinnedCliVersion } from '../src/attempt/launch';
import { WipFailures } from '../src/attempt/work';
import { AttemptStore } from '../src/attempt-store';
import { AwakeClock } from '../src/clock';
import { type RunnerConfig, type RunnerConfigInput, RunnerConfigSchema } from '../src/config';
import { openRunnerDb, type RunnerDb } from '../src/db';
import { ensureRunnerGitFiles, type GitEnvironment, localGitEnv, remoteGitEnv } from '../src/git/run';
import { Vault } from '../src/git/vault';
import { memoryLogger } from '../src/log';
import { Outbox } from '../src/outbox';
import { type RunnerPaths, runnerPaths } from '../src/paths';
import { killGroup } from '../src/processes';
import { SerialQueue } from '../src/queue';
import { removeAgentTools } from '../src/run-dir';
import { defaultHealth, silentNotifier, skipDependencyPreparer } from '../src/seams';

export const FIXTURE_PROJECT = 'demo-0123456789';
export const FIXTURE_WIP_PREFIX = 'refs/agflow/';
/** How the fixture's runner runs agflow: the bridge is `<this> mcp --vendor <v> --runner`. */
export const FIXTURE_AGFLOW: AgflowCommand = { command: '/opt/agflow/bin/agflow', args: ['--profile', 'test'] };

/**
 * The CLI version the fixture's attempts start with: darwin-arm64's pin, whatever platform the tests run on, so the
 * suites pass where agflow pins no CLI (CI's linux-x64).
 */
export function fixtureCliVersion(vendor: Vendor): string {
  return pinnedCliVersion(vendor, 'darwin-arm64');
}

/** Polls until check gives a value, or fails after timeoutMs. */
export async function waitFor<T>(check: () => T | null | undefined | false, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value !== null && value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`waited ${timeoutMs} ms in vain`);
    await Bun.sleep(10);
  }
}

/** The fixture's agent token of an attempt: well-formed (agt_ and 43 base64url characters), and one per attempt. */
export function fixtureAgentToken(attemptId: string): string {
  return `agt_${createHash('sha256').update(attemptId).digest('base64url')}`;
}

/**
 * Timings short enough for tests; runner.json's test block allows them. continuationWait is long, so an agent idles
 * after its turn unless a test asks for continuations.
 */
const TEST_TIMINGS = {
  stopInterrupt: 500,
  stopClose: 500,
  stopKill: 500,
  continuationWait: 60_000,
  finalPush: 5_000,
  hold: 2_000,
  handoff: 2_000,
};

/** What the runner posted to the hub over HTTP. */
export class RecordingHubHttp {
  readonly transcripts: { attemptId: string; transcript: string }[] = [];

  async uploadTranscript(attemptId: string, transcript: string): Promise<void> {
    this.transcripts.push({ attemptId, transcript });
  }
}

export interface RunnerFixtureOptions {
  /** Over the fixture's runner.json. */
  config?: Partial<RunnerConfigInput>;
  /** The origin's files on main. */
  files?: Record<string, string>;
  /** The fake adapters' script; one turn that does nothing by default. */
  script?: FakeScript | ((launch: Parameters<FakeAdapter['start']>[0]) => FakeScript);
  /** Adapters instead of the fake ones. */
  adapters?: VendorAdapter[];
}

export interface RunnerFixture {
  /** The temporary AGFLOW_HOME. */
  home: string;
  paths: RunnerPaths;
  /** The live settings; tests change them in place. */
  config: RunnerConfig;
  db: RunnerDb;
  store: AttemptStore;
  outbox: Outbox;
  queue: SerialQueue;
  origin: OriginRepo;
  vault: Vault;
  local: GitEnvironment;
  adapters: Map<Vendor, VendorAdapter>;
  /** The fake adapter of each vendor, unless the options gave adapters. */
  fakes: Partial<Record<Vendor, FakeAdapter>>;
  hub: RecordingHubHttp;
  logger: ReturnType<typeof memoryLogger>;
  /** The awake clock the controllers read; never started, so it advances with wall time. */
  clock: AwakeClock;
  /** What the controllers' canPushWip reads; by default a welcome since the last gap and a fresh ack. */
  gate: { welcomeSinceGap: boolean; ackAgeMs: number; wipGraceMs: number };
  /** The consecutive failed WIP pushes, shared by the fixture's controllers. */
  wipFailures: WipFailures;
  /** Where Claude attempts' private temporary directories go: a short directory under /tmp. */
  tmpRoot: string;
  /** What deps.liveAttempts() answers. */
  liveAttempts: number;
  /** What deps.linkUp() answers: up by default. */
  link: { up: boolean };
  /** What deps.vendorReady(vendor) answers. */
  ready: Record<Vendor, boolean>;
  /** The outbox's events, oldest first; only those of the type when one is given. */
  events<T extends RunnerEvent['type']>(type?: T): Extract<RunnerEvent, { type: T }>[];
  /**
   * A valid AttemptSpec for this fixture's origin: a worker of T-4 on claude, starting from main. Its agent token is
   * fixtureAgentToken of its attempt id, unless the overrides give one.
   */
  spec(overrides?: Partial<AttemptSpec>): AttemptSpec;
  deps(overrides?: Partial<ControllerDeps>): ControllerDeps;
  controller(attemptId?: string, overrides?: Partial<ControllerDeps>): AttemptController;
}

const cleanups: (() => void | Promise<void>)[] = [];

/** Removes every fixture made since the last call, newest first. */
export async function cleanupRunnerFixtures(): Promise<void> {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export async function createRunnerFixture(options: RunnerFixtureOptions = {}): Promise<RunnerFixture> {
  const home = tempDir('agflow-fixture-home-');
  const paths = runnerPaths(home);
  ensureRunnerGitFiles(paths);
  // The attempts' tools directories are read-only: they must be made writable before the home can go.
  cleanups.push(() => {
    const tools = join(paths.vaults, `${FIXTURE_PROJECT}.agent`);
    if (!existsSync(tools)) return;
    for (const attempt of readdirSync(tools)) removeAgentTools(join(tools, attempt));
  });
  // Short, as Claude's private temporary directories must be (makeAttemptTmpDir).
  const tmpRoot = mkdtempSync('/tmp/ag');
  cleanups.push(() => rmSync(tmpRoot, { recursive: true, force: true }));
  const config = RunnerConfigSchema.parse({
    runnerKey: 'runner-key-test',
    machineId: 'machine-test',
    name: 'test runner',
    test: { skipAuthChecks: true, allowShortTimings: true },
    ...options.config,
    timings: { ...TEST_TIMINGS, ...options.config?.timings },
  });
  const db = openRunnerDb(paths.db);
  cleanups.push(() => db.close());
  const origin = await originRepo(options.files ?? { 'README.md': '# demo\n', 'src/app.ts': 'app\n' });
  cleanups.push(() => origin.remove());
  // The owner's git configuration never reaches the vault's fetches: an empty HOME stands in for theirs.
  const ownerHome = tempDir('agflow-fixture-owner-');
  const ownerEnv = { ...process.env, HOME: ownerHome, XDG_CONFIG_HOME: undefined };
  const vault = new Vault({
    paths,
    project: FIXTURE_PROJECT,
    repo: { url: origin.path, mainBranch: 'main' },
    remote: () => remoteGitEnv({ base: ownerEnv }),
  });
  await vault.ensure();
  const fakes: Partial<Record<Vendor, FakeAdapter>> = {};
  const adapters = new Map<Vendor, VendorAdapter>();
  if (options.adapters) {
    for (const adapter of options.adapters) adapters.set(adapter.vendor, adapter);
  } else {
    for (const vendor of ['claude', 'codex'] as const) {
      const fake = new FakeAdapter({ vendor, skipAuthChecks: true, script: options.script ?? { turns: [[]] } });
      fakes[vendor] = fake;
      adapters.set(vendor, fake);
    }
  }
  const store = new AttemptStore(db);
  const outbox = new Outbox(db);
  const controllers: AttemptController[] = [];
  // Every agent still running is killed, and its controller's work waited for, before the files go. Whatever a test
  // left behind, that work stays short: no timer pushes, and a final push makes one try, so a broken origin costs
  // nothing.
  cleanups.push(async () => {
    for (const controller of controllers) controller.close();
    fixture.config.timings.finalPush = 0;
    for (const record of store.processes()) await killGroup(record, 'SIGKILL');
    await Promise.all(controllers.map((controller) => controller.settled()));
    for (const controller of controllers) controller.close();
  });
  const fixture: RunnerFixture = {
    home,
    paths,
    config,
    db,
    store,
    outbox,
    queue: new SerialQueue(),
    origin,
    vault,
    local: localGitEnv(paths),
    adapters,
    fakes,
    hub: new RecordingHubHttp(),
    logger: memoryLogger(),
    clock: new AwakeClock({ gapMs: 5_000 }),
    gate: { welcomeSinceGap: true, ackAgeMs: 0, wipGraceMs: 300_000 },
    wipFailures: new WipFailures(),
    tmpRoot,
    liveAttempts: 0,
    link: { up: true },
    ready: { claude: true, codex: true },
    events: <T extends RunnerEvent['type']>(type?: T) =>
      outbox.eventsAfter(0).filter((event) => type === undefined || event.type === type) as Extract<
        RunnerEvent,
        { type: T }
      >[],
    spec: (overrides = {}) => ({
      attemptId: 'T-4-a1',
      taskId: 'T-4',
      role: 'worker',
      vendor: 'claude',
      model: null,
      fence: { epoch: 1, counter: 1 },
      agentToken: fixtureAgentToken(overrides.attemptId ?? 'T-4-a1'),
      hubUrl: 'http://127.0.0.1:9',
      repo: { url: origin.path, mainBranch: 'main' },
      start: { ref: 'refs/heads/main', sha: null },
      branch: 'agflow/T-4-tidy',
      wipRef: `${FIXTURE_WIP_PREFIX}T-4/a1`,
      restore: { paths: restoreSet(null), base: 'refs/heads/main' },
      acceptanceIds: ['A1'],
      toolCaps: { defaultMs: 30 * 60_000, longMs: 90 * 60_000, checks: [] },
      taskPack: '# T-4 Tidy the app\n',
      brief: 'You are an agflow worker on T-4.',
      firstPrompt: 'Start working on T-4.',
      successor: false,
      ...overrides,
    }),
    deps: (overrides = {}) => ({
      config: () => fixture.config,
      paths,
      store,
      outbox,
      queue: fixture.queue,
      vault,
      local: fixture.local,
      adapters,
      health: defaultHealth,
      preparer: skipDependencyPreparer,
      notifier: silentNotifier,
      logger: fixture.logger,
      liveAttempts: () => fixture.liveAttempts,
      vendorReady: (vendor) => fixture.ready[vendor],
      wipRefPrefix: () => FIXTURE_WIP_PREFIX,
      tmpRoot: fixture.tmpRoot,
      agflow: FIXTURE_AGFLOW,
      cliVersion: fixtureCliVersion,
      clock: fixture.clock,
      remote: () => remoteGitEnv({ base: ownerEnv, gitDir: vault.path }),
      wipGate: {
        welcomeSinceGap: () => fixture.gate.welcomeSinceGap,
        ackAgeMs: () => fixture.gate.ackAgeMs,
        wipGraceMs: () => fixture.gate.wipGraceMs,
      },
      wipFailures: fixture.wipFailures,
      hub: fixture.hub,
      handoffMs: () => fixture.config.timings.handoff,
      linkUp: () => fixture.link.up,
      ...overrides,
    }),
    controller: (attemptId = 'T-4-a1', overrides = {}) => {
      const controller = new AttemptController(attemptId, fixture.deps(overrides));
      controllers.push(controller);
      return controller;
    },
  };
  return fixture;
}

