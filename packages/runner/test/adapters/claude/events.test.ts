import { describe, expect, test } from 'bun:test';
import { BRIDGE_ANSWERS } from '@agflow/core';
import { loadRecording } from '@agflow/testkit/src/fake-claude';
import { CLAUDE_TOOL_INPUT_MAX, ClaudeEventMapper } from '../../../src/adapters/claude/events';
import type { AgentEvent } from '../../../src/adapters/types';

type Frame = Record<string, unknown>;

/** The frames a recording printed in its turns, placeholders left as they are. */
function recordedFrames(scenario: string): Frame[] {
  return loadRecording(scenario)
    .turns.flat()
    .flatMap((step) => ('frame' in step ? [structuredClone(step.frame)] : []));
}

function mapAll(mapper: ClaudeEventMapper, frames: unknown[]): AgentEvent[] {
  return frames.flatMap((frame) => mapper.map(frame));
}

const init = (fields: Frame = {}): Frame => ({
  type: 'system',
  subtype: 'init',
  session_id: 'session-1',
  model: 'claude-sonnet-5-5',
  claude_code_version: '2.1.285',
  permissionMode: 'acceptEdits',
  tools: ['Bash'],
  ...fields,
});

const assistant = (content: Frame[], fields: Frame = {}): Frame => ({
  type: 'assistant',
  message: { role: 'assistant', content },
  parent_tool_use_id: null,
  session_id: 'session-1',
  ...fields,
});

const toolUse = (id: string, name: string, input: Frame = {}): Frame => ({ type: 'tool_use', id, name, input });

const toolResult = (id: string, content: unknown, isError = false, fields: Frame = {}): Frame => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] },
  parent_tool_use_id: null,
  session_id: 'session-1',
  ...fields,
});

const result = (fields: Frame = {}): Frame => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'Done.',
  stop_reason: 'end_turn',
  terminal_reason: 'completed',
  session_id: 'session-1',
  num_turns: 1,
  duration_ms: 1,
  duration_api_ms: 1,
  total_cost_usd: 0,
  usage: { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  modelUsage: {},
  permission_denials: [],
  ...fields,
});

type ToolEnded = Extract<AgentEvent, { type: 'tool_ended' }>;

/** A tool_ended: by default ok, not denied, not terminal, the hub reachable. */
const ended = (toolId: string, fields: Partial<ToolEnded> = {}): ToolEnded => ({
  type: 'tool_ended',
  toolId,
  ok: true,
  denied: false,
  terminal: null,
  hubUnreachable: false,
  ...fields,
});

const toolEnded = (events: AgentEvent[]) =>
  events.filter((event): event is ToolEnded => event.type === 'tool_ended');

