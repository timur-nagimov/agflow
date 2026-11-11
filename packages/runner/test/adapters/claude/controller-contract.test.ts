// The contract check (design 13): M2b's AttemptController, built against the fake adapter, drives the Claude adapter
// over the recorded-stream fake CLI. The fake stands at the runner's vendor directory as a script that hands it its
// own variables, because the controller builds the agent's environment outside test mode.
import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { InjectedMessage } from '@agflow/core';
import {
  CLAUDE_FIXTURES_DIR,
  type ClaudeRecording,
  FAKE_CLAUDE_BIN,
  type FakeClaudeLogEntry,
  fakeClaudeEnv,
  loadRecording,
  parseRecording,
  type RecordingStep,
  readFakeClaudeLog,
} from '@agflow/testkit/src/fake-claude';
import { SYNTHESISED_RESET } from '../../../scripts/record-claude-stream';
import { claudeAdapterFactory } from '../../../src/adapters/claude/entry';
import { claudeBinary } from '../../../src/adapters/claude/options';
import { claudeProjectDir } from '../../../src/adapters/claude/paths';
import { CLAUDE_CLI_VERSION } from '../../../src/adapters/claude/pin';
import { continuationPrompt, OUTAGE_NUDGE } from '../../../src/attempt/turns';
import { vendorHomes } from '../../../src/config';
import {
  cleanupRunnerFixtures,
  createRunnerFixture,
  FIXTURE_AGFLOW,
  FIXTURE_PROJECT,
  fixtureAgentToken,
  type RunnerFixture,
  type RunnerFixtureOptions,
  waitFor,
} from '../../fixture';

// macOS's first exec of a new script is slow, more so under load.
const TIMEOUT = 30_000;
/** An older CLI version an attempt may have started with (X-13). */
const OLDER = '2.1.280';
const PROMPT = 'Start working on T-4.';
const FENCE = { epoch: 1, counter: 1 };
const RESUMED = { epoch: 1, counter: 2 };
/** The fixture keeps M2b's long continuationWait (an agent idles after its turn); the continuation checks shorten it. */
const CONTINUING = { config: { timings: { continuationWait: 100 } } };

afterEach(cleanupRunnerFixtures);

beforeAll(() => {
  // Warm the script and Bun's transpile cache once, so the first test does not pay for it.
  Bun.spawnSync([FAKE_CLAUDE_BIN, '--version'], { env: { PATH: '/usr/bin:/bin', FAKE_CLAUDE_BUN: process.execPath } });
}, TIMEOUT);

interface ClaudeFixture {
  f: RunnerFixture;
  /** The fake's log of the pinned claude. */
  log: string;
}

/**
 * Puts a claude of the version in the fixture's vendor directory: a script that hands the fake its variables and the
 * recording, warmed once with --warm. Gives the fake's log.
 */
function fakeClaudeAt(f: RunnerFixture, version: string, recording: ClaudeRecording): string {
  const fake = fakeClaudeEnv({ recording, dir: join(f.home, `fake-${version}`), version });
  const bin = claudeBinary(f.paths, version);
  mkdirSync(dirname(bin), { recursive: true });
  const exports = Object.entries(fake).map(([name, value]) => `export ${name}='${value}'`);
  const script = ['#!/bin/sh', '[ "$1" = --warm ] && exit 0', ...exports, `exec '${FAKE_CLAUDE_BIN}' "$@"`];
  writeFileSync(bin, `${script.join('\n')}\n`);
  chmodSync(bin, 0o755);
  Bun.spawnSync([bin, '--warm']);
  return fake.FAKE_CLAUDE_LOG as string;
}

/** M2b's fixture, its claude the registry's Claude adapter over the fake replaying the recording. */
async function claudeFixture(recording: ClaudeRecording, options: RunnerFixtureOptions = {}): Promise<ClaudeFixture> {
  const f = await createRunnerFixture(options);
  const log = fakeClaudeAt(f, CLAUDE_CLI_VERSION, recording);
  const adapter = claudeAdapterFactory({ config: f.config, paths: f.paths, agflow: FIXTURE_AGFLOW });
  if (adapter === null) throw new Error('the claude entry gave no adapter');
  f.adapters.set('claude', adapter);
  return { f, log };
}

