// The pinned claude for tests (design 15, X-20). Tests never download it: they use AGFLOW_CLAUDE_BIN, or the runner's
// vendor directory under the real home, which `bun run vendor:install` fills. The testkit imports no runner code, so
// the layout (vendorBinary) and the version format (parseVendorVersion) are followed by convention; a runner-side test
// holds them together.
import { existsSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export type ClaudeBinaryLookup = { path: string; reason: null } | { path: null; reason: string };

export interface FindClaudeBinaryOptions {
  /** process.env by default. */
  env?: Record<string, string | undefined>;
  /** The home whose ~/.agflow/runner/vendor is searched; the real home by default, whatever AGFLOW_HOME says. */
  home?: string;
  /** For each `--version`; 10 s by default. */
  timeoutMs?: number;
}

const VERSION = /^\d+\.\d+\.\d+$/;
const VERSION_OUTPUT = /^(\d+\.\d+\.\d+) \(Claude Code\)$/;

/** Where vendorBinary('claude', version) lies under an AGFLOW_HOME. */
function vendorClaude(agflowHome: string, version: string): string {
  if (!VERSION.test(version)) throw new Error(`not a vendor version: ${JSON.stringify(version)}`);
  return join(agflowHome, 'runner', 'vendor', 'claude', version, 'claude');
}

/** Why a candidate is not the pinned binary, or null when it is. */
function candidateProblem(path: string, version: string, timeoutMs: number): string | null {
  if (!existsSync(path)) return 'is missing';
  let result: Bun.SyncSubprocess<'pipe', 'ignore'>;
  try {
    // `--version` needs no home or configuration; nothing but PATH is passed.
    result = Bun.spawnSync([path, '--version'], {
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
      timeout: timeoutMs,
    });
  } catch (error) {
    return `cannot run: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`;
  }
  if (result.exitedDueToTimeout) return 'did not answer --version';
  const found = result.exitCode === 0 ? result.stdout.toString().trim().match(VERSION_OUTPUT)?.[1] : undefined;
  if (found === undefined) return 'has an unreadable version';
  return found === version ? null : `is claude ${found}`;
}

/**
 * The pinned claude of a version: AGFLOW_CLAUDE_BIN, then ~/.agflow/runner/vendor/claude/<version>/claude. Only a
 * binary whose `--version` reports the version counts; otherwise the reason names each candidate and the remedy.
 * Synchronous, so a test file can decide at load time whether its suite runs.
 */
export function findClaudeBinary(version: string, options: FindClaudeBinaryOptions = {}): ClaudeBinaryLookup {
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const problems: string[] = [];
  const explicit = env.AGFLOW_CLAUDE_BIN;
  if (explicit) {
    const problem = candidateProblem(explicit, version, timeoutMs);
    if (problem === null) return { path: explicit, reason: null };
    problems.push(`AGFLOW_CLAUDE_BIN ${explicit} ${problem}`);
  } else {
    problems.push('AGFLOW_CLAUDE_BIN is not set');
  }
  const vendored = vendorClaude(join(options.home ?? homedir(), '.agflow'), version);
  const problem = candidateProblem(vendored, version, timeoutMs);
  if (problem === null) return { path: vendored, reason: null };
  problems.push(`${vendored} ${problem}`);
  return {
    path: null,
    reason:
      `no claude ${version}: ${problems.join('; ')}. ` +
      `Set AGFLOW_CLAUDE_BIN to a claude ${version} binary, or run \`bun run vendor:install\`.`,
  };
}

/** Links a located binary into a test runner home's vendor directory, where the runner looks; returns the link. */
export function linkClaudeBinary(agflowHome: string, version: string, bin: string): string {
  const link = vendorClaude(agflowHome, version);
  // The binary findClaudeBinary found under this very home is already in place; replacing it would delete it.
  if (resolve(bin) === link || (existsSync(link) && existsSync(bin) && realpathSync(link) === realpathSync(bin))) {
    return link;
  }
  mkdirSync(dirname(link), { recursive: true });
  rmSync(link, { force: true });
  symlinkSync(resolve(bin), link);
  return link;
}
