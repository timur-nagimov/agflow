import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FakeStep } from '@agflow/testkit';
import { commitFiles, gitIn } from '@agflow/testkit';
import { pushSubmissionWithRetries } from '../src/attempt/submit';
import type { SubmitPushOutcome } from '../src/git/push';
import { runGit } from '../src/git/run';
import { cleanupRunnerFixtures, createRunnerFixture, FIXTURE_PROJECT, type RunnerFixture, waitFor } from './fixture';

afterEach(cleanupRunnerFixtures);

// Every test here runs git or agent processes, which take several times as long on a machine loaded by other suites.
setDefaultTimeout(30_000);

const FENCE = { epoch: 1, counter: 1 };
const BRANCH = 'agflow/T-4-tidy';
const WIP = 'refs/agflow/T-4/a1';
const FILES = { 'README.md': '# demo\n', 'src/app.ts': 'app\n', '.claude/settings.json': '{"permissions":{}}\n' };
const COMMITTED: FakeStep[] = [
  { do: 'write', path: 'src/app.ts', content: 'tidy\n' },
  { do: 'commit', message: 'tidy the app' },
];

const originRef = (f: RunnerFixture, ref: string) =>
  gitIn(f.origin.path, ['rev-parse', '--verify', '--quiet', ref], { allowFailure: true }).then((sha) => sha || null);

const cloneHead = (f: RunnerFixture) => gitIn(f.paths.clone(FIXTURE_PROJECT, 'T-4-a1'), ['rev-parse', 'HEAD']);

/** T-4-a1 started with the steps as its first turn, once that turn has ended. */
async function workedOn(steps: FakeStep[], options: { files?: Record<string, string>; branch?: string; timings?: object } = {}) {
  const f = await createRunnerFixture({
    files: options.files ?? FILES,
    script: { turns: [steps] },
    config: { timings: options.timings ?? {} },
  });
  const controller = f.controller();
  expect(await controller.start(f.spec({ branch: options.branch ?? BRANCH }))).toEqual({ started: true });
  await waitFor(() => f.events('attempt.activity').some((event) => event.data.kind === 'turn'));
  return { f, controller };
}

/** The outcome a submission reported. */
function outcomeOf(result: Awaited<ReturnType<ReturnType<RunnerFixture['controller']>['submit']>>) {
  if (!result.ok) throw new Error(`the submission was refused: ${result.error}`);
  return result.outcome;
}

const submission = (overrides: Partial<{ branch: string; expectedBranchSha: string | null; adoptable: string[] }> = {}) => ({
  fence: FENCE,
  submissionId: 'S-1',
  branch: BRANCH,
  expectedBranchSha: null,
  adoptable: [],
  ...overrides,
});

