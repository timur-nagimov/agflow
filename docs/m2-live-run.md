# M2 live run

M2's exit criteria ([design section 1](superpowers/specs/2026-10-28-m2-runners-design.md#1-goal-and-exit-criteria))
must pass once with real subscriptions, not only against the scripted model servers of `bun run e2e`. This runbook
covers that run and the TTY check of the take-over commands (design 6.12 and 15). Record the outcome in
[Results](#results) and in the PR.

The run uses real Claude and Codex quota. Each scenario runs a handful of agent turns, and every scenario runs once
per vendor.

## What the run does

`bun run live-run` (`scripts/live-run.ts`) runs each chosen scenario once per chosen vendor, in a fresh cluster each
time. A cluster has:

- a local dev hub (`packages/hub/src/main.ts` in hub test mode, with the e2e timings) that serves the web UI;
- the toy repository: a word-count CLI with its test and one research note, on main of a local bare origin, or of the
  throwaway remote given with `--repo`;
- three runners, owned by alice, bob and carol. Each runs `agflow runner start` with its own `AGFLOW_HOME` under
  `/tmp/agf-e2e-*`, and all three offer only the cluster's vendor.

Every runner's runner.json points at the same logged-in runner vendor homes, the ones `agflow runner setup` created
(`~/.agflow/runner/homes/claude` and `~/.agflow/runner/homes/codex` by default), and links the pinned binaries setup
installed under `~/.agflow/runner/vendor/`. Its test block holds only `allowShortTimings`, so preflight checks the
real logins. It records the proxy and certificate variables (`HTTPS_PROXY`, `NODE_EXTRA_CA_CERTS` and the rest) that
setup recorded in your runner.json, and each runner process gets them, as your LaunchAgent gives them to your runner;
without a runner.json there are none. The runners get your `HOME` and SSH agent, as in production, so their git
reaches a `--repo` remote with your credentials. Your own runner.json, runner database and LaunchAgent are not
touched.

The scenarios are the e2e drivers, run with real models. The models follow the task texts, which spell out every
file and command the drivers wait for:

- `killed-agent`: a worker commits a.txt, writes its handoff note, leaves b.txt uncommitted and runs a long command.
  The script kills the agent's process group. A new attempt on another runner finishes the task from the final WIP
  and the note.
- `closed-laptop`: a worker commits a.txt and keeps rewriting tick.txt. The script freezes its runner and everything
  under it (SIGSTOP) until the runner lease runs out. The task finishes on another runner, and after the thaw the
  late work is recorded and merged.
- `lost-lead`: with runner leads on, the script freezes the lead's runner. A new lead starts from the lead handoff,
  receives a message sent during the freeze, and accepts a submission that arrives afterwards.

Before anything starts, the script runs each vendor home's status command (`claude auth status --json`,
`codex login status`), which sends no prompt. A missing or logged-out home stops the run there.

## Before the run

1. Use a Mac with Apple silicon, on AC power: the pinned binaries exist only for `darwin-arm64`. The script runs
   under `caffeinate -i`.
2. Run `agflow runner setup` once, as for normal use: it installs the pinned Claude and Codex binaries and logs both
   vendors in to the runner's own homes. `agflow runner setup --relogin` repeats the logins.
3. If your own runner is running, `agflow runner stop` keeps it from spending the same quota during the run.
4. Install dependencies and build the web UI: `bun install && bun run build:web`. The take-over check uses the task
   page's Take over and Hand back actions.
5. For a run against a real git host, create an empty private repository (on GitHub, say) and pass its URL with
   `--repo`. Each cluster resets that repository: main becomes one commit holding the toy repository, and every other
   ref is deleted. The script refuses a repository with refs other than main and agflow's own, or a main that no
   live run made.

## Running

The exit run is every scenario with both vendors, then the TTY check of both vendors' take-over commands:

```sh
bun run live-run --takeover claude,codex
```

Other runs, to repeat a part:

```sh
bun run live-run                                   # every scenario, both vendors, no take-over check
bun run live-run --runners claude --scenarios killed-agent
bun run live-run --scenarios none --takeover codex # only the Codex take-over check
bun run live-run --takeover codex                  # the scenarios, then the take-over check with Codex only
bun run live-run --repo git@github.com:you/agflow-live-toy.git --takeover claude,codex --keep
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--claude-home <dir>` | runner.json's Claude home, else `~/.agflow/runner/homes/claude` | The runners' `CLAUDE_CONFIG_DIR`, logged in by setup. Pass the exact path setup used: Claude's login keychain item depends on it. |
| `--codex-home <dir>` | runner.json's Codex home, else `~/.agflow/runner/homes/codex` | The runners' `CODEX_HOME`, logged in by setup. |
| `--runners <vendors>` | `claude,codex` | The vendor every runner of a cluster offers; each scenario runs once per vendor. |
| `--scenarios <names>` | `killed-agent,closed-laptop,lost-lead` | The scenarios to run, in that order; `none` skips them for a take-over-only run. |
| `--repo <url>` | a local bare origin | A throwaway remote, reset by each cluster (see above). |
| `--takeover <vendors>` | off | After the scenarios, the take-over check once per vendor named: `claude`, `codex` or `claude,codex`, as the exit run needs. |
| `--keep` | off | Keep every cluster's files; a failed cluster's files are always kept. |
| `--help` | | Print the options and exit. |

