import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLAUDE_SETTINGS, type Runner, claudeHooks, joinClaude, leaveClaude } from '../src/join';
import { run, tempRepo } from './fixture';

const self = { command: '/usr/local/bin/bun', args: ['/repo/packages/cli/src/main.ts'] };

function fakeClaude() {
  const calls: string[][] = [];
  const runner: Runner = (cmd) => {
    calls.push(cmd);
    return { code: 0, output: '' };
  };
  return { calls, runner };
}

const settingsOf = (root: string) => JSON.parse(readFileSync(join(root, CLAUDE_SETTINGS), 'utf8'));

describe('claudeHooks', () => {
  test('uses command plus args with the role, and an asynchronous waiter', () => {
    const hooks = claudeHooks(self, 'lead');
    const start = hooks.SessionStart?.[0]?.hooks ?? [];
    expect(start[0]).toMatchObject({
      type: 'command',
      command: '/usr/local/bin/bun',
      args: ['/repo/packages/cli/src/main.ts', 'hook', 'session-start', '--vendor', 'claude', '--role', 'lead'],
      statusMessage: 'agflow',
    });
    expect(start[1]).toMatchObject({ asyncRewake: true });
    expect(hooks.Stop?.[0]?.hooks.map((h) => (h.args as string[])[2])).toEqual(['stop', 'wait-inbox']);
  });
});

describe('joinClaude and leaveClaude', () => {
  test('adds the MCP server in local scope and the hooks, keeping other settings', () => {
    const repo = tempRepo();
    mkdirSync(join(repo.root, '.claude'));
    writeFileSync(
      join(repo.root, CLAUDE_SETTINGS),
      JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } }),
    );
    const claude = fakeClaude();
    joinClaude(repo.root, self, 'worker', claude.runner);
    expect(claude.calls).toEqual([
      ['claude', 'mcp', 'remove', '--scope', 'local', 'agflow'],
      ['claude', 'mcp', 'add', '--scope', 'local', 'agflow', '--', '/usr/local/bin/bun', '/repo/packages/cli/src/main.ts', 'mcp', '--vendor', 'claude'],
    ]);
    const settings = settingsOf(repo.root);
    expect(settings.model).toBe('opus');
    expect(settings.hooks.Stop).toHaveLength(2);
    expect(settings.hooks.Stop[0].hooks[0].command).toBe('say done');
    expect(readFileSync(join(repo.root, '.git', 'info', 'exclude'), 'utf8')).toContain(CLAUDE_SETTINGS);
    expect(run(['git', 'status', '--porcelain'], repo.root)).toBe('');
  });

  test('joining twice does not duplicate hooks', () => {
    const repo = tempRepo();
    const claude = fakeClaude();
    joinClaude(repo.root, self, 'worker', claude.runner);
    joinClaude(repo.root, self, 'lead', claude.runner);
    const hooks = settingsOf(repo.root).hooks;
    expect(hooks.SessionStart).toHaveLength(1);
    expect(hooks.SessionStart[0].hooks[0].args).toContain('lead');
  });

  test('leave removes only what agflow added', () => {
    const repo = tempRepo();
    mkdirSync(join(repo.root, '.claude'));
    writeFileSync(join(repo.root, CLAUDE_SETTINGS), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } }));
    const claude = fakeClaude();
    joinClaude(repo.root, self, 'worker', claude.runner);
    leaveClaude(repo.root, claude.runner);
    expect(settingsOf(repo.root)).toEqual({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } });
    expect(claude.calls.at(-1)).toEqual(['claude', 'mcp', 'remove', '--scope', 'local', 'agflow']);
  });

  test('leave deletes a settings file that only held agflow hooks', () => {
    const repo = tempRepo();
    const claude = fakeClaude();
    joinClaude(repo.root, self, 'worker', claude.runner);
    leaveClaude(repo.root, claude.runner);
    expect(existsSync(join(repo.root, CLAUDE_SETTINGS))).toBe(false);
  });

  test('refuses a tracked settings file and a failing claude command', () => {
    const repo = tempRepo();
    mkdirSync(join(repo.root, '.claude'));
    writeFileSync(join(repo.root, CLAUDE_SETTINGS), '{}');
    run(['git', 'add', '-f', CLAUDE_SETTINGS], repo.root);
    expect(() => joinClaude(repo.root, self, 'worker', fakeClaude().runner)).toThrow('tracked by git');
    const other = tempRepo();
    const failing: Runner = (cmd) => ({ code: cmd[2] === 'add' ? 1 : 0, output: 'not logged in' });
    expect(() => joinClaude(other.root, self, 'worker', failing)).toThrow('claude mcp add failed: not logged in');
  });
});
