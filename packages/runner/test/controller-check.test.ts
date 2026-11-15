import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { join } from 'node:path';
import type { FakeStep } from '@agflow/testkit';
import { commitFiles, fileAt, gitIn } from '@agflow/testkit';
import { checkOwnFiles } from '../src/attempt/submit';
import { resolveRestoreBase } from '../src/git/protect';
import { runGit } from '../src/git/run';
import { createDependencyPreparer } from '../src/prep/preparer';
import { PrepSandbox, type SandboxBackend } from '../src/prep/sandbox';
import { standardProfile } from '../src/profile';
import type { DependencyPreparer } from '../src/seams';
import { cleanupRunnerFixtures, createRunnerFixture, FIXTURE_PROJECT, type RunnerFixture, waitFor } from './fixture';

afterEach(cleanupRunnerFixtures);

// Every test here runs git or agent processes, which take several times as long on a machine loaded by other suites.
setDefaultTimeout(30_000);

const FENCE = { epoch: 1, counter: 1 };
const BRANCH = 'agflow/T-4-tidy';
const COMMITTED: FakeStep[] = [
  { do: 'write', path: 'src/app.ts', content: 'tidy\n' },
  { do: 'commit', message: 'tidy the app' },
];
const SUBMISSION = { fence: FENCE, submissionId: 'S-1', branch: BRANCH, expectedBranchSha: null, adoptable: [] };

/** The sandbox runtime as the preparer tests fake it: the wrapped command runs as it is, with the real timeout. */
const passThrough: SandboxBackend = {
  initialize: async () => {},
  isSupportedPlatform: () => true,
  checkDependencies: () => ({ errors: [], warnings: [] }),
  wrapWithSandboxArgv: async (command) => ({ argv: ['/bin/sh', '-c', command], env: {} }),
  cleanupAfterCommand: () => {},
};

const files = (check: string | null) => ({
  'README.md': '# demo\n',
  'src/app.ts': 'app\n',
  ...(check === null ? {} : { '.agflow/config.json': JSON.stringify({ check }) }),
});

const cloneOf = (f: RunnerFixture) => f.paths.clone(FIXTURE_PROJECT, 'T-4-a1');
const originRef = (f: RunnerFixture, ref: string) =>
  gitIn(f.origin.path, ['rev-parse', '--verify', '--quiet', ref], { allowFailure: true }).then((sha) => sha || null);

/**
 * T-4-a1 started with the steps as its first turn, once that turn has ended. Its preparer runs commands as
 * dependency preparation does, unless the runner has none (sandbox false).
 */
async function workedOn(
  check: string | null,
  options: {
    checkMinutes?: number;
    sandbox?: boolean;
    files?: Record<string, string>;
    profile?: 'open';
    turn?: FakeStep[];
  } = {},
) {
  const f = await createRunnerFixture({
    files: { ...files(check), ...options.files },
    script: { turns: [options.turn ?? COMMITTED] },
    config: {
      ...(options.checkMinutes === undefined ? {} : { checkMinutes: options.checkMinutes }),
      ...(options.profile === undefined ? {} : { profile: options.profile }),
    },
  });
  const sandbox = new PrepSandbox({ allowedDomains: standardProfile.network.allowedDomains, manager: passThrough });
  const preparer: DependencyPreparer | undefined =
    options.sandbox === false
      ? undefined
      : await createDependencyPreparer({
          paths: f.paths,
          store: f.store,
          config: () => f.config,
          ownerHome: join(f.home, 'owner'),
          run: (spec) => sandbox.run(spec),
        });
  const controller = f.controller('T-4-a1', preparer ? { preparer } : {});
  expect(await controller.start(f.spec({ branch: BRANCH }))).toEqual({ started: true });
  await waitFor(() => f.events('attempt.activity').some((event) => event.data.kind === 'turn'));
  const submit = async () => {
    const result = await controller.submit(SUBMISSION);
    if (!result.ok) throw new Error(`the submission was refused: ${result.error}`);
    return result.outcome;
  };
  return { f, controller, submit };
}