`AGFLOW_HOME` changes where the defaults and the pinned binaries are looked up, as it does for the runner.

## The take-over check

With `--takeover <vendors>`, the script explains the check and waits for Enter in a TTY **before each cluster starts**
(type `q` and Enter to skip that vendor's cluster; Ctrl-C ends the run).
Be ready with a browser and another terminal. The scripted e2e path stays non-interactive.
The script starts one more cluster per vendor, waits until the take-over task's agent
runs its long command (`sleep 600`), and then walks you through the check:

1. Open the sign-in link it prints, which signs you in to the dev hub as alice and opens the task page, and press
   Take over. The window lasts 10 minutes from the command's start; the script prints its approximate closing time
   and seconds remaining.
2. Once the runner has handed the clone over, the script prints the local command, of the form
   `( cd <clone> && CLAUDE_CONFIG_DIR=<home> <pinned claude> --resume <session> )`, or the `codex resume --no-daemon -s workspace-write -c 'sandbox_workspace_write.writable_roots=["<clone>/.git"]'`
   one. The parentheses run it in a subshell, so your terminal does not stay in the clone. Run it in another
   terminal and check that it shows the agent's earlier conversation.
3. From inside the resumed session, commit the agent's uncommitted b.txt: type
   `!git add b.txt && git commit -m 'Add b.txt'` (a line that starts with `!` runs as a shell command in Claude Code
   and in Codex), or ask the agent to commit it. The Codex command gives the session the clone's `.git` as a writable
   root (Codex protects `.git` in its workspace-write sandbox otherwise), so the commit works from inside it too. Then
   exit the session and answer the script's two questions: whether the session resumed with its earlier conversation,
   and whether you committed from inside it. If the session did not resume, commit outside it with
   `git -C <clone> add b.txt && git -C <clone> commit -m 'Add b.txt'`.
4. Leave the clone in every terminal and close any editor open in it: the runner refuses a hand-back while a process
   runs in the clone. Then, in the browser, press Hand back and choose the clone. If the runner refuses, the script
   prints its reason (`process_running` with the process ids); end those processes and press Hand back again.

**Unattended.** `AGFLOW_LIVE_AUTO_PERSON=1 bun run live-run --scenarios none --takeover claude,codex` runs the check
with no one at the computer: Take over and Hand back go through the API as the cluster's person, and the local command
runs in a pseudo-terminal driven by `expect(1)` (`/usr/bin/expect` on macOS). It answers the CLI's first-run screens
(theme, folder trust), checks that the resumed session shows the agent's earlier conversation, and commits b.txt from
inside it (Claude: a `!` shell line; Codex: it asks the agent, because Codex's `!` shell mode does not submit from a
pseudo-terminal). When that commit does not land, it commits outside the session and reports so in the check's detail.
Start it from a plain terminal: inside an agent session, inherited `CLAUDE_CODE_*` variables make Claude Code treat the
resume as a child session.

The script hands you the clone only when the runner handed it over: the attempt ended taken over with no take-over
error, and the clone's `.git` is the runner's new one. Otherwise the agent's own `.git` may still be in the clone, and
git there would run whatever the agent planted in it with your rights. The check then fails with the runner's error,
and the script asks you for nothing; do not work in that clone.

The script then applies the take-over scenario's checks (`takeoverChecks` and `handbackChecks` in
`packages/testkit/src/scenarios/takeover.ts`). They check that the attempt ended taken over and that the commands use
the attempt's CLI version, the clone's new `.git` and its index, the hand-back, and that the next attempt starts from
your commit and submits c.txt on top of it. The e2e suite runs the same check with a stand-in person
(`packages/testkit/e2e/live-takeover.e2e.test.ts`).

## Optional: a real lid close

SIGSTOP only approximates a closed lid: the network stays up and other apps keep running. To try the real thing, set
up a runner on a second Mac against a hub both Macs reach, start a task on it, and close its lid for longer than the
runner lease. Then check that the task finishes on another runner and that, once the lid is open again, its late work
shows on the task page. Note what you saw under Results.

## Reading the results

The script prints a table of every check, with its scenario and vendor, result and detail. It also writes the table
to `results.md` and the same rows to `results.json`, in a `/tmp/agflow-live-*` directory whose path it prints, after
every cluster, so an interrupted run keeps what finished. It exits 0 only when every check passed.

A failed check names what the driver saw. A scenario that could not go on fails "the scenario ran to its end", with
the error and a dump of the cluster: attempts, runners, recent events and log tails. A cluster that did not start, or
did not close cleanly, adds a failed row of its own, and the run goes on with the next cluster. The cluster's files stay in
`/tmp/agf-e2e-*`. Before removing them, make the agent tool directories writable:
`chmod -R u+w /tmp/agf-e2e-<id> && rm -rf /tmp/agf-e2e-<id>`. Claude attempts that were killed may leave
`/tmp/agf/<id>` directories behind.

