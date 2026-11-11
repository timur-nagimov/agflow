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
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { TEST_ACCOUNT_ID, type VendorQuota } from '@agflow/core';
import { linkClaudeBinary } from '@agflow/testkit/src/anthropic';
import {
  CLAUDE_FIXTURES_DIR,
  type ClaudeRecording,
  claudeRecording,
  FAKE_CLAUDE_BIN,
  type FakeClaudeLogEntry,
  fakeClaudeEnv,
  loadRecording,
  readFakeClaudeLog,
  SYNTHETIC_ACCOUNT,
  writeRecording,
} from '@agflow/testkit/src/fake-claude';
import { CLAUDE_SCENARIOS, recordingOf, runScenario, scratchLaunch } from '../../../scripts/record-claude-stream';
import { ClaudeAdapter } from '../../../src/adapters/claude/adapter';
import { claudeAccountId } from '../../../src/adapters/claude/checks';
import { claudeBinary, claudeEmptyDir } from '../../../src/adapters/claude/options';
import { CLAUDE_CLI_VERSION } from '../../../src/adapters/claude/pin';
import {
  CLAUDE_WEAKENED_AUTO,
  CLAUDE_WEAKENED_TMP,
  claudePreflight,
  PREFLIGHT_HUB_URL,
} from '../../../src/adapters/claude/preflight';
import { QuotaBook } from '../../../src/adapters/claude/quota';
import type { AgentEvent, AgentLaunch, AgentSession } from '../../../src/adapters/types';
import { type RunnerConfig, RunnerConfigSchema } from '../../../src/config';
import { type RunnerPaths, runnerPaths } from '../../../src/paths';
import { standardProfile } from '../../../src/profile';

// macOS's first exec of a new script is slow, more so under load.
const TIMEOUT = 30_000;
// The pin's platform: these tests run the fake CLI, so they hold on any machine, CI's ubuntu included.
const PLATFORM = 'darwin-arm64';

const dirs: string[] = [];
const sessions: AgentSession[] = [];

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

beforeAll(() => {
  // Warm the script and Bun's transpile cache once, so the first test does not pay for it.
  Bun.spawnSync([FAKE_CLAUDE_BIN, '--version'], { env: { PATH: '/usr/bin:/bin', FAKE_CLAUDE_BUN: process.execPath } });
}, TIMEOUT);

interface Setup {
  root: string;
  paths: RunnerPaths;
  config: RunnerConfig;
  /** The fake's log. */
  log: string;
  /** A directory on the captured PATH, empty unless a test puts an owner's claude there. */
  ownerBin: string;
  adapter(options?: { skipAuthChecks?: boolean; platform?: string }): ClaudeAdapter;
}

/** The fake's log entries of a kind. */
async function logOf<K extends FakeClaudeLogEntry['kind']>(
  log: string,
  kind: K,
): Promise<Extract<FakeClaudeLogEntry, { kind: K }>[]> {
  return (await readFakeClaudeLog(log)).filter(
    (entry): entry is Extract<FakeClaudeLogEntry, { kind: K }> => entry.kind === kind,
  );
}

/**
 * A runner layout whose pinned claude is the fake, in test mode, so runner.json's test.claudeEnv carries the fake's
 * variables into the handshake's environment, as it carries the scripted server's in M2g.
 */
