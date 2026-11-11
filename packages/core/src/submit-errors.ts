// The codes of a runner's submission outcomes (design 6.13) and how SubmissionRecord.error spells a failure. The web
// UI imports these values, so the module stays free of zod (X-48); runner-protocol.ts builds its schema from them.

/** attempt.submitted error codes. */
export const SUBMIT_ERRORS = [
  'dirty',
  'protected_paths',
  'needs_merge',
  'branch_moved',
  'remote',
  'interrupted',
] as const;
export type SubmitError = (typeof SUBMIT_ERRORS)[number];

/** The submit refusals that go back to the agent to fix. */
export const FIXABLE_SUBMIT_ERRORS = [
  'dirty',
  'protected_paths',
  'needs_merge',
] as const satisfies readonly SubmitError[];

const isSubmitError = (text: string): text is SubmitError => (SUBMIT_ERRORS as readonly string[]).includes(text);

/**
 * Reads SubmissionRecord.error: a runner's refusal, '<code>' or '<code>: <the runner's detail>', gives its code and the
 * detail as it came (null for a bare code); anything else is the hub's own words, such as 'attempt ended: stalled',
 * with no code and the whole text as the detail. The runner's bridge and the web UI both read it this way.
 */
export function splitSubmitError(error: string): { code: SubmitError | null; detail: string | null } {
  if (isSubmitError(error)) return { code: error, detail: null };
  const colon = error.indexOf(': ');
  const code = colon === -1 ? '' : error.slice(0, colon);
  if (isSubmitError(code)) return { code, detail: error.slice(colon + 2) };
  return { code: null, detail: error };
}
