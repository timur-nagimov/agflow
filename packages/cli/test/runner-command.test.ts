import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findRunnerByKey } from '@agflow/hub/src/runners';
import { runnerPaths } from '@agflow/runner/src/paths';
import type { RunnerServiceOptions } from '@agflow/runner/src/service/host';
import { readLockOwner } from '@agflow/runner/src/service/lock';
import { readMachineId } from '@agflow/runner/src/service/machine';
import { ServiceRuns } from '@agflow/runner/src/service/runs';
import { waitFor } from '@agflow/runner/test/fixture';
import { afterThisTest, cleanupRunnerSetups, tempDir } from '@agflow/runner/test/runner-setup';
import { setupTestService } from '@agflow/runner/test/service-helpers';
import { parseArgs } from '../src/args';
import { main } from '../src/main';
import { configDir } from '../src/paths';
import { RUNNER_HELP, runnerCommand } from '../src/runner-command';
import { selfCommand } from '../src/self';

const MAIN = join(import.meta.dir, '..', 'src', 'main.ts');

beforeEach(() => {
  for (const name of ['AGFLOW_HOME', 'AGFLOW_CONFIG_DIR']) {
    const previous = process.env[name];
    process.env[name] = tempDir('agflow-cli-');
    afterThisTest(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
  }
});
afterEach(cleanupRunnerSetups);

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (text: string) => void out.push(text), err: (text: string) => void err.push(text) }, out, err };
}

describe('agflow runner', () => {
  for (const argv of [['runner'], ['runner', 'fly'], ['runner', 'constructor']]) {
    test(`${argv.join(' ')} is a usage error listing subcommands`, async () => {
      const { io, out, err } = capture();
      expect(await main(argv, io)).toBe(2);
      expect(err.join('').split('\n')[0]).toContain('start');
      expect(err.join('')).toContain(RUNNER_HELP);
      expect(out).toEqual([]);
    });
  }

  test('help includes the runner commands', async () => {
    const { io, out, err } = capture();
    expect(await main(['help'], io)).toBe(0);
    expect(RUNNER_HELP).toContain('agflow runner start [--service]');
    expect(out.join('')).toContain(RUNNER_HELP);
    expect(err).toEqual([]);
  });

  test('the CLI loads no runner module until a runner subcommand runs', async () => {
    // Every hook call starts the CLI: only `agflow runner` may pay for the runner's module graph.
    const script = `await import(${JSON.stringify(MAIN)});
console.log(JSON.stringify(Object.keys(require.cache).filter((path) => path.includes('/packages/runner/'))));`;
    const child = Bun.spawn([process.execPath, '-e', script], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
    expect(JSON.parse(stdout)).toEqual([]);
  });

  test('start rejects extra positional arguments', async () => {
    const { io, err } = capture();
    expect(await main(['runner', 'start', 'extra'], io)).toBe(2);
    expect(err.join('')).toContain('agflow runner start');
  });

  for (const mode of ['foreground', 'service'] as const) {
    test(`start passes CLI paths, terminal and signals in ${mode} and returns the host exit code`, async () => {
      const { io, out, err } = capture();
      const exit = { code: 3, clean: true, reason: 'x' };
      const startRunnerService = mock(async (options: RunnerServiceOptions) => ({
        paths: runnerPaths(),
        mode: options.mode,
        runner: null,
        exited: Promise.resolve(exit),
        stop: async () => exit,
      }));
      const argv = ['runner', 'start', ...(mode === 'service' ? ['--service'] : [])];
      expect(await runnerCommand(parseArgs(argv), io, { startRunnerService })).toBe(3);
      expect(startRunnerService).toHaveBeenCalledTimes(1);
      expect(startRunnerService).toHaveBeenCalledWith({
        mode,
        configDir: configDir(),
        agflow: selfCommand(),
        terminal: io.err,
        signals: true,
      });
      expect(out).toEqual([]);
      expect(err).toEqual([]);
    });
  }

  test('start says hello to the hub and exits cleanly on SIGTERM', async () => {
    const s = await setupTestService({ config: { machineId: await readMachineId() } });
    const child = Bun.spawn([process.execPath, MAIN, 'runner', 'start'], {
      env: { ...process.env, AGFLOW_HOME: s.paths.home, AGFLOW_CONFIG_DIR: s.configDir },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    afterThisTest(async () => {
      if (child.exitCode === null) child.kill('SIGKILL');
      await child.exited;
    });
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    await waitFor(() => {
      if (child.exitCode !== null) throw new Error(`runner exited before hello (code ${child.exitCode})`);
      return findRunnerByKey(s.hub.ctx, s.config.runnerKey)?.state === 'online';
    });
    expect(readLockOwner(s.paths)).toMatchObject({ pid: child.pid, mode: 'foreground' });
    child.kill('SIGTERM');
    expect(await child.exited).toBe(0);
    expect(new ServiceRuns(s.paths).lastExit({ running: false })).toMatchObject({
      code: 0,
      clean: true,
      reason: 'received SIGTERM',
    });
    expect(readLockOwner(s.paths)).toBeNull();
    expect(existsSync(s.paths.socket)).toBe(false);
    expect(await stdout).toBe('');
    expect(await stderr).toContain('received SIGTERM');
    expect(readFileSync(s.paths.runnerLog, 'utf8')).toContain('received SIGTERM');
  }, 30_000);
});
