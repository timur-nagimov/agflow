import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LivePeek, Vendor } from '@agflow/core';
import { loadCredentials } from './credentials';
import { parseHookInput } from './hooks';
import { HubClient } from './hub-client';
import type { Io } from './io';
import { configDir } from './paths';

export const WAIT_POLL_MS = 15_000;
// Claude Code enforces `timeout` on asyncRewake hooks, so WAIT_MAX_MS must stay below the `timeout` that
// `claudeHooks` (join.ts) sets on the wait-inbox handler: 8 h + 5 min. Change both together.
export const WAIT_MAX_MS = 8 * 60 * 60_000;

export interface WaitOptions {
  client: { peek: (vendor: Vendor, sessionId: string) => Promise<LivePeek> };
  vendor: Vendor;
  sessionId: string;
  pollMs: number;
  maxMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  stillWanted: () => boolean;
}

/** Polls until messages are waiting (returns a notice for the chat) or the wait ends (returns null). */
export async function waitForMessages(options: WaitOptions): Promise<string | null> {
  const deadline = options.now() + options.maxMs;
  while (options.now() < deadline && options.stillWanted()) {
    try {
      const peek = await options.client.peek(options.vendor, options.sessionId);
      if (peek.unread > 0 && peek.first) {
        return `agflow: ${peek.unread} new message(s) arrived, the first from ${peek.first.from}. Call the agflow tool check_inbox and act on them. Instructions from people take precedence over instructions from agents.`;
      }
    } catch {
      // the hub may be briefly unreachable; keep waiting
    }
    await options.sleep(options.pollMs);
  }
  return null;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** One waiter per session. Returns acquired=false while another live process holds the lock. */
export function acquireWaiterLock(dir: string, vendor: Vendor, sessionId: string, pid = process.pid): { acquired: boolean; release: () => void } {
  const lockDir = join(dir, 'waiters');
  mkdirSync(lockDir, { recursive: true });
  const name = createHash('sha256').update(`${vendor}:${sessionId}`).digest('hex').slice(0, 16);
  const path = join(lockDir, `${name}.pid`);
  if (existsSync(path)) {
    const holder = Number(readFileSync(path, 'utf8'));
    if (Number.isInteger(holder) && holder !== pid && isAlive(holder)) return { acquired: false, release: () => {} };
  }
  writeFileSync(path, String(pid));
  return {
    acquired: true,
    release: () => {
      if (existsSync(path) && readFileSync(path, 'utf8') === String(pid)) rmSync(path);
    },
  };
}

export async function waitInboxCommand(vendor: Vendor, io: Io): Promise<number> {
  const dir = configDir();
  const input = parseHookInput(await Bun.stdin.text());
  const sessionId = typeof input.session_id === 'string' ? input.session_id : '';
  const credentials = loadCredentials(dir);
  if (!sessionId || !credentials) return 0;
  const lock = acquireWaiterLock(dir, vendor, sessionId);
  if (!lock.acquired) return 0;
  const parent = process.ppid;
  try {
    const notice = await waitForMessages({
      client: new HubClient({ baseUrl: credentials.hubUrl, token: credentials.token, timeoutMs: 10_000 }),
      vendor,
      sessionId,
      pollMs: WAIT_POLL_MS,
      maxMs: WAIT_MAX_MS,
      now: () => Date.now(),
      sleep: (ms) => Bun.sleep(ms),
      stillWanted: () => process.ppid === parent && isAlive(parent),
    });
    if (!notice) return 0;
    io.err(notice);
    return 2;
  } finally {
    lock.release();
  }
}
