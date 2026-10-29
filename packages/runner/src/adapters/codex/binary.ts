// Codex binaries (design 9.1, 15): the pinned version, the `--version` reader, the locator tests and M2g use for the
// pin, and the owner's own install, whose version RunnerVendor.ownerCliVersion reports.
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { boundedWait } from '../../processes';
import { runnerPaths } from '../../paths';
import { parseVendorVersion, VENDOR_PINS, vendorBinary } from '../../vendor/pins';

type Env = Record<string, string | undefined>;

/** The one Codex version of VENDOR_PINS; the committed protocol types are generated from it. */
export const CODEX_VERSION: string = pinnedCodexVersion();

function pinnedCodexVersion(): string {
  const versions = new Set(Object.values(VENDOR_PINS).map((pins) => pins?.codex.version));
  const [version] = versions;
  if (versions.size !== 1 || version === undefined) {
    throw new Error(`VENDOR_PINS must pin one Codex version, not ${JSON.stringify([...versions])}`);
  }
  return version;
}

const VERSION_TIMEOUT_MS = 10_000;

/** `--version` prints one short line; more output than this is not a version, and is not buffered. */
const MAX_VERSION_OUTPUT_BYTES = 64 * 1024;

export interface CodexVersionOptions {
  timeoutMs?: number;
  /** The CODEX_HOME and HOME to run with, such as the runner's own (design 9.1); a throwaway directory by default. */
  homes?: { codex: string; user: string };
}

/**
 * Runs `<bin> --version` in its own process group and parses the output with parseVendorVersion. The exit and the
 * output share one deadline, after which the group is killed. Null for a missing, non-executable, slow or failing
 * binary and for any other output.
 */
export async function codexBinaryVersion(bin: string, options: CodexVersionOptions = {}): Promise<string | null> {
  // Codex writes $CODEX_HOME/tmp/arg0 even for --version, and falls back to ~/.codex without CODEX_HOME, so it never
  // runs with the caller's homes. The directory must exist, or Codex warns that it could not create its aliases.
  const scratch = options.homes ? null : mkdtempSync(join(tmpdir(), 'agflow-codex-version-'));
  const homes = options.homes ?? { codex: scratch as string, user: scratch as string };
  try {
    let proc: ReturnType<typeof Bun.spawn<'ignore', 'pipe', 'ignore'>>;
    try {
      proc = Bun.spawn([bin, '--version'], {
        env: { ...process.env, CODEX_HOME: homes.codex, HOME: homes.user },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'ignore',
        detached: true,
      });
    } catch {
      return null;
    }
    const output = boundedText(proc.stdout, MAX_VERSION_OUTPUT_BYTES);
    const run = await boundedWait(Promise.all([proc.exited, output.text]), options.timeoutMs ?? VERSION_TIMEOUT_MS);
    // Whatever is left in the group, a helper holding the pipe included, goes with it.
    try {
      process.kill(-proc.pid, 'SIGKILL');
    } catch {
      // The group is already gone.
    }
    output.cancel();
    if (!run.done) return null;
    const [code, text] = run.value;
    return code === 0 && text !== null ? parseVendorVersion('codex', text) : null;
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}

/** Reads a stream as text, or null once it holds more than limit bytes or fails; cancel() stops the read. */
function boundedText(stream: ReadableStream<Uint8Array>, limit: number) {
  const reader = stream.getReader();
  const read = async (): Promise<string | null> => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks).toString('utf8');
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  };
  return {
    text: read().catch(() => null),
    cancel: () => {
      reader.cancel().catch(() => {});
    },
  };
}

export interface FindCodexOptions {
  env?: Env;
  /** The home whose ~/.agflow holds the runner's vendor directory; the user's home by default. */
  home?: string;
}

/**
 * The pinned binary for tests (design 15, X-20): AGFLOW_CODEX_BIN, then the runner's vendor directory under
 * ~/.agflow, which `bun run vendor:install` fills. A candidate counts only when its --version is the pin.
 */
export async function findCodexBinary(options: FindCodexOptions = {}): Promise<string | null> {
  const env = options.env ?? process.env;
  const candidates = [
    env.AGFLOW_CODEX_BIN,
    join(runnerPaths(join(options.home ?? homedir(), '.agflow')).runner, vendorBinary('codex', CODEX_VERSION)),
  ];
  for (const candidate of candidates) {
    if (candidate && (await codexBinaryVersion(candidate)) === CODEX_VERSION) return candidate;
  }
  return null;
}

/** The Rust target triples of @openai/codex's platform packages, as its wrapper maps them. */
const TARGET_TRIPLES: Record<string, string> = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'linux-arm64': 'aarch64-unknown-linux-musl',
  'linux-x64': 'x86_64-unknown-linux-musl',
};

export interface OwnerCodexOptions {
  env?: Env;
  platform?: string;
  arch?: string;
}

/**
 * The version of the owner's own `codex` on PATH. That is @openai/codex's Node wrapper, which is never run: it is
 * resolved, as the wrapper itself does, to the native binary of its platform package, and only that binary runs.
 * Anything else on PATH gives null, since it could be a script that starts Node.
 */
export async function ownerCodexVersion(options: OwnerCodexOptions = {}): Promise<string | null> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const triple = TARGET_TRIPLES[`${platform}-${arch}`];
  const found = Bun.which('codex', { PATH: env.PATH ?? '' });
  if (!triple || !found) return null;
  const wrapper = realpathSync(found);
  const packageRoot = dirname(dirname(wrapper));
  if (basename(wrapper) !== 'codex.js' || packageName(packageRoot) !== '@openai/codex') return null;
  const platformPackage = `@openai/codex-${platform}-${arch}`;
  const vendorRoots = [platformVendorRoot(platformPackage, dirname(wrapper)), join(packageRoot, 'vendor')];
  const native = vendorRoots
    .filter((root): root is string => root !== null)
    .map((root) => join(root, triple, 'bin', 'codex'))
    .find((path) => existsSync(path));
  return native ? codexBinaryVersion(native) : null;
}

function packageName(root: string): string | null {
  try {
    const { name } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name?: unknown };
    return typeof name === 'string' ? name : null;
  } catch {
    return null;
  }
}

/**
 * The vendor directory of the platform package that Node's lookup finds from the wrapper's directory: the first
 * <dir>/node_modules/<name> on the way up. The disk is all it reads; a module resolver could fall back to Bun's
 * auto-install, fetch the package from a registry and so run a downloaded binary.
 */
function platformVendorRoot(name: string, from: string): string | null {
  for (let dir = from; ; dir = dirname(dir)) {
    if (basename(dir) !== 'node_modules' && existsSync(join(dir, 'node_modules', name, 'package.json'))) {
      return join(dir, 'node_modules', name, 'vendor');
    }
    if (dirname(dir) === dir) return null;
  }
}
