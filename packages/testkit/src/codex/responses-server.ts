// A local stand-in for the OpenAI Responses API (design 15, 15.1). The real Codex reaches it as a custom model
// provider (codexTestConfig), so adapter, local and M2g tests run real app-server turns with zero model use. Replies
// come from the request's content (thread id, brief markers, the last user text, the tool outputs so far), never
// from the order requests arrive in.
import { DEFAULT_REPLY_TEXT, encodeSse, newId, reply, responseEvents, type ScriptedReply } from './replies';
import { parseResponsesRequest, type ResponsesRequest } from './request';

export type ResponsesHandler = (
  request: ResponsesRequest,
) => ScriptedReply | null | undefined | Promise<ScriptedReply | null | undefined>;

export interface ResponsesServer {
  /** The provider's base_url, http://127.0.0.1:<port>/v1; Codex posts to <url>/responses. */
  url: string;
  /** Every POSTed request, parsed, in arrival order. */
  requests: ResponsesRequest[];
  /** Answers every later request; null restores the default answer. */
  setHandler(handler: ResponsesHandler | null): void;
  close(): Promise<void>;
}

export interface ResponsesRule {
  /** Found in the instructions (the brief) or the last user text. */
  marker?: string;
  threadId?: string;
  /** The number of tool outputs since the last user text. */
  toolOutputs?: number;
  reply: ScriptedReply | ((request: ResponsesRequest) => ScriptedReply | null | undefined);
}

/** A handler that answers with the first rule whose every given condition matches. */
export function rules(list: ResponsesRule[]): ResponsesHandler {
  return (request) => {
    const rule = list.find(
      (candidate) =>
        (candidate.marker === undefined ||
          request.instructions.includes(candidate.marker) ||
          (request.lastUserText ?? '').includes(candidate.marker)) &&
        (candidate.threadId === undefined || request.threadId === candidate.threadId) &&
        (candidate.toolOutputs === undefined || request.toolOutputsSinceUser === candidate.toolOutputs),
    );
    if (!rule) return undefined;
    return typeof rule.reply === 'function' ? rule.reply(request) : rule.reply;
  };
}

const EMPTY_MODEL_LIST = { object: 'list', data: [], models: [] };

export async function startResponsesServer(options: { handler?: ResponsesHandler } = {}): Promise<ResponsesServer> {
  const requests: ResponsesRequest[] = [];
  let handler: ResponsesHandler | null = options.handler ?? null;

  function respond(built: ScriptedReply): Response {
    return new Response(encodeSse(responseEvents(built, newId('resp'))), {
      headers: { 'content-type': 'text/event-stream', ...built.headers },
    });
  }

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    // Held streams and long shell commands stay silent for longer than Bun's default idle limit.
    idleTimeout: 0,
    async fetch(httpRequest) {
      const path = new URL(httpRequest.url).pathname;
      if (httpRequest.method !== 'POST') return Response.json(EMPTY_MODEL_LIST);
      if (!path.endsWith('/responses')) {
        return Response.json({ error: { message: `no such endpoint: ${path}` } }, { status: 404 });
      }
      let body: unknown;
      try {
        body = await httpRequest.json();
      } catch {
        return Response.json({ error: { message: 'the body is not JSON' } }, { status: 400 });
      }
      const request = parseResponsesRequest(body, {
        index: requests.length,
        method: httpRequest.method,
        path,
        headers: Object.fromEntries(httpRequest.headers),
      });
      requests.push(request);
      const built = handler ? await handler(request) : undefined;
      if (!built) request.unmatched = true;
      return respond(built ?? reply.text(DEFAULT_REPLY_TEXT));
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}/v1`,
    requests,
    setHandler(next) {
      handler = next;
    },
    async close() {
      await server.stop(true);
    },
  };
}
