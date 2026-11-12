// Exit scenario 3, the lost lead (design 1, 6.5, 6.7, 6.11, 10). With runner leads on, the scheduler seats a runner
// lead, which writes a lead handoff and goes idle. The harness freezes the lead's runner, and while it is frozen a
// person messages the lead. When the lease runs out, the lead attempt ends lost and the seat empties; a new lead
// starts on another runner from that handoff and also receives the person's message, which the frozen lead never
// acknowledged. A worker then submits a task created after the failover, and the new lead accepts it. After the thaw
// the old runner stops the old lead's process and pushes nothing for it: leads have no WIP.
import {
  attemptId,
  type AttemptLogEntry,
  type HubEvent,
  type LeadNote,
  leadAttemptId,
  type NewTaskInput,
  quoteLines,
  taskBranchName,
} from '@agflow/core';
import { processIdentity, sameProcess } from '@agflow/runner/src/processes';
import { fileAt, gitIn, refSha } from '../git-fixtures';
import type { Cluster } from '../harness/cluster';
import { type Programs, react, say, shell, tool } from '../harness/playbook';
import {
  checks,
  cloneFile,
  firstRequestText,
  newestEventId,
  type Recorder,
  type ScenarioOptions,
  type ScenarioResult,
  shown,
} from './result';

/** The first lead's handoff, word for word in a scripted run. */
const LEAD_HANDOFF =
  'The plan: one small task at a time. Review each submission as it arrives, and accept it once its file is in. ' +
  'Nothing is waiting for review now.';

/** The second lead's first text, its restatement. */
const LEAD_RESTATEMENT =
  'The previous lead planned one small task at a time, and nothing waits for review. Next: review submissions as ' +
  'they arrive.';

/** What a person tells the lead while its runner is frozen; the next lead must receive it. */
const MESSAGE =
  'While your runner is away: accept the next submission once its file is in. (lost-lead message to the lead)';

/** The goal the cluster starts with: what a real lead follows in a live run. */
const GOAL = [
  "This project tests agflow's lead failover. As the lead, do only this:",
  '1. If your brief has no lead handoff from a previous lead, call write_handoff, without a task id, with the note: ' +
    `${LEAD_HANDOFF}`,
  '2. If it has one, restate the state of the project and your next step, as your first prompt asks.',
  '3. Create no tasks and staff nothing. When a task is submitted, call fetch_submission with its task_id and wait ' +
    'for success. Then run git fetch origin <submitted-branch> ' +
    'in your clone (origin is your runner vault), then read review.txt from FETCH_HEAD. Accept it with accept_task ' +
    'only after checking that review.txt holds the line review.',
].join('\n');

const TASK: NewTaskInput = {
  title: 'Add review.txt',
  objective: 'Create review.txt holding the line "review", commit it and submit.',
  acceptance: [{ id: 'file', assertion: 'review.txt holds the line review' }],
};

/** The checks lostLead makes, by name; the e2e test reads them in groups. */
const CHECKS = {
  seated: 'the scheduler seats lead-a1 on a runner, and GET /api/status shows a runner lead in the seat',
  handoff: 'GET /api/lead/notes lists the lead handoff of lead-a1',
  lost: 'after the freeze, lead-a1 ends lost, class infra',
  emptied: 'the seat empties when lead-a1 ends, and the next change seats lead-a2',
  reseated: 'lead-a2 takes the seat on another runner than lead-a1',
  brief: "lead-a2's brief quotes lead-a1's lead handoff",
  messageMoved:
    "the person's message sent during the freeze is delivered to lead-a2, and after the thaw still not to lead-a1",
  messageSeen: "lead-a2's model is shown the person's message",
  submitted: 'a worker submits the task created after the failover',
  woken: "the submission's message to the lead is delivered to lead-a2",
  reviewed: 'lead-a2 fetches the submitted branch from its vault and verifies review.txt before accepting',
  accepted: "lead-a2 accepts the task with its agent token, as the acceptance event's actor, while it holds the seat",
  oldStopped: "after the thaw, the old runner stops lead-a1's process",
  noRefs: 'the old runner pushes no ref for lead-a1: leads have no WIP',
} as const;

/** The start of the hub's message to the lead about a submission of the task (design 6.13). */
function submittedMarker(taskId: string): string {
  return `${taskId} ("${TASK.title}") was submitted by`;
}

