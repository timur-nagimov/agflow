import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NewTaskSchema, type SubmitError } from '@agflow/core';
import { recordResult } from '@agflow/hub/src/commands';
import { requestSubmission } from '@agflow/hub/src/submissions';
import { tx } from '@agflow/hub/src/context';
import { updateGoal } from '@agflow/hub/src/goal';
import { onPrepared } from '@agflow/hub/src/prepare';
import { runningWorkers } from '@agflow/hub/src/scheduler';
import { onSubmitted } from '@agflow/hub/src/submissions';
import { getTask } from '@agflow/hub/src/task-store';
import { createTasks } from '@agflow/hub/src/tasks';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
// The runner's own list of these names, which its launches give the adapters; the CLI does not depend on the runner
// package, so the test reads its source.
import { BRIDGE_TOOL_NAMES } from '../../runner/src/adapters/bridge-tools';
import { type FetchFn, HubClient } from '../src/hub-client';
import { type RunnerToolContext, runnerLeadTools, runnerToolsFor, runnerWorkerTools } from '../src/mcp/runner-tools';
import { leadTools, workerTools } from '../src/mcp/tools';
import { createMcpServer } from '../src/mcp/server';
import { HUB_URL, type HubFixture, type RunnerAgent, hubFixture } from './fixture';

const HEAD = 'a'.repeat(40);
const REMOTE = 'b'.repeat(40);

interface Bridge {
  /** Calls a tool as the agent's MCP client would: the text and whether it is an error result. */
  call(name: string, args?: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
  /** GET requests to paths with this prefix, so far. */
  gets(prefix: string): number;
}

/**
 * The agent's runner bridge over MCP, served in process: the agent token as the bearer, no hello. Before the hub
 * answers the poll number `at` of a path with the prefix, decide runs, as the runner's outcome would arrive meanwhile;
 * the poll number `fail.at` finds the hub unreachable. The polls wait on a fake clock, so no test sleeps for real.
 */
async function bridgeFor(
  agent: RunnerAgent,
  options: { pollMaxMs?: number; decide?: { prefix: string; at: number; run: () => void }; fail?: { prefix: string; at: number } } = {},
): Promise<Bridge> {
  const hub = agentHub.get(agent) as HubFixture;
  const counts = new Map<string, number>();
  const fetchFn: FetchFn = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if ((init?.method ?? 'GET') === 'GET') {
      for (const prefix of ['/api/submissions/', '/api/prepare/', '/api/fetch-submission/']) {
        if (!path.startsWith(prefix)) continue;
        const count = (counts.get(prefix) ?? 0) + 1;
        counts.set(prefix, count);
        if (options.fail?.prefix === prefix && options.fail.at === count) throw new Error('ECONNRESET');
        if (options.decide?.prefix === prefix && options.decide.at === count) options.decide.run();
      }
    }
    return hub.fetch(input, init);
  };
  const role = agent.attempt.role;
  const clock = { t: 0 };
  const ctx: RunnerToolContext = {
    client: new HubClient({ baseUrl: HUB_URL, token: agent.token, fetch: fetchFn }),
    state: { agentId: null, role: null },
    cwd: '/tmp',
    runner: {
      attemptId: agent.attempt.id,
      role,
      clone: mkdtempSync(join(tmpdir(), 'agflow-bridge-clone-')),
      pollMs: 5,
      pollMaxMs: options.pollMaxMs ?? 5_000,
      now: () => clock.t,
      sleep: async (ms) => {
        clock.t += ms;
      },
    },
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
    gets: (prefix) => counts.get(prefix) ?? 0,
  };
}

/** The hub each runner agent was made on. */
const agentHub = new WeakMap<RunnerAgent, HubFixture>();

function runnerAgent(hub: HubFixture, role: 'worker' | 'lead' = 'worker'): RunnerAgent {
  const agent = hub.runnerAgent({ role });
  agentHub.set(agent, hub);
  return agent;
}

