// Attempt records and the process registry (design 6.3, 7.4). A record outlives the attempt's process, so a restart
// can report it in hello and finish its work; the registry lists every process group the runner recorded for it, so
// a restart can kill what a crash left behind. The spec is kept without its agent token (design 7.2): after a
// restart, the hub's resent command or resume carries a new one.
import type { AttemptSpec, Fence } from '@agflow/core';
import type { RunnerDb } from './db';

/** Design 6.3's LiveAttempt states, plus ended: the hub ended the attempt and its clone waits for cleanup. */
export type LocalAttemptState = 'starting' | 'running' | 'idle' | 'stopped' | 'suspended' | 'ended';

export type StoredAttemptSpec = Omit<AttemptSpec, 'agentToken'>;

export interface AttemptRecord {
  attemptId: string;
  /** The last start or resume's spec: a resume recomputes taskPack, restore and acceptanceIds. */
  spec: StoredAttemptSpec;
  /** The current fence: the spec's, then each resume's. */
  fence: Fence;
  state: LocalAttemptState;
  sessionRef: string | null;
  /** The clone's path. */
  clone: string | null;
  /** The private /tmp/agf/<id> directory of a Claude attempt. */
  tmpDir: string | null;
  /** The newest harvested work, held in the vault until it is pushed. */
  wipSha: string | null;
  /** What the WIP ref holds as last pushed: the lease of the next push. */
  pushedSha: string | null;
  lastPushAt: number | null;
  /** Late-work refs pushed so far; the next one is <attempt>-late-<count + 1>. */
  lateWorkCount: number;
  /**
   * Work held in the vault that waits for a late-work ref: set as its retries start (a final push, or a cleanup's push,
   * that failed or was refused), cleared when attempt.late_work reports it landed, when the cleanup pushed or dropped
   * it, or when a hand-back's push replaced it. A restart retries it after the first welcome, so it outlives the
   * process; while it is set, the attempt's work is not all on the origin (the unpushed-work marker).
   */
  lateWorkSha: string | null;
  /** The CLI version the attempt started with; every resume and take-over uses it (X-13). */
  cliVersion: string | null;
  endedAt: number | null;
  /** Final-work outcome and pending late work are durable; null before work or after crash recovery. */
  finalizedAt: number | null;
  /** The unresolved final-work error; successful late work, hand-back or cleanup resolution clears it. */
  pushError: string | null;
  createdAt: number;
  updatedAt: number;
}

/** The fields update may change. */
export type AttemptPatch = Partial<Omit<AttemptRecord, 'attemptId' | 'spec' | 'createdAt' | 'updatedAt'>> & {
  spec?: StoredAttemptSpec;
};

/** One recorded process group: its leader's identity and the clone it works in. */
export interface ProcessRecord {
  attemptId: string;
  pid: number;
  pgid: number;
  /** ps's lstart of the leader; with pid, the identity checked before every group kill. */
  lstart: string;
  clone: string | null;
}

interface AttemptRow {
  attempt_id: string;
  spec: string;
  fence: string;
  state: LocalAttemptState;
  session_ref: string | null;
  clone: string | null;
  tmp_dir: string | null;
  wip_sha: string | null;
  pushed_sha: string | null;
  last_push_at: number | null;
  late_work_count: number;
  late_work_sha: string | null;
  cli_version: string | null;
  ended_at: number | null;
  finalized_at: number | null;
  push_error: string | null;
  created_at: number;
  updated_at: number;
}

