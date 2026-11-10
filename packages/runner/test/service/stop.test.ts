import { afterEach, beforeEach, expect, mock, setDefaultTimeout, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getAttempt } from '@agflow/hub/src/attempt-store';
import { getRunner } from '@agflow/hub/src/runners';
import { createTasks, getTask } from '@agflow/hub/src/tasks';
import { newTask } from '@agflow/hub/test/helpers';
import { FakeAdapter, gitIn } from '@agflow/testkit';
import { AttemptStore } from '../../src/attempt-store';
import { loadRunnerConfig, saveRunnerConfig } from '../../src/config';
import { openRunnerDb } from '../../src/db';
import { memoryLogger } from '../../src/log';
import { Outbox } from '../../src/outbox';
import type { RunnerHandle } from '../../src/runner';
import { controlRequest, startControlServer } from '../../src/service/control';
import { plistPath } from '../../src/service/launchd';
import { acquireRunnerLock, readLockOwner } from '../../src/service/lock';
import { drainAndStopAgents, restartRunner, stopReason, stopRunner, stopWaitMs } from '../../src/service/stop';
import { compileServiceCli, verifyServiceMain } from '../../scripts/verify-service';
import { waitFor } from '../fixture';
import { startRunnerAttempt } from '../hub-fixture';
import { afterThisTest, cleanupRunnerSetups, tempDir } from '../runner-setup';
import { recordingExec, setupTestService, startTestService } from '../service-helpers';

setDefaultTimeout(60_000);
afterEach(cleanupRunnerSetups);
beforeEach(() => {
  const previous = process.env.AGFLOW_TEST;
  process.env.AGFLOW_TEST = '1';
  afterThisTest(() => {
    if (previous === undefined) delete process.env.AGFLOW_TEST;
    else process.env.AGFLOW_TEST = previous;
  });
});

const target = 'gui/501/dev.agflow.runner';
function launchctl(loaded = true) {
  return recordingExec([{ argv: ['launchctl', 'print', target], result: { exitCode: loaded ? 0 : 1 } }]);
}

function handle() {
  let link = 'online';
  const calls: string[] = [];
  const runner = {
    changeSettings: mock(async () => {
      calls.push('drain');
      return 2;
    }),
    pause: mock(() => {
      calls.push('pause');
    }),
    stopAgents: mock(async () => {
      calls.push('stop');
      return [3, 7];
    }),
    waitAcked: mock(async (seq: number, _ms: number) => {
      calls.push(`ack ${seq}`);
      return true;
    }),
    status: () => ({ link }) as ReturnType<RunnerHandle['status']>,
  };
  return {
    runner,
    calls,
    offline: () => {
      link = 'backoff';
    },
  };
}

test('drain ack precedes pause and handoff; the final cumulative ack follows the exits', async () => {
  const { runner, calls } = handle();
  expect(await drainAndStopAgents(runner, { logger: memoryLogger() })).toEqual({
    drainAcked: true,
    seqs: [3, 7],
    exitsAcked: true,
    errors: [],
  });
  expect(calls).toEqual(['drain', 'ack 2', 'pause', 'stop', 'ack 7']);
  expect(runner.changeSettings).toHaveBeenCalledWith({ draining: true });
  expect(runner.stopAgents).toHaveBeenCalledWith('runner_stop', { handoff: true });
});

test('offline drain warns and still stops; disconnects end short ack waits', async () => {
  for (const initiallyOffline of [true, false]) {
    const { runner, offline } = handle();
    const logger = memoryLogger();
    if (initiallyOffline) offline();
    else
      runner.waitAcked.mockImplementation(async () => {
        offline();
        return false;
      });
    const result = await drainAndStopAgents(runner, { logger, drainAckMs: 50, exitsAckMs: 50 });
    expect(result.drainAcked).toBe(false);
    expect(result.seqs).toEqual([3, 7]);
    expect(logger.entries.some((entry) => entry.message.includes('acknowledge the drain'))).toBe(true);
    expect(runner.waitAcked.mock.calls.length).toBe(initiallyOffline ? 0 : 1);
  }
});

