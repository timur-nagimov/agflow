import { afterEach, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { getAttempt } from '@agflow/hub/src/attempt-store';
import { findRunnerByKey } from '@agflow/hub/src/runners';
import { createTasks } from '@agflow/hub/src/tasks';
import { newTask } from '@agflow/hub/test/helpers';
import { AttemptStore, type AttemptPatch } from '@agflow/runner/src/attempt-store';
import { saveRunnerConfig } from '@agflow/runner/src/config';
import { openRunnerDb } from '@agflow/runner/src/db';
import { Outbox } from '@agflow/runner/src/outbox';
import { processIdentity } from '@agflow/runner/src/processes';
import { removeAgentTools } from '@agflow/runner/src/run-dir';
import { plistPath } from '@agflow/runner/src/service/launchd';
import { acquireRunnerLock, readLockOwner } from '@agflow/runner/src/service/lock';
import { stopRunner } from '@agflow/runner/src/service/stop';
import { defaultExec, type Exec } from '@agflow/runner/src/service/system';
import { VENDOR_PINS } from '@agflow/runner/src/vendor/pins';
import { waitFor } from '@agflow/runner/test/fixture';
import { addRunnerAttempt, startRunnerAttempt } from '@agflow/runner/test/hub-fixture';
import { afterThisTest, cleanupRunnerSetups, setupRunner, tempDir } from '@agflow/runner/test/runner-setup';
import { fakeVendorCli, setupTestService, sleepingServiceAdapter } from '@agflow/runner/test/service-helpers';
import { parseArgs } from '../src/args';
import { credentialsPath } from '../src/credentials';
import { HubClient } from '../src/hub-client';
import { main } from '../src/main';
import { RUNNER_HELP, runnerCommand } from '../src/runner-command';
import { uninstallRunner, unpushedWork, type RunnerUninstallDeps } from '../src/runner-uninstall';

const MACHINE = '00000000-0000-4000-8000-000000000001';

setDefaultTimeout(60_000);
beforeEach(() => {
  for (const name of ['AGFLOW_HOME', 'AGFLOW_CONFIG_DIR', 'AGFLOW_TEST']) {
    const previous = process.env[name];
    process.env[name] = name === 'AGFLOW_TEST' ? '1' : tempDir('agf-uninstall-env-');
    afterThisTest(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
  }
});
afterEach(cleanupRunnerSetups);

function snapshot(path: string) {
  return { content: readFileSync(path, 'utf8'), mtime: statSync(path).mtimeMs, mode: statSync(path).mode };
}

async function fixture(currentPins = false) {
  const s = await setupTestService({
    config: { machineId: MACHINE },
    host: { adapters: [sleepingServiceAdapter()], machineId: async () => MACHINE },
  });
  process.env.AGFLOW_HOME = s.paths.home;
  process.env.AGFLOW_CONFIG_DIR = s.configDir;
  for (const vendor of ['claude', 'codex'] as const) {
    mkdirSync(s.paths.homes[vendor], { recursive: true });
    s.config.homes[vendor] = realpathSync(s.paths.homes[vendor]);
  }
  saveRunnerConfig(s.paths.config, s.config);
  const home = tempDir('agf-owner-');
  const owned = ['.claude/settings.json', '.codex/auth.json', '.claude.json'].map((file) => join(home, file));
  for (const path of owned) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `owner's credentials: ${path}`);
  }
  owned.push(credentialsPath(s.configDir));
  const before = owned.map(snapshot);
  const unchanged = () => expect(owned.map(snapshot)).toEqual(before);
  const plist = plistPath({ home });
  mkdirSync(dirname(plist), { recursive: true });
  writeFileSync(plist, 'installed');
  const pins = {
    claude: { ...VENDOR_PINS['darwin-arm64']!.claude, ...(!currentPins && { version: '0.0.1' }) },
    codex: { ...VENDOR_PINS['darwin-arm64']!.codex, ...(!currentPins && { version: '0.0.2' }) },
  };
  const claude = fakeVendorCli(s.paths, 'claude', pins.claude.version, [{ argv: ['auth', 'logout'], result: {} }]);
  const codex = fakeVendorCli(s.paths, 'codex', pins.codex.version, [{ argv: ['logout'], result: {} }]);
  let loaded = true;
  // ioreg's answer: this Mac, unless a test copies runner.json from another one.
  const machine = { id: MACHINE };
  const commands: string[][] = [];
  const exec: Exec = async (argv, options) => {
    commands.push(argv);
    if (argv[0] === 'ioreg') {
      return { exitCode: 0, stdout: `"IOPlatformUUID" = "${machine.id}"`, stderr: '', timedOut: false };
    }
    if (argv[0] !== 'launchctl') {
      expect([claude.binary, codex.binary]).toContain(argv[0]!);
      return defaultExec(argv, options);
    }
    const exitCode = argv[1] === 'print' && !loaded ? 1 : 0;
    if (argv[1] === 'bootout') loaded = false;
    return { exitCode, stdout: '', stderr: '', timedOut: false };
  };
  const out: string[] = [];
  const err: string[] = [];
  const io = { out: (line: string) => void out.push(line), err: (line: string) => void err.push(line) };
  const deps: Partial<RunnerUninstallDeps> = {
    paths: s.paths,
    dir: s.configDir,
    home,
    uid: 501,
    exec,
    pins,
    platform: 'darwin-arm64',
    machinePlatform: 'darwin',
    env: { HOME: home, AGFLOW_HOME: s.paths.home, AGFLOW_CONFIG_DIR: s.configDir },
    lockWaitMs: 10_000,
    pollMs: 10,
  };
  const run = (purge = false, overrides: Partial<RunnerUninstallDeps> = {}) =>
    uninstallRunner(parseArgs(['runner', 'uninstall', ...(purge ? ['--purge'] : [])]), io, { ...deps, ...overrides });
  const loggedOut = () => {
    expect(claude.calls()).toHaveLength(1);
    expect(codex.calls()).toHaveLength(1);
    expect(claude.calls()[0]).toMatchObject({
      argv: ['auth', 'logout'],
      env: {
        HOME: home,
        CLAUDE_CONFIG_DIR: s.config.homes.claude,
      },
    });
    expect(codex.calls()[0]).toMatchObject({
      argv: ['logout'],
      env: {
        HOME: s.paths.homes.codexUser,
        CODEX_HOME: s.config.homes.codex,
      },
    });
    unchanged();
  };
  return { ...s, deps, home, plist, claude, codex, io, out, err, commands, run, loggedOut, unchanged, machine };
}

