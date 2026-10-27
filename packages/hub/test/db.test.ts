import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, nextId, openDb } from '../src/db';

describe('openDb', () => {
  test('creates the schema', () => {
    const db = openDb(':memory:');
    const tables = (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
      (row) => row.name,
    );
    for (const name of ['project', 'goal_versions', 'tasks', 'agents', 'messages', 'deliveries', 'events', 'sessions']) {
      expect(tables).toContain(name);
    }
  });

  test('migrating twice is a no-op', () => {
    const db = openDb(':memory:');
    migrate(db);
    const row = db.query('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number };
    expect(row.n).toBe(1);
  });

  test('refuses a database written by a newer hub', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'agflow-db-')), 'agflow.db');
    const db = openDb(path);
    db.run('INSERT INTO schema_migrations (version, applied_at) VALUES (1000, 0)');
    db.close();
    expect(() => openDb(path)).toThrow('database schema version 1000 is newer than this hub supports');
  });
});

describe('nextId', () => {
  test('counts up per counter', () => {
    const db = openDb(':memory:');
    expect(nextId(db, 'task')).toBe(1);
    expect(nextId(db, 'task')).toBe(2);
    expect(nextId(db, 'agent')).toBe(1);
  });
});
