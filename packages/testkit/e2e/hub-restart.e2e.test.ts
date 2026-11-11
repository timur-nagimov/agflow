// The hub can crash at any time (design 6.3, 6.6, 6.8, 6.14, 7.3, 10), per vendor. The harness SIGKILLs the hub while
// a worker is mid-task and keeps it down for longer than the runner lease. Meanwhile the agent keeps working: its
// report_progress gets the hub-unreachable answer, and the runner pushes WIP straight to origin within the WIP grace
// (X-11) and keeps the event in its outbox. When the hub starts again it opens a recovery window, extends the leases
// by the downtime and applies the replayed events; the attempt keeps its fence and its token, and its agent gets the
// one nudge (X-38). Runs only with AGFLOW_E2E=1.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { attemptId, BRIDGE_ANSWERS, DEFAULT_WIP_REF_PREFIX, type Fence, type NewTaskInput, wipRef } from '@agflow/core';
import { OUTAGE_NUDGE } from '@agflow/runner/src/attempt/turns';
import { fileAt, refSha } from '../src/git-fixtures';
import { type Cluster, startCluster } from '../src/harness/cluster';
import { describeE2e, E2E_TEST_TIMEOUT_MS, e2eVendors } from '../src/harness/env';
import { E2E_HUB_TIMINGS } from '../src/harness/hub-process';
import { GATE_DIR, gate, type Program, react, type ShellStep, say, shell, tool } from '../src/harness/playbook';
import type { RunnerProcess } from '../src/harness/runner-process';
import { newestEventId, waitAtGate } from '../src/scenarios/result';

setDefaultTimeout(E2E_TEST_TIMEOUT_MS);

const TASK: NewTaskInput = {
  title: 'Add a.txt, b.txt and c.txt across a hub crash',
  objective: 'Commit a.txt, write b.txt and report progress; once the hub is back, commit b.txt and c.txt and submit.',
  acceptance: [{ id: 'files', assertion: 'a.txt, b.txt and c.txt hold the lines a, b and c' }],
};

/** The gate a1 waits at until the hub is down; b.txt is written as it opens. */
const HUB_DOWN = 'hub-down';
/** The gate a1 waits at, after the nudge, until the recovery window has closed. */
const RECOVERED = 'recovered';

/** The progress a1 reports while the hub is down: the hub must never record it. */
const DOWNTIME_NOTE = 'b.txt is written while the hub is down.';
/** The progress a1 reports once the hub is back. */
const AFTER_NOTE = 'The hub is back; b.txt is written, and c.txt comes next.';

/** How much longer than the runner lease the hub stays down. */
const DOWNTIME_MARGIN_MS = 5_000;

/**
 * A gate that runs cmd as it opens, in the same command: the work lands within the gate's poll of the opening, with
 * no model round trip, so the runner's WIP timer harvests it well inside the WIP grace after the hub's last answer.
 */
function gateThen(name: string, cmd: string): ShellStep {
  const step = gate(name);
  return { ...step, cmd: `${step.cmd} && ${cmd}` };
}

/**
 * a1 commits a.txt, waits for the hub to go down, writes b.txt and reports progress, which fails; its turn ends there.
 * The nudge then starts its next turn: it waits for the recovery window to close, reports progress again, commits
 * b.txt and c.txt, and submits.
 */
function program(taskId: string): Program {
  return {
    steps: [
      say(
        'I add a.txt and commit it.',
        shell("printf 'a\\n' > a.txt && git add a.txt && git commit -q -m 'Add a.txt'"),
      ),
      say('I write b.txt once the hub is down.', gateThen(HUB_DOWN, "printf 'b\\n' > b.txt")),
      say('I report my progress.', tool('report_progress', { task_id: taskId, note: DOWNTIME_NOTE })),
    ],
    reactions: [
      react(OUTAGE_NUDGE, [
        gate(RECOVERED),
        say('I report my progress again.', tool('report_progress', { task_id: taskId, note: AFTER_NOTE })),
        say(
          'I add c.txt and commit b.txt and c.txt.',
          shell("printf 'c\\n' > c.txt && git add b.txt c.txt && git commit -q -m 'Add b.txt and c.txt'"),
        ),
        say('I submit the task.', tool('submit', { task_id: taskId, summary: 'a.txt, b.txt and c.txt are in.' })),
      ]),
    ],
  };
}

