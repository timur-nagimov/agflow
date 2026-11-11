// The service host (design 7.1, X-41) against the in-process hub: one lock holder, the control socket, the run
// record, and the exit policy for refusals, replacements, stops, signals and errors.
import { afterEach, describe, expect, mock, setDefaultTimeout, test } from 'bun:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CREDENTIALS_FILE, PROTOCOL_VERSION } from '@agflow/core';
import { getAttempt } from '@agflow/hub/src/attempt-store';
import { createSession, sessionHashOf } from '@agflow/hub/src/auth';
import { findRunnerByKey, getRunner } from '@agflow/hub/src/runners';
import { createTasks } from '@agflow/hub/src/tasks';
import { newTask } from '@agflow/hub/test/helpers';
import { connectFakeRunnerWs } from '@agflow/hub/test/fake-runner';
import { FakeAdapter } from '@agflow/testkit';
import { AttemptStore } from '../../src/attempt-store';
import { loadRunnerConfig } from '../../src/config';
import { openRunnerDb } from '../../src/db';
import { Outbox } from '../../src/outbox';
import { controlRequest } from '../../src/service/control';
import type { RunnerService } from '../../src/service/host';
import { readLockOwner } from '../../src/service/lock';
import { ServiceRuns } from '../../src/service/runs';
import { FIXTURE_AGFLOW, waitFor } from '../fixture';
import { startRunnerAttempt } from '../hub-fixture';
import { afterThisTest, cleanupRunnerSetups } from '../runner-setup';
import { setupTestService, startTestService } from '../service-helpers';

afterEach(cleanupRunnerSetups);
setDefaultTimeout(60_000);

async function online(service: RunnerService) {
  await waitFor(() => service.runner?.status().link === 'online');
  return service.runner!.status().runnerId!;
}

function lastExit(paths: RunnerService['paths']) {
  return new ServiceRuns(paths).lastExit({ running: false });
}

/** Reads runner.db beside the host's own connection. */
function readDb<T>(paths: RunnerService['paths'], read: (db: ReturnType<typeof openRunnerDb>) => T): T {
  const db = openRunnerDb(paths.db);
  try {
    return read(db);
  } finally {
    db.close();
  }
}

