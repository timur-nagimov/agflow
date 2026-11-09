import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { TEST_ACCOUNT_ID } from '@agflow/core';
import {
  CLAUDE_FIXTURES_DIR,
  type ClaudeRecording,
  FAKE_CLAUDE_BIN,
  type FakeClaudeLogEntry,
  fakeClaudeEnv,
  loadRecording,
  parseRecording,
  readFakeClaudeLog,
} from '@agflow/testkit/src/fake-claude';
import { ADAPTER_FACTORIES, createAdapters } from '../../../src/adapters';
import * as claudeBarrel from '../../../src/adapters/claude';
import { ClaudeAdapter } from '../../../src/adapters/claude/adapter';
import { claudeAdapterFactory } from '../../../src/adapters/claude/entry';
import { createClaudeAdapter } from '../../../src/adapters/claude/factory';
import { briefHookCommand, claudeBinary, claudeEmptyDir, inDirectory } from '../../../src/adapters/claude/options';
import { claudeProjectDir } from '../../../src/adapters/claude/paths';
import { CLAUDE_CLI_VERSION } from '../../../src/adapters/claude/pin';
import type { AgentEvent, AgentLaunch, AgentSession, AgflowCommand } from '../../../src/adapters/types';
import { type RunnerConfig, type RunnerConfigInput, RunnerConfigSchema, vendorHomes } from '../../../src/config';
import { buildAgentEnv } from '../../../src/env';
import { type RunnerPaths, runnerPaths } from '../../../src/paths';
import { standardProfile } from '../../../src/profile';

// macOS's first exec of a new script is slow, more so under load.
const TIMEOUT = 30_000;
// The pin's platform: these tests run the fake CLI, so they hold on any machine, CI's ubuntu included.
const PLATFORM = 'darwin-arm64';
/** An older CLI version an attempt may have started with (X-13). */
const OLDER = '2.1.280';
/** How the runner runs agflow, with a space in its path so the quoting shows. */
const AGFLOW: AgflowCommand = { command: '/opt/agflow bin/agflow', args: ['--profile', 'test'] };

