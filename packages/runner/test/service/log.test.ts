import { afterEach, describe, expect, test } from 'bun:test';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '../../src/log';
import { runnerPaths } from '../../src/paths';
import { launchdLogPaths, RotatingLog, tailLines, trimLaunchdLogs } from '../../src/service/log';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'agf-log-'));
  dirs.push(dir);
  return runnerPaths(dir);
}
const now = () => Date.parse('2026-10-28T12:00:00.000Z');

describe('RotatingLog', () => {
  test('implements Logger, writes private synchronous lines and tees only in the foreground', () => {
    const paths = scratch();
    const terminal: string[] = [];
    const logger: Logger = new RotatingLog(paths, { foreground: true, now, terminal: (line) => terminal.push(line) });
    logger.debug('debug');
    logger.info('ready', { pid: 42 });
    logger.warn('warning');
    logger.error('failure');
    const lines = readFileSync(paths.runnerLog, 'utf8').trimEnd().split('\n');
    expect(lines).toEqual([
      '2026-10-28T12:00:00.000Z debug debug',
      '2026-10-28T12:00:00.000Z info ready {"pid":42}',
      '2026-10-28T12:00:00.000Z warn warning',
      '2026-10-28T12:00:00.000Z error failure',
    ]);
    expect(terminal).toEqual(lines.map((line) => `${line}\n`));
    expect(statSync(paths.logs).mode & 0o777).toBe(0o700);
    expect(statSync(paths.runnerLog).mode & 0o777).toBe(0o600);
    new RotatingLog(paths, { foreground: false, now, terminal: (line) => terminal.push(line) }).info('service');
    expect(terminal).toHaveLength(4);
    expect(tailLines(paths, 1)[0]).toEndWith('info service');
  });

  test('rotates by bytes only above the limit, reopens at the existing size and keeps five older files', () => {
    const paths = scratch();
    const line = '2026-10-28T12:00:00.000Z info é\n';
    const options = { foreground: false, now, maxBytes: Buffer.byteLength(line) * 2 };
    const log = new RotatingLog(paths, options);
    log.info('é');
    log.info('é');
    expect(existsSync(`${paths.runnerLog}.1`)).toBe(false);
    const reopened = new RotatingLog(paths, options);
    reopened.info('new');
    expect(readFileSync(`${paths.runnerLog}.1`, 'utf8')).toBe(line.repeat(2));
    for (let i = 0; i < 7; i++) reopened.info(`oversized ${i} ${'x'.repeat(100)}`);
    expect(readFileSync(paths.runnerLog, 'utf8')).toContain('oversized 6');
    for (let i = 1; i <= 5; i++) {
      expect(readFileSync(`${paths.runnerLog}.${i}`, 'utf8')).toContain(`oversized ${6 - i}`);
    }
    expect(existsSync(`${paths.runnerLog}.6`)).toBe(false);
  });

  test('supports an injected keep count including zero', () => {
    const paths = scratch();
    const log = new RotatingLog(paths, { foreground: false, now, maxBytes: 1, keep: 1 });
    log.info('first');
    expect(existsSync(`${paths.runnerLog}.1`)).toBe(false);
    log.info('second');
    log.info('third');
    expect(tailLines(paths)).toHaveLength(2);
    expect(existsSync(`${paths.runnerLog}.2`)).toBe(false);
    const none = scratch();
    const noHistory = new RotatingLog(none, { foreground: false, maxBytes: 1, keep: 0 });
    noHistory.info('first');
    noHistory.info('second');
    expect(existsSync(`${none.runnerLog}.1`)).toBe(false);
    expect(tailLines(none)).toHaveLength(1);
  });

  test('an oversized first entry in an empty or missing runner.log does not shift the older files', () => {
    for (const empty of [true, false]) {
      const paths = scratch();
      mkdirSync(paths.logs, { recursive: true });
      writeFileSync(`${paths.runnerLog}.1`, 'older\n');
      if (empty) writeFileSync(paths.runnerLog, '');
      new RotatingLog(paths, { foreground: false, now, maxBytes: 10 }).info('an entry longer than the limit');
      expect(readFileSync(`${paths.runnerLog}.1`, 'utf8')).toBe('older\n');
      expect(existsSync(`${paths.runnerLog}.2`)).toBe(false);
      expect(tailLines(paths, 1)).toEqual(['2026-10-28T12:00:00.000Z info an entry longer than the limit']);
    }
  });

    test('serializes rich fields and keeps multiline messages on one line; hostile fields never throw', () => {
    const paths = scratch();
    const log = new RotatingLog(paths, { foreground: false, now });
    log.info('one\ntwo\rthree', { nested: { error: new Error('bad'), big: 12n, absent: undefined } });
    const lines = tailLines(paths);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('one\\ntwo\\rthree');
    expect(lines[0]).toContain('"error":"bad"');
    expect(lines[0]).toContain('"big":"12"');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const throwingGetter = {
      get broken() {
        throw new Error('getter');
      },
    };
    const throwingJson = {
      bad: {
        toJSON() {
          throw new Error('json');
        },
      },
    };
    for (const fields of [circular, throwingGetter, throwingJson, { toJSON: () => undefined }]) {
      expect(() => log.error('still logged', fields)).not.toThrow();
    }
    expect(tailLines(paths)).toHaveLength(5);
    expect(tailLines(paths, 1)[0]).toEndWith('{"serializationError":"unserializable fields"}');
  });

  test('write failures and throwing terminal writers cannot escape a log call', () => {
    const paths = scratch();
    mkdirSync(paths.logs, { recursive: true });
    mkdirSync(paths.runnerLog);
    const terminal: string[] = [];
    const log = new RotatingLog(paths, { foreground: true, terminal: (line) => terminal.push(line) });
    expect(() => log.error('disk failure')).not.toThrow();
    expect(terminal.join('')).toContain('disk failure');
    expect(terminal.join('')).toContain('could not write runner log');
    const broken = new RotatingLog(scratch(), {
      foreground: true,
      terminal: () => {
        throw new Error('terminal');
      },
    });
    expect(() => broken.info('survives')).not.toThrow();
    const silent: string[] = [];
    const quiet = new RotatingLog(paths, { foreground: false, terminal: (line) => silent.push(line) });
    expect(() => quiet.error('failed')).not.toThrow();
    expect(silent).toEqual([]);
  });
});

