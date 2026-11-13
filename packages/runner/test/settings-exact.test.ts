import { afterEach, expect, test } from 'bun:test';
import { parseRunnerMessage } from '@agflow/core';
import { FakeRunner } from '../../hub/test/fake-runner';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestContext, addRunner } from '../../hub/test/helpers';
import { tx } from '../../hub/src/context';
import { applyRunnerEvents, EVENT_HANDLERS } from '../../hub/src/events-in';
import { pendingCommands, cancelPendingSettings } from '../../hub/src/commands';
import { findRunnerRow, patchRunnerSettings, reconcileHelloSettings, runnerSettings } from '../../hub/src/runners';
import { RunnerConfigSchema } from '../src/config';
import { openRunnerDb } from '../src/db';
import { Outbox } from '../src/outbox';
import { SettingsSync } from '../src/settings-sync';
import { memoryLogger } from '../src/log';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'agflow-exact-settings-'));
  const db = openRunnerDb(join(dir, 'runner.db'));
  cleanup.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  let config = RunnerConfigSchema.parse({ runnerKey: 'key', machineId: 'machine', name: 'runner' });
  config.confirmedSettings.version = 1;
  const outbox = new Outbox(db, { confirmedVersion: () => config.confirmedSettings.version });
  const logger = memoryLogger();
  const sync = new SettingsSync({ config: () => config, saveConfig: (next) => { config = next; }, outbox, logger });
  const answer = (seq: number, refused?: true) => ({ seq, outboxEpoch: outbox.epoch, ...(refused ? { refused } : {}) });
  return { db, outbox, sync, logger, config: () => config, answer };
}

test('an equal owner echo cannot answer an undelivered local edit', () => {
  const f = setup();
  const seq = f.sync.change({ draining: true })!;
  f.sync.echo({ settings: { draining: true }, version: 2 });
  expect(f.outbox.settingsInFlight().map(e => e.seq)).toEqual([seq]);
  expect(f.outbox.settingsAnsweredSeq()).toBe(0);
  f.sync.echo({ settings: { draining: true }, version: 3, answers: f.answer(seq) });
  expect(f.outbox.settingsInFlight()).toEqual([]);
  expect(f.outbox.settingsAnsweredSeq()).toBe(seq);
});

test('explicit refusal removes only the named edit without probes, including two refusals at the same version', () => {
  const f = setup();
  const first = f.sync.change({ capacity: 3 })!;
  const second = f.sync.change({ draining: true })!;
  f.sync.echo({ settings: {}, version: 1, answers: f.answer(first, true) });
  expect(f.config().capacity).toBe(2);
  expect(f.config().draining).toBe(true);
  f.sync.echo({ settings: {}, version: 1, answers: f.answer(second, true) });
  expect(f.config().draining).toBe(false);
  expect(f.outbox.settingsInFlight()).toEqual([]);
  expect(f.outbox.eventsAfter(0)).toHaveLength(2);
  expect(f.logger.entries.filter(e => /refused a settings edit/.test(e.message))).toHaveLength(2);
});

test('answers are epoch scoped; a watermark waits for earlier answers and snapshot persistence, then survives pruning', () => {
  const f = setup();
  const first = f.sync.change({ capacity: 3 })!;
  const second = f.sync.change({ draining: true })!;
  f.sync.echo({ settings: { draining: true }, version: 2, answers: { seq: second, outboxEpoch: 'old-db' } });
  expect(f.outbox.settingsInFlight()).toHaveLength(2);
  f.sync.echo({ settings: { draining: true }, version: 2, answers: f.answer(second) });
  expect(f.outbox.settingsAnsweredSeq()).toBe(0);
  expect(f.outbox.settingsAnsweredSparse(1)).toEqual([]);
  expect(new Outbox(f.db).settingsAnsweredSparse()).toEqual([second]);
  f.sync.echo({ settings: { capacity: 3 }, version: 3, answers: f.answer(first) });
  expect(f.outbox.settingsAnsweredSeq()).toBe(second);
  expect(f.outbox.settingsAnsweredSparse()).toEqual([]);
  f.outbox.ack(f.outbox.epoch, second);
  f.outbox.pruneBefore(Number.MAX_SAFE_INTEGER);
  expect(new Outbox(f.db).settingsAnsweredSeq()).toBe(second);
});

