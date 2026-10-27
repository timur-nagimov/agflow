import { mkdtempSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';

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
  console.log('smoke test passed: hub started, dev sign-in worked, goal v1 saved');
} finally {
  hub.kill();
}