/**
 * turn-basic with only the tool calls given: toolu_basic_1 echo hi, 2 a push the guard refuses, 3 a bridge answer that
 * the hub is unreachable, 4 a submit the bridge accepts. The others' frames, hooks and denials are left out. The
 * recording has no second turn: a continuation or nudge sent to it fails that turn, which no check here minds.
 */
function basicWith(keep: number[], version = CLAUDE_CLI_VERSION): ClaudeRecording {
  const text = readFileSync(join(CLAUDE_FIXTURES_DIR, 'turn-basic.jsonl'), 'utf8');
  // As a CLI of that version printed it: its system/init names the version.
  const recording = parseRecording(
    text.replaceAll(`"claude_code_version":"${CLAUDE_CLI_VERSION}"`, `"claude_code_version":"${version}"`),
  );
  const dropped = (value: unknown) =>
    [1, 2, 3, 4].some((n) => !keep.includes(n) && JSON.stringify(value).includes(`"toolu_basic_${n}"`));
  const turns = recording.turns.map((turn) =>
    turn.flatMap((step): RecordingStep[] => {
      if (!('frame' in step) || step.frame.type !== 'result') return dropped(step) ? [] : [step];
      const denials = Array.isArray(step.frame.permission_denials) ? step.frame.permission_denials : [];
      return [{ frame: { ...step.frame, permission_denials: denials.filter((denial) => !dropped(denial)) } }];
    }),
  );
  return { ...recording, turns };
}

/** A recording with a pause after the first tool's PreToolUse hook: the tool is in flight meanwhile. */
function slowFirstTool(recording: ClaudeRecording, ms: number): ClaudeRecording {
  const [turn = []] = recording.turns;
  const hook = turn.findIndex((step) => 'hook' in step);
  return { ...recording, turns: [[...turn.slice(0, hook + 1), { sleep: ms }, ...turn.slice(hook + 1)]] };
}

/**
 * A synthesised quota recording whose limit resets in ten minutes instead of at its fixed 2030 (SYNTHESISED_RESET): a
 * reset one timer of M2b's TurnPolicy reaches, for the checks of a wait and the reset it reports. Bun clamps a delay
 * past 2^31 - 1 ms to 1 ms; M2b bounds the timer there and arms it again while the reset is ahead, so testkit's
 * unmodified 2030 recording keeps the attempt waiting, which a case of its own checks.
 */
function resettingSoon(name: 'limit-hit' | 'overage-in-use'): { recording: ClaudeRecording; resetsAt: number } {
  const resetsAt = Math.floor(Date.now() / 1_000) + 600;
  const text = readFileSync(join(CLAUDE_FIXTURES_DIR, `${name}.jsonl`), 'utf8');
  return {
    recording: parseRecording(text.replaceAll(`"resetsAt":${SYNTHESISED_RESET}`, `"resetsAt":${resetsAt}`)),
    resetsAt: resetsAt * 1_000,
  };
}

/** The user messages the fake took, by text, in order; after the n-th process start when given. */
async function userTexts(log: string, fromStart = 0): Promise<string[]> {
  const entries = await readFakeClaudeLog(log);
  let starts = 0;
  const texts: string[] = [];
  for (const entry of entries) {
    if (entry.kind === 'argv') starts += 1;
    if (entry.kind !== 'user' || starts <= fromStart) continue;
    const content = (entry.message as { message?: { content?: unknown } }).message?.content;
    texts.push(typeof content === 'string' ? content : JSON.stringify(content));
  }
  return texts;
}

