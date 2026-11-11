import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type SecurityCommand, withScratchKeychain } from './scratch-keychain';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function fixture(fail?: string) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "agflow-keychain's home-")));
  homes.push(home);
  const calls: { args: string[]; env: Record<string, string> }[] = [];
  const security: SecurityCommand = (args, env) => {
    calls.push({ args, env });
    return args[0] === fail ? 1 : 0;
  };
  return { home, calls, security };
}

test('keychain setup and removal use only an explicit disposable path and scratch HOME', async () => {
  const { home, calls, security } = fixture();
  const path = join(home, 'Library', 'Keychains', 'probe.keychain-db');
  await withScratchKeychain(home, async (item) => {
    expect(item.home).toBe(home);
    expect(item.path).toBe(path);
    expect(calls.map(({ args }) => args[0])).toEqual(['create-keychain', 'add-generic-password']);
    expect(calls[0]!.args).toEqual(['create-keychain', '-p', expect.any(String), path]);
    expect(calls[1]!.args).toEqual(['add-generic-password', '-a', 'agflow', '-s', item.service, '-w', item.secret, path]);
  }, security);
  expect(calls.at(-1)!.args).toEqual(['delete-keychain', path]);
  for (const { args, env } of calls) {
    expect(args.at(-1)).toBe(path);
    expect(env).toEqual({ PATH: '/usr/bin:/bin', HOME: home });
  }
});

test.each(['create-keychain', 'add-generic-password', 'probe'])(
  'keychain cleanup runs even when %s fails', async (failure) => {
    const { home, calls, security } = fixture(failure);
    let used = false;
    await expect(withScratchKeychain(home, async () => {
      used = true;
      throw new Error('probe failed');
    }, security)).rejects.toThrow(`${failure} failed`);
    expect(used).toBe(failure === 'probe');
    expect(calls.at(-1)!.args).toEqual(['delete-keychain', join(home, 'Library', 'Keychains', 'probe.keychain-db')]);
  },
);

test('keychain removal failures fail the check', async () => {
  const { home, security } = fixture('delete-keychain');
  await expect(withScratchKeychain(home, async () => {}, security)).rejects.toThrow('delete-keychain failed');
});
