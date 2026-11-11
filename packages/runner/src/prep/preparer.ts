// DependencyPreparer (design 7.7, X-40): trusted config, restored protected paths, and serialized per-attempt runs.
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import type { AttemptStore } from '../attempt-store';
import { type RunnerConfig, vendorHomes } from '../config';
import { removeInClone, restoreProtected } from '../git/protect';
import { type Logger, noopLogger } from '../log';
import type { RunnerPaths } from '../paths';
import { profileOf } from '../profile';
import { runDirOf } from '../run-dir';
import type { DependencyPreparer, PrepareInput, PrepareOutcome } from '../seams';
import { readPrepConfig } from './config';
import { prepEntryKey, prepEnv, prepLayout, prepPolicy, PrepState, whenFingerprint, writePrepToolConfig } from './plan';
import { checkPrepSandbox, PrepSandbox, type PrepRunResult, type PrepRunSpec } from './sandbox';

export interface DependencyPreparerOptions {
  paths: RunnerPaths;
  store: AttemptStore;
  config: () => RunnerConfig;
  logger?: Logger;
  ownerHome?: string;
  run?: (spec: PrepRunSpec) => Promise<PrepRunResult>;
  /** Only overrides availability with an injected runner. */
  available?: boolean;
  /** Checked at start and runs the commands when no runner is injected; defaults to one with the profile's domains. */
  sandbox?: PrepSandbox;
}

// Agents can write HOME and CARGO_HOME; their user configs must never steer a later preparation.
const USER_CONFIGS = {
  home: [
    '.bunfig.toml',
    '.config/.bunfig.toml',
    '.npmrc',
    '.yarnrc',
    '.yarnrc.yml',
    '.pip',
    '.config/pip',
    '.pydistutils.cfg',
    '.config/uv',
    'Library/Application Support/go/env',
    '.config/go/env',
  ],
  cargo: ['config', 'config.toml'],
} as const;

