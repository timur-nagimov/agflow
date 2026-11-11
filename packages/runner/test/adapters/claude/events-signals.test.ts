import { describe, expect, test } from 'bun:test';
import type { VendorQuota } from '@agflow/core';
import { loadRecording } from '@agflow/testkit/src/fake-claude';
import { ClaudeEventMapper } from '../../../src/adapters/claude/events';
import { QuotaBook } from '../../../src/adapters/claude/quota';
import type { AgentEvent } from '../../../src/adapters/types';

type Frame = Record<string, unknown>;

const NOW = 1_800_000_000_000;
const ACCOUNT = 'acct-1';

function recordedFrames(scenario: string): Frame[] {
  return loadRecording(scenario)
    .turns.flat()
    .flatMap((step) => ('frame' in step ? [structuredClone(step.frame)] : []));
}

function mapper(options: { quota?: QuotaBook; accountId?: string | null } = {}): ClaudeEventMapper {
  return new ClaudeEventMapper({ accountId: ACCOUNT, quota: new QuotaBook(() => NOW), ...options });
}

const mapAll = (events: ClaudeEventMapper, frames: unknown[]): AgentEvent[] =>
  frames.flatMap((frame) => events.map(frame));

const of = <T extends AgentEvent['type']>(events: AgentEvent[], type: T) =>
  events.filter((event): event is Extract<AgentEvent, { type: T }> => event.type === type);

