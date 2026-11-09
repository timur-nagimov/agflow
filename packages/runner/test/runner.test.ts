import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AGFLOW_VERSION, PROTOCOL_VERSION, type RunnerCommand, RunnerMessageSchema, restoreSet } from '@agflow/core';
import { FakeAdapter, gitIn } from '@agflow/testkit';
import { AttemptStore } from '../src/attempt-store';
import { RunnerConfigSchema } from '../src/config';
import { Journal } from '../src/journal';
import { Outbox } from '../src/outbox';
import { projectKey } from '../src/paths';
import { killGroup, type ProcessIdentity, processIdentity } from '../src/processes';
import { createRunner } from '../src/runner';
import type { PrepareInput, RunnerHealth } from '../src/seams';
import { vendorPlatform } from '../src/vendor/pins';
import { testWelcome } from './fake-hub';
import { FIXTURE_AGFLOW, fixtureCliVersion, waitFor } from './fixture';
import {
  afterThisTest,
  cleanupRunnerSetups,
  hellos,
  openRunnerDb,
  runCommand as run,
  SETUP_PROJECT as PROJECT,
  SETUP_TOKEN as TOKEN,
  setupRunner as setup,
  setupSpec as specOf,
  startFakeHub,
  tempDir,
} from './runner-setup';

afterEach(cleanupRunnerSetups);

// Every test here runs git or agent processes, which take several times as long on a machine loaded by other suites.
setDefaultTimeout(30_000);

/** A runner.settings that names a field: an edit, not a probe. */
const isEdit = (event: { type: string; [key: string]: unknown }) =>
  event.type === 'runner.settings' && Object.keys((event.data as { settings: object }).settings).length > 0;

/** Settings the hub confirmed at version 4: runner.json's defaults. */
const SNAPSHOT = {
  capacity: 2,
  keepAwake: 'ac' as const,
  draining: false,
  ceilings: { claude: { fiveHour: 0.85, weekly: 0.85 }, codex: { fiveHour: 0.85, weekly: 0.85 } },
  allowPaidUsage: { claude: false, codex: false },
  version: 4,
};

/** runner.json as the runner last wrote it. */
async function runnerJson(s: { paths: { config: string } }) {
  return RunnerConfigSchema.parse(await Bun.file(s.paths.config).json());
}

