// The JSON-RPC transport to `codex app-server` (design 9.1, 9.3): one JSON message per line over its stdin and
// stdout, without a "jsonrpc" member, as app-server speaks it. Requests are correlated by id with a timeout,
// notifications reach listeners in arrival order, and every server request gets exactly one answer. It never reads
// stderr; whoever spawns app-server drains that.
import { type Logger, noopLogger } from '../../log';
import type {
  CodexClientMethod,
  CodexNotificationMethod,
  CodexServerRequestMethod,
  ParamsOf,
  ResultOf,
} from './methods';
import type { ClientNotification, RequestId, ServerNotification } from './protocol';

/**
 * An error answer from app-server; data (with its codexErrorInfo) is kept exactly as sent. An answer dropped over
 * the line cap rejects as one too, with code -32603 and no data.
 */
export class RpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
    readonly data: unknown,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

/** The transport closed before the answer came: stdout ended, or the client was closed. */
export class RpcClosed extends Error {
  constructor(readonly method: string) {
    super(`codex app-server closed before answering ${method}`);
    this.name = 'RpcClosed';
  }
}

/** No answer within the request's time bound; a late answer is ignored. */
export class RpcTimeout extends Error {
  constructor(
    readonly method: string,
    readonly timeoutMs: number,
  ) {
    super(`codex app-server did not answer ${method} within ${timeoutMs} ms`);
    this.name = 'RpcTimeout';
  }
}

/** app-server's stdin as Bun's FileSink offers it. */
export interface RpcInput {
  write(data: string): unknown;
  flush?(): unknown;
  end(): unknown;
}

export interface CodexRpcOptions {
  stdin: RpcInput;
  stdout: AsyncIterable<Uint8Array>;
  logger?: Logger;
  requestTimeoutMs?: number;
  /**
   * Longer lines are dropped with a warning, so a runaway line never grows the buffer without bound. A dropped
   * server request is still answered, and a dropped response still settles its request.
   */
  maxLineBytes?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_LINE_BYTES = 32 * 1024 * 1024;
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;
const NEWLINE = 0x0a;

/** How much of a dropped line is kept to find out what it was. */
const OVERSIZED_HEAD_BYTES = 4096;

// app-server writes the id first ({"id":1,"result":...}), so the head of a dropped line names the request it answers
// or the server request it is.
const OVERSIZED_HEAD = /^\{"id":(-?\d+|"(?:[^"\\]|\\.)*"),"(method|result|error)"/;

type ServerRequestHandler<M extends CodexServerRequestMethod> = (
  params: ParamsOf<M>,
  id: RequestId,
) => ResultOf<M> | Promise<ResultOf<M>>;

interface Pending {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

type Message = Record<string, unknown>;

/** A line over the size cap, of which only the head was kept. */
interface DroppedLine {
  head: string;
}

export class CodexRpc {
  /** Settles once app-server's stdout has ended or failed. */
  readonly ended: Promise<void>;

  private readonly stdin: RpcInput;
  private readonly logger: Logger;
  private readonly requestTimeoutMs: number;
  private readonly maxLineBytes: number;
  private readonly pending = new Map<RequestId, Pending>();
  private readonly handlers = new Map<string, (params: unknown, id: RequestId) => unknown>();
  private readonly listeners: ((notification: ServerNotification) => void)[] = [];
  private readonly answered = new Set<RequestId>();
  private nextId = 1;
  private isClosed = false;
  // The current line's bytes so far, and, once it went over the cap, its head.
  private partial: Uint8Array[] = [];
  private partialBytes = 0;
  private oversized: Uint8Array | null = null;
  private readonly decoder = new TextDecoder();

  constructor(options: CodexRpcOptions) {
    this.stdin = options.stdin;
    this.logger = options.logger ?? noopLogger;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    this.ended = this.read(options.stdout);
  }

  /** True once stdout ended or close() ran: requests reject, and nothing more is written or delivered. */
  get closed(): boolean {
    return this.isClosed;
  }

