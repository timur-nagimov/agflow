import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexTestConfig } from '@agflow/testkit/src/codex/index';
import {
  appServerArgs,
  appServerEnv,
  codexToolsNote,
  threadOverrides,
  tomlInline,
} from '../../src/adapters/codex/config';
import type { ParamsOf } from '../../src/adapters/codex/methods';
import type { JsonValue } from '../../src/adapters/codex/protocol/serde_json/JsonValue';
import type { RunnerTestBlock } from '../../src/config';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type LaunchPart = Parameters<typeof threadOverrides>[0];

const BRIDGE_CWD = '/runner/homes/codex-user';

function launchFixture(): LaunchPart {
  const dir = mkdtempSync(join(tmpdir(), 'agflow-codex-config-'));
  dirs.push(dir);
  const clone = join(dir, 'clone.link');
  mkdirSync(join(dir, 'real.clone'));
  symlinkSync(join(dir, 'real.clone'), clone);
  return {
    clone,
    model: 'test-model',
    brief: `Implement the task.\n\nYour working directory: ${clone}`,
    projectConfigVerified: true,
    tmpDir: join(clone, '.agflow', 'run', 'tmp'),
    bridge: {
      command: '/runner/bin/bun',
      args: ['/runner/agflow.ts', 'mcp', '--vendor', 'codex', '--runner'],
      env: {
        AGFLOW_AGENT_TOKEN: 'secret-agent-token',
        AGFLOW_HUB_URL: 'http://localhost:3000',
        AGFLOW_BRIDGE_POLL_MS: '20',
        AGFLOW_CONFIG_DIR: join(clone, '.agflow', 'run', 'config'),
        NODE_USE_SYSTEM_CA: '1',
        HTTPS_PROXY: 'http://localhost:1234',
        SSL_CERT_FILE: '/runner/ca.pem',
      },
      tools: ['get_brief', 'submit'],
    },
    profile: { name: 'standard', network: { allowedDomains: ['registry.npmjs.org'] }, webTools: false },
  };
}

describe('tomlInline', () => {
  test('round-trips strings, numbers, booleans, arrays and nested tables', () => {
    const values: JsonValue[] = [
      '', 'quotes " and backslashes \\ and newline\n', '\b\t\n\f\r\x7f', 'Unicode: café 🌍',
      true, false, 0, -42, 1.25, -0.125, 1e30, 1e-20,
      [], {}, [1, 'two', false, { nested: [3.5] }],
      { bare_key: true, 'hyphen-key': 2, 'a.b': { 'a "quoted" \\ key\n': ['value', 4] }, '': 'empty key' },
    ];
    for (const value of values) {
      expect(Bun.TOML.parse(`v = ${tomlInline(value)}`)).toEqual({ v: value });
    }
  });

  test('escapes every TOML control character in strings and quoted keys', () => {
    // Bun 1.3.11's TOML-to-JSON conversion rejects controls such as \\u0001; verify their escapes directly.
    for (const code of [...Array.from({ length: 32 }, (_, n) => n), 127]) {
      const character = String.fromCharCode(code);
      const quoted = `"\\u${code.toString(16).padStart(4, '0')}"`;
      expect(tomlInline(character)).toBe(quoted);
      expect(tomlInline({ [character]: true })).toBe(`{ ${quoted} = true }`);
      expect(JSON.parse(tomlInline(character))).toBe(character);
    }
  });

  test('omits undefined object members, including in nested tables', () => {
    const rendered = tomlInline({ absent: undefined, nested: { absent: undefined, present: false } });
    expect(Bun.TOML.parse(`v = ${rendered}`)).toEqual({ v: { nested: { present: false } } });
  });

  test('rejects null and non-finite numbers even inside arrays or tables', () => {
    for (const value of [null, NaN, Infinity, -Infinity]) {
      for (const nested of [value, [value], { nested: value }]) {
        expect(() => tomlInline(nested)).toThrow();
      }
    }
  });
});

