import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { agflowHome, makeAttemptTmpDir, projectKey, runnerPaths } from '../src/paths';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A short root under /tmp, so <root>/agf/<id>/claude-<uid> stays within 44 bytes even through /private/tmp. */
function shortRoot(): string {
  const root = mkdtempSync('/tmp/r');
  roots.push(root);
  return root;
}

describe('runnerPaths', () => {
  test('maps every path of the layout under AGFLOW_HOME', () => {
    const paths = runnerPaths('/h');
    expect(paths.home).toBe('/h');
    expect(paths.runner).toBe('/h/runner');
    expect(paths.config).toBe('/h/runner/runner.json');
    expect(paths.db).toBe('/h/runner/runner.db');
    expect(paths.lock).toBe('/h/runner/runner.lock');
    expect(paths.socket).toBe('/h/runner/runner.sock');
    expect(paths.logs).toBe('/h/runner/logs');
    expect(paths.runnerLog).toBe('/h/runner/logs/runner.log');
    expect(paths.attemptLog('T-4-a1')).toBe('/h/runner/logs/attempts/T-4-a1.log');
    expect(paths.homes).toEqual({
      claude: '/h/runner/homes/claude',
      codex: '/h/runner/homes/codex',
      codexUser: '/h/runner/homes/codex-user',
    });
    expect(paths.vendor).toBe('/h/runner/vendor');
    expect(paths.gitConfig).toBe('/h/runner/git/local.gitconfig');
    expect(paths.gitExcludes).toBe('/h/runner/git/excludes');
    expect(paths.prep('demo-1a2b')).toBe('/h/runner/prep/demo-1a2b');
    expect(paths.forensics('T-4-a1')).toBe('/h/runner/forensics/T-4-a1');
    expect(paths.vaults).toBe('/h/vaults');
    expect(paths.vault('demo-1a2b')).toBe('/h/vaults/demo-1a2b.git');
    expect(paths.quarantine('demo-1a2b', 'T-4-a1')).toBe('/h/vaults/demo-1a2b.quarantine/T-4-a1');
    expect(paths.baseCheckout('demo-1a2b', 'a'.repeat(40))).toBe(`/h/vaults/demo-1a2b.base/${'a'.repeat(12)}`);
    expect(paths.work).toBe('/h/work');
    expect(paths.clone('demo-1a2b', 'T-4-a1')).toBe('/h/work/demo-1a2b/T-4-a1');
  });

  test('refuses names that would leave their directory', () => {
    const paths = runnerPaths('/h');
    expect(() => paths.clone('demo', '../T-4-a1')).toThrow('not a safe path name');
    expect(() => paths.vault('a/b')).toThrow('not a safe path name');
    expect(() => paths.attemptLog('..')).toThrow('not a safe path name');
    expect(() => paths.baseCheckout('demo', 'main')).toThrow('expected a commit sha');
  });

  test('AGFLOW_HOME overrides ~/.agflow', () => {
    expect(agflowHome({})).toBe(join(homedir(), '.agflow'));
    expect(agflowHome({ AGFLOW_HOME: '/tmp/agflow-test' })).toBe('/tmp/agflow-test');
    expect(runnerPaths(agflowHome({ AGFLOW_HOME: '/tmp/x' })).vaults).toBe('/tmp/x/vaults');
  });

  test('a relative AGFLOW_HOME is made absolute', () => {
    expect(agflowHome({ AGFLOW_HOME: 'rel/home' })).toBe(join(process.cwd(), 'rel/home'));
  });
});

describe('projectKey', () => {
  test('is filesystem-safe and stable', () => {
    const key = projectKey('https://hub.example.com/', 'My Project: v2/beta');
    expect(key).toMatch(/^[a-z0-9-]+$/);
    expect(key.startsWith('my-project-v2-beta-')).toBe(true);
    expect(projectKey('https://hub.example.com', 'My Project: v2/beta')).toBe(key);
  });

  test('keeps its derivation, because vault and work directories outlive runner upgrades', () => {
    expect(projectKey('https://hub.example.com', 'My Project: v2/beta')).toBe('my-project-v2-beta-406c8e1c7d');
  });

  test('differs for two hubs with the same project name', () => {
    expect(projectKey('https://a.example.com', 'demo')).not.toBe(projectKey('https://b.example.com', 'demo'));
  });

  test('stays short for long or unusual names', () => {
    expect(projectKey('http://h', 'x'.repeat(200)).length).toBeLessThanOrEqual(40);
    expect(projectKey('http://h', '日本語')).toMatch(/^project-[0-9a-f]+$/);
  });
});

describe('makeAttemptTmpDir', () => {
  test('creates <root>/agf/<6 chars> with mode 0700', () => {
    const root = shortRoot();
    const dir = makeAttemptTmpDir({ root, uid: 501 });
    expect(dir).toMatch(new RegExp(`^${root}/agf/[a-z0-9]{6}$`));
    expect(statSync(dir).isDirectory()).toBe(true);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, 'agf')).mode & 0o777).toBe(0o700);
    expect(makeAttemptTmpDir({ root, uid: 501 })).not.toBe(dir);
  });

  test('never reuses an existing directory', () => {
    const root = shortRoot();
    mkdirSync(join(root, 'agf', 'aaaaaa'), { recursive: true });
    const ids = ['aaaaaa', 'bbbbbb'];
    const dir = makeAttemptTmpDir({ root, uid: 501, randomId: () => ids.shift() as string });
    expect(dir).toBe(join(root, 'agf', 'bbbbbb'));
  });

  test('refuses a root whose claude-<uid> directory would exceed 44 bytes', () => {
    const root = shortRoot();
    const deep = join(root, 'x'.repeat(20));
    mkdirSync(deep);
    expect(() => makeAttemptTmpDir({ root: deep, uid: 501 })).toThrow('44 bytes');
  });

  test('accepts exactly 44 bytes and refuses 45', () => {
    // A root whose given and real paths are the same; the uid's digits fill the path up to the limit.
    const root = realpathSync(shortRoot());
    const digits = 44 - Buffer.byteLength(`${root}/agf/xxxxxx/claude-`);
    expect(() => makeAttemptTmpDir({ root, uid: Number('1'.repeat(digits)) })).not.toThrow();
    expect(() => makeAttemptTmpDir({ root, uid: Number('1'.repeat(digits + 1)) })).toThrow('44 bytes');
  });

  test('measures the real path of a root behind a symlink', () => {
    const long = join(shortRoot(), 'y'.repeat(20));
    mkdirSync(long);
    const link = join(shortRoot(), 's');
    symlinkSync(long, link);
    // The given path fits; the real one, which the CLI may resolve, does not.
    expect(`${link}/agf/xxxxxx/claude-501`.length).toBeLessThanOrEqual(44);
    expect(() => makeAttemptTmpDir({ root: link, uid: 501 })).toThrow('44 bytes');
  });

  test('refuses an agf directory that another user or a symlink holds', () => {
    const root = shortRoot();
    const elsewhere = shortRoot();
    symlinkSync(elsewhere, join(root, 'agf'));
    expect(() => makeAttemptTmpDir({ root })).toThrow('not a private directory');
  });
});