const dirs: string[] = [];
const groups = new Set<number>();
const sessions: AgentSession[] = [];

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  for (const pgid of groups) {
    try {
      process.kill(-pgid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  groups.clear();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

beforeAll(() => {
  // Warm the script and Bun's transpile cache once, so the first test does not pay for it.
  Bun.spawnSync([FAKE_CLAUDE_BIN, '--version'], { env: { PATH: '/usr/bin:/bin', FAKE_CLAUDE_BUN: process.execPath } });
}, TIMEOUT);

interface Setup {
  root: string;
  paths: RunnerPaths;
  /** The runner's own HOME, which the agents' environment carries. */
  home: string;
  config(input?: Partial<RunnerConfigInput>): RunnerConfig;
}

function setup(): Setup {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agflow-claude-factory-')));
  dirs.push(root);
  const paths = runnerPaths(join(root, '.agflow'));
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  return {
    root,
    paths,
    home,
    config: (input = {}) =>
      RunnerConfigSchema.parse({ runnerKey: 'r-1', machineId: 'machine-1', name: 'laptop', ...input }),
  };
}

/**
 * The claude of a version in the layout: a script that hands the fake its variables itself, so the fake replays the
 * recording whether or not test mode carries test.claudeEnv into the agent's environment. Warmed once with --warm.
 * Gives the fake's log.
 */
function fakeClaudeAt(fixture: Setup, version: string, recording: ClaudeRecording): string {
  const fake = fakeClaudeEnv({ recording, dir: join(fixture.root, `fake-${version}`), version });
  const bin = claudeBinary(fixture.paths, version);
  mkdirSync(dirname(bin), { recursive: true });
  const exports = Object.entries(fake).map(([name, value]) => `export ${name}='${value}'`);
  const script = ['#!/bin/sh', '[ "$1" = --warm ] && exit 0', ...exports, `exec '${FAKE_CLAUDE_BIN}' "$@"`];
  writeFileSync(bin, `${script.join('\n')}\n`);
  chmodSync(bin, 0o755);
  Bun.spawnSync([bin, '--warm']);
  return fake.FAKE_CLAUDE_LOG as string;
}

/** turn-basic as a CLI of another version printed it: its system/init names that version. */
function turnOf(version: string): ClaudeRecording {
  const text = readFileSync(join(CLAUDE_FIXTURES_DIR, 'turn-basic.jsonl'), 'utf8');
  return parseRecording(
    text.replaceAll(`"claude_code_version":"${CLAUDE_CLI_VERSION}"`, `"claude_code_version":"${version}"`),
  );
}

async function argvs(log: string): Promise<string[][]> {
  return (await readFakeClaudeLog(log)).flatMap((entry: FakeClaudeLogEntry) =>
    entry.kind === 'argv' ? [entry.argv] : [],
  );
}

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index >= 0) return argv[index + 1];
  return argv.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
}

/** The SessionStart command the CLI was given in --settings. */
function sessionStartCommand(argv: string[]): unknown {
  return JSON.parse(flag(argv, '--settings') ?? '{}').hooks?.SessionStart?.[0]?.hooks?.[0]?.command;
}

async function firstEvent(session: AgentSession): Promise<AgentEvent | undefined> {
  for await (const event of session.events) return event;
  return undefined;
}

describe('the claude registry entry', () => {
  test("its AdapterFactory gives a ClaudeAdapter, and createAdapters lists it with vendor 'claude'", () => {
    const fixture = setup();
    const input = { config: fixture.config(), paths: fixture.paths, agflow: AGFLOW };
    const adapter = claudeAdapterFactory(input);
    expect(adapter).toBeInstanceOf(ClaudeAdapter);
    expect(adapter?.vendor).toBe('claude');
    expect(ADAPTER_FACTORIES).toContain(claudeAdapterFactory);
    const claude = createAdapters(input.config, input.paths, { agflow: AGFLOW }).filter(
      (each) => each.vendor === 'claude',
    );
    expect(claude).toHaveLength(1);
    expect(claude[0]).toBeInstanceOf(ClaudeAdapter);
    // The vendor barrel gives the same adapter and factory (X-44).
    expect(claudeBarrel.ClaudeAdapter).toBe(ClaudeAdapter);
    expect(claudeBarrel.createClaudeAdapter).toBe(createClaudeAdapter);
  });

  test(
    "each launch runs the claude of its CLI version, under runner.json's Claude home, which buildAgentEnv also gives",
    async () => {
      const fixture = setup();
      // A home setup recorded in runner.json, apart from the layout's.
      const claudeHome = join(fixture.root, 'claude-home');
      mkdirSync(claudeHome, { recursive: true });
      const config = fixture.config({ homes: { claude: claudeHome } });
      const pinLog = fakeClaudeAt(fixture, CLAUDE_CLI_VERSION, turnOf(CLAUDE_CLI_VERSION));
      const olderLog = fakeClaudeAt(fixture, OLDER, turnOf(OLDER));
      const input = { config, paths: fixture.paths, agflow: AGFLOW };
      const adapter = createClaudeAdapter(input, { env: { HOME: fixture.home } });
      const clone = join(fixture.paths.work, 'p-1', 'T-1-a1');
      const tools = join(fixture.paths.vaults, 'p-1.agent', 'T-1-a1');
      const tmpDir = join(fixture.root, 'tmp');
      for (const dir of [clone, tools, tmpDir]) mkdirSync(dir, { recursive: true });
      const spec = { attemptId: 'T-1-a1', role: 'worker' as const, agentToken: 'agt_x', hubUrl: 'http://127.0.0.1:9' };
      const env = buildAgentEnv({
        vendor: 'claude',
        spec,
        clone,
        tools,
        tmpDir,
        config,
        paths: fixture.paths,
        base: { HOME: fixture.home },
        env: {},
      });
      expect(env.CLAUDE_CONFIG_DIR).toBe(claudeHome);
      const launch: AgentLaunch = {
        attemptId: spec.attemptId,
        role: spec.role,
        model: 'claude-sonnet-5-5',
        cliVersion: OLDER,
        clone,
        baseCheckout: fixture.paths.baseCheckout('p-1', '0123456789abcdef'),
        projectConfigVerified: true,
        tmpDir,
        env,
        bridge: {
          command: AGFLOW.command,
          args: [...AGFLOW.args, 'mcp', '--vendor', 'claude', '--runner'],
          env: {},
          tools: [],
        },
        profile: standardProfile,
        brief: 'brief',
        firstPrompt: 'Start with the task.',
        resume: null,
        logFile: join(fixture.root, 'attempt.log'),
        registerProcess: (pid) => {
          groups.add(pid);
        },
      };
      const session = await adapter.start(launch);
      sessions.push(session);
      expect(await firstEvent(session)).toMatchObject({ type: 'started', cliVersion: OLDER });
      // The older binary ran, with the brief hook running the factory's agflow command in the empty directory of
      // runner.json's Claude home; the pinned one never did.
      const [argv = []] = await argvs(olderLog);
      const empty = claudeEmptyDir(claudeHome);
      expect(sessionStartCommand(argv)).toBe(briefHookCommand(AGFLOW, empty));
      expect(statSync(empty).isDirectory()).toBe(true);
      expect(existsSync(pinLog)).toBe(false);
      // The transcripts the adapter reads and deletes are under the same home.
      const project = claudeProjectDir(claudeHome, clone);
      mkdirSync(project, { recursive: true });
      const line = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } };
      writeFileSync(join(project, `${session.sessionRef}.jsonl`), `${JSON.stringify(line)}\n`);
      const ref = { sessionRef: session.sessionRef, clone };
      expect(await adapter.readTranscriptTail({ ...ref, maxChars: 1_000 })).toContain('Done.');
      await adapter.deleteTranscript(ref);
      expect(existsSync(join(project, `${session.sessionRef}.jsonl`))).toBe(false);
    },
    TIMEOUT,
  );

  test(
    'skipAuthChecks is honoured only in test mode: AGFLOW_TEST=1 and a test block',
    async () => {
      const fixture = setup();
      fakeClaudeAt(fixture, CLAUDE_CLI_VERSION, loadRecording('preflight-api-key'));
      const preflight = (config: RunnerConfig, env: Record<string, string>) =>
        createClaudeAdapter(
          { config, paths: fixture.paths, agflow: AGFLOW },
          { env: { HOME: fixture.home, ...env }, platform: PLATFORM },
        ).preflight();
      const skipping = fixture.config({ test: { skipAuthChecks: true } });
      expect((await preflight(skipping, { AGFLOW_TEST: '1' })).facts).toMatchObject({
        ready: true,
        plan: 'test mode',
        accountId: TEST_ACCOUNT_ID,
      });
      const refused = { ready: false, problem: expect.stringContaining('an API key would replace the subscription') };
      expect((await preflight(skipping, {})).facts).toMatchObject(refused);
      expect((await preflight(fixture.config({ test: {} }), { AGFLOW_TEST: '1' })).facts).toMatchObject(refused);
    },
    TIMEOUT,
  );

  test(
    "the factory's agflow command runs the brief hook and the preflight's bridge",
    async () => {
      const fixture = setup();
      const log = fakeClaudeAt(fixture, CLAUDE_CLI_VERSION, loadRecording('preflight-ok'));
      const adapter = createClaudeAdapter(
        { config: fixture.config(), paths: fixture.paths, agflow: AGFLOW },
        { env: { HOME: fixture.home }, platform: PLATFORM },
      );
      expect((await adapter.preflight()).facts).toMatchObject({ ready: true, cliVersion: CLAUDE_CLI_VERSION });
      const [argv = []] = await argvs(log);
      const bridge = JSON.parse(flag(argv, '--mcp-config') ?? '{}').mcpServers?.agflow;
      const args = [...AGFLOW.args, 'mcp', '--vendor', 'claude', '--runner'];
      const empty = claudeEmptyDir(vendorHomes(fixture.config(), fixture.paths).claude);
      expect(bridge).toMatchObject(inDirectory(empty, AGFLOW.command, args));
      const hook = `cd ${empty} && exec '/opt/agflow bin/agflow' --profile test hook brief --runner`;
      expect(sessionStartCommand(argv)).toBe(hook);
    },
    TIMEOUT,
  );

  test(
    "a runner home without the binary still gets an adapter, whose preflight reports 'binary missing'",
    async () => {
      const fixture = setup();
      const config = fixture.config();
      const listed = createAdapters(config, fixture.paths, { agflow: AGFLOW });
      expect(listed.map((adapter) => adapter.vendor)).toContain('claude');
      const adapter = createClaudeAdapter(
        { config, paths: fixture.paths, agflow: AGFLOW },
        { env: { HOME: fixture.home }, platform: PLATFORM },
      );
      const { facts } = await adapter.preflight();
      expect(facts).toMatchObject({ vendor: 'claude', ready: false, problem: 'binary missing', cliVersion: null });
    },
    TIMEOUT,
  );
});