function setup(
  recording: ClaudeRecording,
  options: { binary?: 'fake' | 'none'; profile?: 'standard' | 'auto'; handshakeMs?: number } = {},
): Setup {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agflow-claude-preflight-')));
  dirs.push(root);
  const paths = runnerPaths(join(root, '.agflow'));
  if (options.binary !== 'none') linkClaudeBinary(paths.home, CLAUDE_CLI_VERSION, FAKE_CLAUDE_BIN);
  const home = join(root, 'home');
  const ownerBin = join(root, 'owner-bin');
  // Only bun, which the fake's launcher runs: a claude installed beside the machine's bun stays off the captured PATH.
  const bunBin = join(root, 'bun-bin');
  for (const dir of [home, ownerBin, bunBin, paths.homes.claude]) mkdirSync(dir, { recursive: true });
  symlinkSync(process.execPath, join(bunBin, 'bun'));
  const fake = fakeClaudeEnv({ recording, dir: join(root, 'fake') });
  const config = RunnerConfigSchema.parse({
    runnerKey: 'r-1',
    machineId: 'machine-1',
    name: 'laptop',
    profile: options.profile ?? 'standard',
    capturedPath: `${ownerBin}:${bunBin}:/usr/bin:/bin`,
    test: { claudeEnv: fake },
  });
  return {
    root,
    paths,
    config,
    log: fake.FAKE_CLAUDE_LOG as string,
    ownerBin,
    adapter: (adapterOptions = {}) =>
      new ClaudeAdapter({
        agflow: { command: '/usr/bin/false', args: [] },
        config,
        paths,
        vendorHomes: { claude: paths.homes.claude, codex: paths.homes.codex },
        skipAuthChecks: adapterOptions.skipAuthChecks,
        platform: adapterOptions.platform ?? PLATFORM,
        env: { AGFLOW_TEST: '1', HOME: home, USER: 'agent', LANG: 'en_US.UTF-8' },
        preflightTimeoutMs: options.handshakeMs,
      }),
  };
}

/** The pinned claude as a script: it reports the pin and runs the fake, the auto handshake with another recording. */
function autoRecording(fixture: Setup, auto: ClaudeRecording): void {
  const bin = claudeBinary(fixture.paths, CLAUDE_CLI_VERSION);
  rmSync(bin, { force: true });
  const path = join(fixture.root, 'auto.jsonl');
  writeRecording(path, auto);
  const script = [
    '#!/bin/sh',
    `[ "$1" = --version ] && { echo "${CLAUDE_CLI_VERSION} (Claude Code)"; exit 0; }`,
    'previous=',
    'for arg in "$@"; do',
    `  [ "$previous" = --permission-mode ] && [ "$arg" = auto ] && FAKE_CLAUDE_RECORDING='${path}'`,
    '  previous=$arg',
    'done',
    'export FAKE_CLAUDE_RECORDING',
    `exec '${FAKE_CLAUDE_BIN}' "$@"`,
  ];
  writeFileSync(bin, `${script.join('\n')}\n`);
  chmodSync(bin, 0o755);
}

/** Every argv the fake logged, in order. */
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

/** preflight-ok with another answer to the usage call. */
function withUsage(answer: ClaudeRecording['answers'][string]): ClaudeRecording {
  const recording = loadRecording('preflight-ok');
  return { ...recording, answers: { ...recording.answers, get_usage: answer } };
}

const ACCOUNT_ID = claudeAccountId(SYNTHETIC_ACCOUNT);

describe('preflight: platform and binary', () => {
  test(
    "an unsupported platform, a missing binary and another version are not ready, each with its problem",
    async () => {
      const unsupported = await setup(loadRecording('preflight-ok')).adapter({ platform: 'plan9-mips' }).preflight();
      expect(unsupported.facts).toMatchObject({ vendor: 'claude', ready: false, problem: 'unsupported platform' });

      const missing = await setup(loadRecording('preflight-ok'), { binary: 'none' }).adapter().preflight();
      expect(missing.facts).toMatchObject({ ready: false, problem: 'binary missing', cliVersion: null });

      const older = setup(loadRecording('preflight-ok'), { binary: 'none' });
      const bin = claudeBinary(older.paths, CLAUDE_CLI_VERSION);
      mkdirSync(dirname(bin), { recursive: true });
      writeFileSync(bin, '#!/bin/sh\necho "2.1.200 (Claude Code)"\n');
      chmodSync(bin, 0o755);
      const result = await older.adapter().preflight();
      expect(result.facts).toMatchObject({ ready: false, problem: `claude 2.1.200, expected ${CLAUDE_CLI_VERSION}` });
      expect(result).toMatchObject({ quota: null, weakened: [] });
    },
    TIMEOUT,
  );
});

