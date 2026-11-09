import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { takeoverAnywhereCommand, takeoverRef } from '@agflow/core';
import { type FakeScript, gitIn, type TranscriptLine } from '@agflow/testkit';
import { handoffPrompt } from '../src/attempt/stop';
import { TAKEOVER_STOP_REASON, takeoverCommands, takeoverLocalCommand } from '../src/attempt/takeover';
import { vendorBinary } from '../src/vendor/pins';
import { vendorHomes } from '../src/config';
import {
  cleanupRunnerFixtures,
  createRunnerFixture,
  FIXTURE_PROJECT,
  FIXTURE_WIP_PREFIX,
  fixtureCliVersion,
  type RunnerFixture,
  waitFor,
} from './fixture';

afterEach(cleanupRunnerFixtures);

// Every test here runs git or agent processes, which take several times as long on a machine loaded by other suites.
setDefaultTimeout(30_000);

const FENCE = { epoch: 1, counter: 1 };
const WIP = 'refs/agflow/T-4/a1';
const BRANCH = 'agflow/T-4-tidy';

/** A turn of work that stays live, then the handoff turn the take-over asks for. */
const WORKING: FakeScript = {
  turns: [
    [
      { do: 'write', path: 'committed.txt', content: 'committed\n' },
      { do: 'commit', message: 'committed work' },
      { do: 'write', path: 'uncommitted.txt', content: 'uncommitted\n' },
      { do: 'write', path: 'README.md', content: '# demo, edited\n' },
      // An agent-config file main lacks, and a people-only file main has: both restored before the person comes.
      { do: 'write', path: '.envrc', content: 'export X=1\n' },
      { do: 'write', path: '.github/workflows/ci.yml', content: 'ci: the agent\n' },
      { do: 'sleep', ms: 20_000 },
    ],
    [{ do: 'terminal', tool: 'handoff' }],
  ],
};

/** main's files: the fixture's, and a people-only file the agent edits. */
const FILES = { 'README.md': '# demo\n', 'src/app.ts': 'app\n', '.github/workflows/ci.yml': 'ci: main\n' };

const cloneOf = (f: RunnerFixture, attemptId = 'T-4-a1') => f.paths.clone(FIXTURE_PROJECT, attemptId);

/** git status --porcelain's lines, sorted, without the leading space gitIn's trim takes from the first. */
const statusLines = (status: string) => status.split('\n').map((line) => line.trim()).sort();

const takeoverViolations = (f: RunnerFixture) =>
  f.events('attempt.violation').filter((event) => event.data.phase === 'takeover');

const sessionOf = (f: RunnerFixture, attemptId = 'T-4-a1') => f.store.get(attemptId)?.sessionRef as string;

/** Starts the attempt and waits until its agent has done the first turn's work. */
async function startWorking(f: RunnerFixture, attemptId = 'T-4-a1', overrides = {}) {
  const controller = f.controller(attemptId);
  await controller.start(f.spec({ attemptId, ...overrides }));
  await waitFor(() => existsSync(join(cloneOf(f, attemptId), 'README.md')) && f.events('attempt.spawned').length > 0);
  // ci.yml is the turn's last write: a stop that comes sooner (a SIGKILL under load) would find the turn half done.
  const ci = join(cloneOf(f, attemptId), '.github', 'workflows', 'ci.yml');
  await waitFor(() => controller.phase === 'turn' && existsSync(ci) && readFileSync(ci, 'utf8') === 'ci: the agent\n');
  return controller;
}

