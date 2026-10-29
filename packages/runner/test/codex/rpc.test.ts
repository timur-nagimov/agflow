import { describe, expect, test } from 'bun:test';
import type { ServerNotification } from '../../src/adapters/codex/protocol';
import { CodexRpc, RpcClosed, RpcError, RpcTimeout } from '../../src/adapters/codex/rpc';
import { memoryLogger } from '../../src/log';

const encoder = new TextEncoder();

/** An in-memory app-server: the test writes its stdout and reads what the client wrote to its stdin. */
function fakePeer(options: { maxLineBytes?: number; requestTimeoutMs?: number } = {}) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stdout = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const written: string[] = [];
  let ended = false;
  const stdin = {
    write(data: string) {
      written.push(data);
      return data.length;
    },
    flush() {
      return 0;
    },
    end() {
      ended = true;
      return 0;
    },
  };
  const logger = memoryLogger();
  const rpc = new CodexRpc({ stdin, stdout, logger, ...options });
  return {
    rpc,
    logger,
    /** Raw bytes on the client's stdout side. */
    send(text: string | Uint8Array) {
      controller.enqueue(typeof text === 'string' ? encoder.encode(text) : text);
    },
    /** Messages as lines. */
    line(...messages: unknown[]) {
      controller.enqueue(encoder.encode(messages.map((message) => `${JSON.stringify(message)}\n`).join('')));
    },
    finish() {
      controller.close();
    },
    /** What the client wrote, one parsed message per line. */
    written(): Record<string, unknown>[] {
      const text = written.join('');
      expect(text === '' || text.endsWith('\n')).toBe(true);
      return text
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    },
    get stdinEnded() {
      return ended;
    },
  };
}

/** What a promise rejected with, or what it resolved to. */
const failure = (promise: Promise<unknown>) => promise.catch((caught: unknown) => caught);

/** Lets the client's read loop take what was sent. */
const settle = () => Bun.sleep(5);

const turnCompleted = (threadId: string, turnId: string): ServerNotification => ({
  method: 'turn/completed',
  params: {
    threadId,
    turn: {
      id: turnId,
      items: [],
      itemsView: 'notLoaded',
      status: 'completed',
      error: null,
      startedAt: 1,
      completedAt: 2,
      durationMs: 1000,
    },
  },
});

describe('requests', () => {
  test('are written as one JSON line each, without params when there are none', async () => {
    const peer = fakePeer();
    const requests = [
      peer.rpc.request('thread/delete', { threadId: 't-1' }),
      peer.rpc.request('account/rateLimits/read', undefined),
    ];
    peer.rpc.notify('initialized');
    expect(peer.written()).toEqual([
      { id: 1, method: 'thread/delete', params: { threadId: 't-1' } },
      { id: 2, method: 'account/rateLimits/read' },
      { method: 'initialized' },
    ]);
    peer.rpc.close();
    for (const request of requests) expect(await failure(request)).toBeInstanceOf(RpcClosed);
  });

  test('responses are matched by id when they arrive out of order', async () => {
    const peer = fakePeer();
    const first = peer.rpc.request('thread/name/set', { threadId: 't-1', name: 'agflow T-1-a1' });
    const second = peer.rpc.request('turn/steer', {
      threadId: 't-1',
      expectedTurnId: 'turn-1',
      input: [{ type: 'text', text: 'hello', text_elements: [] }],
    });
    peer.line({ id: 2, result: { turnId: 'turn-1' } }, { id: 1, result: {} });
    expect(await second).toEqual({ turnId: 'turn-1' });
    expect(await first).toEqual({});
  });

  test('a timed-out request rejects and its late response is ignored', async () => {
    const peer = fakePeer();
    const slow = peer.rpc.request('thread/delete', { threadId: 't-1' }, { timeoutMs: 20 });
    const error = await failure(slow);
    expect(error).toBeInstanceOf(RpcTimeout);
    expect(error).toMatchObject({ method: 'thread/delete', timeoutMs: 20 });
    const next = peer.rpc.request('thread/delete', { threadId: 't-2' });
    peer.line({ id: 1, result: { late: true } }, { id: 2, result: {} });
    expect(await next).toEqual({});
    expect(peer.logger.entries.filter((entry) => entry.level === 'warn')).toEqual([]);
  });

  test('the default timeout comes from the options', async () => {
    const peer = fakePeer({ requestTimeoutMs: 20 });
    expect(await failure(peer.rpc.request('thread/delete', { threadId: 't-1' }))).toBeInstanceOf(RpcTimeout);
  });

  test('an error response surfaces as RpcError with its code, message and data', async () => {
    const peer = fakePeer();
    const steer = peer.rpc.request('turn/steer', {
      threadId: 't-1',
      expectedTurnId: 'turn-1',
      input: [{ type: 'text', text: 'hello', text_elements: [] }],
    });
    const data = { codexErrorInfo: { activeTurnNotSteerable: { turnKind: 'compact' } } };
    peer.line({ id: 1, error: { code: -32600, message: 'turn is not steerable', data } });
    const error = await failure(steer);
    expect(error).toBeInstanceOf(RpcError);
    expect(error).toMatchObject({ method: 'turn/steer', code: -32600, message: 'turn is not steerable', data });
    // Kept as is: the very object the peer sent, parsed.
    expect((error as RpcError).data).toEqual(data);
  });

  test('an error without data has data undefined', async () => {
    const peer = fakePeer();
    const read = peer.rpc.request('account/rateLimits/read', undefined);
    peer.line({ id: 1, error: { code: -32600, message: 'codex account authentication required to read rate limits' } });
    expect(await failure(read)).toMatchObject({ code: -32600, data: undefined });
  });

  test('the awaiting caller runs before the messages that follow its response are delivered', async () => {
    const peer = fakePeer();
    const order: string[] = [];
    peer.rpc.onNotification((notification) => order.push(notification.method));
    const started = peer.rpc.request('turn/start', { threadId: 't-1', input: [] }).then(() => order.push('answer'));
    peer.line(
      { id: 1, result: { turn: { id: 'turn-1' } } },
      { method: 'turn/started', params: { threadId: 't-1', turn: { id: 'turn-1' } } },
    );
    await started;
    await settle();
    expect(order).toEqual(['answer', 'turn/started']);
  });
});

