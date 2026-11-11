import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BRIDGE_VERSION, NewTaskSchema } from '@agflow/core';
import { getAgent } from '@agflow/hub/src/agents';
import { writeTask } from '@agflow/hub/src/task-store';
import { claimTask, createTasks, getTask, rejectTask, releaseTask, submitTask, sweepLeases } from '@agflow/hub/src/tasks';
import { type FetchFn, HubClient } from '../src/hub-client';
import { type ToolContext, allTools } from '../src/mcp/tools';
import {
  HUB_URL,
  type HubFixture,
  type LiveAgent,
  cloneOf,
  forged,
  hubFixture,
  pushedRepo,
  run,
  standingForgeries,
  tempRepo,
} from './fixture';

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

describe('claim_task in a repository whose default branch is not main', () => {
  test('starts the task branch from origin/master when origin/HEAD is not set, and submit pushes it', async () => {
    const hub = hubFixture();
    const repo = pushedRepo('master');
    createTasks(hub.ctx, [newTask('Add parser')], 'user:alice');
    const ctx = as(hub.liveAgent('alice'), repo.root);
    const worktree = join(repo.root, '.worktrees', 'agflow', 'T-1');
    expect(await call('claim_task', { id: 'T-1' }, ctx)).toContain(`Work only inside ${worktree} (branch agflow/T-1-add-parser)`);
    expect(run(['git', 'rev-parse', 'HEAD'], worktree)).toBe(run(['git', 'rev-parse', 'refs/heads/master'], repo.origin));
    writeFileSync(join(worktree, 'parser.ts'), 'export const parse = () => 1;\n');
    commitAll(worktree, 'parser');
    const head = run(['git', 'rev-parse', 'HEAD'], worktree);
    await call('submit', { task_id: 'T-1', summary: 'Parser added' }, ctx);
    expect(run(['git', 'rev-parse', 'refs/heads/agflow/T-1-add-parser'], repo.origin)).toBe(head);
  });

  test('starts from the checked-out branch when origin cannot be reached', async () => {
    const hub = hubFixture();
    const repo = pushedRepo('master');
    run(['git', 'remote', 'set-url', 'origin', join(repo.dir, 'gone.git')], repo.root);
    createTasks(hub.ctx, [newTask('Add parser')], 'user:alice');
    await call('claim_task', { id: 'T-1' }, as(hub.liveAgent('alice'), repo.root));
    const worktree = join(repo.root, '.worktrees', 'agflow', 'T-1');
    expect(run(['git', 'rev-parse', 'HEAD'], worktree)).toBe(run(['git', 'rev-parse', 'refs/heads/master'], repo.root));
  });
});

