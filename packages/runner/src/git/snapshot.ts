// Harvest, step 4 (design 7.3): the clone's uncommitted work becomes one commit on the harvested head, still with no
// git run in the clone. A runner-owned temporary index reads the head, and git lists the work tree's changes through
// the vault with the clone as its work tree, so only the vault's configuration and the local environment apply: no
// filter driver, fsmonitor or hook of the agent's runs, and .gitattributes can only name drivers that are not
// defined. git never opens a listed file: the runner opens each one itself, refusing links (anywhere in the path on
// macOS; on Linux the opened file must lie inside the clone), and feeds the bytes of the file it actually opened to
// one `git fast-import`. So an agent process that swaps a file for a link between the checks and the read gets
// nothing from outside the clone into the vault. Symlinks are stored as links, their text read with readlink. Files
// over 10 MB are skipped and listed. A directory holding its own .git never becomes a gitlink: git lists the names
// of its working files, honouring its .gitignore files, and they are captured under its path like any other. A
// gitlink the head already holds is left as it is and never looked into, since git would look for changes there by
// running git with the nested repository's config. Every git that reads the work tree is bounded: a FIFO planted
// where git probes for a repository would otherwise block it for good.
import { constants } from 'node:fs';
import { type FileHandle, lstat, mkdtemp, open, readFile, readlink, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { HarvestError, NO_LINKS } from './harvest';
import { type GitEnvironment, GitError, RUN_DIR_EXCLUDE, runGit, WORKTREE_GIT_TIMEOUT_MS } from './run';
import type { Vault } from './vault';

/** Files larger than this are left out of a snapshot and listed: 10 MB. */
export const SNAPSHOT_FILE_LIMIT_BYTES = 10 * 1024 * 1024;

export interface SnapshotInput {
  vault: Vault;
  /** The local environment, localGitEnv(paths). */
  local: GitEnvironment;
  clone: string;
  /** The harvested head (HarvestResult.head), which the vault holds. */
  head: string;
  /** The snapshot commit's author and committer: runner.json's commitIdentity. */
  identity: { name: string; email: string };
  /** The snapshot's time; now by default. */
  now?: Date;
  /** SNAPSHOT_FILE_LIMIT_BYTES by default. */
  limitBytes?: number;
  /** The bound of each git that reads the work tree; WORKTREE_GIT_TIMEOUT_MS by default. */
  timeoutMs?: number;
  /** Runs once the work tree's files are listed, before any is read: tests use it to move files in between. */
  afterListing?(): Promise<void>;
}

export interface SnapshotResult {
  /** The snapshot commit, or the head itself when the clone holds no uncommitted work. */
  sha: string;
  changed: boolean;
  /** Files over the limit, left out (a tracked one keeps the head's version), relative to the clone. */
  skipped: string[];
  /** Embedded repositories captured as ordinary files, relative to the clone. */
  embedded: string[];
}

/** Splits -z output into its entries. */
function entries(output: string): string[] {
  return output.split('\0').filter((entry) => entry !== '');
}

/** The runner's own directory: never captured, whatever repository lists it. */
function inRunDir(path: string): boolean {
  return path === '.agflow/run' || path.startsWith('.agflow/run/');
}

interface Capture {
  vault: Vault;
  local: GitEnvironment;
  clone: string;
  /** The clone's real path: every file is read under it, and every embedded repository must lie inside it. */
  root: string;
  limitBytes: number;
  timeoutMs: number;
  skipped: string[];
  embedded: string[];
}

/** git in the vault with the work tree given, a temporary index and the work-tree bound. */
function treeGit(capture: Capture, workTree: string, index: string) {
  return (args: string[], options: { input?: string; check?: boolean } = {}) =>
    runGit(capture.local, [`--git-dir=${capture.vault.path}`, `--work-tree=${workTree}`, ...args], {
      cwd: workTree,
      env: { GIT_INDEX_FILE: index },
      timeoutMs: capture.timeoutMs,
      ...options,
    });
}

/**
 * The names of an embedded repository's working files, relative to the clone, with those of repositories nested in
 * it: git lists them on an empty index with the nested work tree, honouring its ignore rules. Only names are taken
 * here; the runner reads the files itself later, refusing any path beyond a link.
 */
async function embeddedNames(capture: Capture, prefix: string, dir: string): Promise<string[]> {
  const path = join(capture.clone, prefix);
  // The agent may have swapped the directory for a link since git listed it: nothing outside the clone is listed.
  const stat = await lstat(path);
  const real = await realpath(path);
  if (!stat.isDirectory() || !real.startsWith(capture.root + sep)) {
    throw new HarvestError(`${prefix.slice(0, -1)} changed while the snapshot was taken`);
  }
  capture.embedded.push(prefix.slice(0, -1));
  const listed = await treeGit(capture, path, join(dir, `nested-${capture.embedded.length}`))([
    'ls-files',
    '-z',
    '--others',
    '--exclude-standard',
    '--',
    ':(top)',
  ]);
  const names: string[] = [];
  for (const entry of entries(listed.stdout)) {
    const name = prefix + entry;
    if (inRunDir(name.replace(/\/$/, ''))) continue;
    if (name.endsWith('/')) names.push(...(await embeddedNames(capture, name, dir)));
    else names.push(name);
  }
  return names;
}

/** Whether a component above the path is no real directory now: a link, a file, or gone. */
async function beyondLink(root: string, path: string, directories: Map<string, boolean>): Promise<boolean> {
  const parts = path.split('/');
  for (let i = 1; i < parts.length; i++) {
    const dir = parts.slice(0, i).join('/');
    let real = directories.get(dir);
    if (real === undefined) {
      real = (await lstat(join(root, dir)).catch(() => null))?.isDirectory() ?? false;
      directories.set(dir, real);
    }
    if (!real) return true;
  }
  return false;
}

/** What one listed path holds, as the snapshot takes it. */
type Entry =
  /** Gone, a directory now, beyond a link, or neither a file nor a link: out of the index. */
  | { kind: 'absent' }
  /** A file over the limit: left out, a tracked one keeping the head's version. */
  | { kind: 'large' }
  | { kind: 'blob'; mode: '100644' | '100755' | '120000'; data: Buffer };

/** Whether an open file lies inside the clone: on Linux, where only the last component refuses links. */
async function openedInside(handle: FileHandle, root: string): Promise<boolean> {
  if (process.platform !== 'linux') return true;
  const real = await realpath(`/proc/self/fd/${handle.fd}`).catch(() => null);
  return real !== null && real.startsWith(root + sep);
}

/** Reads up to size bytes of an open file: what an agent appends meanwhile is not taken. */
async function readUpTo(handle: FileHandle, size: number): Promise<Buffer> {
  const buffer = Buffer.alloc(size);
  let length = 0;
  while (length < size) {
    const { bytesRead } = await handle.read(buffer, length, size - length, length);
    if (bytesRead === 0) break;
    length += bytesRead;
  }
  return buffer.subarray(0, length);
}

/** How often a path that changes while it is read is read again before the snapshot fails. */
const READ_TRIES = 3;

/**
 * Reads one listed path the way no swap can turn into a read outside the clone: the file is opened with links
 * refused, and only what that descriptor holds is taken; a link is read as its text. Gives 'changed' when the path
 * changed between the steps.
 */
async function readOnce(capture: Capture, path: string): Promise<Entry | 'changed'> {
  // A path whose directory became a link is not captured through it; the link is listed itself.
  if (await beyondLink(capture.root, path, new Map())) return { kind: 'absent' };
  const full = join(capture.root, path);
  let handle: FileHandle;
  try {
    handle = await open(full, constants.O_RDONLY | constants.O_NONBLOCK | NO_LINKS);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'absent' };
    if (code !== 'ELOOP') throw error;
    // A link: its own text, never what it points at. A directory above it swapped meanwhile is not read through.
    if (await beyondLink(capture.root, path, new Map())) return { kind: 'absent' };
    try {
      return { kind: 'blob', mode: '120000', data: await readlink(full, { encoding: 'buffer' }) };
    } catch (linkError) {
      const linkCode = (linkError as NodeJS.ErrnoException).code;
      // No longer a link (EINVAL), or gone.
      if (linkCode === 'EINVAL' || linkCode === 'ENOENT') return 'changed';
      throw linkError;
    }
  }
  try {
    const stat = await handle.stat();
    // A tracked file replaced by a directory, whose files are listed as untracked; a FIFO, socket or device.
    if (!stat.isFile()) return { kind: 'absent' };
    if (!(await openedInside(handle, capture.root))) return 'changed';
    if (stat.size > capture.limitBytes) return { kind: 'large' };
    const mode = (stat.mode & 0o100) !== 0 ? '100755' : '100644';
    return { kind: 'blob', mode, data: await readUpTo(handle, stat.size) };
  } finally {
    await handle.close();
  }
}

