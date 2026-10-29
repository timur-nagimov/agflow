// The runner link (design 6.3): one WebSocket to the hub's GET /api/runner/ws, opened with the CLI token. The runner
// says hello first; after welcome it replays its outbox from welcome.ackedSeq and then streams new events, sends
// heartbeats, and hands each command to the command handler, sending its result back. A link silent for deadLink is
// terminated, a handshake without welcome times out, and a dropped link reconnects with full-jitter backoff, or at
// once after a clock gap. canPushWip (design 7.3, X-11) reads welcomeSinceGap and lastAckAt from here.
import { type Credentials, type HubMessage, parseHubMessage, type RunnerMessage } from '@agflow/core';
import { Backoff } from './backoff';
import { type AwakeClock, type ClockGap, type ClockSource, systemClock } from './clock';
import type { RunnerTimings } from './config';
import type { CommandResult } from './journal';
import { type Logger, noopLogger } from './log';
import type { Outbox, StoredEvent } from './outbox';

/** Gives the CLI's credentials, or null when signed out (X-8; M2c reads credentials.json). */
export type CredentialsProvider = () => Credentials | null | Promise<Credentials | null>;

export type HelloMessage = Extract<RunnerMessage, { t: 'hello' }>;
export type HeartbeatContent = Omit<Extract<RunnerMessage, { t: 'heartbeat' }>, 't' | 'at'>;
export type WelcomeMessage = Extract<HubMessage, { t: 'welcome' }>;
export type CommandMessage = Extract<HubMessage, { t: 'command' }>;

/** idle before start; connecting until welcome; online after it; backoff between connections; closed for good. */
export type LinkState = 'idle' | 'connecting' | 'online' | 'backoff' | 'closed';

export interface LinkHandlers {
  /**
   * Each command, called at once and in arrival order; the result is sent when the promise settles (a rejection
   * answers ok false with its message). The executor decides what runs concurrently. Null answers nothing: the hub
   * keeps the command pending and sends it again after the next welcome.
   */
  onCommand(message: CommandMessage): Promise<CommandResult | null>;
  /** Each welcome, before any message that follows it is handled. */
  onWelcome?(welcome: WelcomeMessage): void;
  /** Each state change, with the close code and reason of the socket that ended (null and '' otherwise). */
  onState?(state: LinkState, detail: { code: number | null; reason: string }): void;
}

export interface LinkOptions {
  credentials: CredentialsProvider;
  /**
   * The hub this runner serves: the one its project key was derived from at start. While the CLI is signed in to
   * another hub (one credentials.json, switched by `agflow login --hub`), the link opens no socket and backs off.
   */
  hubUrl: string;
  outbox: Outbox;
  /** The awake clock: its gaps reconnect the link, and lastAckAt is read on it. */
  clock: AwakeClock;
  /** runner.json's timings; welcome.timings override heartbeat and deadLink. */
  timings: Pick<RunnerTimings, 'heartbeat' | 'deadLink' | 'handshake' | 'backoffBase' | 'backoffCap'>;
  /** Builds the hello sent first on every connection. */
  hello: () => HelloMessage | Promise<HelloMessage>;
  /** The content of each heartbeat: every live attempt's facts, power, disk and acceptingUntil. */
  heartbeat: () => HeartbeatContent;
  /**
   * Whether the hub has had an event already and must not apply it again: the replay leaves it out, as if sent. The
   * runtime names the settings edits a restored hub would apply twice (X-12). None when absent.
   */
  resent?: (event: StoredEvent) => boolean;
  handlers: LinkHandlers;
  logger?: Logger;
  /** Timers; the system's by default. */
  timers?: ClockSource;
  /** For the backoff's jitter. */
  random?: () => number;
}

/** The events of one message at most; a long replay goes out in several. */
const EVENT_BATCH = 100;

/**
 * The serialized events of one message at most, unless a single event is larger (the outbox caps those at
 * MAX_EVENT_BYTES), so no message nears the hub's 16 MB limit, which would close the link before every resend.
 */
export const MAX_EVENTS_MESSAGE_BYTES = 1024 * 1024;

/** Whether two hub URLs name one hub: the same origin and path, a trailing slash aside. */
export function sameHubUrl(a: string, b: string): boolean {
  const normal = (raw: string) => {
    const url = new URL(raw);
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  };
  try {
    return normal(a) === normal(b);
  } catch {
    return false;
  }
}

