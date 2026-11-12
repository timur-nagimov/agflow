import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parsePs, PS_COLUMNS, PS_ENV } from '../../runner/src/processes';

const root = resolve(import.meta.dir, '../../..');
const agent = join(root, 'packages/testkit/src/fake-agent.ts');

function marked(marker: string) {
  const ps = Bun.spawnSync(['ps', '-axo', PS_COLUMNS], { env: { ...process.env, ...PS_ENV } });
  if (ps.exitCode !== 0) throw new Error('ps failed');
  return parsePs(ps.stdout.toString()).filter(row => !row.stat.startsWith('Z') && row.command.includes(marker));
}

for (const outcome of ['pass', 'fail', 'timeout', 'exit'] as const) {
  test(`test preload cleans detached fake tools after ${outcome}`, async () => {
    const marker = `agflow-leak-${crypto.randomUUID()}`;
    // Check ps before starting a fixture that intentionally leaks; a restricted sandbox must run this outside.
    marked(marker);
    const dir = mkdtempSync(join(tmpdir(), 'agflow-cleanup-'));
    const config = join(dir, 'agent.json');
    const ready = join(dir, 'ready');
    writeFileSync(config, JSON.stringify({
      // The agent exits before teardown: its detached tool must still be found after reparenting.
      script: { turns: [[{ do: 'tool', wait: false,
        command: `(while :; do echo tick >> '${ready}'; sleep 1; done) & wait # ${marker}`,
      }, { do: 'exit', code: 0 }]] },
      sessionRef: marker, model: 'fake', cliVersion: 'fake', firstPrompt: 'start', transcript: join(dir, 'transcript'),
    }));
    const fixture = join(dir, 'leak.test.ts');
    writeFileSync(fixture, `
      import { test } from 'bun:test';
      import { existsSync } from 'node:fs';
      test('intentional ${outcome}', async () => {
        const agent = Bun.spawn([process.execPath, '--config=/dev/null', ${JSON.stringify(agent)}, ${JSON.stringify(config)}], {
          detached: true, stdin: 'pipe', stdout: 'ignore', stderr: 'ignore',
        });
        agent.unref();
        while (!existsSync(${JSON.stringify(ready)})) await Bun.sleep(10);
        if (await agent.exited !== 0) throw new Error('fake agent did not exit successfully');
        ${outcome === 'fail' ? "throw new Error('intentional fixture failure');" :
          outcome === 'timeout' ? 'await new Promise(() => {});' :
          outcome === 'exit' ? 'process.exit(23);' : ''}
      }, ${outcome === 'timeout' ? 1500 : 10_000});
    `);
    let child: Bun.Subprocess | undefined;
    try {
      child = Bun.spawn([process.execPath, 'test', '--preload', join(root, 'scripts/test-preload.ts'), fixture], {
        cwd: dir, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
      });
      const output = new Response(child.stderr as ReadableStream).text();
      const stdout = new Response(child.stdout as ReadableStream).text();
      const code = await child.exited;
      const log = await output;
      await stdout;
      expect(readFileSync(ready, 'utf8')).toContain('tick');
      if (outcome === 'pass') expect(code).toBe(0);
      if (outcome === 'fail') { expect(code).not.toBe(0); expect(log).toContain('intentional fixture failure'); }
      if (outcome === 'timeout') { expect(code).not.toBe(0); expect(log).toContain('timed out'); }
      if (outcome === 'exit') expect(code).toBe(23);
      expect(marked(marker).map(row => row.command)).toEqual([]);
    } finally {
      // Even the red regression must not leave its deliberately orphaned loop behind.
      child?.kill('SIGKILL');
      if (child) await child.exited;
      for (const row of marked(marker)) {
        try { process.kill(-row.pgid, 'SIGKILL'); } catch {}
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
}
