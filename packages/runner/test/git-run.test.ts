import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { originRepo } from '@agflow/testkit';
import {
  agentGitEnv,
  ensureRunnerGitFiles,
  GitError,
  gitOk,
  LOCAL_GIT_PINS,
  localGitEnv,
  RUN_DIR_EXCLUDE,
  remoteGitEnv,
  runGit,
} from '../src/git/run';
import { runnerPaths } from '../src/paths';

// Every test here runs git or agent processes, which take several times as long on a machine loaded by other suites.
setDefaultTimeout(30_000);

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tempDir(prefix = 'agflow-gitrun-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Sets process variables for one test and restores them afterwards. */
function withEnv(values: Record<string, string | undefined>): void {
  const saved = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  cleanups.push(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

/** A runner layout with its git files written. */
function runnerHome() {
  const paths = runnerPaths(tempDir('agflow-home-'));
  ensureRunnerGitFiles(paths);
  return paths;
}

/**
 * A TCP server that accepts connections and never answers, so a git fetch from it hangs. open() counts the accepted
 * connections that are still open: only a killed client (git's remote helper) closes one.
 */
async function silentServer(): Promise<{ url: string; open: () => number }> {
  const sockets: Socket[] = [];
  const closed = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.push(socket);
    socket.on('error', () => {});
    socket.on('close', () => closed.add(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return {
    url: `http://127.0.0.1:${address.port}/repo.git`,
    open: () => sockets.filter((socket) => !closed.has(socket)).length,
  };
}

const PINS = [
  'core.hooksPath=/dev/null',
  'core.fsmonitor=false',
  'core.pager=cat',
  'core.editor=false',
  'core.sshCommand=false',
  'core.askPass=',
  'credential.helper=',
  'diff.external=',
  'sequence.editor=false',
  'gpg.program=false',
  'protocol.allow=never',
  'protocol.file.allow=always',
  'gc.auto=0',
];

describe('the local environment', () => {
  test('carries GIT_CONFIG_NOSYSTEM, its global config, --no-optional-locks, the excludes and every pin', async () => {
    const paths = runnerHome();
    const local = localGitEnv(paths);
    expect(local.name).toBe('local');
    expect(local.env.GIT_CONFIG_NOSYSTEM).toBe('1');
    expect(local.env.GIT_CONFIG_GLOBAL).toBe(paths.gitConfig);
    expect(local.args).toContain('--no-optional-locks');
    expect<readonly string[]>(LOCAL_GIT_PINS).toEqual(PINS);
    const pairs = local.args.flatMap((arg, index) => (local.args[index - 1] === '-c' ? [arg] : []));
    expect(pairs).toEqual([`core.excludesFile=${paths.gitExcludes}`, ...PINS]);
    // git itself sees each pin, whatever the repository's own config says.
    const repo = tempDir();
    await runGit(local, ['init', '--quiet', repo]);
    const planted = '[core]\n\thooksPath = planted-hooks\n\tpager = less\n';
    writeFileSync(join(repo, '.git', 'config'), planted, { flag: 'a' });
    const listed = (await runGit(local, ['config', '--list', '--show-scope'], { cwd: repo })).stdout;
    // git lists keys in lower case.
    for (const pin of PINS) {
      const [key, value] = pin.split('=') as [string, string];
      expect(listed).toContain(`command\t${key.toLowerCase()}=${value}\n`);
    }
    expect((await runGit(local, ['config', '--get', 'core.hooksPath'], { cwd: repo })).stdout.trim()).toBe(
      '/dev/null',
    );
    expect(listed.split('\n').some((line) => line.startsWith('system') || line.startsWith('global'))).toBe(false);
  });

  test('ensureRunnerGitFiles writes the excludes, and a local status lists neither directory', async () => {
    const paths = runnerHome();
    expect(readFileSync(paths.gitExcludes, 'utf8')).toBe('.agflow/run/\n.claude/.cc-writes/\n');
    expect(existsSync(paths.gitConfig)).toBe(true);
    expect(statSync(join(paths.runner, 'git')).mode & 0o777).toBe(0o700);
    // Writing them again changes nothing.
    ensureRunnerGitFiles(paths);
    expect(readFileSync(paths.gitExcludes, 'utf8')).toBe('.agflow/run/\n.claude/.cc-writes/\n');
    const local = localGitEnv(paths);
    const work = tempDir();
    await runGit(local, ['init', '--quiet', work]);
    for (const file of ['.agflow/run/task.md', '.claude/.cc-writes/staged.json', '.claude/settings.json', 'a.txt']) {
      mkdirSync(join(work, file, '..'), { recursive: true });
      writeFileSync(join(work, file), 'x\n');
    }
    const status = await runGit(local, ['status', '--porcelain', '--untracked-files=all'], { cwd: work });
    expect(status.stdout.split('\n').filter(Boolean).sort()).toEqual(['?? .claude/settings.json', '?? a.txt']);
    expect(RUN_DIR_EXCLUDE).toBe(':(exclude,top).agflow/run');
    const listed = await runGit(local, ['ls-files', '--others', '--', '.', RUN_DIR_EXCLUDE], { cwd: work });
    expect(listed.stdout).not.toContain('.agflow/run');
  });

  test("never reads the owner's default ignore and attributes files", async () => {
    const home = tempDir();
    mkdirSync(join(home, '.config', 'git'), { recursive: true });
    writeFileSync(join(home, '.config', 'git', 'ignore'), 'a.txt\n');
    writeFileSync(join(home, '.config', 'git', 'attributes'), '* planted=yes\n');
    withEnv({ HOME: home, XDG_CONFIG_HOME: undefined });
    const local = localGitEnv(runnerHome());
    const work = tempDir();
    await runGit(local, ['init', '--quiet', work]);
    writeFileSync(join(work, 'a.txt'), 'x\n');
    expect((await runGit(local, ['status', '--porcelain'], { cwd: work })).stdout).toBe('?? a.txt\n');
    expect((await runGit(local, ['check-attr', '-a', '--', 'a.txt'], { cwd: work })).stdout).toBe('');
  });

  test("GIT_ variables in the runner's own environment never reach git", async () => {
    const paths = runnerHome();
    const repo = tempDir();
    await runGit(localGitEnv(paths), ['init', '--quiet', repo]);
    const bogus = join(tempDir(), 'nowhere');
    withEnv({
      GIT_DIR: bogus,
      GIT_WORK_TREE: bogus,
      GIT_INDEX_FILE: join(bogus, 'index'),
      GIT_CONFIG_PARAMETERS: "'user.planted'='parameters'",
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'user.counted',
      GIT_CONFIG_VALUE_0: 'count',
      GIT_CONFIG_GLOBAL: join(bogus, 'gitconfig'),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: bogus,
    });
    for (const environment of [localGitEnv(paths), await remoteGitEnv()]) {
      const inherited = Object.entries(environment.env).filter(
        ([name, value]) => name.startsWith('GIT_') && process.env[name] === value,
      );
      expect(inherited).toEqual([]);
      expect((await runGit(environment, ['rev-parse', '--absolute-git-dir'], { cwd: repo })).stdout.trim()).toBe(
        join(realpathSync(repo), '.git'),
      );
      expect(await gitOk(environment, ['config', '--get', 'user.planted'], { cwd: repo })).toBe(false);
      expect(await gitOk(environment, ['config', '--get', 'user.counted'], { cwd: repo })).toBe(false);
    }
  });
});

describe('the remote environment', () => {
  test("sees the owner's global config and adds the hook pins, no prompts and a BatchMode SSH command", async () => {
    const home = tempDir();
    writeFileSync(join(home, '.gitconfig'), '[credential]\n\thelper = planted-helper\n[core]\n\thooksPath = /owner\n');
    withEnv({ HOME: home, XDG_CONFIG_HOME: undefined });
    const remote = await remoteGitEnv();
    expect(remote.name).toBe('remote');
    expect(remote.timeoutMs).toBe(120_000);
    expect(remote.env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(remote.env.GIT_SSH_COMMAND).toBe('ssh -o BatchMode=yes');
    expect(remote.env.HOME).toBe(home);
    expect(remote.args).toEqual(['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false']);
    const cwd = tempDir();
    expect((await runGit(remote, ['config', '--get', 'credential.helper'], { cwd })).stdout.trim()).toBe(
      'planted-helper',
    );
    expect((await runGit(remote, ['config', '--get', 'core.hooksPath'], { cwd })).stdout.trim()).toBe('/dev/null');
    expect((await runGit(remote, ['config', '--get', 'core.fsmonitor'], { cwd })).stdout.trim()).toBe('false');
  });

  test("leaves the owner's core.sshCommand in force", async () => {
    const home = tempDir();
    writeFileSync(join(home, '.gitconfig'), '[core]\n\tsshCommand = ssh -i ~/.ssh/work\n');
    withEnv({ HOME: home, XDG_CONFIG_HOME: undefined });
    const remote = await remoteGitEnv();
    expect(remote.env.GIT_SSH_COMMAND).toBeUndefined();
  });

  test("probes core.sshCommand in the vault's context, so a conditional include of the owner's applies", async () => {
    const home = tempDir();
    writeFileSync(
      join(home, '.gitconfig'),
      '[includeIf "hasconfig:remote.*.url:git@github.com:work-org/**"]\n\tpath = ~/.gitconfig-work\n',
    );
    writeFileSync(join(home, '.gitconfig-work'), '[core]\n\tsshCommand = ssh -i ~/.ssh/id_work\n');
    withEnv({ HOME: home, XDG_CONFIG_HOME: undefined });
    const vault = join(tempDir(), 'demo.git');
    const local = localGitEnv(runnerHome());
    await runGit(local, ['init', '--quiet', '--bare', vault]);
    await runGit(local, [`--git-dir=${vault}`, 'config', 'remote.origin.url', 'git@github.com:work-org/demo.git']);
    expect((await remoteGitEnv({ gitDir: vault })).env.GIT_SSH_COMMAND).toBeUndefined();
    expect((await remoteGitEnv()).env.GIT_SSH_COMMAND).toBe('ssh -o BatchMode=yes');
  });

  test('is killed at the timeout with every helper git started, without blocking the event loop', async () => {
    const { url, open } = await silentServer();
    // A scratch HOME and no proxy variables, so git goes to the silent server and nowhere else.
    const remote = await remoteGitEnv({ base: { PATH: process.env.PATH ?? '', HOME: tempDir() }, timeoutMs: 400 });
    let ticks = 0;
    const ticker = setInterval(() => {
      ticks += 1;
    }, 20);
    const started = Date.now();
    const error = await runGit(remote, ['ls-remote', url], { cwd: tempDir() }).catch((caught: unknown) => caught);
    clearInterval(ticker);
    expect(error).toBeInstanceOf(GitError);
    expect(error).toMatchObject({ timedOut: true });
    expect((error as GitError).message).toContain(`git ls-remote ${url} timed out after 400 ms`);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(ticks).toBeGreaterThanOrEqual(10);
    // git's remote helper held the connection; killing the whole group closes it.
    const deadline = Date.now() + 2_000;
    while (open() > 0 && Date.now() < deadline) await Bun.sleep(20);
    expect(open()).toBe(0);
  });
});

describe('runGit', () => {
  test("a failure's error names the command and its stderr; check: false returns the result instead", async () => {
    const local = localGitEnv(runnerHome());
    const origin = await originRepo({ 'a.txt': 'a\n' });
    cleanups.push(() => origin.remove());
    const error = await runGit(local, [`--git-dir=${origin.path}`, 'rev-parse', '--verify', 'nope']).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(GitError);
    expect((error as GitError).message).toMatch(/^git --git-dir=\S+ rev-parse --verify nope failed \(exit 128\): /);
    expect((error as GitError).message).toContain('fatal: Needed a single revision');
    expect(error).toMatchObject({ code: 128, timedOut: false });
    const result = await runGit(local, [`--git-dir=${origin.path}`, 'rev-parse', 'nope'], { check: false });
    expect(result.code).toBe(128);
    expect(result.stderr).toContain('nope');
  });

  test('passes input, extra variables and the working directory, and gives raw output', async () => {
    const local = localGitEnv(runnerHome());
    const origin = await originRepo({ 'a.txt': 'a\n' });
    cleanups.push(() => origin.remove());
    const sha = await runGit(local, [`--git-dir=${origin.path}`, 'hash-object', '-w', '--stdin'], { input: 'hi\n' });
    expect(sha.stdout).toBe('45b983be36b73c0788dc9cbcb76cbb80fc7bb057\n');
    const index = join(tempDir(), 'index');
    await runGit(local, [`--git-dir=${origin.path}`, 'read-tree', 'main'], { env: { GIT_INDEX_FILE: index } });
    expect(existsSync(index)).toBe(true);
    const listed = await runGit(local, [`--git-dir=${origin.path}`, 'ls-tree', '-z', '--name-only', 'main']);
    expect(listed.stdout).toBe('a.txt\0');
  });

  test('gitOk tells whether git succeeded', async () => {
    const local = localGitEnv(runnerHome());
    const origin = await originRepo({ 'a.txt': 'a\n' });
    cleanups.push(() => origin.remove());
    expect(await gitOk(local, [`--git-dir=${origin.path}`, 'cat-file', '-e', origin.mainSha])).toBe(true);
    expect(await gitOk(local, [`--git-dir=${origin.path}`, 'cat-file', '-e', 'f'.repeat(40)])).toBe(false);
  });
});

describe('agentGitEnv', () => {
  test("gives the agent's credential-free git variables", () => {
    const run = '/work/demo/T-4-a1/.agflow/run';
    const env = agentGitEnv({
      gitconfig: `${run}/gitconfig`,
      sshRefusal: `${run}/bin/agflow-no-ssh`,
      ghConfigDir: `${run}/home/gh`,
      glabConfigDir: `${run}/home/glab`,
    });
    expect(env).toEqual({
      GIT_CONFIG_GLOBAL: `${run}/gitconfig`,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '/usr/bin/false',
      GIT_SSH_COMMAND: `${run}/bin/agflow-no-ssh`,
      GIT_SSH_VARIANT: 'ssh',
      GH_CONFIG_DIR: `${run}/home/gh`,
      GLAB_CONFIG_DIR: `${run}/home/glab`,
      GH_TOKEN: 'agflow-no-token',
      GITLAB_TOKEN: 'agflow-no-token',
    });
  });

  test('quotes a refusal script path that the shell would split', () => {
    const run = "/Users/Jane O'Neil/.agflow/work/demo/T-4-a1/.agflow/run";
    const env = agentGitEnv({
      gitconfig: `${run}/gitconfig`,
      sshRefusal: `${run}/ssh-refusal`,
      ghConfigDir: `${run}/home/.config/gh`,
      glabConfigDir: `${run}/home/.config/glab-cli`,
    });
    expect(env.GIT_SSH_COMMAND).toBe(`'/Users/Jane O'\\''Neil/.agflow/work/demo/T-4-a1/.agflow/run/ssh-refusal'`);
    expect(env.GIT_CONFIG_GLOBAL).toBe(`${run}/gitconfig`);
  });
});
