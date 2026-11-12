// Take-over and hand-back (design 6.4, 6.12, 7.3, 8.4, 9.4). A person takes over a running attempt: the runner gets
// a handoff note, stops the agent, pushes the WIP, restores the protected paths, replaces the clone's .git and reports
// the commands, which the runner core builds for the attempt's CLI version (X-5, X-13). The person works in the clone with
// plain git and hands back from it, or runs the "anywhere" commands in another clone and hands back by ref; either way
// the next attempt starts from the person's commit. The checks live here, so the e2e test and the live run's TTY
// check, where a real person takes over in the browser and resumes in a terminal, read the same verdicts.
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import {
  attemptId,
  DEFAULT_WIP_REF_PREFIX,
  type HubEvent,
  type NewTaskInput,
  parseAttemptId,
  takeoverRef,
} from '@agflow/core';
import { handoffPrompt } from '@agflow/runner/src/attempt/stop';
import { TAKEOVER_STOP_REASON } from '@agflow/runner/src/attempt/takeover';
import { vendorHomes } from '@agflow/runner/src/config';
import { VENDOR_PINS, vendorBinary } from '@agflow/runner/src/vendor/pins';
import { fileAt, gitIn, isAncestor, refSha } from '../git-fixtures';
import type { Cluster } from '../harness/cluster';
import { E2E_PLATFORM } from '../harness/env';
import { sessionOf } from '../harness/models';
import type { HandbackSource } from '../harness/person';
import { BASH_MAX_TIMEOUT_MS, type Programs, react, say, shell, tool } from '../harness/playbook';
import { type ProcessInfo, processesInDir } from '../harness/proc';
import {
  checks,
  cloneFile,
  type Recorder,
  type ScenarioOptions,
  type ScenarioResult,
  SNAPSHOT_SUBJECT,
  shown,
} from './result';

/** The command a1 is inside when the person takes over; it would run for 10 minutes. */
const LONG_COMMAND = 'sleep 600';

/** What a1's handoff note says, word for word in a scripted run. */
const HANDOFF = 'a.txt is committed. b.txt is written but not committed yet. Next: commit b.txt, add c.txt and submit.';

/** The runner's take-over handoff turn: a scripted a1 writes its note when it is shown it. */
const HANDOFF_TURN = handoffPrompt(TAKEOVER_STOP_REASON);

const TASK: NewTaskInput = {
  title: 'Add a.txt, b.txt and c.txt around a take-over',
  objective: [
    "This task tests agflow's take-over. Follow these steps exactly, in your task branch.",
    'If your brief has no handoff note from a previous attempt:',
    '1. Create a.txt holding the line "a" and commit it.',
    '2. Create b.txt holding the line "b". Do not commit it.',
    `3. Run \`${LONG_COMMAND}\` in the foreground with a 10-minute timeout and wait for it. A person takes the task ` +
      'over during it.',
    `4. When agflow asks you for a handoff note, call write_handoff with this task's id and the note: ${HANDOFF}`,
    'If your brief has a handoff note: create c.txt holding the line "c", commit it, and submit.',
  ].join('\n'),
  acceptance: [{ id: 'files', assertion: 'c.txt holds the line c, on top of the work handed back' }],
};

/** The checks takeoverChecks and handbackChecks make, by name; the e2e test reads them in groups. */
const CHECKS = {
  blocked: 'the task stays blocked as taken over by the person',
  handoff: 'a1 writes a handoff note before it stops',
  ended: 'a1 ends taken_over, with no take-over error',
  local:
    "attempt.takeover.local resumes a1's session with the runner's pinned binary of a1's CLI version and its vendor home",
  anywhere: 'attempt.takeover.anywhere fetches the WIP ref onto the task branch and pushes to the take-over ref',
  ref: "attempt.takeover.ref is the person's take-over ref",
  gitReplaced:
    "the clone's .git is a new repository, a shared clone of the vault, at the harvested head on the task branch",
  uncommitted:
    "the clone shows a1's uncommitted b.txt as a change, and none of a1's committed files as changed",
  forensics: "a1's old .git is in the runner's forensics/<attempt>/ directory",
  handedBack: 'the hand-back makes the task ready from the source it names',
  position: "the work position holds the person's commit, and no late work is recorded for a1",
  startSha: 'the next attempt starts from the work position',
  submitted: "the next attempt submits a branch holding the person's commit",
} as const;

