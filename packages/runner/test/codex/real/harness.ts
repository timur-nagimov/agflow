// The local real-binary harness for the Codex adapter (design 15, 15.1, 10): the pinned app-server runs against the
// scripted Responses provider with zero model use, behind the refusing proxy, with scratch homes only. It serves
// M2b's in-process hub, gives every attempt a hub attempt, its agent token and a clone of a local origin with
// .agflow/run, and starts sessions through the real CodexAdapter, whose bridge is the real `agflow mcp --runner`.
// The suites under this directory run only with AGFLOW_SMOKE=1 and a located pin (root script smoke:codex).
import type { Attempt } from '@agflow/core';
import { type OriginRepo, gitIn, originRepo, type RefusingProxy, startRefusingProxy } from '@agflow/testkit';
import {
  codexTestConfig,
  type ResponsesHandler,
  type ResponsesServer,
  startResponsesServer,
} from '@agflow/testkit/src/codex/index';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { BRIDGE_TOOL_NAMES } from '../../../src/adapters/bridge-tools';
import { CODEX_VERSION, type CodexAdapter, createCodexAdapter, findCodexBinary } from '../../../src/adapters/codex';
import type { FindCodexOptions } from '../../../src/adapters/codex/binary';
import type { CodexSession } from '../../../src/adapters/codex/session';
import type { AgentEvent, AgentLaunch } from '../../../src/adapters/types';
import { type RunnerConfig, RunnerConfigSchema } from '../../../src/config';
import { bridgeEnvOf, buildAgentEnv } from '../../../src/env';
import { type RunnerPaths, runnerPaths } from '../../../src/paths';
import { profileOf } from '../../../src/profile';
import { removeAgentTools, type RunDir, withWorkingDirectory, writeRunDir } from '../../../src/run-dir';
import { vendorBinary } from '../../../src/vendor/pins';
import { addRunnerAttempt, mintAgentToken, startTestHub, type TestHub } from '../../hub-fixture';

/** The pinned binary when the local suites may run: AGFLOW_SMOKE=1 and findCodexBinary finds the pin. */
export async function smokeCodexBinary(options: FindCodexOptions = {}): Promise<string | null> {
  const env = options.env ?? process.env;
  return env.AGFLOW_SMOKE === '1' ? findCodexBinary({ env, home: options.home }) : null;
}

/** The agflow CLI the bridge runs from, as the runner's selfCommand gives it in a checkout (with its two Bun flags). */
const CLI_MAIN = join(import.meta.dir, '..', '..', '..', '..', 'cli', 'src', 'main.ts');

const PROJECT = 'codex-real';

/**
 * A committed project config: every start and resume runs with one, trusted or not, and must see no configWarning
 * (a thread started in a clone with .codex/ once failed on Codex's startup warning). Its effort is not the default
 * ('low' for the pinned slug with this provider), so a request shows whether the thread loaded it.
 */
export const PROJECT_CODEX_CONFIG = '# The project\'s own Codex settings.\nmodel_reasoning_effort = "high"\n';

/** A committed repo skill: an untrusted thread still loads it (design 9.2), and the skills check must allow it. */
export const REPO_SKILL_MARKER = 'REPO-SKILL-MARKER';

export const DEFAULT_ORIGIN_FILES: Record<string, string> = {
  'README.md': '# Codex real-binary fixture\n',
  'src/app.txt': 'version 1\n',
  '.codex/config.toml': PROJECT_CODEX_CONFIG,
  '.codex/skills/fixture-skill/SKILL.md': [
    '---',
    'name: fixture-skill',
    `description: Marker skill ${REPO_SKILL_MARKER} for the real-binary checks.`,
    '---',
    '',
  ].join('\n'),
};

export interface CodexHarnessOptions {
  /** The origin's first commit; DEFAULT_ORIGIN_FILES by default. */
  files?: Record<string, string>;
  /** Answers the provider's requests; tests may also call provider.setHandler later. */
  handler?: ResponsesHandler;
  streamIdleTimeoutMs?: number;
}

export interface HarnessAttemptOptions {
  role?: 'worker' | 'lead';
  projectConfigVerified?: boolean;
  /** Changes the bridge's environment as the launch gives it, to drop a required variable, say. */
  bridgeEnv?: (env: Record<string, string>) => Record<string, string>;
  /** Changes the launch's agent environment (launch.env) after it is built. */
  agentEnv?: (env: Record<string, string>) => Record<string, string>;
  brief?: string;
  firstPrompt?: string;
}

