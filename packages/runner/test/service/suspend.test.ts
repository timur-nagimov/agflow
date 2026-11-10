// Suspend owns the deadline and command pause; M2b owns each agent's stop and final work.
import { afterEach, beforeEach, expect, mock, setDefaultTimeout, spyOn, test } from 'bun:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunnerMessage } from '@agflow/core';
import { getAttempt } from '@agflow/hub/src/attempt-store';
import { findCommand, pendingCommands } from '@agflow/hub/src/commands';
import { tx } from '@agflow/hub/src/context';
import { patchRunnerSettings } from '@agflow/hub/src/runners';
import { createTasks } from '@agflow/hub/src/tasks';
import { newTask } from '@agflow/hub/test/helpers';
import { FakeAdapter, gitIn } from '@agflow/testkit';
import { systemClock } from '../../src/clock';
import { openRunnerDb, type RunnerDb } from '../../src/db';
import { Journal } from '../../src/journal';
import { memoryLogger } from '../../src/log';
import { RETENTION } from '../../src/ops/retention';
import { Outbox } from '../../src/outbox';
import type { RunnerHandle, RunnerStatus } from '../../src/runner';
import { controlRequest } from '../../src/service/control';
import type { RunnerService } from '../../src/service/host';
import { readLockOwner } from '../../src/service/lock';
import { ServiceRuns } from '../../src/service/runs';
import { suspendRunner } from '../../src/service/suspend';
import { waitFor } from '../fixture';
import { startRunnerAttempt } from '../hub-fixture';
import { afterThisTest, cleanupRunnerSetups, tempDir } from '../runner-setup';
import { setupTestService, startTestService } from '../service-helpers';

afterEach(cleanupRunnerSetups);
setDefaultTimeout(60_000);
beforeEach(() => {
  const previous = process.env.AGFLOW_TEST;
  process.env.AGFLOW_TEST = '1';
  afterThisTest(() => {
    if (previous === undefined) delete process.env.AGFLOW_TEST;
    else process.env.AGFLOW_TEST = previous;
  });
});

type Setup = Awaited<ReturnType<typeof setupTestService>>;
type SuspendHandle = Pick<RunnerHandle, 'pause' | 'stopAgents' | 'waitAcked' | 'status'>;

function handle() {
  const status: RunnerStatus = {
    runnerId: 'R-1',
    link: 'online',
    state: { state: 'ok', detail: null },
    settings: { capacity: 2, keepAwake: 'off', draining: false, ceilings: {}, allowPaidUsage: {} },
    vendors: [],
    git: { ready: true, problem: null, lastPushAt: null },
    attempts: [],
  };
  return {
    pause: mock(() => {}),
    stopAgents: mock(async () => [3, 7]),
    waitAcked: mock(async (_seq: number, _ms: number) => true),
    status: () => status,
  } satisfies SuspendHandle;
}

function readDb<T>(s: Setup, read: (db: RunnerDb) => T): T {
  const db = openRunnerDb(s.paths.db);
  try {
    return read(db);
  } finally {
    db.close();
  }
}

const events = (s: Setup) => readDb(s, (db) => new Outbox(db).eventsAfter(0));
const exits = (s: Setup) => events(s).filter((event) => event.type === 'attempt.exited');
const lastExit = (s: Setup) => new ServiceRuns(s.paths).lastExit({ running: false });

async function online(service: RunnerService) {
  if (service.runner === null) throw new Error(`service did not start: ${(await service.exited).reason}`);
  await waitFor(() => service.runner?.status().link === 'online');
  return service.runner!.status().runnerId!;
}

function waitingAdapter() {
  return new FakeAdapter({
    vendor: 'codex',
    skipAuthChecks: true,
    script: { turns: [[{ do: 'sleep', ms: 120_000 }], [{ do: 'text', text: 'unexpected handoff' }]] },
  });
}

function startAttempt(s: Setup, runnerId: string) {
  const [task] = createTasks(s.hub.ctx, [newTask()], 'user:alice');
  return startRunnerAttempt(s.hub.ctx, { runnerId, taskId: task!.id, role: 'worker', vendor: 'codex' }).attempt;
}

function observeHellos() {
  const hellos: Extract<RunnerMessage, { t: 'hello' }>[] = [];
  const send = WebSocket.prototype.send;
  const observer = spyOn(WebSocket.prototype, 'send').mockImplementation(function (this: WebSocket, data) {
    if (typeof data === 'string') {
      const message = JSON.parse(data) as RunnerMessage;
      if (message.t === 'hello') hellos.push(message);
    }
    return send.call(this, data);
  });
  afterThisTest(() => observer.mockRestore());
  return hellos;
}

