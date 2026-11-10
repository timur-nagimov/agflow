import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { CONNECTIVITY_VARS, RunnerConfigSchema, saveRunnerConfig } from '../../src/config';
import { runnerPaths } from '../../src/paths';
import {
  bootoutService,
  disableService,
  installRefusal,
  installService,
  kickstartService,
  LAUNCHD_LABEL,
  plistPath,
  programPaths,
  renderPlist,
  serviceLoaded,
  serviceTarget,
} from '../../src/service/launchd';
import { acquireRunnerLock } from '../../src/service/lock';
import { defaultExec, type Exec } from '../../src/service/system';
import { afterThisTest, cleanupRunnerSetups, tempDir } from '../runner-setup';
import { recordingExec } from '../service-helpers';

beforeEach(() => {
  const previous = process.env.AGFLOW_TEST;
  delete process.env.AGFLOW_TEST;
  afterThisTest(() => {
    if (previous === undefined) delete process.env.AGFLOW_TEST;
    else process.env.AGFLOW_TEST = previous;
  });
});
afterEach(cleanupRunnerSetups);

const special = `&<>"'`;
const escaped = '&amp;&lt;&gt;&quot;&apos;';
const input = {
  label: 'dev.agflow.runner',
  programArguments: ['/opt/agflow', 'runner', 'start', '--service'],
  environment: { Z: special, A: 'first' },
  stdout: '/tmp/logs/out',
  stderr: '/tmp/logs/err',
};

/** launchctl as installService meets it: print finds no job once bootout has run. */
function launchd(scripts: Parameters<typeof recordingExec>[0] = []) {
  const gone = ['dev.agflow.runner', 'dev.agflow.scratch'].map((label) => ({
    argv: ['launchctl', 'print', `gui/501/${label}`],
    result: { exitCode: 113, stderr: 'Could not find service' },
  }));
  return recordingExec([...scripts, ...gone]);
}

function setup() {
  const home = tempDir('agf-launchd-');
  const paths = runnerPaths(join(home, '.agflow'));
  const config = RunnerConfigSchema.parse({
    runnerKey: 'rk_launchd',
    machineId: 'MACHINE-1',
    name: 'laptop',
    capturedPath: '/captured/bin:/usr/bin',
    connectivity: Object.fromEntries(CONNECTIVITY_VARS.map((key) => [key, special])),
  });
  saveRunnerConfig(paths.config, config);
  const exec = launchd();
  const installPins = mock(async () => ({ claude: '/fake/claude', codex: '/fake/codex' }));
  return {
    home,
    paths,
    config,
    exec,
    installPins,
    options: { paths, home, uid: 501, exec, installPins, agflow: { command: '/opt/agflow', args: [] }, env: {} },
  };
}