test('ack expiry and drain failures do not prevent stopping, even if logging fails', async () => {
  const { runner } = handle();
  runner.waitAcked.mockImplementation(async (_seq, ms) => {
    await Bun.sleep(ms);
    return false;
  });
  const result = await drainAndStopAgents(runner, { logger: memoryLogger(), drainAckMs: 10, exitsAckMs: 10 });
  expect(result).toMatchObject({ drainAcked: false, exitsAcked: false, seqs: [3, 7] });
  runner.changeSettings.mockRejectedValue(new Error('settings failed'));
  const logger = memoryLogger();
  logger.warn = () => {
    throw new Error('log failed');
  };
  expect((await drainAndStopAgents(runner, { logger, exitsAckMs: 0 })).errors).toContain('settings failed');
  expect(runner.stopAgents).toHaveBeenCalledTimes(2);
});

for (const drained of [false, true]) {
  test(`stop restores only its own drain (owner drained: ${drained})`, async () => {
    const s = await startTestService({ config: { draining: drained } });
    const runner = s.service.runner!;
    await waitFor(() => runner.status().link === 'online');
    // drainAndStopAgents catches what stopAgents throws, so the mock records and the test asserts afterwards.
    let hubDraining: boolean | undefined;
    runner.stopAgents = mock(async () => {
      hubDraining = getRunner(s.hub.ctx, runner.status().runnerId!).draining;
      return [];
    });
    expect(await controlRequest(s.paths, 'POST', '/stop')).toBeNull();
    expect(await s.service.exited).toEqual({ code: 0, clean: true, reason: 'runner stop requested' });
    expect(hubDraining).toBe(true);
    expect(loadRunnerConfig(s.paths.config).draining).toBe(drained);
    expect(readLockOwner(s.paths)).toBeNull();
  });
}

for (const offline of [false, true]) {
  test(`stop hands off a running agent and records its final work (offline: ${offline})`, async () => {
    const sends: string[] = [];
    const adapter = new FakeAdapter({
      vendor: 'codex',
      skipAuthChecks: true,
      script: { turns: [[], [{ do: 'text', text: 'handoff complete' }]] },
    });
    const start = adapter.start.bind(adapter);
    adapter.start = async (launch) => {
      const session = await start(launch);
      const send = session.send.bind(session);
      session.send = async (text) => {
        sends.push(JSON.stringify(text));
        return send(text);
      };
      return session;
    };
    const s = await startTestService({
      host: { adapters: [adapter], stopDrainAckMs: offline ? 30 : 1_000, stopExitsAckMs: offline ? 30 : 1_000 },
    });
    const runner = s.service.runner!;
    await waitFor(() => runner.status().link === 'online');
    const runnerId = runner.status().runnerId!;
    const [task] = createTasks(s.hub.ctx, [newTask()], 'user:alice');
    const { attempt } = startRunnerAttempt(s.hub.ctx, { runnerId, taskId: task!.id, role: 'worker', vendor: 'codex' });
    await waitFor(() => runner.status().attempts.some((a) => a.attemptId === attempt.id && a.phase === 'idle'));
    writeFileSync(join(adapter.launches[0]!.clone, 'final.txt'), 'final work\n');
    let hubDraining: boolean | undefined;
    if (offline) {
      await s.hub.stop();
      await waitFor(() => runner.status().link !== 'online');
    } else {
      const stop = runner.stopAgents.bind(runner);
      runner.stopAgents = async (cause, options) => {
        hubDraining = getRunner(s.hub.ctx, runnerId).draining;
        return stop(cause, options);
      };
    }
    // The CLI's stop: the drain warnings come back to the person who asked, not only to the runner's log.
    const log: string[] = [];
    await stopRunner({ env: {}, paths: s.paths, uid: 501, exec: launchctl(false), log: (line) => log.push(line), pollMs: 5 });
    expect(await s.service.exited).toMatchObject({ code: 0, clean: true });
    if (offline) {
      expect(log).toContain(
        'the runner exited: runner stop requested; the hub did not acknowledge the drain and may end the attempts as lost',
      );
    } else {
      expect(hubDraining).toBe(true);
      expect(log).toContain('the runner exited: runner stop requested');
    }
    expect(sends.some((text) => text.includes('agflow is stopping this attempt: the runner is stopping'))).toBe(true);
    const db = openRunnerDb(s.paths.db);
    try {
      const outbox = new Outbox(db);
      const events = outbox.eventsAfter(0);
      const exit = events.find((event) => event.type === 'attempt.exited')!;
      expect(exit.data.cause).toBe('runner_stop');
      if (offline) {
        expect(readFileSync(s.paths.runnerLog, 'utf8')).toContain('acknowledge the drain');
        const record = new AttemptStore(db).get(attempt.id)!;
        // This fresh disconnect is still inside canPushWip's grace: the local origin accepts the final WIP.
        expect(record.pushError).toBeNull();
        const final = exit.data.finalWip!;
        expect(final).not.toBeNull();
        expect((await gitIn(s.hub.ctx.config.projectRepo, ['show', `${final.ref}:final.txt`])).trim()).toBe(
          'final work',
        );
      } else {
        const final = exit.data.finalWip!;
        expect(final).not.toBeNull();
        expect(events.some((e) => e.type === 'attempt.wip' && e.seq < exit.seq && e.data.sha === final.sha)).toBe(true);
        expect((await gitIn(s.hub.ctx.config.projectRepo, ['rev-parse', final.ref])).trim()).toBe(final.sha);
        expect(outbox.ackedSeq()).toBeGreaterThanOrEqual(exit.seq);
        expect(getAttempt(s.hub.ctx, attempt.id)).toMatchObject({
          status: 'ended',
          endReason: 'stopped',
          failureClass: 'infra',
          failureSignature: null,
        });
        expect(getTask(s.hub.ctx, task!.id)).toMatchObject({ status: 'ready', nextDispatchAt: null });
      }
    } finally {
      db.close();
    }
    expect(loadRunnerConfig(s.paths.config).draining).toBe(false);
  });
}

