/**
 * A hub with a made-up project, for trying the web UI and for the browser check.
 *
 *   bun run build:web && bun run demo
 *
 * Then open http://localhost:8790 and sign in as "demo". Everything lives in memory and is rebuilt
 * on each start. Every few seconds an agent reports progress, so live updates are visible.
 *
 * The project also has runners, made-up ones (demo-runner.ts) on the hub's real runner link: R-1, demo's MacBook
 * Pro, holds the runner lead; R-2, bob's Mac mini, took T-9 and went offline; R-3 is offline with nothing on it.
 * On R-1, T-8 pushed its first work and waits for two of demo's approvals, T-10 is submitted after a replacement and
 * a refused submission, and T-12 works; T-11 owns agent configuration, so only a live chat may take it.
 * Before its ready line the demo checks its story through the hub's read routes, and exits with an error naming what
 * did not settle.
 */
import { join } from 'node:path';
import { liveChatOnly } from '../packages/core/src/protected-paths';
import { type NewTaskInput, NewTaskSchema } from '../packages/core/src/schemas';
import type {
  AccountQuota,
  Agent,
  AgentRole,
  Approval,
  Attempt,
  AttemptLogEntry,
  HubStatus,
  Runner,
  RunnerVendor,
  Task,
  TaskDetail,
  TaskNote,
  Vendor,
} from '../packages/core/src/types';
import { startLiveSession, touchAgent } from '../packages/hub/src/agents';
import { createSession } from '../packages/hub/src/auth';
import { HUB_RUNNER_DEFAULTS, createContext, stopGraceFor } from '../packages/hub/src/context';
import { addGoalNote, updateGoal } from '../packages/hub/src/goal';
import { ackMessages, sendMessage, takeInbox } from '../packages/hub/src/messages';
import { startHub } from '../packages/hub/src/server';
import {
  acceptTask,
  blockTask,
  claimTask,
  createTasks,
  markMerged,
  reportProgress,
  submitTask,
  writeHandoff,
} from '../packages/hub/src/tasks';
import { demoSha, startDemoRunner } from './demo-runner';

const SECOND = 1000;
const MINUTE = 60_000;
const port = Number(process.env.AGFLOW_DEMO_PORT ?? 8790);

// The story is told as if it happened over the last three hours, so times in the UI look real.
let offset = -180 * MINUTE;
const later = (minutes: number) => {
  offset = Math.min(0, offset + minutes * MINUTE);
};

// Short timings, so the demo settles in seconds; runner leases and approvals keep their defaults, so they outlast a
// browser check.
const HANDOFF_MS = 30 * SECOND;
const ctx = createContext({
  dbPath: ':memory:',
  now: () => Date.now() + offset,
  config: {
    ...HUB_RUNNER_DEFAULTS,
    tickMs: 2 * SECOND,
    heartbeatMs: 2 * SECOND,
    handoffMs: HANDOFF_MS,
    stopGraceMs: stopGraceFor(HANDOFF_MS),
    recoveryMs: 2 * SECOND,
    publicUrl: `http://localhost:${port}`,
    auth: 'dev',
    // Runner owners sign in too: createSession enforces the allowlist.
    allowedUsers: ['demo', 'bob', 'alice'],
    projectName: 'acme-billing',
    projectRepo: 'https://github.com/acme/billing',
    leaseMs: 120 * MINUTE,
    reminderMs: 30 * MINUTE,
    maxOpenTasks: 200,
    maxTasksPerHour: 60,
    secureCookies: false,
    webDist: join(import.meta.dir, '../packages/web/dist'),
  },
});

// The scheduler waits: the story below runs three hours back, and the demo ticks it once the clock is back at now.
const hub = startHub(ctx, { port, scheduler: 'manual' });
const scheduler = hub.scheduler as NonNullable<typeof hub.scheduler>;

let sessions = 0;
function connect(user: string, vendor: Vendor, role: AgentRole, label?: string): Agent {
  sessions += 1;
  return startLiveSession(ctx, user, { vendor, sessionId: `demo-${sessions}`, role, label }).agent;
}

const contract = (input: NewTaskInput) => NewTaskSchema.parse(input);
const tests = (cmd: string) => ({ kind: 'command' as const, cmd, expect: 'exit 0' });

// --- The goal and the lead -------------------------------------------------------------------

