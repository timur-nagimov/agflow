import { afterEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AttemptSpec, START_REFUSALS } from '@agflow/core';
import type { ClockSource } from '../../src/clock';
import { DEFAULT_TIMINGS } from '../../src/config';
import { memoryLogger } from '../../src/log';
import {
  admissionDecision,
  BATTERY_STOP_PERCENT,
  createServiceHealth,
  GB,
  type ServiceHealthOptions,
} from '../../src/ops/health';
import type { PowerSample } from '../../src/ops/power';
import { runnerPaths } from '../../src/paths';
import { cleanupRunnerFixtures, createRunnerFixture, waitFor } from '../fixture';

afterEach(cleanupRunnerFixtures);

const power = (batteryPercent: number | null, source: PowerSample['source'] = 'battery'): PowerSample => ({
  source,
  batteryPercent,
  lowPowerMode: false,
});
// Service health does not inspect the attempt; the integration test below supplies the full fixture spec.
const spec = {} as AttemptSpec;
/** Lets a guard's stop call settle. */
const settle = () => Bun.sleep(0);
const facts = {
  now: 1_000,
  wakingUntil: null,
  power: null,
  freeBytes: null,
  needsLogin: false,
  minFreeGb: 10,
  batteryDrainPercent: 20,
};

function fixture(overrides: Partial<Parameters<typeof createServiceHealth>[0]> = {}) {
  const data = {
    now: 1_000,
    power: null as PowerSample | null,
    freeBytes: (20 * GB) as number | null,
    heartbeatMs: 15_000,
    /** Attempts that hold a slot: the fake handle stops each of them, as RunnerHandle.stopAgents does. */
    agents: 0,
  };
  const config = {
    minFreeGb: 10,
    batteryDrainPercent: 20,
    timings: { ...DEFAULT_TIMINGS },
  };
  const timers = new Map<unknown, { fn: () => void; ms: number }>();
  const clock: ClockSource = {
    now: () => data.now,
    setInterval: (fn, ms) => {
      const handle = {};
      timers.set(handle, { fn, ms });
      return handle;
    },
    clearInterval: (handle) => {
      timers.delete(handle);
    },
    setTimeout: () => {
      throw new Error('unexpected timeout');
    },
    clearTimeout: () => {
      throw new Error('unexpected timeout');
    },
  };
  const stops: unknown[][] = [];
  let stopped = 0;
  const stopAgents: ServiceHealthOptions['stopAgents'] = async (...args) => {
    stops.push(args);
    const exits = Array.from({ length: data.agents }, (_, index) => stopped + index + 1);
    stopped += data.agents;
    data.agents = 0;
    return exits;
  };
  const logger = memoryLogger();
  let samples = 0;
  let notifications = 0;
  const health = createServiceHealth({
    paths: runnerPaths('/tmp/agflow-health-unused'),
    config: () => config,
    heartbeatMs: () => data.heartbeatMs,
    now: () => data.now,
    clock,
    samplePower: async () => {
      samples++;
      return data.power;
    },
    freeBytes: () => data.freeBytes,
    usage: { current: () => 1234 },
    stopAgents,
    onSample: () => {
      notifications++;
    },
    logger,
    ...overrides,
  });
  return {
    health,
    data,
    config,
    timers,
    stops,
    stopAgents,
    logger,
    stopped: () => stopped,
    warnings: () => logger.entries.filter((entry) => entry.level === 'warn'),
    samples: () => samples,
    notifications: () => notifications,
  };
}

