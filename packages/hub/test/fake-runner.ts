// FakeRunner, the one protocol test client (X-25): it speaks protocol 1 like a runner, with an outbox, hello with
// lastSeq, the replay after welcome, heartbeats and an answer for every command kind, but runs no agent. Hooks
// replace answers, react with events, and supply facts and acceptingUntil. Its transport is pluggable: an in-memory
// FakeConnection to a Gateway here, a WebSocket to a real hub server elsewhere.
import {
  type AccountQuotaReport,
  type AttemptFacts,
  type Fence,
  type HubMessage,
  type LiveAttempt,
  PROTOCOL_VERSION,
  type ProfileSummary,
  type RawRunnerEvent,
  type Runner,
  type RunnerCommand,
  type RunnerCommandKind,
  type RunnerEventData,
  type RunnerEventType,
  type RunnerMessage,
  type RunnerSettings,
  type RunnerVendor,
  type Vendor,
  parseHubMessage,
  parseRunnerMessage,
} from '@agflow/core';
import { sessionHashOf, verifySession } from '../src/auth';
import { type CommandResult, KEPT_ON_CANCEL } from '../src/commands';
import type { HubContext } from '../src/context';
import type { Gateway, LinkSocket, RunnerConnection } from '../src/gateway';
import { testVendor } from './helpers';

/** The runner's end of one link. */
export interface FakeRunnerTransport {
  send(text: string): void;
  /** The runner hangs up. */
  close(): void;
}

/** What a transport calls on the runner for its link. */
export interface FakeRunnerEndpoint {
  receive(text: string): void;
  closed(code: number, reason: string): void;
}

/** Opens one link: the transport delivers to the endpoint and gives back the runner's sending side. */
export type FakeRunnerDialer<T extends FakeRunnerTransport> = (endpoint: FakeRunnerEndpoint) => T;

/** Replaces a kind's default answer. It may emit events through the runner, as a real runner would. */
export type AnswerHook<K extends RunnerCommandKind> = (
  command: Extract<RunnerCommand, { kind: K }>,
  runner: FakeRunner,
) => CommandResult;

export type AnswerHooks = { [K in RunnerCommandKind]?: AnswerHook<K> };

export interface FakeRunnerOptions {
  runnerKey?: string;
  machineId?: string;
  name?: string;
  agflowVersion?: string;
  protocol?: number;
  /** darwin-arm64 by default. */
  platform?: string;
  /** The hub-confirmed snapshot hello reports. */
  settings?: Partial<RunnerSettings>;
  /** Ready test-mode vendors by default (design 15.1). */
  vendors?: (Vendor | RunnerVendor)[];
  /** The account quota hello reports; none by default. */
  quota?: () => AccountQuotaReport[];
  /** The standard profile with dependency prep by default. */
  profile?: ProfileSummary;
  /** Ready to push by default. */
  git?: () => Runner['git'];
  state?: 'ok' | 'crash_loop' | 'disk_low';
  stateDetail?: string | null;
  outboxEpoch?: string;
  /** The hub epoch of the last welcome, as runner.json keeps it. */
  lastHubEpoch?: number | null;
  /** The clock of event and heartbeat times. */
  now?: () => number;
  /** auto: a heartbeat every welcome.timings.heartbeatMs; manual (the default): only heartbeat() sends one. */
  heartbeats?: 'auto' | 'manual';
  answers?: AnswerHooks;
  /** The attempts hello reports. */
  attempts?: () => LiveAttempt[];
  /** The facts each heartbeat carries. */
  facts?: () => AttemptFacts[];
  /** Ms from now during which the runner takes no new attempt; null by default. */
  acceptingUntil?: () => number | null;
  power?: () => Runner['power'];
  disk?: () => Runner['disk'];
  /** Called with each agent token a start or resume brings. */
  onToken?: (attemptId: string, token: string) => void;
}

type CommandMessage = Extract<HubMessage, { t: 'command' }>;
type Welcome = Extract<HubMessage, { t: 'welcome' }>;

/** The answers a runner gives when nothing goes wrong. decide_approval reports the decision applied. */
function defaultAnswer(command: RunnerCommand, runner: FakeRunner): CommandResult {
  switch (command.kind) {
    case 'decide_approval':
      return { ok: true, data: { applied: true } };
    case 'update_settings':
      runner.settings = {
        ...runner.settings,
        ...command.settings,
        ceilings: { ...runner.settings.ceilings, ...command.settings.ceilings },
        allowPaidUsage: { ...runner.settings.allowPaidUsage, ...command.settings.allowPaidUsage },
        version: command.version,
      };
      return { ok: true };
    default:
      return { ok: true };
  }
}

