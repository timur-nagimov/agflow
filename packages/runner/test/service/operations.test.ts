// Service operations across the real runner link: machine facts, guards, settings, approvals and daily retention.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { APPROVALS_ROUTE } from '@agflow/core';
import { getAttempt } from '@agflow/hub/src/attempt-store';
import { tx } from '@agflow/hub/src/context';
import { getRunner, patchRunnerSettings } from '@agflow/hub/src/runners';
import { getTask } from '@agflow/hub/src/task-store';
import { createTasks } from '@agflow/hub/src/tasks';
import { newTask } from '@agflow/hub/test/helpers';
import { FakeAdapter, type FakeScript, originRepo } from '@agflow/testkit';
import type { ClockSource } from '../../src/clock';
import { openRunnerDb } from '../../src/db';
import { GB } from '../../src/ops/health';
import type { PowerSample } from '../../src/ops/power';
import { Outbox } from '../../src/outbox';
import { VENDOR_PINS } from '../../src/vendor/pins';
import { waitFor } from '../fixture';
import { startRunnerAttempt, startTestHub } from '../hub-fixture';
import { afterThisTest, cleanupRunnerSetups, tempDir } from '../runner-setup';
import { fakePrepSandbox, recordingExec, setupTestService, startTestService } from '../service-helpers';

afterEach(cleanupRunnerSetups);
setDefaultTimeout(60_000);

type Service = Awaited<ReturnType<typeof startTestService>>;
const ac: PowerSample = { source: 'ac', batteryPercent: 100, lowPowerMode: false };
const waiting: FakeScript = { turns: [[{ do: 'sleep', ms: 120_000 }], [{ do: 'text', text: 'handoff turn' }]] };
const HOUR = 60 * 60_000;

function fakeClock() {
  let now = Date.now();
  const timers = new Map<object, { at: number; ms: number | null; fn: () => void }>();
  const add = (fn: () => void, ms: number, repeat: boolean) => {
    const id = {};
    timers.set(id, { at: now + ms, ms: repeat ? ms : null, fn });
    return id;
  };
  const clear = (id: unknown) => {
    timers.delete(id as object);
  };
  const clock: ClockSource = {
    now: () => now,
    setTimeout: (fn, ms) => add(fn, ms, false),
    setInterval: (fn, ms) => add(fn, ms, true),
    clearTimeout: clear,
    clearInterval: clear,
  };
  return {
    clock,
    pending: () => timers.size,
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        const [id, timer] = next;
        now = timer.at;
        if (timer.ms === null) timers.delete(id);
        else timer.at += timer.ms;
        timer.fn();
      }
      now = end;
    },
  };
}

/** Moves the fake clock an hour at a time, letting each hourly retention check settle. */
async function hours(time: ReturnType<typeof fakeClock>, count: number) {
  for (let i = 0; i < count; i++) {
    time.advance(HOUR);
    await Bun.sleep(5);
  }
}

/** Turns on AGFLOW_TEST=1 for this test: test mode, with the test block, allows short timings. */
function agflowTestEnv() {
  const previous = process.env.AGFLOW_TEST;
  process.env.AGFLOW_TEST = '1';
  afterThisTest(() => {
    if (previous === undefined) delete process.env.AGFLOW_TEST;
    else process.env.AGFLOW_TEST = previous;
  });
}

/** A fake caffeinate that records its pid and holds while the pid it watches lives. */
function fakeCaffeinate() {
  const dir = tempDir('agf-caffeinate-');
  const command = join(dir, 'caffeinate');
  const record = join(dir, 'pids');
  writeFileSync(command, `#!/bin/sh\necho $$ >> '${record}'\nwhile kill -0 "$3" 2>/dev/null; do sleep 0.01; done\n`, {
    mode: 0o755,
  });
  const pids = () => (existsSync(record) ? readFileSync(record, 'utf8').trim().split('\n').map(Number) : []);
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const live = () => pids().filter(alive);
  afterThisTest(() => {
    for (const pid of live()) process.kill(pid, 'SIGKILL');
  });
  return { command, pids, live };
}