export interface HarnessAttempt {
  /** The hub's attempt, running on a runner of the owner's. */
  attempt: Attempt;
  token: string;
  /** The clone's real path, on the task branch. */
  clone: string;
  runDir: RunDir;
  launch: AgentLaunch;
  /** The pids the adapter registered, in order. */
  registered: number[];
  /** Starts a session, or with sessionRef resumes that thread, through the adapter. */
  start(resume?: string): Promise<CodexSession>;
}

export interface CodexHarness {
  bin: string;
  /** The test's own temporary directory, outside every clone. */
  dir: string;
  paths: RunnerPaths;
  config: RunnerConfig;
  adapter: CodexAdapter;
  hub: TestHub;
  /** Every request agents' bridges made to the hub, as 'METHOD /path', in arrival order. */
  hubRequests: string[];
  provider: ResponsesServer;
  proxy: RefusingProxy;
  origin: OriginRepo;
  attempt(options?: HarnessAttemptOptions): Promise<HarnessAttempt>;
  /** Closes the sessions it started, then the provider, the hub and the proxy, and removes its directories. */
  close(): Promise<void>;
}

/** The runner's own environment as an adapter sees it: AGFLOW_TEST on, never an agflow or Codex variable. */
function adapterEnv(): Record<string, string | undefined> {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith('AGFLOW_') && !name.startsWith('CODEX_')),
    ),
    AGFLOW_TEST: '1',
  };
}