/** The agent groups runner.db registers. */
function registeredGroups(paths: RunnerService['paths']) {
  return readDb(paths, (db) => new AttemptStore(db).processes());
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function register(s: Awaited<ReturnType<typeof setupTestService>>, machineId = s.config.machineId) {
  const fake = await connectFakeRunnerWs(s.hub.url, { runnerKey: s.config.runnerKey, machineId, token: s.hub.token });
  afterThisTest(() => fake.disconnect());
  expect(fake.welcome).not.toBeNull();
  return fake;
}

describe('startRunnerService', () => {
  test('says hello, serves health, and releases everything on an idempotent stop', async () => {
    const s = await startTestService();
    const runnerId = await online(s.service);
    expect(getRunner(s.hub.ctx, runnerId)).toMatchObject({ state: 'online', name: 'laptop' });
    expect(findRunnerByKey(s.hub.ctx, s.config.runnerKey)?.machine_id).toBe('MACHINE-1');
    const health = await controlRequest(s.paths, 'GET', '/health');
    const startedAt = expect.any(String);
    expect(health).toEqual({ pid: process.pid, mode: 'foreground', startedAt, runnerId, link: 'online' });
    const exit = await s.service.stop('finished');
    expect(exit).toEqual({ code: 0, clean: true, reason: 'finished' });
    expect(await s.service.stop('again')).toEqual(exit);
    expect(await s.service.exited).toEqual(exit);
    expect(readLockOwner(s.paths)).toBeNull();
    expect(existsSync(s.paths.socket)).toBe(false);
    expect(lastExit(s.paths)).toMatchObject(exit);
    expect(readFileSync(s.paths.runnerLog, 'utf8')).toContain('info finished');
  });

  test('a second foreground start reports the holder without writing its log or history', async () => {
    const s = await startTestService();
    await online(s.service);
    const runs = new ServiceRuns(s.paths);
    const before = readFileSync(runs.path, 'utf8');
    const log = readFileSync(s.paths.runnerLog, 'utf8');
    const second = await s.start();
    const reason = `the runner is already running (pid ${process.pid}); use agflow runner status`;
    expect(second.runner).toBeNull();
    expect(await second.exited).toMatchObject({ code: 1, reason });
    expect(s.terminal.join('')).toContain(reason);
    expect(readFileSync(runs.path, 'utf8')).toBe(before);
    expect(readFileSync(s.paths.runnerLog, 'utf8')).toBe(log);
  });

  test('a service start waits for the lock and starts after the holder stops', async () => {
    const s = await startTestService();
    await online(s.service);
    let started = false;
    const waiting = s.start({ mode: 'service', lockPollMs: 10 }).then((service) => {
      started = true;
      return service;
    });
    await Bun.sleep(70);
    expect(started).toBe(false);
    expect(s.terminal.join('')).toContain(`pid ${process.pid}`);
    await s.service.stop('handover');
    const second = await waiting;
    await online(second);
    expect(second.mode).toBe('service');
    expect(new ServiceRuns(s.paths).records()).toHaveLength(2);
  });

  test('missing credentials are a clean refusal in foreground', async () => {
    const s = await startTestService({ noCredentials: true });
    const exit = await s.service.exited;
    const reason = 'not signed in; run agflow login --hub <url>';
    expect(exit).toEqual({ code: 1, clean: true, reason });
    expect(lastExit(s.paths)).toMatchObject(exit);
    expect(s.terminal.join('')).toContain(exit.reason);
    expect(existsSync(s.paths.socket)).toBe(false);
  });

  test('an unreadable credentials.json is a clean refusal in foreground', async () => {
    const s = await setupTestService({ noCredentials: true });
    writeFileSync(join(s.configDir, CREDENTIALS_FILE), '{');
    const service = await s.start();
    const exit = await service.exited;
    expect(exit).toMatchObject({ code: 1, clean: true });
    expect(exit.reason).toContain('is not valid JSON; run agflow login');
    expect(lastExit(s.paths)).toMatchObject(exit);
    expect(existsSync(s.paths.socket)).toBe(false);
  });

  for (const mode of ['foreground', 'service'] as const) {
    test(`a machine mismatch is a clean refusal in ${mode}`, async () => {
      const s = await startTestService({ mode, config: { machineId: 'OTHER' } });
      const exit = await s.service.exited;
      expect(exit).toMatchObject({ code: mode === 'service' ? 0 : 1, clean: true });
      expect(exit.reason.endsWith('run agflow runner setup')).toBe(true);
      expect(lastExit(s.paths)).toMatchObject(exit);
      expect(s.service.runner).toBeNull();
      expect(findRunnerByKey(s.hub.ctx, s.config.runnerKey)).toBeNull();
      expect(readLockOwner(s.paths)).toBeNull();
    });

    for (const invalid of ['missing', 'invalid'] as const) {
      test(`${invalid} runner.json is a clean refusal in ${mode}`, async () => {
        const s = await setupTestService({ mode });
        if (invalid === 'missing') rmSync(s.paths.config);
        else writeFileSync(s.paths.config, '{"capacity":0}');
        const service = await s.start();
        const exit = await service.exited;
        expect(exit).toMatchObject({ code: mode === 'service' ? 0 : 1, clean: true });
        expect(service.runner).toBeNull();
        expect(lastExit(s.paths)).toMatchObject(exit);
        expect(readLockOwner(s.paths)).toBeNull();
      });
    }

    for (const refusal of ['another machine', 'retired'] as const) {
      test(`4403 for ${refusal} keeps the hub reason in ${mode}`, async () => {
        const s = await setupTestService({ mode });
        const fake = await register(s, refusal === 'another machine' ? 'OTHER' : 'MACHINE-1');
        fake.disconnect();
        if (refusal === 'retired') {
          const response = await fetch(`${s.hub.url}/api/runner/retire`, {
            method: 'POST',
            headers: { authorization: `Bearer ${s.hub.token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ runnerKey: s.config.runnerKey }),
          });
          expect(response.ok).toBe(true);
        }
        const service = await s.start();
        const exit = await service.exited;
        const reason =
          refusal === 'retired'
            ? 'this runner was retired; run agflow runner setup'
            : 'this runner belongs to alice on another machine; run agflow runner setup';
        expect(exit).toEqual({ code: mode === 'service' ? 0 : 1, clean: true, reason });
        expect(lastExit(s.paths)).toMatchObject(exit);
        const log = readFileSync(s.paths.runnerLog, 'utf8');
        expect(log).toContain('4403');
        expect(log).toContain(`error ${reason}`);
      });
    }

    test(`4426 is a clean refusal in ${mode}`, async () => {
      const s = await setupTestService({ mode });
      s.hub.ctx.config.minProtocol = PROTOCOL_VERSION + 1;
      const service = await s.start();
      const exit = await service.exited;
      const reason =
        `runner protocol ${PROTOCOL_VERSION} is not supported: ` +
        `this hub accepts protocol ${PROTOCOL_VERSION + 1} to ${PROTOCOL_VERSION}`;
      expect(exit).toEqual({ code: mode === 'service' ? 0 : 1, clean: true, reason });
      expect(lastExit(s.paths)).toMatchObject(exit);
      expect(readFileSync(s.paths.runnerLog, 'utf8')).toContain('4426');
    });
  }

  test('4409 from a replacement connection records a clean exit with code zero', async () => {
    const s = await startTestService();
    await online(s.service);
    await register(s);
    const exit = await s.service.exited;
    expect(exit).toEqual({ code: 0, clean: true, reason: 'another connection replaced this one' });
    expect(lastExit(s.paths)).toMatchObject(exit);
    expect(readFileSync(s.paths.runnerLog, 'utf8')).toContain('4409');
    expect(readLockOwner(s.paths)).toBeNull();
  });

  for (const end of ['4409', 'retire'] as const) {
    test(`after ${end} no agent outlives the service`, async () => {
      // Mid-turn, the agent ignores the end of its input, as Claude does: closing the runner alone would leave it.
      const adapter = new FakeAdapter({
        vendor: 'codex',
        skipAuthChecks: true,
        script: { turns: [[{ do: 'sleep', ms: 120_000 }]], ignoreEofMidTurn: true },
      });
      const s = await startTestService({ mode: 'service', host: { adapters: [adapter] } });
      const runnerId = await online(s.service);
      const [task] = createTasks(s.hub.ctx, [newTask()], 'user:alice');
      const spec = { runnerId, taskId: task!.id, role: 'worker', vendor: 'codex' } as const;
      const { attempt } = startRunnerAttempt(s.hub.ctx, spec);
      await waitFor(() => getAttempt(s.hub.ctx, attempt.id).status === 'running');
      await waitFor(() => s.service.runner!.status().attempts.some((a) => a.phase === 'turn'));
      const groups = await waitFor(() => {
        const groups = registeredGroups(s.paths);
        return groups.length > 0 ? groups : null;
      });
      if (end === '4409') {
        await register(s);
      } else {
        const response = await fetch(`${s.hub.url}/api/runner/retire`, {
          method: 'POST',
          headers: { authorization: `Bearer ${s.hub.token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ runnerKey: s.config.runnerKey }),
        });
        expect(response.ok).toBe(true);
      }
      expect(await s.service.exited).toMatchObject({ code: 0, clean: true });
      expect(registeredGroups(s.paths)).toEqual([]);
      expect(groups.filter((group) => alive(group.pid))).toEqual([]);
      // Stopped, not only killed: one exit for the hub's next welcome (a retire's own stop may come first).
      const exits = readDb(s.paths, (db) => new Outbox(db).eventsAfter(0)).filter((e) => e.type === 'attempt.exited');
      expect(exits).toEqual([expect.objectContaining({ attemptId: attempt.id })]);
      if (end === '4409') expect(exits[0]?.data).toMatchObject({ cause: 'runner_stop', handoffWritten: false });
    });
  }

  test('constructs adapters with the config, paths and agflow command when none are injected', async () => {
    const adapter = new FakeAdapter({ vendor: 'codex', skipAuthChecks: true, script: { turns: [[]] } });
    const factory = mock(() => [adapter]);
    const s = await setupTestService({ host: { createAdapters: factory } });
    const config = loadRunnerConfig(s.paths.config);
    const service = await s.start();
    const runnerId = await online(service);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith(config, s.paths, { agflow: FIXTURE_AGFLOW });
    expect(getRunner(s.hub.ctx, runnerId)?.vendors.map((v) => v.vendor)).toEqual(['codex']);
  });

  test('injected adapters bypass the factory', async () => {
    const factory = mock(() => {
      throw new Error('must not be called');
    });
    const s = await startTestService({ host: { adapters: [], createAdapters: factory } });
    await online(s.service);
    expect(factory).not.toHaveBeenCalled();
  });

  test('a createRunner failure records an unclean exit and releases the socket, db and lock', async () => {
    const fetch = async () => {
      throw new Error('project unavailable\ntry later');
    };
    const s = await startTestService({ host: { fetch } });
    const exit = await s.service.exited;
    expect(exit).toMatchObject({ code: 1, clean: false });
    expect(exit.reason).toContain('cannot read the project from the hub');
    expect(exit.reason).not.toContain('\n');
    expect(lastExit(s.paths)).toMatchObject(exit);
    expect(s.service.runner).toBeNull();
    expect(existsSync(s.paths.socket)).toBe(false);
    expect(readLockOwner(s.paths)).toBeNull();
    const restarted = await s.start({ fetch: undefined });
    await online(restarted);
  });

  test('a failed close still releases later resources and records an unclean exit', async () => {
    const s = await startTestService();
    await online(s.service);
    const close = s.service.runner!.close;
    s.service.runner!.close = async () => {
      await close();
      throw new Error('close failed');
    };
    expect(await s.service.stop('done')).toEqual({ code: 1, clean: false, reason: 'close failed' });
    expect(lastExit(s.paths)).toMatchObject({ code: 1, clean: false, reason: 'close failed' });
    expect(readLockOwner(s.paths)).toBeNull();
    expect(existsSync(s.paths.socket)).toBe(false);
  });

  test('health is available before hello, which re-reads credentials changed during startup', async () => {
    const s = await setupTestService();
    const token = createSession(s.hub.ctx, s.hub.owner, 'cli');
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
      const health = await controlRequest(s.paths, 'GET', '/health');
      expect(health).toMatchObject({ pid: process.pid, mode: 'foreground', runnerId: null, link: 'idle' });
      writeFileSync(join(s.configDir, CREDENTIALS_FILE), JSON.stringify({ ...s.hub.credentials, token }));
    } finally {
      resume.resolve();
      await starting;
    }
    await online(await starting);
    expect(findRunnerByKey(s.hub.ctx, s.config.runnerKey)?.session_hash).toBe(sessionHashOf(token));
  });

  test('process handlers are opt-in and are removed when the service ends', async () => {
    const names = ['SIGTERM', 'SIGINT', 'uncaughtException', 'unhandledRejection'] as const;
    const before = names.map((name) => process.listeners(name));
    const s = await startTestService();
    expect(names.map((name) => process.listeners(name))).toEqual(before);
    await s.service.stop('restart with signals');
    const service = await s.start({ signals: true });
    for (const [index, name] of names.entries()) {
      expect(process.listeners(name)).toHaveLength(before[index]!.length + 1);
    }
    await service.stop('done');
    expect(names.map((name) => process.listeners(name))).toEqual(before);
  });

  for (const cause of ['SIGTERM', 'SIGINT', 'exception', 'rejection'] as const) {
    test(`${cause} records the exit and releases a child service`, async () => {
      const s = await setupTestService();
      const child = Bun.spawn([process.execPath, join(import.meta.dir, 'run-service.ts')], {
        env: { ...process.env, AGFLOW_HOME: s.paths.home, AGFLOW_CONFIG_DIR: s.configDir, AGFLOW_TEST_FAILURE: cause },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      afterThisTest(async () => {
        if (child.exitCode === null) child.kill('SIGKILL');
        await child.exited;
      });
      const stderr = new Response(child.stderr).text();
      const reader = child.stdout.getReader();
      let output = '';
      while (!output.includes('online\n')) {
        const { done, value } = await reader.read();
        if (done) throw new Error(`child ended before online: ${await stderr}`);
        output += new TextDecoder().decode(value);
      }
      reader.releaseLock();
      const clean = cause === 'SIGTERM' || cause === 'SIGINT';
      if (clean) child.kill(cause);
      expect(await child.exited).toBe(clean ? 0 : 1);
      const reason = clean ? `received ${cause}` : `child ${cause === 'exception' ? 'uncaught' : 'unhandled'} ${cause}`;
      expect(lastExit(s.paths)).toMatchObject({ code: clean ? 0 : 1, clean, reason });
      expect(readLockOwner(s.paths)).toBeNull();
      expect(existsSync(s.paths.socket)).toBe(false);
    });
  }
});

test('the host forwards the injected CLI version to launches, durable records and spawned events', async () => {
  const adapter = new FakeAdapter({ vendor: 'codex', skipAuthChecks: true, script: { turns: [[]] } });
  const s = await startTestService({ host: { adapters: [adapter], cliVersion: (vendor) => `fixture-${vendor}` } });
  const runnerId = await online(s.service);
  const [task] = createTasks(s.hub.ctx, [newTask()], 'user:alice');
  const { attempt } = startRunnerAttempt(s.hub.ctx, { runnerId, taskId: task!.id, role: 'worker', vendor: 'codex' });
  await waitFor(() => readDb(s.paths, (db) => new Outbox(db).eventsAfter(0).some(
    (event) => event.type === 'attempt.spawned' && event.attemptId === attempt.id,
  )));
  expect(adapter.launches[0]!.cliVersion).toBe('fixture-codex');
  expect(readDb(s.paths, (db) => new AttemptStore(db).get(attempt.id)!.cliVersion)).toBe('fixture-codex');
  expect(readDb(s.paths, (db) => new Outbox(db).eventsAfter(0))).toContainEqual(expect.objectContaining({
    type: 'attempt.spawned', attemptId: attempt.id, data: expect.objectContaining({ cliVersion: 'fixture-codex' }),
  }));
});
