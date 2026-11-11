// A scripted hub for runner tests: a Bun.serve WebSocket at /api/runner/ws that speaks the runner protocol. It checks
// the bearer token before the upgrade, validates every runner message with core's schemas (and every event with
// parseRunnerEvent), keeps acknowledged positions per outbox epoch as the hub does, and by default welcomes each
// hello, acknowledges each events message and answers each heartbeat. Tests script the rest through the connections.
// GET /api/runner/whoami answers the same token check over HTTP, as the hub's probe does; GET /api/status answers the
// project, when the test gives one.
import {
  AGFLOW_VERSION,
  type HubMessage,
  HubMessageSchema,
  parseRunnerEvent,
  PROTOCOL_VERSION,
  type RawRunnerEvent,
  type RunnerCommand,
  type RunnerMessage,
  RunnerMessageSchema,
} from '@agflow/core';
import type { ServerWebSocket } from 'bun';
import type { Outbox } from '../src/outbox';

export type WelcomeMessage = Extract<HubMessage, { t: 'welcome' }>;
export type HelloMessage = Extract<RunnerMessage, { t: 'hello' }>;
export type ResultMessage = Extract<RunnerMessage, { t: 'result' }>;

/** Fields over the default welcome, or false for no welcome. */
export type WelcomeFields = Partial<WelcomeMessage> | false;

export interface FakeHubOptions {
  /** The CLI token the hub accepts; any other bearer gets 401 before the upgrade. Unset: every bearer. */
  token?: string;
  /**
   * How a hello is answered: a welcome made of these fields over the defaults, or nothing (false), in which case
   * the test sends the welcome itself. A function decides per connection.
   */
  welcome?: WelcomeFields | ((hello: HelloMessage, connection: FakeConnection) => WelcomeFields);
  /** Acknowledge each events message cumulatively; true by default. */
  autoAck?: boolean;
  /** Answer each heartbeat with heartbeat_ack; true by default. */
  heartbeatAck?: boolean;
  /** Answer whoami with this status instead of the token check (a hub in trouble, say). */
  whoamiStatus?: number;
  /** GET /api/status: the project it names, or an HTTP status to fail with; 404 when unset. */
  status?: { name: string; repo: string } | number;
}

