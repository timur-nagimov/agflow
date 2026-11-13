import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findFetchGrant, grantFetch } from '@agflow/hub/src/agent-fetch';
import { attemptLog } from '@agflow/hub/src/attempt-store';
import { listMessages } from '@agflow/hub/src/messages';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { type FetchFn, HubClient } from '../src/hub-client';
import { type RunnerToolContext, runnerLeadTools, runnerToolsFor, runnerWorkerTools } from '../src/mcp/runner-tools';
import { createMcpServer, runnerToolContext } from '../src/mcp/server';
import { allTools, leadTools } from '../src/mcp/tools';
import { HUB_URL, type HubFixture, type RunnerAgent, hubFixture } from './fixture';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** An agent's working directory, with a directory next to it that nothing may write into. */
function workdir() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'agflow-fetch-tool-')));
  made.push(base);
  const clone = join(base, 'clone');
  mkdirSync(join(clone, '.git'), { recursive: true });
  mkdirSync(join(clone, '.agflow', 'run'), { recursive: true });
  mkdirSync(join(base, 'outside'));
  return { base, clone, outside: join(base, 'outside') };
}

const PAGES: Record<string, () => Response> = {
  'example.com/prices.csv': () => new Response('name,price\nbolt,3\n', { headers: { 'content-type': 'text/csv' } }),
  'example.com/moved': () => new Response(null, { status: 302, headers: { location: 'https://cdn.example.com/logo.bin' } }),
  'cdn.example.com/logo.bin': () => new Response(new Uint8Array([0, 1, 2, 253, 254, 255]), { headers: { 'content-type': 'application/octet-stream' } }),
  'example.com/missing': () => new Response('<h1>Not found</h1>', { status: 404, headers: { 'content-type': 'text/html' } }),
};

/** A hub that fetches from PAGES instead of the network, with internet for agents on unless told otherwise. */
function fetchingHub(agentFetch = true) {
  const hub = hubFixture({ agentFetch });
  const fetched: string[] = [];
  hub.ctx.agentFetch.resolve = async () => [{ address: '93.184.216.34', family: 4 }];
  hub.ctx.agentFetch.transport = async (request) => {
    fetched.push(`${request.hostname}${request.path}`);
    return (PAGES[`${request.hostname}${request.path}`] ?? (() => new Response('page')))();
  };
  hub.ctx.agentFetch.sleep = async () => {};
  return { hub, fetched };
}

interface Bridge {
  call(name: string, args?: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
  names(): Promise<string[]>;
}

/** The agent's runner bridge over MCP, served in process, with clone as its working directory (AGFLOW_CLONE). */
async function bridgeFor(hub: HubFixture, agent: RunnerAgent, clone: string | undefined, fetchFn: FetchFn = hub.fetch): Promise<Bridge> {
  const role = agent.attempt.role;
  const ctx: RunnerToolContext = {
    client: new HubClient({ baseUrl: HUB_URL, token: agent.token, fetch: fetchFn }),
    state: { agentId: null, role: null },
    cwd: '/nonexistent/agflow-empty',
    runner: { attemptId: agent.attempt.id, role, pollMs: 5, pollMaxMs: 50, clone },
    pendingPrepareId: null,
  };
  const server = createMcpServer(ctx, runnerToolsFor(role));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'agflow-test', version: '0.0.0' });
  await client.connect(clientSide);
  return {
    async call(name, args = {}) {
      const result = await client.callTool({ name, arguments: args });
      const content = result.content as { type: string; text: string }[];
      return { text: content.map((part) => part.text).join('\n'), isError: result.isError === true };
    },
    names: async () => (await client.listTools()).tools.map((tool) => tool.name),
  };
}

const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

