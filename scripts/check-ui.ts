/**
 * Drives the built web UI in headless Chromium against the demo hub and checks the main flows.
 *
 *   bun run build:web && bun run check:ui
 *
 * Needs Playwright's Chromium. If it is missing, install it once with
 *   bun node_modules/playwright-core/cli.js install --only-shell chromium
 * Screenshots of every page are written to a temporary folder, printed at the end.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Locator, type Page, chromium } from 'playwright-core';

const port = 8795;
const base = `http://localhost:${port}`;
const shots = mkdtempSync(join(tmpdir(), 'agflow-ui-'));

const hub = Bun.spawn(['bun', join(import.meta.dir, 'demo-hub.ts')], {
  env: { ...process.env, AGFLOW_DEMO_PORT: String(port) },
  stdout: 'pipe',
  stderr: 'inherit',
});

/** The line the demo prints once its story has settled and checked itself. */
const READY_LINE = 'agflow demo hub on';

/** Forwards the demo's output, all along, and resolves at its ready line; rejects if the demo exits before it. */
function readyLine(): Promise<void> {
  return new Promise((resolve, reject) => {
    const forward = async () => {
      const decoder = new TextDecoder();
      let buffered = '';
      for await (const chunk of hub.stdout) {
        buffered += decoder.decode(chunk, { stream: true });
        const lines = buffered.split('\n');
        buffered = lines.pop() ?? '';
        for (const line of lines) {
          console.log(line);
          if (line.startsWith(READY_LINE)) resolve();
        }
      }
      throw new Error(`the demo hub exited with code ${await hub.exited} before it was ready`);
    };
    forward().catch(reject);
  });
}

/**
 * The demo prints its ready line once its story has settled and checked itself; it exits with an error naming what
 * did not settle instead. Either that, or 20 seconds without the line, fails the check.
 */
async function waitForHub(): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('the demo hub was not ready within 20 seconds')), 20_000);
  });
  try {
    await Promise.race([readyLine(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const failures: string[] = [];
let current: Page | null = null;

async function check(name: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`  FAIL  ${name}: ${(error as Error).message.split('\n')[0]}`);
    await current?.screenshot({ path: join(shots, `failed-${failures.length}.png`), fullPage: true });
  }
}

async function shot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(600); // let the entrance animation finish
  await page.screenshot({ path: join(shots, `${name}.png`), fullPage: true });
}

async function open(page: Page, hash: string, selector: string): Promise<void> {
  await page.goto(`${base}/${hash}`);
  await page.waitForSelector(selector);
}

async function waitForCount(locator: Locator, count: number): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if ((await locator.count()) === count) return;
    await Bun.sleep(100);
  }
  throw new Error(`expected ${count}, found ${await locator.count()}`);
}

/** Waits until the task page shows the given status. */
const statusIs = (page: Page, label: string) =>
  page.locator('.task-head .chip', { hasText: new RegExp(`^${label}$`) }).waitFor();

