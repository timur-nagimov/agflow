// One dependency-preparation command inside Anthropic's sandbox runtime (design 7.7), in the runner process:
// SandboxManager is initialised once with the profile's domains, and each command is wrapped with its attempt's
// prepPolicy. Commands are always spawned asynchronously, because the runtime's proxies run on this process's event
// loop and spawnSync would deadlock on them. checkPrepSandbox is the self-check behind profile.dependencyPrep.
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReadableStreamDefaultReader } from 'node:stream/web';
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { DEFAULT_TIMINGS } from '../config';
import { type Logger, noopLogger } from '../log';
import { boundedWait } from '../processes';
import { standardProfile } from '../profile';
import type { PrepPolicy } from './plan';

export type SandboxBackend = Pick<
  typeof SandboxManager,
  'initialize' | 'isSupportedPlatform' | 'checkDependencies' | 'wrapWithSandboxArgv' | 'cleanupAfterCommand'
>;

export interface PrepSandboxOptions {
  allowedDomains: readonly string[];
  timeoutMs?: number;
  logger?: Logger;
  /** Maximum UTF-8 bytes, including the truncation marker. Defaults to 16 KiB. */
  tailBytes?: number;
  manager?: SandboxBackend;
}

export interface PrepRunSpec {
  argv: string[];
  cwd: string;
  /** Task 10's prepEnv, never the runner's environment. */
  env: Record<string, string>;
  policy: PrepPolicy;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface PrepRunResult {
  code: number | null;
  signal: string | null;
  timedOut: boolean;
  logTail: string;
  durationMs: number;
}

const initializations = new WeakMap<SandboxBackend, { domains: string; promise: Promise<void> }>();
const TRUNCATED = '[agflow: output truncated]\n';
const PIPE_WAIT_MS = 1000;

function domainKey(domains: readonly string[]): string {
  return JSON.stringify([...new Set(domains)].sort());
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function shellWord(value: string): string {
  if (value.includes('\0')) throw new Error('preparation arguments must not contain NUL');
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Keeps reading after the bound; a full pipe must never stop a package manager. */
class LogTail {
  private bytes: Buffer = Buffer.alloc(0);
  private truncated = false;

  constructor(private readonly limit: number) {}

  append(text: string): void {
    const next = Buffer.from(text);
    this.truncated ||= this.bytes.length + next.length > this.limit;
    this.bytes =
      next.length >= this.limit
        ? Buffer.from(next.subarray(next.length - this.limit))
        : Buffer.concat([this.bytes.subarray(Math.max(0, this.bytes.length + next.length - this.limit)), next]);
  }

  text(): string {
    const marker = this.truncated ? TRUNCATED.slice(0, this.limit) : '';
    let start = Math.max(0, this.bytes.length - (this.limit - Buffer.byteLength(marker)));
    // The cap can land inside a codepoint; each pipe's streaming decoder preserves its other boundaries.
    while (start < this.bytes.length && (this.bytes[start]! & 0xc0) === 0x80) start++;
    return marker + this.bytes.subarray(start).toString('utf8');
  }
}

async function drain(reader: ReadableStreamDefaultReader<Uint8Array>, tail: LogTail): Promise<void> {
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      tail.append(decoder.decode(value, { stream: true }));
    }
    tail.append(decoder.decode());
  } catch {
    // A pipe closed mid-write by a kill is the end of its log.
  } finally {
    reader.releaseLock();
  }
}

export class PrepSandbox {
  readonly allowedDomains: readonly string[];
  private readonly manager: SandboxBackend;
  private readonly timeoutMs: number;
  private readonly tailBytes: number;
  private readonly logger: Logger;

  constructor(options: PrepSandboxOptions) {
    this.allowedDomains = Object.freeze([...new Set(options.allowedDomains)].sort());
    this.manager = options.manager ?? SandboxManager;
    this.timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMINGS.prep, 'timeoutMs');
    this.tailBytes = positiveInteger(options.tailBytes ?? 16 * 1024, 'tailBytes');
    this.logger = options.logger ?? noopLogger;
  }

  /** The manager is process-global. A failure is sticky; restart the runner before trying initialization again. */
  init(): Promise<void> {
    const domains = domainKey(this.allowedDomains);
    const existing = initializations.get(this.manager);
    if (existing) {
      return existing.domains === domains
        ? existing.promise
        : Promise.reject(new Error('preparation sandbox already initialized with different allowed domains'));
    }
    const promise = Promise.resolve().then(async () => {
      if (!this.manager.isSupportedPlatform()) throw new Error('preparation sandbox: unsupported platform');
      const { errors } = this.manager.checkDependencies();
      if (errors.length) throw new Error(`preparation sandbox: ${errors.join('; ')}`);
      await this.manager.initialize(
        {
          network: {
            allowedDomains: [...this.allowedDomains],
            deniedDomains: [],
            strictAllowlist: true,
            allowLocalBinding: false,
          },
          // No command may rely on the fallback. Task 10 supplies complete per-call filesystem lists.
          filesystem: { allowWrite: [], denyWrite: ['/'], denyRead: ['/'], allowRead: [] },
        },
        undefined,
        false,
      );
    });
    initializations.set(this.manager, { domains, promise });
    return promise;
  }

