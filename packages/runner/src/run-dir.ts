// A clone's .agflow/run/ (design 7.2): runner-owned, untracked and never committed. It holds the task pack and the
// brief, the Codex tool HOME, per-attempt package caches, a temporary directory and the bridge's empty
// AGFLOW_CONFIG_DIR (X-32).
//
// What processes outside the sandbox run or read as git config stays out of the clone, which the agent can write:
// the Claude CLI runs git in the clone for its context, and sources the owner's shell profile, with the agent's
// environment. So the agent gitconfig, the refusal scripts on PATH and gh's and glab's config directories live in a
// read-only tools directory under vaults/ (paths.agentTools), which agents may read but never write.
//
// The runner writes all of this with the owner's full rights and outside any sandbox, into a tree the agent may have
// prepared (a clone it kept, or a committed `.agflow/run/task.md -> ~/.zshrc`), so it never follows a link there.
import {
  chmodSync,
  closeSync,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  rmSync,
  type Stats,
  writeSync,
} from 'node:fs';
import { dirname, join, sep } from 'node:path';
import type { AgentGitPaths } from './git/run';

export interface RunDir extends AgentGitPaths {
  /** <clone>/.agflow/run. */
  root: string;
  taskMd: string;
  briefMd: string;
  /** The Codex tool commands' HOME. */
  home: string;
  /** Per-attempt package caches. */
  cache: string;
  /** The Codex tool commands' TMPDIR. */
  tmp: string;
  /** AGFLOW_CONFIG_DIR for the bridge and the brief hook: no credentials, only hook.log. */
  config: string;
  /** The runner-owned, read-only tools directory outside the clone; cleanup removes it with removeAgentTools. */
  tools: string;
  /** First on the agent's PATH: the gh and glab shims. */
  bin: string;
}

export function runDirOf(clone: string, tools: string): RunDir {
  const root = join(clone, '.agflow', 'run');
  return {
    root,
    taskMd: join(root, 'task.md'),
    briefMd: join(root, 'brief.md'),
    home: join(root, 'home'),
    cache: join(root, 'cache'),
    tmp: join(root, 'tmp'),
    config: join(root, 'config'),
    tools,
    gitconfig: join(tools, 'gitconfig'),
    bin: join(tools, 'bin'),
    sshRefusal: join(tools, 'ssh-refusal'),
    ghConfigDir: join(tools, 'gh-config'),
    glabConfigDir: join(tools, 'glab-config'),
  };
}

/** The line the hub cannot write, since it does not know the clone's path (X-17). */
export function withWorkingDirectory(brief: string, clone: string): string {
  return `${brief.replace(/\n+$/, '')}\n\nYour working directory: ${clone}`;
}

/** A value in git's config syntax: quoted, with backslashes and quotes escaped; a newline cannot be held. */
function configValue(value: string, what: string): string {
  if (/[\n\r\0]/.test(value)) throw new Error(`the commit identity's ${what} cannot hold a line break`);
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function agentGitconfig(identity: { name: string; email: string }): string {
  return [
    '# Written by the agflow runner. Agents cannot push: the runner pushes for them.',
    '[user]',
    `\tname = ${configValue(identity.name, 'name')}`,
    `\temail = ${configValue(identity.email, 'email')}`,
    '[credential]',
    '\thelper =',
    '[protocol]',
    '\tallow = never',
    '[protocol "file"]',
    '\tallow = always',
    '',
  ].join('\n');
}

function refusal(what: string): string {
  const explanation =
    `agflow: ${what} is not available to runner agents. ` + 'Commit on your task branch; the runner pushes for you.';
  return ['#!/bin/sh', `echo "${explanation}" >&2`, 'exit 1', ''].join('\n');
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Makes path a real directory, keeping one that is: a link or a file there is removed, never followed. */
function realDirectory(path: string): void {
  const stat = lstatOrNull(path);
  if (stat?.isDirectory()) return;
  if (stat) rmSync(path, { force: true });
  mkdirSync(path);
}

/**
 * Writes a new file: whatever is at path goes first (rmSync removes a link, not its target), and O_EXCL refuses a
 * link that appears meanwhile. The mode is set on the open file, never through the path.
 */
function writeNew(path: string, content: string, mode: number): void {
  rmSync(path, { recursive: true, force: true });
  const fd = openSync(path, 'wx', mode);
  try {
    fchmodSync(fd, mode);
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
}

function inside(child: string, parent: string): boolean {
  return child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
}

/** Removes an attempt's tools directory, read-only as writeRunDir leaves it; nothing there is no error. */
export function removeAgentTools(tools: string): void {
  const stat = lstatOrNull(tools);
  if (!stat) return;
  if (stat.isDirectory()) {
    // Its directories are read-only: writable again first, or their entries cannot be removed.
    const writable = (dir: string) => {
      chmodSync(dir, 0o700);
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) writable(join(dir, entry.name));
      }
    };
    writable(tools);
  }
  rmSync(tools, { recursive: true, force: true });
}

export interface RunDirInput {
  clone: string;
  /** paths.agentTools(project, attemptId). */
  tools: string;
  /** AttemptSpec.taskPack. */
  taskPack: string;
  /** The brief as the agent gets it, withWorkingDirectory applied. */
  brief: string;
  /** runner.json's commitIdentity. */
  identity: { name: string; email: string };
}

/**
 * Writes the clone's .agflow/run/ and the attempt's tools directory. Writing again replaces the runner's files,
 * keeps what the agent put in its directories (caches, say), and makes the tools directory anew.
 */
export function writeRunDir(input: RunDirInput): RunDir {
  const gitconfig = agentGitconfig(input.identity);
  const dir = runDirOf(input.clone, input.tools);
  realDirectory(join(input.clone, '.agflow'));
  realDirectory(dir.root);
  const clone = realpathSync(input.clone);
  if (!inside(realpathSync(dir.root), clone)) throw new Error(`${dir.root} is not inside the clone ${clone}`);
  for (const path of [dir.home, dir.cache, dir.tmp, dir.config]) realDirectory(path);
  writeNew(dir.taskMd, input.taskPack, 0o644);
  writeNew(dir.briefMd, input.brief.endsWith('\n') ? input.brief : `${input.brief}\n`, 0o644);

  removeAgentTools(dir.tools);
  mkdirSync(dirname(dir.tools), { recursive: true });
  for (const path of [dir.tools, dir.bin, dir.ghConfigDir, dir.glabConfigDir]) mkdirSync(path, { mode: 0o700 });
  writeNew(dir.gitconfig, gitconfig, 0o444);
  writeNew(join(dir.bin, 'gh'), refusal('gh'), 0o555);
  writeNew(join(dir.bin, 'glab'), refusal('glab'), 0o555);
  writeNew(dir.sshRefusal, refusal('SSH (git push, fetch or clone over ssh)'), 0o555);
  // Read-only, so not even the agent's own git, running as the owner, can change it.
  for (const path of [dir.ghConfigDir, dir.glabConfigDir, dir.bin, dir.tools]) chmodSync(path, 0o555);
  return dir;
}
