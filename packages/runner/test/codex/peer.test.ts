import { afterEach, describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CODEX_VERSION, codexBinaryVersion } from '../../src/adapters/codex/binary';
import type { ServerNotification } from '../../src/adapters/codex/protocol';
import { CodexRpc, RpcClosed, RpcError, RpcTimeout } from '../../src/adapters/codex/rpc';
import { runnerPaths } from '../../src/paths';
import { boundedWait, drainToLog } from '../../src/processes';
import { vendorBinary } from '../../src/vendor/pins';
import probeMessages from './probe-messages.json';
import {
  type CodexScenario,
  codexMessages as m,
  codexScenario,
  FAKE_THREAD_ID,
  fakeTurnId,
  readCodexRecord,
  writeCodexShim,
} from './peer';

const dirs: string[] = [];
const procs: { pid: number }[] = [];
afterEach(() => {
  // The whole group, so pipe holders go too.
  for (const proc of procs.splice(0)) {
    try {
      process.kill(-proc.pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agflow-codex-peer-')));
  dirs.push(dir);
  return dir;
}

const clientInfo = { name: 'agflow', title: null, version: '0.1.0' };

/** A shim at the runner's vendor path, as an adapter would find it. */
function shimAt(scenario: CodexScenario | CodexScenario[]): { bin: string; dir: string } {
  const dir = tempDir();
  const bin = join(runnerPaths(join(dir, 'agflow')).runner, vendorBinary('codex', CODEX_VERSION));
  writeCodexShim(bin, scenario);
  return { bin, dir };
}

const ARGV = ['app-server', '--disable', 'hooks', '-c', 'allow_login_shell=false'];

/**
 * Starts the shim as app-server in its own process group, with CODEX_HOME at <dir>/codex-home (created, as the
 * runner must), its stderr drained into a log and a CodexRpc on its pipes.
 */
function start(bin: string, dir: string, env: Record<string, string> = {}) {
  mkdirSync(join(dir, 'codex-home'), { recursive: true });
  const proc = Bun.spawn([bin, ...ARGV], {
    cwd: dir,
    env: { PATH: '/usr/bin:/bin', CODEX_HOME: join(dir, 'codex-home'), ...env },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    detached: true,
  });
  procs.push(proc);
  const log = join(dir, 'stderr.log');
  const drained = drainToLog(proc.stderr, log, { maxBytes: 1 << 20 });
  const rpc = new CodexRpc({ stdin: proc.stdin, stdout: proc.stdout, requestTimeoutMs: 10_000 });
  return { proc, rpc, drained, log };
}

/** initialize, then initialized, as a client must before anything else. */
async function initialize(rpc: CodexRpc) {
  const result = await rpc.request('initialize', { clientInfo, capabilities: null });
  rpc.notify('initialized');
  return result;
}

const failure = (promise: Promise<unknown>) => promise.catch((caught: unknown) => caught);

async function until(condition: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the condition');
    await Bun.sleep(10);
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('writeCodexShim', () => {
  test('writes an executable codex at any path that prints the scripted version', async () => {
    const { bin } = shimAt(codexScenario());
    expect(statSync(bin).mode & 0o111).toBe(0o111);
    expect(await codexBinaryVersion(bin)).toBe(CODEX_VERSION);
    writeCodexShim(bin, codexScenario({ version: '0.150.0' }));
    expect(await codexBinaryVersion(bin)).toBe('0.150.0');
    // --version is no app-server run.
    expect(readCodexRecord(bin)).toEqual([]);
  }, 20_000);

  test('shims sharing one script each read their own scenario, even when started at the same time', async () => {
    const dir = tempDir();
    const versions = ['0.150.0', '0.151.0', '0.152.0'];
    const bins = versions.map((version, index) =>
      writeCodexShim(join(dir, String(index), 'codex'), codexScenario({ version })),
    );
    // Each shim started more than once, all at the same time: enough to interleave them, few enough for a loaded host.
    const starts = 12;
    const printed = await Promise.all(
      Array.from({ length: starts }, async (_, index) => {
        const proc = Bun.spawn([bins[index % 3] as string, '--version'], { stdout: 'pipe', stderr: 'ignore' });
        const [output] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
        return output.trim();
      }),
    );
    expect(printed).toEqual(Array.from({ length: starts }, (_, index) => `codex-cli ${versions[index % 3]}`));
  }, 60_000);

  test('refuses to replace a file that is not a shim, such as a real binary', () => {
    const dir = tempDir();
    const bin = join(dir, 'bin', 'codex');
    mkdirSync(join(dir, 'bin'));
    writeFileSync(bin, '#!/bin/sh\necho "codex-cli 0.159.2"\n');
    expect(() => writeCodexShim(bin, codexScenario())).toThrow('is not a fake codex shim');
    expect(readFileSync(bin, 'utf8')).toBe('#!/bin/sh\necho "codex-cli 0.159.2"\n');
  });

  test('answers initialize with the version in userAgent and a scripted thread/start', async () => {
    const { bin, dir } = shimAt(codexScenario({ threadId: 'thread-42' }));
    const { proc, rpc } = start(bin, dir);
    const init = await initialize(rpc);
    expect(init.userAgent).toStartWith(`agflow/${CODEX_VERSION} (`);
    expect(init.codexHome).toBe(join(dir, 'codex-home'));
    const clone = join(dir, 'clone');
    const started = await rpc.request('thread/start', {
      cwd: clone,
      model: 'gpt-6.1-sol',
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      config: { sandbox_workspace_write: { writable_roots: [`${clone}/.git`], network_access: false } },
    });
    expect(started).toMatchObject({
      thread: { id: 'thread-42', cwd: clone, cliVersion: CODEX_VERSION, status: { type: 'idle' }, turns: [] },
      model: 'gpt-6.1-sol',
      cwd: clone,
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandbox: { type: 'workspaceWrite', writableRoots: [`${clone}/.git`], networkAccess: false },
    });
    // Fields 0.159.2 sends beyond the generated types.
    expect(started).toMatchObject({
      runtimeWorkspaceRoots: [clone, `${clone}/.git`],
      multiAgentMode: 'explicitRequestOnly',
    });
    proc.stdin.end();
    expect(await proc.exited).toBe(0);
  }, 20_000);

  test('a scripted answer replaces the default, and calls of a method take its scripted answers in turn', async () => {
    const { bin, dir } = shimAt(
      codexScenario({
        answers: {
          'thread/start': { result: m.threadStartResult({ thread: m.thread({ id: 'scripted', cwd: '/x' }) }) },
          'thread/delete': [{ error: { code: -32600, message: 'thread is loaded' } }, { result: {} }],
        },
      }),
    );
    const { rpc } = start(bin, dir);
    await initialize(rpc);
    expect((await rpc.request('thread/start', { cwd: dir })).thread.id).toBe('scripted');
    const first = await failure(rpc.request('thread/delete', { threadId: 'scripted' }));
    expect(first).toBeInstanceOf(RpcError);
    expect(first).toMatchObject({ code: -32600, message: 'thread is loaded' });
    expect(await rpc.request('thread/delete', { threadId: 'scripted' })).toEqual({});
    expect(await rpc.request('thread/delete', { threadId: 'scripted' })).toEqual({});
    // Nothing scripted and no default: the method is unknown to the fake.
    const missing = await failure(rpc.request('skills/list', { cwds: [dir] }));
    expect(missing).toMatchObject({ code: -32601 });
  }, 20_000);

  test('answers thread/resume with the thread it names, the resolved cwd and the echoed policy', async () => {
    const { bin, dir } = shimAt(codexScenario());
    const clone = join(dir, 'clone');
    mkdirSync(clone);
    const link = join(dir, 'clone-link');
    symlinkSync(clone, link);
    const { rpc } = start(bin, dir);
    const notifications: string[] = [];
    rpc.onNotification((notification) => notifications.push(notification.method));
    await initialize(rpc);
    const resumed = await rpc.request('thread/resume', {
      threadId: 'thread-old',
      cwd: link,
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandbox: 'workspace-write',
      config: { sandbox_workspace_write: { writable_roots: [`${clone}/.git`], network_access: false } },
    });
    expect(resumed).toMatchObject({
      thread: { id: 'thread-old', cwd: clone },
      cwd: clone,
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandbox: { type: 'workspaceWrite', writableRoots: [`${clone}/.git`], networkAccess: false },
      turnsBackwardsCursor: null,
      itemsBackwardsCursor: null,
    });
    // Only thread/start announces a thread.
    await rpc.request('thread/name/set', { threadId: 'thread-old', name: 'n' });
    expect(notifications).toEqual([]);
  }, 20_000);

  test('refuses requests before initialize and a second initialize, as 0.159.2 does', async () => {
    const { bin, dir } = shimAt(codexScenario());
    const { rpc } = start(bin, dir);
    const early = await failure(rpc.request('thread/start', { cwd: dir }));
    expect(early).toBeInstanceOf(RpcError);
    expect(early).toMatchObject({ code: -32600, message: 'Not initialized' });
    await initialize(rpc);
    const again = await failure(rpc.request('initialize', { clientInfo, capabilities: null }));
    expect(again).toMatchObject({ code: -32600, message: 'Already initialized' });
    expect((await rpc.request('thread/start', { cwd: dir })).thread.id).toBe(FAKE_THREAD_ID);
  }, 20_000);

  test('exits 1 with the two lines of 0.159.2 when CODEX_HOME does not exist', async () => {
    const { bin, dir } = shimAt(codexScenario({ stderr: ['never written'] }));
    const missing = join(dir, 'no-such-home');
    const { proc, rpc, drained, log } = start(bin, dir, { CODEX_HOME: missing });
    expect(await failure(initialize(rpc))).toBeInstanceOf(RpcClosed);
    expect(await proc.exited).toBe(1);
    await drained;
    expect(readFileSync(log, 'utf8')).toBe(
      `WARNING: proceeding, even though we could not create PATH aliases: CODEX_HOME points to "${missing}", ` +
        'but that path does not exist\n' +
        `Error: CODEX_HOME points to "${missing}", but that path does not exist\n`,
    );
    expect(readCodexRecord(bin)[0]?.exit).toMatchObject({ reason: 'failed', code: 1 });
  }, 20_000);
});

describe('scripted follow-ups', () => {
  test('notifications and server requests follow the answer they belong to; the answers are recorded', async () => {
    const threadId = FAKE_THREAD_ID;
    const turnId = fakeTurnId(1);
    const command = m.commandExecutionItem({ id: 'exec-1', command: 'touch out.txt', cwd: '/clone' });
    const { bin, dir } = shimAt(
      codexScenario({
        answers: {
          'turn/start': {
            then: [
              { notify: m.turnStarted(threadId, m.turn({ id: turnId, status: 'inProgress' })) },
              { notify: m.threadStatusChanged(threadId, ['waitingOnApproval']) },
              // As 0.159.2 does it after the client's answer: resolved, the declined item, the end of the turn.
              {
                request: m.commandApprovalRequest({ threadId, turnId, item: command, reason: 'write outside' }),
                afterAnswer: [
                  { notify: m.serverRequestResolved(threadId, 0) },
                  { notify: m.itemCompleted(threadId, turnId, { ...command, status: 'declined' }) },
                  { notify: m.turnCompleted(threadId, m.turn({ id: turnId, status: 'completed' })) },
                ],
              },
            ],
          },
        },
      }),
    );
    const { proc, rpc } = start(bin, dir);
    const order: string[] = [];
    rpc.onNotification((notification) => order.push(notification.method));
    // Answered late, as after the owner's decision: what follows the answer still waits for it.
    rpc.handle('item/commandExecution/requestApproval', async (params, id) => {
      order.push(`request ${id} ${params.itemId}`);
      await Bun.sleep(200);
      order.push('answering');
      return { decision: 'decline' };
    });
    const completed = new Promise<void>((resolve) => rpc.on('turn/completed', () => resolve()));
    await initialize(rpc);
    await rpc.request('thread/start', { cwd: dir });
    const input = [{ type: 'text' as const, text: 'go', text_elements: [] }];
    const turn = await rpc.request('turn/start', { threadId, input });
    order.push(`answer ${turn.turn.id}`);
    await completed;
    expect(order).toEqual([
      'thread/started',
      `answer ${turnId}`,
      'turn/started',
      'thread/status/changed',
      'request 0 exec-1',
      'answering',
      'serverRequest/resolved',
      'item/completed',
      'turn/completed',
    ]);
    proc.stdin.end();
    await proc.exited;
    const [run] = readCodexRecord(bin);
    expect(run?.answers).toEqual([{ id: 0, result: { decision: 'decline' }, at: expect.any(Number) }]);
    expect(run?.requests.map((request) => request.method)).toEqual(['initialize', 'thread/start', 'turn/start']);
    expect(run?.requests[2]?.params).toEqual({ threadId, input });
  }, 20_000);

  test('by default an answered server request is followed by serverRequest/resolved; afterAnswer [] sends none', async () => {
    const threadId = FAKE_THREAD_ID;
    const turnId = fakeTurnId(1);
    const approval = (itemId: string) =>
      m.fileChangeApprovalRequest({ threadId, turnId, itemId, reason: 'write .agflow/config.json' });
    const { bin, dir } = shimAt(
      codexScenario({
        answers: {
          'turn/start': { then: [{ request: approval('patch-1'), afterAnswer: [] }, { request: approval('patch-2') }] },
        },
      }),
    );
    const { rpc } = start(bin, dir);
    const order: string[] = [];
    rpc.on('serverRequest/resolved', (params) => order.push(`resolved ${params.requestId}`));
    rpc.handle('item/fileChange/requestApproval', async (params, id) => {
      await Bun.sleep(100);
      order.push(`answer ${id} ${params.itemId}`);
      return { decision: 'accept' };
    });
    await initialize(rpc);
    await rpc.request('turn/start', { threadId, input: [] });
    await until(() => order.includes('resolved 1'));
    expect(order).toEqual(['answer 0 patch-1', 'answer 1 patch-2', 'resolved 1']);
  }, 20_000);

  test('follow-ups without a delay go out before the answer to a request that came in after', async () => {
    const { bin, dir } = shimAt(
      codexScenario({
        answers: {
          'thread/name/set': { then: [{ notify: m.warning('first') }, { notify: m.warning('second') }] },
        },
      }),
    );
    const { rpc } = start(bin, dir);
    await initialize(rpc);
    const order: string[] = [];
    rpc.on('warning', (params) => order.push(params.message));
    const named = rpc.request('thread/name/set', { threadId: 't', name: 'n' }).then(() => order.push('named'));
    const interrupted = rpc
      .request('turn/interrupt', { threadId: 't', turnId: 'u' })
      .then(() => order.push('interrupted'));
    await Promise.all([named, interrupted]);
    expect(order).toEqual(['named', 'first', 'second', 'interrupted']);
  }, 20_000);

  test('a silent answer leaves the request unanswered', async () => {
    const { bin, dir } = shimAt(codexScenario({ answers: { 'turn/interrupt': { silent: true } } }));
    const { rpc } = start(bin, dir);
    await initialize(rpc);
    const error = await failure(rpc.request('turn/interrupt', { threadId: 't', turnId: 'u' }, { timeoutMs: 300 }));
    expect(error).toBeInstanceOf(RpcTimeout);
  }, 20_000);

  test('the default turn ids count up per run, and steer answers with the expected turn', async () => {
    const { bin, dir } = shimAt(codexScenario());
    const { rpc } = start(bin, dir);
    await initialize(rpc);
    const first = await rpc.request('turn/start', { threadId: FAKE_THREAD_ID, input: [] });
    const second = await rpc.request('turn/start', { threadId: FAKE_THREAD_ID, input: [] });
    expect([first.turn.id, second.turn.id]).toEqual([fakeTurnId(1), fakeTurnId(2)]);
    expect(first.turn.status).toBe('inProgress');
    const steer = await rpc.request('turn/steer', {
      threadId: FAKE_THREAD_ID,
      expectedTurnId: second.turn.id,
      input: [{ type: 'text', text: 'more', text_elements: [] }],
    });
    expect(steer).toEqual({ turnId: fakeTurnId(2) });
  }, 20_000);
});

describe('the record', () => {
  test('holds argv, the exact environment, the start time and the time initialize was answered', async () => {
    const { bin, dir } = shimAt(codexScenario({ answers: { initialize: { delayMs: 200 } } }));
    const before = Date.now();
    const { proc, rpc } = start(bin, dir, { AGFLOW_MARKER: 'm-1' });
    await initialize(rpc);
    // Recorded before the answer was written, so it is there once the answer is.
    expect(readCodexRecord(bin)[0]?.initializedAt).not.toBeNull();
    proc.stdin.end();
    expect(await proc.exited).toBe(0);
    const [run, ...others] = readCodexRecord(bin);
    expect(others).toEqual([]);
    expect(run).toMatchObject({
      run: 0,
      pid: proc.pid,
      argv: ['app-server', '--disable', 'hooks', '-c', 'allow_login_shell=false'],
      cwd: dir,
      exit: { reason: 'eof', code: 0, signal: null },
    });
    // Exactly what the spawner passed: nothing added on the way, so a leaked variable shows.
    expect(run?.env).toEqual({ AGFLOW_MARKER: 'm-1', CODEX_HOME: join(dir, 'codex-home'), PATH: '/usr/bin:/bin' });
    expect(run?.startedAt).toBeGreaterThanOrEqual(before);
    expect(run?.initializedAt).toBeGreaterThanOrEqual((run?.startedAt as number) + 200);
    expect(run?.notifications.map((notification) => notification.method)).toEqual(['initialized']);
  }, 20_000);

  test('each start is one run, and a list of scenarios gives the n-th run the n-th one', async () => {
    const failing = codexScenario({
      failBeforeInitialize: { stderr: 'Error: failed to initialize sqlite state runtime', code: 7 },
    });
    const { bin, dir } = shimAt([failing, codexScenario({ threadId: 'second' }), codexScenario({ threadId: 'third' })]);
    const first = start(bin, dir);
    const initialize = first.rpc.request('initialize', { clientInfo, capabilities: null });
    expect(await failure(initialize)).toBeInstanceOf(RpcClosed);
    expect(await first.proc.exited).toBe(7);
    await first.drained;
    // The reason is the first line, as with 0.159.2, which writes nothing else there on a start.
    expect(readFileSync(first.log, 'utf8')).toBe('Error: failed to initialize sqlite state runtime\n');
    const ids: string[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const next = start(bin, dir);
      await next.rpc.request('initialize', { clientInfo, capabilities: null });
      ids.push((await next.rpc.request('thread/start', { cwd: dir })).thread.id);
      next.proc.stdin.end();
      await next.proc.exited;
    }
    expect(ids).toEqual(['second', 'third', 'third']);
    const runs = readCodexRecord(bin);
    expect(runs.map((run) => [run.run, run.initializedAt === null, run.exit?.reason])).toEqual([
      [0, true, 'failed'],
      [1, false, 'eof'],
      [2, false, 'eof'],
      [3, false, 'eof'],
    ]);
    expect(runs[0]?.exit).toMatchObject({ reason: 'failed', code: 7, signal: null });
  }, 30_000);
});

describe('exits', () => {
  test('a scripted crash exits with its code, and pending requests reject with RpcClosed', async () => {
    const { bin, dir } = shimAt(
      codexScenario({ answers: { 'turn/start': { silent: true, then: [{ crash: { code: 3 } }] } } }),
    );
    const { proc, rpc } = start(bin, dir);
    await initialize(rpc);
    expect(await failure(rpc.request('turn/start', { threadId: 't', input: [] }))).toBeInstanceOf(RpcClosed);
    expect(await proc.exited).toBe(3);
    expect(readCodexRecord(bin)[0]?.exit).toMatchObject({ reason: 'crash', code: 3, signal: null });
  }, 20_000);

  test('a scripted signal kills the peer with it', async () => {
    const { bin, dir } = shimAt(
      codexScenario({ answers: { 'thread/name/set': { then: [{ crash: { signal: 'SIGKILL' } }] } } }),
    );
    const { proc, rpc } = start(bin, dir);
    await initialize(rpc);
    expect(await rpc.request('thread/name/set', { threadId: 't', name: 'agflow T-1-a1' })).toEqual({});
    await proc.exited;
    expect(proc.signalCode).toBe('SIGKILL');
    expect(readCodexRecord(bin)[0]?.exit).toMatchObject({ reason: 'crash', code: null, signal: 'SIGKILL' });
  }, 20_000);

  test('the peer writes to stderr, at start, per message and when scripted, so drains are exercised', async () => {
    const { bin, dir } = shimAt(
      codexScenario({
        stderr: ['WARN codex_core: scripted startup line'],
        answers: { 'thread/name/set': { then: [{ stderr: 'ERROR codex_core: scripted failure' }] } },
      }),
    );
    const { proc, rpc, drained, log } = start(bin, dir);
    await initialize(rpc);
    await rpc.request('thread/name/set', { threadId: 't', name: 'n' });
    proc.stdin.end();
    await proc.exited;
    expect((await drained).bytes).toBeGreaterThan(0);
    const text = readFileSync(log, 'utf8');
    expect(text).toContain('WARN codex_core: scripted startup line');
    expect(text).toContain('thread/name/set');
    expect(text).toContain('ERROR codex_core: scripted failure');
  }, 20_000);
});

describe('process groups', () => {
  test('a SIGTERM ends the peer by default, and the record says so', async () => {
    const { bin, dir } = shimAt(codexScenario());
    const { proc, rpc } = start(bin, dir);
    await initialize(rpc);
    process.kill(-proc.pid, 'SIGTERM');
    await proc.exited;
    expect(proc.signalCode).toBe('SIGTERM');
    const [run] = readCodexRecord(bin);
    expect(run?.signals).toEqual(['SIGTERM']);
    expect(run?.exit).toMatchObject({ reason: 'signal', code: null, signal: 'SIGTERM' });
  }, 20_000);

  test('told to, the peer outlives stdin EOF and SIGTERM, and only a group SIGKILL ends it', async () => {
    const { bin, dir } = shimAt(codexScenario({ onStdinEof: 'ignore', ignoreSigterm: true }));
    const { proc, rpc } = start(bin, dir);
    await initialize(rpc);
    proc.stdin.end();
    expect((await boundedWait(proc.exited, 300)).done).toBe(false);
    process.kill(-proc.pid, 'SIGTERM');
    await until(() => readCodexRecord(bin)[0]?.signals.length === 1);
    expect((await boundedWait(proc.exited, 300)).done).toBe(false);
    process.kill(-proc.pid, 'SIGKILL');
    await proc.exited;
    expect(proc.signalCode).toBe('SIGKILL');
    const [run] = readCodexRecord(bin);
    expect(run?.signals).toEqual(['SIGTERM']);
    expect(run?.exit).toBeNull();
  }, 20_000);

  test('a pipe holder keeps stdout open after the peer exits, until its group is killed', async () => {
    const { bin, dir } = shimAt(
      codexScenario({ answers: { 'thread/name/set': { then: [{ spawnPipeHolder: true }, { crash: { code: 0 } }] } } }),
    );
    const { proc, rpc } = start(bin, dir);
    await initialize(rpc);
    await rpc.request('thread/name/set', { threadId: 't', name: 'n' });
    expect(await proc.exited).toBe(0);
    const [holder] = readCodexRecord(bin)[0]?.pipeHolders ?? [];
    expect(holder).toBeNumber();
    expect(alive(holder as number)).toBe(true);
    // The leader is gone, but its stdout is not closed.
    expect((await boundedWait(rpc.ended, 300)).done).toBe(false);
    process.kill(-proc.pid, 'SIGKILL');
    expect((await boundedWait(rpc.ended, 2_000)).done).toBe(true);
    await until(() => !alive(holder as number));
  }, 20_000);
});

describe('codexMessages', () => {
  test('build the 0.159.2 shapes recorded in the probes', () => {
    const usage = m.rateLimitsUpdated({
      primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1793207969 },
      secondary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: 1793290769 },
      credits: { hasCredits: false, unlimited: false, balance: null },
    });
    expect(usage).toEqual({
      method: 'account/rateLimits/updated',
      params: {
        rateLimits: {
          limitId: 'codex',
          limitName: null,
          normalModelSlug: null,
          primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1793207969 },
          secondary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: 1793290769 },
          credits: { hasCredits: false, unlimited: false, balance: null },
          individualLimit: null,
          spendControlReached: null,
          planType: null,
          rateLimitReachedType: null,
        },
      },
    });
    const error = m.turnError({ httpConnectionFailed: { httpStatusCode: 401 } }, 'unexpected status 401 Unauthorized');
    expect(m.error('t', 'u', error)).toEqual({
      method: 'error',
      params: {
        error: {
          message: 'unexpected status 401 Unauthorized',
          codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } },
          additionalDetails: null,
          misalignment: null,
        },
        willRetry: false,
        threadId: 't',
        turnId: 'u',
      },
    });
    const failed: ServerNotification = m.turnCompleted('t', m.turn({ id: 'u', status: 'failed', error }));
    expect(failed).toMatchObject({ params: { turn: { status: 'failed', error, itemsView: 'notLoaded' } } });
    expect(m.threadStatusChanged('t', ['waitingOnApproval']).params.status).toEqual({
      type: 'active',
      activeFlags: ['waitingOnApproval'],
    });
    expect(m.threadStatusChanged('t', 'idle').params.status).toEqual({ type: 'idle' });
    const approval = m.commandApprovalRequest({
      threadId: 't',
      turnId: 'u',
      item: m.commandExecutionItem({ id: 'exec-1', command: "echo 'it''s' > x", cwd: '/clone' }),
      kind: 'writeStdin',
      proposedExecpolicyAmendment: null,
    });
    expect(approval).toMatchObject({
      method: 'item/commandExecution/requestApproval',
      params: {
        kind: 'writeStdin',
        itemId: 'exec-1',
        command: `/bin/zsh -c 'echo '\\''it'\\'''\\''s'\\'' > x'`,
        commandActions: [{ type: 'unknown', command: "echo 'it''s' > x" }],
        cwd: '/clone',
        environmentId: 'local',
        proposedExecpolicyAmendment: null,
        availableDecisions: ['accept', 'cancel'],
      },
    });
  });

  /** The message with its times, which no builder can reproduce, set to 0. */
  function masked(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(masked);
    if (value === null || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, field]) => [
        key,
        ['startedAtMs', 'completedAtMs'].includes(key) ? 0 : masked(field),
      ]),
    );
  }

  /** A builder's message equals the recorded one, times aside. */
  function same(built: unknown, recorded: unknown): void {
    expect(masked(built)).toEqual(masked(recorded));
  }

  test('reproduce the messages 0.159.2 sent in the probes, fed the recorded inputs', () => {
    const recorded = probeMessages;
    const esc = recorded.commandApprovalRequest.params;
    const declinedItem = m.commandExecutionItem({
      id: esc.itemId,
      command: 'touch /tmp/m2e-probe/outside.txt; echo done',
      cwd: esc.cwd,
      status: 'declined',
    });
    same(
      m.commandApprovalRequest({ threadId: esc.threadId, turnId: esc.turnId, item: declinedItem, reason: esc.reason }),
      recorded.commandApprovalRequest,
    );
    same(m.itemCompleted(esc.threadId, esc.turnId, declinedItem), recorded.commandExecutionDeclined);
    same(m.serverRequestResolved(esc.threadId, 0), recorded.serverRequestResolved);

    const code = recorded.commandExecutionCompleted.params;
    const completed = m.commandExecutionItem({
      id: code.item.id,
      command: 'echo hi > probe.txt && cat probe.txt',
      cwd: code.item.cwd,
      status: 'completed',
      exitCode: 0,
      output: 'hi\n',
      source: 'unifiedExecStartup',
      processId: '63721',
    });
    same(m.itemCompleted(code.threadId, code.turnId, completed), recorded.commandExecutionCompleted);

    // The second request of a turn: total counts both, last only the latest.
    const usage = recorded.tokenUsageUpdated.params;
    same(
      m.tokenUsageUpdated(usage.threadId, usage.turnId, {
        total: { input: 200, output: 10 },
        last: { input: 100, output: 5 },
      }),
      recorded.tokenUsageUpdated,
    );

    // A bridge's error answer: failed, with the text in result and no error.
    const mcp = recorded.mcpToolCallFailed.params;
    const failed = m.mcpToolCallItem({
      id: mcp.item.id,
      tool: 'submit',
      args: { note: 'x' },
      status: 'failed',
      result: 'refused: dirty',
      durationMs: 0,
    });
    same(m.itemCompleted(mcp.threadId, mcp.turnId, failed), recorded.mcpToolCallFailed);

    const limits = recorded.usageLimitRateLimits.params.rateLimits;
    same(
      m.rateLimitsUpdated({ primary: limits.primary, secondary: limits.secondary, credits: limits.credits }),
      recorded.usageLimitRateLimits,
    );
    const error = recorded.usageLimitError.params;
    same(
      m.error(error.threadId, error.turnId, m.turnError('usageLimitExceeded', error.error.message)),
      recorded.usageLimitError,
    );
  });
});
