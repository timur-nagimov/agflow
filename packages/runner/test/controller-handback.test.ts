import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { lateWorkRef, takeoverRef } from '@agflow/core';
import { commitFiles, type FakeScript, gitIn } from '@agflow/testkit';
import { isCleanedUp } from '../src/attempt/cleanup';
import { vendorHomes } from '../src/config';
import { vendorBinary } from '../src/vendor/pins';
import {
  cleanupRunnerFixtures,
  createRunnerFixture,
  FIXTURE_PROJECT,
  FIXTURE_WIP_PREFIX,
  fixtureCliVersion,
  type RunnerFixture,
  waitFor,
} from './fixture';
import { requireLsofOnMacOS } from './prerequisites';

afterEach(cleanupRunnerFixtures);

// Every test here runs git or agent processes, which take several times as long on a machine loaded by other suites.
setDefaultTimeout(30_000);

const FENCE = { epoch: 1, counter: 1 };
const CLONE = { kind: 'clone' } as const;

const WORKING: FakeScript = {
  turns: [
    [
      { do: 'write', path: 'work.txt', content: 'work\n' },
      { do: 'sleep', ms: 20_000 },
    ],
    [{ do: 'terminal', tool: 'handoff' }],
  ],
};

const cloneOf = (f: RunnerFixture) => f.paths.clone(FIXTURE_PROJECT, 'T-4-a1');

/** Starts T-4-a1 and takes it over, as a person in the browser would. */
async function takenOver(f: RunnerFixture) {
  const controller = f.controller();
  await controller.start(f.spec());
  await waitFor(() => existsSync(join(cloneOf(f), 'work.txt')) && controller.phase === 'turn');
  expect(await controller.prepareTakeover({ fence: FENCE, person: 'alice' })).toMatchObject({ ok: true });
  return controller;
}

/** A stand-in for the runner's pinned codex that records how it was run, then fails. */
function fakeCodex(f: RunnerFixture): string {
  const binary = join(f.paths.runner, vendorBinary('codex', fixtureCliVersion('codex')));
  const record = join(f.home, 'codex-ran.txt');
  mkdirSync(dirname(binary), { recursive: true });
  writeFileSync(binary, `#!/bin/sh\necho "$CODEX_HOME $*" >> '${record}'\nexit 3\n`);
  chmodSync(binary, 0o755);
  return record;
}

