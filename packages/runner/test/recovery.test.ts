import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { AttemptController } from '../src/attempt/controller';
import type { LocalAttemptState } from '../src/attempt-store';
import { processIdentity, type ProcessIdentity } from '../src/processes';
import { killRegisteredGroups, liveAttemptsForHello, recoverOnStart } from '../src/recovery';
import { cleanupRunnerFixtures, createRunnerFixture, type RunnerFixture, waitFor } from './fixture';
import { requireLsofOnMacOS } from './prerequisites';

// Every test here runs git or agent processes, which take several times as long on a machine loaded by other suites.
setDefaultTimeout(30_000);

const children: ReturnType<typeof Bun.spawn>[] = [];
const controllers: AttemptController[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill('SIGKILL');
    await child.exited;
  }
  for (const controller of controllers.splice(0)) await controller.session?.close();
  await cleanupRunnerFixtures();
});

/** A real group leader with its own cwd, without invoking any vendor CLI. */
async function childIn(clone: string) {
  mkdirSync(clone, { recursive: true });
  const child = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    cwd: clone,
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
  });
  children.push(child);
  // Wait for the child to enter its event loop before the clone sweep.
  let identity: ProcessIdentity | null = null;
  for (let tries = 0; tries < 100 && identity === null; tries++) {
    identity = await processIdentity(child.pid);
    if (identity === null) await Bun.sleep(10);
  }
  expect(identity).not.toBeNull();
  return { child, identity: identity! };
}

function record(f: RunnerFixture, n: number, state: LocalAttemptState, clone: string | null) {
  const attemptId = `T-${n}-a1`;
  f.store.create(f.spec({ attemptId, taskId: `T-${n}`, branch: `agflow/T-${n}-x`, wipRef: `refs/agflow/T-${n}/a1` }), {
    clone,
    tmpDir: null,
    cliVersion: null,
  });
  return f.store.update(attemptId, { state, sessionRef: state === 'starting' ? null : `session-${n}` });
}