/** The attempt a command is about, for the welcome.stop rule; preflight and the like are about none. */
function attemptOf(command: RunnerCommand): string | null {
  if (command.kind === 'start_attempt') return command.attempt.attemptId;
  return 'attemptId' in command ? command.attemptId : null;
}

export class FakeRunner<T extends FakeRunnerTransport = FakeRunnerTransport> {
  readonly runnerKey: string;
  readonly machineId: string;
  settings: RunnerSettings;
  outboxEpoch: string;
  lastHubEpoch: number | null;
  /** Events not yet acknowledged, oldest first. */
  outbox: RawRunnerEvent[] = [];
  private nextSeq = 1;
  /** The current link's transport, null when the runner is not connected. */
  transport: T | null = null;
  welcome: Welcome | null = null;
  /** Every message the hub sent, over every link. */
  readonly received: HubMessage[] = [];
  /** Each command's result, by command id, as the journal keeps it: a resent command gets the same answer. */
  readonly journal = new Map<string, CommandResult>();
  /** The newest agent token of each attempt. */
  readonly tokens = new Map<string, string>();
  /** Attempts welcome.stop named: their commands are answered attempt_ended, but for the kinds that outlive one. */
  readonly stopped = new Set<string>();
  /** How the last link closed. */
  closedWith: { code: number; reason: string } | null = null;
  private link = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private waiters: ((message: Welcome | null) => void)[] = [];