describe('LaunchAgent plist', () => {
  test('paths and targets default to the owner and accept a scratch label and home', () => {
    expect(LAUNCHD_LABEL).toBe('dev.agflow.runner');
    expect(plistPath()).toBe(join(homedir(), 'Library/LaunchAgents/dev.agflow.runner.plist'));
    expect(plistPath({ home: '/tmp/owner', label: 'dev.agflow.scratch' })).toBe(
      '/tmp/owner/Library/LaunchAgents/dev.agflow.scratch.plist',
    );
    expect(serviceTarget()).toBe(`gui/${process.getuid!()}/dev.agflow.runner`);
    expect(serviceTarget('dev.agflow.scratch', 123)).toBe('gui/123/dev.agflow.scratch');
  });

  test('renders every required key with its plist type and escapes every string', () => {
    const xml = renderPlist(input);
    expect(xml).toStartWith('<?xml version="1.0" encoding="UTF-8"?>\n');
    expect(xml).toContain(
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ' + '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    );
    expect(xml).toContain('<plist version="1.0">\n<dict>');
    for (const [key, value] of [
      ['Label', '<string>dev.agflow.runner</string>'],
      [
        'ProgramArguments',
        '<array>\n<string>/opt/agflow</string>\n<string>runner</string>\n' +
          '<string>start</string>\n<string>--service</string>\n</array>',
      ],
      [
        'EnvironmentVariables',
        `<dict>\n<key>A</key>\n<string>first</string>\n<key>Z</key>\n` + `<string>${escaped}</string>\n</dict>`,
      ],
      ['KeepAlive', '<dict>\n<key>SuccessfulExit</key>\n<false/>\n</dict>'],
      ['ExitTimeOut', '<integer>60</integer>'],
      ['ThrottleInterval', '<integer>30</integer>'],
      ['HardResourceLimits', '<dict>\n<key>NumberOfFiles</key>\n<integer>65536</integer>\n</dict>'],
      ['ProcessType', '<string>Interactive</string>'],
      ['LimitLoadToSessionType', '<string>Aqua</string>'],
      ['StandardOutPath', '<string>/tmp/logs/out</string>'],
      ['StandardErrorPath', '<string>/tmp/logs/err</string>'],
    ]) {
      expect(xml).toContain(`<key>${key}</key>\n${value}`);
    }
    expect(xml).toEndWith('</dict>\n</plist>\n');
    const all = renderPlist({
      label: special,
      programArguments: [special],
      environment: { [special]: special },
      stdout: special,
      stderr: special,
    });
    expect(all.match(new RegExp(escaped, 'g'))).toHaveLength(6);
  });

  test.skipIf(process.platform !== 'darwin')('plutil accepts the plist and round trips its values', async () => {
    const path = join(tempDir('agf-plist-'), 'test.plist');
    writeFileSync(path, renderPlist(input));
    const lint = await defaultExec(['plutil', '-lint', path], { timeoutMs: 10_000 });
    expect(lint.exitCode).toBe(0);
    const json = await defaultExec(['plutil', '-convert', 'json', '-o', '-', path], { timeoutMs: 10_000 });
    expect(json.exitCode).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({
      EnvironmentVariables: input.environment,
      ProgramArguments: input.programArguments,
      KeepAlive: { SuccessfulExit: false },
      HardResourceLimits: { NumberOfFiles: 65536 },
    });
  });
});

