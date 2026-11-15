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

/** Every line break quoteLines splits on. */
const LINE_BREAK = /\r\n|[\n\v\f\r\u0085\u2028\u2029]/;
/** A list marker that may start a line: "-", "*", "+", "•", or a number followed by "." or ")". */
const LIST_MARKER = /^(?:[-*+•]|\d+[.)])\s*/;
/** The markdown that may come before a line's first word: a heading's or a quote's mark, emphasis and code marks. */
const LEADING_MARKS = /^[\s#>*_`]+/;
/** Emphasis and code marks on either side of a prefix's colon, as in "**gap:**", "**gap**:" or "`gap:`". */
const EMPHASIS = /^[*_`]+/;

/**
 * The lines of the texts that start with prefix, a word and its colon, in any case, after spaces, an optional list
 * marker and markdown marks, each from the prefix on, without the emphasis or code marks around its colon: the fixed
 * lines agflow asks agents to write, such as "gap:" and "DEFECT:", however an agent formats them.
 */
export function linesStarting(texts: readonly string[], prefix: string): string[] {
  const word = prefix.replace(/:$/, '').toLowerCase();
  return texts
    .flatMap((text) => text.split(LINE_BREAK))
    .flatMap((line) => {
      const bare = line.trim().replace(LIST_MARKER, '').replace(LEADING_MARKS, '');
      if (!bare.toLowerCase().startsWith(word)) return [];
      const after = bare.slice(word.length).replace(EMPHASIS, '');
      return after.startsWith(':') ? [`${bare.slice(0, word.length)}:${after.slice(1).replace(EMPHASIS, '')}`] : [];
    });
}
