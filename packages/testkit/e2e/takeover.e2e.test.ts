// Take-over and hand-back (design 6.4, 6.12, 7.3, 8.4, 9.4), per vendor in one cluster. alice takes over T-1 while its
// agent runs a long command, checks what the runner handed her, and is refused a hand-back from the clone while a
// process still runs there; she then commits in the clone and hands back from it. She takes over a second task, runs
// the "anywhere" commands in a clone of her own, pushes to her take-over ref and hands back by ref. Either way the next
// attempt starts from her commit and submits. The checks are takeover.ts's, which the live run's TTY check reuses.
// Runs only with AGFLOW_E2E=1.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cloneTo, gitIn } from '../src/git-fixtures';
import { type Cluster, startCluster } from '../src/harness/cluster';
import { describeE2e, E2E_TEST_TIMEOUT_MS, e2eVendors } from '../src/harness/env';
import { HubCallError } from '../src/harness/person';
import { expectPassed, RAN_TO_END, type ScenarioResult } from '../src/scenarios/result';
import { handbackChecks, readyForTakeover, TAKEOVER, takeoverChecks } from '../src/scenarios/takeover';

setDefaultTimeout(E2E_TEST_TIMEOUT_MS);

const named = TAKEOVER.checks;

/** Every take-over check: a ref hand-back's task is checked as a whole. */
const TAKEOVER_CHECKS = [
  named.blocked,
  named.handoff,
  named.ended,
  named.local,
  named.anywhere,
  named.ref,
  named.gitReplaced,
  named.uncommitted,
  named.forensics,
  RAN_TO_END,
];

/**
 * Runs one line of the "anywhere" commands as a person's shell would, in their clone, with no global or system git
 * configuration: the clone's own config holds the fixture identity, and origin is its remote.
 */
async function runLine(dir: string, line: string): Promise<void> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !name.startsWith('GIT_')) env[name] = value;
  }
  const proc = Bun.spawn(['/bin/sh', '-c', line], {
    cwd: dir,
    env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`${line} exited ${code} in ${dir}: ${stderr.trim()}`);
}

