// agflow runner … (design 7.1, 13): the runner's commands. The CLI depends on @agflow/runner and imports its service
// modules by deep path, so the runner barrel stays M2b's; the runner never imports the CLI, which passes it the
// agflow command (selfCommand) and the directory of its credentials (configDir). Each subcommand loads its modules
// when it runs: every other command, the hooks Claude Code and Codex run on each prompt above all, must not pay for
// the runner's module graph. A static-string import() is still bundled by `bun build --compile`.
import { homedir } from 'node:os';
import type { startRunnerService } from '@agflow/runner/src/service/host';
import type { installService } from '@agflow/runner/src/service/launchd';
import type { RunnerStatusReport } from '@agflow/runner/src/service/status';
import type { installSystemdService } from '@agflow/runner/src/service/systemd';
import type { Exec } from '@agflow/runner/src/service/system';
import { type ParsedArgs, UsageError } from './args';
import type { Io } from './io';
import type { Command } from './main';
import { configDir } from './paths';
import type { RunnerSetupDeps } from './runner-setup';
import type { RunnerUninstallDeps } from './runner-uninstall';
import { selfCommand } from './self';

/** The runner subcommands' lines in main.ts's HELP; each subcommand adds its own. */
export const RUNNER_HELP = `  agflow runner setup [--yes] [--relogin] [--no-service] [--preset hackathon]
      [--name <name>] [--capacity <1-16>] [--ceiling <0.5-1>] [--keep-awake always|ac|off]
      [--profile standard|auto|open]
                                Set up this machine's runner: sign-in, runner.json, binaries, logins and the service;
                                --preset hackathon is capacity 6, ceilings 1, keep-awake always and profile open
  agflow runner start [--service]
                                Run this machine's runner in the foreground (--service for launchd or systemd)
  agflow runner stop             Hand off agents and stop and disable the service
  agflow runner restart          Suspend agents and restart the service
  agflow runner drain            Stop accepting new attempts
  agflow runner undrain          Accept new attempts and clear the crash-loop guard
  agflow runner install          Install and start the service: a LaunchAgent on macOS, a systemd user unit on Linux
  agflow runner uninstall [--purge]
                                Stop, log out, retire and remove the service; --purge deletes local runner data
  agflow runner status [--json]  Show the runner's status and attempts
`;

