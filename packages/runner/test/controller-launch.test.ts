import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { FakeAdapter, type FakeScript } from '@agflow/testkit';
import { BRIDGE_TOOL_NAMES } from '../src/adapters/bridge-tools';
import type { AgentEvent, AgentSession, VendorAdapter } from '../src/adapters/types';
import { bridgeEnvOf } from '../src/env';
import { type ProcessIdentity, processIdentity } from '../src/processes';
import { VENDOR_PINS } from '../src/vendor/pins';
import {
  cleanupRunnerFixtures,
  createRunnerFixture,
  FIXTURE_AGFLOW,
  FIXTURE_PROJECT,
  fixtureAgentToken,
  waitFor,
} from './fixture';

afterEach(cleanupRunnerFixtures);

// Every test here runs git or agent processes, which take several times as long on a machine loaded by other suites.
setDefaultTimeout(30_000);

/** The fixture's attempts start with darwin-arm64's pin, on every platform. */
const CLAUDE_PIN = VENDOR_PINS['darwin-arm64']?.claude.version as string;

/** The bridge variables design 7.6 lists, which the bridge's own environment must hold. */
const BRIDGE_VARIABLES = [
  'AGFLOW_AGENT_TOKEN',
  'AGFLOW_HUB_URL',
  'AGFLOW_ATTEMPT_ID',
  'AGFLOW_ROLE',
  'AGFLOW_CLONE',
  'AGFLOW_BRIDGE_POLL_MS',
  'AGFLOW_BRIDGE_POLL_MAX_MS',
  'AGFLOW_CONFIG_DIR',
  'NODE_USE_SYSTEM_CA',
];

/** An adapter that hands every call to the fake, with hooks around start and the first event read. */
function wrappedAdapter(
  fake: FakeAdapter,
  hooks: { start?: () => void; firstRead?: (session: AgentSession) => void },
): VendorAdapter {
  return {
    vendor: fake.vendor,
    preflight: () => fake.preflight(),
    readTranscriptTail: (input) => fake.readTranscriptTail(input),
    deleteTranscript: (input) => fake.deleteTranscript(input),
    async start(launch) {
      hooks.start?.();
      const session = await fake.start(launch);
      let read = false;
      const events: AsyncIterable<AgentEvent> = {
        [Symbol.asyncIterator]: () => {
          const inner = session.events[Symbol.asyncIterator]();
          return {
            next: () => {
              if (!read) {
                read = true;
                hooks.firstRead?.(session);
              }
              return inner.next();
            },
          };
        },
      };
      return Object.assign(Object.create(session) as AgentSession, { events });
    },
  };
}

