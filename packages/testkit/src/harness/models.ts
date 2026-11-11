// The scripted models of a cluster (design 15, 15.1). One scripted Anthropic server and one scripted Responses
// provider serve every runner; each request goes to the playbook program of the attempt whose clone path it carries,
// and a request no program answers gets the server's harmless default. The refusing proxy stands in front of every
// external host. Every request the handlers see is recorded with its attempt, so a scenario can check what an agent
// was shown: its brief, a handoff note, a delivered message, a bridge answer.
import { claudeTestEnv } from '../anthropic/env';
import type { AnthropicRequest } from '../anthropic/request';
import { type ScriptedAnthropic, startScriptedAnthropic } from '../anthropic/server';
import type { ResponsesRequest } from '../codex/request';
import { type ResponsesServer, startResponsesServer } from '../codex/responses-server';
import { type CodexTestConfig, codexTestConfig } from '../codex/test-config';
import { type RefusedRequest, type RefusingProxy, startRefusingProxy } from '../refusing-proxy';
import { attemptIdIn, claudeReply, codexReply, type Next, nextStep, type Program, type Programs } from './playbook';

interface Recorded {
  /** Recording order across both servers, from 0: a request waiting for its program is recorded once answered. */
  seq: number;
  /** The attempt whose agent sent it; null for auxiliary requests and requests without a clone path. */
  attemptId: string | null;
  /** What the agent was shown, flattened: system or developer text, user and system entries, tool results. */
  text: string;
  /** What its program answered; null when no program did, and the server's default answered. */
  answer: Next | null;
}

export type RecordedRequest =
  | (Recorded & { vendor: 'claude'; request: AnthropicRequest })
  | (Recorded & { vendor: 'codex'; request: ResponsesRequest });

/** The session (Claude) or thread (Codex) the request belongs to; null when it names none. */
export function sessionOf(request: RecordedRequest): string | null {
  return request.vendor === 'claude' ? request.request.sessionId : request.request.threadId;
}

/** The ids of the model's own tool calls in the history the request carries, oldest first. */
export function callIdsIn(request: RecordedRequest): string[] {
  if (request.vendor === 'claude') {
    return request.request.messages.flatMap((message) =>
      message.blocks.flatMap((block) => (block.type === 'tool_use' ? [block.id] : [])),
    );
  }
  const input = Array.isArray(request.request.body.input) ? (request.request.body.input as unknown[]) : [];
  return input.flatMap((item) => {
    const entry = item as Record<string, unknown> | null;
    const type = typeof entry?.type === 'string' ? entry.type : '';
    return type.endsWith('_call') && typeof entry?.call_id === 'string' ? [entry.call_id] : [];
  });
}

export interface Models {
  anthropic: ScriptedAnthropic;
  responses: ResponsesServer;
  proxy: RefusingProxy;
  /**
   * The refusing proxy's url. Runners get it as their connectivity variables (HTTPS_PROXY, HTTP_PROXY, ALL_PROXY), so
   * Codex and every tool command go through it too.
   */
  proxyUrl: string;
  /** runner.json's test.claudeEnv: claudeTestEnv for this server and proxy. */
  claudeEnv: Record<string, string>;
  /** runner.json's test.codexConfig: codexTestConfig for this provider. */
  codexConfig: CodexTestConfig;
  /**
   * Adds programs, or replaces those of the same attempts, and keeps the others. Register a successor ahead of time
   * under its predicted id (core's attemptId and leadAttemptId); a request already waiting for it gets it at once.
   */
  addPrograms(programs: Programs): void;
  /** Every recorded request, in arrival order. */
  requests(): RecordedRequest[];
  /** The attempt's requests, in arrival order. */
  requestsFor(attemptId: string): RecordedRequest[];
  /** Whether any request of the attempt showed the agent the marker. */
  sawText(attemptId: string, marker: string): boolean;
  /** Main-loop requests no program answered: an unknown attempt, or one without a clone path. */
  unmatched(): RecordedRequest[];
  /** What the proxy refused: every connection a CLI or a tool tried to an external host. */
  externalAttempts(): RefusedRequest[];
  /** Stops both servers and the proxy. */
  close(): Promise<void>;
}

export interface ModelsOptions {
  programs?: Programs;
  /**
   * How long a main-loop request for an attempt without a program waits for addPrograms before the server's default
   * answers it; 10 s by default. The hub starts a successor as soon as its predecessor ends, which can be before the
   * scenario has added its program, and a default answer would end its first turn. Tests of unmatched requests pass 0.
   */
  programWaitMs?: number;
}

const DEFAULT_PROGRAM_WAIT_MS = 10_000;

type Item = Record<string, unknown>;

