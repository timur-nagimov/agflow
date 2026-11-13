// The HTTP/1.1 client the hub fetches public URLs with (design 5, Unattended options): one GET on a socket that this
// module opens, reads and destroys itself. fetch() cannot do this job. It goes on downloading a response whose body
// was cancelled, it buffers a response's header block without a bound, and it obeys the proxy variables of the hub's
// environment, so the connection goes to the proxy and not to the address public-fetch.ts checked. Here the socket
// goes to the pinned address and nowhere else, everything read before the body is capped, the body is taken off the
// socket only as fast as the caller reads it, and the socket is destroyed the moment the answer is dropped.
// The site on the other end is hostile: what it sends is parsed strictly, and nothing of it reaches an error message.
import { type Socket, connect as connectTcp, isIP } from 'node:net';
import { type TLSSocket, checkServerIdentity, connect as connectTls, rootCertificates } from 'node:tls';
import { type PinnedRequest, PublicFetchError, type Transport } from './public-fetch';

export interface SocketTransportOptions {
  /** A certificate authority to trust besides the built-in ones; tests pass their own. */
  ca?: string | undefined;
  /** The most bytes read before the body: the status line and the headers, interim responses included. */
  headerMaxBytes?: number | undefined;
}

export const HEADER_MAX_BYTES = 64 * 1024;

/** How much of a body may wait for the caller to read it before the socket is paused. */
const BODY_WAITING_BYTES = 1024 * 1024;

/** And in how many pieces: a site that sends a byte at a time must not fill the hub with a million small buffers. */
const BODY_WAITING_PIECES = 1024;

/** The longest line that gives a chunk's size, extensions included. */
const CHUNK_LINE_MAX_BYTES = 1024;

/** How many interim (1xx) responses are skipped before the final one. */
const INTERIM_MAX = 3;

/** The response headers that are kept: the four the hub reads and the one that frames the body. */
const HEADERS_READ = new Set(['content-type', 'content-encoding', 'content-length', 'location', 'transfer-encoding']);

const HOST_NAME = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
/** Printable ASCII without the space: nothing in it can end the request line or start a header. */
const REQUEST_PATH = /^\/[\x21-\x7e]*$/;
const STATUS_LINE = /^HTTP\/1\.([01]) ([0-9]{3})(?: [^\x00\r]*)?$/;
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const CHUNK_SIZE_LINE = /^([0-9A-Fa-f]{1,12})[ \t]*(?:;[^\x00\r]*)?$/;

const printable = (text: string, max: number): string => text.replace(/[^\x20-\x7e]/g, '?').slice(0, max);

const sizeText = (bytes: number): string => `${Math.round(bytes / 1024)} KB`;

/**
 * Without the spaces and tabs around it. By hand: a pattern would start again at every space of a long run, and the
 * site chooses how long the run is.
 */
function trimmed(text: string): string {
  const blank = (at: number): boolean => text[at] === ' ' || text[at] === '\t';
  let start = 0;
  let end = text.length;
  while (start < end && blank(start)) start += 1;
  while (end > start && blank(end - 1)) end -= 1;
  return text.slice(start, end);
}

/** Why a socket failed: the error's code where it has one, never text the site could have chosen unseen. */
function reasonOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^[A-Za-z0-9_]{1,60}$/.test(code)) return code;
  return printable(error instanceof Error ? error.message : String(error), 120) || 'unknown error';
}

/**
 * The request, byte for byte. The URL rules (public-address.ts) already leave nothing in a host or a path that could
 * end a line; this is the transport's own guard, so that no caller can make it send two requests or a header of the
 * site's choosing.
 */
