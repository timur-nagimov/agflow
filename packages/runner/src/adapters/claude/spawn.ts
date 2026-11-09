// The SDK's spawnClaudeCodeProcess hook (design 7.4, 8.2): node:child_process.spawn, because the SDK needs a Node
// ChildProcess, with detached set, so each claude leads its own session and process group, and piped stdio. The SDK
// alone reads stdout; stderr is drained into the attempt's log up to a bound, and its last lines stay in memory for
// error classification. The process is registered before the hook returns, so before the SDK reads any output.
// Whichever way the process is ended (the SDK's forwarded abort, its kill() after close()'s stdin-EOF grace, or the
// session's own signalGroup), the signal reaches the whole group, so a tool the claude started ends with it (7.4).
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { drainToLog, killGroup, type ProcessIdentity, processIdentity } from '../../processes';
import type { ExitInfo } from '../types';

/** The bytes of a claude's stderr that reach the attempt log; the rest is read and dropped after a marker. */
export const CLAUDE_STDERR_LOG_BYTES = 10 * 1024 * 1024;

/** The stderr lines kept in memory for classifying a crash. */
export const CLAUDE_STDERR_TAIL_LINES = 100;

/** The characters of those lines kept at most, an unfinished last line included: a line may never end. */
export const CLAUDE_STDERR_TAIL_CHARS = 64 * 1024;

/** The spawned claude as the SDK and the session see it: a ChildProcess with its stderr tail and its exit. */
export interface SpawnedClaude extends SpawnedProcess {
  /** undefined only when the spawn itself failed; an 'error' event follows. */
  readonly pid: number | undefined;
  /** The last stderr lines, joined with newlines; an unfinished last line included. */
  stderrTail(): string;
  /** Resolves once stderr is read to its end, so stderrTail() holds all of it; a child may hold it open. */
  readonly stderrRead: Promise<void>;
  /** Resolves when the process exits, or with nulls when it never started; inherited pipes never hold it. */
  readonly exited: Promise<ExitInfo>;
  /**
   * Signals the whole process group now, once the leader is still the process that was spawned; nothing after it
   * exited. close() alone would wait out its stdin-EOF grace and then signal the leader only.
   */
  signalGroup(signal: NodeJS.Signals): Promise<void>;
}

export interface DetachedSpawnInput {
  /** AgentLaunch.registerProcess. */
  registerProcess(pid: number): void;
  /** AgentLaunch.logFile. */
  logFile: string;
  /** CLAUDE_STDERR_LOG_BYTES by default. */
  maxLogBytes?: number;
  /** CLAUDE_STDERR_TAIL_LINES by default. */
  tailLines?: number;
  /** CLAUDE_STDERR_TAIL_CHARS by default. */
  tailChars?: number;
  /** Called with each process before the hook returns it, so the session can watch it. */
  onSpawn?(proc: SpawnedClaude): void;
}

