import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeAdapter, type FakeScript } from '@agflow/testkit';
import type { AgentEvent, AgentSession, ExitInfo } from '../src/adapters/types';
import { DescendantTracker, listProcesses, type ProcessIdentity, processIdentity } from '../src/processes';
import { standardProfile } from '../src/profile';
import { killAndSweep, runStopLadder } from '../src/stop-ladder';
import { requireLsofOnMacOS } from './prerequisites';

// Every test here runs git or agent processes, which take several times as long on a machine loaded by other suites.
setDefaultTimeout(30_000);

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function killLater(pgid: number): void {
  cleanups.push(() => {
    try {
      process.kill(-pgid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  });
}

const TIMINGS = { stopInterrupt: 400, stopClose: 400, stopKill: 400 };

async function until(check: () => Promise<boolean> | boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out waiting for a condition');
    await Bun.sleep(20);
  }
}

/** True once the process is gone or only a zombie waiting to be reaped. */
async function gone(pid: number): Promise<boolean> {
  const row = (await listProcesses([pid])).find((candidate) => candidate.pid === pid);
  return row === undefined || row.stat.startsWith('Z');
}

/** A pid a tool wrote, once the file holds a whole line. */
async function pidFrom(file: string): Promise<number> {
  let text = '';
  await until(() => {
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      return false;
    }
    return text.endsWith('\n');
  });
  return Number(text.trim());
}

/** Follows a session's events as the controller does: whether a turn runs, and a wait for its end. */
function follow(session: AgentSession) {
  const events: AgentEvent[] = [];
  let inTurn = false;
  const waiters: (() => void)[] = [];
  void (async () => {
    for await (const event of session.events) {
      events.push(event);
      if (event.type === 'turn_started') inTurn = true;
      if (event.type === 'turn_ended') {
        inTurn = false;
        for (const waiter of waiters.splice(0)) waiter();
      }
    }
  })();
  return {
    events,
    turnEnded: () => (inTurn ? new Promise<void>((resolve) => waiters.push(resolve)) : Promise.resolve()),
    started: () => until(() => inTurn),
  };
}

/** A fake agent in a clone directory, started as the runner starts agents, with its recorded identity. */
async function startAgent(script: FakeScript) {
  const dir = tempDir('agflow-ladder-');
  const clone = join(dir, 'T-4-a1');
  mkdirSync(clone);
  const adapter = new FakeAdapter({ script, transcriptDir: join(dir, 'transcripts') });
  const session = await adapter.start({
    attemptId: 'T-4-a1',
    role: 'worker',
    model: 'fake-model',
    cliVersion: '9.9.9',
    clone,
    baseCheckout: null,
    projectConfigVerified: true,
    tmpDir: dir,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir },
    bridge: { command: '/bin/false', args: [], env: {} },
    profile: standardProfile,
    brief: 'brief',
    firstPrompt: 'start working',
    resume: null,
    logFile: join(dir, 'T-4-a1.log'),
    registerProcess: (pid) => killLater(pid),
  });
  const identity = (await processIdentity(session.pid)) as ProcessIdentity;
  return { dir, clone, session, identity, turns: follow(session) };
}

const LONG_SLEEP = { do: 'sleep', ms: 30_000 } as const;