export interface FakeConnection {
  /** 0 for the first connection, then 1, 2 and so on. */
  index: number;
  authorization: string | null;
  /** The valid messages this connection sent, in order. */
  messages: RunnerMessage[];
  /** The close code and reason the hub saw (1006 for a terminated socket), or null while open. */
  closed: { code: number; reason: string } | null;
  send(message: HubMessage): void;
  /** Sends text as it is, valid or not. */
  sendRaw(text: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}

export interface FakeHub {
  /** The hub's http URL; the runner derives ws://.../api/runner/ws from it. */
  url: string;
  connections: FakeConnection[];
  /** Upgrades refused with 401 for a wrong bearer. */
  refusedUpgrades: number;
  /** The Authorization header of every whoami call, in order. */
  whoamiCalls: (string | null)[];
  /** Every message that failed core's schemas, with the reason. Tests expect it to stay empty. */
  invalid: { text: string; error: string }[];
  /** Every valid message of every connection, in arrival order. */
  messages(): RunnerMessage[];
  /** Every event of every events message, in arrival order (replays included). */
  events(): RawRunnerEvent[];
  /** The results received, by command id. */
  results: Map<string, ResultMessage>;
  /** The hub's acknowledged position for an outbox epoch. */
  ackedSeq(outboxEpoch: string): number;
  /** Sends a command on the newest connection with the next id; gives the id. */
  command(command: RunnerCommand): string;
  /** Resolves with the check's first truthy value; rejects after timeoutMs. */
  waitFor<T>(check: () => T | null | undefined | false, timeoutMs?: number): Promise<T>;
  /** Resolves with connection number index once it is open. */
  connection(index: number, timeoutMs?: number): Promise<FakeConnection>;
  stop(): void;
}

const HUB_EPOCH = 1;
const RUNNER_ID = 'R-1';

/** A schema-valid hello for the runner whose outbox this is. */
export function testHello(outbox: Outbox): HelloMessage {
  return {
    t: 'hello',
    protocol: PROTOCOL_VERSION,
    runnerKey: 'rk_test',
    machineId: 'MACHINE-1',
    name: 'laptop',
    agflowVersion: AGFLOW_VERSION,
    platform: 'darwin-arm64',
    settings: { capacity: 2, keepAwake: 'ac', draining: false, ceilings: {}, allowPaidUsage: {}, version: 1 },
    vendors: [],
    quota: [],
    profile: { name: 'standard', weakened: [], dependencyPrep: false },
    git: { ready: true, problem: null, lastPushAt: null },
    state: 'ok',
    stateDetail: null,
    outboxEpoch: outbox.epoch,
    firstSeq: outbox.firstSeq(),
    lastSeq: outbox.lastSeq(),
    lastHubEpoch: null,
    attempts: [],
  };
}

/** A schema-valid welcome with the fake hub's defaults, for tests that send one by hand. */
export function testWelcome(ackedSeq: number, fields: Partial<WelcomeMessage> = {}): WelcomeMessage {
  return { ...defaultWelcome(ackedSeq), ...fields };
}

function defaultWelcome(ackedSeq: number): WelcomeMessage {
  return {
    t: 'welcome',
    runnerId: RUNNER_ID,
    hubEpoch: HUB_EPOCH,
    hubTime: Date.now(),
    ackedSeq,
    wipRefPrefix: 'refs/agflow/',
    stop: [],
    timings: { heartbeatMs: 15_000, deadLinkMs: 45_000, handoffMs: 180_000, wipGraceMs: 300_000 },
  };
}

interface SocketData {
  connection: FakeConnection;
}

export function startFakeHub(options: FakeHubOptions = {}): FakeHub {
  const connections: FakeConnection[] = [];
  const invalid: { text: string; error: string }[] = [];
  const all: RunnerMessage[] = [];
  const events: RawRunnerEvent[] = [];
  const results = new Map<string, ResultMessage>();
  const acked = new Map<string, number>();
  const whoamiCalls: (string | null)[] = [];
  let refusedUpgrades = 0;
  let commandSeq = 0;

  const welcomeFor = (hello: HelloMessage, connection: FakeConnection): WelcomeMessage | null => {
    // Design 6.3: acked_seq = max(acked_seq, firstSeq - 1), kept per outbox epoch.
    const position = Math.max(acked.get(hello.outboxEpoch) ?? 0, hello.firstSeq - 1);
    acked.set(hello.outboxEpoch, position);
    const fields = typeof options.welcome === 'function' ? options.welcome(hello, connection) : options.welcome;
    if (fields === false) return null;
    return { ...defaultWelcome(position), ...fields };
  };

  const receive = (ws: ServerWebSocket<SocketData>, text: string) => {
    const { connection } = ws.data;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      invalid.push({ text, error: 'not JSON' });
      return;
    }
    const parsed = RunnerMessageSchema.safeParse(json);
    if (!parsed.success) {
      invalid.push({ text, error: parsed.error.message });
      return;
    }
    const message = parsed.data;
    connection.messages.push(message);
    all.push(message);
    switch (message.t) {
      case 'hello': {
        const welcome = welcomeFor(message, connection);
        if (welcome) connection.send(welcome);
        return;
      }
      case 'heartbeat':
        if (options.heartbeatAck === false) return;
        connection.send({ t: 'heartbeat_ack', at: message.at, hubTime: Date.now() });
        return;
      case 'events': {
        for (const event of message.events) {
          const check = parseRunnerEvent(event);
          if (!check.ok) invalid.push({ text: JSON.stringify(event), error: check.error });
          events.push(event);
        }
        const last = message.events.at(-1);
        if (last && options.autoAck !== false) {
          const position = Math.max(acked.get(message.outboxEpoch) ?? 0, last.seq);
          acked.set(message.outboxEpoch, position);
          connection.send({ t: 'ack', outboxEpoch: message.outboxEpoch, seq: position });
        }
        return;
      }
      case 'result':
        results.set(message.commandId, message);
        return;
    }
  };

