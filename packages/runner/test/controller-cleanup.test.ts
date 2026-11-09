import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { lateWorkRef, localPinRefs } from '@agflow/core';
import { FakeAdapter, type FakeScript, gitIn } from '@agflow/testkit';
import { isCleanedUp, removeTree } from '../src/attempt/cleanup';
import {
  cleanupRunnerFixtures,
  createRunnerFixture,
  FIXTURE_PROJECT,
  FIXTURE_WIP_PREFIX,
  type RunnerFixture,
  waitFor,
} from './fixture';

afterEach(cleanupRunnerFixtures);

// Every test here runs git or agent processes, which take several times as long on a machine loaded by other suites.
setDefaultTimeout(30_000);

const FENCE = { epoch: 1, counter: 1 };
const WIP = 'refs/agflow/T-4/a1';

const WORKING: FakeScript = {
  turns: [
    [
      { do: 'write', path: 'work.txt', content: 'work\n' },
      { do: 'text', text: 'I wrote the work.' },
      { do: 'sleep', ms: 20_000 },
    ],
  ],
};

const cloneOf = (f: RunnerFixture) => f.paths.clone(FIXTURE_PROJECT, 'T-4-a1');

/** The origin's WIP ref; '' when it has none. */
const wipOnOrigin = (f: RunnerFixture) =>
  gitIn(f.origin.path, ['rev-parse', '--verify', '--quiet', WIP], { allowFailure: true });

/** The attempt's late-work refs on the origin. */
async function lateRefs(f: RunnerFixture): Promise<string[]> {
  const listed = await gitIn(f.origin.path, ['for-each-ref', '--format=%(refname)', `${WIP}-late-*`]);
  return listed === '' ? [] : listed.split('\n');
}

async function pins(f: RunnerFixture): Promise<string[]> {
  const listed = await gitIn(f.vault.path, ['for-each-ref', '--format=%(refname)', 'refs/agflow-local/T-4-a1/']);
  return listed === '' ? [] : listed.split('\n');
}

/** Starts T-4-a1 and waits until its agent wrote work.txt and is in its turn. */
async function startWorking(f: RunnerFixture) {
  const controller = f.controller();
  await controller.start(f.spec());
  await waitFor(() => existsSync(join(cloneOf(f), 'work.txt')) && controller.phase === 'turn');
  return controller;
}

