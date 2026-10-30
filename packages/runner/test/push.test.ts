import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lateWorkRef, wipRef } from '@agflow/core';
import { commitFiles, gitIn, originRepo } from '@agflow/testkit';
import { deleteRefsFenced, pushLateWork, pushRefs, pushSubmission, pushWip } from '../src/git/push';
import { ensureRunnerGitFiles, localGitEnv, remoteGitEnv, runGit } from '../src/git/run';
import { commitTree } from '../src/git/snapshot';
import { Vault } from '../src/git/vault';
import { runnerPaths } from '../src/paths';

// Every test here runs git or agent processes, which take several times as long on a machine loaded by other suites.
setDefaultTimeout(30_000);

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const PREFIX = 'refs/agflow/';
const PROJECT = 'demo-0123456789';
const BRANCH = 'agflow/T-4-tidy';
const BRANCH_REF = `refs/heads/${BRANCH}`;
const ATTEMPT = 'T-4-a1';
const WIP = wipRef(PREFIX, ATTEMPT);
const IDENTITY = { name: 'agflow runner', email: 'runner@agflow.invalid' };

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function setup() {
  const repo = await originRepo({ 'README.md': '# demo\n' });
  cleanups.push(() => repo.remove());
  const paths = runnerPaths(tempDir('agflow-push-'));
  ensureRunnerGitFiles(paths);
  const home = tempDir('agflow-owner-');
  const base = { ...process.env, HOME: home, XDG_CONFIG_HOME: undefined };
  const vault = new Vault({
    paths,
    project: PROJECT,
    repo: { url: repo.path, mainBranch: 'main' },
    remote: () => remoteGitEnv({ base }),
  });
  await vault.ensure();
  await vault.fetchForAttempt({ taskId: 'T-4', start: { ref: 'refs/heads/main', sha: null } }, PREFIX);
  const local = localGitEnv(paths);
  const remote = await remoteGitEnv({ base, gitDir: vault.path });
  // Every git the remote environment runs logs its argv here.
  const trace = join(tempDir('agflow-trace-'), 'trace');
  remote.env.GIT_TRACE = trace;
  const git = { vault, local, remote };
  let count = 0;
  /** A new commit in the vault on parent, with main's tree. */
  const commit = async (parent = repo.mainSha) => {
    count += 1;
    const tree = (await runGit(local, [`--git-dir=${vault.path}`, 'rev-parse', `${parent}^{tree}`])).stdout.trim();
    return commitTree({ vault, local, tree, parent, message: `work ${count}`, identity: IDENTITY, now: new Date() });
  };
  /** A ref on the origin, or null. */
  const origin = async (ref: string) =>
    (await gitIn(repo.path, ['rev-parse', '--verify', '--quiet', ref], { allowFailure: true })) || null;
  /** Points a ref on the origin at a commit the vault holds, as another machine's push would. */
  const setOrigin = async (ref: string, sha: string) =>
    runGit(remote, [`--git-dir=${vault.path}`, 'push', '--quiet', '--no-verify', 'origin', `+${sha}:${ref}`]);
  /** Points the vault's origin at a path that holds no repository. */
  const loseOrigin = () =>
    runGit(local, [`--git-dir=${vault.path}`, 'config', 'remote.origin.url', join(tempDir('agflow-gone-'), 'x')]);
  return { repo, vault, local, remote, git, commit, origin, setOrigin, loseOrigin, trace };
}

describe('pushRefs', () => {
  test('pushes atomically: one stale lease refuses every ref, and nothing moves', async () => {
    const s = await setup();
    const [a, b, c] = [await s.commit(), await s.commit(), await s.commit()];
    expect(
      await pushRefs({
        ...s.git,
        updates: [
          { ref: WIP, sha: a, expected: null },
          { ref: BRANCH_REF, sha: a, expected: null },
        ],
      }),
    ).toMatchObject({ ok: true });
    const result = await pushRefs({
      ...s.git,
      updates: [
        { ref: WIP, sha: b, expected: a },
        { ref: BRANCH_REF, sha: b, expected: c },
      ],
    });
    expect(result).toMatchObject({ ok: false, error: 'stale' });
    expect(result.refs).toEqual([
      { ref: WIP, status: 'refused', detail: 'atomic push failed' },
      { ref: BRANCH_REF, status: 'stale', detail: 'stale info' },
    ]);
    expect(await s.origin(WIP)).toBe(a);
    expect(await s.origin(BRANCH_REF)).toBe(a);
  });

  test('an unreachable remote is classified as remote', async () => {
    const s = await setup();
    const a = await s.commit();
    await s.loseOrigin();
    const result = await pushWip({ ...s.git, ref: WIP, sha: a, previous: null });
    expect(result).toMatchObject({ ok: false, error: 'remote', refs: [] });
    if (!result.ok) expect(result.detail).toMatch(/does not appear to be a git repository/);
  });
});