async function logOf<K extends FakeClaudeLogEntry['kind']>(
  log: string,
  kind: K,
): Promise<Extract<FakeClaudeLogEntry, { kind: K }>[]> {
  return (await readFakeClaudeLog(log)).filter(
    (entry): entry is Extract<FakeClaudeLogEntry, { kind: K }> => entry.kind === kind,
  );
}

const activities = (f: RunnerFixture) => f.events('attempt.activity').map((event) => event.data);
const turnsEnded = (f: RunnerFixture) => activities(f).filter((data) => data.kind === 'turn').length;
const spawnedOf = (f: RunnerFixture) => f.events('attempt.spawned');

/** Starts T-4-a1 and waits until its first turn has ended. */
async function startedTurn(f: RunnerFixture) {
  const controller = f.controller();
  expect(await controller.start(f.spec())).toEqual({ started: true });
  await waitFor(() => turnsEnded(f) >= 1, 15_000);
  return controller;
}

/** Starts T-4-a1, waits for its first turn and stops it, keeping the clone and the session. */
async function startedAndStopped(f: RunnerFixture) {
  const controller = await startedTurn(f);
  const stop = { fence: FENCE, reason: 'paused', handoff: false, interruptFirst: false, keepClone: true };
  expect(await controller.stop(stop)).toMatchObject({ ok: true });
  return controller;
}

const RESUME_PROMPT = 'Review feedback: rename the helper.';

/** A resume_attempt for T-4-a1 with the next fence and a new token. */
function resumeCommand(f: RunnerFixture) {
  return {
    fence: RESUMED,
    agentToken: fixtureAgentToken('T-4-a1 resumed'),
    prompt: RESUME_PROMPT,
    messages: [] as InjectedMessage[],
    taskPack: '# T-4 Tidy the app, round 2\n',
    restore: f.spec().restore,
    acceptanceIds: ['A1'],
  };
}

/** Polls an asynchronous check until it holds, or fails after timeoutMs. */
async function eventually(check: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`waited ${timeoutMs} ms in vain`);
    await Bun.sleep(20);
  }
}

/** A main-thread line in the clone's project directory: the session ran a turn, so a resume resumes it (8.4). */
function ranATurn(f: RunnerFixture, sessionRef: string): void {
  const clone = f.paths.clone(FIXTURE_PROJECT, 'T-4-a1');
  const dir = claudeProjectDir(vendorHomes(f.config, f.paths).claude, clone);
  mkdirSync(dir, { recursive: true });
  const prompt = { type: 'user', message: { role: 'user', content: PROMPT } };
  writeFileSync(join(dir, `${sessionRef}.jsonl`), `${JSON.stringify(prompt)}\n`);
}

