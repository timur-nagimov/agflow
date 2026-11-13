import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import {
  type PinnedRequest,
  PublicFetchError,
  type ResolvedAddress,
  type Resolver,
  type Transport,
  createPinnedTransport,
  fetchPublicUrl,
  pinnedUrl,
  systemResolver,
} from '../src/public-fetch';

const PUBLIC = '93.184.216.34';
const PUBLIC_V6 = '2606:2800:220:1:248:1893:25c8:1946';
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** A resolver that answers from a table and records what it was asked. */
function resolverOf(table: Record<string, string[] | Error>) {
  const asked: string[] = [];
  const resolve: Resolver = async (hostname) => {
    asked.push(hostname);
    const answer = table[hostname];
    if (answer === undefined) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });
    if (answer instanceof Error) throw answer;
    return answer.map((address): ResolvedAddress => ({ address, family: address.includes(':') ? 6 : 4 }));
  };
  return { resolve, asked };
}

/** A transport that answers from a script, keyed by host and path, and records the pinned requests it was given. */
function scripted(script: Record<string, (request: PinnedRequest) => Response>) {
  const requests: PinnedRequest[] = [];
  const transport: Transport = async (request) => {
    requests.push(request);
    const answer = script[`${request.hostname}${request.path}`];
    if (!answer) throw new Error(`no scripted answer for ${request.hostname}${request.path}`);
    return answer(request);
  };
  return { transport, requests };
}

const redirect = (location: string, status = 302) => new Response('moved', { status, headers: { location } });

/** The failure of a fetch, as [code, message]; 'no failure' when it succeeded. */
async function failure(run: Promise<unknown>): Promise<[string, string]> {
  try {
    await run;
  } catch (error) {
    if (error instanceof PublicFetchError) return [error.code, error.message];
    throw error;
  }
  return ['no failure', ''];
}

const servers: { stop: (force: boolean) => unknown }[] = [];
afterAll(() => {
  for (const server of servers) server.stop(true);
});

/** A server on 127.0.0.1, and the real pinned transport pointed at it whatever public address the request pins. */
function localServer(handler: (request: Request) => Response | Promise<Response>, tls?: { cert: string; key: string }) {
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', idleTimeout: 10, fetch: handler, ...(tls ? { tls } : {}) });
  servers.push(server);
  const pinned: PinnedRequest[] = [];
  const real = createPinnedTransport(tls ? { ca: tls.cert } : {});
  const transport: Transport = (request, signal) => {
    pinned.push(request);
    return real({ ...request, address: '127.0.0.1', family: 4, port: server.port as number }, signal);
  };
  return { server, transport, pinned };
}