function programs(taskId: string): Programs {
  return {
    [attemptId(taskId, 1, 1)]: {
      steps: [
        say(
          'I add a.txt and commit it.',
          shell("printf 'a\\n' > a.txt && git add a.txt && git commit -q -m 'Add a.txt'"),
        ),
        say('I start b.txt and leave it uncommitted for now.', shell("printf 'b\\n' > b.txt")),
        say('I run the long command.', shell(LONG_COMMAND, { timeoutMs: BASH_MAX_TIMEOUT_MS })),
      ],
      reactions: [
        react(HANDOFF_TURN, [
          say('I write my handoff note.', tool('write_handoff', { task_id: taskId, note: HANDOFF })),
        ]),
      ],
    },
    [attemptId(taskId, 2, 1)]: {
      steps: [
        say(
          'I add c.txt and commit it.',
          shell("printf 'c\\n' > c.txt && git add c.txt && git commit -q -m 'Add c.txt'"),
        ),
        say(
          'I submit the task.',
          tool('submit', { task_id: taskId, summary: 'c.txt is in, on the work handed back.' }),
        ),
      ],
    },
  };
}

/** The task for live runs, the programs for scripted runs, and the names of the checks. */
export const TAKEOVER = {
  scenario: 'take-over',
  task: TASK,
  handoff: HANDOFF,
  longCommand: LONG_COMMAND,
  programs,
  checks: CHECKS,
} as const;

/** The attempt a person takes over, and who. */
export interface TakeoverInput {
  taskId: string;
  attemptId: string;
  /** The login of the person who took it over. */
  login: string;
}

/** A hand-back of a taken-over attempt, and the commit the person made before it. */
export interface HandbackInput {
  taskId: string;
  /** The attempt that was taken over. */
  attemptId: string;
  source: HandbackSource;
  /** The person's commit, which the work position and the next attempt's branch must hold. */
  commit: string;
}

/** How readyForTakeover runs: a scenario's options, and how it finds the processes in a1's clone. */
export interface TakeoverOptions extends ScenarioOptions {
  /** processesInDir (lsof) by default; a unit test with a stand-in cluster passes its own. */
  processesIn?: (dir: string) => Promise<ProcessInfo[]>;
}

/**
 * Creates the task and waits until a1 committed a.txt, left b.txt uncommitted and runs its long command: a person can
 * take it over now. With scripted models it registers both attempts' programs first.
 */
export async function readyForTakeover(
  cluster: Cluster,
  options: TakeoverOptions = {},
): Promise<{ taskId: string; attemptId: string }> {
  const processesIn = options.processesIn ?? processesInDir;
  const { person, models, waitFor, waitForEvent } = cluster;
  const [task] = await person.createTasks([TASK]);
  if (!task) throw new Error('the hub created no task');
  const a1 = attemptId(task.id, 1, 1);
  if (options.scripted !== false) models.addPrograms(programs(task.id));
  await waitForEvent({ type: 'attempt.running', subject: task.id, attemptId: a1 });
  const clone = (await cluster.runnerOf(a1)).clonePath(a1);
  await waitFor(`b.txt in ${a1}'s clone`, async () => cloneFile(clone, 'b.txt') !== null);
  await waitFor(`${LONG_COMMAND} in ${a1}'s clone`, async () =>
    (await processesIn(clone)).some((row) => row.command.includes(LONG_COMMAND)),
  );
  if (options.scripted !== false && cluster.vendor === 'codex') {
    // Cross the loop threshold while the same exec session runs. Taking over immediately after spawn used to
    // miss the live failure: three check_inbox calls with ignored terminalInteraction polls between them.
    await waitFor(`${a1} to survive four exec-session polls`, async () => {
      const { attempt, log } = await person.attempt(a1);
      if (attempt.status === 'ended' || attempt.stopRequested !== null) {
        throw new Error(`${a1} stopped while polling its long command: ${attempt.stopRequested?.reason ?? attempt.endReason}`);
      }
      const polls = log.filter(entry => entry.kind === 'tool' && entry.summary === 'mcp__agflow__check_inbox: {}').length;
      return polls >= 4 && attempt.facts?.tool?.command === LONG_COMMAND &&
        attempt.facts.tool.ageMs >= 4000 && attempt.facts.repeatedCalls < 3;
    });
  }
  return { taskId: task.id, attemptId: a1 };
}

/**
 * Checks a take-over once the person asked for it and before they change the clone: it waits for the attempt to end,
 * then reads the hub, origin, the runner's files and the clone's new .git.
 */
export function takeoverChecks(
  cluster: Cluster,
  input: TakeoverInput,
  options: ScenarioOptions = {},
): Promise<ScenarioResult> {
  return checks(
    TAKEOVER.scenario,
    cluster.vendor,
    (record) => checkTakeover(cluster, input, options, record),
    cluster.dump,
  );
}

/**
 * Checks a hand-back once the person asked for it: the task goes ready from the source, the next attempt starts from
 * the work position, and submits a branch holding the person's commit and c.txt. Live and scripted runs check alike.
 */
export function handbackChecks(cluster: Cluster, input: HandbackInput): Promise<ScenarioResult> {
  const scenario = `hand-back ${input.source === 'clone' ? 'from the clone' : 'by ref'}`;
  return checks(scenario, cluster.vendor, (record) => checkHandback(cluster, input, record), cluster.dump);
}