const init = (fields: Frame = {}): Frame => ({
  type: 'system',
  subtype: 'init',
  session_id: 'session-1',
  model: 'claude-sonnet-5-5',
  claude_code_version: '2.1.285',
  permissionMode: 'acceptEdits',
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
  usage: { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  modelUsage: {},
  permission_denials: [],
  ...fields,
});

const assistant = (content: Frame[], fields: Frame = {}, message: Frame = {}): Frame => ({
  type: 'assistant',
  message: { role: 'assistant', model: 'claude-sonnet-5-5', content, ...message },
  parent_tool_use_id: null,
  session_id: 'session-1',
  ...fields,
});

const lifecycle = (uuid: unknown, state: unknown): Frame => ({
  type: 'command_lifecycle',
  command_uuid: uuid,
  state,
  uuid: 'frame-uuid',
  session_id: 'session-1',
});

describe('ClaudeEventMapper: deliveries and acknowledgements', () => {
  test('a message folded in at a tool boundary is delivered when it starts and acknowledged by the result', () => {
    const events = mapper();
    // The recording's message uuids, as the session would have sent them.
    events.messageSent('$USER_UUID_1', 'runner-1');
    events.messageSent('$USER_UUID_2', 'runner-2');
    const mapped = mapAll(events, recordedFrames('turn-delivery'));
    const messages = mapped.filter((event) => event.type === 'delivered' || event.type === 'acknowledged');
    expect(messages).toEqual([
      { type: 'delivered', id: 'runner-1' },
      { type: 'delivered', id: 'runner-2' },
      { type: 'acknowledged', id: 'runner-1' },
      { type: 'acknowledged', id: 'runner-2' },
    ]);
    // The second delivery came mid-turn, between the tool call and its end.
    const types = mapped.map((event) => event.type);
    expect(types.indexOf('tool_started')).toBeLessThan(types.lastIndexOf('delivered'));
    expect(types.at(-1)).toBe('turn_ended');
  });

  test('each message is delivered and acknowledged once; an acknowledgement implies the delivery', () => {
    const events = mapper();
    events.messageSent('u-1', 'm-1');
    events.messageSent('u-2', 'm-2');
    const mapped = mapAll(events, [
      lifecycle('u-1', 'queued'),
      lifecycle('u-1', 'started'),
      lifecycle('u-1', 'started'),
      init(),
      result({ user_message_uuids: ['u-1', 'u-2', 'u-1'] }),
      init(),
      result({ user_message_uuids: ['u-1', 'u-2'] }),
    ]);
    expect(mapped.filter((event) => event.type === 'delivered' || event.type === 'acknowledged')).toEqual([
      { type: 'delivered', id: 'm-1' },
      { type: 'acknowledged', id: 'm-1' },
      { type: 'delivered', id: 'm-2' },
      { type: 'acknowledged', id: 'm-2' },
    ]);
  });

  test('unknown uuids, cancelled messages and malformed lifecycle frames give nothing', () => {
    const events = mapper();
    events.messageSent('u-1', 'm-1');
    events.messageSent('u-2', 'm-2');
    const mapped = mapAll(events, [
      lifecycle('someone-else', 'started'),
      lifecycle(42, 'started'),
      lifecycle('u-1', 7),
      lifecycle('u-1', 'something_new'),
      { type: 'command_lifecycle' },
      // A stop's interrupt cancels a queued message; it never runs.
      lifecycle('u-2', 'queued'),
      lifecycle('u-2', 'cancelled'),
      init(),
      result({ user_message_uuids: ['someone-else', 'u-2', 3] }),
      result({ user_message_uuids: 'u-1' }),
    ]);
    expect(mapped.filter((event) => event.type === 'delivered' || event.type === 'acknowledged')).toEqual([]);
    // Lifecycle frames start no turn.
    expect(mapAll(mapper(), [lifecycle('u-1', 'started')])).toEqual([]);
  });
});

describe('ClaudeEventMapper: interrupts before a sent message starts', () => {
  test('a message sent and not yet delivered is a turn about to run; once delivered it is not', () => {
    const aborted = result({ subtype: 'error_during_execution', is_error: true, errors: [], terminal_reason: null });
    const queued = mapper();
    queued.messageSent('u-1', 'm-1');
    queued.interruptRequested();
    expect(mapAll(queued, [init(), aborted]).at(-1)).toMatchObject({ type: 'turn_ended', outcome: 'interrupted' });

    const delivered = mapper();
    delivered.messageSent('u-1', 'm-1');
    mapAll(delivered, [lifecycle('u-1', 'started'), init(), result({ user_message_uuids: ['u-1'] })]);
    delivered.interruptRequested();
    expect(mapAll(delivered, [init(), aborted]).at(-1)).toMatchObject({ type: 'turn_ended', outcome: 'failed' });
  });
});

describe('ClaudeEventMapper: quota', () => {
  const info = {
    status: 'allowed_warning',
    resetsAt: 1_800_003_600,
    rateLimitType: 'five_hour',
    utilization: 0.8,
    overageStatus: 'allowed',
  };

  test("rate_limit_event gives quota with the session's accountId, merged with the last one", () => {
    const book = new QuotaBook(() => NOW);
    const events = mapper({ quota: book });
    const [first] = events.map({ type: 'rate_limit_event', rate_limit_info: info, uuid: 'u', session_id: 's' });
    expect(first).toEqual({
      type: 'quota',
      accountId: ACCOUNT,
      quota: {
        state: 'ok',
        resetsAt: 1_800_003_600_000,
        windows: { fiveHour: 0.8, weekly: null },
        paidUsage: 'enabled',
        updatedAt: NOW,
      },
    });
    const weekly = { status: 'allowed', rateLimitType: 'seven_day', utilization: 0.3 };
    const [second] = events.map({ type: 'rate_limit_event', rate_limit_info: weekly });
    expect(second).toMatchObject({ quota: { windows: { fiveHour: 0.8, weekly: 0.3 }, paidUsage: 'enabled' } });
    expect(book.last(ACCOUNT)).toEqual((second as Extract<AgentEvent, { type: 'quota' }>).quota);
    // A malformed event gives nothing.
    expect(mapAll(events, [{ type: 'rate_limit_event' }, { type: 'rate_limit_event', rate_limit_info: {} }])).toEqual(
      [],
    );
  });

  test('fields of an unexpected type are unknown, not an error', () => {
    const events = mapper();
    const odd = { status: 'allowed', rateLimitType: 42, utilization: 'x', resetsAt: 'soon', overageStatus: [] };
    let mapped: AgentEvent[] = [];
    expect(() => {
      mapped = events.map({ type: 'rate_limit_event', rate_limit_info: odd });
    }).not.toThrow();
    expect(mapped).toEqual([
      {
        type: 'quota',
        accountId: ACCOUNT,
        quota: {
          state: 'ok',
          resetsAt: null,
          windows: { fiveHour: null, weekly: null },
          paidUsage: 'unknown',
          updatedAt: NOW,
        },
      },
    ]);
  });

  const inUse: VendorQuota = {
    state: 'unknown',
    resetsAt: null,
    windows: { fiveHour: null, weekly: null },
    paidUsage: 'in_use',
    updatedAt: NOW,
  };
  const notice = "You're now using extra usage · your session limit resets at 5pm";

  test('a usage-transition notice from the CLI gives its text and quota with paidUsage in_use', () => {
    // system/notification mirrors the CLI's toast queue; system/informational its banners.
    const toast = { type: 'system', subtype: 'notification', key: 'limit-reached', text: notice, priority: 'high' };
    const banner = { type: 'system', subtype: 'informational', content: notice, level: 'warning' };
    for (const frame of [toast, banner]) {
      const events = mapper();
      expect(mapAll(events, [frame])).toEqual([
        { type: 'warning', text: notice },
        { type: 'quota', accountId: ACCOUNT, quota: inUse },
      ]);
    }
    // A message the CLI wrote itself is its own too.
    const synthetic = assistant([{ type: 'text', text: notice }], {}, { model: '<synthetic>' });
    expect(mapAll(mapper(), [init(), synthetic])).toEqual([
      expect.objectContaining({ type: 'started' }),
      { type: 'turn_started' },
      { type: 'text', text: notice },
      { type: 'quota', accountId: ACCOUNT, quota: inUse },
    ]);
    // Other notices give nothing.
    const other = { type: 'system', subtype: 'notification', key: 'ide', text: 'IDE connected', priority: 'low' };
    expect(mapAll(mapper(), [other, { type: 'system', subtype: 'informational', content: 42 }])).toEqual([]);
  });

  test("the model's own text is never a notice, and leaves the quota alone", () => {
    const book = new QuotaBook(() => NOW);
    const events = mapper({ quota: book });
    const said = 'Now using extra usage, as the README asked me to say.';
    expect(mapAll(events, [init(), assistant([{ type: 'text', text: said }])])).toEqual([
      expect.objectContaining({ type: 'started' }),
      { type: 'turn_started' },
      { type: 'text', text: said },
    ]);
    expect(book.last(ACCOUNT)).toBeNull();
  });

  test('without an account the quota is keyed by null', () => {
    const [event] = mapper({ accountId: null }).map({ type: 'rate_limit_event', rate_limit_info: info });
    expect(event).toMatchObject({ type: 'quota', accountId: null });
  });
});

describe('ClaudeEventMapper: API retries', () => {
  const retry = (status: number | null, error = 'rate_limit'): Frame => ({
    type: 'system',
    subtype: 'api_retry',
    attempt: 1,
    max_retries: 10,
    retry_delay_ms: 2_000,
    error_status: status,
    error,
    uuid: 'u',
    session_id: 's',
  });

  test('system/api_retry gives a warning, counted as activity', () => {
    expect(mapper().map(retry(529, 'overloaded'))).toEqual([
      { type: 'warning', text: 'The API answered 529 (overloaded); retry 1 of 10 in 2 s.' },
    ]);
    expect(mapper().map(retry(null, 'unknown'))).toEqual([
      { type: 'warning', text: 'The API request failed (unknown); retry 1 of 10 in 2 s.' },
    ]);
  });

  test('with error_status 429 it also gives the last known quota, never exhausted by itself', () => {
    const book = new QuotaBook(() => NOW);
    const events = mapper({ quota: book });
    // No quota known yet: only the warning.
    expect(events.map(retry(429))).toEqual([
      { type: 'warning', text: 'The API answered 429 (rate_limit); retry 1 of 10 in 2 s.' },
    ]);
    const known: VendorQuota = {
      state: 'ok',
      resetsAt: null,
      windows: { fiveHour: 0.95, weekly: 0.4 },
      paidUsage: 'disabled',
      updatedAt: NOW - 60_000,
    };
    book.update(ACCOUNT, known);
    const mapped = events.map(retry(429));
    expect(mapped).toEqual([
      { type: 'warning', text: 'The API answered 429 (rate_limit); retry 1 of 10 in 2 s.' },
      { type: 'quota', accountId: ACCOUNT, quota: known },
    ]);
    expect(book.last(ACCOUNT)?.state).toBe('ok');
    expect(of(mapAll(events, [retry(500), retry(529)]), 'quota')).toEqual([]);
  });

  test('an exhaustion or paid usage the book still holds is reported as unknown, never as a limit hit', () => {
    const book = new QuotaBook(() => NOW);
    const events = mapper({ quota: book });
    const windows = { fiveHour: 1, weekly: 0.5 };
    book.update(ACCOUNT, { state: 'exhausted', resetsAt: NOW - 1, windows, paidUsage: 'disabled', updatedAt: NOW });
    expect(of(events.map(retry(429)), 'quota')).toEqual([
      {
        type: 'quota',
        accountId: ACCOUNT,
        quota: { state: 'unknown', resetsAt: NOW - 1, windows, paidUsage: 'disabled', updatedAt: NOW },
      },
    ]);
    book.update(ACCOUNT, { state: 'ok', resetsAt: null, windows, paidUsage: 'in_use', updatedAt: NOW });
    const [quota] = of(events.map(retry(429)), 'quota');
    expect(quota?.quota).toMatchObject({ state: 'ok', windows, paidUsage: 'unknown' });
    // The book keeps what it knew.
    expect(book.last(ACCOUNT)?.paidUsage).toBe('in_use');
  });
});

describe('ClaudeEventMapper: sub-agents', () => {
  test('system/task_started and task_notification give a tool in flight that starts and ends', () => {
    const events = mapper();
    const mapped = mapAll(events, [
      init(),
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'task-1',
        tool_use_id: 'toolu_task',
        description: 'Survey the tests',
        subagent_type: 'general-purpose',
        task_type: 'local_agent',
      },
      result(),
      // A backgrounded task outlives the turn that started it.
      { type: 'system', subtype: 'task_notification', task_id: 'task-1', status: 'completed', summary: 'done' },
      { type: 'system', subtype: 'task_started', task_id: 'task-2', description: 'Watch the build' },
      { type: 'system', subtype: 'task_notification', task_id: 'task-2', status: 'failed', summary: 'broke' },
    ]);
    expect(mapped.filter((event) => event.type === 'tool_started' || event.type === 'tool_ended')).toEqual([
      { type: 'tool_started', toolId: 'task:task-1', name: 'Task', input: 'Survey the tests', command: null },
      { type: 'tool_ended', toolId: 'task:task-1', ok: true, denied: false, terminal: null, hubUnreachable: false },
      { type: 'tool_started', toolId: 'task:task-2', name: 'Task', input: 'Watch the build', command: null },
      { type: 'tool_ended', toolId: 'task:task-2', ok: false, denied: false, terminal: null, hubUnreachable: false },
    ]);
  });

  test('a foreground task runs inside its Task call: one tool in flight, not two', () => {
    const events = mapper();
    const task = (status: string): Frame[] => [
      assistant([{ type: 'tool_use', id: 'toolu_t', name: 'Task', input: { description: 'Survey', prompt: 'Go' } }]),
      {
        type: 'system',
        subtype: 'task_started',
        task_id: `task-${status}`,
        tool_use_id: 'toolu_t',
        description: 'Survey',
        is_backgrounded: false,
      },
      { type: 'system', subtype: 'task_notification', task_id: `task-${status}`, status },
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_t', content: 'done' }] },
        parent_tool_use_id: null,
      },
    ];
    const mapped = mapAll(events, [init(), ...task('completed'), ...task('failed')]);
    expect(mapped.filter((event) => event.type === 'tool_started' || event.type === 'tool_ended')).toEqual([
      { type: 'tool_started', toolId: 'toolu_t', name: 'Task', input: expect.any(String), command: null },
      { type: 'tool_ended', toolId: 'toolu_t', ok: true, denied: false, terminal: null, hubUnreachable: false },
      { type: 'tool_started', toolId: 'toolu_t', name: 'Task', input: expect.any(String), command: null },
      { type: 'tool_ended', toolId: 'toolu_t', ok: true, denied: false, terminal: null, hubUnreachable: false },
    ]);
  });

  test('a foreground task moved to the background becomes a tool in flight of its own', () => {
    const mapped = mapAll(mapper(), [
      init(),
      assistant([{ type: 'tool_use', id: 'toolu_t', name: 'Task', input: {} }]),
      { type: 'system', subtype: 'task_started', task_id: 'task-1', tool_use_id: 'toolu_t', description: 'Survey' },
      { type: 'system', subtype: 'task_updated', task_id: 'task-1', patch: { is_backgrounded: true } },
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_t', content: 'backgrounded' }] },
        parent_tool_use_id: null,
      },
      { type: 'system', subtype: 'task_notification', task_id: 'task-1', status: 'completed' },
    ]);
    expect(mapped.filter((event) => event.type === 'tool_started' || event.type === 'tool_ended')).toEqual([
      { type: 'tool_started', toolId: 'toolu_t', name: 'Task', input: '{}', command: null },
      { type: 'tool_started', toolId: 'task:task-1', name: 'Task', input: '', command: null },
      { type: 'tool_ended', toolId: 'toolu_t', ok: true, denied: false, terminal: null, hubUnreachable: false },
      { type: 'tool_ended', toolId: 'task:task-1', ok: true, denied: false, terminal: null, hubUnreachable: false },
    ]);
  });

  test('ambient tasks, unknown tasks and malformed frames give nothing', () => {
    const mapped = mapAll(mapper(), [
      { type: 'system', subtype: 'task_started', task_id: 'quiet', description: 'housekeeping', skip_transcript: true },
      { type: 'system', subtype: 'task_notification', task_id: 'quiet', status: 'completed' },
      { type: 'system', subtype: 'task_started', task_id: 'watcher', description: 'watch the build', ambient: true },
      { type: 'system', subtype: 'task_notification', task_id: 'watcher', status: 'completed' },
      { type: 'system', subtype: 'task_updated', task_id: 'watcher', patch: { is_backgrounded: true } },
      { type: 'system', subtype: 'task_notification', task_id: 'never-started', status: 'completed' },
      { type: 'system', subtype: 'task_started', description: 'no id' },
      { type: 'system', subtype: 'task_notification', task_id: 'task-1' },
    ]);
    expect(mapped).toEqual([]);
  });
});