describe('one GET to a public site', () => {
  test('answers the status, the final URL, the content type, the size, the digest and the bytes', async () => {
    const seen: { method: string; url: string; headers: Record<string, string> }[] = [];
    const { transport, pinned } = localServer((request) => {
      seen.push({ method: request.method, url: request.url, headers: Object.fromEntries(request.headers) });
      return new Response('name,price\nbolt,3\n', { headers: { 'content-type': 'text/csv; charset=utf-8', 'set-cookie': 'a=b', 'x-secret': 'no' } });
    });
    const { resolve, asked } = resolverOf({ 'example.com': [PUBLIC] });
    const result = await fetchPublicUrl({ resolve, transport }, 'http://example.com/prices.csv?year=2026#top');
    expect({ ...result, body: text(result.body) }).toEqual({
      status: 200,
      finalUrl: 'http://example.com/prices.csv?year=2026',
      contentType: 'text/csv; charset=utf-8',
      bytes: 18,
      sha256: sha256('name,price\nbolt,3\n'),
      body: 'name,price\nbolt,3\n',
    });
    expect(asked).toEqual(['example.com']);
    expect(pinned).toEqual([{ protocol: 'http:', hostname: 'example.com', address: PUBLIC, family: 4, port: 80, path: '/prices.csv?year=2026' }]);
    // What the site sees: the host name, a fixed agent, nothing of the caller's, and no fragment.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe('GET');
    expect(new URL(seen[0]!.url).pathname + new URL(seen[0]!.url).search).toBe('/prices.csv?year=2026');
    expect(seen[0]!.headers).toMatchObject({ host: 'example.com', 'user-agent': 'agflow-fetch/1.0', accept: '*/*', 'accept-encoding': 'gzip, br' });
    for (const header of ['cookie', 'authorization', 'referer', 'origin', 'x-agflow-bridge', 'proxy-authorization']) {
      expect([header, header in seen[0]!.headers]).toEqual([header, false]);
    }
  });

  test('a status that is not a success is still an answer, with its body', async () => {
    const { transport } = localServer(() => new Response('gone', { status: 404, headers: { 'content-type': 'text/plain' } }));
    const { resolve } = resolverOf({ 'example.com': [PUBLIC] });
    const result = await fetchPublicUrl({ resolve, transport }, 'http://example.com/missing');
    expect([result.status, text(result.body), result.contentType, result.bytes]).toEqual([404, 'gone', 'text/plain', 4]);
  });

  test('a response without a content type has none, and an empty body has the digest of nothing', async () => {
    const { transport, requests } = scripted({ 'example.com/': () => new Response(null, { status: 204 }) });
    const { resolve } = resolverOf({ 'example.com': [PUBLIC] });
    const result = await fetchPublicUrl({ resolve, transport }, 'https://example.com');
    expect([result.status, result.contentType, result.bytes, result.sha256]).toEqual([204, null, 0, sha256('')]);
    expect(requests[0]).toMatchObject({ protocol: 'https:', port: 443, path: '/' });
  });

  test('a URL the rules refuse is never resolved', async () => {
    const { resolve, asked } = resolverOf({});
    const { transport, requests } = scripted({});
    for (const url of ['ftp://example.com/', 'http://127.0.0.1/', 'http://2130706433/', 'http://[::1]/', 'https://example.com:8443/', 'https://u:p@example.com/', 'http://localhost/']) {
      expect([url, (await failure(fetchPublicUrl({ resolve, transport }, url)))[0]]).toEqual([url, 'url_refused']);
    }
    expect(asked).toEqual([]);
    expect(requests).toEqual([]);
  });
});

