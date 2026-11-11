import { afterEach, describe, expect, setDefaultTimeout, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { COMMAND_MIN_PROTOCOL, type RunnerCommand, RunnerCommandSchema, type Vendor } from '@agflow/core';
import { gitIn } from '@agflow/testkit';
import type { PreflightResult } from '../src/adapters/types';
import type { AttemptController, ControllerDeps } from '../src/attempt/controller';
import { saveRunnerConfig } from '../src/config';
import { CommandExecutor, RESTARTABLE_COMMANDS } from '../src/executor';
import { Journal } from '../src/journal';
import type { CommandMessage, WelcomeMessage } from '../src/link';
import { Outbox } from '../src/outbox';
import type { PrepareInput } from '../src/seams';
import { vendorReport } from '../src/vendors';
import {
  cleanupRunnerFixtures,
  createRunnerFixture,
  FIXTURE_PROJECT,
  FIXTURE_WIP_PREFIX,
  type RunnerFixture,
  waitFor,
} from './fixture';

// Every test here runs git or agent processes, which take several times as long on a machine loaded by other suites.
setDefaultTimeout(30_000);

const liveControllers: AttemptController[] = [];
afterEach(async () => {
  // Close fake sessions first, so an assertion failure does not leave an idle child waiting on stdin.
  for (const controller of liveControllers.splice(0)) await controller.session?.close();
  await cleanupRunnerFixtures();
});

const FENCE = { epoch: 1, counter: 1 };
const STOP = {
  kind: 'stop_attempt',
  attemptId: 'T-4-a1',
  fence: FENCE,
  cause: 'stop',
  reason: 'stopped by a person',
  handoff: false,
  interruptFirst: false,
  keepClone: true,
} as const;

function message(command: RunnerCommand, seq = 1): CommandMessage {
  return { t: 'command', id: `1-R-1-${seq}`, seq, command };
}

function welcome(stop: WelcomeMessage['stop']): WelcomeMessage {
  return {
    t: 'welcome',
    runnerId: 'R-1',
    hubEpoch: 1,
    hubTime: Date.now(),
    ackedSeq: 0,
    wipRefPrefix: FIXTURE_WIP_PREFIX,
    stop,
    timings: { heartbeatMs: 15_000, deadLinkMs: 45_000, handoffMs: 2_000, wipGraceMs: 300_000 },
  };
}

/** Timers a test fires by hand. */
function manualTimers() {
  const set: { run: () => void; ms: number; done: boolean }[] = [];
  const waiting = () => set.filter((timer) => !timer.done);
  return {
    setTimeout: (run: () => void, ms: number) => {
      const timer = { run, ms, done: false };
      set.push(timer);
      return timer;
    },
    clearTimeout: (handle: unknown) => {
      (handle as { done: boolean }).done = true;
    },
    /** The timers set and neither fired nor cleared, oldest first. */
    waiting,
    /** Fires the oldest waiting timer. */
    fire: () => {
      const timer = waiting()[0];
      if (timer === undefined) throw new Error('no timer is waiting');
      timer.done = true;
      timer.run();
    },
  };
}

/** The runtime wiring. */
function executor(f: RunnerFixture, overrides: Partial<ControllerDeps> = {}) {
  const journal = new Journal(f.db);
  const controllers = new Map<string, AttemptController>();
  const controller = (id: string) => {
    let value = controllers.get(id);
    if (!value) {
      value = f.controller(id, overrides);
      controllers.set(id, value);
      liveControllers.push(value);
    }
    return value;
  };
  const deps = f.deps(overrides);
  // Each vendor's last preflight, as the runtime keeps them.
  const preflights = new Map<Vendor, { result: PreflightResult; at: number }>();
  const options = {
    journal,
    controller,
    known: (id: string) => controllers.has(id) || f.store.get(id) !== null,
    config: () => f.config,
    // As the runtime does: config() gives the new settings even when the write fails.
    saveConfig: (config: RunnerFixture['config']) => {
      f.config = config;
      saveRunnerConfig(f.paths.config, config);
    },
    outbox: f.outbox,
    vault: f.vault,
    local: f.local,
    remote: deps.remote,
    wipRefPrefix: () => FIXTURE_WIP_PREFIX,
    adapters: f.adapters,
    preflighted: (result: PreflightResult) => preflights.set(result.facts.vendor, { result, at: Date.now() }),
    vendors: () => {
      const each = [...preflights.values()].map(({ result, at }) =>
        vendorReport({ config: f.config, preflights: [result], at, preparer: deps.preparer }),
      );
      return { vendors: each.flatMap((report) => report.vendors), quota: each.flatMap((report) => report.quota) };
    },
    logger: f.logger,
  };
  return { run: new CommandExecutor(options), journal, controller, options, preflights };
}

function commands(f: RunnerFixture): RunnerCommand[] {
  const attemptId = 'T-4-a1';
  return [
    { kind: 'start_attempt', attempt: f.spec() },
    {
      kind: 'resume_attempt',
      attemptId,
      fence: FENCE,
      agentToken: f.spec().agentToken,
      prompt: 'resume',
      messages: [],
      taskPack: null,
      restore: f.spec().restore,
      acceptanceIds: [],
    },
    STOP,
    { kind: 'hold_attempt', attemptId, fence: FENCE },
    { kind: 'deliver', attemptId, fence: FENCE, messages: [], more: 0 },
    { kind: 'interrupt', attemptId, fence: FENCE },
    { kind: 'decide_approval', attemptId, fence: FENCE, approvalId: randomUUID(), decision: 'approve', reason: null },
    {
      kind: 'push_submission',
      attemptId,
      fence: FENCE,
      submissionId: 'S-1',
      branch: 'agflow/T-4-tidy',
      expectedBranchSha: null,
      adoptable: [],
    },
    { kind: 'prepare_takeover', attemptId, fence: FENCE, person: 'owner' },
    { kind: 'hand_back', attemptId, source: { kind: 'clone' } },
    { kind: 'cleanup_attempt', attemptId },
    { kind: 'upload_transcript', attemptId },
    { kind: 'prepare_dependencies', attemptId, fence: FENCE, requestId: '1-R-1-99' },
    { kind: 'refresh_vault', taskId: 'T-4', refs: [] },
    { kind: 'delete_refs', refs: [] },
    { kind: 'update_settings', settings: { capacity: 3 }, version: 1 },
    { kind: 'preflight', vendor: 'claude' },
  ];
}

/** Dispatch probes, leaving process, git and preparation behavior to the integration tests below. */
function probes(controller: AttemptController) {
  return {
    start_attempt: spyOn(controller, 'start').mockResolvedValue({ started: true }),
    resume_attempt: spyOn(controller, 'resume').mockResolvedValue({ resumed: true }),
    stop_attempt: spyOn(controller, 'stop').mockResolvedValue({ ok: true, stoppedBy: 'none', exitedSeq: 1 }),
    hold_attempt: spyOn(controller, 'hold').mockResolvedValue({ ok: true, stoppedBy: 'none', exitedSeq: 1 }),
    deliver: spyOn(controller, 'deliver').mockResolvedValue({ ok: true }),
    interrupt: spyOn(controller, 'interrupt').mockResolvedValue({ ok: true }),
    decide_approval: spyOn(controller, 'decideApproval').mockResolvedValue({ applied: false }),
    push_submission: spyOn(controller, 'submit').mockResolvedValue({
      ok: true,
      outcome: { submissionId: 'S-1', ok: true, headSha: 'a'.repeat(40), remoteHead: null, error: null, detail: null },
    }),
    prepare_takeover: spyOn(controller, 'prepareTakeover').mockResolvedValue({ ok: true, takenOverSeq: 1 }),
    hand_back: spyOn(controller, 'handBack').mockResolvedValue({ ok: true, handedBack: null }),
    cleanup_attempt: spyOn(controller, 'cleanup').mockResolvedValue({ ok: true }),
    upload_transcript: spyOn(controller, 'uploadTranscript').mockResolvedValue({ uploaded: false }),
    prepare_dependencies: spyOn(controller, 'prepareRequested').mockResolvedValue({
      ok: true,
      prepared: { requestId: '1-R-1-13', ok: true, error: null, logTail: null },
    }),
  };
}

describe('CommandExecutor', () => {
  test('journals before execution, joins a running resend by id or key, and returns the stored result', async () => {
    const f = await createRunnerFixture();
    const x = executor(f);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const controller = x.controller('T-4-a1');
    const original = controller.start.bind(controller);
    const start = spyOn(controller, 'start').mockImplementation(async (spec) => {
      expect(x.journal.get('1-R-1-1')?.state).toBe('running');
      expect(JSON.stringify(x.journal.get('1-R-1-1'))).not.toContain(spec.agentToken);
      entered.resolve();
      await release.promise;
      return original(spec);
    });
    const command = { kind: 'start_attempt', attempt: f.spec() } as const;
    const first = x.run.onCommand(message(command));
    await entered.promise;
    const duplicate = x.run.onCommand(message(command));
    const newId = x.run.onCommand(message(command, 2));
    expect(start).toHaveBeenCalledTimes(1);
    release.resolve();
    const result = { ok: true, data: { started: true } };
    expect(await Promise.all([first, duplicate, newId])).toEqual([result, result, result]);
    expect(x.journal.get('1-R-1-1')).toMatchObject({ state: 'done', result });
    expect(await x.run.onCommand(message(command, 3))).toEqual(result);
    expect(start).toHaveBeenCalledTimes(1);
  }, 60_000);

  test('start, stop and submission keep seq order; delivery and approval bypass a handoff stop', async () => {
    const f = await createRunnerFixture({
      script: {
        turns: [
          [],
          [
            { do: 'approval', kind: 'command', summary: 'write the handoff' },
            { do: 'terminal', tool: 'handoff' },
          ],
        ],
      },
      config: { timings: { submitRetry: 1 } },
    });
    const x = executor(f);
    await x.run.onCommand(message({ kind: 'start_attempt', attempt: f.spec() }));
    await waitFor(() => x.controller('T-4-a1').phase === 'idle');
    let stopped = false;
    const stopping = x.run.onCommand(message({ ...STOP, handoff: true }, 2)).then((result) => {
      stopped = true;
      return result;
    });
    const submitting = x.run.onCommand(message(commands(f).find((c) => c.kind === 'push_submission')!, 3));
    const approval = await waitFor(() => f.events('approval.requested')[0]);
    expect(f.events('attempt.submitted')).toHaveLength(0);
    expect(
      await x.run.onCommand(
        message(
          {
            kind: 'deliver',
            attemptId: 'T-4-a1',
            fence: FENCE,
            messages: [{ messageId: 7, authority: 'person', text: 'include the tests' }],
            more: 0,
          },
          4,
        ),
      ),
    ).toEqual({ ok: true, data: { ok: true } });
    expect(stopped).toBe(false);
    expect(
      await x.run.onCommand(
        message(
          {
            kind: 'decide_approval',
            attemptId: 'T-4-a1',
            fence: FENCE,
            approvalId: approval.data.approvalId,
            decision: 'approve',
            reason: null,
          },
          5,
        ),
      ),
    ).toEqual({ ok: true, data: { applied: true } });
    expect(stopped).toBe(false);
    expect((await stopping)?.ok).toBe(true);
    // The submission runs after the stop: the attempt has exited, so it is answered at once, as remote.
    expect(await submitting).toMatchObject({ ok: false, error: 'remote', data: { error: 'remote' } });
    const events = f.events();
    const spawned = events.find((e) => e.type === 'attempt.spawned')!;
    const exited = events.find((e) => e.type === 'attempt.exited')!;
    const submitted = events.find((e) => e.type === 'attempt.submitted')!;
    expect(spawned.seq).toBeLessThan(exited.seq);
    expect(exited.seq).toBeLessThan(submitted.seq);
  }, 60_000);

  test('a stop queued during start waits for it, while two attempts start concurrently', async () => {
    const f = await createRunnerFixture();
    const release = Promise.withResolvers<void>();
    const admitted: string[] = [];
    const deps = f.deps();
    const x = executor(f, {
      health: {
        ...deps.health,
        admit: async (spec) => {
          admitted.push(spec.attemptId);
          await release.promise;
          return null;
        },
      },
    });
    const first = x.run.onCommand(message({ kind: 'start_attempt', attempt: f.spec() }, 1));
    const stopping = x.run.onCommand(message(STOP, 2));
    const second = x.run.onCommand(
      message(
        {
          kind: 'start_attempt',
          attempt: f.spec({ attemptId: 'T-5-a1', taskId: 'T-5', branch: 'agflow/T-5-x', wipRef: 'refs/agflow/T-5/a1' }),
        },
        3,
      ),
    );
    await waitFor(() => admitted.length === 2);
    expect(f.events('attempt.exited')).toHaveLength(0);
    release.resolve();
    expect((await first)?.ok).toBe(true);
    expect((await second)?.ok).toBe(true);
    expect((await stopping)?.ok).toBe(true);
    expect(f.events('attempt.spawned').find((e) => e.attemptId === 'T-4-a1')!.seq).toBeLessThan(
      f.events('attempt.exited')[0]!.seq,
    );
  }, 60_000);

  test('every protocol kind has a handler; invalid payloads are unsupported and unknown attempts are refused', async () => {
    const f = await createRunnerFixture();
    const x = executor(f);
    const handlers = probes(x.controller('T-4-a1'));
    const all = commands(f);
    expect(all.map((c) => c.kind).sort()).toEqual(
      (Object.keys(COMMAND_MIN_PROTOCOL) as RunnerCommand['kind'][]).sort(),
    );
    for (const [i, command] of all.entries()) {
      expect(RunnerCommandSchema.safeParse(command).success).toBe(true);
      const result = await x.run.onCommand(message(command, i + 1));
      expect(result?.ok).toBe(true);
      if (command.kind in handlers) expect(handlers[command.kind as keyof typeof handlers]).toHaveBeenCalledTimes(1);
    }
    for (const command of [
      { kind: 'future_command' },
      { kind: 'deliver', attemptId: 'T-4-a1', fence: FENCE, messages: [], more: -1 },
    ]) {
      expect(await x.run.onCommand(message(command as RunnerCommand, 50))).toEqual({ ok: false, error: 'unsupported' });
      expect(x.journal.get('1-R-1-50')).toBeNull();
    }
    expect(await x.run.onCommand(message({ kind: 'interrupt', attemptId: 'T-99-a1', fence: FENCE }, 51))).toEqual({
      ok: false,
      error: 'unknown_attempt',
    });
  });

  test('controller refusals retain their errors, and failed submission outcomes are failures', async () => {
    const f = await createRunnerFixture();
    const x = executor(f);
    const controller = x.controller('T-4-a1');
    expect(
      await x.run.onCommand(message({ kind: 'deliver', attemptId: 'T-4-a1', fence: FENCE, messages: [], more: 0 })),
    ).toEqual({ ok: false, error: 'stale_fence' });
    spyOn(controller, 'start').mockResolvedValue({
      started: false,
      refused: 'draining',
      error: 'the runner is draining',
    });
    expect(await x.run.onCommand(message({ kind: 'start_attempt', attempt: f.spec() }, 2))).toEqual({
      ok: false,
      error: 'the runner is draining',
    });
    spyOn(controller, 'submit').mockResolvedValue({
      ok: true,
      outcome: {
        submissionId: 'S-1',
        ok: false,
        headSha: null,
        remoteHead: null,
        error: 'dirty',
        detail: 'commit work first',
      },
    });
    // A hand-back refused for processes in the clone keeps their pids for the person (X-37).
    const handBack = spyOn(controller, 'handBack').mockResolvedValue({
      ok: false,
      error: 'process_running',
      pids: [4242, 4243],
    });
    expect(
      await x.run.onCommand(message({ kind: 'hand_back', attemptId: 'T-4-a1', source: { kind: 'clone' } }, 4)),
    ).toEqual({
      ok: false,
      error: 'process_running',
      data: { pids: [4242, 4243] },
    });
    // Any other refusal is its error alone.
    handBack.mockResolvedValue({ ok: false, error: 'the clone is gone' });
    expect(
      await x.run.onCommand(message({ kind: 'hand_back', attemptId: 'T-4-a1', source: { kind: 'clone' } }, 5)),
    ).toEqual({ ok: false, error: 'the clone is gone' });
    // The command's result repeats the outcome attempt.submitted reports.
    expect(await x.run.onCommand(message(commands(f).find((c) => c.kind === 'push_submission')!, 3))).toEqual({
      ok: false,
      error: 'dirty',
      data: { submissionId: 'S-1', ok: false, headSha: null, remoteHead: null, error: 'dirty', detail: 'commit work first' },
    });
  });

  test('welcome.stop fences immediately, saves the next late-work ref and exits only a live process, without handoff', async () => {
    const f = await createRunnerFixture();
    const x = executor(f);
    await x.run.onCommand(message({ kind: 'start_attempt', attempt: f.spec() }));
    const controller = x.controller('T-4-a1');
    await waitFor(() => controller.phase === 'idle');
    const clone = f.store.get('T-4-a1')!.clone!;
    writeFileSync(join(clone, 'late.txt'), 'after the lease expired\n');
    const old = await gitIn(f.origin.path, ['rev-parse', 'refs/heads/main']);
    await gitIn(f.origin.path, ['update-ref', 'refs/agflow/T-4/a1-late-1', old.trim()]);
    f.store.update('T-4-a1', { lateWorkCount: 1 });
    f.store.create(
      f.spec({ attemptId: 'T-5-a1', taskId: 'T-5', branch: 'agflow/T-5-x', wipRef: 'refs/agflow/T-5/a1' }),
      { clone: null, tmpDir: null, cliVersion: null },
    );
    const stopping = x.run.onWelcome(
      welcome([
        { attemptId: 'T-4-a1', reason: 'lease expired' },
        { attemptId: 'T-5-a1', reason: 'already ended' },
        { attemptId: 'T-99-a1', reason: 'unknown' },
      ]),
    );
    expect(f.store.get('T-4-a1')?.endedAt).not.toBeNull();
    // A command that follows the welcome is refused at once; a resend of one already done keeps its result.
    const refenced = { ...commands(f)[1], fence: { epoch: 1, counter: 2 } } as RunnerCommand;
    expect(await x.run.onCommand(message(refenced, 2))).toEqual({ ok: false, error: 'attempt_ended' });
    expect(await x.run.onCommand(message({ kind: 'start_attempt', attempt: f.spec() }))).toEqual({
      ok: true,
      data: { started: true },
    });
    await stopping;
    expect(controller.session).toBeNull();
    const late = await waitFor(() => f.events('attempt.late_work')[0]);
    expect(late.data.ref).toBe('refs/agflow/T-4/a1-late-2');
    expect(await gitIn(f.origin.path, ['show', `${late.data.ref}:late.txt`])).toBe('after the lease expired');
    expect(f.events('attempt.exited')).toHaveLength(1);
    expect(f.events('attempt.exited')[0]).toMatchObject({
      attemptId: 'T-4-a1',
      data: { finalWip: null, cause: null, handoffWritten: false },
    });
    const session = f.store.get('T-4-a1')!.sessionRef!;
    const transcript = readFileSync(join(clone, '.agflow/run/fake-transcripts', `${session}.jsonl`), 'utf8');
    expect(transcript).not.toContain('Call write_handoff');
    for (const attemptId of ['T-4-a1', 'T-5-a1', 'T-99-a1']) {
      expect(await x.run.onCommand(message({ kind: 'interrupt', attemptId, fence: FENCE }, 10))).toEqual({
        ok: false,
        error: 'attempt_ended',
      });
    }
    await x.run.onWelcome(welcome([{ attemptId: 'T-4-a1', reason: 'still ended' }]));
    expect(f.events('attempt.exited')).toHaveLength(1);
    // What outlives an ended attempt still runs: its transcript and its cleanup.
    const upload = { kind: 'upload_transcript', attemptId: 'T-4-a1' } as const;
    expect(await x.run.onCommand(message(upload, 11))).toMatchObject({ ok: true, data: { uploaded: expect.any(Boolean) } });
    expect(await x.run.onCommand(message({ kind: 'cleanup_attempt', attemptId: 'T-4-a1' }, 12))).toEqual({
      ok: true,
      data: { ok: true },
    });
    expect(f.store.get('T-4-a1')).toMatchObject({ state: 'ended', clone: null });
  }, 60_000);

  test('pause lets in-flight work finish, holds new commands unjournaled and resumes them in order', async () => {
    const f = await createRunnerFixture();
    const x = executor(f);
    const gate = Promise.withResolvers<void>();
    const seen: number[] = [];
    const controller = x.controller('T-4-a1');
    spyOn(controller, 'deliver').mockImplementation(async (command) => {
      seen.push(command.more);
      if (command.more === 1) await gate.promise;
      return { ok: true };
    });
    const send = (seq: number) =>
      x.run.onCommand(message({ kind: 'deliver', attemptId: 'T-4-a1', fence: FENCE, messages: [], more: seq }, seq));
    const first = send(1);
    x.run.pause();
    const second = send(2);
    const third = send(3);
    gate.resolve();
    await first;
    expect(seen).toEqual([1]);
    // Held commands are not journaled: a runner that exits while paused leaves them to the hub's resend.
    expect(x.journal.get('1-R-1-2')).toBeNull();
    x.run.resume();
    await Promise.all([second, third]);
    expect(seen).toEqual([1, 2, 3]);
    x.run.pause();
    const held = send(4);
    await x.run.onWelcome(welcome([{ attemptId: 'T-4-a1', reason: 'ended while paused' }]));
    x.run.resume();
    expect(await held).toEqual({ ok: false, error: 'attempt_ended' });
    expect(seen).toEqual([1, 2, 3]);
  });

  test('refreshes the vault, reports preflight, deletes with exact leases, and persists a settings echo with pending drain', async () => {
    const f = await createRunnerFixture();
    const x = executor(f);
    const sha = (await gitIn(f.origin.path, ['rev-parse', 'refs/heads/main'])).trim();
    const ref = 'refs/agflow/T-4/a1-late-1';
    await gitIn(f.origin.path, ['update-ref', ref, sha]);
    expect((await x.run.onCommand(message({ kind: 'refresh_vault', taskId: 'T-4', refs: [ref] })))?.ok).toBe(true);
    expect((await gitIn(f.vault.path, ['rev-parse', ref])).trim()).toBe(sha);
    // The hub replaces the runner's vendor list with runner.vendors: a preflight of one vendor lists them all.
    x.preflights.set('codex', { result: await f.adapters.get('codex')!.preflight(), at: 1_000 });
    expect((await x.run.onCommand(message({ kind: 'preflight', vendor: 'claude' }, 2)))?.ok).toBe(true);
    const reported = f.events('runner.vendors')[0]?.data.vendors ?? [];
    expect(reported.map((vendor) => vendor.vendor).sort()).toEqual(['claude', 'codex']);
    expect(reported.find((vendor) => vendor.vendor === 'claude')).toMatchObject({
      ready: true,
      degraded: false,
      models: f.config.models.claude,
    });
    expect(reported.find((vendor) => vendor.vendor === 'claude')?.preflightAt).toBeGreaterThan(1_000);
    expect(reported.find((vendor) => vendor.vendor === 'codex')?.preflightAt).toBe(1_000);
    // A ref that moved is left alone, and the result says so for the hub to decide.
    expect(
      await x.run.onCommand(message({ kind: 'delete_refs', refs: [{ ref, expectedSha: 'a'.repeat(40) }] }, 3)),
    ).toEqual({ ok: true, data: [{ ref, status: 'moved', remoteSha: sha, detail: null }] });
    expect((await gitIn(f.origin.path, ['rev-parse', ref])).trim()).toBe(sha);
    expect((await x.run.onCommand(message({ kind: 'delete_refs', refs: [{ ref, expectedSha: sha }] }, 4)))?.ok).toBe(
      true,
    );
    expect(await gitIn(f.origin.path, ['for-each-ref', '--format=%(refname)', ref])).toBe('');
    expect((await x.run.onCommand(message({ kind: 'delete_refs', refs: [{ ref, expectedSha: sha }] }, 5)))?.ok).toBe(
      true,
    );
    f.config.draining = true;
    expect(
      (
        await x.run.onCommand(
          message({ kind: 'update_settings', settings: { capacity: 7, draining: false }, version: 1 }, 6),
        )
      )?.ok,
    ).toBe(true);
    expect(f.config).toMatchObject({
      capacity: 7,
      draining: true,
      confirmedSettings: { capacity: 7, draining: false, version: 1 },
    });
    expect(JSON.parse(readFileSync(f.paths.config, 'utf8'))).toMatchObject({
      capacity: 7,
      draining: true,
      confirmedSettings: { version: 1 },
    });
    expect(f.events('runner.settings')[0]?.data).toEqual({ settings: { draining: true }, baseVersion: 1 });
  }, 60_000);

  test('an update_settings echo sends no local edit again that the outbox carries still', async () => {
    const f = await createRunnerFixture();
    const x = executor(f);
    const settings = () => f.events('runner.settings').map((event) => event.data);
    const echo = (edit: { capacity?: number; draining?: boolean; keepAwake?: 'off' | 'always' }, version: number) =>
      x.run.onCommand(message({ kind: 'update_settings', settings: edit, version }, version));
    const base = f.config.confirmedSettings.version;
    const keepAwake = f.config.keepAwake === 'always' ? 'off' : 'always';
    // A drain sent and not acknowledged yet, and a keepAwake edit that never went out.
    f.config.draining = true;
    f.config.keepAwake = keepAwake;
    f.outbox.append({ type: 'runner.settings', data: { settings: { draining: true }, baseVersion: base } });
    // The owner's edit: the drain goes out with the replay, so only keepAwake is sent.
    expect((await echo({ capacity: 7 }, base + 1))?.ok).toBe(true);
    expect(f.config).toMatchObject({ capacity: 7, draining: true, keepAwake });
    expect(settings()).toEqual([
      { settings: { draining: true }, baseVersion: base },
      { settings: { keepAwake }, baseVersion: base + 1 },
    ]);
    // Both applied and acknowledged. The drain's echo comes first; keepAwake's, based on base + 1, is still to come.
    f.outbox.ack(f.outbox.epoch, f.outbox.lastSeq());
    expect((await echo({ draining: true }, base + 2))?.ok).toBe(true);
    expect((await echo({ keepAwake }, base + 3))?.ok).toBe(true);
    expect(settings()).toHaveLength(2);
    expect(f.config).toMatchObject({
      capacity: 7,
      draining: true,
      keepAwake,
      confirmedSettings: { capacity: 7, draining: true, keepAwake, version: base + 3 },
    });
  });

  test("an acknowledged edit stays in flight until its own echo, however many of the owner's echoes come first", async () => {
    const f = await createRunnerFixture();
    const x = executor(f);
    const settings = () => f.events('runner.settings').map((event) => event.data);
    const echo = (edit: { capacity?: number; draining?: boolean }, version: number) =>
      x.run.onCommand(message({ kind: 'update_settings', settings: edit, version }, version));
    const base = f.config.confirmedSettings.version;
    // A drain, sent and acknowledged; the hub applied two of the owner's edits first, whose echoes come before its own.
    f.config.draining = true;
    f.outbox.append({ type: 'runner.settings', data: { settings: { draining: true }, baseVersion: base } });
    f.outbox.ack(f.outbox.epoch, f.outbox.lastSeq());
    expect((await echo({ capacity: 7 }, base + 1))?.ok).toBe(true);
    expect((await echo({ capacity: 6 }, base + 2))?.ok).toBe(true);
    expect(settings()).toEqual([{ settings: { draining: true }, baseVersion: base }]);
    expect(f.config).toMatchObject({
      capacity: 6,
      draining: true,
      confirmedSettings: { capacity: 6, draining: false },
    });
    // Its own echo: the drain is in the snapshot and in flight no longer.
    expect((await echo({ draining: true }, base + 3))?.ok).toBe(true);
    expect(f.outbox.settingsInFlight()).toEqual([]);
    // So a later local edit is sent: the owner undrains, then runner.json drains again by hand, with no event.
    expect((await echo({ draining: false }, base + 4))?.ok).toBe(true);
    expect(f.config.draining).toBe(false);
    f.config.draining = true;
    expect((await echo({ capacity: 5 }, base + 5))?.ok).toBe(true);
    expect(settings()).toEqual([
      { settings: { draining: true }, baseVersion: base },
      { settings: { draining: true }, baseVersion: base + 5 },
    ]);
  });

  test("an owner's echo equal to a later edit in flight leaves the earlier edits in flight", async () => {
    const f = await createRunnerFixture();
    const x = executor(f);
    const settings = () => f.events('runner.settings').map((event) => event.data);
    const echo = (edit: { capacity?: number; draining?: boolean }, version: number) =>
      x.run.onCommand(message({ kind: 'update_settings', settings: edit, version }, version));
    const base = f.config.confirmedSettings.version;
    const capacity = f.config.capacity + 1;
    // Two edits, sent and acknowledged; the owner drained too, and the hub applied that first.
    f.config.capacity = capacity;
    f.config.draining = true;
    f.outbox.append({ type: 'runner.settings', data: { settings: { capacity }, baseVersion: base } });
    f.outbox.append({ type: 'runner.settings', data: { settings: { draining: true }, baseVersion: base } });
    f.outbox.ack(f.outbox.epoch, f.outbox.lastSeq());
    // The owner's drain answers the runner's in effect; the capacity edit is still to be applied, so it is not sent.
    expect((await echo({ draining: true }, base + 1))?.ok).toBe(true);
    expect(settings()).toHaveLength(2);
    expect(f.outbox.settingsInFlight().map((event) => event.data.settings)).toEqual([{ capacity }]);
    expect((await echo({ capacity }, base + 2))?.ok).toBe(true);
    expect((await echo({ draining: true }, base + 3))?.ok).toBe(true);
    expect(settings()).toHaveLength(2);
    expect(f.outbox.settingsInFlight()).toEqual([]);
    expect(f.config).toMatchObject({ capacity, draining: true, confirmedSettings: { capacity, draining: true } });
  });

  test('an echo of an older edit leaves runner.json on the edits still in flight, so none is sent again', async () => {
    const f = await createRunnerFixture();
    const x = executor(f);
    const settings = () => f.events('runner.settings').map((event) => event.data);
    const echo = (edit: { draining?: boolean }, version: number) =>
      x.run.onCommand(message({ kind: 'update_settings', settings: edit, version }, version));
    const base = f.config.confirmedSettings.version;
    // A drain, then an undrain, both sent and acknowledged: runner.json is back where the snapshot is.
    f.outbox.append({ type: 'runner.settings', data: { settings: { draining: true }, baseVersion: base } });
    f.outbox.append({ type: 'runner.settings', data: { settings: { draining: false }, baseVersion: base } });
    f.outbox.ack(f.outbox.epoch, f.outbox.lastSeq());
    // The hub applied both. The drain's echo comes first: the undrain is still in flight, and runner.json holds it.
    expect((await echo({ draining: true }, base + 1))?.ok).toBe(true);
    expect(f.config).toMatchObject({ draining: false, confirmedSettings: { draining: true, version: base + 1 } });
    expect(x.run.settings.view()).toMatchObject({ draining: false });
    expect(settings()).toHaveLength(2);
    expect((await echo({ draining: false }, base + 2))?.ok).toBe(true);
    expect(f.config).toMatchObject({ draining: false, confirmedSettings: { draining: false, version: base + 2 } });
    expect(f.outbox.settingsInFlight()).toEqual([]);
    expect(settings()).toHaveLength(2);
  });

  test('an echo cut short before runner.json took it leaves its edit in flight; run again, it marks no second edit', async () => {
    const f = await createRunnerFixture();
    const x = executor(f);
    const outbox = new Outbox(f.db, { confirmedVersion: () => f.config.confirmedSettings.version });
    const journal = new Journal(f.db);
    const base = f.config.confirmedSettings.version;
    const append = (draining: boolean) =>
      outbox.append({ type: 'runner.settings', data: { settings: { draining }, baseVersion: base } }).seq;
    // A drain, an undrain and a drain again, all acknowledged; runner.json holds the last.
    const seqs = [append(true), append(false), append(true)];
    outbox.ack(outbox.epoch, outbox.lastSeq());
    f.config.draining = true;
    // What a kill between the mark and runner.json's write leaves: the row running, the mark, the old snapshot.
    const command: RunnerCommand = { kind: 'update_settings', settings: { draining: true }, version: base + 1 };
    journal.begin('1-R-1-9', 9, command);
    expect(outbox.markSettingsEcho({ draining: true }, base + 1).answered?.seq).toBe(seqs[0]);
    expect(outbox.settingsInFlight().map((event) => event.seq)).toEqual(seqs);
    // The next start runs the row again when the hub sends it again.
    const run = new CommandExecutor({ ...x.options, outbox, journal });
    await run.recover();
    expect(journal.get('1-R-1-9')?.state).toBe('running');
    expect(await run.onCommand({ t: 'command', id: '1-R-1-9', seq: 9, command })).toEqual({ ok: true });
    expect(journal.get('1-R-1-9')).toMatchObject({ state: 'done', result: { ok: true } });
    expect(f.config).toMatchObject({ draining: true, confirmedSettings: { draining: true, version: base + 1 } });
    expect(f.db.meta('settingsEchoed')).toEqual([{ seq: seqs[0], version: base + 1 }]);
    expect(outbox.settingsInFlight().map((event) => event.seq)).toEqual(seqs.slice(1));
    expect(f.events('runner.settings')).toHaveLength(3);
  });

  test("a probe's echo settles the edits the hub refused: runner.json takes the hub's values, with a warning, and nothing is sent", async () => {
    const f = await createRunnerFixture();
    const x = executor(f);
    const settings = () => f.events('runner.settings').map((event) => event.data);
    const echo = (edit: { capacity?: number; draining?: boolean }, version: number) =>
      x.run.onCommand(message({ kind: 'update_settings', settings: edit, version }, version));
    const base = f.config.confirmedSettings.version;
    const capacity = f.config.confirmedSettings.capacity;
    // A capacity edit the hub refused, a drain it applied, and a probe after them; all acknowledged.
    f.config.capacity = capacity + 1;
    f.config.draining = true;
    f.outbox.append({ type: 'runner.settings', data: { settings: { capacity: capacity + 1 }, baseVersion: base } });
    f.outbox.append({ type: 'runner.settings', data: { settings: { draining: true }, baseVersion: base } });
    f.outbox.append({ type: 'runner.settings', data: { settings: {}, baseVersion: base } });
    f.outbox.ack(f.outbox.epoch, f.outbox.lastSeq());
    // The owner's capacity edit came first: runner.json keeps the refused edit's value while it is in flight.
    expect((await echo({ capacity: capacity + 2 }, base + 1))?.ok).toBe(true);
    expect(f.config.capacity).toBe(capacity + 1);
    expect((await echo({ draining: true }, base + 2))?.ok).toBe(true);
    // The probe's echo: the capacity edit got none before it, so the hub refused it.
    expect((await echo({}, base + 3))?.ok).toBe(true);
    expect(f.config).toMatchObject({
      capacity: capacity + 2,
      draining: true,
      confirmedSettings: { capacity: capacity + 2, draining: true, version: base + 3 },
    });
    expect(f.outbox.settingsInFlight()).toEqual([]);
    expect(settings()).toHaveLength(3);
    const warning = f.logger.entries.find((entry) => /refused a settings edit/.test(entry.message));
    expect(warning).toMatchObject({ level: 'warn', fields: { seq: 1, settings: { capacity: capacity + 1 } } });
  });

  test('an echo answers no edit made after it came, and a rerun after a restart keeps where it came', async () => {
    const f = await createRunnerFixture();
    const x = executor(f);
    const base = f.config.confirmedSettings.version;
    const update = (settings: { draining?: boolean }, version: number): RunnerCommand => ({
      kind: 'update_settings',
      settings,
      version,
    });
    // The owner drained in the browser, and its echo waits behind a pause; meanwhile the person drains on the runner.
    x.run.pause();
    const owners = x.run.onCommand(message(update({ draining: true }, base + 1), 1));
    f.config.draining = true;
    const first = f.outbox.append({
      type: 'runner.settings',
      data: { settings: { draining: true }, baseVersion: base },
    });
    x.run.resume();
    expect(await owners).toEqual({ ok: true });
    // The echo is the owner's: the person's drain stays in flight, for the hub to apply after the owner's.
    expect(f.outbox.settingsInFlight().map((event) => event.seq)).toEqual([first.seq]);
    expect(f.config).toMatchObject({ draining: true, confirmedSettings: { draining: true, version: base + 1 } });
    // The owner undrained, and a kill cut that echo's run short; after it came, the person undrained too.
    const undrain = update({ draining: false }, base + 2);
    x.journal.begin('1-R-1-2', 2, undrain, f.outbox.lastSeq());
    f.config.draining = false;
    const second = f.outbox.append({
      type: 'runner.settings',
      data: { settings: { draining: false }, baseVersion: base + 1 },
    });
    // The hub sends it again after the next start's welcome. Run again, it is still the owner's echo: the person's
    // undrain stays in flight, and runner.json keeps it.
    const restarted = new CommandExecutor(x.options);
    await restarted.recover();
    expect(await restarted.onCommand(message(undrain, 2))).toEqual({ ok: true });
    expect(f.outbox.settingsInFlight().map((event) => event.seq)).toEqual([first.seq, second.seq]);
    expect(f.config).toMatchObject({ draining: false, confirmedSettings: { draining: false, version: base + 2 } });
  });

  test('a failed write of runner.json leaves the echo in the settings the runner holds', async () => {
    const f = await createRunnerFixture();
    const x = executor(f);
    const settings = () => f.events('runner.settings').map((event) => event.data.settings);
    const echo = (edit: { capacity?: number; draining?: boolean }, version: number) =>
      x.run.onCommand(message({ kind: 'update_settings', settings: edit, version }, version));
    const base = f.config.confirmedSettings.version;
    // A drain, sent and acknowledged; its echo comes while runner.json cannot be written.
    f.config.draining = true;
    f.outbox.append({ type: 'runner.settings', data: { settings: { draining: true }, baseVersion: base } });
    f.outbox.ack(f.outbox.epoch, f.outbox.lastSeq());
    spyOn(x.options, 'saveConfig').mockImplementationOnce((config) => {
      f.config = config;
      throw new Error('ENOSPC: no space left on device');
    });
    expect(await echo({ draining: true }, base + 1)).toEqual({ ok: true });
    expect(f.config).toMatchObject({ draining: true, confirmedSettings: { draining: true, version: base + 1 } });
    expect(f.logger.entries).toContainEqual(
      expect.objectContaining({ level: 'error', fields: { error: 'ENOSPC: no space left on device' } }),
    );
    expect(f.db.meta('settingsSavedVersion')).toBeNull();
    // The owner's capacity edit: its echo writes runner.json with both, and nothing is sent again.
    expect(await echo({ capacity: 3 }, base + 2)).toEqual({ ok: true });
    expect(JSON.parse(readFileSync(f.paths.config, 'utf8'))).toMatchObject({
      capacity: 3,
      draining: true,
      confirmedSettings: { capacity: 3, draining: true, version: base + 2 },
    });
    expect(f.db.meta('settingsSavedVersion')).toBe(base + 2);
    expect(f.outbox.settingsInFlight()).toEqual([]);
    expect(settings()).toEqual([{ draining: true }]);
  });

  test('a failed run of an echo runs again shortly on its own, and the echoes after it wait for it, not for a reconnect', async () => {
    const f = await createRunnerFixture();
    const timers = manualTimers();
    const run = new CommandExecutor({ ...executor(f).options, timers });
    const journal = new Journal(f.db);
    const echo = (edit: { capacity?: number; draining?: boolean; keepAwake?: 'off' }, version: number) =>
      run.onCommand(message({ kind: 'update_settings', settings: edit, version }, version));
    const base = f.config.confirmedSettings.version;
    const fail = () => {
      throw new Error('database is locked');
    };
    // The owner's capacity edit fails once; the drain and keepAwake edits after it would each skip a version.
    const mark = spyOn(f.outbox, 'markSettingsEcho').mockImplementationOnce(fail);
    const results = [
      echo({ capacity: 3 }, base + 1),
      echo({ draining: true }, base + 2),
      echo({ keepAwake: 'off' }, base + 3),
    ];
    await waitFor(() => timers.waiting().length === 1);
    expect(timers.waiting()[0]?.ms).toBe(1_000);
    expect(f.config.confirmedSettings.version).toBe(base);
    expect(journal.get(`1-R-1-${base + 1}`)?.state).toBe('running');
    // The link stays up: the retry runs them all, in version order, and each gets its result.
    timers.fire();
    expect(await Promise.all(results)).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
    expect(f.config).toMatchObject({
      capacity: 3,
      draining: true,
      keepAwake: 'off',
      confirmedSettings: { capacity: 3, draining: true, keepAwake: 'off', version: base + 3 },
    });
    expect(journal.running()).toEqual([]);
    // A failure that lasts: each retry waits twice as long as the one before.
    mark.mockImplementation(fail);
    const stuck = echo({ capacity: 4 }, base + 4);
    await waitFor(() => timers.waiting().length === 1);
    timers.fire();
    await waitFor(() => timers.waiting().length === 1);
    expect(timers.waiting()[0]?.ms).toBe(2_000);
    // A hello leaves it to the hub's resend after the welcome, and ends the retries.
    run.helloSent();
    expect(await stuck).toBeNull();
    expect(timers.waiting()).toEqual([]);
    expect(journal.get(`1-R-1-${base + 4}`)?.state).toBe('running');
    mark.mockRestore();
    expect(await echo({ capacity: 4 }, base + 4)).toEqual({ ok: true });
    expect(f.config).toMatchObject({ capacity: 4, confirmedSettings: { version: base + 4 } });
  });

  test('an update_settings whose journal row cannot be written is taken again after the backoff, so the echoes after it wait for it, not for a reconnect', async () => {
    const f = await createRunnerFixture();
    const timers = manualTimers();
    const x = executor(f);
    const run = new CommandExecutor({ ...x.options, timers });
    const echo = (edit: { capacity?: number; draining?: boolean }, version: number) =>
      run.onCommand(message({ kind: 'update_settings', settings: edit, version }, version));
    const base = f.config.confirmedSettings.version;
    const full = () => {
      throw new Error('SQLITE_FULL: database or disk is full');
    };
    // The owner's capacity edit cannot be journaled once; the drain after it would skip a version.
    const begin = spyOn(x.journal, 'begin').mockImplementationOnce(full);
    const results = [echo({ capacity: 3 }, base + 1), echo({ draining: true }, base + 2)];
    await waitFor(() => timers.waiting().length === 1);
    expect(timers.waiting()[0]?.ms).toBe(1_000);
    expect(x.journal.get(`1-R-1-${base + 1}`)).toBeNull();
    expect(f.config.confirmedSettings.version).toBe(base);
    // The link stays up: taken again, it runs, the drain after it runs, and each gets its result.
    timers.fire();
    expect(await Promise.all(results)).toEqual([{ ok: true }, { ok: true }]);
    expect(f.config).toMatchObject({ capacity: 3, draining: true, confirmedSettings: { version: base + 2 } });
    expect(x.journal.running()).toEqual([]);
    // Any other command answers the failure, as a command that fails does.
    begin.mockImplementationOnce(full);
    await expect(run.onCommand(message({ kind: 'preflight', vendor: 'claude' }, 50))).rejects.toThrow(/SQLITE_FULL/);
    // A hello leaves one still to be taken to the hub's resend after the welcome, and ends its wait.
    begin.mockImplementationOnce(full);
    const stuck = echo({ capacity: 4 }, base + 3);
    await waitFor(() => timers.waiting().length === 1);
    run.helloSent();
    expect(await stuck).toBeNull();
    expect(timers.waiting()).toEqual([]);
    expect(await echo({ capacity: 4 }, base + 3)).toEqual({ ok: true });
  });

  test('a command whose journal row cannot be written while paused leaves resume() and the commands after it alone', async () => {
    const f = await createRunnerFixture();
    const timers = manualTimers();
    const x = executor(f);
    const run = new CommandExecutor({ ...x.options, timers });
    const echo = (edit: { capacity?: number; draining?: boolean }, version: number) =>
      run.onCommand(message({ kind: 'update_settings', settings: edit, version }, version));
    const base = f.config.confirmedSettings.version;
    spyOn(x.journal, 'begin').mockImplementationOnce(() => {
      throw new Error('SQLITE_FULL: database or disk is full');
    });
    run.pause();
    const results = [
      echo({ capacity: 3 }, base + 1),
      echo({ draining: true }, base + 2),
      run.onCommand(message({ kind: 'preflight', vendor: 'claude' }, 50)),
    ];
    run.resume();
    await waitFor(() => timers.waiting().length === 1);
    timers.fire();
    const [first, second, preflight] = await Promise.all(results);
    expect([first, second]).toEqual([{ ok: true }, { ok: true }]);
    expect(preflight?.ok).toBe(true);
    expect(f.config).toMatchObject({ capacity: 3, draining: true, confirmedSettings: { version: base + 2 } });
  });

  test("an echo past the snapshot's next version waits for the ones before it, or for a hello; the hub's whole settings apply, and the echoes they cover only mark", async () => {
    const f = await createRunnerFixture();
    const x = executor(f);
    const settings = () => f.events('runner.settings').map((event) => event.data.settings);
    const echo = (edit: Record<string, unknown>, version: number, id = version) =>
      x.run.onCommand(message({ kind: 'update_settings', settings: edit, version }, id));
    // Runs once every runner command taken before it has run.
    const barrier = () => x.run.onCommand(message({ kind: 'preflight', vendor: 'claude' }, 1_000));
    const base = f.config.confirmedSettings.version;
    const { version: _version, ...snapshot } = f.config.confirmedSettings;
    // A keepAwake edit, sent and acknowledged. The hub applied it after an owner's edit whose echo never came.
    f.config.keepAwake = 'always';
    const edit = f.outbox.append({
      type: 'runner.settings',
      data: { settings: { keepAwake: 'always' }, baseVersion: base },
    });
    f.outbox.ack(f.outbox.epoch, edit.seq);
    // Then an owner's PATCH that names every field, but one vendor's ceiling and the other's paid usage only: it is
    // not the hub's whole settings, so it skips no version either.
    const low = { fiveHour: 0.5, weekly: 0.6 };
    const patch = {
      capacity: 4,
      keepAwake: 'always',
      draining: true,
      ceilings: { codex: low },
      allowPaidUsage: { claude: true },
    };
    const waiting = [echo({ capacity: 3 }, base + 2), echo({ keepAwake: 'always' }, base + 3), echo(patch, base + 4)];
    await barrier();
    expect(x.journal.get(`1-R-1-${base + 2}`)?.state).toBe('running');
    expect(f.config).toMatchObject({ capacity: 2, keepAwake: 'always', confirmedSettings: { version: base } });
    expect(f.outbox.settingsInFlight().map((event) => event.seq)).toEqual([edit.seq]);
    // The link drops: the hello leaves them unanswered, for the hub to send again after its welcome.
    x.run.helloSent();
    expect(await Promise.all(waiting)).toEqual([null, null, null]);
    // That hello reported the older version: the hub sends them again, then all of its settings, which apply past the
    // gap; the echoes they cover only mark the edit they answer.
    const resent = [echo({ capacity: 3 }, base + 2), echo({ keepAwake: 'always' }, base + 3), echo(patch, base + 4)];
    const whole = {
      capacity: 4,
      keepAwake: 'always',
      draining: true,
      ceilings: { ...snapshot.ceilings, codex: low },
      allowPaidUsage: { ...snapshot.allowPaidUsage, claude: true },
    };
    expect(await echo(whole, base + 4, 100)).toEqual({ ok: true });
    expect(await Promise.all(resent)).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
    expect(f.outbox.settingsInFlight()).toEqual([]);
    expect(f.config).toMatchObject({ ...whole, confirmedSettings: { ...whole, version: base + 4 } });
    // The next echo applies as usual, and nothing was sent again.
    expect(await echo({ capacity: 5 }, base + 5)).toEqual({ ok: true });
    expect(f.config).toMatchObject({ capacity: 5, confirmedSettings: { capacity: 5, version: base + 5 } });
    expect(settings()).toEqual([{ keepAwake: 'always' }]);
  });

  test('an update_settings taken before the latest hello is left unanswered, unless the hub sends it again after that hello', async () => {
    const f = await createRunnerFixture();
    const x = executor(f);
    const update = (settings: { capacity?: number; draining?: boolean }, version: number): RunnerCommand => ({
      kind: 'update_settings',
      settings,
      version,
    });
    const base = f.config.confirmedSettings.version;
    // Two echoes wait behind a pause. The link drops, and the next hello goes to a hub restored from a backup that has
    // the first and not the second; run before its welcome, they would move the snapshot past what that hello said.
    x.run.pause();
    const kept = x.run.onCommand(message(update({ capacity: 3 }, base + 1), 1));
    const lost = x.run.onCommand(message(update({ draining: true }, base + 2), 2));
    x.run.helloSent();
    // That hello reported the version before both: the restored hub sends the first again, then all of its settings.
    const resent = x.run.onCommand(message(update({ capacity: 3 }, base + 1), 1));
    const { version: _version, ...snapshot } = f.config.confirmedSettings;
    const whole = x.run.onCommand({
      t: 'command',
      id: '2-R-1-1',
      seq: 1,
      command: { kind: 'update_settings', settings: { ...snapshot, capacity: 3 }, version: base + 1 },
    });
    x.run.resume();
    expect(await kept).toEqual({ ok: true });
    expect(await resent).toEqual({ ok: true });
    expect(await lost).toBeNull();
    expect(x.journal.get('1-R-1-2')?.state).toBe('running');
    expect(await whole).toEqual({ ok: true });
    expect(f.config).toMatchObject({
      capacity: 3,
      draining: false,
      confirmedSettings: { capacity: 3, draining: false, version: base + 1 },
    });
  });

  test("a reconnect to the same hub loses no echo: its resend joins one still queued, and runs one the hello left unanswered", async () => {
    const f = await createRunnerFixture();
    const x = executor(f);
    const update = (settings: { capacity?: number; draining?: boolean }, version: number): RunnerCommand => ({
      kind: 'update_settings',
      settings,
      version,
    });
    const base = f.config.confirmedSettings.version;
    // A long preflight holds the runner's queue, with two echoes behind it.
    const gate = Promise.withResolvers<void>();
    const adapter = f.adapters.get('claude')!;
    const preflight = adapter.preflight.bind(adapter);
    spyOn(adapter, 'preflight').mockImplementationOnce(async () => {
      await gate.promise;
      return preflight();
    });
    const held = x.run.onCommand(message({ kind: 'preflight', vendor: 'claude' }, 1));
    const first = x.run.onCommand(message(update({ capacity: 3 }, base + 1), 2));
    const second = x.run.onCommand(message(update({ draining: true }, base + 2), 3));
    // The link drops and says hello again. After the welcome, the hub's resend of the first comes while it waits.
    x.run.helloSent();
    const resent = x.run.onCommand(message(update({ capacity: 3 }, base + 1), 2));
    gate.resolve();
    expect((await held)?.ok).toBe(true);
    expect(await first).toEqual({ ok: true });
    expect(await resent).toEqual({ ok: true });
    // The second ran before its resend came: it answered nothing, and its resend runs it from the journal.
    expect(await second).toBeNull();
    expect(x.journal.get('1-R-1-3')?.state).toBe('running');
    expect(await x.run.onCommand(message(update({ draining: true }, base + 2), 3))).toEqual({ ok: true });
    expect(f.config).toMatchObject({
      capacity: 3,
      draining: true,
      confirmedSettings: { capacity: 3, draining: true, version: base + 2 },
    });
  });

  test('settingsAcknowledged sends a probe for an acknowledged edit no echo answered, once the commands before it ran', async () => {
    const f = await createRunnerFixture();
    const x = executor(f);
    const settings = () => f.events('runner.settings').map((event) => event.data.settings);
    const echo = (edit: { capacity?: number; draining?: boolean }, version: number) =>
      x.run.onCommand(message({ kind: 'update_settings', settings: edit, version }, version));
    const ack = () => f.outbox.ack(f.outbox.epoch, f.outbox.lastSeq());
    const base = f.config.confirmedSettings.version;
    const capacity = f.config.capacity;
    // A drain whose echo came before its ack, as M2a sends them, and waits behind a pause: no probe.
    f.config.draining = true;
    f.outbox.append({ type: 'runner.settings', data: { settings: { draining: true }, baseVersion: base } });
    x.run.pause();
    const echoed = echo({ draining: true }, base + 1);
    ack();
    const checked = x.run.settingsAcknowledged({ welcome: false });
    x.run.resume();
    await Promise.all([echoed, checked]);
    expect(settings()).toEqual([{ draining: true }]);
    // A capacity edit the hub acknowledged and never echoed: a probe follows.
    f.config.capacity = capacity + 1;
    f.outbox.append({ type: 'runner.settings', data: { settings: { capacity: capacity + 1 }, baseVersion: base + 1 } });
    ack();
    await x.run.settingsAcknowledged({ welcome: false });
    expect(settings()).toEqual([{ draining: true }, { capacity: capacity + 1 }, {}]);
    // None more while that probe waits for its acknowledgement, or once acknowledged, for its echo; one at a welcome.
    await x.run.settingsAcknowledged({ welcome: true });
    ack();
    await x.run.settingsAcknowledged({ welcome: false });
    expect(settings()).toHaveLength(3);
    await x.run.settingsAcknowledged({ welcome: true });
    await x.run.settingsAcknowledged({ welcome: true });
    expect(settings()).toEqual([{ draining: true }, { capacity: capacity + 1 }, {}, {}]);
    // The first probe's echo: the capacity edit was refused. Nothing is left to probe for.
    ack();
    expect((await echo({}, base + 2))?.ok).toBe(true);
    expect(f.config.capacity).toBe(capacity);
    await x.run.settingsAcknowledged({ welcome: true });
    expect(settings()).toHaveLength(4);
  });

  test('preparation uses the command id and agent environment, reports outcomes, and works without a live controller after restart', async () => {
    const f = await createRunnerFixture();
    const calls: PrepareInput[] = [];
    const preparer = {
      available: true,
      prepare: async (input: PrepareInput) => {
        calls.push(input);
        return { ran: true, ok: true, error: null, logTail: 'installed' };
      },
    };
    const x = executor(f, { preparer });
    await x.run.onCommand(message({ kind: 'start_attempt', attempt: f.spec() }));
    const request = { kind: 'prepare_dependencies', attemptId: 'T-4-a1', fence: FENCE, requestId: '1-R-1-99' } as const;
    expect(await x.run.onCommand(message(request, 2))).toEqual({
      ok: true,
      data: { requestId: '1-R-1-2', ok: true, error: null, logTail: 'installed' },
    });
    const input = calls.at(-1)!;
    expect(input).toMatchObject({
      requestId: '1-R-1-2',
      attemptId: 'T-4-a1',
      clone: f.store.get('T-4-a1')!.clone,
      vault: f.vault,
    });
    expect(input.env.AGFLOW_AGENT_TOKEN).toBe(f.spec().agentToken);
    expect(input.env.SSH_AUTH_SOCK).toBeUndefined();
    expect(input.env.GIT_CONFIG_GLOBAL).toContain(f.paths.agentTools(FIXTURE_PROJECT, 'T-4-a1'));
    expect(input.baseSha).toBe(x.controller('T-4-a1').workspace!.base);
    await x.run.onCommand(message(STOP, 3));
    const restarted = executor(f, { preparer });
    restarted.journal.begin('1-R-1-4', 4, request);
    await restarted.run.recover();
    expect(calls.at(-1)?.requestId).toBe('1-R-1-4');
    expect(calls.at(-1)?.env.AGFLOW_AGENT_TOKEN).toBeUndefined();
    const unavailable = executor(f);
    expect(await unavailable.run.onCommand(message(request, 5))).toMatchObject({
      ok: false,
      error: 'not available on this runner',
    });
    expect(f.events('attempt.prepared').at(-1)?.data).toEqual({
      requestId: '1-R-1-5',
      ok: false,
      error: 'not available on this runner',
      logTail: null,
    });
    const failed = executor(f, {
      preparer: {
        available: true,
        prepare: async () => {
          throw new Error('preparation failed');
        },
      },
    });
    expect(await failed.run.onCommand(message(request, 6))).toMatchObject({ ok: false, error: 'preparation failed' });
    expect(f.events('attempt.prepared').at(-1)?.data).toEqual({
      requestId: '1-R-1-6',
      ok: false,
      error: 'preparation failed',
      logTail: null,
    });
    const count = calls.length;
    expect(await restarted.run.onCommand(message({ ...request, fence: { epoch: 1, counter: 2 } }, 7))).toEqual({
      ok: false,
      error: 'stale_fence',
    });
    // Workers only (X-40), and only in a clone that is still there; the preparer never runs otherwise.
    const lead = f.spec({ attemptId: 'lead-a1', role: 'lead', taskId: null, branch: null, wipRef: null });
    await x.run.onCommand(message({ kind: 'start_attempt', attempt: lead }, 8));
    expect(await x.run.onCommand(message({ ...request, attemptId: 'lead-a1' }, 9))).toMatchObject({
      ok: false,
      error: 'lead-a1 is not a worker attempt',
    });
    expect(f.events('attempt.prepared').at(-1)?.data).toMatchObject({
      ok: false,
      error: expect.stringMatching(/is not a worker attempt/),
    });
    await x.run.onCommand(message({ ...STOP, attemptId: 'lead-a1' }, 10));
    rmSync(f.store.get('T-4-a1')!.clone!, { recursive: true, force: true });
    expect(await x.run.onCommand(message(request, 11))).toMatchObject({
      ok: false,
      error: expect.stringMatching(/clone of T-4-a1 is gone/),
    });
    expect(f.events('attempt.prepared').at(-1)?.data).toMatchObject({
      ok: false,
      error: expect.stringMatching(/clone of .* is gone/),
    });
    expect(calls).toHaveLength(count);
  }, 30_000);

  test('restart re-runs exactly the ten idempotent handlers, update_settings once the hub sends it again, and interrupts the other seven, without tokens', async () => {
    const f = await createRunnerFixture();
    const x = executor(f);
    const handlers = probes(x.controller('T-4-a1'));
    const refresh = spyOn(f.vault, 'refresh');
    const preflight = spyOn(f.adapters.get('claude')!, 'preflight');
    const remote = spyOn(x.options, 'remote');
    const save = spyOn(x.options, 'saveConfig');
    const all = commands(f);
    for (const [i, command] of all.entries()) x.journal.begin(`1-R-1-${i + 1}`, i + 1, command);
    expect(JSON.stringify(x.journal.running())).not.toContain(f.spec().agentToken);
    const restarted = new CommandExecutor(x.options);
    await restarted.recover();
    const restartable: RunnerCommand['kind'][] = [
      'push_submission',
      'prepare_takeover',
      'hand_back',
      'cleanup_attempt',
      'upload_transcript',
      'refresh_vault',
      'delete_refs',
      'update_settings',
      'preflight',
      'prepare_dependencies',
    ];
    expect([...RESTARTABLE_COMMANDS].sort()).toEqual(restartable.sort());
    // A hub restored without it would never send it again: it waits for the hub, and runs then.
    const settings = all.findIndex((command) => command.kind === 'update_settings');
    expect(x.journal.get(`1-R-1-${settings + 1}`)?.state).toBe('running');
    expect(save).toHaveBeenCalledTimes(0);
    expect(await restarted.onCommand(message(all[settings]!, settings + 1))).toEqual({ ok: true });
    for (const [i, command] of all.entries()) {
      const entry = x.journal.get(`1-R-1-${i + 1}`)!;
      expect(entry.state).toBe('done');
      if (restartable.includes(command.kind)) expect(entry.result?.ok).toBe(true);
      else expect(entry.result).toEqual({ ok: false, error: 'interrupted' });
      if (command.kind in handlers)
        expect(handlers[command.kind as keyof typeof handlers]).toHaveBeenCalledTimes(
          restartable.includes(command.kind) ? 1 : 0,
        );
      expect(await restarted.onCommand(message(command, i + 1))).toEqual(entry.result!);
    }
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(preflight).toHaveBeenCalledTimes(1);
    expect(remote).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(x.journal.running()).toEqual([]);
  });
});
