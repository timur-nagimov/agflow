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
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Vendor } from '../packages/core/src/types';
import { type Cluster, startCluster } from '../packages/testkit/src/harness/cluster';
import { E2E_PLATFORM } from '../packages/testkit/src/harness/env';
import { processesInDir } from '../packages/testkit/src/harness/proc';
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
    const answer = prompt("After step 2: did the local command resume the agent's session, with its earlier conversation? [y/n]");
    const resumed = answer?.trim().toLowerCase().startsWith('y') ?? false;
    const inside = prompt('Did you commit b.txt from inside that session (not outside it)? [y/n]');
    const committedInSession = inside?.trim().toLowerCase().startsWith('y') ?? false;
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
    return { resumed, committedInSession };
  },
};

/**
 * The expect(1) program the unattended person runs: it resumes the session with the local command in a real pseudo-TTY,
 * accepts a folder-trust prompt, waits until the agent's earlier conversation (its own words about b.txt) is on the
 * screen, commits b.txt with a `!` shell line from inside the session, then leaves it. Exit 0 when the conversation
 * showed; 2 when it never did; 4 when the command ended first.
 */
const RESUME_EXPECT = String.raw`
set timeout 120
set stty_init "rows 50 cols 160"
log_user 0
log_file -a -noappend $env(AGFLOW_PERSON_LOG)
set vendor $env(AGFLOW_PERSON_VENDOR)
set trusted 0
spawn sh -c $env(AGFLOW_PERSON_LOCAL)
expect {
  -ex "\x1b\[?u" { send -- "\x1b\[?0u"; exp_continue }
  -ex "\x1b\[>0q" { send -- "\x1bP>|xterm(370)\x1b\\"; exp_continue }
  -ex "\x1b\[6n" { send -- "\x1b\[1;1R"; exp_continue }
  -ex "\x1b\[c" { send -- "\x1b\[?62;22c"; exp_continue }
  -re {[Cc]hoose.{0,40}text.{0,40}style} { sleep 2; send "\r"; exp_continue }
  -re {[Tt]rust.{0,24}this.{0,24}folder|[Dd]o.{0,24}you.{0,24}trust|one.{0,24}you.{0,24}trust} {
    if {!$trusted} {
      set trusted 1
      sleep 2
      if {$vendor eq "claude"} { send -- "\x1b\[B"; sleep 1 }
      send "\r"
    }
    exp_continue
  }
  -re {[Ss]tart.{0,24}on.{0,24}task|takes.{0,24}the.{0,24}task.{0,24}over|b\.txt} {}
  timeout { exit 2 }
  eof { exit 4 }
}
set timeout 8
expect {
  -re {[Tt]rust.{0,24}this.{0,24}folder} { if {!$trusted} { set trusted 1; sleep 2; send "\r" }; exp_continue }
  -re {.} { exp_continue }
  timeout {}
  eof { exit 4 }
}
set timeout 120
if {$vendor eq "claude"} {
  # Claude Code runs a line that starts with ! as a shell command in the resumed session.
  send "!"
  sleep 1
  send "git add b.txt && git commit -m 'Add b.txt'"
} else {
  # Codex's ! shell mode does not submit from a pseudo-TTY here, so ask the agent, as the runbook allows; it runs git
  # inside the same workspace-write sandbox, with the clone's .git writable through the take-over command.
  send "Commit b.txt now: run git add b.txt && git commit -m 'Add b.txt'. Do nothing else."
}
sleep 2
send "\r"
set timeout 180
# The new commit's summary line, "[<branch> <sha>] Add b.txt", not the earlier history's commits.
expect { -re {\].{0,40}Add.{0,24}b\.txt} { sleep 3 } timeout {} eof { exit 4 } }
if {$vendor eq "claude"} { send "/exit\r" } else { send "\x03"; sleep 1; send "\x03" }
expect { eof {} timeout { send "\x03"; sleep 1; send "\x03"; expect { eof {} timeout {} } } }
exit 0
`;

/**
 * A fresh terminal's environment for the person's commands: none of the variables of whatever started this script
 * (for example an agent session's CLAUDE_CODE_* markers, which make Claude Code treat the resume as a child session).
 */
function freshTerminalEnv(): Record<string, string> {
  const keep = ['HOME', 'USER', 'LOGNAME', 'SHELL', 'PATH', 'LANG', 'TMPDIR', 'SSH_AUTH_SOCK', 'NODE_EXTRA_CA_CERTS',
    'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy'];
  const env: Record<string, string> = { TERM: 'xterm-256color' };
  for (const name of keep) if (process.env[name]) env[name] = process.env[name] as string;
  return env;
}

