import { existsSync } from 'node:fs';
import {
  type AgentRole,
  FetchGrantInputSchema,
  NewTaskSchema,
  type Task,
  type TaskStatus,
  TargetSchema,
  TaskIdSchema,
  TaskPatchSchema,
  branchEpoch,
  formatMessages,
  isHeld,
  isTaskBranch,
  quoteLines,
  taskBranchName,
} from '@agflow/core';
import { z } from 'zod';
import { repoRoot } from '../git';
import type { HubClient } from '../hub-client';
import {
  type StartPoint,
  type TaskWorktree,
  type WorkPosition,
  assertTaskBranch,
  describePosition,
  describeStart,
  followWorkPosition,
  positionMissingFrom,
  prepareTaskWorktree,
  pushTaskBranch,
  remoteCommitsMissingFrom,
  removeTaskWorktree,
  taskWorktreePath,
  workPositionOf,
} from './task-git';

export interface ToolState {
  agentId: string | null;
  role: AgentRole | null;
}

export interface ToolContext {
  client: HubClient | null;
  state: ToolState;
  cwd: string;
}

export interface ToolDef {
  name: string;
  description: string;
  input: Record<string, z.ZodType>;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>;
}

export function defineTool<S extends Record<string, z.ZodType>>(
  name: string,
  description: string,
  input: S,
  run: (args: z.output<z.ZodObject<S>>, ctx: ToolContext) => Promise<string>,
): ToolDef {
  return { name, description, input, run: (args, ctx) => run(args as z.output<z.ZodObject<S>>, ctx) };
}

export class ToolError extends Error {
  override name = 'ToolError';
}

export function hub(ctx: ToolContext): HubClient {
  if (!ctx.client) throw new ToolError('This computer is not signed in to agflow. Ask the person to run `agflow login --hub <url>`.');
  return ctx.client;
}

/** The client acting as this chat's agent: after hello, or with a runner's agent token, which names the agent itself. */
export function asAgent(ctx: ToolContext): HubClient {
  const client = hub(ctx);
  if (!ctx.state.agentId && !client.viaAgentToken) throw new ToolError('Call the agflow tool hello first, with the code from your agflow brief.');
  return client;
}

/** Control characters and the Unicode line and paragraph separators: whatever ends a line or has no place in one. */
const LINE_BREAKS = /[\p{Cc}\p{Zl}\p{Zp}]+/gu;
const SPANS_LINES = /[\p{Cc}\p{Zl}\p{Zp}]/u;

/** At most `max` characters of `text` on a single line. Line breaks and other control characters become spaces. */
export function oneLine(text: string, max: number): string {
  const flat = text.replace(LINE_BREAKS, ' ').trim();
  const chars = Array.from(flat);
  return chars.length <= max ? flat : `${chars.slice(0, max - 1).join('')}…`;
}

/**
 * Text that a person or an agent wrote, after a label of ours. A value of one line stays on the label's
 * line. A longer one goes below it, every line quoted, so that no line of it can pose as a heading, a
 * bullet or a message header of the hub's (spec section 12; the hub's brief does the same).
 */
function labelled(label: string, text: string): string {
  return SPANS_LINES.test(text) ? `${label}\n${quoteLines(text)}` : `${label} ${text}`;
}

const acceptanceLines = (task: Task): string =>
  task.acceptance.map((criterion) => labelled(`- ${criterion.id}:`, criterion.assertion)).join('\n');

const BLOCKED_REASON_LIMIT = 150;

export function taskLine(task: Task): string {
  const owner = task.assignee ? ` · ${task.assignee}` : '';
  // An agent writes the reason, and it may run over several lines. One clipped line keeps it on its task's line.
  const reason = task.status === 'blocked' && task.blockedReason ? oneLine(task.blockedReason, BLOCKED_REASON_LIMIT) : '';
  return `${task.id} [${task.status}] p${task.priority} ${task.title}${owner}${reason ? ` · ${reason}` : ''}`;
}

export const lines = (parts: Array<string | false | null | undefined | 0>) => parts.filter(Boolean).join('\n');

/** Where a chat that holds a task works. claim_task and resume_claim both end with it. */
const workInside = (path: string, branch: string) => `Work only inside ${path} (branch ${branch}). Commit there; submit pushes the branch.`;

