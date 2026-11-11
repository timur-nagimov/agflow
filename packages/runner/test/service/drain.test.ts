import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CREDENTIALS_FILE } from '@agflow/core';
import { tx } from '@agflow/hub/src/context';
import { getRunner, patchRunnerSettings } from '@agflow/hub/src/runners';
import { systemClock } from '../../src/clock';
import { loadRunnerConfig } from '../../src/config';
import { openRunnerDb } from '../../src/db';
import { memoryLogger } from '../../src/log';
import { Outbox } from '../../src/outbox';
import { controlRequest, startControlServer } from '../../src/service/control';
import { applyCrashLoopGuard, drainRunner, undrainRunner } from '../../src/service/drain';
import type { RunnerService } from '../../src/service/host';
import { acquireRunnerLock, readLockOwner } from '../../src/service/lock';
import { crashLoopVerdict, ServiceRuns } from '../../src/service/runs';
import { waitFor } from '../fixture';
import { afterThisTest, cleanupRunnerSetups } from '../runner-setup';
import { setupTestService, startTestService } from '../service-helpers';

afterEach(cleanupRunnerSetups);
setDefaultTimeout(60_000);

async function online(service: RunnerService) {
  await waitFor(() => service.runner?.status().link === 'online');
  return service.runner!.status().runnerId!;
}

function crashes(runs: ServiceRuns, count = 3) {
  for (let i = 1; i <= count; i++) {
    const id = runs.start({ pid: process.pid, mode: 'service' });
    runs.finish(id, { clean: false, code: 1, reason: `crash ${i}` });
  }
}

test('live drain and undrain persist locally and reach the hub through settings events', async () => {
  const s = await startTestService();
  const id = await online(s.service);
  expect(await drainRunner({ paths: s.paths })).toEqual({ via: 'runner', draining: true });
  expect(loadRunnerConfig(s.paths.config).draining).toBe(true);
  expect(s.service.runner!.status().settings.draining).toBe(true);
  await waitFor(() => getRunner(s.hub.ctx, id).draining);
  expect(await undrainRunner({ paths: s.paths })).toEqual({ via: 'runner', draining: false });
  expect(loadRunnerConfig(s.paths.config).draining).toBe(false);
  await waitFor(() => !getRunner(s.hub.ctx, id).draining);
});

test('offline drain releases the lock and merges with a hub capacity edit on the next welcome', async () => {
  const s = await startTestService();
  const id = await online(s.service);
  await waitFor(() => loadRunnerConfig(s.paths.config).confirmedSettings.version > 0);
  await s.service.stop('offline edit');
  const snapshot = loadRunnerConfig(s.paths.config).confirmedSettings;
  expect(await drainRunner({ paths: s.paths })).toEqual({ via: 'config', draining: true });
  expect(readLockOwner(s.paths)).toBeNull();
  expect(loadRunnerConfig(s.paths.config).confirmedSettings).toEqual(snapshot);
  tx(s.hub.ctx, (emit) => patchRunnerSettings(s.hub.ctx, emit, id, { capacity: 7 }, 'user:alice'));
  await online(await s.start());
  await waitFor(() => {
    const config = loadRunnerConfig(s.paths.config);
    return config.draining && config.capacity === 7 && config.confirmedSettings.draining;
  });
  expect(getRunner(s.hub.ctx, id)).toMatchObject({ draining: true, capacity: 7 });
});

