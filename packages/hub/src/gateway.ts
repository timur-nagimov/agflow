// The hub side of runner links (design 6.3): one RunnerConnection per link, hello and welcome, the acknowledged
// position and the replay, inbound events, and the commands that follow. The transport is the caller's: Bun's
// WebSocket handlers or an in-memory test connection hand the gateway a LinkSocket and every message and close.
import { CLOSE_CODES, type HubMessage, type RunnerMessage, parseRunnerMessage } from '@agflow/core';
import { markFactsStale, renewLeases } from './attempts';
import { slideSession } from './auth';
import { markSent, pendingCommands, recordResult, toWireCommand } from './commands';
import { type HubContext, type RunnerLink, afterCommit, tx } from './context';
import { acknowledgePosition, applyRunnerEvents } from './events-in';
import { hubEpoch } from './hub-state';
import { recordQuotaReports } from './quota';
import { isAfterRestore, reconcileAfterRestore, reconcileOnHello } from './recovery';
import {
  type HelloMessage,
  checkRunnerIdentity,
  identifyRunner,
  markLinked,
  markUnlinked,
  reconcileHelloSettings,
  recordHeartbeatInfo,
  recordHelloInfo,
  setRestorePending,
  unlinkAll,
} from './runners';

/** The close code for a link whose first message is not a readable hello (WebSocket "policy violation"). */
export const BAD_MESSAGE_CLOSE = 1008;
/**
 * The close code when the hub fails while handling a hello or an events message (WebSocket "internal error"): the
 * runner reconnects with its backoff.
 */
export const HUB_ERROR_CLOSE = 1011;
/** The close code when the hub stops (WebSocket "going away"): the runner reconnects with its backoff. */
export const GOING_AWAY_CLOSE = 1001;

/** The hub's end of one link, as the gateway uses it. */
export interface LinkSocket {
  send(text: string): void;
  close(code: number, reason: string): void;
  /** Drops the link without a closing handshake, which a dead link would never answer. */
  terminate(): void;
}

/** The CLI session a link authenticated with before it was opened. */
export interface LinkSession {
  user: string;
  sessionHash: string;
}

type Welcome = Extract<HubMessage, { t: 'welcome' }>;
type CommandMessage = Extract<HubMessage, { t: 'command' }>;

export class RunnerConnection {
  readonly id = crypto.randomUUID();
  /** The runner this link speaks for, once its hello passed. */
  runnerId: string | null = null;
  /** The protocol its hello spoke; commands newer than it are never sent. */
  protocol = 0;
  /** The welcome went out, so commands may follow. */
  welcomed = false;
  closed = false;
  /** By the context clock: the dead-link check reads it. */
  lastInboundAt: number;
  /** Commands sent on this link: a flush sends only the others. */
  readonly sent = new Set<string>();
  /** The outbox epoch and highest seq the hello reported: the replay is complete once the ack reaches lastSeq. */
  outboxEpoch: string | null = null;
  lastSeq = 0;
  /**
   * The hello came after a restore: its lastHubEpoch is below the hub's, or the runner's re-fences are still pending.
   * Until the replay is complete, a fence newer than an attempt's recorded one is current (X-1).
   */
  afterRestore = false;
  /** The replay reached hello.lastSeq. */
  replayed = false;
  /** Settles when the replay is complete; never on a link that closed first, whose next hello decides again. */
  readonly replayComplete: Promise<void>;
  private settleReplay: () => void = () => {};

  constructor(
    readonly socket: LinkSocket,
    readonly session: LinkSession,
    now: number,
  ) {
    this.lastInboundAt = now;
    this.replayComplete = new Promise((resolve) => {
      this.settleReplay = resolve;
    });
  }

  /** The acknowledged position of the hello's outbox epoch reached ackedSeq. */
  acknowledged(outboxEpoch: string, ackedSeq: number): void {
    if (this.closed || this.replayed || outboxEpoch !== this.outboxEpoch || ackedSeq < this.lastSeq) return;
    this.replayed = true;
    this.settleReplay();
  }
}

export interface GatewayOptions {
  /** Where the gateway reports what it cannot hand back to a runner; console.error by default. */
  log?: (message: string, error?: unknown) => void;
}

/**
 * The runner links of one hub. It installs itself as the context's RunnerLink, so commands queued in a transaction
 * reach a connected runner once that transaction commits.
 */
export class Gateway implements RunnerLink {
  /** Each runner's current link. */
  private readonly links = new Map<string, RunnerConnection>();
  /** Every open link, those still waiting for their hello included. */
  private readonly connections = new Set<RunnerConnection>();
  private readonly log: (message: string, error?: unknown) => void;

