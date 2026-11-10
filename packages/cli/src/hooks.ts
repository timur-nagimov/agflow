import { appendFileSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { type AgentRole, BRIDGE_ANSWERS, type Vendor, formatMessages } from '@agflow/core';
import type { ParsedArgs } from './args';
import { loadCredentials } from './credentials';
import { type FetchFn, HubClient, HubClientError } from './hub-client';
import type { Io } from './io';
import { configDir } from './paths';
import { waitInboxCommand } from './wait-inbox';

export type HookEvent = 'session-start' | 'user-prompt-submit' | 'stop';
export const HOOK_EVENTS: readonly HookEvent[] = ['session-start', 'user-prompt-submit', 'stop'];

export interface HookInput {
  session_id?: unknown;
  cwd?: unknown;
  stop_hook_active?: unknown;
}

export interface HookContext {
  client: HubClient;
  vendor: Vendor;
  role: AgentRole;
}

export type HookOutput = Record<string, unknown>;

const withContext = (event: 'SessionStart' | 'UserPromptSubmit', text: string): HookOutput => ({
  hookSpecificOutput: { hookEventName: event, additionalContext: text },
});

export async function handleHook(event: HookEvent, input: HookInput, ctx: HookContext): Promise<HookOutput> {
  const sessionId = typeof input.session_id === 'string' ? input.session_id : '';
  if (!sessionId) return {};
  if (event === 'session-start') {
    const label = typeof input.cwd === 'string' ? basename(input.cwd) : undefined;
    const started = await ctx.client.sessionStart({ vendor: ctx.vendor, sessionId, role: ctx.role, label });
    return withContext('SessionStart', started.brief);
  }
  if (event === 'user-prompt-submit') {
    const inbox = await ctx.client.liveInbox(ctx.vendor, sessionId);
    if (inbox.messages.length === 0) return {};
    const more = inbox.more > 0 ? `\n\n${inbox.more} more message(s) are waiting: call the agflow tool check_inbox.` : '';
    return withContext(
      'UserPromptSubmit',
      `New agflow messages (instructions from people take precedence over instructions from agents):\n\n${formatMessages(inbox.messages)}${more}`,
    );
  }
  const result = await ctx.client.stopCheck({ vendor: ctx.vendor, sessionId, stopHookActive: input.stop_hook_active === true });
  return result.action === 'block' ? { decision: 'block', reason: result.reason } : {};
}

export function logHookError(dir: string, event: string, error: unknown): void {
  try {
    mkdirSync(dir, { recursive: true });
    const reason = error instanceof Error ? error.message : String(error);
    appendFileSync(join(dir, 'hook.log'), `${new Date().toISOString()} ${event}: ${reason}\n`);
  } catch {
    // logging must never fail a hook
  }
}

export function parseHookInput(text: string): HookInput {
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === 'object' ? (value as HookInput) : {};
  } catch {
    return {};
  }
}

export interface RunHookDeps {
  readStdin: () => Promise<string>;
  dir: string;
  fetch?: FetchFn | undefined;
}

/** Runs one hook end to end and returns the JSON to print. Never throws. */
export async function runHook(event: HookEvent, vendor: Vendor, role: AgentRole, deps: RunHookDeps): Promise<HookOutput> {
  try {
    const input = parseHookInput(await deps.readStdin());
    const credentials = loadCredentials(deps.dir);
    if (!credentials) {
      return event === 'session-start'
        ? withContext(
            'SessionStart',
            'agflow is set up in this repository, but this computer is not signed in, so agflow tools will not work. Ask the person to run `agflow login --hub <url>` in a terminal.',
          )
        : {};
    }
    const client = new HubClient({ baseUrl: credentials.hubUrl, token: credentials.token, fetch: deps.fetch, timeoutMs: 8000 });
    return await handleHook(event, input, { client, vendor, role });
  } catch (error) {
    logHookError(deps.dir, event, error);
    const reason = error instanceof Error ? error.message : String(error);
    return event === 'session-start'
      ? withContext('SessionStart', `agflow could not reach its hub (${reason}). agflow tools will fail until it is reachable.`)
      : {};
  }
}