describe('appServerArgs', () => {
  const flags = [
    'app-server', '--disable', 'hooks', '--disable', 'apps', '--disable', 'plugins',
    '--disable', 'remote_plugin', '-c', 'features.shell_snapshot=false', '-c', 'allow_login_shell=false',
  ];

  test('returns exactly the production flags without test configuration', () => {
    expect(appServerArgs()).toEqual(flags);
    expect(appServerArgs(null)).toEqual(flags);
    expect(appServerArgs({})).toEqual(flags);
    const changed = appServerArgs();
    changed.push('extra');
    expect(appServerArgs()).toEqual(flags);
  });

  test('passes the scripted provider and hand-written values as ordered, parseable -c flags', () => {
    const configs: RunnerTestBlock['codexConfig'][] = [
      codexTestConfig('http://localhost:1234/v1'),
      { text: '"quoted" \\ path\n\t', table: { 'key.with.dots': { values: [true, false, 3, 1.5] } } },
    ];
    for (const config of configs) {
      const args = appServerArgs(config);
      expect(args.slice(0, flags.length)).toEqual(flags);
      expect(args.length).toBe(flags.length + 2 * Object.keys(config).length);
      Object.entries(config).forEach(([key, value], index) => {
        const pair = args.slice(flags.length + 2 * index, flags.length + 2 * index + 2);
        expect(pair).toEqual(['-c', `${key}=${tomlInline(value)}`]);
        expect(Bun.TOML.parse(pair[1])).toEqual({ [key]: value });
      });
    }
  });

  test('rejects top-level keys Codex would split or misinterpret and unrenderable values', () => {
    for (const key of ['a.b', '', 'with space', 'quote"', 'back\\slash', 'é', 'trailing\n']) {
      expect(() => appServerArgs({ [key]: true })).toThrow();
    }
    for (const value of [null, NaN, Infinity]) expect(() => appServerArgs({ value })).toThrow();
    expect(appServerArgs({ 'valid-key_123': true }).slice(-2)).toEqual(['-c', 'valid-key_123=true']);
  });
});

describe('appServerEnv', () => {
  test('merges bridge values, forces runner homes, drops undefined and all managed variables', () => {
    const base = {
      PATH: '/runner/bin', HOME: '/owner', CODEX_HOME: '/owner/.codex', EMPTY: '', MISSING: undefined,
      AGFLOW_AGENT_TOKEN: 'old', CODEX_MANAGED_BY_NPM: '1', CODEX_MANAGED_OTHER: 'yes',
    };
    const bridgeEnv = {
      AGFLOW_AGENT_TOKEN: 'new', HTTPS_PROXY: 'http://proxy', NODE_USE_SYSTEM_CA: '1',
      HOME: '/bridge-home', CODEX_HOME: '/bridge-codex', CODEX_MANAGED_BY_BUN: '1',
    };
    const original = structuredClone({ base, bridgeEnv });
    expect(appServerEnv({ base, bridgeEnv, codexHome: '/runner/codex', userHome: '/runner/codex-user' })).toEqual({
      PATH: '/runner/bin', HOME: '/runner/codex-user', CODEX_HOME: '/runner/codex', EMPTY: '',
      AGFLOW_AGENT_TOKEN: 'new', HTTPS_PROXY: 'http://proxy', NODE_USE_SYSTEM_CA: '1', GIT_DIR: '/dev/null',
    });
    expect({ base, bridgeEnv }).toEqual(original);
  });

  test('hides the clone repository from Codex itself whatever the base and bridge say', () => {
    const env = appServerEnv({
      base: { GIT_DIR: '/clone/.git' }, bridgeEnv: { GIT_DIR: '/other/.git' },
      codexHome: '/runner/codex', userHome: '/runner/codex-user',
    });
    expect(env.GIT_DIR).toBe('/dev/null');
  });
});

describe('codexToolsNote', () => {
  test('names exactly the given bridge tools, which Code Mode does not describe, and how exec calls them', () => {
    expect(codexToolsNote(['get_brief', 'hello', 'submit'])).toBe(
      'Your agflow tools are mcp__agflow__get_brief, mcp__agflow__hello, mcp__agflow__submit. Code Mode does not describe them in exec: call them inside ' +
        'exec as tools.mcp__agflow__<name>, as in `await tools.mcp__agflow__<name>({ ...arguments })`.',
    );
    expect(codexToolsNote(['request_agents'])).toStartWith('Your agflow tools are mcp__agflow__request_agents. ');
  });
});

