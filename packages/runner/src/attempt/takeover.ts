// prepare_takeover (design 6.12, 8.4, 9.4). The controller stops the agent with a handoff turn, harvests and pushes
// its WIP, and then hands the clone to a person: the protected paths restored, and the agent's .git replaced wholesale
// by one the runner builds, a fresh `clone --shared` of the vault with HEAD and the task branch at the harvested head
// and the index rebuilt, so `git status` shows the uncommitted work as changes. The agent's .git moves to
// runner/forensics/<attempt>/, out of every later harvest's reach, and is inspected there: program-valued config,
// hooks, commondir or gitdir files and extra alternates are reported as attempt.violation phase takeover. Every other
// .git the agent left in the work tree goes there too, under its path in the clone, since the person's git would
// recurse into it (a committed gitlink makes it a submodule) and run whatever its config names. The runner
// core builds both commands of attempt.taken_over (X-5): the local one runs the runner's pinned binary of the
// attempt's own CLI version (X-13) with its vendor home; the anywhere one is core's takeoverAnywhereCommand.
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { takeoverAnywhereCommand, takeoverRef, type Vendor } from '@agflow/core';
import { readSized } from '../git/clone';
import { type GitEnvironment, runGit } from '../git/run';
import type { Vault } from '../git/vault';
import { vendorBinary } from '../vendor/pins';

/** The reason the take-over's handoff turn quotes. */
export const TAKEOVER_STOP_REASON = 'a person takes the task over';

/** What prepare_takeover gives: attempt.taken_over's seq, or why nothing was taken over. */
export type TakeoverOutcome = { ok: true; takenOverSeq: number } | { ok: false; error: 'stale_fence' | 'not_running' };

const SAFE_SHELL_WORD = /^[A-Za-z0-9_\/.:=@%+,-]+$/;

