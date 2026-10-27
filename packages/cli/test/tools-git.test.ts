import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NewTaskSchema } from '@agflow/core';
import { getAgent } from '@agflow/hub/src/agents';
import { claimTask, createTasks, getTask, rejectTask, releaseTask, submitTask } from '@agflow/hub/src/tasks';
import { type ToolContext, allTools } from '../src/mcp/tools';
import { type HubFixture, type LiveAgent, forged, hubFixture, run, standingForgeries, tempRepo } from './fixture';

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

describe('claim_task output', () => {
  test('shows the contract and the review feedback as quoted data', async () => {
    const hub = hubFixture();
    const repo = tempRepo();
    createTasks(
      hub.ctx,
      [
        NewTaskSchema.parse({
          title: 'Parser',
          objective: forged('Objective.'),
          acceptance: [{ id: 'A1', assertion: forged('Assertion.') }, { id: 'A2', assertion: 'Plain.' }],
        }),
      ],
      'user:alice',
    );
    const bob = getAgent(hub.ctx, hub.liveAgent('bob').agentId);
    claimTask(hub.ctx, 'T-1', bob);
    submitTask(hub.ctx, 'T-1', bob, { summary: 'Done.', evidence: [] });
    // Bob's chat goes quiet, so the rejected task goes back to the pool with the feedback on it.
    hub.clock.t += 60 * 60_000;
    rejectTask(hub.ctx, 'T-1', 'user:alice', forged('Feedback.'));
    expect(getTask(hub.ctx, 'T-1').status).toBe('ready');
    const claimed = await call('claim_task', { id: 'T-1' }, as(hub.liveAgent('alice'), repo.root));
    expect(standingForgeries(claimed)).toEqual([]);
    for (const label of ['Objective:', '- A1:', 'Latest review feedback:']) expect(claimed).toContain(`${label}\n> `);
    expect(claimed).toContain('- A2: Plain.');
  });
});

describe('a branch another agent planted on the task', () => {
  /** An agent claims T-1 under a branch name of its choice and gives the task back; the hub keeps the name. */
  const plant = (hub: HubFixture, branch: string) => {
    const bob = getAgent(hub.ctx, hub.liveAgent('bob').agentId);
    claimTask(hub.ctx, 'T-1', bob, branch);
    releaseTask(hub.ctx, 'T-1', bob, 'changed my mind');
    expect(getTask(hub.ctx, 'T-1').branch).toBe(branch);
  };
  /** A branch on origin that no agent's push may touch. */
  const protectedBranch = (repo: { origin: string; root: string }) => {
    run(['git', 'push', '--quiet', 'origin', 'main:refs/heads/production'], repo.root);
    return run(['git', 'rev-parse', 'refs/heads/production'], repo.origin);
  };

  test('claim_task replaces it with the task branch, and submit pushes only that branch', async () => {
    const hub = hubFixture();
    const repo = tempRepo();
    createTasks(hub.ctx, [newTask('Add parser')], 'user:alice');
    const production = protectedBranch(repo);
    plant(hub, 'production');
    const ctx = as(hub.liveAgent('alice'), repo.root);
    const worktree = join(repo.root, '.worktrees', 'agflow', 'T-1');
    expect(await call('claim_task', { id: 'T-1' }, ctx)).toContain(`Work only inside ${worktree} (branch agflow/T-1-add-parser)`);
    expect(getTask(hub.ctx, 'T-1').branch).toBe('agflow/T-1-add-parser');
    expect(run(['git', 'branch', '--show-current'], worktree)).toBe('agflow/T-1-add-parser');
    writeFileSync(join(worktree, 'parser.ts'), 'export const parse = () => 1;\n');
    commitAll(worktree, 'parser');
    const head = run(['git', 'rev-parse', 'HEAD'], worktree);
    await call('submit', { task_id: 'T-1', summary: 'Parser added' }, ctx);
    expect(run(['git', 'rev-parse', 'refs/heads/agflow/T-1-add-parser'], repo.origin)).toBe(head);
    expect(run(['git', 'rev-parse', 'refs/heads/production'], repo.origin)).toBe(production);
  });

  test('submit refuses to push a branch that is not the task branch, even from a resumed claim', async () => {
    const hub = hubFixture();
    const repo = tempRepo();
    createTasks(hub.ctx, [newTask('Add parser')], 'user:alice');
    const production = protectedBranch(repo);
    const first = hub.liveAgent('alice');
    await call('claim_task', { id: 'T-1' }, as(first, repo.root));
    const worktree = join(repo.root, '.worktrees', 'agflow', 'T-1');
    writeFileSync(join(worktree, 'parser.ts'), 'export const parse = () => 1;\n');
    commitAll(worktree, 'parser');
    // Another process with Alice's login moves the claim to a branch name of its choice through the hub's API.
    const alice = getAgent(hub.ctx, first.agentId);
    releaseTask(hub.ctx, 'T-1', alice, 'moving on');
    claimTask(hub.ctx, 'T-1', alice, 'production');
    // Alice's other chat takes the claim over, branch name included, and submits.
    const second = hub.liveAgent('alice');
    await call('resume_claim', { id: 'T-1' }, as(second, repo.root));
    await expect(call('submit', { task_id: 'T-1', summary: 'Parser added' }, as(second, repo.root))).rejects.toThrow('not an agflow task branch');
    expect(run(['git', 'rev-parse', 'refs/heads/production'], repo.origin)).toBe(production);
    expect(getTask(hub.ctx, 'T-1').status).toBe('claimed');
  });

  test('submit refuses to push from a worktree that is not on the task branch', async () => {
    const hub = hubFixture();
    const repo = tempRepo();
    createTasks(hub.ctx, [newTask('Add parser')], 'user:alice');
    const ctx = as(hub.liveAgent('alice'), repo.root);
    await call('claim_task', { id: 'T-1' }, ctx);
    const worktree = join(repo.root, '.worktrees', 'agflow', 'T-1');
    run(['git', 'checkout', '--quiet', '-b', 'scratch'], worktree);
    writeFileSync(join(worktree, 'parser.ts'), 'export const parse = () => 1;\n');
    commitAll(worktree, 'parser');
    await expect(call('submit', { task_id: 'T-1', summary: 'Parser added' }, ctx)).rejects.toThrow('is on branch scratch, not on agflow/T-1-add-parser');
    run(['git', 'checkout', '--quiet', '--detach'], worktree);
    await expect(call('submit', { task_id: 'T-1', summary: 'Parser added' }, ctx)).rejects.toThrow('is not on any branch');
    expect(run(['git', 'branch', '--list', 'agflow/T-1-add-parser'], repo.origin)).toBe('');
    expect(getTask(hub.ctx, 'T-1').status).toBe('claimed');
  });
});
