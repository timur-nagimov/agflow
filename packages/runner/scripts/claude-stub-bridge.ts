// A stand-in for agflow while record:claude captures streams (design 15): run with `mcp ...` it is the bridge, an MCP
// server on stdio with the runner-mode worker tools of design 10 and fixed answers; run with `hook brief --runner` it
// is the SessionStart brief hook. It needs no hub, so recordings capture the CLI and nothing else.
import { BRIDGE_ANSWERS } from '@agflow/core';

/** A worker's tools in runner mode (design 10): M1's shared tools in their order, then the seven worker tools. */
export const STUB_BRIDGE_TOOLS = [
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
] as const;

/** The tool that answers as if the hub were down, so recordings hold a hub-unreachable error result. */
export const STUB_UNREACHABLE_TOOL = 'report_progress';

const ANSWERS: Partial<Record<(typeof STUB_BRIDGE_TOOLS)[number], string>> = {
  hello: 'Already connected.',
  submit: 'Submission pending: the runner pushes your branch and submits it when your turn ends.',
  declare_blocked: 'The task is marked blocked.',
  declare_impossible: 'The task is marked impossible.',
  write_handoff: 'Your handoff note is saved.',
  release_task: 'The task is released.',
};

/** The brief the stub hook gives; the line about the working directory is the runner brief's (design 10). */
export function stubBrief(clone: string | undefined): string {
  return `agflow stub brief for record:claude.\nYour working directory: ${clone ?? '(unknown)'}`;
}

type Json = Record<string, unknown>;

/** The answer to one JSON-RPC request, or null for a notification. */
export function answerRpc(message: Json): Json | null {
  if (message.id === undefined || message.id === null) return null;
  const result = (value: unknown): Json => ({ jsonrpc: '2.0', id: message.id, result: value });
  const params = (message.params ?? {}) as Json;
  switch (message.method) {
    case 'initialize':
      return result({
        protocolVersion: params.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'agflow', version: 'stub' },
      });
    case 'ping':
      return result({});
    case 'tools/list':
      return result({
        tools: STUB_BRIDGE_TOOLS.map((name) => ({
          name,
          description: `agflow ${name} (record:claude stub)`,
          inputSchema: { type: 'object', properties: {}, additionalProperties: true },
        })),
      });
    case 'tools/call': {
      const name = String(params.name);
      if (!(STUB_BRIDGE_TOOLS as readonly string[]).includes(name)) {
        return { jsonrpc: '2.0', id: message.id, error: { code: -32602, message: `Unknown tool: ${name}` } };
      }
      if (name === STUB_UNREACHABLE_TOOL) {
        return result({ content: [{ type: 'text', text: BRIDGE_ANSWERS.hubUnreachable }], isError: true });
      }
      const text = ANSWERS[name as keyof typeof ANSWERS] ?? 'OK.';
      return result({ content: [{ type: 'text', text }] });
    }
    default:
      return {
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: `Method not found: ${message.method}` },
      };
  }
}

async function serveMcp(): Promise<void> {
  let buffer = '';
  const decoder = new TextDecoder();
  for await (const chunk of process.stdin) {
    buffer += decoder.decode(chunk as Uint8Array, { stream: true });
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf('\n');
      if (line === '') continue;
      const answer = answerRpc(JSON.parse(line) as Json);
      if (answer) process.stdout.write(`${JSON.stringify(answer)}\n`);
    }
  }
}

if (import.meta.main) {
  const [command, subcommand] = process.argv.slice(2);
  if (command === 'mcp') {
    await serveMcp();
  } else if (command === 'hook' && subcommand === 'brief') {
    const additionalContext = stubBrief(process.env.AGFLOW_CLONE);
    const hookSpecificOutput = { hookEventName: 'SessionStart', additionalContext };
    process.stdout.write(`${JSON.stringify({ hookSpecificOutput })}\n`);
  } else {
    process.stderr.write('usage: claude-stub-bridge.ts mcp --vendor claude --runner | hook brief --runner\n');
    process.exit(2);
  }
}
