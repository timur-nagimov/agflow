import { afterEach, describe, expect, test } from 'bun:test';
import {
  type ResponsesRequest,
  type ResponsesServer,
  reply,
  rules,
  startResponsesServer,
  toolSurface,
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

interface Turn {
  threadId?: string;
  brief?: string;
  cwd?: string;
  user?: string[];
  /** Items after the last user message: tool calls and their outputs. */
  after?: Record<string, unknown>[];
  headers?: Record<string, string>;
  metadataOnly?: boolean;
  /** client_metadata.thread_id when it differs from the headers' thread id. */
  metadataThreadId?: string;
}

const developer = (...texts: string[]) => ({
  type: 'message',
  role: 'developer',
  content: texts.map((text) => ({ type: 'input_text', text })),
});
const user = (text: string) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const context = (cwd: string) => user(`<environment_context>\n  <cwd>${cwd}</cwd>\n</environment_context>`);

/** A request body shaped like Codex 0.159.2's, as the 2026-10-28 probes recorded it. */
function body(turn: Turn): Record<string, unknown> {
  const threadId = turn.threadId ?? 'thread-a';
  return {
    model: 'gpt-6.1-sol',
    stream: true,
    tool_choice: 'auto',
    parallel_tool_calls: true,
    client_metadata: { session_id: threadId, thread_id: turn.metadataThreadId ?? threadId, turn_id: 'turn-1' },
    input: [
      {
        type: 'additional_tools',
        role: 'developer',
        tools: [
          {
            type: 'namespace',
            name: 'functions',
            tools: [
              {
                type: 'custom',
                name: 'exec',
                description:
                  'Run JavaScript\n\n### `apply_patch`\nEdit files.\n\n### `exec_command`\nRuns a command.\n\n' +
                  '### `write_stdin`\nWrites characters.\n\n## clock\n\n### `clock__curr_time`\nThe time.',
              },
              { type: 'function', name: 'wait' },
            ],
          },
          { type: 'namespace', name: 'collaboration', tools: [{ type: 'function', name: 'spawn_agent' }] },
        ],
      },
      developer('You are Codex, an agent based on GPT-6.'),
      developer(turn.brief ?? 'BRIEF', '<skills_instructions>\n## Skills\n</skills_instructions>'),
      developer('<multi_agent_mode>no</multi_agent_mode>'),
      context(turn.cwd ?? '/private/tmp/clone'),
      ...(turn.user ?? ['hello']).map(user),
      ...(turn.after ?? []),
    ],
  };
}

function headersOf(turn: Turn): Record<string, string> {
  const threadId = turn.threadId ?? 'thread-a';
  return {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    ...(turn.metadataOnly ? {} : { 'session-id': threadId, 'thread-id': threadId }),
    ...turn.headers,
  };
}

/** Posts a turn's request and gives the parsed SSE events. */
async function post(target: ResponsesServer, turn: Turn = {}): Promise<{ response: Response; events: SseEvent[] }> {
  const response = await fetch(`${target.url}/responses`, {
    method: 'POST',
    headers: headersOf(turn),
    body: JSON.stringify(body(turn)),
  });
  return { response, events: parseSse(await response.text()) };
}

interface SseEvent {
  event: string;
  data: Record<string, any>;
}

function parseSse(text: string): SseEvent[] {
  return text
    .split('\n\n')
    .filter((block) => block.trim())
    .map((block) => {
      const event = block.match(/^event: (.*)$/m)?.[1] ?? '';
      const data = JSON.parse(block.match(/^data: (.*)$/m)?.[1] ?? '{}');
      return { event, data };
    });
}

/** The output items of a streamed reply, as response.completed lists them. */
function outputOf(events: SseEvent[]): Record<string, any>[] {
  return events.find((event) => event.event === 'response.completed')?.data.response.output ?? [];
}

const callOutput = (callId: string, text: string) => ({
  type: 'custom_tool_call_output',
  call_id: callId,
  output: [
    { type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' },
    { type: 'input_text', text },
  ],
});

describe('startResponsesServer', () => {
  test('streams a text reply as the Responses API does', async () => {
    const scripted = await server();
    expect(scripted.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    scripted.setHandler(() => reply.text('scripted answer'));
    const { response, events } = await post(scripted);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toStartWith('text/event-stream');
    expect(events.map((event) => event.event)).toEqual([
      'response.created',
      'response.output_item.added',
      'response.output_text.delta',
      'response.output_item.done',
      'response.completed',
    ]);
    for (const event of events) expect(event.data.type).toBe(event.event);
    expect(events[2]?.data.delta).toBe('scripted answer');
    const [message] = outputOf(events);
    expect(message).toMatchObject({
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'scripted answer', annotations: [] }],
    });
    expect(events[4]?.data.response).toMatchObject({
      status: 'completed',
      usage: { input_tokens: expect.any(Number), output_tokens: expect.any(Number), total_tokens: expect.any(Number) },
    });
    expect(events[0]?.data.response.id).toBe(events[4]?.data.response.id);
  });

  test('parses each request into a ResponsesRequest, in arrival order', async () => {
    const scripted = await server();
    await post(scripted, {
      threadId: 'thread-a',
      metadataThreadId: 'thread-metadata-a',
      brief: 'AGFLOW BRIEF A',
      cwd: '/private/tmp/a',
      user: ['first'],
    });
    await post(scripted, {
      threadId: 'thread-b',
      metadataThreadId: 'thread-metadata-b',
      user: ['a person', 'steered in'],
      after: [
        // A newer environment context, as after a turn in another directory.
        context('/private/tmp/b-newer'),
        { type: 'custom_tool_call', call_id: 'call-1', name: 'exec', input: 'text(1)' },
        callOutput('call-1', '{"exit_code":0,"output":"hi\\n"}'),
      ],
      headers: { 'thread-id': '', 'session-id': 'thread-b' },
    });
    await post(scripted, {
      threadId: 'thread-c',
      user: [],
      after: [{ type: 'function_call_output', name: 'agent_message', namespace: 'agflow', output: 'from A-3: hi' }],
      metadataOnly: true,
    });
    const [a, b, c] = scripted.requests as [ResponsesRequest, ResponsesRequest, ResponsesRequest];
    expect(scripted.requests.map((request) => request.index)).toEqual([0, 1, 2]);
    expect(a).toMatchObject({
      method: 'POST',
      path: '/v1/responses',
      model: 'gpt-6.1-sol',
      threadId: 'thread-a',
      instructions: 'AGFLOW BRIEF A',
      cwd: '/private/tmp/a',
      lastUserText: 'first',
      toolOutputs: [],
      toolOutputsSinceUser: 0,
      unmatched: true,
    });
    expect(a.inputKinds).toEqual([
      'additional_tools',
      'message:developer',
      'message:developer',
      'message:developer',
      'message:user',
      'message:user',
    ]);
    expect(a.headers['thread-id']).toBe('thread-a');
    expect(a.body.model).toBe('gpt-6.1-sol');
    // The headers win over client_metadata, and session-id stands in for an empty thread-id.
    expect(b).toMatchObject({
      threadId: 'thread-b',
      cwd: '/private/tmp/b-newer',
      lastUserText: 'steered in',
      toolOutputsSinceUser: 1,
    });
    expect(b.toolOutputs).toEqual([
      {
        type: 'custom_tool_call_output',
        callId: 'call-1',
        name: null,
        output: 'Script completed\nWall time 0.1 seconds\nOutput:\n\n{"exit_code":0,"output":"hi\\n"}',
        parts: ['Script completed\nWall time 0.1 seconds\nOutput:\n', '{"exit_code":0,"output":"hi\\n"}'],
      },
    ]);
    // An agent's message arrives as a tool output without a call, and no user text precedes it.
    expect(c).toMatchObject({ threadId: 'thread-c', lastUserText: null, toolOutputsSinceUser: 1 });
    expect(c.toolOutputs).toEqual([
      {
        type: 'function_call_output',
        callId: null,
        name: 'agent_message',
        output: 'from A-3: hi',
        parts: ['from A-3: hi'],
      },
    ]);
  });

  test('a later handler answers every later request', async () => {
    const scripted = await server();
    const seen: string[] = [];
    scripted.setHandler((request) => {
      seen.push(request.lastUserText ?? '');
      return reply.text(`echo ${request.lastUserText}`);
    });
    expect(outputOf((await post(scripted, { user: ['one'] })).events)[0]?.content[0].text).toBe('echo one');
    scripted.setHandler(async () => reply.text('second handler'));
    expect(outputOf((await post(scripted, { user: ['two'] })).events)[0]?.content[0].text).toBe('second handler');
    expect(seen).toEqual(['one']);
    expect(scripted.requests.map((request) => request.unmatched)).toEqual([false, false]);
  });

  test('without a handler, or when it answers nothing, a request gets the default text and is flagged', async () => {
    const scripted = await server();
    const first = outputOf((await post(scripted)).events);
    scripted.setHandler((request) => (request.lastUserText === 'known' ? reply.text('known') : undefined));
    const second = outputOf((await post(scripted, { user: ['unknown'] })).events);
    await post(scripted, { user: ['known'] });
    expect(first.map(({ id: _id, ...item }) => item)).toEqual(second.map(({ id: _id, ...item }) => item));
    expect(first[0]).toMatchObject({ type: 'message', content: [{ type: 'output_text', text: expect.any(String) }] });
    expect(scripted.requests.map((request) => request.unmatched)).toEqual([true, true, false]);
  });

  test('GET requests get an empty model list; other POST paths get 404 and invalid JSON 400', async () => {
    const scripted = await server();
    const models = await fetch(`${scripted.url}/models?client_version=0.159.2`);
    expect(models.status).toBe(200);
    expect(await models.json()).toEqual({ object: 'list', data: [], models: [] });
    const other = await fetch(`${scripted.url}/chat/completions`, { method: 'POST', body: '{}' });
    expect(other.status).toBe(404);
    const invalid = await fetch(`${scripted.url}/responses`, { method: 'POST', body: 'not json' });
    expect(invalid.status).toBe(400);
    expect(scripted.requests).toEqual([]);
  });

  test('toolSurface lists the namespaces, their tools and the nested Code Mode tools', async () => {
    const scripted = await server();
    await post(scripted);
    expect(toolSurface(scripted.requests[0] as ResponsesRequest)).toEqual({
      namespaces: [
        { name: 'functions', tools: ['exec', 'wait'] },
        { name: 'collaboration', tools: ['spawn_agent'] },
      ],
      nested: ['apply_patch', 'exec_command', 'write_stdin', 'clock__curr_time'],
    });
  });
});

describe('rules', () => {
  const handler = rules([
    { threadId: 'thread-x', reply: reply.text('thread x') },
    { marker: 'AGENT-A', toolOutputs: 0, reply: reply.shell({ cmd: 'make test', callId: 'call-a' }) },
    { marker: 'AGENT-A', toolOutputs: 1, reply: (request) => reply.text(`A saw ${request.toolOutputs.length}`) },
    { marker: 'AGENT-B', reply: reply.text('B') },
  ]);

  test('match a brief or user-text marker, a thread id and the tool outputs since the user', async () => {
    const scripted = await server();
    scripted.setHandler(handler);
    const shell = outputOf((await post(scripted, { threadId: 't1', brief: 'You are AGENT-A' })).events);
    expect(shell[0]).toMatchObject({ type: 'custom_tool_call', name: 'exec', call_id: 'call-a' });
    const after = outputOf(
      (
        await post(scripted, {
          threadId: 't1',
          brief: 'You are AGENT-A',
          after: [{ type: 'custom_tool_call', call_id: 'call-a' }, callOutput('call-a', 'done')],
        })
      ).events,
    );
    expect(after[0]?.content[0].text).toBe('A saw 1');
    const b = outputOf((await post(scripted, { threadId: 't2', user: ['ask AGENT-B'] })).events);
    expect(b[0]?.content[0].text).toBe('B');
    const x = outputOf((await post(scripted, { threadId: 'thread-x', user: ['AGENT-B'] })).events);
    expect(x[0]?.content[0].text).toBe('thread x');
    await post(scripted, { threadId: 't3', brief: 'AGENT-A', after: [callOutput('1', 'x'), callOutput('2', 'y')] });
    expect(scripted.requests.map((request) => request.unmatched)).toEqual([false, false, false, false, true]);
  });

  test('a user message after tool outputs, as a steer mid-turn, starts the count again', async () => {
    const scripted = await server();
    scripted.setHandler(handler);
    const { events } = await post(scripted, {
      threadId: 't1',
      brief: 'You are AGENT-A',
      user: ['go'],
      after: [
        { type: 'custom_tool_call', call_id: 'call-a', name: 'exec', input: 'text(1)' },
        callOutput('call-a', 'first'),
        user('steered'),
        { type: 'custom_tool_call', call_id: 'call-b', name: 'exec', input: 'text(2)' },
        callOutput('call-b', 'second'),
      ],
    });
    const [request] = scripted.requests as [ResponsesRequest];
    expect(request).toMatchObject({ lastUserText: 'steered', toolOutputsSinceUser: 1 });
    expect(request.toolOutputs.map((output) => output.callId)).toEqual(['call-a', 'call-b']);
    expect(outputOf(events)[0]?.content[0].text).toBe('A saw 2');
  });

  test('two threads interleaved in either order get the same answers', async () => {
    const a = (outputs: number): Turn => ({
      threadId: 'ta',
      brief: 'AGENT-A',
      after: outputs ? [{ type: 'custom_tool_call', call_id: 'call-a' }, callOutput('call-a', 'ok')] : [],
    });
    const b: Turn = { threadId: 'tb', brief: 'AGENT-B' };
    const answers = async (order: Turn[]) => {
      const scripted = await server();
      scripted.setHandler(handler);
      const byTurn: Record<string, unknown[]> = {};
      for (const turn of order) {
        const items = outputOf((await post(scripted, turn)).events).map(({ id: _id, ...item }) => item);
        byTurn[`${turn.threadId}:${turn.after?.length ?? 0}`] = items;
      }
      return byTurn;
    };
    const expected = await answers([a(0), a(1), b]);
    expect(Object.keys(expected).sort()).toEqual(['ta:0', 'ta:2', 'tb:0']);
    expect(await answers([a(0), b, a(1)])).toEqual(expected);
    expect(await answers([b, a(1), a(0)])).toEqual(expected);
  });
});

describe('reply builders', () => {
  /** Runs a Code Mode exec script with fake tools, as codex-code-mode-host would. */
  async function runScript(source: string, tools: Record<string, (args: any) => Promise<unknown>>): Promise<unknown[]> {
    const texts: unknown[] = [];
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
    await new AsyncFunction('tools', 'text', source)(tools, (value: unknown) => texts.push(value));
    return texts;
  }

  function single(built: ReturnType<typeof reply.text>): Record<string, any> {
    expect(built.kind).toBe('stream');
    const items = built.kind === 'stream' ? built.output : [];
    expect(items).toHaveLength(1);
    return items[0] as Record<string, any>;
  }

  test('shell runs exec_command in one exec call and polls write_stdin until the command exits', async () => {
    const item = single(reply.shell({ cmd: `echo "it's" > out.txt`, timeoutMs: 45_000, callId: 'call-sh' }));
    expect(item).toMatchObject({ type: 'custom_tool_call', name: 'exec', call_id: 'call-sh' });
    const source = item.input as string;
    const pragma = source.split('\n')[0] as string;
    expect(pragma).toMatch(/^\/\/ @exec: \{.*\}$/);
    expect(JSON.parse(pragma.slice('// @exec: '.length)).yield_time_ms).toBeGreaterThanOrEqual(45_000);
    const calls: [string, any][] = [];
    const texts = await runScript(source, {
      exec_command: async (args) => {
        calls.push(['exec_command', args]);
        return { session_id: 7, output: 'one ', wall_time_seconds: 30 };
      },
      write_stdin: async (args) => {
        calls.push(['write_stdin', args]);
        return calls.length < 3
          ? { session_id: 7, output: 'two ', wall_time_seconds: 5 }
          : { exit_code: 0, output: 'three', wall_time_seconds: 1 };
      },
    });
    expect(calls[0]).toEqual(['exec_command', { cmd: `echo "it's" > out.txt`, yield_time_ms: 30_000 }]);
    expect(calls.slice(1).map(([name, args]) => [name, args.session_id, args.chars])).toEqual([
      ['write_stdin', 7, ''],
      ['write_stdin', 7, ''],
    ]);
    expect(texts).toEqual([{ exit_code: 0, output: 'one two three', wall_time_seconds: 1 }]);
  });

  test('live-like shell polls the exec session with inbox checks between waits', async () => {
    const source = single(reply.shell({ cmd: 'bun test', timeoutMs: 60_000, pollInbox: true })).input as string;
    const calls: string[] = [];
    let polls = 0;
    const output = await runScript(source, {
      exec_command: async args => {
        expect(args.yield_time_ms).toBe(1000);
        calls.push('start');
        return { session_id: 32054, output: '' };
      },
      mcp__agflow__check_inbox: async () => { calls.push('inbox'); return { message: 'owner update' }; },
      write_stdin: async args => {
        expect(args).toEqual({ session_id: 32054, chars: '', yield_time_ms: 1000 });
        calls.push('poll');
        return ++polls < 5 ? { session_id: 32054, output: '' } : { exit_code: 0, output: 'done' };
      },
    });
    expect(calls).toEqual(['start', ...Array.from({ length: 5 }, () => ['inbox', 'poll']).flat()]);
    expect(output).toEqual([...Array.from({ length: 5 }, () => ({ message: 'owner update' })), { exit_code: 0, output: 'done' }]);
  });

  test('shell stops polling at timeoutMs and reports the command still running', async () => {
    const source = single(reply.shell({ cmd: 'sleep 100', timeoutMs: 300, callId: 'c' })).input as string;
    let polls = 0;
    const texts = await runScript(source, {
      exec_command: async (args) => {
        expect(args.yield_time_ms).toBe(300);
        return { session_id: 3, output: '', wall_time_seconds: 0.3 };
      },
      write_stdin: async () => {
        polls += 1;
        await Bun.sleep(50);
        return { session_id: 3, output: '', wall_time_seconds: 0.05 };
      },
    });
    expect(texts).toEqual([{ session_id: 3, output: '', wall_time_seconds: expect.any(Number) }]);
    expect(polls).toBeLessThan(20);
  });

  test('shell with escalate asks for an unsandboxed run with its justification', async () => {
    const source = single(
      reply.shell({ cmd: 'curl -sS https://example.com', escalate: { justification: 'needs "network"' }, callId: 'c' }),
    ).input as string;
    const calls: any[] = [];
    await runScript(source, {
      exec_command: async (args) => {
        calls.push(args);
        return { exit_code: 0, output: '', wall_time_seconds: 0 };
      },
      write_stdin: async () => ({}),
    });
    expect(calls).toEqual([
      {
        cmd: 'curl -sS https://example.com',
        sandbox_permissions: 'require_escalated',
        justification: 'needs "network"',
        yield_time_ms: 30_000,
      },
    ]);
  });

  test('mcp calls the agflow tool with its arguments', async () => {
    const mcp = single(reply.mcp({ tool: 'write_handoff', args: { note: 'it\'s "done"' }, callId: 'call-m' }));
    expect(mcp).toMatchObject({ type: 'custom_tool_call', name: 'exec', call_id: 'call-m' });
    const seen: unknown[] = [];
    const texts = await runScript(mcp.input, {
      mcp__agflow__write_handoff: async (args) => {
        seen.push(args);
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    });
    expect(seen).toEqual([{ note: 'it\'s "done"' }]);
    expect(texts).toEqual([{ content: [{ type: 'text', text: 'ok' }] }]);
    expect(() => reply.mcp({ tool: 'bad-name()', args: {} })).toThrow('not a tool name');
  });

  test('patch, code and functionCall', async () => {
    const patchText = '*** Begin Patch\n*** Add File: a.txt\n+hi\n*** End Patch\n';
    const patch = single(reply.patch(patchText, { callId: 'call-p' }));
    expect(patch).toMatchObject({ type: 'custom_tool_call', name: 'exec', call_id: 'call-p' });
    const patches: unknown[] = [];
    await runScript(patch.input, {
      apply_patch: async (input) => {
        patches.push(input);
        return 'Done!';
      },
    });
    expect(patches).toEqual([patchText]);

    expect(single(reply.code('text(1 + 1);', { callId: 'call-e' }))).toMatchObject({
      type: 'custom_tool_call',
      name: 'exec',
      call_id: 'call-e',
      input: 'text(1 + 1);',
    });
    expect(single(reply.functionCall({ name: 'wait', args: { ms: 5 }, callId: 'call-f' }))).toMatchObject({
      type: 'function_call',
      name: 'wait',
      arguments: '{"ms":5}',
      call_id: 'call-f',
    });
    expect(single(reply.functionCall({ name: 'spawn_agent', namespace: 'collaboration', args: {} }))).toEqual({
      type: 'function_call',
      name: 'spawn_agent',
      namespace: 'collaboration',
      arguments: '{}',
    });
  });

  test('a call without a call id gets a fresh one each time it is streamed', async () => {
    const scripted = await server();
    const shared = reply.mcp({ tool: 'hello', args: {} });
    scripted.setHandler(() => shared);
    const first = outputOf((await post(scripted)).events)[0];
    const second = outputOf((await post(scripted)).events)[0];
    expect(first?.call_id).toMatch(/^call_\w+$/);
    expect(second?.call_id).toMatch(/^call_\w+$/);
    expect(first?.call_id).not.toBe(second?.call_id);
    expect(first?.id).not.toBe(second?.id);
  });

  test('a tool call reply streams its item without text deltas', async () => {
    const scripted = await server();
    scripted.setHandler(() => reply.shell({ cmd: 'ls', callId: 'call-ls' }));
    const { events } = await post(scripted);
    expect(events.map((event) => event.event)).toEqual([
      'response.created',
      'response.output_item.added',
      'response.output_item.done',
      'response.completed',
    ]);
    expect(events[1]?.data.item).toMatchObject({ type: 'custom_tool_call', status: 'in_progress', input: '' });
    expect(events[2]?.data.item).toMatchObject({ type: 'custom_tool_call', call_id: 'call-ls', status: 'completed' });
  });
});