describe('the addresses a host resolves to', () => {
  const refused: [string, string][] = [
    ['127.0.0.1', 'loopback'],
    ['10.1.2.3', 'private'],
    ['172.16.5.5', 'private'],
    ['192.168.1.1', 'private'],
    ['169.254.169.254', 'link-local'],
    ['100.64.0.1', 'carrier-grade NAT'],
    ['0.0.0.0', 'unspecified'],
    ['224.0.0.251', 'multicast'],
    ['240.0.0.1', 'reserved'],
    ['192.0.2.9', 'documentation'],
    ['::', 'unspecified'],
    ['::1', 'loopback'],
    ['fe80::1', 'link-local'],
    ['fd00::1', 'unique local'],
    ['::ffff:127.0.0.1', 'IPv4-mapped'],
    ['::ffff:10.0.0.1', 'IPv4-mapped'],
    ['64:ff9b::7f00:1', 'loopback'],
    ['64:ff9b::a9fe:a9fe', 'link-local'],
    ['2001:db8::1', 'documentation'],
    ['not-an-address', 'invalid'],
  ];

  test('a host that resolves to anything but public unicast addresses is refused before any connection', async () => {
    for (const [address, kind] of refused) {
      const { resolve } = resolverOf({ 'evil.example.org': [address] });
      const { transport, requests } = scripted({});
      const [code, message] = await failure(fetchPublicUrl({ resolve, transport }, 'https://evil.example.org/'));
      expect([address, code]).toEqual([address, 'address_refused']);
      expect(message).toContain(address);
      expect(message).toContain(kind);
      expect(requests).toEqual([]);
    }
  });

  test('every address must be public: one private answer among public ones refuses the host', async () => {
    for (const answers of [[PUBLIC, '10.0.0.1'], ['10.0.0.1', PUBLIC], [PUBLIC, PUBLIC_V6, '::1'], [PUBLIC, '169.254.169.254']]) {
      const { resolve } = resolverOf({ 'mixed.example.org': answers });
      const { transport, requests } = scripted({});
      expect((await failure(fetchPublicUrl({ resolve, transport }, 'https://mixed.example.org/')))[0]).toBe('address_refused');
      expect(requests).toEqual([]);
    }
  });

  test('a host that does not resolve, or resolves to nothing, fails as a DNS failure', async () => {
    const { transport } = scripted({});
    const none = resolverOf({ 'empty.example.org': [] });
    expect((await failure(fetchPublicUrl({ resolve: none.resolve, transport }, 'https://empty.example.org/')))[0]).toBe('dns_failed');
    expect((await failure(fetchPublicUrl({ resolve: none.resolve, transport }, 'https://missing.example.org/')))[0]).toBe('dns_failed');
  });

  test('the connection goes to an address that was checked: IPv4 when there is one, else the first IPv6', async () => {
    const page = () => new Response('ok');
    const both = scripted({ 'example.com/': page });
    await fetchPublicUrl({ resolve: resolverOf({ 'example.com': [PUBLIC_V6, PUBLIC] }).resolve, transport: both.transport }, 'https://example.com/');
    expect(both.requests[0]).toMatchObject({ address: PUBLIC, family: 4 });
    const six = scripted({ 'example.com/': page });
    await fetchPublicUrl({ resolve: resolverOf({ 'example.com': [PUBLIC_V6] }).resolve, transport: six.transport }, 'https://example.com/');
    expect(six.requests[0]).toMatchObject({ address: PUBLIC_V6, family: 6 });
    expect(pinnedUrl(six.requests[0]!)).toBe(`https://[${PUBLIC_V6}]:443/`);
    expect(pinnedUrl(both.requests[0]!)).toBe(`https://${PUBLIC}:443/`);
  });
});

describe('the system resolver', () => {
  test('answers every address of a name with its family; localhost needs no network', async () => {
    const answers = await systemResolver('localhost');
    expect(answers.length).toBeGreaterThan(0);
    for (const answer of answers) {
      expect([4, 6]).toContain(answer.family);
      expect(['127.0.0.1', '::1']).toContain(answer.address);
    }
  });
});

describe('pinning', () => {
  test('the host is resolved once per hop, and a resolver that answers differently the second time cannot redirect the connection', async () => {
    let calls = 0;
    // DNS rebinding: public for the check, loopback for whoever asks again.
    const resolve: Resolver = async () => (++calls === 1 ? [{ address: PUBLIC, family: 4 }] : [{ address: '127.0.0.1', family: 4 }]);
    const { transport, requests } = scripted({ 'rebind.example.org/': () => new Response('ok') });
    const result = await fetchPublicUrl({ resolve, transport }, 'http://rebind.example.org/');
    expect(result.status).toBe(200);
    expect(calls).toBe(1);
    expect(requests.map((request) => request.address)).toEqual([PUBLIC]);
  });

  test('the real transport connects to the pinned address and never looks the host name up', async () => {
    const hosts: (string | null)[] = [];
    const { server } = localServer((request) => {
      hosts.push(request.headers.get('host'));
      return new Response('reached');
    });
    // A name no resolver knows: only the pinned address can have reached the server.
    const request: PinnedRequest = { protocol: 'http:', hostname: 'never-resolved.invalid', address: '127.0.0.1', family: 4, port: server.port as number, path: '/' };
    const response = await createPinnedTransport()(request, new AbortController().signal);
    expect(await response.text()).toBe('reached');
    expect(hosts).toEqual(['never-resolved.invalid']);
  });

  test('a rebinding answer on a redirect hop is checked like the first', async () => {
    let calls = 0;
    const resolve: Resolver = async () => (++calls === 1 ? [{ address: PUBLIC, family: 4 }] : [{ address: '192.168.0.10', family: 4 }]);
    const { transport, requests } = scripted({ 'rebind.example.org/': () => redirect('/next') });
    expect((await failure(fetchPublicUrl({ resolve, transport }, 'http://rebind.example.org/')))[0]).toBe('address_refused');
    expect(requests).toHaveLength(1);
  });
});

