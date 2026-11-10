// Exit scenario 1, the killed agent (design 1, 6.8, 7.4, X-15), per vendor in a fresh cluster: the driver runs once and
// each test reads its own checks. Runs only with AGFLOW_E2E=1; the tests of the check list run always.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Cluster, startCluster } from '../src/harness/cluster';
import { describeE2e, E2E_TEST_TIMEOUT_MS, e2eVendors } from '../src/harness/env';
import { KILLED_AGENT, killedAgent } from '../src/scenarios/killed-agent';
import { checks, cloneFile, expectPassed, RAN_TO_END, type ScenarioResult } from '../src/scenarios/result';

setDefaultTimeout(E2E_TEST_TIMEOUT_MS);

describe('a scenario result', () => {
  test('lists every check with pass or fail and a detail, and passes only when all did', async () => {
    const result = await checks('a scenario', 'claude', async (record) => {
      record.check('a holds', true, 'it held');
      record.equal('b is 2', 1 + 1, 2);
      record.equal('c is 3', 2, 3);
    });
    expect(result).toEqual({
      scenario: 'a scenario',
      vendor: 'claude',
      checks: [
        { name: 'a holds', passed: true, detail: 'it held' },
        { name: 'b is 2', passed: true, detail: '2' },
        { name: 'c is 3', passed: false, detail: 'expected 3, got 2' },
        { name: RAN_TO_END, passed: true, detail: '3 checks made' },
      ],
      passed: false,
      dump: null,
    });
  });

  test('a run that ends with a failed check carries the dump once, and expectPassed shows it after the failures', async () => {
    let dumps = 0;
    const dump = async () => {
      dumps += 1;
      return '=== the cluster dump';
    };
    const failed = await checks(
      'a scenario',
      'claude',
      async (record) => {
        record.equal('c is 3', 2, 3);
      },
      dump,
    );
    expect([failed.dump, dumps]).toEqual(['=== the cluster dump', 1]);
    expect(() => expectPassed(failed)).toThrow(/- c is 3: expected 3, got 2\n=== the cluster dump$/);
    const passed = await checks(
      'a scenario',
      'claude',
      async (record) => {
        record.check('a holds', true, 'it held');
      },
      dump,
    );
    expect([passed.dump, dumps]).toEqual([null, 1]);
    // A body that threw has the dump in its error already.
    const stopped = await checks('a scenario', 'claude', async () => Promise.reject(new Error('timed out')), dump);
    expect([stopped.dump, dumps]).toEqual([null, 1]);
  });

  test('a body that throws keeps the checks made and fails the run with the error', async () => {
    const result = await checks('a scenario', 'codex', async (record) => {
      record.check('a holds', true, 'it held');
      throw new Error('timed out waiting for b');
    });
    expect(result.checks.map((check) => [check.name, check.passed])).toEqual([
      ['a holds', true],
      [RAN_TO_END, false],
    ]);
    expect(result.checks[1]?.detail).toContain('timed out waiting for b');
    expect(result.passed).toBe(false);
  });

  test('expectPassed fails with the details of the failed checks, and of named checks never made', async () => {
    const result = await checks('a scenario', 'claude', async (record) => {
      record.check('a holds', true, 'it held');
      record.equal('c is 3', 2, 3);
      throw new Error('timed out waiting for d');
    });
    expect(() => expectPassed(result, ['a holds'])).not.toThrow();
    const failed = /a scenario \(claude\): 2 check\(s\) failed\n- c is 3: expected 3, got 2\n- the scenario ran to its end: /;
    expect(() => expectPassed(result)).toThrow(failed);
    expect(() => expectPassed(result)).toThrow(/timed out waiting for d/);
    expect(() => expectPassed(result, ['a holds', 'd holds'])).toThrow(
      /- d holds: not checked; the run stopped early: .*timed out waiting for d/,
    );
  });
});

describe('a clone file', () => {
  test('is read when regular, named when a link or another kind of file, and null when missing', async () => {
    const clone = mkdtempSync(join(tmpdir(), 'agflow-clone-file-'));
    try {
      writeFileSync(join(clone, 'a.txt'), 'a\n');
      writeFileSync(join(clone, 'big.txt'), 'x'.repeat(100 * 1024));
      symlinkSync(join(clone, 'a.txt'), join(clone, 'b.txt'));
      expect(Bun.spawnSync(['mkfifo', join(clone, 'fifo')]).exitCode).toBe(0);
      expect(cloneFile(clone, 'a.txt')).toBe('a\n');
      expect(cloneFile(clone, 'big.txt')?.length).toBe(64 * 1024);
      expect(cloneFile(clone, 'b.txt')).toBe(`symlink to ${join(clone, 'a.txt')}`);
      expect(cloneFile(clone, 'fifo')).toBe('not a regular file');
      expect(cloneFile(clone, 'c.txt')).toBeNull();
    } finally {
      rmSync(clone, { recursive: true, force: true });
    }
  });
});

describeE2e('exit scenario 1: a killed agent', () => {
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
      const named = KILLED_AGENT.checks;

      beforeAll(async () => {
        started = await startCluster({ vendor });
        // A step, so a run that outlives the hook keeps the cluster's files.
        const cluster = started;
        ran = await cluster.step(() => killedAgent(cluster));
      });

      afterAll(async () => {
        await started?.close();
      });

      test("a1 ends crashed (infra); origin's final WIP is the hub's, with a.txt committed and b.txt snapshotted", () =>
        passed([named.crashed, named.finalWip, named.committed, named.snapshot, named.ownNote]));

      test('when the hub records a1 ended, no process has its cwd in its clone', () => passed([named.swept]));

      test("a2 runs on another runner from a1's final WIP; its clone holds a.txt and b.txt before a2 acts", () =>
        passed([named.otherRunner, named.startSha, named.cloneFiles]));

      test("a2's first request quotes a1's handoff note, and its first text is its restatement", () =>
        passed([named.brief, named.restatement]));

      test('a2 submits a.txt, b.txt and c.txt, and the person accepts the task', () =>
        passed([named.submitted, named.accepted, RAN_TO_END]));

      test('every check passed', () => passed(result().checks.map((check) => check.name)));
    });
  }
});
