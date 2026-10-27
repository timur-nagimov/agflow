import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLAUDE_SETTINGS, type Runner, claudeHooks, defaultRunner, joinClaude, leaveClaude } from '../src/join';
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

  test('gives the waiter a timeout that outlasts its own 8 hour limit', () => {
    // Claude Code still enforces `timeout` on an asyncRewake hook (600 s by default), so without one the waiter
    // would be cancelled after 10 minutes. 29100 s is the 8 hour wait limit (WAIT_MAX_MS) plus a 5 minute margin.
    const hooks = claudeHooks(self, 'worker');
    expect(hooks.SessionStart?.[0]?.hooks[1]).toMatchObject({ asyncRewake: true, timeout: 29100 });
    expect(hooks.Stop?.[0]?.hooks[1]).toMatchObject({ asyncRewake: true, timeout: 29100 });
  });
});

describe('defaultRunner', () => {
  test('reports a program that is not installed as a failed run instead of throwing', () => {
    const result = defaultRunner(['agflow-no-such-binary', '--version'], tmpdir());
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('agflow-no-such-binary');
  });

  test('returns the exit code and the output of a program that runs', () => {
    const ok = defaultRunner(['git', '--version'], tmpdir());
    expect(ok.code).toBe(0);
    expect(ok.output).toStartWith('git version');
    const failed = defaultRunner(['git', 'no-such-subcommand'], tmpdir());
    expect(failed.code).not.toBe(0);
    expect(failed.output).toContain('no-such-subcommand');
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
    expect(settings.permissions.allow).toEqual(['mcp__agflow']);
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

  test('lets the chat call agflow tools without asking, keeping other permission rules', () => {
    const repo = tempRepo();
    mkdirSync(join(repo.root, '.claude'));
    writeFileSync(join(repo.root, CLAUDE_SETTINGS), JSON.stringify({ permissions: { allow: ['Bash(bun test)'], deny: ['Read(.env)'] } }));
    const claude = fakeClaude();
    joinClaude(repo.root, self, 'worker', claude.runner);
    joinClaude(repo.root, self, 'worker', claude.runner);
    expect(settingsOf(repo.root).permissions).toEqual({ allow: ['Bash(bun test)', 'mcp__agflow'], deny: ['Read(.env)'] });
    leaveClaude(repo.root, claude.runner);
    expect(settingsOf(repo.root)).toEqual({ permissions: { allow: ['Bash(bun test)'], deny: ['Read(.env)'] } });
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

  test('without Claude Code installed, join explains that claude mcp add failed and writes nothing', () => {
    const repo = tempRepo();
    // The real runner with a made-up program name stands in for a machine without `claude`; the real claude is never run.
    const missingClaude: Runner = (cmd, cwd) => defaultRunner(['agflow-no-such-binary', ...cmd.slice(1)], cwd);
    expect(() => joinClaude(repo.root, self, 'worker', missingClaude)).toThrow('claude mcp add failed:');
    expect(existsSync(join(repo.root, CLAUDE_SETTINGS))).toBe(false);
  });
});
