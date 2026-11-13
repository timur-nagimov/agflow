import { AGFLOW_VERSION, type AgentRole, BRIDGE_ANSWERS } from '@agflow/core';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { type ParsedArgs, choiceFlag } from '../args';
import { loadCredentials } from '../credentials';
import { HubClient, HubClientError } from '../hub-client';
import type { Io } from '../io';
import { configDir } from '../paths';
import { type RunnerToolContext, runnerToolsFor } from './runner-tools';
import { type ToolContext, type ToolDef, allTools } from './tools';

/**
 * A tool's failure as the agent reads it. The hub's answers to an attempt that must stop, and an unreachable hub in
 * every mode, are core's BRIDGE_ANSWERS word for word: adapters recognise the unreachable one (X-19).
 */
export function errorText(error: unknown): string {
  if (error instanceof HubClientError) {
    if (error.code === 'unreachable') return BRIDGE_ANSWERS.hubUnreachable;
    if (error.status === 401 && error.code === 'attempt_ended') return BRIDGE_ANSWERS.attemptEnded(error.reason);
    if (error.status === 401 && error.code === 'attempt_refenced') return BRIDGE_ANSWERS.attemptRefenced;
    return `agflow hub: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** Every tool's answer: its text as a normal result, or any failure as an error result. */
export function createMcpServer(ctx: ToolContext, tools: ToolDef[] = allTools): McpServer {
  const server = new McpServer({ name: 'agflow', version: AGFLOW_VERSION });
  for (const tool of tools) {
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.input }, async (args: Record<string, unknown>) => {
      try {
        return { content: [{ type: 'text' as const, text: await tool.run(args, ctx) }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: errorText(error) }], isError: true };
      }
    });
  }
  return server;
}

/** What the runner gives the bridge of every attempt (design 10, 7.6); the bridge refuses to start without one. */
export const REQUIRED_RUNNER_ENV = ['AGFLOW_AGENT_TOKEN', 'AGFLOW_HUB_URL', 'AGFLOW_ATTEMPT_ID', 'AGFLOW_ROLE', 'AGFLOW_CONFIG_DIR'] as const;

/** The runner's timings.bridgePoll and timings.bridgePollMax defaults (2 s, 3 minutes; design 6.13), for a runner that passes none. */
const DEFAULT_POLL_MS = 2_000;
const DEFAULT_POLL_MAX_MS = 3 * 60_000;

function positiveMs(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * The runner mode's context, from the agent environment alone: the agent token is the bearer and names the agent, so
 * no credentials file is read and nothing asks the hub until a tool is called. Throws, naming them, when variables are
 * missing; Codex's required MCP server then fails the thread's start.
 */
export function runnerToolContext(env: Record<string, string | undefined>): RunnerToolContext {
  const missing = REQUIRED_RUNNER_ENV.filter((name) => !env[name]);
  if (missing.length > 0) throw new Error(`agflow mcp --runner needs ${missing.join(', ')} in its environment; the runner sets them for its agents`);
  const role = env.AGFLOW_ROLE;
  if (role !== 'worker' && role !== 'lead') throw new Error(`AGFLOW_ROLE must be worker or lead, not "${role}"`);
  const client = new HubClient({ baseUrl: env.AGFLOW_HUB_URL as string, token: env.AGFLOW_AGENT_TOKEN });
  return {
    client,
    // The token names the agent, so tools need no hello.
    state: { agentId: null, role: role as AgentRole },
    cwd: process.cwd(),
    runner: {
      attemptId: env.AGFLOW_ATTEMPT_ID as string,
      role,
      // The bridge starts in a directory of the runner's, never in the clone (design 10), so the clone is named.
      clone: env.AGFLOW_CLONE || undefined,
      pollMs: positiveMs(env.AGFLOW_BRIDGE_POLL_MS, DEFAULT_POLL_MS),
      pollMaxMs: positiveMs(env.AGFLOW_BRIDGE_POLL_MAX_MS, DEFAULT_POLL_MAX_MS),
    },
    pendingPrepareId: null,
  };
}

/** The live bridge of a person's chat: the CLI's own sign-in, bound to an agent by hello. */
function liveServer(): McpServer {
  const credentials = loadCredentials(configDir());
  const client = credentials ? new HubClient({ baseUrl: credentials.hubUrl, token: credentials.token }) : null;
  return createMcpServer({ client, state: { agentId: null, role: null }, cwd: process.cwd() });
}

/**
 * Runs the bridge until the CLI that started it closes stdin. Only the explicit --runner flag selects the runner mode
 * (design 10); it is never inferred from the environment.
 */
export async function mcpCommand(args: ParsedArgs, _io: Io): Promise<number> {
  choiceFlag(args, 'vendor', ['claude', 'codex'] as const, 'claude');
  let server: McpServer;
  if (args.flags.runner === true) {
    const ctx = runnerToolContext(process.env);
    server = createMcpServer(ctx, runnerToolsFor(ctx.runner.role));
  } else {
    server = liveServer();
  }
  const closed = new Promise<void>((resolve) => {
    server.server.onclose = () => resolve();
    process.stdin.on('end', () => resolve());
  });
  await server.connect(new StdioServerTransport());
  await closed;
  return 0;
}
