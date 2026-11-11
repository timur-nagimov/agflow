// The local Claude smoke harness (design 15, 15.1, 8.1, 8.2, 10; X-20, X-26). The pinned claude runs against the
// scripted Messages API behind the refusing proxy, with a fake key, a scratch AGFLOW_HOME (the located binary linked
// into its vendor/), a scratch Claude home and a scratch HOME, in a real task clone and base checkout made from a
// local bare origin. M2b's in-process hub holds the runner agent and its agt_ token; the real bridge and brief hook
// run from source in selfCommand()'s hardened form and reach the hub through a tap that records what it was asked. No
// model is ever used, and every test checks that through isolationProblems().
import { describe } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { type AddressInfo, connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Agent, Attempt, Task } from '@agflow/core';
import { createTasks } from '@agflow/hub/src/tasks';
import { newTask } from '@agflow/hub/test/helpers';
import {
  type OriginRepo,
  originRepo,
  type RefusedRequest,
  type RefusingProxy,
  startRefusingProxy,
} from '@agflow/testkit';
import {
  type AnthropicHandler,
  CLAUDE_TEST_API_KEY,
  claudeTestEnv,
  findClaudeBinary,
  linkClaudeBinary,
  type ScriptedAnthropic,
  startScriptedAnthropic,
} from '@agflow/testkit/src/anthropic';
import type { ClaudeAdapter } from '../../src/adapters/claude/adapter';
import { createClaudeAdapter } from '../../src/adapters/claude/factory';
import { CLAUDE_CLI_VERSION, claudePin } from '../../src/adapters/claude/pin';
import type { ClaudeSession } from '../../src/adapters/claude/session';
import type { AgentEvent, AgentLaunch, AgflowCommand } from '../../src/adapters/types';
import { bridgeOf } from '../../src/attempt/launch';
import { type RunnerConfig, RunnerConfigSchema, vendorHomes } from '../../src/config';
import { buildAgentEnv } from '../../src/env';
import { createTaskClone } from '../../src/git/clone';
import { ensureRunnerGitFiles, remoteGitEnv } from '../../src/git/run';
import { type BaseCheckout, Vault } from '../../src/git/vault';
import { makeAttemptTmpDir, projectKey, type RunnerPaths, runnerPaths } from '../../src/paths';
import { killGroup, type ProcessIdentity, processIdentity } from '../../src/processes';
import { profileOf } from '../../src/profile';
import { removeAgentTools, withWorkingDirectory, writeRunDir } from '../../src/run-dir';
import { vendorPlatform } from '../../src/vendor/pins';
import { addRunnerAttempt, mintAgentToken, startTestHub, type TestHub } from '../hub-fixture';

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..');

/**
 * The real agflow from source, as selfCommand() gives it: the bridge (`mcp --vendor claude --runner`) and the brief
 * hook (X-26). The two Bun flags keep a bunfig.toml or .env in the working directory from loading.
 */
export const SMOKE_AGFLOW: AgflowCommand = {
  command: process.execPath,
  args: ['--no-env-file', '--config=/dev/null', join(REPO_ROOT, 'packages', 'cli', 'src', 'main.ts')],
};

/** A full model id; the scripted server answers any. */
export const SMOKE_MODEL = 'claude-sonnet-5-5';

const PROJECT = 'smoke';
const ATTEMPT_WAIT_MS = 60_000;

// ---------------------------------------------------------------------------------------------------------------
// The gate

export type ClaudeSmokeGate = { run: true; bin: string; reason: null } | { run: false; bin: null; reason: string };

export interface ClaudeSmokeGateOptions {
  /** process.env by default. */
  env?: Record<string, string | undefined>;
  /** The home findClaudeBinary searches; the real home by default. */
  home?: string;
  /** The variables that must be 1 for the suite to run (X-20). */
  switches?: string[];
}

/**
 * Whether the real-CLI suites run (X-20): only with AGFLOW_SMOKE=1 (and whatever other switches a suite needs), on a
 * platform the pin supports, with the pinned claude found. Otherwise the reason says what is missing.
 */
