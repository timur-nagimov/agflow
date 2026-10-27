import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LivePeek, Vendor } from '@agflow/core';
import { acquireWaiterLock, safeToWait, waitForMessages, waitInboxCommand } from '../src/wait-inbox';

function fakeTime() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

const peeks = (...results: LivePeek[]) => {
  let call = 0;
  return { peek: async () => results[Math.min(call++, results.length - 1)] as LivePeek };
};

describe('waitForMessages', () => {
  test('returns a notice once messages are waiting', async () => {
    const time = fakeTime();
    const notice = await waitForMessages({
      client: peeks({ unread: 0, first: null }, { unread: 2, first: { from: 'user:bob' } }),
      vendor: 'claude',
      sessionId: 's1',
      pollMs: 1000,
      maxMs: 60_000,
      ...time,
      stillWanted: () => true,
    });
    expect(notice).toContain('2 new message(s)');
    expect(notice).toContain('user:bob');
    expect(notice).toContain('check_inbox');
    expect(time.now()).toBe(1000);
  });

  test('gives up at the deadline or when the chat is gone', async () => {
    const quiet = peeks({ unread: 0, first: null });
    expect(await waitForMessages({ client: quiet, vendor: 'claude', sessionId: 's1', pollMs: 1000, maxMs: 5000, ...fakeTime(), stillWanted: () => true })).toBeNull();
    expect(await waitForMessages({ client: quiet, vendor: 'claude', sessionId: 's1', pollMs: 1000, maxMs: 5000, ...fakeTime(), stillWanted: () => false })).toBeNull();
  });

  test('keeps waiting through hub errors', async () => {
    let call = 0;
    const flaky = {
      peek: async (): Promise<LivePeek> => {
        call += 1;
        if (call === 1) throw new Error('ECONNREFUSED');
        return { unread: 1, first: { from: 'system' } };
      },
    };
    expect(await waitForMessages({ client: flaky, vendor: 'codex', sessionId: 's1', pollMs: 10, maxMs: 1000, ...fakeTime(), stillWanted: () => true })).toContain('1 new message');
  });
});

describe('acquireWaiterLock', () => {
  test('one live waiter per session; stale locks are taken over', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agflow-cfg-'));
    const first = acquireWaiterLock(dir, 'claude', 's1', process.pid);
    expect(first.acquired).toBe(true);
    expect(acquireWaiterLock(dir, 'claude', 's1', 424242).acquired).toBe(false);
    expect(acquireWaiterLock(dir, 'claude', 's2', 424242).acquired).toBe(true);
    first.release();
    expect(acquireWaiterLock(dir, 'claude', 's1', 424242).acquired).toBe(true);
  });

  test('a lock left by a dead process is ignored', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agflow-cfg-'));
    const lock = acquireWaiterLock(dir, 'claude', 's1', 2 ** 30);
    expect(lock.acquired).toBe(true);
    expect(acquireWaiterLock(dir, 'claude', 's1', process.pid).acquired).toBe(true);
    writeFileSync(join(dir, 'unused'), '');
  });
});

describe('safeToWait', () => {
  test('Claude Code backgrounds the waiter in an interactive terminal session', () => {
    expect(safeToWait('claude', { CLAUDE_CODE_ENTRYPOINT: 'cli' })).toBe(true);
  });

  test('every other Claude Code front end returns without waiting', () => {
    // `claude -p` runs an asyncRewake hook in the foreground and sets sdk-cli, so waiting there would hold up the chat.
    for (const entrypoint of ['sdk-cli', 'sdk-ts', 'sdk-py', 'claude-vscode', 'claude-desktop', 'mcp', 'claude-code-github-action']) {
      expect(safeToWait('claude', { CLAUDE_CODE_ENTRYPOINT: entrypoint })).toBe(false);
    }
  });

  test('a caller that Claude Code did not start may wait', () => {
    expect(safeToWait('claude', {})).toBe(true);
    expect(safeToWait('claude', { CLAUDE_CODE_ENTRYPOINT: '' })).toBe(true);
  });

  test('the variable belongs to Claude Code and does not stop another vendor', () => {
    expect(safeToWait('codex', { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' })).toBe(true);
  });
});

describe('waitInboxCommand', () => {
  /** Runs the hook with an empty config directory, so only the print-mode check can end it before the input is read. */
  async function run(vendor: Vendor, entrypoint: string) {
    let reads = 0;
    const err: string[] = [];
    const code = await waitInboxCommand(
      vendor,
      { out: () => {}, err: (text) => void err.push(text) },
      {
        env: { AGFLOW_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'agflow-cfg-')), CLAUDE_CODE_ENTRYPOINT: entrypoint },
        readStdin: async () => {
          reads += 1;
          return '{"session_id":"s1"}';
        },
      },
    );
    return { code, reads, err };
  }

  test('print mode returns 0 at once, before reading the hook input', async () => {
    expect(await run('claude', 'sdk-cli')).toEqual({ code: 0, reads: 0, err: [] });
  });

  test('an interactive terminal session goes on to read the hook input', async () => {
    expect(await run('claude', 'cli')).toEqual({ code: 0, reads: 1, err: [] });
  });

  test('the Claude Code variable does not stop another vendor', async () => {
    expect(await run('codex', 'sdk-cli')).toEqual({ code: 0, reads: 1, err: [] });
  });
});
