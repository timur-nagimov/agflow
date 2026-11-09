// Thread startup, resume and their fail-closed checks (design 9.2, 7.4).
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { RunnerTestBlock } from '../../config';
import type { Logger } from '../../log';
import { vendorBinary } from '../../vendor/pins';
import type { AgentEvent, AgentLaunch, ExitInfo } from '../types';
import { appServerArgs, appServerEnv, threadOverrides } from './config';
import type { CodexClientMethod, ParamsOf, ResultOf } from './methods';
import { openAppServer, type AppServerProcess } from './process';
import { RpcError } from './rpc';

export interface CodexSessionOptions {
  /** paths.runner: vendorBinary paths are relative to it. */
  runnerDir: string;
  /** The runner's CODEX_HOME and the app-server's HOME. */
  codexHome: string;
  userHome: string;
  /** Passed by the adapter only in test mode. */
  testConfig?: RunnerTestBlock['codexConfig'] | null;
  logger?: Logger;
  /** Bounds each app-server request; tests pass a short one. */
  requestTimeoutMs?: number;
}

export class CodexSession {
  readonly pid: number;
  readonly events: AsyncIterable<AgentEvent>;
  readonly exited: Promise<ExitInfo>;
  private readonly queue = new EventQueue();

  private constructor(
    private readonly app: AppServerProcess,
    readonly sessionRef: string,
  ) {
    this.pid = app.pid;
    this.events = this.queue;
    this.exited = app.exited;
    void this.exited.then(() => this.queue.end());
  }

  static async start(launch: AgentLaunch, options: CodexSessionOptions): Promise<CodexSession> {
    const app = await openAppServer({
      bin: join(options.runnerDir, vendorBinary('codex', launch.cliVersion)),
      args: appServerArgs(options.testConfig),
      env: appServerEnv({
        base: launch.env,
        bridgeEnv: launch.bridge.env,
        codexHome: options.codexHome,
        userHome: options.userHome,
      }),
      // The clone is only the thread's cwd (threadOverrides). Started in the clone, app-server reads its .codex/ before
      // any thread's trust applies and sends a startup configWarning, which would fail every such start.
      cwd: options.userHome,
      expectedVersion: launch.cliVersion,
      logFile: launch.logFile,
      onSpawn: (pid) => launch.registerProcess(pid),
      logger: options.logger,
      requestTimeoutMs: options.requestTimeoutMs,
    });
    let warning: string | null = null;
    const unsubscribeWarning = app.rpc.on('configWarning', ({ summary }) => {
      warning ??= `codex reported a configuration warning: ${summary}`;
    });
    // mcpServerStatus/list omits a server that is still starting or failed to start, such as one a trusted project
    // config adds: its startup status is the only trace. A thread starts every server before it answers.
    const startedServers: { threadId: string | null; name: string }[] = [];
    const unsubscribeStartup = app.rpc.onNotification((notification) => {
      if (notification.method !== 'mcpServer/startupStatus/updated') return;
      startedServers.push({ threadId: notification.params.threadId, name: notification.params.name });
    });
    const unsubscribe = () => {
      unsubscribeWarning();
      unsubscribeStartup();
    };
    try {
      const { thread, resumed } = await CodexSession.openThread(app, launch, options.userHome, options.logger);
      const tools = await CodexSession.checkThread(
        app,
        launch,
        thread,
        resumed ? 'thread/resume' : 'thread/start',
        startedServers,
      );
      if (warning !== null) throw new Error(warning);
      unsubscribe();
      if (!resumed) {
        await request(app, 'thread/name/set', { threadId: thread.thread.id, name: `agflow ${launch.attemptId}` });
      }
      const session = new CodexSession(app, thread.thread.id);
      // The controller starts consuming only after start resolves, so these must already be buffered.
      session.queue.push({
        type: 'started',
        sessionRef: session.sessionRef,
        model: thread.model,
        cliVersion: launch.cliVersion,
        permissionMode: 'on-request',
      });
      if (!launch.projectConfigVerified) {
        session.queue.push({
          type: 'warning',
          text: "The clone's .codex/ could not be verified against the restore base; the thread runs untrusted, so its project config, hooks and exec policies are not loaded (its skills still load).",
        });
      }
      if (tools.length > 0) {
        session.queue.push({ type: 'warning', text: `codex thread lists extra agflow tools: ${tools.join(', ')}` });
      }
      if (!resumed) {
        // Both start and resume carry the tools note in developerInstructions.
        await request(app, 'turn/start', {
          threadId: session.sessionRef,
          input: [{ type: 'text', text: launch.firstPrompt, text_elements: [] }],
        });
      }
      return session;
    } catch (error) {
      await app.end();
      throw new Error(oneLine(warning ?? error));
    } finally {
      unsubscribe();
    }
  }

  async close(): Promise<void> {
    await this.app.end();
  }

