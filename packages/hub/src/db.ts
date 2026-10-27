import { Database } from 'bun:sqlite';

const SCHEMA_V1 = `
CREATE TABLE counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
INSERT INTO counters (name, value) VALUES ('task', 0), ('agent', 0);

CREATE TABLE project (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL,
  repo TEXT NOT NULL,
  paused INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE goal_versions (
  version INTEGER PRIMARY KEY,
  text TEXT NOT NULL,
  author TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE goal_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_version INTEGER NOT NULL,
  text TEXT NOT NULL,
  author TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE,
  status TEXT NOT NULL,
  contract TEXT NOT NULL,
  assignee TEXT,
  branch TEXT,
  goal_version INTEGER NOT NULL,
  lease_expires_at INTEGER,
  blocked_kind TEXT,
  blocked_reason TEXT,
  submission TEXT,
  feedback TEXT,
  merged_sha TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_reminded_at INTEGER
);
CREATE INDEX tasks_status ON tasks (status);
CREATE INDEX tasks_assignee ON tasks (assignee);

CREATE TABLE task_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks (id),
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  author TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX task_notes_task ON task_notes (task_id);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE,
  login TEXT NOT NULL,
  vendor TEXT NOT NULL,
  role TEXT NOT NULL,
  origin TEXT NOT NULL,
  session_id TEXT,
  hello_code TEXT,
  label TEXT,
  current_task TEXT,
  last_seen_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (vendor, session_id)
);
CREATE INDEX agents_hello ON agents (hello_code);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender TEXT NOT NULL,
  target TEXT NOT NULL,
  body TEXT NOT NULL,
  task_id TEXT,
  reply_to INTEGER,
  standing_rule INTEGER NOT NULL DEFAULT 0,
  rule_active INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX messages_target ON messages (target);
CREATE INDEX messages_task ON messages (task_id);

CREATE TABLE deliveries (
  message_id INTEGER NOT NULL REFERENCES messages (id),
  agent_id TEXT NOT NULL,
  delivered_at INTEGER NOT NULL,
  acked_at INTEGER,
  PRIMARY KEY (message_id, agent_id)
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  actor TEXT NOT NULL,
  subject TEXT,
  data TEXT NOT NULL
);
CREATE INDEX events_subject ON events (subject);
CREATE INDEX events_type_ts ON events (type, ts);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  login TEXT NOT NULL,
  kind TEXT NOT NULL,
  label TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE cli_logins (
  code TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  login TEXT NOT NULL,
  label TEXT
);

CREATE TABLE oauth_states (
  state TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  return_to TEXT NOT NULL
);
`;

const MIGRATIONS: readonly string[] = [SCHEMA_V1];

export function openDb(path: string): Database {
  const db = new Database(path, { create: true, strict: true });
  db.run('PRAGMA journal_mode = WAL;');
  db.run('PRAGMA foreign_keys = ON;');
  db.run('PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

export function migrate(db: Database): void {
  db.run('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const row = db.query('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null };
  for (let index = row.v ?? 0; index < MIGRATIONS.length; index++) {
    const sql = MIGRATIONS[index] as string;
    db.transaction(() => {
      db.run(sql);
      db.query('INSERT INTO schema_migrations (version, applied_at) VALUES ($version, $at)').run({
        version: index + 1,
        at: Date.now(),
      });
    })();
  }
}

export function nextId(db: Database, name: 'task' | 'agent'): number {
  const row = db.query('UPDATE counters SET value = value + 1 WHERE name = $name RETURNING value').get({ name }) as {
    value: number;
  } | null;
  if (!row) throw new Error(`unknown counter ${name}`);
  return row.value;
}