export function claudeSmokeGate(options: ClaudeSmokeGateOptions = {}): ClaudeSmokeGate {
  const env = options.env ?? process.env;
  const missing = (options.switches ?? ['AGFLOW_SMOKE']).filter((name) => env[name] !== '1');
  if (missing.length > 0) return { run: false, bin: null, reason: `${missing.join(' and ')}=1 not set` };
  if (claudePin(vendorPlatform()) === null) {
    return { run: false, bin: null, reason: `agflow pins no claude for ${vendorPlatform()}` };
  }
  const found = findClaudeBinary(CLAUDE_CLI_VERSION, { env, home: options.home });
  if (found.path === null) return { run: false, bin: null, reason: found.reason };
  return { run: true, bin: found.path, reason: null };
}

/** describe, or describe.skip with the gate's reason in its title, so a skipped run says why. */
export function smokeDescribe(gate: ClaudeSmokeGate, title: string, fn: () => void): void {
  if (gate.run) describe(title, fn);
  else describe.skip(`${title} (skipped: ${gate.reason})`, fn);
}

// ---------------------------------------------------------------------------------------------------------------
// The hub tap

/** One request the bridge or the brief hook sent the hub, as the hub received it. */
export interface HubTapRequest {
  method: string;
  path: string;
  /** The bearer token, or null. */
  bearer: string | null;
  /** X-Agflow-Agent, which an agent-token request must not carry. */
  agentHeader: string | null;
  status: number;
}

/** A hub path the tap holds: requests for it wait until release(). */
export interface HubHold {
  /** Resolves once a request for the path reached the tap. */
  reached: Promise<void>;
  /** Lets the held requests, and later ones, through. */
  release(): void;
}

interface HubTap {
  url: string;
  requests: HubTapRequest[];
  hold(path: string): HubHold;
  stop(): Promise<void>;
}

/**
 * Forwards every request to the hub as it came and records it; the hub answers only at 127.0.0.1 anyway. A held path
 * waits before it is forwarded, so a test can act while the CLI waits on the hub (in its brief hook, say).
 */
