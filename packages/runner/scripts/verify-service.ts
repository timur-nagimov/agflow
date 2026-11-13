// A desktop-session check with a private label and homes: never operates on the owner's runner.
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ScriptResources } from '../../../scripts/resources';
import { CREDENTIALS_FILE } from '@agflow/core';
import { findRunnerByKey } from '@agflow/hub/src/runners';
import { originRepo } from '@agflow/testkit';
import { saveRunnerConfig } from '../src/config';
import { runnerPaths } from '../src/paths';
import { bootoutService, installService, plistPath, serviceLoaded, serviceTarget } from '../src/service/launchd';
import { readLockOwner } from '../src/service/lock';
import { canonicalHome, readMachineId } from '../src/service/machine';
import { createRunnerConfig } from '../src/service/runner-json';
import { restartRunner, stopRunner } from '../src/service/stop';
import { defaultExec, type Exec } from '../src/service/system';
import { VENDOR_PINS, vendorBinary } from '../src/vendor/pins';
import { startTestHub, type TestHub } from '../test/hub-fixture';

type Env = Record<string, string | undefined>;
interface VerifyServiceOptions {
  log?: (line: string) => void;
  error?: (line: string) => void;
}

async function until(check: () => boolean, description: string, ms = 60_000): Promise<void> {
  const deadline = performance.now() + ms;
  while (!check()) {
    if (performance.now() >= deadline) throw new Error(`timed out waiting for ${description}`);
    await Bun.sleep(100);
  }
}

/** The verification binary has the same cwd-autoload protection as build:cli. */
export async function compileServiceCli(binary: string, exec: Exec = defaultExec): Promise<void> {
  const build = await exec(
    [process.execPath, 'build', '--compile', '--no-compile-autoload-bunfig', '--no-compile-autoload-dotenv',
      'packages/cli/src/main.ts', '--outfile', binary],
    { cwd: resolve(import.meta.dir, '../../..'), timeoutMs: 120_000 },
  );
  if (build.exitCode !== 0 || build.timedOut) throw new Error(`CLI build failed: ${build.stderr}`);
}

