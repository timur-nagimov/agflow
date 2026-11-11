import { describe, expect, test } from 'bun:test';
import { FIXABLE_SUBMIT_ERRORS, SUBMIT_ERRORS, splitSubmitError } from '../src/submit-errors';

describe('splitSubmitError', () => {
  test('a bare code has no detail', () => {
    for (const code of SUBMIT_ERRORS) expect(splitSubmitError(code)).toEqual({ code, detail: null });
  });

  test("'<code>: <detail>' gives the code and the runner's detail as it came", () => {
    const detail = 'merge main rather than revert: main changed .github/workflows/ci.yml';
    expect(splitSubmitError(`protected_paths: ${detail}`)).toEqual({ code: 'protected_paths', detail });
    expect(splitSubmitError('needs_merge: a\nb')).toEqual({ code: 'needs_merge', detail: 'a\nb' });
  });

  test("the hub's own words have no code: the text is the detail", () => {
    for (const error of ['attempt ended: stalled', 'refused', 'remote failure: 503', 'dirty:x']) {
      expect(splitSubmitError(error)).toEqual({ code: null, detail: error });
    }
  });

  test('the fixable codes are submit codes', () => {
    for (const code of FIXABLE_SUBMIT_ERRORS) expect(SUBMIT_ERRORS).toContain(code);
  });

  test('the module imports nothing, so the web UI may import its values (X-48)', async () => {
    const source = await Bun.file(new URL('../src/submit-errors.ts', import.meta.url)).text();
    expect([...source.matchAll(/from '([^']+)'/g)]).toEqual([]);
  });
});
