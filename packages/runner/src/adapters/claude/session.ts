// A live Claude session, the AgentSession of the Claude adapter (design 8.2, 8.3, 8.4, 13). One query() reads one
// long-lived inbox, so the CLI's stdin stays open between turns; its frames go through the event mapper, and the
// compaction hooks add theirs. Sending pushes a user message with a fresh uuid, interrupting is the SDK's control
// request, and closing ends the inbox, after which the CLI exits once its turn is over. The guard is a PreToolUse
// hook of the options. Claude raises no approvals: a call the rules do not allow is denied at once.
import { randomUUID } from 'node:crypto';
import {
  type HookCallback,
  type Query,
  query,
  type SDKControlInitializeResponse,
  type SDKSystemMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { boundedWait } from '../../processes';
import type { AgentEvent, AgentLaunch, AgentSession, ExitInfo } from '../types';
import { ClaudeEventMapper } from './events';
import { ClaudeInbox } from './inbox';
import { isRecord } from './json';
import { buildQueryOptions, type ClaudeOptionDeps, ensureClaudeEmptyDir } from './options';
import type { QuotaBook } from './quota';
import { createDetachedSpawn, type SpawnedClaude } from './spawn';

/** The characters of stderr a crashed turn's error keeps, from the end. */
export const CLAUDE_CRASH_TAIL_CHARS = 4_000;

/** How long the rest of stderr is waited for after the exit: an escaped child that inherited it may hold it open. */
const STDERR_AFTER_EXIT_MS = 1_000;

export interface ClaudeSessionInput {
  launch: AgentLaunch;
  /** Everything buildQueryOptions needs except the session's own spawn hook and compaction callbacks. */
  deps: Omit<ClaudeOptionDeps, 'spawnClaudeCodeProcess' | 'compaction'>;
  /** Pushed before anything else: a new session's first prompt. A resumed session gets none. */
  firstPrompt: string | null;
  /** The account the session's quota events name. */
  accountId?: string | null;
  /** The adapter's last quota per account, shared by its sessions. */
  quota?: QuotaBook;
  /** The first-turn check (8.1): the problems of the session's first system/init, none when it matches. */
  checkInit?(init: SDKSystemMessage): string[];
}

/** The session's first system/init and what the first-turn check found in it. */
export interface FirstInit {
  init: SDKSystemMessage;
  problems: string[];
}

export class ClaudeSession implements AgentSession {
  readonly sessionRef: string;
  readonly events: AsyncIterable<AgentEvent>;
  readonly exited: Promise<ExitInfo>;
  /** Resolves with the first system/init, or with null when the session ends before one. */
  readonly firstInit: Promise<FirstInit | null>;

  private readonly inbox = new ClaudeInbox<SDKUserMessage>();
  private readonly queue = new ClaudeInbox<AgentEvent>();
  private readonly mapper: ClaudeEventMapper;
  private readonly query: Query;
  private readonly checkInit: (init: SDKSystemMessage) => string[];
  private readonly exit = Promise.withResolvers<ExitInfo>();
  private readonly first = Promise.withResolvers<FirstInit | null>();
  private proc: SpawnedClaude | null = null;
  private initSeen = false;
  /** The first-turn check failed: the session is being ended, and its frames are not mapped. */
  private refused = false;
  /** What frames before the first system/init gave; they follow its started. */
  private readonly early: AgentEvent[] = [];
  /**
   * The first prompt was pushed and no turn has started yet: the CLI may be starting one. A message sent later is
   * the mapper's to track, until the CLI starts or cancels it.
   */
  private firstTurnPending = false;

  /** Starts the CLI: the process is spawned, and registered, before this returns. */
  constructor(input: ClaudeSessionInput) {
    this.mapper = new ClaudeEventMapper({ accountId: input.accountId ?? null, quota: input.quota });
    this.checkInit = input.checkInit ?? (() => []);
    this.events = this.queue;
    this.exited = this.exit.promise;
    this.firstInit = this.first.promise;
    // Where the bridge and the brief hook start, and zsh's ZDOTDIR: it must be there before the CLI is.
    ensureClaudeEmptyDir(input.deps.vendorHomes.claude);
    const spawn = createDetachedSpawn({
      registerProcess: (pid) => input.launch.registerProcess(pid),
      logFile: input.launch.logFile,
      onSpawn: (proc) => {
        this.proc = proc;
        void proc.exited.then((exit) => this.exit.resolve(exit));
      },
    });
    const options = buildQueryOptions(input.launch, {
      ...input.deps,
      spawnClaudeCodeProcess: spawn,
      compaction: { preCompact: this.preCompact, postCompact: this.postCompact },
    });
    const sessionRef = options.resume ?? options.sessionId;
    if (sessionRef === undefined) throw new Error('the session options name no session');
    this.sessionRef = sessionRef;
    if (input.firstPrompt !== null) {
      this.pushUser(input.firstPrompt, randomUUID());
      this.firstTurnPending = true;
    }
    this.query = query({ prompt: this.inbox, options });
    void this.pump();
  }

  /** The CLI's pid; 0 when it could not be spawned (the session then ends at once). */
  get pid(): number {
    return this.proc?.pid ?? 0;
  }

  /** The CLI's answer to initialize: the account among others. Rejects when the CLI ends before it answers. */
  initialization(): Promise<SDKControlInitializeResponse> {
    return this.query.initializationResult();
  }

  /** The last lines the CLI wrote to stderr. */
  stderrTail(): string {
    return this.proc?.stderrTail() ?? '';
  }

  /** Resolves once stderr is read to its end, so stderrTail() holds all of it; bounded, as a child may hold it. */
  async stderrRead(): Promise<void> {
    if (this.proc !== null) await boundedWait(this.proc.stderrRead, STDERR_AFTER_EXIT_MS);
  }

  async send(message: { id: string; text: string; authority: 'person' | 'agent' | 'system' }): Promise<void> {
    if (this.inbox.ended) throw new Error('the Claude session is closed');
    const uuid = randomUUID();
    this.mapper.messageSent(uuid, message.id);
    this.pushUser(message.text, uuid);
  }

  /**
   * Plain, queued messages survive and run next (the hub's interrupt); with cancelQueued they are dropped too (a
   * stop). The SDK leaves that parameter untyped, so it is cast (8.3).
   */
  async interrupt(options: { cancelQueued?: boolean } = {}): Promise<void> {
    // Only a turn that runs, or is starting, gives the result an interrupt classifies: the mapper knows the turns and
    // the sent messages still queued, the session the first prompt.
    this.mapper.interruptRequested({ starting: this.firstTurnPending });
    const interrupt = this.query.interrupt as (options?: { cancelQueued?: boolean }) => Promise<unknown>;
    if (options.cancelQueued) await interrupt.call(this.query, { cancelQueued: true });
    else await interrupt.call(this.query);
  }

  /** Claude raises no approvals (permissionPrompts 'none'), so no request ever takes an answer. */
  async answerApproval(_id: string, _decision: 'approve' | 'decline', _reason: string | null): Promise<boolean> {
    return false;
  }

  /** Ends the input: the SDK closes the CLI's stdin once the running turn is over, and the CLI exits. */
  async close(): Promise<void> {
    this.inbox.end();
  }

  /**
   * Ends the session at once: the input, the SDK's side, and the CLI's process group with SIGTERM now. close() alone
   * would leave a running turn to go on until its stdin-EOF grace is over, and then signal the leader only.
   */
  terminate(): void {
    this.inbox.end();
    this.query.close();
    void this.proc?.signalGroup('SIGTERM');
  }

  /** SIGKILLs the CLI's process group: for a CLI that outlived terminate(). */
  kill(): void {
    void this.proc?.signalGroup('SIGKILL');
  }

  private pushUser(text: string, uuid: ReturnType<typeof randomUUID>): void {
    // No priority: the default folds it into a running turn at the next tool boundary (8.3).
    this.inbox.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, uuid });
  }

  private emit(event: AgentEvent): void {
    if (this.queue.ended) return;
    if (event.type === 'turn_started') this.firstTurnPending = false;
    this.queue.push(event);
  }

  private readonly preCompact: HookCallback = async (input) => {
    const trigger = input.hook_event_name === 'PreCompact' ? input.trigger : 'auto';
    this.emit({ type: 'warning', text: `Claude is compacting its context (${trigger})` });
    return {};
  };

  private readonly postCompact: HookCallback = async (input) => {
    if (input.hook_event_name === 'PostCompact') {
      this.emit({ type: 'compacted', summary: input.compact_summary || null });
    }
    return {};
  };

  /** Maps every frame until the SDK's stream ends, then waits for the exit and ends the events after it. */
  private async pump(): Promise<void> {
    try {
      for await (const frame of this.query) this.take(frame);
    } catch {
      // A crash or a kill ends the stream with an error; the exit and stderr say what happened.
    }
    if (this.proc === null) this.exit.resolve({ code: null, signal: null });
    const exit = await this.exited;
    await this.stderrRead();
    this.first.resolve(null);
    if (!this.refused) for (const event of this.early.splice(0)) this.emit(event);
    for (const event of this.mapper.ended(crashError(this.stderrTail(), exit))) this.emit(event);
    this.queue.end();
  }

  private take(frame: unknown): void {
    if (this.refused) return;
    const isInit = isRecord(frame) && frame.type === 'system' && frame.subtype === 'init';
    if (!this.initSeen && !isInit) {
      // Before the first system/init, such as a resumed session's first message starting: started comes first.
      this.early.push(...this.mapper.map(frame));
      return;
    }
    if (!this.initSeen) {
      this.initSeen = true;
      const init = frame as unknown as SDKSystemMessage;
      const problems = this.checkInit(init);
      this.first.resolve({ init, problems });
      if (problems.length > 0) {
        // A session that is not the one the options asked for does no work (X-29).
        this.refused = true;
        this.emit({ type: 'warning', text: `the session does not match its options: ${problems.join('; ')}` });
        this.terminate();
        return;
      }
      for (const event of [...this.mapper.map(frame), ...this.early.splice(0)]) this.emit(event);
      return;
    }
    for (const event of this.mapper.map(frame)) this.emit(event);
  }
}

/** A turn's error when the CLI ends inside it: the end of its stderr, then how it exited. */
function crashError(stderrTail: string, exit: ExitInfo): string {
  const tail = stderrTail.trim();
  const kept = tail.length > CLAUDE_CRASH_TAIL_CHARS ? `…${tail.slice(-(CLAUDE_CRASH_TAIL_CHARS - 1))}` : tail;
  const how =
    exit.signal !== null
      ? `claude was ended by ${exit.signal}`
      : exit.code !== null
        ? `claude exited with code ${exit.code}`
        : 'claude could not be started';
  return kept === '' ? how : `${kept}\n${how}`;
}
