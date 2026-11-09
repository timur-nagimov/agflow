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
      await page.waitForURL(/#\/task\/T-11$/);
      await waitForCount(page.locator('.criteria li'), 2);
    });
    await shot(page, 'new-task');

    await open(page, '#/goal', '.charter-text');
    await check('opening the goal clears the badge for messages to people', () =>
      page.locator('.nav .badge').waitFor({ state: 'detached' }),
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
