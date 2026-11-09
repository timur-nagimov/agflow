// Recordings for the fake claude (design 15, 15.1, 8.3): what a real 2.1.285 printed on stdout in stream-json mode,
// split into turns, plus the directives that make a replay react to its input and the answers to the SDK's control
// requests. A recording is JSONL: a line holding a "type" is a frame, printed as it is after its placeholders are
// filled; every other line is one directive, an object with a single $-key.
import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

/** What the recording is and where it came from. */
export interface RecordingHeader {
  /** The CLI version the frames came from. */
  cliVersion: string;
  /** captured: a real CLI printed it; synthesised: built by a test or from the typings and the binary's texts. */
  source: 'captured' | 'synthesised';
  scenario: string;
  /**
   * The account the frames show. Captures run against the scripted server with an API key, and the recorder rewrites
   * them into a synthetic subscription account; live captures keep the (redacted) real one.
   */
  account: 'synthetic-subscription' | 'live';
  /** The --model and --permission-mode the frames were recorded with; $MODEL and $PERMISSION_MODE default to them. */
  model: string;
  permissionMode: string;
}

/** The answer to one control request subtype: a success response, or an error with its message. */
export type ControlAnswer = { response: Record<string, unknown> } | { error: string };

/** One step of a turn, or of the startup that follows initialize. */
export type RecordingStep =
  /** Printed after its placeholders are filled. */
  | { frame: Record<string, unknown> }
  /** Waits for the next user message (a delivery folded into the running turn), or for an interrupt request. */
  | { wait: 'user' | 'interrupt' }
  | { sleep: number }
  /** Sends hook_callback for the callback the SDK registered for the event, and logs the SDK's answer. */
  | { hook: { event: string; input: Record<string, unknown>; toolUseId?: string } }
  /** Writes this text to stderr, as a crashing CLI does before it exits. */
  | { stderr: string }
  /** Exits with this code. */
  | { exit: number }
  /** From here to the end of the turn, stdin EOF does not end the process. */
  | { ignoreEof: true };

export interface ClaudeRecording {
  header: RecordingHeader;
  /** Answers by control request subtype: initialize, get_settings, get_usage and any other the recording knows. */
  answers: Record<string, ControlAnswer>;
  /** Run after initialize, before its answer: the SessionStart hook frames, for one. */
  startup: RecordingStep[];
  /** Each user message that arrives while the fake is idle replays the next turn. */
  turns: RecordingStep[][];
}

/**
 * The placeholders a replay fills in any string, keys included: the session id (--session-id or --resume), a fresh
 * uuid per occurrence, the newest user message's uuid and the n-th of the running turn (1-based), the working
 * directory, and the --model and --permission-mode arguments.
 */
export const RECORDING_PLACEHOLDERS = [
  '$SESSION',
  '$UUID',
  '$LAST_USER_UUID',
  '$USER_UUID_<n>',
  '$CWD',
  '$MODEL',
  '$PERMISSION_MODE',
] as const;

/** The base recordings record:claude writes. */
export const CLAUDE_FIXTURES_DIR = join(import.meta.dir, '..', '..', 'fixtures', 'claude');

/** The account a synthetic subscription shows: a made-up email and organisation, and a Max plan. */
export const SYNTHETIC_ACCOUNT = Object.freeze({
  email: 'agent@example.invalid',
  organization: 'org-00000000-0000-4000-8000-000000000000',
  subscriptionType: 'max',
  tokenSource: 'claude.ai',
  apiProvider: 'firstParty',
});

export interface ClaudeRecordingInput {
  turns: RecordingStep[][];
  startup?: RecordingStep[];
  /** Merged over the defaults: a synthetic subscription account, a sandbox that is on, and no plan usage. */
  answers?: Record<string, ControlAnswer>;
  header?: Partial<RecordingHeader>;
}