test('pauses before stopping without a handoff, then acks the final exit with the remaining budget', async () => {
  const runner = handle();
  let now = 100;
  runner.stopAgents.mockImplementation(async () => {
    expect(runner.pause).toHaveBeenCalledTimes(1);
    now += 30;
    return [3, 7];
  });
  const result = await suspendRunner(runner, { deadlineMs: 80, logger: memoryLogger(), now: () => now });
  expect(runner.stopAgents).toHaveBeenCalledWith('suspend', { handoff: false });
  expect(runner.waitAcked).toHaveBeenCalledWith(7, 50);
  expect(result).toMatchObject({ seqs: [3, 7], acked: true, deadlinePassed: false });
});

test('does not wait for acks while offline or when no attempt exited', async () => {
  for (const offline of [true, false]) {
    const runner = handle();
    if (offline) runner.status().link = 'backoff';
    else runner.stopAgents.mockResolvedValue([]);
    expect(await suspendRunner(runner, { deadlineMs: 100, logger: memoryLogger() })).toMatchObject({
      acked: null,
      deadlinePassed: false,
    });
    expect(runner.waitAcked).not.toHaveBeenCalled();
  }
});

test('a lost link releases an ack wait without spending the rest of the deadline', async () => {
  const runner = handle();
  runner.waitAcked.mockImplementation(async () => {
    runner.status().link = 'backoff';
    return false;
  });
  const result = await suspendRunner(runner, { deadlineMs: 5_000, logger: memoryLogger() });
  expect(result).toMatchObject({ acked: false, deadlinePassed: false });
  expect(runner.waitAcked).toHaveBeenCalledTimes(1);
});

test('bounds both a hanging stop and a hanging ack, and consumes a late rejection', async () => {
  for (const stage of ['stop', 'ack'] as const) {
    const runner = handle();
    const pending = Promise.withResolvers<never>();
    if (stage === 'stop') runner.stopAgents.mockImplementation(() => pending.promise);
    else runner.waitAcked.mockImplementation(() => pending.promise);
    const logger = memoryLogger();
    const start = performance.now();
    const result = await suspendRunner(runner, { deadlineMs: 40, logger });
    expect(result.deadlinePassed).toBe(true);
    expect(performance.now() - start).toBeGreaterThanOrEqual(30);
    expect(performance.now() - start).toBeLessThan(500);
    expect(logger.entries.some((entry) => entry.message.includes('deadline'))).toBe(true);
    pending.reject(new Error('late failure'));
    await Bun.sleep(10);
  }
});

test('logs failures and never rejects', async () => {
  for (const stage of ['pause', 'stopAgents', 'status', 'waitAcked'] as const) {
    const runner: SuspendHandle = handle();
    runner[stage] = () => {
      throw new Error(`${stage} failed`);
    };
    const logger = memoryLogger();
    const result = await suspendRunner(runner, { deadlineMs: 100, logger });
    expect(result.deadlinePassed).toBe(false);
    expect(logger.entries.some((entry) => entry.fields.error === `${stage} failed`)).toBe(true);
  }
});

