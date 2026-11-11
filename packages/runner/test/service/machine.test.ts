import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONNECTIVITY_VARS } from '../../src/config';
import { agflowHome, runnerPaths } from '../../src/paths';
import {
  canonicalHome,
  captureLoginShellEnv,
  machineMismatch,
  parseIoregPlatformUuid,
  readComputerName,
  readGitIdentity,
  readMachineId,
} from '../../src/service/machine';
import { defaultExec } from '../../src/service/system';
import { recordingExec } from '../service-helpers';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agf-machine-'));
  dirs.push(dir);
  return dir;
}
function shell(body: string): string {
  const path = join(scratch(), 'shell');
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
  return path;
}

const uuid = 'A28F9E10-1234-5678-ABCD-0123456789AB';
const ioreg =
  '+-o MacBookPro18,3  <class IOPlatformExpertDevice, id 0x100000100, registered, matched, ' +
  `active, busy 0 (0 ms), retain 42>
    {
      "IOPlatformSerialNumber" = "TESTSERIAL"
      "IOPlatformUUID" = "${uuid}"
      "model" = <"MacBookPro18,3">
    }
`;

describe('machine facts', () => {
  test('parses a recorded ioreg UUID and refuses missing or malformed UUIDs', () => {
    expect(parseIoregPlatformUuid(ioreg)).toBe(uuid);
    expect(() => parseIoregPlatformUuid('no UUID')).toThrow('IOPlatformUUID');
    expect(() => parseIoregPlatformUuid('"IOPlatformUUID" = ""')).toThrow('IOPlatformUUID');
  });

  test('reads ioreg on macOS and a trimmed machine-id file elsewhere', async () => {
    const exec = recordingExec([
      { argv: ['ioreg', '-rd1', '-c', 'IOPlatformExpertDevice'], result: { stdout: ioreg } },
    ]);
    expect(await readMachineId({ platform: 'darwin', exec })).toBe(uuid);
    expect(exec.calls.map((call) => call.argv)).toEqual([['ioreg', '-rd1', '-c', 'IOPlatformExpertDevice']]);
    const file = join(scratch(), 'machine-id');
    writeFileSync(file, '0123456789abcdef0123456789abcdef\n');
    expect(await readMachineId({ platform: 'linux', machineIdFile: file, exec })).toBe(
      '0123456789abcdef0123456789abcdef',
    );
    expect(exec.calls).toHaveLength(1);
    writeFileSync(file, '\n');
    await expect(readMachineId({ platform: 'linux', machineIdFile: file })).rejects.toThrow(file);
  });

  test('reports a failed ioreg instead of binding an empty machine identity', async () => {
    await expect(
      readMachineId({ platform: 'darwin', exec: recordingExec([], { exitCode: 127, stderr: 'missing' }) }),
    ).rejects.toThrow('ioreg');
  });

  test('uses ComputerName and falls back to hostname on failure or empty output', async () => {
    const exec = recordingExec([], { stdout: '  Owner’s Mac\n' });
    expect(await readComputerName(exec)).toBe('Owner’s Mac');
    expect(exec.calls[0].argv).toEqual(['scutil', '--get', 'ComputerName']);
    for (const result of [{ exitCode: 1 }, { stdout: '\n' }, { timedOut: true, stdout: 'partial' }]) {
      expect(await readComputerName(recordingExec([], result))).toBe(hostname());
    }
  });

  test('reads both global git identity fields and returns null when either is unset', async () => {
    const exec = recordingExec(
      [
        { argv: ['git', 'config', '--global', 'user.name'], result: { stdout: 'Owner Name\n' } },
        { argv: ['git', 'config', '--global', 'user.email'], result: { stdout: 'owner@example.test\n' } },
      ],
      { exitCode: 1 },
    );
    expect(await readGitIdentity(exec)).toEqual({ name: 'Owner Name', email: 'owner@example.test' });
    expect(exec.calls.map((call) => call.argv)).toEqual([
      ['git', 'config', '--global', 'user.name'],
      ['git', 'config', '--global', 'user.email'],
    ]);
    for (const missing of ['user.name', 'user.email']) {
      expect(
        await readGitIdentity(
          recordingExec(
            [{ argv: ['git', 'config', '--global', missing], result: { exitCode: 1 } }],
            { stdout: 'present\n' },
          ),
        ),
      ).toBeNull();
    }
    expect(await readGitIdentity(recordingExec([], { stdout: '\n' }))).toBeNull();
  });

  test('creates private canonical vendor homes through a symlinked AGFLOW_HOME', () => {
    const root = scratch();
    mkdirSync(join(root, 'real'));
    symlinkSync(join(root, 'real'), join(root, 'link'));
    const paths = runnerPaths(agflowHome({ AGFLOW_HOME: join(root, 'link') }));
    for (const path of Object.values(paths.homes)) {
      const home = canonicalHome(`${path}/`);
      expect(home).toBe(realpathSync(path));
      expect(home.endsWith('/')).toBe(false);
      expect(statSync(home).mode & 0o777).toBe(0o700);
      chmodSync(home, 0o755);
      expect(canonicalHome(path)).toBe(home);
      expect(statSync(home).mode & 0o777).toBe(0o700);
    }
  });

  test('refuses a runner.json from another machine with the setup instruction', () => {
    expect(machineMismatch({ machineId: uuid }, uuid)).toBeNull();
    expect(machineMismatch({ machineId: uuid }, 'another')).toBe(
      'this runner.json belongs to another Mac; run agflow runner setup',
    );
  });
});

