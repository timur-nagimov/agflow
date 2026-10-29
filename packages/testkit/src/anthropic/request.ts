// Parsed requests of the scripted Anthropic Messages API (design 15.1). Scripts answer from what a request carries
// (its session, its newest tool results, the user's words, markers from the brief), never from the order requests
// arrive in, so everything here is read from one request alone.
//
// What 2.1.285 sends, as seen in the probes: the session id in X-Claude-Code-Session-Id and in metadata.user_id; the
// system prompt as text blocks; the brief as user context, not in system; after each tool_result a separate user
// message of context; and a message pushed mid-turn as a role 'system' entry in the message list.

export type AnthropicRole = 'user' | 'assistant' | 'system';

export interface AnthropicToolResult {
  toolUseId: string;
  /** The result's text blocks joined by newlines; other blocks (images) are left out. */
  text: string;
  isError: boolean;
}

export type AnthropicBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | ({ type: 'tool_result' } & AnthropicToolResult)
  /** Thinking, images and anything newer, by their type only. */
  | { type: 'other'; kind: string };

export interface AnthropicMessage {
  role: AnthropicRole;
  blocks: AnthropicBlock[];
}

export interface AnthropicRequest {
  /** The request path without its query (2.1.285 adds ?beta=true). */
  path: string;
  endpoint: 'messages' | 'count_tokens' | 'other';
  /** From X-Claude-Code-Session-Id, else from metadata.user_id. */
  sessionId: string | null;
  model: string | null;
  stream: boolean;
  /** The system prompt's text. */
  system: string;
  messages: AnthropicMessage[];
  /** Names of the offered tools. */
  tools: string[];
  /** The tool results after the last assistant message: what the model is now answering. */
  toolResults: AnthropicToolResult[];
  /** The newest of toolResults, or null when the newest input holds none (a new prompt, say). */
  lastToolResult: AnthropicToolResult | null;
  /** Texts of the user and system entries after the last assistant message: a prompt, messages folded in mid-turn. */
  userTexts: string[];
  /** A request of the agent's own loop, which a script answers; auxiliary ones get the server's default. */
  mainLoop: boolean;
  /** A request for a compaction summary. */
  compaction: boolean;
  /** Lower-case header names. */
  headers: Record<string, string>;
  /** The JSON body as received. */
  body: unknown;
}

type HeadersLike = Headers | Record<string, string>;

/** Every compaction prompt of 2.1.285 (full, partial and from-the-start summaries) contains this. */
const COMPACTION_MARKER = 'Your task is to create a detailed summary of';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function lowerCaseHeaders(headers: HeadersLike): Record<string, string> {
  const entries = headers instanceof Headers ? [...headers.entries()] : Object.entries(headers);
  return Object.fromEntries(entries.map(([name, value]) => [name.toLowerCase(), value]));
}

/** metadata.user_id is JSON with a session_id in 2.1.285; older CLIs used `user_<hash>_account_<id>_session_<uuid>`. */
function sessionFromMetadata(metadata: unknown): string | null {
  const userId = record(metadata).user_id;
  if (typeof userId !== 'string') return null;
  try {
    const sessionId = record(JSON.parse(userId)).session_id;
    if (typeof sessionId === 'string' && sessionId) return sessionId;
  } catch {
    // Not JSON: the older form below.
  }
  return userId.match(new RegExp(`session_(${UUID.source})`, 'i'))?.[1] ?? null;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(record)
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n');
}

function parseBlock(value: unknown): AnthropicBlock {
  const block = record(value);
  switch (block.type) {
    case 'text':
      return { type: 'text', text: typeof block.text === 'string' ? block.text : '' };
    case 'tool_use':
      return { type: 'tool_use', id: String(block.id ?? ''), name: String(block.name ?? ''), input: block.input ?? {} };
    case 'tool_result':
      return {
        type: 'tool_result',
        toolUseId: String(block.tool_use_id ?? ''),
        text: textOf(block.content),
        isError: block.is_error === true,
      };
    default:
      return { type: 'other', kind: typeof block.type === 'string' ? block.type : 'unknown' };
  }
}

function parseMessage(value: unknown): AnthropicMessage {
  const message = record(value);
  const role: AnthropicRole = message.role === 'assistant' || message.role === 'system' ? message.role : 'user';
  const content = message.content;
  if (typeof content === 'string') return { role, blocks: [{ type: 'text', text: content }] };
  return { role, blocks: Array.isArray(content) ? content.map(parseBlock) : [] };
}

function endpointOf(path: string): AnthropicRequest['endpoint'] {
  if (path === '/v1/messages') return 'messages';
  if (path === '/v1/messages/count_tokens') return 'count_tokens';
  return 'other';
}

/** Whether a request asks for a compaction summary. */
export function isCompaction(request: Pick<AnthropicRequest, 'userTexts'>): boolean {
  return request.userTexts.some((value) => value.includes(COMPACTION_MARKER));
}

/**
 * Whether a request belongs to the agent's own loop: a Messages request that offers tools and is no compaction.
 * Titles, summaries and other auxiliary requests offer none.
 */
export function isMainLoop(request: Pick<AnthropicRequest, 'endpoint' | 'tools' | 'userTexts'>): boolean {
  return request.endpoint === 'messages' && request.tools.length > 0 && !isCompaction(request);
}

/** Parses a request body (JSON, any shape) and its headers; path is the request path without its query. */
export function parseAnthropicRequest(
  body: unknown,
  headers: HeadersLike = {},
  path: string = '/v1/messages',
): AnthropicRequest {
  const fields = record(body);
  const lowered = lowerCaseHeaders(headers);
  const messages = Array.isArray(fields.messages) ? fields.messages.map(parseMessage) : [];
  const lastAssistant = messages.findLastIndex((message) => message.role === 'assistant');
  const newest = messages.slice(lastAssistant + 1);
  const toolResults = newest.flatMap((message) =>
    message.blocks.flatMap((block) =>
      block.type === 'tool_result' ? [{ toolUseId: block.toolUseId, text: block.text, isError: block.isError }] : [],
    ),
  );
  const userTexts = newest.flatMap((message) =>
    message.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])),
  );
  const tools = Array.isArray(fields.tools)
    ? fields.tools.map(record).flatMap((tool) => (typeof tool.name === 'string' ? [tool.name] : []))
    : [];
  const endpoint = endpointOf(path);
  const sessionHeader = lowered['x-claude-code-session-id'];
  return {
    path,
    endpoint,
    sessionId: sessionHeader || sessionFromMetadata(fields.metadata),
    model: typeof fields.model === 'string' ? fields.model : null,
    stream: fields.stream === true,
    system: textOf(fields.system),
    messages,
    tools,
    toolResults,
    lastToolResult: toolResults.at(-1) ?? null,
    userTexts,
    mainLoop: isMainLoop({ endpoint, tools, userTexts }),
    compaction: isCompaction({ userTexts }),
    headers: lowered,
    body,
  };
}
