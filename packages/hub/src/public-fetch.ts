// One GET to a public site, made by the hub for an agent (design 5, Unattended options). The rules are in
// public-address.ts; this module applies them to every hop. A host is resolved once per hop, every address it resolves
// to must be public, and the connection goes to one of the addresses that were checked: the URL the transport requests
// names that address, with the host name only in the Host header and as the TLS server name. So nothing resolves the
// name a second time, and a resolver that answers differently later (DNS rebinding) cannot move the connection.
// Redirects are followed by hand, each target checked like the first URL. The resolver and the transport are passed
// in, so tests use tables and local servers.
import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { FetchRefusal, classifyAddress, parseFetchUrl } from './public-address';

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

/** One hop, as the transport makes it: to the address, for the host. */
export interface PinnedRequest {
  protocol: 'http:' | 'https:';
  /** The Host header and, for https, the name the certificate must be valid for. */
  hostname: string;
  /** The checked address the connection goes to. */
  address: string;
  family: 4 | 6;
  port: number;
  /** The path and query; the fragment is never sent. */
  path: string;
}

/** Makes one GET without following redirects or decompressing the body. */
export type Transport = (request: PinnedRequest, signal: AbortSignal) => Promise<Response>;

export interface PublicFetchDeps {
  resolve: Resolver;
  transport: Transport;
}

export interface PublicFetchLimits {
  /** For the whole request: every resolution, hop and the body. */
  timeoutMs: number;
  /** The largest body, after decompression. */
  maxBytes: number;
  maxRedirects: number;
}

export const PUBLIC_FETCH_LIMITS: Readonly<PublicFetchLimits> = Object.freeze({
  timeoutMs: 20_000,
  maxBytes: 10 * 1024 * 1024,
  maxRedirects: 5,
});

export interface PublicFetchOptions extends Partial<PublicFetchLimits> {
  /** Called with each redirect target once it passed the URL rules, before it is resolved; a rejection ends the fetch. */
  beforeHop?: ((url: URL) => Promise<void>) | undefined;
}

export interface PublicFetchResult {
  /** The status of the last hop. */
  status: number;
  finalUrl: string;
  /** The only response header passed on. */
  contentType: string | null;
  bytes: number;
  sha256: string;
  body: Uint8Array;
}

export type PublicFetchFailure =
  /** The URL, or a redirect target, breaks the URL rules. */
  | 'url_refused'
  /** The host resolves to an address that is not public. */
  | 'address_refused'
  | 'dns_failed'
  /** The connection, or its TLS handshake, failed. */
  | 'connect_failed'
  | 'too_many_redirects'
  | 'too_large'
  | 'timeout'
  /** The answer cannot be used: an encoding the hub did not ask for, a body that does not decompress. */
  | 'bad_response';

/** Why a fetch gave no answer; the message is written for the agent that asked. */
export class PublicFetchError extends Error {
  override name = 'PublicFetchError';
  constructor(
    readonly code: PublicFetchFailure,
    message: string,
    /**
     * What only the people who read the hub's log may know, never the agent: the address a refused name resolves to.
     * An agent told which internal address each name has could map the hub's network for whoever steers it.
     */
    readonly detail: string | null = null,
  ) {
    super(message);
  }
}

/** The operating system's resolver, with every address it knows for the name. */
export const systemResolver: Resolver = async (hostname) => {
  const answers = await lookup(hostname, { all: true, verbatim: true });
  return answers.map(({ address, family }) => ({ address, family: family === 6 ? 6 : 4 }));
};

/** The URL of one hop: the pinned address stands where the host name was. */
export function pinnedUrl(request: PinnedRequest): string {
  const host = request.family === 6 ? `[${request.address}]` : request.address;
  return `${request.protocol}//${host}:${request.port}${request.path}`;
}

/** The encodings the hub asks for and can undo within the size cap. */
const ACCEPT_ENCODING = 'gzip, br';

export interface PinnedTransportOptions {
  /** A certificate authority to trust besides the system's; tests pass their own. */
  ca?: string | undefined;
}

/**
 * The transport the hub uses. The request URL holds the address, so no name is looked up; the certificate is still
 * verified against the host name (Bun's tls.serverName). Nothing of the caller's is sent: no cookies, no
 * authorization, a fixed User-Agent. The connection is not reused, so a later request for another name on the same
 * address never rides on this one's handshake.
 */