for (const loaded of [false, true]) {
  for (const running of [false, true]) {
    test(`stop running=${running}, loaded=${loaded} only boots out a loaded job after the lock is free`, async () => {
      const s = await setupTestService();
      if (running) {
        const service = await s.start();
        await waitFor(() => service.runner?.status().link === 'online');
      }
      const exec = launchctl(loaded);
      const log: string[] = [];
      const result = await stopRunner({ env: {},
        paths: s.paths,
        uid: 501,
        exec: async (argv, options) => {
          expect(readLockOwner(s.paths)).toBeNull();
          return exec(argv, options);
        },
        log: (line) => log.push(line),
        pollMs: 5,
      });
      expect(result).toEqual({ wasRunning: running, bootedOut: loaded, disabled: loaded });
      expect(exec.calls.map((call) => call.argv)).toEqual([
        ['launchctl', 'print', target],
        ...(loaded
          ? [
              ['launchctl', 'bootout', target],
              ['launchctl', 'disable', target],
            ]
          : []),
      ]);
      if (!running) expect(log.join('')).toContain('no runner is running');
    });
  }
}

test('stop disables an installed plist that launchd has not loaded, so the next login does not start it', async () => {
  const s = await setupTestService();
  const home = tempDir('agf-home-');
  const exec = launchctl(false);
  expect(await stopRunner({ env: {}, paths: s.paths, uid: 501, exec, home })).toEqual({
    wasRunning: false,
    bootedOut: false,
    disabled: false,
  });
  mkdirSync(dirname(plistPath({ home })), { recursive: true });
  writeFileSync(plistPath({ home }), 'installed');
  expect(await stopRunner({ env: {}, paths: s.paths, uid: 501, exec, home })).toEqual({
    wasRunning: false,
    bootedOut: false,
    disabled: true,
  });
  expect(exec.calls.map((call) => call.argv)).toEqual([
    ['launchctl', 'print', target],
    ['launchctl', 'print', target],
    ['launchctl', 'disable', target],
  ]);
});

test('the stop wait covers the handoff and one final push per slot, and never drops below 10 minutes', async () => {
  const s = await setupTestService();
  expect(stopWaitMs(s.paths)).toBe(10 * 60_000);
  saveRunnerConfig(s.paths.config, { ...s.config, capacity: 16 });
  // 60 s drain ack + 3 min handoff + 16 × 60 s final pushes + 30 s exit acks + 2 min teardown.
  expect(stopWaitMs(s.paths)).toBe((60 + 180 + 16 * 60 + 30 + 120) * 1_000);
  writeFileSync(s.paths.config, 'not json');
  expect(stopWaitMs(s.paths)).toBe(10 * 60_000);
});

test('stopReason adds every warning the stop met to the reason', () => {
  const clean = { drainAcked: true, seqs: [], exitsAcked: null, errors: [] };
  expect(stopReason('runner stop requested', clean)).toBe('runner stop requested');
  expect(
    stopReason('runner stop requested', { drainAcked: false, seqs: [3], exitsAcked: false, errors: ['boom'] }),
  ).toBe(
    'runner stop requested; the hub did not acknowledge the drain and may end the attempts as lost; ' +
      'the hub did not acknowledge the exits; runner stop failed: boom',
  );
});

