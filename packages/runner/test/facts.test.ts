import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AttemptSpec, capForCommand, judgeStall, parseRunnerMessage, type StallLimits } from '@agflow/core';
import { gitIn, originRepo } from '@agflow/testkit';
import type { AgentEvent } from '../src/adapters/types';
import { AwakeClock, type ClockSource } from '../src/clock';
import { diffFingerprint, FactsTracker } from '../src/facts';
import { createTaskClone } from '../src/git/clone';
import { ensureRunnerGitFiles, localGitEnv, remoteGitEnv } from '../src/git/run';
import { Vault } from '../src/git/vault';
import { runnerPaths } from '../src/paths';
import { PLANTED_ATTRIBUTES, plantCloneConfig, touchLater } from './planted-config';

// Every test here runs git or agent processes, which take several times as long on a machine loaded by other suites.
setDefaultTimeout(30_000);

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const FENCE = { epoch: 1, counter: 4 };
const CAPS: AttemptSpec['toolCaps'] = {
  defaultMs: 30 * 60_000,
  longMs: 90 * 60_000,
  checks: [{ cmd: 'bun run check:all', capMs: 100 * 60_000 }],
};

/** Wall time the test moves by hand; the awake clock reads it, and no timer of it ever fires. */
class ManualSource implements ClockSource {
  t = Date.UTC(2026, 9, 30, 9, 0, 0);
  now = () => this.t;
  setTimeout = () => 0;
  clearTimeout = () => {};
  setInterval = () => 0;
  clearInterval = () => {};
}

/** Moves wall time in awake steps of 1 s, as the clock's 1 s tick sees it. */
function awake(source: ManualSource, clock: AwakeClock, ms: number): void {
  for (let left = ms; left > 0; left -= 1_000) {
    source.t += Math.min(1_000, left);
    clock.awakeNow();
  }
}

/** A sleep: one jump of wall time, of which the clock counts only a tick. */
function sleep(source: ManualSource, clock: AwakeClock, ms: number): void {
  source.t += ms;
  clock.awakeNow();
}

async function until(check: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for a condition');
    await Bun.sleep(20);
  }
}

/** A tracker on a plain directory, with a fingerprint the test sets. */
function tracker(options: { clone?: string; fingerprint?: () => Promise<string> } = {}) {
  const source = new ManualSource();
  const clock = new AwakeClock({ source, tickMs: 1_000, gapMs: 5_000 });
  const clone = options.clone ?? tempDir('agflow-facts-');
  const facts = new FactsTracker({
    attemptId: 'T-4-a1',
    fence: FENCE,
    clone,
    toolCaps: CAPS,
    clock,
    fingerprint: options.fingerprint ?? (async () => 'same'),
  });
  cleanups.push(() => facts.close());
  return { source, clock, facts, clone };
}

const turnStarted: AgentEvent = { type: 'turn_started' };
function turnEnded(toolCalls: number, outcome: 'completed' | 'interrupted' | 'failed' = 'completed'): AgentEvent {
  return { type: 'turn_ended', outcome, toolCalls, error: null, errorKind: outcome === 'failed' ? 'vendor' : null };
}
const MINUTE = 60_000;
function toolStarted(toolId: string, name: string, input: string, command: string | null = null): AgentEvent {
  return { type: 'tool_started', toolId, name, input, command };
}
function toolEnded(toolId: string): AgentEvent {
  return { type: 'tool_ended', toolId, ok: true, denied: false, terminal: null, hubUnreachable: false };
}

