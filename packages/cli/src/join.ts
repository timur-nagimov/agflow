import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AgentRole } from '@agflow/core';
import { addExclude, isTracked } from './git';
import type { SelfCommand } from './self';

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