test('verify-service rejects extra arguments before doing work', async () => {
  const errors: string[] = [];
  const logs: string[] = [];
  const options = { log: (line: string) => logs.push(line), error: (line: string) => errors.push(line) };
  expect(await verifyServiceMain(['extra'], {}, options)).toBe(1);
  expect(errors).toEqual(['usage: bun run verify:service']);
  expect(logs).toEqual([]);
});

test('restart suspends, keeps the attempt open, and kickstarts only after lock release', async () => {
  const adapter = new FakeAdapter({ vendor: 'codex', skipAuthChecks: true, script: { turns: [[]] } });
  const s = await startTestService({ host: { adapters: [adapter] } });
  await waitFor(() => s.service.runner?.status().link === 'online');
  const [task] = createTasks(s.hub.ctx, [newTask()], 'user:alice');
  const { attempt } = startRunnerAttempt(s.hub.ctx, {
    runnerId: s.service.runner!.status().runnerId!,
    taskId: task!.id,
    role: 'worker',
    vendor: 'codex',
  });
  await waitFor(() => s.service.runner!.status().attempts.some((a) => a.phase === 'idle'));
  const exec = launchctl();
  await restartRunner({ env: {},
    paths: s.paths,
    uid: 501,
    pollMs: 5,
    exec: async (argv, options) => {
      if (argv[1] === 'kickstart') {
        expect(readLockOwner(s.paths)).toBeNull();
        expect(getAttempt(s.hub.ctx, attempt.id).status).toBe('running');
      }
      return exec(argv, options);
    },
  });
  expect(exec.calls.map((call) => call.argv)).toEqual([
    ['launchctl', 'print', target],
    ['launchctl', 'kickstart', '-k', target],
  ]);
  expect(await s.service.exited).toMatchObject({ reason: 'suspend requested' });
});

test('restart without a loaded service leaves a running runner alone and explains install/start', async () => {
  const s = await startTestService();
  const exec = launchctl(false);
  await expect(restartRunner({ env: {}, paths: s.paths, uid: 501, exec })).rejects.toThrow('agflow runner install');
  await expect(restartRunner({ env: {}, paths: s.paths, uid: 501, exec })).rejects.toThrow('agflow runner start');
  expect(readLockOwner(s.paths)).not.toBeNull();
  expect(await controlRequest(s.paths, 'GET', '/health')).toBeDefined();
});

test('unreachable lock holders and timed out stops name the pid without touching launchd', async () => {
  const s = await setupTestService();
  const lock = await acquireRunnerLock(s.paths, { mode: 'foreground' });
  afterThisTest(() => lock.release());
  const exec = launchctl();
  await expect(stopRunner({ env: {}, paths: s.paths, exec })).rejects.toThrow(`pid ${process.pid}`);
  const control = startControlServer({
    paths: s.paths,
    lock,
    routes: { 'GET /health': () => ({}), 'POST /stop': () => null },
  });
  afterThisTest(() => control.stop());
  await expect(stopRunner({ env: {}, paths: s.paths, exec, lockWaitMs: 10, pollMs: 2 })).rejects.toThrow(`pid ${process.pid}`);
  expect(exec.calls).toEqual([]);
});

test('POST /stop during startup is a plain clean stop', async () => {
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
    expect(await controlRequest(s.paths, 'POST', '/stop')).toBeNull();
  } finally {
    release.resolve();
  }
  expect(await (await starting).exited).toEqual({ code: 0, clean: true, reason: 'runner stop requested' });
});

test('a lost link during the exit ack ends the wait promptly', async () => {
  const { runner, offline } = handle();
  runner.waitAcked.mockImplementation(async (seq) => {
    if (seq === 2) return true;
    offline();
    return false;
  });
  expect(await drainAndStopAgents(runner, { logger: memoryLogger(), exitsAckMs: 30_000 })).toMatchObject({
    drainAcked: true,
    exitsAcked: false,
  });
  expect(runner.waitAcked).toHaveBeenCalledTimes(2);
});