describe('FactsTracker', () => {
  test('eventAgeMs and tool.ageMs grow with awake time and leave out a sleep gap', () => {
    const { source, clock, facts } = tracker();
    facts.setPhase('turn');
    facts.observe(turnStarted);
    awake(source, clock, 3_000);
    expect(facts.facts().eventAgeMs).toBe(3_000);
    facts.observe(toolStarted('t1', 'Bash', '{"command":"sleep 100"}', 'sleep 100'));
    awake(source, clock, 2_000);
    sleep(source, clock, 3_600_000);
    awake(source, clock, 4_000);
    const now = facts.facts();
    // 2 s, the one tick before the gap, and 4 s.
    expect(now.eventAgeMs).toBe(7_000);
    expect(now.tool).toMatchObject({ name: 'Bash', command: 'sleep 100', ageMs: 7_000 });
    facts.observe(toolEnded('t1'));
    expect(facts.facts()).toMatchObject({ tool: null, eventAgeMs: 0 });
  });

  test("tool.capMs is core's capForCommand for the command in flight", () => {
    const { facts } = tracker();
    const commands = ['bun run check:all --verbose', 'cargo test', 'ls -la', null];
    commands.forEach((command, index) => {
      facts.observe(toolStarted(`t${index}`, command === null ? 'Edit' : 'Bash', String(index), command));
      const tool = facts.facts().tool;
      expect(tool?.capMs).toBe(capForCommand(CAPS, command));
      expect(tool?.long).toBe(command === 'cargo test');
      facts.observe(toolEnded(`t${index}`));
    });
    expect(capForCommand(CAPS, 'bun run check:all --verbose')).toBe(100 * 60_000);
  });

  test('with calls in parallel, the one nearest to or furthest past its own cap is reported', () => {
    const { source, clock, facts } = tracker();
    facts.setPhase('turn');
    facts.observe(toolStarted('t1', 'Bash', 'cargo test', 'cargo test'));
    awake(source, clock, MINUTE);
    facts.observe(toolStarted('t2', 'Bash', 'curl https://example.com', 'curl https://example.com'));
    awake(source, clock, MINUTE);
    // cargo test: 2 of its 90 minutes; curl: 1 of its 30, the nearer to its cap.
    expect(facts.facts().tool).toMatchObject({ command: 'curl https://example.com', ageMs: MINUTE, capMs: 30 * MINUTE });
    awake(source, clock, 39 * MINUTE);
    const now = facts.facts();
    expect(now.tool).toMatchObject({ command: 'curl https://example.com', ageMs: 40 * MINUTE, capMs: 30 * MINUTE });
    const limits: StallLimits = {
      stallMs: 10 * MINUTE,
      toolCapMs: 30 * MINUTE,
      maxContinuations: 25,
      activeBudgetMs: 4 * 60 * MINUTE,
    };
    expect(judgeStall('worker', now, limits)?.cause).toBe('stall_hung_tool');
    facts.observe(toolEnded('t2'));
    expect(facts.facts().tool).toMatchObject({ command: 'cargo test', ageMs: 41 * MINUTE, capMs: 90 * MINUTE });
  });

  test('what adapters report is kept within the heartbeat schema', () => {
    const { facts } = tracker();
    facts.setPhase('turn');
    facts.observe({ type: 'context', used: 1.04 });
    facts.observe(toolStarted('t1', '', '{}'));
    const heartbeat = (attempts: unknown[]) =>
      parseRunnerMessage(JSON.stringify({ t: 'heartbeat', at: 1, attempts, power: null, disk: null, acceptingUntil: null }));
    const facts1 = facts.facts();
    expect(facts1.contextUsed).toBe(1);
    expect(facts1.tool?.name).toBe('tool');
    expect(heartbeat([facts1]).ok).toBe(true);
    facts.observe({ type: 'context', used: -0.2 });
    expect(facts.facts().contextUsed).toBe(0);
    facts.observe({ type: 'context', used: Number.NaN });
    expect(facts.facts().contextUsed).toBeNull();
    expect(heartbeat([facts.facts()]).ok).toBe(true);
  });

  test('repeatedCalls counts identical consecutive tool calls; a different call resets it', () => {
    const { facts } = tracker();
    expect(facts.facts().repeatedCalls).toBe(0);
    for (const [index, input] of ['{"a":1}', '{"a":1}', '{"a":1}'].entries()) {
      facts.observe(toolStarted(`t${index}`, 'Read', input));
      facts.observe(toolEnded(`t${index}`));
      expect(facts.facts().repeatedCalls).toBe(index + 1);
    }
    facts.observe(toolStarted('t3', 'Read', '{"a":2}'));
    expect(facts.facts().repeatedCalls).toBe(1);
    // The same input under another name is a different call.
    facts.observe(toolStarted('t4', 'Write', '{"a":2}'));
    expect(facts.facts().repeatedCalls).toBe(1);
  });

  test('activeMs counts only starting and turn; vendorErrorMs is the continuous time in vendor_error', () => {
    const { source, clock, facts } = tracker();
    facts.setPhase('starting');
    awake(source, clock, 1_000);
    facts.setPhase('preparing');
    awake(source, clock, 50_000);
    facts.setPhase('starting');
    awake(source, clock, 2_000);
    facts.setPhase('turn');
    awake(source, clock, 3_000);
    sleep(source, clock, 600_000);
    for (const phase of ['idle', 'waiting_approval', 'quota_wait', 'stopping'] as const) {
      facts.setPhase(phase);
      awake(source, clock, 10_000);
    }
    expect(facts.facts().activeMs).toBe(1_000 + 2_000 + 3_000 + 1_000);
    facts.setPhase('vendor_error');
    awake(source, clock, 30_000);
    expect(facts.facts()).toMatchObject({ phase: 'vendor_error', vendorErrorMs: 30_000, activeMs: 7_000 });
    // A retry turn that fails again keeps the errors continuous.
    facts.setPhase('turn');
    awake(source, clock, 1_000);
    facts.observe(turnEnded(0, 'failed'));
    facts.setPhase('vendor_error');
    awake(source, clock, 30_000);
    expect(facts.facts()).toMatchObject({ vendorErrorMs: 61_000, activeMs: 8_000 });
    // A completed turn ends them.
    facts.setPhase('turn');
    facts.observe(turnStarted);
    facts.observe(turnEnded(1));
    facts.setPhase('idle');
    expect(facts.facts().vendorErrorMs).toBe(0);
  });

  test('a period of vendor errors ends once the model answers; a retry turn with output starts a new one', () => {
    const { source, clock, facts } = tracker();
    facts.setPhase('turn');
    facts.observe(turnStarted);
    facts.observe(turnEnded(0, 'failed'));
    facts.setPhase('vendor_error');
    awake(source, clock, 30_000);
    expect(facts.facts().vendorErrorMs).toBe(30_000);
    // The retry turn works for a long while.
    facts.setPhase('turn');
    facts.observe(turnStarted);
    facts.observe(toolStarted('t1', 'Bash', 'ls', 'ls'));
    expect(facts.facts().vendorErrorMs).toBe(0);
    facts.observe(toolEnded('t1'));
    awake(source, clock, 70 * MINUTE);
    expect(facts.facts()).toMatchObject({ phase: 'turn', vendorErrorMs: 0 });
    // And then fails: a new period, from 0.
    facts.observe(turnEnded(1, 'failed'));
    facts.setPhase('vendor_error');
    awake(source, clock, 5_000);
    expect(facts.facts().vendorErrorMs).toBe(5_000);
  });

  test('turns that fail with a vendor error count toward no loop', () => {
    const { facts } = tracker();
    const read = (toolId: string) => {
      facts.observe(toolStarted(toolId, 'Read', '{"file":"src/app.ts"}'));
      facts.observe(toolEnded(toolId));
    };
    facts.observe(turnStarted);
    read('t1');
    facts.observe(turnEnded(1));
    expect(facts.facts().repeatedCalls).toBe(1);
    // Two turns the vendor fails, each after the same call, and the retry that makes it again.
    for (const toolId of ['t2', 't3']) {
      facts.observe(turnStarted);
      read(toolId);
      facts.observe(turnEnded(1, 'failed'));
      expect(facts.facts().repeatedCalls).toBe(1);
    }
    facts.observe(turnStarted);
    read('t4');
    expect(facts.facts().repeatedCalls).toBe(2);
    // An interrupted turn's calls still count.
    facts.observe(turnEnded(1, 'interrupted'));
    facts.observe(turnStarted);
    read('t5');
    expect(facts.facts().repeatedCalls).toBe(3);
  });

  test('reports turns, continuations, context and the fence', () => {
    const { facts } = tracker();
    facts.observe(turnStarted);
    facts.observe({ type: 'context', used: 0.42 });
    facts.observe(turnEnded(0));
    facts.observe(turnStarted);
    facts.continuationSent();
    facts.continuationSent();
    facts.setFence({ epoch: 1, counter: 5 });
    expect(facts.facts()).toMatchObject({
      attemptId: 'T-4-a1',
      fence: { epoch: 1, counter: 5 },
      turns: 2,
      continuations: 2,
      contextUsed: 0.42,
    });
  });

  test('turnsWithoutProgress counts completed turns with no tool call and an unchanged fingerprint', async () => {
    let fingerprint = 'a';
    const { facts } = tracker({ fingerprint: async () => fingerprint });
    await facts.start();
    const turn = async (toolCalls: number, outcome: 'completed' | 'failed' = 'completed') => {
      facts.observe(turnStarted);
      facts.observe(turnEnded(toolCalls, outcome));
      await facts.settled();
      return facts.facts().turnsWithoutProgress;
    };
    expect(await turn(0)).toBe(1);
    expect(await turn(0)).toBe(2);
    // A failed turn neither counts nor resets.
    expect(await turn(0, 'failed')).toBe(2);
    expect(await turn(1)).toBe(0);
    expect(await turn(0)).toBe(1);
    fingerprint = 'b';
    expect(await turn(0)).toBe(0);
    expect(await turn(0)).toBe(1);
  });

  test('new review tools end the no-progress streak before the lead turn completes', async () => {
    const { facts } = tracker();
    await facts.start();
    for (let i = 0; i < 3; i += 1) {
      facts.observe(turnStarted);
      facts.observe(turnEnded(0));
      await facts.settled();
    }
    const limits: StallLimits = {
      stallMs: 10 * MINUTE,
      toolCapMs: 30 * MINUTE,
      maxContinuations: 25,
      activeBudgetMs: 4 * 60 * MINUTE,
    };
    facts.setPhase('idle');
    expect(facts.facts().turnsWithoutProgress).toBe(3);
    expect(judgeStall('lead', facts.facts(), limits)).toBeNull();
    facts.setPhase('turn');
    facts.observe(turnStarted);
    facts.observe(toolStarted('fetch', 'mcp__agflow__fetch_submission', '{"task_id":"T-1"}'));
    expect(facts.facts().turnsWithoutProgress).toBe(0);
    expect(judgeStall('lead', facts.facts(), limits)).toBeNull();
    facts.observe(toolEnded('fetch'));
    // Progress persists between tools, including while the model decides how to review the fetched branch.
    expect(facts.facts().turnsWithoutProgress).toBe(0);
    expect(judgeStall('lead', facts.facts(), limits)).toBeNull();
    facts.observe(toolStarted('review', 'Bash', 'git fetch origin submitted', 'git fetch origin submitted'));
    expect(judgeStall('lead', facts.facts(), limits)).toBeNull();
    facts.observe(toolEnded('review'));
    facts.observe(turnEnded(2));
    expect(facts.facts().turnsWithoutProgress).toBe(0);
    await facts.settled();
    expect(facts.facts().turnsWithoutProgress).toBe(0);
    facts.observe(turnStarted);
    facts.observe(turnEnded(0));
    await facts.settled();
    expect(facts.facts().turnsWithoutProgress).toBe(1);
  });

  test('a vendor-failed tool turn leaves the completed no-progress count unchanged', async () => {
    const { facts } = tracker();
    await facts.start();
    facts.observe(turnStarted);
    facts.observe(turnEnded(0));
    await facts.settled();
    facts.observe(turnStarted);
    facts.observe(toolStarted('fetch', 'mcp__agflow__fetch_submission', '{"task_id":"T-1"}'));
    expect(facts.facts().turnsWithoutProgress).toBe(0);
    facts.observe(turnEnded(1, 'failed'));
    await facts.settled();
    expect(facts.facts().turnsWithoutProgress).toBe(1);
  });

  test('pending fingerprints cannot report an old no-progress streak after a newer tool call', async () => {
    let pending: Promise<string> | undefined;
    const { facts } = tracker({ fingerprint: () => pending ?? Promise.resolve('same') });
    await facts.start();
    let release = () => {};
    pending = new Promise((resolve) => {
      release = () => resolve('same');
    });
    facts.observe(turnStarted);
    facts.observe(turnEnded(0));
    const olderTurn = facts.settled();
    facts.observe(turnStarted);
    facts.observe(toolStarted('fetch', 'mcp__agflow__fetch_submission', '{"task_id":"T-1"}'));
    release();
    await olderTurn;
    expect(facts.facts().turnsWithoutProgress).toBe(0);
    // The next turn may start before the tool turn's fingerprint finishes, too.
    facts.observe(toolEnded('fetch'));
    facts.observe(turnEnded(1));
    facts.observe(turnStarted);
    expect(facts.facts().turnsWithoutProgress).toBe(0);
    await facts.settled();
    expect(facts.facts().turnsWithoutProgress).toBe(0);
    facts.observe(turnEnded(0));
    await facts.settled();
    expect(facts.facts().turnsWithoutProgress).toBe(1);
  });

  test('fsAgeMs follows changes in the clone but not in .agflow/run/; commitAgeMs follows commits', async () => {
    const repo = await originRepo({ 'README.md': '# demo\n' });
    cleanups.push(() => repo.remove());
    const clone = join(tempDir('agflow-facts-clone-'), 'T-4-a1');
    await gitIn(tmpdir(), ['clone', '--quiet', repo.path, clone]);
    const { source, clock, facts } = tracker({ clone });
    await facts.start();
    // Events from before the start may still arrive; only what follows counts.
    await Bun.sleep(300);
    awake(source, clock, 10_000);
    const before = facts.facts();
    mkdirSync(join(clone, '.agflow', 'run'), { recursive: true });
    writeFileSync(join(clone, '.agflow', 'run', 'hook.log'), 'runner\n');
    await Bun.sleep(300);
    expect(facts.facts().fsAgeMs).toBe(before.fsAgeMs);
    expect(before.fsAgeMs === null || before.fsAgeMs >= 10_000).toBe(true);
    writeFileSync(join(clone, 'work.txt'), 'work\n');
    await until(() => facts.facts().fsAgeMs === 0);
    awake(source, clock, 4_000);
    expect(facts.facts().fsAgeMs).toBe(4_000);
    expect(facts.facts().commitAgeMs === null || (facts.facts().commitAgeMs ?? 0) >= 14_000).toBe(true);
    await gitIn(clone, ['add', 'work.txt']);
    await gitIn(clone, ['commit', '-q', '-m', 'work']);
    await until(() => facts.facts().commitAgeMs === 0);
    awake(source, clock, 2_000);
    expect(facts.facts().commitAgeMs).toBe(2_000);
  });

  test('a deleted clone is reported', async () => {
    const clone = join(tempDir('agflow-facts-gone-'), 'T-4-a1');
    mkdirSync(clone);
    const source = new ManualSource();
    let gone = 0;
    const facts = new FactsTracker({
      attemptId: 'T-4-a1',
      fence: FENCE,
      clone,
      toolCaps: CAPS,
      clock: new AwakeClock({ source, gapMs: 5_000 }),
      fingerprint: async () => 'same',
      existenceCheckMs: 50,
      onCloneGone: () => {
        gone += 1;
      },
    });
    cleanups.push(() => facts.close());
    await facts.start();
    expect(facts.cloneGone).toBe(false);
    rmSync(clone, { recursive: true, force: true });
    await until(() => gone > 0);
    await Bun.sleep(150);
    expect(gone).toBe(1);
    expect(facts.cloneGone).toBe(true);
  });
});