/** A throwaway certificate for the name, or null where openssl is missing. */
function selfSigned(name = 'pinned.example.test'): { cert: string; key: string } | null {
  const dir = mkdtempSync(join(tmpdir(), 'agflow-fetch-tls-'));
  try {
    const made = Bun.spawnSync(
      ['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-subj', `/CN=${name}`, '-addext', `subjectAltName=DNS:${name}`],
      { stdout: 'ignore', stderr: 'ignore' },
    );
    if (made.exitCode !== 0) return null;
    return { cert: readFileSync(join(dir, 'cert.pem'), 'utf8'), key: readFileSync(join(dir, 'key.pem'), 'utf8') };
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('TLS to a pinned address', () => {
  const tls = selfSigned();

  test.skipIf(tls === null)('the certificate is verified against the host name, not the address connected to', async () => {
    const { transport } = localServer(() => new Response('secure'), tls!);
    const { resolve } = resolverOf({ 'pinned.example.test': [PUBLIC], 'other.example.test': [PUBLIC] });
    const result = await fetchPublicUrl({ resolve, transport }, 'https://pinned.example.test/');
    expect(text(result.body)).toBe('secure');
    // The same server and address under a name its certificate does not cover.
    const [code, message] = await failure(fetchPublicUrl({ resolve, transport }, 'https://other.example.test/'));
    expect(code).toBe('connect_failed');
    expect(message).toContain('other.example.test');
  });

  test.skipIf(tls === null)('the host name goes into the handshake (SNI), so a server with a certificate per name presents the right one', async () => {
    const second = selfSigned('second.example.test');
    if (!second) throw new Error('openssl made one certificate but not a second');
    // Without the name in the handshake the server could only present one of the two, and one request would fail.
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (request) => new Response(`for ${request.headers.get('host')}`),
      tls: [
        { serverName: 'pinned.example.test', ...tls! },
        { serverName: 'second.example.test', ...second },
      ],
    });
    servers.push(server);
    const { resolve } = resolverOf({ 'pinned.example.test': [PUBLIC], 'second.example.test': [PUBLIC] });
    for (const [name, trusted] of [['pinned.example.test', tls!.cert], ['second.example.test', second.cert]] as const) {
      const real = createPinnedTransport({ ca: trusted });
      const transport: Transport = (request, signal) => real({ ...request, address: '127.0.0.1', port: server.port as number }, signal);
      const result = await fetchPublicUrl({ resolve, transport }, `https://${name}/`);
      expect([name, text(result.body)]).toEqual([name, `for ${name}`]);
    }
  });

  test.skipIf(tls === null)('a certificate no authority vouches for is refused', async () => {
    const { server } = localServer(() => new Response('secure'), tls!);
    const untrusting = createPinnedTransport();
    const transport: Transport = (request, signal) => untrusting({ ...request, address: '127.0.0.1', port: server.port as number }, signal);
    const { resolve } = resolverOf({ 'pinned.example.test': [PUBLIC] });
    expect((await failure(fetchPublicUrl({ resolve, transport }, 'https://pinned.example.test/')))[0]).toBe('connect_failed');
  });
});

