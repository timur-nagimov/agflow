import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SavePathError, checkSavePath, saveInside } from '../src/mcp/save-download';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A working directory with a .git and a .agflow, and a directory next to it that nothing may write into. */
function workdir() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'agflow-save-')));
  made.push(base);
  const root = join(base, 'clone');
  const outside = join(base, 'outside');
  mkdirSync(join(root, '.git', 'hooks'), { recursive: true });
  mkdirSync(join(root, '.agflow', 'run'), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(outside, 'victim'), 'untouched');
  return { base, root, outside };
}

const bytes = (text: string) => new TextEncoder().encode(text);
/** Every file under a directory, relative to it. */
const filesUnder = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => !entry.isDirectory())
    .map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1))
    .sort();

const refusal = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    if (error instanceof SavePathError) return error.message;
    throw error;
  }
  return 'accepted';
};

describe('where a download may be saved', () => {
  test('a relative, normalized path is accepted as its segments', () => {
    expect(checkSavePath('prices.csv')).toEqual(['prices.csv']);
    expect(checkSavePath('data/raw/2026/prices.csv')).toEqual(['data', 'raw', '2026', 'prices.csv']);
    expect(checkSavePath('docs/Über uns.html')).toEqual(['docs', 'Über uns.html']);
    expect(checkSavePath('.github-data/x.json')).toEqual(['.github-data', 'x.json']);
    expect(checkSavePath('notes/git/.gitignore')).toEqual(['notes', 'git', '.gitignore']);
  });

  test('a ".." segment is refused wherever it stands', () => {
    for (const path of ['..', '../x', 'a/../x', 'a/..', 'a/b/../../../x', '../../etc/passwd']) {
      expect([path, refusal(() => checkSavePath(path))]).toEqual([path, expect.stringContaining('..')]);
    }
  });

  test('an absolute path is refused', () => {
    for (const path of ['/etc/passwd', '/tmp/x', '/', '//x']) {
      expect([path, refusal(() => checkSavePath(path))]).toEqual([path, expect.stringContaining('relative')]);
    }
  });

  test('a path that is not normalized is refused', () => {
    for (const path of ['', './x', 'a/./b', 'a//b', 'a/', 'a/b/', '.', 'a\\b', 'a\u0000b', 'a\nb', `${'a'.repeat(300)}/x`]) {
      expect([JSON.stringify(path).slice(0, 20), refusal(() => checkSavePath(path))]).not.toEqual([JSON.stringify(path).slice(0, 20), 'accepted']);
    }
  });

  test('.git and .agflow are refused at any depth and in any case', () => {
    for (const path of [
      '.git',
      '.git/config',
      '.git/hooks/pre-commit',
      '.GIT/config',
      '.Git/hooks/post-checkout',
      'sub/.git/config',
      'a/b/.git',
      '.agflow',
      '.agflow/run/state.json',
      '.agflow/config.json',
      '.AGFLOW/config.json',
      'sub/.agflow/x',
      // Characters HFS+ ignores in a name.
      '.g\u200cit/config',
      '.git\u200d/config',
      '\ufeff.agflow/x',
    ]) {
      expect([path, refusal(() => checkSavePath(path))]).toEqual([path, expect.stringMatching(/\.git|\.agflow/)]);
    }
  });
});

