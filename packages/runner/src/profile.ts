// The permission profile and the denied paths of design 7.6, as data. The vendor adapters render them: Claude's
// permission rules and sandbox settings (M2d), Codex's sandbox (M2e), and dependency preparation's sandbox (M2c).
import { isAbsolute, join } from 'node:path';
import type { Vendor } from '@agflow/core';
import type { RunnerConfig } from './config';
import type { RunnerPaths } from './paths';

export interface PermissionProfile {
  /** Claude: acceptEdits with the sandbox, or auto mode with the sandbox. */
  name: 'standard' | 'auto';
  /** The hosts agent tool commands may reach (Claude's sandbox). */
  network: { allowedDomains: string[] };
  /** WebFetch and WebSearch (Claude), web search (Codex). */
  webTools: boolean;
}

/** The package registries of the default profile. */
const REGISTRIES = [
  'registry.npmjs.org',
  'registry.yarnpkg.com',
  'bun.sh',
  'pypi.org',
  'files.pythonhosted.org',
  'proxy.golang.org',
  'sum.golang.org',
  'crates.io',
  'static.crates.io',
  'index.crates.io',
];

/** The default profile. Frozen: profileOf gives copies to change. */
export const standardProfile: PermissionProfile = Object.freeze({
  name: 'standard',
  network: Object.freeze({ allowedDomains: Object.freeze([...REGISTRIES]) as string[] }),
  webTools: false,
});

/**
 * The profile runner.json asks for. Whether the account offers auto mode is the Claude adapter's to check; it falls
 * back to standard and reports so.
 */
export function profileOf(config: Pick<RunnerConfig, 'profile'>): PermissionProfile {
  return { name: config.profile, network: { allowedDomains: [...REGISTRIES] }, webTools: false };
}

/** An absolute path; tree marks a directory whose whole contents are meant. */
export interface DeniedPath {
  path: string;
  tree: boolean;
}

export interface DeniedPathsInput {
  /** The owner's home, given rather than read from the process. */
  home: string;
  paths: Pick<RunnerPaths, 'runner' | 'vaults' | 'work'>;
  /** vendorHomes(config, paths): runner.json may put them outside the runner tree, shared by several runners. */
  vendorHomes: Record<Vendor, string>;
}

const tree = (path: string): DeniedPath => ({ path, tree: true });
const file = (path: string): DeniedPath => ({ path, tree: false });

/** The vendor homes the runner tree does not already cover: their logins, transcripts and .claude.json. */
function outsideHomes(input: DeniedPathsInput): DeniedPath[] {
  const runner = `${input.paths.runner}/`;
  const homes = [...new Set(Object.values(input.vendorHomes))];
  return homes.filter((home) => !`${home}/`.startsWith(runner)).map(tree);
}

/**
 * A denied path that holds the work root would deny the agent its own clone: deny rules cannot be re-allowed, and
 * Claude copies Edit denials into the sandbox's denyWrite (7.6).
 */
function checked(input: DeniedPathsInput, denied: DeniedPath[]): DeniedPath[] {
  if (!isAbsolute(input.home)) throw new Error(`the owner's home must be an absolute path, not ${input.home}`);
  for (const { path } of denied) {
    if (`${input.paths.work}/`.startsWith(`${path}/`) || path.startsWith(`${input.paths.work}/`)) {
      throw new Error(`the denied path ${path} would cover the work root ${input.paths.work}; move AGFLOW_HOME`);
    }
  }
  return denied;
}

/**
 * Paths agents may not read: credentials, vendor and CLI state, the whole runner tree and vendor homes outside it.
 * The Claude adapter names only the runner tree's sensitive parts in its Read rules, keeps its allowRead for the
 * attempt's own project directory, and adds the work root to its sandbox's denyRead with the clone allowed; neither
 * is listed here.
 */
export function deniedReadPaths(input: DeniedPathsInput): DeniedPath[] {
  const home = (...parts: string[]) => join(input.home, ...parts);
  return checked(input, [
    tree(home('.ssh')),
    file(home('.netrc')),
    file(home('.git-credentials')),
    tree(home('.config', 'gh')),
    tree(home('.config', 'glab-cli')),
    tree(home('.config', 'agflow')),
    tree(input.paths.runner),
    ...outsideHomes(input),
    tree(home('.claude')),
    file(home('.claude.json')),
    tree(home('.codex')),
    tree(home('Library', 'Keychains')),
    tree(home('.aws')),
    tree(home('.config', 'gcloud')),
    tree(home('.kube')),
    file(home('.docker', 'config.json')),
  ]);
}

/**
 * Paths agents may not write: runner state, vendor homes outside it and the vaults (with the attempts' tools
 * directories), vendor and CLI config, LaunchAgents and shell profiles.
 */
export function deniedWritePaths(input: DeniedPathsInput): DeniedPath[] {
  const home = (...parts: string[]) => join(input.home, ...parts);
  return checked(input, [
    tree(input.paths.runner),
    ...outsideHomes(input),
    tree(input.paths.vaults),
    tree(home('.claude')),
    file(home('.claude.json')),
    tree(home('.codex')),
    tree(home('.config', 'agflow')),
    tree(home('Library', 'LaunchAgents')),
    ...['.zshrc', '.zprofile', '.zshenv', '.bashrc', '.bash_profile', '.profile', '.gitconfig'].map((name) =>
      file(home(name)),
    ),
  ]);
}
