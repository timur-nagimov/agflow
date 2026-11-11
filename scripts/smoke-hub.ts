import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectFakeRunnerWs } from '../packages/hub/test/fake-runner';

const dir = mkdtempSync(join(tmpdir(), 'agflow-smoke-'));
const port = 8799;
const base = `http://localhost:${port}`;
const hub = Bun.spawn(['bun', 'packages/hub/src/main.ts'], {
  env: {
    ...process.env,
    AGFLOW_AUTH: 'dev',
    AGFLOW_ALLOWED_USERS: 'alice',
    AGFLOW_PROJECT_NAME: 'smoke',
    AGFLOW_PROJECT_REPO: 'https://github.com/acme/smoke',
    AGFLOW_PORT: String(port),
    AGFLOW_DB: join(dir, 'agflow.db'),
    AGFLOW_BACKUP_DIR: join(dir, 'backups'),
  },
  stdout: 'inherit',
  stderr: 'inherit',
});

async function waitForHub(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      if ((await fetch(`${base}/api/auth-config`)).ok) return;
    } catch {
      // not listening yet
    }
    await Bun.sleep(100);
  }
  throw new Error('the hub did not start within 5 seconds');
}

try {
  await waitForHub();
  const lan = Object.values(networkInterfaces()).flat().find((info) => info?.family === 'IPv4' && !info.internal);
  if (lan) {
    const signal = AbortSignal.timeout(2000);
    const exposed = await fetch(`http://${lan.address}:${port}/api/auth-config`, { signal }).then(() => true, () => false);
    if (exposed) throw new Error(`dev sign-in is reachable from the network at ${lan.address}`);
  }
  // A web page that points a domain of its own at 127.0.0.1 (DNS rebinding) must not be signed in.
  const host = `rebind.attacker.example:${port}`;
  const rebound = await fetch(`${base}/auth/dev?user=alice`, { headers: { host }, redirect: 'manual' });
  if (rebound.status !== 403 || rebound.headers.has('set-cookie')) {
    throw new Error(`dev sign-in answered a request addressed to ${host} with ${rebound.status}`);
  }
  // A start snapshot, plus the day's daily snapshot because the folder had none yet.
  const backups = readdirSync(join(dir, 'backups')).sort();
  if (backups.length !== 2 || !backups[0]?.startsWith('agflow-daily-') || !backups[1]?.startsWith('agflow-start-')) {
    throw new Error(`unexpected backups: ${backups.join(', ')}`);
  }
  const login = await fetch(`${base}/auth/dev?user=alice`, { redirect: 'manual' });
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const goal = await fetch(`${base}/api/goal`, {
    method: 'PUT',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'Smoke goal', baseVersion: 0 }),
  });
  const status = (await (await fetch(`${base}/api/status`, { headers: { cookie } })).json()) as {
    goalVersion: number;
    project: { name: string };
  };
  if (goal.status !== 200 || status.goalVersion !== 1 || status.project.name !== 'smoke') {
    throw new Error(`unexpected result: goal ${goal.status}, status ${JSON.stringify(status)}`);
  }
  // A CLI token, as agflow login gets one: alice approves the code in the browser, and the CLI polls for it.
  const code = randomUUID();
  const approve = await fetch(`${base}/api/cli-login/approve`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ code, label: 'smoke' }),
  });
  const poll = (await (await fetch(`${base}/api/cli-login/poll?code=${code}`)).json()) as { token?: string };
  if (approve.status !== 200 || !poll.token) throw new Error(`CLI sign-in failed: approve ${approve.status}`);
  const token = poll.token;
  const bearer = { authorization: `Bearer ${token}` };
  const whoami = (await (await fetch(`${base}/api/runner/whoami`, { headers: bearer })).json()) as { user?: string };
  if (whoami.user !== 'alice') throw new Error(`unexpected whoami: ${JSON.stringify(whoami)}`);
  // A runner links over a WebSocket with that token; FakeRunner speaks the protocol (X-25).
  const runner = await connectFakeRunnerWs(base, { token, name: 'smoke-runner' });
  const welcome = runner.welcome;
  runner.disconnect();
  if (!welcome?.runnerId) throw new Error(`the runner link got no welcome: ${JSON.stringify(runner.closedWith)}`);
  // Still the two snapshots: the first hourly one comes an hour after start.
  const after = readdirSync(join(dir, 'backups')).sort();
  if (after.join() !== backups.join()) throw new Error(`unexpected backups after start: ${after.join(', ')}`);
  const passed = 'smoke test passed: hub started, snapshots written, dev sign-in worked, goal v1 saved';
  console.log(`${passed}, runner ${welcome.runnerId} linked`);
} finally {
  hub.kill();
}
