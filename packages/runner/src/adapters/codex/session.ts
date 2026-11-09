// Thread startup, resume, fail-closed checks and app-server events (design 9.2, 7.4).
import { TEST_ACCOUNT_ID } from '@agflow/core';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { RunnerTestBlock } from '../../config';
import type { Logger } from '../../log';
import { boundedWait } from '../../processes';
import { vendorBinary } from '../../vendor/pins';
import type { AgentEvent, AgentLaunch, ExitInfo } from '../types';
import { isFinalError, mergeRateLimits, quotaFromRateLimits, turnErrorKind } from './classify';
import { appServerArgs, appServerEnv, threadOverrides } from './config';
import { codexToolEnded, codexToolStarted } from './items';
import type { CodexClientMethod, ParamsOf, ResultOf } from './methods';
import { codexAccountIdentity } from './policy';
import { openAppServer, type AppServerProcess } from './process';
import type { ServerNotification } from './protocol';
import type { RateLimitSnapshot, Turn, TurnError } from './protocol/v2';
import { RpcError } from './rpc';

export interface CodexSessionOptions {
  /** paths.runner: vendorBinary paths are relative to it. */
  runnerDir: string;
  /** The runner's CODEX_HOME and the app-server's HOME. */
  codexHome: string;
  userHome: string;
  /** Passed by the adapter only in test mode. */
  testConfig?: RunnerTestBlock['codexConfig'] | null;
  /** test.skipAuthChecks, only in test mode: quota is then reported for core's TEST_ACCOUNT_ID, as preflight does. */
  skipAuthChecks?: boolean;
  logger?: Logger;
  /** Bounds each app-server request; tests pass a short one. */
  requestTimeoutMs?: number;
}

type TurnEnded = Extract<AgentEvent, { type: 'turn_ended' }>;

/** A started tool item and the main turn it counts for: its own turn on the main thread, else the active one. */
interface OpenTool {
  toolId: string;
  threadId: string;
  turnId: string;
  mainTurn: string | null;
}

export class CodexSession {
  readonly pid: number;
  readonly events: AsyncIterable<AgentEvent>;
  readonly exited: Promise<ExitInfo>;
  private readonly queue = new EventQueue();
  private activeTurn: string | null = null;
  private readonly turns = new Map<string, { started: boolean; toolCalls: number; error: TurnError | null }>();
  /** Started tool items, keyed by thread, turn and item. */
  private readonly tools = new Map<string, OpenTool>();
  /** Tools a turn's end ended before their item/completed: a late one is not reported again. */
  private readonly endedTools = new Set<string>();
  private rateLimits: RateLimitSnapshot | null = null;
  /** A quota failure's end, held until account/rateLimits/read settles. */
  private ending: Promise<void> | null = null;
  private startingTurn = false;
  private recoveredContext = false;
  private compaction: { turnId: string | null; toolCalls: number } | null = null;
  /** Turns a turn/start of ours answered: never the compaction turn. */
  private readonly ownTurns = new Set<string>();

  private constructor(
    private readonly app: AppServerProcess,
    readonly sessionRef: string,
    private readonly accountId: string | null,
    unsubscribe: () => void,
  ) {
    this.pid = app.pid;
    this.events = this.queue;
    this.exited = app.exited;
    void this.exited.then(async () => {
      // An escaped child can hold stdout open after the leader exits.
      await boundedWait(app.rpc.ended, 1000);
      unsubscribe();
      await this.ending;
      this.queue.end();
    });
  }