/**
 * The programs of a scripted run: both leads, and with the task's id the worker's and lead-a2's reaction to the
 * submission. lead-a1's must be known when the cluster starts, because the scheduler seats it as soon as the first
 * runner connects.
 */
function programs(taskId?: string): Programs {
  const lead2 = leadAttemptId(2, 1);
  const known: Programs = {
    [leadAttemptId(1, 1)]: {
      steps: [say('I write my lead handoff.', tool('write_handoff', { note: LEAD_HANDOFF }))],
    },
    [lead2]: { steps: [say(LEAD_RESTATEMENT, tool('get_lead_notes'))] },
  };
  if (taskId === undefined) return known;
  const branch = taskBranchName(taskId, TASK.title, 1);
  const review = shell(
    `git fetch origin ${branch} && git show FETCH_HEAD:review.txt > .agflow/run/review-candidate && ` +
    `printf 'review\\n' | cmp -s - .agflow/run/review-candidate && ` +
    'cp .agflow/run/review-candidate .agflow/run/review-verified',
  );
  const accept = tool('accept_task', { id: taskId, note: 'review.txt is in.' });
  return {
    ...known,
    [lead2]: {
      steps: [say(LEAD_RESTATEMENT, tool('get_lead_notes'))],
      reactions: [
        react(submittedMarker(taskId), [
          say(`I fetch the submission for ${taskId}.`, tool('fetch_submission', { task_id: taskId })),
          say(`I fetch and review ${taskId}.`, review),
          say(`I accept ${taskId}.`, accept),
        ]),
      ],
    },
    [attemptId(taskId, 1, 1)]: {
      steps: [
        say(
          'I add review.txt and commit it.',
          shell("printf 'review\\n' > review.txt && git add review.txt && git commit -q -m 'Add review.txt'"),
        ),
        say('I submit the task.', tool('submit', { task_id: taskId, summary: 'review.txt holds the line review.' })),
      ],
    },
  };
}

/**
 * The goal and task for live runs, the programs for scripted runs, and the check names. The cluster must start with
 * runner leads on, this goal and, for a scripted run, programs() (startCluster's runnerLeads, goal and programs).
 */
export const LOST_LEAD = {
  scenario: 'lost lead',
  goal: GOAL,
  task: TASK,
  handoff: LEAD_HANDOFF,
  message: MESSAGE,
  programs,
  checks: CHECKS,
} as const;

/** Runs exit scenario 3 in the cluster and gives every check it made. */
export function lostLead(cluster: Cluster, options: ScenarioOptions = {}): Promise<ScenarioResult> {
  return checks(LOST_LEAD.scenario, cluster.vendor, (record) => drive(cluster, options, record));
}

/** Every ref of the origin with its sha, one "<ref> <sha>" line each. */
async function originRefs(repo: string): Promise<string[]> {
  return (await gitIn(repo, ['for-each-ref', '--format=%(refname) %(objectname)'])).split('\n').filter(Boolean);
}

