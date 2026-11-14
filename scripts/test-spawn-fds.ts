// Read-only Linux/macOS diagnostic for CI descriptor growth; no credentials, repo mutations or model traffic.
// `bun run scripts/test-spawn-fds.ts` compares raw spawn, testkit git and runner git, with both pipes drained.
import { existsSync, readdirSync, readlinkSync } from 'node:fs';
import { runGit } from '../packages/runner/src/git/run';
import { gitIn } from '../packages/testkit/src/git-fixtures';

const fdDir = existsSync('/proc/self/fd') ? '/proc/self/fd' : '/dev/fd';
function report(label: string) {
  const fds = readdirSync(fdDir);
  const kinds: Record<string, number> = {};
  for (const fd of fds) {
    let target: string;
    try { target = readlinkSync(`${fdDir}/${fd}`); } catch { target = 'unavailable'; }
    const kind = target.startsWith('socket:') ? 'socket' : target.startsWith('pipe:') ? 'pipe' :
      target.startsWith('anon_inode:') ? target : 'other';
    kinds[kind] = (kinds[kind] ?? 0) + 1;
  }
  console.log(JSON.stringify({ label, platform: process.platform, bun: Bun.version, total: fds.length, kinds }));
}
const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
report('baseline');
for (const mode of ['raw', 'testkit', 'runner'] as const) {
  for (let i = 0; i < 250; i++) {
    if (mode === 'testkit') await gitIn('/', ['--version']);
    else if (mode === 'runner') await runGit({ name: 'local', env, args: [], timeoutMs: 5000 }, ['--version']);
    else {
      const child = Bun.spawn(['git', '--version'], { env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
      await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    }
  }
  report(`${mode}: 250 completed spawns`);
  Bun.gc(true);
  await Bun.sleep(50);
  report(`${mode}: after GC`);
}
