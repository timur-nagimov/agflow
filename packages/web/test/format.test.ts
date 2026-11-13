import { describe, expect, test } from 'bun:test';
import {
  type Agent,
  type BlockedKind,
  HUB_EVENT_TYPES,
  type HubEvent,
  type HubEventCategory,
  type HubEventType,
  type LeadSeat,
  type MessageView,
  type Submission,
  type Task,
  type TaskNote,
  type TaskStatus,
} from '@agflow/core';
import {
  actionBody,
  actionHint,
  actionsFor,
  ago,
  BLOCKED_TITLES,
  categoryOf,
  COLUMNS,
  concernsAttempt,
  concernsTask,
  columnCounts,
  columnOf,
  deliveryLabel,
  describeEvent,
  draftReady,
  draftToTask,
  duration,
  EMPTY_DRAFT,
  EVENT_CATEGORIES,
  eventTone,
  groupTasks,
  inConversation,
  leadBanner,
  leadSeatSummary,
  mergeEvents,
  NOTE_LABELS,
  NOTE_TONES,
  percent,
  repoLink,
  shortSha,
  splitTaskMentions,
  STATUS_LABELS,
  statusLabel,
  targetLabel,
  targetOptions,
  threadTarget,
  type Tone,
  toneOf,
  untilText,
  VENDOR_NAMES,
  who,
} from '../src/format';

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'T-1',
    title: 'Parser',
    kind: 'code',
    objective: 'Parse input',
    why: '',
    nonGoals: [],
    acceptance: [{ id: 'A1', assertion: 'parses' }],
    checks: [],
    ownedPaths: [],
    dependsOn: [],
    priority: 5,
    status: 'ready',
    assignee: null,
    branch: null,
    goalVersion: 1,
    leaseExpiresAt: null,
    blockedKind: null,
    blockedReason: null,
    submission: null,
    feedback: null,
    mergedSha: null,
    createdBy: 'agent:A-1',
    createdAt: 0,
    updatedAt: 0,
    currentAttempt: null,
    attemptCount: 0,
    workRef: null,
    workSha: null,
    nextDispatchAt: null,
    ...overrides,
  };
}

function submission(overrides: Partial<Submission> = {}): Submission {
  return {
    summary: 's',
    evidence: [],
    branch: null,
    headSha: null,
    submittedAt: 0,
    by: 'A-4',
    attemptId: null,
    submissionId: null,
    ...overrides,
  };
}

const BLOCKED_KINDS: BlockedKind[] = ['deps', 'agent', 'impossible', 'takeover', 'replan', 'paused', 'branch_moved', 'policy'];

describe('blocked kinds', () => {
  test('every blocked kind has a label, a tone and a column', () => {
    const rows = BLOCKED_KINDS.map((kind) => {
      const blocked = task({ status: 'blocked', blockedKind: kind });
      return [kind, statusLabel('blocked', kind), toneOf('blocked', kind), columnOf(blocked)];
    });
    expect(rows).toEqual([
      ['deps', 'Waiting', 'wait', 'todo'],
      ['agent', 'Blocked', 'trouble', 'attention'],
      ['impossible', 'Blocked', 'trouble', 'attention'],
      ['takeover', 'Taken over', 'active', 'doing'],
      ['replan', 'Re-plan', 'trouble', 'attention'],
      ['paused', 'Paused', 'trouble', 'attention'],
      ['branch_moved', 'Branch moved', 'trouble', 'attention'],
      ['policy', 'Refused', 'trouble', 'attention'],
    ]);
  });

  test('every blocked kind has an attention heading', () => {
    expect(Object.keys(BLOCKED_TITLES).sort()).toEqual([...BLOCKED_KINDS].sort());
    expect(BLOCKED_TITLES.deps).toBe('Waiting on other tasks');
    expect(BLOCKED_TITLES.impossible).toBe('The agent says this cannot be done as written');
    expect(BLOCKED_TITLES.takeover).toBe('Taken over by a person');
    expect(BLOCKED_TITLES.paused).toBe('Stopped and held by a person');
    expect(BLOCKED_TITLES.replan).toBe('Its attempts kept failing: re-plan it');
    expect(BLOCKED_TITLES.branch_moved).toBe('The task branch moved outside agflow');
    expect(BLOCKED_TITLES.policy).toBe('The vendor refused this work on policy grounds');
  });

  test("the column hints mention people's take-overs and holds", () => {
    const hints = Object.fromEntries(COLUMNS.map((column) => [column.key, column.hint]));
    expect(hints.doing).toBe('Claimed by an agent, or taken over by a person.');
    expect(hints.attention).toBe('Blocked, paused, rejected or stale.');
  });
});

describe('board columns', () => {
  test('a task waiting on dependencies is still to do; one blocked by its agent needs attention', () => {
    expect(columnOf(task({ status: 'blocked', blockedKind: 'deps' }))).toBe('todo');
    expect(columnOf(task({ status: 'blocked', blockedKind: 'agent' }))).toBe('attention');
    expect(columnOf(task({ status: 'blocked', blockedKind: 'impossible' }))).toBe('attention');
    expect(statusLabel('blocked', 'deps')).toBe('Waiting');
    expect(statusLabel('blocked', 'agent')).toBe('Blocked');
  });

  test('every status lands in a column', () => {
    expect(columnOf(task({ status: 'working' }))).toBe('doing');
    expect(columnOf(task({ status: 'submitted' }))).toBe('review');
    expect(columnOf(task({ status: 'merged' }))).toBe('done');
    expect(columnOf(task({ status: 'cancelled' }))).toBe('closed');
  });

  test('open columns sort by priority (0 first), finished ones by recency', () => {
    const groups = groupTasks([
      task({ id: 'T-1', priority: 5 }),
      task({ id: 'T-2', priority: 0 }),
      task({ id: 'T-3', priority: 5 }),
      task({ id: 'T-4', status: 'accepted', updatedAt: 1 }),
      task({ id: 'T-5', status: 'merged', updatedAt: 2 }),
    ]);
    expect(groups.todo.map((t) => t.id)).toEqual(['T-2', 'T-1', 'T-3']);
    expect(groups.done.map((t) => t.id)).toEqual(['T-5', 'T-4']);
    expect(columnCounts([task(), task({ status: 'working' })])).toMatchObject({ todo: 1, doing: 1, done: 0 });
  });
});

