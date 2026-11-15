import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDependencyPreparer } from '../src/prep/preparer';
import { PrepSandbox, type SandboxBackend } from '../src/prep/sandbox';
import { checkMain, MAIN_CHECK } from '../src/main-check';
import { standardProfile } from '../src/profile';
import { type DependencyPreparer, skipDependencyPreparer } from '../src/seams';
import {
  cleanupRunnerFixtures,
  createRunnerFixture,
  FIXTURE_PROJECT,
  FIXTURE_WIP_PREFIX,
  type RunnerFixture,
} from './fixture';

afterEach(cleanupRunnerFixtures);

// Every test here runs git, which takes several times as long on a machine loaded by other suites.
setDefaultTimeout(30_000);

/** The sandbox runtime as the preparer tests fake it: the wrapped command runs as it is. */
const passThrough: SandboxBackend = {
  initialize: async () => {},
  isSupportedPlatform: () => true,
  checkDependencies: () => ({ errors: [], warnings: [] }),
  wrapWithSandboxArgv: async (command) => ({ argv: ['/bin/sh', '-c', command], env: {} }),
  cleanupAfterCommand: () => {},
};

/** An origin whose main holds .agflow/config.json with the check and the dependency entries. */
function files(config: { check?: string; dependencies?: string[] } | null): Record<string, string> {
  if (config === null) return { 'README.md': '# demo\n' };
  const dependencies = (config.dependencies ?? []).map((command) => ({ run: ['/bin/sh', '-c', command], when: [] }));
  return { 'README.md': '# demo\n', '.agflow/config.json': JSON.stringify({ dependencies, check: config.check }) };
}

/** A preparer that runs commands as dependency preparation does, with no sandbox around them. */
async function realPreparer(f: RunnerFixture): Promise<DependencyPreparer> {
  const sandbox = new PrepSandbox({ allowedDomains: standardProfile.network.allowedDomains, manager: passThrough });
  return createDependencyPreparer({
    paths: f.paths,
    store: f.store,
    config: () => f.config,
    ownerHome: join(f.home, 'owner'),
    run: (spec) => sandbox.run(spec),
  });
}

function check(f: RunnerFixture, preparer: DependencyPreparer, sha = f.origin.mainSha) {
  const input = { vault: f.vault, local: f.local, paths: f.paths, config: f.config, wipRefPrefix: FIXTURE_WIP_PREFIX };
  return checkMain({ ...input, preparer, sha });
}

const cloneOf = (f: RunnerFixture) => f.paths.clone(FIXTURE_PROJECT, MAIN_CHECK);

