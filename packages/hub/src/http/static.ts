import { extname, join, normalize, sep } from 'node:path';
import type { App } from './app';

/** Serves the built web UI and falls back to index.html for client-side routes. */
export function mountStatic(app: App, root: string): void {
  const base = normalize(root);
  app.get('*', async (c, next) => {
    const path = c.req.path;
    if (path.startsWith('/api/') || path.startsWith('/auth/')) return next();
    let decoded: string;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      return next();
    }
    const candidate = normalize(join(base, decoded));
    if (candidate.startsWith(base + sep) && extname(candidate) !== '') {
      const file = Bun.file(candidate);
      // Bun fills the content type of a file response in lazily, and it is gone once the body has been read.
      if (await file.exists()) return new Response(file, { headers: { 'content-type': file.type } });
    }
    const index = Bun.file(join(base, 'index.html'));
    if (!(await index.exists())) return next();
    return new Response(index, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  });
}
