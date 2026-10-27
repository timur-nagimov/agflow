import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NewTaskSchema } from '@agflow/core';
import { getAgent } from '@agflow/hub/src/agents';
import { claimTask, createTasks, getTask } from '@agflow/hub/src/tasks';
import { type ToolContext, allTools } from '../src/mcp/tools';
import { type LiveAgent, hubFixture, run, tempRepo } from './fixture';

const newTask = (title: string) => NewTaskSchema.parse({ title, objective: `Do ${title}`, acceptance: [{ id: 'A1', assertion: 'works' }] });
const call = (name: string, args: Record<string, unknown>, ctx: ToolContext) => {
  const found = allTools.find((t) => t.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found.run(args, ctx);
};
const as = (live: LiveAgent, cwd: string): ToolContext => ({ client: live.client, state: { agentId: live.agentId, role: 'worker' }, cwd });
const commitAll = (cwd: string, message: string) => {
  run(['git', 'add', '.'], cwd);
  run(['git', 'commit', '--quiet', '-m', message], cwd);
};

describe('claim_task and submit', () => {
  test('claim creates the task worktree; submit refuses uncommitted work, then pushes and records the commit', async () => {
    const hub = hubFixture();
    const repo = tempRepo();
    createTasks(hub.ctx, [newTask('Add parser')], 'user:alice');
    const ctx = as(hub.liveAgent('alice'), repo.root);
    const worktree = join(repo.root, '.worktrees', 'agflow', 'T-1');
    const claimed = await call('claim_task', { id: 'T-1' }, ctx);
    expect(claimed).toContain(`Work only inside ${worktree} (branch agflow/T-1-add-parser)`);
    expect(run(['git', 'branch', '--show-current'], worktree)).toBe('agflow/T-1-add-parser');
    expect(getTask(hub.ctx, 'T-1')).toMatchObject({ status: 'claimed', branch: 'agflow/T-1-add-parser' });
    writeFileSync(join(worktree, 'parser.ts'), 'export const parse = () => 1;\n');
    await expect(call('submit', { task_id: 'T-1', summary: 'Parser added' }, ctx)).rejects.toThrow('uncommitted changes');
    commitAll(worktree, 'parser');
    const head = run(['git', 'rev-parse', 'HEAD'], worktree);
    expect(await call('submit', { task_id: 'T-1', summary: 'Parser added', evidence: ['bun test: 3 pass'] }, ctx)).toContain(
      `at ${head.slice(0, 7)} on agflow/T-1-add-parser`,
    );
    expect(run(['git', 'rev-parse', 'refs/heads/agflow/T-1-add-parser'], repo.origin)).toBe(head);
    expect(getTask(hub.ctx, 'T-1').submission).toMatchObject({ branch: 'agflow/T-1-add-parser', headSha: head });
    expect(run(['git', 'status', '--porcelain'], repo.root)).toBe('');
  });

  test('a refused claim removes the worktree and branch it created', async () => {
    const hub = hubFixture();
    const repo = tempRepo();
    createTasks(hub.ctx, [newTask('Parser')], 'user:alice');
    const other = hub.liveAgent('bob');
    claimTask(hub.ctx, 'T-1', getAgent(hub.ctx, other.agentId), 'agflow/T-1-parser');
    await expect(call('claim_task', { id: 'T-1' }, as(hub.liveAgent('alice'), repo.root))).rejects.toThrow('not ready');
    expect(existsSync(join(repo.root, '.worktrees', 'agflow', 'T-1'))).toBe(false);
    expect(run(['git', 'branch', '--list', 'agflow/T-1-parser'], repo.root)).toBe('');
  });

  test('a successor in another clone continues from the branch the previous holder pushed', async () => {
    const hub = hubFixture();
    const repo = tempRepo();
    createTasks(hub.ctx, [newTask('Parser')], 'user:alice');
    const first = as(hub.liveAgent('alice'), repo.root);
    await call('claim_task', { id: 'T-1' }, first);
    const firstTree = join(repo.root, '.worktrees', 'agflow', 'T-1');
    writeFileSync(join(firstTree, 'progress.txt'), 'half done\n');
    commitAll(firstTree, 'half');
    run(['git', 'push', '--quiet', 'origin', 'HEAD:refs/heads/agflow/T-1-parser'], firstTree);
    await call('release_task', { task_id: 'T-1', reason: 'end of day' }, first);
    const second = join(repo.dir, 'second');
    run(['git', 'clone', '--quiet', repo.origin, second], repo.dir);
    await call('claim_task', { id: 'T-1' }, as(hub.liveAgent('bob'), second));
    expect(readFileSync(join(second, '.worktrees', 'agflow', 'T-1', 'progress.txt'), 'utf8')).toBe('half done\n');
  });

  test('claiming outside a git repository is refused before anything changes', async () => {
    const hub = hubFixture();
    createTasks(hub.ctx, [newTask('Parser')], 'user:alice');
    const repo = tempRepo();
    await expect(call('claim_task', { id: 'T-1' }, as(hub.liveAgent('alice'), repo.dir))).rejects.toThrow('not inside a git repository');
    expect(getTask(hub.ctx, 'T-1').status).toBe('ready');
  });
});
