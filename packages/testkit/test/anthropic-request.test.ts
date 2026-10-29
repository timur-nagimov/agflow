import { describe, expect, test } from 'bun:test';
import {
  type AnthropicRequest,
  isCompaction,
  isMainLoop,
  parseAnthropicRequest,
} from '../src/anthropic/request';
import {
  afterToolResult,
  agflowTool,
  bashTool,
  briefHas,
  fail,
  hold,
  inSession,
  refusal,
  reply,
  rules,
  text,
  toolUse,
  userSays,
} from '../src/anthropic/replies';
import { encodeMessage, encodeSse } from '../src/anthropic/sse';

const SESSION = 'a4fd8ec7-a5e0-4bde-adf3-ec416a148fb0';
const OTHER_SESSION = '0b6f3c2e-9d41-4c7a-8e15-2f7a9c3d5e10';

const TOOLS = ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'mcp__agflow__get_goal'].map((name) => ({
  name,
  description: `${name} tool`,
  input_schema: { type: 'object', properties: {} },
}));

/** A follow-up request shaped like 2.1.285's main loop after a Bash call with a message folded in mid-turn. */
function mainLoopBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: 'claude-sonnet-5-5',
    max_tokens: 128000,
    stream: true,
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.285.bc6; cc_entrypoint=sdk-cli;' },
      { type: 'text', text: "You are a Claude agent, built on Anthropic's Claude Agent SDK." },
    ],
    tools: TOOLS,
    metadata: {
      user_id: JSON.stringify({ device_id: 'd'.repeat(64), account_uuid: '', session_id: SESSION }),
    },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: '<system-reminder>\nBRIEF-MARKER-K7 Your working directory: /w/T-1-a1\n</system-reminder>' },
          { type: 'text', text: 'Start the task.' },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Calling the bridge.' },
          { type: 'tool_use', id: 'toolu_goal_1', name: 'mcp__agflow__get_goal', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_goal_1', content: [{ type: 'text', text: 'goal: ship it' }] },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: '<total_tokens>14999961 tokens left</total_tokens>' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_bash_2', name: 'Bash', input: { command: 'sleep 4; echo slept' } }],
      },
      {
        role: 'user',
        content: [
          { tool_use_id: 'toolu_bash_2', type: 'tool_result', content: 'slept', is_error: false },
          { type: 'text', text: 'and a user note after the result' },
        ],
      },
      {
        role: 'system',
        content: [
          {
            type: 'text',
            text: 'The user sent a new message while you were working:\nMIDTURN-MSG: hello mid-turn\n',
            cache_control: { type: 'ephemeral' },
          },
        ],
      },
    ],
    ...overrides,
  };
}

function parse(body: Record<string, unknown>, headers: Record<string, string> = {}): AnthropicRequest {
  return parseAnthropicRequest(body, headers);
}