describe('ClaudeEventMapper: session and turns', () => {
  test('the first system/init gives started, an init while idle turn_started, and result turn_ended', () => {
    const mapper = new ClaudeEventMapper();
    const events = mapAll(mapper, recordedFrames('turn-basic'));
    expect(events[0]).toEqual({
      type: 'started',
      sessionRef: '$SESSION',
      model: '$MODEL',
      cliVersion: '2.1.285',
      permissionMode: '$PERMISSION_MODE',
    });
    expect(events[1]).toEqual({ type: 'turn_started' });
    expect(events.at(-1)).toEqual({
      type: 'turn_ended',
      outcome: 'completed',
      toolCalls: 4,
      error: null,
      errorKind: null,
    });
    expect(events.filter((event) => event.type === 'turn_started')).toHaveLength(1);
    // The next turn's init repeats the session facts; only the first one gives started.
    const hello = assistant([{ type: 'text', text: 'Hi.' }]);
    const next = mapAll(mapper, [init({ session_id: '$SESSION' }), hello, result()]);
    expect(next).toEqual([
      { type: 'turn_started' },
      { type: 'text', text: 'Hi.' },
      { type: 'turn_ended', outcome: 'completed', toolCalls: 0, error: null, errorKind: null },
    ]);
  });

  test('without an init, the first frame of a turn starts it; frames before the first message start nothing', () => {
    const mapper = new ClaudeEventMapper();
    // The SessionStart hook's frames arrive at startup, before any message.
    const startup = loadRecording('turn-basic').startup.flatMap((step) => ('frame' in step ? [step.frame] : []));
    expect(startup.length).toBeGreaterThan(0);
    expect(mapAll(mapper, startup)).toEqual([]);
    expect(mapper.map(assistant([{ type: 'text', text: 'Working.' }]))).toEqual([
      { type: 'turn_started' },
      { type: 'text', text: 'Working.' },
    ]);
    expect(mapper.map(result())).toEqual([
      { type: 'turn_ended', outcome: 'completed', toolCalls: 0, error: null, errorKind: null },
    ]);
    // A result that finds the mapper idle is a whole turn.
    expect(mapper.map(result({ is_error: true, result: 'boom' }))).toEqual([
      { type: 'turn_started' },
      { type: 'turn_ended', outcome: 'failed', toolCalls: 0, error: 'boom', errorKind: null },
    ]);
  });

  test("an aborted turn is interrupted only while the runner's interrupt is pending", () => {
    const frames = recordedFrames('interrupt');
    const plain = mapAll(new ClaudeEventMapper(), frames).at(-1);
    expect(plain).toMatchObject({ type: 'turn_ended', outcome: 'failed', toolCalls: 1 });

    const mapper = new ClaudeEventMapper();
    const events: AgentEvent[] = [];
    for (const frame of frames) {
      events.push(...mapper.map(frame));
      if (frame.type === 'assistant') mapper.interruptRequested();
    }
    // The interrupt rejected the call in flight (non_execution_kind user-rejected): not a denial.
    expect(toolEnded(events)).toEqual([
      ended('toolu_interrupt_1', { ok: false }),
    ]);
    expect(events.at(-1)).toEqual({
      type: 'turn_ended',
      outcome: 'interrupted',
      toolCalls: 1,
      error: null,
      errorKind: null,
    });
    // The flag ends with that result: the next failure is a failure.
    const next = mapAll(mapper, [init(), result({ subtype: 'error_during_execution', is_error: true, errors: [] })]);
    expect(next.at(-1)).toMatchObject({ type: 'turn_ended', outcome: 'failed' });
  });

  test('an interrupt while idle is ignored, as the CLI ignores it; one before sent input starts counts', () => {
    const aborted = result({
      subtype: 'error_during_execution',
      is_error: true,
      errors: [],
      terminal_reason: 'model_error',
    });
    const idle = new ClaudeEventMapper();
    mapAll(idle, [init(), result()]);
    idle.interruptRequested();
    expect(mapAll(idle, [init(), aborted]).at(-1)).toMatchObject({ type: 'turn_ended', outcome: 'failed' });

    // Input the caller says it sent is a turn about to run.
    const starting = new ClaudeEventMapper();
    starting.interruptRequested({ starting: true });
    expect(mapAll(starting, [init(), aborted]).at(-1)).toMatchObject({ type: 'turn_ended', outcome: 'interrupted' });
  });

  test("the turn's last assistant error reaches classifyResult", () => {
    const mapper = new ClaudeEventMapper();
    const events = mapAll(mapper, [
      init(),
      assistant([{ type: 'text', text: 'API Error: 500 Internal server error' }], { error: 'server_error' }),
      result({ is_error: true, result: 'Request failed', terminal_reason: undefined }),
    ]);
    expect(events.at(-1)).toMatchObject({ type: 'turn_ended', outcome: 'failed', errorKind: 'vendor' });
  });
});

