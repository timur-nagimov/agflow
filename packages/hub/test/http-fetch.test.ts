import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { FetchUrlResponseSchema } from '@agflow/core';
import { attemptLog } from '../src/attempt-store';
import { endAttempt } from '../src/attempts';
import { mintAgentToken } from '../src/auth';
import { grantFetch, revokeFetch } from '../src/agent-fetch';
import { listEvents } from '../src/events';
import { isAgentRouteAllowed } from '../src/http/agent-routes-allowed';
import type { PinnedRequest, Resolver, Transport } from '../src/public-fetch';
import { addRunnerAttempt, addRunnerLead } from './helpers';
import { createTestHub } from './http-helpers';

type Hub = ReturnType<typeof createTestHub>;
type Auth = Parameters<Hub['call']>[2];

const PUBLIC = '93.184.216.34';
const bearer = (token: string): Auth => ({ headers: { authorization: `Bearer ${token}` } });

/**
 * A hub that fetches from a script instead of the network: every *.example.com resolves to a public address, the
 * transport answers by host and path, and waiting for a host's slot moves the test clock.
 */
function setup(options: { agentFetch?: boolean; script?: Record<string, (request: PinnedRequest) => Response | Promise<Response>> } = {}) {
  const hub = createTestHub({ agentFetch: options.agentFetch ?? true });
  const resolved: string[] = [];
  const requests: PinnedRequest[] = [];
  const slept: number[] = [];
  const script = options.script ?? {};
  const resolve: Resolver = async (hostname) => {
    resolved.push(hostname);
    if (hostname === 'inside.example.com') return [{ address: '10.0.0.5', family: 4 }];
    if (hostname.endsWith('.example.com') || hostname === 'example.com') return [{ address: PUBLIC, family: 4 }];
    throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
  };
  const transport: Transport = async (request) => {
    requests.push(request);
    const answer = script[`${request.hostname}${request.path}`];
    return answer ? answer(request) : new Response(`page ${request.path}`, { headers: { 'content-type': 'text/html' } });
  };
  hub.ctx.agentFetch.resolve = resolve;
  hub.ctx.agentFetch.transport = transport;
  hub.ctx.agentFetch.sleep = async (ms) => {
    slept.push(ms);
    hub.clock.advance(ms);
  };
  const granted = addRunnerAttempt(hub.ctx);
  const ungranted = addRunnerAttempt(hub.ctx);
  const codex = addRunnerAttempt(hub.ctx, { vendor: 'codex' });
  const lead = addRunnerLead(hub.ctx);
  if (options.agentFetch ?? true) {
    grantFetch(hub.ctx, granted.task.id, `agent:${lead.agent.id}`, 'needs public data');
    grantFetch(hub.ctx, codex.task.id, `agent:${lead.agent.id}`, 'needs public data');
  }
  const callers = {
    granted: bearer(mintAgentToken(hub.ctx, granted.attempt)),
    ungranted: bearer(mintAgentToken(hub.ctx, ungranted.attempt)),
    codex: bearer(mintAgentToken(hub.ctx, codex.attempt)),
    lead: bearer(mintAgentToken(hub.ctx, lead.attempt)),
    web: { user: 'alice', via: 'web' } as Auth,
    cli: { user: 'alice' } as Auth,
    nobody: {} as Auth,
  };
  return { hub, granted, ungranted, codex, lead, callers, resolved, requests, slept };
}

const fetchUrl = (hub: Hub, auth: Auth, url = 'https://example.com/data') => hub.call('POST', '/api/fetch', { ...auth, body: { url } });
const notes = (hub: Hub, attemptId: string) => attemptLog(hub.ctx, attemptId).map((entry) => `${entry.kind}: ${entry.summary}`);

