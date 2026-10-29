import { Database } from 'bun:sqlite';

export const SCHEMA_V1 = `
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

// Design 6.2: runners, attempts and everything around them.
const SCHEMA_V2 = `
ALTER TABLE project ADD COLUMN epoch INTEGER NOT NULL DEFAULT 1;
ALTER TABLE project ADD COLUMN worker_target INTEGER;            -- request_agents; NULL = the cap
ALTER TABLE project ADD COLUMN vendor_pref TEXT;
ALTER TABLE project ADD COLUMN vendor_pref_until INTEGER;
ALTER TABLE project ADD COLUMN runner_leads INTEGER NOT NULL DEFAULT 1;
ALTER TABLE agents ADD COLUMN runner_id TEXT;
ALTER TABLE agents ADD COLUMN attempt_id TEXT;
ALTER TABLE tasks ADD COLUMN current_attempt TEXT;
ALTER TABLE tasks ADD COLUMN ladder_floor INTEGER NOT NULL DEFAULT 0;  -- highest attempt number at the last re-plan
ALTER TABLE tasks ADD COLUMN work_ref TEXT;                     -- where the next attempt starts
ALTER TABLE tasks ADD COLUMN work_sha TEXT;
ALTER TABLE tasks ADD COLUMN branch_head TEXT;                  -- task branch head the hub last recorded
ALTER TABLE tasks ADD COLUMN next_dispatch_at INTEGER;          -- infra backoff
ALTER TABLE tasks ADD COLUMN dispatch_hold_until INTEGER;       -- waiting for late work or a final push
ALTER TABLE task_notes ADD COLUMN attempt_id TEXT;               -- TaskNote.attemptId
INSERT INTO counters (name, value) VALUES ('runner', 0), ('fence', 0), ('lead_attempt', 0), ('submission', 0);

CREATE TABLE hub_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_alive_at INTEGER NOT NULL,
  recovery_until INTEGER,
  restored_at INTEGER,
  dispatch_paused_until INTEGER,     -- churn guard
  last_lead_review_at INTEGER,
  lead_agent_id TEXT,                -- the lead seat
  lead_kind TEXT,                    -- 'live' | 'runner'
  lead_since INTEGER
);

CREATE TABLE runners (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE,
  runner_key TEXT NOT NULL UNIQUE,
  machine_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'offline',
  state_detail TEXT,
  last_error TEXT,
  capacity INTEGER NOT NULL,
  keep_awake TEXT NOT NULL DEFAULT 'ac',
  draining INTEGER NOT NULL DEFAULT 0,
  settings_version INTEGER NOT NULL DEFAULT 0,
  protocol INTEGER NOT NULL,
  info TEXT NOT NULL,                -- JSON: agflowVersion, platform, vendors, profile, git, power, disk
  vendor_holds TEXT NOT NULL DEFAULT '{}',   -- JSON { [vendor]: { degradedUntil, failedStarts, notReadySince } }, hub-owned
  accepting_until INTEGER,           -- from heartbeats: no placement before this time
  connection_id TEXT,
  session_hash TEXT,                 -- the CLI session its link uses (sliding expiry)
  last_seen_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  retired_at INTEGER
);

CREATE TABLE vendor_accounts (
  owner TEXT NOT NULL,
  vendor TEXT NOT NULL,
  account_id TEXT NOT NULL,
  quota TEXT NOT NULL,               -- JSON VendorQuota
  owner_away INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner, vendor, account_id)
);

CREATE TABLE attempts (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks (id),
  number INTEGER NOT NULL,
  role TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  runner_id TEXT,
  vendor TEXT NOT NULL,
  model TEXT,
  session_ref TEXT,
  fence_epoch INTEGER NOT NULL,
  fence_counter INTEGER NOT NULL,
  status TEXT NOT NULL,
  end_reason TEXT,
  failure_class TEXT,
  failure_signature TEXT,
  start_ref TEXT,
  start_sha TEXT,
  wip_ref TEXT,
  wip_sha TEXT,
  submitted_sha TEXT,
  resumable INTEGER NOT NULL DEFAULT 1,
  review_rounds INTEGER NOT NULL DEFAULT 0,
  wakeups INTEGER NOT NULL DEFAULT 0,
  active_ms INTEGER NOT NULL DEFAULT 0,
  resume_log TEXT,                   -- JSON list of { at, cause: 'runner_restart' | 'lead_exit' }
  phase TEXT,
  facts TEXT,                        -- JSON AttemptFacts
  facts_at INTEGER,                  -- when the hub received them
  stop_requested TEXT,               -- JSON {cause, reason, by, handoff, deferred, at}
  takeover TEXT,                     -- JSON {local, anywhere, ref, error}
  final_sha TEXT,                    -- the harvested head reported at exit, even when its push failed
  compaction_summary TEXT,
  transcript_tail TEXT,
  lease_expires_at INTEGER,
  quota_resets_at INTEGER,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  last_activity_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX attempts_task_number ON attempts (task_id, number) WHERE task_id IS NOT NULL;
CREATE UNIQUE INDEX attempts_one_open ON attempts (task_id) WHERE task_id IS NOT NULL AND status != 'ended';
CREATE INDEX attempts_status ON attempts (status);
CREATE INDEX attempts_runner ON attempts (runner_id);

CREATE TABLE attempt_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,   -- tool | turn | text | delivery | quota | violation | compaction | vendor_error | rejected | note
  summary TEXT NOT NULL
);
CREATE INDEX attempt_log_attempt ON attempt_log (attempt_id, id);

