// Vendor-neutral agent playbooks for the scripted models (design 15.1). A playbook maps attempt ids to programs; a
// program is a list of steps (a shell command, an agflow tool call, a gate, each with optional text before it) plus
// reactions to text injected into the conversation. The servers answer from request content, never from request
// order:
// - The attempt id comes only from the agent's own clone path, work/<project>/<attempt>, which the brief's last line
//   (X-17) and the vendor's own working directory carry; a handoff note naming an earlier attempt cannot mislead it.
// - The next step comes from the history: step n's tool call id encodes n, so a retried request gets the same answer
//   and a resumed session continues where it stopped.
// - A gate waits for a file under the clone's runner-owned .agflow/run/, which harvests, snapshots and the file watcher
//   ignore (design 7.3, 7.5), so opening one changes nothing the scenario checks.
import { parseAttemptId } from '@agflow/core';
import {
  type AnthropicReply,
  agflowTool,
  bashTool,
  type ContentBlock,
  reply as message,
  text,
} from '../anthropic/replies';
import type { AnthropicRequest } from '../anthropic/request';
import { type OutputItem, reply as codex, type StreamReply } from '../codex/replies';
import type { ResponsesRequest } from '../codex/request';

/** Where gates wait, relative to the clone: inside the runner-owned .agflow/run/. */
export const GATE_DIR = '.agflow/run/e2e';

/** The Bash tool's own maximum timeout in Claude Code. */
export const BASH_MAX_TIMEOUT_MS = 600_000;

const DEFAULT_SHELL_TIMEOUT_MS = 120_000;

/** A gate waits as long as a step can: scenarios open it when they are ready. */
const DEFAULT_GATE_TIMEOUT_MS = BASH_MAX_TIMEOUT_MS;

/** What a program answers once every step has run, so a continuation prompt never restarts it. */
export const CLOSING_TEXT = 'Every step of my program has run; there is nothing left for me to do.';

/** How a playbook error starts: the agent sees it as text, and the scenario fails on it. */
export const PLAYBOOK_ERROR = 'agflow playbook error';

/** Codex 0.159.2's answer for an exec cell that yielded while its script still ran. */
const CELL_STILL_RUNNING = 'Script running with cell ID';

/** Claude Code 2.1.285's Bash result for a command it moved to the background, at its timeout or for a message. */
const MOVED_TO_BACKGROUND = /was moved to the background \(ID: /;

/** What a gate prints when its own deadline passes before anyone opened it. */
const GATE_TIMED_OUT = /agflow gate \S+ timed out/;

/**
 * Claude Code 2.1.285's result for a Bash command its permission check could not approve, with the reason after "What
 * required approval: ". A runner session has no approval surface, so the command never ran.
 */
const CLAUDE_DENIED = 'Permission for this tool use was denied.';
const CLAUDE_DENIED_REASON = /What required approval: (.*)/;

export interface ShellStep {
  kind: 'shell';
  cmd: string;
  /** The tool's own timeout: Bash's timeout, the exec cell's deadline. */
  timeoutMs: number;
  /** The gate's name when the step is a gate. */
  gate: string | null;
  /** Text the model says before the call, in the same reply. */
  text: string | null;
}

export interface ToolStep {
  kind: 'tool';
  /** An agflow bridge tool: mcp__agflow__<tool>. */
  tool: string;
  args: Record<string, unknown>;
  text: string | null;
}

export type Step = ShellStep | ToolStep;

/** Steps that run once, the first time the marker appears in text injected after the program started. */
export interface Reaction {
  marker: string;
  steps: Step[];
}

export interface Program {
  steps: Step[];
  reactions?: Reaction[];
}

/** The programs of a scenario, keyed by attempt id. */
export type Programs = Record<string, Program>;

function checkTimeout(timeoutMs: number): number {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > BASH_MAX_TIMEOUT_MS) {
    throw new Error(`a step's timeout must be 1 to ${BASH_MAX_TIMEOUT_MS} ms (Bash's maximum), not ${timeoutMs}`);
  }
  return timeoutMs;
}

/** A shell command, run in the clone; 2 minutes by default. */
export function shell(cmd: string, options: { timeoutMs?: number } = {}): ShellStep {
  const timeoutMs = checkTimeout(options.timeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS);
  return { kind: 'shell', cmd, timeoutMs, gate: null, text: null };
}

