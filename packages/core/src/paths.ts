/** Drops repeated slashes and "." segments, which some glob engines ignore. */
function normalizePattern(pattern: string): string {
  return pattern
    .replace(/\/{2,}/g, '/')
    .replace(/^(?:\.(?:\/|$))+/, '')
    .replace(/\/\.(?=\/|$)/g, '');
}

/**
 * Owned-path patterns are repo-relative globs. Glob engines read a leading "/" or "!", a ".."
 * segment, "\", "(" and "|" in different ways (absolute path, negation, parent directory, escape,
 * extglob, group or alternation), so they are outside the supported syntax and are rejected
 * rather than guessed.
 */
export function isSupportedPattern(pattern: string): boolean {
  const normalized = normalizePattern(pattern);
  return !(
    normalized.startsWith('/') ||
    normalized.startsWith('!') ||
    /[\\(|]/.test(normalized) ||
    normalized.split('/').includes('..')
  );
}

/**
 * Where the literal prefix ends: at the first character a glob engine might read as syntax. That is
 * anything but letters, digits and "_ - . / @", an "@" that opens "@(", and a "." that is not
 * followed by more of a name ("a./", "a.{1..3}"), which picomatch reads as a dot segment or a regex
 * wildcard.
 */
const LITERAL_END = /[^\p{L}\p{N}_.\-\/@]|@(?=\()|\.(?![\p{L}\p{N}_.\-@])/u;

/**
 * The literal part of a path pattern: everything before the first character that is not plainly
 * literal, ignoring redundant "./" and "//". A pattern outside the supported syntax has no usable
 * prefix, so it gives "".
 */
export function patternPrefix(pattern: string): string {
  if (!isSupportedPattern(pattern)) return '';
  const normalized = normalizePattern(pattern);
  const cut = normalized.search(LITERAL_END);
  return cut === -1 ? normalized : normalized.slice(0, cut);
}

/**
 * Conservative overlap test for owned-path patterns. Any path matching a pattern starts with that
 * pattern's literal prefix, so two patterns can only share a path when one prefix starts with the
 * other. A pattern that cannot be reasoned about has the empty prefix, which overlaps everything.
 * The test may flag pairs that cannot actually collide, but it never misses a real overlap.
 */
export function pathsOverlap(a: readonly string[], b: readonly string[]): boolean {
  return a.some((x) =>
    b.some((y) => {
      const px = patternPrefix(x);
      const py = patternPrefix(y);
      return px.startsWith(py) || py.startsWith(px);
    }),
  );
}
