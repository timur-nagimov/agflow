// Harvest, steps 1-3 (design 7.3): the first half of every harvest (WIP, submit, stop, take-over, hand-back), with no
// git run in the clone. The clone's refs are read as plain files; its own objects are copied, as regular files with
// object names only, into a runner-owned bare quarantine that borrows the vault's objects; the vault then fetches
// the commits from the quarantine with transfer.fsckObjects, so index-pack recomputes every hash and the fetch checks
// connectivity. A malformed object, or one whose content does not match its name, fails the harvest instead of
// entering the vault. Only a commit becomes the head pin. The quarantine is always deleted.
import { constants, createWriteStream } from 'node:fs';
import { type FileHandle, lstat, mkdir, open, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { localPinRefs } from '@agflow/core';
import type { RunnerPaths } from '../paths';
import { readCloneHead, readCloneRef } from './clone';
import { GitError, type GitEnvironment, runGit } from './run';
import type { Vault } from './vault';

/** The most a harvest copies from a clone's .git/objects: 200 MB. */
export const QUARANTINE_LIMIT_BYTES = 200 * 1024 * 1024;

/**
 * The longest the fetch from the quarantine may take. The limit above counts compressed bytes, and an agent can
 * craft objects that inflate a thousandfold, so a pathological pack fails the harvest instead of hanging it.
 */
export const HARVEST_FETCH_TIMEOUT_MS = 120_000;

export class HarvestError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'HarvestError';
  }
}

export interface CloneRefs {
  /** The commit the harvest continues from: the task branch's tip, or HEAD's commit when the branch is gone. */
  head: string;
  /**
   * HEAD's commit when it is elsewhere (another branch, or detached): harvested too, and warned about. ref is null
   * for a detached HEAD, and for a branch name git itself would refuse.
   */
  other: { ref: string | null; sha: string } | null;
  warnings: string[];
}

export interface HarvestResult extends CloneRefs {
  /** What was copied into the quarantine; nothing when the vault already held every commit. */
  copied: { files: number; bytes: number };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The longest ref name git accepts on this filesystem. */
const REF_NAME_MAX_BYTES = 255;

/**
 * Whether git's check-ref-format would accept the name: HEAD's ref comes from a file the agent writes, so a name
 * that fails is never repeated in a warning, which agent text would otherwise reach as runner text.
 */
export function isValidRefName(ref: string): boolean {
  if (Buffer.byteLength(ref) > REF_NAME_MAX_BYTES || !ref.startsWith('refs/')) return false;
  if (/[\u0000- \u007f ~^:?*[\\]/.test(ref) || ref.includes('..') || ref.includes('@{')) return false;
  if (ref.endsWith('/') || ref.endsWith('.')) return false;
  return ref.split('/').every((part) => part !== '' && !part.startsWith('.') && !part.endsWith('.lock'));
}

/**
 * Step 1: <clone>/.git/HEAD and the task branch, read as files (loose ref or packed-refs), 40 hex only. A HEAD on
 * another branch or detached elsewhere is reported as `other`, with a warning. HEAD is an extra: when the branch
 * reads fine, a HEAD that cannot be read is only a warning. Throws a HarvestError when neither gives a commit.
 */
export async function readCloneRefs(clone: string, branch: string): Promise<CloneRefs> {
  const ref = `refs/heads/${branch}`;
  let branchSha: string | null = null;
  let branchError: unknown = null;
  try {
    branchSha = await readCloneRef(clone, ref);
  } catch (error) {
    branchError = error;
  }
  let head: { ref: string | null; sha: string | null } = { ref: null, sha: null };
  let headError: unknown = null;
  try {
    head = await readCloneHead(clone);
  } catch (error) {
    headError = error;
  }
  const warnings: string[] = [];
  if (branchSha === null) {
    if (head.sha === null) {
      if (branchError !== null) {
        throw new HarvestError(`cannot read the refs of ${clone}: ${describe(branchError)}`, { cause: branchError });
      }
      throw new HarvestError(`${clone} has neither ${JSON.stringify(branch)} nor a HEAD commit to harvest`);
    }
    const why = branchError === null ? 'is missing' : `cannot be read (${JSON.stringify(describe(branchError))})`;
    warnings.push(`the clone's branch ${JSON.stringify(branch)} ${why}; harvested HEAD at ${head.sha} instead`);
    return { head: head.sha, other: null, warnings };
  }
  if (headError !== null) {
    const why = JSON.stringify(describe(headError));
    warnings.push(`HEAD cannot be read, so only ${JSON.stringify(branch)} was harvested: ${why}`);
    return { head: branchSha, other: null, warnings };
  }
  if (head.ref === ref || head.sha === null || head.sha === branchSha) {
    return { head: branchSha, other: null, warnings };
  }
  const headRef = head.ref !== null && isValidRefName(head.ref) ? head.ref : null;
  warnings.push(
    head.ref === null
      ? `HEAD is detached at ${head.sha}, not on ${JSON.stringify(branch)}; that commit is harvested too`
      : headRef === null
        ? `HEAD names an invalid ref, not ${JSON.stringify(branch)}; its tip ${head.sha} is harvested too`
        : `HEAD names ${JSON.stringify(headRef)}, not ${JSON.stringify(branch)}; its tip ${head.sha} is harvested too`,
  );
  return { head: branchSha, other: { ref: headRef, sha: head.sha }, warnings };
}

const LOOSE_DIR = /^[0-9a-f]{2}$/;
const LOOSE_FILE = /^[0-9a-f]{38}$/;
const PACK_FILE = /^pack-(?:[0-9a-f]{40}|[0-9a-f]{64})\.(?:pack|idx)$/;

/**
 * macOS's O_NOFOLLOW_ANY, which Node does not export: no link anywhere in the path is followed. macOS refuses it
 * together with O_NOFOLLOW, so it takes O_NOFOLLOW's place there.
 */
const O_NOFOLLOW_ANY = process.platform === 'darwin' ? 0x20000000 : 0;
/** The open flag that refuses links: anywhere in the path on macOS, the last component elsewhere. */
export const NO_LINKS = O_NOFOLLOW_ANY !== 0 ? O_NOFOLLOW_ANY : constants.O_NOFOLLOW;

/** A directory, never through a link. */
async function realDirectory(path: string): Promise<boolean> {
  const stat = await lstat(path).catch(() => null);
  return stat?.isDirectory() ?? false;
}

/**
 * Opens <objects>/<relative> for reading with no link followed anywhere in the path, so a directory the agent swaps
 * for a link after the listing is refused rather than read through. Gives null for a link or a missing file.
 * objects must be a real path.
 */
export async function openObjectFile(objects: string, relative: string): Promise<FileHandle | null> {
  try {
    return await open(join(objects, relative), constants.O_RDONLY | constants.O_NONBLOCK | NO_LINKS);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
}

/** The clone's .git/objects is the agent's to break: a read that fails there fails the harvest, not the runner. */
async function fromClone<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof HarvestError) throw error;
    throw new HarvestError(`cannot copy the clone's objects: ${describe(error)}`, { cause: error });
  }
}

