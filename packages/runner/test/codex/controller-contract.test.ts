// The real AttemptController drives the real Codex adapter over a scripted app-server (design 13, 6.3, 15).
// These tests keep the runner's process, delivery, approval and cleanup contracts on the same path as production.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCodexAdapter } from '../../src/adapters/codex';
import { vendorBinary } from '../../src/vendor/pins';
import {
  cleanupRunnerFixtures,
  createRunnerFixture,
  FIXTURE_PROJECT,
  fixtureAgentToken,
  fixtureCliVersion,
  type RunnerFixture,
  type RunnerFixtureOptions,
  waitFor,
} from '../fixture';
import {
  codexMessages as m,
  codexScenario,
  FAKE_THREAD_ID as THREAD,
  fakeTurnId,
  readCodexRecord,
  writeCodexShim,
  type ScriptedAnswers,
} from './peer';
import { firstInput, mcp, skills } from './session-fixture';

afterEach(cleanupRunnerFixtures);

const ATTEMPT = 'T-4-a1';
const FENCE = { epoch: 1, counter: 1 };
const TURN = fakeTurnId(1);
const begin = () => m.turnStarted(THREAD, m.turn({ id: TURN, status: 'inProgress' }));
const finish = () => m.turnCompleted(THREAD, m.turn({ id: TURN, status: 'completed' }));
const input = (text: string) => [{ type: 'text', text, text_elements: [] }];
const cloneOf = (f: RunnerFixture) => f.paths.clone(FIXTURE_PROJECT, ATTEMPT);
const requests = (bin: string, method: string) =>
  readCodexRecord(bin).flatMap((run) => run.requests.filter((request) => request.method === method));

function scenario(answers: ScriptedAnswers = {}, version = fixtureCliVersion('codex')) {
  return codexScenario({
    version,
    answers: {
      'mcpServerStatus/list': { result: mcp() },
      'skills/list': { result: skills('system') },
      'turn/start': { then: [{ notify: begin() }] },
      ...answers,
    },
  });
}

async function setup(answers: (f: RunnerFixture) => ScriptedAnswers = () => ({}), options: RunnerFixtureOptions = {}) {
  const f = await createRunnerFixture(options);
  const bin = join(f.paths.runner, vendorBinary('codex', fixtureCliVersion('codex')));
  writeCodexShim(bin, scenario(answers(f)));
  // The fixture marks vendors ready without a preflight: the adapter's start makes the Codex homes itself.
  const env = { AGFLOW_TEST: '1' };
  f.adapters.set('codex', createCodexAdapter({ config: f.config, paths: f.paths, env, requestTimeoutMs: 1_000 }));
  return { f, bin, controller: f.controller() };
}

const turnsEnded = (f: RunnerFixture) => f.events('attempt.activity').filter((event) => event.data.kind === 'turn');

async function stop(controller: ReturnType<RunnerFixture['controller']>) {
  expect(
    await controller.stop({
      fence: controller.fence!,
      reason: 'contract test finished',
      handoff: false,
      interruptFirst: false,
      keepClone: true,
    }),
  ).toMatchObject({ ok: true });
}

