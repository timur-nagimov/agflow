import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import {
  PROTOCOL_VERSION,
  type MergeTaskResult,
  type RawRunnerEvent,
  type RunnerEventData,
  type SubmissionCheck,
  type Vendor,
} from '@agflow/core';
import { getAttempt } from '../src/attempt-store';
import { startRunnerAttempt } from '../src/attempts';
import { mintAgentToken } from '../src/auth';
import { buildBrief, composeTaskPack, reviewFirstPrompt, situationReport } from '../src/brief';
import { pendingCommands, recordResult } from '../src/commands';
import { tx } from '../src/context';
import { ensureDemoCheck } from '../src/demo-check';
import { HubError } from '../src/errors';
import { listEvents } from '../src/events';
import { applyRunnerEvents } from '../src/events-in';
import { listMessages } from '../src/messages';
import { setPaused } from '../src/project';
import {
  REVIEW_FINISH_MS,
  REVIEW_START_MS,
  expireReviews,
  readVerdict,
  reviewTarget,
  tasksUnderReview,
} from '../src/review';
import { runTick, workerLoad } from '../src/scheduler';
import { findSubmission, listSubmissions } from '../src/submission-store';
import { requestSubmission } from '../src/submissions';
import { getTask, listTasks, move } from '../src/task-store';
import { acceptTask, blockTask, cancelTask, claimTask, createTasks, creationGuard } from '../src/tasks';
import { type RunnerAttempt, addAgent, addRunner, addRunnerAttempt, markHubAlive, newTask } from './helpers';
import { createTestHub } from './http-helpers';

type Hub = ReturnType<typeof createTestHub>;
type Outcome = RunnerEventData['attempt.submitted'];

const sha = (char: string) => char.repeat(40);
const work = { summary: 'Parser done.\nIt reads JSON.', evidence: ['bun test: 12 pass', 'bun run parse x.json: ok'] };
const passed: SubmissionCheck = { status: 'passed', command: 'bun test', durationMs: 4_200, tail: '12 pass\n0 fail' };
const noCheck: SubmissionCheck = { status: 'none', command: null, durationMs: 0, tail: '' };
const findings = 'The parser drops the last line: `printf "a\\nb" | bun run parse` prints only a.';

let seq = 0;

/** The runner reports the outcome of the attempt's submission, as attempt.submitted, and the hub takes it whole. */
function report(hub: Hub, held: RunnerAttempt, outcome: Outcome): void {
  const raw: RawRunnerEvent = {
    seq: ++seq,
    at: hub.ctx.now(),
    type: 'attempt.submitted',
    attemptId: held.attempt.id,
    fence: getAttempt(hub.ctx, held.attempt.id).fence,
    data: outcome,
  };
  applyRunnerEvents(hub.ctx, held.runner.id, { outboxEpoch: 'outbox-1', events: [raw] }, { restoreReplay: false });
  expect(hub.ctx.db.query('SELECT error FROM runner_event_rejects').all()).toEqual([]);
}

/** The author's submission, pushed at head with the check; gives its id. */
function submit(hub: Hub, held: RunnerAttempt, check: SubmissionCheck = passed, head = sha('a')): string {
  hub.ctx.db.query('UPDATE runners SET protocol = $p WHERE id = $id').run({ p: PROTOCOL_VERSION, id: held.runner.id });
  const submission = requestSubmission(hub.ctx, held.task.id, held.agent, work);
  const outcome = { ok: true, headSha: head, remoteHead: head, error: null, detail: null, check };
  report(hub, held, { submissionId: submission.id, ...outcome });
  return submission.id;
}

/** The review of the task, or null when it has none. */
const reviewOf = (hub: Hub, taskId: string) =>
  listTasks(hub.ctx).find((task) => reviewTarget(hub.ctx, task.id)?.taskId === taskId) ?? null;