test('POST /stop answers while the handoff is pending and concurrent stops share its exit', async () => {
  const s = await startTestService();
  const runner = s.service.runner!;
  await waitFor(() => runner.status().link === 'online');
  const release = Promise.withResolvers<number[]>();
  const stopping = mock(() => release.promise);
  runner.stopAgents = stopping;
  try {
    expect(await controlRequest(s.paths, 'POST', '/stop')).toBeNull();
    await waitFor(() => stopping.mock.calls.length === 1);
    expect(readLockOwner(s.paths)).not.toBeNull();
    const joined = s.service.stop('too late');
    expect(s.service.suspend('also too late')).toBe(joined);
    release.resolve([]);
    expect(await joined).toMatchObject({ code: 0, clean: true, reason: 'runner stop requested' });
  } finally {
    release.resolve([]);
  }
  const next = await s.start();
  await waitFor(() => next.runner?.status().link === 'online');
  await waitFor(() => !getRunner(s.hub.ctx, next.runner!.status().runnerId!).draining);
  expect(next.runner!.status().settings.draining).toBe(false);
});

test('restart kickstarts a loaded service with no running process, using its supplied label', async () => {
  const s = await setupTestService();
  const exec = recordingExec();
  await restartRunner({ env: {}, paths: s.paths, exec, uid: 123, label: 'dev.agflow.scratch' });
  expect(exec.calls.map((call) => call.argv)).toEqual([
    ['launchctl', 'print', 'gui/123/dev.agflow.scratch'],
    ['launchctl', 'kickstart', '-k', 'gui/123/dev.agflow.scratch'],
  ]);
});

test('stop reports a failed bootout rather than claiming the job stopped', async () => {
  const s = await setupTestService();
  const exec = recordingExec([{ argv: ['launchctl', 'bootout', target], result: { exitCode: 1 } }]);
  await expect(stopRunner({ env: {}, paths: s.paths, exec, uid: 501 })).rejects.toThrow('bootout failed');
  expect(exec.calls.some((call) => call.argv[1] === 'disable')).toBe(false);
});

test('stop waits only for the runner it stopped, not for a service that takes the lock after it', async () => {
  const s = await setupTestService();
  // The lock now belongs to this process, standing in for a LaunchAgent that was waiting behind the stopped runner.
  const lock = await acquireRunnerLock(s.paths, { mode: 'service' });
  afterThisTest(() => lock.release());
  const stops: unknown[] = [];
  const control = startControlServer({
    paths: s.paths,
    lock,
    routes: { 'GET /health': () => ({ pid: process.pid + 1 }), 'POST /stop': (body) => void stops.push(body) },
  });
  afterThisTest(() => control.stop());
  const exec = launchctl();
  expect(await stopRunner({ env: {}, paths: s.paths, exec, uid: 501, lockWaitMs: 50, pollMs: 2 })).toEqual({
    wasRunning: true,
    bootedOut: true,
    disabled: true,
  });
  expect(stops).toHaveLength(1);
  expect(exec.calls.map((call) => call.argv[1])).toEqual(['print', 'bootout', 'disable']);
});

for (const running of [false, true]) {
  test(`injected test mode stops without launchd or the installed plist (running: ${running})`, async () => {
    const s = await setupTestService();
    if (running) await s.start();
    const home = tempDir('agf-home-');
    const plist = plistPath({ home });
    mkdirSync(dirname(plist), { recursive: true });
    writeFileSync(plist, 'installed');
    const exec = launchctl();
    const options = { paths: s.paths, home, exec, uid: 501, env: { AGFLOW_TEST: '1' }, pollMs: 5 };
    await expect(restartRunner(options)).rejects.toThrow('no runner service is loaded');
    expect(readLockOwner(s.paths) !== null).toBe(running);
    expect(await stopRunner(options)).toEqual({ wasRunning: running, bootedOut: false, disabled: false });
    expect(exec.calls).toEqual([]);
    expect(readFileSync(plist, 'utf8')).toBe('installed');
  });
}


test('verify-service compiles with cwd autoload disabled, like build:cli', async () => {
  const exec = recordingExec();
  await compileServiceCli('/scratch/agflow', exec);
  expect(exec.calls).toHaveLength(1);
  expect(exec.calls[0]!.argv).toEqual([
    process.execPath, 'build', '--compile', '--no-compile-autoload-bunfig', '--no-compile-autoload-dotenv',
    'packages/cli/src/main.ts', '--outfile', '/scratch/agflow',
  ]);
});
