// The tools of a runner agent's bridge, `agflow mcp --runner` (design 10, 6.13, 7.7). AGFLOW_ROLE chooses the set: a
// worker's task is assigned, so it has no claim_task or resume_claim, and submits in two phases, the runner pushing
// for it; a lead gets M1's lead tools and the staffing tools, and submits nothing. The agent token names the agent, so
// no tool waits for hello. Every refusal is an error result; success and the pending answers are normal results, as
// adapters count a terminal tool only on a normal result (X-19).
import {
  AgentIdSchema,
  type AgentRole,
  FIXABLE_SUBMIT_ERRORS,
  type PrepareRequest,
  StaffingInputSchema,
  type SubmissionRecord,
  type SubmitError,
  TaskIdSchema,
  VendorSchema,
  quoteLines,
  splitSubmitError,
} from '@agflow/core';
import { z } from 'zod';
import { HubClientError } from '../hub-client';
import { type ToolContext, type ToolDef, ToolError, asAgent, defineTool, leadTools, sharedTools, workerTools } from './tools';

/** What the runner tells its bridge through the agent environment. */
export interface RunnerBridgeSettings {
  /** AGFLOW_ATTEMPT_ID */
  attemptId: string;
  /** AGFLOW_ROLE */
  role: AgentRole;
  /** AGFLOW_BRIDGE_POLL_MS: how often submit, fetch_submission and prepare_dependencies ask the hub how their request went. */
  pollMs: number;
  /** AGFLOW_BRIDGE_POLL_MAX_MS: how long they ask before they answer that it is still pending. */
  pollMaxMs: number;
  /** The polls' clock and wait: performance.now and Bun.sleep unless a test passes its own. */
  now?: (() => number) | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

export interface RunnerToolContext extends ToolContext {
  runner: RunnerBridgeSettings;
  /**
   * The preparation prepare_dependencies last answered as still running, until a later call reports how it went: the
   * hub hands back only a pending request, and never sends a preparation's outcome as a message.
   */
  pendingPrepareId: string | null;
  /** Explicit fetches whose polling budget expired, keyed by task. */
  pendingFetchIds?: Map<string, string>;
}

/** A tool's context in runner mode; every runner tool is served in runner mode only. */
function runnerContext(ctx: ToolContext): RunnerToolContext {
  if (!(ctx as Partial<RunnerToolContext>).runner) throw new ToolError('This agflow tool is for agents on a runner only.');
  return ctx as RunnerToolContext;
}

/** A poll's failure that the next poll may not meet: the hub unreachable for a moment, or a server error. */
const isTransient = (error: unknown): boolean => error instanceof HubClientError && (error.code === 'unreachable' || error.status >= 500);

/**
 * Asks until the answer is decided or pollMaxMs has passed: the decided answer, or null when it is still pending. The
 * request is made by then, so a poll that fails for a moment leaves it pending rather than failing the tool; the hub's
 * refusals (an ended attempt, say) still end the tool at once.
 */
async function pollUntilDecided<T>(ask: () => Promise<T>, decided: (answer: T) => boolean, runner: RunnerBridgeSettings): Promise<T | null> {
  const now = runner.now ?? (() => performance.now());
  const sleep = runner.sleep ?? ((ms: number) => Bun.sleep(ms));
  const deadline = now() + runner.pollMaxMs;
  while (now() < deadline) {
    await sleep(Math.min(runner.pollMs, Math.max(0, deadline - now())));
    let answer: T;
    try {
      answer = await ask();
    } catch (error) {
      if (isTransient(error)) continue;
      throw error;
    }
    if (decided(answer)) return answer;
  }
  return null;
}

const SUBMISSION_PENDING = 'submission pending; do not submit again; the result will arrive as a message';

type FixableSubmitError = (typeof FIXABLE_SUBMIT_ERRORS)[number];

/** Core's list of the refusals the agent fixes, the one the hub's messages follow too. */
const isFixable = (code: SubmitError | null): code is FixableSubmitError => (FIXABLE_SUBMIT_ERRORS as readonly (string | null)[]).includes(code);

/** What the agent does about a refusal it can fix, when the runner sent no detail that says so. */
const FIX_BY_CODE: Record<FixableSubmitError, string> = {
  dirty: 'the clone has uncommitted changes. Commit them, or remove what does not belong in the submission, then submit again.',
  protected_paths:
    'your commits change protected paths, which agents may not change. Revert them to the versions your branch started from, or merge main if main changed them, then submit again.',
  needs_merge: 'someone added commits to the task branch on top of agflow work. Run `git fetch origin && git merge origin/<your branch>`, resolve any conflicts, then submit again.',
};

const SAFE_WORK = 'Your work is safe in your WIP ref. You may submit again, or call declare_blocked.';

/**
 * A failed submission as the agent reads it. A refusal it can fix passes the runner's detail on unchanged, as it
 * already says what to fix; any other failure says the work is safe. The hub's own words (an ended attempt) are quoted
 * as they came.
 */
export function submissionRefusal(submission: SubmissionRecord): string {
  const { code, detail } = splitSubmitError(submission.error ?? '');
  const which = `Your submission ${submission.id} of ${submission.taskId}`;
  if (isFixable(code)) return `${which} was refused (${code}): ${detail ?? FIX_BY_CODE[code]}`;
  switch (code) {
    case 'branch_moved':
      return (
        `${which} was refused (branch_moved): the task branch moved outside agflow. The task is blocked for people, and agflow stops this attempt: write a handoff note. ` +
        `Your work is safe in your WIP ref.${detail ? ` The runner said: ${detail}` : ''}`
      );
    case 'remote':
    case 'interrupted': {
      const why = code === 'interrupted' ? 'a stop or hold interrupted its push' : 'the runner could not push it';
      return `${which} failed (${code}): ${why}. ${SAFE_WORK}${detail ? ` The runner said: ${detail}` : ''}`;
    }
    case null:
      return `${which} failed: ${detail ?? 'no reason given'}. ${SAFE_WORK}`;
  }
}

/** A finished preparation's log tail, quoted: the package manager's output is not agflow's words. */
const logTailOf = (request: PrepareRequest): string => (request.logTail ? `\nThe end of its log:\n${quoteLines(request.logTail)}` : '');

const runnerHello = defineTool(
  'hello',
  'Not needed on a runner: this chat is already connected to agflow.',
  { code: z.string().max(20).optional() },
  async (_args, ctx) =>
    `You are already connected to agflow as attempt ${runnerContext(ctx).runner.attemptId}; there is no hello to do. Use get_brief to read your brief again.`,
);

const submit = defineTool(
  'submit',
  'Submit your task for review once every change is committed in your working directory. The runner pushes the task branch for you; wait for the answer, and do not submit again while it is pending.',
  {
    task_id: TaskIdSchema,
    summary: z.string().min(1).max(8000),
    evidence: z.array(z.string().min(1).max(2000)).max(50).optional(),
  },
  async ({ task_id, summary, evidence }, ctx) => {
    const { runner } = runnerContext(ctx);
    const client = asAgent(ctx);
    const { submission } = await client.submitWork(task_id, { summary, evidence: evidence ?? [] });
    const decided =
      submission.status === 'pending'
        ? (await pollUntilDecided(() => client.submission(submission.id), (answer) => answer.submission.status !== 'pending', runner))?.submission
        : submission;
    if (!decided) return `${SUBMISSION_PENDING} (${submission.id} of ${task_id}).`;
    if (decided.status === 'failed') throw new ToolError(submissionRefusal(decided));
    return `${decided.taskId} submitted at ${decided.headSha ?? 'an unknown commit'} (${decided.id}). The lead will review it; your work on it is done, so end your turn.`;
  },
);

const prepareDependencies = defineTool(
  'prepare_dependencies',
  "Ask the runner to install the project's dependencies into your working directory, as the project's .agflow/config.json says. Use it after you change a dependency manifest or lockfile; you have no network to install them yourself.",
  {},
  async (_args, ctx) => {
    const bridge = runnerContext(ctx);
    const client = asAgent(ctx);
    // A preparation answered as still running is reported before another is asked for.
    const earlier = bridge.pendingPrepareId;
    bridge.pendingPrepareId = null;
    const { request } = earlier ? await client.prepareRequest(earlier) : await client.requestPrepare();
    const decided =
      request.status === 'pending'
        ? (await pollUntilDecided(() => client.prepareRequest(request.id), (answer) => answer.request.status !== 'pending', bridge.runner))?.request
        : request;
    if (!decided) {
      bridge.pendingPrepareId = request.id;
      return `The dependency preparation ${request.id} is still running. Call prepare_dependencies again later to hear how it went; that call starts no new preparation.`;
    }
    if (decided.status === 'failed') {
      throw new ToolError(`The dependency preparation ${decided.id} failed: ${decided.error ?? 'no reason given'}.${logTailOf(decided)}`);
    }
    return `The dependencies are prepared (${decided.id}).${logTailOf(decided)}`;
  },
);

const fetchSubmission = defineTool(
  'fetch_submission',
  'Lead: fetch a task submission into your runner vault and wait for its submitted head. After success, run git fetch origin <branch> and review FETCH_HEAD before accepting or rejecting.',
  { task_id: TaskIdSchema },
  async ({ task_id }, ctx) => {
    const bridge = runnerContext(ctx);
    const client = asAgent(ctx);
    const pending = bridge.pendingFetchIds ??= new Map();
    const earlier = pending.get(task_id);
    const { request } = earlier ? await client.submissionFetch(earlier) : await client.requestSubmissionFetch(task_id);
    const decided = request.status === 'pending'
      ? (await pollUntilDecided(() => client.submissionFetch(request.id!), (answer) => answer.request.status !== 'pending', bridge.runner))?.request
      : request;
    if (!decided) {
      pending.set(task_id, request.id!);
      throw new ToolError(`The submission fetch ${request.id} is still running. Call fetch_submission again for ${task_id} before fetching or reviewing the branch.`);
    }
    pending.delete(task_id);
    if (decided.status === 'failed') throw new ToolError(`The submission fetch failed: ${decided.error ?? 'no reason given'}`);
    return JSON.stringify({ branch: decided.branch, head_sha: decided.head_sha, ...(decided.note ? { note: decided.note } : {}) });
  },
);

const requestAgents = defineTool(
  'request_agents',
  "Lead: set how many workers agflow runs on runners, of any vendor, and why; agflow caps it at the project's limit, and 0 stops new starts without pausing the project. vendor names the vendor new workers prefer for the next hour.",
  { count: StaffingInputSchema.shape.count, vendor: VendorSchema.optional(), reason: z.string().min(1).max(4000) },
  async ({ count, vendor, reason }, ctx) => {
    const { running, target } = await asAgent(ctx).staffing({ count, vendor, reason });
    return `The target is ${target} runner worker(s); ${running} running now.${vendor ? ` New workers prefer ${vendor} for the next hour.` : ''}`;
  },
);

const stopAgent = defineTool(
  'stop_agent',
  'Lead: stop a worker running on a runner. It writes a handoff note first; with hold, its task waits for people instead of going to the next worker.',
  { agent_id: AgentIdSchema, reason: z.string().min(1).max(4000), hold: z.boolean().optional() },
  async ({ agent_id, reason, hold }, ctx) => {
    const { attempt } = await asAgent(ctx).stopAgent(agent_id, { reason, hold: hold ?? false });
    const held = hold ? ', and its task is held for people' : '';
    const deferred = attempt.stopRequested?.deferred ? ' It waits until the submission it has pending is decided.' : '';
    return `Asked agflow to stop ${agent_id} (attempt ${attempt.id})${held}.${deferred}`;
  },
);

const replaceAgent = defineTool(
  'replace_agent',
  'Lead: replace a worker running on a runner with a fresh one, which continues from its handoff note and work.',
  { agent_id: AgentIdSchema, reason: z.string().min(1).max(4000) },
  async ({ agent_id, reason }, ctx) => {
    const { attempt } = await asAgent(ctx).replaceAgent(agent_id, reason);
    const deferred = attempt.stopRequested?.deferred ? ' It waits until the submission it has pending is decided.' : '';
    return `Asked agflow to replace ${agent_id} (attempt ${attempt.id}).${deferred}`;
  },
);

/**
 * The hub takes a handoff note on a task only from the task's holder (design 6.5), and a lead holds no task, so the
 * lead's handoff goes to the lead notes only. A task_id gets a refusal that says where a note on a task goes, rather
 * than a lead handoff the lead did not mean.
 */
const leadHandoff = defineTool(
  'write_handoff',
  "Leave your lead handoff for the next lead: the plan's state, decisions, what you are waiting for, the next step. A lead holds no task, so task_id is refused: for a note on a task, use send_message to \"task:T-<n>\".",
  { note: z.string().min(1).max(16_000), task_id: TaskIdSchema.optional() },
  async ({ note, task_id }, ctx) => {
    if (task_id) {
      throw new ToolError(
        `A lead's handoff goes on no task: nothing was saved. Call write_handoff without task_id for your lead handoff, or send_message to "task:${task_id}" for a note on ${task_id}.`,
      );
    }
    await asAgent(ctx).leadHandoff(note);
    return 'Lead handoff saved; the next lead reads it.';
  },
);

/**
 * M1's release_task answers that the task is ready again. A runner attempt's release only asks agflow to stop it: the
 * task goes back to ready once the agent has stopped (design 6.4).
 */
const runnerRelease = defineTool(
  'release_task',
  'Give your task back so someone else can take it. agflow then stops this attempt.',
  { task_id: TaskIdSchema, reason: z.string().min(1).max(4000) },
  async ({ task_id, reason }, ctx) => {
    await asAgent(ctx).release(task_id, reason);
    return `Released ${task_id}: agflow stops this attempt, and the task goes back to ready once it has stopped. End your turn.`;
  },
);

const getLeadNotes = defineTool('get_lead_notes', "Lead: the lead notes, newest first: earlier leads' handoffs and restatements.", {}, async (_args, ctx) => {
  const { notes } = await asAgent(ctx).leadNotes();
  if (notes.length === 0) return 'No lead notes yet.';
  return notes.map((note) => `[${note.kind}] by ${note.author} at ${new Date(note.createdAt).toISOString()}:\n${quoteLines(note.body)}`).join('\n\n');
});

const byName = (tools: ToolDef[], names: readonly string[]): ToolDef[] =>
  names.map((name) => {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`no agflow tool ${name}`);
    return tool;
  });

/** The shared tools, with hello answering that the chat is connected already. */
const runnerShared: ToolDef[] = sharedTools.map((tool) => (tool.name === 'hello' ? runnerHello : tool));

const WORKER_TOOLS = ['report_progress', 'write_handoff', 'declare_blocked', 'declare_impossible'] as const;

/** A runner worker's tools (design 10): no claim_task or resume_claim, a release that stops the attempt, and a submit the runner pushes. */
export const runnerWorkerTools: ToolDef[] = [...runnerShared, ...byName(workerTools, WORKER_TOOLS), runnerRelease, submit, prepareDependencies];

/** A runner lead's tools (design 10): M1's lead tools and the staffing ones; no claim, resume or submit. */
export const runnerLeadTools: ToolDef[] = [...runnerShared, ...leadTools.filter((tool) => tool.name !== 'fetch_submission'), requestAgents, replaceAgent, stopAgent, leadHandoff, getLeadNotes, fetchSubmission];

/** The tools AGFLOW_ROLE chooses. */
export function runnerToolsFor(role: AgentRole): ToolDef[] {
  return role === 'lead' ? runnerLeadTools : runnerWorkerTools;
}