describe('preflight: the handshake', () => {
  test(
    'it sends only /clear, with the full options, a scratch clone and base checkout, and a bridge whose hub refuses',
    async () => {
      const fixture = setup(loadRecording('preflight-ok'));
      // The pinned claude notes its working directory, then runs the fake.
      const bin = claudeBinary(fixture.paths, CLAUDE_CLI_VERSION);
      rmSync(bin, { force: true });
      const cwdFile = join(fixture.root, 'cwd');
      writeFileSync(bin, `#!/bin/sh\n[ "$1" = --version ] || pwd > '${cwdFile}'\nexec '${FAKE_CLAUDE_BIN}' "$@"\n`);
      chmodSync(bin, 0o755);
      await fixture.adapter().preflight();
      const entries = await readFakeClaudeLog(fixture.log);
      const users = entries.flatMap((entry) => (entry.kind === 'user' ? [entry.message] : []));
      expect(users).toHaveLength(1);
      expect(users[0]).toMatchObject({ message: { role: 'user', content: '/clear' } });
      const [argv = []] = await argvs(fixture.log);
      expect(flag(argv, '--permission-mode')).toBe('acceptEdits');
      expect(flag(argv, '--permission-prompts')).toBe('none');
      expect(argv).toContain('--strict-mcp-config');
      expect(flag(argv, '--tools')).toBe('Bash,Read,Edit,Write,Glob,Grep,Task,TaskCreate,TaskGet,TaskList,TaskUpdate');
      const mcp = JSON.parse(flag(argv, '--mcp-config') ?? '{}');
      expect(Object.keys(mcp.mcpServers)).toEqual(['agflow']);
      expect(mcp.mcpServers.agflow.env.AGFLOW_HUB_URL).toBe(PREFLIGHT_HUB_URL);
      // The bridge starts in the Claude home's empty directory, which the handshake made.
      const empty = claudeEmptyDir(fixture.paths.homes.claude);
      expect(mcp.mcpServers.agflow).toMatchObject({ command: '/bin/sh', args: expect.arrayContaining([empty]) });
      expect(statSync(empty).isDirectory()).toBe(true);
      await expect(fetch(PREFLIGHT_HUB_URL)).rejects.toThrow();
      const settings = JSON.parse(flag(argv, '--settings') ?? '{}');
      expect(settings.sandbox).toMatchObject({ enabled: true, failIfUnavailable: true });
      // The scratch clone, its working directory, and base checkout lie outside the runner's work root, and are gone
      // afterwards.
      const base = flag(argv, '--project-config-root') as string;
      expect(base.startsWith(fixture.paths.work)).toBe(false);
      expect(existsSync(base)).toBe(false);
      const cwd = readFileSync(cwdFile, 'utf8').trim();
      expect(cwd).toBe(join(dirname(base), 'clone'));
      expect(cwd.startsWith(fixture.paths.work)).toBe(false);
      expect(existsSync(cwd)).toBe(false);
      // The usage call skips the behaviours, which could ask the model.
      const usage = (await logOf(fixture.log, 'control')).filter((entry) => entry.request.subtype === 'get_usage');
      expect(usage).toMatchObject([{ request: { subtype: 'get_usage', skip_behaviors: true } }]);
    },
    TIMEOUT,
  );

  test(
    "a good handshake gives facts only: the pin, the owner's claude, the account and the plan",
    async () => {
      const fixture = setup(loadRecording('preflight-ok'));
      const without = await fixture.adapter().preflight();
      expect(without).toEqual({
        facts: {
          vendor: 'claude',
          cliVersion: CLAUDE_CLI_VERSION,
          ownerCliVersion: null,
          ready: true,
          problem: null,
          accountId: ACCOUNT_ID,
          plan: 'Claude Max',
          managedPolicy: false,
        },
        // The recording's usage call has rate_limits null.
        quota: null,
        weakened: [],
      });
      writeFileSync(join(fixture.ownerBin, 'claude'), '#!/bin/sh\necho "2.1.290 (Claude Code)"\n');
      chmodSync(join(fixture.ownerBin, 'claude'), 0o755);
      expect((await fixture.adapter().preflight()).facts.ownerCliVersion).toBe('2.1.290');
    },
    TIMEOUT,
  );

  test(
    "quota comes from the usage call; a failure, rate_limits null or another shape gives the book's last, else null",
    async () => {
      const resets = '2030-03-17T17:00:00.000Z';
      const usage = withUsage({
        response: {
          subscription_type: 'max',
          rate_limits: {
            five_hour: { utilization: 42, resets_at: resets },
            seven_day: { utilization: 10, resets_at: resets },
            extra_usage: { is_enabled: false },
          },
        },
      });
      const adapter = setup(usage).adapter();
      const { quota } = await adapter.preflight();
      expect(quota).toMatchObject({
        state: 'ok',
        resetsAt: Date.parse(resets),
        windows: { fiveHour: 0.42, weekly: 0.1 },
        paidUsage: 'disabled',
      });
      // The sessions' quota starts from it.
      expect(adapter.quota.last(ACCOUNT_ID)).toEqual(quota);

      const known: VendorQuota = {
        state: 'ok',
        resetsAt: null,
        windows: { fiveHour: 0.5, weekly: 0.2 },
        paidUsage: 'enabled',
        updatedAt: 1,
      };
      for (const answer of [
        { error: 'usage is not available' },
        { response: { rate_limits: null } },
        { response: { rate_limits: { five_hour: 'full' } } },
      ]) {
        const fallback = setup(withUsage(answer)).adapter();
        expect((await fallback.preflight()).quota).toBeNull();
        fallback.quota.update(ACCOUNT_ID, known);
        expect((await fallback.preflight()).quota).toEqual(known);
      }
    },
    TIMEOUT,
  );

  test(
    'an API key, an extra MCP server, a plugin from outside and a disabled sandbox are each not ready, with the reason',
    async () => {
      const cases: [string, string | RegExp][] = [
        ['preflight-api-key', 'an API key would replace the subscription'],
        ['preflight-extra-mcp', /unexpected MCP servers: github/],
        ['preflight-plugin', /unexpected plugins: repo-helper/],
        ['preflight-sandbox-off', 'the sandbox is not enabled'],
      ];
      for (const [scenario, reason] of cases) {
        const { facts } = await setup(loadRecording(scenario)).adapter().preflight();
        expect(facts.ready).toBe(false);
        expect(facts.problem).toMatch(reason);
      }
    },
    TIMEOUT,
  );

  test(
    'a crash or a timeout is not ready, with the error',
    async () => {
      const crash = claudeRecording({
        turns: [],
        startup: [
          { stderr: 'panic: the keychain is locked\n' },
          { sleep: 50 },
          { stderr: '    at unlock (keychain.ts:1:1)\n' },
          { exit: 3 },
        ],
      });
      const crashed = await setup(crash).adapter().preflight();
      expect(crashed.facts).toMatchObject({ ready: false, cliVersion: CLAUDE_CLI_VERSION });
      expect(crashed.facts.problem).toStartWith('the handshake failed: ');
      // All of stderr, each of its writes.
      expect(crashed.facts.problem).toContain('panic: the keychain is locked\n    at unlock (keychain.ts:1:1)');

      const hang = claudeRecording({ turns: [], startup: [{ sleep: 60_000 }] });
      const hung = await setup(hang, { handshakeMs: 1_000 }).adapter().preflight();
      expect(hung.facts).toMatchObject({ ready: false, problem: 'the handshake failed: no answer within 1000 ms' });
    },
    TIMEOUT,
  );

  test(
    "skipAuthChecks gives ready, 'test mode' and TEST_ACCOUNT_ID, whatever key the scripted server's account has",
    async () => {
      const { facts } = await setup(loadRecording('preflight-api-key')).adapter({ skipAuthChecks: true }).preflight();
      expect(facts).toMatchObject({ ready: true, problem: 'test mode', plan: 'test mode', accountId: TEST_ACCOUNT_ID });
    },
    TIMEOUT,
  );
});

