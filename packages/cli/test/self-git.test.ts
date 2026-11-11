import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGFLOW_VERSION } from '@agflow/core';
import { addExclude, defaultBranch, git, gitOk, isTracked, removeExclude, repoRoot } from '../src/git';
import { selfCommand, shellCommand, shellQuote } from '../src/self';
import { cloneOf, pushedRepo, run, tempRepo } from './fixture';

const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temporary.push(dir);
  return dir;
}

/**
 * A working directory an agent could have written: a bunfig.toml whose preload writes a marker, and a .env that sets
 * AGFLOW_SELF_PROBE.
 */
function plantedCwd(): { cwd: string; preloaded: () => boolean } {
  const cwd = tempDir('agflow-self-cwd-');
  const marker = join(cwd, 'preloaded');
  writeFileSync(join(cwd, 'preload.ts'), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\n`);
  writeFileSync(join(cwd, 'bunfig.toml'), 'preload = ["./preload.ts"]\n');
  writeFileSync(join(cwd, '.env'), 'AGFLOW_SELF_PROBE=from-dotenv\n');
  return { cwd, preloaded: () => existsSync(marker) };
}

/** Runs a command in cwd with the test's environment, AGFLOW_SELF_PROBE left out; gives its exit code and stdout. */
function runIn(cwd: string, argv: string[]): { code: number; stdout: string } {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'AGFLOW_SELF_PROBE',
    ),
  );
  const result = Bun.spawnSync(argv, { cwd, env, stdout: 'pipe', stderr: 'pipe' });
  return { code: result.exitCode, stdout: result.stdout.toString() };
}

describe('selfCommand', () => {
  test('runs main.ts with Bun when started from source, loading no bunfig.toml or .env from its working directory', () => {
    expect(selfCommand('/repo/packages/cli/src/self.ts', '/usr/local/bin/bun')).toEqual({
      command: '/usr/local/bin/bun',
      args: ['--no-env-file', '--config=/dev/null', '/repo/packages/cli/src/main.ts'],
    });
  });

  test("the source form never runs a working directory's bunfig.toml preload or reads its .env", () => {
    // A stand-in main.ts that prints what the .env would set, run as the source form runs agflow's.
    const dir = tempDir('agflow-self-main-');
    writeFileSync(join(dir, 'main.ts'), "process.stdout.write(process.env.AGFLOW_SELF_PROBE ?? 'unset');\n");
    const planted = plantedCwd();
    // Plain Bun in that directory runs the preload and reads the .env: the plants work.
    expect(runIn(planted.cwd, [process.execPath, join(dir, 'main.ts')]).stdout).toBe('from-dotenv');
    expect(planted.preloaded()).toBe(true);

    const clean = plantedCwd();
    const self = selfCommand(join(dir, 'self.ts'), process.execPath);
    expect(runIn(clean.cwd, [self.command, ...self.args])).toEqual({ code: 0, stdout: 'unset' });
    expect(clean.preloaded()).toBe(false);
    // agflow itself, started as selfCommand() starts it.
    const agflow = selfCommand();
    expect(runIn(clean.cwd, [agflow.command, ...agflow.args, 'version'])).toEqual({ code: 0, stdout: `${AGFLOW_VERSION}\n` });
    expect(clean.preloaded()).toBe(false);
  });

  test('build:cli compiles a binary that loads no bunfig.toml or .env from its working directory', () => {
    const root = join(import.meta.dir, '..', '..', '..');
    const { scripts } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    const build = (scripts['build:cli'] as string).split(' ');
    expect(build.slice(0, 3)).toEqual(['bun', 'build', '--compile']);
    expect(build).toContain('--no-compile-autoload-bunfig');
    expect(build).toContain('--no-compile-autoload-dotenv');
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
});

describe('defaultBranch', () => {
  const originHead = (root: string) => git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);

  test('is origin/HEAD when git clone set it, whatever branch is checked out', () => {
    const repo = pushedRepo('master');
    const clone = cloneOf(repo, 'clone');
    run(['git', 'checkout', '--quiet', '-b', 'feature'], clone);
    expect(originHead(clone).stdout).toBe('origin/master');
    expect(defaultBranch(clone)).toBe('master');
  });

  test('is what the remote reports when origin/HEAD is not set, as in a repository that was pushed rather than cloned', () => {
    const repo = pushedRepo('master');
    run(['git', 'checkout', '--quiet', '-b', 'feature'], repo.root);
    expect(originHead(repo.root).code).not.toBe(0);
    expect(defaultBranch(repo.root)).toBe('master');
  });

  test('is the checked-out branch when the remote cannot be asked', () => {
    const repo = pushedRepo('trunk');
    run(['git', 'remote', 'set-url', 'origin', join(repo.dir, 'gone.git')], repo.root);
    expect(defaultBranch(repo.root)).toBe('trunk');
  });

  test('is the checked-out branch when the remote reports no HEAD', () => {
    const repo = pushedRepo('trunk');
    // The origin's HEAD names a branch that it does not have, so `git ls-remote` has nothing to report.
    run(['git', 'symbolic-ref', 'HEAD', 'refs/heads/main'], repo.origin);
    expect(run(['git', 'ls-remote', '--symref', 'origin', 'HEAD'], repo.root)).toBe('');
    expect(defaultBranch(repo.root)).toBe('trunk');
  });

  test('is main only when nothing says otherwise', () => {
    const repo = pushedRepo('trunk');
    run(['git', 'remote', 'remove', 'origin'], repo.root);
    run(['git', 'checkout', '--quiet', '--detach'], repo.root);
    expect(defaultBranch(repo.root)).toBe('main');
  });

  test('never returns a name that git would read as an option', () => {
    // A remote can report any of its branches as its HEAD, and `git fetch origin -x` would take "-x" for a switch.
    const repo = pushedRepo('master');
    run(['git', 'push', '--quiet', 'origin', 'master:refs/heads/-x'], repo.root);
    run(['git', 'symbolic-ref', 'HEAD', 'refs/heads/-x'], repo.origin);
    expect(run(['git', 'ls-remote', '--symref', 'origin', 'HEAD'], repo.root)).toContain('ref: refs/heads/-x\tHEAD');
    expect(defaultBranch(repo.root)).toBe('master');
  });
});
