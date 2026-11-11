// What a dependency preparation runs with (design 7.7, X-40): the when-file fingerprints that decide whether an entry
// runs again, kept per attempt under prep/<project>/state/; the environment, the agent's allowlist with the
// preparation's own HOME, TMPDIR and caches; and the sandbox runtime's per-call policy. Nothing here runs a command.
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  readSync,
  renameSync,
  rmSync,
  type Stats,
  writeFileSync,
} from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import { deniedReadPaths, type DeniedPathsInput, type PermissionProfile } from '../profile';
import { runDirOf } from '../run-dir';
import { type PrepConfig, PrepConfigSchema } from './config';

const WhenPath = PrepConfigSchema.shape.dependencies.element.shape.when.element;
const SAFE_NAME = /^(?!\.\.?$)[A-Za-z0-9._-]+$/;
// Agents control when-files; a sparse multi-gigabyte lockfile must not stall the runner's event loop.
const MAX_WHEN_FILE_BYTES = 64 * 1024 * 1024;

function statOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function kind(stat: Stats): number {
  return stat.mode & constants.S_IFMT;
}

function fingerprintFile(clone: string, relative: string): unknown[] {
  let path = clone;
  const parts = relative.split('/');
  // Parents inside the agent's tree must be real directories, including the clone root.
  for (let i = 0; i < parts.length; i++) {
    const parent = statOrNull(path);
    if (!parent) return ['missing-parent', i];
    if (!parent.isDirectory()) return ['blocked-parent', i, kind(parent)];
    path = join(path, parts[i]!);
  }
  const stat = statOrNull(path);
  if (!stat) return ['missing'];
  if (stat.isSymbolicLink()) return ['symlink', readlinkSync(path, { encoding: 'buffer' }).toString('hex')];
  if (!stat.isFile()) return ['kind', kind(stat)];
  // Refuse a final symlink swapped in since lstat; O_NONBLOCK also prevents a replacement FIFO from hanging.
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) return ['kind', kind(opened)];
    if (opened.size > MAX_WHEN_FILE_BYTES) {
      throw new Error(`when-file ${relative} exceeds ${MAX_WHEN_FILE_BYTES / (1024 * 1024)} MiB`);
    }
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
    }
    return ['file', hash.digest('hex')];
  } finally {
    closeSync(fd);
  }
}

/** Ordered, framed records distinguish absent files, empty files, links and special files without following links. */
export function whenFingerprint(clone: string, when: readonly string[]): string {
  const hash = createHash('sha256');
  for (const relative of when) {
    WhenPath.parse(relative);
    hash.update(`${JSON.stringify([relative, ...fingerprintFile(clone, relative)])}\n`);
  }
  return hash.digest('hex');
}

/** A config edit reruns an entry even if its watched files are unchanged. */
export function prepEntryKey(entry: PrepConfig['dependencies'][number]): string {
  return createHash('sha256')
    .update(JSON.stringify([entry.run, entry.when, entry.scripts]))
    .digest('hex');
}

export function prepLayout(prepRoot: string): {
  cache: string;
  tmp: string;
  state: string;
  config: string;
} {
  return {
    cache: join(prepRoot, 'cache'),
    tmp: join(prepRoot, 'tmp'),
    state: join(prepRoot, 'state'),
    config: join(prepRoot, 'config'),
  };
}

export interface PrepCommand {
  run: readonly string[];
  scripts?: boolean;
}

const SHARED_INSTALLS: Record<string, readonly string[]> = {
  bun: ['install', 'i'],
  npm: ['ci', 'install', 'i'],
  pnpm: ['install', 'i', 'fetch'],
};

/**
 * Only these installs run no repository code with scripts off, so only they may write the shared cache. Anything
 * else can (pip and uv build agent-edited local packages, yarn runs .yarn/releases and plugins, a shell runs
 * anything), so like "scripts": true it gets per-attempt caches. A relative argv[0] is the agent's own file.
 */
export function sharesCache(command: PrepCommand): boolean {
  const [program, subcommand] = command.run;
  if (command.scripts || !program || subcommand === undefined) return false;
  if (program.includes('/') && !isAbsolute(program)) return false;
  return SHARED_INSTALLS[basename(program)]?.includes(subcommand) ?? false;
}

/** XDG_CONFIG_HOME for a preparation: runner-owned, outside the clone, and never writable from the sandbox. */
export function prepToolConfig(prep: string, scripts?: boolean): string {
  return join(prepLayout(prep).config, scripts ? 'scripts' : 'noscripts');
}

/**
 * Writes the preparations' tool config. Bun 1.3.11 ignores npm_config_ignore_scripts, so with scripts off its
 * global bunfig turns them off; that bunfig is read from XDG_CONFIG_HOME, which also stops Bun reading
 * $HOME/.bunfig.toml in the agent-writable HOME. The scripts variant stays empty.
 */
