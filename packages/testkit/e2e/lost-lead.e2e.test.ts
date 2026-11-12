// Exit scenario 3, the lost lead (design 1, 6.5, 6.7, 6.11, 10), per vendor in a fresh cluster with runner leads on:
// the driver runs once and each test reads its own checks. Runs only with AGFLOW_E2E=1.
import { afterAll, beforeAll, describe, setDefaultTimeout, test } from 'bun:test';
import { type Cluster, startCluster } from '../src/harness/cluster';
import { describeE2e, E2E_TEST_TIMEOUT_MS, e2eVendors } from '../src/harness/env';
import { LOST_LEAD, lostLead } from '../src/scenarios/lost-lead';
import { expectPassed, RAN_TO_END, type ScenarioResult } from '../src/scenarios/result';

setDefaultTimeout(E2E_TEST_TIMEOUT_MS);

describeE2e('exit scenario 3: a lost lead', () => {
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
      const named = LOST_LEAD.checks;

      beforeAll(async () => {
        started = await startCluster({
          vendor,
          runnerLeads: true,
          goal: LOST_LEAD.goal,
          programs: LOST_LEAD.programs(),
        });
        // A step, so a run that outlives the hook keeps the cluster's files.
        const cluster = started;
        ran = await cluster.step(() => lostLead(cluster));
      });

      afterAll(async () => {
        await started?.close();
      });

      test('the scheduler seats lead-a1 on a runner, and GET /api/lead/notes lists its lead handoff', () =>
        passed([named.seated, named.handoff]));

      test('after the freeze, lead-a1 ends lost (infra) and the seat empties; lead-a2 is seated on another runner', () =>
        passed([named.lost, named.emptied, named.reseated]));

      test("lead-a2's brief quotes lead-a1's handoff, and the person's message sent during the freeze reaches lead-a2", () =>
        passed([named.brief, named.messageMoved, named.messageSeen]));

      test('a worker submits the task created after the failover, and lead-a2, woken by it, accepts it as itself', () =>
        passed([named.submitted, named.woken, named.reviewed, named.accepted]));

      test("after the thaw, the old runner stops lead-a1's process and pushes no ref for it", () =>
        passed([named.oldStopped, named.noRefs, RAN_TO_END]));

      test('every check passed', () => passed(result().checks.map((check) => check.name)));
    });
  }
});
