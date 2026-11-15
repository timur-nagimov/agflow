import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seccompHelper } from '../../src/prep/seccomp';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function home(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agflow-seccomp-')));
  roots.push(root);
  return root;
}

describe('seccompHelper', () => {
  test("picks the package's helper of the architecture and, run from source, uses that file as it is", () => {
    const agflowHome = home();
    for (const arch of ['x64', 'arm64']) {
      const helper = seccompHelper({ arch, home: agflowHome });
      expect(helper.endsWith(join('sandbox-runtime', 'vendor', 'seccomp', arch, 'apply-seccomp'))).toBe(true);
      expect(statSync(helper).isFile()).toBe(true);
    }
    expect(seccompHelper({ home: agflowHome })).toBe(seccompHelper({ arch: process.arch, home: agflowHome }));
    // Nothing is written for a helper that is already a file on disk.
    expect(readdirSync(agflowHome)).toEqual([]);
    for (const arch of ['ia32', 'constructor']) {
      expect(() => seccompHelper({ arch, home: agflowHome })).toThrow(`no seccomp helper for ${arch}`);
    }
  });

  test('writes an embedded helper under AGFLOW_HOME, mode 0755, and again whenever the copy differs', () => {
    const agflowHome = home();
    const embedded = '/$bunfs/root/apply-seccomp-abc123.';
    let bytes = Buffer.from('helper one');
    const reads: string[] = [];
    const resolve = () =>
      seccompHelper({
        arch: 'x64',
        home: agflowHome,
        helpers: { x64: embedded },
        read: (path) => {
          reads.push(path);
          return bytes;
        },
      });
    const path = join(agflowHome, 'seccomp', 'x64', 'apply-seccomp');
    expect(resolve()).toBe(path);
    expect(reads).toEqual([embedded]);
    expect(readFileSync(path, 'utf8')).toBe('helper one');
    expect(statSync(path).mode & 0o777).toBe(0o755);
    // The same bytes and mode: the file stays as it is.
    const { ino } = statSync(path);
    expect(resolve()).toBe(path);
    expect(statSync(path).ino).toBe(ino);
    // A new binary's helper, an edited copy, and a copy that lost its mode are all written again.
    bytes = Buffer.from('helper two');
    expect(resolve()).toBe(path);
    expect(readFileSync(path, 'utf8')).toBe('helper two');
    writeFileSync(path, 'tampered');
    resolve();
    expect(readFileSync(path, 'utf8')).toBe('helper two');
    chmodSync(path, 0o644);
    resolve();
    expect(statSync(path).mode & 0o777).toBe(0o755);
    // A link in its place is replaced, never followed.
    const elsewhere = join(agflowHome, 'elsewhere');
    writeFileSync(elsewhere, 'helper two');
    chmodSync(elsewhere, 0o755);
    rmSync(path);
    symlinkSync(elsewhere, path);
    resolve();
    expect(lstatSync(path).isFile()).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('helper two');
    // No temporary file is left beside it.
    expect(readdirSync(join(agflowHome, 'seccomp', 'x64'))).toEqual(['apply-seccomp']);
  });
});