/** The runner's attempt.submitted for the agent's pending submission, as the hub applies it. */
function submitted(hub: HubFixture, agent: RunnerAgent, outcome: { error: SubmitError | null; detail?: string | null }): void {
  const row = hub.ctx.db.query("SELECT id FROM submissions WHERE attempt_id = $attemptId AND status = 'pending'").get({ attemptId: agent.attempt.id }) as {
    id: string;
  };
  const ok = outcome.error === null;
  const data = { submissionId: row.id, ok, headSha: HEAD, remoteHead: ok ? null : REMOTE, error: outcome.error, detail: outcome.detail ?? null };
  tx(hub.ctx, (emit) => onSubmitted(hub.ctx, emit, agent.attempt.runnerId as string, agent.attempt, { attemptId: agent.attempt.id, data }));
}

/** The runner's attempt.prepared for the agent's pending request. */
function prepared(hub: HubFixture, agent: RunnerAgent, outcome: { ok: boolean; error: string | null; logTail: string | null }): void {
  const row = hub.ctx.db.query("SELECT id FROM runner_commands WHERE attempt_id = $attemptId AND kind = 'prepare_dependencies'").get({
    attemptId: agent.attempt.id,
  }) as { id: string };
  tx(hub.ctx, (emit) => onPrepared(hub.ctx, emit, agent.attempt, { requestId: row.id, ...outcome }));
}

/**
 * The unattended options' tools (design 5, 6.10), which the bridge serves and the runner's list does not name: those
 * options leave the runner as it is. A Codex thread needs every name of the runner's list from its bridge and only
 * warns about others, so these are the whole difference between the two, and any other is a drift.
 */
const UNATTENDED_TOOLS = { worker: ['fetch_url'], lead: ['grant_internet', 'revoke_internet', 'list_approvals', 'decide_approval', 'fetch_url'] } as const;

const SHARED = ['hello', 'get_brief', 'get_goal', 'list_tasks', 'get_task', 'check_inbox', 'ack_messages', 'send_message', 'search'];

describe('the runner tool sets', () => {
  test('the worker set and the lead set contain exactly the section 10 tools; neither has claim_task or resume_claim, and the lead set has no submit', () => {
    expect(runnerWorkerTools.map((tool) => tool.name)).toEqual([
      ...SHARED,
      'report_progress',
      'write_handoff',
      'declare_blocked',
      'declare_impossible',
      'release_task',
      'submit',
      'prepare_dependencies',
      'fetch_url',
    ]);
    // A runner attempt's release stops the attempt: M1's answer, that the task is ready again, would be wrong.
    expect(runnerWorkerTools.find((tool) => tool.name === 'release_task')).not.toBe(workerTools.find((tool) => tool.name === 'release_task'));
    expect(runnerLeadTools.map((tool) => tool.name)).toEqual([
      ...SHARED,
      'get_status',
      'create_tasks',
      'update_task',
      'cancel_task',
      'accept_task',
      'reject_task',
      'unblock_task',
      'mark_merged',
      'add_goal_note',
      'get_events',
      'grant_internet',
      'revoke_internet',
      'request_agents',
      'replace_agent',
      'stop_agent',
      'write_handoff',
      'get_lead_notes',
      'fetch_submission',
      'list_approvals',
      'decide_approval',
      'fetch_url',
    ]);
    for (const tools of [runnerWorkerTools, runnerLeadTools]) {
      const names = tools.map((tool) => tool.name);
      expect(names).not.toContain('claim_task');
      expect(names).not.toContain('resume_claim');
      expect(new Set(names).size).toBe(names.length);
    }
    expect(runnerLeadTools.map((tool) => tool.name)).not.toContain('submit');
    expect(runnerToolsFor('worker')).toBe(runnerWorkerTools);
    expect(runnerToolsFor('lead')).toBe(runnerLeadTools);
  });

  test("the runner's BRIDGE_TOOL_NAMES are all served, and the bridge serves nothing more than them and the unattended options' tools", () => {
    for (const role of ['worker', 'lead'] as const) {
      const served = runnerToolsFor(role).map((tool) => tool.name);
      expect([...BRIDGE_TOOL_NAMES[role], ...UNATTENDED_TOOLS[role]].sort()).toEqual(served.sort());
    }
  });
});

