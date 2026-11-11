import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Fence, InjectedMessage } from '@agflow/core';
import { commitFiles, FakeAdapter, type TranscriptLine } from '@agflow/testkit';
import type { VendorAdapter } from '../src/adapters/types';
import { handoffPrompt } from '../src/attempt/stop';
import { readCloneHead } from '../src/git/clone';
import type { DependencyPreparer } from '../src/seams';
import {
  cleanupRunnerFixtures,
  createRunnerFixture,
  FIXTURE_PROJECT,
  fixtureAgentToken,
  type RunnerFixture,
  waitFor,
} from './fixture';

afterEach(cleanupRunnerFixtures);

// Every test here runs git or agent processes, which take several times as long on a machine loaded by other suites.
setDefaultTimeout(30_000);

const OLD: Fence = { epoch: 1, counter: 1 };
const NEW: Fence = { epoch: 1, counter: 2 };
const NEW_TOKEN = fixtureAgentToken('T-4-a1 resumed');
const FILES = { 'README.md': '# demo\n', 'src/app.ts': 'app\n', '.claude/settings.json': '{"permissions":{}}\n' };

/** A resume_attempt for T-4-a1 with the new fence and token. */
function resumeCommand(f: RunnerFixture, overrides: Partial<Parameters<ReturnType<RunnerFixture['controller']>['resume']>[0]> = {}) {
  return {
    fence: NEW,
    agentToken: NEW_TOKEN,
    prompt: 'Review feedback: rename the helper.',
    messages: [{ messageId: 12, authority: 'person', text: 'also fix the typo' }] as InjectedMessage[],
    taskPack: '# T-4 Tidy the app, round 2\n',
    restore: f.spec().restore,
    acceptanceIds: ['A1', 'A2'],
    ...overrides,
  };
}

