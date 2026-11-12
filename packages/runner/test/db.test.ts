import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AttemptSpec, AttemptSpecSchema, type RunnerCommand } from '@agflow/core';
import { AttemptStore } from '../src/attempt-store';
import { openRunnerDb, type RunnerDb } from '../src/db';
import { idempotencyKey, Journal } from '../src/journal';
import { MAX_EVENT_BYTES, Outbox } from '../src/outbox';

const dirs: string[] = [];
const dbs: RunnerDb[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function dbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agflow-runner-db-'));
  dirs.push(dir);
  return join(dir, 'runner.db');
}

function open(path = dbPath(), options: Parameters<typeof openRunnerDb>[1] = {}): RunnerDb {
  const db = openRunnerDb(path, options);
  dbs.push(db);
  return db;
}

function reopen(db: RunnerDb, options: Parameters<typeof openRunnerDb>[1] = {}): RunnerDb {
  db.close();
  dbs.splice(dbs.indexOf(db), 1);
  return open(db.path, options);
}

const TOKEN = `agt_${'Q'.repeat(43)}`;
const fence = { epoch: 1, counter: 7 };

function spec(overrides: Partial<AttemptSpec> = {}): AttemptSpec {
  return AttemptSpecSchema.parse({
    attemptId: 'T-4-a1',
    taskId: 'T-4',
    role: 'worker',
    vendor: 'claude',
    model: null,
    fence,
    agentToken: TOKEN,
    hubUrl: 'http://127.0.0.1:7000',
    repo: { url: '/tmp/origin.git', mainBranch: 'main' },
    start: { ref: 'refs/heads/main', sha: null },
    branch: 'agflow/T-4-tidy',
    wipRef: 'refs/agflow/T-4/a1',
    restore: { paths: ['.claude/**'], base: 'refs/heads/main' },
    acceptanceIds: ['A1'],
    toolCaps: { defaultMs: 600_000, longMs: 1_800_000, checks: [] },
    taskPack: '# T-4',
    brief: 'brief',
    firstPrompt: 'start',
    successor: false,
    ...overrides,
  });
}

function stateEvent(detail: string) {
  return { type: 'runner.state', data: { state: 'ok', detail } } as const;
}

/** A clock the test sets by hand. */
function manualNow(start = 1_000_000) {
  const clock = { t: start, now: () => clock.t };
  return clock;
}

describe('openRunnerDb', () => {
  test('a new runner.db gets a fresh outboxEpoch that survives reopening; a recreated one gets a new one', () => {
    const path = dbPath();
    const first = open(path);
    const epoch = first.outboxEpoch;
    expect(epoch).toMatch(/^[0-9a-f-]{36}$/);
    const again = reopen(first);
    expect(again.outboxEpoch).toBe(epoch);
    again.close();
    dbs.splice(dbs.indexOf(again), 1);
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
    expect(open(path).outboxEpoch).not.toBe(epoch);
  });

  test('refuses a schema newer than the code', () => {
    const db = open();
    db.sqlite.run('INSERT INTO schema_migrations (version, applied_at) VALUES (99, 0)');
    const path = db.path;
    db.close();
    dbs.splice(dbs.indexOf(db), 1);
    expect(() => openRunnerDb(path)).toThrow(/schema version 99 is newer/);
  });

  test('runs extra named migrations once each, in order', () => {
    const a = { name: 'm2c.health', sql: 'CREATE TABLE health (id INTEGER PRIMARY KEY, note TEXT NOT NULL);' };
    const b = { name: 'm2c.health-seed', sql: "INSERT INTO health (note) VALUES ('seeded');" };
    const c = { name: 'm2c.health-more', sql: "INSERT INTO health (note) VALUES ('more');" };
    const db = open(dbPath(), { migrations: [a, b] });
    const again = reopen(db, { migrations: [a, b, c] });
    const notes = again.sqlite.query('SELECT note FROM health ORDER BY id').all() as { note: string }[];
    expect(notes.map((row) => row.note)).toEqual(['seeded', 'more']);
    expect(again.appliedMigrations()).toEqual(['m2c.health', 'm2c.health-seed', 'm2c.health-more']);
  });

  test('refuses two extra migrations with one name', () => {
    const twice = { name: 'm2c.x', sql: 'SELECT 1;' };
    expect(() => open(dbPath(), { migrations: [twice, twice] })).toThrow(/m2c.x/);
  });

  test('keeps lastHubEpoch, wipRefPrefix, the project and the main branch in meta', () => {
    const db = open();
    expect(db.meta('lastHubEpoch')).toBeNull();
    expect(db.meta('wipRefPrefix')).toBeNull();
    expect(db.meta('project')).toBeNull();
    expect(db.meta('mainBranch')).toBeNull();
    const project = { hubUrl: 'https://hub.example.com', name: 'demo', repo: 'git@example.com:demo.git' };
    db.setMeta('lastHubEpoch', 3);
    db.setMeta('wipRefPrefix', 'refs/agflow/');
    db.setMeta('project', project);
    db.setMeta('mainBranch', 'trunk');
    const again = reopen(db);
    expect(again.meta('lastHubEpoch')).toBe(3);
    expect(again.meta('wipRefPrefix')).toBe('refs/agflow/');
    expect(again.meta('project')).toEqual(project);
    expect(again.meta('mainBranch')).toBe('trunk');
  });
});

