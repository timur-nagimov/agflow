import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { claudeRecording, FAKE_CLAUDE_BIN, fakeClaudeEnv } from '@agflow/testkit/src/fake-claude';
import {
  query,
  type SDKMessage,
  type SDKUserMessage,
  type SpawnedProcess,
  type SpawnOptions,
} from '@anthropic-ai/claude-agent-sdk';
import {
  CLAUDE_STDERR_TAIL_CHARS,
  createDetachedSpawn,
  type DetachedSpawnInput,
  type SpawnedClaude,
} from '../../../src/adapters/claude/spawn';
import { listProcesses, processIdentity } from '../../../src/processes';

// macOS's first exec of a new script is slow.
const TIMEOUT = 30_000;
const CHILD = join(import.meta.dir, '..', '..', 'fixtures', 'claude', 'child.ts');

const dirs: string[] = [];
const groups = new Set<number>();
const children: SpawnedClaude[] = [];

afterEach(async () => {
  for (const pgid of groups) {
    try {
      process.kill(-pgid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  groups.clear();
  await Promise.all(children.splice(0).map((proc) => proc.exited));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agflow-claude-spawn-')));
  dirs.push(dir);
  return dir;
}

/** Runs the child fixture in a mode through the hook, as the SDK would. */
function launch(mode: string, input: Partial<DetachedSpawnInput> = {}, options: Partial<SpawnOptions> = {}) {
  const dir = tempDir();
  const logFile = join(dir, 'attempt.log');
  const controller = new AbortController();
  const hook = createDetachedSpawn({
    logFile,
    ...input,
    registerProcess(pid) {
      groups.add(pid);
      input.registerProcess?.(pid);
    },
  });
  const proc = hook({
    command: process.execPath,
    args: [CHILD, mode],
    cwd: dir,
    env: {},
    signal: controller.signal,
    ...options,
  });
  children.push(proc);
  return { proc, controller, logFile };
}

function pidOf(proc: SpawnedClaude): number {
  if (proc.pid === undefined) throw new Error('the child did not start');
  return proc.pid;
}

async function readAll(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the child');
    await Bun.sleep(10);
  }
}

/** Resolves once the process is gone, or a zombie its parent has not reaped yet. */
async function gone(pid: number): Promise<void> {
  await until(async () => {
    const [row] = await listProcesses([pid]);
    return row === undefined || row.stat.startsWith('Z');
  });
}

/** Collects stdout as it comes; firstLine resolves once a whole line is there. */
function watchStdout(proc: SpawnedClaude): { firstLine(): Promise<string> } {
  let text = '';
  proc.stdout.on('data', (chunk: Buffer) => {
    text += chunk.toString('utf8');
  });
  return {
    firstLine: async () => {
      await until(() => text.includes('\n'));
      return text.slice(0, text.indexOf('\n'));
    },
  };
}

describe('the detached spawn hook', () => {
  test(
    'the child leads its own session and process group',
    async () => {
      const { proc } = launch('wait');
      expect(await watchStdout(proc).firstLine()).toBe('ready');
      expect((await processIdentity(pidOf(proc)))?.pgid).toBe(pidOf(proc));
      // ps marks a session leader with s.
      const [row] = await listProcesses([pidOf(proc)]);
      expect(row?.stat).toContain('s');
    },
    TIMEOUT,
  );

  test(
    'registerProcess(pid) and onSpawn are called before the hook returns',
    async () => {
      const order: string[] = [];
      let registered: number | undefined;
      let watched: SpawnedClaude | undefined;
      const { proc } = launch('wait', {
        registerProcess(pid) {
          registered = pid;
          order.push('register');
        },
        onSpawn(child) {
          watched = child;
          order.push('onSpawn');
        },
      });
      order.push('returned');
      expect(order).toEqual(['register', 'onSpawn', 'returned']);
      expect(registered).toBe(pidOf(proc));
      expect(watched).toBe(proc);
    },
    TIMEOUT,
  );

  test(
    'command, args, cwd and env are passed exactly',
    async () => {
      const cwd = tempDir();
      const args = [CHILD, 'inspect', 'two words', '$HOME', '', '雪'];
      const { proc } = launch(
        'inspect',
        {},
        { args, cwd, env: { AGFLOW_VALUE: 'two words', AGFLOW_EMPTY: '', AGFLOW_UNSET: undefined } },
      );
      expect(JSON.parse(await readAll(proc.stdout))).toEqual({
        executable: process.execPath,
        args: args.slice(1),
        cwd,
        // Nothing from the runner's own environment; an undefined value is left out.
        env: { AGFLOW_VALUE: 'two words', AGFLOW_EMPTY: '' },
      });
      expect(await proc.exited).toEqual({ code: 0, signal: null });
    },
    TIMEOUT,
  );

  test(
    'stderr goes to the log up to the bound and is then dropped with a marker; the last lines stay in memory',
    async () => {
      const { proc, logFile } = launch('stderr', { maxLogBytes: 1_000, tailLines: 3 });
      // Two megabytes of stderr do not block the child: it finishes.
      expect(await readAll(proc.stdout)).toBe('done\n');
      expect(await proc.exited).toEqual({ code: 0, signal: null });
      await until(() => proc.stderrTail() === 'last α\nlast β\nlast γ');
      const expected = `${'x'.repeat(1_000)}\n[agflow: output truncated after 1000 bytes]\n`;
      await until(() => {
        try {
          return readFileSync(logFile, 'utf8') === expected;
        } catch {
          return false;
        }
      });
    },
    TIMEOUT,
  );

  test(
    'a stderr line that never ends keeps the tail within its budget of characters',
    async () => {
      const { proc } = launch('longline', { maxLogBytes: 1_000 });
      expect(await readAll(proc.stdout)).toBe('done\n');
      expect(await proc.exited).toEqual({ code: 0, signal: null });
      await until(() => proc.stderrTail().endsWith('the end'));
      const tail = proc.stderrTail();
      expect(tail.length).toBe(CLAUDE_STDERR_TAIL_CHARS);
      expect(tail.endsWith('yyythe end')).toBe(true);
    },
    TIMEOUT,
  );

  test(
    'without a log, stderr is still read to its end and the tail kept',
    async () => {
      const file = join(tempDir(), 'not-a-directory');
      writeFileSync(file, '');
      // Creating the log's directory fails with ENOTDIR.
      const { proc } = launch('stderr', { logFile: join(file, 'attempt.log'), tailLines: 3 });
      expect(await readAll(proc.stdout)).toBe('done\n');
      expect(await proc.exited).toEqual({ code: 0, signal: null });
      await until(() => proc.stderrTail() === 'last α\nlast β\nlast γ');
    },
    TIMEOUT,
  );

  test(
    'exited resolves while an escaped process still holds the inherited pipes',
    async () => {
      const { proc } = launch('heir');
      // Only the first line: the heir keeps stdout open.
      const heir = Number(await watchStdout(proc).firstLine());
      expect(await proc.exited).toEqual({ code: 0, signal: null });
      expect(await processIdentity(heir)).not.toBeNull();
    },
    TIMEOUT,
  );

  test(
    'aborting the forwarded signal sends SIGTERM to the group, a grandchild included',
    async () => {
      const { proc, controller } = launch('group');
      const grandchild = Number(await watchStdout(proc).firstLine());
      expect((await processIdentity(grandchild))?.pgid).toBe(pidOf(proc));
      controller.abort();
      // A SIGTERMed claude exits 143, not by the signal (design 7.4).
      expect(await proc.exited).toEqual({ code: 143, signal: null });
      await until(async () => {
        const [member] = await listProcesses([grandchild]);
        return member === undefined || member.stat.startsWith('Z');
      });
    },
    TIMEOUT,
  );

  test(
    'a signal that was aborted before the spawn ends the group too',
    async () => {
      const controller = new AbortController();
      controller.abort();
      const { proc } = launch('wait', {}, { signal: controller.signal });
      proc.stdout.resume();
      expect(await proc.exited).toEqual({ code: null, signal: 'SIGTERM' });
    },
    TIMEOUT,
  );

  test(
    'once the leader is gone, an abort or kill signals nothing, though its group lives on',
    async () => {
      const { proc, controller } = launch('orphan');
      const grandchild = Number((await readAll(proc.stdout)).trim());
      expect(await proc.exited).toEqual({ code: 0, signal: null });
      const before = await processIdentity(grandchild);
      expect(before?.pgid).toBe(pidOf(proc));
      expect(() => controller.abort()).not.toThrow();
      proc.kill('SIGTERM');
      await Bun.sleep(200);
      expect(await processIdentity(grandchild)).toEqual(before);
    },
    TIMEOUT,
  );

  test(
    'signalGroup signals the whole group at once, without the forwarded signal, and nothing once the leader is gone',
    async () => {
      const { proc } = launch('group');
      const grandchild = Number(await watchStdout(proc).firstLine());
      await proc.signalGroup('SIGTERM');
      expect(await proc.exited).toEqual({ code: 143, signal: null });
      await gone(grandchild);

      const orphan = launch('orphan').proc;
      const heir = Number((await readAll(orphan.stdout)).trim());
      expect(await orphan.exited).toEqual({ code: 0, signal: null });
      const before = await processIdentity(heir);
      await orphan.signalGroup('SIGKILL');
      expect(await processIdentity(heir)).toEqual(before);
    },
    TIMEOUT,
  );

  test(
    'stderrRead resolves once stderr is read to its end: the tail then holds all of it',
    async () => {
      const { proc } = launch('stderr', { tailLines: 3 });
      proc.stdout.resume();
      await proc.exited;
      await proc.stderrRead;
      expect(proc.stderrTail()).toBe('last α\nlast β\nlast γ');
    },
    TIMEOUT,
  );

  test(
    'stderrRead stays pending while an escaped process holds stderr open past the exit',
    async () => {
      const { proc } = launch('heir');
      const heir = Number(await watchStdout(proc).firstLine());
      expect(await proc.exited).toEqual({ code: 0, signal: null });
      let read = false;
      void proc.stderrRead.then(() => {
        read = true;
      });
      await Bun.sleep(200);
      expect(read).toBe(false);
      process.kill(heir, 'SIGKILL');
      await proc.stderrRead;
    },
    TIMEOUT,
  );

  test(
    "the returned object is the SDK's SpawnedProcess: stdin to EOF, stdout, exit events and exitCode",
    async () => {
      const { proc } = launch('echo');
      const sdk: SpawnedProcess = proc;
      const events: unknown[] = [];
      const removed = () => {
        throw new Error('a removed exit listener fired');
      };
      sdk.on('exit', removed);
      sdk.off('exit', removed);
      sdk.on('exit', (code, signal) => events.push(['on', code, signal]));
      sdk.once('exit', (code, signal) => events.push(['once', code, signal]));
      expect(sdk.killed).toBe(false);
      expect(sdk.exitCode).toBeNull();
      expect(sdk.signalCode).toBeNull();
      const text = readAll(sdk.stdout);
      sdk.stdin.write('input from the SDK\n');
      sdk.stdin.end('EOF');
      expect(await text).toBe('input from the SDK\nEOF');
      expect(await proc.exited).toEqual({ code: 23, signal: null });
      expect(sdk.exitCode).toBe(23);
      expect(sdk.signalCode).toBeNull();
      expect(events).toEqual([
        ['on', 23, null],
        ['once', 23, null],
      ]);
    },
    TIMEOUT,
  );

  test(
    'kill signals the whole group while the leader runs',
    async () => {
      const { proc } = launch('group');
      const grandchild = Number(await watchStdout(proc).firstLine());
      expect(proc.kill('SIGTERM')).toBe(true);
      expect(proc.killed).toBe(true);
      expect(await proc.exited).toEqual({ code: 143, signal: null });
      await gone(grandchild);
    },
    TIMEOUT,
  );

  test(
    'a registration that throws ends the new process and rethrows',
    async () => {
      let spawned: number | undefined;
      const hook = createDetachedSpawn({
        logFile: join(tempDir(), 'attempt.log'),
        registerProcess(pid) {
          spawned = pid;
          groups.add(pid);
          throw new Error('the agent of T-1-a1 was already registered');
        },
      });
      expect(() =>
        hook({
          command: process.execPath,
          args: [CHILD, 'wait'],
          cwd: tempDir(),
          env: {},
          signal: new AbortController().signal,
        }),
      ).toThrow('already registered');
      if (spawned === undefined) throw new Error('nothing was spawned');
      await gone(spawned);
    },
    TIMEOUT,
  );

  test(
    'kill signals the leader, and signalCode reports it',
    async () => {
      const { proc } = launch('wait');
      expect(await watchStdout(proc).firstLine()).toBe('ready');
      expect(proc.kill('SIGKILL')).toBe(true);
      expect(proc.killed).toBe(true);
      expect(await proc.exited).toEqual({ code: null, signal: 'SIGKILL' });
      expect(proc.exitCode).toBeNull();
      expect(proc.signalCode).toBe('SIGKILL');
    },
    TIMEOUT,
  );

  test(
    'a missing command emits error, registers nothing and does not throw',
    async () => {
      const registered: number[] = [];
      const { proc } = launch(
        'wait',
        { registerProcess: (pid) => registered.push(pid) },
        { command: join(tempDir(), 'missing-command') },
      );
      const error = await new Promise<Error>((resolve) => proc.once('error', resolve));
      expect((error as NodeJS.ErrnoException).code).toBe('ENOENT');
      expect(proc.pid).toBeUndefined();
      expect(registered).toEqual([]);
      expect(await proc.exited).toEqual({ code: null, signal: null });
    },
    TIMEOUT,
  );

  test(
    'through the real SDK, a session starts, runs a turn and ends on close() with the hook',
    async () => {
      const dir = tempDir();
      const recording = claudeRecording({
        turns: [
          [
            { frame: { type: 'system', subtype: 'init', session_id: '$SESSION', cwd: '$CWD', model: '$MODEL' } },
            { frame: { type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: '$SESSION' } },
          ],
        ],
      });
      const registered: number[] = [];
      let spawned: SpawnedClaude | undefined;
      const hook = createDetachedSpawn({
        logFile: join(dir, 'attempt.log'),
        registerProcess: (pid) => {
          groups.add(pid);
          registered.push(pid);
        },
        onSpawn: (proc) => {
          spawned = proc;
        },
      });
      const message: SDKUserMessage = {
        type: 'user',
        message: { role: 'user', content: 'go' },
        parent_tool_use_id: null,
        uuid: 'aaaaaaaa-0000-4000-8000-000000000001',
      };
      const q = query({
        prompt: (async function* () {
          yield message;
          // A finite input would close stdin and end the session; this one stays open until close().
          await new Promise(() => {});
        })(),
        options: {
          pathToClaudeCodeExecutable: FAKE_CLAUDE_BIN,
          spawnClaudeCodeProcess: hook,
          cwd: dir,
          env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...fakeClaudeEnv({ recording, dir }) },
          model: 'claude-sonnet-5-5',
        },
      });
      await q.initializationResult();
      const seen: SDKMessage[] = [];
      for await (const frame of q) {
        seen.push(frame);
        if (frame.type === 'result') break;
      }
      expect(seen.find((frame) => frame.type === 'result')).toMatchObject({ subtype: 'success', result: 'ok' });
      if (spawned === undefined) throw new Error('the SDK did not use the hook');
      children.push(spawned);
      expect(registered).toEqual([pidOf(spawned)]);
      q.close();
      // close() ends stdin; the fake exits 0 on EOF while idle.
      expect(await spawned.exited).toEqual({ code: 0, signal: null });
    },
    TIMEOUT,
  );

  test(
    "through the real SDK, close() on a claude that ignores stdin EOF SIGTERMs its group after the SDK's grace",
    async () => {
      const dir = tempDir();
      const pidFile = join(dir, 'grandchild.pid');
      let spawned: SpawnedClaude | undefined;
      const hook = createDetachedSpawn({
        logFile: join(dir, 'attempt.log'),
        registerProcess: (pid) => groups.add(pid),
        onSpawn: (proc) => {
          spawned = proc;
          children.push(proc);
        },
      });
      const q = query({
        prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
          await new Promise(() => {});
        })(),
        options: {
          pathToClaudeCodeExecutable: FAKE_CLAUDE_BIN,
          // The SDK's command is replaced by the stand-in, which never answers it.
          spawnClaudeCodeProcess: (options) =>
            hook({ ...options, command: process.execPath, args: [CHILD, 'stubborn', pidFile] }),
          cwd: dir,
          env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
        },
      });
      q.initializationResult().catch(() => {});
      await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8') !== '');
      const grandchild = Number(readFileSync(pidFile, 'utf8'));
      if (spawned === undefined) throw new Error('the SDK did not use the hook');
      q.close();
      expect(await spawned.exited).toEqual({ code: 143, signal: null });
      await gone(grandchild);
    },
    TIMEOUT,
  );
});