test('three crashes drain before hello; undrain sends state ok and forgets crashes across restart', async () => {
  const s = await setupTestService();
  const runs = new ServiceRuns(s.paths);
  crashes(runs);
  const service = await s.start();
  expect(loadRunnerConfig(s.paths.config).draining).toBe(true);
  const id = await online(service);
  expect(getRunner(s.hub.ctx, id)).toMatchObject({
    state: 'crash_loop',
    lastError: expect.stringContaining('crash 3'),
  });
  await waitFor(() => getRunner(s.hub.ctx, id).draining);
  expect(runs.crashLoop()).toMatchObject({ lastError: 'crash 3' });
  expect(
    readFileSync(s.paths.runnerLog, 'utf8')
      .split('\n')
      .filter((line) => line.includes('error crash_loop')),
  ).toHaveLength(1);
  await undrainRunner({ paths: s.paths });
  await waitFor(() => getRunner(s.hub.ctx, id).state === 'online' && !getRunner(s.hub.ctx, id).draining);
  const db = openRunnerDb(s.paths.db);
  try {
    expect(new Outbox(db).eventsAfter(0)).toContainEqual(
      expect.objectContaining({
        type: 'runner.state',
        data: { state: 'ok', detail: null },
      }),
    );
  } finally {
    db.close();
  }
  expect(loadRunnerConfig(s.paths.config).draining).toBe(false);
  expect(runs.records().at(-1)).not.toHaveProperty('endedAt');
  expect(crashLoopVerdict(runs, { now: Date.now(), window: s.config.timings.crashLoopWindow })).toMatchObject({
    crashLoop: false,
    unclean: 0,
  });
  expect(await service.stop('restart')).toMatchObject({ clean: true });
  await online(await s.start());
  expect(getRunner(s.hub.ctx, id)).toMatchObject({ state: 'online', draining: false });
});

test('a recorded crash loop survives the window and clean restarts until offline undrain', async () => {
  const s = await setupTestService();
  const runs = new ServiceRuns(s.paths, { now: () => Date.now() - 3_600_000 });
  crashes(runs);
  runs.markCrashLoop({ lastError: 'crash 3' });
  const marker = runs.crashLoop();
  for (let i = 0; i < 2; i++) {
    const service = await s.start();
    const id = await online(service);
    expect(getRunner(s.hub.ctx, id)).toMatchObject({
      state: 'crash_loop',
      lastError: expect.stringContaining('crash 3'),
    });
    await waitFor(() => getRunner(s.hub.ctx, id).draining);
    await service.stop('clean stop');
    expect(runs.crashLoop()).toEqual(marker);
  }
  // A last crash without an exit record must also be forgotten while down.
  runs.start({ pid: process.pid, mode: 'service' });
  expect(await undrainRunner({ paths: s.paths })).toEqual({ via: 'config', draining: false });
  expect(readLockOwner(s.paths)).toBeNull();
  expect(runs.crashLoop()).toBeNull();
  expect(runs.records().at(-1)).toMatchObject({ uncleanForgotten: true });
  const id = await online(await s.start());
  await waitFor(() => !getRunner(s.hub.ctx, id).draining);
  expect(getRunner(s.hub.ctx, id)).toMatchObject({ state: 'online', draining: false });
});

test('a service waiting for credentials edits runner.json; once signed in the hub shows the edit', async () => {
  for (const command of [drainRunner, undrainRunner]) {
    const draining = command === drainRunner;
    const s = await setupTestService({
      mode: 'service',
      noCredentials: true,
      // runner.json's loginProbe has a 60 s floor even in test mode; the host's clock shortens the wait.
      host: { clock: { ...systemClock, setTimeout: (fn, ms) => systemClock.setTimeout(fn, ms === 60_000 ? 30 : ms) } },
    });
    const runs = new ServiceRuns(s.paths);
    // An undrain also clears the crash loop, so createRunner does not drain again.
    if (!draining) crashes(runs);
    const starting = s.start();
    await waitFor(async () => {
      try {
        return (await controlRequest<{ link: string }>(s.paths, 'GET', '/health')).link === 'needs_login';
      } catch {
        return false;
      }
    });
    expect(await command({ paths: s.paths })).toEqual({ via: 'runner', draining });
    expect(loadRunnerConfig(s.paths.config).draining).toBe(draining);
    expect(runs.crashLoop()).toBeNull();
    writeFileSync(join(s.configDir, CREDENTIALS_FILE), JSON.stringify(s.hub.credentials));
    const service = await starting;
    const id = await online(service);
    await waitFor(() => getRunner(s.hub.ctx, id).draining === draining);
    expect(getRunner(s.hub.ctx, id)).toMatchObject({ state: 'online', draining });
    // The hub's echo confirms the edit in runner.json after the hub has applied it.
    await waitFor(() => loadRunnerConfig(s.paths.config).confirmedSettings.draining === draining);
    expect(loadRunnerConfig(s.paths.config).draining).toBe(draining);
    await service.stop('done');
  }
});

