import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { addExclude, defaultBranch, git, gitOk, isTracked, removeExclude, repoRoot, slugify } from '../src/git';
import { selfCommand, shellCommand, shellQuote } from '../src/self';
import { run, tempRepo } from './fixture';

describe('selfCommand', () => {
  test('runs main.ts with Bun when started from source', () => {
    expect(selfCommand('/repo/packages/cli/src/self.ts', '/usr/local/bin/bun')).toEqual({
      command: '/usr/local/bin/bun',
      args: ['/repo/packages/cli/src/main.ts'],
    });
  });

  test('runs the binary itself when compiled', () => {
    expect(selfCommand('/$bunfs/root/agflow', '/Users/a/.local/bin/agflow')).toEqual({
      command: '/Users/a/.local/bin/agflow',
      args: [],
    });
  });

  test('shell quoting leaves safe words alone and quotes the rest', () => {
    expect(shellQuote('/usr/bin/bun')).toBe('/usr/bin/bun');
    expect(shellQuote('/My Apps/agflow')).toBe("'/My Apps/agflow'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(shellCommand(['a b', 'c'])).toBe("'a b' c");
  });
});

describe('git helpers', () => {
  test('finds the repository root and the default branch', () => {
    const repo = tempRepo();
    mkdirSync(join(repo.root, 'src'));
    expect(repoRoot(join(repo.root, 'src'))).toBe(repo.root);
    expect(repoRoot(repo.dir)).toBeNull();
    expect(defaultBranch(repo.root)).toBe('main');
  });

  test('knows which files are tracked', () => {
    const repo = tempRepo();
    writeFileSync(join(repo.root, 'local.txt'), 'x');
    expect(isTracked(repo.root, 'README.md')).toBe(true);
    expect(isTracked(repo.root, 'local.txt')).toBe(false);
  });

  test('exclude entries are added once and can be removed', () => {
    const repo = tempRepo();
    addExclude(repo.root, '.worktrees/');
    addExclude(repo.root, '.worktrees/');
    const file = join(repo.root, '.git', 'info', 'exclude');
    expect(readFileSync(file, 'utf8').split('\n').filter((line) => line === '.worktrees/')).toHaveLength(1);
    removeExclude(repo.root, '.worktrees/');
    expect(readFileSync(file, 'utf8')).not.toContain('.worktrees/');
  });

  test('git returns failures and gitOk throws them', () => {
    const repo = tempRepo();
    expect(git(repo.root, ['rev-parse', '--verify', '--quiet', 'refs/heads/nope']).code).not.toBe(0);
    expect(() => gitOk(repo.root, ['checkout', 'nope'])).toThrow('git checkout nope failed');
    expect(gitOk(repo.root, ['rev-parse', 'HEAD'])).toBe(run(['git', 'rev-parse', 'HEAD'], repo.root));
  });

  test('slugify makes short branch-safe names', () => {
    expect(slugify('Add OAuth 2.0 login (GitHub)!')).toBe('add-oauth-2-0-login-github');
    expect(slugify('***')).toBe('task');
    expect(slugify('x'.repeat(80))).toHaveLength(40);
  });
});
