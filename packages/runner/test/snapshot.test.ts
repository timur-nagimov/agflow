import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gitIn, originRepo } from '@agflow/testkit';
import { createTaskClone } from '../src/git/clone';
import { HarvestError, harvestCommits } from '../src/git/harvest';
import { ensureRunnerGitFiles, localGitEnv, remoteGitEnv, runGit } from '../src/git/run';
import { SNAPSHOT_FILE_LIMIT_BYTES, snapshotWork } from '../src/git/snapshot';
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
const ATTEMPT = 'T-4-a1';
const IDENTITY = { name: 'agflow runner', email: 'runner@agflow.invalid' };
const NOW = new Date('2026-10-30T09:00:00.000Z');

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const BASE_FILES = {
  'README.md': '# demo\n',
  'src/app.ts': 'app\n',
  'docs/old.md': 'old\n',
  '.gitignore': 'build/\n*.log\n',
};

/** A vault and a task clone at main, made as the runner makes them. */
async function setup(files: Record<string, string> = BASE_FILES) {
  const repo = await originRepo(files);
  cleanups.push(() => repo.remove());
  const paths = runnerPaths(tempDir('agflow-snapshot-'));
  ensureRunnerGitFiles(paths);
  const home = tempDir('agflow-owner-');
  const vault = new Vault({
    paths,
    project: PROJECT,
    repo: { url: repo.path, mainBranch: 'main' },
    remote: () => remoteGitEnv({ base: { ...process.env, HOME: home, XDG_CONFIG_HOME: undefined } }),
  });
  await vault.ensure();
  await vault.fetchForAttempt({ taskId: 'T-4', start: { ref: 'refs/heads/main', sha: null } }, PREFIX);
  const local = localGitEnv(paths);
  const clone = paths.clone(PROJECT, ATTEMPT);
  await createTaskClone({ vault, local, attemptId: ATTEMPT, clone, branch: BRANCH, startSha: repo.mainSha });
  const git = async (args: string[]) => (await runGit(local, [`--git-dir=${vault.path}`, ...args])).stdout;
  const harvest = async () =>
    (await harvestCommits({ vault, local, paths, clone, attemptId: ATTEMPT, branch: BRANCH })).head;
  const snapshot = (head: string, limitBytes?: number, more: Partial<Parameters<typeof snapshotWork>[0]> = {}) =>
    snapshotWork({ vault, local, clone, head, identity: IDENTITY, now: NOW, limitBytes, ...more });
  /** Every entry of a commit's tree: mode and path. */
  const tree = async (sha: string) =>
    (await git(['ls-tree', '-r', '-z', '--full-tree', sha]))
      .split('\0')
      .filter((line) => line !== '')
      .map((line) => `${line.slice(0, 6)} ${line.slice(line.indexOf('\t') + 1)}`);
  const show = async (sha: string, path: string) => git(['cat-file', 'blob', `${sha}:${path}`]);
  return { repo, vault, local, paths, clone, git, harvest, snapshot, tree, show };
}

function write(clone: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(clone, path)), { recursive: true });
    writeFileSync(join(clone, path), content);
  }
}

