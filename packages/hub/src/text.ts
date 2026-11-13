import { quoteLines } from '@agflow/core';

export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Text someone else wrote, on one line: line breaks and every other control character become "?". What a log or a
 * record keeps of an agent's or a site's text goes through it, so none of it can start a line of its own, or drive the
 * terminal of whoever reads it.
 */
export const oneLine = (text: string): string => text.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, '?');

/**
 * Text someone else wrote, quoted in at most max characters: the quote marks count toward max, so a text of many
 * short lines cannot double in size once quoted.
 */
export const quotedWithin = (text: string, max: number): string => clip(quoteLines(clip(text, max)), max);