export async function verifyServiceMain(
  argv: string[] = [],
  env: Env = process.env,
  options: VerifyServiceOptions = {},
): Promise<number> {
  const log = options.log ?? console.log;
  const error = options.error ?? console.error;
  const label = `dev.agflow.runner.verify-${randomUUID()}`;
  let root: string | undefined;
  let hub: TestHub | undefined;
  let origin: Awaited<ReturnType<typeof originRepo>> | undefined;
  let uid: number | undefined;
  let code = 0;
  await using resources = new ScriptResources();
  resources.defer(async () => {
    const cleanup = async (action: () => unknown) => {
      try {
        await action();
      } catch (caught) {
        error(`cleanup: ${caught instanceof Error ? caught.message : String(caught)}`);
        code = 1;
      }
    };
    if (root !== undefined && uid !== undefined) {
      log('cleanup: removing the scratch LaunchAgent and temporary homes');
      await cleanup(() => bootoutService({ label, uid }));
      // stop's disable persists in launchd's disabled-services database; leave the scratch label enabled there.
      await cleanup(async () => {
        const enabled = await defaultExec(['launchctl', 'enable', serviceTarget(label, uid)], { timeoutMs: 30_000 });
        if (enabled.exitCode !== 0 || enabled.timedOut) throw new Error(`launchctl enable failed: ${enabled.stderr}`);
      });
      await cleanup(() =>
        until(() => readLockOwner(runnerPaths(join(root!, 'agflow'))) === null, 'cleanup lock release', 90_000),
      );
      await cleanup(() => rmSync(plistPath({ home: join(root!, 'home'), label }), { force: true }));
    }
    await cleanup(() => hub?.stop());
    await cleanup(() => origin?.remove());
    if (root) await cleanup(() => rmSync(root!, { recursive: true, force: true }));
  });
  try {
    if (argv.length) throw new Error('usage: bun run verify:service');
    if (process.platform !== 'darwin') throw new Error('verify-service requires a macOS desktop (Aqua) session');
    uid = process.getuid!();
    const session = await resources.waitFor(defaultExec(['launchctl', 'managername'], { timeoutMs: 5_000 }));
    const domain = await resources.waitFor(defaultExec(['launchctl', 'print', `gui/${uid}`], { timeoutMs: 5_000 }));
    if (
      session.exitCode !== 0 ||
      session.timedOut ||
      session.stdout.trim() !== 'Aqua' ||
      domain.exitCode !== 0 ||
      domain.timedOut
    ) {
      throw new Error(
        'verify-service requires the logged-in macOS desktop (Aqua) session; SSH without Aqua cannot run it',
      );
    }
    // A short path also keeps runner.sock within macOS's 104-byte Unix-socket limit.
    root = realpathSync(mkdtempSync('/tmp/agf-vs-'));
    const home = join(root, 'home');
    const paths = runnerPaths(join(root, 'agflow'));
    const configDir = join(root, 'config');
    mkdirSync(home, { recursive: true, mode: 0o700 });
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const scratchEnv = Object.fromEntries(
      Object.entries({
        ...env,
        HOME: home,
        AGFLOW_HOME: paths.home,
        AGFLOW_CONFIG_DIR: configDir,
        AGFLOW_TEST: undefined,
      }).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    const binary = join(root, 'agflow-bin');
    log('build: compiling the CLI into the temporary directory');
    await resources.waitFor(compileServiceCli(binary));

    log('hub: starting an isolated hub over a local bare origin');
    await resources.waitFor(originRepo({ 'README.md': '# service verification\n' }).then((value) => { origin = value; }));
    hub = startTestHub({ config: { projectName: 'verify-service', projectRepo: origin!.path } });
    writeFileSync(join(configDir, CREDENTIALS_FILE), `${JSON.stringify(hub.credentials)}\n`, { mode: 0o600 });
    const config = createRunnerConfig(
      {
        machineId: await readMachineId(),
        name: 'service verification',
        capturedPath: env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
        connectivity: {},
        commitIdentity: { name: 'Service verification', email: 'verify@agflow.invalid' },
        homes: { claude: canonicalHome(paths.homes.claude), codex: canonicalHome(paths.homes.codex) },
      },
      { keepAwake: 'off' },
    );
    saveRunnerConfig(paths.config, config);
    const row = () => findRunnerByKey(hub!.ctx, config.runnerKey);
    const launchd = { label, uid };
    const operations = { ...launchd, paths, home, log, env: scratchEnv };

    log('install: bootstrapping the scratch LaunchAgent without vendor downloads');
    await resources.waitFor(installService({
      ...launchd,
      paths,
      home,
      env: scratchEnv,
      agflow: { command: binary, args: [] },
      // No attempts run here; missing pins should simply make both vendors not ready.
      installPins: async () => {
        const pins = VENDOR_PINS['darwin-arm64']!;
        return {
          claude: join(paths.runner, vendorBinary('claude', pins.claude.version)),
          codex: join(paths.runner, vendorBinary('codex', pins.codex.version)),
        };
      },
    }));
    await until(() => { resources.checkOpen(); return row()?.state === 'online'; }, 'the runner to come online');
    const firstPid = readLockOwner(paths)?.pid;
    if (!firstPid) throw new Error('online runner has no lock owner');

    log('status: checking the compiled CLI reports a running runner');
    const status = await resources.waitFor(defaultExec([binary, 'runner', 'status', '--json'], { env: scratchEnv, timeoutMs: 10_000 }));
    if (status.exitCode !== 0 || status.timedOut || JSON.parse(status.stdout).running !== true) {
      throw new Error(`runner status failed: ${status.stderr || status.stdout}`);
    }

    log('restart: suspending and waiting for a new runner pid online');
    await resources.waitFor(restartRunner(operations));
    await until(() => {
      resources.checkOpen();
      const pid = readLockOwner(paths)?.pid;
      return pid != null && pid !== firstPid && row()?.state === 'online';
    }, 'a new runner pid online');

    log('stop: draining, stopping and disabling the scratch LaunchAgent');
    await resources.waitFor(stopRunner(operations));
    if (readLockOwner(paths) !== null) throw new Error('stop left runner.lock held');
    if (await resources.waitFor(serviceLoaded(launchd))) throw new Error('stop left the scratch LaunchAgent loaded');
    await until(() => { resources.checkOpen(); return row()?.state === 'offline'; }, 'the hub to mark the runner offline');
    log('verify-service passed');
  } catch (caught) {
    error(caught instanceof Error ? caught.message : String(caught));
    code = 1;
  } finally {
    await resources.close();
  }
  return code;
}

if (import.meta.main) process.exitCode = await verifyServiceMain(process.argv.slice(2), process.env);