  constructor(
    readonly ctx: HubContext,
    options: GatewayOptions = {},
  ) {
    this.log = options.log ?? ((message, error) => console.error(message, error ?? ''));
    unlinkAll(ctx);
    ctx.link = this;
  }

  /** A new link, authenticated with a CLI session; its first message must be hello. */
  open(socket: LinkSocket, session: LinkSession): RunnerConnection {
    const connection = new RunnerConnection(socket, session, this.ctx.now());
    this.connections.add(connection);
    return connection;
  }

  /** The runner's current link, if it has one. */
  connectionOf(runnerId: string): RunnerConnection | null {
    return this.links.get(runnerId) ?? null;
  }

  message(connection: RunnerConnection, text: string): void {
    if (connection.closed) return;
    connection.lastInboundAt = this.ctx.now();
    if (connection.runnerId === null) {
      this.firstMessage(connection, text);
      return;
    }
    const parsed = parseRunnerMessage(text);
    if (!parsed.ok) {
      // Closing would only make the runner reconnect and send it again.
      this.log(`runner ${connection.runnerId} sent a message the hub cannot read: ${parsed.error}`);
      return;
    }
    try {
      this.handle(connection, parsed.value);
    } catch (error) {
      // The gateway is the boundary for runner input: a throw here would reach the transport, and in Bun's websocket
      // handlers end the hub. What was rolled back comes again: a pending command is resent after the next welcome.
      this.log(`handling ${parsed.value.t} from runner ${connection.runnerId} failed`, error);
    }
  }

  /** Every inbound message keeps the link alive; hello is allowed only once. */
  private handle(connection: RunnerConnection, message: RunnerMessage): void {
    const { ctx } = this;
    const runnerId = connection.runnerId as string;
    switch (message.t) {
      case 'hello':
        this.close(connection, BAD_MESSAGE_CLOSE, 'hello was already received on this link');
        return;
      case 'heartbeat':
        try {
          tx(ctx, (emit) => {
            recordHeartbeatInfo(ctx, runnerId, message);
            renewLeases(ctx, emit, runnerId, message.attempts);
          });
        } catch (error) {
          // The link is alive whatever the hub could store about it.
          this.log(`recording a heartbeat from runner ${runnerId} failed`, error);
        }
        this.send(connection, { t: 'heartbeat_ack', at: message.at, hubTime: ctx.now() });
        return;
      case 'result': {
        const { t: _, ...result } = message;
        const recorded = recordResult(ctx, runnerId, result);
        if (recorded?.kind === 'refresh_vault') this.flush(runnerId);
        return;
      }
      case 'events':
        this.events(connection, message);
        return;
    }
  }

  /**
   * Applies the events and acknowledges them, whatever each one came to (design 6.3). A message that fails as a whole
   * (applyRunnerEvents throws: the store failed outside the per-event savepoints, or the events skip some) applies
   * nothing, gets no ack, and ends the link with 1011. The runner never resends on the same link, as what it sent
   * moved on, so a later message's cumulative ack would cover the lost events. It reconnects with its backoff; its
   * hello and the welcome carry the acknowledged position, and it replays from there.
   */
  private events(connection: RunnerConnection, message: Extract<RunnerMessage, { t: 'events' }>): void {
    const runnerId = connection.runnerId as string;
    let acked: number;
    try {
      acked = applyRunnerEvents(this.ctx, runnerId, message, {
        restoreReplay: connection.afterRestore && !connection.replayed,
        helloLastSeq: message.outboxEpoch === connection.outboxEpoch ? connection.lastSeq : 0,
      });
    } catch (error) {
      // Closed at once: nothing that arrives on this link after the failure applies, so no ack passes the gap.
      this.log(`applying events from runner ${runnerId} failed`, error);
      this.close(connection, HUB_ERROR_CLOSE, 'the hub could not apply events');
      return;
    }
    this.send(connection, { t: 'ack', outboxEpoch: message.outboxEpoch, seq: acked });
    connection.acknowledged(message.outboxEpoch, acked);
  }

  /** The transport saw the link close. */
  closed(connection: RunnerConnection): void {
    this.drop(connection);
  }

  /**
   * Terminates every link with no inbound message for deadLinkMs by the context clock, those still waiting for their
   * hello included. A dead link would never answer a closing handshake, so none is attempted. Returns how many.
   */
  sweepDeadLinks(): number {
    const cutoff = this.ctx.now() - this.ctx.config.deadLinkMs;
    let terminated = 0;
    for (const connection of [...this.connections]) {
      if (connection.lastInboundAt > cutoff) continue;
      this.drop(connection);
      terminated += 1;
      try {
        connection.socket.terminate();
      } catch (error) {
        this.log(`terminating the link of runner ${connection.runnerId ?? '(no hello yet)'} failed`, error);
      }
    }
    return terminated;
  }

