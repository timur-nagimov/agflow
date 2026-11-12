import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AttemptPhase, RunnerEvent, RunnerSettings } from '@agflow/core';
import { FakeAdapter, type FakeScript, type TranscriptLine } from '@agflow/testkit';
import type { PreflightResult } from '../src/adapters/types';
import { handoffPrompt, RUNNER_STOP_REASON } from '../src/attempt/stop';
import { OUTAGE_NUDGE } from '../src/attempt/turns';
import { AttemptStore } from '../src/attempt-store';
import { loadRunnerConfig } from '../src/config';
import { Journal } from '../src/journal';
import type { LinkState } from '../src/link';
import { Outbox } from '../src/outbox';
import { projectKey } from '../src/paths';
import type { RunnerEvents, RunnerHandle } from '../src/runner';
import type { RunnerHealth } from '../src/seams';
import { testWelcome } from './fake-hub';
import { waitFor } from './fixture';
import {
  cleanupRunnerSetups,
  hellos,
  runCommand as run,
  SETUP_PROJECT,
  type RunnerSetup,
  setupRunner as setup,
  setupSpec as specOf,
} from './runner-setup';

afterEach(cleanupRunnerSetups);

// Every test here runs git or agent processes, which take several times as long on a machine loaded by other suites.
setDefaultTimeout(30_000);

/** A turn that writes work and stays live, then the handoff turn a stop may ask for. */
const WORKING: FakeScript = {
  turns: [
    [
      { do: 'write', path: 'work.txt', content: 'work\n' },
      { do: 'sleep', ms: 30_000 },
    ],
    [{ do: 'terminal', tool: 'handoff' }],
  ],
};

/** The settings the hub confirmed last, at version 4. */
const SNAPSHOT: RunnerSettings = {
  capacity: 2,
  keepAwake: 'ac',
  draining: false,
  ceilings: { claude: { fiveHour: 0.85, weekly: 0.85 }, codex: { fiveHour: 0.85, weekly: 0.85 } },
  allowPaidUsage: { claude: false, codex: false },
  version: 4,
};

const T5 = {
  attemptId: 'T-5-a1',
  taskId: 'T-5',
  branch: 'agflow/T-5-other',
  wipRef: 'refs/agflow/T-5/a1',
  firstPrompt: 'Start working on T-5.',
};

const cloneOf = (s: RunnerSetup, attemptId = 'T-4-a1') =>
  s.paths.clone(projectKey(s.hub.url, SETUP_PROJECT), attemptId);

const eventsOf = <T extends RunnerEvent['type']>(s: RunnerSetup, type: T) =>
  s.hub.events().filter((event) => event.type === type) as Extract<RunnerEvent, { type: T }>[];

/** The local settings edits the hub received. */
const editsOf = (s: RunnerSetup) =>
  eventsOf(s, 'runner.settings').filter((event) => Object.keys(event.data.settings).length > 0);

/** The prompts the agent received, from the fake adapter's transcript. */
function promptsOf(s: RunnerSetup, attemptId = 'T-4-a1'): string[] {
  const sessionRef = new AttemptStore(s.db).get(attemptId)?.sessionRef as string;
  const file = join(cloneOf(s, attemptId), '.agflow', 'run', 'fake-transcripts', `${sessionRef}.jsonl`);
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as TranscriptLine)
    .filter((line) => line.role === 'user')
    .map((line) => line.text);
}

async function online(runner: RunnerHandle): Promise<void> {
  await waitFor(() => runner.status().link === 'online', 10_000);
}

/** Starts the attempt through the hub and waits until its agent wrote its work and is in its turn. */
async function startWorking(s: RunnerSetup, runner: RunnerHandle, overrides = {}) {
  const spec = specOf(s, overrides);
  expect(await run(s.hub, { kind: 'start_attempt', attempt: spec })).toMatchObject({ ok: true });
  await waitFor(
    () =>
      existsSync(join(cloneOf(s, spec.attemptId), 'work.txt')) &&
      runner.status().attempts.some((attempt) => attempt.attemptId === spec.attemptId && attempt.phase === 'turn'),
    10_000,
  );
  return spec;
}

