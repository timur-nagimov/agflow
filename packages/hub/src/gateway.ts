// The hub side of runner links (design 6.3): one RunnerConnection per link, hello and welcome, the acknowledged
// position, and the commands that follow. The transport is the caller's: Bun's WebSocket handlers or an in-memory
// test connection hand the gateway a LinkSocket and every message and close they see.
import { CLOSE_CODES, type HubMessage, type RunnerMessage, parseRunnerMessage } from '@agflow/core';
import { slideSession } from './auth';
import { markSent, pendingCommands, toWireCommand } from './commands';
import { type HubContext, type RunnerLink, afterCommit, tx } from './context';
import { hubEpoch } from './hub-state';
import {
  type HelloMessage,
  checkRunnerIdentity,
  identifyRunner,
  markLinked,
  reconcileHelloSettings,
  recordHelloInfo,
} from './runners';

/** The close code for a link whose first message is not a readable hello (WebSocket "policy violation"). */
export const BAD_MESSAGE_CLOSE = 1008;
/** The close code when the hub fails while handling a hello (WebSocket "internal error"). */
export const HUB_ERROR_CLOSE = 1011;

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

  constructor(
    readonly socket: LinkSocket,
    readonly session: LinkSession,
    now: number,
  ) {
    this.lastInboundAt = now;
  }
}

export interface GatewayOptions {
  /** Where the gateway reports what it cannot hand back to a runner; console.error by default. */
  log?: (message: string, error?: unknown) => void;
}

/**
 * Raises the runner's acknowledged position for this outbox epoch to at least firstSeq − 1, creating the row for a
 * new epoch, and returns it: the runner replays every event after it that it still has.
 */
export function acknowledgePosition(ctx: HubContext, runnerId: string, outboxEpoch: string, firstSeq: number): number {
  const row = ctx.db
    .query(
      `INSERT INTO runner_inbox (runner_id, outbox_epoch, acked_seq) VALUES ($runnerId, $outboxEpoch, $floor)
       ON CONFLICT (runner_id, outbox_epoch) DO UPDATE SET acked_seq = MAX(acked_seq, excluded.acked_seq)
       RETURNING acked_seq`,
    )
    .get({ runnerId, outboxEpoch, floor: firstSeq - 1 }) as { acked_seq: number };
  return row.acked_seq;
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
    this.handle(connection, parsed.value);
  }

  /** Every inbound message keeps the link alive; hello is allowed only once. */
  private handle(connection: RunnerConnection, message: RunnerMessage): void {
    if (message.t === 'hello') this.close(connection, BAD_MESSAGE_CLOSE, 'hello was already received on this link');
  }

  /** The transport saw the link close. */
  closed(connection: RunnerConnection): void {
    this.drop(connection);
  }

  private firstMessage(connection: RunnerConnection, text: string): void {
    const parsed = parseRunnerMessage(text);
    if (!parsed.ok) {
      const envelope = parsed.hello;
      if (envelope) {
        // A newer runner's hello may be unreadable here: it still gets 4426, so it stops instead of retrying.
        const checked = tx(this.ctx, () => checkRunnerIdentity(this.ctx, connection.session.user, envelope));
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
   * Identifies the runner and records the hello in one transaction. The welcome goes out once it commits, before any
   * command that transaction queued: the attach step is queued first, so it runs before their flush.
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
        const welcome: { message: Welcome | null } = { message: null };
        afterCommit(ctx, () => this.attach(connection, runnerId, hello.protocol, welcome.message as Welcome));
        recordHelloInfo(ctx, runnerId, hello);
        reconcileHelloSettings(ctx, runnerId, hello.settings);
        slideSession(ctx, sessionHash);
        const ackedSeq = acknowledgePosition(ctx, runnerId, hello.outboxEpoch, hello.firstSeq);
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
          stop: [],
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

  /** Makes the link the runner's current one, replacing an older link with 4409, and sends welcome then commands. */
  private attach(connection: RunnerConnection, runnerId: string, protocol: number, welcome: Welcome): void {
    if (connection.closed) return;
    const previous = this.links.get(runnerId);
    if (previous && previous !== connection) this.close(previous, CLOSE_CODES.replaced, 'another connection replaced this one');
    connection.runnerId = runnerId;
    connection.protocol = protocol;
    this.links.set(runnerId, connection);
    this.send(connection, welcome);
    connection.welcomed = true;
    this.flush(runnerId);
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
    for (const message of messages) this.send(connection, message);
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

  private drop(connection: RunnerConnection): void {
    if (connection.closed) return;
    connection.closed = true;
    this.connections.delete(connection);
    if (connection.runnerId !== null && this.links.get(connection.runnerId) === connection) {
      this.links.delete(connection.runnerId);
    }
  }
}
