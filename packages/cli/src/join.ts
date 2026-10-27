import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AgentRole, Vendor } from '@agflow/core';
import { type ParsedArgs, choiceFlag } from './args';
import { loadCredentials } from './credentials';
import { addExclude, isTracked, repoRoot } from './git';
import type { Io } from './io';
import { configDir } from './paths';
import { type SelfCommand, selfCommand, shellCommand } from './self';

/** Every hook handler agflow writes carries this statusMessage, so it can be found again. */
export const HOOK_MARK = 'agflow';

export type Runner = (cmd: string[], cwd: string) => { code: number; output: string };

export const defaultRunner: Runner = (cmd, cwd) => {
  const result = Bun.spawnSync(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' });
  return { code: result.exitCode, output: `${result.stdout.toString()}${result.stderr.toString()}`.trim() };
};

export type HookHandler = Record<string, unknown>;
export interface HookGroup {
  matcher?: string;
  hooks: HookHandler[];
}
export type HooksConfig = Record<string, HookGroup[]>;

export function withoutAgflowHooks(hooks: HooksConfig | undefined): HooksConfig {
  const result: HooksConfig = {};
  for (const [event, groups] of Object.entries(hooks ?? {})) {
    const kept = groups
      .map((group) => ({ ...group, hooks: group.hooks.filter((handler) => handler.statusMessage !== HOOK_MARK) }))
      .filter((group) => group.hooks.length > 0);
    if (kept.length > 0) result[event] = kept;
  }
  return result;
}

export function addHookGroups(hooks: HooksConfig, additions: HooksConfig): HooksConfig {
  const result: HooksConfig = { ...hooks };
  for (const [event, groups] of Object.entries(additions)) result[event] = [...(result[event] ?? []), ...groups];
  return result;
}

export function readJsonFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, 'utf8').trim();
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

export function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Writes the settings back without agflow's hooks, deleting the file if nothing else is left in it. */
export function stripAgflowHooksFile(path: string): void {
  if (!existsSync(path)) return;
  const settings = readJsonFile(path);
  const hooks = withoutAgflowHooks(settings.hooks as HooksConfig | undefined);
  const next: Record<string, unknown> = { ...settings };
  if (Object.keys(hooks).length > 0) next.hooks = hooks;
  else delete next.hooks;
  if (Object.keys(next).length === 0) rmSync(path);
  else writeJsonFile(path, next);
}

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

export const CLAUDE_SETTINGS = '.claude/settings.local.json';

export function claudeHooks(self: SelfCommand, role: AgentRole): HooksConfig {
  const handler = (event: string, extra: Record<string, unknown> = {}): HookHandler => ({
    type: 'command',
    command: self.command,
    args: [...self.args, 'hook', event, '--vendor', 'claude', '--role', role],
    statusMessage: HOOK_MARK,
    ...extra,
  });
  const waiter = handler('wait-inbox', { asyncRewake: true });
  return {
    SessionStart: [{ hooks: [handler('session-start', { timeout: 20 }), waiter] }],
    UserPromptSubmit: [{ hooks: [handler('user-prompt-submit', { timeout: 15 })] }],
    Stop: [{ hooks: [handler('stop', { timeout: 20 }), waiter] }],
  };
}

export function joinClaude(root: string, self: SelfCommand, role: AgentRole, run: Runner): void {
  if (isTracked(root, CLAUDE_SETTINGS)) {
    throw new Error(`${CLAUDE_SETTINGS} is tracked by git; agflow keeps its settings out of git and cannot use it`);
  }
  run(['claude', 'mcp', 'remove', '--scope', 'local', 'agflow'], root);
  const added = run(
    ['claude', 'mcp', 'add', '--scope', 'local', 'agflow', '--', self.command, ...self.args, 'mcp', '--vendor', 'claude'],
    root,
  );
  if (added.code !== 0) throw new Error(`claude mcp add failed: ${added.output}`);
  const path = join(root, CLAUDE_SETTINGS);
  const settings = readJsonFile(path);
  const hooks = addHookGroups(withoutAgflowHooks(settings.hooks as HooksConfig | undefined), claudeHooks(self, role));
  writeJsonFile(path, { ...settings, hooks });
  addExclude(root, CLAUDE_SETTINGS);
}