  constructor(
    private readonly dial: FakeRunnerDialer<T>,
    readonly options: FakeRunnerOptions = {},
  ) {
    this.runnerKey = options.runnerKey ?? 'runner-key-1';
    this.machineId = options.machineId ?? 'machine-1';
    this.outboxEpoch = options.outboxEpoch ?? 'outbox-1';
    this.lastHubEpoch = options.lastHubEpoch ?? null;
    this.settings = {
      capacity: 2,
      keepAwake: 'ac',
      draining: false,
      ceilings: {},
      allowPaidUsage: {},
      version: 0,
      ...options.settings,
    };
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  get connected(): boolean {
    return this.transport !== null;
  }

  /** Command messages received, oldest first. */
  get commands(): CommandMessage[] {
    return this.received.filter((message): message is CommandMessage => message.t === 'command');
  }

  /** The lowest seq the outbox keeps, and the highest; firstSeq − 1 when it is empty. */
  get firstSeq(): number {
    return this.outbox[0]?.seq ?? this.nextSeq;
  }

  get lastSeq(): number {
    return this.nextSeq - 1;
  }

  hello(): Extract<RunnerMessage, { t: 'hello' }> {
    const vendors = (this.options.vendors ?? ['claude', 'codex']).map((entry) =>
      typeof entry === 'string' ? testVendor(entry) : entry,
    );
    return {
      t: 'hello',
      protocol: this.options.protocol ?? PROTOCOL_VERSION,
      runnerKey: this.runnerKey,
      machineId: this.machineId,
      name: this.options.name ?? 'fake-runner',
      agflowVersion: this.options.agflowVersion ?? '0.2.0',
      platform: this.options.platform ?? 'darwin-arm64',
      settings: this.settings,
      vendors,
      quota: this.options.quota?.() ?? [],
      profile: this.options.profile ?? { name: 'standard', weakened: [], dependencyPrep: true },
      git: this.options.git?.() ?? { ready: true, problem: null, lastPushAt: null },
      state: this.options.state ?? 'ok',
      stateDetail: this.options.stateDetail ?? null,
      outboxEpoch: this.outboxEpoch,
      firstSeq: this.firstSeq,
      lastSeq: this.lastSeq,
      lastHubEpoch: this.lastHubEpoch,
      attempts: this.options.attempts?.() ?? [],
    };
  }

  /** Opens a link and sends hello; resolves with the welcome, or null when the hub closes the link instead. */
  connect(): Promise<Welcome | null> {
    if (this.transport) throw new Error('the fake runner is already connected');
    const link = ++this.link;
    this.welcome = null;
    this.closedWith = null;
    const current = () => link === this.link;
    this.transport = this.dial({
      receive: (text) => {
        if (current()) this.receive(text);
      },
      closed: (code, reason) => {
        if (current()) this.linkClosed(code, reason);
      },
    });
    const welcomed = new Promise<Welcome | null>((resolve) => this.waiters.push(resolve));
    this.sendMessage(this.hello());
    return welcomed;
  }

  /** Hangs up, as a runner does when it stops. */
  disconnect(): void {
    const transport = this.transport;
    this.linkClosed(1000, 'runner disconnected');
    transport?.close();
  }

  /** A new link, as after a lost connection: hello again and the replay. */
  reconnect(): Promise<Welcome | null> {
    if (this.transport) this.disconnect();
    return this.connect();
  }

  /** Sends a raw message on the current link, as a broken runner might. */
  sendRaw(text: string): void {
    this.transport?.send(text);
  }

  private sendMessage(message: RunnerMessage): void {
    this.transport?.send(JSON.stringify(message));
  }

  /** Adds an event to the outbox and sends it at once when the link is up. */
  emit<K extends RunnerEventType>(
    type: K,
    data: RunnerEventData[K],
    attempt?: { attemptId: string; fence: Fence },
  ): RawRunnerEvent {
    const event: RawRunnerEvent = { seq: this.nextSeq++, at: this.now(), type, ...attempt, data };
    this.outbox.push(event);
    if (this.welcome) this.sendMessage({ t: 'events', outboxEpoch: this.outboxEpoch, events: [event] });
    return event;
  }

  heartbeat(): void {
    this.sendMessage({
      t: 'heartbeat',
      at: this.now(),
      attempts: this.options.facts?.() ?? [],
      power: this.options.power?.() ?? { source: 'ac', batteryPercent: null, lowPowerMode: false },
      disk: this.options.disk?.() ?? { freeBytes: 100e9, agflowBytes: 0 },
      acceptingUntil: this.options.acceptingUntil?.() ?? null,
    });
  }

  private receive(text: string): void {
    const parsed = parseHubMessage(text);
    if (!parsed.ok) {
      // A command the runner cannot read is answered unsupported, as protocol 1 says.
      if (parsed.commandId) this.sendMessage({ t: 'result', commandId: parsed.commandId, ok: false, error: 'unsupported' });
      return;
    }
    const message = parsed.value;
    this.received.push(message);
    switch (message.t) {
      case 'welcome':
        this.welcomed(message);
        return;
      case 'ack':
        if (message.outboxEpoch === this.outboxEpoch) this.dropAcked(message.seq);
        return;
      case 'heartbeat_ack':
        return;
      case 'command':
        this.answer(message);
        return;
    }
  }

  private welcomed(welcome: Welcome): void {
    this.welcome = welcome;
    this.lastHubEpoch = welcome.hubEpoch;
    for (const stop of welcome.stop) this.stopped.add(stop.attemptId);
    this.dropAcked(welcome.ackedSeq);
    if (this.outbox.length > 0) this.sendMessage({ t: 'events', outboxEpoch: this.outboxEpoch, events: this.outbox });
    if (this.options.heartbeats === 'auto') {
      this.timer = setInterval(() => this.heartbeat(), welcome.timings.heartbeatMs);
    }
    for (const resolve of this.waiters.splice(0)) resolve(welcome);
  }

  private dropAcked(seq: number): void {
    this.outbox = this.outbox.filter((event) => event.seq > seq);
  }

  private answer(message: CommandMessage): void {
    const command = message.command;
    let result = this.journal.get(message.id);
    if (!result) {
      if (command.kind === 'start_attempt') this.keepToken(command.attempt.attemptId, command.attempt.agentToken);
      if (command.kind === 'resume_attempt') this.keepToken(command.attemptId, command.agentToken);
      const attemptId = attemptOf(command);
      // welcome.stop ends the fenced lifecycle commands; cleanup, transcript uploads and hand-backs come after an
      // attempt's end on purpose, as the hub keeps them when it cancels the rest.
      if (attemptId !== null && this.stopped.has(attemptId) && !KEPT_ON_CANCEL.includes(command.kind)) {
        result = { ok: false, error: 'attempt_ended' };
      } else {
        const hook = this.options.answers?.[command.kind] as AnswerHook<typeof command.kind> | undefined;
        result = hook ? hook(command as never, this as FakeRunner) : defaultAnswer(command, this as FakeRunner);
      }
      this.journal.set(message.id, result);
    }
    this.sendMessage({ t: 'result', commandId: message.id, ...result });
  }

  private keepToken(attemptId: string, token: string): void {
    this.tokens.set(attemptId, token);
    this.options.onToken?.(attemptId, token);
  }

  private linkClosed(code: number, reason: string): void {
    if (!this.transport) return;
    this.transport = null;
    this.closedWith = { code, reason };
    this.welcome = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const resolve of this.waiters.splice(0)) resolve(null);
  }
}

