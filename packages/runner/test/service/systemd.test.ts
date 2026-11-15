import { afterEach, describe, expect, mock, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { CONNECTIVITY_VARS, RunnerConfigSchema, saveRunnerConfig } from '../../src/config';
import { runnerPaths } from '../../src/paths';
import { acquireRunnerLock, readLockOwner } from '../../src/service/lock';
import { restartRunner, stopRunner } from '../../src/service/stop';
import {
  installSystemdService,
  removeSystemdService,
  renderUnit,
  SYSTEMD_UNIT,
  systemdServiceDisabled,
  unitPath,
} from '../../src/service/systemd';
import type { Exec } from '../../src/service/system';
import { waitFor } from '../fixture';
import { afterThisTest, cleanupRunnerSetups, tempDir } from '../runner-setup';
import { recordingExec, setupTestService, startTestService } from '../service-helpers';

afterEach(cleanupRunnerSetups);

const PROXY = 'http://proxy.test:3128';
const unit = (...args: string[]) => ['systemctl', '--user', ...args];

function setup() {
  const home = tempDir('agf-systemd-');
  const paths = runnerPaths(join(home, '.agflow'));
  const config = RunnerConfigSchema.parse({
    runnerKey: 'rk_systemd',
    machineId: 'MACHINE-1',
    name: 'cloud',
    capturedPath: '/captured/bin:/usr/bin',
    connectivity: Object.fromEntries(CONNECTIVITY_VARS.map((key) => [key, PROXY])),
  });
  saveRunnerConfig(paths.config, config);
  const exec = recordingExec();
  const installPins = mock(async () => ({ claude: '/fake/claude', codex: '/fake/codex' }));
  return {
    home,
    paths,
    config,
    exec,
    installPins,
    options: { paths, home, exec, installPins, user: 'agflow', agflow: { command: '/opt/agflow', args: [] }, env: {} },
  };
}

/** An installed unit file under a scratch home. */
function installedUnit(): string {
  const home = tempDir('agf-home-');
  mkdirSync(dirname(unitPath(home)), { recursive: true });
  writeFileSync(unitPath(home), 'installed');
  return home;
}

/** Records each command, checking first that the runner has released its lock. */
function afterUnlock(paths: ReturnType<typeof runnerPaths>, only?: string) {
  const recorded = recordingExec();
  const run: Exec = async (argv, options) => {
    if (only === undefined || argv.includes(only)) expect(readLockOwner(paths)).toBeNull();
    return recorded(argv, options);
  };
  return { run, calls: () => recorded.calls.map((call) => call.argv) };
}

describe('the systemd unit', () => {
  test("lies in the user's systemd directory under one name", () => {
    expect(SYSTEMD_UNIT).toBe('agflow-runner.service');
    expect(unitPath('/home/owner')).toBe('/home/owner/.config/systemd/user/agflow-runner.service');
    expect(unitPath()).toBe(join(homedir(), '.config/systemd/user/agflow-runner.service'));
  });

  test('runs the service, restarts it after a crash only, outlives an out-of-memory kill, quotes for systemd', () => {
    const text = renderUnit({
      execStart: ['/opt/agflow', 'runner', 'start', '--service'],
      environment: { Z: '100%', A: 'first', QUOTED: 'a "b" \\c', HOME_VAR: '$HOME' },
      stdout: '/h/logs/launchd.out.log',
      stderr: '/h/logs/launchd.err.log',
    });
    expect(text).toBe(
      [
        '[Unit]',
        'Description=agflow runner',
        '',
        '[Service]',
        'ExecStart=/opt/agflow runner start --service',
        'Environment=A=first',
        'Environment="HOME_VAR=$HOME"',
        'Environment="QUOTED=a \\"b\\" \\\\c"',
        'Environment=Z=100%%',
        'Restart=on-failure',
        'RestartSec=30',
        'KillMode=mixed',
        'TimeoutStopSec=60',
        'OOMPolicy=continue',
        'LimitNOFILE=65536',
        'StandardOutput=append:/h/logs/launchd.out.log',
        'StandardError=append:/h/logs/launchd.err.log',
        '',
        '[Install]',
        'WantedBy=default.target',
        '',
      ].join('\n'),
    );
    const words = renderUnit({
      execStart: ['/opt/my agflow/bin/agflow', '50%', '$HOME', 'say "hi"'],
      environment: {},
      stdout: '/h/100%/out',
      stderr: '/h/err',
    });
    expect(words).toContain('ExecStart="/opt/my agflow/bin/agflow" 50%% "$$HOME" "say \\"hi\\""\n');
    expect(words).toContain('StandardOutput=append:/h/100%%/out\n');
    const broken: { execStart: string[]; environment: Record<string, string> }[] = [
      { execStart: ['/opt/agflow', 'two\nlines'], environment: {} },
      { execStart: ['/opt/agflow'], environment: { A: 'line\nbreak' } },
    ];
    for (const input of broken) {
      expect(() => renderUnit({ ...input, stdout: '/h/out', stderr: '/h/err' })).toThrow('a unit file cannot hold');
    }
  });
});

describe('installSystemdService', () => {
  test('installs the pins first, writes the unit, turns on lingering, then reloads, stops, enables and starts', async () => {
    const s = setup();
    const path = unitPath(s.home);
    const installPins = mock(async () => {
      expect(existsSync(path)).toBe(false);
      expect(s.exec.calls).toHaveLength(0);
      return { claude: '/fake/claude', codex: '/fake/codex' };
    });
    const result = await installSystemdService({ ...s.options, installPins });
    expect(result).toEqual({ unitPath: path, target: SYSTEMD_UNIT, warnings: [] });
    expect(installPins).toHaveBeenCalledTimes(1);
    expect(s.exec.calls.map((call) => call.argv)).toEqual([
      ['loginctl', 'enable-linger', 'agflow'],
      unit('daemon-reload'),
      unit('stop', SYSTEMD_UNIT),
      unit('enable', SYSTEMD_UNIT),
      unit('start', SYSTEMD_UNIT),
    ]);
    // The stop waits out the old runner's suspend within the unit's TimeoutStopSec.
    expect(s.exec.calls.map((call) => call.options?.timeoutMs)).toEqual([30_000, 30_000, 75_000, 30_000, 30_000]);
    expect(statSync(path).mode & 0o777).toBe(0o644);
    expect(statSync(s.paths.logs).mode & 0o777).toBe(0o700);
    expect(readdirSync(dirname(path))).toEqual([SYSTEMD_UNIT]);
    const text = readFileSync(path, 'utf8');
    expect(text).toContain('ExecStart=/opt/agflow runner start --service\n');
    expect(text).toContain('Environment=PATH=/captured/bin:/usr/bin\n');
    expect(text).toContain('Environment=NODE_USE_SYSTEM_CA=1\n');
    for (const key of CONNECTIVITY_VARS) expect(text).toContain(`Environment=${key}=${PROXY}\n`);
    expect(text).toContain(`StandardOutput=append:${s.paths.logs}/launchd.out.log\n`);
    expect(text).toContain(`StandardError=append:${s.paths.logs}/launchd.err.log\n`);
    expect(text).not.toContain('AGFLOW_HOME');
    expect(text).not.toContain('AGFLOW_CONFIG_DIR');
  });

  test('AGFLOW_HOME, AGFLOW_CONFIG_DIR and a source command follow the unit, and nothing else of the shell', async () => {
    const s = setup();
    const main = resolve(import.meta.dir, '../../../cli/src/main.ts');
    const result = await installSystemdService({
      ...s.options,
      agflow: { command: process.execPath, args: ['--no-env-file', '--config=/dev/null', main] },
      env: { AGFLOW_HOME: s.paths.home, AGFLOW_CONFIG_DIR: 'scratch-config', SECRET: 'do-not-copy', PATH: '/wrong' },
    });
    const text = readFileSync(result.unitPath, 'utf8');
    expect(text).toContain(
      `ExecStart=${process.execPath} --no-env-file --config=/dev/null ${main} runner start --service\n`,
    );
    expect(text).toContain(`Environment=AGFLOW_HOME=${s.paths.home}\n`);
    expect(text).toContain(`Environment=AGFLOW_CONFIG_DIR=${resolve('scratch-config')}\n`);
    expect(text).not.toContain('SECRET');
    expect(text).not.toContain('/wrong');
  });

  test('a failed enable-linger is a warning that names the fix; the unit still starts', async () => {
    const s = setup();
    const exec = recordingExec([
      { argv: ['loginctl', 'enable-linger', 'agflow'], result: { exitCode: 1, stderr: 'Access denied' } },
    ]);
    const log = mock(() => {});
    const result = await installSystemdService({ ...s.options, exec, log });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('Access denied');
    expect(result.warnings[0]).toContain('sudo loginctl enable-linger agflow');
    expect(log).toHaveBeenCalledWith(result.warnings[0]);
    expect(exec.calls.at(-1)?.argv).toEqual(unit('start', SYSTEMD_UNIT));
  });

  test('a failing systemctl names its command and stops the install there', async () => {
    const s = setup();
    const exec = recordingExec([
      { argv: unit('enable', SYSTEMD_UNIT), result: { exitCode: 1, stderr: 'Failed to connect to bus' } },
    ]);
    await expect(installSystemdService({ ...s.options, exec })).rejects.toThrow(
      'systemctl --user enable failed: Failed to connect to bus',
    );
    expect(exec.calls.some((call) => call.argv.includes('start'))).toBe(false);
  });

  const refusals: [string, Partial<Parameters<typeof installSystemdService>[0]>][] = [
    ['test mode', { env: { AGFLOW_TEST: '1' } }],
    ['absolute', { agflow: { command: 'agflow', args: [] } }],
    ['absolute', { agflow: { command: '/opt/bun', args: ['main.ts'] } }],
  ];
  test.each(refusals)('refuses %s before any side effect', async (message, overrides) => {
    const s = setup();
    await expect(installSystemdService({ ...s.options, ...overrides })).rejects.toThrow(message);
    expect(s.installPins).not.toHaveBeenCalled();
    expect(s.exec.calls).toEqual([]);
    expect(existsSync(unitPath(s.home))).toBe(false);
  });

  test('waits for the old service to release its lock after the stop and before enable', async () => {
    const s = setup();
    const lock = await acquireRunnerLock(s.paths, { mode: 'service' });
    afterThisTest(() => lock.release());
    const installing = installSystemdService({ ...s.options, lockPollMs: 5, lockWaitMs: 5_000 });
    await waitFor(() => s.exec.calls.some((call) => call.argv.includes('stop')));
    await Bun.sleep(25);
    expect(s.exec.calls.at(-1)?.argv).toEqual(unit('stop', SYSTEMD_UNIT));
    lock.release();
    await installing;
    expect(s.exec.calls.slice(-2).map((call) => call.argv)).toEqual([
      unit('enable', SYSTEMD_UNIT),
      unit('start', SYSTEMD_UNIT),
    ]);
  });

  test('leaves a foreground runner alone and explains that the service waits for it', async () => {
    const s = setup();
    const lock = await acquireRunnerLock(s.paths, { mode: 'foreground' });
    afterThisTest(() => lock.release());
    const result = await installSystemdService({ ...s.options, lockWaitMs: 0 });
    expect(lock.held).toBe(true);
    expect(result.warnings.join(' ')).toContain(`pid ${process.pid}`);
    expect(result.warnings.join(' ')).toContain('service waits');
    expect(s.exec.calls.at(-1)?.argv).toEqual(unit('start', SYSTEMD_UNIT));
  });
});

describe('stop, restart and uninstall on Linux', () => {
  test('stop disables and stops an installed unit, and touches nothing without one', async () => {
    const s = await setupTestService();
    const exec = recordingExec();
    const options = { env: {}, platform: 'linux' as const, paths: s.paths, exec };
    expect(await stopRunner({ ...options, home: tempDir('agf-home-') })).toEqual({
      wasRunning: false,
      bootedOut: false,
      disabled: false,
    });
    expect(exec.calls).toEqual([]);
    expect(await stopRunner({ ...options, home: installedUnit() })).toEqual({
      wasRunning: false,
      bootedOut: true,
      disabled: true,
    });
    expect(exec.calls.map((call) => call.argv)).toEqual([unit('disable', '--now', SYSTEMD_UNIT)]);
  });

  test('stop ends a running runner first, then disables the unit once the lock is free', async () => {
    const s = await startTestService();
    await waitFor(() => s.service.runner?.status().link === 'online');
    const systemd = afterUnlock(s.paths);
    const result = await stopRunner({
      env: {},
      platform: 'linux',
      paths: s.paths,
      home: installedUnit(),
      pollMs: 5,
      exec: systemd.run,
    });
    expect(result).toEqual({ wasRunning: true, bootedOut: true, disabled: true });
    expect(await s.service.exited).toMatchObject({ code: 0, clean: true, reason: 'runner stop requested' });
    expect(systemd.calls()).toEqual([unit('disable', '--now', SYSTEMD_UNIT)]);
  });

  test('a failed disable is an error, not a stopped service', async () => {
    const s = await setupTestService();
    const exec = recordingExec([
      { argv: unit('disable', '--now', SYSTEMD_UNIT), result: { exitCode: 1, stderr: 'Failed to connect to bus' } },
    ]);
    await expect(
      stopRunner({ env: {}, platform: 'linux', paths: s.paths, exec, home: installedUnit() }),
    ).rejects.toThrow('systemctl --user disable --now failed: Failed to connect to bus');
  });

  test('restart suspends the runner and restarts an enabled unit only after the lock is free', async () => {
    const s = await startTestService();
    await waitFor(() => s.service.runner?.status().link === 'online');
    const systemd = afterUnlock(s.paths, 'restart');
    const log: string[] = [];
    await restartRunner({
      env: {},
      platform: 'linux',
      paths: s.paths,
      pollMs: 5,
      exec: systemd.run,
      log: (line) => log.push(line),
    });
    expect(systemd.calls()).toEqual([unit('is-enabled', '--quiet', SYSTEMD_UNIT), unit('restart', SYSTEMD_UNIT)]);
    expect(log).toContain('starting the runner under systemd');
    expect(await s.service.exited).toMatchObject({ reason: 'suspend requested' });
  });

  test('restart without an enabled unit leaves a running runner alone and explains install and start', async () => {
    const s = await startTestService();
    const exec = recordingExec([{ argv: unit('is-enabled', '--quiet', SYSTEMD_UNIT), result: { exitCode: 1 } }]);
    const options = { env: {}, platform: 'linux' as const, paths: s.paths, exec };
    await expect(restartRunner(options)).rejects.toThrow('agflow runner install installs and starts the systemd unit');
    await expect(restartRunner(options)).rejects.toThrow('agflow runner start');
    expect(readLockOwner(s.paths)).not.toBeNull();
  });

  test('uninstall disables and removes the unit, then reloads; with no unit it only reloads', async () => {
    const home = installedUnit();
    const exec = recordingExec();
    expect(await removeSystemdService({ exec, home })).toBe(unitPath(home));
    expect(existsSync(unitPath(home))).toBe(false);
    expect(await removeSystemdService({ exec, home })).toBe(unitPath(home));
    expect(exec.calls.map((call) => call.argv)).toEqual([
      unit('disable', '--now', SYSTEMD_UNIT),
      unit('daemon-reload'),
      unit('daemon-reload'),
    ]);
  });

  test("status reads systemd's enabled state, and anything else is unknown", async () => {
    const state = (stdout: string, exitCode = 0) =>
      systemdServiceDisabled({ exec: recordingExec([], { stdout, exitCode }) });
    expect(await state('enabled\n')).toBe(false);
    expect(await state('disabled\n', 1)).toBe(true);
    expect(await state('', 1)).toBeNull();
    const broken: Exec = async () => {
      throw new Error('no systemctl');
    };
    expect(await systemdServiceDisabled({ exec: broken })).toBeNull();
  });
});
