// A Claude session's stream as AgentEvents (design 8.3, 6.8, 10, 13): session facts, turns, the main thread's tools
// with what stall detection needs, text, and the bridge's terminal tools and hub-unreachable answers. Frames arrive
// as the SDK yields them, some untyped (non_execution_kind), so every field is read defensively and anything
// unknown is ignored.
import { BRIDGE_ANSWERS } from '@agflow/core';
import type { SDKAssistantMessageError, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { clip } from '../../attempt/pump';
import type { AgentEvent, TerminalTool } from '../types';
import { isRecord } from './json';
import { classifyResult } from './outcome';

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

type Json = Record<string, unknown>;

/** Maps one session's frames, in order, to the events they give. */
export class ClaudeEventMapper {
  private started = false;
  private inTurn = false;
  private toolCalls = 0;
  private interruptPending = false;
  private assistantError: SDKAssistantMessageError | null = null;
  /** The main thread's calls without a tool_result yet, by tool_use id. */
  private readonly tools = new Map<string, string>();
  /** Calls a system/permission_denied frame named before their tool_result. */
  private readonly deniedCalls = new Set<string>();

  /**
   * The runner interrupted the running turn: the error_during_execution result that follows is an interrupt, not a
   * crash (8.3). The flag ends with the next result. The CLI ignores an interrupt while idle, so one counts only while
   * a turn runs or is about to: `starting` when the caller sent input no frame has answered yet.
   */
  interruptRequested(options: { starting?: boolean } = {}): void {
    if (this.inTurn || options.starting === true) this.interruptPending = true;
  }

  /** The events one frame gives; none for a frame of an unknown type or shape. */
  map(frame: unknown): AgentEvent[] {
    if (!isRecord(frame)) return [];
    const events: AgentEvent[] = [];
    switch (frame.type) {
      case 'system':
        if (frame.subtype === 'init') this.init(frame, events);
        else if (frame.subtype === 'permission_denied' && typeof frame.tool_use_id === 'string') {
          this.deniedCalls.add(frame.tool_use_id);
        }
        break;
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
    events.push({ type: 'turn_started' });
  }

  /** system/init comes again for every user message; the first one names the session. */
  private init(frame: Json, events: AgentEvent[]): void {
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
    for (const block of message.content) {
      if (!isRecord(block)) continue;
      if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') {
        events.push({ type: 'text', text: block.text });
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
    const classified = classifyResult(asResult(frame), {
      interruptPending: this.interruptPending,
      assistantError: this.assistantError,
    });
    events.push({ type: 'turn_ended', ...classified, toolCalls: this.toolCalls });
    this.inTurn = false;
    this.interruptPending = false;
  }
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

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
