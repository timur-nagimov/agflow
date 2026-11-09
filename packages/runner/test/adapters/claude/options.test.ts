import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  HookCallback,
  HookInput,
  PreToolUseHookInput,
  SpawnedProcess,
  SpawnOptions,
} from '@anthropic-ai/claude-agent-sdk';
import {
  assertFullModelId,
  briefHookCommand,
  buildQueryOptions,
  CLAUDE_BUILTIN_TOOLS,
  CLAUDE_SHELL,
  claudeEmptyDir,
  type ClaudeOptionDeps,
  effectivePermissionMode,
  ensureClaudeEmptyDir,
  inDirectory,
} from '../../../src/adapters/claude/options';
import { claudeProjectDir } from '../../../src/adapters/claude/paths';
import { claudePermissionRules, claudeSandboxSettings } from '../../../src/adapters/claude/rules';
import type { AgentLaunch } from '../../../src/adapters/types';
import { runnerPaths } from '../../../src/paths';
import { type PermissionProfile, standardProfile } from '../../../src/profile';

// Paths that exist nowhere: the options are pure, and the guard resolves missing paths through their parents.
const HOME = '/Users/owner';
const paths = runnerPaths('/Users/owner/.agflow');
const CLAUDE_HOME = paths.homes.claude;
const CLONE = join(paths.work, 'p-1234567890', 'T-1-a1');
const TMP = '/tmp/agf/abc123';
const BASE = paths.baseCheckout('p-1234567890', '0123456789abcdef');
const SESSION = '11111111-2222-4333-8444-555555555555';
const EMPTY = join(CLAUDE_HOME, 'agflow-empty');

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratchDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agflow-options-')));
  scratch.push(dir);
  return dir;
}


const preCompact: HookCallback = async () => ({});
const postCompact: HookCallback = async () => ({});
const spawn = (_options: SpawnOptions): SpawnedProcess => {
  throw new Error('not spawned in these tests');
};

function deps(overrides: Partial<ClaudeOptionDeps> = {}): ClaudeOptionDeps {
  return {
    agflow: { command: '/opt/agflow bin/agflow', args: [] },
    paths,
    vendorHomes: { claude: CLAUDE_HOME, codex: paths.homes.codex },
    autoOffered: false,
    spawnClaudeCodeProcess: spawn,
    compaction: { preCompact, postCompact },
    newSessionId: () => SESSION,
    ...overrides,
  };
}

function launch(overrides: Partial<AgentLaunch> = {}): AgentLaunch {
  return {
    attemptId: 'T-1-a1',
    role: 'worker',
    model: 'claude-sonnet-5-5',
    cliVersion: '2.1.285',
    clone: CLONE,
    baseCheckout: BASE,
    projectConfigVerified: true,
    tmpDir: TMP,
    env: {
      HOME,
      PATH: '/usr/bin:/bin',
      CLAUDE_CONFIG_DIR: CLAUDE_HOME,
      CLAUDE_CODE_TMPDIR: TMP,
      AGFLOW_AGENT_TOKEN: 'agt_secret',
    },
    // Not deps().agflow: the MCP server must come from the launch's bridge (X-32).
    bridge: {
      command: '/opt/bridge/agflow',
      args: ['--bridge', 'mcp', '--vendor', 'claude', '--runner'],
      env: { AGFLOW_AGENT_TOKEN: 'agt_secret', AGFLOW_HUB_URL: 'http://127.0.0.1:7000' },
      tools: [],
    },
    profile: standardProfile,
    brief: 'brief',
    firstPrompt: 'go',
    resume: null,
    logFile: '/tmp/attempt.log',
    registerProcess: () => {},
    ...overrides,
  };
}

function preToolUse(tool_name: string, tool_input: unknown): PreToolUseHookInput {
  return {
    hook_event_name: 'PreToolUse',
    session_id: SESSION,
    transcript_path: '/dev/null',
    cwd: CLONE,
    tool_name,
    tool_input,
    tool_use_id: 'toolu_1',
  } as PreToolUseHookInput;
}

const auto: PermissionProfile = { ...standardProfile, name: 'auto' };

