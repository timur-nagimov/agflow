import { quoteLines } from '@agflow/core';

export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Text someone else wrote, quoted in at most max characters: the quote marks count toward max, so a text of many
 * short lines cannot double in size once quoted.
 */
export const quotedWithin = (text: string, max: number): string => clip(quoteLines(clip(text, max)), max);
