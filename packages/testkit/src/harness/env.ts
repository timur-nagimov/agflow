// The end-to-end gate (design 15, X-20). The e2e suite stays out of the default `bun test`: it runs only with
// AGFLOW_E2E=1, and then it fails, naming every missing prerequisite and its remedy, instead of skipping.
import { beforeAll, describe } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type Vendor, VendorSchema } from '@agflow/core';
import { findCodexBinary } from '@agflow/runner/src/adapters/codex/binary';
import { runnerPaths } from '@agflow/runner/src/paths';
import { type PlatformPins, VENDOR_PINS, vendorBinary } from '@agflow/runner/src/vendor/pins';
import { findClaudeBinary } from '../anthropic/binary';

type Env = Record<string, string | undefined>;

const VENDORS: readonly Vendor[] = VendorSchema.options;

/** The one platform M2 pins vendor binaries for, so the one the e2e suite runs on. */
export const E2E_PLATFORM = 'darwin-arm64';

/**
 * Each e2e test's timeout: `bun run e2e` passes it as --timeout, and every e2e file sets it as its default, because a
 * file's setDefaultTimeout overrides the flag.
 */
export const E2E_TEST_TIMEOUT_MS = 600_000;

/** Locating both binaries runs each candidate's --version; a cold first run on macOS takes seconds. */
const PREREQS_TIMEOUT_MS = 60_000;

export function e2eEnabled(env: Env = process.env): boolean {
  return env.AGFLOW_E2E === '1';
}

/** The vendors the scenarios run for: AGFLOW_E2E_VENDORS (comma-separated), or both. */
export function e2eVendors(env: Env = process.env): Vendor[] {
  const named = (env.AGFLOW_E2E_VENDORS ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  if (named.length === 0) return [...VENDORS];
  const vendors: Vendor[] = [];
  for (const name of named) {
    if (!(VENDORS as readonly string[]).includes(name)) {
      throw new Error(`AGFLOW_E2E_VENDORS names an unknown vendor '${name}'; use ${VENDORS.join(' and/or ')}`);
    }
    if (!vendors.includes(name as Vendor)) vendors.push(name as Vendor);
  }
  return vendors;
}

/** What the e2e suite found: the vendors it runs for, their pins, and the located pinned binary of each. */
export interface E2ePrereqs {
  vendors: Vendor[];
  pins: PlatformPins;
  binaries: Partial<Record<Vendor, string>>;
}

export interface RequireE2eOptions {
  /** process.env by default: AGFLOW_E2E, AGFLOW_E2E_VENDORS, the binary variables and PATH. */
  env?: Env;
  /** `<platform>-<arch>`; this machine's by default. */
  platform?: string;
  /** The home whose ~/.agflow/runner/vendor the locators search; the real home by default. */
  home?: string;
}

let located: Promise<E2ePrereqs> | null = null;

/**
 * Checks every prerequisite of the e2e suite and gives the located binaries; it throws one error that names each
 * missing prerequisite with its remedy. Without options the answer is computed once per process.
 */
export function requireE2e(options: RequireE2eOptions = {}): Promise<E2ePrereqs> {
  if (Object.keys(options).length > 0) return checkPrereqs(options);
  located ??= checkPrereqs({});
  return located;
}

async function checkPrereqs(options: RequireE2eOptions): Promise<E2ePrereqs> {
  const env = options.env ?? process.env;
  if (!e2eEnabled(env)) throw new Error('the e2e suite runs only with AGFLOW_E2E=1');
  const platform = options.platform ?? `${process.platform}-${process.arch}`;
  const home = options.home ?? homedir();
  const pins = VENDOR_PINS[E2E_PLATFORM];
  if (!pins) throw new Error(`VENDOR_PINS has no ${E2E_PLATFORM} entry`);
  const vendors = e2eVendors(env);
  const missing: string[] = [];
  if (platform !== E2E_PLATFORM) {
    missing.push(`a Mac on Apple silicon (${E2E_PLATFORM}), the only platform with vendor pins; this is ${platform}`);
  }
  const binaries: Partial<Record<Vendor, string>> = {};
  if (vendors.includes('claude')) {
    const found = findClaudeBinary(pins.claude.version, { env, home });
    if (found.path === null) missing.push(found.reason);
    else binaries.claude = found.path;
  }
  if (vendors.includes('codex')) {
    const found = await findCodexBinary({ env, home });
    if (found === null) {
      const version = pins.codex.version;
      const vendored = join(runnerPaths(join(home, '.agflow')).runner, vendorBinary('codex', version));
      const explicit = env.AGFLOW_CODEX_BIN ? `AGFLOW_CODEX_BIN ${env.AGFLOW_CODEX_BIN}` : 'AGFLOW_CODEX_BIN (not set)';
      missing.push(
        `no codex ${version}: neither ${explicit} nor ${vendored} is codex ${version}. ` +
          `Set AGFLOW_CODEX_BIN to a codex ${version} binary, or run \`bun run vendor:install\`.`,
      );
    } else {
      binaries.codex = found;
    }
  }
  const path = env.PATH ?? '';
  if (Bun.which('git', { PATH: path }) === null) {
    missing.push('git is not on PATH: install the Xcode command line tools (`xcode-select --install`).');
  }
  if (Bun.which('lsof', { PATH: path }) === null) {
    missing.push('lsof is not on PATH: macOS ships it in /usr/sbin; add /usr/sbin to PATH.');
  }
  if (missing.length > 0) {
    throw new Error(
      `the e2e suite (AGFLOW_E2E=1) is missing its prerequisites:\n${missing.map((line) => `- ${line}`).join('\n')}`,
    );
  }
  return { vendors, pins, binaries };
}

/**
 * describe for an e2e suite: skipped unless AGFLOW_E2E=1. When it runs, a missing prerequisite fails every test in it,
 * through requireE2e in its beforeAll.
 */
export function describeE2e(name: string, body: () => void, env: Env = process.env): void {
  if (!e2eEnabled(env)) {
    describe.skip(name, body);
    return;
  }
  describe(name, () => {
    beforeAll(async () => {
      await (env === process.env ? requireE2e() : requireE2e({ env }));
    }, PREREQS_TIMEOUT_MS);
    body();
  });
}