describe('AttemptController: submissions', () => {
  test('a submission naming another branch, or one outside the task, pushes nothing and is a violation', async () => {
    const { f, controller } = await workedOn(COMMITTED);
    expect(await controller.submit(submission({ branch: 'agflow/T-5-other' }))).toEqual({
      ok: false,
      error: 'branch_refused',
    });
    expect(await originRef(f, 'refs/heads/agflow/T-5-other')).toBeNull();
    expect(f.events('attempt.violation').map((event) => event.data)).toEqual([
      { phase: 'submit', paths: ['agflow/T-5-other'] },
    ]);
    expect(f.events('attempt.submitted')).toEqual([]);

    const outside = await workedOn(COMMITTED, { branch: 'feature/T-4-tidy' });
    const result = await outside.controller.submit(submission({ branch: 'feature/T-4-tidy' }));
    expect(result).toEqual({ ok: false, error: 'branch_refused' });
    expect(await originRef(outside.f, 'refs/heads/feature/T-4-tidy')).toBeNull();
    expect(await originRef(outside.f, WIP)).toBeNull();
    expect(outside.f.events('attempt.violation').map((event) => event.data.phase)).toEqual(['submit']);
  });

  test('uncommitted changes give dirty and protected changes protected_paths; the origin is untouched', async () => {
    const dirty = await workedOn([...COMMITTED, { do: 'write', path: 'notes.txt', content: 'not committed\n' }]);
    const head = await cloneHead(dirty.f);
    const refused = outcomeOf(await dirty.controller.submit(submission()));
    expect(refused).toMatchObject({ submissionId: 'S-1', ok: false, error: 'dirty', headSha: head, remoteHead: null });
    expect(refused.detail).toContain('notes.txt');
    expect(dirty.f.events('attempt.submitted').map((event) => event.data)).toEqual([refused]);
    expect(await originRef(dirty.f, `refs/heads/${BRANCH}`)).toBeNull();
    expect(await originRef(dirty.f, WIP)).toBeNull();

    const guarded = await workedOn([
      { do: 'write', path: '.claude/settings.json', content: '{"permissions":{"allow":["Bash(*)"]}}\n' },
      { do: 'commit', message: 'allow everything' },
    ]);
    const protectedPaths = outcomeOf(await guarded.controller.submit(submission()));
    expect(protectedPaths).toMatchObject({ ok: false, error: 'protected_paths' });
    const detail = protectedPaths.detail ?? '';
    expect(detail).toContain('.claude/settings.json');
    expect(detail).not.toContain('merge');
    expect(await originRef(guarded.f, `refs/heads/${BRANCH}`)).toBeNull();
  });

  test("a refused path that main has changed since the restore base gets the advice to merge main", async () => {
    const { f, controller } = await workedOn([{ do: 'sleep', ms: 300 }]);
    await commitFiles(f.origin.path, {
      branch: 'main',
      files: { '.claude/settings.json': '{"permissions":{"deny":["WebFetch"]}}\n' },
      message: 'tighten settings on main',
    });
    // The agent copies main's newer settings by hand instead of merging.
    const clone = f.paths.clone(FIXTURE_PROJECT, 'T-4-a1');
    await Bun.write(join(clone, '.claude', 'settings.json'), '{"permissions":{"deny":["WebFetch"]}}\n');
    await gitIn(clone, ['commit', '-q', '-am', 'take the settings from main']);
    const result = outcomeOf(await controller.submit(submission()));
    expect(result).toMatchObject({ error: 'protected_paths' });
    const detail = result.detail ?? '';
    expect(detail).toContain('.claude/settings.json');
    expect(detail).toContain('git fetch origin && git merge origin/main');
  });

  test('a branch that followed the advice and merged main submits as it is', async () => {
    const { f, controller } = await workedOn(COMMITTED);
    const newer = '{"permissions":{"deny":["WebFetch"]}}\n';
    await commitFiles(f.origin.path, {
      branch: 'main',
      files: { '.claude/settings.json': newer },
      message: 'tighten settings on main',
    });
    // The WIP push fetches main into the vault, which is the clone's origin.
    await controller.pushWip();
    const clone = f.paths.clone(FIXTURE_PROJECT, 'T-4-a1');
    await gitIn(clone, ['fetch', '-q', 'origin']);
    await gitIn(clone, ['merge', '-q', '--no-edit', 'origin/main']);
    const head = await cloneHead(f);
    const result = outcomeOf(await controller.submit(submission()));
    expect(result).toMatchObject({ ok: true, error: null, headSha: head, remoteHead: head });
    expect(await originRef(f, `refs/heads/${BRANCH}`)).toBe(head);
    expect(await gitIn(f.origin.path, ['show', `${head}:.claude/settings.json`])).toBe(newer.trimEnd());
    expect(f.events('attempt.violation').filter((event) => event.data.phase === 'submit')).toEqual([]);
  });

  test('a file over 10 MB the snapshot leaves out makes the clone dirty', async () => {
    const { f, controller } = await workedOn(COMMITTED);
    writeFileSync(join(f.paths.clone(FIXTURE_PROJECT, 'T-4-a1'), 'data.bin'), Buffer.alloc(11 * 1024 * 1024, 1));
    const result = outcomeOf(await controller.submit(submission()));
    expect(result).toMatchObject({ ok: false, error: 'dirty' });
    expect(result.detail).toContain('data.bin');
    expect(await originRef(f, `refs/heads/${BRANCH}`)).toBeNull();
  });

  test('a submission with a fence that is not the attempt\'s is refused and moves nothing', async () => {
    const { f, controller } = await workedOn(COMMITTED);
    expect(await controller.submit({ ...submission(), fence: { epoch: 1, counter: 0 } })).toEqual({
      ok: false,
      error: 'stale_fence',
    });
    expect(await originRef(f, `refs/heads/${BRANCH}`)).toBeNull();
    expect(f.events('attempt.submitted')).toEqual([]);
  });

  test('a clean submission moves the task branch and the WIP ref to the harvested head', async () => {
    const { f, controller } = await workedOn(COMMITTED);
    const head = await cloneHead(f);
    const result = await controller.submit(submission());
    const outcome = { submissionId: 'S-1', ok: true, headSha: head, remoteHead: head, error: null, detail: null };
    expect(result).toEqual({ ok: true, outcome });
    expect(f.events('attempt.submitted').map((event) => [event.fence, event.data])).toEqual([[FENCE, outcome]]);
    expect(await originRef(f, `refs/heads/${BRANCH}`)).toBe(head);
    expect(await originRef(f, WIP)).toBe(head);
    expect(f.store.get('T-4-a1')).toMatchObject({ pushedSha: head, wipSha: head });
    // The WIP ref holds the work now: the timer finds nothing to push.
    expect(await controller.pushWip()).toEqual({ status: 'unchanged' });
  });

  test('adoption, needs_merge and branch_moved follow the stale-lease rules', async () => {
    const adopted = await workedOn(COMMITTED);
    const earlier = await commitFiles(adopted.f.origin.path, { branch: BRANCH, files: { 'old.txt': 'old\n' } });
    const head = await cloneHead(adopted.f);
    expect(await adopted.controller.submit(submission({ adoptable: [earlier] }))).toMatchObject({
      ok: true,
      outcome: { ok: true, headSha: head, remoteHead: head },
    });
    expect(await originRef(adopted.f, `refs/heads/${BRANCH}`)).toBe(head);

    const merge = await workedOn(COMMITTED);
    const onTop = await commitFiles(merge.f.origin.path, { branch: BRANCH, files: { 'person.txt': 'a fix\n' } });
    expect(await merge.controller.submit(submission({ adoptable: [merge.f.origin.mainSha] }))).toMatchObject({
      ok: true,
      outcome: { ok: false, error: 'needs_merge', remoteHead: onTop },
    });
    expect(await originRef(merge.f, `refs/heads/${BRANCH}`)).toBe(onTop);

    const moved = await workedOn(COMMITTED);
    const elsewhere = await commitFiles(moved.f.origin.path, { branch: BRANCH, files: { 'other.txt': 'x\n' } });
    expect(await moved.controller.submit(submission())).toMatchObject({
      ok: true,
      outcome: { ok: false, error: 'branch_moved', remoteHead: elsewhere },
    });
    expect(await originRef(moved.f, WIP)).toBeNull();
  }, 60_000);

  test('remote failures are retried until submitRetry passes (remote) or a stop or hold arrives (interrupted)', async () => {
    const setOrigin = (f: RunnerFixture, url: string) =>
      runGit(f.local, [`--git-dir=${f.vault.path}`, 'config', 'remote.origin.url', url]);
    const failing = await workedOn(COMMITTED, { timings: { submitRetry: 1_200 } });
    await setOrigin(failing.f, join(failing.f.home, 'no-such-origin'));
    const began = performance.now();
    const remote = await failing.controller.submit(submission());
    expect(performance.now() - began).toBeGreaterThanOrEqual(1_000);
    expect(remote).toMatchObject({ ok: true, outcome: { ok: false, error: 'remote' } });
    expect(failing.f.logger.entries.filter((entry) => entry.message.startsWith('a submission push failed')).length).toBeGreaterThan(1);
    await setOrigin(failing.f, failing.f.origin.path);

    for (const ending of ['stop', 'hold'] as const) {
      const { f, controller } = await workedOn(COMMITTED, { timings: { submitRetry: 60_000 } });
      await setOrigin(f, join(f.home, 'no-such-origin'));
      const pending = controller.submit(submission());
      await waitFor(() => f.logger.entries.some((entry) => entry.message.startsWith('a submission push failed')));
      const stopped =
        ending === 'stop'
          ? controller.stop({ fence: FENCE, reason: 'stopped', handoff: false, interruptFirst: false, keepClone: false })
          : controller.hold({ fence: FENCE });
      const started = performance.now();
      expect(await pending).toMatchObject({ ok: true, outcome: { ok: false, error: 'interrupted' } });
      expect(performance.now() - started).toBeLessThan(2_000);
      expect(await stopped).toMatchObject({ ok: true });
      await setOrigin(f, f.origin.path);
      expect(f.events().map((event) => event.type).filter((type) => type === 'attempt.submitted' || type === 'attempt.exited')).toEqual([
        'attempt.submitted',
        'attempt.exited',
      ]);
    }
  }, 30_000);

  test('a stop that arrives while the submission waits on the queue ends it as interrupted', async () => {
    const { f, controller } = await workedOn(COMMITTED, { timings: { submitRetry: 60_000 } });
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    void f.queue.run('T-4-a1', () => gate);
    const pending = controller.submit(submission());
    const stopped = controller.stop({ fence: FENCE, reason: 'stopped', handoff: false, interruptFirst: false, keepClone: false });
    release();
    expect(await pending).toMatchObject({ ok: true, outcome: { ok: false, error: 'interrupted' } });
    expect(await stopped).toMatchObject({ ok: true });
    expect(await originRef(f, `refs/heads/${BRANCH}`)).toBeNull();
  });

  test('an attempt the hub ended is answered at once, with no retries', async () => {
    const { f, controller } = await workedOn(COMMITTED, { timings: { submitRetry: 60_000 } });
    controller.markEnded();
    const began = performance.now();
    const result = outcomeOf(await controller.submit(submission()));
    expect(performance.now() - began).toBeLessThan(1_000);
    expect(result).toMatchObject({ ok: false, error: 'remote', detail: 'the hub ended the attempt' });
    expect(f.logger.entries.filter((entry) => entry.message.startsWith('a submission push failed'))).toEqual([]);
  });
});

