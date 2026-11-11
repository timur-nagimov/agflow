import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentRole, AttemptPhase } from '@agflow/core';
import type { ClockSource } from '../../src/clock';
import { memoryLogger } from '../../src/log';
import { KeepAwake, type KeepAwakeAttempt, type KeepAwakeMode, wantsKeepAwake } from '../../src/ops/keep-awake';
import type { PowerSample } from '../../src/ops/power';
import { waitFor } from '../fixture';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const power = (source: PowerSample['source']): PowerSample => ({
  source,
  batteryPercent: 50,
  lowPowerMode: false,
});

function fakeClock() {
  let now = 0;
  const timers = new Map<unknown, { at: number; fn: () => void }>();
  const clock: ClockSource = {
    now: () => now,
    setTimeout(fn, ms) {
      const handle = {};
      timers.set(handle, { at: now + ms, fn });
      return handle;
    },
    clearTimeout: (handle) => {
      timers.delete(handle);
    },
    setInterval: () => {
      throw new Error('unexpected interval');
    },
    clearInterval: () => {
      throw new Error('unexpected interval');
    },
  };
  return {
    clock,
    pending: () => timers.size,
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].fn();
      }
      now = end;
    },
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function fixture(exits = false, overrides: Partial<ConstructorParameters<typeof KeepAwake>[0]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'agflow-keep-awake-'));
  const command = join(dir, 'caffeinate');
  const record = join(dir, 'calls');
  const exitFlag = join(dir, 'exit');
  if (exits) writeFileSync(exitFlag, '');
  writeFileSync(
    command,
    `#!/bin/sh
printf '%s %s %s %s\\n' "$$" "$1" "$2" "$3" >> '${record}'
if [ -f '${exitFlag}' ]; then exit 0; fi
while kill -0 "$3" 2>/dev/null; do sleep 0.01; done
`,
    { mode: 0o755 },
  );
  const calls = () =>
    existsSync(record)
      ? readFileSync(record, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const [pid, ...argv] = line.split(' ');
            return { pid: Number(pid), argv };
          })
      : [];
  const state = {
    mode: 'ac' as KeepAwakeMode,
    power: power('ac') as PowerSample | null,
    attempts: [{ role: 'worker', phase: 'turn' }] as KeepAwakeAttempt[],
  };
  const time = fakeClock();
  const logger = memoryLogger();
  const keep = new KeepAwake({
    mode: () => state.mode,
    power: () => state.power,
    attempts: () => state.attempts,
    command,
    platform: 'linux',
    aliveCheckMs: 20,
    retryBaseMs: 30,
    retryCapMs: 100,
    clock: time.clock,
    logger,
    ...overrides,
  });
  cleanups.push(async () => {
    const closing = keep.close();
    for (const { pid } of calls()) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* Already reaped. */
      }
    }
    await closing;
    rmSync(dir, { recursive: true, force: true });
  });
  return { keep, state, time, logger, calls, exitFlag };
}

describe('wantsKeepAwake', () => {
  test('covers every phase, role, mode and power source', () => {
    const phases: (AttemptPhase | null)[] = [
      'starting',
      'preparing',
      'turn',
      'waiting_approval',
      'quota_wait',
      'idle',
      'vendor_error',
      'stopping',
      null,
    ];
    for (const mode of ['off', 'ac', 'always'] as const) {
      for (const sample of [power('ac'), power('battery'), power('unknown'), null]) {
        expect(wantsKeepAwake({ mode, power: sample, attempts: [] })).toBe(false);
        for (const role of ['worker', 'lead'] as AgentRole[]) {
          for (const phase of phases) {
            const active = phase !== null && !(role === 'lead' && phase === 'idle');
            const expected =
              mode !== 'off' && phase !== null && (sample?.source === 'ac' || (mode === 'always' && active));
            expect(
              wantsKeepAwake({
                mode,
                power: sample,
                attempts: [{ role, phase }],
              }),
            ).toBe(expected);
          }
        }
      }
    }
    expect(
      wantsKeepAwake({
        mode: 'always',
        power: null,
        attempts: [
          { role: 'lead', phase: 'idle' },
          { role: 'worker', phase: 'turn' },
        ],
      }),
    ).toBe(true);
  });
});