describe('threadOverrides', () => {
  test('uses the canonical clone and launch instructions for both start and resume', () => {
    const launch = launchFixture();
    const overrides = threadOverrides(launch, BRIDGE_CWD);
    const start: ParamsOf<'thread/start'> = overrides;
    const resume: Omit<ParamsOf<'thread/resume'>, 'threadId'> = overrides;
    expect(start).toBe(resume);
    expect(overrides.cwd).toBe(realpathSync(launch.clone));
    expect(overrides.cwd).not.toBe(launch.clone);
    expect(overrides.model).toBe(launch.model);
    expect(overrides.developerInstructions).toBe(`${launch.brief}\n\n${codexToolsNote(launch.bridge.tools)}`);
    expect(overrides.sandbox).toBe('workspace-write');
    expect(overrides.approvalPolicy).toBe('on-request');
    expect(overrides.approvalsReviewer).toBe('user');
  });

  test('sets explicit nested trust for verified and unverified projects', () => {
    const launch = launchFixture();
    const clone = realpathSync(launch.clone);
    for (const verified of [true, false]) {
      const { config } = threadOverrides({ ...launch, projectConfigVerified: verified }, BRIDGE_CWD);
      const trust = verified ? 'trusted' : 'untrusted';
      expect(config.projects[clone].trust_level).toBe(trust);
      expect(config.projects).toEqual({ [clone]: { trust_level: trust } });
      expect(Object.keys(config).some((key) => key.startsWith('projects.'))).toBe(false);
    }
  });

  test('confines sandbox writes and shell homes while preserving the supplied TMPDIR', () => {
    const launch = launchFixture();
    const clone = realpathSync(launch.clone);
    const { config } = threadOverrides(launch, BRIDGE_CWD);
    expect(config.sandbox_workspace_write).toEqual({
      writable_roots: [join(clone, '.git')], network_access: false,
      exclude_slash_tmp: true, exclude_tmpdir_env_var: true,
    });
    expect(config.shell_environment_policy).toEqual({
      inherit: 'all', exclude: ['AGFLOW_*', 'GIT_DIR'],
      set: { HOME: join(clone, '.agflow', 'run', 'home'), TMPDIR: launch.tmpDir },
    });
  });

  test('requires the bridge with its complete command and environment names only, started outside the clone', () => {
    const launch = launchFixture();
    const { config } = threadOverrides(launch, BRIDGE_CWD);
    expect(config.mcp_servers).toEqual({ agflow: {
      command: launch.bridge.command, args: launch.bridge.args, cwd: BRIDGE_CWD,
      env_vars: Object.keys(launch.bridge.env), default_tools_approval_mode: 'approve', required: true,
      tool_timeout_sec: 210,
    } });
    for (const value of Object.values(launch.bridge.env)) {
      expect(config.mcp_servers.agflow.env_vars).not.toContain(value);
    }
    expect(JSON.stringify(config)).not.toContain(launch.bridge.env.AGFLOW_AGENT_TOKEN);
  });

  for (const [value, seconds] of [
    ['180000', 210], ['1000', 31], ['1001', 32], [undefined, 210], ['0', 210], ['abc', 210],
    ['-1', 210], ['1.5', 210], ['Infinity', 210],
  ] as const) {
    test(`allows the bridge poll budget plus 30 seconds (${value})`, () => {
      const launch = launchFixture();
      if (value !== undefined) launch.bridge.env.AGFLOW_BRIDGE_POLL_MAX_MS = value;
      expect(threadOverrides(launch, BRIDGE_CWD).config.mcp_servers.agflow).toHaveProperty('tool_timeout_sec', seconds);
    });
  }

  test('enables only cached web search when the profile allows it', () => {
    const launch = launchFixture();
    expect(threadOverrides(launch, BRIDGE_CWD).config.web_search).toBe('disabled');
    const withWebTools = threadOverrides({ ...launch, profile: { ...launch.profile, webTools: true } }, BRIDGE_CWD);
    expect(withWebTools.config.web_search).toBe('cached');
  });
});
