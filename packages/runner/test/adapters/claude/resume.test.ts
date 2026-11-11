import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { linkClaudeBinary } from '@agflow/testkit/src/anthropic';
import {
  type ClaudeRecording,
  CLAUDE_FIXTURES_DIR,
  FAKE_CLAUDE_BIN,
  type FakeClaudeLogEntry,
  fakeClaudeEnv,
  loadRecording,
  parseRecording,
  readFakeClaudeLog,
} from '@agflow/testkit/src/fake-claude';
import {
  CLAUDE_SCENARIOS,
  type ClaudeScenario,
  recordingOf,
  runScenario,
  scratchLaunch,
} from '../../../scripts/record-claude-stream';
import { ClaudeAdapter } from '../../../src/adapters/claude/adapter';
import { claudeBinary } from '../../../src/adapters/claude/options';
import { claudeProjectDir } from '../../../src/adapters/claude/paths';
import { CLAUDE_CLI_VERSION } from '../../../src/adapters/claude/pin';
import type { AgentEvent, AgentLaunch, AgentSession } from '../../../src/adapters/types';
import { RunnerConfigSchema } from '../../../src/config';
import { runnerPaths } from '../../../src/paths';
import { standardProfile } from '../../../src/profile';

// macOS's first exec of a new script is slow, more so under load.
const TIMEOUT = 30_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SESSION_REF = 'cccccccc-0000-4000-8000-000000000003';
/** An older CLI version an attempt may have started with (X-13). */
const OLDER = '2.1.280';
/** What 2.1.285 says when it resumes a session without a conversation (captured in resume-not-found). */
const NOT_FOUND = 'No conversation found with session ID';

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
  adapter: ClaudeAdapter;
  launch: AgentLaunch;
  /** The fake's log. */
  log: string;
  /** The pids registerProcess got, in order, across the launches. */
  registered: number[];
  paths: ReturnType<typeof runnerPaths>;
  /** A registerProcess for another launch. */
  registration(): AgentLaunch['registerProcess'];
}

/** A runner layout, its adapter, and a launch of the recording, with the fake as the pinned claude. */
function setup(recording: ClaudeRecording): Setup {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agflow-claude-resume-')));
  dirs.push(root);
  const paths = runnerPaths(join(root, '.agflow'));
  linkClaudeBinary(paths.home, CLAUDE_CLI_VERSION, FAKE_CLAUDE_BIN);
  const clone = join(paths.work, 'p-1', 'T-1-a1');
  const tmpDir = join(root, 'tmp');
  const home = join(root, 'home');
  for (const dir of [clone, tmpDir, home, paths.homes.claude]) mkdirSync(dir, { recursive: true });
  const fake = fakeClaudeEnv({ recording, dir: join(root, 'fake') });
  const registered: number[] = [];
  // As M2b's ProcessRegistration: a launch registers one process, and a second one is refused.
  const registration = (): AgentLaunch['registerProcess'] => {
    let pid: number | null = null;
    return (next) => {
      if (pid !== null) throw new Error(`the agent was already registered (pid ${pid})`);
      pid = next;
      registered.push(next);
      groups.add(next);
    };
  };
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
    registerProcess: registration(),
  };
  const adapter = new ClaudeAdapter({
    agflow: { command: '/usr/bin/false', args: [] },
    config: RunnerConfigSchema.parse({ runnerKey: 'r-1', machineId: 'machine-1', name: 'laptop' }),
    paths,
    vendorHomes: { claude: paths.homes.claude, codex: paths.homes.codex },
  });
  return { root, adapter, launch, log: fake.FAKE_CLAUDE_LOG as string, registered, paths, registration };
}

/** The transcript of a session that ran a turn, in the clone's project directory: what a resume resumes. */
function ranATurn(setup: Setup, sessionRef: string): void {
  const dir = claudeProjectDir(setup.paths.homes.claude, setup.launch.clone);
  mkdirSync(dir, { recursive: true });
  const prompt = { type: 'user', message: { role: 'user', content: 'Start with the task.' } };
  writeFileSync(join(dir, `${sessionRef}.jsonl`), `${JSON.stringify(prompt)}\n`);
}

