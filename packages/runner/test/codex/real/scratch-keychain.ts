import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type SecurityCommand = (args: string[], env: Record<string, string>) => number;

const runSecurity: SecurityCommand = (args, env) =>
  Bun.spawnSync(['/usr/bin/security', ...args], { env, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' }).exitCode;

export interface ScratchKeychain {
  home: string;
  path: string;
  service: string;
  secret: string;
}

/** A disposable keychain in a caller-owned scratch HOME, never the default keychain or the owner's search list. */
export async function withScratchKeychain(
  home: string,
  use: (item: ScratchKeychain) => Promise<void>,
  security: SecurityCommand = runSecurity,
): Promise<void> {
  const item = {
    home,
    path: join(home, 'Library', 'Keychains', 'probe.keychain-db'),
    service: `agflow-sandbox-check-${randomUUID()}`,
    secret: randomUUID(),
  };
  const env = { PATH: '/usr/bin:/bin', HOME: item.home };
  mkdirSync(dirname(item.path), { recursive: true, mode: 0o700 });
  const run = (...args: string[]) => {
    if (security(args, env) !== 0) throw new Error(`security ${args[0]} failed`);
  };
  try {
    run('create-keychain', '-p', randomUUID(), item.path);
    run('add-generic-password', '-a', 'agflow', '-s', item.service, '-w', item.secret, item.path);
    await use(item);
  } finally {
    run('delete-keychain', item.path);
    if (existsSync(item.path)) throw new Error('security delete-keychain left the scratch keychain behind');
  }
}