describe('task actions', () => {
  test('people get the actions that fit the status', () => {
    expect(actionsFor(task({ status: 'submitted' }))).toEqual(['accept', 'reject', 'cancel']);
    expect(actionsFor(task({ status: 'accepted' }))).toEqual(['merged']);
    expect(actionsFor(task({ status: 'blocked' }))).toEqual(['unblock', 'cancel']);
    expect(actionsFor(task({ status: 'working' }))).toEqual(['release', 'cancel']);
    expect(actionsFor(task({ status: 'ready' }))).toEqual(['cancel']);
    expect(actionsFor(task({ status: 'merged' }))).toEqual([]);
  });

  test('a hint explains what the actions are for', () => {
    expect(actionHint(task({ status: 'working', assignee: 'A-2' }))).toBe(
      'A-2 is working on this. Release the claim only if the agent is stuck or gone.',
    );
    expect(actionHint(task({ status: 'accepted' }))).toBe('Accepted. Merge its branch, then mark it merged.');
    expect(actionHint(task({ status: 'ready' }))).toBe('');
    expect(actionHint(task({ status: 'submitted', submission: submission() }))).toBe(
      'A-4 submitted this for review. Accept it, or reject it with feedback.',
    );
    expect(actionHint(task({ status: 'blocked' }))).toBe('Unblock it once the problem is solved, or cancel it.');
  });

  test('a task held by a runner agent offers Stop instead of Release claim, which its agent row provides', () => {
    for (const status of ['claimed', 'working'] as const) {
      expect(actionsFor(task({ status }), 'runner')).toEqual(['cancel']);
      expect(actionsFor(task({ status }), 'live')).toEqual(['release', 'cancel']);
      expect(actionsFor(task({ status }), 'nobody')).toEqual(['release', 'cancel']);
      expect(actionsFor(task({ status }))).toEqual(['release', 'cancel']);
    }
    expect(actionsFor(task({ status: 'submitted' }), 'runner')).toEqual(['accept', 'reject', 'cancel']);
  });

  test('a taken-over task is handed back, never unblocked; the other blocked kinds can be unblocked', () => {
    expect(actionsFor(task({ status: 'blocked', blockedKind: 'takeover' }))).toEqual(['cancel']);
    for (const kind of ['paused', 'replan', 'branch_moved', 'policy', 'agent', 'impossible', 'deps'] as const) {
      expect([kind, actionsFor(task({ status: 'blocked', blockedKind: kind }))]).toEqual([kind, ['unblock', 'cancel']]);
    }
  });

  test('hints for runner-held, taken-over, paused, re-plan, branch-moved and refused tasks', () => {
    expect(actionHint(task({ status: 'working', assignee: 'A-9' }), 'runner')).toBe(
      'A-9 is working on this on a runner. Stop it only if it is stuck, or take it over to work on it yourself.',
    );
    expect(actionHint(task({ status: 'claimed', assignee: 'A-2' }), 'live')).toBe(
      'A-2 is working on this. Release the claim only if the agent is stuck or gone.',
    );
    const blocked = (kind: BlockedKind) => actionHint(task({ status: 'blocked', blockedKind: kind }));
    expect(blocked('takeover')).toBe('A person has taken this over. Hand it back when the work is ready, or cancel it.');
    expect(blocked('paused')).toBe('A person stopped and held this. Unblock it to let an agent go on from its last work, or cancel it.');
    expect(blocked('replan')).toBe('Its attempts kept failing. Split, clarify or amend it, then unblock it; or cancel it.');
    expect(blocked('branch_moved')).toBe(
      'Its branch moved outside agflow. Unblock it to go on from the new head, or cancel it.',
    );
    expect(blocked('policy')).toBe('The vendor refused this work. Change the task before you unblock it, or cancel it.');
    expect(blocked('agent')).toBe('Unblock it once the problem is solved, or cancel it.');
  });

  test('bodies carry the text in the right field, and required text is enforced', () => {
    expect(actionBody('reject', '  Add tests. ')).toEqual({ feedback: 'Add tests.' });
    expect(actionBody('reject', '   ')).toBeNull();
    expect(actionBody('accept', '')).toEqual({});
    expect(actionBody('merged', 'abc1234')).toEqual({ sha: 'abc1234' });
    expect(actionBody('merged', ' ABC1234 ')).toEqual({ sha: 'abc1234' });
    expect(actionBody('release', 'went home')).toEqual({ reason: 'went home' });
  });
});

describe('the thread on a task', () => {
  test('a message goes to the agent that holds the task', () => {
    for (const status of ['claimed', 'working'] as const) {
      expect(threadTarget(task({ status, assignee: 'A-2' }))).toEqual({
        to: 'task:T-1',
        placeholder: 'Write to A-2, who holds this task…',
      });
    }
  });

  test('on a task nobody holds yet it waits for the next agent to claim the task', () => {
    for (const status of ['draft', 'ready', 'blocked'] as const) {
      const target = threadTarget(task({ status }));
      expect(target.to).toBe('task:T-1');
      expect(target).not.toHaveProperty('taskId');
      expect(target.placeholder).toBe('Nobody holds this task; the next agent to claim it gets your message…');
    }
  });

  test('on a taken-over task it waits for the next agent, since the person works outside agflow', () => {
    expect(threadTarget(task({ status: 'blocked', blockedKind: 'takeover', assignee: 'A-9' }))).toEqual({
      to: 'task:T-1',
      placeholder: 'A person has taken this task over; the next agent to work on it gets your message…',
    });
  });

  test('once the work is handed in or the task is closed, a message goes to the lead and stays in the thread', () => {
    // After submitting, the task keeps its assignee, but the agent no longer reads the task's thread.
    expect(threadTarget(task({ status: 'submitted', assignee: 'A-2' }))).toEqual({
      to: 'lead',
      taskId: 'T-1',
      placeholder: 'Nobody is working on this task. Your message goes to the lead, who reviews the task…',
    });
  });

  test('only the statuses an agent reads the thread in use the thread', () => {
    const own: TaskStatus[] = ['draft', 'ready', 'claimed', 'working', 'blocked'];
    for (const status of Object.keys(STATUS_LABELS) as TaskStatus[]) {
      const target = threadTarget(task({ status, assignee: 'A-2' }));
      expect([status, target.to]).toEqual([status, own.includes(status) ? 'task:T-1' : 'lead']);
    }
  });
});