function record(
  store: AttemptStore,
  id: string,
  clone: string | null,
  patch: AttemptPatch = {},
  role: 'worker' | 'lead' = 'worker',
) {
  store.create(
    {
      attemptId: id,
      taskId: 'T-4',
      role,
      vendor: 'codex',
      model: null,
      fence: { epoch: 1, counter: 1 },
      hubUrl: 'http://hub.test',
      repo: { url: '/origin', mainBranch: 'main' },
      start: { ref: 'refs/heads/main', sha: null },
      branch: 'agflow/T-4-task',
      wipRef: 'refs/agflow/T-4/a1',
      restore: { paths: [], base: 'refs/heads/main' },
      acceptanceIds: [],
      toolCaps: { defaultMs: 1000, longMs: 1000, checks: [] },
      taskPack: '',
      brief: '',
      firstPrompt: '',
      successor: false,
    },
    { clone, tmpDir: null, cliVersion: null },
  );
  return store.update(id, patch);
}

test('running uninstall hands off, logs out with pinned binaries, retires open attempts and removes the plist', async () => {
  // The service's retention sweep preserves current pins and removes old, unused versions.
  const s = await fixture(true);
  const service = await s.start();
  await waitFor(() => service.runner?.status().link === 'online');
  const runnerId = service.runner!.status().runnerId!;
  const [task] = createTasks(s.hub.ctx, [newTask()], 'user:alice');
  const { attempt } = startRunnerAttempt(s.hub.ctx, { runnerId, taskId: task!.id, role: 'worker', vendor: 'codex' });
  await waitFor(() => service.runner!.status().attempts.some((a) => a.attemptId === attempt.id && a.phase === 'turn'));
  const unknown = addRunnerAttempt(s.hub.ctx, { runnerId }).attempt;
  expect(await runnerCommand(parseArgs(['runner', 'uninstall']), s.io, { uninstall: s.deps })).toBe(0);
  expect(await service.exited).toMatchObject({ code: 0, clean: true });
  const db = openRunnerDb(s.paths.db);
  try {
    expect(new Outbox(db).eventsAfter(0)).toContainEqual(
      expect.objectContaining({
        type: 'attempt.exited',
        attemptId: attempt.id,
        data: expect.objectContaining({ cause: 'runner_stop' }),
      }),
    );
  } finally {
    db.close();
  }
  expect(getAttempt(s.hub.ctx, attempt.id).endedAt).not.toBeNull();
  expect(getAttempt(s.hub.ctx, unknown.id)).toMatchObject({ status: 'ended', endReason: 'lost' });
  expect(findRunnerByKey(s.hub.ctx, s.config.runnerKey)?.retired_at).not.toBeNull();
  s.loggedOut();
  expect(existsSync(s.plist)).toBe(false);
  expect(s.commands.slice(0, 3)).toEqual([
    ['launchctl', 'print', 'gui/501/dev.agflow.runner'],
    ['launchctl', 'bootout', 'gui/501/dev.agflow.runner'],
    ['launchctl', 'disable', 'gui/501/dev.agflow.runner'],
  ]);
  expect(s.out.join('')).toContain('retired');
  expect(s.err).toEqual([]);
  expect(await new HubClient({ baseUrl: s.hub.url, token: s.hub.token }).retireRunner(s.config.runnerKey)).toEqual({
    ok: true,
  });
});