test('suspends two attempts after their pushes, oldest WIP first, then reports and resumes both on hello', async () => {
  const adapter = waitingAdapter();
  const s = await startTestService({ config: { capacity: 2 }, host: { adapters: [adapter] } });
  const runner = s.service.runner!;
  const id = await online(s.service);
  const first = startAttempt(s, id);
  await waitFor(() => runner.status().attempts.some((a) => a.attemptId === first.id && a.phase === 'turn'));
  const second = startAttempt(s, id);
  await waitFor(() => runner.status().attempts.filter((a) => a.phase === 'turn').length === 2);
  for (const launch of adapter.launches) writeFileSync(join(launch.clone, 'initial.txt'), 'initial WIP\n');
  await runner.pushWipNow();
  const firstClone = adapter.launches.find((launch) => launch.attemptId === first.id)!.clone;
  writeFileSync(join(firstClone, 'recent.txt'), 'new WIP\n');
  await runner.pushWipNow();
  const pushed = runner.status().attempts;
  expect(pushed.find((a) => a.attemptId === first.id)!.lastPushAt!).toBeGreaterThan(
    pushed.find((a) => a.attemptId === second.id)!.lastPushAt!,
  );
  for (const launch of adapter.launches) writeFileSync(join(launch.clone, 'final.txt'), `${launch.attemptId}\n`);
  const exit = await s.service.suspend('upgrade');
  expect(exit).toEqual({ code: 0, clean: true, reason: 'upgrade' });
  expect(lastExit(s)).toMatchObject(exit);
  expect(exits(s).map((event) => event.attemptId)).toEqual([second.id, first.id]);
  for (const event of exits(s)) {
    expect(event.data).toMatchObject({ cause: 'suspend', handoffWritten: false, pushError: null });
    expect(event.data.finalWip).not.toBeNull();
    const final = event.data.finalWip!;
    expect((await gitIn(s.hub.ctx.config.projectRepo, ['rev-parse', final.ref])).trim()).toBe(final.sha);
    expect(
      events(s).some(
        (e) =>
          e.type === 'attempt.wip' && e.attemptId === event.attemptId && e.seq < event.seq && e.data.sha === final.sha,
      ),
    ).toBe(true);
    expect(getAttempt(s.hub.ctx, event.attemptId!)).toMatchObject({ status: 'running', wipSha: final.sha });
  }
  expect(readDb(s, (db) => new Outbox(db).ackedSeq())).toBeGreaterThanOrEqual(exits(s).at(-1)!.seq);
  const hellos = observeHellos();
  const resumed = waitingAdapter();
  const next = await s.start({ adapters: [resumed] });
  await online(next);
  for (const attempt of [first, second]) {
    expect(hellos[0]!.attempts).toContainEqual(
      expect.objectContaining({
        attemptId: attempt.id,
        state: 'suspended',
        clone: true,
      }),
    );
    await waitFor(() => getAttempt(s.hub.ctx, attempt.id).status === 'running');
    expect(getAttempt(s.hub.ctx, attempt.id).fence.counter).toBeGreaterThan(attempt.fence.counter);
  }
  await waitFor(() => resumed.launches.length === 2);
  expect(resumed.launches.every((launch) => launch.resume !== null)).toBe(true);
  await next.suspend('done');
});

test('control suspend answers at once; concurrent stops join it and arriving commands stay unjournaled', async () => {
  let free = 100_000_000_000;
  const s = await startTestService({ host: { freeBytes: () => free } });
  const runner = s.service.runner!;
  const id = await online(s.service);
  const release = Promise.withResolvers<number[]>();
  const stopping = mock(() => release.promise);
  runner.stopAgents = stopping;
  try {
    expect(await controlRequest(s.paths, 'POST', '/suspend')).toBeNull();
    expect(stopping).toHaveBeenCalledWith('suspend', { handoff: false });
    expect(readLockOwner(s.paths)).not.toBeNull();
    const joined = s.service.stop('too late');
    expect(s.service.suspend('also too late')).toBe(joined);
    free = 0;
    runner.status();
    await Bun.sleep(20);
    expect(stopping).toHaveBeenCalledTimes(1);
    tx(s.hub.ctx, (emit) => patchRunnerSettings(s.hub.ctx, emit, id, { capacity: 3 }, 'user:alice'));
    const command = pendingCommands(s.hub.ctx, id, 1).find((c) => c.kind === 'update_settings')!;
    await waitFor(() => findCommand(s.hub.ctx, command.id)?.sentAt !== null);
    await Bun.sleep(100);
    expect(readDb(s, (db) => new Journal(db).get(command.id))).toBeNull();
    expect(runner.status().settings.capacity).toBe(s.config.capacity);
    release.resolve([]);
    expect(await joined).toEqual({ code: 0, clean: true, reason: 'suspend requested' });
    free = 100_000_000_000;
    const next = await s.start();
    await online(next);
    await waitFor(() => findCommand(s.hub.ctx, command.id)?.status === 'done');
    expect(readDb(s, (db) => new Journal(db).get(command.id))?.state).toBe('done');
    expect(next.runner!.status().settings.capacity).toBe(3);
  } finally {
    release.resolve([]);
  }
});

