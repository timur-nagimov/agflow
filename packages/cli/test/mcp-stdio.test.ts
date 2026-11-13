import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { saveCredentials } from '../src/credentials';
import { hubFixture } from './fixture';

const cleanEnv = (extra: Record<string, string>) => ({
  ...(Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)) as Record<string, string>),
  ...extra,
});

test('agflow mcp speaks MCP over stdio and binds the chat with hello', async () => {
  const hub = hubFixture();
  const server = Bun.serve({ port: 0, fetch: hub.app.fetch });
  const dir = mkdtempSync(join(tmpdir(), 'agflow-cfg-'));
  saveCredentials({ hubUrl: `http://localhost:${server.port}`, token: hub.tokenFor('alice'), user: 'alice' }, dir);
  const live = hub.liveAgent('alice');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(import.meta.dir, '..', 'src', 'main.ts'), 'mcp', '--vendor', 'claude'],
    env: cleanEnv({ AGFLOW_CONFIG_DIR: dir }),
    stderr: 'inherit',
  });
  const client = new Client({ name: 'agflow-test', version: '0.0.0' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(28);
    expect(tools.find((t) => t.name === 'fetch_submission')?.inputSchema.properties).toHaveProperty('task_id');
    expect(tools.find((t) => t.name === 'claim_task')?.inputSchema.properties).toHaveProperty('id');
    const before = await client.callTool({ name: 'check_inbox', arguments: {} });
    expect(before.isError).toBe(true);
    const hello = await client.callTool({ name: 'hello', arguments: { code: live.helloCode } });
    expect(JSON.stringify(hello.content)).toContain(live.agentId);
    const inbox = await client.callTool({ name: 'check_inbox', arguments: {} });
    expect(inbox.isError).toBeFalsy();
    expect(JSON.stringify(inbox.content)).toContain('No new messages.');
    const invalid = await client.callTool({ name: 'get_task', arguments: { id: 'not-a-task' } });
    expect(invalid.isError).toBe(true);
  } finally {
    await client.close();
    server.stop(true);
  }
}, 30_000);
