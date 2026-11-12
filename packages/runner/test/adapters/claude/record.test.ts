import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRIDGE_ANSWERS } from '@agflow/core';
import {
  type ClaudeRecording,
  claudeRecording,
  FAKE_CLAUDE_BIN,
  fakeClaudeEnv,
  loadRecording,
  SYNTHETIC_ACCOUNT,
} from '@agflow/testkit/src/fake-claude';
import { STUB_BRIDGE_TOOLS, STUB_UNREACHABLE_TOOL } from '../../../scripts/claude-stub-bridge';
import {
  asSubscription,
  assertTranscriptPlacement,
  CLAUDE_SCENARIOS,
  type ClaudeScenario,
  type RedactionContext,
  recordingOf,
  redactRecording,
  runScenario,
  type ScenarioRun,
  type ScratchLaunch,
  scratchLaunch,
  stripManagedPolicy,
} from '../../../scripts/record-claude-stream';
import { BRIDGE_TOOL_NAMES } from '../../../src/adapters/bridge-tools';
import { buildQueryOptions, CLAUDE_BUILTIN_TOOLS, claudeEmptyDir } from '../../../src/adapters/claude/options';
import { claudeProjectDir } from '../../../src/adapters/claude/paths';
import { CLAUDE_CLI_VERSION } from '../../../src/adapters/claude/pin';
import { RunnerConfigSchema, saveRunnerConfig } from '../../../src/config';
import { runnerPaths } from '../../../src/paths';
import { vendorBinary } from '../../../src/vendor/pins';

// macOS's first exec of a new script is slow.
const TIMEOUT = 30_000;
const STUB = join(import.meta.dir, '..', '..', '..', 'scripts', 'claude-stub-bridge.ts');

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

beforeAll(() => {
  // Warm both scripts once.
  const env = { PATH: process.env.PATH ?? '', FAKE_CLAUDE_BUN: process.execPath };
  Bun.spawnSync([FAKE_CLAUDE_BIN, '--version'], { env });
  Bun.spawnSync([process.execPath, STUB, 'hook', 'brief', '--runner'], { env });
}, TIMEOUT);

function scenario(name: string): ClaudeScenario {
  const found = CLAUDE_SCENARIOS.find((entry) => entry.name === name);
  if (!found) throw new Error(`no scenario ${name}`);
  return found;
}

/** Replays a committed recording through the fake claude, driven by its scenario through buildQueryOptions. */
async function replay(name: string): Promise<{ recording: ClaudeRecording; run: ScenarioRun; launch: ScratchLaunch }> {
  const recording = loadRecording(name);
  const launch = scratchLaunch({ bin: FAKE_CLAUDE_BIN, model: recording.header.model, env: {} });
  cleanups.push(launch.cleanup);
  Object.assign(launch.launch.env, fakeClaudeEnv({ recording, dir: join(launch.root, 'fake') }));
  const run = await runScenario(scenario(name), launch);
  return { recording, run, launch };
}

/**
 * The recorder's own path from a run to a recording gives back the recording that was replayed: what assembles,
 * templates, rewrites the account, strips the policy and redacts is the code that wrote the committed files.
 */
function expectRoundTrip(recording: ClaudeRecording, run: ScenarioRun, launch: ScratchLaunch): void {
  const again = recordingOf(run, recording.header, launch, { live: false });
  expect(again.answers).toEqual(recording.answers);
  expect(again.turns).toEqual(recording.turns);
  expect(again.startup).toEqual(recording.startup);
}

const out = (run: ScenarioRun) => run.events.filter((event) => event.dir === 'out').map((event) => event.frame);

/** The first frame the CLI printed that matches; the test fails when there is none. */
function first(run: ScenarioRun, match: (frame: Record<string, any>) => boolean): Record<string, any> {
  const found = out(run).find(match);
  if (found === undefined) throw new Error('no such frame in the replay');
  return found;
}

