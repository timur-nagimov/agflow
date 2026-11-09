import { afterEach, describe, expect, test } from 'bun:test';
import { commitFiles, gitIn, originRepo } from '@agflow/testkit';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { codexEnrichApproval, isPackageManagerCommand, manifestDiff } from '../../src/adapters/codex/manifest-diff';
import { ensureRunnerGitFiles, localGitEnv } from '../../src/git/run';
import type { VendorAdapter } from '../../src/adapters/types';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function write(root: string, files: Record<string, string | Uint8Array>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

async function fixture(files: Record<string, string> = {}) {
  const origin = await originRepo(files);
  dirs.push(origin.root);
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agflow-manifests-')));
  dirs.push(root);
  const clone = join(root, 'clone');
  mkdirSync(clone);
  write(clone, files);
  const paths = { gitConfig: join(root, 'git/local.gitconfig'), gitExcludes: join(root, 'git/excludes') };
  ensureRunnerGitFiles(paths);
  return { root, clone, vault: origin.path, startSha: origin.mainSha, local: localGitEnv(paths) };
}

function patch(path: string, before: string, after: string): string {
  return `===================================================================\n--- a/${path}\n+++ b/${path}\n@@ -${before ? '1,1' : '0,0'} +${after ? '1,1' : '0,0'} @@\n${before ? `-${before}\n` : ''}${after ? `+${after}\n` : ''}`;
}

describe('isPackageManagerCommand', () => {
  for (const command of [
    'npm install',
    'npm i',
    'npm ci',
    'npm add thing',
    'bun add thing',
    'bun install',
    'bun i',
    'pnpm add thing',
    'pnpm install',
    'pnpm i',
    'yarn',
    'yarn add thing',
    'yarn install',
    'pip install -r requirements.txt',
    'pip3 install thing',
    'uv pip install thing',
    'uv add thing',
    'poetry add thing',
    'poetry install',
    'cargo add thing',
    'go get example.org/pkg',
    'cd x && npm install',
    'echo ready; bun add thing',
    'npm test && pnpm i; echo done',
    'VAR=value OTHER="two words" npm ci',
    'cd x && VAR=value bun install',
    "/bin/zsh -c 'cd x && npm install'",
    'bash -lc "VAR=value bun add thing"',
    "/bin/zsh -c 'echo '\\''ready'\\''; pnpm i'",
    '/usr/bin/npm install',
    // Options before the subcommand, with their values.
    'npm --prefix web install',
    'pnpm -C web install',
    'yarn --cwd web add x',
    'bun --cwd web install',
    'npm --prefix=web ci',
    'yarn --frozen-lockfile',
    // Updates, rebuilds and npm's aliases.
    'npm update',
    'npm rebuild',
    'pnpm up',
    'yarn upgrade',
    'bun update',
    'npm clean-install',
    'npm install-test',
    'npm it',
    'npm isntall thing',
    'uv sync',
    'uv pip sync requirements.txt',
    'python3 -m pip install -r requirements.txt',
    'python -m pip3 install thing',
    'pip3.12 install thing',
    // Wrappers, subshells and groups.
    'env CI=1 npm install',
    'env -i PATH=/bin npm install',
    'time npm ci',
    'command npm i',
    'nohup bun install',
    'exec pnpm install',
    '(cd web && npm install)',
    '{ cd web; npm install; }',
  ]) {
    test(command, () => expect(isPackageManagerCommand(command)).toBe(true));
  }
  for (const command of [
    '',
    'npm test',
    'npm run install',
    'bun run build',
    'bun test',
    'git commit',
    'notnpm install',
    'echo npm install',
    'echo "npm install; bun add x"',
    'yarn test',
    'pip uninstall thing',
    'cargo build',
    'go test',
    'uv pip list',
    'echo /bin/zsh -c "npm install"',
    "/bin/zsh -c 'npm test'",
    'VALUE="npm install" echo done',
    'npm --prefix web test',
    'command -v npm',
    'python3 -m pytest',
    'python3 -m pip list',
    'uv run pytest',
    'echo ${npm} install',
    '(echo npm install)',
  ]) {
    test(command || 'empty', () => expect(isPackageManagerCommand(command)).toBe(false));
  }
});

describe('manifestDiff', () => {
  test('diffs root and cwd manifests against startSha, even after the vault main advances', async () => {
    const input = await fixture({ 'package.json': 'root before\n', 'app/package.json': 'app before\n' });
    await commitFiles(input.vault, { branch: 'main', files: { 'package.json': 'new main\n' } });
    write(input.clone, {
      'package.json': 'root after\n',
      '.npmrc': 'registry=root\n',
      'app/package.json': 'app after\n',
      'app/.npmrc': 'registry=app\n',
      'unrelated/package.json': 'not included\n',
    });
    const expected =
      patch('package.json', 'root before', 'root after') +
      patch('.npmrc', '', 'registry=root') +
      patch('app/package.json', 'app before', 'app after') +
      patch('app/.npmrc', '', 'registry=app');
    expect(await manifestDiff({ ...input, cwd: join(input.clone, 'app') })).toBe(expected);
    expect(await manifestDiff({ ...input, cwd: 'app' })).toBe(expected);
  });

  test('unchanged files and missing manifests return null; a removed manifest has a unified diff', async () => {
    const input = await fixture({ 'package.json': '{}\n', 'yarn.lock': 'lock\n' });
    expect(await manifestDiff(input)).toBeNull();
    rmSync(join(input.clone, 'yarn.lock'));
    expect(await manifestDiff(input)).toBe(patch('yarn.lock', 'lock', ''));
  });

  test('covers every manifest of the recognised managers, and every .yarnrc* name', async () => {
    const input = await fixture();
    const names = [
      'package.json',
      'package-lock.json',
      'npm-shrinkwrap.json',
      'yarn.lock',
      'pnpm-lock.yaml',
      'bun.lock',
      '.npmrc',
      '.yarnrc',
      '.yarnrc.extra',
      '.yarnrc.yaml',
      '.yarnrc.yml',
      'bunfig.toml',
      'pyproject.toml',
      'requirements.txt',
      'poetry.lock',
      'uv.lock',
      'Pipfile',
      'Pipfile.lock',
      'Cargo.toml',
      'Cargo.lock',
      'go.mod',
      'go.sum',
    ];
    write(input.clone, Object.fromEntries([...names, 'Gemfile', 'yarnrc'].map((name) => [name, 'new\n'])));
    expect(await manifestDiff(input)).toBe(names.map((name) => patch(name, '', 'new')).join(''));
  });

  test('finds .yarnrc* names in the start commit and the clone, case-insensitively, in the root and cwd', async () => {
    const input = await fixture({ '.yarnrc.ci.yml': 'base\n', 'app/.YARNRC.local': 'app base\n' });
    rmSync(join(input.clone, 'app/.YARNRC.local'));
    write(input.clone, { '.yarnrc.ci.yml': 'agent\n', 'app/.Yarnrc.yml': 'new\n' });
    expect(await manifestDiff({ ...input, cwd: 'app' })).toBe(
      patch('.yarnrc.ci.yml', 'base', 'agent') +
        patch('app/.YARNRC.local', 'app base', '') +
        patch('app/.Yarnrc.yml', '', 'new'),
    );
  });

  test("adds a pip command's requirement files inside the clone, relative to its cwd", async () => {
    const input = await fixture({ 'app/reqs/dev.txt': 'one\n' });
    write(input.clone, { 'app/reqs/dev.txt': 'two\n', 'app/constraints.txt': 'pinned\n' });
    write(input.root, { 'outside.txt': 'secret\n' });
    const request: Parameters<NonNullable<VendorAdapter['enrichApproval']>>[0]['request'] = {
      kind: 'command',
      summary: 'install',
      detail: {
        command: `python3 -m pip install -r reqs/dev.txt --constraint=constraints.txt -r ../../outside.txt -r ${join(input.root, 'outside.txt')}`,
        cwd: 'app',
      },
    };
    expect((await codexEnrichApproval({ ...input, request }, input.local)).manifestDiff).toBe(
      patch('app/reqs/dev.txt', 'one', 'two') + patch('app/constraints.txt', '', 'pinned'),
    );
  });

  test('ignores outside, traversing, sibling-prefix and symlinked cwd directories', async () => {
    const input = await fixture({ 'package.json': '{}\n' });
    write(input.root, { 'outside/package.json': 'outside secret\n', 'clone-sibling/package.json': 'sibling secret\n' });
    symlinkSync(join(input.root, 'outside'), join(input.clone, 'linked'));
    for (const cwd of [join(input.root, 'outside'), '../outside', '../clone-sibling', 'linked', 'linked/../linked']) {
      expect(await manifestDiff({ ...input, cwd })).toBeNull();
    }
  });

  test('does not normalize away a symlink before checking cwd traversal', async () => {
    const input = await fixture({ 'app/package.json': 'before\n' });
    write(input.clone, { 'app/package.json': 'after\n' });
    write(input.root, { 'outside/child/keep': '', 'outside/app/package.json': 'secret\n' });
    symlinkSync(join(input.root, 'outside/child'), join(input.clone, 'linked'));
    expect(await manifestDiff({ ...input, cwd: 'linked/../app' })).toBeNull();
  });

  test('reports symlinks without following them, directories and FIFOs without blocking', async () => {
    const input = await fixture();
    const outside = join(input.root, 'secret');
    writeFileSync(outside, 'outside secret content');
    symlinkSync(outside, join(input.clone, 'package.json'));
    mkdirSync(join(input.clone, '.npmrc'));
    const proc = Bun.spawn(['mkfifo', join(input.clone, 'yarn.lock')]);
    expect(await proc.exited).toBe(0);
    const text = await manifestDiff(input);
    expect(text).toContain(`package.json: absent -> symlink -> ${JSON.stringify(outside)}\n`);
    expect(text).toContain('.npmrc: absent -> directory\n');
    expect(text).toContain('yarn.lock: absent -> non-regular file\n');
    expect(text).not.toContain('outside secret content');
  });

  test('summarises oversized base and current files with their sizes', async () => {
    const input = await fixture({ 'package.json': 'x'.repeat(256 * 1024 + 1), 'yarn.lock': 'old\n' });
    write(input.clone, { 'package.json': '{}\n', 'yarn.lock': 'y'.repeat(256 * 1024 + 2) });
    expect(await manifestDiff(input)).toBe(
      'package.json: size limit (262144 bytes); base 262145 bytes, current 3 bytes\n' +
        'yarn.lock: size limit (262144 bytes); base 4 bytes, current 262146 bytes\n',
    );
  });

  test('skips an unchanged oversized lockfile and an unchanged committed symlink', async () => {
    const big = 'z'.repeat(2 * 1024 * 1024 + 7);
    const input = await fixture({ 'package-lock.json': big });
    // A start commit whose .npmrc is a symlink, and a clone holding the same link.
    const work = join(input.root, 'work');
    await gitIn(input.root, ['clone', '--quiet', input.vault, work]);
    symlinkSync('shared/npmrc', join(work, '.npmrc'));
    await gitIn(work, ['add', '.npmrc']);
    await gitIn(work, ['commit', '--quiet', '-m', 'link .npmrc']);
    await gitIn(work, ['push', '--quiet', 'origin', 'main']);
    input.startSha = await gitIn(work, ['rev-parse', 'HEAD']);
    symlinkSync('shared/npmrc', join(input.clone, '.npmrc'));
    expect(await manifestDiff(input)).toBeNull();
    write(input.clone, { 'package-lock.json': `${big.slice(1)}y` });
    expect(await manifestDiff(input)).toBe(
      `package-lock.json: size limit (262144 bytes); base ${big.length} bytes, current ${big.length} bytes\n`,
    );
  });

  test('summarises binary files, including bun.lockb without NULs, and skips unchanged binaries', async () => {
    const input = await fixture({ 'bun.lockb': 'before', 'package-lock.json': 'a\0b' });
    expect(await manifestDiff(input)).toBeNull();
    write(input.clone, { 'bun.lockb': 'after', 'package-lock.json': new Uint8Array([97, 0, 99]) });
    expect(await manifestDiff(input)).toBe(
      'package-lock.json: binary; base 3 bytes, current 3 bytes\n' +
        'bun.lockb: binary; base 6 bytes, current 5 bytes\n',
    );
  });

  test('bounds diff computation for manifests with many changed lines', async () => {
    const input = await fixture({ 'package.json': 'before\n'.repeat(5000) });
    write(input.clone, { 'package.json': 'after\n'.repeat(5000) });
    expect(await manifestDiff(input)).toBe(
      'package.json: diff computation limit; base 35000 bytes, current 30000 bytes\n',
    );
  });

  test('caps total UTF-8 output and marks the cut', async () => {
    const input = await fixture();
    write(input.clone, { 'package.json': '😀'.repeat(30_000) + '\n', '.npmrc': 'registry=last\n' });
    const text = (await manifestDiff(input))!;
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(64 * 1024);
    expect(text.endsWith('\n[manifest diff truncated]\n')).toBe(true);
    expect(text).not.toContain('\ufffd');
    expect(text).not.toContain('registry=last');
  });

  test('never runs textconv or external diff drivers from the clone', async () => {
    const input = await fixture({ 'package.json': 'before\n' });
    await gitIn(input.clone, ['init', '--quiet']);
    const textconv = join(input.root, 'textconv-ran');
    const external = join(input.root, 'external-ran');
    write(input.clone, {
      '.git/config': `[core]\nrepositoryformatversion = 0\nbare = false\n[diff "x"]\ntextconv = touch ${textconv}\n[diff]\nexternal = touch ${external}\n`,
      '.gitattributes': 'package.json diff=x\n',
      'package.json': 'after\n',
    });
    expect(await manifestDiff(input)).toBe(patch('package.json', 'before', 'after'));
    expect(existsSync(textconv)).toBe(false);
    expect(existsSync(external)).toBe(false);
  });

  test('propagates an invalid start commit and unavailable vault instead of treating them as absent', async () => {
    const input = await fixture();
    await expect(manifestDiff({ ...input, startSha: '0'.repeat(40) })).rejects.toThrow();
    await expect(manifestDiff({ ...input, vault: join(input.root, 'missing.git') })).rejects.toThrow();
  });
});

describe('codexEnrichApproval', () => {
  test('adds the manifest diff only for changed package-manager command requests, preserving other detail', async () => {
    const input = await fixture({ 'app/package.json': 'before\n' });
    const detail = { command: "/bin/zsh -c 'npm install'", cwd: 'app', reason: 'network', diff: 'original' };
    const request: Parameters<NonNullable<VendorAdapter['enrichApproval']>>[0]['request'] = {
      kind: 'command',
      summary: 'install',
      detail,
    };
    expect(await codexEnrichApproval({ ...input, request }, input.local)).toBe(detail);
    write(input.clone, { 'app/package.json': 'after\n' });
    expect(await codexEnrichApproval({ ...input, request }, input.local)).toEqual({
      ...detail,
      manifestDiff: patch('app/package.json', 'before', 'after'),
    });
    expect(detail).not.toHaveProperty('manifestDiff');
    for (const other of [
      { ...request, kind: 'file_change' as const },
      { ...request, kind: 'other' as const },
      { ...request, detail: { ...detail, command: 'npm test', manifestDiff: 'existing' } },
      { ...request, detail: {} },
    ]) {
      expect(await codexEnrichApproval({ ...input, request: other }, input.local)).toBe(other.detail);
    }
  });
});