updateGoal(ctx, { text: 'Build billing for Acme.\n\nInvoices as PDF.\nCard payments.', baseVersion: 0 }, 'user:alice');
later(5);
const lead = connect('alice', 'claude', 'lead', 'lead chat');
later(40);
updateGoal(
  ctx,
  {
    text: 'Build billing for Acme.\n\nInvoices as PDF.\nCard payments with retries.\nEU VAT.',
    baseVersion: 1,
  },
  'user:alice',
);
later(15);
updateGoal(
  ctx,
  {
    text: [
      'Ship billing for Acme by the November close.',
      '',
      'Success means:',
      '1. Invoices render as PDF with the new template.',
      '2. Card payments retry on failure (1h, 6h, 24h) and never double-charge.',
      '3. EU VAT is calculated per country, with reverse charge for B2B.',
      '4. Partial refunds work, and dunning emails go out after the third failed retry.',
      '',
      'Out of scope: usage-based billing until the meter is designed.',
    ].join('\n'),
    baseVersion: 2,
  },
  'user:demo',
);
later(5);
addGoalNote(ctx, 'Reading "never double-charge" as: every retry reuses the original idempotency key. T-4 owns this.', `agent:${lead.id}`);
addGoalNote(ctx, 'Usage billing stays out of the plan until a person signs off on the meter design.', `agent:${lead.id}`);

// --- The plan --------------------------------------------------------------------------------

later(5);
const [t1, t2, t3, t4, t5, t6] = createTasks(
  ctx,
  [
    contract({
      title: 'Invoice PDF renderer',
      objective: 'Render invoices as PDF with the new template.',
      why: 'Goal success criterion 1.',
      acceptance: [{ id: 'A1', assertion: 'Invoices render with the new template', evidence: tests('bun test src/invoices') }],
      ownedPaths: ['src/invoices/**'],
      priority: 3,
    }),
    contract({
      title: 'Currency rounding rules',
      objective: "Round amounts per currency with banker's rounding.",
      acceptance: [{ id: 'A1', assertion: 'Rounding matches the finance table for 12 currencies' }],
      ownedPaths: ['src/billing/rounding/**'],
      priority: 2,
    }),
    contract({
      title: 'Tax calculation for EU VAT',
      objective: 'Calculate VAT per country, with reverse charge for B2B customers with a VAT id.',
      why: 'Goal success criterion 3. Finance needs it for the November close.',
      nonGoals: ['VAT outside the EU'],
      acceptance: [
        { id: 'A1', assertion: 'Rates match the EU table for all member states', evidence: tests('bun test src/billing/tax') },
        { id: 'A2', assertion: 'B2B customers with a valid VAT id get reverse charge' },
      ],
      checks: [{ name: 'unit', cmd: 'bun test' }],
      ownedPaths: ['src/billing/tax/**'],
      priority: 1,
    }),
    contract({
      title: 'Retry failed card payments',
      objective: 'Retry failed card payments after 1h, 6h and 24h without ever charging twice.',
      why: 'Goal success criterion 2.',
      acceptance: [
        { id: 'A1', assertion: 'Failed payments are retried on schedule', evidence: tests('bun test src/billing/payments') },
        { id: 'A2', assertion: 'Every retry reuses the idempotency key', evidence: { kind: 'review', rubric: 'No path creates a new key' } },
      ],
      ownedPaths: ['src/billing/payments/**'],
      priority: 1,
    }),
    contract({
      title: 'Research: payment provider fees',
      kind: 'research',
      objective: 'Compare fees of Stripe, Adyen and Mollie for our volume.',
      acceptance: [{ id: 'A1', assertion: 'A fee table for three providers in docs/research/fees.md' }],
      ownedPaths: ['docs/research/**'],
      priority: 4,
    }),
    contract({
      title: 'Refund flow for partial refunds',
      objective: 'Let support refund part of an invoice.',
      acceptance: [{ id: 'A1', assertion: 'A partial refund updates the invoice and the ledger' }],
      ownedPaths: ['src/billing/refunds/**'],
      priority: 2,
    }),
    contract({
      title: 'Dunning email sequence',
      objective: 'Email the customer after the third failed retry.',
      acceptance: [{ id: 'A1', assertion: 'The email goes out once, after the third failure' }],
      dependsOn: ['#4'],
      priority: 3,
    }),
    contract({
      title: 'Webhook signature verification',
      objective: 'Reject provider webhooks with a bad signature.',
      acceptance: [{ id: 'A1', assertion: 'Unsigned and badly signed webhooks get 401' }],
      ownedPaths: ['src/webhooks/**'],
      // Only Codex asks for approvals, which this task's story needs.
      vendorHint: 'codex',
      priority: 3,
    }),
    contract({
      title: 'Billing settings page',
      objective: 'Show plan, payment method and invoices in the settings page.',
      acceptance: [{ id: 'A1', assertion: 'The page lists the last 12 invoices' }],
      ownedPaths: ['web/settings/**'],
      // The most urgent ready task, so the first dispatch gives it to R-2.
      priority: 1,
    }),
    contract({
      title: 'Proration on plan change',
      objective: 'Prorate charges when a customer changes plan mid-cycle.',
      acceptance: [{ id: 'A1', assertion: 'Upgrades and downgrades are prorated to the day' }],
      priority: 5,
    }),
    contract({
      title: 'Claude Code settings for the repository',
      objective: 'Allow the test and lint commands, and run the billing tests before each commit.',
      acceptance: [{ id: 'A1', assertion: 'bun test and bun run lint run without asking' }],
      // Agent configuration: no runner agent may change it, so the task is left to live chats.
      ownedPaths: ['.claude/**'],
      priority: 4,
    }),
    contract({
      title: 'Invoice numbering per country',
      objective: 'Number invoices in one gapless sequence per country and year.',
      acceptance: [{ id: 'A1', assertion: 'Two invoices never share a number, and no number is skipped' }],
      ownedPaths: ['src/billing/numbering/**'],
      vendorHint: 'claude',
      // The least urgent, so it is dispatched after T-8 and T-10.
      priority: 6,
    }),
  ],
  `agent:${lead.id}`,
);