describe('the stub bridge', () => {
  async function rpc(lines: Record<string, unknown>[]): Promise<Record<string, any>[]> {
    const proc = Bun.spawn([process.execPath, STUB, 'mcp', '--vendor', 'claude', '--runner'], {
      stdin: 'pipe',
      stdout: 'pipe',
    });
    for (const line of lines) proc.stdin.write(`${JSON.stringify(line)}\n`);
    proc.stdin.end();
    const text = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    return text
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  const call = (id: number, name: string) => ({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: {} },
  });

  test(
    'it lists the runner tool names and answers the terminal tools with normal results',
    async () => {
      const answers = await rpc([
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        call(3, 'submit'),
        call(4, 'declare_blocked'),
        call(5, 'write_handoff'),
        call(6, STUB_UNREACHABLE_TOOL),
      ]);
      expect(answers.map((answer) => answer.id)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(answers[0]?.result).toMatchObject({ protocolVersion: '2025-06-18', serverInfo: { name: 'agflow' } });
      // M1's shared tools in their order, then the seven worker tools (design 10).
      expect([...STUB_BRIDGE_TOOLS]).toEqual([
        'hello',
        'get_brief',
        'get_goal',
        'list_tasks',
        'get_task',
        'check_inbox',
        'ack_messages',
        'send_message',
        'search',
        'report_progress',
        'write_handoff',
        'declare_blocked',
        'declare_impossible',
        'release_task',
        'submit',
        'prepare_dependencies',
      ]);
      // The names a worker's AgentLaunch.bridge.tools carries, so the stub serves what a real launch announces.
      expect(BRIDGE_TOOL_NAMES.worker).toEqual(STUB_BRIDGE_TOOLS);
      expect(answers[1]?.result.tools.map((tool: { name: string }) => tool.name)).toEqual([...STUB_BRIDGE_TOOLS]);
      for (const name of ['submit', 'declare_blocked', 'declare_impossible', 'release_task', 'write_handoff']) {
        expect(STUB_BRIDGE_TOOLS as readonly string[]).toContain(name);
      }
      expect(STUB_BRIDGE_TOOLS as readonly string[]).not.toContain('claim_task');
      for (const answer of answers.slice(2, 5)) {
        expect(answer.result.isError).toBeUndefined();
        expect(answer.result.content[0].type).toBe('text');
      }
      expect(answers[2]?.result.content[0].text).toContain('Submission pending');
      expect(answers[5]?.result).toEqual({
        content: [{ type: 'text', text: BRIDGE_ANSWERS.hubUnreachable }],
        isError: true,
      });
    },
    TIMEOUT,
  );

  test(
    'as the brief hook it prints the SessionStart context with the working directory',
    () => {
      const run = Bun.spawnSync([process.execPath, STUB, 'hook', 'brief', '--runner'], {
        env: { PATH: process.env.PATH ?? '', AGFLOW_CLONE: '/work/p/T-1-a1' },
      });
      expect(run.exitCode).toBe(0);
      const output = JSON.parse(run.stdout.toString());
      expect(output.hookSpecificOutput.hookEventName).toBe('SessionStart');
      expect(output.hookSpecificOutput.additionalContext).toContain('Your working directory: /work/p/T-1-a1');
    },
    TIMEOUT,
  );
});

describe('redaction', () => {
  const SESSION = '9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f';
  const OTHER_SESSION = '1e46f8ed-76d5-4281-b1b9-d042abd4cf05';
  const context: RedactionContext = {
    sessionId: SESSION,
    sessionPlaceholder: '$SESSION',
    paths: [
      ['/private/tmp/agflow-record-x1/agflow/work/p/T-1-a1', '$CWD'],
      ['/private/tmp/agflow-record-x1', '/redacted'],
      ['/Users/owner', '/Users/redacted'],
    ],
  };

  function captured(): ClaudeRecording {
    return claudeRecording({
      header: { source: 'captured' },
      answers: {
        initialize: {
          response: {
            account: {
              email: 'owner@example.com',
              organization: 'org-3f2a9b1c-1111-4222-8333-444455556666',
              subscriptionType: 'max',
            },
          },
        },
      },
      turns: [
        [
          {
            frame: {
              type: 'system',
              subtype: 'init',
              session_id: SESSION,
              cwd: '/private/tmp/agflow-record-x1/agflow/work/p/T-1-a1',
              transcript_path:
                '/private/tmp/agflow-record-x1/agflow/runner/homes/claude/projects/' +
                `-private-tmp-agflow-record-x1-agflow-work-p-T-1-a1/${SESSION}.jsonl`,
              note: 'mail owner.name+agflow@corp.example.org or see /Users/owner/.zshrc',
              organization_uuid: '0d1e2f3a-aaaa-4bbb-8ccc-dddddddddddd',
              key: 'sk-ant-api03-agflow-test-dummy-key',
            },
          },
          { frame: { type: 'result', session_id: OTHER_SESSION, new_conversation_id: OTHER_SESSION } },
        ],
      ],
    });
  }

  test('it removes emails, organisation ids, the scratch home and session ids', () => {
    const redacted = redactRecording(captured(), context);
    const text = JSON.stringify(redacted);
    for (const secret of [
      'owner@example.com',
      'owner.name+agflow@corp.example.org',
      '3f2a9b1c',
      '0d1e2f3a',
      'agflow-record-x1',
      '/Users/owner',
      SESSION,
      OTHER_SESSION,
      'dummy-key',
    ]) {
      expect(text).not.toContain(secret);
    }
    const init = redacted.turns[0]?.[0];
    expect(init).toEqual({
      frame: {
        type: 'system',
        subtype: 'init',
        session_id: '$SESSION',
        cwd: '$CWD',
        transcript_path: '/redacted/agflow/runner/homes/claude/projects/-redacted-agflow-work-p-T-1-a1/$SESSION.jsonl',
        note: 'mail agent@example.invalid or see /Users/redacted/.zshrc',
        organization_uuid: SYNTHETIC_ACCOUNT.organization,
        key: 'sk-ant-redacted',
      },
    });
    expect(redacted.answers.initialize).toEqual({
      response: {
        account: {
          email: SYNTHETIC_ACCOUNT.email,
          organization: SYNTHETIC_ACCOUNT.organization,
          subscriptionType: 'max',
        },
      },
    });
    // Another session's id becomes a stable synthetic one, the same wherever it appears.
    const other = redacted.turns[0]?.[1];
    expect(other).toEqual({
      frame: {
        type: 'result',
        session_id: '00000000-0000-4000-8000-000000000001',
        new_conversation_id: '00000000-0000-4000-8000-000000000001',
      },
    });
  });

  test('it is idempotent', () => {
    const once = redactRecording(captured(), context);
    expect(redactRecording(once, context)).toEqual(once);
  });
});

describe('the managed policy', () => {
  const flagSettings = {
    cleanupPeriodDays: 30,
    permissions: { allow: ['mcp__agflow'], deny: ['Bash(gh:*)'] },
    sandbox: { enabled: true, filesystem: { denyRead: ['/redacted/home/.ssh'] } },
  };
  const policySettings = {
    env: { DISABLE_TELEMETRY: '1' },
    permissions: { deny: ['Read(/etc/shadow)', 'Read(~/.gnupg/**)'], disableBypassPermissionsMode: 'disable' },
    disableRemoteControl: true,
    allowedHttpHookUrls: ['http://localhost:*'],
  };
  const userSettings = { permissions: { deny: ['Bash(gh:*)', 'Bash(curl:*)'] }, cleanupPeriodDays: 14 };

  function withSettings(response: Record<string, unknown>): ClaudeRecording {
    return claudeRecording({ answers: { get_settings: { response } }, turns: [] });
  }

  test('it drops the policy source and the lock reason, and rebuilds effective from the other sources', () => {
    const recording = withSettings({
      effective: { ...flagSettings, ...policySettings },
      sources: [
        { source: 'userSettings', settings: userSettings },
        { source: 'flagSettings', settings: flagSettings },
        { source: 'policySettings', settings: policySettings },
      ],
      remote_control_policy_lock_reason: "Remote Control is disabled by your organization's policy.",
      applied: { model: 'claude-sonnet-5-5' },
    });
    const stripped = stripManagedPolicy(recording);
    expect(stripped.answers.get_settings).toEqual({
      response: {
        // Objects merge, arrays concatenate without duplicates, and the later source wins for scalars.
        effective: {
          permissions: { deny: ['Bash(gh:*)', 'Bash(curl:*)'], allow: ['mcp__agflow'] },
          cleanupPeriodDays: 30,
          sandbox: flagSettings.sandbox,
        },
        sources: [
          { source: 'userSettings', settings: userSettings },
          { source: 'flagSettings', settings: flagSettings },
        ],
        applied: { model: 'claude-sonnet-5-5' },
      },
    });
    const text = JSON.stringify(stripped.answers.get_settings);
    for (const policy of ['policy', 'etc/shadow', 'gnupg', 'disableRemoteControl', 'allowedHttpHookUrls', 'env']) {
      expect(text).not.toContain(policy);
    }
    expect(stripManagedPolicy(stripped)).toEqual(stripped);
    // The input is left as it was.
    expect(JSON.stringify(recording)).toContain('policySettings');
  });

  test('an answer without a policy source keeps its effective settings', () => {
    const response = {
      effective: { ...flagSettings, model: 'claude-sonnet-5-5' },
      sources: [{ source: 'flagSettings', settings: flagSettings }],
    };
    expect(stripManagedPolicy(withSettings(response)).answers.get_settings).toEqual({ response });
    const failed = claudeRecording({ answers: { get_settings: { error: 'no settings' } }, turns: [] });
    expect(stripManagedPolicy(failed)).toEqual(failed);
  });

  test('no committed recording carries a managed policy', () => {
    for (const name of ['preflight-ok', 'turn-basic', 'turn-delivery', 'interrupt', 'compaction']) {
      const text = JSON.stringify(loadRecording(name));
      for (const policy of ['policySettings', 'policy_lock', 'etc/shadow', 'disableRemoteControl']) {
        expect(text).not.toContain(policy);
      }
    }
  });
});

describe('the synthetic subscription', () => {
  test('an API-key capture becomes the synthetic subscription account', () => {
    const capture = claudeRecording({
      header: { source: 'captured', account: 'live' },
      answers: {
        initialize: {
          response: {
            account: { email: 'owner@corp.example.org', apiKeySource: 'ANTHROPIC_API_KEY', apiProvider: 'firstParty' },
            models: [{ value: 'claude-sonnet-5-5' }],
          },
        },
        get_usage: { response: { subscription_type: null, rate_limits: null } },
      },
      startup: [{ frame: { type: 'system', subtype: 'hook_started', apiKeySource: 'ANTHROPIC_API_KEY' } }],
      turns: [
        [
          { frame: { type: 'system', subtype: 'init', apiKeySource: 'ANTHROPIC_API_KEY', model: 'claude-sonnet-5-5' } },
          { frame: { type: 'result', subtype: 'success' } },
        ],
      ],
    });
    const subscription = asSubscription(capture);
    expect(subscription.header.account).toBe('synthetic-subscription');
    expect(subscription.answers.initialize).toEqual({
      response: { account: { ...SYNTHETIC_ACCOUNT }, models: [{ value: 'claude-sonnet-5-5' }] },
    });
    expect(subscription.answers.get_usage).toEqual({ response: { subscription_type: 'max', rate_limits: null } });
    expect(subscription.startup).toEqual([
      { frame: { type: 'system', subtype: 'hook_started', apiKeySource: 'none' } },
    ]);
    expect(subscription.turns[0]?.[0]).toEqual({
      frame: { type: 'system', subtype: 'init', apiKeySource: 'none', model: 'claude-sonnet-5-5' },
    });
    expect(JSON.stringify(subscription)).not.toContain('ANTHROPIC_API_KEY');
    expect(JSON.stringify(subscription)).not.toContain('owner@corp.example.org');
  });
});

describe('the recorder', () => {
  test("a live launch is confined by the runner's own layout and runs its pinned claude", () => {
    const runnerHome = realpathSync(mkdtempSync(join(tmpdir(), 'agflow-live-')));
    cleanups.push(() => rmSync(runnerHome, { recursive: true, force: true }));
    const real = runnerPaths(runnerHome);
    const claudeHome = join(runnerHome, 'claude-home');
    mkdirSync(claudeHome);
    const identity = { runnerKey: 'r-1', machineId: 'machine-1', name: 'laptop' };
    saveRunnerConfig(real.config, RunnerConfigSchema.parse({ ...identity, homes: { claude: claudeHome } }));
    const live = () =>
      scratchLaunch({ bin: FAKE_CLAUDE_BIN, model: 'claude-sonnet-5-5', env: {}, live: true, runnerHome });
    const scratchRoot = join(runnerHome, 'scratch');
    mkdirSync(scratchRoot);
    const previousTmp = process.env.TMPDIR;
    try {
      process.env.TMPDIR = scratchRoot;
      expect(live).toThrow(/is missing; run bun run vendor:install/);
      expect(readdirSync(scratchRoot)).toEqual([]);
    } finally {
      if (previousTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmp;
    }

    const pinned = join(real.runner, vendorBinary('claude', CLAUDE_CLI_VERSION));
    mkdirSync(join(pinned, '..'), { recursive: true });
    writeFileSync(pinned, '');
    const launch = live();
    cleanups.push(launch.cleanup);
    // runner.json's Claude home, verbatim: the CLI finds its login by that string.
    expect(launch.vendorHomes).toEqual({ claude: claudeHome, codex: real.homes.codex });
    // Its empty directory, where the bridge and the brief hook start, is there.
    expect(statSync(claudeEmptyDir(claudeHome)).isDirectory()).toBe(true);
    expect(launch.launch.env.CLAUDE_CONFIG_DIR).toBe(claudeHome);
    expect(launch.launch.env.HOME).toBe(homedir());
    // The clone stays in the scratch directory, outside the real work root.
    expect(launch.clone.startsWith(`${launch.root}/`)).toBe(true);
    expect(launch.clone.startsWith(`${real.work}/`)).toBe(false);
    const options = buildQueryOptions(launch.launch, {
      agflow: launch.agflow,
      paths: launch.paths,
      vendorHomes: launch.vendorHomes,
      autoOffered: false,
      spawnClaudeCodeProcess: () => {
        throw new Error('not spawned');
      },
      compaction: { preCompact: async () => ({}), postCompact: async () => ({}) },
    });
    expect(options.pathToClaudeCodeExecutable).toBe(pinned);
    expect(options.sandbox?.filesystem?.denyRead).toContain(real.runner);
    expect(options.sandbox?.filesystem?.denyRead).toContain(join(real.work, '*', '*'));
    expect(options.settings).toMatchObject({
      permissions: { deny: expect.arrayContaining([`Read(/${join(real.runner, 'homes', 'codex', '**')})`]) },
    });
  });

  test("it requires the transcript under the clone's project directory", () => {
    const launch = scratchLaunch({ bin: FAKE_CLAUDE_BIN, model: 'claude-sonnet-5-5', env: {} });
    cleanups.push(launch.cleanup);
    const claudeHome = launch.vendorHomes.claude;
    const session = '11111111-2222-4333-8444-555555555555';
    expect(() => assertTranscriptPlacement(claudeHome, launch.clone, session)).toThrow(
      /not under .*projects\/.*a pin that renames project directories/,
    );
    // Where an older or newer pin might put it: under a differently formed slug.
    mkdirSync(join(claudeHome, 'projects', 'renamed'), { recursive: true });
    writeFileSync(join(claudeHome, 'projects', 'renamed', `${session}.jsonl`), '{}\n');
    expect(() => assertTranscriptPlacement(claudeHome, launch.clone, session)).toThrow(/projects\/renamed/);
    const expected = join(claudeProjectDir(claudeHome, launch.clone), `${session}.jsonl`);
    mkdirSync(join(expected, '..'), { recursive: true });
    writeFileSync(expected, '{}\n');
    expect(assertTranscriptPlacement(claudeHome, launch.clone, session)).toBe(expected);
  });
});

describe('the base recordings replay through the fake claude and the SDK', () => {
  test(
    'turn-basic: a Bash call, a refused call, bridge answers and text',
    async () => {
      const { recording, run, launch } = await replay('turn-basic');
      expect(recording.header).toMatchObject({ cliVersion: '2.1.285', account: 'synthetic-subscription' });
      expectRoundTrip(recording, run, launch);
      const frames = out(run);
      const tools = frames
        .filter((frame) => frame.type === 'assistant')
        .flatMap((frame) => frame.message.content)
        .filter((block: { type: string }) => block.type === 'tool_use');
      expect(tools.map((tool: { name: string }) => tool.name)).toEqual([
        'Bash',
        'Bash',
        'mcp__agflow__report_progress',
        'mcp__agflow__submit',
      ]);
      const results = frames
        .filter((frame) => frame.type === 'user')
        .flatMap((frame) => frame.message.content)
        .filter((block: { type: string }) => block.type === 'tool_result');
      expect(results).toHaveLength(4);
      expect(results[1].is_error).toBe(true);
      // The untyped mark of a refused call, as 2.1.285 prints it (outline Q2).
      const refused = frames.find(
        (frame) =>
          frame.type === 'user' &&
          frame.message.content.some((block: { tool_use_id?: string }) => block.tool_use_id === 'toolu_basic_2'),
      );
      expect(refused?.tool_result_meta).toEqual([{ id: 'toolu_basic_2', non_execution_kind: 'permission-rule' }]);
      expect(JSON.stringify(results[2])).toContain(BRIDGE_ANSWERS.hubUnreachable);
      expect(results[2].is_error).toBe(true);
      expect(JSON.stringify(results[3])).toContain('Submission pending');
      const result = first(run, (frame) => frame.type === 'result');
      expect(result).toMatchObject({ subtype: 'success', is_error: false, session_id: run.sessionId });
      expect(result.user_message_uuids).toEqual(run.sent);
      // The guard answered the refused call's PreToolUse hook.
      const denied = run.hookAnswers.find((answer) => JSON.stringify(answer).includes('"deny"'));
      expect(denied).toBeDefined();
    },
    TIMEOUT,
  );

  test(
    'turn-delivery: a message folded in at a tool boundary',
    async () => {
      const { recording, run, launch } = await replay('turn-delivery');
      expectRoundTrip(recording, run, launch);
      const frames = out(run);
      const [message, note] = run.sent;
      const started = frames.filter((frame) => frame.type === 'command_lifecycle' && frame.state === 'started');
      expect(started.map((frame) => frame.command_uuid)).toEqual([message, note]);
      const result = first(run, (frame) => frame.type === 'result');
      expect(result.user_message_uuids).toEqual([message, note]);
      // Folded into the first turn: one result for both messages.
      expect(frames.filter((frame) => frame.type === 'result')).toHaveLength(1);
    },
    TIMEOUT,
  );

  test(
    'interrupt: the turn ends as an aborted execution',
    async () => {
      const { recording, run, launch } = await replay('interrupt');
      expectRoundTrip(recording, run, launch);
      // Only the recording holds the rejected tool result: the fake's own abort (writeAborted) has none, so this
      // proves the recorded end was replayed.
      const rejected = first(run, (frame) => frame.type === 'user' && Array.isArray(frame.tool_result_meta));
      expect(rejected.tool_result_meta).toEqual([{ id: 'toolu_interrupt_1', non_execution_kind: 'user-rejected' }]);
      const result = first(run, (frame) => frame.type === 'result');
      expect(result).toMatchObject({ subtype: 'error_during_execution', is_error: true });
      expect(['aborted_tools', 'aborted_streaming']).toContain(result.terminal_reason);
      const interrupt = run.events.find((event) => event.dir === 'in' && event.frame.request?.subtype === 'interrupt');
      expect(interrupt?.frame.request.cancel_queued).toBe(true);
    },
    TIMEOUT,
  );

  test(
    'compaction: PreCompact, then PostCompact with a summary',
    async () => {
      const { recording, run, launch } = await replay('compaction');
      expectRoundTrip(recording, run, launch);
      expect(run.compactions.map((input) => input.hook_event_name)).toEqual(['PreCompact', 'PostCompact']);
      const post = run.compactions[1] as { compact_summary?: string };
      expect(post.compact_summary).toContain('Summary');
    },
    TIMEOUT,
  );

  test(
    "preflight-ok: /clear only, a correct session's init, and the sandbox on",
    async () => {
      const { recording, run, launch } = await replay('preflight-ok');
      expectRoundTrip(recording, run, launch);
      const init = first(run, (frame) => frame.type === 'system' && frame.subtype === 'init');
      expect(init).toMatchObject({
        apiKeySource: 'none',
        claude_code_version: '2.1.285',
        model: 'claude-sonnet-5-5',
        permissionMode: 'acceptEdits',
        mcp_servers: [{ name: 'agflow', status: 'connected' }],
      });
      // Design 8.1: the requested built-ins plus the bridge's tools, and nothing else.
      const builtins = init.tools.filter((tool: string) => !tool.startsWith('mcp__agflow__'));
      expect(builtins.sort()).toEqual([...CLAUDE_BUILTIN_TOOLS].sort());
      const bridge = init.tools.filter((tool: string) => tool.startsWith('mcp__agflow__'));
      expect(bridge.sort()).toEqual(STUB_BRIDGE_TOOLS.map((tool) => `mcp__agflow__${tool}`).sort());
      expect(init.plugins.every((plugin: { path: string }) => plugin.path === 'builtin')).toBe(true);
      expect(run.initialization).toMatchObject({ account: { subscriptionType: 'max' } });
      expect(run.initialization).not.toHaveProperty('account.apiKeySource');
      expect(run.settings).toMatchObject({ effective: { sandbox: { enabled: true, failIfUnavailable: true } } });
      expect(recording.turns).toHaveLength(1);
      // /clear asks the model nothing, so the recording holds no assistant frame.
      expect(out(run).some((frame) => frame.type === 'assistant')).toBe(false);
      expect(run.sentTexts).toEqual(['/clear']);
    },
    TIMEOUT,
  );
});