describe('parseAnthropicRequest', () => {
  test('parses a main-loop request of 2.1.285', () => {
    const body = mainLoopBody();
    const request = parseAnthropicRequest(
      body,
      new Headers({ 'X-Claude-Code-Session-Id': SESSION, 'x-api-key': 'k' }),
      '/v1/messages',
    );
    expect(request.endpoint).toBe('messages');
    expect(request.path).toBe('/v1/messages');
    expect(request.sessionId).toBe(SESSION);
    expect(request.model).toBe('claude-sonnet-5-5');
    expect(request.stream).toBe(true);
    expect(request.system).toBe(
      "x-anthropic-billing-header: cc_version=2.1.285.bc6; cc_entrypoint=sdk-cli;\nYou are a Claude agent, built on Anthropic's Claude Agent SDK.",
    );
    expect(request.tools).toEqual(['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'mcp__agflow__get_goal']);
    expect(request.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
      'user',
      'assistant',
      'user',
      'system',
    ]);
    expect(request.messages[1]?.blocks).toEqual([
      { type: 'text', text: 'Calling the bridge.' },
      { type: 'tool_use', id: 'toolu_goal_1', name: 'mcp__agflow__get_goal', input: {} },
    ]);
    expect(request.messages[2]?.blocks).toEqual([
      { type: 'tool_result', toolUseId: 'toolu_goal_1', text: 'goal: ship it', isError: false },
    ]);
    expect(request.messages[5]?.blocks).toEqual([
      { type: 'tool_result', toolUseId: 'toolu_bash_2', text: 'slept', isError: false },
      { type: 'text', text: 'and a user note after the result' },
    ]);
    expect(request.messages[6]?.blocks).toEqual([
      { type: 'text', text: 'The user sent a new message while you were working:\nMIDTURN-MSG: hello mid-turn\n' },
    ]);
    expect(request.toolResults).toEqual([{ toolUseId: 'toolu_bash_2', text: 'slept', isError: false }]);
    expect(request.lastToolResult).toEqual({ toolUseId: 'toolu_bash_2', text: 'slept', isError: false });
    expect(request.userTexts).toEqual([
      'and a user note after the result',
      'The user sent a new message while you were working:\nMIDTURN-MSG: hello mid-turn\n',
    ]);
    expect(request.mainLoop).toBe(true);
    expect(request.compaction).toBe(false);
    expect(request.headers['x-claude-code-session-id']).toBe(SESSION);
    expect(request.body).toBe(body);
  });

  test('takes the session id from metadata.user_id without the header', () => {
    expect(parse(mainLoopBody()).sessionId).toBe(SESSION);
    expect(parse(mainLoopBody({ metadata: { user_id: `user_abc_account__session_${OTHER_SESSION}` } })).sessionId).toBe(
      OTHER_SESSION,
    );
    expect(parse(mainLoopBody({ metadata: {} })).sessionId).toBeNull();
    // The header wins over the metadata.
    expect(parse(mainLoopBody(), { 'x-claude-code-session-id': OTHER_SESSION }).sessionId).toBe(OTHER_SESSION);
  });

  test('a first request has no tool result, and its prompt is a user text', () => {
    const request = parse({
      model: 'claude-sonnet-5-5',
      system: 'plain system text',
      tools: TOOLS,
      messages: [{ role: 'user', content: 'Start the task.' }],
    });
    expect(request.system).toBe('plain system text');
    expect(request.stream).toBe(false);
    expect(request.lastToolResult).toBeNull();
    expect(request.toolResults).toEqual([]);
    expect(request.userTexts).toEqual(['Start the task.']);
    expect(request.messages[0]?.blocks).toEqual([{ type: 'text', text: 'Start the task.' }]);
  });

  test('a new prompt after an earlier tool call is not a tool result', () => {
    const body = mainLoopBody();
    const messages = [
      ...(body.messages as unknown[]),
      { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
      { role: 'user', content: [{ type: 'text', text: 'SECOND-PROMPT' }] },
    ];
    const request = parse({ ...body, messages });
    expect(request.lastToolResult).toBeNull();
    expect(request.userTexts).toEqual(['SECOND-PROMPT']);
  });

  test('keeps unknown blocks by kind, and an error tool result says so', () => {
    const request = parse({
      model: 'm',
      messages: [
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'hm', signature: 's' }] },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_x', is_error: true, content: [{ type: 'image' }] },
          ],
        },
      ],
    });
    expect(request.messages[0]?.blocks).toEqual([{ type: 'other', kind: 'thinking' }]);
    expect(request.lastToolResult).toEqual({ toolUseId: 'toolu_x', text: '', isError: true });
  });

  test('tolerates a body that is not a Messages request', () => {
    const request = parseAnthropicRequest(null, {}, '/v1/models');
    expect(request).toMatchObject({
      endpoint: 'other',
      sessionId: null,
      model: null,
      system: '',
      messages: [],
      tools: [],
      lastToolResult: null,
      userTexts: [],
      mainLoop: false,
      compaction: false,
    });
    expect(parseAnthropicRequest({}, {}, '/v1/messages/count_tokens').endpoint).toBe('count_tokens');
  });
});

