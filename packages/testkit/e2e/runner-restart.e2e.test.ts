// A runner restart must not cost the attempt (design 6.3, 6.4, 7.1, 7.4, 8.4, 9.4), per vendor. On SIGTERM the runner
// suspends: it pushes WIP without a handoff turn, reports the exit as a suspend and exits 0, and on its next hello the
// hub resumes the attempt at a new fence in the agent's own session. After a SIGKILL the restarted runner kills what
// is left of the attempt and sweeps its clone before hello, and the hub resumes it the same way. Each case runs in a
// cluster of its own: a second runner-restart resume within resumeWindowMs would end the attempt crashed. Runs only
// with AGFLOW_E2E=1.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { attemptId, DEFAULT_WIP_REF_PREFIX, type Fence, type NewTaskInput, wipRef } from '@agflow/core';
import { type ProcessIdentity, processIdentity, sameProcess } from '@agflow/runner/src/processes';
import { fileAt, isAncestor, refSha } from '../src/git-fixtures';
import { type Cluster, startCluster } from '../src/harness/cluster';
import { describeE2e, E2E_TEST_TIMEOUT_MS, e2eVendors } from '../src/harness/env';
import { callIdsIn, type RecordedRequest, sessionOf } from '../src/harness/models';
import { GATE_DIR, gate, type Program, say, shell, stepCallId, tool } from '../src/harness/playbook';
import { processesInDir } from '../src/harness/proc';
import type { RunnerProcess } from '../src/harness/runner-process';
import { cloneFile, newestEventId, waitAtGate } from '../src/scenarios/result';

setDefaultTimeout(E2E_TEST_TIMEOUT_MS);

const TASK: NewTaskInput = {
  title: 'Add a.txt, b.txt and c.txt across a runner restart',
  objective: 'Commit a.txt, write b.txt, and after the runner restarts commit b.txt and c.txt, then submit.',
  acceptance: [{ id: 'files', assertion: 'a.txt, b.txt and c.txt hold the lines a, b and c' }],
};

/**
 * The gate that holds a1 in a running command until its runner goes down. The restart interrupts it, and the
 * interrupted call has a result (an interrupted Bash call, an aborted exec cell), so after the resume the gate counts
 * as run and a1 goes on with step 3 at once.
 */
const RESTARTED = 'restarted';

/** What a reconciliation resume tells the agent (design 6.3, resume_attempt). */
const RESTART_PROMPT = 'the runner restarted; continue from your last step';

function program(taskId: string): Program {
  return {
    steps: [
      say(
        'I add a.txt and commit it.',
        shell("printf 'a\\n' > a.txt && git add a.txt && git commit -q -m 'Add a.txt'"),
      ),
      say('I start b.txt and leave it uncommitted for now.', shell("printf 'b\\n' > b.txt")),
      gate(RESTARTED),
      say(
        'I add c.txt and commit b.txt and c.txt.',
        shell("printf 'c\\n' > c.txt && git add b.txt c.txt && git commit -q -m 'Add b.txt and c.txt'"),
      ),
      say('I submit the task.', tool('submit', { task_id: taskId, summary: 'a.txt, b.txt and c.txt are in.' })),
    ],
  };
}

/** One attempt, waiting at its gate with a.txt committed and b.txt uncommitted. */
interface AtGate {
  taskId: string;
  a1: string;
  runner: RunnerProcess;
  clone: string;
  fence: Fence;
  /** The session (Claude) or thread (Codex) the agent's requests carried before the restart. */
  session: string;
  /** The newest event before the runner went down. */
  before: number;
}