describe('ClaudeEventMapper: context', () => {
  const usage = (input: number, creation = 0, read = 0): Frame => ({
    input_tokens: input,
    output_tokens: 5,
    cache_creation_input_tokens: creation,
    cache_read_input_tokens: read,
  });
  const window = { 'claude-sonnet-5-5': { contextWindow: 1_000_000 } };
  const said = (tokens: Frame, fields: Frame = {}, message: Frame = {}) =>
    assistant([{ type: 'text', text: 'Working.' }], fields, { usage: tokens, ...message });

  test("the turn's last request over the model's context window gives context, before turn_ended", () => {
    const mapped = mapAll(mapper(), [
      init(),
      said(usage(20_000, 30_000, 50_000)),
      result({
        usage: usage(20_000, 30_000, 50_000),
        modelUsage: {
          'claude-haiku-4-5': { contextWindow: 10 },
          'claude-sonnet-5-5': { inputTokens: 20_000, contextWindow: 1_000_000 },
        },
      }),
    ]);
    expect(of(mapped, 'context')).toEqual([{ type: 'context', used: 0.1 }]);
    expect(mapped.at(-2)).toEqual({ type: 'context', used: 0.1 });
    expect(mapped.at(-1)?.type).toBe('turn_ended');
  });

  test("the result's usage sums every request of the turn, so only the last one counts", () => {
    const requests = [100_000, 200_000, 250_000, 300_000].map((read) => said(usage(1_000, 0, read - 1_000)));
    const mapped = mapAll(mapper(), [
      init(),
      ...requests,
      // A sub-agent's request and a synthetic error message (no request) change nothing.
      said(usage(900_000), { parent_tool_use_id: 'toolu_task' }),
      said(usage(0), {}, { model: '<synthetic>' }),
      result({ usage: usage(4_000, 0, 846_000), modelUsage: window }),
    ]);
    expect(of(mapped, 'context')).toEqual([{ type: 'context', used: 0.3 }]);
  });

  test('the recorded turn gives its share; a turn without a request or the window gives none', () => {
    const recorded = mapAll(mapper(), recordedFrames('turn-basic'));
    // Each of the five requests had 100 input tokens (the result sums them to 500), over the recorded
    // 1,000,000-token window; the frames name the model $MODEL.
    expect(of(recorded, 'context')).toEqual([{ type: 'context', used: 0.0001 }]);
    for (const modelUsage of [{}, { 'claude-sonnet-5-5': {} }, { 'claude-sonnet-5-5': { contextWindow: 0 } }, null]) {
      expect(of(mapAll(mapper(), [init(), said(usage(10)), result({ modelUsage })]), 'context')).toEqual([]);
    }
    // No request in the turn, or one without usage: unknown.
    expect(of(mapAll(mapper(), [init(), result({ modelUsage: window })]), 'context')).toEqual([]);
    const noUsage = assistant([{ type: 'text', text: 'Hi.' }]);
    expect(of(mapAll(mapper(), [init(), noUsage, result({ modelUsage: window })]), 'context')).toEqual([]);
    // The next turn starts counting again.
    const events = mapper();
    mapAll(events, [init(), said(usage(500_000)), result({ modelUsage: window })]);
    expect(of(mapAll(events, [init(), result({ modelUsage: window })]), 'context')).toEqual([]);
  });
});