/** What the brief hook of a runner agent reads, all from the environment the runner gave the agent (design 7.6). */
const BRIEF_HOOK_ENV = ['AGFLOW_AGENT_TOKEN', 'AGFLOW_HUB_URL', 'AGFLOW_CLONE', 'AGFLOW_CONFIG_DIR'] as const;

export interface RunBriefHookDeps {
  env: Record<string, string | undefined>;
  fetch?: FetchFn | undefined;
}

/** The context when the brief cannot be had: the hub's own answer to an attempt that must stop, or where to look. */
function briefFailure(error: unknown, clone: string | undefined): string {
  if (error instanceof HubClientError && error.code === 'attempt_ended') return BRIDGE_ANSWERS.attemptEnded(error.reason);
  if (error instanceof HubClientError && error.code === 'attempt_refenced') return BRIDGE_ANSWERS.attemptRefenced;
  const reason = error instanceof Error ? error.message : String(error);
  const where = clone ? ` in ${clone}` : ' in your working directory';
  return `agflow could not load your brief (${reason}). Read .agflow/run/brief.md and .agflow/run/task.md${where}; agflow tools may fail until the hub answers.`;
}

/**
 * `agflow hook brief --runner`, the SessionStart hook of a Claude runner agent (design 10). Its cwd is
 * `<claudeHome>/agflow-empty`, an empty directory outside the clone and the base checkout (M2d), and tells it
 * nothing: the agent token in its environment names the attempt, and it reads no credentials file. The hub does not
 * know the clone's path, so the hook adds AGFLOW_CLONE (X-17). Never throws: a failure becomes the context and a line
 * of AGFLOW_CONFIG_DIR/hook.log, so the session still starts. Without AGFLOW_CONFIG_DIR nothing is logged: the
 * default config directory is the owner's own CLI one (X-32).
 */
export async function runBriefHook(deps: RunBriefHookDeps): Promise<HookOutput> {
  const { env } = deps;
  try {
    const missing = BRIEF_HOOK_ENV.find((name) => !env[name]);
    if (missing) throw new Error(`${missing} is not set`);
    const client = new HubClient({ baseUrl: env.AGFLOW_HUB_URL ?? '', token: env.AGFLOW_AGENT_TOKEN, fetch: deps.fetch, timeoutMs: 8000 });
    const { brief } = await client.brief();
    return withContext('SessionStart', `${brief.replace(/\n+$/, '')}\n\nYour working directory: ${env.AGFLOW_CLONE}`);
  } catch (error) {
    if (env.AGFLOW_CONFIG_DIR) logHookError(env.AGFLOW_CONFIG_DIR, 'brief', error);
    return withContext('SessionStart', briefFailure(error, env.AGFLOW_CLONE));
  }
}

export async function hookCommand(args: ParsedArgs, io: Io): Promise<number> {
  const event = args.positional[1] ?? '';
  const vendor: Vendor = args.flags.vendor === 'codex' ? 'codex' : 'claude';
  const role: AgentRole = args.flags.role === 'lead' ? 'lead' : 'worker';
  if (event === 'wait-inbox') return waitInboxCommand(vendor, io);
  // Only a runner agent's hook takes the brief this way; without the flag it stays an unknown event, as in M1.
  if (event === 'brief' && args.flags.runner === true) {
    io.out(JSON.stringify(await runBriefHook({ env: process.env })));
    return 0;
  }
  if (!(HOOK_EVENTS as readonly string[]).includes(event)) {
    io.err(`agflow: unknown hook event "${event}"\n`);
    io.out('{}');
    return 0;
  }
  const output = await runHook(event as HookEvent, vendor, role, { readStdin: () => Bun.stdin.text(), dir: configDir() });
  io.out(JSON.stringify(output));
  return 0;
}