export function createDetachedSpawn(input: DetachedSpawnInput): (options: SpawnOptions) => SpawnedClaude {
  const maxLogBytes = input.maxLogBytes ?? CLAUDE_STDERR_LOG_BYTES;
  const tailLines = input.tailLines ?? CLAUDE_STDERR_TAIL_LINES;
  const tailChars = input.tailChars ?? CLAUDE_STDERR_TAIL_CHARS;
  for (const [name, value] of [
    ['maxLogBytes', maxLogBytes],
    ['tailLines', tailLines],
    ['tailChars', tailChars],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a whole number, not ${value}`);
  }

  return (options) => {
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(options.env)) if (value !== undefined) env[name] = value;
    // options.signal is not passed on: spawn() would then kill only the leader, at once.
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // The leader's start time, read while it surely runs; killGroup compares it again before signalling, since a
    // macOS pid can be reused by then.
    const identity: Promise<ProcessIdentity | null> =
      child.pid === undefined ? Promise.resolve(null) : processIdentity(child.pid).catch(() => null);
    let ended = false;
    const signalGroup = async (name: NodeJS.Signals): Promise<void> => {
      try {
        const leader = await identity;
        if (!ended && leader) await killGroup(leader, name);
      } catch {
        // A failed ps or kill leaves the stop ladder's later steps to end the group.
      }
    };
    const abort = () => void signalGroup('SIGTERM');
    const exited = new Promise<ExitInfo>((resolve) => {
      const finish = (code: number | null, signal: NodeJS.Signals | null) => {
        ended = true;
        options.signal.removeEventListener('abort', abort);
        resolve({ code, signal });
      };
      child.once('exit', finish);
      // A spawn that fails emits error and never exit.
      child.on('error', () => {
        if (child.pid === undefined) finish(null, null);
      });
    });

    const tail = new StderrTail(tailLines, tailChars);
    const stderrRead = Promise.withResolvers<void>();
    const leaderKill = child.kill.bind(child);
    const proc = Object.assign(child, {
      exited,
      stderrTail: () => tail.text(),
      stderrRead: stderrRead.promise,
      signalGroup,
      // close() ends stdin and, after its grace, calls kill('SIGTERM'), which would reach the leader alone. While the
      // leader is not reaped, its pid and so its group id cannot have been reused, which is 7.4's identity check.
      kill: (signal: NodeJS.Signals | number = 'SIGTERM'): boolean => {
        if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
          try {
            process.kill(-child.pid, signal);
            // The SDK reads it to tell whether the process was already ended.
            (child as { killed: boolean }).killed = true;
            return true;
          } catch {
            // No group to signal: the leader alone.
          }
        }
        return leaderKill(signal);
      },
    }) as SpawnedClaude;

    try {
      if (child.pid !== undefined) input.registerProcess(child.pid);
      // The log gets the bytes as they came; the tail decodes them, characters split across chunks included.
      const stderr = (async function* () {
        try {
          for await (const chunk of child.stderr) {
            tail.add(chunk as Buffer);
            yield chunk as Buffer;
          }
          tail.end();
        } finally {
          stderrRead.resolve();
        }
      })();
      void drainToLog(stderr, input.logFile, { maxBytes: maxLogBytes }).catch(async () => {
        // Without a log the pipe is still read to its end, so the child never blocks and Bun buffers nothing.
        try {
          for await (const _chunk of stderr) {
            // Only the tail keeps anything.
          }
        } catch {
          // A process killed mid-write may close its pipe with an error.
        }
      });
      options.signal.addEventListener('abort', abort, { once: true });
      if (options.signal.aborted) abort();
      input.onSpawn?.(proc);
    } catch (error) {
      // A claude nobody registered or watches must not run on: its group ends at once. The pid is a child of ours
      // that has not been reaped, so it is still that group's.
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // Already gone.
        }
      }
      throw error;
    }
    return proc;
  };
}

/** The last lines of a stream of bytes, within a budget of characters. */
class StderrTail {
  private readonly decoder = new StringDecoder('utf8');
  private lines: string[] = [];
  private partial = '';

  constructor(
    private readonly max: number,
    private readonly maxChars: number,
  ) {}

  add(chunk: Buffer): void {
    this.push(this.decoder.write(chunk));
  }

  end(): void {
    this.push(this.decoder.end());
  }

  text(): string {
    const lines = this.partial === '' ? this.lines : [...this.lines, this.partial];
    return lines.slice(-this.max).join('\n').slice(-this.maxChars);
  }

  private push(text: string): void {
    if (this.max === 0 || this.maxChars === 0 || text === '') return;
    // Only the last maxChars can be kept, so a line that never ends stays within the budget too.
    const parts = (this.partial + text).slice(-this.maxChars).split('\n');
    this.partial = parts.pop() as string;
    this.lines = this.lines.concat(parts).slice(-this.max);
    let size = this.partial.length + this.lines.reduce((sum, line) => sum + line.length + 1, 0);
    while (size > this.maxChars && this.lines.length > 0) size -= (this.lines.shift() as string).length + 1;
  }
}