function event(type: string, data: Record<string, unknown> = {}, actor = 'agent:A-2', subject: string | null = 'T-3'): HubEvent {
  return { id: 1, ts: 0, type, actor, subject, data };
}

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'A-2',
    user: 'bob',
    vendor: 'codex',
    role: 'worker',
    origin: 'live',
    sessionId: 's',
    label: null,
    currentTask: null,
    status: 'active',
    lastSeenAt: 0,
    createdAt: 0,
    runnerId: null,
    attemptId: null,
    ...overrides,
  };
}

describe('people, agents and targets', () => {
  test('actors and targets read naturally', () => {
    expect(who('user:alice')).toBe('alice');
    expect(who('agent:A-3')).toBe('A-3');
    expect(who('system')).toBe('agflow');
    expect(targetLabel('lead')).toBe('the lead');
    expect(targetLabel('all')).toBe('everyone');
    expect(targetLabel('humans')).toBe('people');
    expect(targetLabel('agent:A-3')).toBe('A-3');
    expect(targetLabel('task:T-9')).toBe('T-9 thread');
  });

  test('target options list connected agents and open task threads', () => {
    const options = targetOptions(
      [agent(), agent({ id: 'A-5', status: 'gone' })],
      [task({ id: 'T-1' }), task({ id: 'T-2', status: 'merged' })],
      null,
    );
    expect(options.map((option) => option.value)).toEqual(['lead', 'all', 'humans', 'agent:A-2', 'task:T-1']);
    expect(targetOptions([], [], null, 'agent:A-5').at(-1)).toEqual({ value: 'agent:A-5', label: 'A-5' });
  });

  test('target options name the seat holder as the lead, not agents with the lead role (X-45)', () => {
    const agents = [agent({ id: 'A-1', role: 'lead', label: 'lead chat' }), agent({ id: 'A-7', origin: 'runner' })];
    const labels = (leadId: string | null) =>
      targetOptions(agents, [], leadId)
        .filter((option) => option.value.startsWith('agent:'))
        .map((option) => option.label);
    expect(labels('A-7')).toEqual(['A-1 · bob · lead chat', 'A-7 · bob · lead']);
    expect(labels(null)).toEqual(['A-1 · bob · lead chat', 'A-7 · bob']);
  });

  test('a conversation includes messages both ways', () => {
    const base = { id: 1, body: 'x', taskId: null, replyTo: null, standingRule: false, ruleActive: false, createdAt: 0 };
    const toAgent = { ...base, from: 'user:alice', to: 'agent:A-2' };
    const fromAgent = { ...base, from: 'agent:A-2', to: 'humans' };
    const fromLead = { ...base, from: 'agent:A-1', to: 'humans' };
    const aboutTask = { ...base, from: 'user:alice', to: 'lead', taskId: 'T-4' };
    expect(inConversation(toAgent, 'agent:A-2', null)).toBe(true);
    expect(inConversation(fromAgent, 'agent:A-2', null)).toBe(true);
    expect(inConversation(fromLead, 'agent:A-2', null)).toBe(false);
    expect(inConversation(fromLead, 'lead', 'A-1')).toBe(true);
    expect(inConversation(aboutTask, 'task:T-4', null)).toBe(true);
    expect(inConversation(fromLead, 'everything', null)).toBe(true);
    // The lead is whoever holds the seat: a former lead's messages leave the lead conversation with the seat.
    expect(inConversation(fromLead, 'lead', 'A-7')).toBe(false);
    expect(inConversation(fromLead, 'lead', null)).toBe(false);
  });

  test('delivery state is summarised', () => {
    const message: MessageView = {
      id: 1,
      from: 'user:alice',
      to: 'agent:A-2',
      body: 'x',
      taskId: null,
      replyTo: null,
      standingRule: false,
      ruleActive: false,
      createdAt: 0,
      deliveries: [],
    };
    expect(deliveryLabel(message)).toBe('Not delivered yet');
    expect(deliveryLabel({ ...message, deliveries: [{ agentId: 'A-2', deliveredAt: 1, ackedAt: null }] })).toBe('Delivered to A-2');
    expect(deliveryLabel({ ...message, deliveries: [{ agentId: 'A-2', deliveredAt: 1, ackedAt: 2 }] })).toBe('Read by A-2');
    expect(
      deliveryLabel({
        ...message,
        to: 'all',
        deliveries: [
          { agentId: 'A-2', deliveredAt: 1, ackedAt: 2 },
          { agentId: 'A-3', deliveredAt: 1, ackedAt: null },
        ],
      }),
    ).toBe('Read by A-2 · delivered to A-3');
    expect(deliveryLabel({ ...message, to: 'humans' })).toBe('');
  });
});

