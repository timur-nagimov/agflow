import { afterEach, describe, expect, test } from 'bun:test';
import {
  closeSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import { RunnerConfigSchema, vendorHomes } from '../../src/config';
import { buildAgentEnv } from '../../src/env';
import { projectKey, runnerPaths } from '../../src/paths';
import { PrepConfigSchema } from '../../src/prep/config';
import {
  prepEntryKey,
  prepEnv,
  prepLayout,
  prepPolicy,
  PrepState,
  prepToolConfig,
  sharesCache,
  whenFingerprint,
  writePrepToolConfig,
} from '../../src/prep/plan';
import { deniedReadPaths, profileOf } from '../../src/profile';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function directory(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agflow-prep-plan-'));
  dirs.push(dir);
  return dir;
}

describe('whenFingerprint', () => {
  test('tracks bytes, names and order; missing is distinct from an empty file', () => {
    const clone = directory();
    const missing = whenFingerprint(clone, ['package.json']);
    writeFileSync(join(clone, 'package.json'), '');
    const empty = whenFingerprint(clone, ['package.json']);
    expect(empty).not.toBe(missing);
    writeFileSync(join(clone, 'package.json'), '{}');
    const present = whenFingerprint(clone, ['package.json']);
    expect(present).toMatch(/^[a-f0-9]{64}$/);
    expect(present).not.toBe(empty);
    expect(whenFingerprint(clone, ['package.json'])).toBe(present);
    expect(whenFingerprint(clone, ['a', 'b'])).not.toBe(whenFingerprint(clone, ['b', 'a']));
    expect(whenFingerprint(clone, ['a'])).not.toBe(whenFingerprint(clone, ['b']));
    expect(whenFingerprint(clone, [])).toBe(whenFingerprint(clone, []));
  });

  test('hashes link target strings, never their contents or symlinked parents', () => {
    const clone = directory();
    const outside = directory();
    writeFileSync(join(outside, 'lock'), 'secret one');
    symlinkSync(join(outside, 'lock'), join(clone, 'lock'));
    symlinkSync(outside, join(clone, 'parent'));
    const link = whenFingerprint(clone, ['lock']);
    const parent = whenFingerprint(clone, ['parent/lock']);
    writeFileSync(join(outside, 'lock'), 'secret two');
    expect(whenFingerprint(clone, ['lock'])).toBe(link);
    expect(whenFingerprint(clone, ['parent/lock'])).toBe(parent);
    rmSync(join(clone, 'lock'));
    symlinkSync('missing-target', join(clone, 'lock'));
    expect(whenFingerprint(clone, ['lock'])).not.toBe(link);
  });

  test('tells one path apart as missing, a directory and a FIFO, without reading them', () => {
    const clone = directory();
    const missing = whenFingerprint(clone, ['lock']);
    mkdirSync(join(clone, 'lock'));
    const dir = whenFingerprint(clone, ['lock']);
    writeFileSync(join(clone, 'lock/child'), 'ignored');
    expect(whenFingerprint(clone, ['lock'])).toBe(dir);
    rmSync(join(clone, 'lock'), { recursive: true });
    expect(Bun.spawnSync(['mkfifo', join(clone, 'lock')]).exitCode).toBe(0);
    const fifo = whenFingerprint(clone, ['lock']);
    expect(new Set([missing, dir, fifo]).size).toBe(3);
    expect(() => whenFingerprint(clone, ['../secret'])).toThrow();
  });

  test('tells one parent apart as missing, a file and a linked directory', () => {
    const clone = directory();
    const outside = directory();
    writeFileSync(join(outside, 'lock'), 'content');
    const missing = whenFingerprint(clone, ['x/lock']);
    writeFileSync(join(clone, 'x'), '');
    const file = whenFingerprint(clone, ['x/lock']);
    rmSync(join(clone, 'x'));
    symlinkSync(outside, join(clone, 'x'));
    const linked = whenFingerprint(clone, ['x/lock']);
    expect(new Set([missing, file, linked]).size).toBe(3);
  });

  test('refuses an oversized when-file without reading it', () => {
    const clone = directory();
    const fd = openSync(join(clone, 'bun.lock'), 'w');
    try {
      // Sparse: 8 GiB of size, almost no disk.
      ftruncateSync(fd, 8 * 1024 ** 3);
    } finally {
      closeSync(fd);
    }
    expect(statSync(join(clone, 'bun.lock')).size).toBe(8 * 1024 ** 3);
    expect(() => whenFingerprint(clone, ['bun.lock'])).toThrow('when-file bun.lock exceeds 64 MiB');
  });
});

describe('PrepState', () => {
  test('persists fingerprints per attempt and entry under the project state directory', () => {
    const paths = runnerPaths(directory());
    const prep = paths.prep(projectKey('https://hub.example', 'demo'));
    const state = new PrepState(prep);
    expect(state.attempts()).toEqual([]);
    expect(state.needs('T-1-a1', 'entry', 'one')).toBe(true);
    state.record('T-1-a1', 'entry', 'one');
    state.record('T-1-a1', 'second', 'two');
    expect(new PrepState(prep).needs('T-1-a1', 'entry', 'one')).toBe(false);
    expect(state.needs('T-1-a1', 'second', 'two')).toBe(false);
    expect(state.needs('T-1-a1', 'entry', 'changed')).toBe(true);
    expect(state.needs('T-1-a2', 'entry', 'one')).toBe(true);
    expect(JSON.parse(readFileSync(join(prep, 'state/T-1-a1.json'), 'utf8'))).toEqual({ entry: 'one', second: 'two' });
    expect(readdirSync(join(prep, 'state'))).toEqual(['T-1-a1.json']);
    expect(state.attempts()).toEqual(['T-1-a1']);
    state.forget('T-1-a1');
    state.forget('T-1-a1');
    expect(state.needs('T-1-a1', 'entry', 'one')).toBe(true);
    expect(state.attempts()).toEqual([]);
  });

  test('corrupt state reruns preparation and unsafe attempt ids are refused', () => {
    const prep = directory();
    const state = new PrepState(prep);
    state.record('a', 'entry', 'one');
    for (const invalid of ['{', 'null', '[]', '{"entry":12}']) {
      writeFileSync(join(prep, 'state/a.json'), invalid);
      expect(state.needs('a', 'entry', 'one')).toBe(true);
    }
    state.record('a', '__proto__', 'fingerprint');
    expect(state.needs('a', '__proto__', 'fingerprint')).toBe(false);
    for (const id of ['../a', '.', '..', '/a', 'a/b', '']) {
      expect(() => state.needs(id, 'entry', 'one')).toThrow();
      expect(() => state.record(id, 'entry', 'one')).toThrow();
      expect(() => state.forget(id)).toThrow();
    }
  });

  test('entry keys change with argv, when or scripts', () => {
    const entry = PrepConfigSchema.parse({
      dependencies: [{ run: ['bun', 'install'], when: ['bun.lock'] }],
    }).dependencies[0]!;
    const key = prepEntryKey(entry);
    expect(prepEntryKey({ ...entry })).toBe(key);
    for (const changed of [{ run: ['npm', 'ci'] }, { when: ['package.json'] }, { scripts: true }]) {
      expect(prepEntryKey({ ...entry, ...changed })).not.toBe(key);
    }
  });
});

function environment(vendor: 'claude' | 'codex') {
  const home = directory();
  const paths = runnerPaths(join(home, '.agflow'));
  const clone = paths.clone('demo', 'a1');
  const prep = paths.prep('demo');
  const config = RunnerConfigSchema.parse({
    runnerKey: 'runner',
    machineId: 'machine',
    name: 'laptop',
    connectivity: { HTTPS_PROXY: 'http://proxy:3128' },
  });
  const secrets = {
    ANTHROPIC_API_KEY: 'secret',
    OPENAI_API_KEY: 'secret',
    AWS_SECRET_ACCESS_KEY: 'secret',
    NPM_TOKEN: 'secret',
    AGFLOW_HOME: 'secret',
    AGFLOW_TEST: '1',
    CLAUDE_CODE_SECRET: 'secret',
    CODEX_SECRET: 'secret',
    SSH_AUTH_SOCK: '/ssh',
    SSH_ASKPASS: '/ask',
    GIT_CONFIG_PARAMETERS: 'secret',
    RUNNER_PRIVATE: 'secret',
  };
  const agentEnv = buildAgentEnv({
    vendor,
    clone,
    paths,
    config,
    tools: paths.agentTools('demo', 'a1'),
    tmpDir: '/tmp/agf/abcdef',
    spec: {
      attemptId: 'a1',
      role: 'worker',
      agentToken: 'agt_secret',
      hubUrl: 'https://hub',
    },
    base: { HOME: home, USER: 'owner', LANG: 'en_US.UTF-8', ...secrets },
    env: {},
  });
  return {
    home,
    paths,
    clone,
    prep,
    config,
    agentEnv,
    secrets,
    tmpDir: join(prep, 'tmp/a1'),
  };
}

const bunInstall = { run: ['bun', 'install', '--frozen-lockfile'] };

describe('sharesCache', () => {
  test('only known installs with scripts off share the cache', () => {
    for (const run of [
      ['bun', 'install'],
      ['bun', 'i', '--frozen-lockfile'],
      ['/opt/homebrew/bin/bun', 'install'],
      ['npm', 'ci'],
      ['npm', 'install'],
      ['npm', 'i'],
      ['pnpm', 'install'],
      ['pnpm', 'i'],
      ['pnpm', 'fetch'],
    ]) {
      expect(sharesCache({ run })).toBe(true);
      expect(sharesCache({ run, scripts: true })).toBe(false);
    }
    for (const run of [
      ['bun'],
      ['bun', 'add', 'left-pad'],
      ['bun', 'run', 'install'],
      ['./bun', 'install'],
      ['node_modules/.bin/pnpm', 'install'],
      ['npm', '--prefix', 'app', 'ci'],
      ['yarn', 'install'],
      ['python3', '-m', 'pip', 'install', '-r', 'requirements.txt'],
      ['pip', 'install'],
      ['uv', 'sync'],
      ['poetry', 'install'],
      ['sh', '-c', 'bun install'],
    ]) {
      expect(sharesCache({ run })).toBe(false);
    }
  });
});

describe('prepEnv', () => {
  test.each(['claude', 'codex'] as const)(
    'removes bridge, SSH and vendor variables from %s, preserving the allowlist',
    (vendor) => {
      const input = environment(vendor);
      const before = { ...input.agentEnv };
      const env = prepEnv({ ...input, entry: bunInstall });
      for (const key of Object.keys(input.secrets)) expect(env[key]).toBeUndefined();
      expect(Object.keys(env).filter((key) => /^(AGFLOW_|CLAUDE_|CODEX_)/.test(key))).toEqual([]);
      expect(env.DISABLE_AUTOUPDATER).toBeUndefined();
      for (const key of ['PATH', 'USER', 'LANG', 'HTTPS_PROXY', 'GIT_CONFIG_GLOBAL', 'GIT_SSH_COMMAND', 'GH_TOKEN']) {
        expect(env[key]).toBe(input.agentEnv[key]!);
      }
      expect(env.HOME).toBe(join(input.clone, '.agflow/run/home'));
      expect(env.TMPDIR).toBe(input.tmpDir);
      expect(env.npm_config_ignore_scripts).toBe('true');
      expect(input.agentEnv).toEqual(before);
      const defensive = prepEnv({
        ...input,
        entry: bunInstall,
        agentEnv: {
          ...input.agentEnv,
          SSH_AUTH_SOCK: '/ssh',
          SSH_ASKPASS: '/ask',
        },
      });
      expect(defensive.SSH_AUTH_SOCK).toBeUndefined();
      expect(defensive.SSH_ASKPASS).toBeUndefined();
    },
  );

  test.each([
    ['a known install', bunInstall, true],
    ['an install with scripts', { ...bunInstall, scripts: true }, false],
    ['pip', { run: ['python3', '-m', 'pip', 'install', '-r', 'requirements.txt'] }, false],
  ] as const)('cache isolation, script switches and copy/clone settings for %s', (_, entry, shared) => {
    const input = environment('claude');
    Object.assign(input.agentEnv, {
      npm_config_ignore_scripts: 'true',
      npm_config_ignore_pnpmfile: 'true',
      YARN_ENABLE_SCRIPTS: 'false',
      XDG_CONFIG_HOME: join(input.home, '.config'),
    });
    const env = prepEnv({ ...input, entry });
    const perAttempt = join(input.clone, '.agflow/run/cache');
    const cache = shared ? join(input.prep, 'cache') : perAttempt;
    for (const [key, name] of Object.entries({
      BUN_INSTALL_CACHE_DIR: 'bun',
      npm_config_cache: 'npm',
      PIP_CACHE_DIR: 'pip',
      UV_CACHE_DIR: 'uv',
      npm_config_store_dir: 'pnpm',
    }))
      expect(env[key]).toBe(join(cache, name));
    expect(env.GOMODCACHE).toBe(join(perAttempt, 'go-mod'));
    expect(env.CARGO_HOME).toBe(join(perAttempt, 'cargo'));
    const scripts = 'scripts' in entry && entry.scripts;
    const switches = {
      npm_config_ignore_scripts: 'true',
      npm_config_ignore_pnpmfile: 'true',
      YARN_ENABLE_SCRIPTS: 'false',
    };
    for (const [key, value] of Object.entries(switches)) {
      if (scripts) expect(env[key]).toBeUndefined();
      else expect(env[key]).toBe(value);
    }
    // Runner-owned, never the agent-writable HOME: Bun reads its global bunfig there instead of $HOME/.bunfig.toml.
    expect(env.XDG_CONFIG_HOME).toBe(join(input.prep, 'config', scripts ? 'scripts' : 'noscripts'));
    expect(env.XDG_CONFIG_HOME).toBe(prepToolConfig(input.prep, scripts));
    expect(env.npm_config_package_import_method).toBe('clone-or-copy');
    expect(env.UV_LINK_MODE).toBe('clone');
    expect(env.PIP_CONFIG_FILE).toBe('/dev/null');
    expect(env.npm_config_userconfig).toBe('/dev/null');
  });

  test('writes the no-scripts bunfig and an empty scripts directory, replacing a stale file', () => {
    const prep = directory();
    writePrepToolConfig(prep);
    const noScripts = prepToolConfig(prep, false);
    writeFileSync(join(noScripts, '.bunfig.toml'), '[install]\nignoreScripts = false\n');
    writePrepToolConfig(prep);
    expect(readFileSync(join(noScripts, '.bunfig.toml'), 'utf8')).toBe('[install]\nignoreScripts = true\n');
    expect(readdirSync(noScripts)).toEqual(['.bunfig.toml']);
    expect(readdirSync(prepToolConfig(prep, true))).toEqual([]);
    expect(statSync(noScripts).mode & 0o777).toBe(0o700);
  });
});

describe('prepPolicy', () => {
  test.each([
    ['a known install', bunInstall, true],
    ['an install with scripts', { ...bunInstall, scripts: true }, false],
    ['pip', { run: ['python3', '-m', 'pip', 'install', '.'] }, false],
  ] as const)('supplies complete per-call lists for %s', (_, entry, shared) => {
    const input = environment('claude');
    const layout = prepLayout(input.prep);
    expect(layout).toEqual({
      cache: join(input.prep, 'cache'),
      tmp: join(input.prep, 'tmp'),
      state: join(input.prep, 'state'),
      config: join(input.prep, 'config'),
    });
    const homes = {
      ...vendorHomes(input.config, input.paths),
      claude: join(input.home, 'outside-claude'),
    };
    const profile = profileOf(input.config);
    profile.network.allowedDomains = ['registry.npmjs.org', 'custom.example'];
    const policy = prepPolicy({ ...input, vendorHomes: homes, entry, profile });
    const runtimeConfig: Partial<SandboxRuntimeConfig> = policy;
    expect(runtimeConfig).toBe(policy);
    const allowed = shared ? [input.clone, layout.cache, input.tmpDir] : [input.clone, input.tmpDir];
    const scripts = 'scripts' in entry && entry.scripts;
    expect(policy.filesystem).toEqual({
      allowWrite: allowed,
      denyWrite: ['/tmp/claude', '/private/tmp/claude', join(input.home, '.npm/_logs')],
      denyRead: [
        ...deniedReadPaths({ ...input, vendorHomes: homes }).map(({ path }) => path),
        join(input.paths.work, '*', '*'),
      ],
      allowRead: [...allowed, prepToolConfig(input.prep, scripts)],
    });
    // The section 7.6 credential paths, the runner tree, a vendor home outside it and every clone, by name.
    for (const denied of [
      join(input.home, '.ssh'),
      join(input.home, '.config/agflow'),
      join(input.home, '.claude'),
      join(input.home, 'Library/Keychains'),
      input.paths.runner,
      homes.claude,
      join(input.paths.work, '*', '*'),
    ]) {
      expect(policy.filesystem.denyRead).toContain(denied);
    }
    for (const forbidden of [input.prep, layout.state, layout.config]) {
      expect(policy.filesystem.allowWrite).not.toContain(forbidden);
    }
    expect(policy.network).toEqual({
      allowedDomains: ['registry.npmjs.org', 'custom.example'],
      deniedDomains: [],
    });
    profile.network.allowedDomains.push('later.example');
    expect(policy.network.allowedDomains).toEqual(['registry.npmjs.org', 'custom.example']);
  });
});