test('purge after stopping a running attempt finds its work pushed and its events acknowledged', async () => {
  const s = await fixture(true);
  const service = await s.start();
  await waitFor(() => service.runner?.status().link === 'online');
  const runnerId = service.runner!.status().runnerId!;
  const [task] = createTasks(s.hub.ctx, [newTask()], 'user:alice');
  const { attempt } = startRunnerAttempt(s.hub.ctx, { runnerId, taskId: task!.id, role: 'worker', vendor: 'codex' });
  await waitFor(() => service.runner!.status().attempts.some((a) => a.attemptId === attempt.id && a.phase === 'turn'));
  expect(await s.run(true)).toBe(0);
  expect(await service.exited).toMatchObject({ code: 0, clean: true });
  expect(s.out.join('')).toContain('no attempt has unpushed work');
  for (const path of [s.paths.runner, s.paths.vaults, s.paths.work]) expect(existsSync(path)).toBe(false);
  expect(findRunnerByKey(s.hub.ctx, s.config.runnerKey)?.retired_at).not.toBeNull();
});

test('purge deletes the read-only agent tools directory an attempt left', async () => {
  const s = await fixture(true);
  const service = await s.start();
  await waitFor(() => service.runner?.status().link === 'online');
  const runnerId = service.runner!.status().runnerId!;
  const [task] = createTasks(s.hub.ctx, [newTask()], 'user:alice');
  const { attempt } = startRunnerAttempt(s.hub.ctx, { runnerId, taskId: task!.id, role: 'worker', vendor: 'codex' });
  await waitFor(() => service.runner!.status().attempts.some((a) => a.attemptId === attempt.id && a.phase === 'turn'));
  const tools = s.paths.agentTools(service.runner!.vault.project, attempt.id);
  const entries = ['', 'bin', 'bin/gh', 'bin/glab', 'gh-config', 'glab-config', 'gitconfig', 'ssh-refusal'];
  // The tree as purge finds it: the logouts run once the runner has stopped, before anything is removed.
  const left: Record<string, number>[] = [];
  const exec: Exec = async (argv, options) => {
    if (argv[0] === s.claude.binary) {
      left.push(Object.fromEntries(entries.map((entry) => [entry || '.', statSync(join(tools, entry)).mode & 0o777])));
    }
    return s.deps.exec!(argv, options);
  };
  expect(await s.run(true, { exec })).toBe(0);
  expect(await service.exited).toMatchObject({ code: 0, clean: true });
  // M2b's writeRunDir leaves it read-only, where a plain recursive rm fails with EACCES.
  expect(left).toEqual([
    {
      '.': 0o555,
      bin: 0o555,
      'bin/gh': 0o555,
      'bin/glab': 0o555,
      'gh-config': 0o555,
      'glab-config': 0o555,
      gitconfig: 0o444,
      'ssh-refusal': 0o555,
    },
  ]);
  for (const path of [s.paths.runner, s.paths.vaults, s.paths.work]) expect(existsSync(path)).toBe(false);
  expect(s.out.join('')).toContain(`removed ${s.paths.runner}, ${s.paths.vaults} and ${s.paths.work}`);
});

