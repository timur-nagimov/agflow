import { describe, expect, test } from 'bun:test';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { CONNECTIVITY_VARS, type RunnerConfig, RunnerConfigSchema } from '../src/config';
import { type AgentEnvInput, bridgeEnvOf, buildAgentEnv, userVariables } from '../src/env';
import { runnerPaths } from '../src/paths';
import {
  deniedReadPaths,
  deniedWritePaths,
  type PermissionProfile,
  profileOf,
  standardProfile,
} from '../src/profile';

const CLONE = '/h/work/demo-0123456789/T-4-a1';
const RUN = `${CLONE}/.agflow/run`;
const paths = runnerPaths('/h');
const TOOLS = paths.agentTools('demo-0123456789', 'T-4-a1');

function config(overrides: Record<string, unknown> = {}): RunnerConfig {
  return RunnerConfigSchema.parse({
    runnerKey: 'rk_test',
    machineId: 'MACHINE-1',
    name: 'laptop',
    capturedPath: '/opt/homebrew/bin:/usr/bin:/bin',
    connectivity: { HTTPS_PROXY: 'http://proxy.corp:3128', NODE_EXTRA_CA_CERTS: '/etc/corp-ca.pem' },
    homes: { claude: '/h/runner/homes/claude', codex: '/h/runner/homes/codex' },
    ...overrides,
  });
}

/** What the runner's own environment might hold, secrets and all. */
const runnerEnv = {
  HOME: '/Users/owner',
  USER: 'owner',
  LOGNAME: 'owner',
  LANG: 'en_GB.UTF-8',
  LC_ALL: 'en_GB.UTF-8',
  LC_CTYPE: 'UTF-8',
  SHELL: '/bin/zsh',
  TERM: 'xterm-256color',
  PATH: '/somewhere/else:/usr/bin',
  TMPDIR: '/var/folders/xy/T/',
  ANTHROPIC_API_KEY: 'sk-ant-secret',
  OPENAI_API_KEY: 'sk-openai-secret',
  CLAUDE_CODE_X: 'from-runner',
  CODEX_X: 'from-runner',
  SSH_AUTH_SOCK: '/private/tmp/ssh-agent.sock',
  SSH_ASKPASS: '/usr/libexec/ssh-askpass',
  GIT_CONFIG_PARAMETERS: "'credential.helper'='osxkeychain'",
  AWS_SECRET_ACCESS_KEY: 'aws-secret',
  HTTPS_PROXY: 'http://not-the-captured-one:1',
  GITHUB_TOKEN: 'ghp_secret',
  NPM_TOKEN: 'npm-secret',
  EDITOR: 'vim',
  PWD: '/Users/owner/src',
};

/** Every variable an agent environment holds, apart from the vendor's own. */
const COMMON_KEYS = [
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'SHELL',
  'TERM',
  'NODE_USE_SYSTEM_CA',
  'HTTPS_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'HOME',
  'DISABLE_AUTOUPDATER',
  'BUN_INSTALL_CACHE_DIR',
  'npm_config_cache',
  'PIP_CACHE_DIR',
  'UV_CACHE_DIR',
  'GOMODCACHE',
  'CARGO_HOME',
  'PATH',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_TERMINAL_PROMPT',
  'GIT_ASKPASS',
  'GIT_SSH_COMMAND',
  'GIT_SSH_VARIANT',
  'GH_CONFIG_DIR',
  'GLAB_CONFIG_DIR',
  'GH_TOKEN',
  'GITLAB_TOKEN',
  'AGFLOW_AGENT_TOKEN',
  'AGFLOW_HUB_URL',
  'AGFLOW_ATTEMPT_ID',
  'AGFLOW_ROLE',
  'AGFLOW_CLONE',
  'AGFLOW_BRIDGE_POLL_MS',
  'AGFLOW_BRIDGE_POLL_MAX_MS',
  'AGFLOW_CONFIG_DIR',
];
const VENDOR_KEYS = {
  claude: ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_TMPDIR', 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS'],
  codex: ['CODEX_HOME'],
};

function input(overrides: Partial<AgentEnvInput> = {}): AgentEnvInput {
  return {
    vendor: 'claude',
    spec: { attemptId: 'T-4-a1', role: 'worker', agentToken: 'agt_secret', hubUrl: 'https://hub.example.com' },
    clone: CLONE,
    tools: TOOLS,
    tmpDir: '/tmp/agf/abc123',
    config: config(),
    paths,
    base: runnerEnv,
    env: {},
    ...overrides,
  };
}