describe('installService', () => {
  test('installs pins before publishing, then bootout, enable and bootstrap despite failed bootout', async () => {
    const s = setup();
    const path = plistPath({ home: s.home });
    const exec = launchd([
      { argv: ['launchctl', 'bootout', serviceTarget(undefined, 501)], result: { exitCode: 3, stderr: 'not loaded' } },
    ]);
    const installPins = mock(async (paths, options) => {
      expect(paths).toBe(s.paths);
      expect(existsSync(path)).toBe(false);
      expect(existsSync(s.paths.logs)).toBe(false);
      expect(exec.calls).toHaveLength(0);
      options.log('pins ready');
      return { claude: '/fake/claude', codex: '/fake/codex' };
    });
    const log = mock(() => {});
    const result = await installService({ ...s.options, exec, installPins, log });
    expect(result).toEqual({ plistPath: path, target: 'gui/501/dev.agflow.runner', warnings: [] });
    expect(installPins).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('pins ready');
    expect(exec.calls.map((call) => call.argv)).toEqual([
      ['launchctl', 'bootout', result.target],
      ['launchctl', 'print', result.target],
      ['launchctl', 'enable', result.target],
      ['launchctl', 'bootstrap', 'gui/501', path],
    ]);
    // bootout waits out the old service's suspend under launchd's ExitTimeOut.
    expect(exec.calls.map((call) => call.options?.timeoutMs)).toEqual([75_000, 30_000, 30_000, 30_000]);
    expect(statSync(path).mode & 0o777).toBe(0o644);
    expect(statSync(s.paths.logs).mode & 0o777).toBe(0o700);
    expect(readdirSync(join(s.home, 'Library/LaunchAgents'))).toEqual(['dev.agflow.runner.plist']);
    const xml = readFileSync(path, 'utf8');
    expect(xml).toContain(`<string>${s.paths.logs}/launchd.out.log</string>`);
    expect(xml).toContain(`<string>${s.paths.logs}/launchd.err.log</string>`);
    expect(xml).toContain('<key>PATH</key>\n<string>/captured/bin:/usr/bin</string>');
    expect(xml).toContain('<key>NODE_USE_SYSTEM_CA</key>\n<string>1</string>');
    for (const key of CONNECTIVITY_VARS) expect(xml).toContain(`<key>${key}</key>\n<string>${escaped}</string>`);
    expect(xml).not.toContain('<key>AGFLOW_HOME</key>');
    expect(xml).not.toContain('<key>AGFLOW_CONFIG_DIR</key>');
  });

  test('scratch label, homes and source program paths follow the service without leaking shell variables', async () => {
    const s = setup();
    const main = resolve(import.meta.dir, '../../../cli/src/main.ts');
    const result = await installService({
      ...s.options,
      label: 'dev.agflow.scratch',
      agflow: { command: process.execPath, args: [main] },
      env: { AGFLOW_HOME: s.paths.home, AGFLOW_CONFIG_DIR: 'scratch-config', SECRET: 'do-not-copy', PATH: '/wrong' },
    });
    expect(result.plistPath).toBe(plistPath({ home: s.home, label: 'dev.agflow.scratch' }));
    expect(result.target).toBe('gui/501/dev.agflow.scratch');
    const xml = readFileSync(result.plistPath, 'utf8');
    expect(xml).toContain('<key>Label</key>\n<string>dev.agflow.scratch</string>');
    expect(xml).toContain(
      `<string>${process.execPath}</string>\n<string>${main}</string>\n` +
        '<string>runner</string>\n<string>start</string>\n<string>--service</string>',
    );
    expect(xml).toContain(`<key>AGFLOW_HOME</key>\n<string>${s.paths.home}</string>`);
    expect(xml).toContain(`<key>AGFLOW_CONFIG_DIR</key>\n<string>${resolve('scratch-config')}</string>`);
    expect(xml).not.toContain('SECRET');
    expect(xml).not.toContain('/wrong');
    expect(s.exec.calls.map((call) => call.argv)).toEqual([
      ['launchctl', 'bootout', result.target],
      ['launchctl', 'print', result.target],
      ['launchctl', 'enable', result.target],
      ['launchctl', 'bootstrap', 'gui/501', result.plistPath],
    ]);
  });

  test('a hardened source command keeps its options in order and checks only its paths', async () => {
    const s = setup();
    const agflow = { command: '/opt/bun', args: ['--no-env-file', '--config=/abs/bunfig.toml', '/abs/main.ts'] };
    const result = await installService({ ...s.options, agflow });
    expect(result.warnings).toEqual([]);
    expect(readFileSync(result.plistPath, 'utf8')).toContain(
      '<key>ProgramArguments</key>\n<array>\n<string>/opt/bun</string>\n<string>--no-env-file</string>\n' +
        '<string>--config=/abs/bunfig.toml</string>\n<string>/abs/main.ts</string>\n' +
        '<string>runner</string>\n<string>start</string>\n<string>--service</string>\n</array>',
    );
    expect(programPaths(agflow)).toEqual(['/opt/bun', '/abs/bunfig.toml', '/abs/main.ts']);
    const separate = { command: '/opt/bun', args: ['--config', '/abs/bunfig.toml', '/abs/main.ts'] };
    expect(programPaths(separate)).toEqual(['/opt/bun', '/abs/bunfig.toml', '/abs/main.ts']);
  });
  test.each(['Desktop', 'Documents', 'Downloads'])('warns for a program path under %s', async (folder) => {
    const s = setup();
    const log = mock(() => {});
    const result = await installService({
      ...s.options,
      agflow: { command: '/opt/bun', args: ['--no-env-file', join(s.home, folder, 'agflow/main.ts')] },
      log,
    });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain(join(s.home, folder, 'agflow/main.ts'));
    expect(result.warnings[0]).toContain('folder access');
    expect(result.warnings[0]).toContain('~/.local/bin');
    expect(result.warnings[0]).toContain('install again');
    expect(log).toHaveBeenCalledWith(result.warnings[0]);
  });

  test.each([
    { command: 'agflow', args: [] },
    { command: '/opt/bun', args: ['main.ts'] },
    { command: '/opt/bun', args: ['--config=bunfig.toml', '/abs/main.ts'] },
  ])('refuses relative executable or source paths before side effects', async (agflow) => {
    const s = setup();
    await expect(
      installService({ ...s.options, agflow: { command: agflow.command, args: [...agflow.args] } }),
    ).rejects.toThrow('absolute');
    expect(s.installPins).not.toHaveBeenCalled();
    expect(s.exec.calls).toEqual([]);
  });

  test('waits for a service lock after bootout and before enable or bootstrap', async () => {
    const s = setup();
    const lock = await acquireRunnerLock(s.paths, { mode: 'service' });
    afterThisTest(() => lock.release());
    let bootedOut!: () => void;
    const bootout = new Promise<void>((resolve) => {
      bootedOut = resolve;
    });
    const exec: Exec = async (argv, options) => {
      const result = await s.exec(argv, options);
      if (argv[1] === 'bootout') bootedOut();
      else expect(lock.held).toBe(false);
      return result;
    };
    const installing = installService({ ...s.options, exec, lockPollMs: 5, lockWaitMs: 1_000 });
    await bootout;
    await Bun.sleep(25);
    expect(s.exec.calls.map((call) => call.argv[1])).toEqual(['bootout']);
    lock.release();
    await installing;
    expect(s.exec.calls.map((call) => call.argv[1])).toEqual(['bootout', 'print', 'enable', 'bootstrap']);
  });

  test('bootstraps only once launchd has removed the job a timed out bootout left', async () => {
    const s = setup();
    const calls: string[] = [];
    let prints = 0;
    const exec: Exec = async (argv, options) => {
      calls.push(argv[1]!);
      if (argv[1] === 'bootout') {
        expect(options).toEqual({ timeoutMs: 75_000 });
        return { exitCode: 1, stdout: '', stderr: '', timedOut: true };
      }
      // print finds the job once, then launchd has removed it.
      const exitCode = argv[1] === 'print' && prints++ > 0 ? 113 : 0;
      return { exitCode, stdout: '', stderr: '', timedOut: false };
    };
    await installService({ ...s.options, exec, lockPollMs: 5, lockWaitMs: 1_000 });
    expect(calls).toEqual(['bootout', 'print', 'print', 'enable', 'bootstrap']);
  });

  test('a job launchd never removes aborts the install before bootstrap', async () => {
    const s = setup();
    const exec = recordingExec();
    await expect(installService({ ...s.options, exec, lockPollMs: 2, lockWaitMs: 20 })).rejects.toThrow(
      'launchd still has gui/501/dev.agflow.runner loaded',
    );
    expect(exec.calls.map((call) => call.argv[1]).filter((command) => command !== 'print')).toEqual(['bootout']);
  });

  test('times out naming a service pid and never bootstraps', async () => {
    const s = setup();
    const lock = await acquireRunnerLock(s.paths, { mode: 'service' });
    afterThisTest(() => lock.release());
    await expect(installService({ ...s.options, lockPollMs: 2, lockWaitMs: 10 })).rejects.toThrow(`pid ${process.pid}`);
    expect(s.exec.calls.map((call) => call.argv[1])).toEqual(['bootout']);
  });

  test('leaves a foreground runner alone and explains that the service waits for it', async () => {
    const s = setup();
    const lock = await acquireRunnerLock(s.paths, { mode: 'foreground' });
    afterThisTest(() => lock.release());
    const result = await installService({ ...s.options, lockWaitMs: 0 });
    expect(lock.held).toBe(true);
    expect(result.warnings.join(' ')).toContain(`pid ${process.pid}`);
    expect(result.warnings.join(' ')).toContain('service waits');
    expect(s.exec.calls).toHaveLength(4);
  });

  test.each(['env', 'config', 'both'])('refuses test mode from %s before any side effect', async (source) => {
    const s = setup();
    const env = source !== 'config' ? { AGFLOW_TEST: '1' } : {};
    const config = RunnerConfigSchema.parse({ ...s.config, ...(source !== 'env' ? { test: {} } : {}) });
    saveRunnerConfig(s.paths.config, config);
    const refusal = installRefusal(config, env);
    expect(refusal).toBeString();
    expect(refusal).toContain('test');
    expect(refusal).not.toContain('\n');
    await expect(installService({ ...s.options, env })).rejects.toThrow(refusal!);
    expect(s.installPins).not.toHaveBeenCalled();
    expect(s.exec.calls).toEqual([]);
    expect(existsSync(join(s.home, 'Library'))).toBe(false);
    expect(existsSync(s.paths.logs)).toBe(false);
  });

  test('installRefusal defaults to process.env and otherwise allows production', () => {
    const s = setup();
    expect(installRefusal(s.config)).toBeNull();
    process.env.AGFLOW_TEST = '1';
    expect(installRefusal(s.config)).toContain('test');
  });

  test('missing config points to setup without installing pins', async () => {
    const s = setup();
    rmSync(s.paths.config);
    await expect(installService(s.options)).rejects.toThrow('agflow runner setup');
    expect(s.installPins).not.toHaveBeenCalled();
    expect(s.exec.calls).toEqual([]);
  });

  test('pin failure leaves the existing plist and running service alone', async () => {
    const s = setup();
    const first = await installService(s.options);
    const original = readFileSync(first.plistPath, 'utf8');
    s.exec.calls.length = 0;
    await expect(
      installService({
        ...s.options,
        installPins: async () => {
          throw new Error('pin download failed');
        },
      }),
    ).rejects.toThrow('pin download failed');
    expect(readFileSync(first.plistPath, 'utf8')).toBe(original);
    expect(s.exec.calls).toEqual([]);
  });

  test.each(['enable', 'bootstrap'])('reports %s stderr and stops installation', async (command) => {
    const s = setup();
    const target = serviceTarget(undefined, 501);
    const argv =
      command === 'enable'
        ? ['launchctl', command, target]
        : ['launchctl', command, 'gui/501', plistPath({ home: s.home })];
    const exec = launchd([{ argv, result: { exitCode: 5, stderr: 'launchctl denied' } }]);
    const pending = installService({ ...s.options, exec });
    await expect(pending).rejects.toThrow('launchctl denied');
    if (command === 'bootstrap') await expect(pending).rejects.toThrow('logged-in desktop session');
    expect(exec.calls.at(-1)!.argv).toEqual(argv);
  });
});

