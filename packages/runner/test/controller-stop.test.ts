import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FakeAdapter, gitIn, type TranscriptLine } from '@agflow/testkit';
import type { VendorAdapter } from '../src/adapters/types';
import { handoffPrompt } from '../src/attempt/stop';
import { cleanupRunnerFixtures, createRunnerFixture, FIXTURE_PROJECT, type RunnerFixture, waitFor } from './fixture';

afterEach(cleanupRunnerFixtures);

// Every test here runs git or agent processes, which take several times as long on a machine loaded by other suites.
setDefaultTimeout(30_000);

const FENCE = { epoch: 1, counter: 1 };
const LONG_SLEEP = { do: 'sleep', ms: 30_000 } as const;
const WRITE_HANDOFF = { do: 'terminal', tool: 'handoff' } as const;
const STOP = { fence: FENCE, reason: 'a person stopped it', handoff: true, interruptFirst: false, keepClone: false };

const turnsStarted = (f: RunnerFixture, attemptId = 'T-4-a1') =>
  f.events('attempt.activity').filter((event) => event.attemptId === attemptId && event.data.kind === 'turn').length;

/** The transcript of the attempt's session, as the fake agent kept it. */
function transcript(f: RunnerFixture, attemptId = 'T-4-a1'): TranscriptLine[] {
  const spawned = f.events('attempt.spawned').filter((event) => event.attemptId === attemptId);
  const sessionRef = spawned.at(-1)?.data.sessionRef as string;
  const clone = f.paths.clone(FIXTURE_PROJECT, attemptId);
  const file = join(clone, '.agflow', 'run', 'fake-transcripts', `${sessionRef}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as TranscriptLine);
}

const userTexts = (f: RunnerFixture, attemptId?: string) =>
  transcript(f, attemptId)
    .filter((line) => line.role === 'user')
    .map((line) => line.text);

const exitsOf = (f: RunnerFixture, attemptId = 'T-4-a1') =>
  f.events('attempt.exited').filter((event) => event.attemptId === attemptId);

/** Starts T-4-a1 and waits until its first turn has ended. */
async function started(f: RunnerFixture) {
  const controller = f.controller();
  expect(await controller.start(f.spec())).toEqual({ started: true });
  await waitFor(() => f.events('attempt.activity').some((event) => event.data.summary.startsWith('turn completed')));
  return controller;
}

describe('AttemptController: stops', () => {
  test('a stop with handoff asks for a handoff turn and reports handoffWritten; one without asks none', async () => {
    const f = await createRunnerFixture({
      script: { turns: [[{ do: 'text', text: 'working' }], [WRITE_HANDOFF, { do: 'text', text: 'noted' }]] },
    });
    const controller = await started(f);
    const result = await controller.stop(STOP);
    expect(result).toMatchObject({ ok: true, stoppedBy: 'close' });
    const [exited] = exitsOf(f);
    expect(exited?.data).toMatchObject({ stoppedBy: 'close', handoffWritten: true, cause: null });
    expect(result.ok && result.exitedSeq).toBe(exited?.seq as number);
    expect(userTexts(f)).toEqual(['Start working on T-4.', handoffPrompt('a person stopped it')]);
    expect(controller.session).toBeNull();
    expect(f.store.get('T-4-a1')?.state).toBe('stopped');

    const other = f.controller('T-5-a1');
    await other.start(f.spec({ attemptId: 'T-5-a1', taskId: 'T-5', branch: 'agflow/T-5-x', wipRef: 'refs/agflow/T-5/a1' }));
    await waitFor(() => turnsStarted(f, 'T-5-a1') === 1);
    expect(await other.stop({ ...STOP, handoff: false })).toMatchObject({ ok: true });
    expect(exitsOf(f, 'T-5-a1')[0]?.data).toMatchObject({ handoffWritten: false, cause: null });
    expect(userTexts(f, 'T-5-a1')).toEqual(['Start working on T-4.']);
  });

  test('a tool in flight, or interruptFirst, interrupts the turn and waits for its end before the handoff turn', async () => {
    for (const [interruptFirst, step] of [
      [false, { do: 'tool', command: 'sleep 30' }],
      [true, LONG_SLEEP],
    ] as const) {
      const f = await createRunnerFixture({ script: { turns: [[step], [WRITE_HANDOFF]] } });
      const controller = f.controller();
      await controller.start(f.spec());
      await waitFor(() => controller.phase === 'turn' && (interruptFirst || controller.facts()?.tool !== null));
      const began = performance.now();
      expect(await controller.stop({ ...STOP, interruptFirst })).toMatchObject({ ok: true });
      // The 30 s step was cut short.
      expect(performance.now() - began).toBeLessThan(10_000);
      const summaries = f.events('attempt.activity').map((event) => event.data.summary);
      const interrupted = summaries.indexOf('turn interrupted');
      expect(interrupted).toBeGreaterThanOrEqual(0);
      expect(summaries.slice(interrupted + 1)).toContain('turn completed with 1 tool call');
      expect(exitsOf(f)[0]?.data.handoffWritten).toBe(true);
      await cleanupRunnerFixtures();
    }
  }, 30_000);

  test('a handoff turn that never writes the note ends at the handoff timeout, and the stop goes on', async () => {
    const f = await createRunnerFixture({
      config: { timings: { handoff: 400 } },
      script: { turns: [[], [LONG_SLEEP]] },
    });
    const controller = await started(f);
    const began = performance.now();
    const result = await controller.stop(STOP);
    expect(result).toMatchObject({ ok: true });
    // The handoff wait, then the interrupt ends the handoff turn and the close the agent.
    const elapsed = performance.now() - began;
    expect(elapsed).toBeGreaterThanOrEqual(400);
    expect(elapsed).toBeLessThan(400 + 3_000);
    expect(userTexts(f)).toContain(handoffPrompt('a person stopped it'));
    expect(exitsOf(f)[0]?.data).toMatchObject({ handoffWritten: false });
  });

  test('the handoff wait is the hub\'s, as welcome gives it', async () => {
    // runner.json's own handoff is far longer: only the hub's 300 ms meets the bound.
    const f = await createRunnerFixture({ config: { timings: { handoff: 20_000 } }, script: { turns: [[], [LONG_SLEEP]] } });
    const controller = f.controller('T-4-a1', { handoffMs: () => 300 });
    await controller.start(f.spec());
    await waitFor(() => turnsStarted(f) === 1);
    const began = performance.now();
    await controller.stop(STOP);
    const elapsed = performance.now() - began;
    expect(elapsed).toBeGreaterThanOrEqual(300);
    expect(elapsed).toBeLessThan(3_000);
    expect(userTexts(f)).toContain(handoffPrompt('a person stopped it'));
  });

  test('a stop that arrives mid-turn with no tool in flight asks for the note once that turn has ended', async () => {
    const f = await createRunnerFixture({
      config: { timings: { handoff: 5_000 } },
      script: { turns: [[{ do: 'sleep', ms: 800 }], [{ do: 'sleep', ms: 200 }, WRITE_HANDOFF]] },
    });
    const controller = f.controller();
    await controller.start(f.spec());
    await waitFor(() => controller.phase === 'turn');
    expect(await controller.stop(STOP)).toMatchObject({ ok: true, stoppedBy: 'close' });
    expect(exitsOf(f)[0]?.data).toMatchObject({ handoffWritten: true });
    expect(userTexts(f)).toEqual(['Start working on T-4.', handoffPrompt('a person stopped it')]);
    const summaries = f.events('attempt.activity').map((event) => event.data.summary);
    expect(summaries).not.toContain('turn interrupted');
  });

  test('a note written before the stop arrived does not spare the handoff turn', async () => {
    const f = await createRunnerFixture({ script: { turns: [[WRITE_HANDOFF], [WRITE_HANDOFF]] } });
    const controller = await started(f);
    expect(await controller.stop(STOP)).toMatchObject({ ok: true });
    expect(userTexts(f)).toEqual(['Start working on T-4.', handoffPrompt('a person stopped it')]);
    expect(transcript(f).filter((line) => line.role === 'user')).toHaveLength(2);
  });

  test('an agent whose interrupt and send never answer still reaches the ladder within the timings', async () => {
    const fake = new FakeAdapter({ vendor: 'claude', skipAuthChecks: true, script: { turns: [[LONG_SLEEP]] } });
    const never = () => new Promise<void>(() => {});
    const adapter: VendorAdapter = {
      vendor: 'claude',
      preflight: () => fake.preflight(),
      readTranscriptTail: (input) => fake.readTranscriptTail(input),
      deleteTranscript: (input) => fake.deleteTranscript(input),
      start: async (launch) => {
        const session = await fake.start(launch);
        return {
          sessionRef: session.sessionRef,
          pid: session.pid,
          events: session.events,
          exited: session.exited,
          answerApproval: (...args) => session.answerApproval(...args),
          close: () => session.close(),
          interrupt: never,
          send: never,
        };
      },
    };
    const f = await createRunnerFixture({ adapters: [adapter], config: { timings: { handoff: 500 } } });
    const controller = f.controller();
    await controller.start(f.spec());
    await waitFor(() => controller.phase === 'turn');
    const began = performance.now();
    const result = await controller.stop({ ...STOP, interruptFirst: true });
    // stopInterrupt and the handoff, then the ladder: its interrupt step waits stopInterrupt, the close ends the agent.
    expect(performance.now() - began).toBeLessThan(500 + 500 + 500 + 3_000);
    expect(result).toMatchObject({ ok: true, stoppedBy: 'close' });
    expect(exitsOf(f)).toHaveLength(1);
  });

  test('keepClone leaves the clone and the session in place after the exit', async () => {
    const f = await createRunnerFixture({ script: { turns: [[{ do: 'write', path: 'work.txt', content: 'w\n' }]] } });
    const controller = await started(f);
    expect(await controller.stop({ ...STOP, handoff: false, keepClone: true })).toMatchObject({ ok: true });
    const clone = f.paths.clone(FIXTURE_PROJECT, 'T-4-a1');
    expect(readFileSync(join(clone, 'work.txt'), 'utf8')).toBe('w\n');
    const sessionRef = f.events('attempt.spawned')[0]?.data.sessionRef as string;
    expect(f.store.get('T-4-a1')).toMatchObject({ state: 'stopped', sessionRef, clone: expect.any(String) });
    expect(transcript(f).length).toBeGreaterThan(0);
  });

  test('a hold lets the turn end, sends nothing, stops the agent, pushes the WIP and keeps clone and session', async () => {
    // The turn outlasts stopInterrupt (500 ms), so a hold bounded by it would cut the turn short.
    const f = await createRunnerFixture({
      config: { timings: { continuationWait: 100 } },
      script: { turns: [[{ do: 'write', path: 'work.txt', content: 'work\n' }, { do: 'sleep', ms: 1_000 }], []] },
    });
    const controller = f.controller();
    await controller.start(f.spec());
    await waitFor(() => controller.phase === 'turn');
    expect(await controller.hold({ fence: FENCE })).toMatchObject({ ok: true });
    const summaries = f.events('attempt.activity').map((event) => event.data.summary);
    // The turn ran to its end; nothing was sent after it.
    expect(summaries).toContain('turn completed with 1 tool call');
    expect(summaries).not.toContain('turn interrupted');
    expect(userTexts(f)).toEqual(['Start working on T-4.']);
    const [exited] = exitsOf(f);
    expect(exited?.data).toMatchObject({ handoffWritten: false, cause: null, pushError: null });
    const finalWip = exited?.data.finalWip as { ref: string; sha: string };
    expect(finalWip.ref).toBe('refs/agflow/T-4/a1');
    const files = await gitIn(f.origin.path, ['ls-tree', '-r', '--name-only', finalWip.sha]);
    expect(files.split('\n')).toContain('work.txt');
    expect(existsSync(join(f.paths.clone(FIXTURE_PROJECT, 'T-4-a1'), 'work.txt'))).toBe(true);
    expect(transcript(f).length).toBeGreaterThan(0);
  });

  test('a hold waits for the turn at most hold, then interrupts it', async () => {
    // hold is longer than stopInterrupt (500 ms), so a wait bounded by the wrong timing ends too early.
    const f = await createRunnerFixture({ config: { timings: { hold: 1_500 } }, script: { turns: [[LONG_SLEEP]] } });
    const controller = f.controller();
    await controller.start(f.spec());
    await waitFor(() => controller.phase === 'turn');
    const began = performance.now();
    expect(await controller.hold({ fence: FENCE })).toMatchObject({ ok: true });
    const elapsed = performance.now() - began;
    expect(elapsed).toBeGreaterThanOrEqual(1_500);
    expect(elapsed).toBeLessThan(4_500);
    expect(f.events('attempt.activity').map((event) => event.data.summary)).toContain('turn interrupted');
  });

  test("the runner's own stops: runner_stop with or without a handoff turn, and suspend", async () => {
    const f = await createRunnerFixture({ script: { turns: [[], [WRITE_HANDOFF]] } });
    const spec = (n: number) =>
      f.spec({ attemptId: `T-${n}-a1`, taskId: `T-${n}`, branch: `agflow/T-${n}-x`, wipRef: `refs/agflow/T-${n}/a1` });
    const controllers = [4, 5, 6].map((n) => f.controller(`T-${n}-a1`));
    for (const [index, controller] of controllers.entries()) await controller.start(spec(index + 4));
    await waitFor(() => [4, 5, 6].every((n) => turnsStarted(f, `T-${n}-a1`) === 1));
    const [handoff, quick, suspended] = controllers as [
      (typeof controllers)[0],
      (typeof controllers)[0],
      (typeof controllers)[0],
    ];
    expect(await handoff.stopForRunner('runner_stop', { handoff: true })).toMatchObject({ ok: true });
    expect(await quick.stopForRunner('runner_stop', { handoff: false })).toMatchObject({ ok: true });
    expect(await suspended.stopForRunner('suspend', { handoff: false })).toMatchObject({ ok: true });
    expect(exitsOf(f, 'T-4-a1')[0]?.data).toMatchObject({ cause: 'runner_stop', handoffWritten: true });
    expect(userTexts(f, 'T-4-a1')[1]).toBe(handoffPrompt('the runner is stopping'));
    expect(exitsOf(f, 'T-5-a1')[0]?.data).toMatchObject({ cause: 'runner_stop', handoffWritten: false });
    expect(userTexts(f, 'T-5-a1')).toHaveLength(1);
    expect(exitsOf(f, 'T-6-a1')[0]?.data).toMatchObject({ cause: 'suspend', handoffWritten: false });
    expect(f.store.get('T-6-a1')?.state).toBe('suspended');
    expect(f.store.get('T-5-a1')?.state).toBe('stopped');
  });

  test('a stop after the process already exited reports nothing twice; a stale fence is refused', async () => {
    const f = await createRunnerFixture();
    const controller = await started(f);
    expect(await controller.stop({ ...STOP, fence: { epoch: 1, counter: 0 } })).toEqual({
      ok: false,
      error: 'stale_fence',
    });
    process.kill(-(controller.session?.pid as number), 'SIGKILL');
    await waitFor(() => exitsOf(f).length === 1);
    await controller.settled();
    expect(await controller.stop(STOP)).toEqual({ ok: false, error: 'not_running' });
    expect(await controller.hold({ fence: FENCE })).toEqual({ ok: false, error: 'not_running' });
    expect(await controller.stopForRunner('runner_stop', { handoff: true })).toEqual({ ok: false, error: 'not_running' });
    expect(exitsOf(f)).toHaveLength(1);
  });

  test("an exit is dealt with while an escaped process still holds the agent's pipes", async () => {
    const f = await createRunnerFixture({
      script: {
        turns: [[{ do: 'tool', command: 'exec sleep 30', wait: false, inheritPipes: true }, { do: 'exit', code: 0 }]],
      },
    });
    const controller = f.controller();
    await controller.start(f.spec());
    const began = performance.now();
    await waitFor(() => exitsOf(f).length === 1, 10_000);
    expect(performance.now() - began).toBeLessThan(8_000);
    expect(exitsOf(f)[0]?.data).toMatchObject({ code: 0, stoppedBy: 'none' });
  }, 60_000);

  test('an agent that exits by itself during the stop is reported once', async () => {
    const f = await createRunnerFixture({
      config: { timings: { stopInterrupt: 10_000 } },
      // The second input releases the scripted exit, only once the ladder enters its interrupt step.
      script: { turns: [[], [{ do: 'exit', code: 3 }]] },
    });
    const controller = f.controller();
    await controller.start(f.spec());
    await waitFor(() => f.events('attempt.activity').some((event) => event.data.summary.startsWith('turn completed')));
    const session = controller.session!;
    session.interrupt = async (options) => {
      expect(options).toEqual({ cancelQueued: true });
      await session.send({ id: 'exit-during-stop', text: 'release the exit', authority: 'system' });
      // EOF and exited are independent signals. Keep the interrupt pending until the exit promise settles,
      // so an earlier EOF cannot advance the ladder to close while the fake adapter removes its script file.
      await session.exited;
    };
    expect(await controller.stop({ ...STOP, handoff: false })).toMatchObject({ ok: true, stoppedBy: 'interrupt' });
    await controller.settled();
    expect(exitsOf(f)).toHaveLength(1);
    expect(exitsOf(f)[0]?.data).toMatchObject({ code: 3, stoppedBy: 'interrupt' });
  });
});