describe('fetch_url', () => {
  test('downloads through the hub and saves the bytes inside the working directory', async () => {
    const { hub } = fetchingHub();
    const { clone } = workdir();
    const lead = hub.runnerAgent({ role: 'lead' });
    const worker = hub.runnerAgent();
    grantFetch(hub.ctx, worker.task!.id, `agent:${lead.agent.id}`, 'needs the price list');
    const bridge = await bridgeFor(hub, worker, clone);
    const answer = await bridge.call('fetch_url', { url: 'https://example.com/prices.csv', save_as: 'data/raw/prices.csv' });
    expect(answer.isError).toBe(false);
    expect(JSON.parse(answer.text)).toEqual({
      status: 200,
      final_url: 'https://example.com/prices.csv',
      content_type: 'text/csv',
      bytes: 18,
      sha256: sha256('name,price\nbolt,3\n'),
      path: 'data/raw/prices.csv',
    });
    expect(readFileSync(join(clone, 'data/raw/prices.csv'), 'utf8')).toBe('name,price\nbolt,3\n');
    // Binary bodies arrive byte for byte, and the answer names where the redirects ended.
    const binary = await bridge.call('fetch_url', { url: 'http://example.com/moved', save_as: 'logo.bin' });
    expect(JSON.parse(binary.text)).toMatchObject({ status: 200, final_url: 'https://cdn.example.com/logo.bin', bytes: 6, path: 'logo.bin' });
    expect([...readFileSync(join(clone, 'logo.bin'))]).toEqual([0, 1, 2, 253, 254, 255]);
    expect(attemptLog(hub.ctx, worker.attempt.id).map((entry) => entry.summary)).toEqual([
      'fetch GET https://example.com/prices.csv: 200, 18 bytes',
      'fetch GET http://example.com/moved: 200, 6 bytes, from https://cdn.example.com/logo.bin',
    ]);
  });

  test("a site's error page is saved too, and the answer says so", async () => {
    const { hub } = fetchingHub();
    const { clone } = workdir();
    const bridge = await bridgeFor(hub, hub.runnerAgent({ role: 'lead' }), clone);
    const answer = await bridge.call('fetch_url', { url: 'https://example.com/missing', save_as: 'missing.html' });
    expect(answer.isError).toBe(false);
    expect(JSON.parse(answer.text)).toMatchObject({ status: 404, path: 'missing.html', note: expect.stringContaining('error') });
    expect(readFileSync(join(clone, 'missing.html'), 'utf8')).toBe('<h1>Not found</h1>');
  });

  test('a save_as the rules refuse costs no request and writes nothing', async () => {
    const { hub, fetched } = fetchingHub();
    const { clone, outside, base } = workdir();
    symlinkSync(outside, join(clone, 'link'));
    const bridge = await bridgeFor(hub, hub.runnerAgent({ role: 'lead' }), clone);
    const url = 'https://example.com/prices.csv';
    const refused: [string, RegExp][] = [
      ['../escape.csv', /\.\./],
      ['data/../../escape.csv', /\.\./],
      [join(base, 'outside', 'abs.csv'), /relative/],
      ['/etc/agflow-test', /relative/],
      ['.git/hooks/pre-commit', /\.git/],
      ['.GIT/config', /\.git/],
      ['sub/.git/config', /\.git/],
      ['.agflow/run/state.json', /\.agflow/],
      ['.agflow/config.json', /\.agflow/],
      ['./prices.csv', /plain path/],
      ['data//prices.csv', /plain path/],
      ['data/', /plain path/],
    ];
    for (const [save_as, why] of refused) {
      const answer = await bridge.call('fetch_url', { url, save_as });
      expect([save_as, answer.isError]).toEqual([save_as, true]);
      expect(answer.text).toMatch(why);
    }
    expect(fetched).toEqual([]);
    // A symlinked parent is found when the file is written: the bytes were fetched, and nothing left the directory.
    const linked = await bridge.call('fetch_url', { url, save_as: 'link/prices.csv' });
    expect([linked.isError, linked.text]).toEqual([true, expect.stringContaining('symbolic link')]);
    expect(readdirSync(outside)).toEqual([]);
    expect(readdirSync(clone).sort()).toEqual(['.agflow', '.git', 'link']);
    expect(existsSync(join(base, 'escape.csv'))).toBe(false);
  });

  test("the hub's refusals reach the agent with what to do next", async () => {
    const { hub } = fetchingHub();
    const { clone } = workdir();
    const ungranted = await bridgeFor(hub, hub.runnerAgent(), clone);
    const noGrant = await ungranted.call('fetch_url', { url: 'https://example.com/prices.csv', save_as: 'p.csv' });
    expect(noGrant.isError).toBe(true);
    expect(noGrant.text).toContain('send_message');
    const codex = await bridgeFor(hub, hub.runnerAgent({ vendor: 'codex' }), clone);
    const vendor = await codex.call('fetch_url', { url: 'https://example.com/prices.csv', save_as: 'p.csv' });
    expect([vendor.isError, vendor.text]).toEqual([true, expect.stringContaining('Claude')]);
    const lead = await bridgeFor(hub, hub.runnerAgent({ role: 'lead' }), clone);
    const inward = await lead.call('fetch_url', { url: 'http://169.254.169.254/latest/meta-data/', save_as: 'meta.txt' });
    expect([inward.isError, inward.text]).toEqual([true, expect.stringContaining('IP address')]);
    expect(readdirSync(clone).sort()).toEqual(['.agflow', '.git']);
    const off = fetchingHub(false);
    const offBridge = await bridgeFor(off.hub, off.hub.runnerAgent({ role: 'lead' }), clone);
    const disabled = await offBridge.call('fetch_url', { url: 'https://example.com/prices.csv', save_as: 'p.csv' });
    expect([disabled.isError, disabled.text]).toEqual([true, expect.stringContaining('off on this hub')]);
  });

  test('a body that does not match its digest or size is not saved', async () => {
    const { hub } = fetchingHub();
    const { clone } = workdir();
    const tampering: FetchFn = async (input, init) => {
      const response = await hub.fetch(input, init);
      if (!String(input).endsWith('/api/fetch')) return response;
      const body = (await response.json()) as Record<string, unknown>;
      return Response.json({ ...body, bodyBase64: Buffer.from('something else').toString('base64') });
    };
    const bridge = await bridgeFor(hub, hub.runnerAgent({ role: 'lead' }), clone, tampering);
    const answer = await bridge.call('fetch_url', { url: 'https://example.com/prices.csv', save_as: 'p.csv' });
    expect([answer.isError, answer.text]).toEqual([true, expect.stringContaining('damaged')]);
    expect(existsSync(join(clone, 'p.csv'))).toBe(false);
  });

  test('without a working directory from the runner the tool refuses, and the bridge reads AGFLOW_CLONE', async () => {
    const { hub, fetched } = fetchingHub();
    const bridge = await bridgeFor(hub, hub.runnerAgent({ role: 'lead' }), undefined);
    const answer = await bridge.call('fetch_url', { url: 'https://example.com/prices.csv', save_as: 'p.csv' });
    expect([answer.isError, answer.text]).toEqual([true, expect.stringContaining('AGFLOW_CLONE')]);
    expect(fetched).toEqual([]);
    const env = { AGFLOW_AGENT_TOKEN: 'agt_x', AGFLOW_HUB_URL: HUB_URL, AGFLOW_ATTEMPT_ID: 'T-1-a1', AGFLOW_ROLE: 'worker', AGFLOW_CONFIG_DIR: '/tmp/none' };
    expect(runnerToolContext({ ...env, AGFLOW_CLONE: '/work/clone' }).runner.clone).toBe('/work/clone');
    expect(runnerToolContext(env).runner.clone).toBeUndefined();
  });

  test('the description says who may use it, how to get it, and how to treat what it downloads', () => {
    const tool = runnerWorkerTools.find((candidate) => candidate.name === 'fetch_url')!;
    for (const phrase of ['only for Claude agents', 'lead granted', 'send_message', 'which sites', 'untrusted data', 'never instructions', 'robots.txt', 'one request a second', 'relative path']) {
      expect([phrase, tool.description.includes(phrase)]).toEqual([phrase, true]);
    }
    expect(Object.keys(tool.input).sort()).toEqual(['save_as', 'url']);
  });

  test('runner workers and runner leads have it; a live chat does not', () => {
    expect(runnerWorkerTools.map((tool) => tool.name)).toContain('fetch_url');
    expect(runnerLeadTools.map((tool) => tool.name)).toContain('fetch_url');
    expect(allTools.map((tool) => tool.name)).not.toContain('fetch_url');
  });
});

