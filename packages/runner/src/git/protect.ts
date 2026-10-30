// Protected paths on the runner (design 7.3, X-16). The hub sends each attempt's restore set (AttemptSpec.restore):
// protected-class patterns with the task's exemptions applied. Paths are classified only with core's
// matchesProtectedPattern, case-insensitively, from git's -z output, and never with git pathspecs. Everything works
// through the vault with the local environment: restore checks files out into the clone with a temporary index and
// --work-tree, detection and strip read and build trees in the vault, and no git ever runs with the clone's .git.
// Restore, detection, strip and dependency preparation all use one base, resolveRestoreBase's.
import { lstat, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { type AttemptSpec, localPinRefs, matchesProtectedPattern } from '@agflow/core';
import { type GitEnvironment, RUN_DIR_EXCLUDE, runGit, WORKTREE_GIT_TIMEOUT_MS } from './run';
import { commitTree } from './snapshot';
import type { Vault } from './vault';

/** The vault, and the local environment its commands run with. */
export interface ProtectGit {
  vault: Vault;
  local: GitEnvironment;
}

/** A change between the base and a head to a path the restore set covers. */
export interface ProtectedChange {
  path: string;
  /** added: not in the base (strip removes it); modified or deleted: in the base (strip puts it back). */
  status: 'added' | 'modified' | 'deleted';
}

const SHA = /^[0-9a-f]{40}$/;
const NO_SHA = '0'.repeat(40);

/** The Claude CLI's untracked staging directory, whose contents are never a violation (X-28). */
const CC_WRITES = '.claude/.cc-writes/**';

/** Whether the restore set covers the path. */
function isProtected(path: string, patterns: readonly string[]): boolean {
  // Only paths inside the staging directory are exempt. git tracks no directories, so an entry at
  // .claude/.cc-writes itself is a file or a link planted in its place, and the pattern also covers a file standing
  // in for .claude, which both stay protected.
  const inStaging = path.split('/').filter(Boolean).length >= 3 && matchesProtectedPattern(path, CC_WRITES);
  if (inStaging) return false;
  return patterns.some((pattern) => matchesProtectedPattern(path, pattern));
}

/**
 * What restore never removes: the runner's own .agflow/run/, and the Claude CLI's staging directory while it is a
 * real directory, since a live CLI writes there. An entry above one of them is looked into instead of removed.
 */
const KEPT = ['.agflow/run', '.claude/.cc-writes'] as const;

function vaultGit(git: ProtectGit, args: string[], options: { input?: string; index?: string; check?: boolean } = {}) {
  return runGit(git.local, [`--git-dir=${git.vault.path}`, ...args], {
    input: options.input,
    env: options.index === undefined ? undefined : { GIT_INDEX_FILE: options.index },
    check: options.check,
  });
}

/** Runs fn with the path of a runner-owned temporary index, removed afterwards. */
async function withTempIndex<T>(fn: (index: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'agflow-protect-'));
  try {
    return await fn(join(dir, 'index'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Splits -z output into its entries. */
function entries(output: string): string[] {
  return output.split('\0').filter((entry) => entry !== '');
}

/** The best common ancestor of two commits in the vault; null when they share no history. */
export async function mergeBase(git: ProtectGit, a: string, b: string): Promise<string | null> {
  const result = await vaultGit(git, ['merge-base', a, b], { check: false });
  const sha = result.stdout.trim();
  return result.code === 0 && SHA.test(sha) ? sha : null;
}

/** The commit a ref names in the vault, or null. */
async function commitOf(git: ProtectGit, ref: string): Promise<string | null> {
  const result = await vaultGit(git, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { check: false });
  const sha = result.stdout.trim();
  return result.code === 0 && SHA.test(sha) ? sha : null;
}

/**
 * The one base of an attempt's protected paths (X-16): merge-base(restore.base, the start commit), what the branch
 * should contain, with restore.base (refs/heads/<main>) resolved in the vault after the pre-start fetch; the start
 * commit itself when restore.base is null. The start commit is the attempt's start pin, which the clone was made at
 * (and which a lead's fast-forward moves).
 */
export async function resolveRestoreBase(
  vault: Vault,
  spec: Pick<AttemptSpec, 'attemptId' | 'restore'>,
): Promise<string> {
  const git = { vault, local: vault.local };
  const pin = localPinRefs(spec.attemptId).start;
  const start = await commitOf(git, pin);
  if (start === null) throw new Error(`the vault has no start pin for ${spec.attemptId} (${pin})`);
  if (spec.restore.base === null) return start;
  const tip = await commitOf(git, spec.restore.base);
  if (tip === null) throw new Error(`the restore base ${spec.restore.base} is not in the vault`);
  const base = await mergeBase(git, tip, start);
  if (base === null) throw new Error(`${spec.restore.base} and the start ${start} share no history`);
  return base;
}

/**
 * The protected changes from base to head, from `diff --raw -z -M`: content, mode and type changes (a symlink
 * planted at a protected path included), additions, deletions, and both sides of a rename, so a rename out of a
 * protected directory counts as its deletion. Sorted by path.
 */
export async function detectProtected(
  git: ProtectGit,
  input: { base: string; head: string; paths: readonly string[] },
): Promise<ProtectedChange[]> {
  const raw = entries((await vaultGit(git, ['diff-tree', '-r', '-z', '--raw', '-M', input.base, input.head])).stdout);
  const changes = new Map<string, ProtectedChange['status']>();
  const note = (path: string, status: ProtectedChange['status']) => {
    if (isProtected(path, input.paths)) changes.set(path, status);
  };
  for (let i = 0; i < raw.length; i++) {
    // ":<old mode> <new mode> <old sha> <new sha> <status>", then the path, or both paths of a rename or copy.
    const status = (raw[i] ?? '').split(' ')[4] ?? '';
    const path = raw[++i] ?? '';
    if (status.startsWith('R') || status.startsWith('C')) {
      const to = raw[++i] ?? '';
      if (status.startsWith('R')) note(path, 'deleted');
      note(to, 'added');
    } else if (status === 'A') {
      note(path, 'added');
    } else if (status === 'D') {
      note(path, 'deleted');
    } else {
      note(path, 'modified');
    }
  }
  return [...changes]
    .map(([path, status]) => ({ path, status }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Removes the shell's last argument from its working directory, once that directory is known to lie inside the
 * clone (the first argument, its real path). The working directory is pinned when the shell starts, and rm never
 * follows a link below it, so a parent swapped for a link at any moment redirects nothing.
 */
const REMOVE_SCRIPT = 'case "$(pwd -P)/" in "$1"/*) exec /bin/rm -rf -- "./$2";; *) exit 3;; esac';

/**
 * Removes a path in the clone, never through a link: the removal runs in the path's parent directory, which must
 * still be inside the clone when it does. Gives false when there is nothing to remove; throws when it cannot.
 */
export async function removeInClone(root: string, clone: string, path: string): Promise<boolean> {
  const target = join(clone, path);
  if ((await lstat(target).catch(() => null)) === null) return false;
  let code: number;
  try {
    const proc = Bun.spawn(['/bin/sh', '-c', REMOVE_SCRIPT, 'sh', root, basename(target)], {
      cwd: dirname(target),
      env: { PATH: '/usr/bin:/bin' },
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    });
    code = await proc.exited;
  } catch (error) {
    throw new Error(`cannot remove ${path} from the clone: ${error instanceof Error ? error.message : error}`);
  }
  if (code === 3) throw new Error(`${path} is no longer inside the clone`);
  if (code !== 0) throw new Error(`cannot remove ${path} from the clone (exit ${code})`);
  return true;
}

/**
 * Removes a protected entry git listed as untracked, keeping what KEPT names: an entry above a kept path is looked
 * into, and each protected entry in it removed, so a wholly untracked .claude/ or .agflow/ (an embedded repository,
 * or an ignored directory git lists as one entry) loses everything but the kept path. Adds what it removed.
 */
async function removeEntry(
  target: { root: string; clone: string; paths: readonly string[] },
  path: string,
  removed: string[],
): Promise<void> {
  const folded = path.toLowerCase();
  const kept = KEPT.find((keep) => keep === folded || keep.startsWith(`${folded}/`));
  if (kept !== undefined) {
    const stat = await lstat(join(target.clone, path)).catch(() => null);
    // A file or link where a directory belongs is removed whole; .agflow/run is the runner's, whatever it is.
    if (stat !== null && (stat.isDirectory() || folded === '.agflow/run')) {
      if (kept === folded) return;
      for (const name of await readdir(join(target.clone, path))) {
        await removeEntry(target, `${path}/${name}`, removed);
      }
      return;
    }
  }
  if (!isProtected(path, target.paths)) return;
  if (await removeInClone(target.root, target.clone, path)) removed.push(path);
}

/**
 * Restore (design 7.3), before every start, resume, dependency preparation and take-over: the clone's files under
 * the restore set become the base's. Base files that differ or are missing are checked out from the base through
 * the vault and a temporary index; files there that the base lacks are deleted, whether added by the branch or
 * untracked, and ignored ones too, since the agent writes the ignore rules. A wholly ignored directory (node_modules)
 * is one entry, which no pattern covers. Other work is left as it is, and the clone's .git is never touched. Every
 * git that reads the work tree is bounded (WORKTREE_GIT_TIMEOUT_MS): a restore that cannot finish fails.
 */
export async function restoreProtected(
  git: ProtectGit,
  input: { clone: string; base: string; paths: readonly string[]; timeoutMs?: number },
): Promise<{ restored: string[]; removed: string[] }> {
  const { clone } = input;
  const root = await realpath(clone);
  return withTempIndex(async (index) => {
    const tree = (args: string[], options: { input?: string; check?: boolean } = {}) =>
      runGit(git.local, [`--git-dir=${git.vault.path}`, `--work-tree=${clone}`, ...args], {
        cwd: clone,
        env: { GIT_INDEX_FILE: index },
        timeoutMs: input.timeoutMs ?? WORKTREE_GIT_TIMEOUT_MS,
        ...options,
      });
    const scope = ['--', ':(top)', RUN_DIR_EXCLUDE];
    await tree(['read-tree', input.base]);
    // Records the files' stat data, so diff-files lists only real changes; it fails when a file differs.
    await tree(['update-index', '-q', '--refresh'], { check: false });
    const diff = await tree(['diff-files', '-z', '--name-only', '--ignore-submodules=all', ...scope]);
    const differs = entries(diff.stdout);
    const others = await tree(['ls-files', '-z', '--others', '--exclude-standard', ...scope]);
    const ignored = await tree(['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory', ...scope]);
    const restored = differs.filter((path) => isProtected(path, input.paths)).sort();
    // A directory listed as one entry ends in a slash: one holding its own repository, or a wholly ignored one.
    const untracked = new Set([...entries(others.stdout), ...entries(ignored.stdout)].map((p) => p.replace(/\/+$/, '')));
    const removed: string[] = [];
    for (const path of [...untracked].sort()) await removeEntry({ root, clone, paths: input.paths }, path, removed);
    if (restored.length > 0) {
      // Git replaces a link or directory in a file's way and never writes through a link.
      await tree(['checkout-index', '-f', '-z', '--stdin'], { input: restored.map((path) => `${path}\0`).join('') });
    }
    return { restored, removed: removed.sort() };
  });
}

/**
 * Strip (design 7.3): a commit on head whose tree is head's with every protected change undone: changed and
 * deleted paths get the base's entry back, added ones are removed. Built in the vault with a temporary index, with
 * no checkout and no hooks; the clone is not involved. Gives head itself when nothing is protected.
 */
export async function stripProtected(
  git: ProtectGit,
  input: {
    base: string;
    head: string;
    paths: readonly string[];
    identity: { name: string; email: string };
    now?: Date;
  },
): Promise<{ sha: string; stripped: string[] }> {
  const changes = await detectProtected(git, input);
  if (changes.length === 0) return { sha: input.head, stripped: [] };
  // The base's entries, as "<mode> <type> <sha>\t<path>".
  const baseEntries = new Map<string, string>();
  for (const line of entries((await vaultGit(git, ['ls-tree', '-r', '-z', '--full-tree', input.base])).stdout)) {
    const tab = line.indexOf('\t');
    const [mode, , sha] = line.slice(0, tab).split(' ');
    baseEntries.set(line.slice(tab + 1), `${mode} ${sha}`);
  }
  // Removals first, so a base file can come back where the head has a link or a file in its directory's place.
  const removals = changes.filter((change) => change.status === 'added').map((change) => `0 ${NO_SHA}\t${change.path}`);
  const restores = changes.flatMap((change) => {
    const entry = change.status === 'added' ? undefined : baseEntries.get(change.path);
    return entry === undefined ? [] : [`${entry}\t${change.path}`];
  });
  const tree = await withTempIndex(async (index) => {
    await vaultGit(git, ['read-tree', input.head], { index });
    const info = [...removals, ...restores].map((line) => `${line}\0`).join('');
    await vaultGit(git, ['update-index', '-z', '--index-info'], { index, input: info });
    return (await vaultGit(git, ['write-tree'], { index })).stdout.trim();
  });
  const sha = await commitTree({
    vault: git.vault,
    local: git.local,
    tree,
    parent: input.head,
    message: 'agflow: protected paths reverted to the base',
    identity: input.identity,
    now: input.now ?? new Date(),
  });
  return { sha, stripped: changes.map((change) => change.path) };
}
