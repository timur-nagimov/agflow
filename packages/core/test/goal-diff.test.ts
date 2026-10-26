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

  test('clips a single very long line', () => {
    const text = formatChanges(diffGoal('', 'x'.repeat(20_000)));
    expect(text.length).toBeLessThanOrEqual(300);
    expect(text.startsWith('+ xxx')).toBe(true);
    expect(text.endsWith('x…')).toBe(true);
  });

  test('does not split a surrogate pair when clipping', () => {
    const text = formatChanges(diffGoal('', `${'a'.repeat(296)}\u{1F600}tail`));
    expect(text.endsWith('a…')).toBe(true);
    expect(text.isWellFormed()).toBe(true);
  });

  test('stops at the character budget and counts what it left out', () => {
    const after = Array.from({ length: 100 }, (_, i) => `line ${i} ${'y'.repeat(40)}`).join('\n');
    const text = formatChanges(diffGoal('', after), 200, 500);
    expect(text.length).toBeLessThanOrEqual(500);
    const shown = text.split('\n').length - 1;
    expect(shown).toBeGreaterThan(5);
    expect(shown).toBeLessThan(100);
    expect(text.endsWith(`… ${100 - shown} more changed lines`)).toBe(true);
  });

  test('keeps a large edit under the default budget', () => {
    const before = Array.from({ length: 200 }, (_, i) => `Requirement ${i}: ${'old wording '.repeat(8)}`).join('\n');
    const after = Array.from({ length: 200 }, (_, i) => `Requirement ${i}: ${'new wording '.repeat(8)}`).join('\n');
    const text = formatChanges(diffGoal(before, after));
    expect(text.length).toBeLessThanOrEqual(4000);
    expect(text).toMatch(/\n… \d+ more changed lines$/);
  });

  test('does not add a footer when everything fits', () => {
    const text = formatChanges(diffGoal('a\nb\nc', 'a\nB\nc'), 200, 100);
    expect(text).toBe('- b\n+ B');
  });
});