export function writePrepToolConfig(prep: string): void {
  const config = prepLayout(prep).config;
  for (const dir of [config, prepToolConfig(prep, false), prepToolConfig(prep, true)]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const path = join(prepToolConfig(prep, false), '.bunfig.toml');
  const temporary = join(prepToolConfig(prep, false), `.bunfig.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, '[install]\nignoreScripts = true\n', {
      flag: 'wx',
      mode: 0o600,
    });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** State is runner-owned and outside the sandbox's cache and tmp allowances. */
export class PrepState {
  private readonly state: string;

  constructor(prepRoot: string) {
    this.state = prepLayout(prepRoot).state;
  }

  private path(attemptId: string): string {
    if (!SAFE_NAME.test(attemptId)) throw new Error(`not a safe attempt id: ${JSON.stringify(attemptId)}`);
    return join(this.state, `${attemptId}.json`);
  }

  private read(attemptId: string): Record<string, string> {
    const path = this.path(attemptId);
    let content: string;
    try {
      content = readFileSync(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Object.create(null);
      throw error;
    }
    try {
      const entries: unknown = JSON.parse(content);
      if (
        !entries ||
        typeof entries !== 'object' ||
        Array.isArray(entries) ||
        Object.values(entries).some((value) => typeof value !== 'string')
      )
        return Object.create(null);
      return entries as Record<string, string>;
    } catch {
      return Object.create(null);
    }
  }

  needs(attemptId: string, entryKey: string, fingerprint: string): boolean {
    const entries = this.read(attemptId);
    return !Object.hasOwn(entries, entryKey) || entries[entryKey] !== fingerprint;
  }

  record(attemptId: string, entryKey: string, fingerprint: string): void {
    const path = this.path(attemptId);
    const entries = { ...this.read(attemptId), [entryKey]: fingerprint };
    mkdirSync(this.state, { recursive: true, mode: 0o700 });
    const temporary = join(this.state, `.${attemptId}.${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, `${JSON.stringify(entries)}\n`, {
        flag: 'wx',
        mode: 0o600,
      });
      renameSync(temporary, path);
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  forget(attemptId: string): void {
    rmSync(this.path(attemptId), { force: true });
  }

  attempts(): string[] {
    try {
      return readdirSync(this.state, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json') && SAFE_NAME.test(entry.name.slice(0, -5)))
        .map((entry) => entry.name.slice(0, -5))
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
}

export interface PrepEnvInput {
  /** PrepareInput.env, already built from M2b's agent allowlist. Never pass the runner's process.env. */
  agentEnv: Record<string, string>;
  clone: string;
  /** paths.prep(project). */
  prep: string;
  /**
   * A private directory (mode 0700) under prepLayout(prep).tmp; the preparer (createDependencyPreparer) creates one
   * for each preparation and removes it afterwards.
   */
  tmpDir: string;
  /** The config entry: scripts decides the no-scripts switches, sharesCache the caches. */
  entry: PrepCommand;
}

export function prepEnv(input: PrepEnvInput): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(input.agentEnv).filter(
      ([name]) =>
        !name.startsWith('AGFLOW_') &&
        !name.startsWith('CLAUDE_CODE_') &&
        !name.startsWith('CODEX_') &&
        !['CLAUDE_CONFIG_DIR', 'DISABLE_AUTOUPDATER', 'SSH_AUTH_SOCK', 'SSH_ASKPASS'].includes(name),
    ),
  );
  // Only home and cache are needed; tools and the agent git environment stay as the controller supplied them.
  const run = runDirOf(input.clone, '');
  const cache = sharesCache(input.entry) ? prepLayout(input.prep).cache : run.cache;
  Object.assign(env, {
    HOME: run.home,
    TMPDIR: input.tmpDir,
    BUN_INSTALL_CACHE_DIR: join(cache, 'bun'),
    npm_config_cache: join(cache, 'npm'),
    npm_config_store_dir: join(cache, 'pnpm'),
    PIP_CACHE_DIR: join(cache, 'pip'),
    UV_CACHE_DIR: join(cache, 'uv'),
    GOMODCACHE: join(run.cache, 'go-mod'),
    CARGO_HOME: join(run.cache, 'cargo'),
    npm_config_package_import_method: 'clone-or-copy',
    UV_LINK_MODE: 'clone',
    npm_config_userconfig: '/dev/null',
    PIP_CONFIG_FILE: '/dev/null',
    XDG_CONFIG_HOME: prepToolConfig(input.prep, input.entry.scripts),
  });
  // Bun 1.3.11 has no backend env switch; on the supported macOS runner it defaults to clonefile.
  const noScripts = {
    npm_config_ignore_scripts: 'true',
    npm_config_ignore_pnpmfile: 'true',
    YARN_ENABLE_SCRIPTS: 'false',
  };
  for (const [name, value] of Object.entries(noScripts)) {
    if (input.entry.scripts) delete env[name];
    else env[name] = value;
  }
  return env;
}

export type PrepPolicy = Pick<SandboxRuntimeConfig, 'filesystem' | 'network'>;

export interface PrepPolicyInput extends DeniedPathsInput {
  clone: string;
  /** paths.prep(project). */
  prep: string;
  tmpDir: string;
  entry: PrepCommand;
  profile: PermissionProfile;
}

/** Complete per-call lists: the runtime replaces its global filesystem lists with these. */
export function prepPolicy(input: PrepPolicyInput): PrepPolicy {
  // Agent-controlled code (lifecycle scripts, build backends) must not reach the shared cache at all.
  const allowed = sharesCache(input.entry)
    ? [input.clone, prepLayout(input.prep).cache, input.tmpDir]
    : [input.clone, input.tmpDir];
  return {
    filesystem: {
      allowWrite: [...allowed],
      denyWrite: ['/tmp/claude', '/private/tmp/claude', join(input.home, '.npm', '_logs')],
      // Each clone, not the work root: Bun's script runner fails when it cannot read the clone's parents.
      denyRead: [...deniedReadPaths(input).map(({ path }) => path), join(input.paths.work, '*', '*')],
      allowRead: [...allowed, prepToolConfig(input.prep, input.entry.scripts)],
    },
    network: {
      allowedDomains: [...input.profile.network.allowedDomains],
      deniedDomains: [],
    },
  };
}
