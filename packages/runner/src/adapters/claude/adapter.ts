// The Claude adapter (design 8, 13): it starts sessions of the pinned claude and reads and deletes their transcripts
// under the runner's Claude home. A start checks the binary of the attempt's CLI version first (7.4, X-13), then
// spawns the session, pushes the first prompt and resolves once the first system/init passes the first-turn check
// (8.1). A mismatch fails the start and does nothing else (X-29), and so does a CLI that starts no turn within the
// start's deadline. The auto profile runs acceptEdits unless the last preflight saw the account offer auto mode (7.6).
// A resume runs in the same clone with the same options (8.4). A session that never ran a turn has no conversation to
// resume, so a fresh one takes its place without a resume being spawned, and any resume the CLI refuses fails the
// start once the process is gone (7.4): one launch spawns one process.
import type { Vendor } from '@agflow/core';
import type { RunnerPaths } from '../../paths';
import { boundedWait } from '../../processes';
import type { AgentLaunch, AgentSession, AgflowCommand, ExitInfo } from '../types';
import { checkSystemInit, type SystemInitExpectation } from './checks';
import { CLAUDE_BRIEF_HOOK_TIMEOUT_S, claudeBinary, claudeTools, effectivePermissionMode } from './options';
import { readClaudeVersion } from './pin';
import { QuotaBook } from './quota';
import { ClaudeSession } from './session';
import { deleteClaudeTranscript, hasClaudeConversation, readClaudeTranscriptTail } from './transcript';

/** How long a failed start waits for the CLI it ended to exit, before it kills the CLI's group. */
const FAILED_START_EXIT_MS = 5_000;

/** How long a killed CLI gets to be reaped. */
const KILLED_EXIT_MS = 1_000;

/**
 * How long a start waits for the first turn of a new session, or for a resumed CLI's answer to initialize: a minute
 * above the brief hook's timeout. The attempt's later stop waits behind the start, so the start must end.
 */
export const CLAUDE_START_TIMEOUT_MS = (CLAUDE_BRIEF_HOOK_TIMEOUT_S + 60) * 1_000;
const DEFAULT_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

export interface ClaudeAdapterOptions {
  /** How the runner runs agflow; the brief hook runs it (X-5). */
  agflow: AgflowCommand;
  paths: RunnerPaths;
  /** vendorHomes(config, paths): the Claude home is every launch's CLAUDE_CONFIG_DIR. */
  vendorHomes: Record<Vendor, string>;
  /** Test mode (15.1): the scripted server's API key is expected, so the first-turn check leaves apiKeySource be. */
  skipAuthChecks?: boolean;
  /** CLAUDE_START_TIMEOUT_MS by default. */
  startTimeoutMs?: number;
}

export class ClaudeAdapter {
  readonly vendor = 'claude' as const;
  /** The last quota per account, which every session reports into. */
  readonly quota = new QuotaBook();
  /** Whether the last preflight saw the account offer auto mode; before any preflight, it did not. */
  protected autoOffered = false;
  /** The account the last preflight saw; the sessions' quota events name it. */
  protected accountId: string | null = null;

  constructor(protected readonly options: ClaudeAdapterOptions) {}

  async start(launch: AgentLaunch): Promise<AgentSession> {
    // The binary that wrote the session, or the pin for a new one (X-13); --version needs no more than PATH.
    const version = await readClaudeVersion(claudeBinary(this.options.paths, launch.cliVersion), launch.cliVersion, {
      env: { PATH: launch.env.PATH ?? DEFAULT_PATH },
    });
    if (!version.ok) throw new Error(version.problem);
    // Taken once, so the options and the check agree even if a preflight runs meanwhile.
    const expected = this.firstTurnExpectation(launch);
    if (!launch.resume) return this.startNew(launch, expected);
    // A session that never ran a turn cannot be resumed ('No conversation found'): it starts afresh in its clone with
    // the first prompt, and started reports the new sessionRef. Checked before spawning, so the launch registers one
    // process (AgentLaunch.registerProcess).
    const ref = { sessionRef: launch.resume.sessionRef, clone: launch.clone };
    if (!(await hasClaudeConversation(this.options.vendorHomes.claude, ref))) {
      return this.startNew({ ...launch, resume: null }, expected);
    }
    // A resumed session waits for the runner's message, which M2b's controller sends only once start() resolved: so
    // the start resolves once the CLI answers initialize, and the first turn is checked when that message starts it.
    // A mismatch then ends the session (a warning, then SIGTERM), which the hub sees as an exit nobody asked for, not
    // as a failed start (a refinement of 8.1 and X-29).
    const session = this.session(launch, expected);
    const answered = session.initialization().then(
      () => null,
      (error: Error) => error,
    );
    const answer = await this.withinStart(answered);
    if (!answer.done) {
      const problem = `claude did not answer initialize within ${this.startSeconds()} s`;
      throw await this.failedStart(session, problem, { exit: true });
    }
    if (answer.value !== null) throw await this.failedStart(session, answer.value.message, { exit: true });
    return session;
  }

