import { describe, expect, test } from 'bun:test';
import { PROTOCOL_VERSION } from '@agflow/core';
import { getAttempt, updateAttempt } from '../src/attempt-store';
import { type CommandRow, findCommand, pendingCommands, recordResult } from '../src/commands';
import { loadConfig } from '../src/config';
import { type HubContext, tx } from '../src/context';
import { listEvents } from '../src/events';
import { queueMerges } from '../src/merges';
import { listMessages } from '../src/messages';
import { markGitNotReady } from '../src/runners';
import { readySet, withWaitReason } from '../src/scheduler';
import { getTask, move, overlappingPathHolder } from '../src/task-store';
import { acceptTask, createTasks, markMerged } from '../src/tasks';
import { type RunnerAttempt, addRunner, addRunnerAttempt, createTestContext, newTask } from './helpers';

const sha = (char: string) => char.repeat(40);

/** The runner speaks the protocol that knows merge_task, as a runner of this release does. */
function current(ctx: HubContext, runnerId: string): void {
  ctx.db.query('UPDATE runners SET protocol = $protocol WHERE id = $id').run({ protocol: PROTOCOL_VERSION, id: runnerId });
}

/** A runner attempt whose submission was recorded at head: the task submitted, the attempt holding (design 6.13). */
function submitted(ctx: HubContext, held: RunnerAttempt, head = sha('a')): void {
  tx(ctx, (emit) => {
    const task = getTask(ctx, held.task.id);
    move(ctx, emit, task, 'submitted', `agent:${held.agent.id}`, {
      changes: {
        submission: {
          summary: 'Done.',
          evidence: [],
          branch: task.branch,
          headSha: head,
          submittedAt: ctx.now(),
          by: held.agent.id,
          attemptId: held.attempt.id,
          submissionId: null,
        },
      },
    });
  });
  updateAttempt(ctx, held.attempt.id, { status: 'holding', leaseExpiresAt: null });
}

/** A hub with auto merge, and a task of a current runner submitted at head. */
function setup(options: { ownedPaths?: string[] } = {}) {
  const { ctx, clock } = createTestContext({ autoMerge: true });
  const [task] = createTasks(ctx, [newTask({ title: 'Parse the config', ...options })], 'user:alice');
  const held = addRunnerAttempt(ctx, { taskId: task?.id as string });
  current(ctx, held.runner.id);
  submitted(ctx, held);
  return { ctx, clock, held, taskId: held.task.id };
}

/** Another task of the same runner, submitted too. */
function another(ctx: HubContext, held: RunnerAttempt, title: string, ownedPaths: string[] = []): RunnerAttempt {
  const [task] = createTasks(ctx, [newTask({ title, ownedPaths })], 'user:alice');
  const next = addRunnerAttempt(ctx, { taskId: task?.id as string, runnerId: held.runner.id });
  submitted(ctx, next, sha('b'));
  return next;
}

const merges = (ctx: HubContext, runnerId: string): CommandRow[] =>
  pendingCommands(ctx, runnerId, PROTOCOL_VERSION).filter((row) => row.kind === 'merge_task');

