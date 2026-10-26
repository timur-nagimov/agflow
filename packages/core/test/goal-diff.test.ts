import { describe, expect, test } from 'bun:test';
import { diffGoal, formatChanges } from '../src/goal-diff';

describe('diffGoal', () => {
  test('marks removed and added lines', () => {
    expect(diffGoal('keep\nold\n', 'keep\nnew\n')).toEqual([
      { op: ' ', text: 'keep' },
      { op: '-', text: 'old' },
      { op: '+', text: 'new' },
    ]);
  });

  test('a first version is all additions', () => {
    expect(diffGoal('', 'a\nb')).toEqual([
      { op: '+', text: 'a' },
      { op: '+', text: 'b' },
    ]);
  });
});

describe('formatChanges', () => {
  test('shows only changed lines', () => {
    expect(formatChanges(diffGoal('keep\nold\n', 'keep\nnew\n'))).toBe('- old\n+ new');
  });

  test('truncates long change lists', () => {
    const before = Array.from({ length: 5 }, (_, i) => `line ${i}`).join('\n');
    const text = formatChanges(diffGoal(before, ''), 2);
    expect(text).toBe('- line 0\n- line 1\n… 3 more changed lines');
  });

  test('says so when nothing changed', () => {
    expect(formatChanges(diffGoal('same', 'same'))).toBe('(no line changes)');
  });
});