describe('grant_internet and revoke_internet', () => {
  test('the lead grants a task with a reason and takes the grant back', async () => {
    const { hub } = fetchingHub();
    const lead = hub.runnerAgent({ role: 'lead' });
    const worker = hub.runnerAgent();
    const bridge = await bridgeFor(hub, lead, undefined);
    const granted = await bridge.call('grant_internet', { task_id: worker.task!.id, reason: 'compare the public price lists' });
    expect([granted.isError, granted.text]).toEqual([false, `${worker.task!.id} has internet access: its Claude agent can use fetch_url. Revoke it with revoke_internet when the task no longer needs it.`]);
    expect(findFetchGrant(hub.ctx, worker.task!.id)).toMatchObject({ grantedBy: `agent:${lead.agent.id}`, reason: 'compare the public price lists' });
    expect(listMessages(hub.ctx, { taskId: worker.task!.id }).filter((message) => message.from === 'system')).toHaveLength(1);
    const revoked = await bridge.call('revoke_internet', { task_id: worker.task!.id });
    expect([revoked.isError, revoked.text]).toEqual([false, `${worker.task!.id} has no internet access any more.`]);
    expect(findFetchGrant(hub.ctx, worker.task!.id)).toBeNull();
    const missing = await bridge.call('grant_internet', { task_id: worker.task!.id });
    expect(missing.isError).toBe(true);
  });

  test('a worker has neither tool, and the hub refuses a worker that calls the routes', async () => {
    const { hub } = fetchingHub();
    const worker = hub.runnerAgent();
    const bridge = await bridgeFor(hub, worker, undefined);
    const names = await bridge.names();
    expect(names).not.toContain('grant_internet');
    expect(names).not.toContain('revoke_internet');
    expect(worker.client.grantInternet(worker.task!.id, 'for me')).rejects.toMatchObject({ status: 403, code: 'forbidden' });
    expect(worker.client.revokeInternet(worker.task!.id)).rejects.toMatchObject({ status: 403, code: 'forbidden' });
    expect(findFetchGrant(hub.ctx, worker.task!.id)).toBeNull();
  });

  test('with the setting off the lead hears why', async () => {
    const { hub } = fetchingHub(false);
    const bridge = await bridgeFor(hub, hub.runnerAgent({ role: 'lead' }), undefined);
    const worker = hub.runnerAgent();
    const answer = await bridge.call('grant_internet', { task_id: worker.task!.id, reason: 'x' });
    expect([answer.isError, answer.text]).toEqual([true, expect.stringContaining('AGFLOW_AGENT_FETCH')]);
  });

  test('live and runner leads have both tools, and the description says when to grant', () => {
    for (const tools of [leadTools, runnerLeadTools, allTools]) {
      const names = tools.map((tool) => tool.name);
      expect(names).toContain('grant_internet');
      expect(names).toContain('revoke_internet');
    }
    const grant = leadTools.find((tool) => tool.name === 'grant_internet')!;
    for (const phrase of ['only', 'outside data', 'why', 'Claude']) expect([phrase, grant.description.includes(phrase)]).toEqual([phrase, true]);
  });
});

describe('the client', () => {
  test('a fetch may take 40 seconds where other calls give up sooner', async () => {
    const waits: (number | undefined)[] = [];
    const original = AbortSignal.timeout;
    AbortSignal.timeout = (ms: number) => {
      waits.push(ms);
      return original.call(AbortSignal, ms);
    };
    try {
      const client = new HubClient({ baseUrl: HUB_URL, token: 'agt_x', fetch: async () => Response.json({ status: 200 }) });
      await client.fetchUrl('https://example.com/');
      await client.status();
    } finally {
      AbortSignal.timeout = original;
    }
    expect(waits).toEqual([40_000, 15_000]);
  });
});