  /** A new session: it pushes the first prompt and resolves once its first system/init passes the check. */
  private async startNew(launch: AgentLaunch, expected: SystemInitExpectation): Promise<ClaudeSession> {
    const session = this.session(launch, expected);
    const first = await this.withinStart(session.firstInit);
    if (!first.done) {
      const problem = `claude started no turn within ${this.startSeconds()} s`;
      throw await this.failedStart(session, problem, { exit: true });
    }
    if (first.value === null) {
      throw await this.failedStart(session, 'claude ended before its first turn', { exit: true });
    }
    if (first.value.problems.length > 0) {
      throw await this.failedStart(session, first.value.problems.join('; '), { exit: false });
    }
    return session;
  }

  /** A start's wait for the CLI, bounded by the start's deadline. */
  private withinStart<T>(promise: Promise<T>): Promise<{ done: true; value: T } | { done: false }> {
    return boundedWait(promise, this.options.startTimeoutMs ?? CLAUDE_START_TIMEOUT_MS);
  }

  private startSeconds(): number {
    return Math.round((this.options.startTimeoutMs ?? CLAUDE_START_TIMEOUT_MS) / 1_000);
  }

  /**
   * The session of a launch: a new one with its first prompt, or the resume of launch.resume. The options refuse a
   * model alias, a launch without a base checkout and a clone whose project name the CLI would hash, before anything
   * is spawned.
   */
  private session(launch: AgentLaunch, expected: SystemInitExpectation): ClaudeSession {
    return new ClaudeSession({
      launch,
      deps: {
        agflow: this.options.agflow,
        paths: this.options.paths,
        vendorHomes: this.options.vendorHomes,
        autoOffered: expected.permissionMode === 'auto',
      },
      firstPrompt: launch.resume ? null : launch.firstPrompt,
      accountId: this.accountId,
      quota: this.quota,
      checkInit: (init) => checkSystemInit(init, expected),
    });
  }

  /** The end of a session's transcript under the runner's Claude home (8.3). */
  readTranscriptTail(input: { sessionRef: string; clone: string; maxChars: number }): Promise<string | null> {
    return readClaudeTranscriptTail(this.options.vendorHomes.claude, input);
  }

  /** cleanup_attempt and retention (7.8). */
  deleteTranscript(input: { sessionRef: string; clone: string }): Promise<void> {
    return deleteClaudeTranscript(this.options.vendorHomes.claude, input);
  }

  /** What the first turn's system/init must say: the attempt's CLI version and the mode the session runs in. */
  private firstTurnExpectation(launch: AgentLaunch): SystemInitExpectation {
    return {
      cliVersion: launch.cliVersion,
      permissionMode: effectivePermissionMode(launch.profile, this.autoOffered),
      tools: claudeTools(launch.profile),
      skipAuthChecks: this.options.skipAuthChecks,
    };
  }

  /**
   * Ends the session's process group, and kills it when it does not exit within a bounded wait, so no work runs after
   * the start failed. The error is the problem, and for a CLI that ended by itself also how it exited and its last
   * stderr lines.
   */
  private async failedStart(session: ClaudeSession, problem: string, options: { exit: boolean }): Promise<Error> {
    session.terminate();
    let exit = await boundedWait(session.exited, FAILED_START_EXIT_MS);
    if (!exit.done) {
      session.kill();
      exit = await boundedWait(session.exited, KILLED_EXIT_MS);
    }
    if (!options.exit) return new Error(problem);
    await session.stderrRead();
    const how = exit.done ? exitText(exit.value) : null;
    // The SDK's error often quotes the CLI's own last line already.
    const stderr = session.stderrTail().trim();
    const parts = [problem, how, problem.includes(stderr) ? null : stderr];
    return new Error(parts.filter((part) => part !== null && part !== '').join(': '));
  }
}

function exitText(exit: ExitInfo): string | null {
  if (exit.signal !== null) return `ended by ${exit.signal}`;
  return exit.code !== null && exit.code !== 0 ? `exit code ${exit.code}` : null;
}