describe("main's check", () => {
  test('prepares the dependencies in a fresh clone at the sha, runs the check there, and removes the clone', async () => {
    const command = 'test ! -e stale.txt && cat prepared.txt';
    const f = await createRunnerFixture({ files: files({ dependencies: ['echo prepared > prepared.txt'], check: command }) });
    // A clone a stopped runner left goes first: the check runs in a fresh one.
    mkdirSync(cloneOf(f), { recursive: true });
    writeFileSync(join(cloneOf(f), 'stale.txt'), 'stale\n');
    const result = await check(f, await realPreparer(f));
    expect(result).toEqual({
      sha: f.origin.mainSha,
      check: { status: 'passed', command, durationMs: expect.any(Number), tail: 'prepared' },
    });
    expect(existsSync(cloneOf(f))).toBe(false);
  });

  test('a check that fails gives failed with the end of its output, and how it ended', async () => {
    const f = await createRunnerFixture({ files: files({ check: 'echo 1 test failed; exit 3' }) });
    const result = await check(f, await realPreparer(f));
    expect(result.check).toMatchObject({
      status: 'failed',
      command: 'echo 1 test failed; exit 3',
      tail: '1 test failed\nThe check exited with code 3.',
    });
    expect(existsSync(cloneOf(f))).toBe(false);
  });

  test('a check that timed out or was killed says so after its output, which may show only passing tests', async () => {
    const f = await createRunnerFixture({ files: files({ check: 'bun test' }) });
    const runs = [
      { code: null, signal: 'SIGTERM', timedOut: true, logTail: '12 pass', durationMs: 600_000 },
      { code: null, signal: 'SIGKILL', timedOut: false, logTail: '12 pass', durationMs: 3 },
    ];
    const nothing = { ran: false, ok: true, error: null, logTail: null };
    const preparer: DependencyPreparer = {
      available: true,
      prepare: async () => nothing,
      prepareFresh: async () => nothing,
      check: async () => runs.shift() as (typeof runs)[number],
    };
    // checkMinutes is 10 by default.
    expect((await check(f, preparer)).check).toMatchObject({
      status: 'failed',
      tail: '12 pass\nThe check timed out after 10 min.',
    });
    expect((await check(f, preparer)).check).toMatchObject({
      status: 'failed',
      tail: '12 pass\nThe check was killed by SIGKILL.',
    });
  });

  test('a preparation that fails fails the check under the standard profile, which then does not run', async () => {
    const f = await createRunnerFixture({
      files: files({ dependencies: ['echo cannot install >&2; exit 4'], check: 'echo checked' }),
    });
    const result = await check(f, await realPreparer(f));
    expect(result.check).toMatchObject({ status: 'failed', command: 'echo checked', durationMs: 0 });
    expect(result.check.tail).toContain('cannot install');
    expect(result.check.tail).toContain('exited with code 4');
    expect(result.check.tail).not.toContain('checked');
    expect(existsSync(cloneOf(f))).toBe(false);
  });

  test('under the open profile the check runs anyway, and its output ends with a note of the failure', async () => {
    const f = await createRunnerFixture({
      files: files({ dependencies: ['echo cannot install >&2; exit 4'], check: 'echo checked' }),
      config: { profile: 'open' },
    });
    const result = await check(f, await realPreparer(f));
    expect(result.check.status).toBe('passed');
    const lines = result.check.tail.split('\n');
    expect(lines[0]).toBe('checked');
    expect(lines.at(-1)).toStartWith('The dependencies could not be prepared (');
    expect(lines.at(-1)).toEndWith('exited with code 4). The check ran anyway.');
  });

  test('the check gets a worker environment with no vendor login: nothing of runner.env, no CODEX_HOME', async () => {
    const f = await createRunnerFixture({ files: files({ dependencies: ['true'], check: 'true' }) });
    writeFileSync(f.paths.envFile, 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-runner-login\n', { mode: 0o600 });
    const envs: Record<string, string>[] = [];
    const nothing = { ran: true, ok: true, error: null, logTail: null };
    const preparer: DependencyPreparer = {
      available: true,
      prepare: async () => nothing,
      prepareFresh: async (input) => {
        envs.push(input.env);
        return nothing;
      },
      check: async (input) => {
        envs.push(input.env);
        return { code: 0, signal: null, timedOut: false, logTail: '', durationMs: 3 };
      },
    };
    expect((await check(f, preparer)).check.status).toBe('passed');
    expect(envs).toHaveLength(2);
    for (const env of envs) {
      expect(Object.keys(env).filter((name) => name.startsWith('CLAUDE_') || name.startsWith('CODEX_'))).toEqual([]);
      expect(Object.keys(env).filter((name) => name.startsWith('AGFLOW_'))).toEqual([]);
      expect(JSON.stringify(env)).not.toContain('sk-ant-oat01-runner-login');
      expect(env.PATH).toEndWith(f.config.capturedPath);
    }
  });

  test('a sha the origin does not have fails; a main with no check, or a runner with no sandbox, gives none', async () => {
    const f = await createRunnerFixture({ files: files(null) });
    await expect(check(f, await realPreparer(f), 'f'.repeat(40))).rejects.toThrow(
      `${'f'.repeat(40)} is neither on the origin's main nor in the vault`,
    );
    expect((await check(f, await realPreparer(f))).check).toEqual({
      status: 'none',
      command: null,
      durationMs: 0,
      tail: '',
    });
    const g = await createRunnerFixture({ files: files({ check: 'echo checked' }) });
    expect((await check(g, skipDependencyPreparer)).check).toEqual({
      status: 'none',
      command: 'echo checked',
      durationMs: 0,
      tail: 'this runner cannot run it: it has no sandbox for preparation commands',
    });
    expect(existsSync(cloneOf(g))).toBe(false);
  });
});