async function gitOut(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim();
}

/**
 * The take-over check's person without anyone at the computer (AGFLOW_LIVE_AUTO_PERSON=1): the browser's Take over
 * and Hand back through the API as the cluster's person, and the terminal part driven by expect(1) in a pseudo-TTY.
 * resumed is true only when the resumed session showed the agent's earlier conversation and the commit came from it;
 * otherwise it commits with plain git so the hand-back can still be checked, and reports resumed false.
 */
const AUTO_PERSON: TakeoverPerson = {
  async takeOver({ cluster, taskId, attemptId }) {
    say(`Unattended person: taking ${taskId} over (${attemptId}) through the API as ${cluster.person.login}.`);
    await cluster.person.takeover(taskId);
    await cluster.waitFor(
      `${taskId} to be taken over`,
      async () => (await cluster.person.task(taskId)).task.blockedKind === 'takeover',
      { timeoutMs: PERSON_WAIT_MS },
    );
  },
  async handBack({ cluster, taskId, attemptId, clone, local }) {
    const vendor: Vendor = local.includes('CLAUDE_CONFIG_DIR') ? 'claude' : 'codex';
    const dir = mkdtempSync('/tmp/agflow-person-');
    const program = join(dir, 'resume.exp');
    const log = join(dir, 'session.log');
    writeFileSync(program, RESUME_EXPECT);
    say(`Unattended person: resuming ${attemptId} in a pseudo-TTY with the local command (log ${log}):`);
    say(`  ( ${local} )`);
    const before = await gitOut(clone, ['rev-parse', 'HEAD']);
    const run = Bun.spawn(['/usr/bin/expect', '-f', program], {
      env: { ...freshTerminalEnv(), AGFLOW_PERSON_LOCAL: `( ${local} )`, AGFLOW_PERSON_LOG: log, AGFLOW_PERSON_VENDOR: vendor },
      stdout: 'ignore',
      stderr: 'pipe',
    });
    const code = await run.exited;
    const shown = code === 0;
    const subject = await gitOut(clone, ['log', '-1', '--format=%s']);
    const fromSession = (await gitOut(clone, ['rev-parse', 'HEAD'])) !== before && subject === 'Add b.txt';
    say(
      `Unattended person: expect exit ${code}; earlier conversation ${shown ? 'shown' : 'NOT shown'}; ` +
        `commit from the session ${fromSession ? 'made' : 'NOT made'}.`,
    );
    if (!shown && existsSync(log)) say(readFileSync(log, 'utf8').slice(-1500));
    if (!fromSession) {
      await gitOut(clone, ['add', 'b.txt']);
      await gitOut(clone, ['commit', '-q', '-m', 'Add b.txt']);
      say('Unattended person: committed b.txt with plain git instead.');
    }
    // The runner refuses a hand-back while a process runs in the clone: end what the session left behind.
    for (let tries = 0; tries < 3; tries++) {
      for (const row of await processesInDir(clone)) {
        try {
          process.kill(row.pid, 'SIGTERM');
        } catch {}
      }
      say(`Unattended person: handing ${taskId} back from the clone.`);
      await cluster.person.handback(taskId, 'clone');
      const done = await cluster
        .waitFor(
          `${taskId} to be handed back`,
          async () => (await cluster.person.task(taskId)).task.blockedKind !== 'takeover' ||
            (await cluster.person.attempt(attemptId)).attempt.takeover?.error != null,
          { timeoutMs: 120_000 },
        )
        .then(async () => (await cluster.person.task(taskId)).task.blockedKind !== 'takeover');
      if (done) break;
      say(`The runner refused the hand-back: ${(await cluster.person.attempt(attemptId)).attempt.takeover?.error}`);
    }
    return { resumed: shown, committedInSession: fromSession };
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
    const auto = process.env.AGFLOW_LIVE_AUTO_PERSON === '1';
    const person = auto ? AUTO_PERSON : TERMINAL_PERSON;
    const run = (cluster: Cluster) => runTakeoverCheck(cluster, person, { scripted: false });
    const ready = auto
      ? undefined
      : () => confirmTakeoverReady(vendor, { isTTY: process.stdin.isTTY === true, log: say, ask: prompt });
    results.push(
      ...(await inLiveCluster('take-over check', vendor, () => startCluster(options), args.keep, run, say, ready)),
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