describe('the check at submission', () => {
  test('a check that passes lets the submission go, and its result travels with it', async () => {
    // It names no file the branch changes, so the check has no own files changed.
    const command = 'test -f README.md && test -z "$AGFLOW_AGENT_TOKEN" && echo checked';
    const { f, submit } = await workedOn(command);
    const head = await gitIn(cloneOf(f), ['rev-parse', 'HEAD']);
    const outcome = await submit();
    expect(outcome).toMatchObject({ ok: true, error: null, headSha: head, remoteHead: head });
    expect(outcome.check).toEqual({ status: 'passed', command, durationMs: expect.any(Number), tail: 'checked' });
    expect(await originRef(f, `refs/heads/${BRANCH}`)).toBe(head);
    expect(f.events('attempt.submitted').map((event) => event.data.check?.status)).toEqual(['passed']);
  });

  test("a passed check names the check's own files the branch changes: the agent may have made it pass", async () => {
    const weakened: FakeStep[] = [
      { do: 'write', path: 'scripts/check.sh', content: 'echo all good; exit 0\n' },
      { do: 'write', path: 'src/app.ts', content: 'broken\n' },
      { do: 'commit', message: 'make the check pass' },
    ];
    const { submit } = await workedOn('bash scripts/check.sh', {
      files: { 'scripts/check.sh': 'echo failing; exit 1\n' },
      turn: weakened,
    });
    const outcome = await submit();
    expect(outcome).toMatchObject({ ok: true, error: null });
    expect(outcome.check).toMatchObject({ status: 'passed', tail: 'all good', ownFilesChanged: ['scripts/check.sh'] });
  });

  test('the check\'s own files are .agflow/config.json and the files its command names', () => {
    const changed = ['.agflow/config.json', 'scripts/check.sh', 'scripts/lint.sh', 'src/app.ts'];
    expect(checkOwnFiles('bash scripts/check.sh', changed)).toEqual(['.agflow/config.json', 'scripts/check.sh']);
    expect(checkOwnFiles('./scripts/lint.sh && bun test', changed)).toEqual(['.agflow/config.json', 'scripts/lint.sh']);
    expect(checkOwnFiles('bun test', ['src/app.ts', 'src/app.test.ts'])).toEqual([]);
  });

  test("the check's own files are found however the command spells their paths", () => {
    const changed = ['scripts/check.sh', 'src/app.ts'];
    const commands = [
      'bash ./scripts//check.sh',
      'sh scripts/../scripts/check.sh',
      'sh $PWD/scripts/check.sh',
      'sh "${PWD}/./scripts/check.sh"',
      'bash $(pwd)//scripts/check.sh && bun test',
      'sh "$PWD"/scripts/check.sh',
      'sh "$(pwd)"/scripts/check.sh',
      'sh `pwd`/scripts/check.sh',
      'make check SCRIPT=scripts/check.sh',
      `python3 -c "import subprocess; subprocess.run(['sh', 'scripts/check.sh'])"`,
    ];
    for (const command of commands) {
      expect([command, checkOwnFiles(command, changed)]).toEqual([command, ['scripts/check.sh']]);
    }
    // A path that leaves the clone names none of its files.
    expect(checkOwnFiles('sh $PWD/../scripts/check.sh', changed)).toEqual([]);
  });

  test('a failing check refuses the submission with the last 60 lines of its output, and nothing is pushed', async () => {
    const { f, submit } = await workedOn('i=1; while [ $i -le 100 ]; do echo line $i; i=$((i+1)); done; exit 3');
    const outcome = await submit();
    expect(outcome).toMatchObject({ ok: false, error: 'check_failed', remoteHead: null });
    expect(outcome.check).toMatchObject({ status: 'failed' });
    const tail = (outcome.check?.tail ?? '').split('\n');
    expect([tail.length, tail[0], tail.at(-1)]).toEqual([60, 'line 41', 'line 100']);
    const detail = outcome.detail ?? '';
    expect(detail).toContain('exited with code 3');
    expect(detail).toContain('line 41\n');
    expect(detail).not.toContain('line 40\n');
    expect(await originRef(f, `refs/heads/${BRANCH}`)).toBeNull();
  });

  test('a check that runs past checkMinutes is stopped and fails as timed out', async () => {
    // 0.005 minutes: 300 ms.
    const { f, submit } = await workedOn('echo started; sleep 20', { checkMinutes: 0.005 });
    const began = performance.now();
    const outcome = await submit();
    expect(performance.now() - began).toBeLessThan(15_000);
    expect(outcome).toMatchObject({ ok: false, error: 'check_failed', check: { status: 'failed', tail: 'started' } });
    expect(outcome.detail).toContain('timed out after 300 ms');
    expect(await originRef(f, `refs/heads/${BRANCH}`)).toBeNull();
  });

  test('the push gets only what the check left of submitRetry, the time the hub gives the whole submission', async () => {
    const { f, submit } = await workedOn('sleep 2; echo slow');
    f.config.timings.submitRetry = 1_000;
    await runGit(f.local, [`--git-dir=${f.vault.path}`, 'config', 'remote.origin.url', join(f.home, 'no-such-origin')]);
    const outcome = await submit();
    expect(outcome).toMatchObject({ ok: false, error: 'remote', check: { status: 'passed', tail: 'slow' } });
    // One try and no retry: the check took longer than submitRetry.
    expect(f.logger.entries.filter((entry) => entry.message.startsWith('a submission push failed'))).toEqual([]);
  });

  test("main merges into the branch first, in the clone: the check runs on the merge, and the merge is what goes", async () => {
    const { f, submit } = await workedOn('test -f main.txt && echo has-main');
    const main = await commitFiles(f.origin.path, { branch: 'main', files: { 'main.txt': 'from main\n' } });
    const clone = cloneOf(f);
    const head = await gitIn(clone, ['rev-parse', 'HEAD']);
    const outcome = await submit();
    expect(outcome).toMatchObject({ ok: true, error: null, check: { status: 'passed', tail: 'has-main' } });
    const merged = outcome.headSha as string;
    expect(merged).not.toBe(head);
    expect(await gitIn(f.origin.path, ['rev-list', '--parents', '-n', '1', merged])).toBe(`${merged} ${head} ${main}`);
    expect(await originRef(f, `refs/heads/${BRANCH}`)).toBe(merged);
    expect(await fileAt(f.origin.path, merged, 'src/app.ts')).toBe('tidy\n');
    // The agent's clone is on its branch at the merge, with main's files and nothing to commit.
    expect(await gitIn(clone, ['rev-parse', 'HEAD'])).toBe(merged);
    expect(await gitIn(clone, ['symbolic-ref', 'HEAD'])).toBe(`refs/heads/${BRANCH}`);
    expect(await Bun.file(join(clone, 'main.txt')).text()).toBe('from main\n');
    expect(await gitIn(clone, ['status', '--porcelain'])).toBe('');
    // Protected paths are restored from the main it merged from now on.
    expect(await resolveRestoreBase(f.vault, f.spec())).toBe(main);
  });

  test('a merge of main that changes what the dependencies need prepares them again before the check', async () => {
    const entry = { run: ['/bin/sh', '-c', 'cp deps.txt installed.txt'], when: ['deps.txt'] };
    const config = (check: string) => JSON.stringify({ dependencies: [entry], check });
    const { f, submit } = await workedOn(null, {
      files: { '.gitignore': 'installed.txt\n', 'deps.txt': 'v1\n', '.agflow/config.json': config('echo v1') },
    });
    const clone = cloneOf(f);
    expect(await Bun.file(join(clone, 'installed.txt')).text()).toBe('v1\n');
    // main moves on: a new dependency, and a check that needs it installed.
    const check = 'test "$(cat deps.txt)" = "$(cat installed.txt)" && echo deps-ok';
    const moved = { 'deps.txt': 'v2\n', '.agflow/config.json': config(check) };
    await commitFiles(f.origin.path, { branch: 'main', files: moved });
    const outcome = await submit();
    expect(outcome).toMatchObject({ ok: true, check: { status: 'passed', command: check, tail: 'deps-ok' } });
    expect(await Bun.file(join(clone, 'installed.txt')).text()).toBe('v2\n');
    // The preparation restored the protected paths from the main that merged in, not from the one the attempt began at.
    expect(await Bun.file(join(clone, '.agflow/config.json')).text()).toBe(config(check));
  });

  test('a preparation that fails after main merged in refuses the submission as check_failed', async () => {
    const entry = { run: ['/bin/sh', '-c', 'echo installing; test "$(cat deps.txt)" = v1'], when: ['deps.txt'] };
    const config = JSON.stringify({ dependencies: [entry], check: 'echo never' });
    const { f, submit } = await workedOn(null, { files: { 'deps.txt': 'v1\n', '.agflow/config.json': config } });
    await commitFiles(f.origin.path, { branch: 'main', files: { 'deps.txt': 'v2\n' } });
    const outcome = await submit();
    expect(outcome).toMatchObject({ ok: false, error: 'check_failed', remoteHead: null });
    expect(outcome.check).toMatchObject({ status: 'failed', command: 'echo never', durationMs: 0 });
    const tail = outcome.check?.tail ?? '';
    expect(tail.split('\n')[0]).toBe('installing');
    expect(tail).toContain('exited with code 1');
    expect(outcome.detail).toContain('Call prepare_dependencies');
    expect(outcome.detail).toEndWith(`The last lines of its output:\n${tail}`);
    expect(await originRef(f, `refs/heads/${BRANCH}`)).toBeNull();
  });

  test('under the open profile that preparation refuses nothing: the check runs, and its output notes the failure', async () => {
    const entry = { run: ['/bin/sh', '-c', 'echo installing; test "$(cat deps.txt)" = v1'], when: ['deps.txt'] };
    const config = JSON.stringify({ dependencies: [entry], check: 'echo checked' });
    const { f, submit } = await workedOn(null, {
      files: { 'deps.txt': 'v1\n', '.agflow/config.json': config },
      profile: 'open',
    });
    await commitFiles(f.origin.path, { branch: 'main', files: { 'deps.txt': 'v2\n' } });
    const outcome = await submit();
    expect(outcome).toMatchObject({ ok: true, error: null, check: { status: 'passed', command: 'echo checked' } });
    const [output, note, ...rest] = (outcome.check?.tail ?? '').split('\n');
    expect([output, rest]).toEqual(['checked', []]);
    expect(note).toStartWith('The dependencies could not be prepared again after main merged in (');
    expect(note).toContain('exited with code 1');
    expect(note).toEndWith('). The check ran anyway.');
    expect(await originRef(f, `refs/heads/${BRANCH}`)).toBe(outcome.headSha);
  });

  test('a conflict with main refuses the submission, naming the files, and leaves the clone as it was', async () => {
    const { f, submit } = await workedOn('echo never');
    await commitFiles(f.origin.path, { branch: 'main', files: { 'src/app.ts': 'other\n' } });
    const clone = cloneOf(f);
    const head = await gitIn(clone, ['rev-parse', 'HEAD']);
    const outcome = await submit();
    expect(outcome).toMatchObject({ ok: false, error: 'merge_conflict', headSha: head, check: null });
    const detail = outcome.detail ?? '';
    expect(detail).toContain('These files conflict: src/app.ts.');
    expect(detail).toContain('git fetch origin && git merge origin/main');
    expect(await gitIn(clone, ['rev-parse', 'HEAD'])).toBe(head);
    expect(await Bun.file(join(clone, 'src/app.ts')).text()).toBe('tidy\n');
    expect(await originRef(f, `refs/heads/${BRANCH}`)).toBeNull();
  });

  test('with no check, or a runner that cannot run one, the submission goes on with check none', async () => {
    const none = await workedOn(null);
    expect(await none.submit()).toMatchObject({
      ok: true,
      check: { status: 'none', command: null, durationMs: 0, tail: '' },
    });
    const unrunnable = await workedOn('echo checked', { sandbox: false });
    const outcome = await unrunnable.submit();
    expect(outcome).toMatchObject({ ok: true, check: { status: 'none', command: 'echo checked', durationMs: 0 } });
    expect(outcome.check?.tail).toContain('cannot run it');
  });
});
