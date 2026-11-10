// The runner against M2a's hub (design 1 exit criterion 1, 6.3, 6.4, 6.13, 15): one in-process hub, one runner with
// the fake adapter and a local bare origin, over the real link. The hub places the work, the fake agent commits and
// submits with its own agent token, and the runner pushes, holds, cleans up, recovers a killed agent's work and
// replays its outbox after a restart, all through the protocol both sides implement.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { HubStatus } from '@agflow/core';
import { attemptLog, getAttempt } from '@agflow/hub/src/attempt-store';
import { HUB_RUNNER_DEFAULTS } from '@agflow/hub/src/context';
import { getRunner } from '@agflow/hub/src/runners';
import { getTask, listTaskNotes } from '@agflow/hub/src/task-store';
import { acceptTask, createTasks } from '@agflow/hub/src/tasks';
import { addRunner, newTask } from '@agflow/hub/test/helpers';
import { FakeAdapter, type FakeScript, gitIn, type OriginRepo, originRepo } from '@agflow/testkit';
import { AttemptStore } from '../src/attempt-store';
import { loadRunnerConfig, RunnerConfigSchema, saveRunnerConfig } from '../src/config';
import { openRunnerDb, type RunnerDb } from '../src/db';
import type { CredentialsProvider, WelcomeMessage } from '../src/link';
import { memoryLogger } from '../src/log';
import { Outbox } from '../src/outbox';
import { projectKey, type RunnerPaths, runnerPaths } from '../src/paths';
import { killGroup, processIdentity } from '../src/processes';
import { removeAgentTools } from '../src/run-dir';
import { createRunner, type RunnerEvents, type RunnerHandle } from '../src/runner';
import { FIXTURE_AGFLOW, fixtureCliVersion, waitFor } from './fixture';
import { startTestHub, type TestHub } from './hub-fixture';
import { afterThisTest, cleanupRunnerSetups, tempDir } from './runner-setup';

afterEach(cleanupRunnerSetups);

// Each test runs a hub, a runner, git and agent processes, which take several times as long on a loaded machine.
setDefaultTimeout(60_000);

const PROJECT = 'demo';

/** The agent's scripts, by attempt id or task id; a launch of any other attempt does nothing. */
type Scripts = Record<string, FakeScript>;

interface Setup {
  hub: TestHub;
  origin: OriginRepo;
  paths: RunnerPaths;
  /** The vault's project key: the hub's URL and the project's name. */
  project: string;
  /** Starts a runner on the home; closed after the test. A second start is a restart. */
  start(options?: StartOptions): Promise<RunnerHandle>;
  /** The runner.db of the last start. */
  db(): RunnerDb;
}

interface StartOptions {
  /** The hub's credentials by default. */
  credentials?: CredentialsProvider;
  events?: RunnerEvents;
}

/** A hub serving a local bare origin, and a runner home whose fake agents play the scripts. */
async function setup(scripts: Scripts): Promise<Setup> {
  const origin = await originRepo({ 'README.md': '# demo\n', 'src/app.ts': 'app\n' });
  afterThisTest(() => origin.remove());
  const hub = startTestHub({ config: { projectName: PROJECT, projectRepo: origin.path } });
  afterThisTest(() => hub.stop());
  const paths = runnerPaths(tempDir('agflow-runner-home-'));
  // The attempts' tools directories are read-only: they must be made writable before the home can go.
  afterThisTest(() => {
    if (!existsSync(paths.vaults)) return;
    for (const entry of readdirSync(paths.vaults).filter((name) => name.endsWith('.agent'))) {
      for (const attempt of readdirSync(join(paths.vaults, entry))) removeAgentTools(join(paths.vaults, entry, attempt));
    }
  });
  mkdirSync(dirname(paths.db), { recursive: true });
  // Short, as Claude's private temporary directories must be.
  const tmpRoot = mkdtempSync('/tmp/ag');
  afterThisTest(() => rmSync(tmpRoot, { recursive: true, force: true }));
  const config = RunnerConfigSchema.parse({
    runnerKey: 'rk_integration',
    machineId: 'MACHINE-1',
    name: 'laptop',
    test: { skipAuthChecks: true, allowShortTimings: true },
  });
  // A resumed session does nothing more: its script played in the session it resumes.
  const script = (launch: { attemptId: string; resume: unknown }): FakeScript =>
    (launch.resume === null &&
      (scripts[launch.attemptId] ?? scripts[launch.attemptId.replace(/-a\d+$/, '')])) || { turns: [[]] };
  let lastDb: RunnerDb | null = null;
  const start = async (options: StartOptions = {}) => {
    // A restart reads the runner.json the previous run left, its local edits and confirmed snapshot included.
    const restart = lastDb !== null;
    if (!restart) saveRunnerConfig(paths.config, config);
    const db = openRunnerDb(paths.db);
    lastDb = db;
    const runner = await createRunner({
      paths,
      config: restart ? loadRunnerConfig(paths.config) : config,
      db,
      credentials: options.credentials ?? (() => ({ ...hub.credentials })),
      events: options.events,
      adapters: (['claude', 'codex'] as const).map((vendor) => new FakeAdapter({ vendor, skipAuthChecks: true, script })),
      agflow: FIXTURE_AGFLOW,
      // The darwin-arm64 pins, so the fake agents start where no CLI is pinned (CI's linux-x64).
      cliVersion: fixtureCliVersion,
      logger: memoryLogger(),
      tmpRoot,
    });
    afterThisTest(async () => {
      // Whatever agent the test left running goes before the files do.
      for (const group of new AttemptStore(db).processes()) await killGroup(group, 'SIGKILL');
      await runner.close();
      db.close();
    });
    return runner;
  };
  const db = () => {
    if (lastDb === null) throw new Error('no runner started yet');
    return lastDb;
  };
  return { hub, origin, paths, project: projectKey(hub.url, PROJECT), start, db };
}

