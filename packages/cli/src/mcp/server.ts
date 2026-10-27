import { AGFLOW_VERSION } from '@agflow/core';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { type ParsedArgs, choiceFlag } from '../args';
import { loadCredentials } from '../credentials';
import { HubClient, HubClientError } from '../hub-client';
import type { Io } from '../io';
import { configDir } from '../paths';
import { type ToolContext, type ToolDef, allTools } from './tools';

export function errorText(error: unknown): string {
  if (error instanceof HubClientError) return `agflow hub: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

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

/** Runs the bridge until the CLI that started it closes stdin. */
export async function mcpCommand(args: ParsedArgs, _io: Io): Promise<number> {
  choiceFlag(args, 'vendor', ['claude', 'codex'] as const, 'claude');
  const credentials = loadCredentials(configDir());
  const client = credentials ? new HubClient({ baseUrl: credentials.hubUrl, token: credentials.token }) : null;
  const server = createMcpServer({ client, state: { agentId: null, role: null }, cwd: process.cwd() });
  const closed = new Promise<void>((resolve) => {
    server.server.onclose = () => resolve();
    process.stdin.on('end', () => resolve());
  });
  await server.connect(new StdioServerTransport());
  await closed;
  return 0;
}