function recordOf(row: AttemptRow): AttemptRecord {
  return {
    attemptId: row.attempt_id,
    spec: JSON.parse(row.spec) as StoredAttemptSpec,
    fence: JSON.parse(row.fence) as Fence,
    state: row.state,
    sessionRef: row.session_ref,
    clone: row.clone,
    tmpDir: row.tmp_dir,
    wipSha: row.wip_sha,
    pushedSha: row.pushed_sha,
    lastPushAt: row.last_push_at,
    lateWorkCount: row.late_work_count,
    lateWorkSha: row.late_work_sha,
    cliVersion: row.cli_version,
    endedAt: row.ended_at,
    finalizedAt: row.finalized_at,
    pushError: row.push_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// A caller may hand over the full spec; the token is dropped here, whatever the static type says.
function withoutToken(spec: StoredAttemptSpec & { agentToken?: string }): StoredAttemptSpec {
  const { agentToken: _token, ...rest } = spec;
  return rest;
}

export class AttemptStore {
  private readonly now: () => number;

  constructor(
    private readonly db: RunnerDb,
    options: { now?: () => number } = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  /** Records a new attempt as starting. */
  create(
    spec: AttemptSpec | StoredAttemptSpec,
    init: { clone: string | null; tmpDir: string | null; cliVersion: string | null },
  ): AttemptRecord {
    const at = this.now();
    const stored = withoutToken(spec);
    this.db.sqlite
      .query(
        `INSERT INTO attempts (attempt_id, spec, fence, state, clone, tmp_dir, cli_version, created_at, updated_at)
         VALUES ($attemptId, $spec, $fence, 'starting', $clone, $tmpDir, $cliVersion, $at, $at)`,
      )
      .run({
        attemptId: stored.attemptId,
        spec: JSON.stringify(stored),
        fence: JSON.stringify(stored.fence),
        clone: init.clone,
        tmpDir: init.tmpDir,
        cliVersion: init.cliVersion,
        at,
      });
    return this.get(stored.attemptId) as AttemptRecord;
  }

  get(attemptId: string): AttemptRecord | null {
    const row = this.db.sqlite.query('SELECT * FROM attempts WHERE attempt_id = $attemptId').get({ attemptId });
    return row ? recordOf(row as AttemptRow) : null;
  }

  /** Every record, oldest first. */
  list(): AttemptRecord[] {
    const rows = this.db.sqlite.query('SELECT * FROM attempts ORDER BY created_at, rowid').all() as AttemptRow[];
    return rows.map(recordOf);
  }

  update(attemptId: string, patch: AttemptPatch): AttemptRecord {
    const current = this.get(attemptId);
    if (!current) throw new Error(`no attempt record for ${attemptId}`);
    const next: AttemptRecord = { ...current, ...patch, updatedAt: this.now() };
    if (patch.spec) next.spec = withoutToken(patch.spec);
    this.db.sqlite
      .query(
        `UPDATE attempts SET spec = $spec, fence = $fence, state = $state, session_ref = $sessionRef, clone = $clone,
           tmp_dir = $tmpDir, wip_sha = $wipSha, pushed_sha = $pushedSha, last_push_at = $lastPushAt,
           late_work_count = $lateWorkCount, late_work_sha = $lateWorkSha, cli_version = $cliVersion,
           ended_at = $endedAt, finalized_at = $finalizedAt, push_error = $pushError, updated_at = $updatedAt
         WHERE attempt_id = $attemptId`,
      )
      .run({
        attemptId,
        spec: JSON.stringify(next.spec),
        fence: JSON.stringify(next.fence),
        state: next.state,
        sessionRef: next.sessionRef,
        clone: next.clone,
        tmpDir: next.tmpDir,
        wipSha: next.wipSha,
        pushedSha: next.pushedSha,
        lastPushAt: next.lastPushAt,
        lateWorkCount: next.lateWorkCount,
        lateWorkSha: next.lateWorkSha,
        cliVersion: next.cliVersion,
        endedAt: next.endedAt,
        finalizedAt: next.finalizedAt,
        pushError: next.pushError,
        updatedAt: next.updatedAt,
      });
    return next;
  }

  /** Forgets the attempt and its recorded groups (cleanup_attempt). */
  remove(attemptId: string): void {
    this.db.sqlite.transaction(() => {
      this.db.sqlite.query('DELETE FROM attempts WHERE attempt_id = $attemptId').run({ attemptId });
      this.forgetProcesses(attemptId);
    })();
  }

  /** Records a process group, replacing an earlier record of the same group. */
  recordProcess(record: ProcessRecord): void {
    this.db.sqlite
      .query(
        `INSERT INTO processes (attempt_id, pgid, pid, lstart, clone, recorded_at)
         VALUES ($attemptId, $pgid, $pid, $lstart, $clone, $at)
         ON CONFLICT (attempt_id, pgid) DO UPDATE SET pid = $pid, lstart = $lstart, clone = $clone, recorded_at = $at`,
      )
      .run({ ...record, at: this.now() });
  }

  /** The recorded groups of one attempt, or of every attempt, in the order they were first recorded. */
  processes(attemptId?: string): ProcessRecord[] {
    const where = attemptId === undefined ? '' : 'WHERE attempt_id = $attemptId';
    const rows = this.db.sqlite.query(`SELECT * FROM processes ${where} ORDER BY rowid`).all(
      attemptId === undefined ? {} : { attemptId },
    ) as { attempt_id: string; pid: number; pgid: number; lstart: string; clone: string | null }[];
    return rows.map((row) => ({
      attemptId: row.attempt_id,
      pid: row.pid,
      pgid: row.pgid,
      lstart: row.lstart,
      clone: row.clone,
    }));
  }

  forgetProcess(attemptId: string, pgid: number): void {
    this.db.sqlite
      .query('DELETE FROM processes WHERE attempt_id = $attemptId AND pgid = $pgid')
      .run({ attemptId, pgid });
  }

  forgetProcesses(attemptId: string): void {
    this.db.sqlite.query('DELETE FROM processes WHERE attempt_id = $attemptId').run({ attemptId });
  }
}