// --- Work so far -----------------------------------------------------------------------------

later(5);
const bob = connect('bob', 'codex', 'worker');
const demo = connect('demo', 'claude', 'worker', 'laptop');
const carol = connect('bob', 'claude', 'worker');

claimTask(ctx, t1.id, bob, 'agflow/T-1-invoice-pdf');
later(10);
reportProgress(ctx, t1.id, bob, 'Template wired in; rendering fonts embedded.');
later(10);
submitTask(ctx, t1.id, bob, { summary: 'Invoices render with the new template.', evidence: ['bun test src/invoices: 42 pass'], headSha: '9c1e4b7' });
acceptTask(ctx, t1.id, `agent:${lead.id}`, 'Looks good.');
later(5);
markMerged(ctx, t1.id, 'user:demo', '9c1e4b7a2f');

claimTask(ctx, t2.id, demo, 'agflow/T-2-rounding');
later(15);
submitTask(ctx, t2.id, demo, { summary: "Banker's rounding per currency, table-driven.", evidence: ['bun test src/billing/rounding: 18 pass'], headSha: '4be81c2' });
acceptTask(ctx, t2.id, `agent:${lead.id}`);

claimTask(ctx, t3.id, carol, 'agflow/T-3-eu-vat');
later(10);
reportProgress(ctx, t3.id, carol, 'Rates loaded from the EU table; reverse charge next.');
sendMessage(ctx, { from: 'user:demo', to: 'lead', body: 'Prioritise EU VAT before the dunning emails; finance needs it for the November close.' });
later(10);
sendMessage(ctx, { from: 'user:demo', to: 'all', body: 'Always use pnpm in this repository, never npm.', standingRule: true });
sendMessage(ctx, { from: 'user:alice', to: 'all', body: "Don't touch src/legacy/; it is frozen until the migration.", standingRule: true });
later(10);
submitTask(ctx, t3.id, carol, {
  summary: 'VAT rates by country with reverse charge for B2B. Uses the rounding from T-2.',
  evidence: ['bun test src/billing/tax: 31 pass', 'Checked against the EU rate table of 2026-10-01'],
  headSha: 'a71f0d3',
});
sendMessage(ctx, { from: `agent:${lead.id}`, to: `agent:${carol.id}`, taskId: t3.id, body: 'Please add a test for reverse charge with a missing VAT id.' });

later(10);
claimTask(ctx, t6.id, carol, 'agflow/T-6-partial-refunds');
later(5);
blockTask(ctx, t6.id, carol, 'The payment sandbox rejects partial refunds below 1.00 EUR. Round up, or reject them?');

