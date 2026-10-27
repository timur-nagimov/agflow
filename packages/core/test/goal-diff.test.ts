import { describe, expect, test } from 'bun:test';
import { type DiffLine, diffGoal, formatChanges } from '../src/goal-diff';

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

  // Goal text from a textarea usually has no final newline, so the last line is the one that moves
  // when a line is added or removed after it.
  test('adding a line at the end leaves the line before it unchanged', () => {
    expect(diffGoal('a\nb', 'a\nb\nc')).toEqual([
      { op: ' ', text: 'a' },
      { op: ' ', text: 'b' },
      { op: '+', text: 'c' },
    ]);
    expect(diffGoal('x', 'x\ny')).toEqual([
      { op: ' ', text: 'x' },
      { op: '+', text: 'y' },
    ]);
  });

  test('removing the last line leaves the line before it unchanged', () => {
    expect(diffGoal('a\nb\nc', 'a\nb')).toEqual([
      { op: ' ', text: 'a' },
      { op: ' ', text: 'b' },
      { op: '-', text: 'c' },
    ]);
  });

  test('a final newline is not a change', () => {
    expect(formatChanges(diffGoal('a\nb', 'a\nb\n'))).toBe('(no line changes)');
    expect(formatChanges(diffGoal('a\nb\n', 'a\nb'))).toBe('(no line changes)');
  });

  test('CRLF and LF versions of the same text are the same', () => {
    expect(formatChanges(diffGoal('a\r\nb\r\nc', 'a\nb\nc'))).toBe('(no line changes)');
    expect(formatChanges(diffGoal('a\nb\nc', 'a\r\nb\r\nc\r\n'))).toBe('(no line changes)');
  });

  test('a changed line in CRLF text shows without the carriage return', () => {
    expect(diffGoal('a\r\nb\r\n', 'a\r\nc\r\n')).toEqual([
      { op: ' ', text: 'a' },
      { op: '-', text: 'b' },
      { op: '+', text: 'c' },
    ]);
  });
});

describe('diffGoal on texts that differ a lot', () => {
  const count = (lines: DiffLine[], op: DiffLine['op']) => lines.filter((line) => line.op === op).length;

  test('stays exact for an edit that rewords 200 lines', () => {
    const before = Array.from({ length: 400 }, (_, i) => (i % 2 ? `kept ${i}` : `old ${i}`));
    const after = before.map((line, i) => (i % 2 ? line : `new ${i}`));
    const lines = diffGoal(before.join('\n'), after.join('\n'));
    // The 200 untouched lines stay unchanged, which a full replacement would not say.
    expect([count(lines, ' '), count(lines, '-'), count(lines, '+')]).toEqual([200, 200, 200]);
  });

  test('gives up quickly on unrelated texts and reports them as replaced', () => {
    const started = performance.now();
    const lines = diffGoal('a\n'.repeat(10_000), 'b\n'.repeat(10_000));
    // Searching for the exact diff of these two texts takes about 14 seconds.
    expect(performance.now() - started).toBeLessThan(1000);
    expect(lines).toHaveLength(20_000);
    expect(lines.slice(0, 10_000).every((line) => line.op === '-' && line.text === 'a')).toBe(true);
    expect(lines.slice(10_000).every((line) => line.op === '+' && line.text === 'b')).toBe(true);
  });

  test('counts lines the same way when it gives up', () => {
    const before = Array.from({ length: 1000 }, (_, i) => `old ${i}`).join('\r\n'); // CRLF, no final newline
    const after = `${Array.from({ length: 1000 }, (_, i) => `new ${i}`).join('\n')}\n`; // LF, final newline
    const lines = diffGoal(before, after);
    expect(lines).toHaveLength(2000);
    expect(lines[0]).toEqual({ op: '-', text: 'old 0' });
    expect(lines[999]).toEqual({ op: '-', text: 'old 999' });
    expect(lines[1000]).toEqual({ op: '+', text: 'new 0' });
    expect(lines[1999]).toEqual({ op: '+', text: 'new 999' });
  });

  test('a long first version is all additions', () => {
    const goal = Array.from({ length: 1500 }, (_, i) => `line ${i}`).join('\n');
    const lines = diffGoal('', goal);
    expect(lines).toHaveLength(1500);
    expect(lines.every((line) => line.op === '+')).toBe(true);
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
