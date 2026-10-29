// The adapter interface (design 13, X-5). The Claude and Codex adapters implement it, and so does testkit's fake
// adapter. The runner core owns everything that is not vendor-specific; an adapter starts and drives one vendor's
// CLI and turns its output into AgentEvents.
import type { AgentRole, Approval, RunnerVendor, Vendor, VendorQuota } from '@agflow/core';
import type { RunnerConfig } from '../config';
import type { RunnerPaths } from '../paths';
import type { PermissionProfile } from '../profile';

/** How the runner runs agflow itself (`{ command, args }`, as the CLI's selfCommand gives it). */
export interface AgflowCommand {
  command: string;
  args: string[];
}

export interface PreflightResult {
  /** The runner adds models, ceilings, allowPaidUsage, preflightAt and degraded false. */
  facts: Pick<
    RunnerVendor,
    'vendor' | 'cliVersion' | 'ownerCliVersion' | 'ready' | 'problem' | 'accountId' | 'plan' | 'managedPolicy'
  >;
  quota: VendorQuota | null;
  /** Boundaries this laptop cannot enforce, merged with the runner's own into hello.profile.weakened. */
  weakened: string[];
}

export interface VendorAdapter {
  readonly vendor: Vendor;
  preflight(): Promise<PreflightResult>;
  start(launch: AgentLaunch): Promise<AgentSession>;
  /** The end of a session's transcript, read without a live session; null when there is none. */
  readTranscriptTail(input: { sessionRef: string; clone: string; maxChars: number }): Promise<string | null>;
  /** cleanup_attempt and retention. */
  deleteTranscript(input: { sessionRef: string; clone: string }): Promise<void>;
  /** Adds to an approval's detail (Codex: manifest diffs); without it the detail is reported as it came. */
  enrichApproval?(input: {
    clone: string;
    vault: string;
    startSha: string;
    request: { kind: Approval['kind']; summary: string; detail: Approval['detail'] };
  }): Promise<Approval['detail']>;
}

/**
 * One per vendor, in packages/runner/src/adapters/<vendor>/entry.ts; it returns null until that vendor's plan fills
 * it. The agflow command reaches adapters here, since preflight needs it outside any launch.
 */
export type AdapterFactory = (input: {
  config: RunnerConfig;
  paths: RunnerPaths;
  agflow: AgflowCommand;
}) => VendorAdapter | null;

export interface AgentLaunch {
  attemptId: string;
  role: AgentRole;
  /** Resolved by the runner. */
  model: string;
  /** The pin at start; the attempt's recorded version on every resume (design 7.4, X-13). */
  cliVersion: string;
  /** The real path of the clone; the agent's cwd. */
  clone: string;
  /** Claude's project configuration root; null for Codex. */
  baseCheckout: string | null;
  /** The clone's .codex/ equals the restore base's (design 9.2). */
  projectConfigVerified: boolean;
  /** CLAUDE_CODE_TMPDIR, or the Codex TMPDIR. */
  tmpDir: string;
  /** The agent environment (design 7.6). */
  env: Record<string, string>;
  /** `<agflow> mcp --vendor <v> --runner` with the bridge's own environment. */
  bridge: { command: string; args: string[]; env: Record<string, string> };
  profile: PermissionProfile;
  /** spec.brief plus "Your working directory: <clone>" (design 10). */
  brief: string;
  firstPrompt: string;
  resume: { sessionRef: string } | null;
  logFile: string;
  /** The runner records the process's pid, pgid and lstart; called before any of its output is read. */
  registerProcess(pid: number): void;
}

export interface AgentSession {
  readonly sessionRef: string;
  readonly pid: number;
  readonly events: AsyncIterable<AgentEvent>;
  send(message: { id: string; text: string; authority: 'person' | 'agent' | 'system' }): Promise<void>;
  interrupt(options?: { cancelQueued?: boolean }): Promise<void>;
  /** Gives whether a pending request took the answer. */
  answerApproval(approvalId: string, decision: 'approve' | 'decline', reason: string | null): Promise<boolean>;
  /** The vendor's own graceful end. */
  close(): Promise<void>;
  readonly exited: Promise<ExitInfo>;
}

/** The tools whose normal result ends or hands over the agent's work. */
export type TerminalTool = 'submit' | 'blocked' | 'impossible' | 'released' | 'handoff';

export type AgentEvent =
  | { type: 'started'; sessionRef: string; model: string; cliVersion: string; permissionMode: string | null }
  | { type: 'turn_started' }
  | {
      type: 'turn_ended';
      outcome: 'completed' | 'interrupted' | 'failed';
      toolCalls: number;
      error: string | null;
      errorKind: 'quota' | 'vendor' | 'auth' | 'context' | 'policy' | 'denials' | 'session_budget' | null;
    }
  | { type: 'tool_started'; toolId: string; name: string; input: string; command: string | null }
  | {
      type: 'tool_ended';
      toolId: string;
      ok: boolean;
      denied: boolean;
      /** Counted only on a normal result (design 10). */
      terminal: TerminalTool | null;
      /** The bridge answered the hub-unreachable text. */
      hubUnreachable: boolean;
    }
  | { type: 'text'; text: string }
  | { type: 'delivered'; id: string }
  | { type: 'acknowledged'; id: string }
  | { type: 'quota'; accountId: string | null; quota: VendorQuota }
  | {
      type: 'approval_request';
      approvalId: string;
      kind: Approval['kind'];
      summary: string;
      detail: Approval['detail'];
    }
  | { type: 'approval_void'; approvalId: string }
  | { type: 'waiting_approval'; waiting: boolean }
  | { type: 'compacted'; summary: string | null }
  | { type: 'context'; used: number }
  /** Reported as an attempt.activity note. */
  | { type: 'warning'; text: string };

export interface ExitInfo {
  code: number | null;
  signal: string | null;
}