describe('the AttemptController drives the Claude adapter: start and turns', () => {
  test(
    'start_attempt reports attempt.spawned with the sessionRef, pid, model, cliVersion and permissionMode',
    async () => {
      const { f, log } = await claudeFixture(basicWith([1]));
      const controller = f.controller();
      expect(await controller.start(f.spec())).toEqual({ started: true });
      const [spawned] = await waitFor(() => spawnedOf(f).length > 0 && spawnedOf(f));
      const session = controller.session;
      expect(spawned?.data).toEqual({
        sessionRef: session?.sessionRef as string,
        pid: session?.pid as number,
        model: f.config.models.claude.worker,
        cliVersion: CLAUDE_CLI_VERSION,
        permissionMode: 'acceptEdits',
        startSha: f.origin.mainSha,
      });
      const [argv] = await logOf(log, 'argv');
      expect(argv?.argv).toContain(`--session-id=${spawned?.data.sessionRef}`);
      // The adapter registered exactly the process it spawned.
      expect(f.store.processes('T-4-a1').map((record) => record.pid)).toEqual([session?.pid as number]);
      expect(f.store.get('T-4-a1')).toMatchObject({ state: 'running', sessionRef: spawned?.data.sessionRef });
    },
    TIMEOUT,
  );

  test(
    'a recorded turn becomes attempt.activity for its tools, text and turn; the facts show a tool while it runs',
    async () => {
      // Without the hub-unreachable answer, whose nudge would start a second turn.
      const { f } = await claudeFixture(slowFirstTool(basicWith([1, 2, 4]), 1_500));
      const controller = f.controller();
      await controller.start(f.spec());
      const tool = await waitFor(() => controller.facts()?.tool, 15_000);
      expect(tool).toMatchObject({ name: 'Bash', command: 'echo hi', long: false });
      await waitFor(() => turnsEnded(f) === 1, 15_000);
      expect(controller.facts()?.tool).toBeNull();
      expect(activities(f).map((data) => [data.kind, data.summary])).toEqual([
        ['text', 'Running the check.'],
        ['tool', 'Bash: echo hi'],
        ['tool', 'Bash: git push origin HEAD'],
        ['tool', 'mcp__agflow__submit: {"summary":"Checked."}'],
        ['text', 'The check printed hi, and the work is submitted.'],
        ['turn', 'turn completed with 3 tool calls'],
      ]);
      expect(f.events('attempt.activity')[0]?.fence).toEqual(FENCE);
    },
    TIMEOUT,
  );

  test(
    'a submit the bridge accepted suppresses the continuation, which a turn without one gets',
    async () => {
      const submitted = await claudeFixture(basicWith([1, 4]), CONTINUING);
      await startedTurn(submitted.f);
      const plain = await claudeFixture(basicWith([1]), CONTINUING);
      await startedTurn(plain.f);
      await eventually(async () => (await userTexts(plain.log)).length === 2);
      await Bun.sleep(400);
      expect(await userTexts(submitted.log)).toEqual([PROMPT]);
      expect(await userTexts(plain.log)).toEqual([PROMPT, continuationPrompt(['A1'])]);
    },
    TIMEOUT,
  );

  test(
    "the bridge's hub-unreachable answer blocks the continuation: one nudge instead, nothing while the link is down",
    async () => {
      const up = await claudeFixture(basicWith([1, 3]), CONTINUING);
      await startedTurn(up.f);
      const down = await claudeFixture(basicWith([1, 3]), CONTINUING);
      down.f.link.up = false;
      await startedTurn(down.f);
      await eventually(async () => (await userTexts(up.log)).length === 2);
      await Bun.sleep(400);
      expect(await userTexts(up.log)).toEqual([PROMPT, OUTAGE_NUDGE]);
      expect(await userTexts(down.log)).toEqual([PROMPT]);
    },
    TIMEOUT,
  );

  test(
    'a deliver command reports attempt.delivered and attempt.acknowledged with the hub message ids',
    async () => {
      const { f, log } = await claudeFixture(loadRecording('turn-delivery'));
      const controller = f.controller();
      await controller.start(f.spec());
      // The recording takes the message while its tool runs.
      await waitFor(() => controller.facts()?.tool, 15_000);
      const message = { messageId: 31, authority: 'person' as const, text: 'also check the logs' };
      expect(await controller.deliver({ fence: FENCE, messages: [message], more: 0 })).toEqual({ ok: true });
      await waitFor(() => f.events('attempt.acknowledged').length > 0, 15_000);
      expect(f.events('attempt.delivered').map((event) => [event.fence, event.data.messageIds])).toEqual([
        [FENCE, [31]],
      ]);
      expect(f.events('attempt.acknowledged').map((event) => event.data.messageIds)).toEqual([[31]]);
      expect(await userTexts(log)).toEqual([PROMPT, message.text]);
    },
    TIMEOUT,
  );
});