describe('framing', () => {
  test('JSON split across chunks, multibyte characters included, and several messages in one chunk', async () => {
    const peer = fakePeer();
    const methods: string[] = [];
    const params: unknown[] = [];
    peer.rpc.onNotification((notification) => {
      methods.push(notification.method);
      params.push(notification.params);
    });
    const bytes = encoder.encode(
      `${JSON.stringify({ method: 'warning', params: { threadId: null, message: 'ünïcødé ✓' } })}\n`,
    );
    const cut = bytes.indexOf(0xc3) + 1;
    peer.send(bytes.subarray(0, cut));
    await settle();
    peer.send(bytes.subarray(cut));
    peer.line(turnCompleted('t-1', 'turn-1'), { method: 'thread/status/changed', params: { threadId: 't-1' } });
    peer.send('\n\r\n');
    await settle();
    expect(methods).toEqual(['warning', 'turn/completed', 'thread/status/changed']);
    // Decoded as one line, not chunk by chunk, which would turn each half of the cut 'ü' into U+FFFD.
    expect(params[0]).toEqual({ threadId: null, message: 'ünïcødé ✓' });
    expect(peer.logger.entries.filter((entry) => entry.level === 'warn')).toEqual([]);
  });

  test('a line over the size cap and invalid JSON give a warning and parsing continues', async () => {
    const peer = fakePeer({ maxLineBytes: 64 });
    const seen: unknown[] = [];
    peer.rpc.onNotification((notification) => seen.push(notification.params));
    const long = JSON.stringify({ method: 'warning', params: { message: 'x'.repeat(200) } });
    peer.send(long.slice(0, 100));
    await settle();
    peer.send(`${long.slice(100)}\n`);
    peer.send('{not json\n');
    peer.send('[1,2]\n');
    peer.line({ method: 'warning', params: { message: 'short' } });
    await settle();
    expect(seen).toEqual([{ message: 'short' }]);
    expect(peer.logger.entries.filter((entry) => entry.level === 'warn').map((entry) => entry.message)).toEqual([
      'codex rpc: line over the size cap dropped',
      'codex rpc: line is not JSON',
      'codex rpc: message of no known kind',
    ]);
  });

  test('a response over the size cap rejects its request at once, naming the cap', async () => {
    const peer = fakePeer({ maxLineBytes: 64 });
    const request = peer.rpc.request('thread/resume', { threadId: 't-1' }, { timeoutMs: 60_000 });
    const failed = peer.rpc.request('thread/delete', { threadId: 't-1' }, { timeoutMs: 60_000 });
    const after = peer.rpc.request('thread/delete', { threadId: 't-2' });
    const started = Date.now();
    peer.line(
      { id: 1, result: { padding: 'x'.repeat(100) } },
      { id: 2, error: { code: -32600, message: 'y'.repeat(100) } },
      { id: 3, result: {} },
    );
    for (const [promise, method] of [
      [request, 'thread/resume'],
      [failed, 'thread/delete'],
    ] as const) {
      const error = await failure(promise);
      expect(error).toBeInstanceOf(RpcError);
      expect(error).toMatchObject({ method, code: -32603 });
      expect((error as RpcError).message).toContain('64-byte');
    }
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(await after).toEqual({});
  });

  test('a server request over the size cap is answered -32603, and later requests still get their answers', async () => {
    const peer = fakePeer({ maxLineBytes: 256 });
    const seen: unknown[] = [];
    peer.rpc.handle('item/commandExecution/requestApproval', (params, id) => {
      seen.push(id);
      return { decision: 'decline' };
    });
    const request = (id: number | string, command: string) => ({
      id,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 't-1', turnId: 'turn-1', itemId: `item-${id}`, startedAtMs: 1, command },
    });
    // As app-server writes it: the id first. A string id may hold escaped quotes.
    peer.send(`${JSON.stringify(request(7, 'x'.repeat(1_024)))}\n`);
    peer.send(`${JSON.stringify(request('a"b', 'y'.repeat(1_024)))}\n`);
    peer.line(request(8, 'ls'));
    await settle();
    expect(seen).toEqual([8]);
    expect(peer.written()).toEqual([
      { id: 7, error: { code: -32603, message: 'message over the size cap' } },
      { id: 'a"b', error: { code: -32603, message: 'message over the size cap' } },
      { id: 8, result: { decision: 'decline' } },
    ]);
  });
});

