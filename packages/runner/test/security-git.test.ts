// Design 7.3's planted-config test and section 15's credential-free agent git. An agent owns its clone's .git, so it
// can name a program in any key git runs: directly in .git/config, through include.path, or in config.worktree with
// extensions.worktreeConfig. The runner never runs git with that directory, so none of them may run during any of its
// operations on the clone: harvest, snapshot, detection, restore, a WIP push, a submission push, a take-over and a
// hand-back. Each test first proves the plants live, by running git in the clone as the agent would. The agent's own
// git may run what it planted, but never reaches a credential helper outside the clone.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { lateWorkRef } from '@agflow/core';
import { type FakeScript, gitIn } from '@agflow/testkit';
import { buildAgentEnv } from '../src/env';
import {
  cleanupRunnerFixtures,
  createRunnerFixture,
  FIXTURE_PROJECT,
  FIXTURE_WIP_PREFIX,
  type RunnerFixture,
  waitFor,
} from './fixture';
import { requireLsofOnMacOS } from './prerequisites';

afterEach(cleanupRunnerFixtures);

// Every test here runs git or agent processes, which take several times as long on a machine loaded by other suites.
setDefaultTimeout(30_000);

const FENCE = { epoch: 1, counter: 1 };
const BRANCH = 'agflow/T-4-tidy';
const WIP = 'refs/agflow/T-4/a1';

/**
 * main's files: every file goes through the planted clean and smudge filter, and .proc files through a process one.
 * Only an uncommitted .proc file is written: git runs the process filter as a protocol peer, and the planted one
 * would fail the agent's own git in the clone.
 */
const FILES = {
  'README.md': '# demo\n',
  'src/app.ts': 'app\n',
  '.gitattributes': '* filter=planted\n*.proc filter=byprocess\n',
};

/** The agent's work, all committed, in a turn that stays live; then the handoff turn a take-over asks for. */
const SCRIPT: FakeScript = {
  turns: [
    [
      { do: 'write', path: 'src/app.ts', content: 'tidy\n' },
      { do: 'commit', message: 'tidy the app' },
      { do: 'sleep', ms: 60_000 },
    ],
    [{ do: 'terminal', tool: 'handoff' }],
  ],
};

const METHODS = ['directly', 'through include.path', 'in config.worktree'] as const;
type Method = (typeof METHODS)[number];

/** The hooks planted both in .git/hooks and in the core.hooksPath directory. */
const HOOKS = ['pre-commit', 'post-checkout', 'reference-transaction', 'pre-push', 'post-index-change', 'post-merge'];

