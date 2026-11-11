// An HTTP proxy that refuses everything (design 15.1). Tests point HTTPS_PROXY, HTTP_PROXY and ALL_PROXY at it, so any
// connection a vendor CLI tries to an external host is refused and recorded, and a test can assert that none
// succeeded. Local servers are reached through NO_PROXY and never pass through it.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RefusedRequest {
  /** connect: a CONNECT tunnel (https); http: a plain request with an absolute URI. */
  kind: 'connect' | 'http';
  method: string;
  /** host:port for a tunnel, the absolute URI for a plain request. */
  target: string;
  at: number;
}

export interface RefusingProxy {
  /** http://127.0.0.1:<port> */
  url: string;
  port: number;
  /** Every refused request, in arrival order. */
  refused: RefusedRequest[];
  close(): Promise<void>;
}

export async function startRefusingProxy(): Promise<RefusingProxy> {
  const refused: RefusedRequest[] = [];
  const server = createServer((request, response) => {
    const target = request.url ?? '';
    // A request in origin form ("GET /") was sent to the proxy as a server, not through it: nothing to record.
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) {
      response.writeHead(400, { 'content-type': 'text/plain' }).end('this is a refusing proxy\n');
      return;
    }
    refused.push({ kind: 'http', method: request.method ?? 'GET', target, at: Date.now() });
    response.writeHead(403, { 'content-type': 'text/plain' }).end('refused by the agflow test proxy\n');
  });
  server.on('connect', (request, socket) => {
    refused.push({ kind: 'connect', method: 'CONNECT', target: request.url ?? '', at: Date.now() });
    socket.on('error', () => {});
    socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    refused,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
