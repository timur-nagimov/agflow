// Runner processes against a hub process (design 7.1, 7.4, 15): `agflow runner start` with the real adapters, one
// runner per vendor, each offering only that vendor. Runs only with AGFLOW_E2E=1.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { type Runner, TEST_ACCOUNT_ID, type Vendor } from '@agflow/core';
import { type OriginRepo, originRepo } from '../src/git-fixtures';
import { describeE2e, E2E_TEST_TIMEOUT_MS, e2eVendors, requireE2e } from '../src/harness/env';
import { E2E_HUB_TIMINGS, type HubProcess, startHubProcess } from '../src/harness/hub-process';
import { type Models, startModels } from '../src/harness/models';
import { cliToken, type Person, signIn } from '../src/harness/person';
import { descendantsOf, listProcesses } from '../src/harness/proc';
import {
  prepareRunnerHome,
  type RunnerHome,
  type RunnerProcess,
  startRunnerProcess,
} from '../src/harness/runner-process';

// A runner start runs both preflights and the sandbox probe; a stop waits for the suspend.
setDefaultTimeout(E2E_TEST_TIMEOUT_MS);

const VENDORS: readonly Vendor[] = ['claude', 'codex'];

describeE2e('runner processes', () => {
  let dir = '';
  let origin: OriginRepo | null = null;
  let hub: HubProcess | null = null;
  let models: Models | null = null;
  let alice: Person;
  const homes: RunnerHome[] = [];
  const runners = new Map<Vendor, RunnerProcess>();

  beforeAll(async () => {
    const { binaries } = await requireE2e();
    dir = realpathSync(mkdtempSync('/tmp/agf-rp-'));
    origin = await originRepo({ 'README.md': 'runner process test\n' });
    hub = await startHubProcess({ dir: join(dir, 'hub'), repo: origin.path });
    models = await startModels();
    alice = await signIn(hub.url, 'alice');
    // No runner lead: these runners stay idle.
    await alice.setRunnerLeads(false);
    for (const vendor of e2eVendors()) {
      const home = await prepareRunnerHome({
        dir: join(dir, vendor),
        name: `alice-${vendor}`,
        credentials: { hubUrl: hub.url, token: await cliToken(alice), user: 'alice' },
        vendors: [vendor],
        binaries,
        models,
      });
      homes.push(home);
      runners.set(vendor, await startRunnerProcess(home));
    }
  });

  afterAll(async () => {
    for (const runner of runners.values()) await runner.close();
    await models?.close();
    if (hub?.running) await hub.kill();
    for (const home of homes) home.remove();
    origin?.remove();
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
  });

  async function hubRunner(name: string): Promise<Runner> {
    const found = (await alice.runners()).runners.find((runner) => runner.name === name);
    if (!found) throw new Error(`the hub has no runner named ${name}`);
    return found;
  }

  async function until(check: () => Promise<boolean>, what: string, timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting until ${what}`);
      await Bun.sleep(250);
    }
  }

  test('each runner is online under its name and owner; its vendor is ready in test mode and the other is missing', async () => {
    for (const [vendor, runner] of runners) {
      const found = await hubRunner(runner.name);
      expect(found).toMatchObject({ owner: 'alice', state: 'online', keepAwake: 'off', capacity: 2 });
      for (const other of VENDORS) {
        const facts = found.vendors.find((entry) => entry.vendor === other);
        if (other === vendor) {
          const ready = { ready: true, problem: 'test mode', plan: 'test mode', accountId: TEST_ACCOUNT_ID };
          expect(facts).toMatchObject(ready);
        } else {
          expect(facts).toMatchObject({ ready: false, problem: 'binary missing' });
        }
      }
    }
  });

  test('status() parses `agflow runner status --json` as RunnerStatusReport', async () => {
    for (const runner of runners.values()) {
      const report = await runner.status();
      if (!report.running) throw new Error(`runner ${runner.name} reported offline: ${JSON.stringify(report)}`);
      expect(report.pid).toBe(runner.pid ?? -1);
      expect(report.name).toBe(runner.name);
      expect(report.mode).toBe('foreground');
      expect(report.link).toBe('online');
      expect(report.runnerId).toBe((await hubRunner(runner.name)).id);
      expect(report.keepAwake).toEqual({ mode: 'off', held: false });
      expect(report.attempts).toEqual([]);
    }
  });

  test('stop() suspends with SIGTERM and the runner exits 0; the hub shows it offline; start() reconnects it as the same runner', async () => {
    for (const runner of runners.values()) {
      const { id } = await hubRunner(runner.name);
      await runner.stop();
      expect(runner.running).toBe(false);
      expect(runner.exitCode).toBe(0);
      await until(async () => (await hubRunner(runner.name)).state === 'offline', `${runner.name} is offline`);
      await runner.start();
      const back = await hubRunner(runner.name);
      expect(back.id).toBe(id);
      await until(async () => (await hubRunner(runner.name)).state === 'online', `${runner.name} is online again`);
    }
  });

  test('freeze() stops the runner and its descendants, and the hub marks it offline; thaw() brings it back as the same process', async () => {
    const runner = [...runners.values()][0];
    if (!runner) throw new Error('no runner');
    const pid = runner.pid ?? -1;
    const frozenAt = Date.now();
    const frozen = await runner.freeze();
    expect(frozen[0]).toBe(pid);
    const tree = [pid, ...(await descendantsOf(pid)).map((row) => row.pid)];
    for (const row of await listProcesses(tree)) expect(row.stat.startsWith('T')).toBe(true);
    await until(async () => (await hubRunner(runner.name)).state === 'offline', `${runner.name} is offline`);
    expect(Date.now() - frozenAt).toBeGreaterThanOrEqual(E2E_HUB_TIMINGS.deadLinkMs - 1_000);
    await runner.thaw();
    await until(async () => (await hubRunner(runner.name)).state === 'online', `${runner.name} is online again`);
    expect(runner.pid).toBe(pid);
    const report = await runner.status();
    expect(report.running && report.pid).toBe(pid);
  });
});