describe('createRunner', () => {
  test('hello carries the identity, the confirmed settings, the vendors, git, the outbox and the recovered attempts', async () => {
    const s = await setup();
    const store = new AttemptStore(s.db);
    // What a previous run left: an attempt that was running, a push, an event, and the hub epoch it last saw.
    store.create(specOf(s), { clone: join(s.paths.work, 'gone'), tmpDir: null, cliVersion: null });
    store.update('T-4-a1', { state: 'running', sessionRef: 'session-1', lastPushAt: 1_700_000_000_000 });
    new Outbox(s.db).append({ type: 'runner.state', data: { state: 'ok', detail: null } });
    s.db.setMeta('lastHubEpoch', 2);
    const confirmed = {
      capacity: 3,
      keepAwake: 'ac' as const,
      draining: false,
      ceilings: { claude: { fiveHour: 0.7, weekly: 0.8 } },
      allowPaidUsage: { codex: true },
      version: 5,
    };
    await s.start({
      config: {
        // A drain made while the runner was down is a local edit: hello carries the snapshot only.
        capacity: 3,
        draining: true,
        ceilings: { claude: { fiveHour: 0.7, weekly: 0.8 } },
        allowPaidUsage: { codex: true },
        confirmedSettings: confirmed,
        models: { claude: { lead: 'claude-lead-model', worker: 'claude-worker-model' } },
      },
    });
    const [hello] = await s.hub.waitFor(() => hellos(s.hub).length > 0 && hellos(s.hub));
    expect(s.hub.invalid).toEqual([]);
    expect(RunnerMessageSchema.safeParse(hello).success).toBe(true);
    expect(hello).toMatchObject({
      protocol: PROTOCOL_VERSION,
      runnerKey: 'rk_test_runner',
      machineId: 'MACHINE-1',
      name: 'laptop',
      agflowVersion: AGFLOW_VERSION,
      platform: vendorPlatform(),
      settings: confirmed,
      git: { ready: true, problem: null, lastPushAt: 1_700_000_000_000 },
      state: 'ok',
      stateDetail: null,
      firstSeq: 1,
      lastSeq: 1,
      lastHubEpoch: 2,
      attempts: [
        { attemptId: 'T-4-a1', fence: { epoch: 1, counter: 1 }, state: 'stopped', sessionRef: 'session-1', clone: false },
      ],
    });
    expect(hello?.outboxEpoch).toBe(s.db.outboxEpoch);
    const vendors = Object.fromEntries((hello?.vendors ?? []).map((vendor) => [vendor.vendor, vendor]));
    expect(vendors.claude).toMatchObject({
      ready: true,
      models: { lead: 'claude-lead-model', worker: 'claude-worker-model' },
      ceilings: { fiveHour: 0.7, weekly: 0.8 },
      allowPaidUsage: false,
      degraded: false,
    });
    expect(vendors.codex).toMatchObject({ ready: true, allowPaidUsage: true, ceilings: { fiveHour: 0.85, weekly: 0.85 } });
    expect(hello?.profile).toEqual({ name: 'standard', weakened: [], dependencyPrep: false });
    // Startup recovery recorded the attempt as stopped.
    expect(store.get('T-4-a1')?.state).toBe('stopped');
  });

  test("the project's name and repo come from GET /api/status and are cached for the next start", async () => {
    const s = await setup();
    const first = await s.start();
    await s.hub.waitFor(() => hellos(s.hub).length > 0);
    const cached = { hubUrl: s.hub.url, name: PROJECT, repo: s.origin.path };
    expect(s.db.meta('project')).toEqual(cached);
    const vault = s.paths.vault(projectKey(s.hub.url, PROJECT));
    expect(existsSync(join(vault, 'HEAD'))).toBe(true);
    await first.close();

    // The hub answers no status now: the cached project names the same vault, and the runner says hello.
    const down = startFakeHub({ token: TOKEN, status: 503 });
    afterThisTest(() => down.stop());
    const runner = await createRunner({
      paths: s.paths,
      db: s.db,
      credentials: () => ({ hubUrl: s.hub.url, token: TOKEN, user: 'alice' }),
      adapters: [],
      agflow: FIXTURE_AGFLOW,
      fetch: (input, init) => fetch(String(input).replace(s.hub.url, down.url), init),
    });
    afterThisTest(() => runner.close());
    await s.hub.waitFor(() => hellos(s.hub).length > 1);
    expect(s.db.meta('project')).toEqual(cached);

    // With neither the hub nor a cache, the runner cannot start.
    const empty = openRunnerDb(join(tempDir('agflow-runner-db-'), 'runner.db'));
    afterThisTest(() => empty.close());
    const refused = createRunner({
      paths: s.paths,
      db: empty,
      credentials: () => ({ hubUrl: down.url, token: TOKEN, user: 'alice' }),
      adapters: [],
      agflow: FIXTURE_AGFLOW,
    });
    await expect(refused).rejects.toThrow(/cannot read the project from the hub/);

    // Nor with another hub's cache: its repository would get this hub's work.
    const elsewhere = createRunner({
      paths: s.paths,
      db: s.db,
      credentials: () => ({ hubUrl: down.url, token: TOKEN, user: 'alice' }),
      adapters: [],
      agflow: FIXTURE_AGFLOW,
    });
    await expect(elsewhere).rejects.toThrow(/cannot read the project from the hub/);
    expect(s.db.meta('project')).toEqual(cached);
  });

  test("startup recovery kills a previous run's agents before it reads the credentials, signed in or not", async () => {
    const s = await setup();
    const clone = join(tempDir('agflow-clone-'), 'T-4-a1');
    mkdirSync(clone, { recursive: true });
    const child = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      cwd: clone,
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    });
    try {
      let identity: ProcessIdentity | null = null;
      for (let tries = 0; tries < 100 && identity === null; tries++) {
        identity = await processIdentity(child.pid);
        if (identity === null) await Bun.sleep(10);
      }
      if (identity === null) throw new Error('the child never started');
      const store = new AttemptStore(s.db);
      store.create(specOf(s), { clone, tmpDir: null, cliVersion: null });
      store.update('T-4-a1', { state: 'running' });
      store.recordProcess({ ...identity, attemptId: 'T-4-a1', clone });
      // agflow logout after a crash: the runner cannot start, but what the crashed run left is gone.
      const refused = createRunner({
        paths: s.paths,
        config: RunnerConfigSchema.parse({ runnerKey: 'rk_test_runner', machineId: 'MACHINE-1', name: 'laptop' }),
        db: s.db,
        credentials: () => null,
        adapters: [],
        agflow: FIXTURE_AGFLOW,
      });
      await expect(refused).rejects.toThrow(/not signed in/);
      await child.exited;
      expect(child.signalCode).toBe('SIGKILL');
      expect(store.processes()).toEqual([]);
      expect(store.get('T-4-a1')?.state).toBe('stopped');
    } finally {
      child.kill('SIGKILL');
      await child.exited;
    }
  });

  test('HTTP calls go only to the hub the runner serves: after a login to another hub, an upload fails', async () => {
    const s = await setup();
    // Another hub, which records every request it gets.
    const requests: string[] = [];
    const other = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (request) => {
        requests.push(new URL(request.url).pathname);
        return new Response(null, { status: 204 });
      },
    });
    let hubUrl = s.hub.url;
    // A turn that says something, so the transcript has a tail to upload.
    const script = { turns: [[{ do: 'text', text: 'the parser is tidy' } as const]] };
    const runner = await createRunner({
      paths: s.paths,
      config: RunnerConfigSchema.parse({
        runnerKey: 'rk_test_runner',
        machineId: 'MACHINE-1',
        name: 'laptop',
        test: { skipAuthChecks: true, allowShortTimings: true },
      }),
      db: s.db,
      credentials: () => ({ hubUrl, token: TOKEN, user: 'alice' }),
      adapters: [new FakeAdapter({ vendor: 'claude', skipAuthChecks: true, script })],
      agflow: FIXTURE_AGFLOW,
      cliVersion: fixtureCliVersion,
      logger: s.logger,
    });
    try {
      await s.hub.waitFor(() => hellos(s.hub).length > 0);
      const spec = specOf(s);
      expect(await run(s.hub, { kind: 'start_attempt', attempt: spec })).toMatchObject({ ok: true });
      const stop = {
        kind: 'stop_attempt',
        attemptId: 'T-4-a1',
        fence: spec.fence,
        cause: 'stop',
        reason: 'done',
        handoff: false,
        interruptFirst: false,
        keepClone: true,
      } as const;
      expect(await run(s.hub, stop)).toMatchObject({ ok: true });
      // agflow login --hub <other>: the link to this hub is still up, and the hub asks for the transcript.
      hubUrl = `http://127.0.0.1:${other.port}`;
      expect(await run(s.hub, { kind: 'upload_transcript', attemptId: 'T-4-a1' })).toMatchObject({
        ok: true,
        data: { uploaded: false },
      });
      expect(requests).toEqual([]);
      const warned = s.logger.entries.filter((entry) => entry.message === 'cannot upload the transcript tail');
      expect(String(warned.at(-1)?.fields.error)).toContain('not signed in');
    } finally {
      await runner.close();
      other.stop(true);
    }
  }, 30_000);

  test("the vault takes the main branch the hub's specs name and keeps it; another repository is refused", async () => {
    const s = await setup();
    // The hub's repository has trunk and no main.
    await gitIn(s.origin.path, ['branch', '-m', 'main', 'trunk']);
    await gitIn(s.origin.path, ['symbolic-ref', 'HEAD', 'refs/heads/trunk']);
    await s.start();
    await s.hub.waitFor(() => hellos(s.hub).length > 0);
    const trunk = {
      repo: { url: s.origin.path, mainBranch: 'trunk' },
      start: { ref: 'refs/heads/trunk', sha: null },
      restore: { paths: restoreSet(null), base: 'refs/heads/trunk' },
    };
    expect(await run(s.hub, { kind: 'start_attempt', attempt: specOf(s, trunk) })).toMatchObject({ ok: true });
    expect(s.db.meta('mainBranch')).toBe('trunk');
    const vault = s.paths.vault(projectKey(s.hub.url, PROJECT));
    expect(await gitIn(vault, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/trunk');
    expect(await gitIn(vault, ['rev-parse', 'refs/heads/trunk'])).toBe(s.origin.mainSha);
    // A spec naming a repository other than the vault's fails to start, before anything is fetched.
    const foreign = specOf(s, {
      ...trunk,
      attemptId: 'T-5-a1',
      taskId: 'T-5',
      branch: 'agflow/T-5-x',
      wipRef: 'refs/agflow/T-5/a1',
      repo: { url: '/elsewhere/origin.git', mainBranch: 'trunk' },
    });
    expect(await run(s.hub, { kind: 'start_attempt', attempt: foreign })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/the hub names the repository \/elsewhere\/origin\.git/),
    });
  }, 30_000);

  for (const key of ['wipRefPrefix', 'lastHubEpoch'] as const) {
    test(`a failed ${key} and outbox ack write at welcome are logged and the runner stays online`, async () => {
      const s = await setup({ welcome: false, autoAck: false });
      new Outbox(s.db).append({ type: 'runner.state', data: { state: 'ok', detail: null } });
      await s.start();
      await s.hub.waitFor(() => hellos(s.hub).length === 1);
      s.db.sqlite.run(`CREATE TRIGGER fail_meta BEFORE INSERT ON meta WHEN NEW.key = '${key}'
        BEGIN SELECT RAISE(ABORT, 'meta disk full'); END`);
      s.db.sqlite.run("CREATE TRIGGER fail_ack BEFORE UPDATE ON outbox_ack BEGIN SELECT RAISE(ABORT, 'ack disk full'); END");
      (await s.hub.connection(0)).send(testWelcome(0));
      await s.hub.waitFor(() => s.logger.entries.some((entry) => entry.fields?.error === 'meta disk full'));
      expect(s.logger.entries).toContainEqual({
        level: 'error',
        message: key === 'wipRefPrefix' ? 'cannot record the WIP ref prefix' : 'cannot record the hub epoch',
        fields: { error: 'meta disk full' },
      });
      expect(s.logger.entries.some((entry) => entry.fields?.error === 'ack disk full')).toBe(true);
      expect(await run(s.hub, { kind: 'preflight', vendor: 'claude' })).toMatchObject({ ok: true });
      // The outbox still replays, and a later welcome retries both writes.
      s.db.sqlite.run('DROP TRIGGER fail_meta');
      s.db.sqlite.run('DROP TRIGGER fail_ack');
      await s.hub.waitFor(() => s.hub.events().length > 0);
      (await s.hub.connection(0)).send(testWelcome(1));
      await s.hub.waitFor(() => s.db.meta(key) !== null);
      expect(new Outbox(s.db).ackedSeq()).toBeGreaterThanOrEqual(1);
      expect(await run(s.hub, { kind: 'preflight', vendor: 'claude' })).toMatchObject({ ok: true });
    });
  }

  for (const key of ['restoredThrough', 'lastHubEpoch'] as const) {
    test(`a restored hub retries a failed ${key} write with normal link backoff before replay`, async () => {
      const s = await setup({ welcome: false, autoAck: false });
      s.db.setMeta('lastHubEpoch', 1);
      new Outbox(s.db).append({ type: 'runner.state', data: { state: 'ok', detail: null } });
      await s.start();
      await s.hub.waitFor(() => hellos(s.hub).length === 1);
      s.db.sqlite.run(`CREATE TRIGGER fail_restore BEFORE INSERT ON meta WHEN NEW.key = '${key}'
        BEGIN SELECT RAISE(ABORT, 'restore disk full'); END`);
      const first = await s.hub.connection(0);
      first.send(testWelcome(0, { hubEpoch: 2 }));
      await s.hub.waitFor(() => s.logger.entries.some((entry) => entry.fields?.error === 'restore disk full'));
      expect(s.db.meta('lastHubEpoch')).toBe(1);
      expect(first.messages.filter((message) => message.t !== 'hello')).toEqual([]);
      expect(s.logger.entries.some((entry) => entry.message === 'the hub link closed')).toBe(true);
      await s.hub.waitFor(() => first.closed !== null);
      s.db.sqlite.run('DROP TRIGGER fail_restore');
      await s.hub.waitFor(() => hellos(s.hub).length === 2);
      (await s.hub.connection(1)).send(testWelcome(0, { hubEpoch: 2 }));
      await s.hub.waitFor(() => hellos(s.hub).length === 3);
      expect(s.db.meta('lastHubEpoch')).toBe(2);
      expect(s.db.meta('restoredThrough')).toBeGreaterThanOrEqual(1);
      (await s.hub.connection(2)).send(testWelcome(0, { hubEpoch: 2 }));
      await s.hub.waitFor(() => s.hub.events().length > 0);
      expect(await run(s.hub, { kind: 'preflight', vendor: 'claude' })).toMatchObject({ ok: true });
    });
  }

  test('welcome sets the WIP ref prefix, the hub epoch and the timings, handoffMs and wipGraceMs included', async () => {
    const timings = { heartbeatMs: 10_000, deadLinkMs: 60_000, handoffMs: 300, wipGraceMs: 400 };
    const s = await setup({ welcome: { wipRefPrefix: 'refs/agflow-e3/', hubEpoch: 3, timings }, heartbeatAck: false });
    const write = { do: 'write', path: 'src/app.ts', content: 'tidy\n' } as const;
    await s.start({
      // runner.json's own handoff is far longer: only the welcome's 300 ms meets the bound below.
      config: { timings: { handoff: 20_000, submitRetry: 1_500, stopInterrupt: 500, stopClose: 500, stopKill: 500 } },
      script: {
        turns: [[write, { do: 'commit', message: 'tidy' }], [{ do: 'sleep', ms: 30_000 }]],
      },
    });
    await s.hub.waitFor(() => s.db.meta('lastHubEpoch') === 3);
    expect(s.db.meta('wipRefPrefix')).toBe('refs/agflow-e3/');
    const spec = specOf(s, { wipRef: 'refs/agflow-e3/T-4/a1' });
    expect(await run(s.hub, { kind: 'start_attempt', attempt: spec })).toMatchObject({ ok: true });
    await s.hub.waitFor(() => s.hub.events().some((event) => event.type === 'attempt.activity'), 10_000);

    // No heartbeat_ack since the welcome: past wipGraceMs, the submission's push may not go.
    await Bun.sleep(500);
    const submitted = await run(s.hub, {
      kind: 'push_submission',
      attemptId: 'T-4-a1',
      fence: spec.fence,
      submissionId: 'S-1',
      branch: 'agflow/T-4-tidy',
      expectedBranchSha: null,
      adoptable: [],
    });
    expect(submitted).toMatchObject({
      ok: false,
      error: 'remote',
      data: { detail: 'the hub has not answered within the WIP grace' },
    });

    // The handoff turn never writes its note: it is waited for the welcome's handoffMs.
    const began = performance.now();
    const stop = {
      kind: 'stop_attempt',
      attemptId: 'T-4-a1',
      fence: spec.fence,
      cause: 'stop',
      reason: 'a person stopped it',
      handoff: true,
      interruptFirst: false,
      keepClone: true,
    } as const;
    expect(await run(s.hub, stop)).toMatchObject({ ok: true });
    expect(performance.now() - began).toBeLessThan(5_000);
  }, 30_000);

  test("a new attempt's CLI version comes from the cliVersion option, which tests give where no CLI is pinned", async () => {
    const s = await setup();
    const runner = await createRunner({
      paths: s.paths,
      config: RunnerConfigSchema.parse({
        runnerKey: 'rk_test_runner',
        machineId: 'MACHINE-1',
        name: 'laptop',
        test: { skipAuthChecks: true, allowShortTimings: true },
      }),
      db: s.db,
      credentials: () => ({ hubUrl: s.hub.url, token: TOKEN, user: 'alice' }),
      adapters: [new FakeAdapter({ vendor: 'claude', skipAuthChecks: true, script: { turns: [[]] } })],
      agflow: FIXTURE_AGFLOW,
      cliVersion: (vendor) => (vendor === 'claude' ? '1.2.3' : '4.5.6'),
      logger: s.logger,
    });
    try {
      await s.hub.waitFor(() => hellos(s.hub).length > 0);
      expect(await run(s.hub, { kind: 'start_attempt', attempt: specOf(s) })).toMatchObject({ ok: true });
      const spawned = await s.hub.waitFor(() => s.hub.events().find((event) => event.type === 'attempt.spawned'));
      expect(spawned).toMatchObject({ data: { cliVersion: '1.2.3' } });
      expect(new AttemptStore(s.db).get('T-4-a1')?.cliVersion).toBe('1.2.3');
    } finally {
      for (const group of new AttemptStore(s.db).processes()) await killGroup(group, 'SIGKILL');
      await runner.close();
    }
  });

  test("late work a previous run could not push goes out after the next run's first welcome", async () => {
    const s = await setup();
    // The first late-work retry waits a minute: the runner stops before it.
    const config = { timings: { finalPush: 300, lateRetry: { base: 60_000, cap: 60_000 } } };
    const write = { do: 'write', path: 'work.txt', content: 'late\n' } as const;
    const first = await s.start({ config, script: { turns: [[write, { do: 'sleep', ms: 30_000 }]] } });
    await s.hub.waitFor(() => hellos(s.hub).length > 0);
    const spec = specOf(s);
    expect(await run(s.hub, { kind: 'start_attempt', attempt: spec })).toMatchObject({ ok: true });
    await waitFor(() => existsSync(join(s.paths.clone(projectKey(s.hub.url, PROJECT), 'T-4-a1'), 'work.txt')));
    // The origin is away, so the final push fails.
    const away = `${s.origin.path}.away`;
    renameSync(s.origin.path, away);
    const stop = {
      kind: 'stop_attempt',
      attemptId: 'T-4-a1',
      fence: spec.fence,
      cause: 'stop',
      reason: 'done',
      handoff: false,
      interruptFirst: false,
      keepClone: true,
    } as const;
    expect(await run(s.hub, stop)).toMatchObject({ ok: true });
    const exited = await s.hub.waitFor(() => s.hub.events().find((event) => event.type === 'attempt.exited'));
    const finalSha = (exited.data as { finalSha: string }).finalSha;
    expect(exited.data).toMatchObject({ finalWip: null, pushError: expect.any(String) });
    expect(new AttemptStore(s.db).get('T-4-a1')?.lateWorkSha).toBe(finalSha);
    await first.close();
    renameSync(away, s.origin.path);

    await s.start({ config });
    const late = await s.hub.waitFor(() => s.hub.events().find((event) => event.type === 'attempt.late_work'));
    const ref = 'refs/agflow/T-4/a1-late-1';
    expect(late.data).toEqual({ taskId: 'T-4', ref, sha: finalSha });
    expect(await gitIn(s.origin.path, ['rev-parse', ref])).toBe(finalSha);
    expect(new AttemptStore(s.db).get('T-4-a1')).toMatchObject({ lateWorkSha: null, pushError: null });
  });

  test('after welcome, a drain made while the runner was down goes out as runner.settings; none when nothing changed', async () => {
    const snapshot = {
      capacity: 2,
      keepAwake: 'ac' as const,
      draining: false,
      ceilings: { claude: { fiveHour: 0.85, weekly: 0.85 }, codex: { fiveHour: 0.85, weekly: 0.85 } },
      allowPaidUsage: { claude: false, codex: false },
      version: 4,
    };
    const s = await setup();
    await s.start({ config: { draining: true, confirmedSettings: snapshot } });
    const settings = () => s.hub.events().filter((event) => event.type === 'runner.settings');
    const [sent] = await s.hub.waitFor(() => settings().length > 0 && settings());
    expect(sent?.data).toEqual({ settings: { draining: true }, baseVersion: 4 });

    const same = await setup();
    await same.start({ config: { confirmedSettings: snapshot } });
    // The welcome records the hub epoch and then sends the edits, in the same call.
    await waitFor(() => same.db.meta('lastHubEpoch') !== null);
    expect(new Outbox(same.db).eventsAfter(0).filter((event) => event.type === 'runner.settings')).toEqual([]);
  });

  test('a local edit the outbox still carries is not sent again after a reconnect: the replay delivers it, or the hub applied it and its echo is to come', async () => {
    const snapshot = {
      capacity: 2,
      keepAwake: 'ac' as const,
      draining: false,
      ceilings: { claude: { fiveHour: 0.85, weekly: 0.85 }, codex: { fiveHour: 0.85, weekly: 0.85 } },
      allowPaidUsage: { claude: false, codex: false },
      version: 4,
    };
    for (const autoAck of [false, true]) {
      // The second link's welcome names another WIP ref prefix, so the test knows when the runner has handled it.
      const s = await setup({
        autoAck,
        welcome: (_hello, connection) => (connection.index === 0 ? {} : { wipRefPrefix: 'refs/agflow-2/' }),
      });
      await s.start({ config: { draining: true, confirmedSettings: snapshot } });
      // Probes aside: this hub acknowledges the drain and never echoes it, as a hub that refused it would.
      const settings = () => s.hub.events().filter(isEdit);
      const [sent] = await s.hub.waitFor(() => settings().length > 0 && settings());
      expect(sent?.data).toEqual({ settings: { draining: true }, baseVersion: 4 });
      (await s.hub.connection(0)).close(1012, 'the hub restarts');
      await waitFor(() => s.db.meta('wipRefPrefix') === 'refs/agflow-2/');
      const outbox = new Outbox(s.db);
      expect(outbox.eventsAfter(0).filter(isEdit)).toHaveLength(1);
      if (!autoAck) await s.hub.waitFor(() => settings().length === 2);
      expect(new Set(settings().map((event) => event.seq))).toEqual(new Set([sent?.seq as number]));
    }
  });

  test("an acknowledged edit is not sent again after a reconnect when the owner's echo came before its own", async () => {
    const snapshot = {
      capacity: 2,
      keepAwake: 'ac' as const,
      draining: false,
      ceilings: { claude: { fiveHour: 0.85, weekly: 0.85 }, codex: { fiveHour: 0.85, weekly: 0.85 } },
      allowPaidUsage: { claude: false, codex: false },
      version: 4,
    };
    const s = await setup({
      welcome: (_hello, connection) => (connection.index === 0 ? {} : { wipRefPrefix: 'refs/agflow-2/' }),
    });
    await s.start({ config: { draining: true, confirmedSettings: snapshot } });
    // Probes aside: this hub acknowledges the drain before its echo, which M2a never does.
    const settings = () => s.hub.events().filter(isEdit);
    const [sent] = await s.hub.waitFor(() => settings().length > 0 && settings());
    const outbox = new Outbox(s.db);
    await waitFor(() => outbox.ackedSeq() >= (sent?.seq as number));
    // The hub applied the owner's edit before the drain: its echo comes first, and the drain's is still to come.
    expect(await run(s.hub, { kind: 'update_settings', settings: { capacity: 3 }, version: 5 })).toMatchObject({
      ok: true,
    });
    (await s.hub.connection(0)).close(1012, 'the hub restarts');
    await waitFor(() => s.db.meta('wipRefPrefix') === 'refs/agflow-2/');
    expect(outbox.eventsAfter(0).filter(isEdit)).toHaveLength(1);
    // Its own echo: in flight no longer, and nothing to send after the next welcome either.
    expect(await run(s.hub, { kind: 'update_settings', settings: { draining: true }, version: 6 })).toMatchObject({
      ok: true,
    });
    expect(outbox.settingsInFlight().filter(isEdit)).toEqual([]);
    expect(outbox.eventsAfter(0).filter(isEdit)).toHaveLength(1);
  });

  test('an echo of an older edit leaves runner.json on the newer edit in flight, and the next welcome sends neither again', async () => {
    const s = await setup({
      welcome: (_hello, connection) => (connection.index === 0 ? {} : { wipRefPrefix: 'refs/agflow-2/' }),
    });
    // A drain and an undrain made before this start, still in the outbox: runner.json is back at the snapshot.
    const outbox = new Outbox(s.db);
    for (const draining of [true, false]) {
      outbox.append({ type: 'runner.settings', data: { settings: { draining }, baseVersion: 4 } });
    }
    await s.start({ config: { confirmedSettings: SNAPSHOT } });
    await waitFor(() => outbox.ackedSeq() >= 2);
    // The hub applied both, and the drain's echo comes first.
    expect(await run(s.hub, { kind: 'update_settings', settings: { draining: true }, version: 5 })).toMatchObject({
      ok: true,
    });
    expect(await runnerJson(s)).toMatchObject({ draining: false, confirmedSettings: { draining: true, version: 5 } });
    (await s.hub.connection(0)).close(1012, 'the hub restarts');
    await waitFor(() => s.db.meta('wipRefPrefix') === 'refs/agflow-2/');
    const edits = outbox.eventsAfter(0).filter(isEdit);
    expect(edits.map((event) => (event.type === 'runner.settings' ? event.data.settings : null))).toEqual([
      { draining: true },
      { draining: false },
    ]);
    expect(await run(s.hub, { kind: 'update_settings', settings: { draining: false }, version: 6 })).toMatchObject({
      ok: true,
    });
    expect(await runnerJson(s)).toMatchObject({ draining: false, confirmedSettings: { draining: false, version: 6 } });
    expect(outbox.settingsInFlight().filter(isEdit)).toEqual([]);
  });

  test("a refused edit: a probe follows its acknowledgement, and at the probe's echo runner.json takes the hub's value", async () => {
    const s = await setup({
      welcome: (_hello, connection) => (connection.index === 0 ? {} : { wipRefPrefix: 'refs/agflow-2/' }),
    });
    // A capacity edit made while the runner was down.
    await s.start({ config: { capacity: 3, confirmedSettings: SNAPSHOT } });
    const settings = () => s.hub.events().filter((event) => event.type === 'runner.settings');
    const [edit, probe] = await s.hub.waitFor(() => settings().length === 2 && settings());
    expect(edit?.data).toEqual({ settings: { capacity: 3 }, baseVersion: 4 });
    expect(probe?.data).toEqual({ settings: {}, baseVersion: 4 });
    // The hub acknowledged the edit and never echoed it: it refused it. The probe's echo says so.
    expect(await run(s.hub, { kind: 'update_settings', settings: {}, version: 5 })).toMatchObject({ ok: true });
    expect(await runnerJson(s)).toMatchObject({ capacity: 2, confirmedSettings: { capacity: 2, version: 5 } });
    expect(s.logger.entries).toContainEqual({
      level: 'warn',
      message: "the hub refused a settings edit; runner.json takes the hub's settings",
      fields: { seq: edit?.seq, settings: { capacity: 3 } },
    });
    expect(new Outbox(s.db).settingsInFlight()).toEqual([]);
    // Nothing goes again, after the next welcome either.
    (await s.hub.connection(0)).close(1012, 'the hub restarts');
    await waitFor(() => s.db.meta('wipRefPrefix') === 'refs/agflow-2/');
    expect(new Outbox(s.db).eventsAfter(0).filter((event) => event.type === 'runner.settings')).toHaveLength(2);
  });

  test("after a hub restore, the replay leaves out the edits whose echo the snapshot holds, and a probe ends it", async () => {
    // The welcomes after the first are a restored hub's, of a new hub epoch: its backup acknowledged nothing.
    const s = await setup({
      autoAck: false,
      welcome: (_hello, connection) =>
        connection.index === 0 ? {} : { ackedSeq: 0, hubEpoch: 2, wipRefPrefix: 'refs/agflow-2/' },
    });
    const runner = await s.start({ config: { draining: true, confirmedSettings: SNAPSHOT } });
    const outbox = new Outbox(s.db);
    const settings = (index: number) =>
      (s.hub.connections[index]?.messages ?? [])
        .flatMap((message) => (message.t === 'events' ? message.events : []))
        .filter((event) => event.type === 'runner.settings');
    // The drain, and the probe this hub's ack without an echo brings; both echoed and acknowledged.
    const [drain] = await s.hub.waitFor(() => settings(0).length === 1 && settings(0));
    const first = await s.hub.connection(0);
    first.send({ t: 'ack', outboxEpoch: outbox.epoch, seq: drain!.seq });
    const [, probe] = await s.hub.waitFor(() => settings(0).length === 2 && settings(0));
    expect(await run(s.hub, { kind: 'update_settings', settings: { draining: true }, version: 5 })).toMatchObject({
      ok: true,
    });
    expect(await run(s.hub, { kind: 'update_settings', settings: {}, version: 6 })).toMatchObject({ ok: true });
    const probeAcked = runner.waitAcked(probe!.seq, 5_000);
    first.send({ t: 'ack', outboxEpoch: outbox.epoch, seq: probe!.seq });
    expect(await probeAcked).toBe(true);
    expect(outbox.settingsInFlight()).toEqual([]);
    // The hub is restored. At its first welcome the runner records what it holds and says hello again at once, sending
    // nothing first. That hello reports version 6, which the hub adopts, and the replay starts from 0. Applying the
    // drain again would undo whatever came after it; so would the probe, were it an edit. A new probe goes instead, so
    // the hub's acknowledgement reaches hello.lastSeq.
    (await s.hub.connection(0)).close(1012, 'the hub restarts');
    const [replayed] = await s.hub.waitFor(() => settings(2).length > 0 && settings(2));
    expect(s.hub.connections[1]?.messages.map((message) => message.t)).toEqual(['hello']);
    expect(hellos(s.hub)[2]).toMatchObject({ settings: { draining: true, version: 6 }, lastHubEpoch: 2 });
    expect(replayed?.data).toEqual({ settings: {}, baseVersion: 6 });
    expect(replayed?.seq).toBeGreaterThan(probe?.seq as number);
    expect(settings(2).map((event) => event.seq)).not.toContain(drain?.seq);
    expect(outbox.ackedSeq()).toBeLessThan(replayed!.seq);
    // Subscribe through the runtime's Outbox, then release the ack; a separately constructed Outbox has no
    // runtime ack callbacks. This exercises the ordering that used to fail when the ack arrived after the wait.
    const replayAcked = runner.waitAcked(replayed!.seq, 5_000);
    (await s.hub.connection(2)).send({ t: 'ack', outboxEpoch: outbox.epoch, seq: replayed!.seq });
    expect(await replayAcked).toBe(true);
    // The welcomes of that hub that follow do not count as a restore.
    expect(s.hub.connections).toHaveLength(3);
  });

  test("after the welcome of a restored hub the runner says hello again before it runs or sends anything, so that hub's next welcome finds the runner's snapshot", async () => {
    const { version: _version, ...values } = SNAPSHOT;
    // The restored hub's backup predates this runner: M2a registers it anew, stores hello's settings at version 1, and
    // sends them right after the welcome. Run, that echo would be stale (the snapshot is at 4), and every version the
    // hub hands out next one the runner already has; the next hello instead reports 4, which the hub adopts,
    // cancelling the echo.
    const whole: RunnerCommand = { kind: 'update_settings', settings: values, version: 1 };
    const s = await setup({
      welcome: (_hello, connection) => {
        if (connection.index === 0) return {};
        if (connection.index === 1) {
          queueMicrotask(() => connection.send({ t: 'command', id: '2-R-1001-1', seq: 1, command: whole }));
        }
        return { ackedSeq: 0, hubEpoch: 2, runnerId: 'R-1001' };
      },
    });
    await s.start({ config: { draining: true, confirmedSettings: SNAPSHOT } });
    const edits = (index: number) =>
      (s.hub.connections[index]?.messages ?? [])
        .flatMap((message) => (message.t === 'events' ? message.events : []))
        .filter(isEdit);
    // The drain made while the runner was down went to the old hub, which acknowledged it and never echoed it.
    const [drain] = await s.hub.waitFor(() => edits(0).length > 0 && edits(0));
    await waitFor(() => new Outbox(s.db).ackedSeq() >= (drain?.seq as number));
    (await s.hub.connection(0)).close(1012, 'the hub was restored');
    const third = await s.hub.connection(2, 5_000);
    await s.hub.waitFor(() => third.messages.some((message) => message.t === 'hello'));
    expect(hellos(s.hub)[2]).toMatchObject({ settings: SNAPSHOT, lastHubEpoch: 2 });
    // Nothing ran or went out on the restored hub's first connection: no result, no event, no journal row.
    expect(s.hub.connections[1]?.messages.map((message) => message.t)).toEqual(['hello']);
    expect(new Journal(s.db).get('2-R-1001-1')).toBeNull();
    expect(s.db.meta('restoredThrough')).toBeGreaterThanOrEqual(drain?.seq as number);
    // The drain is still in flight: the replay to the restored hub delivers it, and runner.json keeps it.
    const [replayed] = await s.hub.waitFor(() => edits(2).length > 0 && edits(2));
    expect(replayed?.seq).toBe(drain?.seq);
    expect(await runnerJson(s)).toMatchObject({ draining: true, confirmedSettings: SNAPSHOT });
    expect(s.hub.results.size).toBe(0);
    expect(s.hub.connections).toHaveLength(3);
  });

  test("a restored hub's epoch is recorded after what the runner held at its welcome, so a death between the two records that again", async () => {
    const s = await setup({
      welcome: (_hello, connection) => (connection.index === 0 ? {} : { ackedSeq: 0, hubEpoch: 2 }),
    });
    // What runner.db holds as the restored hub's epoch is written: a death right after that write leaves this.
    const restoredThrough: (number | null)[] = [];
    const setMeta = s.db.setMeta.bind(s.db);
    s.db.setMeta = ((key: string, value: unknown) => {
      if (key === 'lastHubEpoch' && value === 2) restoredThrough.push(s.db.meta('restoredThrough'));
      (setMeta as (key: string, value: unknown) => void)(key, value);
    }) as typeof s.db.setMeta;
    await s.start({ config: { draining: true, confirmedSettings: SNAPSHOT } });
    await waitFor(() => new Outbox(s.db).ackedSeq() > 0);
    (await s.hub.connection(0)).close(1012, 'the hub was restored');
    await waitFor(() => restoredThrough.length > 0);
    expect(restoredThrough[0]).toBeGreaterThan(0);
  });

  test('any replay but one to a restored hub sends every edit the hub has not acknowledged, one an equal echo answered included', async () => {
    // This hub acknowledges nothing; the second welcome names another prefix, so the test knows when it was handled.
    const s = await setup({
      autoAck: false,
      welcome: (_hello, connection) => (connection.index === 0 ? {} : { wipRefPrefix: 'refs/agflow-2/' }),
    });
    // A drain made while the runner was down goes out after the welcome.
    await s.start({ config: { draining: true, confirmedSettings: SNAPSHOT } });
    const edits = (index: number) =>
      (s.hub.connections[index]?.messages ?? [])
        .flatMap((message) => (message.t === 'events' ? message.events : []))
        .filter(isEdit);
    const [drain] = await s.hub.waitFor(() => edits(0).length > 0 && edits(0));
    // The owner drained in the browser before the hub read the runner's drain: that echo answers the drain.
    expect(await run(s.hub, { kind: 'update_settings', settings: { draining: true }, version: 5 })).toMatchObject({
      ok: true,
    });
    expect(new Outbox(s.db).settingsInFlight().filter(isEdit)).toEqual([]);
    // The link drops before the hub applied the drain: the same hub's replay sends it, as nothing has applied it.
    (await s.hub.connection(0)).close(1012, 'the hub restarts');
    const [replayed] = await s.hub.waitFor(() => edits(1).length > 0 && edits(1));
    expect(replayed?.seq).toBe(drain?.seq);
  });

  test('a failed write of runner.json leaves the echo in the settings the runner holds, which the next hello reports', async () => {
    const s = await setup({
      welcome: (_hello, connection) => (connection.index === 0 ? {} : { wipRefPrefix: 'refs/agflow-2/' }),
    });
    await s.start({ config: { confirmedSettings: SNAPSHOT } });
    await waitFor(() => s.db.meta('lastHubEpoch') !== null);
    expect(s.db.meta('settingsSavedVersion')).toBe(4);
    // runner.json's directory is read-only for one echo.
    const dir = dirname(s.paths.config);
    chmodSync(dir, 0o500);
    let result: unknown;
    try {
      result = await run(s.hub, { kind: 'update_settings', settings: { draining: true }, version: 5 });
    } finally {
      chmodSync(dir, 0o700);
    }
    expect(result).toMatchObject({ ok: true });
    expect(await runnerJson(s)).toMatchObject({ draining: false, confirmedSettings: { version: 4 } });
    expect(s.db.meta('settingsSavedVersion')).toBe(4);
    (await s.hub.connection(0)).close(1012, 'the hub restarts');
    await waitFor(() => s.db.meta('wipRefPrefix') === 'refs/agflow-2/');
    expect(hellos(s.hub)[1]?.settings).toMatchObject({ draining: true, version: 5 });
    // The next echo writes runner.json with both.
    expect(await run(s.hub, { kind: 'update_settings', settings: { capacity: 3 }, version: 6 })).toMatchObject({
      ok: true,
    });
    expect(await runnerJson(s)).toMatchObject({
      capacity: 3,
      draining: true,
      confirmedSettings: { capacity: 3, draining: true, version: 6 },
    });
    expect(s.db.meta('settingsSavedVersion')).toBe(6);
  });

  test("the person's drain made offline, while the owner's drain and undrain wait behind a long command, reaches the hub", async () => {
    /** A Claude adapter whose preflight the test holds. */
    class HeldAdapter extends FakeAdapter {
      hold: PromiseWithResolvers<void> | null = null;
      override async preflight() {
        await this.hold?.promise;
        return super.preflight();
      }
    }
    const held = new HeldAdapter({ vendor: 'claude', skipAuthChecks: true, script: { turns: [[]] } });
    const codex = new FakeAdapter({ vendor: 'codex', skipAuthChecks: true, script: { turns: [[]] } });
    // The second connection gets its welcome only when the test sends it.
    const s = await setup({ welcome: (_hello, connection) => (connection.index === 0 ? {} : false) });
    const runner = await s.start({ config: { confirmedSettings: SNAPSHOT }, adapters: [held, codex] });
    await waitFor(() => runner.status().link === 'online');
    held.hold = Promise.withResolvers<void>();
    const journal = new Journal(s.db);
    const echoes: RunnerCommand[] = [
      { kind: 'update_settings', settings: { draining: true }, version: 5 },
      { kind: 'update_settings', settings: { draining: false }, version: 6 },
    ];
    const ids = [s.hub.command({ kind: 'preflight', vendor: 'claude' }), ...echoes.map((echo) => s.hub.command(echo))];
    await waitFor(() => ids.every((id) => journal.get(id) !== null));
    // The link drops, and the runner says hello again; offline, the person drains. The owner's echoes then run: taken
    // before that hello, they answer nothing, for the hub to send again after its welcome.
    (await s.hub.connection(0)).close(1012, 'the hub restarts');
    const connection = await s.hub.connection(1);
    await s.hub.waitFor(() => connection.messages.some((message) => message.t === 'hello'));
    const seq = await runner.changeSettings({ draining: true });
    held.hold.resolve();
    await waitFor(() => s.logger.entries.filter((entry) => /before the last hello/.test(entry.message)).length === 2);
    expect(ids.slice(1).map((id) => journal.get(id)?.state)).toEqual(['running', 'running']);
    expect(await runnerJson(s)).toMatchObject({ draining: true, confirmedSettings: { draining: false, version: 4 } });
    // The welcome, and the hub sends them again. The drain is still in flight: runner.json keeps it, and the replay on
    // the same hub sends it.
    connection.send(testWelcome(0));
    for (const [index, command] of echoes.entries()) {
      connection.send({ t: 'command', id: ids[index + 1] as string, seq: index + 2, command });
    }
    await waitFor(() => journal.get(ids[2] as string)?.state === 'done');
    expect(runner.status().settings.draining).toBe(true);
    expect(await runnerJson(s)).toMatchObject({ draining: true, confirmedSettings: { draining: false, version: 6 } });
    const replayed = await s.hub.waitFor(() => {
      const edits = connection.messages.flatMap((message) => (message.t === 'events' ? message.events : []));
      return edits.find((event) => event.type === 'runner.settings' && event.seq === seq);
    });
    expect(replayed).toMatchObject({ data: { settings: { draining: true } } });
  });

  test("hello carries the health seam's state, and git not ready when the vault cannot be made", async () => {
    const s = await setup();
    // A file where the vault goes.
    const vault = s.paths.vault(projectKey(s.hub.url, PROJECT));
    mkdirSync(dirname(vault), { recursive: true });
    writeFileSync(vault, 'not a repository\n');
    const health: RunnerHealth = {
      admit: () => null,
      heartbeat: () => ({ power: null, disk: null, acceptingUntil: null }),
      state: () => ({ state: 'disk_low', detail: 'x' }),
    };
    await s.start({ health });
    const [hello] = await s.hub.waitFor(() => hellos(s.hub).length > 0 && hellos(s.hub));
    expect(hello?.state).toBe('disk_low');
    expect(hello?.stateDetail).toBe('x');
    expect(hello?.git).toEqual({
      ready: false,
      problem: expect.stringMatching(/cannot prepare the vault/),
      lastPushAt: null,
    });
  });

  test('after three consecutive failed WIP pushes, hello says git is not ready', async () => {
    const timings = { heartbeatMs: 50, deadLinkMs: 60_000, handoffMs: 1_000, wipGraceMs: 300_000 };
    const s = await setup({ welcome: { timings } });
    const runner = await s.start({
      // This tests the hello's failure count. Drive its three pushes explicitly through the runtime handle;
      // the normal WIP interval stays at its default, rather than enqueueing harvests every 100 ms.
      config: { timings: { backoffBase: 50, backoffCap: 100 } },
      // A scripted terminal result prevents autonomous continuations from releasing the write before the test.
      script: { turns: [[{ do: 'terminal', tool: 'blocked' }], [{ do: 'write', path: 'work.txt', content: 'work\n' }]] },
    });
    await s.hub.waitFor(() => hellos(s.hub).length > 0);
    const spec = specOf(s);
    expect(await run(s.hub, { kind: 'start_attempt', attempt: spec })).toMatchObject({ ok: true });
    const completedTurns = () => s.hub.events().filter(
      (event) => event.type === 'attempt.activity' && (event.data as { kind: string }).kind === 'turn',
    ).length;
    await s.hub.waitFor(() => completedTurns() === 1, 10_000);
    renameSync(s.origin.path, `${s.origin.path}.gone`);
    try {
      // The write is released only after the origin is gone; it cannot land successfully before the failure test.
      expect(await run(s.hub, {
        kind: 'deliver', attemptId: spec.attemptId, fence: spec.fence,
        messages: [{ messageId: 7, authority: 'person', text: 'write the work' }], more: 0,
      })).toMatchObject({ ok: true });
      await s.hub.waitFor(() => completedTurns() === 2, 10_000);
      for (let i = 0; i < 3; i++) {
        expect(await runner.pushWipNow()).toMatchObject([{ attemptId: spec.attemptId, outcome: { status: 'failed' } }]);
      }
      const failed = () => s.hub.events().filter((event) => event.type === 'attempt.wip_failed');
      await s.hub.waitFor(() => failed().length >= 3, 10_000);
      expect(failed().map((event) => (event.data as { failures: number }).failures)).toEqual([1, 2, 3]);
      s.hub.connections[0]?.close(4000, 'the hub restarts');
      const again = await s.hub.waitFor(() => hellos(s.hub)[1], 10_000);
      expect(again.git).toMatchObject({
        ready: false,
        problem: expect.stringMatching(/^\d+ consecutive WIP pushes failed$/),
      });
    } finally {
      renameSync(`${s.origin.path}.gone`, s.origin.path);
      await runner.stopAgents('runner_stop', { handoff: false });
    }
  }, 30_000);

  test('after the first welcome, the journal rows a previous run left running are settled', async () => {
    const s = await setup();
    const journal = new Journal(s.db);
    journal.begin('0-R-1-1', 1, { kind: 'preflight', vendor: 'claude' });
    const fence = { epoch: 1, counter: 1 };
    journal.begin('0-R-1-2', 2, { kind: 'deliver', attemptId: 'T-4-a1', fence, messages: [], more: 0 });
    await s.start();
    await s.hub.waitFor(() => journal.get('0-R-1-1')?.state === 'done', 10_000);
    expect(journal.get('0-R-1-1')?.result).toEqual({ ok: true });
    // A preflight is run again, and reported; a delivery is not, the hub resends what it still wants.
    await s.hub.waitFor(() => s.hub.events().some((event) => event.type === 'runner.vendors'));
    await s.hub.waitFor(() => journal.get('0-R-1-2')?.state === 'done');
    expect(journal.get('0-R-1-2')?.result).toEqual({ ok: false, error: 'interrupted' });
  });

  test("heartbeats list the facts of every live attempt, a start still preparing included, and the health seam's power, disk and acceptingUntil", async () => {
    const timings = { heartbeatMs: 50, deadLinkMs: 60_000, handoffMs: 1_000, wipGraceMs: 300_000 };
    const s = await setup({ welcome: { timings } });
    const health: RunnerHealth = {
      admit: () => null,
      heartbeat: () => ({
        power: { source: 'battery', batteryPercent: 64, lowPowerMode: false },
        disk: { freeBytes: 42_000_000_000, agflowBytes: 1_000_000 },
        acceptingUntil: 1_000,
      }),
      state: () => ({ state: 'ok', detail: null }),
    };
    // T-6's dependency preparation waits until the test lets it go.
    const release = Promise.withResolvers<void>();
    const preparer = {
      available: true,
      prepare: async (input: PrepareInput) => {
        if (input.attemptId === 'T-6-a1') await release.promise;
        return { ran: false, ok: true, error: null, logTail: null };
      },
    };
    await s.start({ health, preparer, config: { capacity: 3 }, script: { turns: [[{ do: 'sleep', ms: 30_000 }]] } });
    await s.hub.waitFor(() => hellos(s.hub).length > 0);
    const heartbeat = (check: (attempts: { attemptId: string; phase: string }[], at: number) => boolean) =>
      s.hub.waitFor(
        () => s.hub.messages().find((message) => message.t === 'heartbeat' && check(message.attempts, message.at)),
        10_000,
      );
    const spec = specOf(s);
    const other = specOf(s, { attemptId: 'T-5-a1', taskId: 'T-5', branch: 'agflow/T-5-x', wipRef: 'refs/agflow/T-5/a1' });
    for (const attempt of [spec, other]) {
      expect(await run(s.hub, { kind: 'start_attempt', attempt })).toMatchObject({ ok: true });
    }
    const both = await heartbeat(
      (attempts) => attempts.filter((facts) => facts.phase === 'turn').length === 2,
    );
    expect(both).toMatchObject({
      power: { source: 'battery', batteryPercent: 64, lowPowerMode: false },
      disk: { freeBytes: 42_000_000_000, agflowBytes: 1_000_000 },
      acceptingUntil: 1_000,
    });
    if (both.t !== 'heartbeat') throw new Error('not a heartbeat');
    const listed = both.attempts.map(({ attemptId, fence, phase }) => ({ attemptId, fence, phase }));
    expect(listed.sort((a, b) => a.attemptId.localeCompare(b.attemptId))).toEqual([
      { attemptId: 'T-4-a1', fence: spec.fence, phase: 'turn' },
      { attemptId: 'T-5-a1', fence: other.fence, phase: 'turn' },
    ]);

    // A start held in its preparation has no process yet: its lease is renewed all the same.
    const held = specOf(s, {
      attemptId: 'T-6-a1',
      taskId: 'T-6',
      branch: 'agflow/T-6-x',
      wipRef: 'refs/agflow/T-6/a1',
      fence: { epoch: 1, counter: 3 },
    });
    const starting = run(s.hub, { kind: 'start_attempt', attempt: held });
    const preparing = await heartbeat((attempts) => attempts.some((facts) => facts.phase === 'preparing'));
    if (preparing.t !== 'heartbeat') throw new Error('not a heartbeat');
    expect(preparing.attempts.find((facts) => facts.attemptId === 'T-6-a1')).toEqual({
      attemptId: 'T-6-a1',
      fence: held.fence,
      phase: 'preparing',
      eventAgeMs: 0,
      tool: null,
      fsAgeMs: null,
      commitAgeMs: null,
      turns: 0,
      turnsWithoutProgress: 0,
      repeatedCalls: 0,
      continuations: 0,
      vendorErrorMs: 0,
      activeMs: 0,
      contextUsed: null,
    });
    release.resolve();
    expect(await starting).toMatchObject({ ok: true });
    expect(s.hub.invalid).toEqual([]);

    const stop = {
      kind: 'stop_attempt',
      attemptId: 'T-4-a1',
      fence: spec.fence,
      cause: 'stop',
      reason: 'done',
      handoff: false,
      interruptFirst: true,
      keepClone: true,
    } as const;
    expect(await run(s.hub, stop)).toMatchObject({ ok: true });
    const stopped = Date.now();
    const later = await heartbeat((_attempts, at) => at > stopped);
    if (later.t !== 'heartbeat') throw new Error('not a heartbeat');
    expect(later.attempts.map((facts) => facts.attemptId).sort()).toEqual(['T-5-a1', 'T-6-a1']);
  }, 40_000);
});