async function checkTakeover(
  cluster: Cluster,
  input: TakeoverInput,
  options: ScenarioOptions,
  record: Recorder,
): Promise<void> {
  const { person, origin, models, waitForEvent } = cluster;
  const scripted = options.scripted !== false;
  const { taskId, attemptId: a1, login } = input;
  await waitForEvent({ type: 'attempt.ended', subject: taskId, attemptId: a1 });
  const { attempt } = await person.attempt(a1);
  const { task, notes } = await person.task(taskId);
  record.equal(
    CHECKS.blocked,
    [task.status, task.blockedKind, task.blockedReason],
    ['blocked', 'takeover', `taken over by ${login}`],
  );
  const note = notes.find((entry) => entry.kind === 'handoff' && entry.attemptId === a1);
  record.check(
    CHECKS.handoff,
    note !== undefined &&
      note.author === `agent:${attempt.agentId}` &&
      note.createdAt <= (attempt.endedAt ?? 0) &&
      (scripted ? note.body === HANDOFF : note.body !== ''),
    note === undefined
      ? `${a1} wrote no handoff note`
      : `${note.author} at ${note.createdAt}, ended at ${attempt.endedAt}: ${shown(note.body)}`,
  );
  record.equal(
    CHECKS.ended,
    [attempt.status, attempt.endReason, attempt.takeover?.error ?? null],
    ['ended', 'taken_over', null],
  );

  // The commands: the pinned binary of a1's CLI version under the runner's home, with its vendor home and a1's session.
  const runner = await cluster.runnerOf(a1);
  const { paths, config } = runner.home;
  const clone = runner.clonePath(a1);
  const pins = VENDOR_PINS[E2E_PLATFORM];
  if (!pins) throw new Error(`VENDOR_PINS has no ${E2E_PLATFORM} entry`);
  const binary = join(paths.runner, vendorBinary(attempt.vendor, pins[attempt.vendor].version));
  const home = vendorHomes(config, paths)[attempt.vendor];
  const session = attempt.sessionRef;
  const resume =
    attempt.vendor === 'claude'
      ? `CLAUDE_CONFIG_DIR=${home} ${binary} --resume ${session}`
      : `CODEX_HOME=${home} ${binary} resume --no-daemon ${session}`;
  const local = `cd ${clone} && ${resume}`;
  // With scripted models, the session is the one a1's requests carried; real models record none.
  const seen = scripted ? [...new Set(models.requestsFor(a1).map(sessionOf))] : [];
  record.check(
    CHECKS.local,
    session !== null && attempt.takeover?.local === local && (!scripted || seen.includes(session)),
    `got ${shown(attempt.takeover?.local)}, expected ${shown(local)}; sessions seen ${shown(seen)}`,
  );
  const ref = takeoverRef(DEFAULT_WIP_REF_PREFIX, taskId, login);
  const anywhere =
    `git fetch origin ${attempt.wipRef} && git switch -c ${task.branch} FETCH_HEAD\n` + `git push origin HEAD:${ref}`;
  record.equal(CHECKS.anywhere, attempt.takeover?.anywhere, anywhere);
  record.equal(CHECKS.ref, attempt.takeover?.ref, ref);

  // The clone's .git: the runner's own, at the head it harvested, which the final WIP holds (under its snapshot).
  const wip = attempt.wipRef === null ? null : await refSha(origin.path, attempt.wipRef);
  let head: string | null = null;
  if (wip !== null) {
    const subject = await gitIn(origin.path, ['log', '-1', '--format=%s', wip]);
    head = subject.startsWith(SNAPSHOT_SUBJECT) ? await gitIn(origin.path, ['rev-parse', `${wip}^`]) : wip;
  }
  const moved = join(paths.forensics(a1), 'git');
  const isDir = lstatSync(moved, { throwIfNoEntry: false })?.isDirectory() === true;
  const hasHead = lstatSync(join(moved, 'HEAD'), { throwIfNoEntry: false })?.isFile() === true;
  // git in the clone reads the repository's config, which runs programs (core.fsmonitor, clean filters) with the
  // owner's rights. Until the runner has moved the agent's .git aside and built its own, the agent's is still there.
  const dotGit = lstatSync(join(clone, '.git'), { throwIfNoEntry: false });
  const replaced =
    isDir &&
    hasHead &&
    dotGit?.isDirectory() === true &&
    attempt.takeover?.local != null &&
    attempt.takeover.error === null;
  if (replaced) {
    const cloneHead = await gitIn(clone, ['rev-parse', 'HEAD'], { allowFailure: true });
    const branch = await gitIn(clone, ['symbolic-ref', 'HEAD'], { allowFailure: true });
    const alternates = cloneFile(clone, '.git/objects/info/alternates') ?? '';
    record.check(
      CHECKS.gitReplaced,
      wip === attempt.wipSha &&
        head !== null &&
        cloneHead === head &&
        branch === `refs/heads/${task.branch}` &&
        alternates.includes(paths.vaults),
      `WIP ${wip} (hub ${attempt.wipSha}), harvested head ${head}; the clone's HEAD ${cloneHead} on ${branch}; ` +
        `alternates ${shown(alternates.trim())}`,
    );
    const status = await gitIn(
      clone,
      ['-c', 'core.fsmonitor=false', '--no-optional-locks', 'status', '--porcelain'],
      { allowFailure: true },
    );
    // A rebuilt index shows only b.txt: an index left empty would show every committed file as deleted and untracked.
    const lines = status.split('\n').filter((line) => line !== '');
    const tracked = new Set(
      (await gitIn(clone, ['ls-tree', '-r', '--name-only', 'HEAD'], { allowFailure: true })).split('\n'),
    );
    record.check(
      CHECKS.uncommitted,
      lines.includes('?? b.txt') && lines.every((line) => !tracked.has(line.slice(3))),
      `git status: ${shown(status)}`,
    );
  } else {
    const kind = dotGit === undefined ? 'missing' : dotGit.isDirectory() ? 'a directory' : 'not a directory';
    const why =
      `not run: the runner did not replace the clone's .git (.git ${kind}, moved .git ${isDir && hasHead}; ` +
      `local ${shown(attempt.takeover?.local ?? null)}, error ${shown(attempt.takeover?.error ?? null)})`;
    record.check(CHECKS.gitReplaced, false, why);
    record.check(CHECKS.uncommitted, false, why);
  }
  record.check(CHECKS.forensics, isDir && hasHead, `${moved}: directory ${isDir}, HEAD ${hasHead}`);
}

