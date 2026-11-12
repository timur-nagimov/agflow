import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScriptResources, withScriptResources } from './resources';

test('cleanup is idempotent, runs in reverse order, and continues after a cleanup error', async () => {
  const resources = new ScriptResources();
  const dir = resources.directory(join(tmpdir(), 'agflow-cleanup-test-'));
  const calls: number[] = [];
  resources.defer(() => { calls.push(1); });
  resources.defer(() => { calls.push(2); throw new Error('cleanup failed'); });
  try {
    await expect(resources.close()).rejects.toThrow('cleanup failed');
    await expect(resources.close()).rejects.toThrow('cleanup failed');
    expect(calls).toEqual([2, 1]);
    expect(existsSync(dir)).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const throws of [false, true]) {
  test(`scope removes temporary files on ${throws ? 'throw' : 'success'}`, async () => {
    let dir = '';
    try {
      const run = withScriptResources(async (resources) => {
        dir = resources.directory(join(tmpdir(), 'agflow-cleanup-test-'));
        writeFileSync(join(dir, 'agflow.db'), 'scratch');
        if (throws) throw new Error('work failed');
        return 42;
      });
      if (throws) await expect(run).rejects.toThrow('work failed');
      else expect(await run).toBe(42);
      expect(existsSync(dir)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  test(`${signal} stops and waits for children before removing their directory`, async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'agflow-cleanup-fixture-'));
    const childScript = join(fixture, 'child.ts');
    const ownerScript = join(fixture, 'owner.ts');
    const marker = join(fixture, 'stopped');
    writeFileSync(childScript, `
      import { existsSync, writeFileSync } from 'node:fs';
      process.on('SIGTERM', () => {
        writeFileSync(${JSON.stringify(marker)}, String(existsSync(process.argv[2])));
        process.exit(0);
      });
      console.log('ready');
      setInterval(() => {}, 1000);
    `);
    writeFileSync(ownerScript, `
      import { withScriptResources } from ${JSON.stringify(join(import.meta.dir, 'resources.ts'))};
      await withScriptResources(async (resources) => {
        const dir = resources.directory(${JSON.stringify(join(fixture, 'owned-'))});
        const child = resources.child(Bun.spawn([process.execPath, ${JSON.stringify(childScript)}, dir], { stdout: 'pipe' }));
        await child.stdout.getReader().read();
        console.log(dir);
        await new Promise(() => {});
      });
    `);
    const proc = Bun.spawn([process.execPath, ownerScript], { stdout: 'pipe', stderr: 'pipe' });
    try {
      const { value } = await proc.stdout.getReader().read();
      const dir = new TextDecoder().decode(value).trim();
      expect(existsSync(dir)).toBe(true);
      proc.kill(signal);
      expect(await proc.exited).toBe(signal === 'SIGINT' ? 130 : 143);
      expect(readFileSync(marker, 'utf8')).toBe('true');
      expect(existsSync(dir)).toBe(false);
    } finally {
      proc.kill('SIGKILL');
      rmSync(fixture, { recursive: true, force: true });
    }
  });
}

test('cleanup waits for an acquisition already in flight and disposes it', async () => {
  const resources = new ScriptResources();
  const ready = Promise.withResolvers<string>();
  const disposed: string[] = [];
  const acquired = resources.acquire(ready.promise, (value) => { disposed.push(value); });
  const closed = resources.close();
  ready.resolve('resource');
  await expect(acquired).rejects.toThrow('script is closing');
  await closed;
  expect(disposed).toEqual(['resource']);
});
