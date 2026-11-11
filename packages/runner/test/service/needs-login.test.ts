// Login expiry keeps the service alive; M2b owns the probe, WIP gate and reconnect nudge.
import { afterEach, beforeEach, expect, mock, setDefaultTimeout, spyOn, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CREDENTIALS_FILE } from '@agflow/core';
import { getAttempt } from '@agflow/hub/src/attempt-store';
import { createSession, deleteSession } from '@agflow/hub/src/auth';
import { getRunner } from '@agflow/hub/src/runners';
import { getTask } from '@agflow/hub/src/task-store';
import { createTasks } from '@agflow/hub/src/tasks';
import { newTask } from '@agflow/hub/test/helpers';
import { FakeAdapter, gitIn, originRepo } from '@agflow/testkit';
import { AttemptStore } from '../../src/attempt-store';
import { systemClock } from '../../src/clock';
import { openRunnerDb } from '../../src/db';
import { memoryLogger } from '../../src/log';
import * as healthModule from '../../src/ops/health';
import { Outbox } from '../../src/outbox';
import type { RunnerHandle } from '../../src/runner';
import { controlRequest } from '../../src/service/control';
import type { RunnerService } from '../../src/service/host';
import { readLockOwner } from '../../src/service/lock';
import { NeedsLogin } from '../../src/service/needs-login';
import { fixtureAgentToken, waitFor } from '../fixture';
import { startRunnerAttempt, startTestHub } from '../hub-fixture';
import { afterThisTest, cleanupRunnerSetups } from '../runner-setup';
import { recordingExec, setupTestService, startTestService } from '../service-helpers';

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
const nudge = 'the agflow hub is reachable again; retry the tool that failed';

async function online(service: RunnerService) {
  if (service.runner === null) throw new Error(`service did not start: ${(await service.exited).reason}`);
  await waitFor(() => service.runner?.status().link === 'online');
  return service.runner!.status().runnerId!;
}

function readDb<T>(s: Setup, read: (db: ReturnType<typeof openRunnerDb>) => T): T {
  const db = openRunnerDb(s.paths.db);
  try {
    return read(db);
  } finally {
    db.close();
  }
}

function waitingAdapter() {
  const messages = new Map<string, string[]>();
  const interrupts = new Map<string, number>();
  const adapter = new FakeAdapter({
    vendor: 'codex',
    skipAuthChecks: true,
    script: { turns: [[{ do: 'sleep', ms: 120_000 }], [{ do: 'sleep', ms: 120_000 }]] },
  });
  const start = adapter.start.bind(adapter);
  adapter.start = async (launch) => {
    const session = await start(launch);
    messages.set(launch.attemptId, []);
    interrupts.set(launch.attemptId, 0);
    const send = session.send.bind(session);
    session.send = async (message) => {
      messages.get(launch.attemptId)!.push(message.text);
      await send(message);
    };
    const interrupt = session.interrupt.bind(session);
    session.interrupt = async () => {
      interrupts.set(launch.attemptId, interrupts.get(launch.attemptId)! + 1);
      await interrupt();
    };
    return session;
  };
  return { adapter, messages, interrupts };
}

// Real notification mode forbids short runner.json timings; shorten only the probe timer at its clock seam.
function fastLoginProbes() {
  const schedule = systemClock.setTimeout;
  const timer = spyOn(systemClock, 'setTimeout').mockImplementation((fn, ms) => schedule(fn, ms === 60_000 ? 30 : ms));
  afterThisTest(() => timer.mockRestore());
}

function observeHealth() {
  let health: healthModule.ServiceHealth;
  const create = healthModule.createServiceHealth;
  const observer = spyOn(healthModule, 'createServiceHealth').mockImplementation((options) => {
    health = create(options);
    return health;
  });
  afterThisTest(() => observer.mockRestore());
  return () => health;
}

