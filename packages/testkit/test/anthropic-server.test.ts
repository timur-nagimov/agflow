import { afterEach, describe, expect, test } from 'bun:test';
import Anthropic from '@anthropic-ai/sdk';
import { cleanupTestProcesses } from '../src/process-cleanup';
import {
  AUXILIARY_TEXT,
  agflowTool,
  bashTool,
  fail,
  hold,
  inSession,
  reply,
  rules,
  type ScriptedAnthropic,
  startScriptedAnthropic,
  text,
  UNSCRIPTED_TEXT,
  userSays,
} from '../src/anthropic';

const servers: ScriptedAnthropic[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

async function scripted(...args: Parameters<typeof startScriptedAnthropic>): Promise<ScriptedAnthropic> {
  const server = await startScriptedAnthropic(...args);
  servers.push(server);
  return server;
}

function client(server: ScriptedAnthropic): Anthropic {
  return new Anthropic({ baseURL: server.url, apiKey: 'sk-ant-test', maxRetries: 0 });
}

const TOOLS = [
  { name: 'Bash', description: 'Run a command', input_schema: { type: 'object' as const, properties: {} } },
];
const SESSION_A = '11111111-1111-4111-8111-111111111111';
const SESSION_B = '22222222-2222-4222-8222-222222222222';

/** A main-loop request of one session, sent the way the CLI sends it. */
function post(server: ScriptedAnthropic, sessionId: string, prompt: string, init: { stream?: boolean } = {}) {
  return fetch(`${server.url}/v1/messages?beta=true`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'k', 'x-claude-code-session-id': sessionId },
    body: JSON.stringify({
      model: 'claude-sonnet-5-5',
      max_tokens: 1024,
      stream: init.stream ?? false,
      tools: TOOLS,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
}

async function textOf(response: Response): Promise<string> {
  const message = (await response.json()) as { content: { type: string; text?: string }[] };
  return message.content.map((block) => block.text ?? '').join('');
}

describe('startScriptedAnthropic', () => {
  test('serves streamed and plain replies the SDK reassembles', async () => {
    const server = await scripted({
      handler: rules(
        {
          when: userSays('call a tool'),
          reply: reply([text('Running it.'), bashTool({ command: 'echo hi', id: 'toolu_1' })]),
        },
        { when: userSays('hello'), reply: reply('Hello from the scripted server, in more than one delta.') },
      ),
    });
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const anthropic = client(server);
    const params = { model: 'claude-sonnet-5-5', max_tokens: 1024, tools: TOOLS };

    const greeting = await anthropic.messages
      .stream({ ...params, messages: [{ role: 'user', content: 'hello' }] })
      .finalMessage();
    expect(greeting.content).toEqual([
      expect.objectContaining({ type: 'text', text: 'Hello from the scripted server, in more than one delta.' }),
    ]);
    expect(greeting.stop_reason).toBe('end_turn');

    const call = await anthropic.messages
      .stream({ ...params, messages: [{ role: 'user', content: 'call a tool' }] })
      .finalMessage();
    expect(call.stop_reason).toBe('tool_use');
    expect(call.content).toEqual([
      expect.objectContaining({ type: 'text', text: 'Running it.' }),
      expect.objectContaining({
        type: 'tool_use',
        id: 'toolu_1',
        name: 'Bash',
        input: { command: 'echo hi', description: 'Run a scripted command' },
      }),
    ]);
    expect(call.usage.input_tokens).toBe(100);

    const plain = await anthropic.messages.create({ ...params, messages: [{ role: 'user', content: 'call a tool' }] });
    expect(plain.content).toEqual(call.content);
    expect(plain.stop_reason).toBe('tool_use');
  });

  test('answers interleaved sessions from one handler, in either order', async () => {
    const server = await scripted({
      handler: rules(
        { when: inSession(SESSION_A), reply: (request) => reply(`A heard ${request.userTexts.join(' ')}`) },
        { when: inSession(SESSION_B), reply: hold('b', reply('B answered')) },
      ),
    });
    // B is held while A is answered, then B answers.
    const pendingB = post(server, SESSION_B, 'b1');
    expect(await textOf(await post(server, SESSION_A, 'a1'))).toBe('A heard a1');
    server.release('b');
    expect(await textOf(await pendingB)).toBe('B answered');
    // The other order, all at once.
    const [a, b] = await Promise.all([post(server, SESSION_A, 'a2'), post(server, SESSION_B, 'b2')]);
    expect(await textOf(a)).toBe('A heard a2');
    expect(await textOf(b)).toBe('B answered');
  });

  test('setHandler replaces the handler; declined requests get the default answers', async () => {
    const server = await scripted();
    const anthropic = client(server);
    const unscripted = await anthropic.messages.create({
      model: 'claude-sonnet-5-5',
      max_tokens: 64,
      tools: TOOLS,
      messages: [{ role: 'user', content: 'first' }],
    });
    expect(unscripted.content).toEqual([expect.objectContaining({ type: 'text', text: UNSCRIPTED_TEXT })]);
    expect(unscripted.stop_reason).toBe('end_turn');

    server.setHandler(rules({ when: userSays('second'), reply: reply('scripted second') }));
    expect(await textOf(await post(server, SESSION_A, 'second'))).toBe('scripted second');
    expect(await textOf(await post(server, SESSION_A, 'third'))).toBe(UNSCRIPTED_TEXT);

    // An auxiliary request (a title: no tools) gets the short default and is not unmatched.
    const title = await anthropic.messages.create({
      model: 'claude-haiku-5-5',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'second' }],
    });
    expect(title.content).toEqual([expect.objectContaining({ type: 'text', text: AUXILIARY_TEXT })]);

    expect(server.unmatched.map((request) => request.userTexts)).toEqual([['first'], ['third']]);
    server.setHandler(null);
    expect(await textOf(await post(server, SESSION_A, 'second'))).toBe(UNSCRIPTED_TEXT);
  });

  test('a handler may answer asynchronously, and a throwing one gives an api_error', async () => {
    const server = await scripted({
      handler: async (request) => {
        await Bun.sleep(5);
        if (request.userTexts.includes('throw')) throw new Error('script bug');
        return reply('later');
      },
    });
    expect(await textOf(await post(server, SESSION_A, 'go'))).toBe('later');
    const failed = await post(server, SESSION_A, 'throw');
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({
      type: 'error',
      error: { type: 'api_error', message: 'the scripted handler threw: script bug' },
    });
  });

  test('fail() replies arrive with their status, body and headers; count_tokens answers', async () => {
    const server = await scripted({
      handler: rules(
        { when: userSays('limit'), reply: fail(429, { retryAfterSeconds: 7 }) },
        { when: userSays('busy'), reply: fail(529) },
        { when: userSays('long'), reply: fail(400) },
      ),
    });
    const limited = await post(server, SESSION_A, 'limit');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('7');
    expect(limited.headers.get('content-type')).toStartWith('application/json');
    expect(await limited.json()).toMatchObject({ type: 'error', error: { type: 'rate_limit_error' } });
    // Errors are errors for streaming requests too.
    const busy = await post(server, SESSION_A, 'busy', { stream: true });
    expect(busy.status).toBe(529);
    expect(await busy.json()).toMatchObject({ error: { type: 'overloaded_error' } });
    const anthropic = client(server);
    const error = await anthropic.messages
      .create({
        model: 'claude-sonnet-5-5',
        max_tokens: 64,
        tools: TOOLS,
        messages: [{ role: 'user', content: 'long' }],
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Anthropic.BadRequestError);
    expect((error as InstanceType<typeof Anthropic.BadRequestError>).message).toContain('prompt is too long');

    const counted = await anthropic.messages.countTokens({
      model: 'claude-sonnet-5-5',
      messages: [{ role: 'user', content: 'count me' }],
    });
    expect(counted.input_tokens).toBeGreaterThan(0);
    expect(server.requests.at(-1)?.endpoint).toBe('count_tokens');
  });

  test('message replies carry their headers', async () => {
    const server = await scripted({
      handler: () => reply('ok', { headers: { 'anthropic-ratelimit-unified-status': 'allowed_warning' } }),
    });
    const response = await post(server, SESSION_A, 'x', { stream: true });
    expect(response.headers.get('content-type')).toStartWith('text/event-stream');
    expect(response.headers.get('anthropic-ratelimit-unified-status')).toBe('allowed_warning');
    expect(response.headers.get('request-id')).toMatch(/^req_/);
    await response.text();
  });

  test('a held reply waits for its gate; a gate released early lets it through', async () => {
    const script = rules(
      { when: userSays('wait'), reply: hold('gate-1', reply('released')) },
      { when: userSays('early'), reply: hold('gate-2', reply('already open')) },
    );
    const arrived = Promise.withResolvers<void>();
    const server = await scripted({
      handler: (request) => {
        arrived.resolve();
        return script(request);
      },
    });
    let settled = false;
    const pending = post(server, SESSION_A, 'wait').then((response) => {
      settled = true;
      return response;
    });
    // Once the request has arrived, a macrotask later its reply is already waiting on the gate.
    await arrived.promise;
    await Bun.sleep(50);
    expect(settled).toBe(false);
    server.release('gate-1');
    expect(await textOf(await pending)).toBe('released');
    server.release('gate-2');
    expect(await textOf(await post(server, SESSION_A, 'early'))).toBe('already open');
  });

  test('close() ends held requests and the server', async () => {
    const arrived = Promise.withResolvers<void>();
    const server = await startScriptedAnthropic({
      handler: () => {
        arrived.resolve();
        return hold('never', reply('unreachable'));
      },
    });
    const pending = post(server, SESSION_A, 'x', { stream: true }).then(
      (response) => response.text(),
      () => 'failed',
    );
    // One macrotask after the request arrived, its reply is waiting on the gate that close() must end.
    await arrived.promise;
    await Bun.sleep(0);
    await server.close();
    expect(await pending).not.toContain('unreachable');
    expect(await post(server, SESSION_A, 'y').catch(() => 'refused')).toBe('refused');
  });

  test('the cleanup backstop releases held requests without an explicit close', async () => {
    const arrived = Promise.withResolvers<void>();
    const server = await startScriptedAnthropic({
      handler: () => {
        arrived.resolve();
        return hold('never', reply('unreachable'));
      },
    });
    const pending = post(server, SESSION_A, 'x', { stream: true }).then(
      (response) => response.text(),
      () => 'failed',
    );
    // One macrotask after the request arrived, its reply is waiting on the gate that close() must end.
    await arrived.promise;
    await Bun.sleep(0);
    await cleanupTestProcesses();
    expect(await pending).not.toContain('unreachable');
    expect(await post(server, SESSION_A, 'y').catch(() => 'refused')).toBe('refused');
  });

  test('records every request, parsed and raw, in arrival order', async () => {
    const server = await scripted({ handler: () => reply([agflowTool({ tool: 'get_goal', id: 'toolu_g' })]) });
    await post(server, SESSION_A, 'one');
    await post(server, SESSION_B, 'two', { stream: true }).then((response) => response.text());
    const missing = await fetch(`${server.url}/v1/models`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ type: 'error', error: { type: 'not_found_error' } });
    const broken = await fetch(`${server.url}/v1/messages`, { method: 'POST', body: '{not json' });
    expect(broken.status).toBe(400);

    expect(server.requests.map((request) => [request.endpoint, request.path, request.sessionId])).toEqual([
      ['messages', '/v1/messages', SESSION_A],
      ['messages', '/v1/messages', SESSION_B],
      ['other', '/v1/models', null],
      ['messages', '/v1/messages', null],
    ]);
    expect(server.requests[0]?.userTexts).toEqual(['one']);
    expect(server.requests[1]?.stream).toBe(true);
    expect(server.requests[0]?.headers['x-claude-code-session-id']).toBe(SESSION_A);
    expect(server.requests[0]?.body).toMatchObject({ model: 'claude-sonnet-5-5', messages: [{ content: 'one' }] });
    expect(server.requests[3]?.body).toBe('{not json');
    // Unknown endpoints show up as unmatched, so a new kind of request is visible.
    expect(server.unmatched.map((request) => request.path)).toEqual(['/v1/models', '/v1/messages']);
  });
});