describe('who may fetch', () => {
  test('a Claude worker of a granted task and the lead may; everyone else is refused with a code of its own', async () => {
    const { hub, callers, ungranted, requests } = setup();
    for (const who of ['granted', 'lead'] as const) {
      const answer = await fetchUrl(hub, callers[who], `https://${who}.example.com/`);
      expect([who, answer.status]).toEqual([who, 200]);
    }
    expect(requests.map((request) => request.hostname)).toEqual(['granted.example.com', 'lead.example.com']);
    const refused: [keyof typeof callers, number, string][] = [
      ['ungranted', 403, 'fetch_not_granted'],
      ['codex', 403, 'fetch_vendor_refused'],
      ['web', 403, 'forbidden'],
      ['cli', 403, 'forbidden'],
      ['nobody', 401, 'unauthorized'],
    ];
    for (const [who, status, error] of refused) {
      const answer = await fetchUrl(hub, callers[who]);
      expect([who, answer.status, answer.json.error]).toEqual([who, status, error]);
    }
    expect(requests).toHaveLength(2);
    // The refusals tell the agent what to do next.
    const noGrant = await fetchUrl(hub, callers.ungranted);
    expect(noGrant.json.message).toContain(ungranted.task.id);
    expect(noGrant.json.message).toContain('send_message');
    expect(noGrant.json.message).toMatch(/which sites|the sites/);
    expect((await fetchUrl(hub, callers.codex)).json.message).toContain('Claude');
  });

  test('a live chat never fetches: neither with its CLI token and agent, nor as the seated live lead', async () => {
    const hub = createTestHub({ agentFetch: true });
    const worker = await hub.liveAgent('bob', 'live-worker');
    const lead = await hub.liveAgent('alice', 'live-lead', 'lead');
    for (const auth of [{ user: 'bob', agent: worker }, { user: 'alice', agent: lead }]) {
      const answer = await fetchUrl(hub, auth);
      expect([auth.user, answer.status, answer.json.error]).toEqual([auth.user, 403, 'forbidden']);
    }
  });

  test('an owner session cannot fetch as its runner agent, and an agent token cannot name another agent', async () => {
    const { hub, callers, lead, granted, requests } = setup();
    const impersonated = await fetchUrl(hub, { user: 'alice', agent: granted.agent.id });
    expect([impersonated.status, impersonated.json.error]).toEqual([403, 'forbidden']);
    const overridden = await fetchUrl(hub, { ...callers.ungranted, agent: lead.agent.id });
    expect([overridden.status, overridden.json.error]).toEqual([403, 'agent_not_allowed']);
    expect(requests).toEqual([]);
  });

  test('with AGFLOW_AGENT_FETCH off every agent is told so, whatever else would refuse it', async () => {
    const { hub, callers, requests, resolved } = setup({ agentFetch: false });
    for (const who of ['granted', 'ungranted', 'codex', 'lead'] as const) {
      const answer = await fetchUrl(hub, callers[who]);
      expect([who, answer.status, answer.json.error]).toEqual([who, 403, 'fetch_disabled']);
      expect(answer.json.message).toContain('AGFLOW_AGENT_FETCH');
    }
    for (const who of ['web', 'cli'] as const) expect([who, (await fetchUrl(hub, callers[who])).status]).toEqual([who, 403]);
    expect([requests, resolved]).toEqual([[], []]);
  });

  test('the checks come in order: the setting, the attempt, the vendor, the grant', async () => {
    const { hub, callers, codex, granted, lead, requests } = setup();
    // A Codex worker without a grant hears about its vendor, not about the grant.
    revokeFetch(hub.ctx, codex.task.id, 'user:alice');
    expect((await fetchUrl(hub, callers.codex)).json.error).toBe('fetch_vendor_refused');
    // A revoke takes effect on the next request.
    expect((await fetchUrl(hub, callers.granted)).status).toBe(200);
    revokeFetch(hub.ctx, granted.task.id, `agent:${lead.agent.id}`);
    expect((await fetchUrl(hub, callers.granted)).json.error).toBe('fetch_not_granted');
    // An attempt that ended has no token any more.
    endAttempt(hub.ctx, { attemptId: granted.attempt.id, trigger: 'stop', actor: 'user:alice' });
    const ended = await fetchUrl(hub, callers.granted);
    expect([ended.status, ended.json.error]).toEqual([401, 'attempt_ended']);
    expect(requests).toHaveLength(1);
  });

  test('a Codex lead may grant but not fetch', async () => {
    const { hub, lead, callers } = setup();
    hub.ctx.db.query("UPDATE attempts SET vendor = 'codex' WHERE id = $id").run({ id: lead.attempt.id });
    const answer = await fetchUrl(hub, callers.lead);
    expect([answer.status, answer.json.error]).toEqual([403, 'fetch_vendor_refused']);
  });

  test('the agent-token allowlist holds the route, and the body is strict', async () => {
    const { hub, callers } = setup();
    expect(isAgentRouteAllowed('POST', '/api/fetch')).toBe(true);
    expect(isAgentRouteAllowed('GET', '/api/fetch')).toBe(false);
    for (const body of [{}, { url: '' }, { url: 'https://example.com/', save_as: 'x' }, { url: `https://example.com/${'a'.repeat(2000)}` }]) {
      const answer = await hub.call('POST', '/api/fetch', { ...callers.lead, body });
      expect([answer.status, answer.json.error]).toEqual([400, 'bad_request']);
    }
  });
});

