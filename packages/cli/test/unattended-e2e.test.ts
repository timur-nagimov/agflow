// The unattended options end to end (design 5, Unattended options): the bridge's tools against the hub's own routes,
// with no fake hub in between. Each side has its own tests against a stated contract; this file fails when the two
// drift apart.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Fence, RawRunnerEvent, RunnerEventData } from '@agflow/core';
import { findApproval } from '@agflow/hub/src/approvals';
import { getAttempt } from '@agflow/hub/src/attempt-store';
import { pendingCommands } from '@agflow/hub/src/commands';
import { applyRunnerEvents } from '@agflow/hub/src/events-in';
import type { PinnedRequest } from '@agflow/hub/src/public-fetch';
import { getTask } from '@agflow/hub/src/task-store';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { HubClient } from '../src/hub-client';
import { type RunnerToolContext, runnerToolsFor } from '../src/mcp/runner-tools';
import { createMcpServer } from '../src/mcp/server';
import { HUB_URL, type HubFixture, type RunnerAgent, hubFixture } from './fixture';

interface Bridge {
  clone: string;
  tools: string[];
  call(name: string, args?: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
}

/** The agent's runner bridge over MCP, served in process against the real hub app, with a clone of its own. */
async function bridgeFor(hub: HubFixture, agent: RunnerAgent): Promise<Bridge> {
  const clone = realpathSync(mkdtempSync(join(tmpdir(), 'agflow-e2e-clone-')));
  const role = agent.attempt.role;
  const ctx: RunnerToolContext = {
    client: new HubClient({ baseUrl: HUB_URL, token: agent.token, fetch: hub.fetch }),
    state: { agentId: null, role: null },
    cwd: '/tmp',
    runner: { attemptId: agent.attempt.id, role, clone, pollMs: 5, pollMaxMs: 50 },
    pendingPrepareId: null,
  };
  const server = createMcpServer(ctx, runnerToolsFor(role));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'agflow-test', version: '0.0.0' });
  await client.connect(clientSide);
  return {
    clone,
    tools: (await client.listTools()).tools.map((tool) => tool.name),
    async call(name, args = {}) {
      const result = await client.callTool({ name, arguments: args });
      const content = result.content as { type: string; text: string }[];
      return { text: content.map((part) => part.text).join('\n'), isError: result.isError === true };
    },
  };
}

