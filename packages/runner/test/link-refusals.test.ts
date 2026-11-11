import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLOSE_CODES,
  type Credentials,
  TRANSCRIPT_TAIL_MAX_BYTES,
  TranscriptInputSchema,
} from '@agflow/core';
import { AwakeClock, type ClockSource, systemClock } from '../src/clock';
import { openRunnerDb } from '../src/db';
import { clipTranscriptTail, RunnerHttpError, RunnerHubHttp } from '../src/hub-http';
import { LinkClient, type LinkHandlers, type LinkOptions, type LinkState } from '../src/link';
import { memoryLogger } from '../src/log';
import { Outbox } from '../src/outbox';
import { type FakeHub, type FakeHubOptions, startFakeHub, testHello } from './fake-hub';

// Each test serves a hub over real sockets, which take several times as long on a machine loaded by other suites.
setDefaultTimeout(30_000);

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const TOKEN = 'cli_secret_token';

/** Wall time the test can move forward, so the awake clock sees a sleep; timers stay real. */
class ShiftedClock implements ClockSource {
  offset = 0;
  now = (): number => Date.now() + this.offset;
  setTimeout = systemClock.setTimeout;
  clearTimeout = systemClock.clearTimeout;
  setInterval = systemClock.setInterval;
  clearInterval = systemClock.clearInterval;
}

interface Calls {
  states: LinkState[];
  needsLogin: number;
  replaced: string[];
  refused: string[];
  incompatible: string[];
}

interface Setup {
  hub: FakeHub;
  link: LinkClient;
  calls: Calls;
  wall: ShiftedClock;
  clock: AwakeClock;
  /** What the credentials provider returns; a test swaps it as `agflow login` would. */
  credentials: { current: Credentials | null };
}