async function checkHandback(cluster: Cluster, input: HandbackInput, record: Recorder): Promise<void> {
  const { person, origin, waitFor, waitForEvent } = cluster;
  const { taskId, attemptId: a1, source, commit } = input;
  const parsed = parseAttemptId(a1);
  if (parsed === null) throw new Error(`not an attempt id: ${a1}`);
  const kind = source === 'clone' ? 'clone' : 'ref';
  const handed = await waitForEvent({ type: 'task.handed_back', subject: taskId, data: { attemptId: a1 } });
  // The same transaction moves the task to ready, just before task.handed_back.
  const ready = await waitForEvent({ type: 'task.ready', subject: taskId, data: { from: 'blocked', attemptId: a1 } });
  const ref = String(handed.data.ref);
  const sha = String(handed.data.sha);
  record.check(
    CHECKS.handedBack,
    handed.data.source === kind && ready.id <= handed.id,
    `task.handed_back #${handed.id} ${shown(handed.data)}; task.ready #${ready.id}`,
  );
  const { attempt } = await person.attempt(a1);
  const lateWork = (await person.events({ subject: taskId, limit: 1000 })).filter(
    (event: HubEvent) => event.type === 'attempt.late_work' && event.data.attemptId === a1,
  );
  const onOrigin = await refSha(origin.path, ref);
  const holds = onOrigin === sha && (await isAncestor(origin.path, commit, sha));
  const where =
    source === 'clone'
      ? ref.startsWith(`${attempt.wipRef}-late-`)
      : ref === source.ref && sha === source.sha && sha === commit;
  record.check(
    CHECKS.position,
    holds && where && lateWork.length === 0,
    `${ref} at ${sha} (origin ${onOrigin}), person's commit ${commit}; ` +
      `late work ${lateWork.map((event) => `#${event.id}`).join(', ') || 'none'}`,
  );

  // The next attempt starts from that position and submits on top of it.
  const next = attemptId(taskId, parsed.number + 1, parsed.epoch);
  const started = await waitFor(`${next}'s start`, async () => {
    const found = await person.attempt(next).catch(() => null);
    return found?.attempt.startSha ? found.attempt : null;
  });
  record.equal(CHECKS.startSha, started.startSha, sha);
  const submitted = await waitForEvent({ type: 'submission.recorded', subject: taskId, attemptId: next });
  const head = await refSha(origin.path, `refs/heads/${String(submitted.data.branch)}`);
  // The next attempt adds c.txt, as its program or the task's steps say.
  const added = head === null ? null : await fileAt(origin.path, head, 'c.txt');
  record.check(
    CHECKS.submitted,
    head !== null &&
      head === submitted.data.headSha &&
      (await isAncestor(origin.path, commit, head)) &&
      added === 'c\n',
    `branch ${String(submitted.data.branch)} at ${head} (submitted ${String(submitted.data.headSha)}); ` +
      `c.txt ${shown(added)}`,
  );
}
