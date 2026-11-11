// A child `agflow runner start` for signal tests: the CLI's command path with the process handlers on, over a fake
// agent that sleeps and the safe machine operations, so the child never touches the real machine.
import { loadRunnerConfig } from '@agflow/runner/src/config';
import { runnerPaths } from '@agflow/runner/src/paths';
import { startRunnerService } from '@agflow/runner/src/service/host';
import { FIXTURE_AGFLOW, fixtureCliVersion } from '@agflow/runner/test/fixture';
import { fakeServiceOperations, sleepingServiceAdapter } from '@agflow/runner/test/service-helpers';
import { parseArgs } from '../src/args';
import { stdio } from '../src/io';
import { runnerCommand } from '../src/runner-command';

const code = await runnerCommand(parseArgs(['runner', 'start', ...process.argv.slice(2)]), stdio, {
  startRunnerService: (options) =>
    startRunnerService({
      ...options,
      ...fakeServiceOperations(),
      machineId: async () => loadRunnerConfig(runnerPaths().config).machineId,
      agflow: FIXTURE_AGFLOW,
      cliVersion: fixtureCliVersion,
      adapters: [sleepingServiceAdapter()],
    }),
});
process.exit(code);
