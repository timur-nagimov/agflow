// A child-process service for tests (host.test.ts, and task 17's suspend): the fake adapters on the AGFLOW_HOME and
// AGFLOW_CONFIG_DIR its parent prepared, with the process handlers on. It prints 'online' once the hub has it, and
// AGFLOW_TEST_FAILURE=exception|rejection then throws, so the parent can check the unclean exit.
import { loadRunnerConfig } from '../../src/config';
import { runnerPaths } from '../../src/paths';
import { startRunnerService } from '../../src/service/host';
import { FIXTURE_AGFLOW, fixtureCliVersion } from '../fixture';
import { fakeServiceAdapters } from '../service-helpers';

const paths = runnerPaths();
const configDir = process.env.AGFLOW_CONFIG_DIR;
if (!configDir) throw new Error('AGFLOW_CONFIG_DIR is required');
const mode = process.env.AGFLOW_SERVICE_MODE ?? 'foreground';
if (mode !== 'foreground' && mode !== 'service') throw new Error(`invalid service mode: ${mode}`);
const service = await startRunnerService({
  paths,
  configDir,
  mode,
  machineId: async () => loadRunnerConfig(paths.config).machineId,
  adapters: fakeServiceAdapters(),
  agflow: FIXTURE_AGFLOW,
  cliVersion: fixtureCliVersion,
  signals: true,
});
let ended = false;
void service.exited.then(() => {
  ended = true;
});
while (!ended && service.runner?.status().link !== 'online') await Bun.sleep(10);
if (!ended) {
  console.log('online');
  if (process.env.AGFLOW_TEST_FAILURE === 'exception') {
    setTimeout(() => {
      throw new Error('child uncaught exception');
    }, 0);
  } else if (process.env.AGFLOW_TEST_FAILURE === 'rejection') {
    void Promise.reject(new Error('child unhandled rejection'));
  }
}
process.exit((await service.exited).code);
