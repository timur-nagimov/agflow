// What a scripted Responses API handler sees of a request (design 15.1). The fields come from the request shapes
// Codex 0.159.2 sent in the 2026-10-28 probes: the base prompt and the developer instructions arrive as developer
// messages (there is no top-level `instructions`), the working directory as an <environment_context> user message,
// and tool results as *_output items.

export interface ResponsesToolOutput {
  /** function_call_output or custom_tool_call_output (Code Mode's exec). */
  type: string;
  /** Null for an output that answers no call: an agent's message delivered as agflow's agent_message. */
  callId: string | null;
  /** The tool name an output carries without a call (agent_message); null otherwise. */
  name: string | null;
  /** The text parts, joined with newlines. */
  output: string;
  parts: string[];
}

export interface ResponsesRequest {
  /** Arrival order on its server, from 0. */
  index: number;
  method: string;
  path: string;
  /** Lower-case header names. */
  headers: Record<string, string>;
  body: Record<string, unknown>;
  model: string | null;
  /** The thread-id header, else session-id, else client_metadata.thread_id. */
  threadId: string | null;
  /** The developer instructions (the agent's brief): developer texts after the base prompt, without tagged blocks. */
  instructions: string;
  /** The <cwd> of the newest environment context. */
  cwd: string | null;
  /** Each input item's type, with the role for messages: 'message:user', 'custom_tool_call_output'. */
  inputKinds: string[];
  toolOutputs: ResponsesToolOutput[];
  /** Tool outputs after the last user text: 0 for a fresh prompt, then one more per answered call. */
  toolOutputsSinceUser: number;
  /** The newest user message that is not context Codex adds itself; null when there is none. */
  lastUserText: string | null;
  /** Answered by the default reply: no handler, or the handler returned nothing. */
  unmatched: boolean;
}

type Item = Record<string, unknown>;

/** User messages Codex writes itself; they are not what a person or the runner said. */
const CONTEXT_PREFIXES = ['<environment_context>', '# AGENTS.md instructions'];

function textParts(content: unknown): string[] {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content
    .map((part) => (part && typeof part === 'object' ? (part as Item).text : undefined))
    .filter((text): text is string => typeof text === 'string');
}

function isMessage(item: Item, role: string): boolean {
  return item.type === 'message' && item.role === role;
}

function isToolOutput(item: Item): boolean {
  return typeof item.type === 'string' && item.type.endsWith('_call_output');
}

function isContext(text: string): boolean {
  return CONTEXT_PREFIXES.some((prefix) => text.startsWith(prefix));
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

export function parseResponsesRequest(
  raw: unknown,
  meta: { index: number; method: string; path: string; headers: Record<string, string> },
): ResponsesRequest {
  const body = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const input = (Array.isArray(body.input) ? body.input : []).filter(
    (item): item is Item => item !== null && typeof item === 'object',
  );
  const metadata = (body.client_metadata ?? {}) as Item;

  const developerTexts = input
    .filter((item) => isMessage(item, 'developer'))
    .slice(1)
    .flatMap((item) => textParts(item.content))
    .filter((text) => !text.startsWith('<'));

  let cwd: string | null = null;
  let lastUser = -1;
  let lastUserText: string | null = null;
  for (const [position, item] of input.entries()) {
    if (!isMessage(item, 'user')) continue;
    const text = textParts(item.content).join('\n');
    if (isContext(text)) {
      cwd = text.match(/<cwd>([^<]*)<\/cwd>/)?.[1] ?? cwd;
    } else {
      lastUser = position;
      lastUserText = text;
    }
  }

  const toolOutputs: ResponsesToolOutput[] = [];
  let toolOutputsSinceUser = 0;
  for (const [position, item] of input.entries()) {
    if (!isToolOutput(item)) continue;
    const parts = textParts(item.output);
    toolOutputs.push({
      type: item.type as string,
      callId: stringOrNull(item.call_id),
      name: stringOrNull(item.call_id) === null ? stringOrNull(item.name) : null,
      output: parts.join('\n'),
      parts,
    });
    if (position > lastUser) toolOutputsSinceUser += 1;
  }

  return {
    ...meta,
    body,
    model: stringOrNull(body.model),
    threadId:
      stringOrNull(meta.headers['thread-id']) ??
      stringOrNull(meta.headers['session-id']) ??
      stringOrNull(metadata.thread_id),
    instructions: developerTexts.join('\n\n'),
    cwd,
    inputKinds: input.map((item) => (item.type === 'message' ? `message:${item.role}` : String(item.type))),
    toolOutputs,
    toolOutputsSinceUser,
    lastUserText,
    unmatched: false,
  };
}

export interface ToolSurface {
  /** The namespaces of the request's additional_tools item, with their tools, in request order. */
  namespaces: { name: string; tools: string[] }[];
  /** The nested tools Code Mode's exec describes (its `### \`name\`` headings); deferred tools may be missing. */
  nested: string[];
}

/** The tools a request offers the model, or null when it has no additional_tools item. */
export function toolSurface(request: ResponsesRequest): ToolSurface | null {
  const input = Array.isArray(request.body.input) ? (request.body.input as Item[]) : [];
  const additional = input.find((item) => item?.type === 'additional_tools');
  if (!additional || !Array.isArray(additional.tools)) return null;
  const namespaces: ToolSurface['namespaces'] = [];
  const nested: string[] = [];
  for (const namespace of additional.tools as Item[]) {
    const tools = Array.isArray(namespace.tools) ? (namespace.tools as Item[]) : [];
    namespaces.push({ name: String(namespace.name), tools: tools.map((tool) => String(tool.name)) });
    const exec = tools.find((tool) => tool.name === 'exec' && tool.type === 'custom');
    if (typeof exec?.description === 'string') {
      nested.push(...[...exec.description.matchAll(/^### `([^`]+)`$/gm)].map((match) => match[1] as string));
    }
  }
  return { namespaces, nested };
}
