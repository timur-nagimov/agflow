import {
  type Agent,
  type BlockedKind,
  type Evidence,
  type HubEvent,
  type HubEventType,
  type LeadSeat,
  type Message,
  type MessageView,
  type NewTaskInput,
  type Task,
  type TaskKind,
  type TaskNote,
  type TaskStatus,
  type Vendor,
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

/** What a blocked task reads as on its chip; an agent's block and an impossible task both read Blocked. */
export const BLOCKED_LABELS: Record<BlockedKind, string> = {
  deps: 'Waiting',
  agent: 'Blocked',
  impossible: 'Blocked',
  takeover: 'Taken over',
  replan: 'Re-plan',
  paused: 'Paused',
  branch_moved: 'Branch moved',
  policy: 'Refused',
};

/** The heading of a blocked task's attention card. */
export const BLOCKED_TITLES: Record<BlockedKind, string> = {
  deps: 'Waiting on other tasks',
  agent: 'Blocked',
  impossible: 'The agent says this cannot be done as written',
  takeover: 'Taken over by a person',
  replan: 'Its attempts kept failing: re-plan it',
  paused: 'Stopped and held by a person',
  branch_moved: 'The task branch moved outside agflow',
  policy: 'The vendor refused this work on policy grounds',
};

export function statusLabel(status: TaskStatus, blockedKind: BlockedKind | null = null): string {
  return status === 'blocked' && blockedKind ? BLOCKED_LABELS[blockedKind] : STATUS_LABELS[status];
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
      // A task waiting only on dependencies is not in trouble, and a taken-over one is being worked on by a person.
      return blockedKind === 'deps' ? 'wait' : blockedKind === 'takeover' ? 'active' : 'trouble';
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
  { key: 'doing', label: 'In progress', tone: 'active', hint: 'Claimed by an agent, or taken over by a person.' },
  { key: 'review', label: 'In review', tone: 'review', hint: 'Submitted and waiting for the lead or a person.' },
  { key: 'attention', label: 'Needs attention', tone: 'trouble', hint: 'Blocked, paused, rejected or stale.' },
  { key: 'done', label: 'Done', tone: 'done', hint: 'Accepted or merged.' },
  { key: 'closed', label: 'Closed', tone: 'closed', hint: 'Cancelled or failed.' },
];

export function columnOf(task: Pick<Task, 'status' | 'blockedKind'>): ColumnKey {
  switch (task.status) {
    case 'draft':
    case 'ready':
      return 'todo';
    case 'blocked':
      return task.blockedKind === 'deps' ? 'todo' : task.blockedKind === 'takeover' ? 'doing' : 'attention';
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

/** Who works on a task: a runner agent, a live chat, or nobody. */
export type TaskHolder = 'runner' | 'live' | 'nobody';

/**
 * The actions a person can take on a task in its current status. On a task a runner agent holds, Release claim
 * becomes the agent's Stop (design 11), which the runner actions offer; a taken-over task is handed back instead of
 * unblocked (6.12). Without a holder the M1 actions apply.
 */
export function actionsFor(task: Pick<Task, 'status' | 'blockedKind'>, holder?: TaskHolder): TaskAction[] {
  const actions: TaskAction[] = [];
  if (task.status === 'submitted') actions.push('accept', 'reject');
  if (task.status === 'accepted') actions.push('merged');
  if (task.status === 'blocked' && task.blockedKind !== 'takeover') actions.push('unblock');
  if ((task.status === 'claimed' || task.status === 'working') && holder !== 'runner') actions.push('release');
  if (canTransition(task.status, 'cancelled')) actions.push('cancel');
  return actions;
}

const BLOCKED_HINTS: Partial<Record<BlockedKind, string>> = {
  takeover: 'A person has taken this over. Hand it back when the work is ready, or cancel it.',
  paused: 'A person stopped and held this. Unblock it to let an agent go on from its last work, or cancel it.',
  replan: 'Its attempts kept failing. Split, clarify or amend it, then unblock it; or cancel it.',
  branch_moved: 'Its branch moved outside agflow. Unblock it to go on from the new head, or cancel it.',
  policy: 'The vendor refused this work. Change the task before you unblock it, or cancel it.',
};

/** One line telling a person what the actions are for in the task's current status. */
export function actionHint(
  task: Pick<Task, 'status' | 'blockedKind' | 'assignee' | 'submission'>,
  holder?: TaskHolder,
): string {
  switch (task.status) {
    case 'submitted':
      return `${task.submission?.by ?? 'The agent'} submitted this for review. Accept it, or reject it with feedback.`;
    case 'accepted':
      return 'Accepted. Merge its branch, then mark it merged.';
    case 'blocked':
      return (
        (task.blockedKind && BLOCKED_HINTS[task.blockedKind]) ?? 'Unblock it once the problem is solved, or cancel it.'
      );
    case 'claimed':
    case 'working':
      return holder === 'runner'
        ? `${task.assignee ?? 'A runner agent'} is working on this on a runner. Stop it only if it is stuck, or take it over to work on it yourself.`
        : `${task.assignee ?? 'An agent'} is working on this. Release the claim only if the agent is stuck or gone.`;
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
export function threadTarget(task: Pick<Task, 'id' | 'status' | 'blockedKind' | 'assignee'>): ThreadTarget {
  if (isHeld(task.status)) {
    return { to: `task:${task.id}`, placeholder: `Write to ${task.assignee ?? 'the agent'}, who holds this task…` };
  }
  // The person who took the task over works outside agflow and reads no thread; the agent after the hand-back does.
  if (task.status === 'blocked' && task.blockedKind === 'takeover') {
    return {
      to: `task:${task.id}`,
      placeholder: 'A person has taken this task over; the next agent to work on it gets your message…',
    };
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

/**
 * Who a person can write to: the lead, everyone, people, connected agents and open task threads. The agent holding
 * the lead seat (`leadId`, HubStatus.leadSeat) is marked as the lead; an agent's lead role says nothing since M2 (X-45).
 */
export function targetOptions(agents: Agent[], tasks: Task[], leadId: string | null, current?: string): TargetOption[] {
  const options: TargetOption[] = [
    { value: 'lead', label: 'The lead' },
    { value: 'all', label: 'Everyone' },
    { value: 'humans', label: 'People' },
    ...agents
      .filter((agent) => agent.status !== 'gone')
      .map((agent) => ({
        value: `agent:${agent.id}`,
        label: `${agent.id} · ${agent.user}${agent.id === leadId ? ' · lead' : ''}${agent.label ? ` · ${agent.label}` : ''}`,
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

/** True when a message belongs to the conversation with a target; the lead's are those of the seat holder (`leadId`). */
export function inConversation(message: Message, target: string, leadId: string | null): boolean {
  if (target === 'everything' || message.to === target) return true;
  if (target === 'lead') return leadId !== null && message.from === `agent:${leadId}`;
  if (target.startsWith('agent:')) return message.from === target;
  if (target.startsWith('task:')) return message.taskId === target.slice(5);
  return false;
}

// ---------------------------------------------------------------------------
// The lead seat (design 6.11, 11)
// ---------------------------------------------------------------------------

/**
 * Who holds the lead seat, in one line: a live chat with its person (from the seat holder's agent, once loaded), or a
 * runner agent with its runner and the wake-ups since its last rotation.
 */
export function leadSeatSummary(seat: LeadSeat, holder: Pick<Agent, 'id' | 'user' | 'label'> | null): string {
  if (seat.kind === 'none' || seat.agentId === null) return 'Nobody holds the lead seat';
  if (seat.kind === 'live') {
    if (holder?.id !== seat.agentId) return `${seat.agentId} in a live chat`;
    return `${seat.agentId} in ${holder.user}'s live chat${holder.label ? ` “${holder.label}”` : ''}`;
  }
  const wakeups = seat.wakeups === 0 ? 'no wake-ups' : `${seat.wakeups} wake-up${seat.wakeups === 1 ? '' : 's'}`;
  return `${seat.agentId} on ${seat.runnerId ?? 'a runner'}, ${wakeups} since its last rotation`;
}

export interface LeadBanner {
  title: string;
  text: string;
  /** The command that ends the text, which a person runs to lead from a chat. */
  command: string | null;
}

/**
 * The shell's banner while the lead seat is empty, or null while it is held. With runner leads on, the scheduler
 * seats a lead on the next runner with a free slot, except while the project is paused, when it skips the lead seat
 * (design 6.6); with them off, only a person's live chat can take the seat.
 */
export function leadBanner(seat: LeadSeat, paused: boolean): LeadBanner | null {
  if (seat.kind !== 'none') return null;
  if (seat.runnerLeads) {
    return {
      title: 'No lead right now.',
      text: paused
        ? 'The project is paused, so no runner starts a lead until it is resumed.'
        : 'Runner leads are on, so a runner starts one as soon as it has a free slot.',
      command: null,
    };
  }
  return {
    title: 'No lead is connected.',
    text:
      "Runner leads are off, so a live chat leads: in the project's repository, start a new Claude Code or Codex chat " +
      'after running',
    command: 'agflow join --role lead',
  };
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
const list = (value: unknown): string => (Array.isArray(value) ? value.map(String).join(', ') : '');
/** Codes such as failed_to_start, in words. */
const words = (value: unknown): string => text(value).replaceAll('_', ' ');
const sha7 = (value: unknown): string => shortSha(text(value));
const vendorName = (value: unknown): string => (value === 'claude' || value === 'codex' ? VENDOR_NAMES[value] : text(value));
/** How long after the event a time in its data is ('2 h'), or '' without one. */
const later = (event: HubEvent, value: unknown): string =>
  typeof value === 'number' && value > event.ts ? duration(value - event.ts) : '';

function quotaSentence(owner: string, vendor: string, quota: unknown, event: HubEvent): string {
  const q = (quota ?? {}) as { state?: unknown; resetsAt?: unknown; windows?: { fiveHour?: unknown; weekly?: unknown } };
  const of = `${owner}'s ${vendor} quota`;
  if (q.state === 'exhausted') {
    const reset = later(event, q.resetsAt);
    return reset ? `${of} ran out; it resets ${reset} later` : `${of} ran out`;
  }
  const windows = [
    typeof q.windows?.fiveHour === 'number' ? `${percent(q.windows.fiveHour)} of the 5-hour window` : '',
    typeof q.windows?.weekly === 'number' ? `${percent(q.windows.weekly)} of the week` : '',
  ].filter(Boolean);
  return q.state === 'ok' && windows.length > 0 ? `${of}: ${windows.join(', ')}` : `${of} is unknown`;
}

type Sentence = (d: Record<string, unknown>, by: string, on: string, event: HubEvent) => string;

/**
 * The sentences of the event types M2 adds (design 6.17), keyed by core's HubEventType, so a type core adds and this
 * table misses fails the typecheck. Each reads only the data keys core's HUB_EVENT_TYPES records for its type, which
 * the unit test checks. Attempt events name the attempt from data.attemptId; their subject is the task (or, for a
 * lead attempt, the attempt itself).
 */
const M2_SENTENCES: Record<HubEventType, Sentence> = {
  'runner.online': (d, _by, on) => `${text(d.runnerId) || on} came online`,
  'runner.offline': (d, _by, on) =>
    d.state === 'needs_login'
      ? `${text(d.runnerId) || on} went offline: its login no longer verifies, so it needs agflow login`
      : `${text(d.runnerId) || on} went offline`,
  'runner.updated': (d, by, on) =>
    `${by} changed ${text(d.runnerId) || on}'s settings${Array.isArray(d.fields) ? ` (${list(d.fields)})` : ''}`,
  'runner.retired': (d, by, on) => `${by} retired ${text(d.runnerId) || on}`,
  'runner.event_rejected': (d, _by, on) =>
    `The hub refused ${text(d.type)} #${String(d.seq)} from ${text(d.runnerId) || on}: ${text(d.error)}`,
  'account.quota_changed': (d, _by, on, event) => quotaSentence(on, vendorName(d.vendor), d.quota, event),
  'account.owner_away': (d, _by, on) =>
    `${on} seems away: an approval timed out, so their ${vendorName(d.vendor)} account takes no new work until they act`,
  'attempt.started': (d) =>
    `${text(d.attemptId)} started: ${text(d.agentId)}, a ${vendorName(d.vendor)} ${text(d.role)}${
      d.runnerId ? ` on ${text(d.runnerId)}` : ' in a live chat'
    }`,
  'attempt.running': (d) => `${text(d.attemptId)} is running`,
  'attempt.quota_wait': (d, _by, _on, event) => {
    const reset = later(event, d.resetsAt);
    return `${text(d.attemptId)} is waiting for quota${reset ? `; it resets ${reset} later` : ''}`;
  },
  // A task attempt holds while its submission is reviewed; a lead's holds once its process exits, until a delivery.
  'attempt.holding': (d) =>
    d.submissionId
      ? `${text(d.attemptId)} is holding while ${text(d.submissionId)} is reviewed`
      : `${text(d.attemptId)} is holding until its next message`,
  'attempt.resumed': (d) => `${text(d.attemptId)} resumed${d.reason ? `: ${text(d.reason)}` : ''}`,
  'attempt.ended': (d) => `${text(d.attemptId)} ended: ${words(d.endReason)}`,
  'attempt.wip': (d) =>
    `${text(d.attemptId)} pushed work in progress at ${sha7(d.sha)}${
      Array.isArray(d.stripped) && d.stripped.length > 0 ? `, without ${count(d.stripped, 'protected path')}` : ''
    }`,
  'attempt.violation': (d) => `${text(d.attemptId)} changed protected paths (${text(d.phase)}): ${list(d.paths)}`,
  'attempt.late_work': (d) =>
    d.submittedHead === true
      ? `${text(d.attemptId)} pushed its submitted head to ${text(d.ref)} (nothing new)`
      : `${text(d.attemptId)} pushed late work at ${sha7(d.sha)}`,
  'attempt.prepared': (d) =>
    d.ok
      ? `Dependencies are ready for ${text(d.attemptId)}`
      : `Preparing dependencies for ${text(d.attemptId)} failed: ${text(d.error)}`,
  'agent.stalled': (d) => `${text(d.agentId)} stalled on ${text(d.attemptId)}: ${text(d.reason)}`,
  'agent.stopped': (d, by) =>
    `${by} ${d.cause === 'stop_hold' ? 'stopped and held' : 'stopped'} ${text(d.agentId)} on ${text(d.attemptId)}: ${text(d.reason)}`,
  'agent.replaced': (d, by) => `${by} replaced ${text(d.agentId)} on ${text(d.attemptId)}: ${text(d.reason)}`,
  'approval.requested': (d) => `${text(d.agentId)} asked for approval on ${text(d.attemptId)}: ${text(d.summary)}`,
  'approval.decided': (d, by) =>
    `${by} ${d.decision === 'approve' ? 'approved' : 'declined'} ${text(d.agentId)}'s request: ${text(d.summary)}`,
  'approval.expired': (d) => `${text(d.agentId)}'s request expired unanswered and was declined: ${text(d.summary)}`,
  'approval.voided': (d) => `${text(d.agentId)}'s request no longer applies: ${text(d.summary)}`,
  'lead.seat_changed': (d) => {
    if (d.kind === 'none' || !d.agentId) return 'The lead seat is empty';
    return `${text(d.agentId)} took the lead seat ${d.kind === 'runner' ? `on ${text(d.runnerId)}` : 'in a live chat'}`;
  },
  'lead.rotated': (d) => `The lead ${text(d.agentId)} rotated out: ${text(d.reason)}`,
  'submission.pending': (d) => `${text(d.attemptId)} is submitting ${text(d.submissionId)}`,
  'submission.recorded': (d) =>
    `${text(d.attemptId)} submitted ${text(d.submissionId)} at ${sha7(d.headSha)}${d.branch ? ` on ${text(d.branch)}` : ''}`,
  'submission.failed': (d) => `${text(d.submissionId)} from ${text(d.attemptId)} failed: ${text(d.error)}`,
  'task.taken_over': (d, by, on) => `${who(text(d.person)) || by} took ${text(d.taskId) || on} over from ${text(d.attemptId)}`,
  'task.handed_back': (d, by, on) =>
    `${by} handed ${text(d.taskId) || on} back from ${d.source === 'clone' ? "the runner's clone" : text(d.ref)}${
      d.sha ? ` at ${sha7(d.sha)}` : ''
    }`,
  'task.refs_deleted': (d, _by, on) => `${text(d.runnerId)} deleted ${count(d.refs, 'ref')} of ${text(d.taskId) || on}`,
  'guard.plan_change': (d) =>
    `${text(d.agentId)} called ${text(d.call)} on ${list(d.taskIds)}: ${String(d.count)} plan changes in the last hour`,
  'guard.dispatch_paused': (d, _by, _on, event) => {
    const pause = later(event, d.until);
    return `Worker dispatch paused${pause ? ` for ${pause}` : ''} after ${String(d.count)} plan changes in an hour by ${text(d.agentId)}`;
  },
  'system.recovery_started': (d) =>
    `The hub was down for ${duration(typeof d.gapMs === 'number' ? d.gapMs : 0)}; it recovers before it starts new work`,
  'system.recovery_ended': () => 'The hub finished recovering',
  'system.restored': (d) => `The hub was restored from a backup (epoch ${String(d.epoch)})`,
};

const isM2Type = (type: string): type is HubEventType => Object.hasOwn(M2_SENTENCES, type);

/** One plain sentence per event, for the timeline and task histories. */
export function describeEvent(event: HubEvent): string {
  const by = who(event.actor);
  const on = event.subject ?? '';
  const d = event.data;
  if (isM2Type(event.type)) return M2_SENTENCES[event.type](d, by, on, event);
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
      // Only the hub's hand-back fallback gives a reason: the runner had no link, or the clone's push timed out (X-49).
      return d.reason ? `${on} is ready again without the clone's work: ${text(d.reason)}` : `${on} is ready`;
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
      return `${by} marked ${on} merged${d.sha ? ` at ${sha7(d.sha)}` : ''}`;
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

/** Attempt endings that went wrong; the others are a person's or the ladder's decision. */
const TROUBLED_ENDINGS = new Set(['crashed', 'lost', 'stalled']);

/** The tone of an attempt.ended event. A refused start (failed_to_start with no failure class, X-3) only waits. */
function endingTone(data: Record<string, unknown>): Tone {
  if (data.endReason === 'accepted') return 'done';
  if (data.endReason === 'failed_to_start') return data.failureClass === null ? 'wait' : 'trouble';
  return TROUBLED_ENDINGS.has(text(data.endReason)) ? 'trouble' : 'closed';
}

/** The tone of an event; a few M2 types take theirs from the data (an attempt's end reason, a quota's state). */
export function eventTone(type: string, data: Record<string, unknown> = {}): Tone {
  switch (type) {
    case 'attempt.ended':
      return endingTone(data);
    case 'attempt.prepared':
      return data.ok ? 'active' : 'trouble';
    case 'approval.decided':
      return data.decision === 'approve' ? 'done' : 'closed';
    case 'account.quota_changed':
      return (data.quota as { state?: unknown } | null)?.state === 'exhausted' ? 'trouble' : 'wait';
    case 'lead.seat_changed':
      return data.kind === 'none' ? 'wait' : 'active';
    case 'task.handed_back':
    case 'system.recovery_ended':
    case 'task.accepted':
    case 'task.merged':
    case 'project.resumed':
      return 'done';
    case 'attempt.late_work':
      return data.submittedHead === true ? 'wait' : 'trouble';
    case 'task.submitted':
    case 'goal.updated':
    case 'goal.note_added':
    case 'submission.recorded':
    case 'attempt.holding':
    case 'approval.requested':
      return 'review';
    case 'task.claimed':
    case 'task.working':
    case 'task.progress':
    case 'task.handoff_written':
    case 'task.claim_transferred':
    case 'task.returned':
    case 'runner.online':
    case 'attempt.started':
    case 'attempt.running':
    case 'attempt.resumed':
    case 'attempt.wip':
    case 'submission.pending':
    case 'task.taken_over':
      return 'active';
    case 'task.rejected':
    case 'task.blocked':
    case 'task.impossible':
    case 'task.stale':
    case 'guard.tripped':
    case 'project.paused':
    case 'runner.event_rejected':
    case 'account.owner_away':
    case 'attempt.violation':
    case 'agent.stalled':
    case 'approval.expired':
    case 'submission.failed':
    case 'guard.dispatch_paused':
      return 'trouble';
    case 'task.cancelled':
    case 'message.delivered':
    case 'message.acknowledged':
    case 'runner.retired':
    case 'agent.stopped':
    case 'approval.voided':
    case 'task.refs_deleted':
      return 'closed';
    default:
      return 'wait';
  }
}

export type EventCategory = 'goal' | 'tasks' | 'attempts' | 'runners' | 'messages' | 'agents' | 'project';

export const EVENT_CATEGORIES: { key: EventCategory; label: string }[] = [
  { key: 'goal', label: 'Goal' },
  { key: 'tasks', label: 'Tasks' },
  { key: 'attempts', label: 'Attempts' },
  { key: 'runners', label: 'Runners' },
  { key: 'messages', label: 'Messages' },
  { key: 'agents', label: 'Agents' },
  { key: 'project', label: 'Project' },
];

/** The timeline filter an event type belongs to, by its prefix; system and guard events are the project's. */
export function categoryOf(type: string): EventCategory {
  const prefix = type.slice(0, type.indexOf('.'));
  if (prefix === 'task') return 'tasks';
  if (prefix === 'goal') return 'goal';
  if (prefix === 'attempt' || prefix === 'submission' || prefix === 'approval') return 'attempts';
  if (prefix === 'runner' || prefix === 'account') return 'runners';
  if (prefix === 'message' || prefix === 'rule') return 'messages';
  if (prefix === 'agent' || prefix === 'lead') return 'agents';
  return 'project';
}

/** An event about a task: its subject is the task, or its data names it (the events of the task's attempts). */
export function concernsTask(event: Pick<HubEvent, 'subject' | 'data'>, taskId: string): boolean {
  return event.subject === taskId || event.data.taskId === taskId;
}

/** An event about an attempt: its data names it, or it is a lead attempt's event, whose subject is the attempt. */
export function concernsAttempt(event: Pick<HubEvent, 'subject' | 'data'>, attemptId: string): boolean {
  return event.data.attemptId === attemptId || event.subject === attemptId;
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

/** How long until a time to come: "in 12 min", or "now" once it has passed. */
export function untilText(ts: number, now: number): string {
  const left = ts - now;
  if (left <= 0) return 'now';
  return left < MINUTE ? 'in under a minute' : `in ${duration(left)}`;
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

/** Late work arrived after its attempt ended and needs a look; a restatement is for the reader to check. */
export const NOTE_TONES: Record<TaskNote['kind'], Tone> = {
  progress: 'active',
  handoff: 'wait',
  release: 'closed',
  restatement: 'review',
  late_work: 'trouble',
};

// ---------------------------------------------------------------------------
// Shared words
// ---------------------------------------------------------------------------

export const VENDOR_NAMES: Record<Vendor, string> = { claude: 'Claude Code', codex: 'Codex' };

/** A fraction 0..1 as a whole percent: 0.423 is "42%". */
export function percent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

/** The 7 characters of a commit sha that people recognise. */
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

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
