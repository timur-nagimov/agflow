import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import {
  existsSync,
  lstatSync,
  lutimesSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AttemptSpecSchema, type Vendor } from '@agflow/core';
import { FakeAdapter } from '@agflow/testkit';
import type { VendorAdapter } from '../../src/adapters/types';
import { AttemptStore, type AttemptPatch } from '../../src/attempt-store';
import { RunnerConfigSchema } from '../../src/config';
import { openRunnerDb } from '../../src/db';
import { Journal } from '../../src/journal';
import { memoryLogger } from '../../src/log';
import { RETENTION, sweepRetention } from '../../src/ops/retention';
import { Outbox } from '../../src/outbox';
import { runnerPaths } from '../../src/paths';
import { PrepState } from '../../src/prep/plan';
import { launchdLogPaths } from '../../src/service/log';
import { VENDOR_PINS } from '../../src/vendor/pins';

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-11-09T12:00:00Z');
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function file(path: string, at = NOW, content = 'kept') {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  utimesSync(path, new Date(at), new Date(at));
}

function directory(path: string, at = NOW) {
  mkdirSync(path, { recursive: true });
  utimesSync(path, new Date(at), new Date(at));
}

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'agf-ret-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const paths = runnerPaths(home);
  mkdirSync(paths.runner, { recursive: true });
  const db = openRunnerDb(paths.db);
  cleanups.push(() => db.close());
  const clock = { at: NOW, now: () => clock.at };
  const store = new AttemptStore(db, { now: clock.now });
  const outbox = new Outbox(db, { now: clock.now });
  const journal = new Journal(db, { now: clock.now });
  const logger = memoryLogger();
  const deleted: { sessionRef: string; clone: string }[] = [];
  const transcriptDir = join(home, 'transcripts');
  const fake = new FakeAdapter({ script: { turns: [] }, transcriptDir });
  const adapters = new Map<Vendor, Pick<VendorAdapter, 'deleteTranscript'>>([
    [
      'claude',
      {
        deleteTranscript: async (input) => {
          deleted.push(input);
          await fake.deleteTranscript(input);
        },
      },
    ],
  ]);
  const consolidated: string[] = [];
  const vaults = ['one', 'two'].map((project) => ({
    project,
    consolidate: async () => {
      consolidated.push(project);
      return { pruned: false };
    },
  }));
  const input = {
    paths,
    store,
    outbox,
    journal,
    logger,
    adapters,
    vaults,
    now: clock.now,
    eventRetentionMs: RunnerConfigSchema.parse({ runnerKey: 'key', machineId: 'machine', name: 'test' }).timings
      .eventRetention,
    // The real pin lookup on any CI: darwin-arm64 is the platform M2 pins.
    platform: 'darwin-arm64',
  };
  function attempt(id: string, patch: AttemptPatch = {}, vendor: Vendor = 'claude') {
    const spec = AttemptSpecSchema.parse({
      attemptId: id,
      taskId: 'T-4',
      role: 'worker',
      vendor,
      model: null,
      fence: { epoch: 1, counter: 1 },
      agentToken: `agt_${'Q'.repeat(43)}`,
      hubUrl: 'http://127.0.0.1:7000',
      repo: { url: '/tmp/origin.git', mainBranch: 'main' },
      start: { ref: 'refs/heads/main', sha: null },
      branch: 'agflow/T-4-tidy',
      wipRef: 'refs/agflow/T-4/a1',
      restore: { paths: [], base: 'refs/heads/main' },
      acceptanceIds: [],
      toolCaps: { defaultMs: 600_000, longMs: 1_800_000, checks: [] },
      taskPack: '# T-4',
      brief: 'brief',
      firstPrompt: 'start',
      successor: false,
    });
    store.create(spec, { clone: paths.clone('one', id), tmpDir: null, cliVersion: '1.0.0' });
    return store.update(id, { state: 'ended', endedAt: NOW - 15 * DAY, sessionRef: id, ...patch });
  }
  return { ...input, input, home, clock, db, attempt, deleted, transcriptDir, consolidated };
}