describe('launchctl wrappers', () => {
  test('share target overrides and bound every command', async () => {
    const exec = recordingExec();
    const options = { exec, label: 'dev.agflow.scratch', uid: 123 };
    expect(await bootoutService(options)).toBe(true);
    await disableService(options);
    await kickstartService(options);
    expect(await serviceLoaded(options)).toBe(true);
    expect(exec.calls).toEqual(
      [
        ['launchctl', 'bootout', 'gui/123/dev.agflow.scratch'],
        ['launchctl', 'disable', 'gui/123/dev.agflow.scratch'],
        ['launchctl', 'kickstart', '-k', 'gui/123/dev.agflow.scratch'],
        ['launchctl', 'print', 'gui/123/dev.agflow.scratch'],
      ].map((argv) => ({
        argv,
        options: { timeoutMs: argv[1] === 'kickstart' ? 120_000 : argv[1] === 'bootout' ? 75_000 : 30_000 },
      })),
    );
  });

  test.each([
    { exitCode: 5, stderr: 'not loaded' },
    { timedOut: true, stderr: 'timed out' },
  ])('bootout and print tolerate failure; disable and kickstart report it', async (failure) => {
    const exec = recordingExec([], failure);
    expect(await bootoutService({ exec })).toBe(false);
    expect(await serviceLoaded({ exec })).toBe(false);
    await expect(disableService({ exec })).rejects.toThrow(failure.stderr);
    await expect(kickstartService({ exec })).rejects.toThrow(failure.stderr);
  });
});