/**
 * Step 2's copy: the regular files under the clone's .git/objects named like loose objects (xx/<38 hex>) or packs
 * (pack/pack-<hex>.{pack,idx}), at most limitBytes in all. Links and every other file are skipped. The clone's path
 * is resolved once; its directory is runner-owned, so the agent cannot swap it, and below it every file is opened
 * with no link followed. Gives the copied paths, relative to the objects directory.
 */
export async function copyCloneObjects(
  clone: string,
  target: string,
  limitBytes: number,
): Promise<{ files: string[]; bytes: number }> {
  const gitDir = join(await fromClone(() => realpath(clone)), '.git');
  const objects = join(gitDir, 'objects');
  if (!(await realDirectory(gitDir)) || !(await realDirectory(objects))) {
    throw new HarvestError(`${objects} is not a directory`);
  }
  const wanted: string[] = [];
  for (const entry of await fromClone(() => readdir(objects, { withFileTypes: true }))) {
    if (!entry.isDirectory()) continue;
    const pattern = LOOSE_DIR.test(entry.name) ? LOOSE_FILE : entry.name === 'pack' ? PACK_FILE : null;
    if (pattern === null) continue;
    // A listing taken through a link swapped in meanwhile only yields names, which are opened in the real clone.
    for (const file of await fromClone(() => readdir(join(objects, entry.name), { withFileTypes: true }))) {
      if (file.isFile() && pattern.test(file.name)) wanted.push(`${entry.name}/${file.name}`);
    }
  }
  const copied: string[] = [];
  let bytes = 0;
  for (const relative of wanted) {
    const handle = await fromClone(() => openObjectFile(objects, relative));
    if (handle === null) continue;
    try {
      const stat = await fromClone(() => handle.stat());
      if (!stat.isFile() || stat.size === 0) continue;
      if (bytes + stat.size > limitBytes) {
        throw new HarvestError(`the clone's objects come to more than ${limitBytes} bytes; nothing was harvested`);
      }
      const destination = join(target, relative);
      await mkdir(join(destination, '..'), { recursive: true });
      // Only the size seen above, so a file the agent is still writing cannot pass the limit.
      const source = handle.createReadStream({ start: 0, end: stat.size - 1, autoClose: false });
      let readFailed = false;
      source.once('error', () => {
        readFailed = true;
      });
      try {
        await pipeline(source, createWriteStream(destination, { flags: 'wx' }));
      } catch (error) {
        if (readFailed) throw new HarvestError(`cannot copy the clone's objects: ${describe(error)}`, { cause: error });
        throw error;
      }
      bytes += stat.size;
      copied.push(relative);
    } finally {
      await handle.close();
    }
  }
  return { files: copied, bytes };
}

export interface HarvestInput {
  vault: Vault;
  /** The local environment, localGitEnv(paths). */
  local: GitEnvironment;
  paths: Pick<RunnerPaths, 'quarantine'>;
  clone: string;
  attemptId: string;
  /** The task branch, AttemptSpec.branch. */
  branch: string;
  /** QUARANTINE_LIMIT_BYTES by default. */
  limitBytes?: number;
}