for (const withinGrace of [true, false]) {
  test(`revoked login interrupts all turns; WIP ${withinGrace ? 'pushes in grace' : 'waits for welcome'}`, async () => {
    const origin = await originRepo({ 'README.md': '# demo\n', 'src/app.ts': 'app\n' });
    afterThisTest(() => origin.remove());
    const hub = startTestHub({
      config: { projectName: 'demo', projectRepo: origin.path, wipGraceMs: withinGrace ? 30_000 : 1_500 },
    });
    afterThisTest(() => hub.stop());
    fastLoginProbes();
    const health = observeHealth();
    const { adapter, messages, interrupts } = waitingAdapter();
    const exec = recordingExec();
    let probes = 0;
    let delayProbe = false;
    const s = await startTestService({
      hub,
      config: {
        test: undefined,
        keepAwake: 'off',
        capacity: 2,
      },
      host: {
        adapters: [adapter],
        exec,
        platform: 'darwin',
        fetch: async (input, init) => {
          if (String(input).endsWith('/api/runner/whoami')) {
            probes++;
            // No ack arrives after the link closes. Real time ages the runner's ack, not the hub's fake clock.
            if (delayProbe) {
              delayProbe = false;
              await Bun.sleep(1_650);
            }
          }
          return fetch(input, init);
        },
      },
    });
    const id = await online(s.service);
    const attempts = [0, 1].map(() => {
      const [task] = createTasks(hub.ctx, [newTask()], 'user:alice');
      return startRunnerAttempt(hub.ctx, { runnerId: id, taskId: task!.id, role: 'worker', vendor: 'codex' }).attempt;
    });
    await waitFor(() => s.service.runner!.status().attempts.filter((a) => a.phase === 'turn').length === 2);
    for (const launch of adapter.launches) writeFileSync(join(launch.clone, 'saved.txt'), `${launch.attemptId}\n`);
    const spec = {
      ...readDb(s, (db) => new AttemptStore(db).get(attempts[0]!.id)!.spec),
      agentToken: fixtureAgentToken(attempts[0]!.id),
    };
    expect(await health().admit(spec)).toBeNull();
    delayProbe = !withinGrace;
    deleteSession(hub.ctx, hub.token);
    hub.ctx.link.closeRunner(id, 1012, 'reconnect after revocation');
    await waitFor(() => s.service.runner!.status().link === 'needs_login');
    expect(s.service.needsLogin!.state()).toMatchObject({
      on: true,
      since: expect.any(Number),
      reason: 'the hub refused the CLI token',
    });
    const firstState = s.service.needsLogin!.state();
    expect(getRunner(hub.ctx, id).state).toBe('needs_login');
    expect(await health().admit(spec)).toBe('needs_login');
    await waitFor(() => attempts.every((a) => interrupts.get(a.id) === 1));
    await waitFor(() => s.service.runner!.status().attempts.every((a) => a.wipSha !== null));
    await waitFor(() => probes >= 5);
    expect(s.service.needsLogin!.state()).toEqual(firstState);
    expect(exec.calls).toHaveLength(1);
    expect(exec.calls[0]!.argv.join(' ')).toContain(`agflow login --hub ${hub.url}`);
    const log = readFileSync(s.paths.runnerLog, 'utf8');
    expect(log).toContain('sign-in expired or was revoked');
    expect(log).toContain(`agflow login --hub ${hub.url}`);
    for (const attempt of attempts) {
      expect(messages.get(attempt.id)).toEqual([]);
      expect(interrupts.get(attempt.id)).toBe(1);
      const status = s.service.runner!.status().attempts.find((a) => a.attemptId === attempt.id)!;
      if (withinGrace) {
        await waitFor(
          () => s.service.runner!.status().attempts.find((a) => a.attemptId === attempt.id)!.pushedSha !== null,
        );
        expect((await gitIn(origin.path, ['rev-parse', attempt.wipRef!])).trim()).toBe(status.wipSha!);
      } else {
        expect(status.pushedSha).toBeNull();
        expect((await gitIn(origin.path, ['show-ref'])).includes(attempt.wipRef!)).toBe(false);
      }
      // The offline event is queued; the hub learns the SHA only after the next welcome.
      expect(getTask(hub.ctx, attempt.taskId!).workSha).toBeNull();
    }
    expect(readDb(s, (db) => new Outbox(db).eventsAfter(0)).some((e) => e.type === 'attempt.exited')).toBe(false);
    const token = createSession(hub.ctx, hub.owner, 'cli');
    writeFileSync(join(s.configDir, CREDENTIALS_FILE), JSON.stringify({ ...hub.credentials, token }));
    await online(s.service);
    expect(s.service.needsLogin!.state()).toEqual({ on: false, since: null, reason: null });
    expect(await health().admit(spec)).toBeNull();
    expect(getRunner(hub.ctx, id).state).toBe('online');
    for (const attempt of attempts) {
      await waitFor(() => messages.get(attempt.id)!.length === 1);
      await waitFor(() => getTask(hub.ctx, attempt.taskId!).workSha !== null);
      const sha = getTask(hub.ctx, attempt.taskId!).workSha!;
      expect((await gitIn(origin.path, ['show', `${sha}:saved.txt`])).trim()).toBe(attempt.id);
      expect(getAttempt(hub.ctx, attempt.id)).toMatchObject({ status: 'running', wipSha: sha });
    }
    const welcomes = () => readFileSync(s.paths.runnerLog, 'utf8').split('runner link {"state":"online"').length;
    const before = welcomes();
    hub.ctx.link.closeRunner(id, 1012, 'one more welcome');
    await waitFor(() => welcomes() > before);
    await online(s.service);
    await Bun.sleep(100);
    for (const attempt of attempts) expect(messages.get(attempt.id)).toEqual([nudge]);
    expect(exec.calls).toHaveLength(1);
  });
}