describe('the lead seat', () => {
  const empty: LeadSeat = {
    kind: 'none',
    agentId: null,
    attemptId: null,
    runnerId: null,
    since: null,
    wakeups: 0,
    runnerLeads: true,
  };
  const onRunner: LeadSeat = {
    kind: 'runner',
    agentId: 'A-9',
    attemptId: 'lead-a2',
    runnerId: 'R-1',
    since: 1_000,
    wakeups: 3,
    runnerLeads: true,
  };
  const live: LeadSeat = { ...empty, kind: 'live', agentId: 'A-1', since: 1_000 };

  test('a live seat names the chat and its person', () => {
    expect(leadSeatSummary(live, agent({ id: 'A-1', user: 'alice', role: 'lead', label: 'lead chat' }))).toBe(
      "A-1 in alice's live chat “lead chat”",
    );
    expect(leadSeatSummary(live, agent({ id: 'A-1', user: 'bob', role: 'lead' }))).toBe("A-1 in bob's live chat");
    // Before the agents have loaded, the chat is named by its agent alone.
    expect(leadSeatSummary(live, null)).toBe('A-1 in a live chat');
  });

  test('a runner seat names the agent, the runner and the wake-ups since its last rotation', () => {
    expect(leadSeatSummary(onRunner, null)).toBe('A-9 on R-1, 3 wake-ups since its last rotation');
    expect(leadSeatSummary({ ...onRunner, wakeups: 1 }, null)).toBe('A-9 on R-1, 1 wake-up since its last rotation');
    expect(leadSeatSummary({ ...onRunner, wakeups: 0 }, null)).toBe('A-9 on R-1, no wake-ups since its last rotation');
  });

  test('an empty seat says so', () => {
    expect(leadSeatSummary(empty, null)).toBe('Nobody holds the lead seat');
    expect(leadSeatSummary({ ...empty, runnerLeads: false }, null)).toBe('Nobody holds the lead seat');
  });

  test('the no-lead banner shows only while the seat is empty', () => {
    expect(leadBanner(onRunner, false)).toBeNull();
    expect(leadBanner(live, false)).toBeNull();
    expect(leadBanner({ ...live, runnerLeads: false }, false)).toBeNull();
    expect(leadBanner(onRunner, true)).toBeNull();
  });

  test('with runner leads on, the banner says a runner starts a lead once one has a free slot', () => {
    const banner = leadBanner(empty, false);
    expect(banner?.command).toBeNull();
    expect(`${banner?.title} ${banner?.text}`).toBe(
      'No lead right now. Runner leads are on, so a runner starts one as soon as it has a free slot.',
    );
  });

  test('while the project is paused, the banner says no runner starts a lead until it is resumed', () => {
    // A paused project skips the lead seat (design 6.6), so the free-slot promise would be wrong.
    const banner = leadBanner(empty, true);
    expect(banner?.command).toBeNull();
    expect(`${banner?.title} ${banner?.text}`).toBe(
      'No lead right now. The project is paused, so no runner starts a lead until it is resumed.',
    );
  });

  test('with runner leads off, the banner gives the agflow join --role lead instructions', () => {
    const banner = leadBanner({ ...empty, runnerLeads: false }, false);
    // A live chat may join a paused project too, so pausing does not change these instructions.
    expect(leadBanner({ ...empty, runnerLeads: false }, true)).toEqual(banner);
    expect(banner?.title).toBe('No lead is connected.');
    expect(banner?.text).toBe(
      "Runner leads are off, so a live chat leads: in the project's repository, start a new Claude Code or Codex chat " +
        'after running',
    );
    expect(banner?.command).toBe('agflow join --role lead');
  });
});

describe('events', () => {
  test('events read as sentences', () => {
    expect(describeEvent(event('task.created', { title: 'Parser' }, 'user:alice'))).toBe('alice created T-3 “Parser”');
    expect(describeEvent(event('task.submitted', { branch: 'agflow/T-3-parser' }))).toBe(
      'A-2 submitted T-3 for review on agflow/T-3-parser',
    );
    expect(describeEvent(event('task.released', { forced: true, holder: 'A-2', reason: 'went home' }, 'user:bob'))).toBe(
      'bob took T-3 back from A-2: went home',
    );
    expect(describeEvent(event('task.blocked', { from: 'ready' }, 'system'))).toBe('T-3 is waiting on other tasks');
    expect(describeEvent(event('task.unblocked', { note: 'Reject refunds below 1.00 EUR.' }, 'user:alice'))).toBe(
      'alice unblocked T-3: Reject refunds below 1.00 EUR.',
    );
    expect(describeEvent(event('task.unblocked', { note: null }, 'user:alice'))).toBe('alice unblocked T-3');
    expect(describeEvent(event('task.unblocked', {}, 'user:alice'))).toBe('alice unblocked T-3');
    expect(describeEvent(event('goal.updated', { version: 4 }, 'user:alice', null))).toBe('alice changed the goal to v4');
    expect(describeEvent(event('message.sent', { to: 'lead', standingRule: true }, 'user:alice', null))).toBe(
      'alice wrote to the lead (standing rule)',
    );
    expect(describeEvent(event('message.delivered', { ids: [1, 2] }, 'agent:A-2', null))).toBe('A-2 received 2 messages');
    expect(describeEvent(event('something.new', {}, 'system', null))).toBe('agflow: something.new');
  });

  test('categories and merging', () => {
    expect(categoryOf('task.claimed')).toBe('tasks');
    expect(categoryOf('rule.removed')).toBe('messages');
    expect(categoryOf('guard.tripped')).toBe('project');
    const a = { ...event('a'), id: 1 };
    const b = { ...event('b'), id: 2 };
    expect(mergeEvents([b], [a, b]).map((e) => e.id)).toEqual([2, 1]);
  });
});

describe('notes and shared words', () => {
  test('every note kind has a label and a tone', () => {
    const kinds: TaskNote['kind'][] = ['progress', 'handoff', 'release', 'restatement', 'late_work'];
    expect(Object.keys(NOTE_LABELS).sort()).toEqual([...kinds].sort());
    expect(Object.keys(NOTE_TONES).sort()).toEqual([...kinds].sort());
    expect(NOTE_LABELS.restatement).toBe('Restatement');
    expect(NOTE_LABELS.late_work).toBe('Late work');
    expect(NOTE_TONES).toEqual({
      progress: 'active',
      handoff: 'wait',
      release: 'closed',
      restatement: 'review',
      late_work: 'trouble',
    });
  });

  test('vendor names, percents, short shas and times to come', () => {
    expect(VENDOR_NAMES).toEqual({ claude: 'Claude Code', codex: 'Codex' });
    expect(percent(0.423)).toBe('42%');
    expect(percent(1)).toBe('100%');
    expect(percent(0)).toBe('0%');
    expect(shortSha('0123456789abcdef0123456789abcdef01234567')).toBe('0123456');
    const now = 1_000_000_000;
    expect(untilText(now + 12 * 60_000, now)).toBe('in 12 min');
    expect(untilText(now + 90 * 60_000, now)).toBe('in 1 h 30 min');
    expect(untilText(now + 20_000, now)).toBe('in under a minute');
    expect(untilText(now, now)).toBe('now');
    expect(untilText(now - 60_000, now)).toBe('now');
  });
});

const SHA = '0123456789abcdef0123456789abcdef01234567';