  private firstMessage(connection: RunnerConnection, text: string): void {
    const parsed = parseRunnerMessage(text);
    if (!parsed.ok) {
      const envelope = parsed.hello;
      if (envelope) {
        // A newer runner's hello may be unreadable here: it still gets 4426, so it stops instead of retrying.
        let checked: ReturnType<typeof checkRunnerIdentity>;
        try {
          checked = tx(this.ctx, () => checkRunnerIdentity(this.ctx, connection.session.user, envelope));
        } catch (error) {
          this.log(`hello from runner key ${envelope.runnerKey} failed`, error);
          this.close(connection, HUB_ERROR_CLOSE, 'the hub could not process hello');
          return;
        }
        if (!checked.ok) {
          this.close(connection, checked.code, checked.reason);
          return;
        }
      }
      this.close(connection, BAD_MESSAGE_CLOSE, `expected a hello: ${parsed.error}`);
      return;
    }
    if (parsed.value.t !== 'hello') {
      this.close(connection, BAD_MESSAGE_CLOSE, 'the first message must be hello');
      return;
    }
    this.hello(connection, parsed.value);
  }

  /**
   * Identifies the runner, records the hello and reconciles its attempts in one transaction. The welcome goes out once
   * it commits, before any command that transaction queued: the attach step is queued first, so it runs before their
   * flush. After a restore the runner is restore-pending until the attempts to re-fence get their new fences, once its
   * replay is complete; a link that drops before leaves it pending, and its next hello decides again.
   */
  private hello(connection: RunnerConnection, hello: HelloMessage): void {
    const { ctx } = this;
    const { user, sessionHash } = connection.session;
    let outcome: ReturnType<typeof identifyRunner>;
    try {
      outcome = tx(ctx, (emit) => {
        const identity = identifyRunner(ctx, user, hello);
        if (!identity.ok) return identity;
        const runnerId = identity.runner.id;
        const welcome: { message: Welcome | null; refence: string[] | null } = { message: null, refence: null };
        afterCommit(ctx, () => this.attach(connection, runnerId, hello, welcome.message as Welcome, welcome.refence));
        recordHelloInfo(ctx, runnerId, hello);
        recordQuotaReports(ctx, emit, runnerId, hello.quota);
        reconcileHelloSettings(ctx, runnerId, hello.settings, hello.protocol >= 2 ? hello : undefined);
        // Facts count only from the runner's current link.
        markFactsStale(ctx, runnerId);
        const ackedSeq = acknowledgePosition(ctx, runnerId, hello.outboxEpoch, hello.firstSeq);
        const replayPending = hello.lastSeq > ackedSeq;
        const afterRestore = isAfterRestore(ctx, runnerId, hello.lastHubEpoch);
        if (afterRestore) setRestorePending(ctx, runnerId, true);
        const { stop, actions } = reconcileOnHello(ctx, runnerId, hello, { replayPending, afterRestore });
        if (afterRestore) {
          welcome.refence = actions.filter((entry) => entry.action === 'refence').map((entry) => entry.attemptId);
        }
        slideSession(ctx, sessionHash);
        markLinked(ctx, emit, runnerId, {
          connectionId: connection.id,
          sessionHash,
          state: hello.state,
          stateDetail: hello.stateDetail,
        });
        welcome.message = {
          t: 'welcome',
          runnerId,
          hubEpoch: hubEpoch(ctx),
          hubTime: ctx.now(),
          ackedSeq,
          wipRefPrefix: ctx.config.wipRefPrefix,
          stop,
          timings: {
            heartbeatMs: ctx.config.heartbeatMs,
            deadLinkMs: ctx.config.deadLinkMs,
            handoffMs: ctx.config.handoffMs,
            wipGraceMs: ctx.config.wipGraceMs,
          },
        };
        return identity;
      });
    } catch (error) {
      this.log(`hello from runner key ${hello.runnerKey} failed`, error);
      this.close(connection, HUB_ERROR_CLOSE, 'the hub could not process hello');
      return;
    }
    if (!outcome.ok) this.close(connection, outcome.code, outcome.reason);
  }

