// agflow runner … (design 7.1, 13): the runner's commands. The CLI depends on @agflow/runner and imports its service
// modules by deep path, so the runner barrel stays M2b's; the runner never imports the CLI, which passes it the
// agflow command (selfCommand) and the directory of its credentials (configDir). Each subcommand loads its modules
// when it runs: every other command, the hooks Claude Code and Codex run on each prompt above all, must not pay for
// the runner's module graph. A static-string import() is still bundled by `bun build --compile`.
import type { startRunnerService } from '@agflow/runner/src/service/host';
import { type ParsedArgs, UsageError } from './args';
import type { Io } from './io';
import type { Command } from './main';
import { configDir } from './paths';
import { selfCommand } from './self';

/** The runner subcommands' lines in main.ts's HELP; each subcommand adds its own. */
export const RUNNER_HELP = `  agflow runner start [--service]
                                Run this laptop's runner in the foreground (--service for launchd)
`;

export async function runnerCommand(
  args: ParsedArgs,
  io: Io,
  deps: { startRunnerService?: typeof startRunnerService } = {},
): Promise<number> {
  const commands: Record<string, Command> = {
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
  };
  const name = args.positional[1];
  const command = name !== undefined && Object.hasOwn(commands, name) ? commands[name] : undefined;
  if (!command) {
    const reason = name === undefined ? 'agflow runner needs a subcommand' : `unknown runner subcommand "${name}"`;
    throw new UsageError(`${reason}; subcommands: ${Object.keys(commands).join(', ')}`);
  }
  return command(args, io);
}
