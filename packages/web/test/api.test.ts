import { describe, expect, test } from 'bun:test';
import { TAKEOVER_REFUSALS } from '@agflow/core';
import { ApiError, createApi } from '../src/api';

interface Call {
  url: string;
  method: string;
  body: string | null;
  contentType: string | null;
}

/** Answers every request with the payload, or with what the payload function gives for its URL. */
function fakeHub(status: number, payload: unknown) {
  const calls: Call[] = [];
  const fetchFn = async (input: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: input,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : null,
      contentType: headers.get('content-type'),
    });
    const answer = typeof payload === 'function' ? payload(input) : payload;
    return new Response(answer === undefined ? '' : JSON.stringify(answer), { status });
  };
  return { calls, fetchFn };
}

describe('api client', () => {
  test('sends JSON bodies and unwraps responses', async () => {
    const hub = fakeHub(200, { task: { id: 'T-4', status: 'rejected' } });
    const api = createApi(hub.fetchFn);
    const task = await api.taskAction('T-4', 'reject', { feedback: 'Add tests.' });
    expect(task.id).toBe('T-4');
    expect(hub.calls).toEqual([
      { url: '/api/tasks/T-4/reject', method: 'POST', body: '{"feedback":"Add tests."}', contentType: 'application/json' },
    ]);
  });

  test('each task action posts to its own route', async () => {
    const hub = fakeHub(200, { task: { id: 'T-1' } });
    const api = createApi(hub.fetchFn);
    await api.taskAction('T-1', 'release', { reason: 'stuck' });
    await api.taskAction('T-1', 'merged', {});
    await api.taskAction('T-1', 'unblock', {});
    expect(hub.calls.map((call) => call.url)).toEqual([
      '/api/tasks/T-1/release-claim',
      '/api/tasks/T-1/merged',
      '/api/tasks/T-1/unblock',
    ]);
  });

  test('builds query strings and skips empty values', async () => {
    const hub = fakeHub(200, { events: [] });
    const api = createApi(hub.fetchFn);
    await api.events({ latest: true, limit: 50, subject: undefined });
    await api.events();
    expect(hub.calls.map((call) => call.url)).toEqual(['/api/events?latest=1&limit=50', '/api/events']);
  });

  test('encodes search text, a lone surrogate included, instead of throwing', async () => {
    const hub = fakeHub(200, { tasks: [], notes: [], messages: [] });
    const api = createApi(hub.fetchFn);
    await api.search('\uD800');
    await api.search('a,b %2C c&d');
    expect(hub.calls.map((call) => call.url)).toEqual([
      '/api/search?q=%EF%BF%BD',
      '/api/search?q=a,b+%252C+c%26d',
    ]);
  });

  test('turns hub errors into ApiError with the hub message', async () => {
    const api = createApi(fakeHub(409, { error: 'conflict', message: 'T-1 is ready, not submitted' }).fetchFn);
    const error = await api.taskAction('T-1', 'accept', {}).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, code: 'conflict', message: 'T-1 is ready, not submitted' });
  });

  test('reports an ended session once per failed request', async () => {
    let ended = 0;
    const api = createApi(fakeHub(401, { error: 'unauthorized', message: 'sign in first' }).fetchFn, () => {
      ended += 1;
    });
    await expect(api.status()).rejects.toThrow('sign in first');
    expect(ended).toBe(1);
  });

  test('copes with an empty or non-JSON error body', async () => {
    const api = createApi(async () => new Response('Bad gateway', { status: 502 }));
    await expect(api.status()).rejects.toThrow('GET /api/status failed (502)');
  });
});

describe('runner routes', () => {
  test('lists runners with their accounts', async () => {
    const hub = fakeHub(200, { runners: [{ id: 'R-1' }], accounts: [{ owner: 'alice' }] });
    const list = await createApi(hub.fetchFn).runners();
    expect(list).toEqual({ runners: [{ id: 'R-1' }], accounts: [{ owner: 'alice' }] } as never);
    expect(hub.calls.map((call) => `${call.method} ${call.url}`)).toEqual(['GET /api/runners']);
  });

  test("patches a runner's settings with only the given fields, and retires a runner", async () => {
    const hub = fakeHub(200, { runner: { id: 'R-1', capacity: 4 } });
    const api = createApi(hub.fetchFn);
    const runner = await api.updateRunner('R-1', {
      capacity: 4,
      keepAwake: undefined,
      ceilings: { claude: { fiveHour: 0.8, weekly: 0.5 } },
      allowPaidUsage: { codex: false },
    });
    expect(runner).toMatchObject({ id: 'R-1', capacity: 4 });
    await api.updateRunner('R-1', { draining: true });
    expect(await api.retireRunner('R-3')).toBeUndefined();
    expect(hub.calls).toEqual([
      {
        url: '/api/runners/R-1',
        method: 'PATCH',
        body: '{"capacity":4,"ceilings":{"claude":{"fiveHour":0.8,"weekly":0.5}},"allowPaidUsage":{"codex":false}}',
        contentType: 'application/json',
      },
      { url: '/api/runners/R-1', method: 'PATCH', body: '{"draining":true}', contentType: 'application/json' },
      { url: '/api/runners/R-3', method: 'DELETE', body: null, contentType: null },
    ]);
  });
});