function statOrNull(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function realDirectory(path: string): void {
  if (!lstatSync(path).isDirectory()) throw new Error(`${path} is not a directory`);
}

function inside(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

/**
 * Makes path a real directory below root while the agent may still be running. A link or file in the way is removed
 * with removeInClone, which never deletes through a parent swapped for a link; a swap that redirects a mkdir is
 * caught by the final check, which fails the preparation before anything runs there.
 */
async function directory(root: string, path: string): Promise<void> {
  realDirectory(root);
  const real = realpathSync(root);
  const parts = relative(root, path).split('/').filter(Boolean);
  if (parts.some((part) => part === '..')) throw new Error(`${path} is outside ${root}`);
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]!);
    const stat = statOrNull(current);
    if (stat?.isDirectory()) continue;
    if (stat) await removeInClone(real, root, parts.slice(0, i + 1).join('/'));
    try {
      mkdirSync(current, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  if (!inside(realpathSync(path), real)) throw new Error(`${path} is not inside ${root}`);
}

async function cleanUserConfig(clone: string): Promise<void> {
  const real = realpathSync(clone);
  const run = runDirOf(clone, '');
  for (const [root, configs] of [
    [run.home, USER_CONFIGS.home],
    [join(run.cache, 'cargo'), USER_CONFIGS.cargo],
  ] as const) {
    for (const name of configs) {
      const path = join(root, name);
      // A linked or non-directory ancestor is itself unsafe config; it is replaced, never traversed.
      await directory(clone, dirname(path));
      await removeInClone(real, clone, relative(clone, path));
    }
  }
}

async function makeRunDirectories(clone: string, prep: string, env: Record<string, string>): Promise<void> {
  const cache = prepLayout(prep).cache;
  mkdirSync(cache, { recursive: true, mode: 0o700 });
  for (const name of [
    'HOME',
    'BUN_INSTALL_CACHE_DIR',
    'npm_config_cache',
    'npm_config_store_dir',
    'PIP_CACHE_DIR',
    'UV_CACHE_DIR',
    'GOMODCACHE',
    'CARGO_HOME',
  ]) {
    const path = env[name]!;
    await directory(path.startsWith(`${cache}/`) ? cache : clone, path);
  }
}

function runError(argv: string[], result: PrepRunResult, timeoutMs: number): string | null {
  const command = argv.join(' ');
  if (result.timedOut) {
    const duration = timeoutMs % 60_000 === 0 ? `${timeoutMs / 60_000} min` : `${timeoutMs} ms`;
    return `${command} timed out after ${duration}`;
  }
  if (result.signal) return `${command} terminated by ${result.signal}`;
  if (result.code !== 0) return `${command} exited with code ${result.code ?? 'unknown'}`;
  return null;
}

export async function createDependencyPreparer(options: DependencyPreparerOptions): Promise<DependencyPreparer> {
  const logger = options.logger ?? noopLogger;
  const ownerHome = options.ownerHome ?? homedir();
  let run = options.run;
  let available: boolean;
  if (run) {
    available = options.available ?? true;
  } else {
    const sandbox =
      options.sandbox ??
      new PrepSandbox({ allowedDomains: profileOf(options.config()).network.allowedDomains, logger });
    const checked = await checkPrepSandbox({ sandbox });
    available = checked.works;
    if (!available) logger.warn('dependency preparation unavailable', { reason: checked.reason });
    run = (spec) => sandbox.run(spec);
  }
  const commandRun = run;
  const pending = new Map<string, Promise<void>>();

  async function prepare(input: PrepareInput): Promise<PrepareOutcome> {
    if (!available) return { ran: false, ok: false, error: 'not available on this runner', logTail: null };
    let logTail: string | null = null;
    let ran = false;
    try {
      const record = options.store.get(input.attemptId);
      if (!record) throw new Error(`no attempt record for ${input.attemptId}`);
      if (record.spec.role !== 'worker') return { ran, ok: true, error: null, logTail };
      const config = await readPrepConfig(input.vault, input.baseSha);
      if (!config?.dependencies.length) return { ran, ok: true, error: null, logTail };
      // restoreProtected resolves a linked clone and would write through it.
      realDirectory(input.clone);
      const restore = () =>
        restoreProtected(
          { vault: input.vault, local: input.vault.local },
          { clone: input.clone, base: input.baseSha, paths: record.spec.restore.paths },
        );
      const prep = options.paths.prep(input.vault.project);
      const layout = prepLayout(prep);
      const state = new PrepState(prep);
      writePrepToolConfig(prep);
      let restored = false;
      for (const entry of config.dependencies) {
        // An entry that ran may have run agent-controlled code that rewrote .npmrc or bunfig.toml for the next one.
        if (!restored) {
          await restore();
          restored = true;
        }
        const key = prepEntryKey(entry);
        if (input.requestId === null && !state.needs(input.attemptId, key, whenFingerprint(input.clone, entry.when)))
          continue;
        ran = true;
        restored = false;
        const settings = options.config();
        mkdirSync(layout.tmp, { recursive: true, mode: 0o700 });
        const tmpDir = mkdtempSync(join(layout.tmp, 'run-'));
        try {
          await cleanUserConfig(input.clone);
          const env = prepEnv({ agentEnv: input.env, clone: input.clone, prep, tmpDir, entry });
          await makeRunDirectories(input.clone, prep, env);
          const result = await commandRun({
            argv: entry.run,
            cwd: input.clone,
            env,
            policy: prepPolicy({
              clone: input.clone,
              prep,
              tmpDir,
              entry,
              home: ownerHome,
              paths: options.paths,
              profile: profileOf(settings),
              vendorHomes: vendorHomes(settings, options.paths),
            }),
            timeoutMs: settings.timings.prep,
          });
          logTail = result.logTail;
          const error = runError(entry.run, result, settings.timings.prep);
          if (error) return { ran, ok: false, error, logTail };
          state.record(input.attemptId, key, whenFingerprint(input.clone, entry.when));
        } finally {
          rmSync(tmpDir, { recursive: true, force: true });
        }
      }
      return { ran, ok: true, error: null, logTail };
    } catch (error) {
      return { ran: true, ok: false, error: error instanceof Error ? error.message : String(error), logTail };
    }
  }

  return Object.freeze({
    available,
    prepare(input: PrepareInput): Promise<PrepareOutcome> {
      const result = (pending.get(input.attemptId) ?? Promise.resolve()).then(() => prepare(input));
      const settled = result.then(
        () => {},
        () => {},
      );
      pending.set(input.attemptId, settled);
      void settled.then(() => {
        if (pending.get(input.attemptId) === settled) pending.delete(input.attemptId);
      });
      return result;
    },
  });
}