async function drive(cluster: Cluster, options: ScenarioOptions, record: Recorder): Promise<void> {
  const { person, origin, models, waitFor, waitForEvent } = cluster;
  const scripted = options.scripted !== false;
  if (!(await person.project()).runnerLeads) throw new Error('the lost lead needs a cluster with runner leads on');
  const lead1 = leadAttemptId(1, 1);
  const lead2 = leadAttemptId(2, 1);

  // lead-a1 takes the seat, writes its lead handoff and goes idle.
  const seated = await waitForEvent({ type: 'lead.seat_changed', data: { kind: 'runner', attemptId: lead1 } });
  const seat1 = (await person.status()).leadSeat;
  const attempt1 = (await person.attempt(lead1)).attempt;
  const runnerId1 = attempt1.runnerId;
  if (runnerId1 === null) throw new Error(`${lead1} runs on no runner`);
  record.check(
    CHECKS.seated,
    seat1.kind === 'runner' && seat1.attemptId === lead1 && seat1.runnerId === runnerId1,
    `event #${seated.id}; seat ${shown(seat1)}`,
  );
  const handoff = await waitFor(`${lead1}'s lead handoff`, async () =>
    (await person.leadNotes()).find((note) => note.kind === 'handoff' && note.attemptId === lead1),
  );
  record.check(
    CHECKS.handoff,
    handoff.author === `agent:${attempt1.agentId}` && (scripted ? handoff.body === LEAD_HANDOFF : handoff.body !== ''),
    `${handoff.author}: ${shown(handoff.body)}`,
  );
  await waitFor(`${lead1} to go idle`, async () => (await person.attempt(lead1)).attempt.phase === 'idle');
  const runner1 = await cluster.runnerOf(lead1);
  const agent1 = await runner1.agentOf(lead1);

  // The lid closes on the lead's runner, and a person messages the lead while it is away.
  const frozenAt = await newestEventId(cluster);
  await runner1.freeze();
  const message = await person.send({ to: 'lead', body: MESSAGE });
  // The lease runs out runnerLeaseMs after the freeze; the default wait covers it with room to spare.
  await waitForEvent({ type: 'attempt.ended', subject: lead1, attemptId: lead1 }, { after: frozenAt });
  const lost = (await person.attempt(lead1)).attempt;
  record.equal(CHECKS.lost, [lost.endReason, lost.failureClass], ['lost', 'infra']);

  // lead-a2 takes the seat elsewhere, from lead-a1's handoff, and gets the person's message.
  const reseated = await waitForEvent(
    { type: 'lead.seat_changed', data: { kind: 'runner', attemptId: lead2 } },
    { after: frozenAt },
  );
  const seatMovesSinceFreeze = (await person.events({ after: frozenAt, limit: 1000 }))
    .filter((event) => event.type === 'lead.seat_changed' && event.id <= reseated.id)
    .map((event) => [event.data.kind, event.data.attemptId]);
  record.equal(CHECKS.emptied, seatMovesSinceFreeze, [
    ['none', null],
    ['runner', lead2],
  ]);
  const attempt2 = (await person.attempt(lead2)).attempt;
  record.check(
    CHECKS.reseated,
    attempt2.runnerId !== null && attempt2.runnerId !== runnerId1 && reseated.data.runnerId === attempt2.runnerId,
    `lead-a1 on ${runnerId1}, lead-a2 on ${attempt2.runnerId} (event #${reseated.id})`,
  );
  if (scripted) {
    await waitFor(`${lead2}'s first model request`, async () => firstRequestText(cluster, lead2) !== null);
    checkBrief(cluster, lead2, handoff, record);
  }
  const target = `agent:${attempt2.agentId}`;
  // The frozen runner reports nothing, so lead-a1 cannot have a delivery yet: messageMoved is checked after the thaw.
  await waitFor(`the person's message to reach ${lead2}`, async () => {
    const found = (await person.messages({ target: 'lead' })).find((entry) => entry.id === message.id);
    return found?.deliveries.some((delivery) => delivery.agentId === attempt2.agentId) === true;
  });
  if (scripted) {
    await waitFor(`${lead2}'s model to be shown the message`, async () => models.sawText(lead2, MESSAGE));
    record.check(CHECKS.messageSeen, true, `${lead2} was shown ${shown(MESSAGE)}`);
  }

  // A task created now: a worker submits it, the delivery wakes lead-a2, and it accepts.
  const [task] = await person.createTasks([TASK]);
  if (!task) throw new Error('the hub created no task');
  const taskId = task.id;
  if (scripted) models.addPrograms(programs(taskId));
  const submitted = await waitForEvent({ type: 'submission.recorded', subject: taskId });
  const head = await refSha(origin.path, `refs/heads/${String(submitted.data.branch)}`);
  record.equal(
    CHECKS.submitted,
    { head, file: head && (await fileAt(origin.path, head, 'review.txt')) },
    { head: submitted.data.headSha, file: 'review\n' },
  );
  const accepted = await waitForEvent({ type: 'task.accepted', subject: taskId });
  if (scripted) {
    const leadRunner = await cluster.runnerOf(lead2);
    // Playbooks advance even after a failed shell command; require the proof written only after the check passed.
    record.equal(CHECKS.reviewed, cloneFile(leadRunner.clonePath(lead2), '.agflow/run/review-verified'), 'review\n');
  }
  const wake = (await person.messages({ taskId })).find(
    (entry) => entry.to === 'lead' && entry.body.startsWith(submittedMarker(taskId)),
  );
  record.check(
    CHECKS.woken,
    wake?.deliveries.some((delivery) => delivery.agentId === attempt2.agentId) === true,
    wake === undefined ? 'no submission message to the lead' : `#${wake.id} delivered to ${shown(wake.deliveries)}`,
  );
  const seatMoves = (await person.events({ after: reseated.id, limit: 1000 })).filter(
    (event) => event.type === 'lead.seat_changed' && event.id < accepted.id,
  );
  record.check(
    CHECKS.accepted,
    accepted.actor === target && seatMoves.length === 0 && (await person.task(taskId)).task.status === 'accepted',
    `accepted by ${accepted.actor} at #${accepted.id}; seat changes before it: ${seatMoves.length}`,
  );

  // hold_attempt may have reported the worker's exit before acceptance ends its attempt. Wait for the exit
  // in either order; its runner pushes any last WIP before that report, and nothing pushes afterwards.
  const worker = String(submitted.data.attemptId);
  await waitFor(`the exit report of ${worker}`, async () =>
    workerExitReported((await person.attempt(worker)).log),
  );

  // The lid opens: welcome.stop names lead-a1, so the old runner stops its process and pushes nothing for it.
  const refsBefore = await originRefs(origin.path);
  const thawedAt = await newestEventId(cluster);
  await runner1.thaw();
  await waitForEvent({ type: 'runner.online', subject: runnerId1 }, { after: thawedAt });
  await waitFor(`${lead1}'s process to be stopped`, async () => {
    const now = await processIdentity(agent1.pid);
    return now === null || !sameProcess(now, agent1);
  });
  record.check(CHECKS.oldStopped, true, `agent ${agent1.pid} of ${lead1} is gone`);
  // The runner reports the stop after the old process exited: by then anything it pushed would be recorded.
  await waitFor(`the old runner's report on ${lead1}`, async () =>
    (await person.attempt(lead1)).log.some((entry) => entry.summary.includes('after it ended')),
  );
  const pushed = (await person.events({ subject: lead1, limit: 1000 })).filter(
    (event: HubEvent) => event.type === 'attempt.wip' || event.type === 'attempt.late_work',
  );
  // Nothing else pushes in this window (the task is accepted and lead-a2 has no WIP), so origin's refs must not move.
  const refsAfter = await originRefs(origin.path);
  const changed = refsAfter.filter((line) => !refsBefore.includes(line));
  const dropped = refsBefore.filter((line) => !refsAfter.includes(line));
  record.check(
    CHECKS.noRefs,
    pushed.length === 0 && changed.length === 0 && dropped.length === 0,
    `events ${pushed.map((event) => `${event.type} #${event.id}`).join(', ') || 'none'}; ` +
      `refs added or moved ${changed.join(', ') || 'none'}; refs gone ${dropped.join(', ') || 'none'}`,
  );
  // The old runner never injected the message from its old deliver command: lead-a1 has no delivery, and in a
  // scripted run its model never saw the message.
  const final = (await person.messages({ target: 'lead' })).find((entry) => entry.id === message.id);
  record.check(
    CHECKS.messageMoved,
    final !== undefined &&
      final.deliveries.some((delivery) => delivery.agentId === attempt2.agentId) &&
      final.deliveries.every((delivery) => delivery.agentId !== attempt1.agentId) &&
      (!scripted || !models.sawText(lead1, MESSAGE)),
    final === undefined
      ? `#${message.id} is gone`
      : `#${message.id} delivered to ${final.deliveries.map((delivery) => delivery.agentId).join(', ') || 'nobody'} ` +
          `(${target}); ${lead1}'s model saw it: ${models.sawText(lead1, MESSAGE)}`,
  );
}

/** lead-a2's first request quotes lead-a1's lead handoff under the line that names its author and attempt. */
function checkBrief(cluster: Cluster, lead2: string, handoff: LeadNote, record: Recorder): void {
  const first = firstRequestText(cluster, lead2) ?? '';
  const source = `${handoff.author} wrote this lead handoff in attempt ${handoff.attemptId}:`;
  const quoted = `${source}\n${quoteLines(handoff.body)}`;
  record.check(
    CHECKS.brief,
    first.includes(quoted),
    first === '' ? `${lead2} sent no model request` : `looked for ${shown(quoted)}`,
  );
}

/** Whether the worker's exit report has reached the hub. */
export function workerExitReported(log: readonly Pick<AttemptLogEntry, 'kind' | 'summary'>[]): boolean {
  return log.some(
    (entry) => entry.kind === 'note' &&
      /^the agent (?:exited(?: with code -?\d+)?|was killed by \S+), stopped by /.test(entry.summary),
  );
}