export function createPinnedTransport(options: PinnedTransportOptions = {}): Transport {
  return (request, signal) => {
    const init: RequestInit & Record<string, unknown> = {
      method: 'GET',
      redirect: 'manual',
      signal,
      headers: {
        host: request.hostname,
        'user-agent': 'agflow-fetch/1.0',
        accept: '*/*',
        'accept-encoding': ACCEPT_ENCODING,
      },
      // The body is decompressed by hand, under the size cap.
      decompress: false,
      keepalive: false,
    };
    if (request.protocol === 'https:') {
      init.tls = { serverName: request.hostname, rejectUnauthorized: true, ...(options.ca ? { ca: options.ca } : {}) };
    }
    return fetch(pinnedUrl(request), init);
  };
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

const sizeText = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${Math.round(bytes / (1024 * 1024))} MB` : `${Math.round(bytes / 1024)} KB`;

const reasonOf = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  return (typeof code === 'string' && code ? code : message).split('\n')[0]?.slice(0, 200) ?? 'unknown error';
};

/** The URL of a hop, or url_refused; a redirect target says that it was one. */
function checkedUrl(raw: string, redirectedFrom: URL | null): URL {
  try {
    return parseFetchUrl(raw);
  } catch (error) {
    if (!(error instanceof FetchRefusal)) throw error;
    const where = redirectedFrom ? `${redirectedFrom.hostname} sent a redirect that is refused: ` : '';
    throw new PublicFetchError('url_refused', `${where}${error.message}`);
  }
}

/**
 * Downloads one public URL. Throws PublicFetchError when the rules refuse it or the site gives no usable answer; any
 * HTTP status is an answer. A body over the cap is an error, never a shorter success.
 */
export async function fetchPublicUrl(
  deps: PublicFetchDeps,
  rawUrl: string,
  options: PublicFetchOptions = {},
): Promise<PublicFetchResult> {
  const limits = {
    timeoutMs: options.timeoutMs ?? PUBLIC_FETCH_LIMITS.timeoutMs,
    maxBytes: options.maxBytes ?? PUBLIC_FETCH_LIMITS.maxBytes,
    maxRedirects: options.maxRedirects ?? PUBLIC_FETCH_LIMITS.maxRedirects,
  };
  let url = checkedUrl(rawUrl, null);
  const deadline = new AbortController();
  const expired = new Promise<never>((_resolve, reject) => {
    deadline.signal.addEventListener('abort', () => reject(deadline.signal.reason), { once: true });
  });
  // Nothing may be left waiting on it once the fetch has ended.
  expired.catch(() => {});
  const timer = setTimeout(() => deadline.abort(new PublicFetchError('timeout', 'timeout')), limits.timeoutMs);
  /** The step's outcome, or the deadline if that comes first, whatever the step itself does about the signal. */
  const within = <T>(step: Promise<T>): Promise<T> => Promise.race([step, expired]);
  const timedOut = (): PublicFetchError =>
    new PublicFetchError(
      'timeout',
      `${url.hostname} did not answer within ${Math.round(limits.timeoutMs / 1000)} seconds, redirects included`,
    );
  try {
    for (let hop = 0; ; hop += 1) {
      const request = await within(pin(deps.resolve, url, hop > 0)).catch((error: unknown) => {
        throw deadline.signal.aborted ? timedOut() : error;
      });
      let response: Response;
      try {
        response = await within(deps.transport(request, deadline.signal));
      } catch (error) {
        if (deadline.signal.aborted) throw timedOut();
        // A failure the transport named itself says more: an answer that is not HTTP is no failure to connect.
        if (error instanceof PublicFetchError) throw error;
        throw new PublicFetchError('connect_failed', `could not connect to ${url.hostname}: ${reasonOf(error)}`);
      }
      const location = REDIRECTS.has(response.status) ? response.headers.get('location') : null;
      if (location === null) {
        const body = await readBody(response, limits.maxBytes, within, url).catch((error: unknown) => {
          throw deadline.signal.aborted ? timedOut() : error;
        });
        return {
          status: response.status,
          finalUrl: url.href,
          contentType: response.headers.get('content-type')?.slice(0, 255) ?? null,
          bytes: body.length,
          sha256: createHash('sha256').update(body).digest('hex'),
          body,
        };
      }
      // A redirect's own body is never read.
      void response.body?.cancel().catch(() => {});
      if (hop >= limits.maxRedirects) {
        throw new PublicFetchError('too_many_redirects', `${rawUrl} redirected more than ${limits.maxRedirects} times`);
      }
      const target = URL.parse(location, url.href);
      // What cannot be read as a URL goes to the rules as it came, so the refusal says what is wrong with it.
      const next = checkedUrl(target?.href ?? location, url);
      if (options.beforeHop) {
        // The hook's own refusal passes through as it is; only the deadline is reworded.
        await within(options.beforeHop(next)).catch((error: unknown) => {
          throw deadline.signal.aborted ? timedOut() : error;
        });
      }
      url = next;
    }
  } finally {
    clearTimeout(timer);
    // Ends whatever the transport still holds open: a body cut off at the cap, a hop that lost against the deadline.
    deadline.abort(new PublicFetchError('timeout', 'the fetch has ended'));
  }
}

/** Resolves the hop's host, refuses it unless every address is public, and pins one of them. */
async function pin(resolve: Resolver, url: URL, redirected: boolean): Promise<PinnedRequest> {
  const host = url.hostname;
  let addresses: ResolvedAddress[];
  try {
    addresses = await resolve(host);
  } catch (error) {
    throw new PublicFetchError('dns_failed', `${host} could not be resolved: ${reasonOf(error)}`);
  }
  if (addresses.length === 0) throw new PublicFetchError('dns_failed', `${host} resolves to no address`);
  for (const { address } of addresses) {
    const kind = classifyAddress(address);
    if (kind !== 'public') {
      throw new PublicFetchError(
        'address_refused',
        `${redirected ? `a redirect leads to ${host}, which resolves` : `${host} resolves`} to an address that is not ` +
          `public (${kind}); the hub fetches only from public internet addresses`,
        `${host} resolves to ${address} (${kind})`,
      );
    }
  }
  // Every address passed, so any may be used; IPv4 first, as a server may have no IPv6 route.
  const chosen = addresses.find((entry) => entry.family === 4) ?? (addresses[0] as ResolvedAddress);
  const protocol = url.protocol as 'http:' | 'https:';
  return {
    protocol,
    hostname: host,
    address: chosen.address,
    family: chosen.family,
    port: protocol === 'https:' ? 443 : 80,
    path: `${url.pathname}${url.search}`,
  };
}

/**
 * The body, read as a stream and never past the cap, then decompressed with the cap as the output limit: a small
 * compressed body that would unpack to more is refused without ever being unpacked in full.
 */
async function readBody(
  response: Response,
  maxBytes: number,
  within: <T>(step: Promise<T>) => Promise<T>,
  url: URL,
): Promise<Uint8Array> {
  const tooLarge = (): PublicFetchError =>
    new PublicFetchError('too_large', `the answer from ${url.hostname} is larger than ${sizeText(maxBytes)}; nothing was saved`);
  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    void response.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  const encoding = (response.headers.get('content-encoding') ?? '').trim().toLowerCase();
  if (encoding !== '' && encoding !== 'identity' && encoding !== 'gzip' && encoding !== 'x-gzip' && encoding !== 'br') {
    // Refused before its body is downloaded: megabytes the hub could only throw away.
    void response.body?.cancel().catch(() => {});
    throw new PublicFetchError('bad_response', `${url.hostname} answered in an encoding the hub does not read (${encoding.slice(0, 40)})`);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body?.getReader();
  if (reader) {
    for (;;) {
      const { done, value } = await within(reader.read()).catch((error: unknown) => {
        void reader.cancel().catch(() => {});
        // The deadline passes through for the caller to word. Anything else is the connection breaking under the
        // body: the site has the request by then, so it is a failure of the fetch, never an unknown error.
        if (error instanceof PublicFetchError) throw error;
        throw new PublicFetchError('connect_failed', `the connection to ${url.hostname} broke while its answer was read: ${reasonOf(error)}`);
      });
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        void reader.cancel().catch(() => {});
        throw tooLarge();
      }
      chunks.push(value);
    }
  }
  const raw = Buffer.concat(chunks, total);
  if (raw.length === 0 || encoding === '' || encoding === 'identity') return raw;
  try {
    return encoding === 'br' ? brotliDecompressSync(raw, { maxOutputLength: maxBytes }) : gunzipSync(raw, { maxOutputLength: maxBytes });
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ERR_BUFFER_TOO_LARGE') throw tooLarge();
    throw new PublicFetchError('bad_response', `the answer from ${url.hostname} could not be decompressed`);
  }
}
