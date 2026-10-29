// Reply builders for the scripted Responses API (design 15.1). With the pinned slug, Codex 0.159.2 runs Code Mode:
// the model has one freeform `exec` tool that runs JavaScript, and exec_command, write_stdin, apply_patch and the MCP
// tools (tools.mcp__agflow__<tool>) are nested inside it. So a scripted tool call is a custom_tool_call named exec
// whose input is JavaScript.
import { randomUUID } from 'node:crypto';

/** A Responses API output item; ids are added when the reply is streamed. */
export type OutputItem = { type: string } & Record<string, unknown>;

export interface StreamReply {
  kind: 'stream';
  output: OutputItem[];
  /** usage.input_tokens of response.completed, which Codex reports in thread/tokenUsage/updated. */
  inputTokens?: number;
  /** Extra response headers. */
  headers?: Record<string, string>;
}

export type ScriptedReply = StreamReply;

/** What a request gets when no handler answers it. */
export const DEFAULT_REPLY_TEXT = 'Done.';

/** exec_command yields after at most 30 s; a longer command is polled with write_stdin. */
const EXEC_COMMAND_MAX_YIELD_MS = 30_000;
const EXEC_COMMAND_MIN_YIELD_MS = 250;
/** An empty write_stdin poll waits at most 300 s. */
const POLL_MAX_MS = 300_000;
const POLL_MIN_MS = 1_000;
/** exec itself yields this long after the script's own deadline, so the script reports a timeout first. */
const EXEC_GRACE_MS = 5_000;
const DEFAULT_SHELL_TIMEOUT_MS = 60_000;

const JS_IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}

function stream(...output: OutputItem[]): StreamReply {
  return { kind: 'stream', output };
}

/** A Code Mode exec call; a call without callId gets a fresh one each time it is streamed. */
function execCall(source: string, callId: string | undefined): StreamReply {
  return stream({ type: 'custom_tool_call', name: 'exec', input: source, ...(callId ? { call_id: callId } : {}) });
}

export interface ShellReplyOptions {
  cmd: string;
  /** How long the exec call waits for the command; 60 s by default. */
  timeoutMs?: number;
  workdir?: string;
  /** Asks to run outside the sandbox, which raises an approval request with this justification. */
  escalate?: { justification: string };
  callId?: string;
}

/**
 * One exec call that runs cmd and waits for it: exec_command, then empty write_stdin polls until the command exits or
 * timeoutMs passes. The script's text is exec_command's last result with the output of every call joined, so a
 * command still running at timeoutMs reports its session_id and no exit_code.
 */
function shellSource(options: ShellReplyOptions): string {
  const timeoutMs = options.timeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS;
  const args = {
    cmd: options.cmd,
    ...(options.workdir ? { workdir: options.workdir } : {}),
    ...(options.escalate
      ? { sandbox_permissions: 'require_escalated', justification: options.escalate.justification }
      : {}),
    yield_time_ms: Math.max(EXEC_COMMAND_MIN_YIELD_MS, Math.min(timeoutMs, EXEC_COMMAND_MAX_YIELD_MS)),
  };
  const pollMs = `Math.min(${POLL_MAX_MS}, Math.max(${POLL_MIN_MS}, deadline - Date.now()))`;
  return [
    `// @exec: ${JSON.stringify({ yield_time_ms: timeoutMs + EXEC_GRACE_MS })}`,
    `const deadline = Date.now() + ${timeoutMs};`,
    `let result = await tools.exec_command(${JSON.stringify(args)});`,
    `let output = result.output ?? '';`,
    'while (result.exit_code === undefined && result.session_id !== undefined && Date.now() < deadline) {',
    `  result = await tools.write_stdin({ session_id: result.session_id, chars: '', yield_time_ms: ${pollMs} });`,
    `  output += result.output ?? '';`,
    '}',
    'text({ ...result, output });',
  ].join('\n');
}

export const reply = {
  /** An assistant message, which ends the turn. */
  text(text: string): StreamReply {
    return stream({
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text, annotations: [] }],
    });
  },

  /** Raw JavaScript for Code Mode's exec tool. */
  code(source: string, options: { callId?: string } = {}): StreamReply {
    return execCall(source, options.callId);
  },

  /** A shell command through exec_command, polled until it exits or timeoutMs passes. */
  shell(options: ShellReplyOptions): StreamReply {
    return execCall(shellSource(options), options.callId);
  },

  /** A call of the agflow bridge's tool, whose result becomes the exec call's text. */
  mcp(options: { tool: string; args: Record<string, unknown>; callId?: string }): StreamReply {
    if (!JS_IDENTIFIER.test(options.tool)) throw new Error(`not a tool name: ${JSON.stringify(options.tool)}`);
    const source = [
      `const result = await tools.mcp__agflow__${options.tool}(${JSON.stringify(options.args)});`,
      'text(result);',
    ].join('\n');
    return execCall(source, options.callId);
  },

  /** An apply_patch call with a patch in apply_patch's own format. */
  patch(patch: string, options: { callId?: string } = {}): StreamReply {
    const source = [`const result = await tools.apply_patch(${JSON.stringify(patch)});`, 'text(result);'].join('\n');
    return execCall(source, options.callId);
  },

  /** A direct function call, outside exec: wait, or a collaboration tool with its namespace. */
  functionCall(options: {
    name: string;
    args: Record<string, unknown>;
    namespace?: string;
    callId?: string;
  }): StreamReply {
    return stream({
      type: 'function_call',
      name: options.name,
      ...(options.namespace ? { namespace: options.namespace } : {}),
      arguments: JSON.stringify(options.args),
      ...(options.callId ? { call_id: options.callId } : {}),
    });
  },
};

export interface StreamEvent {
  type: string;
  [key: string]: unknown;
}

const ITEM_ID_PREFIX: Record<string, string> = { message: 'msg', custom_tool_call: 'ctc', function_call: 'fc' };

/** The item as response.output_item.added announces it, before its content. */
function pending(item: OutputItem): OutputItem {
  if (item.type === 'message') return { ...item, status: 'in_progress', content: [] };
  if (item.type === 'custom_tool_call') return { ...item, status: 'in_progress', input: '' };
  if (item.type === 'function_call') return { ...item, status: 'in_progress', arguments: '' };
  return item;
}

/** The events of one streamed response, in the order the Responses API sends them. */
export function responseEvents(built: StreamReply, responseId: string): StreamEvent[] {
  const output = built.output.map((item): OutputItem => ({
    id: newId(ITEM_ID_PREFIX[item.type] ?? 'item'),
    ...(item.type === 'custom_tool_call' || item.type === 'function_call' ? { call_id: newId('call') } : {}),
    status: 'completed',
    ...item,
  }));
  const inputTokens = built.inputTokens ?? 100;
  const usage = {
    input_tokens: inputTokens,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 5,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: inputTokens + 5,
  };
  const events: StreamEvent[] = [
    { type: 'response.created', response: { id: responseId, status: 'in_progress', output: [] } },
  ];
  output.forEach((item, index) => {
    events.push({ type: 'response.output_item.added', output_index: index, item: pending(item) });
    if (item.type === 'message') {
      const text = (item.content as { text?: string }[]).map((part) => part.text ?? '').join('');
      events.push({
        type: 'response.output_text.delta',
        item_id: item.id,
        output_index: index,
        content_index: 0,
        delta: text,
      });
    }
    events.push({ type: 'response.output_item.done', output_index: index, item });
  });
  events.push({ type: 'response.completed', response: { id: responseId, status: 'completed', output, usage } });
  return events;
}

export function encodeSse(events: StreamEvent[]): string {
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}