later(10);
claimTask(ctx, t4.id, bob, 'agflow/T-4-card-retry');
reportProgress(ctx, t4.id, bob, 'Started. Reading src/billing/payments and the provider docs.');
later(10);
sendMessage(ctx, {
  from: `agent:${bob.id}`,
  to: 'humans',
  taskId: t4.id,
  body: 'T-4: the provider sandbox throttles retries to 3 per minute, so the tests take about 4 minutes now.',
});
later(10);
claimTask(ctx, t5.id, demo, 'agflow/T-5-fees');
writeHandoff(ctx, t5.id, demo, 'Compared Stripe and Adyen; table in docs/research/fees.md. Next: Mollie and volume discounts.');
sendMessage(ctx, { from: 'user:demo', to: `agent:${demo.id}`, body: 'Include Mollie in the fee comparison, we have a contact there.' });
later(5);
const inbox = takeInbox(ctx, demo);
ackMessages(ctx, demo, inbox.map((message) => message.id));
sendMessage(ctx, { from: `agent:${demo.id}`, to: 'humans', body: 'Added Mollie. Their volume tier starts at 50k EUR a month.' });
later(5);
reportProgress(ctx, t4.id, bob, 'Retry schedule in place (1h, 6h, 24h). Writing tests for the idempotency key.');

// --- Now -------------------------------------------------------------------------------------

offset = 0;
// The live lead chat is left alone: unseen for longer than liveLeadGraceMs, it no longer holds the seat, and a runner
// lead takes it.
for (const agent of [bob, demo]) touchAgent(ctx, agent.id);

const PROGRESS = [
  'Idempotency key now travels with every retry.',
  'Tests for the 6h retry pass.',
  'Provider timeouts are treated as retryable.',
  'Cleaned up the retry scheduler.',
];
let tick = 0;
setInterval(() => {
  try {
    reportProgress(ctx, t4.id, bob, PROGRESS[tick % PROGRESS.length] as string);
    tick += 1;
    for (const agent of [bob, demo]) touchAgent(ctx, agent.id);
  } catch {
    // Someone released or cancelled T-4 in the UI; the demo just stops reporting.
  }
}, 8000);

// --- Runners ---------------------------------------------------------------------------------

/** A vendor as a runner reports it, ready and logged in to the owner's account unless told otherwise. */
function vendor(name: Vendor, overrides: Partial<RunnerVendor> = {}): RunnerVendor {
  const claude = name === 'claude';
  return {
    vendor: name,
    cliVersion: claude ? '2.1.42' : '0.61.0',
    ownerCliVersion: claude ? '2.1.44' : '0.61.0',
    ready: true,
    problem: null,
    accountId: null,
    plan: claude ? 'Claude Max' : 'ChatGPT Pro',
    managedPolicy: false,
    models: claude
      ? { lead: 'claude-opus-5-5', worker: 'claude-sonnet-5-5' }
      : { lead: 'gpt-6.1-sol', worker: 'gpt-6.1-sol' },
    ceilings: { fiveHour: 0.85, weekly: 0.85 },
    allowPaidUsage: false,
    degraded: false,
    preflightAt: Date.now() - 20 * MINUTE,
    ...overrides,
  };
}

const DEMO_CLAUDE = demoSha('demo@acme.example claude').slice(0, 16);
const DEMO_CODEX = demoSha('demo@acme.example codex').slice(0, 16);
const BOB_CLAUDE = demoSha('bob@acme.example claude').slice(0, 16);