test('purge preserves unharvested work after startup recovery and a failed project lookup', async () => {
  const s = await setupRunner({ status: 503 });
  const store = new AttemptStore(s.db);
  const clone = s.paths.clone('demo', 'crashed');
  mkdirSync(clone, { recursive: true });
  const work = join(clone, 'unpublished.txt');
  writeFileSync(work, 'work left by the crashed worker');
  record(store, 'crashed', clone, { state: 'running' });
  await expect(s.start()).rejects.toThrow('GET /api/status failed with HTTP 503');
  // createRunner recovered before project lookup failed; no controller finalized this clone.
  expect(store.get('crashed')).toMatchObject({ state: 'stopped', finalizedAt: null, pushError: null, lateWorkSha: null });
  const outbox = new Outbox(s.db);
  expect(outbox.eventsAfter(outbox.ackedSeq())).toEqual([]);
  const out: string[] = [];
  let externalCalls = 0;
  const dir = tempDir('agf-uninstall-cli-');
  writeFileSync(credentialsPath(dir), JSON.stringify(s.credentials));
  const code = await uninstallRunner(parseArgs(['runner', 'uninstall', '--purge']), {
    out: (line) => void out.push(line), err: () => {},
  }, {
    paths: s.paths,
    dir,
    env: { AGFLOW_TEST: '1' },
    machinePlatform: 'darwin',
    platform: 'darwin-arm64',
    exec: async (argv) => {
      externalCalls++;
      expect(argv).toEqual(['ioreg', '-rd1', '-c', 'IOPlatformExpertDevice']);
      return { exitCode: 0, stdout: `"IOPlatformUUID" = "${MACHINE}"`, stderr: '', timedOut: false };
    },
    fetch: async () => { externalCalls++; return Response.json({ ok: true }); },
  });
  expect(code).toBe(1);
  expect(out.join('')).toContain('refusing to purge: attempts have unpushed work');
  expect(externalCalls).toBe(0);
  expect(readFileSync(work, 'utf8')).toBe('work left by the crashed worker');
  expect(existsSync(s.paths.db)).toBe(true);
});

test('purge preserves a stopped worker whose final harvest failed without producing a SHA', async () => {
  const s = await fixture(true);
  const service = await s.start();
  await waitFor(() => service.runner?.status().link === 'online');
  const runnerId = service.runner!.status().runnerId!;
  const [task] = createTasks(s.hub.ctx, [newTask()], 'user:alice');
  const { attempt } = startRunnerAttempt(s.hub.ctx, { runnerId, taskId: task!.id, role: 'worker', vendor: 'codex' });
  await waitFor(() => service.runner!.status().attempts.some((a) => a.attemptId === attempt.id && a.phase === 'turn'));
  const db = openRunnerDb(s.paths.db);
  afterThisTest(() => db.close());
  const store = new AttemptStore(db);
  const clone = store.get(attempt.id)!.clone!;
  const work = join(clone, 'unpublished.txt');
  writeFileSync(work, 'work that cannot be harvested');
  // Corrupt only the scratch worker's git metadata; no real vendor CLI or model is involved.
  rmSync(join(clone, '.git'), { recursive: true, force: true });
  writeFileSync(join(clone, '.git'), 'broken git metadata\n');
  await stopRunner({ paths: s.paths, env: { AGFLOW_TEST: '1' }, lockWaitMs: 10_000, pollMs: 10 });
  expect(await service.exited).toMatchObject({ code: 0, clean: true });
  expect(store.get(attempt.id)).toMatchObject({ state: 'stopped', lateWorkSha: null });
  expect(store.get(attempt.id)!.pushError).toContain('cannot harvest');
  const outbox = new Outbox(db);
  expect(outbox.eventsAfter(outbox.ackedSeq())).toEqual([]);
  let retired = false;
  expect(await s.run(true, {
    env: { ...s.deps.env, AGFLOW_TEST: '1' },
    fetch: async () => { retired = true; return Response.json({ ok: true }); },
  })).toBe(1);
  expect(retired).toBe(false);
  expect(s.claude.calls()).toEqual([]);
  expect(s.codex.calls()).toEqual([]);
  expect(readFileSync(work, 'utf8')).toBe('work that cannot be harvested');
  expect(existsSync(s.plist)).toBe(true);
  expect(s.out.join('')).toContain('cannot harvest');
  s.unchanged();
});