/** Opens a gate in the clone as cluster.openGate does, without asking the hub where the attempt runs: it is down. */
function openGateOn(runner: RunnerProcess, attempt: string, name: string): void {
  const file = join(runner.clonePath(attempt), GATE_DIR, name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, '');
}

/** How often the marker occurs in the text. */
function occurrences(text: string, marker: string): number {
  return text.split(marker).length - 1;
}

/** What the tests share once a1 waits at its first gate. */
interface Run {
  taskId: string;
  a1: string;
  ref: string;
  runner: RunnerProcess;
  /** a1's fence before the crash. */
  fence: Fence;
  /** The newest event before the crash. */
  before: number;
  /** When the hub was killed and started again. */
  killedAt: number;
  restartedAt: number;
  /** The WIP the runner pushed to origin while the hub was down. */
  downtimeSha: string;
}

describeE2e('hub restart', () => {
  for (const vendor of e2eVendors()) {
    describe(vendor, () => {
      let started: Cluster | null = null;
      let run: Partial<Run> = {};
      const cluster = (): Cluster => {
        if (started === null) throw new Error('the cluster did not start');
        return started;
      };
      const ran = <K extends keyof Run>(key: K): Run[K] => {
        const value = run[key];
        if (value === undefined) throw new Error(`an earlier test did not get as far as ${key}`);
        return value as Run[K];
      };

      beforeAll(async () => {
        started = await startCluster({ vendor });
        const { person, origin, models, waitFor, waitForEvent } = started;
        run = await started.step(async () => {
          const [task] = await person.createTasks([TASK]);
          if (!task) throw new Error('the hub created no task');
          const a1 = attemptId(task.id, 1, 1);
          const ref = wipRef(DEFAULT_WIP_REF_PREFIX, a1);
          models.addPrograms({ [a1]: program(task.id) });
          await waitForEvent({ type: 'attempt.running', subject: task.id, attemptId: a1 });
          await waitAtGate(cluster(), a1, HUB_DOWN, {});
          // The hub has a WIP with a.txt and without b.txt: only the downtime's push can bring b.txt.
          await waitFor(`the hub's WIP of ${a1} with a.txt`, async () => {
            const { attempt } = await person.attempt(a1);
            return attempt.wipSha !== null && (await fileAt(origin.path, attempt.wipSha, 'a.txt')) === 'a\n';
          });
          const { attempt } = await person.attempt(a1);
          const runner = await cluster().runnerOf(a1);
          return { taskId: task.id, a1, ref, runner, fence: attempt.fence, before: await newestEventId(cluster()) };
        });
      });

      afterAll(async () => {
        await started?.close();
      });

      test('while the hub is down, report_progress answers hub-unreachable, and the runner pushes the WIP holding b.txt to origin', () =>
        cluster().step(async () => {
          const { hub, origin, models, waitFor } = cluster();
          const a1 = ran('a1');
          const ref = ran('ref');
          run.killedAt = Date.now();
          await hub.kill();
          openGateOn(ran('runner'), a1, HUB_DOWN);
          run.downtimeSha = await waitFor(`the WIP of ${a1} with b.txt on origin`, async () => {
            const sha = await refSha(origin.path, ref);
            return sha !== null && (await fileAt(origin.path, sha, 'b.txt')) === 'b\n' ? sha : null;
          });
          expect(hub.running).toBe(false);
          expect(await fileAt(origin.path, run.downtimeSha, 'a.txt')).toBe('a\n');
          await waitFor(`${a1}'s report_progress to answer that the hub is unreachable`, async () =>
            models.sawText(a1, BRIDGE_ANSWERS.hubUnreachable),
          );
          // Down for longer than the runner lease: without the recovery, the hub would end a1 lost at its first tick.
          await Bun.sleep(Math.max(0, run.killedAt + E2E_HUB_TIMINGS.runnerLeaseMs + DOWNTIME_MARGIN_MS - Date.now()));
          expect(hub.running).toBe(false);
          run.restartedAt = Date.now();
          await hub.start();
        }));

      test('after the restart, system.recovery_started is emitted, and a1 is not lost and keeps its fence', () =>
        cluster().step(async () => {
          const { person, waitFor, waitForEvent } = cluster();
          const a1 = ran('a1');
          const recovery = await waitForEvent({ type: 'system.recovery_started' }, { after: ran('before') });
          expect(Number(recovery.data.gapMs)).toBeGreaterThan(E2E_HUB_TIMINGS.runnerLeaseMs);
          // The runner is back, and the hub has ticked with it.
          const restartedAt = ran('restartedAt');
          await waitFor(`${a1}'s runner to be seen after the restart`, async () => {
            const { attempt } = await person.attempt(a1);
            const runner = (await person.runners()).runners.find((entry) => entry.id === attempt.runnerId);
            return runner !== undefined && runner.lastSeenAt > restartedAt + E2E_HUB_TIMINGS.tickMs;
          });
          const { attempt } = await person.attempt(a1);
          expect(attempt.status).not.toBe('ended');
          expect(attempt.endReason).toBeNull();
          expect(attempt.fence).toEqual(ran('fence'));
          // No resume, and so no new token: the attempt goes on as it was.
          const since = await person.events({ after: ran('before'), subject: ran('taskId'), limit: 1000 });
          const about = since.filter((event) => event.data.attemptId === a1).map((event) => event.type);
          expect(about).not.toContain('attempt.resumed');
          expect(about).not.toContain('attempt.ended');
        }));

      test("the replayed attempt.wip from the downtime is applied: the hub's WIP and the task's work position are origin's", () =>
        cluster().step(async () => {
          const { person, origin, waitForEvent } = cluster();
          const a1 = ran('a1');
          const sha = ran('downtimeSha');
          const match = { type: 'attempt.wip', subject: ran('taskId'), attemptId: a1, data: { sha } };
          await waitForEvent(match, { after: ran('before') });
          expect(await refSha(origin.path, ran('ref'))).toBe(sha);
          const { attempt } = await person.attempt(a1);
          expect([attempt.wipRef, attempt.wipSha]).toEqual([ran('ref'), sha]);
          const { task } = await person.task(ran('taskId'));
          expect([task.workRef, task.workSha]).toEqual([ran('ref'), sha]);
        }));

      test('once the link is back, the agent gets "the agflow hub is reachable again; retry the tool that failed" once', () =>
        cluster().step(async () => {
          const { models } = cluster();
          const a1 = ran('a1');
          // The nudge starts the turn whose first step is the gate: the request it answered shows what a1 got.
          await waitAtGate(cluster(), a1, RECOVERED, {});
          const atGate = models
            .requestsFor(a1)
            .find(({ answer }) => answer?.kind === 'step' && answer.step.kind === 'shell' && answer.step.gate === RECOVERED);
          expect(occurrences(atGate?.text ?? '', OUTAGE_NUDGE)).toBe(1);
        }));

      test('system.recovery_ended follows after recoveryMs; report_progress then works, the downtime progress is absent, and a1 submits', () =>
        cluster().step(async () => {
          const { person, origin, models, waitForEvent } = cluster();
          const a1 = ran('a1');
          const taskId = ran('taskId');
          const recovery = await waitForEvent({ type: 'system.recovery_started' }, { after: ran('before') });
          const ended = await waitForEvent({ type: 'system.recovery_ended' }, { after: recovery.id });
          const until = Number(recovery.data.until);
          expect(Math.abs(until - recovery.ts - E2E_HUB_TIMINGS.recoveryMs)).toBeLessThan(E2E_HUB_TIMINGS.tickMs);
          expect(ended.ts).toBeGreaterThanOrEqual(until);
          await cluster().openGate(a1, RECOVERED);
          const submitted = await waitForEvent({ type: 'submission.recorded', subject: taskId, attemptId: a1 });
          const progress = (await person.task(taskId)).notes.filter((note) => note.kind === 'progress');
          expect(progress.map((note) => note.body)).toContain(AFTER_NOTE);
          expect(progress.map((note) => note.body)).not.toContain(DOWNTIME_NOTE);
          const head = await refSha(origin.path, `refs/heads/${String(submitted.data.branch)}`);
          expect(head).toBe(String(submitted.data.headSha));
          const files = ['a.txt', 'b.txt', 'c.txt'].map((file) => fileAt(origin.path, head ?? '', file));
          expect(await Promise.all(files)).toEqual(['a\n', 'b\n', 'c\n']);
          // One attempt all along, and one nudge in its whole conversation.
          expect((await cluster().attemptsOf(taskId)).map((attempt) => attempt.id)).toEqual([a1]);
          expect(occurrences(models.requestsFor(a1).at(-1)?.text ?? '', OUTAGE_NUDGE)).toBe(1);
        }));
    });
  }
});
