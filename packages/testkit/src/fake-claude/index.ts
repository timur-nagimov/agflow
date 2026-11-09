// The recorded-stream fake claude (design 15, 15.1): an executable that speaks the CLI's stream-json control
// protocol and replays recorded stdout frames, so the Claude adapter runs in CI and meets signals only a subscription
// produces. It stays out of the testkit's main index; M2d's Claude tests import this entry.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { type ClaudeRecording, writeRecording } from './recording';

export * from './recording';

/**
 * The executable. It has no file extension, so the Agent SDK spawns it as a native binary, as it does the real one.
 * It runs cli.ts with FAKE_CLAUDE_BUN, or the bun on PATH.
 */
export const FAKE_CLAUDE_BIN = join(import.meta.dir, '..', '..', 'bin', 'fake-claude');

export interface FakeClaudeEnvOptions {
  /** A recording, written into dir, or the path of one. */
  recording: ClaudeRecording | string;
  /** Where the recording and the log go. */
  dir: string;
  /** What `--version` prints instead of the pin. */
  version?: string;
}

/** The variables the fake reads; they reach it through the launch environment, which the SDK passes whole. */
export function fakeClaudeEnv(options: FakeClaudeEnvOptions): Record<string, string> {
  mkdirSync(options.dir, { recursive: true });
  let recording = options.recording;
  if (typeof recording !== 'string') {
    const path = join(options.dir, 'recording.jsonl');
    writeRecording(path, recording);
    recording = path;
  }
  return {
    FAKE_CLAUDE_RECORDING: recording,
    FAKE_CLAUDE_LOG: join(options.dir, 'fake-claude.log'),
    FAKE_CLAUDE_BUN: process.execPath,
    ...(options.version === undefined ? {} : { FAKE_CLAUDE_VERSION: options.version }),
  };
}

/** What one line of FAKE_CLAUDE_LOG records. */
export type FakeClaudeLogRecord =
  /** The arguments, and the names of the environment variables the process got. */
  | { kind: 'argv'; argv: string[]; env: string[] }
  /** Every control request the SDK sent, as it came. */
  | { kind: 'control'; requestId: string; request: Record<string, unknown> }
  /** Every user message, as it came. */
  | { kind: 'user'; message: Record<string, unknown> }
  /** The SDK's answer to a $hook directive's hook_callback. */
  | { kind: 'hook_answer'; event: string; callbackId: string; answer: Record<string, unknown> }
  | { kind: 'eof'; midTurn: boolean; ignored: boolean }
  | { kind: 'exit'; code: number }
  /** Something the replay could not do as recorded: no turn left, no callback for a hook. */
  | { kind: 'note'; text: string };

/** One line of FAKE_CLAUDE_LOG; `at` is epoch ms. */
export type FakeClaudeLogEntry = { at: number } & FakeClaudeLogRecord;

export async function readFakeClaudeLog(path: string): Promise<FakeClaudeLogEntry[]> {
  const file = Bun.file(path);
  if (!(await file.exists())) return [];
  return (await file.text())
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as FakeClaudeLogEntry);
}
