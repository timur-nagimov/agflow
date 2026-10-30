import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AttemptPhase, restoreSet } from '@agflow/core';
import { commitFiles, gitIn } from '@agflow/testkit';
import {
  clipViolationPaths,
  START_ERROR_MAX,
  VIOLATION_PATHS_MAX_BYTES,
  verifyProjectConfig,
} from '../src/attempt/workspace';
import { resolveRestoreBase } from '../src/git/protect';
import type { DependencyPreparer, PrepareInput } from '../src/seams';
import { cleanupRunnerFixtures, createRunnerFixture, FIXTURE_PROJECT, waitFor } from './fixture';
import { PLANTED_ATTRIBUTES, plantCloneConfig, touchLater } from './planted-config';

// Every test here runs git or agent processes, which take several times as long on a machine loaded by other suites.
setDefaultTimeout(30_000);

test('a repeated start resets finalization before opening or preparing the clone', async () => {
  const f = await createRunnerFixture();
  f.store.create(f.spec(), { clone: null, tmpDir: null, cliVersion: null });
  f.store.update('T-4-a1', { state: 'stopped', finalizedAt: 123 });
  const seen: (number | null)[] = [];
  const opened: (number | null)[] = [];
  const fetchForAttempt = f.vault.fetchForAttempt.bind(f.vault);
  f.vault.fetchForAttempt = async (attempt, wipRefPrefix) => {
    opened.push(f.store.get('T-4-a1')!.finalizedAt);
    await fetchForAttempt(attempt, wipRefPrefix);
  };
  const controller = f.controller('T-4-a1', {
    preparer: { available: true, prepare: async () => {
      seen.push(f.store.get('T-4-a1')!.finalizedAt);
      return { ran: true, ok: false, error: 'preparation failed', logTail: null };
    } },
  });
  expect(await controller.start(f.spec())).toMatchObject({ started: false });
  expect(opened).toEqual([null]);
  expect(seen).toEqual([null]);
  expect(f.store.get('T-4-a1')?.finalizedAt).toBeNull();
});