/** How a worktree came to be on the branch: the lines of a claim answer that say where the work stands. */
interface StartFacts {
  branch: string;
  worktree: TaskWorktree;
  start: StartPoint | null;
  /** A newer work position the claim answer named that the branch could not be moved to. */
  unfollowed: WorkPosition | null;
  /** The work position an existing branch lacks. */
  missing: StartPoint | null;
  /** Origin's head of the task branch, when it has commits a created branch lacks. */
  remoteAhead: string | null;
}

const describeSwitched = (from: string): string => (/^[0-9a-f]{40}$/.test(from) ? `a detached HEAD at ${from.slice(0, 7)}` : `branch ${from}`);

/** Where the branch started, and what it lacks (design 10, Live-chat claims); null when there is nothing to say. */
function startNote({ branch, worktree, start, unfollowed, missing, remoteAhead }: StartFacts): string | null {
  return (
    lines([
      worktree.switchedFrom !== null &&
        `The worktree was on ${describeSwitched(worktree.switchedFrom)}; agflow switched it to ${branch}, keeping its commits and changes.`,
      start && `Started from ${describeStart(start)}.`,
      unfollowed &&
        `The task's work position moved to ${describePosition(unfollowed)} during the claim, and agflow could not fetch it, so your branch stays where it started. ` +
          `Fetch and merge it before you go on: git fetch origin ${unfollowed.ref ?? unfollowed.sha} && git merge ${unfollowed.sha ?? 'FETCH_HEAD'}`,
      missing &&
        `Your branch ${branch} does not contain the task's work position, ${describeStart(missing)}. Merge it before you go on: git merge ${missing.sha}`,
      remoteAhead &&
        `origin/${branch} (at ${remoteAhead.slice(0, 7)}) has commits your branch lacks, pushed after the work position was taken. ` +
          `Merge them before you submit, or the push is refused: git merge origin/${branch}`,
    ]) || null
  );
}

/**
 * Prepares the worktree, then makes the claim; a refusal by the hub undoes what was prepared. A created branch that
 * the claim answer finds behind a newer work position moves to it before any work starts. The claim stands once the
 * hub has made it, so that move is best effort: when it fails, the answer says how to take the position by hand.
 */
async function claimInWorktree(
  root: string,
  task: Task,
  branch: string,
  claim: () => Promise<{ task: Task }>,
): Promise<{ claimed: Task; worktree: TaskWorktree; startLine: string | null }> {
  const prepared = workPositionOf(task);
  const worktree = prepareTaskWorktree(root, task.id, branch, prepared);
  let claimed: Task;
  try {
    claimed = (await claim()).task;
  } catch (error) {
    removeTaskWorktree(root, worktree, branch);
    throw error;
  }
  const now = workPositionOf(claimed);
  let start = worktree.start;
  let unfollowed: WorkPosition | null = null;
  try {
    start = followWorkPosition(root, worktree, prepared, now) ?? start;
  } catch {
    unfollowed = now;
  }
  const facts = { branch, worktree, start, unfollowed, missing: positionMissingFrom(root, worktree, now), remoteAhead: remoteCommitsMissingFrom(worktree) };
  return { claimed, worktree, startLine: startNote(facts) };
}

