import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRIDGE_ANSWERS } from '@agflow/core';
import { updateAttempt } from '@agflow/hub/src/attempt-store';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { saveCredentials } from '../src/credentials';
import { REQUIRED_RUNNER_ENV } from '../src/mcp/server';
import { runnerLeadTools, runnerWorkerTools } from '../src/mcp/runner-tools';
import { type HubFixture, type RunnerAgent, hubFixture } from './fixture';

const MAIN = join(import.meta.dir, '..', 'src', 'main.ts');

/** This process's environment without the agflow variables, so a test sets exactly the ones it means. */
const baseEnv = (): Record<string, string> =>
  Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith('AGFLOW_')));

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface ServedHub {
  hub: HubFixture;
  url: string;
  /** The requests the hub received, as 'METHOD /path'. */
  requests: string[];
}

/** The fixture's hub on a real port, counting the requests it gets. */
function serveHub(): ServedHub {
  const hub = hubFixture();
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      requests.push(`${request.method} ${new URL(request.url).pathname}`);
      return hub.app.fetch(request);
    },
  });
  cleanups.push(() => server.stop(true));
  return { hub, url: `http://localhost:${server.port}`, requests };
}

/** A port nothing listens on. */
function closedPortUrl(): string {
  const server = Bun.serve({ port: 0, fetch: () => new Response() });
  const url = `http://localhost:${server.port}`;
  server.stop(true);
  return url;
}

/** The variables a runner gives the bridge of the agent's attempt. */
function runnerEnv(agent: RunnerAgent, hubUrl: string, configDir = mkdtempSync(join(tmpdir(), 'agflow-run-config-'))): Record<string, string> {
  return {
    AGFLOW_AGENT_TOKEN: agent.token,
    AGFLOW_HUB_URL: hubUrl,
    AGFLOW_ATTEMPT_ID: agent.attempt.id,
    AGFLOW_ROLE: agent.attempt.role,
    AGFLOW_CONFIG_DIR: configDir,
    AGFLOW_BRIDGE_POLL_MS: '10',
    AGFLOW_BRIDGE_POLL_MAX_MS: '1000',
  };
}

/** `agflow mcp` over stdio with these arguments and agflow variables. */
async function bridge(args: string[], env: Record<string, string>): Promise<Client> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [MAIN, 'mcp', ...args], env: { ...baseEnv(), ...env }, stderr: 'ignore' });
  const client = new Client({ name: 'agflow-test', version: '0.0.0' });
  await client.connect(transport);
  cleanups.push(() => client.close());
  return client;
}

/** A tool call's text and whether it is an error result. */
async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { text: string }[]).map((part) => part.text).join('\n');
  return { text, isError: result.isError === true };
}

