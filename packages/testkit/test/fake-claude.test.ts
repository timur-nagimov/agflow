import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ClaudeRecording,
  claudeRecording,
  FAKE_CLAUDE_BIN,
  fakeClaudeEnv,
  loadRecording,
  parseRecording,
  type RecordingStep,
  readFakeClaudeLog,
  serializeRecording,
  writeRecording,
} from '../src/fake-claude';

// macOS's first exec of a new script is slow; each test that runs the fake gets this long.
const TIMEOUT = 30_000;
const SESSION = '11111111-2222-4333-8444-555555555555';

const dirs: string[] = [];
const procs: FakeProcess[] = [];
afterEach(() => {
  for (const proc of procs.splice(0)) proc.kill();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agflow-fake-claude-'));
  dirs.push(dir);
  return dir;
}

type Frame = Record<string, any>;

/** The fake as the SDK drives it: JSON lines in, JSON lines out. */
class FakeProcess {
  readonly frames: Frame[] = [];
  private cursor = 0;
  private waiters: (() => void)[] = [];
  readonly proc: Bun.Subprocess<'pipe', 'pipe', 'pipe'>;
  readonly log: string;

  constructor(
    args: string[],
    env: Record<string, string>,
    readonly cwd: string,
  ) {
    this.log = env.FAKE_CLAUDE_LOG ?? '';
    this.proc = Bun.spawn([FAKE_CLAUDE_BIN, ...args], {
      cwd,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    void this.read();
  }

  private async read(): Promise<void> {
    let buffer = '';
    const decoder = new TextDecoder();
    for await (const chunk of this.proc.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim() !== '') this.frames.push(JSON.parse(line));
        index = buffer.indexOf('\n');
      }
      for (const wake of this.waiters.splice(0)) wake();
    }
    for (const wake of this.waiters.splice(0)) wake();
  }

  send(message: Frame): void {
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
    this.proc.stdin.flush();
  }

  control(requestId: string, request: Frame): void {
    this.send({ type: 'control_request', request_id: requestId, request });
  }

  user(text: string, uuid: string): void {
    this.send({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, uuid });
  }

  /** The next frame after the cursor that matches, and moves the cursor past it. */
  async next(match: (frame: Frame) => boolean, timeoutMs = 10_000): Promise<Frame> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = this.frames.findIndex((frame, at) => at >= this.cursor && match(frame));
      if (index >= 0) {
        this.cursor = index + 1;
        return this.frames[index] as Frame;
      }
      if (Date.now() > deadline) throw new Error(`no matching frame; got ${JSON.stringify(this.frames)}`);
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  }

  response(requestId: string): Promise<Frame> {
    return this.next((frame) => frame.type === 'control_response' && frame.response.request_id === requestId);
  }

  async end(): Promise<number> {
    this.proc.stdin.end();
    return this.proc.exited;
  }

  kill(): void {
    this.proc.kill('SIGKILL');
  }
}

function start(recording: ClaudeRecording, args: string[] = [`--session-id=${SESSION}`]): FakeProcess {
  const dir = tempDir();
  const proc = new FakeProcess(args, fakeClaudeEnv({ recording, dir }), dir);
  procs.push(proc);
  return proc;
}

async function initialize(proc: FakeProcess, hooks: Frame = {}): Promise<Frame> {
  proc.control('init-1', { subtype: 'initialize', hooks });
  return proc.response('init-1');
}

const frame = (value: Frame): RecordingStep => ({ frame: value });
const result = (extra: Frame = {}): RecordingStep =>
  frame({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'done',
    session_id: '$SESSION',
    uuid: '$UUID',
    user_message_uuids: ['$LAST_USER_UUID'],
    ...extra,
  });
const lifecycle = (state: string, uuid = '$LAST_USER_UUID'): RecordingStep =>
  frame({ type: 'command_lifecycle', command_uuid: uuid, state, uuid: '$UUID', session_id: '$SESSION' });
const init: RecordingStep = frame({
  type: 'system',
  subtype: 'init',
  session_id: '$SESSION',
  cwd: '$CWD',
  model: '$MODEL',
  permissionMode: '$PERMISSION_MODE',
  uuid: '$UUID',
});
const say = (text: string): RecordingStep =>
  frame({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    session_id: '$SESSION',
    uuid: '$UUID',
  });

beforeAll(() => {
  // Warm the script and Bun's transpile cache once, so the first test does not pay for it.
  const env = { PATH: process.env.PATH ?? '', FAKE_CLAUDE_BUN: process.execPath };
  Bun.spawnSync([FAKE_CLAUDE_BIN, '--version'], { env });
}, TIMEOUT);

