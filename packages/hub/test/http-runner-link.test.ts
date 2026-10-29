import { afterEach, describe, expect, test } from 'bun:test';
import { WhoamiResponseSchema } from '@agflow/core';
import { SESSION_TTL, createSession, deleteSession, mintAgentToken, sessionHashOf } from '../src/auth';
import { findCommand } from '../src/commands';
import { BAD_MESSAGE_CLOSE } from '../src/gateway';
import { getRunner } from '../src/runners';
import { type HubServer, startHub } from '../src/server';
import { FakeRunner, connectFakeRunnerWs } from './fake-runner';
import { addRunnerAttempt, createTestContext } from './helpers';
import { createTestHub } from './http-helpers';

const servers: HubServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
});

function serve(overrides: Parameters<typeof createTestContext>[0] = {}, options: { timers?: boolean } = {}) {
  const { ctx, clock } = createTestContext(overrides);
  const timers = options.timers ?? false;
  const hub = startHub(ctx, { port: 0, hostname: '127.0.0.1', scheduler: false, dbLock: false, timers });
  servers.push(hub);
  return { ctx, clock, hub, token: createSession(ctx, 'alice', 'cli') };
}

/** The headers of a WebSocket handshake, which fetch sends as they are. */
const HANDSHAKE = {
  connection: 'Upgrade',
  upgrade: 'websocket',
  'sec-websocket-version': '13',
  'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
};

