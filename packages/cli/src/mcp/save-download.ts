// Where fetch_url saves what the hub downloaded (design 10): inside the agent's working directory and nowhere else.
// The bridge runs outside the agent's sandbox, as the laptop's owner, and what it writes is data from a site nobody
// here controls, at a path the agent chose. So the path is a relative, normalized one that names neither .git nor
// .agflow, and the write never follows a symbolic link.
//
// The agent can change its directory while the bridge works, so a check of a path followed by a write to that path
// could be raced: a directory checked a moment ago may be a link to ~/Library by the time the file is opened. The
// save therefore walks down from the working directory one segment at a time with chdir, which holds each directory
// itself rather than a path to it, checks after every step that it stands in the directory it looked at, and then
// creates and renames the file by its bare name. A directory can only be swapped for another the agent may write.
import { randomBytes } from 'node:crypto';
import { type BigIntStats, closeSync, constants, lstatSync, mkdirSync, openSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { matchesProtectedPattern } from '@agflow/core';

/** A save_as the bridge refuses; the message tells the agent what to change. */
export class SavePathError extends Error {
  override name = 'SavePathError';
}

/** Git's own directory and agflow's: the runner works from both, outside the sandbox. */
const KEPT_OUT = ['.git', '.agflow'] as const;

/** Characters HFS+ ignores in a name, so that ".g<zero width joiner>it" is ".git" there. */
const IGNORED_IN_NAMES = /[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g;
const CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]/u;
/** The longest file name macOS and Linux file systems take, in bytes. */
const NAME_MAX = 255;

/**
 * The segments of a save_as, or a SavePathError: relative, written without "." or empty segments, with no ".."
 * segment, and with no segment that is .git or .agflow in any case a file system would fold into them.
 */
export function checkSavePath(saveAs: string): string[] {
  if (saveAs === '') throw new SavePathError('save_as is empty; name a file inside your working directory, such as data/page.html');
  if (saveAs.startsWith('/')) throw new SavePathError('save_as must be a relative path inside your working directory, not an absolute one');
  if (CONTROL.test(saveAs) || saveAs.includes('\\')) {
    throw new SavePathError('save_as must not contain control characters, line breaks or backslashes');
  }
  const segments = saveAs.split('/');
  for (const segment of segments) {
    if (segment === '..') throw new SavePathError('save_as must not contain a ".." segment; it names a file inside your working directory');
    if (segment === '' || segment === '.') {
      throw new SavePathError('save_as must be a plain path such as data/page.html: no "." segments, no doubled or trailing slashes');
    }
    if (Buffer.byteLength(segment) > NAME_MAX) throw new SavePathError('a name in save_as is longer than 255 bytes');
  }
  const plain = saveAs.replace(IGNORED_IN_NAMES, '');
  for (const kept of KEPT_OUT) {
    if (matchesProtectedPattern(plain, kept)) {
      throw new SavePathError(`save_as must not name ${kept} or anything under it; choose another place in your working directory`);
    }
  }
  return segments;
}

const look = (path: string): BigIntStats | undefined => lstatSync(path, { bigint: true, throwIfNoEntry: false });
const same = (a: BigIntStats, b: BigIntStats): boolean => a.dev === b.dev && a.ino === b.ino;

/**
 * Writes the bytes to save_as inside root and answers the path. Missing directories are created. An existing file,
 * a symbolic link at the file's own name included, is replaced by a new file, never written through. Throws
 * SavePathError for a path the rules refuse and for a symbolic link, a file in the way of a directory or a directory
 * in the way of the file. Synchronous from the first chdir to the last, so nothing else in the process ever runs in
 * another working directory.
 */
export function saveInside(root: string, saveAs: string, bytes: Uint8Array): string {
  const parents = checkSavePath(saveAs);
  const name = parents.pop() as string;
  const realRoot = realpathSync(root);
  const original = process.cwd();
  process.chdir(realRoot);
  try {
    // The working directory's own .git and .agflow, whatever name a path reaches them by.
    const keptOut = KEPT_OUT.flatMap((kept) => look(kept) ?? []);
    const refuseKeptOut = (entry: BigIntStats): void => {
      if (keptOut.some((kept) => same(kept, entry))) throw new SavePathError('save_as leads into .git or .agflow; choose another place');
    };
    let walked = '';
    for (const segment of parents) {
      walked = walked === '' ? segment : `${walked}/${segment}`;
      let entry = look(segment);
      if (!entry) {
        // Created in the directory the process stands in, which was checked; a name that appeared meanwhile is looked at.
        try {
          mkdirSync(segment);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
        entry = look(segment);
      }
      if (!entry) throw new SavePathError(`${walked} could not be created`);
      if (entry.isSymbolicLink()) throw new SavePathError(`${walked} is a symbolic link; fetch_url does not write through links`);
      if (!entry.isDirectory()) throw new SavePathError(`${walked} is not a directory, so nothing can be saved under it`);
      refuseKeptOut(entry);
      process.chdir(segment);
      // The name may have been swapped for a link between the look and the step: the directory reached must be the one seen.
      if (!same(statSync('.', { bigint: true }), entry)) {
        throw new SavePathError(`${walked} became a symbolic link while it was opened; fetch_url does not write through links`);
      }
    }
    const existing = look(name);
    if (existing?.isDirectory()) throw new SavePathError(`${saveAs} is a directory; name a file`);
    if (existing) refuseKeptOut(existing);
    // A new file under a name of its own, then renamed over the target: a link or a hard link there is replaced.
    const temporary = `.agflow-fetch-${randomBytes(8).toString('hex')}.tmp`;
    try {
      const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
      try {
        for (let written = 0; written < bytes.length; ) written += writeSync(fd, bytes, written);
      } finally {
        closeSync(fd);
      }
      renameSync(temporary, name);
    } catch (error) {
      try {
        unlinkSync(temporary);
      } catch {
        // Nothing was created, or the rename had already moved it.
      }
      if ((error as NodeJS.ErrnoException).code === 'EISDIR') throw new SavePathError(`${saveAs} is a directory; name a file`);
      throw error;
    }
    return saveAs;
  } finally {
    process.chdir(original);
  }
}
