// The sandbox runtime's seccomp helper (apply-seccomp). On Linux every sandboxed command runs under its filter, which
// refuses the command unix sockets: the user's systemd manager listens on one and would start any command outside the
// sandbox. The runtime looks for the helper beside its own files, which a binary built with `bun build --compile` does
// not have, so the binary embeds both architectures' helpers and the runner writes out the one it needs.
import { randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import arm64 from '@anthropic-ai/sandbox-runtime/vendor/seccomp/arm64/apply-seccomp' with { type: 'file' };
import x64 from '@anthropic-ai/sandbox-runtime/vendor/seccomp/x64/apply-seccomp' with { type: 'file' };
import { agflowHome } from '../paths';

/** Where a compiled binary's embedded files lie; run from source, the imports are the package's own files. */
const EMBEDDED = '/$bunfs/';

export interface SeccompHelperOptions {
  /** process.arch by default. */
  arch?: string;
  /** AGFLOW_HOME, agflowHome() by default. */
  home?: string;
  /** The helpers by architecture, as imported above by default. */
  helpers?: Readonly<Record<string, string>>;
  /** Reads an embedded helper; readFileSync by default. */
  read?: (path: string) => Buffer;
}

/**
 * The seccomp helper of this machine's architecture. An embedded one is written to
 * AGFLOW_HOME/seccomp/<arch>/apply-seccomp (mode 0755), and written again whenever that file differs from it. The
 * directory lies outside the runner tree, which the sandboxes hide, and no sandbox lets a command write it.
 */
export function seccompHelper(options: SeccompHelperOptions = {}): string {
  const arch = options.arch ?? process.arch;
  const helpers = options.helpers ?? { x64, arm64 };
  const helper = Object.hasOwn(helpers, arch) ? helpers[arch] : undefined;
  if (helper === undefined) throw new Error(`the sandbox runtime has no seccomp helper for ${arch}`);
  if (!helper.startsWith(EMBEDDED)) return helper;
  const bytes = (options.read ?? readFileSync)(helper);
  const dir = join(options.home ?? agflowHome(), 'seccomp', arch);
  const path = join(dir, 'apply-seccomp');
  if (isCopy(path, bytes)) return path;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temporary = join(dir, `.apply-seccomp.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o755 });
    chmodSync(temporary, 0o755);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  return path;
}

/** A regular file, mode 0755, with exactly these bytes. */
function isCopy(path: string, bytes: Buffer): boolean {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  return stat?.isFile() === true && (stat.mode & 0o777) === 0o755 && readFileSync(path).equals(bytes);
}