describe('AttemptController: take-over', () => {
  test("the person's git is on the task branch at the harvested head, with the uncommitted work as changes", async () => {
    const f = await createRunnerFixture({ files: FILES, script: WORKING });
    const controller = await startWorking(f);
    const outcome = await controller.prepareTakeover({ fence: FENCE, person: 'alice' });
    expect(outcome).toMatchObject({ ok: true });
    const [taken] = f.events('attempt.taken_over');
    const wipSha = taken?.data.wipSha as string;
    expect(wipSha).toMatch(/^[0-9a-f]{40}$/);
    expect(await gitIn(f.origin.path, ['rev-parse', WIP])).toBe(wipSha);
    const clone = cloneOf(f);
    expect(await gitIn(clone, ['symbolic-ref', 'HEAD'])).toBe(`refs/heads/${BRANCH}`);
    // The harvested head, under the WIP's snapshot commit and the commit that strips its protected changes.
    const head = await gitIn(clone, ['rev-parse', 'HEAD']);
    expect(await gitIn(f.origin.path, ['log', '-1', '--format=%s', head])).toBe('committed work');
    expect(await gitIn(f.origin.path, ['rev-list', '--count', `${head}..${wipSha}`])).toBe('2');
    const status = await gitIn(clone, ['status', '--porcelain=v1', '--untracked-files=all']);
    expect(statusLines(status)).toEqual(['?? uncommitted.txt', 'M README.md']);
    expect(existsSync(join(clone, '.envrc'))).toBe(false);
    expect(readFileSync(join(clone, '.github', 'workflows', 'ci.yml'), 'utf8')).toBe('ci: main\n');
    expect(existsSync(join(f.paths.forensics('T-4-a1'), 'git', 'HEAD'))).toBe(true);
    // The agent's .git is the one the runner made: nothing in it is reported.
    expect(takeoverViolations(f)).toEqual([]);
    // The agent was asked for its handoff note before it stopped.
    const transcript = readFileSync(join(clone, '.agflow', 'run', 'fake-transcripts', `${sessionOf(f)}.jsonl`), 'utf8');
    const prompts = transcript
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as TranscriptLine)
      .filter((line) => line.role === 'user')
      .map((line) => line.text);
    expect(prompts).toEqual(['Start working on T-4.', handoffPrompt(TAKEOVER_STOP_REASON)]);
    expect(f.events('attempt.exited')).toEqual([]);
    expect(f.fakes.claude?.launches).toHaveLength(1);
    expect(controller.session).toBeNull();
    await controller.settled();
    expect(f.events('attempt.exited')).toEqual([]);
    expect(f.store.processes('T-4-a1')).toEqual([]);
  }, 60_000);

  test('an agent .git with program-valued config, a hook, a commondir and an extra alternate is reported', async () => {
    const f = await createRunnerFixture({ files: FILES, script: WORKING });
    const controller = await startWorking(f);
    const gitDir = join(cloneOf(f), '.git');
    writeFileSync(
      join(gitDir, 'config'),
      `${await Bun.file(join(gitDir, 'config')).text()}[core]\n\thooksPath = .git/hooks\n\talternateRefsCommand = id\n` +
        '[alias]\n\tst = !sh -c id\n\tco = checkout\n[filter "x"]\n\tclean = cat\n[trailer "sign"]\n\tcmd = id\n' +
        '[submodule "lib"]\n\tupdate = !sh -c id\n[submodule "ok"]\n\tupdate = rebase\n[extensions]\n\tworktreeConfig = true\n',
    );
    // With extensions.worktreeConfig, git reads config.worktree too, and each linked worktree's own.
    writeFileSync(join(gitDir, 'config.worktree'), '[core]\n\tfsmonitor = id\n[gpg "ssh"]\n\tdefaultKeyCommand = id\n');
    mkdirSync(join(gitDir, 'worktrees', 'w1'), { recursive: true });
    writeFileSync(join(gitDir, 'worktrees', 'w1', 'config.worktree'), '[core]\n\tsshCommand = id\n');
    mkdirSync(join(gitDir, 'hooks'), { recursive: true });
    writeFileSync(join(gitDir, 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(join(gitDir, 'commondir'), '.\n');
    const other = join(f.home, 'other.git');
    await gitIn(f.home, ['init', '--quiet', '--bare', other]);
    const alternates = join(gitDir, 'objects', 'info', 'alternates');
    writeFileSync(alternates, `${await Bun.file(alternates).text()}${join(other, 'objects')}\n`);
    expect(await controller.prepareTakeover({ fence: FENCE, person: 'alice' })).toMatchObject({ ok: true });
    const violations = takeoverViolations(f);
    expect(violations.map((event) => event.data.paths)).toEqual([
      [
        '.git/config:core.hookspath',
        '.git/config:core.alternaterefscommand',
        '.git/config:alias.st',
        '.git/config:filter.x.clean',
        '.git/config:trailer.sign.cmd',
        '.git/config:submodule.lib.update',
        '.git/config.worktree:core.fsmonitor',
        '.git/config.worktree:gpg.ssh.defaultkeycommand',
        '.git/worktrees/w1/config.worktree:core.sshcommand',
        '.git/hooks/pre-commit',
        '.git/commondir',
        '.git/objects/info/alternates',
      ],
    ]);
    const [taken] = f.events('attempt.taken_over');
    expect(violations[0]?.seq).toBeLessThan(taken?.seq as number);
    expect(taken?.data.error).toBeNull();
  }, 60_000);

  test('a .git/hooks the runner cannot read is reported, and the take-over still goes through', async () => {
    const f = await createRunnerFixture({ files: FILES, script: WORKING });
    const controller = await startWorking(f);
    const hooks = join(cloneOf(f), '.git', 'hooks');
    mkdirSync(hooks, { recursive: true });
    chmodSync(hooks, 0o000);
    try {
      expect(await controller.prepareTakeover({ fence: FENCE, person: 'alice' })).toMatchObject({ ok: true });
    } finally {
      for (const dir of [hooks, join(f.paths.forensics('T-4-a1'), 'git', 'hooks')]) {
        if (existsSync(dir)) chmodSync(dir, 0o700);
      }
    }
    expect(takeoverViolations(f).map((event) => event.data.paths)).toEqual([['.git/hooks']]);
    const [taken] = f.events('attempt.taken_over');
    expect(taken?.data.error).toBeNull();
    expect(taken?.data.commands.local).toContain('--resume');
  }, 60_000);

  test("a nested .git the agent made is moved aside, so the person's git never runs its program", async () => {
    const f = await createRunnerFixture({ files: FILES, script: WORKING });
    const controller = await startWorking(f);
    const clone = cloneOf(f);
    const marker = join(f.home, 'fsmonitor-ran');
    // A nested repository, committed as a gitlink, whose fsmonitor git runs when status recurses into it.
    const sub = join(clone, 'sub');
    await gitIn(clone, ['init', '--quiet', 'sub']);
    await gitIn(sub, ['commit', '--quiet', '--allow-empty', '-m', 'nested']);
    const subHead = await gitIn(sub, ['rev-parse', 'HEAD']);
    await gitIn(clone, ['update-index', '--add', '--cacheinfo', `160000,${subHead},sub`]);
    await gitIn(clone, ['commit', '--quiet', '-m', 'a gitlink']);
    await gitIn(sub, ['config', 'core.fsmonitor', `touch '${marker}'; true`]);
    // A link named .git deeper down, and one inside the run directory, which the walk does not skip.
    mkdirSync(join(clone, 'deep', 'er'), { recursive: true });
    symlinkSync(join(f.home, 'elsewhere'), join(clone, 'deep', 'er', '.git'));
    mkdirSync(join(clone, '.agflow', 'run', 'x'), { recursive: true });
    writeFileSync(join(clone, '.agflow', 'run', 'x', '.git'), 'gitdir: /elsewhere\n');
    expect(await controller.prepareTakeover({ fence: FENCE, person: 'alice' })).toMatchObject({ ok: true });
    expect(existsSync(marker)).toBe(false);
    expect(await gitIn(clone, ['ls-files', '--stage', 'sub'])).toBe(`160000 ${subHead} 0\tsub`);
    for (const nested of ['sub/.git', 'deep/er/.git', '.agflow/run/x/.git']) {
      expect(lstatSync(join(clone, nested), { throwIfNoEntry: false })).toBeUndefined();
      // Kept for forensics under its path in the clone.
      expect(lstatSync(join(f.paths.forensics('T-4-a1'), 'nested', '1', nested), { throwIfNoEntry: false })).toBeDefined();
    }
    // The person's own git, with nothing of theirs configured, runs nothing the agent planted.
    await gitIn(clone, ['status']);
    await gitIn(clone, ['status', '--ignore-submodules=none']);
    expect(existsSync(marker)).toBe(false);
    const [violation] = takeoverViolations(f).map((event) => event.data.paths);
    expect(violation).toEqual(
      expect.arrayContaining(['.agflow/run/x/.git', 'deep/er/.git', 'sub/.git', 'sub/.git/config:core.fsmonitor']),
    );
    expect(f.events('attempt.taken_over')[0]?.data.error).toBeNull();
  }, 60_000);

  test('attempt.taken_over carries the local resume command of the pinned CLI, the anywhere command and the wipSha', async () => {
    const f = await createRunnerFixture({ files: FILES, script: WORKING });
    const claude = await startWorking(f);
    const codex = await startWorking(f, 'T-5-a1', {
      taskId: 'T-5',
      vendor: 'codex',
      branch: 'agflow/T-5-other',
      wipRef: 'refs/agflow/T-5/a1',
    });
    expect(await claude.prepareTakeover({ fence: FENCE, person: 'alice' })).toMatchObject({ ok: true });
    expect(await codex.prepareTakeover({ fence: FENCE, person: 'bob' })).toMatchObject({ ok: true });
    const taken = f.events('attempt.taken_over');
    const of = (attemptId: string) => taken.find((event) => event.attemptId === attemptId);
    const homes = vendorHomes(f.config, f.paths);
    const claudeBinary = join(f.paths.runner, 'vendor', 'claude', fixtureCliVersion('claude'), 'claude');
    const codexBinary = join(f.paths.runner, 'vendor', 'codex', fixtureCliVersion('codex'), 'bin', 'codex');
    expect(of('T-4-a1')?.data).toEqual({
      commands: {
        local: `cd ${realpathSync(cloneOf(f))} && CLAUDE_CONFIG_DIR=${homes.claude} ${claudeBinary} --resume ${sessionOf(f)}`,
        anywhere: takeoverAnywhereCommand({
          ref: WIP,
          branch: BRANCH,
          takeoverRef: takeoverRef(FIXTURE_WIP_PREFIX, 'T-4', 'alice'),
        }),
      },
      wipSha: await gitIn(f.origin.path, ['rev-parse', WIP]),
      error: null,
    });
    expect(of('T-5-a1')?.data.commands).toEqual({
      local: `cd ${realpathSync(cloneOf(f, 'T-5-a1'))} && CODEX_HOME=${homes.codex} ${codexBinary} resume --no-daemon ${sessionOf(f, 'T-5-a1')}`,
      anywhere: takeoverAnywhereCommand({
        ref: 'refs/agflow/T-5/a1',
        branch: 'agflow/T-5-other',
        takeoverRef: takeoverRef(FIXTURE_WIP_PREFIX, 'T-5', 'bob'),
      }),
    });
    expect(f.events('attempt.exited')).toEqual([]);
  }, 30_000);

  test('a failure after the agent stopped still reports attempt.taken_over, with local null and the error', async () => {
    const f = await createRunnerFixture({ files: FILES, script: WORKING });
    const controller = await startWorking(f);
    // The agent left a .git the harvest refuses: a file, not a directory.
    const gitDir = join(cloneOf(f), '.git');
    rmSync(gitDir, { recursive: true, force: true });
    writeFileSync(gitDir, 'gitdir: /somewhere/else\n');
    expect(await controller.prepareTakeover({ fence: FENCE, person: 'alice' })).toMatchObject({ ok: true });
    const [taken] = f.events('attempt.taken_over');
    expect(taken?.data).toMatchObject({ commands: { local: null }, wipSha: null });
    expect(taken?.data.commands.anywhere).toContain(`git fetch origin ${WIP}`);
    expect(taken?.data.error).toContain('is not a directory');
    expect(f.events('attempt.exited')).toEqual([]);
    expect(controller.session).toBeNull();
  }, 60_000);

  test('a prepare_takeover resent after a restart, with the agent gone, continues from the harvest', async () => {
    const f = await createRunnerFixture({ files: FILES, script: WORKING });
    const before = await startWorking(f);
    // The runner dies: its agent is killed at the next start, and a new controller knows only the record.
    process.kill(-(before.session?.pid as number), 'SIGKILL');
    await waitFor(() => f.events('attempt.exited').length > 0);
    await before.settled();
    const exited = f.events('attempt.exited').length;
    const after = f.controller('T-4-a1');
    expect(await after.prepareTakeover({ fence: { epoch: 1, counter: 2 }, person: 'alice' })).toEqual({
      ok: false,
      error: 'stale_fence',
    });
    expect(await after.prepareTakeover({ fence: FENCE, person: 'alice' })).toMatchObject({ ok: true });
    const [taken] = f.events('attempt.taken_over');
    expect(taken?.data.error).toBeNull();
    expect(taken?.data.commands.local).toContain('--resume');
    const clone = cloneOf(f);
    expect(await gitIn(clone, ['symbolic-ref', 'HEAD'])).toBe(`refs/heads/${BRANCH}`);
    const status = await gitIn(clone, ['status', '--porcelain=v1', '--untracked-files=all']);
    expect(statusLines(status)).toEqual(['?? uncommitted.txt', 'M README.md']);
    expect(takeoverViolations(f)).toEqual([]);
    expect(f.events('attempt.exited')).toHaveLength(exited);
  }, 60_000);
});

describe('takeoverCommands', () => {
  const base = {
    wipRefPrefix: FIXTURE_WIP_PREFIX,
    taskId: 'T-4',
    wipRef: WIP,
    branch: BRANCH,
    person: 'alice',
  };
  const local = {
    vendor: 'claude' as const,
    cliVersion: '2.1.0',
    sessionRef: 'session-1',
    clone: '/w/clone',
    runnerDir: '/r',
    home: '/h/claude',
  };
  const anywhere = takeoverAnywhereCommand({
    ref: WIP,
    branch: BRANCH,
    takeoverRef: takeoverRef(FIXTURE_WIP_PREFIX, 'T-4', 'alice'),
  });

  test('builds the Claude and Codex resume commands and the anywhere command', () => {
    expect(takeoverCommands({ ...base, local })).toEqual({
      local: 'cd /w/clone && CLAUDE_CONFIG_DIR=/h/claude /r/vendor/claude/2.1.0/claude --resume session-1',
      anywhere,
    });
    const codex = { ...local, vendor: 'codex' as const, sessionRef: 'thread-1', home: '/h/codex' };
    expect(takeoverCommands({ ...base, local: codex }).local).toBe(
      'cd /w/clone && CODEX_HOME=/h/codex /r/vendor/codex/2.1.0/bin/codex resume --no-daemon thread-1',
    );
  });

  test('gives local null without a session or a clone handed over, and anywhere still', () => {
    expect(takeoverCommands({ ...base, local: { ...local, sessionRef: null } })).toEqual({ local: null, anywhere });
    expect(takeoverCommands({ ...base, local: null })).toEqual({ local: null, anywhere });
  });

  test('quotes paths a shell would split, and a shell reads them back intact', () => {
    const root = mkdtempSync(join(tmpdir(), 'agflow-takeover-cmd-'));
    try {
      const clone = join(root, "the person's clone");
      const runnerDir = join(root, 'runner dir');
      const home = join(root, "home $HOME 'x'");
      mkdirSync(clone, { recursive: true });
      // A stand-in for the pinned CLI that prints where it ran and what it was given.
      const binary = join(runnerDir, vendorBinary('claude', local.cliVersion));
      mkdirSync(dirname(binary), { recursive: true });
      writeFileSync(binary, '#!/bin/sh\nprintf "%s\\n" "$PWD" "$CLAUDE_CONFIG_DIR" "$@"\n', { mode: 0o755 });
      const command = takeoverLocalCommand({ ...local, clone, runnerDir, home, sessionRef: "s 1'" });
      expect(command).toStartWith(`cd '${root}/the person'\\''s clone' && `);
      const ran = Bun.spawnSync(['sh', '-c', command as string], { stdout: 'pipe', stderr: 'pipe' });
      expect(ran.stderr.toString()).toBe('');
      expect(ran.stdout.toString().split('\n')).toEqual([clone, home, '--resume', "s 1'", '']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
