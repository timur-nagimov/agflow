import { expect, test } from 'bun:test';

test('tests never inherit GIT_* variables, so git commands in throwaway repositories cannot reach the real one', () => {
  expect(Object.keys(process.env).filter((name) => name.startsWith('GIT_'))).toEqual([]);
});
