// runner.json's test.codexConfig for the scripted provider (design 15.1). The runner passes each top-level key to
// app-server as a -c flag in test mode; no Codex home's config.toml is written.

// A type alias, not an interface: only an object-literal type fits test.codexConfig's Record<string, JSON> as it is.
export type CodexTestConfig = {
  model_provider: 'agflow_test';
  model_providers: {
    agflow_test: {
      name: string;
      base_url: string;
      wire_api: 'responses';
      requires_openai_auth: false;
      request_max_retries: number;
      stream_max_retries: number;
      stream_idle_timeout_ms: number;
    };
  };
};

/** Codex's own default; a test of a stalled stream passes a short one. */
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000;

/**
 * Points Codex at a scripted Responses server (its url, ending in /v1). Retries are off, so every scripted failure
 * reaches the adapter at once, as the final error.
 */
export function codexTestConfig(url: string, options: { streamIdleTimeoutMs?: number } = {}): CodexTestConfig {
  return {
    model_provider: 'agflow_test',
    model_providers: {
      agflow_test: {
        name: 'agflow test',
        base_url: url,
        wire_api: 'responses',
        requires_openai_auth: false,
        request_max_retries: 0,
        stream_max_retries: 0,
        stream_idle_timeout_ms: options.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
      },
    },
  };
}
