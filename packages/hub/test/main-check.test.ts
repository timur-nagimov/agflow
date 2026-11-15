import { describe, expect, test } from 'bun:test';
import { PROTOCOL_VERSION, type RawRunnerEvent, type RunnerEventData, type SubmissionCheck } from '@agflow/core';
import { getAttempt } from '../src/attempt-store';
import { type CommandRow, findCommand, pendingCommands, recordResult } from '../src/commands';
import { type HubContext, tx } from '../src/context';
import { listEvents } from '../src/events';
import { applyRunnerEvents } from '../src/events-in';
import { FIX_MAIN_TITLE, MAIN_CHECK_RETRY_MS, mainHealth, openFixTask, queueMainCheck } from '../src/main-check';
import { listMessages } from '../src/messages';
import { setPaused } from '../src/project';
import { runTick } from '../src/scheduler';
import { requestSubmission } from '../src/submissions';
import { getTask, move } from '../src/task-store';
import { createTasks, markMerged } from '../src/tasks';
import { type RunnerAttempt, addRunner, addRunnerAttempt, createTestContext, markHubAlive, newTask } from './helpers';

const sha = (char: string) => char.repeat(40);
const short = (char: string) => char.repeat(7);
const command = 'bash scripts/check.sh';
const failed: SubmissionCheck = { status: 'failed', command, durationMs: 61_000, tail: 'FAIL src/app.test.ts\n1 fail' };
const passed: SubmissionCheck = { status: 'passed', command, durationMs: 58_000, tail: '12 pass' };

/** A hub with auto merge, and a runner of this release, which speaks the protocol that knows check_main. */
function setup(config: { autoAccept?: boolean } = {}) {
  const { ctx, clock } = createTestContext({ autoMerge: true, ...config });
  return { ctx, clock, runner: current(ctx) };
}

function current(ctx: HubContext): string {
  const runnerId = addRunner(ctx);
  ctx.db.query('UPDATE runners SET protocol = $p WHERE id = $id').run({ p: PROTOCOL_VERSION, id: runnerId });
  return runnerId;
}

/** A task merged into main at sha, which a person says here, as merge_task's result would: main is at sha now. */
function merge(ctx: HubContext, at: string, title = 'Parse the config'): string {
  const [task] = createTasks(ctx, [newTask({ title })], 'user:alice');
  const id = task?.id as string;
  tx(ctx, (emit) => {
    const claimed = move(ctx, emit, getTask(ctx, id), 'claimed', 'system');
    move(ctx, emit, move(ctx, emit, claimed, 'submitted', 'user:alice'), 'accepted', 'user:alice');
  });
  markMerged(ctx, id, 'user:alice', at);
  return id;
}

const checks = (ctx: HubContext, runnerId: string): CommandRow[] =>
  pendingCommands(ctx, runnerId, PROTOCOL_VERSION).filter((row) => row.kind === 'check_main');

/** The runner answers its pending check_main with the check. */
function answer(ctx: HubContext, runnerId: string, check: SubmissionCheck): void {
  const [row] = checks(ctx, runnerId);
  if (row?.command.kind !== 'check_main') throw new Error('no check_main is pending');
  recordResult(ctx, runnerId, { commandId: row.id, ok: true, data: { sha: row.command.sha, check } });
}

const told = (ctx: HubContext, to: string) => listMessages(ctx, {}).filter((message) => message.to === to);
const checkedEvents = (ctx: HubContext) => listEvents(ctx.db).filter((event) => event.type === 'main.checked');

