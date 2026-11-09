// The service's Logger (X-7): synchronous writes leave the last messages available after a crash.
import {
  appendFileSync,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { LogFields, Logger, LogLevel } from '../log';
import type { RunnerPaths } from '../paths';

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

export interface RotatingLogOptions {
  foreground: boolean;
  maxBytes?: number;
  keep?: number;
  now?: () => number;
  /** Receives a complete line including its newline. All levels default to stderr. */
  terminal?: (line: string) => void;
}

function fieldsJson(fields: LogFields): string {
  try {
    if (Object.keys(fields).length === 0) return '';
    const seen = new WeakSet<object>();
    const json = JSON.stringify(fields, (_key, value: unknown) => {
      if (value instanceof Error) return value.message;
      if (typeof value === 'bigint') return value.toString();
      if (value && typeof value === 'object') {
        if (seen.has(value)) return '[Circular]';
        seen.add(value);
      }
      return value;
    });
    return ` ${json ?? '{"serializationError":"unserializable fields"}'}`;
  } catch {
    // Getters and toJSON can throw too; never let diagnostic data take down the runner.
    return ' {"serializationError":"unserializable fields"}';
  }
}

/** runner.log with size-based rotation, teed to the terminal in the foreground; launchd rotates nothing (7.1). */
export class RotatingLog implements Logger {
  private readonly maxBytes: number;
  private readonly keep: number;
  private readonly now: () => number;
  private readonly terminal: (line: string) => void;

  constructor(
    private readonly paths: RunnerPaths,
    private readonly options: RotatingLogOptions,
  ) {
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.keep = options.keep ?? 5;
    this.now = options.now ?? Date.now;
    this.terminal =
      options.terminal ??
      ((line) => {
        process.stderr.write(line);
      });
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes <= 0) throw new Error('log maxBytes must be positive');
    if (!Number.isSafeInteger(this.keep) || this.keep < 0) throw new Error('log keep must be nonnegative');
  }

  debug(message: string, fields?: LogFields): void {
    this.write('debug', message, fields);
  }

  info(message: string, fields?: LogFields): void {
    this.write('info', message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.write('warn', message, fields);
  }

  error(message: string, fields?: LogFields): void {
    this.write('error', message, fields);
  }

  private tee(line: string): void {
    if (!this.options.foreground) return;
    try {
      this.terminal(line);
    } catch {
      // A broken terminal must not stop file logging.
    }
  }

  private write(level: LogLevel, message: string, fields?: LogFields): void {
    try {
      const text = message.replace(/\r/g, '\\r').replace(/\n/g, '\\n');
      const line = `${new Date(this.now()).toISOString()} ${level} ${text}${fields ? fieldsJson(fields) : ''}\n`;
      this.tee(line);
      mkdirSync(this.paths.logs, { recursive: true, mode: 0o700 });
      let size = 0;
      try {
        size = statSync(this.paths.runnerLog).size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      // An oversized entry is written whole; don't rotate an empty file before it.
      if (size > 0 && size + Buffer.byteLength(line) > this.maxBytes) this.rotate();
      appendFileSync(this.paths.runnerLog, line, { mode: 0o600 });
    } catch {
      this.tee('agflow: could not write runner log\n');
    }
  }

  private rotate(): void {
    const path = this.paths.runnerLog;
    if (this.keep === 0) {
      rmSync(path, { force: true });
      return;
    }
    rmSync(`${path}.${this.keep}`, { force: true });
    for (let i = this.keep - 1; i >= 0; i--) {
      try {
        renameSync(i === 0 ? path : `${path}.${i}`, `${path}.${i + 1}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
}

function fileTail(path: string, count: number): string[] {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  try {
    let position = fstatSync(fd).size;
    let newlines = 0;
    const chunks: Buffer[] = [];
    while (position > 0 && newlines <= count) {
      const length = Math.min(position, 4096);
      position -= length;
      const buffer = Buffer.alloc(length);
      const bytes = readSync(fd, buffer, 0, length, position);
      const chunk = buffer.subarray(0, bytes);
      chunks.push(chunk);
      for (const byte of chunk) if (byte === 10) newlines++;
    }
    // Decode after joining: a multibyte character can straddle a read boundary.
    const text = Buffer.concat(chunks.reverse()).toString('utf8');
    if (!text) return [];
    const lines = text.split('\n');
    if (lines.at(-1) === '') lines.pop();
    return lines.slice(-count);
  } finally {
    closeSync(fd);
  }
}

/** Best-effort status reads need no lock; rotations may disappear while we read them. */
export function tailLines(paths: RunnerPaths | string, count = 20): string[] {
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('tail count must be nonnegative');
  if (count === 0) return [];
  const path = typeof paths === 'string' ? paths : paths.runnerLog;
  let lines = fileTail(path, count);
  if (lines.length >= count) return lines;
  let names: string[];
  try {
    names = readdirSync(dirname(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return lines;
    throw error;
  }
  const prefix = `${basename(path)}.`;
  const rotations = names
    .filter((name) => name.startsWith(prefix) && /^[1-9][0-9]*$/.test(name.slice(prefix.length)))
    .sort((a, b) => Number(a.slice(prefix.length)) - Number(b.slice(prefix.length)));
  for (const name of rotations) {
    lines = [...fileTail(join(dirname(path), name), count - lines.length), ...lines];
    if (lines.length >= count) break;
  }
  return lines;
}

/** The plist's StandardOutPath and StandardErrorPath. */
export function launchdLogPaths(paths: RunnerPaths): { stdout: string; stderr: string } {
  return { stdout: join(paths.logs, 'launchd.out.log'), stderr: join(paths.logs, 'launchd.err.log') };
}

/** Keep launchd's open O_APPEND descriptors valid: truncate in place, never rotate these files. */
export function trimLaunchdLogs(paths: RunnerPaths, limitBytes = DEFAULT_MAX_BYTES): string[] {
  if (!Number.isSafeInteger(limitBytes) || limitBytes < 0) throw new Error('launchd log limit must be nonnegative');
  const trimmed: string[] = [];
  for (const path of Object.values(launchdLogPaths(paths))) {
    try {
      if (statSync(path).size > limitBytes) {
        truncateSync(path, 0);
        trimmed.push(path);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return trimmed;
}