const scratch: string[] = [];
afterEach(async () => {
  await cleanupRunnerFixtures();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

/** Every file under dir, with its content, links shown as links. */
function snapshotOf(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (relative: string) => {
    for (const name of readdirSync(join(dir, relative))) {
      const path = relative === '' ? name : `${relative}/${name}`;
      const stat = lstatSync(join(dir, path));
      if (stat.isDirectory()) walk(path);
      else files[path] = stat.isSymbolicLink() ? 'link' : readFileSync(join(dir, path), 'utf8');
    }
  };
  walk('');
  return files;
}

const CODEX_SPEC = { vendor: 'codex' } as const;

const FILES = {
  'README.md': '# demo\n',
  'src/app.ts': 'app\n',
  '.claude/settings.json': '{"permissions":{}}\n',
  '.codex/config.toml': 'model = "o"\n',
};

/** A preparer that records each call and the controller's phase during it. */
function recordingPreparer(outcome: { ok: boolean; error?: string }, phase: () => AttemptPhase | null) {
  const calls: { input: PrepareInput; phase: AttemptPhase | null }[] = [];
  const preparer: DependencyPreparer = {
    available: true,
    prepare: async (input) => {
      calls.push({ input, phase: phase() });
      return { ran: true, ok: outcome.ok, error: outcome.error ?? null, logTail: outcome.ok ? null : 'npm ERR!' };
    },
  };
  return { calls, preparer };
}

const head = (clone: string) => gitIn(clone, ['rev-parse', 'HEAD']);

describe('AttemptController: preparing the clone for a start', () => {
  test('a task clone at the start tip on the task branch, with .agflow/run written and .cc-writes gone', async () => {
    const f = await createRunnerFixture({ files: FILES });
    const clone = f.paths.clone(FIXTURE_PROJECT, 'T-4-a1');
    const controller = f.controller();
    expect(await controller.start(f.spec())).toEqual({ started: true });
    const workspace = controller.workspace;
    expect(workspace).toMatchObject({ clone: realpathSync(clone), created: true, startSha: f.origin.mainSha });
    expect(await head(clone)).toBe(f.origin.mainSha);
    expect(await gitIn(clone, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/agflow/T-4-tidy');
    const run = join(clone, '.agflow', 'run');
    expect(readFileSync(join(run, 'task.md'), 'utf8')).toBe('# T-4 Tidy the app\n');
    const brief = readFileSync(join(run, 'brief.md'), 'utf8');
    expect(brief.startsWith('You are an agflow worker on T-4.')).toBe(true);
    expect(brief.trimEnd().endsWith(`Your working directory: ${realpathSync(clone)}`)).toBe(true);
    expect(workspace?.brief).toBe(brief.trimEnd());
    expect(readdirSync(join(run, 'config'))).toEqual([]);
    expect(f.store.get('T-4-a1')).toMatchObject({ clone: realpathSync(clone) });

    // A kept clone may hold the Claude CLI's staging directory from an earlier run.
    mkdirSync(join(clone, '.claude', '.cc-writes'), { recursive: true });
    writeFileSync(join(clone, '.claude', '.cc-writes', 'settings.json'), '{"staged":true}\n');
    expect(await f.controller().start(f.spec())).toEqual({ started: true });
    expect(existsSync(join(clone, '.claude', '.cc-writes'))).toBe(false);
    expect(existsSync(join(clone, '.claude', 'settings.json'))).toBe(true);

    // Through a .claude that links outside the clone, nothing is deleted there.
    const outside = tempDir('agflow-outside-claude-');
    mkdirSync(join(outside, '.cc-writes'));
    writeFileSync(join(outside, '.cc-writes', 'precious.txt'), 'precious\n');
    rmSync(join(clone, '.claude'), { recursive: true, force: true });
    symlinkSync(outside, join(clone, '.claude'));
    expect(await f.controller().start(f.spec())).toEqual({ started: true });
    expect(readFileSync(join(outside, '.cc-writes', 'precious.txt'), 'utf8')).toBe('precious\n');
  });

  test('a link planted at the clone path fails the start, and nothing is done through it', async () => {
    const f = await createRunnerFixture({ files: FILES });
    await f.controller().start(f.spec());
    // The first agent's turn is over, so none of its events lands among the second start's.
    await waitFor(() => f.events('attempt.activity').length > 0);
    const clone = f.paths.clone(FIXTURE_PROJECT, 'T-4-a1');
    // The owner's files, where the agent's link points.
    const home = tempDir('agflow-owner-home-');
    mkdirSync(join(home, '.codex'));
    writeFileSync(join(home, '.codex', 'auth.json'), '{"token":"secret"}\n');
    mkdirSync(join(home, '.claude'));
    writeFileSync(join(home, '.claude', 'settings.json'), '{"mine":true}\n');
    writeFileSync(join(home, '.npmrc'), '//registry/:_authToken=secret\n');
    const before = snapshotOf(home);
    renameSync(clone, join(tempDir('agflow-moved-clone-'), 'old'));
    symlinkSync(home, clone);
    const events = f.events().length;
    const result = await f.controller().start(f.spec());
    expect(result).toMatchObject({ started: false, refused: null });
    const reported = f.events().slice(events);
    expect(reported.map((event) => event.type)).toEqual(['attempt.failed_to_start']);
    expect(reported[0]?.data).toMatchObject({ error: expect.stringMatching(/^cannot prepare the clone: .*not a directory/) });
    expect(snapshotOf(home)).toEqual(before);
    expect(lstatSync(clone).isSymbolicLink()).toBe(true);
    expect(f.store.get('T-4-a1')?.clone).not.toBe(realpathSync(home));
  });

  test('an existing clone is kept, not recreated', async () => {
    const f = await createRunnerFixture({ files: FILES });
    await f.controller().start(f.spec());
    const clone = f.paths.clone(FIXTURE_PROJECT, 'T-4-a1');
    writeFileSync(join(clone, 'notes.txt'), 'the agent was here\n');
    const ino = statSync(join(clone, '.git')).ino;
    const again = f.controller();
    expect(await again.start(f.spec())).toEqual({ started: true });
    expect(again.workspace).toMatchObject({ created: false, startSha: f.origin.mainSha });
    expect(readFileSync(join(clone, 'notes.txt'), 'utf8')).toBe('the agent was here\n');
    expect(statSync(join(clone, '.git')).ino).toBe(ino);
  });

  test('a start commit that changed a protected file gets the base back and one violation; a clean start none', async () => {
    const f = await createRunnerFixture({ files: FILES });
    const handBack = await commitFiles(f.origin.path, {
      branch: 'agflow/T-4-tidy',
      files: { '.claude/settings.json': '{"permissions":{"allow":["Bash(*)"]}}\n', 'src/app.ts': 'tidy\n' },
      message: 'a hand-back with agent config',
    });
    const controller = f.controller();
    await controller.start(f.spec({ start: { ref: 'refs/heads/agflow/T-4-tidy', sha: handBack } }));
    const clone = f.paths.clone(FIXTURE_PROJECT, 'T-4-a1');
    expect(controller.workspace?.startSha).toBe(handBack);
    expect(controller.workspace?.base).toBe(f.origin.mainSha);
    expect(readFileSync(join(clone, '.claude', 'settings.json'), 'utf8')).toBe(FILES['.claude/settings.json']);
    expect(readFileSync(join(clone, 'src', 'app.ts'), 'utf8')).toBe('tidy\n');
    const violations = f.events('attempt.violation');
    expect(violations.map((event) => event.data)).toEqual([{ phase: 'start', paths: ['.claude/settings.json'] }]);
    expect(violations[0]?.fence).toEqual({ epoch: 1, counter: 1 });

    await f.controller('T-5-a1').start(
      f.spec({ attemptId: 'T-5-a1', taskId: 'T-5', branch: 'agflow/T-5-clean', wipRef: 'refs/agflow/T-5/a1' }),
    );
    expect(f.events('attempt.violation')).toHaveLength(1);
  });

  test('a Claude attempt gets a base checkout of main and a private tmp dir; a Codex attempt gets neither', async () => {
    const f = await createRunnerFixture({ files: FILES });
    const claude = f.controller();
    await claude.start(f.spec());
    const base = claude.workspace?.baseCheckout;
    expect(base?.sha).toBe(f.origin.mainSha);
    expect(readFileSync(join(base?.path as string, '.claude', 'settings.json'), 'utf8')).toBe(
      FILES['.claude/settings.json'],
    );
    const tmpDir = claude.workspace?.tmpDir as string;
    expect(tmpDir).toMatch(new RegExp(`^${f.tmpRoot}/agf/[a-z0-9]{6}$`));
    expect(statSync(tmpDir).mode & 0o777).toBe(0o700);
    expect(f.store.get('T-4-a1')?.tmpDir).toBe(tmpDir);

    const codex = f.controller('T-5-a1');
    await codex.start(
      f.spec({ attemptId: 'T-5-a1', taskId: 'T-5', vendor: 'codex', branch: 'agflow/T-5-x', wipRef: 'refs/agflow/T-5/a1' }),
    );
    expect(codex.workspace).toMatchObject({ baseCheckout: null, tmpDir: null });
    expect(f.store.get('T-5-a1')?.tmpDir).toBeNull();
  });

  test('projectConfigVerified is true after the restore, and false when an untracked file stays under .codex/', async () => {
    const f = await createRunnerFixture({ files: { ...FILES, '.gitignore': '.codex/*.local.toml\n' } });
    const clone = f.paths.clone(FIXTURE_PROJECT, 'T-4-a1');
    const controller = f.controller();
    await controller.start(f.spec(CODEX_SPEC));
    expect(controller.workspace?.projectConfigVerified).toBe(true);
    const git = { vault: f.vault, local: f.local };
    const base = await resolveRestoreBase(f.vault, f.spec());
    expect(await verifyProjectConfig({ ...git, clone, base })).toBe(true);
    // Codex reads every file there, ignored ones too.
    writeFileSync(join(clone, '.codex', 'override.local.toml'), 'model = "mine"\n');
    expect(await verifyProjectConfig({ ...git, clone, base })).toBe(false);
    writeFileSync(join(clone, '.codex', 'extra.toml'), 'model = "other"\n');
    expect(await verifyProjectConfig({ ...git, clone, base })).toBe(false);
    // A changed tracked file is not verified either.
    writeFileSync(join(clone, '.codex', 'config.toml'), 'model = "changed"\n');
    expect(await verifyProjectConfig({ ...git, clone, base })).toBe(false);

    // The next start's restore removes both, ignored or not, and puts the tracked file back.
    const again = f.controller();
    expect(await again.start(f.spec(CODEX_SPEC))).toEqual({ started: true });
    expect(readdirSync(join(clone, '.codex'))).toEqual(['config.toml']);
    expect(readFileSync(join(clone, '.codex', 'config.toml'), 'utf8')).toBe(FILES['.codex/config.toml']);
    expect(again.workspace?.projectConfigVerified).toBe(true);
  });

  test('a start commit that changed .codex/ is restored first, so the clone is verified', async () => {
    const f = await createRunnerFixture({ files: FILES });
    const changed = await commitFiles(f.origin.path, {
      branch: 'agflow/T-4-tidy',
      files: { '.codex/config.toml': 'model = "agent"\n' },
      message: 'agent config',
    });
    const controller = f.controller();
    await controller.start(f.spec({ ...CODEX_SPEC, start: { ref: 'refs/heads/agflow/T-4-tidy', sha: changed } }));
    expect(f.events('attempt.violation').map((event) => event.data)).toEqual([
      { phase: 'start', paths: ['.codex/config.toml'] },
    ]);
    expect(controller.workspace?.projectConfigVerified).toBe(true);
    expect(f.fakes.codex?.launches[0]?.projectConfigVerified).toBe(true);
  });

  test("the project config is verified after the dependency preparation, which is followed by a restore", async () => {
    const f = await createRunnerFixture({ files: FILES });
    // A preparation whose scripts write agent config, as a postinstall in the agent's package.json could.
    const preparer: DependencyPreparer = {
      available: true,
      prepare: async (input) => {
        writeFileSync(join(input.clone, '.codex', 'config.toml'), 'model = "postinstall"\n');
        writeFileSync(join(input.clone, '.codex', 'prep.toml'), 'approval_policy = "never"\n');
        return { ran: true, ok: true, error: null, logTail: null };
      },
    };
    const controller = f.controller('T-4-a1', { preparer });
    expect(await controller.start(f.spec(CODEX_SPEC))).toEqual({ started: true });
    const clone = f.paths.clone(FIXTURE_PROJECT, 'T-4-a1');
    expect(readdirSync(join(clone, '.codex'))).toEqual(['config.toml']);
    expect(readFileSync(join(clone, '.codex', 'config.toml'), 'utf8')).toBe(FILES['.codex/config.toml']);
    expect(controller.workspace?.projectConfigVerified).toBe(true);

    // With a restore set that leaves .codex/ out, what the preparation wrote stays, and the check sees it.
    const paths = restoreSet(null).filter((pattern) => !pattern.startsWith('.codex'));
    const spec = f.spec({
      ...CODEX_SPEC,
      attemptId: 'T-5-a1',
      taskId: 'T-5',
      branch: 'agflow/T-5-x',
      wipRef: 'refs/agflow/T-5/a1',
      restore: { paths, base: 'refs/heads/main' },
    });
    const unrestored = f.controller('T-5-a1', { preparer });
    expect(await unrestored.start(spec)).toEqual({ started: true });
    expect(unrestored.workspace?.projectConfigVerified).toBe(false);
    expect(f.fakes.codex?.launches.at(-1)?.projectConfigVerified).toBe(false);
  });

  test("never runs git with the clone's own git configuration", async () => {
    const f = await createRunnerFixture({ files: { ...FILES, '.gitattributes': PLANTED_ATTRIBUTES } });
    for (const [attemptId, vendor] of [
      ['T-4-a1', 'claude'],
      ['T-5-a1', 'codex'],
    ] as const) {
      const taskId = attemptId.slice(0, 3);
      const spec = f.spec({ attemptId, taskId, vendor, branch: `agflow/${taskId}-x`, wipRef: `refs/agflow/${taskId}/a1` });
      expect(await f.controller(attemptId).start(spec)).toEqual({ started: true });
      const clone = f.paths.clone(FIXTURE_PROJECT, attemptId);
      const planted = plantCloneConfig(clone, tempDir('agflow-planted-'));
      touchLater(join(clone, 'README.md'));
      touchLater(join(clone, '.codex', 'config.toml'));
      expect(await f.controller(attemptId).start(spec)).toEqual({ started: true });
      expect(planted.fired()).toBe(false);
      await planted.proveLive('README.md');
    }
  });

  test("a worker's preparation runs in phase preparing with requestId null; a lead gets none", async () => {
    const f = await createRunnerFixture({ files: FILES });
    let controller = f.controller();
    const prep = recordingPreparer({ ok: true }, () => controller.phase);
    controller = f.controller('T-4-a1', { preparer: prep.preparer });
    expect(await controller.start(f.spec())).toEqual({ started: true });
    expect(prep.calls).toHaveLength(1);
    const [call] = prep.calls;
    expect(call?.phase).toBe('preparing');
    expect(call?.input).toMatchObject({
      attemptId: 'T-4-a1',
      vendor: 'claude',
      clone: realpathSync(f.paths.clone(FIXTURE_PROJECT, 'T-4-a1')),
      vault: f.vault,
      baseSha: f.origin.mainSha,
      requestId: null,
    });
    expect(call?.input.env.AGFLOW_ATTEMPT_ID).toBe('T-4-a1');
    // Out of preparing: starting, or already in the agent's first turn.
    expect(controller.phase).not.toBe('preparing');
    expect(f.events('attempt.prepared').map((event) => event.data)).toEqual([
      { requestId: null, ok: true, error: null, logTail: null },
    ]);

    const lead = f.controller('lead-a1', { preparer: prep.preparer });
    const spec = f.spec({
      attemptId: 'lead-a1',
      taskId: null,
      role: 'lead',
      branch: null,
      wipRef: null,
    });
    expect(await lead.start(spec)).toEqual({ started: true });
    expect(prep.calls).toHaveLength(1);
    const leadClone = f.paths.clone(FIXTURE_PROJECT, 'lead-a1');
    expect(await head(leadClone)).toBe(f.origin.mainSha);
    expect(await gitIn(leadClone, ['symbolic-ref', '-q', 'HEAD'], { allowFailure: true })).toBe('');
  });

  test('a failed preparation reports attempt.prepared, then attempt.failed_to_start, and starts no agent', async () => {
    const f = await createRunnerFixture({ files: FILES });
    const prep = recordingPreparer({ ok: false, error: 'bun install failed' }, () => null);
    const controller = f.controller('T-4-a1', { preparer: prep.preparer });
    const result = await controller.start(f.spec());
    // What the start took is given back.
    expect(existsSync(f.paths.baseCheckout(FIXTURE_PROJECT, f.origin.mainSha))).toBe(false);
    expect(controller.phase).toBeNull();
    expect(result).toMatchObject({ started: false, refused: null });
    const events = f.events().map((event) => event.type);
    expect(events).toEqual(['attempt.prepared', 'attempt.failed_to_start']);
    expect(f.events('attempt.prepared')[0]?.data).toEqual({
      requestId: null,
      ok: false,
      error: 'bun install failed',
      logTail: 'npm ERR!',
    });
    expect(f.events('attempt.failed_to_start')[0]?.data).toEqual({
      error: 'dependency preparation failed: bun install failed',
      refused: null,
    });
    expect(f.fakes.claude?.launches).toEqual([]);
  });

  test('a clone that cannot be prepared reports attempt.failed_to_start and nothing else', async () => {
    const f = await createRunnerFixture({ files: FILES });
    const controller = f.controller('T-6-a1');
    const result = await controller.start(
      f.spec({ attemptId: 'T-6-a1', taskId: 'T-6', branch: null, wipRef: 'refs/agflow/T-6/a1' }),
    );
    expect(result).toMatchObject({ started: false, refused: null });
    const events = f.events();
    expect(events.map((event) => event.type)).toEqual(['attempt.failed_to_start']);
    expect(events[0]?.data).toMatchObject({ error: expect.stringMatching(/^cannot prepare the clone/), refused: null });
    expect(controller.phase).toBeNull();
  });

  test('a git failure with a huge error is reported clipped, and every later start from there too', async () => {
    const f = await createRunnerFixture({ files: FILES });
    // A tree of names no file system takes: the checkout fails with a line for each.
    const origin = f.origin.path;
    const blob = await gitIn(origin, ['hash-object', '-w', '--stdin'], { input: 'x\n' });
    const names = Array.from({ length: 3_500 }, (_, i) => `100644 blob ${blob}\t${'n'.repeat(300)}${i}\n`).join('');
    const tree = await gitIn(origin, ['mktree'], { input: names });
    const commit = await gitIn(origin, ['commit-tree', tree, '-p', f.origin.mainSha, '-m', 'unreadable names']);
    await gitIn(origin, ['update-ref', 'refs/heads/agflow/T-4-tidy', commit]);
    const spec = f.spec({ start: { ref: 'refs/heads/agflow/T-4-tidy', sha: commit } });
    for (const attempt of [1, 2]) {
      const controller = f.controller();
      expect(await controller.start(spec)).toMatchObject({ started: false, refused: null });
      const failed = f.events('attempt.failed_to_start');
      expect(failed).toHaveLength(attempt);
      const error = failed.at(-1)?.data.error as string;
      expect(error.startsWith('cannot prepare the clone')).toBe(true);
      expect(error.length).toBeLessThanOrEqual(START_ERROR_MAX);
      expect(controller.phase).toBeNull();
    }
  }, 60_000);

  test('an oversized list of protected paths the start commit changed is reported clipped', async () => {
    const f = await createRunnerFixture({ files: FILES });
    const files: Record<string, string> = {};
    for (let i = 0; i < 300; i++) files[`.vscode/${'settings-'.repeat(12)}${i}.json`] = '{}\n';
    const start = await commitFiles(f.origin.path, { branch: 'agflow/T-4-tidy', files, message: 'editor config' });
    const controller = f.controller();
    expect(await controller.start(f.spec({ start: { ref: 'refs/heads/agflow/T-4-tidy', sha: start } }))).toEqual({
      started: true,
    });
    const [violation] = f.events('attempt.violation');
    const paths = violation?.data.paths as string[];
    expect(paths.length).toBeLessThan(300);
    expect(paths.at(-1)).toBe(`… and ${300 - (paths.length - 1)} more`);
    expect(Buffer.byteLength(paths.join('\n'))).toBeLessThan(VIOLATION_PATHS_MAX_BYTES + 100);
    expect(clipViolationPaths(['a', 'b'], 100)).toEqual(['a', 'b']);
    expect(clipViolationPaths(['aaaa', 'bbbb', 'cccc'], 10)).toEqual(['aaaa', 'bbbb', '… and 1 more']);
  }, 30_000);

  test('a recorded Claude tmp dir replaced by a link is left alone, and a new one made', async () => {
    const f = await createRunnerFixture({ files: FILES });
    const first = f.controller();
    await first.start(f.spec());
    const recorded = first.workspace?.tmpDir as string;
    const elsewhere = tempDir('agflow-elsewhere-');
    rmSync(recorded, { recursive: true, force: true });
    symlinkSync(elsewhere, recorded);
    const again = f.controller();
    expect(await again.start(f.spec())).toEqual({ started: true });
    const tmpDir = again.workspace?.tmpDir as string;
    expect(tmpDir).not.toBe(recorded);
    expect(lstatSync(tmpDir).isDirectory()).toBe(true);
    expect(lstatSync(recorded).isSymbolicLink()).toBe(true);
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(f.store.get('T-4-a1')?.tmpDir).toBe(tmpDir);
    // A recorded directory that is still the private one is kept.
    const kept = f.controller();
    await kept.start(f.spec());
    expect(kept.workspace?.tmpDir).toBe(tmpDir);
  });
});
