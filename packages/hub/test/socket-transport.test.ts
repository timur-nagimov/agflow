import { afterAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as tls from 'node:tls';
import { gzipSync } from 'node:zlib';
import { createContext } from '../src/context';
import {
  type PinnedRequest,
  PublicFetchError,
  type ResolvedAddress,
  type Resolver,
  type Transport,
  fetchPublicUrl,
  systemResolver,
} from '../src/public-fetch';
import { type SocketTransportOptions, createSocketTransport } from '../src/socket-transport';
import { makeConfig } from './helpers';

const MB = 1024 * 1024;
const KB = 1024;
const PUBLIC = '93.184.216.34';
/** What the transport sends for a host and a path, byte for byte. */
const wire = (hostname: string, path: string) =>
  `GET ${path} HTTP/1.1\r\nHost: ${hostname}\r\nUser-Agent: agflow-fetch/1.0\r\nAccept: */*\r\nAccept-Encoding: gzip, br\r\nConnection: close\r\n\r\n`;
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

interface KeyPair {
  cert: string;
  key: string;
}

interface Connection {
  socket: net.Socket;
  /** Everything the client has sent so far. */
  received: () => string;
  /** Settles when the server sees that the client has closed the connection. */
  closed: Promise<void>;
  isClosed: () => boolean;
  /** On a TLS server: the name in the handshake and the protocol agreed on. */
  sni: string | null;
  alpn: string | null;
}

interface RawServer {
  port: number;
  connections: Connection[];
}

type Respond = (socket: net.Socket, connection: Connection) => void;

const openSockets = new Set<net.Socket>();
const listeners: net.Server[] = [];
afterAll(() => {
  for (const socket of openSockets) socket.destroy();
  for (const listener of listeners) listener.close();
});

/**
 * A server on a loopback address that speaks raw bytes, so it can send what no HTTP library would. It responds once
 * the request head has arrived whole, or as soon as the connection opens.
 */
function rawServer(respond: Respond, options: { secure?: KeyPair; at?: 'request' | 'connect'; host?: string } = {}): Promise<RawServer> {
  const connections: Connection[] = [];
  const onSocket = (socket: net.Socket) => {
    openSockets.add(socket);
    let received = '';
    let closed = false;
    let responded = false;
    const secure = socket as tls.TLSSocket;
    const connection: Connection = {
      socket,
      received: () => received,
      closed: new Promise<void>((resolve) => {
        // A client that destroys its socket is seen as the end of what it sends. Bun's server socket then stays open
        // for as long as it has bytes of its own left to write, so the server closes its side itself.
        for (const event of ['end', 'close']) {
          socket.on(event, () => {
            closed = true;
            openSockets.delete(socket);
            socket.destroy();
            resolve();
          });
        }
      }),
      isClosed: () => closed,
      sni: options.secure ? ((secure as unknown as { servername?: string | false }).servername || null) : null,
      alpn: options.secure ? secure.alpnProtocol || null : null,
    };
    connections.push(connection);
    const answer = () => {
      if (responded) return;
      responded = true;
      respond(socket, connection);
    };
    socket.on('error', () => {});
    socket.on('data', (bytes: Buffer) => {
      received += bytes.toString('latin1');
      if (received.includes('\r\n\r\n')) answer();
    });
    if (options.at === 'connect') answer();
  };
  const server = options.secure
    ? tls.createServer({ cert: options.secure.cert, key: options.secure.key, ALPNProtocols: ['h2', 'http/1.1'] }, onSocket)
    : net.createServer(onSocket);
  server.on('tlsClientError', () => {});
  server.on('error', () => {});
  listeners.push(server);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, options.host ?? '127.0.0.1', () => resolve({ port: (server.address() as net.AddressInfo).port, connections }));
  });
}

/** A port of the loopback address that nothing listens on. */
const unusedPort = () =>
  new Promise<number>((resolve) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });

/** A server that sends these bytes when the request has arrived, and then closes the connection or keeps it open. */
const answering = (bytes: string | Buffer, then: 'close' | 'stay' = 'close', options: { secure?: KeyPair } = {}) =>
  rawServer((socket) => void (then === 'close' ? socket.end(bytes) : socket.write(bytes)), options);

/**
 * Writes filler for as long as the socket takes it, waiting whenever the socket says it is full, and never more than
 * the limits: the flood always ends. `handed` is what the server gave the socket, so no more than that was sent.
 */
function flood(socket: net.Socket, limits: { bytes?: number; ms?: number; chunk?: Buffer } = {}) {
  const chunk = limits.chunk ?? Buffer.alloc(64 * KB, 0x61);
  const maxBytes = limits.bytes ?? 48 * MB;
  const maxMs = limits.ms ?? 4_000;
  const state = { handed: 0 };
  const started = performance.now();
  const pump = () => {
    let burst = 0;
    while (!socket.destroyed) {
      if (state.handed >= maxBytes || performance.now() - started > maxMs) {
        socket.destroy();
        return;
      }
      state.handed += chunk.length;
      burst += chunk.length;
      if (!socket.write(chunk)) return;
      if (burst >= 256 * KB) {
        // The client runs in this process: let it see what was sent.
        setImmediate(pump);
        return;
      }
    }
  };
  socket.on('drain', pump);
  pump();
  return state;
}

/** One hop to a local server, as fetchPublicUrl would pin it. */
const pinned = (server: RawServer, overrides: Partial<PinnedRequest> = {}): PinnedRequest => ({
  protocol: 'http:',
  hostname: 'example.com',
  address: '127.0.0.1',
  family: 4,
  port: server.port,
  path: '/',
  ...overrides,
});

const get = (server: RawServer, overrides: Partial<PinnedRequest> = {}, options: SocketTransportOptions = {}) =>
  createSocketTransport(options)(pinned(server, overrides), new AbortController().signal);

const bodyOf = async (response: Response) => Buffer.from(await response.arrayBuffer()).toString('latin1');

/** The promise's outcome, or a failure when it has none in time: a hang must fail its own test, not the run. */
const soon = <T>(promise: Promise<T>, ms = 2_000): Promise<T> =>
  Promise.race([promise, Bun.sleep(ms).then(() => Promise.reject(new Error(`nothing happened within ${ms} ms`)))]);

/** The failure of a request or of a fetch, as [code, message]; 'no failure' when there was none. */
async function failure(run: Promise<unknown>): Promise<[string, string]> {
  try {
    await run;
  } catch (error) {
    if (error instanceof PublicFetchError) return [error.code, error.message];
    throw error;
  }
  return ['no failure', ''];
}

/** The failure of one GET, whether the head or the body brings it. */
const failureOfGet = (server: RawServer, overrides: Partial<PinnedRequest> = {}, options: SocketTransportOptions = {}) =>
  failure(soon(get(server, overrides, options).then((response) => response.arrayBuffer())));

/** A resolver that answers every name of the table with a public address. */
function resolverOf(names: string[], table: Record<string, string> = {}): Resolver {
  return async (hostname) => {
    const address = table[hostname] ?? (names.includes(hostname) ? PUBLIC : null);
    if (address === null) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });
    return [{ address, family: 4 } satisfies ResolvedAddress];
  };
}

/**
 * The real transport with each host name standing for a local server: what fetchPublicUrl pinned is recorded, then
 * only the address and the port are replaced.
 */
