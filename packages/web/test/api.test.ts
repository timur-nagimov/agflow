import { describe, expect, test } from 'bun:test';
import { ApiError, createApi } from '../src/api';

interface Call {
  url: string;
  method: string;
  body: string | null;
  contentType: string | null;
}

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
    return new Response(payload === undefined ? '' : JSON.stringify(payload), { status });
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