function startHubTap(hubUrl: string): HubTap {
  const requests: HubTapRequest[] = [];
  const holds = new Map<string, { arrived(): void; opened: Promise<void> }>();
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 0,
    async fetch(incoming) {
      const url = new URL(incoming.url);
      const held = holds.get(url.pathname);
      if (held) {
        held.arrived();
        await held.opened;
      }
      const body = incoming.method === 'GET' || incoming.method === 'HEAD' ? undefined : await incoming.arrayBuffer();
      const answer = await fetch(`${hubUrl}${url.pathname}${url.search}`, {
        method: incoming.method,
        headers: incoming.headers,
        body,
      });
      const authorization = incoming.headers.get('authorization');
      requests.push({
        method: incoming.method,
        path: url.pathname,
        bearer: authorization?.match(/^Bearer (.+)$/)?.[1] ?? null,
        agentHeader: incoming.headers.get('x-agflow-agent'),
        status: answer.status,
      });
      // fetch has decoded the body already.
      const headers = new Headers(answer.headers);
      headers.delete('content-encoding');
      headers.delete('content-length');
      return new Response(await answer.arrayBuffer(), { status: answer.status, headers });
    },
  });
  const opens: (() => void)[] = [];
  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    hold(path) {
      const reached = Promise.withResolvers<void>();
      const opened = Promise.withResolvers<void>();
      holds.set(path, { arrived: reached.resolve, opened: opened.promise });
      opens.push(opened.resolve);
      return { reached: reached.promise, release: opened.resolve };
    },
    stop: () => {
      // A held request ends with the tap.
      for (const open of opens) open();
      return server.stop(true);
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Sessions

/** A started session and every event it emitted so far. */
export interface SmokeSession {
  session: ClaudeSession;
  events: AgentEvent[];
  /** The first event, from the given index on, that matches; it fails after timeoutMs. */
  next<T extends AgentEvent['type']>(
    type: T,
    match?: (event: Extract<AgentEvent, { type: T }>) => boolean,
    options?: { from?: number; timeoutMs?: number },
  ): Promise<Extract<AgentEvent, { type: T }>>;
  /** Resolves once the events end, after the CLI exited. */
  ended: Promise<void>;
}

function collect(session: ClaudeSession): SmokeSession {
  const events: AgentEvent[] = [];
  const waiters = new Set<() => void>();
  let done = false;
  const ended = (async () => {
    for await (const event of session.events) {
      events.push(event);
      for (const wake of [...waiters]) wake();
    }
    done = true;
    for (const wake of [...waiters]) wake();
  })();
  return {
    session,
    events,
    ended,
    async next(type, match = () => true, options = {}) {
      const deadline = Date.now() + (options.timeoutMs ?? ATTEMPT_WAIT_MS);
      for (;;) {
        const found = events
          .slice(options.from ?? 0)
          .find((event) => event.type === type && match(event as Extract<AgentEvent, { type: typeof type }>));
        if (found) return found as Extract<AgentEvent, { type: typeof type }>;
        if (done) throw new Error(`the session ended without a matching ${type} event: ${JSON.stringify(events)}`);
        if (Date.now() > deadline) throw new Error(`no matching ${type} event: ${JSON.stringify(events)}`);
        await new Promise<void>((resolve) => {
          const wake = () => {
            clearTimeout(timer);
            waiters.delete(wake);
            resolve();
          };
          const timer = setTimeout(wake, 200);
          waiters.add(wake);
        });
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The harness

export interface ClaudeSmokeOptions {
  /** The pinned claude; the gate's by default. */
  bin?: string;
  /** The scripted server's first handler; setHandler replaces it. */
  handler?: AnthropicHandler;
  /** CLAUDE_CODE_MAX_RETRIES; 0 by default. */
  maxRetries?: number;
  /** runner.json's profile; standard by default. */
  profile?: RunnerConfig['profile'];
  /**
   * The host:port targets the CLI's proxy tunnels to the real host, for the sandbox's network checks: Claude's sandbox
   * proxy chains through HTTPS_PROXY, so behind a proxy that refuses everything no sandboxed command could reach an
   * allowed registry. Every other target is still refused and recorded, and the model still comes only from the
   * scripted server on 127.0.0.1.
   */
  egress?: string[];
  /**
   * The owner's SHELL, as the agent environment and preflight carry it (7.6); the test process's by default. The
   * adapter runs the CLI's shells as zsh whatever it is (8.2).
   */
  shell?: string;
  /** More files of the origin's main, so of the clone and the base checkout, besides README.md and src/app.ts. */
  files?: Record<string, string>;
  /** How the bridge and the brief hook run agflow: SMOKE_AGFLOW by default. */
  agflow?: AgflowCommand;
}

export interface StartSmokeOptions {
  /** A new session's first prompt. */
  prompt?: string;
  /** The session to resume instead. */
  resume?: string;
}

export interface ClaudeSmoke {
  /** The scratch directory everything but the clone's temporary directory lies in. */
  root: string;
  /** The agent's scratch HOME. */
  home: string;
  paths: RunnerPaths;
  config: RunnerConfig;
  /** The runner's Claude home, every launch's CLAUDE_CONFIG_DIR. */
  claudeHome: string;
  server: ScriptedAnthropic;
  proxy: RefusingProxy;
  hub: TestHub;
  /** Every request the bridge and the brief hook sent the hub. */
  hubRequests: HubTapRequest[];
  origin: OriginRepo;
  /** The runner agent the hub knows, its attempt, task and agt_ token. */
  agent: Agent;
  attempt: Attempt;
  task: Task;
  token: string;
  /** A marker in the task's title: it reaches the model only through the hub's brief. */
  briefMarker: string;
  clone: string;
  baseCheckout: string;
  tmpDir: string;
  adapter: ClaudeAdapter;
  /** The launch a start uses: the agent environment, the bridge and the profile as the runner builds them. */
  launch(options?: StartSmokeOptions): AgentLaunch;
  /** Starts (or resumes) a session through the adapter, collecting its events. */
  start(options?: StartSmokeOptions): Promise<SmokeSession>;
  /** The pids the launches registered. */
  pids: number[];
  /** Holds the bridge's and the brief hook's requests for a hub path until release(). */
  holdHub(path: string): HubHold;
  /**
   * Why this harness may have let a request reach a real model, the owner's home or a host other than the scripted
   * server and the hub; empty when it did not.
   */
  isolationProblems(): string[];
  close(): Promise<void>;
}

const smokes = new Set<ClaudeSmoke>();

/** For afterEach: closes every harness a test started, even when it failed. */
export async function cleanupClaudeSmokes(): Promise<void> {
  for (const smoke of [...smokes]) await smoke.close();
}

/**
 * The user variables an agent environment carries over (design 7.6), with the scratch HOME in place of the owner's
 * and the given SHELL, if any.
 */
function runnerEnv(home: string, shell: string | undefined): Record<string, string> {
  const env: Record<string, string> = { HOME: home, AGFLOW_TEST: '1' };
  for (const name of ['USER', 'LOGNAME', 'LANG', 'SHELL']) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  if (shell !== undefined) env.SHELL = shell;
  return env;
}

export async function startClaudeSmoke(options: ClaudeSmokeOptions = {}): Promise<ClaudeSmoke> {
  const bin = options.bin ?? claudeSmokeGate().bin;
  if (!bin) throw new Error('no pinned claude: check claudeSmokeGate() before starting the harness');
  const agflow = options.agflow ?? SMOKE_AGFLOW;
  const cleanups: (() => void | Promise<void>)[] = [];
  const later = (cleanup: () => void | Promise<void>) => cleanups.push(cleanup);
  const closeAll = async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      try {
        await cleanup();
      } catch {
        // The rest is cleaned up regardless.
      }
    }
  };
  try {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'agflow-claude-smoke-')));
    later(() => rmSync(root, { recursive: true, force: true }));
    const home = join(root, 'home');
    mkdirSync(home);
    const paths = runnerPaths(join(root, 'agflow'));
    ensureRunnerGitFiles(paths);
    linkClaudeBinary(paths.home, CLAUDE_CLI_VERSION, bin);

    const server = await startScriptedAnthropic({ handler: options.handler });
    later(() => server.close());
    const proxy = options.egress === undefined ? await startRefusingProxy() : await startEgressProxy(options.egress);
    later(() => proxy.close());
    const origin = await originRepo({
      'README.md': '# Smoke project\n',
      'src/app.ts': 'export const app = 1;\n',
      ...options.files,
    });
    later(() => origin.remove());
    const hub = startTestHub({ config: { projectName: PROJECT, projectRepo: origin.path } });
    later(() => hub.stop());
    const tap = startHubTap(hub.url);
    later(() => tap.stop());

    const briefMarker = `smoke-brief-${crypto.randomUUID().slice(0, 8)}`;
    const [created] = createTasks(hub.ctx, [newTask({ title: `Tidy the app ${briefMarker}` })], 'user:alice');
    if (!created) throw new Error('the hub created no task');
    const { agent, attempt, task } = addRunnerAttempt(hub.ctx, { taskId: created.id });
    const token = mintAgentToken(hub.ctx, attempt);
    if (!task.branch) throw new Error(`${task.id} has no branch`);

    const claudeEnv = claudeTestEnv({ baseUrl: server.url, proxyUrl: proxy.url, maxRetries: options.maxRetries });
    const config = RunnerConfigSchema.parse({
      runnerKey: 'rk_claude_smoke',
      machineId: 'MACHINE-SMOKE',
      name: 'smoke-laptop',
      profile: options.profile ?? 'standard',
      test: {
        claudeEnv,
        skipAuthChecks: true,
      },
    });
    const claudeHome = vendorHomes(config, paths).claude;
    mkdirSync(claudeHome, { recursive: true });

    // The vault, the task clone and the base checkout as the runner makes them, with no owner git configuration.
    const project = projectKey(hub.url, PROJECT);
    const vault = new Vault({
      paths,
      project,
      repo: { url: origin.path, mainBranch: 'main' },
      remote: () => remoteGitEnv({ base: { PATH: process.env.PATH, HOME: home }, gitDir: paths.vault(project) }),
    });
    await vault.ensure();
    const fromMain = { ref: 'refs/heads/main', sha: null };
    await vault.fetchForAttempt({ taskId: task.id, start: fromMain }, hub.ctx.config.wipRefPrefix);
    const clonePath = paths.clone(project, attempt.id);
    await createTaskClone({
      vault,
      local: vault.local,
      attemptId: attempt.id,
      clone: clonePath,
      branch: task.branch,
      startSha: origin.mainSha,
    });
    const clone = realpathSync(clonePath);
    const base: BaseCheckout = await vault.acquireBaseCheckout(attempt.id);
    later(() => base.release());
    const tools = paths.agentTools(project, attempt.id);
    later(() => removeAgentTools(tools));
    writeRunDir({
      clone,
      tools,
      taskPack: `# ${task.id} ${task.title}\n`,
      brief: withWorkingDirectory(`Work on ${task.id}.`, clone),
      identity: config.commitIdentity,
    });
    const tmpDir = makeAttemptTmpDir();
    later(() => rmSync(tmpDir, { recursive: true, force: true }));

    const env = buildAgentEnv({
      vendor: 'claude',
      spec: { attemptId: attempt.id, role: 'worker', agentToken: token, hubUrl: tap.url },
      clone,
      tools,
      tmpDir,
      config,
      paths,
      base: runnerEnv(home, options.shell),
      env: { AGFLOW_TEST: '1' },
    });
    const adapter = createClaudeAdapter(
      { config, paths, agflow },
      { env: runnerEnv(home, options.shell) },
    );
    const pids: number[] = [];
    const identities: Promise<ProcessIdentity | null>[] = [];
    later(async () => {
      // Whatever CLI a test left running goes before its files do; the start time guards against a reused pid.
      for (const identity of await Promise.all(identities)) if (identity) await killGroup(identity, 'SIGKILL');
    });

    const launch = (start: StartSmokeOptions = {}): AgentLaunch => ({
      attemptId: attempt.id,
      role: 'worker',
      model: SMOKE_MODEL,
      cliVersion: CLAUDE_CLI_VERSION,
      clone,
      baseCheckout: base.path,
      projectConfigVerified: false,
      tmpDir,
      env,
      bridge: bridgeOf(agflow, 'claude', env),
      profile: profileOf(config),
      brief: withWorkingDirectory(`Work on ${task.id}.`, clone),
      firstPrompt: start.prompt ?? '',
      resume: start.resume === undefined ? null : { sessionRef: start.resume },
      logFile: join(root, 'attempt.log'),
      registerProcess: (pid) => {
        pids.push(pid);
        identities.push(processIdentity(pid));
      },
    });

    const smoke: ClaudeSmoke = {
      root,
      home,
      paths,
      config,
      claudeHome,
      server,
      proxy,
      hub,
      hubRequests: tap.requests,
      origin,
      agent,
      attempt,
      task,
      token,
      briefMarker,
      clone,
      baseCheckout: base.path,
      tmpDir,
      adapter,
      launch,
      pids,
      holdHub: (path) => tap.hold(path),
      async start(start = {}) {
        const session = (await adapter.start(launch(start))) as ClaudeSession;
        const collected = collect(session);
        later(async () => {
          session.terminate();
          await Promise.race([session.exited, Bun.sleep(5_000)]);
        });
        return collected;
      },
      isolationProblems() {
        return isolationProblems({
          env,
          root,
          home,
          claudeHome,
          server,
          proxy,
          hubUrl: tap.url,
        });
      },
      async close() {
        smokes.delete(smoke);
        await closeAll();
      },
    };
    smokes.add(smoke);
    return smoke;
  } catch (error) {
    await closeAll();
    throw error;
  }
}