describe('ClaudeEventMapper: tools', () => {
  test('a main-thread tool_use gives tool_started, and its tool_result tool_ended with ok and denied', () => {
    const events = mapAll(new ClaudeEventMapper(), recordedFrames('turn-basic'));
    const started = events.filter((event) => event.type === 'tool_started');
    expect(started).toEqual([
      {
        type: 'tool_started',
        toolId: 'toolu_basic_1',
        name: 'Bash',
        input: expect.stringContaining('"command":"echo hi"'),
        command: 'echo hi',
      },
      {
        type: 'tool_started',
        toolId: 'toolu_basic_2',
        name: 'Bash',
        input: expect.stringContaining('git push origin HEAD'),
        command: 'git push origin HEAD',
      },
      {
        type: 'tool_started',
        toolId: 'toolu_basic_3',
        name: 'mcp__agflow__report_progress',
        input: '{"note":"Checked."}',
        command: null,
      },
      {
        type: 'tool_started',
        toolId: 'toolu_basic_4',
        name: 'mcp__agflow__submit',
        input: '{"summary":"Checked."}',
        command: null,
      },
    ]);
    expect(toolEnded(events)).toEqual([
      ended('toolu_basic_1'),
      // The guard refused it: 2.1.285 marks it with non_execution_kind.
      ended('toolu_basic_2', { ok: false, denied: true }),
      ended('toolu_basic_3', { ok: false, hubUnreachable: true }),
      ended('toolu_basic_4', { terminal: 'submit' }),
    ]);
  });

  test('the input is clipped JSON, and only Bash has a command', () => {
    const mapper = new ClaudeEventMapper();
    const content = 'x'.repeat(CLAUDE_TOOL_INPUT_MAX * 2);
    const events = mapAll(mapper, [
      init(),
      assistant([
        toolUse('toolu_w', 'Write', { file_path: '/clone/a.txt', content }),
        toolUse('toolu_b', 'Bash', { command: 42 }),
        toolUse('toolu_r', 'Read', { file_path: '/clone/a.txt', command: 'not a shell' }),
      ]),
    ]);
    const started = events.filter((event) => event.type === 'tool_started');
    const write = started[0] as Extract<AgentEvent, { type: 'tool_started' }>;
    expect(write.input).toHaveLength(CLAUDE_TOOL_INPUT_MAX);
    expect(write.input.startsWith('{"file_path":"/clone/a.txt","content":"xxx')).toBe(true);
    expect(write.input.endsWith('…')).toBe(true);
    expect(write.command).toBeNull();
    expect(started[1]).toMatchObject({ name: 'Bash', input: '{"command":42}', command: null });
    expect(started[2]).toMatchObject({ name: 'Read', command: null });
  });

  test('a denial without a mark is found by its permission_denied frame or, at the result, permission_denials', () => {
    const mapper = new ClaudeEventMapper();
    const events = mapAll(mapper, [
      init(),
      assistant([
        toolUse('toolu_1', 'Read', { file_path: '/x' }),
        toolUse('toolu_2', 'Bash', { command: 'gh pr list' }),
      ]),
      { type: 'system', subtype: 'permission_denied', tool_name: 'Read', tool_use_id: 'toolu_1', message: 'denied' },
      toolResult('toolu_1', 'Permission to read /x was denied.', true),
      // toolu_2 never gets a tool_result; the result names it.
      result({
        permission_denials: [{ tool_name: 'Bash', tool_use_id: 'toolu_2', tool_input: { command: 'gh pr list' } }],
      }),
    ]);
    expect(toolEnded(events)).toEqual([
      ended('toolu_1', { ok: false, denied: true }),
      ended('toolu_2', { ok: false, denied: true }),
    ]);
    // Calls still in flight end before the turn does.
    expect(events.at(-2)).toMatchObject({ type: 'tool_ended', toolId: 'toolu_2' });
    expect(events.at(-1)).toMatchObject({ type: 'turn_ended', toolCalls: 2 });
  });

  test('a call the turn left unanswered ends at the result, not denied', () => {
    const events = mapAll(new ClaudeEventMapper(), [
      init(),
      assistant([toolUse('toolu_1', 'Bash', { command: 'sleep 30' })]),
      result({ subtype: 'error_during_execution', is_error: true, errors: [], terminal_reason: 'aborted_tools' }),
    ]);
    expect(toolEnded(events)).toEqual([
      ended('toolu_1', { ok: false }),
    ]);
  });
});