describe('Outbox', () => {
  test('append assigns increasing seqs and eventsAfter returns them in order', () => {
    const clock = manualNow();
    const outbox = new Outbox(open(), { now: clock.now });
    const first = outbox.append(stateEvent('one'));
    clock.t += 5;
    const second = outbox.append({
      type: 'attempt.activity',
      attemptId: 'T-4-a1',
      fence,
      data: { kind: 'note', summary: 'two' },
    });
    expect(first).toEqual({ seq: 1, at: 1_000_000, type: 'runner.state', data: { state: 'ok', detail: 'one' } });
    expect(second.seq).toBe(2);
    expect(second.at).toBe(1_000_005);
    expect(outbox.eventsAfter(0)).toEqual([first, second]);
    expect(outbox.eventsAfter(1)).toEqual([second]);
    expect(outbox.eventsAfter(0, 1)).toEqual([first]);
  });

  test('append refuses an event the hub could not read', () => {
    const outbox = new Outbox(open());
    const unreadable = { type: 'runner.state', data: { state: 'asleep', detail: null } } as never;
    expect(() => outbox.append(unreadable)).toThrow(/runner.state/);
    expect(outbox.lastSeq()).toBe(0);
  });

  test('append refuses an event over MAX_EVENT_BYTES, which no hub message could carry', () => {
    const outbox = new Outbox(open());
    outbox.append(stateEvent('kept'));
    expect(() => outbox.append(stateEvent('x'.repeat(MAX_EVENT_BYTES)))).toThrow(/too large/);
    expect(outbox.lastSeq()).toBe(1);
    // Just under the cap is fine.
    const fits = stateEvent('x'.repeat(MAX_EVENT_BYTES - 200));
    expect(outbox.append(fits).seq).toBe(2);
  });

  test('tells listeners about each appended event after the append returns', async () => {
    const outbox = new Outbox(open());
    const seen: number[] = [];
    const stop = outbox.onAppend((event) => seen.push(event.seq));
    outbox.append(stateEvent('one'));
    outbox.append(stateEvent('two'));
    expect(seen).toEqual([]);
    await Promise.resolve();
    expect(seen).toEqual([1, 2]);
    stop();
    outbox.append(stateEvent('three'));
    await Promise.resolve();
    expect(seen).toEqual([1, 2]);
  });

  test('listeners hear only committed events: a rolled-back append is never announced', async () => {
    const db = open();
    const outbox = new Outbox(db);
    const seen: { seq: number; detail: string }[] = [];
    outbox.onAppend((event) => seen.push({ seq: event.seq, detail: (event.data as { detail: string }).detail }));
    outbox.append(stateEvent('one'));
    const rolledBack = db.sqlite.transaction(() => {
      outbox.append(stateEvent('rolled back'));
      throw new Error('the surrounding update failed');
    });
    expect(() => rolledBack()).toThrow(/surrounding/);
    // SQLite rolls AUTOINCREMENT back too, so the next event reuses seq 2.
    outbox.append(stateEvent('two'));
    await Promise.resolve();
    expect(seen).toEqual([
      { seq: 1, detail: 'one' },
      { seq: 2, detail: 'two' },
    ]);
  });

  test('ack is cumulative and ignores another outbox epoch', () => {
    const db = open();
    const outbox = new Outbox(db);
    for (const detail of ['a', 'b', 'c']) outbox.append(stateEvent(detail));
    expect(outbox.ackedSeq()).toBe(0);
    expect(outbox.ack('another-epoch', 3)).toBe(false);
    expect(outbox.ackedSeq()).toBe(0);
    expect(outbox.ack(db.outboxEpoch, 2)).toBe(true);
    expect(outbox.ack(db.outboxEpoch, 1)).toBe(true);
    expect(outbox.ackedSeq()).toBe(2);
    expect(new Outbox(reopen(db)).ackedSeq()).toBe(2);
  });

  test('pruneAcked drops only acknowledged events older than the cutoff', () => {
    const clock = manualNow();
    const db = open();
    const outbox = new Outbox(db, { now: clock.now });
    outbox.append(stateEvent('old acked'));
    outbox.append(stateEvent('old unacked'));
    clock.t += 60_000;
    outbox.append(stateEvent('new'));
    outbox.ack(db.outboxEpoch, 1);
    clock.t += 1_000;
    expect(outbox.pruneAcked(30_000)).toBe(1);
    expect(outbox.eventsAfter(0).map((event) => event.seq)).toEqual([2, 3]);
    // Acknowledging the rest still keeps the young event.
    outbox.ack(db.outboxEpoch, 3);
    expect(outbox.pruneAcked(30_000)).toBe(1);
    expect(outbox.eventsAfter(0).map((event) => event.seq)).toEqual([3]);
  });

  test('pruneBefore drops events older than a time, acknowledged or not, so firstSeq rises', () => {
    const clock = manualNow();
    const outbox = new Outbox(open(), { now: clock.now });
    outbox.append(stateEvent('a'));
    clock.t += 10;
    outbox.append(stateEvent('b'));
    clock.t += 10;
    outbox.append(stateEvent('c'));
    // One of the two old events is acknowledged and the other is not; both go.
    outbox.ack(outbox.epoch, 1);
    expect(outbox.pruneBefore(1_000_015)).toBe(2);
    expect(outbox.firstSeq()).toBe(3);
    expect(outbox.lastSeq()).toBe(3);
  });

  test('firstSeq and lastSeq describe the kept range, and an empty outbox reports lastSeq = firstSeq - 1', () => {
    const clock = manualNow();
    const db = open();
    const outbox = new Outbox(db, { now: clock.now });
    expect([outbox.firstSeq(), outbox.lastSeq()]).toEqual([1, 0]);
    outbox.append(stateEvent('a'));
    outbox.append(stateEvent('b'));
    expect([outbox.firstSeq(), outbox.lastSeq()]).toEqual([1, 2]);
    clock.t += 10;
    outbox.pruneBefore(clock.t);
    // Seqs are never reused, so the empty outbox continues after the pruned ones.
    expect([outbox.firstSeq(), outbox.lastSeq()]).toEqual([3, 2]);
    expect(outbox.append(stateEvent('c')).seq).toBe(3);
    expect([outbox.firstSeq(), outbox.lastSeq()]).toEqual([3, 3]);
    const again = new Outbox(reopen(db));
    expect([again.firstSeq(), again.lastSeq()]).toEqual([3, 3]);
  });

  test('waitAcked resolves true once an ack reaches the seq, at once if it has, and false on timeout', async () => {
    const db = open();
    const outbox = new Outbox(db);
    outbox.append(stateEvent('a'));
    outbox.append(stateEvent('b'));
    outbox.ack(db.outboxEpoch, 1);
    expect(await outbox.waitAcked(1, 10)).toBe(true);
    const waiting = outbox.waitAcked(2, 5_000);
    setTimeout(() => outbox.ack(db.outboxEpoch, 2), 5);
    expect(await waiting).toBe(true);
    const started = Date.now();
    expect(await outbox.waitAcked(3, 30)).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
  });
});

