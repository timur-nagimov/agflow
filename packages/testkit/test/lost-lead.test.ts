import { expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { commitFiles, gitIn, originRepo } from '../src/git-fixtures';
import { LOST_LEAD, workerExitReported } from '../src/scenarios/lost-lead';

for (const summary of [
  'the agent exited with code 0, stopped by close',
  'the agent exited with code 0, stopped by close, after it ended accepted',
  'the agent exited, stopped by sigterm',
  'the agent was killed by SIGKILL, stopped by sigkill',
]) {
  test(`recognizes the worker exit: ${summary}`, () => {
    expect(workerExitReported([{ kind: 'note', summary }])).toBe(true);
  });
}

test('acceptance, hold requests and agent text do not stand in for an exit report', () => {
  expect(workerExitReported([])).toBe(false);
  expect(workerExitReported([
    { kind: 'note', summary: 'attempt ended accepted' },
    { kind: 'note', summary: 'hold requested' },
    { kind: 'text', summary: 'the agent exited with code 0, stopped by close' },
  ])).toBe(false);
});

test('the scripted lead fetches from its origin and checks review.txt before accepting', async () => {
  const program = LOST_LEAD.programs('T-1')['lead-a2']!;
  const steps = program.reactions![0]!.steps;
  expect(steps[0]?.kind).toBe('shell');
  expect(steps[1]).toMatchObject({ kind: 'tool', tool: 'accept_task' });
  const review = steps[0]!;
  if (review.kind !== 'shell') throw new Error('no review shell step');
  expect(LOST_LEAD.goal).toContain('git fetch origin');
  const repo = await originRepo({ 'README.md': 'demo\n' });
  try {
    const clone = join(repo.root, 'lead');
    await gitIn(repo.root, ['clone', '-q', repo.path, clone]);
    mkdirSync(join(clone, '.agflow/run'), { recursive: true });
    const run = async () => {
      const proc = Bun.spawn(['/bin/sh', '-c', review.cmd], {
        cwd: clone,
        env: { PATH: process.env.PATH, HOME: repo.root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
        stdout: 'pipe', stderr: 'pipe',
      });
      await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      return proc.exited;
    };
    expect(await run()).not.toBe(0); // The lead's origin lacks the submission.
    await commitFiles(repo.path, { branch: 'agflow/T-1-add-review-txt', files: { 'review.txt': 'wrong\n' } });
    expect(await run()).not.toBe(0);
    await commitFiles(repo.path, { branch: 'agflow/T-1-add-review-txt', files: { 'review.txt': 'review\n' } });
    expect(await run()).toBe(0);
    expect(await Bun.file(join(clone, '.agflow/run/review-verified')).text()).toBe('review\n');
  } finally {
    repo.remove();
  }
});
