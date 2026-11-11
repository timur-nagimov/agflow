// Install and verify runner-owned vendor pins atomically (design 7.1, 7.8, 8.1, 9.1).
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import type { Vendor } from '@agflow/core';
import { agflowHome, type RunnerPaths, runnerPaths } from '../paths';
import { defaultExec, type Exec } from '../service/system';
import {
  type ClaudePin,
  type CodexPin,
  parseVendorVersion,
  type PlatformPins,
  VENDOR_PINS,
  vendorBinary,
  vendorPlatform,
} from './pins';

type Env = Record<string, string | undefined>;
type Pin = ClaudePin | CodexPin;

// The real tarballs unpack to 224 and 332 MB, so the bound only catches a stalled download on a slow network.
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;

export class VendorInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VendorInstallError';
  }
}

export interface VendorInstallOptions {
  env?: Env;
  registry?: string;
  exec?: Exec;
}

export interface PinnedVendorsOptions extends VendorInstallOptions {
  /** Gets each installed binary's path, as it is ready. */
  log?: (line: string) => void;
  platform?: string;
  /** Test packages can replace the platform's real pins without a real download. */
  pins?: PlatformPins;
}

async function checkBinary(
  vendor: Vendor,
  pin: Pin,
  binary: string,
  exec: Exec,
  env: Record<string, string>,
  cwd: string,
): Promise<void> {
  const stat = await lstat(binary);
  if (!stat.isFile() || !(stat.mode & 0o111)) {
    throw new VendorInstallError(`not an executable file: ${binary}`);
  }
  if (vendor === 'claude') {
    if (!('sha256' in pin)) throw new VendorInstallError('Claude pin has no sha256');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(binary)) hash.update(chunk);
    const actual = hash.digest('hex');
    if (actual !== pin.sha256) {
      throw new VendorInstallError(`sha256 mismatch for ${pin.package}: expected ${pin.sha256}, actual ${actual}`);
    }
    if ((stat.mode & 0o777) !== 0o755) throw new VendorInstallError(`expected mode 0755: ${binary}`);
  }
  if (vendor === 'codex') {
    const tree = dirname(dirname(binary));
    for (const file of ['bin/codex-code-mode-host', 'codex-path/rg']) {
      const companion = join(tree, file);
      const stat = await lstat(companion);
      if (!stat.isFile() || !(stat.mode & 0o111)) {
        throw new VendorInstallError(`not an executable file: ${companion}`);
      }
    }
  }
  const result = await exec([binary, '--version'], { env, cwd, timeoutMs: 10_000 });
  if (result.exitCode !== 0 || result.timedOut || parseVendorVersion(vendor, result.stdout) !== pin.version) {
    const actual = JSON.stringify(result.stdout.trim() || result.stderr.trim());
    throw new VendorInstallError(
      `--version mismatch for ${vendor}: expected ${pin.version}, actual ${actual}` +
        (result.timedOut ? ' (timed out)' : result.exitCode !== 0 ? ` (exit ${result.exitCode})` : ''),
    );
  }
}

async function download(url: string): Promise<Buffer> {
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (response.ok) return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    throw new VendorInstallError(`${url}: ${error instanceof Error ? error.message : String(error)}`);
  }
  throw new VendorInstallError(`${url}: HTTP ${response.status}`);
}