describe('redirects', () => {
  const everywhere = { 'a.example.org': [PUBLIC], 'b.example.org': ['1.1.1.1'], 'inside.example.org': ['10.0.0.8'], 'meta.example.org': ['169.254.169.254'] };

  test('are followed by hand, each hop resolved and checked, relative or absolute, http to https', async () => {
    const { resolve, asked } = resolverOf(everywhere);
    const { transport, requests } = scripted({
      'a.example.org/start': () => redirect('/second?x=1', 301),
      'a.example.org/second?x=1': () => redirect('https://b.example.org/third#frag', 307),
      'b.example.org/third': () => redirect('//a.example.org/last', 308),
      'a.example.org/last': () => new Response('arrived', { headers: { 'content-type': 'text/plain' } }),
    });
    const hops: string[] = [];
    const result = await fetchPublicUrl({ resolve, transport }, 'http://a.example.org/start', { beforeHop: async (url) => void hops.push(url.href) });
    expect([result.status, result.finalUrl, text(result.body)]).toEqual([200, 'https://a.example.org/last', 'arrived']);
    expect(asked).toEqual(['a.example.org', 'a.example.org', 'b.example.org', 'a.example.org']);
    expect(requests.map((request) => `${request.protocol}//${request.hostname}:${request.port}${request.path} @${request.address}`)).toEqual([
      `http://a.example.org:80/start @${PUBLIC}`,
      `http://a.example.org:80/second?x=1 @${PUBLIC}`,
      'https://b.example.org:443/third @1.1.1.1',
      `https://a.example.org:443/last @${PUBLIC}`,
    ]);
    // The hook hears every hop after the first, so its caller can pace requests per host.
    expect(hops).toEqual(['http://a.example.org/second?x=1', 'https://b.example.org/third', 'https://a.example.org/last']);
  });

  test('a redirect to a forbidden target is refused and never requested', async () => {
    const targets: [string, string][] = [
      ['http://inside.example.org/admin', 'address_refused'],
      ['http://meta.example.org/latest/meta-data/', 'address_refused'],
      ['http://127.0.0.1/', 'url_refused'],
      ['http://169.254.169.254/latest/meta-data/', 'url_refused'],
      ['http://[::1]/', 'url_refused'],
      ['http://2130706433/', 'url_refused'],
      ['http://localhost/', 'url_refused'],
      ['ftp://a.example.org/file', 'url_refused'],
      ['file:///etc/passwd', 'url_refused'],
      ['gopher://a.example.org/', 'url_refused'],
      ['http://a.example.org:8080/', 'url_refused'],
      ['http://user:pw@a.example.org/', 'url_refused'],
      ['http://exa mple.org/', 'url_refused'],
    ];
    for (const [location, code] of targets) {
      const { resolve } = resolverOf(everywhere);
      const { transport, requests } = scripted({ 'a.example.org/start': () => redirect(location) });
      const [got, message] = await failure(fetchPublicUrl({ resolve, transport }, 'http://a.example.org/start'));
      expect([location, got]).toEqual([location, code]);
      expect(message).toContain('redirect');
      expect(requests).toHaveLength(1);
    }
  });

  test('five redirects are followed and a sixth is an error', async () => {
    const chain = (length: number) => {
      const script: Record<string, () => Response> = {};
      for (let hop = 0; hop < length; hop++) script[`a.example.org/${hop}`] = () => redirect(`/${hop + 1}`);
      script[`a.example.org/${length}`] = () => new Response('end');
      return scripted(script);
    };
    const five = chain(5);
    const result = await fetchPublicUrl({ resolve: resolverOf(everywhere).resolve, transport: five.transport }, 'http://a.example.org/0');
    expect([result.finalUrl, five.requests.length]).toEqual(['http://a.example.org/5', 6]);
    const six = chain(6);
    const [code] = await failure(fetchPublicUrl({ resolve: resolverOf(everywhere).resolve, transport: six.transport }, 'http://a.example.org/0'));
    expect([code, six.requests.length]).toEqual(['too_many_redirects', 6]);
    const loop = scripted({ 'a.example.org/loop': () => redirect('/loop') });
    expect((await failure(fetchPublicUrl({ resolve: resolverOf(everywhere).resolve, transport: loop.transport }, 'http://a.example.org/loop')))[0]).toBe('too_many_redirects');
  });

  test('a redirect status without a Location is the answer, and a refusal by the hop hook stops the fetch', async () => {
    const { transport } = scripted({
      'a.example.org/multiple': () => new Response('choose', { status: 300 }),
      'a.example.org/start': () => redirect('/next'),
    });
    const { resolve } = resolverOf(everywhere);
    const result = await fetchPublicUrl({ resolve, transport }, 'http://a.example.org/multiple');
    expect([result.status, text(result.body)]).toEqual([300, 'choose']);
    const busy = new Error('the host is busy');
    const refusedHop = fetchPublicUrl({ resolve, transport }, 'http://a.example.org/start', { beforeHop: async () => { throw busy; } });
    expect(refusedHop).rejects.toBe(busy);
  });
});

