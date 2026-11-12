/**
 * The M2 live run (design 1, 15, X-43): the exit scenarios once with real subscriptions, and the TTY check of a
 * take-over. See docs/m2-live-run.md.
 *
 *   bun run build:web && bun run live-run [--runners claude,codex] [--scenarios ...] [--takeover claude,codex]
 *
 * Each scenario runs in a cluster of its own: a local dev hub that serves the web UI with short test timings, the toy
 * repository (a local bare origin, or the throwaway remote of --repo) and three runners on the person's runner vendor
 * homes, logged in once by `agflow runner setup`. Before anything starts, the script confirms each vendor home's login
 * with the vendor CLI's status command, which sends no prompt. It prints a results table and writes results.json and
 * results.md; it exits 0 only when every check passed.
 */
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Vendor } from '../packages/core/src/types';
import { type Cluster, startCluster } from '../packages/testkit/src/harness/cluster';
import { E2E_PLATFORM } from '../packages/testkit/src/harness/env';
import {
  checkVendorHome,
  confirmTakeoverReady,
  formatResults,
  inLiveCluster,
  type LiveArgs,
  liveClusterOptions,
  liveUsage,
  parseLiveArgs,
  runLiveScenario,
  runTakeoverCheck,
  type TakeoverPerson,
} from '../packages/testkit/src/live';
import type { ScenarioResult } from '../packages/testkit/src/scenarios/result';
import { TAKEOVER } from '../packages/testkit/src/scenarios/takeover';

const WEB_DIST = join(import.meta.dir, '../packages/web/dist');

/** How long the person has for each of their take-over steps. */
const PERSON_WAIT_MS = 30 * 60_000;

function say(line = ''): void {
  process.stdout.write(`${line}\n`);
}

/** The dev hub's sign-in as the cluster's person, which then opens the task page. */
function signInUrl(cluster: Cluster, taskId: string): string {
  const returnTo = encodeURIComponent(`/#/task/${taskId}`);
  return `${cluster.hub.url}/auth/dev?user=${encodeURIComponent(cluster.person.login)}&returnTo=${returnTo}`;
}

/** The person of the take-over check, at this terminal and a browser. */
const TERMINAL_PERSON: TakeoverPerson = {
  async takeOver({ cluster, taskId, attemptId }) {
    say();
    say(`The take-over check: ${attemptId} runs \`${TAKEOVER.longCommand}\`, which ends 10 minutes after it started.`);
    const { attempt } = await cluster.person.attempt(attemptId);
    // The heartbeat reports awake age of the original command, including every exec-session poll.
    const ageMs = attempt.facts?.tool?.ageMs ?? 0;
    const remainingMs = Math.max(0, 600_000 - ageMs);
    say(
      `Window closes approximately ${new Date(Date.now() + remainingMs).toLocaleTimeString()} ` +
        `(${Math.ceil(remainingMs / 1000)} seconds remaining).`,
    );
    say('In a browser, open');
    say(`  ${signInUrl(cluster, taskId)}`);
    say(`and press Take over on ${taskId} before that command ends. Waiting for it...`);
    await cluster.waitFor(
      `${taskId} to be taken over`,
      async () => (await cluster.person.task(taskId)).task.blockedKind === 'takeover',
      { timeoutMs: PERSON_WAIT_MS },
    );
  },
  async handBack({ cluster, taskId, attemptId, clone, local }) {
    say();
    say(`${attemptId} is taken over, and the runner handed its clone over: ${clone}. Now:`);
    say('  1. In another terminal, resume the agent session with the local command. The parentheses run it in a');
    say('     subshell, so the terminal does not stay in the clone afterwards:');
    say(`       ( ${local} )`);
    say("     Check that it shows the agent's earlier conversation.");
    say("  2. From inside the resumed session, commit the agent's uncommitted b.txt: type");
    say("       !git add b.txt && git commit -m 'Add b.txt'");
    say('     (a line that starts with ! runs as a shell command in Claude Code and in Codex), or ask the agent to');
    say('     commit it. Then exit the session. If the session did not resume, commit outside it instead:');
    say(`       git -C ${clone} add b.txt && git -C ${clone} commit -m 'Add b.txt'`);
    say('  3. Leave the clone in every terminal and close any editor open in it: the runner refuses a hand-back');
    say('     while a process runs there.');
    say(`  4. In the browser, press Hand back on ${taskId} and choose the clone.`);
    const question = "After step 2: did the local command resume the agent's session, and did you commit from it?";
    const answer = prompt(`${question} [y/n]`);
    const resumed = answer?.trim().toLowerCase().startsWith('y') ?? false;
    say('Waiting for the hand-back...');
    let refused: string | null = null;
    await cluster.waitFor(
      `${taskId} to be handed back`,
      async () => {
        const { task } = await cluster.person.task(taskId);
        if (task.blockedKind !== 'takeover') return true;
        // A refused hand-back leaves the task taken over, with the runner's reason on the attempt.
        const error = (await cluster.person.attempt(attemptId)).attempt.takeover?.error ?? null;
        if (error !== null && error !== refused) {
          say(`The runner refused the hand-back: ${error}`);
          say('End those processes, leave the clone, and press Hand back again.');
        }
        refused = error;
        return false;
      },
      { timeoutMs: PERSON_WAIT_MS },
    );
    return { resumed };
  },
};