  /**
   * Makes the link the runner's current one, replacing an older link with 4409, and sends welcome then commands. With
   * nothing to replay, the replay is complete at once. After a restore (refence not null), the re-fences follow the
   * replay.
   */
  private attach(
    connection: RunnerConnection,
    runnerId: string,
    hello: HelloMessage,
    welcome: Welcome,
    refence: string[] | null,
  ): void {
    if (connection.closed) return;
    const previous = this.links.get(runnerId);
    if (previous && previous !== connection) this.close(previous, CLOSE_CODES.replaced, 'another connection replaced this one');
    connection.runnerId = runnerId;
    connection.protocol = hello.protocol;
    connection.outboxEpoch = hello.outboxEpoch;
    connection.lastSeq = hello.lastSeq;
    connection.afterRestore = refence !== null;
    this.links.set(runnerId, connection);
    this.send(connection, welcome);
    connection.welcomed = true;
    connection.acknowledged(hello.outboxEpoch, welcome.ackedSeq);
    this.flush(runnerId);
    if (refence !== null) void connection.replayComplete.then(() => this.afterReplay(connection, runnerId, refence));
  }

  /** The replay after a restore is complete: the re-fences run, while the link is still the runner's current one. */
  private afterReplay(connection: RunnerConnection, runnerId: string, refence: string[]): void {
    if (connection.closed || this.links.get(runnerId) !== connection) return;
    try {
      reconcileAfterRestore(this.ctx, runnerId, refence);
    } catch (error) {
      // The runner stays restore-pending, so its next hello decides again.
      this.log(`re-fencing the attempts of runner ${runnerId} after the restore failed`, error);
    }
  }

  /**
   * Sends the runner the pending commands its current link has not had yet, in seq order. A command that cannot be
   * built stops the flush there: the ones before it still go out, the ones after it wait, so the order holds.
   */
  flush(runnerId: string): void {
    const connection = this.links.get(runnerId);
    if (!connection || !connection.welcomed || connection.closed) return;
    const { ctx } = this;
    const messages = tx(ctx, () => {
      const built: CommandMessage[] = [];
      for (const row of pendingCommands(ctx, runnerId, connection.protocol)) {
        if (connection.sent.has(row.id)) continue;
        try {
          // A savepoint per command, so a failing one leaves the earlier ones' writes standing.
          built.push(
            tx(ctx, () => {
              markSent(ctx, row.id);
              return toWireCommand(ctx, row);
            }),
          );
        } catch (error) {
          this.log(`building command ${row.id} for runner ${runnerId} failed`, error);
          break;
        }
      }
      return built;
    });
    // Only after the commit: a rolled-back flush must leave its commands to the next one.
    for (const message of messages) connection.sent.add(message.id);
    for (const message of messages) {
      // Protocol 1 schemas reject unknown keys. Keep the hub-first upgrade window usable.
      if (connection.protocol < 2 && message.command.kind === 'update_settings') {
        const { answers: _answers, ...command } = message.command;
        this.send(connection, { ...message, command });
      } else this.send(connection, message);
    }
  }

  /** Ends the runner's current link from the hub's side, as retiring the runner does. */
  closeRunner(runnerId: string, code: number, reason: string): void {
    const connection = this.links.get(runnerId);
    if (connection) this.close(connection, code, reason);
  }

  private send(connection: RunnerConnection, message: HubMessage): void {
    try {
      connection.socket.send(JSON.stringify(message));
    } catch (error) {
      this.log(`sending ${message.t} to runner ${connection.runnerId ?? '(no hello yet)'} failed`, error);
    }
  }

  /** Closes every link, those still waiting for their hello included: the hub is stopping ("going away"). */
  closeAll(): void {
    for (const connection of [...this.connections]) this.close(connection, GOING_AWAY_CLOSE, 'the hub is stopping');
  }

  /** Ends the link from the hub's side. */
  close(connection: RunnerConnection, code: number, reason: string): void {
    if (connection.closed) return;
    this.drop(connection);
    try {
      connection.socket.close(code, reason);
    } catch (error) {
      this.log(`closing the link of runner ${connection.runnerId ?? '(no hello yet)'} failed`, error);
    }
  }

  /**
   * Forgets the link; when it was the runner's current link, the runner goes offline (or needs_login) and its facts
   * are no longer fresh.
   */
  private drop(connection: RunnerConnection): void {
    if (connection.closed) return;
    connection.closed = true;
    this.connections.delete(connection);
    const runnerId = connection.runnerId;
    if (runnerId === null || this.links.get(runnerId) !== connection) return;
    this.links.delete(runnerId);
    try {
      // A replaced link's runner already names its new link, so only the current one marks it offline. An unheard
      // runner's attempts are judged only by their leases, so what it reported is no longer fresh (design 6.8).
      tx(this.ctx, (emit) => {
        if (markUnlinked(this.ctx, emit, runnerId, connection.id)) markFactsStale(this.ctx, runnerId);
      });
    } catch (error) {
      this.log(`marking runner ${runnerId} offline failed`, error);
    }
  }
}
