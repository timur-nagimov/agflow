// Paths the Claude adapter shares between the guard, the sandbox settings and the transcripts (design 7.6): real
// paths, and the project directory Claude Code 2.1.285 keeps an attempt's transcripts and oversized tool output in.
import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

/** Past this length the CLI cuts the slug and appends a hash, which the runner does not reproduce. */
export const MAX_CLAUDE_PROJECT_SLUG = 200;

/** Symbolic links followed by hand before a path counts as a loop. */
const MAX_LINKS = 40;

/**
 * The real path of `path`, also when it does not exist yet: a missing path is its nearest existing parent's real path
 * plus the rest, and a dangling symlink is followed to where a write through it would land. On a case-insensitive
 * volume the existing part comes back in its on-disk case.
 */
export function realPathOf(path: string): string {
  return resolveReal(resolve(path), 0);
}

function resolveReal(path: string, links: number): string {
  if (links > MAX_LINKS) throw new Error(`too many symbolic links at ${path}`);
  try {
    return realpathSync.native(path);
  } catch {
    // Missing, a dangling link or a loop: walk it by hand below.
  }
  let link: string | null = null;
  try {
    if (lstatSync(path).isSymbolicLink()) link = readlinkSync(path);
  } catch {
    // The path itself is missing; its parent decides.
  }
  if (link !== null) return resolveReal(resolve(dirname(path), link), links + 1);
  const parent = dirname(path);
  if (parent === path) return path;
  return join(resolveReal(parent, links), basename(path));
}

/**
 * The name of a clone's project directory, as 2.1.285 forms it: the real path of its working directory with every
 * character other than A-Z, a-z and 0-9 replaced by '-'. Slugs longer than 200 characters are refused.
 */
export function claudeProjectSlug(clone: string): string {
  const real = realPathOf(clone);
  const slug = real.replace(/[^A-Za-z0-9]/g, '-');
  if (slug.length > MAX_CLAUDE_PROJECT_SLUG) {
    throw new Error(
      `the clone path ${real} gives a Claude project name of ${slug.length} characters; ` +
        `Claude Code shortens names over ${MAX_CLAUDE_PROJECT_SLUG} with a hash, so the runner refuses the clone`,
    );
  }
  return slug;
}

/** <CLAUDE_CONFIG_DIR>/projects/<slug>: the attempt's transcripts and the tool output the CLI persists. */
export function claudeProjectDir(claudeHome: string, clone: string): string {
  return join(claudeHome, 'projects', claudeProjectSlug(clone));
}
