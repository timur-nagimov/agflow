import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type LiveAttempt, wipRef } from '@agflow/core';
import { getAttempt, updateAttempt } from '../src/attempt-store';
import { recentResumes, startRunnerAttempt } from '../src/attempts';
import { createSession, mintAgentToken, resolveAgentToken } from '../src/auth';
import { backupDatabase } from '../src/backup';
import { type HubContext, createContext, tx } from '../src/context';
import { SCHEMA_V1 } from '../src/db';
import type { HubError } from '../src/errors';
import { listEvents } from '../src/events';
import { Gateway } from '../src/gateway';
import { getHubState, hubEpoch } from '../src/hub-state';
import { insertMessage, listMessages } from '../src/messages';
import { RESTART_PROMPT, checkClock, dbLockRecord } from '../src/recovery';
import { COUNTER_ADVANCE, UNKNOWN_IDS_ADVANCE, markRestored, restoreBackup } from '../src/restore';
import { findRunnerRow, runnerInfo } from '../src/runners';
import { getTask, listTaskNotes, writeTask } from '../src/task-store';
import { createTasks } from '../src/tasks';
import { type FakeConnection, type FakeRunner, connectFakeRunner, settle } from './fake-runner';
import { addRunner, makeConfig, newTask } from './helpers';
import { createTestHub } from './http-helpers';

const NOW = Date.UTC(2026, 10, 9, 12, 0, 0);
const REPO_ROOT = join(import.meta.dir, '../../..');

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A hub data folder like the default: data/agflow.db and data/backups. */
function dataDir(): { dbPath: string; backupDir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'agflow-restore-'));
  dirs.push(dir);
  const backupDir = join(dir, 'backups');
  mkdirSync(backupDir);
  return { dbPath: join(dir, 'agflow.db'), backupDir };
}

/** A hub database with one task, its backup, and a second task created after the backup; the database is closed. */
function hubWithBackup(): { dbPath: string; backupDir: string; backupPath: string } {
  const { dbPath, backupDir } = dataDir();
  const ctx = createContext({ dbPath, config: makeConfig(), now: () => NOW });
  createTasks(ctx, [newTask({ title: 'Before the backup' })], 'user:alice');
  const backupPath = backupDatabase(ctx, backupDir, 'start');
  createTasks(ctx, [newTask({ title: 'After the backup' })], 'user:alice');
  ctx.db.close();
  return { dbPath, backupDir, backupPath };
}

const counters = (ctx: HubContext): Record<string, number> =>
  Object.fromEntries(
    (ctx.db.query('SELECT name, value FROM counters').all() as { name: string; value: number }[]).map((row) => [
      row.name,
      row.value,
    ]),
  );

const titles = (dbPath: string): string[] => {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.query('SELECT contract FROM tasks ORDER BY seq').all() as { contract: string }[]).map(
      (row) => (JSON.parse(row.contract) as { title: string }).title,
    );
  } finally {
    db.close();
  }
};

/** Leaves the database as a hub killed mid-write does: its last change only in -wal, with -shm beside it. */
async function crashWithWal(dbPath: string, epoch: number): Promise<void> {
  const script = `
    import { Database } from 'bun:sqlite';
    const db = new Database(process.argv[1]);
    db.run('PRAGMA journal_mode = WAL');
    db.run('PRAGMA wal_autocheckpoint = 0');
    db.run('UPDATE project SET epoch = ${epoch} WHERE id = 1');
    process.kill(process.pid, 'SIGKILL');
  `;
  const child = Bun.spawn(['bun', '--eval', script, dbPath], { stdout: 'ignore', stderr: 'inherit' });
  await child.exited;
}

