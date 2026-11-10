import { afterEach, beforeEach, describe, expect, mock, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { getAttempt } from '@agflow/hub/src/attempt-store';
import { findRunnerByKey, getRunner } from '@agflow/hub/src/runners';
import { createTasks } from '@agflow/hub/src/tasks';
import { newTask } from '@agflow/hub/test/helpers';
import { AttemptStore } from '@agflow/runner/src/attempt-store';
import { loadRunnerConfig, RunnerConfigSchema, saveRunnerConfig } from '@agflow/runner/src/config';
import { openRunnerDb } from '@agflow/runner/src/db';
import { Outbox } from '@agflow/runner/src/outbox';
import { runnerPaths } from '@agflow/runner/src/paths';
import type { RunnerServiceOptions } from '@agflow/runner/src/service/host';
import {
  installRefusal,
  type installService as installRunnerService,
  plistPath,
  installService as realInstallService,
} from '@agflow/runner/src/service/launchd';
import { acquireRunnerLock, readLockOwner } from '@agflow/runner/src/service/lock';
import { readMachineId } from '@agflow/runner/src/service/machine';
import { ServiceRuns } from '@agflow/runner/src/service/runs';
import { waitFor } from '@agflow/runner/test/fixture';
import { startRunnerAttempt } from '@agflow/runner/test/hub-fixture';
import { afterThisTest, cleanupRunnerSetups, tempDir } from '@agflow/runner/test/runner-setup';
import { recordingExec, setupTestService, sleepingServiceAdapter } from '@agflow/runner/test/service-helpers';
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
    expect(RUNNER_HELP).toContain('agflow runner setup [--yes] [--relogin] [--no-service]');
    expect(RUNNER_HELP).toContain('agflow runner stop');
    expect(RUNNER_HELP).toContain('agflow runner restart');
    expect(RUNNER_HELP).toContain('agflow runner drain');
    expect(RUNNER_HELP).toContain('agflow runner undrain');
    expect(RUNNER_HELP).toContain('agflow runner install');
    expect(RUNNER_HELP).toContain('agflow runner status [--json]');
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

  test('setup rejects extra positional arguments', async () => {
    const { io, out, err } = capture();
    expect(await main(['runner', 'setup', 'extra'], io)).toBe(2);
    expect(err.join('')).toContain('usage: agflow runner setup [--yes] [--relogin] [--no-service]');
    expect(out).toEqual([]);
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
        runnerStop: async () => exit,
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

for (const running of [false, true]) {
  test(`status in injected test mode never consults launchd (running: ${running})`, async () => {
    const s = await setupTestService();
    process.env.AGFLOW_HOME = s.paths.home;
    if (running) await s.start();
    const exec = recordingExec([], { stdout: '"dev.agflow.runner" => disabled' });
    const home = tempDir('agf-home-');
    const plist = plistPath({ home });
    mkdirSync(dirname(plist), { recursive: true });
    writeFileSync(plist, 'installed');
    const { io, out } = capture();
    expect(await runnerCommand(parseArgs(['runner', 'status', '--json']), io, {
      env: { AGFLOW_TEST: '1' }, exec, home, uid: 501,
    })).toBe(running ? 0 : 1);
    const report = JSON.parse(out.join(''));
    expect(report.warnings).toEqual([]);
    if (!running) expect(report).toMatchObject({ disabled: null, plistInstalled: false });
    expect(exec.calls).toEqual([]);
  });
}

describe('agflow runner status', () => {
  test('rejects extra arguments and non-boolean --json', async () => {
    for (const argv of [
      ['runner', 'status', 'extra'],
      ['runner', 'status', '--json', 'extra'],
    ]) {
      const { io, err } = capture();
      expect(await main(argv, io)).toBe(2);
      expect(err.join('')).toContain('usage: agflow runner status [--json]');
    }
  });

  test('reports a live attempt, recorded group, kept clone and Login Items without exposing tokens', async () => {
    const adapter = sleepingServiceAdapter();
    let agentToken = '';
    const start = adapter.start.bind(adapter);
    adapter.start = async (launch) => {
      agentToken = launch.env.AGFLOW_AGENT_TOKEN!;
      return start(launch);
    };
    const s = await setupTestService({ config: { capacity: 2 }, host: { adapters: [adapter] } });
    process.env.AGFLOW_HOME = s.paths.home;
    const service = await s.start();
    await waitFor(() => service.runner?.status().link === 'online');
    const runnerId = service.runner!.status().runnerId!;
    const [task] = createTasks(s.hub.ctx, [newTask()], 'user:alice');
    const started = startRunnerAttempt(s.hub.ctx, {
      runnerId,
      taskId: task!.id,
      role: 'worker',
      vendor: 'codex',
    });
    await waitFor(() =>
      service.runner!.status().attempts.some((a) => a.attemptId === started.attempt.id && a.phase === 'turn'),
    );
    await service.runner!.changeSettings({ draining: true });
    const db = openRunnerDb(s.paths.db);
    try {
      const store = new AttemptStore(db);
      // A running attempt with a stale pushError still works in its clone; only the ended one keeps a clone.
      const stale = store.update(started.attempt.id, { pushError: 'stale push error' });
      expect(existsSync(stale.clone!)).toBe(true);
      const kept = tempDir('agf-kept-');
      const ended = store.create(
        { ...stale.spec, attemptId: `${stale.attemptId}-kept` },
        { clone: kept, tmpDir: null, cliVersion: null },
      );
      store.update(ended.attemptId, { state: 'ended', endedAt: Date.now(), pushError: 'final push refused' });
      const group = store.processes(started.attempt.id)[0]!;
      const exec = recordingExec([
        {
          argv: ['launchctl', 'print-disabled', 'gui/501'],
          result: { stdout: 'disabled services = {\n  "dev.agflow.runner" => disabled\n}' },
        },
      ]);
      const deps = { env: {}, exec, uid: 501, home: tempDir('agf-home-') };
      const human = capture();
      expect(await runnerCommand(parseArgs(['runner', 'status']), human.io, deps)).toBe(0);
      const text = human.out.join('');
      expect(text).toMatch(/^State\s+ok$/m);
      expect(text).toMatch(/^Draining\s+true$/m);
      expect(text).toMatch(/^Capacity\s+2, free slots: 1$/m);
      expect(text).toContain(`Kept clone     ${ended.attemptId} ${kept}: final push refused`);
      expect(text).not.toContain('stale push error');
      for (const value of [runnerId, started.attempt.id, task!.id, 'worker', 'codex', 'turn', 'Login Items']) {
        expect(text).toContain(value);
      }
      const json = capture();
      expect(await runnerCommand(parseArgs(['runner', 'status', '--json']), json.io, deps)).toBe(0);
      const report = JSON.parse(json.out.join(''));
      expect(report).toMatchObject({ running: true, runnerId, state: 'ok', capacity: 2, freeSlots: 1, draining: true });
      expect(report.keptClones).toEqual([{ attemptId: ended.attemptId, clone: kept, error: 'final push refused' }]);
      expect(report.warnings).toHaveLength(1);
      expect(agentToken).toStartWith('agt_');
      expect(json.out.join('')).not.toContain(agentToken);
      expect(json.out.join('')).not.toContain(s.hub.token);
      expect(json.out.join('')).not.toContain('agt_');
      expect(json.out.join('')).not.toContain('agentToken');
      expect(human.err).toEqual([]);
      expect(json.err).toEqual([]);
      store.update(started.attempt.id, { pushError: null });
      expect(group).toBeDefined();
      expect(report.attempts[0]).toMatchObject({
        attemptId: started.attempt.id,
        pid: group.pid,
        pgid: group.pgid,
        lstart: group.lstart,
        ageMs: expect.any(Number),
      });
    } finally {
      db.close();
    }
  });

  test('without a socket prints best effort, installation, exit time and 20 log lines and exits 1', async () => {
    const s = await setupTestService();
    process.env.AGFLOW_HOME = s.paths.home;
    const home = tempDir('agf-home-');
    const plist = plistPath({ home });
    mkdirSync(dirname(plist), { recursive: true });
    writeFileSync(plist, 'installed');
    const at = 1_700_000_000_000;
    const runs = new ServiceRuns(s.paths, { now: () => at });
    const id = runs.start({ pid: 42, mode: 'service' });
    runs.finish(id, { code: 0, clean: true, reason: 'incompatible protocol' });
    writeFileSync(s.paths.runnerLog, Array.from({ length: 30 }, (_, i) => `log-line-${i}\n`).join(''));
    const exec = recordingExec([
      { argv: ['launchctl', 'print-disabled', 'gui/501'], result: { stdout: '"dev.agflow.runner" => true' } },
    ]);
    for (const flags of [[], ['--json']]) {
      const { io, out, err } = capture();
      expect(await runnerCommand(parseArgs(['runner', 'status', ...flags]), io, { env: {}, exec, uid: 501, home })).toBe(1);
      const text = out.join('');
      expect(text).toContain('incompatible protocol');
      expect(text).toContain('Login Items');
      expect(text).toContain('log-line-10');
      expect(text).toContain('log-line-29');
      expect(text).not.toContain('log-line-9');
      if (flags.length) {
        expect(JSON.parse(text)).toMatchObject({
          running: false,
          bestEffort: true,
          plistInstalled: true,
          disabled: true,
          lastExit: { at, reason: 'incompatible protocol' },
          warnings: [expect.any(String)],
        });
        expect(JSON.parse(text).logLines).toHaveLength(20);
      } else {
        expect(text).toContain('best effort');
        expect(text).toContain('installed');
        expect(text).toContain(new Date(at).toISOString());
      }
      expect(err).toEqual([]);
    }
    expect(exec.calls).toHaveLength(2);
  });
});

for (const command of ['stop', 'restart']) {
  test(`${command} rejects extra positional arguments`, async () => {
    const { io, out, err } = capture();
    expect(await main(['runner', command, 'extra'], io)).toBe(2);
    expect(err.join('')).toContain(`usage: agflow runner ${command}`);
    expect(out).toEqual([]);
  });
}

test('runner stop reaches the service and boots out and disables its LaunchAgent', async () => {
  const s = await setupTestService();
  process.env.AGFLOW_HOME = s.paths.home;
  const service = await s.start();
  await waitFor(() => service.runner?.status().link === 'online');
  const exec = recordingExec();
  const { io, out, err } = capture();
  expect(await runnerCommand(parseArgs(['runner', 'stop']), io, { env: {}, exec, uid: 501, home: tempDir('agf-home-') })).toBe(
    0,
  );
  expect(await service.exited).toMatchObject({ code: 0, clean: true });
  expect(out.join('')).toContain('the runner stopped');
  expect(out.join('')).toContain('booted out and disabled');
  expect(out.join('')).toContain('agflow runner install');
  expect(out.join('')).toContain('agflow runner start');
  expect(err.join('')).toContain('stopping the runner');
  expect(err.join('')).toContain('the runner exited: runner stop requested');
  expect(exec.calls.map((call) => call.argv)).toEqual([
    ['launchctl', 'print', 'gui/501/dev.agflow.runner'],
    ['launchctl', 'bootout', 'gui/501/dev.agflow.runner'],
    ['launchctl', 'disable', 'gui/501/dev.agflow.runner'],
  ]);
});

test('runner restart prints its result and kickstarts a loaded service with no live runner', async () => {
  const exec = recordingExec();
  const { io, out } = capture();
  expect(await runnerCommand(parseArgs(['runner', 'restart']), io, { env: {}, exec, uid: 501 })).toBe(0);
  expect(out).toEqual(['the runner restarted under launchd\n']);
  expect(exec.calls.map((call) => call.argv)).toEqual([
    ['launchctl', 'print', 'gui/501/dev.agflow.runner'],
    ['launchctl', 'kickstart', '-k', 'gui/501/dev.agflow.runner'],
  ]);
});

test('runner stop without a runner or loaded job explains how to bring it back', async () => {
  const exec = recordingExec([], { exitCode: 1 });
  const { io, out } = capture();
  expect(await runnerCommand(parseArgs(['runner', 'stop']), io, { env: {}, exec, uid: 501, home: tempDir('agf-home-') })).toBe(
    0,
  );
  expect(out.join('')).toContain('no runner was running; no LaunchAgent was loaded');
  expect(out.join('')).toContain('agflow runner install or agflow runner start');
  expect(exec.calls).toHaveLength(1);
});

test('runner stop disables an installed LaunchAgent that is not loaded', async () => {
  const home = tempDir('agf-home-');
  mkdirSync(dirname(plistPath({ home })), { recursive: true });
  writeFileSync(plistPath({ home }), 'installed');
  const exec = recordingExec([{ argv: ['launchctl', 'print', 'gui/501/dev.agflow.runner'], result: { exitCode: 1 } }]);
  const { io, out } = capture();
  expect(await runnerCommand(parseArgs(['runner', 'stop']), io, { env: {}, exec, uid: 501, home })).toBe(0);
  expect(out.join('')).toContain('no runner was running; the installed LaunchAgent was not loaded and is now disabled');
  expect(exec.calls.map((call) => call.argv[1])).toEqual(['print', 'disable']);
});

test('runner stop reports an unreachable lock holder without touching launchd', async () => {
  const s = await setupTestService();
  process.env.AGFLOW_HOME = s.paths.home;
  const lock = await acquireRunnerLock(s.paths, { mode: 'foreground' });
  afterThisTest(() => lock.release());
  const exec = recordingExec();
  const { io, out } = capture();
  await expect(
    runnerCommand(parseArgs(['runner', 'stop']), io, { env: {}, exec, uid: 501, home: tempDir('agf-home-') }),
  ).rejects.toThrow(`runner.lock is held by pid ${process.pid}`);
  expect(out).toEqual([]);
  expect(exec.calls).toEqual([]);
});

test('stop and restart pass the injected test environment through to operations', async () => {
  const exec = recordingExec();
  const deps = { exec, env: { AGFLOW_TEST: '1' }, home: tempDir('agf-home-'), uid: 501 };
  const { io } = capture();
  expect(await runnerCommand(parseArgs(['runner', 'stop']), io, deps)).toBe(0);
  await expect(runnerCommand(parseArgs(['runner', 'restart']), io, deps)).rejects.toThrow('no runner service is loaded');
  expect(exec.calls).toEqual([]);
});