export const sharedTools: ToolDef[] = [
  defineTool(
    'hello',
    'Connect this chat to agflow. Call it first, with the code from your agflow brief.',
    { code: z.string().min(4).max(20) },
    async ({ code }, ctx) => {
      const client = hub(ctx);
      const result = await client.hello(code);
      client.agentId = result.agentId;
      ctx.state.agentId = result.agentId;
      ctx.state.role = result.role;
      const next = result.role === 'lead' ? 'Use get_status and list_tasks to see the plan.' : 'Use list_tasks to find ready work and claim_task to take it.';
      return `Connected as agflow agent ${result.agentId} (${result.role}). ${next}`;
    },
  ),
  defineTool(
    'get_brief',
    'Your current agflow brief: goal, standing rules, your task or the situation report, and unread messages.',
    {},
    async (_args, ctx) => (await asAgent(ctx).brief()).brief,
  ),
  defineTool('get_goal', "The project's current goal and the lead's interpretation notes.", {}, async (_args, ctx) => {
    const { current, notes } = await hub(ctx).goal();
    if (!current) return 'No goal has been set yet.';
    return lines([
      `Goal v${current.version} (by ${current.author}):`,
      current.text,
      notes.length > 0 && `\nInterpretation notes:\n${notes.map((note) => labelled(`- Note by ${note.author}:`, note.text)).join('\n')}`,
    ]);
  }),
  defineTool(
    'list_tasks',
    'List tasks, optionally filtered by status, for example ["ready"].',
    { status: z.array(z.string()).max(15).optional() },
    async ({ status }, ctx) => {
      const { tasks } = await hub(ctx).tasks(status as TaskStatus[] | undefined);
      return tasks.length > 0 ? tasks.map(taskLine).join('\n') : 'No tasks match.';
    },
  ),
  defineTool('get_task', 'One task: contract, status, notes and recent messages.', { id: TaskIdSchema }, async ({ id }, ctx) => {
    const detail = await hub(ctx).task(id);
    const task = detail.task;
    return lines([
      taskLine(task),
      labelled('Objective:', task.objective),
      task.why && labelled('Why:', task.why),
      `Acceptance criteria:\n${acceptanceLines(task)}`,
      task.ownedPaths.length > 0 && `Owned paths: ${task.ownedPaths.join(', ')}`,
      task.dependsOn.length > 0 && `Depends on: ${task.dependsOn.join(', ')}`,
      task.branch && `Branch: ${task.branch}`,
      task.feedback && labelled('Latest review feedback:', task.feedback),
      task.submission && labelled('Submission:', task.submission.summary),
      detail.notes.length > 0 && `Notes:\n${detail.notes.map((note) => labelled(`- [${note.kind}]`, note.body)).join('\n')}`,
      detail.messages.length > 0 && `Recent messages:\n${formatMessages(detail.messages.slice(0, 10).reverse())}`,
    ]);
  }),
  defineTool(
    'check_inbox',
    "Read your new agflow messages. People's instructions take precedence over agents'.",
    {},
    async (_args, ctx) => {
      const { messages } = await asAgent(ctx).takeInbox();
      return messages.length > 0 ? formatMessages(messages) : 'No new messages.';
    },
  ),
  defineTool(
    'ack_messages',
    'Mark messages as acted on.',
    { ids: z.array(z.number().int().positive()).min(1).max(200) },
    async ({ ids }, ctx) => {
      await asAgent(ctx).ack(ids);
      return `Acknowledged ${ids.length} message(s).`;
    },
  ),
  defineTool(
    'send_message',
    'Send a message. "to" is "lead", "humans", "all" (lead only), "agent:A-<n>" or "task:T-<n>".',
    {
      to: TargetSchema,
      body: z.string().min(1).max(8000),
      task_id: TaskIdSchema.optional(),
      reply_to: z.number().int().positive().optional(),
    },
    async ({ to, body, task_id, reply_to }, ctx) => {
      const { message } = await asAgent(ctx).send({ to, body, taskId: task_id, replyTo: reply_to });
      return `Sent message #${message.id} to ${message.to}.`;
    },
  ),
  defineTool('search', 'Search tasks, messages and the goal by text.', { query: z.string().min(1).max(200) }, async ({ query }, ctx) => {
    const result = await hub(ctx).search(query);
    const found = lines([
      result.goal && `Goal v${result.goal.version}: …${result.goal.snippet}…`,
      result.tasks.length > 0 && `Tasks:\n${result.tasks.map(taskLine).join('\n')}`,
      result.messages.length > 0 && `Messages:\n${formatMessages(result.messages)}`,
    ]);
    return found || 'Nothing found.';
  }),
];