async function startAtGate(cluster: Cluster): Promise<AtGate> {
  const { person, models, waitFor, waitForEvent } = cluster;
  const [task] = await person.createTasks([TASK]);
  if (!task) throw new Error('the hub created no task');
  const a1 = attemptId(task.id, 1, 1);
  models.addPrograms({ [a1]: program(task.id) });
  await waitForEvent({ type: 'attempt.running', subject: task.id, attemptId: a1 });
  await waitAtGate(cluster, a1, RESTARTED, {});
  const runner = await cluster.runnerOf(a1);
  const clone = runner.clonePath(a1);
  await waitFor(`b.txt in ${a1}'s clone`, async () => cloneFile(clone, 'b.txt') !== null);
  // The model's answer is not yet the command: the restart must find the gate running in the clone. For both vendors
  // the perl gate, and the shell that wraps it, carry the gate's file in their command lines.
  const gateFile = `${GATE_DIR}/${RESTARTED}`;
  await waitFor(`${a1}'s gate command in its clone`, async () =>
    (await processesInDir(clone)).some((row) => row.command.includes(gateFile)),
  );
  const { attempt } = await person.attempt(a1);
  const last = models.requestsFor(a1).at(-1);
  const session = last ? sessionOf(last) : null;
  // A resume checks for the same session or thread: without an id to compare, that check would prove nothing.
  if (session === null) throw new Error(`${a1}'s model requests carry no session or thread id`);
  return { taskId: task.id, a1, runner, clone, fence: attempt.fence, session, before: await newestEventId(cluster) };
}

/** After the runner is back: a1 resumes at a higher fence in the same session, and no second attempt starts. */
async function expectResumed(cluster: Cluster, at: AtGate): Promise<RecordedRequest> {
  const { models, waitFor, waitForEvent } = cluster;
  const match = { type: 'attempt.resumed', subject: at.taskId, attemptId: at.a1 };
  const resumed = await waitForEvent(match, { after: at.before });
  const fence = resumed.data.fence as Fence;
  expect(fence.epoch).toBe(at.fence.epoch);
  expect(fence.counter).toBeGreaterThan(at.fence.counter);
  expect((await cluster.person.attempt(at.a1)).attempt.fence.counter).toBeGreaterThanOrEqual(fence.counter);
  const restarted = await waitFor(`${at.a1}'s model to be told the runner restarted`, async () =>
    models.requestsFor(at.a1).find((request) => request.text.includes(RESTART_PROMPT)),
  );
  // The agent's own session goes on: the earlier steps are in its history, under the same session or thread.
  expect(callIdsIn(restarted)).toContain(stepCallId(1));
  expect(sessionOf(restarted)).toBe(at.session);
  expect((await cluster.attemptsOf(at.taskId)).map((attempt) => attempt.id)).toEqual([at.a1]);
  return restarted;
}

/** The resumed agent passes its gate and submits a branch with the work from before and after the restart. */
async function expectSubmitted(cluster: Cluster, at: AtGate): Promise<void> {
  const { origin, waitForEvent } = cluster;
  // The resumed agent counts the interrupted gate as run; opening it is only a safeguard for a CLI that runs it again.
  await cluster.openGate(at.a1, RESTARTED);
  const submitted = await waitForEvent({ type: 'submission.recorded', subject: at.taskId, attemptId: at.a1 });
  const head = await refSha(origin.path, `refs/heads/${String(submitted.data.branch)}`);
  expect(head).toBe(String(submitted.data.headSha));
  const files = await Promise.all(['a.txt', 'b.txt', 'c.txt'].map((file) => fileAt(origin.path, head ?? '', file)));
  expect(files).toEqual(['a\n', 'b\n', 'c\n']);
  expect((await cluster.attemptsOf(at.taskId)).map((attempt) => attempt.id)).toEqual([at.a1]);
}

