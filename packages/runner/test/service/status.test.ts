import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createTasks } from '@agflow/hub/src/tasks';
import { newTask } from '@agflow/hub/test/helpers';
import { AttemptStore } from '../../src/attempt-store';
import { openRunnerDb } from '../../src/db';
import { GB } from '../../src/ops/health';
import type { RunnerStatus } from '../../src/runner';
import { controlRequest } from '../../src/service/control';
import { plistPath } from '../../src/service/launchd';
import { acquireRunnerLock } from '../../src/service/lock';
import { ServiceRuns } from '../../src/service/runs';
import {
  buildStatusReport,
  formatStatus,
  offlineStatus,
  parseLaunchdDisabled,
  type RunnerStatusReport,
} from '../../src/service/status';
import { waitFor } from '../fixture';
import { startRunnerAttempt } from '../hub-fixture';
import { afterThisTest, cleanupRunnerSetups, tempDir } from '../runner-setup';
import { recordingExec, setupTestService, startTestService } from '../service-helpers';

afterEach(cleanupRunnerSetups);
setDefaultTimeout(60_000);

const disabledOutput = (value: string) => `disabled services = {
  "com.apple.SafariLaunchAgent" => enabled
  "dev.agflow.runner.extra" => disabled
  "dev.agflow.runner"   => ${value}
  "com.example.other" => true
}`;

for (const [value, expected] of [
  ['disabled', true],
  ['true', true],
  ['enabled', false],
  ['false', false],
] as const) {
  test(`parseLaunchdDisabled reads ${value} from recorded launchctl output`, () => {
    expect(parseLaunchdDisabled(disabledOutput(value))).toBe(expected);
  });
}

test('disabled parsing matches a whole label, including custom labels', () => {
  expect(parseLaunchdDisabled('"dev.agflow.runner.extra" => disabled')).toBeNull();
  expect(parseLaunchdDisabled('"devXagflowXrunner" => true')).toBeNull();
  expect(parseLaunchdDisabled('  "scratch.runner" => true', 'scratch.runner')).toBe(true);
  expect(parseLaunchdDisabled('')).toBeNull();
});

test('buildStatusReport uses phases for slots, projects safe fields and keeps process identities flat', async () => {
  const s = await setupTestService();
  const attempts: RunnerStatus['attempts'] = ['turn', 'idle', null].map((phase, i) => ({
    attemptId: `attempt-${i}`,
    taskId: `task-${i}`,
    role: 'worker',
    vendor: 'codex',
    state: 'running',
    phase: phase as 'turn' | 'idle' | null,
    wipSha: 'abc',
    pushedSha: 'def',
    lastPushAt: 8_000,
    pushError: i === 2 ? 'push refused' : null,
    lateWorkSha: i === 2 ? 'abc' : null,
    process: i === 0 ? { pid: 123, pgid: 123, lstart: 'Tue Nov 10 12:00:00 2026' } : null,
    agentToken: 'agent-secret',
  }));
  const status: RunnerStatus = {
    runnerId: 'runner-1',
    link: 'online',
    state: { state: 'ok', detail: null },
    settings: { ...s.config, capacity: 4 },
    vendors: [],
    git: { ready: true, problem: null, lastPushAt: null },
    attempts,
  };
  // attempt-1 runs again after a resume with its old pushError; only the ended attempt-2 keeps its clone.
  const records = attempts.map((a, i) => ({
    attemptId: a.attemptId,
    createdAt: 5_000,
    state: i === 2 ? ('ended' as const) : ('running' as const),
    clone: `/clones/${a.attemptId}`,
    pushError: i === 1 ? 'stale push error' : a.pushError,
    lateWorkSha: a.lateWorkSha,
    spec: { agentToken: 'agent-secret' },
  }));
  const report = buildStatusReport({
    status,
    config: s.config,
    hubUrl: s.hub.url,
    owner: { pid: 42, mode: 'foreground', startedAt: new Date(1_000).toISOString() },
    health: status.state,
    heartbeat: { power: null, disk: null, acceptingUntil: 2_000 },
    needsLogin: { on: false, reason: null, since: null },
    keepAwakeHeld: true,
    dependencyPrep: true,
    records,
    existingClones: ['/clones/attempt-1', '/clones/attempt-2'],
    now: 10_000,
  });
  // 'turn' and 'idle' hold slots and the null phase does not, with no clamping at zero.
  expect(report).toMatchObject({ running: true, startedAt: 1_000, capacity: 4, freeSlots: 2, acceptingUntil: 12_000 });
  expect(report.attempts[0]).toMatchObject({ ageMs: 5_000, pid: 123, pgid: 123, lstart: attempts[0]!.process!.lstart });
  expect(report.attempts[1]).toMatchObject({ pid: null, pgid: null, lstart: null });
  expect(report.attempts.map((a) => a.lateWorkSha)).toEqual([null, null, 'abc']);
  expect(report.keptClones).toEqual([{ attemptId: 'attempt-2', clone: '/clones/attempt-2', error: 'push refused' }]);
  expect(JSON.stringify(report)).not.toContain('agent-secret');
  expect(formatStatus(report)).toContain('push refused');
});