const stop = (counter: number): RunnerCommand => ({
  kind: 'stop_attempt',
  attemptId: 'T-4-a1',
  fence: { epoch: 1, counter },
  cause: 'stop',
  reason: 'a person stopped it',
  handoff: true,
  interruptFirst: false,
  keepClone: false,
});

describe('Outbox settings echoes', () => {
  type Edit = { capacity?: number; draining?: boolean; keepAwake?: 'off' | 'ac' | 'always' };
  const edit = (outbox: Outbox, settings: Edit) =>
    outbox.append({ type: 'runner.settings', data: { settings, baseVersion: 1 } }).seq;
  const seqsOf = (events: { seq: number }[]) => events.map((event) => event.seq);

  test('settingsInFlight lists every runner.settings no exact answer has settled, acknowledged or not, across reopening', () => {
    const db = open();
    const outbox = new Outbox(db);
    // runner.json was written with version 10: every mark below counts.
    outbox.settingsSaved(10);
    const capacity = edit(outbox, { capacity: 3 });
    outbox.append({ type: 'runner.state', data: { state: 'ok', detail: null } });
    const drain = edit(outbox, { draining: true });
    const again = edit(outbox, { capacity: 3 });
    outbox.ack(outbox.epoch, drain);
    const inFlight = (box: Outbox) => seqsOf(box.settingsInFlight());
    expect(inFlight(outbox)).toEqual([capacity, drain, again]);
    const answered = (echo: { answered: { seq: number } | null }) => echo.answered?.seq ?? null;
    // An echo that equals no edit (the owner's) marks none.
    expect(answered(outbox.markSettingsEcho(undefined, 2))).toBeNull();
    // An exact answer can name an edit past an earlier edit in flight.
    expect(answered(outbox.markSettingsEcho({ seq: drain, outboxEpoch: outbox.epoch }, 3))).toBe(drain);
    expect(answered(outbox.markSettingsEcho({ seq: capacity, outboxEpoch: outbox.epoch }, 4))).toBe(capacity);
    expect(answered(outbox.markSettingsEcho(undefined, 5))).toBeNull();
    const reopened = reopen(db);
    const box = new Outbox(reopened);
    expect(inFlight(box)).toEqual([again]);
    // The marks of pruned events go.
    box.ack(box.epoch, again);
    box.markSettingsEcho({ seq: again, outboxEpoch: box.epoch }, 6);
    box.pruneBefore(Number.MAX_SAFE_INTEGER);
    expect(reopened.meta('settingsEchoed')).toEqual([]);
    const keepAwake = box.append({
      type: 'runner.settings',
      data: { settings: { keepAwake: 'always' }, baseVersion: 2 },
    });
    expect(inFlight(box)).toEqual([keepAwake.seq]);
    expect(answered(box.markSettingsEcho({ seq: keepAwake.seq, outboxEpoch: box.epoch }, 7))).toBe(keepAwake.seq);
    expect(reopened.meta('settingsEchoed')).toEqual([{ seq: keepAwake.seq, version: 7 }]);
    expect(inFlight(box)).toEqual([]);
  });

  test("a mark counts once runner.json's snapshot has its version, and an echo run again marks nothing more", () => {
    const db = open();
    let confirmed = 4;
    const outbox = new Outbox(db, { confirmedVersion: () => confirmed });
    const first = edit(outbox, { draining: true });
    const second = edit(outbox, { draining: false });
    const third = edit(outbox, { draining: true });
    expect(outbox.markSettingsEcho({ seq: first, outboxEpoch: outbox.epoch }, 5).answered?.seq).toBe(first);
    // runner.json has not taken version 5 yet: the drain is still in flight, though no other echo matches it.
    expect(seqsOf(outbox.settingsInFlight())).toEqual([first, second, third]);
    expect(seqsOf(outbox.settingsInFlight(5))).toEqual([second, third]);
    // The same echo again (the journal's rerun after a restart) answers the same edit, and never the equal third one.
    expect(outbox.markSettingsEcho({ seq: first, outboxEpoch: outbox.epoch }, 5).answered?.seq).toBe(first);
    expect(db.meta('settingsEchoed')).toEqual([{ seq: first, version: 5 }]);
    confirmed = 5;
    expect(seqsOf(outbox.settingsInFlight())).toEqual([second, third]);
    // The hub's whole settings at the version of an echo that came answer nothing.
    expect(outbox.markSettingsEcho(undefined, 5)).toEqual({ answered: null, refused: [] });
    expect(seqsOf(outbox.settingsInFlight())).toEqual([second, third]);
  });

  test('pruneAcked and pruneBefore keep every runner.settings in flight and drop the marks of what they prune', () => {
    const clock = manualNow();
    const db = open();
    let confirmed = 4;
    const outbox = new Outbox(db, { now: clock.now, confirmedVersion: () => confirmed });
    outbox.settingsSaved(confirmed);
    const answered = edit(outbox, { draining: true });
    const waiting = edit(outbox, { capacity: 3 });
    const marked = edit(outbox, { keepAwake: 'always' });
    const state = outbox.append({ type: 'runner.state', data: { state: 'ok', detail: null } }).seq;
    const unacked = edit(outbox, { keepAwake: 'off' });
    outbox.ack(outbox.epoch, state);
    outbox.markSettingsEcho({ seq: answered, outboxEpoch: outbox.epoch }, 4);
    // Marked at version 5, which runner.json has not taken yet: still in flight.
    outbox.markSettingsEcho({ seq: marked, outboxEpoch: outbox.epoch }, 5);
    clock.t += 3 * 24 * 60 * 60_000;
    expect(outbox.pruneAcked(48 * 60 * 60_000)).toBe(2);
    expect(seqsOf(outbox.eventsAfter(0))).toEqual([waiting, marked, unacked]);
    expect(db.meta('settingsEchoed')).toEqual([{ seq: marked, version: 5 }]);
    expect(outbox.pruneBefore(clock.t)).toBe(0);
    confirmed = 5;
    outbox.settingsSaved(confirmed);
    expect(outbox.pruneBefore(clock.t)).toBe(1);
    expect(seqsOf(outbox.eventsAfter(0))).toEqual([waiting, unacked]);
    expect(db.meta('settingsEchoed')).toEqual([]);
    expect(outbox.firstSeq()).toBe(waiting);
  });

  test('without confirmedVersion, an Outbox counts marks up to the version runner.json was last written with', () => {
    const clock = manualNow();
    const db = open();
    let held = 4;
    // The runtime's, which counts against the snapshot it holds, and one built as M2c's retention builds it.
    const runtime = new Outbox(db, { now: clock.now, confirmedVersion: () => held });
    const retention = new Outbox(db, { now: clock.now });
    expect(seqsOf(retention.settingsInFlight())).toEqual([]);
    runtime.settingsSaved(4);
    const drain = edit(runtime, { draining: true });
    runtime.ack(runtime.epoch, drain);
    runtime.markSettingsEcho({ seq: drain, outboxEpoch: runtime.epoch }, 5);
    // runner.json's write at version 5 failed: the runtime holds version 5, and the file still has version 4.
    held = 5;
    expect(seqsOf(runtime.settingsInFlight())).toEqual([]);
    expect(seqsOf(retention.settingsInFlight())).toEqual([drain]);
    clock.t += 3 * 24 * 60 * 60_000;
    // Neither prunes the drain: a restart would read version 4 and find the drain in runner.json, and in flight.
    expect(retention.pruneAcked(48 * 60 * 60_000)).toBe(0);
    expect(runtime.pruneAcked(48 * 60 * 60_000)).toBe(0);
    runtime.settingsSaved(5);
    expect(seqsOf(retention.settingsInFlight())).toEqual([]);
    expect(retention.pruneAcked(48 * 60 * 60_000)).toBe(1);
    expect(db.meta('settingsEchoed')).toEqual([]);
  });

});