describe('runStopLadder', () => {
  test('close, SIGTERM and SIGKILL each end the agent that ignores the step before', async () => {
    const polite = await startAgent({ turns: [[LONG_SLEEP]] });
    await polite.turns.started();
    const closed = await runStopLadder({
      session: polite.session,
      turnEnded: polite.turns.turnEnded,
      groups: async () => [polite.identity],
      clone: polite.clone,
      timings: TIMINGS,
    });
    expect(closed).toMatchObject({ stoppedBy: 'close', exit: { code: 0, signal: null } });
    expect(polite.turns.events.some((event) => event.type === 'turn_ended' && event.outcome === 'interrupted')).toBe(
      true,
    );

    const stubborn = await startAgent({ turns: [[LONG_SLEEP]], ignoreInterrupt: true, ignoreEofMidTurn: true });
    await stubborn.turns.started();
    const terminated = await runStopLadder({
      session: stubborn.session,
      turnEnded: stubborn.turns.turnEnded,
      groups: async () => [stubborn.identity],
      clone: stubborn.clone,
      timings: TIMINGS,
    });
    // A SIGTERMed claude exits 143, not by signal; stoppedBy says it was asked to.
    expect(terminated).toMatchObject({ stoppedBy: 'sigterm', exit: { code: 143, signal: null } });

    const deaf = await startAgent({
      turns: [[LONG_SLEEP]],
      ignoreInterrupt: true,
      ignoreEofMidTurn: true,
      ignoreSigterm: true,
    });
    await deaf.turns.started();
    const killed = await runStopLadder({
      session: deaf.session,
      turnEnded: deaf.turns.turnEnded,
      groups: async () => [deaf.identity],
      clone: deaf.clone,
      timings: TIMINGS,
    });
    expect(killed).toMatchObject({ stoppedBy: 'sigkill', exit: { signal: 'SIGKILL' } });
    expect(killed.killed).toContain(deaf.identity.pgid);
  }, 60_000);

  test('the interrupt cancels queued input, so a message sent mid-turn starts no second turn', async () => {
    const agent = await startAgent({ turns: [[LONG_SLEEP], [LONG_SLEEP]], ignoreEofMidTurn: true });
    await agent.turns.started();
    await agent.session.send({ id: '41', text: 'one more thing', authority: 'person' });
    const result = await runStopLadder({
      session: agent.session,
      turnEnded: agent.turns.turnEnded,
      groups: async () => [agent.identity],
      clone: agent.clone,
      timings: TIMINGS,
    });
    expect(result.stoppedBy).toBe('close');
    expect(agent.turns.events.filter((event) => event.type === 'turn_started')).toHaveLength(1);
  }, 60_000);

  test('an agent that exits on the interrupt was stopped by interrupt, and is never closed', async () => {
    let exit!: (info: ExitInfo) => void;
    let closes = 0;
    const session = {
      exited: new Promise<ExitInfo>((resolve) => {
        exit = resolve;
      }),
      interrupt: async () => exit({ code: 0, signal: null }),
      close: async () => {
        closes += 1;
      },
    };
    const result = await runStopLadder({
      session,
      // The turn's end is never seen: the exit alone settles the step.
      turnEnded: () => new Promise<void>(() => {}),
      groups: async () => [],
      clone: null,
      timings: TIMINGS,
    });
    expect(result).toEqual({
      stoppedBy: 'interrupt',
      exit: { code: 0, signal: null },
      killed: [],
      swept: [],
      sweepSkipped: null,
    });
    expect(closes).toBe(0);
  });

  test('a close that never returns does not hold the ladder: SIGTERM and SIGKILL still follow in bounds', async () => {
    const agent = await startAgent({
      turns: [[LONG_SLEEP]],
      ignoreInterrupt: true,
      ignoreEofMidTurn: true,
      ignoreSigterm: true,
    });
    await agent.turns.started();
    const began = performance.now();
    const result = await runStopLadder({
      session: {
        interrupt: (options) => agent.session.interrupt(options),
        // Like an adapter whose close waits for the CLI to exit.
        close: () => new Promise<void>(() => {}),
        exited: agent.session.exited,
      },
      turnEnded: agent.turns.turnEnded,
      groups: async () => [agent.identity],
      clone: agent.clone,
      timings: TIMINGS,
    });
    expect(result).toMatchObject({ stoppedBy: 'sigkill', exit: { signal: 'SIGKILL' } });
    expect(performance.now() - began).toBeLessThan(TIMINGS.stopInterrupt + TIMINGS.stopClose + TIMINGS.stopKill + 2_500);
  }, 60_000);

  test('an agent that already exited was stopped by none', async () => {
    const agent = await startAgent({ turns: [[{ do: 'exit', code: 3 }]] });
    await agent.session.exited;
    const result = await runStopLadder({
      session: agent.session,
      turnEnded: agent.turns.turnEnded,
      groups: async () => [agent.identity],
      clone: agent.clone,
      timings: TIMINGS,
    });
    expect(result).toMatchObject({ stoppedBy: 'none', exit: { code: 3 } });
  });

  test.skipIf(process.platform !== 'darwin')(
    'a tool group dies with the agent, and a detached process left in the clone is swept (the runner supports darwin-arm64 only; design 7.1)',
    async () => {
      requireLsofOnMacOS();
      const outside = tempDir('agflow-ladder-outside-');
      const toolPid = join(outside, 'tool.pid');
      const leftPid = join(outside, 'left.pid');
      const scripted = await startAgent({
        turns: [
          [
            // Its own group, working outside the clone: only the group kill reaches it.
            { do: 'tool', command: `cd / && echo $$ > '${toolPid}' && exec sleep 30`, wait: false },
            // Left behind in the clone by a shell that has exited: only the sweep finds it.
            { do: 'tool', command: `sleep 30 >/dev/null 2>&1 & echo $! > '${leftPid}'` },
            LONG_SLEEP,
          ],
        ],
      });
      const tool = await pidFrom(toolPid);
      const left = await pidFrom(leftPid);
      killLater(tool);
      cleanups.push(() => {
        try {
          process.kill(left, 'SIGKILL');
        } catch {
          // Already gone.
        }
      });
      const tracker = new DescendantTracker();
      await tracker.snapshot([scripted.identity]);
      expect(tracker.groups().map((group) => group.pgid)).toContain(tool);
      const result = await runStopLadder({
        session: scripted.session,
        turnEnded: scripted.turns.turnEnded,
        groups: async () => {
          await tracker.snapshot([scripted.identity]);
          return tracker.groups();
        },
        clone: scripted.clone,
        timings: TIMINGS,
      });
      expect(result.stoppedBy).toBe('close');
      expect(result.killed).toContain(tool);
      expect(result.swept).toContain(left);
      await until(() => gone(tool));
      await until(() => gone(left));
    },
    60_000,
  );

  test('a recorded group whose leader identity changed is not signalled', async () => {
    const elsewhere = tempDir('agflow-ladder-elsewhere-');
    const bystander = Bun.spawn(['sh', '-c', 'exec sleep 30'], {
      cwd: elsewhere,
      detached: true,
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    });
    killLater(bystander.pid);
    const real = (await processIdentity(bystander.pid)) as ProcessIdentity;
    const reused = { ...real, lstart: 'Thu Jan  1 00:00:00 1970' };
    const agent = await startAgent({
      turns: [[LONG_SLEEP]],
      ignoreInterrupt: true,
      ignoreEofMidTurn: true,
      ignoreSigterm: true,
    });
    await agent.turns.started();
    const result = await runStopLadder({
      session: agent.session,
      turnEnded: agent.turns.turnEnded,
      groups: async () => [agent.identity, reused],
      clone: agent.clone,
      timings: TIMINGS,
    });
    expect(result.stoppedBy).toBe('sigkill');
    expect(result.killed).not.toContain(real.pgid);
    expect(await processIdentity(bystander.pid)).toEqual(real);
  }, 60_000);

  test.skipIf(process.platform !== 'darwin')(
    'returns within its bounds while an escaped grandchild holds the pipes open (the runner supports darwin-arm64 only; design 7.1)',
    async () => {
      requireLsofOnMacOS();
      const agent = await startAgent({
        turns: [[{ do: 'tool', command: 'exec sleep 30', wait: false, inheritPipes: true }, LONG_SLEEP]],
        ignoreInterrupt: true,
        ignoreEofMidTurn: true,
        ignoreSigterm: true,
      });
      await until(() => agent.turns.events.some((event) => event.type === 'tool_ended'));
      const began = performance.now();
      const result = await runStopLadder({
        session: agent.session,
        turnEnded: agent.turns.turnEnded,
        groups: async () => [agent.identity],
        clone: agent.clone,
        timings: TIMINGS,
      });
      const elapsed = performance.now() - began;
      expect(result.stoppedBy).toBe('sigkill');
      // Three steps of 400 ms, the bounded wait for the killed agent, and the sweep.
      expect(elapsed).toBeLessThan(TIMINGS.stopInterrupt + TIMINGS.stopClose + TIMINGS.stopKill + 2_500);
      expect(result.swept.length).toBeGreaterThan(0);
    },
    60_000,
  );
});