describe("the unattended options' tools against the hub", () => {
  test("a runner lead grants and revokes a task's internet access with its agent token; a worker's bridge has no such tool", async () => {
    const hub = hubFixture({ agentFetch: true });
    const worker = runnerAgent(hub);
    const lead = runnerAgent(hub, 'lead');
    const taskId = worker.task?.id as string;
    const leadBridge = await bridgeFor(lead);
    expect(await leadBridge.call('grant_internet', { task_id: taskId, reason: 'It needs the published schema.' })).toEqual({
      text: expect.stringContaining(`${taskId} has internet access`),
      isError: false,
    });
    expect(getTask(hub.ctx, taskId).fetchGranted).toBe(true);
    const workerBridge = await bridgeFor(worker);
    expect((await workerBridge.call('grant_internet', { task_id: taskId, reason: 'mine' })).isError).toBe(true);
    expect((await workerBridge.call('revoke_internet', { task_id: taskId })).isError).toBe(true);
    expect(getTask(hub.ctx, taskId).fetchGranted).toBe(true);
    expect(await leadBridge.call('revoke_internet', { task_id: taskId })).toEqual({ text: expect.stringContaining(`${taskId} has no internet access`), isError: false });
    expect(getTask(hub.ctx, taskId).fetchGranted).toBe(false);
  });

  test('with the settings off the hub refuses the grant, the fetch and the approvals, each as an error result in its own words', async () => {
    const hub = hubFixture();
    const worker = runnerAgent(hub);
    const lead = runnerAgent(hub, 'lead');
    const leadBridge = await bridgeFor(lead);
    const grant = await leadBridge.call('grant_internet', { task_id: worker.task?.id, reason: 'docs' });
    expect(grant).toEqual({ text: expect.stringContaining('agflow hub: internet access for agents is off'), isError: true });
    for (const [name, args] of [
      ['list_approvals', {}],
      ['decide_approval', { id: '0b0e7c3a-5d1f-4c59-9d0e-2f6f3b1a7c11', decision: 'approve' }],
      ['fetch_url', { url: 'https://example.com/', save_as: 'page.html' }],
    ] as const) {
      const answer = await leadBridge.call(name, args);
      expect({ name, isError: answer.isError, fromHub: answer.text.startsWith('agflow hub: ') }).toEqual({ name, isError: true, fromHub: true });
    }
    const asWorker = await (await bridgeFor(worker)).call('fetch_url', { url: 'https://example.com/', save_as: 'page.html' });
    expect(asWorker).toEqual({ text: expect.stringMatching(/^agflow hub: /), isError: true });
  });
});

