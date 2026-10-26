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

export function formatChanges(lines: DiffLine[], maxLines = 200): string {
  const changed = lines.filter((line) => line.op !== ' ');
  if (changed.length === 0) return '(no line changes)';
  const shown = changed.slice(0, maxLines).map((line) => `${line.op} ${line.text}`);
  if (changed.length > maxLines) shown.push(`… ${changed.length - maxLines} more changed lines`);
  return shown.join('\n');
}
