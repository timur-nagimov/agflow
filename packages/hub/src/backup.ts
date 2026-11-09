import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { HubContext } from './context';

export type BackupKind = 'hourly' | 'daily' | 'start';

/** The hourly snapshots cover the last 24 hours (design 6.14). */
const KEEP: Record<BackupKind, number> = { hourly: 24, daily: 7, start: 3 };

/** Finished snapshots only: temporary files and anything else in the folder are never counted or pruned. */
const SNAPSHOT: Record<BackupKind, RegExp> = {
  hourly: /^agflow-hourly-\d{4}-\d{2}-\d{2}T\d{2}\.db$/,
  daily: /^agflow-daily-\d{4}-\d{2}-\d{2}\.db$/,
  start: /^agflow-start-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.db$/,
};

function snapshotName(kind: BackupKind, now: number): string {
  const iso = new Date(now).toISOString();
  if (kind === 'hourly') return `agflow-hourly-${iso.slice(0, 13)}.db`;
  return kind === 'daily' ? `agflow-daily-${iso.slice(0, 10)}.db` : `agflow-start-${iso.replace(/[:.]/g, '-')}.db`;
}

/** A written snapshot, and how long VACUUM INTO took, in wall-clock ms. */
export interface Backup {
  file: string;
  durationMs: number;
}

export function checkIntegrity(ctx: Pick<HubContext, 'db'>): void {
  const row = ctx.db.query('PRAGMA integrity_check').get() as { integrity_check: string };
  if (row.integrity_check !== 'ok') throw new Error(`database integrity check failed: ${row.integrity_check}`);
}

/**
 * Writes a consistent snapshot with VACUUM INTO and keeps the newest 24 hourly, 7 daily and 3 start snapshots.
 * There is one hourly snapshot per UTC hour and one daily snapshot per UTC day; a later one replaces it.
 */
export function backupDatabase(ctx: HubContext, dir: string, kind: BackupKind): Backup {
  const started = performance.now();
  mkdirSync(dir, { recursive: true });
  const file = join(dir, snapshotName(kind, ctx.now()));
  // The snapshot only gets its name once complete. A leftover from an interrupted backup would make VACUUM INTO fail.
  const tmp = join(dir, `agflow-${kind}.tmp`);
  rmSync(tmp, { force: true });
  try {
    ctx.db.query('VACUUM INTO $file').run({ file: tmp });
    renameSync(tmp, file);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
  const snapshots = readdirSync(dir)
    .filter((name) => SNAPSHOT[kind].test(name))
    .sort();
  for (const name of snapshots.slice(0, Math.max(0, snapshots.length - KEEP[kind]))) rmSync(join(dir, name));
  return { file, durationMs: Math.round(performance.now() - started) };
}

/** Writes a snapshot and logs where and how long it took; a failure is logged, and the hub goes on. */
export function backupAndLog(ctx: HubContext, dir: string, kind: BackupKind): void {
  try {
    const { file, durationMs } = backupDatabase(ctx, dir, kind);
    console.log(`${kind} backup written to ${file} in ${durationMs} ms`);
  } catch (error) {
    console.error(`${kind} backup failed`, error);
  }
}

/** True until a daily snapshot exists for the current UTC day. */
export function dailyBackupDue(ctx: HubContext, dir: string): boolean {
  return !existsSync(join(dir, snapshotName('daily', ctx.now())));
}
