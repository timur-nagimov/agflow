import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localPinRefs } from '@agflow/core';
import { commitFiles, gitIn, type OriginRepo, originRepo } from '@agflow/testkit';
import { ensureRunnerGitFiles, gitOk, localGitEnv, remoteGitEnv, runGit } from '../src/git/run';
import { Vault } from '../src/git/vault';
import { type RunnerPaths, runnerPaths } from '../src/paths';

// Every test here runs git or agent processes, which take several times as long on a machine loaded by other suites.
setDefaultTimeout(30_000);

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const PREFIX = 'refs/agflow/';
const PROJECT = 'demo-0123456789';

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function origin(files: Record<string, string> = { 'README.md': '# demo\n' }): Promise<OriginRepo> {
  const made = await originRepo(files);
  cleanups.push(() => made.remove());
  return made;
}

interface Setup {
  paths: RunnerPaths;
  vault: Vault;
  /** Runs local git in the vault. */
  git(args: string[]): Promise<string>;
  has(sha: string): Promise<boolean>;
}

async function setup(repo: OriginRepo): Promise<Setup> {
  const paths = runnerPaths(tempDir('agflow-vault-'));
  ensureRunnerGitFiles(paths);
  // The owner's environment, but with a scratch HOME, so the developer's own git config plays no part.
  const home = tempDir('agflow-owner-');
  const vault = new Vault({
    paths,
    project: PROJECT,
    repo: { url: repo.path, mainBranch: 'main' },
    remote: () => remoteGitEnv({ base: { ...process.env, HOME: home, XDG_CONFIG_HOME: undefined } }),
  });
  await vault.ensure();
  const local = localGitEnv(paths);
  const git = async (args: string[]) =>
    (await runGit(local, [`--git-dir=${vault.path}`, ...args])).stdout.trim();
  const has = (sha: string) => gitOk(local, [`--git-dir=${vault.path}`, 'cat-file', '-e', `${sha}^{commit}`]);
  return { paths, vault, git, has };
}

describe('Vault.ensure', () => {
  test('creates the bare vault once, with the origin URL and gc.auto=0', async () => {
    const repo = await origin();
    const { vault, paths, git } = await setup(repo);
    expect(vault.path).toBe(paths.vault(PROJECT));
    expect(await git(['rev-parse', '--is-bare-repository'])).toBe('true');
    expect(await git(['config', '--get', 'remote.origin.url'])).toBe(repo.path);
    expect(await git(['config', '--get', 'gc.auto'])).toBe('0');
    expect(await git(['symbolic-ref', 'HEAD'])).toBe('refs/heads/main');
    // A second ensure keeps what is there.
    await vault.fetchForAttempt({ taskId: null, start: { ref: 'refs/heads/main', sha: null } }, PREFIX);
    await git(['update-ref', 'refs/agflow-local/T-1-a1/start', repo.mainSha]);
    await vault.ensure();
    expect(await git(['rev-parse', 'refs/agflow-local/T-1-a1/start'])).toBe(repo.mainSha);
  });

  test('follows a changed origin URL', async () => {
    const repo = await origin();
    const { paths, git } = await setup(repo);
    const moved = new Vault({ paths, project: PROJECT, repo: { url: '/elsewhere/origin.git', mainBranch: 'main' } });
    await moved.ensure();
    expect(await git(['config', '--get', 'remote.origin.url'])).toBe('/elsewhere/origin.git');
  });
});