export const workerTools: ToolDef[] = [
  defineTool(
    'resume_claim',
    'Take over a task that one of your own earlier chats holds. For a task on an agflow branch this also gives you its worktree in this repository; do all work for the task there.',
    { id: TaskIdSchema },
    async ({ id }, ctx) => {
      const client = asAgent(ctx);
      const held = (await client.task(id)).task;
      const { branch } = held;
      if (!isTaskBranch(id, branch)) {
        const { task } = await client.resumeClaim(id);
        return `You now hold ${task.id}${task.branch ? ` (branch ${task.branch})` : ''}.`;
      }
      // As in claim_task, the worktree comes first, so that a refusal by the hub leaves nothing behind.
      const root = repoRoot(ctx.cwd);
      if (!root) throw new ToolError(`${ctx.cwd} is not inside a git repository, so agflow cannot create the worktree for ${id}.`);
      const { claimed, worktree, startLine } = await claimInWorktree(root, held, branch, () => client.resumeClaim(id));
      return lines([`You now hold ${claimed.id} (branch ${branch}).`, startLine, workInside(worktree.path, branch)]);
    },
  ),
  defineTool(
    'report_progress',
    'Record progress on the task you hold. This also keeps your claim alive.',
    { task_id: TaskIdSchema, note: z.string().min(1).max(4000) },
    async ({ task_id, note }, ctx) => {
      const { task } = await asAgent(ctx).progress(task_id, note);
      return `Progress recorded; ${task.id} is ${task.status}.`;
    },
  ),
  defineTool(
    'write_handoff',
    'Leave a handoff note for whoever continues your task: what is done, what remains, commands run and results, decisions, failed approaches, the next step.',
    { task_id: TaskIdSchema, note: z.string().min(1).max(16_000) },
    async ({ task_id, note }, ctx) => {
      await asAgent(ctx).handoff(task_id, note);
      return `Handoff note saved on ${task_id}.`;
    },
  ),
  defineTool(
    'declare_blocked',
    'Stop work on your task because something outside it blocks you. The lead is told.',
    { task_id: TaskIdSchema, reason: z.string().min(1).max(4000) },
    async ({ task_id, reason }, ctx) => {
      const { task } = await asAgent(ctx).block(task_id, reason);
      return `${task.id} is blocked; the lead has been told.`;
    },
  ),
  defineTool(
    'declare_impossible',
    'Report that your task cannot be done as specified (for example, acceptance criteria contradict each other), with evidence.',
    { task_id: TaskIdSchema, evidence: z.string().min(1).max(8000) },
    async ({ task_id, evidence }, ctx) => {
      const { task } = await asAgent(ctx).impossible(task_id, evidence);
      return `${task.id} is marked impossible as specified; the lead will decide.`;
    },
  ),
  defineTool(
    'release_task',
    'Give your task back so someone else can take it.',
    { task_id: TaskIdSchema, reason: z.string().min(1).max(4000) },
    async ({ task_id, reason }, ctx) => {
      const { task } = await asAgent(ctx).release(task_id, reason);
      return `Released ${task.id}; it is ${task.status} again.`;
    },
  ),
];

