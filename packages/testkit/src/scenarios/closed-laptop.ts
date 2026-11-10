// Exit scenario 2, the closed laptop (design 1, 6.3, 6.4, 7.3, 7.9, X-11, X-36). A worker commits a.txt, then runs a
// command that keeps rewriting tick.txt. Once the hub has recorded a WIP, the harness freezes the runner and everything
// under it, as a closed lid does. The hub marks the runner offline, ends the attempt lost when the lease runs out, and
// the task goes stale, then ready with an assembled handoff note; a successor on another runner starts from the last
// pushed WIP. The harness then thaws the runner: after its clock gap it pushes no WIP until welcome, whose stop makes
// it stop the agent without a handoff and push the late work to a late-work ref. The hub records a late_work note and
// tells the successor, which merges that ref, so the final submission holds everything.
import { existsSync } from 'node:fs';
import {
  attemptId,
  DEFAULT_WIP_REF_PREFIX,
  type HubEvent,
  lateWorkRef,
  type NewTaskInput,
  quoteLines,
  wipRef,
} from '@agflow/core';
import { processIdentity, sameProcess } from '@agflow/runner/src/processes';
import { loadConfig } from '../../../hub/src/config';
import { fileAt, gitIn, isAncestor, refSha } from '../git-fixtures';
import type { Cluster } from '../harness/cluster';
import { BASH_MAX_TIMEOUT_MS, gate, type Program, type Programs, say, shell, tool } from '../harness/playbook';
import { processesInDir } from '../harness/proc';
import {
  checks,
  cloneFile,
  firstRequestText,
  newestEventId,
  notesOf,
  type Recorder,
  type ScenarioOptions,
  type ScenarioResult,
  shown,
  waitAtGate,
} from './result';

/**
 * Rewrites tick.txt with a counter five times a second, for about 8 minutes. The counter keeps the work in the clone
 * changing right up to the freeze and again right after the thaw, so the work the runner pushes late always differs
 * from the last WIP it pushed in time. A perl one-liner, like the playbook's gates: Claude Code denies a shell loop
 * with expansions in a runner session.
 */
const TICK_COMMAND =
  `perl -e 'for my $n (1..2500) { open(my $f, ">", "tick.txt") or die "tick.txt: $!"; print $f "$n\\n"; close $f; ` +
  "select(undef, undef, undef, 0.2) }'";

/** a2's first text, which the hub stores as its restatement. */
const RESTATEMENT =
  'a.txt is committed and tick.txt is in the last WIP. My next step is to add c.txt, then merge the late work of the ' +
  'previous attempt and submit.';

/** The gate a2 waits at, after its own commit, until the driver has seen the late work recorded. */
const LATE_WORK = 'late-work';

/** How many times a2's merge fetches a late ref before it gives up: refresh_vault may still be fetching it. */
const FETCH_TRIES = 30;

/** How an assembled note closes when the attempt wrote none (design 6.8). */
const NO_NOTE = 'No handoff note was written; the next step is unknown.';

const TASK: NewTaskInput = {
  title: 'Add a.txt, tick.txt and c.txt',
  objective: [
    "This task tests agflow's recovery from a closed laptop. Follow these steps exactly, in your task branch.",
    'If your brief has no handoff note from a previous attempt:',
    '1. Create a.txt holding the line "a" and commit it.',
    `2. Run \`${TICK_COMMAND}\` in the foreground with a 10-minute timeout and wait for it. It keeps rewriting ` +
      'tick.txt, which you do not commit; agflow stops you during it.',
    'If your brief has a handoff note: first restate the state of the work and your next step, as your first prompt ' +
      'asks. Then create c.txt holding the line "c" and commit it. Then wait for agflow\'s message about late work ' +
      'of the previous attempt: run `sleep 60`, up to ten times, until it arrives. Merge that work as the message ' +
      "says, keeping the late work's tick.txt if the merge conflicts, and submit.",
  ].join('\n'),
  acceptance: [
    { id: 'files', assertion: 'a.txt and c.txt hold the lines a and c' },
    { id: 'late-work', assertion: "tick.txt is the previous attempt's late work" },
  ],
};