const hubUrl = hub.url;
const r1 = await startDemoRunner({
  url: hubUrl,
  token: createSession(ctx, 'demo', 'cli', "demo's MacBook Pro"),
  runnerKey: 'demo-runner-r1',
  machineId: 'demo-machine-macbook-pro',
  name: "demo's MacBook Pro",
  settings: { capacity: 3 },
  vendors: [vendor('claude', { accountId: DEMO_CLAUDE }), vendor('codex', { accountId: DEMO_CODEX })],
  quota: [
    {
      vendor: 'claude',
      accountId: DEMO_CLAUDE,
      quota: {
        state: 'ok',
        resetsAt: Date.now() + 2 * 60 * MINUTE,
        windows: { fiveHour: 0.42, weekly: 0.31 },
        paidUsage: 'disabled',
        updatedAt: Date.now(),
      },
    },
    {
      vendor: 'codex',
      accountId: DEMO_CODEX,
      quota: {
        state: 'ok',
        resetsAt: null,
        windows: { fiveHour: 0.08, weekly: 0.12 },
        paidUsage: 'unknown',
        updatedAt: Date.now(),
      },
    },
  ],
  power: { source: 'ac', batteryPercent: 100, lowPowerMode: false },
  disk: { freeBytes: 182e9, agflowBytes: 6.4e9 },
});
const r2 = await startDemoRunner({
  url: hubUrl,
  token: createSession(ctx, 'bob', 'cli', "bob's Mac mini"),
  runnerKey: 'demo-runner-r2',
  machineId: 'demo-machine-mac-mini',
  name: "bob's Mac mini",
  vendors: [
    vendor('claude', { accountId: BOB_CLAUDE, plan: 'Claude Pro' }),
    vendor('codex', { ready: false, problem: 'not logged in', plan: null }),
  ],
  profile: { name: 'auto', weakened: ['network allowlist'], dependencyPrep: true },
  power: { source: 'battery', batteryPercent: 57, lowPowerMode: false },
  disk: { freeBytes: 41e9, agflowBytes: 2.1e9 },
});
const r3 = await startDemoRunner({
  url: hubUrl,
  token: createSession(ctx, 'demo', 'cli', "demo's MacBook Air"),
  runnerKey: 'demo-runner-r3',
  machineId: 'demo-machine-macbook-air',
  name: "demo's MacBook Air",
  vendors: [vendor('claude', { accountId: DEMO_CLAUDE })],
});
r3.disconnect();

// --- The runners' story, through the routes people use -----------------------------------------

const person = `Bearer ${createSession(ctx, 'demo', 'cli', 'the demo')}`;
// People act on agents and staffing in a browser.
const browsers = {
  demo: `agflow_session=${createSession(ctx, 'demo', 'web')}`,
  alice: `agflow_session=${createSession(ctx, 'alice', 'web')}`,
};

async function read<T>(path: string): Promise<T> {
  const response = await fetch(new URL(path, hubUrl), { headers: { authorization: person } });
  if (!response.ok) throw new Error(`GET ${path} answered ${response.status}`);
  return (await response.json()) as T;
}

/** A person's request in the browser. */
async function post(user: keyof typeof browsers, path: string, body: unknown): Promise<void> {
  const response = await fetch(new URL(path, hubUrl), {
    method: 'POST',
    headers: { cookie: browsers[user], 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`POST ${path} as ${user} answered ${response.status}`);
}

/** demo in the browser sets the worker target (request_agents); the lead seat is not a worker. */
const staff = (count: number, reason: string) => post('demo', '/api/staffing', { count, reason });

/** Polls until the check holds; on the deadline the demo stops and names what did not settle. */
async function settle(what: string, check: () => Promise<boolean>, timeoutMs = 8 * SECOND): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(what);
    await Bun.sleep(50);
  }
}

const runnerById = async (id: string) =>
  (await read<{ runners: Runner[] }>('/api/runners')).runners.find((runner) => runner.id === id);
const seat = async () => (await read<HubStatus>('/api/status')).leadSeat;
const taskById = async (id: string) => (await read<{ task: Task }>(`/api/tasks/${id}`)).task;
const attemptById = async (id: string) => (await read<{ attempt: Attempt }>(`/api/attempts/${id}`)).attempt;

/** The current attempt of a task, when it has one. */
async function currentAttempt(taskId: string): Promise<Attempt | null> {
  const { currentAttempt } = await taskById(taskId);
  return currentAttempt === null ? null : attemptById(currentAttempt);
}

/**
 * Ticks the scheduler on every poll until the task's new attempt runs on R-1; `after` is the attempt it follows. A tick
 * more than 3 x tickMs after the last one opens the recovery window and dispatches nothing, so one tick is not enough
 * after a slow step; the worker target met by the new attempt keeps the later ticks from starting more.
 */
async function dispatchOnR1(taskId: string, after: string | null = null): Promise<Attempt> {
  await settle(`${taskId} to run on R-1`, async () => {
    scheduler.tick();
    const attempt = await currentAttempt(taskId);
    return attempt !== null && attempt.id !== after && attempt.runnerId === 'R-1' && attempt.status === 'running';
  });
  return (await currentAttempt(taskId)) as Attempt;
}

const taskDetail = (id: string) => read<TaskDetail>(`/api/tasks/${id}`);

