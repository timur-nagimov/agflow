import { describe, expect, test } from 'bun:test';
import type { Agent, BlockedKind, HubEvent, MessageView, Submission, Task, TaskNote, TaskStatus } from '@agflow/core';
import {
  actionBody,
  actionHint,
  actionsFor,
  ago,
  BLOCKED_TITLES,
  categoryOf,
  COLUMNS,
  columnCounts,
  columnOf,
  deliveryLabel,
  describeEvent,
  draftReady,
  draftToTask,
  duration,
  EMPTY_DRAFT,
  groupTasks,
  inConversation,
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
    );
    expect(options.map((option) => option.value)).toEqual(['lead', 'all', 'humans', 'agent:A-2', 'task:T-1']);
    expect(targetOptions([], [], 'agent:A-5').at(-1)).toEqual({ value: 'agent:A-5', label: 'A-5' });
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