describe('resume_claim and the task worktree', () => {
  test('in another clone it creates the worktree there, and submit pushes from it', async () => {
    const hub = hubFixture();
    const repo = tempRepo();
    createTasks(hub.ctx, [newTask('Parser')], 'user:alice');
    await call('claim_task', { id: 'T-1' }, as(hub.liveAgent('alice'), repo.root));
    const firstTree = join(repo.root, '.worktrees', 'agflow', 'T-1');
    writeFileSync(join(firstTree, 'first.txt'), 'first chat\n');
    commitAll(firstTree, 'first');
    // Alice's other chat runs in another clone, say on another computer, and takes the claim over there.
    const clone = cloneOf(repo, 'second');
    const cloneTree = join(clone, '.worktrees', 'agflow', 'T-1');
    const second = as(hub.liveAgent('alice'), clone);
    expect(await call('resume_claim', { id: 'T-1' }, second)).toContain(`Work only inside ${cloneTree} (branch agflow/T-1-parser)`);
    expect(run(['git', 'branch', '--show-current'], cloneTree)).toBe('agflow/T-1-parser');
    writeFileSync(join(cloneTree, 'second.txt'), 'second chat\n');
    commitAll(cloneTree, 'second');
    const head = run(['git', 'rev-parse', 'HEAD'], cloneTree);
    expect(await call('submit', { task_id: 'T-1', summary: 'Parser added' }, second)).toContain(`at ${head.slice(0, 7)} on agflow/T-1-parser`);
    expect(run(['git', 'rev-parse', 'refs/heads/agflow/T-1-parser'], repo.origin)).toBe(head);
    expect(getTask(hub.ctx, 'T-1').submission).toMatchObject({ branch: 'agflow/T-1-parser', headSha: head });
    expect(run(['git', 'status', '--porcelain'], clone)).toBe('');
  });

  test('in the same repository it names the worktree that is already there, and submit pushes that worktree', async () => {
    const hub = hubFixture();
    const repo = tempRepo();
    createTasks(hub.ctx, [newTask('Parser')], 'user:alice');
    await call('claim_task', { id: 'T-1' }, as(hub.liveAgent('alice'), repo.root));
    const worktree = join(repo.root, '.worktrees', 'agflow', 'T-1');
    writeFileSync(join(worktree, 'first.txt'), 'first chat\n');
    commitAll(worktree, 'first');
    const second = as(hub.liveAgent('alice'), repo.root);
    expect(await call('resume_claim', { id: 'T-1' }, second)).toContain(`Work only inside ${worktree} (branch agflow/T-1-parser)`);
    writeFileSync(join(worktree, 'second.txt'), 'second chat\n');
    commitAll(worktree, 'second');
    const head = run(['git', 'rev-parse', 'HEAD'], worktree);
    await call('submit', { task_id: 'T-1', summary: 'Parser added' }, second);
    expect(run(['git', 'rev-parse', 'refs/heads/agflow/T-1-parser'], repo.origin)).toBe(head);
    // The first chat's commit travels with the second chat's.
    expect(run(['git', 'rev-list', '--count', 'main..refs/heads/agflow/T-1-parser'], repo.origin)).toBe('2');
  });

  test('from outside a git repository it is refused, and the claim stays where it was', async () => {
    const hub = hubFixture();
    const repo = tempRepo();
    createTasks(hub.ctx, [newTask('Parser')], 'user:alice');
    const first = hub.liveAgent('alice');
    await call('claim_task', { id: 'T-1' }, as(first, repo.root));
    await expect(call('resume_claim', { id: 'T-1' }, as(hub.liveAgent('alice'), repo.dir))).rejects.toThrow('not inside a git repository');
    expect(getTask(hub.ctx, 'T-1').assignee).toBe(first.agentId);
  });

  test('on a task whose branch is not an agflow task branch it makes no worktree, and submit names the branch, not the worktree', async () => {
    const hub = hubFixture();
    const repo = tempRepo();
    createTasks(hub.ctx, [newTask('Parser')], 'user:alice');
    claimTask(hub.ctx, 'T-1', getAgent(hub.ctx, hub.liveAgent('alice').agentId), 'production');
    const second = as(hub.liveAgent('alice'), repo.root);
    expect(await call('resume_claim', { id: 'T-1' }, second)).toBe('You now hold T-1 (branch production).');
    expect(existsSync(join(repo.root, '.worktrees'))).toBe(false);
    expect(run(['git', 'branch', '--list', 'production'], repo.root)).toBe('');
    // resume_claim cannot help here, so the refusal must not send the chat to it.
    await expect(call('submit', { task_id: 'T-1', summary: 'Done' }, second)).rejects.toThrow('not an agflow task branch');
    expect(getTask(hub.ctx, 'T-1').status).toBe('claimed');
  });

  test('a refused resume_claim removes the worktree and branch it created', async () => {
    const hub = hubFixture();
    const repo = tempRepo();
    createTasks(hub.ctx, [newTask('Parser')], 'user:alice');
    const alice = hub.liveAgent('alice');
    await call('claim_task', { id: 'T-1' }, as(alice, repo.root));
    const clone = cloneOf(repo, 'bobs');
    await expect(call('resume_claim', { id: 'T-1' }, as(hub.liveAgent('bob'), clone))).rejects.toThrow("someone else's agent");
    expect(existsSync(join(clone, '.worktrees', 'agflow', 'T-1'))).toBe(false);
    expect(run(['git', 'branch', '--list', 'agflow/T-1-parser'], clone)).toBe('');
    expect(getTask(hub.ctx, 'T-1').assignee).toBe(alice.agentId);
  });
});