/** The checks closedLaptop makes, by name; the e2e test reads them in groups. */
const CHECKS = {
  offline: "the hub marks a1's frozen runner offline after deadLinkMs, while a1 is still open",
  lost: 'a1 ends lost, class infra, once the runner lease has run out',
  notStalled: 'while its runner was frozen, a1 got no stall or stop: only the lease ended it',
  staleReady: 'the task went stale, then ready',
  assembled: "a handoff note by system quotes a1's work and says no handoff note was written",
  otherRunner: 'a2 runs on another runner than a1',
  startSha: "a2 starts from a1's last recorded WIP",
  brief: "a2's brief holds the assembled note, quoted",
  agentGone: "after the thaw, a1's agent and its tick command are gone",
  lateWork:
    "origin holds a1's late work on its late-work refs from the first, with a.txt and tick.txt, and any late WIP " +
    'was harvested before the freeze (no WIP after the clock gap, X-11)',
  lateNote: 'a late_work note of a1 names each ref of its late work',
  message: "a2's agent gets the hub's message that names the late work's ref",
  received: "a2's model is shown the message that names the late work's ref",
  merged: "a2 submits a branch that merged the late work: a.txt, the late work's tick.txt and c.txt",
  accepted: 'the person accepts the task, and a2 ends accepted',
} as const;

/**
 * The command a2 runs to merge the late work: each ref fetched from the vault, retried each second while
 * refresh_vault may still be bringing it, then merged with conflicts resolved for the late work. Simple commands only,
 * which Claude Code can approve.
 */
function mergeCommand(refs: readonly string[]): string {
  const fetch =
    `perl -e 'for (1..${FETCH_TRIES}) { exit 0 if system("git", "fetch", "-q", "origin", $ARGV[0]) == 0; sleep 1 } ` +
    "exit 1'";
  return refs.map((ref) => `${fetch} '${ref}' && git merge -q --no-edit -X theirs FETCH_HEAD`).join(' && ');
}

/**
 * a2's program: its restatement with its own commit, the gate, then the merge of the late refs once the driver knows
 * them (it replaces the program while a2 waits at the gate), then the submission.
 */
function successorProgram(taskId: string, lateRefs: readonly string[]): Program {
  const merge = lateRefs.length === 0 ? [] : [say('I merge the late work.', shell(mergeCommand(lateRefs)))];
  return {
    steps: [
      say(RESTATEMENT, shell("printf 'c\\n' > c.txt && git add c.txt && git commit -q -m 'Add c.txt'")),
      gate(LATE_WORK),
      ...merge,
      say(
        'I submit the task.',
        tool('submit', { task_id: taskId, summary: "a.txt and c.txt are in, with the late work's tick.txt merged." }),
      ),
    ],
  };
}

function programs(taskId: string, lateRefs: readonly string[] = []): Programs {
  return {
    [attemptId(taskId, 1, 1)]: {
      steps: [
        say(
          'I add a.txt and commit it.',
          shell("printf 'a\\n' > a.txt && git add a.txt && git commit -q -m 'Add a.txt'"),
        ),
        say('I keep tick.txt current.', shell(TICK_COMMAND, { timeoutMs: BASH_MAX_TIMEOUT_MS })),
      ],
    },
    [attemptId(taskId, 2, 1)]: successorProgram(taskId, lateRefs),
  };
}

/** The task for live runs, the programs for scripted runs (a2's with the late refs to merge), and the check names. */
export const CLOSED_LAPTOP = {
  scenario: 'closed laptop',
  task: TASK,
  tickCommand: TICK_COMMAND,
  programs,
  checks: CHECKS,
} as const;

/**
 * The hub's liveness timings, as the hub itself loads them from the environment it was started with: its test
 * configuration overrides only the fields it names (X-27), and the rest keep the hub's own settings.
 */
function liveness(cluster: Cluster): { heartbeatMs: number; deadLinkMs: number; runnerLeaseMs: number } {
  const { config } = loadConfig(cluster.hub.env);
  return { heartbeatMs: config.heartbeatMs, deadLinkMs: config.deadLinkMs, runnerLeaseMs: config.runnerLeaseMs };
}

/**
 * Whether a text names the ref itself, not a longer ref it is a prefix of (the WIP ref of its late-work refs). A
 * full stop that ends a sentence may follow it.
 */
