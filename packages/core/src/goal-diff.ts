import { diffLines } from 'diff';

export interface DiffLine {
  op: '+' | '-' | ' ';
  text: string;
}

export function diffGoal(before: string, after: string): DiffLine[] {
  const lines: DiffLine[] = [];
  for (const part of diffLines(before, after)) {
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