describe('submit without the right to push', () => {
  test('refuses, and pushes nothing, when this repository has no worktree for the task', async () => {
    const hub = hubFixture();
    const repo = tempRepo();
    createTasks(hub.ctx, [newTask('Parser')], 'user:alice');
    const alice = hub.liveAgent('alice');
    // Alice's chat holds T-1 on its task branch, but nothing made the worktree in this repository.
    claimTask(hub.ctx, 'T-1', getAgent(hub.ctx, alice.agentId), 'agflow/T-1-parser');
    const here = as(alice, repo.root);
    await expect(call('submit', { task_id: 'T-1', summary: 'Parser added' }, here)).rejects.toThrow(`There is no worktree for T-1 in ${repo.root}`);
    await expect(call('submit', { task_id: 'T-1', summary: 'Parser added' }, as(alice, repo.dir))).rejects.toThrow('is not inside a git repository');
    expect(getTask(hub.ctx, 'T-1').status).toBe('claimed');
    expect(getTask(hub.ctx, 'T-1').submission).toBeNull();
    expect(run(['git', 'branch', '--list', 'agflow/T-1-parser'], repo.origin)).toBe('');
    // resume_claim, which the message names, makes the worktree. Then the submit goes through.
    const worktree = join(repo.root, '.worktrees', 'agflow', 'T-1');
    expect(await call('resume_claim', { id: 'T-1' }, here)).toContain(`Work only inside ${worktree}`);
    writeFileSync(join(worktree, 'parser.ts'), 'export const parse = () => 1;\n');
    commitAll(worktree, 'parser');
    const head = run(['git', 'rev-parse', 'HEAD'], worktree);
    expect(await call('submit', { task_id: 'T-1', summary: 'Parser added' }, here)).toContain(`at ${head.slice(0, 7)} on agflow/T-1-parser`);
    expect(run(['git', 'rev-parse', 'refs/heads/agflow/T-1-parser'], repo.origin)).toBe(head);
  });

  test('a task that has no branch is submitted without a push, wherever the chat runs', async () => {
    const hub = hubFixture();
    createTasks(hub.ctx, [newTask('Parser')], 'user:alice');
    const alice = hub.liveAgent('alice');
    claimTask(hub.ctx, 'T-1', getAgent(hub.ctx, alice.agentId));
    expect(getTask(hub.ctx, 'T-1').branch).toBeNull();
    expect(await call('submit', { task_id: 'T-1', summary: 'Done' }, as(alice, tempRepo().dir))).toStartWith('T-1 is submitted.');
    expect(getTask(hub.ctx, 'T-1').submission).toMatchObject({ branch: null, headSha: null });
  });

  test('a chat whose claim has ended pushes nothing, and the new holder submits cleanly', async () => {
    const hub = hubFixture();
    const repo = tempRepo();
    createTasks(hub.ctx, [newTask('Parser')], 'user:alice');
    const old = as(hub.liveAgent('alice'), repo.root);
    await call('claim_task', { id: 'T-1' }, old);
    const oldTree = join(repo.root, '.worktrees', 'agflow', 'T-1');
    writeFileSync(join(oldTree, 'old.txt'), 'old work\n');
    commitAll(oldTree, 'old work');
    // The lease runs out, the hub gives the task back, and Bob takes it in his own clone.
    hub.clock.t += 3 * 60 * 60_000;
    expect(sweepLeases(hub.ctx)).toEqual(['T-1']);
    const bobClone = cloneOf(repo, 'bobs');
    const bob = as(hub.liveAgent('bob'), bobClone);
    await call('claim_task', { id: 'T-1' }, bob);
    // Alice's chat comes back and submits late. Its commits stay out of the branch Bob works on.
    await expect(call('submit', { task_id: 'T-1', summary: 'Late' }, old)).rejects.toThrow(/do not hold T-1/i);
    expect(run(['git', 'branch', '--list', 'agflow/T-1-parser'], repo.origin)).toBe('');
    // Bob's own submit goes through.
    const bobTree = join(bobClone, '.worktrees', 'agflow', 'T-1');
    writeFileSync(join(bobTree, 'new.txt'), 'new work\n');
    commitAll(bobTree, 'new work');
    const head = run(['git', 'rev-parse', 'HEAD'], bobTree);
    expect(await call('submit', { task_id: 'T-1', summary: 'Parser added' }, bob)).toContain(`at ${head.slice(0, 7)} on agflow/T-1-parser`);
    expect(run(['git', 'rev-parse', 'refs/heads/agflow/T-1-parser'], repo.origin)).toBe(head);
    expect(getTask(hub.ctx, 'T-1')).toMatchObject({ status: 'submitted', submission: { headSha: head } });
  });

  test('refuses after the chat released the task, and again after it submitted, and pushes nothing more', async () => {
    const hub = hubFixture();
    const repo = tempRepo();
    createTasks(hub.ctx, [newTask('Parser')], 'user:alice');
    const alice = as(hub.liveAgent('alice'), repo.root);
    await call('claim_task', { id: 'T-1' }, alice);
    const worktree = join(repo.root, '.worktrees', 'agflow', 'T-1');
    writeFileSync(join(worktree, 'one.txt'), 'one\n');
    commitAll(worktree, 'one');
    await call('release_task', { task_id: 'T-1', reason: 'end of day' }, alice);
    await expect(call('submit', { task_id: 'T-1', summary: 'Parser added' }, alice)).rejects.toThrow('You do not hold T-1: it is ready');
    expect(run(['git', 'branch', '--list', 'agflow/T-1-parser'], repo.origin)).toBe('');
    // It takes the task again and submits it.
    await call('claim_task', { id: 'T-1' }, alice);
    const head = run(['git', 'rev-parse', 'HEAD'], worktree);
    await call('submit', { task_id: 'T-1', summary: 'Parser added' }, alice);
    writeFileSync(join(worktree, 'two.txt'), 'two\n');
    commitAll(worktree, 'two');
    await expect(call('submit', { task_id: 'T-1', summary: 'Once more' }, alice)).rejects.toThrow('You do not hold T-1: it is submitted');
    expect(run(['git', 'rev-parse', 'refs/heads/agflow/T-1-parser'], repo.origin)).toBe(head);
  });
});

