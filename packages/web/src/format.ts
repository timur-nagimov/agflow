import {
  type Agent,
  type BlockedKind,
  type Evidence,
  type HubEvent,
  type Message,
  type MessageView,
  type NewTaskInput,
  type Task,
  type TaskKind,
  type TaskNote,
  type TaskStatus,
  canTransition,
  isClosed,
} from '@agflow/core';

// ---------------------------------------------------------------------------
// Task status and board columns
// ---------------------------------------------------------------------------

export type Tone = 'wait' | 'active' | 'review' | 'done' | 'trouble' | 'closed';

export const STATUS_LABELS: Record<TaskStatus, string> = {
  draft: 'Draft',
  ready: 'Ready',
  claimed: 'Claimed',
  working: 'Working',
  submitted: 'Submitted',
  checking: 'Checking',
  reviewing: 'Reviewing',
  accepted: 'Accepted',
  merging: 'Merging',
  merged: 'Merged',
  rejected: 'Rejected',
  stale: 'Stale',
  blocked: 'Blocked',
  cancelled: 'Cancelled',
  failed: 'Failed',
};

/** A task blocked only by unfinished dependencies is waiting, not in trouble. */
export function statusLabel(status: TaskStatus, blockedKind: BlockedKind | null = null): string {
  return status === 'blocked' && blockedKind === 'deps' ? 'Waiting' : STATUS_LABELS[status];
}

export function toneOf(status: TaskStatus, blockedKind: BlockedKind | null = null): Tone {
  switch (status) {
    case 'draft':
    case 'ready':
      return 'wait';
    case 'claimed':
    case 'working':
      return 'active';
    case 'submitted':
    case 'checking':
    case 'reviewing':
      return 'review';
    case 'accepted':
    case 'merging':
    case 'merged':
      return 'done';
    case 'blocked':
      return blockedKind === 'deps' ? 'wait' : 'trouble';
    case 'rejected':
    case 'stale':
    case 'failed':
      return 'trouble';
    case 'cancelled':
      return 'closed';
  }
}

export type ColumnKey = 'todo' | 'doing' | 'review' | 'attention' | 'done' | 'closed';

export const COLUMNS: { key: ColumnKey; label: string; tone: Tone; hint: string }[] = [
  { key: 'todo', label: 'To do', tone: 'wait', hint: 'Ready to claim, or waiting on other tasks.' },
  { key: 'doing', label: 'In progress', tone: 'active', hint: 'Claimed by an agent.' },
  { key: 'review', label: 'In review', tone: 'review', hint: 'Submitted and waiting for the lead or a person.' },
  { key: 'attention', label: 'Needs attention', tone: 'trouble', hint: 'Blocked by an agent, rejected or stale.' },
  { key: 'done', label: 'Done', tone: 'done', hint: 'Accepted or merged.' },
  { key: 'closed', label: 'Closed', tone: 'closed', hint: 'Cancelled or failed.' },
];

export function columnOf(task: Pick<Task, 'status' | 'blockedKind'>): ColumnKey {
  switch (task.status) {
    case 'draft':
    case 'ready':
      return 'todo';
    case 'blocked':
      return task.blockedKind === 'deps' ? 'todo' : 'attention';
    case 'claimed':
    case 'working':
      return 'doing';
    case 'submitted':
    case 'checking':
    case 'reviewing':
      return 'review';
    case 'rejected':
    case 'stale':
      return 'attention';
    case 'accepted':
    case 'merging':
    case 'merged':
      return 'done';
    case 'cancelled':
    case 'failed':
      return 'closed';
  }
}

const seqOf = (id: string): number => Number(id.slice(2));

/** Priority 0 is the most urgent; equal priorities keep creation order. */
export function byPriority(a: Task, b: Task): number {
  return a.priority - b.priority || seqOf(a.id) - seqOf(b.id);
}