describe('pushWip', () => {
  test('creates the WIP ref with an empty lease, advances it on the previous sha, never forces it', async () => {
    const s = await setup();
    const [a, b, c] = [await s.commit(), await s.commit(), await s.commit()];
    expect(await pushWip({ ...s.git, ref: WIP, sha: a, previous: null })).toEqual({
      ok: true,
      refs: [{ ref: WIP, status: 'ok', detail: 'new reference' }],
    });
    expect(await pushWip({ ...s.git, ref: WIP, sha: b, previous: a })).toMatchObject({ ok: true });
    expect(await s.origin(WIP)).toBe(b);
    expect(await pushWip({ ...s.git, ref: WIP, sha: c, previous: a })).toMatchObject({ ok: false, error: 'stale' });
    expect(await pushWip({ ...s.git, ref: WIP, sha: c, previous: null })).toMatchObject({ ok: false, error: 'stale' });
    expect(await s.origin(WIP)).toBe(b);
  });

  test('pushing the same sha again reports = and succeeds', async () => {
    const s = await setup();
    const a = await s.commit();
    await pushWip({ ...s.git, ref: WIP, sha: a, previous: null });
    // The lease is stale, but the ref already holds the commit: the retry of a push whose answer was lost.
    expect(await pushWip({ ...s.git, ref: WIP, sha: a, previous: null })).toEqual({
      ok: true,
      refs: [{ ref: WIP, status: 'up_to_date', detail: 'up to date' }],
    });
  });
});

describe('pushLateWork', () => {
  test('goes to the first late-work ref, then to the next free one', async () => {
    const s = await setup();
    const [a, b] = [await s.commit(), await s.commit()];
    const late = (sha: string) => pushLateWork({ ...s.git, wipRefPrefix: PREFIX, attemptId: ATTEMPT, sha });
    expect(await late(a)).toEqual({ ok: true, ref: lateWorkRef(PREFIX, ATTEMPT, 1), n: 1 });
    expect(await late(b)).toEqual({ ok: true, ref: lateWorkRef(PREFIX, ATTEMPT, 2), n: 2 });
    // A repeat of a push that landed finds its own ref.
    expect(await late(a)).toEqual({ ok: true, ref: lateWorkRef(PREFIX, ATTEMPT, 1), n: 1 });
    expect(await s.origin(lateWorkRef(PREFIX, ATTEMPT, 1))).toBe(a);
    expect(await s.origin(lateWorkRef(PREFIX, ATTEMPT, 2))).toBe(b);
  });
});