  /** Sends a client request and resolves with its result; rejects with RpcError, RpcTimeout or RpcClosed. */
  request<M extends CodexClientMethod>(
    method: M,
    params: ParamsOf<M>,
    options: { timeoutMs?: number } = {},
  ): Promise<ResultOf<M>> {
    if (this.isClosed) return Promise.reject(new RpcClosed(method));
    const id = this.nextId++;
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    const answer = new Promise<ResultOf<M>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcTimeout(method, timeoutMs));
      }, timeoutMs);
      this.pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject, timer });
    });
    this.write(params === undefined ? { id, method } : { id, method, params });
    return answer;
  }

  notify(method: ClientNotification['method']): void {
    this.write({ method });
  }

  /**
   * Answers one kind of server request; a later call replaces the handler. A throwing or rejecting handler answers
   * -32603, and a request of a kind without a handler gets -32601.
   */
  handle<M extends CodexServerRequestMethod>(method: M, handler: ServerRequestHandler<M>): void {
    this.handlers.set(method, handler as (params: unknown, id: RequestId) => unknown);
  }

  /** Every notification, in arrival order. Gives a function that removes the listener. */
  onNotification(listener: (notification: ServerNotification) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index !== -1) this.listeners.splice(index, 1);
    };
  }

  /** One kind of notification, in the same order as every other listener sees it. */
  on<M extends CodexNotificationMethod>(method: M, listener: (params: ParamsOf<M>) => void): () => void {
    return this.onNotification((notification) => {
      if (notification.method === method) listener(notification.params as ParamsOf<M>);
    });
  }

  /**
   * Ends app-server's stdin, which makes it exit, and rejects pending requests. stdout is still read to its end,
   * so app-server never blocks on a full pipe, but nothing more is delivered or answered.
   */
  close(): void {
    if (this.isClosed) return;
    this.shut();
    try {
      this.settle(this.stdin.end());
    } catch (error) {
      this.logger.debug('codex rpc: ending stdin failed', { error: String(error) });
    }
  }

  private shut(): void {
    this.isClosed = true;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(new RpcClosed(pending.method));
    }
  }

  private write(message: Message): void {
    if (this.isClosed) return;
    try {
      this.settle(this.stdin.write(`${JSON.stringify(message)}\n`));
      this.settle(this.stdin.flush?.());
    } catch (error) {
      this.logger.warn('codex rpc: write failed', { error: String(error) });
    }
  }

  /** A FileSink call may answer with a promise; its failure is logged, never left unhandled. */
  private settle(result: unknown): void {
    if (result instanceof Promise) {
      result.catch((error: unknown) => this.logger.warn('codex rpc: write failed', { error: String(error) }));
    }
  }

  private async read(stdout: AsyncIterable<Uint8Array>): Promise<void> {
    try {
      for await (const chunk of stdout) {
        for (const line of this.lines(chunk)) {
          const answered = typeof line === 'string' ? this.dispatch(line) : this.dropped(line);
          // After an answer, the caller awaiting it runs before the messages behind it are delivered, so it sees
          // its turn id before that turn's notifications.
          if (answered) await new Promise((resolve) => setImmediate(resolve));
        }
      }
    } catch (error) {
      this.logger.debug('codex rpc: stdout failed', { error: String(error) });
    } finally {
      this.shut();
    }
  }

  /** Splits a chunk into the complete lines it ends, keeping the rest for the next chunk. */
  private lines(chunk: Uint8Array): (string | DroppedLine)[] {
    const lines: (string | DroppedLine)[] = [];
    let start = 0;
    while (start <= chunk.length) {
      const newline = chunk.indexOf(NEWLINE, start);
      const end = newline === -1 ? chunk.length : newline;
      if (!this.oversized) {
        if (this.partialBytes + end - start > this.maxLineBytes) {
          this.oversized = lineHead([...this.partial, chunk.subarray(start, end)]);
          this.partial = [];
          this.partialBytes = 0;
          this.logger.warn('codex rpc: line over the size cap dropped', { maxLineBytes: this.maxLineBytes });
        } else if (end > start) {
          // Copied, because the stream may reuse the chunk's buffer.
          this.partial.push(chunk.slice(start, end));
          this.partialBytes += end - start;
        }
      }
      if (newline === -1) break;
      lines.push(
        this.oversized
          ? { head: this.decoder.decode(this.oversized) }
          : this.decoder.decode(Buffer.concat(this.partial)),
      );
      this.partial = [];
      this.partialBytes = 0;
      this.oversized = null;
      start = newline + 1;
    }
    return lines;
  }

  /** Handles one line; gives true when it answered a pending request. */
  private dispatch(line: string): boolean {
    if (this.isClosed || line.trim() === '') return false;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.logger.warn('codex rpc: line is not JSON', { excerpt: line.slice(0, 200) });
      return false;
    }
    if (typeof message !== 'object' || message === null || Array.isArray(message)) {
      this.logger.warn('codex rpc: message of no known kind', { excerpt: line.slice(0, 200) });
      return false;
    }
    const fields = message as Message;
    const hasId = typeof fields.id === 'number' || typeof fields.id === 'string';
    if (typeof fields.method === 'string') {
      if (hasId) this.serverRequest(fields.id as RequestId, fields.method, fields.params);
      else this.notification(fields as unknown as ServerNotification);
      return false;
    }
    if (hasId && ('result' in fields || 'error' in fields)) return this.response(fields.id as RequestId, fields);
    this.logger.warn('codex rpc: message of no known kind', { excerpt: line.slice(0, 200) });
    return false;
  }

  /**
   * A dropped line that was a server request still gets an answer, which app-server treats as a decline, and a
   * dropped response rejects its request now instead of at its timeout. Gives true when it settled a request.
   */
  private dropped(line: DroppedLine): boolean {
    const match = line.head.match(OVERSIZED_HEAD);
    if (this.isClosed || !match) return false;
    const raw = match[1] as string;
    const id: RequestId = raw.startsWith('"') ? (JSON.parse(raw) as string) : Number(raw);
    if (match[2] === 'method') {
      if (this.answered.has(id)) return false;
      this.answered.add(id);
      this.answer(id, { error: { code: INTERNAL_ERROR, message: 'message over the size cap' } });
      return false;
    }
    const pending = this.pending.get(id);
    if (!pending) return false;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    const message = `the answer to ${pending.method} was over the ${this.maxLineBytes}-byte line cap`;
    pending.reject(new RpcError(pending.method, INTERNAL_ERROR, message, undefined));
    return true;
  }

  private response(id: RequestId, fields: Message): boolean {
    const pending = this.pending.get(id);
    if (!pending) {
      // Most likely the answer to a request that timed out.
      this.logger.debug('codex rpc: answer to no pending request', { id });
      return false;
    }
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if ('error' in fields) {
      const error = (fields.error ?? {}) as { code?: unknown; message?: unknown; data?: unknown };
      pending.reject(
        new RpcError(
          pending.method,
          typeof error.code === 'number' ? error.code : INTERNAL_ERROR,
          typeof error.message === 'string' ? error.message : 'codex app-server error',
          error.data,
        ),
      );
    } else {
      pending.resolve(fields.result);
    }
    return true;
  }

  private notification(notification: ServerNotification): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(notification);
      } catch (error) {
        this.logger.warn('codex rpc: listener failed', { method: notification.method, error: String(error) });
      }
    }
  }

  private serverRequest(id: RequestId, method: string, params: unknown): void {
    if (this.answered.has(id)) {
      this.logger.warn('codex rpc: repeated server request id', { id, method });
      return;
    }
    this.answered.add(id);
    const handler = this.handlers.get(method);
    if (!handler) {
      this.answer(id, { error: { code: METHOD_NOT_FOUND, message: `unhandled server request: ${method}` } });
      return;
    }
    let result: unknown;
    try {
      result = handler(params, id);
    } catch (error) {
      this.answer(id, { error: { code: INTERNAL_ERROR, message: errorMessage(error) } });
      return;
    }
    Promise.resolve(result).then(
      (value) => this.answer(id, { result: value }),
      (error: unknown) => this.answer(id, { error: { code: INTERNAL_ERROR, message: errorMessage(error) } }),
    );
  }

  private answer(id: RequestId, body: { result: unknown } | { error: { code: number; message: string } }): void {
    this.write({ id, ...body });
  }
}

/** The first OVERSIZED_HEAD_BYTES of a line's parts, copied. */
function lineHead(parts: Uint8Array[]): Uint8Array {
  const kept: Uint8Array[] = [];
  let size = 0;
  for (const part of parts) {
    if (size >= OVERSIZED_HEAD_BYTES) break;
    kept.push(part.subarray(0, OVERSIZED_HEAD_BYTES - size));
    size += kept.at(-1)?.length ?? 0;
  }
  return Uint8Array.from(Buffer.concat(kept));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
