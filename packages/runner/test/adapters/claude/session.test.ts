import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { linkClaudeBinary } from '@agflow/testkit/src/anthropic';
import {
  type ClaudeRecording,
  claudeRecording,
  FAKE_CLAUDE_BIN,
  type FakeClaudeLogEntry,
  fakeClaudeEnv,
  loadRecording,
  type RecordingStep,
  readFakeClaudeLog,
} from '@agflow/testkit/src/fake-claude';
import { type ClaudeOptionDeps, claudeEmptyDir } from '../../../src/adapters/claude/options';
import { CLAUDE_CLI_VERSION } from '../../../src/adapters/claude/pin';
import { ClaudeSession, type ClaudeSessionInput } from '../../../src/adapters/claude/session';
import type { AgentEvent, AgentLaunch } from '../../../src/adapters/types';
import { runnerPaths } from '../../../src/paths';
import { standardProfile } from '../../../src/profile';

// macOS's first exec of a new script is slow, more so under load.
const TIMEOUT = 30_000;
const SESSION = '11111111-2222-4333-8444-555555555555';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const dirs: string[] = [];
const groups = new Set<number>();
const sessions: ClaudeSession[] = [];

afterEach(async () => {
  for (const session of sessions.splice(0)) session.terminate();
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

/** A runner layout whose pinned claude is the fake, an attempt clone in it, and a launch for that clone. */
function setup(recording: ClaudeRecording) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agflow-claude-session-')));
  dirs.push(root);
  const paths = runnerPaths(join(root, '.agflow'));
  linkClaudeBinary(paths.home, CLAUDE_CLI_VERSION, FAKE_CLAUDE_BIN);
  const clone = join(paths.work, 'p-1', 'T-1-a1');
  const tmpDir = join(root, 'tmp');
  const home = join(root, 'home');
  for (const dir of [clone, tmpDir, home, paths.homes.claude]) mkdirSync(dir, { recursive: true });
  const fake = fakeClaudeEnv({ recording, dir: join(root, 'fake') });
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
    firstPrompt: 'go',
    resume: null,
    logFile: join(root, 'attempt.log'),
    registerProcess: (pid) => {
      groups.add(pid);
    },
  };
  const deps: ClaudeSessionInput['deps'] = {
    agflow: { command: '/usr/bin/false', args: [] },
    paths,
    vendorHomes: { claude: paths.homes.claude, codex: paths.homes.codex },
    autoOffered: false,
    newSessionId: () => SESSION,
  } satisfies Omit<ClaudeOptionDeps, 'spawnClaudeCodeProcess' | 'compaction'>;
  return { launch, deps, log: fake.FAKE_CLAUDE_LOG as string };
}

/** Reads a session's events as they come, so a test can wait for one. */
class Events {
  readonly seen: AgentEvent[] = [];
  ended = false;
  readonly done: Promise<void>;
  private wakers: (() => void)[] = [];

  constructor(session: ClaudeSession) {
    this.done = (async () => {
      for await (const event of session.events) {
        this.seen.push(event);
        this.wake();
      }
      this.ended = true;
      this.wake();
    })();
  }

  /** The n-th event (1-based) that matches, once it came. */
  async until(match: (event: AgentEvent) => boolean, nth = 1, timeoutMs = 20_000): Promise<AgentEvent> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.seen.filter(match);
      if (found.length >= nth) return found[nth - 1] as AgentEvent;
      if (this.ended || Date.now() > deadline) {
        throw new Error(`no such event; saw ${JSON.stringify(this.seen.map((event) => event.type))}`);
      }
      await new Promise<void>((resolve) => {
        this.wakers.push(resolve);
        setTimeout(resolve, 100);
      });
    }
  }

  types(): string[] {
    return this.seen.map((event) => event.type);
  }

  private wake(): void {
    for (const wake of this.wakers.splice(0)) wake();
  }
}

function open(recording: ClaudeRecording, input: Partial<ClaudeSessionInput> = {}) {
  const { launch, deps, log } = setup(recording);
  const session = new ClaudeSession({ launch, deps, firstPrompt: launch.firstPrompt, ...input });
  sessions.push(session);
  return { session, events: new Events(session), log, launch };
}

