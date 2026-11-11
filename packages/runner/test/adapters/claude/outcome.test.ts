import { describe, expect, test } from 'bun:test';
import { loadRecording } from '@agflow/testkit/src/fake-claude';
import type { SDKResultError, SDKResultMessage, SDKResultSuccess } from '@anthropic-ai/claude-agent-sdk';
import { classifyResult } from '../../../src/adapters/claude/outcome';
import { USAGE_DISABLED_PREFIXES, USAGE_LIMIT_PREFIXES } from '../../../src/adapters/claude/quota';

/** The result frames a recording printed, by subtype. */
function recordedResult(scenario: string, subtype: SDKResultMessage['subtype']): SDKResultMessage {
  for (const step of loadRecording(scenario).turns.flat()) {
    if ('frame' in step && step.frame.type === 'result' && step.frame.subtype === subtype) {
      return structuredClone(step.frame) as unknown as SDKResultMessage;
    }
  }
  throw new Error(`${scenario} has no ${subtype} result`);
}

const success = recordedResult('turn-basic', 'success') as SDKResultSuccess;
const aborted = recordedResult('interrupt', 'error_during_execution') as SDKResultError;

/** A turn that ended on an API error: success with is_error, the error text as the result. */
function apiError(result: string, fields: Partial<SDKResultSuccess> & Record<string, unknown> = {}): SDKResultSuccess {
  return {
    ...success,
    is_error: true,
    result,
    stop_reason: 'stop_sequence',
    terminal_reason: 'api_error',
    ...fields,
  } as SDKResultSuccess;
}

const idle = { interruptPending: false };