describe('AttemptController: hand-back', () => {
  test.skipIf(process.platform !== 'darwin')(
    'a process still in the clone refuses the hand-back with its pid; once gone, it goes (the runner supports darwin-arm64 only; design 7.1)',
    async () => {
      requireLsofOnMacOS();
      const f = await createRunnerFixture({ script: WORKING });
      const controller = await takenOver(f);
      // The person's dev server, still running in the clone.
      const server = Bun.spawn(['sleep', '30'], { cwd: cloneOf(f), stdout: 'ignore', stderr: 'ignore' });
      await waitFor(() => server.pid > 0);
      const refused = await controller.handBack({ source: CLONE });
      expect(refused).toEqual({ ok: false, error: 'process_running', pids: [server.pid] });
      const notes = f.events('attempt.activity').filter((event) => event.data.kind === 'note');
      expect(notes.at(-1)?.data.summary).toContain(String(server.pid));
      expect(existsSync(join(cloneOf(f), 'work.txt'))).toBe(true);
      expect(f.events('attempt.handed_back')).toEqual([]);
      server.kill('SIGKILL');
      await server.exited;
      expect(await controller.handBack({ source: CLONE })).toMatchObject({ ok: true });
      expect(f.events('attempt.handed_back')).toHaveLength(1);
    },
    60_000,
  );

  test.skipIf(process.platform !== 'darwin')(
    "a hand-back pushes the person's work to a new late-work ref, reports it and cleans the attempt up (the runner supports darwin-arm64 only; design 7.1)",
    async () => {
      requireLsofOnMacOS();
      const f = await createRunnerFixture({ script: WORKING });
      const controller = await takenOver(f);
      const clone = cloneOf(f);
      // The person commits, leaves a change uncommitted and touches a protected path.
      writeFileSync(join(clone, 'person.txt'), 'by a person\n');
      await gitIn(clone, ['add', 'person.txt']);
      await gitIn(clone, ['commit', '--quiet', '-m', 'the person finished it']);
      writeFileSync(join(clone, 'draft.txt'), 'not committed\n');
      writeFileSync(join(clone, '.envrc'), 'export SECRET=1\n');
      const outcome = await controller.handBack({ source: CLONE });
      const ref = lateWorkRef(FIXTURE_WIP_PREFIX, 'T-4-a1', 1);
      const sha = await gitIn(f.origin.path, ['rev-parse', ref]);
      expect(outcome).toEqual({ ok: true, handedBack: { ref, sha } });
      expect(f.events('attempt.handed_back').map((event) => event.data)).toEqual([{ ref, sha }]);
      expect(await gitIn(f.origin.path, ['show', `${ref}:person.txt`])).toBe('by a person');
      expect(await gitIn(f.origin.path, ['show', `${ref}:draft.txt`])).toBe('not committed');
      expect(await gitIn(f.origin.path, ['log', '--format=%s', ref])).toContain('the person finished it');
      expect(await gitIn(f.origin.path, ['ls-tree', '--name-only', ref, '.envrc'])).toBe('');
      const violations = f.events('attempt.violation').filter((event) => event.data.phase === 'wip');
      expect(violations.map((event) => event.data.paths)).toEqual([['.envrc']]);
      expect(f.events('attempt.late_work')).toEqual([]);
      expect(existsSync(clone)).toBe(false);
      const record = f.store.get('T-4-a1');
      expect(record && isCleanedUp(record)).toBe(true);
      expect(record?.lateWorkCount).toBe(1);
    },
    60_000,
  );

  test.skipIf(process.platform !== 'darwin')(
    "a protected path the agent's WIP reported is reported again when the person's hand-back strips it (the runner supports darwin-arm64 only; design 7.1)",
    async () => {
      requireLsofOnMacOS();
      const script: FakeScript = {
        turns: [
          [
            { do: 'write', path: 'work.txt', content: 'work\n' },
            { do: 'write', path: '.envrc', content: 'export AGENT=1\n' },
            { do: 'sleep', ms: 20_000 },
          ],
          [{ do: 'terminal', tool: 'handoff' }],
        ],
      };
      const f = await createRunnerFixture({ script });
      const controller = await takenOver(f);
      const wipViolations = () => f.events('attempt.violation').filter((event) => event.data.phase === 'wip');
      expect(wipViolations().map((event) => event.data.paths)).toEqual([['.envrc']]);
      // The take-over restored it; the person writes it again.
      writeFileSync(join(cloneOf(f), '.envrc'), 'export PERSON=1\n');
      expect(await controller.handBack({ source: CLONE })).toMatchObject({ ok: true });
      expect(wipViolations().map((event) => event.data.paths)).toEqual([['.envrc'], ['.envrc']]);
    },
    60_000,
  );

  test.skipIf(process.platform !== 'darwin')(
    "a hand-back settles the agent's late work it replaced, whatever its cleanup does, so no later run pushes that work (the runner supports darwin-arm64 only; design 7.1)",
    async () => {
      requireLsofOnMacOS();
      const f = await createRunnerFixture({
        config: { timings: { finalPush: 1, lateRetry: { base: 60_000, cap: 60_000 } } },
        script: WORKING,
      });
      // The origin refuses the take-over's push: the agent's work waits as late work.
      const hook = join(f.origin.path, 'hooks', 'pre-receive');
      mkdirSync(dirname(hook), { recursive: true });
      writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      const controller = await takenOver(f);
      expect(f.store.get('T-4-a1')?.lateWorkSha).toEqual(expect.any(String));
      const pushError = f.store.get('T-4-a1')?.pushError;
      expect(pushError).toEqual(expect.any(String));
      expect(await controller.handBack({ source: CLONE })).toMatchObject({ ok: false });
      expect(f.store.get('T-4-a1')?.pushError).toBe(pushError);
      rmSync(hook);
      // The cleanup after the hand-back cannot remove the forensics directory.
      const forensics = f.paths.forensics('T-4-a1');
      mkdirSync(forensics, { recursive: true });
      chmodSync(dirname(forensics), 0o555);
      let outcome: Awaited<ReturnType<typeof controller.handBack>>;
      try {
        outcome = await controller.handBack({ source: CLONE });
      } finally {
        chmodSync(dirname(forensics), 0o755);
      }
      const ref = lateWorkRef(FIXTURE_WIP_PREFIX, 'T-4-a1', 1);
      expect(outcome).toMatchObject({ ok: true, handedBack: { ref } });
      expect(f.store.get('T-4-a1')).toMatchObject({ lateWorkSha: null, lateWorkCount: 1, pushError: null });
      expect(f.logger.entries.some((entry) => entry.message === 'cannot clean up after a hand-back')).toBe(true);
      // A later run finds nothing of the agent's to push after the person's hand-back.
      controller.close();
      const next = f.controller('T-4-a1');
      next.resumeLateWork();
      await next.settled();
      expect(f.events('attempt.late_work')).toEqual([]);
      expect(await gitIn(f.origin.path, ['for-each-ref', '--format=%(refname)', 'refs/agflow/T-4/a1-late-*'])).toBe(ref);
    },
    60_000,
  );

  test('a hand-back that cannot look for processes in the clone is refused, and the clone kept', async () => {
    const f = await createRunnerFixture({ script: WORKING });
    const controller = await takenOver(f);
    const path = process.env.PATH ?? '';
    // A PATH without lsof: git still runs, the process check cannot.
    process.env.PATH = path
      .split(':')
      .filter((dir) => dir !== '' && !existsSync(join(dir, 'lsof')))
      .join(':');
    let outcome: Awaited<ReturnType<typeof controller.handBack>>;
    try {
      outcome = await controller.handBack({ source: CLONE });
    } finally {
      process.env.PATH = path;
    }
    expect(outcome).toEqual({ ok: false, error: expect.stringContaining('cannot look for processes in the clone') });
    const notes = f.events('attempt.activity').filter((event) => event.data.kind === 'note');
    expect(notes.at(-1)?.data.summary).toContain('cannot look for processes in the clone');
    expect(f.events('attempt.handed_back')).toEqual([]);
    expect(existsSync(join(cloneOf(f), 'work.txt'))).toBe(true);
    expect(f.store.get('T-4-a1')?.clone).not.toBeNull();
  }, 60_000);

  test.skipIf(process.platform !== 'darwin')(
    "the runner-home Codex daemon is stopped with the runner's codex and Codex home; its failure is ignored (the runner supports darwin-arm64 only; design 7.1)",
    async () => {
      requireLsofOnMacOS();
      const f = await createRunnerFixture({ script: WORKING });
      const ran = fakeCodex(f);
      const controller = await takenOver(f);
      expect(await controller.handBack({ source: CLONE })).toMatchObject({ ok: true });
      expect(readFileSync(ran, 'utf8')).toBe(`${vendorHomes(f.config, f.paths).codex} app-server daemon stop\n`);
      expect(f.events('attempt.handed_back')).toHaveLength(1);
    },
    60_000,
  );

  test('a ref source fetches the ref into the vault, answers ok and reports no event', async () => {
    const f = await createRunnerFixture({ script: WORKING });
    const controller = await takenOver(f);
    const events = f.events().length;
    const sha = await commitFiles(f.origin.path, { branch: 'person-work', files: { 'person.txt': 'by a person\n' } });
    const ref = takeoverRef(FIXTURE_WIP_PREFIX, 'T-4', 'alice');
    await gitIn(f.origin.path, ['update-ref', ref, sha]);
    expect(await f.vault.hasCommit(sha)).toBe(false);
    expect(await controller.handBack({ source: { kind: 'ref', ref, sha } })).toEqual({ ok: true, handedBack: null });
    expect(await f.vault.hasCommit(sha)).toBe(true);
    expect(f.events()).toHaveLength(events);
    expect(existsSync(join(cloneOf(f), 'work.txt'))).toBe(true);
  }, 60_000);
});
