import { appendFileSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { type AgentRole, type Vendor, formatMessages } from '@agflow/core';
import type { ParsedArgs } from './args';
import { loadCredentials } from './credentials';
import { type FetchFn, HubClient } from './hub-client';
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

export async function hookCommand(args: ParsedArgs, io: Io): Promise<number> {
  const event = args.positional[1] ?? '';
  const vendor: Vendor = args.flags.vendor === 'codex' ? 'codex' : 'claude';
  const role: AgentRole = args.flags.role === 'lead' ? 'lead' : 'worker';
  if (event === 'wait-inbox') return waitInboxCommand(vendor, io);
  if (!(HOOK_EVENTS as readonly string[]).includes(event)) {
    io.err(`agflow: unknown hook event "${event}"\n`);
    io.out('{}');
    return 0;
  }
  const output = await runHook(event as HookEvent, vendor, role, { readStdin: () => Bun.stdin.text(), dir: configDir() });
  io.out(JSON.stringify(output));
  return 0;
}
