// The restore command (design 6.14): `bun run restore <backup>` (bun packages/hub/src/restore.ts <backup>), run while
// the hub is stopped, on the database AGFLOW_DB names. It swaps the backup in and gives the restored hub a new epoch,
// so that nothing it creates collides with what existed after the backup was taken. What the hub then does when each
// runner comes back is in recovery.ts and gateway.ts.
import { Database } from 'bun:sqlite';
import { copyFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { checkIntegrity } from './backup';
import { databasePath } from './config';
import { migrate } from './db';
import { insertEvent } from './events';
import { acquireDbLock, releaseDbLock } from './recovery';

/** How far the id counters jump, so that ids handed out after the backup are not handed out again. */
export const COUNTER_ADVANCE = 1000;

/** The counters of the ids people and runners keep: tasks, agents, runners, lead attempts and submissions. */
const ADVANCED_COUNTERS = ['task', 'agent', 'runner', 'lead_attempt', 'submission'];

/**
 * The AUTOINCREMENT ids clients and runners keep as cursors: event ids (Last-Event-ID, the bridge's after) and message
 * ids (attempt.delivered, attempt.acknowledged). A cursor the old hub handed out must not name a new row.
 */
const SEQUENCED_TABLES = ['events', 'messages'] as const;

/** The newest id of each sequenced table. */
export type LastIds = Record<(typeof SEQUENCED_TABLES)[number], number>;

/** How far those ids jump when the replaced database cannot be read, so its newest ids are unknown. */
export const UNKNOWN_IDS_ADVANCE = 1_000_000;

/** The files SQLite keeps for one database. */
const DB_FILES = ['', '-wal', '-shm'];

export interface RestoreInput {
  /** The database to replace; it need not exist. */
  dbPath: string;
  backupPath: string;
  /** Epoch ms; Date.now() by default. */
  now?: number | undefined;
}

export interface RestoreResult {
  /** The restored hub's epoch. */
  epoch: number;
  /** Where the replaced database went, with -wal and -shm beside it when it had them; null when there was none. */
  aside: string | null;
}

function lastIds(db: Database): LastIds {
  const last = (table: string): number =>
    (
      db
        .query(
          `SELECT MAX(COALESCE((SELECT MAX(id) FROM ${table}), 0),
                      COALESCE((SELECT seq FROM sqlite_sequence WHERE name = $table), 0)) AS id`,
        )
        .get({ table }) as { id: number }
    ).id;
  return { events: last('events'), messages: last('messages') };
}

/** What the restore needs from the database it replaces: its epoch and newest ids, or null when it cannot be read. */
function readReplaced(path: string): { epoch: number; lastIds: LastIds } | null {
  if (!existsSync(path)) return null;
  try {
    const db = new Database(path, { readonly: true });
    try {
      const row = db.query('SELECT epoch FROM project WHERE id = 1').get() as { epoch: number } | null;
      return row ? { epoch: row.epoch, lastIds: lastIds(db) } : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** The epoch an earlier restore recorded in the backup folder, or null. */
function recordedEpoch(file: string): number | null {
  try {
    const text = readFileSync(file, 'utf8').trim();
    return /^[1-9][0-9]*$/.test(text) ? Number(text) : null;
  } catch {
    return null;
  }
}

/** Moves the database's files from one name to another, those it has. */
function moveFiles(from: string, to: string): void {
  for (const suffix of DB_FILES) {
    if (existsSync(`${from}${suffix}`)) renameSync(`${from}${suffix}`, `${to}${suffix}`);
  }
}

function removeFiles(path: string): void {
  for (const suffix of DB_FILES) rmSync(`${path}${suffix}`, { force: true });
}

/**
 * What a restore changes in the restored database (design 6.14), in one transaction: the epoch, the id counters
 * advanced by COUNTER_ADVANCE, the event and message ids advanced past both databases' newest (by COUNTER_ADVANCE, or
 * by UNKNOWN_IDS_ADVANCE when the replaced database's are unknown), the recorded branch heads forgotten (the first
 * push_submission of each task adopts the remote head), restored_at, which makes unknown agent tokens answer
 * attempt_refenced for a while, and system.restored.
 */
export function markRestored(
  db: Database,
  input: { epoch: number; now: number; replacedIds?: LastIds | null | undefined },
): void {
  db.transaction(() => {
    db.query('UPDATE project SET epoch = $epoch WHERE id = 1').run({ epoch: input.epoch });
    const advance = db.query('UPDATE counters SET value = value + $by WHERE name = $name');
    for (const name of ADVANCED_COUNTERS) advance.run({ by: COUNTER_ADVANCE, name });
    const own = lastIds(db);
    const margin = input.replacedIds ? COUNTER_ADVANCE : UNKNOWN_IDS_ADVANCE;
    for (const table of SEQUENCED_TABLES) {
      const seq = Math.max(own[table], input.replacedIds?.[table] ?? 0) + margin;
      db.query('DELETE FROM sqlite_sequence WHERE name = $table').run({ table });
      db.query('INSERT INTO sqlite_sequence (name, seq) VALUES ($table, $seq)').run({ table, seq });
    }
    db.run('UPDATE tasks SET branch_head = NULL');
    db.query('UPDATE hub_state SET restored_at = $now WHERE id = 1').run({ now: input.now });
    insertEvent(db, input.now, { type: 'system.restored', actor: 'system', data: { epoch: input.epoch } });
  })();
}

/**
 * Copies the backup to the given path, checks and migrates it, and marks it restored at max(its own epoch, floor) + 1,
 * where floor is the higher of the replaced database's epoch and the backup folder's epoch file. Returns that epoch.
 */
function installBackup(
  path: string,
  backupPath: string,
  input: { now: number; floor: number; replacedIds: LastIds | null },
): number {
  copyFileSync(backupPath, path);
  const db = new Database(path, { strict: true });
  try {
    db.run('PRAGMA journal_mode = WAL;');
    checkIntegrity({ db });
    migrate(db, input.now);
    const backupEpoch = (db.query('SELECT epoch FROM project WHERE id = 1').get() as { epoch: number }).epoch;
    const epoch = Math.max(backupEpoch, input.floor) + 1;
    markRestored(db, { epoch, now: input.now, replacedIds: input.replacedIds });
    db.run('PRAGMA wal_checkpoint(TRUNCATE)');
    return epoch;
  } finally {
    db.close();
  }
}

/**
 * Restores a backup (design 6.14), refusing while a hub holds the database (its <db>.pid names a live process) and
 * holding that lock itself meanwhile:
 * 1. the backup is copied to agflow.db.restoring next to the database, passes integrity_check, and is migrated;
 * 2. the epoch becomes max(the backup's, the replaced database's if readable, <backup dir>/epoch) + 1; the counters
 *    advance and the rest of markRestored applies; the WAL is checkpointed;
 * 3. only then are agflow.db, -wal and -shm moved aside, kept as agflow.db.replaced-<time> (with its -wal and -shm),
 *    and the prepared database renamed into place; the epoch is written back to <backup dir>/epoch.
 * A restore that fails or is interrupted before step 3 leaves the database as it was; a failed rename in step 3 puts
 * the replaced files back.
 */
export function restoreBackup(input: RestoreInput): RestoreResult {
  const { dbPath, backupPath } = input;
  const now = input.now ?? Date.now();
  if (!existsSync(backupPath)) throw new Error(`no backup at ${backupPath}`);
  acquireDbLock(dbPath);
  try {
    const epochFile = join(dirname(backupPath), 'epoch');
    const replaced = readReplaced(dbPath);
    const floor = Math.max(replaced?.epoch ?? 0, recordedEpoch(epochFile) ?? 0);
    const restoring = `${dbPath}.restoring`;
    removeFiles(restoring);
    let epoch: number;
    try {
      epoch = installBackup(restoring, backupPath, { now, floor, replacedIds: replaced?.lastIds ?? null });
    } catch (error) {
      removeFiles(restoring);
      throw error;
    }
    const aside = existsSync(dbPath) ? `${dbPath}.replaced-${new Date(now).toISOString().replace(/[:.]/g, '-')}` : null;
    if (aside) moveFiles(dbPath, aside);
    try {
      moveFiles(restoring, dbPath);
    } catch (error) {
      removeFiles(dbPath);
      if (aside) moveFiles(aside, dbPath);
      throw error;
    }
    writeFileSync(epochFile, `${epoch}\n`);
    return { epoch, aside };
  } finally {
    releaseDbLock(dbPath);
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !args[0]) {
    console.error('usage: bun run restore <backup>   (stop the hub first; AGFLOW_DB names the database)');
    process.exit(2);
  }
  const dbPath = databasePath(process.env);
  try {
    const { epoch, aside } = restoreBackup({ dbPath, backupPath: args[0] });
    console.log(`restored ${args[0]} into ${dbPath} at epoch ${epoch}`);
    if (aside) console.log(`the replaced database is kept at ${aside}`);
    console.log('start the hub; runners replay what they did since the backup when they reconnect');
  } catch (error) {
    console.error(`restore failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
