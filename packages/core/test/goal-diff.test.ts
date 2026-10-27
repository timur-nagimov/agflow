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
    expect(text).toBe('- line 0\n- line 1\n… 3 more removed lines');
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
    expect(text.endsWith(`… ${100 - shown} more added lines`)).toBe(true);
  });

  test('keeps a large edit under the default budget', () => {
    const before = Array.from({ length: 200 }, (_, i) => `Requirement ${i}: ${'old wording '.repeat(8)}`).join('\n');
    const after = Array.from({ length: 200 }, (_, i) => `Requirement ${i}: ${'new wording '.repeat(8)}`).join('\n');
    const text = formatChanges(diffGoal(before, after));
    expect(text.length).toBeLessThanOrEqual(4000);
    expect(text).toMatch(/\n… \d+ more added and \d+ more removed lines$/);
  });

  test('does not add a footer when everything fits', () => {
    const text = formatChanges(diffGoal('a\nb\nc', 'a\nB\nc'), 200, 100);
    expect(text).toBe('- b\n+ B');
  });

  // A diff lists a removed block before the added block that replaces it, so a budget spent in diff
  // order shows what is going away and none of what is new.
  describe('when the changes do not fit', () => {
    const prefixed = (op: '+' | '-', texts: string[]) => texts.map((text) => `${op} ${text}`);

    test('replacing a long paragraph with a short one shows every added line', () => {
      const sentences = (tag: string, count: number) =>
        Array.from({ length: count }, (_, i) => `${tag} sentence ${i}: ${'detail '.repeat(10)}`.trimEnd());
      const before = ['# Goal', ...sentences('old', 60), 'Last line'].join('\n');
      const after = ['# Goal', ...sentences('new', 5), 'Last line'].join('\n');
      const text = formatChanges(diffGoal(before, after));
      const shown = text.split('\n');
      const shownRemoved = shown.filter((line) => line.startsWith('- ')).length;
      expect(text.length).toBeLessThanOrEqual(4000);
      expect(shownRemoved).toBeGreaterThan(0);
      expect(shownRemoved).toBeLessThan(60);
      // The removed lines that fit come first, as in the diff, then all five new ones, then the count.
      expect(shown).toEqual([
        ...prefixed('-', sentences('old', shownRemoved)),
        ...prefixed('+', sentences('new', 5)),
        `… ${60 - shownRemoved} more removed lines`,
      ]);
    });

    test('a rewrite spends the budget on the new text and counts both kinds it leaves out', () => {
      const goal = (tag: string) =>
        Array.from({ length: 80 }, (_, i) => `${tag} requirement ${i}: ${'x'.repeat(50)}`);
      const text = formatChanges(diffGoal(goal('old').join('\n'), goal('new').join('\n')));
      const shown = text.split('\n');
      const shownAdded = shown.length - 1;
      expect(text.length).toBeLessThanOrEqual(4000);
      expect(shownAdded).toBeGreaterThan(40);
      expect(shownAdded).toBeLessThan(80);
      expect(shown).toEqual([
        ...prefixed('+', goal('new').slice(0, shownAdded)),
        `… ${80 - shownAdded} more added and 80 more removed lines`,
      ]);
    });

    test('shows the new lines of a rewrite too big to diff exactly', () => {
      const goal = (tag: string) => Array.from({ length: 600 }, (_, i) => `${tag} ${i} ${'z'.repeat(20)}`);
      const text = formatChanges(diffGoal(goal('old').join('\n'), goal('new').join('\n')));
      const shown = text.split('\n');
      expect(text.length).toBeLessThanOrEqual(4000);
      expect(shown[0]).toBe(`+ new 0 ${'z'.repeat(20)}`);
      expect(shown.some((line) => line.startsWith('- '))).toBe(false);
      expect(shown.at(-1)).toBe(`… ${600 - (shown.length - 1)} more added and 600 more removed lines`);
    });

    test('the line cap also keeps added lines first and shows what it keeps in diff order', () => {
      // The diff reads: - b, + B, - d, + D. Both new lines and the first removed line fit in three.
      expect(formatChanges(diffGoal('a\nb\nc\nd', 'a\nB\nc\nD'), 3)).toBe('- b\n+ B\n+ D\n… 1 more removed lines');
      expect(formatChanges(diffGoal('a\nb\nc', 'x\ny\nz'), 2)).toBe(
        '+ x\n+ y\n… 1 more added and 3 more removed lines',
      );
    });

    test('never goes over the budget, and shown plus counted lines add up to every changed line', () => {
      const before = [
        ...Array.from({ length: 30 }, (_, i) => (i % 3 ? `keep ${i}` : `old ${i} ${'o'.repeat(i * 3)}`)),
        'gone 1',
        'gone 2',
      ];
      const after = [
        ...Array.from({ length: 30 }, (_, i) => (i % 3 ? `keep ${i}` : `new ${i} ${'n'.repeat(i)}`)),
        'extra 1',
        'extra 2',
        'extra 3',
      ];
      const lines = diffGoal(before.join('\n'), after.join('\n'));
      const totalAdded = lines.filter((line) => line.op === '+').length;
      const totalRemoved = lines.filter((line) => line.op === '-').length;
      expect([totalAdded, totalRemoved]).toEqual([13, 12]);
      for (let maxChars = 50; maxChars <= 1500; maxChars += 7) {
        const text = formatChanges(lines, 200, maxChars);
        const shown = text.split('\n');
        const footer = shown.at(-1) as string;
        const hiddenAdded = Number(footer.match(/(\d+) more added/)?.[1] ?? 0);
        const hiddenRemoved = Number(footer.match(/(\d+) more removed/)?.[1] ?? 0);
        expect(text.length).toBeLessThanOrEqual(maxChars);
        expect(shown.filter((line) => line.startsWith('+ ')).length + hiddenAdded).toBe(totalAdded);
        expect(shown.filter((line) => line.startsWith('- ')).length + hiddenRemoved).toBe(totalRemoved);
      }
    });
  });
});
