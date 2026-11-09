// Starting `codex app-server` (design 9.1, 7.4), the one way preflight, transcript deletion and sessions open it:
// detached in its own process group, recorded before any output is read, stderr drained with a bound, initialized
// with a version check, and ended through stdin EOF, SIGTERM and SIGKILL with every wait bounded.
import { AGFLOW_VERSION } from '@agflow/core';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { type Logger, noopLogger } from '../../log';
import { boundedWait, drainToLog } from '../../processes';
import type { ExitInfo } from '../types';
import type { InitializeResponse } from './protocol/InitializeResponse';
import { CodexRpc, RpcClosed } from './rpc';

export interface OpenAppServerOptions {
  /** The native binary in the runner's vendor directory. */
  bin: string;
  /** appServerArgs(...). */
  args: string[];
  /** appServerEnv(...); CODEX_HOME is required and keys the startup lock. */
  env: Record<string, string>;
  cwd: string;
  /** The pin, or the attempt's recorded cliVersion on resume. */
  expectedVersion: string;
  /** stderr is appended through drainToLog. */
  logFile: string;
  /** Called synchronously after spawn, before either pipe is read. */
  onSpawn?: (pid: number) => void;
  logger?: Logger;
  /** Passed to CodexRpc for requests after initialization. */
  requestTimeoutMs?: number;
  /** Defaults to 30 seconds. */
  initializeTimeoutMs?: number;
  /** Defaults to 4 MiB; the pipe is still drained past this bound. */
  maxStderrBytes?: number;
}

export interface AppServerProcess {
  readonly pid: number;
  readonly rpc: CodexRpc;
  readonly initialize: InitializeResponse;
  readonly exited: Promise<ExitInfo>;
  /** stdin EOF, SIGTERM, SIGKILL, then bounded pipe waiting; every call returns the same promise. */
  end(options?: { closeMs?: number; termMs?: number; pipesMs?: number }): Promise<ExitInfo | null>;
}

const startups = new Map<string, Promise<void>>();
const SQLITE_FAILURE = 'failed to initialize sqlite state runtime';
const STDERR_HEAD_BYTES = 4096;
// userAgent is `agflow/0.159.2 (Mac OS 26.6.2; arm64) ...`: the version follows the client name.
const USER_AGENT_VERSION = /^[^/]+\/([^\s/]+)(?: |$)/;
const PIPES_MS = 1000;

class StartupExit extends Error {
  constructor(
    message: string,
    readonly retry: boolean,
  ) {
    super(message);
  }
}

export async function openAppServer(options: OpenAppServerOptions): Promise<AppServerProcess> {
  if (!options.env.CODEX_HOME) throw new Error('CODEX_HOME is required');
  const home = resolve(options.env.CODEX_HOME);
  // A 2026-10-28 probe: two starts at once on a fresh home failed in 5 of 10 runs with SQLITE_FAILURE, while 30
  // concurrent starts on an initialized home all worked. So starts on one home wait for each other until initialize
  // answers, and the sqlite exit gets one retry inside the lock unless the caller registers the pid.
  const previous = startups.get(home);
  let release!: () => void;
  const current = new Promise<void>((done) => {
    release = done;
  });
  startups.set(home, current);
  await previous;
  try {
    try {
      return await start(options);
    } catch (error) {
      // A registered launch records exactly one pid, so with onSpawn the caller's own retry starts it again.
      if (!(error instanceof StartupExit) || !error.retry || options.onSpawn) throw error;
      return await start(options);
    }
  } finally {
    release();
    if (startups.get(home) === current) startups.delete(home);
  }
}