describe('killAndSweep', () => {
  test.skipIf(process.platform !== 'darwin')(
    'SIGKILLs a tool group that outlived the agent and sweeps the clone, sparing a reused identity (the runner supports darwin-arm64 only; design 7.1)',
    async () => {
      requireLsofOnMacOS();
      const outside = tempDir('agflow-ladder-outside-');
      const toolPid = join(outside, 'tool.pid');
      const leftPid = join(outside, 'left.pid');
      const agent = await startAgent({
        turns: [
          [
            { do: 'tool', command: `cd / && echo $$ > '${toolPid}' && exec sleep 30`, wait: false },
            { do: 'tool', command: `sleep 30 >/dev/null 2>&1 & echo $! > '${leftPid}'` },
          ],
        ],
      });
      const tool = await pidFrom(toolPid);
      const left = await pidFrom(leftPid);
      killLater(tool);
      cleanups.push(() => {
        try {
          process.kill(left, 'SIGKILL');
        } catch {
          // Already gone.
        }
      });
      const toolIdentity = (await processIdentity(tool)) as ProcessIdentity;
      // The agent ends on its own: an exit the runner did not request.
      await agent.session.close();
      await agent.session.exited;
      const bystander = Bun.spawn(['sh', '-c', 'exec sleep 30'], {
        cwd: outside,
        detached: true,
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore',
      });
      killLater(bystander.pid);
      const real = (await processIdentity(bystander.pid)) as ProcessIdentity;
      const result = await killAndSweep({
        groups: async () => [agent.identity, toolIdentity, { ...real, lstart: 'Thu Jan  1 00:00:00 1970' }],
        clone: agent.clone,
      });
      expect(result.killed).toEqual([tool]);
      expect(result.swept).toEqual([left]);
      expect(result.sweepSkipped).toBeNull();
      await until(() => gone(tool));
      await until(() => gone(left));
      expect(await processIdentity(bystander.pid)).toEqual(real);
    },
    60_000,
  );

  test('a link the agent put in place of its clone is not swept through, and a failed sweep fails nothing', async () => {
    // The owner's directory the link points at, where one of their own processes works.
    const home = tempDir('agflow-ladder-home-');
    mkdirSync(join(home, 'projects', 'website'), { recursive: true });
    const bystander = Bun.spawn(['sh', '-c', 'exec sleep 30'], {
      cwd: join(home, 'projects', 'website'),
      detached: true,
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    });
    killLater(bystander.pid);
    const real = (await processIdentity(bystander.pid)) as ProcessIdentity;
    const clone = join(tempDir('agflow-ladder-link-'), 'T-4-a1');
    symlinkSync(home, clone);
    const result = await killAndSweep({ groups: async () => [], clone });
    expect(result).toEqual({ killed: [], swept: [], sweepSkipped: 'the clone path is not a directory' });
    expect(await processIdentity(bystander.pid)).toEqual(real);

    // A sweep that cannot run, such as one of a clone path too wide to sweep, is reported, not thrown.
    const wide = await killAndSweep({ groups: async () => [], clone: '/usr' });
    expect(wide.sweepSkipped).toMatch(/^the sweep failed: refusing to sweep/);
    expect(await processIdentity(bystander.pid)).toEqual(real);
  }, 60_000);
});