test('offline uninstall takes the lock, kills matching groups and preserves a reused pid', async () => {
  const s = await fixture();
  const db = openRunnerDb(s.paths.db);
  afterThisTest(() => db.close());
  const store = new AttemptStore(db);
  const children = [];
  for (const id of ['matching', 'reused']) {
    const child = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
      cwd: s.home,
    });
    afterThisTest(async () => {
      child.kill('SIGKILL');
      await child.exited;
    });
    let identity = await processIdentity(child.pid);
    for (let i = 0; !identity && i < 100; i++) {
      await Bun.sleep(10);
      identity = await processIdentity(child.pid);
    }
    expect(identity).not.toBeNull();
    record(store, id, null);
    store.recordProcess({
      ...identity!,
      attemptId: id,
      clone: null,
      lstart: id === 'reused' ? 'an earlier process' : identity!.lstart,
    });
    children.push(child);
  }
  expect(await s.run(false, { fetch: async () => Response.json({ ok: true }) })).toBe(0);
  await children[0]!.exited;
  expect(children[0]!.signalCode).toBe('SIGKILL');
  expect(children[1]!.signalCode).toBeNull();
  expect(store.processes()).toEqual([]);
  expect(readLockOwner(s.paths)).toBeNull();
  expect(s.out.join('')).toContain('killed 1 registered agent group');
  s.loggedOut();
});

test('an unanswered lock holder or a new lock owner after stop prevents offline recovery and removal', async () => {
  const s = await fixture();
  const lock = await acquireRunnerLock(s.paths, { mode: 'foreground', wait: false });
  try {
    await expect(s.run()).rejects.toThrow(`pid ${process.pid}`);
    expect(s.claude.calls()).toEqual([]);
  } finally {
    lock.release();
  }
  // Take the lock between stop's socket probe and recovery; recovery must refuse this race too.
  let racedLock: Awaited<ReturnType<typeof acquireRunnerLock>> | undefined;
  const exec: Exec = async (argv) => {
    if (!racedLock) racedLock = await acquireRunnerLock(s.paths, { mode: 'foreground', wait: false });
    return { exitCode: 1, stdout: '', stderr: '', timedOut: false };
  };
  try {
    await expect(s.run(false, { exec })).rejects.toThrow(`pid ${process.pid}`);
  } finally {
    racedLock?.release();
  }
  expect(s.claude.calls()).toEqual([]);
  expect(s.codex.calls()).toEqual([]);
  expect(existsSync(s.plist)).toBe(true);
  s.unchanged();
});

test('unpushedWork reads durable records even after exit, late-work and spawn events are pruned', () => {
  const db = openRunnerDb(':memory:');
  try {
    const store = new AttemptStore(db);
    const outbox = new Outbox(db);
    const [w, x] = ['a', 'b'].map((digit) => digit.repeat(40));
    const live = new Set(['/live', '/lead']);
    const unpushed = () =>
      unpushedWork(store, (path) => live.has(path)).map(({ record, reasons }) => [record.attemptId, reasons]);
    record(store, 'cleaned', null, { state: 'ended', finalizedAt: 1, endedAt: 1, wipSha: x, pushedSha: w });
    record(store, 'failed', '/error', { state: 'ended', finalizedAt: 1, endedAt: 1, pushError: 'denied', lateWorkSha: x });
    // A known-ended refusal has no pushError, even when its WIP shas agree.
    record(store, 'T-4-a6', '/retrying', { state: 'stopped', finalizedAt: 1, wipSha: w, pushedSha: w, lateWorkSha: x });
    // Pending work is in the vault even if the clone is absent or its path was lost.
    record(store, 'no-clone', null, { state: 'ended', finalizedAt: 1, endedAt: 1, lateWorkSha: x });
    record(store, 'stale-error', '/kept', { state: 'stopped', finalizedAt: 1, pushError: 'a push before hand-back', lateWorkSha: null });
    record(store, 'landed', '/held', { state: 'stopped', finalizedAt: 1, wipSha: x, pushedSha: w, lateWorkSha: null });
    record(store, 'unchanged-since-start', '/start', { state: 'stopped', finalizedAt: 1 });
    record(store, 'unchanged-since-push', '/same', { state: 'stopped', finalizedAt: 1, wipSha: x, pushedSha: w });
    record(store, 'live', '/live', { state: 'running', wipSha: w, pushedSha: w });
    record(store, 'held-wip', '/missing', { state: 'running', wipSha: x, pushedSha: w });
    record(store, 'lead', '/lead', { state: 'running', wipSha: x }, 'lead');
    expect(unpushed()).toEqual([
      ['failed', ['final push failed: denied']],
      ['T-4-a6', [`final work ${x} has not reached a late-work ref yet`]],
      ['no-clone', [`final work ${x} has not reached a late-work ref yet`]],
      ['live', ['the runner did not stop this attempt, so its clone was never harvested']],
      ['held-wip', [`unpushed WIP ${x} (last pushed: ${w})`]],
    ]);
    // Once the durable marker clears, retained stale events must not resurrect the pending work.
    store.update('T-4-a6', { lateWorkSha: null });
    outbox.append({ type: 'attempt.exited', attemptId: 'T-4-a6', fence: { epoch: 1, counter: 1 }, data: {
      code: 0, signal: null, stoppedBy: 'none', handoffWritten: false, cause: 'runner_stop',
      finalSha: x, finalWip: null, pushError: null,
    } });
    expect(unpushed().map(([id]) => id)).not.toContain('T-4-a6');
    outbox.pruneBefore(Date.now() + 1);
    expect(unpushed().map(([id]) => id)).toContain('no-clone');
  } finally {
    db.close();
  }
});

