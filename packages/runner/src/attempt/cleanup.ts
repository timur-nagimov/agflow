// cleanup_attempt and upload_transcript (design 6.4 Cleanup, 6.3, 7.8). A cleanup first stops a live process with the
// stop ladder (an accept or reject during a hold), then pushes the late work still pending (AttemptRecord.lateWorkSha)
// and saves the clone's work that is not yet on the origin to a new late-work ref, each reported as attempt.late_work,
// before anything is deleted: a late push that fails keeps the clone and answers the command with the reason. Then
// the transcript tail is uploaded, and the clone, the attempt's vault pins, its private /tmp/agf/<id> directory, its
// tools, quarantine and forensics directories and the vendor's transcript are removed, and the base checkout
// released. The record stays, with endedAt, the clone forgotten, so hello no longer lists the attempt (isCleanedUp).
// upload_transcript posts the tail of an attempt with no live session, for attempts the hub ended lost.
import { chmod, lstat, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { AttemptRecord } from '../attempt-store';

/** The reason a cleanup gives the stop of a process still alive. */
export const CLEANUP_STOP_REASON = 'the attempt is cleaned up';

/** What cleanup_attempt gives: done, or why the clone was kept (a late push that failed, say). */
export type CleanupOutcome = { ok: true } | { ok: false; error: string };

/** Whether cleanup_attempt has run for the record: hello no longer lists such an attempt. */
export function isCleanedUp(record: Pick<AttemptRecord, 'clone' | 'endedAt'>): boolean {
  return record.clone === null && record.endedAt !== null;
}

/** Makes every directory under dir writable again, never following a link, so its entries can be removed. */
async function makeWritable(dir: string): Promise<void> {
  await chmod(dir, 0o700).catch(() => {});
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isDirectory()) await makeWritable(join(dir, entry.name));
  }
}

/**
 * Removes a file tree the agent wrote, links as links. Directories it made read-only are made writable first, so
 * nothing is left behind; a path that does not exist is no error.
 */
export async function removeTree(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EACCES' && code !== 'EPERM' && code !== 'ENOTEMPTY') throw error;
    const stat = await lstat(path).catch(() => null);
    if (stat?.isDirectory()) await makeWritable(path);
    await rm(path, { recursive: true, force: true });
  }
}