describe('submit', () => {
  test("polls until the submission is submitted and answers 'submitted at <sha>' as a normal result", async () => {
    const hub = hubFixture();
    const worker = runnerAgent(hub);
    const taskId = worker.task?.id as string;
    const bridge = await bridgeFor(worker, { decide: { prefix: '/api/submissions/', at: 3, run: () => submitted(hub, worker, { error: null }) } });
    const answer = await bridge.call('submit', { task_id: taskId, summary: 'Parser added', evidence: ['bun test: 3 pass'] });
    expect(answer).toEqual({ text: expect.stringContaining(`${taskId} submitted at ${HEAD}`), isError: false });
    expect(bridge.gets('/api/submissions/')).toBe(3);
    expect(getTask(hub.ctx, taskId)).toMatchObject({ status: 'submitted', submission: expect.objectContaining({ summary: 'Parser added' }) });
  });

  test('dirty, protected_paths and needs_merge are error results that say what to fix, the detail passed on unchanged', async () => {
    const details: Record<'dirty' | 'protected_paths' | 'needs_merge', string> = {
      dirty: 'the clone has uncommitted changes: notes.txt. Commit them, or remove what does not belong in the submission, then submit again.',
      protected_paths:
        'the branch changes protected paths, which agents may not change: .github/workflows/ci.yml. main has changed .github/workflows/ci.yml since your branch started: merge it rather than reverting them (`git fetch origin && git merge origin/main`), then submit again.',
      needs_merge: 'agflow/T-1-parser has commits on top of agflow work; run `git fetch origin && git merge origin/agflow/T-1-parser`',
    };
    const hub = hubFixture();
    for (const [code, detail] of Object.entries(details) as [SubmitError, string][]) {
      const worker = runnerAgent(hub);
      const bridge = await bridgeFor(worker, { decide: { prefix: '/api/submissions/', at: 1, run: () => submitted(hub, worker, { error: code, detail }) } });
      const answer = await bridge.call('submit', { task_id: worker.task?.id, summary: 'Done' });
      expect(answer.isError).toBe(true);
      expect(answer.text).toContain(`was refused (${code}): ${detail}`);
    }
    // A refusal without the runner's detail still says what to fix.
    const bare = runnerAgent(hub);
    const bridge = await bridgeFor(bare, { decide: { prefix: '/api/submissions/', at: 1, run: () => submitted(hub, bare, { error: 'dirty' }) } });
    const answer = await bridge.call('submit', { task_id: bare.task?.id, summary: 'Done' });
    expect(answer).toEqual({ text: expect.stringContaining('uncommitted changes. Commit them'), isError: true });
  });

  test('branch_moved, remote and interrupted are error results that say the work is safe in its WIP ref', async () => {
    const hub = hubFixture();
    for (const code of ['branch_moved', 'remote', 'interrupted'] as const) {
      const worker = runnerAgent(hub);
      const bridge = await bridgeFor(worker, { decide: { prefix: '/api/submissions/', at: 1, run: () => submitted(hub, worker, { error: code, detail: 'the runner says why' }) } });
      const answer = await bridge.call('submit', { task_id: worker.task?.id, summary: 'Done' });
      expect(answer.isError).toBe(true);
      expect(answer.text).toContain(`(${code})`);
      expect(answer.text).toContain('Your work is safe in your WIP ref.');
      expect(answer.text).toContain('the runner says why');
    }
  });

  test('after the poll limit it answers the pending message as a normal result', async () => {
    const hub = hubFixture();
    const worker = runnerAgent(hub);
    const bridge = await bridgeFor(worker, { pollMaxMs: 60 });
    const answer = await bridge.call('submit', { task_id: worker.task?.id, summary: 'Done' });
    expect(answer).toEqual({
      text: expect.stringContaining('submission pending; do not submit again; the result will arrive as a message'),
      isError: false,
    });
    // pollMaxMs / pollMs polls, one every 5 ms of the fake clock.
    expect(bridge.gets('/api/submissions/')).toBe(12);
  });

  test('a poll that finds the hub unreachable leaves the submission pending, and the polls go on', async () => {
    const hub = hubFixture();
    const worker = runnerAgent(hub);
    const bridge = await bridgeFor(worker, {
      fail: { prefix: '/api/submissions/', at: 2 },
      decide: { prefix: '/api/submissions/', at: 3, run: () => submitted(hub, worker, { error: null }) },
    });
    expect(await bridge.call('submit', { task_id: worker.task?.id, summary: 'Done' })).toEqual({
      text: expect.stringContaining(`${worker.task?.id} submitted at ${HEAD}`),
      isError: false,
    });
    const unlucky = runnerAgent(hub);
    const failing = await bridgeFor(unlucky, { pollMaxMs: 10, fail: { prefix: '/api/submissions/', at: 2 } });
    expect(await failing.call('submit', { task_id: unlucky.task?.id, summary: 'Done' })).toEqual({
      text: expect.stringContaining('submission pending; do not submit again'),
      isError: false,
    });
  });
});

