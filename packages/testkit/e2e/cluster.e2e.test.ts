// The cluster's smoke test (design 1, 6.4, 6.13, 7.8, 15): the whole chain, before any scenario relies on it. Per
// vendor: one hub process, three runners with the real CLI behind the scripted models, one task that commits a file
// and submits, its acceptance and the clone's cleanup. Runs only with AGFLOW_E2E=1; the root script check runs always.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { attemptId, DEFAULT_WIP_REF_PREFIX, taskBranchName, wipRef } from '@agflow/core';
import { processIdentity } from '@agflow/runner/src/processes';
import { fileAt, gitIn, refSha } from '../src/git-fixtures';
import { type Cluster, startCluster } from '../src/harness/cluster';
import { describeE2e, E2E_TEST_TIMEOUT_MS, e2eVendors } from '../src/harness/env';
import { E2E_HUB_TIMINGS, E2E_USERS } from '../src/harness/hub-process';
import { gate, type Next, type Program, say, shell, tool } from '../src/harness/playbook';
import { processesInDir } from '../src/harness/proc';

// Every step drives a real CLI through the hub and the runner; the cluster's start runs three runners' preflights.
setDefaultTimeout(E2E_TEST_TIMEOUT_MS);
const START_TIMEOUT_MS = 300_000;

const TASK = {
  title: 'Add hello.txt',
  objective: 'Add hello.txt, which says hello, and submit it.',
  acceptance: [{ id: 'hello', assertion: 'hello.txt says hello' }],
};

/** Commits hello.txt, waits at a gate while the test looks at the agent, then submits. */
function smokeProgram(taskId: string): Program {
  return {
    steps: [
      say(
        'I add hello.txt and commit it.',
        shell("printf 'hello\\n' > hello.txt && git add hello.txt && git commit -q -m 'Add hello.txt'"),
      ),
      gate('looked-at'),
      say('I submit the task.', tool('submit', { task_id: taskId, summary: 'Added hello.txt, which says hello.' })),
    ],
  };
}

test('root script `bun run e2e` runs packages/testkit/e2e with AGFLOW_E2E=1 under caffeinate -i, 10 minutes a test', () => {
  const manifest = JSON.parse(readFileSync(join(import.meta.dir, '../../../package.json'), 'utf8'));
  expect(manifest.scripts.e2e).toBe(
    `AGFLOW_E2E=1 caffeinate -i bun test --timeout ${E2E_TEST_TIMEOUT_MS} packages/testkit/e2e`,
  );
});

