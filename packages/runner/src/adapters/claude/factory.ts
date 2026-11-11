// The Claude adapter from the registry's input (design 13, X-6): runner.json, the layout and how the runner runs
// agflow. The Claude home is vendorHomes' canonical string, the one buildAgentEnv puts in every launch's
// CLAUDE_CONFIG_DIR, so the adapter's transcripts and guard name the directory the CLI writes in. The binary is
// resolved per launch from its CLI version, so a runner home without it still gets an adapter: its preflight reports
// 'binary missing'. test.skipAuthChecks counts only in test mode (15.1).
import { isTestMode, vendorHomes } from '../../config';
import type { AdapterFactory } from '../types';
import { ClaudeAdapter } from './adapter';

export interface CreateClaudeAdapterOptions {
  /** The runner's environment: AGFLOW_TEST, and preflight's agent environment; process.env by default. */
  env?: Record<string, string | undefined>;
  /** `<os>-<arch>`, vendorPlatform() by default. */
  platform?: string;
}

export function createClaudeAdapter(
  input: Parameters<AdapterFactory>[0],
  options: CreateClaudeAdapterOptions = {},
): ClaudeAdapter {
  const { config, paths, agflow } = input;
  const env = options.env ?? process.env;
  return new ClaudeAdapter({
    agflow,
    config,
    paths,
    vendorHomes: vendorHomes(config, paths),
    skipAuthChecks: isTestMode(config, env) && config.test?.skipAuthChecks === true,
    platform: options.platform,
    env,
  });
}