describeE2e('take-over and hand-back', () => {
  for (const vendor of e2eVendors()) {
    describe(vendor, () => {
      let started: Cluster | null = null;
      let taken: { taskId: string; attemptId: string } | null = null;
      let checked: ScenarioResult | null = null;
      const cluster = (): Cluster => {
        if (started === null) throw new Error('the cluster did not start');
        return started;
      };
      const takenOver = () => {
        if (taken === null) throw new Error('the first test took nothing over');
        return taken;
      };
      const result = (): ScenarioResult => {
        if (checked === null) throw new Error('the take-over was not checked');
        return checked;
      };

      beforeAll(async () => {
        started = await startCluster({ vendor });
        const cluster = started;
        taken = await cluster.step(() => readyForTakeover(cluster));
      });

      afterAll(async () => {
        await started?.close();
      });

      test('POST /api/tasks/:id/takeover answers 202, the task is blocked as a take-over, and a1 writes a handoff note before it stops', () =>
        cluster().step(async () => {
          const { person } = cluster();
          const { taskId, attemptId } = takenOver();
          if (vendor === 'codex') {
            const { attempt, log } = await person.attempt(attemptId);
            expect(log.filter(entry => entry.kind === 'tool' && entry.summary === 'mcp__agflow__check_inbox: {}').length).toBeGreaterThanOrEqual(4);
            expect(attempt.facts?.tool?.command).toBe(TAKEOVER.longCommand);
            expect(attempt.facts?.repeatedCalls).toBeLessThan(3);
          }
          expect(await person.takeover(taskId)).toBe(attemptId);
          const { task } = await person.task(taskId);
          expect([task.status, task.blockedKind]).toEqual(['blocked', 'takeover']);
          checked = await takeoverChecks(cluster(), { taskId, attemptId, login: person.login });
          expectPassed(result(), [named.blocked, named.handoff]);
        }));

      test("a1 ends taken_over; the commands resume its session with its CLI version's binary, fetch its WIP ref, and push to alice's take-over ref", () =>
        cluster().step(async () => expectPassed(result(), [named.ended, named.local, named.anywhere, named.ref])));

      test("the clone's .git is a new repository at the harvested head, and the agent's old .git is in forensics/<attempt>/", () =>
        cluster().step(async () =>
          expectPassed(result(), [named.gitReplaced, named.uncommitted, named.forensics, RAN_TO_END]),
        ));

      test("unblocking the taken-over task answers 409 'hand it back instead'", () =>
        cluster().step(async () => {
          const { taskId } = takenOver();
          const refused = await cluster()
            .person.unblock(taskId)
            .then(
              () => null,
              (error: unknown) => error,
            );
          expect(refused).toBeInstanceOf(HubCallError);
          expect((refused as HubCallError).status).toBe(409);
          expect((refused as HubCallError).body).toContain('hand it back instead');
        }));

      test('a clone hand-back while a process runs in the clone is refused with process_running; after it exits and alice commits, a clone hand-back makes the task ready from late work, and a2 starts from it and submits', () =>
        cluster().step(async () => {
          const { person, waitFor } = cluster();
          const { taskId, attemptId } = takenOver();
          const clone = (await cluster().runnerOf(attemptId)).clonePath(attemptId);
          // alice's own process, still running in the clone.
          const running = Bun.spawn(['sleep', '600'], {
            cwd: clone,
            stdin: 'ignore',
            stdout: 'ignore',
            stderr: 'ignore',
          });
          try {
            expect(await person.handback(taskId, 'clone')).toBe(attemptId);
            const refused = await waitFor(`the refused hand-back of ${attemptId}`, async () => {
              const { attempt } = await person.attempt(attemptId);
              return attempt.takeover?.error?.startsWith('process_running') ? attempt : null;
            });
            expect(refused.takeover?.error).toContain(String(running.pid));
            expect(refused.takeover?.handingBack).toBeNull();
            const { task } = await person.task(taskId);
            expect([task.status, task.blockedKind]).toEqual(['blocked', 'takeover']);
          } finally {
            running.kill('SIGKILL');
            await running.exited;
          }
          // alice commits a1's uncommitted b.txt with plain git, and hands back from the clone again.
          await gitIn(clone, ['add', 'b.txt']);
          await gitIn(clone, ['commit', '-q', '-m', 'Add b.txt']);
          const commit = await gitIn(clone, ['rev-parse', 'HEAD']);
          expect(await person.handback(taskId, 'clone')).toBe(attemptId);
          expectPassed(await handbackChecks(cluster(), { taskId, attemptId, source: 'clone', commit }));
        }));

      test("a hand-back by ref, after the anywhere commands in alice's own clone and a push to her take-over ref, makes that sha the work position; a2 starts from it and submits", () =>
        cluster().step(async () => {
          const { person, origin } = cluster();
          const { taskId, attemptId } = await readyForTakeover(cluster());
          expect(await person.takeover(taskId)).toBe(attemptId);
          expectPassed(await takeoverChecks(cluster(), { taskId, attemptId, login: person.login }), TAKEOVER_CHECKS);
          const { takeover } = (await person.attempt(attemptId)).attempt;
          if (takeover === null) throw new Error(`${attemptId} has no take-over record`);
          const [fetch, push] = takeover.anywhere.split('\n');
          if (fetch === undefined || push === undefined) throw new Error(`not two commands: ${takeover.anywhere}`);
          const own = await cloneTo(origin.path, join(cluster().dir, 'alice-anywhere'));
          await runLine(own, fetch);
          writeFileSync(join(own, 'alice.txt'), 'alice\n');
          await gitIn(own, ['add', 'alice.txt']);
          await gitIn(own, ['commit', '-q', '-m', 'Add alice.txt']);
          await runLine(own, push);
          const sha = await gitIn(own, ['rev-parse', 'HEAD']);
          expect(await person.handback(taskId, { ref: takeover.ref, sha })).toBe(attemptId);
          const source = { ref: takeover.ref, sha };
          expectPassed(await handbackChecks(cluster(), { taskId, attemptId, source, commit: sha }));
        }));
    });
  }
});