describe('live claims from the work position', () => {
  /** A commit with one file, made in another clone and pushed to `ref` on the origin only, as a runner pushes a WIP. */
  const pushWork = (repo: { dir: string; origin: string }, ref: string, file: string, from = 'main'): string => {
    const clone = join(repo.dir, `wip-${file}`);
    if (!existsSync(clone)) {
      run(['git', 'clone', '--quiet', repo.origin, clone], repo.dir);
      run(['git', 'config', 'user.email', 'runner@example.com'], clone);
      run(['git', 'config', 'user.name', 'Runner'], clone);
    }
    run(['git', 'fetch', '--quiet', 'origin', `+${from === 'main' ? 'refs/heads/main' : from}:refs/start`], clone);
    run(['git', 'checkout', '--quiet', '--detach', 'refs/start'], clone);
    writeFileSync(join(clone, file), `${file}\n`);
    commitAll(clone, file);
    run(['git', 'push', '--quiet', 'origin', `HEAD:${ref}`], clone);
    return run(['git', 'rev-parse', 'HEAD'], clone);
  };
  const worktreeOf = (root: string) => join(root, '.worktrees', 'agflow', 'T-1');
  /** Alice's chat in `cwd`, with `meanwhile` run as her claim of T-1 reaches the hub, so only the claim answer sees it. */
  const racing = (hub: HubFixture, cwd: string, meanwhile: () => void): ToolContext => {
    const live = hub.liveAgent('alice');
    const fetchFn: FetchFn = async (input, init) => {
      if (init?.method === 'POST' && String(input).endsWith('/api/tasks/T-1/claim')) meanwhile();
      return hub.fetch(input, init);
    };
    const client = new HubClient({ baseUrl: HUB_URL, token: hub.tokenFor('alice'), agentId: live.agentId, fetch: fetchFn });
    return { client, state: { agentId: live.agentId, role: 'worker' }, cwd };
  };

  test('a task whose work position is a WIP ref is claimed on a branch at that commit, and the answer says so', async () => {
    const hub = hubFixture();
    const repo = tempRepo();
    createTasks(hub.ctx, [newTask('Parser')], 'user:alice');
    const sha = pushWork(repo, 'refs/agflow/T-1/a1', 'wip.txt');
    writeTask(hub.ctx, 'T-1', { workRef: 'refs/agflow/T-1/a1', workSha: sha });
    const answer = await call('claim_task', { id: 'T-1' }, as(hub.liveAgent('alice'), repo.root));
    expect(answer).toContain(`Started from refs/agflow/T-1/a1 at ${sha.slice(0, 7)}.`);
    expect(answer).toContain(`Work only inside ${worktreeOf(repo.root)} (branch agflow/T-1-parser)`);
    expect(run(['git', 'rev-parse', 'HEAD'], worktreeOf(repo.root))).toBe(sha);
    expect(run(['git', 'branch', '--show-current'], worktreeOf(repo.root))).toBe('agflow/T-1-parser');
    expect(readFileSync(join(worktreeOf(repo.root), 'wip.txt'), 'utf8')).toBe('wip.txt\n');
    expect(getTask(hub.ctx, 'T-1')).toMatchObject({ status: 'claimed', branch: 'agflow/T-1-parser' });
  });

  test('a position given only as a SHA is fetched by its SHA', async () => {
    const hub = hubFixture();
    const repo = tempRepo();
    createTasks(hub.ctx, [newTask('Parser')], 'user:alice');
    const sha = pushWork(repo, 'refs/agflow/T-1/a1', 'wip.txt');
    expect(run(['git', 'cat-file', '-t', sha], repo.origin)).toBe('commit');
    expect(() => run(['git', 'cat-file', '-e', sha], repo.root)).toThrow();
    writeTask(hub.ctx, 'T-1', { workRef: null, workSha: sha });
    expect(await call('claim_task', { id: 'T-1' }, as(hub.liveAgent('alice'), repo.root))).toContain(`Started from ${sha.slice(0, 7)}.`);
    expect(run(['git', 'rev-parse', 'HEAD'], worktreeOf(repo.root))).toBe(sha);
  });

  test('without a position the M1 behaviour is unchanged: the pushed task branch, or the default branch', async () => {
    const hub = hubFixture();
    const repo = tempRepo();
    createTasks(hub.ctx, [newTask('Parser'), newTask('Lexer')], 'user:alice');
    const pushed = pushWork(repo, 'refs/heads/agflow/T-1-parser', 'pushed.txt');
    const bob = getAgent(hub.ctx, hub.liveAgent('bob').agentId);
    claimTask(hub.ctx, 'T-1', bob, 'agflow/T-1-parser');
    releaseTask(hub.ctx, 'T-1', bob, 'end of day');
    expect(getTask(hub.ctx, 'T-1')).toMatchObject({ workRef: null, workSha: null });
    const alice = as(hub.liveAgent('alice'), repo.root);
    expect(await call('claim_task', { id: 'T-1' }, alice)).not.toContain('Started from');
    expect(run(['git', 'rev-parse', 'HEAD'], worktreeOf(repo.root))).toBe(pushed);
    await call('release_task', { task_id: 'T-1', reason: 'not now' }, alice);
    expect(await call('claim_task', { id: 'T-2' }, alice)).not.toContain('Started from');
    expect(run(['git', 'rev-parse', 'HEAD'], join(repo.root, '.worktrees', 'agflow', 'T-2'))).toBe(run(['git', 'rev-parse', 'main'], repo.origin));
  });

  test('when the claim answer names a newer position than the one prepared, the new branch moves to it', async () => {
    const hub = hubFixture();
    const repo = tempRepo();
    createTasks(hub.ctx, [newTask('Parser')], 'user:alice');
    const first = pushWork(repo, 'refs/agflow/T-1/a1', 'first.txt');
    writeTask(hub.ctx, 'T-1', { workRef: 'refs/agflow/T-1/a1', workSha: first });
    let newer = '';
    // A runner's WIP lands between the task read and the claim, so only the claim answer names it.
    const alice = racing(hub, repo.root, () => {
      newer = pushWork(repo, 'refs/agflow/T-1/a2', 'second.txt', 'refs/agflow/T-1/a1');
      writeTask(hub.ctx, 'T-1', { workRef: 'refs/agflow/T-1/a2', workSha: newer });
    });
    const answer = await call('claim_task', { id: 'T-1' }, alice);
    expect(answer).toContain(`Started from refs/agflow/T-1/a2 at ${newer.slice(0, 7)}.`);
    expect(run(['git', 'rev-parse', 'HEAD'], worktreeOf(repo.root))).toBe(newer);
    expect(run(['git', 'branch', '--show-current'], worktreeOf(repo.root))).toBe('agflow/T-1-parser');
    expect(existsSync(join(worktreeOf(repo.root), 'second.txt'))).toBe(true);
  });

  test('with HubStatus.epoch 2 a new branch carries the epoch, and a recorded epoch-1 branch is not reused', async () => {
    const hub = hubFixture();
    const repo = tempRepo();
    createTasks(hub.ctx, [newTask('Parser')], 'user:alice');
    const bob = getAgent(hub.ctx, hub.liveAgent('bob').agentId);
    claimTask(hub.ctx, 'T-1', bob, 'agflow/T-1-parser');
    releaseTask(hub.ctx, 'T-1', bob, 'end of day');
    hub.ctx.db.run('UPDATE project SET epoch = 2');
    const answer = await call('claim_task', { id: 'T-1' }, as(hub.liveAgent('alice'), repo.root));
    expect(answer).toContain('(branch agflow/T-1-e2-parser)');
    expect(run(['git', 'branch', '--show-current'], worktreeOf(repo.root))).toBe('agflow/T-1-e2-parser');
    expect(getTask(hub.ctx, 'T-1').branch).toBe('agflow/T-1-e2-parser');
  });

  test('a newer position in the claim answer that cannot be fetched leaves the claim made, and the answer says how to take it', async () => {
    const hub = hubFixture();
    const repo = tempRepo();
    createTasks(hub.ctx, [newTask('Parser')], 'user:alice');
    const first = pushWork(repo, 'refs/agflow/T-1/a1', 'first.txt');
    writeTask(hub.ctx, 'T-1', { workRef: 'refs/agflow/T-1/a1', workSha: first });
    const late = 'b'.repeat(40);
    const alice = racing(hub, repo.root, () => writeTask(hub.ctx, 'T-1', { workRef: 'refs/agflow/T-1/a9-late-1', workSha: late }));
    const answer = await call('claim_task', { id: 'T-1' }, alice);
    expect(answer).toContain(`Started from refs/agflow/T-1/a1 at ${first.slice(0, 7)}.`);
    expect(answer).toContain(
      "The task's work position moved to refs/agflow/T-1/a9-late-1 at bbbbbbb during the claim, and agflow could not fetch it, so your branch stays where it started. " +
        `Fetch and merge it before you go on: git fetch origin refs/agflow/T-1/a9-late-1 && git merge ${late}`,
    );
    expect(run(['git', 'rev-parse', 'HEAD'], worktreeOf(repo.root))).toBe(first);
    expect(getTask(hub.ctx, 'T-1')).toMatchObject({ status: 'claimed', assignee: alice.state.agentId });
  });

  test("the hub's SHA wins over a work ref that has moved since", async () => {
    const hub = hubFixture();
    const repo = tempRepo();
    createTasks(hub.ctx, [newTask('Parser')], 'user:alice');
    const recorded = pushWork(repo, 'refs/agflow/T-1/a1', 'wip.txt');
    const moved = pushWork(repo, 'refs/agflow/T-1/a1', 'later.txt', 'refs/agflow/T-1/a1');
    expect(run(['git', 'rev-parse', 'refs/agflow/T-1/a1'], repo.origin)).toBe(moved);
    writeTask(hub.ctx, 'T-1', { workRef: 'refs/agflow/T-1/a1', workSha: recorded });
    expect(await call('claim_task', { id: 'T-1' }, as(hub.liveAgent('alice'), repo.root))).toContain(`Started from refs/agflow/T-1/a1 at ${recorded.slice(0, 7)}.`);
    expect(run(['git', 'rev-parse', 'HEAD'], worktreeOf(repo.root))).toBe(recorded);
  });

  test('a task branch pushed on top of the position is where the claim starts, and a newer position it holds already moves nothing', async () => {
    const hub = hubFixture();
    const repo = tempRepo();
    createTasks(hub.ctx, [newTask('Parser')], 'user:alice');
    const wip = pushWork(repo, 'refs/agflow/T-1/a1', 'wip.txt');
    const middle = pushWork(repo, 'refs/heads/agflow/T-1-parser', 'pushed.txt', 'refs/agflow/T-1/a1');
    const top = pushWork(repo, 'refs/heads/agflow/T-1-parser', 'more.txt', 'refs/heads/agflow/T-1-parser');
    writeTask(hub.ctx, 'T-1', { workRef: 'refs/agflow/T-1/a1', workSha: wip });
    const alice = racing(hub, repo.root, () => writeTask(hub.ctx, 'T-1', { workRef: 'refs/agflow/T-1/a2', workSha: middle }));
    const answer = await call('claim_task', { id: 'T-1' }, alice);
    expect(answer).toContain(`Started from refs/heads/agflow/T-1-parser at ${top.slice(0, 7)}.`);
    expect(answer).not.toContain('has commits your branch lacks');
    expect(run(['git', 'rev-parse', 'HEAD'], worktreeOf(repo.root))).toBe(top);
  });

  test('a task branch on origin that lacks the position: the claim starts from the position, and the answer says to merge the branch before submit', async () => {
    const hub = hubFixture();
    const repo = tempRepo();
    createTasks(hub.ctx, [newTask('Parser')], 'user:alice');
    // Bob pushed the task branch by hand and released it; a runner's WIP from main became the position later.
    const pushed = pushWork(repo, 'refs/heads/agflow/T-1-parser', 'pushed.txt');
    const wip = pushWork(repo, 'refs/agflow/T-1/a1', 'wip.txt');
    writeTask(hub.ctx, 'T-1', { workRef: 'refs/agflow/T-1/a1', workSha: wip });
    const alice = as(hub.liveAgent('alice'), repo.root);
    const answer = await call('claim_task', { id: 'T-1' }, alice);
    expect(answer).toContain(`Started from refs/agflow/T-1/a1 at ${wip.slice(0, 7)}.`);
    expect(answer).toContain(
      `origin/agflow/T-1-parser (at ${pushed.slice(0, 7)}) has commits your branch lacks, pushed after the work position was taken. ` +
        'Merge them before you submit, or the push is refused: git merge origin/agflow/T-1-parser',
    );
    expect(run(['git', 'rev-parse', 'HEAD'], worktreeOf(repo.root))).toBe(wip);
    run(['git', 'merge', '--quiet', '--no-edit', 'origin/agflow/T-1-parser'], worktreeOf(repo.root));
    await call('submit', { task_id: 'T-1', summary: 'Parser added' }, alice);
    expect(run(['git', 'rev-parse', 'refs/heads/agflow/T-1-parser'], repo.origin)).toBe(run(['git', 'rev-parse', 'HEAD'], worktreeOf(repo.root)));
  });

  test('at epoch 1 a recorded M1 branch that only looks like an epoch-2 name is reused, from its pushed head', async () => {
    const hub = hubFixture();
    const repo = tempRepo();
    createTasks(hub.ctx, [newTask('E2: parser')], 'user:alice');
    const bob = getAgent(hub.ctx, hub.liveAgent('bob').agentId);
    // M1's names had no "t-" guard: the title "E2: parser" gave agflow/T-1-e2-parser.
    claimTask(hub.ctx, 'T-1', bob, 'agflow/T-1-e2-parser');
    const pushed = pushWork(repo, 'refs/heads/agflow/T-1-e2-parser', 'bobs.txt');
    releaseTask(hub.ctx, 'T-1', bob, 'end of day');
    expect(await call('claim_task', { id: 'T-1' }, as(hub.liveAgent('alice'), repo.root))).toContain('(branch agflow/T-1-e2-parser)');
    expect(run(['git', 'rev-parse', 'HEAD'], worktreeOf(repo.root))).toBe(pushed);
    expect(getTask(hub.ctx, 'T-1').branch).toBe('agflow/T-1-e2-parser');
  });

  test('at epoch 2 a recorded epoch-2 branch is reused, not renamed', async () => {
    const hub = hubFixture();
    const repo = tempRepo();
    createTasks(hub.ctx, [newTask('Parser')], 'user:alice');
    hub.ctx.db.run('UPDATE project SET epoch = 2');
    const bob = getAgent(hub.ctx, hub.liveAgent('bob').agentId);
    claimTask(hub.ctx, 'T-1', bob, 'agflow/T-1-e2-old-name');
    releaseTask(hub.ctx, 'T-1', bob, 'end of day');
    expect(await call('claim_task', { id: 'T-1' }, as(hub.liveAgent('alice'), repo.root))).toContain('(branch agflow/T-1-e2-old-name)');
    expect(getTask(hub.ctx, 'T-1').branch).toBe('agflow/T-1-e2-old-name');
  });

  test("after a restore the person's worktree on the epoch-1 branch is switched to the epoch-2 one, work kept, and submit pushes it", async () => {
    const hub = hubFixture();
    const repo = tempRepo();
    createTasks(hub.ctx, [newTask('Parser')], 'user:alice');
    const alice = as(hub.liveAgent('alice'), repo.root);
    await call('claim_task', { id: 'T-1' }, alice);
    writeFileSync(join(worktreeOf(repo.root), 'committed.txt'), 'committed\n');
    commitAll(worktreeOf(repo.root), 'committed');
    const before = run(['git', 'rev-parse', 'HEAD'], worktreeOf(repo.root));
    writeFileSync(join(worktreeOf(repo.root), 'uncommitted.txt'), 'uncommitted\n');
    await call('release_task', { task_id: 'T-1', reason: 'end of day' }, alice);
    hub.ctx.db.run('UPDATE project SET epoch = 2');
    const answer = await call('claim_task', { id: 'T-1' }, alice);
    expect(answer).toContain('The worktree was on branch agflow/T-1-parser; agflow switched it to agflow/T-1-e2-parser, keeping its commits and changes.');
    expect(answer).toContain(`Work only inside ${worktreeOf(repo.root)} (branch agflow/T-1-e2-parser)`);
    expect(run(['git', 'branch', '--show-current'], worktreeOf(repo.root))).toBe('agflow/T-1-e2-parser');
    expect(run(['git', 'rev-parse', 'HEAD'], worktreeOf(repo.root))).toBe(before);
    expect(readFileSync(join(worktreeOf(repo.root), 'uncommitted.txt'), 'utf8')).toBe('uncommitted\n');
    expect(getTask(hub.ctx, 'T-1').branch).toBe('agflow/T-1-e2-parser');
    commitAll(worktreeOf(repo.root), 'uncommitted');
    const head = run(['git', 'rev-parse', 'HEAD'], worktreeOf(repo.root));
    expect(await call('submit', { task_id: 'T-1', summary: 'Parser added' }, alice)).toContain(`at ${head.slice(0, 7)} on agflow/T-1-e2-parser`);
    expect(run(['git', 'rev-parse', 'refs/heads/agflow/T-1-e2-parser'], repo.origin)).toBe(head);
  });

  test('a refused claim switches an existing worktree back and deletes the branch it created', async () => {
    const hub = hubFixture();
    const repo = tempRepo();
    createTasks(hub.ctx, [newTask('Parser')], 'user:alice');
    const alice = as(hub.liveAgent('alice'), repo.root);
    await call('claim_task', { id: 'T-1' }, alice);
    await call('release_task', { task_id: 'T-1', reason: 'end of day' }, alice);
    hub.ctx.db.run('UPDATE project SET epoch = 2');
    claimTask(hub.ctx, 'T-1', getAgent(hub.ctx, hub.liveAgent('bob').agentId), 'agflow/T-1-e2-parser', BRIDGE_VERSION);
    await expect(call('claim_task', { id: 'T-1' }, alice)).rejects.toThrow('not ready');
    expect(run(['git', 'branch', '--show-current'], worktreeOf(repo.root))).toBe('agflow/T-1-parser');
    expect(run(['git', 'branch', '--list', 'agflow/T-1-e2-parser'], repo.root)).toBe('');
  });

  test('resume_claim creates its worktree from the work position too', async () => {
    const hub = hubFixture();
    const repo = tempRepo();
    createTasks(hub.ctx, [newTask('Parser')], 'user:alice');
    const sha = pushWork(repo, 'refs/agflow/T-1/a1', 'wip.txt');
    writeTask(hub.ctx, 'T-1', { workRef: 'refs/agflow/T-1/a1', workSha: sha });
    await call('claim_task', { id: 'T-1' }, as(hub.liveAgent('alice'), repo.root));
    // Alice's other chat, in a clone that has never fetched the WIP ref, takes the claim over.
    const clone = cloneOf(repo, 'second');
    const answer = await call('resume_claim', { id: 'T-1' }, as(hub.liveAgent('alice'), clone));
    expect(answer).toContain(`Started from refs/agflow/T-1/a1 at ${sha.slice(0, 7)}.`);
    expect(run(['git', 'rev-parse', 'HEAD'], worktreeOf(clone))).toBe(sha);
    expect(readFileSync(join(worktreeOf(clone), 'wip.txt'), 'utf8')).toBe('wip.txt\n');
  });

  test('a refused claim still removes the worktree and the branch it created', async () => {
    const hub = hubFixture();
    const repo = tempRepo();
    createTasks(hub.ctx, [newTask('Parser')], 'user:alice');
    const sha = pushWork(repo, 'refs/agflow/T-1/a1', 'wip.txt');
    writeTask(hub.ctx, 'T-1', { workRef: 'refs/agflow/T-1/a1', workSha: sha });
    claimTask(hub.ctx, 'T-1', getAgent(hub.ctx, hub.liveAgent('bob').agentId), 'agflow/T-1-parser', BRIDGE_VERSION);
    await expect(call('claim_task', { id: 'T-1' }, as(hub.liveAgent('alice'), repo.root))).rejects.toThrow('not ready');
    expect(existsSync(worktreeOf(repo.root))).toBe(false);
    expect(run(['git', 'branch', '--list', 'agflow/T-1-parser'], repo.root)).toBe('');
  });

  test('a position that cannot be fetched refuses the claim before the hub hears of it', async () => {
    const hub = hubFixture();
    const repo = tempRepo();
    createTasks(hub.ctx, [newTask('Parser')], 'user:alice');
    writeTask(hub.ctx, 'T-1', { workRef: 'refs/agflow/T-1/a1', workSha: 'a'.repeat(40) });
    await expect(call('claim_task', { id: 'T-1' }, as(hub.liveAgent('alice'), repo.root))).rejects.toThrow(
      `could not fetch the task's work position (refs/agflow/T-1/a1 at aaaaaaa) from origin`,
    );
    expect(existsSync(worktreeOf(repo.root))).toBe(false);
    expect(getTask(hub.ctx, 'T-1').status).toBe('ready');
  });

  test('an existing branch is kept, and the answer says when it lacks the work position', async () => {
    const hub = hubFixture();
    const repo = tempRepo();
    createTasks(hub.ctx, [newTask('Parser')], 'user:alice');
    const alice = as(hub.liveAgent('alice'), repo.root);
    await call('claim_task', { id: 'T-1' }, alice);
    const before = run(['git', 'rev-parse', 'HEAD'], worktreeOf(repo.root));
    await call('release_task', { task_id: 'T-1', reason: 'end of day' }, alice);
    // A runner went on from main meanwhile; its WIP is the task's position now.
    const sha = pushWork(repo, 'refs/agflow/T-1/a1', 'wip.txt');
    writeTask(hub.ctx, 'T-1', { workRef: 'refs/agflow/T-1/a1', workSha: sha });
    const answer = await call('claim_task', { id: 'T-1' }, alice);
    expect(answer).toContain(
      `Your branch agflow/T-1-parser does not contain the task's work position, refs/agflow/T-1/a1 at ${sha.slice(0, 7)}. Merge it before you go on: git merge ${sha}`,
    );
    expect(run(['git', 'rev-parse', 'HEAD'], worktreeOf(repo.root))).toBe(before);
  });
});
