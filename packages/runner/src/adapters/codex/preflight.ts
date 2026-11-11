// The zero-model Codex preflight (design 9.1): the pinned binary's version, then one app-server in the runner's own
// homes for the account, the managed policy, MCP servers, skills and rate limits. Every failure is a not-ready
// result, never an exception, and the app-server is always ended.
import { TEST_ACCOUNT_ID } from '@agflow/core';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isTestMode, type RunnerConfig, type RunnerTestBlock, vendorHomes } from '../../config';
import { userVariables } from '../../env';
import type { Logger } from '../../log';
import type { RunnerPaths } from '../../paths';
import { VENDOR_PINS, vendorBinary, vendorPlatform } from '../../vendor/pins';
import type { PreflightResult } from '../types';
import { CODEX_VERSION, codexBinaryVersion, ownerCodexVersion } from './binary';
import { quotaFromRateLimits } from './classify';
import { appServerArgs, appServerEnv } from './config';
import { classifyCodexPolicy, codexAccountIdentity } from './policy';
import { openAppServer } from './process';

/** What every app-server the runner starts shares: its homes, its base environment and the test switches. */
export interface CodexProcessOptions {
  codexHome: string;
  userHome: string;
  /** The captured login PATH and connectivity variables plus the user variables (design 7.6). */
  base: Record<string, string | undefined>;
  /** test.codexConfig, only in test mode. */
  codexConfig: RunnerTestBlock['codexConfig'] | null;
  /** test.skipAuthChecks, only in test mode. */
  skipAuthChecks: boolean;
}

/** The one derivation for preflight, transcript deletion and sessions, with the one test-mode gate. */
export function codexProcessOptions(input: {
  config: RunnerConfig;
  paths: RunnerPaths;
  /** Where AGFLOW_TEST and the user variables are read; process.env by default. */
  env?: Record<string, string | undefined>;
}): CodexProcessOptions {
  const { config, paths } = input;
  const env = input.env ?? process.env;
  // The user variables as buildAgentEnv gives them to sessions.
  const base: Record<string, string | undefined> = {
    PATH: config.capturedPath,
    ...config.connectivity,
    ...userVariables(env),
  };
  const testMode = isTestMode(config, env);
  return {
    codexHome: vendorHomes(config, paths).codex,
    userHome: paths.homes.codexUser,
    base,
    codexConfig: testMode ? (config.test?.codexConfig ?? null) : null,
    skipAuthChecks: testMode && (config.test?.skipAuthChecks ?? false),
  };
}

export interface CodexPreflightOptions extends CodexProcessOptions {
  /** The pinned binary and logs/codex-preflight.log. */
  paths: RunnerPaths;
  /** runner.json's captured login PATH, where the owner's own install is found. */
  capturedPath: string;
  platform?: string;
  arch?: string;
  logger?: Logger;
  /** Bounds each app-server request; tests pass a short one. */
  requestTimeoutMs?: number;
}

export async function runCodexPreflight(options: CodexPreflightOptions): Promise<PreflightResult> {
  const { paths, codexHome, userHome, skipAuthChecks, logger, requestTimeoutMs } = options;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const result: PreflightResult = {
    facts: {
      vendor: 'codex',
      cliVersion: null,
      ownerCliVersion: null,
      ready: false,
      problem: null,
      accountId: null,
      plan: null,
      managedPolicy: true,
    },
    quota: null,
    weakened: [],
  };
  const facts = result.facts;
  try {
    // The owner's install is for information, so it is reported whatever else fails, and its own failure fails
    // nothing. The captured login PATH finds it; the service's own PATH is minimal.
    facts.ownerCliVersion = await ownerCodexVersion({ env: { PATH: options.capturedPath }, platform, arch }).catch(
      (error: unknown) => {
        logger?.warn('codex preflight: owner version failed', { error: String(error) });
        return null;
      },
    );
    if (!VENDOR_PINS[vendorPlatform(platform, arch)]?.codex) {
      facts.problem = 'unsupported platform';
      return result;
    }
    await Promise.all([codexHome, userHome].map((home) => mkdir(home, { recursive: true, mode: 0o700 })));
    const bin = join(paths.runner, vendorBinary('codex', CODEX_VERSION));
    if (!existsSync(bin)) {
      facts.problem = 'binary missing';
      return result;
    }
    facts.cliVersion = await codexBinaryVersion(bin, { homes: { codex: codexHome, user: userHome } });
    if (facts.cliVersion !== CODEX_VERSION) {
      facts.problem =
        facts.cliVersion === null
          ? 'could not read codex binary version'
          : `codex binary is version ${facts.cliVersion}, expected ${CODEX_VERSION}`;
      return result;
    }
    const app = await openAppServer({
      bin,
      args: appServerArgs(options.codexConfig),
      env: appServerEnv({ base: options.base, bridgeEnv: {}, codexHome, userHome }),
      cwd: userHome,
      expectedVersion: CODEX_VERSION,
      logFile: join(paths.logs, 'codex-preflight.log'),
      logger,
      requestTimeoutMs,
    });
    try {
      const account = skipAuthChecks
        ? null
        : await app.rpc.request('account/read', { refreshToken: false }).catch(() => null);
      const requirements = await app.rpc.request('configRequirements/read', undefined).catch(() => null);
      const configuration = await app.rpc.request('config/read', { includeLayers: true }).catch(() => null);
      const mcp = await app.rpc.request('mcpServerStatus/list', {}).catch(() => null);
      const skills = await app.rpc.request('skills/list', { cwds: [userHome] }).catch(() => null);
      const rateLimits = await app.rpc.request('account/rateLimits/read', undefined).catch(() => null);
      const policy = classifyCodexPolicy({ requirements, config: configuration });
      const identity = skipAuthChecks
        ? { accountId: TEST_ACCOUNT_ID, plan: 'test mode', problem: null }
        : codexAccountIdentity(account?.account ?? null);
      const mcpProblem =
        mcp === null
          ? 'could not check MCP servers'
          : mcp.data.length > 0
            ? `unexpected MCP servers: ${mcp.data.map((server) => server.name).join(', ')}`
            : null;
      const unexpectedSkills =
        skills?.data
          .flatMap((entry) => entry.skills)
          .filter((skill) => skill.scope === 'user' || skill.pluginId !== null) ?? [];
      const skillsProblem =
        skills === null
          ? 'could not check skills'
          : unexpectedSkills.length > 0
            ? `unexpected user or plugin skills: ${unexpectedSkills.map((skill) => skill.name).join(', ')}`
            : null;
      facts.accountId = identity.accountId;
      facts.plan = identity.plan;
      facts.managedPolicy = policy.managedPolicy;
      facts.problem = policy.problem ?? identity.problem ?? mcpProblem ?? skillsProblem;
      facts.ready = facts.problem === null;
      if (facts.ready && skipAuthChecks) facts.problem = 'test mode';
      if (rateLimits !== null) {
        const quota = quotaFromRateLimits(rateLimits.rateLimits);
        // The backend's own permission for included usage: low percentages and no reached type do not imply it.
        if (rateLimits.ordinaryUsageAllowed === false) {
          const credits = rateLimits.rateLimits.credits;
          if (credits?.hasCredits || credits?.unlimited) quota.paidUsage = 'in_use';
          if (quota.paidUsage !== 'in_use') quota.state = 'exhausted';
        }
        result.quota = quota;
      }
    } finally {
      await app.end();
    }
  } catch (error) {
    facts.ready = false;
    facts.problem = error instanceof Error ? error.message : String(error);
  }
  return result;
}