test('a refusal cannot advance the snapshot past an accepted echo still waiting for retry', () => {
  const f = setup();
  const accepted = f.sync.change({ keepAwake: 'always' })!;
  const refused = f.sync.change({ capacity: 3 })!;
  const refusal = { settings: {}, version: 2, answers: f.answer(refused, true) };
  expect(f.sync.echo(refusal)).toBe(false);
  expect(f.config().confirmedSettings.version).toBe(1);
  expect(f.sync.echo({ settings: { keepAwake: 'always' }, version: 2, answers: f.answer(accepted) })).toBe(true);
  expect(f.sync.echo(refusal)).toBe(true);
  expect(f.config()).toMatchObject({ capacity: 2, keepAwake: 'always', confirmedSettings: { keepAwake: 'always', version: 2 } });
});

// Real hub settings/event transactions and the real runner sync, across an independently restored hub database.


function hubFor(f: ReturnType<typeof setup>) {
  const { ctx } = createTestContext();
  cleanup.push(() => ctx.db.close());
  const id = addRunner(ctx);
  ctx.db.query('UPDATE runners SET protocol = 2 WHERE id = ?').run(id);
  tx(ctx, () => reconcileHelloSettings(ctx, id, f.config().confirmedSettings));
  tx(ctx, () => cancelPendingSettings(ctx, id));
  const flush = () => {
    for (const row of pendingCommands(ctx, id, 2)) {
      if (row.command.kind === 'update_settings') expect(f.sync.echo(row.command)).toBe(true);
    }
    tx(ctx, () => cancelPendingSettings(ctx, id));
  };
  const receive = () => {
    const acked = applyRunnerEvents(ctx, id, { outboxEpoch: f.outbox.epoch, events: f.outbox.eventsAfter(0) }, { restoreReplay: true });
    flush();
    f.outbox.ack(f.outbox.epoch, acked);
  };
  const hello = () => tx(ctx, () => reconcileHelloSettings(ctx, id, f.config().confirmedSettings,
    { outboxEpoch: f.outbox.epoch, settingsAnsweredSeq: f.outbox.settingsAnsweredSeq(), settingsAnsweredSparse: f.outbox.settingsAnsweredSparse() }));
  const owner = (settings: { capacity?: number; draining?: boolean }) => tx(ctx, emit => patchRunnerSettings(ctx, emit, id, settings, 'user:alice'));
  const settings = () => runnerSettings(findRunnerRow(ctx, id)!);
  return { ctx, id, flush, receive, hello, owner, settings };
}

test('restore preserves an undelivered local edit after an equal owner echo and a later owner reversal', () => {
  const f = setup();
  const restored = hubFor(f); // backup at version 1
  const old = hubFor(f);
  const edit = f.sync.change({ draining: true })!;
  old.owner({ draining: true }); old.flush();
  old.owner({ draining: false }); old.flush();
  expect(f.config().draining).toBe(true);
  expect(f.outbox.settingsAnsweredSeq()).toBe(0);
  expect(restored.hello()).toBe('adopted');
  restored.receive();
  expect(restored.settings()).toEqual(f.config().confirmedSettings);
  expect(f.config().draining).toBe(true);
  expect(f.outbox.settingsAnsweredSeq()).toBe(edit);
  expect(f.outbox.settingsInFlight()).toEqual([]);
});