describe('fake-claude', () => {
  test(
    "--version prints the pin, or FAKE_CLAUDE_VERSION, the way the real one does",
    () => {
      const run = (env: Record<string, string>) =>
        Bun.spawnSync([FAKE_CLAUDE_BIN, '--version'], { env: { PATH: process.env.PATH ?? '', ...env } });
      const plain = run({ FAKE_CLAUDE_BUN: process.execPath });
      expect(plain.exitCode).toBe(0);
      expect(plain.stdout.toString()).toBe('2.1.285 (Claude Code)\n');
      // Without FAKE_CLAUDE_BUN, as `<bin> --version` runs with PATH only, the bun on PATH runs it.
      const bunDir = process.execPath.slice(0, process.execPath.lastIndexOf('/'));
      const bare = Bun.spawnSync([FAKE_CLAUDE_BIN, '--version'], { env: { PATH: `${bunDir}:/usr/bin:/bin` } });
      expect(bare.stdout.toString()).toBe('2.1.285 (Claude Code)\n');
      const other = run({ FAKE_CLAUDE_BUN: process.execPath, FAKE_CLAUDE_VERSION: '2.1.200' });
      expect(other.stdout.toString()).toBe('2.1.200 (Claude Code)\n');
    },
    TIMEOUT,
  );

  test(
    'a symlink to the executable runs it, as a runner home links the vendor binary',
    () => {
      const dir = tempDir();
      const link = join(dir, 'claude');
      symlinkSync(FAKE_CLAUDE_BIN, link);
      const run = Bun.spawnSync([link, '--version'], {
        env: { PATH: process.env.PATH ?? '', FAKE_CLAUDE_BUN: process.execPath },
      });
      expect(run.stdout.toString()).toBe('2.1.285 (Claude Code)\n');
    },
    TIMEOUT,
  );

  test(
    'control requests are answered from the recording, and an unknown one gets an error, never silence',
    async () => {
      const recording = claudeRecording({
        turns: [],
        answers: {
          get_usage: { error: 'usage is unavailable' },
          get_settings: { response: { effective: { sandbox: { enabled: true, failIfUnavailable: true } } } },
        },
      });
      const proc = start(recording);
      const answer = await initialize(proc);
      expect(answer.response.subtype).toBe('success');
      expect(answer.response.response.account).toEqual({
        email: 'agent@example.invalid',
        organization: 'org-00000000-0000-4000-8000-000000000000',
        subscriptionType: 'max',
        tokenSource: 'claude.ai',
        apiProvider: 'firstParty',
      });
      expect(answer.response.response.models).toEqual([]);
      expect(answer.response.response.commands).toEqual([]);
      proc.control('s-1', { subtype: 'get_settings' });
      expect((await proc.response('s-1')).response).toEqual({
        subtype: 'success',
        request_id: 's-1',
        response: { effective: { sandbox: { enabled: true, failIfUnavailable: true } } },
      });
      proc.control('u-1', { subtype: 'get_usage', skip_behaviors: true });
      expect((await proc.response('u-1')).response).toEqual({
        subtype: 'error',
        request_id: 'u-1',
        error: 'usage is unavailable',
      });
      proc.control('x-1', { subtype: 'mcp_status' });
      const unknown = (await proc.response('x-1')).response;
      expect(unknown.subtype).toBe('error');
      expect(unknown.error).toContain('mcp_status');
      expect(await proc.end()).toBe(0);
    },
    TIMEOUT,
  );

  test(
    'each user message replays the next turn with the placeholders filled',
    async () => {
      const recording = claudeRecording({
        header: { model: 'claude-recorded-1', permissionMode: 'default' },
        turns: [
          [lifecycle('queued'), lifecycle('started'), init, say('first'), result(), lifecycle('completed')],
          [lifecycle('started'), say('second'), result({ modelUsage: { $MODEL: { contextWindow: 1000 } } })],
        ],
      });
      const args = ['--session-id', SESSION, '--model', 'claude-sonnet-5-5', '--permission-mode=auto'];
      const proc = start(recording, args);
      await initialize(proc);
      proc.user('go', 'user-1');
      expect(await proc.next((f) => f.type === 'command_lifecycle')).toMatchObject({
        command_uuid: 'user-1',
        state: 'queued',
        session_id: SESSION,
      });
      const started = await proc.next((f) => f.type === 'command_lifecycle');
      expect(started.state).toBe('started');
      const system = await proc.next((f) => f.type === 'system');
      expect(system).toMatchObject({ session_id: SESSION, model: 'claude-sonnet-5-5', permissionMode: 'auto' });
      expect(system.cwd).toBe(realpathSync(proc.cwd));
      expect(system.uuid).toMatch(/^[0-9a-f-]{36}$/);
      expect(system.uuid).not.toBe(started.uuid);
      const first = await proc.next((f) => f.type === 'result');
      expect(first.user_message_uuids).toEqual(['user-1']);
      proc.user('again', 'user-2');
      const second = await proc.next((f) => f.type === 'result');
      expect(second.user_message_uuids).toEqual(['user-2']);
      expect(second.modelUsage).toEqual({ 'claude-sonnet-5-5': { contextWindow: 1000 } });
      expect(await proc.end()).toBe(0);
    },
    TIMEOUT,
  );

  test(
    'a message folded into the running turn is waited for, and its uuid is the turn\'s second',
    async () => {
      const recording = claudeRecording({
        turns: [
          [
            lifecycle('started'),
            say('working'),
            { wait: 'user' },
            lifecycle('queued'),
            lifecycle('started'),
            say('folded'),
            result({ user_message_uuids: ['$USER_UUID_1', '$USER_UUID_2'] }),
            lifecycle('completed', '$USER_UUID_1'),
          ],
        ],
      });
      const proc = start(recording);
      await initialize(proc);
      proc.user('go', 'user-1');
      await proc.next((f) => f.type === 'assistant');
      proc.user('also this', 'user-2');
      const queued = await proc.next((f) => f.type === 'command_lifecycle' && f.state === 'queued');
      expect(queued.command_uuid).toBe('user-2');
      const done = await proc.next((f) => f.type === 'result');
      expect(done.user_message_uuids).toEqual(['user-1', 'user-2']);
      const completed = await proc.next((f) => f.type === 'command_lifecycle');
      expect(completed.command_uuid).toBe('user-1');
    },
    TIMEOUT,
  );

  test(
    'an interrupt mid-turn ends it with an aborted result, and its cancel_queued flag is logged',
    async () => {
      const recording = claudeRecording({
        turns: [[lifecycle('started'), say('working'), { sleep: 20_000 }, result()], [say('next'), result()]],
      });
      const proc = start(recording);
      await initialize(proc);
      proc.user('go', 'user-1');
      await proc.next((f) => f.type === 'assistant');
      proc.user('queued behind', 'user-2');
      proc.control('int-1', { subtype: 'interrupt', cancel_queued: true });
      expect((await proc.response('int-1')).response.response).toEqual({ still_queued: [], cancelled: ['user-2'] });
      const aborted = await proc.next((f) => f.type === 'result');
      expect(aborted).toMatchObject({
        subtype: 'error_during_execution',
        is_error: true,
        terminal_reason: 'aborted_tools',
        session_id: SESSION,
        user_message_uuids: ['user-1'],
      });
      expect(await proc.next((f) => f.type === 'command_lifecycle')).toMatchObject({
        command_uuid: 'user-1',
        state: 'cancelled',
      });
      // As 2.1.285 ends every turn; the SDK ends its run on it.
      expect(await proc.next((f) => f.type === 'system')).toMatchObject({
        subtype: 'session_state_changed',
        state: 'idle',
        session_id: SESSION,
      });
      const log = await readFakeClaudeLog(proc.log);
      const interrupt = log.find((entry) => entry.kind === 'control' && entry.request.subtype === 'interrupt');
      expect(interrupt).toMatchObject({ request: { subtype: 'interrupt', cancel_queued: true } });
      // The cancelled message never ran: nothing replays until the next message.
      proc.user('after', 'user-3');
      expect((await proc.next((f) => f.type === 'result')).user_message_uuids).toEqual(['user-3']);
    },
    TIMEOUT,
  );

  test(
    'a plain interrupt keeps queued messages, which run next; a recorded $wait interrupt plays the recorded end',
    async () => {
      const recording = claudeRecording({
        turns: [
          [say('working'), { wait: 'interrupt' }, result({ subtype: 'error_during_execution', terminal_reason: 'x' })],
          [say('next'), result()],
        ],
      });
      const proc = start(recording);
      await initialize(proc);
      proc.user('go', 'user-1');
      await proc.next((f) => f.type === 'assistant');
      proc.user('queued behind', 'user-2');
      proc.control('int-1', { subtype: 'interrupt' });
      expect((await proc.response('int-1')).response.response).toEqual({ still_queued: ['user-2'], cancelled: [] });
      expect((await proc.next((f) => f.type === 'result')).terminal_reason).toBe('x');
      expect((await proc.next((f) => f.type === 'result')).user_message_uuids).toEqual(['user-2']);
    },
    TIMEOUT,
  );

  test(
    'a $hook directive calls the callback registered at initialize and logs the answer',
    async () => {
      const recording = claudeRecording({
        turns: [
          [
            {
              hook: {
                event: 'PreToolUse',
                input: { hook_event_name: 'PreToolUse', session_id: '$SESSION', tool_name: 'Bash' },
                toolUseId: 'toolu_1',
              },
            },
            say('after the hook'),
            result(),
          ],
        ],
      });
      const proc = start(recording);
      await initialize(proc, {
        PreToolUse: [{ hookCallbackIds: ['hook_0'] }],
        PostCompact: [{ hookCallbackIds: ['hook_1'] }],
      });
      proc.user('go', 'user-1');
      const request = await proc.next((f) => f.type === 'control_request');
      expect(request.request).toEqual({
        subtype: 'hook_callback',
        callback_id: 'hook_0',
        input: { hook_event_name: 'PreToolUse', session_id: SESSION, tool_name: 'Bash' },
        tool_use_id: 'toolu_1',
      });
      // The replay waits for the answer.
      await Bun.sleep(200);
      expect(proc.frames.some((f) => f.type === 'assistant')).toBe(false);
      const deny = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' } };
      proc.send({
        type: 'control_response',
        response: { subtype: 'success', request_id: request.request_id, response: deny },
      });
      await proc.next((f) => f.type === 'result');
      const log = await readFakeClaudeLog(proc.log);
      expect(log.find((entry) => entry.kind === 'hook_answer')).toMatchObject({
        event: 'PreToolUse',
        callbackId: 'hook_0',
        answer: { subtype: 'success', response: deny },
      });
    },
    TIMEOUT,
  );

  test(
    'it exits 0 on EOF when idle and with a recorded code, and 143 on SIGTERM',
    async () => {
      const idle = start(claudeRecording({ turns: [] }));
      await initialize(idle);
      expect(await idle.end()).toBe(0);

      const exiting = start(claudeRecording({ turns: [[say('bye'), { stderr: 'panic: lost\n' }, { exit: 3 }]] }));
      await initialize(exiting);
      exiting.user('go', 'user-1');
      expect(await exiting.proc.exited).toBe(3);
      expect(exiting.frames.some((f) => f.type === 'assistant')).toBe(true);
      expect(await new Response(exiting.proc.stderr).text()).toBe('panic: lost\n');

      const term = start(claudeRecording({ turns: [] }));
      await initialize(term);
      term.proc.kill('SIGTERM');
      expect(await term.proc.exited).toBe(143);
      expect((await readFakeClaudeLog(term.log)).at(-1)).toMatchObject({ kind: 'exit', code: 143 });
    },
    TIMEOUT,
  );

  test(
    'EOF mid-turn ends the process, unless the recording ignores it; then only a signal ends it',
    async () => {
      const quitting = start(claudeRecording({ turns: [[say('working'), { sleep: 20_000 }, result()]] }));
      await initialize(quitting);
      quitting.user('go', 'user-1');
      await quitting.next((f) => f.type === 'assistant');
      expect(await quitting.end()).toBe(0);
      expect(quitting.frames.some((f) => f.type === 'result')).toBe(false);

      const stubborn = start(claudeRecording({ turns: [[{ ignoreEof: true }, say('working'), { sleep: 20_000 }]] }));
      await initialize(stubborn);
      stubborn.user('go', 'user-1');
      await stubborn.next((f) => f.type === 'assistant');
      stubborn.proc.stdin.end();
      // Bounded: wait for the fake to log the EOF rather than for a fixed time.
      let entries = await readFakeClaudeLog(stubborn.log);
      for (let tries = 0; tries < 200 && !entries.some((entry) => entry.kind === 'eof'); tries += 1) {
        await Bun.sleep(50);
        entries = await readFakeClaudeLog(stubborn.log);
      }
      const eof = entries.find((entry) => entry.kind === 'eof');
      expect(eof).toMatchObject({ kind: 'eof', midTurn: true, ignored: true });
      expect(entries.some((entry) => entry.kind === 'exit')).toBe(false);
      expect(stubborn.proc.exitCode).toBeNull();
      stubborn.proc.kill('SIGTERM');
      expect(await stubborn.proc.exited).toBe(143);

      const finishing = start(
        claudeRecording({ turns: [[{ ignoreEof: true }, say('working'), { sleep: 300 }, result()]] }),
      );
      await initialize(finishing);
      finishing.user('go', 'user-1');
      await finishing.next((f) => f.type === 'assistant');
      expect(await finishing.end()).toBe(0);
      expect(finishing.frames.some((f) => f.type === 'result')).toBe(true);
    },
    TIMEOUT,
  );

  test(
    'it reads --resume and both flag forms, and logs every argv, control request and user message',
    async () => {
      const recording = claudeRecording({ turns: [[init, result()]] });
      const proc = start(recording, ['--resume=aaaaaaaa-0000-4000-8000-000000000000', '--model=claude-opus-5-5']);
      await initialize(proc);
      proc.user('go', 'user-1');
      const done = await proc.next((f) => f.type === 'result');
      expect(done.session_id).toBe('aaaaaaaa-0000-4000-8000-000000000000');
      expect(proc.frames.find((f) => f.type === 'system')).toMatchObject({
        model: 'claude-opus-5-5',
        // No --permission-mode: the recorded one.
        permissionMode: 'acceptEdits',
      });
      await proc.end();
      const log = await readFakeClaudeLog(proc.log);
      expect(log.map((entry) => entry.kind)).toEqual(['argv', 'control', 'user', 'eof', 'exit']);
      expect(log[0]).toMatchObject({
        argv: ['--resume=aaaaaaaa-0000-4000-8000-000000000000', '--model=claude-opus-5-5'],
      });
      // The names of the variables the process got, never their values.
      const names = log[0]?.kind === 'argv' ? log[0].env : [];
      expect(names).toContain('FAKE_CLAUDE_RECORDING');
      expect(JSON.stringify(log[0])).not.toContain(proc.log);
      expect(log[1]).toMatchObject({ requestId: 'init-1', request: { subtype: 'initialize' } });
      expect(log[2]).toMatchObject({ message: { uuid: 'user-1', message: { content: 'go' } } });
    },
    TIMEOUT,
  );

  test(
    'a message with no recorded turn left gets a failed result, and the replay says so in its log',
    async () => {
      const proc = start(claudeRecording({ turns: [] }));
      await initialize(proc);
      proc.user('go', 'user-1');
      const failed = await proc.next((f) => f.type === 'result');
      expect(failed).toMatchObject({ is_error: true, user_message_uuids: ['user-1'] });
      expect((await readFakeClaudeLog(proc.log)).some((entry) => entry.kind === 'note')).toBe(true);
    },
    TIMEOUT,
  );
});

