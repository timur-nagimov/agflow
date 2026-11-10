// agflow runner … (design 7.1, 13): the runner's commands. The CLI depends on @agflow/runner and imports its service
// modules by deep path, so the runner barrel stays M2b's; the runner never imports the CLI, which passes it the
// agflow command (selfCommand) and the directory of its credentials (configDir). Each subcommand loads its modules
// when it runs: every other command, the hooks Claude Code and Codex run on each prompt above all, must not pay for
// the runner's module graph. A static-string import() is still bundled by `bun build --compile`.
import { homedir } from 'node:os';
import type { startRunnerService } from '@agflow/runner/src/service/host';
import type { installService } from '@agflow/runner/src/service/launchd';
import type { RunnerStatusReport } from '@agflow/runner/src/service/status';
import type { Exec } from '@agflow/runner/src/service/system';
import { type ParsedArgs, UsageError } from './args';
import type { Io } from './io';
import type { Command } from './main';
import { configDir } from './paths';
import type { RunnerSetupDeps } from './runner-setup';
import { selfCommand } from './self';

/** The runner subcommands' lines in main.ts's HELP; each subcommand adds its own. */
export const RUNNER_HELP = `  agflow runner setup [--yes] [--relogin] [--no-service]
                                Set up this laptop's runner: sign-in, runner.json, binaries, logins and the service
  agflow runner start [--service]
                                Run this laptop's runner in the foreground (--service for launchd)
  agflow runner stop             Hand off agents and stop and disable the LaunchAgent
  agflow runner restart          Suspend agents and restart the runner under launchd
  agflow runner drain            Stop accepting new attempts
  agflow runner undrain          Accept new attempts and clear the crash-loop guard
  agflow runner install          Install and start the LaunchAgent that runs the runner at login
  agflow runner status [--json]  Show the runner's status and attempts
`;

export async function runnerCommand(
  args: ParsedArgs,
  io: Io,
  deps: {
    setup?: Partial<RunnerSetupDeps>;
    startRunnerService?: typeof startRunnerService;
    installService?: typeof installService;
    env?: Record<string, string | undefined>;
    exec?: Exec;
    uid?: number;
    home?: string;
  } = {},
): Promise<number> {
  const env = deps.env ?? process.env;
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
        throw new UsageError('usage: agflow runner setup [--yes] [--relogin] [--no-service]');
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
          launchd: env.AGFLOW_TEST !== '1',
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
        log: (line) => io.err(`${line}\n`),
      });
      const launchd = result.bootedOut
        ? 'the LaunchAgent was booted out and disabled'
        : result.disabled
          ? 'the installed LaunchAgent was not loaded and is now disabled'
          : 'no LaunchAgent was loaded';
      io.out(`${result.wasRunning ? 'the runner stopped' : 'no runner was running'}; ${launchd}\n`);
      io.out('run agflow runner install or agflow runner start to bring it back\n');
      return 0;
    },
    restart: async (args, io) => {
      if (args.positional.length > 2) throw new UsageError('usage: agflow runner restart');
      const { restartRunner } = await import('@agflow/runner/src/service/stop');
      await restartRunner({ env, exec: deps.exec, uid: deps.uid, log: (line) => io.err(`${line}\n`) });
      io.out('the runner restarted under launchd\n');
      return 0;
    },
    drain: drainingCommand(true),
    undrain: drainingCommand(false),
    install: async (args, io) => {
      if (args.positional.length > 2) throw new UsageError('usage: agflow runner install');
      try {
        const install = deps.installService ?? (await import('@agflow/runner/src/service/launchd')).installService;
        const { runnerPaths } = await import('@agflow/runner/src/paths');
        const result = await install({
          paths: runnerPaths(),
          agflow: selfCommand(),
          env: process.env,
          log: (line) => io.err(`${line}\n`),
        });
        io.out(`installed ${result.plistPath}; the runner starts as ${result.target}\n`);
        return 0;
      } catch (error) {
        io.err(`agflow: ${error instanceof Error ? error.message : String(error)}\n`);
        return 1;
      }
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