/** A word a POSIX shell reads back as it is: left bare when safe, single-quoted otherwise. */
export function shellWord(word: string): string {
  return SAFE_SHELL_WORD.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

export interface LocalCommandInput {
  vendor: Vendor;
  /** The CLI version the attempt started with (X-13). */
  cliVersion: string;
  /** The session or thread to resume; null when the agent never started one. */
  sessionRef: string | null;
  /** The clone's real path. */
  clone: string;
  /** RunnerPaths.runner, under which the pinned binaries live. */
  runnerDir: string;
  /** The vendor's home as the agents had it: vendorHomes(config, paths)[vendor]. */
  home: string;
}

export interface TakeoverCommandsInput {
  /** What the local command resumes; null when the clone was not handed over. */
  local: LocalCommandInput | null;
  wipRefPrefix: string;
  taskId: string;
  /** The attempt's WIP ref, which the anywhere command fetches. */
  wipRef: string;
  branch: string;
  /** The person's login, which names their take-over ref. */
  person: string;
}

/**
 * The take-over command on the runner's laptop (design 6.12): the pinned binary of the attempt's own CLI version
 * resuming its session in the clone, with the runner's vendor home. Null without a session to resume.
 */
export function takeoverLocalCommand(input: LocalCommandInput): string | null {
  if (input.sessionRef === null) return null;
  const binary = shellWord(join(input.runnerDir, vendorBinary(input.vendor, input.cliVersion)));
  const session = shellWord(input.sessionRef);
  // Codex protects .git inside its workspace-write sandbox by default; the person gets the same writable root the agent
  // had (adapters/codex/config.ts threadOverrides), so they can commit from the resumed session. Nothing else widens.
  const gitRoot = `sandbox_workspace_write.writable_roots=${JSON.stringify([join(input.clone, '.git')])}`;
  const resume =
    input.vendor === 'claude'
      ? `CLAUDE_CONFIG_DIR=${shellWord(input.home)} ${binary} --resume ${session}`
      : `CODEX_HOME=${shellWord(input.home)} ${binary} resume --no-daemon -s workspace-write -c ${shellWord(gitRoot)} ${session}`;
  return `cd ${shellWord(input.clone)} && ${resume}`;
}

/**
 * attempt.taken_over's commands: the local one (null when the clone was not handed over or has no session), and
 * anywhere, the fetch of the WIP ref onto the task branch and the push to the person's take-over ref, as core builds
 * it for the hub too.
 */
export function takeoverCommands(input: TakeoverCommandsInput): { local: string | null; anywhere: string } {
  const anywhere = takeoverAnywhereCommand({
    ref: input.wipRef,
    branch: input.branch,
    takeoverRef: takeoverRef(input.wipRefPrefix, input.taskId, input.person),
  });
  return { local: input.local === null ? null : takeoverLocalCommand(input.local), anywhere };
}

/** Where the next of an attempt's moved-aside git directories goes: git, then git-2, git-3 and so on. */
async function forensicsTarget(forensics: string): Promise<string> {
  await mkdir(forensics, { recursive: true, mode: 0o700 });
  for (let n = 1; ; n++) {
    const target = join(forensics, n === 1 ? 'git' : `git-${n}`);
    if ((await lstat(target).catch(() => null)) === null) return target;
  }
}

/**
 * Replaces <clone>/.git with a git directory the runner builds: a `clone --shared --no-checkout` of the vault, with
 * HEAD on the task branch at head and the index read from it, and .agflow/run/ excluded. The old .git, whatever it
 * is, moves to the next free place under forensics. Gives where it went; null when the clone had none.
 */
export async function replaceGitDir(input: {
  vault: Vault;
  local: GitEnvironment;
  clone: string;
  branch: string;
  head: string;
  forensics: string;
}): Promise<string | null> {
  const { vault, local, clone, branch, head } = input;
  // Built beside the clone, never inside it, so nothing of the agent's can reach the new directory first.
  const building = join(dirname(clone), `.${basename(clone)}.takeover`);
  await rm(building, { recursive: true, force: true });
  try {
    await runGit(local, ['clone', '--quiet', '--shared', '--no-checkout', '--template=', vault.path, building]);
    const gitDir = join(building, '.git');
    const git = (args: string[]) => runGit(local, [`--git-dir=${gitDir}`, ...args]);
    await git(['update-ref', `refs/heads/${branch}`, head]);
    await git(['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
    await git(['read-tree', head]);
    await mkdir(join(gitDir, 'info'), { recursive: true });
    await writeFile(join(gitDir, 'info', 'exclude'), '# Written by the agflow runner.\n/.agflow/run/\n');
    const old = join(clone, '.git');
    let moved: string | null = null;
    if ((await lstat(old).catch(() => null)) !== null) {
      moved = await forensicsTarget(input.forensics);
      await rename(old, moved);
    }
    await rename(gitDir, old);
    return moved;
  } finally {
    await rm(building, { recursive: true, force: true });
  }
}

/**
 * Moves every .git the agent left in the clone's work tree, other than the clone's own, whatever it is (a directory,
 * a file or a link), to forensics/nested/<n>/<its path in the clone>, n counting take-overs. The walk never follows
 * a link and skips nothing else, .agflow/run included; a directory the agent made unreadable is made readable first.
 * Gives the moved entries' paths in the clone and where each went, in path order.
 */
export async function moveNestedGitDirs(input: {
  clone: string;
  forensics: string;
}): Promise<{ path: string; moved: string }[]> {
  const { clone } = input;
  const found: string[] = [];
  const pending = [''];
  while (pending.length > 0) {
    const dir = pending.pop() as string;
    const full = dir === '' ? clone : join(clone, dir);
    const entries = await readdir(full, { withFileTypes: true }).catch(async () => {
      await chmod(full, 0o700);
      return readdir(full, { withFileTypes: true });
    });
    for (const entry of entries) {
      const path = dir === '' ? entry.name : `${dir}/${entry.name}`;
      // The clone's own .git is replaced as a whole.
      if (path === '.git') continue;
      if (entry.name === '.git') found.push(path);
      else if (entry.isDirectory()) pending.push(path);
    }
  }
  if (found.length === 0) return [];
  const nested = join(input.forensics, 'nested');
  await mkdir(nested, { recursive: true, mode: 0o700 });
  let target = '';
  for (let n = 1; ; n++) {
    target = join(nested, String(n));
    if ((await lstat(target).catch(() => null)) === null) break;
  }
  const moved: { path: string; moved: string }[] = [];
  for (const path of found.sort()) {
    const to = join(target, path);
    await mkdir(dirname(to), { recursive: true, mode: 0o700 });
    await rename(join(clone, path), to);
    moved.push({ path, moved: to });
  }
  return moved;
}

/** The config keys whose values git runs as programs or reads as other configuration, lower-cased as git lists them. */
const PROGRAM_KEYS = new Set([
  'core.hookspath',
  'core.alternaterefscommand',
  'gpg.ssh.defaultkeycommand',
  'core.sshcommand',
  'core.editor',
  'core.pager',
  'core.askpass',
  'core.gitproxy',
  'core.worktree',
  'sequence.editor',
  'diff.external',
  'gpg.program',
  'credential.helper',
  'interactive.difffilter',
  'uploadpack.packobjectshook',
  'web.browser',
  'include.path',
]);

const PROGRAM_KEY_PATTERNS = [
  /^includeif\..+\.path$/,
  /^filter\..+\.(clean|smudge|process)$/,
  /^diff\..+\.(textconv|command)$/,
  /^merge\..+\.driver$/,
  /^credential\..+\.helper$/,
  /^gpg\..+\.program$/,
  /^remote\..+\.(uploadpack|receivepack|vcs)$/,
  /^(difftool|mergetool|man|browser)\..+\.(cmd|path)$/,
  /^pager\..+$/,
  /^trailer\..+\.(cmd|command)$/,
  /^sendemail\..*cmd$/,
  /^tar\..+\.command$/,
];

/** Whether git would run a config entry's value, or read another file through it. */
function isProgramValued(key: string, value: string): boolean {
  if (PROGRAM_KEYS.has(key) || PROGRAM_KEY_PATTERNS.some((pattern) => pattern.test(key))) return true;
  // fsmonitor is a boolean for git's own daemon, and a program otherwise.
  if (key === 'core.fsmonitor') return !/^(true|false|yes|no|on|off|1|0)?$/i.test(value.trim());
  // An alias or a submodule's update mode that starts with ! is a shell command.
  const shell = value.trimStart().startsWith('!');
  return shell && (key.startsWith('alias.') || /^submodule\..+\.update$/.test(key));
}

/** A small file of the moved .git, read without following a link; null when it is absent. */
async function readSmallFile(path: string, maxBytes: number): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error(`${path} is not a small regular file`);
    return await readSized(handle, stat.size, path);
  } finally {
    await handle.close();
  }
}

/**
 * Lists one config file of a moved .git, its includes not followed, adding each program-valued key to found as
 * `<label>:<key>`; a file that is not a regular one, or that git cannot list, is reported as label.
 */
async function inspectConfigFile(local: GitEnvironment, file: string, label: string, found: string[]): Promise<void> {
  const stat = await lstat(file).catch(() => null);
  if (stat === null) return;
  if (!stat.isFile()) {
    found.push(label);
    return;
  }
  // --no-includes: the listing itself must not read the files the agent pointed at.
  const listed = await runGit(local, ['config', '--file', file, '--no-includes', '--list', '-z'], { check: false });
  if (listed.code !== 0) found.push(label);
  for (const entry of listed.stdout.split('\0')) {
    if (entry === '') continue;
    const newline = entry.indexOf('\n');
    const key = newline < 0 ? entry : entry.slice(0, newline);
    const value = newline < 0 ? '' : entry.slice(newline + 1);
    if (isProgramValued(key, value)) found.push(`${label}:${key}`);
  }
}

/**
 * What an agent's moved .git held that the runner never planted, as paths relative to the clone, label (`.git`, or a
 * nested one's path) standing for the directory: program-valued config keys (`.git/config:<key>`, and those of
 * config.worktree and each worktrees/<name>/config.worktree, which git reads with extensions.worktreeConfig), hooks,
 * commondir and gitdir files, and alternates other than the vault's objects. Anything that is a link, or that cannot
 * be read as the runner expects, is reported as it stands.
 */
export async function inspectAgentGitDir(input: {
  gitDir: string;
  local: GitEnvironment;
  vault: Vault;
  label?: string;
}): Promise<string[]> {
  const { gitDir, local } = input;
  const label = input.label ?? '.git';
  const found: string[] = [];
  const top = await lstat(gitDir);
  if (!top.isDirectory()) return [label];
  await inspectConfigFile(local, join(gitDir, 'config'), `${label}/config`, found);
  await inspectConfigFile(local, join(gitDir, 'config.worktree'), `${label}/config.worktree`, found);
  const worktrees = join(gitDir, 'worktrees');
  const worktreesStat = await lstat(worktrees).catch(() => null);
  if (worktreesStat !== null && !worktreesStat.isDirectory()) found.push(`${label}/worktrees`);
  else if (worktreesStat !== null) {
    const names = await readdir(worktrees).catch(() => null);
    if (names === null) found.push(`${label}/worktrees`);
    for (const name of (names ?? []).sort()) {
      const file = join(worktrees, name, 'config.worktree');
      await inspectConfigFile(local, file, `${label}/worktrees/${name}/config.worktree`, found);
    }
  }
  const hooks = join(gitDir, 'hooks');
  const hooksStat = await lstat(hooks).catch(() => null);
  if (hooksStat !== null && !hooksStat.isDirectory()) found.push(`${label}/hooks`);
  else if (hooksStat !== null) {
    // The runner makes clones with no template: whatever is here, the agent put here. git never runs a .sample, and
    // a directory the runner cannot read is suspect in itself.
    const names = await readdir(hooks).catch(() => null);
    if (names === null) found.push(`${label}/hooks`);
    for (const name of (names ?? []).sort()) {
      if (!name.endsWith('.sample')) found.push(`${label}/hooks/${name}`);
    }
  }
  for (const name of ['commondir', 'gitdir']) {
    if ((await lstat(join(gitDir, name)).catch(() => null)) !== null) found.push(`${label}/${name}`);
  }
  const alternates = join(gitDir, 'objects', 'info', 'alternates');
  let lines: string[] = [];
  try {
    lines = ((await readSmallFile(alternates, 64 * 1024)) ?? '').split('\n');
  } catch {
    found.push(`${label}/objects/info/alternates`);
  }
  const vaultObjects = new Set([join(input.vault.path, 'objects')]);
  vaultObjects.add(await realpath(join(input.vault.path, 'objects')).catch(() => join(input.vault.path, 'objects')));
  const extra = lines.map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('#'));
  if (extra.some((line) => !vaultObjects.has(line))) found.push(`${label}/objects/info/alternates`);
  return found;
}
