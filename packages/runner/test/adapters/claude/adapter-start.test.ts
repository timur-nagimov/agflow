import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { linkClaudeBinary } from '@agflow/testkit/src/anthropic';
import {
  CLAUDE_FIXTURES_DIR,
  type ClaudeRecording,
  claudeRecording,
  FAKE_CLAUDE_BIN,
  type FakeClaudeLogEntry,
  fakeClaudeEnv,
  loadRecording,
  parseRecording,
  type RecordingStep,
  readFakeClaudeLog,
} from '@agflow/testkit/src/fake-claude';
import { ClaudeAdapter, type ClaudeAdapterOptions } from '../../../src/adapters/claude/adapter';
import { claudeBinary } from '../../../src/adapters/claude/options';
import { claudeProjectDir } from '../../../src/adapters/claude/paths';
import { CLAUDE_CLI_VERSION } from '../../../src/adapters/claude/pin';
import type { AgentEvent, AgentLaunch, AgentSession, VendorAdapter } from '../../../src/adapters/types';
import { RunnerConfigSchema } from '../../../src/config';
import { runnerPaths } from '../../../src/paths';
import { standardProfile } from '../../../src/profile';

// macOS's first exec of a new script is slow, more so under load.
const TIMEOUT = 30_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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
  adapter: ClaudeAdapter;
  launch: AgentLaunch;
  /** The fake's log. */
  log: string;
  /** The pids registerProcess got, in order. */
  registered: number[];
  paths: ReturnType<typeof runnerPaths>;
}

/** A runner layout, its adapter, and a launch of the given recording; the fake is the pinned claude unless told. */
function setup(
  recording: ClaudeRecording,
  options: { binary?: 'fake' | 'none'; adapter?: Partial<ClaudeAdapterOptions> } = {},
): Setup {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agflow-claude-adapter-')));
  dirs.push(root);
  const paths = runnerPaths(join(root, '.agflow'));
  if (options.binary !== 'none') linkClaudeBinary(paths.home, CLAUDE_CLI_VERSION, FAKE_CLAUDE_BIN);
  const clone = join(paths.work, 'p-1', 'T-1-a1');
  const tmpDir = join(root, 'tmp');
  const home = join(root, 'home');
  for (const dir of [clone, tmpDir, home, paths.homes.claude]) mkdirSync(dir, { recursive: true });
  const fake = fakeClaudeEnv({ recording, dir: join(root, 'fake') });
  const registered: number[] = [];
  const launch: AgentLaunch = {
    attemptId: 'T-1-a1',
    role: 'worker',
    model: 'claude-sonnet-5-5',
    cliVersion: CLAUDE_CLI_VERSION,
    clone,
    baseCheckout: paths.baseCheckout('p-1', '0123456789abcdef'),
    projectConfigVerified: true,
    tmpDir,
    env: {
      HOME: home,
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      CLAUDE_CONFIG_DIR: paths.homes.claude,
      CLAUDE_CODE_TMPDIR: tmpDir,
      ...fake,
    },
    bridge: { command: '/usr/bin/false', args: ['mcp', '--vendor', 'claude', '--runner'], env: {}, tools: [] },
    profile: standardProfile,
    brief: 'brief',
    firstPrompt: 'Start with the task.',
    resume: null,
    logFile: join(root, 'attempt.log'),
    registerProcess: (pid) => {
      registered.push(pid);
      groups.add(pid);
    },
  };
  const adapter = new ClaudeAdapter({
    agflow: { command: '/usr/bin/false', args: [] },
    config: RunnerConfigSchema.parse({ runnerKey: 'r-1', machineId: 'machine-1', name: 'laptop' }),
    paths,
    vendorHomes: { claude: paths.homes.claude, codex: paths.homes.codex },
    ...options.adapter,
  });
  return { adapter, launch, log: fake.FAKE_CLAUDE_LOG as string, registered, paths };
}

