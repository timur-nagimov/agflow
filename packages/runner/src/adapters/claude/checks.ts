// The checks behind preflight's handshake and every session's first turn (design 8.1, 5, 15.1): what system/init,
// initializationResult().account and the untyped getSettings().effective must hold, as the problem strings the Runners
// card shows, and the account facts (accountId, plan) the hub keys quota by. Pure, so the recordings pin them.
import { createHash } from 'node:crypto';
import { type RunnerVendor, TEST_ACCOUNT_ID } from '@agflow/core';
import type { AccountInfo, SDKSystemMessage } from '@anthropic-ai/claude-agent-sdk';
import { isRecord } from './json';

/**
 * The built-in plugins 2.1.285 registers, copied from the binary, so they change with the pin. Each is reported with
 * path 'builtin' when its gate turns it on; most gates are account feature flags, so which ones a session lists
 * depends on the account (the preflight-ok capture, made without fetching flags, lists cc-plugin-agents-md only).
 * Anything else came from a marketplace or a plugin directory, and so from outside the runner's control.
 */
export const CLAUDE_BUILTIN_PLUGINS: readonly { name: string; path: string }[] = Object.freeze(
  [
    'cc-plugin-sec-default',
    'cc-plugin-agents-md',
    'cc-plugin-telemetry',
    'cc-plugin-plugin-authoring',
    'cc-plugin-mods-guide',
    'cc-plugin-tips',
    'cc-plugin-mermaid',
    'cc-plugin-responsive-mode',
    'cc-plugin-diff',
    'cc-plugin-claude-test',
  ].map((name) => Object.freeze({ name, path: 'builtin' })),
);

/** The prefix of every agflow bridge tool: the only MCP server a session has. */
const BRIDGE_TOOL_PREFIX = 'mcp__agflow__';
const BRIDGE_SERVER = 'agflow';

/** The problem preflight shows, with a ready vendor, under skipAuthChecks (design 15.1). */
const TEST_MODE = 'test mode';

const PLANS: Record<string, string> = {
  max: 'Claude Max',
  pro: 'Claude Pro',
  team: 'Claude Team',
  enterprise: 'Claude Enterprise',
};

export interface SystemInitExpectation {
  /** The attempt's CLI version, or the pin for preflight. */
  cliVersion: string;
  /** effectivePermissionMode(profile, autoOffered). */
  permissionMode: string;
  /** The built-in tools the session asked for. */
  tools: readonly string[];
  /** Test mode: the scripted server's API key is expected, so apiKeySource is not checked. */
  skipAuthChecks?: boolean;
}

/** What a session's system/init gets wrong; empty when it is the session the options asked for. */
export function checkSystemInit(init: SDKSystemMessage, expected: SystemInitExpectation): string[] {
  const problems: string[] = [];
  if (!expected.skipAuthChecks && init.apiKeySource !== 'none') problems.push(apiKeyProblem(init.apiKeySource));
  if (init.claude_code_version !== expected.cliVersion) {
    problems.push(`claude ${init.claude_code_version}, expected ${expected.cliVersion}`);
  }
  if (init.permissionMode !== expected.permissionMode) {
    problems.push(`permission mode ${init.permissionMode}, expected ${expected.permissionMode}`);
  }

  const tools = init.tools ?? [];
  const missing = expected.tools.filter((tool) => !tools.includes(tool));
  const extra = tools.filter((tool) => !expected.tools.includes(tool) && !tool.startsWith(BRIDGE_TOOL_PREFIX));
  if (missing.length > 0) problems.push(`missing tools: ${missing.join(', ')}`);
  if (extra.length > 0) problems.push(`unexpected tools: ${extra.join(', ')}`);
  if (!tools.some((tool) => tool.startsWith(BRIDGE_TOOL_PREFIX))) problems.push('no agflow bridge tools');

  const servers = init.mcp_servers ?? [];
  const others = servers.filter((server) => server.name !== BRIDGE_SERVER);
  if (others.length > 0) problems.push(`unexpected MCP servers: ${others.map((server) => server.name).join(', ')}`);
  const bridge = servers.find((server) => server.name === BRIDGE_SERVER);
  if (bridge === undefined) problems.push('the agflow MCP server is missing');
  else if (bridge.status !== 'connected') problems.push(`the agflow MCP server is ${bridge.status}`);

  const plugins = (init.plugins ?? []).filter(
    (plugin) => !CLAUDE_BUILTIN_PLUGINS.some((builtin) => builtin.name === plugin.name && builtin.path === plugin.path),
  );
  if (plugins.length > 0) {
    problems.push(`unexpected plugins: ${plugins.map((plugin) => `${plugin.name} (${plugin.path})`).join(', ')}`);
  }
  return problems;
}

export type ClaudeAccountFacts = Pick<RunnerVendor, 'ready' | 'problem' | 'accountId' | 'plan'>;

/**
 * The account initializationResult() reports: ready with a subscription and no API key. Under skipAuthChecks it is
 * test mode's identity instead (X-21), whatever the scripted server's key looks like.
 */
export function checkAccount(
  account: AccountInfo | null | undefined,
  options: { skipAuthChecks?: boolean } = {},
): ClaudeAccountFacts {
  if (options.skipAuthChecks) return { ready: true, problem: TEST_MODE, accountId: TEST_ACCOUNT_ID, plan: TEST_MODE };
  const accountId = account ? claudeAccountId(account) : null;
  const type = account?.subscriptionType;
  const plan = type ? (PLANS[type] ?? `Claude ${type}`) : null;
  let problem: string | null = null;
  if (account?.apiKeySource) problem = apiKeyProblem(account.apiKeySource);
  else if (!type) problem = 'not logged in';
  return { ready: problem === null, problem, accountId, plan };
}

/** The first 16 hex of sha256 of the account's email, or of its organisation without one; null without either. */
export function claudeAccountId(account: Pick<AccountInfo, 'email' | 'organization'>): string | null {
  const identity = account.email || account.organization;
  if (!identity) return null;
  return createHash('sha256').update(identity).digest('hex').slice(0, 16);
}

/**
 * What getSettings().effective gets wrong about the sandbox; the SDK leaves it untyped, so any shape is read. The
 * sandbox must be on and must fail closed: a CLI that cannot start it then runs no command instead of running it bare.
 */
export function checkEffectiveSettings(effective: unknown): string[] {
  const sandbox = isRecord(effective) && isRecord(effective.sandbox) ? effective.sandbox : {};
  const problems: string[] = [];
  if (sandbox.enabled !== true) problems.push('the sandbox is not enabled');
  if (sandbox.failIfUnavailable !== true) {
    problems.push('the sandbox would let commands run unsandboxed when it is unavailable');
  }
  return problems;
}

function apiKeyProblem(source: string): string {
  const problem = 'an API key would replace the subscription';
  return source === 'ANTHROPIC_API_KEY' ? problem : `${problem} (${source})`;
}