/** A runner author's first green submission, which went to a review; gives the author, the submission and the review. */
function reviewed(hub: Hub, options: { vendor?: Vendor } = {}) {
  const held = addRunnerAttempt(hub.ctx, options);
  const submissionId = submit(hub, held);
  const review = reviewOf(hub, held.task.id);
  if (!review) throw new Error('no review was created');
  return { held, submissionId, review };
}

/** A reviewer's attempt, started as the scheduler starts one, on a new runner of the vendor. */
function startReview(hub: Hub, reviewId: string, vendor: Vendor = 'codex') {
  const runnerId = addRunner(hub.ctx, { vendors: [vendor] });
  hub.ctx.db.query('UPDATE runners SET protocol = $p WHERE id = $id').run({ p: PROTOCOL_VERSION, id: runnerId });
  return { runnerId, ...startRunnerAttempt(hub.ctx, { runnerId, taskId: reviewId, role: 'worker', vendor }) };
}

type Reviewer = ReturnType<typeof startReview>;

/** The reviewer's submit. */
const verdict = (hub: Hub, reviewer: Reviewer, summary: string) =>
  requestSubmission(hub.ctx, reviewer.attempt.taskId as string, reviewer.agent, { summary, evidence: ['ran bun test'] });

/** A runner attempt at a new task with the title, which the actor created. */
function attemptAt(hub: Hub, title: string, actor = 'user:alice'): RunnerAttempt {
  return addRunnerAttempt(hub.ctx, { taskId: createTasks(hub.ctx, [newTask({ title })], actor)[0]?.id });
}

/** The pending merge of the task, which its author's runner gets, lands in main or conflicts. */
function mergeResult(hub: Hub, held: RunnerAttempt, data: MergeTaskResult): void {
  const merge = pendingCommands(hub.ctx, held.runner.id, PROTOCOL_VERSION).find(
    (row) => row.command.kind === 'merge_task' && row.command.taskId === held.task.id,
  );
  if (!merge) throw new Error(`no merge of ${held.task.id} is pending`);
  recordResult(hub.ctx, held.runner.id, { commandId: merge.id, ok: true, data });
}

const kinds = (hub: Hub, runnerId: string) => pendingCommands(hub.ctx, runnerId, PROTOCOL_VERSION).map((row) => row.kind);
const toLead = (hub: Hub) => listMessages(hub.ctx, {}).filter((message) => message.to === 'lead');
const taskEvents = (hub: Hub, taskId: string) =>
  listEvents(hub.ctx.db, { subject: taskId }).filter((event) => event.type.startsWith('task.'));
const accepted = (hub: Hub, taskId: string) => taskEvents(hub, taskId).filter((event) => event.type === 'task.accepted');