describe('preflight: the auto profile and weakened items', () => {
  const turnLaunch = (
    fixture: Setup,
    options: { recording?: string; profile?: AgentLaunch['profile'] } = {},
  ): AgentLaunch => {
    const clone = join(fixture.paths.work, 'p-1', 'T-1-a1');
    const tmpDir = join(fixture.root, 'tmp');
    for (const dir of [clone, tmpDir]) mkdirSync(dir, { recursive: true });
    return {
      attemptId: 'T-1-a1',
      role: 'worker',
      model: 'claude-sonnet-5-5',
      cliVersion: CLAUDE_CLI_VERSION,
      clone,
      baseCheckout: fixture.paths.baseCheckout('p-1', '0123456789abcdef'),
      projectConfigVerified: true,
      tmpDir,
      env: {
        HOME: join(fixture.root, 'home'),
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        CLAUDE_CONFIG_DIR: fixture.paths.homes.claude,
        CLAUDE_CODE_TMPDIR: tmpDir,
        ...fakeClaudeEnv({
          recording: join(CLAUDE_FIXTURES_DIR, `${options.recording ?? 'turn-basic'}.jsonl`),
          dir: join(fixture.root, 'turn'),
        }),
      },
      bridge: { command: '/usr/bin/false', args: ['mcp', '--vendor', 'claude', '--runner'], env: {}, tools: [] },
      profile: options.profile ?? { ...standardProfile, name: 'auto' },
      brief: 'brief',
      firstPrompt: 'Start with the task.',
      resume: null,
      logFile: join(fixture.root, 'attempt.log'),
      registerProcess: () => {},
    };
  };

  async function startedMode(adapter: ClaudeAdapter, launch: AgentLaunch): Promise<string | null> {
    const session = await adapter.start(launch);
    sessions.push(session);
    for await (const event of session.events) {
      if (event.type === 'started') return (event as Extract<AgentEvent, { type: 'started' }>).permissionMode;
    }
    return null;
  }

  test(
    "weakened holds 'auto' when the account offers auto mode, and later starts run auto",
    async () => {
      const fixture = setup(loadRecording('preflight-ok'), { profile: 'auto' });
      const adapter = fixture.adapter();
      const result = await adapter.preflight();
      expect(result.facts.ready).toBe(true);
      expect(result.weakened).toEqual([CLAUDE_WEAKENED_AUTO]);
      expect((await argvs(fixture.log)).map((argv) => flag(argv, '--permission-mode'))).toEqual(['auto']);
      expect(await startedMode(adapter, turnLaunch(fixture))).toBe('auto');
    },
    TIMEOUT,
  );

  test(
    "without auto offered, or when the auto handshake fails, the standard one decides and 'auto' is left out",
    async () => {
      const crash = claudeRecording({
        turns: [],
        startup: [{ stderr: 'auto mode is unavailable right now\n' }, { exit: 1 }],
      });
      for (const auto of [loadRecording('preflight-auto-off'), crash]) {
        const fixture = setup(loadRecording('preflight-ok'), { profile: 'auto' });
        autoRecording(fixture, auto);
        const adapter = fixture.adapter();
        const result = await adapter.preflight();
        expect(result.facts).toMatchObject({ ready: true, problem: null });
        expect(result.weakened).toEqual([]);
        const modes = (await argvs(fixture.log)).map((argv) => flag(argv, '--permission-mode'));
        expect(modes).toEqual(['auto', 'acceptEdits']);
        expect(await startedMode(adapter, turnLaunch(fixture))).toBe('acceptEdits');
      }
    },
    TIMEOUT,
  );

  test(
    "later sessions name preflight's account in their quota, and start from preflight's quota",
    async () => {
      const resets = '2030-03-17T17:00:00.000Z';
      const usage = withUsage({
        response: {
          subscription_type: 'max',
          rate_limits: {
            five_hour: { utilization: 42, resets_at: resets },
            seven_day: { utilization: 10, resets_at: resets },
            extra_usage: { is_enabled: false },
          },
        },
      });
      for (const [skipAuthChecks, accountId] of [
        [false, ACCOUNT_ID],
        [true, TEST_ACCOUNT_ID],
      ] as const) {
        const fixture = setup(usage);
        const adapter = fixture.adapter({ skipAuthChecks });
        const { quota } = await adapter.preflight();
        if (quota === null) throw new Error('preflight gave no quota');
        // A 429 the CLI retries repeats the account's last known quota.
        const launch = turnLaunch(fixture, { recording: 'api-retry-429', profile: standardProfile });
        const session = await adapter.start(launch);
        sessions.push(session);
        let found: AgentEvent | null = null;
        for await (const event of session.events) {
          if (event.type === 'quota') found = event;
          if (event.type === 'turn_ended') break;
        }
        expect(found).toEqual({ type: 'quota', accountId, quota });
      }
    },
    TIMEOUT,
  );

  test(
    "'/tmp/claude' is listed when the pin's sandbox does not enforce its denyWrite",
    async () => {
      const fixture = setup(loadRecording('preflight-ok'));
      const input = {
        agflow: { command: '/usr/bin/false', args: [] },
        config: fixture.config,
        paths: fixture.paths,
        vendorHomes: { claude: fixture.paths.homes.claude, codex: fixture.paths.homes.codex },
        platform: PLATFORM,
        quota: new QuotaBook(),
        skipAuthChecks: false,
        env: { AGFLOW_TEST: '1', HOME: join(fixture.root, 'home') },
      };
      expect((await claudePreflight(input)).weakened).toEqual([]);
      const weakened = await claudePreflight({ ...input, tmpClaudeDenyWriteEnforced: false });
      expect(weakened).toMatchObject({ facts: { ready: true }, weakened: [CLAUDE_WEAKENED_TMP] });
      // Even a vendor that is not ready names it.
      const missing = await claudePreflight({ ...input, platform: 'plan9-mips', tmpClaudeDenyWriteEnforced: false });
      expect(missing.weakened).toEqual([CLAUDE_WEAKENED_TMP]);
    },
    TIMEOUT,
  );
});

