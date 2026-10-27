import type { HubEvent } from '@agflow/core';
import { streamSSE } from 'hono/streaming';
import type { HubContext } from '../context';
import { listEvents } from '../events';
import { search } from '../search';
import type { App } from './app';
import { intParam, principal } from './util';

export const SSE_PING_MS = 15_000;

export function mountEventRoutes(app: App, ctx: HubContext): void {
  app.get('/api/events', (c) => {
    principal(c);
    return c.json({
      events: listEvents(ctx.db, {
        after: intParam(c.req.query('after')),
        limit: intParam(c.req.query('limit')),
        subject: c.req.query('subject') || undefined,
      }),
    });
  });

  app.get('/api/search', (c) => {
    principal(c);
    return c.json(search(ctx, c.req.query('q') ?? ''));
  });

  app.get('/api/events/stream', (c) => {
    principal(c);
    const after = intParam(c.req.query('after')) ?? intParam(c.req.header('last-event-id')) ?? 0;
    return streamSSE(c, async (stream) => {
      const queue: HubEvent[] = [];
      let wake: (() => void) | null = null;
      let closed = false;
      const unsubscribe = ctx.bus.subscribe((event) => {
        queue.push(event);
        wake?.();
      });
      stream.onAbort(() => {
        closed = true;
        unsubscribe();
        wake?.();
      });
      let lastId = after;
      const send = async (event: HubEvent) => {
        if (event.id <= lastId) return;
        await stream.writeSSE({ event: 'hub', id: String(event.id), data: JSON.stringify(event) });
        lastId = event.id;
      };
      for (const event of listEvents(ctx.db, { after, limit: 1000 })) await send(event);
      while (!closed) {
        while (queue.length > 0) await send(queue.shift() as HubEvent);
        if (closed) break;
        const timedOut = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(true), SSE_PING_MS);
          wake = () => {
            clearTimeout(timer);
            resolve(false);
          };
        });
        wake = null;
        if (timedOut && !closed) await stream.writeSSE({ event: 'ping', data: '' });
      }
    });
  });
}
