import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupDatabase, checkIntegrity } from '../src/backup';
import { createTasks } from '../src/tasks';
import { createTestContext, newTask } from './helpers';

describe('backups', () => {
  test('a snapshot contains the data and old snapshots are pruned', () => {
    const { ctx, clock } = createTestContext();
    createTasks(ctx, [newTask({ title: 'Saved' })], 'user:alice');
    const dir = mkdtempSync(join(tmpdir(), 'agflow-backup-'));
    let last = '';
    for (let i = 0; i < 3; i++) {
      last = backupDatabase(ctx, dir, 2);
      clock.advance(60_000);
    }
    expect(readdirSync(dir)).toHaveLength(2);
    const copy = new Database(last, { readonly: true });
    expect(copy.query('SELECT COUNT(*) AS n FROM tasks').get()).toEqual({ n: 1 });
  });

  test('a healthy database passes the integrity check', () => {
    const { ctx } = createTestContext();
    expect(() => checkIntegrity(ctx)).not.toThrow();
  });
});