async function story(): Promise<void> {
  // The story's three hours read as downtime, so the first ticks only wait out the short recovery window.
  await staff(0, 'Only the lead until the runners are set up.');
  await settle('the recovery window after the story to end', async () => !scheduler.tick().recovering);
  await settle('a runner lead to take the seat on R-1', async () => {
    const held = await seat();
    return held.kind === 'runner' && held.runnerId === 'R-1';
  });
  // R-1 takes no new work for a moment, so the one worker the target allows goes to R-2.
  const holdUntil = Date.now() + MINUTE;
  r1.holdPlacement(holdUntil);
  await settle('R-1 to hold placement for a minute', async () => {
    const until = (await runnerById('R-1'))?.acceptingUntil ?? null;
    return until !== null && until <= holdUntil + 5 * SECOND;
  });
  await staff(1, 'One worker for the settings page.');
  // A tick on every poll: one tick after a slow step would only open the recovery window. The new attempt meets the
  // worker target, so the later ticks start nothing more.
  await settle('T-9 to run on R-2', async () => {
    scheduler.tick();
    const attempt = await currentAttempt('T-9');
    return attempt?.runnerId === 'R-2' && attempt.status === 'running';
  });
  r1.holdPlacement(null);
  await r2.settled();
  r2.disconnect();
  await settle('R-2 to go offline', async () => (await runnerById('R-2'))?.state === 'offline');
}

/** What T-8's install would change, against the attempt's start commit (design 6.10). */
const MANIFEST_DIFF = [
  'diff --git a/package.json b/package.json',
  '--- a/package.json',
  '+++ b/package.json',
  '@@ -9,5 +9,6 @@',
  '   "dependencies": {',
  '     "pdfkit": "^0.17.1",',
  '+    "stripe": "^18.2.0",',
  '     "zod": "^4.1.0"',
  '   },',
  '   "devDependencies": {',
  'diff --git a/bun.lock b/bun.lock',
  '--- a/bun.lock',
  '+++ b/bun.lock',
  '@@ -7,5 +7,6 @@',
  '       "dependencies": {',
  '         "pdfkit": "^0.17.1",',
  '+        "stripe": "^18.2.0",',
  '         "zod": "^4.1.0",',
  '       },',
  '     },',
  '@@ -41,1 +42,3 @@',
  '     "pdfkit": ["pdfkit@0.17.1", "", {}, "sha512-pdfkit"],',
  '+',
  '+    "stripe": ["stripe@18.2.0", "", {}, "sha512-stripe"],',
].join('\n');

/**
 * The runner work on R-1 (design 6.4, 6.8, 6.10, 6.13), one worker at a time through the worker target: T-8 logs its
 * work, pushes a WIP and waits for two approvals; T-10's first attempt is replaced by alice, its successor restates the
 * handoff, gets the first attempt's late work, has S-1 refused and S-2 recorded, and holds; T-12 works in a turn. With
 * three workers running (T-8, T-9 and T-12) the target is met, so R-1's free slot stays for a runner lead whenever the
 * seat empties.
 */
