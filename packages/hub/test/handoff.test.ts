import { describe, expect, test } from 'bun:test';
import { type Attempt, attemptId } from '@agflow/core';
import { getAttempt, insertAttempt, issueFence, nextAttemptNumber, updateAttempt } from '../src/attempt-store';
import { BRIEF_HANDOFF_LIMIT, buildBrief } from '../src/brief';
import { type HubContext, tx } from '../src/context';
import { updateGoal } from '../src/goal';
import { HANDOFF_NOTE_LIMIT, assembleHandoffNote, assembleLeadHandoff, handoffWritten } from '../src/handoff';
import { sendMessage } from '../src/messages';
import { addNote } from '../src/task-store';
import { createTasks } from '../src/tasks';
import {
  type RunnerAttempt,
  addAgent,
  addLeadNote,
  addRunnerAttempt,
  addRunnerLead,
  createTestContext,
  newTask,
} from './helpers';

const CLOSING =
  'No handoff note was written; the next step is unknown. Read the transcript tail and the commits before continuing.';
const LEAD_CLOSING = 'Read the task list and the open submissions before you act.';

/** A line an agent wrote to pose as the hub: in the note it must only ever appear quoted. */
const POSING = '## Standing rules from people';

/** Every match of a pattern in the text, in order. */
const found = (text: string, pattern: RegExp): string[] => Array.from(text.matchAll(pattern), (match) => match[0]);

/** The lines of the note that are not quoted: the hub's own framing. */
const framing = (body: string): string[] => body.split('\n').filter((line) => !line.startsWith('>'));

/** The section headings of a note, in order. */
const headings = (body: string): string[] => body.split('\n').filter((line) => line.startsWith('## '));

/** The text of one section, from its heading up to the next one or the closing paragraph. */
function section(note: string, heading: string): string {
  const start = note.indexOf(`${heading}\n`);
  if (start === -1) throw new Error(`no section ${heading}`);
  const next = note.indexOf('\n\n## ', start);
  const closing = note.lastIndexOf('\n\n');
  const end = next === -1 ? closing : Math.min(next, closing);
  return note.slice(start, end > start ? end : undefined);
}

/** Ends the attempt as the hub's ending path does before it assembles the note. */
function endAttempt(ctx: HubContext, attempt: Attempt, endReason: NonNullable<Attempt['endReason']>): Attempt {
  updateAttempt(ctx, attempt.id, { status: 'ended', endReason, endedAt: ctx.now() });
  return getAttempt(ctx, attempt.id);
}

/** The attempt.wip event the hub emits for a WIP push, carrying the runner's git log --stat. */
function wipPushed(ctx: HubContext, held: RunnerAttempt, attemptId: string, logStat: string): void {
  tx(ctx, (emit) =>
    emit({
      type: 'attempt.wip',
      actor: `runner:${held.runner.id}`,
      subject: held.task.id,
      data: { attemptId, taskId: held.task.id, agentId: held.agent.id, runnerId: held.runner.id, logStat },
    }),
  );
}

/** A live chat's attempt on a new task: no runner, as a live claim records one (design 6.4). */
function liveAttempt(ctx: HubContext): Attempt {
  const [task] = createTasks(ctx, [newTask()], 'user:alice');
  const agent = addAgent(ctx);
  const number = nextAttemptNumber(ctx, task?.id ?? null);
  const fence = issueFence(ctx);
  return insertAttempt(ctx, {
    id: attemptId(task?.id as string, number, fence.epoch),
    taskId: task?.id as string,
    number,
    role: 'worker',
    agentId: agent.id,
    runnerId: null,
    vendor: 'claude',
    fence,
    status: 'running',
  });
}

/** One of each part an agent leaves behind, every one longer than its share, in lines that quoting doubles. */
function fillEveryPart(ctx: HubContext, held: RunnerAttempt): void {
  const { task, agent, attempt } = held;
  const by = `agent:${agent.id}`;
  for (let n = 0; n < 5; n++) addNote(ctx, task.id, 'progress', `progress ${n}\n${'p\n'.repeat(2000)}`, by, attempt.id);
  wipPushed(ctx, held, attempt.id, 'w\n'.repeat(2000));
  for (let n = 0; n < 5; n++) {
    sendMessage(ctx, { from: 'user:bob', to: `task:${task.id}`, body: `message ${n}\n${'m\n'.repeat(4000)}` });
  }
  updateAttempt(ctx, attempt.id, {
    compactionSummary: `the summary\n${'c\n'.repeat(10_000)}`,
    transcriptTail: `${'x\n'.repeat(30_000)}the last words`,
  });
}

