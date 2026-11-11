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
bun run live-run --takeover codex                  # the scenarios, then the take-over check with Codex only
bun run live-run --repo git@github.com:you/agflow-live-toy.git --takeover claude,codex --keep
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--claude-home <dir>` | runner.json's Claude home, else `~/.agflow/runner/homes/claude` | The runners' `CLAUDE_CONFIG_DIR`, logged in by setup. Pass the exact path setup used: Claude's login keychain item depends on it. |
| `--codex-home <dir>` | runner.json's Codex home, else `~/.agflow/runner/homes/codex` | The runners' `CODEX_HOME`, logged in by setup. |
| `--runners <vendors>` | `claude,codex` | The vendor every runner of a cluster offers; each scenario runs once per vendor. |
| `--scenarios <names>` | `killed-agent,closed-laptop,lost-lead` | The scenarios to run, in that order. |
| `--repo <url>` | a local bare origin | A throwaway remote, reset by each cluster (see above). |
| `--takeover <vendors>` | off | After the scenarios, the take-over check once per vendor named: `claude`, `codex` or `claude,codex`, as the exit run needs. |
| `--keep` | off | Keep every cluster's files; a failed cluster's files are always kept. |
| `--help` | | Print the options and exit. |

`AGFLOW_HOME` changes where the defaults and the pinned binaries are looked up, as it does for the runner.

## The take-over check

With `--takeover <vendors>`, the script starts one more cluster per vendor, waits until the take-over task's agent
runs its long command (`sleep 600`), and then walks you through the check:

1. Open the sign-in link it prints, which signs you in to the dev hub as alice and opens the task page, and press
   Take over. Do it before the long command ends, within about 10 minutes of the script's prompt.
2. Once the runner has handed the clone over, the script prints the local command, of the form
   `( cd <clone> && CLAUDE_CONFIG_DIR=<home> <pinned claude> --resume <session> )`, or the `codex resume --no-daemon`
   one. The parentheses run it in a subshell, so your terminal does not stay in the clone. Run it in another
   terminal and check that it shows the agent's earlier conversation.
3. From inside the resumed session, commit the agent's uncommitted b.txt: type
   `!git add b.txt && git commit -m 'Add b.txt'` (a line that starts with `!` runs as a shell command in Claude Code
   and in Codex), or ask the agent to commit it. Then exit the session and answer the script's question. If the
   session did not resume, commit outside it with `git -C <clone> add b.txt && git -C <clone> commit -m 'Add b.txt'`
   and answer no.
4. Leave the clone in every terminal and close any editor open in it: the runner refuses a hand-back while a process
   runs in the clone. Then, in the browser, press Hand back and choose the clone. If the runner refuses, the script
   prints its reason (`process_running` with the process ids); end those processes and press Hand back again.

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

Not run yet: the live run happens once the M2 plans have landed, because the plans are prototyped without models.
After the run, fill in one row per run below and paste the script's table under it.

| Date | Commit | Vendors | Scenarios | Take-over check (Claude) | Take-over check (Codex) | Lid close | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
