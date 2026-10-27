import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LivePeek } from '@agflow/core';
import { acquireWaiterLock, waitForMessages } from '../src/wait-inbox';

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