describe('Journal', () => {
  test('records a command as running, joins a resend while it runs and answers the stored result once done', () => {
    const journal = new Journal(open());
    const command = stop(7);
    expect(journal.begin('1-R-1-5', 5, command)).toEqual({ state: 'new' });
    expect(journal.get('1-R-1-5')).toMatchObject({
      commandId: '1-R-1-5',
      seq: 5,
      kind: 'stop_attempt',
      attemptId: 'T-4-a1',
      state: 'running',
      result: null,
      command,
    });
    expect(journal.begin('1-R-1-5', 5, command)).toEqual({ state: 'running', commandId: '1-R-1-5' });
    expect(journal.running().map((entry) => entry.commandId)).toEqual(['1-R-1-5']);
    journal.finish('1-R-1-5', { ok: true, data: { stopped: true } });
    expect(journal.begin('1-R-1-5', 5, command)).toEqual({
      state: 'done',
      commandId: '1-R-1-5',
      result: { ok: true, data: { stopped: true } },
    });
    expect(journal.running()).toEqual([]);
  });

  test('keeps the outbox position a command arrived at, the first one, across reopening', () => {
    const db = open();
    const journal = new Journal(db);
    const command = { kind: 'update_settings', settings: { draining: true }, version: 5 } as const;
    expect(journal.begin('1-R-1-6', 6, command, 12)).toEqual({ state: 'new' });
    // A resend joins the first execution and leaves its position as it was.
    expect(journal.begin('1-R-1-6', 6, command, 15)).toEqual({ state: 'running', commandId: '1-R-1-6' });
    const reopened = new Journal(reopen(db));
    expect(reopened.get('1-R-1-6')).toMatchObject({ outboxSeq: 12, state: 'running' });
    expect(reopened.running().map((entry) => entry.outboxSeq)).toEqual([12]);
    // Without one, none is kept.
    reopened.begin('1-R-1-7', 7, { kind: 'cleanup_attempt', attemptId: 'T-4-a1' });
    expect(reopened.get('1-R-1-7')?.outboxSeq).toBeNull();
  });

  test('maps a new command id with the same idempotency key to the first execution', () => {
    const journal = new Journal(open());
    const decide = (id: string): RunnerCommand => ({
      kind: 'decide_approval',
      attemptId: 'T-4-a1',
      fence,
      approvalId: id,
      decision: 'approve',
      reason: null,
    });
    const resume = (agentToken: string): RunnerCommand => ({
      kind: 'resume_attempt',
      attemptId: 'T-4-a1',
      fence,
      agentToken,
      prompt: 'go',
      messages: [],
      taskPack: null,
      restore: { paths: [], base: null },
      acceptanceIds: [],
    });
    const push = (pushFence: typeof fence): RunnerCommand => ({
      kind: 'push_submission',
      attemptId: 'T-4-a1',
      fence: pushFence,
      submissionId: 'S-9',
      branch: 'agflow/T-4-tidy',
      expectedBranchSha: null,
      adoptable: [],
    });
    const approval = '0f8fad5b-d9cb-469f-a165-70867728950e';
    const commands: [RunnerCommand, RunnerCommand][] = [
      [{ kind: 'start_attempt', attempt: spec() }, { kind: 'start_attempt', attempt: spec() }],
      [resume(TOKEN), resume(`agt_${'R'.repeat(43)}`)],
      [push(fence), push({ epoch: 1, counter: 8 })],
      [stop(7), { ...stop(7), reason: 'again' } as RunnerCommand],
      [{ kind: 'hold_attempt', attemptId: 'T-4-a1', fence }, { kind: 'hold_attempt', attemptId: 'T-4-a1', fence }],
      [
        { kind: 'prepare_takeover', attemptId: 'T-4-a1', fence, person: 'alice' },
        { kind: 'prepare_takeover', attemptId: 'T-4-a1', fence, person: 'alice' },
      ],
      [decide(approval), decide(approval)],
    ];
    let seq = 1;
    for (const [first, second] of commands) {
      const journal2 = new Journal(open());
      const firstId = `1-R-1-${seq++}`;
      const secondId = `1-R-1-${seq++}`;
      expect(idempotencyKey(first)).not.toBeNull();
      expect(idempotencyKey(second)).toBe(idempotencyKey(first));
      expect(journal2.begin(firstId, 1, first)).toEqual({ state: 'new' });
      expect(journal2.begin(secondId, 2, second)).toEqual({ state: 'running', commandId: firstId });
      journal2.finish(firstId, { ok: true });
      expect(journal2.begin(secondId, 2, second)).toEqual({ state: 'done', commandId: firstId, result: { ok: true } });
    }
    // Another fence, another submission or another approval is another command.
    expect(idempotencyKey(stop(8))).not.toBe(idempotencyKey(stop(7)));
    expect(idempotencyKey(decide('1b4e28ba-2fa1-41d2-883f-0016d3cca427'))).not.toBe(idempotencyKey(decide(approval)));
    expect(idempotencyKey({ kind: 'hold_attempt', attemptId: 'T-4-a1', fence })).not.toBe(idempotencyKey(stop(7)));
    // Commands without a key are told apart by their id alone.
    expect(idempotencyKey({ kind: 'cleanup_attempt', attemptId: 'T-4-a1' })).toBeNull();
    expect(journal.begin('1-R-1-90', 90, { kind: 'cleanup_attempt', attemptId: 'T-4-a1' })).toEqual({ state: 'new' });
    expect(journal.begin('1-R-1-91', 91, { kind: 'cleanup_attempt', attemptId: 'T-4-a1' })).toEqual({ state: 'new' });
  });

  test('pruneBefore drops journal rows older than a time and keeps newer ones', () => {
    const clock = manualNow();
    const journal = new Journal(open(), { now: clock.now });
    journal.begin('1-R-1-1', 1, { kind: 'cleanup_attempt', attemptId: 'T-4-a1' });
    journal.finish('1-R-1-1', { ok: true });
    clock.t += 100;
    journal.begin('1-R-1-2', 2, { kind: 'cleanup_attempt', attemptId: 'T-5-a1' });
    expect(journal.pruneBefore(clock.t - 50)).toBe(1);
    expect(journal.get('1-R-1-1')).toBeNull();
    expect(journal.get('1-R-1-2')).not.toBeNull();
  });
});