test('a final push that hangs past the deadline does not delay the exit; the hub resumes the attempt in its clone', async () => {
  const adapter = waitingAdapter();
  // The stop reaches the push after the agent's interrupt and group signal, about a second in.
  const suspend = 3_000;
  const s = await startTestService({ config: { timings: { suspend } }, host: { adapters: [adapter] } });
  const id = await online(s.service);
  const attempt = startAttempt(s, id);
  await waitFor(() => s.service.runner!.status().attempts.some((a) => a.phase === 'turn'));
  const clone = adapter.launches[0]!.clone;
  writeFileSync(join(clone, 'final.txt'), 'unpushed\n');
  // M2b's real stop path runs; the origin holds its final WIP push until the test releases it, then refuses it.
  const gate = tempDir('agf-hook-');
  const hook = join(s.hub.ctx.config.projectRepo, 'hooks', 'pre-receive');
  writeFileSync(
    hook,
    `#!/bin/sh\ntouch '${gate}/entered'\nwhile [ ! -e '${gate}/release' ]; do sleep 0.05; done\nexit 1\n`,
    { mode: 0o755 },
  );
  const release = () => {
    rmSync(hook, { force: true });
    writeFileSync(join(gate, 'release'), '');
  };
  afterThisTest(release);
  const runner = s.service.runner!;
  const stopAgents = runner.stopAgents.bind(runner);
  let stopping: Promise<unknown> = Promise.resolve();
  runner.stopAgents = (cause, options) => {
    const stop = stopAgents(cause, options);
    stopping = stop.catch(() => {});
    return stop;
  };
  const start = performance.now();
  expect(await s.service.suspend('deadline')).toEqual({
    code: 0,
    clean: true,
    reason: 'deadline',
  });
  expect(performance.now() - start).toBeLessThan(suspend + 1_500);
  expect(existsSync(join(gate, 'entered'))).toBe(true);
  expect(lastExit(s)).toMatchObject({ code: 0, clean: true });
  expect(readLockOwner(s.paths)).toBeNull();
  expect(readFileSync(s.paths.runnerLog, 'utf8')).toContain('"deadlinePassed":true');
  expect(exits(s)).toEqual([]);
  // The leftover stop ends against a closed runner before the next start opens the same clone.
  release();
  await stopping;
  const hellos = observeHellos();
  const resumed = waitingAdapter();
  const next = await s.start({ adapters: [resumed] });
  await online(next);
  expect(hellos[0]!.attempts).toContainEqual(
    expect.objectContaining({
      attemptId: attempt.id,
      state: 'stopped',
      clone: true,
    }),
  );
  await waitFor(() => resumed.launches.length === 1 && getAttempt(s.hub.ctx, attempt.id).status === 'running');
  expect(resumed.launches[0]!.clone).toBe(clone);
  expect(readFileSync(join(clone, 'final.txt'), 'utf8')).toBe('unpushed\n');
  expect(getAttempt(s.hub.ctx, attempt.id).fence.counter).toBeGreaterThan(attempt.fence.counter);
});

test('an empty suspend still answers the control request; a prior stop retains its reason', async () => {
  const s = await startTestService();
  await online(s.service);
  expect(await controlRequest(s.paths, 'POST', '/suspend')).toBeNull();
  expect(await s.service.exited).toEqual({ code: 0, clean: true, reason: 'suspend requested' });
  const next = await s.start();
  await online(next);
  const stop = next.stop('plain stop');
  expect(next.suspend('too late')).toBe(stop);
  expect(await stop).toEqual({ code: 0, clean: true, reason: 'plain stop' });
});

test('teardown does not wait past the suspend budget for an in-flight retention consolidation', async () => {
  let now = Date.now();
  let sweep = () => {};
  const s = await startTestService({
    config: { timings: { suspend: 60 } },
    host: {
      now: () => now,
      clock: {
        ...systemClock,
        setInterval: (fn, ms) => {
          if (ms === RETENTION.checkIntervalMs) sweep = fn;
          return systemClock.setInterval(fn, ms);
        },
      },
    },
  });
  await online(s.service);
  await waitFor(() => s.terminal.some((line) => line.includes('retention sweep finished')));
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<{ pruned: boolean }>();
  s.service.runner!.vault.consolidate = () => {
    entered.resolve();
    return release.promise;
  };
  now += RETENTION.sweepIntervalMs;
  sweep();
  try {
    await entered.promise;
    const start = performance.now();
    expect(await s.service.suspend('retention busy')).toMatchObject({ code: 0, clean: true });
    expect(performance.now() - start).toBeLessThan(600);
    expect(readLockOwner(s.paths)).toBeNull();
  } finally {
    release.resolve({ pruned: false });
    await waitFor(() => s.terminal.filter((line) => line.includes('retention sweep finished')).length === 2);
  }
});

test('suspend during startup is a plain clean stop, and a prior refusal retains its exit', async () => {
  const s = await setupTestService();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const starting = s.start({
    fetch: async (input, init) => {
      entered.resolve();
      await release.promise;
      return fetch(input, init);
    },
  });
  try {
    await entered.promise;
    expect(await controlRequest(s.paths, 'POST', '/suspend')).toBeNull();
  } finally {
    release.resolve();
  }
  const service = await starting;
  expect(await service.exited).toEqual({ code: 0, clean: true, reason: 'suspend requested' });
  const refused = await startTestService({ noCredentials: true });
  expect(await refused.service.suspend('late')).toEqual(await refused.service.exited);
});