test('a service without credentials waits, notifies once, and connects when the file appears', async () => {
  fastLoginProbes();
  const exec = recordingExec();
  const s = await setupTestService({
    mode: 'service',
    noCredentials: true,
    config: { test: undefined, keepAwake: 'off' },
    host: { exec, platform: 'darwin' },
  });
  let returned = false;
  const starting = s.start().then((service) => {
    returned = true;
    return service;
  });
  try {
    await waitFor(
      () => existsSync(s.paths.runnerLog) && readFileSync(s.paths.runnerLog, 'utf8').includes('agflow login'),
    );
    await Bun.sleep(150);
    expect(returned).toBe(false);
    expect(readLockOwner(s.paths)).toMatchObject({ pid: process.pid, mode: 'service' });
    expect(await controlRequest(s.paths, 'GET', '/health')).toMatchObject({ link: 'needs_login', runnerId: null });
    expect(exec.calls).toHaveLength(1);
    expect(exec.calls[0]!.argv.join(' ')).toContain('not signed in');
    expect(readFileSync(s.paths.runnerLog, 'utf8')).toContain('waiting');
  } finally {
    writeFileSync(join(s.configDir, CREDENTIALS_FILE), JSON.stringify(s.hub.credentials));
    await starting;
  }
  const service = await starting;
  await online(service);
  expect(service.needsLogin!.state().on).toBe(false);
  expect(exec.calls).toHaveLength(1);
});

test('a service whose credentials.json is not valid JSON waits in needs_login and connects once it is', async () => {
  fastLoginProbes();
  const exec = recordingExec();
  const s = await setupTestService({
    mode: 'service',
    noCredentials: true,
    config: { test: undefined, keepAwake: 'off' },
    host: { exec, platform: 'darwin' },
  });
  // agflow login truncates before it writes: a probe can read an empty or partial file.
  writeFileSync(join(s.configDir, CREDENTIALS_FILE), '{');
  const starting = s.start();
  try {
    await waitFor(
      () => existsSync(s.paths.runnerLog) && readFileSync(s.paths.runnerLog, 'utf8').includes('run agflow login'),
    );
    await Bun.sleep(150);
    expect(readLockOwner(s.paths)).toMatchObject({ pid: process.pid, mode: 'service' });
    expect(await controlRequest(s.paths, 'GET', '/health')).toMatchObject({ link: 'needs_login', runnerId: null });
    expect(exec.calls).toHaveLength(1);
    expect(exec.calls[0]!.argv.join(' ')).toContain('is not valid JSON');
    const log = readFileSync(s.paths.runnerLog, 'utf8');
    expect(log).toContain('cannot read the CLI credentials');
    expect(log).toContain('is not valid JSON; run agflow login --hub <url>');
  } finally {
    writeFileSync(join(s.configDir, CREDENTIALS_FILE), JSON.stringify(s.hub.credentials));
  }
  const service = await starting;
  await online(service);
  expect(service.needsLogin!.state().on).toBe(false);
  expect(exec.calls).toHaveLength(1);
  await service.stop('done');
  expect(await service.exited).toMatchObject({ code: 0, clean: true });
});

