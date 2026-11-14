import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCurrentGoal } from '@agflow/hub/src/goal';
import { listStandingRules } from '@agflow/hub/src/messages';
import { getProject } from '@agflow/hub/src/project';
import { PrepConfigSchema } from '@agflow/runner/src/prep/config';
import { UsageError, parseArgs } from '../src/args';
import { saveCredentials } from '../src/credentials';
import { KEYCHAIN_SERVICE, findOperatorToken, operatorTokenCommand } from '../src/operator-token';
import { type RunCommand, runCommand } from '../src/run';
import { describeStack, seedFiles } from '../src/seed';
import type { SpecFile } from '../src/spec';
import { type StartDeps, parseDeadline, repoOf, startCommand } from '../src/start';
import { HUB_URL, hubFixture } from './fixture';

const TOKEN = 'op-0123456789abcdef0123456789abcdef';
const NOW = Date.UTC(2026, 10, 15, 9, 0, 0);

/** Git with none of the developer's configuration, as the tests' own repositories need. */
const CLEAN_GIT = {
  PATH: process.env.PATH,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  XDG_CONFIG_HOME: '/nonexistent/agflow-test',
  GIT_AUTHOR_NAME: 'agflow test',
  GIT_AUTHOR_EMAIL: 'test@agflow.invalid',
  GIT_COMMITTER_NAME: 'agflow test',
  GIT_COMMITTER_EMAIL: 'test@agflow.invalid',
};

