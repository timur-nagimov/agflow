import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AttemptFacts } from '@agflow/core';
import { getAttempt, updateAttempt } from '../src/attempt-store';
import { mintAgentToken } from '../src/auth';
import { type HubContext, createContext } from '../src/context';
import { listEvents } from '../src/events';
import { getHubState, inRecovery, updateHubState } from '../src/hub-state';
import { acquireDbLock, checkClock, dbLockRecord, releaseDbLock } from '../src/recovery';
import { type TickResult, runTick } from '../src/scheduler';
import { type HubServer, startHub } from '../src/server';
import { getTask } from '../src/task-store';
import { claimTask, createTasks } from '../src/tasks';
import { type TestClock, addAgent, addRunner, addRunnerAttempt, createTestContext, makeConfig, newTask } from './helpers';
import { createTestHub } from './http-helpers';

const MINUTE = 60_000;

const leaseOf = (ctx: HubContext, attemptId: string) => getAttempt(ctx, attemptId).leaseExpiresAt;
const taskLeaseOf = (ctx: HubContext, taskId: string) => getTask(ctx, taskId).leaseExpiresAt;
const eventsOf = (ctx: HubContext, type: string) => listEvents(ctx.db).filter((event) => event.type === type);
/** The pid a lock file names; the boot beside it moves by a second from one reading of the clock to the next. */
const lockPid = (path: string) => readFileSync(path, 'utf8').split(' ')[0];

/** Facts that report an hour of vendor errors: a fresh report makes the tick replace the attempt (design 6.8). */
function erringFacts(ctx: HubContext, attemptId: string): AttemptFacts {
  return {
    attemptId,
    fence: getAttempt(ctx, attemptId).fence,
    phase: 'turn',
    eventAgeMs: 5_000,
    tool: null,
    fsAgeMs: 20_000,
    commitAgeMs: null,
    turns: 3,
    turnsWithoutProgress: 0,
    repeatedCalls: 0,
    continuations: 0,
    vendorErrorMs: ctx.config.vendorErrorReplaceMs,
    activeMs: 90_000,
    contextUsed: 0.4,
  };
}

describe('the clock check', () => {
  test('a gap over 3 ticks extends the leases by it and starts the recovery window; recovery_ended follows it', () => {
    const { ctx, clock } = createTestContext();
    const held = addRunnerAttempt(ctx);
    const [live] = createTasks(ctx, [newTask({ title: 'Live' })], 'user:alice');
    claimTask(ctx, live?.id as string, addAgent(ctx));
    const runnerLease = leaseOf(ctx, held.attempt.id) as number;
    const taskLease = taskLeaseOf(ctx, live?.id as string) as number;

    // Exactly three ticks is a hub that ran late, not downtime.
    clock.advance(3 * ctx.config.tickMs);
    expect(checkClock(ctx)).toEqual({ gapMs: 3 * ctx.config.tickMs, downtime: false, recoveryEnded: false });
    expect(getHubState(ctx)).toMatchObject({ lastAliveAt: ctx.now(), recoveryUntil: null });
    expect(leaseOf(ctx, held.attempt.id)).toBe(runnerLease);

    const gapMs = 3 * ctx.config.tickMs + 1;
    clock.advance(gapMs);
    expect(checkClock(ctx)).toEqual({ gapMs, downtime: true, recoveryEnded: false });
    const until = ctx.now() + ctx.config.recoveryMs;
    expect(getHubState(ctx)).toMatchObject({ lastAliveAt: ctx.now(), recoveryUntil: until });
    expect(leaseOf(ctx, held.attempt.id)).toBe(runnerLease + gapMs);
    expect(taskLeaseOf(ctx, live?.id as string)).toBe(taskLease + gapMs);
    expect(eventsOf(ctx, 'system.recovery_started').map((event) => [event.subject, event.data])).toEqual([
      [null, { gapMs, until }],
    ]);
    expect(inRecovery(ctx)).toBe(true);

    // The ticks go on every tickMs meanwhile; the window ends with the first one at or after recovery_until.
    while (ctx.now() + ctx.config.tickMs < until) {
      clock.advance(ctx.config.tickMs);
      expect(checkClock(ctx)).toMatchObject({ downtime: false, recoveryEnded: false });
    }
    clock.advance(until - ctx.now() - 1);
    expect(checkClock(ctx).recoveryEnded).toBe(false);
    expect(inRecovery(ctx)).toBe(true);
    clock.advance(1);
    expect(inRecovery(ctx)).toBe(false);
    expect(checkClock(ctx)).toEqual({ gapMs: 1, downtime: false, recoveryEnded: true });
    expect(getHubState(ctx).recoveryUntil).toBeNull();
    expect(eventsOf(ctx, 'system.recovery_ended')).toHaveLength(1);
    expect(checkClock(ctx).recoveryEnded).toBe(false);
    expect(eventsOf(ctx, 'system.recovery_ended')).toHaveLength(1);
  });

  test('a backward clock step is not downtime and shortens no lease', () => {
    const { ctx } = createTestContext();
    const held = addRunnerAttempt(ctx);
    const lease = leaseOf(ctx, held.attempt.id);
    // The last tick ran ten minutes "later" than now: the clock was stepped back.
    updateHubState(ctx, { lastAliveAt: ctx.now() + 10 * MINUTE });
    expect(checkClock(ctx)).toEqual({ gapMs: -10 * MINUTE, downtime: false, recoveryEnded: false });
    expect(leaseOf(ctx, held.attempt.id)).toBe(lease);
    expect(getHubState(ctx)).toMatchObject({ lastAliveAt: ctx.now(), recoveryUntil: null });
    expect(eventsOf(ctx, 'system.recovery_started')).toEqual([]);
  });

  test('a backward clock step cuts an open recovery window back to recoveryMs from now', () => {
    const { ctx, clock } = createTestContext();
    clock.advance(10 * MINUTE);
    checkClock(ctx);
    const until = getHubState(ctx).recoveryUntil as number;
    // Thirty seconds into the window the clock steps back an hour: the window ends at most recoveryMs later.
    clock.advance(30_000);
    checkClock(ctx);
    clock.advance(-60 * MINUTE);
    expect(checkClock(ctx)).toMatchObject({ downtime: false, recoveryEnded: false });
    expect(getHubState(ctx).recoveryUntil).toBe(ctx.now() + ctx.config.recoveryMs);
    expect(until - ctx.now()).toBeGreaterThan(ctx.config.recoveryMs);
    // A window that ends sooner than that keeps its end.
    updateHubState(ctx, { recoveryUntil: ctx.now() + 1_000, lastAliveAt: ctx.now() + MINUTE });
    checkClock(ctx);
    expect(getHubState(ctx).recoveryUntil).toBe(ctx.now() + 1_000);
    clock.advance(1_000);
    expect(checkClock(ctx).recoveryEnded).toBe(true);
  });
});