export function leaveClaude(root: string, run: Runner): void {
  run(['claude', 'mcp', 'remove', '--scope', 'local', 'agflow'], root);
  stripAgflowHooksFile(join(root, CLAUDE_SETTINGS));
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

export const CODEX_CONFIG = '.codex/config.toml';
export const CODEX_HOOKS = '.codex/hooks.json';
const BLOCK_START = '# >>> agflow (managed by agflow join; do not edit) >>>';
const BLOCK_END = '# <<< agflow <<<';

const tomlString = (value: string) => JSON.stringify(value);

export function codexMcpBlock(self: SelfCommand, root: string): string {
  const args = [...self.args, 'mcp', '--vendor', 'codex'];
  return [
    BLOCK_START,
    '[mcp_servers.agflow]',
    `command = ${tomlString(self.command)}`,
    `args = [${args.map(tomlString).join(', ')}]`,
    `cwd = ${tomlString(root)}`,
    BLOCK_END,
  ].join('\n');
}

export function withoutAgflowBlock(text: string): string {
  const kept: string[] = [];
  let inside = false;
  for (const line of text.split('\n')) {
    if (line === BLOCK_START) {
      inside = true;
      continue;
    }
    if (inside) {
      if (line === BLOCK_END) inside = false;
      continue;
    }
    kept.push(line);
  }
  const result = kept.join('\n').replace(/\n+$/, '');
  return result ? `${result}\n` : '';
}

export function codexHooks(self: SelfCommand, role: AgentRole): HooksConfig {
  const handler = (event: string, extra: Record<string, unknown> = {}): HookHandler => ({
    type: 'command',
    command: shellCommand([self.command, ...self.args, 'hook', event, '--vendor', 'codex', '--role', role]),
    statusMessage: HOOK_MARK,
    timeout: 20,
    ...extra,
  });
  return {
    SessionStart: [{ hooks: [handler('session-start', { additionalContextLimit: 4000 })] }],
    UserPromptSubmit: [{ hooks: [handler('user-prompt-submit', { additionalContextLimit: 4000 })] }],
    Stop: [{ hooks: [handler('stop')] }],
  };
}

export function joinCodex(root: string, self: SelfCommand, role: AgentRole): void {
  for (const file of [CODEX_CONFIG, CODEX_HOOKS]) {
    if (isTracked(root, file)) throw new Error(`${file} is tracked by git; agflow keeps its settings out of git and cannot add to it`);
  }
  const configPath = join(root, CODEX_CONFIG);
  const base = withoutAgflowBlock(existsSync(configPath) ? readFileSync(configPath, 'utf8') : '');
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${base}${base ? '\n' : ''}${codexMcpBlock(self, root)}\n`);
  const hooksPath = join(root, CODEX_HOOKS);
  const hooksFile = readJsonFile(hooksPath);
  writeJsonFile(hooksPath, {
    ...hooksFile,
    hooks: addHookGroups(withoutAgflowHooks(hooksFile.hooks as HooksConfig | undefined), codexHooks(self, role)),
  });
  addExclude(root, CODEX_CONFIG);
  addExclude(root, CODEX_HOOKS);
}

export function leaveCodex(root: string): void {
  const configPath = join(root, CODEX_CONFIG);
  if (existsSync(configPath)) {
    const rest = withoutAgflowBlock(readFileSync(configPath, 'utf8'));
    if (rest) writeFileSync(configPath, rest);
    else rmSync(configPath);
  }
  stripAgflowHooksFile(join(root, CODEX_HOOKS));
}

// ---------------------------------------------------------------------------
// Joined repositories and the commands
// ---------------------------------------------------------------------------

export interface JoinedRepo {
  root: string;
  role: AgentRole;
  vendors: Vendor[];
  joinedAt: string;
}

const joinedPath = (dir: string) => join(dir, 'joined.json');

export function loadJoined(dir: string): JoinedRepo[] {
  const path = joinedPath(dir);
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as JoinedRepo[]) : [];
}

function saveJoined(dir: string, repos: JoinedRepo[]): void {
  writeJsonFile(joinedPath(dir), repos);
}

export interface JoinOptions {
  cwd: string;
  dir: string;
  role: AgentRole;
  vendors: Vendor[];
  self: SelfCommand;
  run: Runner;
}

/** Joins the repository containing cwd and returns lines to show the person. */
export function joinRepository(options: JoinOptions): string[] {
  const credentials = loadCredentials(options.dir);
  if (!credentials) throw new Error('not signed in; run agflow login --hub <url> first');
  const root = repoRoot(options.cwd);
  if (!root) throw new Error('run agflow join inside the project’s git repository');
  addExclude(root, '.worktrees/');
  if (options.vendors.includes('claude')) joinClaude(root, options.self, options.role, options.run);
  if (options.vendors.includes('codex')) joinCodex(root, options.self, options.role);
  const others = loadJoined(options.dir).filter((repo) => repo.root !== root);
  saveJoined(options.dir, [...others, { root, role: options.role, vendors: options.vendors, joinedAt: new Date().toISOString() }]);
  const lines = [`Joined ${root} to ${credentials.hubUrl} as ${options.role}.`];
  if (options.vendors.includes('claude')) {
    lines.push('Claude Code: start a new chat in this repository; it will receive an agflow brief and the agflow tools.');
  }
  if (options.vendors.includes('codex')) {
    lines.push('Codex: trust this project if Codex asks, then run /hooks once and trust the three agflow hooks. New chats here receive the agflow brief and tools.');
  }
  if (options.role === 'lead') lines.push('Lead: one lead is active per project; if another lead is active, this chat registers as a worker.');
  return lines;
}

export function leaveRepository(options: { cwd: string; dir: string; run: Runner }): string {
  const root = repoRoot(options.cwd);
  if (!root) throw new Error('run agflow leave inside the project’s git repository');
  leaveClaude(root, options.run);
  leaveCodex(root);
  saveJoined(options.dir, loadJoined(options.dir).filter((repo) => repo.root !== root));
  return `Removed agflow from ${root}.`;
}

export async function joinCommand(args: ParsedArgs, io: Io): Promise<number> {
  const role = choiceFlag(args, 'role', ['worker', 'lead'] as const, 'worker');
  const vendor = choiceFlag(args, 'vendor', ['claude', 'codex', 'both'] as const, 'both');
  const vendors: Vendor[] = vendor === 'both' ? ['claude', 'codex'] : [vendor];
  const lines = joinRepository({ cwd: process.cwd(), dir: configDir(), role, vendors, self: selfCommand(), run: defaultRunner });
  io.out(`${lines.join('\n')}\n`);
  return 0;
}

export async function leaveCommand(_args: ParsedArgs, io: Io): Promise<number> {
  io.out(`${leaveRepository({ cwd: process.cwd(), dir: configDir(), run: defaultRunner })}\n`);
  return 0;
}
