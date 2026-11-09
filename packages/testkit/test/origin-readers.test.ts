import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cloneTo,
  commitFiles,
  fileAt,
  gitIn,
  isAncestor,
  type OriginRepo,
  originRepo,
  refSha,
} from '../src/git-fixtures';

const origins: OriginRepo[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const origin of origins.splice(0)) origin.remove();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function origin(files: Record<string, string>): Promise<OriginRepo> {
  const made = await originRepo(files);
  origins.push(made);
  return made;
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agflow-readers-'));
  dirs.push(dir);
  return dir;
}

describe('refSha', () => {
  test("gives a ref's sha, by full or short name, and null for a missing ref", async () => {
    const repo = await origin({ 'a.txt': 'a\n' });
    const wip = await commitFiles(repo.path, { branch: 'agflow/T-1-feature', files: { 'b.txt': 'b\n' } });
    await gitIn(repo.path, ['update-ref', 'refs/agflow/wip/T-1-a1', wip]);
    expect(await refSha(repo.path, 'refs/heads/main')).toBe(repo.mainSha);
    expect(await refSha(repo.path, 'main')).toBe(repo.mainSha);
    expect(await refSha(repo.path, 'agflow/T-1-feature')).toBe(wip);
    expect(await refSha(repo.path, 'refs/agflow/wip/T-1-a1')).toBe(wip);
    expect(await refSha(repo.path, 'refs/agflow/wip/T-1-a2')).toBeNull();
    expect(await refSha(repo.path, 'refs/heads/missing')).toBeNull();
  });
});

describe('fileAt', () => {
  test('reads a file at a commit or ref exactly, and gives null for a missing file or revision', async () => {
    const repo = await origin({ 'a.txt': 'first\n\n', 'dir/b.txt': 'b' });
    const next = await commitFiles(repo.path, { branch: 'main', files: { 'a.txt': 'second\n', 'dir/b.txt': null } });
    expect(await fileAt(repo.path, repo.mainSha, 'a.txt')).toBe('first\n\n');
    expect(await fileAt(repo.path, repo.mainSha, 'dir/b.txt')).toBe('b');
    expect(await fileAt(repo.path, 'main', 'a.txt')).toBe('second\n');
    expect(await fileAt(repo.path, next, 'dir/b.txt')).toBeNull();
    expect(await fileAt(repo.path, 'refs/heads/missing', 'a.txt')).toBeNull();
    expect(await fileAt(repo.path, repo.mainSha, 'dir')).toBeNull();
  });
});

describe('isAncestor', () => {
  test('answers for two commits', async () => {
    const repo = await origin({ 'a.txt': 'a\n' });
    const topic = await commitFiles(repo.path, { branch: 'topic', files: { 'b.txt': 'b\n' } });
    const other = await commitFiles(repo.path, { branch: 'other', files: { 'c.txt': 'c\n' } });
    expect(await isAncestor(repo.path, repo.mainSha, topic)).toBe(true);
    expect(await isAncestor(repo.path, topic, topic)).toBe(true);
    expect(await isAncestor(repo.path, topic, repo.mainSha)).toBe(false);
    expect(await isAncestor(repo.path, topic, other)).toBe(false);
    await expect(isAncestor(repo.path, topic, 'f'.repeat(40))).rejects.toThrow(/merge-base/);
  });
});

describe('cloneTo', () => {
  test('makes a working clone that can commit and push back with plain git', async () => {
    const repo = await origin({ 'a.txt': 'a\n' });
    const work = join(tempDir(), 'person');
    expect(await cloneTo(repo.path, work)).toBe(work);
    expect(await Bun.file(join(work, 'a.txt')).text()).toBe('a\n');
    writeFileSync(join(work, 'b.txt'), 'b\n');
    // Plain git, as a person's terminal would run it: the clone carries its own identity.
    const git = (args: string[]) =>
      Bun.spawnSync(['git', ...args], {
        cwd: work,
        env: { PATH: process.env.PATH, HOME: tempDir(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
        stdout: 'pipe',
        stderr: 'pipe',
      });
    expect(git(['add', 'b.txt']).exitCode).toBe(0);
    expect(git(['commit', '--quiet', '-m', 'add b']).exitCode).toBe(0);
    expect(git(['push', '--quiet', 'origin', 'HEAD:refs/heads/person']).exitCode).toBe(0);
    const pushed = (await refSha(repo.path, 'refs/heads/person')) as string;
    expect(await fileAt(repo.path, pushed, 'b.txt')).toBe('b\n');
    expect(await isAncestor(repo.path, repo.mainSha, pushed)).toBe(true);
  });

  test('checks out a given branch', async () => {
    const repo = await origin({ 'a.txt': 'a\n' });
    const topic = await commitFiles(repo.path, { branch: 'agflow/T-2-x', files: { 'c.txt': 'c\n' } });
    const work = join(tempDir(), 'clone');
    await cloneTo(repo.path, work, { branch: 'agflow/T-2-x' });
    expect(await gitIn(work, ['rev-parse', 'HEAD'])).toBe(topic);
    expect(await gitIn(work, ['symbolic-ref', '--short', 'HEAD'])).toBe('agflow/T-2-x');
    expect(existsSync(join(work, 'c.txt'))).toBe(true);
  });
});