/** A call of an agflow bridge tool, such as tool('submit', { task_id, summary }). */
export function tool(name: string, args: Record<string, unknown> = {}): ToolStep {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`not a tool name: ${JSON.stringify(name)}`);
  return { kind: 'tool', tool: name, args, text: null };
}

/** The step with text the model says before its call, in the same reply. */
export function say<S extends Step>(value: string, step: S): S {
  return { ...step, text: value };
}

const GATE_NAME = /^(?!\.\.?$)[A-Za-z0-9._-]+$/;

/** How long before its step's timeout a gate gives up on its own. */
const GATE_MARGIN_S = 5;

/**
 * A command that waits until GATE_DIR/<name> exists in the clone; the harness opens it by writing that file. The
 * step's timeout is 10 minutes by default. A gate that is never opened gives up on its own 5 s before that, exiting
 * 124 with "agflow gate <name> timed out": at their timeouts both CLIs leave a command running (Claude moves it to the
 * background, Codex's cell returns while it runs), and a loop that outlives its step would run on in the clone. The
 * loop is a perl one-liner, one simple command with a literal script: Claude Code 2.1.285 cannot approve a shell loop
 * with expansions, substitutions or brace groups in a runner session, and denies it without running it.
 */
export function gate(name: string, options: { timeoutMs?: number } = {}): ShellStep {
  if (!GATE_NAME.test(name)) throw new Error(`not a gate name: ${JSON.stringify(name)}`);
  const file = `${GATE_DIR}/${name}`;
  const timeoutMs = checkTimeout(options.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS);
  const seconds = Math.max(1, Math.floor(timeoutMs / 1000) - GATE_MARGIN_S);
  const script =
    `my $end = time + ${seconds}; until (-e "${file}") { if (time >= $end) { print "agflow gate ${name} timed out\\n"; ` +
    `exit 124 } select(undef, undef, undef, 0.2) } print "gate ${name} is open\\n"`;
  const cmd = `perl -e '${script}'`;
  return { ...shell(cmd, { timeoutMs }), gate: name };
}

export function react(marker: string, steps: Step[]): Reaction {
  if (marker === '') throw new Error('a reaction needs a marker');
  return { marker, steps };
}

// --- Attempt ids ---------------------------------------------------------------------------------------------------

/** The attempt of a clone path, <home>/work/<project>/<attempt>, or null for any other path. */
function attemptOfPath(path: string): string | null {
  const id = path.trim().match(/\/work\/[^/]+\/([^/]+)\/?$/)?.[1];
  return id !== undefined && parseAttemptId(id) !== null ? id : null;
}

/** The value of the last line of the text that the pattern matches, from its first group. */
function lastLineValue(value: string, line: RegExp): string | null {
  let found: string | null = null;
  for (const text of value.split('\n')) found = text.match(line)?.[1] ?? found;
  return found;
}

/** The brief's last line (X-17); a quoted copy in a note is indented or prefixed, and comes before it. */
const BRIEF_LINE = /^Your working directory: (.+)$/;
/** Claude Code's environment section: " - Primary working directory: <cwd>". */
const CLAUDE_CWD_LINE = /^(?:\s*-\s+)?Primary working directory: (.+)$/;

function isClaude(request: AnthropicRequest | ResponsesRequest): request is AnthropicRequest {
  return 'messages' in request;
}

/**
 * The attempt whose agent sent the request, read from its clone path only: Claude's primary working directory or the
 * brief-hook context; Codex's environment context or developer instructions (the brief). The brief ends with its "Your
 * working directory" line, so the last such line of a text counts and a quoted handoff note above it does not. Null
 * for auxiliary requests (titles, summaries, compactions) and requests that carry no clone path.
 */
