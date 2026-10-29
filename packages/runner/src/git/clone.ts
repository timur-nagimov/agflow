// Attempt clones (design 7.3, 6.11). Each attempt works in a standalone `git clone --shared --no-checkout` of the
// vault: it borrows the vault's objects, and its origin is the vault path, so the agent's fetches never leave the
// laptop. The runner makes the clone with the local environment before hand-over: the task branch checked out at
// the start commit (a lead's clone detached at main), .agflow/run/ excluded from the agent's git, and the start
// pinned in the vault. From hand-over on, the clone and its .git are the agent's and untrusted: the runner reads
// its refs as plain files and works on its files only through the vault, with --work-tree and a temporary index,
// writing .git/HEAD and .git/index back as files.
import { randomUUID } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import { copyFile, type FileHandle, lstat, mkdir, mkdtemp, open, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { type GitEnvironment, gitOk, RUN_DIR_EXCLUDE, runGit } from './run';
import type { Vault } from './vault';

const SHA = /^[0-9a-f]{40}$/;

/** The largest packed-refs file read; an agent can make it any size. */
const PACKED_REFS_MAX_BYTES = 16 * 1024 * 1024;

export interface CloneTarget {
  vault: Vault;
  /** The local environment, localGitEnv(paths). */
  local: GitEnvironment;
  attemptId: string;
  /** paths.clone(project, attemptId). */
  clone: string;
}

export interface CloneResult {
  /** false when the clone already existed; it is never recreated. */
  created: boolean;
}

/** HEAD as the clone's files say: the branch it names, if any, and the commit it resolves to, if any. */
export interface CloneHead {
  ref: string | null;
  sha: string | null;
}

export type FastForwardResult =
  | { moved: true; from: string; to: string }
  | {
      moved: false;
      /** dirty: changed or untracked files; not_fast_forward: HEAD names a branch, or main does not descend from it. */
      reason: 'up_to_date' | 'dirty' | 'not_fast_forward';
      sha: string;
    };

/** A clone appears in its place only once it is complete, so its directory existing means it is there. */
export function cloneExists(clone: string): boolean {
  return existsSync(clone);
}

/** A task clone on its branch at the start commit. An existing clone is kept as it is. */
export function createTaskClone(target: CloneTarget & { branch: string; startSha: string }): Promise<CloneResult> {
  return create(target, target.startSha, ['--no-track', '-B', target.branch, target.startSha]);
}

/** A lead's clone, detached at main (startSha), with no task branch. An existing clone is kept as it is. */
export function createLeadClone(target: CloneTarget & { startSha: string }): Promise<CloneResult> {
  return create(target, target.startSha, ['--detach', target.startSha]);
}

async function create(target: CloneTarget, startSha: string, checkout: string[]): Promise<CloneResult> {
  const { vault, local, clone, attemptId } = target;
  if (!SHA.test(startSha)) throw new Error(`not a commit sha: ${JSON.stringify(startSha)}`);
  if (cloneExists(clone)) return { created: false };
  // Built beside its place and renamed into it, so a runner that dies halfway leaves no clone that looks complete.
  const building = join(dirname(clone), `.${basename(clone)}.creating`);
  await rm(building, { recursive: true, force: true });
  await mkdir(dirname(clone), { recursive: true });
  try {
    // No template: the clone gets no sample hooks and no info/ of git's own.
    await runGit(local, ['clone', '--quiet', '--shared', '--no-checkout', '--template=', vault.path, building]);
    const self = [`--git-dir=${join(building, '.git')}`, `--work-tree=${building}`];
    await runGit(local, [...self, 'checkout', '--quiet', ...checkout], { cwd: building });
    await mkdir(join(building, '.git', 'info'), { recursive: true });
    await writeFile(join(building, '.git', 'info', 'exclude'), '# Written by the agflow runner.\n/.agflow/run/\n');
    await vault.pin(attemptId, { start: startSha });
    await rename(building, clone);
  } catch (error) {
    await rm(building, { recursive: true, force: true });
    throw error;
  }
  return { created: true };
}

/** The clone's .git, which must be a real directory: a .git file or link could point the runner anywhere. */
async function gitDirOf(clone: string): Promise<string> {
  const gitDir = join(clone, '.git');
  const stat = await lstat(gitDir);
  if (!stat.isDirectory()) throw new Error(`${gitDir} is not a directory`);
  return gitDir;
}

/**
 * Reads an open file whose fstat gave size, refusing it when more arrives: the agent may append to a file while the
 * runner reads it, and reading to the end would let it pass any limit.
 */
export async function readSized(handle: FileHandle, size: number, path: string): Promise<string> {
  const buffer = Buffer.alloc(size + 1);
  let length = 0;
  while (length < buffer.length) {
    const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
    if (bytesRead === 0) break;
    length += bytesRead;
  }
  if (length > size) throw new Error(`${path} changed while it was read`);
  return buffer.toString('utf8', 0, length);
}

/**
 * Reads a file under the clone's .git without following a symlink anywhere on the way. Gives null when it does not
 * exist.
 */
async function readGitFile(clone: string, relative: string, maxBytes: number): Promise<string | null> {
  let path = await gitDirOf(clone);
  const parts = relative.split('/');
  for (const part of parts.slice(0, -1)) {
    path = join(path, part);
    const stat = await lstat(path).catch(() => null);
    if (stat === null) return null;
    if (!stat.isDirectory()) throw new Error(`${path} is not a directory`);
  }
  path = join(path, parts.at(-1) as string);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    if (code === 'ELOOP') throw new Error(`${path} is a symbolic link`);
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`${path} is not a regular file`);
    if (stat.size > maxBytes) throw new Error(`${path} is larger than ${maxBytes} bytes`);
    return await readSized(handle, stat.size, path);
  } finally {
    await handle.close();
  }
}

