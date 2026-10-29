import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitFiles, gitIn, type OriginRepo, originRepo } from '../src/git-fixtures';

// Every test here runs git or agent processes, which take several times as long on a machine loaded by other suites.
setDefaultTimeout(30_000);

const origins: OriginRepo[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const origin of origins.splice(0)) origin.remove();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function origin(files: Record<string, string>): Promise<OriginRepo> {
  const made = await originRepo(files);
  origins.push(made);
  return made;
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agflow-gitfix-'));
  dirs.push(dir);
  return dir;
}

describe('originRepo', () => {
  test('makes a bare origin whose main holds the files', async () => {
    const repo = await origin({ 'README.md': '# demo\n', 'src/app.ts': 'export {};\n' });
    expect(await gitIn(repo.path, ['rev-parse', '--is-bare-repository'])).toBe('true');
    expect(await gitIn(repo.path, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/main');
    expect(await gitIn(repo.path, ['rev-parse', 'refs/heads/main'])).toBe(repo.mainSha);
    expect(repo.mainSha).toMatch(/^[0-9a-f]{40}$/);
    expect((await gitIn(repo.path, ['ls-tree', '-r', '--name-only', 'main'])).split('\n')).toEqual([
      'README.md',
      'src/app.ts',
    ]);
    expect(await gitIn(repo.path, ['show', 'main:src/app.ts'])).toBe('export {};');
  });

  test('remove() deletes the origin and its directory', async () => {
    const repo = await originRepo({ a: '1\n' });
    repo.remove();
    expect(await Bun.file(join(repo.path, 'HEAD')).exists()).toBe(false);
  });
});

describe('commitFiles', () => {
  test('writes, deletes and commits files on a new branch from main and pushes it', async () => {
    const repo = await origin({ 'a.txt': 'a\n', 'gone.txt': 'x\n' });
    const sha = await commitFiles(repo.path, {
      branch: 'agflow/T-1-feature',
      files: { 'a.txt': 'changed\n', 'gone.txt': null, 'deep/new.txt': 'new\n' },
      message: 'work on T-1',
    });
    expect(await gitIn(repo.path, ['rev-parse', 'refs/heads/agflow/T-1-feature'])).toBe(sha);
    expect(await gitIn(repo.path, ['rev-parse', `${sha}^`])).toBe(repo.mainSha);
    expect(await gitIn(repo.path, ['log', '-1', '--format=%s', sha])).toBe('work on T-1');
    expect((await gitIn(repo.path, ['ls-tree', '-r', '--name-only', sha])).split('\n')).toEqual([
      'a.txt',
      'deep/new.txt',
    ]);
    expect(await gitIn(repo.path, ['show', `${sha}:a.txt`])).toBe('changed');
    expect(await gitIn(repo.path, ['rev-parse', 'refs/heads/main'])).toBe(repo.mainSha);
  });

  test('builds on the tip of an existing branch', async () => {
    const repo = await origin({ 'a.txt': 'a\n' });
    const first = await commitFiles(repo.path, { branch: 'topic', files: { 'b.txt': 'b\n' } });
    const second = await commitFiles(repo.path, { branch: 'topic', files: { 'c.txt': 'c\n' } });
    expect(await gitIn(repo.path, ['rev-parse', `${second}^`])).toBe(first);
    expect((await gitIn(repo.path, ['ls-tree', '-r', '--name-only', second])).split('\n')).toEqual([
      'a.txt',
      'b.txt',
      'c.txt',
    ]);
  });

  test('can start a new branch from another commit and move main', async () => {
    const repo = await origin({ 'a.txt': 'a\n' });
    const topic = await commitFiles(repo.path, { branch: 'topic', files: { 'b.txt': 'b\n' } });
    const fork = await commitFiles(repo.path, { branch: 'fork', from: topic, files: { 'c.txt': 'c\n' } });
    expect(await gitIn(repo.path, ['rev-parse', `${fork}^`])).toBe(topic);
    const main = await commitFiles(repo.path, { branch: 'main', files: { 'a.txt': 'a2\n' } });
    expect(await gitIn(repo.path, ['rev-parse', 'refs/heads/main'])).toBe(main);
    expect(await gitIn(repo.path, ['rev-parse', `${main}^`])).toBe(repo.mainSha);
  });

  test('commits with the testkit identity', async () => {
    const repo = await origin({ 'a.txt': 'a\n' });
    expect(await gitIn(repo.path, ['log', '-1', '--format=%an <%ae>|%cn <%ce>', 'main'])).toBe(
      'agflow test <test@agflow.invalid>|agflow test <test@agflow.invalid>',
    );
  });
});

describe('gitIn', () => {
  test("runs git without the user's global or system config or inherited GIT_ variables", async () => {
    const repo = await origin({ 'a.txt': 'a\n' });
    const global = join(tempDir(), 'gitconfig');
    writeFileSync(global, '[core]\n\thooksPath = /planted-global\n');
    const system = join(tempDir(), 'system-gitconfig');
    writeFileSync(system, '[core]\n\thooksPath = /planted-system\n');
    const saved = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_DIR: process.env.GIT_DIR };
    process.env.GIT_CONFIG_GLOBAL = global;
    process.env.GIT_DIR = join(tempDir(), 'not-a-repo');
    try {
      expect(await gitIn(repo.path, ['config', '--get', 'core.hooksPath'], { allowFailure: true })).toBe('');
      // GIT_CONFIG_NOSYSTEM wins over a system file named by GIT_CONFIG_SYSTEM.
      expect(
        await gitIn(repo.path, ['config', '--get', 'core.hooksPath'], {
          env: { GIT_CONFIG_SYSTEM: system },
          allowFailure: true,
        }),
      ).toBe('');
      expect(await gitIn(repo.path, ['rev-parse', 'main'])).toBe(repo.mainSha);
      const scopes = await gitIn(repo.path, ['config', '--show-scope', '--list']);
      const outside = scopes.split('\n').filter((line) => !/^(local|command)\t/.test(line));
      expect(outside).toEqual([]);
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test("ignores the user's default ignore and attributes files under ~/.config/git", async () => {
    const repo = await origin({ 'a.txt': 'a\n' });
    const home = tempDir();
    mkdirSync(join(home, '.config', 'git'), { recursive: true });
    writeFileSync(join(home, '.config', 'git', 'ignore'), '.env\n.claude/.cc-writes/\n');
    writeFileSync(join(home, '.config', 'git', 'attributes'), '* planted=yes\n');
    const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
    process.env.HOME = home;
    delete process.env.XDG_CONFIG_HOME;
    try {
      const sha = await commitFiles(repo.path, {
        branch: 'topic',
        files: { '.env': 'SECRET=1\n', '.claude/.cc-writes/staged.json': '{}\n' },
      });
      expect((await gitIn(repo.path, ['ls-tree', '-r', '--name-only', sha])).split('\n')).toEqual([
        '.claude/.cc-writes/staged.json',
        '.env',
        'a.txt',
      ]);
      const work = tempDir();
      await gitIn(work, ['clone', '--quiet', repo.path, '.']);
      expect(await gitIn(work, ['check-attr', '-a', '--', 'a.txt'])).toBe('');
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test("throws with git's message on failure, unless failure is allowed", async () => {
    const dir = tempDir();
    await expect(gitIn(dir, ['rev-parse', 'HEAD'])).rejects.toThrow(
      /git rev-parse HEAD failed .*not a git repository/s,
    );
    expect(await gitIn(dir, ['rev-parse', 'HEAD'], { allowFailure: true })).toBe('');
  });

  test('passes stdin and extra environment variables', async () => {
    const repo = await origin({ 'a.txt': 'a\n' });
    expect(await gitIn(repo.path, ['hash-object', '--stdin'], { input: 'hello\n' })).toBe(
      'ce013625030ba8dba906f756967f9e9ca394464a',
    );
    expect(await gitIn(repo.path, ['var', 'GIT_AUTHOR_IDENT'], { env: { GIT_AUTHOR_NAME: 'Someone' } })).toMatch(
      /^Someone <test@agflow\.invalid>/,
    );
  });
});