/** The user lines of the session's fake transcript. */
function userTexts(f: RunnerFixture, sessionRef: string, attemptId = 'T-4-a1'): string[] {
  const file = join(f.paths.clone(FIXTURE_PROJECT, attemptId), '.agflow', 'run', 'fake-transcripts', `${sessionRef}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as TranscriptLine)
    .filter((line) => line.role === 'user')
    .map((line) => line.text);
}

const fenceOf = (event: ReturnType<RunnerFixture['events']>[number]) => ('fence' in event ? event.fence : null);

const spawnedOf = (f: RunnerFixture, attemptId = 'T-4-a1') =>
  f.events('attempt.spawned').filter((event) => event.attemptId === attemptId);

/** Starts T-4-a1 and stops it after its first turn, with no handoff. */
async function startedAndStopped(f: RunnerFixture, spec = f.spec()) {
  const controller = f.controller(spec.attemptId);
  expect(await controller.start(spec)).toEqual({ started: true });
  await waitFor(() => f.events('attempt.activity').some((event) => event.attemptId === spec.attemptId));
  const stop = { fence: OLD, reason: 'paused', handoff: false, interruptFirst: false, keepClone: true };
  expect(await controller.stop(stop)).toMatchObject({ ok: true });
  return controller;
}

describe('AttemptController: resume', () => {
  test('resume resets finalization before preparing work, even if preparation fails', async () => {
    const f = await createRunnerFixture();
    await startedAndStopped(f);
    f.store.update('T-4-a1', { finalizedAt: 123 });
    const seen: (number | null)[] = [];
    const opened: (number | null)[] = [];
    const fetchForAttempt = f.vault.fetchForAttempt.bind(f.vault);
    f.vault.fetchForAttempt = async (attempt, wipRefPrefix) => {
      opened.push(f.store.get('T-4-a1')!.finalizedAt);
      await fetchForAttempt(attempt, wipRefPrefix);
    };
    const controller = f.controller('T-4-a1', {
      preparer: { available: true, prepare: async () => {
        seen.push(f.store.get('T-4-a1')!.finalizedAt);
        return { ran: true, ok: false, error: 'preparation failed', logTail: null };
      } },
    });
    expect(await controller.resume(resumeCommand(f))).toMatchObject({ resumed: false });
    expect(opened).toEqual([null]);
    expect(seen).toEqual([null]);
    expect(f.store.get('T-4-a1')?.finalizedAt).toBeNull();
  });

  test('a stopped attempt resumes its session in the same clone with the new token, then gets the prompt and the messages', async () => {
    const f = await createRunnerFixture({ files: FILES, script: { turns: [[], [], []] } });
    const first = await startedAndStopped(f);
    const clone = f.paths.clone(FIXTURE_PROJECT, 'T-4-a1');
    const ino = statSync(join(clone, '.git')).ino;
    const sessionRef = spawnedOf(f)[0]?.data.sessionRef as string;
    // Agent config changed while it was stopped.
    writeFileSync(join(clone, '.claude', 'settings.json'), '{"permissions":{"allow":["Bash(*)"]}}\n');
    const controller = f.controller();
    expect(await controller.resume(resumeCommand(f))).toEqual({ resumed: true });
    expect(controller.fence).toEqual(NEW);
    expect(statSync(join(clone, '.git')).ino).toBe(ino);
    expect(readFileSync(join(clone, '.agflow', 'run', 'task.md'), 'utf8')).toBe('# T-4 Tidy the app, round 2\n');
    expect(readFileSync(join(clone, '.claude', 'settings.json'), 'utf8')).toBe(FILES['.claude/settings.json']);
    const launch = f.fakes.claude?.launches[1];
    expect(launch?.resume).toEqual({ sessionRef });
    // The project config is checked again in the resumed clone.
    expect(launch?.projectConfigVerified).toBe(true);
    expect(launch?.env.AGFLOW_AGENT_TOKEN).toBe(NEW_TOKEN);
    expect(launch?.clone).toBe(first.workspace?.clone as string);
    const spawned = await waitFor(() => spawnedOf(f)[1]);
    expect(spawned.fence).toEqual(NEW);
    expect(spawned.data).toMatchObject({ sessionRef, startSha: null });
    await waitFor(() => f.events('attempt.acknowledged').length > 0);
    expect(userTexts(f, sessionRef)).toEqual([
      'Start working on T-4.',
      'Review feedback: rename the helper.',
      'also fix the typo',
    ]);
    expect(f.events('attempt.delivered').map((event) => [event.fence, event.data.messageIds])).toEqual([[NEW, [12]]]);
    expect(f.store.get('T-4-a1')).toMatchObject({ fence: NEW, spec: { acceptanceIds: ['A1', 'A2'] } });
    expect(JSON.stringify(f.store.get('T-4-a1'))).not.toContain(NEW_TOKEN);
  });

  test('after a pin change the resume runs the CLI version the attempt started with', async () => {
    const f = await createRunnerFixture({ files: FILES });
    await startedAndStopped(f);
    const started = spawnedOf(f)[0]?.data.cliVersion as string;
    // The record says what the attempt started with, whatever the pins say now.
    f.store.update('T-4-a1', { cliVersion: '0.0.1-recorded' });
    await f.controller().resume(resumeCommand(f));
    expect(f.fakes.claude?.launches[1]?.cliVersion).toBe('0.0.1-recorded');
    expect((await waitFor(() => spawnedOf(f)[1])).data.cliVersion).toBe('0.0.1-recorded');
    expect(started).not.toBe('0.0.1-recorded');
  });

  test('a live process is stopped first, without a handoff turn, and its work pushed; then it resumes', async () => {
    const f = await createRunnerFixture({
      files: FILES,
      script: { turns: [[{ do: 'write', path: 'work.txt', content: 'work\n' }], []] },
    });
    const controller = f.controller();
    await controller.start(f.spec());
    await waitFor(() => f.events('attempt.activity').length > 0);
    const sessionRef = spawnedOf(f)[0]?.data.sessionRef as string;
    expect(await controller.resume(resumeCommand(f))).toEqual({ resumed: true });
    const [exited] = f.events('attempt.exited');
    expect(exited?.fence).toEqual(OLD);
    expect(exited?.data).toMatchObject({ handoffWritten: false, finalWip: { ref: 'refs/agflow/T-4/a1' } });
    expect(userTexts(f, sessionRef)).not.toContain(handoffPrompt('the attempt resumes'));
    const spawned = await waitFor(() => spawnedOf(f)[1]);
    expect(spawned.seq).toBeGreaterThan(exited?.seq as number);
    expect(f.fakes.claude?.launches[1]?.env.AGFLOW_AGENT_TOKEN).toBe(NEW_TOKEN);
    expect(controller.session).not.toBeNull();
  });

  test("a lead's clean clone is fast-forwarded to the vault's newer main; a dirty one is not", async () => {
    const f = await createRunnerFixture({ files: FILES });
    const leadSpec = (n: number) =>
      f.spec({ attemptId: `lead-a${n}`, taskId: null, role: 'lead', branch: null, wipRef: null });
    await startedAndStopped(f, leadSpec(1));
    await startedAndStopped(f, leadSpec(2));
    writeFileSync(join(f.paths.clone(FIXTURE_PROJECT, 'lead-a2'), 'scratch.md'), 'notes\n');
    const newer = await commitFiles(f.origin.path, { branch: 'main', files: { 'NEWS.md': 'news\n' }, message: 'news' });
    for (const n of [1, 2]) {
      const resumed = await f.controller(`lead-a${n}`).resume({ ...resumeCommand(f), taskPack: null, acceptanceIds: [] });
      expect(resumed).toEqual({ resumed: true });
    }
    expect((await readCloneHead(f.paths.clone(FIXTURE_PROJECT, 'lead-a1'))).sha).toBe(newer);
    expect((await readCloneHead(f.paths.clone(FIXTURE_PROJECT, 'lead-a2'))).sha).toBe(f.origin.mainSha);
    expect(existsSync(join(f.paths.clone(FIXTURE_PROJECT, 'lead-a1'), 'NEWS.md'))).toBe(true);
  });

  test('a session that never ran a turn starts fresh with the brief and first prompt, and reports its new sessionRef', async () => {
    const f = await createRunnerFixture({ files: FILES });
    await startedAndStopped(f);
    // A session the agent never took a message in.
    f.store.update('T-4-a1', { sessionRef: 'never-ran' });
    await f.controller().resume(resumeCommand(f));
    expect(f.fakes.claude?.launches[1]?.resume).toEqual({ sessionRef: 'never-ran' });
    const spawned = await waitFor(() => spawnedOf(f)[1]);
    const fresh = spawned.data.sessionRef;
    expect(fresh).not.toBe('never-ran');
    expect(spawned.data.startSha).toBeNull();
    expect(f.store.get('T-4-a1')?.sessionRef).toBe(fresh);
    await waitFor(() => userTexts(f, fresh).length === 3);
    expect(userTexts(f, fresh)[0]).toBe('Start working on T-4.');
  });

  test('a resume restores agent config a dependency preparation wrote, then verifies the project config', async () => {
    const files = { ...FILES, '.codex/config.toml': 'model = "gpt"\n' };
    let resumed = false;
    // A preparation whose scripts write agent config on the resume, as a postinstall could.
    const preparer: DependencyPreparer = {
      available: true,
      prepare: async (input) => {
        if (resumed) {
          writeFileSync(join(input.clone, '.codex', 'config.toml'), 'model = "postinstall"\n');
          writeFileSync(join(input.clone, '.codex', 'prep.toml'), 'approval_policy = "never"\n');
        }
        return { ran: true, ok: true, error: null, logTail: null };
      },
    };
    const f = await createRunnerFixture({ files });
    const first = f.controller('T-4-a1', { preparer });
    await first.start(f.spec({ vendor: 'codex' }));
    await waitFor(() => f.events('attempt.activity').length > 0);
    await first.stop({ fence: OLD, reason: 'paused', handoff: false, interruptFirst: false, keepClone: true });
    resumed = true;
    expect(await f.controller('T-4-a1', { preparer }).resume(resumeCommand(f))).toEqual({ resumed: true });
    const clone = f.paths.clone(FIXTURE_PROJECT, 'T-4-a1');
    expect(readdirSync(join(clone, '.codex'))).toEqual(['config.toml']);
    expect(readFileSync(join(clone, '.codex', 'config.toml'), 'utf8')).toBe(files['.codex/config.toml']);
    expect(f.fakes.codex?.launches.at(-1)?.projectConfigVerified).toBe(true);
  });

  test("a resumed successor reports no second first_output, unless its session started fresh", async () => {
    const f = await createRunnerFixture({
      files: FILES,
      // The resumed session's own first turn says 'On it.', however its prompt and messages arrive.
      script: (launch) => ({
        turns: [[{ do: 'text', text: launch.resume === null ? 'I restate the task.' : 'On it.' }], []],
      }),
    });
    await startedAndStopped(f, f.spec({ successor: true }));
    await f.controller().resume(resumeCommand(f));
    await waitFor(() => f.events('attempt.activity').some((event) => event.data.summary === 'On it.'));
    expect(f.events('attempt.first_output').map((event) => event.data.text)).toEqual(['I restate the task.']);

    // A session that never ran a turn starts fresh: its first text is the restatement again.
    const g = await createRunnerFixture({ files: FILES, script: { turns: [[{ do: 'text', text: 'Restated.' }]] } });
    await startedAndStopped(g, g.spec({ successor: true }));
    g.store.update('T-4-a1', { sessionRef: 'never-ran' });
    await g.controller().resume({ ...resumeCommand(g), prompt: '', messages: [] });
    await waitFor(() => g.events('attempt.first_output').length === 2);
    expect(g.events('attempt.first_output').map((event) => [event.fence, event.data.text])).toEqual([
      [OLD, 'Restated.'],
      [NEW, 'Restated.'],
    ]);
  }, 60_000);

  test('a preparation failure reports attempt.prepared and attempt.failed_to_start; another failure pushes the work first', async () => {
    let calls = 0;
    const preparer: DependencyPreparer = {
      available: true,
      prepare: async () => {
        calls += 1;
        return calls === 1
          ? { ran: true, ok: true, error: null, logTail: null }
          : { ran: true, ok: false, error: 'bun install failed', logTail: 'ERR' };
      },
    };
    const f = await createRunnerFixture({ files: FILES });
    const first = f.controller('T-4-a1', { preparer });
    await first.start(f.spec());
    await waitFor(() => f.events('attempt.activity').length > 0);
    await first.stop({ fence: OLD, reason: 'paused', handoff: false, interruptFirst: false, keepClone: true });
    const before = f.events().length;
    const failed = await f.controller('T-4-a1', { preparer }).resume(resumeCommand(f));
    expect(failed).toMatchObject({ resumed: false });
    const after = f.events().slice(before);
    expect(after.map((event) => event.type)).toEqual(['attempt.prepared', 'attempt.failed_to_start']);
    expect(after.map(fenceOf)).toEqual([NEW, NEW]);
    expect(after[0]?.data).toEqual({ requestId: null, ok: false, error: 'bun install failed', logTail: 'ERR' });
    expect(f.fakes.claude?.launches).toHaveLength(1);

    // An adapter that cannot resume: the clone's work is pushed, then the failure reported.
    const fake = f.fakes.claude as FakeAdapter;
    const refusing: VendorAdapter = {
      vendor: 'claude',
      preflight: () => fake.preflight(),
      readTranscriptTail: (input) => fake.readTranscriptTail(input),
      deleteTranscript: (input) => fake.deleteTranscript(input),
      start: async () => {
        throw new Error('the session file is corrupt');
      },
    };
    f.adapters.set('claude', refusing);
    writeFileSync(join(f.paths.clone(FIXTURE_PROJECT, 'T-4-a1'), 'late.txt'), 'late\n');
    const count = f.events().length;
    const third = { ...resumeCommand(f), fence: { epoch: 1, counter: 3 } };
    expect(await f.controller().resume(third)).toMatchObject({ resumed: false });
    const events = f.events().slice(count);
    expect(events.map((event) => event.type)).toEqual(['attempt.wip', 'attempt.failed_to_start']);
    expect(events[1]?.data).toMatchObject({ error: expect.stringContaining('the session file is corrupt'), refused: null });
    expect(events.every((event) => fenceOf(event)?.counter === 3)).toBe(true);
  });

  test('after a resume, commands with the old fence are refused and WIP goes out under the new one', async () => {
    const f = await createRunnerFixture({
      files: FILES,
      script: { turns: [[], [{ do: 'write', path: 'more.txt', content: 'more\n' }]] },
    });
    await startedAndStopped(f);
    const controller = f.controller();
    await controller.resume(resumeCommand(f));
    expect(await controller.deliver({ fence: OLD, messages: [], more: 0 })).toEqual({ ok: false, error: 'stale_fence' });
    expect(await controller.interrupt({ fence: OLD })).toEqual({ ok: false, error: 'stale_fence' });
    expect(await controller.hold({ fence: OLD })).toEqual({ ok: false, error: 'stale_fence' });
    expect(await controller.resume({ ...resumeCommand(f), fence: OLD })).toEqual({ resumed: false, error: 'stale_fence' });
    const submission = { fence: OLD, submissionId: 'S-1', branch: 'agflow/T-4-tidy', expectedBranchSha: null, adoptable: [] };
    expect(await controller.submit(submission)).toEqual({ ok: false, error: 'stale_fence' });
    await waitFor(() => existsSync(join(f.paths.clone(FIXTURE_PROJECT, 'T-4-a1'), 'more.txt')));
    expect(await controller.pushWip()).toMatchObject({ status: 'pushed' });
    const wips = f.events('attempt.wip');
    expect(wips.at(-1)?.fence).toEqual(NEW);
    const resumed = spawnedOf(f)[1]?.seq ?? 0;
    expect(f.events().filter((event) => event.seq > resumed && fenceOf(event)?.counter === 1)).toEqual([]);
  });
});