test('suspend cancels the credential wait on the host clock and releases the lock cleanly', async () => {
  const timers = new Map<object, () => void>();
  const s = await setupTestService({
    mode: 'service',
    noCredentials: true,
    host: {
      clock: {
        ...systemClock,
        setTimeout: (fn) => {
          const id = {};
          timers.set(id, fn);
          return id;
        },
        clearTimeout: (id) => {
          timers.delete(id as object);
        },
      },
    },
  });
  // A previous run's hub is still useful in the sign-in instructions without credentials.json.
  const db = openRunnerDb(s.paths.db);
  db.setMeta('project', { hubUrl: s.hub.url, name: 'demo', repo: s.hub.ctx.config.projectRepo });
  db.close();
  const starting = s.start();
  await waitFor(() => timers.size === 1);
  expect(readFileSync(s.paths.runnerLog, 'utf8')).toContain(`agflow login --hub ${s.hub.url}`);
  expect(await controlRequest(s.paths, 'POST', '/suspend')).toBeNull();
  const service = await starting;
  expect(await service.exited).toEqual({ code: 0, clean: true, reason: 'suspend requested' });
  expect(service.runner).toBeNull();
  expect(timers.size).toBe(0);
  expect(readLockOwner(s.paths)).toBeNull();
  expect(existsSync(s.paths.socket)).toBe(false);
});

test('needs_login is once per stretch, survives failed side effects, and does not wait for notifications', async () => {
  let now = 100;
  const logger = memoryLogger();
  const health = { setNeedsLogin: mock((_on: boolean) => {}) };
  const notice = Promise.withResolvers<void>();
  const notifier = { notify: mock(() => notice.promise) };
  const runner = {
    interruptAgents: mock(async (_options: { outage: boolean }) => {
      throw new Error('interrupt failed');
    }),
    pushWipNow: mock(async () => {
      throw new Error('push failed');
    }),
  } satisfies Pick<RunnerHandle, 'interruptAgents' | 'pushWipNow'>;
  let current: typeof runner | null = null;
  const state = new NeedsLogin({
    health,
    notifier,
    logger,
    runner: () => current,
    hubUrl: () => 'https://hub',
    now: () => now,
  });
  state.leave();
  state.enter('not signed in');
  expect(state.state()).toEqual({ on: true, since: 100, reason: 'not signed in' });
  state.leave();
  current = runner;
  state.enter('expired');
  await waitFor(() => runner.pushWipNow.mock.calls.length === 1);
  now += 600_000;
  state.enter('repeated');
  expect(state.state()).toEqual({ on: true, since: 100, reason: 'expired' });
  expect(runner.interruptAgents).toHaveBeenCalledTimes(1);
  expect(runner.interruptAgents).toHaveBeenCalledWith({ outage: true });
  expect(notifier.notify).toHaveBeenCalledTimes(2);
  expect(logger.entries.some((e) => e.fields.error === 'interrupt failed')).toBe(true);
  expect(logger.entries.some((e) => e.fields.error === 'push failed')).toBe(true);
  notice.reject(new Error('notification failed'));
  await waitFor(() => logger.entries.some((e) => e.fields.error === 'notification failed'));
  state.leave();
  expect(health.setNeedsLogin.mock.calls.map(([on]) => on)).toEqual([true, false, true, false]);
  expect(state.state()).toEqual({ on: false, since: null, reason: null });
});

test('the log and the notification say why from the reason', async () => {
  for (const [reason, why] of [
    ['the hub refused the CLI token', 'the sign-in expired or was revoked'],
    ['the CLI has no credentials for this hub', 'the CLI has no credentials for this hub'],
    ['not signed in', 'not signed in; waiting for credentials.json'],
  ]) {
    const logger = memoryLogger();
    const notifier = { notify: mock(async (_notice: { body: string }) => {}) };
    const state = new NeedsLogin({
      health: { setNeedsLogin: () => {} },
      notifier,
      logger,
      runner: () => null,
      hubUrl: () => 'https://hub',
    });
    state.enter(reason!);
    const body = `${why}; run agflow login --hub https://hub`;
    expect(logger.entries.find((entry) => entry.level === 'warn')?.message).toEndWith(body);
    expect(notifier.notify.mock.calls[0]![0].body).toEndWith(body);
    if (reason !== 'the hub refused the CLI token') {
      expect(logger.entries.some((entry) => entry.message.includes('expired or was revoked'))).toBe(false);
    }
  }
});