describe("main's check, after each merge", () => {
  test('a merge sends one check of the sha it made, and no second goes out while one is pending', () => {
    const { ctx, runner } = setup();
    merge(ctx, sha('a'));
    expect(checks(ctx, runner).map((row) => row.command)).toEqual([{ kind: 'check_main', sha: sha('a') }]);
    merge(ctx, sha('b'), 'Print the config');
    expect(queueMainCheck(ctx)).toBeNull();
    answer(ctx, runner, passed);
    // The next tick checks main as agflow last merged it; a sha with a result is never checked again.
    expect(queueMainCheck(ctx)?.command).toEqual({ kind: 'check_main', sha: sha('b') });
    answer(ctx, runner, passed);
    expect(queueMainCheck(ctx)).toBeNull();
    const recorded = { status: 'passed', command, tail: '12 pass', durationMs: 58_000, runnerId: runner };
    expect(checkedEvents(ctx).map((event) => [event.actor, event.data])).toEqual([
      [`runner:${runner}`, { sha: sha('a'), ...recorded }],
      [`runner:${runner}`, { sha: sha('b'), ...recorded }],
    ]);
    expect(mainHealth(ctx)).toEqual({ status: 'passed', sha: sha('b'), at: ctx.now() });
  });

  test('a check that gave no result records nothing, and goes out again for its sha no sooner than a minute later', () => {
    const { ctx, clock, runner } = setup();
    merge(ctx, sha('a'));
    const [first] = checks(ctx, runner);
    recordResult(ctx, runner, { commandId: first?.id as string, ok: false, error: 'cannot fetch main' });
    expect(queueMainCheck(ctx)).toBeNull();
    clock.advance(MAIN_CHECK_RETRY_MS - 1);
    expect(queueMainCheck(ctx)).toBeNull();
    clock.advance(1);
    const [second] = [queueMainCheck(ctx)];
    expect(second?.command).toEqual({ kind: 'check_main', sha: sha('a') });
    // Data agflow cannot read counts the same.
    recordResult(ctx, runner, { commandId: second?.id as string, ok: true, data: { sha: sha('a') } });
    expect(queueMainCheck(ctx)).toBeNull();
    clock.advance(MAIN_CHECK_RETRY_MS);
    expect(queueMainCheck(ctx)?.command).toEqual({ kind: 'check_main', sha: sha('a') });
    expect(checkedEvents(ctx)).toEqual([]);
    expect(mainHealth(ctx)).toBeNull();
  });

  test('goes to the current runner with the most free slots, never an older one, and moves off one gone offline', () => {
    const { ctx } = createTestContext({ autoMerge: true });
    const older = addRunner(ctx);
    ctx.db.query('UPDATE runners SET protocol = 3 WHERE id = $id').run({ id: older });
    merge(ctx, sha('a'));
    expect(ctx.db.query("SELECT COUNT(*) AS n FROM runner_commands WHERE kind = 'check_main'").get()).toEqual({ n: 0 });
    const small = current(ctx);
    const large = current(ctx);
    ctx.db.query('UPDATE runners SET capacity = 4 WHERE id = $id').run({ id: large });
    const sent = queueMainCheck(ctx);
    expect(sent?.runnerId).toBe(large);
    ctx.db.query("UPDATE runners SET state = 'offline' WHERE id = $id").run({ id: large });
    const moved = queueMainCheck(ctx);
    expect(moved?.runnerId).toBe(small);
    expect(findCommand(ctx, sent?.id as string)?.status).toBe('cancelled');
    expect(pendingCommands(ctx, older, 3)).toEqual([]);
    // A runner gone back to an older release would never be sent it: it is cancelled too, and none is left to check.
    ctx.db.query('UPDATE runners SET protocol = 3 WHERE id = $id').run({ id: small });
    expect(queueMainCheck(ctx)).toBeNull();
    expect(findCommand(ctx, moved?.id as string)?.status).toBe('cancelled');
  });

  test('the tick checks main while the project is paused, and only with AGFLOW_AUTO_MERGE', () => {
    const { ctx, runner } = setup();
    merge(ctx, sha('a'));
    answer(ctx, runner, passed);
    tx(ctx, (emit) => emit({ type: 'task.merged', actor: 'user:alice', subject: 'T-1', data: { sha: sha('b') } }));
    setPaused(ctx, true, 'user:alice');
    markHubAlive(ctx);
    runTick(ctx);
    expect(checks(ctx, runner).map((row) => row.command)).toEqual([{ kind: 'check_main', sha: sha('b') }]);
    const { ctx: plain } = createTestContext();
    const other = current(plain);
    merge(plain, sha('a'));
    markHubAlive(plain);
    runTick(plain);
    expect(checks(plain, other)).toEqual([]);
  });
});