async function start(options: OpenAppServerOptions): Promise<AppServerProcess> {
  const logger = options.logger ?? noopLogger;
  let proc: ReturnType<typeof Bun.spawn<'pipe', 'pipe', 'pipe'>>;
  try {
    proc = Bun.spawn([options.bin, ...options.args], {
      cwd: options.cwd,
      env: options.env,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      detached: true,
    });
  } catch (error) {
    // Bun gives the same ENOENT for a missing cwd, such as a removed clone.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    throw new Error(existsSync(options.bin) ? `working directory missing: ${options.cwd}` : 'binary missing');
  }

  let spawnError: { error: unknown } | undefined;
  try {
    options.onSpawn?.(proc.pid);
  } catch (error) {
    spawnError = { error };
    signal('SIGKILL');
  }

  function signal(name: NodeJS.Signals): void {
    try {
      process.kill(-proc.pid, name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        logger.warn('codex app-server: group signal failed', { pid: proc.pid, signal: name, error: String(error) });
      }
    }
  }

  let exit: ExitInfo | null = null;
  const exited = proc.exited.then(() => {
    exit = { code: proc.exitCode, signal: proc.signalCode };
    // Kill pipe holders now, while the group still has members and its id cannot have been reused.
    signal('SIGKILL');
    return exit;
  });
  let starting = true;
  let head = Buffer.alloc(0);
  const stderr = pipe(proc.stderr, (chunk) => {
    if (starting && head.length < STDERR_HEAD_BYTES) {
      head = Buffer.concat([head, chunk.subarray(0, STDERR_HEAD_BYTES - head.length)]);
    }
  });
  const stdout = pipe(proc.stdout);
  const drained = drainToLog(stderr.read(), options.logFile, { maxBytes: options.maxStderrBytes ?? 4 * 1024 * 1024 })
    .catch((error: unknown) => {
      logger.warn('codex app-server: stderr log failed', { error: String(error) });
    })
    .then(async () => {
      // Opening the log can fail; the pipe is still read to its end, or app-server would block on it.
      for await (const _chunk of stderr.read()) {
        // Dropped.
      }
    });
  const rpc = new CodexRpc({
    stdin: proc.stdin,
    stdout: stdout.read(),
    logger,
    requestTimeoutMs: options.requestTimeoutMs,
  });
  const pipes = Promise.all([rpc.ended, drained]);
  let ending: Promise<ExitInfo | null> | undefined;
  const end: AppServerProcess['end'] = (bounds = {}) => {
    ending ??= (async () => {
      const pipesMs = bounds.pipesMs ?? PIPES_MS;
      const alreadyClosed = rpc.closed;
      rpc.close();
      // stdout EOF closes the transport without ending stdin.
      if (alreadyClosed) {
        try {
          void Promise.resolve(proc.stdin.end()).catch((error: unknown) => {
            logger.debug('codex app-server: ending stdin failed', { error: String(error) });
          });
        } catch (error) {
          logger.debug('codex app-server: ending stdin failed', { error: String(error) });
        }
      }
      if (!exit) await boundedWait(exited, bounds.closeMs ?? 2000);
      if (!exit) {
        signal('SIGTERM');
        await boundedWait(exited, bounds.termMs ?? 5000);
      }
      if (!exit) {
        signal('SIGKILL');
        await boundedWait(exited, pipesMs);
      }
      if (!(await boundedWait(pipes, pipesMs)).done) {
        stdout.cancel();
        stderr.cancel();
      }
      return exit;
    })();
    return ending;
  };

  try {
    if (spawnError) throw spawnError.error;
    let initialize: InitializeResponse;
    try {
      initialize = await Promise.race([
        rpc.request(
          'initialize',
          { clientInfo: { name: 'agflow', title: null, version: AGFLOW_VERSION }, capabilities: null },
          { timeoutMs: options.initializeTimeoutMs ?? 30_000 },
        ),
        exited.then(() => {
          throw new RpcClosed('initialize');
        }),
      ]);
    } catch (error) {
      if (!(error instanceof RpcClosed)) throw error;
      const stopped = await boundedWait(exited, PIPES_MS);
      await boundedWait(drained, PIPES_MS);
      const text = head.toString('utf8');
      const lines = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      // 0.159.2 prints a WARNING before the Error line (a missing CODEX_HOME), so an Error line is the reason when
      // there is one.
      const reason = lines.find((line) => line.startsWith('Error:')) ?? lines[0];
      const how = stopped.done
        ? stopped.value.signal
          ? `signal ${stopped.value.signal}`
          : `code ${stopped.value.code}`
        : null;
      const outcome = how
        ? `codex app-server exited with ${how}`
        : 'codex app-server stdout ended before initialize answered';
      throw new StartupExit(reason ?? outcome, stopped.done && text.includes(SQLITE_FAILURE));
    }
    starting = false;
    head = Buffer.alloc(0);
    const agent: unknown = initialize?.userAgent;
    const version = typeof agent === 'string' ? agent.match(USER_AGENT_VERSION)?.[1] : undefined;
    if (version !== options.expectedVersion) {
      throw new Error(`codex app-server reports version ${version ?? 'unknown'}, expected ${options.expectedVersion}`);
    }
    rpc.notify('initialized');
    return { pid: proc.pid, rpc, initialize, exited, end };
  } catch (error) {
    await end();
    throw error;
  } finally {
    starting = false;
  }
}

/** Explicit readers let end() stop waiting on pipes inherited by an escaped process. */
function pipe(stream: ReadableStream<Uint8Array>, capture?: (chunk: Uint8Array) => void) {
  const reader = stream.getReader();
  return {
    async *read(): AsyncGenerator<Uint8Array> {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          capture?.(value);
          yield value;
        }
      } catch {
        // A killed process or a cancelled pipe ends the read.
      }
    },
    cancel: () => {
      void reader.cancel().catch(() => {});
    },
  };
}