describe('Vault.fetchForAttempt', () => {
  test("brings main, the task's WIP refs and its agflow/<task>-* branches, and nothing else", async () => {
    const repo = await origin();
    const wip = await commitFiles(repo.path, { branch: 'placeholder', files: { 'w.txt': 'w\n' } });
    // WIP refs are written straight into the origin, as a runner's push would leave them.
    await gitIn(repo.path, ['update-ref', `${PREFIX}T-4/a1`, wip]);
    await gitIn(repo.path, ['update-ref', `${PREFIX}T-5/a1`, wip]);
    const branch = await commitFiles(repo.path, { branch: 'agflow/T-4-parser', files: { 'b.txt': 'b\n' } });
    await commitFiles(repo.path, { branch: 'agflow/T-40-other', files: { 'c.txt': 'c\n' } });
    const { vault, git } = await setup(repo);
    await vault.fetchForAttempt({ taskId: 'T-4', start: { ref: `${PREFIX}T-4/a1`, sha: wip } }, PREFIX);
    const refs = (await git(['for-each-ref', '--format=%(refname) %(objectname)'])).split('\n').sort();
    expect(refs).toEqual(
      [`refs/agflow/T-4/a1 ${wip}`, `refs/heads/agflow/T-4-parser ${branch}`, `refs/heads/main ${repo.mainSha}`].sort(),
    );
  });

  test('then fetches start.sha by SHA when it is still missing', async () => {
    const repo = await origin();
    const elsewhere = await commitFiles(repo.path, { branch: 'scratch', files: { 'x.txt': 'x\n' } });
    const { vault, has } = await setup(repo);
    expect(await has(elsewhere)).toBe(false);
    await vault.fetchForAttempt({ taskId: 'T-4', start: { ref: 'refs/heads/main', sha: elsewhere } }, PREFIX);
    expect(await has(elsewhere)).toBe(true);
  });

  test('fetches a start ref that the task refspecs do not cover', async () => {
    const repo = await origin();
    const feature = await commitFiles(repo.path, { branch: 'feature', files: { 'f.txt': 'f\n' } });
    const { vault, git } = await setup(repo);
    await vault.fetchForAttempt({ taskId: 'T-4', start: { ref: 'refs/heads/feature', sha: null } }, PREFIX);
    expect(await git(['rev-parse', 'refs/heads/feature'])).toBe(feature);
  });

  test('names git and its stderr when origin cannot be read', async () => {
    const repo = await origin();
    const { paths } = await setup(repo);
    const broken = new Vault({
      paths,
      project: 'broken-0123456789',
      repo: { url: join(tempDir('agflow-missing-'), 'nothing.git'), mainBranch: 'main' },
    });
    await broken.ensure();
    await expect(
      broken.fetchForAttempt({ taskId: null, start: { ref: 'refs/heads/main', sha: null } }, PREFIX),
    ).rejects.toThrow(
      / fetch --quiet --no-tags origin \S+ failed \(exit 128\): fatal: .*does not appear to be a git repository/,
    );
  });

  test('a start ref deleted on origin is absent, not a failure: main and the WIP refs still arrive', async () => {
    const repo = await origin();
    // A person handed back on my-fix, which was merged into main and deleted afterwards.
    const fix = await commitFiles(repo.path, { branch: 'my-fix', files: { 'fix.txt': 'fix\n' } });
    await gitIn(repo.path, ['update-ref', 'refs/heads/main', fix]);
    await gitIn(repo.path, ['update-ref', '-d', 'refs/heads/my-fix']);
    const wip = await commitFiles(repo.path, { branch: 'placeholder', files: { 'w.txt': 'w\n' } });
    await gitIn(repo.path, ['update-ref', `${PREFIX}T-4/a1`, wip]);
    const { vault, git } = await setup(repo);
    const start = { ref: 'refs/heads/my-fix', sha: fix };
    await vault.fetchForAttempt({ taskId: 'T-4', start }, PREFIX);
    expect(await git(['rev-parse', 'refs/heads/main'])).toBe(fix);
    expect(await git(['rev-parse', `${PREFIX}T-4/a1`])).toBe(wip);
    expect(await vault.resolveStart(start)).toEqual({ ref: start.ref, sha: fix, recordedSha: fix, differs: false });
  });

  test('a recorded sha that origin no longer serves starts from the tip of the start ref', async () => {
    const repo = await origin();
    const tip = await commitFiles(repo.path, { branch: 'agflow/T-4-parser', files: { 'a.txt': '1\n' } });
    const { vault } = await setup(repo);
    // The WIP ref was rewritten: the recorded commit is gone from origin.
    const start = { ref: 'refs/heads/agflow/T-4-parser', sha: 'e'.repeat(40) };
    await vault.fetchForAttempt({ taskId: 'T-4', start }, PREFIX);
    expect(await vault.resolveStart(start)).toMatchObject({ sha: tip, differs: true });
  });

  test('an abbreviated recorded sha is resolved in the vault, never fetched by SHA', async () => {
    const repo = await origin();
    const first = await commitFiles(repo.path, { branch: 'agflow/T-4-parser', files: { 'a.txt': '1\n' } });
    const second = await commitFiles(repo.path, { branch: 'agflow/T-4-parser', files: { 'a.txt': '2\n' } });
    const { vault } = await setup(repo);
    const ref = 'refs/heads/agflow/T-4-parser';
    await vault.fetchForAttempt({ taskId: 'T-4', start: { ref, sha: second.slice(0, 12) } }, PREFIX);
    expect(await vault.resolveStart({ ref, sha: second.slice(0, 12) })).toEqual({
      ref,
      sha: second,
      recordedSha: second.slice(0, 12),
      differs: false,
    });
    expect(await vault.resolveStart({ ref, sha: first.slice(0, 7) })).toMatchObject({ sha: second, differs: true });
    // With the ref gone, the abbreviation names the commit to start from.
    expect(await vault.resolveStart({ ref: `${PREFIX}T-4/a1`, sha: first.slice(0, 7) })).toMatchObject({
      sha: first,
      differs: false,
    });
  });
});