function requestBytes(request: PinnedRequest): Buffer {
  const refuse = (why: string): PublicFetchError => new PublicFetchError('url_refused', `the hub does not send this request: ${why}`);
  if (request.protocol !== 'http:' && request.protocol !== 'https:') throw refuse('it is neither http nor https');
  if (!HOST_NAME.test(request.hostname) || isIP(request.hostname) !== 0) throw refuse('its host is not a plain host name');
  if (!REQUEST_PATH.test(request.path)) throw refuse('its path holds a space or a character outside printable ASCII');
  // A name here would be looked up by the socket, and that answer nobody has checked.
  if (isIP(request.address) === 0) throw refuse('it is not pinned to an IP address');
  if (!Number.isInteger(request.port) || request.port < 1 || request.port > 65_535) throw refuse('its port is not a port');
  return Buffer.from(
    `GET ${request.path} HTTP/1.1\r\nHost: ${request.hostname}\r\nUser-Agent: agflow-fetch/1.0\r\nAccept: */*\r\nAccept-Encoding: gzip, br\r\nConnection: close\r\n\r\n`,
    'latin1',
  );
}

/** The socket is given an address, so it has nothing to look up; if it ever tried, the connection fails. */
const neverLookup = (_hostname: string, _options: unknown, callback: (error: Error | null, address: string, family: number) => void): void => {
  callback(new Error('the transport resolves no name'), '', 4);
};

/** Takes a body off the socket's bytes, by one of the framings of RFC 9112. */
interface BodyDecoder {
  /** Hands the body's bytes among these to `take` and says whether the body is whole; throws when the framing is broken. */
  push(bytes: Buffer, take: (chunk: Buffer) => void): boolean;
  /** Whether the server closing the connection is how this body ends, and not a body cut short. */
  endsAtClose: boolean;
}

const lengthDecoder = (length: number): BodyDecoder => {
  let left = length;
  return {
    endsAtClose: false,
    push(bytes, take) {
      const size = Math.min(left, bytes.length);
      if (size > 0) take(bytes.subarray(0, size));
      left -= size;
      // What the server sends after the body is never looked at.
      return left === 0;
    },
  };
};

const untilCloseDecoder = (): BodyDecoder => ({
  endsAtClose: true,
  push(bytes, take) {
    if (bytes.length > 0) take(bytes);
    return false;
  },
});

/** Chunked transfer coding: the sizes are read, the extensions ignored, the trailers read and dropped under their cap. */
function chunkedDecoder(trailerMaxBytes: number, broken: (why: string) => PublicFetchError): BodyDecoder {
  let state: 'size' | 'data' | 'data-end' | 'trailers' = 'size';
  /** The line being read: a chunk's size, the line end after a chunk's data, or a trailer. */
  let line = '';
  let left = 0;
  let trailerBytes = 0;
  return {
    endsAtClose: false,
    push(bytes, take) {
      let at = 0;
      while (at < bytes.length) {
        if (state === 'data') {
          const size = Math.min(left, bytes.length - at);
          take(bytes.subarray(at, at + size));
          at += size;
          left -= size;
          if (left === 0) state = 'data-end';
          continue;
        }
        const feed = bytes.indexOf(0x0a, at);
        const end = feed === -1 ? bytes.length : feed + 1;
        line += bytes.toString('latin1', at, end);
        if (state === 'trailers') {
          trailerBytes += end - at;
          if (trailerBytes > trailerMaxBytes) throw broken(`the trailers of its chunked body are larger than ${sizeText(trailerMaxBytes)}`);
        } else if (state === 'data-end') {
          if (!'\r\n'.startsWith(line)) throw broken('a chunk of its body is longer than the size it gave');
        } else if (line.length > CHUNK_LINE_MAX_BYTES) {
          throw broken('the size of a chunk of its body is not given in one short line');
        }
        at = end;
        if (feed === -1) break;
        if (!line.endsWith('\r\n')) throw broken('a line of its chunked body does not end with CRLF');
        const content = line.slice(0, -2);
        line = '';
        if (state === 'data-end') {
          state = 'size';
        } else if (state === 'size') {
          const size = CHUNK_SIZE_LINE.exec(content);
          if (!size) throw broken('the size of a chunk of its body is not a hexadecimal number');
          left = Number.parseInt(size[1] as string, 16);
          state = left === 0 ? 'trailers' : 'data';
        } else if (content === '') {
          // The empty line after the last chunk and its trailers: the body is whole.
          return true;
        }
      }
      return false;
    },
  };
}

