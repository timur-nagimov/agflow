import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitIn, type OriginRepo, originRepo } from '@agflow/testkit';
import { RunnerConfigSchema } from '../src/config';
import { buildAgentEnv } from '../src/env';
import { runnerPaths } from '../src/paths';
import { removeAgentTools, runDirOf, writeRunDir, withWorkingDirectory } from '../src/run-dir';

// Every test here runs git or agent processes, which take several times as long on a machine loaded by other suites.
setDefaultTimeout(30_000);

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function tempDir(prefix = 'agflow-rundir-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A runner-owned tools directory for one attempt; read-only once written, so the cleanup makes it writable. */
function toolsDir(): string {
  const tools = join(tempDir('agflow-tools-'), 'demo.agent', 'T-4-a1');
  cleanups.push(() => removeAgentTools(tools));
  return tools;
}

const identity = { name: 'Jane "JD" Doe', email: 'jane@example.com' };

function written(clone = tempDir(), tools = toolsDir()) {
  const runDir = writeRunDir({
    clone,
    tools,
    taskPack: '# T-4\nDo the thing.\n',
    brief: 'You are a worker.',
    identity,
  });
  return { clone, tools, runDir };
}

async function run(argv: string[], options: { cwd: string; env: Record<string, string> }) {
  const proc = Bun.spawn(argv, { ...options, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

describe('runDirOf', () => {
  test("names the clone's .agflow/run/ and, outside the clone, what unsandboxed processes run or read", () => {
    const run = '/w/T-4-a1/.agflow/run';
    const tools = '/h/vaults/demo.agent/T-4-a1';
    expect(runDirOf('/w/T-4-a1', tools)).toEqual({
      root: run,
      taskMd: `${run}/task.md`,
      briefMd: `${run}/brief.md`,
      home: `${run}/home`,
      cache: `${run}/cache`,
      tmp: `${run}/tmp`,
      config: `${run}/config`,
      tools,
      gitconfig: `${tools}/gitconfig`,
      bin: `${tools}/bin`,
      sshRefusal: `${tools}/ssh-refusal`,
      ghConfigDir: `${tools}/gh-config`,
      glabConfigDir: `${tools}/glab-config`,
    });
  });
});

describe('writeRunDir', () => {
  test('writes task.md, brief.md, an empty config/ directory and the other directories', () => {
    const { clone, tools, runDir } = written();
    expect(runDir).toEqual(runDirOf(clone, tools));
    expect(readFileSync(runDir.taskMd, 'utf8')).toBe('# T-4\nDo the thing.\n');
    expect(readFileSync(runDir.briefMd, 'utf8')).toBe('You are a worker.\n');
    expect(readdirSync(runDir.config)).toEqual([]);
    for (const dir of [runDir.home, runDir.cache, runDir.tmp, runDir.ghConfigDir, runDir.glabConfigDir]) {
      expect(statSync(dir).isDirectory()).toBe(true);
    }
    expect(readdirSync(runDir.ghConfigDir)).toEqual([]);
    expect(readdirSync(runDir.bin).sort()).toEqual(['gh', 'glab']);
    expect(readdirSync(tools).sort()).toEqual(['bin', 'gh-config', 'gitconfig', 'glab-config', 'ssh-refusal']);
  });

  test('makes the tools directory read-only, and removeAgentTools removes it', () => {
    const { tools, runDir } = written();
    for (const dir of [tools, runDir.bin, runDir.ghConfigDir, runDir.glabConfigDir]) {
      expect(statSync(dir).mode & 0o777).toBe(0o555);
    }
    expect(statSync(runDir.gitconfig).mode & 0o777).toBe(0o444);
    for (const script of [join(runDir.bin, 'gh'), join(runDir.bin, 'glab'), runDir.sshRefusal]) {
      expect(statSync(script).mode & 0o777).toBe(0o555);
    }
    removeAgentTools(tools);
    expect(existsSync(tools)).toBe(false);
    removeAgentTools(tools);
  });

  test('writes a gitconfig with the commit identity, no credential helper and local protocols only', async () => {
    const { runDir } = written();
    const get = (key: string) => gitIn(tmpdir(), ['config', '--file', runDir.gitconfig, '--get-all', key]);
    expect(await get('user.name')).toBe('Jane "JD" Doe');
    expect(await get('user.email')).toBe('jane@example.com');
    expect(await get('credential.helper')).toBe('');
    expect(await gitIn(tmpdir(), ['config', '--file', runDir.gitconfig, '--list'])).toContain('credential.helper=');
    expect(await get('protocol.allow')).toBe('never');
    expect(await get('protocol.file.allow')).toBe('always');
  });

  test('refuses an identity git config cannot hold', () => {
    const clone = tempDir();
    expect(() =>
      writeRunDir({ clone, tools: toolsDir(), taskPack: '', brief: '', identity: { name: 'a\nb', email: 'x@y' } }),
    ).toThrow('identity');
  });

  test('the gh and glab shims and the SSH refusal script exit non-zero with an explanation', async () => {
    const { clone, runDir } = written();
    for (const [argv, name] of [
      [[join(runDir.bin, 'gh'), 'pr', 'create'], 'gh'],
      [[join(runDir.bin, 'glab'), 'mr', 'create'], 'glab'],
      [[runDir.sshRefusal, 'git@github.com', 'git-receive-pack', 'x'], 'SSH'],
    ] as const) {
      const [script, ...args] = argv;
      // Executable shell scripts; run through /bin/sh, because macOS checks each new executable on its first run.
      expect(statSync(script).mode & 0o111).toBe(0o111);
      expect(readFileSync(script, 'utf8').startsWith('#!/bin/sh\n')).toBe(true);
      const result = await run(['/bin/sh', script, ...args], { cwd: clone, env: { PATH: '/usr/bin:/bin' } });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain(name);
      expect(result.stderr).toContain('the runner pushes');
    }
  });

  test('writing again replaces the files and keeps what the agent put in its directories', () => {
    const { clone, tools, runDir } = written();
    mkdirSync(join(runDir.cache, 'npm'), { recursive: true });
    writeRunDir({ clone, tools, taskPack: 'new pack\n', brief: 'new brief\n', identity });
    expect(readFileSync(runDir.taskMd, 'utf8')).toBe('new pack\n');
    expect(readFileSync(runDir.briefMd, 'utf8')).toBe('new brief\n');
    expect(existsSync(join(runDir.cache, 'npm'))).toBe(true);
  });

  test('follows no link the agent planted, and writes nothing outside the clone', () => {
    const outside = tempDir('agflow-outside-');
    const profile = join(outside, '.zshrc');
    writeFileSync(profile, 'export PATH=/usr/bin\n');
    const elsewhere = join(outside, 'dir');
    mkdirSync(elsewhere);
    const snapshot = () => [readFileSync(profile, 'utf8'), readdirSync(elsewhere)];
    const before = snapshot();
    const check = (clone: string) => {
      const runDir = runDirOf(clone, '/unused');
      expect(snapshot()).toEqual(before);
      for (const dir of [join(clone, '.agflow'), runDir.root, runDir.config, runDir.cache, runDir.home, runDir.tmp]) {
        expect(lstatSync(dir).isDirectory()).toBe(true);
      }
      for (const file of [runDir.taskMd, runDir.briefMd]) expect(lstatSync(file).isFile()).toBe(true);
    };
    // The whole run directory is a link.
    const linkedRun = tempDir();
    mkdirSync(join(linkedRun, '.agflow'));
    symlinkSync(elsewhere, join(linkedRun, '.agflow', 'run'));
    written(linkedRun);
    check(linkedRun);
    // .agflow itself is a link.
    const linkedAgflow = tempDir();
    symlinkSync(elsewhere, join(linkedAgflow, '.agflow'));
    written(linkedAgflow);
    check(linkedAgflow);
    // Files and directories inside it are links, as a committed `.agflow/run/task.md -> ~/.zshrc` would leave them.
    const { clone, tools } = written();
    const runDir = runDirOf(clone, tools);
    rmSync(runDir.taskMd);
    symlinkSync(profile, runDir.taskMd);
    rmSync(runDir.briefMd);
    symlinkSync(profile, runDir.briefMd);
    rmSync(runDir.config, { recursive: true });
    symlinkSync(elsewhere, runDir.config);
    rmSync(runDir.cache, { recursive: true });
    symlinkSync(elsewhere, runDir.cache);
    writeRunDir({ clone, tools, taskPack: 'pack\n', brief: 'brief', identity });
    check(clone);
    expect(readFileSync(runDir.taskMd, 'utf8')).toBe('pack\n');
  });

  test('replaces a tools directory someone changed, whatever is in it', () => {
    const { clone, tools, runDir } = written();
    removeAgentTools(tools);
    mkdirSync(runDir.bin, { recursive: true });
    writeFileSync(join(runDir.bin, 'git'), '#!/bin/sh\n');
    writeFileSync(runDir.gitconfig, '[core]\n\tfsmonitor = /tmp/x.sh\n');
    writeRunDir({ clone, tools, taskPack: '', brief: '', identity });
    expect(readdirSync(runDir.bin).sort()).toEqual(['gh', 'glab']);
    expect(readFileSync(runDir.gitconfig, 'utf8')).not.toContain('fsmonitor');
  });
});

describe('withWorkingDirectory', () => {
  test("appends 'Your working directory: <clone>'", () => {
    expect(withWorkingDirectory('You are a worker.', '/w/T-4-a1')).toBe(
      'You are a worker.\n\nYour working directory: /w/T-4-a1',
    );
    expect(withWorkingDirectory('You are a worker.\n', '/w/T-4-a1')).toBe(
      'You are a worker.\n\nYour working directory: /w/T-4-a1',
    );
  });
});

describe('git with the agent environment', () => {
  let repo: OriginRepo;

  async function agentClone() {
    repo = await originRepo({ 'a.txt': 'a\n' });
    cleanups.push(() => repo.remove());
    const clone = join(tempDir(), 'T-4-a1');
    await gitIn(tmpdir(), ['clone', '--quiet', repo.path, clone]);
    const tools = toolsDir();
    const runDir = writeRunDir({ clone, tools, taskPack: '', brief: '', identity });
    const config = RunnerConfigSchema.parse({ runnerKey: 'rk', machineId: 'M', name: 'laptop' });
    const env = buildAgentEnv({
      vendor: 'codex',
      spec: { attemptId: 'T-4-a1', role: 'worker', agentToken: 'agt', hubUrl: 'http://127.0.0.1:9' },
      clone,
      tools,
      tmpDir: null,
      config,
      paths: runnerPaths(tempDir()),
      base: { HOME: tempDir(), USER: 'owner' },
      env: {},
    });
    return { clone, runDir, env };
  }

  // git runs the freshly written SSH refusal script, and macOS checks each new executable on its first run.
  test('a push to an http or an ssh remote fails at once without prompting', async () => {
    const { clone, env } = await agentClone();
    // A remote that asks for a login, as a git host does.
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () =>
        new Response('login required', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="git"' } }),
    });
    cleanups.push(() => server.stop(true));
    const http = `http://127.0.0.1:${server.port}/acme/demo.git`;
    const ssh = 'ssh://git@127.0.0.1:1/acme/demo.git';
    // The agent gitconfig's protocol.allow=never stops both first.
    for (const url of [http, ssh]) {
      const started = Date.now();
      const result = await run(['git', 'push', url, 'HEAD:refs/heads/main'], { cwd: clone, env });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(/transport '(http|ssh)' not allowed/);
      expect(Date.now() - started).toBeLessThan(5_000);
    }
    // Past it, the refusal script answers SSH, and no prompt is shown for http.
    const allowed = ['git', '-c', 'protocol.allow=always', 'push'];
    const overSsh = await run([...allowed, ssh, 'HEAD:refs/heads/main'], { cwd: clone, env });
    expect(overSsh.code).not.toBe(0);
    expect(overSsh.stderr).toContain('is not available to runner agents');
    const started = Date.now();
    const overHttp = await run([...allowed, http, 'HEAD:refs/heads/main'], { cwd: clone, env });
    expect(overHttp.code).not.toBe(0);
    expect(overHttp.stderr).toContain('terminal prompts disabled');
    expect(Date.now() - started).toBeLessThan(5_000);
    // A fetch from the vault-like origin path still works: local protocols are allowed.
    expect((await run(['git', 'fetch', 'origin', 'main'], { cwd: clone, env })).code).toBe(0);
  }, 30_000);

  test('the agent git config is read-only: git config --global fails and changes nothing', async () => {
    const { clone, runDir, env } = await agentClone();
    const before = readFileSync(runDir.gitconfig, 'utf8');
    const result = await run(['git', 'config', '--global', 'core.fsmonitor', '/tmp/x.sh'], { cwd: clone, env });
    expect(result.code).not.toBe(0);
    expect(readFileSync(runDir.gitconfig, 'utf8')).toBe(before);
    expect((await run(['git', 'config', '--get', 'user.name'], { cwd: clone, env })).stdout.trim()).toBe(
      identity.name,
    );
  });
});
