// The runtime's test setup: a fake hub serving the project, a local origin, and a runner home whose runner.db a test
// may fill before the runner starts. Everything a test made, the runners it started included, goes in
// cleanupRunnerSetups, which the test files call after each test.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type AttemptSpec, type Credentials, restoreSet, type RunnerCommand } from '@agflow/core';
import { FakeAdapter, type FakeScript, type OriginRepo, originRepo } from '@agflow/testkit';
import type { VendorAdapter } from '../src/adapters/types';
import { AttemptStore } from '../src/attempt-store';
import { type RunnerConfigInput, RunnerConfigSchema, saveRunnerConfig } from '../src/config';
import { openRunnerDb, type RunnerDb } from '../src/db';
import { memoryLogger } from '../src/log';
import { type RunnerPaths, runnerPaths } from '../src/paths';
import { killGroup } from '../src/processes';
import { removeAgentTools } from '../src/run-dir';
import { createRunner, type RunnerEvents, type RunnerHandle } from '../src/runner';
import type { DependencyPreparer, RunnerHealth } from '../src/seams';
import { type FakeHub, type FakeHubOptions, type HelloMessage, startFakeHub } from './fake-hub';
import { FIXTURE_AGFLOW, fixtureAgentToken, fixtureCliVersion } from './fixture';

export const SETUP_TOKEN = 'cli_token_for_the_runner';
export const SETUP_PROJECT = 'demo';

const cleanups: (() => void | Promise<void>)[] = [];

/** Undoes everything the setups made, newest first; each test file calls it after each test. */
export async function cleanupRunnerSetups(): Promise<void> {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
}

/** Registers a cleanup that runs after the test. */
export function afterThisTest(cleanup: () => void | Promise<void>): void {
  cleanups.push(cleanup);
}

/** A temporary directory removed after the test. */
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export interface StartOptions {
  config?: Partial<RunnerConfigInput>;
  health?: RunnerHealth;
  preparer?: DependencyPreparer;
  /** The fake adapters' script; one turn that does nothing by default. */
  script?: FakeScript;
  /** The adapters, instead of a fake one per vendor. */
  adapters?: VendorAdapter[];
  events?: RunnerEvents;
}

export interface RunnerSetup {
  hub: FakeHub;
  origin: OriginRepo;
  paths: RunnerPaths;
  db: RunnerDb;
  logger: ReturnType<typeof memoryLogger>;
  /** What the credentials provider gives; a test may change its token. */
  credentials: Credentials;
  /** Starts a runner on these files; closed after the test. */
  start(options?: StartOptions): Promise<RunnerHandle>;
}

/** A fake hub serving the project, an origin, and a runner home whose runner.db the test may fill first. */
export async function setupRunner(hubOptions: FakeHubOptions = {}): Promise<RunnerSetup> {
  const origin = await originRepo({ 'README.md': '# demo\n', 'src/app.ts': 'app\n' });
  cleanups.push(() => origin.remove());
  const hub = startFakeHub({ token: SETUP_TOKEN, status: { name: SETUP_PROJECT, repo: origin.path }, ...hubOptions });
  // Not waited for: Bun's server.stop(true) never settles once the hub side closed a socket, as some tests do.
  cleanups.push(() => {
    hub.stop();
  });
  const paths = runnerPaths(tempDir('agflow-runner-home-'));
  // The attempts' tools directories are read-only: they must be made writable before the home can go.
  cleanups.push(() => {
    if (!existsSync(paths.vaults)) return;
    for (const entry of readdirSync(paths.vaults).filter((name) => name.endsWith('.agent'))) {
      for (const attempt of readdirSync(join(paths.vaults, entry))) removeAgentTools(join(paths.vaults, entry, attempt));
    }
  });
  mkdirSync(dirname(paths.db), { recursive: true });
  const db = openRunnerDb(paths.db);
  cleanups.push(() => db.close());
  const logger = memoryLogger();
  const credentials: Credentials = { hubUrl: hub.url, token: SETUP_TOKEN, user: 'alice' };
  // Short, as Claude's private temporary directories must be.
  const tmpRoot = mkdtempSync('/tmp/ag');
  cleanups.push(() => rmSync(tmpRoot, { recursive: true, force: true }));
  const start: RunnerSetup['start'] = async (options = {}) => {
    const config = RunnerConfigSchema.parse({
      runnerKey: 'rk_test_runner',
      machineId: 'MACHINE-1',
      name: 'laptop',
      test: { skipAuthChecks: true, allowShortTimings: true },
      ...options.config,
    });
    saveRunnerConfig(paths.config, config);
    const script = options.script ?? { turns: [[]] };
    const adapters =
      options.adapters ??
      (['claude', 'codex'] as const).map((vendor) => new FakeAdapter({ vendor, skipAuthChecks: true, script }));
    const runner = await createRunner({
      paths,
      config,
      db,
      credentials: () => ({ ...credentials }),
      adapters,
      agflow: FIXTURE_AGFLOW,
      // The darwin-arm64 pins, so the fake agents start where no CLI is pinned (CI's linux-x64).
      cliVersion: fixtureCliVersion,
      health: options.health,
      preparer: options.preparer,
      events: options.events,
      logger,
      tmpRoot,
    });
    cleanups.push(async () => {
      // Whatever agent a test left running goes before the files do.
      for (const group of new AttemptStore(db).processes()) await killGroup(group, 'SIGKILL');
      await runner.close();
    });
    return runner;
  };
  return { hub, origin, paths, db, logger, credentials, start };
}

/** A worker spec of T-4 for the setup's origin. */
export function setupSpec(s: RunnerSetup, overrides: Partial<AttemptSpec> = {}): AttemptSpec {
  const attemptId = overrides.attemptId ?? 'T-4-a1';
  return {
    attemptId,
    taskId: 'T-4',
    role: 'worker',
    vendor: 'claude',
    model: null,
    fence: { epoch: 1, counter: 1 },
    agentToken: fixtureAgentToken(attemptId),
    hubUrl: s.hub.url,
    repo: { url: s.origin.path, mainBranch: 'main' },
    start: { ref: 'refs/heads/main', sha: null },
    branch: 'agflow/T-4-tidy',
    wipRef: 'refs/agflow/T-4/a1',
    restore: { paths: restoreSet(null), base: 'refs/heads/main' },
    acceptanceIds: ['A1'],
    toolCaps: { defaultMs: 30 * 60_000, longMs: 90 * 60_000, checks: [] },
    taskPack: '# T-4 Tidy the app\n',
    brief: 'You are an agflow worker on T-4.',
    firstPrompt: 'Start working on T-4.',
    successor: false,
    ...overrides,
  };
}

/** The hellos the hub received, in order. */
export const hellos = (hub: FakeHub) =>
  hub.messages().filter((message): message is HelloMessage => message.t === 'hello');

/** Sends the command and waits for its result. */
export async function runCommand(hub: FakeHub, command: RunnerCommand, timeoutMs = 20_000) {
  const id = hub.command(command);
  return hub.waitFor(() => hub.results.get(id), timeoutMs);
}

export { openRunnerDb, startFakeHub };