/** ws(s)://<hub>/api/runner/ws for the hub URL the CLI signed in to. */
export function hubWebSocketUrl(hubUrl: string): string {
  const url = new URL(hubUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`the hub URL must be http or https, not ${url.protocol}`);
  }
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/api/runner/ws`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class LinkClient {
  private readonly logger: Logger;
  private readonly timers: ClockSource;
  private readonly backoff: Backoff;
  private currentState: LinkState = 'idle';
  private socket: WebSocket | null = null;
  /** Counts connection attempts, so one overtaken while it read the credentials gives up. */
  private generation = 0;
  private lastWelcome: WelcomeMessage | null = null;
  private sinceGap = false;
  private ackAt: number | null = null;
  /** The highest seq sent on the current connection. */
  private sentSeq = 0;
  private reconnectTimer: unknown = null;
  private handshakeTimer: unknown = null;
  private deadTimer: unknown = null;
  private heartbeatTimer: unknown = null;
  private readonly unsubscribe: (() => void)[] = [];

  constructor(private readonly options: LinkOptions) {
    this.logger = options.logger ?? noopLogger;
    this.timers = options.timers ?? systemClock;
    this.backoff = new Backoff({
      base: options.timings.backoffBase,
      cap: options.timings.backoffCap,
      now: () => options.clock.awakeNow(),
      random: options.random,
    });
  }

  get state(): LinkState {
    return this.currentState;
  }

  /** The last welcome, kept across reconnects. */
  get welcome(): WelcomeMessage | null {
    return this.lastWelcome;
  }

  /**
   * Whether a welcome arrived since the last clock gap (canPushWip, X-11). It reads the clock first, so a gap that
   * nothing noticed yet (right after a wake, before the tick) already counts.
   */
  get welcomeSinceGap(): boolean {
    this.options.clock.awakeNow();
    return this.sinceGap;
  }

  /**
   * The awake time of the last heartbeat_ack or welcome, or null before the first (canPushWip, X-11). The grace age
   * is clock.awakeNow() - lastAckAt; reading it notices a pending gap, as welcomeSinceGap does.
   */
  get lastAckAt(): number | null {
    this.options.clock.awakeNow();
    return this.ackAt;
  }

  /** The heartbeat and dead-link intervals in force: the last welcome's, or runner.json's before any. */
  get timings(): { heartbeatMs: number; deadLinkMs: number } {
    const fromHub = this.lastWelcome?.timings;
    return {
      heartbeatMs: fromHub?.heartbeatMs ?? this.options.timings.heartbeat,
      deadLinkMs: fromHub?.deadLinkMs ?? this.options.timings.deadLink,
    };
  }

  start(): void {
    if (this.currentState !== 'idle') return;
    this.unsubscribe.push(
      this.options.outbox.onAppend(() => this.pump()),
      this.options.clock.onGap((gap) => this.onGap(gap)),
    );
    void this.connect();
  }

  /** Closes the link for good. */
  close(): void {
    if (this.currentState === 'closed') return;
    for (const stop of this.unsubscribe.splice(0)) stop();
    this.generation += 1;
    this.clearTimers();
    if (this.reconnectTimer !== null) this.timers.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, 'runner closing');
    this.setState('closed', { code: null, reason: '' });
  }

  private setState(state: LinkState, detail: { code: number | null; reason: string }): void {
    if (this.currentState === state) return;
    this.currentState = state;
    this.options.handlers.onState?.(state, detail);
  }

  private async connect(): Promise<void> {
    this.reconnectTimer = null;
    const generation = ++this.generation;
    this.setState('connecting', { code: null, reason: '' });
    let credentials: Credentials | null;
    try {
      credentials = await this.options.credentials();
    } catch (error) {
      this.logger.warn('cannot read the CLI credentials', { error: describe(error) });
      credentials = null;
    }
    if (generation !== this.generation || this.currentState !== 'connecting') return;
    if (!credentials) {
      this.logger.warn('not signed in to an agflow hub; run agflow login');
      this.scheduleReconnect({ code: null, reason: 'not signed in' });
      return;
    }
    // The CLI token of another hub never goes to this one, and this runner's hello and events never go to another.
    if (!sameHubUrl(credentials.hubUrl, this.options.hubUrl)) {
      this.logger.warn(`the CLI is signed in to ${credentials.hubUrl}; this runner serves ${this.options.hubUrl}`);
      this.scheduleReconnect({ code: null, reason: 'signed in to another hub' });
      return;
    }
    let socket: WebSocket;
    try {
      socket = new WebSocket(hubWebSocketUrl(credentials.hubUrl), {
        headers: { Authorization: `Bearer ${credentials.token}` },
      });
    } catch (error) {
      this.logger.warn('cannot open the hub link', { error: describe(error) });
      this.scheduleReconnect({ code: null, reason: describe(error) });
      return;
    }
    this.socket = socket;
    this.sentSeq = 0;
    // The handshake covers the upgrade and the welcome.
    this.handshakeTimer = this.timers.setTimeout(() => {
      if (this.socket !== socket) return;
      this.logger.warn('the hub sent no welcome in time; reconnecting', { ms: this.options.timings.handshake });
      this.terminate(socket, 'handshake timeout');
    }, this.options.timings.handshake);
    socket.addEventListener('open', () => void this.sendHello(socket));
    socket.addEventListener('message', (event) => this.receive(socket, event.data));
    socket.addEventListener('close', (event) => this.closed(socket, event.code, event.reason));
  }

  private async sendHello(socket: WebSocket): Promise<void> {
    try {
      const hello = await this.options.hello();
      if (this.socket === socket) socket.send(JSON.stringify(hello));
    } catch (error) {
      this.logger.error('cannot build the hello', { error: describe(error) });
      if (this.socket === socket) this.terminate(socket, 'no hello');
    }
  }

  /**
   * Ends a socket at once (terminate, not close: a dead peer would never answer a close frame) and goes on as if it
   * had closed, without waiting for its close event.
   */
  private terminate(socket: WebSocket, reason: string): void {
    // Closed first: terminate() may report its own close event at once, which would replace this reason.
    this.closed(socket, 1006, reason);
    socket.terminate();
  }

  private closed(socket: WebSocket, code: number, reason: string): void {
    // A gap that this close is the first to see reconnects at once (onGap replaces the socket), not after a backoff.
    this.options.clock.awakeNow();
    // A socket that a reconnect or close() already replaced has nothing more to say.
    if (this.socket !== socket) return;
    this.socket = null;
    this.clearTimers();
    this.backoff.disconnected();
    this.logger.info('the hub link closed', { code, reason });
    this.scheduleReconnect({ code, reason });
  }

  private scheduleReconnect(detail: { code: number | null; reason: string }): void {
    if (this.currentState === 'closed') return;
    this.setState('backoff', detail);
    const delay = this.backoff.next();
    this.reconnectTimer = this.timers.setTimeout(() => void this.connect(), delay);
  }

  /**
   * Ends the current connection at once and connects again, without a backoff (the runtime does after the welcome of
   * a restored hub, X-12). Called from onWelcome, it ends the connection before anything follows that welcome: no
   * event goes out on it and no later message of it is handled, and the welcome counts for nothing, so no WIP push
   * goes until the next one.
   */
  reconnectNow(reason: string): void {
    if (this.currentState === 'closed') return;
    this.logger.info('reconnecting at once', { reason });
    this.sinceGap = false;
    if (this.reconnectTimer !== null) this.timers.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    this.clearTimers();
    socket?.terminate();
    void this.connect();
  }

  /** A failed welcome's bookkeeping: drop this socket and retry with the normal backoff. */
  reconnectWithBackoff(reason: string): void {
    if (this.socket === null || this.currentState === 'closed') return;
    this.sinceGap = false;
    this.terminate(this.socket, reason);
  }

  /** A sleep or a freeze: no WIP push until the next welcome, and a new link at once. */
  private onGap(gap: ClockGap): void {
    if (this.currentState === 'closed') return;
    this.sinceGap = false;
    this.logger.info('the clock jumped; reconnecting', { gapMs: gap.ms });
    const socket = this.socket;
    this.socket = null;
    this.clearTimers();
    socket?.terminate();
    if (this.reconnectTimer !== null) this.timers.clearTimeout(this.reconnectTimer);
    this.backoff.disconnected();
    void this.connect();
  }

  private receive(socket: WebSocket, data: unknown): void {
    // A gap that this message is the first to see replaces the socket first, so a welcome or ack that waited out a
    // sleep is dropped with the socket it came on.
    this.options.clock.awakeNow();
    if (this.socket !== socket) return;
    // Any inbound message, readable or not, shows the link is alive.
    this.armDeadLink(socket);
    const text = typeof data === 'string' ? data : new TextDecoder().decode(data as ArrayBuffer);
    const parsed = parseHubMessage(text);
    if (!parsed.ok) {
      if (parsed.commandId !== null) {
        this.logger.warn('answered an unreadable command unsupported', {
          commandId: parsed.commandId,
          error: parsed.error,
        });
        this.send(socket, { t: 'result', commandId: parsed.commandId, ok: false, error: 'unsupported' });
      } else {
        this.logger.warn('ignored a malformed hub message', { error: parsed.error });
      }
      return;
    }
    const message = parsed.value;
    switch (message.t) {
      case 'welcome':
        this.welcomed(socket, message);
        return;
      case 'ack':
        this.acknowledge(message.outboxEpoch, message.seq);
        return;
      case 'heartbeat_ack':
        this.ackAt = this.options.clock.awakeNow();
        return;
      case 'command':
        this.runCommand(socket, message);
        return;
    }
  }

  private welcomed(socket: WebSocket, welcome: WelcomeMessage): void {
    if (this.handshakeTimer !== null) this.timers.clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
    this.lastWelcome = welcome;
    this.sinceGap = true;
    this.ackAt = this.options.clock.awakeNow();
    this.backoff.connected();
    // welcome.ackedSeq is the hub's acknowledged position for the outbox epoch this hello named.
    this.acknowledge(this.options.outbox.epoch, welcome.ackedSeq);
    this.sentSeq = welcome.ackedSeq;
    this.armDeadLink(socket);
    if (this.heartbeatTimer !== null) this.timers.clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = this.timers.setInterval(() => this.sendHeartbeat(socket), welcome.timings.heartbeatMs);
    this.setState('online', { code: null, reason: '' });
    try {
      this.options.handlers.onWelcome?.(welcome);
    } catch (error) {
      this.logger.error('cannot handle the welcome', { error: describe(error) });
    }
    this.pump();
  }

  /** A later ack or welcome repeats the hub's position if this local write fails. */
  private acknowledge(epoch: string, seq: number): void {
    try {
      this.options.outbox.ack(epoch, seq);
    } catch (error) {
      this.logger.error('cannot record the hub acknowledgement', { error: describe(error) });
    }
  }

  private runCommand(socket: WebSocket, message: CommandMessage): void {
    let pending: Promise<CommandResult | null>;
    try {
      pending = this.options.handlers.onCommand(message);
    } catch (error) {
      pending = Promise.reject(error);
    }
    pending
      .catch((error: unknown): CommandResult => {
        this.logger.error('a command failed', { commandId: message.id, error: describe(error) });
        return { ok: false, error: describe(error) };
      })
      // A result for a link that dropped meanwhile is lost; the hub resends the command and the journal answers it.
      .then((result) => {
        if (result !== null) this.send(socket, { t: 'result', commandId: message.id, ...result });
      });
  }

  private sendHeartbeat(socket: WebSocket): void {
    if (this.socket !== socket) return;
    let content: HeartbeatContent;
    try {
      content = this.options.heartbeat();
    } catch (error) {
      this.logger.error('cannot build the heartbeat', { error: describe(error) });
      return;
    }
    this.send(socket, { t: 'heartbeat', at: this.timers.now(), ...content });
  }

  /**
   * Sends every event after the last one sent, in seq order, while the link is online: at most EVENT_BATCH events
   * and MAX_EVENTS_MESSAGE_BYTES per message, and always at least one event. Events the hub has had (resent) are left
   * out; the cumulative ack of a later one covers them.
   */
  private pump(): void {
    const socket = this.socket;
    if (!socket || this.currentState !== 'online') return;
    const resent = this.options.resent;
    for (;;) {
      const candidates = this.options.outbox.eventsAfter(this.sentSeq, EVENT_BATCH);
      if (candidates.length === 0) return;
      const events: StoredEvent[] = [];
      // The last event sent or left out.
      let through = this.sentSeq;
      // The array's brackets, then each event's JSON and its separating comma.
      let bytes = 2;
      for (const event of candidates) {
        if (resent?.(event)) {
          through = event.seq;
          continue;
        }
        const size = Buffer.byteLength(JSON.stringify(event)) + 1;
        if (events.length > 0 && bytes + size > MAX_EVENTS_MESSAGE_BYTES) break;
        events.push(event);
        bytes += size;
        through = event.seq;
      }
      if (events.length > 0 && !this.send(socket, { t: 'events', outboxEpoch: this.options.outbox.epoch, events })) {
        return;
      }
      this.sentSeq = through;
    }
  }

  /** Sends on the socket if it is still the current, open one; gives whether it did. */
  private send(socket: WebSocket, message: RunnerMessage): boolean {
    if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }

  private armDeadLink(socket: WebSocket): void {
    if (this.lastWelcome === null || this.handshakeTimer !== null) return;
    if (this.deadTimer !== null) this.timers.clearTimeout(this.deadTimer);
    const { deadLinkMs } = this.timings;
    this.deadTimer = this.timers.setTimeout(() => {
      if (this.socket !== socket) return;
      this.logger.warn('nothing came from the hub in time; terminating the link', { ms: deadLinkMs });
      this.terminate(socket, 'dead link');
    }, deadLinkMs);
  }

  private clearTimers(): void {
    if (this.handshakeTimer !== null) this.timers.clearTimeout(this.handshakeTimer);
    if (this.deadTimer !== null) this.timers.clearTimeout(this.deadTimer);
    if (this.heartbeatTimer !== null) this.timers.clearInterval(this.heartbeatTimer);
    this.handshakeTimer = null;
    this.deadTimer = null;
    this.heartbeatTimer = null;
  }
}