describe('main loop and compaction', () => {
  test('a request offering the session tools is the main loop; one without tools is auxiliary', () => {
    expect(isMainLoop(parse(mainLoopBody()))).toBe(true);
    const title = parse({
      model: 'claude-haiku-5-5',
      system: [{ type: 'text', text: 'Generate a concise, sentence-case title for this conversation.' }],
      messages: [{ role: 'user', content: 'Start the task.' }],
    });
    expect(title.mainLoop).toBe(false);
    expect(isMainLoop(title)).toBe(false);
    const counted = parseAnthropicRequest(mainLoopBody(), {}, '/v1/messages/count_tokens');
    expect(counted.mainLoop).toBe(false);
  });

  test('the compaction prompt makes a request a compaction, never the main loop', () => {
    const body = mainLoopBody();
    const messages = [
      ...(body.messages as unknown[]),
      { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
      {
        role: 'user',
        content:
          'CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.\n\nYour task is to create a detailed summary of the conversation so far, paying close attention to the user\'s explicit requests and your previous actions.',
      },
    ];
    const request = parse({ ...body, messages });
    expect(isCompaction(request)).toBe(true);
    expect(request.compaction).toBe(true);
    expect(request.mainLoop).toBe(false);
    expect(isCompaction(parse(mainLoopBody()))).toBe(false);
  });
});

describe('reply builders', () => {
  test('build content blocks', () => {
    expect(text('hello')).toEqual({ type: 'text', text: 'hello' });
    expect(toolUse('Read', { file_path: '/x' }, { id: 'toolu_read_1' })).toEqual({
      type: 'tool_use',
      id: 'toolu_read_1',
      name: 'Read',
      input: { file_path: '/x' },
    });
    expect(toolUse('Glob', { pattern: '*' }).id).toMatch(/^toolu_[A-Za-z0-9]{24}$/);
    expect(toolUse('Glob', { pattern: '*' }).id).not.toBe(toolUse('Glob', { pattern: '*' }).id);
    expect(bashTool({ command: 'bun test', timeoutMs: 60_000, id: 'toolu_b' })).toEqual({
      type: 'tool_use',
      id: 'toolu_b',
      name: 'Bash',
      input: { command: 'bun test', description: 'Run a scripted command', timeout: 60_000 },
    });
    expect(bashTool({ command: 'ls', description: 'List files', id: 'toolu_c' }).input).toEqual({
      command: 'ls',
      description: 'List files',
    });
    expect(agflowTool({ tool: 'submit', args: { summary: 's' }, id: 'toolu_s' })).toEqual({
      type: 'tool_use',
      id: 'toolu_s',
      name: 'mcp__agflow__submit',
      input: { summary: 's' },
    });
    expect(agflowTool({ tool: 'get_goal', id: 'toolu_g' }).input).toEqual({});
  });

  test('reply sets the stop reason from its content, and the usage', () => {
    expect(reply('done')).toEqual({
      kind: 'message',
      content: [{ type: 'text', text: 'done' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 100, outputTokens: 10 },
      headers: {},
    });
    const call = reply([text('Running.'), bashTool({ command: 'ls', id: 'toolu_1' })], { inputTokens: 150_000 });
    expect(call.stopReason).toBe('tool_use');
    expect(call.usage.inputTokens).toBe(150_000);
    expect(reply(text('x'), { headers: { 'anthropic-ratelimit-unified-status': 'allowed' } }).headers).toEqual({
      'anthropic-ratelimit-unified-status': 'allowed',
    });
    expect(reply('x', { stopReason: 'max_tokens' }).stopReason).toBe('max_tokens');
  });

  test('refusal ends with stop_reason refusal', () => {
    expect(refusal()).toMatchObject({ kind: 'message', content: [], stopReason: 'refusal' });
    expect(refusal('I cannot help with that.')).toMatchObject({
      content: [{ type: 'text', text: 'I cannot help with that.' }],
      stopReason: 'refusal',
    });
  });

  test('fail builds the API statuses, error bodies and headers', () => {
    expect(fail(429)).toEqual({
      kind: 'error',
      status: 429,
      body: { type: 'error', error: { type: 'rate_limit_error', message: expect.any(String) } },
      headers: { 'retry-after': '1' },
    });
    expect(fail(429, { retryAfterSeconds: 30 }).headers['retry-after']).toBe('30');
    expect(fail(529).body.error.type).toBe('overloaded_error');
    expect(fail(500).body.error.type).toBe('api_error');
    expect(fail(401).body.error.type).toBe('authentication_error');
    expect(fail(400).body.error).toEqual({
      type: 'invalid_request_error',
      message: expect.stringMatching(/^prompt is too long: \d+ tokens > \d+ maximum$/),
    });
    expect(fail(500, { message: 'boom', headers: { 'x-should-retry': 'false' } })).toMatchObject({
      body: { error: { message: 'boom' } },
      headers: { 'x-should-retry': 'false' },
    });
    expect(() => fail(418)).toThrow('no API error type for status 418');
  });

  test('hold wraps a reply behind a gate', () => {
    const inner = reply('late');
    expect(hold('after-delivery', inner)).toEqual({ kind: 'hold', gate: 'after-delivery', then: inner });
  });
});

describe('encoding', () => {
  test('encodeSse emits the event stream of a reply', () => {
    const input = { command: 'echo "a long enough command to be split into several json chunks"' };
    const calling = reply([text('Running it.'), bashTool({ ...input, id: 'toolu_9' })], { inputTokens: 42 });
    const encoded = encodeSse(calling, { id: 'msg_1', model: 'claude-sonnet-5-5' });
    const events = [...encoded.matchAll(/^event: (\S+)\ndata: (.*)\n\n/gm)].map((match) => ({
      event: match[1],
      data: JSON.parse(match[2] ?? 'null'),
    }));
    // Nothing but whole events.
    expect(events.map((event) => `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`).join('')).toBe(
      encoded,
    );
    for (const event of events) expect(event.data.type).toBe(event.event);
    const names = events.map((event) => event.event);
    expect(names[0]).toBe('message_start');
    expect(names.slice(-2)).toEqual(['message_delta', 'message_stop']);
    expect(events[0]?.data.message).toMatchObject({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-5-5',
      content: [],
      stop_reason: null,
      usage: { input_tokens: 42 },
    });
    const starts = events.filter((event) => event.event === 'content_block_start').map((event) => event.data);
    expect(starts).toEqual([
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'toolu_9', name: 'Bash', input: {} },
      },
    ]);
    const deltas = events.filter((event) => event.event === 'content_block_delta').map((event) => event.data);
    const textDeltas = deltas.filter((delta) => delta.index === 0).map((delta) => delta.delta);
    expect(textDeltas.every((delta) => delta.type === 'text_delta')).toBe(true);
    expect(textDeltas.map((delta) => delta.text).join('')).toBe('Running it.');
    const jsonDeltas = deltas.filter((delta) => delta.index === 1).map((delta) => delta.delta);
    expect(jsonDeltas.length).toBeGreaterThan(1);
    expect(jsonDeltas.every((delta) => delta.type === 'input_json_delta')).toBe(true);
    expect(JSON.parse(jsonDeltas.map((delta) => delta.partial_json).join(''))).toEqual({
      command: input.command,
      description: 'Run a scripted command',
    });
    // Each block's start, deltas and stop come in turn.
    expect(
      events.map((event) => (event.data.index === undefined ? event.event : `${event.event}:${event.data.index}`)),
    ).toEqual([
      'message_start',
      'content_block_start:0',
      ...textDeltas.map(() => 'content_block_delta:0'),
      'content_block_stop:0',
      'content_block_start:1',
      ...jsonDeltas.map(() => 'content_block_delta:1'),
      'content_block_stop:1',
      'message_delta',
      'message_stop',
    ]);
    expect(events.at(-2)?.data).toMatchObject({
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { input_tokens: 42, output_tokens: 10 },
    });
  });

  test('encodeMessage gives the same reply as one JSON message', () => {
    const message = encodeMessage(reply([text('hi'), toolUse('Read', { file_path: '/x' }, { id: 'toolu_r' })]), {
      id: 'msg_2',
      model: 'claude-sonnet-5-5',
    });
    expect(message).toEqual({
      id: 'msg_2',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-5-5',
      content: [
        { type: 'text', text: 'hi' },
        { type: 'tool_use', id: 'toolu_r', name: 'Read', input: { file_path: '/x' } },
      ],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    });
  });

  test('a text with characters outside the basic plane survives chunking', () => {
    const value = `${'🙂'.repeat(40)} done`;
    const encoded = encodeSse(reply(value), { id: 'msg_3', model: 'm' });
    const pieces = [...encoded.matchAll(/^data: (.*)$/gm)]
      .map((match) => JSON.parse(match[1] ?? 'null'))
      .filter((data) => data.type === 'content_block_delta')
      .map((data) => data.delta.text as string);
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) expect(piece.isWellFormed()).toBe(true);
    expect(pieces.join('')).toBe(value);
  });
});