describe('pushSubmission', () => {
  const submission = (s: Awaited<ReturnType<typeof setup>>, sha: string, more: Record<string, unknown> = {}) =>
    pushSubmission({
      ...s.git,
      taskId: 'T-4',
      wipRefPrefix: PREFIX,
      branch: BRANCH,
      wipRef: WIP,
      sha,
      expectedBranchSha: null,
      previousWip: null,
      adoptable: [],
      ...more,
    });

  test('moves the task branch and the WIP ref together', async () => {
    const s = await setup();
    const a = await s.commit();
    expect(await submission(s, a)).toEqual({ ok: true, headSha: a, remoteHead: a, error: null, detail: null });
    expect(await s.origin(BRANCH_REF)).toBe(a);
    expect(await s.origin(WIP)).toBe(a);
    const b = await s.commit(a);
    expect(await submission(s, b, { expectedBranchSha: a, previousWip: a })).toMatchObject({ ok: true, headSha: b });
    expect(await s.origin(BRANCH_REF)).toBe(b);
    expect(await s.origin(WIP)).toBe(b);
  });

  test('adopts a remote head the submitted commit contains, with one retry', async () => {
    const s = await setup();
    const a = await s.commit();
    await submission(s, a);
    const moved = await commitFiles(s.repo.path, { branch: BRANCH, files: { 'b.txt': 'b\n' } });
    await s.vault.refresh('T-4', [], PREFIX);
    const merged = await s.commit(moved);
    expect(await submission(s, merged, { expectedBranchSha: a, previousWip: a })).toEqual({
      ok: true,
      headSha: merged,
      remoteHead: merged,
      error: null,
      detail: null,
    });
    expect(await s.origin(BRANCH_REF)).toBe(merged);
    expect(await s.origin(WIP)).toBe(merged);
  });

  test('adopts a remote head listed in adoptable', async () => {
    const s = await setup();
    const [other, mine] = [await s.commit(), await s.commit()];
    await s.setOrigin(BRANCH_REF, other);
    const outcome = await submission(s, mine, { expectedBranchSha: null, adoptable: [other.slice(0, 12)] });
    expect(outcome).toMatchObject({ ok: true, headSha: mine, remoteHead: mine });
    expect(await s.origin(BRANCH_REF)).toBe(mine);
  });

  test('a remote head on top of an adoptable sha gives needs_merge, any other gives branch_moved', async () => {
    const s = await setup();
    const agentWork = await s.commit();
    await submission(s, agentWork);
    const personal = await commitFiles(s.repo.path, { branch: BRANCH, files: { 'p.txt': 'person\n' } });
    const mine = await s.commit(agentWork);
    const needsMerge = await submission(s, mine, {
      expectedBranchSha: agentWork,
      previousWip: agentWork,
      adoptable: [agentWork],
    });
    expect(needsMerge).toEqual({
      ok: false,
      headSha: mine,
      remoteHead: personal,
      error: 'needs_merge',
      detail: expect.stringContaining(`git fetch origin && git merge origin/${BRANCH}`),
    });
    expect(await s.origin(BRANCH_REF)).toBe(personal);
    expect(await s.origin(WIP)).toBe(agentWork);
    // The vault carries the remote head, so the agent's `git fetch origin && git merge` merges it.
    const vaultBranch = await runGit(s.local, [`--git-dir=${s.vault.path}`, 'rev-parse', '--verify', BRANCH_REF]);
    expect(vaultBranch.stdout.trim()).toBe(personal);
    const unrelated = await s.commit(s.repo.mainSha);
    await s.setOrigin(BRANCH_REF, unrelated);
    const moved = await submission(s, mine, {
      expectedBranchSha: agentWork,
      previousWip: agentWork,
      adoptable: [agentWork],
    });
    expect(moved).toMatchObject({ ok: false, headSha: mine, remoteHead: unrelated, error: 'branch_moved' });
    expect(await s.origin(BRANCH_REF)).toBe(unrelated);
    expect(await s.origin(WIP)).toBe(agentWork);
  });

  test('adopts a WIP ref whose push answer was lost', async () => {
    const s = await setup();
    const w = await s.commit();
    await pushWip({ ...s.git, ref: WIP, sha: w, previous: null });
    const next = await s.commit(w);
    expect(await submission(s, next, { previousWip: null })).toEqual({
      ok: true,
      headSha: next,
      remoteHead: next,
      error: null,
      detail: null,
    });
    expect(await s.origin(BRANCH_REF)).toBe(next);
    expect(await s.origin(WIP)).toBe(next);
  });

  test('refuses a WIP ref at a commit this attempt did not push, and moves nothing', async () => {
    const s = await setup();
    const [foreign, mine] = [await s.commit(), await s.commit()];
    await s.setOrigin(WIP, foreign);
    const outcome = await submission(s, mine);
    expect(outcome).toMatchObject({ ok: false, headSha: mine, error: 'remote' });
    expect(outcome.detail).toContain(WIP);
    expect(await s.origin(WIP)).toBe(foreign);
    expect(await s.origin(BRANCH_REF)).toBeNull();
  });

  test('resolves an abbreviated expected branch sha from the remote', async () => {
    const s = await setup();
    const a = await s.commit();
    await submission(s, a);
    const b = await s.commit(a);
    const outcome = await submission(s, b, { expectedBranchSha: a.slice(0, 12), previousWip: a });
    expect(outcome).toEqual({ ok: true, headSha: b, remoteHead: b, error: null, detail: null });
    expect(await s.origin(BRANCH_REF)).toBe(b);
    expect(await s.origin(WIP)).toBe(b);
    // A rewritten branch: only the abbreviation's match with the remote head lets the lease through.
    const rewritten = await s.commit(s.repo.mainSha);
    const again = await submission(s, rewritten, { expectedBranchSha: b.slice(0, 12), previousWip: b });
    expect(again).toEqual({ ok: true, headSha: rewritten, remoteHead: rewritten, error: null, detail: null });
    expect(await s.origin(BRANCH_REF)).toBe(rewritten);
    expect(await s.origin(WIP)).toBe(rewritten);
  });

  test('a remote failure gives remote', async () => {
    const s = await setup();
    const a = await s.commit();
    await s.loseOrigin();
    expect(await submission(s, a)).toMatchObject({ ok: false, headSha: a, remoteHead: null, error: 'remote' });
  });
});