describe('admissionDecision', () => {
  test('decides holds and guard thresholds, including unknown facts and exact boundaries', () => {
    expect(GB).toBe(1_000_000_000);
    expect(BATTERY_STOP_PERCENT).toBe(8);
    const clear = {
      refusal: null,
      waking: false,
      batteryLow: false,
      batteryStop: false,
      diskLow: false,
      diskStop: false,
    };
    const cases: [Partial<Parameters<typeof admissionDecision>[0]>, Partial<ReturnType<typeof admissionDecision>>][] = [
      [{}, {}],
      [{ wakingUntil: 2_000 }, { refusal: 'waking', waking: true }],
      [{ wakingUntil: 1_000 }, {}],
      [{ power: power(15) }, { refusal: 'battery_low', batteryLow: true }],
      [{ power: power(7) }, { refusal: 'battery_low', batteryLow: true, batteryStop: true }],
      [{ power: power(8) }, { refusal: 'battery_low', batteryLow: true }],
      [{ power: power(20) }, {}],
      [{ power: power(5, 'ac') }, {}],
      [{ power: power(5, 'unknown') }, {}],
      [{ power: power(null) }, {}],
      [{ freeBytes: 8 * GB }, { refusal: 'disk_low', diskLow: true }],
      [{ freeBytes: 4 * GB }, { refusal: 'disk_low', diskLow: true, diskStop: true }],
      [{ freeBytes: 5 * GB }, { refusal: 'disk_low', diskLow: true }],
      [{ freeBytes: 10 * GB }, {}],
      [{ minFreeGb: 0, freeBytes: 0 }, {}],
      // The stop level holds even when batteryDrainPercent sits below it.
      [
        { power: power(7), batteryDrainPercent: 0 },
        { refusal: 'battery_low', batteryLow: true, batteryStop: true },
      ],
      [{ power: power(8), batteryDrainPercent: 0 }, {}],
    ];
    for (const [input, expected] of cases)
      expect(admissionDecision({ ...facts, ...input })).toEqual({
        ...clear,
        ...expected,
      });
  });

  test('orders refusals needs_login, waking, battery_low, disk_low, all from START_REFUSALS', () => {
    const input = {
      ...facts,
      needsLogin: true,
      wakingUntil: 2_000 as number | null,
      power: power(7),
      freeBytes: 4 * GB,
    };
    for (const refusal of ['needs_login', 'waking', 'battery_low', 'disk_low'] as const) {
      const decision = admissionDecision(input);
      expect(decision.refusal).toBe(refusal);
      expect(START_REFUSALS).toContain(decision.refusal!);
      if (refusal === 'needs_login') input.needsLogin = false;
      if (refusal === 'waking') input.wakingUntil = null;
      if (refusal === 'battery_low') input.power = power(100);
    }
  });
});