export async function runnerCommand(
  args: ParsedArgs,
  io: Io,
  deps: {
    setup?: Partial<RunnerSetupDeps>;
    uninstall?: Partial<RunnerUninstallDeps>;
    startRunnerService?: typeof startRunnerService;
    installService?: typeof installService;
    installSystemdService?: typeof installSystemdService;
    env?: Record<string, string | undefined>;
    exec?: Exec;
    uid?: number;
    home?: string;
    /** Linux runs the runner as a systemd user unit, macOS as a LaunchAgent; process.platform by default. */
    platform?: NodeJS.Platform;
  } = {},
): Promise<number> {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const linux = platform === 'linux';
  const drainingCommand =
    (draining: boolean): Command =>
    async (args, io) => {
      const name = draining ? 'drain' : 'undrain';
      if (args.positional.length > 2) throw new UsageError(`usage: agflow runner ${name}`);
      const { drainRunner, undrainRunner } = await import('@agflow/runner/src/service/drain');
      const result = await (draining ? drainRunner : undrainRunner)();
      io.out(
        result.via === 'runner'
          ? `the runner is ${draining ? 'draining' : 'undrained'}\n`
          : `${name}ed in runner.json; the hub hears it after the next start\n`,
      );
      return 0;
    };
  const commands: Record<string, Command> = {
    setup: async (args, io) => {
      if (args.positional.length > 2) {
        throw new UsageError(
          'usage: agflow runner setup [--yes] [--relogin] [--no-service] [--preset hackathon] [--name <name>] ' +
            '[--capacity <1-16>] [--ceiling <0.5-1>] [--keep-awake always|ac|off] [--profile standard|auto|open]',
        );
      }
      const { runnerSetup } = await import('./runner-setup');
      return runnerSetup(args, io, deps.setup);
    },
    // The host logs and prints every reason; the exit code is the ServiceExit's.
    start: async (args, io) => {
      if (args.positional.length > 2) throw new UsageError('usage: agflow runner start [--service]');
      const start = deps.startRunnerService ?? (await import('@agflow/runner/src/service/host')).startRunnerService;
      const service = await start({
        mode: args.flags.service === true ? 'service' : 'foreground',
        configDir: configDir(),
        agflow: selfCommand(),
        terminal: io.err,
        signals: true,
      });
      return (await service.exited).code;
    },
    status: async (args, io) => {
      if (args.positional.length > 2 || (args.flags.json !== undefined && args.flags.json !== true)) {
        throw new UsageError('usage: agflow runner status [--json]');
      }
      try {
        const { offlineStatus, formatStatus, launchdDisabled, LOGIN_ITEMS_WARNING } = await import(
          '@agflow/runner/src/service/status'
        );
        const { LAUNCHD_LABEL } = await import('@agflow/runner/src/service/launchd');
        const { controlRequest, ControlUnavailableError } = await import('@agflow/runner/src/service/control');
        const { runnerPaths } = await import('@agflow/runner/src/paths');
        const paths = runnerPaths();
        const options = {
          paths, exec: deps.exec, uid: deps.uid, home: deps.home, label: LAUNCHD_LABEL,
          launchd: env.AGFLOW_TEST !== '1', platform,
        };
        let report: RunnerStatusReport;
        try {
          report = await controlRequest<RunnerStatusReport>(paths, 'GET', '/status', undefined, { timeoutMs: 3_000 });
        } catch (error) {
          if (!(error instanceof ControlUnavailableError)) throw error;
          report = await offlineStatus(options);
        }
        if (
          options.launchd &&
          !linux &&
          report.running &&
          (await launchdDisabled(options)) === true &&
          !report.warnings.includes(LOGIN_ITEMS_WARNING)
        ) {
          report.warnings.push(LOGIN_ITEMS_WARNING);
        }
        io.out(args.flags.json === true ? `${JSON.stringify(report, null, 2)}\n` : formatStatus(report));
        return report.running ? 0 : 1;
      } catch (error) {
        io.err(`agflow: ${error instanceof Error ? error.message : String(error)}\n`);
        return 1;
      }
    },
    stop: async (args, io) => {
      if (args.positional.length > 2) throw new UsageError('usage: agflow runner stop');
      const { stopRunner } = await import('@agflow/runner/src/service/stop');
      const result = await stopRunner({
        env,
        exec: deps.exec,
        uid: deps.uid,
        home: deps.home ?? homedir(),
        platform,
        log: (line) => io.err(`${line}\n`),
      });
      const service = linux
        ? result.disabled
          ? 'the systemd unit was stopped and disabled'
          : 'no systemd unit was installed'
        : result.bootedOut
          ? 'the LaunchAgent was booted out and disabled'
          : result.disabled
            ? 'the installed LaunchAgent was not loaded and is now disabled'
            : 'no LaunchAgent was loaded';
      io.out(`${result.wasRunning ? 'the runner stopped' : 'no runner was running'}; ${service}\n`);
      // A foreground runner on a cloud machine ends with the SSH session that started it.
      io.out(`run agflow runner install${linux ? '' : ' or agflow runner start'} to bring it back\n`);
      return 0;
    },
    restart: async (args, io) => {
      if (args.positional.length > 2) throw new UsageError('usage: agflow runner restart');
      const { restartRunner } = await import('@agflow/runner/src/service/stop');
      await restartRunner({ env, exec: deps.exec, uid: deps.uid, platform, log: (line) => io.err(`${line}\n`) });
      io.out(`the runner restarted under ${linux ? 'systemd' : 'launchd'}\n`);
      return 0;
    },
    drain: drainingCommand(true),
    undrain: drainingCommand(false),
    install: async (args, io) => {
      if (args.positional.length > 2) throw new UsageError('usage: agflow runner install');
      try {
        const { runnerPaths } = await import('@agflow/runner/src/paths');
        const options = {
          paths: runnerPaths(),
          agflow: selfCommand(),
          env: process.env,
          log: (line: string) => io.err(`${line}\n`),
        };
        if (linux) {
          const install =
            deps.installSystemdService ?? (await import('@agflow/runner/src/service/systemd')).installSystemdService;
          const result = await install(options);
          io.out(`installed ${result.unitPath}; the runner starts as ${result.target}\n`);
        } else {
          const install = deps.installService ?? (await import('@agflow/runner/src/service/launchd')).installService;
          const result = await install(options);
          io.out(`installed ${result.plistPath}; the runner starts as ${result.target}\n`);
        }
        return 0;
      } catch (error) {
        io.err(`agflow: ${error instanceof Error ? error.message : String(error)}\n`);
        return 1;
      }
    },
    uninstall: async (args, io) => {
      if (args.positional.length > 2 || (args.flags.purge !== undefined && args.flags.purge !== true)) {
        throw new UsageError('usage: agflow runner uninstall [--purge]');
      }
      const { uninstallRunner } = await import('./runner-uninstall');
      return uninstallRunner(args, io, {
        exec: deps.exec, uid: deps.uid, home: deps.home, machinePlatform: platform, ...deps.uninstall,
        env: deps.uninstall?.env ?? env,
      });
    },
  };
  const name = args.positional[1];
  const command = name !== undefined && Object.hasOwn(commands, name) ? commands[name] : undefined;
  if (!command) {
    const reason = name === undefined ? 'agflow runner needs a subcommand' : `unknown runner subcommand "${name}"`;
    throw new UsageError(`${reason}; subcommands: ${Object.keys(commands).join(', ')}`);
  }
  return command(args, io);
}
