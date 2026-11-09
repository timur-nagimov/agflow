// The adapter registry (design 13, X-6). Each vendor has an entry file, adapters/<vendor>/entry.ts, exporting an
// AdapterFactory; createAdapters asks each one and keeps what it returns. The entries return null until M2d and M2e
// fill them, and they fill only their own entry file, never this one. `agflow runner start`'s host calls
// createAdapters unless its caller injects adapters.
import type { RunnerConfig } from '../config';
import type { RunnerPaths } from '../paths';
import { claudeAdapterFactory } from './claude/entry';
import { codexAdapterFactory } from './codex/entry';
import type { AdapterFactory, AgflowCommand, VendorAdapter } from './types';

/** Every vendor's entry, in the order adapters are listed. */
export const ADAPTER_FACTORIES: readonly AdapterFactory[] = [claudeAdapterFactory, codexAdapterFactory];

/**
 * The adapters whose entries return one, given the runner's settings, its layout and how it runs agflow. Two for
 * one vendor throw: the runtime keys adapters by vendor, and hello would list the vendor twice.
 */
export function createAdapters(
  config: RunnerConfig,
  paths: RunnerPaths,
  options: { agflow: AgflowCommand; factories?: readonly AdapterFactory[] },
): VendorAdapter[] {
  const factories = options.factories ?? ADAPTER_FACTORIES;
  const adapters = factories.flatMap((factory) => factory({ config, paths, agflow: options.agflow }) ?? []);
  const seen = new Set<VendorAdapter['vendor']>();
  for (const adapter of adapters) {
    if (seen.has(adapter.vendor)) throw new Error(`two adapters for ${adapter.vendor}`);
    seen.add(adapter.vendor);
  }
  return adapters;
}
