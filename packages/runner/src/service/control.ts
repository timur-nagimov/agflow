// JSON over a private Unix socket; the service owns it only while holding runner.lock (design 7.1–7.2).
import { chmodSync, lstatSync, unlinkSync } from 'node:fs';
import type { RunnerPaths } from '../paths';
import { assertRunnerLock, type RunnerLock } from './lock';

/** Keys are 'METHOD /path'; handlers receive parsed POST JSON (undefined if empty) and the query. */
export type ControlRoutes = Record<string, (body: unknown, query: URLSearchParams) => unknown | Promise<unknown>>;

export interface ControlServer {
  readonly path: string;
  /** Closes active connections too, including requests whose handlers never resolved. */
  stop(): void;
}

export class ControlUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ControlUnavailableError';
  }
}

/** macOS sun_path has 104 bytes including its trailing NUL. Use the same limit on Linux. */
export function checkSocketPath(path: string): void {
  if (Buffer.byteLength(path) > 103) {
    throw new Error(`control socket path ${path} exceeds 103 bytes; choose a shorter AGFLOW_HOME`);
  }
}

function removeSocket(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

const serving = new WeakSet<RunnerLock>();

/** Binds runner.sock (mode 0600) for the lock holder, replacing a stale socket a crashed runner left behind. */
export function startControlServer(options: {
  lock: RunnerLock;
  paths: RunnerPaths;
  routes: ControlRoutes;
}): ControlServer {
  const { lock, paths, routes } = options;
  const path = paths.socket;
  checkSocketPath(path);
  assertRunnerLock(lock, paths);
  if (serving.has(lock)) throw new Error('this runner lock already has a control server');
  removeSocket(path);
  const previousUmask = process.umask(0o177);
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      unix: path,
      async fetch(request, server) {
        // Checks and graceful stops can run for longer than Bun's default idle timeout.
        server.timeout(request, 0);
        const url = new URL(request.url);
        const key = `${request.method} ${url.pathname}`;
        const handler = Object.hasOwn(routes, key) ? routes[key] : undefined;
        if (!handler) return Response.json({ error: `unknown control route: ${key}` }, { status: 404 });
        let body: unknown;
        if (request.method === 'POST') {
          try {
            const text = await request.text();
            body = text === '' ? undefined : JSON.parse(text);
          } catch {
            return Response.json({ error: 'request body is not valid JSON' }, { status: 400 });
          }
        }
        try {
          // Routes that only act (drain, stop) return nothing; JSON has no undefined.
          return Response.json((await handler(body, url.searchParams)) ?? null);
        } catch (error) {
          return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
        }
      },
    });
  } finally {
    process.umask(previousUmask);
  }
  let identity: ReturnType<typeof lstatSync>;
  try {
    chmodSync(path, 0o600);
    identity = lstatSync(path);
  } catch (error) {
    void server.stop(true);
    removeSocket(path);
    throw error;
  }
  serving.add(lock);
  let stopped = false;
  return {
    path,
    stop() {
      if (stopped) return;
      stopped = true;
      // Bun's promise waits for handlers too; an unresponsive handler must not delay shutdown.
      void server.stop(true);
      // A late stop must not remove a replacement socket after the lock was released.
      try {
        const current = lstatSync(path);
        if (current.dev === identity.dev && current.ino === identity.ino) removeSocket(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      } finally {
        serving.delete(lock);
      }
    },
  };
}

/** One JSON request to the running runner; no listener, or no answer in time, is ControlUnavailableError. */
export async function controlRequest<T = unknown>(
  paths: RunnerPaths,
  method: string,
  path: string,
  body?: unknown,
  options: { timeoutMs?: number } = {},
): Promise<T> {
  checkSocketPath(paths.socket);
  const timeoutMs = options.timeoutMs ?? 3_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('control timeoutMs must be positive');
  const signal = AbortSignal.timeout(timeoutMs);
  let response: Response;
  let result: unknown;
  try {
    response = await fetch(`http://localhost${path}`, {
      unix: paths.socket,
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    result = await response.json();
  } catch (error) {
    if (signal.aborted) {
      throw new ControlUnavailableError(`runner control request timed out after ${timeoutMs} ms`, { cause: error });
    }
    const code = (error as NodeJS.ErrnoException).code;
    // Bun 1.3.11 reports failed Unix connects as FailedToOpenSocket on macOS.
    if (code === 'ENOENT' || code === 'ECONNREFUSED' || code === 'FailedToOpenSocket') {
      throw new ControlUnavailableError(`no runner is listening on ${paths.socket}`, { cause: error });
    }
    throw error;
  }
  if (!response.ok) {
    const message =
      result && typeof result === 'object' && 'error' in result ? String(result.error) : response.statusText;
    throw new Error(message);
  }
  return result as T;
}
