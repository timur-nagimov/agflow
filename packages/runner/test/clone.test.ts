import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { localPinRefs } from '@agflow/core';
import { commitFiles, gitIn, originRepo } from '@agflow/testkit';
import {
  cloneExists,
  createLeadClone,
  createTaskClone,
  fastForwardLeadClone,
  isWorktreeClean,
  readCloneHead,
  readCloneRef,
  readSized,
} from '../src/git/clone';
import { harvestCommits } from '../src/git/harvest';
import { ensureRunnerGitFiles, localGitEnv, remoteGitEnv, runGit } from '../src/git/run';
import { Vault } from '../src/git/vault';
import { runnerPaths } from '../src/paths';
import { PLANTED_ATTRIBUTES, plantCloneConfig, touchLater } from './planted-config';

// Every test here runs git or agent processes, which take several times as long on a machine loaded by other suites.
setDefaultTimeout(30_000);

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const PREFIX = 'refs/agflow/';
const PROJECT = 'demo-0123456789';
const BRANCH = 'agflow/T-4-tidy';

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function setup(files: Record<string, string> = { 'README.md': '# demo\n', 'src/app.ts': 'app\n' }) {
  const repo = await originRepo(files);
  cleanups.push(() => repo.remove());
  const paths = runnerPaths(tempDir('agflow-clone-'));
  ensureRunnerGitFiles(paths);
  const home = tempDir('agflow-owner-');
  const vault = new Vault({
    paths,
    project: PROJECT,
    repo: { url: repo.path, mainBranch: 'main' },
    remote: () => remoteGitEnv({ base: { ...process.env, HOME: home, XDG_CONFIG_HOME: undefined } }),
  });
  await vault.ensure();
  const local = localGitEnv(paths);
  const git = async (args: string[]) => (await runGit(local, [`--git-dir=${vault.path}`, ...args])).stdout.trim();
  const fetch = (start: { ref: string; sha: string | null }) => vault.fetchForAttempt({ taskId: 'T-4', start }, PREFIX);
  return { repo, paths, vault, local, git, fetch };
}

/** A clone made the way the runner makes a task clone, at main. */
async function taskClone(s: Awaited<ReturnType<typeof setup>>, attemptId = 'T-4-a1') {
  await s.fetch({ ref: 'refs/heads/main', sha: null });
  const clone = s.paths.clone(PROJECT, attemptId);
  await createTaskClone({ vault: s.vault, local: s.local, attemptId, clone, branch: BRANCH, startSha: s.repo.mainSha });
  return clone;
}

async function leadClone(s: Awaited<ReturnType<typeof setup>>, startSha = s.repo.mainSha) {
  await s.fetch({ ref: 'refs/heads/main', sha: null });
  const clone = s.paths.clone(PROJECT, 'lead-a1');
  const result = await createLeadClone({ vault: s.vault, local: s.local, attemptId: 'lead-a1', clone, startSha });
  return { clone, result };
}

