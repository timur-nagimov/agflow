import { describe, expect, test } from 'bun:test';
import { addAgent } from './helpers';
import { createTestHub } from './http-helpers';

describe('message routes', () => {
  test('people and agents exchange messages; agents take and acknowledge their inbox', async () => {
    const hub = createTestHub();
    const worker = addAgent(hub.ctx, 'bob');
    const sent = await hub.call('POST', '/api/messages', { user: 'alice', via: 'web', body: { to: `agent:${worker.id}`, body: 'Use pnpm.' } });
    expect(sent.status).toBe(201);
    const inbox = await hub.call('POST', '/api/inbox', { user: 'bob', agent: worker.id });
    expect(inbox.json.messages.map((m: { body: string }) => m.body)).toEqual(['Use pnpm.']);
    const ack = await hub.call('POST', '/api/inbox/ack', { user: 'bob', agent: worker.id, body: { ids: [sent.json.message.id] } });
    expect(ack.json).toEqual({ ok: true });
    const reply = await hub.call('POST', '/api/messages', {
      user: 'bob',
      agent: worker.id,
      body: { to: 'humans', body: 'Done. npm is faster here, though.', replyTo: sent.json.message.id },
    });
    expect(reply.json.message.from).toBe(`agent:${worker.id}`);
    expect((await hub.call('GET', '/api/messages?target=humans', { user: 'alice', via: 'web' })).json.messages).toHaveLength(1);
  });

  test('broadcasts, standing rules and bare CLI tokens are restricted', async () => {
    const hub = createTestHub();
    const worker = addAgent(hub.ctx, 'bob');
    const lead = addAgent(hub.ctx, 'alice', 'lead');
    const send = (options: Parameters<typeof hub.call>[2]) => hub.call('POST', '/api/messages', options);
    expect((await send({ user: 'bob', agent: worker.id, body: { to: 'all', body: 'hi' } })).status).toBe(403);
    expect((await send({ user: 'alice', agent: lead.id, body: { to: 'all', body: 'hi' } })).status).toBe(201);
    expect((await send({ user: 'alice', agent: lead.id, body: { to: 'all', body: 'rule', standingRule: true } })).status).toBe(403);
    expect((await send({ user: 'alice', via: 'cli', body: { to: 'lead', body: 'x' } })).status).toBe(403);
    const rule = await send({ user: 'alice', via: 'web', body: { to: 'all', body: 'Always use pnpm.', standingRule: true } });
    expect((await hub.call('GET', '/api/rules', { user: 'bob', agent: worker.id })).json.rules).toHaveLength(1);
    expect((await hub.call('DELETE', `/api/rules/${rule.json.message.id}`, { user: 'alice', via: 'web' })).json).toEqual({ ok: true });
    expect((await hub.call('GET', '/api/rules', { user: 'alice', via: 'web' })).json.rules).toEqual([]);
  });

  test('an agent can fetch its current brief', async () => {
    const hub = createTestHub();
    const worker = addAgent(hub.ctx, 'bob');
    expect((await hub.call('GET', '/api/brief', { user: 'bob', agent: worker.id })).json.brief).toContain(`agflow brief for ${worker.id}`);
    expect((await hub.call('GET', '/api/brief', { user: 'bob' })).status).toBe(403);
  });
});