describe('agflow mcp --runner', () => {
  test('lists the worker or the lead tools according to AGFLOW_ROLE; without --runner the live bridge lists its 30 tools including fetch_submission, whatever the environment', async () => {
    const { hub, url } = serveHub();
    const names = async (client: Client) => (await client.listTools()).tools.map((tool) => tool.name);
    const worker = await bridge(['--vendor', 'claude', '--runner'], runnerEnv(hub.runnerAgent(), url));
    expect(await names(worker)).toEqual(runnerWorkerTools.map((tool) => tool.name));
    const lead = await bridge(['--vendor', 'codex', '--runner'], runnerEnv(hub.runnerAgent({ role: 'lead' }), url));
    expect(await names(lead)).toEqual(runnerLeadTools.map((tool) => tool.name));
    // Every runner variable, but no --runner: the runner mode is never inferred from the environment (design 10).
    const liveDir = mkdtempSync(join(tmpdir(), 'agflow-cfg-'));
    saveCredentials({ hubUrl: url, token: hub.tokenFor('alice'), user: 'alice' }, liveDir);
    const live = await bridge(['--vendor', 'claude'], { ...runnerEnv(hub.runnerAgent(), url), AGFLOW_CONFIG_DIR: liveDir });
    const liveNames = await names(live);
    expect(liveNames).toHaveLength(30);
    expect(liveNames).toContain('fetch_submission');
    expect(liveNames).toContain('claim_task');
    expect(liveNames).not.toContain('request_agents');
    // A live chat has a network of its own: the hub fetches only for runner agents.
    expect(liveNames).not.toContain('fetch_url');
    // M1's hello, which asks the hub about the code, not the runner's "already connected".
    const hello = await call(live, 'hello', { code: 'ZZZZZZ' });
    expect(hello.isError).toBe(true);
    expect(hello.text).toStartWith('agflow hub: ');
  }, 30_000);

  test('each missing required variable makes the process exit non-zero and name it', async () => {
    const { hub, url } = serveHub();
    const env = runnerEnv(hub.runnerAgent(), url);
    expect(REQUIRED_RUNNER_ENV).toEqual(['AGFLOW_AGENT_TOKEN', 'AGFLOW_HUB_URL', 'AGFLOW_ATTEMPT_ID', 'AGFLOW_ROLE', 'AGFLOW_CONFIG_DIR']);
    const runs = REQUIRED_RUNNER_ENV.map(async (name) => {
      const { [name]: _missing, ...rest } = env;
      const child = Bun.spawn([process.execPath, MAIN, 'mcp', '--vendor', 'claude', '--runner'], {
        env: { ...baseEnv(), ...rest },
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const code = await child.exited;
      return { name, code, stderr: await new Response(child.stderr).text() };
    });
    for (const { name, code, stderr } of await Promise.all(runs)) {
      expect({ name, failed: code !== 0 }).toEqual({ name, failed: true });
      expect(stderr).toContain(name);
    }
    const child = Bun.spawn([process.execPath, MAIN, 'mcp', '--vendor', 'claude', '--runner'], {
      env: { ...baseEnv(), ...env, AGFLOW_ROLE: 'boss' },
      stdin: 'pipe',
      stderr: 'pipe',
    });
    expect(await child.exited).not.toBe(0);
    expect(await new Response(child.stderr).text()).toContain('AGFLOW_ROLE');
  }, 30_000);

  test('a credentials.json in AGFLOW_CONFIG_DIR is never read, and the hub receives no request until a tool is called', async () => {
    const served = serveHub();
    const other = serveHub();
    const configDir = mkdtempSync(join(tmpdir(), 'agflow-run-config-'));
    // The owner's sign-in to another hub, as if it had leaked into the attempt's config directory.
    saveCredentials({ hubUrl: other.url, token: other.hub.tokenFor('alice'), user: 'alice' }, configDir);
    const worker = served.hub.runnerAgent();
    const client = await bridge(['--vendor', 'claude', '--runner'], runnerEnv(worker, served.url, configDir));
    await client.listTools();
    expect(served.requests).toEqual([]);
    expect(await call(client, 'list_tasks')).toEqual({ text: expect.stringContaining(worker.task?.id as string), isError: false });
    expect(served.requests).toEqual(['GET /api/tasks']);
    expect(other.requests).toEqual([]);
  }, 30_000);

  test("hello answers 'already connected'", async () => {
    const { hub, url, requests } = serveHub();
    const client = await bridge(['--vendor', 'claude', '--runner'], runnerEnv(hub.runnerAgent(), url));
    expect(await call(client, 'hello', { code: 'ABC234' })).toEqual({ text: expect.stringContaining('already connected'), isError: false });
    expect(requests).toEqual([]);
  }, 30_000);

  test('401 attempt_ended answers with the hub reason, attempt_refenced the restarting text, and an unreachable hub the unreachable text in runner and live modes, each as an error result', async () => {
    const { hub, url } = serveHub();
    const ended = hub.runnerAgent();
    const endedBridge = await bridge(['--vendor', 'claude', '--runner'], runnerEnv(ended, url));
    updateAttempt(hub.ctx, ended.attempt.id, { status: 'ended', endReason: 'stopped', endedAt: hub.ctx.now() });
    expect(await call(endedBridge, 'list_tasks')).toEqual({ text: BRIDGE_ANSWERS.attemptEnded('stopped'), isError: true });
    expect(await call(endedBridge, 'submit', { task_id: ended.task?.id, summary: 'Done' })).toEqual({
      text: BRIDGE_ANSWERS.attemptEnded('stopped'),
      isError: true,
    });

    const refenced = hub.runnerAgent();
    const refencedBridge = await bridge(['--vendor', 'claude', '--runner'], runnerEnv(refenced, url));
    hub.ctx.db.run('UPDATE project SET epoch = 2');
    expect(await call(refencedBridge, 'check_inbox')).toEqual({ text: BRIDGE_ANSWERS.attemptRefenced, isError: true });

    const nowhere = closedPortUrl();
    const unreachable = await bridge(['--vendor', 'claude', '--runner'], runnerEnv(hubFixture().runnerAgent(), nowhere));
    expect(await call(unreachable, 'get_brief')).toEqual({ text: BRIDGE_ANSWERS.hubUnreachable, isError: true });
    const liveDir = mkdtempSync(join(tmpdir(), 'agflow-cfg-'));
    saveCredentials({ hubUrl: nowhere, token: 'cli_token', user: 'alice' }, liveDir);
    const live = await bridge(['--vendor', 'claude'], { AGFLOW_CONFIG_DIR: liveDir });
    expect(await call(live, 'list_tasks')).toEqual({ text: BRIDGE_ANSWERS.hubUnreachable, isError: true });
  }, 30_000);
});