test('GET /status shows health, power, disk, preparation and current settings', async () => {
  const s = await startTestService({ config: { minFreeGb: 10 }, host: { freeBytes: () => 7 * GB } });
  await waitFor(() => s.service.runner?.status().link === 'online');
  await s.service.runner!.changeSettings({ capacity: 4, draining: true, keepAwake: 'off' });
  const report = await controlRequest<RunnerStatusReport>(s.paths, 'GET', '/status');
  expect(report).toMatchObject({
    running: true,
    runnerId: s.service.runner!.status().runnerId,
    name: 'laptop',
    hubUrl: s.hub.url,
    state: 'disk_low',
    draining: true,
    capacity: 4,
    freeSlots: 4,
    power: { source: 'ac', batteryPercent: 100, lowPowerMode: false },
    disk: { freeBytes: 7 * GB, agflowBytes: 1_000_000 },
    keepAwake: { mode: 'off', held: false },
    dependencyPrep: true,
  });
  const text = formatStatus(report);
  expect(text).toContain('disk_low: 7.0 GB free, below the 10 GB minimum');
  for (const value of ['Power', 'Disk', 'Keep-awake', 'codex', 'claude']) {
    expect(text).toContain(value);
  }
});

test('GET /status shows the persistent crash-loop reason', async () => {
  const s = await setupTestService();
  const runs = new ServiceRuns(s.paths);
  for (let i = 0; i < 3; i++) {
    const id = runs.start({ pid: process.pid, mode: 'service' });
    runs.finish(id, { clean: false, code: 1, reason: `crash ${i}` });
  }
  await s.start();
  const report = await controlRequest<RunnerStatusReport>(s.paths, 'GET', '/status');
  expect(report).toMatchObject({ state: 'crash_loop', draining: true });
  expect(formatStatus(report)).toContain('crash 2');
});

test('GET /status answers while the service waits for credentials', async () => {
  const s = await setupTestService({ mode: 'service', noCredentials: true });
  const starting = s.start();
  try {
    await waitFor(() => existsSync(s.paths.socket));
    const report = await controlRequest<RunnerStatusReport>(s.paths, 'GET', '/status');
    expect(formatStatus(report)).toContain('not signed in; run agflow login');
    expect(report).toMatchObject({
      running: true,
      pid: process.pid,
      mode: 'service',
      link: 'needs_login',
      attempts: [],
      needsLogin: { on: true, reason: 'not signed in', since: expect.any(Number) },
    });
  } finally {
    await controlRequest(s.paths, 'POST', '/suspend');
    await starting;
  }
});