function setup(
  hubOptions: FakeHubOptions = {},
  options: { token?: string; timings?: Partial<LinkOptions['timings']>; handlers?: Partial<LinkHandlers> } = {},
): Setup {
  const hub = startFakeHub({ token: TOKEN, ...hubOptions });
  cleanups.push(() => hub.stop());
  const dir = mkdtempSync(join(tmpdir(), 'agflow-refusals-'));
  const db = openRunnerDb(join(dir, 'runner.db'));
  cleanups.push(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const outbox = new Outbox(db);
  const wall = new ShiftedClock();
  const clock = new AwakeClock({ source: wall, gapMs: 5_000 });
  const calls: Calls = { states: [], needsLogin: 0, replaced: [], refused: [], incompatible: [] };
  const signedIn: Credentials = { hubUrl: hub.url, token: options.token ?? TOKEN, user: 'alice' };
  const credentials: { current: Credentials | null } = { current: signedIn };
  const link = new LinkClient({
    credentials: () => credentials.current,
    hubUrl: hub.url,
    outbox,
    clock,
    logger: memoryLogger(),
    random: () => 0,
    timings: {
      heartbeat: 10_000,
      deadLink: 10_000,
      handshake: 10_000,
      backoffBase: 10,
      backoffCap: 20,
      loginProbe: 60,
      ...options.timings,
    },
    hello: () => testHello(outbox),
    heartbeat: () => ({ attempts: [], power: null, disk: null, acceptingUntil: null }),
    handlers: {
      onCommand: async () => ({ ok: true }),
      onState: (state) => calls.states.push(state),
      onNeedsLogin: () => {
        calls.needsLogin += 1;
      },
      onReplaced: (reason) => calls.replaced.push(reason),
      onRefused: (reason) => calls.refused.push(reason),
      onIncompatible: (reason) => calls.incompatible.push(reason),
      ...options.handlers,
    },
  });
  cleanups.push(() => link.close());
  link.start();
  return { hub, link, calls, wall, clock, credentials };
}

describe('a refused upgrade', () => {
  test('whoami 401 enters needs_login and stops reconnecting; after agflow login a probe reconnects', async () => {
    const { hub, link, calls, credentials } = setup({}, { token: 'expired_token' });
    await hub.waitFor(() => link.state === 'needs_login');
    expect(calls.needsLogin).toBe(1);
    expect(hub.whoamiCalls[0]).toBe('Bearer expired_token');
    // Probes go on every loginProbe; the link itself is not tried again.
    await hub.waitFor(() => hub.whoamiCalls.length >= 4);
    expect(hub.refusedUpgrades).toBe(1);
    expect(hub.connections).toHaveLength(0);
    expect(link.state).toBe('needs_login');
    credentials.current = { hubUrl: hub.url, token: TOKEN, user: 'alice' };
    const connection = await hub.connection(0);
    await hub.waitFor(() => link.state === 'online');
    expect(connection.authorization).toBe(`Bearer ${TOKEN}`);
    expect(hub.whoamiCalls.at(-1)).toBe(`Bearer ${TOKEN}`);
    expect(hub.refusedUpgrades).toBe(1);
    expect(calls.needsLogin).toBe(1);
    expect(calls.states).toEqual(['connecting', 'needs_login', 'connecting', 'online']);
  });

  test('a CLI without credentials enters needs_login once and connects when they appear', async () => {
    const { hub, link, calls, credentials } = setup();
    credentials.current = null;
    await hub.waitFor(() => link.state === 'online');
    hub.connections[0]?.terminate();
    await hub.waitFor(() => link.state === 'needs_login');
    // Probes go on without credentials; none reaches the hub, and onNeedsLogin is not repeated.
    await Bun.sleep(200);
    expect(calls.needsLogin).toBe(1);
    expect(hub.whoamiCalls).toEqual([]);
    expect(hub.connections).toHaveLength(1);
    credentials.current = { hubUrl: hub.url, token: TOKEN, user: 'alice' };
    await hub.connection(1);
    await hub.waitFor(() => link.state === 'online');
    expect(calls.needsLogin).toBe(1);
  });

  test('credentials for another hub enter needs_login, and the token never goes to either hub', async () => {
    const other = startFakeHub({ token: 'other_token' });
    cleanups.push(() => other.stop());
    const { hub, link, calls, credentials } = setup();
    await hub.waitFor(() => link.state === 'online');
    credentials.current = { hubUrl: other.url, token: 'other_token', user: 'alice' };
    hub.connections[0]?.terminate();
    await hub.waitFor(() => link.state === 'needs_login');
    await Bun.sleep(200);
    expect(calls.needsLogin).toBe(1);
    expect(other.connections).toHaveLength(0);
    expect(other.whoamiCalls).toEqual([]);
    expect(hub.whoamiCalls).toEqual([]);
    credentials.current = { hubUrl: hub.url, token: TOKEN, user: 'alice' };
    await hub.connection(1);
    await hub.waitFor(() => link.state === 'online');
  });

  test('any other whoami answer backs off and tries the link again', async () => {
    const { hub, link, calls } = setup({ whoamiStatus: 503 }, { token: 'expired_token' });
    await hub.waitFor(() => hub.refusedUpgrades >= 3);
    expect(hub.whoamiCalls.length).toBeGreaterThanOrEqual(2);
    expect(calls.needsLogin).toBe(0);
    expect(calls.states).not.toContain('needs_login');
    expect(calls.states.slice(0, 3)).toEqual(['connecting', 'backoff', 'connecting']);
    expect(['connecting', 'backoff']).toContain(link.state);
  });

  test('a hub that cannot be reached backs off without entering needs_login', async () => {
    const { hub, link, calls } = setup();
    await hub.waitFor(() => link.state === 'online');
    hub.stop();
    await Bun.sleep(150);
    expect(calls.needsLogin).toBe(0);
    expect(['connecting', 'backoff']).toContain(link.state);
  });

  test('a clock gap in needs_login probes at once instead of trying the link', async () => {
    const { hub, link, wall, clock, credentials } = setup(
      {},
      { token: 'expired_token', timings: { loginProbe: 60_000 } },
    );
    await hub.waitFor(() => link.state === 'needs_login');
    const probes = hub.whoamiCalls.length;
    credentials.current = { hubUrl: hub.url, token: TOKEN, user: 'alice' };
    wall.offset += 60_000;
    clock.awakeNow();
    await hub.waitFor(() => link.state === 'online', 2_000);
    expect(hub.whoamiCalls.length).toBe(probes + 1);
    expect(hub.refusedUpgrades).toBe(1);
  });
});

describe('close codes', () => {
  test('4409 on the current socket calls onReplaced and closes the link for good', async () => {
    const { hub, link, calls } = setup();
    await hub.waitFor(() => link.state === 'online');
    (await hub.connection(0)).close(CLOSE_CODES.replaced, 'replaced by a newer connection');
    await hub.waitFor(() => link.state === 'closed');
    expect(calls.replaced).toEqual(['replaced by a newer connection']);
    await Bun.sleep(100);
    expect(hub.connections).toHaveLength(1);
  });

  test('a 4409 on a socket that a reconnect already replaced is ignored', async () => {
    // Records every socket the link opens, so the replaced one can be handed a 4409 after the link moved on.
    const sockets: WebSocket[] = [];
    const RealWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = class extends RealWebSocket {
      constructor(...args: ConstructorParameters<typeof WebSocket>) {
        super(...args);
        sockets.push(this);
      }
    } as typeof WebSocket;
    cleanups.push(() => {
      globalThis.WebSocket = RealWebSocket;
    });
    const { hub, link, calls, wall, clock } = setup();
    await hub.waitFor(() => link.state === 'online');
    wall.offset += 60_000;
    clock.awakeNow();
    await hub.connection(1);
    await hub.waitFor(() => link.state === 'online' && sockets.length === 2);
    sockets[0]?.dispatchEvent(
      new CloseEvent('close', { code: CLOSE_CODES.replaced, reason: 'replaced by a newer connection' }),
    );
    await Bun.sleep(100);
    expect(calls.replaced).toEqual([]);
    expect(link.state).toBe('online');
    expect(hub.connections).toHaveLength(2);
  });

  test("4403 calls onRefused with the hub's reason and never reconnects", async () => {
    const reason = 'this runner was retired; run agflow runner setup';
    const { hub, link, calls } = setup({
      welcome: (_hello, connection) => {
        connection.close(CLOSE_CODES.refused, reason);
        return false;
      },
    });
    await hub.waitFor(() => link.state === 'closed');
    expect(calls.refused).toEqual([reason]);
    expect(calls.states.at(-1)).toBe('closed');
    await Bun.sleep(100);
    expect(hub.connections).toHaveLength(1);
    expect(hub.whoamiCalls).toEqual([]);
  });

  test('4426 calls onIncompatible and never reconnects', async () => {
    const { hub, link, calls } = setup({
      welcome: (_hello, connection) => {
        connection.close(CLOSE_CODES.incompatible, 'protocol 1 is no longer supported; the minimum is 2');
        return false;
      },
    });
    await hub.waitFor(() => link.state === 'closed');
    expect(calls.incompatible).toEqual(['protocol 1 is no longer supported; the minimum is 2']);
    expect(calls.refused).toEqual([]);
    await Bun.sleep(100);
    expect(hub.connections).toHaveLength(1);
  });
});

interface Recorded {
  method: string;
  path: string;
  authorization: string | null;
  body: unknown;
}

/** A hub of scripted HTTP answers that records every request. */
function httpHub(answer: (request: Recorded) => Response) {
  const requests: Recorded[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const text = await request.text();
      const recorded: Recorded = {
        method: request.method,
        path: new URL(request.url).pathname,
        authorization: request.headers.get('authorization'),
        body: text ? JSON.parse(text) : null,
      };
      requests.push(recorded);
      return answer(recorded);
    },
  });
  cleanups.push(() => server.stop(true));
  const url = `http://127.0.0.1:${server.port}`;
  const http = new RunnerHubHttp({ credentials: () => ({ hubUrl: `${url}/`, token: TOKEN, user: 'alice' }) });
  return { requests, http, url };
}