describe('Claude recordings', () => {
  test('claudeRecording builds one from frames, and it survives the JSONL form', () => {
    const recording = claudeRecording({
      startup: [frame({ type: 'system', subtype: 'hook_started' })],
      turns: [[init, { wait: 'user' }, { sleep: 5 }, { ignoreEof: true }, { stderr: 'x' }, { exit: 2 }], [result()]],
      header: { scenario: 'round-trip' },
    });
    expect(recording.header).toEqual({
      cliVersion: '2.1.285',
      source: 'synthesised',
      scenario: 'round-trip',
      account: 'synthetic-subscription',
      model: 'claude-sonnet-5-5',
      permissionMode: 'acceptEdits',
    });
    const text = serializeRecording(recording);
    expect(text.endsWith('\n')).toBe(true);
    expect(text.split('\n')[0]).toBe(JSON.stringify({ $recording: recording.header }));
    expect(parseRecording(text)).toEqual(recording);
  });

  test('loadRecording reads a recording by path, and names the file it could not read', () => {
    const dir = tempDir();
    const path = join(dir, 'turn.jsonl');
    const recording = claudeRecording({ turns: [[result()]] });
    writeRecording(path, recording);
    expect(loadRecording(path)).toEqual(recording);
    expect(() => loadRecording('no-such-recording')).toThrow(/fixtures\/claude\/no-such-recording\.jsonl/);
    writeFileSync(path, '{"type":"result"}\n');
    expect(() => loadRecording(path)).toThrow(/no \$recording header/);
    writeFileSync(path, '{"$recording":{}}\n{"$nonsense":1}\n');
    expect(() => loadRecording(path)).toThrow(/turn\.jsonl:2 is neither a frame nor a directive/);
  });
});
