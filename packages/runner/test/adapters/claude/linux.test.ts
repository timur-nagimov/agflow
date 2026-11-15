// Claude on a Linux runner: the sandbox's tools and Ubuntu's restriction, which preflight checks before its handshake,
// and the account of a `claude setup-token` login.
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkAccount, claudeTokenAccountId } from '../../../src/adapters/claude/checks';
import { claudeBinary } from '../../../src/adapters/claude/options';
import { CLAUDE_CLI_VERSION } from '../../../src/adapters/claude/pin';
import {
  claudePreflight,
  LINUX_SANDBOX_TOOLS,
  linuxSandboxProblem,
  USERNS_SYSCTL,
} from '../../../src/adapters/claude/preflight';
import { QuotaBook } from '../../../src/adapters/claude/quota';
import { RunnerConfigSchema } from '../../../src/config';
import { runnerPaths } from '../../../src/paths';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agflow-claude-linux-')));
  dirs.push(dir);
  return dir;
}

/** A stand-in for the sysctl file, holding value. */
function sysctl(value: string): string {
  const file = join(scratch(), 'apparmor_restrict_unprivileged_userns');
  writeFileSync(file, `${value}\n`);
  return file;
}

/** A which that finds only the given commands, recording each lookup. */
function which(found: string[], lookups: string[] = []) {
  return (command: string, path: string) => {
    lookups.push(`${command} in ${path}`);
    return found.includes(command) ? `/usr/bin/${command}` : null;
  };
}

describe('the Claude sandbox on Linux', () => {
  test('needs bwrap, socat and rg on the captured PATH, and says how to install the missing ones', () => {
    expect(LINUX_SANDBOX_TOOLS).toEqual(['bwrap', 'socat', 'rg']);
    const lookups: string[] = [];
    const open = sysctl('0');
    expect(linuxSandboxProblem('/captured/bin:/usr/bin', { which: which(['socat'], lookups), usernsSysctl: open })).toBe(
      'the Claude sandbox needs bwrap, rg on the PATH: install them with sudo apt-get install bubblewrap socat ripgrep, ' +
        'then run agflow runner setup again',
    );
    expect(lookups).toEqual([
      'bwrap in /captured/bin:/usr/bin',
      'socat in /captured/bin:/usr/bin',
      'rg in /captured/bin:/usr/bin',
    ]);
    expect(linuxSandboxProblem('/usr/bin', { which: which(['bwrap', 'socat', 'rg']), usernsSysctl: open })).toBeNull();
  });

  test("names Ubuntu's restriction on user namespaces with its fix; with no such sysctl nothing restricts", () => {
    expect(USERNS_SYSCTL).toBe('/proc/sys/kernel/apparmor_restrict_unprivileged_userns');
    const all = which(['bwrap', 'socat', 'rg']);
    const restricted = linuxSandboxProblem('/usr/bin', { which: all, usernsSysctl: sysctl('1') });
    expect(restricted).toContain('Ubuntu keeps bubblewrap from building the Claude sandbox');
    expect(restricted).toContain('sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0');
    expect(restricted).toContain('/etc/sysctl.d');
    expect(linuxSandboxProblem('/usr/bin', { which: all, usernsSysctl: join(scratch(), 'missing') })).toBeNull();
  });

  test('preflight of a Linux pin reports a missing tool before any handshake', async () => {
    const root = scratch();
    const paths = runnerPaths(join(root, '.agflow'));
    const bin = claudeBinary(paths, CLAUDE_CLI_VERSION);
    mkdirSync(dirname(bin), { recursive: true });
    // It only answers --version: a handshake would end with another problem.
    writeFileSync(bin, `#!/bin/sh\necho "${CLAUDE_CLI_VERSION} (Claude Code)"\n`);
    chmodSync(bin, 0o755);
    const empty = join(root, 'empty-bin');
    mkdirSync(empty);
    const config = RunnerConfigSchema.parse({ runnerKey: 'r-1', machineId: 'm-1', name: 'cloud', capturedPath: empty });
    const result = await claudePreflight({
      agflow: { command: '/usr/bin/false', args: [] },
      config,
      paths,
      vendorHomes: { claude: paths.homes.claude, codex: paths.homes.codex },
      platform: 'linux-x64',
      quota: new QuotaBook(),
      skipAuthChecks: false,
      usernsSysctl: sysctl('0'),
    });
    expect(result.facts).toMatchObject({ vendor: 'claude', ready: false, cliVersion: CLAUDE_CLI_VERSION });
    expect(result.facts.problem).toContain('needs bwrap, socat, rg on the PATH');
    expect(result.facts.problem).toContain('sudo apt-get install bubblewrap socat ripgrep');
  });
});

describe('a claude setup-token login', () => {
  test('is ready and names no plan, and the token itself keys the quota', () => {
    const token = 'sk-ant-oat01-runner-token';
    const account = { tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN', apiProvider: 'firstParty' as const };
    expect(claudeTokenAccountId(token)).toBe(createHash('sha256').update(token).digest('hex').slice(0, 16));
    expect(checkAccount(account, { oauthToken: token })).toEqual({
      ready: true,
      problem: null,
      accountId: claudeTokenAccountId(token),
      plan: null,
    });
    expect(checkAccount(account)).toEqual({ ready: true, problem: null, accountId: null, plan: null });
    expect(checkAccount({ ...account, apiKeySource: 'ANTHROPIC_API_KEY' }, { oauthToken: token })).toMatchObject({
      ready: false,
      problem: 'an API key would replace the subscription',
    });
  });
});
