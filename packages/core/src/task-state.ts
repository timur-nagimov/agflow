import type { TaskStatus } from './types';

export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  draft: ['ready', 'blocked', 'cancelled'],
  ready: ['claimed', 'blocked', 'cancelled'],
  claimed: ['working', 'submitted', 'ready', 'stale', 'blocked', 'cancelled'],
  working: ['submitted', 'ready', 'stale', 'blocked', 'cancelled'],
  submitted: ['checking', 'accepted', 'rejected', 'cancelled'],
  checking: ['reviewing', 'rejected', 'cancelled'],
  reviewing: ['accepted', 'rejected', 'cancelled'],
  accepted: ['merging', 'merged'],
  merging: ['merged', 'rejected'],
  merged: [],
  rejected: ['ready', 'claimed', 'cancelled', 'failed'],
  stale: ['ready', 'cancelled'],
  blocked: ['ready', 'cancelled'],
  cancelled: [],
  failed: [],
};

export class TransitionError extends Error {
  constructor(
    readonly from: TaskStatus,
    readonly to: TaskStatus,
  ) {
    super(`a task cannot move from ${from} to ${to}`);
    this.name = 'TransitionError';
  }
}

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) throw new TransitionError(from, to);
}

/** An agent is actively holding the task. */
export function isHeld(status: TaskStatus): boolean {
  return status === 'claimed' || status === 'working';
}

/** The task satisfies dependencies. In M1 acceptance counts; M3 will require `merged`. */
export function isDone(status: TaskStatus): boolean {
  return status === 'accepted' || status === 'merging' || status === 'merged';
}

/** The task's contract can no longer change. */
export function isClosed(status: TaskStatus): boolean {
  return isDone(status) || status === 'cancelled' || status === 'failed';
}
