// Where fetch_url may write (design 5, Unattended options). The bridge runs outside the vendor sandbox, with an agent
// in the clone that may be following a hostile page's instructions, so this file is the only thing between a download
// and the places the sandbox keeps the agent out of: everything outside the clone, the clone's .git (config and hooks
// run as the owner) and its .agflow (the runner's own tools and the bridge's configuration).
import { randomBytes } from 'node:crypto';
import { type Stats, closeSync, constants, lstatSync, mkdirSync, openSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { ToolError } from './tools';

/** The longest name a directory entry may have on the file systems runners use, in bytes. */
const NAME_MAX_BYTES = 255;

/**
 * Control characters (NUL among them), the line and paragraph separators and the invisible format characters. HFS+
 * ignores the zero-width ones when it compares names, so ".g<U+200C>it" is .git there; the others only disguise a name.
 */
const UNSAFE_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

const PROTECTED_NAMES: readonly string[] = ['.git', '.agflow'];

/**
 * A name as the most forgiving file system would compare it: macOS volumes ignore letter case and Unicode
 * normalization, so ".GIT" opens .git. Compatibility forms and combining marks are folded as well, which no volume
 * does: a name that only looks like a protected one is refused with it, at the cost of names nobody needs.
 */
const foldName = (name: string): string => name.normalize('NFKD').replace(/\p{M}/gu, '').toUpperCase().toLowerCase();

const isProtectedName = (name: string): boolean => PROTECTED_NAMES.includes(foldName(name));

const refuse = (saveAs: string, why: string): ToolError =>
  new ToolError(
    `save_as ${JSON.stringify(saveAs)} is refused: ${why}. Give a plain relative path inside your working directory, such as "docs/reference/page.html". Nothing was fetched or saved.`,
  );

/** One name of a path, on the rules every segment follows. Returns why it is refused, or null. */
function segmentProblem(segment: string): string | null {
  if (segment === '') return 'it has an empty segment (a leading, trailing or doubled "/")';
  if (segment === '.' || segment === '..') return `it has a "${segment}" segment`;
  if (segment.includes('/') || segment.includes('\\')) return 'it has a backslash or a slash inside a name';
  if (UNSAFE_CHARS.test(segment)) return 'it has a control character or an invisible character';
  if (Buffer.byteLength(segment) > NAME_MAX_BYTES) return 'one of its names is longer than 255 bytes';
  if (isProtectedName(segment)) return 'it names .git or .agflow, which agflow and git own, in whatever spelling and at whatever depth';
  return null;
}

/**
 * save_as as the names to walk, or a ToolError that says which rule it broke. The path is relative and normalized: no
 * absolute or home form, no empty, "." or ".." segment, no control or invisible character, and no segment that is .git
 * or .agflow in any letter case or Unicode form, as a directory or as the file itself.
 */
export function savePathSegments(saveAs: string): string[] {
  if (saveAs === '') throw refuse(saveAs, 'it is empty');
  // Named first: a path with a control character is not worth describing further.
  if (UNSAFE_CHARS.test(saveAs)) throw refuse(saveAs, 'it has a control character or an invisible character');
  if (saveAs.startsWith('/') || saveAs.startsWith('~') || isAbsolute(saveAs)) throw refuse(saveAs, 'it is not relative to your working directory');
  const segments = saveAs.split('/');
  for (const segment of segments) {
    const problem = segmentProblem(segment);
    if (problem) throw refuse(saveAs, problem);
  }
  return segments;
}

const sameFile = (a: Stats, b: Stats): boolean => a.dev === b.dev && a.ino === b.ino;

const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | null)?.code;

