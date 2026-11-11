// The guard for the SDK's untyped frames and files (transcripts, settings, rate-limit and lifecycle fields): every
// field is read off a plain object, never off an array or null.
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
