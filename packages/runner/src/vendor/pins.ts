// The one place for each vendor binary the runner runs (design 7.1, X-10). The runner installs its own pinned
// binaries under runner/vendor and never uses or changes the owner's installs.
import { join } from 'node:path';
import type { Vendor } from '@agflow/core';

export interface VendorPin {
  /** The version `<binary> --version` prints. */
  version: string;
  /** The npm package the binary comes from, at packageVersion. */
  package: string;
  packageVersion: string;
}

export interface ClaudePin extends VendorPin {
  /** The @anthropic-ai/claude-agent-sdk version that bundles this CLI; packages/runner depends on it. */
  sdkVersion: string;
}

export interface PlatformPins {
  claude: ClaudePin;
  codex: VendorPin;
}

/** Keyed by `<process.platform>-<process.arch>`. M2 pins darwin-arm64 only; elsewhere preflight reports it. */
export const VENDOR_PINS: Partial<Record<string, PlatformPins>> = {
  'darwin-arm64': {
    // The claude file of the SDK's platform package, which ships the CLI the SDK was built with.
    claude: {
      version: '2.1.285',
      sdkVersion: '0.3.285',
      package: '@anthropic-ai/claude-agent-sdk-darwin-arm64',
      packageVersion: '0.3.285',
    },
    // Codex has no separate platform package; the platform build of @openai/codex carries the whole vendor tree.
    codex: { version: '0.159.2', package: '@openai/codex', packageVersion: '0.159.2-darwin-arm64' },
  },
};

export function vendorPlatform(platform: string = process.platform, arch: string = process.arch): string {
  return `${platform}-${arch}`;
}

const VERSION = /^\d+\.\d+\.\d+$/;

/** A vendor binary's path relative to RunnerPaths.runner; callers join it. */
export function vendorBinary(vendor: Vendor, version: string): string {
  if (!VERSION.test(version)) throw new Error(`not a vendor version: ${JSON.stringify(version)}`);
  return vendor === 'claude'
    ? join('vendor', 'claude', version, 'claude')
    : join('vendor', 'codex', version, 'bin', 'codex');
}

const VERSION_OUTPUT: Record<Vendor, RegExp> = {
  claude: /^(\d+\.\d+\.\d+) \(Claude Code\)$/,
  codex: /^codex-cli (\d+\.\d+\.\d+)$/,
};

/** The version in a vendor binary's `--version` output, or null for any other output. */
export function parseVendorVersion(vendor: Vendor, output: string): string | null {
  return output.trim().match(VERSION_OUTPUT[vendor])?.[1] ?? null;
}
