import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { type OriginRepo, originRepo } from '../src/git-fixtures';
import { type HubProcess, startHubProcess } from '../src/harness/hub-process';
import { signIn } from '../src/harness/person';

// Like the gated restore/restart scenarios: the fixture belongs to beforeAll, but its replacement processes
// start inside individual tests. The preload must retain those processes until the fixture's lifetime ends.
describe('a shared hub keeps its process scope across restarts', () => {
  let dir: string;
  let origin: OriginRepo | undefined;
  let hub: HubProcess;
  let pid: number | null;

  beforeAll(async () => {
    dir = mkdtempSync('/tmp/agf-hub-scope-');
    origin = await originRepo({ 'README.md': 'shared hub scope\n' });
    hub = await startHubProcess({ dir: join(dir, 'hub'), repo: origin.path });
  }, 30_000);

  afterAll(async () => {
    if (hub?.running) await hub.kill();
    origin?.remove();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test('restart completes during one scenario step', async () => {
    const old = hub.pid;
    await hub.restart();
    pid = hub.pid;
    expect(pid).not.toBe(old);
    expect(hub.running).toBe(true);
  }, 30_000);

  test('the replacement is still reachable in the next step', async () => {
    expect(hub.running).toBe(true);
    expect(hub.pid).toBe(pid);
    expect((await (await signIn(hub.url, 'alice')).status()).epoch).toBe(1);
  });

  test('restore starts another replacement during a scenario step', async () => {
    const backup = hub.backups('start').at(-1)!;
    await hub.stop();
    await hub.restore(backup);
    await hub.start();
    pid = hub.pid;
    expect((await (await signIn(hub.url, 'alice')).status()).epoch).toBe(2);
  }, 30_000);

  test('the restored hub is still reachable in the next step', async () => {
    expect(hub.running).toBe(true);
    expect(hub.pid).toBe(pid);
    expect((await (await signIn(hub.url, 'alice')).status()).epoch).toBe(2);
  });
});