export const gitTools: ToolDef[] = [
  defineTool(
    'claim_task',
    'Claim a ready task. agflow creates its branch in a separate git worktree inside this repository; do all work for the task there.',
    { id: TaskIdSchema },
    async ({ id }, ctx) => {
      const client = asAgent(ctx);
      const root = repoRoot(ctx.cwd);
      if (!root) throw new ToolError(`${ctx.cwd} is not inside a git repository, so agflow cannot create the task branch.`);
      const [{ task }, { epoch }] = await Promise.all([client.task(id), client.status()]);
      // The hub keeps the branch name a claim last gave it, and any agent can give it any valid name (say
      // "production"). Only a name inside this task's own namespace is used; any other is replaced, and the
      // claim below stores the replacement on the hub. From epoch 2 (after a restore) names carry the epoch, and a
      // branch named before it is not reused, so nothing collides with what existed before (design 6.14). At epoch 1
      // every recorded name is current: an M1 name such as agflow/T-1-e2-parser (title "E2: parser") only looks
      // like an epoch-2 one.
      const branch =
        isTaskBranch(task.id, task.branch) && (epoch === 1 || branchEpoch(task.branch) === epoch)
          ? task.branch
          : taskBranchName(task.id, task.title, epoch);
      const { claimed, worktree, startLine } = await claimInWorktree(root, task, branch, () => client.claim(id, branch));
      return lines([
        `You hold ${claimed.id}: ${claimed.title}`,
        startLine,
        workInside(worktree.path, branch),
        labelled('Objective:', claimed.objective),
        `Acceptance criteria:\n${acceptanceLines(claimed)}`,
        claimed.ownedPaths.length > 0 && `Change only: ${claimed.ownedPaths.join(', ')}`,
        claimed.feedback && labelled('Latest review feedback:', claimed.feedback),
      ]);
    },
  ),
  defineTool(
    'submit',
    'Submit your task for review. Commit all changes in the task worktree first; this pushes the branch and records its head commit.',
    {
      task_id: TaskIdSchema,
      summary: z.string().min(1).max(8000),
      evidence: z.array(z.string().min(1).max(2000)).max(50).optional(),
    },
    async ({ task_id, summary, evidence }, ctx) => {
      const client = asAgent(ctx);
      const { task } = await client.task(task_id);
      // The hub refuses a submission from anyone but the holder, but only after the push below. A chat whose
      // claim has ended (the lease ran out, it released the task, someone took it over) must not push at all:
      // its commits would land on the branch that the task's new holder works on, and that holder's own
      // push would then be rejected.
      if (task.assignee !== ctx.state.agentId || !isHeld(task.status)) {
        const heldBy = isHeld(task.status) && task.assignee ? ` (held by ${task.assignee})` : '';
        throw new ToolError(
          `You do not hold ${task.id}: it is ${task.status}${heldBy}. Nothing was pushed or submitted, and its branch is no longer yours to push to. ` +
            'If you have work worth keeping, tell the lead with send_message. Then pick another task with list_tasks and claim_task.',
        );
      }
      let headSha: string | undefined;
      if (task.branch) {
        // A task on a branch goes to review only with that branch pushed, or the lead would be sent to a branch
        // that is not on the remote. The branch name comes first: resume_claim cannot give a task a new one.
        assertTaskBranch(task.id, task.branch);
        const root = repoRoot(ctx.cwd);
        if (!root) {
          throw new ToolError(
            `${ctx.cwd} is not inside a git repository, so the worktree of ${task.id} cannot be found, and nothing was pushed or submitted. ` +
              `Ask the person to start this chat inside the repository, call resume_claim for ${task.id} there, commit in the worktree it names, and submit again.`,
          );
        }
        const worktree = taskWorktreePath(root, task.id);
        if (!existsSync(worktree)) {
          throw new ToolError(
            `There is no worktree for ${task.id} in ${root}, so nothing was pushed or submitted. ` +
              `Call resume_claim for ${task.id} here, which creates the worktree. Commit your work there, then submit again.`,
          );
        }
        headSha = pushTaskBranch(worktree, task.id, task.branch);
      }
      const submitted = (await client.submit(task_id, { summary, evidence: evidence ?? [], branch: task.branch ?? undefined, headSha })).task;
      const where = headSha ? ` at ${headSha.slice(0, 7)} on ${task.branch}` : '';
      return `${submitted.id} is ${submitted.status}${where}. The lead will review it; you may claim another task.`;
    },
  ),
];

