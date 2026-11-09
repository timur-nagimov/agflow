import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { TEST_ACCOUNT_ID } from '@agflow/core';
import { loadRecording } from '@agflow/testkit/src/fake-claude';
import type { AccountInfo, SDKSystemMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  CLAUDE_BUILTIN_PLUGINS,
  checkAccount,
  checkEffectiveSettings,
  checkSystemInit,
  claudeAccountId,
} from '../../../src/adapters/claude/checks';
import { CLAUDE_BUILTIN_TOOLS } from '../../../src/adapters/claude/options';
import { CLAUDE_CLI_VERSION } from '../../../src/adapters/claude/pin';

const preflight = loadRecording('preflight-ok');

/** preflight-ok's system/init, with the placeholders the replay fills set to the recording's own values. */
function recordedInit(): SDKSystemMessage {
  const step = preflight.turns
    .flat()
    .find((s) => 'frame' in s && s.frame.type === 'system' && s.frame.subtype === 'init');
  if (step === undefined || !('frame' in step)) throw new Error('preflight-ok has no system/init');
  return {
    ...structuredClone(step.frame),
    cwd: '/work/p/T-1-a1',
    model: preflight.header.model,
    permissionMode: preflight.header.permissionMode,
  } as unknown as SDKSystemMessage;
}

function recordedAnswer(subtype: string): Record<string, unknown> {
  const answer = preflight.answers[subtype];
  if (answer === undefined || !('response' in answer)) throw new Error(`preflight-ok has no ${subtype} answer`);
  return structuredClone(answer.response);
}

const expected = { cliVersion: CLAUDE_CLI_VERSION, permissionMode: 'acceptEdits', tools: CLAUDE_BUILTIN_TOOLS };

describe('checkSystemInit', () => {
  test('the init of preflight-ok passes', () => {
    expect(checkSystemInit(recordedInit(), expected)).toEqual([]);
  });

  test("an apiKeySource other than 'none' is a problem; ANTHROPIC_API_KEY reads 'an API key would replace the subscription'", () => {
    expect(checkSystemInit({ ...recordedInit(), apiKeySource: 'ANTHROPIC_API_KEY' }, expected)).toEqual([
      'an API key would replace the subscription',
    ]);
    expect(checkSystemInit({ ...recordedInit(), apiKeySource: 'apiKeyHelper' }, expected)).toEqual([
      'an API key would replace the subscription (apiKeyHelper)',
    ]);
  });

  test('a claude_code_version other than the expected one and a permissionMode other than the effective one are problems', () => {
    const init = { ...recordedInit(), claude_code_version: '2.1.200', permissionMode: 'default' as const };
    expect(checkSystemInit(init, expected)).toEqual([
      `claude 2.1.200, expected ${CLAUDE_CLI_VERSION}`,
      'permission mode default, expected acceptEdits',
    ]);
    expect(checkSystemInit(recordedInit(), { ...expected, permissionMode: 'auto' })).toEqual([
      'permission mode acceptEdits, expected auto',
    ]);
  });

  test('tools must equal the requested built-ins plus at least one mcp__agflow__* tool; extra and missing tools are named', () => {
    const init = recordedInit();
    const bridgeTools = init.tools.filter((tool) => tool.startsWith('mcp__agflow__'));
    expect(checkSystemInit({ ...init, tools: [...init.tools].reverse() }, expected)).toEqual([]);
    expect(
      checkSystemInit(
        { ...init, tools: [...init.tools.filter((t) => t !== 'Bash' && t !== 'Grep'), 'WebFetch', 'SendMessage'] },
        expected,
      ),
    ).toEqual(['missing tools: Bash, Grep', 'unexpected tools: WebFetch, SendMessage']);
    expect(checkSystemInit({ ...init, tools: [...CLAUDE_BUILTIN_TOOLS] }, expected)).toEqual([
      'no agflow bridge tools',
    ]);
    expect(
      checkSystemInit({ ...init, tools: [...CLAUDE_BUILTIN_TOOLS, 'WebFetch', 'WebSearch', ...bridgeTools] }, {
        ...expected,
        tools: [...CLAUDE_BUILTIN_TOOLS, 'WebFetch', 'WebSearch'],
      }),
    ).toEqual([]);
    expect(checkSystemInit({ ...init, tools: [...init.tools, 'mcp__other__tool'] }, expected)).toEqual([
      'unexpected tools: mcp__other__tool',
    ]);
  });

  test('mcp_servers must be agflow alone, and connected', () => {
    const init = recordedInit();
    const agflow = { name: 'agflow', status: 'connected' };
    const github = { name: 'github', status: 'connected' };
    expect(checkSystemInit({ ...init, mcp_servers: [agflow, github] }, expected)).toEqual([
      'unexpected MCP servers: github',
    ]);
    expect(checkSystemInit({ ...init, mcp_servers: [{ name: 'agflow', status: 'failed' }] }, expected)).toEqual([
      'the agflow MCP server is failed',
    ]);
    expect(checkSystemInit({ ...init, mcp_servers: [] }, expected)).toEqual(['the agflow MCP server is missing']);
  });

  test('plugins must be only CLAUDE_BUILTIN_PLUGINS, the built-in plugins the pinned CLI registers', () => {
    const init = recordedInit();
    expect(init.plugins.length).toBeGreaterThan(0);
    for (const { name, path } of init.plugins) expect(CLAUDE_BUILTIN_PLUGINS).toContainEqual({ name, path });
    expect(checkSystemInit({ ...init, plugins: [] }, expected)).toEqual([]);
    // Which built-ins a session lists depends on the account's feature flags; any of them is accepted.
    const builtins = CLAUDE_BUILTIN_PLUGINS.map(({ name, path }) => ({ name, path, source: `${name}@builtin` }));
    expect(builtins.map(({ name }) => name)).toContain('cc-plugin-tips');
    expect(checkSystemInit({ ...init, plugins: builtins }, expected)).toEqual([]);
    expect(
      checkSystemInit(
        {
          ...init,
          plugins: [
            ...init.plugins,
            { name: 'superpowers', path: '/Users/owner/.claude/plugins/superpowers' },
            { name: 'cc-plugin-agents-md', path: '/tmp/look-alike' },
          ],
        },
        expected,
      ),
    ).toEqual([
      'unexpected plugins: superpowers (/Users/owner/.claude/plugins/superpowers), ' +
        'cc-plugin-agents-md (/tmp/look-alike)',
    ]);
  });

  test('skipAuthChecks waives the apiKeySource check and nothing else', () => {
    const init = { ...recordedInit(), apiKeySource: 'ANTHROPIC_API_KEY' as const };
    expect(checkSystemInit(init, { ...expected, skipAuthChecks: true })).toEqual([]);
    const older = { ...init, claude_code_version: '2.1.200' };
    expect(checkSystemInit(older, { ...expected, skipAuthChecks: true })).toEqual([
      `claude 2.1.200, expected ${CLAUDE_CLI_VERSION}`,
    ]);
  });
});