describe('the AttemptController drives the Claude adapter: stops and quota', () => {
  test(
    'stop_attempt runs the stop ladder: an interrupt that cancels queued input, then the close; exited has stoppedBy',
    async () => {
      const { f, log } = await claudeFixture(loadRecording('interrupt'));
      const controller = f.controller();
      await controller.start(f.spec());
      await waitFor(() => controller.facts()?.tool, 15_000);
      const stop = { fence: FENCE, reason: 'stopped', handoff: false, interruptFirst: false, keepClone: false };
      expect(await controller.stop(stop)).toMatchObject({ ok: true, stoppedBy: 'close' });
      const [exited] = f.events('attempt.exited');
      expect(exited?.data).toMatchObject({ stoppedBy: 'close', handoffWritten: false });
      const interrupts = (await logOf(log, 'control')).filter((entry) => entry.request.subtype === 'interrupt');
      expect(interrupts.length).toBeGreaterThan(0);
      expect(interrupts.every((entry) => entry.request.cancel_queued === true)).toBe(true);
      const [eof] = await logOf(log, 'eof');
      expect(eof?.at).toBeGreaterThanOrEqual(interrupts[0]?.at as number);
      expect(activities(f).map((data) => data.summary)).toContain('turn interrupted');
      expect(controller.session).toBeNull();
    },
    TIMEOUT,
  );

  test(
    'a limit hit moves the attempt to quota_wait and reports attempt.quota',
    async () => {
      const { recording, resetsAt } = resettingSoon('limit-hit');
      const { f } = await claudeFixture(recording);
      const controller = f.controller();
      await controller.start(f.spec());
      await waitFor(() => controller.phase === 'quota_wait' && f.events('attempt.quota').length > 0, 15_000);
      const [quota] = f.events('attempt.quota');
      expect(quota?.data).toMatchObject({
        vendor: 'claude',
        quota: { state: 'exhausted', resetsAt, windows: { fiveHour: 1 } },
      });
      expect(controller.facts()?.phase).toBe('quota_wait');
    },
    TIMEOUT,
  );

  test(
    "a limit hit resetting in 2030, beyond one timer's reach, keeps the attempt in quota_wait without a resume prompt",
    async () => {
      const { f, log } = await claudeFixture(loadRecording('limit-hit'));
      const controller = f.controller();
      await controller.start(f.spec());
      await waitFor(() => controller.phase === 'quota_wait' && f.events('attempt.quota').length > 0, 15_000);
      // A timer armed for the whole wait would fire within a millisecond, end the wait and send the resume prompt.
      await Bun.sleep(500);
      const quotas = f.events('attempt.quota').map((event) => event.data.quota);
      expect(quotas).toMatchObject([{ state: 'exhausted', resetsAt: SYNTHESISED_RESET * 1_000 }]);
      expect(controller.phase).toBe('quota_wait');
      expect(await userTexts(log)).toEqual([PROMPT]);
    },
    TIMEOUT,
  );

  test(
    'overage in use is a limit hit while allowPaidUsage is false, and an allowed turn while it is true',
    async () => {
      const refused = await claudeFixture(resettingSoon('overage-in-use').recording);
      const refusing = refused.f.controller();
      await refusing.start(refused.f.spec());
      await waitFor(() => refusing.phase === 'quota_wait' && refused.f.events('attempt.quota').length > 0, 15_000);
      expect(refused.f.events('attempt.quota').map((event) => event.data.quota.state)).toEqual(['exhausted']);
      const allowed = await claudeFixture(resettingSoon('overage-in-use').recording, {
        config: { allowPaidUsage: { claude: true, codex: false } },
      });
      const allowing = await startedTurn(allowed.f);
      expect(allowing.phase).not.toBe('quota_wait');
      expect(allowed.f.events('attempt.quota')).toEqual([]);
      expect(activities(allowed.f).map((data) => data.summary)).toContain('turn completed with 0 tool calls');
    },
    TIMEOUT,
  );
});

