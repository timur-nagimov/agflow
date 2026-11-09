// A Claude session's stream as AgentEvents (design 8.3, 6.7, 6.8, 6.10, 10, 13): session facts, turns, the main
// thread's tools with what stall detection needs, text, the bridge's terminal tools and hub-unreachable answers,
// deliveries and acknowledgements, quota, API retries, sub-agent tasks and context use. Frames arrive as the SDK
// yields them, some untyped (command_lifecycle, non_execution_kind), so every field is read defensively and anything
// unknown is ignored.
import { BRIDGE_ANSWERS, type VendorQuota } from '@agflow/core';
import type { SDKAssistantMessageError, SDKRateLimitInfo, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { clip } from '../../attempt/pump';
import type { AgentEvent, TerminalTool } from '../types';
import { isRecord } from './json';
import { classifyResult } from './outcome';
import { isPaidUsageNotice, QuotaBook } from './quota';

/** The longest tool input a tool_started carries, as JSON: enough to tell repeated calls apart (6.8). */
export const CLAUDE_TOOL_INPUT_MAX = 4_000;

const BRIDGE_TOOL_PREFIX = 'mcp__agflow__';

/** The bridge tools whose normal result ends or hands over the work (design 10). */
const TERMINAL_TOOLS: Readonly<Record<string, TerminalTool>> = Object.freeze({
  submit: 'submit',
  declare_blocked: 'blocked',
  declare_impossible: 'impossible',
  release_task: 'released',
  write_handoff: 'handoff',
});

/** Sub-agent tasks are tools in flight under ids no tool_use has. */
const TASK_TOOL_PREFIX = 'task:';

type Json = Record<string, unknown>;

export interface ClaudeEventMapperOptions {
  /** The session's account (claudeAccountId), which its quota events name. */
  accountId?: string | null;
  /** The adapter's last quota per account, shared by its sessions; a book of its own by default. */
  quota?: QuotaBook;
}

/** Maps one session's frames, in order, to the events they give. */
export class ClaudeEventMapper {
  private readonly accountId: string | null;
  private readonly quota: QuotaBook;
  private started = false;
  /** The model system/init named; its modelUsage entry has the context window. */
  private model: string | null = null;
  private inTurn = false;
  private toolCalls = 0;
  private interruptPending = false;
  private assistantError: SDKAssistantMessageError | null = null;
  /** The main thread's calls without a tool_result yet, by tool_use id. */
  private readonly tools = new Map<string, string>();
  /** Calls a system/permission_denied frame named before their tool_result. */
  private readonly deniedCalls = new Set<string>();
  /** The runner's message id of each sent uuid not yet acknowledged, and whether it was delivered. */
  private readonly messages = new Map<string, { id: string; delivered: boolean }>();
  /** Sub-agent tasks in flight; they may outlive the turn that started them. */
  private readonly tasks = new Set<string>();
  /** Foreground sub-agent tasks: the Task call that spawned them is the tool in flight while they run. */
  private readonly foregroundTasks = new Set<string>();
  /** The prompt tokens, cache included, of the turn's last main-thread request; null before its first. */
  private lastRequestTokens: number | null = null;

  constructor(options: ClaudeEventMapperOptions = {}) {
    this.accountId = options.accountId ?? null;
    this.quota = options.quota ?? new QuotaBook();
  }

  /** The session sent a message with this uuid: its delivery and acknowledgement carry the runner's id. */
  messageSent(uuid: string, id: string): void {
    this.messages.set(uuid, { id, delivered: false });
  }

  /**
   * The runner interrupted the running turn: the error_during_execution result that follows is an interrupt, not a
   * crash (8.3). The flag ends with the next result. The CLI ignores an interrupt while idle, so one counts only while
   * a turn runs or is about to: `starting` when the caller sent input no frame has answered yet, or a sent message
   * not yet delivered.
   */
  interruptRequested(options: { starting?: boolean } = {}): void {
    const waiting = [...this.messages.values()].some((message) => !message.delivered);
    if (this.inTurn || options.starting === true || waiting) this.interruptPending = true;
  }

  /** Whether a turn runs: a frame of it came, and its result has not. */
  get turnRunning(): boolean {
    return this.inTurn;
  }

  /**
   * The process ended without a result for the running turn (a crash, a kill): the turn ends failed with this error,
   * and the calls and sub-agent tasks in flight end with it. Only the tasks while idle.
   */
  ended(error: string): AgentEvent[] {
    const events: AgentEvent[] = [];
    const end = (toolId: string) =>
      events.push({ type: 'tool_ended', toolId, ok: false, denied: false, terminal: null, hubUnreachable: false });
    for (const id of this.tools.keys()) end(id);
    for (const id of this.tasks) end(`${TASK_TOOL_PREFIX}${id}`);
    this.tools.clear();
    this.tasks.clear();
    this.deniedCalls.clear();
    if (this.inTurn) {
      events.push({ type: 'turn_ended', outcome: 'failed', toolCalls: this.toolCalls, error, errorKind: null });
      this.inTurn = false;
      this.interruptPending = false;
    }
    return events;
  }

  /** The events one frame gives; none for a frame of an unknown type or shape. */
  map(frame: unknown): AgentEvent[] {
    if (!isRecord(frame)) return [];
    const events: AgentEvent[] = [];
    switch (frame.type) {
      case 'system':
        this.system(frame, events);
        break;
      case 'command_lifecycle':
        this.lifecycle(frame, events);
        break;
      case 'rate_limit_event': {
        const info = rateLimitInfo(frame.rate_limit_info);
        if (info !== null) {
          events.push({ type: 'quota', accountId: this.accountId, quota: this.quota.rateLimit(this.accountId, info) });
        }
        break;
      }
      case 'assistant':
        this.assistant(frame, events);
        break;
      case 'user':
        this.user(frame, events);
        break;
      case 'result':
        this.result(frame, events);
        break;
      default:
        break;
    }
    return events;
  }

  private turnStarts(events: AgentEvent[]): void {
    if (this.inTurn) return;
    this.inTurn = true;
    this.toolCalls = 0;
    this.assistantError = null;
    this.lastRequestTokens = null;
    events.push({ type: 'turn_started' });
  }

  private system(frame: Json, events: AgentEvent[]): void {
    switch (frame.subtype) {
      case 'init':
        this.init(frame, events);
        return;
      case 'permission_denied':
        if (typeof frame.tool_use_id === 'string') this.deniedCalls.add(frame.tool_use_id);
        return;
      case 'api_retry':
        this.apiRetry(frame, events);
        return;
      case 'task_started':
        // Ambient tasks are housekeeping, not activity.
        if (typeof frame.task_id !== 'string' || frame.skip_transcript === true || frame.ambient === true) return;
        // A foreground task runs inside the main-thread call that spawned it, already a tool in flight; a second
        // start would hide that call's repeats from the loop rule (6.8).
        if (
          typeof frame.tool_use_id === 'string' &&
          this.tools.has(frame.tool_use_id) &&
          frame.is_backgrounded !== true
        ) {
          this.foregroundTasks.add(frame.task_id);
          return;
        }
        this.taskStarts(frame.task_id, frame.description, events);
        return;
      case 'task_updated':
        // A foreground task moved to the background: its call returns, and the task goes on by itself.
        if (
          typeof frame.task_id === 'string' &&
          isRecord(frame.patch) &&
          frame.patch.is_backgrounded === true &&
          this.foregroundTasks.delete(frame.task_id)
        ) {
          this.taskStarts(frame.task_id, frame.patch.description, events);
        }
        return;
      case 'task_notification':
        if (typeof frame.task_id !== 'string' || typeof frame.status !== 'string') return;
        this.foregroundTasks.delete(frame.task_id);
        if (!this.tasks.delete(frame.task_id)) return;
        events.push({
          type: 'tool_ended',
          toolId: `${TASK_TOOL_PREFIX}${frame.task_id}`,
          ok: frame.status === 'completed',
          denied: false,
          terminal: null,
          hubUnreachable: false,
        });
        return;
      case 'notification':
        this.notice(frame.text, events);
        return;
      case 'informational':
        this.notice(frame.content, events);
        return;
      default:
        return;
    }
  }

  private taskStarts(taskId: string, description: unknown, events: AgentEvent[]): void {
    this.tasks.add(taskId);
    events.push({
      type: 'tool_started',
      toolId: `${TASK_TOOL_PREFIX}${taskId}`,
      name: 'Task',
      input: clip(text(description), CLAUDE_TOOL_INPUT_MAX),
      command: null,
    });
  }

  /**
   * The CLI's own notices (system/notification mirrors its toast queue, system/informational its banners): the
   * usage-transition notice says the work draws on paid usage from here on (8.3, 6.10). Other notices are left out.
   */
  private notice(value: unknown, events: AgentEvent[]): void {
    if (typeof value !== 'string' || !isPaidUsageNotice(value)) return;
    events.push({ type: 'warning', text: value });
    events.push({ type: 'quota', accountId: this.accountId, quota: this.quota.paidUsageInUse(this.accountId) });
  }

  /**
   * A retry is activity, never quota by itself (8.3): with a 429 it repeats the account's last known quota, so the
   * hub sees how close the limits are, but only a limit hit makes it exhausted.
   */
  private apiRetry(frame: Json, events: AgentEvent[]): void {
    const status = typeof frame.error_status === 'number' ? frame.error_status : null;
    const error = typeof frame.error === 'string' ? frame.error : 'unknown';
    const cause = status === null ? `The API request failed (${error})` : `The API answered ${status} (${error})`;
    const delay = typeof frame.retry_delay_ms === 'number' ? ` in ${Math.round(frame.retry_delay_ms / 1000)} s` : '';
    const retry = `retry ${number(frame.attempt)} of ${number(frame.max_retries)}`;
    events.push({ type: 'warning', text: `${cause}; ${retry}${delay}.` });
    const last = status === 429 ? this.quota.last(this.accountId) : null;
    if (last === null) return;
    // Information only: an exhaustion or paid usage the book still holds is not repeated as if the retry found it.
    const quota: VendorQuota = {
      ...last,
      state: last.state === 'exhausted' ? 'unknown' : last.state,
      paidUsage: last.paidUsage === 'in_use' ? 'unknown' : last.paidUsage,
    };
    events.push({ type: 'quota', accountId: this.accountId, quota });
  }

  /**
   * The untyped command_lifecycle frames of 2.1.285 ({ command_uuid, state }): a sent message is delivered when it
   * starts, and a cancelled one will never be acknowledged.
   */
  private lifecycle(frame: Json, events: AgentEvent[]): void {
    if (typeof frame.command_uuid !== 'string') return;
    const message = this.messages.get(frame.command_uuid);
    if (message === undefined) return;
    if (frame.state === 'started' && !message.delivered) {
      message.delivered = true;
      events.push({ type: 'delivered', id: message.id });
    } else if (frame.state === 'cancelled') {
      this.messages.delete(frame.command_uuid);
    }
  }

  /** system/init comes again for every user message; the first one names the session. */
  private init(frame: Json, events: AgentEvent[]): void {
    if (typeof frame.model === 'string') this.model = frame.model;
    if (!this.started) {
      this.started = true;
      events.push({
        type: 'started',
        sessionRef: text(frame.session_id),
        model: text(frame.model),
        cliVersion: text(frame.claude_code_version),
        permissionMode: typeof frame.permissionMode === 'string' ? frame.permissionMode : null,
      });
    }
    this.turnStarts(events);
  }

  private assistant(frame: Json, events: AgentEvent[]): void {
    this.turnStarts(events);
    // A sub-agent's frames: its calls are its own, inside the Task call in flight.
    if (frame.parent_tool_use_id !== null && frame.parent_tool_use_id !== undefined) return;
    const message = frame.message;
    if (!isRecord(message) || !Array.isArray(message.content)) return;
    this.assistantError = typeof frame.error === 'string' ? (frame.error as SDKAssistantMessageError) : null;
    const tokens = promptTokens(message.usage);
    // A synthetic API-error message made no request.
    if (tokens > 0) this.lastRequestTokens = tokens;
    // Only the CLI writes '<synthetic>' messages; the model's own text never counts as a notice.
    const synthetic = message.model === SYNTHETIC_MODEL;
    for (const block of message.content) {
      if (!isRecord(block)) continue;
      if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') {
        events.push({ type: 'text', text: block.text });
        if (synthetic && isPaidUsageNotice(block.text)) {
          events.push({ type: 'quota', accountId: this.accountId, quota: this.quota.paidUsageInUse(this.accountId) });
        }
      } else if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        this.toolCalls += 1;
        this.tools.set(block.id, block.name);
        const input = isRecord(block.input) ? block.input : {};
        events.push({
          type: 'tool_started',
          toolId: block.id,
          name: block.name,
          input: clip(JSON.stringify(input), CLAUDE_TOOL_INPUT_MAX),
          command: block.name === 'Bash' && typeof input.command === 'string' ? input.command : null,
        });
      }
    }
  }

  private user(frame: Json, events: AgentEvent[]): void {
    this.turnStarts(events);
    if (frame.parent_tool_use_id !== null && frame.parent_tool_use_id !== undefined) return;
    const message = frame.message;
    if (!isRecord(message) || !Array.isArray(message.content)) return;
    const marked = refusedCalls(frame.tool_result_meta);
    for (const block of message.content) {
      if (!isRecord(block) || block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
      const id = block.tool_use_id;
      const name = this.tools.get(id);
      if (name === undefined) continue;
      this.tools.delete(id);
      const failed = block.is_error === true;
      const announced = this.deniedCalls.delete(id);
      const bridge = name.startsWith(BRIDGE_TOOL_PREFIX) ? name.slice(BRIDGE_TOOL_PREFIX.length) : null;
      events.push({
        type: 'tool_ended',
        toolId: id,
        ok: !failed,
        denied: marked.has(id) || announced,
        // Refusals are error results; only a normal result ends the work (design 10, X-19).
        terminal: bridge !== null && !failed ? (TERMINAL_TOOLS[bridge] ?? null) : null,
        hubUnreachable: bridge !== null && failed && resultText(block.content).includes(BRIDGE_ANSWERS.hubUnreachable),
      });
    }
  }

  private result(frame: Json, events: AgentEvent[]): void {
    this.turnStarts(events);
    // Calls the turn left unanswered (an interrupt, a denial without a tool_result) end with it.
    const denials = new Set(
      (Array.isArray(frame.permission_denials) ? frame.permission_denials : []).flatMap((denial) =>
        isRecord(denial) && typeof denial.tool_use_id === 'string' ? [denial.tool_use_id] : [],
      ),
    );
    for (const id of this.tools.keys()) {
      events.push({
        type: 'tool_ended',
        toolId: id,
        ok: false,
        denied: denials.has(id) || this.deniedCalls.has(id),
        terminal: null,
        hubUnreachable: false,
      });
    }
    this.tools.clear();
    this.deniedCalls.clear();
    this.acknowledge(frame.user_message_uuids, events);
    const used = this.contextUsed(frame.modelUsage);
    if (used !== null) events.push({ type: 'context', used });
    const classified = classifyResult(asResult(frame), {
      interruptPending: this.interruptPending,
      assistantError: this.assistantError,
    });
    events.push({ type: 'turn_ended', ...classified, toolCalls: this.toolCalls });
    this.inTurn = false;
    this.interruptPending = false;
  }

  /** result.user_message_uuids: the messages the turn consumed. One never seen starting was delivered as well. */
  private acknowledge(uuids: unknown, events: AgentEvent[]): void {
    if (!Array.isArray(uuids)) return;
    for (const uuid of uuids) {
      const message = typeof uuid === 'string' ? this.messages.get(uuid) : undefined;
      if (message === undefined) continue;
      this.messages.delete(uuid);
      if (!message.delivered) events.push({ type: 'delivered', id: message.id });
      events.push({ type: 'acknowledged', id: message.id });
    }
  }

  /**
   * The context in use (8.3, 6.8): the prompt tokens of the turn's last main-thread request over the session model's
   * window; null when either is unknown. The result's usage sums every request of the turn, so it would overstate it.
   */
  private contextUsed(models: unknown): number | null {
    if (this.model === null || this.lastRequestTokens === null || !isRecord(models)) return null;
    const entry = models[this.model];
    const window = isRecord(entry) ? entry.contextWindow : undefined;
    if (typeof window !== 'number' || !(window > 0)) return null;
    return this.lastRequestTokens / window;
  }
}

