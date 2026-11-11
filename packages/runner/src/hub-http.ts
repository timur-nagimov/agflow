// The runner's HTTP calls to the hub (design 6.3, 6.16), all with the CLI token: whoami, which tells a refused token
// from anything else after a refused link; the project's name and repo from GET /api/status, which name the vault
// and work directories; and transcript tails for handoff notes. The credentials are read on every call, so a call
// after `agflow login` uses the new token.
import {
  OkResponseSchema,
  TRANSCRIPT_TAIL_MAX_BYTES,
  TranscriptInputSchema,
  WhoamiResponseSchema,
} from '@agflow/core';
import { z } from 'zod';
import type { CredentialsProvider } from './link';

export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** status is the HTTP status, or 0 when there was no answer: unreachable, signed out, or an unreadable body. */
export class RunnerHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RunnerHttpError';
  }
}

export interface RunnerHubHttpOptions {
  credentials: CredentialsProvider;
  fetch?: FetchFn;
  /** Per request; 15 s. */
  timeoutMs?: number;
}

/** Only the two fields the runner needs; the rest of the status may grow without breaking it. */
const ProjectStatusSchema = z.object({ project: z.object({ name: z.string().min(1), repo: z.string() }) });

/**
 * The end of a transcript within the byte limit, cut at a character boundary: UTF-8 continuation bytes at the cut
 * are dropped, never split.
 */
export function clipTranscriptTail(text: string, maxBytes: number = TRANSCRIPT_TAIL_MAX_BYTES): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;
  let start = bytes.length - maxBytes;
  while (start < bytes.length && ((bytes[start] as number) & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString('utf8');
}

export class RunnerHubHttp {
  private readonly fetchFn: FetchFn;
  private readonly timeoutMs: number;

  constructor(private readonly options: RunnerHubHttpOptions) {
    this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  /** GET /api/runner/whoami: the signed-in user. A refused token is a RunnerHttpError with status 401. */
  async whoami(): Promise<{ user: string }> {
    const path = '/api/runner/whoami';
    return this.parse(WhoamiResponseSchema, await this.request('GET', path), path);
  }

  /** The project's name and repo, from GET /api/status. */
  async projectStatus(): Promise<{ name: string; repo: string }> {
    const { project } = this.parse(ProjectStatusSchema, await this.request('GET', '/api/status'), '/api/status');
    return { name: project.name, repo: project.repo };
  }

  /** Posts the end of an attempt's transcript, clipped to 64 KB. */
  async uploadTranscript(attemptId: string, transcript: string): Promise<void> {
    const path = `/api/runner/attempts/${encodeURIComponent(attemptId)}/transcript`;
    const body = TranscriptInputSchema.parse({ tail: clipTranscriptTail(transcript) });
    this.parse(OkResponseSchema, await this.request('POST', path, body), path);
  }

  private parse<T>(schema: z.ZodType<T>, value: unknown, path: string): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw new RunnerHttpError(0, 'bad_response', `the hub answered ${path} with an unexpected body`);
    }
    return parsed.data;
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const credentials = await this.options.credentials();
    if (!credentials) throw new RunnerHttpError(0, 'signed_out', 'not signed in to an agflow hub; run agflow login');
    const base = credentials.hubUrl.replace(/\/+$/, '');
    const headers: Record<string, string> = {
      accept: 'application/json',
      authorization: `Bearer ${credentials.token}`,
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    let response: Response;
    try {
      response = await this.fetchFn(`${base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new RunnerHttpError(0, 'unreachable', `cannot reach the agflow hub at ${base}: ${reason}`);
    }
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!response.ok) {
      const error = (json ?? {}) as { error?: unknown; message?: unknown };
      throw new RunnerHttpError(
        response.status,
        typeof error.error === 'string' ? error.error : 'http_error',
        typeof error.message === 'string' ? error.message : `${method} ${path} failed with HTTP ${response.status}`,
      );
    }
    return json;
  }
}