/** Data for every M2 event type, with each key HUB_EVENT_TYPES records for it and nothing else. */
const M2_EVENTS: Record<HubEventType, { data: Record<string, unknown>; subject: string | null; actor: string }> = (() => {
  const ofAttempt = { attemptId: 'T-8-a1', taskId: 'T-8', agentId: 'A-9', runnerId: 'R-1' };
  const ofApproval = { approvalId: '0b7c4a52-1a1e-4c0e-9b8f-1d2e3f4a5b6c', ...ofAttempt, summary: 'npm install' };
  const ofSubmission = { submissionId: 'S-2', ...ofAttempt };
  const quota = { state: 'ok', resetsAt: null, windows: { fiveHour: 0.42, weekly: 0.1 }, paidUsage: 'disabled', updatedAt: 0 };
  const task = (data: Record<string, unknown>, actor = 'system') => ({ data, subject: 'T-8', actor });
  const runner = (data: Record<string, unknown>, actor = 'system') => ({ data, subject: 'R-1', actor });
  const none = (data: Record<string, unknown>, actor = 'system') => ({ data, subject: null, actor });
  return {
    'runner.online': runner({ runnerId: 'R-1', name: 'MacBook Pro' }),
    'runner.offline': runner({ runnerId: 'R-1', name: 'MacBook Pro', state: 'offline' }),
    'runner.updated': runner({ runnerId: 'R-1', name: 'MacBook Pro', fields: ['capacity', 'draining'] }, 'user:alice'),
    'runner.retired': runner({ runnerId: 'R-1', name: 'MacBook Pro' }, 'user:alice'),
    'runner.event_rejected': runner({ runnerId: 'R-1', seq: 41, type: 'attempt.wip', error: 'stale fence' }),
    'account.quota_changed': { data: { vendor: 'codex', accountId: 'a1b2c3d4e5f60718', quota }, subject: 'alice', actor: 'system' },
    'account.owner_away': {
      data: { vendor: 'codex', accountId: 'a1b2c3d4e5f60718', approvalId: ofApproval.approvalId },
      subject: 'alice',
      actor: 'system',
    },
    'attempt.started': task({ ...ofAttempt, vendor: 'codex', role: 'worker' }),
    'attempt.running': task({ ...ofAttempt }),
    'attempt.quota_wait': task({ ...ofAttempt, resetsAt: 7_200_000 }),
    'attempt.holding': task({ ...ofAttempt, submissionId: 'S-2' }),
    'attempt.resumed': task({ ...ofAttempt, fence: { epoch: 1, counter: 4 }, reason: 'review feedback' }),
    'attempt.ended': task({ ...ofAttempt, endReason: 'stalled', failureClass: 'agent' }),
    'attempt.wip': task({ ...ofAttempt, ref: 'refs/agflow/T-8/a1', sha: SHA, stripped: [], skipped: [], embedded: [], logStat: '' }),
    'attempt.violation': task({ ...ofAttempt, phase: 'wip', paths: ['.github/workflows/ci.yml'] }),
    'attempt.late_work': task({ ...ofAttempt, ref: 'refs/agflow/T-8/late-a1', sha: SHA }),
    'attempt.prepared': task({ ...ofAttempt, requestId: 'C-7', ok: true, error: null }),
    'agent.stalled': task({ ...ofAttempt, cause: 'stall_silent', reason: 'no events for 20 min' }),
    'agent.stopped': task({ ...ofAttempt, cause: 'stop', reason: 'wrong approach' }, 'user:alice'),
    'agent.replaced': task({ ...ofAttempt, cause: 'replace', reason: 'looping' }, 'user:alice'),
    'approval.requested': task({ ...ofApproval, kind: 'command' }),
    'approval.decided': task({ ...ofApproval, decision: 'approve' }, 'user:alice'),
    'approval.expired': task({ ...ofApproval }),
    'approval.voided': task({ ...ofApproval }),
    'lead.seat_changed': none({ kind: 'runner', agentId: 'A-5', attemptId: 'lead-a5', runnerId: 'R-1' }),
    'lead.rotated': none({ attemptId: 'lead-a5', agentId: 'A-5', runnerId: 'R-1', reason: 'wake-ups' }),
    'submission.pending': task({ ...ofSubmission }),
    'submission.recorded': task({ ...ofSubmission, headSha: SHA, branch: 'agflow/T-8-parser' }),
    'submission.failed': task({ ...ofSubmission, error: 'needs_merge' }),
    'task.taken_over': task({ ...ofAttempt, person: 'alice', ref: 'refs/agflow/T-8/takeover-alice' }, 'user:alice'),
    'task.handed_back': task({ ...ofAttempt, source: 'ref', ref: 'refs/agflow/T-8/takeover-alice', sha: SHA }, 'user:alice'),
    'task.refs_deleted': task({ taskId: 'T-8', runnerId: 'R-1', refs: ['refs/agflow/T-8/a1', 'refs/agflow/T-8/a2'] }),
    'guard.plan_change': none({ agentId: 'A-5', call: 'update_task', taskIds: ['T-3', 'T-4'], count: 12 }, 'agent:A-5'),
    'guard.dispatch_paused': none({ agentId: 'A-5', until: 1_800_000, count: 20 }),
    'system.recovery_started': none({ gapMs: 3 * 3_600_000, until: 60_000 }),
    'system.recovery_ended': none({}),
    'system.restored': none({ epoch: 2 }),
  };
})();

function m2Event(type: HubEventType, data: Record<string, unknown> = {}): HubEvent {
  const sample = M2_EVENTS[type];
  return { id: 1, ts: 0, type, actor: sample.actor, subject: sample.subject, data: { ...sample.data, ...data } };
}

