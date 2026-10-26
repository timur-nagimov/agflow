/** The literal part of a path pattern before its first wildcard, without a leading "./". */
export function patternPrefix(pattern: string): string {
  const cut = pattern.search(/[*?[{]/);
  const literal = cut === -1 ? pattern : pattern.slice(0, cut);
  return literal.replace(/^\.\//, '');
}

/**
 * Conservative overlap test for owned-path patterns. Any path matching a pattern starts with that
 * pattern's literal prefix, so two patterns can only share a path when one prefix starts with the
 * other. The test may flag pairs that cannot actually collide, but it never misses a real overlap.
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