describe('the recovery window', () => {
  /** Ticks every tickMs, as the scheduler's timer does, until a tick runs past the window; returns that tick. */
  function tickOut(ctx: HubContext, clock: TestClock, beforeEach: () => void): TickResult {
    for (;;) {
      clock.advance(ctx.config.tickMs);
      beforeEach();
      const result = runTick(ctx);
      if (!result.recovering) return result;
      expect([result.reconciled, result.lead, result.started]).toEqual([null, null, []]);
    }
  }

  test('nothing expires, stalls or dispatches until recovery_until, while bridge calls work', async () => {
    const hub = createTestHub();
    const { ctx, clock } = hub;
    ctx.db.run('UPDATE project SET runner_leads = 0 WHERE id = 1');
    const lost = addRunnerAttempt(ctx);
    const erring = addRunnerAttempt(ctx);
    addRunner(ctx);
    const [ready] = createTasks(ctx, [newTask({ title: 'Ready' })], 'user:alice');
    const token = mintAgentToken(ctx, lost.attempt);

    clock.advance(10 * MINUTE);
    const first = runTick(ctx);
    expect(first).toMatchObject({ clock: { downtime: true }, recovering: true, reconciled: null, started: [] });
    // Within the window: a lease that ran out, facts that call for a replacement, and a ready task with a free slot.
    updateAttempt(ctx, lost.attempt.id, { leaseExpiresAt: ctx.now() - 1 });
    updateAttempt(ctx, erring.attempt.id, { facts: erringFacts(ctx, erring.attempt.id), factsAt: ctx.now() });
    expect(runTick(ctx)).toMatchObject({ recovering: true, reconciled: null, started: [] });
    expect(getAttempt(ctx, lost.attempt.id).status).toBe('running');
    expect(getAttempt(ctx, erring.attempt.id).stopRequested).toBeNull();
    expect(getTask(ctx, ready?.id as string).status).toBe('ready');
    const call = await hub.call('GET', '/api/tasks', { headers: { authorization: `Bearer ${token}` } });
    expect(call.status).toBe(200);

    const after = tickOut(ctx, clock, () =>
      updateAttempt(ctx, erring.attempt.id, { facts: erringFacts(ctx, erring.attempt.id), factsAt: ctx.now() }),
    );
    expect(after.clock).toMatchObject({ downtime: false, recoveryEnded: true });
    expect(after.reconciled).toMatchObject({ runnerLeases: 1, stalls: { stopped: [erring.attempt.id] } });
    expect(after.started.map((attempt) => attempt.taskId)).toContain(ready?.id);
    expect(getAttempt(ctx, lost.attempt.id).endReason).toBe('lost');
    expect(eventsOf(ctx, 'system.recovery_ended')).toHaveLength(1);
  });
});