describe('Vault.resolveStart', () => {
  test('returns the fetched tip of start.ref and reports when it differs from start.sha', async () => {
    const repo = await origin();
    const first = await commitFiles(repo.path, { branch: 'agflow/T-4-parser', files: { 'a.txt': '1\n' } });
    const second = await commitFiles(repo.path, { branch: 'agflow/T-4-parser', files: { 'a.txt': '2\n' } });
    const { vault } = await setup(repo);
    const start = { ref: 'refs/heads/agflow/T-4-parser', sha: first };
    await vault.fetchForAttempt({ taskId: 'T-4', start }, PREFIX);
    expect(await vault.resolveStart(start)).toEqual({
      ref: start.ref,
      sha: second,
      recordedSha: first,
      differs: true,
    });
    expect(await vault.resolveStart({ ref: start.ref, sha: second })).toMatchObject({ sha: second, differs: false });
    expect(await vault.resolveStart({ ref: 'refs/heads/main', sha: null })).toEqual({
      ref: 'refs/heads/main',
      sha: repo.mainSha,
      recordedSha: null,
      differs: false,
    });
  });

  test('resolves a refs/agflow-local/ start inside the vault, and fetchForAttempt never fetches it', async () => {
    const repo = await origin();
    const { vault, git, paths } = await setup(repo);
    await vault.fetchForAttempt({ taskId: null, start: { ref: 'refs/heads/main', sha: null } }, PREFIX);
    // A harvest the vault alone holds: origin has never seen this commit.
    const tree = await git(['rev-parse', `${repo.mainSha}^{tree}`]);
    const identity = {
      GIT_AUTHOR_NAME: 'a',
      GIT_AUTHOR_EMAIL: 'a@b',
      GIT_COMMITTER_NAME: 'a',
      GIT_COMMITTER_EMAIL: 'a@b',
    };
    const commitTree = [`--git-dir=${vault.path}`, 'commit-tree', tree, '-p', repo.mainSha];
    const made = await runGit(localGitEnv(paths), commitTree, { input: 'harvested\n', env: identity });
    const harvested = made.stdout.trim();
    await vault.pin('T-4-a1', { head: harvested });
    const pins = localPinRefs('T-4-a1');
    const position = { ref: pins.head, sha: harvested };
    await vault.fetchForAttempt({ taskId: 'T-4', start: position }, PREFIX);
    expect(await git(['rev-parse', pins.head])).toBe(harvested);
    expect(await vault.resolveStart(position)).toEqual({
      ref: pins.head,
      sha: harvested,
      recordedSha: harvested,
      differs: false,
    });
  });

  test('falls back to a recorded sha the vault holds, and refuses an unknown position', async () => {
    const repo = await origin();
    const { vault } = await setup(repo);
    await vault.fetchForAttempt({ taskId: null, start: { ref: 'refs/heads/main', sha: null } }, PREFIX);
    expect(await vault.resolveStart({ ref: `${PREFIX}T-4/a1`, sha: repo.mainSha })).toMatchObject({
      sha: repo.mainSha,
      differs: false,
    });
    await expect(vault.resolveStart({ ref: `${PREFIX}T-4/a1`, sha: null })).rejects.toThrow(
      'the start position refs/agflow/T-4/a1 is not in the vault',
    );
    await expect(vault.resolveStart({ ref: `${PREFIX}T-4/a1`, sha: 'f'.repeat(40) })).rejects.toThrow(
      'not in the vault',
    );
  });
});