/** Groups tasks into board columns. Finished columns show the most recent first. */
export function groupTasks(tasks: Task[]): Record<ColumnKey, Task[]> {
  const groups: Record<ColumnKey, Task[]> = { todo: [], doing: [], review: [], attention: [], done: [], closed: [] };
  for (const task of tasks) groups[columnOf(task)].push(task);
  for (const key of ['todo', 'doing', 'review', 'attention'] as const) groups[key].sort(byPriority);
  for (const key of ['done', 'closed'] as const) groups[key].sort((a, b) => b.updatedAt - a.updatedAt);
  return groups;
}

export function columnCounts(tasks: Task[]): Record<ColumnKey, number> {
  const counts: Record<ColumnKey, number> = { todo: 0, doing: 0, review: 0, attention: 0, done: 0, closed: 0 };
  for (const task of tasks) counts[columnOf(task)] += 1;
  return counts;
}

// ---------------------------------------------------------------------------
// People's task actions
// ---------------------------------------------------------------------------

export type TaskAction = 'accept' | 'reject' | 'merged' | 'unblock' | 'release' | 'cancel';

export interface ActionSpec {
  label: string;
  /** Path segment under /api/tasks/:id/. */
  path: string;
  /** Body field the text goes into. */
  field: 'note' | 'feedback' | 'reason' | 'sha';
  required: boolean;
  prompt: string;
  confirm: string;
  danger: boolean;
}

export const TASK_ACTIONS: Record<TaskAction, ActionSpec> = {
  accept: {
    label: 'Accept',
    path: 'accept',
    field: 'note',
    required: false,
    prompt: 'Note for the agent (optional)',
    confirm: 'Accept',
    danger: false,
  },
  reject: {
    label: 'Reject',
    path: 'reject',
    field: 'feedback',
    required: true,
    prompt: 'What has to change before it can be accepted?',
    confirm: 'Reject and send back',
    danger: true,
  },
  merged: {
    label: 'Mark merged',
    path: 'merged',
    field: 'sha',
    required: false,
    prompt: 'Merge commit SHA (optional)',
    confirm: 'Mark merged',
    danger: false,
  },
  unblock: {
    label: 'Unblock',
    path: 'unblock',
    field: 'note',
    required: false,
    prompt: 'What changed? (optional)',
    confirm: 'Unblock',
    danger: false,
  },
  release: {
    label: 'Release claim',
    path: 'release-claim',
    field: 'reason',
    required: true,
    prompt: 'Why take the task back? The agent is told to stop.',
    confirm: 'Release claim',
    danger: true,
  },
  cancel: {
    label: 'Cancel task',
    path: 'cancel',
    field: 'reason',
    required: true,
    prompt: 'Why cancel it? An agent holding it is told to stop.',
    confirm: 'Cancel task',
    danger: true,
  },
};

/** The actions a person can take on a task in its current status. */
export function actionsFor(task: Pick<Task, 'status'>): TaskAction[] {
  const actions: TaskAction[] = [];
  if (task.status === 'submitted') actions.push('accept', 'reject');
  if (task.status === 'accepted') actions.push('merged');
  if (task.status === 'blocked') actions.push('unblock');
  if (task.status === 'claimed' || task.status === 'working') actions.push('release');
  if (canTransition(task.status, 'cancelled')) actions.push('cancel');
  return actions;
}

/** One line telling a person what the actions are for in the task's current status. */
export function actionHint(task: Pick<Task, 'status' | 'assignee' | 'submission'>): string {
  switch (task.status) {
    case 'submitted':
      return `${task.submission?.by ?? 'The agent'} submitted this for review. Accept it, or reject it with feedback.`;
    case 'accepted':
      return 'Accepted. Merge its branch, then mark it merged.';
    case 'blocked':
      return 'Unblock it once the problem is solved, or cancel it.';
    case 'claimed':
    case 'working':
      return `${task.assignee ?? 'An agent'} is working on this. Release the claim only if the agent is stuck or gone.`;
    default:
      return '';
  }
}

/** The request body for an action, or null while a required text is missing. */
export function actionBody(action: TaskAction, text: string): Record<string, string> | null {
  const spec = TASK_ACTIONS[action];
  const value = text.trim();
  if (!value) return spec.required ? null : {};
  return { [spec.field]: value };
}
