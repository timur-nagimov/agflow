// The live run's take-over check (design 6.12, 15), per vendor on a scripted cluster. In a live run a person takes the
// task over in the browser, resumes the session with the local command in a terminal, commits and hands back in the
// browser. Here a stand-in person commits in the clone and hands back through the API, so runTakeoverCheck's own
// steps and verdicts are checked without a terminal, a browser or a model. The cluster uses a throwaway "remote" (a
// local bare repository) as a live run's --repo does, so every origin read goes through the mirror and its refresh.
// Runs only with AGFLOW_E2E=1.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { gitIn, type OriginRepo, originRepo, refSha } from '../src/git-fixtures';
import { type Cluster, startCluster } from '../src/harness/cluster';
import { describeE2e, E2E_TEST_TIMEOUT_MS, e2eVendors } from '../src/harness/env';
import { runTakeoverCheck, TAKEOVER_CHECK, type TakeoverPerson } from '../src/live';
import { expectPassed } from '../src/scenarios/result';
import { TAKEOVER } from '../src/scenarios/takeover';

setDefaultTimeout(E2E_TEST_TIMEOUT_MS);

/** The person's steps through the API: take over, then commit a1's uncommitted b.txt and hand back from the clone. */
const STAND_IN: TakeoverPerson = {
  async takeOver({ cluster, taskId }) {
    await cluster.person.takeover(taskId);
  },
  async handBack({ cluster, taskId, clone }) {
    await gitIn(clone, ['add', 'b.txt']);
    await gitIn(clone, ['commit', '-q', '-m', 'Add b.txt']);
    await cluster.person.handback(taskId, 'clone');
    return { resumed: null };
  },
};

describeE2e('the live run take-over check', () => {
  for (const vendor of e2eVendors()) {
    describe(vendor, () => {
      let started: Cluster | null = null;
      let remote: OriginRepo | null = null;
      const cluster = (): Cluster => {
        if (started === null) throw new Error('the cluster did not start');
        return started;
      };

      beforeAll(async () => {
        // An empty throwaway remote, as --repo names one.
        remote = await originRepo({});
        await gitIn(remote.path, ['update-ref', '-d', 'refs/heads/main']);
        started = await startCluster({ vendor, repo: remote.path });
      });

      afterAll(async () => {
        await started?.close();
        remote?.remove();
      });

      test('the cluster resets the remote, and its origin is a local mirror of it', () =>
        cluster().step(async () => {
          const { origin } = cluster();
          if (remote === null) throw new Error('no remote');
          expect(origin.path).not.toBe(remote.path);
          expect(await refSha(remote.path, 'refs/heads/main')).toBe(origin.mainSha);
        }));

      test('runTakeoverCheck with a stand-in person reports every check passed', () =>
        cluster().step(async () => {
          const results = await runTakeoverCheck(cluster(), STAND_IN);
          expect(results.map((result) => result.scenario)).toEqual([
            TAKEOVER_CHECK.scenario,
            TAKEOVER.scenario,
            'hand-back from the clone',
          ]);
          for (const result of results) expectPassed(result);
          // Without a terminal, nobody saw the session resume: that check is left out, not passed.
          const own = results[0]?.checks.map((check) => check.name) ?? [];
          expect(own).toContain(TAKEOVER_CHECK.checks.committed);
          expect(own).not.toContain(TAKEOVER_CHECK.checks.resumed);
        }));
    });
  }
});