describe('prepare_dependencies', () => {
  test('polls its request and reports the outcome and the log tail', async () => {
    const hub = hubFixture();
    const worker = runnerAgent(hub);
    const done = { ok: true, error: null, logTail: 'bun install v1.3.11\n3 packages installed' };
    const bridge = await bridgeFor(worker, { decide: { prefix: '/api/prepare/', at: 2, run: () => prepared(hub, worker, done) } });
    const answer = await bridge.call('prepare_dependencies');
    expect(answer).toEqual({ text: expect.stringContaining('The dependencies are prepared'), isError: false });
    expect(answer.text).toContain('> bun install v1.3.11\n> 3 packages installed');
    expect(bridge.gets('/api/prepare/')).toBe(2);

    const failing = runnerAgent(hub);
    const failed = { ok: false, error: 'bun install exited with code 1', logTail: 'error: lockfile had changes' };
    const again = await bridgeFor(failing, { decide: { prefix: '/api/prepare/', at: 1, run: () => prepared(hub, failing, failed) } });
    const refused = await again.call('prepare_dependencies');
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('failed: bun install exited with code 1');
    expect(refused.text).toContain('> error: lockfile had changes');

    const slow = runnerAgent(hub);
    const slowBridge = await bridgeFor(slow, { pollMaxMs: 40 });
    const requestsOf = () =>
      hub.ctx.db.query("SELECT id FROM runner_commands WHERE attempt_id = $id AND kind = 'prepare_dependencies'").all({ id: slow.attempt.id }) as {
        id: string;
      }[];
    const pending = await slowBridge.call('prepare_dependencies');
    const [request] = requestsOf();
    expect(pending).toEqual({ text: expect.stringContaining(`${request?.id} is still running`), isError: false });
    expect(pending.text).toContain('that call starts no new preparation');
    // Asked again while it runs: the same request.
    expect(await slowBridge.call('prepare_dependencies')).toEqual({ text: expect.stringContaining(`${request?.id} is still running`), isError: false });
    // Once it has failed, the next call reports that, and asks for no second preparation.
    prepared(hub, slow, { ok: false, error: 'lockfile mismatch', logTail: null });
    expect(await slowBridge.call('prepare_dependencies')).toEqual({ text: `The dependency preparation ${request?.id} failed: lockfile mismatch.`, isError: true });
    expect(requestsOf()).toEqual([{ id: request?.id as string }]);
  });
});

describe('fetch_submission', () => {
  function setup() {
    const hub = hubFixture();
    const lead = runnerAgent(hub, 'lead');
    const worker = runnerAgent(hub);
    const taskId = worker.task!.id;
    requestSubmission(hub.ctx, taskId, worker.agent, { summary: 'Ready', evidence: [] });
    submitted(hub, worker, { error: null });
    const finish = (ok: boolean) => {
      const row = hub.ctx.db.query("SELECT id FROM runner_commands WHERE kind = 'refresh_vault' AND attempt_id = ?").get(lead.attempt.id) as { id: string };
      recordResult(hub.ctx, lead.attempt.runnerId!, { commandId: row.id, ok,
        ...(ok ? { data: { refs: { [`refs/heads/${worker.task!.branch}`]: HEAD } } } : { error: 'fetch denied' }) });
    };
    return { hub, lead, worker, taskId, finish };
  }

  test('a live lead gets the branch and head with the own-remote instruction', async () => {
    const hub = hubFixture();
    const lead = hub.liveAgent('alice', 'lead');
    const worker = runnerAgent(hub);
    requestSubmission(hub.ctx, worker.task!.id, worker.agent, { summary: 'Ready', evidence: [] });
    submitted(hub, worker, { error: null });
    const result = await leadTools.find((tool) => tool.name === 'fetch_submission')!.run({ task_id: worker.task!.id }, {
      client: lead.client, state: { agentId: lead.agentId, role: 'lead' }, cwd: '/tmp',
    });
    expect(JSON.parse(result)).toEqual({ branch: worker.task!.branch, head_sha: HEAD, note: expect.stringContaining('own git remote') });
  });

  test.each([true, false])('polls the refresh and relays its result (ok=%s)', async (ok) => {
    const { lead, worker, taskId, finish } = setup();
    const bridge = await bridgeFor(lead, { decide: { prefix: '/api/fetch-submission/', at: 2, run: () => finish(ok) } });
    const result = await bridge.call('fetch_submission', { task_id: taskId });
    expect(result.isError).toBe(!ok);
    if (ok) expect(JSON.parse(result.text)).toEqual({ branch: worker.task!.branch, head_sha: HEAD });
    else expect(result.text).toContain('fetch denied');
    expect(bridge.gets('/api/fetch-submission/')).toBe(2);
  });

  test('an unanswered fetch has the polling budget and a later call reports its result without enqueuing again', async () => {
    const { hub, lead, taskId, finish } = setup();
    const bridge = await bridgeFor(lead, { pollMaxMs: 10 });
    const answer = await bridge.call('fetch_submission', { task_id: taskId });
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('still running');
    expect(bridge.gets('/api/fetch-submission/')).toBe(2);
    finish(false);
    expect((await bridge.call('fetch_submission', { task_id: taskId })).text).toContain('fetch denied');
    expect(hub.ctx.db.query("SELECT id FROM runner_commands WHERE kind = 'refresh_vault' AND attempt_id = ?").all(lead.attempt.id)).toHaveLength(1);
  });
});