export async function startCodexHarness(bin: string, options: CodexHarnessOptions = {}): Promise<CodexHarness> {
  const cleanups: (() => Promise<void> | void)[] = [];
  const sessions: CodexSession[] = [];
  const close = async () => {
    for (const session of sessions.splice(0)) await session.close().catch(() => {});
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  };
  try {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agflow-codex-real-')));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const paths = runnerPaths(join(dir, 'agflow'));
    // The located version directory, so Code Mode's host and the bundled rg sit beside the binary (design 9.1, 15).
    const pinned = join(paths.runner, vendorBinary('codex', CODEX_VERSION));
    mkdirSync(dirname(dirname(dirname(pinned))), { recursive: true });
    symlinkSync(dirname(dirname(bin)), dirname(dirname(pinned)));

    const proxy = await startRefusingProxy();
    cleanups.push(() => proxy.close());
    const provider = await startResponsesServer({ handler: options.handler });
    cleanups.push(() => provider.close());
    const origin = await originRepo(options.files ?? DEFAULT_ORIGIN_FILES);
    cleanups.push(() => origin.remove());
    const hub = startTestHub({ config: { projectName: PROJECT, projectRepo: origin.path } });
    cleanups.push(() => hub.stop());
    // Agents reach the hub through a recording front, so a test sees which bridge calls reached it.
    const hubRequests: string[] = [];
    const front = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        hubRequests.push(`${request.method} ${url.pathname}`);
        const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer();
        return fetch(`${hub.url}${url.pathname}${url.search}`, {
          method: request.method,
          headers: request.headers,
          body,
        });
      },
    });
    cleanups.push(() => front.stop(true));

    const config = RunnerConfigSchema.parse({
      runnerKey: 'codex-real-runner',
      machineId: 'codex-real-machine',
      name: 'codex-real',
      capturedPath: '/usr/bin:/bin:/usr/sbin:/sbin',
      // Every external connection meets the refusing proxy; the hub, the provider and the bridge are on loopback.
      connectivity: {
        HTTP_PROXY: proxy.url,
        HTTPS_PROXY: proxy.url,
        ALL_PROXY: proxy.url,
        NO_PROXY: '127.0.0.1,localhost',
      },
      test: {
        codexConfig: codexTestConfig(provider.url, { streamIdleTimeoutMs: options.streamIdleTimeoutMs }),
        skipAuthChecks: true,
      },
    });
    const env = adapterEnv();
    const adapter = createCodexAdapter({ config, paths, env });

    const attempt = async (input: HarnessAttemptOptions = {}): Promise<HarnessAttempt> => {
      const started = addRunnerAttempt(hub.ctx, { owner: hub.owner, vendor: 'codex' });
      const hubAttempt = started.attempt;
      const token = mintAgentToken(hub.ctx, hubAttempt);
      const branch = started.task.branch ?? `agflow/${hubAttempt.taskId}`;
      const target = paths.clone(PROJECT, hubAttempt.id);
      mkdirSync(dirname(target), { recursive: true });
      await gitIn(dirname(target), ['clone', '--quiet', origin.path, target]);
      await gitIn(target, ['checkout', '--quiet', '-b', branch]);
      const clone = realpathSync(target);
      const brief = withWorkingDirectory(input.brief ?? `You work on ${hubAttempt.taskId} as ${hubAttempt.id}.`, clone);
      const runDir = writeRunDir({
        clone,
        tools: paths.agentTools(PROJECT, hubAttempt.id),
        taskPack: `# ${hubAttempt.taskId}\n\nThe task for the real-binary checks.\n`,
        brief,
        identity: config.commitIdentity,
      });
      const role = input.role ?? 'worker';
      const spec = { attemptId: hubAttempt.id, role, agentToken: token, hubUrl: `http://127.0.0.1:${front.port}` };
      const agentEnv = buildAgentEnv({
        vendor: 'codex',
        spec,
        clone,
        tools: runDir.tools,
        tmpDir: null,
        config,
        paths,
        base: env,
        env,
      });
      const registered: number[] = [];
      const launch: AgentLaunch = {
        attemptId: hubAttempt.id,
        role,
        model: config.models.codex[role],
        cliVersion: CODEX_VERSION,
        clone,
        baseCheckout: null,
        projectConfigVerified: input.projectConfigVerified ?? true,
        tmpDir: runDir.tmp,
        env: input.agentEnv ? input.agentEnv(agentEnv) : agentEnv,
        bridge: {
          command: process.execPath,
          args: ['--no-env-file', '--config=/dev/null', CLI_MAIN, 'mcp', '--vendor', 'codex', '--runner'],
          env: (input.bridgeEnv ?? ((given) => given))(bridgeEnvOf(agentEnv)),
          tools: BRIDGE_TOOL_NAMES[role],
        },
        profile: profileOf(config),
        brief,
        firstPrompt: input.firstPrompt ?? `Work on ${hubAttempt.taskId}.`,
        resume: null,
        logFile: paths.attemptLog(hubAttempt.id),
        registerProcess: (pid) => {
          registered.push(pid);
        },
      };
      cleanups.push(() => {
        // Read-only, as writeRunDir leaves it: the directory's own removal makes it writable first.
        removeAgentTools(runDir.tools);
        // A session a test killed or never closed leaves its group behind.
        for (const pid of registered) {
          try {
            process.kill(-pid, 'SIGKILL');
          } catch {
            // Already gone.
          }
        }
      });
      return {
        attempt: hubAttempt,
        token,
        clone,
        runDir,
        launch,
        registered,
        async start(resume) {
          const session = (await adapter.start({
            ...launch,
            resume: resume === undefined ? null : { sessionRef: resume },
          })) as CodexSession;
          sessions.push(session);
          return session;
        },
      };
    };

    return { bin, dir, paths, config, adapter, hub, hubRequests, provider, proxy, origin, attempt, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/** A session's events as they arrive, read by one pump, with waits for the next matching one. */
export class EventLog {
  readonly events: AgentEvent[] = [];
  readonly done: Promise<void>;
  private readonly waiters = new Set<() => void>();
  // Set by the pump itself, before it wakes the waiters: a wait on an ended log fails at once.
  private ended = false;

  constructor(source: AsyncIterable<AgentEvent>) {
    this.done = (async () => {
      for await (const event of source) {
        this.events.push(event);
        for (const wake of [...this.waiters]) wake();
      }
      this.ended = true;
      for (const wake of [...this.waiters]) wake();
    })();
  }

  of<T extends AgentEvent['type']>(type: T): Extract<AgentEvent, { type: T }>[] {
    return this.events.filter((event): event is Extract<AgentEvent, { type: T }> => event.type === type);
  }

  /** The first event from index `from` on that matches, waiting up to ms for it. */
  async next<T extends AgentEvent['type']>(
    type: T,
    options: { from?: number; ms?: number; where?: (event: Extract<AgentEvent, { type: T }>) => boolean } = {},
  ): Promise<Extract<AgentEvent, { type: T }>> {
    const deadline = Date.now() + (options.ms ?? 30_000);
    for (;;) {
      const found = this.events
        .slice(options.from ?? 0)
        .find(
          (event): event is Extract<AgentEvent, { type: T }> =>
            event.type === type && (options.where?.(event as Extract<AgentEvent, { type: T }>) ?? true),
        );
      if (found) return found;
      const left = deadline - Date.now();
      if (this.ended || left <= 0) {
        throw new Error(`no ${type} event${this.ended ? ' before the events ended' : ''}: ${this.summary()}`);
      }
      await new Promise<void>((resolve) => {
        const wake = () => {
          this.waiters.delete(wake);
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(wake, left);
        this.waiters.add(wake);
      });
    }
  }

  /** The event types so far, for failure messages. */
  summary(): string {
    return this.events.map((event) => event.type).join(', ') || '(none)';
  }
}
