import { describe, expect, test } from 'bun:test';
import { PROTOCOL_VERSION, type RawRunnerEvent, type RunnerEventData, type SubmissionCheck } from '@agflow/core';
import { getAttempt } from '../src/attempt-store';
import { mintAgentToken } from '../src/auth';
import { situationReport } from '../src/brief';
import { pendingCommands, recordResult } from '../src/commands';
import { listEvents } from '../src/events';
import { applyRunnerEvents } from '../src/events-in';
import { listMessages } from '../src/messages';
import { findSubmission } from '../src/submission-store';
import { requestSubmission } from '../src/submissions';
import { getTask } from '../src/task-store';
import { type RunnerAttempt, addRunnerAttempt, addRunnerLead } from './helpers';
import { createTestHub } from './http-helpers';

type Hub = ReturnType<typeof createTestHub>;
type Outcome = RunnerEventData['attempt.submitted'];

const sha = (char: string) => char.repeat(40);
const work = { summary: 'Parser done.', evidence: ['bun test: 12 pass'] };
const passed: SubmissionCheck = { status: 'passed', command: 'bun test', durationMs: 4_200, tail: '12 pass\n0 fail' };
const noCheck: SubmissionCheck = { status: 'none', command: null, durationMs: 0, tail: '' };

let seq = 0;

/** The runner reports the outcome of the attempt's submission, as attempt.submitted. */
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

/** A runner agent's submission, pushed with the check; gives the attempt and its submission's id. */
function submit(hub: Hub, check: SubmissionCheck | null, held = addRunnerAttempt(hub.ctx)) {
  hub.ctx.db.query('UPDATE runners SET protocol = $p WHERE id = $id').run({ p: PROTOCOL_VERSION, id: held.runner.id });
  const submission = requestSubmission(hub.ctx, held.task.id, held.agent, work);
  report(hub, held, {
    submissionId: submission.id,
    ok: true,
    headSha: sha('a'),
    remoteHead: sha('a'),
    error: null,
    detail: null,
    check,
  });
  return { held, submissionId: submission.id };
}

const toLead = (hub: Hub) => listMessages(hub.ctx, {}).filter((message) => message.to === 'lead');

