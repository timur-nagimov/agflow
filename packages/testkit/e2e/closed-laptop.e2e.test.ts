// Exit scenario 2, the closed laptop (design 1, 6.3, 6.4, 7.3, 7.9, X-11, X-36), per vendor in a fresh cluster: the
// driver runs once and each test reads its own checks. Runs only with AGFLOW_E2E=1.
import { afterAll, beforeAll, describe, setDefaultTimeout, test } from 'bun:test';
import { type Cluster, startCluster } from '../src/harness/cluster';
import { describeE2e, E2E_TEST_TIMEOUT_MS, e2eVendors } from '../src/harness/env';
import { CLOSED_LAPTOP, closedLaptop } from '../src/scenarios/closed-laptop';
import { expectPassed, RAN_TO_END, type ScenarioResult } from '../src/scenarios/result';

setDefaultTimeout(E2E_TEST_TIMEOUT_MS);

describeE2e('exit scenario 2: a closed laptop', () => {
  for (const vendor of e2eVendors()) {
    describe(vendor, () => {
      let started: Cluster | null = null;
      let ran: ScenarioResult | null = null;
      const cluster = (): Cluster => {
        if (started === null) throw new Error('the cluster did not start');
        return started;
      };
      const result = (): ScenarioResult => {
        if (ran === null) throw new Error('the scenario did not run');
        return ran;
      };
      const passed = (names: readonly string[]) => cluster().step(async () => expectPassed(result(), names));
      const named = CLOSED_LAPTOP.checks;

      beforeAll(async () => {
        started = await startCluster({ vendor });
        // A step, so a run that outlives the hook keeps the cluster's files.
        const cluster = started;
        ran = await cluster.step(() => closedLaptop(cluster));
      });

      afterAll(async () => {
        await started?.close();
      });

      test('frozen, the runner goes offline after deadLinkMs, and only the lease ends a1: lost (infra), no stall', () =>
        passed([named.offline, named.lost, named.notStalled]));

      test('the task went stale, then ready, with a note by system that quotes the work and says none was written', () =>
        passed([named.staleReady, named.assembled]));

      test("a2 starts on another runner from a1's last recorded WIP, and its brief holds the assembled note", () =>
        passed([named.otherRunner, named.startSha, named.brief]));

      test("after the thaw a1's agent is gone, its late work is on its late-work refs, and a late_work note names them", () =>
        passed([named.agentGone, named.lateWork, named.lateNote]));

      test('a2 receives the message that names the ref, merges it and submits everything', () =>
        passed([named.message, named.received, named.merged, named.accepted, RAN_TO_END]));

      test('every check passed', () => passed(result().checks.map((check) => check.name)));
    });
  }
});
