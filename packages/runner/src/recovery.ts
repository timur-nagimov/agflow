// Startup recovery (design 7.4, "Runner start"; 6.3, hello.attempts; X-36). Before the first hello the runner
// settles what a previous run left: every registered group whose leader is still the process the registry recorded
// (pid, pgid and lstart) is killed, and every recorded clone swept, so no agent or escaped tool of a dead runner keeps
// writing; a pid that now belongs to another process is not signalled. The registry is then cleared, and the attempts
// that had a process are recorded as stopped; suspended ones stay suspended, so the hub resumes them as such. No
// agent is resumed here: the hub decides that from hello. killRegisteredGroups is exported for M2c's uninstall (X-7).
//
// hello lists every attempt whose start or resume the runner recorded, as LiveAttempt entries with design 6.3's
// states: starting before attempt.spawned, running while its process lives (a worker, or a lead in a turn), idle for
// a lead's process between wake-ups, stopped with no process, suspended after a suspend. An ended attempt stays listed
// as stopped while its clone waits for cleanup_attempt; once cleaned up it is left out.
import type { LiveAttempt } from '@agflow/core';
import type { AttemptController } from './attempt/controller';
import type { AttemptStore, ProcessRecord } from './attempt-store';
import { cloneExists } from './git/clone';
import { type Logger, noopLogger } from './log';
import { killAndSweep } from './stop-ladder';

/**
 * Kills the registered groups whose leader is still the recorded process, then sweeps each recorded clone once, also
 * when its leader is gone or its pid now belongs to another process, and clears the registry. Gives the groups it
 * killed.
 */
export async function killRegisteredGroups(store: AttemptStore, logger: Logger = noopLogger): Promise<ProcessRecord[]> {
  const groups = store.processes();
  const byClone = new Map<string | null, ProcessRecord[]>();
  // Every recorded clone is swept: a leader that is gone, or whose pid was reused, may have left escaped tools
  // writing there. Only the group kill checks the leader's identity, as killGroup does for every group signal.
  for (const group of groups) byClone.set(group.clone, [...(byClone.get(group.clone) ?? []), group]);
  const killed: ProcessRecord[] = [];
  for (const [clone, recorded] of byClone) {
    const result = await killAndSweep({ groups: async () => recorded, clone });
    killed.push(...recorded.filter((group) => result.killed.includes(group.pgid)));
    if (result.sweepSkipped !== null) logger.warn('cannot sweep a recorded clone', { clone, why: result.sweepSkipped });
  }
  // What is left of them is dead or someone else's; the next start records its own groups.
  for (const group of groups) store.forgetProcess(group.attemptId, group.pgid);
  return killed;
}

/** Settles what a previous run left, before the first hello: its processes killed, its live attempts stopped. */
export async function recoverOnStart(store: AttemptStore, logger: Logger = noopLogger): Promise<void> {
  const killed = await killRegisteredGroups(store, logger);
  if (killed.length > 0) {
    const attempts = [...new Set(killed.map((group) => group.attemptId))];
    logger.info('killed the agents a previous run left', { attempts });
  }
  for (const record of store.list()) {
    if (record.state === 'starting' || record.state === 'running' || record.state === 'idle') {
      store.update(record.attemptId, { state: 'stopped' });
    }
  }
}

/**
 * hello.attempts: every recorded attempt as a LiveAttempt, except ended ones whose clone is gone. The runtime gives
 * its controllers, whose live processes tell running from a lead idle between wake-ups on a reconnect.
 */
export function liveAttemptsForHello(
  store: AttemptStore,
  controllers: ReadonlyMap<string, Pick<AttemptController, 'phase' | 'session'>> = new Map(),
): LiveAttempt[] {
  return store.list().flatMap((record): LiveAttempt[] => {
    const clone = record.clone !== null && cloneExists(record.clone);
    if ((record.endedAt !== null || record.state === 'ended') && !clone) return [];
    const controller = controllers.get(record.attemptId);
    let state: LiveAttempt['state'] = record.state === 'ended' ? 'stopped' : record.state;
    if (controller?.session) {
      const between = record.spec.role === 'lead' && controller.phase === 'idle';
      if (record.state !== 'starting') state = between ? 'idle' : 'running';
    } else if (controller?.phase === 'starting' || controller?.phase === 'preparing') {
      // A start or resume under way, with no process yet.
      state = 'starting';
    }
    return [{ attemptId: record.attemptId, fence: record.fence, state, sessionRef: record.sessionRef, clone }];
  });
}