describe('accepting with AGFLOW_AUTO_MERGE', () => {
  test("moves the task to merging and sends merge_task to its author's runner; the author's attempt keeps holding", () => {
    const { ctx, held, taskId } = setup();
    expect(acceptTask(ctx, taskId, 'agent:A-9')).toMatchObject({ status: 'merging', assignee: held.agent.id });
    expect(getAttempt(ctx, held.attempt.id).status).toBe('holding');
    expect(merges(ctx, held.runner.id).map((row) => row.command)).toEqual([
      { kind: 'merge_task', taskId, title: 'Parse the config', branch: held.task.branch as string, headSha: sha('a') },
    ]);
    expect(listEvents(ctx.db, { subject: taskId }).map((event) => [event.type, event.actor]).slice(-2)).toEqual([
      ['task.accepted', 'agent:A-9'],
      ['task.merging', 'system'],
    ]);
  });

  test('one merge is in flight at a time: the next goes out once the first is merged', () => {
    const { ctx, held, taskId } = setup();
    const second = another(ctx, held, 'Print the config');
    acceptTask(ctx, taskId, 'user:alice');
    acceptTask(ctx, second.task.id, 'user:alice');
    const [first] = merges(ctx, held.runner.id);
    expect(merges(ctx, held.runner.id).map((row) => row.command)).toMatchObject([{ taskId }]);
    // A tick changes nothing while the merge is in flight.
    expect(queueMerges(ctx)).toBeNull();
    recordResult(ctx, held.runner.id, { commandId: first?.id as string, ok: true, data: { status: 'merged', sha: sha('f') } });
    expect(getTask(ctx, taskId)).toMatchObject({ status: 'merged', mergedSha: sha('f'), assignee: held.agent.id });
    expect(getAttempt(ctx, held.attempt.id)).toMatchObject({ status: 'ended', endReason: 'accepted' });
    expect(pendingCommands(ctx, held.runner.id, PROTOCOL_VERSION).map((row) => row.command)).toContainEqual({
      kind: 'cleanup_attempt',
      attemptId: held.attempt.id,
    });
    expect(listEvents(ctx.db, { subject: taskId }).find((event) => event.type === 'task.merged')).toMatchObject({
      actor: `runner:${held.runner.id}`,
      data: { from: 'merging', sha: sha('f') },
    });
    expect(merges(ctx, held.runner.id).map((row) => row.command)).toMatchObject([{ taskId: second.task.id, headSha: sha('b') }]);
  });

  test('a conflict sends the task back to its author through rejected, with the files as its feedback', () => {
    const { ctx, held, taskId } = setup();
    acceptTask(ctx, taskId, 'user:alice');
    const [merge] = merges(ctx, held.runner.id);
    const conflict = { status: 'conflict', files: ['src/config.ts', 'README.md'] };
    recordResult(ctx, held.runner.id, { commandId: merge?.id as string, ok: true, data: conflict });
    const task = getTask(ctx, taskId);
    expect(task).toMatchObject({ status: 'claimed', assignee: held.agent.id, currentAttempt: held.attempt.id });
    expect(task.feedback).toContain('These files conflict: src/config.ts, README.md.');
    expect(listEvents(ctx.db, { subject: taskId }).find((event) => event.type === 'task.rejected')?.actor).toBe(
      'hub:auto-merge',
    );
    const resume = pendingCommands(ctx, held.runner.id, PROTOCOL_VERSION).find((row) => row.kind === 'resume_attempt');
    expect(resume?.command.kind === 'resume_attempt' && resume.command.prompt).toContain('src/config.ts');
    // A conflict is no review: it uses none of the author's review rounds.
    expect(getAttempt(ctx, held.attempt.id)).toMatchObject({ status: 'starting', reviewRounds: 0 });
  });

  test('a conflict goes back to its author even after both review rounds, and leaves them as they were', () => {
    const { ctx, held, taskId } = setup();
    updateAttempt(ctx, held.attempt.id, { reviewRounds: 2 });
    acceptTask(ctx, taskId, 'user:alice');
    const [merge] = merges(ctx, held.runner.id);
    recordResult(ctx, held.runner.id, { commandId: merge?.id as string, ok: true, data: { status: 'conflict', files: [] } });
    expect(getTask(ctx, taskId)).toMatchObject({ status: 'claimed', currentAttempt: held.attempt.id });
    expect(getAttempt(ctx, held.attempt.id)).toMatchObject({ status: 'starting', reviewRounds: 2, endReason: null });
  });

  test('a failed merge stays merging, is recorded, and goes out again 15 s later, then twice as long after each failure, up to 10 min', () => {
    const { ctx, clock, held, taskId } = setup();
    acceptTask(ctx, taskId, 'user:alice');
    const fail = (error = 'remote: denied'): void => {
      const [merge] = merges(ctx, held.runner.id);
      expect(merge?.command).toMatchObject({ kind: 'merge_task', taskId });
      recordResult(ctx, held.runner.id, { commandId: merge?.id as string, ok: false, error });
    };
    fail();
    expect([getTask(ctx, taskId).status, merges(ctx, held.runner.id)]).toEqual(['merging', []]);
    for (const [index, seconds] of [15, 30, 60, 120, 240, 480, 600, 600].entries()) {
      clock.advance(seconds * 1_000 - 1);
      expect([index, queueMerges(ctx)]).toEqual([index, null]);
      clock.advance(1);
      expect(queueMerges(ctx)?.command).toMatchObject({ kind: 'merge_task', taskId });
      fail();
    }
    const failures = listEvents(ctx.db, { subject: taskId }).filter((event) => event.type === 'task.merge_failed');
    expect(failures).toHaveLength(9);
    expect(failures[0]?.data).toEqual({ runnerId: held.runner.id, error: 'remote: denied' });
  });

  test('a merge that waits to be tried again holds up no other', () => {
    const { ctx, held, taskId } = setup();
    const second = another(ctx, held, 'Print the config');
    acceptTask(ctx, taskId, 'user:alice');
    acceptTask(ctx, second.task.id, 'user:alice');
    const [first] = merges(ctx, held.runner.id);
    recordResult(ctx, held.runner.id, { commandId: first?.id as string, ok: false, error: 'remote: denied' });
    // The failed task waits; the other one's merge goes out at once.
    const [next] = merges(ctx, held.runner.id);
    expect(next?.command).toMatchObject({ kind: 'merge_task', taskId: second.task.id });
    recordResult(ctx, held.runner.id, { commandId: next?.id as string, ok: true, data: { status: 'merged', sha: sha('f') } });
    expect(getTask(ctx, second.task.id).status).toBe('merged');
    expect(merges(ctx, held.runner.id)).toEqual([]);
  });

  test('people hear of the first failure and the fifth, with the likely cause when the error names one', () => {
    const told = (error: string): string[] => {
      const { ctx, clock, held, taskId } = setup();
      acceptTask(ctx, taskId, 'user:alice');
      for (let failures = 1; failures <= 6; failures++) {
        if (failures > 1) {
          clock.advance(10 * 60_000);
          queueMerges(ctx);
        }
        const [merge] = merges(ctx, held.runner.id);
        recordResult(ctx, held.runner.id, { commandId: merge?.id as string, ok: false, error });
      }
      return listMessages(ctx, { target: 'humans' })
        .reverse()
        .map((message) => message.body);
    };
    const named = 'T-1 ("Parse the config") into main';
    const retries = [
      'agflow tries again after 15 s, then twice as long after each failure, up to 10 min.',
      'agflow keeps trying, up to 10 min apart.',
    ];
    const tail = ' If you merge it yourself, mark it merged.';
    expect(told('remote: denied')).toEqual([
      `agflow could not merge ${named}: runner R-1 said: remote: denied\n${retries[0]}${tail}`,
      `agflow is still failing to merge ${named} after 5 tries: runner R-1 said: remote: denied\n${retries[1]}${tail}`,
    ]);
    const protectedMain = 'cannot push main: remote: error: GH006: Protected branch update failed for refs/heads/main.';
    const pushes = 'Likely cause: main is protected or requires checks, and AGFLOW_AUTO_MERGE needs a main that accepts ' +
      "direct pushes from the runners' owners.";
    expect(told(protectedMain)).toEqual([
      `agflow could not merge ${named}: runner R-1 said: ${protectedMain}\n${pushes}\n${retries[0]}${tail}`,
      `agflow is still failing to merge ${named} after 5 tries: runner R-1 said: ${protectedMain}\n${pushes}\n${retries[1]}${tail}`,
    ]);
    const workflow =
      'cannot push main: refusing to allow a Personal Access Token to create or update workflow ' +
      '`.github/workflows/ci.yml` without `workflow` scope';
    expect(told(workflow)[0]).toContain(
      "\nLikely cause: the runner's git credentials cannot push changes to .github/workflows. A fine-grained token " +
        'needs Workflows write; a classic token or an OAuth login needs the workflow scope.\n',
    );
  });

  test('a merging task whose last merge failed tells the board how many failed and the newest error', () => {
    const { ctx, clock, held, taskId } = setup();
    acceptTask(ctx, taskId, 'user:alice');
    const reason = () => withWaitReason(ctx, getTask(ctx, taskId)).waitReason;
    expect(reason()).toBeNull();
    const [merge] = merges(ctx, held.runner.id);
    recordResult(ctx, held.runner.id, { commandId: merge?.id as string, ok: false, error: 'remote: denied' });
    expect(reason()).toBe('merge failed 1 time: remote: denied');
    clock.advance(15_000);
    queueMerges(ctx);
    const [again] = merges(ctx, held.runner.id);
    recordResult(ctx, held.runner.id, { commandId: again?.id as string, ok: false, error: 'remote: not now' });
    expect(reason()).toBe('merge failed 2 times: remote: not now');
    // A person merged it by hand: it is no longer waiting.
    markMerged(ctx, taskId, 'user:alice');
    expect(reason()).toBeNull();
  });

  test("goes to another current runner when the author's is offline, never to an older one, and moves off a runner that went offline", () => {
    const { ctx, held, taskId } = setup();
    ctx.db.query("UPDATE runners SET state = 'offline' WHERE id = $id").run({ id: held.runner.id });
    const older = addRunner(ctx, { owner: 'bob' });
    acceptTask(ctx, taskId, 'user:alice');
    expect(getTask(ctx, taskId).status).toBe('merging');
    expect(merges(ctx, older)).toEqual([]);
    const other = addRunner(ctx, { owner: 'bob' });
    current(ctx, other);
    const sent = queueMerges(ctx);
    expect(sent).toMatchObject({ runnerId: other, command: { kind: 'merge_task', taskId } });
    // That runner goes offline in turn: the merge is cancelled there and goes back to the author's runner.
    ctx.db.query("UPDATE runners SET state = 'offline' WHERE id = $id").run({ id: other });
    ctx.db.query("UPDATE runners SET state = 'online' WHERE id = $id").run({ id: held.runner.id });
    expect(queueMerges(ctx)).toMatchObject({ runnerId: held.runner.id, command: { taskId } });
    expect(findCommand(ctx, sent?.id as string)?.status).toBe('cancelled');
  });

  test('after a failed merge the next try goes to another able runner, and back once it failed there too', () => {
    const { ctx, clock, held, taskId } = setup();
    const other = addRunner(ctx, { owner: 'bob' });
    current(ctx, other);
    acceptTask(ctx, taskId, 'user:alice');
    const fail = (runnerId: string): void => {
      const [merge] = merges(ctx, runnerId);
      recordResult(ctx, runnerId, { commandId: merge?.id as string, ok: false, error: 'remote: denied' });
    };
    // The first merge goes to the author's runner. It fails there, so the next try goes to the other runner.
    fail(held.runner.id);
    clock.advance(15_000);
    expect(queueMerges(ctx)).toMatchObject({ runnerId: other, command: { kind: 'merge_task', taskId } });
    // Once it failed on both, it goes where it failed longest ago.
    fail(other);
    clock.advance(30_000);
    expect(queueMerges(ctx)).toMatchObject({ runnerId: held.runner.id, command: { kind: 'merge_task', taskId } });
  });

  test("passes over a runner whose git is not ready, the author's included", () => {
    const { ctx, held, taskId } = setup();
    markGitNotReady(ctx, held.runner.id, 'the last 3 WIP pushes failed: denied');
    const other = addRunner(ctx, { owner: 'bob' });
    current(ctx, other);
    acceptTask(ctx, taskId, 'user:alice');
    expect(merges(ctx, held.runner.id)).toEqual([]);
    expect(merges(ctx, other).map((row) => row.command)).toMatchObject([{ kind: 'merge_task', taskId }]);
  });

  test('a person who merged a merging task by hand marks it merged; its merge is cancelled', () => {
    const { ctx, held, taskId } = setup();
    acceptTask(ctx, taskId, 'user:alice');
    const [merge] = merges(ctx, held.runner.id);
    expect(markMerged(ctx, taskId, 'user:alice', 'abc1234')).toMatchObject({ status: 'merged', mergedSha: 'abc1234' });
    expect(getAttempt(ctx, held.attempt.id)).toMatchObject({ status: 'ended', endReason: 'accepted' });
    expect(findCommand(ctx, merge?.id as string)?.status).toBe('cancelled');
    // Its late result changes nothing.
    expect(recordResult(ctx, held.runner.id, { commandId: merge?.id as string, ok: true, data: { status: 'merged', sha: sha('f') } })).toBeNull();
    expect(getTask(ctx, taskId).mergedSha).toBe('abc1234');
  });

  test('the lead cannot mark a merging task merged: the merge into main goes on', () => {
    const { ctx, held, taskId } = setup();
    acceptTask(ctx, taskId, 'agent:A-9');
    const [merge] = merges(ctx, held.runner.id);
    expect(() => markMerged(ctx, taskId, 'agent:A-9')).toThrow(`${taskId} is merging`);
    expect(getTask(ctx, taskId).status).toBe('merging');
    expect(findCommand(ctx, merge?.id as string)?.status).toBe('pending');
  });

  test('a task not submitted on its own branch is accepted as without auto merge, for people to merge', () => {
    const { ctx, held, taskId } = setup();
    ctx.db.run(`UPDATE tasks SET submission = json_set(submission, '$.branch', 'person-review') WHERE id = '${taskId}'`);
    expect(acceptTask(ctx, taskId, 'user:alice').status).toBe('accepted');
    expect(getAttempt(ctx, held.attempt.id).endReason).toBe('accepted');
    expect(merges(ctx, held.runner.id)).toEqual([]);
  });
});