function textParts(content: unknown): string[] {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content
    .map((part) => (part !== null && typeof part === 'object' ? (part as Item).text : undefined))
    .filter((part): part is string => typeof part === 'string');
}

function join(parts: string[]): string {
  return parts.filter((part) => part !== '').join('\n');
}

/** The model's own replies are left out: a marker in its words or its commands is not one it was shown. */
function claudeText(request: AnthropicRequest): string {
  const parts = [request.system];
  for (const message of request.messages) {
    if (message.role === 'assistant') continue;
    for (const block of message.blocks) {
      if (block.type === 'text' || block.type === 'tool_result') parts.push(block.text);
    }
  }
  return join(parts);
}

/** Codex 0.159.2 sends no top-level instructions: its base prompt and the brief are developer messages. */
function codexText(request: ResponsesRequest): string {
  const parts: string[] = [];
  const input = Array.isArray(request.body.input) ? (request.body.input as unknown[]) : [];
  for (const raw of input) {
    if (raw === null || typeof raw !== 'object') continue;
    const item = raw as Item;
    if (item.type === 'message' && item.role !== 'assistant') parts.push(...textParts(item.content));
    else if (typeof item.type === 'string' && item.type.endsWith('_call_output')) parts.push(...textParts(item.output));
  }
  return join(parts);
}

export async function startModels(options: ModelsOptions = {}): Promise<Models> {
  const recorded: RecordedRequest[] = [];
  const programs: Programs = { ...options.programs };
  const programWaitMs = options.programWaitMs ?? DEFAULT_PROGRAM_WAIT_MS;
  let closing: Promise<void> | null = null;
  // Requests waiting for a program; addPrograms and close wake them all.
  const waiting = new Set<() => void>();
  const wakeAll = () => {
    for (const wake of [...waiting]) wake();
  };

  /** The attempt's program, waiting up to programWaitMs for addPrograms when it has none yet. */
  async function programFor(attemptId: string | null): Promise<Program | undefined> {
    if (attemptId === null) return undefined;
    const deadline = Date.now() + programWaitMs;
    while (programs[attemptId] === undefined && closing === null && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(timer);
          waiting.delete(wake);
          resolve();
        };
        const timer = setTimeout(wake, deadline - Date.now());
        waiting.add(wake);
      });
    }
    return programs[attemptId];
  }

  /** The program's answer for the request's attempt, or null when it has none. */
  async function answerFor(
    attemptId: string | null,
    request: AnthropicRequest | ResponsesRequest,
  ): Promise<Next | null> {
    const program = await programFor(attemptId);
    return program === undefined ? null : nextStep(program, request);
  }

  // Each start is undone if a later one fails, so a failed start leaks no listener.
  const started: { close(): Promise<void> }[] = [];
  let anthropic: ScriptedAnthropic;
  let responses: ResponsesServer;
  let proxy: RefusingProxy;
  try {
    proxy = await startRefusingProxy();
    started.push(proxy);
    anthropic = await startScriptedAnthropic({
      async handler(request) {
        const attemptId = attemptIdIn(request);
        const answer = await answerFor(attemptId, request);
        const text = claudeText(request);
        recorded.push({ seq: recorded.length, vendor: 'claude', attemptId, text, answer, request });
        return answer === null ? undefined : claudeReply(answer);
      },
    });
    started.push(anthropic);
    responses = await startResponsesServer({
      async handler(request) {
        const attemptId = attemptIdIn(request);
        const answer = await answerFor(attemptId, request);
        const text = codexText(request);
        recorded.push({ seq: recorded.length, vendor: 'codex', attemptId, text, answer, request });
        return answer === null ? undefined : codexReply(answer);
      },
    });
  } catch (error) {
    await Promise.all(started.map((server) => server.close()));
    throw error;
  }

  const proxyUrl = proxy.url;
  const requestsFor = (attemptId: string) => recorded.filter((request) => request.attemptId === attemptId);

  return {
    anthropic,
    responses,
    proxy,
    proxyUrl,
    claudeEnv: claudeTestEnv({ baseUrl: anthropic.url, proxyUrl }),
    codexConfig: codexTestConfig(responses.url),
    addPrograms(added) {
      Object.assign(programs, added);
      wakeAll();
    },
    requests: () => [...recorded],
    requestsFor,
    sawText: (attemptId, marker) => requestsFor(attemptId).some((request) => request.text.includes(marker)),
    unmatched: () =>
      recorded.filter(
        (entry) =>
          entry.answer === null && (entry.vendor === 'claude' ? entry.request.mainLoop : !entry.request.isCompaction),
      ),
    externalAttempts: () => [...proxy.refused],
    close() {
      closing ??= Promise.all([anthropic.close(), responses.close(), proxy.close()]).then(() => undefined);
      wakeAll();
      return closing;
    },
  };
}