/**
 * A claude of the given version in the layout: it reports that version and runs the fake, after noting its working
 * directory in <root>/cwd. With notFound, a resume replays resume-not-found instead of the launch's recording.
 */
function wrapClaude(setup: Setup, version: string, options: { notFound?: boolean } = {}): void {
  const bin = claudeBinary(setup.paths, version);
  mkdirSync(dirname(bin), { recursive: true });
  rmSync(bin, { force: true });
  const notFound = join(CLAUDE_FIXTURES_DIR, 'resume-not-found.jsonl');
  const lines = [
    '#!/bin/sh',
    `[ "$1" = --version ] && { echo "${version} (Claude Code)"; exit 0; }`,
    `pwd > '${join(setup.root, 'cwd')}'`,
    ...(options.notFound
      ? [`case " $* " in *" --resume"*) FAKE_CLAUDE_RECORDING='${notFound}'; export FAKE_CLAUDE_RECORDING;; esac`]
      : []),
    `exec '${FAKE_CLAUDE_BIN}' "$@"`,
  ];
  writeFileSync(bin, `${lines.join('\n')}\n`);
  chmodSync(bin, 0o755);
}

/** turn-basic as an older CLI printed it: its system/init names that version. */
function olderTurn(version: string): ClaudeRecording {
  const text = readFileSync(join(CLAUDE_FIXTURES_DIR, 'turn-basic.jsonl'), 'utf8');
  return parseRecording(
    text.replaceAll(`"claude_code_version":"${CLAUDE_CLI_VERSION}"`, `"claude_code_version":"${version}"`),
  );
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

async function argvs(log: string): Promise<string[][]> {
  return (await readFakeClaudeLog(log)).flatMap((entry: FakeClaudeLogEntry) =>
    entry.kind === 'argv' ? [entry.argv] : [],
  );
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('ClaudeAdapter.start: resume', () => {
  test(
    "a resume passes resume: sessionRef with a new session's options, in its clone, with the attempt's CLI",
    async () => {
      const fixture = setup(olderTurn(OLDER));
      const { adapter, launch, log, root } = fixture;
      wrapClaude(fixture, OLDER);
      // A new session of the same launch on the pin, for its options.
      const fresh = await start(adapter, launch).catch((error: Error) => error);
      // The pin's fake replays the older init, which the first-turn check refuses; its argv is all this needs.
      expect(fresh).toBeInstanceOf(Error);

      ranATurn(fixture, SESSION_REF);
      const session = await start(adapter, {
        ...launch,
        cliVersion: OLDER,
        resume: { sessionRef: SESSION_REF },
        registerProcess: fixture.registration(),
      });
      expect(session.sessionRef).toBe(SESSION_REF);
      const [newArgv, resumeArgv] = await argvs(log);
      const asResume = (newArgv ?? []).map((arg) =>
        arg.startsWith('--session-id=') ? `--resume=${SESSION_REF}` : arg,
      );
      // The SDK places --resume elsewhere than --session-id; the arguments are the same.
      expect([...(resumeArgv ?? [])].sort()).toEqual(asResume.sort());
      // The binary of launch.cliVersion ran, in the clone.
      expect(readFileSync(join(root, 'cwd'), 'utf8').trim()).toBe(launch.clone);
      await session.send({ id: 'm-1', text: 'Carry on.', authority: 'system' });
      const [started] = await firstEvents(session, 1);
      expect(started).toEqual({
        type: 'started',
        sessionRef: SESSION_REF,
        model: 'claude-sonnet-5-5',
        cliVersion: OLDER,
        permissionMode: 'acceptEdits',
      });
    },
    TIMEOUT,
  );

  test(
    'a session that never ran a turn starts afresh in its clone with the first prompt; no resume is spawned',
    async () => {
      const queued = JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: 'Start with the task.' });
      // No transcript at all, and one the CLI wrote no message to.
      for (const transcript of [null, [queued]]) {
        const fixture = setup(loadRecording('turn-basic'));
        const { adapter, launch, log, registered } = fixture;
        // A resume, were one spawned, would replay resume-not-found.
        wrapClaude(fixture, CLAUDE_CLI_VERSION, { notFound: true });
        if (transcript !== null) {
          const dir = claudeProjectDir(fixture.paths.homes.claude, launch.clone);
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, `${SESSION_REF}.jsonl`), `${transcript.join('\n')}\n`);
        }
        const session = await start(adapter, { ...launch, resume: { sessionRef: SESSION_REF } });
        expect(session.sessionRef).toMatch(UUID);
        expect(session.sessionRef).not.toBe(SESSION_REF);
        // One launch, one process: the registration M2b refuses twice took it.
        expect(registered).toEqual([session.pid]);
        expect(readFileSync(join(fixture.root, 'cwd'), 'utf8').trim()).toBe(launch.clone);
        const all = await argvs(log);
        expect(all).toHaveLength(1);
        expect(all[0]).toContain(`--session-id=${session.sessionRef}`);
        expect(all[0]?.some((arg) => arg.startsWith('--resume'))).toBe(false);
        const [started] = await firstEvents(session, 1);
        expect(started).toMatchObject({ type: 'started', sessionRef: session.sessionRef });
        const users = (await readFakeClaudeLog(log)).filter((entry) => entry.kind === 'user');
        expect(users).toHaveLength(1);
        expect(users[0]).toMatchObject({ message: { message: { role: 'user', content: 'Start with the task.' } } });
      }
    },
    TIMEOUT,
  );

  test(
    "a resume the CLI refuses with 'No conversation found' fails the start once the process is gone; no fallback",
    async () => {
      const fixture = setup(loadRecording('resume-not-found'));
      const { adapter, launch, registered } = fixture;
      ranATurn(fixture, SESSION_REF);
      const failure = adapter.start({ ...launch, resume: { sessionRef: SESSION_REF } });
      await expect(failure).rejects.toThrow(NOT_FOUND);
      await expect(failure).rejects.toThrow(/exit code 1/);
      expect(registered).toHaveLength(1);
      expect(alive(registered[0] as number)).toBe(false);
    },
    TIMEOUT,
  );

  test(
    "any other resume failure rejects start() with the CLI's error once the process is gone",
    async () => {
      const fixture = setup(loadRecording('resume-failure'));
      const { adapter, launch, registered } = fixture;
      ranATurn(fixture, SESSION_REF);
      const failure = adapter.start({ ...launch, resume: { sessionRef: SESSION_REF } });
      await expect(failure).rejects.toThrow(/--resume requires a valid session ID.*: exit code 1$/);
      expect(registered).toHaveLength(1);
      expect(alive(registered[0] as number)).toBe(false);
    },
    TIMEOUT,
  );
});