/** A ref name the clone's files may hold: refs/..., with no empty, dot-leading or traversing component. */
function checkRefName(ref: string): void {
  const parts = ref.split('/');
  if (parts[0] !== 'refs' || parts.length < 2 || parts.some((part) => part === '' || part.startsWith('.'))) {
    throw new Error(`not a ref the runner reads: ${JSON.stringify(ref)}`);
  }
}

function commitSha(value: string, where: string): string {
  const sha = value.trim();
  if (!SHA.test(sha)) throw new Error(`${where} is not a commit sha: ${JSON.stringify(value.slice(0, 80))}`);
  return sha;
}

/**
 * The commit a ref of the clone names, read from its loose ref file or else from packed-refs, as plain files. Only
 * 40 hex is accepted, never a symbolic value. Gives null when the clone has no such ref.
 */
export async function readCloneRef(clone: string, ref: string): Promise<string | null> {
  checkRefName(ref);
  const loose = await readGitFile(clone, ref, 4096);
  if (loose !== null) return commitSha(loose, ref);
  const packed = await readGitFile(clone, 'packed-refs', PACKED_REFS_MAX_BYTES);
  if (packed === null) return null;
  for (const line of packed.split('\n')) {
    if (line.startsWith('#') || line.startsWith('^')) continue;
    const space = line.indexOf(' ');
    if (space > 0 && line.slice(space + 1).trimEnd() === ref) {
      return commitSha(line.slice(0, space), `${ref} in packed-refs`);
    }
  }
  return null;
}

/** The clone's HEAD, read as a file: a commit sha (detached), or `ref: <branch>` resolved through readCloneRef. */
export async function readCloneHead(clone: string): Promise<CloneHead> {
  const head = await readGitFile(clone, 'HEAD', 4096);
  if (head === null) throw new Error(`${clone} has no .git/HEAD`);
  const text = head.trim();
  if (text.startsWith('ref:')) {
    const ref = text.slice(4).trim();
    return { ref, sha: await readCloneRef(clone, ref) };
  }
  return { ref: null, sha: commitSha(text, 'HEAD') };
}

