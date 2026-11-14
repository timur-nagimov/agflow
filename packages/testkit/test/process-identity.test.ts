import { expect, test } from 'bun:test';
import { identifyProcesses, parseLinuxStartTime } from '../src/process-identity';
import type { PsRow } from '../src/process-table';

const row: PsRow = { pid: 101, ppid: 1, pgid: 101, stat: 'S',
  lstart: 'Thu Nov 12 12:00:00 2026', command: 'marked process' };

test('kernel identities bracket ps so a stale marker cannot attach to a recycled pid', () => {
  const before = new Map([[101, 'birth-1']]);
  let scanned = false;
  const source = {
    snapshot: () => { expect(scanned).toBe(false); return before; },
    read: (pid: number) => { expect(scanned).toBe(true); expect(pid).toBe(101); return 'birth-1'; },
  };
  expect(identifyProcesses(() => { scanned = true; return [row]; }, source))
    .toEqual([{ ...row, identity: 'birth-1' }]);
  for (const identity of ['birth-2', undefined]) {
    expect(identifyProcesses(() => [row], { snapshot: () => before, read: () => identity }))
      .toEqual([{ ...row, identity: null }]);
  }
  expect(identifyProcesses(() => [row], { snapshot: () => new Map(), read: () => 'birth-1' }))
    .toEqual([{ ...row, identity: null }]);
});

test('Linux birth identity uses stat field 22 even when comm contains spaces and closing parentheses', () => {
  const fields = ['S', ...Array(18).fill('0'), '1234567890123', '999'];
  expect(parseLinuxStartTime(`101 (a name) with ) parens) ${fields.join(' ')}`)).toBe('linux:1234567890123');
  expect(parseLinuxStartTime('')).toBeUndefined();
  expect(parseLinuxStartTime('101 (gone) Z 1')).toBeUndefined();
});