async function online(s: Service) {
  await waitFor(() => s.service.runner?.status().link === 'online');
  return s.service.runner!.status().runnerId!;
}

function events(s: Service) {
  const db = openRunnerDb(s.paths.db);
  try {
    return new Outbox(db).eventsAfter(0);
  } finally {
    db.close();
  }
}

function startAttempt(s: Service, runnerId: string) {
  const [task] = createTasks(s.hub.ctx, [newTask()], 'user:alice');
  return startRunnerAttempt(s.hub.ctx, { runnerId, taskId: task!.id, role: 'worker', vendor: 'codex' }).attempt;
}

async function refused(s: Service, runnerId: string, reason: 'disk_low' | 'battery_low' | 'waking') {
  const attempt = startAttempt(s, runnerId);
  await waitFor(() => getAttempt(s.hub.ctx, attempt.id).status === 'ended');
  expect(getAttempt(s.hub.ctx, attempt.id)).toMatchObject({ endReason: 'failed_to_start', failureClass: null });
  expect(events(s)).toContainEqual(expect.objectContaining({
    type: 'attempt.failed_to_start',
    attemptId: attempt.id,
    data: expect.objectContaining({ refused: reason }),
  }));
}

async function stopped(s: Service, ids: string[], messages: string[]) {
  await waitFor(() => ids.every((id) => getAttempt(s.hub.ctx, id).status === 'ended'), 30_000);
  for (const id of ids) {
    const attempt = getAttempt(s.hub.ctx, id);
    expect(attempt).toMatchObject({ endReason: 'stopped', failureClass: 'infra', failureSignature: null });
    expect(getTask(s.hub.ctx, attempt.taskId!)).toMatchObject({ status: 'ready', nextDispatchAt: null });
    expect(events(s).filter((event) => event.type === 'attempt.exited' && event.attemptId === id)).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ cause: 'runner_stop', handoffWritten: false }) }),
    ]);
  }
  // A handoff turn requires a new input to the live session.
  expect(messages).toEqual([]);
}

function waitingAdapter() {
  const messages: string[] = [];
  const adapter = new FakeAdapter({ vendor: 'codex', skipAuthChecks: true, script: waiting });
  const start = adapter.start.bind(adapter);
  adapter.start = async (launch) => {
    const session = await start(launch);
    const send = session.send.bind(session);
    session.send = async (message) => {
      messages.push(message.text);
      await send(message);
    };
    return session;
  };
  return { adapter, messages };
}

test('heartbeats put injected power and disk facts on the hub card', async () => {
  const power: PowerSample = { source: 'battery', batteryPercent: 55, lowPowerMode: true };
  const s = await startTestService({
    host: { power: async () => power, freeBytes: () => 42 * GB, usage: { current: () => 123_456 } },
  });
  const id = await online(s);
  await waitFor(() => getRunner(s.hub.ctx, id).power !== null);
  expect(getRunner(s.hub.ctx, id)).toMatchObject({
    power,
    disk: { freeBytes: 42 * GB, agflowBytes: 123_456 },
    acceptingUntil: null,
  });
});

test('power is sampled before the runner starts, so the first start already sees a low battery', async () => {
  const low: PowerSample = { source: 'battery', batteryPercent: 15, lowPowerMode: false };
  const s = await startTestService({
    host: {
      power: async () => {
        // A slow pmset: a start right after the first welcome must still wait for its answer.
        await Bun.sleep(300);
        return low;
      },
    },
  });
  const id = await online(s);
  await refused(s, id, 'battery_low');
});