describe('createServiceHealth', () => {
  test('reports a shrinking wake hold, extends later gaps, and never shortens an existing end', () => {
    const f = fixture();
    f.health.gap({ at: f.data.now, ms: 30_000 });
    expect(f.health.heartbeat().acceptingUntil).toBe(f.config.timings.wakeHold);
    expect(f.health.admit(spec)).toBe('waking');
    f.data.now += 10_000;
    expect(f.health.heartbeat().acceptingUntil).toBe(f.config.timings.wakeHold - 10_000);
    f.health.gap({ at: f.data.now, ms: 30_000 });
    f.config.timings.wakeHold = 1_000;
    f.health.gap({ at: f.data.now - 1_000, ms: 30_000 });
    expect(f.health.heartbeat().acceptingUntil).toBe(DEFAULT_TIMINGS.wakeHold);
    f.data.now += DEFAULT_TIMINGS.wakeHold;
    expect(f.health.heartbeat().acceptingUntil).toBeNull();
    expect(f.health.admit(spec)).toBeNull();
  });

  test('a wall clock stepping back after a gap never stretches the hold past wakeHold', () => {
    const f = fixture();
    f.health.gap({ at: f.data.now, ms: 30_000 });
    f.data.now -= 3_600_000;
    expect(f.health.heartbeat().acceptingUntil).toBe(DEFAULT_TIMINGS.wakeHold);
    expect(f.health.admit(spec)).toBe('waking');
    f.data.now += DEFAULT_TIMINGS.wakeHold;
    expect(f.health.admit(spec)).toBeNull();
    expect(f.health.heartbeat().acceptingUntil).toBeNull();
  });

  test('renews battery holds and stops each agent once per crossing, without a handoff', async () => {
    const f = fixture();
    expect(f.health.power()).toBeNull();
    f.data.power = power(15);
    expect(f.health.admit(spec)).toBeNull();
    expect(f.samples()).toBe(0);
    await f.health.sample();
    expect(f.health.power()).toEqual(power(15));
    expect(f.health.admit(spec)).toBe('battery_low');
    expect(f.health.heartbeat().acceptingUntil).toBe(30_000);
    f.data.now += 60_000;
    f.data.heartbeatMs = 5_000;
    expect(f.health.heartbeat().acceptingUntil).toBe(10_000);
    expect(f.stops).toEqual([]);
    f.data.agents = 2;
    f.data.power = power(7);
    for (let i = 0; i < 3; i++) {
      await f.health.sample();
      f.health.heartbeat();
      f.health.state();
      f.health.admit(spec);
    }
    await settle();
    expect(f.stopped()).toBe(2);
    expect(f.stops.length).toBeGreaterThan(0);
    for (const args of f.stops) expect(args).toEqual(['runner_stop', { handoff: false }]);
    expect(f.warnings()).toHaveLength(1);
    expect(JSON.stringify(f.logger.entries)).toContain('battery');
    expect(JSON.stringify(f.logger.entries)).toContain('7');
    // A resume_attempt skips admit; the tripped guard stops it at the next evaluation, without a second warning.
    f.data.agents = 1;
    await f.health.sample();
    await settle();
    expect(f.stopped()).toBe(3);
    expect(f.warnings()).toHaveLength(1);
    f.data.power = power(9);
    await f.health.sample();
    f.data.agents = 1;
    f.data.power = power(7);
    await f.health.sample();
    await settle();
    expect(f.stopped()).toBe(4);
    expect(f.warnings()).toHaveLength(2);
    for (const recovered of [power(8), power(5, 'ac')]) {
      f.data.power = recovered;
      await f.health.sample();
      f.data.agents = 1;
      f.data.power = power(7);
      await f.health.sample();
      await settle();
    }
    expect(f.stopped()).toBe(6);
    expect(f.warnings()).toHaveLength(4);
    f.data.power = power(5, 'ac');
    await f.health.sample();
    await settle();
    const calls = f.stops.length;
    expect(f.health.admit(spec)).toBeNull();
    expect(f.health.heartbeat().acceptingUntil).toBeNull();
    expect(f.stops).toHaveLength(calls);
  });

  test('after a stop that threw, reached no agent or is under way, the guard stops later agents', async () => {
    const host: { handle?: { stopAgents: ServiceHealthOptions['stopAgents'] } } = {};
    let release = () => {};
    const f = fixture({
      // As the host binds it: the handle does not exist yet, so the call throws a TypeError.
      stopAgents: (cause, options) =>
        (host.handle as { stopAgents: ServiceHealthOptions['stopAgents'] }).stopAgents(cause, options),
    });
    f.data.power = power(7);
    await f.health.sample();
    expect(JSON.stringify(f.logger.entries)).toContain('guard stop failed');
    expect(f.health.state()).toEqual({ state: 'ok', detail: null });
    expect(f.health.admit(spec)).toBe('battery_low');
    host.handle = { stopAgents: f.stopAgents };
    f.health.heartbeat();
    await settle();
    expect(f.stops).toHaveLength(1);
    expect(f.stopped()).toBe(0);
    // A suspended attempt resumed after the guard tripped: the next heartbeat stops it.
    f.data.agents = 1;
    f.health.heartbeat();
    await settle();
    expect(f.stopped()).toBe(1);
    // One call at a time: evaluations during a slow stop (WIP pushes) start no second one.
    host.handle = {
      stopAgents: (...args) => {
        f.stops.push(args);
        return new Promise((done) => {
          release = () => done([]);
        });
      },
    };
    const before = f.stops.length;
    await f.health.sample();
    f.health.heartbeat();
    f.health.admit(spec);
    expect(f.stops).toHaveLength(before + 1);
    release();
    await settle();
    host.handle = { stopAgents: f.stopAgents };
    f.data.agents = 1;
    f.health.state();
    await settle();
    expect(f.stopped()).toBe(2);
    expect(f.warnings()).toHaveLength(1);
  });

  test('reads disk afresh, reports usage, and clears disk holds after recovery', async () => {
    const f = fixture();
    f.data.freeBytes = 8 * GB;
    expect(f.health.state()).toEqual({ state: 'disk_low', detail: 'free space below 10 GB' });
    // A changed detail goes out as a runner.state event: it must not follow the live number.
    f.data.freeBytes = 7.9 * GB;
    expect(f.health.state()).toEqual({ state: 'disk_low', detail: 'free space below 10 GB' });
    f.data.freeBytes = 8 * GB;
    expect(f.health.admit(spec)).toBe('disk_low');
    expect(f.health.heartbeat()).toEqual({
      power: null,
      disk: { freeBytes: 8 * GB, agflowBytes: 1234 },
      acceptingUntil: 30_000,
    });
    f.data.agents = 1;
    f.data.freeBytes = 4 * GB;
    f.health.state();
    f.health.heartbeat();
    f.health.admit(spec);
    await settle();
    expect(f.stopped()).toBe(1);
    for (const args of f.stops) expect(args).toEqual(['runner_stop', { handoff: false }]);
    expect(f.warnings()).toHaveLength(1);
    expect(JSON.stringify(f.logger.entries)).toContain('disk');
    expect(JSON.stringify(f.logger.entries)).toContain(String(4 * GB));
    f.data.freeBytes = 5 * GB;
    f.health.admit(spec);
    f.data.agents = 1;
    f.data.freeBytes = 4 * GB;
    f.health.admit(spec);
    await settle();
    expect(f.stopped()).toBe(2);
    expect(f.warnings()).toHaveLength(2);
    f.data.freeBytes = 11 * GB;
    expect(f.health.state()).toEqual({ state: 'ok', detail: null });
    expect(f.health.admit(spec)).toBeNull();
    expect(f.health.heartbeat().acceptingUntil).toBeNull();
    f.data.freeBytes = null;
    expect(f.health.heartbeat().disk).toBeNull();
  });

  test('prioritizes crash_loop state and needs_login admission without adding a heartbeat hold', async () => {
    const f = fixture();
    f.health.setCrashLoop('last service error');
    f.health.setNeedsLogin(true);
    expect(f.health.state()).toEqual({
      state: 'crash_loop',
      detail: 'last service error',
    });
    expect(f.health.admit(spec)).toBe('needs_login');
    expect(f.health.heartbeat().acceptingUntil).toBeNull();
    f.data.freeBytes = 8 * GB;
    f.data.power = power(15);
    await f.health.sample();
    f.health.gap({ at: f.data.now, ms: 30_000 });
    expect(f.health.admit(spec)).toBe('needs_login');
    expect(f.health.state().state).toBe('crash_loop');
    f.health.setCrashLoop(null);
    expect(f.health.state().state).toBe('disk_low');
    f.health.setNeedsLogin(false);
    expect(f.health.admit(spec)).toBe('waking');
    f.data.freeBytes = 20 * GB;
    expect(f.health.state()).toEqual({ state: 'ok', detail: null });
  });

  test('uses the longest hold, reads live thresholds, and arms guards independently', async () => {
    const f = fixture();
    f.data.agents = 1;
    f.data.power = power(7);
    f.data.freeBytes = 4 * GB;
    await f.health.sample();
    await settle();
    // Both guards trip and warn; one stop call covers them.
    expect(f.stopped()).toBe(1);
    expect(f.warnings().map((entry) => entry.fields.guard)).toEqual(['battery', 'disk']);
    f.health.gap({ at: f.data.now, ms: 30_000 });
    expect(f.health.heartbeat().acceptingUntil).toBe(DEFAULT_TIMINGS.wakeHold);
    f.data.now += DEFAULT_TIMINGS.wakeHold - 1;
    expect(f.health.heartbeat().acceptingUntil).toBe(30_000);
    f.data.freeBytes = 5 * GB;
    f.health.heartbeat();
    f.data.freeBytes = 4 * GB;
    f.health.heartbeat();
    expect(f.warnings().map((entry) => entry.fields.guard)).toEqual(['battery', 'disk', 'disk']);
    f.data.now++;
    f.data.power = power(9);
    await f.health.sample();
    f.config.batteryDrainPercent = 5;
    expect(f.health.admit(spec)).toBe('disk_low');
    f.config.minFreeGb = 3;
    await settle();
    const calls = f.stops.length;
    expect(f.health.admit(spec)).toBeNull();
    expect(f.health.state().state).toBe('ok');
    expect(f.health.heartbeat().acceptingUntil).toBeNull();
    expect(f.stops).toHaveLength(calls);
    expect(f.warnings()).toHaveLength(3);
  });

  test('shares overlapping samples and notifies only after the sample and each heartbeat', async () => {
    let resolve!: (sample: PowerSample | null) => void;
    let calls = 0;
    const f = fixture({
      samplePower: () => {
        calls++;
        return new Promise((done) => {
          resolve = done;
        });
      },
    });
    const first = f.health.sample();
    expect(f.health.sample()).toBe(first);
    await Promise.resolve();
    expect(calls).toBe(1);
    expect(f.notifications()).toBe(0);
    resolve(power(15));
    await first;
    expect(f.notifications()).toBe(1);
    f.health.admit(spec);
    f.health.state();
    expect(f.notifications()).toBe(1);
    expect(f.health.heartbeat().power).toEqual(power(15));
    expect(f.notifications()).toBe(2);
  });

  test('samples at start and on its timer even without heartbeats; close clears the timer', async () => {
    for (const sampleEveryMs of [undefined, 123]) {
      const f = fixture({ sampleEveryMs });
      f.health.start();
      f.health.start();
      await f.health.sample();
      expect(f.samples()).toBe(1);
      expect(f.timers.size).toBe(1);
      expect([...f.timers.values()][0].ms).toBe(sampleEveryMs ?? 60_000);
      f.data.agents = 1;
      f.data.power = power(7);
      for (const timer of f.timers.values()) timer.fn();
      await f.health.sample();
      await settle();
      expect(f.samples()).toBe(2);
      expect(f.stopped()).toBe(1);
      f.health.close();
      f.health.close();
      expect(f.timers.size).toBe(0);
    }
  });

  test('logs rejected stops and throwing observers without failing health reads; stops again', async () => {
    let stops = 0;
    const f = fixture({
      stopAgents: async () => {
        stops++;
        throw new Error('stop failed');
      },
      onSample: () => {
        throw new Error('observer failed');
      },
    });
    f.data.power = power(7);
    await f.health.sample();
    await settle();
    expect(stops).toBe(1);
    expect(f.health.heartbeat().acceptingUntil).toBe(30_000);
    await settle();
    expect(stops).toBe(2);
    expect(JSON.stringify(f.logger.entries)).toContain('stop failed');
    expect(JSON.stringify(f.logger.entries)).toContain('observer failed');
    expect(f.warnings()).toHaveLength(1);
  });

  test('a config read that throws during a timer sample is logged instead of rejecting', async () => {
    let broken = false;
    const f = fixture({
      config: () => {
        if (broken) throw new Error('runner.json is malformed');
        return f.config;
      },
    });
    f.health.start();
    await f.health.sample();
    broken = true;
    for (const timer of f.timers.values()) timer.fn();
    await f.health.sample();
    expect(await f.health.sample()).toBeUndefined();
    expect(JSON.stringify(f.logger.entries)).toContain('runner.json is malformed');
    broken = false;
    f.data.power = power(15);
    await f.health.sample();
    expect(f.health.admit(spec)).toBe('battery_low');
    f.health.close();
  });

  test('a failed power sample becomes unknown, is logged, and permits another sample', async () => {
    let fail = false;
    const f = fixture({
      samplePower: async () => {
        if (fail) throw new Error('power unavailable');
        return power(15);
      },
    });
    await f.health.sample();
    expect(f.health.admit(spec)).toBe('battery_low');
    fail = true;
    await f.health.sample();
    expect(f.health.power()).toBeNull();
    expect(f.health.admit(spec)).toBeNull();
    expect(JSON.stringify(f.logger.entries)).toContain('power unavailable');
    fail = false;
    await f.health.sample();
    expect(f.health.admit(spec)).toBe('battery_low');
  });

  test('measures free space and agflow usage at AGFLOW_HOME by default', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agflow-health-'));
    try {
      writeFileSync(join(home, 'runner.db'), randomBytes(64 * 1024));
      const f = fixture({ paths: runnerPaths(home), freeBytes: undefined, usage: undefined });
      // Above any real disk: the default free space must be read, and be below it.
      f.config.minFreeGb = 1e9;
      expect(f.health.admit(spec)).toBe('disk_low');
      expect(f.health.state().state).toBe('disk_low');
      expect(f.health.heartbeat().disk?.freeBytes ?? 0).toBeGreaterThan(0);
      // AgflowUsage measures in the background; the file is inside AGFLOW_HOME, so its size shows up.
      await waitFor(() => (f.health.heartbeat().disk?.agflowBytes ?? 0) >= 64 * 1024);
      await settle();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('reports a sampled battery hold through the controller without launching an agent', async () => {
    const runner = await createRunnerFixture();
    const f = fixture({ paths: runner.paths, config: () => runner.config });
    f.data.power = power(15);
    await f.health.sample();
    const controller = runner.controller('T-4-a1', { health: f.health });
    expect(await controller.start(runner.spec())).toMatchObject({
      started: false,
      refused: 'battery_low',
    });
    expect(runner.events('attempt.failed_to_start').map((event) => event.data.refused)).toEqual(['battery_low']);
    expect(runner.fakes.claude?.launches).toEqual([]);
    expect(runner.fakes.codex?.launches).toEqual([]);
    expect(runner.store.list()).toEqual([]);
    expect(controller.holdsSlot).toBe(false);
  });
});
