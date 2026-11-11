// A restore rolls the hub back (design 6.3, 6.4, 6.5, 6.13, 6.14), per vendor. The harness restarts the hub, so that
// its start backup knows the running attempt, then restarts the attempt's runner, so that the hub resumes the attempt
// at a fence newer than the backup's, and lets the agent push more WIP at that fence. It then stops the hub and
// restores that backup. The restored hub (epoch 2) first applies the events the runner replays up to hello.lastSeq,
// taking replayed events with a newer fence as current, so the newer WIP becomes the work position; only then does it
// re-fence the attempt through resume_attempt (X-1). Ids created after the restore embed the epoch and the advanced
// counters, so nothing collides with what existed before. Runs only with AGFLOW_E2E=1.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import {
  attemptId,
  compareFence,
  DEFAULT_WIP_REF_PREFIX,
  type Fence,
  type HubEvent,
  type NewTaskInput,
  taskBranchName,
  wipRef,
} from '@agflow/core';
import { handoffPrompt } from '@agflow/runner/src/attempt/stop';
import { type ProcessIdentity, processIdentity, sameProcess } from '@agflow/runner/src/processes';
import { fileAt, refSha } from '../src/git-fixtures';
import { type Cluster, startCluster } from '../src/harness/cluster';
import { describeE2e, E2E_TEST_TIMEOUT_MS, e2eVendors } from '../src/harness/env';
import { callIdsIn, sessionOf } from '../src/harness/models';
import { GATE_DIR, gate, type Program, say, shell, stepCallId, tool } from '../src/harness/playbook';
import { processesInDir } from '../src/harness/proc';
import { cloneFile, newestEventId, waitAtGate } from '../src/scenarios/result';

setDefaultTimeout(E2E_TEST_TIMEOUT_MS);

const TASK: NewTaskInput = {
  title: 'Add a.txt, b.txt and c.txt across a hub restore',
  objective:
    'Commit a.txt, write b.txt, and after the hub is restored report progress, commit b.txt and c.txt, then submit.',
  acceptance: [{ id: 'files', assertion: 'a.txt, b.txt and c.txt hold the lines a, b and c' }],
};

/** The task created after the restore. */
const LATER_TASK: NewTaskInput = {
  title: 'Add d.txt after the restore',
  objective: 'Commit d.txt holding the line "d" and submit.',
  acceptance: [{ id: 'file', assertion: 'd.txt holds the line d' }],
};

/**
 * The gate a1 waits in until the hub's start backup knows it. The runner restart that gives a1 a newer fence
 * interrupts it, and the resumed agent counts the interrupted call as run.
 */
const BACKED_UP = 'backed-up';
/**
 * The gate a1 waits in, with b.txt pushed at the newer fence, while the hub is restored. The restore's resume stops
 * the agent and so interrupts it too.
 */
const RESTORED = 'restored';
/** The gate the agent resumed after the restore waits at, so nothing newer than the replayed WIP exists meanwhile. */
const RESUMED = 'resumed';

/** The progress a1 reports once re-fenced: its bridge call must work with the new token. */
const PROGRESS_NOTE = 'The hub was restored; b.txt is written, and c.txt comes next.';

/** What a restore's resume tells the agent (design 6.3, resume_attempt). */
const RESTART_PROMPT = 'the runner restarted; continue from your last step';

/** How the runner's handoff turn starts: a resume stops the live agent without one. */
const HANDOFF_TURN = handoffPrompt('<reason>').split('<reason>')[0] ?? '';

/** Ids above this were handed out after the restore: the restore advances each counter by 1000. */
const ADVANCED = 1000;

function program(taskId: string): Program {
  return {
    steps: [
      say(
        'I add a.txt and commit it.',
        shell("printf 'a\\n' > a.txt && git add a.txt && git commit -q -m 'Add a.txt'"),
      ),
      gate(BACKED_UP),
      say('I start b.txt and leave it uncommitted for now.', shell("printf 'b\\n' > b.txt")),
      gate(RESTORED),
      gate(RESUMED),
      say('I report my progress.', tool('report_progress', { task_id: taskId, note: PROGRESS_NOTE })),
      say(
        'I add c.txt and commit b.txt and c.txt.',
        shell("printf 'c\\n' > c.txt && git add b.txt c.txt && git commit -q -m 'Add b.txt and c.txt'"),
      ),
      say('I submit the task.', tool('submit', { task_id: taskId, summary: 'a.txt, b.txt and c.txt are in.' })),
    ],
  };
}

