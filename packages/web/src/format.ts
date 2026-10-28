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
  isHeld,
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
  // Commit SHAs are lowercase hex; people often paste them in capitals.
  const value = spec.field === 'sha' ? text.trim().toLowerCase() : text.trim();
  if (!value) return spec.required ? null : {};
  return { [spec.field]: value };
}

/** Where a person's message in a task's thread goes, and what the box says about it. */
export interface ThreadTarget {
  to: string;
  /** Set when the message is not addressed to the task's own thread, so that it still shows there. */
  taskId?: string;
  placeholder: string;
}

/**
 * The hub hands a task-thread message to the agent that holds the task, or to the next agent that claims
 * it. Once the work is handed in, or the task is finished or closed, nobody reads the thread any more,
 * although `assignee` stays set. A message then goes to the lead, who reviews the task.
 */
export function threadTarget(task: Pick<Task, 'id' | 'status' | 'assignee'>): ThreadTarget {
  if (isHeld(task.status)) {
    return { to: `task:${task.id}`, placeholder: `Write to ${task.assignee ?? 'the agent'}, who holds this task…` };
  }
  if (task.status === 'draft' || task.status === 'ready' || task.status === 'blocked') {
    return { to: `task:${task.id}`, placeholder: 'Nobody holds this task; the next agent to claim it gets your message…' };
  }
  return {
    to: 'lead',
    taskId: task.id,
    placeholder: 'Nobody is working on this task. Your message goes to the lead, who reviews the task…',
  };
}

// ---------------------------------------------------------------------------
// People, agents and message targets
// ---------------------------------------------------------------------------

/** "user:alice" → "alice", "agent:A-3" → "A-3", "system" → "agflow". */
export function who(actor: string): string {
  if (actor === 'system') return 'agflow';
  const colon = actor.indexOf(':');
  return colon === -1 ? actor : actor.slice(colon + 1);
}

export type ActorKind = 'person' | 'agent' | 'system';

export function actorKind(actor: string): ActorKind {
  if (actor.startsWith('user:')) return 'person';
  if (actor.startsWith('agent:')) return 'agent';
  return 'system';
}

export function targetLabel(to: string): string {
  if (to === 'lead') return 'the lead';
  if (to === 'all') return 'everyone';
  if (to === 'humans') return 'people';
  if (to.startsWith('task:')) return `${to.slice(5)} thread`;
  return who(to);
}

export interface TargetOption {
  value: string;
  label: string;
}

/** Who a person can write to: the lead, everyone, people, connected agents and open task threads. */
export function targetOptions(agents: Agent[], tasks: Task[], current?: string): TargetOption[] {
  const options: TargetOption[] = [
    { value: 'lead', label: 'The lead' },
    { value: 'all', label: 'Everyone' },
    { value: 'humans', label: 'People' },
    ...agents
      .filter((agent) => agent.status !== 'gone')
      .map((agent) => ({
        value: `agent:${agent.id}`,
        label: `${agent.id} · ${agent.user}${agent.role === 'lead' ? ' · lead' : ''}${agent.label ? ` · ${agent.label}` : ''}`,
      })),
    ...tasks
      .filter((task) => !isClosed(task.status))
      .map((task) => ({ value: `task:${task.id}`, label: `${task.id} thread · ${clipText(task.title, 48)}` })),
  ];
  if (current && !options.some((option) => option.value === current)) {
    options.push({ value: current, label: targetLabel(current) });
  }
  return options;
}

/** True when a message belongs to the conversation with a target. */
export function inConversation(message: Message, target: string, leadId: string | null): boolean {
  if (target === 'everything' || message.to === target) return true;
  if (target === 'lead') return leadId !== null && message.from === `agent:${leadId}`;
  if (target.startsWith('agent:')) return message.from === target;
  if (target.startsWith('task:')) return message.taskId === target.slice(5);
  return false;
}