describe('limits', () => {
  const resolve = resolverOf({ 'example.com': [PUBLIC] }).resolve;
  const CAP = 64 * 1024;

  test('a site that never answers is a timeout, for the whole request', async () => {
    const { transport } = localServer(() => new Promise<Response>(() => {}));
    const started = performance.now();
    const [code, message] = await failure(fetchPublicUrl({ resolve, transport }, 'http://example.com/', { timeoutMs: 150 }));
    expect(code).toBe('timeout');
    expect(message).toContain('example.com');
    expect(performance.now() - started).toBeLessThan(3_000);
  });

  test('a body that stalls is a timeout, and so is a slow chain of redirects', async () => {
    const stalled = localServer(() => new Response(new ReadableStream({ start: (controller) => controller.enqueue(new TextEncoder().encode('begin')) })));
    expect((await failure(fetchPublicUrl({ resolve, transport: stalled.transport }, 'http://example.com/', { timeoutMs: 150 })))[0]).toBe('timeout');
    let hop = 0;
    const slow = localServer(async () => {
      await Bun.sleep(70);
      return redirect(`/${++hop}`);
    });
    const started = performance.now();
    expect((await failure(fetchPublicUrl({ resolve, transport: slow.transport }, 'http://example.com/0', { timeoutMs: 150 })))[0]).toBe('timeout');
    expect(performance.now() - started).toBeLessThan(3_000);
    // A resolver that never answers is inside the same deadline.
    const never: Resolver = () => new Promise(() => {});
    expect((await failure(fetchPublicUrl({ resolve: never, transport: slow.transport }, 'http://example.com/', { timeoutMs: 100 })))[0]).toBe('timeout');
  });

  test('a body at the cap is answered whole; one byte more is an error, never a shorter success', async () => {
    const body = (size: number) => new Uint8Array(size).fill(97);
    const exact = localServer(() => new Response(body(CAP)));
    const result = await fetchPublicUrl({ resolve, transport: exact.transport }, 'http://example.com/', { maxBytes: CAP });
    expect([result.bytes, result.sha256]).toEqual([CAP, sha256(body(CAP))]);
    const over = localServer(() => new Response(body(CAP + 1)));
    const [code, message] = await failure(fetchPublicUrl({ resolve, transport: over.transport }, 'http://example.com/', { maxBytes: CAP }));
    expect(code).toBe('too_large');
    expect(message).toContain('64 KB');
  });

  test('a stream without a declared length is cut off as soon as it passes the cap', async () => {
    let sent = 0;
    const endless = localServer(
      () =>
        new Response(
          new ReadableStream({
            async pull(controller) {
              sent += 1;
              controller.enqueue(new Uint8Array(16 * 1024));
              await Bun.sleep(1);
            },
          }),
        ),
    );
    expect((await failure(fetchPublicUrl({ resolve, transport: endless.transport }, 'http://example.com/', { maxBytes: CAP })))[0]).toBe('too_large');
    await Bun.sleep(50);
    const afterRefusal = sent;
    // The hub stopped reading: the server is not asked for megabytes more.
    expect(afterRefusal).toBeLessThan(200);
    await Bun.sleep(100);
    expect(sent - afterRefusal).toBeLessThan(50);
  });

  test('a compressed body is measured after decompression: a small bomb is refused, an honest one answered', async () => {
    const bomb = new Uint8Array(8 * 1024 * 1024);
    for (const [encoding, compress] of [['gzip', gzipSync], ['br', brotliCompressSync]] as const) {
      const packed = compress(bomb);
      expect(packed.length).toBeLessThan(CAP);
      const server = localServer(() => new Response(packed, { headers: { 'content-encoding': encoding, 'content-type': 'text/plain' } }));
      const [code] = await failure(fetchPublicUrl({ resolve, transport: server.transport }, 'http://example.com/', { maxBytes: CAP }));
      expect([encoding, code]).toEqual([encoding, 'too_large']);
      const honest = localServer(() => new Response(compress('hello '.repeat(1000)), { headers: { 'content-encoding': encoding, 'content-type': 'text/plain' } }));
      const result = await fetchPublicUrl({ resolve, transport: honest.transport }, 'http://example.com/', { maxBytes: CAP });
      expect([encoding, result.bytes, result.sha256, result.contentType]).toEqual([encoding, 6000, sha256('hello '.repeat(1000)), 'text/plain']);
    }
  });

  test('an encoding the hub did not ask for, or a body that does not decompress, is an error', async () => {
    const zstd = localServer(() => new Response('abc', { headers: { 'content-encoding': 'zstd' } }));
    expect((await failure(fetchPublicUrl({ resolve, transport: zstd.transport }, 'http://example.com/')))[0]).toBe('bad_response');
    const twice = localServer(() => new Response(gzipSync(gzipSync('abc')), { headers: { 'content-encoding': 'gzip, gzip' } }));
    expect((await failure(fetchPublicUrl({ resolve, transport: twice.transport }, 'http://example.com/')))[0]).toBe('bad_response');
    const corrupt = localServer(() => new Response('this is not gzip', { headers: { 'content-encoding': 'gzip' } }));
    expect((await failure(fetchPublicUrl({ resolve, transport: corrupt.transport }, 'http://example.com/')))[0]).toBe('bad_response');
  });

  test('a declared length over the cap is refused without reading the body', async () => {
    const { transport } = scripted({
      'example.com/': () => new Response(new ReadableStream({ pull: () => { throw new Error('the body must not be read'); } }), { headers: { 'content-length': String(CAP + 1) } }),
    });
    expect((await failure(fetchPublicUrl({ resolve, transport }, 'http://example.com/', { maxBytes: CAP })))[0]).toBe('too_large');
  });

  test('a connection that fails is reported with the host, not as a hub error', async () => {
    const transport: Transport = async () => {
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    };
    const [code, message] = await failure(fetchPublicUrl({ resolve, transport }, 'https://example.com/'));
    expect(code).toBe('connect_failed');
    expect(message).toContain('example.com');
  });

  test('a connection that breaks while the body is read is a failure of the fetch, with its code', async () => {
    // The site sent its headers and the start of the body; then the stream failed.
    const { transport } = scripted({
      'example.com/': () =>
        new Response(
          new ReadableStream({
            start: (controller) => controller.enqueue(new TextEncoder().encode('begin')),
            pull: (controller) => controller.error(Object.assign(new Error('socket closed'), { code: 'ECONNRESET' })),
          }),
        ),
    });
    const [code, message] = await failure(fetchPublicUrl({ resolve, transport }, 'https://example.com/'));
    expect(code).toBe('connect_failed');
    expect(message).toContain('example.com');
    expect(message).toContain('ECONNRESET');
  });

  test('a site that closes the connection before the body it announced is complete is a failure, never a shorter success', async () => {
    const listener = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: {
        data(socket) {
          socket.write('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 1000\r\n\r\nonly the start');
          socket.end();
        },
      },
    });
    try {
      const real = createPinnedTransport();
      const transport: Transport = (request, signal) => real({ ...request, address: '127.0.0.1', port: listener.port }, signal);
      expect((await failure(fetchPublicUrl({ resolve, transport }, 'http://example.com/')))[0]).toBe('connect_failed');
    } finally {
      listener.stop(true);
    }
  });

  test('the defaults are 20 seconds, 10 MB and 5 redirects', async () => {
    const { PUBLIC_FETCH_LIMITS } = await import('../src/public-fetch');
    expect(PUBLIC_FETCH_LIMITS).toEqual({ timeoutMs: 20_000, maxBytes: 10 * 1024 * 1024, maxRedirects: 5 });
  });
});