test('the guard uses the configured window and logs only when it reports a crash loop', async () => {
  const s = await setupTestService({ config: { timings: { crashLoopWindow: 100 } } });
  const runs = new ServiceRuns(s.paths, { now: () => 1_000 });
  crashes(runs);
  const logger = memoryLogger();
  const report: { detail: string | null } = { detail: null };
  const health = {
    setCrashLoop: (value: string | null) => {
      report.detail = value;
    },
  };
  expect(applyCrashLoopGuard({ runs, config: s.config, health, now: 1_100, logger })).toBe(false);
  expect(report.detail).toBeNull();
  expect(logger.entries).toEqual([]);
  expect(applyCrashLoopGuard({ runs, config: s.config, health, now: 1_099, logger })).toBe(true);
  expect(report.detail).toContain('crash 3');
  expect(logger.entries).toHaveLength(1);
  expect(logger.entries[0]?.level).toBe('error');
  expect(runs.crashLoop()).not.toBeNull();
});

for (const command of [drainRunner, undrainRunner]) {
  test(`${command.name} reports the lock holder when no socket answers, without editing files`, async () => {
    const s = await setupTestService();
    const runs = new ServiceRuns(s.paths);
    crashes(runs);
    const before = readFileSync(s.paths.config, 'utf8');
    const history = readFileSync(runs.path, 'utf8');
    const lock = await acquireRunnerLock(s.paths, { mode: 'foreground' });
    afterThisTest(() => lock.release());
    await expect(command({ paths: s.paths })).rejects.toThrow(`pid ${process.pid}`);
    await expect(command({ paths: s.paths })).rejects.toThrow('agflow runner status');
    expect(readFileSync(s.paths.config, 'utf8')).toBe(before);
    expect(readFileSync(runs.path, 'utf8')).toBe(history);
  });

  test(`${command.name} preserves a starting service's error instead of falling back to runner.json`, async () => {
    const s = await setupTestService();
    const requested = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const starting = s.start({
      fetch: async (input, init) => {
        requested.resolve();
        await resume.promise;
        return fetch(input, init);
      },
    });
    try {
      await requested.promise;
      await expect(command({ paths: s.paths })).rejects.toThrow('the runner is starting');
      expect(loadRunnerConfig(s.paths.config).draining).toBe(false);
    } finally {
      resume.resolve();
      await starting;
    }
  });

  test(`${command.name} reports the holder when its socket accepts but never answers`, async () => {
    const s = await setupTestService();
    const before = readFileSync(s.paths.config, 'utf8');
    const lock = await acquireRunnerLock(s.paths, { mode: 'foreground' });
    afterThisTest(() => lock.release());
    const pending = Promise.withResolvers<void>();
    const server = startControlServer({
      paths: s.paths,
      lock,
      routes: { 'POST /drain': () => pending.promise, 'POST /undrain': () => pending.promise },
    });
    afterThisTest(() => {
      pending.resolve();
      server.stop();
    });
    await expect(command({ paths: s.paths, timeoutMs: 20 })).rejects.toThrow(`pid ${process.pid}`);
    expect(readFileSync(s.paths.config, 'utf8')).toBe(before);
  });

  test(`${command.name} releases its offline lock if runner.json cannot be loaded`, async () => {
    const s = await setupTestService();
    rmSync(s.paths.config);
    await expect(command({ paths: s.paths })).rejects.toThrow('agflow runner setup');
    expect(readLockOwner(s.paths)).toBeNull();
  });
}