/** Starts the runner and waits until the hub has it online. */
async function online(s: Setup): Promise<RunnerHandle> {
  const runner = await s.start();
  await waitFor(() => runner.status().link === 'online');
  return runner;
}

/** Creates a ready task by alice; returns its id. */
function readyTask(hub: TestHub, title: string): string {
  const [task] = createTasks(hub.ctx, [newTask({ title })], 'user:alice');
  if (!task) throw new Error('no task created');
  return task.id;
}

/**
 * The fake agent's submit, as the bridge sends it: POST /api/tasks/:id/submit with its own agent token from the agent
 * environment. curl -f fails the tool on any answer but a success.
 */
function submitStep(taskId: string): FakeScript['turns'][number][number] {
  const body = JSON.stringify({ summary: 'Tidied the app', evidence: ['src/app.ts reads well'] });
  const command =
    `curl -sf -X POST "$AGFLOW_HUB_URL/api/tasks/${taskId}/submit" -H "authorization: Bearer $AGFLOW_AGENT_TOKEN" ` +
    `-H 'content-type: application/json' --data '${body}'`;
  return { do: 'tool', command };
}

/** The hub's acknowledged position in the runner's outbox. */
function hubAckedSeq(hub: TestHub, runnerId: string, outboxEpoch: string): number {
  const row = hub.ctx.db
    .query('SELECT acked_seq FROM runner_inbox WHERE runner_id = $runnerId AND outbox_epoch = $outboxEpoch')
    .get({ runnerId, outboxEpoch }) as { acked_seq: number } | null;
  return row?.acked_seq ?? 0;
}

/** How many hub events of the type the hub recorded. */
function hubEvents(hub: TestHub, type: string): number {
  const row = hub.ctx.db.query('SELECT COUNT(*) AS count FROM events WHERE type = $type').get({ type }) as {
    count: number;
  };
  return row.count;
}

/** How many entries of the attempt's hub log begin with the text. */
function logged(hub: TestHub, attemptId: string, text: string): number {
  return attemptLog(hub.ctx, attemptId).filter((entry) => entry.summary.startsWith(text)).length;
}

/** The commit a ref names on the origin; null when it does not exist. */
async function originSha(origin: OriginRepo, ref: string): Promise<string | null> {
  const sha = await gitIn(origin.path, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFailure: true });
  return sha === '' ? null : sha;
}

