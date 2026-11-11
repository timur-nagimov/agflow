// Exit scenario 1, the killed agent (design 1, 6.8, 7.4, X-15). A worker commits a.txt, writes its handoff note, leaves
// b.txt uncommitted and runs a long command; the harness then SIGKILLs the agent's process group. The runner must kill
// what is left of the attempt and sweep the clone, then harvest and push the final WIP, all before it reports the
// exit. The hub ends the attempt crashed (infra) and starts a successor on another runner from that WIP and that note,
// and the successor finishes the task. The driver waits only on what it can observe, so a live run reuses it with a
// real model that follows the task's written steps.
import { type Attempt, attemptId, type NewTaskInput, quoteLines } from '@agflow/core';
import { fileAt, gitIn, refSha } from '../git-fixtures';
import type { Cluster } from '../harness/cluster';
import { BASH_MAX_TIMEOUT_MS, gate, type Programs, say, shell, tool } from '../harness/playbook';
import { processesInDir } from '../harness/proc';
import {
  checks,
  cloneFile,
  firstRequestText,
  notesOf,
  type Recorder,
  type ScenarioOptions,
  type ScenarioResult,
  SNAPSHOT_SUBJECT,
  shown,
  waitAtGate,
} from './result';

/** The command a1 is inside when it is killed; it would run for 10 minutes. */
const LONG_COMMAND = 'sleep 600';

/** What a1's handoff note says, word for word in a scripted run. */
const HANDOFF = 'a.txt is committed. b.txt is written but not committed yet. Next: add c.txt, commit, and submit.';

/** a2's first text, which the hub stores as its restatement. */
const RESTATEMENT = 'a.txt is committed and b.txt is written. My next step is to add c.txt, commit, and submit.';

/** The gate a2 waits at before it changes anything, while the driver reads its clone. */
const CHECKED = 'checked';

const TASK: NewTaskInput = {
  title: 'Add a.txt, b.txt and c.txt',
  objective: [
    "This task tests agflow's recovery from a killed agent. Follow these steps exactly, in your task branch.",
    'If your brief has no handoff note from a previous attempt:',
    '1. Create a.txt holding the line "a" and commit it.',
    `2. Call write_handoff with this task's id and the note: ${HANDOFF}`,
    '3. Create b.txt holding the line "b". Do not commit it.',
    `4. Run \`${LONG_COMMAND}\` in the foreground with a 10-minute timeout and wait for it. agflow stops you ` +
      'during it.',
    'If your brief has a handoff note: first restate the state of the work and your next step, as your first prompt ' +
      'asks. Then create c.txt holding the line "c", commit b.txt and c.txt, and submit.',
  ].join('\n'),
  acceptance: [{ id: 'files', assertion: 'a.txt, b.txt and c.txt hold the lines a, b and c' }],
};

/** The checks killedAgent makes, by name; the e2e test reads them in groups. */
const CHECKS = {
  crashed: 'a1 ends crashed, class infra',
  finalWip: "a1's final WIP ref on origin equals the hub's wipSha",
  committed: 'the final WIP holds a.txt from a commit under the snapshot',
  snapshot: 'the final WIP holds b.txt from the uncommitted-work snapshot',
  ownNote: "a1's own handoff note stands, so the hub assembled none",
  swept: 'when the hub records a1 ended, no process has its cwd in its clone',
  otherRunner: 'a2 runs on another runner than a1',
  startSha: "a2 starts from a1's final WIP",
  cloneFiles: "a2's clone holds a.txt and b.txt before a2 changes anything",
  brief: "a2's first model request quotes a1's handoff note",
  restatement: "a2's first text is stored as a restatement note of a2",
  submitted: 'a2 submits a branch holding a.txt, b.txt and c.txt',
  accepted: 'the person accepts the task, and a2 ends accepted',
} as const;

