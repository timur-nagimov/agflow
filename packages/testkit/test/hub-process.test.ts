import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { type HubStatus, WhoamiResponseSchema } from '@agflow/core';
import { loadConfig } from '../../hub/src/config';
import { type OriginRepo, originRepo } from '../src/git-fixtures';
import { E2E_HUB_TIMINGS, E2E_USERS, type HubProcess, startHubProcess } from '../src/harness/hub-process';
import { HubCallError, cliToken, signIn } from '../src/harness/person';

const hubs: HubProcess[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const hub of hubs.splice(0)) {
    if (hub.running) await hub.kill();
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A hub process whose project repository is a local bare origin; in a fresh directory by default. */
async function startHubWithOrigin(dir?: string): Promise<{ hub: HubProcess; origin: OriginRepo }> {
  const hubDir = dir ?? mkdtempSync('/tmp/agf-hub-');
  if (dir === undefined) dirs.push(hubDir);
  const origin = await originRepo({ 'README.md': 'hub process test\n' });
  dirs.push(origin.root);
  const hub = await startHubProcess({ dir: hubDir, repo: origin.path });
  hubs.push(hub);
  return { hub, origin };
}

async function startHub(): Promise<HubProcess> {
  return (await startHubWithOrigin()).hub;
}

const task = (title: string) => ({ title, objective: `Do ${title}.`, acceptance: [{ id: 'done', assertion: 'it is done' }] });

describe('E2E_HUB_TIMINGS', () => {
  test('passes the hub config loader in test mode, and every key is a HubConfig millisecond field', () => {
    const { config } = loadConfig({
      AGFLOW_AUTH: 'dev',
      AGFLOW_ALLOWED_USERS: E2E_USERS.join(','),
      AGFLOW_PROJECT_NAME: 'e2e',
      AGFLOW_PROJECT_REPO: '/tmp/origin.git',
      AGFLOW_TEST: '1',
      AGFLOW_TEST_CONFIG: JSON.stringify(E2E_HUB_TIMINGS),
    });
    for (const [key, value] of Object.entries(E2E_HUB_TIMINGS)) {
      expect(key).toMatch(/Ms$/);
      expect(config[key as keyof typeof config]).toEqual(value);
    }
    // The WIP grace the hub sends follows the short lease (X-11).
    expect(config.wipGraceMs).toBe(Math.floor(E2E_HUB_TIMINGS.runnerLeaseMs / 3));
  });

  test('keep liveness to seconds and judgement long', () => {
    const { tickMs, heartbeatMs, deadLinkMs, runnerLeaseMs, recoveryMs, dispatchHoldMs, infraBackoffMs } =
      E2E_HUB_TIMINGS;
    for (const liveness of [tickMs, heartbeatMs, deadLinkMs, runnerLeaseMs, recoveryMs, dispatchHoldMs, ...infraBackoffMs]) {
      expect(liveness).toBeLessThanOrEqual(60_000);
    }
    expect(deadLinkMs).toBeGreaterThanOrEqual(3 * heartbeatMs);
    expect(runnerLeaseMs).toBeGreaterThan(deadLinkMs);
    const { stallMs, toolCapMs, longToolCapMs, leadReviewMs, activeBudgetMs } = E2E_HUB_TIMINGS;
    for (const judgement of [stallMs, toolCapMs, longToolCapMs, leadReviewMs, activeBudgetMs]) {
      expect(judgement).toBeGreaterThanOrEqual(60 * 60_000);
    }
  });
});

describe('startHubProcess', () => {
  test('starts main.ts in test mode with dev sign-in, the users and the repository, logging to the hub directory', async () => {
    const { hub, origin } = await startHubWithOrigin();
    expect(hub.url).toBe(`http://127.0.0.1:${hub.port}`);
    expect(hub.env).toMatchObject({
      AGFLOW_AUTH: 'dev',
      AGFLOW_ALLOWED_USERS: 'alice,bob,carol',
      AGFLOW_TEST: '1',
      AGFLOW_PORT: String(hub.port),
      AGFLOW_DB: hub.dbPath,
      AGFLOW_BACKUP_DIR: hub.backupDir,
      AGFLOW_PROJECT_REPO: origin.path,
    });
    expect(JSON.parse(hub.env.AGFLOW_TEST_CONFIG ?? '')).toEqual(E2E_HUB_TIMINGS);
    const config = (await (await fetch(`${hub.url}/api/auth-config`)).json()) as { mode: string; project: string };
    expect(config).toEqual({ mode: 'dev', project: 'e2e' });
    for (const login of E2E_USERS) {
      const person = await signIn(hub.url, login);
      expect((await person.project()).repo).toBe(origin.path);
    }
    expect(hub.logPath.startsWith(hub.dir)).toBe(true);
    expect(readFileSync(hub.logPath, 'utf8')).toContain('agflow hub for "e2e"');
    expect(hub.logTail()).toContain('agflow hub for "e2e"');
  }, 30_000);

  test('creates a hub directory that does not exist yet', async () => {
    const base = mkdtempSync('/tmp/agf-hub-');
    dirs.push(base);
    const dir = join(base, 'missing', 'hub');
    const { hub } = await startHubWithOrigin(dir);
    expect(hub.dir).toBe(dir);
    expect(existsSync(hub.logPath)).toBe(true);
    expect((await (await signIn(hub.url, 'alice')).status()).epoch).toBe(1);
  }, 30_000);

  test('with webDist, the hub serves the built web UI; without it, none', async () => {
    const web = mkdtempSync('/tmp/agf-web-');
    dirs.push(web);
    writeFileSync(join(web, 'index.html'), '<!doctype html><title>agflow</title>\n');
    const origin = await originRepo({ 'README.md': 'hub process test\n' });
    dirs.push(origin.root);
    const dir = mkdtempSync('/tmp/agf-hub-');
    dirs.push(dir);
    const hub = await startHubProcess({ dir, repo: origin.path, webDist: web });
    hubs.push(hub);
    expect(hub.env.AGFLOW_WEB_DIST).toBe(web);
    const page = await fetch(`${hub.url}/`);
    expect(await page.text()).toContain('<title>agflow</title>');
    const { hub: plain } = await startHubWithOrigin();
    expect(plain.env.AGFLOW_WEB_DIST).toBeUndefined();
    expect((await fetch(`${plain.url}/`)).status).toBe(404);
  }, 30_000);

  test('GET /api/status shows no lead seat, epoch 1 and the project', async () => {
    const hub = await startHub();
    const status: HubStatus = await (await signIn(hub.url, 'alice')).status();
    expect(status.leadSeat.kind).toBe('none');
    expect(status.epoch).toBe(1);
    expect(status.project.name).toBe('e2e');
  }, 30_000);

  test('restart() brings the hub back on the same port and database', async () => {
    const hub = await startHub();
    const alice = await signIn(hub.url, 'alice');
    expect((await alice.setGoal('Ship the e2e harness')).version).toBe(1);
    const { pid, url } = hub;
    await hub.restart();
    expect(hub.url).toBe(url);
    expect(hub.pid).not.toBe(pid);
    expect((await alice.status()).goalVersion).toBe(1);
  }, 30_000);

  test('kill() leaves a stale database lock, and the next start replaces it', async () => {
    const hub = await startHub();
    const pid = hub.pid;
    await hub.kill();
    expect(hub.running).toBe(false);
    expect(readFileSync(`${hub.dbPath}.pid`, 'utf8')).toContain(String(pid));
    await hub.start();
    expect(hub.running).toBe(true);
    expect((await (await signIn(hub.url, 'bob')).status()).epoch).toBe(1);
  }, 30_000);

  test("backups('start') lists the start snapshots, newest last", async () => {
    const hub = await startHub();
    expect(hub.backups('start')).toHaveLength(1);
    await hub.restart();
    const backups = hub.backups('start');
    expect(backups).toHaveLength(2);
    expect(backups.map((file) => basename(file))).toEqual(backups.map((file) => basename(file)).sort());
    for (const file of backups) {
      expect(file.startsWith(hub.backupDir)).toBe(true);
      expect(basename(file)).toMatch(/^agflow-start-.*\.db$/);
    }
    expect(hub.backups('daily')).toHaveLength(1);
  }, 30_000);

  test('restore() runs the restore command while the hub is stopped: epoch 2, and counters 1000 ahead', async () => {
    const hub = await startHub();
    const alice = await signIn(hub.url, 'alice');
    const [last] = await alice.createTasks([task('first')]);
    // The start snapshot of this restart knows the task.
    await hub.restart();
    const backup = hub.backups('start').at(-1) ?? '';
    await expect(hub.restore(backup)).rejects.toThrow('stop the hub');
    await hub.stop();
    expect(await hub.restore(backup)).toContain('at epoch 2');
    await hub.start();
    const person = await signIn(hub.url, 'alice');
    expect((await person.status()).epoch).toBe(2);
    const [next] = await person.createTasks([task('second')]);
    const number = (id: string | undefined) => Number(id?.slice(2));
    expect(number(next?.id)).toBeGreaterThan(number(last?.id) + 1000);
    expect(hub.logTail()).toContain('restored');
  }, 30_000);
});

describe('person', () => {
  test('cliToken approves a CLI login and returns a token the runner whoami accepts for that person', async () => {
    const hub = await startHub();
    const carol = await signIn(hub.url, 'carol');
    const token = await cliToken(carol);
    const response = await fetch(`${hub.url}/api/runner/whoami`, { headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    expect(WhoamiResponseSchema.parse(await response.json())).toEqual({ user: 'carol' });
  }, 30_000);

  test('a call with an unexpected status throws with the method, path, status and body', async () => {
    const hub = await startHub();
    const alice = await signIn(hub.url, 'alice');
    const error = await alice.accept('T-999').then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(HubCallError);
    const call = error as HubCallError;
    expect(call).toMatchObject({ method: 'POST', path: '/api/tasks/T-999/accept', status: 404 });
    expect(call.body).toContain('not_found');
    expect(call.message).toContain('POST /api/tasks/T-999/accept');
    expect(call.message).toContain('404');
    expect(call.message).toContain(call.body);
  }, 30_000);

  test('signIn refuses a login the hub does not allow', async () => {
    const hub = await startHub();
    await expect(signIn(hub.url, 'mallory')).rejects.toBeInstanceOf(HubCallError);
  }, 30_000);

  test('the M2 reads parse with core response schemas', async () => {
    const hub = await startHub();
    const alice = await signIn(hub.url, 'alice');
    expect(await alice.runners()).toEqual({ runners: [], accounts: [] });
    expect(await alice.attempts()).toEqual([]);
    expect(await alice.leadNotes()).toEqual([]);
    expect((await alice.setRunnerLeads(false)).runnerLeads).toBe(false);
  }, 30_000);

  test('an M2 answer that drifts from the core schema fails the call', async () => {
    // A stand-in hub: sign-in works, and the M2 reads answer with an extra field or an incomplete attempt.
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(request) {
        const { pathname } = new URL(request.url);
        if (pathname === '/auth/dev') {
          const headers = { location: '/', 'set-cookie': 'agflow_session=s1; Path=/' };
          return new Response(null, { status: 302, headers });
        }
        if (pathname === '/api/runners') return Response.json({ runners: [], accounts: [], extra: true });
        if (pathname === '/api/attempts') return Response.json({ attempts: [{ id: 'T-1.a1' }] });
        return new Response('not found', { status: 404 });
      },
    });
    try {
      const alice = await signIn(`http://127.0.0.1:${server.port}`, 'alice');
      // A ZodError; testkit has no zod dependency of its own to import the class from.
      await expect(alice.runners()).rejects.toMatchObject({ name: 'ZodError' });
      await expect(alice.attempts()).rejects.toMatchObject({ name: 'ZodError' });
    } finally {
      server.stop(true);
    }
  });

  test('a call to a hub that does not answer throws with status 0', async () => {
    const hub = await startHub();
    const alice = await signIn(hub.url, 'alice');
    await hub.kill();
    const error = await alice.status().then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(HubCallError);
    expect((error as HubCallError).status).toBe(0);
    expect((error as HubCallError).message).toContain('GET /api/status failed');
  }, 30_000);
});