describe('createTaskClone', () => {
  test('gives a clone on the task branch at the start commit, whose origin is the vault', async () => {
    const s = await setup();
    const start = await commitFiles(s.repo.path, { branch: 'agflow/T-4-earlier', files: { 'src/app.ts': 'v2\n' } });
    await s.fetch({ ref: 'refs/heads/agflow/T-4-earlier', sha: start });
    const clone = s.paths.clone(PROJECT, 'T-4-a1');
    expect(cloneExists(clone)).toBe(false);
    const result = await createTaskClone({
      vault: s.vault,
      local: s.local,
      attemptId: 'T-4-a1',
      clone,
      branch: BRANCH,
      startSha: start,
    });
    expect(result).toEqual({ created: true });
    expect(cloneExists(clone)).toBe(true);
    expect(await gitIn(clone, ['symbolic-ref', 'HEAD'])).toBe(`refs/heads/${BRANCH}`);
    expect(await gitIn(clone, ['rev-parse', 'HEAD'])).toBe(start);
    expect(readFileSync(join(clone, 'src', 'app.ts'), 'utf8')).toBe('v2\n');
    expect(await gitIn(clone, ['status', '--porcelain'])).toBe('');
    expect(await gitIn(clone, ['config', '--get', 'remote.origin.url'])).toBe(s.vault.path);
    // The objects are borrowed from the vault, and the start pin keeps them there.
    expect(readFileSync(join(clone, '.git', 'objects', 'info', 'alternates'), 'utf8').trim()).toBe(
      join(s.vault.path, 'objects'),
    );
    expect(await s.git(['rev-parse', localPinRefs('T-4-a1').start])).toBe(start);
    await expect(readCloneHead(clone)).resolves.toEqual({ ref: `refs/heads/${BRANCH}`, sha: start });
  });

  test("the agent's fetches stay on the laptop, and its git ignores .agflow/run/", async () => {
    const s = await setup();
    const clone = await taskClone(s);
    s.repo.remove();
    expect(existsSync(s.repo.path)).toBe(false);
    await gitIn(clone, ['fetch', '--quiet', 'origin', 'main']);
    expect(await gitIn(clone, ['rev-parse', 'FETCH_HEAD'])).toBe(s.repo.mainSha);
    mkdirSync(join(clone, '.agflow', 'run'), { recursive: true });
    writeFileSync(join(clone, '.agflow', 'run', 'task.md'), '# T-4\n');
    expect(await gitIn(clone, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
    await gitIn(clone, ['add', '-A']);
    expect(await gitIn(clone, ['diff', '--cached', '--name-only'])).toBe('');
  });

  test('an existing clone is detected and never recreated; a half-made one is replaced', async () => {
    const s = await setup();
    const clone = s.paths.clone(PROJECT, 'T-4-a1');
    // What a runner that died while making the clone leaves behind.
    mkdirSync(join(dirname(clone), '.T-4-a1.creating', 'junk'), { recursive: true });
    await taskClone(s);
    expect(existsSync(join(dirname(clone), '.T-4-a1.creating'))).toBe(false);
    writeFileSync(join(clone, 'work.txt'), 'the agent was here\n');
    const other = await commitFiles(s.repo.path, { branch: 'agflow/T-4-other', files: { 'o.txt': 'o\n' } });
    await s.fetch({ ref: 'refs/heads/agflow/T-4-other', sha: other });
    const again = await createTaskClone({
      vault: s.vault,
      local: s.local,
      attemptId: 'T-4-a1',
      clone,
      branch: BRANCH,
      startSha: other,
    });
    expect(again).toEqual({ created: false });
    expect(readFileSync(join(clone, 'work.txt'), 'utf8')).toBe('the agent was here\n');
    expect(await gitIn(clone, ['rev-parse', 'HEAD'])).toBe(s.repo.mainSha);
  });
});

describe('createLeadClone', () => {
  test('gives a clone detached at main with no task branch', async () => {
    const s = await setup();
    const { clone, result } = await leadClone(s);
    expect(result).toEqual({ created: true });
    expect(readFileSync(join(clone, '.git', 'HEAD'), 'utf8').trim()).toBe(s.repo.mainSha);
    expect(await gitIn(clone, ['symbolic-ref', '-q', 'HEAD'], { allowFailure: true })).toBe('');
    expect(await gitIn(clone, ['branch', '--list', 'agflow/*'])).toBe('');
    expect(await gitIn(clone, ['status', '--porcelain'])).toBe('');
    expect(await s.git(['rev-parse', localPinRefs('lead-a1').start])).toBe(s.repo.mainSha);
  });
});

describe('readCloneRef', () => {
  test('reads a loose ref, then packed-refs, and refuses anything but 40 hex', async () => {
    const s = await setup();
    const clone = await taskClone(s);
    expect(await readCloneRef(clone, `refs/heads/${BRANCH}`)).toBe(s.repo.mainSha);
    await gitIn(clone, ['pack-refs', '--all']);
    expect(existsSync(join(clone, '.git', 'refs', 'heads', 'agflow', 'T-4-tidy'))).toBe(false);
    expect(await readCloneRef(clone, `refs/heads/${BRANCH}`)).toBe(s.repo.mainSha);
    expect(await readCloneRef(clone, 'refs/heads/missing')).toBeNull();
    writeFileSync(join(clone, '.git', 'refs', 'heads', 'odd'), 'ref: refs/heads/main\n');
    await expect(readCloneRef(clone, 'refs/heads/odd')).rejects.toThrow(/not a commit sha/);
    writeFileSync(join(clone, '.git', 'refs', 'heads', 'odd'), 'zz\n');
    await expect(readCloneRef(clone, 'refs/heads/odd')).rejects.toThrow(/not a commit sha/);
    await expect(readCloneRef(clone, 'refs/heads/../../config')).rejects.toThrow(/not a ref/);
  });
});

describe('isWorktreeClean', () => {
  test("compares the clone's files with its HEAD through the vault", async () => {
    const s = await setup();
    const clone = await taskClone(s);
    const check = () => isWorktreeClean({ vault: s.vault, local: s.local, clone });
    expect(await check()).toBe(true);
    mkdirSync(join(clone, '.agflow', 'run'), { recursive: true });
    writeFileSync(join(clone, '.agflow', 'run', 'brief.md'), 'brief\n');
    expect(await check()).toBe(true);
    writeFileSync(join(clone, 'src', 'app.ts'), 'changed\n');
    expect(await check()).toBe(false);
    writeFileSync(join(clone, 'src', 'app.ts'), 'app\n');
    expect(await check()).toBe(true);
    writeFileSync(join(clone, 'new.txt'), 'untracked\n');
    expect(await check()).toBe(false);
    rmSync(join(clone, 'new.txt'));
    rmSync(join(clone, 'README.md'));
    expect(await check()).toBe(false);
  });

  test('a HEAD the vault does not hold yet is not clean', async () => {
    const s = await setup();
    const clone = await taskClone(s);
    writeFileSync(join(clone, 'local.txt'), 'local\n');
    await gitIn(clone, ['add', '-A']);
    await gitIn(clone, ['commit', '-q', '-m', 'local work']);
    expect(await isWorktreeClean({ vault: s.vault, local: s.local, clone })).toBe(false);
  });
});

describe('fastForwardLeadClone', () => {
  test("moves a clean lead clone to the vault's newer main; git status in the clone is clean there", async () => {
    const s = await setup();
    const { clone } = await leadClone(s);
    const newer = await commitFiles(s.repo.path, {
      branch: 'main',
      files: { 'src/app.ts': 'app v2\n', 'README.md': null, 'docs/new.md': 'new\n' },
    });
    expect(await fastForwardLeadClone({ vault: s.vault, local: s.local, attemptId: 'lead-a1', clone })).toEqual({
      moved: false,
      reason: 'up_to_date',
      sha: s.repo.mainSha,
    });
    await s.fetch({ ref: 'refs/heads/main', sha: null });
    expect(await fastForwardLeadClone({ vault: s.vault, local: s.local, attemptId: 'lead-a1', clone })).toEqual({
      moved: true,
      from: s.repo.mainSha,
      to: newer,
    });
    expect(readFileSync(join(clone, '.git', 'HEAD'), 'utf8').trim()).toBe(newer);
    expect(await gitIn(clone, ['rev-parse', 'HEAD'])).toBe(newer);
    expect(await gitIn(clone, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
    expect(readFileSync(join(clone, 'src', 'app.ts'), 'utf8')).toBe('app v2\n');
    expect(readFileSync(join(clone, 'docs', 'new.md'), 'utf8')).toBe('new\n');
    expect(existsSync(join(clone, 'README.md'))).toBe(false);
    expect(await s.git(['rev-parse', localPinRefs('lead-a1').start])).toBe(newer);
  });

  test('leaves a dirty clone as it is and reports it', async () => {
    const s = await setup();
    const { clone } = await leadClone(s);
    await commitFiles(s.repo.path, { branch: 'main', files: { 'src/app.ts': 'app v2\n' } });
    await s.fetch({ ref: 'refs/heads/main', sha: null });
    writeFileSync(join(clone, 'notes.md'), 'lead notes\n');
    expect(await fastForwardLeadClone({ vault: s.vault, local: s.local, attemptId: 'lead-a1', clone })).toEqual({
      moved: false,
      reason: 'dirty',
      sha: s.repo.mainSha,
    });
    expect(readFileSync(join(clone, '.git', 'HEAD'), 'utf8').trim()).toBe(s.repo.mainSha);
    expect(readFileSync(join(clone, 'src', 'app.ts'), 'utf8')).toBe('app\n');
  });

  test('leaves a clone whose HEAD the vault cannot fast-forward', async () => {
    const s = await setup();
    const { clone } = await leadClone(s);
    writeFileSync(join(clone, 'notes.md'), 'lead notes\n');
    await gitIn(clone, ['add', '-A']);
    await gitIn(clone, ['commit', '-q', '-m', 'lead commit']);
    const local = await gitIn(clone, ['rev-parse', 'HEAD']);
    await commitFiles(s.repo.path, { branch: 'main', files: { 'src/app.ts': 'app v2\n' } });
    await s.fetch({ ref: 'refs/heads/main', sha: null });
    expect(await fastForwardLeadClone({ vault: s.vault, local: s.local, attemptId: 'lead-a1', clone })).toEqual({
      moved: false,
      reason: 'not_fast_forward',
      sha: local,
    });
  });
});


describe('fastForwardLeadClone and HEAD', () => {
  const forward = (s: Awaited<ReturnType<typeof setup>>, clone: string) =>
    fastForwardLeadClone({ vault: s.vault, local: s.local, attemptId: 'lead-a1', clone });

  test('leaves a clone whose HEAD names a branch of the lead\'s own', async () => {
    const s = await setup();
    const { clone } = await leadClone(s);
    await commitFiles(s.repo.path, { branch: 'main', files: { 'src/app.ts': 'app v2\n' } });
    await s.fetch({ ref: 'refs/heads/main', sha: null });
    await gitIn(clone, ['switch', '--quiet', '-c', 'lead-notes']);
    expect(await forward(s, clone)).toEqual({ moved: false, reason: 'not_fast_forward', sha: s.repo.mainSha });
    expect(readFileSync(join(clone, '.git', 'HEAD'), 'utf8')).toBe('ref: refs/heads/lead-notes\n');
    expect(readFileSync(join(clone, 'src', 'app.ts'), 'utf8')).toBe('app\n');
  });

  test('leaves a clone detached at a commit the vault holds when main no longer descends from it', async () => {
    const s = await setup();
    const { clone } = await leadClone(s);
    const newer = await commitFiles(s.repo.path, { branch: 'main', files: { 'src/app.ts': 'app v2\n' } });
    await s.fetch({ ref: 'refs/heads/main', sha: null });
    expect((await forward(s, clone)).moved).toBe(true);
    // Origin's main is rewound to a sibling of the commit the clone is at.
    const sibling = await commitFiles(s.repo.path, {
      branch: 'sibling',
      from: s.repo.mainSha,
      files: { 'other.txt': 'other\n' },
    });
    await gitIn(s.repo.path, ['update-ref', 'refs/heads/main', sibling]);
    await s.fetch({ ref: 'refs/heads/main', sha: null });
    expect(await forward(s, clone)).toEqual({ moved: false, reason: 'not_fast_forward', sha: newer });
    expect(readFileSync(join(clone, '.git', 'HEAD'), 'utf8').trim()).toBe(newer);
  });

  test('finishes a move cut short after the files changed, before .git/HEAD and .git/index were written', async () => {
    const s = await setup();
    const { clone } = await leadClone(s);
    const newer = await commitFiles(s.repo.path, { branch: 'main', files: { 'src/app.ts': 'app v2\n' } });
    await s.fetch({ ref: 'refs/heads/main', sha: null });
    // The runner's own move, through the vault and a temporary index, as a crash right after it leaves it.
    const index = join(tempDir('agflow-index-'), 'index');
    const git = (args: string[]) =>
      runGit(s.local, [`--git-dir=${s.vault.path}`, `--work-tree=${clone}`, ...args], {
        cwd: clone,
        env: { GIT_INDEX_FILE: index },
      });
    await git(['read-tree', s.repo.mainSha]);
    await git(['update-index', '-q', '--refresh']);
    await git(['read-tree', '-m', '-u', s.repo.mainSha, newer]);
    expect(readFileSync(join(clone, 'src', 'app.ts'), 'utf8')).toBe('app v2\n');
    expect(readFileSync(join(clone, '.git', 'HEAD'), 'utf8').trim()).toBe(s.repo.mainSha);
    expect(await forward(s, clone)).toEqual({ moved: true, from: s.repo.mainSha, to: newer });
    expect(readFileSync(join(clone, '.git', 'HEAD'), 'utf8').trim()).toBe(newer);
    expect(await gitIn(clone, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
    expect(await s.git(['rev-parse', localPinRefs('lead-a1').start])).toBe(newer);
  });
});

describe("the clone's .git, which the agent controls", () => {
  test('a symlinked HEAD is refused, never followed', async () => {
    const s = await setup();
    const clone = await taskClone(s);
    const outside = join(tempDir('agflow-outside-'), 'HEAD');
    writeFileSync(outside, `${s.repo.mainSha}\n`);
    rmSync(join(clone, '.git', 'HEAD'));
    symlinkSync(outside, join(clone, '.git', 'HEAD'));
    await expect(readCloneHead(clone)).rejects.toThrow(/symbolic link/);
    await expect(isWorktreeClean({ vault: s.vault, local: s.local, clone })).rejects.toThrow(/symbolic link/);
  });

  test('a symlinked directory on the way to a ref is refused', async () => {
    const s = await setup();
    const clone = await taskClone(s);
    const outside = join(tempDir('agflow-outside-'), 'agflow');
    renameSync(join(clone, '.git', 'refs', 'heads', 'agflow'), outside);
    expect(existsSync(join(outside, 'T-4-tidy'))).toBe(true);
    symlinkSync(outside, join(clone, '.git', 'refs', 'heads', 'agflow'));
    await expect(readCloneRef(clone, `refs/heads/${BRANCH}`)).rejects.toThrow(/not a directory/);
  });

  test('a .git that is a link is refused', async () => {
    const s = await setup();
    const clone = await taskClone(s);
    const elsewhere = join(tempDir('agflow-outside-'), 'git');
    renameSync(join(clone, '.git'), elsewhere);
    symlinkSync(elsewhere, join(clone, '.git'));
    await expect(readCloneHead(clone)).rejects.toThrow(/not a directory/);
  });

  test('a FIFO at .git/HEAD is refused without blocking', async () => {
    const s = await setup();
    const clone = await taskClone(s);
    rmSync(join(clone, '.git', 'HEAD'));
    expect(Bun.spawnSync(['mkfifo', join(clone, '.git', 'HEAD')]).exitCode).toBe(0);
    await expect(readCloneHead(clone)).rejects.toThrow(/not a regular file/);
  });

  test('a packed-refs file over 16 MiB is refused', async () => {
    const s = await setup();
    const clone = await taskClone(s);
    rmSync(join(clone, '.git', 'refs', 'heads', 'agflow', 'T-4-tidy'));
    const packed = join(clone, '.git', 'packed-refs');
    writeFileSync(packed, '');
    truncateSync(packed, 16 * 1024 * 1024 + 1);
    await expect(readCloneRef(clone, `refs/heads/${BRANCH}`)).rejects.toThrow(/larger than/);
  });

  test('a file that grows while it is read is refused', async () => {
    const path = join(tempDir('agflow-growing-'), 'HEAD');
    writeFileSync(path, 'abc\n');
    const handle = await open(path, 'r');
    try {
      const { size } = await handle.stat();
      appendFileSync(path, 'x'.repeat(64 * 1024));
      await expect(readSized(handle, size, path)).rejects.toThrow(/changed while it was read/);
      expect(await readSized(handle, size + 64 * 1024, path)).toHaveLength(size + 64 * 1024);
    } finally {
      await handle.close();
    }
  });

  test('a link planted at .git/index is replaced, not written through', async () => {
    const s = await setup();
    const { clone } = await leadClone(s);
    const outside = join(tempDir('agflow-outside-'), 'precious');
    writeFileSync(outside, 'precious\n');
    rmSync(join(clone, '.git', 'index'));
    symlinkSync(outside, join(clone, '.git', 'index'));
    await commitFiles(s.repo.path, { branch: 'main', files: { 'src/app.ts': 'app v2\n' } });
    await s.fetch({ ref: 'refs/heads/main', sha: null });
    const result = await fastForwardLeadClone({ vault: s.vault, local: s.local, attemptId: 'lead-a1', clone });
    expect(result.moved).toBe(true);
    expect(readFileSync(outside, 'utf8')).toBe('precious\n');
    expect(lstatSync(join(clone, '.git', 'index')).isFile()).toBe(true);
    expect(await gitIn(clone, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
  });
});

describe("the clone's own git configuration", () => {
  const files = { 'README.md': '# demo\n', 'src/app.ts': 'app\n', '.gitattributes': PLANTED_ATTRIBUTES };

  test('runs for neither the clean check nor the fast-forward', async () => {
    const s = await setup(files);
    const { clone } = await leadClone(s);
    const planted = plantCloneConfig(clone, tempDir('agflow-planted-'));
    await commitFiles(s.repo.path, { branch: 'main', files: { 'src/app.ts': 'app v2\n' } });
    await s.fetch({ ref: 'refs/heads/main', sha: null });
    touchLater(join(clone, 'README.md'));
    touchLater(join(clone, 'src', 'app.ts'));
    expect(await isWorktreeClean({ vault: s.vault, local: s.local, clone })).toBe(true);
    const result = await fastForwardLeadClone({ vault: s.vault, local: s.local, attemptId: 'lead-a1', clone });
    expect(result.moved).toBe(true);
    expect(planted.fired()).toBe(false);
    await planted.proveLive('README.md');
  });

  test('an unparseable config stops neither the clean check nor the fast-forward', async () => {
    const s = await setup();
    const { clone } = await leadClone(s);
    appendFileSync(join(clone, '.git', 'config'), '[core\n\tbroken\n');
    expect(await gitIn(clone, ['status'], { allowFailure: true })).toBe('');
    await commitFiles(s.repo.path, { branch: 'main', files: { 'src/app.ts': 'app v2\n' } });
    await s.fetch({ ref: 'refs/heads/main', sha: null });
    expect(await isWorktreeClean({ vault: s.vault, local: s.local, clone })).toBe(true);
    const result = await fastForwardLeadClone({ vault: s.vault, local: s.local, attemptId: 'lead-a1', clone });
    expect(result.moved).toBe(true);
  });

  test("a committed gitlink over a nested repository runs none of the nested repository's config", async () => {
    const s = await setup();
    const clone = await taskClone(s);
    const marker = join(tempDir('agflow-nested-'), 'fired');
    const sub = join(clone, 'sub');
    mkdirSync(sub);
    await gitIn(sub, ['init', '--quiet']);
    writeFileSync(join(sub, 'f.txt'), 'nested\n');
    writeFileSync(join(sub, '.gitattributes'), '* filter=x\n');
    await gitIn(sub, ['add', '-A']);
    await gitIn(sub, ['commit', '--quiet', '-m', 'nested']);
    await gitIn(clone, ['add', 'sub']);
    await gitIn(clone, ['commit', '--quiet', '-m', 'a gitlink']);
    appendFileSync(join(sub, '.git', 'config'), `[filter "x"]\n\tclean = "cat; echo clean >> '${marker}'"\n`);
    await harvestCommits({
      vault: s.vault,
      local: s.local,
      paths: s.paths,
      clone,
      attemptId: 'T-4-a1',
      branch: BRANCH,
    });
    touchLater(join(sub, 'f.txt'));
    expect(await isWorktreeClean({ vault: s.vault, local: s.local, clone })).toBe(true);
    expect(existsSync(marker)).toBe(false);
    // The plant is live: git status in the clone looks into the nested repository and runs its filter.
    await gitIn(clone, ['status']);
    expect(existsSync(marker)).toBe(true);
  });

  test("a gitlink on main over a repository the lead faked runs none of that repository's config", async () => {
    const s = await setup();
    const work = tempDir('agflow-gitlink-');
    await gitIn(work, ['clone', '--quiet', s.repo.path, '.']);
    const linked = '1234567890abcdef1234567890abcdef12345678';
    await gitIn(work, ['update-index', '--add', '--cacheinfo', `160000,${linked},lib`]);
    await gitIn(work, ['commit', '--quiet', '-m', 'a gitlink on main']);
    await gitIn(work, ['push', '--quiet', 'origin', 'HEAD:refs/heads/main']);
    const withLink = await gitIn(work, ['rev-parse', 'HEAD']);
    const { clone } = await leadClone(s, withLink);
    const lib = join(clone, 'lib');
    mkdirSync(lib, { recursive: true });
    await gitIn(lib, ['init', '--quiet']);
    writeFileSync(join(lib, 'f.txt'), 'faked\n');
    writeFileSync(join(lib, '.gitattributes'), '* filter=x\n');
    await gitIn(lib, ['add', '-A']);
    writeFileSync(join(lib, '.git', 'HEAD'), `${linked}\n`);
    const marker = join(tempDir('agflow-nested-'), 'fired');
    appendFileSync(join(lib, '.git', 'config'), `[filter "x"]\n\tclean = "cat; echo clean >> '${marker}'"\n`);
    touchLater(join(lib, 'f.txt'));
    const newer = await commitFiles(s.repo.path, { branch: 'main', files: { 'src/app.ts': 'app v2\n' } });
    await s.fetch({ ref: 'refs/heads/main', sha: null });
    const result = await fastForwardLeadClone({ vault: s.vault, local: s.local, attemptId: 'lead-a1', clone });
    expect(existsSync(marker)).toBe(false);
    expect(result).toEqual({ moved: true, from: withLink, to: newer });
  });
});