describe('what a fetch answers', () => {
  test('the status, the final URL, the content type, the size, the digest and the body in base64, and no headers', async () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252]);
    const { hub, callers } = setup({
      script: {
        'example.com/start': () => new Response(null, { status: 302, headers: { location: 'https://cdn.example.com/file.bin' } }),
        'cdn.example.com/file.bin': () => new Response(bytes, { headers: { 'content-type': 'application/octet-stream', 'set-cookie': 'session=1', etag: '"x"' } }),
      },
    });
    const answer = await fetchUrl(hub, callers.granted, 'http://example.com/start#part');
    expect(answer.status).toBe(200);
    expect(FetchUrlResponseSchema.parse(answer.json)).toEqual({
      status: 200,
      finalUrl: 'https://cdn.example.com/file.bin',
      contentType: 'application/octet-stream',
      bytes: 6,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bodyBase64: Buffer.from(bytes).toString('base64'),
    });
  });

  test("a site's own error status is an answer; what the hub refuses or cannot get is an error with its code", async () => {
    const { hub, callers, requests } = setup({
      script: {
        'example.com/missing': () => new Response('no such page', { status: 404 }),
        'example.com/huge': () => new Response('x', { headers: { 'content-length': String(11 * 1024 * 1024) } }),
        'example.com/loop': () => new Response(null, { status: 302, headers: { location: '/loop' } }),
        'example.com/inward': () => new Response(null, { status: 302, headers: { location: 'http://inside.example.com/admin' } }),
        'example.com/broken': () => {
          throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
        },
      },
    });
    const missing = await fetchUrl(hub, callers.lead, 'https://example.com/missing');
    expect([missing.status, missing.json.status, Buffer.from(missing.json.bodyBase64, 'base64').toString()]).toEqual([200, 404, 'no such page']);
    const cases: [string, number, string][] = [
      ['http://127.0.0.1/', 400, 'fetch_url_refused'],
      ['http://169.254.169.254/latest/meta-data/', 400, 'fetch_url_refused'],
      ['file:///etc/passwd', 400, 'fetch_url_refused'],
      ['https://example.com:8443/', 400, 'fetch_url_refused'],
      ['https://inside.example.com/', 400, 'fetch_address_refused'],
      ['https://example.com/inward', 400, 'fetch_address_refused'],
      ['https://nowhere.example.org/', 502, 'fetch_dns_failed'],
      ['https://example.com/broken', 502, 'fetch_connect_failed'],
      ['https://example.com/huge', 502, 'fetch_too_large'],
      ['https://example.com/loop', 502, 'fetch_too_many_redirects'],
    ];
    for (const [url, status, error] of cases) {
      hub.clock.advance(60_000);
      const answer = await fetchUrl(hub, callers.lead, url);
      expect([url, answer.status, answer.json.error]).toEqual([url, status, error]);
      expect(answer.json.bodyBase64).toBeUndefined();
    }
    expect(requests.some((request) => request.hostname === 'inside.example.com')).toBe(false);
  });

  test('a site that does not answer in time is 504 fetch_timeout', async () => {
    const { hub, callers } = setup({ script: { 'example.com/slow': () => new Promise<Response>(() => {}) } });
    hub.ctx.agentFetch.limits = { timeoutMs: 50 };
    const answer = await fetchUrl(hub, callers.lead, 'https://example.com/slow');
    expect([answer.status, answer.json.error]).toEqual([504, 'fetch_timeout']);
  });
});

