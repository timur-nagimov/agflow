// The stop ladder (design 7.4, 8.4, 9.4): one function every stop uses. Each step waits a bounded time for the agent
// to exit and records what ended it in stoppedBy, core's STOPPED_BY: a SIGTERMed claude exits 143, not by signal,
// and exit code 0 does not mean a clean finish, so stoppedBy, not the exit, says whether the runner asked. Whatever
// step ends the agent, the recorded groups are then SIGKILLed and the clone is swept, so no tool outlives a stop.
// Every group kill checks the leader's identity first, because macOS PIDs wrap. Nothing waits on the agent's pipes,
// nor on the vendor's close: an escaped grandchild that inherited them, or a close that never returns, must not hold
// a stop. The sweep never follows the clone path's last component, which the agent can replace with a link.
import { lstat } from 'node:fs/promises';
import type { StoppedBy } from '@agflow/core';
import type { AgentSession, ExitInfo } from './adapters/types';
import type { RunnerTimings } from './config';
import { boundedWait, killGroup, type ProcessIdentity, sweepCloneProcesses } from './processes';

/** How long a SIGKILLed agent's exit is waited for: the kill is immediate, but its exit report may not be. */
export const EXIT_AFTER_KILL_MS = 1_000;

export interface KillAndSweepInput {
  /**
   * The groups to signal, read at each step so a group recorded meanwhile is included: the attempt's recorded
   * groups and those its descendant snapshots found.
   */
  groups(): Promise<readonly ProcessIdentity[]>;
  /** The clone whose processes are swept; null sweeps nothing. */
  clone: string | null;
}

export interface KillAndSweepResult {
  /** The groups SIGKILLed: those whose leader identity still matched. */
  killed: number[];
  /** The processes the sweep killed. */
  swept: number[];
  /** Why no sweep ran: a missing lsof, a clone path that is not a directory, or a sweep that failed. */
  sweepSkipped: string | null;
}

export interface StopLadderInput extends KillAndSweepInput {
  session: Pick<AgentSession, 'interrupt' | 'close' | 'exited'>;
  /** Resolves once no turn is running; the caller reads the session's events. */
  turnEnded(): Promise<void>;
  timings: Pick<RunnerTimings, 'stopInterrupt' | 'stopClose' | 'stopKill'>;
}

export interface StopLadderResult extends KillAndSweepResult {
  stoppedBy: StoppedBy;
  /** null when the agent's exit was not reported within the last bound. */
  exit: ExitInfo | null;
}

/** Signals every group whose leader identity still matches; gives the pgids signalled. */
async function signalGroups(groups: readonly ProcessIdentity[], name: NodeJS.Signals): Promise<number[]> {
  const signalled: number[] = [];
  for (const group of groups) {
    if (signalled.includes(group.pgid)) continue;
    if (await killGroup(group, name)) signalled.push(group.pgid);
  }
  return signalled;
}

/**
 * Ladder steps 3 and 4 alone: SIGKILL every group that passes the identity check, then sweep the clone. Exits the
 * runner did not request run this before the final harvest, so no orphaned tool writes during or after it (X-15).
 */
export async function killAndSweep(input: KillAndSweepInput): Promise<KillAndSweepResult> {
  const killed = await signalGroups(await input.groups(), 'SIGKILL');
  if (input.clone === null) return { killed, swept: [], sweepSkipped: null };
  // A link or a file the agent put in the clone's place is not swept: through it the sweep would kill the owner's
  // processes wherever it points.
  const stat = await lstat(input.clone).catch(() => null);
  if (stat !== null && !stat.isDirectory()) {
    return { killed, swept: [], sweepSkipped: 'the clone path is not a directory' };
  }
  try {
    const sweep = await sweepCloneProcesses(input.clone);
    return { killed, swept: sweep.killed, sweepSkipped: sweep.skipped };
  } catch (error) {
    // The agent is gone either way; a sweep that cannot run must not fail its stop or its exit.
    const detail = error instanceof Error ? error.message : String(error);
    return { killed, swept: [], sweepSkipped: `the sweep failed: ${detail}` };
  }
}

/** Runs a request to the agent, which may already be gone; it never fails the stop. */
async function ask(request: () => Promise<void>): Promise<void> {
  try {
    await request();
  } catch {
    // The agent's input is closed or the agent has exited: the next step's wait tells.
  }
}

/**
 * Stops an agent: the protocol interrupt, up to stopInterrupt for the turn to end; the vendor's own close, up to
 * stopClose for the exit; SIGTERM to every recorded group, up to stopKill; then SIGKILL to every recorded group and
 * a sweep of the clone. Returns within the sum of those bounds, EXIT_AFTER_KILL_MS and the sweep.
 */
export async function runStopLadder(input: StopLadderInput): Promise<StopLadderResult> {
  const { session, timings } = input;
  const finish = async (stoppedBy: StoppedBy, exit: ExitInfo | null): Promise<StopLadderResult> => ({
    stoppedBy,
    exit,
    ...(await killAndSweep(input)),
  });
  const exitWithin = async (ms: number, also?: Promise<unknown>) => {
    const waited = await boundedWait(also ? Promise.race([session.exited, also]) : session.exited, ms);
    if (!waited.done) return null;
    // Only the exit itself, not the end of the turn, settles the step.
    const exited = await boundedWait(session.exited, 0);
    return exited.done ? exited.value : null;
  };

  const already = await boundedWait(session.exited, 0);
  if (already.done) return finish('none', already.value);

  // 1. The interrupt, cancelling queued input so no message or continuation starts a turn.
  const turnOver = (async () => {
    await ask(() => session.interrupt({ cancelQueued: true }));
    await ask(() => input.turnEnded());
  })();
  const interrupted = await exitWithin(timings.stopInterrupt, turnOver);
  if (interrupted) return finish('interrupt', interrupted);

  // 2. The vendor's own close: stdin EOF ends app-server and its commands, and an idle claude. The close itself is
  // not waited for, only the exit: a close that never returns must not keep the ladder from SIGTERM.
  void ask(() => session.close());
  const closed = await exitWithin(timings.stopClose);
  if (closed) return finish('close', closed);

  // 3. SIGTERM to every recorded group, then SIGKILL.
  await signalGroups(await input.groups(), 'SIGTERM');
  const terminated = await exitWithin(timings.stopKill);
  if (terminated) return finish('sigterm', terminated);
  const result = await finish('sigkill', null);
  const killed = await boundedWait(session.exited, EXIT_AFTER_KILL_MS);
  return { ...result, exit: killed.done ? killed.value : null };
}