export function deliveryLabel(message: Message & Partial<Pick<MessageView, 'deliveries'>>): string {
  const deliveries = message.deliveries;
  if (!deliveries || message.to === 'humans') return '';
  if (deliveries.length === 0) return 'Not delivered yet';
  const read = deliveries.filter((delivery) => delivery.ackedAt !== null).map((delivery) => delivery.agentId);
  const unread = deliveries.filter((delivery) => delivery.ackedAt === null).map((delivery) => delivery.agentId);
  const parts = [read.length > 0 ? `read by ${read.join(', ')}` : '', unread.length > 0 ? `delivered to ${unread.join(', ')}` : ''];
  const text = parts.filter(Boolean).join(' · ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const count = (value: unknown, noun: string): string => {
  const n = Array.isArray(value) ? value.length : 0;
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
};

/** One plain sentence per event, for the timeline and task histories. */
export function describeEvent(event: HubEvent): string {
  const by = who(event.actor);
  const on = event.subject ?? '';
  const d = event.data;
  switch (event.type) {
    case 'task.created':
      return `${by} created ${on} “${text(d.title)}”`;
    case 'task.updated':
      return `${by} changed ${on}${Array.isArray(d.fields) ? ` (${d.fields.join(', ')})` : ''}`;
    case 'task.claimed':
      return `${by} claimed ${on}`;
    case 'task.working':
      return `${by} started work on ${on}`;
    case 'task.progress':
      return `${by} on ${on}: ${text(d.note)}`;
    case 'task.handoff_written':
      return `${by} left a handoff note on ${on}`;
    case 'task.released':
      return d.forced ? `${by} took ${on} back from ${text(d.holder)}: ${text(d.reason)}` : `${by} released ${on}: ${text(d.reason)}`;
    case 'task.claim_transferred':
      return `${by} took over ${on} from ${text(d.from)}`;
    case 'task.stale':
      return `${on} went stale: ${text(d.holder) || 'its agent'} stopped responding`;
    case 'task.ready':
      return `${on} is ready`;
    case 'task.blocked':
      return d.reason ? `${by} reported ${on} blocked: ${text(d.reason)}` : `${on} is waiting on other tasks`;
    case 'task.impossible':
      return `${by} says ${on} cannot be done as written: ${text(d.reason)}`;
    case 'task.unblocked':
      return `${by} unblocked ${on}${d.note ? `: ${text(d.note)}` : ''}`;
    case 'task.submitted':
      return `${by} submitted ${on} for review${d.branch ? ` on ${text(d.branch)}` : ''}`;
    case 'task.accepted':
      return `${by} accepted ${on}`;
    case 'task.rejected':
      return `${by} rejected ${on}: ${text(d.feedback)}`;
    case 'task.returned':
      return `${on} went back to ${text(d.to)} for another try`;
    case 'task.merged':
      return `${by} marked ${on} merged${d.sha ? ` at ${text(d.sha).slice(0, 7)}` : ''}`;
    case 'task.cancelled':
      return `${by} cancelled ${on}: ${text(d.reason)}`;
    case 'goal.updated':
      return `${by} changed the goal to v${String(d.version)}`;
    case 'goal.note_added':
      return `${by} added a note on the goal`;
    case 'message.sent':
      return `${by} wrote to ${targetLabel(text(d.to))}${d.standingRule ? ' (standing rule)' : ''}`;
    case 'message.delivered':
      return `${by} received ${count(d.ids, 'message')}`;
    case 'message.acknowledged':
      return `${by} acknowledged ${count(d.ids, 'message')}`;
    case 'rule.removed':
      return `${by} removed standing rule #${String(d.id)}`;
    case 'project.paused':
      return `${by} paused the project`;
    case 'project.resumed':
      return `${by} resumed the project`;
    case 'agent.session_started':
      return `${by} connected ${on}, a ${text(d.vendor)} ${text(d.role)}${d.label ? ` (${text(d.label)})` : ''}`;
    case 'agent.lead_changed':
      return `${on} is now the lead`;
    case 'guard.tripped':
      return `A safety limit stopped ${by}: ${text(d.reason)}`;
    default:
      return `${by}: ${event.type}${on ? ` ${on}` : ''}`;
  }
}

export function eventTone(type: string): Tone {
  switch (type) {
    case 'task.accepted':
    case 'task.merged':
    case 'project.resumed':
      return 'done';
    case 'task.submitted':
    case 'goal.updated':
    case 'goal.note_added':
      return 'review';
    case 'task.claimed':
    case 'task.working':
    case 'task.progress':
    case 'task.handoff_written':
    case 'task.claim_transferred':
    case 'task.returned':
      return 'active';
    case 'task.rejected':
    case 'task.blocked':
    case 'task.impossible':
    case 'task.stale':
    case 'guard.tripped':
    case 'project.paused':
      return 'trouble';
    case 'task.cancelled':
    case 'message.delivered':
    case 'message.acknowledged':
      return 'closed';
    default:
      return 'wait';
  }
}

export type EventCategory = 'goal' | 'tasks' | 'messages' | 'agents' | 'project';

export const EVENT_CATEGORIES: { key: EventCategory; label: string }[] = [
  { key: 'goal', label: 'Goal' },
  { key: 'tasks', label: 'Tasks' },
  { key: 'messages', label: 'Messages' },
  { key: 'agents', label: 'Agents' },
  { key: 'project', label: 'Project' },
];

export function categoryOf(type: string): EventCategory {
  const prefix = type.slice(0, type.indexOf('.'));
  if (prefix === 'task') return 'tasks';
  if (prefix === 'goal') return 'goal';
  if (prefix === 'message' || prefix === 'rule') return 'messages';
  if (prefix === 'agent') return 'agents';
  return 'project';
}

/** Merges live and loaded events without duplicates, newest first. */
export function mergeEvents(...lists: HubEvent[][]): HubEvent[] {
  const byId = new Map<number, HubEvent>();
  for (const list of lists) for (const event of list) byId.set(event.id, event);
  return [...byId.values()].sort((a, b) => b.id - a.id);
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function ago(ts: number, now: number): string {
  const elapsed = Math.max(0, now - ts);
  if (elapsed < 45_000) return 'just now';
  if (elapsed < HOUR) return `${Math.max(1, Math.floor(elapsed / MINUTE))} min ago`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)} h ago`;
  return `${Math.floor(elapsed / DAY)} d ago`;
}

/** A short duration such as "1 h 20 min" or "3 d 4 h". */
export function duration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / MINUTE));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days} d ${hours % 24} h` : `${days} d`;
}

