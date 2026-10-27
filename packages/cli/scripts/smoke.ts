import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'agflow-smoke-cli-')));
const port = 8797;
const hubUrl = `http://localhost:${port}`;
const cli = join(import.meta.dir, '..', 'src', 'main.ts');
const hubMain = join(import.meta.dir, '..', '..', 'hub', 'src', 'main.ts');
const env: Record<string, string> = {
  ...(Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)) as Record<string, string>),
  AGFLOW_CONFIG_DIR: join(base, 'config'),
  AGFLOW_NO_BROWSER: '1',
};

function check(condition: unknown, what: string): asserts condition {
  if (!condition) throw new Error(`smoke check failed: ${what}`);
}

function sh(cmd: string[], cwd: string, input?: string): string {
  const result = Bun.spawnSync(cmd, { cwd, env, stdin: input === undefined ? 'ignore' : new TextEncoder().encode(input), stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(`${cmd.join(' ')} failed: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

const hub = Bun.spawn(['bun', hubMain], {
  env: {
    ...env,
    AGFLOW_AUTH: 'dev',
    AGFLOW_ALLOWED_USERS: 'alice',
    AGFLOW_PROJECT_NAME: 'smoke',
    AGFLOW_PROJECT_REPO: 'https://example.com/smoke.git',
    AGFLOW_PORT: String(port),
    AGFLOW_DB: join(base, 'hub.db'),
    AGFLOW_BACKUP_DIR: join(base, 'backups'),
  },
  stdout: 'ignore',
  stderr: 'inherit',
});

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

  // A person signs in to the web UI, sets the goal and creates a task.
  const signIn = await fetch(`${hubUrl}/auth/dev?user=alice`, { redirect: 'manual' });
  const cookie = (signIn.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const web = (method: string, path: string, body?: unknown) =>
    fetch(`${hubUrl}${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  check((await web('PUT', '/api/goal', { text: 'Smoke goal', baseVersion: 0 })).ok, 'goal saved');
  const taskBody = { tasks: [{ title: 'Add greeting', objective: 'Add greeting.txt', acceptance: [{ id: 'A1', assertion: 'greeting.txt exists' }] }] };
  check((await web('POST', '/api/tasks', taskBody)).ok, 'task created');

  // agflow login prints a link; the person approves it.
  const login = Bun.spawn(['bun', cli, 'login', '--hub', hubUrl], { env, stdout: 'pipe', stderr: 'inherit' });
  const reader = login.stdout.getReader();
  let printed = '';
  while (!printed.includes('code=')) {
    const chunk = await reader.read();
    if (chunk.done) break;
    printed += new TextDecoder().decode(chunk.value);
  }
  reader.releaseLock();
  const code = printed.match(/code=([A-Za-z0-9_-]+)/)?.[1] ?? '';
  check(code, 'login printed a sign-in link');
  check((await web('POST', '/api/cli-login/approve', { code, label: 'smoke' })).ok, 'login approved');
  check((await login.exited) === 0, 'agflow login finished');

  // A repository joined for Codex.
  const origin = join(base, 'origin.git');
  const work = join(base, 'work');
  sh(['git', 'init', '--quiet', '--bare', '-b', 'main', origin], base);
  sh(['git', 'clone', '--quiet', origin, work], base);
  sh(['git', 'config', 'user.email', 'smoke@example.com'], work);
  sh(['git', 'config', 'user.name', 'Smoke'], work);
  writeFileSync(join(work, 'README.md'), '# smoke\n');
  sh(['git', 'add', '.'], work);
  sh(['git', 'commit', '--quiet', '-m', 'init'], work);
  sh(['git', 'push', '--quiet', '-u', 'origin', 'main'], work);
  check(sh(['bun', cli, 'join', '--vendor', 'codex', '--role', 'worker'], work).includes('Joined'), 'agflow join');

  // The SessionStart hook registers the chat and returns the brief with the hello code.
  const hook = (event: string, input: unknown) => sh(['bun', cli, 'hook', event, '--vendor', 'codex', '--role', 'worker'], work, JSON.stringify(input));
  const brief = (JSON.parse(hook('session-start', { session_id: 'smoke-session', cwd: work })) as { hookSpecificOutput: { additionalContext: string } })
    .hookSpecificOutput.additionalContext;
  const helloCode = brief.match(/code "([A-Z2-9]{6})"/)?.[1] ?? '';
  check(helloCode, 'the brief contains a hello code');

  // The MCP bridge: hello, list, claim, commit, submit.
  const transport = new StdioClientTransport({ command: 'bun', args: [cli, 'mcp', '--vendor', 'codex'], cwd: work, env, stderr: 'inherit' });
  const mcp = new Client({ name: 'agflow-smoke', version: '0.0.0' });
  await mcp.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await mcp.callTool({ name, arguments: args });
    const text = (result.content as Array<{ text?: string }>).map((part) => part.text ?? '').join('\n');
    if (result.isError) throw new Error(`${name}: ${text}`);
    return text;
  };
  check((await call('hello', { code: helloCode })).includes('Connected'), 'hello');
  check((await call('list_tasks', { status: ['ready'] })).includes('T-1'), 'list_tasks shows T-1');
  const worktree = join(work, '.worktrees', 'agflow', 'T-1');
  check((await call('claim_task', { id: 'T-1' })).includes(worktree), 'claim created the task worktree');
  writeFileSync(join(worktree, 'greeting.txt'), 'hello\n');
  sh(['git', 'add', '.'], worktree);
  sh(['git', 'commit', '--quiet', '-m', 'greeting'], worktree);
  check((await call('submit', { task_id: 'T-1', summary: 'Added greeting.txt' })).includes('submitted'), 'submit');
  await mcp.close();

  // The hub has the submission with the pushed commit, and the Stop hook lets the chat stop.
  const detail = (await (await web('GET', '/api/tasks/T-1')).json()) as { task: { status: string; submission: { headSha: string } } };
  check(detail.task.status === 'submitted', 'the task is submitted');
  check(sh(['git', 'rev-parse', 'refs/heads/agflow/T-1-add-greeting'], origin) === detail.task.submission.headSha, 'origin has the submitted commit');
  check(JSON.parse(hook('stop', { session_id: 'smoke-session', stop_hook_active: false })).decision === undefined, 'the stop hook allows stopping');
  console.log('smoke test passed: login, join, hooks, the MCP bridge, claim, push and submit work end to end');
} finally {
  hub.kill();
}