/** Shell-quoted, for a command git runs through sh. */
function quoted(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

/** A config value in double quotes, as git's config syntax reads it. */
function configString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

interface Planted {
  /** The keys and hooks that ran, one per line, in order. */
  fired(): string[];
  /** Forgets what ran so far. */
  reset(): void;
}

/**
 * Plants every program-valued key in a .git directory by the given method, and hooks in its hooks directory and in
 * the one core.hooksPath names. Every planted program is a shell command that appends its key to a marker file in
 * dir, outside the clone.
 */
function plant(gitDir: string, dir: string, method: Method): Planted {
  mkdirSync(dir, { recursive: true });
  const marker = join(dir, 'fired');
  const record = (key: string) => configString(`echo ${key} >> ${quoted(marker)}`);
  const hooksPath = join(dir, 'hooks');
  for (const hooks of [hooksPath, join(gitDir, 'hooks')]) {
    mkdirSync(hooks, { recursive: true });
    for (const hook of HOOKS) {
      writeFileSync(join(hooks, hook), `#!/bin/sh\necho hook ${hook} >> ${quoted(marker)}\n`, { mode: 0o755 });
    }
  }
  const keys = [
    '[core]',
    `\thooksPath = ${configString(hooksPath)}`,
    `\tfsmonitor = ${record('core.fsmonitor')}`,
    `\tsshCommand = ${record('core.sshCommand')}`,
    `\tpager = ${record('core.pager')}`,
    `\teditor = ${record('core.editor')}`,
    `\taskPass = ${record('core.askPass')}`,
    '[credential]',
    `\thelper = ${configString(`!echo credential.helper >> ${quoted(marker)}; echo username=agent; echo password=x`)}`,
    // What the agent's gitconfig forbids, a repository's config allows again.
    '[protocol]',
    '\tallow = always',
    '[diff]',
    `\texternal = ${record('diff.external')}`,
    '[sequence]',
    `\teditor = ${record('sequence.editor')}`,
    '[gpg]',
    `\tprogram = ${record('gpg.program')}`,
    // So a commit or tag made with this config would call gpg.program.
    '[commit]',
    '\tgpgSign = true',
    '[tag]',
    '\tgpgSign = true',
    '[filter "planted"]',
    `\tclean = ${configString(`cat; echo filter.planted.clean >> ${quoted(marker)}`)}`,
    `\tsmudge = ${configString(`cat; echo filter.planted.smudge >> ${quoted(marker)}`)}`,
    '[filter "byprocess"]',
    `\tprocess = ${record('filter.byprocess.process')}`,
    '[uploadpack]',
    `\tpackObjectsHook = ${record('uploadpack.packObjectsHook')}`,
    '',
  ].join('\n');
  const config = join(gitDir, 'config');
  if (method === 'directly') {
    appendFileSync(config, keys);
  } else if (method === 'through include.path') {
    const included = join(dir, 'planted.inc');
    writeFileSync(included, keys);
    appendFileSync(config, `[include]\n\tpath = ${configString(included)}\n`);
  } else {
    writeFileSync(join(gitDir, 'config.worktree'), keys);
    appendFileSync(config, '[extensions]\n\tworktreeConfig = true\n');
  }
  return {
    fired: () => (existsSync(marker) ? readFileSync(marker, 'utf8').split('\n').filter((line) => line !== '') : []),
    reset: () => rmSync(marker, { force: true }),
  };
}

/** Proves the plants live: the agent's git in the clone runs the fsmonitor, the hooks and both filters. */
async function proveLive(clone: string, planted: Planted): Promise<void> {
  // No optional locks: status then writes no index, so no hook runs before the runner's operations. None of these
  // commands changes the clone.
  await gitIn(clone, ['--no-optional-locks', 'status']);
  await gitIn(clone, ['hash-object', 'src/app.ts']);
  await gitIn(clone, ['hook', 'run', 'pre-commit']);
  await gitIn(clone, ['cat-file', '--filters', 'HEAD:src/app.ts']);
  const fired = planted.fired().join('\n');
  expect(fired).toContain('core.fsmonitor');
  expect(fired).toContain('filter.planted.clean');
  expect(fired).toContain('hook pre-commit');
  expect(fired).toContain('filter.planted.smudge');
  planted.reset();
}

const cloneOf = (f: RunnerFixture) => f.paths.clone(FIXTURE_PROJECT, 'T-4-a1');

/** Starts T-4-a1 and waits until its agent has committed its work and is in its long turn. */
async function startCommitted(f: RunnerFixture) {
  const controller = f.controller();
  await controller.start(f.spec());
  const clone = cloneOf(f);
  await waitFor(() => controller.phase === 'turn');
  for (;;) {
    if ((await gitIn(clone, ['log', '-1', '--format=%s'])) === 'tidy the app') return controller;
    await Bun.sleep(50);
  }
}

describe('planted git configuration', () => {
  for (const method of METHODS) {
    async function throughTakeover() {
      const f = await createRunnerFixture({ files: FILES, script: SCRIPT });
      const controller = await startCommitted(f);
      const clone = cloneOf(f);
      const head = await gitIn(clone, ['rev-parse', 'HEAD']);
      const planted = plant(join(clone, '.git'), join(f.home, 'planted'), method);
      await proveLive(clone, planted);

      // A submission push: the clone is clean, its work committed.
      const submitted = await controller.submit({
        fence: FENCE,
        submissionId: 'S-1',
        branch: BRANCH,
        expectedBranchSha: null,
        adoptable: [],
      });
      expect(submitted).toMatchObject({ ok: true, outcome: { ok: true, headSha: head } });
      expect(await gitIn(f.origin.path, ['rev-parse', `refs/heads/${BRANCH}`])).toBe(head);

      // Uncommitted work and a protected change: the harvest, the snapshot, the detection that strips it, a WIP push.
      writeFileSync(join(clone, 'src', 'app.ts'), 'tidier\n');
      writeFileSync(join(clone, 'notes.proc'), 'notes\n');
      writeFileSync(join(clone, '.envrc'), 'export X=1\n');
      expect(await controller.pushWip()).toMatchObject({ status: 'pushed', ref: WIP });
      expect(await gitIn(f.origin.path, ['show', `${WIP}:src/app.ts`])).toBe('tidier');
      expect(await gitIn(f.origin.path, ['show', `${WIP}:notes.proc`])).toBe('notes');
      expect(f.events('attempt.violation').map((event) => event.data)).toEqual([{ phase: 'wip', paths: ['.envrc'] }]);

      // A take-over: the stop, the final harvest and push, the restore that removes .envrc, and a new .git.
      expect(await controller.prepareTakeover({ fence: FENCE, person: 'alice' })).toMatchObject({ ok: true });
      expect(f.events('attempt.taken_over')[0]?.data.error).toBeNull();
      expect(existsSync(join(clone, '.envrc'))).toBe(false);
      expect(planted.fired()).toEqual([]);
      return { f, controller, clone, planted };
    }

    test(`keys planted ${method} never run in harvest, snapshot, detection, restore, WIP, submission and take-over`, async () => {
      await throughTakeover();
    }, 60_000);

    test.skipIf(process.platform !== 'darwin')(
      `keys planted ${method} never run in hand-back (the runner supports darwin-arm64 only; design 7.1)`,
      async () => {
        requireLsofOnMacOS();
        const { f, controller, clone, planted } = await throughTakeover();

        // The person's .git, planted the same way: the hand-back harvests it, pushes it and removes the clone.
        const again = plant(join(clone, '.git'), join(f.home, 'planted-again'), method);
        writeFileSync(join(clone, 'src', 'app.ts'), 'by a person\n');
        await proveLive(clone, again);
        expect(await controller.handBack({ source: { kind: 'clone' } })).toMatchObject({ ok: true });
        const late = lateWorkRef(FIXTURE_WIP_PREFIX, 'T-4-a1', 1);
        expect(await gitIn(f.origin.path, ['show', `${late}:src/app.ts`])).toBe('by a person');
        expect(existsSync(clone)).toBe(false);
        expect(planted.fired()).toEqual([]);
        expect(again.fired()).toEqual([]);
      },
      60_000,
    );
  }

  test("the agent's git, with a planted credential.helper and protocols allowed again, never reaches another helper", async () => {
    const f = await createRunnerFixture({ files: FILES, script: SCRIPT });
    await startCommitted(f);
    const clone = cloneOf(f);
    // The owner's own git configuration names a helper too, which the agent's git must never reach.
    const owner = join(f.home, 'owner');
    const ownerMarker = join(owner, 'helper-ran');
    mkdirSync(owner, { recursive: true });
    writeFileSync(
      join(owner, '.gitconfig'),
      `[credential]\n\thelper = ${configString(`!echo owner >> ${quoted(ownerMarker)}; echo password=secret`)}\n`,
    );
    const record = f.store.get('T-4-a1');
    const tools = f.paths.agentTools(FIXTURE_PROJECT, 'T-4-a1');
    const env = buildAgentEnv({
      vendor: 'claude',
      spec: f.spec(),
      clone,
      tools,
      tmpDir: record?.tmpDir ?? null,
      config: f.config,
      paths: f.paths,
      base: { HOME: owner, USER: process.env.USER },
    });
    // A remote that asks for a login, as a git host does, and records what it is offered.
    const offered: (string | null)[] = [];
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (request) => {
        offered.push(request.headers.get('authorization'));
        return new Response('login required', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="git"' } });
      },
    });
    const url = `http://127.0.0.1:${server.port}/acme/demo.git`;
    const agentGit = async (args: string[]) => {
      const run = Bun.spawn(['git', ...args], { cwd: clone, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
      const [stdout, stderr, code] = await Promise.all([
        new Response(run.stdout).text(),
        new Response(run.stderr).text(),
        run.exited,
      ]);
      return { stdout, stderr, code };
    };
    try {
      // As the runner left the clone, the agent's git uses no network protocol.
      const refused = await agentGit(['ls-remote', url]);
      expect(refused.code).not.toBe(0);
      expect(refused.stderr).toContain("transport 'http' not allowed");
      expect(offered).toEqual([]);

      const dir = join(f.home, 'planted');
      for (const method of METHODS) plant(join(clone, '.git'), join(dir, method), method);
      for (const args of [['ls-remote', url], ['push', url, 'HEAD:refs/heads/main']]) {
        const result = await agentGit(args);
        expect(result.code).not.toBe(0);
      }
      // The agent's own helpers answered, and nothing else: the owner's never ran, and no other secret was sent.
      const sent = offered.flatMap((authorization) =>
        authorization === null ? [] : [Buffer.from(authorization.replace(/^Basic /, ''), 'base64').toString()],
      );
      expect(sent.length).toBeGreaterThan(0);
      for (const credentials of sent) expect(credentials).toMatch(/^agent:x/);
      expect(existsSync(ownerMarker)).toBe(false);

      // Every helper the agent's git sees is the clone's own, or the empty one of the agent's gitconfig: no global,
      // XDG or system helper (Apple git's osxkeychain, say).
      expect(env.GIT_CONFIG_GLOBAL).toBe(join(tools, 'gitconfig'));
      const helpers = await agentGit(['config', '--show-scope', '--show-origin', '--get-all', 'credential.helper']);
      const lines = helpers.stdout.split('\n').filter((line) => line !== '');
      const outside = lines.filter((line) => !line.startsWith('local\t') && !line.startsWith('worktree\t'));
      expect(outside).toEqual([`global\tfile:${env.GIT_CONFIG_GLOBAL}\t`]);
      expect(lines.filter((line) => line.includes('echo username=agent'))).toHaveLength(METHODS.length);
    } finally {
      server.stop(true);
    }
  }, 30_000);
});