describe('AttemptStore', () => {
  test('migrates a version 1 database without claiming its stopped attempts were finalized', () => {
    const db = open();
    const store = new AttemptStore(db);
    store.create(spec(), { clone: '/w/kept', tmpDir: null, cliVersion: null });
    store.update('T-4-a1', { state: 'stopped', wipSha: 'a'.repeat(40), pushError: 'unresolved' });
    const columns = db.sqlite.query('PRAGMA table_info(attempts)').all() as { name: string }[];
    if (columns.some(({ name }) => name === 'finalized_at')) db.sqlite.run('ALTER TABLE attempts DROP COLUMN finalized_at');
    db.sqlite.run('DELETE FROM schema_migrations WHERE version > 1');
    const migrated = reopen(db);
    expect(new AttemptStore(migrated).get('T-4-a1')).toMatchObject({
      state: 'stopped', clone: '/w/kept', wipSha: 'a'.repeat(40), pushError: 'unresolved', finalizedAt: null,
    });
    expect(migrated.sqlite.query('SELECT MAX(version) AS v FROM schema_migrations').get()).toEqual({ v: 2 });
    expect(new AttemptStore(reopen(migrated)).get('T-4-a1')?.finalizedAt).toBeNull();
  });

  test('round-trips every field of an attempt record through its states', () => {
    const clock = manualNow();
    let db = open();
    let store = new AttemptStore(db, { now: clock.now });
    const created = store.create(spec(), { clone: '/w/demo/T-4-a1', tmpDir: '/tmp/agf/abc123', cliVersion: '2.1.285' });
    expect(created).toEqual({
      attemptId: 'T-4-a1',
      spec: expect.not.objectContaining({ agentToken: expect.anything() }),
      fence,
      state: 'starting',
      sessionRef: null,
      clone: '/w/demo/T-4-a1',
      tmpDir: '/tmp/agf/abc123',
      wipSha: null,
      pushedSha: null,
      lastPushAt: null,
      lateWorkCount: 0,
      lateWorkSha: null,
      cliVersion: '2.1.285',
      endedAt: null,
      finalizedAt: null,
      pushError: null,
      createdAt: 1_000_000,
      updatedAt: 1_000_000,
    });
    expect(created.spec).not.toHaveProperty('agentToken');
    for (const state of ['running', 'idle', 'stopped', 'suspended', 'ended'] as const) {
      clock.t += 1;
      store.update('T-4-a1', { state });
      db = reopen(db);
      store = new AttemptStore(db, { now: clock.now });
      expect(store.get('T-4-a1')?.state).toBe(state);
    }
    const sha = (digit: string) => digit.repeat(40);
    clock.t += 1;
    const updated = store.update('T-4-a1', {
      fence: { epoch: 1, counter: 9 },
      sessionRef: 'session-1',
      wipSha: sha('a'),
      pushedSha: sha('b'),
      lastPushAt: 999,
      lateWorkCount: 2,
      lateWorkSha: sha('c'),
      endedAt: 1_234,
      finalizedAt: 1_235,
      pushError: 'remote: rejected',
    });
    db = reopen(db);
    const reread = new AttemptStore(db).get('T-4-a1');
    expect(reread).toEqual(updated);
    expect(reread).toMatchObject({
      fence: { epoch: 1, counter: 9 },
      sessionRef: 'session-1',
      wipSha: sha('a'),
      pushedSha: sha('b'),
      lastPushAt: 999,
      lateWorkCount: 2,
      lateWorkSha: sha('c'),
      cliVersion: '2.1.285',
      endedAt: 1_234,
      finalizedAt: 1_235,
      pushError: 'remote: rejected',
      updatedAt: 1_000_006,
    });
    const reset = new AttemptStore(db);
    reset.update('T-4-a1', { finalizedAt: null });
    expect(new AttemptStore(reopen(db)).get('T-4-a1')?.finalizedAt).toBeNull();
  });

  test('lists and removes attempts, and refuses to update an unknown one', () => {
    const store = new AttemptStore(open());
    store.create(spec(), { clone: '/w/a', tmpDir: null, cliVersion: '2.1.285' });
    store.create(spec({ attemptId: 'T-5-a2', taskId: 'T-5', branch: 'agflow/T-5-x', wipRef: 'refs/agflow/T-5/a2' }), {
      clone: '/w/b',
      tmpDir: null,
      cliVersion: '2.1.285',
    });
    expect(store.list().map((record) => record.attemptId)).toEqual(['T-4-a1', 'T-5-a2']);
    store.remove('T-4-a1');
    expect(store.get('T-4-a1')).toBeNull();
    expect(() => store.update('T-4-a1', { state: 'running' })).toThrow(/T-4-a1/);
  });

  test('the process registry stores and lists recorded groups per attempt', () => {
    const store = new AttemptStore(open());
    const lstart = 'Thu Oct 29 13:04:14 2026';
    store.recordProcess({ attemptId: 'T-4-a1', pid: 100, pgid: 100, lstart, clone: '/w/a' });
    store.recordProcess({ attemptId: 'T-4-a1', pid: 140, pgid: 140, lstart, clone: '/w/a' });
    store.recordProcess({ attemptId: 'T-5-a2', pid: 200, pgid: 200, lstart, clone: '/w/b' });
    // Recording a group again replaces it.
    const later = 'Thu Oct 29 13:05:00 2026';
    store.recordProcess({ attemptId: 'T-4-a1', pid: 100, pgid: 100, lstart: later, clone: '/w/a' });
    expect(store.processes('T-4-a1')).toEqual([
      { attemptId: 'T-4-a1', pid: 100, pgid: 100, lstart: later, clone: '/w/a' },
      { attemptId: 'T-4-a1', pid: 140, pgid: 140, lstart, clone: '/w/a' },
    ]);
    expect(store.processes().map((record) => record.pgid)).toEqual([100, 140, 200]);
    store.forgetProcess('T-4-a1', 140);
    expect(store.processes('T-4-a1').map((record) => record.pgid)).toEqual([100]);
    store.forgetProcesses('T-4-a1');
    expect(store.processes('T-4-a1')).toEqual([]);
    expect(store.processes('T-5-a2')).toHaveLength(1);
  });
});