describe('snapshotWork', () => {
  test('modified, staged, deleted and untracked files become one commit on the harvested head', async () => {
    const s = await setup();
    write(s.clone, { 'a.txt': 'committed\n' });
    await gitIn(s.clone, ['add', '-A']);
    await gitIn(s.clone, ['commit', '--quiet', '-m', 'agent work']);
    const head = await s.harvest();
    write(s.clone, { 'src/app.ts': 'app v2\n', 'staged.txt': 'staged\n', 'notes/n.md': 'untracked\n' });
    await gitIn(s.clone, ['add', 'staged.txt']);
    rmSync(join(s.clone, 'docs', 'old.md'));
    const status = await gitIn(s.clone, ['status', '--porcelain']);
    const result = await s.snapshot(head);
    expect(result).toEqual({ sha: expect.stringMatching(/^[0-9a-f]{40}$/), changed: true, skipped: [], embedded: [] });
    expect((await s.git(['log', '-1', '--format=%P|%an <%ae>|%cn <%ce>|%s|%at', result.sha])).trim()).toBe(
      `${head}|agflow runner <runner@agflow.invalid>|agflow runner <runner@agflow.invalid>|` +
        `agflow: uncommitted work at 2026-10-30T09:00:00.000Z|${NOW.getTime() / 1000}`,
    );
    expect(await s.tree(result.sha)).toEqual([
      '100644 .gitignore',
      '100644 README.md',
      '100644 a.txt',
      '100644 notes/n.md',
      '100644 src/app.ts',
      '100644 staged.txt',
    ]);
    expect(await s.show(result.sha, 'src/app.ts')).toBe('app v2\n');
    // The clone is untouched: its own index and files are as the agent left them.
    expect(await gitIn(s.clone, ['status', '--porcelain'])).toBe(status);
  });

  test('a clean clone gives the head itself', async () => {
    const s = await setup();
    expect(await s.snapshot(s.repo.mainSha)).toEqual({
      sha: s.repo.mainSha,
      changed: false,
      skipped: [],
      embedded: [],
    });
  });

  test('.agflow/run/ and ignored files are left out; a symlink is stored as a link, never followed', async () => {
    const s = await setup();
    const outside = join(tempDir('agflow-outside-'), 'secret.txt');
    writeFileSync(outside, 'secret\n');
    write(s.clone, {
      '.agflow/run/task.md': '# T-4\n',
      'build/out.js': 'built\n',
      'debug.log': 'log\n',
      '.claude/.cc-writes/staged': 'cli staging\n',
      'kept.txt': 'kept\n',
    });
    symlinkSync(outside, join(s.clone, 'link'));
    const fifo = join(tempDir('agflow-outside-'), 'fifo');
    expect(Bun.spawnSync(['mkfifo', fifo]).exitCode).toBe(0);
    symlinkSync(fifo, join(s.clone, 'to-fifo'));
    const result = await s.snapshot(s.repo.mainSha);
    expect(await s.tree(result.sha)).toEqual([
      '100644 .gitignore',
      '100644 README.md',
      '100644 docs/old.md',
      '100644 kept.txt',
      '120000 link',
      '100644 src/app.ts',
      '120000 to-fifo',
    ]);
    expect(await s.show(result.sha, 'link')).toBe(outside);
  });

  test('a file over 10 MB is skipped and listed, and the rest is still captured', async () => {
    const s = await setup();
    write(s.clone, {
      'big.bin': 'x'.repeat(SNAPSHOT_FILE_LIMIT_BYTES + 1),
      'src/app.ts': 'y'.repeat(SNAPSHOT_FILE_LIMIT_BYTES + 1),
      'at-limit.bin': 'z'.repeat(SNAPSHOT_FILE_LIMIT_BYTES),
      'small.txt': 'small\n',
    });
    const result = await s.snapshot(s.repo.mainSha);
    expect(result.skipped).toEqual(['big.bin', 'src/app.ts']);
    expect(await s.tree(result.sha)).toEqual([
      '100644 .gitignore',
      '100644 README.md',
      '100644 at-limit.bin',
      '100644 docs/old.md',
      '100644 small.txt',
      '100644 src/app.ts',
    ]);
    // A tracked file over the limit keeps the head's version.
    expect(await s.show(result.sha, 'src/app.ts')).toBe('app\n');
  });

  test('embedded repositories become ordinary files under their paths, honouring their .gitignore', async () => {
    const s = await setup();
    const sub = join(s.clone, 'sub');
    mkdirSync(sub);
    await gitIn(sub, ['init', '--quiet']);
    write(sub, { 's.txt': 's\n', '.gitignore': 'ignored.txt\n', 'ignored.txt': 'ignored\n' });
    await gitIn(sub, ['add', '-A']);
    await gitIn(sub, ['commit', '--quiet', '-m', 'nested']);
    write(sub, { 'uncommitted.txt': 'nested work\n' });
    const deeper = join(sub, 'deeper');
    mkdirSync(deeper);
    await gitIn(deeper, ['init', '--quiet']);
    write(deeper, { 'd.txt': 'd\n' });
    // A .git file, as a submodule or a linked worktree has.
    const separate = join(tempDir('agflow-separate-'), 'lib.git');
    mkdirSync(join(s.clone, 'vendor'));
    await gitIn(join(s.clone, 'vendor'), ['init', '--quiet', `--separate-git-dir=${separate}`, 'lib']);
    write(s.clone, { 'vendor/lib/f.txt': 'f\n', 'plain.txt': 'plain\n' });
    const result = await s.snapshot(s.repo.mainSha);
    expect(result.embedded).toEqual(['sub', 'sub/deeper', 'vendor/lib']);
    expect(await s.tree(result.sha)).toEqual([
      '100644 .gitignore',
      '100644 README.md',
      '100644 docs/old.md',
      '100644 plain.txt',
      '100644 src/app.ts',
      '100644 sub/.gitignore',
      '100644 sub/deeper/d.txt',
      '100644 sub/s.txt',
      '100644 sub/uncommitted.txt',
      '100644 vendor/lib/f.txt',
    ]);
  });

  test('a tracked directory replaced by a link is stored as the link, without the files it held', async () => {
    const s = await setup();
    const shared = tempDir('agflow-shared-');
    writeFileSync(join(shared, 'app.ts'), 'outside\n');
    rmSync(join(s.clone, 'src'), { recursive: true });
    symlinkSync(shared, join(s.clone, 'src'));
    const result = await s.snapshot(s.repo.mainSha);
    expect(await s.tree(result.sha)).toEqual(['100644 .gitignore', '100644 README.md', '100644 docs/old.md', '120000 src']);
    expect(await s.show(result.sha, 'src')).toBe(shared);
  });

  test('an embedded repository swapped for a link after it was listed gives nothing from outside the clone', async () => {
    const s = await setup();
    const sub = join(s.clone, 'sub');
    mkdirSync(sub);
    await gitIn(sub, ['init', '--quiet']);
    write(sub, { 's.txt': 's\n', 'id_ed25519': 'not the key\n' });
    const outside = tempDir('agflow-outside-');
    writeFileSync(join(outside, 's.txt'), 'outside\n');
    writeFileSync(join(outside, 'id_ed25519'), 'PRIVATE KEY\n');
    const result = await s.snapshot(s.repo.mainSha, undefined, {
      afterListing: async () => {
        renameSync(sub, join(s.clone, 'sub.moved'));
        symlinkSync(outside, sub);
      },
    });
    const entries = await s.tree(result.sha);
    expect(entries.filter((entry) => entry.includes(' sub/'))).toEqual([]);
    expect(entries).not.toContain('120000 sub');
  });

  test("an embedded .agflow repository is captured without the runner's .agflow/run/", async () => {
    const s = await setup();
    const agflow = join(s.clone, '.agflow');
    mkdirSync(agflow);
    await gitIn(agflow, ['init', '--quiet']);
    write(s.clone, {
      '.agflow/notes.md': 'agent notes\n',
      '.agflow/run/task.md': '# T-4\n',
      '.agflow/run/config/hook.log': 'log\n',
      '.agflow/run/cache/npm/blob': 'cached\n',
    });
    const result = await s.snapshot(s.repo.mainSha);
    expect(result.embedded).toEqual(['.agflow']);
    expect((await s.tree(result.sha)).filter((entry) => entry.includes('.agflow'))).toEqual(['100644 .agflow/notes.md']);
  });

  test('a tracked file under .agflow/run/ is never captured', async () => {
    const s = await setup();
    write(s.clone, { '.agflow/run/task.md': '# agent copy\n' });
    await gitIn(s.clone, ['add', '-f', '.agflow/run/task.md']);
    await gitIn(s.clone, ['commit', '--quiet', '-m', 'agent adds a runner file']);
    const head = await s.harvest();
    write(s.clone, { '.agflow/run/task.md': '# T-4, as the runner writes it\n' });
    expect(await s.snapshot(head)).toEqual({ sha: head, changed: false, skipped: [], embedded: [] });
  });

  test('files swapped for links to a file outside the clone, again and again, never give the outside bytes', async () => {
    const s = await setup();
    const secret = 'SECRET-KEY-MATERIAL-0123456789ab';
    const outside = join(tempDir('agflow-outside-'), 'id_ed25519');
    writeFileSync(outside, `${secret}\n`);
    // A process the runner never recorded keeps renaming 32-byte files and links to the outside file into place.
    const swapper = Bun.spawn(
      [
        process.execPath,
        '-e',
        `const fs = require('node:fs');
        const [clone, outside] = process.argv.slice(1);
        for (let i = 0; ; i = (i + 1) % 100) {
          const decoy = clone + '/decoys/' + i;
          fs.mkdirSync(clone + '/decoys', { recursive: true });
          fs.writeFileSync(clone + '/.decoy-file', 'decoy-decoy-decoy-decoy-decoy-32');
          fs.renameSync(clone + '/.decoy-file', decoy);
          fs.rmSync(clone + '/.decoy-link', { force: true });
          fs.symlinkSync(outside, clone + '/.decoy-link');
          fs.renameSync(clone + '/.decoy-link', decoy);
        }`,
        s.clone,
        outside,
      ],
      { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
    );
    cleanups.push(() => {
      swapper.kill('SIGKILL');
    });
    await Bun.sleep(200);
    let links = 0;
    // Every decoy holds the same bytes, so each blob is read once: the test stays quick on a loaded machine.
    const read = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const result = await s.snapshot(s.repo.mainSha).catch((error: unknown) => {
        // A swap between the listing and the read may fail a snapshot; it never leaks.
        if (error instanceof HarvestError) return null;
        throw error;
      });
      if (result === null) continue;
      const blobs = await s.git(['ls-tree', '-r', '-z', '--full-tree', result.sha]);
      for (const line of blobs.split('\0').filter((entry) => entry !== '')) {
        const [mode, , sha] = line.slice(0, line.indexOf('\t')).split(' ') as [string, string, string];
        if (mode === '120000') links += 1;
        if (read.has(sha)) continue;
        read.add(sha);
        expect(await s.git(['cat-file', 'blob', sha])).not.toContain(secret);
      }
    }
    swapper.kill('SIGKILL');
    // The race was on: snapshots met the links.
    expect(links).toBeGreaterThan(0);
  }, 60_000);

  test('a FIFO where git probes for a repository fails the snapshot within its bound', async () => {
    const s = await setup();
    mkdirSync(join(s.clone, 'trap', '.git', 'objects'), { recursive: true });
    mkdirSync(join(s.clone, 'trap', '.git', 'refs'), { recursive: true });
    expect(Bun.spawnSync(['mkfifo', join(s.clone, 'trap', '.git', 'HEAD')]).exitCode).toBe(0);
    write(s.clone, { 'trap/f.txt': 'f\n' });
    const started = Date.now();
    await expect(s.snapshot(s.repo.mainSha, undefined, { timeoutMs: 1_000 })).rejects.toBeInstanceOf(HarvestError);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  test("runs none of the clone's config, nor that of a repository nested in it", async () => {
    const s = await setup({ ...BASE_FILES, '.gitattributes': PLANTED_ATTRIBUTES });
    const nestedMarker = join(tempDir('agflow-nested-'), 'fired');
    const nestedFilter = `[filter "x"]\n\tclean = "cat; echo clean >> '${nestedMarker}'"\n`;
    // A committed gitlink over a nested repository, and an untracked one, each with a filter of its own.
    for (const name of ['linked', 'loose']) {
      const dir = join(s.clone, name);
      mkdirSync(dir);
      await gitIn(dir, ['init', '--quiet']);
      write(dir, { 'f.txt': `${name}\n`, '.gitattributes': '* filter=x\n' });
      await gitIn(dir, ['add', '-A']);
      await gitIn(dir, ['commit', '--quiet', '-m', 'nested']);
    }
    await gitIn(s.clone, ['add', 'linked']);
    await gitIn(s.clone, ['commit', '--quiet', '-m', 'a gitlink']);
    const head = await s.harvest();
    for (const name of ['linked', 'loose']) {
      appendFileSync(join(s.clone, name, '.git', 'config'), nestedFilter);
      touchLater(join(s.clone, name, 'f.txt'));
    }
    const planted = plantCloneConfig(s.clone, tempDir('agflow-planted-'));
    write(s.clone, { 'src/app.ts': 'app v2\n', 'new.txt': 'new\n' });
    touchLater(join(s.clone, 'README.md'));
    const result = await s.snapshot(head);
    expect(planted.fired()).toBe(false);
    expect(await Bun.file(nestedMarker).exists()).toBe(false);
    expect(result.embedded).toEqual(['loose']);
    const entries = await s.tree(result.sha);
    expect(entries).toContain('160000 linked');
    expect(entries).toContain('100644 loose/f.txt');
    expect(await s.show(result.sha, 'src/app.ts')).toBe('app v2\n');
    await planted.proveLive('README.md');
  });
});