describe('startup recovery', () => {
  test.skipIf(process.platform !== 'darwin')(
    'kills matching registered groups, sweeps every recorded clone, and never signals a reused pid (the runner supports darwin-arm64 only; design 7.1)',
    async () => {
      requireLsofOnMacOS();
      const f = await createRunnerFixture();
      const clone = join(f.home, 'clone');
      const otherClone = join(f.home, 'other-clone');
      const leader = await childIn(clone);
      const escaped = await childIn(clone);
      // T-5's leader died and its pid went to an unrelated process elsewhere; a tool it left still runs in its clone.
      const reused = await childIn(join(f.home, 'elsewhere'));
      const left = await childIn(otherClone);
      record(f, 4, 'running', clone);
      record(f, 5, 'running', otherClone);
      const registration = { ...leader.identity, attemptId: 'T-4-a1', clone };
      f.store.recordProcess(registration);
      f.store.recordProcess({ ...reused.identity, lstart: 'an earlier process', attemptId: 'T-5-a1', clone: otherClone });
      expect(await killRegisteredGroups(f.store, f.logger)).toEqual([registration]);
      // Killed processes have no exit code, only the signal.
      await Promise.all([leader.child.exited, escaped.child.exited, left.child.exited]);
      expect([leader.child.signalCode, escaped.child.signalCode, left.child.signalCode]).toEqual([
        'SIGKILL',
        'SIGKILL',
        'SIGKILL',
      ]);
      expect(reused.child.signalCode).toBeNull();
      expect(await processIdentity(reused.child.pid)).toEqual(reused.identity);
      expect(f.store.processes()).toEqual([]);
      // The standalone helper does not change the attempts' states; startup owns that step.
      expect(f.store.get('T-4-a1')?.state).toBe('running');
      expect(await killRegisteredGroups(f.store, f.logger)).toEqual([]);
    },
    60_000,
  );

  test.skipIf(process.platform !== 'darwin')(
    'sweeps a recorded clone whose group leader is gone, so an escaped tool does not outlive a crash (the runner supports darwin-arm64 only; design 7.1)',
    async () => {
      requireLsofOnMacOS();
      const f = await createRunnerFixture();
      const clone = join(f.home, 'clone');
      const leader = await childIn(clone);
      const survivor = await childIn(clone);
      record(f, 4, 'running', clone);
      f.store.recordProcess({ ...leader.identity, attemptId: 'T-4-a1', clone });
      leader.child.kill('SIGKILL');
      await leader.child.exited;
      expect(await killRegisteredGroups(f.store, f.logger)).toEqual([]);
      expect(f.store.processes()).toEqual([]);
      await survivor.child.exited;
      expect(survivor.child.signalCode).toBe('SIGKILL');
    },
    60_000,
  );

  test('recovers running, starting and idle attempts as stopped, preserves suspended and ended clones awaiting cleanup', async () => {
    const f = await createRunnerFixture();
    const states: LocalAttemptState[] = ['running', 'starting', 'idle', 'suspended', 'ended', 'stopped'];
    for (const [i, state] of states.entries()) {
      const clone = join(f.home, `clone-${i}`);
      mkdirSync(clone);
      record(f, i + 4, state, clone);
      if (state === 'ended') f.store.update(`T-${i + 4}-a1`, { endedAt: 123 });
    }
    record(f, 10, 'ended', null);
    f.store.update('T-10-a1', { endedAt: 123 });
    await recoverOnStart(f.store, f.logger);
    expect(f.store.processes()).toEqual([]);
    for (const id of ['T-4-a1', 'T-5-a1', 'T-6-a1']) {
      expect(f.store.get(id)).toMatchObject({ state: 'stopped', finalizedAt: null });
    }
    expect(f.store.get('T-7-a1')?.state).toBe('suspended');
    expect(f.store.get('T-8-a1')).toMatchObject({ state: 'ended', endedAt: 123 });
    expect(liveAttemptsForHello(f.store).map((attempt) => [attempt.attemptId, attempt.state])).toEqual([
      ['T-4-a1', 'stopped'],
      ['T-5-a1', 'stopped'],
      ['T-6-a1', 'stopped'],
      ['T-7-a1', 'suspended'],
      ['T-8-a1', 'stopped'],
      ['T-9-a1', 'stopped'],
    ]);
    await recoverOnStart(f.store, f.logger);
    expect(f.store.get('T-7-a1')?.state).toBe('suspended');
  }, 60_000);

  test('hello carries every recorded state, fence, session and the actual clone existence', async () => {
    const f = await createRunnerFixture();
    const states = ['starting', 'running', 'idle', 'stopped', 'suspended'] as const;
    for (const [i, state] of states.entries()) {
      const clone = join(f.home, `clone-${i}`);
      mkdirSync(clone);
      record(f, i + 4, state, clone);
      f.store.update(`T-${i + 4}-a1`, { fence: { epoch: 2, counter: i + 1 } });
    }
    rmSync(f.store.get('T-7-a1')!.clone!, { recursive: true });
    expect(liveAttemptsForHello(f.store)).toEqual(
      states.map((state, i) => ({
        attemptId: `T-${i + 4}-a1`,
        fence: { epoch: 2, counter: i + 1 },
        state,
        sessionRef: state === 'starting' ? null : `session-${i + 4}`,
        clone: i !== 3,
      })),
    );
    f.store.update('T-7-a1', { endedAt: 123 });
    expect(liveAttemptsForHello(f.store).map((attempt) => attempt.attemptId)).not.toContain('T-7-a1');
    f.store.update('T-8-a1', { endedAt: 123 });
    expect(liveAttemptsForHello(f.store).map((attempt) => attempt.attemptId)).toContain('T-8-a1');
  });

  test('on reconnect an idle lead is idle and an idle worker still has a running process', async () => {
    const f = await createRunnerFixture();
    const lead = f.controller('lead-a1');
    const worker = f.controller();
    controllers.push(lead, worker);
    expect(
      await lead.start(f.spec({ attemptId: 'lead-a1', role: 'lead', taskId: null, branch: null, wipRef: null })),
    ).toEqual({ started: true });
    expect(await worker.start(f.spec())).toEqual({ started: true });
    await waitFor(() => lead.phase === 'idle' && worker.phase === 'idle');
    expect(f.store.get('lead-a1')?.state).toBe('running');
    const live = new Map([
      [lead.attemptId, lead],
      [worker.attemptId, worker],
    ]);
    expect(liveAttemptsForHello(f.store, live).map(({ attemptId, state }) => ({ attemptId, state }))).toEqual([
      { attemptId: 'lead-a1', state: 'idle' },
      { attemptId: 'T-4-a1', state: 'running' },
    ]);
    // A resume keeps its session ref while waiting for the new attempt.spawned.
    f.store.update('lead-a1', { state: 'starting' });
    expect(liveAttemptsForHello(f.store, live)[0]?.state).toBe('starting');
  }, 60_000);

  test('a start still preparing its clone, with no process yet, is starting whatever its record says', async () => {
    const release = Promise.withResolvers<void>();
    const f = await createRunnerFixture();
    const controller = f.controller('T-4-a1', {
      preparer: {
        available: true,
        prepare: async () => {
          await release.promise;
          return { ran: true, ok: true, error: null, logTail: null };
        },
      },
    });
    controllers.push(controller);
    const started = controller.start(f.spec());
    await waitFor(() => controller.phase === 'preparing', 10_000);
    // As a previous run left it: the record says stopped until the new process is spawned.
    f.store.update('T-4-a1', { state: 'stopped' });
    expect(liveAttemptsForHello(f.store, new Map([[controller.attemptId, controller]]))).toEqual([
      expect.objectContaining({ attemptId: 'T-4-a1', state: 'starting' }),
    ]);
    release.resolve();
    expect(await started).toEqual({ started: true });
  }, 60_000);
});
