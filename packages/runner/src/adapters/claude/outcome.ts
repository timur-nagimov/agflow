// A Claude turn's result as turn_ended's outcome and errorKind (design 8.3, 6.10): limit hits, vendor errors, auth,
// context and policy kept apart, so the controller waits for quota, retries the vendor, or reports a vendor outcome.
// The CLI's texts are 2.1.285's, copied from the binary.
import type { SDKAssistantMessageError, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent } from '../types';
import { isLimitHitText } from './quota';

type TurnEnded = Extract<AgentEvent, { type: 'turn_ended' }>;

export type ResultClassification = Pick<TurnEnded, 'outcome' | 'errorKind' | 'error'>;

export interface ResultContext {
  /** The runner interrupted the turn and its result has not arrived yet: the runner's flag decides (design 8.3). */
  interruptPending: boolean;
  /** The error of the turn's last main-thread assistant message, when that message wrapped an API error. */
  assistantError?: SDKAssistantMessageError | null;
}

/** 2.1.285's messages for a login that is missing, expired, revoked or refused. */
const AUTH_TEXTS = [
  'Not logged in',
  'Login expired',
  'OAuth token revoked',
  'Authentication required',
  'Invalid API key',
  'Invalid auth token',
  'Failed to authenticate',
  'Your organization has disabled',
  'Your ANTHROPIC_API_KEY belongs to a disabled organization',
  'Your account does not have access to Claude',
];
const AUTH_ERRORS: readonly SDKAssistantMessageError[] = [
  'authentication_failed',
  'oauth_org_not_allowed',
  'account_on_hold',
];
const CONTEXT_TEXTS = ['Prompt is too long', 'Autocompact is thrashing'];
/**
 * The terminal reasons of a full context window: blocking_limit is the context estimate at its limit before any API
 * call, rapid_refill_breaker automatic compaction refilling it each time. 2.1.285 groups them as context_limit; none
 * is a usage limit, which ends as an API error with a usage-limit text instead.
 */
const CONTEXT_REASONS: readonly string[] = ['blocking_limit', 'rapid_refill_breaker', 'prompt_too_long'];
const CONTEXT_API_ERRORS = ['autocompact_thrashing'];
/** The untyped result.api_error values for a request the API's safety checks blocked. */
const POLICY_API_ERRORS = ['dlp_request_denied', 'safety_monitor_blocked'];

/**
 * outcome: completed for a normal end, interrupted for an error_during_execution while the runner's interrupt is
 * pending, failed otherwise (any is_error, and a refusal). A failure's errorKind is policy for a refusal, quota for a
 * limit hit, context for a full context window, auth or policy for those vendor outcomes, vendor for any other API
 * error (429 and 529 after retries included), and null for a failure the CLI gives no cause for.
 */
export function classifyResult(result: SDKResultMessage, context: ResultContext): ResultClassification {
  if (context.interruptPending && result.subtype === 'error_during_execution') {
    return { outcome: 'interrupted', errorKind: null, error: null };
  }
  const refused = result.stop_reason === 'refusal';
  if (result.subtype === 'success' && !result.is_error && !refused) {
    return { outcome: 'completed', errorKind: null, error: null };
  }
  const text = (result.subtype === 'success' ? result.result : result.errors.join('\n')).trim();
  const error = text !== '' ? text : refused ? 'the model declined the request (stop_reason refusal)' : null;
  return { outcome: 'failed', errorKind: errorKind(result, text, refused, context), error };
}

/** Text tests apply to CLI-written error text only: an is_error result's, or an error subtype's errors. */
function errorKind(
  result: SDKResultMessage,
  text: string,
  refused: boolean,
  context: ResultContext,
): TurnEnded['errorKind'] {
  const reason = result.terminal_reason;
  // Untyped in sdk.d.ts on error subtypes (api_error_status) or everywhere (api_error).
  const { api_error_status: status, api_error: apiError } = result as {
    api_error_status?: unknown;
    api_error?: unknown;
  };
  const assistantError = context.assistantError ?? null;
  // A refusal's text is the model's own partial answer, not the CLI's: no text decides its kind.
  if (refused) return 'policy';
  if (isLimitHitText(text)) return 'quota';
  if (
    (reason !== undefined && CONTEXT_REASONS.includes(reason)) ||
    (typeof apiError === 'string' && CONTEXT_API_ERRORS.includes(apiError)) ||
    startsWithAny(text, CONTEXT_TEXTS)
  ) {
    return 'context';
  }
  if (
    status === 401 ||
    (assistantError !== null && AUTH_ERRORS.includes(assistantError)) ||
    startsWithAny(text, AUTH_TEXTS)
  ) {
    return 'auth';
  }
  if (typeof apiError === 'string' && POLICY_API_ERRORS.includes(apiError)) return 'policy';
  if (
    reason === 'api_error' ||
    reason === 'model_error' ||
    typeof status === 'number' ||
    assistantError !== null ||
    text.startsWith('API Error')
  ) {
    return 'vendor';
  }
  return null;
}

function startsWithAny(text: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => text.startsWith(prefix));
}
