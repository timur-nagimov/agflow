// Launching the agent (design 13, 7.4, 7.6, 10). The controller hands the adapter one AgentLaunch: the model the
// runner resolved, the CLI version (the current pin for a new attempt, recorded so every resume and take-over runs
// the same one, X-13), the agent environment with the agent token held only in memory, the bridge command with its
// own environment (X-32), the brief with the clone's path (X-17), the profile, the temporary directory and the
// attempt log. registerProcess records the agent's group in runner.db; the controller reads no event before that
// record is written.
import type { AttemptSpec, Vendor } from '@agflow/core';
import { BRIDGE_TOOL_NAMES } from '../adapters/bridge-tools';
import type { AgentLaunch, AgflowCommand } from '../adapters/types';
import type { AttemptStore, ProcessRecord } from '../attempt-store';
import type { RunnerConfig } from '../config';
import { bridgeEnvOf, buildAgentEnv } from '../env';
import type { Logger } from '../log';
import type { RunnerPaths } from '../paths';
import { type ProcessIdentity, processIdentity, recordGroup } from '../processes';
import { profileOf } from '../profile';
import { VENDOR_PINS, vendorPlatform } from '../vendor/pins';
import type { PreparedWorkspace } from './workspace';

/** The CLI version a new attempt of the vendor starts with: this platform's pin. */
export function pinnedCliVersion(vendor: Vendor, platform: string = vendorPlatform()): string {
  const pins = VENDOR_PINS[platform];
  if (!pins) throw new Error(`agflow pins no ${vendor} CLI for ${platform}`);
  return pins[vendor].version;
}

/** spec.model, or runner.json's models[vendor][role] when the hub left it to the runner. */
export function resolveModel(spec: Pick<AttemptSpec, 'model' | 'vendor' | 'role'>, config: RunnerConfig): string {
  return spec.model ?? config.models[spec.vendor][spec.role];
}

/**
 * `<agflow> mcp --vendor <v> --runner`, run with the bridge's own environment (X-32), and the tools it serves: those
 * of the role its AGFLOW_ROLE names, as the bridge chooses them; none for any other value, which it refuses.
 */
export function bridgeOf(agflow: AgflowCommand, vendor: Vendor, agentEnv: Record<string, string>): AgentLaunch['bridge'] {
  const env = bridgeEnvOf(agentEnv);
  const role = env.AGFLOW_ROLE;
  return {
    command: agflow.command,
    args: [...agflow.args, 'mcp', '--vendor', vendor, '--runner'],
    env,
    tools: role === 'worker' || role === 'lead' ? BRIDGE_TOOL_NAMES[role] : [],
  };
}

/**
 * The agent's process group as runner.db records it. register is what AgentLaunch.registerProcess calls: the pid
 * arrives synchronously, while its start time takes a ps call, so the record is written asynchronously and
 * recorded() resolves once it is. The agent leads its own group, so the group is its pid.
 */
export class ProcessRegistration {
  private pending: Promise<ProcessRecord | null> | null = null;

  constructor(
    private readonly store: AttemptStore,
    private readonly attemptId: string,
    private readonly clone: string,
    private readonly logger: Logger,
    private readonly identify: (pid: number) => Promise<ProcessIdentity | null> = processIdentity,
  ) {}

  register(pid: number): void {
    if (this.pending !== null) throw new Error(`the agent of ${this.attemptId} was already registered`);
    this.pending = this.identify(pid).then(
      (identity) => {
        // Gone already: there is no group left to stop.
        if (identity === null) return null;
        return recordGroup(this.store, this.attemptId, this.clone, identity);
      },
      (error) => {
        this.logger.error('cannot record the agent process', { attemptId: this.attemptId, pid, error: String(error) });
        return null;
      },
    );
  }

  /** The record, once written; null when the process was gone before it could be. */
  recorded(): Promise<ProcessRecord | null> {
    return this.pending ?? Promise.resolve(null);
  }
}

export interface LaunchInput {
  spec: AttemptSpec;
  workspace: PreparedWorkspace;
  config: RunnerConfig;
  paths: RunnerPaths;
  agflow: AgflowCommand;
  cliVersion: string;
  resume: AgentLaunch['resume'];
  registration: ProcessRegistration;
}

/** The AgentLaunch of a start or resume. */
export function buildLaunch(input: LaunchInput): AgentLaunch {
  const { spec, workspace, config, paths } = input;
  const env = buildAgentEnv({
    vendor: spec.vendor,
    spec,
    clone: workspace.clone,
    tools: workspace.runDir.tools,
    tmpDir: workspace.tmpDir,
    config,
    paths,
  });
  return {
    attemptId: spec.attemptId,
    role: spec.role,
    model: resolveModel(spec, config),
    cliVersion: input.cliVersion,
    clone: workspace.clone,
    baseCheckout: workspace.baseCheckout?.path ?? null,
    projectConfigVerified: workspace.projectConfigVerified,
    // Claude: the private /tmp/agf/<id>; Codex: the tool commands' TMPDIR inside the clone (design 7.6).
    tmpDir: workspace.tmpDir ?? workspace.runDir.tmp,
    env,
    bridge: bridgeOf(input.agflow, spec.vendor, env),
    profile: profileOf(config),
    brief: workspace.brief,
    firstPrompt: spec.firstPrompt,
    resume: input.resume,
    logFile: paths.attemptLog(spec.attemptId),
    registerProcess: (pid) => input.registration.register(pid),
  };
}