async function runnerWork(): Promise<void> {
  await settle('R-1 to take new work again', async () => (await runnerById('R-1'))?.acceptingUntil === null);

  await staff(2, 'A second worker for the webhooks.');
  const t8 = await dispatchOnR1('T-8');
  // The agent reads, pushes its first WIP (the task's work position from then on), and finds the SDK missing.
  r1.emit('attempt.activity', { kind: 'tool', summary: 'Read src/webhooks/stripe.ts' }, t8.id);
  const { wipRef, head } = r1.attempt(t8.id);
  r1.emit(
    'attempt.wip',
    {
      ref: wipRef as string,
      sha: head,
      stripped: [],
      skipped: [],
      embedded: [],
      logStat: ' src/webhooks/stripe.ts | 24 ++++++++++++++++++++++++\n 1 file changed, 24 insertions(+)',
    },
    t8.id,
  );
  r1.emit(
    'attempt.activity',
    { kind: 'text', summary: 'The signature check needs the Stripe SDK, which is not installed yet.' },
    t8.id,
  );
  await settle("T-8's WIP to be its work position", async () => (await taskById('T-8')).workSha === head);
  const cwd = `/Users/demo/.agflow/work/${t8.id}`;
  r1.requestApproval(t8.id, {
    kind: 'command',
    summary: 'Install the Stripe SDK to verify webhook signatures',
    detail: {
      command: 'npm install stripe@^18.2.0',
      cwd,
      reason: 'The signature check uses stripe.webhooks.constructEvent, and the SDK is not installed yet.',
      manifestDiff: MANIFEST_DIFF,
    },
  });
  r1.requestApproval(t8.id, {
    kind: 'file_change',
    summary: 'Add signed sample payloads to the shared fixtures',
    detail: {
      cwd,
      reason: 'The other services test against the same samples.',
      diff: [
        '--- /dev/null',
        '+++ b/webhooks/stripe/invoice.paid.json',
        '@@ -0,0 +1,3 @@',
        '+{',
        '+  "type": "invoice.paid"',
        '+}',
      ].join('\n'),
      grantRoot: '/Users/demo/code/acme-fixtures',
    },
  });

  await staff(3, 'A third worker for proration.');
  const first = await dispatchOnR1('T-10');
  await r1.progress(first.id, 'Reading the plan catalogue; it has no per-day prices yet.');
  await post('alice', `/api/agents/${first.agentId}/replace`, {
    reason: 'It keeps re-reading the plan catalogue; a fresh session should get on with it.',
  });
  await settle('T-10 to be ready after the replace', async () => (await taskById('T-10')).status === 'ready');
  // The successor starts with the handoff, restates it, and is then told of the first attempt's late work.
  const second = await dispatchOnR1('T-10', first.id);
  const noted = (kind: TaskNote['kind']) => async () =>
    (await taskDetail('T-10')).notes.some((note) => note.kind === kind);
  await settle("T-10's restatement", noted('restatement'));
  r1.lateWork(first.id);
  await settle("T-10's late-work note", noted('late_work'));
  await r1.submit(
    second.id,
    { summary: 'Proration to the day for upgrades and downgrades.' },
    { error: 'needs_merge', detail: 'someone pushed to agflow/T-10 since the last submission' },
  );
  const submissions = async () => (await taskDetail('T-10')).submissions;
  await settle('S-1 to be refused', async () => (await submissions()).some((entry) => entry.status === 'failed'));
  await r1.submit(second.id, {
    summary: 'Proration to the day for upgrades and downgrades, merged with the branch.',
    evidence: ['bun test src/billing/proration: 14 pass'],
  });
  await settle('T-10 to be submitted, its attempt holding', async () => {
    const task = await taskById('T-10');
    return task.status === 'submitted' && (await attemptById(second.id)).status === 'holding';
  });

  // T-10's attempt holds and no longer counts as a running worker, so T-12 takes its place.
  const t12 = await dispatchOnR1('T-12');
  r1.setFacts(t12.id, { phase: 'turn', turns: 3 });
  await r1.settled();
}