describe('AttemptController: cleanup', () => {
  test('cleanup of an attempt whose process is still alive runs the stop ladder first', async () => {
    const f = await createRunnerFixture({ script: WORKING });
    const controller = await startWorking(f);
    const wipBefore = await wipOnOrigin(f);
    // An accept that reaches the runner while the agent still runs: the hub ended the attempt already.
    expect(await controller.cleanup()).toEqual({ ok: true });
    await controller.settled();
    const [exited] = f.events('attempt.exited');
    expect(exited?.data.stoppedBy).not.toBe('none');
    // An ended attempt's WIP ref never moves: the final work goes to a late-work ref, once.
    expect(exited?.data).toMatchObject({ finalWip: null, pushError: null });
    expect(await wipOnOrigin(f)).toBe(wipBefore);
    const ref = lateWorkRef(FIXTURE_WIP_PREFIX, 'T-4-a1', 1);
    const lates = f.events('attempt.late_work');
    expect(lates.map((event) => event.data)).toEqual([
      { taskId: 'T-4', ref, sha: await gitIn(f.origin.path, ['rev-parse', ref]) },
    ]);
    // The work the exit harvested, harvested again: a new snapshot commit of the same tree.
    const treeOf = (sha: string) => gitIn(f.vault.path, ['rev-parse', `${sha}^{tree}`]);
    expect(await treeOf(lates[0]?.data.sha as string)).toBe(await treeOf(exited?.data.finalSha as string));
    expect(await gitIn(f.origin.path, ['show', `${ref}:work.txt`])).toBe('work');
    expect(await lateRefs(f)).toEqual([ref]);
    expect(controller.session).toBeNull();
    expect(f.store.processes('T-4-a1')).toEqual([]);
    expect(existsSync(cloneOf(f))).toBe(false);
  }, 60_000);

  test('cleanup of an attempt whose agent wrote nothing pushes no late work', async () => {
    const f = await createRunnerFixture({ script: { turns: [[{ do: 'sleep', ms: 20_000 }]] } });
    const controller = f.controller();
    await controller.start(f.spec());
    await waitFor(() => controller.phase === 'turn');
    expect(await controller.stop({ fence: FENCE, reason: 'done', handoff: false, interruptFirst: false, keepClone: true }))
      .toMatchObject({ ok: true });
    expect(f.events('attempt.exited')[0]?.data.finalWip).toBeNull();
    f.store.update('T-4-a1', { pushError: 'an earlier failed harvest' });
    expect(await controller.cleanup()).toEqual({ ok: true });
    expect(f.store.get('T-4-a1')?.pushError).toBeNull();
    expect(f.events('attempt.late_work')).toEqual([]);
    expect(await lateRefs(f)).toEqual([]);
    expect(existsSync(cloneOf(f))).toBe(false);
  }, 60_000);

  test("cleanup of a clone the agent broke beyond harvesting still removes it, with a note", async () => {
    const f = await createRunnerFixture({ script: WORKING });
    const controller = await startWorking(f);
    expect(await controller.stop({ fence: FENCE, reason: 'done', handoff: false, interruptFirst: false, keepClone: true }))
      .toMatchObject({ ok: true });
    rmSync(join(cloneOf(f), '.git'), { recursive: true, force: true });
    f.store.update('T-4-a1', { pushError: 'unresolved harvest' });
    expect(await controller.cleanup()).toEqual({ ok: true });
    expect(existsSync(cloneOf(f))).toBe(false);
    const record = f.store.get('T-4-a1');
    expect(record && isCleanedUp(record)).toBe(true);
    expect(record?.pushError).toBe('unresolved harvest');
    const notes = f.events('attempt.activity').filter((event) => event.data.kind === 'note');
    expect(notes.map((event) => event.data.summary)).toEqual([expect.stringContaining('cannot harvest the clone')]);
    expect(f.events('attempt.late_work')).toEqual([]);
  }, 60_000);

  test('cleanup removes a clone in which the agent left a read-only directory', async () => {
    const f = await createRunnerFixture({ script: WORKING });
    const controller = await startWorking(f);
    expect(await controller.stop({ fence: FENCE, reason: 'done', handoff: false, interruptFirst: false, keepClone: true }))
      .toMatchObject({ ok: true });
    const readOnly = join(cloneOf(f), 'ro');
    mkdirSync(readOnly);
    writeFileSync(join(readOnly, 'f.txt'), 'kept\n');
    chmodSync(readOnly, 0o555);
    try {
      expect(await controller.cleanup()).toEqual({ ok: true });
    } finally {
      if (existsSync(readOnly)) chmodSync(readOnly, 0o755);
    }
    expect(existsSync(cloneOf(f))).toBe(false);
  }, 60_000);

  test('cleanup pushes work not yet on the origin to a late-work ref and reports it before deleting the clone', async () => {
    const f = await createRunnerFixture({ script: WORKING });
    const controller = await startWorking(f);
    expect(await controller.stop({ fence: FENCE, reason: 'done', handoff: false, interruptFirst: false, keepClone: true }))
      .toMatchObject({ ok: true });
    // Work the final WIP does not hold: a person's file in the kept clone.
    writeFileSync(join(cloneOf(f), 'later.txt'), 'later\n');
    let cloneAtLateWork = null as boolean | null;
    const appended = f.outbox.append.bind(f.outbox);
    f.outbox.append = (event) => {
      if (event.type === 'attempt.late_work') cloneAtLateWork = existsSync(cloneOf(f));
      return appended(event);
    };
    expect(await controller.cleanup()).toEqual({ ok: true });
    const [late] = f.events('attempt.late_work');
    const ref = lateWorkRef(FIXTURE_WIP_PREFIX, 'T-4-a1', 1);
    expect(late?.data).toEqual({ taskId: 'T-4', ref, sha: await gitIn(f.origin.path, ['rev-parse', ref]) });
    expect(await gitIn(f.origin.path, ['show', `${ref}:later.txt`])).toBe('later');
    expect(cloneAtLateWork).toBe(true);
    expect(existsSync(cloneOf(f))).toBe(false);
    expect(f.store.get('T-4-a1')?.lateWorkCount).toBe(1);
  }, 60_000);

  test('cleanup uploads the tail, then removes the clone, the pins, the tmp dir, the forensics and the transcript', async () => {
    const f = await createRunnerFixture({ script: WORKING });
    // Transcripts outside the clone, as a real CLI keeps them, so their deletion shows on its own.
    const transcripts = join(f.home, 'transcripts');
    const fake = new FakeAdapter({ vendor: 'claude', skipAuthChecks: true, script: WORKING, transcriptDir: transcripts });
    f.adapters.set('claude', fake);
    let cloneAtUpload = null as boolean | null;
    const hub = {
      uploadTranscript: async (attemptId: string, transcript: string) => {
        cloneAtUpload = existsSync(cloneOf(f));
        await f.hub.uploadTranscript(attemptId, transcript);
      },
    };
    const controller = f.controller('T-4-a1', { hub });
    await controller.start(f.spec());
    await waitFor(() => existsSync(join(cloneOf(f), 'work.txt')) && controller.phase === 'turn');
    const record = f.store.get('T-4-a1');
    const tmpDir = record?.tmpDir as string;
    const sessionRef = record?.sessionRef as string;
    expect(existsSync(tmpDir)).toBe(true);
    expect(existsSync(join(transcripts, `${sessionRef}.jsonl`))).toBe(true);
    mkdirSync(join(f.paths.forensics('T-4-a1'), 'git'), { recursive: true });
    expect(await pins(f)).toContain(localPinRefs('T-4-a1').start);
    expect(await controller.cleanup()).toEqual({ ok: true });
    expect(cloneAtUpload).toBe(true);
    expect(f.hub.transcripts.map((upload) => upload.transcript)).toContain('I wrote the work.');
    expect(existsSync(cloneOf(f))).toBe(false);
    expect(await pins(f)).toEqual([]);
    expect(existsSync(tmpDir)).toBe(false);
    expect(existsSync(f.paths.forensics('T-4-a1'))).toBe(false);
    expect(existsSync(f.paths.agentTools(FIXTURE_PROJECT, 'T-4-a1'))).toBe(false);
    expect(existsSync(join(transcripts, `${sessionRef}.jsonl`))).toBe(false);
    expect(existsSync(f.paths.baseCheckout(FIXTURE_PROJECT, f.origin.mainSha))).toBe(false);
    const after = f.store.get('T-4-a1');
    expect(after?.endedAt).toEqual(expect.any(Number));
    expect(after && isCleanedUp(after)).toBe(true);
    // Done is done: a resent cleanup answers ok and changes nothing.
    expect(await controller.cleanup()).toEqual({ ok: true });
  }, 60_000);

  test('a late push that fails keeps the clone and answers { ok: false } with the reason', async () => {
    const f = await createRunnerFixture({
      config: { timings: { finalPush: 1, lateRetry: { base: 60_000, cap: 60_000 } } },
      script: WORKING,
    });
    const controller = await startWorking(f);
    // The origin still answers ls-remote, and refuses every push.
    const hook = join(f.origin.path, 'hooks', 'pre-receive');
    mkdirSync(dirname(hook), { recursive: true });
    writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    expect(await controller.stop({ fence: FENCE, reason: 'done', handoff: false, interruptFirst: false, keepClone: true }))
      .toMatchObject({ ok: true });
    const pushError = f.store.get('T-4-a1')?.pushError;
    expect(pushError).toEqual(expect.any(String));
    const outcome = await controller.cleanup();
    expect(outcome).toEqual({ ok: false, error: expect.stringContaining('cannot push the late work') });
    expect(f.store.get('T-4-a1')?.pushError).toBe(pushError);
    expect(existsSync(join(cloneOf(f), 'work.txt'))).toBe(true);
    expect(await pins(f)).not.toEqual([]);
    expect(f.store.get('T-4-a1')?.clone).not.toBeNull();
    expect(f.events('attempt.late_work')).toEqual([]);
    // Once the origin takes pushes again, the cleanup goes through.
    rmSync(hook);
    expect(await controller.cleanup()).toEqual({ ok: true });
    expect(f.store.get('T-4-a1')?.pushError).toBeNull();
    expect(f.events('attempt.late_work')).toHaveLength(1);
    expect(existsSync(cloneOf(f))).toBe(false);
  }, 60_000);

  test('late work still pending is pushed first, so a clone that is gone loses none of it', async () => {
    const f = await createRunnerFixture({
      config: { timings: { finalPush: 1, lateRetry: { base: 60_000, cap: 60_000 } } },
      script: WORKING,
    });
    const controller = await startWorking(f);
    // The origin still answers ls-remote, and refuses every push.
    const hook = join(f.origin.path, 'hooks', 'pre-receive');
    mkdirSync(dirname(hook), { recursive: true });
    writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    expect(await controller.stop({ fence: FENCE, reason: 'done', handoff: false, interruptFirst: false, keepClone: true }))
      .toMatchObject({ ok: true });
    const [exited] = f.events('attempt.exited');
    const finalSha = exited?.data.finalSha as string;
    expect(f.store.get('T-4-a1')?.lateWorkSha).toBe(finalSha);
    rmSync(hook);
    await removeTree(cloneOf(f));
    expect(await controller.cleanup()).toEqual({ ok: true });
    const ref = lateWorkRef(FIXTURE_WIP_PREFIX, 'T-4-a1', 1);
    expect(f.events('attempt.late_work').map((event) => event.data)).toEqual([{ taskId: 'T-4', ref, sha: finalSha }]);
    expect(await gitIn(f.origin.path, ['show', `${ref}:work.txt`])).toBe('work');
    expect(f.store.get('T-4-a1')).toMatchObject({ lateWorkSha: null, clone: null });
    expect(await pins(f)).toEqual([]);
  }, 60_000);

  test('late work a failed cleanup could not push is retried until it lands, as the hub never sends that cleanup again', async () => {
    const f = await createRunnerFixture({
      config: { timings: { finalPush: 1, lateRetry: { base: 300, cap: 300 } } },
      script: WORKING,
    });
    const controller = await startWorking(f);
    // The origin still answers ls-remote, and refuses every push.
    const hook = join(f.origin.path, 'hooks', 'pre-receive');
    mkdirSync(dirname(hook), { recursive: true });
    writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    expect(await controller.stop({ fence: FENCE, reason: 'done', handoff: false, interruptFirst: false, keepClone: true }))
      .toMatchObject({ ok: true });
    const finalSha = f.events('attempt.exited')[0]?.data.finalSha as string;
    expect(await controller.cleanup()).toEqual({ ok: false, error: expect.stringContaining('cannot push the late work') });
    expect(f.store.get('T-4-a1')?.lateWorkSha).toBe(finalSha);
    rmSync(hook);
    const ref = lateWorkRef(FIXTURE_WIP_PREFIX, 'T-4-a1', 1);
    await waitFor(() => f.events('attempt.late_work').length > 0);
    expect(f.events('attempt.late_work').map((event) => event.data)).toEqual([{ taskId: 'T-4', ref, sha: finalSha }]);
    expect(f.store.get('T-4-a1')?.lateWorkSha).toBeNull();
    // Once: the work landed, and the retries ended.
    await Bun.sleep(1_000);
    expect(f.events('attempt.late_work')).toHaveLength(1);
  }, 60_000);

  test("the clone's work a failed cleanup could not push is recorded as late work and retried until it lands", async () => {
    const f = await createRunnerFixture({
      config: { timings: { lateRetry: { base: 300, cap: 300 } } },
      script: WORKING,
    });
    const controller = await startWorking(f);
    expect(await controller.stop({ fence: FENCE, reason: 'done', handoff: false, interruptFirst: false, keepClone: true }))
      .toMatchObject({ ok: true });
    expect(f.store.get('T-4-a1')?.lateWorkSha).toBeNull();
    // Work made in the clone after the exit (a person's, say); then the origin refuses every push.
    writeFileSync(join(cloneOf(f), 'after.txt'), 'after the exit\n');
    const hook = join(f.origin.path, 'hooks', 'pre-receive');
    mkdirSync(dirname(hook), { recursive: true });
    writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    expect(await controller.cleanup()).toEqual({ ok: false, error: expect.stringContaining('cannot push the late work') });
    const pending = f.store.get('T-4-a1')?.lateWorkSha as string;
    expect(pending).toEqual(expect.any(String));
    expect(await gitIn(f.vault.path, ['show', `${pending}:after.txt`])).toBe('after the exit');
    rmSync(hook);
    const ref = lateWorkRef(FIXTURE_WIP_PREFIX, 'T-4-a1', 1);
    await waitFor(() => f.events('attempt.late_work').length > 0);
    expect(f.events('attempt.late_work').map((event) => event.data)).toEqual([{ taskId: 'T-4', ref, sha: pending }]);
    expect(await gitIn(f.origin.path, ['show', `${ref}:after.txt`])).toBe('after the exit');
    expect(f.store.get('T-4-a1')?.lateWorkSha).toBeNull();
    // A cleanup then removes the clone, and pushes nothing again.
    expect(await controller.cleanup()).toEqual({ ok: true });
    expect(f.events('attempt.late_work')).toHaveLength(1);
    expect(existsSync(cloneOf(f))).toBe(false);
  }, 60_000);

  test('upload_transcript of an attempt without a live session posts its tail', async () => {
    const f = await createRunnerFixture({ script: WORKING });
    const controller = await startWorking(f);
    expect(await controller.stop({ fence: FENCE, reason: 'done', handoff: false, interruptFirst: false, keepClone: true }))
      .toMatchObject({ ok: true });
    f.hub.transcripts.length = 0;
    // A new controller, as after a restart, knows the attempt from its record only.
    const after = f.controller('T-4-a1');
    expect(await after.uploadTranscript()).toEqual({ uploaded: true });
    expect(f.hub.transcripts).toEqual([{ attemptId: 'T-4-a1', transcript: 'I wrote the work.' }]);
  }, 60_000);
});