/** Runs git in dir and gives its trimmed output; a failure throws. */
async function gitIn(dir: string, args: string[]): Promise<string> {
  const ran = runCommand(['git', ...args], { env: CLEAN_GIT, cwd: dir });
  if (ran.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${ran.stderr}`);
  return ran.stdout.trim();
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix = 'agflow-start-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function capture() {
  const out: string[] = [];
  return { io: { out: (text: string) => void out.push(text), err: (text: string) => void out.push(text) }, text: () => out.join('') };
}

/** A command runner that answers security as the Keychain would, holding token or nothing, and records the calls. */
function keychain(token: string | null, calls: string[][] = []): RunCommand {
  return (argv) => {
    calls.push(argv);
    if (argv[0] === 'security' && argv[1] === 'find-generic-password' && token !== null) {
      return { code: 0, stdout: `${token}\n`, stderr: '' };
    }
    if (argv[0] === 'security' && argv[1] === 'add-generic-password') return { code: 0, stdout: '', stderr: '' };
    return { code: 44, stdout: '', stderr: 'The specified item could not be found in the keychain.' };
  };
}

describe('the operator token', () => {
  test('comes from AGFLOW_OPERATOR_TOKEN, then the Keychain, then ~/.agflow/operator-token', () => {
    const home = tempDir();
    mkdirSync(join(home, '.agflow'));
    writeFileSync(join(home, '.agflow', 'operator-token'), 'from-the-file\n', { mode: 0o600 });
    const calls: string[][] = [];
    const env = { AGFLOW_OPERATOR_TOKEN: 'from-the-env' };
    expect(findOperatorToken({ env, home, run: keychain('from-the-keychain', calls) })).toEqual({
      token: 'from-the-env',
      source: 'AGFLOW_OPERATOR_TOKEN',
    });
    expect(calls).toEqual([]);
    expect(findOperatorToken({ env: {}, home, run: keychain('from-the-keychain', calls) })).toEqual({
      token: 'from-the-keychain',
      source: `the Keychain item ${KEYCHAIN_SERVICE}`,
    });
    expect(calls).toEqual([['security', 'find-generic-password', '-s', 'agflow-operator', '-w']]);
    expect(findOperatorToken({ env: { AGFLOW_OPERATOR_TOKEN: '' }, home, run: keychain(null) })).toEqual({
      token: 'from-the-file',
      source: join(home, '.agflow', 'operator-token'),
    });
    expect(findOperatorToken({ env: {}, home: tempDir(), run: keychain(null) })).toBeNull();
  });

  test('agflow operator-token set puts the token from standard input in the Keychain', async () => {
    const calls: string[][] = [];
    const deps = { env: {}, home: tempDir(), run: keychain(null, calls), stdin: async () => `${TOKEN}\n` };
    const { io, text } = capture();
    expect(await operatorTokenCommand(parseArgs(['operator-token', 'set']), io, deps)).toBe(0);
    expect(calls).toEqual([['security', 'add-generic-password', '-U', '-a', 'agflow', '-s', 'agflow-operator', '-w', TOKEN]]);
    expect(text()).toContain('agflow-operator');
    const short = { ...deps, stdin: async () => 'short\n' };
    await expect(operatorTokenCommand(parseArgs(['operator-token', 'set']), io, short)).rejects.toThrow(UsageError);
    await expect(operatorTokenCommand(parseArgs(['operator-token']), io, deps)).rejects.toThrow(UsageError);
  });
});

describe('the seed files', () => {
  const specs: SpecFile[] = [
    { name: 'brief.md', bytes: new TextEncoder().encode('# Brief\n'), text: '# Brief\n' },
    { name: 'mockup.png', bytes: new TextEncoder().encode('PNG'), text: null },
  ];

  test('hold the spec, AGENTS.md, CLAUDE.md, the preparation and check config, the scripts and a .gitignore', () => {
    const files = seedFiles({ name: 'afisha', stack: 'python', specs });
    expect(files.map((file) => file.path)).toEqual([
      'SPEC.md',
      'docs/spec/brief.md',
      'docs/spec/mockup.png',
      'AGENTS.md',
      'CLAUDE.md',
      '.agflow/config.json',
      'scripts/install.sh',
      'scripts/check.sh',
      'scripts/demo.sh',
      '.gitignore',
    ]);
    const content = (path: string) => files.find((file) => file.path === path)?.content as string;
    expect(content('SPEC.md')).toContain('The spec is in docs/spec/mockup.png, and the first task transcribes it');
    expect(content('AGENTS.md')).toContain(describeStack('python'));
    for (const command of ['bash scripts/install.sh', 'bash scripts/check.sh', 'bash scripts/demo.sh']) {
      expect(content('AGENTS.md')).toContain(command);
    }
    expect(content('AGENTS.md')).toContain('SPEC.md is the source of truth');
    expect(content('CLAUDE.md')).toBe('@AGENTS.md\n');
    expect(JSON.parse(content('.agflow/config.json'))).toEqual({
      dependencies: [{ run: ['bash', 'scripts/install.sh'], when: ['scripts/install.sh', 'pyproject.toml', 'uv.lock'] }],
      check: 'bash scripts/check.sh',
    });
    expect(files.filter((file) => file.executable).map((file) => file.path)).toEqual([
      'scripts/install.sh',
      'scripts/check.sh',
      'scripts/demo.sh',
    ]);
    expect(content('.gitignore')).toContain('.venv/');
    const typescript = seedFiles({ name: 'afisha', stack: 'typescript', specs });
    expect(typescript.find((file) => file.path === '.gitignore')?.content).toContain('node_modules/');
  });

  test("the runner's reader takes the seeded .agflow/config.json, whatever the stack", () => {
    for (const stack of ['python', 'typescript', 'Go with Gin', null]) {
      const config = seedFiles({ name: 'afisha', stack, specs }).find((file) => file.path === '.agflow/config.json');
      const parsed = PrepConfigSchema.safeParse(JSON.parse(config?.content as string));
      expect([stack, parsed.error?.issues ?? []]).toEqual([stack, []]);
    }
  });

  test('the scripts pass in an empty project, and run the stack tools once its manifest is there', () => {
    const bin = join(tempDir(), 'bin');
    mkdirSync(bin);
    const log = join(tempDir(), 'tools.log');
    for (const tool of ['uv', 'bun', 'bunx', 'npm']) {
      writeFileSync(join(bin, tool), `#!/bin/sh\necho "${tool} $*" >> "${log}"\n`);
      chmodSync(join(bin, tool), 0o755);
    }
    const env = { PATH: `${bin}:/usr/bin:/bin` };
    const run = (stack: string | null, manifest: Record<string, string>): string[] => {
      const dir = tempDir();
      for (const file of seedFiles({ name: 'p', stack, specs })) {
        mkdirSync(join(dir, file.path, '..'), { recursive: true });
        writeFileSync(join(dir, file.path), file.content);
      }
      for (const [path, text] of Object.entries(manifest)) {
        mkdirSync(join(dir, path, '..'), { recursive: true });
        writeFileSync(join(dir, path), text);
      }
      writeFileSync(log, '');
      for (const script of ['install', 'check', 'demo']) {
        const ran = runCommand(['bash', `scripts/${script}.sh`], { env, cwd: dir });
        expect([stack, script, ran.code]).toEqual([stack, script, 0]);
      }
      return readFileSync(log, 'utf8').split('\n').filter(Boolean);
    };
    for (const stack of ['python', 'typescript', 'Go with Gin', null]) expect([stack, run(stack, {})]).toEqual([stack, []]);
    const python = { 'pyproject.toml': '[project]\nname = "p"\n\n[tool.ruff]\n\n[project.scripts]\ndemo = "p:main"\n', 'tests/test_p.py': '' };
    expect(run('python', python)).toEqual(['uv sync', 'uv run ruff check .', 'uv run pytest', 'uv run demo']);
    const typescript = { 'package.json': '{ "scripts": { "test": "bun test", "demo": "bun src/demo.ts" } }', 'tsconfig.json': '{}' };
    expect(run('typescript', typescript)).toEqual(['bun install', 'bunx tsc --noEmit', 'bun run test', 'bun run demo']);
    expect(run('typescript', { 'package.json': '{}', 'package-lock.json': '{}', 'src/a.test.ts': '' })).toEqual([
      'npm ci',
      'bun test',
    ]);
  });
});

