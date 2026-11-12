// Exit scenario 1, the killed agent (design 1, 6.8, 7.4, X-15), per vendor and publication ordering in a fresh cluster.
// Each test reads its own checks. Runs only with AGFLOW_E2E=1; the tests of the driver and check list run always.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveRunnerConfig } from '@agflow/runner/src/config';
import { commitFiles, gitIn, originRepo } from '../src/git-fixtures';
import { type Cluster, startCluster } from '../src/harness/cluster';
import { describeE2e, E2E_TEST_TIMEOUT_MS, e2eVendors } from '../src/harness/env';
import { KILLED_AGENT, killedAgent } from '../src/scenarios/killed-agent';
import { checks, cloneFile, expectPassed, RAN_TO_END, type ScenarioResult } from '../src/scenarios/result';

setDefaultTimeout(E2E_TEST_TIMEOUT_MS);

test.skipIf(process.platform !== 'darwin')(
  'the pushed-WIP variant waits for a reported origin commit containing b.txt before killing (the runner supports darwin-arm64 only; design 7.1)',
  async () => {
    const origin = await originRepo({ 'a.txt': 'a\n' });
    const wipRef = 'refs/agflow/T-1/a1';
    const pushed = await commitFiles(origin.path, { branch: 'snapshot', files: { 'b.txt': 'b\n' } });
    await gitIn(origin.path, ['update-ref', wipRef, origin.mainSha]);
    writeFileSync(join(origin.root, 'b.txt'), 'b\n');
    const sleeper = Bun.spawn(['sleep', '600'], { cwd: origin.root, stdout: 'ignore', stderr: 'ignore' });
    let reads = 0;
    let killedAfterReads = -1;
    // Only the pre-kill part of the driver: publication progresses from no report, through an old WIP without b,
    // to a report not yet visible on origin. killAgent stops the test before the rest of the scenario needs a hub.
    const cluster = {
      vendor: 'claude', origin,
      models: { addPrograms() {} },
      person: {
        createTasks: async () => [{ id: 'T-1' }],
        task: async () => ({ notes: [{ kind: 'handoff', attemptId: 'T-1-a1' }] }),
        attempt: async () => {
          reads += 1;
          if (reads === 4) await gitIn(origin.path, ['update-ref', wipRef, pushed]);
          return { attempt: { wipRef, wipSha: reads === 1 ? null : reads === 2 ? origin.mainSha : pushed } };
        },
      },
      runnerOf: async () => ({
        clonePath: () => origin.root,
        killAgent: async () => { killedAfterReads = reads; throw new Error('stopped at killAgent'); },
      }),
      waitForEvent: async () => ({}),
      waitFor: async (_what: string, check: () => Promise<unknown>) => {
        for (let tries = 0; tries < 30; tries += 1) {
          const value = await check();
          if (value !== null && value !== undefined && value !== false) return value;
          await Bun.sleep(20);
        }
        throw new Error(`timed out: ${_what}`);
      },
    } as unknown as Cluster;
    try {
      const options = { scripted: true, wipBeforeKill: 'pushed' as const };
      const result = await killedAgent(cluster, options);
      expect(result.checks.at(-1)?.detail).toContain('stopped at killAgent');
      expect(killedAfterReads).toBe(4);
    } finally {
      sleeper.kill('SIGKILL');
      await sleeper.exited;
      origin.remove();
    }
  },
  30_000,
);

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
  const variants = e2eVendors().flatMap((vendor) =>
    (['unpublished', 'pushed'] as const).map((wipBeforeKill) => ({ vendor, wipBeforeKill })),
  );
  for (const { vendor, wipBeforeKill } of variants) {
    describe(`${vendor}, b.txt ${wipBeforeKill} before kill`, () => {
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
        if (wipBeforeKill === 'unpublished') {
          // No task exists yet. Suppress periodic pushes for this variant so it deterministically exercises the
          // final harvest of work never published earlier, even when the CLI is slow. Scratch runner homes only.
          for (const runner of started.runners) {
            await runner.stop();
            saveRunnerConfig(runner.home.paths.config, {
              ...runner.home.config, timings: { ...runner.home.config.timings, wip: 60 * 60_000 },
            });
            await runner.start();
          }
        }
        // A step, so a run that outlives the hook keeps the cluster's files.
        const cluster = started;
        ran = await cluster.step(() => killedAgent(cluster, { wipBeforeKill }));
      });

      afterAll(async () => {
        await started?.close();
      });

      test("a1 ends crashed (infra); origin's final WIP is the hub's, with a.txt committed and b.txt snapshotted", () =>
        passed([named.crashed, named.finalWip, named.committed, named.snapshot, named.ownNote]));

      test('when the hub records a1 ended, no process has its cwd in its clone', () => passed([named.swept]));

      test("a2 runs on another runner from a1's final WIP; its clone holds a.txt and b.txt before a2 acts", () =>
        passed([named.otherRunner, named.startSha, named.startRef, named.cloneFiles]));

      test('the requested publication ordering holds and the exit and start command carry the exact WIP', () =>
        cluster().step(async () => {
          expectPassed(result(), [named.wipOrdering, ...(wipBeforeKill === 'pushed' ? [named.sameWip] : [])]);
          const a1 = (await cluster().person.attempt('T-1-a1')).attempt;
          const a2 = (await cluster().person.attempt('T-1-a2')).attempt;
          const runner1 = await cluster().runnerOf(a1.id);
          const runner2 = await cluster().runnerOf(a2.id);
          const db1 = new Database(runner1.home.paths.db, { readonly: true });
          const db2 = new Database(runner2.home.paths.db, { readonly: true });
          try {
            const exits = db1.query("SELECT event FROM outbox WHERE type = 'attempt.exited' AND attempt_id = ?")
              .all(a1.id) as { event: string }[];
            expect(exits).toHaveLength(1);
            expect(JSON.parse(exits[0]!.event).data).toMatchObject({
              finalSha: a1.wipSha, finalWip: { ref: a1.wipRef, sha: a1.wipSha }, pushError: null,
            });
            const starts = db2.query("SELECT command FROM journal WHERE kind = 'start_attempt' AND attempt_id = ?")
              .all(a2.id) as { command: string }[];
            expect(starts).toHaveLength(1);
            expect(JSON.parse(starts[0]!.command).attempt.start).toEqual({ ref: a1.wipRef, sha: a1.wipSha });
          } finally {
            db1.close();
            db2.close();
          }
        }));

      test("a2's first request quotes a1's handoff note, and its first text is its restatement", () =>
        passed([named.brief, named.restatement]));

      test('a2 submits a.txt, b.txt and c.txt, and the person accepts the task', () =>
        passed([named.submitted, named.accepted, RAN_TO_END]));

      test('every check passed', () => passed(result().checks.map((check) => check.name)));
    });
  }
});