describe('saving inside the working directory', () => {
  test('writes the bytes, creating the missing directories, and answers the path', () => {
    const { root } = workdir();
    expect(saveInside(root, 'data/raw/2026/prices.csv', bytes('a,b\n1,2\n'))).toBe('data/raw/2026/prices.csv');
    expect(readFileSync(join(root, 'data/raw/2026/prices.csv'), 'utf8')).toBe('a,b\n1,2\n');
    expect(saveInside(root, 'top.bin', new Uint8Array([0, 255, 7]))).toBe('top.bin');
    expect([...readFileSync(join(root, 'top.bin'))]).toEqual([0, 255, 7]);
    // Nothing is left behind next to the files.
    expect(filesUnder(root).filter((file) => !file.startsWith('.git') && !file.startsWith('.agflow'))).toEqual(['data/raw/2026/prices.csv', 'top.bin']);
  });

  test('an existing file is replaced, an empty body is an empty file', () => {
    const { root } = workdir();
    writeFileSync(join(root, 'page.html'), 'old and longer');
    saveInside(root, 'page.html', bytes('new'));
    expect(readFileSync(join(root, 'page.html'), 'utf8')).toBe('new');
    saveInside(root, 'empty', new Uint8Array());
    expect(readFileSync(join(root, 'empty'))).toHaveLength(0);
  });

  test('the working directory of the process is the same afterwards, whether the save worked or not', () => {
    const { root } = workdir();
    const before = process.cwd();
    saveInside(root, 'a/b', bytes('x'));
    expect(process.cwd()).toBe(before);
    symlinkSync('/tmp', join(root, 'link'));
    expect(refusal(() => saveInside(root, 'link/x', bytes('x')))).not.toBe('accepted');
    expect(process.cwd()).toBe(before);
    expect(refusal(() => saveInside(root, '../x', bytes('x')))).not.toBe('accepted');
    expect(process.cwd()).toBe(before);
  });

  test('a symlinked parent is refused, and nothing is written or created where it points', () => {
    const { root, outside } = workdir();
    symlinkSync(outside, join(root, 'link'));
    mkdirSync(join(root, 'real'));
    symlinkSync(outside, join(root, 'real', 'deep'));
    symlinkSync(join(root, 'real'), join(root, 'inner'));
    for (const path of ['link/victim', 'link/new.txt', 'link/made/new.txt', 'real/deep/new.txt', 'real/deep/made/new.txt', 'inner/x.txt']) {
      expect([path, refusal(() => saveInside(root, path, bytes('pwned')))]).toEqual([path, expect.stringContaining('symbolic link')]);
    }
    expect(filesUnder(outside)).toEqual(['victim']);
    expect(readFileSync(join(outside, 'victim'), 'utf8')).toBe('untouched');
    expect(existsSync(join(outside, 'made'))).toBe(false);
    expect(existsSync(join(root, 'real', 'x.txt'))).toBe(false);
  });

  test('a file that is a symlink or a hard link to something outside is replaced, not written through', () => {
    const { root, outside } = workdir();
    symlinkSync(join(outside, 'victim'), join(root, 'soft'));
    linkSync(join(outside, 'victim'), join(root, 'hard'));
    saveInside(root, 'soft', bytes('mine'));
    saveInside(root, 'hard', bytes('mine too'));
    expect(readFileSync(join(outside, 'victim'), 'utf8')).toBe('untouched');
    expect(lstatSync(join(root, 'soft')).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(root, 'soft'), 'utf8')).toBe('mine');
    expect(readFileSync(join(root, 'hard'), 'utf8')).toBe('mine too');
    // A dangling link is replaced the same way; nothing appears where it pointed.
    symlinkSync(join(outside, 'not-yet'), join(root, 'dangling'));
    saveInside(root, 'dangling', bytes('here'));
    expect(existsSync(join(outside, 'not-yet'))).toBe(false);
    expect(readFileSync(join(root, 'dangling'), 'utf8')).toBe('here');
  });

  test('a directory in the way of the file, or a file in the way of a directory, is refused', () => {
    const { root } = workdir();
    mkdirSync(join(root, 'dir'));
    writeFileSync(join(root, 'file'), 'x');
    expect(refusal(() => saveInside(root, 'dir', bytes('x')))).toContain('directory');
    expect(refusal(() => saveInside(root, 'file/inside.txt', bytes('x')))).toContain('not a directory');
    expect(readFileSync(join(root, 'file'), 'utf8')).toBe('x');
    expect(readdirSync(join(root, 'dir'))).toEqual([]);
  });

  test('.git and .agflow stay untouched however the path is spelt', () => {
    const { root } = workdir();
    const before = filesUnder(root);
    for (const path of ['.git/hooks/pre-commit', '.GIT/hooks/pre-commit', '.git/config', '.agflow/run/x', '.Agflow/config.json', 'sub/.git/config']) {
      expect([path, refusal(() => saveInside(root, path, bytes('#!/bin/sh\n')))]).not.toEqual([path, 'accepted']);
    }
    expect(filesUnder(root)).toEqual(before);
    expect(existsSync(join(root, 'sub'))).toBe(false);
  });

  test('a spelling the file system folds into .agflow is refused before anything is written', () => {
    const { root } = workdir();
    const before = filesUnder(root);
    expect(refusal(() => saveInside(root, '.aGfLoW/x', bytes('x')))).toContain('.agflow');
    expect(refusal(() => saveInside(root, '.gIt', bytes('x')))).toContain('.git');
    expect(filesUnder(root)).toEqual(before);
  });

  test('the working directory may itself be reached through a symlink', () => {
    const { base, root } = workdir();
    symlinkSync(root, join(base, 'via'));
    expect(saveInside(join(base, 'via'), 'x/y.txt', bytes('ok'))).toBe('x/y.txt');
    expect(readFileSync(join(root, 'x/y.txt'), 'utf8')).toBe('ok');
  });

  test('a working directory that does not exist is an error, not a write somewhere else', () => {
    const { base } = workdir();
    expect(() => saveInside(join(base, 'missing'), 'x', bytes('x'))).toThrow();
    expect(existsSync(join(base, 'missing'))).toBe(false);
  });
});