describe('ClaudeEventMapper: terminal bridge tools', () => {
  const terminals = [
    [
      'mcp__agflow__submit',
      'Submission pending: the runner pushes your branch and submits it when your turn ends.',
      'submit',
    ],
    ['mcp__agflow__declare_blocked', 'The task is marked blocked.', 'blocked'],
    ['mcp__agflow__declare_impossible', 'The task is marked impossible.', 'impossible'],
    ['mcp__agflow__release_task', 'The task is released.', 'released'],
    ['mcp__agflow__write_handoff', 'Your handoff note is saved.', 'handoff'],
  ] as const;

  test('normal results of the five terminal tools are terminal', () => {
    for (const [name, text, terminal] of terminals) {
      const events = mapAll(new ClaudeEventMapper(), [
        init(),
        assistant([toolUse('toolu_t', name)]),
        // MCP results arrive as content blocks.
        toolResult('toolu_t', [{ type: 'text', text }]),
      ]);
      expect(toolEnded(events)).toEqual([
        { type: 'tool_ended', toolId: 'toolu_t', ok: true, denied: false, terminal, hubUnreachable: false },
      ]);
    }
  });

  test('an error result is never terminal, and other tools never are', () => {
    for (const [name] of terminals) {
      const refused = mapAll(new ClaudeEventMapper(), [
        init(),
        assistant([toolUse('toolu_t', name)]),
        toolResult('toolu_t', 'The task is not yours.', true),
      ]);
      expect(toolEnded(refused)).toEqual([
        ended('toolu_t', { ok: false }),
      ]);
    }
    for (const name of ['mcp__agflow__report_progress', 'submit', 'mcp__other__submit', 'mcp__agflow__submit_x']) {
      const events = mapAll(new ClaudeEventMapper(), [
        init(),
        assistant([toolUse('toolu_t', name)]),
        toolResult('toolu_t', 'OK.'),
      ]);
      expect(toolEnded(events)[0]?.terminal).toBeNull();
    }
  });

  test("an agflow error result with the hub-unreachable text sets hubUnreachable; nothing else does", () => {
    const cases: [string, unknown, boolean, boolean][] = [
      ['mcp__agflow__get_task', [{ type: 'text', text: BRIDGE_ANSWERS.hubUnreachable }], true, true],
      ['mcp__agflow__submit', BRIDGE_ANSWERS.hubUnreachable, true, true],
      // A normal result, another server or another refusal is not the bridge saying the hub is unreachable.
      ['mcp__agflow__get_task', BRIDGE_ANSWERS.hubUnreachable, false, false],
      ['mcp__other__get_task', BRIDGE_ANSWERS.hubUnreachable, true, false],
      ['Bash', BRIDGE_ANSWERS.hubUnreachable, true, false],
      ['mcp__agflow__submit', BRIDGE_ANSWERS.attemptEnded('stopped'), true, false],
    ];
    for (const [name, content, isError, hubUnreachable] of cases) {
      const events = mapAll(new ClaudeEventMapper(), [
        init(),
        assistant([toolUse('toolu_t', name)]),
        toolResult('toolu_t', content, isError),
      ]);
      expect(toolEnded(events)[0]).toMatchObject({ terminal: null, hubUnreachable });
    }
  });
});

