// Design 15's real registry check: fresh caches, sandboxed installs, and no cache inode shared with a clone.
import { lstatSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScriptResources } from '../../../scripts/resources';
import { DEFAULT_TIMINGS } from '../src/config';
import { runnerPaths } from '../src/paths';
import { prepEnv, prepLayout, prepPolicy, writePrepToolConfig } from '../src/prep/plan';
import { checkPrepSandbox, PrepSandbox } from '../src/prep/sandbox';
import { standardProfile } from '../src/profile';

type Env = Record<string, string | undefined>;

interface VerifyPrepOptions {
  log?: (line: string) => void;
  error?: (line: string) => void;
}

/** Do not follow package symlinks; compare every regular file with exact device and inode values. */
function regularFiles(root: string): { path: string; identity: string }[] {
  const files: { path: string; identity: string }[] = [];
  const visit = (path: string) => {
    const stat = lstatSync(path, { bigint: true });
    if (stat.isDirectory()) for (const name of readdirSync(path)) visit(join(path, name));
    else if (stat.isFile()) files.push({ path, identity: `${stat.dev}:${stat.ino}` });
  };
  visit(root);
  return files;
}

async function pythonExecutable(env: Env, resources: ScriptResources): Promise<string> {
  const python = Bun.which('python3', { PATH: env.PATH });
  if (!python) throw new Error('verify-prep needs python3 with pip on PATH');
  // Resolve a pyenv shim before replacing HOME; -I ignores Python's user site and environment configuration.
  const proc = resources.child(Bun.spawn([python, '-I', '-c', 'import sys; print(sys.executable)'], {
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  }));
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0 || !stdout.trim()) throw new Error(`cannot resolve python3: ${stderr.trim()}`);
  return realpathSync(stdout.trim());
}

export async function verifyPrepMain(
  argv: string[] = [],
  env: Env = process.env,
  options: VerifyPrepOptions = {},
): Promise<number> {
  await using resources = new ScriptResources();
  const log = options.log ?? console.log;
  let root: string | undefined;
  try {
    if (argv.length) throw new Error('usage: bun run verify:prep');
    if (process.platform !== 'darwin') throw new Error('verify-prep requires macOS');
    root = resources.directory(join(tmpdir(), 'agflow-verify-prep-'));
    const paths = runnerPaths(root);
    const sandbox = new PrepSandbox({ allowedDomains: standardProfile.network.allowedDomains });
    const checked = await resources.waitFor(checkPrepSandbox({ sandbox }));
    if (!checked.works) throw new Error(`preparation sandbox unavailable: ${checked.reason}`);
    const python = await pythonExecutable(env, resources);
    const fixtures = [
      {
        name: 'bun',
        argv: [process.execPath, 'install', '--ignore-scripts'],
        installed: 'node_modules',
        expected: 'is-number/index.js',
      },
      {
        name: 'pip',
        argv: [
          python,
          '-I',
          '-m',
          'pip',
          '--disable-pip-version-check',
          // pip 24.2+ verifies TLS through macOS's trustd, which the sandbox denies; older pips reject this flag, so
          // it belongs in the entry of a project that runs a newer pip, never in prepEnv.
          '--use-deprecated=legacy-certs',
          'install',
          '--no-input',
          '--index-url',
          'https://pypi.org/simple',
          '--only-binary=:all:',
          '--no-deps',
          '--target',
          'installed',
          'six==1.17.0',
        ],
        installed: 'installed',
        expected: 'six.py',
      },
    ];
    for (const fixture of fixtures) {
      const clone = paths.clone(fixture.name, 'fixture');
      const prep = paths.prep(fixture.name);
      const layout = prepLayout(prep);
      for (const path of [clone, layout.cache, layout.tmp]) mkdirSync(path, { recursive: true, mode: 0o700 });
      writePrepToolConfig(prep);
      const entry = { run: fixture.argv };
      if (fixture.name === 'bun') {
        writeFileSync(
          join(clone, 'package.json'),
          `${JSON.stringify({ name: 'prep-fixture', private: true, dependencies: { 'is-number': '7.0.0' } })}\n`,
        );
      }
      const tmpDir = resources.directory(join(layout.tmp, 'install-'));
      // Only the executable search path and system CA setting cross from the calling environment.
      const runEnv = prepEnv({
        agentEnv: { PATH: env.PATH ?? '/usr/bin:/bin', NODE_USE_SYSTEM_CA: '1' },
        clone,
        prep,
        tmpDir,
        entry,
      });
      // bun install shares the project cache; pip may build agent-edited packages, so its cache is per attempt.
      const cache = fixture.name === 'bun' ? runEnv.BUN_INSTALL_CACHE_DIR! : runEnv.PIP_CACHE_DIR!;
      for (const path of [runEnv.HOME!, cache]) mkdirSync(path, { recursive: true, mode: 0o700 });
      if (readdirSync(cache).length) throw new Error(`${fixture.name}: cache was not empty`);
      const abort = new AbortController();
      const result = await resources.waitFor(sandbox.run({
        signal: abort.signal,
        // pip runs with the preparation's environment, as a project's entry would: its cache and no config.
        argv: fixture.argv,
        cwd: clone,
        env: runEnv,
        policy: prepPolicy({
          home: homedir(),
          paths,
          clone,
          prep,
          tmpDir,
          entry,
          profile: standardProfile,
          vendorHomes: { claude: paths.homes.claude, codex: paths.homes.codex },
        }),
        timeoutMs: DEFAULT_TIMINGS.prep,
      }), () => abort.abort());
      if (result.code !== 0 || result.signal || result.timedOut) {
        throw new Error(
          `${fixture.name} install failed (exit ${result.code}, signal ${result.signal}, timedOut ${result.timedOut}): ${result.logTail}`,
        );
      }
      const installedRoot = join(clone, fixture.installed);
      if (!lstatSync(join(installedRoot, fixture.expected)).isFile())
        throw new Error(`${fixture.name}: package was not installed`);
      const installed = regularFiles(installedRoot);
      const cached = regularFiles(cache);
      if (!installed.length || !cached.length) throw new Error(`${fixture.name}: installed files or cache is empty`);
      const identities = new Set(cached.map((file) => file.identity));
      for (const file of installed) {
        if (identities.has(file.identity))
          throw new Error(`${fixture.name}: installed file shares a cache inode: ${file.path}`);
      }
      log(
        `${fixture.name}: installed from an empty cache; ${installed.length} installed files, ${cached.length} cache files; no shared inodes`,
      );
    }
    return 0;
  } catch (error) {
    (options.error ?? console.error)(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    await resources.close();
  }
}

if (import.meta.main) process.exitCode = await verifyPrepMain(process.argv.slice(2), process.env);
