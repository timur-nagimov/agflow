import { describe, expect, test } from 'bun:test';
import { codexTrustOverride } from '../scripts/codex-trust';

describe('codexTrustOverride', () => {
  const repo = '/private/var/folders/ab/xyz/T/agflow-real-AbC123/work';

  test('keeps the -c key a bare word and puts the repository path in the TOML value', () => {
    const override = codexTrustOverride(repo);
    // Codex splits the -c key on dots and keeps quote characters, so a key that carries the path never matches it.
    expect(override.slice(0, override.indexOf('='))).toBe('projects');
    expect(override).toBe(`projects={"${repo}"={trust_level="trusted"}}`);
  });

  test('parses as TOML into a table that trusts exactly that repository', () => {
    expect(Bun.TOML.parse(codexTrustOverride(repo))).toEqual({ projects: { [repo]: { trust_level: 'trusted' } } });
  });

  test('escapes quotes, backslashes, spaces and dots in the path', () => {
    const odd = '/tmp/we"ird\\dir with space/work.v2';
    expect(Bun.TOML.parse(codexTrustOverride(odd))).toEqual({ projects: { [odd]: { trust_level: 'trusted' } } });
  });
});