describe('AGFLOW_AUTO_ACCEPT', () => {
  test('accepts a submission whose check passed as it is recorded, as hub:auto-accept, and does not wake the lead', () => {
    const hub = createTestHub({ autoAccept: true });
    const { held } = submit(hub, passed);
    expect(getTask(hub.ctx, held.task.id).status).toBe('accepted');
    const types = listEvents(hub.ctx.db, { subject: held.task.id }).map((event) => [event.type, event.actor]);
    expect(types).toContainEqual(['task.accepted', 'hub:auto-accept']);
    expect(types.findIndex(([type]) => type === 'submission.recorded')).toBeLessThan(
      types.findIndex(([type]) => type === 'task.accepted'),
    );
    expect(getAttempt(hub.ctx, held.attempt.id)).toMatchObject({ status: 'ended', endReason: 'accepted' });
    expect(toLead(hub)).toEqual([]);
  });

  test('with auto merge too, the accepted task goes on to merging and its merge goes out', () => {
    const hub = createTestHub({ autoAccept: true, autoMerge: true });
    const { held } = submit(hub, passed);
    expect(getTask(hub.ctx, held.task.id).status).toBe('merging');
    const merge = pendingCommands(hub.ctx, held.runner.id, PROTOCOL_VERSION).find((row) => row.kind === 'merge_task');
    expect(merge?.command).toMatchObject({ kind: 'merge_task', taskId: held.task.id, headSha: sha('a') });
    recordResult(hub.ctx, held.runner.id, { commandId: merge?.id as string, ok: true, data: { status: 'merged', sha: sha('f') } });
    expect(getTask(hub.ctx, held.task.id)).toMatchObject({ status: 'merged', mergedSha: sha('f') });
    expect(toLead(hub)).toEqual([]);
  });

  test('a submission with no check goes to the lead as before, with what the check gave', () => {
    const hub = createTestHub({ autoAccept: true });
    const { held } = submit(hub, noCheck);
    expect(getTask(hub.ctx, held.task.id).status).toBe('submitted');
    const [told] = toLead(hub);
    expect(told?.body).toContain('No check ran: .agflow/config.json on main names none.');
    const older = submit(hub, null);
    expect(getTask(hub.ctx, older.held.task.id).status).toBe('submitted');
  });

  test("without it, the lead reviews a submission whose check passed, and its message names the check", () => {
    const hub = createTestHub();
    const { held } = submit(hub, passed);
    expect(getTask(hub.ctx, held.task.id).status).toBe('submitted');
    expect(toLead(hub)[0]?.body).toContain("The runner's check `bun test` passed in 4 s.");
  });

  test("the lead's situation report names the tasks the hub accepted since its last wake-up", async () => {
    const hub = createTestHub({ autoAccept: true });
    const lead = addRunnerLead(hub.ctx);
    const first = submit(hub, passed);
    expect(situationReport(hub.ctx)).toContain(
      `Accepted by the hub since your last wake-up, their check passed: ${first.held.task.id} "Do the thing".`,
    );
    // The lead wakes: a delivery goes out, and the next report starts from there.
    hub.ctx.db
      .query(
        `INSERT INTO runner_commands (id, runner_id, hub_epoch, seq, kind, attempt_id, payload, status, created_at)
         VALUES ('1-R-9-1', $runnerId, 1, 99, 'deliver', $attemptId, '{}', 'done', $now)`,
      )
      .run({ runnerId: lead.attempt.runnerId, attemptId: lead.attempt.id, now: hub.ctx.now() });
    hub.clock.advance(1_000);
    expect(situationReport(hub.ctx)).not.toContain('Accepted by the hub');
    const second = submit(hub, passed);
    const report = situationReport(hub.ctx);
    expect(report).toContain(`their check passed: ${second.held.task.id} "Do the thing".`);
    expect(report).not.toContain(`${first.held.task.id} "`);
  });
});

describe("the runner's check of a submission", () => {
  test('is stored with the submission, and fetch_submission and the submission poll show it', async () => {
    const hub = createTestHub();
    const lead = addRunnerLead(hub.ctx);
    const { held, submissionId } = submit(hub, passed);
    expect(findSubmission(hub.ctx, submissionId)?.check).toEqual(passed);
    const token = mintAgentToken(hub.ctx, held.attempt);
    const polled = await hub.call('GET', `/api/submissions/${submissionId}`, { headers: { authorization: `Bearer ${token}` } });
    expect(polled.json.submission.check).toEqual(passed);
    const auth = { headers: { authorization: `Bearer ${mintAgentToken(hub.ctx, lead.attempt)}` } };
    const fetched = await hub.call('POST', '/api/fetch-submission', { ...auth, body: { task_id: held.task.id } });
    expect(fetched.json.request).toMatchObject({ status: 'pending', head_sha: sha('a'), check: passed });
  });

  test('a failed check refuses the submission back to the agent, which hears the end of its output', () => {
    const hub = createTestHub({ autoAccept: true });
    const held = addRunnerAttempt(hub.ctx);
    const submission = requestSubmission(hub.ctx, held.task.id, held.agent, work);
    const failed: SubmissionCheck = { status: 'failed', command: 'bun test', durationMs: 900, tail: '1 fail' };
    report(hub, held, {
      submissionId: submission.id,
      ok: false,
      headSha: sha('a'),
      remoteHead: null,
      error: 'check_failed',
      detail: "the project's check `bun test` exited with code 1. The last lines of its output:\n1 fail",
      check: failed,
    });
    expect(findSubmission(hub.ctx, submission.id)).toMatchObject({ status: 'failed', check: failed });
    expect(findSubmission(hub.ctx, submission.id)?.error).toStartWith('check_failed: ');
    expect(getTask(hub.ctx, held.task.id).status).toBe('claimed');
    const told = listMessages(hub.ctx, {}).find((message) => message.to === `agent:${held.agent.id}`);
    expect(told?.body).toContain('was refused (check_failed)');
    expect(told?.body).toContain('> 1 fail');
  });
});