/** A shell script as the claude of a version, run once with --warm: macOS's first exec of a new script is slow. */
function stub(paths: Setup['paths'], version: string, body: string[]): void {
  const bin = claudeBinary(paths, version);
  mkdirSync(dirname(bin), { recursive: true });
  rmSync(bin, { force: true });
  writeFileSync(bin, `${['#!/bin/sh', '[ "$1" = --warm ] && exit 0', ...body].join('\n')}\n`);
  chmodSync(bin, 0o755);
  Bun.spawnSync([bin, '--warm']);
}

/** The transcript of a session that ran a turn, in the clone's project directory: what a resume resumes (8.4). */
function ranATurn(fixture: Setup, sessionRef: string): void {
  const dir = claudeProjectDir(fixture.paths.homes.claude, fixture.launch.clone);
  mkdirSync(dir, { recursive: true });
  const prompt = { type: 'user', message: { role: 'user', content: 'Start with the task.' } };
  writeFileSync(join(dir, `${sessionRef}.jsonl`), `${JSON.stringify(prompt)}\n`);
}

/** A recording whose system/init frames name another CLI version. */
function initVersion(name: string, version: string): ClaudeRecording {
  const text = readFileSync(join(CLAUDE_FIXTURES_DIR, `${name}.jsonl`), 'utf8');
  const pinned = `"claude_code_version":"${CLAUDE_CLI_VERSION}"`;
  return parseRecording(text.replaceAll(pinned, `"claude_code_version":"${version}"`));
}

/** The recording with its first turn held after its system/init, where stdin EOF does not end the CLI (design 3). */
function stalledAfterInit(recording: ClaudeRecording): ClaudeRecording {
  const [turn = [], ...rest] = recording.turns;
  const init = turn.findIndex(
    (step) => 'frame' in step && step.frame.type === 'system' && step.frame.subtype === 'init',
  );
  const held: RecordingStep[] = [...turn.slice(0, init + 1), { ignoreEof: true }, { sleep: 60_000 }];
  return { ...recording, turns: [held, ...rest] };
}

async function start(adapter: ClaudeAdapter, launch: AgentLaunch): Promise<AgentSession> {
  const session = await adapter.start(launch);
  sessions.push(session);
  return session;
}

/** The first n events of a session. */
async function firstEvents(session: AgentSession, n: number): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of session.events) {
    events.push(event);
    if (events.length === n) break;
  }
  return events;
}