describe('captureLoginShellEnv', () => {
  test('captures only PATH and allowed connectivity, preserving values inside markers', async () => {
    const fake = shell(`
if read -r input; then exit 9; fi
printf 'profile noise PATH=wrong\\n'
export PATH=':./bin:node_modules/.bin:/login/bin::/usr/bin:.:/login/bin'
unset ALL_PROXY
export NO_PROXY=''
export HTTPS_PROXY='http://proxy.test/?a=b'
export SSL_CERT_FILE='cert path
second line'
/bin/sh -c "$4"
printf '\\nlogout noise PATH=wrong\\n'
`);
    const connectivity = Object.fromEntries(CONNECTIVITY_VARS.map((name) => [name, `value-${name}`]));
    const env = {
      ...connectivity,
      SHELL: fake,
      PATH: '/original/bin',
      OPENAI_API_KEY: 'secret',
      AGFLOW_TOKEN: 'secret',
    };
    const calls = recordingExec();
    const captured = await captureLoginShellEnv({
      env,
      exec: async (argv, options) => {
        await calls(argv, options);
        return defaultExec(argv, options);
      },
    });
    const { ALL_PROXY: _unset, ...remaining } = connectivity;
    expect(captured.connectivity).not.toHaveProperty('ALL_PROXY');
    expect(captured.connectivity).toHaveProperty('NO_PROXY', '');
    expect(captured).toStrictEqual({
      path: '/login/bin:/usr/bin',
      connectivity: {
        ...remaining,
        NO_PROXY: '',
        HTTPS_PROXY: 'http://proxy.test/?a=b',
        SSL_CERT_FILE: 'cert path\nsecond line',
      },
    });
    expect(calls.calls[0].argv.slice(0, 4)).toEqual([fake, '-l', '-i', '-c']);
    expect(calls.calls[0].options).toMatchObject({ env, cwd: homedir(), timeoutMs: 10_000 });
    expect(calls.calls[0].options?.interactive).not.toBe(true);
  });

  test('uses /bin/zsh when SHELL is unset and falls back on malformed capture', async () => {
    const exec = recordingExec([], { stdout: 'noise only' });
    expect(
      await captureLoginShellEnv({ env: { PATH: '/fallback', ALL_PROXY: 'proxy', TOKEN: 'secret' }, exec }),
    ).toEqual({ path: '/fallback', connectivity: { ALL_PROXY: 'proxy' } });
    expect(exec.calls[0].argv.slice(0, 4)).toEqual(['/bin/zsh', '-l', '-i', '-c']);
    expect(await captureLoginShellEnv({ env: { ALL_PROXY: 'proxy' }, exec })).toEqual({
      path: '/usr/bin:/bin:/usr/sbin:/sbin',
      connectivity: { ALL_PROXY: 'proxy' },
    });
  });

  test.each([
    [':./bin:node_modules/.bin:/login/bin::/usr/bin:.:/login/bin', '/login/bin:/usr/bin'],
    [':.:./bin:node_modules/.bin', '/usr/bin:/bin:/usr/sbin:/sbin'],
  ])('filters fallback PATH %s', async (path, expected) => {
    expect(await captureLoginShellEnv({ env: { PATH: path }, exec: recordingExec() })).toEqual({
      path: expected,
      connectivity: {},
    });
  });

  test('uses the default for an all-relative captured PATH and runs the shell in HOME', async () => {
    const home = realpathSync(scratch());
    const fake = shell(`
export PATH=':.:./bin'
export SSL_CERT_DIR="$(pwd)"
/bin/sh -c "$4"
`);
    expect(await captureLoginShellEnv({ env: { HOME: home, SHELL: fake, PATH: '/caller/bin' } })).toStrictEqual({
      path: '/usr/bin:/bin:/usr/sbin:/sbin',
      connectivity: { SSL_CERT_DIR: home },
    });
  }, 20_000);

  test('falls back to the given environment when the shell fails, is missing or times out', async () => {
    const failed = shell('export PATH=/failed-shell; eval "$4"; exit 3');
    const missing = join(scratch(), 'missing');
    const hanging = shell('exec /bin/sleep 30');
    for (const fake of [failed, missing, hanging]) {
      expect(
        await captureLoginShellEnv({
          env: { SHELL: fake, PATH: '/fallback', HTTP_PROXY: 'proxy', TOKEN: 'secret' },
          timeoutMs: fake === hanging ? 50 : 5_000,
          exec: async (argv, options) => {
            const result = await defaultExec(argv, options);
            if (fake === failed) {
              expect(result).toMatchObject({ timedOut: false, exitCode: 3 });
              expect(result.stdout).toContain('PATH=/failed-shell');
              expect(result.stdout).toContain('AGFLOW_ENV_END_');
            }
            return result;
          },
        }),
      ).toEqual({ path: '/fallback', connectivity: { HTTP_PROXY: 'proxy' } });
    }
  }, 20_000);
});