/** A hub with both options on that fetches from a script: every *.example.com is a public address. */
function unattendedHub(): { hub: HubFixture; requests: PinnedRequest[] } {
  const hub = hubFixture({ agentFetch: true, leadApprovals: true });
  const requests: PinnedRequest[] = [];
  hub.ctx.agentFetch.resolve = async () => [{ address: '93.184.216.34', family: 4 }];
  hub.ctx.agentFetch.transport = async (request) => {
    requests.push(request);
    return new Response(`<html>${request.hostname}${request.path}</html>`, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  };
  hub.ctx.agentFetch.sleep = async (ms) => {
    hub.clock.t += ms;
  };
  return { hub, requests };
}

let seq = 0;

/** The runner relays the agent's approval request at its attempt's fence; returns the approval's id. */
function requestApproval(hub: HubFixture, asking: RunnerAgent, detail: RunnerEventData['approval.requested']['detail']): string {
  const approvalId = crypto.randomUUID();
  const fence: Fence = getAttempt(hub.ctx, asking.attempt.id).fence;
  const raw: RawRunnerEvent = {
    seq: ++seq,
    at: hub.ctx.now(),
    type: 'approval.requested',
    attemptId: asking.attempt.id,
    fence,
    data: { approvalId, kind: 'command', summary: 'Run command: curl https://example.com', detail },
  };
  applyRunnerEvents(hub.ctx, asking.attempt.runnerId as string, { outboxEpoch: 'outbox-e2e', events: [raw] }, { restoreReplay: false });
  expect(hub.ctx.db.query('SELECT error FROM runner_event_rejects').all()).toEqual([]);
  return approvalId;
}

/** Makes the runner's stored vendor reports say that a managed device policy applies. */
function setManaged(hub: HubFixture, runnerId: string): void {
  const row = hub.ctx.db.query('SELECT info FROM runners WHERE id = $id').get({ id: runnerId }) as { info: string };
  const info = JSON.parse(row.info) as { vendors: Record<string, unknown>[] };
  const vendors = info.vendors.map((vendor) => ({ ...vendor, managedPolicy: true }));
  hub.ctx.db.query('UPDATE runners SET info = $info WHERE id = $id').run({ id: runnerId, info: JSON.stringify({ ...info, vendors }) });
}

const LEAD_ONLY = ['grant_internet', 'revoke_internet', 'list_approvals', 'decide_approval'];

describe('internet through the hub, end to end', () => {
  test('a worker fetches only after the lead granted its task; a Codex worker never does; a revoke ends it', async () => {
    const { hub, requests } = unattendedHub();
    const lead = hub.runnerAgent({ role: 'lead' });
    const worker = hub.runnerAgent();
    const codex = hub.runnerAgent({ vendor: 'codex' });
    const [leadBridge, workerBridge, codexBridge] = await Promise.all([bridgeFor(hub, lead), bridgeFor(hub, worker), bridgeFor(hub, codex)]);
    const taskId = (worker.task as { id: string }).id;
    const codexTaskId = (codex.task as { id: string }).id;

    // A worker's bridge serves fetch_url and none of the lead's four tools.
    expect(workerBridge.tools).toContain('fetch_url');
    expect(workerBridge.tools.filter((name) => LEAD_ONLY.includes(name))).toEqual([]);
    expect(leadBridge.tools).toEqual(expect.arrayContaining(['fetch_url', ...LEAD_ONLY]));

    const before = await workerBridge.call('fetch_url', { url: 'https://afisha.example.com/events?page=1', save_as: 'data/raw/events-1.html' });
    expect(before.isError).toBe(true);
    expect(before.text).toContain('send_message');
    expect(requests).toHaveLength(0);

    const granted = await leadBridge.call('grant_internet', { task_id: taskId, reason: 'the task collects public event listings' });
    expect(granted.isError).toBe(false);
    expect(getTask(hub.ctx, taskId).fetchGranted).toBe(true);

    const saved = await workerBridge.call('fetch_url', { url: 'https://afisha.example.com/events?page=1', save_as: 'data/raw/events-1.html' });
    expect(saved.isError).toBe(false);
    expect(saved.text).toContain('data/raw/events-1.html');
    expect(readFileSync(join(workerBridge.clone, 'data', 'raw', 'events-1.html'), 'utf8')).toBe('<html>afisha.example.com/events?page=1</html>');
    expect(requests.map((request) => `${request.hostname}${request.path}`)).toEqual(['afisha.example.com/events?page=1']);

    // The lead needs no grant; a Codex agent gets none, granted or not.
    const leads = await leadBridge.call('fetch_url', { url: 'https://docs.example.com/', save_as: 'notes/docs.html' });
    expect(leads.isError).toBe(false);
    expect((await leadBridge.call('grant_internet', { task_id: codexTaskId, reason: 'same data' })).isError).toBe(false);
    const refused = await codexBridge.call('fetch_url', { url: 'https://afisha.example.com/', save_as: 'x.html' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('Claude');

    // A worker cannot grant: its bridge has no such tool, and the route refuses its token.
    expect((await workerBridge.call('grant_internet', { task_id: taskId, reason: 'me again' })).isError).toBe(true);
    await expect(worker.client.request('POST', `/api/tasks/${taskId}/fetch-grant`, { reason: 'me again' })).rejects.toThrow();

    expect((await leadBridge.call('revoke_internet', { task_id: taskId })).isError).toBe(false);
    expect(getTask(hub.ctx, taskId).fetchGranted).toBe(false);
    const after = await workerBridge.call('fetch_url', { url: 'https://afisha.example.com/events?page=2', save_as: 'data/raw/events-2.html' });
    expect(after.isError).toBe(true);
    expect(requests).toHaveLength(2);
  });
});

describe('approvals answered by the lead, end to end', () => {
  const detail = { command: 'curl https://example.com', cwd: '/clone', reason: 'needs the network' };

  test('the lead lists a request and approves it where no managed policy applies', async () => {
    const { hub } = unattendedHub();
    const lead = hub.runnerAgent({ role: 'lead' });
    const codex = hub.runnerAgent({ vendor: 'codex', owner: 'bob' });
    const leadBridge = await bridgeFor(hub, lead);
    const id = requestApproval(hub, codex, detail);

    const listing = await leadBridge.call('list_approvals');
    expect(listing.isError).toBe(false);
    expect(listing.text).toContain(id);
    expect(listing.text).toContain('you may: approve or decline it');
    expect(listing.text).toContain('> command: curl https://example.com');

    const answer = await leadBridge.call('decide_approval', { id, decision: 'approve' });
    expect(answer.isError).toBe(false);
    const approval = findApproval(hub.ctx, id);
    expect([approval?.status, approval?.decidedBy]).toEqual(['approved', `agent:${lead.agent.id}`]);
    expect((await leadBridge.call('list_approvals')).text).toBe('No approvals wait for your answer.');
  });

  test('on a managed device the lead may only decline, and the asking agent gets the reason', async () => {
    const { hub } = unattendedHub();
    const lead = hub.runnerAgent({ role: 'lead' });
    const codex = hub.runnerAgent({ vendor: 'codex', owner: 'bob' });
    const worker = hub.runnerAgent();
    setManaged(hub, codex.attempt.runnerId as string);
    const [leadBridge, workerBridge] = await Promise.all([bridgeFor(hub, lead), bridgeFor(hub, worker)]);
    const id = requestApproval(hub, codex, detail);

    expect((await leadBridge.call('list_approvals')).text).toContain('you may: decline only');
    const approve = await leadBridge.call('decide_approval', { id, decision: 'approve' });
    expect(approve.isError).toBe(true);
    expect(findApproval(hub.ctx, id)?.status).toBe('pending');
    expect((await leadBridge.call('decide_approval', { id, decision: 'decline' })).isError).toBe(true);

    const reason = 'work inside the sandbox; CI checks PostgreSQL after you submit';
    const decline = await leadBridge.call('decide_approval', { id, decision: 'decline', reason });
    expect(decline.isError).toBe(false);
    const approval = findApproval(hub.ctx, id);
    expect([approval?.status, approval?.decidedBy]).toEqual(['declined', `agent:${lead.agent.id}`]);
    const sent = pendingCommands(hub.ctx, codex.attempt.runnerId as string, 1)
      .map((row) => row.command)
      .filter((command) => command.kind === 'decide_approval');
    expect(sent).toMatchObject([{ approvalId: id, decision: 'decline', reason }]);

    // Another worker can neither list nor answer.
    expect((await workerBridge.call('list_approvals')).isError).toBe(true);
    expect((await workerBridge.call('decide_approval', { id, decision: 'decline', reason: 'no' })).isError).toBe(true);
  });
});
