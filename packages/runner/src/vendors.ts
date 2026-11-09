// What hello and runner.vendors say about the runner's vendors (design 6.3, 13, X-5). Each adapter's preflight gives
// its facts, its quota and the boundaries it cannot enforce; vendorReport adds what runner.json says (models,
// ceilings, allowPaidUsage), when the preflight ran, and degraded false, which only the hub's vendor holds change. A
// quota report without an account id is left out (X-21). The profile is 'auto' only when runner.json asks for it and
// an adapter reports the auto profile as weakened, so it is in force (X-29); otherwise 'standard'. Its weakened list
// merges the runner's own with every adapter's, without duplicates.
import type { AccountQuotaReport, ProfileSummary, RunnerVendor } from '@agflow/core';
import type { PreflightResult } from './adapters/types';
import type { RunnerConfig } from './config';
import type { DependencyPreparer } from './seams';

/** What hello carries about the vendors, and runner.vendors after each preflight. */
export interface VendorReport {
  vendors: RunnerVendor[];
  quota: AccountQuotaReport[];
  profile: ProfileSummary;
}

export interface VendorReportInput {
  config: Pick<RunnerConfig, 'models' | 'ceilings' | 'allowPaidUsage' | 'profile'>;
  /** The adapters' preflights, one per vendor. */
  preflights: readonly PreflightResult[];
  /** When the preflights ran, epoch ms. */
  at: number;
  preparer: Pick<DependencyPreparer, 'available'>;
  /** The runner's own boundaries it cannot enforce, merged with the adapters'. */
  weakened?: readonly string[];
}

export function vendorReport(input: VendorReportInput): VendorReport {
  const { config, preflights } = input;
  const vendors = preflights.map(
    ({ facts }): RunnerVendor => ({
      ...facts,
      models: { ...config.models[facts.vendor] },
      ceilings: { ...config.ceilings[facts.vendor] },
      allowPaidUsage: config.allowPaidUsage[facts.vendor],
      degraded: false,
      preflightAt: input.at,
    }),
  );
  const quota = preflights.flatMap(({ facts, quota }): AccountQuotaReport[] =>
    quota !== null && facts.accountId !== null ? [{ vendor: facts.vendor, accountId: facts.accountId, quota }] : [],
  );
  const weakened = [...new Set([...(input.weakened ?? []), ...preflights.flatMap((result) => result.weakened)])];
  const auto = config.profile === 'auto' && preflights.some((result) => result.weakened.includes('auto'));
  return {
    vendors,
    quota,
    profile: { name: auto ? 'auto' : 'standard', weakened, dependencyPrep: input.preparer.available },
  };
}