describe('server requests', () => {
  const approval = (id: number | string) => ({
    id,
    method: 'item/fileChange/requestApproval',
    params: { threadId: 't-1', turnId: 'turn-1', itemId: 'item-1', startedAtMs: 1 },
  });

  test('a request that no handler claims gets -32601', async () => {
    const peer = fakePeer();
    peer.line(approval(0), { id: 'x-1', method: 'item/tool/call', params: {} });
    await settle();
    expect(peer.written()).toEqual([
      { id: 0, error: { code: -32601, message: 'unhandled server request: item/fileChange/requestApproval' } },
      { id: 'x-1', error: { code: -32601, message: 'unhandled server request: item/tool/call' } },
    ]);
  });

  test('a handler gets the params and the request id, and its answer is written once', async () => {
    const peer = fakePeer();
    const calls: unknown[] = [];
    peer.rpc.handle('item/fileChange/requestApproval', (params, id) => {
      calls.push([params.itemId, id]);
      return { decision: 'decline' };
    });
    peer.line(approval(3));
    await settle();
    expect(calls).toEqual([['item-1', 3]]);
    expect(peer.written()).toEqual([{ id: 3, result: { decision: 'decline' } }]);
  });

  test('a throwing or rejecting handler gets -32603', async () => {
    const peer = fakePeer();
    peer.rpc.handle('item/fileChange/requestApproval', () => {
      throw new Error('boom');
    });
    peer.rpc.handle('item/tool/requestUserInput', async () => {
      throw new Error('later boom');
    });
    const params = { threadId: 't-1', turnId: 'turn-1', itemId: 'i', questions: [], isBlocking: true };
    peer.line(approval(1), { id: 2, method: 'item/tool/requestUserInput', params: { ...params, autoResolutionMs: 0 } });
    await settle();
    expect(peer.written()).toEqual([
      { id: 1, error: { code: -32603, message: 'boom' } },
      { id: 2, error: { code: -32603, message: 'later boom' } },
    ]);
  });

  test('a deferred answer is written when it resolves, and never after close', async () => {
    const peer = fakePeer();
    const answers: ((value: { decision: 'accept' }) => void)[] = [];
    peer.rpc.handle(
      'item/fileChange/requestApproval',
      () => new Promise<{ decision: 'accept' }>((resolve) => answers.push(resolve)),
    );
    peer.line(approval(1), approval(2));
    await settle();
    expect(peer.written()).toEqual([]);
    answers[0]?.({ decision: 'accept' });
    answers[0]?.({ decision: 'accept' });
    await settle();
    expect(peer.written()).toEqual([{ id: 1, result: { decision: 'accept' } }]);
    peer.rpc.close();
    answers[1]?.({ decision: 'accept' });
    await settle();
    expect(peer.written()).toEqual([{ id: 1, result: { decision: 'accept' } }]);
  });

  test('a repeated request id is answered once', async () => {
    const peer = fakePeer();
    let calls = 0;
    peer.rpc.handle('item/fileChange/requestApproval', () => {
      calls += 1;
      return { decision: 'decline' };
    });
    peer.line(approval(5), approval(5));
    await settle();
    expect(calls).toBe(1);
    expect(peer.written()).toEqual([{ id: 5, result: { decision: 'decline' } }]);
    expect(peer.logger.entries.map((entry) => entry.message)).toContain('codex rpc: repeated server request id');
  });
});