function isolationProblems(input: {
  env: Record<string, string>;
  root: string;
  home: string;
  claudeHome: string;
  server: ScriptedAnthropic;
  proxy: RefusingProxy;
  hubUrl: string;
}): string[] {
  const { env, root, server } = input;
  const problems: string[] = [];
  const inside = (path: string | undefined) => path !== undefined && path.startsWith(`${root}/`);
  if (env.ANTHROPIC_BASE_URL !== server.url || !server.url.startsWith('http://127.0.0.1:')) {
    problems.push(`ANTHROPIC_BASE_URL is ${env.ANTHROPIC_BASE_URL}, not the scripted server on 127.0.0.1`);
  }
  if (env.ANTHROPIC_API_KEY !== CLAUDE_TEST_API_KEY) problems.push('the agent environment holds another API key');
  if (env.HOME !== input.home || !inside(env.HOME)) problems.push(`HOME is ${env.HOME}, not the scratch home`);
  if (env.CLAUDE_CONFIG_DIR !== input.claudeHome || !inside(env.CLAUDE_CONFIG_DIR)) {
    problems.push(`CLAUDE_CONFIG_DIR is ${env.CLAUDE_CONFIG_DIR}, not the scratch Claude home`);
  }
  if (env.HTTPS_PROXY !== input.proxy.url || env.HTTP_PROXY !== input.proxy.url) {
    problems.push(`HTTPS_PROXY is ${env.HTTPS_PROXY}, not the test proxy`);
  }
  if (!input.hubUrl.startsWith('http://127.0.0.1:') || env.AGFLOW_HUB_URL !== input.hubUrl) {
    problems.push(`AGFLOW_HUB_URL is ${env.AGFLOW_HUB_URL}, not the in-process hub`);
  }
  for (const request of server.requests) {
    if (request.headers['x-api-key'] !== CLAUDE_TEST_API_KEY || request.headers.authorization !== undefined) {
      problems.push(`a request to ${request.path} carried other credentials`);
    }
  }
  // Every other host goes through the test proxy, which records what it refused; none was even tried.
  for (const refused of input.proxy.refused) problems.push(`the CLI tried ${refused.method} ${refused.target}`);
  // The Claude home is the scratch one: no transcript was written anywhere else.
  if (existsSync(join(input.claudeHome, 'projects'))) {
    for (const dir of readdirSync(join(input.claudeHome, 'projects'))) {
      if (!dir.startsWith(root.replace(/[^A-Za-z0-9]/g, '-'))) problems.push(`a project directory ${dir} is outside`);
    }
  }
  return problems;
}