describeE2e('runner restart', () => {
  for (const vendor of e2eVendors()) {
    describe(`${vendor}: SIGTERM suspends`, () => {
      let started: Cluster | null = null;
      let at: AtGate | null = null;
      /** The WIP the suspend pushed, which test 1 checked: the work from before the restart. */
      let suspendWip: string | null = null;
      const cluster = (): Cluster => {
        if (started === null) throw new Error('the cluster did not start');
        return started;
      };
      const atGate = (): AtGate => {
        if (at === null) throw new Error('the attempt never reached its gate');
        return at;
      };

      beforeAll(async () => {
        started = await startCluster({ vendor });
        const cluster = started;
        at = await cluster.step(() => startAtGate(cluster));
      });

      afterAll(async () => {
        await started?.close();
      });

      test("on SIGTERM the runner exits 0 within its suspend timing; origin's WIP holds both kinds of work; a1 stays open", () =>
        cluster().step(async () => {
          const { origin, person, models, waitForEvent } = cluster();
          const { runner, a1, clone } = atGate();
          const runnerId = (await person.attempt(a1)).attempt.runnerId ?? '';
          const ref = wipRef(DEFAULT_WIP_REF_PREFIX, a1);
          // A change the periodic WIP push cannot have seen yet, so only the suspend's own push can bring it.
          const seen = models.requestsFor(a1).length;
          const before = await refSha(origin.path, ref);
          writeFileSync(join(clone, 'suspend.txt'), 'suspend\n');
          const stopping = Date.now();
          await runner.stop();
          expect(runner.exitCode).toBe(0);
          expect(Date.now() - stopping).toBeLessThanOrEqual(runner.home.config.timings.suspend);
          // The suspend pushed WIP before it exited: a snapshot of b.txt and suspend.txt over the commit of a.txt.
          const sha = await refSha(origin.path, ref);
          expect(sha).not.toBeNull();
          expect(sha).not.toBe(before);
          expect(await fileAt(origin.path, sha ?? '', 'a.txt')).toBe('a\n');
          expect(await fileAt(origin.path, sha ?? '', 'b.txt')).toBe('b\n');
          expect(await fileAt(origin.path, sha ?? '', 'suspend.txt')).toBe('suspend\n');
          expect(await fileAt(origin.path, `${sha}^`, 'b.txt')).toBeNull();
          // Without a handoff turn: the model got no request while the runner suspended.
          expect(models.requestsFor(a1).length).toBe(seen);
          suspendWip = sha;
          // A submission needs a clean clone, and the agent commits only its own files: suspend.txt goes before the
          // runner starts again.
          rmSync(join(clone, 'suspend.txt'));
          // Once the hub has seen the runner go, a1 is still open: a suspend is not an ending.
          await waitForEvent({ type: 'runner.offline', subject: runnerId }, { after: atGate().before });
          const { attempt } = await person.attempt(a1);
          expect(attempt.status).not.toBe('ended');
          expect(attempt.wipSha).toBe(sha);
        }));

      test('after start, the hub resumes a1 at a higher fence with attempt.resumed and no second attempt; its model resumes the same session', () =>
        cluster().step(async () => {
          await atGate().runner.start();
          await expectResumed(cluster(), atGate());
        }));

      test('the resumed agent finishes and submits a branch with the work from before and after the restart', () =>
        cluster().step(async () => {
          const { origin } = cluster();
          if (suspendWip === null) throw new Error("the first test did not check the suspend's WIP");
          await expectSubmitted(cluster(), atGate());
          const branch = (await cluster().person.task(atGate().taskId)).task.branch ?? '';
          const head = await refSha(origin.path, `refs/heads/${branch}`);
          // The commit of a.txt under the suspend's WIP, from before the restart, is under the submitted head.
          expect(await isAncestor(origin.path, `${suspendWip}^`, head ?? '')).toBe(true);
        }));
    });

    describe(`${vendor}: SIGKILL crashes`, () => {
      let started: Cluster | null = null;
      const cluster = (): Cluster => {
        if (started === null) throw new Error('the cluster did not start');
        return started;
      };

      beforeAll(async () => {
        started = await startCluster({ vendor });
      });

      afterAll(async () => {
        await started?.close();
      });

      test("after SIGKILL of the runner alone and a start, nothing that ran in a1's clone survives the runner's return; a1 resumes and submits", () =>
        cluster().step(async () => {
          const at = await startAtGate(cluster());
          const { runner, clone, a1 } = at;
          // Each process of the attempt, by pid and start time: the agent, and whatever runs in the clone.
          const inClone = await processesInDir(clone);
          expect(inClone.length).toBeGreaterThan(0);
          const before: ProcessIdentity[] = [await runner.agentOf(a1), ...inClone];
          await runner.kill();
          await runner.start();
          const survivors: ProcessIdentity[] = [];
          for (const old of before) {
            const now = await processIdentity(old.pid);
            if (now !== null && sameProcess(now, old)) survivors.push(old);
          }
          expect(survivors).toEqual([]);
          await expectResumed(cluster(), at);
          await expectSubmitted(cluster(), at);
        }));
    });
  }
});