/** Polls until the predicate holds, failing at the deadline; for waits on real sockets and timers. */
async function until(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms`);
    await Bun.sleep(5);
  }
}

type Ctx = ReturnType<typeof createTestContext>['ctx'];

const sessionRow = (ctx: Ctx, token: string) =>
  ctx.db.query('SELECT 1 AS found FROM sessions WHERE token_hash = $hash').get({ hash: sessionHashOf(token) });

async function answer(response: Response): Promise<[number, string | undefined]> {
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  return [response.status, body?.error];
}

describe('the runner link on a real server', () => {
  test('FakeRunner over a WebSocket with a CLI token sends hello and gets welcome', async () => {
    const { ctx, hub, token } = serve();
    const runner = await connectFakeRunnerWs(hub.url, { token, now: ctx.now });
    expect(runner.welcome).toMatchObject({ t: 'welcome', runnerId: 'R-1', hubEpoch: 1, ackedSeq: 0, stop: [] });
    expect(hub.gateway.connectionOf('R-1')).not.toBeNull();
    expect(getRunner(ctx, 'R-1')).toMatchObject({ owner: 'alice', state: 'online' });
    runner.disconnect();
  });

  test('before an upgrade a cookie gets 401, an agent token 403 agent_not_allowed, a plain GET 426', async () => {
    const { ctx, hub, token } = serve();
    const ws = `${hub.url}/api/runner/ws`;
    const web = createSession(ctx, 'alice', 'web');
    const cookie = await fetch(ws, { headers: { ...HANDSHAKE, cookie: `agflow_session=${web}` } });
    expect(await answer(cookie)).toEqual([401, 'unauthorized']);
    const { attempt } = addRunnerAttempt(ctx);
    const agentToken = mintAgentToken(ctx, attempt);
    const agent = await fetch(ws, { headers: { ...HANDSHAKE, authorization: `Bearer ${agentToken}` } });
    expect(await answer(agent)).toEqual([403, 'agent_not_allowed']);
    const plain = await fetch(ws, { headers: { authorization: `Bearer ${token}` } });
    expect(await answer(plain)).toEqual([426, 'upgrade_required']);
    expect(await answer(await fetch(ws))).toEqual([401, 'unauthorized']);
    // A refused WebSocket client learns nothing but that the upgrade failed.
    const refused = await connectFakeRunnerWs(hub.url, { token: web, now: ctx.now });
    expect([refused.welcome, refused.connected]).toEqual([null, false]);
  });

  test('the app alone refuses the link the same way before any upgrade', async () => {
    const hub = createTestHub();
    const plain = await hub.call('GET', '/api/runner/ws', { user: 'alice' });
    expect([plain.status, plain.json.error]).toEqual([426, 'upgrade_required']);
    const web = await hub.call('GET', '/api/runner/ws', { user: 'alice', via: 'web', headers: HANDSHAKE });
    expect([web.status, web.json.error]).toEqual([401, 'unauthorized']);
  });

  test('whoami answers { user } for a CLI token, and 401 for an expired one or a cookie', async () => {
    const { ctx, clock, hub, token } = serve();
    const whoami = `${hub.url}/api/runner/whoami`;
    const ok = await fetch(whoami, { headers: { authorization: `Bearer ${token}` } });
    expect(ok.status).toBe(200);
    expect(WhoamiResponseSchema.parse(await ok.json())).toEqual({ user: 'alice' });
    const web = createSession(ctx, 'alice', 'web');
    const cookie = await fetch(whoami, { headers: { cookie: `agflow_session=${web}` } });
    expect(await answer(cookie)).toEqual([401, 'unauthorized']);
    clock.advance(SESSION_TTL.cli);
    expect(await answer(await fetch(whoami, { headers: { authorization: `Bearer ${token}` } }))).toEqual([
      401,
      'unauthorized',
    ]);
  });

  test('url names the bound port, and stop() closes the runners and the server', async () => {
    const { ctx, hub, token } = serve();
    expect(hub.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(Number(new URL(hub.url).port)).toBeGreaterThan(0);
    expect(hub.scheduler).toBeNull();
    const runner = await connectFakeRunnerWs(hub.url, { token, now: ctx.now });
    await hub.stop();
    await until(() => !runner.connected);
    // The hub closes with 1001 (going away); Bun's WebSocket client reports that code as 1000.
    expect(runner.connected).toBe(false);
    expect(runner.closedWith?.reason).toBe('the hub is stopping');
    expect(getRunner(ctx, 'R-1').state).toBe('offline');
    expect(await fetch(`${hub.url}/api/status`).catch(() => 'refused')).toBe('refused');
  });

  test('a malformed hello closes with 1008 and a reason cut to 123 bytes at a character boundary', async () => {
    const { hub, token } = serve();
    const url = new URL('/api/runner/ws', hub.url);
    url.protocol = 'ws:';
    const socket = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
    const closed = new Promise<CloseEvent>((resolve) => socket.addEventListener('close', resolve));
    await new Promise((resolve) => socket.addEventListener('open', resolve));
    const fake = new FakeRunner(() => {
      throw new Error('unused');
    });
    // zod's message quotes the unknown key: 2-byte characters past byte 123 make a cut fall inside one.
    socket.send(JSON.stringify({ ...fake.hello(), [`x${'é'.repeat(60)}`]: 1 }));
    const event = await closed;
    expect(event.code).toBe(BAD_MESSAGE_CLOSE);
    expect(event.reason).toStartWith('expected a hello: ');
    expect(Buffer.byteLength(event.reason)).toBeLessThanOrEqual(123);
  });
});

describe('timers', () => {
  const timings = { heartbeatMs: 20, deadLinkMs: 60_000 };

  test('with timers on the server sweeps dead links and sign-ins and refreshes needs_login', async () => {
    const { ctx, clock, hub, token } = serve(timings, { timers: true });
    const web = createSession(ctx, 'alice', 'web');
    const silent = await connectFakeRunnerWs(hub.url, { token, now: ctx.now });
    // The runner's answer to the settings echo arrives after its welcome; the link is silent from then on.
    await until(() => findCommand(ctx, '1-R-1-1')?.status === 'done');
    clock.advance(timings.deadLinkMs);
    // Terminated, not closed: the runner sees the connection drop.
    await until(() => !silent.connected);
    expect(silent.closedWith?.code).toBe(1006);
    await until(() => getRunner(ctx, 'R-1').state === 'offline');
    deleteSession(ctx, token);
    await until(() => getRunner(ctx, 'R-1').state === 'needs_login');
    // The auth sweep runs here too: an expired web session is removed.
    clock.advance(SESSION_TTL.web);
    await until(() => sessionRow(ctx, web) === null);
  });

  test('with timers off nothing runs by itself', async () => {
    const { ctx, clock, hub, token } = serve(timings);
    const web = createSession(ctx, 'alice', 'web');
    const silent = await connectFakeRunnerWs(hub.url, { token, now: ctx.now });
    await until(() => findCommand(ctx, '1-R-1-1')?.status === 'done');
    clock.advance(timings.deadLinkMs);
    await Bun.sleep(100);
    expect(silent.connected).toBe(true);
    silent.disconnect();
    await until(() => getRunner(ctx, 'R-1').state === 'offline');
    deleteSession(ctx, token);
    clock.advance(SESSION_TTL.web);
    await Bun.sleep(100);
    expect(getRunner(ctx, 'R-1').state).toBe('offline');
    expect(sessionRow(ctx, web)).not.toBeNull();
    expect(hub.gateway.sweepDeadLinks()).toBe(0);
  });
});
