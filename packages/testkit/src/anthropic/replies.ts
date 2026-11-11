// Replies of the scripted Anthropic Messages API (design 15.1): content blocks, messages, API errors and held replies,
// and rules that pick a reply from what a request carries. The server encodes them (sse.ts).
import { randomBytes } from 'node:crypto';
import type { AnthropicRequest } from './request';

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type ContentBlock = TextBlock | ToolUseBlock;

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'refusal';

export interface MessageReply {
  kind: 'message';
  content: ContentBlock[];
  stopReason: StopReason;
  usage: { inputTokens: number; outputTokens: number };
  /** Extra response headers: rate-limit headers, say. */
  headers: Record<string, string>;
}

export interface ErrorReply {
  kind: 'error';
  status: number;
  body: { type: 'error'; error: { type: string; message: string } };
  headers: Record<string, string>;
}

/** A reply the server sends only once the test calls release(gate). */
export interface HoldReply {
  kind: 'hold';
  gate: string;
  then: MessageReply | ErrorReply;
}

export type AnthropicReply = MessageReply | ErrorReply | HoldReply;

const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** A random id in the API's style: a prefix and 24 alphanumerics. */
export function scriptedId(prefix: string): string {
  return `${prefix}_${Array.from(randomBytes(24), (byte) => ID_ALPHABET[byte % ID_ALPHABET.length]).join('')}`;
}

export function text(value: string): TextBlock {
  return { type: 'text', text: value };
}

/** A tool call. Scripts that answer its result later choose the id, so afterToolResult can find it. */
export function toolUse(
  name: string,
  input: Record<string, unknown> = {},
  options: { id?: string } = {},
): ToolUseBlock {
  return { type: 'tool_use', id: options.id ?? scriptedId('toolu'), name, input };
}

export interface BashToolOptions {
  command: string;
  /** The Bash tool's own timeout, in milliseconds. */
  timeoutMs?: number;
  description?: string;
  id?: string;
}

export function bashTool(options: BashToolOptions): ToolUseBlock {
  const input: Record<string, unknown> = {
    command: options.command,
    description: options.description ?? 'Run a scripted command',
  };
  if (options.timeoutMs !== undefined) input.timeout = options.timeoutMs;
  return toolUse('Bash', input, { id: options.id });
}

/** A call of an agflow bridge tool, mcp__agflow__<tool>. */
export function agflowTool(options: { tool: string; args?: Record<string, unknown>; id?: string }): ToolUseBlock {
  return toolUse(`mcp__agflow__${options.tool}`, options.args ?? {}, { id: options.id });
}

export interface ReplyOptions {
  /** tool_use when the content holds a tool call, end_turn otherwise. */
  stopReason?: StopReason;
  /** usage.input_tokens, which the CLI reports as the context used; 100 by default. */
  inputTokens?: number;
  outputTokens?: number;
  headers?: Record<string, string>;
}

export function reply(content: string | ContentBlock | ContentBlock[], options: ReplyOptions = {}): MessageReply {
  const blocks = typeof content === 'string' ? [text(content)] : Array.isArray(content) ? content : [content];
  return {
    kind: 'message',
    content: blocks,
    stopReason: options.stopReason ?? (blocks.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn'),
    usage: { inputTokens: options.inputTokens ?? 100, outputTokens: options.outputTokens ?? 10 },
    headers: { ...options.headers },
  };
}

/** The model declined: stop_reason refusal, with whatever text came before it. */
export function refusal(value?: string, options: Omit<ReplyOptions, 'stopReason'> = {}): MessageReply {
  return reply(value === undefined ? [] : [text(value)], { ...options, stopReason: 'refusal' });
}

const ERRORS: Record<number, { type: string; message: string }> = {
  400: { type: 'invalid_request_error', message: 'prompt is too long: 210000 tokens > 200000 maximum' },
  401: { type: 'authentication_error', message: 'invalid x-api-key' },
  403: { type: 'permission_error', message: 'your API key does not have permission to use the specified resource' },
  404: { type: 'not_found_error', message: 'not found' },
  413: { type: 'request_too_large', message: 'request exceeds the maximum allowed number of bytes' },
  429: { type: 'rate_limit_error', message: 'this request would exceed the rate limit of the agflow scripted server' },
  500: { type: 'api_error', message: 'internal server error' },
  529: { type: 'overloaded_error', message: 'Overloaded' },
};

export interface FailOptions {
  message?: string;
  /** 429 only: the retry-after header, 1 s by default. */
  retryAfterSeconds?: number;
  headers?: Record<string, string>;
}

/** An API error with the status's error type and body. */
export function fail(status: number, options: FailOptions = {}): ErrorReply {
  const known = ERRORS[status];
  if (!known) throw new Error(`no API error type for status ${status}`);
  const headers: Record<string, string> = {};
  if (status === 429) headers['retry-after'] = String(options.retryAfterSeconds ?? 1);
  return {
    kind: 'error',
    status,
    body: { type: 'error', error: { type: known.type, message: options.message ?? known.message } },
    headers: { ...headers, ...options.headers },
  };
}

/** Holds a reply until the test calls release(gate), so a test decides when a model call ends, not a sleep. */
export function hold(gate: string, then: MessageReply | ErrorReply): HoldReply {
  return { kind: 'hold', gate, then };
}

export type RequestMatcher = (request: AnthropicRequest) => boolean;

export interface ScriptRule {
  /** Every matcher must hold. */
  when: RequestMatcher | RequestMatcher[];
  reply: AnthropicReply | ((request: AnthropicRequest) => AnthropicReply);
}

/**
 * A handler that answers a main-loop request with the first rule whose matchers all hold, and declines anything else,
 * so auxiliary requests and unscripted ones get the server's default.
 */
export function rules(...list: ScriptRule[]): (request: AnthropicRequest) => AnthropicReply | undefined {
  return (request) => {
    if (!request.mainLoop) return undefined;
    for (const rule of list) {
      const matchers = Array.isArray(rule.when) ? rule.when : [rule.when];
      if (matchers.every((matcher) => matcher(request))) {
        return typeof rule.reply === 'function' ? rule.reply(request) : rule.reply;
      }
    }
    return undefined;
  };
}

export function inSession(sessionId: string): RequestMatcher {
  return (request) => request.sessionId === sessionId;
}

/** The request answers this tool call: its result is among the newest ones. */
export function afterToolResult(toolUseId: string): RequestMatcher {
  return (request) => request.toolResults.some((result) => result.toolUseId === toolUseId);
}

/** A newest user or system entry contains the text: the prompt, or a message folded in mid-turn. */
export function userSays(value: string): RequestMatcher {
  return (request) => request.userTexts.some((entry) => entry.includes(value));
}

/** The marker appears anywhere the brief can reach the model: the system prompt or any message. */
export function briefHas(marker: string): RequestMatcher {
  return (request) =>
    request.system.includes(marker) ||
    request.messages.some((message) =>
      message.blocks.some(
        (block) =>
          (block.type === 'text' && block.text.includes(marker)) ||
          (block.type === 'tool_result' && block.text.includes(marker)),
      ),
    );
}