/** A synthesised recording, for cases no capture can produce (limit hits, overage) and for the fake's own tests. */
export function claudeRecording(input: ClaudeRecordingInput): ClaudeRecording {
  return {
    header: {
      cliVersion: '2.1.285',
      source: 'synthesised',
      scenario: 'synthesised',
      account: 'synthetic-subscription',
      model: 'claude-sonnet-5-5',
      permissionMode: 'acceptEdits',
      ...input.header,
    },
    answers: {
      initialize: {
        response: {
          commands: [],
          agents: [],
          output_style: 'default',
          available_output_styles: ['default'],
          models: [],
          account: { ...SYNTHETIC_ACCOUNT },
          pid: 0,
        },
      },
      get_settings: {
        response: { effective: { sandbox: { enabled: true, failIfUnavailable: true } }, sources: [], applied: {} },
      },
      get_usage: { response: { subscription_type: 'max', rate_limits_available: false, rate_limits: null } },
      ...input.answers,
    },
    startup: input.startup ?? [],
    turns: input.turns,
  };
}

const DIRECTIVES = [
  '$recording',
  '$answer',
  '$turn',
  '$wait',
  '$sleep',
  '$hook',
  '$stderr',
  '$exit',
  '$ignoreEof',
] as const;

/** The JSONL form: the header, the answers, the startup steps, then each turn after a $turn line. */
export function serializeRecording(recording: ClaudeRecording): string {
  const lines: unknown[] = [{ $recording: recording.header }];
  for (const [subtype, answer] of Object.entries(recording.answers)) lines.push({ $answer: { subtype, ...answer } });
  const steps = (list: RecordingStep[]) => lines.push(...list.map(stepLine));
  steps(recording.startup);
  recording.turns.forEach((turn, index) => {
    lines.push({ $turn: index + 1 });
    steps(turn);
  });
  return `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
}

function stepLine(step: RecordingStep): unknown {
  if ('frame' in step) return step.frame;
  if ('wait' in step) return { $wait: step.wait };
  if ('sleep' in step) return { $sleep: step.sleep };
  if ('hook' in step) return { $hook: step.hook };
  if ('stderr' in step) return { $stderr: step.stderr };
  if ('exit' in step) return { $exit: step.exit };
  return { $ignoreEof: true };
}

export function parseRecording(text: string, name = 'recording'): ClaudeRecording {
  let header: RecordingHeader | null = null;
  const answers: Record<string, ControlAnswer> = {};
  const startup: RecordingStep[] = [];
  const turns: RecordingStep[][] = [];
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    if (line.trim() === '') return;
    const where = `${name}:${index + 1}`;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      throw new Error(`${where} is not JSON`);
    }
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new Error(`${where} is no object`);
    const current = turns.at(-1) ?? startup;
    if (typeof entry.type === 'string') {
      current.push({ frame: entry });
      return;
    }
    const keys = Object.keys(entry);
    const key = keys[0] as (typeof DIRECTIVES)[number];
    if (keys.length !== 1 || !DIRECTIVES.includes(key)) throw new Error(`${where} is neither a frame nor a directive`);
    const value = entry[key];
    switch (key) {
      case '$recording':
        header = value as RecordingHeader;
        return;
      case '$answer': {
        const { subtype, ...answer } = value as { subtype: string } & ControlAnswer;
        answers[subtype] = answer as ControlAnswer;
        return;
      }
      case '$turn':
        turns.push([]);
        return;
      case '$wait':
        if (value !== 'user' && value !== 'interrupt') throw new Error(`${where} waits for ${JSON.stringify(value)}`);
        current.push({ wait: value });
        return;
      case '$sleep':
        current.push({ sleep: Number(value) });
        return;
      case '$hook':
        current.push({ hook: value as { event: string; input: Record<string, unknown>; toolUseId?: string } });
        return;
      case '$stderr':
        current.push({ stderr: String(value) });
        return;
      case '$exit':
        current.push({ exit: Number(value) });
        return;
      case '$ignoreEof':
        current.push({ ignoreEof: true });
        return;
    }
  });
  if (header === null) throw new Error(`${name} has no $recording header`);
  return { header, answers, startup, turns };
}

/** A recording by fixture name (packages/testkit/fixtures/claude/<name>.jsonl) or by absolute path. */
export function loadRecording(nameOrPath: string): ClaudeRecording {
  const path = isAbsolute(nameOrPath) ? nameOrPath : join(CLAUDE_FIXTURES_DIR, `${nameOrPath}.jsonl`);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`no Claude recording at ${path}: ${(error as NodeJS.ErrnoException).code ?? error}`);
  }
  return parseRecording(text, path);
}

export function writeRecording(path: string, recording: ClaudeRecording): void {
  writeFileSync(path, serializeRecording(recording));
}
