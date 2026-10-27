import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveCredentials } from '../src/credentials';
import { CODEX_CONFIG, CODEX_HOOKS, type Runner, joinCodex, joinRepository, leaveCodex, leaveRepository, loadJoined } from '../src/join';
import { run, tempRepo } from './fixture';

const self = { command: '/Apps/My Tools/agflow', args: [] };

describe('joinCodex and leaveCodex', () => {
  test('adds a marked MCP block and quoted command hooks, keeping existing settings', () => {
    const repo = tempRepo();
    mkdirSync(join(repo.root, '.codex'));
    writeFileSync(join(repo.root, CODEX_CONFIG), 'model = "gpt-6"\n');
    joinCodex(repo.root, self, 'worker');
    const config = readFileSync(join(repo.root, CODEX_CONFIG), 'utf8');
    expect(config).toStartWith('model = "gpt-6"\n');
    expect(config).toContain('[mcp_servers.agflow]');
    expect(config).toContain('command = "/Apps/My Tools/agflow"');
    expect(config).toContain('args = ["mcp", "--vendor", "codex"]');
    expect(config).toContain(`cwd = ${JSON.stringify(repo.root)}`);
    const hooks = JSON.parse(readFileSync(join(repo.root, CODEX_HOOKS), 'utf8')).hooks;
    expect(hooks.SessionStart[0].hooks[0]).toMatchObject({
      command: "'/Apps/My Tools/agflow' hook session-start --vendor codex --role worker",
      additionalContextLimit: 4000,
      statusMessage: 'agflow',
    });
    expect(hooks.Stop[0].hooks[0].command).toContain('hook stop');
    expect(run(['git', 'status', '--porcelain'], repo.root)).toBe('');
  });

  test('joining twice keeps one block and one set of hooks', () => {
    const repo = tempRepo();
    joinCodex(repo.root, self, 'worker');
    joinCodex(repo.root, self, 'lead');
    const config = readFileSync(join(repo.root, CODEX_CONFIG), 'utf8');
    expect(config.match(/\[mcp_servers\.agflow\]/g)).toHaveLength(1);
    const hooks = JSON.parse(readFileSync(join(repo.root, CODEX_HOOKS), 'utf8')).hooks;
    expect(hooks.SessionStart).toHaveLength(1);
    expect(hooks.SessionStart[0].hooks[0].command).toContain('--role lead');
  });

  test('leave restores the previous files', () => {
    const repo = tempRepo();
    mkdirSync(join(repo.root, '.codex'));
    writeFileSync(join(repo.root, CODEX_CONFIG), 'model = "gpt-6"\n');
    joinCodex(repo.root, self, 'worker');
    leaveCodex(repo.root);
    expect(readFileSync(join(repo.root, CODEX_CONFIG), 'utf8')).toBe('model = "gpt-6"\n');
    expect(existsSync(join(repo.root, CODEX_HOOKS))).toBe(false);
  });

  test('refuses tracked Codex files', () => {
    const repo = tempRepo();
    mkdirSync(join(repo.root, '.codex'));
    writeFileSync(join(repo.root, CODEX_HOOKS), '{}');
    run(['git', 'add', CODEX_HOOKS], repo.root);
    expect(() => joinCodex(repo.root, self, 'worker')).toThrow('tracked by git');
  });
});

describe('joinRepository', () => {
  const noClaude: Runner = () => ({ code: 0, output: '' });

  test('needs a sign-in and a git repository, then records the join', () => {
    const repo = tempRepo();
    const dir = mkdtempSync(join(tmpdir(), 'agflow-cfg-'));
    expect(() => joinRepository({ cwd: repo.root, dir, role: 'worker', vendors: ['codex'], self, run: noClaude })).toThrow('not signed in');
    saveCredentials({ hubUrl: 'http://hub.test', token: 't', user: 'alice' }, dir);
    expect(() => joinRepository({ cwd: repo.dir, dir, role: 'worker', vendors: ['codex'], self, run: noClaude })).toThrow('git repository');
    const lines = joinRepository({ cwd: repo.root, dir, role: 'lead', vendors: ['codex'], self, run: noClaude });
    expect(lines.join('\n')).toContain('/hooks');
    expect(loadJoined(dir)).toEqual([expect.objectContaining({ root: repo.root, role: 'lead', vendors: ['codex'] })]);
    expect(readFileSync(join(repo.root, '.git', 'info', 'exclude'), 'utf8')).toContain('.worktrees/');
    leaveRepository({ cwd: repo.root, dir, run: noClaude });
    expect(loadJoined(dir)).toEqual([]);
    expect(existsSync(join(repo.root, CODEX_CONFIG))).toBe(false);
  });
});
