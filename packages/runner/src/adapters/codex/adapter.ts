// The Codex adapter (design 9, 13): the VendorAdapter the registry's Codex entry returns (X-6). Preflight, sessions and
// transcript deletion share one derivation of the homes, base environment and test switches (codexProcessOptions), and
// a session runs the binary of its launch's cliVersion, the recorded one on a resume (X-13). A missing binary is
// preflight's 'binary missing', never a failed construction.
import { mkdir } from 'node:fs/promises';
import type { RunnerConfig } from '../../config';
import { localGitEnv } from '../../git/run';
import type { Logger } from '../../log';
import type { RunnerPaths } from '../../paths';
import type { AgentLaunch, PreflightResult, VendorAdapter } from '../types';
import { codexEnrichApproval } from './manifest-diff';
import { codexProcessOptions, runCodexPreflight, type CodexProcessOptions } from './preflight';
import { CodexSession } from './session';
import { deleteCodexTranscript, readCodexTranscriptTail } from './transcript';

export interface CodexAdapterOptions {
  config: RunnerConfig;
  paths: RunnerPaths;
  /** Where AGFLOW_TEST and the user variables are read; process.env by default. */
  env?: Record<string, string | undefined>;
  logger?: Logger;
  requestTimeoutMs?: number;
  platform?: string;
  arch?: string;
}

/**
 * The homes, base environment and test switches the adapter resolves from its config, paths and env. Transcript
 * deletion resolves them from the same three inputs, so the adapter takes no other source of them.
 */
export function codexAdapterOptions(
  config: RunnerConfig,
  paths: RunnerPaths,
  env: Record<string, string | undefined> = process.env,
): CodexProcessOptions {
  return codexProcessOptions({ config, paths, env });
}

export class CodexAdapter implements VendorAdapter {
  readonly vendor = 'codex' as const;

  private readonly resolved: CodexProcessOptions;

  constructor(private readonly options: CodexAdapterOptions) {
    this.resolved = codexAdapterOptions(options.config, options.paths, options.env);
  }

  preflight(): Promise<PreflightResult> {
    const { config, paths, logger, requestTimeoutMs, platform, arch } = this.options;
    return runCodexPreflight({
      ...this.resolved,
      paths,
      capturedPath: config.capturedPath,
      platform,
      arch,
      logger,
      requestTimeoutMs,
    });
  }

  async start(launch: AgentLaunch): Promise<CodexSession> {
    const { paths, logger, requestTimeoutMs } = this.options;
    const { codexHome, userHome, codexConfig, skipAuthChecks } = this.resolved;
    // The homes are made as preflight and deletion make them: the user home is app-server's cwd, and a start must not
    // depend on a preflight having run first.
    await Promise.all([codexHome, userHome].map((home) => mkdir(home, { recursive: true, mode: 0o700 })));
    // The session resolves the binary from launch.cliVersion, including the recorded version on resume (X-13).
    return CodexSession.start(launch, {
      runnerDir: paths.runner,
      codexHome,
      userHome,
      testConfig: codexConfig,
      skipAuthChecks,
      logger,
      requestTimeoutMs,
    });
  }

  readTranscriptTail({
    sessionRef,
    maxChars,
  }: Parameters<VendorAdapter['readTranscriptTail']>[0]): Promise<string | null> {
    return readCodexTranscriptTail({ codexHome: this.resolved.codexHome, sessionRef, maxChars });
  }

  deleteTranscript({ sessionRef }: Parameters<VendorAdapter['deleteTranscript']>[0]): Promise<void> {
    const { config, paths, env, logger, requestTimeoutMs } = this.options;
    return deleteCodexTranscript({ sessionRef, config, paths, env, logger, requestTimeoutMs });
  }

  // A property, so it works detached from the adapter, as callers may hold it.
  readonly enrichApproval: NonNullable<VendorAdapter['enrichApproval']> = (input) =>
    codexEnrichApproval(input, localGitEnv(this.options.paths));
}

export function createCodexAdapter(options: CodexAdapterOptions): CodexAdapter {
  return new CodexAdapter(options);
}
