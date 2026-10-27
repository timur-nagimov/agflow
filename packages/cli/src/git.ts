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

export function defaultBranch(root: string): string {
  const result = git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  return result.code === 0 && result.stdout.startsWith('origin/') ? result.stdout.slice('origin/'.length) : 'main';
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

export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug || 'task';
}