/** Runs fn with the path of a runner-owned temporary index, removed afterwards. */
async function withTempIndex<T>(fn: (index: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'agflow-index-'));
  try {
    return await fn(join(dir, 'index'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Local git on the vault, with the clone as its work tree and the temporary index. */
function worktreeGit(input: { vault: Vault; local: GitEnvironment; clone: string }, index: string) {
  return (args: string[]) =>
    runGit(input.local, [`--git-dir=${input.vault.path}`, `--work-tree=${input.clone}`, ...args], {
      cwd: input.clone,
      env: { GIT_INDEX_FILE: index },
      check: false,
    });
}

/**
 * Whether the work tree matches the commit the index was read from: no changed or deleted tracked file, and no
 * untracked file outside the ignore rules and the runner's exclusions.
 */
async function matchesIndex(git: ReturnType<typeof worktreeGit>): Promise<boolean> {
  // refresh records the files' stat data, hashing only what changed, and writes no object.
  if ((await git(['update-index', '-q', '--refresh'])).code !== 0) return false;
  // A gitlink is compared with the nested HEAD, read as a file: looking for changes inside the nested repository
  // would start git there, with that repository's config, which the agent wrote (its filter drivers, say). The flag
  // also overrides any submodule.<name>.ignore in an agent-written .gitmodules.
  if ((await git(['diff-files', '--quiet', '--ignore-submodules=dirty'])).code !== 0) return false;
  const untracked = await git(['ls-files', '-z', '--others', '--exclude-standard', '--', ':(top)', RUN_DIR_EXCLUDE]);
  return untracked.code === 0 && untracked.stdout === '';
}

/** Reads the commit into the temporary index and compares the work tree with it. */
async function matchesCommit(git: ReturnType<typeof worktreeGit>, sha: string): Promise<boolean> {
  return (await git(['read-tree', sha])).code === 0 && matchesIndex(git);
}

/**
 * Whether the clone's files equal its HEAD (read as a file), compared through the vault: no git runs with the
 * clone's .git. A HEAD the vault does not hold (commits not harvested yet) is not clean.
 */
export async function isWorktreeClean(input: { vault: Vault; local: GitEnvironment; clone: string }): Promise<boolean> {
  const head = await readCloneHead(input.clone);
  if (head.sha === null || !(await input.vault.hasCommit(head.sha))) return false;
  const sha = head.sha;
  return withTempIndex((index) => matchesCommit(worktreeGit(input, index), sha));
}

/**
 * Replaces a file in the clone's .git by renaming a new one over it, so a link planted in its place is replaced, not
 * written through. The new file has a random name and is created exclusively, so nothing planted at that name is
 * followed or stands in the way.
 */
async function replaceGitFile(gitDir: string, name: string, write: (path: string) => Promise<void>): Promise<void> {
  const fresh = join(gitDir, `${name}.agflow-${randomUUID()}`);
  try {
    await write(fresh);
    await rename(fresh, join(gitDir, name));
  } catch (error) {
    await rm(fresh, { force: true });
    throw error;
  }
}

/**
 * resume_attempt for a lead (design 7.3): moves a clean clone detached at an older main to the vault's main. The
 * files change through the vault with a two-tree read-tree; .git/index and .git/HEAD are then written as files and
 * the start pin moves along. A dirty clone, or one main does not fast-forward, is left as it is. A move that a crash
 * or a failure cut short after the files changed (files at main, HEAD and index still at the old commit) is
 * finished.
 */
export async function fastForwardLeadClone(target: CloneTarget): Promise<FastForwardResult> {
  const { vault, local, clone, attemptId } = target;
  const head = await readCloneHead(clone);
  if (head.sha === null) throw new Error(`the HEAD of ${clone} names no commit`);
  const from = head.sha;
  const main = (await vault.resolveStart({ ref: `refs/heads/${vault.mainBranch}`, sha: null })).sha;
  if (main === from) return { moved: false, reason: 'up_to_date', sha: from };
  const fastForward =
    head.ref === null &&
    (await vault.hasCommit(from)) &&
    (await gitOk(local, [`--git-dir=${vault.path}`, 'merge-base', '--is-ancestor', from, main]));
  if (!fastForward) return { moved: false, reason: 'not_fast_forward', sha: from };
  return withTempIndex(async (index): Promise<FastForwardResult> => {
    const git = worktreeGit(target, index);
    if (await matchesCommit(git, from)) {
      const moved = await git(['read-tree', '-m', '-u', from, main]);
      if (moved.code !== 0) throw new Error(`cannot move ${clone} to ${main}: ${moved.stderr.trim()}`);
    } else if (!(await matchesCommit(git, main))) {
      return { moved: false, reason: 'dirty', sha: from };
    }
    const gitDir = await gitDirOf(clone);
    await replaceGitFile(gitDir, 'index', (path) => copyFile(index, path, constants.COPYFILE_EXCL));
    await replaceGitFile(gitDir, 'HEAD', (path) => writeFile(path, `${main}\n`, { flag: 'wx' }));
    await vault.pin(attemptId, { start: main });
    return { moved: true, from, to: main };
  });
}