describe('RunnerHandle', () => {
  test("status() lists each attempt with its phase, last push and its process's pid, pgid and lstart", async () => {
    const s = await setup();
    const runner = await s.start({ script: WORKING });
    await online(runner);
    await startWorking(s, runner);
    const pushed = await runner.pushWipNow();
    const outcome = { status: 'pushed' as const, ref: 'refs/agflow/T-4/a1', sha: expect.any(String) };
    expect(pushed).toEqual([{ attemptId: 'T-4-a1', outcome }]);
    const status = runner.status();
    expect(status).toMatchObject({
      runnerId: 'R-1',
      link: 'online',
      state: { state: 'ok', detail: null },
      settings: { capacity: 2, draining: false, keepAwake: 'ac' },
      git: { ready: true, problem: null, lastPushAt: expect.any(Number) },
    });
    expect(status.vendors.map((vendor) => vendor.vendor).sort()).toEqual(['claude', 'codex']);
    const record = new AttemptStore(s.db).get('T-4-a1');
    const [group] = new AttemptStore(s.db).processes('T-4-a1');
    expect(status.attempts).toEqual([
      {
        attemptId: 'T-4-a1',
        taskId: 'T-4',
        role: 'worker',
        vendor: 'claude',
        state: 'running',
        phase: 'turn',
        wipSha: record?.wipSha as string,
        pushedSha: record?.pushedSha as string,
        lastPushAt: record?.lastPushAt as number,
        pushError: null,
        lateWorkSha: null,
        process: { pid: group?.pid as number, pgid: group?.pgid as number, lstart: group?.lstart as string },
      },
    ]);
    expect(status.attempts[0]?.pushedSha).toBe(pushed[0]?.outcome.status === 'pushed' ? pushed[0].outcome.sha : '');
  }, 30_000);

  test("changeSettings writes runner.json and sends runner.settings, resolving with its seq; the hub's echo sets the version", async () => {
    const s = await setup();
    const runner = await s.start({ config: { confirmedSettings: SNAPSHOT } });
    await online(runner);
    const seq = await runner.changeSettings({ draining: true });
    expect(seq).toEqual(expect.any(Number));
    expect(loadRunnerConfig(s.paths.config)).toMatchObject({ draining: true, confirmedSettings: SNAPSHOT });
    const settings = () => editsOf(s);
    const [sent] = await s.hub.waitFor(() => settings().length > 0 && settings());
    expect(sent).toMatchObject({ seq, data: { settings: { draining: true }, baseVersion: 4 } });
    // Nothing changes: nothing is sent.
    expect(await runner.changeSettings({ draining: true, capacity: 2 })).toBeNull();
    // The hub applies the drain and echoes it at its next version.
    expect(await run(s.hub, { kind: 'update_settings', settings: { draining: true }, version: 5, answers: { seq: editsOf(s)[0]!.seq, outboxEpoch: s.db.outboxEpoch } })).toMatchObject({
      ok: true,
    });
    expect(loadRunnerConfig(s.paths.config)).toMatchObject({
      draining: true,
      confirmedSettings: { ...SNAPSHOT, draining: true, version: 5 },
    });
    expect(runner.status().settings.draining).toBe(true);
    expect(editsOf(s)).toHaveLength(1);
    expect(new Outbox(s.db).settingsInFlight()).toEqual([]);
  }, 60_000);

  test('a drain made while the runner was down and a capacity change made in the browser meanwhile both survive, the drain sent once', async () => {
    const s = await setup();
    const runner = await s.start({ config: { draining: true, confirmedSettings: SNAPSHOT } });
    await online(runner);
    await s.hub.waitFor(() => editsOf(s).length > 0);
    const sent = () =>
      new Outbox(s.db)
        .eventsAfter(0)
        .flatMap((event) =>
          event.type === 'runner.settings' && Object.keys(event.data.settings).length > 0 ? [event.data] : [],
        );
    // The hub had the owner's capacity change at version 5, and echoes it before it applies the drain, which it has:
    // the runner keeps the drain and does not send it again.
    expect(await run(s.hub, { kind: 'update_settings', settings: { capacity: 3 }, version: 5 })).toMatchObject({
      ok: true,
    });
    expect(sent()).toEqual([{ settings: { draining: true }, baseVersion: 4 }]);
    expect(loadRunnerConfig(s.paths.config)).toMatchObject({
      capacity: 3,
      draining: true,
      confirmedSettings: { ...SNAPSHOT, capacity: 3, version: 5 },
    });
    // The drain applied, at version 6.
    expect(await run(s.hub, { kind: 'update_settings', settings: { draining: true }, version: 6, answers: { seq: editsOf(s)[0]!.seq, outboxEpoch: s.db.outboxEpoch } })).toMatchObject({
      ok: true,
    });
    expect(sent()).toHaveLength(1);
    expect(loadRunnerConfig(s.paths.config)).toMatchObject({
      capacity: 3,
      draining: true,
      confirmedSettings: { ...SNAPSHOT, capacity: 3, draining: true, version: 6 },
    });
    expect(editsOf(s)).toHaveLength(1);
    expect(new Outbox(s.db).settingsInFlight()).toEqual([]);
  }, 60_000);

  test('a local edit back to an earlier value while an older edit is in flight is sent, and the last one wins', async () => {
    const s = await setup();
    const runner = await s.start({ config: { confirmedSettings: SNAPSHOT } });
    await online(runner);
    const sent = () => editsOf(s).map((event) => event.data.settings);
    expect(await runner.changeSettings({ draining: true })).toEqual(expect.any(Number));
    expect(await runner.changeSettings({ draining: false })).toEqual(expect.any(Number));
    await s.hub.waitFor(() => sent().length === 2);
    // The hub applied both. The drain's echo comes first: the undrain is still in flight, and runner.json holds it.
    expect(await run(s.hub, { kind: 'update_settings', settings: { draining: true }, version: 5, answers: { seq: editsOf(s)[0]!.seq, outboxEpoch: s.db.outboxEpoch } })).toMatchObject({
      ok: true,
    });
    expect(runner.status().settings.draining).toBe(false);
    // So a drain now is a change, and goes out.
    expect(await runner.changeSettings({ draining: true })).toEqual(expect.any(Number));
    await s.hub.waitFor(() => sent().length === 3);
    expect(sent()).toEqual([{ draining: true }, { draining: false }, { draining: true }]);
    for (const [draining, version] of [
      [false, 6],
      [true, 7],
    ] as const) {
      expect(await run(s.hub, { kind: 'update_settings', settings: { draining }, version, answers: { seq: editsOf(s)[version - 5]!.seq, outboxEpoch: s.db.outboxEpoch } })).toMatchObject({ ok: true });
      expect(runner.status().settings.draining).toBe(true);
    }
    expect(loadRunnerConfig(s.paths.config)).toMatchObject({
      draining: true,
      confirmedSettings: { ...SNAPSHOT, draining: true, version: 7 },
    });
    expect(sent()).toHaveLength(3);
    expect(new Outbox(s.db).settingsInFlight()).toEqual([]);
  }, 60_000);

  test('changeSettings changes nothing and rejects when runner.json cannot be written', async () => {
    const s = await setup();
    const runner = await s.start({ config: { confirmedSettings: SNAPSHOT } });
    await online(runner);
    const dir = dirname(s.paths.config);
    chmodSync(dir, 0o500);
    try {
      await expect(runner.changeSettings({ draining: true })).rejects.toThrow();
    } finally {
      chmodSync(dir, 0o700);
    }
    expect(runner.status().settings.draining).toBe(false);
    expect(loadRunnerConfig(s.paths.config).draining).toBe(false);
    expect(new Outbox(s.db).eventsAfter(0).filter((event) => event.type === 'runner.settings')).toEqual([]);
    // Written again, the drain goes.
    expect(await runner.changeSettings({ draining: true })).toEqual(expect.any(Number));
    expect(runner.status().settings.draining).toBe(true);
  }, 60_000);

  test('changeSettings changes nothing and rejects when its runner.settings cannot be stored; a saved version that cannot be noted changes nothing', async () => {
    const s = await setup();
    const runner = await s.start({ config: { confirmedSettings: SNAPSHOT } });
    await online(runner);
    const settings = () => new Outbox(s.db).eventsAfter(0).filter((event) => event.type === 'runner.settings');
    // runner.db refuses the event, as a full disk would.
    s.db.sqlite.run(`CREATE TEMP TRIGGER refuse_settings BEFORE INSERT ON outbox WHEN NEW.type = 'runner.settings'
      BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END`);
    try {
      await expect(runner.changeSettings({ draining: true })).rejects.toThrow(/full/);
    } finally {
      s.db.sqlite.run('DROP TRIGGER refuse_settings');
    }
    expect(runner.status().settings.draining).toBe(false);
    expect(loadRunnerConfig(s.paths.config).draining).toBe(false);
    expect(settings()).toEqual([]);
    // The version runner.json was written with only bounds retention: the edit goes all the same.
    s.db.sqlite.run(`CREATE TEMP TRIGGER refuse_saved BEFORE UPDATE ON meta WHEN NEW.key = 'settingsSavedVersion'
      BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END`);
    try {
      expect(await runner.changeSettings({ draining: true })).toEqual(expect.any(Number));
    } finally {
      s.db.sqlite.run('DROP TRIGGER refuse_saved');
    }
    expect(runner.status().settings.draining).toBe(true);
    expect(loadRunnerConfig(s.paths.config).draining).toBe(true);
    expect(settings().map((event) => event.type === 'runner.settings' && event.data.settings)).toEqual([
      { draining: true },
    ]);
    expect(s.logger.entries).toContainEqual(expect.objectContaining({ level: 'error', fields: { error: expect.stringMatching(/full/) } }));
  }, 60_000);

  test("stopAgents('runner_stop', { handoff: true }) runs the handoff turn and resolves with attempt.exited's seq", async () => {
    const s = await setup();
    // A turn that ends by itself soon: the handoff prompt waits for it, as it would for a real agent's.
    const script: FakeScript = {
      turns: [
        [
          { do: 'write', path: 'work.txt', content: 'work\n' },
          { do: 'sleep', ms: 1_500 },
        ],
        [{ do: 'terminal', tool: 'handoff' }],
      ],
    };
    const runner = await s.start({ script });
    await online(runner);
    await startWorking(s, runner);
    const seqs = await runner.stopAgents('runner_stop', { handoff: true });
    const exited = await s.hub.waitFor(() => eventsOf(s, 'attempt.exited').length > 0 && eventsOf(s, 'attempt.exited'));
    expect(exited.map((event) => event.seq)).toEqual(seqs);
    expect(exited[0]?.data).toMatchObject({ cause: 'runner_stop', handoffWritten: true });
    expect(promptsOf(s)).toEqual(['Start working on T-4.', handoffPrompt(RUNNER_STOP_REASON)]);
    expect(new AttemptStore(s.db).get('T-4-a1')?.state).toBe('stopped');
    expect(runner.status().attempts[0]?.phase).toBeNull();
  }, 30_000);

  test("stopAgents('suspend', { handoff: false }) stops every agent at once, pushes the oldest unpushed work first and records the attempts suspended", async () => {
    const s = await setup();
    // When each attempt's ladder began: how many attempt.exited the outbox held then.
    const exited = () => new Outbox(s.db).eventsAfter(0).filter((event) => event.type === 'attempt.exited').length;
    const laddered = new Map<string, number>();
    const events: RunnerEvents = {
      attemptState: (change) => {
        if (change.phase === 'stopping' && !laddered.has(change.attemptId)) laddered.set(change.attemptId, exited());
      },
    };
    const runner = await s.start({ script: WORKING, events });
    await online(runner);
    await startWorking(s, runner);
    await startWorking(s, runner, T5);
    // T-4 pushed a moment ago; T-5's work has waited since long before.
    const store = new AttemptStore(s.db);
    store.update('T-4-a1', { lastPushAt: Date.now() });
    store.update('T-5-a1', { lastPushAt: 1_000 });
    // Every push to the origin takes a second: T-5's final push is still going when T-4's agent is stopped.
    writeFileSync(join(s.origin.path, 'hooks', 'pre-receive'), '#!/bin/sh\nsleep 1\n', { mode: 0o755 });
    const began = performance.now();
    const seqs = await runner.stopAgents('suspend', { handoff: false });
    expect(performance.now() - began).toBeGreaterThan(2_000);
    expect(Object.fromEntries(laddered)).toEqual({ 'T-4-a1': 0, 'T-5-a1': 0 });
    const reported = await s.hub.waitFor(
      () => eventsOf(s, 'attempt.exited').length > 1 && eventsOf(s, 'attempt.exited'),
    );
    expect(reported.map((event) => [event.attemptId, event.seq])).toEqual([
      ['T-5-a1', seqs[0]],
      ['T-4-a1', seqs[1]],
    ]);
    expect(reported.map((event) => event.data.cause)).toEqual(['suspend', 'suspend']);
    expect(promptsOf(s)).toEqual(['Start working on T-4.']);
    expect(promptsOf(s, 'T-5-a1')).toEqual(['Start working on T-5.']);
    expect(store.get('T-4-a1')?.state).toBe('suspended');
    expect(store.get('T-5-a1')?.state).toBe('suspended');
    // Nothing is left to stop.
    expect(await runner.stopAgents('suspend', { handoff: false })).toEqual([]);
  }, 30_000);

  test('interruptAgents({ outage: true }) ends the turn without an exit, and the next welcome brings the reconnect message', async () => {
    const s = await setup();
    const runner = await s.start({ script: WORKING, config: { timings: { backoffBase: 50, backoffCap: 100 } } });
    await online(runner);
    await startWorking(s, runner);
    await runner.interruptAgents({ outage: true });
    await waitFor(() => runner.status().attempts[0]?.phase === 'idle');
    expect(eventsOf(s, 'attempt.exited')).toEqual([]);
    expect(promptsOf(s)).toEqual(['Start working on T-4.']);
    // The link comes back: the welcome that follows sends the one nudge.
    s.hub.connections[0]?.close(4000, 'the hub restarts');
    await waitFor(() => s.hub.connections.length > 1 && runner.status().link === 'online', 10_000);
    await waitFor(() => promptsOf(s).length > 1, 10_000);
    expect(promptsOf(s)).toEqual(['Start working on T-4.', OUTAGE_NUDGE]);
    expect(eventsOf(s, 'attempt.exited')).toEqual([]);
    // pushWipNow pushes the changed clone once; unchanged, it pushes nothing.
    const [first] = await runner.pushWipNow();
    expect(first?.outcome.status).toBe('pushed');
    expect(await runner.pushWipNow()).toEqual([{ attemptId: 'T-4-a1', outcome: { status: 'unchanged' } }]);
    expect(eventsOf(s, 'attempt.wip')).toHaveLength(1);
  }, 30_000);

  test('interruptAgents({ outage: false }) brings no reconnect message; pushWipNow holds what canPushWip forbids', async () => {
    // No heartbeat_ack ever: the hub has not answered within wipGraceMs, so no WIP push may go.
    const timings = { heartbeatMs: 1_000, deadLinkMs: 60_000, handoffMs: 1_000, wipGraceMs: 300 };
    const s = await setup({ heartbeatAck: false, welcome: { timings } });
    // Every turn after the first does nothing.
    const script: FakeScript = { turns: [WORKING.turns[0] ?? []] };
    const runner = await s.start({ script, config: { timings: { backoffBase: 50, backoffCap: 100 } } });
    await online(runner);
    const spec = await startWorking(s, runner);
    // The welcome is the last word from the hub: once wipGraceMs has passed since it, however fast the start was.
    await Bun.sleep(timings.wipGraceMs + 200);
    expect(await runner.pushWipNow()).toEqual([
      { attemptId: 'T-4-a1', outcome: { status: 'held', sha: expect.any(String) } },
    ]);
    expect(eventsOf(s, 'attempt.wip')).toEqual([]);
    await runner.interruptAgents({ outage: false });
    await waitFor(() => runner.status().attempts[0]?.phase === 'idle');
    // The link comes back: a plain interrupt is no outage, so the next turn is the hub's delivery alone.
    s.hub.connections[0]?.close(4000, 'the hub restarts');
    await waitFor(() => s.hub.connections.length > 1 && runner.status().link === 'online', 10_000);
    const message = { messageId: 7, authority: 'person' as const, text: 'carry on' };
    const delivery = { kind: 'deliver' as const, attemptId: 'T-4-a1', fence: spec.fence, messages: [message], more: 0 };
    expect(await run(s.hub, delivery)).toMatchObject({ ok: true });
    await waitFor(() => promptsOf(s).length > 1 && runner.status().attempts[0]?.phase === 'idle', 10_000);
    const prompts = promptsOf(s);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('carry on');
    expect(prompts).not.toContain(OUTAGE_NUDGE);
  }, 30_000);

  test('pause() holds commands unjournaled and unrun; resume() runs them in order', async () => {
    const s = await setup();
    const runner = await s.start();
    await online(runner);
    runner.pause();
    const first = s.hub.command({ kind: 'preflight', vendor: 'codex' });
    const second = s.hub.command({ kind: 'preflight', vendor: 'claude' });
    await Bun.sleep(300);
    const journal = new Journal(s.db);
    expect(journal.get(first)).toBeNull();
    expect(journal.get(second)).toBeNull();
    expect(s.hub.results.get(first)).toBeUndefined();
    expect(eventsOf(s, 'runner.vendors')).toEqual([]);
    runner.resume();
    await s.hub.waitFor(() => s.hub.results.get(first) && s.hub.results.get(second));
    expect(journal.get(first)?.state).toBe('done');
    // Each preflight's report lists every vendor: the hub replaces the runner's list with it.
    const reports = eventsOf(s, 'runner.vendors').map((event) => event.data.vendors.map((vendor) => vendor.vendor));
    expect(reports.map((vendors) => vendors.sort())).toEqual([
      ['claude', 'codex'],
      ['claude', 'codex'],
    ]);
  }, 60_000);

  test('waitAcked resolves true once the hub acknowledges the seq, at once if it has, and false after the timeout', async () => {
    const s = await setup({ autoAck: false });
    const runner = await s.start({ config: { confirmedSettings: SNAPSHOT } });
    await online(runner);
    const seq = (await runner.changeSettings({ capacity: 3 })) as number;
    await s.hub.waitFor(() => eventsOf(s, 'runner.settings').length > 0);
    expect(await runner.waitAcked(seq, 100)).toBe(false);
    const acked = runner.waitAcked(seq, 5_000);
    const [hello] = hellos(s.hub);
    s.hub.connections[0]?.send({ t: 'ack', outboxEpoch: hello?.outboxEpoch as string, seq });
    expect(await acked).toBe(true);
    expect(await runner.waitAcked(seq, 1)).toBe(true);
  }, 60_000);

  test('4409, 4403 and 4426 closes resolve done with replaced, refused and incompatible; close() with closed', async () => {
    const s = await setup();
    const runner = await s.start();
    await online(runner);
    s.hub.connections[0]?.close(4409, 'another process uses this key');
    expect(await runner.done).toEqual({ kind: 'replaced', reason: 'another process uses this key' });

    const retired = await setup();
    const refused = await retired.start();
    await online(refused);
    retired.hub.connections[0]?.close(4403, 'retired');
    expect(await refused.done).toEqual({ kind: 'refused', reason: 'retired' });

    const newer = await setup();
    const incompatible = await newer.start();
    await online(incompatible);
    newer.hub.connections[0]?.close(4426, 'needs protocol 3');
    expect(await incompatible.done).toEqual({ kind: 'incompatible', reason: 'needs protocol 3' });

    const other = await setup();
    const closed = await other.start();
    await online(closed);
    await closed.close();
    expect(await closed.done).toEqual({ kind: 'closed', reason: '' });
  }, 60_000);
});

