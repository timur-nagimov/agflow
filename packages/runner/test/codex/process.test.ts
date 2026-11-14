import { withoutTestProcessEnv } from '@agflow/testkit/src/process-cleanup';
// App-server startup, handshake and bounded group shutdown against the scripted peer.
import { afterEach, describe, expect, test } from 'bun:test';
import { AGFLOW_VERSION } from '@agflow/core';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CODEX_VERSION } from '../../src/adapters/codex/binary';
import { appServerArgs, appServerEnv } from '../../src/adapters/codex/config';
import { openAppServer, type OpenAppServerOptions } from '../../src/adapters/codex/process';
import { RpcTimeout } from '../../src/adapters/codex/rpc';
import { runnerPaths } from '../../src/paths';
import { processIdentity } from '../../src/processes';
import { vendorBinary } from '../../src/vendor/pins';
import { codexMessages, codexScenario, readCodexRecord, writeCodexShim, type CodexScenario } from './peer';

const dirs: string[] = [];
const pids: number[] = [];
/** Pipe holders that escaped the app-server's group, so no group kill ends them. */
const escaped: number[] = [];
afterEach(() => {
  for (const pid of [...pids.splice(0), ...escaped.splice(0)]) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // Already gone, including any pipe holders.
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(scenario: CodexScenario | CodexScenario[] = codexScenario()): OpenAppServerOptions {
  const dir = mkdtempSync(join(tmpdir(), 'agflow-codex-process-'));
  dirs.push(dir);
  const codexHome = join(dir, 'codex-home');
  mkdirSync(codexHome);
  const bin = join(runnerPaths(join(dir, 'agflow')).runner, vendorBinary('codex', CODEX_VERSION));
  writeCodexShim(bin, scenario);
  return {
    bin,
    args: appServerArgs({ model_provider: 'scripted' }),
    env: appServerEnv({ base: { PATH: '/usr/bin:/bin' }, bridgeEnv: { AGFLOW_TEST: '1' }, codexHome, userHome: dir }),
    cwd: dir,
    expectedVersion: CODEX_VERSION,
    logFile: join(dir, 'stderr.log'),
    onSpawn: (pid) => {
      pids.push(pid);
    },
  };
}

/** Opened without onSpawn, as preflight and transcript deletion open it. */
function unregistered(options: OpenAppServerOptions): OpenAppServerOptions {
  return { ...options, onSpawn: undefined };
}

const fastEnd = { closeMs: 100, termMs: 100, pipesMs: 100 };
const sqliteFailure = codexScenario({
  failBeforeInitialize: { stderr: 'Error: failed to initialize sqlite state runtime', code: 1 },
});

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the peer');
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

describe('openAppServer', () => {
  test('spawns a group with the given args, env and cwd; onSpawn runs before stderr is drained, with a bound', async () => {
    const options = setup(codexScenario({ stderr: ['startup ' + 'x'.repeat(128 * 1024)] }));
    let spawned: number | undefined;
    options.onSpawn = (pid) => {
      pids.push(pid);
      spawned = pid;
      expect(!existsSync(options.logFile) || readFileSync(options.logFile).length === 0).toBe(true);
    };
    const server = await openAppServer({ ...options, maxStderrBytes: 32 });
    const [run] = readCodexRecord(options.bin);
    expect(run?.pid).toBe(spawned!);
    expect(server.pid).toBe(spawned!);
    expect(run?.argv).toEqual(options.args);
    expect(withoutTestProcessEnv(run!.env)).toEqual(options.env);
    expect(run?.cwd).toBe(realpathSync(options.cwd));
    expect(process.kill(-server.pid, 0)).toBe(true);
    await server.end(fastEnd);
    expect(readFileSync(options.logFile, 'utf8')).toBe(
      'startup ' + 'x'.repeat(24) + '\n[agflow: output truncated after 32 bytes]\n',
    );
  });

  test('ps confirms that the app-server leads its own group', async () => {
    const server = await openAppServer(setup());
    try {
      expect((await processIdentity(server.pid))?.pgid).toBe(server.pid);
    } finally {
      await server.end(fastEnd);
    }
  });

  test('initializes as agflow with its version, then sends initialized', async () => {
    const options = setup();
    const server = await openAppServer(options);
    expect(server.initialize.userAgent).toStartWith(`agflow/${CODEX_VERSION} `);
    await server.end(fastEnd);
    const [run] = readCodexRecord(options.bin);
    expect(run?.requests).toHaveLength(1);
    expect(run?.requests[0]).toMatchObject({
      method: 'initialize',
      params: { clientInfo: { name: 'agflow', title: null, version: AGFLOW_VERSION }, capabilities: null },
    });
    expect(run?.notifications.map((note) => note.method)).toEqual(['initialized']);
    expect(run!.notifications[0]!.at).toBeGreaterThanOrEqual(run!.initializedAt!);
  });

  test('a different version ends through stdin EOF, names both versions, and releases the lock', async () => {
    const options = setup([codexScenario({ version: '0.158.0' }), codexScenario()]);
    const first = openAppServer(options);
    const failed = expect(first).rejects.toThrow(`reports version 0.158.0, expected ${CODEX_VERSION}`);
    const next = openAppServer(options);
    await failed;
    expect(readCodexRecord(options.bin)[0]?.exit?.reason).toBe('eof');
    await (await next).end(fastEnd);
  });

  test('an unreadable userAgent is a version mismatch and ends the process', async () => {
    const result = {
      ...codexMessages.initializeResult(CODEX_VERSION, { name: 'agflow', version: AGFLOW_VERSION }, '/tmp'),
      userAgent: 'unreadable',
    };
    const options = setup(codexScenario({ answers: { initialize: { result } } }));
    await expect(openAppServer(options)).rejects.toThrow(`reports version unknown, expected ${CODEX_VERSION}`);
    expect(readCodexRecord(options.bin)[0]?.exit?.reason).toBe('eof');
  });

  test('accepts the recorded version for a resumed attempt even when it differs from the pin', async () => {
    const options = setup(codexScenario({ version: '0.158.0' }));
    const server = await openAppServer({ ...options, expectedVersion: '0.158.0' });
    expect(server.initialize.userAgent).toStartWith('agflow/0.158.0 ');
    await server.end(fastEnd);
  });

  test('serializes opens on the same resolved home only until initialize answers', async () => {
    const options = setup(codexScenario({ answers: { initialize: { delayMs: 300 } } }));
    const [first, second] = await Promise.all([
      openAppServer(options),
      openAppServer({ ...options, env: { ...options.env, CODEX_HOME: `${options.env.CODEX_HOME}/../codex-home` } }),
    ]);
    const runs = readCodexRecord(options.bin);
    expect(runs).toHaveLength(2);
    expect(runs[1]!.startedAt).toBeGreaterThanOrEqual(runs[0]!.initializedAt!);
    expect(runs[0]!.exit).toBeNull();
    await Promise.all([first.end(fastEnd), second.end(fastEnd)]);
  });

  test('different homes initialize concurrently', async () => {
    const options = setup(codexScenario({ answers: { initialize: { delayMs: 300 } } }));
    const otherHome = join(options.cwd, 'other-home');
    mkdirSync(otherHome);
    const servers = await Promise.all([
      openAppServer(options),
      openAppServer({ ...options, env: { ...options.env, CODEX_HOME: otherHome } }),
    ]);
    const runs = readCodexRecord(options.bin);
    expect(Math.max(...runs.map((run) => run.startedAt))).toBeLessThan(
      Math.min(...runs.map((run) => run.initializedAt!)),
    );
    await Promise.all(servers.map((server) => server.end(fastEnd)));
  });

  test('retries the sqlite startup exit once inside the lock', async () => {
    const options = unregistered(setup([sqliteFailure, codexScenario({ answers: { initialize: { delayMs: 100 } } })]));
    const servers = await Promise.all([openAppServer(options), openAppServer(options)]);
    const runs = readCodexRecord(options.bin);
    pids.push(...runs.map((run) => run.pid));
    expect(runs).toHaveLength(3);
    expect(runs[0]?.exit?.code).toBe(1);
    expect(servers[0]!.pid).toBe(runs[1]!.pid);
    expect(runs[2]!.startedAt).toBeGreaterThanOrEqual(runs[1]!.initializedAt!);
    await Promise.all(servers.map((server) => server.end(fastEnd)));
  });

  test('a second sqlite failure rejects and releases the lock', async () => {
    const options = unregistered(setup([sqliteFailure, sqliteFailure, codexScenario()]));
    await expect(openAppServer(options)).rejects.toThrow(sqliteFailure.failBeforeInitialize!.stderr);
    expect(readCodexRecord(options.bin)).toHaveLength(2);
    const server = await openAppServer(options);
    pids.push(server.pid);
    await server.end(fastEnd);
  });

  test('a registered open does not respawn after the sqlite exit, because a launch registers one pid', async () => {
    const options = setup([sqliteFailure, codexScenario()]);
    const registered: number[] = [];
    await expect(
      openAppServer({
        ...options,
        onSpawn: (pid) => {
          pids.push(pid);
          registered.push(pid);
        },
      }),
    ).rejects.toThrow(sqliteFailure.failBeforeInitialize!.stderr);
    expect(registered).toHaveLength(1);
    expect(readCodexRecord(options.bin)).toHaveLength(1);
    await (await openAppServer(options)).end(fastEnd);
  });

  test('other early exits report the first nonempty stderr line without retrying', async () => {
    const options = setup(
      codexScenario({
        stderr: ['', 'startup failed', 'details'],
        failBeforeInitialize: { stderr: '', code: 7 },
      }),
    );
    await expect(openAppServer(options)).rejects.toThrow(/^startup failed$/);
    expect(readCodexRecord(options.bin)).toHaveLength(1);
  });

  test('an Error line takes precedence over a warning for a missing home', async () => {
    const options = setup();
    options.env.CODEX_HOME = join(options.cwd, 'missing-home');
    await expect(openAppServer(options)).rejects.toThrow(
      `Error: CODEX_HOME points to "${options.env.CODEX_HOME}", but that path does not exist`,
    );
    expect(readCodexRecord(options.bin)).toHaveLength(1);
  });

  test('empty stderr reports the exit code', async () => {
    const options = setup(codexScenario({ failBeforeInitialize: { stderr: '', code: 7 } }));
    await expect(openAppServer(options)).rejects.toThrow('code 7');
  });

  test('an early leader exit is diagnosed even when a child inherited its pipes', async () => {
    const options = setup(
      codexScenario({
        answers: {
          initialize: {
            silent: true,
            then: [{ spawnPipeHolder: true }, { stderr: 'Error: startup crashed' }, { crash: { code: 3 } }],
          },
        },
      }),
    );
    const started = Date.now();
    await expect(openAppServer(options)).rejects.toThrow('Error: startup crashed');
    expect(Date.now() - started).toBeLessThan(1_500);
    const [holder] = readCodexRecord(options.bin)[0]!.pipeHolders;
    expect(holder).toBeNumber();
    await until(() => !alive(holder!));
  });

  test('an early exit is diagnosed from stderr when an escaped process holds the pipes', async () => {
    const options = setup(
      codexScenario({
        answers: {
          initialize: {
            silent: true,
            then: [
              { spawnPipeHolder: { detached: true } },
              { stderr: 'Error: startup crashed' },
              { crash: { code: 3 } },
            ],
          },
        },
      }),
    );
    const started = Date.now();
    const opened = openAppServer({ ...options, initializeTimeoutMs: 10_000 });
    const failed = expect(opened).rejects.toThrow('Error: startup crashed');
    await until(() => readCodexRecord(options.bin)[0]?.pipeHolders.length === 1);
    escaped.push(...readCodexRecord(options.bin)[0]!.pipeHolders);
    await failed;
    // Well before initializeTimeoutMs: the exit, not stdout's end, settles initialize.
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(alive(escaped[0]!)).toBe(true);
  }, 15_000);

  test('a missing binary says binary missing and releases the lock', async () => {
    const options = setup();
    await expect(openAppServer({ ...options, bin: join(options.cwd, 'missing') })).rejects.toThrow(/^binary missing$/);
    await (await openAppServer(options)).end(fastEnd);
  });

  test('a missing working directory is not reported as a missing binary', async () => {
    const options = setup();
    await expect(openAppServer({ ...options, cwd: join(options.cwd, 'removed-clone') })).rejects.toThrow(
      `working directory missing: ${join(options.cwd, 'removed-clone')}`,
    );
    expect(readCodexRecord(options.bin)).toEqual([]);
    await (await openAppServer(options)).end(fastEnd);
  });

  test('a throwing onSpawn kills the group, preserves the error and releases the lock', async () => {
    const options = setup();
    const error = new Error('registration failed');
    let pid = 0;
    await expect(
      openAppServer({
        ...options,
        onSpawn: (value) => {
          pids.push(value);
          pid = value;
          throw error;
        },
      }),
    ).rejects.toBe(error);
    await until(() => !alive(pid));
    await (await openAppServer(options)).end(fastEnd);
  });

  test('initialize has its own timeout, cleans up, and releases the lock', async () => {
    const options = setup([codexScenario({ answers: { initialize: { silent: true } } }), codexScenario()]);
    await expect(openAppServer({ ...options, initializeTimeoutMs: 150, requestTimeoutMs: 1 })).rejects.toThrow(
      'initialize within 150 ms',
    );
    expect(readCodexRecord(options.bin)[0]?.exit?.reason).toBe('eof');
    const server = await openAppServer({ ...options, requestTimeoutMs: 20 });
    await server.end(fastEnd);
  });

  test('passes the ordinary request timeout to rpc', async () => {
    const options = setup(codexScenario({ answers: { 'thread/name/set': { silent: true } } }));
    const server = await openAppServer({ ...options, requestTimeoutMs: 20 });
    await expect(server.rpc.request('thread/name/set', { threadId: 't', name: 'n' })).rejects.toBeInstanceOf(
      RpcTimeout,
    );
    await server.end(fastEnd);
  });
});

describe('end', () => {
  test('closes stdin, gives the exit and returns the same promise on every call', async () => {
    const options = setup();
    const server = await openAppServer(options);
    const ended = server.end(fastEnd);
    expect(server.end({ closeMs: 0 })).toBe(ended);
    expect(await ended).toEqual({ code: 0, signal: null });
    expect(await server.exited).toEqual({ code: 0, signal: null });
    expect(server.end()).toBe(ended);
    expect(readCodexRecord(options.bin)[0]?.exit?.reason).toBe('eof');
    expect(readCodexRecord(options.bin)[0]?.signals).toEqual([]);
  });

  test('escalates to SIGTERM when stdin EOF is ignored', async () => {
    const options = setup(codexScenario({ onStdinEof: 'ignore' }));
    const server = await openAppServer(options);
    expect(await server.end(fastEnd)).toMatchObject({ signal: 'SIGTERM' });
    expect(readCodexRecord(options.bin)[0]?.signals).toEqual(['SIGTERM']);
  });

  test('escalates to SIGKILL when SIGTERM is ignored too', async () => {
    const options = setup(codexScenario({ onStdinEof: 'ignore', ignoreSigterm: true }));
    const server = await openAppServer(options);
    expect(await server.end(fastEnd)).toMatchObject({ signal: 'SIGKILL' });
    expect(readCodexRecord(options.bin)[0]?.signals).toEqual(['SIGTERM']);
  });

  test('stdin EOF also kills the group member holding the pipes', async () => {
    const options = setup(codexScenario({ answers: { 'thread/name/set': { then: [{ spawnPipeHolder: true }] } } }));
    const server = await openAppServer(options);
    await server.rpc.request('thread/name/set', { threadId: 't', name: 'n' });
    await until(() => readCodexRecord(options.bin)[0]!.pipeHolders.length === 1);
    const [holder] = readCodexRecord(options.bin)[0]!.pipeHolders;
    expect(alive(holder!)).toBe(true);
    const started = Date.now();
    expect(await server.end(fastEnd)).toEqual({ code: 0, signal: null });
    expect(Date.now() - started).toBeLessThan(1_000);
    await until(() => !alive(holder!));
  });

  test('kills a pipe holder immediately after an unrequested leader exit and bounds pipe waiting', async () => {
    const options = setup(
      codexScenario({
        answers: { 'thread/name/set': { then: [{ spawnPipeHolder: true }, { crash: { code: 0 } }] } },
      }),
    );
    const server = await openAppServer(options);
    await server.rpc.request('thread/name/set', { threadId: 't', name: 'n' });
    await server.exited;
    const [holder] = readCodexRecord(options.bin)[0]!.pipeHolders;
    expect(holder).toBeNumber();
    const started = Date.now();
    expect(await server.end(fastEnd)).toEqual({ code: 0, signal: null });
    expect(Date.now() - started).toBeLessThan(1_000);
    await until(() => !alive(holder!));
  });

  test('waiting for the pipes after an exit is bounded, even when an escaped process holds them', async () => {
    const options = setup(
      codexScenario({ answers: { 'thread/name/set': { then: [{ spawnPipeHolder: { detached: true } }] } } }),
    );
    const server = await openAppServer(options);
    await server.rpc.request('thread/name/set', { threadId: 't', name: 'n' });
    await until(() => readCodexRecord(options.bin)[0]!.pipeHolders.length === 1);
    escaped.push(...readCodexRecord(options.bin)[0]!.pipeHolders);
    const started = Date.now();
    expect(await server.end(fastEnd)).toEqual({ code: 0, signal: null });
    expect(Date.now() - started).toBeLessThan(1_000);
    // It still holds stdout and stderr; end() stopped waiting for them.
    expect(alive(escaped[0]!)).toBe(true);
  });
});