function routed(ports: Record<string, number>, options: SocketTransportOptions = {}) {
  const real = createSocketTransport(options);
  const requests: PinnedRequest[] = [];
  const statuses: number[] = [];
  const transport: Transport = async (request, signal) => {
    requests.push(request);
    const port = ports[request.hostname];
    if (port === undefined) throw new Error(`no local server stands for ${request.hostname}`);
    const response = await real({ ...request, address: '127.0.0.1', family: 4, port }, signal);
    statuses.push(response.status);
    return response;
  };
  return { transport, requests, statuses };
}

describe('the request', () => {
  test('is exactly these bytes, sent to the pinned address for a name nothing resolves', async () => {
    const site = await answering('HTTP/1.1 200 OK\r\nContent-Length: 7\r\n\r\nreached', 'stay');
    // A name no resolver knows: only the pinned address can have reached the server.
    const response = await get(site, { hostname: 'never-resolved.invalid', path: '/prices.csv?year=2026' });
    expect([response.status, await bodyOf(response)]).toEqual([200, 'reached']);
    await soon(site.connections[0]!.closed);
    expect(site.connections).toHaveLength(1);
    expect(site.connections[0]!.received()).toBe(wire('never-resolved.invalid', '/prices.csv?year=2026'));
  });

  test('goes straight to the pinned address whatever proxy the environment names', async () => {
    const proxy = await rawServer((socket) => socket.end('HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nproxy'), { at: 'connect' });
    const names = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy'];
    const before = names.map((name) => process.env[name]);
    for (const name of names) process.env[name] = `http://127.0.0.1:${proxy.port}`;
    try {
      const site = await answering('HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\nsite');
      expect(await bodyOf(await get(site, { path: '/direct' }))).toBe('site');
      expect(site.connections[0]!.received()).toBe(wire('example.com', '/direct'));
      if (certificates) {
        const secure = await answering('HTTP/1.1 200 OK\r\nContent-Length: 6\r\n\r\nsecure', 'close', { secure: certificates.good });
        const response = await get(secure, { protocol: 'https:', hostname: 'pinned.example.test' }, { ca: certificates.ca });
        expect(await bodyOf(response)).toBe('secure');
        expect(secure.connections[0]!.received()).toBe(wire('pinned.example.test', '/'));
      }
      await Bun.sleep(50);
      expect(proxy.connections).toHaveLength(0);
    } finally {
      names.forEach((name, index) => {
        if (before[index] === undefined) delete process.env[name];
        else process.env[name] = before[index];
      });
    }
  });

  test('is not sent for a path or a host that could split it, nor to an address that is a name', async () => {
    const site = await answering('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n');
    const refused: Partial<PinnedRequest>[] = [
      { path: '/a b' },
      { path: '/a\r\nX-Injected: 1' },
      { path: '/a\nGET /other HTTP/1.1' },
      { path: '/tab\there' },
      { path: '/café' },
      { path: '/\u0000' },
      { path: '/del\u007f' },
      { path: 'no-slash' },
      { path: '' },
      { hostname: 'example.com\r\nX-Injected: 1' },
      { hostname: 'exa mple.com' },
      { hostname: 'example.com:8080' },
      { hostname: 'example.com/path' },
      { hostname: 'bücher.example' },
      { hostname: '' },
      { hostname: '127.0.0.1' },
      { address: 'localhost' },
      { address: 'example.com' },
      { address: '' },
      { port: 0 },
      { port: 70_000 },
      { protocol: 'ftp:' as 'http:' },
    ];
    for (const overrides of refused) {
      const [code, message] = await failure(soon(get(site, overrides)));
      expect([overrides, code]).toEqual([overrides, 'url_refused']);
      expect(message).toMatch(/^[\x20-\x7e]{1,300}$/);
    }
    await Bun.sleep(30);
    expect(site.connections).toHaveLength(0);
  });

  test('reaches an IPv6 address as it is pinned', async () => {
    let site: RawServer;
    try {
      site = await rawServer((socket) => socket.end('HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nsix'), { host: '::1' });
    } catch {
      // No IPv6 loopback on this machine.
      return;
    }
    expect(await bodyOf(await get(site, { address: '::1', family: 6 }))).toBe('six');
  });
});