// ---------------------------------------------------------------------------
// Task details
// ---------------------------------------------------------------------------

export const NOTE_LABELS: Record<TaskNote['kind'], string> = {
  progress: 'Progress',
  handoff: 'Handoff',
  release: 'Released',
  restatement: 'Restatement',
  late_work: 'Late work',
};

export function evidenceText(evidence: Evidence): string {
  switch (evidence.kind) {
    case 'command':
      return `run ${evidence.cmd ?? ''}${evidence.expect ? ` and expect ${evidence.expect}` : ''}`;
    case 'artifact':
      return `file ${evidence.path ?? ''}`;
    case 'review':
      return `review: ${evidence.rubric ?? ''}`;
  }
}

/** A link to a branch or commit when the project's repository is on GitHub or GitLab. */
export function repoLink(repo: string, kind: 'branch' | 'commit', ref: string): string | null {
  const base = repo.replace(/\/+$/, '').replace(/\.git$/, '');
  const host = base.match(/^https:\/\/(github\.com|gitlab\.com)\/[^/]+\/[^/]+$/)?.[1];
  if (!host) return null;
  const path = ref.split('/').map(encodeURIComponent).join('/');
  const section = kind === 'branch' ? 'tree' : 'commit';
  return host === 'gitlab.com' ? `${base}/-/${section}/${path}` : `${base}/${section}/${path}`;
}

/** Task ids such as T-12, but not inside names like agflow/T-12-login. */
const TASK_MENTION = /(?<![\w/.-])(T-\d+)(?![\w-])/;

/** Splits text around task ids; the ids are at the odd positions. */
export function splitTaskMentions(text: string): string[] {
  return text.split(TASK_MENTION);
}

export function clipText(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

// ---------------------------------------------------------------------------
// The new-task form
// ---------------------------------------------------------------------------

export const TASK_KINDS: TaskKind[] = ['code', 'research', 'review', 'curation'];
export const PRIORITIES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

export interface TaskDraft {
  title: string;
  objective: string;
  why: string;
  acceptance: string;
  kind: TaskKind;
  priority: number;
  ownedPaths: string;
  dependsOn: string;
}

export const EMPTY_DRAFT: TaskDraft = {
  title: '',
  objective: '',
  why: '',
  acceptance: '',
  kind: 'code',
  priority: 5,
  ownedPaths: '',
  dependsOn: '',
};

/** Non-empty lines, without list bullets. */
export function lines(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim().replace(/^[-*•]\s+/, ''))
    .filter(Boolean);
}

export function draftReady(draft: TaskDraft): boolean {
  return draft.title.trim() !== '' && draft.objective.trim() !== '' && lines(draft.acceptance).length > 0;
}

export function draftToTask(draft: TaskDraft): NewTaskInput {
  return {
    title: draft.title.trim(),
    objective: draft.objective.trim(),
    why: draft.why.trim(),
    kind: draft.kind,
    priority: draft.priority,
    acceptance: lines(draft.acceptance).map((assertion, index) => ({ id: `A${index + 1}`, assertion })),
    ownedPaths: lines(draft.ownedPaths),
    dependsOn: draft.dependsOn
      .split(/[\s,]+/)
      .map((id) => id.trim().toUpperCase())
      .filter(Boolean),
  };
}
