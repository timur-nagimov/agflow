import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScriptResources } from '../../../scripts/resources';
import { saveCredentials } from '../src/credentials';
import { codexTrustOverride } from './codex-trust';

await using resources = new ScriptResources();
const base = resources.directory(join(tmpdir(), 'agflow-real-'));
const port = 8796;
const hubUrl = `http://localhost:${port}`;
const cli = join(import.meta.dir, '..', 'src', 'main.ts');
const hubMain = join(import.meta.dir, '..', '..', 'hub', 'src', 'main.ts');
const configDir = join(base, 'config');

// A nested Claude Code refuses to start while variables from the parent session are set.
const env: Record<string, string> = Object.fromEntries(
  Object.entries(process.env).filter(([key, value]) => value !== undefined && key !== 'CLAUDECODE' && !key.startsWith('CLAUDE_CODE_')),
) as Record<string, string>;
env.AGFLOW_CONFIG_DIR = configDir;

const PROMPT =
  'Call the agflow MCP tool hello with the code from your agflow brief. Then call the agflow tool list_tasks with status ["ready"]. Reply with only the id of the first ready task, for example T-1.';

function sh(cmd: string[], cwd: string, timeout = 60_000): { code: number; out: string } {
  const result = Bun.spawnSync(cmd, { cwd, env, stdout: 'pipe', stderr: 'pipe', timeout });
  return { code: result.exitCode ?? 1, out: `${result.stdout.toString()}\n${result.stderr.toString()}` };
}

const hub = resources.child(Bun.spawn(['bun', hubMain], {
  env: {
    ...env,
    AGFLOW_AUTH: 'dev',
    AGFLOW_ALLOWED_USERS: 'alice',
    AGFLOW_PROJECT_NAME: 'real-cli-check',
    AGFLOW_PROJECT_REPO: 'https://example.com/check.git',
    AGFLOW_PORT: String(port),
    AGFLOW_DB: join(base, 'hub.db'),
    AGFLOW_BACKUP_DIR: join(base, 'backups'),
  },
  stdout: 'ignore',
  stderr: 'inherit',
}));

const results: string[] = [];
const work = join(base, 'work');
try {
  for (let attempt = 0; ; attempt++) {
    try {
      if ((await fetch(`${hubUrl}/api/auth-config`)).ok) break;
    } catch {
      // not listening yet
    }
    if (attempt > 50) throw new Error('the hub did not start');
    await Bun.sleep(100);
  }
  const signIn = await fetch(`${hubUrl}/auth/dev?user=alice`, { redirect: 'manual' });
  const cookie = (signIn.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const web = (method: string, path: string, body?: unknown) =>
    fetch(`${hubUrl}${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  await web('PUT', '/api/goal', { text: 'Check the real CLIs.', baseVersion: 0 });
  await web('POST', '/api/tasks', { tasks: [{ title: 'Say hello', objective: 'Nothing to change', acceptance: [{ id: 'A1', assertion: 'none' }] }] });

  // Sign the CLI in without a browser: approve a code directly.
  const code = 'realcheck'.padEnd(32, 'x');
  await web('POST', '/api/cli-login/approve', { code, label: 'real-cli-check' });
  const poll = (await (await fetch(`${hubUrl}/api/cli-login/poll?code=${code}`)).json()) as { token: string };
  saveCredentials({ hubUrl, token: poll.token, user: 'alice' }, configDir);

  sh(['git', 'init', '--quiet', '-b', 'main', work], base);
  writeFileSync(join(work, 'README.md'), '# check\n');
  sh(['git', 'add', '.'], work);
  sh(['git', '-c', 'user.email=check@example.com', '-c', 'user.name=Check', 'commit', '--quiet', '-m', 'init'], work);
  const joined = sh(['bun', cli, 'join', '--vendor', 'both', '--role', 'worker'], work);
  results.push(`join: ${joined.code === 0 ? 'ok' : `failed\n${joined.out}`}`);

  const claude = sh(
    // No --allowedTools: the permission rule that `agflow join` writes must be enough.
    ['claude', '-p', PROMPT, '--output-format', 'json', '--max-turns', '8'],
    work,
    300_000,
  );
  results.push(`claude: exit ${claude.code}; answered T-1: ${claude.out.includes('T-1')}`);

  const codex = sh(
    ['codex', 'exec', '--json', '--dangerously-bypass-hook-trust', '-c', codexTrustOverride(work), PROMPT],
    work,
    300_000,
  );
  results.push(`codex: exit ${codex.code}; answered T-1: ${codex.out.includes('T-1')}`);

  const agents = (await (await web('GET', '/api/agents')).json()) as { agents: Array<{ id: string; vendor: string; lastSeenAt: number }> };
  results.push(`agents registered by hooks: ${agents.agents.map((a) => `${a.id}/${a.vendor}`).join(', ') || 'none'}`);
  if (claude.code !== 0) results.push(`claude output (first 2000 chars):\n${claude.out.slice(0, 2000)}`);
  if (codex.code !== 0) results.push(`codex output (first 2000 chars):\n${codex.out.slice(0, 2000)}`);
} finally {
  sh(['bun', cli, 'leave'], work);
  await resources.close();
  console.log(results.join('\n'));
}
