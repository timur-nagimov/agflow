import { afterEach, describe, expect, test } from 'bun:test';
import { connect } from 'node:net';
import { type RefusingProxy, startRefusingProxy } from '../src/refusing-proxy';

const proxies: RefusingProxy[] = [];
afterEach(async () => {
  for (const proxy of proxies.splice(0)) await proxy.close();
});

async function proxy(): Promise<RefusingProxy> {
  const started = await startRefusingProxy();
  proxies.push(started);
  return started;
}

/** A request that never got a successful answer, whether the client threw or saw the proxy's refusal. */
async function outcome(request: Promise<Response>): Promise<number | 'failed'> {
  return request.then(
    (response) => response.status,
    () => 'failed' as const,
  );
}

describe('startRefusingProxy', () => {
  test('refuses and records a CONNECT tunnel', async () => {
    const refusing = await proxy();
    expect(refusing.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect([403, 'failed']).toContain(await outcome(fetch('https://example.com/', { proxy: refusing.url })));
    expect(refusing.refused).toEqual([
      { kind: 'connect', method: 'CONNECT', target: 'example.com:443', at: expect.any(Number) },
    ]);
  });

  test('answers an absolute-URI request with 403 and records it', async () => {
    const refusing = await proxy();
    const response = await fetch('http://example.com/path?q=1', { proxy: refusing.url });
    expect(response.status).toBe(403);
    expect(refusing.refused).toHaveLength(1);
    expect(refusing.refused[0]).toMatchObject({ kind: 'http', method: 'GET' });
    expect(refusing.refused[0]?.target).toMatch(/^http:\/\/example\.com(:80)?\/path\?q=1$/);
  });

  test('a request sent to the proxy as a server, or to a local server without it, is not recorded', async () => {
    const refusing = await proxy();
    const direct = await fetch(`${refusing.url}/`);
    expect(direct.status).toBe(400);
    expect(refusing.refused).toEqual([]);
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('ok') });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/`);
      expect(await response.text()).toBe('ok');
    } finally {
      server.stop(true);
    }
    expect(refusing.refused).toEqual([]);
  });

  test('close() stops the proxy', async () => {
    const refusing = await startRefusingProxy();
    await refusing.close();
    const refusedConnection = await new Promise<boolean>((resolve) => {
      const socket = connect(refusing.port, '127.0.0.1');
      socket.on('connect', () => {
        socket.destroy();
        resolve(false);
      });
      socket.on('error', () => resolve(true));
    });
    expect(refusedConnection).toBe(true);
  });
});