describe('when main fails', () => {
  test('a failure of the newest merge gets one fix task, at the top priority, and people and the lead hear once', () => {
    const { ctx, runner } = setup();
    merge(ctx, sha('a'));
    answer(ctx, runner, passed);
    const second = merge(ctx, sha('b'), 'Print the config');
    const third = merge(ctx, sha('c'), 'Lint the config');
    // b is no longer the newest main: c's check, which may find it fixed, decides.
    answer(ctx, runner, failed);
    expect([openFixTask(ctx), told(ctx, 'lead')]).toEqual([null, []]);
    expect(mainHealth(ctx)).toEqual({ status: 'failed', since: sha('b'), fixTask: null });
    queueMainCheck(ctx);
    answer(ctx, runner, failed);
    const fix = openFixTask(ctx);
    if (fix === null) throw new Error('no fix task was created');
    expect(fix).toMatchObject({
      title: `${FIX_MAIN_TITLE} the check fails after ${third}`,
      status: 'ready',
      priority: 0,
      tier: 'strong',
      ownedPaths: [],
      createdBy: 'system',
      nonGoals: [
        'Weakening, skipping or deleting tests.',
        "Changing the check's own files: .agflow/config.json and what its check command runs.",
      ],
      acceptance: [
        { id: 'A1', assertion: `The check \`${command}\` passes with main merged in.` },
        { id: 'A2', assertion: 'No test was removed or skipped.' },
      ],
    });
    expect(fix.objective).toStartWith(
      `The project's check \`${command}\` fails on main at ${sha('c')}, which agflow merged for ${third}. Tasks ` +
        `merged since main's check last passed: ${second}, ${third}.`,
    );
    expect(fix.objective).toEndWith('The end of its output:\n> FAIL src/app.test.ts\n> 1 fail');
    expect(fix.why).toBe('Every submission merges main before its check, so while main fails, every submission fails.');
    for (const to of ['humans', 'lead']) {
      expect(told(ctx, to).map((message) => [message.taskId, message.body])).toEqual([
        [
          fix.id,
          `main's check \`${command}\` fails at ${short('c')}, after ${third} merged. agflow created ${fix.id} ` +
            `("${fix.title}") to fix it, at the top priority. The lead should not create another task for it.`,
        ],
      ]);
    }
    expect(mainHealth(ctx)).toEqual({ status: 'failed', since: sha('b'), fixTask: fix.id });
    // Another failure while the fix task is open creates no other, and tells nobody again.
    merge(ctx, sha('d'), 'Format the config');
    answer(ctx, runner, failed);
    expect(openFixTask(ctx)?.id).toBe(fix.id);
    expect(createdBySystem(ctx)).toHaveLength(1);
    expect([told(ctx, 'humans'), told(ctx, 'lead')].map((messages) => messages.length)).toEqual([1, 1]);
  });

  test("the fix task's objective stays within its limits whatever the check printed", () => {
    const { ctx, runner } = setup();
    for (let i = 0; i < 25; i++) merge(ctx, `${i}`.padStart(40, '0'), `Task ${i}`);
    // 60 lines, within a check's tail of 4 KB.
    const long = Array.from({ length: 60 }, (_, i) => `line ${i} ${'x'.repeat(55)}`).join('\n');
    // The first merge's check comes back after 24 more merges; the newest one's then fails.
    answer(ctx, runner, { ...failed, tail: long });
    queueMainCheck(ctx);
    answer(ctx, runner, { ...failed, tail: long });
    const fix = openFixTask(ctx);
    expect(fix?.objective.length).toBeLessThanOrEqual(4_000);
    expect(fix?.objective).toContain('25 tasks, the last 20: ');
    expect(fix?.objective).toEndWith(`> line 59 ${'x'.repeat(55)}`);
  });

  test('a pass after a failure tells people, and cancels the fix task that nobody has claimed', () => {
    const { ctx, runner } = setup();
    merge(ctx, sha('a'));
    answer(ctx, runner, failed);
    const fix = openFixTask(ctx);
    merge(ctx, sha('b'), 'Print the config');
    answer(ctx, runner, passed);
    expect(getTask(ctx, fix?.id as string).status).toBe('cancelled');
    expect(told(ctx, 'humans')[0]?.body).toBe(
      `main's check passes again at ${short('b')}; it had failed since ${short('a')}. agflow cancelled ${fix?.id}, ` +
        'which nobody had started.',
    );
    expect(mainHealth(ctx)).toEqual({ status: 'passed', sha: sha('b'), at: ctx.now() });
  });

  test('a pass leaves a fix task an agent works on, and a pass with no failure before says nothing', () => {
    const { ctx, runner } = setup();
    merge(ctx, sha('a'));
    answer(ctx, runner, passed);
    expect(told(ctx, 'humans')).toEqual([]);
    merge(ctx, sha('b'), 'Print the config');
    answer(ctx, runner, failed);
    const fix = openFixTask(ctx) as NonNullable<ReturnType<typeof openFixTask>>;
    tx(ctx, (emit) => move(ctx, emit, fix, 'claimed', 'system'));
    merge(ctx, sha('c'), 'Lint the config');
    answer(ctx, runner, passed);
    expect(getTask(ctx, fix.id).status).toBe('claimed');
    expect(told(ctx, 'humans')[0]?.body).toBe(
      `main's check passes again at ${short('c')}; it had failed since ${short('b')}.`,
    );
  });
});