describe('the arguments', () => {
  test('a repository is owner/name on GitHub or a URL git can clone', () => {
    expect(repoOf('acme/afisha')).toEqual({ url: 'https://github.com/acme/afisha', slug: 'acme/afisha', name: 'afisha' });
    expect(repoOf('git@github.com:acme/afisha.git')).toEqual({
      url: 'git@github.com:acme/afisha.git',
      slug: 'acme/afisha',
      name: 'afisha',
    });
    expect(repoOf('/srv/git/afisha.git')).toEqual({ url: '/srv/git/afisha.git', slug: null, name: 'afisha' });
  });

  test('a deadline is an ISO 8601 time or a span from now', () => {
    expect(parseDeadline(undefined, NOW)).toBeNull();
    expect(parseDeadline('+36h', NOW)).toBe('2026-11-16T21:00:00.000Z');
    expect(parseDeadline('+90m', NOW)).toBe('2026-11-15T10:30:00.000Z');
    expect(parseDeadline('2026-11-16T18:00+03:00', NOW)).toBe('2026-11-16T15:00:00.000Z');
    expect(() => parseDeadline('tomorrow', NOW)).toThrow(UsageError);
  });
});

describe('agflow start', () => {
  /** A hub, a saved login, an empty origin and a git that reads none of the developer's configuration. */
  async function setup(hubOverrides: Parameters<typeof hubFixture>[0] = { operatorToken: TOKEN, operatorUser: 'alice' }) {
    const hub = hubFixture(hubOverrides);
    const root = tempDir();
    const origin = join(root, 'afisha.git');
    await gitIn(root, ['init', '--quiet', '--bare', '--initial-branch=main', origin]);
    const configDir = join(root, 'config');
    saveCredentials({ hubUrl: HUB_URL, token: 'cli-token', user: 'alice' }, configDir);
    const env: Record<string, string | undefined> = { ...CLEAN_GIT, HOME: root, AGFLOW_OPERATOR_TOKEN: TOKEN };
    const deps: StartDeps = { env, home: root, run: runCommand, fetch: hub.fetch, configDir, now: () => NOW };
    const spec = join(root, 'brief.md');
    writeFileSync(spec, '# Afisha\nA poster of the week.\n');
    const mockup = join(root, 'mockup.png');
    writeFileSync(mockup, 'PNG');
    return { hub, root, origin, deps, spec, mockup };
  }

  test('seeds an empty repository and resets the hub to it', async () => {
    const s = await setup();
    const { io, text } = capture();
    const argv = ['start', '--spec', s.spec, '--spec', s.mockup, '--repo', s.origin, '--stack', 'python', '--deadline', '+36h'];
    expect(await startCommand(parseArgs(argv), io, s.deps)).toBe(0);

    const tree = await gitIn(s.origin, ['ls-tree', '-r', 'main']);
    expect(tree.split('\n').map((line) => line.split('\t')[1])).toEqual([
      '.agflow/config.json',
      '.gitignore',
      'AGENTS.md',
      'CLAUDE.md',
      'SPEC.md',
      'docs/spec/brief.md',
      'docs/spec/mockup.png',
      'scripts/check.sh',
      'scripts/demo.sh',
      'scripts/install.sh',
    ]);
    expect(tree).toContain('100755 blob');
    expect(await gitIn(s.origin, ['rev-list', '--count', 'main'])).toBe('1');
    expect(await gitIn(s.origin, ['show', 'main:docs/spec/mockup.png'])).toBe('PNG');

    expect(getProject(s.hub.ctx)).toMatchObject({ name: 'afisha', repo: s.origin, paused: false });
    expect(s.hub.ctx.db.query('SELECT deadline_at FROM project').get()).toEqual({
      deadline_at: Date.parse('2026-11-16T21:00:00Z'),
    });
    expect(getCurrentGoal(s.hub.ctx)?.text).toBe(
      `Implement SPEC.md completely (it is in the repository root). Stack: ${describeStack('python')}. ` +
        'Deadline: 2026-11-16 21:00 UTC. When SPEC.md is covered, keep improving the product (defects, tests, demo ' +
        'polish, new features) until the deadline.',
    );
    expect(listStandingRules(s.hub.ctx).map((rule) => rule.body)).toEqual([
      expect.stringContaining(`Stack: ${describeStack('python')}.`),
    ]);
    expect(text()).toContain('docs/spec/mockup.png: SPEC.md asks the first task to transcribe it');
    expect(text()).toContain(`The hub's project is now "afisha"`);
    expect(text()).toContain(HUB_URL);
  });

  test('a repository with commits gets the seed as a new commit on top', async () => {
    const s = await setup();
    const { io } = capture();
    const argv = ['start', '--spec', s.spec, '--repo', s.origin, '--name', 'poster'];
    expect(await startCommand(parseArgs(argv), io, s.deps)).toBe(0);
    const first = await gitIn(s.origin, ['rev-parse', 'main']);
    writeFileSync(s.spec, '# Afisha\nA poster of the month.\n');
    expect(await startCommand(parseArgs(argv), io, s.deps)).toBe(0);
    expect(await gitIn(s.origin, ['rev-parse', 'main^'])).toBe(first);
    expect(await gitIn(s.origin, ['show', 'main:SPEC.md'])).toBe('# Afisha\nA poster of the month.');
    expect(getProject(s.hub.ctx).name).toBe('poster');
    expect(s.hub.ctx.db.query('SELECT epoch FROM project').get()).toEqual({ epoch: 3 });
  });

  test("the seed goes on the hub's main branch, whatever the repository's default branch is", async () => {
    // A repository whose only branch is master: main starts from it, with the seed on top.
    const s = await setup();
    const old = join(s.root, 'old.git');
    await gitIn(s.root, ['init', '--quiet', '--bare', '--initial-branch=master', old]);
    const work = join(s.root, 'old');
    await gitIn(s.root, ['clone', '--quiet', old, work]);
    writeFileSync(join(work, 'README.md'), '# Old\n');
    await gitIn(work, ['add', 'README.md']);
    await gitIn(work, ['commit', '--quiet', '-m', 'Old work']);
    await gitIn(work, ['push', '--quiet', 'origin', 'HEAD:refs/heads/master']);
    const { io, text } = capture();
    expect(await startCommand(parseArgs(['start', '--spec', s.spec, '--repo', old]), io, s.deps)).toBe(0);
    expect(await gitIn(old, ['rev-parse', 'main^'])).toBe(await gitIn(old, ['rev-parse', 'master']));
    expect(await gitIn(old, ['show', 'main:CLAUDE.md'])).toBe('@AGENTS.md');
    expect(text()).toContain('(main at ');

    // A hub whose main branch is trunk (AGFLOW_MAIN_BRANCH) gets the seed of an empty repository there.
    const t = await setup({ operatorToken: TOKEN, operatorUser: 'alice', mainBranch: 'trunk' });
    expect(await startCommand(parseArgs(['start', '--spec', t.spec, '--repo', t.origin]), io, t.deps)).toBe(0);
    expect(await gitIn(t.origin, ['for-each-ref', '--format=%(refname)', 'refs/heads/'])).toBe('refs/heads/trunk');
  });

  test('--create makes the private repository with gh and gives the collaborators write access', async () => {
    const s = await setup();
    // gh is a stand-in, and git takes github.com from a local folder.
    const github = join(s.root, 'github');
    const bin = join(s.root, 'bin');
    mkdirSync(bin);
    const log = join(s.root, 'gh.log');
    writeFileSync(
      join(bin, 'gh'),
      `#!/bin/sh\necho "$*" >> "${log}"\ncase "$1 $2" in\n  "repo view") exit 1;;\n  "repo create") git init --quiet --bare --initial-branch=main "${github}/$3";;\n` +
        `  "api -X") echo '{"id":1}';;\nesac\n`,
    );
    chmodSync(join(bin, 'gh'), 0o755);
    s.deps.env = {
      ...s.deps.env,
      PATH: `${bin}:${process.env.PATH}`,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `url.${github}/.insteadOf`,
      GIT_CONFIG_VALUE_0: 'https://github.com/',
    };
    const { io, text } = capture();
    const argv = ['start', '--spec', s.spec, '--repo', 'acme/afisha', '--create', '--collaborator', 'bob'];
    expect(await startCommand(parseArgs(argv), io, s.deps)).toBe(0);
    // GitHub invites bob, who must accept before his runner can fetch the repository.
    expect(text()).toContain('Invited bob to acme/afisha with write access');
    expect(text()).toContain('https://github.com/acme/afisha/invitations');
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual([
      'repo view acme/afisha --json name',
      'repo create acme/afisha --private',
      'api -X PUT repos/acme/afisha/collaborators/bob -f permission=push',
    ]);
    expect(await gitIn(join(github, 'acme/afisha'), ['show', 'main:CLAUDE.md'])).toBe('@AGENTS.md');
    expect(getProject(s.hub.ctx)).toMatchObject({ name: 'afisha', repo: 'https://github.com/acme/afisha' });
  });

  test('says what is missing: the spec, the hub, the token, or the hub operator routes', async () => {
    const s = await setup({});
    const { io } = capture();
    const start = (argv: string[], deps = s.deps) => startCommand(parseArgs(['start', ...argv]), io, deps);
    await expect(start(['--repo', s.origin])).rejects.toThrow(UsageError);
    await expect(start(['--spec', join(s.root, 'none.md'), '--repo', s.origin])).rejects.toThrow(/no spec file/);
    await expect(start(['--spec', s.spec, '--repo', s.origin], { ...s.deps, configDir: join(s.root, 'nowhere') })).rejects.toThrow(
      /no hub/,
    );
    const tokenless = { ...s.deps, env: { ...s.deps.env, AGFLOW_OPERATOR_TOKEN: undefined }, run: keychain(null) };
    await expect(start(['--spec', s.spec, '--repo', s.origin], tokenless)).rejects.toThrow(/no operator token/);
    // This hub has no operator token, so it has no operator routes.
    await expect(start(['--spec', s.spec, '--repo', s.origin])).rejects.toThrow(/no operator routes/);
  });
});