describe('tailLines', () => {
  test('returns the last twenty oldest first across rotations, and handles missing and partial files', () => {
    const paths = scratch();
    expect(tailLines(paths)).toEqual([]);
    mkdirSync(paths.logs, { recursive: true });
    writeFileSync(`${paths.runnerLog}.2`, 'old\n');
    writeFileSync(`${paths.runnerLog}.1`, Array.from({ length: 25 }, (_, i) => `line ${i}\n`).join(''));
    writeFileSync(paths.runnerLog, 'line 25\nline 26\n');
    expect(tailLines(paths)).toEqual(Array.from({ length: 20 }, (_, i) => `line ${i + 7}`));
    expect(tailLines(paths.runnerLog, 30)).toHaveLength(28);
    expect(tailLines(paths, 0)).toEqual([]);
    // 10007 bytes: the 4096-byte reads start at odd offsets, inside a two-byte 'é'.
    writeFileSync(paths.runnerLog, `${'é'.repeat(5000)}\n\nlast!`);
    expect(tailLines(paths, 3)).toEqual(['é'.repeat(5000), '', 'last!']);
    rmSync(paths.runnerLog);
    expect(tailLines(paths, 1)).toEqual(['line 24']);
  });
});

describe('trimLaunchdLogs', () => {
  test('truncates only oversized files in place, preserving an open append descriptor', () => {
    const paths = scratch();
    const logs = launchdLogPaths(paths);
    expect(logs).toEqual({ stdout: join(paths.logs, 'launchd.out.log'), stderr: join(paths.logs, 'launchd.err.log') });
    expect(trimLaunchdLogs(paths, 10)).toEqual([]);
    mkdirSync(paths.logs, { recursive: true });
    writeFileSync(logs.stdout, 'x'.repeat(11));
    writeFileSync(logs.stderr, 'x'.repeat(10));
    const inode = statSync(logs.stdout).ino;
    const fd = openSync(logs.stdout, 'a');
    try {
      expect(trimLaunchdLogs(paths, 10)).toEqual([logs.stdout]);
      expect(statSync(logs.stdout).ino).toBe(inode);
      expect(statSync(logs.stdout).size).toBe(0);
      expect(statSync(logs.stderr).size).toBe(10);
      writeSync(fd, 'new');
      expect(readFileSync(logs.stdout, 'utf8')).toBe('new');
      writeFileSync(logs.stderr, 'x'.repeat(12));
      expect(trimLaunchdLogs(paths, 10)).toEqual([logs.stderr]);
    } finally {
      closeSync(fd);
    }
  });
});