describe('startHub', () => {
  const servers: HubServer[] = [];
  const dirs: string[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) await server.stop();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function fileContext(): { ctx: HubContext; dbPath: string; pidPath: string } {
    const dir = mkdtempSync(join(tmpdir(), 'agflow-recovery-'));
    dirs.push(dir);
    const dbPath = join(dir, 'agflow.db');
    const ctx = createContext({ dbPath, config: makeConfig() });
    return { ctx, dbPath, pidPath: `${dbPath}.pid` };
  }

  /** The pid of a process that has exited. */
  function deadPid(): number {
    const child = Bun.spawnSync(['true']);
    return child.pid;
  }

  test('checks the clock at start: downtime starts the recovery window', async () => {
    const { ctx, clock } = createTestContext();
    const held = addRunnerAttempt(ctx);
    const lease = leaseOf(ctx, held.attempt.id) as number;
    clock.advance(20 * MINUTE);
    const hub = startHub(ctx, { timers: false });
    servers.push(hub);
    expect(getHubState(ctx)).toMatchObject({ lastAliveAt: ctx.now(), recoveryUntil: ctx.now() + ctx.config.recoveryMs });
    expect(leaseOf(ctx, held.attempt.id)).toBe(lease + 20 * MINUTE);
    expect(eventsOf(ctx, 'system.recovery_started')).toHaveLength(1);
  });

  test('with dbLock it keeps <db>.pid, refuses a live holder, replaces a stale one and removes it on stop', async () => {
    const { ctx, dbPath, pidPath } = fileContext();
    const own = String(process.pid);
    const hub = startHub(ctx, { dbLock: true, timers: false });
    expect(lockPid(pidPath)).toBe(own);
    await hub.stop();
    expect(existsSync(pidPath)).toBe(false);

    // Another hub that runs: the file names a live process of this boot.
    const other = Bun.spawn(['sleep', '30']);
    try {
      writeFileSync(pidPath, dbLockRecord(other.pid));
      expect(() => startHub(ctx, { dbLock: true, timers: false })).toThrow(
        `the database ${dbPath} is in use by process ${other.pid}`,
      );
      expect(lockPid(pidPath)).toBe(String(other.pid));
      // The same pid written in an earlier boot names some other process now: the file is stale.
      writeFileSync(pidPath, `${other.pid} 1\n`);
      acquireDbLock(dbPath);
      expect(lockPid(pidPath)).toBe(own);
      releaseDbLock(dbPath);
    } finally {
      other.kill();
      await other.exited;
    }
    // It is gone now, so its file is stale.
    writeFileSync(pidPath, dbLockRecord(other.pid));
    const again = startHub(ctx, { dbLock: true, timers: false });
    expect(lockPid(pidPath)).toBe(own);
    await again.stop();
    // A file that names no pid and boot is stale too; one that names this process is its own lock already.
    for (const text of ['garbage', '', `${other.pid}\n`]) {
      writeFileSync(pidPath, text);
      acquireDbLock(dbPath);
      acquireDbLock(dbPath);
      expect(lockPid(pidPath)).toBe(own);
      releaseDbLock(dbPath);
      expect(existsSync(pidPath)).toBe(false);
    }
    writeFileSync(pidPath, dbLockRecord(deadPid()));
    const third = startHub(ctx, { dbLock: true, timers: false });
    servers.push(third);
    expect(lockPid(pidPath)).toBe(own);
    // Only the lock file is left: the files it was written and replaced through are gone.
    expect(readdirSync(dirname(pidPath)).filter((name) => name.includes('.pid'))).toEqual(['agflow.db.pid']);
  });

  test('of processes racing for one stale lock, exactly one takes it', async () => {
    const { dbPath, pidPath } = fileContext();
    writeFileSync(pidPath, dbLockRecord(deadPid()));
    const script = `
      import { acquireDbLock } from ${JSON.stringify(join(import.meta.dir, '../src/recovery.ts'))};
      await Bun.sleep(Number(process.argv[2]) - Date.now());
      try {
        acquireDbLock(process.argv[1]);
        console.log('took');
        await Bun.sleep(1_000);
      } catch (error) {
        console.log(error.message);
      }
    `;
    const at = Date.now() + 500;
    const racers = Array.from({ length: 6 }, () =>
      Bun.spawn(['bun', '--eval', script, dbPath, String(at)], { stdout: 'pipe', stderr: 'inherit' }),
    );
    const outputs = await Promise.all(racers.map((racer) => new Response(racer.stdout).text()));
    const took = outputs.filter((output) => output.trim() === 'took');
    expect(took).toHaveLength(1);
    for (const output of outputs.filter((one) => one.trim() !== 'took')) {
      expect(output).toMatch(/is in use by process|another process took it/);
    }
  }, 20_000);

  test('releasing leaves a lock file that names another process alone', () => {
    const { dbPath, pidPath } = fileContext();
    writeFileSync(pidPath, dbLockRecord(deadPid()));
    releaseDbLock(dbPath);
    expect(existsSync(pidPath)).toBe(true);
  });

  test('without dbLock it writes no lock file; an in-memory database cannot be locked', async () => {
    const { ctx, pidPath } = fileContext();
    const hub = startHub(ctx, { timers: false });
    servers.push(hub);
    expect(existsSync(pidPath)).toBe(false);
    const memory = createTestContext().ctx;
    expect(() => startHub(memory, { dbLock: true, timers: false })).toThrow('dbLock needs a database file');
  });
});