describe('refresh and pins', () => {
  test('refresh fetches the named refs with the task refspecs', async () => {
    const repo = await origin();
    const { vault, git } = await setup(repo);
    const late = await commitFiles(repo.path, { branch: 'placeholder', files: { 'l.txt': 'l\n' } });
    await gitIn(repo.path, ['update-ref', `${PREFIX}T-4/a1-late-1`, late]);
    const other = await commitFiles(repo.path, { branch: 'handback', files: { 'h.txt': 'h\n' } });
    await vault.refresh('T-4', [`${PREFIX}T-4/a1-late-1`, 'refs/heads/handback'], PREFIX);
    expect(await git(['rev-parse', `${PREFIX}T-4/a1-late-1`])).toBe(late);
    expect(await git(['rev-parse', 'refs/heads/handback'])).toBe(other);
    expect(await git(['rev-parse', 'refs/heads/main'])).toBe(repo.mainSha);
    await expect(vault.refresh('T-4', ['refs/agflow-local/T-4-a1/head'], PREFIX)).rejects.toThrow('local pin');
  });

  test('pins are written per attempt, and deletePins removes only that attempt', async () => {
    const repo = await origin();
    const { vault, git } = await setup(repo);
    await vault.fetchForAttempt({ taskId: null, start: { ref: 'refs/heads/main', sha: null } }, PREFIX);
    await vault.pin('T-4-a1', { start: repo.mainSha, head: repo.mainSha });
    await vault.pin('T-4-a10', { start: repo.mainSha });
    await vault.pin('T-5-a1', { head: repo.mainSha });
    const pinned = async () => (await git(['for-each-ref', '--format=%(refname)', 'refs/agflow-local/'])).split('\n');
    expect(await pinned()).toEqual([
      localPinRefs('T-4-a1').head,
      localPinRefs('T-4-a1').start,
      localPinRefs('T-4-a10').start,
      localPinRefs('T-5-a1').head,
    ]);
    await vault.deletePins('T-4-a1');
    expect(await pinned()).toEqual([localPinRefs('T-4-a10').start, localPinRefs('T-5-a1').head]);
    await vault.deletePins('T-4-a1');
  });

  test('two concurrent ref updates of one vault run one after the other', async () => {
    const repo = await origin();
    const { vault, paths, git } = await setup(repo);
    const steps: string[] = [];
    const slow = vault.withLock(async () => {
      steps.push('a start');
      await Bun.sleep(50);
      steps.push('a end');
    });
    // Another Vault object for the same vault shares the lock.
    const twin = new Vault({ paths, project: PROJECT, repo: { url: repo.path, mainBranch: 'main' } });
    const fast = twin.withLock(async () => {
      steps.push('b start');
      steps.push('b end');
    });
    await Promise.all([slow, fast]);
    expect(steps).toEqual(['a start', 'a end', 'b start', 'b end']);
    // A failure releases the lock.
    await expect(vault.withLock(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await vault.withLock(async () => 'next')).toBe('next');
    await vault.fetchForAttempt({ taskId: null, start: { ref: 'refs/heads/main', sha: null } }, PREFIX);
    const pinned = async () => (await git(['for-each-ref', '--format=%(refname)', 'refs/agflow-local/'])).split('\n');
    // A pin waits while another holder has the lock.
    let open!: () => void;
    const held = vault.withLock(() => new Promise<void>((resolve) => (open = resolve)));
    let landed = false;
    const pin = vault.pin('T-4-a1', { head: repo.mainSha }).then(() => {
      landed = true;
    });
    await Bun.sleep(100);
    expect(landed).toBe(false);
    expect(await pinned()).toEqual(['']);
    open();
    await Promise.all([held, pin]);
    expect(await pinned()).toEqual([localPinRefs('T-4-a1').head]);
    // Real ref updates in parallel all land.
    const ids = Array.from({ length: 8 }, (_, index) => `T-4-a${index + 1}`);
    await Promise.all(ids.map((id) => vault.pin(id, { start: repo.mainSha, head: repo.mainSha })));
    await Promise.all([...ids.map((id) => vault.deletePins(id)), vault.pin('T-9-a1', { head: repo.mainSha })]);
    expect(await pinned()).toEqual([localPinRefs('T-9-a1').head]);
  });
});

describe('base checkouts', () => {
  test('are created detached at the main sha, shared between attempts and removed after the last release', async () => {
    const repo = await origin({ 'CLAUDE.md': '# rules\n', '.claude/settings.json': '{}\n' });
    const { vault, paths, git } = await setup(repo);
    await vault.fetchForAttempt({ taskId: null, start: { ref: 'refs/heads/main', sha: null } }, PREFIX);
    const first = await vault.acquireBaseCheckout('T-4-a1');
    expect(first.path).toBe(paths.baseCheckout(PROJECT, repo.mainSha));
    expect(first.sha).toBe(repo.mainSha);
    expect(readFileSync(join(first.path, 'CLAUDE.md'), 'utf8')).toBe('# rules\n');
    expect(readFileSync(join(first.path, '.claude/settings.json'), 'utf8')).toBe('{}\n');
    const head = await runGit(localGitEnv(paths), ['rev-parse', 'HEAD'], { cwd: first.path });
    expect(head.stdout.trim()).toBe(repo.mainSha);
    expect(await gitOk(localGitEnv(paths), ['symbolic-ref', '-q', 'HEAD'], { cwd: first.path })).toBe(false);
    const second = await vault.acquireBaseCheckout('T-5-a1', repo.mainSha);
    expect(second.path).toBe(first.path);
    await first.release();
    // Released twice by mistake: still counted once.
    await first.release();
    expect(existsSync(first.path)).toBe(true);
    await second.release();
    expect(existsSync(first.path)).toBe(false);
    expect(await git(['worktree', 'list', '--porcelain'])).not.toContain(first.path);
  });

  test('two Vault objects of one vault share the count: only the last release removes the checkout', async () => {
    const repo = await origin({ 'CLAUDE.md': '# rules\n' });
    const { vault, paths, git } = await setup(repo);
    await vault.fetchForAttempt({ taskId: null, start: { ref: 'refs/heads/main', sha: null } }, PREFIX);
    const twin = new Vault({ paths, project: PROJECT, repo: { url: repo.path, mainBranch: 'main' } });
    const first = await vault.acquireBaseCheckout('T-4-a1');
    const second = await twin.acquireBaseCheckout('T-5-a1');
    expect(second.path).toBe(first.path);
    await first.release();
    expect(existsSync(join(first.path, 'CLAUDE.md'))).toBe(true);
    await second.release();
    expect(existsSync(first.path)).toBe(false);
    expect(await git(['worktree', 'list', '--porcelain'])).not.toContain(first.path);
  });

  test('a checkout no attempt uses is made again, not reused because its HEAD matches', async () => {
    const repo = await origin({ 'CLAUDE.md': '# rules\n' });
    const { vault, paths } = await setup(repo);
    await vault.fetchForAttempt({ taskId: null, start: { ref: 'refs/heads/main', sha: null } }, PREFIX);
    // Left by an earlier runner process whose worktree add stopped half way: HEAD is set, a file is missing.
    const path = paths.baseCheckout(PROJECT, repo.mainSha);
    const add = ['worktree', 'add', '--quiet', '--detach', path, repo.mainSha];
    await runGit(localGitEnv(paths), [`--git-dir=${vault.path}`, ...add]);
    rmSync(join(path, 'CLAUDE.md'));
    const checkout = await vault.acquireBaseCheckout('T-4-a1');
    expect(checkout.path).toBe(path);
    expect(readFileSync(join(path, 'CLAUDE.md'), 'utf8')).toBe('# rules\n');
    await checkout.release();
  });

  test('a newer main gets its own checkout', async () => {
    const repo = await origin();
    const { vault } = await setup(repo);
    await vault.fetchForAttempt({ taskId: null, start: { ref: 'refs/heads/main', sha: null } }, PREFIX);
    const old = await vault.acquireBaseCheckout('T-4-a1');
    const newer = await commitFiles(repo.path, { branch: 'main', files: { 'n.txt': 'n\n' } });
    await vault.fetchForAttempt({ taskId: null, start: { ref: 'refs/heads/main', sha: null } }, PREFIX);
    const fresh = await vault.acquireBaseCheckout('T-5-a1');
    expect(fresh.sha).toBe(newer);
    expect(fresh.path).not.toBe(old.path);
    await old.release();
    await fresh.release();
  });
});

describe('Vault.consolidate', () => {
  test('keeps unreachable objects while any clone exists and prunes only when none does', async () => {
    const repo = await origin();
    const { vault, paths, git } = await setup(repo);
    await vault.fetchForAttempt({ taskId: null, start: { ref: 'refs/heads/main', sha: null } }, PREFIX);
    const loose = await runGit(localGitEnv(paths), [`--git-dir=${vault.path}`, 'hash-object', '-w', '--stdin'], {
      input: 'unreachable\n',
    });
    const blob = loose.stdout.trim();
    const exists = () => gitOk(localGitEnv(paths), [`--git-dir=${vault.path}`, 'cat-file', '-e', blob]);
    const clone = paths.clone(PROJECT, 'T-4-a1');
    mkdirSync(clone, { recursive: true });
    expect(await vault.consolidate()).toEqual({ pruned: false });
    expect(await exists()).toBe(true);
    expect(await git(['count-objects', '-v'])).toMatch(/^count: 0$/m);
    rmSync(clone, { recursive: true });
    expect(await vault.consolidate()).toEqual({ pruned: true });
    expect(await exists()).toBe(false);
    expect(await git(['rev-parse', 'refs/heads/main'])).toBe(repo.mainSha);
  });
});