describeE2e('the cluster', () => {
  for (const vendor of e2eVendors()) {
    describe(vendor, () => {
      let started: Cluster | null = null;
      let taskId = '';
      let a1 = '';
      const cluster = (): Cluster => {
        if (started === null) throw new Error('the cluster did not start');
        return started;
      };

      beforeAll(async () => {
        started = await startCluster({ vendor });
      }, START_TIMEOUT_MS);

      afterAll(async () => {
        await started?.close();
      });

      test('three runners come online, owned by alice, bob and carol, and no lead starts while runner leads are off', () =>
        cluster().step(async () => {
          const { person, runners } = cluster();
          const online = (await person.runners()).runners;
          expect(online.map((runner) => [runner.owner, runner.name, runner.state]).sort()).toEqual(
            E2E_USERS.map((login) => [login, `${login}-mac`, 'online']),
          );
          expect(runners.map((runner) => runner.name)).toEqual(E2E_USERS.map((login) => `${login}-mac`));
          for (const runner of online) {
            expect(runner.vendors.filter((entry) => entry.ready).map((entry) => entry.vendor)).toEqual([vendor]);
          }
          // A few scheduler ticks with three free runners: still no lead.
          await Bun.sleep(3 * E2E_HUB_TIMINGS.tickMs);
          expect(await person.attempts({ role: 'lead' })).toEqual([]);
          expect((await person.status()).leadSeat.kind).toBe('none');
        }));

      test('while the attempt runs, agentOf gives its live agent, the leader of its own group, in the clone (Claude) or the codex user home with its commands in the clone (Codex)', () =>
        cluster().step(async () => {
          const { person, models, waitFor, waitForEvent } = cluster();
          const [task] = await person.createTasks([TASK]);
          if (!task) throw new Error('no task created');
          taskId = task.id;
          a1 = attemptId(taskId, 1, 1);
          models.addPrograms({ [a1]: smokeProgram(taskId) });
          await waitForEvent({ type: 'attempt.running', subject: taskId, attemptId: a1 });
          const gated = (answer: Next | null) =>
            answer?.kind === 'step' && answer.step.kind === 'shell' && answer.step.gate !== null;
          const atGate = () => models.requestsFor(a1).some((request) => gated(request.answer));
          await waitFor(`${a1} to wait at its gate`, async () => atGate());
          const runner = await cluster().runnerOf(a1);
          const agent = await runner.agentOf(a1);
          expect(agent.pgid).toBe(agent.pid);
          expect(await processIdentity(agent.pid)).toEqual(agent);
          const clone = runner.clonePath(a1);
          // Claude runs in the clone; Codex's app-server in the runner's codex user home, its commands in the clone.
          const home = vendor === 'claude' ? clone : runner.home.paths.homes.codexUser;
          expect((await processesInDir(home)).map((row) => row.pid)).toContain(agent.pid);
          // The gate's command starts after the model's answer, so it may not run yet.
          await waitFor(`a process in ${a1}'s clone`, async () => (await processesInDir(clone)).length > 0);
        }));

      test('the task is dispatched and ends submitted; origin has the task branch and the WIP ref at one commit', () =>
        cluster().step(async () => {
          const { origin, person, openGate, waitFor, waitForEvent } = cluster();
          await openGate(a1, 'looked-at');
          const recorded = await waitForEvent({ type: 'submission.recorded', subject: taskId });
          const branch = taskBranchName(taskId, TASK.title, 1);
          expect(recorded.data.branch).toBe(branch);
          const submitted = async () => (await person.task(taskId)).task.status === 'submitted';
          await waitFor(`${taskId} to be submitted`, submitted);
          const { attempt } = await person.attempt(a1);
          expect(attempt.status).toBe('holding');
          const head = await refSha(origin.path, `refs/heads/${branch}`);
          expect(head).not.toBeNull();
          expect(recorded.data.headSha).toBe(head);
          expect(await refSha(origin.path, wipRef(DEFAULT_WIP_REF_PREFIX, a1))).toBe(head);
          // The hold stops the agent; its exit report carries the final WIP, which the hub then holds too.
          const holds = async () => (await person.attempt(a1)).attempt.wipSha === head;
          await waitFor(`the hub to hold ${a1}'s final WIP`, holds);
          expect(await fileAt(origin.path, head ?? '', 'hello.txt')).toBe('hello\n');
          const files = (await gitIn(origin.path, ['ls-tree', '-r', '--name-only', head ?? ''])).split('\n');
          expect(files.filter((file) => file.startsWith('.agflow/run/'))).toEqual([]);
        }));

      test('after the person accepts, the attempt ends accepted and cleanup_attempt removes its clone', () =>
        cluster().step(async () => {
          const { person, runnerOf, waitFor, waitForEvent } = cluster();
          const clone = (await runnerOf(a1)).clonePath(a1);
          expect(existsSync(clone)).toBe(true);
          await person.accept(taskId);
          const ended = { type: 'attempt.ended', subject: taskId, attemptId: a1, data: { endReason: 'accepted' } };
          await waitForEvent(ended);
          expect((await person.attempt(a1)).attempt).toMatchObject({ status: 'ended', endReason: 'accepted' });
          await waitFor(`the clone of ${a1} to be removed`, async () => !existsSync(clone));
          // The submitted work is the accepted work: nothing of it counts as late.
          expect((await person.task(taskId)).notes.filter((note) => note.kind === 'late_work')).toEqual([]);
        }));

      test('a waitFor that times out throws an error that carries the cluster dump', () =>
        cluster().step(async () => {
          const { waitFor, runners } = cluster();
          const error = await waitFor('a thing that never happens', async () => false, { timeoutMs: 1_000 }).then(
            () => null,
            (caught: unknown) => caught as Error,
          );
          expect(error?.message).toContain('timed out after 1000 ms waiting for a thing that never happens');
          expect(error?.message).toContain(`=== cluster ${cluster().dir}`);
          expect(error?.message).toContain(`--- attempts\n${a1} worker ended/`);
          expect(error?.message).toContain('--- events');
          expect(error?.message).toContain(`model requests of ${a1}`);
          for (const runner of runners) {
            expect(error?.message).toContain(`--- runner ${runner.name} (pid ${runner.pid})`);
          }
        }));

      // Not a step: a step still running at close() would keep the directory.
      test('after close(), no process has its cwd under the cluster directory, waits refuse, and only external hosts met the proxy', async () => {
        const { dir, models } = cluster();
        expect(models.requestsFor(a1).length).toBeGreaterThan(0);
        await cluster().close();
        expect(await processesInDir(dir)).toEqual([]);
        // A step a timed-out test left running stops at its next wait.
        await expect(cluster().waitFor('anything', async () => true)).rejects.toThrow('the cluster is closed');
        // The CLIs reached the scripted servers and the hub directly; the proxy refused whatever else they tried.
        const local = /127\.0\.0\.1|localhost|\[::1\]/;
        const loopback = models.externalAttempts().filter((request) => local.test(request.target));
        expect(loopback).toEqual([]);
      });
    });
  }
});
