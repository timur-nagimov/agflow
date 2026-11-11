import { afterEach, describe, expect, test } from 'bun:test';
import type { RunnerTestBlock } from '@agflow/runner/src/config';
import {
  codexTestConfig,
  DEFAULT_COMPACTION_SUMMARY,
  DEFAULT_REPLY_TEXT,
  rateLimitHeaders,
  type ResponsesServer,
  reply,
  rules,
  startResponsesServer,
} from '../../src/codex/index';

const servers: ResponsesServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

async function server(): Promise<ResponsesServer> {
  const started = await startResponsesServer();
  servers.push(started);
  return started;
}

const COMPACTION_PROMPT =
  'You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume ' +
  'the task.';

function request(target: ResponsesServer, threadId: string, text = 'hello', init: RequestInit = {}): Promise<Response> {
  return fetch(`${target.url}/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'thread-id': threadId },
    body: JSON.stringify({
      model: 'gpt-6.1-sol',
      input: [
        { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'You are Codex.' }] },
        { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'BRIEF' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
      ],
    }),
    ...init,
  });
}

function events(text: string): { event: string; data: Record<string, any> }[] {
  return text
    .split('\n\n')
    .filter((block) => block.trim())
    .map((block) => ({
      event: block.match(/^event: (.*)$/m)?.[1] ?? '',
      data: JSON.parse(block.match(/^data: (.*)$/m)?.[1] ?? '{}'),
    }));
}

async function until(condition: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the condition');
    await Bun.sleep(10);
  }
}

describe('rateLimitHeaders', () => {
  test('gives the x-codex window and credit headers Codex reads', () => {
    expect(
      rateLimitHeaders({
        primary: { usedPercent: 42.5, windowMinutes: 300, resetAt: 1_793_207_968 },
        secondary: { usedPercent: 10, windowMinutes: 10_080, resetAt: 1_793_290_768 },
        credits: { hasCredits: true, unlimited: false, balance: '12.50' },
        reachedType: 'rate_limit_reached',
      }),
    ).toEqual({
      'x-codex-primary-used-percent': '42.5',
      'x-codex-primary-window-minutes': '300',
      'x-codex-primary-reset-at': '1793207968',
      'x-codex-secondary-used-percent': '10',
      'x-codex-secondary-window-minutes': '10080',
      'x-codex-secondary-reset-at': '1793290768',
      'x-codex-credits-has-credits': 'true',
      'x-codex-credits-unlimited': 'false',
      'x-codex-credits-balance': '12.50',
      'x-codex-rate-limit-reached-type': 'rate_limit_reached',
    });
    expect(rateLimitHeaders({ primary: { usedPercent: 1, windowMinutes: 300, resetAt: 5 } })).toEqual({
      'x-codex-primary-used-percent': '1',
      'x-codex-primary-window-minutes': '300',
      'x-codex-primary-reset-at': '5',
    });
  });

  test('can go with any reply', async () => {
    const scripted = await server();
    const headers = rateLimitHeaders({ primary: { usedPercent: 50, windowMinutes: 300, resetAt: 100 } });
    scripted.setHandler((parsed) => {
      if (parsed.lastUserText === 'text') return { ...reply.text('ok'), headers };
      if (parsed.lastUserText === 'hang') return { ...reply.hang(), headers };
      return { ...reply.failed('server_error', 'x'), headers };
    });
    for (const text of ['text', 'failed', 'hang']) {
      const response = await request(scripted, 't', text);
      expect(response.headers.get('x-codex-primary-used-percent')).toBe('50');
      if (text === 'hang') expect(scripted.release('t')).toBe(1);
      expect(events(await response.text()).at(-1)?.event).toBe(
        text === 'failed' ? 'response.failed' : 'response.completed',
      );
    }
  });
});

describe('failure replies', () => {
  test('usageLimit answers 429 usage_limit_reached with the exhausted window in the headers', async () => {
    const scripted = await server();
    scripted.setHandler(() => reply.usageLimit(1_800));
    const before = Math.floor(Date.now() / 1000);
    const response = await request(scripted, 't');
    const after = Math.floor(Date.now() / 1000);
    expect(response.status).toBe(429);
    const body = (await response.json()) as { error: Record<string, unknown> };
    expect(body.error).toMatchObject({ type: 'usage_limit_reached', resets_in_seconds: 1_800 });
    // The reset is resetInS from when the reply was built, which Task 23's resetsAt assertions rely on.
    const resetsAt = body.error.resets_at as number;
    expect(resetsAt).toBeGreaterThanOrEqual(before + 1_800);
    expect(resetsAt).toBeLessThanOrEqual(after + 1_800);
    expect(response.headers.get('x-codex-primary-used-percent')).toBe('100');
    expect(response.headers.get('x-codex-primary-window-minutes')).toBe('300');
    expect(Number(response.headers.get('x-codex-primary-reset-at'))).toBe(resetsAt);
    // The weekly window is not exhausted and resets a week from now.
    expect(response.headers.get('x-codex-secondary-used-percent')).toBe('40');
    expect(response.headers.get('x-codex-secondary-window-minutes')).toBe('10080');
    const weekly = Number(response.headers.get('x-codex-secondary-reset-at'));
    expect(weekly).toBeGreaterThanOrEqual(before + 7 * 24 * 3600);
    expect(weekly).toBeLessThanOrEqual(after + 7 * 24 * 3600);
  });

  test('httpError answers with its status, body and headers', async () => {
    const scripted = await server();
    scripted.setHandler(() =>
      reply.httpError(500, { error: { type: 'server_error', message: 'boom' } }, { 'retry-after': '1' }),
    );
    const response = await request(scripted, 't');
    expect(response.status).toBe(500);
    expect(response.headers.get('retry-after')).toBe('1');
    expect(await response.json()).toEqual({ error: { type: 'server_error', message: 'boom' } });
  });

  test('failed sends response.failed inside a 200 stream', async () => {
    const scripted = await server();
    scripted.setHandler(() => reply.failed('context_length_exceeded', 'Your input exceeds the context window.'));
    const response = await request(scripted, 't');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toStartWith('text/event-stream');
    const stream = events(await response.text());
    expect(stream.map((event) => event.event)).toEqual(['response.created', 'response.failed']);
    expect(stream[1]?.data.response).toMatchObject({
      status: 'failed',
      error: { code: 'context_length_exceeded', message: 'Your input exceeds the context window.' },
    });
  });
});

describe('holds', () => {
  test('hang holds the stream until release(threadId), then finishes it', async () => {
    const scripted = await server();
    scripted.setHandler(rules([{ threadId: 'held', reply: reply.hang(reply.text('after the hold')) }]));
    const held = request(scripted, 'held').then((response) => response.text());
    const free = await (await request(scripted, 'free')).text();
    expect(events(free).at(-1)?.event).toBe('response.completed');
    let settled = false;
    void held.then(() => {
      settled = true;
    });
    await Bun.sleep(100);
    expect(settled).toBe(false);
    expect(scripted.release('other')).toBe(0);
    expect(scripted.release('held')).toBe(1);
    const stream = events(await held);
    expect(stream.map((event) => event.event)).toEqual([
      'response.created',
      'response.output_item.added',
      'response.output_text.delta',
      'response.output_item.done',
      'response.completed',
    ]);
    expect(stream[2]?.data.delta).toBe('after the hold');
    expect(scripted.requests.map((parsed) => parsed.aborted)).toEqual([false, false]);
  });

  test('the response starts before the hold, and a held request records the client abort', async () => {
    const scripted = await server();
    scripted.setHandler(() => reply.hang());
    const controller = new AbortController();
    const response = await request(scripted, 'held', 'hello', { signal: controller.signal });
    expect(response.status).toBe(200);
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(events(first).map((event) => event.event)).toEqual(['response.created']);
    controller.abort();
    await until(() => scripted.requests[0]?.aborted === true);
    // An aborted hold is gone; releasing it finds nothing.
    expect(scripted.release('held')).toBe(0);
  });

  test('a hold without a thread id is released by release() with no argument, and close finishes every hold', async () => {
    const scripted = await server();
    scripted.setHandler(() => reply.hang());
    const first = fetch(`${scripted.url}/responses`, { method: 'POST', body: JSON.stringify({ input: [] }) });
    const second = request(scripted, 'held');
    await until(() => scripted.requests.length === 2);
    expect(scripted.release()).toBe(2);
    for (const response of [await first, await second]) {
      expect(events(await response.text()).at(-1)?.data.response.output[0].content[0].text).toBe(DEFAULT_REPLY_TEXT);
    }
    const third = request(scripted, 'held').then((response) => response.text());
    await until(() => scripted.requests.length === 3);
    const closing = Date.now();
    await scripted.close();
    servers.splice(servers.indexOf(scripted), 1);
    expect(Date.now() - closing).toBeLessThan(1_500);
    expect(events(await third).at(-1)?.event).toBe('response.completed');
  });
});

describe('compaction', () => {
  test('a compaction request gets a scripted summary by default and is not flagged', async () => {
    const scripted = await server();
    const response = await request(scripted, 't', `${COMPACTION_PROMPT}\n\nInclude:\n- progress`);
    const stream = events(await response.text());
    expect(stream.at(-1)?.data.response.output[0].content[0].text).toBe(DEFAULT_COMPACTION_SUMMARY);
    expect(scripted.requests[0]).toMatchObject({ isCompaction: true, unmatched: false });
    await (await request(scripted, 't')).text();
    expect(scripted.requests[1]).toMatchObject({ isCompaction: false, unmatched: true });
  });

  test('rules skip compaction requests unless a rule asks for them', async () => {
    const scripted = await server();
    scripted.setHandler(
      rules([
        { marker: 'BRIEF', reply: reply.shell({ cmd: 'ls', callId: 'call-ls' }) },
        { compaction: true, marker: 'BRIEF', reply: reply.text('custom summary') },
      ]),
    );
    const compaction = events(await (await request(scripted, 't', COMPACTION_PROMPT)).text());
    expect(compaction.at(-1)?.data.response.output[0].content[0].text).toBe('custom summary');
    const normal = events(await (await request(scripted, 't')).text());
    expect(normal.at(-1)?.data.response.output[0]).toMatchObject({ type: 'custom_tool_call', call_id: 'call-ls' });
    scripted.setHandler(rules([{ marker: 'BRIEF', reply: reply.shell({ cmd: 'ls' }) }]));
    const fallback = events(await (await request(scripted, 't', COMPACTION_PROMPT)).text());
    expect(fallback.at(-1)?.data.response.output[0].content[0].text).toBe(DEFAULT_COMPACTION_SUMMARY);
  });
});

describe('codexTestConfig', () => {
  test('points Codex at the scripted provider with retries off', () => {
    expect(codexTestConfig('http://127.0.0.1:4100/v1', { streamIdleTimeoutMs: 15_000 })).toEqual({
      model_provider: 'agflow_test',
      model_providers: {
        agflow_test: {
          name: 'agflow test',
          base_url: 'http://127.0.0.1:4100/v1',
          wire_api: 'responses',
          requires_openai_auth: false,
          request_max_retries: 0,
          stream_max_retries: 0,
          stream_idle_timeout_ms: 15_000,
        },
      },
    });
  });

  test("is runner.json's test.codexConfig as it is", () => {
    // A compile-time check as much as a runtime one: the value fits the block's type without a cast.
    const block: RunnerTestBlock['codexConfig'] = codexTestConfig('http://127.0.0.1:4100/v1');
    expect(block).toEqual(codexTestConfig('http://127.0.0.1:4100/v1'));
  });

  test("defaults the stream idle timeout to Codex's own and takes a server's url", async () => {
    const scripted = await server();
    const config = codexTestConfig(scripted.url);
    expect(config.model_providers.agflow_test.base_url).toBe(scripted.url);
    expect(config.model_providers.agflow_test.stream_idle_timeout_ms).toBe(300_000);
  });
});