/** The tasks the system created. */
const createdBySystem = (ctx: HubContext) =>
  listEvents(ctx.db).filter((event) => event.type === 'task.created' && event.actor === 'system');

type Outcome = RunnerEventData['attempt.submitted'];
let seq = 0;

/** A runner agent's submission, refused or recorded as the runner reports it. */
function submit(ctx: HubContext, held: RunnerAttempt, outcome: Omit<Outcome, 'submissionId'>): void {
  ctx.db.query('UPDATE runners SET protocol = $p WHERE id = $id').run({ p: PROTOCOL_VERSION, id: held.runner.id });
  const submission = requestSubmission(ctx, held.task.id, held.agent, { summary: 'Done.', evidence: [] });
  const raw: RawRunnerEvent = {
    seq: ++seq,
    at: ctx.now(),
    type: 'attempt.submitted',
    attemptId: held.attempt.id,
    fence: getAttempt(ctx, held.attempt.id).fence,
    data: { submissionId: submission.id, ...outcome },
  };
  applyRunnerEvents(ctx, held.runner.id, { outboxEpoch: 'outbox-1', events: [raw] }, { restoreReplay: false });
}

const refusedCheck = {
  ok: false,
  headSha: sha('9'),
  remoteHead: null,
  error: 'check_failed',
  detail: `the project's check \`${command}\` exited with code 1.`,
  check: failed,
} as const;

describe('submissions while main fails', () => {
  test('an agent whose check failed hears that the fix task mends main, only while main fails', () => {
    const { ctx, runner } = setup();
    merge(ctx, sha('a'));
    answer(ctx, runner, failed);
    const fix = openFixTask(ctx);
    const hint =
      `main's own check has failed since ${short('a')}; ${fix?.id} fixes it. If the failure is not from your change, ` +
      `do not fix it in your branch: keep your change focused, and submit again after ${fix?.id} is merged (the ` +
      'runner merges the newest main before each check).';
    const heard = (held: RunnerAttempt) =>
      listMessages(ctx, {}).find((message) => message.to === `agent:${held.agent.id}`)?.body ?? '';
    const worker = addRunnerAttempt(ctx);
    submit(ctx, worker, refusedCheck);
    expect(heard(worker)).toContain(`then submit again.\n${hint}`);
    // Another refusal says nothing of main, and neither does the fix task's own.
    const dirty = addRunnerAttempt(ctx);
    submit(ctx, dirty, { ...refusedCheck, error: 'dirty', check: null });
    expect(heard(dirty)).not.toContain('own check');
    const fixer = addRunnerAttempt(ctx, { taskId: fix?.id });
    submit(ctx, fixer, refusedCheck);
    expect(heard(fixer)).not.toContain('own check');
    // Once main passes, a failed check is the agent's own.
    merge(ctx, sha('b'), 'Print the config');
    answer(ctx, runner, passed);
    const later = addRunnerAttempt(ctx);
    submit(ctx, later, refusedCheck);
    expect(heard(later)).toContain('was refused (check_failed)');
    expect(heard(later)).not.toContain('own check');
  });

  test('the hub accepts the fix task whose check passed by itself, as any other task', () => {
    const { ctx, runner } = setup({ autoAccept: true });
    merge(ctx, sha('a'));
    answer(ctx, runner, failed);
    const fix = openFixTask(ctx);
    const fixer = addRunnerAttempt(ctx, { taskId: fix?.id });
    submit(ctx, fixer, { ok: true, headSha: sha('9'), remoteHead: sha('9'), error: null, detail: null, check: passed });
    expect(getTask(ctx, fix?.id as string).status).toBe('merging');
    expect(listEvents(ctx.db, { subject: fix?.id }).map((event) => [event.type, event.actor])).toContainEqual([
      'task.accepted',
      'hub:auto-accept',
    ]);
  });
});