export function attemptIdIn(request: AnthropicRequest | ResponsesRequest): string | null {
  const paths: (string | null)[] = [];
  if (isClaude(request)) {
    if (!request.mainLoop) return null;
    paths.push(lastLineValue(request.system, CLAUDE_CWD_LINE));
    // Claude Code 2.1.285 sends the hook's brief and its own environment section together, in a role 'system' entry
    // near the start of the messages. That entry comes before any message delivered later, so the first path found in
    // message order is the agent's own, and a forwarded "Your working directory" line cannot win.
    for (const entry of request.messages) {
      if (entry.role === 'assistant') continue;
      for (const block of entry.blocks) {
        if (block.type !== 'text') continue;
        paths.push(lastLineValue(block.text, CLAUDE_CWD_LINE), lastLineValue(block.text, BRIEF_LINE));
      }
    }
  } else {
    if (request.isCompaction) return null;
    paths.push(request.cwd, lastLineValue(request.instructions, BRIEF_LINE));
  }
  for (const path of paths) {
    const id = path === null ? null : attemptOfPath(path);
    if (id !== null) return id;
  }
  return null;
}

// --- The history ---------------------------------------------------------------------------------------------------

type Entry =
  | { kind: 'call'; callId: string }
  | { kind: 'result'; callId: string; text: string }
  | { kind: 'injected'; text: string };

function claudeHistory(request: AnthropicRequest): Entry[] {
  const entries: Entry[] = [];
  for (const entry of request.messages) {
    for (const block of entry.blocks) {
      if (entry.role === 'assistant') {
        if (block.type === 'tool_use') entries.push({ kind: 'call', callId: block.id });
      } else if (block.type === 'tool_result') {
        entries.push({ kind: 'result', callId: block.toolUseId, text: block.text });
      } else if (block.type === 'text') {
        // A prompt, a message folded in mid-turn (a system entry), or context the CLI adds.
        entries.push({ kind: 'injected', text: block.text });
      }
    }
  }
  return entries;
}

type Item = Record<string, unknown>;

function texts(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (part !== null && typeof part === 'object' ? (part as Item).text : undefined))
    .filter((part): part is string => typeof part === 'string')
    .join('\n');
}

/** User messages Codex writes itself. */
const CODEX_CONTEXT = ['<environment_context>', '# AGENTS.md instructions'];

function codexHistory(request: ResponsesRequest): Entry[] {
  const input = Array.isArray(request.body.input) ? (request.body.input as unknown[]) : [];
  const entries: Entry[] = [];
  for (const raw of input) {
    if (raw === null || typeof raw !== 'object') continue;
    const item = raw as Item;
    const type = typeof item.type === 'string' ? item.type : '';
    const callId = typeof item.call_id === 'string' && item.call_id !== '' ? item.call_id : null;
    if (type.endsWith('_call_output')) {
      // An output without a call is an agent's message delivered as agflow's agent_message.
      const output = texts(item.output);
      entries.push(callId ? { kind: 'result', callId, text: output } : { kind: 'injected', text: output });
    } else if (type.endsWith('_call') && callId) {
      entries.push({ kind: 'call', callId });
    } else if (type === 'message' && item.role === 'user') {
      const value = texts(item.content);
      if (!CODEX_CONTEXT.some((prefix) => value.startsWith(prefix))) entries.push({ kind: 'injected', text: value });
    }
  }
  return entries;
}

// --- The next step -------------------------------------------------------------------------------------------------

/** The call id of a program step: e2e-s<n>, or e2e-r<k>-s<n> for step n of reaction k. */
export function stepCallId(step: number, reaction: number | null = null): string {
  return reaction === null ? `e2e-s${step}` : `e2e-r${reaction}-s${step}`;
}

function parseCallId(callId: string): { reaction: number | null; step: number } | null {
  const match = callId.match(/^e2e-(?:r(\d+)-)?s(\d+)$/);
  if (!match) return null;
  return { reaction: match[1] === undefined ? null : Number(match[1]), step: Number(match[2]) };
}

export type Next =
  | { kind: 'step'; step: Step; callId: string }
  /** Every step has run: the closing text. */
  | { kind: 'done' }
  | { kind: 'error'; message: string };

/**
 * Why a step's result is not a result: its command still ran when the tool returned, its gate timed out, or Claude
 * Code denied it.
 */
function unfinished(request: AnthropicRequest | ResponsesRequest, result: string): string | null {
  if (GATE_TIMED_OUT.test(result)) return 'its gate timed out before anyone opened it';
  if (isClaude(request)) {
    if (result.includes(CLAUDE_DENIED)) {
      const reason = result.match(CLAUDE_DENIED_REASON)?.[1]?.trim() || 'no reason given';
      return `Claude Code denied it without running it (${reason})`;
    }
    return MOVED_TO_BACKGROUND.test(result) ? 'its command was moved to the background' : null;
  }
  if (result.includes(CELL_STILL_RUNNING)) return 'its cell yielded while its command still ran';
  // reply.shell's cell reports a command still running at its deadline with a session_id and no exit_code.
  for (const line of result.split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      const value = JSON.parse(line) as Item;
      if ('session_id' in value && !('exit_code' in value)) return 'its command still ran at the deadline';
    } catch {
      // Not the cell's JSON.
    }
  }
  return null;
}

