// What the Load page and the top strip say (GET /api/load). Free of the DOM, so the wording is unit-tested; the hub
// computes every number, with core's placement rules for the accounts.
import { type AccountLoad, type HubLoad, PLACEMENT_REFUSAL_WORDS, type ProjectLoad } from '@agflow/core';
import { type Tone, VENDOR_NAMES, duration, percent } from './format';
import { clockTime } from './runners';

/** An account's state: Ready when one of its runners can take an attempt now, else why placement passes it over. */
export function accountStateText(state: AccountLoad['state']): string {
  const words = state === 'ok' ? 'ready' : PLACEMENT_REFUSAL_WORDS[state];
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

/** Ready is good, full is busy as it should be, offline is simply away; anything else waits for something. */
export function accountTone(state: AccountLoad['state']): Tone {
  if (state === 'ok') return 'done';
  if (state === 'full') return 'active';
  if (state === 'offline') return 'closed';
  return 'wait';
}

/** "alice · Claude Code · Claude Max". */
export function accountName(account: Pick<AccountLoad, 'owner' | 'vendor' | 'plan'>): string {
  return [account.owner, VENDOR_NAMES[account.vendor], account.plan].filter((part) => part !== null).join(' · ');
}

/** The slots the vendor's attempts take on the owner's online runners: "1 of 2". */
export function slotText(account: Pick<AccountLoad, 'busy' | 'capacity'>): string {
  return `${account.busy} of ${account.capacity}`;
}

/** One quota window against the runners' ceiling: "42% of 85%", or "unknown of 85%". */
export function windowText(used: number | null, ceiling: number): string {
  return `${used === null ? 'unknown' : percent(used)} of ${percent(ceiling)}`;
}

/** Whether a window has reached the ceiling, so the vendor gets no new attempts there. */
export const overCeiling = (used: number | null, ceiling: number): boolean => used !== null && used >= ceiling;

/** When the limiting window resets, as a clock time; "unknown" without one. */
export function resetText(resetsAt: number | null, now: number): string {
  return resetsAt === null ? 'unknown' : clockTime(resetsAt, now);
}

/** The most workers the scheduler runs now: the lead's target, or AGFLOW_MAX_WORKERS without one. */
export function workerLimit(workers: ProjectLoad['workers']): number {
  return workers.target ?? workers.cap;
}

/** "2 running of 4, the lead's target (the cap is 6)", or "3 running of 4, the cap". */
export function workersText(workers: ProjectLoad['workers']): string {
  if (workers.target === null) return `${workers.running} running of ${workers.cap}, the cap`;
  return `${workers.running} running of ${workers.target}, the lead's target (the cap is ${workers.cap})`;
}

/** "4 of 6 taken, 2 free". */
export function slotsText(slots: ProjectLoad['slots']): string {
  return `${slots.busy} of ${slots.capacity} taken, ${slots.idle} free`;
}

/** Tasks waiting in a queue: "2, the oldest for 12 min", or "none". */
export function queueText(queue: { count: number; oldestAgeMs: number | null }): string {
  if (queue.count === 0) return 'none';
  if (queue.oldestAgeMs === null) return String(queue.count);
  return `${queue.count}, the oldest for ${duration(queue.oldestAgeMs)}`;
}

/** The deadline and the time left: "18:00, 5 h 20 min left", "18:00, passed 10 min ago", or "none set". */
export function deadlineText(deadline: ProjectLoad['deadline'], now: number): string {
  if (deadline.at === null || deadline.leftMs === null) return 'none set';
  const at = clockTime(deadline.at, now);
  if (deadline.leftMs > 0) return `${at}, ${duration(deadline.leftMs)} left`;
  return `${at}, passed ${duration(-deadline.leftMs)} ago`;
}

/** What the strip shows: workers running of the limit, ready tasks (and how many can start now), free slots now. */
export function stripNumbers(load: HubLoad): { workers: string; ready: number; dispatchable: number; idle: number } {
  const { workers, tasks, slots } = load.project;
  return {
    workers: `${workers.running}/${workerLimit(workers)}`,
    ready: tasks.ready,
    dispatchable: tasks.dispatchable,
    idle: slots.idle,
  };
}