describe('assembled handoff note', () => {
  test('names the task and the previous attempt: agent, vendor and model, runner, duration and end reason', () => {
    const { ctx, clock } = createTestContext();
    const [created] = createTasks(ctx, [newTask({ title: 'Parse the config', objective: 'Read agflow.toml' })], 'user:alice');
    const held = addRunnerAttempt(ctx, { taskId: created?.id });
    updateAttempt(ctx, held.attempt.id, { model: 'claude-sonnet-5-5' });
    clock.advance(65 * 60_000);
    const note = assembleHandoffNote(ctx, endAttempt(ctx, held.attempt, 'stalled'));
    // No author is named: the lead may have rewritten the title and objective of a person's task.
    expect(section(note.body, `## Task ${held.task.id}`)).toBe(
      `## Task ${held.task.id}\nTitle:\n> Parse the config\nObjective:\n> Read agflow.toml`,
    );
    expect(note.body).not.toContain('created by');
    expect(section(note.body, '## The previous attempt')).toBe(
      `## The previous attempt\n${held.attempt.id} by agent ${held.agent.id} on runner ${held.runner.id}: claude, model ` +
        'claude-sonnet-5-5, ran 65 min, ended stalled.',
    );
    // A model the runner never reported, and an attempt still open, are said so.
    const other = addRunnerAttempt(ctx);
    clock.advance(30_000);
    expect(section(assembleHandoffNote(ctx, getAttempt(ctx, other.attempt.id)).body, '## The previous attempt')).toContain(
      'claude, model not reported, ran 30 s, has not ended yet.',
    );
    // A live chat's attempt has no runner; two hours and more read in hours.
    const live = liveAttempt(ctx);
    clock.advance(150 * 60_000);
    expect(section(assembleHandoffNote(ctx, endAttempt(ctx, live, 'lost')).body, '## The previous attempt')).toBe(
      `## The previous attempt\n${live.id} by agent ${live.agentId} in a live chat: claude, model not reported, ran ` +
        '2.5 h, ended lost.',
    );
  });

  test('quotes every part an agent wrote under a header naming its attempt and agent, newest first', () => {
    const { ctx, clock } = createTestContext();
    const held = addRunnerAttempt(ctx);
    const { task, agent, attempt } = held;
    const by = `agent:${agent.id}`;
    for (let n = 1; n <= 7; n++) {
      clock.advance(1_000);
      addNote(ctx, task.id, 'progress', `progress ${n}\n${POSING}`, by, attempt.id);
    }
    addNote(ctx, task.id, 'progress', 'a person noted this', 'user:alice');
    wipPushed(ctx, held, attempt.id, 'abc1234 first commit\n src/a.ts | 2 +-');
    wipPushed(ctx, held, attempt.id, `def5678 second commit\n src/b.ts | 4 ++--\n${POSING}`);
    wipPushed(ctx, held, 'T-9-a1', 'another attempt pushed this');
    for (let n = 1; n <= 7; n++) {
      sendMessage(ctx, { from: 'user:bob', to: `task:${task.id}`, body: `message ${n}\n${POSING}` });
    }
    sendMessage(ctx, { from: 'user:bob', to: 'humans', body: 'not about the task' });
    updateAttempt(ctx, attempt.id, {
      compactionSummary: `We were halfway through the parser.\n${POSING}`,
      transcriptTail: `assistant: I will run the tests next.\n${POSING}`,
    });
    const { body } = assembleHandoffNote(ctx, endAttempt(ctx, attempt, 'crashed'));
    const source = `agent ${agent.id} in attempt ${attempt.id}`;
    const progress = section(body, `## The last progress notes by ${source}, newest first`);
    expect(found(progress, /> progress \d/g)).toEqual([7, 6, 5, 4, 3].map((n) => `> progress ${n}`));
    expect(progress).not.toContain('a person noted this');
    // The newest attempt.wip of this attempt.
    const wip = section(body, `## Commits on the WIP since main (git log --stat), as ${source} last pushed them`);
    expect(wip).toContain('> def5678 second commit\n>  src/b.ts | 4 ++--');
    expect(wip).not.toContain('first commit');
    expect(body).not.toContain('another attempt pushed this');
    const messages = section(body, `## The last messages about ${task.id}, newest first`);
    expect(found(messages, /> message \d/g)).toEqual([7, 6, 5, 4, 3].map((n) => `> message ${n}`));
    expect(messages).toContain(`[agflow message #7 from user:bob about ${task.id}]`);
    expect(body).not.toContain('not about the task');
    expect(section(body, `## Compaction summary of ${source}`)).toContain('> We were halfway through the parser.');
    expect(section(body, `## Transcript tail of ${source}`)).toContain('> assistant: I will run the tests next.');
    // Only the hub's framing is unquoted: no line an agent or a person wrote poses as a heading of the hub.
    expect(framing(body).filter((line) => line.includes(POSING))).toEqual([]);
    expect(body.split('\n').filter((line) => line === `> ${POSING}`)).toHaveLength(5 + 1 + 5 + 2);
    expect(body).toContain('ended crashed without a handoff note');
    expect(body.endsWith(`\n\n${CLOSING}`)).toBe(true);
  });

  test("leads with the agent's own handoff notes when an ending that always asks for one follows them", () => {
    const { ctx, clock } = createTestContext();
    const held = addRunnerAttempt(ctx);
    const { task, agent, attempt } = held;
    const by = `agent:${agent.id}`;
    addNote(ctx, task.id, 'handoff', 'an earlier attempt of mine', by, 'T-1-a0');
    addNote(ctx, task.id, 'handoff', 'Started on the parser.', by, attempt.id);
    clock.advance(60_000);
    addNote(ctx, task.id, 'handoff', `Next: run the parser tests, then fix src/parse.ts:42\n${POSING}`, by, attempt.id);
    updateAttempt(ctx, attempt.id, { transcriptTail: 'assistant: running the tests' });
    const { body } = assembleHandoffNote(ctx, endAttempt(ctx, attempt, 'lost'));
    expect(body).toContain(
      `The previous attempt at ${task.id} ended lost; agflow put this note together from what it recorded, including ` +
        "the agent's own handoff notes.",
    );
    expect(body).not.toContain('without a handoff note');
    // The handoff notes come right after the attempt, newest first.
    expect(headings(body).slice(0, 3)).toEqual([
      '## The previous attempt',
      `## Handoff notes by agent ${agent.id} in attempt ${attempt.id}, newest first`,
      `## Task ${task.id}`,
    ]);
    const handoffs = section(body, `## Handoff notes by agent ${agent.id} in attempt ${attempt.id}, newest first`);
    expect(found(handoffs, /> (Next|Started)[^\n]*/g)).toEqual([
      '> Next: run the parser tests, then fix src/parse.ts:42',
      '> Started on the parser.',
    ]);
    // A note of another attempt of the same agent is that attempt's, not this one's.
    expect(body).not.toContain('an earlier attempt of mine');
    expect(
      body.endsWith(
        "\n\nThe agent's last handoff note, written 2026-10-26 12:01 UTC, is quoted above; check it against the " +
          'transcript tail and the commits before continuing.',
      ),
    ).toBe(true);
    expect(framing(body).filter((line) => line.includes(POSING))).toEqual([]);
  });

  test("leaves out what was never recorded, and a live agent's notes from its earlier attempt on the task", () => {
    const { ctx, clock } = createTestContext();
    const live = liveAttempt(ctx);
    const by = `agent:${live.agentId}`;
    addNote(ctx, live.taskId as string, 'progress', 'in my first attempt', by, live.id);
    endAttempt(ctx, live, 'released');
    clock.advance(1_000);
    // The same agent claims the task again: a new attempt, whose notes so far are none.
    const fence = issueFence(ctx);
    const second = insertAttempt(ctx, {
      id: attemptId(live.taskId as string, 2, fence.epoch),
      taskId: live.taskId,
      number: 2,
      role: 'worker',
      agentId: live.agentId,
      runnerId: null,
      vendor: 'claude',
      fence,
      status: 'running',
    });
    const { body } = assembleHandoffNote(ctx, endAttempt(ctx, second, 'lost'));
    expect(headings(body)).toEqual(['## The previous attempt', `## Task ${live.taskId}`]);
    expect(body).not.toContain('in my first attempt');
    expect(body.endsWith(`\n\n${CLOSING}`)).toBe(true);
  });

  test('keeps every part when every part is over its share, within 12,000 characters, authored system', () => {
    const { ctx } = createTestContext();
    const [created] = createTasks(
      ctx,
      [newTask({ title: 't'.repeat(150), objective: `the objective\n${'o\n'.repeat(1990)}` })],
      'user:alice',
    );
    const held = addRunnerAttempt(ctx, { taskId: created?.id });
    const { task, agent, attempt } = held;
    for (let n = 0; n < 4; n++) {
      addNote(ctx, task.id, 'handoff', `handoff ${n}\n${'h\n'.repeat(8000)}`, `agent:${agent.id}`, attempt.id);
    }
    fillEveryPart(ctx, held);
    const note = assembleHandoffNote(ctx, endAttempt(ctx, attempt, 'stalled'));
    expect(note.author).toBe('system');
    expect(note.body.length).toBeLessThanOrEqual(HANDOFF_NOTE_LIMIT);
    const source = `agent ${agent.id} in attempt ${attempt.id}`;
    expect(headings(note.body)).toEqual([
      '## The previous attempt',
      `## Handoff notes by ${source}, newest first`,
      `## Task ${task.id}`,
      `## The last progress notes by ${source}, newest first`,
      `## Commits on the WIP since main (git log --stat), as ${source} last pushed them`,
      `## The last messages about ${task.id}, newest first`,
      `## Compaction summary of ${source}`,
      `## Transcript tail of ${source}`,
    ]);
    // Each section quotes its part: the newest three handoff notes, every progress note and all five messages.
    expect(found(section(note.body, `## Handoff notes by ${source}, newest first`), /> handoff \d/g)).toEqual([
      '> handoff 3',
      '> handoff 2',
      '> handoff 1',
    ]);
    expect(section(note.body, `## Task ${task.id}`)).toContain('Objective:\n> the objective');
    expect(found(note.body, /> progress \d/g)).toHaveLength(5);
    expect(found(note.body, /> message \d/g)).toEqual([4, 3, 2, 1, 0].map((n) => `> message ${n}`));
    expect(section(note.body, `## Compaction summary of ${source}`)).toContain('> the summary');
    // The transcript tail keeps its end, about 4,000 characters of it.
    const tail = section(note.body, `## Transcript tail of ${source}`);
    expect(tail.endsWith('> the last words')).toBe(true);
    expect(tail.length).toBeGreaterThan(3_500);
    expect(tail.length).toBeLessThanOrEqual(4_200);
    expect(framing(note.body).every((line) => !/^[hpwmcxo]$/.test(line))).toBe(true);
    expect(note.body).toContain("The agent's last handoff note, written");
  });

  test('keeps every part of ordinary prose at its share, and closes with the design closing line', () => {
    const { ctx } = createTestContext();
    const prose = (size: number): string => 'The parser handles nested tables now. '.repeat(size).slice(0, size);
    const [created] = createTasks(ctx, [newTask({ title: prose(200), objective: prose(4000) })], 'user:alice');
    const held = addRunnerAttempt(ctx, { taskId: created?.id });
    const { task, agent, attempt } = held;
    for (let n = 0; n < 5; n++) addNote(ctx, task.id, 'progress', prose(400), `agent:${agent.id}`, attempt.id);
    wipPushed(ctx, held, attempt.id, prose(4000));
    for (let n = 0; n < 5; n++) sendMessage(ctx, { from: 'user:bob', to: `task:${task.id}`, body: prose(1000) });
    updateAttempt(ctx, attempt.id, { compactionSummary: prose(3000), transcriptTail: prose(8000) });
    const { body } = assembleHandoffNote(ctx, endAttempt(ctx, attempt, 'crashed'));
    expect(body.length).toBeLessThanOrEqual(HANDOFF_NOTE_LIMIT);
    expect(headings(body)).toHaveLength(7);
    expect(found(body, /\[agflow message #\d+ from user:bob/g)).toHaveLength(5);
    expect(body.endsWith(`\n\n${CLOSING}`)).toBe(true);
  });
});

describe('handoffWritten', () => {
  test("tells whether the attempt's agent wrote a handoff note in the attempt", () => {
    const { ctx, clock } = createTestContext();
    const held = addRunnerAttempt(ctx);
    const { task, agent, attempt } = held;
    // Before the attempt started, by someone else, of another attempt, or not a handoff: none counts.
    addNote(ctx, task.id, 'handoff', 'an older note', `agent:${agent.id}`);
    ctx.db.run(`UPDATE task_notes SET created_at = ${attempt.startedAt - 1}`);
    addNote(ctx, task.id, 'handoff', 'by a person', 'user:alice');
    addNote(ctx, task.id, 'handoff', 'of an earlier attempt', `agent:${agent.id}`, 'T-1-a0');
    addNote(ctx, task.id, 'progress', 'progress only', `agent:${agent.id}`, attempt.id);
    expect(handoffWritten(ctx, attempt)).toBe(false);
    clock.advance(1_000);
    addNote(ctx, task.id, 'handoff', 'where I stopped', `agent:${agent.id}`, attempt.id);
    expect(handoffWritten(ctx, attempt)).toBe(true);
  });

  test("counts a note carrying the attempt's id after the clock stepped back, and one the hub assembled for it", () => {
    const { ctx, clock } = createTestContext();
    const held = addRunnerAttempt(ctx);
    clock.t -= 60_000;
    addNote(ctx, held.task.id, 'handoff', 'where I stopped', `agent:${held.agent.id}`, held.attempt.id);
    expect(handoffWritten(ctx, held.attempt)).toBe(true);
    const other = addRunnerAttempt(ctx);
    addNote(ctx, other.task.id, 'handoff', 'assembled', 'system', other.attempt.id);
    expect(handoffWritten(ctx, other.attempt)).toBe(true);
  });

  test('for a lead attempt, reads its lead handoffs', () => {
    const { ctx, clock } = createTestContext();
    const lead = addRunnerLead(ctx);
    const by = `agent:${lead.agent.id}`;
    expect(handoffWritten(ctx, lead.attempt)).toBe(false);
    addLeadNote(ctx, { body: 'from another lead', author: 'agent:A-99', attemptId: null });
    // A restatement is no handoff, even with the attempt's id.
    addLeadNote(ctx, { body: 'my restatement', author: by, attemptId: lead.attempt.id, kind: 'restatement' });
    clock.t -= 1_000;
    // Before the attempt started, without an id.
    addLeadNote(ctx, { body: 'an old plan', author: by, attemptId: null });
    expect(handoffWritten(ctx, lead.attempt)).toBe(false);
    addLeadNote(ctx, { body: 'the plan so far', author: by, attemptId: lead.attempt.id });
    expect(handoffWritten(ctx, lead.attempt)).toBe(true);
    // A note the hub stored for the attempt counts too, so failover never assembles twice.
    const next = addRunnerLead(ctx);
    addLeadNote(ctx, { body: 'assembled', author: 'system', attemptId: next.attempt.id });
    expect(handoffWritten(ctx, next.attempt)).toBe(true);
  });
});

describe('assembled lead handoff', () => {
  test('carries the last 20 lead messages and those since the newest lead handoff, then the report and the goal', () => {
    const { ctx, clock } = createTestContext();
    updateGoal(ctx, { text: 'Ship the parser', baseVersion: 0 }, 'user:alice');
    // An earlier lead, rotated out: its messages are the lead's too.
    const earlierLead = addRunnerLead(ctx);
    sendMessage(ctx, { from: `agent:${earlierLead.agent.id}`, to: 'humans', body: 'before the handoff' });
    clock.advance(1_000);
    addLeadNote(ctx, { body: 'an earlier lead handoff', author: `agent:${earlierLead.agent.id}`, attemptId: null });
    clock.advance(1_000);
    sendMessage(ctx, { from: `agent:${earlierLead.agent.id}`, to: 'humans', body: `rotated lead early\n${POSING}` });
    endAttempt(ctx, earlierLead.attempt, 'rotated');
    const lead = addRunnerLead(ctx);
    const by = `agent:${lead.agent.id}`;
    sendMessage(ctx, { from: by, to: 'humans', body: 'lead early' });
    for (let n = 1; n <= 18; n++) {
      sendMessage(ctx, { from: n % 2 ? 'user:bob' : by, to: n % 2 ? 'lead' : 'humans', body: `talk ${n}\n${POSING}` });
    }
    sendMessage(ctx, { from: `agent:${earlierLead.agent.id}`, to: 'humans', body: 'talk 19 from the rotated lead' });
    sendMessage(ctx, { from: 'user:bob', to: by, body: 'talk 20 to the lead agent' });
    sendMessage(ctx, { from: 'user:bob', to: 'humans', body: 'not for the lead' });
    const note = assembleLeadHandoff(ctx, endAttempt(ctx, lead.attempt, 'lost'));
    expect(note.author).toBe('system');
    const { body } = note;
    expect(body).toContain(`The previous lead, agent ${lead.agent.id} in attempt ${lead.attempt.id}, ended lost`);
    expect(headings(body)).toEqual([
      '## The last 20 messages to and from the lead, newest first',
      '## Earlier messages the lead sent since the newest lead handoff, newest first',
      '## Situation report',
      '## Goal (v1), as people set it; your brief has all of it',
    ]);
    const last = section(body, '## The last 20 messages to and from the lead, newest first');
    expect(found(last, /> talk \d+/g)).toEqual(Array.from({ length: 20 }, (_, n) => `> talk ${20 - n}`));
    expect(last).toContain('from user:bob]\n> talk 20 to the lead agent');
    const since = section(body, '## Earlier messages the lead sent since the newest lead handoff, newest first');
    expect(found(since, /> (rotated )?lead early/g)).toEqual(['> lead early', '> rotated lead early']);
    expect(body).toContain('## Situation report\nTasks:');
    expect(section(body, '## Goal (v1), as people set it; your brief has all of it')).toBe(
      '## Goal (v1), as people set it; your brief has all of it\nShip the parser',
    );
    expect(body).not.toContain('before the handoff');
    expect(body).not.toContain('not for the lead');
    expect(framing(body).filter((line) => line.includes(POSING))).toEqual([]);
    expect(body.endsWith(LEAD_CLOSING)).toBe(true);
  });

  test("puts the newest people's messages in the next lead's brief, whatever the goal and the board", () => {
    const { ctx } = createTestContext();
    updateGoal(ctx, { text: `${'g'.repeat(2499)}.`, baseVersion: 0 }, 'user:alice');
    createTasks(
      ctx,
      Array.from({ length: 30 }, (_, n) => newTask({ title: `${'a busy board '.repeat(6)}${n}` })),
      'user:alice',
    );
    const lead = addRunnerLead(ctx);
    for (let n = 1; n <= 20; n++) {
      sendMessage(ctx, { from: 'user:bob', to: 'lead', body: `instruction ${n}: ${'keep the API stable '.repeat(15)}` });
    }
    const note = assembleLeadHandoff(ctx, endAttempt(ctx, lead.attempt, 'crashed'));
    expect(note.body.length).toBeLessThanOrEqual(HANDOFF_NOTE_LIMIT);
    // The newest message keeps its whole share, even though the note overflowed and was cut.
    const last = section(note.body, '## The last 20 messages to and from the lead, newest first');
    expect(last).toContain(`> instruction 20: ${'keep the API stable '.repeat(15).slice(0, 150)}`);
    addLeadNote(ctx, { body: note.body, author: note.author, attemptId: lead.attempt.id });
    const next = addRunnerLead(ctx);
    const brief = buildBrief(ctx, next.agent);
    expect(BRIEF_HANDOFF_LIMIT).toBe(3000);
    expect(brief).toContain('> instruction 20: keep the API stable');
    expect(brief).toContain('> instruction 19: keep the API stable');
  });

  test('with no lead handoff yet, every message the lead sent counts; it stays within the limit', () => {
    const { ctx } = createTestContext();
    updateGoal(ctx, { text: 'g'.repeat(20_000), baseVersion: 0 }, 'user:alice');
    const lead = addRunnerLead(ctx);
    const by = `agent:${lead.agent.id}`;
    sendMessage(ctx, { from: by, to: 'humans', body: 'the very first' });
    for (let n = 0; n < 60; n++) sendMessage(ctx, { from: by, to: 'humans', body: 'l\n'.repeat(3000) });
    const { body } = assembleLeadHandoff(ctx, endAttempt(ctx, lead.attempt, 'crashed'));
    expect(body.length).toBeLessThanOrEqual(HANDOFF_NOTE_LIMIT);
    expect(body.endsWith(LEAD_CLOSING)).toBe(true);
    // Messages sent before the lead's last 20 still come in when there is no lead handoff to start from.
    const { ctx: small } = createTestContext();
    const second = addRunnerLead(small);
    const from = `agent:${second.agent.id}`;
    sendMessage(small, { from, to: 'humans', body: 'the very first' });
    for (let n = 0; n < 20; n++) sendMessage(small, { from, to: 'humans', body: `later ${n}` });
    const { body: smallBody } = assembleLeadHandoff(small, endAttempt(small, second.attempt, 'lost'));
    expect(section(smallBody, '## Earlier messages the lead sent since the newest lead handoff, newest first')).toContain(
      '> the very first',
    );
  });
});