function namesRef(text: string, ref: string): boolean {
  const escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${escaped}(?![\\w/-]|\\.\\w)`).test(text);
}

/** The section of an assembled note that quotes the WIP's log: one paragraph, as quoted lines are never empty. */
function wipSection(body: string): string {
  return body.split('\n\n').find((part) => part.startsWith('## Commits on the WIP since main')) ?? '';
}

/** The task's events of a type about the attempt, oldest first. */
async function eventsOf(cluster: Cluster, taskId: string, type: string, attempt: string): Promise<HubEvent[]> {
  const events = await cluster.person.events({ subject: taskId, limit: 1000 });
  return events.filter((event) => event.type === type && event.data.attemptId === attempt);
}

/** Runs exit scenario 2 in the cluster and gives every check it made. */
export function closedLaptop(cluster: Cluster, options: ScenarioOptions = {}): Promise<ScenarioResult> {
  return checks(CLOSED_LAPTOP.scenario, cluster.vendor, (record) => drive(cluster, options, record), cluster.dump);
}

async function drive(cluster: Cluster, options: ScenarioOptions, record: Recorder): Promise<void> {
  const { person, origin, models, waitFor, waitForEvent } = cluster;
  const scripted = options.scripted !== false;
  const timings = liveness(cluster);
  const [task] = await person.createTasks([TASK]);
  if (!task) throw new Error('the hub created no task');
  const taskId = task.id;
  const a1 = attemptId(taskId, 1, 1);
  const a2 = attemptId(taskId, 2, 1);
  if (scripted) models.addPrograms(programs(taskId));

  // a1 committed a.txt and keeps rewriting tick.txt; the lid closes right after the hub records a WIP.
  await waitForEvent({ type: 'attempt.running', subject: taskId, attemptId: a1 });
  const runner1 = await cluster.runnerOf(a1);
  const clone1 = runner1.clonePath(a1);
  const runnerId1 = (await person.attempt(a1)).attempt.runnerId;
  if (runnerId1 === null) throw new Error(`${a1} runs on no runner`);
  await waitFor(`tick.txt in ${a1}'s clone`, async () => cloneFile(clone1, 'tick.txt') !== null);
  const agent1 = await runner1.agentOf(a1);
  const wip = await waitForEvent(
    { type: 'attempt.wip', subject: taskId, attemptId: a1 },
    { after: await newestEventId(cluster) },
  );
  const frozenAt = Date.now();
  await runner1.freeze();
  // Anything the runner harvests later than this, it harvested after the thaw.
  const frozenBy = Date.now();

  // The hub hears nothing: the runner goes offline, then the lease ends a1 lost and the task goes stale, then ready.
  const offline = await waitForEvent({ type: 'runner.offline', subject: runnerId1 }, { after: wip.id });
  const leaseWait = { after: wip.id, timeoutMs: timings.runnerLeaseMs + 120_000 };
  const ended = await waitForEvent({ type: 'attempt.ended', subject: taskId, attemptId: a1 }, leaseWait);
  const attempt1 = (await person.attempt(a1)).attempt;
  // The bounds leave room for heartbeat jitter but still tell the dead link from the lease.
  record.check(
    CHECKS.offline,
    offline.ts - frozenAt >= timings.deadLinkMs - 2 * timings.heartbeatMs && offline.id < ended.id,
    `offline ${offline.ts - frozenAt} ms after the freeze (event #${offline.id}); a1 ended at #${ended.id}`,
  );
  record.check(
    CHECKS.lost,
    attempt1.endReason === 'lost' &&
      attempt1.failureClass === 'infra' &&
      ended.ts - frozenAt >= timings.runnerLeaseMs - timings.deadLinkMs,
    `${attempt1.endReason} (${attempt1.failureClass}) ${ended.ts - frozenAt} ms after the freeze; ` +
      `the lease is ${timings.runnerLeaseMs} ms`,
  );
  // What the e2e timings let this observe: the hub neither stalls nor stops an attempt whose runner went quiet. The
  // freshness rule itself (stale facts never confirm a stall) needs timings that make a rule fire, so the hub's
  // supervisor tests cover it ('a suspicion is not confirmed by a heartbeat whose facts went stale').
  const stalls = [
    ...(await eventsOf(cluster, taskId, 'agent.stalled', a1)),
    ...(await eventsOf(cluster, taskId, 'agent.stopped', a1)),
  ];
  record.check(
    CHECKS.notStalled,
    stalls.length === 0 && attempt1.stopRequested === null,
    stalls.length === 0 && attempt1.stopRequested === null
      ? 'no stall event and no stop request'
      : `${stalls.map((event) => `${event.type} ${shown(event.data.cause)}`).join(', ')} ` +
          `stop ${shown(attempt1.stopRequested)}`,
  );
  const moves = (await person.events({ subject: taskId, after: wip.id, limit: 1000 }))
    .filter((event) => (event.type === 'task.stale' || event.type === 'task.ready') && event.data.attemptId === a1)
    .map((event) => event.type);
  record.equal(CHECKS.staleReady, moves, ['task.stale', 'task.ready']);
  const assembled = (await notesOf(cluster, taskId, 'handoff', a1)).filter((note) => note.author === 'system');
  const note = assembled.at(-1);
  const lastParagraph = note?.body.split('\n\n').at(-1) ?? '';
  // a1's work is quoted in the WIP log's section: the task's title and objective, quoted above it, name a.txt too.
  const wipLog = wipSection(note?.body ?? '');
  record.check(
    CHECKS.assembled,
    assembled.length === 1 && note !== undefined && /^> .*a\.txt/m.test(wipLog) && lastParagraph.startsWith(NO_NOTE),
    note === undefined
      ? 'no handoff note by system'
      : `${assembled.length} note(s); the WIP log ${shown(wipLog)}; the last ending ${shown(lastParagraph)}`,
  );

  // The successor: another runner, a1's last recorded WIP, the assembled note in its brief.
  await waitForEvent({ type: 'attempt.running', subject: taskId, attemptId: a2 });
  const attempt2 = (await person.attempt(a2)).attempt;
  const runner2 = await cluster.runnerOf(a2);
  record.check(
    CHECKS.otherRunner,
    attempt2.runnerId !== null && attempt2.runnerId !== attempt1.runnerId,
    `a1 on ${runner1.name} (${attempt1.runnerId}), a2 on ${runner2.name} (${attempt2.runnerId})`,
  );
  record.equal(CHECKS.startSha, attempt2.startSha, attempt1.wipSha);
  if (scripted && note !== undefined) {
    const first = firstRequestText(cluster, a2) ?? '';
    const start = note.body.split('\n').slice(0, 2).join('\n');
    const quoted = `system wrote this handoff note in attempt ${a1}:\n${quoteLines(start)}`;
    record.check(
      CHECKS.brief,
      first.includes(quoted),
      first === '' ? 'a2 sent no model request' : `looked for ${shown(quoted)}`,
    );
  }

  // The lid opens while a2 waits: welcome.stop stops a1's agent, and its late work goes to a late-work ref.
  await waitAtGate(cluster, a2, LATE_WORK, options);
  await runner1.thaw();
  const ownWipRef = wipRef(DEFAULT_WIP_REF_PREFIX, a1);
  const lateRefPattern = `${ownWipRef}-late-`;
  // The cleanup removes the clone only after the late-work push, so once it is gone every late push was made.
  const late = await waitFor(`${a1}'s late work, and its clone removed`, async () => {
    const found = await eventsOf(cluster, taskId, 'attempt.late_work', a1);
    const pushedLate = found.some((event) => String(event.data.ref).startsWith(lateRefPattern));
    return pushedLate && !existsSync(clone1) ? found : null;
  });
  const now = await processIdentity(agent1.pid);
  const left = await processesInDir(clone1);
  record.check(
    CHECKS.agentGone,
    (now === null || !sameProcess(now, agent1)) && left.length === 0,
    `agent ${agent1.pid} ${now !== null && sameProcess(now, agent1) ? 'still runs' : 'is gone'}; ` +
      `${left.length === 0 ? 'nothing runs' : left.map((row) => `${row.pid} ${row.command}`).join('; ')} in its clone`,
  );
  const lateRefs = late.map((event) => String(event.data.ref));
  const newest = late.at(-1) as HubEvent;
  const newestSha = String(newest.data.sha);
  await checkLateWork(cluster, { late, ownWipRef, a1, frozenBy }, record);
  const tick = await fileAt(origin.path, newestSha, 'tick.txt');
  const lateNotes = (await notesOf(cluster, taskId, 'late_work', a1)).filter((entry) => entry.author === 'system');
  record.check(
    CHECKS.lateNote,
    lateRefs.every((ref) => lateNotes.some((entry) => namesRef(entry.body, ref))),
    lateNotes.map((entry) => shown(entry.body)).join('; ') || 'no late_work note',
  );

  // a2 gets the message that names the ref, merges the late work and submits.
  const target = `agent:${attempt2.agentId}`;
  const ref = String(newest.data.ref);
  const message = await waitFor(`the late-work message to ${target}`, async () =>
    (await person.messages({ target })).find((entry) => entry.from === 'system' && namesRef(entry.body, ref)),
  );
  record.check(CHECKS.message, true, `#${message.id}: ${shown(message.body)}`);
  // Real models have no gate, and the harness must not write into a clone the agent shapes: openGate follows links.
  if (scripted) {
    models.addPrograms({ [a2]: successorProgram(taskId, lateRefs) });
    await cluster.openGate(a2, LATE_WORK);
  }
  const submitted = await waitForEvent({ type: 'submission.recorded', subject: taskId, attemptId: a2 });
  if (scripted) {
    const received = models.requestsFor(a2).some((request) => namesRef(request.text, ref));
    record.check(CHECKS.received, received, `looked for ${ref} in what a2 was shown`);
  }
  const head = await refSha(origin.path, `refs/heads/${String(submitted.data.branch)}`);
  const merged =
    head !== null &&
    (await Promise.all(late.map((event) => isAncestor(origin.path, String(event.data.sha), head)))).every(Boolean);
  const files = {
    head,
    merged,
    a: head && (await fileAt(origin.path, head, 'a.txt')),
    tick: head && (await fileAt(origin.path, head, 'tick.txt')),
    c: head && (await fileAt(origin.path, head, 'c.txt')),
  };
  record.equal(CHECKS.merged, files, { head: submitted.data.headSha, merged: true, a: 'a\n', tick, c: 'c\n' });
  await person.accept(taskId);
  await waitForEvent({ type: 'attempt.ended', subject: taskId, attemptId: a2 });
  const accepted = { task: (await person.task(taskId)).task.status, a2: (await person.attempt(a2)).attempt.endReason };
  record.equal(CHECKS.accepted, accepted, { task: 'accepted', a2: 'accepted' });
}