  get activeTurnId(): string | null {
    return this.activeTurn;
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
    let session: CodexSession | null = null;
    const pending: ServerNotification[] = [];
    const unsubscribeNotifications = app.rpc.onNotification((notification) => {
      if (session) session.notification(notification);
      else pending.push(notification);
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
      // Quota is account state: the hub applies an exhaustion to every runner on that account (design 6.10).
      const accountId = options.skipAuthChecks
        ? TEST_ACCOUNT_ID
        : await app.rpc.request('account/read', { refreshToken: false }).then(
            ({ account }) => codexAccountIdentity(account).accountId,
            () => null,
          );
      if (!resumed) {
        await request(app, 'thread/name/set', { threadId: thread.thread.id, name: `agflow ${launch.attemptId}` });
      }
      session = new CodexSession(app, thread.thread.id, accountId, unsubscribeNotifications);
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
      for (const notification of pending) session.notification(notification);
      pending.length = 0;
      if (!resumed) {
        // Both start and resume carry the tools note in developerInstructions.
        await session.startTurn(launch.firstPrompt);
      }
      return session;
    } catch (error) {
      unsubscribeNotifications();
      await app.end();
      throw new Error(oneLine(warning ?? error));
    } finally {
      unsubscribe();
    }
  }

  async close(): Promise<void> {
    await this.app.end();
  }

  private notification(notification: ServerNotification): void {
    switch (notification.method) {
      case 'turn/started': {
        const { threadId, turn } = notification.params;
        if (threadId !== this.sessionRef) return;
        this.activeTurn = turn.id;
        const state = this.turnState(turn.id);
        // compact/start answers no id: its turn is the next new main-thread turn that no turn/start of ours opened.
        if (
          this.compaction &&
          this.compaction.turnId === null &&
          !this.startingTurn &&
          !this.ownTurns.has(turn.id) &&
          !state.started
        ) {
          this.compaction.turnId = turn.id;
        }
        if (!state.started) {
          state.started = true;
          if (this.compaction?.turnId !== turn.id) this.queue.push({ type: 'turn_started' });
        }
        return;
      }
      case 'turn/completed': {
        const { threadId, turn } = notification.params;
        if (threadId === this.sessionRef) {
          this.turnCompleted(turn);
        } else if (turn.status !== 'inProgress') {
          // A child turn interrupted with a command approval pending does not complete that item either, and its tools
          // may count for no main turn: they end with their own turn.
          this.endOpenTools((tool) => tool.threadId === threadId && tool.turnId === turn.id);
        }
        return;
      }
      case 'error': {
        const params = notification.params;
        if (params.threadId === this.sessionRef && isFinalError(params)) {
          this.turnState(params.turnId).error = params.error;
        }
        return;
      }
      case 'item/started':
      case 'item/completed': {
        const { item, threadId, turnId } = notification.params;
        const start = codexToolStarted(item);
        if (start) {
          const key = JSON.stringify([threadId, turnId, item.id]);
          if (this.endedTools.has(key)) {
            if (notification.method === 'item/completed') this.endedTools.delete(key);
            return;
          }
          if (!this.tools.has(key)) {
            // Child tools are progress for the attempt while its main turn runs.
            const mainTurn = threadId === this.sessionRef ? turnId : this.activeTurn;
            this.tools.set(key, { toolId: item.id, threadId, turnId, mainTurn });
            if (mainTurn !== null) this.turnState(mainTurn).toolCalls += 1;
            this.queue.push(start);
          }
          if (notification.method === 'item/completed') {
            this.queue.push(codexToolEnded(item)!);
            this.tools.delete(key);
          }
        } else if (
          notification.method === 'item/completed' &&
          threadId === this.sessionRef &&
          item.type === 'agentMessage'
        ) {
          this.queue.push({ type: 'text', text: item.text });
        } else if (
          notification.method === 'item/completed' &&
          threadId === this.sessionRef &&
          item.type === 'contextCompaction'
        ) {
          this.queue.push({ type: 'compacted', summary: null });
        }
        return;
      }
      case 'thread/tokenUsage/updated': {
        const { threadId, tokenUsage } = notification.params;
        if (threadId === this.sessionRef && tokenUsage.modelContextWindow) {
          this.queue.push({ type: 'context', used: tokenUsage.last.inputTokens / tokenUsage.modelContextWindow });
        }
        return;
      }
      case 'account/rateLimits/updated':
        this.rateLimits = mergeRateLimits(this.rateLimits, notification.params.rateLimits);
        if (this.rateLimits)
          this.queue.push({ type: 'quota', accountId: this.accountId, quota: quotaFromRateLimits(this.rateLimits) });
        return;
      case 'warning':
        this.warn('warning', notification.params.message);
        return;
      case 'configWarning':
        this.warn(
          'configuration warning',
          [notification.params.summary, notification.params.details].filter(Boolean).join(': '),
        );
        return;
      case 'deprecationNotice':
        this.warn('deprecation', [notification.params.summary, notification.params.details].filter(Boolean).join(': '));
        return;
      case 'model/rerouted': {
        const { fromModel, toModel, reason } = notification.params;
        this.warn('model rerouted', `${fromModel} -> ${toModel} (${reason})`);
        return;
      }
    }
  }

  private turnState(id: string) {
    let state = this.turns.get(id);
    if (!state) {
      state = { started: false, toolCalls: 0, error: null };
      this.turns.set(id, state);
    }
    return state;
  }

  private turnCompleted(turn: Turn): void {
    if (turn.status === 'inProgress') return;
    this.endOpenTools((tool) => tool.mainTurn === turn.id);
    const state = this.turnState(turn.id);
    const error = turn.status === 'failed' ? (state.error ?? turn.error) : null;
    const errorKind = turn.status === 'failed' ? turnErrorKind(error?.codexErrorInfo ?? null, this.rateLimits) : null;
    this.turns.delete(turn.id);
    this.ownTurns.delete(turn.id);
    if (this.activeTurn === turn.id) this.activeTurn = null;
    if (this.compaction?.turnId === turn.id) {
      const toolCalls = this.compaction.toolCalls + state.toolCalls;
      this.compaction = null;
      if (turn.status === 'completed') {
        void this.startTurn(
          'System note: The context window filled up and was compacted. Continue your task where you left off.',
        ).catch((error) => {
          if (!this.gone) this.contextFailed(oneLine(error), toolCalls);
        });
      } else {
        // Only a second context error is the context outcome; an interrupt or another failure ends as itself (9.2).
        this.endTurn(turn.status, toolCalls, error, errorKind);
      }
      return;
    }
    // The final error or, without one, the failed turn's own error (design 9.2).
    if (error?.codexErrorInfo === 'contextWindowExceeded' && !this.recoveredContext) {
      this.recoveredContext = true;
      this.compaction = { turnId: null, toolCalls: state.toolCalls };
      void request(this.app, 'thread/compact/start', { threadId: this.sessionRef }).catch((error) => {
        const compaction = this.compaction;
        // A started compaction turn ends the recovery itself, and an exit reports the end on its own.
        if (!compaction || compaction.turnId !== null) return;
        this.compaction = null;
        if (!this.gone) this.contextFailed(oneLine(error), compaction.toolCalls);
      });
      return;
    }
    this.endTurn(turn.status, state.toolCalls, error, errorKind);
  }

  /**
   * Ends the open tools of a turn that has ended: a main turn's end also ends the child tools that count for it. An
   * interrupt with a command approval pending completes the turn without that command's item/completed.
   */
  private endOpenTools(ended: (tool: OpenTool) => boolean): void {
    for (const [key, tool] of this.tools) {
      if (!ended(tool)) continue;
      this.tools.delete(key);
      this.endedTools.add(key);
      this.queue.push({
        type: 'tool_ended',
        toolId: tool.toolId,
        ok: false,
        denied: false,
        terminal: null,
        hubUnreachable: false,
      });
    }
  }

  private endTurn(
    outcome: TurnEnded['outcome'],
    toolCalls: number,
    error: TurnError | null,
    errorKind: TurnEnded['errorKind'],
  ): void {
    const end = () => {
      if (errorKind === 'quota') this.pushExhausted();
      this.queue.push({ type: 'turn_ended', outcome, toolCalls, error: error?.message ?? null, errorKind });
    };
    if (errorKind !== 'quota' || (this.rateLimits && quotaFromRateLimits(this.rateLimits).resetsAt !== null)) {
      end();
      return;
    }
    // Without a known reset the hub would wait and probe; app-server can tell it now (design 9.2).
    this.ending = this.app.rpc
      .request('account/rateLimits/read', undefined)
      .then(
        ({ rateLimits }) => {
          this.rateLimits = mergeRateLimits(this.rateLimits, rateLimits);
        },
        () => {},
      )
      .then(() => {
        this.ending = null;
        end();
      });
  }

  private pushExhausted(): void {
    const quota = this.rateLimits
      ? quotaFromRateLimits(this.rateLimits)
      : {
          resetsAt: null,
          windows: { fiveHour: null, weekly: null },
          paidUsage: 'unknown' as const,
          updatedAt: Date.now(),
        };
    this.queue.push({ type: 'quota', accountId: this.accountId, quota: { ...quota, state: 'exhausted' } });
  }

  private async startTurn(...texts: string[]): Promise<void> {
    this.startingTurn = true;
    try {
      const { turn } = await request(this.app, 'turn/start', {
        threadId: this.sessionRef,
        input: texts.map((text) => ({ type: 'text', text, text_elements: [] })),
      });
      this.ownTurns.add(turn.id);
      this.activeTurn = turn.id;
    } finally {
      this.startingTurn = false;
    }
  }

  /** The transport is gone: a rejected request then reports nothing, since the exit does. */
  private get gone(): boolean {
    return this.app.rpc.closed;
  }

  private contextFailed(error: string, toolCalls: number): void {
    // Recovery hid the original end; expose one failure so the runner can replace the attempt.
    this.queue.push({ type: 'turn_ended', outcome: 'failed', toolCalls, error, errorKind: 'context' });
  }

  private warn(kind: string, text: string): void {
    this.queue.push({ type: 'warning', text: oneLine(`codex ${kind}: ${text}`) });
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
