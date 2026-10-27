import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestHub } from './http-helpers';

function webDist(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agflow-web-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>agflow</title>');
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log("ui")');
  return dir;
}

describe('static UI', () => {
  test('serves files and falls back to index.html for client routes', async () => {
    const hub = createTestHub({ webDist: webDist() });
    const page = await hub.app.request('/board');
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<title>agflow</title>');
    const asset = await hub.app.request('/assets/app.js');
    expect(await asset.text()).toBe('console.log("ui")');
    expect(asset.headers.get('content-type')).toContain('javascript');
  });

  test('serves files when the folder is given with a trailing slash', async () => {
    const hub = createTestHub({ webDist: `${webDist()}/` });
    const asset = await hub.app.request('/assets/app.js');
    expect(asset.status).toBe(200);
    expect(await asset.text()).toBe('console.log("ui")');
    expect(asset.headers.get('content-type')).toContain('javascript');
  });

  test('serves files when the folder is given as "."', async () => {
    const dir = webDist();
    const before = process.cwd();
    process.chdir(dir);
    try {
      const hub = createTestHub({ webDist: '.' });
      const asset = await hub.app.request('/assets/app.js');
      expect(asset.status).toBe(200);
      expect(await asset.text()).toBe('console.log("ui")');
      expect(asset.headers.get('content-type')).toContain('javascript');
    } finally {
      process.chdir(before);
    }
  });

  test('API 404s stay JSON and paths cannot escape the folder', async () => {
    const hub = createTestHub({ webDist: webDist() });
    expect((await hub.call('GET', '/api/nope')).json.error).toBe('not_found');
    const escape = await hub.app.request('/..%2F..%2Fetc%2Fpasswd');
    expect(await escape.text()).toContain('<title>agflow</title>');
  });

  test('without a UI folder nothing is served', async () => {
    const hub = createTestHub();
    expect((await hub.app.request('/board')).status).toBe(404);
  });
});