/**
 * a1's late work on origin: its late-work refs numbered from 1 in the order the hub recorded them, each on origin at
 * the recorded sha, the newest holding a.txt and tick.txt. A push that was in flight at the freeze lands late on the
 * WIP ref; it must have been harvested before the freeze, since after its clock gap the runner pushes no WIP until
 * welcome (X-11). The runner dates a snapshot with its harvest time.
 */
async function checkLateWork(
  cluster: Cluster,
  input: { late: HubEvent[]; ownWipRef: string; a1: string; frozenBy: number },
  record: Recorder,
): Promise<void> {
  const repo = cluster.origin.path;
  const { late, ownWipRef, a1, frozenBy } = input;
  const problems: string[] = [];
  const seen: string[] = [];
  let n = 0;
  for (const event of late) {
    const ref = String(event.data.ref);
    const sha = String(event.data.sha);
    const onOrigin = await refSha(repo, ref);
    if (onOrigin !== sha) problems.push(`${ref} is at ${onOrigin} on origin, not ${sha}`);
    if (ref === ownWipRef) {
      const harvested = Number((await gitIn(repo, ['log', '-1', '--format=%ct', sha])).trim());
      seen.push(`late WIP ${sha} harvested at ${harvested} s`);
      if (!(harvested <= Math.ceil(frozenBy / 1000))) {
        problems.push(`the late WIP ${sha} was harvested at ${harvested} s, after the freeze at ${frozenBy} ms`);
      }
      continue;
    }
    n += 1;
    seen.push(`${ref} at ${sha}`);
    const expected = lateWorkRef(DEFAULT_WIP_REF_PREFIX, a1, n);
    if (ref !== expected) problems.push(`late work #${n} is on ${ref}, not ${expected}`);
  }
  if (n === 0) problems.push('no late work on a late-work ref');
  const newest = String(late.at(-1)?.data.sha ?? '');
  const files = { a: await fileAt(repo, newest, 'a.txt'), tick: await fileAt(repo, newest, 'tick.txt') };
  if (files.a !== 'a\n' || files.tick === null) problems.push(`the newest late work holds ${shown(files)}`);
  record.check(CHECKS.lateWork, problems.length === 0, [...seen, ...problems].join('; '));
}