describe('restoreBackup', () => {
  test('refuses while the pid file names a live hub; moves the files aside, copies, checks and migrates', async () => {
    const { dbPath, backupPath } = hubWithBackup();
    await crashWithWal(dbPath, 5);
    expect([existsSync(`${dbPath}-wal`), existsSync(`${dbPath}-shm`)]).toEqual([true, true]);
    const walBefore = readFileSync(`${dbPath}-wal`);

    const hub = Bun.spawn(['sleep', '30']);
    try {
      writeFileSync(`${dbPath}.pid`, dbLockRecord(hub.pid));
      expect(() => restoreBackup({ dbPath, backupPath, now: NOW })).toThrow(`is in use by process ${hub.pid}`);
      expect(existsSync(`${dbPath}-wal`)).toBe(true);
    } finally {
      hub.kill();
      await hub.exited;
    }

    const result = restoreBackup({ dbPath, backupPath, now: NOW });
    const aside = result.aside as string;
    expect(aside).toStartWith(`${dbPath}.replaced-`);
    expect(readFileSync(`${aside}-wal`)).toEqual(walBefore);
    expect(existsSync(`${aside}-shm`)).toBe(true);
    // The replaced database, with its WAL, is whole where it was put aside.
    expect(titles(aside)).toEqual(['Before the backup', 'After the backup']);
    expect(titles(dbPath)).toEqual(['Before the backup']);
    // Its epoch was readable, from the WAL: 5, so the restored hub's is 6.
    expect(result.epoch).toBe(6);
    expect(existsSync(`${dbPath}.pid`)).toBe(false);
    expect(existsSync(`${dbPath}-wal`) ? readFileSync(`${dbPath}-wal`).length : 0).toBe(0);
  });

  test('a backup that fails integrity_check is refused, and the replaced files go back', () => {
    const { dbPath, backupDir, backupPath } = hubWithBackup();
    // A row that breaks a CHECK constraint: the file opens and reads, and only integrity_check finds the fault.
    const broken = new Database(backupPath);
    broken.run('PRAGMA ignore_check_constraints = ON');
    broken.run('UPDATE project SET id = 2');
    broken.close();
    expect(() => restoreBackup({ dbPath, backupPath, now: NOW })).toThrow('database integrity check failed');
    // The backup was checked next to the database, which was never moved.
    expect(readdirSync(dirname(dbPath)).filter((name) => /restoring|replaced/.test(name))).toEqual([]);
    expect(titles(dbPath)).toEqual(['Before the backup', 'After the backup']);
    expect(existsSync(`${dbPath}.pid`)).toBe(false);
    expect(() => restoreBackup({ dbPath, backupPath: join(backupDir, 'missing.db'), now: NOW })).toThrow(
      'no backup at',
    );
  });

  test('a schema version 1 backup is migrated', () => {
    const { dbPath, backupDir } = dataDir();
    const old = join(backupDir, 'agflow-v1.db');
    const db = new Database(old);
    db.run(SCHEMA_V1);
    db.run('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
    db.run('INSERT INTO schema_migrations (version, applied_at) VALUES (1, 0)');
    db.run("INSERT INTO project (id, name, repo, paused) VALUES (1, 'demo', 'https://github.com/acme/demo', 0)");
    db.close();
    expect(restoreBackup({ dbPath, backupPath: old, now: NOW }).epoch).toBe(2);
    const restored = new Database(dbPath, { readonly: true });
    expect(restored.query('SELECT MAX(version) AS v FROM schema_migrations').get()).toEqual({ v: 2 });
    expect(restored.query('SELECT epoch FROM project').get()).toEqual({ epoch: 2 });
    restored.close();
  });

  test('the epoch, counters, branch heads, restored_at and system.restored; bun run restore works', async () => {
    const { dbPath, backupDir } = dataDir();
    const ctx = createContext({ dbPath, config: makeConfig(), now: () => NOW });
    const [task] = createTasks(ctx, [newTask()], 'user:alice');
    writeTask(ctx, task?.id as string, { branchHead: 'b'.repeat(40) });
    const before = counters(ctx);
    const backupPath = backupDatabase(ctx, backupDir, 'daily');
    ctx.db.close();
    // An earlier restore from this folder recorded epoch 3, which the backup and the replaced database are below.
    writeFileSync(join(backupDir, 'epoch'), '3\n');

    expect(restoreBackup({ dbPath, backupPath, now: NOW + 1 }).epoch).toBe(4);
    expect(readFileSync(join(backupDir, 'epoch'), 'utf8').trim()).toBe('4');
    const restored = createContext({ dbPath, config: makeConfig(), now: () => NOW + 2 });
    expect(hubEpoch(restored)).toBe(4);
    expect(counters(restored)).toEqual({
      ...before,
      task: (before.task ?? 0) + 1000,
      agent: (before.agent ?? 0) + 1000,
      runner: (before.runner ?? 0) + 1000,
      lead_attempt: (before.lead_attempt ?? 0) + 1000,
      submission: (before.submission ?? 0) + 1000,
    });
    expect(restored.db.query('SELECT branch_head FROM tasks').all()).toEqual([{ branch_head: null }]);
    expect(getHubState(restored).restoredAt).toBe(NOW + 1);
    const events = listEvents(restored.db).filter((event) => event.type === 'system.restored');
    expect(events.map((event) => [event.ts, event.subject, event.data])).toEqual([[NOW + 1, null, { epoch: 4 }]]);
    restored.db.close();

    // The root script: the replaced database (4) and the folder's record (4) are the highest now.
    const cli = Bun.spawn(['bun', 'run', 'restore', backupPath], {
      cwd: REPO_ROOT,
      env: { PATH: process.env.PATH ?? '', HOME: backupDir, AGFLOW_DB: dbPath },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [code, out] = await Promise.all([cli.exited, new Response(cli.stdout).text()]);
    expect(code).toBe(0);
    expect(out).toContain('epoch 5');
    expect(readFileSync(join(backupDir, 'epoch'), 'utf8').trim()).toBe('5');
    const usage = Bun.spawnSync(['bun', 'run', 'restore'], {
      cwd: REPO_ROOT,
      env: { PATH: process.env.PATH ?? '', HOME: backupDir, AGFLOW_DB: dbPath },
    });
    expect(usage.exitCode).toBe(2);
    expect(usage.stderr.toString()).toContain('usage: bun run restore <backup>');
  }, 20_000);

  test('event and message ids go on past the newest of both databases', () => {
    const { dbPath, backupDir } = dataDir();
    const ctx = createContext({ dbPath, config: makeConfig(), now: () => NOW });
    const say = (body: string) => tx(ctx, (emit) => insertMessage(ctx, emit, { from: 'user:alice', to: 'humans', body }));
    say('before the backup');
    const backupPath = backupDatabase(ctx, backupDir, 'daily');
    // The old hub went on after the backup: clients and runners hold these ids as cursors.
    const after = say('after the backup');
    createTasks(ctx, [newTask()], 'user:alice');
    const lastEvent = Math.max(...listEvents(ctx.db).map((event) => event.id));
    ctx.db.close();

    restoreBackup({ dbPath, backupPath, now: NOW });
    const restored = createContext({ dbPath, config: makeConfig(), now: () => NOW });
    const [marked] = listEvents(restored.db).filter((event) => event.type === 'system.restored');
    expect(marked?.id).toBe(lastEvent + COUNTER_ADVANCE + 1);
    const next = tx(restored, (emit) => insertMessage(restored, emit, { from: 'user:alice', to: 'humans', body: 'new' }));
    expect(next.id).toBe(after.id + COUNTER_ADVANCE + 1);
    restored.db.close();

    // A replaced database that cannot be read leaves its newest ids unknown: they jump far.
    writeFileSync(dbPath, 'not a database');
    restoreBackup({ dbPath, backupPath, now: NOW + 1 });
    const again = new Database(dbPath, { readonly: true });
    expect(again.query("SELECT seq FROM sqlite_sequence WHERE name = 'messages'").get()).toEqual({
      seq: 1 + UNKNOWN_IDS_ADVANCE,
    });
    again.close();
  });

  test('unknown agent tokens answer attempt_refenced for runnerLeaseMs from when the restored hub starts', () => {
    const { dbPath, backupPath } = hubWithBackup();
    const restoredAt = NOW + 60_000;
    restoreBackup({ dbPath, backupPath, now: restoredAt });
    // The restored hub starts an hour after the restore, when a window counted from the restore would be over.
    let now = restoredAt + 60 * 60_000;
    const ctx = createContext({ dbPath, config: makeConfig(), now: () => now });
    expect(now - restoredAt).toBeGreaterThan(ctx.config.runnerLeaseMs);
    const unknown = `agt_${'U'.repeat(43)}`;
    const answer = () => {
      try {
        resolveAgentToken(ctx, unknown);
        return null;
      } catch (error) {
        return (error as HubError).code;
      }
    };
    checkClock(ctx);
    expect(getHubState(ctx).restoredAt).toBe(now);
    expect(answer()).toBe('attempt_refenced');
    // Later checks leave it where the start put it.
    now += ctx.config.runnerLeaseMs - 1;
    checkClock(ctx);
    expect(answer()).toBe('attempt_refenced');
    now += 1;
    checkClock(ctx);
    expect(answer()).toBe('attempt_ended');
    ctx.db.close();
  });

  test('new ids, WIP refs and branches carry the epoch', () => {
    const hub = createTestHub();
    const { ctx } = hub;
    const runnerId = addRunner(ctx);
    markRestored(ctx.db, { epoch: 2, now: ctx.now() });
    const [task] = createTasks(ctx, [newTask({ title: 'Add the parser' })], 'user:alice');
    expect(task?.id).toBe('T-1001');
    const { attempt } = startRunnerAttempt(ctx, { runnerId, taskId: 'T-1001', role: 'worker', vendor: 'claude' });
    expect(attempt.id).toBe('T-1001-e2-a1');
    expect(attempt.fence.epoch).toBe(2);
    expect(attempt.wipRef).toBe('refs/agflow/T-1001/e2-a1');
    expect(getTask(ctx, 'T-1001').branch).toBe('agflow/T-1001-e2-add-the-parser');
  });
});

describe('after a restore', () => {
  type Link = FakeRunner<FakeConnection>;

  /**
   * R-1 connected at epoch 1 with: a worker on T-1, which its task names; a worker on T-2, which its task no longer
   * names in the restored database; and the runner lead, which the seat names. Then the hub is restored (epoch 2).
   */
  async function restoredHub() {
    const hub = createTestHub();
    const { ctx } = hub;
    const runnerId = addRunner(ctx);
    const ids = createTasks(
      ctx,
      [newTask({ title: 'Named' }), newTask({ title: 'Superseded' }), newTask({ title: 'Late work' })],
      'user:alice',
    ).map((task) => task.id);
    const gateway = new Gateway(ctx);
    const live: LiveAttempt[] = [];
    const runner = await connectFakeRunner(ctx, gateway, {
      token: createSession(ctx, 'alice', 'cli'),
      attempts: () => live,
    });
    const start = (taskId: string | null) =>
      startRunnerAttempt(ctx, { runnerId, taskId, role: taskId ? 'worker' : 'lead', vendor: 'claude' }).attempt;
    const named = start(ids[0] as string);
    const superseded = start(ids[1] as string);
    const lead = start(null);
    await settle();
    for (const attempt of [named, superseded, lead]) runner.startRunning(attempt.id);
    await settle();
    const token = mintAgentToken(ctx, getAttempt(ctx, named.id));
    runner.disconnect();
    await settle();
    // In the restored database T-2 names another attempt than the one R-1 still runs for it.
    ctx.db.query("UPDATE tasks SET current_attempt = 'T-2-a9' WHERE id = 'T-2'").run();
    markRestored(ctx.db, { epoch: 2, now: ctx.now() });
    const report = (attemptId: string, fence = getAttempt(ctx, attemptId).fence): LiveAttempt => ({
      attemptId,
      fence,
      state: 'running',
      sessionRef: `session-${attemptId}`,
      clone: true,
    });
    live.push(report(named.id), report(superseded.id), report(lead.id));
    live.push(report('T-3-a7', { epoch: 1, counter: 99 }));
    return { hub, ctx, runnerId, runner, ids, named, superseded, lead, token, live };
  }

  const resumesOf = (runner: Link, attemptId: string) =>
    runner.commands.flatMap((message) =>
      message.command.kind === 'resume_attempt' && message.command.attemptId === attemptId ? [message.command] : [],
    );

  const restorePending = (ctx: HubContext, runnerId: string) =>
    runnerInfo(findRunnerRow(ctx, runnerId) as NonNullable<ReturnType<typeof findRunnerRow>>).restorePending ?? false;

  test('superseded and unknown attempts go to welcome.stop; named ones are re-fenced after the replay', async () => {
    const { hub, ctx, runnerId, runner, named, superseded, lead, token } = await restoredHub();
    // WIP the named attempt pushed after the backup, at a fence the restored hub never issued.
    const newer = { epoch: 1, counter: getAttempt(ctx, named.id).fence.counter + 5 };
    const wip = { ref: wipRef(ctx.config.wipRefPrefix, named.id), sha: 'd'.repeat(40) };
    runner.emit('attempt.wip', { ...wip, stripped: [], skipped: [], embedded: [], logStat: '' }, {
      attemptId: named.id,
      fence: newer,
    });

    const welcome = await runner.connect();
    expect(welcome?.hubEpoch).toBe(2);
    expect(welcome?.stop).toEqual([
      { attemptId: superseded.id, reason: 'the attempt ended (superseded)' },
      { attemptId: 'T-3-a7', reason: 'the hub does not know this attempt' },
    ]);
    expect(getAttempt(ctx, superseded.id)).toMatchObject({ status: 'ended', endReason: 'superseded' });
    await settle();

    // The replay came first: the WIP sent after the backup counted as current.
    expect(getTask(ctx, 'T-1')).toMatchObject({ workSha: 'd'.repeat(40) });
    for (const attempt of [named, lead]) {
      const after = getAttempt(ctx, attempt.id);
      expect([attempt.id, after.status, after.fence.epoch]).toEqual([attempt.id, 'starting', 2]);
      const [resume] = resumesOf(runner, attempt.id);
      expect(resume?.fence).toEqual(after.fence);
      expect(resume?.prompt).toBe(RESTART_PROMPT);
      expect(recentResumes(ctx, attempt.id, 'runner_restart', ctx.config.resumeWindowMs)).toBe(0);
    }
    expect(restorePending(ctx, runnerId)).toBe(false);
    // The old token is refused for good now; the one the resume brought works.
    const old = await hub.call('GET', '/api/tasks', { headers: { authorization: `Bearer ${token}` } });
    expect([old.status, old.json.error]).toEqual([401, 'attempt_ended']);
    const fresh = runner.tokens.get(named.id) as string;
    expect((await hub.call('GET', '/api/tasks', { headers: { authorization: `Bearer ${fresh}` } })).status).toBe(200);
  });

  test('a lead the seat no longer names ends superseded; a holding attempt keeps its rows', async () => {
    const { ctx, runner, named, lead, live } = await restoredHub();
    ctx.db.run('UPDATE hub_state SET lead_agent_id = NULL WHERE id = 1');
    updateAttempt(ctx, named.id, { status: 'holding' });
    live[0] = { ...(live[0] as LiveAttempt), state: 'stopped', clone: false };
    const welcome = await runner.connect();
    expect(welcome?.stop).toContainEqual({ attemptId: lead.id, reason: 'the attempt ended (superseded)' });
    expect(getAttempt(ctx, lead.id)).toMatchObject({ status: 'ended', endReason: 'superseded' });
    await settle();
    // A holding attempt has no process to re-fence: the ordinary rows decide it, here as one that cannot resume.
    expect(getAttempt(ctx, named.id)).toMatchObject({ status: 'holding', resumable: false, fence: { epoch: 1 } });
    expect([resumesOf(runner, lead.id), resumesOf(runner, named.id)]).toEqual([[], []]);
  });

  test('old tokens get attempt_refenced until the re-fence; a link that drops first leaves it pending', async () => {
    const { hub, ctx, runnerId, runner, named, token } = await restoredHub();
    // The runner holds two events, and this link delivers only the first: the replay cannot complete on it.
    const at = { attemptId: named.id, fence: getAttempt(ctx, named.id).fence };
    runner.emit('attempt.activity', { kind: 'note', summary: 'one' }, at);
    const held = runner.emit('attempt.activity', { kind: 'note', summary: 'two' }, at);
    runner.outbox = runner.outbox.filter((event) => event.seq !== held.seq);
    await runner.connect();
    await settle();
    expect(restorePending(ctx, runnerId)).toBe(true);
    expect(getAttempt(ctx, named.id).fence.epoch).toBe(1);
    expect(resumesOf(runner, named.id)).toEqual([]);
    const refused = await hub.call('GET', '/api/tasks', { headers: { authorization: `Bearer ${token}` } });
    expect([refused.status, refused.json.error]).toEqual([401, 'attempt_refenced']);
    // An unknown token too, within runnerLeaseMs of the restore: its attempt is about to be re-fenced.
    const unknown = await hub.call('GET', '/api/tasks', { headers: { authorization: `Bearer agt_${'U'.repeat(43)}` } });
    expect(unknown.json.error).toBe('attempt_refenced');

    // The next hello decides again, although the runner stored epoch 2 from the welcome.
    runner.disconnect();
    await settle();
    expect(runner.lastHubEpoch).toBe(2);
    runner.outbox.push(held);
    await runner.connect();
    await settle();
    expect(restorePending(ctx, runnerId)).toBe(false);
    expect(getAttempt(ctx, named.id)).toMatchObject({ status: 'starting', fence: { epoch: 2 } });
    expect(resumesOf(runner, named.id)).toHaveLength(1);
  });

  test('a start the runner never had, queued before the restore, goes out again at a fence of the new epoch', async () => {
    const hub = createTestHub();
    const { ctx } = hub;
    const runnerId = addRunner(ctx);
    const [task] = createTasks(ctx, [newTask()], 'user:alice');
    const runner = await connectFakeRunner(ctx, new Gateway(ctx), { token: createSession(ctx, 'alice', 'cli') });
    runner.disconnect();
    await settle();
    // Queued while the runner is away, before the backup; the runner comes back only after the restore.
    const { attempt } = startRunnerAttempt(ctx, { runnerId, taskId: task?.id as string, role: 'worker', vendor: 'claude' });
    expect(attempt.fence.epoch).toBe(1);
    markRestored(ctx.db, { epoch: 2, now: ctx.now() });

    await runner.connect();
    await settle();
    const after = getAttempt(ctx, attempt.id);
    expect([after.status, after.fence.epoch]).toEqual(['starting', 2]);
    const starts = runner.commands.flatMap((message) =>
      message.command.kind === 'start_attempt' ? [message.command.attempt.fence] : [],
    );
    expect(starts).toEqual([after.fence]);
    const token = runner.tokens.get(attempt.id) as string;
    expect((await hub.call('GET', '/api/tasks', { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
    runner.startRunning(attempt.id);
    await settle();
    expect(getAttempt(ctx, attempt.id)).toMatchObject({ status: 'running', fence: after.fence });
    expect((await hub.call('GET', '/api/tasks', { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
  });

  test('late work of unknown attempts becomes a task note, or a message to people without the task', async () => {
    const { ctx, runner, ids } = await restoredHub();
    const unknownFence = { epoch: 1, counter: 99 };
    const late = { ref: 'refs/agflow/T-3/a7-late', sha: 'e'.repeat(40) };
    runner.emit('attempt.late_work', { taskId: ids[2] as string, ...late }, { attemptId: 'T-3-a7', fence: unknownFence });
    runner.emit('attempt.late_work', { taskId: 'T-77', ref: 'refs/agflow/T-77/a1-late', sha: 'f'.repeat(40) }, {
      attemptId: 'T-77-a1',
      fence: unknownFence,
    });
    await runner.connect();
    await settle();
    const [note] = listTaskNotes(ctx, ids[2] as string).filter((one) => one.kind === 'late_work');
    expect(note).toMatchObject({ attemptId: 'T-3-a7' });
    expect(note?.body).toContain('refs/agflow/T-3/a7-late');
    const toPeople = listMessages(ctx, {}).filter((message) => message.to === 'humans');
    expect(toPeople.map((message) => message.body)).toEqual([expect.stringContaining('no task T-77')]);
  });
});
