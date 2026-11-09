// runner.db (design 6.3, 7.4): the runner's durable state in bun:sqlite. The outbox, the command journal, the attempt
// records, the process registry and a little meta live here; nothing in it is secret (design 7.2). Versioned
// migrations work like the hub's db.ts, and callers may add named migrations of their own (M2c's tables), so no
// other plan has to edit this file.
import { randomUUID } from 'node:crypto';
import { Database } from 'bun:sqlite';

const SCHEMA_V1 = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  type TEXT NOT NULL,
  attempt_id TEXT,
  event TEXT NOT NULL
);
CREATE INDEX outbox_at ON outbox (at);

CREATE TABLE outbox_ack (id INTEGER PRIMARY KEY CHECK (id = 1), seq INTEGER NOT NULL);
INSERT INTO outbox_ack (id, seq) VALUES (1, 0);

CREATE TABLE journal (
  command_id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  attempt_id TEXT,
  idempotency_key TEXT UNIQUE,
  command TEXT NOT NULL,
  outbox_seq INTEGER,
  state TEXT NOT NULL,
  result TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX journal_state ON journal (state);
CREATE INDEX journal_started ON journal (started_at);

CREATE TABLE attempts (
  attempt_id TEXT PRIMARY KEY,
  spec TEXT NOT NULL,
  fence TEXT NOT NULL,
  state TEXT NOT NULL,
  session_ref TEXT,
  clone TEXT,
  tmp_dir TEXT,
  wip_sha TEXT,
  pushed_sha TEXT,
  last_push_at INTEGER,
  late_work_count INTEGER NOT NULL DEFAULT 0,
  late_work_sha TEXT,
  cli_version TEXT,
  ended_at INTEGER,
  push_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE processes (
  attempt_id TEXT NOT NULL,
  pgid INTEGER NOT NULL,
  pid INTEGER NOT NULL,
  lstart TEXT NOT NULL,
  clone TEXT,
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY (attempt_id, pgid)
);
`;

const MIGRATIONS: readonly string[] = [SCHEMA_V1, 'ALTER TABLE attempts ADD COLUMN finalized_at INTEGER;'];

/** A migration another plan adds; it runs once, identified by its name, after the runner's own. */
export interface RunnerMigration {
  name: string;
  sql: string;
}

/**
 * A runner.settings event an update_settings echo answered, with the echo's version: it counts once runner.json's
 * confirmed snapshot has that version (Outbox.settingsInFlight). refused: a probe's echo showed the hub refused it.
 */
export interface SettingsMark {
  seq: number;
  version: number;
  refused?: true;
}

/** The meta values the runner keeps between runs. */
export interface RunnerMeta {
  /** The runner.settings that update_settings echoes answered, of those the outbox keeps (Outbox.markSettingsEcho). */
  settingsEchoed: SettingsMark[] | null;
  /** The version of the snapshot runner.json was last written with (Outbox.settingsSaved). */
  settingsSavedVersion: number | null;
  /** The hub epoch of the last welcome; hello reports it, so a restored hub knows to reconcile. */
  lastHubEpoch: number | null;
  /** The last welcome's wipRefPrefix, for pushes made before the next welcome. */
  wipRefPrefix: string | null;
  /** The project's name and repo from GET /api/status; the project key names the vault and work directories. */
  project: { name: string; repo: string } | null;
}

const OUTBOX_EPOCH = 'outboxEpoch';

export class RunnerDb {
  /** New whenever runner.db is new, so the hub can tell a fresh outbox from one it has acknowledged before. */
  readonly outboxEpoch: string;

  constructor(
    readonly sqlite: Database,
    readonly path: string,
  ) {
    const row = sqlite.query('SELECT value FROM meta WHERE key = $key').get({ key: OUTBOX_EPOCH }) as {
      value: string;
    } | null;
    if (!row) throw new Error(`${path} has no outbox epoch`);
    this.outboxEpoch = JSON.parse(row.value) as string;
  }

  meta<K extends keyof RunnerMeta>(key: K): RunnerMeta[K] {
    const row = this.sqlite.query('SELECT value FROM meta WHERE key = $key').get({ key }) as { value: string } | null;
    return row ? (JSON.parse(row.value) as RunnerMeta[K]) : null;
  }

  setMeta<K extends keyof RunnerMeta>(key: K, value: RunnerMeta[K]): void {
    this.sqlite
      .query('INSERT INTO meta (key, value) VALUES ($key, $value) ON CONFLICT (key) DO UPDATE SET value = $value')
      .run({ key, value: JSON.stringify(value) });
  }

  /** The names of the extra migrations applied so far, in the order they ran. */
  appliedMigrations(): string[] {
    const rows = this.sqlite.query('SELECT name FROM extra_migrations ORDER BY rowid').all() as { name: string }[];
    return rows.map((row) => row.name);
  }

  close(): void {
    this.sqlite.close();
  }
}

export function openRunnerDb(path: string, options: { migrations?: readonly RunnerMigration[] } = {}): RunnerDb {
  const sqlite = new Database(path, { create: true, strict: true });
  try {
    sqlite.run('PRAGMA journal_mode = WAL;');
    sqlite.run('PRAGMA busy_timeout = 5000;');
    migrate(sqlite);
    migrateExtra(sqlite, options.migrations ?? []);
    // Written once, by whoever creates the database: a deleted and recreated runner.db gets a new epoch.
    sqlite
      .query('INSERT OR IGNORE INTO meta (key, value) VALUES ($key, $value)')
      .run({ key: OUTBOX_EPOCH, value: JSON.stringify(randomUUID()) });
    return new RunnerDb(sqlite, path);
  } catch (error) {
    sqlite.close();
    throw error;
  }
}

function migrate(sqlite: Database): void {
  sqlite.run('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const row = sqlite.query('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null };
  const version = row.v ?? 0;
  // Older code on a newer schema (after a downgrade) would misread the data.
  if (version > MIGRATIONS.length) {
    throw new Error(
      `runner.db schema version ${version} is newer than this runner supports (${MIGRATIONS.length}); ` +
        'run a newer agflow',
    );
  }
  for (let index = version; index < MIGRATIONS.length; index++) {
    const sql = MIGRATIONS[index] as string;
    sqlite.transaction(() => {
      sqlite.run(sql);
      sqlite
        .query('INSERT INTO schema_migrations (version, applied_at) VALUES ($version, $at)')
        .run({ version: index + 1, at: Date.now() });
    })();
  }
}

function migrateExtra(sqlite: Database, migrations: readonly RunnerMigration[]): void {
  const names = new Set<string>();
  for (const { name } of migrations) {
    if (names.has(name)) throw new Error(`two runner.db migrations are named ${name}`);
    names.add(name);
  }
  sqlite.run('CREATE TABLE IF NOT EXISTS extra_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const applied = sqlite.query('SELECT 1 FROM extra_migrations WHERE name = $name');
  for (const { name, sql } of migrations) {
    if (applied.get({ name })) continue;
    sqlite.transaction(() => {
      sqlite.run(sql);
      sqlite.query('INSERT INTO extra_migrations (name, applied_at) VALUES ($name, $at)').run({ name, at: Date.now() });
    })();
  }
}