describe('classifyResult', () => {
  test('success gives completed and is_error gives failed', () => {
    expect(success.is_error).toBe(false);
    expect(classifyResult(success, idle)).toEqual({ outcome: 'completed', errorKind: null, error: null });
    expect(classifyResult({ ...success, is_error: true, result: 'boom', terminal_reason: undefined }, idle)).toEqual({
      outcome: 'failed',
      errorKind: null,
      error: 'boom',
    });
  });

  test('with the pending-interrupt flag set, error_during_execution gives interrupted, whatever its terminal_reason', () => {
    expect(aborted.terminal_reason).toBe('aborted_tools');
    const pending = { interruptPending: true };
    for (const terminal_reason of ['aborted_tools', 'aborted_streaming', 'api_error', undefined] as const) {
      expect(classifyResult({ ...aborted, terminal_reason }, pending)).toEqual({
        outcome: 'interrupted',
        errorKind: null,
        error: null,
      });
    }
    // A turn that finished before the interrupt landed is still a completed turn.
    expect(classifyResult(success, pending).outcome).toBe('completed');
  });

  test('without the flag, error_during_execution is a failure with its errors', () => {
    expect(classifyResult(aborted, idle)).toEqual({
      outcome: 'failed',
      errorKind: null,
      error: aborted.errors.join('\n'),
    });
    expect(classifyResult({ ...aborted, errors: [] }, idle)).toEqual({
      outcome: 'failed',
      errorKind: null,
      error: null,
    });
  });

  test('terminal_reason blocking_limit or rapid_refill_breaker is a full context, never quota', () => {
    const tooLong = 'Prompt is too long';
    const blocked = apiError(tooLong, { terminal_reason: 'blocking_limit', api_error: 'invalid_request' });
    expect(classifyResult(blocked, idle)).toEqual({ outcome: 'failed', errorKind: 'context', error: tooLong });
    const thrashing = 'Autocompact is thrashing: the context refilled to the limit right after compacting';
    const refilled = { terminal_reason: 'rapid_refill_breaker', api_error: 'autocompact_thrashing' } as const;
    expect(classifyResult(apiError(thrashing, refilled), idle).errorKind).toBe('context');
    // Each signal on its own.
    for (const fields of [
      { terminal_reason: 'blocking_limit' },
      { terminal_reason: 'rapid_refill_breaker' },
      { terminal_reason: undefined, api_error: 'autocompact_thrashing' },
    ] as const) {
      expect(classifyResult(apiError('API Error: stopped', fields), idle).errorKind).toBe('context');
    }
    expect(classifyResult(apiError(thrashing, { terminal_reason: undefined }), idle).errorKind).toBe('context');
  });

  test('result text that starts with one of USAGE_LIMIT_PREFIXES gives errorKind quota', () => {
    const text = "You've hit your session limit · resets 3pm (Europe/Moscow)";
    const limited = apiError(text, { api_error_status: 429 });
    expect(classifyResult(limited, { interruptPending: false, assistantError: 'rate_limit' })).toEqual({
      outcome: 'failed',
      errorKind: 'quota',
      error: text,
    });
    for (const prefix of [...USAGE_LIMIT_PREFIXES, ...USAGE_DISABLED_PREFIXES]) {
      expect(classifyResult(apiError(`${prefix} …`), idle).errorKind).toBe('quota');
    }
    // The text of a rejected status whose overage the organisation's service level disables.
    expect(classifyResult(apiError('This service is disabled for your org'), idle).errorKind).toBe('quota');
  });

  test('prompt_too_long gives context', () => {
    expect(classifyResult(apiError('Prompt is too long', { terminal_reason: 'prompt_too_long' }), idle).errorKind).toBe(
      'context',
    );
    const overflow = apiError('Prompt is too long: 210000 tokens > 200000 maximum');
    expect(classifyResult(overflow, idle).errorKind).toBe('context');
  });

  test('an expired or invalid login gives auth', () => {
    for (const text of [
      'Not logged in · Please run /login',
      'Login expired · Please run /login',
      'OAuth token revoked · Please run /login',
      'Invalid API key · Fix external API key',
      'Failed to authenticate: OAuth session expired and could not be refreshed',
      'Authentication required · Sign in again to continue',
    ]) {
      expect(classifyResult(apiError(text), idle)).toMatchObject({ outcome: 'failed', errorKind: 'auth', error: text });
    }
    expect(classifyResult(apiError('API Error: 401', { api_error_status: 401 }), idle).errorKind).toBe('auth');
    const login = { interruptPending: false, assistantError: 'authentication_failed' as const };
    expect(classifyResult(apiError('something new'), login).errorKind).toBe('auth');
  });

  test('a policy refusal gives policy', () => {
    const refused = { ...success, stop_reason: 'refusal', result: '', terminal_reason: 'completed' as const };
    expect(classifyResult(refused, idle)).toEqual({
      outcome: 'failed',
      errorKind: 'policy',
      error: 'the model declined the request (stop_reason refusal)',
    });
    const blocked = apiError('API Error: blocked', { api_error: 'safety_monitor_blocked' });
    expect(classifyResult(blocked, idle).errorKind).toBe('policy');
  });

  test("a refusal's own text never decides its kind", () => {
    for (const text of [`${USAGE_LIMIT_PREFIXES[0]} limit · resets 3pm`, 'Not logged in', 'Prompt is too long']) {
      const refused = { ...success, stop_reason: 'refusal', result: text, terminal_reason: 'completed' as const };
      expect(classifyResult(refused, idle)).toEqual({ outcome: 'failed', errorKind: 'policy', error: text });
    }
  });

  test('api_error, model_error, and 429 or 529 after retries give vendor, never quota', () => {
    expect(classifyResult(apiError('API Error: 500 Internal server error'), idle)).toMatchObject({
      outcome: 'failed',
      errorKind: 'vendor',
    });
    const modelError = apiError('API Error: bad model output', { terminal_reason: 'model_error' });
    expect(classifyResult(modelError, idle).errorKind).toBe('vendor');
    // Each vendor signal on its own, without any other.
    for (const terminal_reason of ['api_error', 'model_error'] as const) {
      expect(classifyResult(apiError('Something went wrong', { terminal_reason }), idle).errorKind).toBe('vendor');
    }
    const textOnly = apiError('API Error: Connection error.', { terminal_reason: undefined });
    expect(classifyResult(textOnly, idle).errorKind).toBe('vendor');
    expect(classifyResult(apiError('Something went wrong', { terminal_reason: undefined }), idle).errorKind).toBeNull();
    for (const [status, assistantError] of [
      [429, 'rate_limit'],
      [529, 'overloaded'],
    ] as const) {
      const result = apiError(`API Error: ${status} {"type":"error","error":{"type":"${assistantError}_error"}}`, {
        api_error_status: status,
        terminal_reason: undefined,
      });
      expect(classifyResult(result, { interruptPending: false, assistantError }).errorKind).toBe('vendor');
      expect(classifyResult(result, idle).errorKind).toBe('vendor');
    }
    expect(
      classifyResult(apiError('Request timed out', { terminal_reason: undefined }), {
        interruptPending: false,
        assistantError: 'server_error',
      }).errorKind,
    ).toBe('vendor');
  });
});