describe('the AttemptController drives the Claude adapter: resume', () => {
  test(
    "resume_attempt starts the binary of the attempt's recorded cliVersion and resumes the session",
    async () => {
      const { f, log } = await claudeFixture(basicWith([1]));
      await startedAndStopped(f);
      const sessionRef = spawnedOf(f)[0]?.data.sessionRef as string;
      ranATurn(f, sessionRef);
      // The record says what the attempt started with, whatever the pin is now.
      f.store.update('T-4-a1', { cliVersion: OLDER });
      const olderLog = fakeClaudeAt(f, OLDER, basicWith([1], OLDER));
      const controller = f.controller();
      expect(await controller.resume(resumeCommand(f))).toEqual({ resumed: true });
      const spawned = await waitFor(() => spawnedOf(f)[1], 15_000);
      expect(spawned.fence).toEqual(RESUMED);
      expect(spawned.data).toMatchObject({ sessionRef, cliVersion: OLDER, startSha: null });
      const [argv] = await logOf(olderLog, 'argv');
      expect(argv?.argv).toContain(`--resume=${sessionRef}`);
      expect(await userTexts(olderLog)).toEqual([RESUME_PROMPT]);
      // The pinned claude ran only the first start.
      expect(await logOf(log, 'argv')).toHaveLength(1);
      expect(f.store.processes('T-4-a1').map((record) => record.pid)).toContain(controller.session?.pid as number);
    },
    TIMEOUT,
  );

  test(
    "a resumed session whose first turn does not match ends as an exit nobody asked for, not a failed start (X-50)",
    async () => {
      const { f } = await claudeFixture(basicWith([1]));
      await startedAndStopped(f);
      ranATurn(f, spawnedOf(f)[0]?.data.sessionRef as string);
      f.store.update('T-4-a1', { cliVersion: OLDER });
      // The older binary's system/init names the pin: the first turn's check fails once the resume prompt starts it.
      fakeClaudeAt(f, OLDER, basicWith([1]));
      expect(await f.controller().resume(resumeCommand(f))).toEqual({ resumed: true });
      const exits = await waitFor(() => f.events('attempt.exited').length === 2 && f.events('attempt.exited'), 15_000);
      expect(exits[1]?.fence).toEqual(RESUMED);
      expect(exits[1]?.data).toMatchObject({ stoppedBy: 'none', cause: null });
      const notes = activities(f).filter((data) => data.kind === 'note').map((data) => data.summary);
      expect(notes).toEqual([expect.stringContaining('the session does not match its options')]);
      expect(notes[0]).toContain(OLDER);
      expect(f.events('attempt.failed_to_start')).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    'a resume of a session that never ran a turn starts one fresh process with the first prompt (X-50)',
    async () => {
      const { f, log } = await claudeFixture(basicWith([1]));
      await startedAndStopped(f);
      const first = spawnedOf(f)[0]?.data.sessionRef as string;
      // No transcript holds a turn of the session: the fake writes none.
      const controller = f.controller();
      expect(await controller.resume(resumeCommand(f))).toEqual({ resumed: true });
      const spawned = await waitFor(() => spawnedOf(f)[1], 15_000);
      expect(spawned.data.sessionRef).not.toBe(first);
      expect(spawned.data.startSha).toBeNull();
      // The fresh process is registered, once: the stop ladder and recovery can reach it. Registration is asynchronous.
      const recorded = await waitFor(
        () => f.store.processes('T-4-a1').length > 0 && f.store.processes('T-4-a1'),
        15_000,
      );
      expect(recorded.map((record) => record.pid)).toEqual([spawned.data.pid]);
      expect(f.store.get('T-4-a1')?.sessionRef).toBe(spawned.data.sessionRef);
      const argvs = await logOf(log, 'argv');
      expect(argvs).toHaveLength(2);
      expect(argvs[1]?.argv).toContain(`--session-id=${spawned.data.sessionRef}`);
      expect(argvs[1]?.argv.some((arg) => arg.startsWith('--resume'))).toBe(false);
      await eventually(async () => (await userTexts(log, 1)).length === 2);
      expect(await userTexts(log, 1)).toEqual([PROMPT, RESUME_PROMPT]);
      expect(controller.session?.pid).toBe(spawned.data.pid);
    },
    TIMEOUT,
  );
});