describe('RunnerEvents', () => {
  test('link carries close codes; needsLogin, gap and attemptState are called as they happen', async () => {
    const s = await setup();
    const links: [LinkState, { code: number | null; reason: string }][] = [];
    const states: { attemptId: string; phase: AttemptPhase | null; live: number }[] = [];
    let needsLogin = 0;
    const gaps: number[] = [];
    const events: RunnerEvents = {
      link: (state, detail) => links.push([state, detail]),
      gap: (gap) => gaps.push(gap.ms),
      needsLogin: () => {
        needsLogin += 1;
      },
      attemptState: (change) => states.push(change),
    };
    const runner = await s.start({
      events,
      script: WORKING,
      config: { timings: { backoffBase: 50, backoffCap: 100, loginProbe: 100, tickGap: 2_000 } },
    });
    await online(runner);
    await startWorking(s, runner);
    expect(states[0]).toEqual({ attemptId: 'T-4-a1', phase: 'starting', live: 1 });
    expect(states.at(-1)).toEqual({ attemptId: 'T-4-a1', phase: 'turn', live: 1 });
    await runner.stopAgents('runner_stop', { handoff: false });
    expect(states.at(-1)).toEqual({ attemptId: 'T-4-a1', phase: null, live: 0 });

    // The hub drops the link; the CLI's token is refused meanwhile.
    s.credentials.token = 'revoked';
    s.hub.connections[0]?.close(4000, 'the hub restarts');
    await waitFor(() => needsLogin === 1, 10_000);
    expect(links).toContainEqual(['backoff', { code: 4000, reason: 'the hub restarts' }]);
    expect(runner.status().link).toBe('needs_login');
    // After agflow login, the probe finds the token good and the link comes back.
    s.credentials.token = 'cli_token_for_the_runner';
    await waitFor(() => runner.status().link === 'online', 10_000);
    expect(links.at(-1)).toEqual(['online', { code: null, reason: '' }]);

    // A freeze longer than the tick gap is a clock gap.
    Bun.sleepSync(3_500);
    await waitFor(() => gaps.length > 0, 5_000);
    expect(gaps[0]).toBeGreaterThan(2_000);
    expect(needsLogin).toBe(1);
  }, 40_000);

  test('welcome is called before the executor runs any command that follows it', async () => {
    const s = await setup({ welcome: false });
    const order: string[] = [];
    const health: RunnerHealth = {
      admit: () => {
        order.push('admit');
        return null;
      },
      heartbeat: () => ({ power: null, disk: null, acceptingUntil: null }),
      state: () => ({ state: 'ok', detail: null }),
    };
    const runner = await s.start({
      health,
      events: { welcome: (welcome) => order.push(`welcome ${welcome.runnerId}`) },
      script: WORKING,
    });
    const connection = await s.hub.connection(0);
    await s.hub.waitFor(() => connection.messages.some((message) => message.t === 'hello'));
    connection.send(testWelcome(0));
    const started = run(s.hub, { kind: 'start_attempt', attempt: specOf(s) });
    expect(await started).toMatchObject({ ok: true });
    expect(order).toEqual(['welcome R-1', 'admit']);
    await online(runner);
  }, 60_000);

  test('preflight runs again every preflightEvery and sends runner.vendors only on a change; a health state change sends runner.state', async () => {
    const timings = { heartbeatMs: 50, deadLinkMs: 60_000, handoffMs: 1_000, wipGraceMs: 300_000 };
    const s = await setup({ welcome: { timings } });
    let ready = true;
    let preflights = 0;
    const claude = new FakeAdapter({ vendor: 'claude', skipAuthChecks: true, script: { turns: [[]] } });
    const preflight = claude.preflight.bind(claude);
    claude.preflight = async (): Promise<PreflightResult> => {
      preflights += 1;
      const result = await preflight();
      return { ...result, facts: { ...result.facts, ready, problem: ready ? result.facts.problem : 'logged out' } };
    };
    let state: ReturnType<RunnerHealth['state']> = { state: 'ok', detail: null };
    const health: RunnerHealth = {
      admit: () => null,
      heartbeat: () => ({ power: null, disk: null, acceptingUntil: null }),
      state: () => state,
    };
    const runner = await s.start({ adapters: [claude], health, config: { timings: { preflightEvery: 100 } } });
    await online(runner);
    await waitFor(() => preflights >= 4);
    expect(eventsOf(s, 'runner.vendors')).toEqual([]);
    ready = false;
    const reports = () => eventsOf(s, 'runner.vendors');
    const [report] = await s.hub.waitFor(() => reports().length > 0 && reports());
    expect(report?.data.vendors).toMatchObject([{ vendor: 'claude', ready: false, problem: 'logged out' }]);
    const after = preflights;
    await waitFor(() => preflights >= after + 3);
    expect(eventsOf(s, 'runner.vendors')).toHaveLength(1);
    expect(runner.status().vendors[0]?.ready).toBe(false);

    expect(eventsOf(s, 'runner.state')).toEqual([]);
    state = { state: 'disk_low', detail: '2 GB free' };
    const [changed] = await s.hub.waitFor(() => eventsOf(s, 'runner.state').length > 0 && eventsOf(s, 'runner.state'));
    expect(changed?.data).toEqual({ state: 'disk_low', detail: '2 GB free' });
    await Bun.sleep(200);
    expect(eventsOf(s, 'runner.state')).toHaveLength(1);
    state = { state: 'ok', detail: null };
    await s.hub.waitFor(() => eventsOf(s, 'runner.state').length > 1);
    expect(eventsOf(s, 'runner.state').map((event) => event.data.state)).toEqual(['disk_low', 'ok']);
  }, 30_000);

  test("a runner.state the outbox replays after a newer hello is followed by the hello's own state", async () => {
    const timings = { heartbeatMs: 50, deadLinkMs: 60_000, handoffMs: 1_000, wipGraceMs: 300_000 };
    const s = await setup({ autoAck: false, welcome: { timings } });
    let state: ReturnType<RunnerHealth['state']> = { state: 'ok', detail: null };
    const health: RunnerHealth = {
      admit: () => null,
      heartbeat: () => ({ power: null, disk: null, acceptingUntil: null }),
      state: () => state,
    };
    // The disk recovers as the link drops: no heartbeat goes out until the next hello.
    const events: RunnerEvents = {
      link: (linkState) => {
        if (linkState === 'backoff') state = { state: 'ok', detail: null };
      },
    };
    const runner = await s.start({ health, events, config: { timings: { backoffBase: 50, backoffCap: 100 } } });
    await online(runner);
    state = { state: 'disk_low', detail: '2 GB free' };
    await s.hub.waitFor(() => eventsOf(s, 'runner.state').length > 0);
    // The link drops before the hub acknowledges it.
    s.hub.connections[0]?.close(4000, 'the hub restarts');
    const second = await s.hub.connection(1, 10_000);
    const states = () =>
      second.messages.flatMap((message) =>
        message.t === 'events'
          ? (message.events.filter((event) => event.type === 'runner.state') as Extract<
              RunnerEvent,
              { type: 'runner.state' }
            >[])
          : [],
      );
    await s.hub.waitFor(() => states().length > 1, 10_000);
    expect(hellos(s.hub)[1]?.state).toBe('ok');
    // The replay brings the stale report back; the hello's state follows it, so the hub's last word is current.
    expect(states().map((event) => event.data)).toEqual([
      { state: 'disk_low', detail: '2 GB free' },
      { state: 'ok', detail: null },
    ]);
  }, 30_000);
});
