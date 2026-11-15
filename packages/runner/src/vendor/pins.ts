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
  /** The whole npm tarball's sha512 SRI. */
  integrity: string;
}

export interface ClaudePin extends VendorPin {
  /** The @anthropic-ai/claude-agent-sdk version that bundles this CLI; packages/runner depends on it. */
  sdkVersion: string;
  /** The platform checksum in the SDK's manifest.json. */
  sha256: string;
}

export interface CodexPin extends VendorPin {
  /** Package-relative tree containing bin/, codex-path/ and codex-resources/. */
  tree: string;
}

export interface PlatformPins {
  claude: ClaudePin;
  codex: CodexPin;
}

/**
 * Keyed by `<process.platform>-<process.arch>`: darwin-arm64 for the Macs, linux-x64 and linux-arm64 for a cloud runner
 * (glibc builds, as Ubuntu has). Every platform pins the same versions. Elsewhere preflight reports it.
 */
export const VENDOR_PINS: Partial<Record<string, PlatformPins>> = {
  'darwin-arm64': {
    // The claude file of the SDK's platform package, which ships the CLI the SDK was built with.
    claude: {
      version: '2.1.285',
      sdkVersion: '0.3.285',
      package: '@anthropic-ai/claude-agent-sdk-darwin-arm64',
      packageVersion: '0.3.285',
      integrity: 'sha512-2h6iCTH5uPYKA9jBXB7Of0dXZ5hUdu88VnXq9u50AFfMnusy+w83dKgpu+TD+mWiO+mbvMdi1ZsGaoI8HPFTXQ==',
      sha256: '51f09bd1e021d9fa8a1864c179799bd37cb39962a937935c5cf6823398e86db4',
    },
    // Codex has no separate platform package; the platform build of @openai/codex carries the whole vendor tree.
    codex: {
      version: '0.159.2',
      package: '@openai/codex',
      packageVersion: '0.159.2-darwin-arm64',
      integrity: 'sha512-7SPaPFU0tdqapQ5VEgrF+wb+p9dxfWfLMXMKZMRKoWPn/tLMajlMjYBBnu8o6VtaVH2DHQ6kpnp5TMkv5bqvrg==',
      tree: 'vendor/aarch64-apple-darwin',
    },
  },
  'linux-x64': {
    claude: {
      version: '2.1.285',
      sdkVersion: '0.3.285',
      package: '@anthropic-ai/claude-agent-sdk-linux-x64',
      packageVersion: '0.3.285',
      integrity: 'sha512-yVxQ3Xsmme5M9iXnpVQKaBxhGXktl2m2f19fEig30BblvhhRTjF/H1PY4SCA7g9V1D8Ety+0SKMhGZTca4WcWQ==',
      sha256: '33dad1ec615a2e08cc78b494f05c110e49916de2c79d78ec8799ebf46b233d29',
    },
    codex: {
      version: '0.159.2',
      package: '@openai/codex',
      packageVersion: '0.159.2-linux-x64',
      integrity: 'sha512-RrCZ1X52wpa1lOsXtCtSyhjOFdQPh7LH5Ccv8HsKmd/2UXbUwxXFqWXFK3JzatquUNGtW/TLox5Y7qVOGkV0/Q==',
      tree: 'vendor/x86_64-unknown-linux-musl',
    },
  },
  'linux-arm64': {
    claude: {
      version: '2.1.285',
      sdkVersion: '0.3.285',
      package: '@anthropic-ai/claude-agent-sdk-linux-arm64',
      packageVersion: '0.3.285',
      integrity: 'sha512-YbYXqKGtyqpyqY92U8TRcKdrsnO38Ys6oO8aSBqugQyILcv9JEau8/Gtsw1e9cbkGyuNiUP2e2HIiwK3wMa9mg==',
      sha256: '24fac77749bed3d91365d6b6915aa4b824e14318ecb6bc17adbc192f01c9173d',
    },
    codex: {
      version: '0.159.2',
      package: '@openai/codex',
      packageVersion: '0.159.2-linux-arm64',
      integrity: 'sha512-Pm0W2PnFeTEqPx+AOIwgOVB4dBtY24cuD0tx1hjCor60CbSAT7WBPZVNUINSrTCDrMndvQC67p71ZEz+gmPPkA==',
      tree: 'vendor/aarch64-unknown-linux-musl',
    },
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
