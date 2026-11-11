import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class GitError extends Error {
  override name = 'GitError';
}

/** Runs git with an argument vector (no shell). Credential prompts are disabled so calls never hang. */
export function git(cwd: string, args: string[]): GitResult {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return { code: result.exitCode, stdout: result.stdout.toString().trim(), stderr: result.stderr.toString().trim() };
}

export function gitOk(cwd: string, args: string[]): string {
  const result = git(cwd, args);
  if (result.code !== 0) throw new GitError(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

export function repoRoot(cwd: string): string | null {
  const result = git(cwd, ['rev-parse', '--show-toplevel']);
  return result.code === 0 ? result.stdout : null;
}

/** `origin/HEAD`, which `git clone` sets. A repository made with `git init` and pushed does not have it. */
function originHeadBranch(root: string): string | null {
  const result = git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  return result.code === 0 && result.stdout.startsWith('origin/') ? result.stdout.slice('origin/'.length) : null;
}

/** The branch the remote itself names as its HEAD. Null when it cannot be reached or has no HEAD to report. */
function remoteHeadBranch(root: string): string | null {
  const result = git(root, ['ls-remote', '--symref', 'origin', 'HEAD']);
  return result.code === 0 ? (result.stdout.match(/^ref: refs\/heads\/(\S+)\tHEAD$/m)?.[1] ?? null) : null;
}

/** The branch checked out in this working tree. Null when HEAD is detached. */
function currentBranch(root: string): string | null {
  const result = git(root, ['symbolic-ref', '--short', 'HEAD']);
  return result.code === 0 && result.stdout !== '' ? result.stdout : null;
}

/**
 * A name that is safe to hand to git as a branch. A remote reports its HEAD in its own words, and
 * `git fetch origin -x` reads "-x" as a switch, which is also a valid branch name for git.
 */
function isUsableBranch(root: string, name: string): boolean {
  return !name.startsWith('-') && git(root, ['check-ref-format', `refs/heads/${name}`]).code === 0;
}

/**
 * The branch that a task branch starts from, taken from the first of these that gives a usable name:
 * `origin/HEAD`; the remote's own HEAD; the branch checked out here; then `main`.
 */
export function defaultBranch(root: string): string {
  for (const find of [originHeadBranch, remoteHeadBranch, currentBranch]) {
    const name = find(root);
    if (name && isUsableBranch(root, name)) return name;
  }
  return 'main';
}

export function isTracked(root: string, path: string): boolean {
  return git(root, ['ls-files', '--error-unmatch', path]).code === 0;
}

function excludeFile(root: string): string {
  const path = gitOk(root, ['rev-parse', '--git-path', 'info/exclude']);
  return isAbsolute(path) ? path : join(root, path);
}

/** Adds a pattern to .git/info/exclude (local ignore rules that are never committed). */
export function addExclude(root: string, pattern: string): void {
  const file = excludeFile(root);
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (existing.split('\n').includes(pattern)) return;
  mkdirSync(dirname(file), { recursive: true });
  const separator = existing === '' || existing.endsWith('\n') ? '' : '\n';
  writeFileSync(file, `${existing}${separator}${pattern}\n`);
}

export function removeExclude(root: string, pattern: string): void {
  const file = excludeFile(root);
  if (!existsSync(file)) return;
  const kept = readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== pattern);
  writeFileSync(file, kept.join('\n'));
}