describe('attempt routes', () => {
  test('filters attempts with a comma list of statuses and skips empty values', async () => {
    const hub = fakeHub(200, { attempts: [{ id: 'T-4-a1' }] });
    const api = createApi(hub.fetchFn);
    const attempts = await api.attempts({ task: 'T-4', role: 'worker', status: ['starting', 'running'], runner: 'R-1', limit: 50 });
    expect(attempts).toEqual([{ id: 'T-4-a1' }] as never);
    await api.attempts({ task: '', status: [], runner: undefined });
    await api.attempts();
    expect(hub.calls.map((call) => call.url)).toEqual([
      '/api/attempts?task=T-4&role=worker&status=starting,running&runner=R-1&limit=50',
      '/api/attempts',
      '/api/attempts',
    ]);
  });

  test('reads one attempt with its log', async () => {
    const hub = fakeHub(200, { attempt: { id: 'T-4-e2-a1' }, log: [{ id: 1 }] });
    const detail = await createApi(hub.fetchFn).attempt('T-4-e2-a1');
    expect(detail).toEqual({ attempt: { id: 'T-4-e2-a1' }, log: [{ id: 1 }] } as never);
    expect(hub.calls.map((call) => call.url)).toEqual(['/api/attempts/T-4-e2-a1']);
    await createApi(hub.fetchFn).attempt('a/b');
    expect(hub.calls.at(-1)?.url).toBe('/api/attempts/a%2Fb');
  });
});

describe('agent actions, take-over and hand-back', () => {
  test('interrupt, stop and replace post to the agent; stop and replace unwrap the attempt', async () => {
    const hub = fakeHub(200, (url: string) =>
      url.endsWith('/interrupt') ? { ok: true } : { attempt: { id: 'T-4-a1', status: 'running' } },
    );
    const api = createApi(hub.fetchFn);
    expect(await api.agentAction('A-3', 'interrupt')).toBeNull();
    expect(await api.agentAction('A-3', 'stop', { reason: 'wrong approach', hold: true })).toMatchObject({ id: 'T-4-a1' });
    expect(await api.agentAction('A-3', 'replace', { reason: 'looping' })).toMatchObject({ id: 'T-4-a1' });
    expect(hub.calls.map((call) => [call.url, call.body])).toEqual([
      ['/api/agents/A-3/interrupt', '{}'],
      ['/api/agents/A-3/stop', '{"reason":"wrong approach","hold":true}'],
      ['/api/agents/A-3/replace', '{"reason":"looping"}'],
    ]);
  });

  test("the body type follows the hub's schemas: stop and replace need a reason, and only stop holds", () => {
    const api = createApi(fakeHub(200, {}).fetchFn);
    // Never called: the typecheck is the test.
    const typed = () => [
      // @ts-expect-error stop needs a reason
      api.agentAction('A-3', 'stop'),
      // @ts-expect-error replace needs a reason
      api.agentAction('A-3', 'replace', {}),
      // @ts-expect-error replace does not hold
      api.agentAction('A-3', 'replace', { reason: 'looping', hold: true }),
      // @ts-expect-error interrupt takes no body
      api.agentAction('A-3', 'interrupt', { reason: 'now' }),
    ];
    expect(typeof typed).toBe('function');
  });

  test("take-over and hand-back return the 202 answer's attempt id", async () => {
    const hub = fakeHub(202, { attemptId: 'T-4-a2' });
    const api = createApi(hub.fetchFn);
    expect(await api.takeOver('T-4')).toBe('T-4-a2');
    expect(await api.handBack('T-4', 'clone')).toBe('T-4-a2');
    const sha = 'a'.repeat(40);
    expect(await api.handBack('T-4', { ref: 'refs/agflow/T-4/takeover-alice', sha })).toBe('T-4-a2');
    expect(hub.calls.map((call) => [call.method, call.url, call.body])).toEqual([
      ['POST', '/api/tasks/T-4/takeover', '{}'],
      ['POST', '/api/tasks/T-4/handback', '{"source":"clone"}'],
      ['POST', '/api/tasks/T-4/handback', `{"source":{"ref":"refs/agflow/T-4/takeover-alice","sha":"${sha}"}}`],
    ]);
  });

  test("a refused take-over keeps the hub's code and message", async () => {
    const api = createApi(fakeHub(409, { error: 'runner_offline', message: 'R-2 is offline' }).fetchFn);
    const error = await api.takeOver('T-9').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, code: 'runner_offline', message: 'R-2 is offline' });
    expect(TAKEOVER_REFUSALS).toContain((error as ApiError).code as never);
  });
});

describe('approvals and the project', () => {
  test("lists the caller's approvals by status and decides one", async () => {
    const hub = fakeHub(200, { approvals: [{ id: 'p-1' }], approval: { id: 'p-1', status: 'declined' } });
    const api = createApi(hub.fetchFn);
    expect(await api.approvals(['pending'])).toEqual([{ id: 'p-1' }] as never);
    await api.approvals(['approved', 'declined']);
    await api.approvals();
    const id = '0b7c4a52-1a1e-4c0e-9b8f-1d2e3f4a5b6c';
    expect(await api.decideApproval(id, 'decline')).toMatchObject({ id: 'p-1', status: 'declined' });
    expect(hub.calls.map((call) => [call.method, call.url, call.body])).toEqual([
      ['GET', '/api/approvals?status=pending', null],
      ['GET', '/api/approvals?status=approved,declined', null],
      ['GET', '/api/approvals', null],
      ['POST', `/api/approvals/${id}`, '{"decision":"decline"}'],
    ]);
  });

  test('switches runner leads on the project', async () => {
    const hub = fakeHub(200, { name: 'demo', repo: 'r', paused: false, runnerLeads: false });
    const project = await createApi(hub.fetchFn).setRunnerLeads(false);
    expect(project.runnerLeads).toBe(false);
    expect(hub.calls).toEqual([
      { url: '/api/project', method: 'PATCH', body: '{"runnerLeads":false}', contentType: 'application/json' },
    ]);
  });
});