## Results

| Date | Commit | Vendors | Scenarios | Take-over check (Claude) | Take-over check (Codex) | Lid close | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-11-12 | 1e645f9 (branch m2-live-fixes) | Claude Code 2.1.285 (Claude Ultra), Codex 0.159.2 (ChatGPT) | killed-agent, closed-laptop, lost-lead | passed: resumed with its conversation, committed from the session | passed: resumed with its conversation; committed outside the session (unattended run, see below) | not tried | 116 of 116 checks passed |

The take-over checks ran unattended (`AGFLOW_LIVE_AUTO_PERSON=1`). In the Codex session the unattended person's request
did not reach the agent from the pseudo-terminal, so it committed outside the session; that the take-over command lets
a Codex session commit was checked separately in the same workspace-write sandbox (`codex exec` with and without the
command's writable root: without it git fails on `.git/index.lock`, with it the commit lands).

Earlier live runs the same day, on main and on this branch before its last commits, found what this branch fixes: a
runner lead could not fetch a submission from another runner's worker (now `fetch_submission`); after a killed agent
whose work was already pushed, the runner reported the wrong final commit, so the replacement stayed on the same runner
and started from a snapshot; a Codex agent polling a long command was ended as `stall_loop` (as was a Claude
background-output poll); the lost-lead driver expected the worker's exit after the acceptance; a bare Enter at the
take-over prompt read as a cancel; and a resumed Codex session could not commit.

| Scenario | Check | Result | Detail |
| --- | --- | --- | --- |
| killed agent (claude) | when the hub records a1 ended, no process has its cwd in its clone | passed | agent 43309 killed; nothing ran in /private/tmp/agf-e2e-4bCShL/alice/agflow/work/e2e-0decafa9ed/T-1-a1 at event #14 |
| killed agent (claude) | a1 ends crashed, class infra | passed | ["crashed","infra"] |
| killed agent (claude) | a1's final WIP ref on origin equals the hub's wipSha | passed | hub refs/agflow/T-1/a1 at 8a719f751254edd9b8c2304ee63cff0d15430136, origin at 8a719f751254edd9b8c2304ee63cff0d15430136 |
| killed agent (claude) | the final WIP holds a.txt from a commit under the snapshot | passed | {"a":"a\n","b":null} |
| killed agent (claude) | the final WIP holds b.txt from the uncommitted-work snapshot | passed | 8a719f751254edd9b8c2304ee63cff0d15430136 is "agflow: uncommitted work at 2026-11-12T17:32:14.069Z" with b.txt "b\n" |
| killed agent (claude) | a1's own handoff note stands, so the hub assembled none | passed | agent:A-1 in T-1-a1: "a.txt is committed. b.txt is written but not committed yet. Next: add c.txt, commit, and submit." |
| killed agent (claude) | a2 runs on another runner than a1 | passed | a1 on alice-mac (R-1), a2 on bob-mac (R-2) |
| killed agent (claude) | a2 starts from a1's final WIP | passed | "8a719f751254edd9b8c2304ee63cff0d15430136" |
| killed agent (claude) | a2 starts from a1's WIP ref | passed | "refs/agflow/T-1/a1" |
| killed agent (claude) | a2's clone holds a.txt and b.txt before a2 changes anything | passed | {"a":"a\n","b":"b\n"} |
| killed agent (claude) | a2's first text is stored as a restatement note of a2 | passed | agent:A-2: "**State (from the handoff and the branch):** A-1 committed `a.txt`. It wrote `b.txt` but didn't commit it. The latest commit, \"uncommitted work at …\", may have captured it. **Next step:** check what the tree holds, add `c.txt`, commit, and submit." |
| killed agent (claude) | a2 submits a branch holding a.txt, b.txt and c.txt | passed | {"head":"44ab68bc426a0fd8a03e24076b2c770fb4d8a345","a":"a\n","b":"b\n","c":"c\n"} |
| killed agent (claude) | the person accepts the task, and a2 ends accepted | passed | {"task":"accepted","a2":"accepted"} |
| killed agent (claude) | the scenario ran to its end | passed | 13 checks made |
| closed laptop (claude) | the hub marks a1's frozen runner offline after deadLinkMs, while a1 is still open | passed | offline 4828 ms after the freeze (event #14); a1 ended at #18 |
| closed laptop (claude) | a1 ends lost, class infra, once the runner lease has run out | passed | lost (infra) 29861 ms after the freeze; the lease is 30000 ms |
| closed laptop (claude) | while its runner was frozen, a1 got no stall or stop: only the lease ended it | passed | no stall event and no stop request |
| closed laptop (claude) | the task went stale, then ready | passed | ["task.stale","task.ready"] |
| closed laptop (claude) | a handoff note by system quotes a1's work and says no handoff note was written | passed | 1 note(s); the WIP log "## Commits on the WIP since main (git log --stat), as agent A-1 in attempt T-1-a1 last pushed them\n> commit 5de692e45df76a759943930ed3130db8c33feb99\n> Author: alice <alice@agflow.invalid>\n> Date:   Thu Nov 12 17:33:04 2026 +0000\n>\n>     agflow: uncommitted work at 2026-11-12T17:33:04.797Z\n>\n>  tick.txt \| 1 +\n>  1 file changed, 1 insertion(+)\n>\n> commit 8f204714cc6d3adfee1fd96563c914bd20427e06\n> Author: alice <alice@agflow.invalid>\n> Date:   Thu Nov 12 20:32:55 2026 +0300\n>\n>     Add a.txt\n>     \n>     Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>\n>\n>  a.txt \| 1 +\n>  1 file changed, 1 insertion(+)"; the last ending "No handoff note was written; the next step is unknown. Read the transcript tail and the commits before continuing." |
| closed laptop (claude) | a2 runs on another runner than a1 | passed | a1 on alice-mac (R-1), a2 on bob-mac (R-2) |
| closed laptop (claude) | a2 starts from a1's last recorded WIP | passed | "5de692e45df76a759943930ed3130db8c33feb99" |
| closed laptop (claude) | after the thaw, a1's agent and its tick command are gone | passed | agent 42897 is gone; nothing runs in its clone |
| closed laptop (claude) | origin holds a1's late work on its late-work refs from the first, with a.txt and tick.txt, and any late WIP was harvested before the freeze (no WIP after the clock gap, X-11) | passed | refs/agflow/T-1/a1-late-1 at 85c0fe155d71139f09b35d056c5afd7f9647f262 |
| closed laptop (claude) | a late_work note of a1 names each ref of its late work | passed | "Late work of attempt T-1-a1: runner R-1 pushed 85c0fe155d71139f09b35d056c5afd7f9647f262 to refs/agflow/T-1/a1-late-1 after the attempt ended. Merge it before going on: git fetch origin refs/agflow/T-1/a1-late-1 && git merge FETCH_HEAD" |
| closed laptop (claude) | a2's agent gets the hub's message that names the late work's ref | passed | #3: "Late work for T-1: attempt T-1-a1 pushed 85c0fe155d71139f09b35d056c5afd7f9647f262 to refs/agflow/T-1/a1-late-1 after it ended. Merge it into your branch before you go on: git fetch origin refs/agflow/T-1/a1-late-1 && git merge FETCH_HEAD" |
| closed laptop (claude) | a2 submits a branch that merged the late work: a.txt, the late work's tick.txt and c.txt | passed | {"head":"f8bcab39fc534ca14a4077a397db5f3a1fef7b6e","merged":true,"a":"a\n","tick":"25\n","c":"c\n"} |
| closed laptop (claude) | the person accepts the task, and a2 ends accepted | passed | {"task":"accepted","a2":"accepted"} |
| closed laptop (claude) | the scenario ran to its end | passed | 13 checks made |
| lost lead (claude) | the scheduler seats lead-a1 on a runner, and GET /api/status shows a runner lead in the seat | passed | event #4; seat {"kind":"runner","agentId":"A-1","attemptId":"lead-a1","runnerId":"R-1","since":1794504850864,"wakeups":1,"runnerLeads":true} |
| lost lead (claude) | GET /api/lead/notes lists the lead handoff of lead-a1 | passed | agent:A-1: "The plan: one small task at a time. Review each submission as it arrives, and accept it once its file is in. Nothing is waiting for review now." |
| lost lead (claude) | after the freeze, lead-a1 ends lost, class infra | passed | ["lost","infra"] |
| lost lead (claude) | the seat empties when lead-a1 ends, and the next change seats lead-a2 | passed | [["none",null],["runner","lead-a2"]] |
| lost lead (claude) | lead-a2 takes the seat on another runner than lead-a1 | passed | lead-a1 on R-1, lead-a2 on R-2 (event #16) |
| lost lead (claude) | a worker submits the task created after the failover | passed | {"head":"dd8155fcdebb1fe95634b01823f189995a2fe62a","file":"review\n"} |
| lost lead (claude) | the submission's message to the lead is delivered to lead-a2 | passed | #4 delivered to [{"agentId":"A-2","deliveredAt":1794504917444,"ackedAt":null}] |
| lost lead (claude) | lead-a2 accepts the task with its agent token, as the acceptance event's actor, while it holds the seat | passed | accepted by agent:A-2 at #34; seat changes before it: 0 |
| lost lead (claude) | after the thaw, the old runner stops lead-a1's process | passed | agent 25268 of lead-a1 is gone |
| lost lead (claude) | the old runner pushes no ref for lead-a1: leads have no WIP | passed | events none; refs added or moved none; refs gone none |
| lost lead (claude) | the person's message sent during the freeze is delivered to lead-a2, and after the thaw still not to lead-a1 | passed | #2 delivered to A-2 (agent:A-2); lead-a1's model saw it: false |
| lost lead (claude) | the scenario ran to its end | passed | 11 checks made |
| killed agent (codex) | when the hub records a1 ended, no process has its cwd in its clone | passed | agent 6802 killed; nothing ran in /private/tmp/agf-e2e-L4Un5R/alice/agflow/work/e2e-21f08f99ab/T-1-a1 at event #19 |
| killed agent (codex) | a1 ends crashed, class infra | passed | ["crashed","infra"] |
| killed agent (codex) | a1's final WIP ref on origin equals the hub's wipSha | passed | hub refs/agflow/T-1/a1 at ee78292da4be06284704bb925802074740b94cf6, origin at ee78292da4be06284704bb925802074740b94cf6 |
| killed agent (codex) | the final WIP holds a.txt from a commit under the snapshot | passed | {"a":"a\n","b":null} |
| killed agent (codex) | the final WIP holds b.txt from the uncommitted-work snapshot | passed | ee78292da4be06284704bb925802074740b94cf6 is "agflow: uncommitted work at 2026-11-12T17:36:00.440Z" with b.txt "b\n" |
| killed agent (codex) | a1's own handoff note stands, so the hub assembled none | passed | agent:A-1 in T-1-a1: "a.txt is committed. b.txt is written but not committed yet. Next: add c.txt, commit, and submit." |
| killed agent (codex) | a2 runs on another runner than a1 | passed | a1 on alice-mac (R-1), a2 on bob-mac (R-2) |
| killed agent (codex) | a2 starts from a1's final WIP | passed | "ee78292da4be06284704bb925802074740b94cf6" |
| killed agent (codex) | a2 starts from a1's WIP ref | passed | "refs/agflow/T-1/a1" |
| killed agent (codex) | a2's clone holds a.txt and b.txt before a2 changes anything | passed | {"a":"a\n","b":"b\n"} |
| killed agent (codex) | a2's first text is stored as a restatement note of a2 | passed | agent:A-2: "I’ll read the task contract and branch history, then restate the current state and next step before changing any files." |
| killed agent (codex) | a2 submits a branch holding a.txt, b.txt and c.txt | passed | {"head":"5410d3a419e5d0174b3e93d4b8efb67f4bb9b465","a":"a\n","b":"b\n","c":"c\n"} |
| killed agent (codex) | the person accepts the task, and a2 ends accepted | passed | {"task":"accepted","a2":"accepted"} |
| killed agent (codex) | the scenario ran to its end | passed | 13 checks made |
| closed laptop (codex) | the hub marks a1's frozen runner offline after deadLinkMs, while a1 is still open | passed | offline 5467 ms after the freeze (event #17); a1 ended at #21 |
| closed laptop (codex) | a1 ends lost, class infra, once the runner lease has run out | passed | lost (infra) 30515 ms after the freeze; the lease is 30000 ms |
| closed laptop (codex) | while its runner was frozen, a1 got no stall or stop: only the lease ended it | passed | no stall event and no stop request |
| closed laptop (codex) | the task went stale, then ready | passed | ["task.stale","task.ready"] |
| closed laptop (codex) | a handoff note by system quotes a1's work and says no handoff note was written | passed | 1 note(s); the WIP log "## Commits on the WIP since main (git log --stat), as agent A-1 in attempt T-1-a1 last pushed them\n> commit a7ac652b24176acc156202d5fb113ca8ad88b2af\n> Author: alice <alice@agflow.invalid>\n> Date:   Thu Nov 12 17:37:28 2026 +0000\n>\n>     agflow: uncommitted work at 2026-11-12T17:37:28.044Z\n>\n>  tick.txt \| 1 +\n>  1 file changed, 1 insertion(+)\n>\n> commit cbb9ef10f568dce0b94ebc07e1ee4381351dd6ff\n> Author: alice <alice@agflow.invalid>\n> Date:   Thu Nov 12 20:37:13 2026 +0300\n>\n>     Add a.txt\n>\n>  a.txt \| 1 +\n>  1 file changed, 1 insertion(+)"; the last ending "No handoff note was written; the next step is unknown. Read the transcript tail and the commits before continuing." |
| closed laptop (codex) | a2 runs on another runner than a1 | passed | a1 on alice-mac (R-1), a2 on bob-mac (R-2) |
| closed laptop (codex) | a2 starts from a1's last recorded WIP | passed | "a7ac652b24176acc156202d5fb113ca8ad88b2af" |
| closed laptop (codex) | after the thaw, a1's agent and its tick command are gone | passed | agent 65261 is gone; nothing runs in its clone |
| closed laptop (codex) | origin holds a1's late work on its late-work refs from the first, with a.txt and tick.txt, and any late WIP was harvested before the freeze (no WIP after the clock gap, X-11) | passed | refs/agflow/T-1/a1-late-1 at 13c27b77e11dabed2b9d717d49cd6c0ceae939ff |
| closed laptop (codex) | a late_work note of a1 names each ref of its late work | passed | "Late work of attempt T-1-a1: runner R-1 pushed 13c27b77e11dabed2b9d717d49cd6c0ceae939ff to refs/agflow/T-1/a1-late-1 after the attempt ended. Merge it before going on: git fetch origin refs/agflow/T-1/a1-late-1 && git merge FETCH_HEAD" |
| closed laptop (codex) | a2's agent gets the hub's message that names the late work's ref | passed | #3: "Late work for T-1: attempt T-1-a1 pushed 13c27b77e11dabed2b9d717d49cd6c0ceae939ff to refs/agflow/T-1/a1-late-1 after it ended. Merge it into your branch before you go on: git fetch origin refs/agflow/T-1/a1-late-1 && git merge FETCH_HEAD" |
| closed laptop (codex) | a2 submits a branch that merged the late work: a.txt, the late work's tick.txt and c.txt | passed | {"head":"81dd09aeedecca1240829e8f9bd36adc2e5db28e","merged":true,"a":"a\n","tick":"18\n","c":"c\n"} |
| closed laptop (codex) | the person accepts the task, and a2 ends accepted | passed | {"task":"accepted","a2":"accepted"} |
| closed laptop (codex) | the scenario ran to its end | passed | 13 checks made |
| lost lead (codex) | the scheduler seats lead-a1 on a runner, and GET /api/status shows a runner lead in the seat | passed | event #5; seat {"kind":"runner","agentId":"A-1","attemptId":"lead-a1","runnerId":"R-1","since":1794505127899,"wakeups":1,"runnerLeads":true} |
| lost lead (codex) | GET /api/lead/notes lists the lead handoff of lead-a1 | passed | agent:A-1: "The plan: one small task at a time. Review each submission as it arrives, and accept it once its file is in. Nothing is waiting for review now." |
| lost lead (codex) | after the freeze, lead-a1 ends lost, class infra | passed | ["lost","infra"] |
| lost lead (codex) | the seat empties when lead-a1 ends, and the next change seats lead-a2 | passed | [["none",null],["runner","lead-a2"]] |
| lost lead (codex) | lead-a2 takes the seat on another runner than lead-a1 | passed | lead-a1 on R-1, lead-a2 on R-2 (event #18) |
| lost lead (codex) | a worker submits the task created after the failover | passed | {"head":"f8d89ebfe2fc32e104b61821b6764c8ed38f8023","file":"review\n"} |
| lost lead (codex) | the submission's message to the lead is delivered to lead-a2 | passed | #3 delivered to [{"agentId":"A-2","deliveredAt":1794505202557,"ackedAt":null}] |
| lost lead (codex) | lead-a2 accepts the task with its agent token, as the acceptance event's actor, while it holds the seat | passed | accepted by agent:A-2 at #37; seat changes before it: 0 |
| lost lead (codex) | after the thaw, the old runner stops lead-a1's process | passed | agent 90336 of lead-a1 is gone |
| lost lead (codex) | the old runner pushes no ref for lead-a1: leads have no WIP | passed | events none; refs added or moved none; refs gone none |
| lost lead (codex) | the person's message sent during the freeze is delivered to lead-a2, and after the thaw still not to lead-a1 | passed | #2 delivered to A-2 (agent:A-2); lead-a1's model saw it: false |
| lost lead (codex) | the scenario ran to its end | passed | 11 checks made |
| take-over check (claude) | the person resumed the agent's session with the local command in a terminal, and its earlier conversation showed | passed | "cd /private/tmp/agf-e2e-ZMN3Oz/alice/agflow/work/e2e-3833225465/T-1-a1 && CLAUDE_CONFIG_DIR=/Users/nagimov-timur/.agflow/runner/homes/claude /private/tmp/agf-e2e-ZMN3Oz/alice/agflow/runner/vendor/claude/2.1.285/claude --resume bd5f4ecd-5657-40db-9549-ba6009f9c2bb": true; committed from the session |
| take-over check (claude) | the person's commit in the clone is on top of the head the runner harvested | passed | handed back 0c0a9b40db4f605b9a020fda412878fa3f62ac8f ("Add b.txt"); the person's commit 0c0a9b40db4f605b9a020fda412878fa3f62ac8f; harvested head b96e333d6df3ee1ca41435f1f77fef3c090b5d24 |
| take-over check (claude) | the scenario ran to its end | passed | 2 checks made |
| take-over (claude) | the task stays blocked as taken over by the person | passed | ["blocked","takeover","taken over by alice"] |
| take-over (claude) | a1 writes a handoff note before it stops | passed | agent:A-1 at 1794505249182, ended at 1794505250957: "a.txt is committed. b.txt is written but not committed yet. Next: commit b.txt, add c.txt and submit.\n\nDetails: a.txt (\"a\") was committed on the task branch. b.txt (\"b\") exists in the working directory, uncommitted. I started `sleep 600` in the foreground, but the tool call was interrupted before it completed because of the take-over. Nothing surprising otherwise. c.txt has not been created and nothing has been submitted." |
| take-over (claude) | a1 ends taken_over, with no take-over error | passed | ["ended","taken_over",null] |
| take-over (claude) | attempt.takeover.local resumes a1's session with the runner's pinned binary of a1's CLI version and its vendor home | passed | got "cd /private/tmp/agf-e2e-ZMN3Oz/alice/agflow/work/e2e-3833225465/T-1-a1 && CLAUDE_CONFIG_DIR=/Users/nagimov-timur/.agflow/runner/homes/claude /private/tmp/agf-e2e-ZMN3Oz/alice/agflow/runner/vendor/claude/2.1.285/claude --resume bd5f4ecd-5657-40db-9549-ba6009f9c2bb", expected "cd /private/tmp/agf-e2e-ZMN3Oz/alice/agflow/work/e2e-3833225465/T-1-a1 && CLAUDE_CONFIG_DIR=/Users/nagimov-timur/.agflow/runner/homes/claude /private/tmp/agf-e2e-ZMN3Oz/alice/agflow/runner/vendor/claude/2.1.285/claude --resume bd5f4ecd-5657-40db-9549-ba6009f9c2bb"; sessions seen [] |
| take-over (claude) | attempt.takeover.anywhere fetches the WIP ref onto the task branch and pushes to the take-over ref | passed | "git fetch origin refs/agflow/T-1/a1 && git switch -c agflow/T-1-add-a-txt-b-txt-and-c-txt-around-a-take FETCH_HEAD\ngit push origin HEAD:refs/agflow/T-1/takeover-alice" |
| take-over (claude) | attempt.takeover.ref is the person's take-over ref | passed | "refs/agflow/T-1/takeover-alice" |
| take-over (claude) | the clone's .git is a new repository, a shared clone of the vault, at the harvested head on the task branch | passed | WIP 0bdd2d54effe363eed9dbaddfd09bd9c19717128 (hub 0bdd2d54effe363eed9dbaddfd09bd9c19717128), harvested head b96e333d6df3ee1ca41435f1f77fef3c090b5d24; the clone's HEAD b96e333d6df3ee1ca41435f1f77fef3c090b5d24 on refs/heads/agflow/T-1-add-a-txt-b-txt-and-c-txt-around-a-take; alternates "/private/tmp/agf-e2e-ZMN3Oz/alice/agflow/vaults/e2e-3833225465.git/objects" |
| take-over (claude) | the clone shows a1's uncommitted b.txt as a change, and none of a1's committed files as changed | passed | git status: "?? b.txt" |
| take-over (claude) | a1's old .git is in the runner's forensics/<attempt>/ directory | passed | /private/tmp/agf-e2e-ZMN3Oz/alice/agflow/runner/forensics/T-1-a1/git: directory true, HEAD true |
| take-over (claude) | the scenario ran to its end | passed | 9 checks made |
| hand-back from the clone (claude) | the hand-back makes the task ready from the source it names | passed | task.handed_back #19 {"attemptId":"T-1-a1","taskId":"T-1","agentId":"A-1","runnerId":"R-1","source":"clone","ref":"refs/agflow/T-1/a1-late-1","sha":"0c0a9b40db4f605b9a020fda412878fa3f62ac8f"}; task.ready #18 |
| hand-back from the clone (claude) | the work position holds the person's commit, and no late work is recorded for a1 | passed | refs/agflow/T-1/a1-late-1 at 0c0a9b40db4f605b9a020fda412878fa3f62ac8f (origin 0c0a9b40db4f605b9a020fda412878fa3f62ac8f), person's commit 0c0a9b40db4f605b9a020fda412878fa3f62ac8f; late work none |
| hand-back from the clone (claude) | the next attempt starts from the work position | passed | "0c0a9b40db4f605b9a020fda412878fa3f62ac8f" |
| hand-back from the clone (claude) | the next attempt submits a branch holding the person's commit | passed | branch agflow/T-1-add-a-txt-b-txt-and-c-txt-around-a-take at 300079ae7222f96b9cf84406a694ef10790571e0 (submitted 300079ae7222f96b9cf84406a694ef10790571e0); c.txt "c\n" |
| hand-back from the clone (claude) | the scenario ran to its end | passed | 4 checks made |
| take-over check (codex) | the person resumed the agent's session with the local command in a terminal, and its earlier conversation showed | passed | "cd /private/tmp/agf-e2e-GldmIo/alice/agflow/work/e2e-5e19ef95e8/T-1-a1 && CODEX_HOME=/Users/nagimov-timur/.agflow/runner/homes/codex /private/tmp/agf-e2e-GldmIo/alice/agflow/runner/vendor/codex/0.159.2/bin/codex resume --no-daemon -s workspace-write -c 'sandbox_workspace_write.writable_roots=[\"/private/tmp/agf-e2e-GldmIo/alice/agflow/work/e2e-5e19ef95e8/T-1-a1/.git\"]' 01a1d0dc-9e67-7e62-b478-7eee843c97a3": true; committed outside the session |
| take-over check (codex) | the person's commit in the clone is on top of the head the runner harvested | passed | handed back 253aa6eec0cdca61152822f7f01b18a10a01c721 ("Add b.txt"); the person's commit 253aa6eec0cdca61152822f7f01b18a10a01c721; harvested head 8c8f10124c86e7f7b75ab1f6190e6827ffa2728d |
| take-over check (codex) | the scenario ran to its end | passed | 2 checks made |
| take-over (codex) | the task stays blocked as taken over by the person | passed | ["blocked","takeover","taken over by alice"] |
| take-over (codex) | a1 writes a handoff note before it stops | passed | agent:A-1 at 1794505509901, ended at 1794505510990: "a.txt is committed. b.txt is written but not committed yet. Next: commit b.txt, add c.txt and submit.\n\nCommitted a.txt containing the line a as 8c8f101 (Add a.txt). Created b.txt containing the line b; git status showed ?? b.txt. Started foreground sleep 600 for the take-over, but the tool call was interrupted by the take-over request. No tests run because only text files were added. No other surprises." |
| take-over (codex) | a1 ends taken_over, with no take-over error | passed | ["ended","taken_over",null] |
| take-over (codex) | attempt.takeover.local resumes a1's session with the runner's pinned binary of a1's CLI version and its vendor home | passed | got "cd /private/tmp/agf-e2e-GldmIo/alice/agflow/work/e2e-5e19ef95e8/T-1-a1 && CODEX_HOME=/Users/nagimov-timur/.agflow/runner/homes/codex /private/tmp/agf-e2e-GldmIo/alice/agflow/runner/vendor/codex/0.159.2/bin/codex resume --no-daemon -s workspace-write -c 'sandbox_workspace_write.writable_roots=[\"/private/tmp/agf-e2e-GldmIo/alice/agflow/work/e2e-5e19ef95e8/T-1-a1/.git\"]' 01a1d0dc-9e67-7e62-b478-7eee843c97a3", expected "cd /private/tmp/agf-e2e-GldmIo/alice/agflow/work/e2e-5e19ef95e8/T-1-a1 && CODEX_HOME=/Users/nagimov-timur/.agflow/runner/homes/codex /private/tmp/agf-e2e-GldmIo/alice/agflow/runner/vendor/codex/0.159.2/bin/codex resume --no-daemon -s workspace-write -c 'sandbox_workspace_write.writable_roots=[\"/private/tmp/agf-e2e-GldmIo/alice/agflow/work/e2e-5e19ef95e8/T-1-a1/.git\"]' 01a1d0dc-9e67-7e62-b478-7eee843c97a3"; sessions seen [] |
| take-over (codex) | attempt.takeover.anywhere fetches the WIP ref onto the task branch and pushes to the take-over ref | passed | "git fetch origin refs/agflow/T-1/a1 && git switch -c agflow/T-1-add-a-txt-b-txt-and-c-txt-around-a-take FETCH_HEAD\ngit push origin HEAD:refs/agflow/T-1/takeover-alice" |
| take-over (codex) | attempt.takeover.ref is the person's take-over ref | passed | "refs/agflow/T-1/takeover-alice" |
| take-over (codex) | the clone's .git is a new repository, a shared clone of the vault, at the harvested head on the task branch | passed | WIP c19751779bcd3beb4a92674ce525c925b9caa79f (hub c19751779bcd3beb4a92674ce525c925b9caa79f), harvested head 8c8f10124c86e7f7b75ab1f6190e6827ffa2728d; the clone's HEAD 8c8f10124c86e7f7b75ab1f6190e6827ffa2728d on refs/heads/agflow/T-1-add-a-txt-b-txt-and-c-txt-around-a-take; alternates "/private/tmp/agf-e2e-GldmIo/alice/agflow/vaults/e2e-5e19ef95e8.git/objects" |
| take-over (codex) | the clone shows a1's uncommitted b.txt as a change, and none of a1's committed files as changed | passed | git status: "?? b.txt" |
| take-over (codex) | a1's old .git is in the runner's forensics/<attempt>/ directory | passed | /private/tmp/agf-e2e-GldmIo/alice/agflow/runner/forensics/T-1-a1/git: directory true, HEAD true |
| take-over (codex) | the scenario ran to its end | passed | 9 checks made |
| hand-back from the clone (codex) | the hand-back makes the task ready from the source it names | passed | task.handed_back #23 {"attemptId":"T-1-a1","taskId":"T-1","agentId":"A-1","runnerId":"R-1","source":"clone","ref":"refs/agflow/T-1/a1-late-1","sha":"253aa6eec0cdca61152822f7f01b18a10a01c721"}; task.ready #22 |
| hand-back from the clone (codex) | the work position holds the person's commit, and no late work is recorded for a1 | passed | refs/agflow/T-1/a1-late-1 at 253aa6eec0cdca61152822f7f01b18a10a01c721 (origin 253aa6eec0cdca61152822f7f01b18a10a01c721), person's commit 253aa6eec0cdca61152822f7f01b18a10a01c721; late work none |
| hand-back from the clone (codex) | the next attempt starts from the work position | passed | "253aa6eec0cdca61152822f7f01b18a10a01c721" |
| hand-back from the clone (codex) | the next attempt submits a branch holding the person's commit | passed | branch agflow/T-1-add-a-txt-b-txt-and-c-txt-around-a-take at a45b3dd67024a2ab6a7398c77fd7e72c3942f52a (submitted a45b3dd67024a2ab6a7398c77fd7e72c3942f52a); c.txt "c\n" |
| hand-back from the clone (codex) | the scenario ran to its end | passed | 4 checks made |