test('offline status reads installed plist, finished exit, last 20 lines and Login Items without writes', async () => {
  const s = await setupTestService();
  const home = tempDir('agf-home-');
  const plist = plistPath({ home });
  mkdirSync(dirname(plist), { recursive: true });
  writeFileSync(plist, 'installed');
  const runs = new ServiceRuns(s.paths, { now: () => 1_700_000_000_000 });
  const id = runs.start({ pid: 42, mode: 'service' });
  runs.finish(id, { reason: 'machine mismatch', code: 0, clean: true });
  writeFileSync(s.paths.runnerLog, Array.from({ length: 25 }, (_, i) => `line ${i}\n`).join(''));
  const history = readFileSync(runs.path, 'utf8');
  const exec = recordingExec([
    { argv: ['launchctl', 'print-disabled', 'gui/501'], result: { stdout: disabledOutput('disabled') } },
  ]);
  const report = await offlineStatus({ paths: s.paths, home, uid: 501, exec });
  expect(report).toMatchObject({
    running: false,
    bestEffort: true,
    plistInstalled: true,
    disabled: true,
    lockHolder: null,
    lastExit: { reason: 'machine mismatch', at: 1_700_000_000_000, code: 0, clean: true },
  });
  expect(report.logLines).toEqual(Array.from({ length: 20 }, (_, i) => `line ${i + 5}`));
  expect(report.warnings).toHaveLength(1);
  expect(formatStatus(report)).toContain('best effort');
  expect(formatStatus(report)).toContain(new Date(1_700_000_000_000).toISOString());
  expect(formatStatus(report)).toContain('Login Items');
  expect(exec.calls[0]?.options?.timeoutMs).toBeGreaterThan(0);
  expect(readFileSync(runs.path, 'utf8')).toBe(history);
});

test('offline status distinguishes an unanswered lock holder from an abandoned run and unknown launchd', async () => {
  const s = await setupTestService();
  const runs = new ServiceRuns(s.paths, { now: () => 1_000 });
  runs.start({ pid: process.pid, mode: 'service' });
  const lock = await acquireRunnerLock(s.paths, { mode: 'service' });
  afterThisTest(() => lock.release());
  const options = { paths: s.paths, home: tempDir('agf-home-'), exec: recordingExec([], { exitCode: 1 }) };
  expect(await offlineStatus(options)).toMatchObject({
    disabled: null,
    plistInstalled: false,
    lastExit: null,
    lockHolder: { pid: process.pid, mode: 'service' },
    logLines: [],
  });
  lock.release();
  expect(await offlineStatus(options)).toMatchObject({
    lockHolder: null,
    lastExit: { at: 1_000, clean: false, reason: 'exited without a clean shutdown' },
  });
});

test('GET /status lists a retained failed-push clone only while it exists', async () => {
  const s = await startTestService();
  await waitFor(() => s.service.runner?.status().link === 'online');
  // Leave the queued start untouched: this test supplies an ended record whose final push failed.
  s.service.runner!.pause();
  const [task] = createTasks(s.hub.ctx, [newTask()], 'user:alice');
  const { command } = startRunnerAttempt(s.hub.ctx, {
    runnerId: s.service.runner!.status().runnerId!,
    taskId: task!.id,
    role: 'worker',
    vendor: 'codex',
  });
  if (command.command.kind !== 'start_attempt') throw new Error('expected start_attempt');
  const clone = tempDir('agf-kept-');
  const db = openRunnerDb(s.paths.db);
  try {
    const store = new AttemptStore(db);
    const record = store.create(command.command.attempt, { clone, tmpDir: null, cliVersion: null });
    store.update(record.attemptId, { state: 'ended', endedAt: Date.now(), pushError: 'remote refused final push' });
    const report = await controlRequest<RunnerStatusReport>(s.paths, 'GET', '/status');
    if (!report.running) throw new Error('expected a running service');
    expect(report.keptClones).toEqual([{ attemptId: record.attemptId, clone, error: 'remote refused final push' }]);
    expect(report.freeSlots).toBe(report.capacity);
    expect(report.attempts[0]).toMatchObject({ pid: null, pgid: null, lstart: null, phase: null, state: 'ended' });
    store.update(record.attemptId, { pushError: null, lateWorkSha: 'pending-sha' });
    expect(await controlRequest(s.paths, 'GET', '/status')).toMatchObject({
      keptClones: [{ attemptId: record.attemptId, clone, error: 'final work pending-sha has not reached a late-work ref yet' }],
    });
    rmSync(clone, { recursive: true });
    expect(await controlRequest(s.paths, 'GET', '/status')).toMatchObject({ keptClones: [] });
  } finally {
    db.close();
  }
});