/** Only reap abandoned staging; another installer may still be downloading or checking its binary. */
function abandonedStaging(name: string): boolean {
  const pid = name.match(/^\.staging-([1-9][0-9]*)-/)?.[1];
  if (!pid) return true;
  try {
    process.kill(Number(pid), 0);
    return false;
  } catch (error) {
    // EPERM also means the owner is alive.
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/** Reuses a verified install, or stages and verifies the pinned package before publishing its version directory. */
export async function ensureVendorBinary(
  vendor: Vendor,
  pin: Pin,
  paths: RunnerPaths,
  options: VendorInstallOptions = {},
): Promise<string> {
  const env = options.env ?? process.env;
  const exec = options.exec ?? defaultExec;
  const binary = resolve(paths.runner, vendorBinary(vendor, pin.version));
  const parent = resolve(paths.vendor, vendor);
  const destination = join(parent, pin.version);
  const binaryRelative = relative(destination, binary);
  let staging: string | undefined;
  try {
    await mkdir(paths.runner, { recursive: true, mode: 0o700 });
    await mkdir(parent, { recursive: true });
    for (const entry of await readdir(parent)) {
      if (entry.startsWith('.staging-') && abandonedStaging(entry)) {
        await rm(join(parent, entry), { recursive: true, force: true });
      }
    }
    staging = await mkdtemp(join(parent, `.staging-${process.pid}-`));
    const checkHome = join(staging, 'check');
    await mkdir(checkHome);
    // Even --version gets a private home and tmp, and no caller's vendor settings or credentials.
    const commandEnv = {
      PATH: env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: checkHome,
      TMPDIR: checkHome,
      CLAUDE_CONFIG_DIR: checkHome,
      CODEX_HOME: checkHome,
      COPYFILE_DISABLE: '1',
    };
    try {
      await checkBinary(vendor, pin, binary, exec, commandEnv, checkHome);
      return binary;
    } catch {
      // Keep the old tree available until its replacement has passed every check.
    }
    const registry = (options.registry ?? env.AGFLOW_NPM_REGISTRY ?? 'https://registry.npmjs.org').replace(/\/+$/, '');
    const name = pin.package.split('/').at(-1);
    const url = `${registry}/${pin.package}/-/${name}-${pin.packageVersion}.tgz`;
    const bytes = await download(url);
    const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
    if (integrity !== pin.integrity) {
      throw new VendorInstallError(
        `sha512 mismatch for ${pin.package}: expected ${pin.integrity}, actual ${integrity}`,
      );
    }
    const archive = join(staging, 'package.tgz');
    const unpacked = join(staging, 'unpacked');
    await writeFile(archive, bytes);
    await mkdir(unpacked);
    const extraction = await exec(['tar', '-xzf', archive, '-C', unpacked], {
      env: commandEnv,
      cwd: staging,
      timeoutMs: 120_000,
    });
    if (extraction.exitCode !== 0 || extraction.timedOut) {
      throw new VendorInstallError(`tar failed for ${pin.package}: ${extraction.stderr.trim() || 'extraction failed'}`);
    }
    const ready = join(staging, 'ready');
    if (vendor === 'claude') {
      await mkdir(ready);
      const source = join(unpacked, 'package', 'claude');
      if (!(await lstat(source)).isFile()) throw new VendorInstallError(`not a regular file: ${source}`);
      await rename(source, join(ready, 'claude'));
      await chmod(join(ready, 'claude'), 0o755);
    } else {
      if (!('tree' in pin) || !/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(pin.tree)) {
        throw new VendorInstallError('Codex pin has no safe package tree');
      }
      const source = join(unpacked, 'package', pin.tree);
      if (!(await lstat(source)).isDirectory()) throw new VendorInstallError(`not a directory: ${source}`);
      await rename(source, ready);
    }
    await checkBinary(vendor, pin, join(ready, binaryRelative), exec, commandEnv, checkHome);
    const previous = join(staging, 'previous');
    let replaced = false;
    try {
      await rename(destination, previous);
      replaced = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    try {
      await rename(ready, destination);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST' || code === 'ENOTEMPTY') {
        try {
          await checkBinary(vendor, pin, binary, exec, commandEnv, checkHome);
          return binary;
        } catch {
          // A competing publish only wins if it is a complete, verified install.
        }
      }
      if (replaced) {
        try {
          await rename(previous, destination);
        } catch (restoreError) {
          // Preserve the backup if the filesystem prevents rollback.
          staging = undefined;
          throw new VendorInstallError(
            `cannot restore ${previous}: ${String(restoreError)}; publish failed: ${String(error)}`,
          );
        }
      }
      throw error;
    }
    return binary;
  } catch (error) {
    if (error instanceof VendorInstallError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new VendorInstallError(`installing ${pin.package}: ${message}`);
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
  }
}

/** Setup and install share this platform gate; service start never calls the installer. */
export async function ensurePinnedVendors(
  paths: RunnerPaths,
  options: PinnedVendorsOptions = {},
): Promise<Record<Vendor, string>> {
  const platform = options.platform ?? vendorPlatform();
  const pins = options.pins ?? VENDOR_PINS[platform];
  if (!pins) throw new VendorInstallError(`unsupported platform ${platform}`);
  const claude = await ensureVendorBinary('claude', pins.claude, paths, options);
  options.log?.(claude);
  const codex = await ensureVendorBinary('codex', pins.codex, paths, options);
  options.log?.(codex);
  return { claude, codex };
}

/** Fills AGFLOW_HOME's vendor directory without setup, for the smoke suites and standalone installation. */
export async function vendorInstallMain(
  argv: string[] = [],
  env: Env = process.env,
  options: Omit<PinnedVendorsOptions, 'env'> & { error?: (line: string) => void } = {},
): Promise<number> {
  try {
    if (argv.length) throw new VendorInstallError('usage: bun run vendor:install');
    await ensurePinnedVendors(runnerPaths(agflowHome(env)), { ...options, env, log: options.log ?? console.log });
    return 0;
  } catch (error) {
    (options.error ?? console.error)(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