describe('RunnerHubHttp', () => {
  test('whoami returns the user, and a refused token is a 401 error', async () => {
    const { http, requests } = httpHub(() => Response.json({ user: 'alice' }));
    expect(await http.whoami()).toEqual({ user: 'alice' });
    expect(requests).toEqual([
      { method: 'GET', path: '/api/runner/whoami', authorization: `Bearer ${TOKEN}`, body: null },
    ]);
    const refused = httpHub(() => Response.json({ error: 'unauthorized' }, { status: 401 })).http;
    const error = await refused.whoami().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RunnerHttpError);
    expect(error).toMatchObject({ status: 401, code: 'unauthorized' });
  });

  test("projectStatus returns the project's name and repo", async () => {
    const { http, requests } = httpHub(() =>
      Response.json({
        project: { name: 'demo', repo: 'git@github.com:acme/demo.git', paused: false },
        goalVersion: 3,
        epoch: 1,
      }),
    );
    expect(await http.projectStatus()).toEqual({ name: 'demo', repo: 'git@github.com:acme/demo.git' });
    expect(requests[0]).toMatchObject({ method: 'GET', path: '/api/status', authorization: `Bearer ${TOKEN}` });
  });

  test('uploadTranscript posts { tail } clipped to 64 KB with the CLI token', async () => {
    const { http, requests } = httpHub(() => Response.json({ ok: true }));
    // Three-byte characters, so the cut falls inside one unless it is moved to a boundary.
    const transcript = `${'start '.repeat(5_000)}${'€'.repeat(30_000)}the end`;
    await http.uploadTranscript('T-4-a1', transcript);
    const [request] = requests;
    expect(request).toMatchObject({
      method: 'POST',
      path: '/api/runner/attempts/T-4-a1/transcript',
      authorization: `Bearer ${TOKEN}`,
    });
    const { tail } = TranscriptInputSchema.parse(request?.body);
    expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(TRANSCRIPT_TAIL_MAX_BYTES);
    expect(Buffer.byteLength(tail)).toBeGreaterThan(TRANSCRIPT_TAIL_MAX_BYTES - 3);
    expect(transcript.endsWith(tail)).toBe(true);
    expect(tail.startsWith('€')).toBe(true);
    await http.uploadTranscript('T-4-a1', 'short');
    expect(requests[1]?.body).toEqual({ tail: 'short' });
  });

  test('clipTranscriptTail keeps a short text and never splits a character', () => {
    expect(clipTranscriptTail('héllo', 64)).toBe('héllo');
    expect(clipTranscriptTail('aé', 2)).toBe('é');
    expect(clipTranscriptTail('aé', 1)).toBe('');
  });

  test('reads the credentials on every call and names an unreachable hub or a signed-out CLI', async () => {
    let credentials: Credentials | null = null;
    const http = new RunnerHubHttp({ credentials: () => credentials });
    await expect(http.whoami()).rejects.toMatchObject({ status: 0, code: 'signed_out' });
    credentials = { hubUrl: 'http://127.0.0.1:1', token: TOKEN, user: 'alice' };
    await expect(http.whoami()).rejects.toMatchObject({ status: 0, code: 'unreachable' });
  });

  test('a body that does not match the schema is an error', async () => {
    const { http } = httpHub(() => Response.json({ who: 'alice' }));
    await expect(http.whoami()).rejects.toMatchObject({ code: 'bad_response' });
    await expect(http.projectStatus()).rejects.toMatchObject({ code: 'bad_response' });
  });
});
