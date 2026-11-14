// The scripted Anthropic Messages API (design 15.1, X-20). The real claude reaches it through ANTHROPIC_BASE_URL, so
// adapter tests, the recorder and M2g's cluster run real CLI turns with zero model use. It has the shape both scripted
// servers share: { url, requests, setHandler }, with parsed requests and a harmless default answer.
import { registerTestCleanup } from '../process-cleanup';
import { type AnthropicRequest, parseAnthropicRequest } from './request';
import { type AnthropicReply, type ErrorReply, fail, type MessageReply, reply, scriptedId } from './replies';
import { encodeMessage, encodeSse } from './sse';

/** Answers a parsed request, or declines it with nothing so the server's default answers. */
export type AnthropicHandler = (
  request: AnthropicRequest,
) => AnthropicReply | undefined | Promise<AnthropicReply | undefined>;

/** The default answer to a main-loop request no script answered; it ends the turn. */
export const UNSCRIPTED_TEXT = 'agflow scripted server: no scripted reply for this request.';
/** The default answer to auxiliary requests: titles, summaries and the like. */
export const AUXILIARY_TEXT = 'ok';

export interface ScriptedAnthropic {
  /** http://127.0.0.1:<port>, for ANTHROPIC_BASE_URL. */
  url: string;
  port: number;
  /** Every request, parsed and with its raw headers and body, in arrival order. */
  requests: AnthropicRequest[];
  /** Main-loop requests the handler declined, and requests the server could not serve. */
  unmatched: AnthropicRequest[];
  /** Replaces the handler for later requests; null declines everything. */
  setHandler(handler: AnthropicHandler | null): void;
  /** Lets every reply held on the gate through, now and later. */
  release(gate: string): void;
  /** Ends held requests and stops the server. */
  close(): Promise<void>;
}

export interface ScriptedAnthropicOptions {
  handler?: AnthropicHandler;
}

interface Gate {
  open: boolean;
  waiters: (() => void)[];
}

function errorResponse(error: ErrorReply): Response {
  return Response.json(error.body, {
    status: error.status,
    headers: { 'request-id': scriptedId('req'), ...error.headers },
  });
}

function messageResponse(message: MessageReply, request: AnthropicRequest): Response {
  const options = { id: scriptedId('msg'), model: request.model ?? 'claude-scripted' };
  const headers = { 'request-id': scriptedId('req'), ...message.headers };
  if (request.stream) {
    return new Response(encodeSse(message, options), {
      headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', ...headers },
    });
  }
  return Response.json(encodeMessage(message, options), { headers });
}

/** A rough count, as no tokenizer is at hand: four characters a token. */
function countTokens(raw: string): number {
  return Math.max(1, Math.ceil(raw.length / 4));
}

export async function startScriptedAnthropic(options: ScriptedAnthropicOptions = {}): Promise<ScriptedAnthropic> {
  const requests: AnthropicRequest[] = [];
  const unmatched: AnthropicRequest[] = [];
  const gates = new Map<string, Gate>();
  let handler: AnthropicHandler | null = options.handler ?? null;
  let closed = false;

  function gate(name: string): Gate {
    let found = gates.get(name);
    if (!found) {
      found = { open: false, waiters: [] };
      gates.set(name, found);
    }
    return found;
  }

  function openGate(name: string): void {
    const found = gate(name);
    found.open = true;
    for (const wake of found.waiters.splice(0)) wake();
  }

  /** Resolves true once the gate opens, false when the server closes first. */
  function passGate(name: string): Promise<boolean> {
    const found = gate(name);
    if (found.open || closed) return Promise.resolve(!closed);
    return new Promise((resolve) => found.waiters.push(() => resolve(!closed)));
  }

  async function answer(request: AnthropicRequest): Promise<Response> {
    let scripted: AnthropicReply | undefined;
    try {
      scripted = handler ? await handler(request) : undefined;
    } catch (error) {
      return errorResponse(fail(500, { message: `the scripted handler threw: ${(error as Error).message}` }));
    }
    if (scripted === undefined) {
      if (request.mainLoop) unmatched.push(request);
      scripted = reply(request.mainLoop ? UNSCRIPTED_TEXT : AUXILIARY_TEXT);
    }
    if (scripted.kind === 'hold') {
      // A request still held at close() gets no answer: stopping the server drops its connection.
      if (!(await passGate(scripted.gate))) return new Response(null, { status: 503 });
      scripted = scripted.then;
    }
    return scripted.kind === 'error' ? errorResponse(scripted) : messageResponse(scripted, request);
  }

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    // Held replies may wait as long as a test needs.
    idleTimeout: 0,
    async fetch(incoming) {
      const path = new URL(incoming.url).pathname;
      const raw = await incoming.text();
      let body: unknown = raw;
      let parsed = raw === '';
      if (raw !== '') {
        try {
          body = JSON.parse(raw);
          parsed = true;
        } catch {
          // Recorded as the raw text below.
        }
      }
      const request = parseAnthropicRequest(body, incoming.headers, path);
      requests.push(request);
      if (request.endpoint === 'other' || incoming.method !== 'POST') {
        unmatched.push(request);
        return errorResponse(fail(404, { message: `the scripted server has no route ${incoming.method} ${path}` }));
      }
      if (!parsed) {
        unmatched.push(request);
        return errorResponse(fail(400, { message: 'the request body is not JSON' }));
      }
      if (request.endpoint === 'count_tokens') return Response.json({ input_tokens: countTokens(raw) });
      return answer(request);
    },
  });

  const handle: ScriptedAnthropic = {
    url: `http://127.0.0.1:${server.port}`,
    port: server.port as number,
    requests,
    unmatched,
    setHandler(next) {
      handler = next;
    },
    release: openGate,
    async close() {
      if (closed) return;
      closed = true;
      for (const found of gates.values()) for (const wake of found.waiters.splice(0)) wake();
      await server.stop(true);
    },
  };
  registerTestCleanup(() => handle.close());
  return handle;
}