describe('checkAccount', () => {
  const recorded = recordedAnswer('initialize').account as AccountInfo;

  test("preflight-ok's account is ready, with the account id and the plan", () => {
    expect(checkAccount(recorded)).toEqual({
      ready: true,
      problem: null,
      accountId: claudeAccountId(recorded),
      plan: 'Claude Max',
    });
  });

  test('a subscription type is required, and any apiKeySource is a problem', () => {
    expect(checkAccount({ ...recorded, subscriptionType: undefined })).toMatchObject({
      ready: false,
      problem: 'not logged in',
      plan: null,
    });
    expect(checkAccount(undefined)).toEqual({ ready: false, problem: 'not logged in', accountId: null, plan: null });
    expect(checkAccount({ apiKeySource: 'ANTHROPIC_API_KEY' })).toEqual({
      ready: false,
      problem: 'an API key would replace the subscription',
      accountId: null,
      plan: null,
    });
    expect(checkAccount({ ...recorded, apiKeySource: '/login managed key' })).toMatchObject({
      ready: false,
      problem: 'an API key would replace the subscription (/login managed key)',
    });
  });

  test("max, pro, team and enterprise read 'Claude Max', 'Claude Pro', 'Claude Team' and 'Claude Enterprise'", () => {
    const plans = ['max', 'pro', 'team', 'enterprise', 'founders'].map(
      (subscriptionType) => checkAccount({ ...recorded, subscriptionType }).plan,
    );
    expect(plans).toEqual(['Claude Max', 'Claude Pro', 'Claude Team', 'Claude Enterprise', 'Claude founders']);
  });

  test('skipAuthChecks gives ready, accountId TEST_ACCOUNT_ID, plan "test mode" and the problem "test mode"', () => {
    const facts = { ready: true, problem: 'test mode', accountId: TEST_ACCOUNT_ID, plan: 'test mode' };
    expect(checkAccount({ apiKeySource: 'ANTHROPIC_API_KEY' }, { skipAuthChecks: true })).toEqual(facts);
    expect(checkAccount(undefined, { skipAuthChecks: true })).toEqual(facts);
  });
});

describe('claudeAccountId', () => {
  test('the first 16 hex of sha256 of the email, or of the organisation without one', () => {
    const sha = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16);
    expect(claudeAccountId({ email: 'owner@example.com', organization: 'org-1' })).toBe(sha('owner@example.com'));
    expect(claudeAccountId({ organization: 'org-1' })).toBe(sha('org-1'));
    expect(claudeAccountId({ email: '', organization: '' })).toBeNull();
    expect(claudeAccountId({})).toBeNull();
    // Core's test-mode id is the same hash of 'agflow-test'.
    expect(claudeAccountId({ email: 'agflow-test' })).toBe(TEST_ACCOUNT_ID);
  });
});

describe('checkEffectiveSettings', () => {
  test("preflight-ok's effective settings pass", () => {
    expect(checkEffectiveSettings(recordedAnswer('get_settings').effective)).toEqual([]);
  });

  test('sandbox.enabled and sandbox.failIfUnavailable must be true', () => {
    expect(checkEffectiveSettings({ sandbox: { enabled: false, failIfUnavailable: true } })).toEqual([
      'the sandbox is not enabled',
    ]);
    expect(checkEffectiveSettings({ sandbox: { enabled: true } })).toEqual([
      'the sandbox would let commands run unsandboxed when it is unavailable',
    ]);
    expect(checkEffectiveSettings({ sandbox: { enabled: 'true', failIfUnavailable: 1 } })).toHaveLength(2);
    for (const effective of [{}, null, undefined, 'x', { sandbox: null }]) {
      expect(checkEffectiveSettings(effective)).toEqual([
        'the sandbox is not enabled',
        'the sandbox would let commands run unsandboxed when it is unavailable',
      ]);
    }
  });
});