function programs(taskId: string): Programs {
  return {
    [attemptId(taskId, 1, 1)]: {
      steps: [
        say(
          'I add a.txt and commit it.',
          shell("printf 'a\\n' > a.txt && git add a.txt && git commit -q -m 'Add a.txt'"),
        ),
        say('I write my handoff note.', tool('write_handoff', { task_id: taskId, note: HANDOFF })),
        say('I start b.txt and leave it uncommitted for now.', shell("printf 'b\\n' > b.txt")),
        say('I run the long command.', shell(LONG_COMMAND, { timeoutMs: BASH_MAX_TIMEOUT_MS })),
      ],
    },
    [attemptId(taskId, 2, 1)]: {
      steps: [
        say(RESTATEMENT, gate(CHECKED)),
        say(
          'I add c.txt and commit b.txt and c.txt.',
          shell("printf 'c\\n' > c.txt && git add b.txt c.txt && git commit -q -m 'Add b.txt and c.txt'"),
        ),
        say(
          'I submit the task.',
          tool('submit', { task_id: taskId, summary: 'a.txt, b.txt and c.txt hold the lines a, b and c.' }),
        ),
      ],
    },
  };
}

/** The task for live runs, the programs for scripted runs, and the names of the checks. */
export const KILLED_AGENT = {
  scenario: 'killed agent',
  task: TASK,
  handoff: HANDOFF,
  longCommand: LONG_COMMAND,
  programs,
  checks: CHECKS,
} as const;

/** Runs exit scenario 1 in the cluster and gives every check it made. */
export function killedAgent(cluster: Cluster, options: ScenarioOptions = {}): Promise<ScenarioResult> {
  return checks(KILLED_AGENT.scenario, cluster.vendor, (record) => drive(cluster, options, record), cluster.dump);
}

