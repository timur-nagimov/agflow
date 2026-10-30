// Stops of a live agent (design 6.8, Replacement steps 1-3; 6.13, Hold; 6.4, the runner's own stops; 7.1). Every
// stop prepares the agent, then runs the stop ladder (stop-ladder.ts), and the controller's exit work follows:
// - stop_attempt: when interruptFirst is set or a tool is in flight, the turn is interrupted, queued input dropped,
//   and its end waited for (up to stopInterrupt); with handoff, a handoff note is asked for as its own turn and
//   waited for up to the hub's handoff time, until write_handoff, the end of the turn that took the prompt (its
//   acknowledged event), or the agent's end. A prompt sent while a turn still runs waits for that turn to end, and
//   is then taken as the next one. A note written before the stop arrived does not count: the stop asks again.
//   Every call to the agent is bounded too, so an agent whose control channel no longer answers reaches the ladder.
// - hold_attempt: no further continuation; the running turn may end by itself (up to hold), so the agent sees its
//   submit's result; then the ladder, with no handoff turn. Clone and session stay, as after every stop.
// - The runner's own stops (X-41): runner_stop with a handoff turn (agflow runner stop and uninstall) or without one
//   (the disk and battery guards), and suspend without one (SIGTERM), each reported as attempt.exited.cause.
// The runner removes a clone and its session only on cleanup_attempt, so keepClone needs nothing of a stop: the
// hub sends it so that a stopped-and-held attempt keeps its clone for a person's take-over.
import { randomUUID } from 'node:crypto';
import type { ExitCause, StoppedBy } from '@agflow/core';
import type { AgentEvent, AgentSession } from '../adapters/types';
import { boundedWait } from '../processes';

/** The reason a runner's own stop gives in its handoff prompt. */
export const RUNNER_STOP_REASON = 'the runner is stopping';

export interface StopOptions {
  /** Ask for a handoff note as its own turn before the ladder (design 6.8). */
  handoff: boolean;
  /** Interrupt the running turn first, even with no tool in flight (stuck tools, quiet agents, loops). */
  interruptFirst: boolean;
  /** Why the attempt stops, as the hub or the runner words it; the handoff prompt quotes it. */
  reason: string;
  /** attempt.exited.cause: the runner's own stops; null for the hub's. */
  cause: ExitCause | null;
}

/** What a stop did: the step that ended the agent and the seq of its attempt.exited, or why nothing was stopped. */
export type StopOutcome =
  | { ok: true; stoppedBy: StoppedBy; exitedSeq: number }
  | { ok: false; error: 'stale_fence' | 'not_running' };

/** The handoff turn's prompt: the hub's or the runner's reason, then what the note must hold. */
export function handoffPrompt(reason: string): string {
  return (
    `agflow is stopping this attempt: ${reason}. Do not start new work. Call write_handoff now with a handoff note ` +
    'for whoever continues: what you did, what is left, what you were about to do next, and anything that surprised ' +
    'you. Your uncommitted work is saved for them.'
  );
}

/**
 * A live agent's turns as stops and holds follow them: whether a turn runs, and waits for events to come. The
 * controller feeds it every event after the pump has handled it, and ends it when the agent's events end, which
 * settles every wait.
 */
export class TurnWatch {
  private running = false;
  private ended = false;
  private readonly waiters = new Set<{ match: (event: AgentEvent) => boolean; resolve: () => void }>();

  /** Whether a turn is running. */
  get inTurn(): boolean {
    return this.running;
  }

  observe(event: AgentEvent): void {
    if (event.type === 'turn_started') this.running = true;
    if (event.type === 'turn_ended') this.running = false;
    for (const waiter of [...this.waiters]) {
      if (!waiter.match(event)) continue;
      this.waiters.delete(waiter);
      waiter.resolve();
    }
  }

  /** The agent's events have ended: no turn runs, and every wait is over. */
  end(): void {
    this.ended = true;
    this.running = false;
    for (const waiter of this.waiters) waiter.resolve();
    this.waiters.clear();
  }

  /** Resolves on the next event that matches, or when the events end. */
  until(match: (event: AgentEvent) => boolean): Promise<void> {
    if (this.ended) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.waiters.add({ match, resolve });
    });
  }

  /** Resolves once no turn runs. */
  turnEnded(): Promise<void> {
    return this.running ? this.until((event) => event.type === 'turn_ended') : Promise.resolve();
  }
}

export interface PrepareStopInput {
  session: Pick<AgentSession, 'interrupt' | 'send'>;
  watch: TurnWatch;
  /** Whether a tool call is in flight now. */
  toolInFlight(): boolean;
  /** Whether the agent has written a handoff note since the stop arrived. */
  handoffWritten(): boolean;
  options: Pick<StopOptions, 'handoff' | 'interruptFirst' | 'reason'>;
  /** Ms the interrupt and the interrupted turn's end are waited for: stopInterrupt. */
  interruptMs: number;
  /** Ms the handoff note is waited for, the prompt's send included: the hub's handoffMs. */
  handoffMs: number;
}

/**
 * Steps 1 and 2 of a replacement (design 6.8): the interrupt when a tool is in flight or interruptFirst is set,
 * then the handoff turn. Every wait is bounded; an agent that is gone, or does not answer, only ends them early.
 */
export async function prepareForStop(input: PrepareStopInput): Promise<void> {
  const { session, watch, options } = input;
  if (watch.inTurn && (options.interruptFirst || input.toolInFlight())) {
    // Queued input is dropped, so no message or continuation starts another turn first.
    const interrupted = session.interrupt({ cancelQueued: true }).catch(() => {});
    await boundedWait(Promise.all([interrupted, watch.turnEnded()]), input.interruptMs);
  }
  if (!options.handoff || input.handoffWritten()) return;
  const deadline = performance.now() + input.handoffMs;
  const remaining = () => Math.max(0, deadline - performance.now());
  const id = randomUUID();
  const written = watch.until((event) => event.type === 'tool_ended' && event.terminal === 'handoff');
  // The prompt's own turn: the one that took it ends with its acknowledged event, whether it ran next or the
  // running turn folded the prompt in at a tool boundary.
  const answered = watch.until((event) => event.type === 'acknowledged' && event.id === id);
  const sent = await boundedWait(
    session.send({ id, text: handoffPrompt(options.reason), authority: 'system' }).then(
      () => true,
      () => false,
    ),
    remaining(),
  );
  // The agent is gone, or does not take input: the ladder finds it so.
  if (!sent.done || !sent.value) return;
  await boundedWait(Promise.race([written, answered]), remaining());
}