describe('defaultExec', () => {
  test('closes stdin, captures both streams, and applies cwd and the whole environment', async () => {
    const cwd = realpathSync(scratch());
    const script = [
      'read -r input && exit 9',
      'printf "%s|%s|%s" "$PWD" "$CUSTOM" "${HOME-unset}"',
      'printf error >&2',
      'exit 7',
    ].join('\n');
    const result = await defaultExec(['/bin/sh', '-c', script], { cwd, env: { CUSTOM: 'value' } });
    expect(result).toEqual({ exitCode: 7, stdout: `${cwd}|value|unset`, stderr: 'error', timedOut: false });
  });

  test('returns 127 for a missing executable and kills a timed-out command', async () => {
    const missing = await defaultExec([join(scratch(), 'missing')]);
    expect(missing.exitCode).toBe(127);
    expect(missing.stderr.length).toBeGreaterThan(0);
    expect(missing.timedOut).toBe(false);
    const timeout = await defaultExec(['/bin/sleep', '30'], { timeoutMs: 50 });
    expect(timeout.timedOut).toBe(true);
    expect(timeout.exitCode).not.toBe(0);
  });

  test('interactive commands return empty captured streams', async () => {
    expect(await defaultExec(['/usr/bin/true'], { interactive: true })).toEqual({
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
    });
  });

  test('a timeout does not wait for a shell child still holding the output pipes', async () => {
    const started = Date.now();
    const result = await defaultExec(['/bin/sh', '-c', 'printf started; /bin/sleep 2; printf late'], {
      timeoutMs: 100,
    });
    expect(result).toMatchObject({ timedOut: true, stdout: 'started' });
    expect(Date.now() - started).toBeLessThan(1_500);
  });
});