describe('dependencies and paths with AGFLOW_AUTO_MERGE', () => {
  test('a dependent waits until its dependency is merged, not accepted', () => {
    const { ctx, held, taskId } = setup();
    const [dependent] = createTasks(ctx, [newTask({ title: 'Use the config', dependsOn: [taskId] })], 'user:alice');
    acceptTask(ctx, taskId, 'user:alice');
    expect(getTask(ctx, dependent?.id as string)).toMatchObject({ status: 'blocked', blockedKind: 'deps' });
    const [merge] = merges(ctx, held.runner.id);
    recordResult(ctx, held.runner.id, { commandId: merge?.id as string, ok: true, data: { status: 'merged', sha: sha('f') } });
    expect(getTask(ctx, dependent?.id as string).status).toBe('ready');
  });

  test('accepted and merging work keeps holding its owned paths until it is merged', () => {
    const { ctx, held, taskId } = setup({ ownedPaths: ['src/config/**'] });
    acceptTask(ctx, taskId, 'user:alice');
    const [overlapping] = createTasks(ctx, [newTask({ title: 'Tune the config', ownedPaths: ['src/config/**'] })], 'user:alice');
    expect(overlappingPathHolder(ctx, overlapping!)?.id).toBe(taskId);
    expect(readySet(ctx).map((candidate) => candidate.id)).not.toContain(overlapping?.id);
    const [merge] = merges(ctx, held.runner.id);
    recordResult(ctx, held.runner.id, { commandId: merge?.id as string, ok: true, data: { status: 'merged', sha: sha('f') } });
    expect(overlappingPathHolder(ctx, overlapping!)).toBeNull();
    expect(readySet(ctx).map((candidate) => candidate.id)).toContain(overlapping?.id);
  });

  test('without auto merge, an accepted task releases its dependents and its paths at once', () => {
    const { ctx } = createTestContext();
    const [task] = createTasks(ctx, [newTask({ title: 'Parse', ownedPaths: ['src/**'] })], 'user:alice');
    const held = addRunnerAttempt(ctx, { taskId: task?.id as string });
    submitted(ctx, held);
    const [dependent] = createTasks(ctx, [newTask({ title: 'Use', dependsOn: [held.task.id], ownedPaths: ['src/**'] })], 'user:alice');
    expect(acceptTask(ctx, held.task.id, 'user:alice').status).toBe('accepted');
    expect(getTask(ctx, dependent?.id as string).status).toBe('ready');
    expect(overlappingPathHolder(ctx, dependent!)).toBeNull();
  });
});

describe('the settings', () => {
  test('AGFLOW_AUTO_MERGE=1 and AGFLOW_AUTO_ACCEPT=1 turn them on; both are off by default', () => {
    const base = {
      AGFLOW_AUTH: 'dev',
      AGFLOW_ALLOWED_USERS: 'alice',
      AGFLOW_PROJECT_NAME: 'demo',
      AGFLOW_PROJECT_REPO: 'https://github.com/acme/demo',
    };
    expect(loadConfig(base).config).toMatchObject({ autoMerge: false, autoAccept: false });
    const on = loadConfig({ ...base, AGFLOW_AUTO_MERGE: '1', AGFLOW_AUTO_ACCEPT: '1' }).config;
    expect(on).toMatchObject({ autoMerge: true, autoAccept: true });
    expect(() => loadConfig({ ...base, AGFLOW_AUTO_MERGE: 'yes' })).toThrow(/AGFLOW_AUTO_MERGE/);
    expect(() => loadConfig({ ...base, AGFLOW_AUTO_ACCEPT: 'true' })).toThrow(/AGFLOW_AUTO_ACCEPT/);
  });
});
