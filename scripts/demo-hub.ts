/**
 * A hub with a made-up project, for trying the web UI and for the browser check.
 *
 *   bun run build:web && bun run demo
 *
 * Then open http://localhost:8790 and sign in as "demo". Everything lives in memory and is rebuilt
 * on each start. Every few seconds an agent reports progress, so live updates are visible.
 */
import { join } from 'node:path';
import { type NewTaskInput, NewTaskSchema } from '../packages/core/src/schemas';
import type { Agent, AgentRole, Vendor } from '../packages/core/src/types';
import { startLiveSession, touchAgent } from '../packages/hub/src/agents';
import { createContext } from '../packages/hub/src/context';
import { addGoalNote, updateGoal } from '../packages/hub/src/goal';
import { createApp } from '../packages/hub/src/http/app';
import { ackMessages, sendMessage, takeInbox } from '../packages/hub/src/messages';
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

const MINUTE = 60_000;
const port = Number(process.env.AGFLOW_DEMO_PORT ?? 8790);

// The story is told as if it happened over the last three hours, so times in the UI look real.
let offset = -180 * MINUTE;
const later = (minutes: number) => {
  offset = Math.min(0, offset + minutes * MINUTE);
};

const ctx = createContext({
  dbPath: ':memory:',
  now: () => Date.now() + offset,
  config: {
    publicUrl: `http://localhost:${port}`,
    auth: 'dev',
    allowedUsers: ['demo'],
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
      priority: 0,
    }),
    contract({
      title: 'Billing settings page',
      objective: 'Show plan, payment method and invoices in the settings page.',
      acceptance: [{ id: 'A1', assertion: 'The page lists the last 12 invoices' }],
      ownedPaths: ['web/settings/**'],
      priority: 6,
    }),
    contract({
      title: 'Proration on plan change',
      objective: 'Prorate charges when a customer changes plan mid-cycle.',
      acceptance: [{ id: 'A1', assertion: 'Upgrades and downgrades are prorated to the day' }],
      priority: 5,
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
for (const agent of [lead, bob, demo]) touchAgent(ctx, agent.id);

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
    for (const agent of [lead, bob, demo]) touchAgent(ctx, agent.id);
  } catch {
    // Someone released or cancelled T-4 in the UI; the demo just stops reporting.
  }
}, 8000);

const server = Bun.serve({ port, fetch: createApp(ctx).fetch, idleTimeout: 120 });
console.log(`agflow demo hub on http://localhost:${server.port}, sign in as "demo"`);