export const leadTools: ToolDef[] = [
  defineTool(
    'fetch_submission',
    'Lead: get the submitted branch and head to review. Then git fetch origin <branch> and review FETCH_HEAD.',
    { task_id: TaskIdSchema },
    async ({ task_id }, ctx) => {
      const { request } = await asAgent(ctx).requestSubmissionFetch(task_id);
      if (request.status !== 'ok') throw new ToolError(request.error ?? 'The submission fetch is still running.');
      return JSON.stringify({ branch: request.branch, head_sha: request.head_sha, note: request.note });
    },
  ),
  defineTool(
    'get_status',
    'Project status: goal version, lead, task counts, active agents and recent messages to people.',
    {},
    async (_args, ctx) => {
      const status = await hub(ctx).status();
      const counts = Object.entries(status.counts).map(([state, n]) => `${state} ${n}`).join(' · ') || 'none';
      return lines([
        `Project: ${status.project.name}${status.project.paused ? ' (PAUSED)' : ''}`,
        `Goal: v${status.goalVersion}`,
        `Lead: ${status.lead ? `${status.lead.id} (${status.lead.user})` : 'none'}`,
        `Tasks: ${counts}`,
        `Active agents: ${status.activeAgents}`,
        status.humansInbox.length > 0 && `Messages to people:\n${formatMessages(status.humansInbox.slice(0, 5))}`,
      ]);
    },
  ),
  defineTool(
    'create_tasks',
    'Lead: create tasks from the goal. Each needs a title, an objective and acceptance criteria. Use "#1" in dependsOn to refer to an earlier task in the same call.',
    { tasks: z.array(NewTaskSchema).min(1).max(20) },
    async ({ tasks }, ctx) => {
      const created = await asAgent(ctx).createTasks(tasks);
      return `Created:\n${created.tasks.map(taskLine).join('\n')}`;
    },
  ),
  defineTool(
    'update_task',
    'Lead: change fields of an open task (title, objective, why, acceptance, checks, ownedPaths, dependsOn, priority, nonGoals, kind).',
    { id: TaskIdSchema, patch: TaskPatchSchema },
    async ({ id, patch }, ctx) => {
      const { task } = await asAgent(ctx).updateTask(id, patch);
      return `Updated ${task.id}: ${taskLine(task)}`;
    },
  ),
  defineTool(
    'cancel_task',
    'Lead: cancel a task, giving the reason. Its holder is told to stop.',
    { id: TaskIdSchema, reason: z.string().min(1).max(4000) },
    async ({ id, reason }, ctx) => {
      await asAgent(ctx).cancel(id, reason);
      return `Cancelled ${id}.`;
    },
  ),
  defineTool(
    'accept_task',
    'Lead: accept a submitted task.',
    { id: TaskIdSchema, note: z.string().min(1).max(4000).optional() },
    async ({ id, note }, ctx) => {
      await asAgent(ctx).accept(id, note);
      return `Accepted ${id}.`;
    },
  ),
  defineTool(
    'reject_task',
    'Lead: reject a submitted task with concrete feedback. It goes back to its author when possible.',
    { id: TaskIdSchema, feedback: z.string().min(1).max(8000) },
    async ({ id, feedback }, ctx) => {
      const { task } = await asAgent(ctx).reject(id, feedback);
      return task.status === 'claimed' ? `Rejected ${id}; it is claimed by ${task.assignee} with your feedback.` : `Rejected ${id}; it is ready for anyone.`;
    },
  ),
  defineTool(
    'unblock_task',
    'Lead: return a blocked task to the pool once its blocker is resolved.',
    { id: TaskIdSchema, note: z.string().min(1).max(4000).optional() },
    async ({ id, note }, ctx) => {
      const { task } = await asAgent(ctx).unblock(id, note);
      return task.status === 'ready' ? `${id} is ready.` : `${id} is still blocked: ${task.blockedReason ?? 'unknown reason'}.`;
    },
  ),
  defineTool(
    'mark_merged',
    'Lead: record that an accepted task was merged, optionally with the merge commit.',
    { id: TaskIdSchema, sha: z.string().regex(/^[0-9a-f]{7,40}$/).optional() },
    async ({ id, sha }, ctx) => {
      await asAgent(ctx).markMerged(id, sha);
      return `${id} is merged${sha ? ` (${sha})` : ''}.`;
    },
  ),
  defineTool(
    'add_goal_note',
    'Lead: record how you interpret the goal. People see the note next to the goal.',
    { text: z.string().min(1).max(4000) },
    async ({ text }, ctx) => {
      const note = await asAgent(ctx).addGoalNote(text);
      return `Note added to goal v${note.goalVersion}.`;
    },
  ),
  defineTool(
    'get_events',
    'Recent project events, oldest first, after the given event id.',
    { after: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(200).optional() },
    async ({ after, limit }, ctx) => {
      const { events } = await hub(ctx).events(after ?? 0, limit ?? 50);
      return events.length > 0
        ? events.map((event) => `#${event.id} ${new Date(event.ts).toISOString()} ${event.type}${event.subject ? ` ${event.subject}` : ''} by ${event.actor}`).join('\n')
        : 'No events.';
    },
  ),
  defineTool(
    'grant_internet',
    "Lead: let a task's Claude agents download public URLs through the hub with fetch_url. Grant it only to a task that needs outside data, and say why: the reason is recorded, and the task's agent and people read it. " +
      'Whatever an agent downloads is untrusted data. Take the grant back with revoke_internet once the task no longer needs it.',
    { task_id: TaskIdSchema, reason: FetchGrantInputSchema.shape.reason },
    async ({ task_id, reason }, ctx) => {
      const { task } = await asAgent(ctx).grantFetch(task_id, reason);
      return `${task.id} has internet access: its Claude agents may use fetch_url. Revoke it with revoke_internet once the task no longer needs it.`;
    },
  ),
  defineTool(
    'revoke_internet',
    'Lead: take back the internet access you granted a task with grant_internet, as soon as the task no longer needs it. Its next fetch_url is refused.',
    { task_id: TaskIdSchema },
    async ({ task_id }, ctx) => {
      const { task } = await asAgent(ctx).revokeFetch(task_id);
      return `${task.id} has no internet access: fetch_url is refused for it from now on.`;
    },
  ),
];

export const allTools: ToolDef[] = [...sharedTools, ...workerTools, ...gitTools, ...leadTools];