describe('AttemptController with CodexAdapter', () => {
  test('start_attempt reports the thread, launch model, CLI version and permission mode', async () => {
    const { f, bin, controller } = await setup();
    const spec = f.spec({ vendor: 'codex', model: 'contract-model' });
    expect(await controller.start(spec)).toEqual({ started: true });
    const spawned = await waitFor(() => f.events('attempt.spawned')[0]);
    expect(spawned).toMatchObject({
      attemptId: ATTEMPT,
      fence: FENCE,
      data: {
        sessionRef: THREAD,
        pid: controller.session!.pid,
        model: spec.model,
        cliVersion: fixtureCliVersion('codex'),
        permissionMode: 'on-request',
        startSha: f.origin.mainSha,
      },
    });
    expect(requests(bin, 'thread/start')[0]?.params).toMatchObject({ model: spec.model });
    expect(requests(bin, 'turn/start').map((request) => request.params)).toEqual([
      { threadId: THREAD, input: firstInput(spec.firstPrompt) },
    ]);
    await stop(controller);
  });

  test('resume_attempt runs the binary of the recorded CLI version', async () => {
    const { f, bin, controller } = await setup(() => ({
      'turn/start': { then: [{ notify: begin() }, { notify: finish() }] },
    }));
    const spec = f.spec({ vendor: 'codex' });
    expect(await controller.start(spec)).toEqual({ started: true });
    await waitFor(() => turnsEnded(f).length === 1);
    await stop(controller);
    const version = '0.158.0';
    const recordedBin = join(f.paths.runner, vendorBinary('codex', version));
    writeCodexShim(recordedBin, scenario({}, version));
    f.store.update(ATTEMPT, { cliVersion: version });
    const fence = { epoch: 1, counter: 2 };
    const prompt = 'Review feedback: rename the helper.';
    expect(
      await controller.resume({
        fence,
        agentToken: fixtureAgentToken(`${ATTEMPT} resumed`),
        prompt,
        messages: [],
        taskPack: null,
        restore: spec.restore,
        acceptanceIds: spec.acceptanceIds,
      }),
    ).toEqual({ resumed: true });
    const spawned = await waitFor(() => f.events('attempt.spawned')[1]);
    expect(spawned).toMatchObject({ fence, data: { sessionRef: THREAD, cliVersion: version, startSha: null } });
    expect(readCodexRecord(bin)).toHaveLength(1);
    expect(readCodexRecord(recordedBin)).toHaveLength(1);
    expect(requests(recordedBin, 'thread/resume')[0]?.params).toMatchObject({ threadId: THREAD });
    expect(requests(recordedBin, 'thread/start')).toEqual([]);
    expect(requests(recordedBin, 'turn/start').map((request) => request.params)).toEqual([
      { threadId: THREAD, input: input(prompt) },
    ]);
    await stop(controller);
  });

  test('command activity and a completed submit end the turn without a continuation', async () => {
    const { f, bin, controller } = await setup(
      (f) => {
        const command = m.commandExecutionItem({ id: 'command', command: 'pwd', cwd: cloneOf(f) });
        const submit = m.mcpToolCallItem({ id: 'submit', tool: 'submit', args: {} });
        return {
          'turn/start': {
            then: [
              { notify: begin() },
              { notify: m.itemStarted(THREAD, TURN, command) },
              { notify: m.itemCompleted(THREAD, TURN, { ...command, status: 'completed', exitCode: 0 }) },
              { notify: m.itemStarted(THREAD, TURN, submit) },
              {
                notify: m.itemCompleted(
                  THREAD,
                  TURN,
                  m.mcpToolCallItem({
                    id: submit.id,
                    tool: 'submit',
                    args: {},
                    status: 'completed',
                    result: 'submission pending',
                  }),
                ),
              },
              { notify: finish() },
            ],
          },
        };
      },
      { config: { timings: { continuationWait: 100 } } },
    );
    expect(await controller.start(f.spec({ vendor: 'codex' }))).toEqual({ started: true });
    await waitFor(() => turnsEnded(f).length === 1);
    expect(f.events('attempt.activity').map((event) => event.data)).toEqual([
      { kind: 'tool', summary: 'exec_command: pwd' },
      { kind: 'tool', summary: 'mcp__agflow__submit: {}' },
      { kind: 'turn', summary: 'turn completed with 2 tool calls' },
    ]);
    // Keep the live session beyond the continuation deadline: the successful terminal must suppress it.
    await Bun.sleep(400);
    expect(requests(bin, 'turn/start')).toHaveLength(1);
    expect(controller.facts()).toMatchObject({ phase: 'idle', turns: 1, continuations: 0 });
    await stop(controller);
  });

  test('deliver steers the current turn and reports the hub message id through acknowledgement', async () => {
    const { f, bin, controller } = await setup(() => ({
      'turn/steer': { then: [{ notify: finish() }] },
    }));
    expect(await controller.start(f.spec({ vendor: 'codex' }))).toEqual({ started: true });
    await waitFor(() => controller.phase === 'turn');
    const message = { messageId: 42, authority: 'person' as const, text: 'Also update the README.' };
    expect(await controller.deliver({ fence: FENCE, messages: [message], more: 0 })).toEqual({ ok: true });
    const acknowledged = await waitFor(() => f.events('attempt.acknowledged')[0]);
    const delivered = f.events('attempt.delivered')[0]!;
    for (const event of [delivered, acknowledged]) {
      expect(event).toMatchObject({ attemptId: ATTEMPT, fence: FENCE, data: { messageIds: [42] } });
    }
    expect(delivered.seq).toBeLessThan(acknowledged.seq);
    expect(f.events('attempt.delivered')).toHaveLength(1);
    expect(f.events('attempt.acknowledged')).toHaveLength(1);
    expect(requests(bin, 'turn/steer').map((request) => request.params)).toEqual([
      { threadId: THREAD, expectedTurnId: TURN, input: input(message.text) },
    ]);
    expect(requests(bin, 'turn/start')).toHaveLength(1);
    await stop(controller);
  });

  test('npm install relays the manifest diff and applies an approval only once', async () => {
    const requestId = 'install-approval';
    const { f, bin, controller } = await setup(
      (f) => {
        const item = m.commandExecutionItem({ id: 'install', command: 'npm install', cwd: cloneOf(f) });
        return {
          'turn/steer': {
            then: [
              { notify: m.itemStarted(THREAD, TURN, item) },
              {
                request: m.commandApprovalRequest({ threadId: THREAD, turnId: TURN, item, id: requestId }),
                afterAnswer: [
                  { notify: m.serverRequestResolved(THREAD, requestId) },
                  { notify: m.itemCompleted(THREAD, TURN, { ...item, status: 'completed', exitCode: 0 }) },
                  { notify: finish() },
                ],
              },
            ],
          },
        };
      },
      { files: { 'package.json': '{"dependencies":{}}\n' } },
    );
    expect(await controller.start(f.spec({ vendor: 'codex' }))).toEqual({ started: true });
    await waitFor(() => controller.phase === 'turn');
    writeFileSync(join(cloneOf(f), 'package.json'), '{"dependencies":{"left-pad":"1.3.0"}}\n');
    expect(
      await controller.deliver({
        fence: FENCE,
        messages: [{ messageId: 51, authority: 'person', text: 'Install the changed dependencies.' }],
        more: 0,
      }),
    ).toEqual({ ok: true });
    const requested = await waitFor(() => f.events('approval.requested')[0]);
    expect(requested).toMatchObject({ attemptId: ATTEMPT, fence: FENCE, data: { kind: 'command' } });
    expect(requested.data.approvalId).toMatch(/^[0-9a-f-]{36}$/);
    expect(requested.data.approvalId).not.toBe(requestId);
    expect(requested.data.detail.command).toContain('npm install');
    expect(requested.data.detail.manifestDiff).toContain('package.json');
    expect(requested.data.detail.manifestDiff).toContain('-{"dependencies":{}}');
    expect(requested.data.detail.manifestDiff).toContain('+{"dependencies":{"left-pad":"1.3.0"}}');
    const decision = {
      fence: FENCE,
      approvalId: requested.data.approvalId,
      decision: 'approve' as const,
      reason: null,
    };
    expect(await controller.decideApproval(decision)).toEqual({ applied: true });
    expect(await controller.decideApproval(decision)).toEqual({ applied: false });
    await waitFor(() => turnsEnded(f).length === 1);
    expect(readCodexRecord(bin)[0]!.answers.filter((answer) => answer.id === requestId)).toEqual([
      { id: requestId, result: { decision: 'accept' }, at: expect.any(Number) },
    ]);
    expect(f.events('approval.voided')).toEqual([]);
    await stop(controller);
  });

  test('a peer crash voids its pending approval before reporting attempt.exited', async () => {
    const requestId = 'pending-approval';
    const { f, bin, controller } = await setup((f) => ({
      'turn/start': {
        then: [
          { notify: begin() },
          {
            request: m.commandApprovalRequest({
              threadId: THREAD,
              turnId: TURN,
              item: m.commandExecutionItem({ id: 'command', command: 'rm -rf build', cwd: cloneOf(f) }),
              id: requestId,
            }),
          },
        ],
      },
      // The test observes the pending approval before asking the peer to crash.
      'turn/steer': { then: [{ delayMs: 30 }, { crash: { signal: 'SIGKILL' } }] },
    }));
    expect(await controller.start(f.spec({ vendor: 'codex' }))).toEqual({ started: true });
    const requested = await waitFor(() => f.events('approval.requested')[0]);
    expect(readCodexRecord(bin)[0]!.answers).toEqual([]);
    expect(
      await controller.deliver({
        fence: FENCE,
        messages: [{ messageId: 61, authority: 'person', text: 'Check progress.' }],
        more: 0,
      }),
    ).toEqual({ ok: true });
    const exited = await waitFor(() => f.events('attempt.exited')[0]);
    const voided = f.events('approval.voided');
    expect(voided).toHaveLength(1);
    expect(voided[0]).toMatchObject({
      attemptId: ATTEMPT,
      fence: FENCE,
      data: { approvalId: requested.data.approvalId },
    });
    expect(requested.seq).toBeLessThan(voided[0]!.seq);
    expect(voided[0]!.seq).toBeLessThan(exited.seq);
    expect(exited.data).toMatchObject({ code: null, signal: 'SIGKILL', stoppedBy: 'none' });
    expect(
      await controller.decideApproval({
        fence: FENCE,
        approvalId: requested.data.approvalId,
        decision: 'approve',
        reason: null,
      }),
    ).toEqual({ applied: false });
    await controller.settled();
  });

  test('cleanup_attempt deletes the recorded thread through the pinned app-server', async () => {
    const { f, bin, controller } = await setup();
    writeCodexShim(bin, [
      scenario({ 'turn/start': { then: [{ notify: begin() }, { notify: finish() }] } }),
      scenario({ 'thread/delete': { result: {} } }),
    ]);
    expect(await controller.start(f.spec({ vendor: 'codex' }))).toEqual({ started: true });
    const spawned = await waitFor(() => f.events('attempt.spawned')[0]);
    await waitFor(() => turnsEnded(f).length === 1);
    await stop(controller);
    expect(await controller.cleanup()).toEqual({ ok: true });
    const runs = readCodexRecord(bin);
    expect(runs).toHaveLength(2);
    expect(
      runs[1]!.requests.filter((request) => request.method === 'thread/delete').map((request) => request.params),
    ).toEqual([{ threadId: spawned.data.sessionRef }]);
    expect(runs[1]!.exit).toMatchObject({ code: 0, signal: null });
    expect(existsSync(cloneOf(f))).toBe(false);
    expect(f.store.get(ATTEMPT)?.clone).toBeNull();
  });
});