function laterProgram(taskId: string): Program {
  return {
    steps: [
      say(
        'I add d.txt and commit it.',
        shell("printf 'd\\n' > d.txt && git add d.txt && git commit -q -m 'Add d.txt'"),
      ),
      say('I submit the task.', tool('submit', { task_id: taskId, summary: 'd.txt holds the line d.' })),
    ],
  };
}

/** The number in an id such as T-1001 or S-1001. */
function idNumber(id: string): number {
  return Number(id.match(/-(\d+)$/)?.[1] ?? Number.NaN);
}

/** What the tests share. */
interface Run {
  taskId: string;
  a1: string;
  ref: string;
  /** The task's branch before the restore. */
  branch: string;
  /** a1's fence in the hub's start backup. */
  backupFence: Fence;
  /** a1's agent, fence and session while it waited for the restore: the fence is newer than backupFence. */
  agent: ProcessIdentity;
  fence: Fence;
  session: string;
  /** The WIP a1 pushed at its newer fence after the backup: the restored hub learns it only from the replay. */
  afterBackupSha: string;
  restored: HubEvent;
  resumed: HubEvent;
}

describeE2e('hub restore', () => {
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
        const { person, models, waitFor, waitForEvent } = started;
        run = await started.step(async () => {
          const [task] = await person.createTasks([TASK]);
          if (!task) throw new Error('the hub created no task');
          const a1 = attemptId(task.id, 1, 1);
          models.addPrograms({ [a1]: program(task.id) });
          await waitForEvent({ type: 'attempt.running', subject: task.id, attemptId: a1 });
          await waitAtGate(cluster(), a1, BACKED_UP, {});
          const clone = (await cluster().runnerOf(a1)).clonePath(a1);
          await waitFor(`a.txt in ${a1}'s clone`, async () => cloneFile(clone, 'a.txt') !== null);
          const branch = (await person.task(task.id)).task.branch;
          if (branch === null) throw new Error(`${task.id} has no branch`);
          return { taskId: task.id, a1, ref: wipRef(DEFAULT_WIP_REF_PREFIX, a1), branch };
        });
      });

      afterAll(async () => {
        await started?.close();
      });

      test('after the restore GET /api/status has epoch 2, and a system.restored event is recorded', () =>
        cluster().step(async () => {
          const { hub, person, origin, models, waitFor, waitForEvent } = cluster();
          const a1 = ran('a1');
          const taskId = ran('taskId');
          // A restart, so that the hub's start backup knows a1 as it runs; a hub restart keeps a1's fence.
          const backupsBefore = hub.backups('start').length;
          await hub.restart();
          const backups = hub.backups('start');
          expect(backups.length).toBeGreaterThan(backupsBefore);
          const backup = backups.at(-1) as string;
          run.backupFence = (await person.attempt(a1)).attempt.fence;
          const afterRestart = await newestEventId(cluster());
          // A runner restart, so that the hub resumes a1 at a fence the backup does not know (X-1). The suspend must
          // find the gate running in the clone: it interrupts the gate, and the resumed agent counts it as run. This is
          // the one runner-restart resume within resumeWindowMs; the restore's own resume does not count.
          const runner = await cluster().runnerOf(a1);
          const clone = runner.clonePath(a1);
          const gateFile = `${GATE_DIR}/${BACKED_UP}`;
          await waitFor(`${a1}'s gate command in its clone`, async () =>
            (await processesInDir(clone)).some((row) => row.command.includes(gateFile)),
          );
          await runner.stop();
          await runner.start();
          const refenced = await waitForEvent(
            { type: 'attempt.resumed', subject: taskId, attemptId: a1 },
            { after: afterRestart },
          );
          const fence = refenced.data.fence as Fence;
          expect(fence.epoch).toBe(1);
          expect(compareFence(fence, run.backupFence)).toBeGreaterThan(0);
          // Only a safeguard for a CLI that runs the interrupted gate again.
          await cluster().openGate(a1, BACKED_UP);
          // At the newer fence, a1 writes b.txt, and the hub records the WIP that holds it.
          const wip = await waitFor(`a WIP of ${a1} with b.txt after its resume`, async () => {
            const events = await person.events({ after: refenced.id, subject: taskId, limit: 1000 });
            const pushed = events.filter((event) => event.type === 'attempt.wip' && event.data.attemptId === a1);
            for (const event of pushed.reverse()) {
              if ((await fileAt(origin.path, String(event.data.sha), 'b.txt')) === 'b\n') return event;
            }
            return null;
          });
          run.afterBackupSha = String(wip.data.sha);
          await waitAtGate(cluster(), a1, RESTORED, {});
          const { attempt } = await person.attempt(a1);
          expect(attempt.wipSha).toBe(run.afterBackupSha);
          expect(attempt.fence).toEqual(fence);
          run.fence = attempt.fence;
          run.agent = await runner.agentOf(a1);
          const last = models.requestsFor(a1).at(-1);
          const session = last ? sessionOf(last) : null;
          // The resume checks for the same session or thread: without an id to compare, that check would prove nothing.
          if (session === null) throw new Error(`${a1}'s model requests carry no session or thread id`);
          run.session = session;
          // The rollback.
          await hub.stop();
          await hub.restore(backup);
          await hub.start();
          expect((await person.status()).epoch).toBe(2);
          run.restored = await waitForEvent({ type: 'system.restored', data: { epoch: 2 } });
        }));

      test("the WIP pushed at the newer fence is applied before the re-fence, and it is a1's work position", () =>
        cluster().step(async () => {
          const { person, origin, waitForEvent } = cluster();
          const a1 = ran('a1');
          const taskId = ran('taskId');
          const restored = ran('restored');
          const afterBackupSha = ran('afterBackupSha');
          const resumedMatch = { type: 'attempt.resumed', subject: taskId, attemptId: a1 };
          run.resumed = await waitForEvent(resumedMatch, { after: restored.id });
          const replayed = await waitForEvent(
            { type: 'attempt.wip', subject: taskId, attemptId: a1, data: { sha: afterBackupSha } },
            { after: restored.id },
          );
          expect(replayed.id).toBeLessThan(run.resumed.id);
          // Its fence is newer than the one the restored hub holds, and the replay took it as current, not late work.
          expect(compareFence(ran('fence'), ran('backupFence'))).toBeGreaterThan(0);
          const since = await person.events({ after: restored.id, subject: taskId, limit: 1000 });
          expect(since.filter((event) => event.type === 'attempt.late_work')).toEqual([]);
          // The resumed agent waits at its gate, so nothing newer than the replayed WIP exists.
          await waitAtGate(cluster(), a1, RESUMED, {});
          expect(await refSha(origin.path, ran('ref'))).toBe(afterBackupSha);
          expect(await fileAt(origin.path, afterBackupSha, 'b.txt')).toBe('b\n');
          expect((await person.attempt(a1)).attempt.wipSha).toBe(afterBackupSha);
          expect((await person.task(taskId)).task.workSha).toBe(afterBackupSha);
        }));

      test('resume_attempt re-fences a1 at epoch 2: its agent is stopped without a handoff turn, its session goes on, its bridge calls work and it does not end', () =>
        cluster().step(async () => {
          const { person, models, waitFor } = cluster();
          const a1 = ran('a1');
          const fence = ran('resumed').data.fence as Fence;
          expect(ran('fence').epoch).toBe(1);
          expect(fence.epoch).toBe(2);
          expect((await person.attempt(a1)).attempt.fence.epoch).toBe(2);
          // The agent's own session goes on. Its first request after the restore is the one its program answered with
          // the RESUMED gate; its history holds the earlier steps and the resume prompts of the runner restart and the
          // restore.
          await waitAtGate(cluster(), a1, RESUMED, {});
          const resumed = models
            .requestsFor(a1)
            .find(
              ({ answer }) => answer?.kind === 'step' && answer.step.kind === 'shell' && answer.step.gate === RESUMED,
            );
          if (!resumed) throw new Error(`no request of ${a1} was answered with the gate ${RESUMED}`);
          expect(resumed.text.split(RESTART_PROMPT).length - 1).toBe(2);
          expect(callIdsIn(resumed)).toContain(stepCallId(2));
          expect(sessionOf(resumed)).toBe(ran('session'));
          expect(models.requestsFor(a1).some((request) => request.text.includes(HANDOFF_TURN))).toBe(false);
          // The process that waited at the gate is gone: the runner stopped it and started the resumed one.
          const old = ran('agent');
          const now = await processIdentity(old.pid);
          expect(now !== null && sameProcess(now, old)).toBe(false);
          // Through the gate, the resumed agent's report_progress works with the token of the new fence.
          await cluster().openGate(a1, RESUMED);
          const note = await waitFor(`${a1}'s progress note`, async () => {
            const { notes } = await person.task(ran('taskId'));
            return notes.find((entry) => entry.kind === 'progress' && entry.body === PROGRESS_NOTE);
          });
          const { attempt } = await person.attempt(a1);
          expect(note.author).toBe(`agent:${attempt.agentId}`);
          expect(attempt.status).not.toBe('ended');
          expect((await cluster().attemptsOf(ran('taskId'))).map((entry) => entry.id)).toEqual([a1]);
        }));

      test('a1 submits on the branch its attempt started with, and the submission id is above S-1000', () =>
        cluster().step(async () => {
          const { origin, waitForEvent } = cluster();
          const a1 = ran('a1');
          const submitted = await waitForEvent({ type: 'submission.recorded', subject: ran('taskId'), attemptId: a1 });
          expect(submitted.data.branch).toBe(ran('branch'));
          expect(ran('branch')).toBe(taskBranchName(ran('taskId'), TASK.title, 1));
          expect(idNumber(String(submitted.data.submissionId))).toBeGreaterThan(ADVANCED);
          const head = await refSha(origin.path, `refs/heads/${ran('branch')}`);
          expect(head).toBe(String(submitted.data.headSha));
          const files = ['a.txt', 'b.txt', 'c.txt'].map((file) => fileAt(origin.path, head ?? '', file));
          expect(await Promise.all(files)).toEqual(['a\n', 'b\n', 'c\n']);
        }));

      test('a task created after the restore gets an id above T-1000, and its attempt id, WIP ref and branch embed e2', () =>
        cluster().step(async () => {
          const { person, origin, models, waitForEvent } = cluster();
          const [task] = await person.createTasks([LATER_TASK]);
          if (!task) throw new Error('the hub created no task');
          expect(idNumber(task.id)).toBeGreaterThan(ADVANCED);
          const first = attemptId(task.id, 1, 2);
          expect(first).toBe(`${task.id}-e2-a1`);
          models.addPrograms({ [first]: laterProgram(task.id) });
          const submitted = await waitForEvent({ type: 'submission.recorded', subject: task.id, attemptId: first });
          expect((await cluster().attemptsOf(task.id)).map((attempt) => attempt.id)).toEqual([first]);
          const { attempt } = await person.attempt(first);
          const ref = `refs/agflow/${task.id}/e2-a1`;
          expect(wipRef(DEFAULT_WIP_REF_PREFIX, first)).toBe(ref);
          expect(attempt.wipRef).toBe(ref);
          expect(await refSha(origin.path, ref)).not.toBeNull();
          const branch = taskBranchName(task.id, LATER_TASK.title, 2);
          expect(branch.startsWith(`agflow/${task.id}-e2-`)).toBe(true);
          expect((await person.task(task.id)).task.branch).toBe(branch);
          expect(submitted.data.branch).toBe(branch);
          expect(await fileAt(origin.path, String(submitted.data.headSha), 'd.txt')).toBe('d\n');
        }));
    });
  }
});