async function drive(cluster: Cluster, options: ScenarioOptions, record: Recorder): Promise<void> {
  const { person, origin, models, waitFor, waitForEvent } = cluster;
  const scripted = options.scripted !== false;
  const [task] = await person.createTasks([TASK]);
  if (!task) throw new Error('the hub created no task');
  const taskId = task.id;
  const a1 = attemptId(taskId, 1, 1);
  const a2 = attemptId(taskId, 2, 1);
  if (scripted) models.addPrograms(programs(taskId));

  // a1 committed a.txt, wrote its note, left b.txt and is inside the long command.
  await waitForEvent({ type: 'attempt.running', subject: taskId, attemptId: a1 });
  const runner1 = await cluster.runnerOf(a1);
  const clone1 = runner1.clonePath(a1);
  await waitFor(`${a1}'s handoff note`, async () => (await notesOf(cluster, taskId, 'handoff', a1)).length > 0);
  await waitFor(`b.txt in ${a1}'s clone`, async () => cloneFile(clone1, 'b.txt') !== null);
  await waitFor(`${LONG_COMMAND} in ${a1}'s clone`, async () =>
    (await processesInDir(clone1)).some((row) => row.command.includes(LONG_COMMAND)),
  );

  const agent = await runner1.killAgent(a1);
  const ended = await waitForEvent({ type: 'attempt.ended', subject: taskId, attemptId: a1 });
  // Read at once: the runner must have killed and swept before the harvest that the exit report follows.
  const left = await processesInDir(clone1);
  record.check(
    CHECKS.swept,
    left.length === 0,
    left.length === 0
      ? `agent ${agent.pid} killed; nothing ran in ${clone1} at event #${ended.id}`
      : left.map((row) => `${row.pid} ${row.command}`).join('; '),
  );
  const attempt1 = (await person.attempt(a1)).attempt;
  record.equal(CHECKS.crashed, [attempt1.endReason, attempt1.failureClass], ['crashed', 'infra']);
  await checkFinalWip(cluster, attempt1, record);
  // Every handoff note is a1's own; an agent may write more than one, but none may be the hub's.
  const ownNotes = (await person.task(taskId)).notes.filter((note) => note.kind === 'handoff');
  record.check(
    CHECKS.ownNote,
    ownNotes.length > 0 &&
      ownNotes.every((note) => note.author === `agent:${attempt1.agentId}` && note.attemptId === a1),
    ownNotes.map((note) => `${note.author} in ${note.attemptId}: ${shown(note.body)}`).join('; ') || 'no handoff note',
  );

  // The successor: another runner, a1's final WIP, and a1's note in its brief.
  await waitForEvent({ type: 'attempt.running', subject: taskId, attemptId: a2 });
  const attempt2 = (await person.attempt(a2)).attempt;
  const runner2 = await cluster.runnerOf(a2);
  record.check(
    CHECKS.otherRunner,
    attempt2.runnerId !== null && attempt2.runnerId !== attempt1.runnerId,
    `a1 on ${runner1.name} (${attempt1.runnerId}), a2 on ${runner2.name} (${attempt2.runnerId})`,
  );
  record.equal(CHECKS.startSha, attempt2.startSha, attempt1.wipSha);
  await waitAtGate(cluster, a2, CHECKED, options);
  const clone2 = runner2.clonePath(a2);
  record.equal(
    CHECKS.cloneFiles,
    { a: cloneFile(clone2, 'a.txt'), b: cloneFile(clone2, 'b.txt') },
    { a: 'a\n', b: 'b\n' },
  );
  // Real models have no gate, and the harness must not write into a clone the agent shapes: openGate follows links.
  if (scripted) await cluster.openGate(a2, CHECKED);
  if (scripted) {
    const [note] = await notesOf(cluster, taskId, 'handoff', a1);
    const first = firstRequestText(cluster, a2) ?? '';
    const source = `${note?.author} wrote this handoff note in attempt ${a1}:`;
    const quoted = quoteLines(note?.body ?? HANDOFF);
    record.check(
      CHECKS.brief,
      first.includes(`${source}\n${quoted}`),
      first === '' ? 'a2 sent no model request' : `looked for ${shown(`${source}\n${quoted}`)}`,
    );
  }
  const [restatement] = await waitFor(`${a2}'s restatement`, async () => {
    const found = await notesOf(cluster, taskId, 'restatement', a2);
    return found.length > 0 ? found : null;
  });
  record.check(
    CHECKS.restatement,
    restatement?.author === `agent:${attempt2.agentId}` &&
      (scripted ? restatement.body.includes(RESTATEMENT) : restatement.body.trim() !== ''),
    `${restatement?.author}: ${shown(restatement?.body)}`,
  );

  // a2 finishes, and the person accepts.
  const submitted = await waitForEvent({ type: 'submission.recorded', subject: taskId, attemptId: a2 });
  const branch = String(submitted.data.branch);
  const head = await refSha(origin.path, `refs/heads/${branch}`);
  const files = {
    head,
    a: head && (await fileAt(origin.path, head, 'a.txt')),
    b: head && (await fileAt(origin.path, head, 'b.txt')),
    c: head && (await fileAt(origin.path, head, 'c.txt')),
  };
  record.equal(CHECKS.submitted, files, { head: submitted.data.headSha, a: 'a\n', b: 'b\n', c: 'c\n' });
  await person.accept(taskId);
  await waitForEvent({ type: 'attempt.ended', subject: taskId, attemptId: a2 });
  const accepted = { task: (await person.task(taskId)).task.status, a2: (await person.attempt(a2)).attempt.endReason };
  record.equal(CHECKS.accepted, accepted, { task: 'accepted', a2: 'accepted' });
}

/** a1's final WIP: origin's WIP ref at the hub's wipSha, a snapshot of b.txt over the commit of a.txt. */
async function checkFinalWip(cluster: Cluster, attempt: Attempt, record: Recorder): Promise<void> {
  const repo = cluster.origin.path;
  const sha = attempt.wipSha;
  const onOrigin = attempt.wipRef === null ? null : await refSha(repo, attempt.wipRef);
  record.check(
    CHECKS.finalWip,
    sha !== null && onOrigin === sha,
    `hub ${attempt.wipRef ?? 'no WIP ref'} at ${sha}, origin at ${onOrigin}`,
  );
  if (sha === null) return;
  const subject = (await gitIn(repo, ['log', '-1', '--format=%s', sha])).trim();
  const below = `${sha}^`;
  record.equal(
    CHECKS.committed,
    { a: await fileAt(repo, below, 'a.txt'), b: await fileAt(repo, below, 'b.txt') },
    { a: 'a\n', b: null },
  );
  record.check(
    CHECKS.snapshot,
    subject.startsWith(SNAPSHOT_SUBJECT) && (await fileAt(repo, sha, 'b.txt')) === 'b\n',
    `${sha} is ${shown(subject)} with b.txt ${shown(await fileAt(repo, sha, 'b.txt'))}`,
  );
}