describe('AttemptController: launching the agent', () => {
  test('starts the agent in the clone with the agent environment, the bridge and the brief', async () => {
    const script: FakeScript = { turns: [[{ do: 'tool', command: 'pwd -P > where.txt' }]] };
    const f = await createRunnerFixture({ script });
    expect(await f.controller().start(f.spec())).toEqual({ started: true });
    const clone = realpathSync(f.paths.clone(FIXTURE_PROJECT, 'T-4-a1'));
    const launch = f.fakes.claude?.launches[0];
    expect(launch).toBeDefined();
    if (!launch) return;
    expect(launch.clone).toBe(clone);
    expect(launch.env.AGFLOW_AGENT_TOKEN).toBe(fixtureAgentToken('T-4-a1'));
    expect(launch.env.AGFLOW_CLONE).toBe(clone);
    expect(launch.env.CLAUDE_CODE_TMPDIR).toBe(launch.tmpDir);
    expect(launch.bridge.command).toBe(FIXTURE_AGFLOW.command);
    expect(launch.bridge.args).toEqual([...FIXTURE_AGFLOW.args, 'mcp', '--vendor', 'claude', '--runner']);
    expect(launch.bridge.env).toEqual(bridgeEnvOf(launch.env));
    expect(launch.bridge.tools).toEqual(BRIDGE_TOOL_NAMES.worker);
    for (const name of BRIDGE_VARIABLES) {
      expect(launch.bridge.env[name]).toEqual(expect.any(String));
      expect(launch.bridge.env[name]).toBe(launch.env[name] as string);
    }
    expect(launch.brief.endsWith(`Your working directory: ${clone}`)).toBe(true);
    expect(launch.brief.startsWith('You are an agflow worker on T-4.')).toBe(true);
    expect(launch.firstPrompt).toBe('Start working on T-4.');
    expect(launch.resume).toBeNull();
    expect(launch.logFile).toBe(f.paths.attemptLog('T-4-a1'));
    const where = join(clone, 'where.txt');
    await waitFor(() => existsSync(where) && readFileSync(where, 'utf8') !== '');
    expect(readFileSync(where, 'utf8').trim()).toBe(clone);
  });

  test("the temporary directory is the attempt's /tmp/agf/<id> for Claude and .agflow/run/tmp for Codex", async () => {
    const f = await createRunnerFixture();
    await f.controller('T-4-a1').start(f.spec());
    await f.controller('T-5-a1').start(f.spec({ attemptId: 'T-5-a1', taskId: 'T-5', vendor: 'codex' }));
    const claude = f.fakes.claude?.launches[0];
    const codex = f.fakes.codex?.launches[0];
    expect(claude?.tmpDir.startsWith(`${f.tmpRoot}/agf/`)).toBe(true);
    expect(f.store.get('T-4-a1')?.tmpDir).toBe(claude?.tmpDir as string);
    expect(codex?.tmpDir).toBe(join(codex?.clone as string, '.agflow', 'run', 'tmp'));
    expect(codex?.env.CODEX_HOME).toBeDefined();
    expect(codex?.bridge.args).toEqual([...FIXTURE_AGFLOW.args, 'mcp', '--vendor', 'codex', '--runner']);
  });

  test('attempt.spawned carries the session, the pid, the model, the pinned CLI version and the start tip', async () => {
    const f = await createRunnerFixture({ script: { turns: [[]], permissionMode: 'plan' } });
    const controller = f.controller();
    await controller.start(f.spec());
    const [spawned] = await waitFor(() => f.events('attempt.spawned').length > 0 && f.events('attempt.spawned'));
    const launch = f.fakes.claude?.launches[0];
    const session = controller.session;
    expect(session).not.toBeNull();
    expect(spawned?.fence).toEqual({ epoch: 1, counter: 1 });
    expect(spawned?.data).toEqual({
      sessionRef: session?.sessionRef as string,
      pid: session?.pid as number,
      model: f.config.models.claude.worker,
      cliVersion: CLAUDE_PIN,
      permissionMode: 'plan',
      startSha: f.origin.mainSha,
    });
    expect(f.store.processes('T-4-a1').map((record) => record.pid)).toContain(session?.pid as number);
    expect(launch?.cliVersion).toBe(CLAUDE_PIN);
    expect(f.store.get('T-4-a1')).toMatchObject({
      state: 'running',
      sessionRef: session?.sessionRef as string,
      cliVersion: CLAUDE_PIN,
    });
  });

  test("a null model is runner.json's models[vendor][role]; a model the hub names is used as it is", async () => {
    const f = await createRunnerFixture();
    f.config.models = {
      claude: { lead: 'claude-lead-model', worker: 'claude-worker-model' },
      codex: { lead: 'codex-lead-model', worker: 'codex-worker-model' },
    };
    await f.controller('lead-a1').start(
      f.spec({ attemptId: 'lead-a1', taskId: null, role: 'lead', branch: null, wipRef: null }),
    );
    await f.controller('T-5-a1').start(f.spec({ attemptId: 'T-5-a1', taskId: 'T-5', vendor: 'codex' }));
    await f.controller('T-6-a1').start(
      f.spec({ attemptId: 'T-6-a1', taskId: 'T-6', vendor: 'codex', model: 'gpt-test-model' }),
    );
    const spawned = await waitFor(() => f.events('attempt.spawned').length === 3 && f.events('attempt.spawned'));
    const modelOf = (attemptId: string) => spawned.find((event) => event.attemptId === attemptId)?.data.model;
    expect(modelOf('lead-a1')).toBe('claude-lead-model');
    expect(modelOf('T-5-a1')).toBe('codex-worker-model');
    expect(modelOf('T-6-a1')).toBe('gpt-test-model');
    // The bridge serves the tools of the role AGFLOW_ROLE names, and the launch names them.
    expect(f.fakes.claude?.launches[0]?.bridge.env.AGFLOW_ROLE).toBe('lead');
    expect(f.fakes.claude?.launches[0]?.bridge.tools).toEqual(BRIDGE_TOOL_NAMES.lead);
    expect(f.fakes.codex?.launches.map((launch) => launch.bridge.tools)).toEqual([
      BRIDGE_TOOL_NAMES.worker,
      BRIDGE_TOOL_NAMES.worker,
    ]);
    expect(f.fakes.codex?.launches.map((launch) => launch.cliVersion)).toEqual([
      VENDOR_PINS['darwin-arm64']?.codex.version as string,
      VENDOR_PINS['darwin-arm64']?.codex.version as string,
    ]);
  });

  test("the agent's process is in the registry before its first event is read", async () => {
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await createRunnerFixture();
    const fake = f.fakes.claude as FakeAdapter;
    let atFirstRead: { pid: number; recorded: ReturnType<typeof f.store.processes> } | null = null;
    f.adapters.set(
      'claude',
      wrappedAdapter(fake, {
        firstRead: (session) => {
          atFirstRead = { pid: session.pid, recorded: f.store.processes('T-4-a1') };
        },
      }),
    );
    // The identity lookup answers only once released, well after the first read could have run.
    const identify = async (pid: number): Promise<ProcessIdentity | null> => {
      await released;
      return processIdentity(pid);
    };
    const controller = f.controller('T-4-a1', { identify });
    await controller.start(f.spec());
    await Bun.sleep(300);
    expect(atFirstRead).toBeNull();
    release();
    const seen = await waitFor(() => atFirstRead);
    const identity = await processIdentity(seen.pid);
    expect(seen.recorded).toEqual([
      {
        attemptId: 'T-4-a1',
        pid: seen.pid,
        pgid: seen.pid,
        lstart: identity?.lstart as string,
        clone: realpathSync(f.paths.clone(FIXTURE_PROJECT, 'T-4-a1')),
      },
    ]);
  });

  test("the agent token reaches the agent's environment but never runner.db", async () => {
    const script: FakeScript = { turns: [[{ do: 'tool', command: 'printf %s "$AGFLOW_AGENT_TOKEN" > token.txt' }]] };
    const f = await createRunnerFixture({ script });
    await f.controller().start(f.spec());
    const token = join(f.paths.clone(FIXTURE_PROJECT, 'T-4-a1'), 'token.txt');
    await waitFor(() => existsSync(token) && readFileSync(token, 'utf8') !== '');
    expect(readFileSync(token, 'utf8')).toBe(fixtureAgentToken('T-4-a1'));
    await waitFor(() => f.events('attempt.spawned').length > 0);
    // The database's bytes, its WAL included: a token written and overwritten would still be in their pages.
    for (const suffix of ['', '-wal', '-shm']) {
      const file = f.paths.db + suffix;
      if (existsSync(file)) expect(readFileSync(file).includes(fixtureAgentToken('T-4-a1'))).toBe(false);
    }
  });

  test('an adapter that cannot start the agent gives attempt.failed_to_start with refused null', async () => {
    const f = await createRunnerFixture();
    const fake = f.fakes.claude as FakeAdapter;
    f.adapters.set(
      'claude',
      wrappedAdapter(fake, {
        start: () => {
          throw new Error('the claude binary is missing');
        },
      }),
    );
    const outcome = await f.controller().start(f.spec());
    expect(outcome).toEqual({
      started: false,
      refused: null,
      error: expect.stringContaining('the claude binary is missing'),
    });
    expect(f.events('attempt.failed_to_start').map((event) => event.data)).toEqual([
      { error: expect.stringContaining('the claude binary is missing'), refused: null },
    ]);
    expect(f.events('attempt.spawned')).toEqual([]);
    expect(f.store.processes('T-4-a1')).toEqual([]);
  });

  test('a vendor with no CLI pin for this platform gives attempt.failed_to_start and releases the base checkout', async () => {
    const f = await createRunnerFixture();
    const cliVersion = (): string => {
      throw new Error('agflow pins no claude CLI for linux-x64');
    };
    const outcome = await f.controller('T-4-a1', { cliVersion }).start(f.spec());
    expect(outcome).toEqual({
      started: false,
      refused: null,
      error: expect.stringContaining('agflow pins no claude CLI for linux-x64'),
    });
    expect(f.events('attempt.failed_to_start').map((event) => event.data)).toEqual([
      { error: expect.stringContaining('agflow pins no claude CLI for linux-x64'), refused: null },
    ]);
    expect(f.fakes.claude?.launches).toEqual([]);
    expect(existsSync(f.paths.baseCheckout(FIXTURE_PROJECT, f.origin.mainSha))).toBe(false);
  });
});