describe('the preflight recordings', () => {
  const captured = ['preflight-api-key', 'preflight-extra-mcp', 'preflight-sandbox-off'];
  for (const name of [...captured, 'preflight-plugin', 'preflight-auto-off']) {
    test(
      `${name} replays through the recorder as it was written`,
      async () => {
        const recording = loadRecording(name);
        expect(recording.header).toMatchObject({
          cliVersion: CLAUDE_CLI_VERSION,
          source: captured.includes(name) ? 'captured' : 'synthesised',
          account: name === 'preflight-api-key' ? 'api-key' : 'synthetic-subscription',
        });
        const scenario = CLAUDE_SCENARIOS.find((entry) => entry.name === name);
        if (!scenario) throw new Error(`no scenario ${name}`);
        const launch = scratchLaunch({ bin: FAKE_CLAUDE_BIN, model: recording.header.model, env: {} });
        try {
          Object.assign(launch.launch.env, fakeClaudeEnv({ recording, dir: join(launch.root, 'fake') }));
          const run = await runScenario(scenario, launch);
          const again = recordingOf(run, recording.header, launch, {
            live: false,
            apiKeyAccount: scenario.apiKeyAccount,
          });
          expect(again.answers).toEqual(recording.answers);
          expect(again.startup).toEqual(recording.startup);
          expect(again.turns).toEqual(recording.turns);
        } finally {
          launch.cleanup();
        }
      },
      TIMEOUT,
    );
  }
});