/**
 * An in-memory link between a FakeRunner and a Gateway. Each side's messages arrive in order on a later microtask,
 * as over a socket, so neither side runs inside the other's handler.
 */
export class FakeConnection implements FakeRunnerTransport {
  readonly connection: RunnerConnection;
  /** The hub's end, which the gateway sends on. */
  readonly socket: LinkSocket;
  /** Every message each side sent, parsed, oldest first. */
  readonly toHub: RunnerMessage[] = [];
  readonly toRunner: HubMessage[] = [];
  /** How the hub ended the link; terminate reads as 1006. */
  closedBy: { code: number; reason: string } | null = null;
  private down = false;

  constructor(
    private readonly gateway: Gateway,
    session: { user: string; sessionHash: string },
    private readonly endpoint: FakeRunnerEndpoint,
  ) {
    const hubSide: LinkSocket = {
      send: (text) => {
        if (this.down) return;
        const parsed = parseHubMessage(text);
        if (parsed.ok) this.toRunner.push(parsed.value);
        queueMicrotask(() => this.endpoint.receive(text));
      },
      close: (code, reason) => this.hubEnded(code, reason),
      terminate: () => this.hubEnded(1006, ''),
    };
    this.socket = hubSide;
    this.connection = gateway.open(hubSide, session);
  }

  get isDown(): boolean {
    return this.down;
  }

  send(text: string): void {
    if (this.down) return;
    const parsed = parseRunnerMessage(text);
    if (parsed.ok) this.toHub.push(parsed.value);
    queueMicrotask(() => this.gateway.message(this.connection, text));
  }

  close(): void {
    if (this.down) return;
    this.down = true;
    queueMicrotask(() => this.gateway.closed(this.connection));
  }

  private hubEnded(code: number, reason: string): void {
    if (this.down) return;
    this.down = true;
    this.closedBy = { code, reason };
    queueMicrotask(() => {
      this.endpoint.closed(code, reason);
      this.gateway.closed(this.connection);
    });
  }
}

/** Lets every queued delivery of the fake links run. */
export function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * A FakeRunner on in-memory links to the gateway, signed in with a CLI token as agflow runner is; it has said hello
 * and heard the hub's answer by the time this resolves.
 */
export async function connectFakeRunner(
  ctx: HubContext,
  gateway: Gateway,
  options: FakeRunnerOptions & { token: string },
): Promise<FakeRunner<FakeConnection>> {
  const session = verifySession(ctx, options.token);
  if (!session || session.kind !== 'cli') throw new Error('connectFakeRunner needs a CLI token');
  const link = { user: session.user, sessionHash: sessionHashOf(options.token) };
  const runner = new FakeRunner<FakeConnection>(
    (endpoint) => new FakeConnection(gateway, link, endpoint),
    { now: ctx.now, ...options },
  );
  await runner.connect();
  await settle();
  return runner;
}

/**
 * A FakeRunner's link to a real hub server: a WebSocket to /api/runner/ws with the CLI token, as a runner opens it.
 * What the runner sends before the socket opens waits for it, so connect() can send hello at once.
 */
export class WebSocketTransport implements FakeRunnerTransport {
  readonly socket: WebSocket;
  private readonly waiting: string[] = [];

  constructor(url: string, token: string, endpoint: FakeRunnerEndpoint) {
    const wsUrl = new URL('/api/runner/ws', url);
    wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    this.socket = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${token}` } });
    this.socket.addEventListener('open', () => {
      for (const text of this.waiting.splice(0)) this.socket.send(text);
    });
    this.socket.addEventListener('message', (event) => endpoint.receive(String(event.data)));
    this.socket.addEventListener('close', (event) => endpoint.closed(event.code, event.reason));
  }

  send(text: string): void {
    if (this.socket.readyState === WebSocket.CONNECTING) this.waiting.push(text);
    else if (this.socket.readyState === WebSocket.OPEN) this.socket.send(text);
  }

  close(): void {
    this.socket.close(1000, 'runner disconnected');
  }
}

/**
 * A FakeRunner linked to a hub server at url (startHub's HubServer.url) over a real WebSocket, signed in with a CLI
 * token as agflow runner is. It resolves once the runner has its welcome, or once the hub refused or closed the link.
 */
export async function connectFakeRunnerWs(
  url: string,
  options: FakeRunnerOptions & { token: string },
): Promise<FakeRunner<WebSocketTransport>> {
  const runner = new FakeRunner<WebSocketTransport>(
    (endpoint) => new WebSocketTransport(url, options.token, endpoint),
    options,
  );
  await runner.connect();
  return runner;
}