describe('diffFingerprint', () => {
  test('changes with HEAD, with tracked and untracked changes, and with another edit of a modified file', async () => {
    const repo = await originRepo({ 'README.md': '# demo\n', 'src/app.ts': 'app\n' });
    cleanups.push(() => repo.remove());
    const paths = runnerPaths(tempDir('agflow-facts-runner-'));
    ensureRunnerGitFiles(paths);
    const home = tempDir('agflow-owner-');
    const vault = new Vault({
      paths,
      project: 'demo-0123456789',
      repo: { url: repo.path, mainBranch: 'main' },
      remote: () => remoteGitEnv({ base: { ...process.env, HOME: home, XDG_CONFIG_HOME: undefined } }),
    });
    await vault.ensure();
    await vault.fetchForAttempt({ taskId: 'T-4', start: { ref: 'refs/heads/main', sha: null } }, 'refs/agflow/');
    const local = localGitEnv(paths);
    const clone = paths.clone('demo-0123456789', 'T-4-a1');
    await createTaskClone({
      vault,
      local,
      attemptId: 'T-4-a1',
      clone,
      branch: 'agflow/T-4-tidy',
      startSha: repo.mainSha,
    });
    const index = join(tempDir('agflow-facts-index-'), 'index');
    const take = () => diffFingerprint({ vault, local, clone, startSha: repo.mainSha, index });
    const clean = await take();
    expect(await take()).toBe(clean);
    mkdirSync(join(clone, '.agflow', 'run'), { recursive: true });
    writeFileSync(join(clone, '.agflow', 'run', 'note.txt'), 'runner-owned\n');
    expect(await take()).toBe(clean);
    writeFileSync(join(clone, 'src', 'app.ts'), 'changed\n');
    const modified = await take();
    expect(modified).not.toBe(clean);
    expect(await take()).toBe(modified);
    // An edit of the same size: only its mtime tells it apart.
    writeFileSync(join(clone, 'src', 'app.ts'), 'chanGed\n');
    touchLater(join(clone, 'src', 'app.ts'));
    const sameSize = await take();
    expect(sameSize).not.toBe(modified);
    writeFileSync(join(clone, 'src', 'app.ts'), 'changed again, longer\n');
    const again = await take();
    expect(again).not.toBe(sameSize);
    writeFileSync(join(clone, 'new.txt'), 'new\n');
    const untracked = await take();
    expect(untracked).not.toBe(again);
    // A commit the vault does not hold yet changes HEAD.
    await gitIn(clone, ['add', '-A']);
    await gitIn(clone, ['commit', '-q', '-m', 'work']);
    const committed = await take();
    expect(committed).not.toBe(untracked);
    expect(await take()).toBe(committed);
    // Another branch at the same commit: HEAD read as a file, not only its sha.
    await gitIn(clone, ['checkout', '-q', '-b', 'agflow/T-4-other']);
    expect(await take()).not.toBe(committed);
  });

  test("never runs git with the clone's own git configuration", async () => {
    const repo = await originRepo({ 'README.md': '# demo\n', '.gitattributes': PLANTED_ATTRIBUTES });
    cleanups.push(() => repo.remove());
    const paths = runnerPaths(tempDir('agflow-facts-runner-'));
    ensureRunnerGitFiles(paths);
    const home = tempDir('agflow-owner-');
    const vault = new Vault({
      paths,
      project: 'demo-0123456789',
      repo: { url: repo.path, mainBranch: 'main' },
      remote: () => remoteGitEnv({ base: { ...process.env, HOME: home, XDG_CONFIG_HOME: undefined } }),
    });
    await vault.ensure();
    await vault.fetchForAttempt({ taskId: 'T-4', start: { ref: 'refs/heads/main', sha: null } }, 'refs/agflow/');
    const local = localGitEnv(paths);
    const clone = paths.clone('demo-0123456789', 'T-4-a1');
    await createTaskClone({ vault, local, attemptId: 'T-4-a1', clone, branch: 'agflow/T-4-tidy', startSha: repo.mainSha });
    const planted = plantCloneConfig(clone, tempDir('agflow-planted-'));
    const index = join(tempDir('agflow-facts-index-'), 'index');
    const take = () => diffFingerprint({ vault, local, clone, startSha: repo.mainSha, index });
    touchLater(join(clone, 'README.md'));
    const before = await take();
    writeFileSync(join(clone, 'README.md'), '# demo, edited\n');
    expect(await take()).not.toBe(before);
    expect(planted.fired()).toBe(false);
    await planted.proveLive('README.md');
  });
});
