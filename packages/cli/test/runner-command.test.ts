import { afterEach, beforeEach, describe, expect, mock, setDefaultTimeout, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { getAttempt } from '@agflow/hub/src/attempt-store';
import { findRunnerByKey, getRunner } from '@agflow/hub/src/runners';
import { createTasks } from '@agflow/hub/src/tasks';
import { newTask } from '@agflow/hub/test/helpers';
import { loadRunnerConfig, RunnerConfigSchema, saveRunnerConfig } from '@agflow/runner/src/config';
import { openRunnerDb } from '@agflow/runner/src/db';
import { Outbox } from '@agflow/runner/src/outbox';
import { runnerPaths } from '@agflow/runner/src/paths';
import type { RunnerServiceOptions } from '@agflow/runner/src/service/host';
import {
  installRefusal,
  type installService as installRunnerService,
  installService as realInstallService,
} from '@agflow/runner/src/service/launchd';
import { acquireRunnerLock, readLockOwner } from '@agflow/runner/src/service/lock';
import { readMachineId } from '@agflow/runner/src/service/machine';
import { ServiceRuns } from '@agflow/runner/src/service/runs';
import { waitFor } from '@agflow/runner/test/fixture';
import { startRunnerAttempt } from '@agflow/runner/test/hub-fixture';
import { afterThisTest, cleanupRunnerSetups, tempDir } from '@agflow/runner/test/runner-setup';
import { recordingExec, setupTestService } from '@agflow/runner/test/service-helpers';
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
setDefaultTimeout(60_000);

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
    expect(RUNNER_HELP).toContain('agflow runner drain');
    expect(RUNNER_HELP).toContain('agflow runner undrain');
    expect(RUNNER_HELP).toContain('agflow runner install');
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

  test('install rejects extra positional arguments', async () => {
    const { io, out, err } = capture();
    expect(await main(['runner', 'install', 'extra'], io)).toBe(2);
    expect(err.join('')).toContain('usage: agflow runner install');
    expect(out).toEqual([]);
  });

  test('install passes runner paths, the absolute source command and environment, and prints its result', async () => {
    const { io, out, err } = capture();
    const result = { plistPath: '/scratch/agent.plist', target: 'gui/501/dev.agflow.runner', warnings: ['warning'] };
    const installService = mock(async (options: Parameters<typeof installRunnerService>[0]) => {
      expect(options.paths.home).toBe(process.env.AGFLOW_HOME!);
      expect(options.agflow).toEqual(selfCommand());
      expect(isAbsolute(options.agflow.command)).toBe(true);
      // The source form may put Bun options before main.ts; the installer checks its own paths.
      expect(options.agflow.args.at(-1)).toBe(MAIN);
      expect(options.env).toBe(process.env);
      options.log?.('pins ready');
      options.log?.('warning');
      return result;
    });
    expect(await runnerCommand(parseArgs(['runner', 'install']), io, { installService })).toBe(0);
    expect(installService).toHaveBeenCalledTimes(1);
    expect(err).toEqual(['pins ready\n', 'warning\n']);
    expect(out).toEqual(['installed /scratch/agent.plist; the runner starts as gui/501/dev.agflow.runner\n']);
  });

  test('install reports failures on stderr and exits 1', async () => {
    const { io, out, err } = capture();
    const installService = async () => {
      throw new Error('bootstrap failed');
    };
    expect(await runnerCommand(parseArgs(['runner', 'install']), io, { installService })).toBe(1);
    expect(out).toEqual([]);
    expect(err).toEqual(['agflow: bootstrap failed\n']);
  });

  test('install refuses test mode through the real installer before touching launchd', async () => {
    const paths = runnerPaths();
    saveRunnerConfig(
      paths.config,
      RunnerConfigSchema.parse({
        runnerKey: 'rk_install',
        machineId: 'MACHINE-1',
        name: 'laptop',
        test: {},
      }),
    );
    const message = installRefusal(loadRunnerConfig(paths.config));
    // The real installer, with launchd, the LaunchAgents folder and the pins kept to scratch should it ever pass.
    const exec = recordingExec();
    const installPins = mock(async () => ({ claude: '/fake/claude', codex: '/fake/codex' }));
    const home = tempDir('agf-home-');
    const installService = (options: Parameters<typeof installRunnerService>[0]) =>
      realInstallService({ ...options, exec, home, uid: 501, installPins });
    const { io, out, err } = capture();
    expect(await runnerCommand(parseArgs(['runner', 'install']), io, { installService })).toBe(1);
    expect(out).toEqual([]);
    expect(err).toEqual([`agflow: ${message}\n`]);
    expect(exec.calls).toEqual([]);
    expect(installPins).not.toHaveBeenCalled();
    expect(existsSync(join(home, 'Library'))).toBe(false);
  });

  test('drain and undrain reach the running service and print one line each', async () => {
    const s = await setupTestService();
    process.env.AGFLOW_HOME = s.paths.home;
    const service = await s.start();
    await waitFor(() => service.runner?.status().link === 'online');
    const id = service.runner!.status().runnerId!;
    for (const command of ['drain', 'undrain']) {
      const { io, out, err } = capture();
      expect(await runnerCommand(parseArgs(['runner', command]), io)).toBe(0);
      expect(loadRunnerConfig(s.paths.config).draining).toBe(command === 'drain');
      await waitFor(() => getRunner(s.hub.ctx, id).draining === (command === 'drain'));
      expect(out).toEqual([command === 'drain' ? 'the runner is draining\n' : 'the runner is undrained\n']);
      expect(err).toEqual([]);
    }
  });

  for (const command of ['drain', 'undrain']) {
    test(`${command} while stopped prints where it saved the edit`, async () => {
      const s = await setupTestService({ config: { draining: command === 'undrain' } });
      process.env.AGFLOW_HOME = s.paths.home;
      const { io, out, err } = capture();
      expect(await runnerCommand(parseArgs(['runner', command]), io)).toBe(0);
      expect(loadRunnerConfig(s.paths.config).draining).toBe(command === 'drain');
      expect(out).toEqual([`${command}ed in runner.json; the hub hears it after the next start\n`]);
      expect(err).toEqual([]);
      expect(readLockOwner(s.paths)).toBeNull();
    });

    test(`${command} rejects extra positional arguments`, async () => {
      const { io, out, err } = capture();
      expect(await main(['runner', command, 'extra'], io)).toBe(2);
      expect(err.join('')).toContain(`usage: agflow runner ${command}`);
      expect(out).toEqual([]);
    });

    test(`${command} reports an unreachable lock holder and exits 1`, async () => {
      const s = await setupTestService();
      process.env.AGFLOW_HOME = s.paths.home;
      const lock = await acquireRunnerLock(s.paths, { mode: 'foreground' });
      afterThisTest(() => lock.release());
      const { io, out, err } = capture();
      expect(await main(['runner', command], io)).toBe(1);
      expect(out).toEqual([]);
      expect(err.join('')).toStartWith(`agflow: runner.lock is held by pid ${process.pid}`);
      expect(err.join('')).toContain('agflow runner status');
    });
  }

  for (const mode of ['foreground', 'service'] as const) {
    test(`start passes CLI paths, terminal and signals in ${mode} and returns the host exit code`, async () => {
      const { io, out, err } = capture();
      const exit = { code: 3, clean: true, reason: 'x' };
      const startRunnerService = mock(async (options: RunnerServiceOptions) => ({
        paths: runnerPaths(),
        mode: options.mode,
        runner: null,
        needsLogin: null,
        exited: Promise.resolve(exit),
        suspend: async () => exit,
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
    // The real host reads this Mac's free space for its disk guard; test mode keeps its notifier silent.
    const s = await setupTestService({ config: { machineId: await readMachineId(), minFreeGb: 0 } });
    const child = Bun.spawn([process.execPath, MAIN, 'runner', 'start'], {
      env: { ...process.env, AGFLOW_HOME: s.paths.home, AGFLOW_CONFIG_DIR: s.configDir, AGFLOW_TEST: '1' },
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

  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    for (const mode of ['foreground', 'service'] as const) {
      // Only a foreground runner has a terminal to close.
      if (signal === 'SIGHUP' && mode === 'service') continue;
      test(`start suspends a running attempt on ${signal} in ${mode} and exits 0 with a clean run`, async () => {
        const s = await setupTestService();
        const flags = mode === 'service' ? ['--service'] : [];
        const child = Bun.spawn([process.execPath, join(import.meta.dir, 'run-runner-start.ts'), ...flags], {
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
        const row = await waitFor(() => {
          if (child.exitCode !== null) throw new Error(`runner exited before hello (code ${child.exitCode})`);
          const row = findRunnerByKey(s.hub.ctx, s.config.runnerKey);
          return row?.state === 'online' ? row : null;
        });
        const [task] = createTasks(s.hub.ctx, [newTask()], 'user:alice');
        const { attempt } = startRunnerAttempt(s.hub.ctx, {
          runnerId: row.id,
          taskId: task!.id,
          role: 'worker',
          vendor: 'codex',
        });
        await waitFor(() => getAttempt(s.hub.ctx, attempt.id).status === 'running');
        child.kill(signal);
        expect(await child.exited).toBe(0);
        const db = openRunnerDb(s.paths.db);
        const exits = (() => {
          try {
            return new Outbox(db).eventsAfter(0).filter((event) => event.type === 'attempt.exited');
          } finally {
            db.close();
          }
        })();
        expect(exits).toEqual([
          expect.objectContaining({
            attemptId: attempt.id,
            data: expect.objectContaining({ cause: 'suspend', handoffWritten: false }),
          }),
        ]);
        expect(new ServiceRuns(s.paths).lastExit({ running: false })).toMatchObject({
          code: 0,
          clean: true,
          reason: `received ${signal}`,
        });
        expect(readLockOwner(s.paths)).toBeNull();
        expect(existsSync(s.paths.socket)).toBe(false);
        const log = readFileSync(s.paths.runnerLog, 'utf8');
        expect(log.indexOf('runner suspend finished')).toBeLessThan(log.indexOf(`info received ${signal}`));
        expect(await stdout).toBe('');
        await stderr;
      }, 60_000);
    }
  }
});
