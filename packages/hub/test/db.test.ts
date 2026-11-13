import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAgent } from '../src/agents';
import { createContext } from '../src/context';
import { M1_LEAD_STALE_MS, SCHEMA_V1, migrate, nextId, openDb } from '../src/db';
import { type HubStateRow, getHubState, hubEpoch, updateHubState } from '../src/hub-state';
import { getProject } from '../src/project';
import { getTask, listTaskNotes } from '../src/tasks';
import { makeConfig } from './helpers';

const NOW = Date.UTC(2026, 9, 29, 12, 0, 0);
const MINUTE = 60_000;

const tempDbPath = () => join(mkdtempSync(join(tmpdir(), 'agflow-db-')), 'agflow.db');

const names = (db: Database, type: 'table' | 'index') =>
  (db.query('SELECT name FROM sqlite_master WHERE type = $type').all({ type }) as { name: string }[]).map(
    (row) => row.name,
  );

const columns = (db: Database, table: string) =>
  (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((row) => row.name);

/** A database as an M1 hub left it: schema version 1 with a project, a task, a note and agents. */
function v1Database(path: string, leadSeenAt: number): void {
  const db = new Database(path, { create: true, strict: true });
  db.run('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
  db.run(SCHEMA_V1);
  db.run('INSERT INTO schema_migrations (version, applied_at) VALUES (1, 0)');
  db.run("UPDATE counters SET value = 3 WHERE name = 'task'");
  db.run("UPDATE counters SET value = 2 WHERE name = 'agent'");
  db.run("INSERT INTO project (id, name, repo, paused) VALUES (1, 'demo', 'https://github.com/acme/demo', 1)");
  const contract = { title: 'Old task', kind: 'code', objective: 'o', why: '', nonGoals: [], acceptance: [] };
  db.query(
    `INSERT INTO tasks (id, seq, status, contract, goal_version, created_by, created_at, updated_at)
     VALUES ('T-3', 3, 'ready', $contract, 0, 'user:alice', 1, 1)`,
  ).run({ contract: JSON.stringify({ ...contract, checks: [], ownedPaths: [], dependsOn: [], priority: 2 }) });
  db.run(
    "INSERT INTO task_notes (task_id, kind, body, author, created_at) VALUES ('T-3', 'handoff', 'notes', 'agent:A-1', 2)",
  );
  const agent = `INSERT INTO agents (id, seq, login, vendor, role, origin, session_id, last_seen_at, created_at)
     VALUES ($id, $seq, 'alice', 'claude', $role, 'live', $id, $seen, 0)`;
  db.query(agent).run({ id: 'A-1', seq: 1, role: 'lead', seen: leadSeenAt });
  db.query(agent).run({ id: 'A-2', seq: 2, role: 'worker', seen: NOW });
  db.close();
}

describe('openDb', () => {
  test('creates every table, column and index of schema versions 2 and 3', () => {
    const db = openDb(':memory:', NOW);
    const tables = names(db, 'table');
    for (const name of [
      'project',
      'goal_versions',
      'tasks',
      'agents',
      'messages',
      'deliveries',
      'events',
      'sessions',
      'hub_state',
      'runners',
      'vendor_accounts',
      'attempts',
      'attempt_log',
      'agent_tokens',
      'submissions',
      'runner_commands',
      'pending_deliveries',
      'runner_inbox',
      'runner_event_rejects',
      'approvals',
      'lead_notes',
      'task_fetch_grants',
      'agent_fetches',
    ]) {
      expect(tables).toContain(name);
    }
    expect(columns(db, 'project')).toEqual(
      expect.arrayContaining(['epoch', 'worker_target', 'vendor_pref', 'vendor_pref_until', 'runner_leads']),
    );
    expect(columns(db, 'agents')).toEqual(expect.arrayContaining(['runner_id', 'attempt_id']));
    expect(columns(db, 'tasks')).toEqual(
      expect.arrayContaining([
        'current_attempt',
        'ladder_floor',
        'work_ref',
        'work_sha',
        'branch_head',
        'next_dispatch_at',
        'dispatch_hold_until',
      ]),
    );
    expect(columns(db, 'task_notes')).toContain('attempt_id');
    expect(columns(db, 'task_fetch_grants')).toEqual(['task_id', 'granted_by', 'reason', 'granted_at']);
    expect(columns(db, 'agent_fetches')).toEqual([
      'id',
      'at',
      'attempt_id',
      'task_id',
      'agent_id',
      'url',
      'final_url',
      'status',
      'error',
      'bytes',
      'detail',
    ]);
    expect(names(db, 'index')).toEqual(
      expect.arrayContaining([
        'agent_fetches_attempt',
        'attempts_task_number',
        'attempts_one_open',
        'attempts_status',
        'attempts_runner',
        'attempt_log_attempt',
        'agent_tokens_attempt',
        'submissions_one_pending',
        'runner_commands_pending',
        'approvals_owner_status',
      ]),
    );
    const versions = db.query('SELECT version, applied_at FROM schema_migrations ORDER BY version').all();
    expect(versions).toEqual([
      { version: 1, applied_at: NOW },
      { version: 2, applied_at: NOW },
      { version: 3, applied_at: NOW },
    ]);
  });

  test('a schema version 2 database gains the internet grants and the record of fetches, and keeps its rows', () => {
    const db = openDb(':memory:', NOW);
    // As a hub before version 3 left it.
    db.run('DROP TABLE task_fetch_grants');
    db.run('DROP TABLE agent_fetches');
    db.run('DELETE FROM schema_migrations WHERE version = 3');
    db.run("INSERT INTO goal_versions (version, text, author, created_at) VALUES (1, 'goal', 'user:alice', 0)");
    migrate(db, NOW + MINUTE);
    expect(db.query('SELECT version, applied_at FROM schema_migrations WHERE version = 3').get()).toEqual({
      version: 3,
      applied_at: NOW + MINUTE,
    });
    expect(db.query('SELECT COUNT(*) AS n FROM task_fetch_grants').get()).toEqual({ n: 0 });
    expect(db.query('SELECT COUNT(*) AS n FROM agent_fetches').get()).toEqual({ n: 0 });
    expect(db.query('SELECT COUNT(*) AS n FROM goal_versions').get()).toEqual({ n: 1 });
  });

  test("the runbook's way back from schema version 3 leaves a whole version 2 database, which takes the upgrade again", () => {
    const runbook = readFileSync(join(import.meta.dir, '../../../docs/deploy-hub.md'), 'utf8');
    // The statements the runbook feeds to sqlite3 on the stopped hub's database.
    const statements = /sqlite3 \/var\/lib\/agflow\/data\/agflow\.db <<'SQL'\n([\s\S]*?)\nSQL\n/.exec(runbook)?.[1];
    if (!statements) throw new Error('the runbook shows no statements for the way back from schema version 3');
    const db = openDb(tempDbPath(), NOW);
    // A hub that ran on version 3: a task, an event, a grant and a recorded fetch.
    db.run(
      `INSERT INTO tasks (id, seq, status, contract, goal_version, created_by, created_at, updated_at)
       VALUES ('T-1', 1, 'ready', '{}', 0, 'user:alice', 1, 1)`,
    );
    db.run("INSERT INTO events (ts, type, actor, subject, data) VALUES (1, 'task.fetch_granted', 'user:alice', 'T-1', '{}')");
    db.run("INSERT INTO task_fetch_grants (task_id, granted_by, reason, granted_at) VALUES ('T-1', 'user:alice', 'why', 1)");
    db.run(
      `INSERT INTO agent_fetches (at, attempt_id, task_id, agent_id, url, bytes)
       VALUES (1, 'T-1-a1', 'T-1', 'A-1', 'https://example.com/', 0)`,
    );
    const objects = () =>
      (
        db
          .query("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
          .all() as { type: string; name: string; sql: string }[]
      ).map((object) => `${object.type} ${object.name}: ${object.sql}`);
    const version3 = objects();
    db.run(statements);
    // What the previous release asks of a database at its start: no version above the 2 it knows, and a sound file.
    expect(db.query('SELECT MAX(version) AS v FROM schema_migrations').get()).toEqual({ v: 2 });
    expect(db.query('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    // Only what version 3 added is gone; everything else stays, the events of the grants included.
    const version2 = objects();
    expect(version3.filter((object) => !version2.includes(object)).map((object) => object.split(':')[0])).toEqual([
      'index agent_fetches_attempt',
      'table agent_fetches',
      'table task_fetch_grants',
    ]);
    expect(version2.filter((object) => !version3.includes(object))).toEqual([]);
    expect(db.query('SELECT (SELECT COUNT(*) FROM tasks) AS tasks, (SELECT COUNT(*) FROM events) AS events').get()).toEqual({
      tasks: 1,
      events: 1,
    });
    // Nothing of version 3 is left behind, or its step could not run again: the upgrade applies, and gives its schema.
    migrate(db, NOW + MINUTE);
    expect(objects()).toEqual(version3);
    expect(db.query('SELECT version, applied_at FROM schema_migrations WHERE version = 3').get()).toEqual({
      version: 3,
      applied_at: NOW + MINUTE,
    });
    expect(db.query('SELECT (SELECT COUNT(*) FROM task_fetch_grants) AS grants, (SELECT COUNT(*) FROM agent_fetches) AS fetches').get()).toEqual({
      grants: 0,
      fetches: 0,
    });
    db.close();
  });

  test('migrating twice is a no-op', () => {
    const db = openDb(':memory:', NOW);
    migrate(db, NOW + MINUTE);
    const row = db.query('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number };
    expect(row.n).toBe(3);
    expect((db.query('SELECT COUNT(*) AS n FROM hub_state').get() as { n: number }).n).toBe(1);
  });

  test('refuses a database written by a newer hub', () => {
    const path = tempDbPath();
    const db = openDb(path, NOW);
    db.run('INSERT INTO schema_migrations (version, applied_at) VALUES (1000, 0)');
    db.close();
    expect(() => openDb(path, NOW)).toThrow('database schema version 1000 is newer than this hub supports (3)');
  });

  test('a version 1 database keeps its data and gets the defaults', () => {
    const path = tempDbPath();
    v1Database(path, NOW - 5 * MINUTE);
    const db = openDb(path, NOW);
    expect(db.query('SELECT epoch, worker_target, vendor_pref, runner_leads, paused FROM project').get()).toEqual({
      epoch: 1,
      worker_target: null,
      vendor_pref: null,
      runner_leads: 1,
      paused: 1,
    });
    const task = db.query("SELECT status, ladder_floor, current_attempt, work_ref FROM tasks WHERE id = 'T-3'").get();
    expect(task).toEqual({ status: 'ready', ladder_floor: 0, current_attempt: null, work_ref: null });
    expect(db.query('SELECT body, attempt_id FROM task_notes').all()).toEqual([{ body: 'notes', attempt_id: null }]);
    expect(nextId(db, 'task')).toBe(4);
    expect(nextId(db, 'agent')).toBe(3);
    db.close();
  });
});

describe('hub_state', () => {
  test('a fresh database records the start as the last time the hub was alive, with an empty seat', () => {
    const ctx = createContext({ dbPath: ':memory:', config: makeConfig(), now: () => NOW });
    expect(getHubState(ctx)).toEqual({
      lastAliveAt: NOW,
      recoveryUntil: null,
      restoredAt: null,
      dispatchPausedUntil: null,
      lastLeadReviewAt: null,
      leadAgentId: null,
      leadKind: null,
      leadSince: null,
    });
    expect(hubEpoch(ctx)).toBe(1);
  });

  test('updateHubState changes only the fields it is given', () => {
    const ctx = createContext({ dbPath: ':memory:', config: makeConfig(), now: () => NOW });
    updateHubState(ctx, { leadAgentId: 'A-7', leadKind: 'runner', leadSince: NOW + 1 });
    updateHubState(ctx, { recoveryUntil: NOW + MINUTE, leadSince: undefined });
    expect(getHubState(ctx)).toMatchObject({
      lastAliveAt: NOW,
      recoveryUntil: NOW + MINUTE,
      leadAgentId: 'A-7',
      leadKind: 'runner',
      leadSince: NOW + 1,
    });
    updateHubState(ctx, { leadAgentId: null, leadKind: null, leadSince: null });
    expect(getHubState(ctx)).toMatchObject({ leadAgentId: null, leadKind: null, leadSince: null });
    ctx.db.run('UPDATE project SET epoch = 3');
    expect(hubEpoch(ctx)).toBe(3);
  });

  test('every field goes to its own column and reads back from it', () => {
    const ctx = createContext({ dbPath: ':memory:', config: makeConfig(), now: () => NOW });
    const state: Required<HubStateRow> = {
      lastAliveAt: 1,
      recoveryUntil: 2,
      restoredAt: 3,
      dispatchPausedUntil: 4,
      lastLeadReviewAt: 5,
      leadAgentId: 'A-7',
      leadKind: 'runner',
      leadSince: 6,
    };
    updateHubState(ctx, state);
    expect(getHubState(ctx)).toEqual(state);
    expect(ctx.db.query('SELECT * FROM hub_state').get()).toEqual({
      id: 1,
      last_alive_at: 1,
      recovery_until: 2,
      restored_at: 3,
      dispatch_paused_until: 4,
      last_lead_review_at: 5,
      lead_agent_id: 'A-7',
      lead_kind: 'runner',
      lead_since: 6,
    });
  });

  test("M1's live lead keeps the seat when it was seen within 15 minutes", () => {
    const path = tempDbPath();
    v1Database(path, NOW - M1_LEAD_STALE_MS + 1);
    const db = openDb(path, NOW);
    expect(db.query('SELECT last_alive_at, lead_agent_id, lead_kind, lead_since FROM hub_state').get()).toEqual({
      last_alive_at: NOW,
      lead_agent_id: 'A-1',
      lead_kind: 'live',
      lead_since: NOW,
    });
    db.close();
  });

  test('a lead unseen for 15 minutes leaves the seat empty', () => {
    const path = tempDbPath();
    v1Database(path, NOW - M1_LEAD_STALE_MS);
    const db = openDb(path, NOW);
    expect(db.query('SELECT lead_agent_id, lead_kind, lead_since FROM hub_state').get()).toEqual({
      lead_agent_id: null,
      lead_kind: null,
      lead_since: null,
    });
    db.close();
  });
});

describe('nextId', () => {
  test('counts up per counter', () => {
    const db = openDb(':memory:', NOW);
    expect(nextId(db, 'task')).toBe(1);
    expect(nextId(db, 'task')).toBe(2);
    expect(nextId(db, 'agent')).toBe(1);
    for (const name of ['runner', 'fence', 'lead_attempt', 'submission'] as const) {
      expect([name, nextId(db, name), nextId(db, name)]).toEqual([name, 1, 2]);
    }
  });
});

describe('schema version 2 constraints', () => {
  const attempt = (db: Database, id: string, taskId: string | null, number: number, status: string) =>
    db
      .query(
        `INSERT INTO attempts (id, task_id, number, role, agent_id, vendor, fence_epoch, fence_counter, status,
           started_at, last_activity_at)
         VALUES ($id, $taskId, $number, 'worker', 'A-1', 'claude', 1, $number, $status, 0, 0)`,
      )
      .run({ id, taskId, number, status });

  function withTask(): Database {
    const db = openDb(':memory:', NOW);
    db.run(
      `INSERT INTO tasks (id, seq, status, contract, goal_version, created_by, created_at, updated_at)
       VALUES ('T-1', 1, 'ready', '{}', 0, 'user:alice', 0, 0)`,
    );
    return db;
  }

  test('a task has at most one open attempt', () => {
    const db = withTask();
    attempt(db, 'T-1-a1', 'T-1', 1, 'ended');
    attempt(db, 'T-1-a2', 'T-1', 2, 'running');
    expect(() => attempt(db, 'T-1-a3', 'T-1', 3, 'holding')).toThrow('UNIQUE');
    attempt(db, 'T-1-a3', 'T-1', 3, 'ended');
    // Lead attempts have no task, so any number of them may be open.
    attempt(db, 'lead-a1', null, 1, 'running');
    attempt(db, 'lead-a2', null, 2, 'running');
  });

  test('an attempt number is used once per task', () => {
    const db = withTask();
    attempt(db, 'T-1-a1', 'T-1', 1, 'ended');
    expect(() => attempt(db, 'T-1-e2-a1', 'T-1', 1, 'ended')).toThrow('UNIQUE');
  });

  test('an attempt has at most one pending submission', () => {
    const db = openDb(':memory:', NOW);
    const submission = (id: string, status: string) =>
      db
        .query(
          `INSERT INTO submissions (id, task_id, attempt_id, status, summary, evidence, requested_at)
           VALUES ($id, 'T-1', 'T-1-a1', $status, 's', '[]', 0)`,
        )
        .run({ id, status });
    submission('S-1', 'failed');
    submission('S-2', 'pending');
    expect(() => submission('S-3', 'pending')).toThrow('UNIQUE');
    submission('S-3', 'submitted');
  });
});

describe('answers read the version 2 columns', () => {
  test('tasks, agents, the project and task notes', () => {
    const path = tempDbPath();
    v1Database(path, NOW);
    const ctx = createContext({ dbPath: path, config: makeConfig(), now: () => NOW });
    const sha = 'a'.repeat(40);
    ctx.db
      .query(
        `UPDATE tasks SET current_attempt = 'T-3-a2', work_ref = 'refs/agflow/T-3/a2', work_sha = $sha,
           next_dispatch_at = $at WHERE id = 'T-3'`,
      )
      .run({ sha, at: NOW + MINUTE });
    ctx.db.run("UPDATE agents SET origin = 'runner', runner_id = 'R-1', attempt_id = 'T-3-a2' WHERE id = 'A-2'");
    ctx.db.run('UPDATE project SET runner_leads = 0');
    ctx.db.run("UPDATE task_notes SET attempt_id = 'T-3-a1'");
    expect(getTask(ctx, 'T-3')).toMatchObject({
      currentAttempt: 'T-3-a2',
      workRef: 'refs/agflow/T-3/a2',
      workSha: sha,
      nextDispatchAt: NOW + MINUTE,
    });
    expect(getAgent(ctx, 'A-2')).toMatchObject({ runnerId: 'R-1', attemptId: 'T-3-a2' });
    expect(getAgent(ctx, 'A-1')).toMatchObject({ runnerId: null, attemptId: null });
    expect(getProject(ctx)).toMatchObject({ paused: true, runnerLeads: false });
    expect(listTaskNotes(ctx, 'T-3')).toEqual([expect.objectContaining({ body: 'notes', attemptId: 'T-3-a1' })]);
  });
});
