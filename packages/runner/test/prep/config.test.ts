import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitFiles, gitIn, originRepo } from '@agflow/testkit';
import { ensureRunnerGitFiles, runGit } from '../../src/git/run';
import { Vault } from '../../src/git/vault';
import { runnerPaths } from '../../src/paths';
import { PrepConfigSchema, readPrepConfig } from '../../src/prep/config';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function directory(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agflow-prep-config-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const entry = { run: ['bun', 'install', '--frozen-lockfile', '--ignore-scripts'], when: ['package.json', 'bun.lock'] };
const config = { dependencies: [entry] };

async function fixture(files: Record<string, string>) {
  const repo = await originRepo(files);
  cleanups.push(() => repo.remove());
  const paths = runnerPaths(directory());
  ensureRunnerGitFiles(paths);
  const vault = new Vault({ paths, project: 'demo', repo: { url: repo.path, mainBranch: 'main' } });
  await vault.ensure();
  const fetch = () =>
    runGit(vault.local, ['--git-dir', vault.path, 'fetch', repo.path, 'refs/heads/main:refs/heads/main']);
  await fetch();
  return { repo, vault, fetch };
}

describe('PrepConfigSchema', () => {
  test('accepts the design example, scripts and empty dependency/when lists', () => {
    expect(PrepConfigSchema.parse(config)).toEqual({ dependencies: [{ ...entry, scripts: false }] });
    expect(PrepConfigSchema.parse({ dependencies: [{ ...entry, scripts: true }] }).dependencies[0]?.scripts).toBe(true);
    expect(PrepConfigSchema.parse({ dependencies: [] })).toEqual({ dependencies: [] });
    expect(PrepConfigSchema.safeParse({ dependencies: [{ ...entry, when: [] }] }).success).toBe(true);
  });

  test.each(['bun install', [], [''], ['bun', ''], ['bun', '\0']].map((run) => ({ run })))(
    'rejects invalid argv %j',
    ({ run }) => {
      expect(PrepConfigSchema.safeParse({ dependencies: [{ ...entry, run }] }).success).toBe(false);
    },
  );

  test.each(['', '/package.json', '../a', 'a/../b', 'a/..', '.', './a', 'a/./b', 'a//b', 'a/', 'a\0b', 'C:\\a'])(
    'rejects unsafe or non-normalized when path %j',
    (path) => expect(PrepConfigSchema.safeParse({ dependencies: [{ ...entry, when: [path] }] }).success).toBe(false),
  );

  test('uses strict objects and boolean scripts', () => {
    for (const value of [
      { ...config, extra: true },
      { dependencies: [{ ...entry, extra: true }] },
      { dependencies: [{ ...entry, scripts: 'true' }] },
    ])
      expect(PrepConfigSchema.safeParse(value).success).toBe(false);
  });
});

describe('readPrepConfig', () => {
  test('reads the specified vault commit, ignoring the clone and later commits; absence is null', async () => {
    const { repo, vault, fetch } = await fixture({ 'README.md': 'demo' });
    const base = await commitFiles(repo.path, {
      branch: 'main',
      files: { '.agflow/config.json': JSON.stringify(config) },
    });
    await fetch();
    const clone = join(directory(), 'clone');
    await runGit(vault.local, ['clone', vault.path, clone]);
    mkdirSync(join(clone, '.agflow'), { recursive: true });
    writeFileSync(join(clone, '.agflow/config.json'), '{"dependencies":[]}');
    await commitFiles(repo.path, { branch: 'main', files: { '.agflow/config.json': '{"dependencies":[]}' } });
    await fetch();
    expect(await readPrepConfig(vault, base)).toEqual(PrepConfigSchema.parse(config));
    expect(await readPrepConfig(vault, repo.mainSha)).toBeNull();
    await expect(readPrepConfig(vault, 'f'.repeat(40))).rejects.toThrow('.agflow/config.json');
  });

  test.each(['{', '{"dependencies":[{"run":"bun install","when":[]}]}', ' '.repeat(1024 * 1024 + 1)])(
    'rejects malformed, invalid or oversized config (%#)',
    async (content) => {
      const { vault, repo } = await fixture({ '.agflow/config.json': content });
      await expect(readPrepConfig(vault, repo.mainSha)).rejects.toThrow('.agflow/config.json');
      if (content.length > 1024 * 1024) {
        await expect(readPrepConfig(vault, repo.mainSha)).rejects.toThrow('size limit');
      }
    },
  );

  test.each(['symlink', 'directory'])('rejects a %s named config.json', async (kind) => {
    const { repo, vault, fetch } = await fixture({ 'README.md': 'demo' });
    const clone = join(directory(), 'edit');
    await runGit(vault.local, ['clone', repo.path, clone]);
    mkdirSync(join(clone, '.agflow'));
    if (kind === 'symlink') symlinkSync('../README.md', join(clone, '.agflow/config.json'));
    else {
      mkdirSync(join(clone, '.agflow/config.json'));
      writeFileSync(join(clone, '.agflow/config.json/child'), '{}');
    }
    await gitIn(clone, ['add', '.agflow']);
    await gitIn(clone, ['commit', '-m', 'invalid config type']);
    await gitIn(clone, ['push', 'origin', 'main']);
    await fetch();
    const sha = await gitIn(clone, ['rev-parse', 'HEAD']);
    await expect(readPrepConfig(vault, sha)).rejects.toThrow('regular file');
  });
});
