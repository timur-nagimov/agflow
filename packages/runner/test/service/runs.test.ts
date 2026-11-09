import { afterEach, describe, expect, test } from 'bun:test';
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_TIMINGS } from '../../src/config';
import { runnerPaths } from '../../src/paths';
import { CRASH_LOOP_EXITS, crashLoopVerdict, ServiceRuns } from '../../src/service/runs';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'agf-runs-'));
  dirs.push(dir);
  const paths = runnerPaths(dir);
  let time = 1_000_000;
  const runs = new ServiceRuns(paths, { now: () => time });
  return {
    paths,
    runs,
    file: join(paths.logs, 'service-runs.json'),
    now: () => time,
    advance: (ms = 1) => {
      time += ms;
    },
  };
}

describe('ServiceRuns', () => {
  test('starts empty and atomically replaces private, complete JSON without leaving temporary files', () => {
    const { paths, runs, file, advance } = fixture();
    expect(runs.records()).toEqual([]);
    expect(runs.lastExit({ running: false })).toBeNull();
    const id = runs.start({ pid: 123, mode: 'foreground' });
    expect(runs.records()).toEqual([{ id, pid: 123, mode: 'foreground', startedAt: 1_000_000 }]);
    const before = readFileSync(file, 'utf8');
    const fd = openSync(file, 'r');
    try {
      advance();
      runs.finish(id, { clean: true, code: 0, reason: 'suspend' });
      // An already open reader still sees the complete old inode, not an in-place rewrite.
      expect(readFileSync(fd, 'utf8')).toBe(before);
      expect(JSON.parse(readFileSync(file, 'utf8')).runs[0].reason).toBe('suspend');
    } finally {
      closeSync(fd);
    }
    expect(readdirSync(paths.logs)).toEqual(['service-runs.json']);
    expect(statSync(paths.logs).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(new ServiceRuns(paths).lastExit({ running: false })).toEqual({ reason: 'suspend', code: 0, at: 1_000_001, clean: true });
  });

  test('the next start closes an abandoned run at detection time as unclean with an unknown code', () => {
    const f = fixture();
    const abandoned = f.runs.start({ pid: 123, mode: 'service' });
    f.advance(100);
    const reopened = new ServiceRuns(f.paths, { now: f.now });
    const current = reopened.start({ pid: 456, mode: 'foreground' });
    expect(current).not.toBe(abandoned);
    expect(reopened.records()[0]).toMatchObject({
      endedAt: f.now(),
      clean: false,
      code: null,
      reason: 'exited without a clean shutdown',
    });
    expect(crashLoopVerdict(reopened, { now: f.now(), window: 1000 }).unclean).toBe(1);
    reopened.finish(current, { clean: false, code: 1, reason: 'uncaught\nerror' });
    expect(reopened.lastExit({ running: false })).toEqual({ reason: 'uncaught error', code: 1, at: f.now(), clean: false });
  });

  test('invalid JSON and invalid records are empty history and do not prevent a new start', () => {
    const f = fixture();
    mkdirSync(f.paths.logs, { recursive: true });
    const corrupt = [
      '{',
      '{}',
      JSON.stringify({ runs: [{ id: 'bad', pid: '123' }] }),
      JSON.stringify({ runs: [{ id: 'bad', pid: 123, mode: 'service', startedAt: 1, endedAt: 2 }] }),
    ];
    for (const content of corrupt) {
      writeFileSync(f.file, content);
      expect(f.runs.records()).toEqual([]);
      expect(f.runs.lastExit({ running: false })).toBeNull();
      expect(() => f.runs.start({ pid: 123, mode: 'service' })).not.toThrow();
      expect(f.runs.records()).toHaveLength(1);
    }
  });

  test('keeps the newest fifty runs and reports the newest finished one while another is running', () => {
    const f = fixture();
    const ids: string[] = [];
    for (let i = 0; i < 55; i++) {
      ids.push(f.runs.start({ pid: 123, mode: 'service' }));
      f.runs.finish(ids[i]!, { clean: true, code: i % 2, reason: `exit ${i}` });
      f.advance();
    }
    expect(f.runs.records().map((run) => run.id)).toEqual(ids.slice(-50));
    f.runs.start({ pid: 123, mode: 'service' });
    expect(f.runs.records()).toHaveLength(50);
    expect(f.runs.lastExit({ running: true })).toEqual({ reason: 'exit 54', code: 0, at: 1_000_054, clean: true });
  });

  test('while the runner is down, a newest run without an exit record is the last exit, at its start', () => {
    const f = fixture();
    const clean = f.runs.start({ pid: 123, mode: 'service' });
    f.advance();
    f.runs.finish(clean, { clean: true, code: 0, reason: 'suspend' });
    f.advance(100);
    const killed = new ServiceRuns(f.paths, { now: f.now });
    killed.start({ pid: 456, mode: 'foreground' });
    f.advance(100);
    const status = new ServiceRuns(f.paths, { now: f.now });
    expect(status.lastExit({ running: false })).toEqual({
      reason: 'exited without a clean shutdown',
      code: null,
      at: 1_000_101,
      clean: false,
    });
    expect(status.lastExit({ running: true })).toEqual({ reason: 'suspend', code: 0, at: 1_000_001, clean: true });
  });

  test('lastExit and lastError use exit time even after the wall clock steps backward', () => {
    const f = fixture();
    const first = f.runs.start({ pid: 123, mode: 'service' });
    f.runs.finish(first, { clean: false, code: 1, reason: 'newest error' });
    f.advance(-100);
    const second = f.runs.start({ pid: 123, mode: 'service' });
    f.runs.finish(second, { clean: false, code: 2, reason: 'earlier time' });
    expect(f.runs.lastExit({ running: false })).toEqual({ reason: 'newest error', code: 1, at: 1_000_000, clean: false });
    expect(crashLoopVerdict(f.runs, { now: 1_000_000, window: 1000 }).lastError).toBe('newest error');
  });
});

describe('crashLoopVerdict', () => {
  test('requires three unclean exits in (now - window, now], reporting the newest error', () => {
    const f = fixture();
    const window = DEFAULT_TIMINGS.crashLoopWindow;
    expect(CRASH_LOOP_EXITS).toBe(3);
    for (let i = 0; i < 3; i++) {
      const id = f.runs.start({ pid: 123, mode: 'service' });
      f.runs.finish(id, { clean: false, code: 1, reason: `crash ${i}` });
      expect(crashLoopVerdict(f.runs, { now: f.now(), window })).toEqual({
        crashLoop: i === 2,
        unclean: i + 1,
        lastError: `crash ${i}`,
      });
      f.advance();
    }
    expect(crashLoopVerdict(f.runs.records(), { now: 999_999, window }).unclean).toBe(0);
    expect(crashLoopVerdict(f.runs, { now: 1_000_000 + window, window }).unclean).toBe(2);
    f.advance(window);
    expect(crashLoopVerdict(f.runs, { now: f.now(), window })).toEqual({
      crashLoop: false,
      unclean: 0,
      lastError: null,
    });
  });

  test('clean exits, including foreground refusals with code 1, never count as crashes', () => {
    const f = fixture();
    const reasons = ['suspend', 'stop', '4409 replacement', '4403 retired', '4426 incompatible', 'machine mismatch'];
    for (const reason of reasons) {
      const id = f.runs.start({ pid: 123, mode: 'foreground' });
      f.runs.finish(id, { clean: true, code: 1, reason });
    }
    expect(crashLoopVerdict(f.runs, { now: f.now(), window: 1000 })).toEqual({
      crashLoop: false,
      unclean: 0,
      lastError: null,
    });
    expect(f.runs.lastExit({ running: false })?.reason).toBe('machine mismatch');
  });

  test('forgetUnclean persists without deleting history or forgetting later crashes in the same millisecond', () => {
    const f = fixture();
    for (let i = 0; i < 3; i++) {
      const id = f.runs.start({ pid: 123, mode: 'service' });
      f.runs.finish(id, { clean: false, code: 1, reason: `crash ${i}` });
    }
    const last = f.runs.lastExit({ running: false });
    f.runs.forgetUnclean({ at: f.now() - 1 });
    expect(crashLoopVerdict(f.runs, { now: f.now(), window: 1000 }).crashLoop).toBe(true);
    f.runs.forgetUnclean();
    const reopened = new ServiceRuns(f.paths, { now: f.now });
    expect(reopened.lastExit({ running: false })).toEqual(last);
    expect(reopened.records()).toHaveLength(3);
    expect(crashLoopVerdict(reopened, { now: f.now(), window: 1000 }).unclean).toBe(0);
    const id = reopened.start({ pid: 123, mode: 'service' });
    reopened.finish(id, { clean: false, code: 1, reason: 'new crash' });
    expect(reopened.crashLoop()).toBeNull();
    expect(crashLoopVerdict(reopened.records(), { now: f.now(), window: 1000 })).toEqual({
      crashLoop: false,
      unclean: 1,
      lastError: 'new crash',
    });
  });

  test('forgetUnclean also forgets a dead run without an exit record, but never the run of the calling process', () => {
    const f = fixture();
    for (let i = 0; i < 2; i++) {
      const id = f.runs.start({ pid: 123, mode: 'service' });
      f.runs.finish(id, { clean: false, code: 1, reason: `crash ${i}` });
    }
    f.runs.start({ pid: 123, mode: 'service' });
    f.advance();
    // undrain while the runner is down: a new instance under the lock, after a SIGKILLed third run.
    const down = new ServiceRuns(f.paths, { now: f.now });
    down.forgetUnclean();
    expect(down.records().at(-1)).toMatchObject({ reason: 'exited without a clean shutdown', uncleanForgotten: true });
    const next = new ServiceRuns(f.paths, { now: f.now });
    const running = next.start({ pid: 456, mode: 'service' });
    expect(crashLoopVerdict(next, { now: f.now(), window: 1000 }).unclean).toBe(0);
    // undrain inside the running service keeps its own run open, so a later crash still counts.
    next.forgetUnclean();
    expect(next.records().at(-1)).toEqual({ id: running, pid: 456, mode: 'service', startedAt: f.now() });
    f.advance();
    next.finish(running, { clean: false, code: 1, reason: 'later crash' });
    expect(crashLoopVerdict(next, { now: f.now(), window: 1000 })).toMatchObject({
      unclean: 1,
      lastError: 'later crash',
    });
  });

  test('another instance forgetting unclean exits keeps the live run it is told about open', () => {
    const f = fixture();
    const live = f.runs.start({ pid: 123, mode: 'service' });
    f.advance();
    // The undrain handler of the running service, with its own instance.
    new ServiceRuns(f.paths, { now: f.now }).forgetUnclean({ current: live });
    expect(f.runs.records()).toEqual([{ id: live, pid: 123, mode: 'service', startedAt: 1_000_000 }]);
    f.runs.finish(live, { clean: true, code: 0, reason: 'suspend' });
    expect(f.runs.lastExit({ running: false })).toEqual({ reason: 'suspend', code: 0, at: 1_000_001, clean: true });
  });

  test('a recorded crash loop outlives the window and clean runs until forgetUnclean clears it', () => {
    const f = fixture();
    const window = DEFAULT_TIMINGS.crashLoopWindow;
    for (let i = 0; i < 3; i++) {
      const id = f.runs.start({ pid: 123, mode: 'service' });
      f.runs.finish(id, { clean: false, code: 1, reason: `crash ${i}` });
    }
    const guard = f.runs.start({ pid: 123, mode: 'service' });
    const verdict = crashLoopVerdict(f.runs, { now: f.now(), window });
    expect(verdict).toEqual({ crashLoop: true, unclean: 3, lastError: 'crash 2' });
    f.runs.markCrashLoop(verdict);
    f.advance();
    f.runs.finish(guard, { clean: true, code: 0, reason: 'suspend' });
    f.advance(60 * 60 * 1000);
    const later = new ServiceRuns(f.paths, { now: f.now });
    const next = later.start({ pid: 456, mode: 'service' });
    expect(later.crashLoop()).toEqual({ at: 1_000_000, lastError: 'crash 2' });
    expect(crashLoopVerdict(later, { now: f.now(), window })).toEqual({
      crashLoop: true,
      unclean: 0,
      lastError: 'crash 2',
    });
    later.forgetUnclean();
    expect(later.crashLoop()).toBeNull();
    expect(crashLoopVerdict(later, { now: f.now(), window })).toEqual({
      crashLoop: false,
      unclean: 0,
      lastError: null,
    });
    expect(later.records().at(-1)).toEqual({ id: next, pid: 456, mode: 'service', startedAt: f.now() });
  });
});