describe('no secrets on disk', () => {
  test('the agent token occurs nowhere in the database file', () => {
    const db = open();
    const journal = new Journal(db);
    const store = new AttemptStore(db);
    const start: RunnerCommand = { kind: 'start_attempt', attempt: spec() };
    const resume: RunnerCommand = {
      kind: 'resume_attempt',
      attemptId: 'T-4-a1',
      fence: { epoch: 1, counter: 8 },
      agentToken: TOKEN,
      prompt: 'continue',
      messages: [],
      taskPack: null,
      restore: { paths: [], base: null },
      acceptanceIds: [],
    };
    journal.begin('1-R-1-1', 1, start);
    journal.finish('1-R-1-1', { ok: true });
    journal.begin('1-R-1-2', 2, resume);
    expect(journal.get('1-R-1-1')?.command).toEqual({
      kind: 'start_attempt',
      attempt: expect.not.objectContaining({ agentToken: TOKEN }),
    });
    expect(journal.get('1-R-1-2')?.command).not.toHaveProperty('agentToken');
    store.create(spec(), { clone: '/w/a', tmpDir: null, cliVersion: '2.1.285' });
    store.update('T-4-a1', { spec: spec({ taskPack: 'recomputed' }) });
    expect(store.get('T-4-a1')?.spec.taskPack).toBe('recomputed');
    const path = db.path;
    db.close();
    dbs.splice(dbs.indexOf(db), 1);
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(`${path}${suffix}`)) expect(readFileSync(`${path}${suffix}`).includes(TOKEN)).toBe(false);
    }
    expect(readFileSync(path).includes('T-4-a1')).toBe(true);
  });
});
