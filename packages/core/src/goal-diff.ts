import { diffLines } from 'diff';

export interface DiffLine {
  op: '+' | '-' | ' ';
  text: string;
}

/**
 * The most edits (lines removed plus lines added) that `diffGoal` searches for. Finding a minimal diff
 * takes longer the more the two texts differ: two unrelated 20,000-character goals took 14 seconds,
 * and the diff runs on the hub's single thread. Up to this bound the diff is exact (rewording 200
 * lines is 400 edits); past it the texts are reported as replaced. In the worst case that costs
 * a few tens of milliseconds.
 */
const MAX_EDIT_LENGTH = 500;

/** The lines of a text as `diffGoal` counts them: CRLF is one line break, and a final newline ends the last line. */
function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split(/\r?\n/);
  if (text.endsWith('\n')) lines.pop();
  return lines;
}

/**
 * Line diff of two goal versions. A goal often has no final newline (a textarea does not add one) and
 * may use CRLF line endings. Neither is a change to a requirement, so adding a line at the end shows
 * only that line. When the texts differ by more than `MAX_EDIT_LENGTH` lines, every old line is
 * reported as removed and every new line as added.
 */
export function diffGoal(before: string, after: string): DiffLine[] {
  const parts = diffLines(before, after, {
    ignoreNewlineAtEof: true,
    stripTrailingCr: true,
    maxEditLength: MAX_EDIT_LENGTH,
  });
  if (!parts) {
    return [
      ...splitLines(before).map((text): DiffLine => ({ op: '-', text })),
      ...splitLines(after).map((text): DiffLine => ({ op: '+', text })),
    ];
  }
  const lines: DiffLine[] = [];
  for (const part of parts) {
    const op: DiffLine['op'] = part.added ? '+' : part.removed ? '-' : ' ';
    const value = part.value.endsWith('\n') ? part.value.slice(0, -1) : part.value;
    for (const text of value.split('\n')) lines.push({ op, text });
  }
  return lines;
}

/** The longest a single rendered change line can be. */
const MAX_LINE_CHARS = 300;

function clipLine(text: string): string {
  if (text.length <= MAX_LINE_CHARS) return text;
  let end = MAX_LINE_CHARS - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1; // do not split a surrogate pair
  return `${text.slice(0, end)}…`;
}

/**
 * Renders the changed lines of a diff for a message. The result has at most `maxLines` lines, each
 * clipped to 300 characters, and at most `maxChars` characters in all, so a large goal edit cannot
 * push the text that follows it out of an agent's context. What does not fit is counted at the end.
 */
export function formatChanges(lines: DiffLine[], maxLines = 200, maxChars = 4000): string {
  const changed = lines.filter((line) => line.op !== ' ');
  if (changed.length === 0) return '(no line changes)';
  const footer = (hidden: number) => `… ${hidden} more changed lines`;
  const room = maxChars - footer(changed.length).length - 1;
  const shown: string[] = [];
  let used = 0;
  for (const line of changed.slice(0, maxLines)) {
    const text = clipLine(`${line.op} ${line.text}`);
    if (used + text.length + 1 > room) break;
    shown.push(text);
    used += text.length + 1;
  }
  if (shown.length < changed.length) shown.push(footer(changed.length - shown.length));
  return shown.join('\n');
}