describe('the body', () => {
  test('of a declared length is exactly that many bytes, and the connection is closed after them', async () => {
    const site = await answering('HTTP/1.1 200 OK\r\nContent-Type: text/csv; charset=utf-8\r\nContent-Length: 5\r\n\r\nhelloEXTRA', 'stay');
    const response = await get(site);
    expect([response.status, response.headers.get('content-type'), response.headers.get('content-length')]).toEqual([200, 'text/csv; charset=utf-8', '5']);
    expect(await bodyOf(response)).toBe('hello');
    // The server kept its side open: the transport closed the connection, it reuses none.
    await soon(site.connections[0]!.closed);
  });

  const chunked =
    'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Type: text/plain\r\n\r\n' +
    '5\r\nhello\r\n1;name=value;other="q"\r\n \r\nA\r\n0123456789\r\n0\r\nExpires: never\r\nX-Checksum: 1\r\n\r\nIGNORED';

  test('in chunks is put together: several chunks, an extension and a trailer', async () => {
    const site = await answering(chunked, 'stay');
    const response = await get(site);
    expect([response.status, response.headers.get('content-type'), response.headers.get('content-length')]).toEqual([200, 'text/plain', null]);
    expect(await bodyOf(response)).toBe('hello 0123456789');
    await soon(site.connections[0]!.closed);
  });

  test('is read the same when the answer arrives a few bytes at a time', async () => {
    const site = await rawServer(async (socket) => {
      for (let at = 0; at < chunked.length; at += 3) {
        socket.write(chunked.slice(at, at + 3));
        await Bun.sleep(1);
      }
    });
    expect(await bodyOf(await soon(get(site)))).toBe('hello 0123456789');
  });

  test('without a length or chunks lasts until the server closes', async () => {
    const site = await answering('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nuntil the end');
    expect(await bodyOf(await get(site))).toBe('until the end');
    const old = await answering('HTTP/1.0 200 OK\r\n\r\nfrom an old server');
    expect(await bodyOf(await get(old))).toBe('from an old server');
  });

  test('may be empty', async () => {
    const declared = await answering('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n', 'stay');
    expect(await bodyOf(await get(declared))).toBe('');
    await soon(declared.connections[0]!.closed);
    const closed = await answering('HTTP/1.1 404 Not Found\r\n\r\n');
    const response = await get(closed);
    expect([response.status, await bodyOf(response)]).toEqual([404, '']);
    const chunks = await answering('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n', 'stay');
    expect(await bodyOf(await get(chunks))).toBe('');
  });

  test('is none for 204 and 304, whatever the headers announce', async () => {
    for (const status of [204, 304]) {
      const site = await answering(`HTTP/1.1 ${status} Whatever\r\nContent-Length: 10\r\nContent-Encoding: gzip\r\n\r\n0123456789`, 'stay');
      const response = await soon(get(site));
      expect([response.status, response.body, await bodyOf(response)]).toEqual([status, null, '']);
      // Nothing describes a body that is not there.
      expect([response.headers.get('content-length'), response.headers.get('content-encoding')]).toEqual([null, null]);
      await soon(site.connections[0]!.closed);
    }
  });

  test('is read after a status line without a reason, and from headers in any case', async () => {
    const bare = await answering('HTTP/1.1 200\r\nCONTENT-LENGTH:2\r\ncontent-type:\ttext/plain \t\r\n\r\nok', 'stay');
    const response = await get(bare);
    expect([response.status, response.headers.get('content-type'), await bodyOf(response)]).toEqual([200, 'text/plain', 'ok']);
    const chunkedCase = await answering('HTTP/1.1 200 OK\r\ntransfer-encoding: CHUNKED\r\n\r\n2\r\nok\r\n0\r\n\r\n', 'stay');
    expect(await bodyOf(await get(chunkedCase))).toBe('ok');
    // The same length said twice is one length.
    const twice = await answering('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Length: 2\r\n\r\nok', 'stay');
    expect(await bodyOf(await get(twice))).toBe('ok');
  });

  test('cut into chunks of one byte reaches the reader in a few pieces, not one for every byte', async () => {
    const size = 200_000;
    const site = await answering(`HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n${'1\r\nx\r\n'.repeat(size)}0\r\n\r\n`, 'stay');
    const response = await get(site);
    const reader = response.body!.getReader();
    let pieces = 0;
    let bytes = 0;
    for (;;) {
      const { done, value } = await soon(reader.read());
      if (done) break;
      pieces += 1;
      bytes += value.length;
      expect((value as Uint8Array).every((byte) => byte === 0x78)).toBe(true);
    }
    expect(bytes).toBe(size);
    // The answer is 1.2 MB on the wire: no more pieces than reads off the socket, where a piece per chunk were 200 000.
    expect(pieces).toBeLessThan(2_000);
  });

  test('follows the interim responses, of which at most three are skipped', async () => {
    const early = 'HTTP/1.1 103 Early Hints\r\nLink: </style.css>; rel=preload\r\n\r\n';
    const site = await answering(`${early}HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok`);
    const response = await get(site);
    expect([response.status, await bodyOf(response)]).toEqual([200, 'ok']);
    const three = await answering(`HTTP/1.1 100 Continue\r\n\r\n${early}HTTP/1.1 102 Processing\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok`);
    expect(await bodyOf(await get(three))).toBe('ok');
    const four = await answering(`${early.repeat(4)}HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok`, 'stay');
    expect((await failureOfGet(four))[0]).toBe('bad_response');
    const endless = await rawServer((socket) => void flood(socket, { chunk: Buffer.from(early) }));
    expect((await failureOfGet(endless))[0]).toBe('bad_response');
  });

  test('arrives as it was sent: a gzip body is not unpacked, and its encoding is named', async () => {
    const packed = gzipSync('hello '.repeat(1000));
    const head = `HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Encoding: gzip\r\nContent-Length: ${packed.length}\r\n\r\n`;
    const site = await answering(Buffer.concat([Buffer.from(head), packed]));
    const response = await get(site);
    expect([response.headers.get('content-encoding'), response.headers.get('content-length')]).toEqual(['gzip', String(packed.length)]);
    expect(Buffer.from(await response.arrayBuffer()).equals(packed)).toBe(true);
  });

  test('of megabytes arrives whole, by length, in chunks and until the close, through a reader that starts late', async () => {
    const body = randomBytes(3 * MB);
    const inChunks: Buffer[] = [];
    for (let at = 0; at < body.length; at += 100_000) {
      const piece = body.subarray(at, at + 100_000);
      inChunks.push(Buffer.from(`${piece.length.toString(16)}\r\n`), piece, Buffer.from('\r\n'));
    }
    const framings: [string, Buffer][] = [
      ['length', Buffer.concat([Buffer.from(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\n\r\n`), body])],
      ['chunks', Buffer.concat([Buffer.from('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n'), ...inChunks, Buffer.from('0\r\n\r\n')])],
      ['close', Buffer.concat([Buffer.from('HTTP/1.1 200 OK\r\n\r\n'), body])],
    ];
    for (const [framing, bytes] of framings) {
      const site = await answering(bytes);
      const response = await get(site);
      // More than the transport holds has been sent by now, so it has stopped the socket and must start it again.
      await Bun.sleep(150);
      const got = Buffer.from(await soon(response.arrayBuffer(), 5_000));
      expect([framing, got.length, sha256(got)]).toEqual([framing, body.length, sha256(body)]);
    }
  }, 20_000);
});

describe('the answer handed on', () => {
  test('carries the status and only the headers the hub reads, cleaned to printable characters', async () => {
    const head =
      'HTTP/1.1 302 Found\r\n' +
      'Set-Cookie: session=1\r\n' +
      'X-Secret: no\r\n' +
      'Server: \x1b[31mred\r\n' +
      'content-TYPE:   text/html; charset=\xe9\x1b[2J  \r\n' +
      'Location: /caf\xc3\xa9 au lait?q=\x01\r\n' +
      'Content-Length: 4\r\n\r\nbody';
    const site = await answering(Buffer.from(head, 'latin1'));
    const response = await get(site);
    expect(response.status).toBe(302);
    expect(Object.fromEntries(response.headers)).toEqual({
      'content-type': 'text/html; charset=??[2J',
      // The bytes a URL cannot hold are escaped, so the target is the one the site named.
      location: '/caf%C3%A9%20au%20lait?q=%01',
      'content-length': '4',
    });
    // A redirect is an answer like any other: the transport follows nothing.
    expect(await bodyOf(response)).toBe('body');
    expect(site.connections).toHaveLength(1);
  });

  test('a header padded with tens of thousands of spaces costs the hub no time', async () => {
    const spaces = ' '.repeat(20_000);
    // Trailing space to trim after a word, and a value that turns out wrong only at its end.
    const padded = await answering(`HTTP/1.1 200 OK\r\nContent-Type:${spaces}text/plain${spaces}x${spaces}\r\nContent-Length: 2\r\n\r\nok`, 'stay');
    const wrong = await answering(`HTTP/1.1 200 OK\r\nContent-Type:${spaces}x${spaces}\x00\r\nContent-Length: 2\r\n\r\nok`, 'stay');
    const started = performance.now();
    const response = await soon(get(padded), 10_000);
    expect(response.headers.get('content-type')).toBe(`text/plain${spaces}x`);
    expect((await failure(soon(get(wrong), 10_000)))[0]).toBe('bad_response');
    expect(performance.now() - started).toBeLessThan(250);
  }, 25_000);

  test('a failure says nothing of what the site sent that is not printable, and little of that', async () => {
    const lines = [
      `HTTP/9.9 \x1b[2J\xff<script>${'A'.repeat(5000)}\r\n\r\n`,
      `HTTP/1.1 200 OK\r\n\x1b[31mBad\x07 header ${'B'.repeat(5000)}\r\n\r\n`,
      `HTTP/1.1 200 OK\r\nTransfer-Encoding: \x1b[31m${'C'.repeat(5000)}\r\n\r\n`,
      `HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n\x1b[31m${'D'.repeat(500)}\r\n`,
    ];
    for (const bytes of lines) {
      const site = await answering(Buffer.from(bytes, 'latin1'), 'stay');
      const [code, message] = await failureOfGet(site);
      expect(code).toBe('bad_response');
      expect(message).toMatch(/^[\x20-\x7e]{1,300}$/);
      expect(message).toContain('example.com');
      expect(message).not.toMatch(/AAAA|BBBB|CCCC|DDDD/);
    }
  });
});

describe('a response head without an end', () => {
  const CAP = 64 * KB;

  test('one endless header line is an error at the cap, and the server cannot send much more', async () => {
    let sent = { handed: 0 };
    const site = await rawServer((socket) => {
      socket.write('HTTP/1.1 200 OK\r\nX-Fill: ');
      sent = flood(socket);
    });
    const started = performance.now();
    const [code, message] = await failureOfGet(site);
    expect(code).toBe('bad_response');
    expect(message).toContain('64 KB');
    expect(performance.now() - started).toBeLessThan(1_500);
    // The socket is destroyed at once: the server sees the close and stops.
    await soon(site.connections[0]!.closed);
    // The review's probe saw 548 MB held in the hub. Here the hub took the cap and one read more; the rest of what
    // the server handed to its socket (about half a megabyte) is what the two ends' socket buffers held at the close.
    expect(sent.handed).toBeGreaterThan(CAP);
    expect(sent.handed).toBeLessThan(4 * MB);
  });

  test('many header lines are an error at the cap too', async () => {
    let sent = { handed: 0 };
    const line = Buffer.from(`X-Fill: ${'a'.repeat(1_000)}\r\n`);
    const site = await rawServer((socket) => {
      socket.write('HTTP/1.1 200 OK\r\n');
      sent = flood(socket, { chunk: Buffer.concat(new Array<Buffer>(32).fill(line)) });
    });
    expect((await failureOfGet(site))[0]).toBe('bad_response');
    await soon(site.connections[0]!.closed);
    expect(sent.handed).toBeGreaterThan(CAP);
    expect(sent.handed).toBeLessThan(4 * MB);
  });

  test('the cap is the one given, and a head just under it is read', async () => {
    const filler = (size: number) => `HTTP/1.1 200 OK\r\nX-Fill: ${'a'.repeat(size)}\r\nContent-Length: 2\r\n\r\nok`;
    const under = await answering(filler(60 * KB));
    expect(await bodyOf(await get(under))).toBe('ok');
    const over = await answering(filler(70 * KB), 'stay');
    expect((await failureOfGet(over))[0]).toBe('bad_response');
    const small = await answering(filler(2 * KB), 'stay');
    const [code, message] = await failureOfGet(small, {}, { headerMaxBytes: KB });
    expect(code).toBe('bad_response');
    expect(message).toContain('1 KB');
    // The interim responses count towards the same cap.
    const interim = `HTTP/1.1 103 Early Hints\r\nLink: ${'a'.repeat(600)}\r\n\r\n`;
    const split = await answering(`${interim}HTTP/1.1 200 OK\r\nX-Fill: ${'a'.repeat(600)}\r\nContent-Length: 2\r\n\r\nok`, 'stay');
    expect((await failureOfGet(split, {}, { headerMaxBytes: KB }))[0]).toBe('bad_response');
    // The trailers of a chunked body are read under it as well.
    const trailers = await rawServer((socket) => {
      socket.write('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nok\r\n0\r\n');
      flood(socket, { chunk: Buffer.from(`X-Trailer: ${'a'.repeat(500)}\r\n`) });
    });
    expect((await failureOfGet(trailers))[0]).toBe('bad_response');
    await soon(trailers.connections[0]!.closed);
  });
});

describe('stopping', () => {
  test('cancelling the body ends the download at once, with a clean end for the reader', async () => {
    let sent = { handed: 0 };
    const site = await rawServer((socket) => {
      socket.write('HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\n\r\n');
      sent = flood(socket);
    });
    const response = await get(site);
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    await reader.cancel();
    await soon(site.connections[0]!.closed);
    expect(sent.handed).toBeLessThan(4 * MB);
    expect(await reader.read()).toEqual({ done: true, value: undefined });
  });

  test('cancelling a body nobody started to read ends the download too', async () => {
    let sent = { handed: 0 };
    const site = await rawServer((socket) => {
      socket.write('HTTP/1.1 302 Found\r\nLocation: /next\r\n\r\n');
      sent = flood(socket);
    });
    const response = await get(site);
    await response.body!.cancel();
    await soon(site.connections[0]!.closed);
    expect(sent.handed).toBeLessThan(4 * MB);
  });

  test('the signal during the handshake rejects the request and destroys the socket', async () => {
    // A server that accepts and says nothing: the TLS handshake never finishes.
    const silent = await rawServer(() => {}, { at: 'connect' });
    const controller = new AbortController();
    const reason = new Error('the deadline');
    const request = createSocketTransport()(pinned(silent, { protocol: 'https:' }), controller.signal);
    await Bun.sleep(60);
    expect(silent.connections).toHaveLength(1);
    const started = performance.now();
    controller.abort(reason);
    expect(await soon(request.catch((error: unknown) => error))).toBe(reason);
    expect(performance.now() - started).toBeLessThan(500);
    await soon(silent.connections[0]!.closed);
  });

  test('a signal that has fired already connects to nothing', async () => {
    const site = await answering('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n');
    const reason = new Error('too late');
    const request = createSocketTransport()(pinned(site), AbortSignal.abort(reason));
    expect(await soon(request.catch((error: unknown) => error))).toBe(reason);
    await Bun.sleep(30);
    expect(site.connections).toHaveLength(0);
  });

  test('the signal during the head rejects the request and destroys the socket', async () => {
    const site = await answering('HTTP/1.1 200 OK\r\nContent-Type: te', 'stay');
    const controller = new AbortController();
    const reason = new Error('the deadline');
    const request = createSocketTransport()(pinned(site), controller.signal);
    await Bun.sleep(60);
    controller.abort(reason);
    expect(await soon(request.catch((error: unknown) => error))).toBe(reason);
    await soon(site.connections[0]!.closed);
  });

  test('the signal during the body gives the reader the error and destroys the socket', async () => {
    const site = await answering('HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\nbegin', 'stay');
    const controller = new AbortController();
    const reason = new Error('the deadline');
    const response = await createSocketTransport()(pinned(site), controller.signal);
    const reader = response.body!.getReader();
    expect(text((await reader.read()).value!)).toBe('begin');
    const next = reader.read();
    await Bun.sleep(30);
    const started = performance.now();
    controller.abort(reason);
    expect(await soon(next.catch((error: unknown) => error))).toBe(reason);
    expect(performance.now() - started).toBeLessThan(500);
    await soon(site.connections[0]!.closed);
  });

  test('a reader that does not read stops the socket: about a megabyte waits in the hub, never more', async () => {
    let sent = { handed: 0 };
    const site = await rawServer((socket) => {
      socket.write('HTTP/1.1 200 OK\r\n\r\n');
      sent = flood(socket, { bytes: 64 * MB, ms: 8_000 });
    });
    // What the transport's socket had read each time the transport paused it.
    const pausedAt: number[] = [];
    let client: net.Socket | null = null;
    const pause = net.Socket.prototype.pause;
    net.Socket.prototype.pause = function (this: net.Socket) {
      if (this.remotePort === site.port) {
        client = this;
        pausedAt.push(this.bytesRead);
      }
      return pause.call(this);
    };
    try {
      const response = await get(site);
      await Bun.sleep(400);
      // The megabyte that may wait, and the one read that crossed it.
      expect(pausedAt).toHaveLength(1);
      expect(pausedAt[0]).toBeGreaterThanOrEqual(MB);
      expect(pausedAt[0]).toBeLessThan(2.5 * MB);
      const transportSocket = client as unknown as net.Socket;
      const [readAtStall, handedAtStall] = [transportSocket.bytesRead, sent.handed];
      expect(readAtStall).toBeLessThan(2.5 * MB);
      await Bun.sleep(300);
      // Nothing more is read, so the server stalls too: its socket and the hub's hold what it had handed over, which
      // is the operating system's buffers and far from the 64 MB it would send.
      expect([transportSocket.bytesRead, sent.handed]).toEqual([readAtStall, handedAtStall]);
      expect(handedAtStall).toBeLessThan(32 * MB);
      expect(site.connections[0]!.isClosed()).toBe(false);
      // Reading lets the server go on.
      const reader = response.body!.getReader();
      let read = 0;
      while (read < 36 * MB) read += (await soon(reader.read())).value!.length;
      expect(sent.handed).toBeGreaterThan(handedAtStall);
      await reader.cancel();
      await soon(site.connections[0]!.closed);
    } finally {
      net.Socket.prototype.pause = pause;
    }
  }, 15_000);
});

/** A throwaway certificate authority and what it signed, or null where openssl is missing. */
function makeCertificates(): { ca: string; good: KeyPair; expired: KeyPair | null; selfSigned: KeyPair } | null {
  const dir = mkdtempSync(join(tmpdir(), 'agflow-transport-tls-'));
  const at = (name: string) => join(dir, name);
  const openssl = (...args: string[]) => Bun.spawnSync(['openssl', ...args], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0;
  const key = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes'];
  const pair = (name: string): KeyPair => ({ cert: readFileSync(at(`${name}.pem`), 'utf8'), key: readFileSync(at(`${name}.key`), 'utf8') });
  /** A certificate for the name signed by the authority, valid for the given days or for the given dates. */
  const signed = (file: string, name: string, validity: string[]): KeyPair | null => {
    writeFileSync(at(`${file}.ext`), `subjectAltName=DNS:${name}\nbasicConstraints=CA:FALSE\n`);
    const made =
      openssl('req', ...key, '-keyout', at(`${file}.key`), '-out', at(`${file}.csr`), '-subj', `/CN=${name}`) &&
      openssl('x509', '-req', '-in', at(`${file}.csr`), '-CA', at('ca.pem'), '-CAkey', at('ca.key'), '-CAcreateserial', '-out', at(`${file}.pem`), '-extfile', at(`${file}.ext`), ...validity);
    return made ? pair(file) : null;
  };
  try {
    if (!openssl('req', '-x509', ...key, '-days', '2', '-keyout', at('ca.key'), '-out', at('ca.pem'), '-subj', '/CN=agflow test authority', '-addext', 'basicConstraints=critical,CA:TRUE')) return null;
    const good = signed('good', 'pinned.example.test', ['-days', '2']);
    if (!good) return null;
    const selfMade = openssl('req', '-x509', ...key, '-days', '2', '-keyout', at('self.key'), '-out', at('self.pem'), '-subj', '/CN=pinned.example.test', '-addext', 'subjectAltName=DNS:pinned.example.test');
    if (!selfMade) return null;
    return {
      ca: readFileSync(at('ca.pem'), 'utf8'),
      good,
      // An older openssl cannot set the dates; the test of an expired certificate is skipped there.
      expired: signed('expired', 'pinned.example.test', ['-not_before', '20200101000000Z', '-not_after', '20200102000000Z']),
      selfSigned: pair('self'),
    };
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const certificates = makeCertificates();

describe('TLS to a pinned address', () => {
  const made = certificates!;
  const ok = 'HTTP/1.1 200 OK\r\nContent-Length: 6\r\n\r\nsecure';
  const secureGet = (server: RawServer, hostname: string, options: SocketTransportOptions = { ca: made.ca }) =>
    get(server, { protocol: 'https:', hostname }, options);

  /** What Bun's own node:tls makes of a handshake with the server, asked for the name: 'verified' or the error's code. */
  const handshake = (server: RawServer, servername: string, ca?: string) =>
    soon(
      new Promise<string>((resolve) => {
        const socket = tls.connect({ host: '127.0.0.1', port: server.port, servername, rejectUnauthorized: true, ...(ca ? { ca } : {}) });
        socket.on('secureConnect', () => {
          resolve(socket.authorized ? 'verified' : 'connected without being verified');
          socket.destroy();
        });
        socket.on('error', (error: Error & { code?: string }) => {
          resolve(error.code ?? error.message);
          socket.destroy();
        });
      }),
    );

  test.skipIf(certificates === null)('the certificate is verified against the host name, which the server sees in the handshake', async () => {
    const site = await answering(ok, 'close', { secure: made.good });
    const response = await secureGet(site, 'pinned.example.test');
    expect([response.status, await bodyOf(response)]).toEqual([200, 'secure']);
    // The connection went to 127.0.0.1; the name is in the handshake (SNI) and only HTTP/1.1 was offered.
    expect([site.connections[0]!.sni, site.connections[0]!.alpn]).toEqual(['pinned.example.test', 'http/1.1']);
    expect(site.connections[0]!.received()).toBe(wire('pinned.example.test', '/'));
  });

  test.skipIf(certificates === null)('a certificate issued for another name is refused, and nothing is sent', async () => {
    const site = await answering(ok, 'close', { secure: made.good });
    // The same server and address under a name its certificate does not cover.
    const [code, message] = await failure(soon(secureGet(site, 'other.example.test')));
    expect(code).toBe('connect_failed');
    expect(message).toContain('other.example.test');
    expect(message).toContain('ERR_TLS_CERT_ALTNAME_INVALID');
    await Bun.sleep(50);
    expect(site.connections.map((connection) => connection.received())).toEqual(site.connections.map(() => ''));
    expect(await handshake(site, 'other.example.test', made.ca)).toBe('ERR_TLS_CERT_ALTNAME_INVALID');
    expect(await handshake(site, 'pinned.example.test', made.ca)).toBe('verified');
  });

  test.skipIf(certificates === null)('a certificate from an authority that is not trusted is refused', async () => {
    const site = await answering(ok, 'close', { secure: made.good });
    // Without the test authority only the built-in ones are trusted.
    const [code, message] = await failure(soon(secureGet(site, 'pinned.example.test', {})));
    expect(code).toBe('connect_failed');
    expect(message).toContain('UNABLE_TO_VERIFY_LEAF_SIGNATURE');
    expect(await handshake(site, 'pinned.example.test')).toBe('UNABLE_TO_VERIFY_LEAF_SIGNATURE');
    // A certificate that vouches for itself, with and without another authority trusted.
    const self = await answering(ok, 'close', { secure: made.selfSigned });
    for (const options of [{}, { ca: made.ca }]) {
      const [selfCode, selfMessage] = await failure(soon(secureGet(self, 'pinned.example.test', options)));
      expect([selfCode, selfMessage.includes('DEPTH_ZERO_SELF_SIGNED_CERT')]).toEqual(['connect_failed', true]);
    }
    expect(await handshake(self, 'pinned.example.test', made.ca)).toBe('DEPTH_ZERO_SELF_SIGNED_CERT');
    await Bun.sleep(50);
    for (const connection of [...site.connections, ...self.connections]) expect(connection.received()).toBe('');
  });

  test.skipIf(certificates === null || certificates.expired === null)('an expired certificate is refused', async () => {
    const site = await answering(ok, 'close', { secure: made.expired! });
    const [code, message] = await failure(soon(secureGet(site, 'pinned.example.test')));
    expect(code).toBe('connect_failed');
    expect(message).toContain('CERT_HAS_EXPIRED');
    expect(await handshake(site, 'pinned.example.test', made.ca)).toBe('CERT_HAS_EXPIRED');
  });

  test.skipIf(certificates === null)('megabytes arrive whole through TLS, in chunks', async () => {
    const body = randomBytes(2 * MB);
    const pieces: Buffer[] = [Buffer.from('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n')];
    for (let at = 0; at < body.length; at += 70_000) {
      const piece = body.subarray(at, at + 70_000);
      pieces.push(Buffer.from(`${piece.length.toString(16)}\r\n`), piece, Buffer.from('\r\n'));
    }
    pieces.push(Buffer.from('0\r\n\r\n'));
    const site = await answering(Buffer.concat(pieces), 'stay', { secure: made.good });
    const response = await secureGet(site, 'pinned.example.test');
    await Bun.sleep(100);
    const got = Buffer.from(await soon(response.arrayBuffer(), 5_000));
    expect([got.length, sha256(got)]).toEqual([body.length, sha256(body)]);
    await soon(site.connections[0]!.closed);
  }, 15_000);

  test.skipIf(certificates === null)('a server that speaks plain HTTP where TLS is expected is a failure, not a hang', async () => {
    const plain = await rawServer((socket) => socket.end(ok), { at: 'connect' });
    const [code, message] = await failure(soon(secureGet(plain, 'pinned.example.test')));
    expect(code).toBe('connect_failed');
    expect(message).toContain('pinned.example.test');
  }, 5_000);

  test.skipIf(certificates === null)('a server that speaks TLS where plain HTTP is expected is a failure, not a hang', async () => {
    const site = await answering(ok, 'close', { secure: made.good });
    // Such a server closes the connection on a plain request, or answers with bytes that are no status line.
    const [code] = await failureOfGet(site);
    expect(['connect_failed', 'bad_response']).toContain(code);
  }, 5_000);
});

describe('an answer that is not HTTP/1.1 as the hub reads it', () => {
  const ok = 'Content-Length: 2\r\n\r\nok';
  const chunks = 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n';
  /** [what, the bytes, whether the server then closes, the failure]. */
  const malformed: [string, string, 'close' | 'stay', string][] = [
    ['a status line of another protocol', `ICY 200 OK\r\n${ok}`, 'stay', 'bad_response'],
    ['a banner that is not HTTP at all', 'SSH-2.0-OpenSSH_9.6', 'stay', 'bad_response'],
    ['HTTP/2 in the status line', `HTTP/2 200 OK\r\n${ok}`, 'stay', 'bad_response'],
    ['a status of two digits', `HTTP/1.1 20 OK\r\n${ok}`, 'stay', 'bad_response'],
    ['a status of four digits', `HTTP/1.1 2000 OK\r\n${ok}`, 'stay', 'bad_response'],
    ['a status below 100', `HTTP/1.1 099 Odd\r\n${ok}`, 'stay', 'bad_response'],
    ['a status above 599', `HTTP/1.1 600 Odd\r\n${ok}`, 'stay', 'bad_response'],
    ['a switch of protocols nobody asked for', 'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n', 'stay', 'bad_response'],
    ['a status line that starts with a space', ` HTTP/1.1 200 OK\r\n${ok}`, 'stay', 'bad_response'],
    ['a folded header', `HTTP/1.1 200 OK\r\nX-Long: one\r\n two\r\n${ok}`, 'stay', 'bad_response'],
    ['a header folded with a tab', `HTTP/1.1 200 OK\r\nX-Long: one\r\n\ttwo\r\n${ok}`, 'stay', 'bad_response'],
    ['a header line without a colon', `HTTP/1.1 200 OK\r\nno colon here\r\n${ok}`, 'stay', 'bad_response'],
    ['a space before the colon', 'HTTP/1.1 200 OK\r\nContent-Length : 2\r\n\r\nok', 'stay', 'bad_response'],
    ['a header without a name', `HTTP/1.1 200 OK\r\n: nameless\r\n${ok}`, 'stay', 'bad_response'],
    ['a control character in a header', `HTTP/1.1 200 OK\r\nX-Odd: a\x00b\r\n${ok}`, 'stay', 'bad_response'],
    ['lines that end with a bare line feed', 'HTTP/1.1 200 OK\nContent-Length: 2\n\nok', 'stay', 'bad_response'],
    ['a bare carriage return in a header', `HTTP/1.1 200 OK\r\nX-Odd: a\rContent-Length: 9\r\n${ok}`, 'stay', 'bad_response'],
    ['Content-Lengths that differ', 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Length: 3\r\n\r\nokk', 'stay', 'bad_response'],
    ['a list of Content-Lengths in one header', 'HTTP/1.1 200 OK\r\nContent-Length: 2, 3\r\n\r\nokk', 'stay', 'bad_response'],
    ['a Content-Length that is not a number', 'HTTP/1.1 200 OK\r\nContent-Length: two\r\n\r\nok', 'stay', 'bad_response'],
    ['a negative Content-Length', 'HTTP/1.1 200 OK\r\nContent-Length: -2\r\n\r\nok', 'stay', 'bad_response'],
    ['a signed Content-Length', 'HTTP/1.1 200 OK\r\nContent-Length: +2\r\n\r\nok', 'stay', 'bad_response'],
    ['a Content-Length in hexadecimal', 'HTTP/1.1 200 OK\r\nContent-Length: 0x2\r\n\r\nok', 'stay', 'bad_response'],
    ['a Content-Length too long to count', 'HTTP/1.1 200 OK\r\nContent-Length: 99999999999999999999\r\n\r\nok', 'stay', 'bad_response'],
    ['an empty Content-Length', 'HTTP/1.1 200 OK\r\nContent-Length:\r\n\r\nok', 'stay', 'bad_response'],
    ['a Transfer-Encoding that is not chunked', 'HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip\r\n\r\nok', 'stay', 'bad_response'],
    ['a Transfer-Encoding with a coding before chunked', 'HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip, chunked\r\n\r\n2\r\nok\r\n0\r\n\r\n', 'stay', 'bad_response'],
    ['the identity Transfer-Encoding', 'HTTP/1.1 200 OK\r\nTransfer-Encoding: identity\r\n\r\nok', 'stay', 'bad_response'],
    ['two Transfer-Encoding headers', 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nok\r\n0\r\n\r\n', 'stay', 'bad_response'],
    ['a Transfer-Encoding beside a Content-Length', 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Length: 2\r\n\r\n2\r\nok\r\n0\r\n\r\n', 'stay', 'bad_response'],
    ['a Transfer-Encoding from an HTTP/1.0 server', 'HTTP/1.0 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nok\r\n0\r\n\r\n', 'stay', 'bad_response'],
    ['two Locations that differ', 'HTTP/1.1 302 Found\r\nLocation: /a\r\nLocation: /b\r\nContent-Length: 0\r\n\r\n', 'stay', 'bad_response'],
    ['a chunk size that is not hexadecimal', `${chunks}zz\r\nok\r\n0\r\n\r\n`, 'stay', 'bad_response'],
    ['a negative chunk size', `${chunks}-2\r\nok\r\n0\r\n\r\n`, 'stay', 'bad_response'],
    ['a chunk size with a prefix', `${chunks}0x2\r\nok\r\n0\r\n\r\n`, 'stay', 'bad_response'],
    ['an empty chunk size', `${chunks}\r\nok\r\n0\r\n\r\n`, 'stay', 'bad_response'],
    ['a chunk size too long to count', `${chunks}${'f'.repeat(20)}\r\nok`, 'stay', 'bad_response'],
    ['a chunk size line without an end', `${chunks}2;${'x'.repeat(8 * KB)}`, 'stay', 'bad_response'],
    ['a chunk size that ends with a bare line feed', `${chunks}2\nok\r\n0\r\n\r\n`, 'stay', 'bad_response'],
    ['a chunk longer than its size', `${chunks}2\r\nokay\r\n0\r\n\r\n`, 'stay', 'bad_response'],
    ['a close inside the declared length', 'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 1000\r\n\r\nonly the start', 'close', 'connect_failed'],
    ['a close inside a chunk', `${chunks}3e8\r\nonly the start`, 'close', 'connect_failed'],
    ['a close before the last chunk', `${chunks}2\r\nok\r\n`, 'close', 'connect_failed'],
    ['a close inside the trailers', `${chunks}2\r\nok\r\n0\r\nX-Trailer: 1\r\n`, 'close', 'connect_failed'],
    ['a close inside the head', 'HTTP/1.1 200 OK\r\nContent-Type: te', 'close', 'connect_failed'],
    ['a close after an interim response', 'HTTP/1.1 100 Continue\r\n\r\n', 'close', 'connect_failed'],
    ['a close without a byte', '', 'close', 'connect_failed'],
  ];

  for (const [what, bytes, then, expected] of malformed) {
    test(`${what} is an error, not a hang`, async () => {
      const site = await answering(Buffer.from(bytes, 'latin1'), then);
      const [code, message] = await failureOfGet(site);
      expect([code, message]).toEqual([expected, expect.stringMatching(/^[\x20-\x7e]{1,300}$/)]);
      expect(message).toContain('example.com');
      // Whatever the server does next, the transport has let go of the connection.
      await soon(site.connections[0]!.closed);
    }, 3_000);
  }

  test('a connection reset under the body is a failure for the reader', async () => {
    const site = await rawServer((socket) => {
      socket.write('HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\nbegin');
      setTimeout(() => socket.resetAndDestroy(), 30);
    });
    const [code, message] = await failureOfGet(site);
    expect(code).toBe('connect_failed');
    expect(message).toContain('example.com');
  }, 3_000);

  test('a broken connection is a failure with its code', async () => {
    const refused = createSocketTransport()({ protocol: 'http:', hostname: 'example.com', address: '127.0.0.1', family: 4, port: await unusedPort(), path: '/' }, new AbortController().signal);
    const [code, message] = await failure(soon(refused));
    expect(code).toBe('connect_failed');
    expect(message).toContain('example.com');
    expect(message).toContain('ECONNREFUSED');
  }, 3_000);
});

describe('through fetchPublicUrl', () => {
  const CAP = 64 * KB;

  test('a redirect with an endless body is dropped at once, while the next hop is still slow to answer', async () => {
    let sent = { handed: 0 };
    const first = await rawServer((socket) => {
      socket.write('HTTP/1.1 302 Found\r\nLocation: http://b.example.org/slow\r\n\r\n');
      sent = flood(socket, { bytes: 64 * MB, ms: 5_000 });
    });
    let firstClosedBeforeTheAnswer = false;
    let sentBeforeTheAnswer = -1;
    const second = await rawServer(async (socket) => {
      await Bun.sleep(700);
      firstClosedBeforeTheAnswer = first.connections[0]!.isClosed();
      sentBeforeTheAnswer = sent.handed;
      socket.end('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 7\r\n\r\narrived');
    });
    const { transport, statuses } = routed({ 'a.example.org': first.port, 'b.example.org': second.port });
    const result = await fetchPublicUrl({ resolve: resolverOf(['a.example.org', 'b.example.org']), transport }, 'http://a.example.org/');
    expect([result.status, result.finalUrl, text(result.body)]).toEqual([200, 'http://b.example.org/slow', 'arrived']);
    expect(statuses).toEqual([302, 200]);
    expect(firstClosedBeforeTheAnswer).toBe(true);
    // The review's probe measured 390 MB of the redirect's body streamed into the hub during the later hops.
    expect(sentBeforeTheAnswer).toBeLessThan(4 * MB);
    expect(sent.handed).toBe(sentBeforeTheAnswer);
  }, 10_000);

  /** A site that answers with the head and then filler without end; what fetchPublicUrl makes of it and what the site could send. */
  async function flooded(head: string, limits: { maxBytes?: number } = {}) {
    let sent = { handed: 0 };
    const site = await rawServer((socket) => {
      socket.write(head);
      sent = flood(socket);
    });
    const { transport } = routed({ 'example.com': site.port });
    const [code] = await failure(fetchPublicUrl({ resolve: resolverOf(['example.com']), transport }, 'http://example.com/', { maxBytes: CAP, ...limits }));
    // The server sees the close soon after the hub has given up.
    await soon(site.connections[0]!.closed, 1_000);
    return { code, handed: sent.handed };
  }

  test('a body larger than the cap is too large, and the download ends soon after the cap', async () => {
    const endless = await flooded('HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\n\r\n');
    expect(endless.code).toBe('too_large');
    expect(endless.handed).toBeLessThan(4 * MB);
    const chunked = await flooded('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n40000000\r\n');
    expect(chunked.code).toBe('too_large');
    expect(chunked.handed).toBeLessThan(4 * MB);
  }, 10_000);

  test('a declared length over the cap ends the download before the body', async () => {
    const declared = await flooded(`HTTP/1.1 200 OK\r\nContent-Length: ${64 * MB}\r\n\r\n`);
    expect(declared.code).toBe('too_large');
    expect(declared.handed).toBeLessThan(4 * MB);
  }, 10_000);

  test('an encoding the hub does not read ends the download before the body', async () => {
    // The cap is far away: the body would be downloaded up to it before the encoding were looked at.
    const encoded = await flooded('HTTP/1.1 200 OK\r\nContent-Encoding: zstd\r\n\r\n', { maxBytes: 32 * MB });
    expect(encoded.code).toBe('bad_response');
    expect(encoded.handed).toBeLessThan(4 * MB);
  }, 10_000);

  test('a refused redirect, and one redirect too many, end the download of the redirect that brought them', async () => {
    const elsewhere = await flooded('HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1/admin\r\n\r\n');
    expect(elsewhere.code).toBe('url_refused');
    expect(elsewhere.handed).toBeLessThan(4 * MB);
    const again = await flooded('HTTP/1.1 302 Found\r\nLocation: /again\r\n\r\n', { maxBytes: CAP });
    expect(again.code).toBe('too_many_redirects');
  }, 10_000);

  test('the deadline ends a download that is still running', async () => {
    // A body that stalls after its first bytes.
    const site = await answering('HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\nbegin', 'stay');
    const { transport } = routed({ 'example.com': site.port });
    const started = performance.now();
    const [code, message] = await failure(fetchPublicUrl({ resolve: resolverOf(['example.com']), transport }, 'http://example.com/', { timeoutMs: 150 }));
    expect([code, message.includes('example.com')]).toEqual(['timeout', true]);
    expect(performance.now() - started).toBeLessThan(2_000);
    await soon(site.connections[0]!.closed, 1_000);
    // A site that takes the request and never answers.
    const silent = await rawServer(() => {});
    const never = routed({ 'example.com': silent.port });
    expect((await failure(fetchPublicUrl({ resolve: resolverOf(['example.com']), transport: never.transport }, 'http://example.com/', { timeoutMs: 150 })))[0]).toBe('timeout');
    await soon(silent.connections[0]!.closed, 1_000);
  });

  test('a redirect to a loopback service is refused and that service is never connected to', async () => {
    const internal = await rawServer((socket) => socket.end('HTTP/1.1 200 OK\r\nContent-Length: 6\r\n\r\nsecret'), { at: 'connect' });
    for (const [location, expected] of [
      [`http://127.0.0.1:${internal.port}/admin`, 'url_refused'],
      ['http://127.0.0.1/admin', 'url_refused'],
      ['http://localhost/admin', 'url_refused'],
      // A public-looking name that resolves to the loopback address.
      ['http://internal.example.org/admin', 'address_refused'],
    ] as const) {
      const site = await answering(`HTTP/1.1 302 Found\r\nLocation: ${location}\r\nContent-Length: 0\r\n\r\n`);
      const { transport, requests, statuses } = routed({ 'a.example.org': site.port, 'internal.example.org': internal.port, localhost: internal.port, '127.0.0.1': internal.port });
      const resolve = resolverOf(['a.example.org'], { 'internal.example.org': '127.0.0.1' });
      const [code, message] = await failure(fetchPublicUrl({ resolve, transport }, 'http://a.example.org/start'));
      expect([location, code]).toEqual([location, expected]);
      expect(message).toContain('redirect');
      // The transport handed the 302 on and was asked for nothing after it.
      expect([statuses, requests.map((request) => request.hostname)]).toEqual([[302], ['a.example.org']]);
    }
    await Bun.sleep(50);
    expect(internal.connections).toHaveLength(0);
  });

  test('a redirect to a relative path is followed by hand on the same host', async () => {
    const site = await rawServer((socket, connection) => {
      const path = connection.received().split(' ')[1];
      if (path === '/start') socket.end('HTTP/1.1 302 Found\r\nLocation: next?x=1\r\nContent-Length: 5\r\n\r\nmoved');
      else socket.end(`HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: ${path!.length}\r\n\r\n${path}`);
    });
    const { transport, requests, statuses } = routed({ 'example.com': site.port });
    const result = await fetchPublicUrl({ resolve: resolverOf(['example.com']), transport }, 'http://example.com/start');
    expect([result.status, result.finalUrl, text(result.body), result.contentType]).toEqual([200, 'http://example.com/next?x=1', '/next?x=1', 'text/plain']);
    // The transport itself answered the 302; fetchPublicUrl made the second request, pinned again.
    expect(statuses).toEqual([302, 200]);
    expect(requests).toEqual([
      { protocol: 'http:', hostname: 'example.com', address: PUBLIC, family: 4, port: 80, path: '/start' },
      { protocol: 'http:', hostname: 'example.com', address: PUBLIC, family: 4, port: 80, path: '/next?x=1' },
    ]);
    expect(site.connections.map((connection) => connection.received())).toEqual([wire('example.com', '/start'), wire('example.com', '/next?x=1')]);
  });

  test('a site that closes the connection before the body it announced is complete is a failure, never a shorter success', async () => {
    const site = await answering('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 1000\r\n\r\nonly the start');
    const { transport } = routed({ 'example.com': site.port });
    const [code, message] = await failure(fetchPublicUrl({ resolve: resolverOf(['example.com']), transport }, 'http://example.com/'));
    expect(code).toBe('connect_failed');
    expect(message).toContain('example.com');
  });

  test('an answer that is not HTTP is a bad response, and a refused connection a failed one', async () => {
    const site = await answering('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Length: 3\r\n\r\nokk', 'stay');
    const { transport } = routed({ 'example.com': site.port });
    const resolve = resolverOf(['example.com']);
    const [code, message] = await failure(fetchPublicUrl({ resolve, transport }, 'http://example.com/'));
    expect(code).toBe('bad_response');
    expect(message).toContain('example.com');
    const nowhere = routed({ 'example.com': await unusedPort() });
    const [refusedCode, refusedMessage] = await failure(fetchPublicUrl({ resolve, transport: nowhere.transport }, 'http://example.com/'));
    expect(refusedCode).toBe('connect_failed');
    expect(refusedMessage).toContain('ECONNREFUSED');
  });

  test.skipIf(certificates === null)('a certificate is verified against the name of each hop, not the address connected to', async () => {
    const site = await answering('HTTP/1.1 200 OK\r\nContent-Length: 6\r\n\r\nsecure', 'close', { secure: certificates!.good });
    const { transport } = routed({ 'pinned.example.test': site.port, 'other.example.test': site.port }, { ca: certificates!.ca });
    const resolve = resolverOf(['pinned.example.test', 'other.example.test']);
    const result = await fetchPublicUrl({ resolve, transport }, 'https://pinned.example.test/');
    expect(text(result.body)).toBe('secure');
    const [code, message] = await failure(fetchPublicUrl({ resolve, transport }, 'https://other.example.test/'));
    expect(code).toBe('connect_failed');
    expect(message).toContain('other.example.test');
    // Without the authority the same site is not trusted.
    const untrusting = routed({ 'pinned.example.test': site.port });
    expect((await failure(fetchPublicUrl({ resolve, transport: untrusting.transport }, 'https://pinned.example.test/')))[0]).toBe('connect_failed');
  });
});

describe('the hub by default', () => {
  test('resolves with the system resolver and fetches with the socket transport', async () => {
    const ctx = createContext({ dbPath: ':memory:', config: makeConfig({ agentFetch: true }) });
    try {
      expect(ctx.agentFetch.resolve).toBe(systemResolver);
      const site = await answering('HTTP/1.1 302 Found\r\nLocation: /next\r\nContent-Length: 0\r\n\r\n');
      const response = await ctx.agentFetch.transport(pinned(site, { hostname: 'default.example.org', path: '/start' }), new AbortController().signal);
      // The 302 comes back as it is, and what went out are the socket transport's bytes: the Host of the name, the
      // fixed User-Agent, and a connection that is not kept.
      expect([response.status, response.headers.get('location')]).toEqual([302, '/next']);
      await Bun.sleep(30);
      expect(site.connections.map((connection) => connection.received())).toEqual([wire('default.example.org', '/start')]);
    } finally {
      ctx.db.close();
    }
  });
});