test('disk holds refuse starts, stop every attempt without a handoff once, and recover', async () => {
  let free = 20 * GB;
  const { adapter, messages } = waitingAdapter();
  const s = await startTestService({
    config: { capacity: 2, minFreeGb: 10 },
    host: { freeBytes: () => free, adapters: [adapter] },
  });
  const id = await online(s);
  free = 7 * GB;
  await waitFor(() => getRunner(s.hub.ctx, id).state === 'disk_low');
  expect(getRunner(s.hub.ctx, id).acceptingUntil).toBe(s.hub.clock.now() + 2_000);
  expect(events(s)).toContainEqual(expect.objectContaining({
    type: 'runner.state',
    data: expect.objectContaining({ state: 'disk_low' }),
  }));
  await refused(s, id, 'disk_low');
  free = 20 * GB;
  await waitFor(() => getRunner(s.hub.ctx, id).state === 'online');
  const attempts = [startAttempt(s, id), startAttempt(s, id)];
  await waitFor(() => attempts.every((attempt) => getAttempt(s.hub.ctx, attempt.id).status === 'running'));
  await waitFor(() => s.service.runner!.status().attempts.filter((a) => a.phase === 'turn').length === 2);
  free = 4 * GB;
  await stopped(s, attempts.map((attempt) => attempt.id), messages);
  await Bun.sleep(2_100);
  await stopped(s, attempts.map((attempt) => attempt.id), messages);
  expect(s.terminal.filter((line) => line.includes('disk guard stopping agents'))).toHaveLength(1);
  free = 20 * GB;
  await waitFor(() => getRunner(s.hub.ctx, id).state === 'online');
  expect(events(s).filter((event) => event.type === 'runner.state').at(-1)?.data).toEqual({
    state: 'ok',
    detail: null,
  });
});

test('battery at seven percent stops once without a handoff; fifteen percent refuses a start', async () => {
  const time = fakeClock();
  let power = ac;
  const { adapter, messages } = waitingAdapter();
  const s = await startTestService({ host: { clock: time.clock, power: async () => power, adapters: [adapter] } });
  const id = await online(s);
  const attempt = startAttempt(s, id);
  await waitFor(() => getAttempt(s.hub.ctx, attempt.id).status === 'running');
  await waitFor(() => s.service.runner!.status().attempts.some((a) => a.phase === 'turn'));
  power = { source: 'battery', batteryPercent: 7, lowPowerMode: true };
  time.advance(60_000);
  await stopped(s, [attempt.id], messages);
  time.advance(60_000);
  await Bun.sleep(1_100);
  await stopped(s, [attempt.id], messages);
  expect(s.terminal.filter((line) => line.includes('battery guard stopping agents'))).toHaveLength(1);
  power = { ...power, batteryPercent: 15 };
  time.advance(60_000);
  await waitFor(() => getRunner(s.hub.ctx, id).power?.batteryPercent === 15);
  await refused(s, id, 'battery_low');
});

test('one fake caffeinate holds a running attempt and hub settings release it within a heartbeat', async () => {
  const caffeinate = fakeCaffeinate();
  const s = await startTestService({
    host: {
      caffeinate: caffeinate.command,
      adapters: [new FakeAdapter({ vendor: 'codex', skipAuthChecks: true, script: waiting })],
    },
  });
  const id = await online(s);
  const attempt = startAttempt(s, id);
  await waitFor(() => getAttempt(s.hub.ctx, attempt.id).status === 'running' && caffeinate.live().length === 1);
  await Bun.sleep(1_100);
  expect(caffeinate.pids()).toHaveLength(1);
  tx(s.hub.ctx, (emit) => patchRunnerSettings(s.hub.ctx, emit, id, { keepAwake: 'off' }, 'user:alice'));
  await waitFor(() => s.service.runner!.status().settings.keepAwake === 'off');
  await waitFor(() => caffeinate.live().length === 0, 1_200);
  expect(caffeinate.pids()).toHaveLength(1);
});

