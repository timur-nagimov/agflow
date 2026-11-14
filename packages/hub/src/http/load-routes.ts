// The Load page's numbers (load.ts), for a person signed in to the web UI.
import type { HubContext } from '../context';
import { loadOf } from '../load';
import type { App } from './app';
import { human } from './util';

export function mountLoadRoutes(app: App, ctx: HubContext): void {
  app.get('/api/load', (c) => {
    human(c);
    return c.json(loadOf(ctx));
  });
}