  /** Setup/wrap/spawn errors throw; command failures and termination are returned for attempt.prepared. */
  async run(spec: PrepRunSpec): Promise<PrepRunResult> {
    const started = performance.now();
    const timeoutMs = positiveInteger(spec.timeoutMs ?? this.timeoutMs, 'timeoutMs');
    if (!spec.argv.length) throw new Error('preparation argv must not be empty');
    if (!spec.env.TMPDIR) throw new Error('preparation needs a private TMPDIR');
    if (domainKey(spec.policy.network.allowedDomains) !== domainKey(this.allowedDomains)) {
      throw new Error('preparation policy domains must match the global sandbox domains');
    }
    spec.signal?.throwIfAborted();
    // The runtime's wrapper overrides TMPDIR. Restore it INSIDE that wrapper, without changing process.env.
    const command = `export TMPDIR=${shellWord(spec.env.TMPDIR)}; exec ${spec.argv.map(shellWord).join(' ')}`;
    await this.init();
    spec.signal?.throwIfAborted();
    this.logger.info('preparation started', { argv: spec.argv, cwd: spec.cwd });
    const wrapped = await this.manager.wrapWithSandboxArgv(command, '/bin/sh', spec.policy, spec.signal, spec.cwd);
    try {
      spec.signal?.throwIfAborted();
      const env = { ...spec.env };
      // 0.0.81 returns process.env on macOS/Linux; only runtime additions/changes may cross the allowlist.
      for (const [name, value] of Object.entries(wrapped.env)) {
        if (value !== undefined && value !== process.env[name]) env[name] = value;
      }
      const proc = Bun.spawn(wrapped.argv, {
        cwd: spec.cwd,
        env,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        detached: true,
      });
      let timedOut = false;
      const kill = () => {
        try {
          process.kill(-proc.pid, 'SIGKILL');
        } catch {
          proc.kill('SIGKILL');
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, timeoutMs);
      spec.signal?.addEventListener('abort', kill, { once: true });
      if (spec.signal?.aborted) kill();
      const tail = new LogTail(this.tailBytes);
      const readers = [proc.stdout.getReader(), proc.stderr.getReader()];
      const output = Promise.all(readers.map((reader) => drain(reader, tail)));
      try {
        const code = await proc.exited;
        clearTimeout(timer);
        spec.signal?.removeEventListener('abort', kill);
        // Leftovers in the group could still write the clone or the cache after the preparation is recorded.
        try {
          process.kill(-proc.pid, 'SIGKILL');
        } catch {
          // ESRCH: the group is already empty.
        }
        // A process that left the group (setsid) can still hold the pipes open.
        if (!(await boundedWait(output, PIPE_WAIT_MS)).done) {
          for (const reader of readers) void reader.cancel().catch(() => {});
        }
        const result: PrepRunResult = {
          code: proc.signalCode ? null : code,
          signal: proc.signalCode ?? null,
          timedOut,
          logTail: tail.text(),
          durationMs: performance.now() - started,
        };
        this.logger.info('preparation finished', {
          code: result.code,
          signal: result.signal,
          timedOut,
          durationMs: result.durationMs,
        });
        return result;
      } finally {
        clearTimeout(timer);
        spec.signal?.removeEventListener('abort', kill);
      }
    } finally {
      // Each successful wrap owns one runtime cleanup, including when spawn fails.
      this.manager.cleanupAfterCommand();
    }
  }
}

export interface CheckPrepSandboxOptions extends Partial<PrepSandboxOptions> {
  sandbox?: PrepSandbox;
}

/** A real filesystem operation, not just a dependency check; setup and ProfileSummary use the same answer. */
export async function checkPrepSandbox(
  options: CheckPrepSandboxOptions = {},
): Promise<{ works: boolean; reason: string | null }> {
  let directory: string | undefined;
  try {
    const sandbox =
      options.sandbox ??
      new PrepSandbox({
        ...options,
        allowedDomains: options.allowedDomains ?? standardProfile.network.allowedDomains,
      });
    await sandbox.init();
    directory = realpathSync(mkdtempSync(join(tmpdir(), 'agflow-prep-check-')));
    const result = await sandbox.run({
      argv: ['/bin/sh', '-c', 'printf agflow-prep-ok > probe'],
      cwd: directory,
      env: { PATH: '/usr/bin:/bin', HOME: directory, TMPDIR: directory },
      policy: {
        filesystem: {
          allowWrite: [directory],
          denyWrite: ['/tmp/claude', '/private/tmp/claude'],
          denyRead: [],
          allowRead: [directory],
        },
        network: { allowedDomains: [...sandbox.allowedDomains], deniedDomains: [] },
      },
      timeoutMs: options.timeoutMs ?? 10_000,
    });
    if (result.code !== 0 || result.signal || result.timedOut) {
      throw new Error(
        `preparation sandbox probe failed (exit ${result.code}, signal ${result.signal}, ` +
          `timedOut ${result.timedOut}): ${result.logTail.trim()}`,
      );
    }
    if (readFileSync(join(directory, 'probe'), 'utf8') !== 'agflow-prep-ok') {
      throw new Error('preparation sandbox probe did not write the expected file');
    }
    return { works: true, reason: null };
  } catch (error) {
    return { works: false, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    if (directory) {
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch {
        // A self-check never throws.
      }
    }
  }
}