/** The model name of the messages the CLI writes itself, such as API errors and notices. */
const SYNTHETIC_MODEL = '<synthetic>';

/** A request's prompt tokens: input plus cache creation and cache reads, counting only numbers. */
function promptTokens(usage: unknown): number {
  if (!isRecord(usage)) return 0;
  return ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'].reduce(
    (sum, key) => sum + (typeof usage[key] === 'number' && Number.isFinite(usage[key]) ? (usage[key] as number) : 0),
    0,
  );
}

/**
 * A rate_limit_event's info with a string status, its other fields kept only in the types sdk.d.ts gives them, so
 * an unexpected value is unknown rather than an error; null without a status.
 */
function rateLimitInfo(value: unknown): SDKRateLimitInfo | null {
  if (!isRecord(value) || typeof value.status !== 'string') return null;
  const info: Json = { ...value };
  for (const key of ['rateLimitType', 'overageStatus', 'overageDisabledReason']) {
    if (typeof info[key] !== 'string') delete info[key];
  }
  for (const key of ['resetsAt', 'utilization', 'overageResetsAt']) {
    if (typeof info[key] !== 'number' || !Number.isFinite(info[key])) delete info[key];
  }
  for (const key of ['isUsingOverage', 'overageInUse']) {
    if (typeof info[key] !== 'boolean') delete info[key];
  }
  return info as unknown as SDKRateLimitInfo;
}

/** A result frame with the fields classifyResult reads made safe: errors a list, result a string. */
function asResult(frame: Json): SDKResultMessage {
  return {
    ...frame,
    result: typeof frame.result === 'string' ? frame.result : '',
    errors: Array.isArray(frame.errors) ? frame.errors.filter((error) => typeof error === 'string') : [],
  } as unknown as SDKResultMessage;
}

// The runner's own interrupt rejects the call in flight; that is no denial.
const NOT_DENIALS = new Set(['user-rejected']);

/** The ids 2.1.285's untyped tool_result_meta marks as refused: never executed, for any reason but an interrupt. */
function refusedCalls(meta: unknown): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(meta)) return ids;
  for (const entry of meta) {
    const kind = isRecord(entry) ? entry.non_execution_kind : undefined;
    if (isRecord(entry) && typeof entry.id === 'string' && typeof kind === 'string' && !NOT_DENIALS.has(kind)) {
      ids.add(entry.id);
    }
  }
  return ids;
}

/** A tool_result's text: a string, or its text blocks joined. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((block) => (isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? block.text : []))
    .join('\n');
}

function number(value: unknown): string {
  return typeof value === 'number' ? String(value) : '?';
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