describe('startTestHub', () => {
  test('a hub events transaction failure closes with 1011 and the runner replays from the acknowledged position', async () => {
    const s = await setup({});
    const welcomes: WelcomeMessage[] = [];
    const closes: number[] = [];
    const runner = await s.start({
      events: {
        welcome: (welcome) => welcomes.push(welcome),
        link: (_state, detail) => {
          if (detail.code !== null) closes.push(detail.code);
        },
      },
    });
    await waitFor(() => runner.status().link === 'online');
    const runnerId = runner.status().runnerId as string;
    const box = new Outbox(s.db());
    const first = (await runner.changeSettings({ capacity: 3 })) as number;
    expect(await runner.waitAcked(first, 5_000)).toBe(true);
    await waitFor(() => loadRunnerConfig(s.paths.config).confirmedSettings.version === getRunner(s.hub.ctx, runnerId).settingsVersion);
    const version = getRunner(s.hub.ctx, runnerId).settingsVersion;
    const acked = box.ackedSeq();
    s.hub.ctx.db.run(`CREATE TRIGGER fail_events BEFORE UPDATE ON runner_inbox WHEN NEW.acked_seq > ${acked}
      BEGIN SELECT RAISE(ABORT, 'scripted full disk'); END`);
    const failed = (await runner.changeSettings({ draining: true })) as number;
    await waitFor(() => closes.includes(1011));
    expect(box.ackedSeq()).toBe(acked);
    expect(getRunner(s.hub.ctx, runnerId)).toMatchObject({ draining: false, settingsVersion: version });
    s.hub.ctx.db.run('DROP TRIGGER fail_events');
    expect(await runner.waitAcked(failed, 10_000)).toBe(true);
    await waitFor(() => getRunner(s.hub.ctx, runnerId).draining);
    expect(welcomes.slice(1).some((welcome) => welcome.ackedSeq === acked)).toBe(true);
    expect(getRunner(s.hub.ctx, runnerId).settingsVersion).toBe(version + 1);
    expect(runner.status().link).toBe('online');
  });

  test('serves the runner gateway and the API on one port, ticks only when the test runs the scheduler, and stops cleanly without a pid file', async () => {
    const origin = await originRepo({ 'README.md': '# demo\n' });
    afterThisTest(() => origin.remove());
    const hub = startTestHub({ config: { projectName: PROJECT, projectRepo: origin.path } });
    afterThisTest(() => hub.stop());
    expect(hub.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(hub.ctx.config.publicUrl).toBe(hub.url);
    expect(hub.credentials).toEqual({ hubUrl: hub.url, token: hub.token, user: 'alice' });
    // The API, with the owner's CLI session.
    const status = await fetch(`${hub.url}/api/status`, { headers: { authorization: `Bearer ${hub.token}` } });
    expect(status.status).toBe(200);
    const { project } = (await status.json()) as HubStatus;
    expect(project).toMatchObject({ name: PROJECT, repo: origin.path, runnerLeads: false });
    // The runner link on the same port: a WebSocket upgrade with the same session.
    const socket = new WebSocket(`${hub.url.replace('http', 'ws')}/api/runner/ws`, {
      headers: { authorization: `Bearer ${hub.token}` },
    });
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve());
      socket.addEventListener('error', () => reject(new Error('the runner link did not open')));
    });
    socket.close();
    // The scheduler is created stopped: with a runner online, a ready task still waits past the debounce of a started
    // scheduler's tick on task.created, until the test ticks.
    expect(hub.scheduler.running).toBe(false);
    const runnerId = addRunner(hub.ctx);
    const taskId = readyTask(hub, 'Run it when asked');
    await Bun.sleep(1_500);
    expect(getTask(hub.ctx, taskId).status).toBe('ready');
    // A fake clock moved by more than three ticks opens no recovery window: the tick marks the hub alive first.
    hub.clock.advance(10 * hub.ctx.config.tickMs);
    expect(hub.tick()).toMatchObject({ recovering: false, started: [expect.objectContaining({ taskId, runnerId })] });
    // The database is in memory, which cannot take a lock (startHub would throw with dbLock): no pid file can appear.
    expect(hub.ctx.db.filename).toBe(':memory:');
    await hub.stop();
    expect(() => hub.ctx.db.query('SELECT 1').get()).toThrow();
    await expect(fetch(`${hub.url}/api/status`)).rejects.toThrow();
    await hub.stop();
  });

  test('stopGraceMs and wipGraceMs follow handoffMs and runnerLeaseMs unless set, and the owner is always allowed', async () => {
    const derived = startTestHub({ config: { runnerLeaseMs: 30_000, handoffMs: 2_000 } });
    afterThisTest(() => derived.stop());
    expect(derived.ctx.config).toMatchObject({ wipGraceMs: 10_000, stopGraceMs: 302_000 });
    const defaults = startTestHub();
    afterThisTest(() => defaults.stop());
    expect(defaults.ctx.config).toMatchObject({
      handoffMs: 5_000,
      stopGraceMs: 305_000,
      wipGraceMs: Math.floor(HUB_RUNNER_DEFAULTS.runnerLeaseMs / 3),
    });
    const given = startTestHub({
      owner: 'carol',
      config: { runnerLeaseMs: 30_000, handoffMs: 2_000, wipGraceMs: 7_000, stopGraceMs: 9_000, allowedUsers: ['bob'] },
    });
    afterThisTest(() => given.stop());
    expect(given.ctx.config).toMatchObject({ wipGraceMs: 7_000, stopGraceMs: 9_000, allowedUsers: ['bob', 'carol'] });
    expect(given.credentials.user).toBe('carol');
  });
});

