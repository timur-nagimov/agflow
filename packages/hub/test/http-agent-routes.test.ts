import { describe, expect, test } from 'bun:test';
import { mintAgentToken } from '../src/auth';
import { AGENT_ROUTES, isAgentRouteAllowed } from '../src/http/agent-routes-allowed';
import { addRunnerAttempt, addRunnerLead } from './helpers';
import { createTestHub } from './http-helpers';

/** Design 6.5's table of the routes an agent token may use, written out so that a wider allowlist fails here. */
const DESIGN_TABLE = [
  'GET /api/brief',
  'GET /api/goal',
  'GET /api/status',
  'GET /api/search',
  'GET /api/events',
  'GET /api/tasks',
  'GET /api/tasks/:id',
  'POST /api/tasks/:id/progress',
  'POST /api/tasks/:id/handoff',
  'POST /api/tasks/:id/submit',
  'POST /api/tasks/:id/block',
  'POST /api/tasks/:id/impossible',
  'POST /api/tasks/:id/release',
  'GET /api/submissions/:id',
  'POST /api/prepare',
  'GET /api/prepare/:id',
  'POST /api/fetch-submission',
  'GET /api/fetch-submission/:id',
  'POST /api/inbox',
  'POST /api/inbox/ack',
  'POST /api/messages',
  'POST /api/tasks',
  'PATCH /api/tasks/:id',
  'POST /api/tasks/:id/cancel',
  'POST /api/tasks/:id/accept',
  'POST /api/tasks/:id/reject',
  'POST /api/tasks/:id/unblock',
  'POST /api/tasks/:id/merged',
  'POST /api/goal/notes',
  'POST /api/staffing',
  'POST /api/agents/:id/stop',
  'POST /api/agents/:id/replace',
  'POST /api/lead/handoff',
  'GET /api/lead/notes',
  'POST /api/tasks/:id/fetch-grant',
  'DELETE /api/tasks/:id/fetch-grant',
];

/** A path that the route pattern matches: each parameter becomes a sample segment, a wildcard a sample page. */
function concrete(pattern: string): string {
  return pattern.replace(/:[A-Za-z]+/g, 'T-1').replace(/\/\*$/, '/some/page');
}