describe('the audit trail', () => {
  test('every request the hub made or refused to make is one line in the attempt log, and no event', async () => {
    const { hub, callers, granted, lead } = setup({
      script: {
        'example.com/start': () => new Response(null, { status: 301, headers: { location: 'https://www.example.com/page' } }),
        'www.example.com/page': () => new Response('hello'),
        'example.com/missing': () => new Response('nope', { status: 404 }),
      },
    });
    const before = listEvents(hub.ctx.db).length;
    await fetchUrl(hub, callers.granted, 'http://example.com/start');
    hub.clock.advance(5_000);
    await fetchUrl(hub, callers.granted, 'https://example.com/missing');
    await fetchUrl(hub, callers.granted, 'http://10.0.0.1/admin');
    await fetchUrl(hub, callers.granted, 'https://inside.example.com/');
    await fetchUrl(hub, callers.lead, 'https://nowhere.example.org/x');
    expect(notes(hub, granted.attempt.id)).toEqual([
      'note: fetch GET http://example.com/start: 200, 5 bytes, from https://www.example.com/page',
      'note: fetch GET https://example.com/missing: 404, 4 bytes',
      'note: fetch GET http://10.0.0.1/admin: refused (url_refused), 0 bytes: the URL names an IP address; name the site by its DNS host name',
      'note: fetch GET https://inside.example.com/: refused (address_refused), 0 bytes: inside.example.com, which resolves to 10.0.0.5 (private); the hub fetches only from public internet addresses',
    ]);
    expect(notes(hub, lead.attempt.id)).toEqual([
      'note: fetch GET https://nowhere.example.org/x: failed (dns_failed), 0 bytes: nowhere.example.org could not be resolved: ENOTFOUND',
    ]);
    expect(listEvents(hub.ctx.db).length).toBe(before);
  });

  test('a request refused before any fetch leaves no line: the setting, the vendor, the grant', async () => {
    const { hub, callers, ungranted, codex } = setup();
    await fetchUrl(hub, callers.ungranted);
    await fetchUrl(hub, callers.codex);
    expect(notes(hub, ungranted.attempt.id)).toEqual([]);
    expect(notes(hub, codex.attempt.id)).toEqual([]);
  });

  test('a URL in the log is one clipped line, whatever the agent sent', async () => {
    const { hub, callers, lead } = setup();
    await hub.call('POST', '/api/fetch', { ...callers.lead, body: { url: `https://example.com/${'a'.repeat(1900)}` } });
    await hub.call('POST', '/api/fetch', { ...callers.lead, body: { url: 'https://example.com/a\nfetch GET https://forged.example.com/: 200' } });
    const lines = notes(hub, lead.attempt.id);
    expect(lines).toHaveLength(2);
    expect(lines[0]!.length).toBeLessThan(700);
    expect(lines[1]!.split('\n')).toHaveLength(1);
  });
});