describe('ClaudeEventMapper: text and what it ignores', () => {
  test('assistant text blocks give text; thinking and empty text give none', () => {
    const events = mapAll(new ClaudeEventMapper(), [
      init(),
      assistant([
        { type: 'thinking', thinking: 'hmm', signature: 'sig' },
        { type: 'text', text: 'First.' },
        { type: 'text', text: '' },
        { type: 'text', text: 'Second.' },
      ]),
    ]);
    expect(events.filter((event) => event.type === 'text')).toEqual([
      { type: 'text', text: 'First.' },
      { type: 'text', text: 'Second.' },
    ]);
  });

  test('frames with parent_tool_use_id give no tool events or text', () => {
    const mapper = new ClaudeEventMapper();
    const events = mapAll(mapper, [
      init(),
      assistant([toolUse('toolu_task', 'Task', { description: 'look around', prompt: 'look' })]),
      assistant([{ type: 'text', text: 'Inside.' }, toolUse('toolu_sub', 'Read', { file_path: '/x' })], {
        parent_tool_use_id: 'toolu_task',
      }),
      toolResult('toolu_sub', 'contents', false, { parent_tool_use_id: 'toolu_task' }),
      toolResult('toolu_task', [{ type: 'text', text: 'Found it.' }]),
      result(),
    ]);
    expect(events.filter((event) => event.type === 'tool_started').map((event) => event.toolId)).toEqual([
      'toolu_task',
    ]);
    expect(toolEnded(events).map((event) => event.toolId)).toEqual(['toolu_task']);
    expect(events.some((event) => event.type === 'text')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'turn_ended', toolCalls: 1 });
  });

  test('unknown frame types and malformed frames give nothing but a turn start', () => {
    const mapper = new ClaudeEventMapper();
    const junk: unknown[] = [
      null,
      'text',
      42,
      [],
      {},
      { type: 'keep_alive' },
      { type: 'something_new', payload: 1 },
      { type: 'system', subtype: 'something_new' },
      { type: 'system', subtype: 'hook_started', hook_event: 'SessionStart' },
      { type: 'system', subtype: 'session_state_changed', state: 'running' },
      { type: 'assistant' },
      { type: 'assistant', message: { content: 'not blocks' } },
      { type: 'user', message: null },
      toolResult('toolu_unknown', 'nobody asked'),
    ];
    // The first malformed assistant frame still marks a turn as running, but nothing gives more.
    expect(mapAll(mapper, junk)).toEqual([{ type: 'turn_started' }]);
    const fresh = new ClaudeEventMapper();
    expect(mapAll(fresh, junk.slice(0, 10))).toEqual([]);
  });
});

describe('ClaudeEventMapper.ended', () => {
  test('a turn the process left running ends failed with the error, its calls and tasks with it', () => {
    const mapper = new ClaudeEventMapper();
    expect(mapper.turnRunning).toBe(false);
    mapAll(mapper, [
      init(),
      assistant([toolUse('toolu_1', 'Bash', { command: 'make' }), toolUse('toolu_2', 'Read')]),
      toolResult('toolu_2', 'text'),
      { type: 'system', subtype: 'task_started', task_id: 'task-1', description: 'Explore' },
    ]);
    expect(mapper.turnRunning).toBe(true);
    mapper.interruptRequested();
    expect(mapper.ended('panic\nclaude exited with code 3')).toEqual([
      ended('toolu_1', { ok: false }),
      ended('task:task-1', { ok: false }),
      {
        type: 'turn_ended',
        outcome: 'failed',
        toolCalls: 2,
        error: 'panic\nclaude exited with code 3',
        errorKind: null,
      },
    ]);
    expect(mapper.turnRunning).toBe(false);
    expect(mapper.ended('again')).toEqual([]);
  });

  test('while idle only the sub-agent tasks in flight end', () => {
    const mapper = new ClaudeEventMapper();
    mapAll(mapper, [
      init(),
      { type: 'system', subtype: 'task_started', task_id: 'task-1', description: 'Watch' },
      result(),
    ]);
    expect(mapper.turnRunning).toBe(false);
    expect(mapper.ended('claude exited with code 0')).toEqual([ended('task:task-1', { ok: false })]);
  });
});
