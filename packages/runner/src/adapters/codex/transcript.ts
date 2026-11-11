// Transcript operations without a live session (design 6.8, 7.8, 13).
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunnerConfig } from '../../config';
import type { Logger } from '../../log';
import type { RunnerPaths } from '../../paths';
import { vendorBinary } from '../../vendor/pins';
import { CODEX_VERSION } from './binary';
import { appServerArgs, appServerEnv } from './config';
import { codexProcessOptions } from './preflight';
import { openAppServer } from './process';
import { RpcError } from './rpc';

// Parse the timestamp boundary so even a longer thread id ending in `-<sessionRef>` cannot match.
const ROLLOUT_NAME = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/;
const DATE_PARTS = [/^\d{4}$/, /^\d{2}$/, /^\d{2}$/];

async function findRollout(dir: string, sessionRef: string, depth = 0): Promise<string | null> {
  const entries = await readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const entry of entries) {
    const datePart = DATE_PARTS[depth];
    if (datePart) {
      if (!entry.isDirectory() || !datePart.test(entry.name)) continue;
      const found = await findRollout(join(dir, entry.name), sessionRef, depth + 1);
      if (found) return found;
    } else if (entry.isFile() && entry.name.match(ROLLOUT_NAME)?.[1] === sessionRef) {
      return join(dir, entry.name);
    }
  }
  return null;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The rollout's assistant text of the last 3 turns that have any, cut from the front to maxChars; null without a file. */
export async function readCodexTranscriptTail(input: {
  codexHome: string;
  sessionRef: string;
  maxChars: number;
}): Promise<string | null> {
  const file = await findRollout(join(input.codexHome, 'sessions'), input.sessionRef);
  if (file === null) return null;
  const contents = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
    // Retention can delete the rollout between discovery and reading.
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (contents === null) return null;
  const turns: string[][] = [[]];
  let messages = turns[0]!;
  for (const line of contents.split('\n')) {
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!object(record) || !object(record.payload)) continue;
    const payload = record.payload;
    if (record.type === 'event_msg' && payload.type === 'task_started') {
      messages = [];
      turns.push(messages);
    } else if (
      record.type === 'response_item' &&
      payload.type === 'message' &&
      payload.role === 'assistant' &&
      Array.isArray(payload.content)
    ) {
      const text = payload.content
        .filter((part: unknown) => object(part) && part.type === 'output_text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('');
      if (text !== '') messages.push(text);
    }
  }
  const text = turns
    .filter((turn) => turn.length > 0)
    .slice(-3)
    .map((turn) => turn.join('\n'))
    .join('\n\n');
  let start = Math.max(0, text.length - Math.max(0, Math.floor(input.maxChars)));
  const before = text.charCodeAt(start - 1);
  const after = text.charCodeAt(start);
  if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) start += 1;
  return text.slice(start);
}

/** thread/delete through a short-lived app-server of the current pin; 'no rollout found' counts as deleted. */
export async function deleteCodexTranscript(input: {
  sessionRef: string;
  config: RunnerConfig;
  paths: RunnerPaths;
  /** Where AGFLOW_TEST and the user variables are read; process.env by default. */
  env?: Record<string, string | undefined>;
  logger?: Logger;
  /** Bounds each app-server request; tests pass a short one. */
  requestTimeoutMs?: number;
}): Promise<void> {
  const { paths, logger, requestTimeoutMs } = input;
  const { codexHome, userHome, base, codexConfig } = codexProcessOptions(input);
  await Promise.all([codexHome, userHome].map((home) => mkdir(home, { recursive: true, mode: 0o700 })));
  const app = await openAppServer({
    bin: join(paths.runner, vendorBinary('codex', CODEX_VERSION)),
    args: appServerArgs(codexConfig),
    env: appServerEnv({ base, bridgeEnv: {}, codexHome, userHome }),
    cwd: userHome,
    expectedVersion: CODEX_VERSION,
    logFile: join(paths.logs, 'codex-transcripts.log'),
    logger,
    requestTimeoutMs,
  });
  try {
    await app.rpc.request('thread/delete', { threadId: input.sessionRef });
  } catch (error) {
    if (!(error instanceof RpcError && error.code === -32600 && error.message.startsWith('no rollout found'))) {
      throw error;
    }
  } finally {
    await app.end();
  }
}
