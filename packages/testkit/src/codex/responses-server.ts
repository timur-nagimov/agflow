// A local stand-in for the OpenAI Responses API (design 15, 15.1). The real Codex reaches it as a custom model
// provider (codexTestConfig), so adapter, local and M2g tests run real app-server turns with zero model use. Replies
// come from the request's content (thread id, brief markers, the last user text, the tool outputs so far), never
// from the order requests arrive in.
import {
  DEFAULT_COMPACTION_SUMMARY,
  DEFAULT_REPLY_TEXT,
  encodeSse,
  type HangReply,
  newId,
  reply,
  responseEvents,
  type ScriptedReply,
} from './replies';
import { parseResponsesRequest, type ResponsesRequest } from './request';

export type ResponsesHandler = (
  request: ResponsesRequest,
) => ScriptedReply | null | undefined | Promise<ScriptedReply | null | undefined>;

export interface ResponsesServer {
  /** The provider's base_url, http://127.0.0.1:<port>/v1; Codex posts to <url>/responses. */
  url: string;
  /** Every POSTed request, parsed, in arrival order. */
  requests: ResponsesRequest[];
  /** Answers every later request; null restores the default answers. */
  setHandler(handler: ResponsesHandler | null): void;
  /** Lets the held streams of a thread, or without a thread id every held stream, finish; gives their number. */
  release(threadId?: string): number;
  /** Lets every held stream finish, then ends the server; a stream still open after a short wait is cut. */
  close(): Promise<void>;
}

export interface ResponsesRule {
  /** Found in the instructions (the brief) or the last user text. */
  marker?: string;
  threadId?: string;
  /** The number of tool outputs since the last user text. */
  toolOutputs?: number;
  /** True for a rule that answers Codex's compaction requests; other rules never match them. */
  compaction?: boolean;
  reply: ScriptedReply | ((request: ResponsesRequest) => ScriptedReply | null | undefined);
}

/** A handler that answers with the first rule whose every given condition matches. */
export function rules(list: ResponsesRule[]): ResponsesHandler {
  return (request) => {
    const rule = list.find(
      (candidate) =>
        (candidate.compaction ?? false) === request.isCompaction &&
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

/** How long close() waits for the released streams before it cuts them. */
const CLOSE_GRACE_MS = 500;

interface Hold {
  threadId: string | null;
  release(): void;
}

export async function startResponsesServer(options: { handler?: ResponsesHandler } = {}): Promise<ResponsesServer> {
  const requests: ResponsesRequest[] = [];
  const holds = new Set<Hold>();
  let handler: ResponsesHandler | null = options.handler ?? null;

  const sse = (body: string | ReadableStream<Uint8Array>, headers: Record<string, string> = {}) =>
    new Response(body, { headers: { 'content-type': 'text/event-stream', ...headers } });

  /** Sends response.created at once, waits for a release, then sends the rest of the reply. */
  function held(request: ResponsesRequest, built: HangReply, signal: AbortSignal): Response {
    const events = responseEvents(built.then ?? reply.text(DEFAULT_REPLY_TEXT), newId('resp'));
    const encoder = new TextEncoder();
    let hold: Hold | undefined;
    const ended = () => {
      if (hold && holds.delete(hold)) request.aborted = true;
    };
    signal.addEventListener('abort', ended);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(encodeSse(events.slice(0, 1))));
        hold = {
          threadId: request.threadId,
          release() {
            holds.delete(this);
            signal.removeEventListener('abort', ended);
            try {
              controller.enqueue(encoder.encode(encodeSse(events.slice(1))));
              controller.close();
            } catch {
              // The client went away while the hold was being released.
            }
          },
        };
        holds.add(hold);
      },
      cancel: ended,
    });
    return sse(body, built.headers);
  }

  function respond(request: ResponsesRequest, built: ScriptedReply, signal: AbortSignal): Response {
    switch (built.kind) {
      case 'stream':
        return sse(encodeSse(responseEvents(built, newId('resp'))), built.headers);
      case 'http':
        return Response.json(built.body, { status: built.status, headers: built.headers });
      case 'failed': {
        const id = newId('resp');
        const events = [
          { type: 'response.created', response: { id, status: 'in_progress', output: [] } },
          {
            type: 'response.failed',
            response: { id, status: 'failed', output: [], error: { code: built.code, message: built.message } },
          },
        ];
        return sse(encodeSse(events), built.headers);
      }
      case 'hang':
        return held(request, built, signal);
    }
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
      // A compaction is auxiliary: its default summary is a harmless answer, not a missed script step.
      if (!built && !request.isCompaction) request.unmatched = true;
      const fallback = reply.text(request.isCompaction ? DEFAULT_COMPACTION_SUMMARY : DEFAULT_REPLY_TEXT);
      return respond(request, built ?? fallback, httpRequest.signal);
    },
  });

  function release(threadId?: string): number {
    const matching = [...holds].filter((hold) => threadId === undefined || hold.threadId === threadId);
    for (const hold of matching) hold.release();
    return matching.length;
  }

  return {
    url: `http://127.0.0.1:${server.port}/v1`,
    requests,
    setHandler(next) {
      handler = next;
    },
    release,
    async close() {
      release();
      // A graceful stop lets the released streams reach their clients; a forced one would cut them.
      await Promise.race([server.stop(), Bun.sleep(CLOSE_GRACE_MS)]);
      await server.stop(true);
    },
  };
}