describe('KeepAwake', () => {
  test('two attempts share one process with the runner pid until the last ends', async () => {
    const f = fixture();
    f.state.attempts.push({ role: 'worker', phase: 'starting' });
    expect(f.keep.isHeld()).toBe(false);
    f.keep.evaluate();
    await waitFor(() => f.calls().length === 1);
    const first = f.calls()[0];
    expect(first.argv).toEqual(['-i', '-w', String(process.pid)]);
    // In the runner's own process group (7.9), so the assertion goes with the runner's group.
    const pgid = (pid: number) => Bun.spawnSync(['ps', '-o', 'pgid=', '-p', String(pid)]).stdout.toString().trim();
    expect(pgid(first.pid)).toBe(pgid(process.pid));
    f.time.advance(20);
    expect(f.keep.isHeld()).toBe(true);
    f.state.attempts[0].phase = null;
    for (let i = 0; i < 10; i++) f.keep.evaluate();
    expect(f.calls()).toHaveLength(1);
    expect(alive(first.pid)).toBe(true);
    f.state.attempts[1].phase = null;
    f.keep.evaluate();
    expect(f.keep.isHeld()).toBe(false);
    await waitFor(() => !alive(first.pid));
    expect(f.logger.entries.filter((entry) => entry.level === 'info').map((entry) => entry.fields.pid)).toEqual([
      first.pid,
      first.pid,
    ]);
    expect(f.time.pending()).toBe(0);
  });

  test('an outside kill after the alive check restarts immediately', async () => {
    const f = fixture();
    f.keep.evaluate();
    await waitFor(() => f.calls().length === 1);
    f.time.advance(20);
    process.kill(f.calls()[0].pid, 'SIGKILL');
    await waitFor(() => f.calls().length === 2);
    expect(f.calls()[1].pid).not.toBe(f.calls()[0].pid);
    expect(f.keep.isHeld()).toBe(true);
    expect(f.logger.entries.some((entry) => entry.level === 'warn' && entry.fields.pid === f.calls()[0].pid)).toBe(
      true,
    );
  });

  test('immediate exits warn with code 0, back off to the cap, and cancel when attempts end', async () => {
    const f = fixture(true);
    f.keep.evaluate();
    for (const [index, delay] of [30, 60, 100, 100].entries()) {
      await waitFor(() => f.logger.entries.filter((entry) => entry.level === 'warn').length === index + 1);
      expect(f.keep.isHeld()).toBe(false);
      expect(f.logger.entries.filter((entry) => entry.level === 'warn')[index].fields.exitCode).toBe(0);
      for (let i = 0; i < 10; i++) f.keep.evaluate();
      f.time.advance(delay - 1);
      expect(f.calls()).toHaveLength(index + 1);
      f.time.advance(1);
      await waitFor(() => f.calls().length === index + 2);
    }
    await waitFor(() => f.logger.entries.filter((entry) => entry.level === 'warn').length === 5);
    f.state.attempts[0].phase = null;
    f.keep.evaluate();
    expect(f.time.pending()).toBe(0);
    f.time.advance(10_000);
    expect(f.calls()).toHaveLength(5);
  });

  test('passing the alive check resets backoff for the next immediate exit', async () => {
    const f = fixture(true);
    f.keep.evaluate();
    await waitFor(() => f.logger.entries.some((entry) => entry.level === 'warn'));
    rmSync(f.exitFlag);
    f.time.advance(30);
    await waitFor(() => f.calls().length === 2);
    f.time.advance(20);
    writeFileSync(f.exitFlag, '');
    process.kill(f.calls()[1].pid, 'SIGKILL');
    await waitFor(() => f.logger.entries.filter((entry) => entry.level === 'warn').length === 3);
    f.time.advance(29);
    expect(f.calls()).toHaveLength(3);
    f.time.advance(1);
    await waitFor(() => f.calls().length === 4);
  });

  test('settings and power changes apply at evaluation, including rapid off/on', async () => {
    const f = fixture();
    f.keep.evaluate();
    await waitFor(() => f.calls().length === 1);
    f.state.mode = 'off';
    f.keep.evaluate();
    expect(f.keep.isHeld()).toBe(false);
    f.state.mode = 'always';
    f.keep.evaluate();
    await waitFor(() => f.calls().length === 2 && f.keep.isHeld());
    expect(alive(f.calls()[0].pid)).toBe(false);
    f.state.mode = 'ac';
    f.state.power = power('battery');
    f.keep.evaluate();
    expect(f.keep.isHeld()).toBe(false);
    await waitFor(() => !alive(f.calls()[1].pid));
    f.state.power = power('ac');
    f.keep.evaluate();
    await waitFor(() => f.calls().length === 3 && f.keep.isHeld());
  });

  test('close releases, cancels the alive check, and permanently disables evaluate', async () => {
    const f = fixture();
    f.keep.evaluate();
    await waitFor(() => f.calls().length === 1);
    await Promise.all([f.keep.close(), f.keep.close()]);
    expect(alive(f.calls()[0].pid)).toBe(false);
    expect(f.keep.isHeld()).toBe(false);
    expect(f.time.pending()).toBe(0);
    f.keep.evaluate();
    f.time.advance(10_000);
    expect(f.calls()).toHaveLength(1);
  });

  test('spawn failures back off without throwing, and close cancels retries', async () => {
    const f = fixture(false, { command: '/nonexistent/agflow-caffeinate' });
    expect(() => f.keep.evaluate()).not.toThrow();
    expect(f.keep.isHeld()).toBe(false);
    expect(f.logger.entries.filter((entry) => entry.level === 'warn')).toHaveLength(1);
    f.time.advance(29);
    f.keep.evaluate();
    expect(f.logger.entries.filter((entry) => entry.level === 'warn')).toHaveLength(1);
    f.time.advance(1);
    expect(f.logger.entries.filter((entry) => entry.level === 'warn')).toHaveLength(2);
    await f.keep.close();
    expect(f.time.pending()).toBe(0);
    f.time.advance(10_000);
    expect(f.logger.entries.filter((entry) => entry.level === 'warn')).toHaveLength(2);
  });

  test('off macOS the default command never spawns', async () => {
    const f = fixture(false, { command: undefined, platform: 'linux' });
    f.keep.evaluate();
    expect(f.keep.isHeld()).toBe(false);
    expect(f.time.pending()).toBe(0);
    expect(f.logger.entries).toEqual([]);
  });

  test('source and logger exceptions cannot escape evaluate', () => {
    const fail = () => {
      throw new Error('host callback failed');
    };
    const f = fixture(false, {
      mode: fail,
      logger: { debug: fail, info: fail, warn: fail, error: fail },
    });
    expect(() => f.keep.evaluate()).not.toThrow();
    expect(f.keep.isHeld()).toBe(false);
  });

  test.skipIf(process.platform !== 'darwin')('real caffeinate survives its check and close ends it', async () => {
    const f = fixture(false, { command: undefined, platform: 'darwin' });
    f.keep.evaluate();
    const pid = f.logger.entries.find((entry) => entry.level === 'info')?.fields.pid as number;
    expect(pid).toBeGreaterThan(0);
    // Give the real command time to reject a bad watch pid before driving the check.
    await Bun.sleep(100);
    f.time.advance(20);
    expect(alive(pid)).toBe(true);
    expect(f.keep.isHeld()).toBe(true);
    await f.keep.close();
    expect(alive(pid)).toBe(false);
  });
});
