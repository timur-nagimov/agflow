import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { backupDatabase, checkIntegrity, dailyBackupDue } from '../src/backup';
import { createTasks } from '../src/tasks';
import { createTestContext, newTask } from './helpers';

const DAY = 24 * 60 * 60_000;

function backupDir(): string {
  return mkdtempSync(join(tmpdir(), 'agflow-backup-'));
}

function snapshots(dir: string, kind: 'daily' | 'start'): string[] {
  return readdirSync(dir)
    .filter((name) => name.startsWith(`agflow-${kind}-`))
    .sort();
}

function taskCount(file: string): number {
  const copy = new Database(file, { readonly: true });
  const row = copy.query('SELECT COUNT(*) AS n FROM tasks').get() as { n: number };
  copy.close();
  return row.n;
}

describe('backups', () => {
  test('a snapshot contains the data and is named after its kind and time', () => {
    const { ctx } = createTestContext();
    createTasks(ctx, [newTask({ title: 'Saved' })], 'user:alice');
    const dir = backupDir();
    const daily = backupDatabase(ctx, dir, 'daily');
    const start = backupDatabase(ctx, dir, 'start');
    expect(basename(daily)).toBe('agflow-daily-2026-10-26.db');
    expect(basename(start)).toBe('agflow-start-2026-10-26T12-00-00-000Z.db');
    expect(readdirSync(dir).sort()).toEqual([basename(daily), basename(start)]);
    expect(taskCount(daily)).toBe(1);
    expect(taskCount(start)).toBe(1);
  });

  test('a second daily snapshot on the same day replaces the first', () => {
    const { ctx, clock } = createTestContext();
    const dir = backupDir();
    backupDatabase(ctx, dir, 'daily');
    createTasks(ctx, [newTask({ title: 'Later' })], 'user:alice');
    clock.advance(6 * 60 * 60_000);
    const file = backupDatabase(ctx, dir, 'daily');
    expect(readdirSync(dir)).toEqual(['agflow-daily-2026-10-26.db']);
    expect(taskCount(file)).toBe(1);
  });

  test('two snapshots in the same millisecond both succeed', () => {
    const { ctx } = createTestContext();
    const dir = backupDir();
    backupDatabase(ctx, dir, 'start');
    expect(() => backupDatabase(ctx, dir, 'start')).not.toThrow();
    expect(readdirSync(dir)).toEqual(['agflow-start-2026-10-26T12-00-00-000Z.db']);
  });

  test('keeps the newest 7 daily and 3 start snapshots, so a crash loop cannot evict the daily ones', () => {
    const { ctx, clock } = createTestContext();
    const dir = backupDir();
    for (let day = 0; day < 9; day++) {
      backupDatabase(ctx, dir, 'daily');
      clock.advance(DAY);
    }
    for (let start = 0; start < 10; start++) {
      backupDatabase(ctx, dir, 'start');
      clock.advance(60_000);
    }
    expect(snapshots(dir, 'daily')).toEqual([
      'agflow-daily-2026-10-28.db',
      'agflow-daily-2026-10-29.db',
      'agflow-daily-2026-10-30.db',
      'agflow-daily-2026-10-31.db',
      'agflow-daily-2026-11-01.db',
      'agflow-daily-2026-11-02.db',
      'agflow-daily-2026-11-03.db',
    ]);
    expect(snapshots(dir, 'start')).toEqual([
      'agflow-start-2026-11-04T12-07-00-000Z.db',
      'agflow-start-2026-11-04T12-08-00-000Z.db',
      'agflow-start-2026-11-04T12-09-00-000Z.db',
    ]);
  });

  test('a failed backup leaves no temporary file and keeps the earlier snapshots', () => {
    const { ctx, clock } = createTestContext();
    const dir = backupDir();
    backupDatabase(ctx, dir, 'start');
    clock.advance(DAY);
    // A folder in the snapshot's place makes moving the finished snapshot into place fail.
    mkdirSync(join(dir, 'agflow-daily-2026-10-27.db'));
    expect(() => backupDatabase(ctx, dir, 'daily')).toThrow();
    expect(readdirSync(dir).sort()).toEqual(['agflow-daily-2026-10-27.db', 'agflow-start-2026-10-26T12-00-00-000Z.db']);
  });

  test('a temporary file left by an interrupted backup neither counts nor blocks the next backup', () => {
    const { ctx, clock } = createTestContext();
    const dir = backupDir();
    writeFileSync(join(dir, 'agflow-daily.tmp'), 'partial');
    writeFileSync(join(dir, 'agflow-start.tmp'), 'partial');
    for (let day = 0; day < 8; day++) {
      backupDatabase(ctx, dir, 'daily');
      clock.advance(DAY);
    }
    expect(snapshots(dir, 'daily')).toHaveLength(7);
    expect(readdirSync(dir)).toContain('agflow-start.tmp');
    backupDatabase(ctx, dir, 'start');
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  test('a daily snapshot is due until one exists for the current UTC day', () => {
    const { ctx, clock } = createTestContext();
    const dir = backupDir();
    expect(dailyBackupDue(ctx, dir)).toBe(true);
    backupDatabase(ctx, dir, 'start');
    expect(dailyBackupDue(ctx, dir)).toBe(true);
    backupDatabase(ctx, dir, 'daily');
    expect(dailyBackupDue(ctx, dir)).toBe(false);
    clock.advance(12 * 60 * 60_000);
    expect(dailyBackupDue(ctx, dir)).toBe(true);
  });

  test('a healthy database passes the integrity check', () => {
    const { ctx } = createTestContext();
    expect(() => checkIntegrity(ctx)).not.toThrow();
  });
});