CREATE TABLE agent_tokens (
  token_hash TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  fence_epoch INTEGER NOT NULL,
  fence_counter INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX agent_tokens_attempt ON agent_tokens (attempt_id);

CREATE TABLE submissions (
  id TEXT PRIMARY KEY,               -- 'S-<n>'
  task_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  status TEXT NOT NULL,              -- pending | submitted | failed
  summary TEXT NOT NULL,
  evidence TEXT NOT NULL,            -- JSON string[]
  head_sha TEXT,
  remote_head TEXT,
  error TEXT,
  requested_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE UNIQUE INDEX submissions_one_pending ON submissions (attempt_id) WHERE status = 'pending';

CREATE TABLE runner_commands (
  id TEXT PRIMARY KEY,
  runner_id TEXT NOT NULL,
  hub_epoch INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  attempt_id TEXT,
  fence_epoch INTEGER,
  fence_counter INTEGER,
  payload TEXT NOT NULL,             -- JSON; agent tokens are never stored
  status TEXT NOT NULL,              -- pending | done | failed | cancelled
  result TEXT,
  created_at INTEGER NOT NULL,
  sent_at INTEGER,
  done_at INTEGER,
  UNIQUE (runner_id, hub_epoch, seq)
);
CREATE INDEX runner_commands_pending ON runner_commands (runner_id, status);

CREATE TABLE pending_deliveries (
  message_id INTEGER NOT NULL,
  attempt_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, attempt_id)
);

CREATE TABLE runner_inbox (
  runner_id TEXT NOT NULL,
  outbox_epoch TEXT NOT NULL,
  acked_seq INTEGER NOT NULL,
  PRIMARY KEY (runner_id, outbox_epoch)
);

CREATE TABLE runner_event_rejects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  runner_id TEXT NOT NULL,
  outbox_epoch TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  error TEXT NOT NULL,
  raw TEXT NOT NULL,
  at INTEGER NOT NULL
);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,               -- minted by the runner
  attempt_id TEXT NOT NULL,
  fence_epoch INTEGER NOT NULL,
  fence_counter INTEGER NOT NULL,
  runner_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  task_id TEXT,
  agent_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  detail TEXT NOT NULL,
  status TEXT NOT NULL,
  decided_by TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  decided_at INTEGER,
  lead_notified_at INTEGER
);
CREATE INDEX approvals_owner_status ON approvals (owner, status);

CREATE TABLE lead_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id TEXT,
  kind TEXT NOT NULL,                -- handoff | restatement
  body TEXT NOT NULL,
  author TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

/** M1's lead seat: the lead chat seen within the last 15 minutes. Only the migration to schema version 2 reads it. */
export const M1_LEAD_STALE_MS = 15 * 60_000;

/** The hub_state row starts with the migration, and M1's lead, if it is live now, keeps the seat. */
function seedHubState(db: Database, now: number): void {
  const lead = db
    .query("SELECT id FROM agents WHERE role = 'lead' AND last_seen_at > $cutoff ORDER BY last_seen_at DESC LIMIT 1")
    .get({ cutoff: now - M1_LEAD_STALE_MS }) as { id: string } | null;
  db.query(
    `INSERT INTO hub_state (id, last_alive_at, lead_agent_id, lead_kind, lead_since)
     VALUES (1, $now, $leadId, $kind, $since)`,
  ).run({ now, leadId: lead?.id ?? null, kind: lead ? 'live' : null, since: lead ? now : null });
}

/** Each migration runs in its own transaction, with the hub's clock. */
const MIGRATIONS: readonly ((db: Database, now: number) => void)[] = [
  (db) => db.run(SCHEMA_V1),
  (db, now) => {
    db.run(SCHEMA_V2);
    seedHubState(db, now);
  },
];

export function openDb(path: string, now: number): Database {
  const db = new Database(path, { create: true, strict: true });
  db.run('PRAGMA journal_mode = WAL;');
  db.run('PRAGMA foreign_keys = ON;');
  db.run('PRAGMA busy_timeout = 5000;');
  migrate(db, now);
  return db;
}

export function migrate(db: Database, now: number): void {
  db.run('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const row = db.query('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null };
  const version = row.v ?? 0;
  // Older code on a newer schema (after a rollback, or a restore of a newer backup) would misread the data.
  if (version > MIGRATIONS.length) {
    throw new Error(
      `database schema version ${version} is newer than this hub supports (${MIGRATIONS.length}); run a newer hub or restore an older backup`,
    );
  }
  for (let index = version; index < MIGRATIONS.length; index++) {
    const step = MIGRATIONS[index] as (db: Database, now: number) => void;
    db.transaction(() => {
      step(db, now);
      db.query('INSERT INTO schema_migrations (version, applied_at) VALUES ($version, $at)').run({
        version: index + 1,
        at: now,
      });
    })();
  }
}

export type CounterName = 'task' | 'agent' | 'runner' | 'fence' | 'lead_attempt' | 'submission';

export function nextId(db: Database, name: CounterName): number {
  const row = db.query('UPDATE counters SET value = value + 1 WHERE name = $name RETURNING value').get({ name }) as {
    value: number;
  } | null;
  if (!row) throw new Error(`unknown counter ${name}`);
  return row.value;
}