test('unpushedWork requires finalization before ignoring retained clones and unequal WIP SHAs', () => {
  const db = openRunnerDb(':memory:');
  try {
    const store = new AttemptStore(db);
    for (const state of ['stopped', 'suspended', 'ended'] as const) {
      record(store, `${state}-clone`, '/retained', { state, wipSha: 'same', pushedSha: 'same' });
      record(store, `${state}-wip`, '/missing', { state, wipSha: 'new', pushedSha: 'old' });
    }
    const pending = () => unpushedWork(store, (path) => path === '/retained');
    const ids = store.list().map((record) => record.attemptId);
    expect(pending().map(({ record }) => record.attemptId)).toEqual(ids);
    for (const id of ids) store.update(id, { finalizedAt: 1 });
    expect(pending()).toEqual([]);

    // Finalization records the outcome; it does not prove a failed harvest or push reached origin.
    store.update('stopped-clone', { pushError: 'cannot harvest' });
    store.update('ended-wip', { lateWorkSha: 'pending-final' });
    expect(pending().map(({ record }) => record.attemptId)).toEqual(['stopped-clone', 'ended-wip']);
    store.update('stopped-clone', { pushError: null });
    store.update('ended-wip', { lateWorkSha: null });
    expect(pending()).toEqual([]);

    // A live worker remains protected even if a previous completion timestamp survived.
    store.update('stopped-clone', { state: 'running' });
    expect(pending().map(({ record }) => record.attemptId)).toEqual(['stopped-clone']);
    // Cleaned records remain safe even without a completion timestamp.
    store.update('stopped-clone', { state: 'ended', clone: null, endedAt: 1, finalizedAt: null });
    expect(pending()).toEqual([]);
  } finally {
    db.close();
  }
});

test('purge refuses before logouts, retirement or removal and names work and recovery instructions', async () => {
  const s = await fixture();
  const db = openRunnerDb(s.paths.db);
  const store = new AttemptStore(db);
  const clones = ['push-error', 'wip', 'live'].map((id) => s.paths.clone('demo', id));
  for (const clone of clones) {
    mkdirSync(clone, { recursive: true });
    writeFileSync(join(clone, 'work'), 'keep');
  }
  record(store, 'push-error', clones[0]!, { pushError: 'remote denied', lateWorkSha: 'failed-sha', endedAt: 1, state: 'ended', finalizedAt: 1 });
  record(store, 'wip', clones[1]!, { wipSha: 'new-sha', pushedSha: 'old-sha', state: 'stopped', finalizedAt: 1, lateWorkSha: 'new-sha' });
  // Left running by a runner that crashed: up to one WIP interval of work was never harvested.
  record(store, 'live', clones[2]!, { state: 'running' });
  db.close();
  let retired = false;
  expect(
    await s.run(true, {
      fetch: async () => {
        retired = true;
        return Response.json({ ok: true });
      },
    }),
  ).toBe(1);
  expect(retired).toBe(false);
  expect(s.claude.calls()).toEqual([]);
  expect(s.codex.calls()).toEqual([]);
  expect(existsSync(s.paths.config)).toBe(true);
  expect(existsSync(s.plist)).toBe(true);
  for (const clone of clones) expect(readFileSync(join(clone, 'work'), 'utf8')).toBe('keep');
  for (const text of [
    ...clones,
    'push-error',
    'wip',
    'remote denied',
    'final work new-sha has not reached a late-work ref yet',
    'its clone was never harvested',
    'agflow runner start',
    'by hand',
    'agflow runner uninstall --purge',
  ])
    expect(s.out.join('')).toContain(text);
  s.unchanged();
});