  private static async openThread(
    app: AppServerProcess,
    launch: AgentLaunch,
    bridgeCwd: string,
    logger?: Logger,
  ): Promise<{ thread: ResultOf<'thread/start'> | ResultOf<'thread/resume'>; resumed: boolean }> {
    if (launch.resume !== null) {
      try {
        // Keep the RPC error intact until the never-ran case has been distinguished from other failures.
        const thread = await app.rpc.request('thread/resume', {
          threadId: launch.resume.sessionRef,
          ...threadOverrides(launch, bridgeCwd),
          excludeTurns: true,
        });
        return { thread, resumed: true };
      } catch (error) {
        if (!(error instanceof RpcError) || error.code !== -32600 || !error.message.startsWith('no rollout found')) {
          throw new Error(`codex thread/resume failed: ${oneLine(error)}`);
        }
        logger?.info('codex thread/resume: no rollout found; starting a fresh thread', {
          attemptId: launch.attemptId,
          sessionRef: launch.resume.sessionRef,
        });
      }
    }
    return { thread: await request(app, 'thread/start', threadOverrides(launch, bridgeCwd)), resumed: false };
  }

  /** Checks required tools against the live bridge; returns sorted extra names to warn about. */
  private static async checkThread(
    app: AppServerProcess,
    launch: AgentLaunch,
    thread: Pick<ResultOf<'thread/start'>, 'thread' | 'approvalPolicy' | 'approvalsReviewer' | 'sandbox' | 'cwd'>,
    method: 'thread/start' | 'thread/resume',
    startedServers: readonly { threadId: string | null; name: string }[],
  ): Promise<string[]> {
    if (thread.approvalPolicy !== 'on-request') {
      throw new Error(
        `codex ${method} reported approval policy ${JSON.stringify(thread.approvalPolicy)}, expected on-request`,
      );
    }
    if (thread.approvalsReviewer !== 'user') {
      throw new Error(`codex ${method} reported approvals reviewer ${thread.approvalsReviewer}, expected user`);
    }
    if (thread.sandbox.type !== 'workspaceWrite') {
      throw new Error(`codex ${method} reported sandbox ${thread.sandbox.type}, expected workspaceWrite`);
    }
    if (thread.sandbox.networkAccess !== false) {
      throw new Error(`codex ${method} reported sandbox network access, expected no network`);
    }
    if (thread.cwd !== realpathSync(launch.clone)) {
      throw new Error(`codex ${method} reported cwd ${thread.cwd}, expected ${realpathSync(launch.clone)}`);
    }
    const mcp = await request(app, 'mcpServerStatus/list', { threadId: thread.thread.id });
    // An incomplete inventory cannot establish that agflow is the only server.
    if (mcp.nextCursor !== null) throw new Error('codex thread lists an incomplete MCP server inventory');
    const agflow = mcp.data[0];
    if (mcp.data.length !== 1 || agflow?.name !== 'agflow') {
      throw new Error(
        `codex thread lists unexpected MCP servers: ${mcp.data.map((server) => server.name).join(', ') || '(none)'}`,
      );
    }
    // The bridge serves exactly the role's tools. Without any, the agent could neither report nor submit.
    const tools = Object.keys(agflow.tools).sort();
    if (tools.length === 0) {
      throw new Error(`codex thread lists no agflow tools${agflow.toolsError ? `: ${agflow.toolsError}` : ''}`);
    }
    const missing = launch.bridge.tools.filter((name) => !tools.includes(name));
    if (missing.length > 0) throw new Error(`codex thread is missing agflow tools: ${missing.join(', ')}`);
    // A status without a thread is the process's own server: no thread may have one either.
    const started = new Set(
      startedServers
        .filter((server) => server.threadId === null || server.threadId === thread.thread.id)
        .map((server) => server.name),
    );
    started.delete('agflow');
    if (started.size > 0) throw new Error(`codex thread started unexpected MCP servers: ${[...started].join(', ')}`);
    const skills = await request(app, 'skills/list', { cwds: [launch.clone] });
    const unexpected = skills.data
      .flatMap((entry) => entry.skills)
      .filter((skill) => skill.scope === 'user' || skill.pluginId !== null);
    if (unexpected.length > 0) {
      throw new Error(`codex thread lists user or plugin skills: ${unexpected.map((skill) => skill.name).join(', ')}`);
    }
    return tools.filter((name) => !launch.bridge.tools.includes(name));
  }
}

async function request<M extends CodexClientMethod>(
  app: AppServerProcess,
  method: M,
  params: ParamsOf<M>,
): Promise<ResultOf<M>> {
  try {
    return await app.rpc.request(method, params);
  } catch (error) {
    throw new Error(`codex ${method} failed: ${oneLine(error)}`);
  }
}

function oneLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim();
}

/** A single-consumer queue: exit ends waiting, but buffered events still drain. */
class EventQueue implements AsyncIterable<AgentEvent> {
  private readonly items: AgentEvent[] = [];
  private waiting: ((result: IteratorResult<AgentEvent>) => void) | null = null;
  private ended = false;

  push(event: AgentEvent): void {
    if (this.ended) return;
    const waiting = this.waiting;
    this.waiting = null;
    if (waiting) waiting({ value: event, done: false });
    else this.items.push(event);
  }

  end(): void {
    this.ended = true;
    const waiting = this.waiting;
    this.waiting = null;
    waiting?.({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.waiting = resolve;
        });
      },
    };
  }
}