describe('pushSubmissionWithRetries', () => {
  const failure: SubmitPushOutcome = { ok: false, headSha: 'h', remoteHead: null, error: 'remote', detail: 'down' };

  /** A fake clock: each sleep is recorded and passes at once, unless sleeps never end. */
  function clock(options: { endless?: boolean } = {}) {
    let at = 0;
    const waits: number[] = [];
    return {
      waits,
      now: () => at,
      sleep: (ms: number) => {
        waits.push(ms);
        if (options.endless) return new Promise<void>(() => {});
        at += ms;
        return Promise.resolve();
      },
    };
  }

  const base = { interrupted: () => false, stopArrived: () => new Promise<void>(() => {}), onRetry: () => {} };

  test('waits 1 s doubling to a minute, the last wait shortened to the budget', async () => {
    const fake = clock();
    let tries = 0;
    const outcome = await pushSubmissionWithRetries({
      ...base,
      ...fake,
      budgetMs: 200_000,
      push: async () => {
        tries += 1;
        return failure;
      },
    });
    expect(outcome).toBe(failure);
    expect(fake.waits).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 17_000]);
    expect(tries).toBe(10);
  });

  test('a refusal, or a remote outcome that cannot clear, is never retried', async () => {
    for (const [result, retryable] of [
      [{ ...failure, error: 'needs_merge' }, true],
      [failure, false],
    ] as const) {
      const fake = clock();
      let tries = 0;
      const outcome = await pushSubmissionWithRetries({
        ...base,
        ...fake,
        budgetMs: 60_000,
        retryable: () => retryable,
        push: async () => {
          tries += 1;
          return result;
        },
      });
      expect([outcome, tries, fake.waits]).toEqual([result, 1, []]);
    }
  });

  test('a stop during a wait or a try gives interrupted at once', async () => {
    let arrive = () => {};
    let stops = 0;
    const fake = clock({ endless: true });
    const waiting = pushSubmissionWithRetries({
      ...fake,
      budgetMs: 60_000,
      interrupted: () => stops > 0,
      stopArrived: () => new Promise<void>((resolve) => (arrive = resolve)),
      onRetry: () => {},
      push: async () => failure,
    });
    await Bun.sleep(10);
    stops += 1;
    arrive();
    expect(await waiting).toBe('interrupted');

    const during = clock();
    let tries = 0;
    let arrived = false;
    const outcome = await pushSubmissionWithRetries({
      ...base,
      ...during,
      budgetMs: 60_000,
      interrupted: () => arrived,
      push: async () => {
        tries += 1;
        arrived = true;
        return failure;
      },
    });
    expect([outcome, tries, during.waits]).toEqual(['interrupted', 1, []]);
  });
});