let quiet: ReturnType<typeof spyOn> | null = null;
beforeEach(() => {
  quiet = spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => quiet?.mockRestore());

describe('AGFLOW_REVIEW: creating the review', () => {
  test('a first green submission gets a review instead of the accept; the task stays submitted, its author holding', () => {
    const hub = createTestHub({ autoAccept: true, review: true });
    const { held, submissionId, review } = reviewed(hub);
    expect(getTask(hub.ctx, held.task.id).status).toBe('submitted');
    expect(getAttempt(hub.ctx, held.attempt.id).status).toBe('holding');
    expect(review).toMatchObject({
      title: `Review of ${held.task.id} (${submissionId}): Do the thing`,
      kind: 'review',
      priority: 1,
      tier: 'strong',
      ownedPaths: [],
      dependsOn: [],
      createdBy: 'system',
      status: 'ready',
    });
    expect(review.objective.length).toBeLessThanOrEqual(4000);
    for (const words of ['VERDICT: accept with follow-ups', 'git diff origin/main...HEAD', 'send_message']) {
      expect(review.objective).toContain(words);
    }
    expect(accepted(hub, held.task.id)).toEqual([]);
    expect(toLead(hub)).toEqual([]);
    expect(tasksUnderReview(hub.ctx)).toEqual(new Map([[held.task.id, review.id]]));
    // The title is clipped to the schema's limit.
    const long = attemptAt(hub, 't'.repeat(200));
    submit(hub, long);
    expect(reviewOf(hub, long.task.id)?.title).toHaveLength(200);
  });

  test("the review starts at the submitted head; its pack holds the task's pack, the author's words, the neighbours", () => {
    const hub = createTestHub({ autoAccept: true, review: true });
    const finish = (status: 'merged' | 'submitted') => {
      const contract = newTask({ title: `A ${status} neighbour`, ownedPaths: ['src/lexer/**'] });
      const [task] = createTasks(hub.ctx, [contract], 'user:bob');
      tx(hub.ctx, (emit) => {
        const claimed = move(hub.ctx, emit, getTask(hub.ctx, task?.id as string), 'claimed', 'system');
        const submitted = move(hub.ctx, emit, claimed, 'submitted', 'system');
        if (status === 'submitted') return;
        move(hub.ctx, emit, move(hub.ctx, emit, submitted, 'accepted', 'user:bob'), 'merged', 'user:bob');
      });
      return task?.id as string;
    };
    const before = finish('merged');
    const held = addRunnerAttempt(hub.ctx);
    const merged = finish('merged');
    const waiting = finish('submitted');
    submit(hub, held);
    const review = reviewOf(hub, held.task.id);
    if (!review) throw new Error('no review');
    expect(review).toMatchObject({ workRef: `refs/heads/${held.task.branch}`, workSha: sha('a') });
    const { command } = startReview(hub, review.id);
    if (command.command.kind !== 'start_attempt') throw new Error('not a start');
    const spec = command.command.attempt;
    expect(spec.start).toEqual({ ref: `refs/heads/${held.task.branch}`, sha: sha('a') });
    expect(spec.tier).toBe('strong');
    const pack = spec.taskPack;
    expect(pack).toStartWith(composeTaskPack(getTask(hub.ctx, review.id)));
    expect(pack).toEndWith(composeTaskPack(getTask(hub.ctx, held.task.id)));
    expect(pack).toContain("## The author's summary\n> Parser done.\n> It reads JSON.");
    expect(pack).toContain("## The author's evidence\n> bun test: 12 pass\n> bun run parse x.json: ok");
    expect(pack).toContain("The runner's check `bun test` passed in 4 s, with main merged in. Do not run it again.");
    expect(pack).toContain(`- ${merged} [merged] "A merged neighbour"; owns src/lexer/**`);
    expect(pack).toContain(`- ${waiting} [submitted] "A submitted neighbour"`);
    expect(pack).not.toContain(`- ${before} `);
    expect(pack).not.toContain(`- ${held.task.id} `);
  });

  test("the vendor hint is the author's other vendor, only while an online runner that is not draining offers it", () => {
    const hub = createTestHub({ autoAccept: true, review: true });
    expect(reviewed(hub).review.vendorHint).toBeUndefined();
    const codex = addRunner(hub.ctx, { vendors: ['codex'] });
    expect(reviewed(hub).review.vendorHint).toBe('codex');
    hub.ctx.db.query('UPDATE runners SET draining = 1 WHERE id = $id').run({ id: codex });
    expect(reviewed(hub).review.vendorHint).toBeUndefined();
    hub.ctx.db.query("UPDATE runners SET draining = 0, state = 'offline' WHERE id = $id").run({ id: codex });
    expect(reviewed(hub).review.vendorHint).toBeUndefined();
    // A Codex author's work goes to Claude, which the earlier authors' runners offer.
    expect(reviewed(hub, { vendor: 'codex' }).review.vendorHint).toBe('claude');
  });

  test('system tasks are not reviewed, nor is anything with review or auto accept off', () => {
    const off = createTestHub({ autoAccept: true });
    const plain = addRunnerAttempt(off.ctx);
    submit(off, plain);
    expect(getTask(off.ctx, plain.task.id).status).toBe('accepted');
    expect(reviewOf(off, plain.task.id)).toBeNull();

    const lead = createTestHub({ review: true });
    const waits = addRunnerAttempt(lead.ctx);
    submit(lead, waits);
    expect(getTask(lead.ctx, waits.task.id).status).toBe('submitted');
    expect(reviewOf(lead, waits.task.id)).toBeNull();
    expect(toLead(lead)).toHaveLength(1);

    const hub = createTestHub({ autoAccept: true, review: true });
    const [fix] = createTasks(hub.ctx, [newTask({ title: 'Fix main: the check fails after T-9' })], 'system');
    const system = addRunnerAttempt(hub.ctx, { taskId: fix?.id });
    submit(hub, system);
    expect(getTask(hub.ctx, system.task.id).status).toBe('accepted');
    expect(reviewOf(hub, system.task.id)).toBeNull();
    // A check that ran nothing goes to the lead as before.
    const unchecked = addRunnerAttempt(hub.ctx);
    submit(hub, unchecked, noCheck);
    expect(reviewOf(hub, unchecked.task.id)).toBeNull();
  });

  test('a review the task limits refuse, or whose creation throws, leaves the accept as before; the event stands', () => {
    const hub = createTestHub({ autoAccept: true, review: true, maxTasksPerHour: 1 });
    const held = addRunnerAttempt(hub.ctx);
    const submissionId = submit(hub, held);
    expect(getTask(hub.ctx, held.task.id).status).toBe('accepted');
    expect(reviewOf(hub, held.task.id)).toBeNull();
    expect(findSubmission(hub.ctx, submissionId)?.status).toBe('submitted');
    // The hub asked first: no safety limit tripped, and nobody was told.
    expect(listEvents(hub.ctx.db, {}).filter((event) => event.type === 'guard.tripped')).toEqual([]);
    expect(listMessages(hub.ctx, {})).toEqual([]);

    const broken = createTestHub({ autoAccept: true, review: true });
    broken.ctx.db.run(
      `CREATE TRIGGER no_reviews BEFORE INSERT ON tasks WHEN NEW.created_by = 'system'
       BEGIN SELECT RAISE(ABORT, 'no reviews'); END`,
    );
    const other = addRunnerAttempt(broken.ctx);
    const recorded = submit(broken, other);
    expect(getTask(broken.ctx, other.task.id).status).toBe('accepted');
    expect(findSubmission(broken.ctx, recorded)?.status).toBe('submitted');
    expect(listTasks(broken.ctx)).toHaveLength(1);
    expect(quiet).toHaveBeenCalled();
  });
});

describe('AGFLOW_REVIEW: the verdict', () => {
  test('accept: the task is accepted by hub:review and merges; the review is cancelled, never pushed or counted', () => {
    const hub = createTestHub({ autoAccept: true, review: true, autoMerge: true });
    const { held, review } = reviewed(hub);
    const reviewer = startReview(hub, review.id);
    const recorded = verdict(hub, reviewer, '  **Verdict: Accept**  \n');
    expect(recorded).toMatchObject({ status: 'submitted', taskId: review.id, headSha: null });
    expect(getTask(hub.ctx, held.task.id).status).toBe('merging');
    expect(accepted(hub, held.task.id).map((event) => event.actor)).toEqual(['hub:review']);
    const merges = pendingCommands(hub.ctx, held.runner.id, PROTOCOL_VERSION).filter((row) => row.kind === 'merge_task');
    expect(merges.map((row) => row.command.kind === 'merge_task' && row.command.taskId)).toEqual([held.task.id]);
    expect(getTask(hub.ctx, review.id).status).toBe('cancelled');
    const reviewEvents = taskEvents(hub, review.id).map((event) => event.type);
    expect(reviewEvents).toEqual(['task.created', 'task.claimed', 'task.cancelled']);
    expect(taskEvents(hub, review.id).at(-1)?.data.reason).toBe('review done: accept');
    expect(kinds(hub, reviewer.runnerId)).toContain('stop_attempt');
    expect(kinds(hub, reviewer.runnerId)).not.toContain('push_submission');
    expect(workerLoad(hub.ctx)).toMatchObject({ submitted: 0, acceptedNotMerged: 1 });
    expect(toLead(hub)).toEqual([]);
    // The merge lands: the task counts as done, the review never does.
    mergeResult(hub, held, { status: 'merged', sha: sha('f') });
    expect(getTask(hub.ctx, held.task.id).status).toBe('merged');
    expect(taskEvents(hub, review.id).map((event) => event.type)).not.toContain('task.merged');
  });

  test('accept with follow-ups: the task is accepted the same, and the lead gets one message with them', () => {
    const hub = createTestHub({ autoAccept: true, review: true });
    const { held, review } = reviewed(hub);
    const reviewer = startReview(hub, review.id);
    const followUps = '- The help text names an old flag.\n- No test covers an empty file.';
    verdict(hub, reviewer, `VERDICT: accept with follow-ups\n${followUps}`);
    expect(getTask(hub.ctx, held.task.id).status).toBe('accepted');
    expect(accepted(hub, held.task.id).map((event) => event.actor)).toEqual(['hub:review']);
    const told = toLead(hub);
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ from: 'system', taskId: held.task.id });
    expect(told[0]?.body).toContain(`${review.id} reviewed ${held.task.id} ("Do the thing"), and the hub accepted it.`);
    expect(told[0]?.body).toContain(
      `${reviewer.agent.id} wrote:\n> - The help text names an old flag.\n> - No test covers an empty file.`,
    );
    expect(getTask(hub.ctx, review.id).status).toBe('cancelled');
  });

  test('reject: the task goes back to its author with the findings, in the same session', () => {
    const hub = createTestHub({ autoAccept: true, review: true });
    const { held, submissionId, review } = reviewed(hub);
    const reviewer = startReview(hub, review.id);
    verdict(hub, reviewer, `VERDICT: reject\n${findings}`);
    const task = getTask(hub.ctx, held.task.id);
    expect(task).toMatchObject({ status: 'claimed', assignee: held.agent.id, currentAttempt: held.attempt.id });
    expect(task.feedback).toBe(`${review.id}, the review of submission ${submissionId}, found:\n${findings}`);
    expect(taskEvents(hub, held.task.id).map((event) => [event.type, event.actor]).slice(-2)).toEqual([
      ['task.rejected', 'hub:review'],
      ['task.returned', 'system'],
    ]);
    expect(getAttempt(hub.ctx, held.attempt.id)).toMatchObject({ status: 'starting', reviewRounds: 1 });
    const resume = pendingCommands(hub.ctx, held.runner.id, PROTOCOL_VERSION).find((row) => row.kind === 'resume_attempt');
    expect(resume?.command.kind === 'resume_attempt' && resume.command.prompt).toContain(`> ${findings}`);
    expect(getTask(hub.ctx, review.id).status).toBe('cancelled');
  });

  test('a summary with no verdict line, or a reject with no findings, is refused with the format', async () => {
    const hub = createTestHub({ autoAccept: true, review: true });
    const { held, review } = reviewed(hub);
    const reviewer = startReview(hub, review.id);
    const events = () => (hub.ctx.db.query('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n;
    const before = events();
    const refused = ['Looks good.', 'VERDICT: maybe', 'The verdict: accept', 'VERDICT: reject', 'VERDICT: reject\n \n'];
    for (const summary of refused) {
      let refusal: unknown = null;
      try {
        verdict(hub, reviewer, summary);
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(HubError);
      expect((refusal as HubError).status).toBe(400);
      expect((refusal as HubError).message).toMatch(/VERDICT: (accept with follow-ups|reject)/);
    }
    expect(events()).toBe(before);
    expect(listSubmissions(hub.ctx, review.id)).toEqual([]);
    expect(getTask(hub.ctx, review.id).status).toBe('claimed');
    expect(getTask(hub.ctx, held.task.id).status).toBe('submitted');
    // The bridge reads the refusal as the hub's words, and the agent tries again.
    const token = mintAgentToken(hub.ctx, reviewer.attempt);
    const answer = await hub.call('POST', `/api/tasks/${review.id}/submit`, {
      headers: { authorization: `Bearer ${token}` },
      body: { summary: 'All fine.', evidence: [] },
    });
    expect(answer.status).toBe(400);
    expect(answer.json.message).toContain(
      'exactly `VERDICT: accept`, `VERDICT: accept with follow-ups` or `VERDICT: reject`',
    );
    const decided = await hub.call('POST', `/api/tasks/${review.id}/submit`, {
      headers: { authorization: `Bearer ${token}` },
      body: { summary: 'VERDICT: accept', evidence: [] },
    });
    expect(decided.status).toBe(202);
    expect(decided.json.submission).toMatchObject({ status: 'submitted', taskId: review.id });
    expect(getTask(hub.ctx, held.task.id).status).toBe('accepted');
  });

  test('the verdict line is read whatever its whitespace, emphasis and case', () => {
    expect(readVerdict('VERDICT: accept')).toEqual({ verdict: 'accept', rest: '' });
    expect(readVerdict('\n  **verdict:  ACCEPT**\n\nnothing to add')).toEqual({ verdict: 'accept', rest: 'nothing to add' });
    const followUps = { verdict: 'accept with follow-ups', rest: '- one' } as const;
    expect(readVerdict('`VERDICT: accept with follow-ups`\n- one')).toEqual(followUps);
    expect(readVerdict('_Verdict_: accept with followups.\n- one')?.verdict).toBe('accept with follow-ups');
    expect(readVerdict('# VERDICT: reject\nx')).toBeNull();
    expect(readVerdict('VERDICT: accept, mostly')).toBeNull();
  });

  test('a verdict on a task decided meanwhile is dropped: the review closes, the task is untouched', () => {
    const hub = createTestHub({ autoAccept: true, review: true });
    const { held, review } = reviewed(hub);
    const reviewer = startReview(hub, review.id);
    acceptTask(hub.ctx, held.task.id, 'user:alice', 'I read it myself');
    verdict(hub, reviewer, `VERDICT: reject\n${findings}`);
    expect(getTask(hub.ctx, held.task.id)).toMatchObject({ status: 'accepted', feedback: null });
    expect(taskEvents(hub, held.task.id).map((event) => event.type)).not.toContain('task.rejected');
    expect(getTask(hub.ctx, review.id).status).toBe('cancelled');
  });

  test("the next green submission is accepted as before: after a review's rejection, and after a merge conflict", () => {
    const hub = createTestHub({ autoAccept: true, review: true, autoMerge: true });
    const { held, review } = reviewed(hub);
    verdict(hub, startReview(hub, review.id), `VERDICT: reject\n${findings}`);
    expect(getTask(hub.ctx, held.task.id).status).toBe('claimed');
    submit(hub, held, passed, sha('b'));
    expect(getTask(hub.ctx, held.task.id).status).toBe('merging');
    expect(accepted(hub, held.task.id).map((event) => event.actor)).toEqual(['hub:auto-accept']);
    // One merge goes out at a time: this one lands before the next task's.
    mergeResult(hub, held, { status: 'merged', sha: sha('f') });
    expect(getTask(hub.ctx, held.task.id).status).toBe('merged');

    const second = reviewed(hub);
    verdict(hub, startReview(hub, second.review.id), 'VERDICT: accept');
    mergeResult(hub, second.held, { status: 'conflict', files: ['src/parser.ts'] });
    expect(getTask(hub.ctx, second.held.task.id).status).toBe('claimed');
    submit(hub, second.held, passed, sha('c'));
    expect(getTask(hub.ctx, second.held.task.id).status).toBe('merging');
    expect(accepted(hub, second.held.task.id).map((event) => event.actor)).toEqual(['hub:review', 'hub:auto-accept']);
    // One review per task, ever.
    const reviews = listTasks(hub.ctx).filter((task) => task.kind === 'review');
    expect(reviews.map((task) => reviewTarget(hub.ctx, task.id)?.taskId)).toEqual([held.task.id, second.held.task.id]);
  });
});

describe('AGFLOW_REVIEW: a review that does not finish', () => {
  test('one that has not started 5 minutes after it was created lets the hub accept as before', () => {
    const hub = createTestHub({ autoAccept: true, review: true });
    const { held, review } = reviewed(hub);
    hub.clock.advance(REVIEW_START_MS - 1);
    expect(expireReviews(hub.ctx)).toBe(0);
    hub.clock.advance(1);
    expect(expireReviews(hub.ctx)).toBe(1);
    expect(getTask(hub.ctx, held.task.id).status).toBe('accepted');
    const [accept] = accepted(hub, held.task.id);
    expect([accept?.actor, accept?.data.note]).toEqual(['hub:auto-accept', 'its check passed; its review did not finish']);
    expect(getTask(hub.ctx, review.id).status).toBe('cancelled');
    expect(taskEvents(hub, review.id).at(-1)?.data.reason).toContain('did not start within 5 minutes');
    expect(expireReviews(hub.ctx)).toBe(0);
  });

  test('one with no verdict 20 minutes after it was created lets the hub accept as before, and its agent is stopped', () => {
    const hub = createTestHub({ autoAccept: true, review: true });
    const { held, review } = reviewed(hub);
    const reviewer = startReview(hub, review.id);
    hub.clock.advance(REVIEW_FINISH_MS - 1);
    expect(expireReviews(hub.ctx)).toBe(0);
    expect(getTask(hub.ctx, held.task.id).status).toBe('submitted');
    hub.clock.advance(1);
    expect(expireReviews(hub.ctx)).toBe(1);
    expect(accepted(hub, held.task.id).map((event) => event.actor)).toEqual(['hub:auto-accept']);
    expect(getTask(hub.ctx, review.id).status).toBe('cancelled');
    expect(kinds(hub, reviewer.runnerId)).toContain('stop_attempt');
  });

  test('one closed without a verdict or blocked lets the hub accept; one whose task was decided is cancelled', () => {
    const hub = createTestHub({ autoAccept: true, review: true });
    const cancelled = reviewed(hub);
    cancelTask(hub.ctx, cancelled.review.id, 'not worth it', 'user:alice');
    const blocked = reviewed(hub);
    const reviewer = startReview(hub, blocked.review.id);
    blockTask(hub.ctx, blocked.review.id, reviewer.agent, 'the clone has no SPEC.md');
    expect(getTask(hub.ctx, blocked.review.id).status).toBe('blocked');
    const decided = reviewed(hub);
    acceptTask(hub.ctx, decided.held.task.id, 'user:alice');
    expect(expireReviews(hub.ctx)).toBe(3);
    for (const { held } of [cancelled, blocked]) {
      expect(accepted(hub, held.task.id).map((event) => event.actor)).toEqual(['hub:auto-accept']);
    }
    expect(accepted(hub, decided.held.task.id).map((event) => event.actor)).toEqual(['user:alice']);
    for (const { review } of [cancelled, blocked, decided]) expect(getTask(hub.ctx, review.id).status).toBe('cancelled');
    expect(expireReviews(hub.ctx)).toBe(0);
  });

  test('the tick does nothing of it while the project is paused, and settles it once the project runs', () => {
    const hub = createTestHub({ autoAccept: true, review: true });
    const { held, review } = reviewed(hub);
    setPaused(hub.ctx, true, 'user:alice');
    hub.clock.advance(REVIEW_FINISH_MS + 60_000);
    markHubAlive(hub.ctx);
    runTick(hub.ctx);
    expect(getTask(hub.ctx, held.task.id).status).toBe('submitted');
    expect(getTask(hub.ctx, review.id).status).toBe('ready');
    setPaused(hub.ctx, false, 'user:alice');
    markHubAlive(hub.ctx);
    runTick(hub.ctx);
    expect(getTask(hub.ctx, held.task.id).status).toBe('accepted');
    expect(getTask(hub.ctx, review.id).status).toBe('cancelled');
  });
});

describe('AGFLOW_REVIEW: what else sees a review', () => {
  test("the review stays out of the hourly limit, the demo check's count and the lead's accepted and awaiting lists", () => {
    const hub = createTestHub({ autoAccept: true, review: true, autoMerge: true, maxTasksPerHour: 2, demoCheckEvery: 1 });
    const { held, review } = reviewed(hub);
    // The author's task counts, the system's review does not.
    expect(creationGuard(hub.ctx, 1)).toBeNull();
    expect(creationGuard(hub.ctx, 2)).toContain('new tasks per hour');
    const waiting = attemptAt(hub, 'Lint', 'system');
    submit(hub, waiting, noCheck);
    let report = situationReport(hub.ctx);
    expect(report).toContain(`Awaiting your review:\n- ${waiting.task.id} "Lint"`);
    expect(report).not.toContain(`- ${held.task.id} "`);
    expect(report).toContain(`Under review by agents: ${held.task.id} (by ${review.id}).`);
    verdict(hub, startReview(hub, review.id), 'VERDICT: accept');
    report = situationReport(hub.ctx);
    expect(report).toContain(`Accepted by the hub since your last wake-up, their check passed: ${held.task.id} "Do the`);
    expect(report).not.toContain('Under review by agents');
    expect(report).not.toContain(`${review.id} "`);
    mergeResult(hub, held, { status: 'merged', sha: sha('f') });
    expect(ensureDemoCheck(hub.ctx)?.title).toBe('Demo check after 1 task');
  });

  test('a live chat cannot claim a review', () => {
    const hub = createTestHub({ autoAccept: true, review: true });
    const { review } = reviewed(hub);
    const refusal = `${review.id} is a review, which only runner agents take`;
    expect(() => claimTask(hub.ctx, review.id, addAgent(hub.ctx))).toThrow(refusal);
    expect(getTask(hub.ctx, review.id).status).toBe('ready');
  });

  test("the reviewer's brief, task section and first prompt send it to read and run, never to commit or merge", () => {
    const hub = createTestHub({ autoAccept: true, review: true });
    const { submissionId, held, review } = reviewed(hub);
    const reviewer = startReview(hub, review.id);
    if (reviewer.command.command.kind !== 'start_attempt') throw new Error('not a start');
    const { brief, firstPrompt } = reviewer.command.command.attempt;
    expect(brief).toBe(buildBrief(hub.ctx, reviewer.agent));
    expect(brief).toContain('change, commit and push nothing, do not merge main, do not run the project\'s check again');
    expect(brief).toContain(`You review ${held.task.id}'s submission ${submissionId}, at whose head your clone is;`);
    for (const told of [brief, firstPrompt]) {
      expect(told).not.toContain('commit on this branch');
      expect(told).not.toContain('commit as you go');
      expect(told).not.toContain("merge origin's main");
    }
    expect(firstPrompt).toBe(reviewFirstPrompt({ taskId: held.task.id, submissionId }));
    expect(firstPrompt).toContain('finish with `submit`, the first line of its summary your verdict');
    // The author's own brief is the worker's, as before.
    expect(buildBrief(hub.ctx, held.agent)).toContain('commit on this branch');
  });

  test("the lead's guide says that agents review first green submissions, only while review and auto accept are on", () => {
    const line =
      "- An agent of the other vendor reviews each task's first green submission before the hub accepts it; its " +
      'rejections go back to the author, and its follow-ups and questions come to you.';
    const guide = (config: { autoAccept?: boolean; review?: boolean; autoMerge?: boolean }) => {
      const hub = createTestHub(config);
      const lead = addAgent(hub.ctx, 'alice', 'lead');
      return buildBrief(hub.ctx, lead);
    };
    expect(guide({ autoAccept: true, review: true, autoMerge: true })).toContain(
      `come to you with the others.\n${line}\n- agflow merges accepted work into main itself`,
    );
    expect(guide({ review: true })).not.toContain(line);
    expect(guide({ autoAccept: true })).not.toContain(line);
  });
});