async function main(argv: string[]): Promise<number> {
  let args: LiveArgs;
  try {
    args = parseLiveArgs(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${liveUsage()}`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(liveUsage());
    return 0;
  }

  // Every vendor home the run uses must be logged in before anything starts.
  const vendors = [...new Set<Vendor>([...(args.scenarios.length ? args.runners : []), ...args.takeover])];
  say("Checking the runners' vendor homes (a status command each; no prompt is sent)...");
  const homes = await Promise.all(vendors.map((vendor) => checkVendorHome(vendor, args, { platform: E2E_PLATFORM })));
  const missing = homes.filter((home) => !home.ok);
  for (const home of homes) say(`  ${home.vendor}: ${home.detail} (${home.home})`);
  if (missing.length > 0) {
    for (const home of missing) {
      say(
        `${home.vendor}: ${home.detail}. Log the runner's ${home.vendor} home in with \`agflow runner setup\` ` +
          `(\`--relogin\` repeats the logins), or name a logged-in home with --${home.vendor}-home.`,
      );
    }
    return 1;
  }
  if (!existsSync(join(WEB_DIST, 'index.html'))) {
    say(`The take-over check needs the web UI in ${WEB_DIST}: run \`bun run build:web\` first.`);
    return 1;
  }

  const out = mkdtempSync('/tmp/agflow-live-');
  const results: ScenarioResult[] = [];
  /** Written after every cluster, so an interrupted run keeps what finished. */
  const save = () => {
    const { markdown, json } = formatResults(results);
    writeFileSync(join(out, 'results.md'), markdown);
    writeFileSync(join(out, 'results.json'), `${JSON.stringify(json, null, 2)}\n`);
    return markdown;
  };
  for (const vendor of args.runners) {
    for (const scenario of args.scenarios) {
      const options = { ...liveClusterOptions(args, vendor, scenario), webDist: WEB_DIST };
      const run = async (cluster: Cluster) => [await runLiveScenario(cluster, scenario)];
      results.push(...(await inLiveCluster(scenario, vendor, () => startCluster(options), args.keep, run, say)));
      save();
    }
  }
  // The TTY check of each vendor's take-over commands (design 15), a cluster each.
  for (const vendor of args.takeover) {
    const options = { ...liveClusterOptions(args, vendor, 'takeover'), webDist: WEB_DIST };
    const run = (cluster: Cluster) => runTakeoverCheck(cluster, TERMINAL_PERSON, { scripted: false });
    results.push(
      ...(await inLiveCluster('take-over check', vendor, () => startCluster(options), args.keep, run, say, () =>
        confirmTakeoverReady(vendor, { isTTY: process.stdin.isTTY === true, log: say, ask: prompt }),
      )),
    );
    save();
  }
  const markdown = save();
  say();
  say(markdown);
  say(`Results: ${join(out, 'results.md')} and ${join(out, 'results.json')}`);
  say('Copy the table into the Results section of docs/m2-live-run.md and into the PR.');
  return formatResults(results).json.passed ? 0 : 1;
}

process.exit(await main(process.argv.slice(2)));