test('keep-awake follows attempt changes between heartbeats and ends with the service', async () => {
  const caffeinate = fakeCaffeinate();
  const origin = await originRepo({ 'README.md': '# demo\n' });
  afterThisTest(() => origin.remove());
  // Heartbeats 30 s apart and power samples 60 s apart: only the attempt-state events move keep-awake sooner.
  const hub = startTestHub({
    config: { projectName: 'demo', projectRepo: origin.path, heartbeatMs: 30_000, deadLinkMs: 120_000 },
  });
  afterThisTest(() => hub.stop());
  const s = await startTestService({
    hub,
    host: {
      caffeinate: caffeinate.command,
      adapters: [new FakeAdapter({ vendor: 'codex', skipAuthChecks: true, script: waiting })],
    },
  });
  const id = await online(s);
  const first = startAttempt(s, id);
  await waitFor(() => getAttempt(s.hub.ctx, first.id).status === 'running');
  await waitFor(() => caffeinate.live().length === 1, 5_000);
  await s.service.runner!.stopAgents('runner_stop', { handoff: false });
  await waitFor(() => caffeinate.live().length === 0, 5_000);
  const second = startAttempt(s, id);
  await waitFor(() => getAttempt(s.hub.ctx, second.id).status === 'running');
  await waitFor(() => caffeinate.live().length === 1, 5_000);
  await s.service.stop('done');
  expect(caffeinate.live()).toEqual([]);
  expect(caffeinate.pids()).toHaveLength(2);
});

test('a clock gap holds new attempts for wakeHold', async () => {
  agflowTestEnv();
  const s = await startTestService({ config: { timings: { tickGap: 2_000 } } });
  const id = await online(s);
  // A freeze longer than tickGap, as a sleeping Mac gives.
  Bun.sleepSync(3_500);
  await online(s);
  await waitFor(() => getRunner(s.hub.ctx, id).acceptingUntil !== null);
  expect(getRunner(s.hub.ctx, id).acceptingUntil!).toBeLessThanOrEqual(s.hub.clock.now() + s.config.timings.wakeHold);
  await refused(s, id, 'waking');
});

for (const testMode of [false, true]) {
  const name = testMode ? 'is silent in test mode' : 'includes the summary and hub approvals URL';
  test(`approval notification ${name}`, async () => {
    agflowTestEnv();
    const exec = recordingExec();
    const summary = 'Allow the release command';
    const adapter = new FakeAdapter({
      vendor: 'codex',
      skipAuthChecks: true,
      script: { turns: [[{ do: 'approval', kind: 'command', summary }]] },
    });
    const s = await startTestService({
      config: { test: testMode ? { skipAuthChecks: true } : undefined, keepAwake: 'off' },
      host: { exec, platform: 'darwin', adapters: [adapter] },
    });
    const id = await online(s);
    const attempt = startAttempt(s, id);
    await waitFor(() => events(s).some((event) => event.type === 'approval.requested'));
    if (testMode) {
      await Bun.sleep(100);
      expect(exec.calls).toEqual([]);
    } else {
      await waitFor(() => exec.calls.length === 1);
      expect(exec.calls[0]?.argv[0]).toBe('osascript');
      expect(exec.calls[0]?.argv).toContain(`${summary}\n${s.hub.url}${APPROVALS_ROUTE}`);
    }
    await waitFor(() => getAttempt(s.hub.ctx, attempt.id).status === 'running');
  });
}

for (const works of [true, false]) {
  test(`hello dependencyPrep is ${works} after the sandbox self-check`, async () => {
    const s = await startTestService({ host: { prepSandbox: fakePrepSandbox({ isSupportedPlatform: () => works }) } });
    const id = await online(s);
    expect(getRunner(s.hub.ctx, id).profile.dependencyPrep).toBe(works);
  });
}