describe('notifications and close', () => {
  test('reach every listener in arrival order, past a listener that throws', async () => {
    const peer = fakePeer();
    const all: string[] = [];
    const completed: string[] = [];
    peer.rpc.onNotification(() => {
      throw new Error('listener bug');
    });
    peer.rpc.onNotification((notification) => all.push(notification.method));
    const off = peer.rpc.on('turn/completed', (params) => completed.push(params.turn.id));
    peer.line(
      { method: 'thread/status/changed', params: { threadId: 't-1', status: { type: 'idle' } } },
      turnCompleted('t-1', 'turn-1'),
      { method: 'serverRequest/resolved', params: { threadId: 't-1', requestId: 0 } },
    );
    await settle();
    off();
    peer.line(turnCompleted('t-1', 'turn-2'));
    await settle();
    expect(all).toEqual(['thread/status/changed', 'turn/completed', 'serverRequest/resolved', 'turn/completed']);
    expect(completed).toEqual(['turn-1']);
    expect(peer.logger.entries.filter((entry) => entry.message === 'codex rpc: listener failed')).toHaveLength(4);
  });

  test('when stdout ends, pending requests reject with RpcClosed and later writes are dropped', async () => {
    const peer = fakePeer();
    const pending = peer.rpc.request('thread/start', { cwd: '/tmp/clone' });
    peer.finish();
    await peer.rpc.ended;
    const error = await failure(pending);
    expect(error).toBeInstanceOf(RpcClosed);
    expect(error).toMatchObject({ method: 'thread/start' });
    expect(peer.rpc.closed).toBe(true);
    const before = peer.written().length;
    expect(await failure(peer.rpc.request('thread/delete', { threadId: 't' }))).toBeInstanceOf(RpcClosed);
    peer.rpc.notify('initialized');
    expect(peer.written()).toHaveLength(before);
  });

  test('close() ends stdin, rejects pending requests and delivers nothing more', async () => {
    const peer = fakePeer();
    const seen: string[] = [];
    peer.rpc.onNotification((notification) => seen.push(notification.method));
    const pending = peer.rpc.request('turn/interrupt', { threadId: 't-1', turnId: 'turn-1' });
    peer.rpc.close();
    peer.rpc.close();
    expect(peer.stdinEnded).toBe(true);
    expect(await failure(pending)).toBeInstanceOf(RpcClosed);
    // The rest of stdout is still read, so the peer never blocks on a full pipe, but nothing is delivered.
    peer.line(turnCompleted('t-1', 'turn-1'), { id: 1, result: {} });
    peer.finish();
    await peer.rpc.ended;
    expect(seen).toEqual([]);
  });

  test('a failing stdout ends the client like its end does', async () => {
    const failing = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('EIO'));
      },
    });
    const rpc = new CodexRpc({ stdin: { write: () => 0, end: () => 0 }, stdout: failing, logger: memoryLogger() });
    const pending = rpc.request('thread/delete', { threadId: 't' });
    await rpc.ended;
    expect(await failure(pending)).toBeInstanceOf(RpcClosed);
  });

  test('a stdin that throws is logged, and the request still waits for its answer', async () => {
    const logger = memoryLogger();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stdout = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    const stdin = {
      write(): number {
        throw new Error('EPIPE');
      },
      end: () => 0,
    };
    const rpc = new CodexRpc({ stdin, stdout, logger });
    const pending = rpc.request('thread/delete', { threadId: 't' });
    expect(logger.entries.map((entry) => entry.message)).toEqual(['codex rpc: write failed']);
    controller.close();
    expect(await failure(pending)).toBeInstanceOf(RpcClosed);
  });
});