describe('the hub process', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** A port that was free a moment ago. */
  function freePort(): number {
    const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response() });
    const { port } = probe;
    probe.stop(true);
    return port as number;
  }

  /** Reads the stream until its text contains what it waits for. */
  async function readUntil(stream: ReadableStream<Uint8Array>, wanted: string): Promise<string> {
    const decoder = new TextDecoder();
    let text = '';
    for await (const chunk of stream) {
      text += decoder.decode(chunk);
      if (text.includes(wanted)) return text;
    }
    throw new Error(`the hub exited before printing "${wanted}":\n${text}`);
  }

  function spawnHub(dir: string, args: string[] = []) {
    const dbPath = join(dir, 'agflow.db');
    return Bun.spawn(['bun', ...args, join(import.meta.dir, '../src/main.ts')], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: dir,
        AGFLOW_AUTH: 'dev',
        AGFLOW_ALLOWED_USERS: 'alice',
        AGFLOW_PROJECT_NAME: 'signals',
        AGFLOW_PROJECT_REPO: 'https://github.com/acme/signals',
        AGFLOW_PORT: String(freePort()),
        AGFLOW_DB: dbPath,
        AGFLOW_BACKUP_DIR: join(dir, 'backups'),
      },
      stdout: 'pipe',
      stderr: 'inherit',
    });
  }

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    test(`${signal} at the readiness announcement shuts down cleanly`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'agflow-signal-ready-'));
      dirs.push(dir);
      const dbPath = join(dir, 'agflow.db');
      const preload = join(dir, 'signal-at-ready.ts');
      // Send the real OS signal before the banner's console.log returns. This pins the earliest moment a reader
      // can signal readiness, without depending on the parent winning a scheduling race or adding a sleep.
      writeFileSync(preload, `
        const log = console.log;
        console.log = (...args) => {
          log(...args);
          if (String(args[0]).startsWith('agflow hub for "signals"')) {
            process.kill(process.pid, ${JSON.stringify(signal)});
          }
        };
      `);
      const hub = spawnHub(dir, ['--preload', preload]);
      try {
        const output = new Response(hub.stdout).text();
        expect(await hub.exited).toBe(0);
        expect(await output).toContain(`${signal}: stopping the hub`);
        expect(existsSync(`${dbPath}.pid`)).toBe(false);
        expect(existsSync(`${dbPath}-wal`) ? statSync(`${dbPath}-wal`).size : 0).toBe(0);
      } finally {
        hub.kill('SIGKILL');
        await hub.exited;
      }
    }, 20_000);

    test(`${signal} closes the database with the WAL checkpointed and removes the lock file`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'agflow-signal-'));
      dirs.push(dir);
      const dbPath = join(dir, 'agflow.db');
      const hub = spawnHub(dir);
      try {
        await readUntil(hub.stdout, 'agflow hub for "signals"');
        expect(lockPid(`${dbPath}.pid`)).toBe(String(hub.pid));
        expect(existsSync(`${dbPath}-wal`)).toBe(true);
        hub.kill(signal);
        expect(await hub.exited).toBe(0);
      } finally {
        hub.kill('SIGKILL');
      }
      expect(existsSync(`${dbPath}.pid`)).toBe(false);
      expect(existsSync(`${dbPath}-wal`) ? statSync(`${dbPath}-wal`).size : 0).toBe(0);
    }, 20_000);
  }
});