describe('sweepRetention', () => {
  test('uses 48 hours for acknowledged events and 14 days for all events and journal rows', async () => {
    const f = fixture();
    const event = () => f.outbox.append({ type: 'runner.state', data: { state: 'ok', detail: null } });
    f.clock.at = NOW - 3 * DAY;
    event();
    f.outbox.ack(f.outbox.epoch, 1);
    // A clock correction lets the oldest unacknowledged row follow the acknowledged one.
    f.clock.at = NOW - 15 * DAY;
    event();
    f.journal.begin('old', 1, { kind: 'preflight', vendor: 'claude' });
    f.clock.at = NOW - 14 * DAY;
    event();
    f.journal.begin('boundary', 2, { kind: 'preflight', vendor: 'claude' });
    f.clock.at = NOW - 3 * DAY;
    event();
    f.clock.at = NOW;
    const result = await sweepRetention(f.input);
    expect(result).toMatchObject({ ran: true, ackedEvents: 1, outboxEvents: 1, journalRows: 1 });
    expect(f.outbox.firstSeq()).toBe(3);
    expect(f.outbox.eventsAfter(0).map((event) => event.seq)).toEqual([3, 4]);
    expect(f.journal.get('old')).toBeNull();
    expect(f.journal.get('boundary')).not.toBeNull();

    const recent = fixture();
    for (const age of [48 * HOUR + 1, 48 * HOUR, 24 * HOUR]) {
      recent.clock.at = NOW - age;
      recent.outbox.append({ type: 'runner.state', data: { state: 'ok', detail: null } });
    }
    recent.outbox.ack(recent.outbox.epoch, 3);
    recent.clock.at = NOW;
    expect((await sweepRetention(recent.input)).ackedEvents).toBe(1);
    expect(recent.outbox.firstSeq()).toBe(2);
  });

  test('removes only regular attempt log files older than 14 days', async () => {
    const f = fixture();
    const old = f.paths.attemptLog('old');
    const boundary = f.paths.attemptLog('boundary');
    const fresh = f.paths.attemptLog('fresh');
    file(old, NOW - 15 * DAY);
    file(boundary, NOW - 14 * DAY);
    file(fresh, NOW - 13 * DAY);
    directory(f.paths.attemptLog('directory'), NOW - 15 * DAY);
    const target = join(f.home, 'target');
    file(target, NOW - 15 * DAY);
    symlinkSync(target, f.paths.attemptLog('link'));
    expect((await sweepRetention(f.input)).attemptLogs).toBe(1);
    expect(existsSync(old)).toBe(false);
    for (const path of [boundary, fresh, target, f.paths.attemptLog('link'), f.paths.attemptLog('directory')]) {
      expect(existsSync(path)).toBe(true);
    }
  });

  test('deletes a missing clone transcript once, then frees its record, version and preparation state', async () => {
    const f = fixture();
    const record = f.attempt('T-4-a1');
    file(join(f.transcriptDir, 'T-4-a1.jsonl'));
    const version = join(f.paths.vendor, 'claude', '1.0.0');
    directory(version);
    const prep = new PrepState(f.paths.prep('one'));
    prep.record(record.attemptId, 'entry', 'fingerprint');
    const result = await sweepRetention(f.input);
    expect(result).toMatchObject({ attempts: 1, transcripts: 1, vendorVersions: 1, prepStates: 1 });
    expect(f.deleted).toEqual([{ sessionRef: record.sessionRef!, clone: record.clone! }]);
    expect(existsSync(join(f.transcriptDir, 'T-4-a1.jsonl'))).toBe(false);
    expect(f.store.get(record.attemptId)).toBeNull();
    expect(existsSync(version)).toBe(false);
    expect(prep.attempts()).toEqual([]);
    f.clock.at += DAY;
    await sweepRetention(f.input);
    expect(f.deleted).toHaveLength(1);
  });

  test('preserves holding, taken-over and push-failing clones, recent and unended attempts', async () => {
    const f = fixture();
    for (const [index, patch] of [
      { state: 'idle' },
      { state: 'stopped' },
      { pushError: 'remote unavailable' },
    ].entries()) {
      const record = f.attempt(`T-4-a${index + 1}`, patch as AttemptPatch);
      file(join(record.clone!, 'work.txt'), NOW - 20 * DAY);
    }
    f.attempt('T-4-a4', { endedAt: NOW - 13 * DAY });
    f.attempt('T-4-a5', { endedAt: null });
    f.attempt('T-4-a6', { endedAt: NOW - 14 * DAY });
    f.attempt('T-4-a7', { clone: null });
    expect((await sweepRetention(f.input)).attempts).toBe(1);
    expect(f.deleted).toEqual([]);
    expect(f.store.list()).toHaveLength(6);
    for (let i = 1; i <= 3; i++) {
      expect(readFileSync(join(f.paths.clone('one', `T-4-a${i}`), 'work.txt'), 'utf8')).toBe('kept');
    }
  });

  test('a failed transcript deletion keeps the record and version and does not stop other attempts', async () => {
    const f = fixture();
    f.attempt('T-4-a1');
    f.attempt('T-4-a2', { clone: null });
    const version = join(f.paths.vendor, 'claude', '1.0.0');
    directory(version);
    f.adapters.set('claude', {
      deleteTranscript: async () => {
        throw new Error('thread busy');
      },
    });
    const result = await sweepRetention(f.input);
    expect(result.attempts).toBe(1);
    expect(f.store.get('T-4-a1')).not.toBeNull();
    expect(f.store.get('T-4-a2')).toBeNull();
    expect(existsSync(version)).toBe(true);
    expect(f.consolidated).toEqual(['one', 'two']);
    expect(f.logger.entries).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        fields: expect.objectContaining({ step: 'endedAttempts', error: expect.anything() }),
      }),
    );
    f.adapters.set('claude', { deleteTranscript: async () => {} });
    f.clock.at += DAY;
    await sweepRetention(f.input);
    expect(f.store.get('T-4-a1')).toBeNull();
    expect(existsSync(version)).toBe(false);
  });

  test('keeps pins, newer versions and every referenced version, leaving staging and linked targets alone', async () => {
    const f = fixture();
    const pins = VENDOR_PINS['darwin-arm64']!;
    expect([pins.claude.version, pins.codex.version]).toEqual(['2.1.285', '0.159.2']);
    f.attempt('T-4-a1', { endedAt: null });
    f.attempt('T-4-a2', { endedAt: null, cliVersion: '0.100.0' }, 'codex');
    const version = (vendor: Vendor, name: string) => join(f.paths.vendor, vendor, name);
    // 2.1.300 and 0.160.0 stand for pins an upgrade installed before this runner restarted.
    for (const [vendor, names] of [
      ['claude', [pins.claude.version, '1.0.0', '2.1.284', '2.1.300', '10.0.0', '.staging-123-abcd', 'unknown']],
      ['codex', [pins.codex.version, '0.100.0', '1.0.0', '0.150.0', '0.160.0']],
    ] as const)
      for (const name of names) directory(version(vendor, name));
    file(version('claude', '0.9.0'));
    const target = join(f.home, 'linked-version');
    file(join(target, 'binary'));
    symlinkSync(target, version('claude', '2.0.0'));
    // codex 1.0.0 is newer than its pin and claude 1.0.0 is a record's; claude 2.1.284, the link and codex 0.150.0 go.
    expect((await sweepRetention(f.input)).vendorVersions).toBe(3);
    expect(readdirSync(join(f.paths.vendor, 'claude')).sort()).toEqual([
      '.staging-123-abcd',
      '0.9.0',
      '1.0.0',
      '10.0.0',
      '2.1.285',
      '2.1.300',
      'unknown',
    ]);
    expect(readdirSync(join(f.paths.vendor, 'codex')).sort()).toEqual(['0.100.0', '0.159.2', '0.160.0', '1.0.0']);
    expect(readFileSync(join(target, 'binary'), 'utf8')).toBe('kept');
  });

  test('a platform without pins keeps only referenced vendor versions', async () => {
    const f = fixture();
    expect(VENDOR_PINS['linux-x64']).toBeUndefined();
    f.attempt('T-4-a1', { endedAt: null });
    for (const name of ['1.0.0', '2.1.285', '9.0.0']) directory(join(f.paths.vendor, 'claude', name));
    expect((await sweepRetention({ ...f.input, platform: 'linux-x64' })).vendorVersions).toBe(2);
    expect(readdirSync(join(f.paths.vendor, 'claude'))).toEqual(['1.0.0']);
  });

  test('removes hour-old quarantines and orphan preparation state across projects', async () => {
    const f = fixture();
    f.attempt('T-4-a1', { endedAt: null });
    const old = f.paths.quarantine('one', 'old');
    const boundary = f.paths.quarantine('one', 'boundary');
    const fresh = f.paths.quarantine('two', 'fresh');
    directory(old, NOW - HOUR - 1);
    directory(boundary, NOW - HOUR);
    directory(fresh, NOW - 30 * 60_000);
    const target = join(f.home, 'quarantine-target');
    file(join(target, 'work'));
    const link = f.paths.quarantine('one', 'link');
    symlinkSync(target, link);
    lutimesSync(link, new Date(NOW - 2 * HOUR), new Date(NOW - 2 * HOUR));
    for (const project of ['one', 'two']) {
      const prep = new PrepState(f.paths.prep(project));
      prep.record('T-4-a1', 'entry', 'keep');
      prep.record('T-4-a2', 'entry', 'remove');
      file(join(f.paths.prep(project), 'cache', 'keep'));
    }
    expect(await sweepRetention(f.input)).toMatchObject({ quarantines: 2, prepStates: 2 });
    expect(existsSync(old)).toBe(false);
    expect(existsSync(link)).toBe(false);
    for (const path of [boundary, fresh, join(target, 'work')]) expect(existsSync(path)).toBe(true);
    for (const project of ['one', 'two']) {
      expect(new PrepState(f.paths.prep(project)).attempts()).toEqual(['T-4-a1']);
      expect(existsSync(join(f.paths.prep(project), 'cache', 'keep'))).toBe(true);
    }
  });

  test('persists daily scheduling privately and honors each vault timestamp', async () => {
    const f = fixture();
    expect(Object.isFrozen(RETENTION)).toBe(true);
    const state = join(f.paths.logs, 'retention.json');
    file(state, NOW, JSON.stringify({ sweptAt: NOW - DAY, consolidatedAt: { one: NOW - HOUR } }));
    expect((await sweepRetention(f.input)).consolidatedVaults).toEqual(['two']);
    expect(JSON.parse(readFileSync(state, 'utf8'))).toEqual({
      sweptAt: NOW,
      consolidatedAt: { one: NOW - HOUR, two: NOW },
    });
    expect(statSync(state).mode & 0o777).toBe(0o600);
    expect(readdirSync(f.paths.logs)).toEqual(['retention.json']);
    f.clock.at += DAY - 1;
    expect((await sweepRetention({ ...f.input, paths: runnerPaths(f.home) })).ran).toBe(false);
    f.clock.at++;
    expect((await sweepRetention(f.input)).ran).toBe(true);
    expect(f.consolidated).toEqual(['two', 'one', 'two']);
  });

  test('stamps the sweep with its start, so a long consolidation does not delay the next day', async () => {
    const f = fixture();
    for (const vault of f.vaults) {
      vault.consolidate = async () => {
        f.clock.at += HOUR;
        return { pruned: false };
      };
    }
    expect((await sweepRetention(f.input)).consolidatedVaults).toEqual(['one', 'two']);
    const state = JSON.parse(readFileSync(join(f.paths.logs, 'retention.json'), 'utf8'));
    expect(state).toEqual({ sweptAt: NOW, consolidatedAt: { one: NOW, two: NOW } });
    f.clock.at = NOW + DAY;
    expect((await sweepRetention(f.input)).consolidatedVaults).toEqual(['one', 'two']);
  });

  test('an aborted sweep finishes its step under way, skips the rest and stays due', async () => {
    const f = fixture();
    const state = join(f.paths.logs, 'retention.json');
    file(state, NOW, JSON.stringify({ sweptAt: NOW - 2 * DAY, consolidatedAt: {} }));
    const shutdown = new AbortController();
    f.vaults[0]!.consolidate = async () => {
      shutdown.abort();
      f.consolidated.push('one');
      return { pruned: false };
    };
    const result = await sweepRetention({ ...f.input, signal: shutdown.signal });
    expect(result).toMatchObject({ ran: true, consolidatedVaults: ['one'], failedSteps: [] });
    expect(f.consolidated).toEqual(['one']);
    expect(JSON.parse(readFileSync(state, 'utf8'))).toEqual({ sweptAt: NOW - 2 * DAY, consolidatedAt: { one: NOW } });
    const stopped = expect.objectContaining({ message: 'retention sweep stopped by shutdown' });
    expect(f.logger.entries).toContainEqual(stopped);
    const next = await sweepRetention(f.input);
    expect(next).toMatchObject({ ran: true, consolidatedVaults: ['two'] });
    expect(f.consolidated).toEqual(['one', 'two']);
  });

  test('an aborted signal skips every step before the first', async () => {
    const f = fixture();
    file(f.paths.attemptLog('old'), NOW - 15 * DAY);
    const shutdown = new AbortController();
    shutdown.abort();
    const result = await sweepRetention({ ...f.input, signal: shutdown.signal });
    expect(result).toMatchObject({ ran: true, attemptLogs: 0, consolidatedVaults: [] });
    expect(existsSync(f.paths.attemptLog('old'))).toBe(true);
    expect(f.consolidated).toEqual([]);
  });

  test('unreadable state and a clock moved backwards allow a sweep', async () => {
    const f = fixture();
    const state = join(f.paths.logs, 'retention.json');
    for (const content of [
      '{broken',
      '{"sweptAt":"today"}',
      JSON.stringify({ sweptAt: NOW + DAY, consolidatedAt: { one: NOW + DAY } }),
    ]) {
      file(state, NOW, content);
      expect((await sweepRetention(f.input)).ran).toBe(true);
    }
    expect(f.consolidated).toEqual(['one', 'two', 'one', 'two', 'one', 'two']);
  });

  test('shares overlapping sweeps for one home without blocking another home', async () => {
    const f = fixture();
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.vaults[0]!.consolidate = async () => {
      await waiting;
      return { pruned: false };
    };
    const first = sweepRetention(f.input);
    const second = sweepRetention({ ...f.input, paths: runnerPaths(f.home) });
    expect(second).toBe(first);
    try {
      expect((await sweepRetention(fixture().input)).ran).toBe(true);
    } finally {
      release();
    }
    expect(await second).toBe(await first);
    expect((await sweepRetention(f.input)).ran).toBe(false);
  });

  test('a failed prune or vault does not stop later steps and only successful vaults are stamped', async () => {
    const f = fixture();
    const prune = spyOn(f.outbox, 'pruneAcked').mockImplementation(() => {
      throw new Error('busy');
    });
    cleanups.push(() => prune.mockRestore());
    const journal = spyOn(f.journal, 'pruneBefore');
    cleanups.push(() => journal.mockRestore());
    f.vaults[0]!.consolidate = async () => {
      throw new Error('repack failed');
    };
    file(f.paths.attemptLog('old'), NOW - 15 * DAY);
    const result = await sweepRetention(f.input);
    expect(result).toMatchObject({ ran: true, attemptLogs: 1, consolidatedVaults: ['two'] });
    expect(journal).toHaveBeenCalledWith(NOW - 14 * DAY);
    expect(f.logger.entries.filter((entry) => entry.level === 'warn')).toHaveLength(2);
    expect(JSON.parse(readFileSync(join(f.paths.logs, 'retention.json'), 'utf8')).consolidatedAt).toEqual({ two: NOW });
  });

  test('trims launchd excess in place', async () => {
    const f = fixture();
    const logs = launchdLogPaths(f.paths);
    file(logs.stdout);
    file(logs.stderr);
    truncateSync(logs.stdout, 10 * 1024 * 1024 + 1);
    const inode = statSync(logs.stdout).ino;
    expect((await sweepRetention(f.input)).launchdLogs).toEqual([logs.stdout]);
    expect(statSync(logs.stdout).size).toBe(0);
    expect(statSync(logs.stdout).ino).toBe(inode);
    expect(readFileSync(logs.stderr, 'utf8')).toBe('kept');
  });

  test('a state write failure is logged without losing the completed cleanup result', async () => {
    const f = fixture();
    directory(join(f.paths.logs, 'retention.json'));
    file(f.paths.attemptLog('old'), NOW - 15 * DAY);
    const result = await sweepRetention(f.input);
    expect(result).toMatchObject({
      ran: true,
      attemptLogs: 1,
      consolidatedVaults: ['one', 'two'],
      failedSteps: ['saveState'],
    });
    expect(readdirSync(f.paths.logs).sort()).toEqual(['attempts', 'retention.json']);
    expect(f.logger.entries).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        fields: expect.objectContaining({ step: 'saveState', error: expect.anything() }),
      }),
    );
  });

  test('forgets eligible records without session metadata or an adapter, but preserves dangling clone links', async () => {
    const f = fixture();
    f.attempt('T-4-a1', { sessionRef: null });
    f.attempt('T-4-a2', {}, 'codex');
    const linked = f.attempt('T-4-a3');
    directory(dirname(linked.clone!));
    symlinkSync(join(f.home, 'missing'), linked.clone!);
    const result = await sweepRetention(f.input);
    expect(result).toMatchObject({ attempts: 2, transcripts: 0 });
    expect(f.deleted).toEqual([]);
    expect(f.store.list().map((record) => record.attemptId)).toEqual(['T-4-a3']);
    expect(lstatSync(linked.clone!).isSymbolicLink()).toBe(true);
  });

  test('sweeps through an AGFLOW_HOME that is itself a link', async () => {
    const f = fixture();
    const linked = join(dirname(f.home), `${f.home.split('/').pop()}-link`);
    symlinkSync(f.home, linked);
    cleanups.push(() => rmSync(linked, { force: true }));
    file(f.paths.attemptLog('old'), NOW - 15 * DAY);
    const result = await sweepRetention({ ...f.input, paths: runnerPaths(linked) });
    expect(result).toMatchObject({ ran: true, attemptLogs: 1, failedSteps: [] });
    expect(existsSync(f.paths.attemptLog('old'))).toBe(false);
  });

  test('never traverses symlinked cleanup containers or launchd files into clones', async () => {
    const f = fixture();
    const clone = f.paths.clone('one', 'T-4-a1');
    const precious = join(clone, 'T-4-a1.json');
    file(precious, NOW - 20 * DAY);
    directory(join(clone, '1.0.0'), NOW - 20 * DAY);
    directory(f.paths.logs);
    symlinkSync(clone, join(f.paths.logs, 'attempts'));
    directory(f.paths.vendor);
    symlinkSync(clone, join(f.paths.vendor, 'claude'));
    directory(f.paths.vaults);
    symlinkSync(clone, join(f.paths.vaults, 'one.quarantine'));
    directory(f.paths.prep('one'));
    symlinkSync(clone, join(f.paths.prep('one'), 'state'));
    const huge = join(clone, 'huge');
    file(huge);
    truncateSync(huge, 10 * 1024 * 1024 + 1);
    symlinkSync(huge, launchdLogPaths(f.paths).stdout);
    await sweepRetention(f.input);
    expect(readFileSync(precious, 'utf8')).toBe('kept');
    expect(existsSync(join(clone, '1.0.0'))).toBe(true);
    expect(statSync(huge).size).toBe(10 * 1024 * 1024 + 1);
    expect(lstatSync(join(f.paths.logs, 'attempts')).isSymbolicLink()).toBe(true);
  });
});

test('retention keeps durable late work even when the ended attempt has no clone left', async () => {
  const f = fixture();
  for (const clone of [null, '/missing-agflow-clone']) {
    const id = clone === null ? 'T-4-a1' : 'T-4-a2';
    f.attempt(id, { clone, state: 'ended', endedAt: NOW - 15 * DAY, lateWorkSha: 'pending-sha' });
  }
  await sweepRetention(f.input);
  expect(f.store.list().map((record) => record.attemptId)).toEqual(['T-4-a1', 'T-4-a2']);
});