test.each([false, true])('post-backup answered edits survive restore with snapshot adoption=%s', (adopts) => {
  const f = setup();
  const restored = hubFor(f);
  const old = hubFor(f);
  f.sync.change({ draining: true });
  old.receive();
  f.sync.change({ capacity: 4 });
  old.receive();
  // An owner edit after the backup makes the restored hub ahead, so it must receive the answered edits again.
  if (!adopts) for (const capacity of [5, 6, 7]) restored.owner({ capacity });
  expect(restored.hello()).toBe(adopts ? 'adopted' : 'sent');
  restored.flush(); restored.receive();
  expect(restored.settings()).toEqual(f.config().confirmedSettings);
  expect(f.config()).toMatchObject({ capacity: 4, draining: true });
  expect(f.outbox.settingsInFlight()).toEqual([]);
  expect(restored.settings().version).toBe(adopts ? 3 : 6);
});

test.each([false, true])('adoption preserves an acknowledged pending answer, including refusal=%s', (refused) => {
  const f = setup();
  const restored = hubFor(f);
  const old = hubFor(f);
  const seq = f.sync.change({ draining: true })!;
  // Both DBs include the edit and its pending echo: this is the backup point.
  const handler = EVENT_HANDLERS['runner.settings'];
  if (refused) EVENT_HANDLERS['runner.settings'] = () => { throw new Error('refused'); };
  try {
    for (const h of [restored, old]) {
      applyRunnerEvents(h.ctx, h.id, { outboxEpoch: f.outbox.epoch, events: f.outbox.eventsAfter(0) }, { restoreReplay: false });
    }
  } finally { EVENT_HANDLERS['runner.settings'] = handler; }
  f.outbox.ack(f.outbox.epoch, seq);
  const setMeta = f.db.setMeta.bind(f.db);
  f.db.setMeta = (key, value) => {
    if (key === 'settingsEchoed') throw new Error('mark write fails');
    return setMeta(key, value);
  };
  const pending = pendingCommands(old.ctx, old.id, 2).at(-1)!.command;
  if (pending.kind !== 'update_settings') throw new Error('wrong command');
  expect(() => f.sync.echo(pending)).toThrow('mark write fails');
  // The individual answer is waiting for a failed journal/mark write. A whole
  // settings command can still run and advance the snapshot without answering it.
  const { version: _, ...values } = old.settings();
  tx(old.ctx, emit => patchRunnerSettings(old.ctx, emit, old.id, { ...values, capacity: 4 }, 'user:alice'));
  const whole = pendingCommands(old.ctx, old.id, 2).at(-1)!;
  if (whole.command.kind !== 'update_settings') throw new Error('wrong command');
  expect(f.sync.echo(whole.command)).toBe(true);
  expect(f.outbox.settingsInFlight().map(e => e.seq)).toEqual([seq]);
  expect(restored.hello()).toBe('adopted');
  expect(pendingCommands(restored.ctx, restored.id, 2).map(row => row.command)).toEqual([
    { kind: 'update_settings', settings: {}, version: f.config().confirmedSettings.version,
      answers: f.answer(seq, refused ? true : undefined) },
  ]);
  f.db.setMeta = setMeta;
  restored.flush(); restored.receive();
  restored.owner({ draining: false }); restored.flush();
  expect(restored.settings().draining).toBe(false);
  expect(f.config().draining).toBe(false);
  expect(f.outbox.settingsInFlight()).toEqual([]);
  expect(f.logger.entries.some(e => /refused a settings edit/.test(e.message))).toBe(refused);
});