/** readOnce, again while the path keeps changing under it, up to READ_TRIES. */
async function readEntry(capture: Capture, path: string): Promise<Entry> {
  for (let tries = 1; ; tries++) {
    const entry = await readOnce(capture, path);
    if (entry !== 'changed') return entry;
    if (tries === READ_TRIES) throw new HarvestError(`${path} kept changing while the snapshot was taken`);
  }
}

/**
 * Writes blobs into the vault through one `git fast-import`, fed on its stdin, so git reads no file of the clone.
 * finish() gives each blob's sha by its mark.
 */
class BlobWriter {
  private readonly args: string[];
  private readonly proc: Bun.Subprocess<'pipe', 'pipe', 'pipe'>;
  private readonly output: Promise<[string, string]>;
  private readonly timer: ReturnType<typeof setTimeout>;
  private timedOut = false;
  private marks = 0;

  constructor(
    private readonly capture: Capture,
    private readonly marksFile: string,
  ) {
    this.args = [`--git-dir=${capture.vault.path}`, 'fast-import', '--quiet', `--export-marks=${marksFile}`];
    this.proc = Bun.spawn(['git', ...capture.local.args, ...this.args], {
      cwd: '/',
      env: capture.local.env,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      detached: true,
    });
    this.output = Promise.all([new Response(this.proc.stdout).text(), new Response(this.proc.stderr).text()]);
    this.timer = setTimeout(() => {
      this.timedOut = true;
      try {
        process.kill(-this.proc.pid, 'SIGKILL');
      } catch {
        this.proc.kill('SIGKILL');
      }
    }, capture.timeoutMs);
  }