  const server = Bun.serve<SocketData>({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, srv) {
      const path = new URL(request.url).pathname;
      const authorization = request.headers.get('authorization');
      const accepted = options.token === undefined || authorization === `Bearer ${options.token}`;
      if (path === '/api/runner/whoami') {
        whoamiCalls.push(authorization);
        if (options.whoamiStatus !== undefined) {
          return Response.json({ error: 'scripted' }, { status: options.whoamiStatus });
        }
        return accepted
          ? Response.json({ user: 'alice' })
          : Response.json({ error: 'unauthorized' }, { status: 401 });
      }
      if (path === '/api/status') {
        const status = options.status;
        if (!accepted) return Response.json({ error: 'unauthorized' }, { status: 401 });
        if (status === undefined || typeof status === 'number') {
          return Response.json({ error: 'scripted' }, { status: status ?? 404 });
        }
        return Response.json({ project: { ...status, paused: false, runnerLeads: false } });
      }
      if (path !== '/api/runner/ws') return new Response('not found', { status: 404 });
      if (!accepted) {
        refusedUpgrades += 1;
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }
      const connection: FakeConnection = {
        index: connections.length,
        authorization,
        messages: [],
        closed: null,
        send: () => {
          throw new Error('the connection is not open yet');
        },
        sendRaw: () => {
          throw new Error('the connection is not open yet');
        },
        close: () => {},
        terminate: () => {},
      };
      if (srv.upgrade(request, { data: { connection } })) return undefined;
      return new Response('upgrade failed', { status: 400 });
    },
    websocket: {
      open(ws) {
        const { connection } = ws.data;
        connection.sendRaw = (text) => {
          if (connection.closed === null) ws.send(text);
        };
        connection.send = (message) => {
          // A test that scripts an invalid hub message means to, and uses sendRaw.
          connection.sendRaw(JSON.stringify(HubMessageSchema.parse(message)));
        };
        connection.close = (code = 1000, reason = '') => ws.close(code, reason);
        connection.terminate = () => ws.terminate();
        connections.push(connection);
      },
      message(ws, data) {
        receive(ws, typeof data === 'string' ? data : new TextDecoder().decode(data));
      },
      close(ws, code, reason) {
        ws.data.connection.closed = { code, reason };
      },
    },
  });

  const waitFor = async <T>(check: () => T | null | undefined | false, timeoutMs = 15_000): Promise<T> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = check();
      if (value !== null && value !== undefined && value !== false) return value;
      if (Date.now() > deadline) throw new Error(`the fake hub waited ${timeoutMs} ms in vain`);
      await Bun.sleep(5);
    }
  };

  return {
    url: `http://127.0.0.1:${server.port}`,
    connections,
    get refusedUpgrades() {
      return refusedUpgrades;
    },
    whoamiCalls,
    invalid,
    results,
    messages: () => [...all],
    events: () => [...events],
    ackedSeq: (outboxEpoch) => acked.get(outboxEpoch) ?? 0,
    command(command) {
      const connection = connections.at(-1);
      if (!connection) throw new Error('no runner is connected');
      commandSeq += 1;
      const id = `${HUB_EPOCH}-${RUNNER_ID}-${commandSeq}`;
      connection.send({ t: 'command', id, seq: commandSeq, command });
      return id;
    },
    waitFor,
    connection: (index, timeoutMs) => waitFor(() => connections[index], timeoutMs),
    stop: () => server.stop(true),
  };
}