describe('the agent-token route allowlist', () => {
  test("the allowlist is exactly design 6.5's table", () => {
    expect(DESIGN_TABLE).toHaveLength(36);
    expect(AGENT_ROUTES.map((route) => `${route.method} ${route.path}`).sort()).toEqual([...DESIGN_TABLE].sort());
  });

  test('every allowlist entry matches a mounted route', () => {
    const hub = createTestHub();
    const mounted = new Set(hub.app.routes.map((route) => `${route.method} ${route.path}`));
    const listed = AGENT_ROUTES.map((route) => `${route.method} ${route.path}`);
    expect(listed.filter((route) => !mounted.has(route))).toEqual([]);
  });

  test('every mounted route matches an allowlist entry or answers an agent token 403 agent_not_allowed', async () => {
    // A web build directory mounts the static catch-all too, so the walk covers every route the hub can have.
    const hub = createTestHub({ webDist: '/nonexistent/agflow-web-dist' });
    const { attempt } = addRunnerAttempt(hub.ctx);
    const token = mintAgentToken(hub.ctx, attempt);
    const routes = hub.app.routes.filter((route) => route.method !== 'ALL');
    expect(routes.length).toBeGreaterThan(40);
    const refused: string[] = [];
    for (const route of routes) {
      const path = concrete(route.path);
      const answer = await hub.call(route.method, path, { headers: { authorization: `Bearer ${token}` }, body: {} });
      const label = `${route.method} ${route.path}`;
      // HEAD is answered by the GET route of the same path.
      const listed = DESIGN_TABLE.includes(`${route.method === 'HEAD' ? 'GET' : route.method} ${route.path}`);
      expect([label, isAgentRouteAllowed(route.method, path)]).toEqual([label, listed]);
      if (listed) {
        expect([label, answer.json?.error]).not.toEqual([label, 'agent_not_allowed']);
      } else {
        expect([label, answer.status, answer.json?.error]).toEqual([label, 403, 'agent_not_allowed']);
        refused.push(label);
      }
    }
    expect(refused).toContain('GET /api/attempts');
    expect(refused).toContain('GET /*');
  });

  test('live, CLI sign-in, agent list, claim and resume-claim refuse agent tokens; the reads are allowed', () => {
    const refused: [string, string][] = [
      ['POST', '/api/live/session-start'],
      ['POST', '/api/live/hello'],
      ['GET', '/api/live/inbox'],
      ['GET', '/api/live/peek'],
      ['POST', '/api/live/stop-check'],
      ['POST', '/api/cli-login/approve'],
      ['GET', '/api/cli-login/poll'],
      ['GET', '/api/agents'],
      ['POST', '/api/tasks/T-1/claim'],
      ['POST', '/api/tasks/T-1/resume-claim'],
      ['POST', '/api/tasks/T-1/release-claim'],
      ['GET', '/api/approvals'],
      ['GET', '/api/runners'],
      ['GET', '/api/attempts'],
      ['GET', '/api/attempts/T-1-a1'],
      ['POST', '/api/tasks/T-1/takeover'],
      ['GET', '/api/runner/ws'],
      ['GET', '/api/me'],
      ['PUT', '/api/goal'],
      ['POST', '/api/project/pause'],
      ['DELETE', '/api/rules/1'],
      ['GET', '/api/events/stream'],
    ];
    for (const [method, path] of refused) expect([method, path, isAgentRouteAllowed(method, path)]).toEqual([method, path, false]);
    const reads: [string, string][] = [
      ['GET', '/api/brief'],
      ['GET', '/api/goal'],
      ['GET', '/api/status'],
      ['GET', '/api/search'],
      ['GET', '/api/events'],
      ['GET', '/api/tasks'],
      ['GET', '/api/tasks/T-1'],
      ['HEAD', '/api/tasks'],
      ['GET', '/api/submissions/S-1'],
      ['POST', '/api/prepare'],
      ['GET', '/api/prepare/1-R-1-3'],
      ['POST', '/api/inbox'],
      ['POST', '/api/inbox/ack'],
      ['POST', '/api/messages'],
    ];
    for (const [method, path] of reads) expect([method, path, isAgentRouteAllowed(method, path)]).toEqual([method, path, true]);
  });

  test('holder and lead routes carry their access rule', () => {
    const access = (method: string, path: string) =>
      AGENT_ROUTES.find((route) => route.method === method && route.path === path)?.access;
    for (const action of ['progress', 'handoff', 'submit', 'block', 'impossible', 'release']) {
      expect([action, access('POST', `/api/tasks/:id/${action}`)]).toEqual([action, 'holder']);
    }
    const lead: [string, string][] = [
      ['POST', '/api/fetch-submission'],
      ['GET', '/api/fetch-submission/:id'],
      ['POST', '/api/tasks'],
      ['PATCH', '/api/tasks/:id'],
      ['POST', '/api/tasks/:id/cancel'],
      ['POST', '/api/tasks/:id/accept'],
      ['POST', '/api/tasks/:id/reject'],
      ['POST', '/api/tasks/:id/unblock'],
      ['POST', '/api/tasks/:id/merged'],
      ['POST', '/api/goal/notes'],
      ['POST', '/api/staffing'],
      ['POST', '/api/agents/:id/stop'],
      ['POST', '/api/agents/:id/replace'],
      ['POST', '/api/lead/handoff'],
      ['GET', '/api/lead/notes'],
      ['POST', '/api/tasks/:id/fetch-grant'],
      ['DELETE', '/api/tasks/:id/fetch-grant'],
    ];
    for (const [method, path] of lead) expect([method, path, access(method, path)]).toEqual([method, path, 'lead']);
    expect(access('GET', '/api/tasks')).toBe('read');
    expect(access('GET', '/api/submissions/:id')).toBe('own');
    expect(access('POST', '/api/inbox')).toBe('self');
    expect(new Set(AGENT_ROUTES.map((route) => `${route.method} ${route.path}`)).size).toBe(AGENT_ROUTES.length);
  });

  test('fetch routes require the seated lead, not merely an allowed agent token or an owner session', async () => {
    const hub = createTestHub();
    const worker = addRunnerAttempt(hub.ctx);
    const lead = addRunnerLead(hub.ctx);
    const workerAuth = { headers: { authorization: `Bearer ${mintAgentToken(hub.ctx, worker.attempt)}` } };
    const leadAuth = { headers: { authorization: `Bearer ${mintAgentToken(hub.ctx, lead.attempt)}` } };
    const routes = [
      { method: 'POST', path: '/api/fetch-submission', body: { task_id: worker.task.id }, leadStatus: 409 },
      { method: 'GET', path: '/api/fetch-submission/1-R-1-999', leadStatus: 404 },
    ];
    for (const route of routes) {
      const call = (auth: Parameters<typeof hub.call>[2]) => hub.call(route.method, route.path, { ...auth, body: route.body });
      // The lead passes authorization and reaches the missing submission/request checks.
      expect((await call(leadAuth)).status).toBe(route.leadStatus);
      for (const auth of [workerAuth, { user: 'alice' }, { user: 'alice', via: 'web' as const }]) {
        const answer = await call(auth);
        expect([route.method, answer.status, answer.json.error]).toEqual([route.method, 403, 'forbidden']);
      }
      // Runner identity comes only from agt_: an owner session cannot name the runner lead, and an agent token
      // cannot override its identity with X-Agflow-Agent. There is no separate lead-token credential.
      const impersonated = await call({ user: 'alice', agent: lead.agent.id });
      expect([route.method, impersonated.status, impersonated.json.error]).toEqual([route.method, 403, 'forbidden']);
      const overridden = await call({ ...workerAuth, agent: lead.agent.id });
      expect([route.method, overridden.status, overridden.json.error]).toEqual([route.method, 403, 'agent_not_allowed']);
    }
  });

  test('a path parameter matches one segment only', () => {
    expect(isAgentRouteAllowed('GET', '/api/tasks/T-1')).toBe(true);
    expect(isAgentRouteAllowed('GET', '/api/tasks/T-1/notes')).toBe(false);
    expect(isAgentRouteAllowed('GET', '/api/tasks/')).toBe(false);
    expect(isAgentRouteAllowed('POST', '/api/tasks/T-1/progress')).toBe(true);
    expect(isAgentRouteAllowed('POST', '/api/tasks/T-1/x/progress')).toBe(false);
    expect(isAgentRouteAllowed('POST', '/api/tasks/progress')).toBe(false);
    expect(isAgentRouteAllowed('POST', '/api/agents/A-1/stop')).toBe(true);
    expect(isAgentRouteAllowed('POST', '/api/agents/A-1/interrupt')).toBe(false);
    expect(isAgentRouteAllowed('GET', '/api/tasks/T-1/progress')).toBe(false);
  });

  test('an agent token gets 403 agent_not_allowed before the route runs, and the allowed routes still answer it', async () => {
    const hub = createTestHub();
    const held = addRunnerAttempt(hub.ctx);
    const token = mintAgentToken(hub.ctx, held.attempt);
    const auth = { headers: { authorization: `Bearer ${token}` } };
    const agents = await hub.call('GET', '/api/agents', auth);
    expect([agents.status, agents.json.error]).toEqual([403, 'agent_not_allowed']);
    const claim = await hub.call('POST', `/api/tasks/${held.task.id}/claim`, { ...auth, body: {} });
    expect([claim.status, claim.json.error]).toEqual([403, 'agent_not_allowed']);
    expect((await hub.call('GET', `/api/tasks/${held.task.id}`, auth)).status).toBe(200);
    const progress = await hub.call('POST', `/api/tasks/${held.task.id}/progress`, { ...auth, body: { note: 'ok' } });
    expect(progress.status).toBe(200);
    // People and live agents are not affected.
    expect((await hub.call('GET', '/api/agents', { user: 'alice' })).status).toBe(200);
  });
});