test('adopting a snapshot with an answer gap must not replay a later answered edit over an owner change', () => {
  const f = setup();
  const restored = hubFor(f);
  const old = hubFor(f);
  const first = f.sync.change({ capacity: 3 })!;
  // A refused first edit at the same version can fail to journal while a later
  // accepted answer succeeds. No version gap prevents the second answer.
  const handler = EVENT_HANDLERS['runner.settings'];
  EVENT_HANDLERS['runner.settings'] = () => { throw new Error('refused'); };
  try {
    applyRunnerEvents(old.ctx, old.id, { outboxEpoch: f.outbox.epoch, events: f.outbox.eventsAfter(0) }, { restoreReplay: false });
  } finally { EVENT_HANDLERS['runner.settings'] = handler; }
  const setMeta = f.db.setMeta.bind(f.db);
  f.db.setMeta = (key, value) => {
    if (key === 'settingsEchoed' && (value as { seq: number }[]).some(m => m.seq === first)) throw new Error('first mark fails');
    return setMeta(key, value);
  };
  const refusal = pendingCommands(old.ctx, old.id, 2).at(-1)!.command;
  if (refusal.kind !== 'update_settings') throw new Error('wrong command');
  expect(() => f.sync.echo(refusal)).toThrow('first mark fails');
  const second = f.sync.change({ draining: true })!;
  applyRunnerEvents(old.ctx, old.id, { outboxEpoch: f.outbox.epoch, events: f.outbox.eventsAfter(first) }, { restoreReplay: false });
  const secondEcho = pendingCommands(old.ctx, old.id, 2).find(r => r.command.kind === 'update_settings' && r.command.answers?.seq === second)!.command;
  if (secondEcho.kind !== 'update_settings') throw new Error('wrong command');
  expect(f.sync.echo(secondEcho)).toBe(true);
  old.owner({ draining: false });
  const reversal = pendingCommands(old.ctx, old.id, 2).at(-1)!;
  if (reversal.command.kind !== 'update_settings') throw new Error('wrong command');
  expect(f.sync.echo(reversal.command)).toBe(true);
  expect(f.config().draining).toBe(false);
  expect(f.outbox.settingsAnsweredSeq()).toBe(0);
  expect(restored.hello()).toBe('adopted');
  f.db.setMeta = setMeta;
  restored.receive();
  expect(restored.settings()).toMatchObject({ draining: false, capacity: 3 });
  expect(f.config()).toMatchObject({ draining: false, capacity: 3 });
  expect(f.outbox.settingsInFlight()).toEqual([]);
});

test.each(['pruneBefore', 'pruneAcked'] as const)('%s after a backward clock jump leaves a valid hello watermark', (prune) => {
  const f = setup();
  let now = 1000;
  const outbox = new Outbox(f.db, { now: () => now, confirmedVersion: () => 2 });
  outbox.append({ type: 'runner.state', data: { state: 'ok', detail: null } });
  now = 500;
  const edit = outbox.append({ type: 'runner.settings', data: { settings: { draining: true }, baseVersion: 1 } });
  outbox.markSettingsEcho({ seq: edit.seq, outboxEpoch: outbox.epoch }, 2);
  outbox.settingsSaved(2);
  outbox.ack(outbox.epoch, edit.seq);
  now = 1000;
  expect(prune === 'pruneBefore' ? outbox.pruneBefore(750) : outbox.pruneAcked(250)).toBe(1);
  expect(outbox.eventsAfter(0).map(e => e.seq)).toEqual([1]);
  // Validate the advertised bounds with the real parser.
  const fake = new FakeRunner(() => { throw new Error('no socket required'); });
  const hello = { ...fake.hello(), outboxEpoch: outbox.epoch, firstSeq: outbox.firstSeq(),
    lastSeq: outbox.lastSeq(), settingsAnsweredSeq: outbox.settingsAnsweredSeq() };
  expect(parseRunnerMessage(JSON.stringify(hello))).toMatchObject({ ok: true });
  expect(hello.settingsAnsweredSeq).toBe(1);
  // A second prune must not replace the durable prefix with the bounded advertisement.
  expect(outbox.pruneBefore(750)).toBe(0);
  expect(f.db.meta('settingsAnswered')).toEqual({ seq: edit.seq, version: 2 });
  outbox.append({ type: 'runner.state', data: { state: 'ok', detail: null } });
  expect(new Outbox(f.db).settingsAnsweredSeq()).toBe(edit.seq);
});