/**
 * The test proxy of the sandbox's network checks: like the refusing proxy, except that it tunnels a CONNECT to one of
 * the allowed host:port targets to the real host. Plain requests and every other target are refused and recorded.
 */
async function startEgressProxy(allowed: string[]): Promise<RefusingProxy> {
  const refused: RefusedRequest[] = [];
  const tunnels = new Set<Socket>();
  const server = createServer((request, response) => {
    refused.push({ kind: 'http', method: request.method ?? 'GET', target: request.url ?? '', at: Date.now() });
    response.writeHead(403, { 'content-type': 'text/plain' }).end('refused by the agflow test proxy\n');
  });
  server.on('connect', (request, client: Socket, head: Buffer) => {
    const target = request.url ?? '';
    client.on('error', () => {});
    if (!allowed.includes(target)) {
      refused.push({ kind: 'connect', method: 'CONNECT', target, at: Date.now() });
      client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      return;
    }
    const colon = target.lastIndexOf(':');
    const upstream = connect(Number(target.slice(colon + 1)), target.slice(0, colon), () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    for (const socket of [client, upstream]) {
      tunnels.add(socket);
      socket.on('close', () => tunnels.delete(socket));
    }
    upstream.on('error', () => client.destroy());
    client.on('close', () => upstream.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    refused,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
        // A tunnel is no longer the server's connection.
        for (const socket of tunnels) socket.destroy();
      }),
  };
}