interface ResponseHead {
  /** The minor version of HTTP/1.x the server answered with. */
  minor: 0 | 1;
  status: number;
  /** The values of the headers the hub reads, by lower-case name, in the order they came. */
  fields: Map<string, string[]>;
}

/** How the body of a final response is framed (RFC 9112, section 6.3), or null when the status has none. */
function framingOf(head: ResponseHead, trailerMaxBytes: number, broken: (why: string) => PublicFetchError): { decoder: BodyDecoder; length: number | null } | null {
  // 205 asks for no content either, and a Response of that status can carry none.
  if (head.status === 204 || head.status === 205 || head.status === 304) return null;
  const codings = head.fields.get('transfer-encoding') ?? [];
  const lengths = head.fields.get('content-length') ?? [];
  if (codings.length > 0) {
    if (head.minor === 0) throw broken('a Transfer-Encoding from an HTTP/1.0 server');
    if (codings.length !== 1 || (codings[0] as string).toLowerCase() !== 'chunked') throw broken('a Transfer-Encoding other than chunked');
    // Two framings for one body is how a response is smuggled past a reader; neither is believed.
    if (lengths.length > 0) throw broken('both a Transfer-Encoding and a Content-Length');
    return { decoder: chunkedDecoder(trailerMaxBytes, broken), length: null };
  }
  if (lengths.length > 0) {
    if (!lengths.every((value) => /^[0-9]{1,15}$/.test(value))) throw broken('a Content-Length that is not a plain number');
    const length = Number(lengths[0]);
    if (lengths.some((value) => Number(value) !== length)) throw broken('Content-Length headers that differ');
    return { decoder: lengthDecoder(length), length };
  }
  return { decoder: untilCloseDecoder(), length: null };
}