describe('M2 events', () => {
  test('the samples carry exactly the data keys HUB_EVENT_TYPES records', () => {
    expect(Object.keys(M2_EVENTS).sort()).toEqual(Object.keys(HUB_EVENT_TYPES).sort());
    for (const [type, spec] of Object.entries(HUB_EVENT_TYPES)) {
      expect([type, Object.keys(M2_EVENTS[type as HubEventType].data).sort()]).toEqual([type, [...spec.data].sort()]);
    }
  });

  test('every type reads as a sentence that uses only the data keys recorded for it', () => {
    for (const [type, spec] of Object.entries(HUB_EVENT_TYPES)) {
      const event = m2Event(type as HubEventType);
      const read = new Set<string>();
      const data = new Proxy(event.data, {
        get(target, key, receiver) {
          if (typeof key === 'string') read.add(key);
          return Reflect.get(target, key, receiver);
        },
      });
      const sentence = describeEvent({ ...event, data });
      const allowed = [...spec.data, ...('optionalData' in spec ? spec.optionalData : [])] as readonly string[];
      expect([type, [...read].filter((key) => !allowed.includes(key))]).toEqual([type, []]);
      expect([type, sentence.includes(type) || /undefined|null|NaN|\[object/.test(sentence)]).toEqual([type, false]);
    }
  });

  test('runner and account events', () => {
    expect(describeEvent(m2Event('runner.online'))).toBe('R-1 came online');
    expect(describeEvent(m2Event('runner.offline'))).toBe('R-1 went offline');
    expect(describeEvent(m2Event('runner.offline', { state: 'needs_login' }))).toBe(
      'R-1 went offline: its login no longer verifies, so it needs agflow login',
    );
    expect(describeEvent(m2Event('runner.updated'))).toBe("alice changed R-1's settings (capacity, draining)");
    expect(describeEvent(m2Event('runner.retired'))).toBe('alice retired R-1');
    expect(describeEvent(m2Event('runner.event_rejected'))).toBe('The hub refused attempt.wip #41 from R-1: stale fence');
    expect(describeEvent(m2Event('account.quota_changed'))).toBe("alice's Codex quota: 42% of the 5-hour window, 10% of the week");
    const exhausted = { state: 'exhausted', resetsAt: 3_600_000, windows: { fiveHour: 1, weekly: null }, paidUsage: 'disabled', updatedAt: 0 };
    expect(describeEvent(m2Event('account.quota_changed', { quota: exhausted }))).toBe(
      "alice's Codex quota ran out; it resets 1 h later",
    );
    expect(describeEvent(m2Event('account.quota_changed', { quota: { ...exhausted, resetsAt: null } }))).toBe(
      "alice's Codex quota ran out",
    );
    expect(describeEvent(m2Event('account.quota_changed', { quota: { ...exhausted, state: 'unknown' } }))).toBe(
      "alice's Codex quota is unknown",
    );
    expect(describeEvent(m2Event('account.owner_away'))).toBe(
      'alice seems away: an approval timed out, so their Codex account takes no new work until they act',
    );
  });

  test('attempt and agent events name the attempt', () => {
    expect(describeEvent(m2Event('attempt.started'))).toBe('T-8-a1 started: A-9, a Codex worker on R-1');
    expect(describeEvent(m2Event('attempt.started', { runnerId: null, vendor: 'claude' }))).toBe(
      'T-8-a1 started: A-9, a Claude Code worker in a live chat',
    );
    expect(describeEvent(m2Event('attempt.running'))).toBe('T-8-a1 is running');
    expect(describeEvent(m2Event('attempt.quota_wait'))).toBe('T-8-a1 is waiting for quota; it resets 2 h later');
    expect(describeEvent(m2Event('attempt.quota_wait', { resetsAt: null }))).toBe('T-8-a1 is waiting for quota');
    expect(describeEvent(m2Event('attempt.holding'))).toBe('T-8-a1 is holding while S-2 is reviewed');
    expect(describeEvent(m2Event('attempt.holding', { attemptId: 'lead-a5', taskId: null, submissionId: null }))).toBe(
      'lead-a5 is holding until its next message',
    );
    expect(describeEvent(m2Event('attempt.resumed'))).toBe('T-8-a1 resumed: review feedback');
    expect(describeEvent(m2Event('attempt.ended'))).toBe('T-8-a1 ended: stalled');
    expect(describeEvent(m2Event('attempt.ended', { endReason: 'failed_to_start', failureClass: 'infra' }))).toBe(
      'T-8-a1 ended: failed to start',
    );
    expect(describeEvent(m2Event('attempt.wip'))).toBe('T-8-a1 pushed work in progress at 0123456');
    expect(describeEvent(m2Event('attempt.wip', { stripped: ['.github/workflows/ci.yml', '.claude/settings.json'] }))).toBe(
      'T-8-a1 pushed work in progress at 0123456, without 2 protected paths',
    );
    expect(describeEvent(m2Event('attempt.violation'))).toBe(
      'T-8-a1 changed protected paths (wip): .github/workflows/ci.yml',
    );
    expect(describeEvent(m2Event('attempt.late_work'))).toBe('T-8-a1 pushed late work at 0123456');
    expect(describeEvent(m2Event('attempt.prepared'))).toBe('Dependencies are ready for T-8-a1');
    expect(describeEvent(m2Event('attempt.prepared', { ok: false, error: 'lockfile changed' }))).toBe(
      'Preparing dependencies for T-8-a1 failed: lockfile changed',
    );
    expect(describeEvent(m2Event('agent.stalled'))).toBe('A-9 stalled on T-8-a1: no events for 20 min');
    expect(describeEvent(m2Event('agent.stopped'))).toBe('alice stopped A-9 on T-8-a1: wrong approach');
    expect(describeEvent(m2Event('agent.stopped', { cause: 'stop_hold' }))).toBe(
      'alice stopped and held A-9 on T-8-a1: wrong approach',
    );
    expect(describeEvent(m2Event('agent.replaced'))).toBe('alice replaced A-9 on T-8-a1: looping');
  });

  test('submitted-head late refs are neutral and explain that there is nothing new', () => {
    const event = m2Event('attempt.late_work', { submittedHead: true });
    expect(describeEvent(event)).toBe('T-8-a1 pushed its submitted head to refs/agflow/T-8/late-a1 (nothing new)');
    expect(eventTone(event.type, event.data)).toBe('wait');
    const ordinary = m2Event('attempt.late_work');
    expect(describeEvent(ordinary)).toBe('T-8-a1 pushed late work at 0123456');
    expect(eventTone(ordinary.type, ordinary.data)).toBe('trouble');
  });

  test('approval, lead, submission, task, guard and hub events', () => {
    expect(describeEvent(m2Event('approval.requested'))).toBe('A-9 asked for approval on T-8-a1: npm install');
    expect(describeEvent(m2Event('approval.decided'))).toBe("alice approved A-9's request: npm install");
    expect(describeEvent(m2Event('approval.decided', { decision: 'decline' }))).toBe("alice declined A-9's request: npm install");
    expect(describeEvent(m2Event('approval.expired'))).toBe("A-9's request expired unanswered and was declined: npm install");
    expect(describeEvent(m2Event('approval.voided'))).toBe("A-9's request no longer applies: npm install");
    expect(describeEvent(m2Event('lead.seat_changed'))).toBe('A-5 took the lead seat on R-1');
    expect(describeEvent(m2Event('lead.seat_changed', { kind: 'live', attemptId: 'T-1-a1', runnerId: null }))).toBe(
      'A-5 took the lead seat in a live chat',
    );
    expect(describeEvent(m2Event('lead.seat_changed', { kind: 'none', agentId: null, attemptId: null, runnerId: null }))).toBe(
      'The lead seat is empty',
    );
    expect(describeEvent(m2Event('lead.rotated'))).toBe('The lead A-5 rotated out: wake-ups');
    expect(describeEvent(m2Event('submission.pending'))).toBe('T-8-a1 is submitting S-2');
    expect(describeEvent(m2Event('submission.recorded'))).toBe('T-8-a1 submitted S-2 at 0123456 on agflow/T-8-parser');
    expect(describeEvent(m2Event('submission.failed'))).toBe('S-2 from T-8-a1 failed: needs_merge');
    expect(describeEvent(m2Event('task.taken_over'))).toBe('alice took T-8 over from T-8-a1');
    expect(describeEvent(m2Event('task.handed_back'))).toBe('alice handed T-8 back from refs/agflow/T-8/takeover-alice at 0123456');
    expect(describeEvent(m2Event('task.handed_back', { source: 'clone', ref: null, sha: null }))).toBe(
      "alice handed T-8 back from the runner's clone",
    );
    expect(describeEvent(m2Event('task.refs_deleted'))).toBe('R-1 deleted 2 refs of T-8');
    expect(describeEvent(m2Event('guard.plan_change'))).toBe('A-5 called update_task on T-3, T-4: 12 plan changes in the last hour');
    expect(describeEvent(m2Event('guard.dispatch_paused'))).toBe(
      'Worker dispatch paused for 30 min after 20 plan changes in an hour by A-5',
    );
    expect(describeEvent(m2Event('system.recovery_started'))).toBe('The hub was down for 3 h; it recovers before it starts new work');
    expect(describeEvent(m2Event('system.recovery_ended'))).toBe('The hub finished recovering');
    expect(describeEvent(m2Event('system.restored'))).toBe('The hub was restored from a backup (epoch 2)');
  });

  test("a hand-back that falls back says the task is ready without the clone's work, and why", () => {
    // The hub's fallback (X-49) moves the task with task.ready, not task.handed_back, and only it gives a reason.
    const fallback = (reason: string, actor: string) =>
      describeEvent(event('task.ready', { from: 'blocked', attemptId: 'T-8-a1', reason }, actor, 'T-8'));
    expect(fallback('runner R-2 is offline; its clone comes as late work', 'user:alice')).toBe(
      "T-8 is ready again without the clone's work: runner R-2 is offline; its clone comes as late work",
    );
    expect(fallback('nothing came back from the clone within 600 s', 'system')).toBe(
      "T-8 is ready again without the clone's work: nothing came back from the clone within 600 s",
    );
    expect(describeEvent(event('task.ready', { from: 'stale' }, 'system', 'T-8'))).toBe('T-8 is ready');
    expect(eventTone('task.ready', { reason: 'x' })).toBe('wait');
  });

  test('M1 types keep their sentences, and unknown types fall back', () => {
    expect(describeEvent(event('task.claimed'))).toBe('A-2 claimed T-3');
    expect(describeEvent(event('agent.lead_changed', {}, 'system', 'A-1'))).toBe('A-1 is now the lead');
    expect(describeEvent(event('attempt.unheard_of', {}, 'system', 'T-3'))).toBe('agflow: attempt.unheard_of T-3');
  });

  test('tones', () => {
    const tone = (type: HubEventType, data: Record<string, unknown> = {}) => eventTone(type, m2Event(type, data).data);
    for (const type of ['attempt.violation', 'agent.stalled', 'submission.failed', 'approval.expired'] as const) {
      expect([type, tone(type)]).toEqual([type, 'trouble']);
    }
    for (const type of ['account.owner_away', 'runner.event_rejected', 'guard.dispatch_paused'] as const) {
      expect([type, tone(type)]).toEqual([type, 'trouble']);
    }
    for (const endReason of ['crashed', 'lost', 'stalled']) {
      expect([endReason, tone('attempt.ended', { endReason })]).toEqual([endReason, 'trouble']);
    }
    // An infra failure to start is trouble; a refused start (X-3) has no failure class and only waits.
    expect(tone('attempt.ended', { endReason: 'failed_to_start', failureClass: 'infra' })).toBe('trouble');
    expect(tone('attempt.ended', { endReason: 'failed_to_start', failureClass: null })).toBe('wait');
    expect(tone('attempt.ended', { endReason: 'accepted' })).toBe('done');
    expect(tone('attempt.ended', { endReason: 'replaced' })).toBe('closed');
    expect(tone('submission.recorded')).toBe('review');
    expect(tone('task.handed_back')).toBe('done');
    expect(tone('system.recovery_ended')).toBe('done');
    for (const type of ['attempt.started', 'attempt.running', 'attempt.wip', 'attempt.resumed'] as const) {
      expect([type, tone(type)]).toEqual([type, 'active']);
    }
    expect(tone('attempt.prepared', { ok: false })).toBe('trouble');
    expect(tone('approval.decided', { decision: 'decline' })).toBe('closed');
    expect(eventTone('task.accepted')).toBe('done');
    expect(eventTone('something.new')).toBe('wait');
  });

  test('every type has its tone, so a dropped or misspelt case fails', () => {
    const TONES: Record<HubEventType, Tone> = {
      'runner.online': 'active',
      'runner.offline': 'wait',
      'runner.updated': 'wait',
      'runner.retired': 'closed',
      'runner.event_rejected': 'trouble',
      'account.quota_changed': 'wait',
      'account.owner_away': 'trouble',
      'attempt.started': 'active',
      'attempt.running': 'active',
      'attempt.quota_wait': 'wait',
      'attempt.holding': 'review',
      'attempt.resumed': 'active',
      'attempt.ended': 'trouble',
      'attempt.wip': 'active',
      'attempt.violation': 'trouble',
      'attempt.late_work': 'trouble',
      'attempt.prepared': 'active',
      'agent.stalled': 'trouble',
      'agent.stopped': 'closed',
      'agent.replaced': 'wait',
      'approval.requested': 'review',
      'approval.decided': 'done',
      'approval.expired': 'trouble',
      'approval.voided': 'closed',
      'lead.seat_changed': 'active',
      'lead.rotated': 'wait',
      'submission.pending': 'active',
      'submission.recorded': 'review',
      'submission.failed': 'trouble',
      'task.taken_over': 'active',
      'task.handed_back': 'done',
      'task.refs_deleted': 'closed',
      'guard.plan_change': 'wait',
      'guard.dispatch_paused': 'trouble',
      'system.recovery_started': 'wait',
      'system.recovery_ended': 'done',
      'system.restored': 'wait',
    };
    for (const type of Object.keys(HUB_EVENT_TYPES) as HubEventType[]) {
      expect([type, eventTone(type, m2Event(type).data)]).toEqual([type, TONES[type]]);
    }
    const tone = (type: HubEventType, data: Record<string, unknown>) => eventTone(type, m2Event(type, data).data);
    const quota = M2_EVENTS['account.quota_changed'].data.quota as Record<string, unknown>;
    expect(tone('account.quota_changed', { quota: { ...quota, state: 'exhausted' } })).toBe('trouble');
    expect(tone('account.quota_changed', { quota: { ...quota, state: 'ok' } })).toBe('wait');
    expect(tone('lead.seat_changed', { kind: 'none', agentId: null, attemptId: null, runnerId: null })).toBe('wait');
    expect(tone('lead.seat_changed', { kind: 'runner' })).toBe('active');
    expect(tone('approval.decided', { decision: 'approve' })).toBe('done');
    expect(tone('approval.decided', { decision: 'decline' })).toBe('closed');
  });

  test("categories follow the event's group", () => {
    const expected: Record<HubEventCategory, string> = {
      runners: 'runners',
      accounts: 'runners',
      attempts: 'attempts',
      submissions: 'attempts',
      approvals: 'attempts',
      lead: 'agents',
      agents: 'agents',
      guards: 'project',
      hub: 'project',
      tasks: 'tasks',
    };
    for (const [type, spec] of Object.entries(HUB_EVENT_TYPES)) {
      expect([type, categoryOf(type)]).toEqual([type, expected[spec.category]]);
    }
    expect(EVENT_CATEGORIES.map((category) => category.label)).toEqual([
      'Goal',
      'Tasks',
      'Attempts',
      'Runners',
      'Messages',
      'Agents',
      'Project',
    ]);
  });

  test('pages reload on events about their task or attempt', () => {
    expect(concernsTask(m2Event('attempt.started'), 'T-8')).toBe(true);
    expect(concernsTask(event('task.claimed', {}, 'agent:A-2', 'T-8'), 'T-8')).toBe(true);
    expect(concernsTask(m2Event('task.refs_deleted'), 'T-8')).toBe(true);
    expect(concernsTask({ ...m2Event('attempt.started'), subject: null }, 'T-8')).toBe(true);
    expect(concernsTask(m2Event('attempt.started'), 'T-80')).toBe(false);
    expect(concernsTask(m2Event('runner.online'), 'T-8')).toBe(false);
    expect(concernsAttempt(m2Event('attempt.ended'), 'T-8-a1')).toBe(true);
    expect(concernsAttempt(m2Event('attempt.ended'), 'T-8-a2')).toBe(false);
    expect(concernsAttempt(event('task.claimed', {}, 'agent:A-2', 'T-8'), 'T-8-a1')).toBe(false);
    const lead = { ...m2Event('attempt.holding', { attemptId: 'lead-a5', taskId: null, submissionId: null }), subject: 'lead-a5' };
    expect(concernsAttempt(lead, 'lead-a5')).toBe(true);
    expect(concernsAttempt({ ...lead, data: {} }, 'lead-a5')).toBe(true);
  });
});

describe('time', () => {
  test('relative times and durations', () => {
    const now = 10 * 24 * 3_600_000;
    expect(ago(now - 10_000, now)).toBe('just now');
    expect(ago(now - 50_000, now)).toBe('1 min ago');
    expect(ago(now - 59 * 60_000, now)).toBe('59 min ago');
    expect(ago(now - 3 * 3_600_000, now)).toBe('3 h ago');
    expect(ago(now - 2 * 24 * 3_600_000, now)).toBe('2 d ago');
    expect(duration(80 * 60_000)).toBe('1 h 20 min');
    expect(duration(2 * 3_600_000)).toBe('2 h');
    expect(duration(28 * 3_600_000)).toBe('1 d 4 h');
  });
});

describe('links and the new-task form', () => {
  test('task ids in text are found, but not inside branch names', () => {
    expect(splitTaskMentions('Blocked by T-4 and T-12.')).toEqual(['Blocked by ', 'T-4', ' and ', 'T-12', '.']);
    expect(splitTaskMentions('pushed agflow/T-3-eu-vat')).toEqual(['pushed agflow/T-3-eu-vat']);
    expect(splitTaskMentions('T-3: done')).toEqual(['', 'T-3', ': done']);
  });

  test('links into GitHub and GitLab repositories only', () => {
    expect(repoLink('https://github.com/acme/demo.git', 'branch', 'agflow/T-1-x')).toBe(
      'https://github.com/acme/demo/tree/agflow/T-1-x',
    );
    expect(repoLink('https://gitlab.com/acme/demo', 'commit', 'abc1234')).toBe('https://gitlab.com/acme/demo/-/commit/abc1234');
    expect(repoLink('https://github.com/acme/demo.git/', 'branch', 'main')).toBe('https://github.com/acme/demo/tree/main');
    expect(repoLink('git@github.com:acme/demo.git', 'branch', 'main')).toBeNull();
    expect(repoLink('https://example.com/acme/demo', 'branch', 'main')).toBeNull();
  });

  test('a draft becomes a task input', () => {
    expect(draftReady(EMPTY_DRAFT)).toBe(false);
    const draft = {
      ...EMPTY_DRAFT,
      title: ' Token refresh ',
      objective: 'Refresh expired tokens',
      acceptance: '- Expired tokens refresh\n\n* Failures are typed',
      ownedPaths: 'src/auth/**\n',
      dependsOn: 't-1, T-2',
      priority: 1,
    };
    expect(draftReady(draft)).toBe(true);
    expect(draftToTask(draft)).toEqual({
      title: 'Token refresh',
      objective: 'Refresh expired tokens',
      why: '',
      kind: 'code',
      priority: 1,
      acceptance: [
        { id: 'A1', assertion: 'Expired tokens refresh' },
        { id: 'A2', assertion: 'Failures are typed' },
      ],
      ownedPaths: ['src/auth/**'],
      dependsOn: ['T-1', 'T-2'],
    });
  });
});
