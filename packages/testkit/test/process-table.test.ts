import { expect, test } from 'bun:test';
import { parsePs, PS_COLUMNS, PS_ENV, sameProcess } from '../src/process-table';

test('process snapshots parse C-locale ps rows without losing ownership markers', () => {
  expect(PS_COLUMNS).toBe('pid=,ppid=,pgid=,stat=,lstart=,command=');
  expect(PS_ENV).toEqual({ LC_ALL: 'C', TZ: 'UTC' });
  expect(parsePs(`
  101 1 101 S Thu Oct  2 13:04:14 2026 /bin/sh AGFLOW_TEST_PROCESS_SCOPE=fixture.nested  
  102 101 101 Z Thu Nov 12 12:00:00 2026
not a process row
`)).toEqual([
    { pid: 101, ppid: 1, pgid: 101, stat: 'S', lstart: 'Thu Oct  2 13:04:14 2026',
      command: '/bin/sh AGFLOW_TEST_PROCESS_SCOPE=fixture.nested' },
    { pid: 102, ppid: 101, pgid: 101, stat: 'Z', lstart: 'Thu Nov 12 12:00:00 2026', command: '' },
  ]);
});

test('process identities require both pid and start time', () => {
  const original = { pid: 101, lstart: 'Thu Nov 12 12:00:00 2026' };
  expect(sameProcess(original, { ...original })).toBe(true);
  expect(sameProcess(original, { ...original, pid: 102 })).toBe(false);
  expect(sameProcess(original, { ...original, lstart: 'Thu Nov 12 12:00:01 2026' })).toBe(false);
});