describe('rate limits', () => {
  test('an attempt gets 120 requests in any 10 minutes, then 429 until one leaves the window', async () => {
    const { hub, callers, requests } = setup();
    for (let n = 0; n < 120; n += 1) {
      const answer = await fetchUrl(hub, callers.granted, `https://site${n}.example.com/`);
      expect([n, answer.status]).toEqual([n, 200]);
    }
    const refused = await fetchUrl(hub, callers.granted, 'https://one-more.example.com/');
    expect([refused.status, refused.json.error]).toEqual([429, 'fetch_rate_limited']);
    expect(refused.json.message).toContain('120');
    expect(requests).toHaveLength(120);
    // Another attempt is not held back.
    expect((await fetchUrl(hub, callers.lead, 'https://other.example.com/')).status).toBe(200);
    hub.clock.advance(10 * 60_000);
    expect((await fetchUrl(hub, callers.granted, 'https://one-more.example.com/')).status).toBe(200);
  });

  test('requests to one host are a second apart hub-wide: the next waits for its slot, and beyond 3 seconds it is 429', async () => {
    const { hub, callers, slept, requests } = setup();
    const url = 'https://example.com/a';
    expect((await fetchUrl(hub, callers.granted, url)).status).toBe(200);
    expect(slept).toEqual([0]);
    // The lead asks for the same host at the same moment: it waits a second.
    expect((await fetchUrl(hub, callers.lead, url)).status).toBe(200);
    expect(slept).toEqual([0, 1000]);
    // Five at the same moment: the slots at 0, 1, 2 and 3 seconds are taken, and a fifth would wait four.
    hub.ctx.agentFetch.sleep = async (ms) => void slept.push(ms);
    hub.clock.advance(10_000);
    slept.length = 0;
    const burst = [];
    for (const n of [1, 2, 3, 4, 5]) burst.push(await fetchUrl(hub, n % 2 ? callers.granted : callers.lead, `${url}?n=${n}`));
    expect(burst.map((answer) => answer.status)).toEqual([200, 200, 200, 200, 429]);
    const refused = burst[4]!;
    expect(refused.json.error).toBe('fetch_host_busy');
    expect(refused.json.message).toContain('example.com');
    expect(slept).toEqual([0, 1000, 2000, 3000]);
    expect(requests).toHaveLength(6);
    // The refused one reserved nothing: a second later the next slot is three seconds away again.
    hub.clock.advance(1000);
    expect((await fetchUrl(hub, callers.lead, url)).status).toBe(200);
    expect(slept.at(-1)).toBe(3000);
  });

  test('a redirect waits for the slot of the host it leads to', async () => {
    const { hub, callers, slept } = setup({
      script: { 'example.com/start': () => new Response(null, { status: 302, headers: { location: '/end' } }) },
    });
    expect((await fetchUrl(hub, callers.lead, 'https://example.com/start')).status).toBe(200);
    expect(slept).toEqual([0, 1000]);
  });

  test('an attempt has two fetches under way at most; an answer frees its place', async () => {
    const release: (() => void)[] = [];
    const { hub, callers, granted } = setup();
    const scripted = hub.ctx.agentFetch.transport;
    hub.ctx.agentFetch.transport = () => new Promise<Response>((resolve) => release.push(() => resolve(new Response('late'))));
    const first = fetchUrl(hub, callers.granted, 'https://a.example.com/');
    const second = fetchUrl(hub, callers.granted, 'https://b.example.com/');
    while (release.length < 2) await Bun.sleep(1);
    const third = await fetchUrl(hub, callers.granted, 'https://c.example.com/');
    expect([third.status, third.json.error]).toEqual([429, 'fetch_busy']);
    // Another attempt has places of its own.
    hub.ctx.agentFetch.transport = scripted;
    expect((await fetchUrl(hub, callers.lead, 'https://d.example.com/')).status).toBe(200);
    for (const done of release) done();
    expect([(await first).status, (await second).status]).toEqual([200, 200]);
    expect((await fetchUrl(hub, callers.granted, 'https://c.example.com/')).status).toBe(200);
    // The refused request made no fetch and left no line.
    expect(notes(hub, granted.attempt.id).filter((line) => line.includes('c.example.com'))).toHaveLength(1);
  });
});