describe('rules', () => {
  const first = parse(mainLoopBody());
  const other = parse(mainLoopBody({ metadata: { user_id: JSON.stringify({ session_id: OTHER_SESSION }) } }));

  test('matchers read the request content', () => {
    expect(inSession(SESSION)(first)).toBe(true);
    expect(inSession(SESSION)(other)).toBe(false);
    expect(afterToolResult('toolu_bash_2')(first)).toBe(true);
    // Only the newest tool results count: an earlier call's result is history.
    expect(afterToolResult('toolu_goal_1')(first)).toBe(false);
    expect(userSays('MIDTURN-MSG')(first)).toBe(true);
    expect(userSays('Start the task.')(first)).toBe(false);
    expect(briefHas('BRIEF-MARKER-K7')(first)).toBe(true);
    expect(briefHas("built on Anthropic's")(first)).toBe(true);
    expect(briefHas('goal: ship it')(first)).toBe(true);
    expect(briefHas('NOT-THERE')(first)).toBe(false);
  });

  test('picks the first rule whose matchers all hold', () => {
    const handler = rules(
      { when: [inSession(OTHER_SESSION), afterToolResult('toolu_bash_2')], reply: reply('other session') },
      { when: afterToolResult('toolu_bash_2'), reply: (request) => reply(`after bash in ${request.sessionId}`) },
      { when: briefHas('BRIEF-MARKER-K7'), reply: reply('brief') },
    );
    expect(handler(first)).toEqual(reply(`after bash in ${SESSION}`));
    expect(handler(other)).toEqual(reply('other session'));
    const fresh = parse({
      model: 'm',
      tools: TOOLS,
      messages: [{ role: 'user', content: 'BRIEF-MARKER-K7 begin' }],
    });
    expect(handler(fresh)).toEqual(reply('brief'));
    expect(handler(parse({ model: 'm', tools: TOOLS, messages: [{ role: 'user', content: 'x' }] }))).toBeUndefined();
  });

  test('leave auxiliary requests to the server default', () => {
    const handler = rules({ when: briefHas('BRIEF-MARKER-K7'), reply: reply('brief') });
    const title = parse({ model: 'm', messages: [{ role: 'user', content: 'BRIEF-MARKER-K7' }] });
    expect(handler(title)).toBeUndefined();
  });
});