async function main(): Promise<void> {
  await waitForHub();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  current = page;
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    // 400 and 401 answers are expected: a bad commit SHA, and /api/me before sign-in.
    if (message.type() === 'error' && !/status of 40[01]/.test(message.text())) consoleErrors.push(message.text());
  });

  try {
    await page.goto(`${base}/#/task/T-3`);
    await check('sign-in returns to the page that was asked for', async () => {
      await page.fill('input[autocomplete=username]', 'demo');
      await page.click('button.primary');
      await page.locator('h1.page-title', { hasText: 'EU VAT' }).waitFor();
    });
    await check('the live connection opens', () => page.locator('.connection.live').waitFor({ timeout: 5000 }));
    await check('a submitted task can be accepted', async () => {
      await page.click('.actions button:has-text("Accept")');
      await page.click('.action-form .confirm-action');
      await statusIs(page, 'Accepted');
    });
    await shot(page, 'task');
    await check('a comment on a task nobody holds goes to the lead and shows in the thread', async () => {
      const placeholder = (await page.getAttribute('.composer textarea', 'placeholder')) ?? '';
      if (!placeholder.includes('the lead')) throw new Error(`the box says: ${placeholder}`);
      await page.fill('.composer textarea', 'Thanks. Merge it after the freeze.');
      await page.click('.composer button.primary');
      const sent = page.locator('.message', { hasText: 'Merge it after the freeze' });
      await sent.locator('.message-head', { hasText: 'the lead' }).waitFor();
    });

    await open(page, '#/task/T-2', '.task-head');
    await check('a bad merge commit shows the hub error, a good one marks the task merged', async () => {
      await page.click('.actions button:has-text("Mark merged")');
      await page.fill('.action-form input', 'xyz');
      await page.click('.action-form .confirm-action');
      await page.locator('.action-form .error').waitFor();
      await page.fill('.action-form input', '1a2b3c4');
      await page.click('.action-form .confirm-action');
      await statusIs(page, 'Merged');
    });

    await open(page, '#/task/T-6', '.task-head');
    await check('a blocked task can be unblocked', async () => {
      await page.click('.actions button:has-text("Unblock")');
      await page.fill('.action-form textarea', 'Reject refunds below 1.00 EUR with a clear error.');
      await page.click('.action-form .confirm-action');
      await statusIs(page, 'Ready');
    });
    await check('the note given when unblocking is in the thread and in the history', async () => {
      await page.locator('.message-body', { hasText: 'Reject refunds below 1.00 EUR' }).waitFor();
      await page.locator('.log-text', { hasText: 'unblocked T-6: Reject refunds below 1.00 EUR' }).waitFor();
    });

    await open(page, '#/task/T-5', '.task-head');
    await check('a claim can be released', async () => {
      await page.click('.actions button:has-text("Release claim")');
      await page.fill('.action-form textarea', 'Moving this to next week.');
      await page.click('.action-form .confirm-action');
      await statusIs(page, 'Ready');
    });

    await open(page, '#/board', '.board');
    await check('the board shows the open tasks', async () => {
      const ids = await page.locator('.task-card .task-id').allTextContents();
      for (const id of ['T-3', 'T-4', 'T-6', 'T-7', 'T-8']) if (!ids.includes(id)) throw new Error(`${id} missing`);
    });
    await check('a person can create a task', async () => {
      await page.click('button:has-text("New task")');
      await page.fill('.new-task input >> nth=0', 'Export invoices as CSV');
      await page.fill('.new-task textarea >> nth=0', 'Finance can export a month of invoices as CSV.');
      await page.fill('.new-task textarea >> nth=2', '- One row per invoice\n- Totals match the PDF');
      await page.click('.new-task button.primary');
      await page.waitForURL(/#\/task\/T-13$/);
      await waitForCount(page.locator('.criteria li'), 2);
    });
    await shot(page, 'new-task');

    await open(page, '#/goal', '.charter-text');
    await check('opening the goal clears the badge for messages to people', () =>
      page.locator('.nav a[href="#/goal"] .badge').waitFor({ state: 'detached' }),
    );
    await check('editing the goal previews the change and saves a new version', async () => {
      await page.click('button:has-text("Edit goal")');
      const text = await page.inputValue('.goal-input');
      await page.fill('.goal-input', `${text}\n5. Invoices can be exported as CSV.`);
      await page.locator('.diff-add').first().waitFor();
      await shot(page, 'goal-edit');
      await page.click('button:has-text("Save as v4")');
      await page.locator('.page-meta', { hasText: 'Version 4' }).waitFor();
    });
    await check('the goal history shows what each version changed', async () => {
      await page.click('.version-toggle:text-is("v1")');
      await page.locator('.versions .diff-add').first().waitFor();
    });
    await shot(page, 'goal');

    await open(page, '#/messages?to=agent%3AA-3', '.composer');
    await check('a person can message an agent', async () => {
      await page.fill('.composer textarea', 'Please share the fee table when it is ready.');
      await page.click('.composer button.primary');
      await page.locator('.message-body', { hasText: 'fee table' }).waitFor();
    });
    await check('a message can become a standing rule', async () => {
      await page.selectOption('.composer-to select', 'all');
      await page.fill('.composer textarea', 'Write commit messages in English.');
      await page.check('.composer input[type=checkbox]');
      await page.click('.composer button.primary');
      await page.locator('.message-body', { hasText: 'commit messages' }).waitFor();
    });
    await shot(page, 'messages');

    await open(page, '#/knowledge', '.rule');
    await check('standing rules are listed and can be removed', async () => {
      await waitForCount(page.locator('.rule'), 3);
      await page.click('.rule >> nth=0 >> button:has-text("Remove")');
      await page.click('.rule >> nth=0 >> button:has-text("Remove rule")');
      await waitForCount(page.locator('.rule'), 2);
    });
    await check('search finds tasks', async () => {
      await page.fill('.search input', 'VAT');
      await page.click('.search button');
      await page.locator('.result-tasks .task-link', { hasText: 'T-3' }).waitFor();
    });
    await shot(page, 'knowledge');

    await open(page, '#/agents', 'table');
    await check('agents are listed with what they work on, and the lead is the runner lead on R-1', async () => {
      // The live lead chat, A-1, has been away for hours, so it is listed only with the disconnected agents.
      const text = (await page.locator('table').textContent()) ?? '';
      if (!text.includes('T-4')) throw new Error(text.slice(0, 200));
      // The page signed in, so its fetch carries the session.
      const seat = await page.evaluate<{ kind: string; agentId: string | null; runnerId: string | null }>(
        "fetch('/api/status').then((response) => response.json()).then((status) => status.leadSeat)",
      );
      if (seat.kind !== 'runner' || seat.runnerId !== 'R-1') throw new Error(`the seat: ${JSON.stringify(seat)}`);
      const leadRow = page.locator('tr', { has: page.locator('.chip', { hasText: 'Lead' }) });
      await waitForCount(leadRow, 1);
      const row = (await leadRow.textContent()) ?? '';
      if (!seat.agentId || !row.includes(seat.agentId)) throw new Error(`the Lead row: ${row}`);
    });
    await shot(page, 'agents');

    /** The text of the attempt page's fact with this label. */
    const fact = async (label: string) =>
      (await page.locator('.fact', { has: page.locator(`dt:text-is("${label}")`) }).locator('dd').first().textContent()) ?? '';
    await open(page, '#/attempt/T-10-a1', '.attempt-head');
    await check("the page of T-10's first attempt shows Replaced, its class, who asked and why, its WIP ref and the log", async () => {
      const chip = (await page.locator('.attempt-head .chip').textContent()) ?? '';
      if (chip !== 'Replaced') throw new Error(`the chip reads ${chip}`);
      if ((await fact('Class')) !== 'None') throw new Error(`the class reads ${await fact('Class')}`);
      const stop = page.locator('.stop-request');
      if ((await fact('Cause')) !== 'Replace') throw new Error(`the cause reads ${await fact('Cause')}`);
      if (!(await fact('Asked by')).startsWith('alice')) throw new Error(`asked by ${await fact('Asked by')}`);
      await stop.locator('.stop-reason', { hasText: 'It keeps re-reading the plan catalogue' }).waitFor();
      if (!(await fact('Work in progress')).startsWith('refs/agflow/T-10/a1 at ')) {
        throw new Error(`the WIP reads ${await fact('Work in progress')}`);
      }
      await page.locator('.attempt-log .log-text', { hasText: 'the agent exited' }).waitFor();
      await page.locator('a.back[href="#/task/T-10"]').waitFor();
    });
    await shot(page, 'attempt');
    await open(page, '#/attempt/T-12-a1', '.attempt-head');
    await check("the page of T-12's running attempt shows its facts: phase, last event, turns", async () => {
      await page.locator('.attempt-facts').waitFor();
      const facts = { Phase: 'Working', 'Last agent event': /^\d+ s ago$/, Turns: '3', Fence: /^e1\.\d+$/ };
      for (const [label, expected] of Object.entries(facts)) {
        const value = await fact(label);
        if (typeof expected === 'string' ? value !== expected : !expected.test(value)) throw new Error(`${label} reads ${value}`);
      }
    });
    await check("the lead's attempt page has no task and links to Agents", async () => {
      const seat = await page.evaluate<{ attemptId: string | null }>(
        "fetch('/api/status').then((response) => response.json()).then((status) => status.leadSeat)",
      );
      if (!seat.attemptId?.startsWith('lead-')) throw new Error(`the seat's attempt: ${seat.attemptId}`);
      await open(page, `#/attempt/${seat.attemptId}`, '.attempt-head');
      await page.locator('a.back[href="#/agents"]').waitFor();
      await page.locator('.nav a[href="#/agents"][aria-current="page"]').waitFor();
      if ((await page.locator('.attempt-head .task-link').count()) !== 0) throw new Error('the page names a task');
      if (!(await page.locator('h1.page-title').textContent())?.startsWith('Lead attempt')) throw new Error('no lead title');
    });

    await open(page, '#/agents', 'table');
    /** The Agents row of the agent working on a task. */
    const agentRow = (taskId: string) => page.locator('tr', { has: page.locator(`.task-link:text-is("${taskId}")`) });
    const cell = async (row: Locator, name: string) => ((await row.locator(`.agent-${name}`).textContent()) ?? '').trim();
    await check("runner agents show their runner, attempt and phase (T-12's agent: R-1, a1, Working)", async () => {
      const row = agentRow('T-12');
      // The phase comes from the open attempts, which load apart from the agents, so the check waits for it.
      await row.locator('.agent-phase', { hasText: /^Working$/ }).waitFor();
      const cells = { runner: await cell(row, 'runner'), attempt: await cell(row, 'attempt'), phase: await cell(row, 'phase') };
      if (cells.runner !== 'R-1' || cells.attempt !== 'a1' || cells.phase !== 'Working') {
        throw new Error(`the row shows ${JSON.stringify(cells)}`);
      }
      await row.locator('.agent-attempt a[href="#/attempt/T-12-a1"]').waitFor();
    });
    await check("the lead's row says it runs on R-1 and how many wake-ups it has had", async () => {
      const lead = page.locator('tr', { has: page.locator('.chip', { hasText: 'Lead' }) });
      const seat = (await lead.locator('.lead-seat').textContent()) ?? '';
      if (!/^On R-1 · \d+ wake-ups? since rotation$/.test(seat)) throw new Error(`the lead's row says ${seat}`);
    });
    await check('live chats have no runner actions, only Message', async () => {
      const row = agentRow('T-4');
      await waitForCount(row, 1);
      if ((await cell(row, 'runner')) !== 'Live chat') throw new Error(`T-4's agent runs in ${await cell(row, 'runner')}`);
      if ((await row.locator('button').count()) !== 0) throw new Error('a live chat offers runner actions');
      if ((await row.locator('.cell-action').textContent())?.trim() !== 'Message') throw new Error('no Message link');
    });
    /** Opens the actions of the agent on a task. */
    const actionsOf = async (taskId: string) => {
      const row = agentRow(taskId);
      if ((await row.locator('button[aria-expanded="true"]').count()) === 0) await row.locator('button:text-is("Actions")').click();
      return page.locator('.agent-actions-row .runner-actions-panel');
    };
    await check("interrupting T-12's agent succeeds, and its attempt log records the interrupt", async () => {
      const actions = await actionsOf('T-12');
      const offered = await actions.locator('.actions button').allTextContents();
      if (offered.join(',') !== 'Interrupt,Stop,Stop and hold,Replace,Take over') throw new Error(`it offers ${offered.join(', ')}`);
      await actions.locator('.actions button:text-is("Interrupt")').click();
      // The second click.
      await actions.locator('.action-form .confirm-action:text-is("Interrupt")').click();
      await actions.locator('.runner-actions-done', { hasText: 'Interrupt' }).waitFor();
      // The runner logs the interrupt in its own time, and logging sends no event, so the hub is asked until it has
      // the entry; the attempt page, opened then, must show it.
      for (let tries = 0; ; tries++) {
        const logged = await page.evaluate<boolean>(
          "fetch('/api/attempts/T-12-a1').then((response) => response.json())" +
            ".then(({ log }) => log.some((entry) => entry.summary === 'the turn was interrupted'))",
        );
        if (logged) break;
        if (tries === 20) throw new Error('the hub has no log entry for the interrupt');
        await Bun.sleep(250);
      }
      await open(page, '#/attempt/T-12-a1', '.attempt-head');
      await page.locator('.attempt-log .log-text', { hasText: 'the turn was interrupted' }).waitFor();
    });
    await open(page, '#/agents', 'table');
    await check('stop and hold on T-12\'s agent asks for a reason, then T-12 is Paused', async () => {
      const actions = await actionsOf('T-12');
      await actions.locator('.actions button:text-is("Stop and hold")').click();
      const confirm = actions.locator('.action-form .confirm-action:text-is("Stop and hold")');
      if (!(await confirm.isDisabled())) throw new Error('it stops without a reason');
      await actions.locator('.action-form textarea').fill('Hold this until the pricing review is done.');
      await shot(page, 'agent-actions');
      await confirm.click();
      // The form closes once the hub took the request; the agent then leaves, and its row with it.
      await confirm.waitFor({ state: 'detached' });
      await open(page, '#/task/T-12', '.task-head');
      await statusIs(page, 'Paused');
    });
    await check("T-12, paused by the Agents check, shows the 'Stopped and held by a person' heading and offers Unblock", async () => {
      await page.locator('.attention h2', { hasText: /^Stopped and held by a person$/ }).waitFor();
      await page.locator('.attention', { hasText: 'Hold this until the pricing review is done.' }).waitFor();
      await page.locator('.actions button:text-is("Unblock")').waitFor();
    });

    /** A task as the hub has it, through the page's signed-in session. */
    const taskDetail = (id: string) =>
      page.evaluate<{
        task: { workRef: string | null; workSha: string | null };
        attempts: { id: string; wipSha: string | null }[];
        submissions: { id: string; headSha: string | null }[];
      }>(`fetch('/api/tasks/${id}').then((response) => response.json())`);
    /** The Attempts table's row of an attempt, by its short name. */
    const attemptRow = (name: string) =>
      page.locator('.attempts-table tbody tr', { has: page.locator(`.attempt-link:text-is("${name}")`) });
    const rowCell = async (row: Locator, name: string) => ((await row.locator(`.attempt-${name}`).textContent()) ?? '').trim();
    await open(page, '#/task/T-8', '.task-head');
    await check('T-8 shows its current attempt, its work position and its newest log entries', async () => {
      await page.locator('.task-head .fact a.attempt-link[href="#/attempt/T-8-a1"]').waitFor();
      const current = await fact('Current attempt');
      if (current !== 'a1 · Waiting for approval') throw new Error(`the current attempt reads ${current}`);
      const { task } = await taskDetail('T-8');
      const position = await fact('Work position');
      if (!task.workRef || !task.workSha || position !== `${task.workRef} at ${task.workSha.slice(0, 7)}`) {
        throw new Error(`the work position reads ${position}`);
      }
      const log = page.locator('.task-attempt-log .log-text');
      await log.filter({ hasText: 'Read src/webhooks/stripe.ts' }).waitFor();
      await log.filter({ hasText: 'The signature check needs the Stripe SDK' }).waitFor();
      // The log lists newest first, so its first row is the hub's last entry (after the row's kind label).
      const { log: entries } = await page.evaluate<{ log: { summary: string }[] }>(
        "fetch('/api/attempts/T-8-a1').then((response) => response.json())",
      );
      const newest = entries.at(-1)?.summary;
      const first = ((await log.first().textContent()) ?? '').trim();
      if (!newest || !first.endsWith(newest)) throw new Error(`the newest entry reads ${first}, not ${newest}`);
      await page.locator('.task-attempt-log a[href="#/attempt/T-8-a1"]').waitFor();
      if ((await fact('Attempts')) !== '1') throw new Error(`the attempt count reads ${await fact('Attempts')}`);
    });
    await check('T-8, held by a runner, offers Stop, Stop and hold, Replace and Take over, but not Release claim', async () => {
      const offered = await page.locator('.actions-card .runner-actions-panel .actions button').allTextContents();
      if (offered.join(',') !== 'Stop,Stop and hold,Replace,Take over') throw new Error(`it offers ${offered.join(', ')}`);
      const all = await page.locator('.actions-card button').allTextContents();
      if (all.includes('Release claim')) throw new Error(`the page offers ${all.join(', ')}`);
      const hint = (await page.locator('.actions-card .action-hint').textContent()) ?? '';
      if (!hint.includes('on a runner')) throw new Error(`the hint reads ${hint}`);
    });
    await open(page, '#/task/T-10', '.task-head');
    await check('T-10 lists attempts a1 (Replaced, its runner, WIP ref and sha) and a2 (Holding), each linking its attempt page', async () => {
      await waitForCount(page.locator('.attempts-table tbody tr'), 2);
      const { attempts } = await taskDetail('T-10');
      const first = attempts.find((attempt) => attempt.id === 'T-10-a1');
      const cells = {
        end: await rowCell(attemptRow('a1'), 'end'),
        runner: await rowCell(attemptRow('a1'), 'runner'),
        wip: await rowCell(attemptRow('a1'), 'wip'),
        second: await rowCell(attemptRow('a2'), 'status'),
      };
      const wip = `refs/agflow/T-10/a1 at ${first?.wipSha?.slice(0, 7)}`;
      if (cells.end !== 'Replaced' || cells.runner !== 'R-1' || cells.wip !== wip || cells.second !== 'Holding') {
        throw new Error(`the rows show ${JSON.stringify(cells)}`);
      }
      await attemptRow('a1').locator('a.attempt-link[href="#/attempt/T-10-a1"]').waitFor();
      await attemptRow('a2').locator('a.attempt-link[href="#/attempt/T-10-a2"]').waitFor();
      if ((await fact('Attempts')) !== '2') throw new Error(`the attempt count reads ${await fact('Attempts')}`);
    });
    await check("T-10's handoff note, its successor's restatement and the late-work note sit side by side", async () => {
      const step = page.locator('.note-step', { has: page.locator('.note-step-head', { hasText: 'a1 → a2' }) });
      await waitForCount(step, 1);
      const left = step.locator('.note-left');
      const right = step.locator('.note-right');
      await left.locator('.note', { hasText: 'It keeps re-reading the plan catalogue' }).waitFor();
      await left.locator('.note', { hasText: 'Late work of attempt T-10-a1' }).waitFor();
      await right.locator('.note', { hasText: 'Restating T-10' }).waitFor();
      const [a, b] = [await left.boundingBox(), await right.boundingBox()];
      if (!a || !b || a.x + a.width > b.x || a.y >= b.y + b.height || b.y >= a.y + a.height) {
        throw new Error(`the columns are not side by side: ${JSON.stringify([a, b])}`);
      }
      // The progress note stays in the notes list, outside the handoffs.
      await page.locator('.card:not(.handoffs) .note', { hasText: 'it has no per-day prices yet' }).waitFor();
      if ((await page.locator('.handoffs .note', { hasText: 'no per-day prices' }).count()) !== 0) {
        throw new Error('the progress note is among the handoffs');
      }
    });
    await check("T-10's submissions show S-1 refused because the branch needs a merge, and S-2 submitted at its sha; accepting T-10 still works", async () => {
      const { submissions } = await taskDetail('T-10');
      const s2 = submissions.find((submission) => submission.id === 'S-2');
      const record = (id: string) => page.locator('.submission-record', { has: page.locator(`.submission-id:text-is("${id}")`) });
      const refused = (await record('S-1').locator('.submission-outcome').textContent()) ?? '';
      if (!refused.startsWith('Refused: someone added commits to the task branch, so it must merge them first')) {
        throw new Error(`S-1 reads ${refused}`);
      }
      await record('S-1').locator('.submission-detail', { hasText: 'someone pushed to agflow/T-10' }).waitFor();
      const submitted = (await record('S-2').locator('.submission-outcome').textContent()) ?? '';
      if (!s2?.headSha || submitted !== `Submitted at ${s2.headSha.slice(0, 7)}`) throw new Error(`S-2 reads ${submitted}`);
      // Its attempt still holds, but a submitted task has no runner actions: only people's review.
      const runnerPanels = await page.locator('.actions-card .runner-actions-panel').count();
      if (runnerPanels !== 0) throw new Error('T-10 offers runner actions');
      await page.click('.actions button:has-text("Accept")');
      await page.click('.action-form .confirm-action');
      await statusIs(page, 'Accepted');
    });
    await shot(page, 'task-attempts');
    await open(page, '#/task/T-11', '.task-head');
    await check('T-11 is marked live chat only', async () => {
      await page.locator('.task-head .chip.live-only', { hasText: 'Live chat only' }).waitFor();
    });
    await open(page, '#/task/T-12', '.task-head');
    await check('a task runners may take has no live-chat-only mark', async () => {
      await statusIs(page, 'Paused');
      if ((await page.locator('.live-only').count()) !== 0) throw new Error('T-12 is marked live chat only');
    });

    await check('the strip shows how many runners are online', () =>
      page.locator('.strip .readout', { hasText: /^Runners\s*1\/3\s*online$/ }).waitFor(),
    );
    await open(page, '#/runners', '.runner-card');
    /** The text of one runner's card. */
    const card = (id: string) => page.locator('.runner-card', { has: page.locator(`.runner-id:text-is("${id}")`) });
    const cardText = async (id: string) => (await card(id).textContent()) ?? '';
    await check('the Runners page lists R-1, R-2 and R-3 with owner, state, slots, power, disk, keep-awake, git and each vendor', async () => {
      await waitForCount(page.locator('.runner-card'), 3);
      const expected: Record<string, { owner: string; parts: (string | RegExp)[] }> = {
        'R-1': {
          owner: 'demo',
          parts: ["demo's MacBook Pro", 'Online', /\d of 3 slots free/, 'On AC power', '182 GB free, 6.4 GB used by agflow'],
        },
        'R-2': {
          owner: 'bob',
          parts: ["bob's Mac mini", 'Offline', /\d of \d slots? free/, 'On battery, 57%', '41.0 GB free, 2.1 GB used by agflow'],
        },
        'R-3': {
          owner: 'demo',
          parts: ["demo's MacBook Air", 'Offline', /\d of \d slots? free/, 'On AC power', '120 GB free, 2.0 GB used by agflow'],
        },
      };
      for (const [id, { owner, parts }] of Object.entries(expected)) {
        const ownerFact = card(id).locator('.fact', { has: page.locator('dt:text-is("Owner")') }).locator('dd');
        if ((await ownerFact.textContent()) !== owner) throw new Error(`${id}'s owner is not ${owner}`);
        const text = await cardText(id);
        // Every demo runner keeps the hello's default keep-awake setting.
        const all = [...parts, 'Kept awake on AC power', 'Git ready', 'Claude Code'];
        const missing = all.filter((part) => (typeof part === 'string' ? !text.includes(part) : !part.test(text)));
        if (missing.length > 0) throw new Error(`${id} lacks ${missing.join(', ')}: ${text.slice(0, 300)}`);
      }
      for (const id of ['R-1', 'R-2']) {
        if (!(await cardText(id)).includes('Codex')) throw new Error(`${id} does not list Codex`);
      }
    });
    await check("R-2 says why it is offline, shows its weakened boundary and Codex 'not logged in'", async () => {
      const why = (await card('R-2').locator('.runner-why').textContent()) ?? '';
      // R-2 went away without a word, so the line is the offline default.
      if (!why.startsWith('Last seen')) throw new Error(`the why line: ${why}`);
      const text = await cardText('R-2');
      if (!text.includes('Not enforced on this laptop: network allowlist')) throw new Error('no weakened boundary');
      const codex = card('R-2').locator('.vendor', { has: page.locator('.vendor-name:text-is("Codex")') });
      if (!((await codex.textContent()) ?? '').includes('not logged in')) throw new Error('Codex is not "not logged in"');
    });
    await check("R-1's Claude meters show the utilization against the 85% ceiling and the account's reset time", async () => {
      const claude = card('R-1').locator('.vendor', { has: page.locator('.vendor-name:text-is("Claude Code")') });
      const meters = claude.locator('.meter');
      await waitForCount(meters, 2);
      const used = [
        ['42% used, ceiling 85%', '42%'],
        ['31% used, ceiling 85%', '31%'],
      ];
      for (const [index, [text, width]] of used.entries()) {
        const meter = meters.nth(index);
        if (!((await meter.textContent()) ?? '').includes(text)) throw new Error(`meter ${index} lacks ${text}`);
        const fill = (await meter.locator('.meter-fill').getAttribute('style')) ?? '';
        if (!fill.includes(width)) throw new Error(`meter ${index}'s fill: ${fill}`);
        const mark = (await meter.locator('.meter-mark').getAttribute('style')) ?? '';
        if (!mark.includes('85%')) throw new Error(`meter ${index}'s ceiling mark: ${mark}`);
      }
      // The reset time as the browser shows it, in its own time zone.
      const reset = await page.evaluate<string>(`fetch('/api/runners').then((response) => response.json()).then(({ accounts }) => {
        const at = new Date(accounts.find((a) => a.owner === 'demo' && a.vendor === 'claude').quota.resetsAt);
        return String(at.getHours()).padStart(2, '0') + ':' + String(at.getMinutes()).padStart(2, '0');
      })`);
      const line = (await claude.locator('.quota-line').textContent()) ?? '';
      if (!line.startsWith('Resets at') || !line.includes(reset)) throw new Error(`the quota line: ${line}`);
    });
    await check('only the owner sees Settings, Drain and Retire: R-1 and R-3 show them, R-2 does not', async () => {
      for (const [id, expected] of [
        ['R-1', ['Settings', 'Drain', 'Retire']],
        ['R-2', []],
        ['R-3', ['Settings', 'Drain', 'Retire']],
      ] as const) {
        const buttons = await card(id).locator('.runner-actions .actions button').allTextContents();
        if (buttons.join(',') !== expected.join(',')) throw new Error(`${id} shows ${buttons.join(', ') || 'no controls'}`);
      }
    });
    await check("the owner raises R-1's capacity from 3 to 4, and the card shows 4", async () => {
      await card('R-1').locator('button:text-is("Settings")').click();
      const capacity = card('R-1').locator('.runner-settings input[type=number] >> nth=0');
      if ((await capacity.inputValue()) !== '3') throw new Error(`the form says ${await capacity.inputValue()}`);
      await capacity.fill('4');
      await card('R-1').locator('button:text-is("Save settings")').click();
      await card('R-1').locator('.runner-settings').waitFor({ state: 'detached' });
      await card('R-1').locator('.fact', { hasText: /\d of 4 slots free/ }).waitFor();
    });
    await check('Drain marks R-1 draining, and Undrain clears it', async () => {
      await card('R-1').locator('button:text-is("Drain")').click();
      await card('R-1').locator('.runner-why', { hasText: 'Draining' }).waitFor();
      await card('R-1').locator('button:text-is("Undrain")').click();
      await card('R-1').locator('button:text-is("Drain")').waitFor();
      await card('R-1').locator('.runner-why', { hasText: 'Draining' }).waitFor({ state: 'detached' });
    });
    await shot(page, 'runners');
    await check('retiring the offline R-3 asks first, then its card goes', async () => {
      await card('R-3').locator('button:text-is("Retire")').click();
      const confirm = card('R-3').locator('.retire-confirm');
      const text = (await confirm.textContent()) ?? '';
      for (const part of ['end lost', 'back to ready', 'submitted tasks keep their status']) {
        if (!text.includes(part)) throw new Error(`the question lacks "${part}": ${text}`);
      }
      await confirm.locator('button:text-is("Retire R-3")').click();
      await waitForCount(page.locator('.runner-card'), 2);
      await page.locator('.strip .readout', { hasText: /^Runners\s*1\/2\s*online$/ }).waitFor();
    });

    /** The Approvals item's badge. */
    const approvalsBadge = page.locator('.nav a[href="#/approvals"] .badge');
    await check('the Approvals item shows a badge with 2', async () => {
      await approvalsBadge.filter({ hasText: /^2$/ }).waitFor();
    });
    await open(page, '#/approvals', '.approval-card');
    const request = (summary: string) => page.locator('.approval-card', { hasText: summary });
    const install = request('Install the Stripe SDK');
    const fixtures = request('Add signed sample payloads');
    await check('the npm install request shows the command, cwd, reason, warning, package.json diff and time left', async () => {
      await waitForCount(page.locator('.approval-card'), 2);
      const command = (await install.locator('.approval-command').textContent()) ?? '';
      if (command !== 'npm install stripe@^18.2.0') throw new Error(`the command reads ${command}`);
      const text = (await install.textContent()) ?? '';
      const parts = [
        /\/Users\/demo\/\.agflow\/work\/T-8-a\d+/,
        'The signature check uses stripe.webhooks.constructEvent',
        'Approving runs this command outside the sandbox, with network access and write access to all your files',
        'T-8',
        'R-1',
      ];
      const missing = parts.filter((part) => (typeof part === 'string' ? !text.includes(part) : !part.test(text)));
      if (missing.length > 0) throw new Error(`it lacks ${missing.join(', ')}`);
      await install.locator('.diff-add', { hasText: '"stripe": "^18.2.0"' }).first().waitFor();
      await install.locator('.diff-same', { hasText: 'package.json' }).first().waitFor();
      const left = (await install.locator('.approval-left').textContent()) ?? '';
      if (!/^\d+ (min|h)/.test(left) || !left.endsWith('left')) throw new Error(`the time left reads ${left}`);
    });
    /** The signed-in person's approvals in one status, as the hub recorded them. */
    const recorded = (status: string) =>
      page.evaluate<{ summary: string; decidedBy: string | null }[]>(
        `fetch('/api/approvals?status=${status}').then((response) => response.json()).then(({ approvals }) => approvals)`,
      );
    const holds = (list: { summary: string }[], summary: string) => list.some((entry) => entry.summary.includes(summary));
    await check('the file change shows its grant-root warning; declining it records a decline, and the badge shows 1', async () => {
      const warnings = (await fixtures.locator('.approval-warnings').textContent()) ?? '';
      if (!warnings.includes('write anywhere under this root') || !warnings.includes('/Users/demo/code/acme-fixtures')) {
        throw new Error(`the warnings: ${warnings}`);
      }
      // Decline is the default action.
      await fixtures.locator('button.primary:text-is("Decline")').click();
      await waitForCount(page.locator('.approval-card'), 1);
      await approvalsBadge.filter({ hasText: /^1$/ }).waitFor();
      const declined = await recorded('declined');
      const entry = declined.find((approval) => approval.summary.includes('Add signed sample payloads'));
      if (entry?.decidedBy !== 'user:demo') throw new Error(`the hub records ${JSON.stringify(declined)}`);
    });
    // Every decision the page sends, to prove that a click sent none.
    const decisions: string[] = [];
    page.on('request', (sent) => {
      if (sent.method() === 'POST' && sent.url().includes('/api/approvals/')) decisions.push(sent.url());
    });
    await check('a double-click on Approve… does not approve the command', async () => {
      await install.locator('button:text-is("Approve…")').dblclick();
      await install.locator('button:text-is("Approve and let it run")').waitFor();
      if (decisions.length > 0) throw new Error(`the page sent ${decisions.join(', ')}`);
      if (!holds(await recorded('pending'), 'Install the Stripe SDK')) throw new Error('the hub no longer has it pending');
      await install.locator('button:text-is("Keep")').click();
    });
    await check('approving the command needs a second click; then the hub records it, and the badge is gone', async () => {
      await install.locator('button:text-is("Approve…")').click();
      await install.locator('button:text-is("Approve and let it run")').waitFor();
      if (decisions.length > 0) throw new Error(`one click sent ${decisions.join(', ')}`);
      if (!holds(await recorded('pending'), 'Install the Stripe SDK')) throw new Error('one click approved it');
      await install.locator('button:text-is("Approve and let it run")').click();
      await page.locator('.empty-title', { hasText: 'No approvals waiting' }).waitFor();
      await approvalsBadge.waitFor({ state: 'detached' });
      if (!holds(await recorded('approved'), 'Install the Stripe SDK')) throw new Error('the hub has not recorded the approval');
      if (holds(await recorded('declined'), 'Install the Stripe SDK')) throw new Error('the hub recorded a decline');
    });
    await shot(page, 'approvals');

    await open(page, '#/timeline', '.log');
    await check('live events arrive without reloading', () => page.locator('.log-row.fresh').first().waitFor({ timeout: 12_000 }));
    await shot(page, 'timeline');

    await open(page, '#/goal', '.charter-text');
    await check('pausing shows a banner, and resuming from it removes the banner', async () => {
      await page.click('button:has-text("Pause everything")');
      await page.click('button:has-text("Pause all work")');
      await page.locator('.banner.warn').waitFor();
      await page.click('.banner.warn button:has-text("Resume")');
      await page.locator('.banner.warn').waitFor({ state: 'detached' });
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, '#/board', '.board');
    await check('the layout fits a phone screen', async () => {
      const width = await page.evaluate<number>('document.documentElement.scrollWidth');
      if (width > 390) throw new Error(`the page is ${width}px wide`);
    });
    await shot(page, 'phone-board');
    await page.setViewportSize({ width: 1440, height: 900 });

    await check('signing out shows the sign-in page', async () => {
      await page.click('button:has-text("Sign out")');
      await page.locator('input[autocomplete=username]').waitFor();
    });

    await check('no errors in the page', async () => {
      const errors = [...(await page.evaluate<string[]>('window.__agflowErrors')), ...consoleErrors];
      if (errors.length > 0) throw new Error(errors.join(' | '));
    });
  } finally {
    await browser.close();
  }
}

try {
  await main();
} finally {
  hub.kill();
}
console.log(`\nScreenshots: ${shots}`);
if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('UI check passed');