describe('the resume recordings', () => {
  function scenario(name: string): ClaudeScenario {
    const found = CLAUDE_SCENARIOS.find((entry) => entry.name === name);
    if (!found) throw new Error(`no scenario ${name}`);
    return found;
  }

  for (const name of ['resume-not-found', 'resume-failure']) {
    test(
      `${name} replays through the recorder as it was captured: an error result, stderr and exit 1`,
      async () => {
        const recording = loadRecording(name);
        expect(recording.header).toMatchObject({ source: 'captured', cliVersion: CLAUDE_CLI_VERSION });
        const launch = scratchLaunch({ bin: FAKE_CLAUDE_BIN, model: recording.header.model, env: {} });
        try {
          Object.assign(launch.launch.env, fakeClaudeEnv({ recording, dir: join(launch.root, 'fake') }));
          const run = await runScenario(scenario(name), launch);
          expect(run.exit).toEqual({ code: 1, signal: null });
          expect(run.startError).toContain(name === 'resume-not-found' ? NOT_FOUND : '--resume');
          const again = recordingOf(run, recording.header, launch, { live: false });
          expect(again.startup).toEqual(recording.startup);
          expect(again.turns).toEqual([]);
        } finally {
          launch.cleanup();
        }
      },
      TIMEOUT,
    );
  }
});
