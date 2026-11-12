import { expect, test } from 'bun:test';
import { killOwnedProcesses, type CleanupHost } from '../src/process-cleanup';
import type { PsRow } from '../../runner/src/processes';

const scope = 'fixture-scope';
const row = (pid: number, extra: Partial<PsRow> = {}): PsRow => ({
  pid, ppid: 1, pgid: pid, stat: 'S', lstart: 'Thu Nov 12 12:00:00 2026',
  command: `sh AGFLOW_TEST_PROCESS_SCOPE=${scope}`, ...extra,
});
function host(snapshots: PsRow[][], groups = new Map<string, { scope: string; pid: number; lstart: string }>()) {
  const signals: [number, NodeJS.Signals][] = [];
  let index = 0;
  const io: CleanupHost = {
    snapshot: () => snapshots[Math.min(index++, snapshots.length - 1)]!,
    signal: (pid, signal) => { signals.push([pid, signal]); },
    groups: () => groups,
    forgetGroup: (id: string) => { groups.delete(id); },
  };
  return { io, signals };
}

test('a recorded group owns platform binaries after its leader exits and its members are reparented', () => {
  const leader = row(101);
  const orphan = row(102, { pgid: 101, command: '/bin/sh -c loop' });
  const sleeper = row(103, { ppid: 102, pgid: 101, command: '/bin/sleep 1' });
  const groups = new Map([['launch', { scope, pid: leader.pid, lstart: leader.lstart }]]);
  const h = host([[orphan, sleeper]], groups);
  expect(killOwnedProcesses(scope, h.io, 999)).toBe(2);
  expect(h.signals).toEqual([[102, 'SIGSTOP'], [103, 'SIGSTOP'], [-101, 'SIGKILL']]);
});

test('retires an empty recorded group so a reused pgid cannot inherit ownership', () => {
  const groups = new Map([['launch', { scope, pid: 101, lstart: row(101).lstart }]]);
  const h = host([[]], groups);
  expect(killOwnedProcesses(scope, h.io, 999)).toBe(0);
  expect(groups.size).toBe(0);
  const reused = host([[row(102, { pgid: 101, command: '/bin/sleep 20' })]], groups);
  expect(killOwnedProcesses(scope, reused.io, 999)).toBe(0);
  expect(reused.signals).toEqual([]);
});

test('rejects a recorded group with a reused leader or a member older than the launch', () => {
  for (const member of [
    row(101, { lstart: 'Thu Nov 12 12:00:01 2026', command: 'unrelated' }),
    row(102, { pgid: 101, lstart: 'Thu Nov 12 11:59:59 2026', command: 'unrelated' }),
  ]) {
    const groups = new Map([['launch', { scope, pid: 101, lstart: row(101).lstart }]]);
    const h = host([[member]], groups);
    expect(killOwnedProcesses(scope, h.io, 999)).toBe(0);
    expect(h.signals).toEqual([]);
    expect(groups.size).toBe(0);
  }
});

test('group records follow scope boundaries and never include the test runner', () => {
  const groups = new Map([
    ['nested', { scope: `${scope}.nested`, pid: 101, lstart: row(101).lstart }],
    ['sibling', { scope: `${scope}-sibling`, pid: 201, lstart: row(201).lstart }],
    ['self', { scope, pid: 999, lstart: row(999).lstart }],
  ]);
  const h = host([[
    row(102, { pgid: 101, command: 'sleep 1' }),
    row(202, { pgid: 201, command: 'sleep 1' }),
    row(999, { command: 'bun test' }),
  ]], groups);
  expect(killOwnedProcesses(scope, h.io, 999)).toBe(1);
  expect(h.signals).toEqual([[102, 'SIGSTOP'], [-101, 'SIGKILL']]);
  expect(groups.has('sibling')).toBe(true);
});

test('a group published during a process snapshot is rescanned before being retired', () => {
  const groups = new Map<string, { scope: string; pid: number; lstart: string }>();
  const orphan = row(102, { pgid: 101, command: '/bin/sleep 20' });
  const h = host([[orphan]], groups);
  const snapshot = h.io.snapshot;
  let first = true;
  h.io.snapshot = () => {
    if (!first) return snapshot();
    first = false;
    groups.set('new-launch', { scope, pid: 101, lstart: row(101).lstart });
    return []; // ps captured this before the launch, but the registry was published before ps returned.
  };
  expect(killOwnedProcesses(scope, h.io, 999)).toBe(1);
  expect(h.signals).toContainEqual([-101, 'SIGKILL']);
});

test('kills an orphaned detached group and descendants with a cleared environment', () => {
  const parent = row(101);
  const child = row(102, { ppid: 101, pgid: 101, command: 'sleep 25' });
  const h = host([[parent, child]]);
  killOwnedProcesses(scope, h.io, 999);
  expect(h.signals).toContainEqual([-101, 'SIGKILL']);
});

test('does not signal a reused pid or its old group', () => {
  const original = row(101);
  const reused = row(101, { lstart: 'Thu Nov 12 12:00:01 2026', command: 'unrelated' });
  const h = host([[original], [reused]]);
  killOwnedProcesses(scope, h.io, 999);
  expect(h.signals).toEqual([]);
});

test('does not signal a group containing unrelated processes or the test runner', () => {
  const owned = row(101, { pgid: 999 });
  const self = row(999, { command: 'bun test' });
  const bystander = row(103, { pgid: 999, command: 'unrelated' });
  const h = host([[owned, self, bystander]]);
  killOwnedProcesses(scope, h.io, 999);
  expect(h.signals).toContainEqual([101, 'SIGKILL']);
  expect(h.signals.some(([pid]) => pid !== 101)).toBe(false);
});

test('scope boundaries exclude a sibling test and include nested test processes', () => {
  const nested = row(101, { command: `sh AGFLOW_TEST_PROCESS_SCOPE=${scope}.nested` });
  const sibling = row(102, { command: `sh AGFLOW_TEST_PROCESS_SCOPE=${scope}-sibling` });
  const h = host([[nested, sibling]]);
  killOwnedProcesses(scope, h.io, 999);
  expect(h.signals).toContainEqual([-101, 'SIGKILL']);
  expect(h.signals.some(([pid]) => Math.abs(pid) === 102)).toBe(false);
});

test('rescans after stopping parents to catch a newly forked detached child', () => {
  const parent = row(101);
  const child = row(102, { ppid: 101, command: 'env -i sleep 25' });
  const h = host([[parent], [parent], [parent, child]]);
  killOwnedProcesses(scope, h.io, 999);
  expect(h.signals).toContainEqual([-102, 'SIGKILL']);
});

test('a recycled marked pid cannot inherit ownership even within the same ps timestamp second', () => {
  const original = row(101);
  const reused = row(101, { command: 'unrelated' });
  const h = host([[original], [reused]]);
  killOwnedProcesses(scope, h.io, 999);
  expect(h.signals).toEqual([]);
});

test('a timed-out test continuation cannot start a new server after its cleanup', async () => {
  const { cleanupTestProcesses } = await import('../src/process-cleanup');
  const later = new Promise<string>((resolve) => {
    setTimeout(() => {
      try {
        const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('late') });
        server.stop(true);
        resolve('started');
      } catch (error) { resolve((error as Error).message); }
    }, 20);
  });
  await cleanupTestProcesses();
  expect(await later).toContain('test scope already closed');
});