/**
 * What the program answers to the request, from the history alone. A step counts as run once the history holds a
 * result for its call id, whatever the result says (an interrupted or aborted call included). A triggered reaction
 * runs before the program goes on. A step whose command was still running when its tool returned (a yielded Codex
 * cell or one past its deadline, a command Claude moved to the background) or whose gate timed out is a playbook
 * error: going on would run the next step while it still runs. So is a step Claude Code denied: it never ran.
 */
export function nextStep(program: Program, request: AnthropicRequest | ResponsesRequest): Next {
  const history = isClaude(request) ? claudeHistory(request) : codexHistory(request);
  const done = new Map<number | null, number>();
  let started = -1;
  for (const [position, entry] of history.entries()) {
    if (entry.kind === 'injected') continue;
    const parsed = parseCallId(entry.callId);
    if (parsed === null) continue;
    if (started < 0) started = position;
    if (entry.kind !== 'result') continue;
    const why = unfinished(request, entry.text);
    if (why !== null) {
      return { kind: 'error', message: `step ${entry.callId} did not finish: ${why} (${entry.text.slice(0, 200)})` };
    }
    done.set(parsed.reaction, Math.max(done.get(parsed.reaction) ?? -1, parsed.step));
  }
  if (started >= 0) {
    const reactions = program.reactions ?? [];
    const triggered = reactions
      .map((reaction, index) => ({
        index,
        reaction,
        at: history.findIndex(
          (entry, position) => position > started && entry.kind === 'injected' && entry.text.includes(reaction.marker),
        ),
      }))
      .filter((candidate) => candidate.at >= 0)
      .sort((a, b) => a.at - b.at);
    for (const { index, reaction } of triggered) {
      const next = (done.get(index) ?? -1) + 1;
      const step = reaction.steps[next];
      if (step) return { kind: 'step', step, callId: stepCallId(next, index) };
    }
  }
  const next = (done.get(null) ?? -1) + 1;
  const step = program.steps[next];
  return step ? { kind: 'step', step, callId: stepCallId(next) } : { kind: 'done' };
}

// --- Compiling ----------------------------------------------------------------------------------------------------

function errorText(message: string): string {
  return `${PLAYBOOK_ERROR}: ${message}`;
}

/** The reply of the scripted Anthropic server: text before the call, then a Bash or mcp__agflow__ tool_use. */
export function claudeReply(next: Next): AnthropicReply {
  if (next.kind === 'done') return message(CLOSING_TEXT);
  if (next.kind === 'error') return message(errorText(next.message));
  const { step, callId } = next;
  const call =
    step.kind === 'shell'
      ? bashTool({
          command: step.cmd,
          timeoutMs: step.timeoutMs,
          description: step.gate === null ? `Run e2e step ${callId}` : `Wait for gate ${step.gate}`,
          id: callId,
        })
      : agflowTool({ tool: step.tool, args: step.args, id: callId });
  const blocks: ContentBlock[] = step.text === null ? [call] : [text(step.text), call];
  return message(blocks);
}

/**
 * The reply of the scripted Responses provider: text before the call, then a Code Mode exec cell. A shell step's cell
 * waits for the command until the step's timeout, and its pragma keeps the cell from yielding before that.
 */
export function codexReply(next: Next): StreamReply {
  if (next.kind === 'done') return codex.text(CLOSING_TEXT);
  if (next.kind === 'error') return codex.text(errorText(next.message));
  const { step, callId } = next;
  const call =
    step.kind === 'shell'
      ? codex.shell({ cmd: step.cmd, timeoutMs: step.timeoutMs, callId, pollInbox: true })
      : codex.mcp({ tool: step.tool, args: step.args, callId });
  const before: OutputItem[] = step.text === null ? [] : codex.text(step.text).output;
  return { ...call, output: [...before, ...call.output] };
}
