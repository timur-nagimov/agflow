// startHub (design 13): the HTTP API, the web UI and the runner link on one port, the link through Bun's own
// WebSocket handlers. main.ts serves the hub with it; tests and the demo pass their own context. It checks the clock
// at start, as a tick does (design 6.14), and with dbLock keeps <db>.pid while it runs.
import type { Attempt, Message } from '@agflow/core';
import type { Server, ServerWebSocket } from 'bun';
import { sweepAuth } from './auth';
import { type HubContext, NO_RUNNER_LINK } from './context';
import { flushDeliveries, watchDeliveries } from './delivery';
import { Gateway, type LinkSession, type LinkSocket, type RunnerConnection } from './gateway';
import { createApp } from './http/app';
import { wakeHoldingLead } from './lead';
import { acquireDbLock, checkClock, releaseDbLock } from './recovery';
import { refreshNeedsLogin } from './runners';
import { Scheduler } from './scheduler';

export interface StartHubOptions {
  /** 0, the default, binds a free port; HubServer.url names it. */
  port?: number | undefined;
  /** 127.0.0.1 by default. */
  hostname?: string | undefined;
  /**
   * How the scheduler runs (X-26): 'auto' on its own timer, 'manual' created stopped, so that the caller ticks it or
   * starts it, false not at all (the default).
   */
  scheduler?: 'auto' | 'manual' | false | undefined;
  /**
   * Keep <db>.pid next to the database while the hub runs, and refuse to start while it names a live process (design
   * 6.14): a second hub or a restore would change the database under this one. False by default.
   */
  dbLock?: boolean | undefined;
  /**
   * The hub's own housekeeping, once per heartbeatMs: dead links are terminated, expired sign-ins removed, offline
   * runners whose session no longer verifies marked needs_login, and due deliveries flushed. Sent messages also flush
   * once their batch is due (watchDeliveries). True by default; tests that drive the clock themselves turn it off.
   */
  timers?: boolean | undefined;
}

export interface HubServer {
  /** The bound origin, such as http://127.0.0.1:43211. */
  url: string;
  gateway: Gateway;
  /** The scheduler the options asked for; null for scheduler: false. */
  scheduler: Scheduler | null;
  /**
   * Closes every runner link, stops the timers and the server. closeDatabase also checkpoints the WAL and closes the
   * database, as the hub process does on SIGTERM and SIGINT; the lock goes last, once nothing writes any more.
   */
  stop(options?: StopHubOptions): Promise<void>;
}

export interface StopHubOptions {
  closeDatabase?: boolean | undefined;
}

/** Folds the WAL into the database file and closes it, so that the files on disk are complete without the hub. */
export function closeDatabase(ctx: HubContext): void {
  ctx.db.run('PRAGMA wal_checkpoint(TRUNCATE)');
  ctx.db.close();
}

/** What each runner link's socket carries: its session from before the upgrade, then its gateway connection. */
interface LinkData {
  session: LinkSession;
  connection: RunnerConnection | null;
}

/** The most bytes a WebSocket close reason may hold (RFC 6455: 125 less the 2-byte code); Bun cuts at 123. */
const CLOSE_REASON_BYTES = 123;

/**
 * A close reason cut to fit, at a character boundary. Bun cuts a longer one by bytes, and a cut inside a multi-byte
 * character makes the client drop the frame as invalid UTF-8 (1003) and lose the hub's code.
 */
function closeReason(text: string): string {
  let out = '';
  let bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char);
    if (bytes + size > CLOSE_REASON_BYTES) break;
    bytes += size;
    out += char;
  }
  return out;
}

function linkSocket(ws: ServerWebSocket<LinkData>): LinkSocket {
  return {
    send: (text) => ws.send(text),
    close: (code, reason) => ws.close(code, closeReason(reason)),
    terminate: () => ws.terminate(),
  };
}

/** A holding runner lead's delivery is its wake-up (design 6.11). */
const leadWaker = (ctx: HubContext) => (attempt: Attempt, unread: readonly Message[]) =>
  wakeHoldingLead(ctx, attempt, unread);

/** Each duty in its own try, so one failing does not skip the others; the next round runs them all again. */
function housekeeping(ctx: HubContext, gateway: Gateway): void {
  const duties: [string, () => unknown][] = [
    ['the dead-link sweep', () => gateway.sweepDeadLinks()],
    ['the auth sweep', () => sweepAuth(ctx)],
    ['the needs_login refresh', () => refreshNeedsLogin(ctx)],
    ['the delivery flush', () => flushDeliveries(ctx, leadWaker(ctx))],
  ];
  for (const [name, duty] of duties) {
    try {
      duty();
    } catch (error) {
      console.error(`${name} failed`, error);
    }
  }
}

export function startHub(ctx: HubContext, options: StartHubOptions = {}): HubServer {
  const dbPath = ctx.db.filename;
  if (options.dbLock) acquireDbLock(dbPath);
  try {
    return serveHub(ctx, options);
  } catch (error) {
    if (options.dbLock) releaseDbLock(dbPath);
    throw error;
  }
}

function serveHub(ctx: HubContext, options: StartHubOptions): HubServer {
  const dbPath = ctx.db.filename;
  // Downtime before this start extends the leases and opens the recovery window before any runner can say hello.
  checkClock(ctx);
  const gateway = new Gateway(ctx);
  // The app is made before the server it upgrades links on, so it reaches the server through this binding.
  let upgrader: Server<LinkData> | undefined;
  const upgradeRunnerLink = (request: Request, session: LinkSession) =>
    upgrader?.upgrade(request, { data: { session, connection: null } }) ?? false;
  const app = createApp(ctx, { upgradeRunnerLink });
  const server = Bun.serve<LinkData>({
    hostname: options.hostname ?? '127.0.0.1',
    port: options.port ?? 0,
    idleTimeout: 120,
    fetch: app.fetch,
    websocket: {
      open(ws) {
        ws.data.connection = gateway.open(linkSocket(ws), ws.data.session);
      },
      message(ws, message) {
        const { connection } = ws.data;
        if (connection) gateway.message(connection, typeof message === 'string' ? message : message.toString('utf8'));
      },
      close(ws) {
        if (ws.data.connection) gateway.closed(ws.data.connection);
      },
    },
  });
  upgrader = server;
  const timers = options.timers ?? true;
  const timer = timers ? setInterval(() => housekeeping(ctx, gateway), ctx.config.heartbeatMs) : null;
  const stopDeliveries = timers ? watchDeliveries(ctx, leadWaker(ctx)) : null;
  const scheduler = options.scheduler ? new Scheduler(ctx) : null;
  if (options.scheduler === 'auto') scheduler?.start();
  return {
    url: server.url.origin,
    gateway,
    scheduler,
    async stop(stopOptions = {}) {
      scheduler?.stop();
      if (timer) clearInterval(timer);
      stopDeliveries?.();
      gateway.closeAll();
      if (ctx.link === gateway) ctx.link = NO_RUNNER_LINK;
      // The port closes at once. Its promise is not awaited: in Bun 1.3.11 it never settles once the server has
      // closed a WebSocket itself, as closeAll just did.
      void server.stop(true);
      if (stopOptions.closeDatabase) closeDatabase(ctx);
      if (options.dbLock) releaseDbLock(dbPath);
    },
  };
}