test('purge deletes only runner, vaults and work, including read-only tools, without following symlinks', async () => {
  const s = await fixture();
  const tools = s.paths.agentTools('demo', 'attempt');
  mkdirSync(join(tools, 'bin'), { recursive: true });
  writeFileSync(join(tools, 'bin', 'tool'), 'tool');
  afterThisTest(() => removeAgentTools(tools));
  const outside = tempDir('agf-outside-');
  writeFileSync(join(outside, 'keep'), 'outside');
  const before = snapshot(join(outside, 'keep'));
  symlinkSync(outside, join(tools, 'outside'));
  chmodSync(join(tools, 'bin'), 0o555);
  chmodSync(tools, 0o555);
  symlinkSync(outside, join(s.paths.vaults, 'linked.agent'));
  symlinkSync(outside, s.paths.agentTools('demo', 'linked'));
  afterThisTest(() => {
    rmSync(join(s.paths.vaults, 'linked.agent'), { force: true });
    rmSync(s.paths.agentTools('demo', 'linked'), { force: true });
  });
  mkdirSync(s.paths.work, { recursive: true });
  symlinkSync(outside, join(s.paths.work, 'outside'));
  const other = join(s.paths.home, 'keep');
  writeFileSync(other, 'keep');
  expect(await s.run(true, { fetch: async () => Response.json({ ok: true }) })).toBe(0);
  for (const path of [s.paths.runner, s.paths.vaults, s.paths.work]) expect(existsSync(path)).toBe(false);
  expect(readFileSync(other, 'utf8')).toBe('keep');
  expect(snapshot(join(outside, 'keep'))).toEqual(before);
  s.unchanged();
});

test('purge removes read-only directories in clones and stays inside AGFLOW_HOME', async () => {
  const s = await fixture();
  const cache = join(s.paths.clone('demo', 'a1'), '.agflow/run/cache/go-mod/example.com/mod@v1');
  mkdirSync(cache, { recursive: true });
  writeFileSync(join(cache, 'go.mod'), 'module example.com/mod\n');
  chmodSync(join(cache, 'go.mod'), 0o444);
  chmodSync(cache, 0o555);
  chmodSync(dirname(cache), 0o555);
  const outside = tempDir('agf-outside-');
  writeFileSync(join(outside, 'keep'), 'outside');
  const before = snapshot(join(outside, 'keep'));
  symlinkSync(outside, join(s.paths.clone('demo', 'a1'), 'outside'));
  expect(await s.run(true, { fetch: async () => Response.json({ ok: true }) })).toBe(0);
  for (const path of [s.paths.runner, s.paths.vaults, s.paths.work]) expect(existsSync(path)).toBe(false);
  expect(snapshot(join(outside, 'keep'))).toEqual(before);
  s.unchanged();
});

test('purge refuses while runner.db holds events the hub has not acknowledged', async () => {
  const s = await fixture();
  const db = openRunnerDb(s.paths.db);
  new Outbox(db).append({ type: 'runner.state', data: { state: 'ok', detail: null } });
  db.close();
  let retired = false;
  const fetch: RunnerUninstallDeps['fetch'] = async () => {
    retired = true;
    return Response.json({ ok: true });
  };
  expect(await s.run(true, { fetch })).toBe(1);
  expect(retired).toBe(false);
  expect(s.claude.calls()).toEqual([]);
  expect(existsSync(s.paths.db)).toBe(true);
  expect(s.out.join('')).toContain('1 event the hub has not acknowledged');
  expect(s.out.join('')).toContain('run agflow runner start until the hub has them');
});

test('purge after a failed retirement keeps runner.json, runner.db and the clones for a rerun', async () => {
  const s = await fixture();
  mkdirSync(s.paths.clone('demo', 'a1'), { recursive: true });
  const db = openRunnerDb(s.paths.db);
  db.close();
  const fetch: RunnerUninstallDeps['fetch'] = async () => {
    throw new Error('network down');
  };
  expect(await s.run(true, { fetch })).toBe(1);
  for (const path of [s.paths.config, s.paths.db, s.paths.clone('demo', 'a1')]) expect(existsSync(path)).toBe(true);
  expect(existsSync(s.plist)).toBe(false);
  expect(s.out.join('')).toContain('run agflow runner uninstall --purge again once the hub is reachable');
  expect(await s.run(true, { fetch: async () => Response.json({ ok: true }) })).toBe(0);
  for (const path of [s.paths.runner, s.paths.vaults, s.paths.work]) expect(existsSync(path)).toBe(false);
});

