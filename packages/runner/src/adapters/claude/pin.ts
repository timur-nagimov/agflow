// The Claude pin (design 8.1, X-10): the CLI and Agent SDK versions come from VENDOR_PINS, so they live in one place,
// plus the facts the local checks settle per pin, and the `<bin> --version` reader that runs before every start.
import { boundedWait } from '../../processes';
import { type ClaudePin, parseVendorVersion, VENDOR_PINS, vendorPlatform } from '../../vendor/pins';

const PINNED = VENDOR_PINS['darwin-arm64']?.claude;
if (!PINNED) throw new Error('VENDOR_PINS has no darwin-arm64 Claude pin');

/** The Claude Code version the runner installs and expects for new attempts. */
export const CLAUDE_CLI_VERSION: string = PINNED.version;

/** The @anthropic-ai/claude-agent-sdk version packages/runner depends on; its claudeCodeVersion is the CLI pin. */
export const CLAUDE_SDK_VERSION: string = PINNED.sdkVersion;

/** The pin for a platform (`<os>-<arch>`), or null where M2 pins nothing: preflight reports "unsupported platform". */
export function claudePin(platform: string = vendorPlatform()): ClaudePin | null {
  return VENDOR_PINS[platform]?.claude ?? null;
}

/**
 * Whether the sandbox's denyWrite of the shared /tmp/claude holds on this pin. It held on 2.1.285 in the feasibility
 * probe; check:claude-sandbox re-checks it for each pin and sets this to false if it fails, which makes preflight list
 * '/tmp/claude' as weakened (X-29). Nothing is probed at run time.
 */
export const TMP_CLAUDE_DENYWRITE_ENFORCED = true;

export type ClaudeVersionResult =
  | { ok: true; version: string }
  | {
      ok: false;
      /** The version the binary reported, when it reported one. */
      version: string | null;
      problem: string;
    };

export interface ReadClaudeVersionOptions {
  /** 10 s by default, the handshake timing. */
  timeoutMs?: number;
  /** The whole environment of the process; only PATH is passed by default, which `--version` needs at most. */
  env?: Record<string, string>;
}

const DEFAULT_TIMEOUT_MS = 10_000;
/** After a kill, a child the binary started may hold the pipes; its output is not worth waiting for. */
const OUTPUT_AFTER_KILL_MS = 500;

/**
 * Runs `<bin> --version` in its own process group and checks it against the expected version (null accepts any, for
 * the owner's own install). The problems are the ones preflight and a failed start report.
 */
export async function readClaudeVersion(
  bin: string,
  expected: string | null,
  options: ReadClaudeVersionOptions = {},
): Promise<ClaudeVersionResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
  try {
    proc = Bun.spawn([bin, '--version'], {
      cwd: '/',
      env: options.env ?? { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      detached: true,
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { ok: false, version: null, problem: 'binary missing' };
    return { ok: false, version: null, problem: `cannot run claude: ${code ?? (error as Error).message}` };
  }
  let timedOut = false;
  const deadline = Promise.withResolvers<void>();
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      process.kill(-proc.pid, 'SIGKILL');
    } catch {
      proc.kill('SIGKILL');
    }
    deadline.resolve();
  }, timeoutMs);
  // The deadline holds until the pipes are drained too: a child the binary leaves behind may keep them open.
  const output = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const done = Promise.all([proc.exited, output]);
  await Promise.race([done, deadline.promise]);
  clearTimeout(timer);
  if (timedOut) {
    await boundedWait(done, OUTPUT_AFTER_KILL_MS);
    return { ok: false, version: null, problem: `claude --version timed out after ${timeoutMs} ms` };
  }
  const [code, [stdout]] = await done;
  const version = code === 0 ? parseVendorVersion('claude', stdout) : null;
  if (version === null) return { ok: false, version: null, problem: 'unreadable version' };
  if (expected !== null && version !== expected) {
    return { ok: false, version, problem: `claude ${version}, expected ${expected}` };
  }
  return { ok: true, version };
}