describe('the runner against the hub', () => {
  test("the runner registers through hello; a scheduler tick places a ready task on it; the fake agent commits and leaves uncommitted work; a WIP push updates the task's work position on the hub", async () => {
    const s = await setup({
      'T-1': {
        turns: [
          [
            { do: 'write', path: 'src/app.ts', content: 'app, tidied\n' },
            { do: 'commit', message: 'Tidy the app' },
            { do: 'write', path: 'notes.txt', content: 'not committed yet\n' },
          ],
        ],
      },
    });
    const runner = await online(s);
    const runnerId = runner.status().runnerId as string;
    expect(runnerId).toMatch(/^R-\d+$/);
    const taskId = readyTask(s.hub, 'Tidy the app');
    const [started] = s.hub.tick().started;
    expect(started).toMatchObject({ taskId, runnerId, vendor: 'claude' });
    const attemptId = started?.id as string;
    await waitFor(() => getAttempt(s.hub.ctx, attemptId).status === 'running');
    await waitFor(() => runner.status().attempts.find((a) => a.attemptId === attemptId)?.phase === 'idle');
    const wipRef = getAttempt(s.hub.ctx, attemptId).wipRef as string;
    const [pushed] = await runner.pushWipNow();
    expect(pushed).toEqual({ attemptId, outcome: { status: 'pushed', ref: wipRef, sha: expect.any(String) } });
    const wipSha = await originSha(s.origin, wipRef);
    expect(wipSha).toBe(pushed?.outcome.status === 'pushed' ? pushed.outcome.sha : null);
    await waitFor(() => getTask(s.hub.ctx, taskId).workSha === wipSha);
    expect(getTask(s.hub.ctx, taskId)).toMatchObject({ status: 'claimed', workRef: wipRef, workSha: wipSha });
    // The WIP holds the commit and the uncommitted file.
    expect(await gitIn(s.origin.path, ['show', `${wipSha}:src/app.ts`])).toBe('app, tidied');
    expect(await gitIn(s.origin.path, ['show', `${wipSha}:notes.txt`])).toBe('not committed yet');
  });

  test('the fake agent submits with its agent token; the runner pushes the task branch; the hub records the submission and holds the attempt, and the runner stops the process; accepting the task cleans the clone up', async () => {
    const s = await setup({
      'T-1': {
        turns: [
          [
            { do: 'write', path: 'src/app.ts', content: 'app, tidied\n' },
            { do: 'commit', message: 'Tidy the app' },
            submitStep('T-1'),
            { do: 'terminal', tool: 'submit' },
          ],
        ],
      },
    });
    const runner = await online(s);
    const taskId = readyTask(s.hub, 'Tidy the app');
    const attemptId = s.hub.tick().started[0]?.id as string;
    const clone = s.paths.clone(s.project, attemptId);
    // The submission lands: the task is submitted at the pushed head, and the attempt holds.
    const submitted = await waitFor(() => {
      const task = getTask(s.hub.ctx, taskId);
      return task.status === 'submitted' && task;
    });
    const head = submitted.submission?.headSha as string;
    expect(submitted.submission).toMatchObject({ summary: 'Tidied the app', evidence: ['src/app.ts reads well'] });
    expect(await originSha(s.origin, `refs/heads/${submitted.branch}`)).toBe(head);
    expect(await gitIn(s.origin.path, ['show', `${head}:src/app.ts`])).toBe('app, tidied');
    expect(submitted).toMatchObject({ workRef: `refs/heads/${submitted.branch}`, workSha: head });
    expect(getAttempt(s.hub.ctx, attemptId)).toMatchObject({ status: 'holding', submittedSha: head });
    // The hold stops the agent; the clone stays for review.
    await waitFor(() => {
      const attempt = runner.status().attempts.find((entry) => entry.attemptId === attemptId);
      return attempt?.phase === null && attempt.process === null;
    });
    expect(existsSync(clone)).toBe(true);
    // Accepting ends the attempt, and its cleanup removes the clone.
    acceptTask(s.hub.ctx, taskId, 'user:alice');
    expect(getAttempt(s.hub.ctx, attemptId).status).toBe('ended');
    await waitFor(() => !existsSync(clone));
    await waitFor(() => runner.status().attempts.every((entry) => entry.attemptId !== attemptId));
  });

  test("a second task's agent group is SIGKILLed mid-turn: the hub ends the attempt crashed with the final WIP as the work position, and the successor's clone starts at that commit with the uncommitted file present", async () => {
    const s = await setup({
      'T-1': { turns: [[{ do: 'sleep', ms: 60_000 }]] },
      'T-2-a1': {
        turns: [
          [
            { do: 'write', path: 'src/app.ts', content: 'app, half done\n' },
            { do: 'commit', message: 'Start on the app' },
            { do: 'write', path: 'notes.txt', content: 'not committed yet\n' },
            { do: 'sleep', ms: 60_000 },
          ],
        ],
      },
    });
    const runner = await online(s);
    const first = readyTask(s.hub, 'Something else');
    const second = readyTask(s.hub, 'Finish the app');
    const started = s.hub.tick().started;
    expect(started.map((attempt) => attempt.taskId)).toEqual([first, second]);
    const attemptId = started[1]?.id as string;
    const clone = s.paths.clone(s.project, attemptId);
    await waitFor(() => existsSync(join(clone, 'notes.txt')));
    const agent = await waitFor(() => runner.status().attempts.find((entry) => entry.attemptId === attemptId)?.process);
    process.kill(-agent.pgid, 'SIGKILL');
    // The runner's final push carries the commit and the uncommitted file; the hub ends the attempt crashed there.
    const ended = await waitFor(() => {
      const attempt = getAttempt(s.hub.ctx, attemptId);
      return attempt.status === 'ended' && attempt;
    });
    expect(ended.endReason).toBe('crashed');
    // The agent wrote no handoff note: the hub assembled one, quoting the final push's commits (design 6.8).
    const notes = listTaskNotes(s.hub.ctx, second).filter((note) => note.kind === 'handoff');
    expect(notes).toEqual([expect.objectContaining({ author: 'system', attemptId })]);
    expect(notes[0]?.body).toStartWith('# Handoff note assembled by agflow');
    expect(notes[0]?.body).toContain('Start on the app');
    const wipRef = ended.wipRef as string;
    const wipSha = (await originSha(s.origin, wipRef)) as string;
    expect(await gitIn(s.origin.path, ['show', `${wipSha}:notes.txt`])).toBe('not committed yet');
    expect(getTask(s.hub.ctx, second)).toMatchObject({ status: 'ready', workRef: wipRef, workSha: wipSha });
    // The first task's agent never noticed.
    expect(getAttempt(s.hub.ctx, started[0]?.id as string).status).toBe('running');
    // A crash is an infra ending: the task waits out the first infra backoff, then the successor starts from that work
    // position.
    const backoff = (getTask(s.hub.ctx, second).nextDispatchAt as number) - s.hub.ctx.now();
    expect(backoff).toBe(s.hub.ctx.config.infraBackoffMs[0] as number);
    expect(s.hub.tick().started).toEqual([]);
    s.hub.clock.advance(backoff);
    const [successor] = s.hub.tick().started;
    expect(successor).toMatchObject({ taskId: second, startRef: wipRef, startSha: wipSha });
    const successorClone = s.paths.clone(s.project, successor?.id as string);
    await waitFor(() => getAttempt(s.hub.ctx, successor?.id as string).status === 'running');
    expect(getAttempt(s.hub.ctx, successor?.id as string).startSha).toBe(wipSha);
    expect(await gitIn(successorClone, ['rev-parse', 'HEAD'])).toBe(wipSha);
    expect(readFileSync(join(successorClone, 'notes.txt'), 'utf8')).toBe('not committed yet\n');
    expect(readFileSync(join(successorClone, 'src/app.ts'), 'utf8')).toBe('app, half done\n');
    // And with the handoff note: the successor's brief quotes it.
    expect(new AttemptStore(s.db()).get(successor?.id as string)?.spec.brief).toContain('No handoff note was written');
  });

  test("restarting the runner reconnects, replays retained events after the hub's acked position, and the hub applies none twice", async () => {
    const s = await setup({
      'T-1': {
        turns: [
          [
            { do: 'write', path: 'src/app.ts', content: 'app, tidied\n' },
            { do: 'commit', message: 'Tidy the app' },
          ],
        ],
      },
    });
    let signedIn = true;
    const first = await s.start({ credentials: () => (signedIn ? { ...s.hub.credentials } : null) });
    await waitFor(() => first.status().link === 'online');
    const runnerId = first.status().runnerId as string;
    const outbox = new Outbox(s.db());
    const taskId = readyTask(s.hub, 'Tidy the app');
    const attemptId = s.hub.tick().started[0]?.id as string;
    const clone = s.paths.clone(s.project, attemptId);
    await waitFor(() => first.status().attempts.find((entry) => entry.attemptId === attemptId)?.phase === 'idle');
    const [pushed] = await first.pushWipNow();
    const wipSha = pushed?.outcome.status === 'pushed' ? pushed.outcome.sha : null;
    await waitFor(() => getTask(s.hub.ctx, taskId).workSha === wipSha);
    await waitFor(() => hubAckedSeq(s.hub, runnerId, outbox.epoch) === outbox.lastSeq());
    const acked = outbox.lastSeq();
    const version = getRunner(s.hub.ctx, runnerId).settingsVersion;
    // The script's turn made two tool calls; the resumed session's own turn (no tool calls) may land at any time.
    const turns = () => logged(s.hub, attemptId, 'turn completed with 2');
    const applied = { wip: hubEvents(s.hub, 'attempt.wip'), turns: turns() };
    expect(applied).toEqual({ wip: 1, turns: 1 });
    // The link drops and cannot come back (the CLI is signed out); what the runner does meanwhile waits in its outbox.
    signedIn = false;
    s.hub.ctx.link.closeRunner(runnerId, 1012, 'the hub drops the link');
    await waitFor(() => first.status().link === 'needs_login');
    writeFileSync(join(clone, 'later.txt'), 'written while the hub was away\n');
    const [during] = await first.pushWipNow();
    expect(during?.outcome.status).toBe('pushed');
    expect(await first.changeSettings({ capacity: 1 })).toBe(outbox.lastSeq());
    // The service's restart: SIGTERM suspends the agents (design 6.4), and the process goes.
    const agent = first.status().attempts.find((entry) => entry.attemptId === attemptId)?.process;
    expect(await first.stopAgents('suspend', { handoff: false })).toEqual([outbox.lastSeq()]);
    await first.close();
    expect(await processIdentity(agent?.pid as number)).toBeNull();
    const unsent = outbox.eventsAfter(acked).map((event) => event.type);
    expect(unsent).toEqual(['attempt.wip', 'runner.settings', 'attempt.exited']);
    expect(hubAckedSeq(s.hub, runnerId, outbox.epoch)).toBe(acked);
    // The restarted runner says hello from the same outbox, which still holds the acknowledged events: the hub names
    // its acked position, and only what follows it is replayed.
    const welcomes: WelcomeMessage[] = [];
    const second = await s.start({ events: { welcome: (welcome) => welcomes.push(welcome) } });
    await waitFor(() => second.status().link === 'online');
    expect(welcomes[0]).toMatchObject({ runnerId, ackedSeq: acked });
    expect(new Outbox(s.db()).firstSeq()).toBeLessThan(acked);
    await waitFor(() => hubAckedSeq(s.hub, runnerId, outbox.epoch) === new Outbox(s.db()).lastSeq());
    // The local edit, kept in runner.json and replayed, made one new settings version.
    expect(getRunner(s.hub.ctx, runnerId)).toMatchObject({ capacity: 1, settingsVersion: version + 1 });
    // The hello reported the attempt suspended, and the hub resumed it at a new fence (design 6.3): the WIP and the
    // suspend's exit, replayed at the old fence, are each refused once as stale.
    expect(getAttempt(s.hub.ctx, attemptId).fence).toEqual({ epoch: 1, counter: 2 });
    expect(logged(s.hub, attemptId, 'attempt.wip at fence e1.1 ignored')).toBe(1);
    expect(logged(s.hub, attemptId, 'attempt.exited at fence e1.1 ignored')).toBe(1);
    // Nothing applied before the restart was applied again.
    expect({ wip: hubEvents(s.hub, 'attempt.wip'), turns: turns() }).toEqual(applied);
  });
});