/** The harvest running for each quarantine path: harvests of one attempt share it, so they take turns. */
const running = new Map<string, Promise<void>>();

async function inTurn<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = running.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => mine);
  running.set(key, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (running.get(key) === tail) running.delete(key);
  }
}

/**
 * Steps 1-3: reads the clone's refs, and brings their commits into the vault, the head at
 * refs/agflow-local/<attempt>/head. HEAD's commit elsewhere is fetched too, with no ref of its own: the head pin and
 * the vault's consolidation keep its objects while the clone exists. Throws a HarvestError when the clone's refs or
 * objects are unreadable, too large, refused by the fetch or not a commit; the head pin does not move then. HEAD's
 * other commit never fails the harvest: what goes wrong with it is a warning. Harvests of one attempt take turns,
 * each reading the refs only once the previous one is done.
 */
export function harvestCommits(input: HarvestInput): Promise<HarvestResult> {
  const quarantine = input.paths.quarantine(input.vault.project, input.attemptId);
  return inTurn(quarantine, () => harvestOnce(input, quarantine));
}

async function harvestOnce(input: HarvestInput, quarantine: string): Promise<HarvestResult> {
  const { vault, local, clone } = input;
  const refs = await readCloneRefs(clone, input.branch);
  const warnings = [...refs.warnings];
  let other = refs.other;
  const vaultGit = (args: string[], options: { input?: string; check?: boolean; timeoutMs?: number } = {}) =>
    runGit(local, [`--git-dir=${vault.path}`, ...args], options);
  const typeOf = async (sha: string) => {
    const result = await vaultGit(['cat-file', '-t', sha], { check: false });
    return result.code === 0 ? result.stdout.trim() : null;
  };
  const notCommit = (sha: string, type: string) =>
    `the clone's ${sha} is a ${JSON.stringify(type)}, not a commit; nothing was harvested`;

  // A held object that is no commit (a tree or a tag the agent wrote into the branch file) fails before anything
  // moves; HEAD's other commit is only dropped.
  const headType = await typeOf(refs.head);
  if (headType !== null && headType !== 'commit') throw new HarvestError(notCommit(refs.head, headType));
  const otherType = other === null ? null : await typeOf(other.sha);
  if (other !== null && otherType !== null && otherType !== 'commit') {
    warnings.push(`HEAD's ${other.sha} is a ${JSON.stringify(otherType)}, not a commit, and was not harvested`);
    other = null;
  }
  const missing: string[] = [];
  if (headType === null) missing.push(refs.head);
  if (other !== null && otherType === null) missing.push(other.sha);
  let copied = { files: 0, bytes: 0 };
  if (missing.length > 0) {
    try {
      await rm(quarantine, { recursive: true, force: true });
      await mkdir(join(quarantine, '..'), { recursive: true });
      await runGit(local, ['init', '--quiet', '--bare', '--template=', quarantine]);
      await mkdir(join(quarantine, 'objects', 'info'), { recursive: true });
      await writeFile(join(quarantine, 'objects', 'info', 'alternates'), `${join(vault.path, 'objects')}\n`);
      const limit = input.limitBytes ?? QUARANTINE_LIMIT_BYTES;
      const files = await copyCloneObjects(clone, join(quarantine, 'objects'), limit);
      copied = { files: files.files.length, bytes: files.bytes };
      // Objects only, with no ref moved, so the vault's lock is not held while index-pack works through them.
      const fetch = async (shas: string[]) => {
        const args = ['-c', 'transfer.fsckObjects=true', 'fetch', '--quiet', '--no-tags', '--no-write-fetch-head'];
        try {
          await vaultGit([...args, quarantine, ...shas], { timeoutMs: HARVEST_FETCH_TIMEOUT_MS });
        } catch (error) {
          if (!(error instanceof GitError)) throw error;
          throw new HarvestError(`the vault refused the clone's commits: ${error.message}`, { cause: error });
        }
      };
      try {
        await fetch(missing);
      } catch (error) {
        const skipped = other?.sha;
        if (!(error instanceof HarvestError) || skipped === undefined || !missing.includes(skipped)) throw error;
        const cause = error.cause as GitError;
        warnings.push(`HEAD's ${skipped} could not be harvested: ${cause.stderr.trim() || cause.message}`);
        other = null;
        const rest = missing.filter((sha) => sha !== skipped);
        if (rest.length > 0) await fetch(rest);
      }
    } finally {
      await rm(quarantine, { recursive: true, force: true });
    }
  }
  const pin = localPinRefs(input.attemptId).head;
  await vault.withLock(async () => {
    const type = await typeOf(refs.head);
    if (type !== 'commit') throw new HarvestError(notCommit(refs.head, type ?? 'missing object'));
    await vaultGit(['update-ref', '--stdin'], { input: `update ${pin} ${refs.head}\n` });
  });
  return { head: refs.head, other, warnings, copied };
}