describe('buildQueryOptions', () => {
  test('a new session sets a fresh sessionId and no resume; a resumed one sets resume and no sessionId', () => {
    const fresh = buildQueryOptions(launch(), deps());
    expect(fresh.sessionId).toBe(SESSION);
    expect(fresh.resume).toBeUndefined();
    expect(fresh.cwd).toBe(CLONE);
    const ids = new Set(
      [1, 2].map(() => buildQueryOptions(launch(), deps({ newSessionId: undefined })).sessionId as string),
    );
    expect(ids.size).toBe(2);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const resumed = buildQueryOptions(launch({ resume: { sessionRef: SESSION } }), deps());
    expect(resumed.resume).toBe(SESSION);
    expect(resumed.sessionId).toBeUndefined();
    expect(resumed.cwd).toBe(CLONE);
  });

  test('the sandbox is a top-level option, task 7 settings, and never appears inside settings', () => {
    const options = buildQueryOptions(launch(), deps());
    const input = {
      home: HOME,
      paths,
      vendorHomes: deps().vendorHomes,
      profile: standardProfile,
      clone: CLONE,
      tmpDir: TMP,
    };
    expect(options.sandbox).toEqual(claudeSandboxSettings(input));
    expect(typeof options.settings).toBe('object');
    expect(Object.keys(options.settings as object)).not.toContain('sandbox');
  });

  test('tools are exactly the built-ins, plus WebFetch and WebSearch with webTools', () => {
    expect([...CLAUDE_BUILTIN_TOOLS]).toEqual([
      'Bash',
      'Read',
      'Edit',
      'Write',
      'Glob',
      'Grep',
      'Task',
      'TaskCreate',
      'TaskGet',
      'TaskList',
      'TaskUpdate',
    ]);
    expect(buildQueryOptions(launch(), deps()).tools).toEqual([...CLAUDE_BUILTIN_TOOLS]);
    const web = buildQueryOptions(launch({ profile: { ...standardProfile, webTools: true } }), deps());
    expect(web.tools).toEqual([...CLAUDE_BUILTIN_TOOLS, 'WebFetch', 'WebSearch']);
    const absent = [
      'SendMessage',
      'ListAgents',
      'CronCreate',
      'CronDelete',
      'CronList',
      'ScheduleWakeup',
      'RemoteTrigger',
      'Workflow',
      'EnterWorktree',
      'ToolSearch',
    ];
    for (const tool of absent) expect(web.tools as string[]).not.toContain(tool);
  });

  test('the permission mode is acceptEdits, and auto only for the auto profile on an account that offers it', () => {
    expect(effectivePermissionMode(standardProfile, false)).toBe('acceptEdits');
    expect(effectivePermissionMode(standardProfile, true)).toBe('acceptEdits');
    expect(effectivePermissionMode(auto, false)).toBe('acceptEdits');
    expect(effectivePermissionMode(auto, true)).toBe('auto');
    expect(buildQueryOptions(launch(), deps({ autoOffered: true })).permissionMode).toBe('acceptEdits');
    expect(buildQueryOptions(launch({ profile: auto }), deps()).permissionMode).toBe('acceptEdits');
    const options = buildQueryOptions(launch({ profile: auto }), deps({ autoOffered: true }));
    expect(options.permissionMode).toBe('auto');
    expect(options.permissionPrompts).toBe('none');
    expect(options.canUseTool).toBeUndefined();
    expect(options.allowDangerouslySkipPermissions).toBeUndefined();
  });

  test('project settings come only from the base checkout, and a launch without one is refused', () => {
    const options = buildQueryOptions(launch(), deps());
    expect(options.settingSources).toEqual(['project']);
    expect(options.projectConfigRoot).toBe(BASE);
    expect(() => buildQueryOptions(launch({ baseCheckout: null }), deps())).toThrow(/base checkout/);
  });

  test('strictMcpConfig is set, and mcpServers holds only agflow: the bridge, started in the empty directory', () => {
    const options = buildQueryOptions(launch(), deps());
    expect(options.strictMcpConfig).toBe(true);
    expect(options.mcpServers).toEqual({
      agflow: {
        type: 'stdio',
        ...inDirectory(EMPTY, '/opt/bridge/agflow', ['--bridge', 'mcp', '--vendor', 'claude', '--runner']),
        env: { AGFLOW_AGENT_TOKEN: 'agt_secret', AGFLOW_HUB_URL: 'http://127.0.0.1:7000' },
      },
    });
    expect(inDirectory(EMPTY, '/opt/bridge/agflow', ['mcp'])).toEqual({
      command: '/bin/sh',
      args: ['-c', 'cd -- "$1" && shift && exec "$@"', 'agflow', EMPTY, '/opt/bridge/agflow', 'mcp'],
    });
  });

  test('settings hold the permissions, the brief hook and the session settings', () => {
    const options = buildQueryOptions(launch(), deps());
    const rules = claudePermissionRules({
      home: HOME,
      paths,
      vendorHomes: deps().vendorHomes,
      profile: standardProfile,
      clone: CLONE,
      tmpDir: TMP,
    });
    expect(options.settings).toEqual({
      permissions: { allow: rules.allow, deny: rules.deny },
      hooks: {
        SessionStart: [
          { hooks: [{ type: 'command', command: `cd ${EMPTY} && exec '/opt/agflow bin/agflow' hook brief --runner` }] },
        ],
      },
      autoMemoryEnabled: false,
      crossSessionInbound: 'refuse',
      cleanupPeriodDays: 30,
      syncClaudeAiSkills: false,
      syncClaudeAiPlugins: false,
    });
  });

  test('briefHookCommand changes to the directory, then runs the agflow command, all quoted for the shell', () => {
    expect(briefHookCommand({ command: '/usr/local/bin/agflow', args: [] }, '/h/claude/agflow-empty')).toBe(
      'cd /h/claude/agflow-empty && exec /usr/local/bin/agflow hook brief --runner',
    );
    expect(
      briefHookCommand({ command: '/Users/o/.bun/bin/bun', args: ['/Users/o/my agflow/main.ts'] }, '/h/my claude/e'),
    ).toBe("cd '/h/my claude/e' && exec /Users/o/.bun/bin/bun '/Users/o/my agflow/main.ts' hook brief --runner");
    expect(briefHookCommand({ command: "/x/it's", args: ['$(rm -rf ~)'] }, "/h/it's")).toBe(
      "cd '/h/it'\\''s' && exec '/x/it'\\''s' '$(rm -rf ~)' hook brief --runner",
    );
  });

  test('the bridge wrapper and the brief hook run agflow in the given directory, where Bun loads nothing', () => {
    // As the CLI starts them: in the base checkout, whose bunfig.toml preload and .env Bun would otherwise load.
    const root = scratchDir();
    const checkout = join(root, 'checkout');
    const empty = join(root, "it's empty");
    mkdirSync(checkout);
    mkdirSync(empty);
    const preloadRan = join(root, 'preload-ran');
    writeFileSync(join(checkout, 'bunfig.toml'), "preload = ['./planted.ts']\n");
    const ran = `require('node:fs').appendFileSync(${JSON.stringify(preloadRan)}, 'ran');\n`;
    writeFileSync(join(checkout, 'planted.ts'), ran);
    writeFileSync(join(checkout, '.env'), 'AGFLOW_PLANTED=from-the-checkout\n');
    const agflow = join(root, 'agflow.ts');
    const note = '{ cwd: process.cwd(), argv: process.argv.slice(2), planted: process.env.AGFLOW_PLANTED ?? null }';
    writeFileSync(agflow, `console.log(JSON.stringify(${note}));\n`);
    const run = (argv: string[]) => {
      const proc = Bun.spawnSync(argv, { cwd: checkout, env: { PATH: '/usr/bin:/bin', HOME: root } });
      expect(proc.exitCode).toBe(0);
      return JSON.parse(proc.stdout.toString());
    };
    const bridge = inDirectory(empty, process.execPath, [agflow, 'mcp', '--vendor', 'claude', '--runner']);
    expect(run([bridge.command, ...bridge.args])).toEqual({
      cwd: empty,
      argv: ['mcp', '--vendor', 'claude', '--runner'],
      planted: null,
    });
    // The CLI runs a hook's command with /bin/sh -c.
    const hook = briefHookCommand({ command: process.execPath, args: [agflow] }, empty);
    expect(run(['/bin/sh', '-c', hook])).toEqual({ cwd: empty, argv: ['hook', 'brief', '--runner'], planted: null });
    expect(existsSync(preloadRan)).toBe(false);
    // Started in the checkout itself, Bun loads both.
    expect(run([process.execPath, agflow])).toEqual({ cwd: checkout, argv: [], planted: 'from-the-checkout' });
    expect(existsSync(preloadRan)).toBe(true);
  });

  test("hooks register the guard with the launch's scope and the compaction callbacks", async () => {
    const options = buildQueryOptions(launch(), deps());
    expect(Object.keys(options.hooks ?? {}).sort()).toEqual(['PostCompact', 'PreCompact', 'PreToolUse']);
    expect(options.hooks?.PreCompact).toEqual([{ hooks: [preCompact] }]);
    expect(options.hooks?.PostCompact).toEqual([{ hooks: [postCompact] }]);
    const guard = options.hooks?.PreToolUse?.[0]?.hooks[0];
    if (!guard) throw new Error('no PreToolUse hook');
    const signal = new AbortController().signal;
    const ask = (name: string, input: unknown) => guard(preToolUse(name, input) as HookInput, 'toolu_1', { signal });
    expect(await ask('Bash', { command: 'git push origin HEAD' })).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
    // The scope's work root, tmpDir, home and Claude home come from the launch and the paths.
    expect(await ask('Read', { file_path: join(paths.work, 'p-1234567890', 'T-2-b2', 'x') })).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
    // Only the launch's HOME puts this path under the work root.
    expect(await ask('Read', { file_path: '~/.agflow/work/p-1234567890/T-2-b2/x' })).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
    // Other sessions' transcripts lie under the Claude home's projects/ (X-29); the attempt's own stay readable.
    expect(await ask('Read', { file_path: join(CLAUDE_HOME, 'projects', '-other', 'x.jsonl') })).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
    expect(await ask('Read', { file_path: join(claudeProjectDir(CLAUDE_HOME, CLONE), 'x.jsonl') })).toEqual({});
    expect(await ask('Write', { file_path: join(TMP, 'out.txt') })).toEqual({});
    expect(await ask('Write', { file_path: '~/.zshrc' })).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
    expect(await ask('Edit', { file_path: join(CLONE, 'src', 'a.ts') })).toEqual({});
  });

  test('env is launch.env with the empty ZDOTDIR and zsh, and it must name the Claude home and the tmpDir', () => {
    const given = launch();
    const options = buildQueryOptions(given, deps());
    // Without a SHELL that is a zsh, the CLI's shells are /bin/zsh.
    expect(options.env).toEqual({ ...given.env, ZDOTDIR: EMPTY, CLAUDE_CODE_SHELL: CLAUDE_SHELL });
    expect(CLAUDE_SHELL).toBe('/bin/zsh');
    for (const shell of ['/bin/bash', '/opt/homebrew/bin/fish', '/bin/zsh-not']) {
      const env = { ...given.env, SHELL: shell };
      expect(buildQueryOptions(launch({ env }), deps()).env).toEqual({
        ...env,
        ZDOTDIR: EMPTY,
        CLAUDE_CODE_SHELL: CLAUDE_SHELL,
      });
    }
    // An owner's zsh stays the CLI's shell.
    for (const shell of ['/bin/zsh', '/opt/homebrew/bin/zsh']) {
      const env = { ...given.env, SHELL: shell };
      expect(buildQueryOptions(launch({ env }), deps()).env).toEqual({ ...env, ZDOTDIR: EMPTY });
    }
    // Whatever the launch says, ZDOTDIR and CLAUDE_CODE_SHELL are the adapter's.
    const planted = { ...given.env, ZDOTDIR: '/Users/owner', CLAUDE_CODE_SHELL: '/bin/bash' };
    const { CLAUDE_CODE_SHELL: _planted, ...unplanted } = planted;
    expect(buildQueryOptions(launch({ env: { ...planted, SHELL: '/bin/zsh' } }), deps()).env).toEqual({
      ...unplanted,
      SHELL: '/bin/zsh',
      ZDOTDIR: EMPTY,
    });
    expect(buildQueryOptions(launch({ env: { ...planted, SHELL: '/bin/bash' } }), deps()).env).toEqual({
      ...planted,
      SHELL: '/bin/bash',
      ZDOTDIR: EMPTY,
      CLAUDE_CODE_SHELL: CLAUDE_SHELL,
    });
    const wrongHome = launch({ env: { ...given.env, CLAUDE_CONFIG_DIR: '/Users/owner/.claude' } });
    expect(() => buildQueryOptions(wrongHome, deps())).toThrow(/CLAUDE_CONFIG_DIR/);
    const wrongTmp = launch({ env: { ...given.env, CLAUDE_CODE_TMPDIR: '/tmp/claude' } });
    expect(() => buildQueryOptions(wrongTmp, deps())).toThrow(/CLAUDE_CODE_TMPDIR/);
    const { HOME: _home, ...homeless } = given.env;
    expect(() => buildQueryOptions(launch({ env: homeless }), deps())).toThrow(/HOME/);
  });

  test("the binary is the one for launch.cliVersion, and the spawn hook is the adapter's", () => {
    const options = buildQueryOptions(launch({ cliVersion: '2.1.200' }), deps());
    expect(options.pathToClaudeCodeExecutable).toBe(join(paths.runner, 'vendor', 'claude', '2.1.200', 'claude'));
    expect(options.spawnClaudeCodeProcess).toBe(spawn);
  });

  test("new and resumed sessions retain Claude Code's prompt and explain the runner's Bash limits", () => {
    for (const profile of [standardProfile, auto]) {
      for (const resume of [null, { sessionRef: SESSION }]) {
        const options = buildQueryOptions(launch({ profile, resume }), deps({ autoOffered: true }));
        expect(options.systemPrompt).toMatchObject({
          type: 'preset',
          preset: 'claude_code',
        });
        const note = (options.systemPrompt as { append: string }).append;
        expect(note).toContain('no approval surface');
        expect(note).toContain('loops with $var');
        expect(note).toContain('$(git rev-parse');
        expect(note).toContain('brace groups with quotes');
        expect(note).toContain('sh script.sh');
        expect(note).toContain('Only the runner pushes');
        expect(options.permissionPrompts).toBe('none');
        expect(options.sandbox?.allowUnsandboxedCommands).toBe(false);
        expect(options.sandbox?.autoAllowBashIfSandboxed).toBeUndefined();
        expect(options.settings).toMatchObject({
          permissions: { allow: expect.not.arrayContaining(['Bash']) },
        });
      }
    }
  });

  test('a model alias is refused before anything is built', () => {
    for (const alias of ['opus', 'sonnet', 'haiku', 'fable', 'default', 'opusplan', 'best', 'sonnet[1m]', '']) {
      expect(() => assertFullModelId(alias)).toThrow(/full model id/);
      expect(() => buildQueryOptions(launch({ model: alias }), deps())).toThrow(/full model id/);
    }
    for (const id of ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-4-5-20251001']) {
      expect(() => assertFullModelId(id)).not.toThrow();
    }
    expect(buildQueryOptions(launch(), deps()).model).toBe('claude-sonnet-5-5');
  });
});

describe('the empty directory', () => {
  test('it lies in the Claude home; ensureClaudeEmptyDir makes it private and refuses anything but a directory', () => {
    expect(claudeEmptyDir(CLAUDE_HOME)).toBe(EMPTY);
    const home = join(scratchDir(), 'claude');
    const empty = ensureClaudeEmptyDir(home);
    expect(empty).toBe(claudeEmptyDir(home));
    expect(statSync(empty).isDirectory()).toBe(true);
    expect(statSync(empty).mode & 0o777).toBe(0o700);
    expect(ensureClaudeEmptyDir(home)).toBe(empty);
    const other = scratchDir();
    rmSync(empty, { recursive: true });
    symlinkSync(other, empty);
    expect(() => ensureClaudeEmptyDir(home)).toThrow(/not a directory/);
    rmSync(empty);
    writeFileSync(empty, '');
    expect(() => ensureClaudeEmptyDir(home)).toThrow();
  });
});