/** Matches events of a type whose fields hold these values. */
function is<T extends AgentEvent['type']>(type: T, fields: Partial<Extract<AgentEvent, { type: T }>> = {}) {
  return (event: AgentEvent) =>
    event.type === type &&
    Object.entries(fields).every(([key, value]) => (event as Record<string, unknown>)[key] === value);
}

async function logOf(path: string, kind: FakeClaudeLogEntry['kind']): Promise<FakeClaudeLogEntry[]> {
  return (await readFakeClaudeLog(path)).filter((entry) => entry.kind === kind);
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

/** A turn that fails by itself: only an error_during_execution result for the newest message. */
const failingTurn: RecordingStep[] = [
  {
    frame: {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      duration_ms: 0,
      duration_api_ms: 0,
      num_turns: 1,
      result: null,
      stop_reason: null,
      session_id: '$SESSION',
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      modelUsage: {},
      permission_denials: [],
      errors: ['the session store is corrupt'],
      uuid: '$UUID',
      user_message_uuids: ['$LAST_USER_UUID'],
    },
  },
];

/** Waits until the fake logged n entries of a kind: the interrupt recording waits for one only after its hook. */
async function logged(path: string, kind: FakeClaudeLogEntry['kind'], n = 1): Promise<void> {
  const deadline = Date.now() + 20_000;
  while ((await logOf(path, kind)).length < n) {
    if (Date.now() > deadline) throw new Error(`the fake logged no ${kind}`);
    await Bun.sleep(20);
  }
}

describe('ClaudeSession', () => {
  test(
    "the Claude home's empty directory, where the bridge and the brief hook start, is made before the CLI",
    async () => {
      const { launch, deps } = setup(loadRecording('turn-basic'));
      const empty = claudeEmptyDir(deps.vendorHomes.claude);
      expect(existsSync(empty)).toBe(false);
      const session = new ClaudeSession({ launch, deps, firstPrompt: launch.firstPrompt });
      sessions.push(session);
      expect(statSync(empty).isDirectory()).toBe(true);
      await new Events(session).until(is('turn_ended'));
    },
    TIMEOUT,
  );

  test(
    'send() pushes a message with a fresh uuid and the default priority; delivered and acknowledged carry its id',
    async () => {
      const { session, events, log } = open(loadRecording('turn-delivery'));
      expect(session.sessionRef).toBe(SESSION);
      expect(session.pid).toBeGreaterThan(0);
      await events.until(is('tool_started'));
      await session.send({ id: 'm-1', text: 'a note', authority: 'person' });
      await events.until(is('turn_ended'));
      const delivered = events.seen.findIndex(is('delivered', { id: 'm-1' }));
      const acknowledged = events.seen.findIndex(is('acknowledged', { id: 'm-1' }));
      expect(delivered).toBeGreaterThan(-1);
      expect(acknowledged).toBeGreaterThan(delivered);
      expect(events.seen.find(is('turn_ended'))).toMatchObject({ outcome: 'completed', errorKind: null });

      const users = await logOf(log, 'user');
      expect(users).toHaveLength(2);
      const [first, note] = users.map((entry) => (entry.kind === 'user' ? entry.message : {}));
      expect(first).toMatchObject({ type: 'user', message: { role: 'user', content: 'go' }, parent_tool_use_id: null });
      expect(note).toMatchObject({ message: { content: 'a note' }, parent_tool_use_id: null });
      expect(note?.uuid).toMatch(UUID);
      expect(note?.uuid).not.toBe(first?.uuid);
      expect(note).not.toHaveProperty('priority');
    },
    TIMEOUT,
  );

  test(
    'interrupt() is plain: the turn ends interrupted and a queued message runs next',
    async () => {
      const interrupt = loadRecording('interrupt');
      const next = loadRecording('compaction').turns[0] ?? [];
      const { session, events, log } = open({ ...interrupt, turns: [...interrupt.turns, next] });
      await logged(log, 'hook_answer');
      await session.send({ id: 'm-1', text: 'after the interrupt', authority: 'person' });
      await logged(log, 'user', 2);
      await session.interrupt();
      expect(await events.until(is('turn_ended'))).toMatchObject({ outcome: 'interrupted', errorKind: null });
      expect(await events.until(is('turn_ended'), 2)).toMatchObject({ outcome: 'completed' });
      expect(events.seen.findIndex(is('delivered', { id: 'm-1' }))).toBeGreaterThan(
        events.seen.findIndex(is('turn_ended')),
      );
      expect(events.seen.some(is('acknowledged', { id: 'm-1' }))).toBe(true);
      const interrupts = (await logOf(log, 'control')).filter(
        (entry) => entry.kind === 'control' && entry.request.subtype === 'interrupt',
      );
      expect(interrupts).toHaveLength(1);
      expect(interrupts[0]).toMatchObject({ request: { subtype: 'interrupt' } });
      expect(interrupts[0]?.kind === 'control' && interrupts[0].request).not.toHaveProperty('cancel_queued');
    },
    TIMEOUT,
  );

  test(
    'interrupt({ cancelQueued: true }) sends cancel_queued: the turn ends interrupted, the queued message never runs',
    async () => {
      const { session, events, log } = open(loadRecording('interrupt'));
      await logged(log, 'hook_answer');
      await session.send({ id: 'm-1', text: 'dropped', authority: 'system' });
      await logged(log, 'user', 2);
      await session.interrupt({ cancelQueued: true });
      expect(await events.until(is('turn_ended'))).toMatchObject({ outcome: 'interrupted', errorKind: null });
      const control = await logOf(log, 'control');
      expect(control.some((entry) => entry.kind === 'control' && entry.request.cancel_queued === true)).toBe(true);
      await session.close();
      await events.done;
      expect(events.seen.filter(is('turn_ended'))).toHaveLength(1);
      expect(events.seen.some(is('acknowledged', { id: 'm-1' }))).toBe(false);
      expect(await session.exited).toEqual({ code: 0, signal: null });
    },
    TIMEOUT,
  );

  test(
    'an interrupt after a turn ended still classifies the next turn when it holds a message sent during the last one',
    async () => {
      const basic = loadRecording('turn-basic');
      // The next turn holds still until the interrupt, then prints what 2.1.285 printed after one.
      const interrupted = (loadRecording('interrupt').turns[0] ?? []).filter((step) => !('wait' in step));
      const next: RecordingStep[] = [{ wait: 'interrupt' }, ...interrupted];
      const { session, events } = open({ ...basic, turns: [...basic.turns, next] });
      await events.until(is('tool_started'));
      // turn-basic waits for no message, so the CLI queues this one for a turn of its own.
      await session.send({ id: 'm-1', text: 'a note', authority: 'person' });
      expect(await events.until(is('turn_ended'))).toMatchObject({ outcome: 'completed' });
      expect(events.seen.some(is('delivered', { id: 'm-1' }))).toBe(false);
      await session.interrupt();
      expect(await events.until(is('turn_ended'), 2)).toMatchObject({ outcome: 'interrupted', errorKind: null });
      expect(events.seen.some(is('delivered', { id: 'm-1' }))).toBe(true);
    },
    TIMEOUT,
  );

  test(
    'an interrupt while idle is ignored: a later turn that fails by itself ends failed, not interrupted',
    async () => {
      const basic = loadRecording('turn-basic');
      const { session, events } = open({ ...basic, turns: [...basic.turns, failingTurn] });
      await events.until(is('turn_ended'));
      // Answered before the message is sent; the CLI was idle, so it ignored it.
      await session.interrupt();
      await session.send({ id: 'm-1', text: 'go on', authority: 'person' });
      expect(await events.until(is('turn_ended'), 2)).toMatchObject({
        outcome: 'failed',
        error: 'the session store is corrupt',
      });
    },
    TIMEOUT,
  );

  test(
    "the guard answers the fake's PreToolUse hook_callback for git push with deny",
    async () => {
      const { events, log } = open(loadRecording('turn-basic'));
      await events.until(is('turn_ended'));
      const answers = (await logOf(log, 'hook_answer')).map((entry) =>
        entry.kind === 'hook_answer' ? entry.answer : {},
      );
      // The recorded calls in order: echo hi, git push origin HEAD, then two bridge tools.
      expect(answers).toHaveLength(4);
      expect(answers[0]).toMatchObject({ subtype: 'success' });
      expect(JSON.stringify(answers[0])).not.toContain('deny');
      expect(answers[1]).toMatchObject({
        subtype: 'success',
        response: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' } },
      });
    },
    TIMEOUT,
  );

  test(
    'PreCompact gives a warning, and PostCompact gives compacted with its summary',
    async () => {
      const { session, events } = open(loadRecording('compaction'));
      await events.until(is('turn_ended'));
      await session.send({ id: 'm-1', text: '/compact', authority: 'person' });
      const compacted = await events.until(is('compacted'));
      expect(compacted).toEqual({
        type: 'compacted',
        summary: 'Summary: the agent said hello; nothing else happened.',
      });
      const warning = events.seen.findIndex(is('warning', { text: 'Claude is compacting its context (manual)' }));
      expect(warning).toBeGreaterThan(-1);
      expect(warning).toBeLessThan(events.seen.indexOf(compacted));
      expect(await events.until(is('turn_ended'), 2)).toMatchObject({ outcome: 'completed' });
    },
    TIMEOUT,
  );

  test(
    'close() ends the input and the process: exited resolves, and the events end after the exit',
    async () => {
      const { session, events, log } = open(loadRecording('turn-basic'));
      await events.until(is('turn_ended'));
      let exitedFirst = false;
      void session.exited.then(() => {
        exitedFirst = !events.ended;
      });
      await session.close();
      await events.done;
      expect(exitedFirst).toBe(true);
      expect(await session.exited).toEqual({ code: 0, signal: null });
      expect(events.types()[0]).toBe('started');
      expect((await readFakeClaudeLog(log)).at(-1)).toMatchObject({ kind: 'exit', code: 0 });
      await expect(session.send({ id: 'm-2', text: 'late', authority: 'person' })).rejects.toThrow(/closed/);
    },
    TIMEOUT,
  );

  test(
    'a crash mid-turn gives turn_ended failed with the stderr tail, then the exit code',
    async () => {
      const { session, events } = open(loadRecording('crash-mid-turn'));
      await events.done;
      expect(events.types()).toEqual([
        'started',
        'turn_started',
        'text',
        'tool_started',
        'tool_ended',
        'turn_ended',
      ]);
      expect(events.seen.find(is('tool_ended'))).toMatchObject({ toolId: 'toolu_basic_1', ok: false });
      expect(events.seen.at(-1)).toEqual({
        type: 'turn_ended',
        outcome: 'failed',
        toolCalls: 1,
        error: 'Error: the session store is corrupt\n    at loadSession (cli.js:1:1)\nclaude exited with code 3',
        errorKind: null,
      });
      expect(await session.exited).toEqual({ code: 3, signal: null });
    },
    TIMEOUT,
  );

  test(
    'a first system/init that fails the check ends the session before any work, and is reported',
    async () => {
      const { session, events } = open(loadRecording('turn-basic'), { checkInit: () => ['claude 2.1.200, expected'] });
      expect(await session.firstInit).toMatchObject({
        init: { type: 'system', subtype: 'init', session_id: SESSION },
        problems: ['claude 2.1.200, expected'],
      });
      await events.done;
      expect(events.seen).toEqual([
        { type: 'warning', text: 'the session does not match its options: claude 2.1.200, expected' },
      ]);
      // Ended, by stdin EOF (0) or SIGTERM (the fake exits 143 on it), whichever reaches the CLI first.
      const exit = await session.exited;
      expect(exit.signal).toBeNull();
      expect([0, 143]).toContain(exit.code as number);
    },
    TIMEOUT,
  );

  test(
    "terminate() ends the CLI's group at once, also mid-turn, where stdin EOF does not end it",
    async () => {
      const { session, events } = open(stalledAfterInit(loadRecording('turn-basic')));
      await events.until(is('turn_started'));
      const before = Date.now();
      session.terminate();
      expect(await session.exited).toEqual({ code: 143, signal: null });
      // The SDK's close() alone would wait 2 s before it signals the leader.
      expect(Date.now() - before).toBeLessThan(1_500);
    },
    TIMEOUT,
  );

  test(
    'answerApproval resolves false: Claude raises no approvals',
    async () => {
      const { session } = open(claudeRecording({ turns: [] }), { firstPrompt: null });
      expect(await session.answerApproval('a-1', 'approve', null)).toBe(false);
      await session.close();
      expect(await session.exited).toEqual({ code: 0, signal: null });
    },
    TIMEOUT,
  );
});