test('a runner.json copied from another Mac is not retired from this one', async () => {
  const s = await fixture();
  s.machine.id = '00000000-0000-4000-8000-000000000002';
  let retired = false;
  const fetch: RunnerUninstallDeps['fetch'] = async () => {
    retired = true;
    return Response.json({ ok: true });
  };
  expect(await s.run(false, { fetch })).toBe(0);
  expect(retired).toBe(false);
  expect(findRunnerByKey(s.hub.ctx, s.config.runnerKey)?.retired_at ?? null).toBeNull();
  expect(s.out.join('')).toContain(
    `runner.json came from another Mac; its runner ${s.config.runnerKey} belongs to that Mac and is not retired here`,
  );
  s.loggedOut();
});

test('logouts use the newest installed binary when the pin moved, and say when none is installed', async () => {
  const s = await fixture();
  rmSync(join(s.paths.vendor, 'codex'), { recursive: true });
  const pins = {
    claude: { ...s.deps.pins!.claude, version: '9.9.9' },
    codex: { ...s.deps.pins!.codex, version: '9.9.8' },
  };
  expect(await s.run(false, { pins, fetch: async () => Response.json({ ok: true }) })).toBe(0);
  expect(s.claude.calls()).toHaveLength(1);
  expect(s.claude.calls()[0]!.argv).toEqual(['auth', 'logout']);
  expect(s.out.join('')).toContain("claude: requested logout from the runner's home");
  expect(s.out.join('')).toContain('codex: no runner binary is installed, so the logout could not run');
  expect(s.out.join('')).not.toContain('codex: requested logout');
});

for (const failure of ['unreachable', 'missing credentials', 'refused token']) {
  test(`${failure}: local steps finish and retirement failure returns 1`, async () => {
    const s = await fixture();
    if (failure === 'missing credentials') rmSync(credentialsPath(s.configDir));
    const fetch: RunnerUninstallDeps['fetch'] = async () => {
      if (failure === 'unreachable') throw new Error('network down');
      return Response.json({ error: 'unauthorized', message: 'refused' }, { status: 401 });
    };
    expect(await s.run(false, { fetch })).toBe(1);
    expect(s.claude.calls()).toHaveLength(1);
    expect(s.codex.calls()).toHaveLength(1);
    expect(existsSync(s.plist)).toBe(false);
    expect(existsSync(s.paths.config)).toBe(true);
    expect(s.out.join('')).toContain('retire');
    expect(s.out.join('')).toContain(failure === 'unreachable' ? 'network down' : 'run agflow login --hub');
    if (failure !== 'missing credentials') s.unchanged();
  });
}

test('missing runner.json skips logouts and retire but still removes the plist', async () => {
  const s = await fixture();
  rmSync(s.paths.config);
  expect(
    await s.run(false, {
      fetch: async () => {
        throw new Error('must not retire');
      },
    }),
  ).toBe(0);
  expect(s.out.join('')).toContain('runner.json is missing');
  expect(s.claude.calls()).toEqual([]);
  expect(s.codex.calls()).toEqual([]);
  expect(existsSync(s.paths.db)).toBe(false);
  expect(existsSync(s.plist)).toBe(false);
  s.unchanged();
});

test('uninstall help and usage reject extra arguments', async () => {
  const s = await fixture();
  expect(RUNNER_HELP).toContain('agflow runner uninstall [--purge]');
  for (const argv of [
    ['runner', 'uninstall', 'extra'],
    ['runner', 'uninstall', '--purge', 'extra'],
  ]) {
    expect(await main(argv, s.io)).toBe(2);
    expect(s.err.join('')).toContain('usage: agflow runner uninstall [--purge]');
  }
});

for (const running of [false, true]) {
  test(`uninstall in injected test mode leaves launchd and its plist alone (running: ${running})`, async () => {
    const s = await fixture();
    if (running) await s.start();
    process.env.AGFLOW_TEST = '0';
    expect(await runnerCommand(parseArgs(['runner', 'uninstall']), s.io, {
      env: { ...s.deps.env, AGFLOW_TEST: '1' },
      uninstall: { ...s.deps, env: undefined, fetch: async () => Response.json({ ok: true }) },
    })).toBe(0);
    expect(s.commands.filter((argv) => argv[0] === 'launchctl')).toEqual([]);
    expect(readFileSync(s.plist, 'utf8')).toBe('installed');
  });
}