describe('deleteRefsFenced', () => {
  test('deletes a ref still at its expected sha and leaves one that moved', async () => {
    const s = await setup();
    const [a, b] = [await s.commit(), await s.commit()];
    const late = lateWorkRef(PREFIX, ATTEMPT, 1);
    const updates = [
      { ref: WIP, sha: a, expected: null },
      { ref: late, sha: b, expected: null },
    ];
    await pushRefs({ ...s.git, updates });
    const results = await deleteRefsFenced({
      ...s.git,
      refs: [
        { ref: WIP, expectedSha: a },
        { ref: late, expectedSha: a },
        { ref: lateWorkRef(PREFIX, ATTEMPT, 2), expectedSha: a },
      ],
    });
    expect(results).toEqual([
      { ref: WIP, status: 'deleted', remoteSha: null, detail: null },
      { ref: late, status: 'moved', remoteSha: b, detail: null },
      { ref: lateWorkRef(PREFIX, ATTEMPT, 2), status: 'gone', remoteSha: null, detail: null },
    ]);
    expect(await s.origin(WIP)).toBeNull();
    expect(await s.origin(late)).toBe(b);
  });
});

describe('every push', () => {
  test('is atomic, porcelain and without hooks, leased on an exact sha, and never forced', async () => {
    const s = await setup();
    const [a, b] = [await s.commit(), await s.commit()];
    await pushWip({ ...s.git, ref: WIP, sha: a, previous: null });
    await pushWip({ ...s.git, ref: WIP, sha: b, previous: a });
    await pushLateWork({ ...s.git, wipRefPrefix: PREFIX, attemptId: ATTEMPT, sha: a });
    await pushLateWork({ ...s.git, wipRefPrefix: PREFIX, attemptId: ATTEMPT, sha: b });
    const moved = await commitFiles(s.repo.path, { branch: BRANCH, files: { 'b.txt': 'b\n' } });
    await s.vault.refresh('T-4', [], PREFIX);
    await pushSubmission({
      ...s.git,
      taskId: 'T-4',
      wipRefPrefix: PREFIX,
      branch: BRANCH,
      wipRef: WIP,
      sha: await s.commit(moved),
      expectedBranchSha: null,
      previousWip: b,
      adoptable: [],
    });
    await deleteRefsFenced({ ...s.git, refs: [{ ref: lateWorkRef(PREFIX, ATTEMPT, 1), expectedSha: a }] });
    const pushes = readFileSync(s.trace, 'utf8')
      .split('\n')
      .filter((line) => line.includes('built-in: git push'));
    expect(pushes.length).toBe(8);
    for (const line of pushes) {
      const args = line.slice(line.indexOf('git push') + 'git push'.length).trim().split(' ');
      expect(args.slice(0, 3)).toEqual(['--atomic', '--porcelain', '--no-verify']);
      const leases = args.filter((arg) => arg.includes('--force'));
      const refspecs = args.slice(args.indexOf('origin') + 1);
      expect(leases.length).toBe(refspecs.length);
      for (const lease of leases) expect(lease).toMatch(/^'?--force-with-lease=refs\/[^:]+:(?:[0-9a-f]{40})?'?$/);
      for (const refspec of refspecs) expect(refspec).toMatch(/^(?:[0-9a-f]{40})?:refs\//);
    }
  });
});
