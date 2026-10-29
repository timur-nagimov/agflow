// runner.json's test.claudeEnv for a test (design 15.1, X-20): the CLI talks to the scripted Messages API with a fake
// key, never retries unless a test asks, sends no non-essential traffic, and reaches every other host only through the
// refusing proxy, which records the attempt.

/** A key the scripted server accepts; it is no real key and reaches no real API. */
export const CLAUDE_TEST_API_KEY = 'sk-ant-api03-agflow-test-dummy-key';

export interface ClaudeTestEnvOptions {
  /** The scripted server's url. */
  baseUrl: string;
  /** The refusing proxy's url. */
  proxyUrl: string;
  /** CLAUDE_CODE_MAX_RETRIES, 0 by default so an error reaches the adapter at once. */
  maxRetries?: number;
}

export function claudeTestEnv(options: ClaudeTestEnvOptions): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: options.baseUrl,
    ANTHROPIC_API_KEY: CLAUDE_TEST_API_KEY,
    CLAUDE_CODE_MAX_RETRIES: String(options.maxRetries ?? 0),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    HTTPS_PROXY: options.proxyUrl,
    HTTP_PROXY: options.proxyUrl,
    // The scripted server and the test hub listen on the loopback interface and are reached directly.
    NO_PROXY: '127.0.0.1,localhost',
  };
}