describe('buildAgentEnv', () => {
  test("is an allowlist: none of the runner's own secrets, vendor variables or anything else", () => {
    for (const vendor of ['claude', 'codex'] as const) {
      const env = buildAgentEnv(input({ vendor, tmpDir: vendor === 'claude' ? '/tmp/agf/abc123' : null }));
      expect(Object.keys(env).sort()).toEqual([...COMMON_KEYS, ...VENDOR_KEYS[vendor]].sort());
      for (const name of [
        'ANTHROPIC_API_KEY',
        'OPENAI_API_KEY',
        'CLAUDE_CODE_X',
        'CODEX_X',
        'SSH_AUTH_SOCK',
        'SSH_ASKPASS',
        'GIT_CONFIG_PARAMETERS',
        'GIT_CONFIG_COUNT',
        'AWS_SECRET_ACCESS_KEY',
        'TMPDIR',
      ]) {
        expect(env[name]).toBeUndefined();
      }
      const values = Object.values(env).join('\n');
      for (const secret of [
        'sk-ant-secret',
        'sk-openai-secret',
        'aws-secret',
        'osxkeychain',
        'ssh-agent.sock',
        'ghp_secret',
        'npm-secret',
      ]) {
        expect(values).not.toContain(secret);
      }
    }
  });

  test('carries the user and system variables and sets TERM and NODE_USE_SYSTEM_CA', () => {
    const env = buildAgentEnv(input());
    expect(env).toMatchObject({
      USER: 'owner',
      LOGNAME: 'owner',
      LANG: 'en_GB.UTF-8',
      LC_ALL: 'en_GB.UTF-8',
      LC_CTYPE: 'UTF-8',
      SHELL: '/bin/zsh',
      TERM: 'dumb',
      NODE_USE_SYSTEM_CA: '1',
    });
  });

  test('takes the connectivity variables from runner.json, not from the runner environment', () => {
    const env = buildAgentEnv(input());
    expect(env.HTTPS_PROXY).toBe('http://proxy.corp:3128');
    expect(env.NODE_EXTRA_CA_CERTS).toBe('/etc/corp-ca.pem');
    const none = buildAgentEnv(input({ config: config({ connectivity: {} }) }));
    for (const name of CONNECTIVITY_VARS) expect(none[name]).toBeUndefined();
  });

  test("Claude gets the owner's HOME, its config dir and tmp dir, and no autoupdate or background tasks", () => {
    const env = buildAgentEnv(input());
    expect(env).toMatchObject({
      HOME: '/Users/owner',
      CLAUDE_CONFIG_DIR: '/h/runner/homes/claude',
      CLAUDE_CODE_TMPDIR: '/tmp/agf/abc123',
      DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
    });
    expect(env.CODEX_HOME).toBeUndefined();
    expect(() => buildAgentEnv(input({ tmpDir: null }))).toThrow('CLAUDE_CODE_TMPDIR');
  });

  test('Codex gets homes/codex-user as HOME, CODEX_HOME and no autoupdate', () => {
    const env = buildAgentEnv(input({ vendor: 'codex', tmpDir: null }));
    expect(env).toMatchObject({
      HOME: '/h/runner/homes/codex-user',
      CODEX_HOME: '/h/runner/homes/codex',
      DISABLE_AUTOUPDATER: '1',
    });
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(env.CLAUDE_CODE_TMPDIR).toBeUndefined();
    expect(env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBeUndefined();
  });

  test("uses the layout's canonical homes when runner.json records none", () => {
    const home = realpathSync('/tmp');
    const env = buildAgentEnv(
      input({ config: config({ homes: {} }), paths: runnerPaths('/tmp/agflow-env-missing-home') }),
    );
    expect(env.CLAUDE_CONFIG_DIR).toBe(join(home, 'agflow-env-missing-home', 'runner', 'homes', 'claude'));
  });

  test('points the package caches into the clone and puts the runner-owned shims first on PATH', () => {
    const env = buildAgentEnv(input());
    expect(env).toMatchObject({
      BUN_INSTALL_CACHE_DIR: `${RUN}/cache/bun`,
      npm_config_cache: `${RUN}/cache/npm`,
      PIP_CACHE_DIR: `${RUN}/cache/pip`,
      UV_CACHE_DIR: `${RUN}/cache/uv`,
      GOMODCACHE: `${RUN}/cache/go-mod`,
      CARGO_HOME: `${RUN}/cache/cargo`,
      PATH: `${TOOLS}/bin:/opt/homebrew/bin:/usr/bin:/bin`,
    });
  });

  test('carries the agent git variables, naming files outside the clone that agents cannot write', () => {
    expect(TOOLS).toBe('/h/vaults/demo-0123456789.agent/T-4-a1');
    expect(buildAgentEnv(input())).toMatchObject({
      GIT_CONFIG_GLOBAL: `${TOOLS}/gitconfig`,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '/usr/bin/false',
      GIT_SSH_COMMAND: `${TOOLS}/ssh-refusal`,
      GIT_SSH_VARIANT: 'ssh',
      GH_CONFIG_DIR: `${TOOLS}/gh-config`,
      GLAB_CONFIG_DIR: `${TOOLS}/glab-config`,
      GH_TOKEN: 'agflow-no-token',
      GITLAB_TOKEN: 'agflow-no-token',
    });
  });

  test('sets the bridge variables, and bridgeEnvOf gives only those plus connectivity and NODE_USE_SYSTEM_CA', () => {
    const env = buildAgentEnv(input({ config: config({ timings: { bridgePoll: 2_500 } }) }));
    const bridge = {
      AGFLOW_AGENT_TOKEN: 'agt_secret',
      AGFLOW_HUB_URL: 'https://hub.example.com',
      AGFLOW_ATTEMPT_ID: 'T-4-a1',
      AGFLOW_ROLE: 'worker',
      AGFLOW_CLONE: CLONE,
      AGFLOW_BRIDGE_POLL_MS: '2500',
      AGFLOW_BRIDGE_POLL_MAX_MS: '180000',
      AGFLOW_CONFIG_DIR: `${RUN}/config`,
    };
    expect(env).toMatchObject(bridge);
    expect(bridgeEnvOf(env)).toEqual({
      ...bridge,
      NODE_USE_SYSTEM_CA: '1',
      HTTPS_PROXY: 'http://proxy.corp:3128',
      NODE_EXTRA_CA_CERTS: '/etc/corp-ca.pem',
    });
  });

  test('adds test.claudeEnv after the allowlist, for Claude only and only in test mode', () => {
    const test = { claudeEnv: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', ANTHROPIC_API_KEY: 'test-key', TERM: 'x' } };
    const testConfig = config({ test });
    const claude = buildAgentEnv(input({ config: testConfig, env: { AGFLOW_TEST: '1' } }));
    expect(claude).toMatchObject(test.claudeEnv);
    const outside = buildAgentEnv(input({ config: testConfig, env: {} }));
    expect(outside.ANTHROPIC_BASE_URL).toBeUndefined();
    const codex = buildAgentEnv(
      input({ vendor: 'codex', tmpDir: null, config: testConfig, env: { AGFLOW_TEST: '1' } }),
    );
    expect(codex.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  test('builds the owner HOME from the given base only', () => {
    const env = buildAgentEnv(input({ base: { ...runnerEnv, HOME: '/Users/other' } }));
    expect(env.HOME).toBe('/Users/other');
  });
});

describe('userVariables', () => {
  test('gives the set USER, LOGNAME, LANG, SHELL and LC_ variables, as buildAgentEnv carries them', () => {
    expect(userVariables({ ...runnerEnv, LC_TIME: undefined })).toEqual({
      USER: 'owner',
      LOGNAME: 'owner',
      LANG: 'en_GB.UTF-8',
      LC_ALL: 'en_GB.UTF-8',
      LC_CTYPE: 'UTF-8',
      SHELL: '/bin/zsh',
    });
    expect(userVariables({})).toEqual({});
    expect(buildAgentEnv(input())).toMatchObject(userVariables(runnerEnv));
  });
});

describe('the permission profile', () => {
  test('the standard profile lists the section 7.6 registries and no web tools', () => {
    const expected: PermissionProfile = {
      name: 'standard',
      network: {
        allowedDomains: [
          'registry.npmjs.org',
          'registry.yarnpkg.com',
          'bun.sh',
          'pypi.org',
          'files.pythonhosted.org',
          'proxy.golang.org',
          'sum.golang.org',
          'crates.io',
          'static.crates.io',
          'index.crates.io',
        ],
      },
      webTools: false,
    };
    expect(standardProfile).toEqual(expected);
    expect(Object.isFrozen(standardProfile.network.allowedDomains)).toBe(true);
  });

  test("profileOf follows runner.json's profile", () => {
    expect(profileOf(config())).toEqual(standardProfile);
    const auto = profileOf(config({ profile: 'auto' }));
    expect(auto).toEqual({ ...standardProfile, name: 'auto' });
    auto.network.allowedDomains.push('example.com');
    expect(standardProfile.network.allowedDomains).not.toContain('example.com');
  });
});

describe('denied paths', () => {
  const owner = '/Users/owner';
  const tree = (path: string) => ({ path, tree: true });
  const file = (path: string) => ({ path, tree: false });
  const vendorHomes = { claude: '/h/runner/homes/claude', codex: '/h/runner/homes/codex' };

  test('reads: credentials, vendor state and the whole runner tree, under the given home and AGFLOW_HOME', () => {
    expect(deniedReadPaths({ home: owner, paths, vendorHomes })).toEqual([
      tree(`${owner}/.ssh`),
      file(`${owner}/.netrc`),
      file(`${owner}/.git-credentials`),
      tree(`${owner}/.config/gh`),
      tree(`${owner}/.config/glab-cli`),
      tree(`${owner}/.config/agflow`),
      tree('/h/runner'),
      tree(`${owner}/.claude`),
      file(`${owner}/.claude.json`),
      tree(`${owner}/.codex`),
      tree(`${owner}/Library/Keychains`),
      tree(`${owner}/.aws`),
      tree(`${owner}/.config/gcloud`),
      tree(`${owner}/.kube`),
      file(`${owner}/.docker/config.json`),
    ]);
  });

  test('writes: runner state, vaults, vendor and CLI config, LaunchAgents and shell profiles', () => {
    expect(deniedWritePaths({ home: owner, paths, vendorHomes })).toEqual([
      tree('/h/runner'),
      tree('/h/vaults'),
      tree(`${owner}/.claude`),
      file(`${owner}/.claude.json`),
      tree(`${owner}/.codex`),
      tree(`${owner}/.config/agflow`),
      tree(`${owner}/Library/LaunchAgents`),
      file(`${owner}/.zshrc`),
      file(`${owner}/.zprofile`),
      file(`${owner}/.zshenv`),
      file(`${owner}/.bashrc`),
      file(`${owner}/.bash_profile`),
      file(`${owner}/.profile`),
      file(`${owner}/.gitconfig`),
    ]);
  });

  test('never name the work root or a clone, and refuse a layout where one would', () => {
    for (const denied of [...deniedReadPaths({ home: owner, paths, vendorHomes }), ...deniedWritePaths({ home: owner, paths, vendorHomes })]) {
      expect(`${CLONE}/`.startsWith(`${denied.path}/`)).toBe(false);
      expect(`${paths.work}/`.startsWith(`${denied.path}/`)).toBe(false);
      expect(denied.path.startsWith(paths.work)).toBe(false);
    }
    const inside = runnerPaths(`${owner}/.codex/agflow`);
    expect(() => deniedReadPaths({ home: owner, paths: inside, vendorHomes })).toThrow('work root');
    expect(() => deniedWritePaths({ home: owner, paths: inside, vendorHomes })).toThrow('work root');
  });

  test('add the vendor homes runner.json puts outside the runner tree', () => {
    const shared = { claude: '/shared/homes/claude', codex: '/shared/homes/codex' };
    const read = deniedReadPaths({ home: owner, paths, vendorHomes: shared });
    const write = deniedWritePaths({ home: owner, paths, vendorHomes: shared });
    for (const denied of [read, write]) {
      expect(denied).toContainEqual(tree('/shared/homes/claude'));
      expect(denied).toContainEqual(tree('/shared/homes/codex'));
    }
    expect(read).toHaveLength(deniedReadPaths({ home: owner, paths, vendorHomes }).length + 2);
    expect(write).toHaveLength(deniedWritePaths({ home: owner, paths, vendorHomes }).length + 2);
    // A home that holds the work root would deny the agent its clone.
    const covering = { ...shared, codex: '/h' };
    expect(() => deniedReadPaths({ home: owner, paths, vendorHomes: covering })).toThrow('work root');
  });

  test('refuse a relative home', () => {
    expect(() => deniedReadPaths({ home: 'Users/owner', paths, vendorHomes })).toThrow('absolute');
  });
});