/** The headers handed on with the answer: the few the hub reads, each cleaned to printable characters. */
function headersOf(head: ResponseHead, length: number | null, hasBody: boolean, broken: (why: string) => PublicFetchError): Headers {
  const headers = new Headers();
  const type = head.fields.get('content-type');
  if (type) headers.set('content-type', printable(type.join(', '), HEADER_MAX_BYTES));
  const locations = head.fields.get('location');
  if (locations) {
    if (locations.some((value) => value !== locations[0])) throw broken('Location headers that differ');
    // A URL holds no space and no byte outside ASCII: each is escaped, so the target stays the one the site named.
    const escaped = (locations[0] as string).replace(/[^\x21-\x7e]/g, (byte) => `%${byte.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
    headers.set('location', escaped);
  }
  // Nothing describes a body that is not there: a 304 may name the length and the encoding of what it did not send.
  if (hasBody) {
    const encoding = head.fields.get('content-encoding');
    if (encoding) headers.set('content-encoding', printable(encoding.join(', '), HEADER_MAX_BYTES));
    if (length !== null) headers.set('content-length', String(length));
  }
  return headers;
}

/**
 * The transport the hub uses: one GET per call on a connection of its own, to the address the request pins. For https
 * the certificate is verified against the request's host name, which also goes into the handshake (SNI). Nothing of
 * the caller's is sent: no cookies, no authorization, a fixed User-Agent. No proxy is used, no redirect followed, no
 * connection kept or reused. The answer carries the status, the few headers the hub reads and the body as the server
 * sent it, still compressed; the caller unpacks it under its own cap.
 *
 * The transport has no deadline of its own: the signal ends a request at any point, and a caller that cancels the
 * body ends the download. Either destroys the socket at once.
 */
export function createSocketTransport(options: SocketTransportOptions = {}): Transport {
  const headerMaxBytes = options.headerMaxBytes ?? HEADER_MAX_BYTES;
  const authorities = options.ca ? [...rootCertificates, options.ca] : undefined;
  return (request, signal) =>
    new Promise<Response>((resolve, reject) => {
      const host = request.hostname;
      const outgoing = requestBytes(request);
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      const broken = (why: string): PublicFetchError => new PublicFetchError('bad_response', `${host} sent an answer the hub cannot read: ${why}`);

      /** 'over' once the socket is destroyed: nothing that arrives after that is looked at. */
      let phase: 'connecting' | 'head' | 'body' | 'over' = 'connecting';

      // The head: read line by line, so that a line that is wrong is an error when it arrives, not at the deadline.
      let line = '';
      let headBytes = 0;
      let interim = 0;
      let head: ResponseHead | null = null;

      // The body: what was taken off the socket and waits for the caller to read it.
      let decoder: BodyDecoder | null = null;
      const waiting: Buffer[] = [];
      let waitingBytes = 0;
      let paused = false;
      let whole = false;
      let errored = false;
      let stream: ReadableStreamDefaultController<Uint8Array> | null = null;
      /** Set while the caller waits for bytes that have not arrived. */
      let wanted: (() => void) | null = null;

      const socket: Socket =
        request.protocol === 'https:'
          ? connectTls({
              host: request.address,
              port: request.port,
              servername: host,
              rejectUnauthorized: true,
              ALPNProtocols: ['http/1.1'],
              lookup: neverLookup as never,
              ...(authorities ? { ca: authorities } : {}),
            })
          : connectTcp({ host: request.address, port: request.port, lookup: neverLookup as never });

      const release = (): void => {
        phase = 'over';
        signal.removeEventListener('abort', onAbort);
        socket.destroy();
      };

      /** Ends the request with an error: for the caller of the transport before the answer, for the body's reader after. */
      const fail = (error: unknown): void => {
        if (phase === 'over') return;
        const answered = phase === 'body';
        release();
        if (!answered) {
          reject(error);
          return;
        }
        waiting.length = 0;
        waitingBytes = 0;
        errored = true;
        stream?.error(error);
        wanted?.();
      };

      function onAbort(): void {
        fail(signal.reason);
      }

      /** Gives the body's reader the next bytes, or the end; false while there is nothing to give. */
      const deliver = (): boolean => {
        if (errored || !stream) return true;
        if (waiting.length > 0) {
          // Everything that waits goes out as one piece, so the reader holds no more pieces than it made reads.
          stream.enqueue(waiting.length === 1 ? (waiting[0] as Buffer) : Buffer.concat(waiting, waitingBytes));
          waiting.length = 0;
          waitingBytes = 0;
          if (paused && phase === 'body') {
            paused = false;
            socket.resume();
          }
          return true;
        }
        if (!whole) return false;
        stream.close();
        return true;
      };

      const readBody = (bytes: Buffer): void => {
        const pieces: Buffer[] = [];
        const done = (decoder as BodyDecoder).push(bytes, (piece) => pieces.push(piece));
        if (pieces.length > 0) {
          // One piece per read off the socket, however small the chunks the site cut its body into.
          const read = pieces.length === 1 ? (pieces[0] as Buffer) : Buffer.concat(pieces);
          waiting.push(read);
          waitingBytes += read.length;
        }
        if (done) {
          whole = true;
          release();
        } else if (!paused && (waitingBytes >= BODY_WAITING_BYTES || waiting.length >= BODY_WAITING_PIECES)) {
          // The caller reads slower than the site sends: the site waits, the hub does not buffer.
          paused = true;
          socket.pause();
        }
        wanted?.();
      };

      /** The final response's head is whole: the answer goes to the caller, and what follows on the socket is the body. */
      const answer = (final: ResponseHead, rest: Buffer): void => {
        const framing = framingOf(final, headerMaxBytes, broken);
        const headers = headersOf(final, framing?.length ?? null, framing !== null, broken);
        if (!framing) {
          release();
          resolve(new Response(null, { status: final.status, headers }));
          return;
        }
        decoder = framing.decoder;
        const body = new ReadableStream<Uint8Array>(
          {
            start(controller) {
              stream = controller;
            },
            pull() {
              if (deliver()) return undefined;
              return new Promise<void>((given) => {
                wanted = () => {
                  if (!deliver()) return;
                  wanted = null;
                  given();
                };
              });
            },
            cancel() {
              waiting.length = 0;
              waitingBytes = 0;
              if (phase !== 'over') release();
            },
          },
          // Nothing is taken ahead of the reader: what waits, waits here, where it is counted.
          { highWaterMark: 0 },
        );
        phase = 'body';
        resolve(new Response(body, { status: final.status, headers }));
        readBody(rest);
      };

      const readHead = (bytes: Buffer): void => {
        let at = 0;
        while (at < bytes.length) {
          const feed = bytes.indexOf(0x0a, at);
          const end = feed === -1 ? bytes.length : feed + 1;
          headBytes += end - at;
          if (headBytes > headerMaxBytes) throw broken(`its head is larger than ${sizeText(headerMaxBytes)}`);
          line += bytes.toString('latin1', at, end);
          at = end;
          // What cannot become a status line is refused before its line ends: such a server may never end it.
          if (!head && !'HTTP/1.'.startsWith(line.slice(0, 7))) throw broken('it does not start with an HTTP/1 status line');
          if (feed === -1) return;
          if (!line.endsWith('\r\n')) throw broken('a line of its head does not end with CRLF');
          const content = line.slice(0, -2);
          line = '';
          if (!head) {
            const status = STATUS_LINE.exec(content);
            if (!status) throw broken('it does not start with an HTTP/1 status line');
            head = { minor: status[1] === '0' ? 0 : 1, status: Number(status[2]), fields: new Map() };
          } else if (content !== '') {
            if (content.startsWith(' ') || content.startsWith('\t')) throw broken('a header continued on a second line');
            const colon = content.indexOf(':');
            if (colon < 1 || !HEADER_NAME.test(content.slice(0, colon)) || content.includes('\0') || content.includes('\r')) {
              throw broken('a header line that is not "name: value"');
            }
            const name = content.slice(0, colon).toLowerCase();
            if (HEADERS_READ.has(name)) {
              const values = head.fields.get(name) ?? [];
              values.push(trimmed(content.slice(colon + 1)));
              head.fields.set(name, values);
            }
          } else if (head.status >= 200 && head.status <= 599) {
            answer(head, bytes.subarray(at));
            return;
          } else {
            // An interim response has no body; the final one follows. 101 would switch to a protocol nobody asked for.
            if (head.status < 100 || head.status === 101 || head.status > 599) throw broken(`the status ${head.status}`);
            interim += 1;
            if (interim > INTERIM_MAX) throw broken(`more than ${INTERIM_MAX} interim responses`);
            head = null;
          }
        }
      };

      /** The connection is up and, for https, verified: the request goes out. */
      const send = (): void => {
        if (phase !== 'connecting') return;
        if (request.protocol === 'https:') {
          // The handshake has verified the certificate already; a socket that says otherwise gets no request.
          const secure = socket as TLSSocket;
          const unverified = secure.authorized ? checkServerIdentity(host, secure.getPeerCertificate()) : (secure.authorizationError ?? 'the certificate is not verified');
          if (unverified) {
            fail(new PublicFetchError('connect_failed', `could not connect to ${host}: ${reasonOf(unverified)}`));
            return;
          }
        }
        phase = 'head';
        socket.write(outgoing);
      };

      /** The server closed the connection: the end of a body that lasts until then, a failure anywhere else. */
      const onClosed = (): void => {
        if (phase === 'over') return;
        if (phase === 'body' && (decoder as BodyDecoder).endsAtClose) {
          whole = true;
          release();
          wanted?.();
          return;
        }
        const where = phase === 'body' ? 'before its answer was complete' : phase === 'head' ? 'before it answered' : 'before it was set up';
        fail(new PublicFetchError('connect_failed', `${host} closed the connection ${where}`));
      };

      signal.addEventListener('abort', onAbort, { once: true });
      socket.on(request.protocol === 'https:' ? 'secureConnect' : 'connect', send);
      socket.on('data', (bytes: Buffer) => {
        if (phase !== 'head' && phase !== 'body') return;
        try {
          if (phase === 'head') readHead(bytes);
          else readBody(bytes);
        } catch (error) {
          fail(error);
        }
      });
      socket.on('end', onClosed);
      socket.on('close', onClosed);
      socket.on('error', (error: unknown) => {
        const what = phase === 'connecting' ? `could not connect to ${host}` : `the connection to ${host} broke`;
        fail(new PublicFetchError('connect_failed', `${what}: ${reasonOf(error)}`));
      });
    });
}