/** lstat of a name in the current directory; null when nothing has it. */
function entry(name: string): Stats | null {
  try {
    return lstatSync(name);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
}

/** Whether `path` is `root` or below it; both are real paths. */
function within(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/**
 * Steps from the current directory into `name`, creating it when it is missing. The directory entered is the one
 * lstat saw (the same device and inode), so a symbolic link is never followed, not even one swapped in between the
 * check and the step.
 */
function enter(name: string, shown: string): void {
  let seen = entry(name);
  if (!seen) {
    try {
      mkdirSync(name, { mode: 0o755 });
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
    }
    seen = entry(name);
  }
  if (!seen) throw new ToolError(`${shown} could not be created. Nothing was saved.`);
  if (seen.isSymbolicLink()) throw new ToolError(`${shown} is a symbolic link, and agflow never writes through one. Nothing was saved.`);
  if (!seen.isDirectory()) throw new ToolError(`${shown} is not a directory, so nothing can be saved below it. Nothing was saved.`);
  process.chdir(name);
  if (!sameFile(statSync('.'), seen)) {
    throw new ToolError(`${shown} changed while agflow was entering it, and agflow never writes through a symbolic link. Nothing was saved.`);
  }
}

/**
 * Writes `body` to the path `segments` name below `root`, the agent's working directory, and returns the real path
 * of the file. Missing directories are created one by one; an existing regular file is replaced.
 *
 * The walk moves this process's own current directory, one name at a time, and writes by bare names inside the last
 * one. A directory held as the current one stays the same directory whatever is renamed or linked above it, so nothing
 * the agent does to the tree meanwhile (it runs beside the bridge) can turn the write towards another place: checking
 * a path and then opening it by that path would leave that gap. Everything here is synchronous, so no other tool of the
 * bridge runs while the current directory is moved, and it is put back before this returns or throws.
 *
 * The body goes to a new temporary file, which is then renamed over the name: a symbolic link there is never written
 * through, and a hard link to a file elsewhere is replaced rather than written into.
 */
export function saveInside(root: string, segments: readonly string[], body: Uint8Array): string {
  if (segments.length === 0) throw new ToolError('There is no file name to save to. Nothing was saved.');
  // The names are checked here again: this function is the boundary, whoever calls it.
  for (const segment of segments) {
    const problem = segmentProblem(segment);
    if (problem) throw new ToolError(`The path ${JSON.stringify(segments.join('/'))} is refused: ${problem}. Nothing was saved.`);
  }
  if (!isAbsolute(root)) throw new ToolError(`The working directory ${JSON.stringify(root)} is not an absolute path. Nothing was saved.`);
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
    if (!statSync(realRoot).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new ToolError(`The working directory ${root} does not exist. Nothing was saved.`);
  }
  const directories = segments.slice(0, -1);
  const name = segments[segments.length - 1] as string;
  const shown = segments.join('/');
  const startedIn = process.cwd();
  try {
    process.chdir(realRoot);
    directories.forEach((directory, index) => enter(directory, segments.slice(0, index + 1).join('/')));
    // Where the walk really ended, by the file system's own account: inside the working directory, as deep as the
    // path says, and under no protected name in the spelling the volume keeps.
    const here = process.cwd();
    const real = relative(realRoot, here);
    const realNames = real === '' ? [] : real.split(sep);
    if (!within(here, realRoot) || realNames.length !== directories.length || realNames.some(isProtectedName)) {
      throw new ToolError(`${shown} does not stay inside your working directory. Nothing was saved.`);
    }
    const existing = entry(name);
    if (existing?.isSymbolicLink()) throw new ToolError(`${shown} is a symbolic link, and agflow never writes through one. Nothing was saved.`);
    if (existing?.isDirectory()) throw new ToolError(`${shown} is a directory. Give the name of a file inside it. Nothing was saved.`);
    if (existing && !existing.isFile()) throw new ToolError(`${shown} is not a regular file, so it is not replaced. Nothing was saved.`);
    const temporary = `.fetch-${randomBytes(12).toString('hex')}.tmp`;
    // O_EXCL refuses any existing name, a symbolic link included; O_NOFOLLOW says so twice.
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
    try {
      try {
        for (let written = 0; written < body.length; ) written += writeSync(fd, body, written, body.length - written);
      } finally {
        closeSync(fd);
      }
      // rename replaces the name itself: a link put there since the check is replaced, not followed.
      renameSync(temporary, name);
    } catch (error) {
      try {
        unlinkSync(temporary);
      } catch {
        // Already renamed or removed.
      }
      if (errorCode(error) === 'EISDIR' || errorCode(error) === 'ENOTDIR' || errorCode(error) === 'ENOTEMPTY') {
        throw new ToolError(`${shown} is a directory. Give the name of a file inside it. Nothing was saved.`);
      }
      throw error;
    }
    return join(here, name);
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw new ToolError(`${shown} could not be saved: ${error instanceof Error ? error.message : String(error)}. Nothing was saved.`);
  } finally {
    try {
      process.chdir(startedIn);
    } catch {
      // The directory the bridge started in is gone. No tool reads a relative path, so any directory does, and the
      // clone, where a bunfig.toml or a .env may lie, is not where the bridge stays.
      process.chdir('/');
    }
  }
}