async function argvOf(log: string): Promise<Extract<FakeClaudeLogEntry, { kind: 'argv' }>> {
  const entry = (await readFakeClaudeLog(log)).find((line) => line.kind === 'argv');
  if (entry?.kind !== 'argv') throw new Error('the fake logged no argv');
  return entry;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('ClaudeAdapter.start', () => {
  test(
    "it reads the binary of launch.cliVersion first: a missing one is 'binary missing', another version is named",
    async () => {
      const missing = setup(loadRecording('turn-basic'), { binary: 'none' });
      await expect(missing.adapter.start(missing.launch)).rejects.toThrow('binary missing');

      const older = setup(loadRecording('turn-basic'), { binary: 'none' });
      stub(older.paths, CLAUDE_CLI_VERSION, ['echo "2.1.200 (Claude Code)"']);
      await expect(older.adapter.start(older.launch)).rejects.toThrow(
        `claude 2.1.200, expected ${CLAUDE_CLI_VERSION}`,
      );
      expect([...missing.registered, ...older.registered]).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "the binary and the first-turn check follow launch.cliVersion, not the pin: a resume's older CLI",
    async () => {
      // Only the pin's binary is there.
      const missing = setup(loadRecording('turn-basic'));
      await expect(missing.adapter.start({ ...missing.launch, cliVersion: '2.1.200' })).rejects.toThrow(
        'binary missing',
      );

      const wrong = setup(loadRecording('turn-basic'));
      stub(wrong.paths, '2.1.200', [`echo "${CLAUDE_CLI_VERSION} (Claude Code)"`]);
      await expect(wrong.adapter.start({ ...wrong.launch, cliVersion: '2.1.200' })).rejects.toThrow(
        `claude ${CLAUDE_CLI_VERSION}, expected 2.1.200`,
      );

      // The version check gets only PATH, so the older claude is a script that answers it and runs the fake.
      const older = [
        '[ "$1" = --version ] && { echo "2.1.200 (Claude Code)"; exit 0; }',
        `exec '${FAKE_CLAUDE_BIN}' "$@"`,
      ];
      const ok = setup(initVersion('turn-basic', '2.1.200'));
      stub(ok.paths, '2.1.200', older);
      const session = await start(ok.adapter, { ...ok.launch, cliVersion: '2.1.200' });
      const [started] = await firstEvents(session, 1);
      expect(started).toMatchObject({ type: 'started', cliVersion: '2.1.200' });

      // A first turn of the pin's version is not the attempt's.
      const pinned = setup(loadRecording('turn-basic'));
      stub(pinned.paths, '2.1.200', older);
      await expect(pinned.adapter.start({ ...pinned.launch, cliVersion: '2.1.200' })).rejects.toThrow(
        new Error(`claude ${CLAUDE_CLI_VERSION}, expected 2.1.200`),
      );
    },
    TIMEOUT,
  );

  test(
    'a model alias, a launch without a base checkout and a clone slug over 200 characters are refused before spawning',
    async () => {
      const { adapter, launch, log, registered, paths } = setup(loadRecording('turn-basic'));
      await expect(adapter.start({ ...launch, model: 'sonnet' })).rejects.toThrow(/not a full model id/);
      await expect(adapter.start({ ...launch, baseCheckout: null })).rejects.toThrow(/base checkout/);
      const deep = join(paths.work, 'p-1', 'x'.repeat(200));
      mkdirSync(deep, { recursive: true });
      await expect(adapter.start({ ...launch, clone: deep })).rejects.toThrow(/refuses the clone/);
      expect(registered).toEqual([]);
      expect(existsSync(log)).toBe(false);
    },
    TIMEOUT,
  );

  test(
    'it pushes the first prompt and resolves after the first system/init; started comes first, after the pid',
    async () => {
      const { adapter, launch, log, registered } = setup(loadRecording('turn-basic'));
      const session = await start(adapter, launch);
      expect(session.sessionRef).toMatch(UUID);
      expect(registered).toEqual([session.pid]);
      const [started, turn] = await firstEvents(session, 2);
      expect(started).toEqual({
        type: 'started',
        sessionRef: session.sessionRef,
        model: 'claude-sonnet-5-5',
        cliVersion: CLAUDE_CLI_VERSION,
        permissionMode: 'acceptEdits',
      });
      expect(turn).toEqual({ type: 'turn_started' });
      expect((await argvOf(log)).argv).toContain(`--session-id=${session.sessionRef}`);
      const users = (await readFakeClaudeLog(log)).filter((entry) => entry.kind === 'user');
      expect(users).toHaveLength(1);
      expect(users[0]).toMatchObject({ message: { message: { role: 'user', content: 'Start with the task.' } } });
    },
    TIMEOUT,
  );

  test(
    "a first system/init that does not match closes the session and rejects start() with the problems",
    async () => {
      const { adapter, launch, registered } = setup(loadRecording('init-mismatch'));
      await expect(adapter.start(launch)).rejects.toThrow(
        new Error(`claude 2.1.200, expected ${CLAUDE_CLI_VERSION}; unexpected MCP servers: github`),
      );
      expect(registered).toHaveLength(1);
      expect(alive(registered[0] as number)).toBe(false);
    },
    TIMEOUT,
  );

  test(
    'a refused first turn ends the CLI at once, though stdin EOF does not, and start() rejects after the exit',
    async () => {
      const { adapter, launch, log, registered } = setup(stalledAfterInit(loadRecording('init-mismatch')));
      await expect(adapter.start(launch)).rejects.toThrow(/^claude 2\.1\.200, expected /);
      expect(alive(registered[0] as number)).toBe(false);
      const entries = await readFakeClaudeLog(log);
      const prompt = entries.find((entry) => entry.kind === 'user');
      const exit = entries.find((entry) => entry.kind === 'exit');
      expect(exit).toMatchObject({ code: 143 });
      // SIGTERM came with the refusal; the SDK's close() alone would wait 2 s, then signal the leader only.
      expect((exit?.at ?? Infinity) - (prompt?.at ?? 0)).toBeLessThan(1_500);
    },
    TIMEOUT,
  );

  test(
    "a new session's CLI that ends before its first turn fails the start with how it exited and its stderr",
    async () => {
      const { adapter, launch, registered } = setup(claudeRecording({ turns: [[{ stderr: 'boom\n' }, { exit: 3 }]] }));
      await expect(adapter.start(launch)).rejects.toThrow(
        new Error('claude ended before its first turn: exit code 3: boom'),
      );
      expect(registered).toHaveLength(1);
      expect(alive(registered[0] as number)).toBe(false);
    },
    TIMEOUT,
  );

  test(
    'a CLI that starts no turn within the deadline fails the start; one that ignores SIGTERM is killed',
    async () => {
      const { adapter, launch, registered, paths } = setup(loadRecording('turn-basic'), {
        adapter: { startTimeoutMs: 1_000 },
      });
      stub(paths, CLAUDE_CLI_VERSION, [
        `[ "$1" = --version ] && { echo "${CLAUDE_CLI_VERSION} (Claude Code)"; exit 0; }`,
        "trap '' TERM",
        'exec /bin/sleep 600',
      ]);
      await expect(adapter.start(launch)).rejects.toThrow(
        new Error('claude started no turn within 1 s: ended by SIGKILL'),
      );
      expect(alive(registered[0] as number)).toBe(false);
    },
    TIMEOUT,
  );

  test(
    'with the auto profile and a last preflight that did not offer auto, the session runs acceptEdits and says so',
    async () => {
      const { adapter, launch, log } = setup(loadRecording('turn-basic'));
      const session = await start(adapter, { ...launch, profile: { ...standardProfile, name: 'auto' } });
      const [started] = await firstEvents(session, 1);
      expect(started).toMatchObject({ type: 'started', permissionMode: 'acceptEdits' });
      const { argv } = await argvOf(log);
      expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
    },
    TIMEOUT,
  );

  test(
    "the child's environment holds no ANTHROPIC_API_KEY or CLAUDE_CODE_* from the runner's own environment",
    async () => {
      const { adapter, launch, log } = setup(loadRecording('turn-basic'));
      const saved = { key: process.env.ANTHROPIC_API_KEY, bedrock: process.env.CLAUDE_CODE_USE_BEDROCK };
      process.env.ANTHROPIC_API_KEY = 'sk-ant-runner-own';
      process.env.CLAUDE_CODE_USE_BEDROCK = '1';
      try {
        await start(adapter, launch);
      } finally {
        if (saved.key === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = saved.key;
        if (saved.bedrock === undefined) delete process.env.CLAUDE_CODE_USE_BEDROCK;
        else process.env.CLAUDE_CODE_USE_BEDROCK = saved.bedrock;
      }
      const { env } = await argvOf(log);
      expect(env).not.toContain('ANTHROPIC_API_KEY');
      expect(env).not.toContain('CLAUDE_CODE_USE_BEDROCK');
      expect(env).toContain('CLAUDE_CONFIG_DIR');
      expect(env).toContain('CLAUDE_CODE_TMPDIR');
    },
    TIMEOUT,
  );

  test(
    "skipAuthChecks leaves the first turn's API key source be; without it, the key fails the start",
    async () => {
      const text = readFileSync(join(CLAUDE_FIXTURES_DIR, 'turn-basic.jsonl'), 'utf8');
      const keyed = parseRecording(text.replaceAll('"apiKeySource":"none"', '"apiKeySource":"ANTHROPIC_API_KEY"'));
      const strict = setup(keyed);
      await expect(strict.adapter.start(strict.launch)).rejects.toThrow('an API key would replace the subscription');
      const test = setup(keyed, { adapter: { skipAuthChecks: true } });
      const session = await start(test.adapter, test.launch);
      expect(await firstEvents(session, 1)).toEqual([expect.objectContaining({ type: 'started' })]);
    },
    TIMEOUT,
  );

  test('Claude raises no approvals, so the adapter has no enrichApproval (X-5)', () => {
    const { adapter } = setup(loadRecording('turn-basic'));
    expect('enrichApproval' in adapter).toBe(false);
    expect((adapter as Partial<VendorAdapter>).enrichApproval).toBeUndefined();
  });

  test(
    'a resume passes the session id, pushes no prompt, and resolves once the CLI answers initialize',
    async () => {
      const fixture = setup(loadRecording('turn-basic'));
      const { adapter, launch, log } = fixture;
      const sessionRef = 'aaaaaaaa-0000-4000-8000-000000000001';
      ranATurn(fixture, sessionRef);
      const session = await start(adapter, { ...launch, resume: { sessionRef } });
      expect(session.sessionRef).toBe(sessionRef);
      expect((await argvOf(log)).argv).toContain(`--resume=${sessionRef}`);
      expect((await readFakeClaudeLog(log)).some((entry) => entry.kind === 'user')).toBe(false);
      await session.send({ id: 'm-1', text: 'Carry on.', authority: 'system' });
      // The message starts before system/init comes, yet started stays the first event.
      expect(await firstEvents(session, 3)).toEqual([
        expect.objectContaining({ type: 'started', sessionRef }),
        { type: 'turn_started' },
        { type: 'delivered', id: 'm-1' },
      ]);
    },
    TIMEOUT,
  );

  test(
    "a resumed session's first turn is checked when the runner's message starts it: a mismatch ends the session",
    async () => {
      const fixture = setup(loadRecording('init-mismatch'));
      const { adapter, launch } = fixture;
      const sessionRef = 'aaaaaaaa-0000-4000-8000-000000000001';
      ranATurn(fixture, sessionRef);
      const session = await start(adapter, { ...launch, resume: { sessionRef } });
      await session.send({ id: 'm-1', text: 'Carry on.', authority: 'system' });
      const events: AgentEvent[] = [];
      for await (const event of session.events) events.push(event);
      const problems = `claude 2.1.200, expected ${CLAUDE_CLI_VERSION}; unexpected MCP servers: github`;
      expect(events).toEqual([{ type: 'warning', text: `the session does not match its options: ${problems}` }]);
      expect((await session.exited).signal).toBeNull();
    },
    TIMEOUT,
  );

  test(
    "a resumed CLI that ends before it answers initialize fails the start with the CLI's error, once it is gone",
    async () => {
      const recording = claudeRecording({ startup: [{ stderr: 'boom\n' }, { exit: 3 }], turns: [] });
      const fixture = setup(recording);
      const { adapter, launch, registered } = fixture;
      const sessionRef = 'aaaaaaaa-0000-4000-8000-000000000001';
      ranATurn(fixture, sessionRef);
      const failure = adapter.start({ ...launch, resume: { sessionRef } });
      await expect(failure).rejects.toThrow(/exit code 3: boom$/);
      expect(registered).toHaveLength(1);
      expect(alive(registered[0] as number)).toBe(false);
    },
    TIMEOUT,
  );
});

describe('the transcripts', () => {
  test("readTranscriptTail and deleteTranscript apply to the adapter's Claude home", async () => {
    const { adapter, launch } = setup(loadRecording('turn-basic'));
    const sessionRef = 'bbbbbbbb-0000-4000-8000-000000000002';
    const dir = claudeProjectDir(launch.env.CLAUDE_CONFIG_DIR as string, launch.clone);
    mkdirSync(dir, { recursive: true });
    const said = (text: string) =>
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
    const prompt = JSON.stringify({ type: 'user', message: { role: 'user', content: 'go' } });
    writeFileSync(join(dir, `${sessionRef}.jsonl`), `${[prompt, said('first'), prompt, said('second')].join('\n')}\n`);
    const ref = { sessionRef, clone: launch.clone };
    expect(await adapter.readTranscriptTail({ ...ref, maxChars: 100 })).toBe('first\n\nsecond');
    await adapter.deleteTranscript(ref);
    expect(existsSync(join(dir, `${sessionRef}.jsonl`))).toBe(false);
    expect(await adapter.readTranscriptTail({ ...ref, maxChars: 100 })).toBeNull();
  });
});