describe('lead tools', () => {
  test("request_agents reports the running count and the target; stop_agent (with hold) and replace_agent act on runner workers, and the hub's refusal for a lead comes back as an error result", async () => {
    const hub = hubFixture();
    const lead = runnerAgent(hub, 'lead');
    const first = runnerAgent(hub);
    const second = runnerAgent(hub);
    const bridge = await bridgeFor(lead);
    const staffing = await bridge.call('request_agents', { count: 3, reason: 'three ready tasks' });
    // Three run: the two workers, and the one addRunnerLead started to get a runner for the lead.
    expect(runningWorkers(hub.ctx)).toBe(3);
    expect(staffing).toEqual({ text: 'The target is 3 runner worker(s); 3 running now.', isError: false });
    expect(await bridge.call('request_agents', { count: 2, vendor: 'codex', reason: 'Codex for the parser work' })).toEqual({
      text: 'The target is 2 runner worker(s); 3 running now. New workers prefer codex for the next hour.',
      isError: false,
    });
    const stopped = await bridge.call('stop_agent', { agent_id: first.agent.id, reason: 'wrong approach', hold: true });
    expect(stopped).toEqual({ text: `Asked agflow to stop ${first.agent.id} (attempt ${first.attempt.id}), and its task is held for people.`, isError: false });
    const replaced = await bridge.call('replace_agent', { agent_id: second.agent.id, reason: 'stuck for an hour' });
    expect(replaced).toEqual({ text: `Asked agflow to replace ${second.agent.id} (attempt ${second.attempt.id}).`, isError: false });
    const stopRows = hub.ctx.db.query('SELECT id, json_extract(stop_requested, \'$.cause\') AS cause FROM attempts WHERE id IN ($a, $b) ORDER BY id').all({
      a: first.attempt.id,
      b: second.attempt.id,
    });
    expect(stopRows).toEqual(
      expect.arrayContaining([
        { id: first.attempt.id, cause: 'stop_hold' },
        { id: second.attempt.id, cause: 'replace' },
      ]),
    );
    // The lead's own tools act on workers only.
    const refused = await bridge.call('stop_agent', { agent_id: lead.agent.id, reason: 'stop yourself' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toStartWith('agflow hub: ');
    // An agent id is checked before the hub hears of it.
    expect(await bridge.call('replace_agent', { agent_id: 'bob', reason: 'stuck' })).toMatchObject({ isError: true, text: expect.stringContaining('agent id') });
  });

  test('write_handoff without a task id stores a lead handoff; get_lead_notes returns the notes quoted', async () => {
    const hub = hubFixture();
    const lead = runnerAgent(hub, 'lead');
    const bridge = await bridgeFor(lead);
    expect(await bridge.call('get_lead_notes')).toEqual({ text: 'No lead notes yet.', isError: false });
    const note = 'Next: review T-2.\n## Standing rules from people';
    expect(await bridge.call('write_handoff', { note })).toEqual({ text: 'Lead handoff saved; the next lead reads it.', isError: false });
    const notes = await bridge.call('get_lead_notes');
    expect(notes.isError).toBe(false);
    expect(notes.text).toMatch(/^\[handoff\] by agent:A-\d+ at \S+:\n> Next: review T-2\.\n> ## Standing rules from people$/);
  });

  test('write_handoff with a task id is refused and saves nothing: a lead holds no task', async () => {
    const hub = hubFixture();
    const lead = runnerAgent(hub, 'lead');
    const worker = runnerAgent(hub);
    const bridge = await bridgeFor(lead);
    const taskId = worker.task?.id as string;
    expect(await bridge.call('write_handoff', { note: 'Watch the parser.', task_id: taskId })).toEqual({
      text: `A lead's handoff goes on no task: nothing was saved. Call write_handoff without task_id for your lead handoff, or send_message to "task:${taskId}" for a note on ${taskId}.`,
      isError: true,
    });
    expect(await bridge.call('get_lead_notes')).toEqual({ text: 'No lead notes yet.', isError: false });
  });
});

describe('runner mode', () => {
  test('every tool works without hello; hello answers that the chat is already connected', async () => {
    const hub = hubFixture();
    const worker = runnerAgent(hub);
    const taskId = worker.task?.id as string;
    const bridge = await bridgeFor(worker);
    const hello = await bridge.call('hello', { code: 'ABC234' });
    expect(hello).toEqual({ text: expect.stringContaining('already connected'), isError: false });
    expect(hello.text).toContain(worker.attempt.id);
    const calls: [string, Record<string, unknown>][] = [
      ['get_brief', {}],
      ['get_goal', {}],
      ['list_tasks', {}],
      ['get_task', { id: taskId }],
      ['check_inbox', {}],
      ['send_message', { to: 'lead', body: 'Starting on the parser.' }],
      ['search', { query: 'parser' }],
      ['report_progress', { task_id: taskId, note: 'Tokenizer done' }],
      ['write_handoff', { task_id: taskId, note: 'Next: the AST.' }],
    ];
    for (const [name, args] of calls) expect({ name, ...(await bridge.call(name, args)) }).toMatchObject({ name, isError: false });
    const sent = (await bridge.call('send_message', { to: 'humans', body: 'Need a key.' })).text;
    const id = Number(sent.match(/#(\d+)/)?.[1]);
    expect(await bridge.call('ack_messages', { ids: [id] })).toMatchObject({ isError: false });

    // The terminal worker tools, each by a worker of its own.
    const terminal: [string, (taskId: string) => Record<string, unknown>][] = [
      ['declare_blocked', (id) => ({ task_id: id, reason: 'The API key is missing.' })],
      ['declare_impossible', (id) => ({ task_id: id, evidence: 'A1 and A2 contradict each other.' })],
      ['release_task', (id) => ({ task_id: id, reason: 'Wrong vendor for this.' })],
    ];
    const ended: Record<string, string> = {};
    for (const [name, args] of terminal) {
      const other = runnerAgent(hub);
      ended[name] = other.task?.id as string;
      const answer = await (await bridgeFor(other)).call(name, args(ended[name] as string));
      expect({ name, ...answer }).toMatchObject({ name, isError: false });
      if (name === 'release_task') {
        expect(answer.text).toBe(`Released ${ended[name]}: agflow stops this attempt, and the task goes back to ready once it has stopped. End your turn.`);
      }
    }

    updateGoal(hub.ctx, { text: 'Ship the parser.', baseVersion: 0 }, 'user:alice');
    const lead = runnerAgent(hub, 'lead');
    const leadBridge = await bridgeFor(lead);
    // Two submitted tasks to accept (then merge) and reject, and two ready ones to update and cancel.
    const submittedTask = async () => {
      const author = runnerAgent(hub);
      const bridge = await bridgeFor(author, { decide: { prefix: '/api/submissions/', at: 1, run: () => submitted(hub, author, { error: null }) } });
      expect(await bridge.call('submit', { task_id: author.task?.id, summary: 'Done' })).toMatchObject({ isError: false });
      return author.task?.id as string;
    };
    const [accepted, rejected] = [await submittedTask(), await submittedTask()];
    const [updated, cancelled] = createTasks(
      hub.ctx,
      ['Lexer', 'Linter'].map((title) => NewTaskSchema.parse({ title, objective: `Write the ${title}`, acceptance: [{ id: 'A1', assertion: 'works' }] })),
      'user:alice',
    ).map((task) => task.id);
    for (const [name, args] of [
      ['get_status', {}],
      ['get_events', {}],
      ['add_goal_note', { text: 'Parser first.' }],
      ['create_tasks', { tasks: [{ title: 'Docs', objective: 'Write docs', acceptance: [{ id: 'A1', assertion: 'Docs exist' }] }] }],
      ['update_task', { id: updated, patch: { priority: 1 } }],
      ['cancel_task', { id: cancelled, reason: 'Not needed after all.' }],
      ['accept_task', { id: accepted, note: 'Looks right.' }],
      ['mark_merged', { id: accepted }],
      ['reject_task', { id: rejected, feedback: 'A1 fails on empty input.' }],
      ['unblock_task', { id: ended.declare_blocked, note: 'The key is in the vault now.' }],
    ] as [string, Record<string, unknown>][]) {
      expect({ name, ...(await leadBridge.call(name, args)) }).toMatchObject({ name, isError: false });
    }
  });
});