test('retention sweeps at start and daily however long a sweep takes, and restarts add no sweep', async () => {
  const time = fakeClock();
  const s = await startTestService({ host: { clock: time.clock, now: time.clock.now } });
  await online(s);
  const state = join(s.paths.logs, 'retention.json');
  const sweptAt = () => JSON.parse(readFileSync(state, 'utf8')).sweptAt as number;
  const sweeps = () => s.terminal.filter((line) => line.includes('retention sweep finished')).length;
  await waitFor(() => sweeps() === 1);
  const first = sweptAt();
  expect(first).toBe(time.clock.now());
  const vault = s.service.runner!.vault;
  const consolidate = vault.consolidate.bind(vault);
  vault.consolidate = async (...args) => {
    // A long repack: the clock moves on while the sweep runs.
    time.advance(HOUR / 2);
    return consolidate(...args);
  };
  for (let day = 1; day <= 3; day++) {
    await hours(time, 23);
    expect(sweeps()).toBe(day);
    await hours(time, 1);
    await waitFor(() => sweeps() === day + 1);
    expect(sweptAt()).toBe(first + day * 24 * HOUR);
  }
  await s.service.stop('restart');
  expect(time.pending()).toBe(0);
  // A restart within the day does not sweep; the hourly check sweeps soon after the day is up.
  time.advance(20 * HOUR);
  const restarted = await s.start();
  await waitFor(() => restarted.runner?.status().link === 'online');
  await hours(time, 3);
  expect(sweeps()).toBe(4);
  await hours(time, 1);
  await waitFor(() => sweeps() === 5);
  await restarted.stop('done');
  expect(time.pending()).toBe(0);
});

test('shutdown stops a retention sweep after its step under way, before closing runner.db', async () => {
  const time = fakeClock();
  const s = await startTestService({ host: { clock: time.clock, now: time.clock.now } });
  await online(s);
  await waitFor(() => s.terminal.some((line) => line.includes('retention sweep finished')));
  const state = join(s.paths.logs, 'retention.json');
  const first = JSON.parse(readFileSync(state, 'utf8')).sweptAt;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const vault = s.service.runner!.vault;
  const consolidate = vault.consolidate.bind(vault);
  vault.consolidate = async (...args) => {
    entered.resolve();
    await release.promise;
    return consolidate(...args);
  };
  await hours(time, 24);
  await entered.promise;
  let ended = false;
  const stopping = s.service.stop('during sweep').then((exit) => {
    ended = true;
    return exit;
  });
  try {
    await Bun.sleep(20);
    expect(ended).toBe(false);
    // status reads the host's database, not a separate connection.
    expect(s.service.runner!.status().runnerId).not.toBeNull();
  } finally {
    release.resolve();
    await stopping;
  }
  expect(time.pending()).toBe(0);
  expect(() => s.service.runner!.status()).toThrow();
  // The stopped sweep stays due: the next start finishes it.
  expect(s.terminal.some((line) => line.includes('retention sweep stopped by shutdown'))).toBe(true);
  expect(JSON.parse(readFileSync(state, 'utf8')).sweptAt).toBe(first);
});

test('a retention failure is logged, leaves the service online, and retries at the next hourly check', async () => {
  const time = fakeClock();
  let fail = false;
  const s = await startTestService({
    host: {
      clock: time.clock,
      now: () => {
        if (fail) throw new Error('retention clock unavailable');
        return time.clock.now();
      },
    },
  });
  const id = await online(s);
  await waitFor(() => s.terminal.some((line) => line.includes('retention sweep finished')));
  const state = join(s.paths.logs, 'retention.json');
  const first = JSON.parse(readFileSync(state, 'utf8')).sweptAt;
  fail = true;
  await hours(time, 24);
  await waitFor(() => s.terminal.some((line) => line.includes('retention sweep failed')));
  expect(getRunner(s.hub.ctx, id).state).toBe('online');
  expect(s.service.runner!.status().link).toBe('online');
  fail = false;
  await hours(time, 1);
  await waitFor(() => JSON.parse(readFileSync(state, 'utf8')).sweptAt > first);
  expect(JSON.parse(readFileSync(state, 'utf8')).sweptAt).toBe(time.clock.now());
});


test('the host passes the retention platform independently of the machine operations platform', async () => {
  const s = await setupTestService({ host: { retentionPlatform: 'unpublished-test-platform' } });
  const installed = join(s.paths.vendor, 'codex', VENDOR_PINS['darwin-arm64']!.codex.version);
  mkdirSync(installed, { recursive: true });
  writeFileSync(join(installed, 'codex'), 'fake binary');
  await s.start();
  await waitFor(() => s.terminal.some((line) => line.includes('retention sweep finished')));
  // Retention's existing no-pins rule removes unreferenced installs; native darwin would keep this pin.
  expect(existsSync(installed)).toBe(false);
});