  /** Writes one blob; gives its mark. */
  async add(data: Buffer): Promise<number> {
    this.marks += 1;
    const { stdin } = this.proc;
    stdin.write(`blob\nmark :${this.marks}\ndata ${data.length}\n`);
    stdin.write(data);
    stdin.write('\n');
    await stdin.flush();
    return this.marks;
  }

  /** Ends the import; gives the shas by mark. Throws a GitError when git failed. */
  async finish(): Promise<Map<number, string>> {
    try {
      await this.proc.stdin.end();
    } catch {
      // git is gone: its exit says why.
    }
    const code = await this.proc.exited;
    clearTimeout(this.timer);
    const [, stderr] = await this.output;
    if (code !== 0 || this.timedOut) {
      throw new GitError(this.args, code, stderr, this.timedOut, this.capture.timeoutMs);
    }
    const shas = new Map<number, string>();
    if (this.marks === 0) return shas;
    for (const line of (await readFile(this.marksFile, 'utf8')).split('\n')) {
      const [mark, sha] = line.split(' ');
      if (mark?.startsWith(':') && sha !== undefined) shas.set(Number(mark.slice(1)), sha);
    }
    return shas;
  }

  /** Kills git, when the snapshot fails before finish. */
  abort(): void {
    clearTimeout(this.timer);
    try {
      process.kill(-this.proc.pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

/**
 * Captures the clone's work tree into a tree object of the vault, on top of the head. Gives the tree's sha.
 *
 * git lists the changed and untracked files rather than taking them in with `add -A` and exclude pathspecs: add
 * fails on any pathspec at or under an ignored directory, which the agent's .gitignore decides, and it would open
 * the files itself. The index is then written with `update-index --index-info` from blobs the runner read.
 */
async function captureTree(capture: Capture, head: string, afterListing?: () => Promise<void>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agflow-snapshot-'));
  let writer: BlobWriter | null = null;
  try {
    const git = treeGit(capture, capture.clone, join(dir, 'index'));
    const scope = ['--', ':(top)', RUN_DIR_EXCLUDE];
    await git(['read-tree', head]);
    // Records the files' stat data, hashing what changed, so that diff-files lists only real changes. It fails when
    // a file differs, which is what the snapshot is for.
    await git(['update-index', '-q', '--refresh'], { check: false });
    // Gitlinks are left out: looking for changes in them would run git with the nested repository's config.
    const changed = entries((await git(['diff-files', '-z', '--name-only', '--ignore-submodules=all', ...scope])).stdout);
    const untracked = entries((await git(['ls-files', '-z', '--others', '--exclude-standard', ...scope])).stdout);
    const candidates = [...changed];
    for (const entry of untracked) {
      // git lists a directory holding its own repository as "<dir>/" and does not look inside.
      if (entry.endsWith('/')) candidates.push(...(await embeddedNames(capture, entry, dir)));
      else candidates.push(entry);
    }
    await afterListing?.();
    const removals: string[] = [];
    const blobs: { path: string; mode: string; mark: number }[] = [];
    for (const path of new Set(candidates)) {
      const entry = await readEntry(capture, path);
      if (entry.kind === 'absent') removals.push(path);
      else if (entry.kind === 'large') capture.skipped.push(path);
      else {
        writer ??= new BlobWriter(capture, join(dir, 'marks'));
        blobs.push({ path, mode: entry.mode, mark: await writer.add(entry.data) });
      }
    }
    const shas = writer === null ? new Map<number, string>() : await writer.finish();
    writer = null;
    if (removals.length > 0) {
      const zero = '0'.repeat(40);
      await git(['update-index', '-z', '--index-info'], { input: removals.map((path) => `0 ${zero}\t${path}\0`).join('') });
    }
    if (blobs.length > 0) {
      const lines = blobs.map(({ path, mode, mark }) => {
        const sha = shas.get(mark);
        if (sha === undefined) throw new HarvestError(`git stored no blob for ${path}`);
        return `${mode} ${sha}\t${path}\0`;
      });
      // --replace: a file where the head has a directory, or the other way round, takes its place.
      await git(['update-index', '-z', '--replace', '--index-info'], { input: lines.join('') });
    }
    return (await git(['write-tree'])).stdout.trim();
  } finally {
    writer?.abort();
    await rm(dir, { recursive: true, force: true });
  }
}

/** A runner-made commit in the vault on one parent, by the given identity at the given time. Gives its sha. */
export async function commitTree(input: {
  vault: Vault;
  local: GitEnvironment;
  tree: string;
  parent: string;
  message: string;
  identity: { name: string; email: string };
  now: Date;
}): Promise<string> {
  const date = `@${Math.floor(input.now.getTime() / 1000)} +0000`;
  const { name, email } = input.identity;
  const args = [`--git-dir=${input.vault.path}`, 'commit-tree', input.tree, '-p', input.parent, '-m', input.message];
  const commit = await runGit(input.local, args, {
    env: {
      GIT_AUTHOR_NAME: name,
      GIT_AUTHOR_EMAIL: email,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_NAME: name,
      GIT_COMMITTER_EMAIL: email,
      GIT_COMMITTER_DATE: date,
    },
  });
  return commit.stdout.trim();
}

/**
 * Step 4: a commit 'agflow: uncommitted work at <time>' whose parent is the head, holding the clone's files; the
 * head itself when they equal it. The clone, its index and its .git are never written. Throws a HarvestError when
 * git cannot read the files.
 */
export async function snapshotWork(input: SnapshotInput): Promise<SnapshotResult> {
  const { vault, local, clone, head } = input;
  try {
    const capture: Capture = {
      vault,
      // Tracked links are compared as links, whatever the vault's config says.
      local: { ...local, args: [...local.args, '-c', 'core.symlinks=true'] },
      clone,
      root: await realpath(clone),
      limitBytes: input.limitBytes ?? SNAPSHOT_FILE_LIMIT_BYTES,
      timeoutMs: input.timeoutMs ?? WORKTREE_GIT_TIMEOUT_MS,
      skipped: [],
      embedded: [],
    };
    const tree = await captureTree(capture, head, input.afterListing);
    const headTree = (await runGit(local, [`--git-dir=${vault.path}`, 'rev-parse', `${head}^{tree}`])).stdout.trim();
    const result = { skipped: capture.skipped.sort(), embedded: capture.embedded.sort() };
    if (tree === headTree) return { sha: head, changed: false, ...result };
    const now = input.now ?? new Date();
    const message = `agflow: uncommitted work at ${now.toISOString()}`;
    const sha = await commitTree({ vault, local, tree, parent: head, message, identity: input.identity, now });
    return { sha, changed: true, ...result };
  } catch (error) {
    if (error instanceof GitError) {
      throw new HarvestError(`cannot snapshot the uncommitted work in ${clone}: ${error.message}`, { cause: error });
    }
    throw error;
  }
}