/** The demo's own check of its story, through the hub's read routes; returns what is not as told. */
async function selfCheck(): Promise<string[]> {
  const problems: string[] = [];
  const expect = (what: string, ok: boolean) => {
    if (!ok) problems.push(what);
  };
  const [one, two, three] = await Promise.all(['R-1', 'R-2', 'R-3'].map(runnerById));
  const { accounts } = await read<{ accounts: AccountQuota[] }>('/api/runners');
  const claude = accounts.find((account) => account.owner === 'demo' && account.vendor === 'claude');
  const ceilings = one?.vendors.find((entry) => entry.vendor === 'claude')?.ceilings;
  expect(
    "R-1 is demo's, online, with Claude and Codex ready, on AC power, with 3 slots",
    one?.owner === 'demo' &&
      one.state === 'online' &&
      one.capacity === 3 &&
      one.vendors.every((entry) => entry.ready) &&
      one.vendors.length === 2 &&
      one.power?.source === 'ac',
  );
  expect(
    "R-1's Claude account has used 42% of its 5-hour window and 31% of its week, against 85% ceilings",
    claude?.quota.windows.fiveHour === 0.42 &&
      claude.quota.windows.weekly === 0.31 &&
      ceilings?.fiveHour === 0.85 &&
      ceilings.weekly === 0.85,
  );
  expect(
    "R-2 is bob's, offline, on the auto profile with a weakened boundary, its Codex not logged in, on battery",
    two?.owner === 'bob' &&
      two.state === 'offline' &&
      two.profile.name === 'auto' &&
      two.profile.weakened.length > 0 &&
      two.vendors.some((entry) => entry.vendor === 'codex' && entry.problem === 'not logged in') &&
      two.power?.source === 'battery',
  );
  expect(
    "R-3 is demo's, offline, with no attempts",
    three?.owner === 'demo' && three.state === 'offline' && three.activeAttempts === 0,
  );
  const t9 = await currentAttempt('T-9');
  expect('T-9 runs on the offline R-2', t9?.runnerId === 'R-2' && t9.status === 'running');
  const held = await seat();
  const leadAttempt = held.attemptId === null ? null : await attemptById(held.attemptId);
  expect(
    'a runner lead holds the seat on R-1, and the live lead chat no longer does',
    held.kind === 'runner' && held.runnerId === 'R-1' && held.agentId !== lead.id && leadAttempt?.status === 'running',
  );

  const t8 = await currentAttempt('T-8');
  const t8Task = await taskById('T-8');
  const t8Log = t8 ? (await read<{ log: AttemptLogEntry[] }>(`/api/attempts/${t8.id}`)).log : [];
  expect(
    "T-8's WIP is its work position, and its log has what the agent read and found",
    t8Task.workRef !== null &&
      t8Task.workRef === t8?.wipRef &&
      t8Task.workSha === t8.wipSha &&
      ['tool', 'text'].every((kind) => t8Log.some((entry) => entry.kind === kind)),
  );
  const { approvals } = await read<{ approvals: Approval[] }>('/api/approvals?status=pending');
  const onT8 = approvals.filter((approval) => approval.attemptId === t8?.id && approval.owner === 'demo');
  expect(
    'T-8 runs on R-1 with Codex and waits for two approvals of demo: npm install with its manifest diff, and a file ' +
      'change with a grant root',
    t8?.runnerId === 'R-1' &&
      t8.vendor === 'codex' &&
      t8.phase === 'waiting_approval' &&
      onT8.length === 2 &&
      onT8.some(
        (approval) =>
          approval.kind === 'command' &&
          approval.detail.command?.startsWith('npm install') === true &&
          ['package.json', 'bun.lock'].every((file) => approval.detail.manifestDiff?.includes(file)),
      ) &&
      onT8.some((approval) => approval.kind === 'file_change' && approval.detail.grantRoot !== undefined),
  );

  const t10 = await taskDetail('T-10');
  const [first, second] = [...t10.attempts].sort((a, b) => a.number - b.number);
  const note = (kind: TaskNote['kind'], attempt: Attempt | undefined) =>
    t10.notes.some((entry) => entry.kind === kind && attempt !== undefined && entry.attemptId === attempt.id);
  const [s1, s2] = [...t10.submissions].sort((a, b) => a.requestedAt - b.requestedAt);
  expect(
    "T-10's first attempt was replaced by alice and wrote a handoff note, and its late work has a note",
    first?.endReason === 'replaced' &&
      first.stopRequested?.by === 'user:alice' &&
      note('handoff', first) &&
      note('late_work', first),
  );
  expect(
    "T-10's second attempt restated the handoff and holds",
    second?.status === 'holding' && note('restatement', second),
  );
  expect(
    'T-10 is submitted, with S-1 refused needs_merge and S-2 recorded',
    t10.task.status === 'submitted' &&
      s1?.id === 'S-1' &&
      s1.status === 'failed' &&
      s1.error?.startsWith('needs_merge') === true &&
      s2?.id === 'S-2' &&
      s2.status === 'submitted',
  );

  const t11 = await taskById('T-11');
  expect(
    'T-11 is left to live chats, ready with no attempt',
    liveChatOnly(t11) && t11.status === 'ready' && t11.currentAttempt === null,
  );
  const t12 = await currentAttempt('T-12');
  expect(
    'T-12 runs on R-1 with Claude, in a turn',
    t12?.runnerId === 'R-1' && t12.vendor === 'claude' && t12.status === 'running' && t12.phase === 'turn',
  );

  for (const runner of [r1, r2, r3]) {
    for (const error of runner.errors) problems.push(`${runner.options.name}: ${error}`);
  }
  return problems;
}

try {
  await story();
  await runnerWork();
  const problems = await selfCheck();
  if (problems.length > 0) throw new Error(problems.join('; '));
} catch (error) {
  console.error(`the demo did not settle: ${(error as Error).message}`);
  await Promise.all([r1, r2, r3].map((runner) => runner.close()));
  await hub.stop();
  process.exit(1);
}
// From here the scheduler ticks on its own, so the pages show what a running hub does.
scheduler.start();
console.log(`agflow demo hub on http://localhost:${port}, sign in as "demo"`);
