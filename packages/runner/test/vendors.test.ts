import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunnerVendorSchema, TEST_ACCOUNT_ID, type VendorQuota } from '@agflow/core';
import { FakeAdapter } from '@agflow/testkit';
import { claudeAdapterFactory } from '../src/adapters/claude/entry';
import { codexAdapterFactory } from '../src/adapters/codex/entry';
import { ADAPTER_FACTORIES, createAdapters } from '../src/adapters/index';
import type { AdapterFactory, PreflightResult } from '../src/adapters/types';
import { RunnerConfigSchema } from '../src/config';
import { runnerPaths } from '../src/paths';
import { skipDependencyPreparer } from '../src/seams';
import { vendorReport } from '../src/vendors';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const AGFLOW = { command: '/opt/agflow/bin/agflow', args: ['--profile', 'test'] };

function setup(overrides: Record<string, unknown> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'agflow-vendors-'));
  dirs.push(home);
  const config = RunnerConfigSchema.parse({ runnerKey: 'runner-key-test', machineId: 'm', name: 'test', ...overrides });
  return { config, paths: runnerPaths(home) };
}

const QUOTA: VendorQuota = {
  state: 'ok',
  resetsAt: null,
  windows: { fiveHour: 0.2, weekly: 0.1 },
  paidUsage: 'disabled',
  updatedAt: 1_000,
};

function preflight(
  vendor: 'claude' | 'codex',
  fields: Partial<PreflightResult['facts']> = {},
  weakened: string[] = [],
): PreflightResult {
  return {
    facts: {
      vendor,
      cliVersion: '1.0.0',
      ownerCliVersion: null,
      ready: true,
      problem: 'test mode',
      accountId: TEST_ACCOUNT_ID,
      plan: 'test mode',
      managedPolicy: false,
      ...fields,
    },
    quota: QUOTA,
    weakened,
  };
}

describe('createAdapters', () => {
  test("lists each vendor's entry, and an entry gives null or its own vendor's adapter", () => {
    const { config, paths } = setup();
    expect(ADAPTER_FACTORIES).toEqual([claudeAdapterFactory, codexAdapterFactory]);
    expect(createAdapters(config, paths, { agflow: AGFLOW, factories: [() => null, () => null] })).toEqual([]);
    // Holds before and after M2d and M2e fill the entries.
    expect(claudeAdapterFactory({ config, paths, agflow: AGFLOW })?.vendor ?? 'claude').toBe('claude');
    expect(codexAdapterFactory({ config, paths, agflow: AGFLOW })?.vendor ?? 'codex').toBe('codex');
  });

  test('refuses two adapters of one vendor', () => {
    const { config, paths } = setup();
    const factory = (): AdapterFactory => () =>
      new FakeAdapter({ vendor: 'claude', skipAuthChecks: true, script: { turns: [[]] } });
    expect(() => createAdapters(config, paths, { agflow: AGFLOW, factories: [factory(), factory()] })).toThrow(
      'two adapters for claude',
    );
  });

  test('passes the config, the paths and the agflow command to each factory, and keeps what they return', () => {
    const { config, paths } = setup();
    const fake = new FakeAdapter({ vendor: 'codex', skipAuthChecks: true, script: { turns: [[]] } });
    const seen: Parameters<AdapterFactory>[0][] = [];
    const stub: AdapterFactory = (input) => {
      seen.push(input);
      return fake;
    };
    const none: AdapterFactory = () => null;
    expect(createAdapters(config, paths, { agflow: AGFLOW, factories: [none, stub] })).toEqual([fake]);
    expect(seen).toEqual([{ config, paths, agflow: AGFLOW }]);
  });
});

describe('vendorReport', () => {
  test('copies models, ceilings and allowPaidUsage from runner.json and sets preflightAt and degraded false', () => {
    const { config } = setup({
      ceilings: { claude: { fiveHour: 0.5, weekly: 0.6 } },
      allowPaidUsage: { codex: true },
    });
    const report = vendorReport({
      config,
      preflights: [preflight('claude'), preflight('codex', { ready: false, problem: 'binary missing' })],
      at: 42_000,
      preparer: skipDependencyPreparer,
    });
    expect(report.vendors).toEqual([
      {
        ...preflight('claude').facts,
        models: config.models.claude,
        ceilings: { fiveHour: 0.5, weekly: 0.6 },
        allowPaidUsage: false,
        degraded: false,
        preflightAt: 42_000,
      },
      {
        ...preflight('codex', { ready: false, problem: 'binary missing' }).facts,
        models: config.models.codex,
        ceilings: config.ceilings.codex,
        allowPaidUsage: true,
        degraded: false,
        preflightAt: 42_000,
      },
    ]);
    for (const vendor of report.vendors) expect(RunnerVendorSchema.safeParse(vendor).success).toBe(true);
  });

  test('a quota report without an account id is left out; one for TEST_ACCOUNT_ID is kept', () => {
    const { config } = setup();
    const report = vendorReport({
      config,
      preflights: [preflight('claude'), preflight('codex', { accountId: null })],
      at: 1,
      preparer: skipDependencyPreparer,
    });
    expect(report.quota).toEqual([{ vendor: 'claude', accountId: TEST_ACCOUNT_ID, quota: QUOTA }]);
  });

  test("profile.weakened holds the runner's and every adapter's entries once; dependencyPrep is the preparer's", () => {
    const { config } = setup();
    const report = vendorReport({
      config,
      preflights: [preflight('claude', {}, ['/tmp/claude', 'network']), preflight('codex', {}, ['network'])],
      at: 1,
      preparer: { available: true },
      weakened: ['keychain', 'network'],
    });
    expect(report.profile).toEqual({
      name: 'standard',
      weakened: ['keychain', 'network', '/tmp/claude'],
      dependencyPrep: true,
    });
    expect(
      vendorReport({ config, preflights: [], at: 1, preparer: skipDependencyPreparer }).profile.dependencyPrep,
    ).toBe(false);
  });

  test("profile.name is auto only when runner.json asks for auto and an adapter's weakened list holds it", () => {
    const auto = setup({ profile: 'auto' }).config;
    const standard = setup().config;
    const nameOf = (config: typeof auto, weakened: string[]) =>
      vendorReport({
        config,
        preflights: [preflight('claude', {}, weakened), preflight('codex')],
        at: 1,
        preparer: skipDependencyPreparer,
      }).profile.name;
    expect(nameOf(auto, ['auto'])).toBe('auto');
    expect(nameOf(auto, ['/tmp/claude'])).toBe('standard');
    expect(nameOf(standard, ['auto'])).toBe('standard');
  });
});
