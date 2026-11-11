// Encodes a scripted reply the way the Messages API sends it: an event stream for streaming requests, one JSON message
// otherwise. Text and tool input arrive in several deltas, as from the real API, so clients reassemble them.
import type { ContentBlock, MessageReply } from './replies';

export interface EncodeOptions {
  /** The message id, msg_… */
  id: string;
  /** The model the request named. */
  model: string;
}

/** Characters per delta. */
const CHUNK = 24;

/** Splits by code points, so no delta ends in half of a surrogate pair. */
function chunks(value: string): string[] {
  const points = Array.from(value);
  const parts: string[] = [];
  for (let start = 0; start < points.length; start += CHUNK) parts.push(points.slice(start, start + CHUNK).join(''));
  return parts.length > 0 ? parts : [''];
}

function usageOf(reply: MessageReply) {
  return {
    input_tokens: reply.usage.inputTokens,
    output_tokens: reply.usage.outputTokens,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
}

function event(name: string, data: Record<string, unknown>): string {
  return `event: ${name}\ndata: ${JSON.stringify({ type: name, ...data })}\n\n`;
}

function blockEvents(block: ContentBlock, index: number): string[] {
  if (block.type === 'text') {
    return [
      event('content_block_start', { index, content_block: { type: 'text', text: '' } }),
      ...chunks(block.text).map((text) =>
        event('content_block_delta', { index, delta: { type: 'text_delta', text } }),
      ),
      event('content_block_stop', { index }),
    ];
  }
  return [
    event('content_block_start', {
      index,
      content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
    }),
    ...chunks(JSON.stringify(block.input)).map((partial_json) =>
      event('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json } }),
    ),
    event('content_block_stop', { index }),
  ];
}

/** The reply as the API's server-sent events, from message_start to message_stop. */
export function encodeSse(reply: MessageReply, options: EncodeOptions): string {
  const usage = usageOf(reply);
  return [
    event('message_start', {
      message: {
        id: options.id,
        type: 'message',
        role: 'assistant',
        model: options.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { ...usage, output_tokens: 1 },
      },
    }),
    ...reply.content.flatMap(blockEvents),
    event('message_delta', { delta: { stop_reason: reply.stopReason, stop_sequence: null }, usage }),
    event('message_stop', {}),
  ].join('');
}

/** The reply as one JSON message, for requests that do not stream. */
export function encodeMessage(reply: MessageReply, options: EncodeOptions): Record<string, unknown> {
  return {
    id: options.id,
    type: 'message',
    role: 'assistant',
    model: options.model,
    content: reply.content,
    stop_reason: reply.stopReason,
    stop_sequence: null,
    usage: usageOf(reply),
  };
}
