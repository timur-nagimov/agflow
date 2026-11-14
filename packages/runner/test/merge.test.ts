import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitFiles, fileAt, gitIn, originRepo } from '@agflow/testkit';
import { MERGE_TRIES, mergeTaskBranch } from '../src/git/merge';
import { ensureRunnerGitFiles, localGitEnv, remoteGitEnv } from '../src/git/run';
import { Vault } from '../src/git/vault';
import { runnerPaths } from '../src/paths';

// Every test here runs git, which takes several times as long on a machine loaded by other suites.
setDefaultTimeout(30_000);

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const PREFIX = 'refs/agflow/';
const BRANCH = 'agflow/T-4-tidy';
const IDENTITY = { name: 'agflow runner', email: 'runner@agflow.invalid' };

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A local origin and the project's vault, as a runner has them; every git the remote environment runs is traced. */
async function setup() {
  const repo = await originRepo({ 'README.md': '# demo\n', 'src/app.ts': 'app\n' });
  cleanups.push(() => repo.remove());
  const paths = runnerPaths(tempDir('agflow-merge-'));
  ensureRunnerGitFiles(paths);
  const base = { ...process.env, HOME: tempDir('agflow-owner-'), XDG_CONFIG_HOME: undefined };
  const vault = new Vault({
    paths,
    project: 'demo-0123456789',
    repo: { url: repo.path, mainBranch: 'main' },
    remote: () => remoteGitEnv({ base }),
  });
  await vault.ensure();
  const remote = await remoteGitEnv({ base, gitDir: vault.path });
  const trace = join(tempDir('agflow-trace-'), 'trace');
  remote.env.GIT_TRACE = trace;
  const main = () => gitIn(repo.path, ['rev-parse', 'refs/heads/main']);
  /** merge_task as the executor runs it, for the task branch at head. */
  const merge = (head: string, extra: Partial<Parameters<typeof mergeTaskBranch>[0]> = {}) =>
    mergeTaskBranch({
      vault,
      local: localGitEnv(paths),
      remote,
      taskId: 'T-4',
      title: 'Tidy the app',
      branch: BRANCH,
      headSha: head,
      wipRefPrefix: PREFIX,
      identity: IDENTITY,
      ...extra,
    });
  return { repo, vault, trace, main, merge };
}

describe('merge_task', () => {
  test('a clean merge pushes a commit with main and the head as parents, leased on the main it merged', async () => {
    const s = await setup();
    const head = await commitFiles(s.repo.path, { branch: BRANCH, files: { 'src/app.ts': 'tidy\n' } });
    const before = await commitFiles(s.repo.path, { branch: 'main', files: { 'docs.md': 'docs\n' } });
    const outcome = await s.merge(head);
    const after = await s.main();
    expect(outcome).toEqual({ status: 'merged', sha: after });
    expect(await gitIn(s.repo.path, ['rev-list', '--parents', '-n', '1', after])).toBe(`${after} ${before} ${head}`);
    expect(await gitIn(s.repo.path, ['log', '-1', '--format=%s|%an|%ae', after])).toBe(
      'Merge T-4: Tidy the app|agflow runner|runner@agflow.invalid',
    );
    expect(await fileAt(s.repo.path, after, 'src/app.ts')).toBe('tidy\n');
    expect(await fileAt(s.repo.path, after, 'docs.md')).toBe('docs\n');
    expect(readFileSync(s.trace, 'utf8')).toContain(`--force-with-lease=refs/heads/main:${before}`);
  });

  test('a conflict reports its files and leaves main where it was', async () => {
    const s = await setup();
    const head = await commitFiles(s.repo.path, {
      branch: BRANCH,
      files: { 'src/app.ts': 'tidy\n', 'README.md': '# tidy\n' },
    });
    const before = await commitFiles(s.repo.path, {
      branch: 'main',
      files: { 'src/app.ts': 'other\n', 'README.md': '# other\n' },
    });
    expect(await s.merge(head)).toEqual({ status: 'conflict', files: ['README.md', 'src/app.ts'] });
    expect(await s.main()).toBe(before);
  });

  test('a main that moved before the push is fetched and merged again', async () => {
    const s = await setup();
    const head = await commitFiles(s.repo.path, { branch: BRANCH, files: { 'src/app.ts': 'tidy\n' } });
    let pushes = 0;
    let moved = '';
    const outcome = await s.merge(head, {
      beforePush: async () => {
        pushes += 1;
        // Another machine pushes to main between this runner's fetch and its push, once.
        if (pushes === 1) moved = await commitFiles(s.repo.path, { branch: 'main', files: { 'late.md': 'late\n' } });
      },
    });
    const after = await s.main();
    expect(pushes).toBe(2);
    expect(outcome).toEqual({ status: 'merged', sha: after });
    expect(await gitIn(s.repo.path, ['rev-list', '--parents', '-n', '1', after])).toBe(`${after} ${moved} ${head}`);
    expect(await fileAt(s.repo.path, after, 'late.md')).toBe('late\n');
  });

  test(`a main that keeps moving fails after ${MERGE_TRIES} tries, and main keeps the others' work`, async () => {
    const s = await setup();
    const head = await commitFiles(s.repo.path, { branch: BRANCH, files: { 'src/app.ts': 'tidy\n' } });
    let pushes = 0;
    let last = '';
    const outcome = await s.merge(head, {
      beforePush: async () => {
        pushes += 1;
        last = await commitFiles(s.repo.path, { branch: 'main', files: { [`late-${pushes}.md`]: 'late\n' } });
      },
    });
    expect(pushes).toBe(MERGE_TRIES);
    expect(outcome).toMatchObject({ status: 'failed' });
    if (outcome.status === 'failed') expect(outcome.detail).toContain('kept moving');
    expect(await s.main()).toBe(last);
  });

  test('a head main already holds is merged at main, with nothing pushed', async () => {
    const s = await setup();
    const head = await commitFiles(s.repo.path, { branch: BRANCH, files: { 'src/app.ts': 'tidy\n' } });
    const first = await s.merge(head);
    expect(first).toMatchObject({ status: 'merged' });
    const pushesBefore = readFileSync(s.trace, 'utf8').split('--force-with-lease').length;
    expect(await s.merge(head)).toEqual(first);
    expect(readFileSync(s.trace, 'utf8').split('--force-with-lease').length).toBe(pushesBefore);
  });

  test("only a task's own branch is merged, and only a head the vault has", async () => {
    const s = await setup();
    const before = await s.main();
    const head = await commitFiles(s.repo.path, { branch: BRANCH, files: { 'src/app.ts': 'tidy\n' } });
    const other = await s.merge(head, { branch: 'feature/T-4-tidy' });
    expect(other).toMatchObject({ status: 'failed' });
    if (other.status === 'failed') expect(other.detail).toContain('is not a branch of T-4');
    const unknown = await s.merge('f'.repeat(40));
    expect(unknown).toMatchObject({ status: 'failed' });
    if (unknown.status === 'failed') expect(unknown.detail).toContain('the vault has no commit');
    expect(await s.main()).toBe(before);
  });
});
