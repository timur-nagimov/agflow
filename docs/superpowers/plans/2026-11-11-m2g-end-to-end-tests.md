# M2g: end-to-end tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove M2's exit criteria through the real hub, runners and vendor CLIs. For both Claude and Codex:

- kill a worker and finish its task on another runner without losing committed or uncommitted work;
- freeze a runner, finish its task elsewhere after the lease expires, then recover and merge its late work;
- freeze the lead's runner, seat a successor from its handoff, deliver the person's message and review a new submission;
- check runner suspend and crash, hub crash and restore, delivery during a tool call, and take-over with both kinds of hand-back.

Provide a script and runbook for the owner's later run with real subscriptions, including both vendors' terminal take-over commands. Update the README and the original agflow spec, with tests that keep their commands, configuration, transitions, links and status tables true to the code.

**Architecture:**

- **One real cluster per case.** `packages/testkit/src/harness/index.ts` is a separate entry. A cluster composes a bare origin, `packages/hub/src/main.ts` as a process, three foreground `agflow runner start` processes, and a person signed in through the hub's real routes. Alice, bob and carol own separate runner homes. Every runner offers just the case's vendor.
- **Real CLIs, scripted answers.** M2d's Anthropic server and M2e's Responses provider answer through vendor-neutral playbooks. Attempt paths and tool-call history choose the next step, never request order. The servers and hub use loopback; the refusing proxy blocks other traffic. Agents get scratch homes and test credentials.
- **Observable faults and checks.** Faults signal real process groups or freeze a whole tree. Checks use the hub API and events, origin refs, clone files, process identities and recorded requests. They never read runner.db or replace a base plan's implementation. Gates make timing observable; short liveness timings and long judgement timings keep unrelated policies out of a scenario.
- **Shared drivers.** The three exit scenarios and the take-over checks return named results and details. The scripted suite asserts them; the owner's live run reuses them with real models and prints a table. Take-over checks establish that the runner replaced `.git` before any person-side git command runs in the clone.
- **Checks in layers.** Harness, process, hub, live-script and documentation tests run in the ordinary suite. Real-CLI end-to-end tests run only with `AGFLOW_E2E=1`; once enabled, missing prerequisites fail rather than skip. The live run is a separate, manual exit gate, never an implementation or CI command.

**Tech Stack:** Bun 1.3.11 (runtime and test runner), TypeScript 5.9.3, git, macOS process tools (`ps`, `lsof`, signals and `caffeinate`), Claude Code 2.1.285 with Agent SDK 0.3.285, Codex 0.159.2. Existing testkit servers, builders and refusing proxy; existing core schemas and runner helpers. No new dependencies or lockfile change.

**Depends on:**

- Plan M2f, complete: branch `m2f-web` at **`a661768c2473de34a0bde1bb2ea295d67f00c421`** (M2F Task 20). This is the base of this plan. In the final linear stack it includes M2a–M2e and M1. Do not start from M2f's earlier standalone base or the provisional stack head in the historical reports.
- M2a supplies core names, fences, schemas, `TEST_ACCOUNT_ID`, bridge answers and events; hub test mode; the real scheduler, runner link, attempts, submissions, delivery, lead seat, take-over, restart and restore. M2b supplies git fixtures, the proxy, process parsers and identities, runner configuration, the controller, replay, harvests, late work and bridge. M2c supplies machine identity, runner configuration creation, foreground start, status with pid/pgid/lstart, suspend and login checks. M2d and M2e supply their adapters, pinned-binary locators, scripted servers, request parsers and reply builders. M2f supplies the UI used by the live run and described in the README.
- Historically, Tasks 1–3 followed lanes D1/E1 after gate G2, and Task 4 followed G5 (hub complete). Tasks 5–14 required G6 (M2c/M2d/M2e complete, their local real-CLI and sandbox suites checked on macOS). Tasks 15–19 also required G7 (M2f complete and `bun run check:ui` passing). All providers are in the base above; these gates still describe the evidence required before the final end-to-end gate (X-47).

**Spec:** `docs/superpowers/specs/2026-10-28-m2-runners-design.md`, revision 4 and the accepted refinements in its section 18: section 1 (exit criteria), sections 6–10 (the contracts exercised), section 14 (plan ownership), sections 15 and 15.1 (testing and test mode), and section 17 (updates to the original spec). Tasks 18 and 19 update `docs/superpowers/specs/2026-10-26-agflow-design.md`; Task 19 also records accepted clarifications in the M2 design. The cross-plan decisions that bind this plan are listed below with their reasons.

**How this plan was checked:**

- Current commit refresh (2026-11-11): all task subjects and linear parents match the refreshed prototype, exactly one commit per task. SHA references now name this chain. Earlier rebase comparisons and test totals below describe their recorded runs; they do not establish unchanged patches or new full-suite/Linux results after the latest fixups. Generated code comes from the current task commits.

- The finished prototype is branch `m2g-e2e`, the 19 commits from the base above through `84fda5c18eb62215942402ed072b936fd9261674`, one per task in outline order. The code below comes only from those commits: new files in full and changed files as unified diffs. Older SHAs in the G1/G2 reports and Linux-fix report are historical; `plan.json` uses the final full SHAs.
- The G1 reports record the harness tests, their initial failures and review fixes. The G2 reports record the scripted real-CLI runs for both vendors and the subsequent review fixes. Their final Task 16 batch reports `bun test`: 3738 pass, 223 skip, 0 fail, and a clean typecheck; the affected cluster, killed-agent, take-over, delivery and live-take-over suites report 54 pass. These are historical prototype results, not a fresh full-suite claim for the final SHA. The Linux-fix report records 18 passing macOS tests and a clean typecheck, but explicitly left its full and Linux runs unfinished; it is not evidence of a final Linux pass.
- Tasks 17–19 record test-first documentation checks: respectively 4, 22 and 46 passing tests and clean typechecks. Their full-suite and Linux checks were handed to the coordinator. A final-chain M2f note reports no coordinator failures or fixes, but supplies no M2g full-suite counts; this plan does not invent them.
- Test-first exceptions are explicit. Tasks 11–13 add only scenario tests over existing implementations, so their generated steps say “Make the change” and “Check it”. Tasks 12 and 13 initially passed; Task 11 first exposed a test-driver mistake while the hub was down. Task 10 originally passed too, but its final commit also extracts `sessionOf` and `callIdsIn`; its final tests fail before those exports exist. Some later Task 15 and 16 review assertions were not run before their fixes. Mutation evidence is recorded as mutation evidence, not as a parent-commit failure.
- On 2026-11-11, missing or unsuitable parent-tree failure evidence for Tasks 6, 9–14 and 16 was checked in disposable `git archive` copies of each task's final parent, with only that task's final test files copied in and `bun install --frozen-lockfile`. Tasks 6, 9, 10 and 14 failed on the missing driver or exports, quoted below; Task 16 first failed on the absent webDist behavior, then on missing live-run exports. Tasks 11–13 loaded and skipped their gated cases (14, 14 and 12 skips); that is explicitly not a gated pass. The scratch copies were removed. Logs are alongside this plan as `expected-failure-task-*.log` and `expected-failure-checks.json`.
- The generated document was reconstructed task by task in a disposable archive, applying its diff blocks with `patch` and comparing the complete tracked tree with each final commit: all 19 match exactly, including bytes, symlink targets and executable modes. No Git metadata was written and the scratch copy was removed. `plan-verification.json` records the check and all 14 binding decisions. Current-head documentation tests pass (46 tests, 363 assertions), and `bun run typecheck` exits 0. An additional parent-tree process-test run was blocked by `EPERM: operation not permitted, posix_spawn ps`; this is not a product failure or a red-test result. Run `bun test packages/testkit/test/proc.test.ts` outside this sandbox.
- Evidence sources: `outline.json`, `stage4-g1a-result.json`, `stage4-g1b-result.json`, `g2-batch-reports.json`, `g2-reports.md`, `notes-for-later.md`, `linuxfix-result.json`, the final Task 17–19 reports under `/tmp/agflow-codex/final/m2g/`, and the shared `decisions.md`, `stack/conflicts.md` and `spec-updates.md`. Later report corrections supersede their earlier versions; the final Git range supplies every code block.
- Plan assembly runs no real model and no owner login. Full `bun test`, Linux CI, nested-sandbox real binaries and the final gated suite belong to the coordinator outside the restricted sandbox. The owner alone performs the live run after the plans land.

---

## Decisions

### Cross-plan decisions that bind this plan

These are every decision whose `Binds:` names M2g, plus X-47, which binds all plans. Task numbers below use the final outline, not the earlier numbers in some decision prose.

1. **X-1 Restore replay precedes re-fencing** (Task 12). `hello.lastSeq` is the highest held seq, or `firstSeq - 1` with an empty outbox. Reconciliation waits for the cumulative acknowledgement to reach it; a dropped link starts that decision again. A replayed event with a fence newer than the backup counts as current. Unknown agent tokens during the restore window get `attempt_refenced`. Why: otherwise the post-backup WIP is discarded before the new fence and token arrive. Task 12 deliberately creates a newer fence before restoring.
2. **X-6 Real adapter registry** (Task 5). The foreground CLI's host calls M2b's `createAdapters`; M2d and M2e fill their own registry entries. Why: end-to-end tests must exercise the production adapter selection, without a duplicate factory in testkit.
3. **X-10 Pins and binary layout** (Tasks 1, 5, 14–16). Use `VENDOR_PINS` for darwin-arm64, `vendor/claude/<version>/claude` and `vendor/codex/<version>/bin/codex`. Start never installs; an omitted vendor has no linked binary and reads “binary missing”. No `CODEX_MANAGED_*` variables or vendor-disable setting. Why: the installed layout, preflight and take-over commands must agree, and a one-vendor cluster needs no new production switch.
4. **X-11 WIP during outages** (Tasks 5, 8, 11). `canPushWip` requires a welcome since the last clock gap, no known fencing/end/exit, and a recent acknowledgement within `runnerLeaseMs / 3`. With the 30 s test lease this is 10 s; WIP runs every 5 s. Work outside the grace waits in the vault; final work that cannot use WIP is late work. Why: the hub-crash case must push inside the grace, while a waking obsolete attempt must not overwrite current WIP.
5. **X-15 Kill and sweep before harvest** (Task 7). After an unrequested exit, the runner kills identity-checked groups and sweeps the clone before final harvest. Why: a surviving tool must not write after the work advertised as final. The scenario checks the clone's processes when the hub records the end.
6. **X-20 One testkit and separate gates** (Tasks 1–5). Reuse `startRefusingProxy`, `startScriptedAnthropic`, `claudeTestEnv`, `startResponsesServer`, `codexTestConfig`, the parsed requests and builders, `findClaudeBinary` and `findCodexBinary`. Codex calls compile through Code Mode builders. Locators accept explicit binary variables or the runner's pinned vendor directory and do not read `AGFLOW_HOME`; use the scratch provisioning commands and both exports under the gated rules. `AGFLOW_SMOKE`, `AGFLOW_SANDBOX_CHECKS` and `AGFLOW_E2E` remain distinct. The main testkit entry imports runner types only; the harness has its own entry. Why: no second wire protocol, proxy or dependency cycle, and normal CI never starts a real vendor session.
7. **X-21 Test account identity** (Task 5). Under `skipAuthChecks`, both adapters report ready, problem and plan “test mode”, and `TEST_ACCOUNT_ID = '337c8a0a2e66c1e6'`. A ready account without quota remains usable; unknown utilization is zero and a zero ceiling excludes it. Why: the real scheduler can place scripted work without the owner's login or quota.
8. **X-26 Real hub entry** (Task 4). Spawn `main.ts`, whose `startHub` owns the database lock and automatic scheduler. The demo's manual scheduler and the in-process fixture are separate uses of the same hub. Why: crashes, stale locks, startup backups and restores must cross real process boundaries.
9. **X-27 Hub test mode** (Task 4). Pass `AGFLOW_TEST=1` and `E2E_HUB_TIMINGS` as `AGFLOW_TEST_CONFIG`; validate them with the hub's loader. Production minimums stay intact. Why: seconds-long liveness tests must not lower production leases or judgement limits.
10. **X-30 Runner timings** (Task 5). Short positive overrides require both test mode and `test.allowShortTimings`. The hub supplies heartbeat, deadLink, handoff and WIP grace through welcome; other timings keep their defaults. Why: one side owns each duration and tests preserve the production handshake.
11. **X-42 Real helpers and observable status** (Tasks 1, 5, 7, 14). Extend M2b's `originRepo`, `commitFiles` and `gitIn`; reuse its process tools. Build homes with M2c's `readMachineId` and `createRunnerConfig`; inspect attempts through `agflow runner status --json`, checking pid, pgid and lstart. No runner.db reads and no test-mode notifications (X-9). Why: the harness tests public behavior and shares the production process-identity rules.
12. **X-43 Scope, topology and spec updates** (Tasks 12, 14–19). A local bare origin needs no hub change. Keep hub restore and take-over here. The owner's live run uses one Mac, three AGFLOW_HOMEs and one set of logged-in runner vendor homes; optional `--repo` is a throwaway remote. Results go into the PR and runbook. Replace superseded spec rules with short summaries and M2 heading links; add the original spec's status column; put accepted contract clarifications in M2 section 18. Why: test the complete system without duplicating its design or creating a competing “implementation notes” contract.
13. **X-44 Shared-file ownership** (Tasks 1, 6, 16, 17). Dependencies already exist. M2g adds only the root scripts `e2e` and `live-run`, owns the README update and checks every root script there. The decision's older “T16 edits README” means final Task 17. Why: parallel plans must not edit the same package metadata or README, and testkit needs no new CLI, hub or zod dependency.
14. **X-47 Gates and order** (all tasks). Harness pieces follow their providers, scenarios follow G6, and live tooling/docs follow G7 too. The final gate is both vendors' gated e2e on macOS; the subscription run follows after landing. Why: prototype parallelism is safe only when the contracts and real providers used by a task already exist.

### Decisions of this plan

15. **One vendor per cluster** (Tasks 5–16). Alice, bob and carol each have `<login>-mac`, capacity 2, and only that vendor's binary. Runner leads are off by default, and the goal and lead setting are saved before a runner connects. Why: placement and successor assertions are deterministic; cross-vendor placement belongs to hub unit tests.
16. **Observe the system from outside** (Tasks 6–14). Use API/event order, origin refs, session history, safe clone reads and process identities. A resume means an `attempt.resumed` event and higher fence; a restore means epoch 2 and replay before resume. Transcript uploads with no public observable, submission adoption absent from this backup, keep-awake, disk guards and shell-profile behavior remain in the owning plans' tests. Why: assertions against runner.db or a copied policy would prove less than the public outcome.
17. **Separate scripted and owner live use** (Tasks 15–16). Implement and test live support with fake status CLIs and scripted clusters. Only the owner later runs real subscriptions and terminal sessions. Why: real-model nondeterminism and quota are part of the manual exit criterion, not plan development.
18. **Commit ownership follows the final history.** The gate/denial fix is in Task 2; the parent-exit cleanup hook is in Task 6; session/history helpers are in Task 10; `SNAPSHOT_SUBJECT` is in Task 7; `TakeoverOptions.processesIn` is in Task 14; its live test is in Task 16. Why: later reviews moved shared changes to the task that owns them, so every intermediate tree remains reconstructible.

### Refinements of the design

The prototype and reviews settled the following details. Each describes the final code; superseded experiments in the reports are not implementation instructions.

**Entry, processes and playbooks**

19. **Prerequisite checks are async and exhaustive** (Task 1). `requireE2e({ env, platform, home })` is injectable and memoized with no options. It refuses an unset gate, then reports every missing requirement with a remedy, including the platform, selected pinned binaries, git and lsof. Pins always come from darwin-arm64, even when reporting the wrong platform. `e2eVendors` uses `VendorSchema.options`, removes duplicates, treats empty as both and rejects unknown names. `describeE2e` accepts an optional test env, skips only when disabled and uses a 60 s prerequisite hook. Why: a missing tool must fail an enabled run, while unit tests need no real CLI.
20. **Origin readers preserve exact data** (Task 1). A shared private `runGit` supports untrimmed `fileAt`; absent refs or non-blob paths return null. `isAncestor` maps git exits 0/1 and throws otherwise. `cloneTo` accepts an optional branch and writes fixture identity only in the clone. Why: scenarios compare exact file content and can commit without the user's git configuration.
21. **Process lookup shares M2b's implementation** (Task 1). `ProcessInfo` is `PsRow`; list and clone lookup reuse M2b. Resolve the nearest existing ancestor and reattach missing path components before `findCloneProcesses`, including removed clone trees and `/tmp` versus `/private/tmp`. Reject relative paths, filter zombies and surface missing lsof. Why: cleanup must still find a process whose working directory has disappeared.
22. **Tree and group control have explicit boundaries** (Task 1). Freeze the root first, then descendants, repeating the walk until no new pid appears. Thaw deepest descendants before the root. Group signals return false for vanished/all-zombie groups and refuse 0, 1 and the test process's own group. `waitUntilGone` defaults to 10 s with 50 ms polls and names the pid on timeout. Why: tool children form separate groups, and a fault must never stop the test runner itself.
23. **Linux keeps portable checks** (Tasks 1, 14, 16). Removed-cwd discovery is darwin-only, reason “the runner supports darwin-arm64 only; design 7.1”. The ordinary cwd test skips off macOS only when lsof is absent; macOS never skips for that absence. `TakeoverOptions.processesIn` defaults to real lookup, but the failed-take-over unit test injects and asserts a fake lookup of the clone. Why: Linux CI need not reproduce macOS's deleted-cwd reporting or start a real long process to test a control-flow guard; macOS checks remain intact.
24. **Playbook steps are bounded and repeatable** (Task 2). `shell` defaults to 120 s and accepts integer timeouts 1–600000 ms; `tool` takes an identifier, `say` prepends text and `react` requires a marker. Main call ids are `e2e-s<n>`, reactions `e2e-r<k>-s<n>`. A result, including interrupted/aborted, advances; a call without a result repeats. Reactions trigger only after the program's first call, run once in trigger order, then return to the main steps. Exhausted programs emit closing text; idle-agent messages can still trigger reactions. Why: retries and resumed histories must not replay work or react to the initial brief.
25. **The attempt comes from its own clone path** (Task 2, X-17). Validate `work/<project>/<attempt>` with core's parser. Read Claude's system environment and then non-assistant text blocks in message order, trying the last primary-working-directory line and brief cwd line within each block. Codex uses request cwd, then developer instructions. Ignore auxiliary Claude requests and Codex compactions. Why: quoted handoffs and later messages naming an earlier clone must not redirect the program. Compaction would lose call ids; these short scenarios do not exercise it.
26. **A gate is one literal perl command** (Task 2). It waits under `.agflow/run/e2e/<safe-name>`, with its own deadline five seconds before the step timeout and exit 124 on expiry. That directory is ignored by harvests, snapshots and file watching. Why: the pinned Claude CLI denied the earlier shell loop's expansions and brace group before running it; a denied gate let the smoke test pass by timing.
27. **An unfinished tool is a playbook error** (Task 2). Reject gate timeout text, Claude permission denial (including its reason), Claude “moved to the background”, Codex “Script running with cell ID” and whole JSON result lines with `session_id` but no `exit_code`. Do not mistake an escaped string inside command output for that result. `Next` carries step/done/error, and error replies start `agflow playbook error:`. Why: a refused or still-running command must not count as completed work.
28. **Use the pinned Codex tool schema** (Task 2). `reply.shell` emits a first-line exec pragma with yield time at least the step timeout (timeout + 5 s) and polls `write_stdin` to its own deadline. `exec_command` gets `{ cmd, yield_time_ms }`, capped at a 30 s yield, and no `timeout_ms`, which this pin does not declare. Tests execute the compiled cell with fake tools. Claude uses Bash's explicit timeout and MCP tools; both place optional text before the call. Why: one long gate must finish in the same Code Mode cell instead of yielding and advancing the playbook.

**Models, hub and runner homes**

29. **Model recordings describe input actually seen** (Task 3). A vendor-tagged `RecordedRequest` holds seq, attempt id, flattened input, parsed request and the `Next` answer or null for the default. Exclude assistant replies/tool calls; include prompts, injected text and tool outputs. `requests`, `requestsFor`, `sawText`, `unmatched` and external attempts serve scenarios and dumps; raw servers, proxy and `proxyUrl` stay accessible. Rejected requests before the handler remain only on the raw server. Why: the model's own text must not satisfy a “was shown” check.
30. **Late programs have a short grace** (Task 3). `addPrograms` merges and replaces only named attempts, wakes waiting requests, and waits up to `programWaitMs` (10 s by default) for a valid main-loop attempt missing its program. Closing also wakes waiters; seq is recording order, not arrival order. Unknown attempts then get the harmless default and count as unmatched. Register successors ahead using core attempt names. Startup failure closes partial servers and close is memoized. Why: a fast scheduler may start a successor before the test registers its program, without making the scenario nondeterministic.
31. **Hub timings isolate the intended policy** (Task 4). Tick/heartbeat 1 s, deadLink 5 s, lease 30 s, recovery 15 s, backoff 1/2/5 s, dispatch hold 10 s and delivery batch 500 ms. Stall/tool cap/lead review are 60 min, long tool cap 120 min and active budget 8 h. Other values, including handoff and submit timeouts, keep defaults. Type the override as millisecond fields of `HubConfig`. Why: liveness should settle quickly while no unrelated stall or budget ends the attempt.
32. **A hub process owns a minimal environment and directory** (Task 4). Create its directory before opening `hub.log`; keep `agflow.db` and backups there. Spawn Bun with `--no-env-file`, cwd and HOME at that directory, only PATH/TMPDIR and explicit hub variables, and a `127.0.0.1` public URL. Append process/restore output to the log. Readiness is `/api/auth-config`, with a 30 s deadline and log tail; SIGTERM must exit 0 within 20 s. Why: inherited auth, web paths or dotenv must not affect tests, IPv6 localhost must not race an IPv4 listener, and a ready line is earlier than a fully usable hub.
33. **Backups and people use the real routes** (Task 4). Use hub `BackupKind`; list completed `agflow-<kind>-*.db` names in time order, ignoring temporary files. Restore only while stopped, with a minimal environment. The counter test backs up T-1 before expecting T-1002. Person uses the dev-auth cookie as a web principal; CLI token minting approves then polls without that cookie. M2 responses parse with core schemas; M1 answers use core types where no response schema exists. Why: restore counters start at the backup, and browser-only actions must run with real authority.
34. **Client failures remain useful during outages** (Task 4). `HubCallError` has method/path/status/body; transport errors have status 0. Stop and replace accept 200 or 202, and goal writes use the current version. Stand-in responses prove schema parsing rejects drift; an unreachable real hub proves status 0. Assert ZodError's name without adding zod to testkit. Export `E2E_USERS`. Why: waits must survive expected disconnects but expose the real last failure and contract mismatches.
35. **Runner homes are explicit inputs** (Task 5). `prepareRunnerHome` takes credentials, not Person; use `<login>@agflow.invalid` identity. Canonical directory layout is `home/`, `agflow/`, `config/`, `runner-process.log`; credentials are mode 0600. Use a de-duplicated absolute PATH or `/usr/bin:/bin:/usr/sbin:/sbin`, with a small environment allowlist. Link Claude with M2d's helper and Codex's whole version tree, refusing a binary outside `bin/`. Why: a relative PATH or inherited environment could load clone-written programs; plain unit tests need no hub.
36. **Runner defaults favor a stable test host** (Task 5). Set keepAwake off, minFreeGb 0.5, backoff 500 ms–2 s, WIP 5 s, wake hold 5 s and crash-loop window 30 s; leave the battery threshold and other timings alone. Proxy connectivity bypasses only loopback. Run on AC power. Why: low disk and sleep guards have their own tests; WIP must fit the hub's 10 s grace and fault cases must not self-drain from old crashes.
37. **Runner lifecycle checks the process it started** (Task 5). Run foreground CLI with `--no-env-file`. Poll `/health` until the control response pid matches the spawned pid and the link is online with runner id; `{ online: false }` waits only for the socket. `stop` requires exit 0 within suspend + 15 s. A failed start calls close and rethrows with its log tail. `agentOf` checks pid/pgid/lstart through `sameProcess`. Why: a stale socket or reused pid must not count as this runner or agent.
38. **Status and removal avoid service side effects** (Task 5). `status()` runs the CLI with PATH at an empty directory, preventing the historical status path from calling `launchctl print-disabled` on the real user domain. `close()` thaws, collects descendants, kills, sweeps the home and waits; `remove()` first calls `removeAgentTools` for read-only directories. Why: tests must neither touch the real LaunchAgent nor leave protected fixture directories undeletable. This conservative status isolation remains even if the base fixes test-mode status.

**Cluster lifecycle and exit drivers**

39. **Clusters have short real paths and bounded waits** (Task 6). Use realpath of `/tmp/agf-e2e-*` for socket limits. `waitFor` defaults to 120 s/250 ms, treating a thrown check as not yet; timeout includes the last error and dump. `waitForEvent` pages with `after` and independently matches type, subject, attempt id and data. Attempts are ordered by number; runners are matched by name. Why: restarts interrupt HTTP, and event subjects cannot be guessed from attempt names.
40. **Dumps and failure retention are explicit** (Task 6). Dump attempts with 20 log entries, runner readiness, 40 recent events, process log tails, six requests per attempt and unmatched requests, building each section independently. `step` records failure and in-flight work; close keeps files for failure, in-flight steps, KEEP_E2E or explicit keep, and is idempotent. A deliberate wait timeout alone does not mark failure. After close, waits and gates throw; never close inside a step. Why: Bun exposes no test-result API, and a timed-out body may still run while teardown begins.
41. **Parent death cleans tracked children** (Task 6). Hub and runner starts call `trackProcess`. Exit and SIGINT/SIGTERM/SIGHUP handlers snapshot ps once, thaw/kill descendants of live tracked processes and kill their roots; signal exits use 128 + signal. Cluster shutdown also sweeps its directory. Tests cover frozen trees on normal exit and SIGTERM. Every e2e file sets `E2E_TEST_TIMEOUT_MS = 600000`, since a file default overrides the CLI flag. Why: a timed-out setup or killed test process must not leave frozen agents behind.
42. **Smoke checks use vendor-specific cwd and final work** (Task 6). Claude's agent cwd is the clone; Codex's app-server cwd is its user home while commands run in the clone. Both have pgid = pid and matching start time. Wait for the hub's final wipSha before acceptance, then require no late-work note and clone cleanup. The root-script assertion stays ungated. After close, proxy records must contain no loopback target; the proxy never grants external traffic. Why: command cwd is distinct from agent cwd, and holding alone does not prove the final exit WIP reached the hub. The accept-before-exit race found here was later fixed in M2a.
43. **Named results survive failures** (Task 7). `checks` accumulates `Check { name, passed, detail }`; a thrown body adds failed `RAN_TO_END` and keeps earlier results. `expectPassed(result, names?)` fails for missing named checks too. A completed body with failed checks can attach `ScenarioResult.dump`; killed-agent and closed-laptop pass the dump callback. Lost-lead does not in the final prototype, although timeout errors already include the cluster dump. Why: live runs need a complete table and tests need meaningful diagnostics rather than the first assertion only.
44. **Shared helpers read clone files cautiously** (Task 7). `cloneFile` uses lstat, O_NOFOLLOW/O_NONBLOCK, fstat and a 64 KB cap; it reports links and non-regular files rather than following/opening them. `SNAPSHOT_SUBJECT`, newest-event, first-request, gate and note helpers live in result.ts. Open gates only in scripted drivers. Why: real-model clone contents are untrusted, and shared snapshot semantics must not drift.
45. **Killed-agent checks a real pre-kill state** (Task 7). Wait for a1's handoff on the hub, b.txt in its clone and `sleep 600` in that clone, then kill the identity-checked group. Final WIP must have the uncommitted-work subject and b.txt, with a parent holding a.txt but no b.txt. Require at least one handoff and every handoff to be a1's own; compare its exact quoted brief in a2's first request. Check no remaining clone processes, another runner, a2's restatement, a/b/c on the submitted branch and acceptance. Why: this distinguishes a final snapshot and actual handoff reuse from incidental periodic WIP.
46. **Closed-laptop creates distinguishable late work** (Task 8). A literal perl command rewrites tick.txt five times a second. Freeze after the first WIP following that file, read effective timings through hub `loadConfig`, and require offline after deadLink − 2 heartbeats and lost after lease − deadLink. No stall/stop or stopRequested while frozen; the lease alone ends it. Require task.stale then task.ready and exactly one system handoff, with a.txt inside the WIP-commits section and the unknown-next-step closing paragraph. Why: the late tree must differ from WIP, and the handoff assertion must prove the named section rather than match unrelated text.
47. **Late refs and merges are checked precisely** (Task 8). Number late refs with core `lateWorkRef(..., k)` from 1. A late event on the WIP ref is allowed only for a commit timestamp no later than the freeze bound (rounded for git's seconds). Ref matching rejects longer ref names but accepts sentence punctuation. Hold a2 after its own c.txt commit; after thaw, wait for a1 cleanup, a late-ref event and the message, then install the merge step and open the gate. Retry fetch while refresh_vault catches up and merge with `-X theirs` for tick.txt's add/add conflict. Require every late sha ancestral to submission and the newest tick content, then accept. Why: in-flight pre-freeze pushes are legitimate, but post-wake work must not masquerade as current WIP.
48. **Lost-lead proves authority after failover** (Task 9). Supply lead-a1's program before runners start and freeze only after its handoff and idle phase. Require seat changes none → lead-a2 on another runner; wait for a2's first request before checking the quote. Its first call is get_lead_notes; later add the submission-message reaction using `accept_task { id }`. Require no intervening seat change and acceptance by a2's agent. Re-read the person's delivery after thaw and the old runner's exit report: a2 only, never a1 or a1's model. Snapshot every origin ref and sha before/after thaw, after waiting for the accepted worker's final exit report. Why: a name heuristic could miss a lead's illicit push, and checking only before thaw could miss a late delivery.

**Restarts, restore, delivery and take-over**

49. **Suspend and crash are separate clusters** (Task 10). A second resume within the window intentionally crashes an attempt. Before SIGTERM, wait for the actual gate command, record a non-null session/thread, then write suspend.txt. Require a changed final WIP holding it, no extra model request/handoff turn, exit 0 within suspend, and the same open attempt. Remove that test-only file while down so submission stays clean. After SIGKILL, compare pid plus start time for the agent and clone processes; none may survive the restarted runner's hello, even if they died earlier from pipe closure. Why: both paths must preserve work without relying on the child outliving its parent.
50. **Resume checks cannot pass on two null ids** (Task 10, reused by 12 and 14). Extract `sessionOf` and `callIdsIn` to models.ts with a unit test. Require an earlier real id, the same resumed id, earlier call history, a higher fence and no second attempt. Use the literal design restart prompt, not an import of the implementation being tested. An interrupted gate counts as run; opening it after the resume request is a safeguard. Why: a copied implementation string or null equality would hide a broken resume contract.
51. **Hub-crash work stays inside WIP grace** (Task 11). Capture the runner/clone before killing the hub; open the gate by that path while HTTP is unavailable. The same perl-gate command immediately writes b.txt, avoiding a model round trip before the 5 s WIP timer. Keep the hub down for lease + 5 s. A failed report_progress ends the turn, so X-38's nudge waits for welcome; its reaction waits at a recovery gate, retries progress and submits only after recovery_ended. Why: this tests a real outage and the allowed direct origin push, not a test-driver HTTP failure.
52. **Recovery evidence is ordered** (Task 11). Require gapMs above the lease, until within one tick of recoveryMs, recovery_ended at/after until, replayed WIP and task position matching origin, unchanged fence, no resume/end, and successful later progress with the same token. Count OUTAGE_NUDGE exactly once both at the reaction and after submission; the downtime progress note must be absent. Why: a submitted task alone does not prove lease extension, replay or single delivery of the retry nudge.
53. **Restore really exercises a newer-fence replay** (Task 12). Take a new start backup while a1 runs and require the backup count to rise. At BACKED_UP, restart a1's runner to advance its epoch-1 fence beyond the backup; only then record the b.txt WIP and its fence. Restore the stopped hub and require that WIP after system.restored but before attempt.resumed, with no late-work event. The RESUMED gate holds all three positions (attempt, task, origin) at that sha. Why: without the post-backup resume, the X-1 newer-fence test was vacuous. Removing that rule during review made it time out.
54. **Restore keeps sessions and avoids identifier collisions** (Task 12). The restore-resume request must contain the restart prompt twice (runner restart and restore), the same non-null session and earlier calls. Old process identity is gone, no handoff prompt was sent, the epoch-2 token can report progress, and the attempt remains open. The old task submits on its original branch with S-number above 1000; a new task has T-number above 1000 and epoch-2 attempt/ref/branch on origin. Person and CLI credentials predate this backup, so no new sign-in is needed. Why: backup counters and epochs prevent collisions without changing an existing attempt's branch; a session created after a backup would instead need re-authentication.
55. **Delivery timing follows the vendor** (Task 13). Wait for a running gate before sending the message. Codex accepts it at turn/steer; Claude's session transcript queue-operation enqueue proves it is queued while deliveredAt is still absent, then the next tool boundary accepts it. A second HELD gate holds the consuming turn with deliveredAt set and ackedAt null; opening it lets acknowledgement follow. Why: arbitrary timestamp comparisons cannot reliably distinguish delivery from turn completion.
56. **Person authority is asserted in new input** (Task 13). Slice after the model's last item, distinguishing call results, every tool output (including call-less agent_message outputs) and injected user input. Require the formatted user:alice message in exactly one request's injected input and no tool output, with the initial gate result and reaction call in that same turn and no intervening turn-log entry. The reaction commits d.txt, checks inbox and waits at HELD; inbox must be a normal “No new messages.” result. Why: counting text anywhere let an agent-authority mutation pass; the corrected checks reject it.
57. **Take-over has separate setup and observation** (Task 14). `readyForTakeover` creates the task and waits for committed a.txt, uncommitted b.txt and `sleep 600`; `takeoverChecks` and `handbackChecks` only observe. Run take-over checks after the stop and before person edits or hand-back removes the clone. Why: the live browser/TTY person and scripted API person must use the same checks without the driver performing their actions.
58. **Never run git on the agent's old repository** (Task 14). First require successful take-over, local command, no error, a real `.git` directory and forensics/<attempt>/git with HEAD. Only then inspect HEAD, branch, status and alternates; otherwise record “not run” failures. The harvested head is the snapshot's parent or WIP itself; alternates name the vault, and status with `core.fsmonitor=false --no-optional-locks` shows b.txt untracked and no tracked file changed. Why: a failed take-over could leave planted git configuration, and the missing-read-tree mutation previously passed while deleting every tracked index entry.
59. **Commands and hand-backs match the public contract** (Task 14). Compare local commands exactly using the attempt's pinned version and vendor home (`claude --resume` or `codex resume --no-daemon`); scripted runs also match its recorded session. Compare anywhere commands and takeoverRef exactly. Require the agent's handoff before endedAt and 409 on unblock. One task exercises process_running with a real process, cleared handingBack and retry from the clone; a second exercises each anywhere command in another clone and ref hand-back with full sha. Read work position from task.handed_back, since a2 soon moves it; require the person's commit ancestor, no a1 late-work event and a2 starting there. Why: both return paths must preserve the person's work and report refusal without losing take-over state.

**Owner live tooling and documentation**

60. **Real models preserve the owner's recorded setup** (Task 15). `RealModels` carries exact vendor-home strings, the person's HOME and recorded connectivity. Short-timing test configuration has no scripted overrides and no skipAuthChecks; parsed empty overrides stay empty. Forward recorded proxy/certificate variables and SSH_AUTH_SOCK as production does, without adding a refusing proxy or NODE_USE_SYSTEM_CA. Use supplied pins and skip requireE2e only in real mode; scripted binary overrides remain gated. Why: Claude's keychain identity depends on the home string, and the owner's remote git and managed network must behave as configured.
61. **Real mode cannot silently use scripts** (Task 15). `noScriptedModels` records nothing, answers false/empty reads and throws for program installation or server access. `liveDefaults` reads runner.json homes/connectivity or layout defaults and darwin-arm64 pins. `checkVendorHome` refuses missing homes before invoking only auth-status commands. Why: the manual run must use real preflight, while unit tests prove its configuration with fake CLIs and no login.
62. **Live options name vendors, not machine count** (Task 15). `--runners` selects vendors, with three runners per cluster; `--scenarios` accepts only the three exit names; `--takeover` is a separate vendor list, empty by default. Support spaced and equals option values, --repo, --keep and --help. Use 20-minute scenario waits, a Bun word-count toy CLI/test/research note and the scenario's goal (LOST_LEAD's when needed). Why: one fresh cluster per scenario/vendor preserves the same placement assumptions as e2e.
63. **A remote is explicitly disposable** (Task 15). `remoteOrigin` mirror-clones, refuses foreign refs or a main without `REMOTE_MAIN_SUBJECT`, then replaces main with the toy commit and pushes --mirror, deleting earlier run refs. Tests prove refused remotes unchanged. The local mirror refreshes before successful waits return. Why: fresh T-1 ids must not collide with an older run, and checks must read the origin that runners actually push to. Never supply a real project repository.
64. **Results are durable and comparable** (Tasks 15–16). Markdown and JSON use identical rows, escape pipes/newlines and treat an empty result set as failure. Save both after every cluster under `/tmp/agflow-live-*`. `inLiveCluster` never throws: failed start/body/close each becomes a failed row, including CLUSTER_CLOSED; do not retry memoized close. Why: one broken scenario must not erase earlier evidence or prevent the remaining checks.
65. **Terminal take-over is checked before hand-back** (Task 16). `runTakeoverCheck` first runs the common take-over checks, then `handedOver` requires ended state, no error, local command, real `.git` and vault alternates before git or person.handBack. Derive the person's commit from the hand-back sha, using the snapshot parent when needed; test that it is above the harvested head. Why: a failed take-over must never hand the person an unsafe clone or accidentally run git there.
66. **The person confirms actual session resumption** (Task 16). Print a dev sign-in link to the task, require Take over before the long command ends, print the local command in a subshell, and ask the person to commit b.txt from the resumed session. Then exit, leave the clone, close editors and hand back in the browser. Report changing refusal reasons and ask whether both resume and in-session commit worked; record that check only when the person can tell. Each step allows 30 minutes. Why: API-only tests cannot prove the terminal shows the old conversation, and an open cwd correctly blocks hand-back.
67. **Live script startup is ordered** (Task 16). Parse errors exit 2, help exits 0 without starting anything; check every needed vendor home (scenario and take-over vendors), then require the built web UI, then start clusters. Add `webDist` to hub/cluster options and test serving only when requested. The script is `caffeinate -i bun scripts/live-run.ts`. Its scripted stand-in e2e uses a local bare remote through the mirror. Why: missing setup fails before spending quota, and the terminal check needs the actual task page.
68. **The runbook records an unrun exit gate** (Task 16). Document every flag, `bun run live-run --takeover claude,codex`, exact homes/connectivity, safe take-over order, results, cleanup of read-only directories and optional real lid close on a second Mac. Leave the Results table empty for the owner's run. Why: SIGSTOP is only an approximation and automated evidence cannot stand in for a subscription/TTY check.
69. **README coverage is derived from code** (Task 17). Compare production AGFLOW_* reads with its config table in both directions, runner commands with CLI HELP, scripts with package.json and relative links with existing files. Describe operations, four security boundaries, managed devices/residual risks, UI, take-over, preparation, protected paths, restore, all gates and the live exit command. Why: hand-maintained lists otherwise drift as the seven plans add commands. Keep the smoke-hub temporary-directory leak as a separate owner follow-up; M2g does not edit that script.
70. **Original spec updates are summaries with real links** (Tasks 18–19). Keep live-chat §6.5. Name and check the three added transitions against core, replace mirror/worktree and exec-fallback text, and validate M2 heading anchors. Finish lead seats, API authority, link, security, recovery, testing, package layout, milestones, nested trust answer and all 17 review statuses. Rows 1–4, 6, 7, 11, 12 and 14–16 resolve in M2; 5 except rebut_review, which stays M3; 8–10 and 13 stay M3, 17 M4. Name M2a–M2g in M2's status without links to absent plan files. Why: the base contracts already implement these transitions, and the docs must not retain contradictory older rules.
71. **Accepted handoff notes are recorded without promising deferred fixes** (Task 19). M2 §18 records the accepted spec-update refinements: untrusted Codex still loads project skills; trusted MCP can start before refusal; explicit Claude preset and resume mismatch behavior; bridge/hook cwd and disabled Bun autoloading; Code Mode tool names that survive compaction; backup cadence; take-over state/actors; settings echo/replay behavior and its Known limits; durable late-work retries and cleanup; quota timers; and measured Claude sandbox/Bash limitations. The shell-profile mitigation is implemented: the adapter sets `ZDOTDIR=<claudeHome>/agflow-empty`, drops any incoming CLAUDE_CODE_SHELL, and sets `CLAUDE_CODE_SHELL=/bin/zsh` unless `basename(SHELL) === 'zsh'` (in which case the override is absent). Only the snapshot's ~/.zshrc runs outside the sandbox, once per process; ~/.zshenv, ~/.zprofile, ~/.zlogin and ~/.bashrc do not run around agent commands. The snapshot remains an accepted residual risk. Task 18 owns the new M2 §§5–6 edits; Task 19 carries the shell rule through §§3, 7.6, 8.2, 15 and 18 and records X-49 in §18. Two documentation regressions belong to each task; the final docs-spec suite has 46 tests. The §15 shell-profile check reads: “With either zsh or bash as the owner's SHELL, the snapshot sources ~/.zshrc once per Claude process; the other startup files do not run, and their functions and PATH changes do not reach agent commands.” X-49: a refused start sets Runner.stateDetail to `'refused a start: <code>'` until the next heartbeat. Attempt.stopRequested.by is `user:<login>`, `agent:<id>`, or system. A pending clone hand-back records handingBack with `by=user:<login>` and at in epoch milliseconds; another hand-back receives 409 handback_pending. Completion, refusal or timeout clears it. A fallback without returned clone work emits task.ready with { from, attemptId, reason }, not task.handed_back. Core exports reportHolds and utilization for the runner card. In §6.1 the declaration is `takeover: { local: string | null; anywhere: string; ref: string; error: string | null; handingBack: { by: string; at: number } | null } | null;`; §6.12 records pending hand-back and its refusal. Why: final docs must describe the shipped stack, while the exact-echo/lineage protocol fix belongs to a later milestone. Restore-only settings loss/divergence is not claimed fixed by the restore e2e. A submitted-head event on a non-WIP ref still exists for retention and can read as late work on the timeline even though no merge is needed; a distinguishing flag remains deferred. The web’s fixable-submit parity check stays, and its proposed core re-export cleanup is deferred too.

## Conventions for every task

- Start from `m2f-web` at `a661768c2473de34a0bde1bb2ea295d67f00c421`, and install once with `bun install --frozen-lockfile`. Use Bun, not Node. All commands below run from the repository root.
- A `(new)` block is the complete file; a `(change)` block is a unified diff. Apply test blocks before implementation blocks, tasks in order. Tests-only Tasks 11–13 intentionally have no invented red step. Each generated commit command preserves its mapped prototype commit's subject.
- In this restricted run, never execute generated git add/commit/apply commands or any other Git metadata write. The coordinator performs commits outside it. Read-only Git and scratch `git archive` copies are sufficient for generation and checking; no real worktrees are created here.
- Run each task's listed tests and typecheck. Full `bun test` and Linux CI run outside the restricted sandbox through the coordinator. Run a load-only failure alone before drawing a conclusion; never loosen a test to make it pass. No tests through git hooks or rebase --exec, and no exported GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE.
- Keep implementation changes within this plan's files. Missing base contracts go back to their owner with an exact change and test; never patch core, hub, runner, CLI or web here to make a scenario pass. This plan extends the shared git-fixtures file and adds its own root scripts and documentation as X-44 assigns.
- Use core names and schemas, real process helpers and existing vendor builders. The harness has its own entry and imports hub modules by path; it takes no dependency on the CLI. Worker tool arguments include task_id; lead write_handoff takes only note; send_message uses body; accept_task uses id. The old server-unit examples are not bridge schemas.
- Trigger faults only after observed state, and always wrap scenario bodies in `cluster.step`. Every e2e file sets the shared 600 s timeout. Do not call close from inside a step. Diagnose with the saved cluster dump, log tails and model requests; remove only the scratch directories belonging to that run after stopping their processes and making protected tool directories writable.
- Platform-neutral tests run on Ubuntu. A macOS-only check states “the runner supports darwin-arm64 only; design 7.1”; no missing prerequisite may silently skip an enabled e2e suite, and no macOS check is weakened for Linux.

### Gated end-to-end and live-run rules

- **Zero real-model use during implementation and verification.** Vendor sessions use only testkit servers on 127.0.0.1, scratch HOME/CLAUDE_CONFIG_DIR/CODEX_HOME/AGFLOW_HOME and test credentials. Never use the owner's credentials, keychain logins or real `~/.claude`, `~/.codex` or `~/.agflow`. Binary locators may read the already-installed pinned executable; for this restricted run supply explicit binary paths and a scratch AGFLOW_HOME rather than installing into the real home.
- `AGFLOW_E2E=1` enables only scripted end-to-end tests. `AGFLOW_E2E_VENDORS=claude,codex` is the default; narrow it only for diagnosis. `bun run e2e` sets the gate and runs `caffeinate -i bun test --timeout 600000 packages/testkit/e2e`. Use an Apple-silicon Mac on AC power with the pinned CLIs, git and lsof. Use the scratch provisioning commands below and export both binary paths before `bun run e2e`; never install or configure the owner's service as part of tests.
- Do not install a real LaunchAgent, call launchctl on the real user domain, post real notifications or bypass this Mac's Codex MDM policy. Do not work around nested sandbox failures. Commands needing vendor sandboxes run outside this sandbox through the coordinator; ordinary documentation and fake-CLI tests remain inside.
- **Only the owner's explicitly initiated live run may use real subscriptions.** After landing, the owner follows `docs/m2-live-run.md`, supplies the logged-in runner homes and pins from setup, builds the UI, then runs `bun run live-run --takeover claude,codex`. That command is never part of a task's passCommand. It consumes quota and deliberately uses the owner's production credentials/connectivity. The optional remote is disposable and reset by every cluster. Record its results in the runbook and PR; do not mark this exit gate done from scripted tests.

### Pinned binaries for verification

For implementation and verification, use existing pinned executables through `AGFLOW_CLAUDE_BIN` and `AGFLOW_CODEX_BIN`, or install into a newly created scratch directory using `AGFLOW_HOME=<scratch-home> bun run vendor:install`. Then explicitly set `AGFLOW_CLAUDE_BIN=<scratch-home>/runner/vendor/claude/2.1.285/claude` and `AGFLOW_CODEX_BIN=<scratch-home>/runner/vendor/codex/0.159.2/bin/codex`; the locators do not follow AGFLOW_HOME. Remove the scratch installation after all children exit. Do not run the installer without a scratch AGFLOW_HOME or install globally during implementation or verification.

For verification, install into a scratch directory and explicitly select both binaries. The test locators do not search AGFLOW_HOME.

```bash
AGFLOW_REVIEW_HOME=$(mktemp -d /tmp/agflow-vendors.XXXXXX)
AGFLOW_HOME="$AGFLOW_REVIEW_HOME" bun run vendor:install
export AGFLOW_CLAUDE_BIN="$AGFLOW_REVIEW_HOME/runner/vendor/claude/2.1.285/claude"
export AGFLOW_CODEX_BIN="$AGFLOW_REVIEW_HOME/runner/vendor/codex/0.159.2/bin/codex"
```

Keep this directory until verification finishes, then remove it. Wait for all children to exit before removal.

## File structure

```
packages/testkit/src/
  git-fixtures.ts             refSha, fileAt, isAncestor, cloneTo; existing fixtures remain shared
  harness/index.ts           (new) separate harness entry, extended as pieces land
  harness/env.ts             (new) e2e gate, selected vendors, prerequisite checks, timeout
  harness/proc.ts            (new) process trees, signals, safe lookup, waits and parent-exit cleanup
  harness/playbook.ts        (new) vendor-neutral programs, reactions, gates and reply compilation
  harness/models.ts          (new) scripted servers, recordings, grace for programs, session/history readers
  harness/hub-process.ts     (new) real main.ts lifecycle, backups, restore and optional webDist
  harness/person.ts          (new) dev sign-in, CLI token minting and typed person API
  harness/runner-process.ts  (new) isolated homes, binary links, real foreground runner and faults
  harness/cluster.ts         (new) hub, origin, models, three runners, waits, dumps and cleanup
  scenarios/result.ts        (new) named checks, safe clone reads, common helpers and snapshot subject
  scenarios/killed-agent.ts  (new) killed-worker driver and task text
  scenarios/closed-laptop.ts (new) freeze, lease failover, late-work recovery and merge
  scenarios/lost-lead.ts     (new) lead failover, message move and successor acceptance
  scenarios/takeover.ts      (new) setup and shared take-over/hand-back checks
  live.ts                    (new) owner-run options, homes, toy repo, tables, cluster and TTY orchestration
packages/testkit/test/
  harness-env.test.ts         (new) gate, pins and remedies with fake tools
  origin-readers.test.ts      (new) exact origin/ref/blob readers and working clone
  proc.test.ts                (new) real trees, groups, removed cwd and parent death
  playbook.test.ts            (new) routing, history, reactions, bounded gates and compiled cells
  models.test.ts              (new) server routing, recordings, program grace and session/history readers
  hub-process.test.ts         (new) real hub lifecycle, restore, person schemas and optional web serving
  runner-home.test.ts         (new) configuration, pins, environment, failed-start cleanup
  live.test.ts                (new) real-mode configuration with fake logins, args, remote and result tables
  live-run-script.test.ts     (new) help/refusal, runbook, script, failed take-over and failure results
  docs-readme.test.ts         (new) config variables, runner commands, root scripts and links
  docs-spec.test.ts           (new) transitions, M2 links, statuses, packages and design handoff notes
packages/testkit/e2e/
  runner-process.e2e.test.ts  (new) one real runner's lifecycle per vendor
  cluster.e2e.test.ts         (new) three-runner smoke and ungated root-script check
  killed-agent.e2e.test.ts    (new) exit criterion 1 and ungated result/helper tests
  closed-laptop.e2e.test.ts   (new) exit criterion 2
  lost-lead.e2e.test.ts       (new) exit criterion 3
  runner-restart.e2e.test.ts  (new) suspend and crash in separate clusters
  hub-restart.e2e.test.ts     (new) outage, WIP grace, replay and recovery nudge
  hub-restore.e2e.test.ts     (new) newer-fence replay before resume and epoch/counter names
  mid-turn-delivery.e2e.test.ts (new) vendor delivery timing, person authority and acknowledgement
  takeover.e2e.test.ts        (new) clone/ref hand-back and process_running refusal
  live-takeover.e2e.test.ts   (new) owner-run orchestration with a scripted stand-in and mirror origin
scripts/live-run.ts          (new) manual subscription run and terminal person
package.json                 e2e and live-run scripts
README.md                    M2 operations, boundaries, views, settings and development commands
docs/m2-live-run.md           (new) owner's runbook and empty Results table
docs/superpowers/specs/
  2026-10-26-agflow-design.md  summaries and links replacing superseded M1 rules; status column
  2026-10-28-m2-runners-design.md  implementation attribution and accepted handoff clarifications in §18
```

---

### Task 1: Harness: entry, e2e gating, origin readers and process control

The harness gets its own entry, packages/testkit/src/harness/index.ts, so the testkit's main index keeps importing runner types only (X-20). Gating keeps the e2e suite out of the default `bun test`: it runs only with AGFLOW_E2E=1, and then fails loudly when a prerequisite is missing instead of skipping. Scenarios check what reached the remote, so M2b's git fixtures gain refSha, fileAt, isAncestor and cloneTo (X-42). The faults act on real processes: freeze a runner's whole tree as a closed lid does, signal one process group, find processes whose cwd is in a clone. proc.ts builds these on M2b's parsePs and parseLsofCwds (X-42) and adds only the tree walk, the signals and the waits. The harness adds no dependency: it imports hub modules by path, as the scripts do, so packages/testkit/package.json and bun.lock stay M2b's (X-44).

**Files:**
- Modify: `packages/testkit/src/git-fixtures.ts`
- Create: `packages/testkit/src/harness/env.ts`
- Create: `packages/testkit/src/harness/index.ts`
- Create: `packages/testkit/src/harness/proc.ts`
- Test: `packages/testkit/test/harness-env.test.ts`
- Test: `packages/testkit/test/origin-readers.test.ts`
- Test: `packages/testkit/test/proc.test.ts`

- [ ] **Step 1: Write the failing tests**

**File:** `packages/testkit/test/harness-env.test.ts` (new)

```ts
import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VENDOR_PINS } from '@agflow/runner/src/vendor/pins';
import { describeE2e, e2eEnabled, e2eVendors, requireE2e } from '../src/harness/env';

const PINS = VENDOR_PINS['darwin-arm64'];
if (!PINS) throw new Error('VENDOR_PINS has no darwin-arm64 entry');

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agflow-e2e-env-'));
  dirs.push(dir);
  return dir;
}

// Each stub is written once per file and linked into place: macOS scans every new executable on its first run.
const stubs = mkdtempSync(join(tmpdir(), 'agflow-e2e-stubs-'));
process.on('exit', () => rmSync(stubs, { recursive: true, force: true }));
const claudeStub = join(stubs, 'claude');
writeFileSync(claudeStub, `#!/bin/sh\necho '${PINS.claude.version} (Claude Code)'\n`);
chmodSync(claudeStub, 0o755);
const codexStub = join(stubs, 'codex');
writeFileSync(codexStub, `#!/bin/sh\necho 'codex-cli ${PINS.codex.version}'\n`);
chmodSync(codexStub, 0o755);

const toolStub = join(stubs, 'tool');
writeFileSync(toolStub, '#!/bin/sh\nexit 0\n');
chmodSync(toolStub, 0o755);

/** A PATH directory that holds only the named tools, as stubs: requireE2e looks for them and runs none. */
function pathWith(...tools: string[]): string {
  const bin = join(tempDir(), 'bin');
  mkdirSync(bin);
  for (const tool of tools) symlinkSync(toolStub, join(bin, tool));
  return bin;
}

describe('e2eEnabled', () => {
  test('is true only with AGFLOW_E2E=1', () => {
    expect(e2eEnabled({})).toBe(false);
    expect(e2eEnabled({ AGFLOW_E2E: '0' })).toBe(false);
    expect(e2eEnabled({ AGFLOW_E2E: 'true' })).toBe(false);
    expect(e2eEnabled({ AGFLOW_E2E: '1' })).toBe(true);
  });
});

describe('e2eVendors', () => {
  test('defaults to claude and codex and honours AGFLOW_E2E_VENDORS', () => {
    expect(e2eVendors({})).toEqual(['claude', 'codex']);
    expect(e2eVendors({ AGFLOW_E2E_VENDORS: '' })).toEqual(['claude', 'codex']);
    expect(e2eVendors({ AGFLOW_E2E_VENDORS: 'codex' })).toEqual(['codex']);
    expect(e2eVendors({ AGFLOW_E2E_VENDORS: ' codex , claude,codex ' })).toEqual(['codex', 'claude']);
  });

  test('refuses an unknown vendor', () => {
    expect(() => e2eVendors({ AGFLOW_E2E_VENDORS: 'claude,gemini' })).toThrow(
      "AGFLOW_E2E_VENDORS names an unknown vendor 'gemini'",
    );
  });
});

describe('requireE2e', () => {
  test('refuses to run without AGFLOW_E2E=1', async () => {
    await expect(requireE2e({ env: {} })).rejects.toThrow('AGFLOW_E2E=1');
  });

  test('throws one message that names every missing prerequisite with its remedy', async () => {
    const env = { AGFLOW_E2E: '1', PATH: tempDir() };
    const error = await requireE2e({ env, platform: 'linux-x64', home: tempDir() }).then(
      () => null,
      (caught: Error) => caught,
    );
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('the e2e suite (AGFLOW_E2E=1) is missing its prerequisites');
    expect(message).toContain('darwin-arm64');
    expect(message).toContain('linux-x64');
    expect(message).toContain(`claude ${PINS.claude.version}`);
    expect(message).toContain('AGFLOW_CLAUDE_BIN');
    expect(message).toContain(`codex ${PINS.codex.version}`);
    expect(message).toContain('AGFLOW_CODEX_BIN');
    expect(message.match(/bun run vendor:install/g)?.length).toBe(2);
    expect(message).toContain('git is not on PATH');
    expect(message).toContain('lsof is not on PATH');
    expect(message.split('\n').filter((line) => line.startsWith('- '))).toHaveLength(5);
  });

  test('gives the located binaries when every prerequisite is there', async () => {
    const env = {
      AGFLOW_E2E: '1',
      AGFLOW_CLAUDE_BIN: claudeStub,
      AGFLOW_CODEX_BIN: codexStub,
      PATH: pathWith('git', 'lsof'),
    };
    const prereqs = await requireE2e({ env, platform: 'darwin-arm64', home: tempDir() });
    expect(prereqs).toEqual({
      vendors: ['claude', 'codex'],
      pins: PINS,
      binaries: { claude: claudeStub, codex: codexStub },
    });
  });

  test('requires only the vendors AGFLOW_E2E_VENDORS names', async () => {
    const env = { AGFLOW_E2E: '1', AGFLOW_E2E_VENDORS: 'claude', AGFLOW_CLAUDE_BIN: claudeStub };
    const prereqs = await requireE2e({
      env: { ...env, PATH: pathWith('git', 'lsof') },
      platform: 'darwin-arm64',
      home: tempDir(),
    });
    expect(prereqs.vendors).toEqual(['claude']);
    expect(prereqs.binaries).toEqual({ claude: claudeStub });
    const missing = await requireE2e({
      env: { ...env, AGFLOW_E2E_VENDORS: 'codex', PATH: pathWith('git', 'lsof') },
      platform: 'darwin-arm64',
      home: tempDir(),
    }).then(
      () => '',
      (caught: Error) => caught.message,
    );
    expect(missing).toContain(`codex ${PINS.codex.version}`);
    expect(missing).not.toContain('claude');
  });
});

describe('describeE2e', () => {
  let ran = false;
  describeE2e(
    'a gated suite',
    () => {
      test('never runs without AGFLOW_E2E', () => {
        ran = true;
      });
    },
    {},
  );

  test('skips its tests when AGFLOW_E2E is unset', () => {
    expect(ran).toBe(false);
  });
});
```

**File:** `packages/testkit/test/origin-readers.test.ts` (new)

```ts
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cloneTo,
  commitFiles,
  fileAt,
  gitIn,
  isAncestor,
  type OriginRepo,
  originRepo,
  refSha,
} from '../src/git-fixtures';

const origins: OriginRepo[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const origin of origins.splice(0)) origin.remove();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function origin(files: Record<string, string>): Promise<OriginRepo> {
  const made = await originRepo(files);
  origins.push(made);
  return made;
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agflow-readers-'));
  dirs.push(dir);
  return dir;
}

describe('refSha', () => {
  test("gives a ref's sha, by full or short name, and null for a missing ref", async () => {
    const repo = await origin({ 'a.txt': 'a\n' });
    const wip = await commitFiles(repo.path, { branch: 'agflow/T-1-feature', files: { 'b.txt': 'b\n' } });
    await gitIn(repo.path, ['update-ref', 'refs/agflow/wip/T-1-a1', wip]);
    expect(await refSha(repo.path, 'refs/heads/main')).toBe(repo.mainSha);
    expect(await refSha(repo.path, 'main')).toBe(repo.mainSha);
    expect(await refSha(repo.path, 'agflow/T-1-feature')).toBe(wip);
    expect(await refSha(repo.path, 'refs/agflow/wip/T-1-a1')).toBe(wip);
    expect(await refSha(repo.path, 'refs/agflow/wip/T-1-a2')).toBeNull();
    expect(await refSha(repo.path, 'refs/heads/missing')).toBeNull();
  });
});

describe('fileAt', () => {
  test('reads a file at a commit or ref exactly, and gives null for a missing file or revision', async () => {
    const repo = await origin({ 'a.txt': 'first\n\n', 'dir/b.txt': 'b' });
    const next = await commitFiles(repo.path, { branch: 'main', files: { 'a.txt': 'second\n', 'dir/b.txt': null } });
    expect(await fileAt(repo.path, repo.mainSha, 'a.txt')).toBe('first\n\n');
    expect(await fileAt(repo.path, repo.mainSha, 'dir/b.txt')).toBe('b');
    expect(await fileAt(repo.path, 'main', 'a.txt')).toBe('second\n');
    expect(await fileAt(repo.path, next, 'dir/b.txt')).toBeNull();
    expect(await fileAt(repo.path, 'refs/heads/missing', 'a.txt')).toBeNull();
    expect(await fileAt(repo.path, repo.mainSha, 'dir')).toBeNull();
  });
});

describe('isAncestor', () => {
  test('answers for two commits', async () => {
    const repo = await origin({ 'a.txt': 'a\n' });
    const topic = await commitFiles(repo.path, { branch: 'topic', files: { 'b.txt': 'b\n' } });
    const other = await commitFiles(repo.path, { branch: 'other', files: { 'c.txt': 'c\n' } });
    expect(await isAncestor(repo.path, repo.mainSha, topic)).toBe(true);
    expect(await isAncestor(repo.path, topic, topic)).toBe(true);
    expect(await isAncestor(repo.path, topic, repo.mainSha)).toBe(false);
    expect(await isAncestor(repo.path, topic, other)).toBe(false);
    await expect(isAncestor(repo.path, topic, 'f'.repeat(40))).rejects.toThrow(/merge-base/);
  });
});

describe('cloneTo', () => {
  test('makes a working clone that can commit and push back with plain git', async () => {
    const repo = await origin({ 'a.txt': 'a\n' });
    const work = join(tempDir(), 'person');
    expect(await cloneTo(repo.path, work)).toBe(work);
    expect(await Bun.file(join(work, 'a.txt')).text()).toBe('a\n');
    writeFileSync(join(work, 'b.txt'), 'b\n');
    // Plain git, as a person's terminal would run it: the clone carries its own identity.
    const git = (args: string[]) =>
      Bun.spawnSync(['git', ...args], {
        cwd: work,
        env: { PATH: process.env.PATH, HOME: tempDir(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
        stdout: 'pipe',
        stderr: 'pipe',
      });
    expect(git(['add', 'b.txt']).exitCode).toBe(0);
    expect(git(['commit', '--quiet', '-m', 'add b']).exitCode).toBe(0);
    expect(git(['push', '--quiet', 'origin', 'HEAD:refs/heads/person']).exitCode).toBe(0);
    const pushed = (await refSha(repo.path, 'refs/heads/person')) as string;
    expect(await fileAt(repo.path, pushed, 'b.txt')).toBe('b\n');
    expect(await isAncestor(repo.path, repo.mainSha, pushed)).toBe(true);
  });

  test('checks out a given branch', async () => {
    const repo = await origin({ 'a.txt': 'a\n' });
    const topic = await commitFiles(repo.path, { branch: 'agflow/T-2-x', files: { 'c.txt': 'c\n' } });
    const work = join(tempDir(), 'clone');
    await cloneTo(repo.path, work, { branch: 'agflow/T-2-x' });
    expect(await gitIn(work, ['rev-parse', 'HEAD'])).toBe(topic);
    expect(await gitIn(work, ['symbolic-ref', '--short', 'HEAD'])).toBe('agflow/T-2-x');
    expect(existsSync(join(work, 'c.txt'))).toBe(true);
  });
});
```

**File:** `packages/testkit/test/proc.test.ts` (new)

```ts
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  descendantsOf,
  freezeTree,
  isAlive,
  listProcesses,
  processesInDir,
  signalGroup,
  thawTree,
  waitUntilGone,
} from '../src/harness/proc';

const pids = new Set<number>();
const dirs: string[] = [];
afterEach(() => {
  for (const pid of pids) {
    for (const signal of ['SIGCONT', 'SIGKILL'] as const) {
      try {
        process.kill(pid, signal);
      } catch {
        // Already gone.
      }
    }
  }
  pids.clear();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Why the tests that look for processes by their cwd do not run here, or null: they need lsof, which macOS ships. */
const NO_LSOF =
  process.platform !== 'darwin' && Bun.which('lsof') === null
    ? 'lsof is not on PATH; the runner supports darwin-arm64 only (design 7.1), where /usr/sbin has it'
    : null;

/** Why the tests of what macOS's lsof reports do not run here, or null. */
const NOT_MACOS = process.platform !== 'darwin' ? 'the runner supports darwin-arm64 only; design 7.1' : null;

/** test, or test.skip with the reason in its title, so a skipped run says why. */
function testUnless(reason: string | null): (name: string, body: () => Promise<void>) => void {
  return (name, body) => (reason === null ? test(name, body) : test.skip(`${name} (skipped: ${reason})`, body));
}

/** A directory under /tmp, given by its /tmp path, which is a link to /private/tmp on macOS. */
function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join('/tmp', prefix));
  dirs.push(dir);
  return dir;
}

/** Starts a shell script as the leader of its own group, as the runner starts agents. */
function spawnGroup(script: string, options: { cwd?: string } = {}) {
  const proc = Bun.spawn(['sh', '-c', script], {
    cwd: options.cwd,
    detached: true,
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
  });
  pids.add(proc.pid);
  return proc;
}

async function until(check: () => Promise<boolean> | boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out waiting for a condition');
    await Bun.sleep(20);
  }
}

/** The pid a script wrote to file, once the file holds a whole line. */
async function pidFrom(file: string): Promise<number> {
  let text = '';
  await until(() => {
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      return false;
    }
    return text.endsWith('\n');
  });
  const pid = Number(text.trim());
  pids.add(pid);
  return pid;
}

/**
 * sh with a background sleep in its group, a background sleep that leads a group of its own, and a nested sh whose
 * sleep is a grandchild. Each pid goes to a file of its own in dir.
 */
async function spawnTree(dir: string) {
  const script = [
    `sleep 31 & echo $! > ${dir}/child`,
    `perl -e 'setpgrp(0, 0); exec @ARGV' sleep 32 & echo $! > ${dir}/own`,
    `sh -c 'sleep 33 & echo $! > ${dir}/grandchild; wait' & echo $! > ${dir}/nested`,
    'wait',
  ].join('\n');
  const root = spawnGroup(script);
  const [child, ownGroup, nested, grandchild] = await Promise.all(
    ['child', 'own', 'nested', 'grandchild'].map((name) => pidFrom(join(dir, name))),
  );
  await until(async () => (await listProcesses([ownGroup as number]))[0]?.pgid === ownGroup);
  return {
    root: root.pid,
    child: child as number,
    ownGroup: ownGroup as number,
    nested: nested as number,
    grandchild: grandchild as number,
  };
}

async function stats(list: number[]): Promise<Map<number, string>> {
  return new Map((await listProcesses(list)).map((row) => [row.pid, row.stat]));
}

describe('descendantsOf', () => {
  test('finds the children and grandchildren of a spawned tree and no unrelated process', async () => {
    const tree = await spawnTree(tmpDir('agflow-proc-'));
    const unrelated = spawnGroup('exec sleep 34');
    const found = await descendantsOf(tree.root);
    expect(found.map((row) => row.pid).sort((a, b) => a - b)).toEqual(
      [tree.child, tree.ownGroup, tree.nested, tree.grandchild].sort((a, b) => a - b),
    );
    expect(found.find((row) => row.pid === tree.ownGroup)?.pgid).toBe(tree.ownGroup);
    expect(found.find((row) => row.pid === tree.child)?.pgid).toBe(tree.root);
    expect(found.map((row) => row.pid)).not.toContain(unrelated.pid);
    expect(found.map((row) => row.pid)).not.toContain(tree.root);
    expect(await descendantsOf(unrelated.pid)).toEqual([]);
  });
});

describe('freezeTree and thawTree', () => {
  test('freeze stops the root first, then every descendant; thaw resumes them all', async () => {
    const tree = await spawnTree(tmpDir('agflow-proc-'));
    const all = [tree.root, tree.child, tree.ownGroup, tree.nested, tree.grandchild];
    const frozen = await freezeTree(tree.root);
    expect(frozen[0]).toBe(tree.root);
    expect([...frozen].sort((a, b) => a - b)).toEqual([...all].sort((a, b) => a - b));
    await until(async () => [...(await stats(all)).values()].every((stat) => stat.startsWith('T')));
    const thawed = await thawTree(tree.root);
    expect([...thawed].sort((a, b) => a - b)).toEqual([...all].sort((a, b) => a - b));
    await until(async () => [...(await stats(all)).values()].every((stat) => !stat.startsWith('T')));
    expect((await stats(all)).size).toBe(all.length);
  });
});

describe('signalGroup', () => {
  test('kills every member of a detached group and leaves the test process alive', async () => {
    const dir = tmpDir('agflow-proc-');
    const root = spawnGroup(`sleep 35 & echo $! > ${dir}/first; sleep 36 & echo $! > ${dir}/second; wait`);
    const members = await Promise.all([pidFrom(join(dir, 'first')), pidFrom(join(dir, 'second'))]);
    expect(await signalGroup(root.pid, 'SIGKILL')).toBe(true);
    for (const pid of [root.pid, ...members]) await waitUntilGone(pid, { timeoutMs: 5_000 });
    expect(await isAlive(process.pid)).toBe(true);
    // The group is gone now: nothing is signalled.
    expect(await signalGroup(root.pid, 'SIGKILL')).toBe(false);
  });

  test("refuses group 0, group 1 and the test process's own group", async () => {
    const own = (await listProcesses([process.pid]))[0]?.pgid as number;
    for (const pgid of [0, 1, own]) {
      await expect(signalGroup(pgid, 'SIGTERM')).rejects.toThrow(/refusing to signal group/);
    }
    expect(await isAlive(process.pid)).toBe(true);
  });
});

describe('processesInDir', () => {
  testUnless(NO_LSOF)(
    'finds a process whose cwd is inside a directory given by its /tmp or /private/tmp path',
    async () => {
      const dir = tmpDir('agflow-proc-dir-');
      mkdirSync(join(dir, 'work', 'T-1-a1'), { recursive: true });
      const outside = tmpDir('agflow-proc-out-');
      const inside = spawnGroup('exec sleep 37', { cwd: join(dir, 'work', 'T-1-a1') });
      const elsewhere = spawnGroup('exec sleep 38', { cwd: outside });
      await until(async () => (await processesInDir(dir)).length > 0);
      for (const given of [dir, realpathSync(dir)]) {
        const found = await processesInDir(given);
        expect(found.map((row) => row.pid)).toEqual([inside.pid]);
        expect(found[0]?.command).toContain('sleep 37');
      }
      expect((await processesInDir(outside)).map((row) => row.pid)).toEqual([elsewhere.pid]);
    },
  );

  // A removed cwd is found by the resolved path macOS's lsof reports for it.
  testUnless(NOT_MACOS)(
    'finds a process whose cwd was removed under either path; a path that never existed gives nothing',
    async () => {
      const dir = tmpDir('agflow-proc-gone-');
      const clone = join(dir, 'work', 'demo', 'T-1-a1');
      mkdirSync(clone, { recursive: true });
      const survivor = spawnGroup('exec sleep 40', { cwd: clone });
      await until(async () => (await processesInDir(dir)).length > 0);
      // Remove the whole tree above the clone, as a cleanup that runs while something still works in it.
      rmSync(join(dir, 'work'), { recursive: true, force: true });
      for (const given of [clone, join(realpathSync(dir), 'work', 'demo', 'T-1-a1'), dir]) {
        expect((await processesInDir(given)).map((row) => row.pid)).toEqual([survivor.pid]);
      }
      expect(await processesInDir(join(dir, 'missing'))).toEqual([]);
    },
  );

  test('refuses a relative path', async () => {
    await expect(processesInDir('work/demo')).rejects.toThrow('not absolute');
  });
});

describe('waitUntilGone', () => {
  test('resolves when a pid exits, and rejects naming the pid after its timeout', async () => {
    const short = spawnGroup('sleep 0.2');
    await waitUntilGone(short.pid, { timeoutMs: 5_000 });
    expect(await isAlive(short.pid)).toBe(false);
    const long = spawnGroup('exec sleep 39');
    await expect(waitUntilGone(long.pid, { timeoutMs: 200 })).rejects.toThrow(
      `process ${long.pid} is still running after 200 ms`,
    );
    expect(await isAlive(long.pid)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `bun test packages/testkit/test/harness-env.test.ts packages/testkit/test/origin-readers.test.ts packages/testkit/test/proc.test.ts`
Expected: FAIL — error: Cannot find module '../src/harness/env' from '.../packages/testkit/test/harness-env.test.ts' (same for ../src/harness/proc); origin-readers: SyntaxError: Export named 'fileAt' not found in module '.../packages/testkit/src/git-fixtures.ts'

- [ ] **Step 3: Implement**

**File:** `packages/testkit/src/git-fixtures.ts` (change)

```diff
diff --git a/packages/testkit/src/git-fixtures.ts b/packages/testkit/src/git-fixtures.ts
index 25f27e0e..9c12d4ab 100644
--- a/packages/testkit/src/git-fixtures.ts
+++ b/packages/testkit/src/git-fixtures.ts
@@ -47,8 +47,12 @@ const FIXTURE_FLAGS = [
   'init.defaultBranch=main',
 ];
 
-/** Runs git in dir and gives its trimmed output. It throws with git's own message when git fails. */
-export async function gitIn(dir: string, args: string[], options: GitInOptions = {}): Promise<string> {
+/** Runs git in dir with the fixture flags and the clean environment; the output is left as git wrote it. */
+async function runGit(
+  dir: string,
+  args: string[],
+  options: GitInOptions = {},
+): Promise<{ code: number; stdout: string; stderr: string }> {
   const proc = Bun.spawn(['git', ...FIXTURE_FLAGS, ...args], {
     cwd: dir,
     env: cleanEnv(options.env),
@@ -61,9 +65,19 @@ export async function gitIn(dir: string, args: string[], options: GitInOptions =
     new Response(proc.stderr).text(),
     proc.exited,
   ]);
-  if (code === 0) return stdout.trim();
+  return { code, stdout, stderr };
+}
+
+function gitFailure(dir: string, args: string[], result: { code: number; stderr: string }): Error {
+  return new Error(`git ${args.join(' ')} failed (exit ${result.code}) in ${dir}: ${result.stderr.trim()}`);
+}
+
+/** Runs git in dir and gives its trimmed output. It throws with git's own message when git fails. */
+export async function gitIn(dir: string, args: string[], options: GitInOptions = {}): Promise<string> {
+  const result = await runGit(dir, args, options);
+  if (result.code === 0) return result.stdout.trim();
   if (options.allowFailure) return '';
-  throw new Error(`git ${args.join(' ')} failed (exit ${code}) in ${dir}: ${stderr.trim()}`);
+  throw gitFailure(dir, args, result);
 }
 
 export interface OriginRepo {
@@ -135,3 +149,47 @@ export async function commitFiles(origin: string, change: FileChange): Promise<s
     rmSync(work, { recursive: true, force: true });
   }
 }
+
+// Readers for what reached a remote (M2g, X-42): end-to-end scenarios check refs and files on the origin itself.
+
+/** The sha a ref names in the repository (a full ref or a short name such as a branch), or null when it is missing. */
+export async function refSha(repo: string, ref: string): Promise<string | null> {
+  return (await gitIn(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFailure: true })) || null;
+}
+
+/** A file's exact content at a commit or ref, or null when the revision or the file (a blob) does not exist. */
+export async function fileAt(repo: string, rev: string, path: string): Promise<string | null> {
+  const object = `${rev}:${path}`;
+  const type = await gitIn(repo, ['cat-file', '-t', object], { allowFailure: true });
+  if (type !== 'blob') return null;
+  const result = await runGit(repo, ['cat-file', 'blob', object]);
+  if (result.code !== 0) throw gitFailure(repo, ['cat-file', 'blob', object], result);
+  return result.stdout;
+}
+
+/** Whether ancestor is descendant or one of its ancestors; an unknown commit throws. */
+export async function isAncestor(repo: string, ancestor: string, descendant: string): Promise<boolean> {
+  const args = ['merge-base', '--is-ancestor', ancestor, descendant];
+  const result = await runGit(repo, args);
+  if (result.code === 0) return true;
+  if (result.code === 1) return false;
+  throw gitFailure(repo, args, result);
+}
+
+export interface CloneToOptions {
+  /** The branch to check out; the origin's HEAD by default. */
+  branch?: string;
+}
+
+/**
+ * Clones the origin into dir as a person's working clone. The clone's own config holds the fixture identity, so plain
+ * git can commit there, and origin is its remote, so it can push back. Gives dir.
+ */
+export async function cloneTo(origin: string, dir: string, options: CloneToOptions = {}): Promise<string> {
+  mkdirSync(dirname(dir), { recursive: true });
+  const branch = options.branch === undefined ? [] : ['--branch', options.branch];
+  await gitIn(dirname(dir), ['clone', '--quiet', ...branch, origin, dir]);
+  await gitIn(dir, ['config', 'user.name', FIXTURE_IDENTITY.name]);
+  await gitIn(dir, ['config', 'user.email', FIXTURE_IDENTITY.email]);
+  return dir;
+}
```

**File:** `packages/testkit/src/harness/env.ts` (new)

```ts
// The end-to-end gate (design 15, X-20). The e2e suite stays out of the default `bun test`: it runs only with
// AGFLOW_E2E=1, and then it fails, naming every missing prerequisite and its remedy, instead of skipping.
import { beforeAll, describe } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type Vendor, VendorSchema } from '@agflow/core';
import { findCodexBinary } from '@agflow/runner/src/adapters/codex/binary';
import { runnerPaths } from '@agflow/runner/src/paths';
import { type PlatformPins, VENDOR_PINS, vendorBinary } from '@agflow/runner/src/vendor/pins';
import { findClaudeBinary } from '../anthropic/binary';

type Env = Record<string, string | undefined>;

const VENDORS: readonly Vendor[] = VendorSchema.options;

/** The one platform M2 pins vendor binaries for, so the one the e2e suite runs on. */
export const E2E_PLATFORM = 'darwin-arm64';

/** Locating both binaries runs each candidate's --version; a cold first run on macOS takes seconds. */
const PREREQS_TIMEOUT_MS = 60_000;

export function e2eEnabled(env: Env = process.env): boolean {
  return env.AGFLOW_E2E === '1';
}

/** The vendors the scenarios run for: AGFLOW_E2E_VENDORS (comma-separated), or both. */
export function e2eVendors(env: Env = process.env): Vendor[] {
  const named = (env.AGFLOW_E2E_VENDORS ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  if (named.length === 0) return [...VENDORS];
  const vendors: Vendor[] = [];
  for (const name of named) {
    if (!(VENDORS as readonly string[]).includes(name)) {
      throw new Error(`AGFLOW_E2E_VENDORS names an unknown vendor '${name}'; use ${VENDORS.join(' and/or ')}`);
    }
    if (!vendors.includes(name as Vendor)) vendors.push(name as Vendor);
  }
  return vendors;
}

/** What the e2e suite found: the vendors it runs for, their pins, and the located pinned binary of each. */
export interface E2ePrereqs {
  vendors: Vendor[];
  pins: PlatformPins;
  binaries: Partial<Record<Vendor, string>>;
}

export interface RequireE2eOptions {
  /** process.env by default: AGFLOW_E2E, AGFLOW_E2E_VENDORS, the binary variables and PATH. */
  env?: Env;
  /** `<platform>-<arch>`; this machine's by default. */
  platform?: string;
  /** The home whose ~/.agflow/runner/vendor the locators search; the real home by default. */
  home?: string;
}

let located: Promise<E2ePrereqs> | null = null;

/**
 * Checks every prerequisite of the e2e suite and gives the located binaries; it throws one error that names each
 * missing prerequisite with its remedy. Without options the answer is computed once per process.
 */
export function requireE2e(options: RequireE2eOptions = {}): Promise<E2ePrereqs> {
  if (Object.keys(options).length > 0) return checkPrereqs(options);
  located ??= checkPrereqs({});
  return located;
}

async function checkPrereqs(options: RequireE2eOptions): Promise<E2ePrereqs> {
  const env = options.env ?? process.env;
  if (!e2eEnabled(env)) throw new Error('the e2e suite runs only with AGFLOW_E2E=1');
  const platform = options.platform ?? `${process.platform}-${process.arch}`;
  const home = options.home ?? homedir();
  const pins = VENDOR_PINS[E2E_PLATFORM];
  if (!pins) throw new Error(`VENDOR_PINS has no ${E2E_PLATFORM} entry`);
  const vendors = e2eVendors(env);
  const missing: string[] = [];
  if (platform !== E2E_PLATFORM) {
    missing.push(`a Mac on Apple silicon (${E2E_PLATFORM}), the only platform with vendor pins; this is ${platform}`);
  }
  const binaries: Partial<Record<Vendor, string>> = {};
  if (vendors.includes('claude')) {
    const found = findClaudeBinary(pins.claude.version, { env, home });
    if (found.path === null) missing.push(found.reason);
    else binaries.claude = found.path;
  }
  if (vendors.includes('codex')) {
    const found = await findCodexBinary({ env, home });
    if (found === null) {
      const version = pins.codex.version;
      const vendored = join(runnerPaths(join(home, '.agflow')).runner, vendorBinary('codex', version));
      const explicit = env.AGFLOW_CODEX_BIN ? `AGFLOW_CODEX_BIN ${env.AGFLOW_CODEX_BIN}` : 'AGFLOW_CODEX_BIN (not set)';
      missing.push(
        `no codex ${version}: neither ${explicit} nor ${vendored} is codex ${version}. ` +
          `Set AGFLOW_CODEX_BIN to a codex ${version} binary, or run \`bun run vendor:install\`.`,
      );
    } else {
      binaries.codex = found;
    }
  }
  const path = env.PATH ?? '';
  if (Bun.which('git', { PATH: path }) === null) {
    missing.push('git is not on PATH: install the Xcode command line tools (`xcode-select --install`).');
  }
  if (Bun.which('lsof', { PATH: path }) === null) {
    missing.push('lsof is not on PATH: macOS ships it in /usr/sbin; add /usr/sbin to PATH.');
  }
  if (missing.length > 0) {
    throw new Error(
      `the e2e suite (AGFLOW_E2E=1) is missing its prerequisites:\n${missing.map((line) => `- ${line}`).join('\n')}`,
    );
  }
  return { vendors, pins, binaries };
}

/**
 * describe for an e2e suite: skipped unless AGFLOW_E2E=1. When it runs, a missing prerequisite fails every test in it,
 * through requireE2e in its beforeAll.
 */
export function describeE2e(name: string, body: () => void, env: Env = process.env): void {
  if (!e2eEnabled(env)) {
    describe.skip(name, body);
    return;
  }
  describe(name, () => {
    beforeAll(async () => {
      await (env === process.env ? requireE2e() : requireE2e({ env }));
    }, PREREQS_TIMEOUT_MS);
    body();
  });
}
```

**File:** `packages/testkit/src/harness/index.ts` (new)

```ts
// The multi-runner e2e harness (design 15, X-20). It has its own entry, so the testkit's main index keeps importing
// runner types only; the harness imports runner and hub modules by path and adds no dependency (X-44).
export * from './env';
export * from './proc';
```

**File:** `packages/testkit/src/harness/proc.ts` (new)

```ts
// Process control for the e2e faults (design 1, 7.4): freeze a runner's whole tree as a closed lid does, signal one
// process group, find what still runs in a directory, wait for a process to go. The ps and lsof readers are M2b's
// (X-42); only this file follows their names, and it adds the tree walk, the signals and the waits.
import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { findCloneProcesses, listProcesses as psRows, type PsRow } from '@agflow/runner/src/processes';

/** One process as ps shows it: pid, ppid, pgid, stat (T when stopped, Z for a zombie), lstart and command. */
export type ProcessInfo = PsRow;

/** Every process, or only the given pids, from one ps call. */
export function listProcesses(pids?: readonly number[]): Promise<ProcessInfo[]> {
  return psRows(pids);
}

/** True while the pid runs or is stopped; a zombie, exited but not yet reaped, counts as gone. */
export async function isAlive(pid: number): Promise<boolean> {
  const row = (await listProcesses([pid])).find((candidate) => candidate.pid === pid);
  return row !== undefined && !row.stat.startsWith('Z');
}

/** Every live descendant of pid in one ps snapshot, children before grandchildren; pid itself is left out. */
export async function descendantsOf(pid: number): Promise<ProcessInfo[]> {
  return descendantsIn(await listProcesses(), pid);
}

function descendantsIn(rows: ProcessInfo[], root: number): ProcessInfo[] {
  const children = new Map<number, ProcessInfo[]>();
  for (const row of rows) {
    if (row.stat.startsWith('Z')) continue;
    const siblings = children.get(row.ppid);
    if (siblings) siblings.push(row);
    else children.set(row.ppid, [row]);
  }
  const found: ProcessInfo[] = [];
  const queue = [...(children.get(root) ?? [])];
  const seen = new Set([root]);
  for (let row = queue.shift(); row !== undefined; row = queue.shift()) {
    if (seen.has(row.pid)) continue;
    seen.add(row.pid);
    found.push(row);
    queue.push(...(children.get(row.pid) ?? []));
  }
  return found;
}

/** Sends a signal to one pid; false when it is already gone. */
function signalPid(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

/**
 * Stops pid and everything under it, as a closed lid does. The root stops first, so it cannot start or reap anything
 * while its descendants are stopped one by one (each pid, not each group: agents lead groups of their own). It walks
 * the tree again until a pass finds nothing new, and gives the stopped pids, the root first.
 */
export async function freezeTree(pid: number): Promise<number[]> {
  if (!signalPid(pid, 'SIGSTOP')) throw new Error(`cannot freeze process ${pid}: it is not running`);
  const frozen = [pid];
  for (;;) {
    const fresh = (await descendantsOf(pid)).filter((row) => !frozen.includes(row.pid));
    if (fresh.length === 0) return frozen;
    for (const row of fresh) {
      if (signalPid(row.pid, 'SIGSTOP')) frozen.push(row.pid);
    }
  }
}

/** Resumes pid's descendants, then pid itself, and gives the resumed pids. */
export async function thawTree(pid: number): Promise<number[]> {
  const thawed: number[] = [];
  for (const row of (await descendantsOf(pid)).reverse()) {
    if (signalPid(row.pid, 'SIGCONT')) thawed.push(row.pid);
  }
  if (signalPid(pid, 'SIGCONT')) thawed.push(pid);
  return thawed;
}

/**
 * Signals every member of a process group, such as one attempt's agent. Gives false when the group is gone. Groups 0
 * and 1 and the test process's own group are refused: those signals would reach the test itself or every process the
 * user owns.
 */
export async function signalGroup(pgid: number, signal: NodeJS.Signals): Promise<boolean> {
  const own = (await listProcesses([process.pid])).find((row) => row.pid === process.pid)?.pgid;
  if (!Number.isInteger(pgid) || pgid <= 1 || pgid === own) {
    throw new Error(`refusing to signal group ${pgid}: it would reach the test process or every user process`);
  }
  try {
    process.kill(-pgid, signal);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // EPERM: on macOS, a group whose members are all zombies.
    if (code === 'ESRCH' || code === 'EPERM') return false;
    throw error;
  }
}

/**
 * The path with its nearest existing ancestor resolved: lsof reports resolved paths, even for a cwd that was removed,
 * so /tmp/x/gone must become /private/tmp/x/gone on macOS.
 */
function resolveExisting(path: string): string {
  const missing: string[] = [];
  for (let current = path; ; current = dirname(current)) {
    try {
      return join(realpathSync(current), ...missing.reverse());
    } catch {
      if (dirname(current) === current) return path;
      missing.push(basename(current));
    }
  }
}

/**
 * The user's processes whose cwd is dir or inside it, through M2b's clone search (X-42), zombies left out. dir may be
 * given by its /tmp or its /private/tmp path, and may already be removed while a process still has its cwd there.
 */
export async function processesInDir(dir: string): Promise<ProcessInfo[]> {
  const found = await findCloneProcesses(isAbsolute(dir) ? resolveExisting(dir) : dir);
  if (found.skipped !== null) throw new Error(found.skipped);
  return found.processes.filter((row) => !row.stat.startsWith('Z'));
}

export interface WaitOptions {
  /** 10 s by default. */
  timeoutMs?: number;
  /** 50 ms by default. */
  intervalMs?: number;
}

/** Resolves once pid is gone (a zombie counts as gone); rejects, naming the pid, after the timeout. */
export async function waitUntilGone(pid: number, options: WaitOptions = {}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const deadline = Date.now() + timeoutMs;
  while (await isAlive(pid)) {
    if (Date.now() >= deadline) throw new Error(`process ${pid} is still running after ${timeoutMs} ms`);
    await Bun.sleep(options.intervalMs ?? 50);
  }
}
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `bun test packages/testkit/test/harness-env.test.ts packages/testkit/test/origin-readers.test.ts packages/testkit/test/proc.test.ts && bun run typecheck`
Expected: all selected tests pass (0 fail); tsc exits 0.

The gate tests use stub executables, so this command needs no installed vendor CLI. processesInDir reuses M2b findCloneProcesses and resolves the nearest surviving path ancestor; the final Task 1 includes the removed-cwd and Linux fixes. The removed-cwd test is macOS-only; an ordinary cwd test skips off macOS only if lsof is absent. Neither can skip for missing lsof on macOS. Group signals refuse the test process’s group. See Decisions 19–23.

- [ ] **Step 5: Commit**

```bash
git add -A 'packages/testkit/src/git-fixtures.ts' 'packages/testkit/src/harness/env.ts' 'packages/testkit/src/harness/index.ts' 'packages/testkit/src/harness/proc.ts' 'packages/testkit/test/harness-env.test.ts' 'packages/testkit/test/origin-readers.test.ts' 'packages/testkit/test/proc.test.ts'
git commit -m 'M2G Task 1: Harness: entry, e2e gating, origin readers and process control' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

### Task 2: Harness: vendor-neutral agent playbooks

Design 15.1: the scripted servers answer from request content, never from request order. A playbook maps attempt ids to programs. A program is a list of steps (a shell command, an agflow tool call, optional text before the call, a gate) plus reactions to messages injected into the conversation. The attempt id comes only from the agent's own clone path (work/<project>/<attempt>), which the brief's 'Your working directory' line (X-17) and the vendor's environment context carry, so a handoff note that names an earlier attempt cannot mislead it. The next step comes from the history: step n's tool call id encodes n, so a retried request gets the same answer and a resumed session continues where it stopped. A gate is one perl command that waits for a file under the clone's runner-owned .agflow/run/e2e/, which harvests, snapshots and the file watcher ignore (design 7.3, 7.5): Claude Code 2.1.285 denies a shell loop with expansions in a runner session without running it, so a step Claude Code denied is a playbook error, not the step's result. The task is pure: steps compile through M2d's and M2e's builders. For Codex they are Code Mode exec cells (X-20), and a cell for a long command or a gate must not yield before the step's timeout (see decisions).

**Files:**
- Modify: `packages/testkit/src/harness/index.ts`
- Create: `packages/testkit/src/harness/playbook.ts`
- Test: `packages/testkit/test/playbook.test.ts`

- [ ] **Step 1: Write the failing test**

**File:** `packages/testkit/test/playbook.test.ts` (new)

```ts
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AnthropicRequest, parseAnthropicRequest } from '../src/anthropic/request';
import { parseResponsesRequest, type ResponsesRequest } from '../src/codex/request';
import {
  attemptIdIn,
  BASH_MAX_TIMEOUT_MS,
  CLOSING_TEXT,
  claudeReply,
  codexReply,
  GATE_DIR,
  gate,
  nextStep,
  PLAYBOOK_ERROR,
  type Program,
  react,
  say,
  shell,
  tool,
} from '../src/harness/playbook';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agflow-playbook-'));
  dirs.push(dir);
  return dir;
}

const HOME = '/private/tmp/agf-e2e/r2';
const clone = (attempt: string) => `${HOME}/work/demo/${attempt}`;
const TOOLS = ['Bash', 'Read', 'mcp__agflow__submit'].map((name) => ({ name, description: name, input_schema: {} }));

/** A brief as the runner builds it: the hub's text, then its own "Your working directory" line (X-17). */
function brief(attempt: string, note = ''): string {
  return `You are a worker on T-7.\n${note}\n\nYour working directory: ${clone(attempt)}`;
}

/**
 * The role 'system' entry Claude Code 2.1.285 sends near the start of the messages: the SessionStart hook's brief,
 * then its own environment section, which names the clone's resolved path.
 */
function claudeContext(attempt: string, note = ''): string {
  return [
    `SessionStart hook additional context: ${brief(attempt, note)}`,
    '',
    '# Environment',
    'You have been invoked in the following environment: ',
    ` - Primary working directory: ${clone(attempt)}`,
    ' - Is a git repository: true',
  ].join('\n');
}

function claudeRequest(body: Record<string, unknown>): AnthropicRequest {
  return parseAnthropicRequest({ model: 'claude-test', stream: true, tools: TOOLS, ...body }, {});
}

function codexRequest(input: unknown[]): ResponsesRequest {
  return parseResponsesRequest(
    { model: 'gpt-test', input },
    { index: 0, method: 'POST', path: '/v1/responses', headers: {} },
  );
}

const userText = (value: string) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text: value }] });
const developer = (value: string) => ({
  type: 'message',
  role: 'developer',
  content: [{ type: 'input_text', text: value }],
});
const environment = (cwd: string) => userText(`<environment_context>\n  <cwd>${cwd}</cwd>\n</environment_context>`);

describe('attemptIdIn', () => {
  test('reads the attempt from the hook context and environment entry Claude Code 2.1.285 sends', () => {
    const note = ['Handoff note from T-7-a1:', `> Your working directory: ${clone('T-7-a1')}`].join('\n');
    for (const attempt of ['T-7-a2', 'T-7-e2-a1', 'lead-a3']) {
      const request = claudeRequest({
        system: 'You are Claude Code.',
        messages: [
          { role: 'user', content: 'Start the task.' },
          { role: 'system', content: [{ type: 'text', text: claudeContext(attempt, note) }] },
        ],
      });
      expect(attemptIdIn(request)).toBe(attempt);
    }
    // A message delivered later that names another clone comes after the agent's own context, so it cannot win.
    const later = claudeRequest({
      system: 'You are Claude Code.',
      messages: [
        { role: 'user', content: 'Start the task.' },
        { role: 'system', content: [{ type: 'text', text: claudeContext('T-7-a2') }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'e2e-s0', name: 'Bash', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'e2e-s0', content: 'ok' }] },
        { role: 'system', content: [{ type: 'text', text: `From lead:\nYour working directory: ${clone('T-7-a1')}` }] },
      ],
    });
    expect(attemptIdIn(later)).toBe('T-7-a2');
  });

  test('reads the attempt from a Claude system prompt or a brief in a user entry', () => {
    const fromSystem = claudeRequest({
      system: [
        { type: 'text', text: 'You are Claude Code.' },
        {
          type: 'text',
          text: `# Environment\n - Primary working directory: ${clone('T-7-a2')}\n - Is a git repository: true`,
        },
      ],
      messages: [{ role: 'user', content: 'Start the task.' }],
    });
    expect(attemptIdIn(fromSystem)).toBe('T-7-a2');
    const fromUser = claudeRequest({
      system: 'You are Claude Code.',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: `<system-reminder>\n${brief('T-7-e2-a1')}\n</system-reminder>` },
            { type: 'text', text: 'Start the task.' },
          ],
        },
      ],
    });
    expect(attemptIdIn(fromUser)).toBe('T-7-e2-a1');
  });

  test('reads the attempt from Codex developer instructions or environment context', () => {
    const fromInstructions = codexRequest([
      developer('Codex base prompt.'),
      developer(brief('T-7-a2')),
      userText('Start the task.'),
    ]);
    expect(attemptIdIn(fromInstructions)).toBe('T-7-a2');
    const fromEnvironment = codexRequest([developer('Codex base prompt.'), environment(clone('lead-a3'))]);
    expect(attemptIdIn(fromEnvironment)).toBe('lead-a3');
    const successor = codexRequest([developer('Codex base prompt.'), developer(brief('T-7-e2-a1'))]);
    expect(attemptIdIn(successor)).toBe('T-7-e2-a1');
  });

  test('ignores attempt ids elsewhere, such as in a quoted handoff note', () => {
    const note = [
      'Handoff note from T-7-a1:',
      `> I worked in ${clone('T-7-a1')} and committed a.txt.`,
      `> Your working directory: ${clone('T-7-a1')}`,
      `Your working directory: ${clone('T-7-a1')}`,
    ].join('\n');
    const claude = claudeRequest({
      system: 'You are Claude Code.',
      messages: [{ role: 'user', content: [{ type: 'text', text: brief('T-7-a2', note) }] }],
    });
    expect(attemptIdIn(claude)).toBe('T-7-a2');
    const codex = codexRequest([developer('Codex base prompt.'), developer(brief('T-7-a2', note))]);
    expect(attemptIdIn(codex)).toBe('T-7-a2');
    // A note alone names no working directory of this agent.
    const noteOnly = codexRequest([developer('Codex base prompt.'), userText(`See ${clone('T-7-a1')} for my work.`)]);
    expect(attemptIdIn(noteOnly)).toBeNull();
    const notAnAttempt = codexRequest([environment(`${HOME}/work/demo/notes`)]);
    expect(attemptIdIn(notAnAttempt)).toBeNull();
  });

  test('gives null for auxiliary requests', () => {
    const title = parseAnthropicRequest(
      {
        model: 'claude-test',
        system: `Primary working directory: ${clone('T-7-a2')}`,
        messages: [{ role: 'user', content: 'Write a title for this conversation.' }],
      },
      {},
    );
    expect(attemptIdIn(title)).toBeNull();
    const compaction = codexRequest([
      developer('Codex base prompt.'),
      developer(brief('T-7-a2')),
      userText('You are performing a CONTEXT CHECKPOINT COMPACTION. Summarise.'),
    ]);
    expect(attemptIdIn(compaction)).toBeNull();
  });
});

/** One turn of a conversation, written once for both vendors. */
type Turn =
  | { prompt: string }
  | { call: string }
  | { result: string; text?: string; isError?: boolean }
  | { inject: string }
  /** A message to an idle agent: a new prompt for Claude, a call-less agent_message output for Codex. */
  | { message: string };

/** The request a vendor sends after these turns: Claude folds mid-turn text in as a system entry. */
function conversation(vendor: 'claude' | 'codex', turns: Turn[]): AnthropicRequest | ResponsesRequest {
  if (vendor === 'claude') {
    const messages = turns.map((turn) => {
      if ('prompt' in turn) return { role: 'user', content: turn.prompt };
      if ('message' in turn) return { role: 'user', content: turn.message };
      if ('call' in turn) {
        return { role: 'assistant', content: [{ type: 'tool_use', id: turn.call, name: 'Bash', input: {} }] };
      }
      if ('result' in turn) {
        return {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: turn.result,
              content: turn.text ?? 'ok',
              is_error: turn.isError === true,
            },
          ],
        };
      }
      return { role: 'system', content: [{ type: 'text', text: turn.inject }] };
    });
    return claudeRequest({ system: `Primary working directory: ${clone('T-7-a1')}`, messages });
  }
  const input = turns.map((turn) => {
    if ('prompt' in turn || 'inject' in turn) return userText('prompt' in turn ? turn.prompt : turn.inject);
    if ('call' in turn) return { type: 'custom_tool_call', name: 'exec', call_id: turn.call, input: 'text(1)' };
    if ('message' in turn) {
      return { type: 'function_call_output', name: 'agent_message', namespace: 'agflow', output: turn.message };
    }
    return { type: 'custom_tool_call_output', call_id: turn.result, output: turn.text ?? 'ok' };
  });
  return codexRequest([developer('Codex base prompt.'), environment(clone('T-7-a1')), ...input]);
}

const PROGRAM: Program = {
  steps: [shell('echo zero'), shell('echo one'), tool('write_handoff', { note: 'two' }), shell('echo three')],
  reactions: [react('MSG-42', [shell('echo r0'), tool('send_message', { to: 'lead', text: 'r1' })])],
};

function stepOf(vendor: 'claude' | 'codex', turns: Turn[]): string {
  const next = nextStep(PROGRAM, conversation(vendor, turns));
  return next.kind === 'step' ? next.callId : next.kind;
}

/** Steps 0..n-1 called and answered. */
function ran(count: number, prefix = 'e2e-s'): Turn[] {
  return Array.from({ length: count }, (_, step) => [
    { call: `${prefix}${step}` },
    { result: `${prefix}${step}` },
  ]).flat();
}

for (const vendor of ['claude', 'codex'] as const) {
  describe(`nextStep (${vendor})`, () => {
    test('gives step 0 for a fresh conversation, then step n+1 after the result of step n', () => {
      const fresh = nextStep(PROGRAM, conversation(vendor, [{ prompt: 'Start the task.' }]));
      expect(fresh).toEqual({ kind: 'step', step: PROGRAM.steps[0] as never, callId: 'e2e-s0' });
      expect(stepOf(vendor, [{ prompt: 'Start.' }, ...ran(1)])).toBe('e2e-s1');
      expect(stepOf(vendor, [{ prompt: 'Start.' }, ...ran(3)])).toBe('e2e-s3');
    });

    test('moves on after an interrupted or aborted result', () => {
      const interrupted = [
        { prompt: 'Start.' },
        { call: 'e2e-s0' },
        { result: 'e2e-s0', text: '[Request interrupted by user for tool use]', isError: true },
      ];
      expect(stepOf(vendor, interrupted)).toBe('e2e-s1');
      const aborted: Turn[] = [
        { prompt: 'Start.' },
        ...ran(1),
        { call: 'e2e-s1' },
        { result: 'e2e-s1', text: 'aborted' },
      ];
      expect(stepOf(vendor, aborted)).toBe('e2e-s2');
    });

    test('gives the same step again for a retried request whose history is unchanged', () => {
      const turns: Turn[] = [{ prompt: 'Start.' }, ...ran(2)];
      expect(stepOf(vendor, turns)).toBe('e2e-s2');
      expect(stepOf(vendor, turns)).toBe('e2e-s2');
      // A call without a result yet (the request that carried it failed) is not a step that ran.
      expect(stepOf(vendor, [...turns, { call: 'e2e-s2' }])).toBe('e2e-s2');
    });

    test('continues a resumed conversation at the step after the last one that ran', () => {
      const resumed: Turn[] = [
        { prompt: 'Start.' },
        ...ran(3),
        { prompt: 'The runner restarted; continue from your last step.' },
      ];
      expect(stepOf(vendor, resumed)).toBe('e2e-s3');
    });

    test('runs a reaction once, the first time its marker is injected after the program started', () => {
      const injected: Turn[] = [
        { prompt: 'Start.' },
        ...ran(2),
        { inject: 'A message for you: MSG-42, please answer.' },
      ];
      expect(stepOf(vendor, injected)).toBe('e2e-r0-s0');
      const reacting = [...injected, ...ran(1, 'e2e-r0-s')];
      expect(stepOf(vendor, reacting)).toBe('e2e-r0-s1');
      const reacted = [...injected, ...ran(2, 'e2e-r0-s')];
      // The program continues where it was.
      expect(stepOf(vendor, reacted)).toBe('e2e-s2');
      // The marker again, later: the reaction does not run twice.
      const again: Turn[] = [...reacted, { call: 'e2e-s2' }, { result: 'e2e-s2' }, { inject: 'MSG-42 again' }];
      expect(stepOf(vendor, again)).toBe('e2e-s3');
    });

    test('runs a reaction to a message delivered to the idle agent, mid-program or after the last step', () => {
      const message = { message: 'from lead: MSG-42' };
      expect(stepOf(vendor, [{ prompt: 'Start.' }, ...ran(2), message])).toBe('e2e-r0-s0');
      expect(stepOf(vendor, [{ prompt: 'Start.' }, ...ran(4), message])).toBe('e2e-r0-s0');
      expect(stepOf(vendor, [{ prompt: 'Start.' }, ...ran(4), message, ...ran(2, 'e2e-r0-s')])).toBe('done');
      // A message that came before the program started is not one to react to.
      expect(stepOf(vendor, [message, { prompt: 'Start.' }])).toBe('e2e-s0');
      expect(stepOf(vendor, [message, { prompt: 'Start.' }, ...ran(1)])).toBe('e2e-s1');
    });

    test('ignores a marker that came before the program started', () => {
      expect(stepOf(vendor, [{ prompt: 'Start. MSG-42' }])).toBe('e2e-s0');
      expect(stepOf(vendor, [{ prompt: 'Start. MSG-42' }, ...ran(1)])).toBe('e2e-s1');
    });

    test('answers closing text after the last step, so a continuation prompt never restarts it', () => {
      const finished: Turn[] = [{ prompt: 'Start.' }, ...ran(4)];
      expect(nextStep(PROGRAM, conversation(vendor, finished))).toEqual({ kind: 'done' });
      const nudged: Turn[] = [...finished, { prompt: 'Continue with the task.' }];
      expect(nextStep(PROGRAM, conversation(vendor, nudged))).toEqual({ kind: 'done' });
      // A reaction triggered after the end still runs, then the program closes again.
      expect(stepOf(vendor, [...finished, { inject: 'MSG-42' }])).toBe('e2e-r0-s0');
      expect(stepOf(vendor, [...finished, { inject: 'MSG-42' }, ...ran(2, 'e2e-r0-s')])).toBe('done');
    });

    test("ignores tool calls that are not the program's own", () => {
      const foreign: Turn[] = [{ prompt: 'Start.' }, { call: 'toolu_other' }, { result: 'toolu_other' }];
      expect(stepOf(vendor, foreign)).toBe('e2e-s0');
    });
  });
}

describe('steps', () => {
  test("a step's optional text comes before its tool call in the same reply", () => {
    const step = say('Restating: a1 committed a.txt; I continue with b.txt.', shell('ls'));
    const claude = claudeReply({ kind: 'step', step, callId: 'e2e-s0' });
    expect(claude.kind === 'message' && claude.content.map((block) => block.type)).toEqual(['text', 'tool_use']);
    expect(claude.kind === 'message' && claude.content[0]).toEqual({
      type: 'text',
      text: 'Restating: a1 committed a.txt; I continue with b.txt.',
    });
    const codex = codexReply({ kind: 'step', step, callId: 'e2e-s0' });
    expect(codex.output.map((item) => item.type)).toEqual(['message', 'custom_tool_call']);
    expect(JSON.stringify(codex.output[0])).toContain('Restating: a1 committed a.txt');
  });

  test('gate(name) compiles to one command that waits for .agflow/run/e2e/<name>, relative to the clone', async () => {
    expect(GATE_DIR).toBe('.agflow/run/e2e');
    const step = gate('ready');
    expect(step).toMatchObject({ kind: 'shell', gate: 'ready', timeoutMs: BASH_MAX_TIMEOUT_MS });
    // One simple command with a literal script, which Claude Code can approve: no expansion, substitution or group.
    expect(step.cmd).toStartWith("perl -e '");
    expect(step.cmd).toEndWith("'");
    expect(step.cmd.slice("perl -e '".length, -1)).not.toContain("'");
    expect(step.cmd).toContain('-e ".agflow/run/e2e/ready"');
    const dir = tempDir();
    const proc = Bun.spawn(['sh', '-c', step.cmd], { cwd: dir, stdout: 'pipe', stderr: 'ignore' });
    await Bun.sleep(400);
    expect(proc.exitCode).toBeNull();
    mkdirSync(join(dir, GATE_DIR), { recursive: true });
    writeFileSync(join(dir, GATE_DIR, 'ready'), '');
    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stdout).text()).toBe('gate ready is open\n');
    for (const name of ['', '.', '..', 'a/b', "it's"]) expect(() => gate(name)).toThrow('not a gate name');
    expect(gate('later', { timeoutMs: 30_000 }).timeoutMs).toBe(30_000);
  });

  test('a gate nobody opens gives up on its own, 5 s before its step times out, with exit 124', async () => {
    expect(gate('ready').cmd).toContain('time + 595;');
    expect(gate('later', { timeoutMs: 30_000 }).cmd).toContain('time + 25;');
    const step = gate('never', { timeoutMs: 6_000 });
    expect(step.cmd).toContain('time + 1;');
    const started = Date.now();
    const proc = Bun.spawn(['sh', '-c', step.cmd], { cwd: tempDir(), stdout: 'pipe', stderr: 'ignore' });
    expect(await proc.exited).toBe(124);
    expect(Date.now() - started).toBeLessThan(step.timeoutMs);
    expect(await new Response(proc.stdout).text()).toBe('agflow gate never timed out\n');
  });

  test('shell timeouts are explicit and at most Bash maximum; tool names are identifiers', () => {
    expect(shell('ls').timeoutMs).toBe(120_000);
    expect(shell('ls', { timeoutMs: BASH_MAX_TIMEOUT_MS }).timeoutMs).toBe(600_000);
    for (const timeoutMs of [0, -1, 1.5, BASH_MAX_TIMEOUT_MS + 1]) {
      expect(() => shell('ls', { timeoutMs })).toThrow("a step's timeout must be");
    }
    expect(() => tool('mcp__agflow__submit()')).toThrow('not a tool name');
    expect(() => react('', [])).toThrow('a reaction needs a marker');
  });
});

describe('Claude replies', () => {
  test('a shell step is a Bash tool_use with an explicit timeout and the step call id', () => {
    const built = claudeReply({ kind: 'step', step: shell('sleep 30', { timeoutMs: 45_000 }), callId: 'e2e-s4' });
    expect(built).toMatchObject({ kind: 'message', stopReason: 'tool_use' });
    expect(built.kind === 'message' && built.content).toEqual([
      {
        type: 'tool_use',
        id: 'e2e-s4',
        name: 'Bash',
        input: { command: 'sleep 30', timeout: 45_000, description: 'Run e2e step e2e-s4' },
      },
    ]);
    const waiting = claudeReply({ kind: 'step', step: gate('go'), callId: 'e2e-r1-s0' });
    expect(waiting.kind === 'message' && waiting.content[0]).toMatchObject({
      id: 'e2e-r1-s0',
      input: { timeout: 600_000, description: 'Wait for gate go' },
    });
  });

  test('a tool step is mcp__agflow__<tool> with the step call id', () => {
    const built = claudeReply({ kind: 'step', step: tool('submit', { summary: 'done' }), callId: 'e2e-s2' });
    expect(built.kind === 'message' && built.content).toEqual([
      { type: 'tool_use', id: 'e2e-s2', name: 'mcp__agflow__submit', input: { summary: 'done' } },
    ]);
  });

  test('the end is closing text, and an error is a playbook error', () => {
    expect(claudeReply({ kind: 'done' })).toMatchObject({ stopReason: 'end_turn', content: [{ text: CLOSING_TEXT }] });
    const error = claudeReply({ kind: 'error', message: 'broken' });
    expect(error.kind === 'message' && error.content).toEqual([{ type: 'text', text: `${PLAYBOOK_ERROR}: broken` }]);
  });
});

describe('Codex replies', () => {
  /** Runs a Code Mode exec script with fake tools, as codex-code-mode-host would. */
  async function runScript(source: string, tools: Record<string, (args: any) => Promise<unknown>>): Promise<unknown[]> {
    const texts: unknown[] = [];
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
    await new AsyncFunction('tools', 'text', source)(tools, (value: unknown) => texts.push(value));
    return texts;
  }

  test("a shell step is one exec cell that does not yield before the step's timeout", async () => {
    const step = gate('go', { timeoutMs: 90_000 });
    const built = codexReply({ kind: 'step', step, callId: 'e2e-s3' });
    expect(built.output).toHaveLength(1);
    const cell = built.output[0] as Record<string, any>;
    expect(cell).toMatchObject({ type: 'custom_tool_call', name: 'exec', call_id: 'e2e-s3' });
    const source = cell.input as string;
    const pragma = source.split('\n')[0] as string;
    expect(pragma.startsWith('// @exec: ')).toBe(true);
    expect(JSON.parse(pragma.slice('// @exec: '.length)).yield_time_ms).toBeGreaterThanOrEqual(90_000);
    // The cell waits for the command until the step's own deadline, polling past exec_command's yields.
    expect(source).toContain('Date.now() + 90000');
    const calls: [string, any][] = [];
    const texts = await runScript(source, {
      exec_command: async (args) => {
        calls.push(['exec_command', args]);
        return { session_id: 9, output: '', wall_time_seconds: 30 };
      },
      write_stdin: async (args) => {
        calls.push(['write_stdin', args]);
        return calls.length < 3
          ? { session_id: 9, output: '', wall_time_seconds: 30 }
          : { exit_code: 0, output: 'gate go is open\n', wall_time_seconds: 1 };
      },
    });
    // exec_command gets no timeout_ms: the pinned 0.159.2 declares none, and the cell's own deadline bounds the step.
    expect(calls[0]?.[1]).toEqual({ cmd: step.cmd, yield_time_ms: 30_000 });
    expect(calls.map(([name]) => name)).toEqual(['exec_command', 'write_stdin', 'write_stdin']);
    expect(texts).toEqual([{ exit_code: 0, output: 'gate go is open\n', wall_time_seconds: 1 }]);
  });

  test('a tool step calls the agflow tool through exec with the step call id', async () => {
    const built = codexReply({ kind: 'step', step: tool('write_handoff', { note: 'next: c.txt' }), callId: 'e2e-s1' });
    const cell = built.output[0] as Record<string, any>;
    expect(cell).toMatchObject({ type: 'custom_tool_call', name: 'exec', call_id: 'e2e-s1' });
    const seen: unknown[] = [];
    await runScript(cell.input, {
      mcp__agflow__write_handoff: async (args) => {
        seen.push(args);
        return { content: [{ type: 'text', text: 'saved' }] };
      },
    });
    expect(seen).toEqual([{ note: 'next: c.txt' }]);
  });

  test('a cell that says it is still running is a playbook error, not the step result', () => {
    const yielded = codexRequest([
      developer('Codex base prompt.'),
      environment(clone('T-7-a1')),
      userText('Start.'),
      { type: 'custom_tool_call', name: 'exec', call_id: 'e2e-s0', input: 'text(1)' },
      { type: 'custom_tool_call_output', call_id: 'e2e-s0', output: 'ok' },
      { type: 'custom_tool_call', name: 'exec', call_id: 'e2e-s1', input: 'text(1)' },
      {
        type: 'custom_tool_call_output',
        call_id: 'e2e-s1',
        output: [{ type: 'input_text', text: 'Script running with cell ID 4\nWall time 10.0 seconds' }],
      },
    ]);
    const next = nextStep(PROGRAM, yielded);
    expect(next.kind).toBe('error');
    expect(next.kind === 'error' && next.message).toContain('e2e-s1');
    const answer = codexReply(next);
    expect(JSON.stringify(answer.output)).toContain(PLAYBOOK_ERROR);
    expect(codexReply({ kind: 'done' }).output).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'message' })]),
    );
    expect(JSON.stringify(codexReply({ kind: 'done' }).output)).toContain(CLOSING_TEXT);
  });

  test('a cell whose command still ran at its deadline is a playbook error; one that exited is a result', () => {
    const cell = (json: string) =>
      codexRequest([
        developer('Codex base prompt.'),
        environment(clone('T-7-a1')),
        userText('Start.'),
        { type: 'custom_tool_call', name: 'exec', call_id: 'e2e-s0', input: 'text(1)' },
        {
          type: 'custom_tool_call_output',
          call_id: 'e2e-s0',
          output: [
            { type: 'input_text', text: 'Script completed\nWall time 20.0 seconds\nOutput:\n' },
            { type: 'input_text', text: json },
          ],
        },
      ]);
    const running = nextStep(PROGRAM, cell('{"session_id":9,"wall_time_seconds":20,"output":"waiting"}'));
    expect(running.kind === 'error' && running.message).toContain('e2e-s0 did not finish');
    // The command's own output naming a session is escaped inside the JSON, so it is not the cell's session_id.
    const exited = nextStep(PROGRAM, cell('{"exit_code":0,"wall_time_seconds":1,"output":"{\\"session_id\\": 3}"}'));
    expect(exited).toMatchObject({ kind: 'step', callId: 'e2e-s1' });
  });
});

describe('unfinished steps', () => {
  for (const vendor of ['claude', 'codex'] as const) {
    test(`a gate that timed out is a playbook error (${vendor})`, () => {
      const turns: Turn[] = [
        { prompt: 'Start.' },
        { call: 'e2e-s0' },
        { result: 'e2e-s0', text: 'agflow gate g1 timed out\nExit code 124', isError: true },
      ];
      const next = nextStep(PROGRAM, conversation(vendor, turns));
      expect(next.kind === 'error' && next.message).toContain('its gate timed out');
    });
  }

  test('a step Claude Code denied without running it is a playbook error', () => {
    const denied =
      'Permission for this tool use was denied. It requires approval, and this session has no approval surface. ' +
      'What required approval: Contains brace with quote character (expansion obfuscation)';
    const turns: Turn[] = [{ prompt: 'Start.' }, { call: 'e2e-s0' }, { result: 'e2e-s0', text: denied, isError: true }];
    const next = nextStep(PROGRAM, conversation('claude', turns));
    expect(next.kind === 'error' && next.message).toContain(
      'Claude Code denied it without running it (Contains brace with quote character (expansion obfuscation))',
    );
  });

  test('a command Claude moved to the background is a playbook error', () => {
    for (const output of [
      'Command did not complete within its 5s timeout and was moved to the background (ID: bash_1).',
      'Command was moved to the background (ID: bash_2) so that a message that arrived while it was running can reach' +
        ' you.',
    ]) {
      const turns: Turn[] = [{ prompt: 'Start.' }, { call: 'e2e-s0' }, { result: 'e2e-s0', text: output }];
      const next = nextStep(PROGRAM, conversation('claude', turns));
      expect(next.kind === 'error' && next.message).toContain('moved to the background');
    }
  });
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `bun test packages/testkit/test/playbook.test.ts`
Expected: FAIL — error: Cannot find module '../src/harness/playbook' from '.../packages/testkit/test/playbook.test.ts'

- [ ] **Step 3: Implement**

**File:** `packages/testkit/src/harness/index.ts` (change)

```diff
diff --git a/packages/testkit/src/harness/index.ts b/packages/testkit/src/harness/index.ts
index 13ce9591..73b304af 100644
--- a/packages/testkit/src/harness/index.ts
+++ b/packages/testkit/src/harness/index.ts
@@ -1,4 +1,5 @@
 // The multi-runner e2e harness (design 15, X-20). It has its own entry, so the testkit's main index keeps importing
 // runner types only; the harness imports runner and hub modules by path and adds no dependency (X-44).
 export * from './env';
+export * from './playbook';
 export * from './proc';
```

**File:** `packages/testkit/src/harness/playbook.ts` (new)

```ts
// Vendor-neutral agent playbooks for the scripted models (design 15.1). A playbook maps attempt ids to programs; a
// program is a list of steps (a shell command, an agflow tool call, a gate, each with optional text before it) plus
// reactions to text injected into the conversation. The servers answer from request content, never from request
// order:
// - The attempt id comes only from the agent's own clone path, work/<project>/<attempt>, which the brief's last line
//   (X-17) and the vendor's own working directory carry; a handoff note naming an earlier attempt cannot mislead it.
// - The next step comes from the history: step n's tool call id encodes n, so a retried request gets the same answer
//   and a resumed session continues where it stopped.
// - A gate waits for a file under the clone's runner-owned .agflow/run/, which harvests, snapshots and the file watcher
//   ignore (design 7.3, 7.5), so opening one changes nothing the scenario checks.
import { parseAttemptId } from '@agflow/core';
import {
  type AnthropicReply,
  agflowTool,
  bashTool,
  type ContentBlock,
  reply as message,
  text,
} from '../anthropic/replies';
import type { AnthropicRequest } from '../anthropic/request';
import { type OutputItem, reply as codex, type StreamReply } from '../codex/replies';
import type { ResponsesRequest } from '../codex/request';

/** Where gates wait, relative to the clone: inside the runner-owned .agflow/run/. */
export const GATE_DIR = '.agflow/run/e2e';

/** The Bash tool's own maximum timeout in Claude Code. */
export const BASH_MAX_TIMEOUT_MS = 600_000;

const DEFAULT_SHELL_TIMEOUT_MS = 120_000;

/** A gate waits as long as a step can: scenarios open it when they are ready. */
const DEFAULT_GATE_TIMEOUT_MS = BASH_MAX_TIMEOUT_MS;

/** What a program answers once every step has run, so a continuation prompt never restarts it. */
export const CLOSING_TEXT = 'Every step of my program has run; there is nothing left for me to do.';

/** How a playbook error starts: the agent sees it as text, and the scenario fails on it. */
export const PLAYBOOK_ERROR = 'agflow playbook error';

/** Codex 0.159.2's answer for an exec cell that yielded while its script still ran. */
const CELL_STILL_RUNNING = 'Script running with cell ID';

/** Claude Code 2.1.285's Bash result for a command it moved to the background, at its timeout or for a message. */
const MOVED_TO_BACKGROUND = /was moved to the background \(ID: /;

/** What a gate prints when its own deadline passes before anyone opened it. */
const GATE_TIMED_OUT = /agflow gate \S+ timed out/;

/**
 * Claude Code 2.1.285's result for a Bash command its permission check could not approve, with the reason after "What
 * required approval: ". A runner session has no approval surface, so the command never ran.
 */
const CLAUDE_DENIED = 'Permission for this tool use was denied.';
const CLAUDE_DENIED_REASON = /What required approval: (.*)/;

export interface ShellStep {
  kind: 'shell';
  cmd: string;
  /** The tool's own timeout: Bash's timeout, the exec cell's deadline. */
  timeoutMs: number;
  /** The gate's name when the step is a gate. */
  gate: string | null;
  /** Text the model says before the call, in the same reply. */
  text: string | null;
}

export interface ToolStep {
  kind: 'tool';
  /** An agflow bridge tool: mcp__agflow__<tool>. */
  tool: string;
  args: Record<string, unknown>;
  text: string | null;
}

export type Step = ShellStep | ToolStep;

/** Steps that run once, the first time the marker appears in text injected after the program started. */
export interface Reaction {
  marker: string;
  steps: Step[];
}

export interface Program {
  steps: Step[];
  reactions?: Reaction[];
}

/** The programs of a scenario, keyed by attempt id. */
export type Programs = Record<string, Program>;

function checkTimeout(timeoutMs: number): number {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > BASH_MAX_TIMEOUT_MS) {
    throw new Error(`a step's timeout must be 1 to ${BASH_MAX_TIMEOUT_MS} ms (Bash's maximum), not ${timeoutMs}`);
  }
  return timeoutMs;
}

/** A shell command, run in the clone; 2 minutes by default. */
export function shell(cmd: string, options: { timeoutMs?: number } = {}): ShellStep {
  const timeoutMs = checkTimeout(options.timeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS);
  return { kind: 'shell', cmd, timeoutMs, gate: null, text: null };
}

/** A call of an agflow bridge tool, such as tool('submit', { task_id, summary }). */
export function tool(name: string, args: Record<string, unknown> = {}): ToolStep {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`not a tool name: ${JSON.stringify(name)}`);
  return { kind: 'tool', tool: name, args, text: null };
}

/** The step with text the model says before its call, in the same reply. */
export function say<S extends Step>(value: string, step: S): S {
  return { ...step, text: value };
}

const GATE_NAME = /^(?!\.\.?$)[A-Za-z0-9._-]+$/;

/** How long before its step's timeout a gate gives up on its own. */
const GATE_MARGIN_S = 5;

/**
 * A command that waits until GATE_DIR/<name> exists in the clone; the harness opens it by writing that file. The
 * step's timeout is 10 minutes by default. A gate that is never opened gives up on its own 5 s before that, exiting
 * 124 with "agflow gate <name> timed out": at their timeouts both CLIs leave a command running (Claude moves it to the
 * background, Codex's cell returns while it runs), and a loop that outlives its step would run on in the clone. The
 * loop is a perl one-liner, one simple command with a literal script: Claude Code 2.1.285 cannot approve a shell loop
 * with expansions, substitutions or brace groups in a runner session, and denies it without running it.
 */
export function gate(name: string, options: { timeoutMs?: number } = {}): ShellStep {
  if (!GATE_NAME.test(name)) throw new Error(`not a gate name: ${JSON.stringify(name)}`);
  const file = `${GATE_DIR}/${name}`;
  const timeoutMs = checkTimeout(options.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS);
  const seconds = Math.max(1, Math.floor(timeoutMs / 1000) - GATE_MARGIN_S);
  const script =
    `my $end = time + ${seconds}; until (-e "${file}") { if (time >= $end) { print "agflow gate ${name} timed out\\n"; ` +
    `exit 124 } select(undef, undef, undef, 0.2) } print "gate ${name} is open\\n"`;
  const cmd = `perl -e '${script}'`;
  return { ...shell(cmd, { timeoutMs }), gate: name };
}

export function react(marker: string, steps: Step[]): Reaction {
  if (marker === '') throw new Error('a reaction needs a marker');
  return { marker, steps };
}

// --- Attempt ids ---------------------------------------------------------------------------------------------------

/** The attempt of a clone path, <home>/work/<project>/<attempt>, or null for any other path. */
function attemptOfPath(path: string): string | null {
  const id = path.trim().match(/\/work\/[^/]+\/([^/]+)\/?$/)?.[1];
  return id !== undefined && parseAttemptId(id) !== null ? id : null;
}

/** The value of the last line of the text that the pattern matches, from its first group. */
function lastLineValue(value: string, line: RegExp): string | null {
  let found: string | null = null;
  for (const text of value.split('\n')) found = text.match(line)?.[1] ?? found;
  return found;
}

/** The brief's last line (X-17); a quoted copy in a note is indented or prefixed, and comes before it. */
const BRIEF_LINE = /^Your working directory: (.+)$/;
/** Claude Code's environment section: " - Primary working directory: <cwd>". */
const CLAUDE_CWD_LINE = /^(?:\s*-\s+)?Primary working directory: (.+)$/;

function isClaude(request: AnthropicRequest | ResponsesRequest): request is AnthropicRequest {
  return 'messages' in request;
}

/**
 * The attempt whose agent sent the request, read from its clone path only: Claude's primary working directory or the
 * brief-hook context; Codex's environment context or developer instructions (the brief). The brief ends with its "Your
 * working directory" line, so the last such line of a text counts and a quoted handoff note above it does not. Null
 * for auxiliary requests (titles, summaries, compactions) and requests that carry no clone path.
 */
export function attemptIdIn(request: AnthropicRequest | ResponsesRequest): string | null {
  const paths: (string | null)[] = [];
  if (isClaude(request)) {
    if (!request.mainLoop) return null;
    paths.push(lastLineValue(request.system, CLAUDE_CWD_LINE));
    // Claude Code 2.1.285 sends the hook's brief and its own environment section together, in a role 'system' entry
    // near the start of the messages. That entry comes before any message delivered later, so the first path found in
    // message order is the agent's own, and a forwarded "Your working directory" line cannot win.
    for (const entry of request.messages) {
      if (entry.role === 'assistant') continue;
      for (const block of entry.blocks) {
        if (block.type !== 'text') continue;
        paths.push(lastLineValue(block.text, CLAUDE_CWD_LINE), lastLineValue(block.text, BRIEF_LINE));
      }
    }
  } else {
    if (request.isCompaction) return null;
    paths.push(request.cwd, lastLineValue(request.instructions, BRIEF_LINE));
  }
  for (const path of paths) {
    const id = path === null ? null : attemptOfPath(path);
    if (id !== null) return id;
  }
  return null;
}

// --- The history ---------------------------------------------------------------------------------------------------

type Entry =
  | { kind: 'call'; callId: string }
  | { kind: 'result'; callId: string; text: string }
  | { kind: 'injected'; text: string };

function claudeHistory(request: AnthropicRequest): Entry[] {
  const entries: Entry[] = [];
  for (const entry of request.messages) {
    for (const block of entry.blocks) {
      if (entry.role === 'assistant') {
        if (block.type === 'tool_use') entries.push({ kind: 'call', callId: block.id });
      } else if (block.type === 'tool_result') {
        entries.push({ kind: 'result', callId: block.toolUseId, text: block.text });
      } else if (block.type === 'text') {
        // A prompt, a message folded in mid-turn (a system entry), or context the CLI adds.
        entries.push({ kind: 'injected', text: block.text });
      }
    }
  }
  return entries;
}

type Item = Record<string, unknown>;

function texts(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (part !== null && typeof part === 'object' ? (part as Item).text : undefined))
    .filter((part): part is string => typeof part === 'string')
    .join('\n');
}

/** User messages Codex writes itself. */
const CODEX_CONTEXT = ['<environment_context>', '# AGENTS.md instructions'];

function codexHistory(request: ResponsesRequest): Entry[] {
  const input = Array.isArray(request.body.input) ? (request.body.input as unknown[]) : [];
  const entries: Entry[] = [];
  for (const raw of input) {
    if (raw === null || typeof raw !== 'object') continue;
    const item = raw as Item;
    const type = typeof item.type === 'string' ? item.type : '';
    const callId = typeof item.call_id === 'string' && item.call_id !== '' ? item.call_id : null;
    if (type.endsWith('_call_output')) {
      // An output without a call is an agent's message delivered as agflow's agent_message.
      const output = texts(item.output);
      entries.push(callId ? { kind: 'result', callId, text: output } : { kind: 'injected', text: output });
    } else if (type.endsWith('_call') && callId) {
      entries.push({ kind: 'call', callId });
    } else if (type === 'message' && item.role === 'user') {
      const value = texts(item.content);
      if (!CODEX_CONTEXT.some((prefix) => value.startsWith(prefix))) entries.push({ kind: 'injected', text: value });
    }
  }
  return entries;
}

// --- The next step -------------------------------------------------------------------------------------------------

/** The call id of a program step: e2e-s<n>, or e2e-r<k>-s<n> for step n of reaction k. */
export function stepCallId(step: number, reaction: number | null = null): string {
  return reaction === null ? `e2e-s${step}` : `e2e-r${reaction}-s${step}`;
}

function parseCallId(callId: string): { reaction: number | null; step: number } | null {
  const match = callId.match(/^e2e-(?:r(\d+)-)?s(\d+)$/);
  if (!match) return null;
  return { reaction: match[1] === undefined ? null : Number(match[1]), step: Number(match[2]) };
}

export type Next =
  | { kind: 'step'; step: Step; callId: string }
  /** Every step has run: the closing text. */
  | { kind: 'done' }
  | { kind: 'error'; message: string };

/**
 * Why a step's result is not a result: its command still ran when the tool returned, its gate timed out, or Claude
 * Code denied it.
 */
function unfinished(request: AnthropicRequest | ResponsesRequest, result: string): string | null {
  if (GATE_TIMED_OUT.test(result)) return 'its gate timed out before anyone opened it';
  if (isClaude(request)) {
    if (result.includes(CLAUDE_DENIED)) {
      const reason = result.match(CLAUDE_DENIED_REASON)?.[1]?.trim() || 'no reason given';
      return `Claude Code denied it without running it (${reason})`;
    }
    return MOVED_TO_BACKGROUND.test(result) ? 'its command was moved to the background' : null;
  }
  if (result.includes(CELL_STILL_RUNNING)) return 'its cell yielded while its command still ran';
  // reply.shell's cell reports a command still running at its deadline with a session_id and no exit_code.
  for (const line of result.split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      const value = JSON.parse(line) as Item;
      if ('session_id' in value && !('exit_code' in value)) return 'its command still ran at the deadline';
    } catch {
      // Not the cell's JSON.
    }
  }
  return null;
}

/**
 * What the program answers to the request, from the history alone. A step counts as run once the history holds a
 * result for its call id, whatever the result says (an interrupted or aborted call included). A triggered reaction
 * runs before the program goes on. A step whose command was still running when its tool returned (a yielded Codex
 * cell or one past its deadline, a command Claude moved to the background) or whose gate timed out is a playbook
 * error: going on would run the next step while it still runs. So is a step Claude Code denied: it never ran.
 */
export function nextStep(program: Program, request: AnthropicRequest | ResponsesRequest): Next {
  const history = isClaude(request) ? claudeHistory(request) : codexHistory(request);
  const done = new Map<number | null, number>();
  let started = -1;
  for (const [position, entry] of history.entries()) {
    if (entry.kind === 'injected') continue;
    const parsed = parseCallId(entry.callId);
    if (parsed === null) continue;
    if (started < 0) started = position;
    if (entry.kind !== 'result') continue;
    const why = unfinished(request, entry.text);
    if (why !== null) {
      return { kind: 'error', message: `step ${entry.callId} did not finish: ${why} (${entry.text.slice(0, 200)})` };
    }
    done.set(parsed.reaction, Math.max(done.get(parsed.reaction) ?? -1, parsed.step));
  }
  if (started >= 0) {
    const reactions = program.reactions ?? [];
    const triggered = reactions
      .map((reaction, index) => ({
        index,
        reaction,
        at: history.findIndex(
          (entry, position) => position > started && entry.kind === 'injected' && entry.text.includes(reaction.marker),
        ),
      }))
      .filter((candidate) => candidate.at >= 0)
      .sort((a, b) => a.at - b.at);
    for (const { index, reaction } of triggered) {
      const next = (done.get(index) ?? -1) + 1;
      const step = reaction.steps[next];
      if (step) return { kind: 'step', step, callId: stepCallId(next, index) };
    }
  }
  const next = (done.get(null) ?? -1) + 1;
  const step = program.steps[next];
  return step ? { kind: 'step', step, callId: stepCallId(next) } : { kind: 'done' };
}

// --- Compiling ----------------------------------------------------------------------------------------------------

function errorText(message: string): string {
  return `${PLAYBOOK_ERROR}: ${message}`;
}

/** The reply of the scripted Anthropic server: text before the call, then a Bash or mcp__agflow__ tool_use. */
export function claudeReply(next: Next): AnthropicReply {
  if (next.kind === 'done') return message(CLOSING_TEXT);
  if (next.kind === 'error') return message(errorText(next.message));
  const { step, callId } = next;
  const call =
    step.kind === 'shell'
      ? bashTool({
          command: step.cmd,
          timeoutMs: step.timeoutMs,
          description: step.gate === null ? `Run e2e step ${callId}` : `Wait for gate ${step.gate}`,
          id: callId,
        })
      : agflowTool({ tool: step.tool, args: step.args, id: callId });
  const blocks: ContentBlock[] = step.text === null ? [call] : [text(step.text), call];
  return message(blocks);
}

/**
 * The reply of the scripted Responses provider: text before the call, then a Code Mode exec cell. A shell step's cell
 * waits for the command until the step's timeout, and its pragma keeps the cell from yielding before that.
 */
export function codexReply(next: Next): StreamReply {
  if (next.kind === 'done') return codex.text(CLOSING_TEXT);
  if (next.kind === 'error') return codex.text(errorText(next.message));
  const { step, callId } = next;
  const call =
    step.kind === 'shell'
      ? codex.shell({ cmd: step.cmd, timeoutMs: step.timeoutMs, callId })
      : codex.mcp({ tool: step.tool, args: step.args, callId });
  const before: OutputItem[] = step.text === null ? [] : codex.text(step.text).output;
  return { ...call, output: [...before, ...call.output] };
}
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `bun test packages/testkit/test/playbook.test.ts && bun run typecheck`
Expected: all selected tests pass (0 fail); tsc exits 0.

Use the final perl gate, with a deadline five seconds before the step timeout. The earlier shell-loop gate was denied by Claude without running and was moved out of Task 7 into this commit. Denial, backgrounding, gate timeout, a yielded Codex cell and a still-running JSON result all fail the playbook. Codex exec_command has no timeout_ms at this pin: test the generated pragma and polling loop with fake tools. The submit example uses task_id and summary. See Decisions 24–28.

- [ ] **Step 5: Commit**

```bash
git add -A 'packages/testkit/src/harness/index.ts' 'packages/testkit/src/harness/playbook.ts' 'packages/testkit/test/playbook.test.ts'
git commit -m 'M2G Task 2: Harness: vendor-neutral agent playbooks' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

### Task 3: Harness: scripted models for a cluster

One scripted Anthropic server and one scripted Responses provider serve every runner of a cluster. Through their setHandler hooks, each request goes to the playbook program of the attempt id it carries; requests the handler declines get the servers' harmless default. M2b's startRefusingProxy stands in front of every external host. The models record each attempt's requests, so a scenario can check what an agent saw: its brief, a handoff note, a delivered message, a bridge answer. claudeEnv and codexConfig are claudeTestEnv and codexTestConfig pointed at these servers and the proxy; they become runner.json's test.claudeEnv and test.codexConfig.

**Files:**
- Modify: `packages/testkit/src/harness/index.ts`
- Create: `packages/testkit/src/harness/models.ts`
- Test: `packages/testkit/test/models.test.ts`

- [ ] **Step 1: Write the failing test**

**File:** `packages/testkit/test/models.test.ts` (new)

```ts
import { afterEach, describe, expect, test } from 'bun:test';
import { claudeTestEnv } from '../src/anthropic/env';
import { UNSCRIPTED_TEXT } from '../src/anthropic/server';
import { DEFAULT_REPLY_TEXT } from '../src/codex/replies';
import { codexTestConfig } from '../src/codex/test-config';
import { type Models, startModels } from '../src/harness/models';
import { CLOSING_TEXT, type Program, type Programs, shell, tool } from '../src/harness/playbook';

const started: Models[] = [];
afterEach(async () => {
  for (const models of started.splice(0)) await models.close();
});

/** Models that answer a request without a program at once, so the tests of unmatched requests do not wait. */
async function models(programs: Programs = {}, programWaitMs = 0): Promise<Models> {
  const value = await startModels({ programs, programWaitMs });
  started.push(value);
  return value;
}

const clone = (attempt: string) => `/private/tmp/agf-e2e/r1/work/demo/${attempt}`;
const PROGRAM: Program = { steps: [shell('echo one > one.txt'), tool('submit', { summary: 'one.txt' })] };

type Block = Record<string, unknown>;
type Message = { role: string; content: string | Block[] };

/** A Claude main-loop request, sent as the CLI sends it (without streaming, to read the reply at once). */
async function claude(target: Models, system: string, messages: Message[], tools = ['Bash']): Promise<Block> {
  const response = await fetch(`${target.anthropic.url}/v1/messages?beta=true`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'k' },
    body: JSON.stringify({
      model: 'claude-test',
      max_tokens: 1024,
      stream: false,
      system: [{ type: 'text', text: system }],
      tools: tools.map((name) => ({ name, description: name, input_schema: { type: 'object' } })),
      messages,
    }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Block;
}

const message = (role: string, value: string) => ({
  type: 'message',
  role,
  content: [{ type: 'input_text', text: value }],
});
const developer = (value: string) => message('developer', value);
const user = (value: string) => message('user', value);
const environment = (cwd: string) => user(`<environment_context>\n  <cwd>${cwd}</cwd>\n</environment_context>`);

/** A Codex request whose input follows the base prompt; gives the output items of the streamed reply. */
async function codex(target: Models, input: Block[]): Promise<Block[]> {
  const response = await fetch(`${target.responses.url}/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'thread-id': 'thread-1' },
    body: JSON.stringify({ model: 'gpt-test', stream: true, input: [developer('Codex base prompt.'), ...input] }),
  });
  expect(response.status).toBe(200);
  const completed = (await response.text())
    .split('\n\n')
    .map((block) => block.match(/^data: (.*)$/m)?.[1])
    .filter((data): data is string => data !== undefined)
    .map((data) => JSON.parse(data) as Block)
    .find((event) => event.type === 'response.completed');
  return ((completed?.response as Block | undefined)?.output ?? []) as Block[];
}

describe('startModels', () => {
  test("routes a Claude request to the program of the clone's attempt; an unknown attempt is unmatched", async () => {
    const cluster = await models({ 'T-1-a1': PROGRAM });
    const answered = await claude(cluster, `Primary working directory: ${clone('T-1-a1')}`, [
      { role: 'user', content: 'Start the task.' },
    ]);
    expect(answered.content).toEqual([
      {
        type: 'tool_use',
        id: 'e2e-s0',
        name: 'Bash',
        input: { command: 'echo one > one.txt', timeout: 120_000, description: 'Run e2e step e2e-s0' },
      },
    ]);
    const unknown = await claude(cluster, `Primary working directory: ${clone('T-9-a1')}`, [
      { role: 'user', content: 'Start the task.' },
    ]);
    expect(unknown.content).toEqual([{ type: 'text', text: UNSCRIPTED_TEXT }]);
    expect(cluster.unmatched().map((recorded) => recorded.attemptId)).toEqual(['T-9-a1']);
    // An auxiliary request (a title: no tools) gets the harmless default and is not unmatched.
    await claude(cluster, `Primary working directory: ${clone('T-1-a1')}`, [{ role: 'user', content: 'Title?' }], []);
    expect(cluster.unmatched()).toHaveLength(1);
    expect(cluster.requestsFor('T-1-a1').map((recorded) => recorded.answer)).toEqual([
      { kind: 'step', step: PROGRAM.steps[0], callId: 'e2e-s0' },
    ]);
  });

  test('routes a Codex request the same way, as an exec cell with the encoded call id', async () => {
    const cluster = await models({ 'T-1-a1': PROGRAM });
    const first = await codex(cluster, [environment(clone('T-1-a1')), user('Start the task.')]);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ type: 'custom_tool_call', name: 'exec', call_id: 'e2e-s0' });
    expect(first[0]?.input).toContain('echo one > one.txt');
    const second = await codex(cluster, [
      environment(clone('T-1-a1')),
      user('Start the task.'),
      { type: 'custom_tool_call', name: 'exec', call_id: 'e2e-s0', input: '' },
      { type: 'custom_tool_call_output', call_id: 'e2e-s0', output: [{ type: 'input_text', text: 'exit 0' }] },
    ]);
    expect(second[0]).toMatchObject({ type: 'custom_tool_call', name: 'exec', call_id: 'e2e-s1' });
    expect(second[0]?.input).toContain('mcp__agflow__submit');
    const unknown = await codex(cluster, [environment(clone('T-9-a1')), user('Start the task.')]);
    expect(JSON.stringify(unknown)).toContain(DEFAULT_REPLY_TEXT);
    expect(cluster.unmatched().map((recorded) => [recorded.vendor, recorded.attemptId])).toEqual([['codex', 'T-9-a1']]);
    // A compaction is auxiliary: its default summary answers it, and it is not unmatched.
    await codex(cluster, [
      environment(clone('T-1-a1')),
      user('You are performing a CONTEXT CHECKPOINT COMPACTION. Summarise.'),
    ]);
    expect(cluster.unmatched()).toHaveLength(1);
  });

  test("requestsFor gives an attempt's requests in arrival order with their text flattened", async () => {
    const cluster = await models({ 'T-1-a1': PROGRAM, 'T-1-a2': PROGRAM });
    const system = `You are Claude Code. MARK-SYSTEM\nPrimary working directory: ${clone('T-1-a1')}`;
    await claude(cluster, system, [{ role: 'user', content: 'Start. MARK-USER' }]);
    await codex(cluster, [environment(clone('T-1-a2')), user('Start.')]);
    await claude(cluster, system, [
      { role: 'user', content: 'Start. MARK-USER' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'MARK-OWN-WORDS' },
          { type: 'tool_use', id: 'e2e-s0', name: 'Bash', input: { command: 'echo MARK-OWN-CALL' } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'e2e-s0', content: 'MARK-RESULT' }] },
      { role: 'system', content: [{ type: 'text', text: 'A message from alice: MARK-INJECTED' }] },
    ]);
    const a1 = cluster.requestsFor('T-1-a1');
    expect(a1.map((recorded) => [recorded.vendor, recorded.answer?.kind === 'step' && recorded.answer.callId])).toEqual(
      [
        ['claude', 'e2e-s0'],
        ['claude', 'e2e-s1'],
      ],
    );
    expect(a1[0]?.seq).toBeLessThan(a1[1]?.seq as number);
    expect(a1[1]?.text).toContain('MARK-SYSTEM');
    for (const marker of ['MARK-SYSTEM', 'MARK-USER', 'MARK-RESULT', 'MARK-INJECTED']) {
      expect(cluster.sawText('T-1-a1', marker)).toBe(true);
    }
    // What the agent saw, not what it said: its own words and calls do not count.
    expect(cluster.sawText('T-1-a1', 'MARK-OWN-WORDS')).toBe(false);
    expect(cluster.sawText('T-1-a1', 'MARK-OWN-CALL')).toBe(false);
    expect(cluster.sawText('T-1-a2', 'MARK-USER')).toBe(false);

    await codex(cluster, [
      developer(`You are a worker. MARK-BRIEF\n\nYour working directory: ${clone('T-1-a2')}`),
      environment(clone('T-1-a2')),
      user('Start.'),
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'MARK-CODEX-WORDS' }] },
      { type: 'custom_tool_call', name: 'exec', call_id: 'e2e-s0', input: 'text("MARK-CODEX-CALL")' },
      { type: 'custom_tool_call_output', call_id: 'e2e-s0', output: [{ type: 'input_text', text: 'MARK-OUTPUT' }] },
      user('A message from alice: MARK-STEER'),
    ]);
    expect(cluster.requestsFor('T-1-a2').map((recorded) => recorded.vendor)).toEqual(['codex', 'codex']);
    for (const marker of ['MARK-BRIEF', 'MARK-OUTPUT', 'MARK-STEER']) {
      expect(cluster.sawText('T-1-a2', marker)).toBe(true);
    }
    expect(cluster.sawText('T-1-a2', 'MARK-CODEX-CALL')).toBe(false);
    expect(cluster.sawText('T-1-a2', 'MARK-CODEX-WORDS')).toBe(false);
    expect(cluster.requestsFor('T-1-a3')).toEqual([]);
  });

  test('addPrograms adds programs for later requests and keeps the others', async () => {
    const cluster = await models({ 'T-1-a1': PROGRAM });
    const successor: Program = { steps: [tool('write_handoff', { note: 'two' })] };
    const start = (attempt: string) =>
      claude(cluster, `Primary working directory: ${clone(attempt)}`, [{ role: 'user', content: 'Start the task.' }]);
    expect((await start('T-1-a2')).content).toEqual([{ type: 'text', text: UNSCRIPTED_TEXT }]);
    cluster.addPrograms({ 'T-1-a2': successor });
    expect((await start('T-1-a2')).content).toEqual([
      { type: 'tool_use', id: 'e2e-s0', name: 'mcp__agflow__write_handoff', input: { note: 'two' } },
    ]);
    // The program added earlier still answers.
    expect((await start('T-1-a1')).content).toMatchObject([{ type: 'tool_use', id: 'e2e-s0', name: 'Bash' }]);
    expect(cluster.unmatched().map((recorded) => recorded.attemptId)).toEqual(['T-1-a2']);
    // A finished program answers its closing text.
    const finished = await claude(cluster, `Primary working directory: ${clone('T-1-a2')}`, [
      { role: 'user', content: 'Start the task.' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'e2e-s0', name: 'mcp__agflow__write_handoff', input: {} }],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'e2e-s0', content: 'saved' }] },
    ]);
    expect(finished.content).toEqual([{ type: 'text', text: CLOSING_TEXT }]);
  });

  test('a request for an attempt without a program waits for addPrograms, within the grace', async () => {
    const cluster = await models({ 'T-1-a1': PROGRAM }, 5_000);
    const start = (attempt: string) =>
      claude(cluster, `Primary working directory: ${clone(attempt)}`, [{ role: 'user', content: 'Start the task.' }]);
    const early = start('T-1-a2');
    await Bun.sleep(200);
    // Nothing is recorded while it waits.
    expect(cluster.requestsFor('T-1-a2')).toEqual([]);
    cluster.addPrograms({ 'T-1-a2': PROGRAM });
    expect((await early).content).toMatchObject([{ type: 'tool_use', id: 'e2e-s0', name: 'Bash' }]);
    expect(cluster.unmatched()).toEqual([]);
    expect(cluster.requestsFor('T-1-a2').map((recorded) => recorded.answer?.kind)).toEqual(['step']);
    // An attempt nobody adds gets the default once the grace runs out.
    const short = await models({}, 300);
    const began = Date.now();
    const late = await claude(short, `Primary working directory: ${clone('T-9-a1')}`, [
      { role: 'user', content: 'Start the task.' },
    ]);
    expect(Date.now() - began).toBeGreaterThanOrEqual(250);
    expect(late.content).toEqual([{ type: 'text', text: UNSCRIPTED_TEXT }]);
    expect(short.unmatched().map((recorded) => recorded.attemptId)).toEqual(['T-9-a1']);
  });

  test('claudeEnv and codexConfig point the CLIs at the servers and the proxy', async () => {
    const cluster = await models();
    expect(cluster.proxyUrl).toBe(cluster.proxy.url);
    expect(cluster.claudeEnv).toEqual(claudeTestEnv({ baseUrl: cluster.anthropic.url, proxyUrl: cluster.proxyUrl }));
    expect(cluster.claudeEnv.HTTPS_PROXY).toBe(cluster.proxyUrl);
    expect(cluster.codexConfig).toEqual(codexTestConfig(cluster.responses.url));
  });

  test('externalAttempts lists what the proxy refused; close() stops both servers and the proxy', async () => {
    const cluster = await startModels();
    expect(cluster.externalAttempts()).toEqual([]);
    await fetch('https://example.com/', { proxy: cluster.proxy.url }).catch(() => undefined);
    expect(cluster.externalAttempts()).toEqual([
      { kind: 'connect', method: 'CONNECT', target: 'example.com:443', at: expect.any(Number) },
    ]);
    await cluster.close();
    await cluster.close();
    const urls = [`${cluster.anthropic.url}/v1/messages`, `${cluster.responses.url}/responses`, cluster.proxy.url];
    for (const url of urls) {
      const outcome = await fetch(url, { method: 'POST', body: '{}' }).then(
        () => 'answered',
        () => 'refused',
      );
      expect(outcome).toBe('refused');
    }
  });
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `bun test packages/testkit/test/models.test.ts`
Expected: FAIL — error: Cannot find module '../src/harness/models' from '.../packages/testkit/test/models.test.ts'

- [ ] **Step 3: Implement**

**File:** `packages/testkit/src/harness/index.ts` (change)

```diff
diff --git a/packages/testkit/src/harness/index.ts b/packages/testkit/src/harness/index.ts
index 73b304af..764b16a4 100644
--- a/packages/testkit/src/harness/index.ts
+++ b/packages/testkit/src/harness/index.ts
@@ -1,5 +1,6 @@
 // The multi-runner e2e harness (design 15, X-20). It has its own entry, so the testkit's main index keeps importing
 // runner types only; the harness imports runner and hub modules by path and adds no dependency (X-44).
 export * from './env';
+export * from './models';
 export * from './playbook';
 export * from './proc';
```

**File:** `packages/testkit/src/harness/models.ts` (new)

```ts
// The scripted models of a cluster (design 15, 15.1). One scripted Anthropic server and one scripted Responses
// provider serve every runner; each request goes to the playbook program of the attempt whose clone path it carries,
// and a request no program answers gets the server's harmless default. The refusing proxy stands in front of every
// external host. Every request the handlers see is recorded with its attempt, so a scenario can check what an agent
// was shown: its brief, a handoff note, a delivered message, a bridge answer.
import { claudeTestEnv } from '../anthropic/env';
import type { AnthropicRequest } from '../anthropic/request';
import { type ScriptedAnthropic, startScriptedAnthropic } from '../anthropic/server';
import type { ResponsesRequest } from '../codex/request';
import { type ResponsesServer, startResponsesServer } from '../codex/responses-server';
import { type CodexTestConfig, codexTestConfig } from '../codex/test-config';
import { type RefusedRequest, type RefusingProxy, startRefusingProxy } from '../refusing-proxy';
import { attemptIdIn, claudeReply, codexReply, type Next, nextStep, type Program, type Programs } from './playbook';

interface Recorded {
  /** Recording order across both servers, from 0: a request waiting for its program is recorded once answered. */
  seq: number;
  /** The attempt whose agent sent it; null for auxiliary requests and requests without a clone path. */
  attemptId: string | null;
  /** What the agent was shown, flattened: system or developer text, user and system entries, tool results. */
  text: string;
  /** What its program answered; null when no program did, and the server's default answered. */
  answer: Next | null;
}

export type RecordedRequest =
  | (Recorded & { vendor: 'claude'; request: AnthropicRequest })
  | (Recorded & { vendor: 'codex'; request: ResponsesRequest });

export interface Models {
  anthropic: ScriptedAnthropic;
  responses: ResponsesServer;
  proxy: RefusingProxy;
  /**
   * The refusing proxy's url. Runners get it as their connectivity variables (HTTPS_PROXY, HTTP_PROXY, ALL_PROXY), so
   * Codex and every tool command go through it too.
   */
  proxyUrl: string;
  /** runner.json's test.claudeEnv: claudeTestEnv for this server and proxy. */
  claudeEnv: Record<string, string>;
  /** runner.json's test.codexConfig: codexTestConfig for this provider. */
  codexConfig: CodexTestConfig;
  /**
   * Adds programs, or replaces those of the same attempts, and keeps the others. Register a successor ahead of time
   * under its predicted id (core's attemptId and leadAttemptId); a request already waiting for it gets it at once.
   */
  addPrograms(programs: Programs): void;
  /** Every recorded request, in arrival order. */
  requests(): RecordedRequest[];
  /** The attempt's requests, in arrival order. */
  requestsFor(attemptId: string): RecordedRequest[];
  /** Whether any request of the attempt showed the agent the marker. */
  sawText(attemptId: string, marker: string): boolean;
  /** Main-loop requests no program answered: an unknown attempt, or one without a clone path. */
  unmatched(): RecordedRequest[];
  /** What the proxy refused: every connection a CLI or a tool tried to an external host. */
  externalAttempts(): RefusedRequest[];
  /** Stops both servers and the proxy. */
  close(): Promise<void>;
}

export interface ModelsOptions {
  programs?: Programs;
  /**
   * How long a main-loop request for an attempt without a program waits for addPrograms before the server's default
   * answers it; 10 s by default. The hub starts a successor as soon as its predecessor ends, which can be before the
   * scenario has added its program, and a default answer would end its first turn. Tests of unmatched requests pass 0.
   */
  programWaitMs?: number;
}

const DEFAULT_PROGRAM_WAIT_MS = 10_000;

type Item = Record<string, unknown>;

function textParts(content: unknown): string[] {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content
    .map((part) => (part !== null && typeof part === 'object' ? (part as Item).text : undefined))
    .filter((part): part is string => typeof part === 'string');
}

function join(parts: string[]): string {
  return parts.filter((part) => part !== '').join('\n');
}

/** The model's own replies are left out: a marker in its words or its commands is not one it was shown. */
function claudeText(request: AnthropicRequest): string {
  const parts = [request.system];
  for (const message of request.messages) {
    if (message.role === 'assistant') continue;
    for (const block of message.blocks) {
      if (block.type === 'text' || block.type === 'tool_result') parts.push(block.text);
    }
  }
  return join(parts);
}

/** Codex 0.159.2 sends no top-level instructions: its base prompt and the brief are developer messages. */
function codexText(request: ResponsesRequest): string {
  const parts: string[] = [];
  const input = Array.isArray(request.body.input) ? (request.body.input as unknown[]) : [];
  for (const raw of input) {
    if (raw === null || typeof raw !== 'object') continue;
    const item = raw as Item;
    if (item.type === 'message' && item.role !== 'assistant') parts.push(...textParts(item.content));
    else if (typeof item.type === 'string' && item.type.endsWith('_call_output')) parts.push(...textParts(item.output));
  }
  return join(parts);
}

export async function startModels(options: ModelsOptions = {}): Promise<Models> {
  const recorded: RecordedRequest[] = [];
  const programs: Programs = { ...options.programs };
  const programWaitMs = options.programWaitMs ?? DEFAULT_PROGRAM_WAIT_MS;
  let closing: Promise<void> | null = null;
  // Requests waiting for a program; addPrograms and close wake them all.
  const waiting = new Set<() => void>();
  const wakeAll = () => {
    for (const wake of [...waiting]) wake();
  };

  /** The attempt's program, waiting up to programWaitMs for addPrograms when it has none yet. */
  async function programFor(attemptId: string | null): Promise<Program | undefined> {
    if (attemptId === null) return undefined;
    const deadline = Date.now() + programWaitMs;
    while (programs[attemptId] === undefined && closing === null && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(timer);
          waiting.delete(wake);
          resolve();
        };
        const timer = setTimeout(wake, deadline - Date.now());
        waiting.add(wake);
      });
    }
    return programs[attemptId];
  }

  /** The program's answer for the request's attempt, or null when it has none. */
  async function answerFor(
    attemptId: string | null,
    request: AnthropicRequest | ResponsesRequest,
  ): Promise<Next | null> {
    const program = await programFor(attemptId);
    return program === undefined ? null : nextStep(program, request);
  }

  // Each start is undone if a later one fails, so a failed start leaks no listener.
  const started: { close(): Promise<void> }[] = [];
  let anthropic: ScriptedAnthropic;
  let responses: ResponsesServer;
  let proxy: RefusingProxy;
  try {
    proxy = await startRefusingProxy();
    started.push(proxy);
    anthropic = await startScriptedAnthropic({
      async handler(request) {
        const attemptId = attemptIdIn(request);
        const answer = await answerFor(attemptId, request);
        const text = claudeText(request);
        recorded.push({ seq: recorded.length, vendor: 'claude', attemptId, text, answer, request });
        return answer === null ? undefined : claudeReply(answer);
      },
    });
    started.push(anthropic);
    responses = await startResponsesServer({
      async handler(request) {
        const attemptId = attemptIdIn(request);
        const answer = await answerFor(attemptId, request);
        const text = codexText(request);
        recorded.push({ seq: recorded.length, vendor: 'codex', attemptId, text, answer, request });
        return answer === null ? undefined : codexReply(answer);
      },
    });
  } catch (error) {
    await Promise.all(started.map((server) => server.close()));
    throw error;
  }

  const proxyUrl = proxy.url;
  const requestsFor = (attemptId: string) => recorded.filter((request) => request.attemptId === attemptId);

  return {
    anthropic,
    responses,
    proxy,
    proxyUrl,
    claudeEnv: claudeTestEnv({ baseUrl: anthropic.url, proxyUrl }),
    codexConfig: codexTestConfig(responses.url),
    addPrograms(added) {
      Object.assign(programs, added);
      wakeAll();
    },
    requests: () => [...recorded],
    requestsFor,
    sawText: (attemptId, marker) => requestsFor(attemptId).some((request) => request.text.includes(marker)),
    unmatched: () =>
      recorded.filter(
        (entry) =>
          entry.answer === null && (entry.vendor === 'claude' ? entry.request.mainLoop : !entry.request.isCompaction),
      ),
    externalAttempts: () => [...proxy.refused],
    close() {
      closing ??= Promise.all([anthropic.close(), responses.close(), proxy.close()]).then(() => undefined);
      wakeAll();
      return closing;
    },
  };
}
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `bun test packages/testkit/test/models.test.ts && bun run typecheck`
Expected: all selected tests pass (0 fail); tsc exits 0.

addPrograms merges; it does not replace unrelated programs. A main-loop request for an unregistered valid attempt waits up to programWaitMs (10 s by default), then gets the harmless default. seq records recording order after that wait. sawText excludes the model’s own replies; raw server failures before the handler remain on the server. close is idempotent and wakes waiters. No real CLI or model is required. See Decisions 29–30.

- [ ] **Step 5: Commit**

```bash
git add -A 'packages/testkit/src/harness/index.ts' 'packages/testkit/src/harness/models.ts' 'packages/testkit/test/models.test.ts'
git commit -m 'M2G Task 3: Harness: scripted models for a cluster' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

### Task 4: Harness: the hub as a process, and a person's API client

Scenarios restart, kill and restore the hub, so it runs as a real process: `bun packages/hub/src/main.ts`, which serves startHub with the database lock and the automatic scheduler (X-26). It gets a temporary database and backup folder, dev sign-in for alice, bob and carol, the origin's path as AGFLOW_PROJECT_REPO (a local path works as is, X-43), and hub test mode: AGFLOW_TEST=1 with E2E_HUB_TIMINGS as AGFLOW_TEST_CONFIG (X-27). The E2E timings keep liveness short (tick, heartbeat, dead link, lease, recovery, backoff, dispatch hold) and judgement long (stall, tool caps, lead review, active budget), so a scenario trips only the rule it tests. A person client signs in through /auth/dev, approves CLI logins to mint each runner owner's CLI token, and wraps the M1 and M2 routes the scenarios call. It parses answers with core's response schemas; its errors carry the method, path, status and body. These tests need no vendor CLI, so they run in CI.

**Files:**
- Create: `packages/testkit/src/harness/hub-process.ts`
- Modify: `packages/testkit/src/harness/index.ts`
- Create: `packages/testkit/src/harness/person.ts`
- Test: `packages/testkit/test/hub-process.test.ts`

- [ ] **Step 1: Write the failing test**

**File:** `packages/testkit/test/hub-process.test.ts` (new)

```ts
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { type HubStatus, WhoamiResponseSchema } from '@agflow/core';
import { loadConfig } from '../../hub/src/config';
import { type OriginRepo, originRepo } from '../src/git-fixtures';
import { E2E_HUB_TIMINGS, E2E_USERS, type HubProcess, startHubProcess } from '../src/harness/hub-process';
import { HubCallError, cliToken, signIn } from '../src/harness/person';

const hubs: HubProcess[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const hub of hubs.splice(0)) {
    if (hub.running) await hub.kill();
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A hub process whose project repository is a local bare origin; in a fresh directory by default. */
async function startHubWithOrigin(dir?: string): Promise<{ hub: HubProcess; origin: OriginRepo }> {
  const hubDir = dir ?? mkdtempSync('/tmp/agf-hub-');
  if (dir === undefined) dirs.push(hubDir);
  const origin = await originRepo({ 'README.md': 'hub process test\n' });
  dirs.push(origin.root);
  const hub = await startHubProcess({ dir: hubDir, repo: origin.path });
  hubs.push(hub);
  return { hub, origin };
}

async function startHub(): Promise<HubProcess> {
  return (await startHubWithOrigin()).hub;
}

const task = (title: string) => ({ title, objective: `Do ${title}.`, acceptance: [{ id: 'done', assertion: 'it is done' }] });

describe('E2E_HUB_TIMINGS', () => {
  test('passes the hub config loader in test mode, and every key is a HubConfig millisecond field', () => {
    const { config } = loadConfig({
      AGFLOW_AUTH: 'dev',
      AGFLOW_ALLOWED_USERS: E2E_USERS.join(','),
      AGFLOW_PROJECT_NAME: 'e2e',
      AGFLOW_PROJECT_REPO: '/tmp/origin.git',
      AGFLOW_TEST: '1',
      AGFLOW_TEST_CONFIG: JSON.stringify(E2E_HUB_TIMINGS),
    });
    for (const [key, value] of Object.entries(E2E_HUB_TIMINGS)) {
      expect(key).toMatch(/Ms$/);
      expect(config[key as keyof typeof config]).toEqual(value);
    }
    // The WIP grace the hub sends follows the short lease (X-11).
    expect(config.wipGraceMs).toBe(Math.floor(E2E_HUB_TIMINGS.runnerLeaseMs / 3));
  });

  test('keep liveness to seconds and judgement long', () => {
    const { tickMs, heartbeatMs, deadLinkMs, runnerLeaseMs, recoveryMs, dispatchHoldMs, infraBackoffMs } =
      E2E_HUB_TIMINGS;
    for (const liveness of [tickMs, heartbeatMs, deadLinkMs, runnerLeaseMs, recoveryMs, dispatchHoldMs, ...infraBackoffMs]) {
      expect(liveness).toBeLessThanOrEqual(60_000);
    }
    expect(deadLinkMs).toBeGreaterThanOrEqual(3 * heartbeatMs);
    expect(runnerLeaseMs).toBeGreaterThan(deadLinkMs);
    const { stallMs, toolCapMs, longToolCapMs, leadReviewMs, activeBudgetMs } = E2E_HUB_TIMINGS;
    for (const judgement of [stallMs, toolCapMs, longToolCapMs, leadReviewMs, activeBudgetMs]) {
      expect(judgement).toBeGreaterThanOrEqual(60 * 60_000);
    }
  });
});

describe('startHubProcess', () => {
  test('starts main.ts in test mode with dev sign-in, the users and the repository, logging to the hub directory', async () => {
    const { hub, origin } = await startHubWithOrigin();
    expect(hub.url).toBe(`http://127.0.0.1:${hub.port}`);
    expect(hub.env).toMatchObject({
      AGFLOW_AUTH: 'dev',
      AGFLOW_ALLOWED_USERS: 'alice,bob,carol',
      AGFLOW_TEST: '1',
      AGFLOW_PORT: String(hub.port),
      AGFLOW_DB: hub.dbPath,
      AGFLOW_BACKUP_DIR: hub.backupDir,
      AGFLOW_PROJECT_REPO: origin.path,
    });
    expect(JSON.parse(hub.env.AGFLOW_TEST_CONFIG ?? '')).toEqual(E2E_HUB_TIMINGS);
    const config = (await (await fetch(`${hub.url}/api/auth-config`)).json()) as { mode: string; project: string };
    expect(config).toEqual({ mode: 'dev', project: 'e2e' });
    for (const login of E2E_USERS) {
      const person = await signIn(hub.url, login);
      expect((await person.project()).repo).toBe(origin.path);
    }
    expect(hub.logPath.startsWith(hub.dir)).toBe(true);
    expect(readFileSync(hub.logPath, 'utf8')).toContain('agflow hub for "e2e"');
    expect(hub.logTail()).toContain('agflow hub for "e2e"');
  }, 30_000);

  test('creates a hub directory that does not exist yet', async () => {
    const base = mkdtempSync('/tmp/agf-hub-');
    dirs.push(base);
    const dir = join(base, 'missing', 'hub');
    const { hub } = await startHubWithOrigin(dir);
    expect(hub.dir).toBe(dir);
    expect(existsSync(hub.logPath)).toBe(true);
    expect((await (await signIn(hub.url, 'alice')).status()).epoch).toBe(1);
  }, 30_000);

  test('GET /api/status shows no lead seat, epoch 1 and the project', async () => {
    const hub = await startHub();
    const status: HubStatus = await (await signIn(hub.url, 'alice')).status();
    expect(status.leadSeat.kind).toBe('none');
    expect(status.epoch).toBe(1);
    expect(status.project.name).toBe('e2e');
  }, 30_000);

  test('restart() brings the hub back on the same port and database', async () => {
    const hub = await startHub();
    const alice = await signIn(hub.url, 'alice');
    expect((await alice.setGoal('Ship the e2e harness')).version).toBe(1);
    const { pid, url } = hub;
    await hub.restart();
    expect(hub.url).toBe(url);
    expect(hub.pid).not.toBe(pid);
    expect((await alice.status()).goalVersion).toBe(1);
  }, 30_000);

  test('kill() leaves a stale database lock, and the next start replaces it', async () => {
    const hub = await startHub();
    const pid = hub.pid;
    await hub.kill();
    expect(hub.running).toBe(false);
    expect(readFileSync(`${hub.dbPath}.pid`, 'utf8')).toContain(String(pid));
    await hub.start();
    expect(hub.running).toBe(true);
    expect((await (await signIn(hub.url, 'bob')).status()).epoch).toBe(1);
  }, 30_000);

  test("backups('start') lists the start snapshots, newest last", async () => {
    const hub = await startHub();
    expect(hub.backups('start')).toHaveLength(1);
    await hub.restart();
    const backups = hub.backups('start');
    expect(backups).toHaveLength(2);
    expect(backups.map((file) => basename(file))).toEqual(backups.map((file) => basename(file)).sort());
    for (const file of backups) {
      expect(file.startsWith(hub.backupDir)).toBe(true);
      expect(basename(file)).toMatch(/^agflow-start-.*\.db$/);
    }
    expect(hub.backups('daily')).toHaveLength(1);
  }, 30_000);

  test('restore() runs the restore command while the hub is stopped: epoch 2, and counters 1000 ahead', async () => {
    const hub = await startHub();
    const alice = await signIn(hub.url, 'alice');
    const [last] = await alice.createTasks([task('first')]);
    // The start snapshot of this restart knows the task.
    await hub.restart();
    const backup = hub.backups('start').at(-1) ?? '';
    await expect(hub.restore(backup)).rejects.toThrow('stop the hub');
    await hub.stop();
    expect(await hub.restore(backup)).toContain('at epoch 2');
    await hub.start();
    const person = await signIn(hub.url, 'alice');
    expect((await person.status()).epoch).toBe(2);
    const [next] = await person.createTasks([task('second')]);
    const number = (id: string | undefined) => Number(id?.slice(2));
    expect(number(next?.id)).toBeGreaterThan(number(last?.id) + 1000);
    expect(hub.logTail()).toContain('restored');
  }, 30_000);
});

describe('person', () => {
  test('cliToken approves a CLI login and returns a token the runner whoami accepts for that person', async () => {
    const hub = await startHub();
    const carol = await signIn(hub.url, 'carol');
    const token = await cliToken(carol);
    const response = await fetch(`${hub.url}/api/runner/whoami`, { headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    expect(WhoamiResponseSchema.parse(await response.json())).toEqual({ user: 'carol' });
  }, 30_000);

  test('a call with an unexpected status throws with the method, path, status and body', async () => {
    const hub = await startHub();
    const alice = await signIn(hub.url, 'alice');
    const error = await alice.accept('T-999').then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(HubCallError);
    const call = error as HubCallError;
    expect(call).toMatchObject({ method: 'POST', path: '/api/tasks/T-999/accept', status: 404 });
    expect(call.body).toContain('not_found');
    expect(call.message).toContain('POST /api/tasks/T-999/accept');
    expect(call.message).toContain('404');
    expect(call.message).toContain(call.body);
  }, 30_000);

  test('signIn refuses a login the hub does not allow', async () => {
    const hub = await startHub();
    await expect(signIn(hub.url, 'mallory')).rejects.toBeInstanceOf(HubCallError);
  }, 30_000);

  test('the M2 reads parse with core response schemas', async () => {
    const hub = await startHub();
    const alice = await signIn(hub.url, 'alice');
    expect(await alice.runners()).toEqual({ runners: [], accounts: [] });
    expect(await alice.attempts()).toEqual([]);
    expect(await alice.leadNotes()).toEqual([]);
    expect((await alice.setRunnerLeads(false)).runnerLeads).toBe(false);
  }, 30_000);

  test('an M2 answer that drifts from the core schema fails the call', async () => {
    // A stand-in hub: sign-in works, and the M2 reads answer with an extra field or an incomplete attempt.
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(request) {
        const { pathname } = new URL(request.url);
        if (pathname === '/auth/dev') {
          const headers = { location: '/', 'set-cookie': 'agflow_session=s1; Path=/' };
          return new Response(null, { status: 302, headers });
        }
        if (pathname === '/api/runners') return Response.json({ runners: [], accounts: [], extra: true });
        if (pathname === '/api/attempts') return Response.json({ attempts: [{ id: 'T-1.a1' }] });
        return new Response('not found', { status: 404 });
      },
    });
    try {
      const alice = await signIn(`http://127.0.0.1:${server.port}`, 'alice');
      // A ZodError; testkit has no zod dependency of its own to import the class from.
      await expect(alice.runners()).rejects.toMatchObject({ name: 'ZodError' });
      await expect(alice.attempts()).rejects.toMatchObject({ name: 'ZodError' });
    } finally {
      server.stop(true);
    }
  });

  test('a call to a hub that does not answer throws with status 0', async () => {
    const hub = await startHub();
    const alice = await signIn(hub.url, 'alice');
    await hub.kill();
    const error = await alice.status().then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(HubCallError);
    expect((error as HubCallError).status).toBe(0);
    expect((error as HubCallError).message).toContain('GET /api/status failed');
  }, 30_000);
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `bun test packages/testkit/test/hub-process.test.ts`
Expected: FAIL — error: Cannot find module '../src/harness/hub-process' from '.../packages/testkit/test/hub-process.test.ts'

- [ ] **Step 3: Implement**

**File:** `packages/testkit/src/harness/hub-process.ts` (new)

```ts
// The hub as a real process (design 6.14, 12, 15). Scenarios restart, kill and restore the hub, so it runs as
// `bun packages/hub/src/main.ts`, which serves startHub with the database lock and the automatic scheduler (X-26), in
// hub test mode with the E2E timings (X-27). The harness imports hub modules by path and adds no dependency (X-44).
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { BackupKind } from '../../../hub/src/backup';
import type { HubConfig } from '../../../hub/src/context';

const HUB_SRC = join(import.meta.dir, '../../../hub/src');
const MAIN = join(HUB_SRC, 'main.ts');
const RESTORE = join(HUB_SRC, 'restore.ts');

const SECOND = 1000;
const MINUTE = 60 * SECOND;

type MillisecondField = { [K in keyof HubConfig]-?: K extends `${string}Ms` ? K : never }[keyof HubConfig];

/** Hub settings AGFLOW_TEST_CONFIG may carry: HubConfig's millisecond fields (X-27). */
export type HubTimings = Partial<Pick<HubConfig, MillisecondField>>;

/**
 * The E2E hub timings. Liveness is short, so a fault shows within seconds: the tick, the heartbeat and dead link, the
 * runner lease (whose third is the WIP grace, X-11), the recovery window, the infra backoff, the dispatch hold for late
 * work and delivery batching. Judgement is long, so a scenario trips only the rule it tests: no stall, tool cap, lead
 * review or active budget ends an attempt during a run.
 */
export const E2E_HUB_TIMINGS = Object.freeze({
  tickMs: SECOND,
  heartbeatMs: SECOND,
  deadLinkMs: 5 * SECOND,
  runnerLeaseMs: 30 * SECOND,
  recoveryMs: 15 * SECOND,
  infraBackoffMs: [SECOND, 2 * SECOND, 5 * SECOND],
  dispatchHoldMs: 10 * SECOND,
  deliveryBatchMs: 500,
  stallMs: 60 * MINUTE,
  toolCapMs: 60 * MINUTE,
  longToolCapMs: 120 * MINUTE,
  leadReviewMs: 60 * MINUTE,
  activeBudgetMs: 8 * 60 * MINUTE,
}) satisfies HubTimings;

/** The people of a cluster: each owns a runner, and any of them signs in to the dev hub. */
export const E2E_USERS = ['alice', 'bob', 'carol'] as const;

export interface HubProcessOptions {
  /** The hub's directory: agflow.db, backups/ and hub.log; created when missing. */
  dir: string;
  /** AGFLOW_PROJECT_REPO: the origin's path; a local bare repository works as is (X-43). */
  repo: string;
  /** 'e2e' by default. */
  projectName?: string;
  /** The logins dev sign-in admits; E2E_USERS by default. */
  users?: readonly string[];
  /** AGFLOW_TEST_CONFIG; E2E_HUB_TIMINGS by default. */
  timings?: HubTimings;
  /** How long a start may take to answer /api/auth-config; 30 s by default. */
  startTimeoutMs?: number;
}

export interface HubProcess {
  /** http://127.0.0.1:<port>, the same across restarts. */
  readonly url: string;
  readonly port: number;
  readonly dir: string;
  readonly dbPath: string;
  readonly backupDir: string;
  /** stdout and stderr of every start and restore, appended. */
  readonly logPath: string;
  /** The environment each start gets. */
  readonly env: Readonly<Record<string, string>>;
  /** The running hub's pid; null while it is stopped. */
  readonly pid: number | null;
  readonly running: boolean;
  /** Starts main.ts and resolves once /api/auth-config answers. */
  start(): Promise<void>;
  /** SIGTERM: the hub closes the database cleanly and gives up its lock; it must exit 0. */
  stop(): Promise<void>;
  /** stop(), then start(), on the same port and database. */
  restart(): Promise<void>;
  /** SIGKILL, as a crash: the database lock (<db>.pid) stays behind, stale. */
  kill(): Promise<void>;
  /** The kind's finished snapshots in the backup folder, newest last. */
  backups(kind: BackupKind): string[];
  /** Runs `bun packages/hub/src/restore.ts <backup>` on this hub's database, while it is stopped; gives its output. */
  restore(backup: string): Promise<string>;
  /** The last lines of the hub's log. */
  logTail(lines?: number): string;
}

const DEFAULT_START_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 20_000;
const POLL_MS = 50;

/** A port that was free a moment ago; restarts reuse it, so the runners' hub URL never changes. */
function freePort(): number {
  const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response() });
  const port = probe.port as number;
  probe.stop(true);
  return port;
}

function tail(text: string, lines: number): string {
  return text.split('\n').filter(Boolean).slice(-lines).join('\n');
}

/** Resolves with the exit code, or null when the process is still running after timeoutMs. */
async function exitWithin(proc: Bun.Subprocess, timeoutMs: number): Promise<number | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    return await Promise.race([proc.exited, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** A hub process on a free port, started. */
export async function startHubProcess(options: HubProcessOptions): Promise<HubProcess> {
  const hub = createHubProcess(options, freePort());
  await hub.start();
  return hub;
}

function createHubProcess(options: HubProcessOptions, port: number): HubProcess {
  const { dir } = options;
  const url = `http://127.0.0.1:${port}`;
  const dbPath = join(dir, 'agflow.db');
  const backupDir = join(dir, 'backups');
  const logPath = join(dir, 'hub.log');
  const startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
  // The log opens before main.ts runs, so the directory must exist first.
  mkdirSync(dir, { recursive: true });
  // Only what the hub reads: a developer's own AGFLOW_* variables must not reach it. HOME is the hub directory, so
  // nothing the hub or bun writes lands in the real home.
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: dir,
    ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
    AGFLOW_AUTH: 'dev',
    AGFLOW_ALLOWED_USERS: (options.users ?? E2E_USERS).join(','),
    AGFLOW_PROJECT_NAME: options.projectName ?? 'e2e',
    AGFLOW_PROJECT_REPO: options.repo,
    AGFLOW_PORT: String(port),
    AGFLOW_PUBLIC_URL: url,
    AGFLOW_DB: dbPath,
    AGFLOW_BACKUP_DIR: backupDir,
    AGFLOW_TEST: '1',
    AGFLOW_TEST_CONFIG: JSON.stringify(options.timings ?? E2E_HUB_TIMINGS),
  };
  let proc: Bun.Subprocess | null = null;

  const running = () => proc !== null && proc.exitCode === null && proc.signalCode === null;

  function log(line: string): void {
    const fd = openSync(logPath, 'a');
    try {
      writeSync(fd, `${line}\n`);
    } finally {
      closeSync(fd);
    }
  }

  function logTail(lines = 40): string {
    return existsSync(logPath) ? tail(readFileSync(logPath, 'utf8'), lines) : '';
  }

  /** Spawns a bun script in the hub directory, its output appended to the log. */
  function spawn(argv: string[], spawnEnv: Record<string, string>): Bun.Subprocess {
    const fd = openSync(logPath, 'a');
    try {
      // --no-env-file: a .env file must not add settings to the hub's.
      return Bun.spawn([process.execPath, '--no-env-file', ...argv], {
        cwd: dir,
        env: spawnEnv,
        stdin: 'ignore',
        stdout: fd,
        stderr: fd,
      });
    } finally {
      closeSync(fd);
    }
  }

  async function answers(): Promise<boolean> {
    try {
      return (await fetch(`${url}/api/auth-config`, { signal: AbortSignal.timeout(2_000) })).ok;
    } catch {
      return false;
    }
  }

  async function start(): Promise<void> {
    if (running()) throw new Error(`the hub at ${url} is already running (pid ${proc?.pid})`);
    log(`--- harness: starting the hub at ${new Date().toISOString()}`);
    const started = spawn([MAIN], env);
    proc = started;
    const deadline = Date.now() + startTimeoutMs;
    while (!(await answers())) {
      if (started.exitCode !== null || started.signalCode !== null) {
        throw new Error(`the hub exited (${started.exitCode ?? started.signalCode}) before it answered:\n${logTail()}`);
      }
      if (Date.now() > deadline) {
        started.kill('SIGKILL');
        await started.exited;
        throw new Error(`the hub did not answer at ${url} within ${startTimeoutMs} ms:\n${logTail()}`);
      }
      await Bun.sleep(POLL_MS);
    }
  }

  async function stop(): Promise<void> {
    const current = proc;
    if (current === null || !running()) throw new Error(`the hub at ${url} is not running`);
    current.kill('SIGTERM');
    const code = await exitWithin(current, STOP_TIMEOUT_MS);
    if (code === null) {
      current.kill('SIGKILL');
      await current.exited;
      throw new Error(`the hub did not stop within ${STOP_TIMEOUT_MS} ms of SIGTERM:\n${logTail()}`);
    }
    if (code !== 0) throw new Error(`the hub exited ${code} on SIGTERM:\n${logTail()}`);
  }

  async function kill(): Promise<void> {
    const current = proc;
    if (current === null || !running()) throw new Error(`the hub at ${url} is not running`);
    log(`--- harness: SIGKILL at ${new Date().toISOString()}`);
    current.kill('SIGKILL');
    await current.exited;
  }

  async function restore(backup: string): Promise<string> {
    if (running()) throw new Error(`stop the hub at ${url} before a restore`);
    log(`--- harness: restoring ${backup} at ${new Date().toISOString()}`);
    const before = existsSync(logPath) ? readFileSync(logPath, 'utf8').length : 0;
    const restoring = spawn([RESTORE, backup], { PATH: env.PATH ?? '', HOME: dir, AGFLOW_DB: dbPath });
    const code = await restoring.exited;
    const output = readFileSync(logPath, 'utf8').slice(before);
    if (code !== 0) throw new Error(`the restore of ${backup} exited ${code}:\n${output}`);
    return output;
  }

  function backups(kind: BackupKind): string[] {
    if (!existsSync(backupDir)) return [];
    // Finished snapshots only: an interrupted one is agflow-<kind>.tmp. Their names sort in time order.
    return readdirSync(backupDir)
      .filter((name) => name.startsWith(`agflow-${kind}-`) && name.endsWith('.db'))
      .sort()
      .map((name) => join(backupDir, name));
  }

  return {
    url,
    port,
    dir,
    dbPath,
    backupDir,
    logPath,
    env,
    get pid() {
      return running() ? (proc?.pid ?? null) : null;
    },
    get running() {
      return running();
    },
    start,
    stop,
    async restart() {
      await stop();
      await start();
    },
    kill,
    backups,
    restore,
    logTail,
  };
}
```

**File:** `packages/testkit/src/harness/index.ts` (change)

```diff
diff --git a/packages/testkit/src/harness/index.ts b/packages/testkit/src/harness/index.ts
index 764b16a4..d2607a29 100644
--- a/packages/testkit/src/harness/index.ts
+++ b/packages/testkit/src/harness/index.ts
@@ -1,6 +1,8 @@
 // The multi-runner e2e harness (design 15, X-20). It has its own entry, so the testkit's main index keeps importing
 // runner types only; the harness imports runner and hub modules by path and adds no dependency (X-44).
 export * from './env';
+export * from './hub-process';
 export * from './models';
+export * from './person';
 export * from './playbook';
 export * from './proc';
```

**File:** `packages/testkit/src/harness/person.ts` (new)

```ts
// A person's API client (design 6.16, 6.17): signed in through dev sign-in with a browser session, as the web UI is,
// so it may do what only people in the browser do (take over, hand back, act on agents, turn runner leads off). It
// wraps the M1 and M2 routes the scenarios call. The M2 answers parse with core's response schemas, so a hub that
// drifts from the contract fails the harness; M1's answers have core types only. Every unexpected status throws a
// HubCallError that carries the method, the path, the status and the body.
import { randomUUID } from 'node:crypto';
import {
  type AccountQuota,
  type AgentRole,
  type Attempt,
  type AttemptLogEntry,
  AttemptDetailResponseSchema,
  AttemptResponseSchema,
  AttemptsResponseSchema,
  type GoalVersion,
  type HubEvent,
  type HubStatus,
  type LeadNote,
  LeadNotesResponseSchema,
  type Message,
  type MessageView,
  type NewTaskInput,
  OkResponseSchema,
  type Project,
  ProjectSchema,
  type Runner,
  RunnersResponseSchema,
  type Task,
  type TaskDetail,
  TakeoverResponseSchema,
} from '@agflow/core';
import type { CliLoginPoll } from '../../../hub/src/auth';

/** A hub answer with a status the call did not expect, or a hub the call could not reach (status 0). */
export class HubCallError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(status === 0 ? `${method} ${path} failed: ${body}` : `${method} ${path} answered ${status}: ${body}`);
    this.name = 'HubCallError';
  }
}

/** Each call gives up after this long; scenarios wait on state with deadlines of their own. */
const CALL_TIMEOUT_MS = 30_000;
/** How long cliToken polls an approved login, which the hub answers at once. */
const POLL_TIMEOUT_MS = 10_000;

type Query = Record<string, string | number | boolean | undefined>;

function withQuery(path: string, query: Query = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `${path}?${text}` : path;
}

interface CallOptions {
  body?: unknown;
  /** The statuses that count as success; [200] by default. */
  expect?: readonly number[];
  headers?: Record<string, string>;
}

/** One call to the hub; the parsed JSON answer, or a HubCallError for any other status. */
async function call(hubUrl: string, method: string, path: string, options: CallOptions = {}): Promise<unknown> {
  const headers: Record<string, string> = { accept: 'application/json', ...options.headers };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  let response: Response;
  try {
    response = await fetch(`${hubUrl}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      redirect: 'manual',
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
  } catch (error) {
    throw new HubCallError(method, path, 0, error instanceof Error ? error.message : String(error));
  }
  const text = await response.text();
  if (!(options.expect ?? [200]).includes(response.status)) throw new HubCallError(method, path, response.status, text);
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new HubCallError(method, path, response.status, `not JSON: ${text}`);
  }
}

export interface AttemptsQuery {
  task?: string;
  role?: AgentRole;
  runner?: string;
  /** One status, or several. */
  status?: Attempt['status'] | Attempt['status'][];
  limit?: number;
}

export interface EventsQuery {
  after?: number;
  subject?: string;
  limit?: number;
  /** The newest events first. */
  latest?: boolean;
}

export interface MessagesQuery {
  taskId?: string;
  target?: string;
  limit?: number;
}

export interface SendMessage {
  /** lead, all, humans, agent:A-<n> or task:T-<n>. */
  to: string;
  body: string;
  taskId?: string;
}

/** POST /api/tasks/:id/handback: from the runner's clone, or from a pushed ref with its full sha. */
export type HandbackSource = 'clone' | { ref: string; sha: string };

export interface AgentStopInput {
  reason: string;
  /** Stop and hold, so a person can still take the clone over. */
  hold?: boolean;
}

export interface Person {
  readonly login: string;
  readonly hubUrl: string;
  /** Any call with the person's session, for routes the wrappers leave out. */
  request(method: string, path: string, options?: CallOptions): Promise<unknown>;

  // M1
  status(): Promise<HubStatus>;
  project(): Promise<Project>;
  /** Saves a new goal version on top of the current one. */
  setGoal(text: string): Promise<GoalVersion>;
  createTasks(tasks: NewTaskInput[]): Promise<Task[]>;
  /** The task with its notes, events, messages, attempts and submissions. */
  task(id: string): Promise<TaskDetail>;
  accept(taskId: string, note?: string): Promise<Task>;
  unblock(taskId: string, note?: string): Promise<Task>;
  send(message: SendMessage): Promise<Message>;
  /** Newest first, each with its deliveries. */
  messages(query?: MessagesQuery): Promise<MessageView[]>;
  events(query?: EventsQuery): Promise<HubEvent[]>;

  // M2
  runners(): Promise<{ runners: Runner[]; accounts: AccountQuota[] }>;
  setRunnerLeads(on: boolean): Promise<Project>;
  /** Newest first. */
  attempts(query?: AttemptsQuery): Promise<Attempt[]>;
  attempt(id: string): Promise<{ attempt: Attempt; log: AttemptLogEntry[] }>;
  leadNotes(): Promise<LeadNote[]>;
  /** 202: the attempt taken over. */
  takeover(taskId: string): Promise<string>;
  /** 202: the attempt whose work is handed back. */
  handback(taskId: string, source: HandbackSource): Promise<string>;
  /** 200, or 202 while a pending submission defers the stop. */
  stopAgent(agentId: string, input: AgentStopInput): Promise<Attempt>;
  replaceAgent(agentId: string, reason: string): Promise<Attempt>;
  interruptAgent(agentId: string): Promise<void>;
}

/** Signs the person in through dev sign-in and keeps the session cookie, as a browser does. */
export async function signIn(hubUrl: string, login: string): Promise<Person> {
  const path = `/auth/dev?user=${encodeURIComponent(login)}`;
  let response: Response;
  try {
    response = await fetch(`${hubUrl}${path}`, { redirect: 'manual', signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
  } catch (error) {
    throw new HubCallError('GET', path, 0, error instanceof Error ? error.message : String(error));
  }
  const text = await response.text();
  // The cookie's name=value, without its attributes, is what a browser sends back.
  const cookie = response.headers.getSetCookie()[0]?.split(';')[0];
  if (response.status !== 302 || !cookie) throw new HubCallError('GET', path, response.status, text);
  return createPerson(hubUrl, login, cookie);
}

function createPerson(hubUrl: string, login: string, cookie: string): Person {
  const request = (method: string, path: string, options: CallOptions = {}) =>
    call(hubUrl, method, path, { ...options, headers: { cookie, ...options.headers } });
  const get = (path: string, query?: Query) => request('GET', withQuery(path, query));
  const post = (path: string, body: unknown, expect?: readonly number[]) => request('POST', path, { body, expect });
  const task = (id: string) => `/api/tasks/${encodeURIComponent(id)}`;
  const agent = (id: string) => `/api/agents/${encodeURIComponent(id)}`;

  return {
    login,
    hubUrl,
    request,

    status: async () => (await get('/api/status')) as HubStatus,
    project: async () => ProjectSchema.parse(await get('/api/project')),
    async setGoal(text) {
      const { current } = (await get('/api/goal')) as { current: GoalVersion | null };
      const body = { text, baseVersion: current?.version ?? 0 };
      return (await request('PUT', '/api/goal', { body })) as GoalVersion;
    },
    createTasks: async (tasks) => ((await post('/api/tasks', { tasks }, [201])) as { tasks: Task[] }).tasks,
    task: async (id) => (await get(task(id))) as TaskDetail,
    accept: async (id, note) => ((await post(`${task(id)}/accept`, { note })) as { task: Task }).task,
    unblock: async (id, note) => ((await post(`${task(id)}/unblock`, { note })) as { task: Task }).task,
    send: async (message) => ((await post('/api/messages', message, [201])) as { message: Message }).message,
    messages: async (query = {}) => ((await get('/api/messages', { ...query })) as { messages: MessageView[] }).messages,
    events: async (query = {}) => {
      const { latest, ...rest } = query;
      return ((await get('/api/events', { ...rest, latest: latest ? 1 : undefined })) as { events: HubEvent[] }).events;
    },

    runners: async () => RunnersResponseSchema.parse(await get('/api/runners')),
    setRunnerLeads: async (on) =>
      ProjectSchema.parse(await request('PATCH', '/api/project', { body: { runnerLeads: on } })),
    attempts: async (query = {}) => {
      const status = Array.isArray(query.status) ? query.status.join(',') : query.status;
      return AttemptsResponseSchema.parse(await get('/api/attempts', { ...query, status })).attempts;
    },
    attempt: async (id) => AttemptDetailResponseSchema.parse(await get(`/api/attempts/${encodeURIComponent(id)}`)),
    leadNotes: async () => LeadNotesResponseSchema.parse(await get('/api/lead/notes')).notes,
    takeover: async (id) => TakeoverResponseSchema.parse(await post(`${task(id)}/takeover`, undefined, [202])).attemptId,
    handback: async (id, source) =>
      TakeoverResponseSchema.parse(await post(`${task(id)}/handback`, { source }, [202])).attemptId,
    stopAgent: async (id, input) =>
      AttemptResponseSchema.parse(await post(`${agent(id)}/stop`, input, [200, 202])).attempt,
    replaceAgent: async (id, reason) =>
      AttemptResponseSchema.parse(await post(`${agent(id)}/replace`, { reason }, [200, 202])).attempt,
    interruptAgent: async (id) => {
      OkResponseSchema.parse(await post(`${agent(id)}/interrupt`, undefined));
    },
  };
}

/**
 * A CLI token for the person, as `agflow login` gets one: the person approves a fresh code with the browser session,
 * and the CLI side polls for the token. Each runner owner's runner links with it.
 */
export async function cliToken(person: Person, label = 'agflow e2e runner'): Promise<string> {
  const code = randomUUID();
  await person.request('POST', '/api/cli-login/approve', { body: { code, label } });
  const path = `/api/cli-login/poll?code=${code}`;
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const poll = (await call(person.hubUrl, 'GET', path)) as CliLoginPoll;
    if (poll.status === 'approved') return poll.token;
    if (poll.status === 'expired' || Date.now() > deadline) {
      throw new HubCallError('GET', path, 200, JSON.stringify(poll));
    }
    await Bun.sleep(100);
  }
}
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `bun test packages/testkit/test/hub-process.test.ts && bun run typecheck`
Expected: all selected tests pass (0 fail); tsc exits 0.

These tests start real main.ts and restore.ts, but no vendor CLI. The directory is created before hub.log; both hub URL and public URL use 127.0.0.1. M2 response schemas are actually exercised with malformed stand-in answers, and a killed hub proves transport status 0. Counter advancement is relative to the backup: create T-1, restart to back it up, then restore before expecting T-1002. E2E_USERS exports alice, bob and carol. See Decisions 31–34.

- [ ] **Step 5: Commit**

```bash
git add -A 'packages/testkit/src/harness/hub-process.ts' 'packages/testkit/src/harness/index.ts' 'packages/testkit/src/harness/person.ts' 'packages/testkit/test/hub-process.test.ts'
git commit -m 'M2G Task 4: Harness: the hub as a process, and a person'\''s API client' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

### Task 5: Harness: runner homes and runner processes

Each runner gets its own AGFLOW_HOME, CLI config directory and scratch HOME. Its runner.json comes from createRunnerConfig, given readMachineId's id, the runner's name, the test process's PATH, the proxy as connectivity variables (NO_PROXY for loopback), the owner's commit identity and vendor homes inside the runner home (X-42). Test overrides follow: the test block (claudeEnv, codexConfig, skipAuthChecks, allowShortTimings), E2E_RUNNER_TIMINGS, keepAwake off, capacity 2, and a low minFreeGb so the disk guard never refuses on a developer's Mac. The runner home links the located Claude binary and Codex version directory into its own vendor/, where vendorBinary looks (X-20); a runner that offers one vendor lacks the other's link (X-10). credentials.json follows core's CredentialsSchema (X-8). A RunnerProcess runs `bun packages/cli/src/main.ts runner start` in the foreground, whose host calls createAdapters, so the real adapters run (X-6). It exposes the faults: SIGTERM (suspend), SIGKILL (crash), freezing and thawing the whole tree, and killing one attempt's agent group, found through `agflow runner status --json` (X-41, X-42) and checked with processIdentity.

**Files:**
- Test: `packages/testkit/e2e/runner-process.e2e.test.ts`
- Modify: `packages/testkit/src/harness/env.ts`
- Modify: `packages/testkit/src/harness/index.ts`
- Create: `packages/testkit/src/harness/runner-process.ts`
- Test: `packages/testkit/test/runner-home.test.ts`

- [ ] **Step 1: Write the failing tests**

**File:** `packages/testkit/e2e/runner-process.e2e.test.ts` (new)

```ts
// Runner processes against a hub process (design 7.1, 7.4, 15): `agflow runner start` with the real adapters, one
// runner per vendor, each offering only that vendor. Runs only with AGFLOW_E2E=1.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { type Runner, TEST_ACCOUNT_ID, type Vendor } from '@agflow/core';
import { type OriginRepo, originRepo } from '../src/git-fixtures';
import { describeE2e, E2E_TEST_TIMEOUT_MS, e2eVendors, requireE2e } from '../src/harness/env';
import { E2E_HUB_TIMINGS, type HubProcess, startHubProcess } from '../src/harness/hub-process';
import { type Models, startModels } from '../src/harness/models';
import { cliToken, type Person, signIn } from '../src/harness/person';
import { descendantsOf, listProcesses } from '../src/harness/proc';
import {
  prepareRunnerHome,
  type RunnerHome,
  type RunnerProcess,
  startRunnerProcess,
} from '../src/harness/runner-process';

// A runner start runs both preflights and the sandbox probe; a stop waits for the suspend.
setDefaultTimeout(E2E_TEST_TIMEOUT_MS);

const VENDORS: readonly Vendor[] = ['claude', 'codex'];

describeE2e('runner processes', () => {
  let dir = '';
  let origin: OriginRepo | null = null;
  let hub: HubProcess | null = null;
  let models: Models | null = null;
  let alice: Person;
  const homes: RunnerHome[] = [];
  const runners = new Map<Vendor, RunnerProcess>();

  beforeAll(async () => {
    const { binaries } = await requireE2e();
    dir = realpathSync(mkdtempSync('/tmp/agf-rp-'));
    origin = await originRepo({ 'README.md': 'runner process test\n' });
    hub = await startHubProcess({ dir: join(dir, 'hub'), repo: origin.path });
    models = await startModels();
    alice = await signIn(hub.url, 'alice');
    // No runner lead: these runners stay idle.
    await alice.setRunnerLeads(false);
    for (const vendor of e2eVendors()) {
      const home = await prepareRunnerHome({
        dir: join(dir, vendor),
        name: `alice-${vendor}`,
        credentials: { hubUrl: hub.url, token: await cliToken(alice), user: 'alice' },
        vendors: [vendor],
        binaries,
        models,
      });
      homes.push(home);
      runners.set(vendor, await startRunnerProcess(home));
    }
  });

  afterAll(async () => {
    for (const runner of runners.values()) await runner.close();
    await models?.close();
    if (hub?.running) await hub.kill();
    for (const home of homes) home.remove();
    origin?.remove();
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
  });

  async function hubRunner(name: string): Promise<Runner> {
    const found = (await alice.runners()).runners.find((runner) => runner.name === name);
    if (!found) throw new Error(`the hub has no runner named ${name}`);
    return found;
  }

  async function until(check: () => Promise<boolean>, what: string, timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting until ${what}`);
      await Bun.sleep(250);
    }
  }

  test('each runner is online under its name and owner; its vendor is ready in test mode and the other is missing', async () => {
    for (const [vendor, runner] of runners) {
      const found = await hubRunner(runner.name);
      expect(found).toMatchObject({ owner: 'alice', state: 'online', keepAwake: 'off', capacity: 2 });
      for (const other of VENDORS) {
        const facts = found.vendors.find((entry) => entry.vendor === other);
        if (other === vendor) {
          const ready = { ready: true, problem: 'test mode', plan: 'test mode', accountId: TEST_ACCOUNT_ID };
          expect(facts).toMatchObject(ready);
        } else {
          expect(facts).toMatchObject({ ready: false, problem: 'binary missing' });
        }
      }
    }
  });

  test('status() parses `agflow runner status --json` as RunnerStatusReport', async () => {
    for (const runner of runners.values()) {
      const report = await runner.status();
      if (!report.running) throw new Error(`runner ${runner.name} reported offline: ${JSON.stringify(report)}`);
      expect(report.pid).toBe(runner.pid ?? -1);
      expect(report.name).toBe(runner.name);
      expect(report.mode).toBe('foreground');
      expect(report.link).toBe('online');
      expect(report.runnerId).toBe((await hubRunner(runner.name)).id);
      expect(report.keepAwake).toEqual({ mode: 'off', held: false });
      expect(report.attempts).toEqual([]);
    }
  });

  test('stop() suspends with SIGTERM and the runner exits 0; the hub shows it offline; start() reconnects it as the same runner', async () => {
    for (const runner of runners.values()) {
      const { id } = await hubRunner(runner.name);
      await runner.stop();
      expect(runner.running).toBe(false);
      expect(runner.exitCode).toBe(0);
      await until(async () => (await hubRunner(runner.name)).state === 'offline', `${runner.name} is offline`);
      await runner.start();
      const back = await hubRunner(runner.name);
      expect(back.id).toBe(id);
      await until(async () => (await hubRunner(runner.name)).state === 'online', `${runner.name} is online again`);
    }
  });

  test('freeze() stops the runner and its descendants, and the hub marks it offline; thaw() brings it back as the same process', async () => {
    const runner = [...runners.values()][0];
    if (!runner) throw new Error('no runner');
    const pid = runner.pid ?? -1;
    const frozenAt = Date.now();
    const frozen = await runner.freeze();
    expect(frozen[0]).toBe(pid);
    const tree = [pid, ...(await descendantsOf(pid)).map((row) => row.pid)];
    for (const row of await listProcesses(tree)) expect(row.stat.startsWith('T')).toBe(true);
    await until(async () => (await hubRunner(runner.name)).state === 'offline', `${runner.name} is offline`);
    expect(Date.now() - frozenAt).toBeGreaterThanOrEqual(E2E_HUB_TIMINGS.deadLinkMs - 1_000);
    await runner.thaw();
    await until(async () => (await hubRunner(runner.name)).state === 'online', `${runner.name} is online again`);
    expect(runner.pid).toBe(pid);
    const report = await runner.status();
    expect(report.running && report.pid).toBe(pid);
  });
});
```

**File:** `packages/testkit/test/runner-home.test.ts` (new)

```ts
import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { CREDENTIALS_FILE, CredentialsSchema, type Vendor } from '@agflow/core';
import { loadRunnerConfig } from '@agflow/runner/src/config';
import { readMachineId } from '@agflow/runner/src/service/machine';
import { VENDOR_PINS, vendorBinary } from '@agflow/runner/src/vendor/pins';
import { claudeTestEnv } from '../src/anthropic/env';
import { codexTestConfig } from '../src/codex/test-config';
import { E2E_PLATFORM } from '../src/harness/env';
import { E2E_HUB_TIMINGS } from '../src/harness/hub-process';
import { processesInDir } from '../src/harness/proc';
import {
  E2E_RUNNER_TIMINGS,
  prepareRunnerHome,
  type RunnerHome,
  startRunnerProcess,
} from '../src/harness/runner-process';

const dirs: string[] = [];
const homes: RunnerHome[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) home.remove();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join('/tmp', prefix));
  dirs.push(dir);
  return dir;
}

const PINS = VENDOR_PINS[E2E_PLATFORM];
if (!PINS) throw new Error(`no ${E2E_PLATFORM} pins`);

const PROXY_URL = 'http://127.0.0.1:9';
// Stand-ins for the scripted servers: prepareRunnerHome only writes their addresses.
const MODELS = {
  proxyUrl: PROXY_URL,
  claudeEnv: claudeTestEnv({ baseUrl: 'http://127.0.0.1:7', proxyUrl: PROXY_URL }),
  codexConfig: codexTestConfig('http://127.0.0.1:8/v1'),
};

/** Stand-ins for the located binaries: a claude file and a codex version directory with bin/codex. */
function fakeBinaries(): Record<Vendor, string> {
  const root = tmpDir('agf-bins-');
  const claude = join(root, 'claude-bin', 'claude');
  const codex = join(root, 'codex-tree', 'bin', 'codex');
  for (const file of [claude, codex]) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '#!/bin/sh\nexit 0\n');
    chmodSync(file, 0o755);
  }
  return { claude, codex };
}

async function prepare(vendors: Vendor[], name = 'alice-mac'): Promise<RunnerHome> {
  const home = await prepareRunnerHome({
    dir: join(tmpDir('agf-rh-'), 'alice'),
    name,
    credentials: { hubUrl: 'http://127.0.0.1:4000', token: 'agf_cli_token', user: 'alice' },
    vendors,
    binaries: fakeBinaries(),
    models: MODELS,
  });
  homes.push(home);
  return home;
}

describe('E2E_RUNNER_TIMINGS', () => {
  test('push WIP within the WIP grace the hub sends, a third of its runner lease (X-11)', () => {
    expect(E2E_RUNNER_TIMINGS.wip).toBeLessThan(E2E_HUB_TIMINGS.runnerLeaseMs / 3);
  });
});

describe('prepareRunnerHome', () => {
  test('writes a runner.json that loadRunnerConfig accepts in test mode, with the e2e settings', async () => {
    const home = await prepare(['claude', 'codex']);
    // The short timings need test mode, which the runner process gets.
    expect(() => loadRunnerConfig(home.paths.config, {})).toThrow('timings.wip');
    expect(home.env.AGFLOW_TEST).toBe('1');
    const config = loadRunnerConfig(home.paths.config, { AGFLOW_TEST: '1' });
    expect(config).toEqual(home.config);
    expect(config.name).toBe('alice-mac');
    expect(config.machineId).toBe(await readMachineId());
    expect(config.test).toEqual({
      claudeEnv: MODELS.claudeEnv,
      codexConfig: MODELS.codexConfig,
      skipAuthChecks: true,
      allowShortTimings: true,
    });
    for (const [key, value] of Object.entries(E2E_RUNNER_TIMINGS)) {
      expect(config.timings[key as keyof typeof config.timings]).toEqual(value);
    }
    expect(config.keepAwake).toBe('off');
    expect(config.capacity).toBe(2);
    expect(config.minFreeGb).toBeLessThan(1);
    expect(config.commitIdentity).toEqual({ name: 'alice', email: 'alice@agflow.invalid' });
    expect(config.capturedPath).toBe(home.env.PATH ?? '');
    expect(config.capturedPath.split(':')).toEqual(
      [...new Set((process.env.PATH ?? '').split(':'))].filter((entry) => entry.startsWith('/')),
    );
    expect(config.connectivity).toEqual({
      HTTPS_PROXY: PROXY_URL,
      HTTP_PROXY: PROXY_URL,
      ALL_PROXY: PROXY_URL,
      NO_PROXY: '127.0.0.1,localhost,::1',
    });
    // Both vendor homes exist inside the runner home, at their real paths.
    const real = realpathSync(home.agflowHome);
    for (const vendor of ['claude', 'codex'] as const) {
      const path = config.homes[vendor] ?? '';
      expect(path.startsWith(`${real}/`)).toBe(true);
      expect(realpathSync(path)).toBe(path);
    }
  });

  test("gives the runner its own AGFLOW_HOME, CLI config directory and HOME, and no developer's variables", async () => {
    const home = await prepare(['claude']);
    expect(home.env).toMatchObject({
      AGFLOW_HOME: home.agflowHome,
      AGFLOW_CONFIG_DIR: home.configDir,
      HOME: home.home,
      AGFLOW_TEST: '1',
    });
    for (const dir of [home.agflowHome, home.configDir, home.home]) {
      expect(dir.startsWith(`${home.dir}/`)).toBe(true);
      expect(existsSync(dir)).toBe(true);
    }
    expect(home.paths.home).toBe(home.agflowHome);
    // Only what the runner reads: no inherited AGFLOW_*, GIT_* or vendor keys.
    const system = ['PATH', 'HOME', 'TMPDIR', 'USER', 'LOGNAME', 'LANG', 'SHELL'];
    const unexpected = Object.keys(home.env).filter((name) => !system.includes(name) && !name.startsWith('LC_'));
    expect(unexpected.sort()).toEqual(['AGFLOW_CONFIG_DIR', 'AGFLOW_HOME', 'AGFLOW_TEST']);
  });

  test("keeps only the absolute entries of the test process's PATH, for runner.json and the runner process", async () => {
    const saved = process.env.PATH;
    // readMachineId runs ioreg from /usr/sbin.
    process.env.PATH = './node_modules/.bin:/usr/bin:.::/bin:bin:/usr/sbin:/usr/bin';
    try {
      const home = await prepare(['claude']);
      expect(home.config.capturedPath).toBe('/usr/bin:/bin:/usr/sbin');
      expect(home.env.PATH).toBe('/usr/bin:/bin:/usr/sbin');
    } finally {
      process.env.PATH = saved;
    }
  });

  test('links the located binary of each offered vendor where vendorBinary looks, and leaves an omitted one out', async () => {
    for (const offered of ['claude', 'codex'] as const) {
      const home = await prepareRunnerHome({
        dir: join(tmpDir('agf-rh-'), 'bob'),
        name: 'bob-mac',
        credentials: { hubUrl: 'http://127.0.0.1:4000', token: 'agf_cli_token', user: 'bob' },
        vendors: [offered],
        binaries: fakeBinaries(),
        models: MODELS,
      });
      homes.push(home);
      const omitted: Vendor = offered === 'claude' ? 'codex' : 'claude';
      const binary = (vendor: Vendor) => join(home.paths.runner, vendorBinary(vendor, PINS[vendor].version));
      expect(realpathSync(binary(offered))).toBe(realpathSync(home.binaries[offered] ?? ''));
      expect(existsSync(binary(omitted))).toBe(false);
      expect(existsSync(dirname(binary(omitted)))).toBe(false);
      expect(home.vendors).toEqual([offered]);
    }
  });

  test('refuses an offered vendor without a located binary, and a codex binary outside a bin directory', async () => {
    const dir = join(tmpDir('agf-rh-'), 'carol');
    const options = {
      dir,
      name: 'carol-mac',
      credentials: { hubUrl: 'http://127.0.0.1:4000', token: 'agf_cli_token', user: 'carol' },
      models: MODELS,
    };
    await expect(prepareRunnerHome({ ...options, vendors: ['codex'], binaries: {} })).rejects.toThrow(
      'no located codex binary',
    );
    const loose = join(tmpDir('agf-bins-'), 'codex');
    writeFileSync(loose, '');
    await expect(prepareRunnerHome({ ...options, vendors: ['codex'], binaries: { codex: loose } })).rejects.toThrow(
      'bin/codex',
    );
  });

  test("writes credentials.json in the runner's config directory with mode 0600, parsed by CredentialsSchema", async () => {
    const home = await prepare(['codex']);
    const file = join(home.configDir, CREDENTIALS_FILE);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(CredentialsSchema.parse(JSON.parse(readFileSync(file, 'utf8')))).toEqual({
      hubUrl: 'http://127.0.0.1:4000',
      token: 'agf_cli_token',
      user: 'alice',
    });
  });

  test("names the attempt's clone path under the runner's work directory", async () => {
    const home = await prepare(['claude']);
    const clone = home.clonePath('T-1-a1');
    expect(clone.startsWith(`${home.paths.work}/e2e-`)).toBe(true);
    expect(clone.endsWith('/T-1-a1')).toBe(true);
  });

  test('remove() deletes the home, read-only agent tools directories included', async () => {
    const home = await prepare(['claude']);
    const tools = home.paths.agentTools('e2e-0123456789', 'T-1-a1');
    mkdirSync(join(tools, 'bin'), { recursive: true });
    writeFileSync(join(tools, 'bin', 'gh'), '');
    chmodSync(join(tools, 'bin'), 0o555);
    chmodSync(tools, 0o555);
    home.remove();
    expect(existsSync(home.dir)).toBe(false);
  });
});

describe('startRunnerProcess', () => {
  const hasLsof = Bun.which('lsof') !== null;

  // macOS only: lsof finds what runs in the home, and the runner's sandbox probe needs macOS.
  test.skipIf(process.platform !== 'darwin' || !hasLsof)(
    'a start that times out leaves nothing of the runner running',
    async () => {
      // A hub that answers the project's status and refuses every link, so the runner keeps retrying it.
      const hub = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        fetch: (request) =>
          new URL(request.url).pathname === '/api/status'
            ? Response.json({ project: { name: 'e2e', repo: '/nowhere' } })
            : new Response('no', { status: 503 }),
      });
      try {
        const home = await prepareRunnerHome({
          dir: join(tmpDir('agf-rs-'), 'dave'),
          name: 'dave-mac',
          credentials: { hubUrl: `http://127.0.0.1:${hub.port}`, token: 'agf_cli_token', user: 'dave' },
          vendors: [],
          binaries: {},
          models: MODELS,
        });
        homes.push(home);
        await expect(startRunnerProcess(home, { timeoutMs: 8_000 })).rejects.toThrow('did not start within 8000 ms');
        expect(await processesInDir(home.dir)).toEqual([]);
      } finally {
        hub.stop(true);
      }
    },
    60_000,
  );
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `bun test packages/testkit/test/runner-home.test.ts packages/testkit/e2e/runner-process.e2e.test.ts`
Expected: FAIL — `error: Cannot find module '../src/harness/runner-process' from '.../packages/testkit/test/runner-home.test.ts'`.

- [ ] **Step 3: Implement**

**File:** `packages/testkit/src/harness/env.ts` (change)

```diff
diff --git a/packages/testkit/src/harness/env.ts b/packages/testkit/src/harness/env.ts
index 08d3ddab..8e6bcc62 100644
--- a/packages/testkit/src/harness/env.ts
+++ b/packages/testkit/src/harness/env.ts
@@ -16,6 +16,12 @@ const VENDORS: readonly Vendor[] = VendorSchema.options;
 /** The one platform M2 pins vendor binaries for, so the one the e2e suite runs on. */
 export const E2E_PLATFORM = 'darwin-arm64';
 
+/**
+ * Each e2e test's timeout: `bun run e2e` passes it as --timeout, and every e2e file sets it as its default, because a
+ * file's setDefaultTimeout overrides the flag.
+ */
+export const E2E_TEST_TIMEOUT_MS = 600_000;
+
 /** Locating both binaries runs each candidate's --version; a cold first run on macOS takes seconds. */
 const PREREQS_TIMEOUT_MS = 60_000;
 
```

**File:** `packages/testkit/src/harness/index.ts` (change)

```diff
diff --git a/packages/testkit/src/harness/index.ts b/packages/testkit/src/harness/index.ts
index d2607a29..179a6a5b 100644
--- a/packages/testkit/src/harness/index.ts
+++ b/packages/testkit/src/harness/index.ts
@@ -6,3 +6,4 @@ export * from './models';
 export * from './person';
 export * from './playbook';
 export * from './proc';
+export * from './runner-process';
```

**File:** `packages/testkit/src/harness/runner-process.ts` (new)

```ts
// Runner homes and runner processes (design 7.1, 7.2, 7.4, 15, 15.1). Each runner has its own AGFLOW_HOME, CLI
// config directory and scratch HOME, and runs as `bun packages/cli/src/main.ts runner start` in the foreground, whose
// host calls createAdapters, so the real adapters run (X-6). The harness runs the CLI by path and adds no dependency
// on @agflow/cli; it finds an attempt's agent through `agflow runner status --json` and never reads runner.db (X-42).
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { CREDENTIALS_FILE, type Credentials, CredentialsSchema, type Vendor } from '@agflow/core';
import { type RunnerConfig, type RunnerTimings, saveRunnerConfig } from '@agflow/runner/src/config';
import { projectKey, type RunnerPaths, runnerPaths } from '@agflow/runner/src/paths';
import { type ProcessIdentity, processIdentity, sameProcess } from '@agflow/runner/src/processes';
import { removeAgentTools } from '@agflow/runner/src/run-dir';
import { ControlUnavailableError, controlRequest } from '@agflow/runner/src/service/control';
import { canonicalHome, readMachineId } from '@agflow/runner/src/service/machine';
import { createRunnerConfig } from '@agflow/runner/src/service/runner-json';
import type { RunnerStatusReport } from '@agflow/runner/src/service/status';
import { VENDOR_PINS, vendorBinary } from '@agflow/runner/src/vendor/pins';
import { linkClaudeBinary } from '../anthropic/binary';
import { E2E_PLATFORM } from './env';
import type { Models } from './models';
import { descendantsOf, freezeTree, processesInDir, signalGroup, thawTree, waitUntilGone } from './proc';

const CLI_MAIN = join(import.meta.dir, '../../../cli/src/main.ts');

const SECOND = 1000;

/**
 * The e2e runner timings over design 12's defaults (X-30; runner.json's test.allowShortTimings admits them). WIP is
 * pushed every 5 s, inside the 10 s WIP grace the hub derives from E2E_HUB_TIMINGS.runnerLeaseMs (X-11). A runner
 * reconnects within 2 s of a hub restart. A thawed runner takes new starts again 5 s after its clock gap, not 2
 * minutes. Unclean exits count as a crash loop only within 30 s, so the SIGKILL scenarios never drain a runner. The
 * hub sets heartbeat, deadLink and handoff through welcome.timings; everything else keeps its default.
 */
export const E2E_RUNNER_TIMINGS = Object.freeze({
  backoffBase: SECOND / 2,
  backoffCap: 2 * SECOND,
  wip: 5 * SECOND,
  wakeHold: 5 * SECOND,
  crashLoopWindow: 30 * SECOND,
}) satisfies Partial<RunnerTimings>;

/** Agents of every runner reach the scripted servers and the hub directly; every other host goes to the proxy. */
const NO_PROXY = '127.0.0.1,localhost,::1';

/** Low enough that the disk guard never refuses a start on a developer's Mac. */
const E2E_MIN_FREE_GB = 0.5;

const DEFAULT_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

/**
 * The test process's PATH with only absolute entries, as setup keeps it (service/machine.ts): vendor CLIs, hooks and
 * the runner's own git run with their cwd in a clone, where a relative entry would find an agent-written binary.
 */
function runnerPath(path = process.env.PATH ?? ''): string {
  const entries = path.split(':').filter((entry) => entry.startsWith('/'));
  return [...new Set(entries)].join(':') || DEFAULT_PATH;
}

/** What prepareRunnerHome needs of the scripted models: Models, or stand-ins in a test. */
export type RunnerModels = Pick<Models, 'claudeEnv' | 'codexConfig' | 'proxyUrl'>;

export interface RunnerHomeOptions {
  /** The runner's directory; created, and used at its real path. Keep it short: runner.sock must fit in 104 bytes. */
  dir: string;
  /** The runner's name on the hub. */
  name: string;
  /** The owner's CLI sign-in: hub URL, a token from cliToken, and the owner's login. */
  credentials: Credentials;
  /** The vendors the runner offers; any other lacks its binary, and preflight reports 'binary missing' (X-10). */
  vendors: readonly Vendor[];
  /** The located pinned binaries, from requireE2e. */
  binaries: Partial<Record<Vendor, string>>;
  models: RunnerModels;
  /** The hub's project name, which names the runner's vault and clone directories; 'e2e' by default. */
  projectName?: string;
}

export interface RunnerHome {
  readonly name: string;
  /** The owner's login. */
  readonly owner: string;
  readonly vendors: readonly Vendor[];
  /** The located binaries the home links, by vendor. */
  readonly binaries: Partial<Record<Vendor, string>>;
  /** The runner's directory, at its real path; everything below lives in it. */
  readonly dir: string;
  /** HOME: a scratch home, so no CLI ever reads or writes the developer's own. */
  readonly home: string;
  /** AGFLOW_HOME. */
  readonly agflowHome: string;
  /** AGFLOW_CONFIG_DIR: the CLI's config directory, holding credentials.json. */
  readonly configDir: string;
  readonly paths: RunnerPaths;
  readonly config: RunnerConfig;
  readonly hubUrl: string;
  readonly projectName: string;
  /** The runner process's whole environment. */
  readonly env: Readonly<Record<string, string>>;
  /** The runner process's stdout and stderr, appended across starts. */
  readonly logPath: string;
  /** Where the runner clones the attempt: the agent's working directory. */
  clonePath(attemptId: string): string;
  /** Deletes the directory, after making the read-only agent tools directories writable (M2b's removeAgentTools). */
  remove(): void;
}

/** The runner process's environment: only what the runner and its agents read, never a developer's own settings. */
function runnerEnv(home: { home: string; agflowHome: string; configDir: string }): Record<string, string> {
  const env: Record<string, string> = { PATH: runnerPath() };
  // The user variables agents inherit (buildAgentEnv), and the temporary directory Bun and the sandbox use.
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (['TMPDIR', 'USER', 'LOGNAME', 'LANG', 'SHELL'].includes(name) || name.startsWith('LC_')) env[name] = value;
  }
  return {
    ...env,
    HOME: home.home,
    AGFLOW_HOME: home.agflowHome,
    AGFLOW_CONFIG_DIR: home.configDir,
    AGFLOW_TEST: '1',
  };
}

/** Links each offered vendor's located binary into the home's vendor/, where vendorBinary looks (X-20). */
function linkBinaries(
  paths: RunnerPaths,
  vendors: readonly Vendor[],
  binaries: Partial<Record<Vendor, string>>,
): void {
  const pins = VENDOR_PINS[E2E_PLATFORM];
  if (!pins) throw new Error(`VENDOR_PINS has no ${E2E_PLATFORM} entry`);
  for (const vendor of vendors) {
    const bin = binaries[vendor];
    if (bin === undefined) throw new Error(`no located ${vendor} binary for a runner that offers ${vendor}`);
    if (vendor === 'claude') {
      linkClaudeBinary(paths.home, pins.claude.version, bin);
      continue;
    }
    // Codex needs its whole version directory: the bundled rg and the code-mode host sit next to bin/.
    if (basename(dirname(bin)) !== 'bin') {
      throw new Error(`the codex binary ${bin} is not in a version directory's bin/codex`);
    }
    const link = dirname(dirname(join(paths.runner, vendorBinary('codex', pins.codex.version))));
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(dirname(dirname(bin)), link);
  }
}

/**
 * Creates a runner home: runner.json from createRunnerConfig with readMachineId's id and the e2e overrides (X-42), the
 * vendor homes inside it, the offered vendors' binaries linked into its vendor/, and the owner's credentials.json.
 */
export async function prepareRunnerHome(options: RunnerHomeOptions): Promise<RunnerHome> {
  mkdirSync(options.dir, { recursive: true });
  // The real path: lsof reports real paths, and vendor homes must be real paths (createRunnerConfig refuses links).
  const dir = realpathSync(options.dir);
  const owner = options.credentials.user;
  const projectName = options.projectName ?? 'e2e';
  const home = join(dir, 'home');
  const agflowHome = join(dir, 'agflow');
  const configDir = join(dir, 'config');
  for (const path of [home, agflowHome, configDir]) mkdirSync(path, { recursive: true, mode: 0o700 });
  const paths = runnerPaths(agflowHome);
  linkBinaries(paths, options.vendors, options.binaries);
  const { claudeEnv, codexConfig, proxyUrl } = options.models;
  const config = createRunnerConfig(
    {
      machineId: await readMachineId(),
      name: options.name,
      capturedPath: runnerPath(),
      connectivity: { HTTPS_PROXY: proxyUrl, HTTP_PROXY: proxyUrl, ALL_PROXY: proxyUrl, NO_PROXY },
      commitIdentity: { name: owner, email: `${owner}@agflow.invalid` },
      homes: { claude: canonicalHome(paths.homes.claude), codex: canonicalHome(paths.homes.codex) },
    },
    {
      capacity: 2,
      keepAwake: 'off',
      minFreeGb: E2E_MIN_FREE_GB,
      timings: { ...E2E_RUNNER_TIMINGS },
      test: { claudeEnv, codexConfig, skipAuthChecks: true, allowShortTimings: true },
    },
  );
  saveRunnerConfig(paths.config, config);
  const credentials = CredentialsSchema.parse(options.credentials);
  writeFileSync(join(configDir, CREDENTIALS_FILE), `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  const project = projectKey(credentials.hubUrl, projectName);
  return {
    name: options.name,
    owner,
    vendors: [...options.vendors],
    binaries: { ...options.binaries },
    dir,
    home,
    agflowHome,
    configDir,
    paths,
    config,
    hubUrl: credentials.hubUrl,
    projectName,
    env: runnerEnv({ home, agflowHome, configDir }),
    logPath: join(dir, 'runner-process.log'),
    clonePath: (attemptId) => paths.clone(project, attemptId),
    remove() {
      if (existsSync(paths.vaults)) {
        for (const entry of readdirSync(paths.vaults).filter((name) => name.endsWith('.agent'))) {
          for (const attempt of readdirSync(join(paths.vaults, entry))) {
            removeAgentTools(join(paths.vaults, entry, attempt));
          }
        }
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface RunnerStartOptions {
  /** Wait until the runner's link is online with a runner id (true by default); false waits only for its socket. */
  online?: boolean;
  /** 120 s by default: a start runs the sandbox probe and every vendor's preflight. */
  timeoutMs?: number;
}

export interface RunnerProcess {
  readonly home: RunnerHome;
  readonly name: string;
  /** The running runner's pid; null while it is stopped. */
  readonly pid: number | null;
  readonly running: boolean;
  /** The exit code of the last run, or null for a run ended by a signal or still running. */
  readonly exitCode: number | null;
  /** Starts `agflow runner start` in the foreground and waits for it (RunnerStartOptions). */
  start(options?: RunnerStartOptions): Promise<void>;
  /** SIGTERM, which suspends (design 7.1); the runner must exit 0 within its suspend timing. */
  stop(): Promise<void>;
  /** SIGKILL of the runner process alone, as a crash: its agents lead their own groups and may run on. */
  kill(): Promise<void>;
  /** Stops the runner and every descendant, as a closed lid does; gives the stopped pids, the runner's first. */
  freeze(): Promise<number[]>;
  /** Resumes what freeze() stopped; the same process runs on. */
  thaw(): Promise<number[]>;
  /** `agflow runner status --json`, parsed. */
  status(): Promise<RunnerStatusReport>;
  /** The attempt's agent as the runner recorded it, checked against the live process with processIdentity. */
  agentOf(attemptId: string): Promise<ProcessIdentity>;
  /** SIGKILLs the attempt's agent process group; gives the agent it killed. */
  killAgent(attemptId: string): Promise<ProcessIdentity>;
  clonePath(attemptId: string): string;
  /** The last lines of the runner's output. */
  logTail(lines?: number): string;
  /** Thaws, then SIGKILLs the runner, its descendants and every process left with its cwd in the runner's directory. */
  close(): Promise<void>;
}

const DEFAULT_START_TIMEOUT_MS = 120_000;
/** Beyond the suspend timing: the process still has to close its database and release its lock. */
const STOP_MARGIN_MS = 15_000;
const STATUS_TIMEOUT_MS = 30_000;
const POLL_MS = 100;
const CLOSE_WAIT_MS = 10_000;

/** What the runner's GET /health answers. */
interface Health {
  pid: number;
  link: string;
  runnerId: string | null;
}

function tail(text: string, lines: number): string {
  return text.split('\n').filter(Boolean).slice(-lines).join('\n');
}

/** Resolves with the exit code, or null when the process is still running after timeoutMs. */
async function exitWithin(proc: Bun.Subprocess, timeoutMs: number): Promise<number | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    return await Promise.race([proc.exited, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function signal(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(pid, name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

/** A runner process on the home, started. */
export async function startRunnerProcess(home: RunnerHome, options: RunnerStartOptions = {}): Promise<RunnerProcess> {
  const runner = createRunnerProcess(home);
  await runner.start(options);
  return runner;
}

function createRunnerProcess(home: RunnerHome): RunnerProcess {
  const { name, paths } = home;
  let proc: Bun.Subprocess | null = null;
  let frozen = false;
  const running = () => proc !== null && proc.exitCode === null && proc.signalCode === null;
  // `runner status` reads launchd's disabled state for the real label in gui/<uid> (M2c's Known behaviour 12). Its
  // PATH is an empty directory, so launchctl cannot run and the state reads unknown.
  const statusPath = join(home.dir, 'status-path');

  function log(line: string): void {
    const fd = openSync(home.logPath, 'a');
    try {
      writeSync(fd, `${line}\n`);
    } finally {
      closeSync(fd);
    }
  }

  function logTail(lines = 40): string {
    return existsSync(home.logPath) ? tail(readFileSync(home.logPath, 'utf8'), lines) : '';
  }

  function requireRunning(action: string): Bun.Subprocess {
    if (proc === null || !running()) throw new Error(`cannot ${action} runner ${name}: it is not running`);
    return proc;
  }

  /** The runner's own view through its control socket; null while the socket does not answer. */
  async function health(): Promise<Health | null> {
    try {
      return await controlRequest<Health>(paths, 'GET', '/health', undefined, { timeoutMs: 2_000 });
    } catch (error) {
      if (error instanceof ControlUnavailableError) return null;
      throw error;
    }
  }

  async function start(options: RunnerStartOptions = {}): Promise<void> {
    if (running()) throw new Error(`runner ${name} is already running (pid ${proc?.pid})`);
    const timeoutMs = options.timeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    log(`--- harness: starting runner ${name} at ${new Date().toISOString()}`);
    const fd = openSync(home.logPath, 'a');
    let started: Bun.Subprocess;
    try {
      // --no-env-file: a .env file must not add settings to the runner's.
      started = Bun.spawn([process.execPath, '--no-env-file', CLI_MAIN, 'runner', 'start'], {
        cwd: home.dir,
        env: { ...home.env },
        stdin: 'ignore',
        stdout: fd,
        stderr: fd,
      });
    } finally {
      closeSync(fd);
    }
    proc = started;
    frozen = false;
    try {
      await untilStarted(started, options.online !== false, timeoutMs);
    } catch (error) {
      // A start that failed leaves nothing behind: the runner may still be retrying its link, its agents running.
      await close();
      throw error;
    }
  }

  async function untilStarted(started: Bun.Subprocess, online: boolean, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (started.exitCode !== null || started.signalCode !== null) {
        const end = started.exitCode ?? started.signalCode;
        throw new Error(`runner ${name} exited (${end}) during its start:\n${logTail()}`);
      }
      const seen = await health();
      // Only this process's answer counts: another instance of the home may still hold the socket.
      const own = seen !== null && seen.pid === started.pid;
      if (own && (!online || (seen.link === 'online' && seen.runnerId !== null))) return;
      if (Date.now() > deadline) {
        const state =
          seen === null
            ? 'its socket did not answer'
            : own
              ? `its link is ${seen.link}`
              : `its socket answered for pid ${seen.pid}`;
        throw new Error(`runner ${name} did not start within ${timeoutMs} ms (${state}):\n${logTail()}`);
      }
      await Bun.sleep(POLL_MS);
    }
  }

  async function stop(): Promise<void> {
    const current = requireRunning('stop');
    log(`--- harness: SIGTERM at ${new Date().toISOString()}`);
    current.kill('SIGTERM');
    const timeoutMs = home.config.timings.suspend + STOP_MARGIN_MS;
    const code = await exitWithin(current, timeoutMs);
    if (code === null) {
      current.kill('SIGKILL');
      await current.exited;
      throw new Error(`runner ${name} did not exit within ${timeoutMs} ms of SIGTERM:\n${logTail()}`);
    }
    if (code !== 0) throw new Error(`runner ${name} exited ${code} on SIGTERM:\n${logTail()}`);
  }

  async function kill(): Promise<void> {
    const current = requireRunning('kill');
    log(`--- harness: SIGKILL at ${new Date().toISOString()}`);
    current.kill('SIGKILL');
    await current.exited;
  }

  async function freeze(): Promise<number[]> {
    const current = requireRunning('freeze');
    log(`--- harness: freezing the tree at ${new Date().toISOString()}`);
    frozen = true;
    return freezeTree(current.pid);
  }

  async function thaw(): Promise<number[]> {
    const current = requireRunning('thaw');
    frozen = false;
    const thawed = await thawTree(current.pid);
    log(`--- harness: thawed the tree at ${new Date().toISOString()}`);
    return thawed;
  }

  async function status(): Promise<RunnerStatusReport> {
    mkdirSync(statusPath, { recursive: true });
    const env = { ...home.env, PATH: statusPath };
    const child = Bun.spawn([process.execPath, '--no-env-file', CLI_MAIN, 'runner', 'status', '--json'], {
      cwd: home.dir,
      env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    const code = await exitWithin(child, STATUS_TIMEOUT_MS);
    if (code === null) {
      child.kill('SIGKILL');
      await child.exited;
      throw new Error(`agflow runner status --json for ${name} did not answer within ${STATUS_TIMEOUT_MS} ms`);
    }
    const [stdout, stderr] = await output;
    // It exits 0 when the runner answered and 1 with the offline report; anything else is a failure.
    try {
      return JSON.parse(stdout) as RunnerStatusReport;
    } catch {
      throw new Error(`agflow runner status --json for ${name} exited ${code}: ${stderr.trim() || stdout.trim()}`);
    }
  }

  async function agentOf(attemptId: string): Promise<ProcessIdentity> {
    const report = await status();
    if (!report.running) throw new Error(`runner ${name} is not running, so it has no agent for ${attemptId}`);
    const attempt = report.attempts.find((candidate) => candidate.attemptId === attemptId);
    if (attempt === undefined) throw new Error(`runner ${name} has no attempt ${attemptId}`);
    const { pid, pgid, lstart } = attempt;
    if (pid === null || pgid === null || lstart === null) {
      throw new Error(`runner ${name} has recorded no agent process for ${attemptId} (phase ${attempt.phase})`);
    }
    // macOS reuses pids: only the same pid with the same start time is the recorded agent.
    const now = await processIdentity(pid);
    if (now === null || !sameProcess(now, { pid, lstart }) || now.pgid !== pgid) {
      throw new Error(`the agent of ${attemptId} (pid ${pid}, started ${lstart}) no longer runs`);
    }
    return { pid, pgid, lstart };
  }

  async function killAgent(attemptId: string): Promise<ProcessIdentity> {
    const agent = await agentOf(attemptId);
    log(`--- harness: SIGKILL of ${attemptId}'s group ${agent.pgid} at ${new Date().toISOString()}`);
    if (!(await signalGroup(agent.pgid, 'SIGKILL'))) {
      throw new Error(`the agent group ${agent.pgid} of ${attemptId} is gone`);
    }
    return agent;
  }

  async function close(): Promise<void> {
    const current = proc;
    if (current !== null && running()) {
      if (frozen) await thaw();
      // Collected first: once the runner is gone, its agents are reparented and no longer descend from it.
      const descendants = await descendantsOf(current.pid);
      current.kill('SIGKILL');
      await current.exited;
      for (const row of descendants) signal(row.pid, 'SIGKILL');
    }
    // Escaped tools and agents of an earlier kill: everything whose cwd is still inside the runner's directory.
    const left = await processesInDir(home.dir);
    for (const row of left) signal(row.pid, 'SIGKILL');
    for (const row of left) await waitUntilGone(row.pid, { timeoutMs: CLOSE_WAIT_MS });
  }

  return {
    home,
    name,
    get pid() {
      return running() ? (proc?.pid ?? null) : null;
    },
    get running() {
      return running();
    },
    get exitCode() {
      return proc === null || running() ? null : proc.exitCode;
    },
    start,
    stop,
    kill,
    freeze,
    thaw,
    status,
    agentOf,
    killAgent,
    clonePath: (attemptId) => home.clonePath(attemptId),
    logTail,
    close,
  };
}
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `bun test packages/testkit/test/runner-home.test.ts && bun test packages/testkit/e2e/runner-process.e2e.test.ts && AGFLOW_E2E=1 caffeinate -i bun test --timeout 600000 packages/testkit/e2e/runner-process.e2e.test.ts && bun run typecheck`
Expected: all selected tests pass (0 fail); tsc exits 0; the gated cases run for both vendors against scripted servers.

The red command needs no vendor CLI; the pass command also runs the gated real-runner tests for both vendors. Supply explicit pinned binary paths for the latter. Keep the scratch HOME, credential file mode 0600, proxy-only external connectivity, absolute PATH and empty-PATH status command. The final commit includes cleanup on failed start, matching the health response pid, and E2E_TEST_TIMEOUT_MS. The gated case offers one vendor at a time and requires the other to report binary missing. See Decisions 35–38.

- [ ] **Step 5: Commit**

```bash
git add -A 'packages/testkit/e2e/runner-process.e2e.test.ts' 'packages/testkit/src/harness/env.ts' 'packages/testkit/src/harness/index.ts' 'packages/testkit/src/harness/runner-process.ts' 'packages/testkit/test/runner-home.test.ts'
git commit -m 'M2G Task 5: Harness: runner homes and runner processes' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

### Task 6: Harness: the cluster, its smoke test and `bun run e2e`

startCluster composes one hub process, a local bare origin (originRepo), the scripted models and three runners owned by alice, bob and carol. ClusterOptions.vendor gives every runner that vendor only (X-10), so placement and lead seating are deterministic. The cluster lives in a short /tmp directory, so runner.sock stays under the Unix socket path limit. Before any runner connects, the person turns runner leads off unless the scenario wants a runner lead, and sets a goal. waitFor polls the hub until a deadline; waitForEvent matches events by type, subject and data.attemptId (6.17). On timeout both fail with a dump: the attempts and their logs, the runners, recent events, runner log tails and the model requests of the attempts involved. openGate writes a gate file in an attempt's clone. close() thaws, kills and sweeps every process the cluster started, and keeps the directory when a test failed or KEEP_E2E=1. The smoke test proves the whole chain before any scenario relies on it.

**Files:**
- Modify: `package.json`
- Test: `packages/testkit/e2e/cluster.e2e.test.ts`
- Create: `packages/testkit/src/harness/cluster.ts`
- Modify: `packages/testkit/src/harness/hub-process.ts`
- Modify: `packages/testkit/src/harness/index.ts`
- Modify: `packages/testkit/src/harness/proc.ts`
- Modify: `packages/testkit/src/harness/runner-process.ts`
- Test: `packages/testkit/test/proc.test.ts`

- [ ] **Step 1: Write the failing tests**

**File:** `packages/testkit/e2e/cluster.e2e.test.ts` (new)

```ts
// The cluster's smoke test (design 1, 6.4, 6.13, 7.8, 15): the whole chain, before any scenario relies on it. Per
// vendor: one hub process, three runners with the real CLI behind the scripted models, one task that commits a file
// and submits, its acceptance and the clone's cleanup. Runs only with AGFLOW_E2E=1; the root script check runs always.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { attemptId, DEFAULT_WIP_REF_PREFIX, taskBranchName, wipRef } from '@agflow/core';
import { processIdentity } from '@agflow/runner/src/processes';
import { fileAt, gitIn, refSha } from '../src/git-fixtures';
import { type Cluster, startCluster } from '../src/harness/cluster';
import { describeE2e, E2E_TEST_TIMEOUT_MS, e2eVendors } from '../src/harness/env';
import { E2E_HUB_TIMINGS, E2E_USERS } from '../src/harness/hub-process';
import { gate, type Next, type Program, say, shell, tool } from '../src/harness/playbook';
import { processesInDir } from '../src/harness/proc';

// Every step drives a real CLI through the hub and the runner; the cluster's start runs three runners' preflights.
setDefaultTimeout(E2E_TEST_TIMEOUT_MS);
const START_TIMEOUT_MS = 300_000;

const TASK = {
  title: 'Add hello.txt',
  objective: 'Add hello.txt, which says hello, and submit it.',
  acceptance: [{ id: 'hello', assertion: 'hello.txt says hello' }],
};

/** Commits hello.txt, waits at a gate while the test looks at the agent, then submits. */
function smokeProgram(taskId: string): Program {
  return {
    steps: [
      say(
        'I add hello.txt and commit it.',
        shell("printf 'hello\\n' > hello.txt && git add hello.txt && git commit -q -m 'Add hello.txt'"),
      ),
      gate('looked-at'),
      say('I submit the task.', tool('submit', { task_id: taskId, summary: 'Added hello.txt, which says hello.' })),
    ],
  };
}

test('root script `bun run e2e` runs packages/testkit/e2e with AGFLOW_E2E=1 under caffeinate -i, 10 minutes a test', () => {
  const manifest = JSON.parse(readFileSync(join(import.meta.dir, '../../../package.json'), 'utf8'));
  expect(manifest.scripts.e2e).toBe(
    `AGFLOW_E2E=1 caffeinate -i bun test --timeout ${E2E_TEST_TIMEOUT_MS} packages/testkit/e2e`,
  );
});

describeE2e('the cluster', () => {
  for (const vendor of e2eVendors()) {
    describe(vendor, () => {
      let started: Cluster | null = null;
      let taskId = '';
      let a1 = '';
      const cluster = (): Cluster => {
        if (started === null) throw new Error('the cluster did not start');
        return started;
      };

      beforeAll(async () => {
        started = await startCluster({ vendor });
      }, START_TIMEOUT_MS);

      afterAll(async () => {
        await started?.close();
      });

      test('three runners come online, owned by alice, bob and carol, and no lead starts while runner leads are off', () =>
        cluster().step(async () => {
          const { person, runners } = cluster();
          const online = (await person.runners()).runners;
          expect(online.map((runner) => [runner.owner, runner.name, runner.state]).sort()).toEqual(
            E2E_USERS.map((login) => [login, `${login}-mac`, 'online']),
          );
          expect(runners.map((runner) => runner.name)).toEqual(E2E_USERS.map((login) => `${login}-mac`));
          for (const runner of online) {
            expect(runner.vendors.filter((entry) => entry.ready).map((entry) => entry.vendor)).toEqual([vendor]);
          }
          // A few scheduler ticks with three free runners: still no lead.
          await Bun.sleep(3 * E2E_HUB_TIMINGS.tickMs);
          expect(await person.attempts({ role: 'lead' })).toEqual([]);
          expect((await person.status()).leadSeat.kind).toBe('none');
        }));

      test('while the attempt runs, agentOf gives its live agent, the leader of its own group, in the clone (Claude) or the codex user home with its commands in the clone (Codex)', () =>
        cluster().step(async () => {
          const { person, models, waitFor, waitForEvent } = cluster();
          const [task] = await person.createTasks([TASK]);
          if (!task) throw new Error('no task created');
          taskId = task.id;
          a1 = attemptId(taskId, 1, 1);
          models.addPrograms({ [a1]: smokeProgram(taskId) });
          await waitForEvent({ type: 'attempt.running', subject: taskId, attemptId: a1 });
          const gated = (answer: Next | null) =>
            answer?.kind === 'step' && answer.step.kind === 'shell' && answer.step.gate !== null;
          const atGate = () => models.requestsFor(a1).some((request) => gated(request.answer));
          await waitFor(`${a1} to wait at its gate`, async () => atGate());
          const runner = await cluster().runnerOf(a1);
          const agent = await runner.agentOf(a1);
          expect(agent.pgid).toBe(agent.pid);
          expect(await processIdentity(agent.pid)).toEqual(agent);
          const clone = runner.clonePath(a1);
          // Claude runs in the clone; Codex's app-server in the runner's codex user home, its commands in the clone.
          const home = vendor === 'claude' ? clone : runner.home.paths.homes.codexUser;
          expect((await processesInDir(home)).map((row) => row.pid)).toContain(agent.pid);
          // The gate's command starts after the model's answer, so it may not run yet.
          await waitFor(`a process in ${a1}'s clone`, async () => (await processesInDir(clone)).length > 0);
        }));

      test('the task is dispatched and ends submitted; origin has the task branch and the WIP ref at one commit', () =>
        cluster().step(async () => {
          const { origin, person, openGate, waitFor, waitForEvent } = cluster();
          await openGate(a1, 'looked-at');
          const recorded = await waitForEvent({ type: 'submission.recorded', subject: taskId });
          const branch = taskBranchName(taskId, TASK.title, 1);
          expect(recorded.data.branch).toBe(branch);
          const submitted = async () => (await person.task(taskId)).task.status === 'submitted';
          await waitFor(`${taskId} to be submitted`, submitted);
          const { attempt } = await person.attempt(a1);
          expect(attempt.status).toBe('holding');
          const head = await refSha(origin.path, `refs/heads/${branch}`);
          expect(head).not.toBeNull();
          expect(recorded.data.headSha).toBe(head);
          expect(await refSha(origin.path, wipRef(DEFAULT_WIP_REF_PREFIX, a1))).toBe(head);
          // The hold stops the agent; its exit report carries the final WIP, which the hub then holds too.
          const holds = async () => (await person.attempt(a1)).attempt.wipSha === head;
          await waitFor(`the hub to hold ${a1}'s final WIP`, holds);
          expect(await fileAt(origin.path, head ?? '', 'hello.txt')).toBe('hello\n');
          const files = (await gitIn(origin.path, ['ls-tree', '-r', '--name-only', head ?? ''])).split('\n');
          expect(files.filter((file) => file.startsWith('.agflow/run/'))).toEqual([]);
        }));

      test('after the person accepts, the attempt ends accepted and cleanup_attempt removes its clone', () =>
        cluster().step(async () => {
          const { person, runnerOf, waitFor, waitForEvent } = cluster();
          const clone = (await runnerOf(a1)).clonePath(a1);
          expect(existsSync(clone)).toBe(true);
          await person.accept(taskId);
          const ended = { type: 'attempt.ended', subject: taskId, attemptId: a1, data: { endReason: 'accepted' } };
          await waitForEvent(ended);
          expect((await person.attempt(a1)).attempt).toMatchObject({ status: 'ended', endReason: 'accepted' });
          await waitFor(`the clone of ${a1} to be removed`, async () => !existsSync(clone));
          // The submitted work is the accepted work: nothing of it counts as late.
          expect((await person.task(taskId)).notes.filter((note) => note.kind === 'late_work')).toEqual([]);
        }));

      test('a waitFor that times out throws an error that carries the cluster dump', () =>
        cluster().step(async () => {
          const { waitFor, runners } = cluster();
          const error = await waitFor('a thing that never happens', async () => false, { timeoutMs: 1_000 }).then(
            () => null,
            (caught: unknown) => caught as Error,
          );
          expect(error?.message).toContain('timed out after 1000 ms waiting for a thing that never happens');
          expect(error?.message).toContain(`=== cluster ${cluster().dir}`);
          expect(error?.message).toContain(`--- attempts\n${a1} worker ended/`);
          expect(error?.message).toContain('--- events');
          expect(error?.message).toContain(`model requests of ${a1}`);
          for (const runner of runners) {
            expect(error?.message).toContain(`--- runner ${runner.name} (pid ${runner.pid})`);
          }
        }));

      // Not a step: a step still running at close() would keep the directory.
      test('after close(), no process has its cwd under the cluster directory, waits refuse, and only external hosts met the proxy', async () => {
        const { dir, models } = cluster();
        expect(models.requestsFor(a1).length).toBeGreaterThan(0);
        await cluster().close();
        expect(await processesInDir(dir)).toEqual([]);
        // A step a timed-out test left running stops at its next wait.
        await expect(cluster().waitFor('anything', async () => true)).rejects.toThrow('the cluster is closed');
        // The CLIs reached the scripted servers and the hub directly; the proxy refused whatever else they tried.
        const local = /127\.0\.0\.1|localhost|\[::1\]/;
        const loopback = models.externalAttempts().filter((request) => local.test(request.target));
        expect(loopback).toEqual([]);
      });
    });
  }
});
```

**File:** `packages/testkit/test/proc.test.ts` (change)

```diff
diff --git a/packages/testkit/test/proc.test.ts b/packages/testkit/test/proc.test.ts
index 898282e1..d7c16a63 100644
--- a/packages/testkit/test/proc.test.ts
+++ b/packages/testkit/test/proc.test.ts
@@ -1,5 +1,5 @@
 import { afterEach, describe, expect, test } from 'bun:test';
-import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
+import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
 import { join } from 'node:path';
 import {
   descendantsOf,
@@ -221,3 +221,51 @@ describe('waitUntilGone', () => {
     expect(await isAlive(long.pid)).toBe(true);
   });
 });
+
+describe('trackProcess', () => {
+  const PROC = join(import.meta.dir, '../src/harness/proc.ts');
+
+  /**
+   * A bun process that tracks a frozen tree, as a cluster tracks a frozen runner, writes the pids it froze, and then
+   * ends as `how` says, without any afterAll.
+   */
+  async function endTracking(how: 'exit' | 'SIGTERM'): Promise<number[]> {
+    const dir = tmpDir('agflow-track-');
+    const script = join(dir, 'track.ts');
+    const end = how === 'exit' ? 'process.exit(0);' : "process.kill(process.pid, 'SIGTERM'); await Bun.sleep(60_000);";
+    writeFileSync(
+      script,
+      [
+        `import { freezeTree, trackProcess } from ${JSON.stringify(PROC)};`,
+        "const root = Bun.spawn(['sh', '-c', 'sleep 41 & sleep 42 & wait'], { stdin: 'ignore' });",
+        'trackProcess(root);',
+        'await Bun.sleep(300);',
+        'const frozen = await freezeTree(root.pid);',
+        `await Bun.write(${JSON.stringify(join(dir, 'frozen'))}, frozen.join(' ') + '\\n');`,
+        end,
+      ].join('\n'),
+    );
+    const tracker = Bun.spawn([process.execPath, script], { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' });
+    const code = await tracker.exited;
+    const frozen = readFileSync(join(dir, 'frozen'), 'utf8').trim().split(' ').map(Number);
+    for (const pid of frozen) pids.add(pid);
+    expect({ code, stderr: await new Response(tracker.stderr).text() }).toEqual({
+      code: how === 'exit' ? 0 : 143,
+      stderr: '',
+    });
+    return frozen;
+  }
+
+  test('a tracked tree, frozen, is killed when the process exits without closing it', async () => {
+    const frozen = await endTracking('exit');
+    expect(frozen.length).toBe(3);
+    for (const pid of frozen) await waitUntilGone(pid, { timeoutMs: 5_000 });
+  });
+
+  test('a tracked tree, frozen, is killed when SIGTERM ends the process, which exits 128 + 15', async () => {
+    const frozen = await endTracking('SIGTERM');
+    expect(frozen.length).toBe(3);
+    for (const pid of frozen) await waitUntilGone(pid, { timeoutMs: 5_000 });
+  });
+});
+
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `bun test packages/testkit/e2e/cluster.e2e.test.ts`
Expected: FAIL — `error: Cannot find module '../src/harness/cluster' from '.../packages/testkit/e2e/cluster.e2e.test.ts'` (0 pass, 1 fail; final-parent check, 2026-11-11). The earlier prototype report separately recorded the missing root e2e script assertion.

- [ ] **Step 3: Implement**

**File:** `package.json` (change)

```diff
diff --git a/package.json b/package.json
index a9117296..baf7611f 100644
--- a/package.json
+++ b/package.json
@@ -23,7 +23,8 @@
     "check:claude-sandbox": "AGFLOW_SMOKE=1 AGFLOW_SANDBOX_CHECKS=1 bun test packages/runner/test/claude-sandbox",
     "gen:codex-protocol": "bun packages/runner/scripts/gen-codex-protocol.ts",
     "smoke:codex": "AGFLOW_SMOKE=1 bun test packages/runner/test/codex",
-    "check:codex-sandbox": "AGFLOW_SMOKE=1 AGFLOW_SANDBOX_CHECKS=1 bun test packages/runner/test/codex/real/sandbox.test.ts"
+    "check:codex-sandbox": "AGFLOW_SMOKE=1 AGFLOW_SANDBOX_CHECKS=1 bun test packages/runner/test/codex/real/sandbox.test.ts",
+    "e2e": "AGFLOW_E2E=1 caffeinate -i bun test --timeout 600000 packages/testkit/e2e"
   },
   "devDependencies": {
     "@types/bun": "1.3.14",
```

**File:** `packages/testkit/src/harness/cluster.ts` (new)

```ts
// A cluster for the e2e scenarios (design 1, 15): one hub process, a local bare origin, the scripted models and three
// runners owned by alice, bob and carol. Every runner offers the cluster's vendor only (X-10), so placement and lead
// seating are deterministic. Scenarios wait on what the hub shows; a wait that times out fails with a dump of
// everything a reader needs to see why.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Attempt, HubEvent, Vendor } from '@agflow/core';
import { type OriginRepo, originRepo } from '../git-fixtures';
import { requireE2e } from './env';
import { E2E_USERS, type HubProcess, type HubTimings, startHubProcess } from './hub-process';
import { type Models, startModels } from './models';
import { cliToken, type Person, signIn } from './person';
import { GATE_DIR, type Programs } from './playbook';
import { processesInDir } from './proc';
import { prepareRunnerHome, type RunnerHome, type RunnerProcess, startRunnerProcess } from './runner-process';

export interface ClusterOptions {
  /** Every runner offers this vendor only. */
  vendor: Vendor;
  /** Whether the hub seats a runner lead; off by default, so only the scenario's workers run. */
  runnerLeads?: boolean;
  /** The goal the person sets before any runner connects. */
  goal?: string;
  /** main's files on the origin. */
  files?: Record<string, string>;
  /** The scripted programs known up front; more come through models.addPrograms. */
  programs?: Programs;
  /** The hub's timings; E2E_HUB_TIMINGS by default. */
  hubTimings?: HubTimings;
}

export interface ClusterWaitOptions {
  /** 120 s by default. */
  timeoutMs?: number;
  /** 250 ms by default. */
  intervalMs?: number;
}

/** An event to wait for: its type, and optionally its subject, its data.attemptId and other data fields. */
export interface EventMatch {
  type: string;
  subject?: string;
  attemptId?: string;
  data?: Record<string, unknown>;
}

export interface EventWaitOptions extends ClusterWaitOptions {
  /** Only events with a larger id count; 0 by default. */
  after?: number;
}

export interface Cluster {
  /** The cluster's directory, at its real path: the hub's and every runner's directories. */
  readonly dir: string;
  readonly vendor: Vendor;
  readonly hub: HubProcess;
  readonly origin: OriginRepo;
  readonly models: Models;
  /** alice, signed in: she set the goal and the runner-leads switch, and accepts work. */
  readonly person: Person;
  /** The runners of alice, bob and carol, in that order. */
  readonly runners: readonly RunnerProcess[];
  /** Whether a step threw; close() then keeps the directory. */
  readonly failed: boolean;
  /** Steps still running: a test that timed out leaves its step running, and close() then keeps the directory. */
  readonly inFlight: number;
  /** The runner the hub placed the attempt on. */
  runnerOf(attemptId: string): Promise<RunnerProcess>;
  /** The task's attempts, oldest first. */
  attemptsOf(taskId: string): Promise<Attempt[]>;
  /**
   * Polls check until it gives a value other than null, undefined or false, and resolves with it. A check that throws
   * counts as not yet, so a wait survives a hub restart. On timeout it throws with the last error and the dump.
   */
  waitFor<T>(
    what: string,
    check: () => Promise<T | null | undefined | false>,
    options?: ClusterWaitOptions,
  ): Promise<T>;
  /** The first event, oldest first, that matches; on timeout it throws with the dump. */
  waitForEvent(match: EventMatch, options?: EventWaitOptions): Promise<HubEvent>;
  /** Opens the gate a playbook step of the attempt waits for, in the attempt's clone. */
  openGate(attemptId: string, name: string): Promise<void>;
  /** Everything a failure needs: attempts and their logs, runners, recent events, log tails and model requests. */
  dump(): Promise<string>;
  /**
   * Runs a test step; a step that throws marks the cluster failed, and a step still running at close() (its test
   * timed out) counts as failed too, so close() keeps the directory. Once close() began, waits and gates throw at once,
   * so a step left running stops soon.
   */
  step<T>(body: () => Promise<T>): Promise<T>;
  /**
   * Thaws, kills and sweeps every process the cluster started, then removes its files, unless keep (by default:
   * KEEP_E2E=1, a failed step or a step still running) keeps them for a look. A second call does nothing.
   */
  close(options?: { keep?: boolean }): Promise<void>;
}

const DEFAULT_WAIT_MS = 120_000;
const DEFAULT_INTERVAL_MS = 250;
const DEFAULT_GOAL = 'Keep the e2e repository tidy, one small task at a time.';
const DEFAULT_FILES = { 'README.md': '# e2e\n\nA repository for agflow end-to-end tests.\n' };

/** How much of the cluster the dump shows. */
const DUMP = { attemptLog: 20, events: 40, logLines: 30, requests: 6, requestChars: 1_500 };

/** One line of JSON, cut to a length a dump can carry. */
function brief(value: unknown, max = 400): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function matches(event: HubEvent, match: EventMatch): boolean {
  if (event.type !== match.type) return false;
  if (match.subject !== undefined && event.subject !== match.subject) return false;
  if (match.attemptId !== undefined && event.data.attemptId !== match.attemptId) return false;
  return Object.entries(match.data ?? {}).every(([key, value]) => Bun.deepEquals(event.data[key], value));
}

/** Starts a cluster; a start that fails stops every process it started and keeps its files for a look. */
export async function startCluster(options: ClusterOptions): Promise<Cluster> {
  const { binaries } = await requireE2e();
  // Short and real: runner.sock must fit in 104 bytes, and lsof reports real paths.
  const dir = realpathSync(mkdtempSync('/tmp/agf-e2e-'));
  const started: {
    origin?: OriginRepo;
    models?: Models;
    hub?: HubProcess;
    homes: RunnerHome[];
    runners: RunnerProcess[];
  } = { homes: [], runners: [] };
  const stopAll = async () => {
    for (const runner of started.runners) await runner.close().catch(() => {});
    await started.models?.close();
    if (started.hub?.running) await started.hub.kill();
    // Whatever escaped: agents of a runner that died during the start still run in its directory.
    for (const row of await processesInDir(dir).catch(() => [])) {
      try {
        process.kill(row.pid, 'SIGKILL');
      } catch {
        // Gone meanwhile.
      }
    }
  };
  try {
    started.origin = await originRepo(options.files ?? DEFAULT_FILES);
    started.models = await startModels({ programs: options.programs });
    const repo = started.origin.path;
    const hub = await startHubProcess({ dir: join(dir, 'hub'), repo, timings: options.hubTimings });
    started.hub = hub;
    const people = await Promise.all(E2E_USERS.map((login) => signIn(hub.url, login)));
    const [person] = people;
    if (!person) throw new Error('no person to drive the cluster');
    // Before any runner connects: the seat and the goal are what the scheduler reads first.
    await person.setRunnerLeads(options.runnerLeads ?? false);
    await person.setGoal(options.goal ?? DEFAULT_GOAL);
    const models = started.models;
    for (const owner of people) {
      started.homes.push(
        await prepareRunnerHome({
          dir: join(dir, owner.login),
          name: `${owner.login}-mac`,
          credentials: { hubUrl: hub.url, token: await cliToken(owner), user: owner.login },
          vendors: [options.vendor],
          binaries,
          models,
        }),
      );
    }
    for (const home of started.homes) started.runners.push(await startRunnerProcess(home));
    return createCluster({
      dir,
      vendor: options.vendor,
      hub,
      origin: started.origin,
      models,
      person,
      homes: started.homes,
      runners: started.runners,
    });
  } catch (error) {
    await stopAll();
    throw new Error(`the cluster did not start; its files are in ${dir}: ${describe(error)}`, { cause: error });
  }
}

interface ClusterParts {
  dir: string;
  vendor: Vendor;
  hub: HubProcess;
  origin: OriginRepo;
  models: Models;
  person: Person;
  homes: RunnerHome[];
  runners: RunnerProcess[];
}

function createCluster(parts: ClusterParts): Cluster {
  const { dir, vendor, hub, origin, models, person, homes, runners } = parts;
  let failed = false;
  let inFlight = 0;
  let closing: Promise<void> | null = null;

  function requireOpen(what: string): void {
    if (closing !== null) throw new Error(`the cluster is closed: cannot ${what}`);
  }

  async function runnerOf(attemptId: string): Promise<RunnerProcess> {
    const { attempt } = await person.attempt(attemptId);
    if (attempt.runnerId === null) throw new Error(`${attemptId} runs on no runner`);
    const placed = (await person.runners()).runners.find((runner) => runner.id === attempt.runnerId);
    const runner = runners.find((candidate) => candidate.name === placed?.name);
    if (!runner) throw new Error(`${attemptId} runs on ${attempt.runnerId}, which is no runner of this cluster`);
    return runner;
  }

  async function attemptsOf(taskId: string): Promise<Attempt[]> {
    return (await person.attempts({ task: taskId })).sort((a, b) => a.number - b.number);
  }

  /** Each part on its own: a hub that is down still leaves the runners' and the models' parts. */
  async function section(title: string, body: () => Promise<string[]> | string[]): Promise<string> {
    try {
      const lines = await body();
      return [`--- ${title}`, ...(lines.length > 0 ? lines : ['(none)'])].join('\n');
    } catch (error) {
      return `--- ${title}\n(unavailable: ${describe(error)})`;
    }
  }

  async function dump(): Promise<string> {
    const attempts = await person.attempts().catch(() => [] as Attempt[]);
    const parts = [
      `=== cluster ${dir} (${vendor}), hub ${hub.url}${hub.running ? '' : ' (not running)'}`,
      await section('attempts', async () => {
        const lines: string[] = [];
        for (const attempt of [...attempts].reverse()) {
          lines.push(
            `${attempt.id} ${attempt.role} ${attempt.status}/${attempt.phase ?? '-'} ` +
              `runner ${attempt.runnerId ?? '-'} fence ${brief(attempt.fence)} ` +
              `end ${attempt.endReason ?? '-'}/${attempt.failureClass ?? '-'} ` +
              `start ${attempt.startSha ?? '-'} wip ${attempt.wipSha ?? '-'}`,
          );
          const { log } = await person.attempt(attempt.id);
          for (const entry of log.slice(-DUMP.attemptLog)) lines.push(`  ${entry.kind}: ${brief(entry.summary, 300)}`);
        }
        return lines;
      }),
      await section('runners', async () =>
        (await person.runners()).runners.map(
          (runner) =>
            `${runner.name} ${runner.id} ${runner.state}${runner.stateDetail ? ` (${runner.stateDetail})` : ''} ` +
            `active ${runner.activeAttempts} vendors ` +
            runner.vendors.map((entry) => `${entry.vendor}:${entry.ready ? 'ready' : entry.problem}`).join(','),
        ),
      ),
      await section(`events (newest ${DUMP.events})`, async () =>
        (await person.events({ latest: true, limit: DUMP.events }))
          .reverse()
          .map((event) => `#${event.id} ${event.type} ${event.subject ?? '-'} ${event.actor} ${brief(event.data)}`),
      ),
      ...runners.map((runner) =>
        section(`runner ${runner.name} (${runner.running ? `pid ${runner.pid}` : 'not running'})`, () =>
          runner.logTail(DUMP.logLines).split('\n'),
        ),
      ),
      section('hub log', () => hub.logTail(DUMP.logLines).split('\n')),
      ...attempts.map((attempt) =>
        section(`model requests of ${attempt.id}`, () =>
          models
            .requestsFor(attempt.id)
            .slice(-DUMP.requests)
            .map((request) => {
              const answer = request.answer === null ? 'default' : brief(request.answer, 300);
              const seen = request.text.slice(-DUMP.requestChars);
              return `#${request.seq} ${request.vendor} answered ${answer}\n  saw …${seen}`;
            }),
        ),
      ),
      section('unmatched model requests', () =>
        models.unmatched().map((request) => `#${request.seq} ${request.vendor} …${request.text.slice(-300)}`),
      ),
    ];
    return (await Promise.all(parts)).join('\n');
  }

  async function waitFor<T>(
    what: string,
    check: () => Promise<T | null | undefined | false>,
    options: ClusterWaitOptions = {},
  ): Promise<T> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_MS;
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown = null;
    for (;;) {
      requireOpen(`wait for ${what}`);
      try {
        const value = await check();
        if (value !== null && value !== undefined && value !== false) return value;
        lastError = null;
      } catch (error) {
        lastError = error;
      }
      if (Date.now() >= deadline) {
        const last = lastError === null ? '' : ` (last error: ${describe(lastError)})`;
        throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}${last}\n${await dump()}`);
      }
      await Bun.sleep(options.intervalMs ?? DEFAULT_INTERVAL_MS);
    }
  }

  async function waitForEvent(match: EventMatch, options: EventWaitOptions = {}): Promise<HubEvent> {
    let after = options.after ?? 0;
    const what =
      `event ${match.type}${match.subject ? ` of ${match.subject}` : ''}` +
      `${match.attemptId ? ` for ${match.attemptId}` : ''}${match.data ? ` with ${brief(match.data)}` : ''}`;
    return waitFor(
      what,
      async () => {
        const events = await person.events({ after, subject: match.subject, limit: 1000 });
        const found = events.find((event) => matches(event, match));
        if (found) return found;
        after = events.at(-1)?.id ?? after;
        return null;
      },
      options,
    );
  }

  async function openGate(attemptId: string, name: string): Promise<void> {
    const runner = await runnerOf(attemptId);
    // A step left running must not recreate directories in a removed cluster.
    requireOpen(`open the gate ${name} of ${attemptId}`);
    const file = join(runner.clonePath(attemptId), GATE_DIR, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '');
  }

  async function step<T>(body: () => Promise<T>): Promise<T> {
    inFlight += 1;
    try {
      return await body();
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      inFlight -= 1;
    }
  }

  async function shutDown(keep: boolean): Promise<void> {
    const problems: string[] = [];
    for (const runner of runners) {
      await runner.close().catch((error) => problems.push(`runner ${runner.name}: ${describe(error)}`));
    }
    await models.close();
    if (hub.running) await hub.kill();
    // Whatever escaped every runner's sweep: the cluster's directory must be empty of processes.
    const left = await processesInDir(dir);
    for (const row of left) {
      try {
        process.kill(row.pid, 'SIGKILL');
      } catch {
        // Gone meanwhile.
      }
      problems.push(`process ${row.pid} (${row.command}) still ran in ${dir}`);
    }
    if (keep) {
      process.stderr.write(`agflow e2e: kept the cluster's files in ${dir} and the origin in ${origin.root}\n`);
    } else {
      for (const home of homes) home.remove();
      rmSync(dir, { recursive: true, force: true });
      origin.remove();
    }
    if (problems.length > 0) throw new Error(`closing the cluster:\n${problems.join('\n')}`);
  }

  return {
    dir,
    vendor,
    hub,
    origin,
    models,
    person,
    runners,
    get failed() {
      return failed;
    },
    get inFlight() {
      return inFlight;
    },
    runnerOf,
    attemptsOf,
    waitFor,
    waitForEvent,
    openGate,
    dump,
    step,
    close(options = {}) {
      closing ??= shutDown(options.keep ?? (failed || inFlight > 0 || process.env.KEEP_E2E === '1'));
      return closing;
    },
  };
}
```

**File:** `packages/testkit/src/harness/hub-process.ts` (change)

```diff
diff --git a/packages/testkit/src/harness/hub-process.ts b/packages/testkit/src/harness/hub-process.ts
index 1aabe1c4..115781f7 100644
--- a/packages/testkit/src/harness/hub-process.ts
+++ b/packages/testkit/src/harness/hub-process.ts
@@ -5,6 +5,7 @@ import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync,
 import { join } from 'node:path';
 import type { BackupKind } from '../../../hub/src/backup';
 import type { HubConfig } from '../../../hub/src/context';
+import { trackProcess } from './proc';
 
 const HUB_SRC = join(import.meta.dir, '../../../hub/src');
 const MAIN = join(HUB_SRC, 'main.ts');
@@ -197,6 +198,7 @@ function createHubProcess(options: HubProcessOptions, port: number): HubProcess
     log(`--- harness: starting the hub at ${new Date().toISOString()}`);
     const started = spawn([MAIN], env);
     proc = started;
+    trackProcess(started);
     const deadline = Date.now() + startTimeoutMs;
     while (!(await answers())) {
       if (started.exitCode !== null || started.signalCode !== null) {
```

**File:** `packages/testkit/src/harness/index.ts` (change)

```diff
diff --git a/packages/testkit/src/harness/index.ts b/packages/testkit/src/harness/index.ts
index 179a6a5b..8130cb1f 100644
--- a/packages/testkit/src/harness/index.ts
+++ b/packages/testkit/src/harness/index.ts
@@ -1,5 +1,6 @@
 // The multi-runner e2e harness (design 15, X-20). It has its own entry, so the testkit's main index keeps importing
 // runner types only; the harness imports runner and hub modules by path and adds no dependency (X-44).
+export * from './cluster';
 export * from './env';
 export * from './hub-process';
 export * from './models';
```

**File:** `packages/testkit/src/harness/proc.ts` (change)

```diff
diff --git a/packages/testkit/src/harness/proc.ts b/packages/testkit/src/harness/proc.ts
index 3af0a2a9..7a506bd2 100644
--- a/packages/testkit/src/harness/proc.ts
+++ b/packages/testkit/src/harness/proc.ts
@@ -2,8 +2,16 @@
 // process group, find what still runs in a directory, wait for a process to go. The ps and lsof readers are M2b's
 // (X-42); only this file follows their names, and it adds the tree walk, the signals and the waits.
 import { realpathSync } from 'node:fs';
+import { constants } from 'node:os';
 import { basename, dirname, isAbsolute, join } from 'node:path';
-import { findCloneProcesses, listProcesses as psRows, type PsRow } from '@agflow/runner/src/processes';
+import {
+  findCloneProcesses,
+  PS_COLUMNS,
+  PS_ENV,
+  parsePs,
+  listProcesses as psRows,
+  type PsRow,
+} from '@agflow/runner/src/processes';
 
 /** One process as ps shows it: pid, ppid, pgid, stat (T when stopped, Z for a zombie), lstart and command. */
 export type ProcessInfo = PsRow;
@@ -145,3 +153,56 @@ export async function waitUntilGone(pid: number, options: WaitOptions = {}): Pro
     await Bun.sleep(options.intervalMs ?? 50);
   }
 }
+
+// --- Tracked processes ----------------------------------------------------------------------------------------------
+
+/** The hub and runner processes the harness started that still run. */
+const tracked = new Set<Bun.Subprocess>();
+let hooked = false;
+
+/**
+ * Tracks a hub or runner process until it exits. If the test process ends first (afterAll never ran: Ctrl-C, SIGTERM
+ * or SIGHUP, a crash, a timed-out hook), an exit hook kills it and everything under it, frozen trees included: spawned
+ * processes outlive bun, and a SIGSTOPped tree would stay stopped for good.
+ */
+export function trackProcess(proc: Bun.Subprocess): void {
+  tracked.add(proc);
+  void proc.exited.then(() => tracked.delete(proc));
+  if (hooked) return;
+  hooked = true;
+  process.on('exit', killTracked);
+  for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
+    process.once(name, () => {
+      killTracked();
+      process.exit(128 + constants.signals[name]);
+    });
+  }
+}
+
+/**
+ * Synchronously, as an exit hook must: from one ps snapshot, SIGCONT and SIGKILL every descendant of a tracked
+ * process, then SIGKILL the tracked process itself.
+ */
+function killTracked(): void {
+  const live = [...tracked].filter((proc) => proc.exitCode === null && proc.signalCode === null);
+  if (live.length === 0) return;
+  const ps = Bun.spawnSync(['ps', '-A', '-o', PS_COLUMNS], { env: { ...process.env, ...PS_ENV } });
+  const rows = parsePs(ps.stdout.toString());
+  for (const proc of live) {
+    for (const row of descendantsIn(rows, proc.pid)) {
+      quietly(row.pid, 'SIGCONT');
+      quietly(row.pid, 'SIGKILL');
+    }
+    quietly(proc.pid, 'SIGCONT');
+    quietly(proc.pid, 'SIGKILL');
+  }
+}
+
+function quietly(pid: number, signal: NodeJS.Signals): void {
+  try {
+    process.kill(pid, signal);
+  } catch {
+    // Gone already, or never ours.
+  }
+}
+
```

**File:** `packages/testkit/src/harness/runner-process.ts` (change)

```diff
diff --git a/packages/testkit/src/harness/runner-process.ts b/packages/testkit/src/harness/runner-process.ts
index 6fd7f8c8..52280a8c 100644
--- a/packages/testkit/src/harness/runner-process.ts
+++ b/packages/testkit/src/harness/runner-process.ts
@@ -29,7 +29,15 @@ import { VENDOR_PINS, vendorBinary } from '@agflow/runner/src/vendor/pins';
 import { linkClaudeBinary } from '../anthropic/binary';
 import { E2E_PLATFORM } from './env';
 import type { Models } from './models';
-import { descendantsOf, freezeTree, processesInDir, signalGroup, thawTree, waitUntilGone } from './proc';
+import {
+  descendantsOf,
+  freezeTree,
+  processesInDir,
+  signalGroup,
+  thawTree,
+  trackProcess,
+  waitUntilGone,
+} from './proc';
 
 const CLI_MAIN = join(import.meta.dir, '../../../cli/src/main.ts');
 
@@ -365,6 +373,7 @@ function createRunnerProcess(home: RunnerHome): RunnerProcess {
     }
     proc = started;
     frozen = false;
+    trackProcess(started);
     try {
       await untilStarted(started, options.online !== false, timeoutMs);
     } catch (error) {
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `bun test packages/testkit/test/proc.test.ts && bun test packages/testkit/e2e/cluster.e2e.test.ts && AGFLOW_E2E=1 caffeinate -i bun test --timeout 600000 packages/testkit/e2e/cluster.e2e.test.ts && bun run typecheck`
Expected: all selected tests pass (0 fail); tsc exits 0; the gated cases run for both vendors against scripted servers.

The root-script check runs outside describeE2e and was the historical red test. With the final test file copied onto the final parent, the missing cluster import fails first. An additional parent-tree run of proc.test.ts was blocked by `EPERM: operation not permitted, posix_spawn ps`; that sandbox error is not implementation failure evidence, and the process tests need an outside run. The final Task 6 also owns trackProcess and its frozen-tree exit/SIGTERM regressions, plus the calls from both process wrappers. Every e2e file uses the shared 600 s default. The smoke waits for final WIP before acceptance, distinguishes Claude agent cwd from Codex command cwd, checks no late-work note, and closes outside cluster.step. The race it exposed in M2a was fixed by the hub plan; no hub patch belongs here. See Decisions 39–42.

- [ ] **Step 5: Commit**

```bash
git add -A 'package.json' 'packages/testkit/e2e/cluster.e2e.test.ts' 'packages/testkit/src/harness/cluster.ts' 'packages/testkit/src/harness/hub-process.ts' 'packages/testkit/src/harness/index.ts' 'packages/testkit/src/harness/proc.ts' 'packages/testkit/src/harness/runner-process.ts' 'packages/testkit/test/proc.test.ts'
git commit -m 'M2G Task 6: Harness: the cluster, its smoke test and `bun run e2e`' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

### Task 7: Exit scenario 1: killed agent

Design exit criterion 1. A worker commits a.txt, writes its handoff note, leaves b.txt uncommitted and runs a long command. The harness SIGKILLs the agent's process group. The runner must kill the remaining tool groups and sweep the clone, then harvest and push the final WIP, all before it reports the exit (X-15). The hub must end the attempt crashed (infra) and start a successor on another runner from that WIP and that note, and the successor finishes the task. The driver acts only on what it can observe (the hub API, origin, clone files, processes), so the live run reuses it with a real model that follows the task's written instructions. This task also adds the check list that every driver returns.

**Files:**
- Test: `packages/testkit/e2e/killed-agent.e2e.test.ts`
- Create: `packages/testkit/src/scenarios/killed-agent.ts`
- Create: `packages/testkit/src/scenarios/result.ts`

- [ ] **Step 1: Write the failing test**

**File:** `packages/testkit/e2e/killed-agent.e2e.test.ts` (new)

```ts
// Exit scenario 1, the killed agent (design 1, 6.8, 7.4, X-15), per vendor in a fresh cluster: the driver runs once and
// each test reads its own checks. Runs only with AGFLOW_E2E=1; the tests of the check list run always.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Cluster, startCluster } from '../src/harness/cluster';
import { describeE2e, E2E_TEST_TIMEOUT_MS, e2eVendors } from '../src/harness/env';
import { KILLED_AGENT, killedAgent } from '../src/scenarios/killed-agent';
import { checks, cloneFile, expectPassed, RAN_TO_END, type ScenarioResult } from '../src/scenarios/result';

setDefaultTimeout(E2E_TEST_TIMEOUT_MS);

describe('a scenario result', () => {
  test('lists every check with pass or fail and a detail, and passes only when all did', async () => {
    const result = await checks('a scenario', 'claude', async (record) => {
      record.check('a holds', true, 'it held');
      record.equal('b is 2', 1 + 1, 2);
      record.equal('c is 3', 2, 3);
    });
    expect(result).toEqual({
      scenario: 'a scenario',
      vendor: 'claude',
      checks: [
        { name: 'a holds', passed: true, detail: 'it held' },
        { name: 'b is 2', passed: true, detail: '2' },
        { name: 'c is 3', passed: false, detail: 'expected 3, got 2' },
        { name: RAN_TO_END, passed: true, detail: '3 checks made' },
      ],
      passed: false,
      dump: null,
    });
  });

  test('a run that ends with a failed check carries the dump once, and expectPassed shows it after the failures', async () => {
    let dumps = 0;
    const dump = async () => {
      dumps += 1;
      return '=== the cluster dump';
    };
    const failed = await checks(
      'a scenario',
      'claude',
      async (record) => {
        record.equal('c is 3', 2, 3);
      },
      dump,
    );
    expect([failed.dump, dumps]).toEqual(['=== the cluster dump', 1]);
    expect(() => expectPassed(failed)).toThrow(/- c is 3: expected 3, got 2\n=== the cluster dump$/);
    const passed = await checks(
      'a scenario',
      'claude',
      async (record) => {
        record.check('a holds', true, 'it held');
      },
      dump,
    );
    expect([passed.dump, dumps]).toEqual([null, 1]);
    // A body that threw has the dump in its error already.
    const stopped = await checks('a scenario', 'claude', async () => Promise.reject(new Error('timed out')), dump);
    expect([stopped.dump, dumps]).toEqual([null, 1]);
  });

  test('a body that throws keeps the checks made and fails the run with the error', async () => {
    const result = await checks('a scenario', 'codex', async (record) => {
      record.check('a holds', true, 'it held');
      throw new Error('timed out waiting for b');
    });
    expect(result.checks.map((check) => [check.name, check.passed])).toEqual([
      ['a holds', true],
      [RAN_TO_END, false],
    ]);
    expect(result.checks[1]?.detail).toContain('timed out waiting for b');
    expect(result.passed).toBe(false);
  });

  test('expectPassed fails with the details of the failed checks, and of named checks never made', async () => {
    const result = await checks('a scenario', 'claude', async (record) => {
      record.check('a holds', true, 'it held');
      record.equal('c is 3', 2, 3);
      throw new Error('timed out waiting for d');
    });
    expect(() => expectPassed(result, ['a holds'])).not.toThrow();
    const failed = /a scenario \(claude\): 2 check\(s\) failed\n- c is 3: expected 3, got 2\n- the scenario ran to its end: /;
    expect(() => expectPassed(result)).toThrow(failed);
    expect(() => expectPassed(result)).toThrow(/timed out waiting for d/);
    expect(() => expectPassed(result, ['a holds', 'd holds'])).toThrow(
      /- d holds: not checked; the run stopped early: .*timed out waiting for d/,
    );
  });
});

describe('a clone file', () => {
  test('is read when regular, named when a link or another kind of file, and null when missing', async () => {
    const clone = mkdtempSync(join(tmpdir(), 'agflow-clone-file-'));
    try {
      writeFileSync(join(clone, 'a.txt'), 'a\n');
      writeFileSync(join(clone, 'big.txt'), 'x'.repeat(100 * 1024));
      symlinkSync(join(clone, 'a.txt'), join(clone, 'b.txt'));
      expect(Bun.spawnSync(['mkfifo', join(clone, 'fifo')]).exitCode).toBe(0);
      expect(cloneFile(clone, 'a.txt')).toBe('a\n');
      expect(cloneFile(clone, 'big.txt')?.length).toBe(64 * 1024);
      expect(cloneFile(clone, 'b.txt')).toBe(`symlink to ${join(clone, 'a.txt')}`);
      expect(cloneFile(clone, 'fifo')).toBe('not a regular file');
      expect(cloneFile(clone, 'c.txt')).toBeNull();
    } finally {
      rmSync(clone, { recursive: true, force: true });
    }
  });
});

describeE2e('exit scenario 1: a killed agent', () => {
  for (const vendor of e2eVendors()) {
    describe(vendor, () => {
      let started: Cluster | null = null;
      let ran: ScenarioResult | null = null;
      const cluster = (): Cluster => {
        if (started === null) throw new Error('the cluster did not start');
        return started;
      };
      const result = (): ScenarioResult => {
        if (ran === null) throw new Error('the scenario did not run');
        return ran;
      };
      const passed = (names: readonly string[]) => cluster().step(async () => expectPassed(result(), names));
      const named = KILLED_AGENT.checks;

      beforeAll(async () => {
        started = await startCluster({ vendor });
        // A step, so a run that outlives the hook keeps the cluster's files.
        const cluster = started;
        ran = await cluster.step(() => killedAgent(cluster));
      });

      afterAll(async () => {
        await started?.close();
      });

      test("a1 ends crashed (infra); origin's final WIP is the hub's, with a.txt committed and b.txt snapshotted", () =>
        passed([named.crashed, named.finalWip, named.committed, named.snapshot, named.ownNote]));

      test('when the hub records a1 ended, no process has its cwd in its clone', () => passed([named.swept]));

      test("a2 runs on another runner from a1's final WIP; its clone holds a.txt and b.txt before a2 acts", () =>
        passed([named.otherRunner, named.startSha, named.cloneFiles]));

      test("a2's first request quotes a1's handoff note, and its first text is its restatement", () =>
        passed([named.brief, named.restatement]));

      test('a2 submits a.txt, b.txt and c.txt, and the person accepts the task', () =>
        passed([named.submitted, named.accepted, RAN_TO_END]));

      test('every check passed', () => passed(result().checks.map((check) => check.name)));
    });
  }
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `bun test packages/testkit/e2e/killed-agent.e2e.test.ts`
Expected: FAIL — `error: Cannot find module '../src/scenarios/killed-agent' from '.../packages/testkit/e2e/killed-agent.e2e.test.ts'`.

- [ ] **Step 3: Implement**

**File:** `packages/testkit/src/scenarios/killed-agent.ts` (new)

```ts
// Exit scenario 1, the killed agent (design 1, 6.8, 7.4, X-15). A worker commits a.txt, writes its handoff note, leaves
// b.txt uncommitted and runs a long command; the harness then SIGKILLs the agent's process group. The runner must kill
// what is left of the attempt and sweep the clone, then harvest and push the final WIP, all before it reports the
// exit. The hub ends the attempt crashed (infra) and starts a successor on another runner from that WIP and that note,
// and the successor finishes the task. The driver waits only on what it can observe, so a live run reuses it with a
// real model that follows the task's written steps.
import { type Attempt, attemptId, type NewTaskInput, quoteLines } from '@agflow/core';
import { fileAt, gitIn, refSha } from '../git-fixtures';
import type { Cluster } from '../harness/cluster';
import { BASH_MAX_TIMEOUT_MS, gate, type Programs, say, shell, tool } from '../harness/playbook';
import { processesInDir } from '../harness/proc';
import {
  checks,
  cloneFile,
  firstRequestText,
  notesOf,
  type Recorder,
  type ScenarioOptions,
  type ScenarioResult,
  SNAPSHOT_SUBJECT,
  shown,
  waitAtGate,
} from './result';

/** The command a1 is inside when it is killed; it would run for 10 minutes. */
const LONG_COMMAND = 'sleep 600';

/** What a1's handoff note says, word for word in a scripted run. */
const HANDOFF = 'a.txt is committed. b.txt is written but not committed yet. Next: add c.txt, commit, and submit.';

/** a2's first text, which the hub stores as its restatement. */
const RESTATEMENT = 'a.txt is committed and b.txt is written. My next step is to add c.txt, commit, and submit.';

/** The gate a2 waits at before it changes anything, while the driver reads its clone. */
const CHECKED = 'checked';

const TASK: NewTaskInput = {
  title: 'Add a.txt, b.txt and c.txt',
  objective: [
    "This task tests agflow's recovery from a killed agent. Follow these steps exactly, in your task branch.",
    'If your brief has no handoff note from a previous attempt:',
    '1. Create a.txt holding the line "a" and commit it.',
    `2. Call write_handoff with this task's id and the note: ${HANDOFF}`,
    '3. Create b.txt holding the line "b". Do not commit it.',
    `4. Run \`${LONG_COMMAND}\` in the foreground with a 10-minute timeout and wait for it. agflow stops you ` +
      'during it.',
    'If your brief has a handoff note: first restate the state of the work and your next step, as your first prompt ' +
      'asks. Then create c.txt holding the line "c", commit b.txt and c.txt, and submit.',
  ].join('\n'),
  acceptance: [{ id: 'files', assertion: 'a.txt, b.txt and c.txt hold the lines a, b and c' }],
};

/** The checks killedAgent makes, by name; the e2e test reads them in groups. */
const CHECKS = {
  crashed: 'a1 ends crashed, class infra',
  finalWip: "a1's final WIP ref on origin equals the hub's wipSha",
  committed: 'the final WIP holds a.txt from a commit under the snapshot',
  snapshot: 'the final WIP holds b.txt from the uncommitted-work snapshot',
  ownNote: "a1's own handoff note stands, so the hub assembled none",
  swept: 'when the hub records a1 ended, no process has its cwd in its clone',
  otherRunner: 'a2 runs on another runner than a1',
  startSha: "a2 starts from a1's final WIP",
  cloneFiles: "a2's clone holds a.txt and b.txt before a2 changes anything",
  brief: "a2's first model request quotes a1's handoff note",
  restatement: "a2's first text is stored as a restatement note of a2",
  submitted: 'a2 submits a branch holding a.txt, b.txt and c.txt',
  accepted: 'the person accepts the task, and a2 ends accepted',
} as const;

function programs(taskId: string): Programs {
  return {
    [attemptId(taskId, 1, 1)]: {
      steps: [
        say(
          'I add a.txt and commit it.',
          shell("printf 'a\\n' > a.txt && git add a.txt && git commit -q -m 'Add a.txt'"),
        ),
        say('I write my handoff note.', tool('write_handoff', { task_id: taskId, note: HANDOFF })),
        say('I start b.txt and leave it uncommitted for now.', shell("printf 'b\\n' > b.txt")),
        say('I run the long command.', shell(LONG_COMMAND, { timeoutMs: BASH_MAX_TIMEOUT_MS })),
      ],
    },
    [attemptId(taskId, 2, 1)]: {
      steps: [
        say(RESTATEMENT, gate(CHECKED)),
        say(
          'I add c.txt and commit b.txt and c.txt.',
          shell("printf 'c\\n' > c.txt && git add b.txt c.txt && git commit -q -m 'Add b.txt and c.txt'"),
        ),
        say(
          'I submit the task.',
          tool('submit', { task_id: taskId, summary: 'a.txt, b.txt and c.txt hold the lines a, b and c.' }),
        ),
      ],
    },
  };
}

/** The task for live runs, the programs for scripted runs, and the names of the checks. */
export const KILLED_AGENT = {
  scenario: 'killed agent',
  task: TASK,
  handoff: HANDOFF,
  longCommand: LONG_COMMAND,
  programs,
  checks: CHECKS,
} as const;

/** Runs exit scenario 1 in the cluster and gives every check it made. */
export function killedAgent(cluster: Cluster, options: ScenarioOptions = {}): Promise<ScenarioResult> {
  return checks(KILLED_AGENT.scenario, cluster.vendor, (record) => drive(cluster, options, record), cluster.dump);
}

async function drive(cluster: Cluster, options: ScenarioOptions, record: Recorder): Promise<void> {
  const { person, origin, models, waitFor, waitForEvent } = cluster;
  const scripted = options.scripted !== false;
  const [task] = await person.createTasks([TASK]);
  if (!task) throw new Error('the hub created no task');
  const taskId = task.id;
  const a1 = attemptId(taskId, 1, 1);
  const a2 = attemptId(taskId, 2, 1);
  if (scripted) models.addPrograms(programs(taskId));

  // a1 committed a.txt, wrote its note, left b.txt and is inside the long command.
  await waitForEvent({ type: 'attempt.running', subject: taskId, attemptId: a1 });
  const runner1 = await cluster.runnerOf(a1);
  const clone1 = runner1.clonePath(a1);
  await waitFor(`${a1}'s handoff note`, async () => (await notesOf(cluster, taskId, 'handoff', a1)).length > 0);
  await waitFor(`b.txt in ${a1}'s clone`, async () => cloneFile(clone1, 'b.txt') !== null);
  await waitFor(`${LONG_COMMAND} in ${a1}'s clone`, async () =>
    (await processesInDir(clone1)).some((row) => row.command.includes(LONG_COMMAND)),
  );

  const agent = await runner1.killAgent(a1);
  const ended = await waitForEvent({ type: 'attempt.ended', subject: taskId, attemptId: a1 });
  // Read at once: the runner must have killed and swept before the harvest that the exit report follows.
  const left = await processesInDir(clone1);
  record.check(
    CHECKS.swept,
    left.length === 0,
    left.length === 0
      ? `agent ${agent.pid} killed; nothing ran in ${clone1} at event #${ended.id}`
      : left.map((row) => `${row.pid} ${row.command}`).join('; '),
  );
  const attempt1 = (await person.attempt(a1)).attempt;
  record.equal(CHECKS.crashed, [attempt1.endReason, attempt1.failureClass], ['crashed', 'infra']);
  await checkFinalWip(cluster, attempt1, record);
  // Every handoff note is a1's own; an agent may write more than one, but none may be the hub's.
  const ownNotes = (await person.task(taskId)).notes.filter((note) => note.kind === 'handoff');
  record.check(
    CHECKS.ownNote,
    ownNotes.length > 0 &&
      ownNotes.every((note) => note.author === `agent:${attempt1.agentId}` && note.attemptId === a1),
    ownNotes.map((note) => `${note.author} in ${note.attemptId}: ${shown(note.body)}`).join('; ') || 'no handoff note',
  );

  // The successor: another runner, a1's final WIP, and a1's note in its brief.
  await waitForEvent({ type: 'attempt.running', subject: taskId, attemptId: a2 });
  const attempt2 = (await person.attempt(a2)).attempt;
  const runner2 = await cluster.runnerOf(a2);
  record.check(
    CHECKS.otherRunner,
    attempt2.runnerId !== null && attempt2.runnerId !== attempt1.runnerId,
    `a1 on ${runner1.name} (${attempt1.runnerId}), a2 on ${runner2.name} (${attempt2.runnerId})`,
  );
  record.equal(CHECKS.startSha, attempt2.startSha, attempt1.wipSha);
  await waitAtGate(cluster, a2, CHECKED, options);
  const clone2 = runner2.clonePath(a2);
  record.equal(
    CHECKS.cloneFiles,
    { a: cloneFile(clone2, 'a.txt'), b: cloneFile(clone2, 'b.txt') },
    { a: 'a\n', b: 'b\n' },
  );
  // Real models have no gate, and the harness must not write into a clone the agent shapes: openGate follows links.
  if (scripted) await cluster.openGate(a2, CHECKED);
  if (scripted) {
    const [note] = await notesOf(cluster, taskId, 'handoff', a1);
    const first = firstRequestText(cluster, a2) ?? '';
    const source = `${note?.author} wrote this handoff note in attempt ${a1}:`;
    const quoted = quoteLines(note?.body ?? HANDOFF);
    record.check(
      CHECKS.brief,
      first.includes(`${source}\n${quoted}`),
      first === '' ? 'a2 sent no model request' : `looked for ${shown(`${source}\n${quoted}`)}`,
    );
  }
  const [restatement] = await waitFor(`${a2}'s restatement`, async () => {
    const found = await notesOf(cluster, taskId, 'restatement', a2);
    return found.length > 0 ? found : null;
  });
  record.check(
    CHECKS.restatement,
    restatement?.author === `agent:${attempt2.agentId}` &&
      (scripted ? restatement.body.includes(RESTATEMENT) : restatement.body.trim() !== ''),
    `${restatement?.author}: ${shown(restatement?.body)}`,
  );

  // a2 finishes, and the person accepts.
  const submitted = await waitForEvent({ type: 'submission.recorded', subject: taskId, attemptId: a2 });
  const branch = String(submitted.data.branch);
  const head = await refSha(origin.path, `refs/heads/${branch}`);
  const files = {
    head,
    a: head && (await fileAt(origin.path, head, 'a.txt')),
    b: head && (await fileAt(origin.path, head, 'b.txt')),
    c: head && (await fileAt(origin.path, head, 'c.txt')),
  };
  record.equal(CHECKS.submitted, files, { head: submitted.data.headSha, a: 'a\n', b: 'b\n', c: 'c\n' });
  await person.accept(taskId);
  await waitForEvent({ type: 'attempt.ended', subject: taskId, attemptId: a2 });
  const accepted = { task: (await person.task(taskId)).task.status, a2: (await person.attempt(a2)).attempt.endReason };
  record.equal(CHECKS.accepted, accepted, { task: 'accepted', a2: 'accepted' });
}

/** a1's final WIP: origin's WIP ref at the hub's wipSha, a snapshot of b.txt over the commit of a.txt. */
async function checkFinalWip(cluster: Cluster, attempt: Attempt, record: Recorder): Promise<void> {
  const repo = cluster.origin.path;
  const sha = attempt.wipSha;
  const onOrigin = attempt.wipRef === null ? null : await refSha(repo, attempt.wipRef);
  record.check(
    CHECKS.finalWip,
    sha !== null && onOrigin === sha,
    `hub ${attempt.wipRef ?? 'no WIP ref'} at ${sha}, origin at ${onOrigin}`,
  );
  if (sha === null) return;
  const subject = (await gitIn(repo, ['log', '-1', '--format=%s', sha])).trim();
  const below = `${sha}^`;
  record.equal(
    CHECKS.committed,
    { a: await fileAt(repo, below, 'a.txt'), b: await fileAt(repo, below, 'b.txt') },
    { a: 'a\n', b: null },
  );
  record.check(
    CHECKS.snapshot,
    subject.startsWith(SNAPSHOT_SUBJECT) && (await fileAt(repo, sha, 'b.txt')) === 'b\n',
    `${sha} is ${shown(subject)} with b.txt ${shown(await fileAt(repo, sha, 'b.txt'))}`,
  );
}
```

**File:** `packages/testkit/src/scenarios/result.ts` (new)

```ts
// What every scenario driver shares (design 1, 15): its options, the checks it records and the result it returns.
// A driver acts only on what it can observe (the hub API, origin, clone files, processes and, with scripted models,
// the requests they saw), so the e2e tests and the live run read the same verdicts. A check never throws: the driver
// records it and goes on. A step that cannot go on, such as a wait that timed out, ends the run with one failed check
// that carries the error, the cluster dump included; a run whose checks failed without stopping carries the dump on its
// result.
import { closeSync, constants, fstatSync, lstatSync, openSync, readlinkSync, readSync } from 'node:fs';
import { join } from 'node:path';
import type { TaskNote, Vendor } from '@agflow/core';
import type { Cluster } from '../harness/cluster';

export interface Check {
  /** What must hold, as a sentence. */
  name: string;
  passed: boolean;
  /** What the driver saw. */
  detail: string;
}

export interface ScenarioResult {
  scenario: string;
  vendor: Vendor;
  /** Every check in the order the driver made it. */
  checks: Check[];
  /** Whether every check passed. */
  passed: boolean;
  /**
   * The cluster's dump when a check failed and the run went on to its end; null otherwise. A run that stopped early
   * has the dump in its RAN_TO_END detail already.
   */
  dump: string | null;
}

export interface ScenarioOptions {
  /**
   * Whether the cluster's models are the scripted servers (true by default): the driver then registers the scenario's
   * programs, waits at their gates and checks what the models were shown. A live run with real models passes false.
   */
  scripted?: boolean;
}

/** The check a run that stopped early fails, with the error that stopped it. */
export const RAN_TO_END = 'the scenario ran to its end';

/** How the uncommitted-work snapshot's commit message starts (M2b's harvest, design 7.3). */
export const SNAPSHOT_SUBJECT = 'agflow: uncommitted work at ';

/** Records a scenario's checks. */
export interface Recorder {
  /** Records a check; gives whether it passed. */
  check(name: string, passed: boolean, detail: string): boolean;
  /** Records that actual deep-equals expected; the detail shows what was seen. */
  equal(name: string, actual: unknown, expected: unknown): boolean;
}

/** A value as one line of a detail. */
export function shown(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === undefined) return 'undefined';
  return JSON.stringify(value) ?? String(value);
}

/**
 * Runs a scenario's body with a recorder and gives every check it made. A body that throws ends the run with a
 * failed RAN_TO_END check that carries the error; the checks before it stand. A body that ends with failed checks
 * gets dump's output on its result, taken once at the end.
 */
export async function checks(
  scenario: string,
  vendor: Vendor,
  body: (record: Recorder) => Promise<void>,
  dump?: () => Promise<string>,
): Promise<ScenarioResult> {
  const recorded: Check[] = [];
  const recorder: Recorder = {
    check(name, passed, detail) {
      recorded.push({ name, passed, detail });
      return passed;
    },
    equal(name, actual, expected) {
      const passed = Bun.deepEquals(actual, expected);
      const detail = passed ? shown(actual) : `expected ${shown(expected)}, got ${shown(actual)}`;
      return recorder.check(name, passed, detail);
    },
  };
  let ranToEnd = false;
  try {
    await body(recorder);
    ranToEnd = recorder.check(RAN_TO_END, true, `${recorded.length} checks made`);
  } catch (error) {
    recorder.check(RAN_TO_END, false, error instanceof Error ? (error.stack ?? error.message) : String(error));
  }
  const passed = recorded.every((check) => check.passed);
  let dumped: string | null = null;
  if (!passed && ranToEnd && dump) {
    dumped = await dump().catch((error) => `the dump failed: ${error instanceof Error ? error.message : error}`);
  }
  return { scenario, vendor, checks: recorded, passed, dump: dumped };
}

/**
 * Throws, and so fails the test, unless every check passed; with names, unless each named check was made and passed.
 * The error lists each failed or missing check with its detail; a missing one also gets RAN_TO_END's detail, which
 * says why the run stopped before it. The result's dump, when it has one, follows the list.
 */
export function expectPassed(result: ScenarioResult, names?: readonly string[]): void {
  const failures: string[] = [];
  const end = result.checks.find((check) => check.name === RAN_TO_END);
  const wanted = names ?? result.checks.map((check) => check.name);
  for (const name of wanted) {
    const made = result.checks.filter((check) => check.name === name);
    if (made.length === 0) {
      const why = end && !end.passed ? `; the run stopped early: ${end.detail}` : '';
      failures.push(`- ${name}: not checked${why}`);
      continue;
    }
    for (const check of made.filter((candidate) => !candidate.passed)) failures.push(`- ${name}: ${check.detail}`);
  }
  if (failures.length > 0) {
    const title = `${result.scenario} (${result.vendor}): ${failures.length} check(s) failed`;
    const dump = result.dump === null ? '' : `\n${result.dump}`;
    throw new Error(`${title}\n${failures.join('\n')}${dump}`);
  }
}

// --- Driver steps the scenarios share ------------------------------------------------------------------------------

/** The id of the hub's newest event, so a wait counts only what happens after it; 0 on an empty hub. */
export async function newestEventId(cluster: Cluster): Promise<number> {
  return (await cluster.person.events({ latest: true, limit: 1 }))[0]?.id ?? 0;
}

/**
 * With scripted models, waits until the attempt's program has answered with the gate's step, so the agent now waits
 * for it; with real models there is no gate, and this returns at once.
 */
export async function waitAtGate(
  cluster: Cluster,
  attemptId: string,
  gate: string,
  options: ScenarioOptions,
): Promise<void> {
  if (options.scripted === false) return;
  await cluster.waitFor(`${attemptId} to wait at its gate ${gate}`, async () =>
    cluster.models
      .requestsFor(attemptId)
      .some(({ answer }) => answer?.kind === 'step' && answer.step.kind === 'shell' && answer.step.gate === gate),
  );
}

/** How much of a clone's file cloneFile reads. */
const CLONE_FILE_MAX_BYTES = 64 * 1024;

/**
 * A file of a clone, or null when it has none. The harness reads outside any sandbox with the owner's rights, and in
 * a live run the agent shapes the clone: a link is shown as one and never followed, anything else that is not a
 * regular file (a FIFO would block the read) is only named, and a regular file is read up to 64 KB.
 */
export function cloneFile(clone: string, path: string): string | null {
  const file = join(clone, path);
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (stat === undefined) return null;
  if (stat.isSymbolicLink()) return `symlink to ${readlinkSync(file)}`;
  if (!stat.isFile()) return 'not a regular file';
  // Opened without following a link or waiting on a FIFO, and checked again: the clone may change in between.
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) return 'not a regular file';
    const buffer = Buffer.alloc(Math.min(opened.size, CLONE_FILE_MAX_BYTES));
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, read).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/** The task's notes of a kind that belong to the attempt, oldest first. */
export async function notesOf(
  cluster: Cluster,
  taskId: string,
  kind: TaskNote['kind'],
  attemptId: string,
): Promise<TaskNote[]> {
  const { notes } = await cluster.person.task(taskId);
  return notes.filter((note) => note.kind === kind && note.attemptId === attemptId);
}

/** The text of the attempt's first model request, or null before it sent one. */
export function firstRequestText(cluster: Cluster, attemptId: string): string | null {
  return cluster.models.requestsFor(attemptId)[0]?.text ?? null;
}
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `bun test packages/testkit/e2e/killed-agent.e2e.test.ts && AGFLOW_E2E=1 caffeinate -i bun test --timeout 600000 packages/testkit/e2e/killed-agent.e2e.test.ts && bun run typecheck`
Expected: all selected tests pass (0 fail); tsc exits 0; the gated cases run for both vendors against scripted servers.

The plain command runs result/helper tests and loads the new driver; the pass command additionally exercises both real CLIs against scripted servers. result.ts owns SNAPSHOT_SUBJECT, bounded no-follow cloneFile reads and failure dumps. The driver checks a1’s own note, the snapshot parent and all three final files, and opens gates only when scripted. All checks run inside cluster.step so failed and timed-out runs keep evidence. The old report’s gate fix belongs to Task 2 in the final history. See Decisions 43–45.

- [ ] **Step 5: Commit**

```bash
git add -A 'packages/testkit/e2e/killed-agent.e2e.test.ts' 'packages/testkit/src/scenarios/killed-agent.ts' 'packages/testkit/src/scenarios/result.ts'
git commit -m 'M2G Task 7: Exit scenario 1: killed agent' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

### Task 8: Exit scenario 2: closed laptop

Design exit criterion 2. A worker commits a.txt, then runs a command that keeps rewriting tick.txt. Once the hub has recorded a WIP, the harness freezes the runner and everything under it, as a closed lid does. When the lease expires, the attempt ends lost and the task goes stale, then ready with an assembled handoff note. A successor on another runner starts from the last pushed WIP. The harness then thaws the runner. After the clock gap it pushes no WIP until welcome (canPushWip, X-11); welcome.stop then makes it stop the agent without a handoff, push the late work to a late-work ref and report it (X-36). The hub records a late_work note and tells the successor, whose program merges that ref, so the final submission holds everything.

**Files:**
- Test: `packages/testkit/e2e/closed-laptop.e2e.test.ts`
- Create: `packages/testkit/src/scenarios/closed-laptop.ts`

- [ ] **Step 1: Write the failing test**

**File:** `packages/testkit/e2e/closed-laptop.e2e.test.ts` (new)

```ts
// Exit scenario 2, the closed laptop (design 1, 6.3, 6.4, 7.3, 7.9, X-11, X-36), per vendor in a fresh cluster: the
// driver runs once and each test reads its own checks. Runs only with AGFLOW_E2E=1.
import { afterAll, beforeAll, describe, setDefaultTimeout, test } from 'bun:test';
import { type Cluster, startCluster } from '../src/harness/cluster';
import { describeE2e, E2E_TEST_TIMEOUT_MS, e2eVendors } from '../src/harness/env';
import { CLOSED_LAPTOP, closedLaptop } from '../src/scenarios/closed-laptop';
import { expectPassed, RAN_TO_END, type ScenarioResult } from '../src/scenarios/result';

setDefaultTimeout(E2E_TEST_TIMEOUT_MS);

describeE2e('exit scenario 2: a closed laptop', () => {
  for (const vendor of e2eVendors()) {
    describe(vendor, () => {
      let started: Cluster | null = null;
      let ran: ScenarioResult | null = null;
      const cluster = (): Cluster => {
        if (started === null) throw new Error('the cluster did not start');
        return started;
      };
      const result = (): ScenarioResult => {
        if (ran === null) throw new Error('the scenario did not run');
        return ran;
      };
      const passed = (names: readonly string[]) => cluster().step(async () => expectPassed(result(), names));
      const named = CLOSED_LAPTOP.checks;

      beforeAll(async () => {
        started = await startCluster({ vendor });
        // A step, so a run that outlives the hook keeps the cluster's files.
        const cluster = started;
        ran = await cluster.step(() => closedLaptop(cluster));
      });

      afterAll(async () => {
        await started?.close();
      });

      test('frozen, the runner goes offline after deadLinkMs, and only the lease ends a1: lost (infra), no stall', () =>
        passed([named.offline, named.lost, named.notStalled]));

      test('the task went stale, then ready, with a note by system that quotes the work and says none was written', () =>
        passed([named.staleReady, named.assembled]));

      test("a2 starts on another runner from a1's last recorded WIP, and its brief holds the assembled note", () =>
        passed([named.otherRunner, named.startSha, named.brief]));

      test("after the thaw a1's agent is gone, its late work is on its late-work refs, and a late_work note names them", () =>
        passed([named.agentGone, named.lateWork, named.lateNote]));

      test('a2 receives the message that names the ref, merges it and submits everything', () =>
        passed([named.message, named.received, named.merged, named.accepted, RAN_TO_END]));

      test('every check passed', () => passed(result().checks.map((check) => check.name)));
    });
  }
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `bun test packages/testkit/e2e/closed-laptop.e2e.test.ts`
Expected: FAIL — `error: Cannot find module '../src/scenarios/closed-laptop' from '.../packages/testkit/e2e/closed-laptop.e2e.test.ts'`.

- [ ] **Step 3: Implement**

**File:** `packages/testkit/src/scenarios/closed-laptop.ts` (new)

```ts
// Exit scenario 2, the closed laptop (design 1, 6.3, 6.4, 7.3, 7.9, X-11, X-36). A worker commits a.txt, then runs a
// command that keeps rewriting tick.txt. Once the hub has recorded a WIP, the harness freezes the runner and everything
// under it, as a closed lid does. The hub marks the runner offline, ends the attempt lost when the lease runs out, and
// the task goes stale, then ready with an assembled handoff note; a successor on another runner starts from the last
// pushed WIP. The harness then thaws the runner: after its clock gap it pushes no WIP until welcome, whose stop makes
// it stop the agent without a handoff and push the late work to a late-work ref. The hub records a late_work note and
// tells the successor, which merges that ref, so the final submission holds everything.
import { existsSync } from 'node:fs';
import {
  attemptId,
  DEFAULT_WIP_REF_PREFIX,
  type HubEvent,
  lateWorkRef,
  type NewTaskInput,
  quoteLines,
  wipRef,
} from '@agflow/core';
import { processIdentity, sameProcess } from '@agflow/runner/src/processes';
import { loadConfig } from '../../../hub/src/config';
import { fileAt, gitIn, isAncestor, refSha } from '../git-fixtures';
import type { Cluster } from '../harness/cluster';
import { BASH_MAX_TIMEOUT_MS, gate, type Program, type Programs, say, shell, tool } from '../harness/playbook';
import { processesInDir } from '../harness/proc';
import {
  checks,
  cloneFile,
  firstRequestText,
  newestEventId,
  notesOf,
  type Recorder,
  type ScenarioOptions,
  type ScenarioResult,
  shown,
  waitAtGate,
} from './result';

/**
 * Rewrites tick.txt with a counter five times a second, for about 8 minutes. The counter keeps the work in the clone
 * changing right up to the freeze and again right after the thaw, so the work the runner pushes late always differs
 * from the last WIP it pushed in time. A perl one-liner, like the playbook's gates: Claude Code denies a shell loop
 * with expansions in a runner session.
 */
const TICK_COMMAND =
  `perl -e 'for my $n (1..2500) { open(my $f, ">", "tick.txt") or die "tick.txt: $!"; print $f "$n\\n"; close $f; ` +
  "select(undef, undef, undef, 0.2) }'";

/** a2's first text, which the hub stores as its restatement. */
const RESTATEMENT =
  'a.txt is committed and tick.txt is in the last WIP. My next step is to add c.txt, then merge the late work of the ' +
  'previous attempt and submit.';

/** The gate a2 waits at, after its own commit, until the driver has seen the late work recorded. */
const LATE_WORK = 'late-work';

/** How many times a2's merge fetches a late ref before it gives up: refresh_vault may still be fetching it. */
const FETCH_TRIES = 30;

/** How an assembled note closes when the attempt wrote none (design 6.8). */
const NO_NOTE = 'No handoff note was written; the next step is unknown.';

const TASK: NewTaskInput = {
  title: 'Add a.txt, tick.txt and c.txt',
  objective: [
    "This task tests agflow's recovery from a closed laptop. Follow these steps exactly, in your task branch.",
    'If your brief has no handoff note from a previous attempt:',
    '1. Create a.txt holding the line "a" and commit it.',
    `2. Run \`${TICK_COMMAND}\` in the foreground with a 10-minute timeout and wait for it. It keeps rewriting ` +
      'tick.txt, which you do not commit; agflow stops you during it.',
    'If your brief has a handoff note: first restate the state of the work and your next step, as your first prompt ' +
      'asks. Then create c.txt holding the line "c" and commit it. Then wait for agflow\'s message about late work ' +
      'of the previous attempt: run `sleep 60`, up to ten times, until it arrives. Merge that work as the message ' +
      "says, keeping the late work's tick.txt if the merge conflicts, and submit.",
  ].join('\n'),
  acceptance: [
    { id: 'files', assertion: 'a.txt and c.txt hold the lines a and c' },
    { id: 'late-work', assertion: "tick.txt is the previous attempt's late work" },
  ],
};

/** The checks closedLaptop makes, by name; the e2e test reads them in groups. */
const CHECKS = {
  offline: "the hub marks a1's frozen runner offline after deadLinkMs, while a1 is still open",
  lost: 'a1 ends lost, class infra, once the runner lease has run out',
  notStalled: 'while its runner was frozen, a1 got no stall or stop: only the lease ended it',
  staleReady: 'the task went stale, then ready',
  assembled: "a handoff note by system quotes a1's work and says no handoff note was written",
  otherRunner: 'a2 runs on another runner than a1',
  startSha: "a2 starts from a1's last recorded WIP",
  brief: "a2's brief holds the assembled note, quoted",
  agentGone: "after the thaw, a1's agent and its tick command are gone",
  lateWork:
    "origin holds a1's late work on its late-work refs from the first, with a.txt and tick.txt, and any late WIP " +
    'was harvested before the freeze (no WIP after the clock gap, X-11)',
  lateNote: 'a late_work note of a1 names each ref of its late work',
  message: "a2's agent gets the hub's message that names the late work's ref",
  received: "a2's model is shown the message that names the late work's ref",
  merged: "a2 submits a branch that merged the late work: a.txt, the late work's tick.txt and c.txt",
  accepted: 'the person accepts the task, and a2 ends accepted',
} as const;

/**
 * The command a2 runs to merge the late work: each ref fetched from the vault, retried each second while
 * refresh_vault may still be bringing it, then merged with conflicts resolved for the late work. Simple commands only,
 * which Claude Code can approve.
 */
function mergeCommand(refs: readonly string[]): string {
  const fetch =
    `perl -e 'for (1..${FETCH_TRIES}) { exit 0 if system("git", "fetch", "-q", "origin", $ARGV[0]) == 0; sleep 1 } ` +
    "exit 1'";
  return refs.map((ref) => `${fetch} '${ref}' && git merge -q --no-edit -X theirs FETCH_HEAD`).join(' && ');
}

/**
 * a2's program: its restatement with its own commit, the gate, then the merge of the late refs once the driver knows
 * them (it replaces the program while a2 waits at the gate), then the submission.
 */
function successorProgram(taskId: string, lateRefs: readonly string[]): Program {
  const merge = lateRefs.length === 0 ? [] : [say('I merge the late work.', shell(mergeCommand(lateRefs)))];
  return {
    steps: [
      say(RESTATEMENT, shell("printf 'c\\n' > c.txt && git add c.txt && git commit -q -m 'Add c.txt'")),
      gate(LATE_WORK),
      ...merge,
      say(
        'I submit the task.',
        tool('submit', { task_id: taskId, summary: "a.txt and c.txt are in, with the late work's tick.txt merged." }),
      ),
    ],
  };
}

function programs(taskId: string, lateRefs: readonly string[] = []): Programs {
  return {
    [attemptId(taskId, 1, 1)]: {
      steps: [
        say(
          'I add a.txt and commit it.',
          shell("printf 'a\\n' > a.txt && git add a.txt && git commit -q -m 'Add a.txt'"),
        ),
        say('I keep tick.txt current.', shell(TICK_COMMAND, { timeoutMs: BASH_MAX_TIMEOUT_MS })),
      ],
    },
    [attemptId(taskId, 2, 1)]: successorProgram(taskId, lateRefs),
  };
}

/** The task for live runs, the programs for scripted runs (a2's with the late refs to merge), and the check names. */
export const CLOSED_LAPTOP = {
  scenario: 'closed laptop',
  task: TASK,
  tickCommand: TICK_COMMAND,
  programs,
  checks: CHECKS,
} as const;

/**
 * The hub's liveness timings, as the hub itself loads them from the environment it was started with: its test
 * configuration overrides only the fields it names (X-27), and the rest keep the hub's own settings.
 */
function liveness(cluster: Cluster): { heartbeatMs: number; deadLinkMs: number; runnerLeaseMs: number } {
  const { config } = loadConfig(cluster.hub.env);
  return { heartbeatMs: config.heartbeatMs, deadLinkMs: config.deadLinkMs, runnerLeaseMs: config.runnerLeaseMs };
}

/**
 * Whether a text names the ref itself, not a longer ref it is a prefix of (the WIP ref of its late-work refs). A
 * full stop that ends a sentence may follow it.
 */
function namesRef(text: string, ref: string): boolean {
  const escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${escaped}(?![\\w/-]|\\.\\w)`).test(text);
}

/** The section of an assembled note that quotes the WIP's log: one paragraph, as quoted lines are never empty. */
function wipSection(body: string): string {
  return body.split('\n\n').find((part) => part.startsWith('## Commits on the WIP since main')) ?? '';
}

/** The task's events of a type about the attempt, oldest first. */
async function eventsOf(cluster: Cluster, taskId: string, type: string, attempt: string): Promise<HubEvent[]> {
  const events = await cluster.person.events({ subject: taskId, limit: 1000 });
  return events.filter((event) => event.type === type && event.data.attemptId === attempt);
}

/** Runs exit scenario 2 in the cluster and gives every check it made. */
export function closedLaptop(cluster: Cluster, options: ScenarioOptions = {}): Promise<ScenarioResult> {
  return checks(CLOSED_LAPTOP.scenario, cluster.vendor, (record) => drive(cluster, options, record), cluster.dump);
}

async function drive(cluster: Cluster, options: ScenarioOptions, record: Recorder): Promise<void> {
  const { person, origin, models, waitFor, waitForEvent } = cluster;
  const scripted = options.scripted !== false;
  const timings = liveness(cluster);
  const [task] = await person.createTasks([TASK]);
  if (!task) throw new Error('the hub created no task');
  const taskId = task.id;
  const a1 = attemptId(taskId, 1, 1);
  const a2 = attemptId(taskId, 2, 1);
  if (scripted) models.addPrograms(programs(taskId));

  // a1 committed a.txt and keeps rewriting tick.txt; the lid closes right after the hub records a WIP.
  await waitForEvent({ type: 'attempt.running', subject: taskId, attemptId: a1 });
  const runner1 = await cluster.runnerOf(a1);
  const clone1 = runner1.clonePath(a1);
  const runnerId1 = (await person.attempt(a1)).attempt.runnerId;
  if (runnerId1 === null) throw new Error(`${a1} runs on no runner`);
  await waitFor(`tick.txt in ${a1}'s clone`, async () => cloneFile(clone1, 'tick.txt') !== null);
  const agent1 = await runner1.agentOf(a1);
  const wip = await waitForEvent(
    { type: 'attempt.wip', subject: taskId, attemptId: a1 },
    { after: await newestEventId(cluster) },
  );
  const frozenAt = Date.now();
  await runner1.freeze();
  // Anything the runner harvests later than this, it harvested after the thaw.
  const frozenBy = Date.now();

  // The hub hears nothing: the runner goes offline, then the lease ends a1 lost and the task goes stale, then ready.
  const offline = await waitForEvent({ type: 'runner.offline', subject: runnerId1 }, { after: wip.id });
  const leaseWait = { after: wip.id, timeoutMs: timings.runnerLeaseMs + 120_000 };
  const ended = await waitForEvent({ type: 'attempt.ended', subject: taskId, attemptId: a1 }, leaseWait);
  const attempt1 = (await person.attempt(a1)).attempt;
  // The bounds leave room for heartbeat jitter but still tell the dead link from the lease.
  record.check(
    CHECKS.offline,
    offline.ts - frozenAt >= timings.deadLinkMs - 2 * timings.heartbeatMs && offline.id < ended.id,
    `offline ${offline.ts - frozenAt} ms after the freeze (event #${offline.id}); a1 ended at #${ended.id}`,
  );
  record.check(
    CHECKS.lost,
    attempt1.endReason === 'lost' &&
      attempt1.failureClass === 'infra' &&
      ended.ts - frozenAt >= timings.runnerLeaseMs - timings.deadLinkMs,
    `${attempt1.endReason} (${attempt1.failureClass}) ${ended.ts - frozenAt} ms after the freeze; ` +
      `the lease is ${timings.runnerLeaseMs} ms`,
  );
  // What the e2e timings let this observe: the hub neither stalls nor stops an attempt whose runner went quiet. The
  // freshness rule itself (stale facts never confirm a stall) needs timings that make a rule fire, so the hub's
  // supervisor tests cover it ('a suspicion is not confirmed by a heartbeat whose facts went stale').
  const stalls = [
    ...(await eventsOf(cluster, taskId, 'agent.stalled', a1)),
    ...(await eventsOf(cluster, taskId, 'agent.stopped', a1)),
  ];
  record.check(
    CHECKS.notStalled,
    stalls.length === 0 && attempt1.stopRequested === null,
    stalls.length === 0 && attempt1.stopRequested === null
      ? 'no stall event and no stop request'
      : `${stalls.map((event) => `${event.type} ${shown(event.data.cause)}`).join(', ')} ` +
          `stop ${shown(attempt1.stopRequested)}`,
  );
  const moves = (await person.events({ subject: taskId, after: wip.id, limit: 1000 }))
    .filter((event) => (event.type === 'task.stale' || event.type === 'task.ready') && event.data.attemptId === a1)
    .map((event) => event.type);
  record.equal(CHECKS.staleReady, moves, ['task.stale', 'task.ready']);
  const assembled = (await notesOf(cluster, taskId, 'handoff', a1)).filter((note) => note.author === 'system');
  const note = assembled.at(-1);
  const lastParagraph = note?.body.split('\n\n').at(-1) ?? '';
  // a1's work is quoted in the WIP log's section: the task's title and objective, quoted above it, name a.txt too.
  const wipLog = wipSection(note?.body ?? '');
  record.check(
    CHECKS.assembled,
    assembled.length === 1 && note !== undefined && /^> .*a\.txt/m.test(wipLog) && lastParagraph.startsWith(NO_NOTE),
    note === undefined
      ? 'no handoff note by system'
      : `${assembled.length} note(s); the WIP log ${shown(wipLog)}; the last ending ${shown(lastParagraph)}`,
  );

  // The successor: another runner, a1's last recorded WIP, the assembled note in its brief.
  await waitForEvent({ type: 'attempt.running', subject: taskId, attemptId: a2 });
  const attempt2 = (await person.attempt(a2)).attempt;
  const runner2 = await cluster.runnerOf(a2);
  record.check(
    CHECKS.otherRunner,
    attempt2.runnerId !== null && attempt2.runnerId !== attempt1.runnerId,
    `a1 on ${runner1.name} (${attempt1.runnerId}), a2 on ${runner2.name} (${attempt2.runnerId})`,
  );
  record.equal(CHECKS.startSha, attempt2.startSha, attempt1.wipSha);
  if (scripted && note !== undefined) {
    const first = firstRequestText(cluster, a2) ?? '';
    const start = note.body.split('\n').slice(0, 2).join('\n');
    const quoted = `system wrote this handoff note in attempt ${a1}:\n${quoteLines(start)}`;
    record.check(
      CHECKS.brief,
      first.includes(quoted),
      first === '' ? 'a2 sent no model request' : `looked for ${shown(quoted)}`,
    );
  }

  // The lid opens while a2 waits: welcome.stop stops a1's agent, and its late work goes to a late-work ref.
  await waitAtGate(cluster, a2, LATE_WORK, options);
  await runner1.thaw();
  const ownWipRef = wipRef(DEFAULT_WIP_REF_PREFIX, a1);
  const lateRefPattern = `${ownWipRef}-late-`;
  // The cleanup removes the clone only after the late-work push, so once it is gone every late push was made.
  const late = await waitFor(`${a1}'s late work, and its clone removed`, async () => {
    const found = await eventsOf(cluster, taskId, 'attempt.late_work', a1);
    const pushedLate = found.some((event) => String(event.data.ref).startsWith(lateRefPattern));
    return pushedLate && !existsSync(clone1) ? found : null;
  });
  const now = await processIdentity(agent1.pid);
  const left = await processesInDir(clone1);
  record.check(
    CHECKS.agentGone,
    (now === null || !sameProcess(now, agent1)) && left.length === 0,
    `agent ${agent1.pid} ${now !== null && sameProcess(now, agent1) ? 'still runs' : 'is gone'}; ` +
      `${left.length === 0 ? 'nothing runs' : left.map((row) => `${row.pid} ${row.command}`).join('; ')} in its clone`,
  );
  const lateRefs = late.map((event) => String(event.data.ref));
  const newest = late.at(-1) as HubEvent;
  const newestSha = String(newest.data.sha);
  await checkLateWork(cluster, { late, ownWipRef, a1, frozenBy }, record);
  const tick = await fileAt(origin.path, newestSha, 'tick.txt');
  const lateNotes = (await notesOf(cluster, taskId, 'late_work', a1)).filter((entry) => entry.author === 'system');
  record.check(
    CHECKS.lateNote,
    lateRefs.every((ref) => lateNotes.some((entry) => namesRef(entry.body, ref))),
    lateNotes.map((entry) => shown(entry.body)).join('; ') || 'no late_work note',
  );

  // a2 gets the message that names the ref, merges the late work and submits.
  const target = `agent:${attempt2.agentId}`;
  const ref = String(newest.data.ref);
  const message = await waitFor(`the late-work message to ${target}`, async () =>
    (await person.messages({ target })).find((entry) => entry.from === 'system' && namesRef(entry.body, ref)),
  );
  record.check(CHECKS.message, true, `#${message.id}: ${shown(message.body)}`);
  // Real models have no gate, and the harness must not write into a clone the agent shapes: openGate follows links.
  if (scripted) {
    models.addPrograms({ [a2]: successorProgram(taskId, lateRefs) });
    await cluster.openGate(a2, LATE_WORK);
  }
  const submitted = await waitForEvent({ type: 'submission.recorded', subject: taskId, attemptId: a2 });
  if (scripted) {
    const received = models.requestsFor(a2).some((request) => namesRef(request.text, ref));
    record.check(CHECKS.received, received, `looked for ${ref} in what a2 was shown`);
  }
  const head = await refSha(origin.path, `refs/heads/${String(submitted.data.branch)}`);
  const merged =
    head !== null &&
    (await Promise.all(late.map((event) => isAncestor(origin.path, String(event.data.sha), head)))).every(Boolean);
  const files = {
    head,
    merged,
    a: head && (await fileAt(origin.path, head, 'a.txt')),
    tick: head && (await fileAt(origin.path, head, 'tick.txt')),
    c: head && (await fileAt(origin.path, head, 'c.txt')),
  };
  record.equal(CHECKS.merged, files, { head: submitted.data.headSha, merged: true, a: 'a\n', tick, c: 'c\n' });
  await person.accept(taskId);
  await waitForEvent({ type: 'attempt.ended', subject: taskId, attemptId: a2 });
  const accepted = { task: (await person.task(taskId)).task.status, a2: (await person.attempt(a2)).attempt.endReason };
  record.equal(CHECKS.accepted, accepted, { task: 'accepted', a2: 'accepted' });
}

/**
 * a1's late work on origin: its late-work refs numbered from 1 in the order the hub recorded them, each on origin at
 * the recorded sha, the newest holding a.txt and tick.txt. A push that was in flight at the freeze lands late on the
 * WIP ref; it must have been harvested before the freeze, since after its clock gap the runner pushes no WIP until
 * welcome (X-11). The runner dates a snapshot with its harvest time.
 */
async function checkLateWork(
  cluster: Cluster,
  input: { late: HubEvent[]; ownWipRef: string; a1: string; frozenBy: number },
  record: Recorder,
): Promise<void> {
  const repo = cluster.origin.path;
  const { late, ownWipRef, a1, frozenBy } = input;
  const problems: string[] = [];
  const seen: string[] = [];
  let n = 0;
  for (const event of late) {
    const ref = String(event.data.ref);
    const sha = String(event.data.sha);
    const onOrigin = await refSha(repo, ref);
    if (onOrigin !== sha) problems.push(`${ref} is at ${onOrigin} on origin, not ${sha}`);
    if (ref === ownWipRef) {
      const harvested = Number((await gitIn(repo, ['log', '-1', '--format=%ct', sha])).trim());
      seen.push(`late WIP ${sha} harvested at ${harvested} s`);
      if (!(harvested <= Math.ceil(frozenBy / 1000))) {
        problems.push(`the late WIP ${sha} was harvested at ${harvested} s, after the freeze at ${frozenBy} ms`);
      }
      continue;
    }
    n += 1;
    seen.push(`${ref} at ${sha}`);
    const expected = lateWorkRef(DEFAULT_WIP_REF_PREFIX, a1, n);
    if (ref !== expected) problems.push(`late work #${n} is on ${ref}, not ${expected}`);
  }
  if (n === 0) problems.push('no late work on a late-work ref');
  const newest = String(late.at(-1)?.data.sha ?? '');
  const files = { a: await fileAt(repo, newest, 'a.txt'), tick: await fileAt(repo, newest, 'tick.txt') };
  if (files.a !== 'a\n' || files.tick === null) problems.push(`the newest late work holds ${shown(files)}`);
  record.check(CHECKS.lateWork, problems.length === 0, [...seen, ...problems].join('; '));
}
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `bun test packages/testkit/e2e/closed-laptop.e2e.test.ts && AGFLOW_E2E=1 caffeinate -i bun test --timeout 600000 packages/testkit/e2e/closed-laptop.e2e.test.ts && bun run typecheck`
Expected: all selected tests pass (0 fail); tsc exits 0; the gated cases run for both vendors against scripted servers.

The import failure is observable without enabling the gate; the pass command enables both vendors. Freeze after observed WIP, use the hub’s effective timings, and check assembled-note text in the WIP section. After thaw, match whole refs and require numbered late refs; a late WIP is permitted only with the pre-freeze timestamp bound. Register the merge after the actual late ref/message arrive; fetch retries and -X theirs preserve the late tick.txt. See Decisions 46–47.

- [ ] **Step 5: Commit**

```bash
git add -A 'packages/testkit/e2e/closed-laptop.e2e.test.ts' 'packages/testkit/src/scenarios/closed-laptop.ts'
git commit -m 'M2G Task 8: Exit scenario 2: closed laptop' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

### Task 9: Exit scenario 3: lost lead

Design exit criterion 3. With runner leads on, the scheduler seats a runner lead, whose program writes a lead handoff and goes idle. The harness freezes the lead's runner, and while it is frozen a person messages the lead. When the lease expires, the lead attempt ends lost and the seat empties. A new lead starts on another runner from that handoff, and it also receives the person's message, which the frozen lead never acknowledged. A worker then submits a task created after the failover, and the new lead accepts it.

**Files:**
- Test: `packages/testkit/e2e/lost-lead.e2e.test.ts`
- Create: `packages/testkit/src/scenarios/lost-lead.ts`

- [ ] **Step 1: Write the failing test**

**File:** `packages/testkit/e2e/lost-lead.e2e.test.ts` (new)

```ts
// Exit scenario 3, the lost lead (design 1, 6.5, 6.7, 6.11, 10), per vendor in a fresh cluster with runner leads on:
// the driver runs once and each test reads its own checks. Runs only with AGFLOW_E2E=1.
import { afterAll, beforeAll, describe, setDefaultTimeout, test } from 'bun:test';
import { type Cluster, startCluster } from '../src/harness/cluster';
import { describeE2e, E2E_TEST_TIMEOUT_MS, e2eVendors } from '../src/harness/env';
import { LOST_LEAD, lostLead } from '../src/scenarios/lost-lead';
import { expectPassed, RAN_TO_END, type ScenarioResult } from '../src/scenarios/result';

setDefaultTimeout(E2E_TEST_TIMEOUT_MS);

describeE2e('exit scenario 3: a lost lead', () => {
  for (const vendor of e2eVendors()) {
    describe(vendor, () => {
      let started: Cluster | null = null;
      let ran: ScenarioResult | null = null;
      const cluster = (): Cluster => {
        if (started === null) throw new Error('the cluster did not start');
        return started;
      };
      const result = (): ScenarioResult => {
        if (ran === null) throw new Error('the scenario did not run');
        return ran;
      };
      const passed = (names: readonly string[]) => cluster().step(async () => expectPassed(result(), names));
      const named = LOST_LEAD.checks;

      beforeAll(async () => {
        started = await startCluster({
          vendor,
          runnerLeads: true,
          goal: LOST_LEAD.goal,
          programs: LOST_LEAD.programs(),
        });
        // A step, so a run that outlives the hook keeps the cluster's files.
        const cluster = started;
        ran = await cluster.step(() => lostLead(cluster));
      });

      afterAll(async () => {
        await started?.close();
      });

      test('the scheduler seats lead-a1 on a runner, and GET /api/lead/notes lists its lead handoff', () =>
        passed([named.seated, named.handoff]));

      test('after the freeze, lead-a1 ends lost (infra) and the seat empties; lead-a2 is seated on another runner', () =>
        passed([named.lost, named.emptied, named.reseated]));

      test("lead-a2's brief quotes lead-a1's handoff, and the person's message sent during the freeze reaches lead-a2", () =>
        passed([named.brief, named.messageMoved, named.messageSeen]));

      test('a worker submits the task created after the failover, and lead-a2, woken by it, accepts it as itself', () =>
        passed([named.submitted, named.woken, named.accepted]));

      test("after the thaw, the old runner stops lead-a1's process and pushes no ref for it", () =>
        passed([named.oldStopped, named.noRefs, RAN_TO_END]));

      test('every check passed', () => passed(result().checks.map((check) => check.name)));
    });
  }
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `bun test packages/testkit/e2e/lost-lead.e2e.test.ts`
Expected: FAIL — `error: Cannot find module '../src/scenarios/lost-lead' from '.../packages/testkit/e2e/lost-lead.e2e.test.ts'` (0 pass, 1 fail; parent-tree check, 2026-11-11).

- [ ] **Step 3: Implement**

**File:** `packages/testkit/src/scenarios/lost-lead.ts` (new)

```ts
// Exit scenario 3, the lost lead (design 1, 6.5, 6.7, 6.11, 10). With runner leads on, the scheduler seats a runner
// lead, which writes a lead handoff and goes idle. The harness freezes the lead's runner, and while it is frozen a
// person messages the lead. When the lease runs out, the lead attempt ends lost and the seat empties; a new lead
// starts on another runner from that handoff and also receives the person's message, which the frozen lead never
// acknowledged. A worker then submits a task created after the failover, and the new lead accepts it. After the thaw
// the old runner stops the old lead's process and pushes nothing for it: leads have no WIP.
import { attemptId, type HubEvent, type LeadNote, leadAttemptId, type NewTaskInput, quoteLines } from '@agflow/core';
import { processIdentity, sameProcess } from '@agflow/runner/src/processes';
import { fileAt, gitIn, refSha } from '../git-fixtures';
import type { Cluster } from '../harness/cluster';
import { type Programs, react, say, shell, tool } from '../harness/playbook';
import {
  checks,
  firstRequestText,
  newestEventId,
  type Recorder,
  type ScenarioOptions,
  type ScenarioResult,
  shown,
} from './result';

/** The first lead's handoff, word for word in a scripted run. */
const LEAD_HANDOFF =
  'The plan: one small task at a time. Review each submission as it arrives, and accept it once its file is in. ' +
  'Nothing is waiting for review now.';

/** The second lead's first text, its restatement. */
const LEAD_RESTATEMENT =
  'The previous lead planned one small task at a time, and nothing waits for review. Next: review submissions as ' +
  'they arrive.';

/** What a person tells the lead while its runner is frozen; the next lead must receive it. */
const MESSAGE =
  'While your runner is away: accept the next submission once its file is in. (lost-lead message to the lead)';

/** The goal the cluster starts with: what a real lead follows in a live run. */
const GOAL = [
  "This project tests agflow's lead failover. As the lead, do only this:",
  '1. If your brief has no lead handoff from a previous lead, call write_handoff, without a task id, with the note: ' +
    `${LEAD_HANDOFF}`,
  '2. If it has one, restate the state of the project and your next step, as your first prompt asks.',
  '3. Create no tasks and staff nothing. When a task is submitted, accept it with accept_task once its file is in.',
].join('\n');

const TASK: NewTaskInput = {
  title: 'Add review.txt',
  objective: 'Create review.txt holding the line "review", commit it and submit.',
  acceptance: [{ id: 'file', assertion: 'review.txt holds the line review' }],
};

/** The checks lostLead makes, by name; the e2e test reads them in groups. */
const CHECKS = {
  seated: 'the scheduler seats lead-a1 on a runner, and GET /api/status shows a runner lead in the seat',
  handoff: 'GET /api/lead/notes lists the lead handoff of lead-a1',
  lost: 'after the freeze, lead-a1 ends lost, class infra',
  emptied: 'the seat empties when lead-a1 ends, and the next change seats lead-a2',
  reseated: 'lead-a2 takes the seat on another runner than lead-a1',
  brief: "lead-a2's brief quotes lead-a1's lead handoff",
  messageMoved:
    "the person's message sent during the freeze is delivered to lead-a2, and after the thaw still not to lead-a1",
  messageSeen: "lead-a2's model is shown the person's message",
  submitted: 'a worker submits the task created after the failover',
  woken: "the submission's message to the lead is delivered to lead-a2",
  accepted: "lead-a2 accepts the task with its agent token, as the acceptance event's actor, while it holds the seat",
  oldStopped: "after the thaw, the old runner stops lead-a1's process",
  noRefs: 'the old runner pushes no ref for lead-a1: leads have no WIP',
} as const;

/** The start of the hub's message to the lead about a submission of the task (design 6.13). */
function submittedMarker(taskId: string): string {
  return `${taskId} ("${TASK.title}") was submitted by`;
}

/**
 * The programs of a scripted run: both leads, and with the task's id the worker's and lead-a2's reaction to the
 * submission. lead-a1's must be known when the cluster starts, because the scheduler seats it as soon as the first
 * runner connects.
 */
function programs(taskId?: string): Programs {
  const lead2 = leadAttemptId(2, 1);
  const known: Programs = {
    [leadAttemptId(1, 1)]: {
      steps: [say('I write my lead handoff.', tool('write_handoff', { note: LEAD_HANDOFF }))],
    },
    [lead2]: { steps: [say(LEAD_RESTATEMENT, tool('get_lead_notes'))] },
  };
  if (taskId === undefined) return known;
  const accept = tool('accept_task', { id: taskId, note: 'review.txt is in.' });
  return {
    ...known,
    [lead2]: {
      steps: [say(LEAD_RESTATEMENT, tool('get_lead_notes'))],
      reactions: [react(submittedMarker(taskId), [say(`I accept ${taskId}.`, accept)])],
    },
    [attemptId(taskId, 1, 1)]: {
      steps: [
        say(
          'I add review.txt and commit it.',
          shell("printf 'review\\n' > review.txt && git add review.txt && git commit -q -m 'Add review.txt'"),
        ),
        say('I submit the task.', tool('submit', { task_id: taskId, summary: 'review.txt holds the line review.' })),
      ],
    },
  };
}

/**
 * The goal and task for live runs, the programs for scripted runs, and the check names. The cluster must start with
 * runner leads on, this goal and, for a scripted run, programs() (startCluster's runnerLeads, goal and programs).
 */
export const LOST_LEAD = {
  scenario: 'lost lead',
  goal: GOAL,
  task: TASK,
  handoff: LEAD_HANDOFF,
  message: MESSAGE,
  programs,
  checks: CHECKS,
} as const;

/** Runs exit scenario 3 in the cluster and gives every check it made. */
export function lostLead(cluster: Cluster, options: ScenarioOptions = {}): Promise<ScenarioResult> {
  return checks(LOST_LEAD.scenario, cluster.vendor, (record) => drive(cluster, options, record));
}

/** Every ref of the origin with its sha, one "<ref> <sha>" line each. */
async function originRefs(repo: string): Promise<string[]> {
  return (await gitIn(repo, ['for-each-ref', '--format=%(refname) %(objectname)'])).split('\n').filter(Boolean);
}

async function drive(cluster: Cluster, options: ScenarioOptions, record: Recorder): Promise<void> {
  const { person, origin, models, waitFor, waitForEvent } = cluster;
  const scripted = options.scripted !== false;
  if (!(await person.project()).runnerLeads) throw new Error('the lost lead needs a cluster with runner leads on');
  const lead1 = leadAttemptId(1, 1);
  const lead2 = leadAttemptId(2, 1);

  // lead-a1 takes the seat, writes its lead handoff and goes idle.
  const seated = await waitForEvent({ type: 'lead.seat_changed', data: { kind: 'runner', attemptId: lead1 } });
  const seat1 = (await person.status()).leadSeat;
  const attempt1 = (await person.attempt(lead1)).attempt;
  const runnerId1 = attempt1.runnerId;
  if (runnerId1 === null) throw new Error(`${lead1} runs on no runner`);
  record.check(
    CHECKS.seated,
    seat1.kind === 'runner' && seat1.attemptId === lead1 && seat1.runnerId === runnerId1,
    `event #${seated.id}; seat ${shown(seat1)}`,
  );
  const handoff = await waitFor(`${lead1}'s lead handoff`, async () =>
    (await person.leadNotes()).find((note) => note.kind === 'handoff' && note.attemptId === lead1),
  );
  record.check(
    CHECKS.handoff,
    handoff.author === `agent:${attempt1.agentId}` && (scripted ? handoff.body === LEAD_HANDOFF : handoff.body !== ''),
    `${handoff.author}: ${shown(handoff.body)}`,
  );
  await waitFor(`${lead1} to go idle`, async () => (await person.attempt(lead1)).attempt.phase === 'idle');
  const runner1 = await cluster.runnerOf(lead1);
  const agent1 = await runner1.agentOf(lead1);

  // The lid closes on the lead's runner, and a person messages the lead while it is away.
  const frozenAt = await newestEventId(cluster);
  await runner1.freeze();
  const message = await person.send({ to: 'lead', body: MESSAGE });
  // The lease runs out runnerLeaseMs after the freeze; the default wait covers it with room to spare.
  await waitForEvent({ type: 'attempt.ended', subject: lead1, attemptId: lead1 }, { after: frozenAt });
  const lost = (await person.attempt(lead1)).attempt;
  record.equal(CHECKS.lost, [lost.endReason, lost.failureClass], ['lost', 'infra']);

  // lead-a2 takes the seat elsewhere, from lead-a1's handoff, and gets the person's message.
  const reseated = await waitForEvent(
    { type: 'lead.seat_changed', data: { kind: 'runner', attemptId: lead2 } },
    { after: frozenAt },
  );
  const seatMovesSinceFreeze = (await person.events({ after: frozenAt, limit: 1000 }))
    .filter((event) => event.type === 'lead.seat_changed' && event.id <= reseated.id)
    .map((event) => [event.data.kind, event.data.attemptId]);
  record.equal(CHECKS.emptied, seatMovesSinceFreeze, [
    ['none', null],
    ['runner', lead2],
  ]);
  const attempt2 = (await person.attempt(lead2)).attempt;
  record.check(
    CHECKS.reseated,
    attempt2.runnerId !== null && attempt2.runnerId !== runnerId1 && reseated.data.runnerId === attempt2.runnerId,
    `lead-a1 on ${runnerId1}, lead-a2 on ${attempt2.runnerId} (event #${reseated.id})`,
  );
  if (scripted) {
    await waitFor(`${lead2}'s first model request`, async () => firstRequestText(cluster, lead2) !== null);
    checkBrief(cluster, lead2, handoff, record);
  }
  const target = `agent:${attempt2.agentId}`;
  // The frozen runner reports nothing, so lead-a1 cannot have a delivery yet: messageMoved is checked after the thaw.
  await waitFor(`the person's message to reach ${lead2}`, async () => {
    const found = (await person.messages({ target: 'lead' })).find((entry) => entry.id === message.id);
    return found?.deliveries.some((delivery) => delivery.agentId === attempt2.agentId) === true;
  });
  if (scripted) {
    await waitFor(`${lead2}'s model to be shown the message`, async () => models.sawText(lead2, MESSAGE));
    record.check(CHECKS.messageSeen, true, `${lead2} was shown ${shown(MESSAGE)}`);
  }

  // A task created now: a worker submits it, the delivery wakes lead-a2, and it accepts.
  const [task] = await person.createTasks([TASK]);
  if (!task) throw new Error('the hub created no task');
  const taskId = task.id;
  if (scripted) models.addPrograms(programs(taskId));
  const submitted = await waitForEvent({ type: 'submission.recorded', subject: taskId });
  const head = await refSha(origin.path, `refs/heads/${String(submitted.data.branch)}`);
  record.equal(
    CHECKS.submitted,
    { head, file: head && (await fileAt(origin.path, head, 'review.txt')) },
    { head: submitted.data.headSha, file: 'review\n' },
  );
  const accepted = await waitForEvent({ type: 'task.accepted', subject: taskId });
  const wake = (await person.messages({ taskId })).find(
    (entry) => entry.to === 'lead' && entry.body.startsWith(submittedMarker(taskId)),
  );
  record.check(
    CHECKS.woken,
    wake?.deliveries.some((delivery) => delivery.agentId === attempt2.agentId) === true,
    wake === undefined ? 'no submission message to the lead' : `#${wake.id} delivered to ${shown(wake.deliveries)}`,
  );
  const seatMoves = (await person.events({ after: reseated.id, limit: 1000 })).filter(
    (event) => event.type === 'lead.seat_changed' && event.id < accepted.id,
  );
  record.check(
    CHECKS.accepted,
    accepted.actor === target && seatMoves.length === 0 && (await person.task(taskId)).task.status === 'accepted',
    `accepted by ${accepted.actor} at #${accepted.id}; seat changes before it: ${seatMoves.length}`,
  );

  // The acceptance ends the worker's attempt, and its runner pushes any last WIP before it reports the exit; after
  // that report nothing else pushes.
  const worker = String(submitted.data.attemptId);
  await waitFor(`the exit report of ${worker}`, async () =>
    (await person.attempt(worker)).log.some((entry) => entry.summary.includes('after it ended')),
  );

  // The lid opens: welcome.stop names lead-a1, so the old runner stops its process and pushes nothing for it.
  const refsBefore = await originRefs(origin.path);
  const thawedAt = await newestEventId(cluster);
  await runner1.thaw();
  await waitForEvent({ type: 'runner.online', subject: runnerId1 }, { after: thawedAt });
  await waitFor(`${lead1}'s process to be stopped`, async () => {
    const now = await processIdentity(agent1.pid);
    return now === null || !sameProcess(now, agent1);
  });
  record.check(CHECKS.oldStopped, true, `agent ${agent1.pid} of ${lead1} is gone`);
  // The runner reports the stop after the old process exited: by then anything it pushed would be recorded.
  await waitFor(`the old runner's report on ${lead1}`, async () =>
    (await person.attempt(lead1)).log.some((entry) => entry.summary.includes('after it ended')),
  );
  const pushed = (await person.events({ subject: lead1, limit: 1000 })).filter(
    (event: HubEvent) => event.type === 'attempt.wip' || event.type === 'attempt.late_work',
  );
  // Nothing else pushes in this window (the task is accepted and lead-a2 has no WIP), so origin's refs must not move.
  const refsAfter = await originRefs(origin.path);
  const changed = refsAfter.filter((line) => !refsBefore.includes(line));
  const dropped = refsBefore.filter((line) => !refsAfter.includes(line));
  record.check(
    CHECKS.noRefs,
    pushed.length === 0 && changed.length === 0 && dropped.length === 0,
    `events ${pushed.map((event) => `${event.type} #${event.id}`).join(', ') || 'none'}; ` +
      `refs added or moved ${changed.join(', ') || 'none'}; refs gone ${dropped.join(', ') || 'none'}`,
  );
  // The old runner never injected the message from its old deliver command: lead-a1 has no delivery, and in a
  // scripted run its model never saw the message.
  const final = (await person.messages({ target: 'lead' })).find((entry) => entry.id === message.id);
  record.check(
    CHECKS.messageMoved,
    final !== undefined &&
      final.deliveries.some((delivery) => delivery.agentId === attempt2.agentId) &&
      final.deliveries.every((delivery) => delivery.agentId !== attempt1.agentId) &&
      (!scripted || !models.sawText(lead1, MESSAGE)),
    final === undefined
      ? `#${message.id} is gone`
      : `#${message.id} delivered to ${final.deliveries.map((delivery) => delivery.agentId).join(', ') || 'nobody'} ` +
          `(${target}); ${lead1}'s model saw it: ${models.sawText(lead1, MESSAGE)}`,
  );
}

/** lead-a2's first request quotes lead-a1's lead handoff under the line that names its author and attempt. */
function checkBrief(cluster: Cluster, lead2: string, handoff: LeadNote, record: Recorder): void {
  const first = firstRequestText(cluster, lead2) ?? '';
  const source = `${handoff.author} wrote this lead handoff in attempt ${handoff.attemptId}:`;
  const quoted = `${source}\n${quoteLines(handoff.body)}`;
  record.check(
    CHECKS.brief,
    first.includes(quoted),
    first === '' ? `${lead2} sent no model request` : `looked for ${shown(quoted)}`,
  );
}
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `bun test packages/testkit/e2e/lost-lead.e2e.test.ts && AGFLOW_E2E=1 caffeinate -i bun test --timeout 600000 packages/testkit/e2e/lost-lead.e2e.test.ts && bun run typecheck`
Expected: all selected tests pass (0 fail); tsc exits 0; the gated cases run for both vendors against scripted servers.

The parent-tree red check on 2026-11-11 copied only lost-lead.e2e.test.ts and failed on its missing driver. The historical first gated run also found a premature first-request read; the final driver waits for that request. Program the first lead before the first runner starts, use accept_task { id }, and check message routing again after thaw. Compare every origin ref/sha after the worker’s final exit report, not a heuristic for refs containing “lead”. lostLead in this prototype does not pass the optional dump callback to checks. See Decision 48.

- [ ] **Step 5: Commit**

```bash
git add -A 'packages/testkit/e2e/lost-lead.e2e.test.ts' 'packages/testkit/src/scenarios/lost-lead.ts'
git commit -m 'M2G Task 9: Exit scenario 3: lost lead' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

### Task 10: Runner restart: suspend and crash

A runner restart must not cost the attempt. On SIGTERM (a launchd restart, logout or upgrade) the runner suspends: it pushes WIP without a handoff turn, reports attempt.exited with cause suspend and exits 0. On the next hello the hub resumes the attempt with a new fence, and the agent's own session continues on the attempt's recorded CLI version (X-13). After a SIGKILL the agent may die with its pipes or keep running; either way the restarted runner kills the recorded groups whose identity still matches and sweeps the clone before hello, reports the attempt stopped, and the hub resumes it the same way. Each case runs in its own cluster, because a second runner-restart resume within resumeWindowMs ends the attempt crashed. The final task also extracts the shared sessionOf and callIdsIn readers into models.ts, with a unit test, for the restart, restore and take-over checks.

**Files:**
- Test: `packages/testkit/e2e/runner-restart.e2e.test.ts`
- Modify: `packages/testkit/src/harness/models.ts`
- Test: `packages/testkit/test/models.test.ts`

- [ ] **Step 1: Write the failing tests**

**File:** `packages/testkit/e2e/runner-restart.e2e.test.ts` (new)

```ts
// A runner restart must not cost the attempt (design 6.3, 6.4, 7.1, 7.4, 8.4, 9.4), per vendor. On SIGTERM the runner
// suspends: it pushes WIP without a handoff turn, reports the exit as a suspend and exits 0, and on its next hello the
// hub resumes the attempt at a new fence in the agent's own session. After a SIGKILL the restarted runner kills what
// is left of the attempt and sweeps its clone before hello, and the hub resumes it the same way. Each case runs in a
// cluster of its own: a second runner-restart resume within resumeWindowMs would end the attempt crashed. Runs only
// with AGFLOW_E2E=1.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { attemptId, DEFAULT_WIP_REF_PREFIX, type Fence, type NewTaskInput, wipRef } from '@agflow/core';
import { type ProcessIdentity, processIdentity, sameProcess } from '@agflow/runner/src/processes';
import { fileAt, isAncestor, refSha } from '../src/git-fixtures';
import { type Cluster, startCluster } from '../src/harness/cluster';
import { describeE2e, E2E_TEST_TIMEOUT_MS, e2eVendors } from '../src/harness/env';
import { callIdsIn, type RecordedRequest, sessionOf } from '../src/harness/models';
import { GATE_DIR, gate, type Program, say, shell, stepCallId, tool } from '../src/harness/playbook';
import { processesInDir } from '../src/harness/proc';
import type { RunnerProcess } from '../src/harness/runner-process';
import { cloneFile, newestEventId, waitAtGate } from '../src/scenarios/result';

setDefaultTimeout(E2E_TEST_TIMEOUT_MS);

const TASK: NewTaskInput = {
  title: 'Add a.txt, b.txt and c.txt across a runner restart',
  objective: 'Commit a.txt, write b.txt, and after the runner restarts commit b.txt and c.txt, then submit.',
  acceptance: [{ id: 'files', assertion: 'a.txt, b.txt and c.txt hold the lines a, b and c' }],
};

/**
 * The gate that holds a1 in a running command until its runner goes down. The restart interrupts it, and the
 * interrupted call has a result (an interrupted Bash call, an aborted exec cell), so after the resume the gate counts
 * as run and a1 goes on with step 3 at once.
 */
const RESTARTED = 'restarted';

/** What a reconciliation resume tells the agent (design 6.3, resume_attempt). */
const RESTART_PROMPT = 'the runner restarted; continue from your last step';

function program(taskId: string): Program {
  return {
    steps: [
      say(
        'I add a.txt and commit it.',
        shell("printf 'a\\n' > a.txt && git add a.txt && git commit -q -m 'Add a.txt'"),
      ),
      say('I start b.txt and leave it uncommitted for now.', shell("printf 'b\\n' > b.txt")),
      gate(RESTARTED),
      say(
        'I add c.txt and commit b.txt and c.txt.',
        shell("printf 'c\\n' > c.txt && git add b.txt c.txt && git commit -q -m 'Add b.txt and c.txt'"),
      ),
      say('I submit the task.', tool('submit', { task_id: taskId, summary: 'a.txt, b.txt and c.txt are in.' })),
    ],
  };
}

/** One attempt, waiting at its gate with a.txt committed and b.txt uncommitted. */
interface AtGate {
  taskId: string;
  a1: string;
  runner: RunnerProcess;
  clone: string;
  fence: Fence;
  /** The session (Claude) or thread (Codex) the agent's requests carried before the restart. */
  session: string;
  /** The newest event before the runner went down. */
  before: number;
}

async function startAtGate(cluster: Cluster): Promise<AtGate> {
  const { person, models, waitFor, waitForEvent } = cluster;
  const [task] = await person.createTasks([TASK]);
  if (!task) throw new Error('the hub created no task');
  const a1 = attemptId(task.id, 1, 1);
  models.addPrograms({ [a1]: program(task.id) });
  await waitForEvent({ type: 'attempt.running', subject: task.id, attemptId: a1 });
  await waitAtGate(cluster, a1, RESTARTED, {});
  const runner = await cluster.runnerOf(a1);
  const clone = runner.clonePath(a1);
  await waitFor(`b.txt in ${a1}'s clone`, async () => cloneFile(clone, 'b.txt') !== null);
  // The model's answer is not yet the command: the restart must find the gate running in the clone. For both vendors
  // the perl gate, and the shell that wraps it, carry the gate's file in their command lines.
  const gateFile = `${GATE_DIR}/${RESTARTED}`;
  await waitFor(`${a1}'s gate command in its clone`, async () =>
    (await processesInDir(clone)).some((row) => row.command.includes(gateFile)),
  );
  const { attempt } = await person.attempt(a1);
  const last = models.requestsFor(a1).at(-1);
  const session = last ? sessionOf(last) : null;
  // A resume checks for the same session or thread: without an id to compare, that check would prove nothing.
  if (session === null) throw new Error(`${a1}'s model requests carry no session or thread id`);
  return { taskId: task.id, a1, runner, clone, fence: attempt.fence, session, before: await newestEventId(cluster) };
}

/** After the runner is back: a1 resumes at a higher fence in the same session, and no second attempt starts. */
async function expectResumed(cluster: Cluster, at: AtGate): Promise<RecordedRequest> {
  const { models, waitFor, waitForEvent } = cluster;
  const match = { type: 'attempt.resumed', subject: at.taskId, attemptId: at.a1 };
  const resumed = await waitForEvent(match, { after: at.before });
  const fence = resumed.data.fence as Fence;
  expect(fence.epoch).toBe(at.fence.epoch);
  expect(fence.counter).toBeGreaterThan(at.fence.counter);
  expect((await cluster.person.attempt(at.a1)).attempt.fence.counter).toBeGreaterThanOrEqual(fence.counter);
  const restarted = await waitFor(`${at.a1}'s model to be told the runner restarted`, async () =>
    models.requestsFor(at.a1).find((request) => request.text.includes(RESTART_PROMPT)),
  );
  // The agent's own session goes on: the earlier steps are in its history, under the same session or thread.
  expect(callIdsIn(restarted)).toContain(stepCallId(1));
  expect(sessionOf(restarted)).toBe(at.session);
  expect((await cluster.attemptsOf(at.taskId)).map((attempt) => attempt.id)).toEqual([at.a1]);
  return restarted;
}

/** The resumed agent passes its gate and submits a branch with the work from before and after the restart. */
async function expectSubmitted(cluster: Cluster, at: AtGate): Promise<void> {
  const { origin, waitForEvent } = cluster;
  // The resumed agent counts the interrupted gate as run; opening it is only a safeguard for a CLI that runs it again.
  await cluster.openGate(at.a1, RESTARTED);
  const submitted = await waitForEvent({ type: 'submission.recorded', subject: at.taskId, attemptId: at.a1 });
  const head = await refSha(origin.path, `refs/heads/${String(submitted.data.branch)}`);
  expect(head).toBe(String(submitted.data.headSha));
  const files = await Promise.all(['a.txt', 'b.txt', 'c.txt'].map((file) => fileAt(origin.path, head ?? '', file)));
  expect(files).toEqual(['a\n', 'b\n', 'c\n']);
  expect((await cluster.attemptsOf(at.taskId)).map((attempt) => attempt.id)).toEqual([at.a1]);
}

describeE2e('runner restart', () => {
  for (const vendor of e2eVendors()) {
    describe(`${vendor}: SIGTERM suspends`, () => {
      let started: Cluster | null = null;
      let at: AtGate | null = null;
      /** The WIP the suspend pushed, which test 1 checked: the work from before the restart. */
      let suspendWip: string | null = null;
      const cluster = (): Cluster => {
        if (started === null) throw new Error('the cluster did not start');
        return started;
      };
      const atGate = (): AtGate => {
        if (at === null) throw new Error('the attempt never reached its gate');
        return at;
      };

      beforeAll(async () => {
        started = await startCluster({ vendor });
        const cluster = started;
        at = await cluster.step(() => startAtGate(cluster));
      });

      afterAll(async () => {
        await started?.close();
      });

      test("on SIGTERM the runner exits 0 within its suspend timing; origin's WIP holds both kinds of work; a1 stays open", () =>
        cluster().step(async () => {
          const { origin, person, models, waitForEvent } = cluster();
          const { runner, a1, clone } = atGate();
          const runnerId = (await person.attempt(a1)).attempt.runnerId ?? '';
          const ref = wipRef(DEFAULT_WIP_REF_PREFIX, a1);
          // A change the periodic WIP push cannot have seen yet, so only the suspend's own push can bring it.
          const seen = models.requestsFor(a1).length;
          const before = await refSha(origin.path, ref);
          writeFileSync(join(clone, 'suspend.txt'), 'suspend\n');
          const stopping = Date.now();
          await runner.stop();
          expect(runner.exitCode).toBe(0);
          expect(Date.now() - stopping).toBeLessThanOrEqual(runner.home.config.timings.suspend);
          // The suspend pushed WIP before it exited: a snapshot of b.txt and suspend.txt over the commit of a.txt.
          const sha = await refSha(origin.path, ref);
          expect(sha).not.toBeNull();
          expect(sha).not.toBe(before);
          expect(await fileAt(origin.path, sha ?? '', 'a.txt')).toBe('a\n');
          expect(await fileAt(origin.path, sha ?? '', 'b.txt')).toBe('b\n');
          expect(await fileAt(origin.path, sha ?? '', 'suspend.txt')).toBe('suspend\n');
          expect(await fileAt(origin.path, `${sha}^`, 'b.txt')).toBeNull();
          // Without a handoff turn: the model got no request while the runner suspended.
          expect(models.requestsFor(a1).length).toBe(seen);
          suspendWip = sha;
          // A submission needs a clean clone, and the agent commits only its own files: suspend.txt goes before the
          // runner starts again.
          rmSync(join(clone, 'suspend.txt'));
          // Once the hub has seen the runner go, a1 is still open: a suspend is not an ending.
          await waitForEvent({ type: 'runner.offline', subject: runnerId }, { after: atGate().before });
          const { attempt } = await person.attempt(a1);
          expect(attempt.status).not.toBe('ended');
          expect(attempt.wipSha).toBe(sha);
        }));

      test('after start, the hub resumes a1 at a higher fence with attempt.resumed and no second attempt; its model resumes the same session', () =>
        cluster().step(async () => {
          await atGate().runner.start();
          await expectResumed(cluster(), atGate());
        }));

      test('the resumed agent finishes and submits a branch with the work from before and after the restart', () =>
        cluster().step(async () => {
          const { origin } = cluster();
          if (suspendWip === null) throw new Error("the first test did not check the suspend's WIP");
          await expectSubmitted(cluster(), atGate());
          const branch = (await cluster().person.task(atGate().taskId)).task.branch ?? '';
          const head = await refSha(origin.path, `refs/heads/${branch}`);
          // The commit of a.txt under the suspend's WIP, from before the restart, is under the submitted head.
          expect(await isAncestor(origin.path, `${suspendWip}^`, head ?? '')).toBe(true);
        }));
    });

    describe(`${vendor}: SIGKILL crashes`, () => {
      let started: Cluster | null = null;
      const cluster = (): Cluster => {
        if (started === null) throw new Error('the cluster did not start');
        return started;
      };

      beforeAll(async () => {
        started = await startCluster({ vendor });
      });

      afterAll(async () => {
        await started?.close();
      });

      test("after SIGKILL of the runner alone and a start, nothing that ran in a1's clone survives the runner's return; a1 resumes and submits", () =>
        cluster().step(async () => {
          const at = await startAtGate(cluster());
          const { runner, clone, a1 } = at;
          // Each process of the attempt, by pid and start time: the agent, and whatever runs in the clone.
          const inClone = await processesInDir(clone);
          expect(inClone.length).toBeGreaterThan(0);
          const before: ProcessIdentity[] = [await runner.agentOf(a1), ...inClone];
          await runner.kill();
          await runner.start();
          const survivors: ProcessIdentity[] = [];
          for (const old of before) {
            const now = await processIdentity(old.pid);
            if (now !== null && sameProcess(now, old)) survivors.push(old);
          }
          expect(survivors).toEqual([]);
          await expectResumed(cluster(), at);
          await expectSubmitted(cluster(), at);
        }));
    });
  }
});
```

**File:** `packages/testkit/test/models.test.ts` (change)

```diff
diff --git a/packages/testkit/test/models.test.ts b/packages/testkit/test/models.test.ts
index 321b4d2e..1e9bd00f 100644
--- a/packages/testkit/test/models.test.ts
+++ b/packages/testkit/test/models.test.ts
@@ -3,7 +3,7 @@ import { claudeTestEnv } from '../src/anthropic/env';
 import { UNSCRIPTED_TEXT } from '../src/anthropic/server';
 import { DEFAULT_REPLY_TEXT } from '../src/codex/replies';
 import { codexTestConfig } from '../src/codex/test-config';
-import { type Models, startModels } from '../src/harness/models';
+import { callIdsIn, type Models, sessionOf, startModels } from '../src/harness/models';
 import { CLOSING_TEXT, type Program, type Programs, shell, tool } from '../src/harness/playbook';
 
 const started: Models[] = [];
@@ -25,10 +25,16 @@ type Block = Record<string, unknown>;
 type Message = { role: string; content: string | Block[] };
 
 /** A Claude main-loop request, sent as the CLI sends it (without streaming, to read the reply at once). */
-async function claude(target: Models, system: string, messages: Message[], tools = ['Bash']): Promise<Block> {
+async function claude(
+  target: Models,
+  system: string,
+  messages: Message[],
+  tools = ['Bash'],
+  headers: Record<string, string> = {},
+): Promise<Block> {
   const response = await fetch(`${target.anthropic.url}/v1/messages?beta=true`, {
     method: 'POST',
-    headers: { 'content-type': 'application/json', 'x-api-key': 'k' },
+    headers: { 'content-type': 'application/json', 'x-api-key': 'k', ...headers },
     body: JSON.stringify({
       model: 'claude-test',
       max_tokens: 1024,
@@ -172,6 +178,34 @@ describe('startModels', () => {
     expect(cluster.requestsFor('T-1-a3')).toEqual([]);
   });
 
+  test("sessionOf and callIdsIn read a request's session or thread and the model's own calls", async () => {
+    const cluster = await models({ 'T-1-a1': PROGRAM, 'T-1-a2': PROGRAM });
+    const system = `Primary working directory: ${clone('T-1-a1')}`;
+    await claude(cluster, system, [{ role: 'user', content: 'Start.' }]);
+    await claude(
+      cluster,
+      system,
+      [
+        { role: 'user', content: 'Start.' },
+        { role: 'assistant', content: [{ type: 'tool_use', id: 'e2e-s0', name: 'Bash', input: { command: 'true' } }] },
+        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'e2e-s0', content: 'done' }] },
+      ],
+      ['Bash'],
+      { 'x-claude-code-session-id': 'session-1' },
+    );
+    await codex(cluster, [
+      environment(clone('T-1-a2')),
+      user('Start.'),
+      { type: 'custom_tool_call', name: 'exec', call_id: 'e2e-s0', input: '' },
+      { type: 'custom_tool_call_output', call_id: 'e2e-s0', output: [{ type: 'input_text', text: 'exit 0' }] },
+    ]);
+    const [first, second] = cluster.requestsFor('T-1-a1');
+    const [thread] = cluster.requestsFor('T-1-a2');
+    if (!first || !second || !thread) throw new Error('a request was not recorded');
+    expect([sessionOf(first), sessionOf(second), sessionOf(thread)]).toEqual([null, 'session-1', 'thread-1']);
+    expect([callIdsIn(first), callIdsIn(second), callIdsIn(thread)]).toEqual([[], ['e2e-s0'], ['e2e-s0']]);
+  });
+
   test('addPrograms adds programs for later requests and keeps the others', async () => {
     const cluster = await models({ 'T-1-a1': PROGRAM });
     const successor: Program = { steps: [tool('write_handoff', { note: 'two' })] };
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `bun test packages/testkit/test/models.test.ts packages/testkit/e2e/runner-restart.e2e.test.ts`
Expected: FAIL — `SyntaxError: Export named 'sessionOf' not found in module '.../packages/testkit/src/harness/models.ts'.` The e2e file also reports missing `callIdsIn` (0 pass, 2 fail; parent-tree check, 2026-11-11).

- [ ] **Step 3: Implement**

**File:** `packages/testkit/src/harness/models.ts` (change)

```diff
diff --git a/packages/testkit/src/harness/models.ts b/packages/testkit/src/harness/models.ts
index ebf23c0a..4adacb69 100644
--- a/packages/testkit/src/harness/models.ts
+++ b/packages/testkit/src/harness/models.ts
@@ -27,6 +27,26 @@ export type RecordedRequest =
   | (Recorded & { vendor: 'claude'; request: AnthropicRequest })
   | (Recorded & { vendor: 'codex'; request: ResponsesRequest });
 
+/** The session (Claude) or thread (Codex) the request belongs to; null when it names none. */
+export function sessionOf(request: RecordedRequest): string | null {
+  return request.vendor === 'claude' ? request.request.sessionId : request.request.threadId;
+}
+
+/** The ids of the model's own tool calls in the history the request carries, oldest first. */
+export function callIdsIn(request: RecordedRequest): string[] {
+  if (request.vendor === 'claude') {
+    return request.request.messages.flatMap((message) =>
+      message.blocks.flatMap((block) => (block.type === 'tool_use' ? [block.id] : [])),
+    );
+  }
+  const input = Array.isArray(request.request.body.input) ? (request.request.body.input as unknown[]) : [];
+  return input.flatMap((item) => {
+    const entry = item as Record<string, unknown> | null;
+    const type = typeof entry?.type === 'string' ? entry.type : '';
+    return type.endsWith('_call') && typeof entry?.call_id === 'string' ? [entry.call_id] : [];
+  });
+}
+
 export interface Models {
   anthropic: ScriptedAnthropic;
   responses: ResponsesServer;
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `bun test packages/testkit/test/models.test.ts && bun test packages/testkit/e2e/runner-restart.e2e.test.ts && AGFLOW_E2E=1 caffeinate -i bun test --timeout 600000 packages/testkit/e2e/runner-restart.e2e.test.ts && bun run typecheck`
Expected: all selected tests pass (0 fail); tsc exits 0; the gated cases run for both vendors against scripted servers.

The original scenario-only prototype passed its first gated runs. The final commit additionally moves sessionOf/callIdsIn into models.ts, so its final tests have a genuine missing-export failure at the final parent. The new unit test and both helper exports belong here, not to Task 3. Suspend writes and proves a fresh suspend.txt snapshot, then removes that test-only file while the runner is down. Require non-null sessions, literal restart-prompt text, the running gate and process identities; use a fresh cluster for SIGKILL. See Decisions 49–50.

- [ ] **Step 5: Commit**

```bash
git add -A 'packages/testkit/e2e/runner-restart.e2e.test.ts' 'packages/testkit/src/harness/models.ts' 'packages/testkit/test/models.test.ts'
git commit -m 'M2G Task 10: Runner restart: suspend and crash' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

### Task 11: Hub restart: crash, recovery window and replay

The hub can crash at any time. The harness SIGKILLs it while a worker is mid-task and keeps it down for longer than the runner lease. Meanwhile the agent keeps working: a bridge call gets the hub-unreachable answer, and the runner pushes WIP straight to origin within the WIP grace (canPushWip, X-11; the E2E timings put the WIP interval inside it) and keeps the event in its outbox. When the hub restarts, it opens a recovery window, extends the leases by the downtime, applies the replayed events and resends pending commands. The attempt keeps its fence and its token, and gets the one reconnect nudge (X-38). This task adds only scenario tests over behavior already provided by the preceding plans; apply the file and run it, without inventing a failing implementation step.

**Files:**
- Test: `packages/testkit/e2e/hub-restart.e2e.test.ts`

- [ ] **Step 1: Make the change**

**File:** `packages/testkit/e2e/hub-restart.e2e.test.ts` (new)

```ts
// The hub can crash at any time (design 6.3, 6.6, 6.8, 6.14, 7.3, 10), per vendor. The harness SIGKILLs the hub while
// a worker is mid-task and keeps it down for longer than the runner lease. Meanwhile the agent keeps working: its
// report_progress gets the hub-unreachable answer, and the runner pushes WIP straight to origin within the WIP grace
// (X-11) and keeps the event in its outbox. When the hub starts again it opens a recovery window, extends the leases
// by the downtime and applies the replayed events; the attempt keeps its fence and its token, and its agent gets the
// one nudge (X-38). Runs only with AGFLOW_E2E=1.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { attemptId, BRIDGE_ANSWERS, DEFAULT_WIP_REF_PREFIX, type Fence, type NewTaskInput, wipRef } from '@agflow/core';
import { OUTAGE_NUDGE } from '@agflow/runner/src/attempt/turns';
import { fileAt, refSha } from '../src/git-fixtures';
import { type Cluster, startCluster } from '../src/harness/cluster';
import { describeE2e, E2E_TEST_TIMEOUT_MS, e2eVendors } from '../src/harness/env';
import { E2E_HUB_TIMINGS } from '../src/harness/hub-process';
import { GATE_DIR, gate, type Program, react, type ShellStep, say, shell, tool } from '../src/harness/playbook';
import type { RunnerProcess } from '../src/harness/runner-process';
import { newestEventId, waitAtGate } from '../src/scenarios/result';

setDefaultTimeout(E2E_TEST_TIMEOUT_MS);

const TASK: NewTaskInput = {
  title: 'Add a.txt, b.txt and c.txt across a hub crash',
  objective: 'Commit a.txt, write b.txt and report progress; once the hub is back, commit b.txt and c.txt and submit.',
  acceptance: [{ id: 'files', assertion: 'a.txt, b.txt and c.txt hold the lines a, b and c' }],
};

/** The gate a1 waits at until the hub is down; b.txt is written as it opens. */
const HUB_DOWN = 'hub-down';
/** The gate a1 waits at, after the nudge, until the recovery window has closed. */
const RECOVERED = 'recovered';

/** The progress a1 reports while the hub is down: the hub must never record it. */
const DOWNTIME_NOTE = 'b.txt is written while the hub is down.';
/** The progress a1 reports once the hub is back. */
const AFTER_NOTE = 'The hub is back; b.txt is written, and c.txt comes next.';

/** How much longer than the runner lease the hub stays down. */
const DOWNTIME_MARGIN_MS = 5_000;

/**
 * A gate that runs cmd as it opens, in the same command: the work lands within the gate's poll of the opening, with
 * no model round trip, so the runner's WIP timer harvests it well inside the WIP grace after the hub's last answer.
 */
function gateThen(name: string, cmd: string): ShellStep {
  const step = gate(name);
  return { ...step, cmd: `${step.cmd} && ${cmd}` };
}

/**
 * a1 commits a.txt, waits for the hub to go down, writes b.txt and reports progress, which fails; its turn ends there.
 * The nudge then starts its next turn: it waits for the recovery window to close, reports progress again, commits
 * b.txt and c.txt, and submits.
 */
function program(taskId: string): Program {
  return {
    steps: [
      say(
        'I add a.txt and commit it.',
        shell("printf 'a\\n' > a.txt && git add a.txt && git commit -q -m 'Add a.txt'"),
      ),
      say('I write b.txt once the hub is down.', gateThen(HUB_DOWN, "printf 'b\\n' > b.txt")),
      say('I report my progress.', tool('report_progress', { task_id: taskId, note: DOWNTIME_NOTE })),
    ],
    reactions: [
      react(OUTAGE_NUDGE, [
        gate(RECOVERED),
        say('I report my progress again.', tool('report_progress', { task_id: taskId, note: AFTER_NOTE })),
        say(
          'I add c.txt and commit b.txt and c.txt.',
          shell("printf 'c\\n' > c.txt && git add b.txt c.txt && git commit -q -m 'Add b.txt and c.txt'"),
        ),
        say('I submit the task.', tool('submit', { task_id: taskId, summary: 'a.txt, b.txt and c.txt are in.' })),
      ]),
    ],
  };
}

/** Opens a gate in the clone as cluster.openGate does, without asking the hub where the attempt runs: it is down. */
function openGateOn(runner: RunnerProcess, attempt: string, name: string): void {
  const file = join(runner.clonePath(attempt), GATE_DIR, name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, '');
}

/** How often the marker occurs in the text. */
function occurrences(text: string, marker: string): number {
  return text.split(marker).length - 1;
}

/** What the tests share once a1 waits at its first gate. */
interface Run {
  taskId: string;
  a1: string;
  ref: string;
  runner: RunnerProcess;
  /** a1's fence before the crash. */
  fence: Fence;
  /** The newest event before the crash. */
  before: number;
  /** When the hub was killed and started again. */
  killedAt: number;
  restartedAt: number;
  /** The WIP the runner pushed to origin while the hub was down. */
  downtimeSha: string;
}

describeE2e('hub restart', () => {
  for (const vendor of e2eVendors()) {
    describe(vendor, () => {
      let started: Cluster | null = null;
      let run: Partial<Run> = {};
      const cluster = (): Cluster => {
        if (started === null) throw new Error('the cluster did not start');
        return started;
      };
      const ran = <K extends keyof Run>(key: K): Run[K] => {
        const value = run[key];
        if (value === undefined) throw new Error(`an earlier test did not get as far as ${key}`);
        return value as Run[K];
      };

      beforeAll(async () => {
        started = await startCluster({ vendor });
        const { person, origin, models, waitFor, waitForEvent } = started;
        run = await started.step(async () => {
          const [task] = await person.createTasks([TASK]);
          if (!task) throw new Error('the hub created no task');
          const a1 = attemptId(task.id, 1, 1);
          const ref = wipRef(DEFAULT_WIP_REF_PREFIX, a1);
          models.addPrograms({ [a1]: program(task.id) });
          await waitForEvent({ type: 'attempt.running', subject: task.id, attemptId: a1 });
          await waitAtGate(cluster(), a1, HUB_DOWN, {});
          // The hub has a WIP with a.txt and without b.txt: only the downtime's push can bring b.txt.
          await waitFor(`the hub's WIP of ${a1} with a.txt`, async () => {
            const { attempt } = await person.attempt(a1);
            return attempt.wipSha !== null && (await fileAt(origin.path, attempt.wipSha, 'a.txt')) === 'a\n';
          });
          const { attempt } = await person.attempt(a1);
          const runner = await cluster().runnerOf(a1);
          return { taskId: task.id, a1, ref, runner, fence: attempt.fence, before: await newestEventId(cluster()) };
        });
      });

      afterAll(async () => {
        await started?.close();
      });

      test('while the hub is down, report_progress answers hub-unreachable, and the runner pushes the WIP holding b.txt to origin', () =>
        cluster().step(async () => {
          const { hub, origin, models, waitFor } = cluster();
          const a1 = ran('a1');
          const ref = ran('ref');
          run.killedAt = Date.now();
          await hub.kill();
          openGateOn(ran('runner'), a1, HUB_DOWN);
          run.downtimeSha = await waitFor(`the WIP of ${a1} with b.txt on origin`, async () => {
            const sha = await refSha(origin.path, ref);
            return sha !== null && (await fileAt(origin.path, sha, 'b.txt')) === 'b\n' ? sha : null;
          });
          expect(hub.running).toBe(false);
          expect(await fileAt(origin.path, run.downtimeSha, 'a.txt')).toBe('a\n');
          await waitFor(`${a1}'s report_progress to answer that the hub is unreachable`, async () =>
            models.sawText(a1, BRIDGE_ANSWERS.hubUnreachable),
          );
          // Down for longer than the runner lease: without the recovery, the hub would end a1 lost at its first tick.
          await Bun.sleep(Math.max(0, run.killedAt + E2E_HUB_TIMINGS.runnerLeaseMs + DOWNTIME_MARGIN_MS - Date.now()));
          expect(hub.running).toBe(false);
          run.restartedAt = Date.now();
          await hub.start();
        }));

      test('after the restart, system.recovery_started is emitted, and a1 is not lost and keeps its fence', () =>
        cluster().step(async () => {
          const { person, waitFor, waitForEvent } = cluster();
          const a1 = ran('a1');
          const recovery = await waitForEvent({ type: 'system.recovery_started' }, { after: ran('before') });
          expect(Number(recovery.data.gapMs)).toBeGreaterThan(E2E_HUB_TIMINGS.runnerLeaseMs);
          // The runner is back, and the hub has ticked with it.
          const restartedAt = ran('restartedAt');
          await waitFor(`${a1}'s runner to be seen after the restart`, async () => {
            const { attempt } = await person.attempt(a1);
            const runner = (await person.runners()).runners.find((entry) => entry.id === attempt.runnerId);
            return runner !== undefined && runner.lastSeenAt > restartedAt + E2E_HUB_TIMINGS.tickMs;
          });
          const { attempt } = await person.attempt(a1);
          expect(attempt.status).not.toBe('ended');
          expect(attempt.endReason).toBeNull();
          expect(attempt.fence).toEqual(ran('fence'));
          // No resume, and so no new token: the attempt goes on as it was.
          const since = await person.events({ after: ran('before'), subject: ran('taskId'), limit: 1000 });
          const about = since.filter((event) => event.data.attemptId === a1).map((event) => event.type);
          expect(about).not.toContain('attempt.resumed');
          expect(about).not.toContain('attempt.ended');
        }));

      test("the replayed attempt.wip from the downtime is applied: the hub's WIP and the task's work position are origin's", () =>
        cluster().step(async () => {
          const { person, origin, waitForEvent } = cluster();
          const a1 = ran('a1');
          const sha = ran('downtimeSha');
          const match = { type: 'attempt.wip', subject: ran('taskId'), attemptId: a1, data: { sha } };
          await waitForEvent(match, { after: ran('before') });
          expect(await refSha(origin.path, ran('ref'))).toBe(sha);
          const { attempt } = await person.attempt(a1);
          expect([attempt.wipRef, attempt.wipSha]).toEqual([ran('ref'), sha]);
          const { task } = await person.task(ran('taskId'));
          expect([task.workRef, task.workSha]).toEqual([ran('ref'), sha]);
        }));

      test('once the link is back, the agent gets "the agflow hub is reachable again; retry the tool that failed" once', () =>
        cluster().step(async () => {
          const { models } = cluster();
          const a1 = ran('a1');
          // The nudge starts the turn whose first step is the gate: the request it answered shows what a1 got.
          await waitAtGate(cluster(), a1, RECOVERED, {});
          const atGate = models
            .requestsFor(a1)
            .find(({ answer }) => answer?.kind === 'step' && answer.step.kind === 'shell' && answer.step.gate === RECOVERED);
          expect(occurrences(atGate?.text ?? '', OUTAGE_NUDGE)).toBe(1);
        }));

      test('system.recovery_ended follows after recoveryMs; report_progress then works, the downtime progress is absent, and a1 submits', () =>
        cluster().step(async () => {
          const { person, origin, models, waitForEvent } = cluster();
          const a1 = ran('a1');
          const taskId = ran('taskId');
          const recovery = await waitForEvent({ type: 'system.recovery_started' }, { after: ran('before') });
          const ended = await waitForEvent({ type: 'system.recovery_ended' }, { after: recovery.id });
          const until = Number(recovery.data.until);
          expect(Math.abs(until - recovery.ts - E2E_HUB_TIMINGS.recoveryMs)).toBeLessThan(E2E_HUB_TIMINGS.tickMs);
          expect(ended.ts).toBeGreaterThanOrEqual(until);
          await cluster().openGate(a1, RECOVERED);
          const submitted = await waitForEvent({ type: 'submission.recorded', subject: taskId, attemptId: a1 });
          const progress = (await person.task(taskId)).notes.filter((note) => note.kind === 'progress');
          expect(progress.map((note) => note.body)).toContain(AFTER_NOTE);
          expect(progress.map((note) => note.body)).not.toContain(DOWNTIME_NOTE);
          const head = await refSha(origin.path, `refs/heads/${String(submitted.data.branch)}`);
          expect(head).toBe(String(submitted.data.headSha));
          const files = ['a.txt', 'b.txt', 'c.txt'].map((file) => fileAt(origin.path, head ?? '', file));
          expect(await Promise.all(files)).toEqual(['a\n', 'b\n', 'c\n']);
          // One attempt all along, and one nudge in its whole conversation.
          expect((await cluster().attemptsOf(taskId)).map((attempt) => attempt.id)).toEqual([a1]);
          expect(occurrences(models.requestsFor(a1).at(-1)?.text ?? '', OUTAGE_NUDGE)).toBe(1);
        }));
    });
  }
});
```

- [ ] **Step 2: Check it**

Run: `bun test packages/testkit/e2e/hub-restart.e2e.test.ts && AGFLOW_E2E=1 caffeinate -i bun test --timeout 600000 packages/testkit/e2e/hub-restart.e2e.test.ts && bun run typecheck`
Expected: all selected tests pass (0 fail); tsc exits 0; the gated cases run for both vendors against scripted servers.

Tests-only task: there is no implementation block to make red tests green. The historical first run failed in the test itself because cluster.openGate asked the killed hub for the attempt; the final test captures its clone path first and opens it locally. The exact final test on the parent loads with 14 gated skips when AGFLOW_E2E is unset; that is not a pass of the scenario. Historical final gated runs: 10 pass for both vendors, twice. Run the enabled command outside a nested sandbox. See Decisions 51–52.

- [ ] **Step 3: Commit**

```bash
git add -A 'packages/testkit/e2e/hub-restart.e2e.test.ts'
git commit -m 'M2G Task 11: Hub restart: crash, recovery window and replay' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

### Task 12: Hub restore from a backup

A restore rolls the hub back. The harness restarts the hub, so that its start backup knows the running attempt, and lets the agent push more WIP. It then stops the hub and restores that backup. The restored hub (epoch 2) must first apply the events the runner replays up to hello.lastSeq, taking replayed events with a newer fence as current, so the newer WIP becomes the work position; only then does it re-fence the attempt through resume_attempt (X-1). Ids created after the restore embed the epoch and the advanced counters, so nothing collides with what existed before. To make the newer-fence rule observable, restart the runner after taking the backup and before recording the later WIP, then hold the restored session at a third gate. This task adds only scenario tests over behavior already provided by the preceding plans; apply the file and run it, without inventing a failing implementation step.

**Files:**
- Test: `packages/testkit/e2e/hub-restore.e2e.test.ts`

- [ ] **Step 1: Make the change**

**File:** `packages/testkit/e2e/hub-restore.e2e.test.ts` (new)

```ts
// A restore rolls the hub back (design 6.3, 6.4, 6.5, 6.13, 6.14), per vendor. The harness restarts the hub, so that
// its start backup knows the running attempt, then restarts the attempt's runner, so that the hub resumes the attempt
// at a fence newer than the backup's, and lets the agent push more WIP at that fence. It then stops the hub and
// restores that backup. The restored hub (epoch 2) first applies the events the runner replays up to hello.lastSeq,
// taking replayed events with a newer fence as current, so the newer WIP becomes the work position; only then does it
// re-fence the attempt through resume_attempt (X-1). Ids created after the restore embed the epoch and the advanced
// counters, so nothing collides with what existed before. Runs only with AGFLOW_E2E=1.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import {
  attemptId,
  compareFence,
  DEFAULT_WIP_REF_PREFIX,
  type Fence,
  type HubEvent,
  type NewTaskInput,
  taskBranchName,
  wipRef,
} from '@agflow/core';
import { handoffPrompt } from '@agflow/runner/src/attempt/stop';
import { type ProcessIdentity, processIdentity, sameProcess } from '@agflow/runner/src/processes';
import { fileAt, refSha } from '../src/git-fixtures';
import { type Cluster, startCluster } from '../src/harness/cluster';
import { describeE2e, E2E_TEST_TIMEOUT_MS, e2eVendors } from '../src/harness/env';
import { callIdsIn, sessionOf } from '../src/harness/models';
import { GATE_DIR, gate, type Program, say, shell, stepCallId, tool } from '../src/harness/playbook';
import { processesInDir } from '../src/harness/proc';
import { cloneFile, newestEventId, waitAtGate } from '../src/scenarios/result';

setDefaultTimeout(E2E_TEST_TIMEOUT_MS);

const TASK: NewTaskInput = {
  title: 'Add a.txt, b.txt and c.txt across a hub restore',
  objective:
    'Commit a.txt, write b.txt, and after the hub is restored report progress, commit b.txt and c.txt, then submit.',
  acceptance: [{ id: 'files', assertion: 'a.txt, b.txt and c.txt hold the lines a, b and c' }],
};

/** The task created after the restore. */
const LATER_TASK: NewTaskInput = {
  title: 'Add d.txt after the restore',
  objective: 'Commit d.txt holding the line "d" and submit.',
  acceptance: [{ id: 'file', assertion: 'd.txt holds the line d' }],
};

/**
 * The gate a1 waits in until the hub's start backup knows it. The runner restart that gives a1 a newer fence
 * interrupts it, and the resumed agent counts the interrupted call as run.
 */
const BACKED_UP = 'backed-up';
/**
 * The gate a1 waits in, with b.txt pushed at the newer fence, while the hub is restored. The restore's resume stops
 * the agent and so interrupts it too.
 */
const RESTORED = 'restored';
/** The gate the agent resumed after the restore waits at, so nothing newer than the replayed WIP exists meanwhile. */
const RESUMED = 'resumed';

/** The progress a1 reports once re-fenced: its bridge call must work with the new token. */
const PROGRESS_NOTE = 'The hub was restored; b.txt is written, and c.txt comes next.';

/** What a restore's resume tells the agent (design 6.3, resume_attempt). */
const RESTART_PROMPT = 'the runner restarted; continue from your last step';

/** How the runner's handoff turn starts: a resume stops the live agent without one. */
const HANDOFF_TURN = handoffPrompt('<reason>').split('<reason>')[0] ?? '';

/** Ids above this were handed out after the restore: the restore advances each counter by 1000. */
const ADVANCED = 1000;

function program(taskId: string): Program {
  return {
    steps: [
      say(
        'I add a.txt and commit it.',
        shell("printf 'a\\n' > a.txt && git add a.txt && git commit -q -m 'Add a.txt'"),
      ),
      gate(BACKED_UP),
      say('I start b.txt and leave it uncommitted for now.', shell("printf 'b\\n' > b.txt")),
      gate(RESTORED),
      gate(RESUMED),
      say('I report my progress.', tool('report_progress', { task_id: taskId, note: PROGRESS_NOTE })),
      say(
        'I add c.txt and commit b.txt and c.txt.',
        shell("printf 'c\\n' > c.txt && git add b.txt c.txt && git commit -q -m 'Add b.txt and c.txt'"),
      ),
      say('I submit the task.', tool('submit', { task_id: taskId, summary: 'a.txt, b.txt and c.txt are in.' })),
    ],
  };
}

function laterProgram(taskId: string): Program {
  return {
    steps: [
      say(
        'I add d.txt and commit it.',
        shell("printf 'd\\n' > d.txt && git add d.txt && git commit -q -m 'Add d.txt'"),
      ),
      say('I submit the task.', tool('submit', { task_id: taskId, summary: 'd.txt holds the line d.' })),
    ],
  };
}

/** The number in an id such as T-1001 or S-1001. */
function idNumber(id: string): number {
  return Number(id.match(/-(\d+)$/)?.[1] ?? Number.NaN);
}

/** What the tests share. */
interface Run {
  taskId: string;
  a1: string;
  ref: string;
  /** The task's branch before the restore. */
  branch: string;
  /** a1's fence in the hub's start backup. */
  backupFence: Fence;
  /** a1's agent, fence and session while it waited for the restore: the fence is newer than backupFence. */
  agent: ProcessIdentity;
  fence: Fence;
  session: string;
  /** The WIP a1 pushed at its newer fence after the backup: the restored hub learns it only from the replay. */
  afterBackupSha: string;
  restored: HubEvent;
  resumed: HubEvent;
}

describeE2e('hub restore', () => {
  for (const vendor of e2eVendors()) {
    describe(vendor, () => {
      let started: Cluster | null = null;
      let run: Partial<Run> = {};
      const cluster = (): Cluster => {
        if (started === null) throw new Error('the cluster did not start');
        return started;
      };
      const ran = <K extends keyof Run>(key: K): Run[K] => {
        const value = run[key];
        if (value === undefined) throw new Error(`an earlier test did not get as far as ${key}`);
        return value as Run[K];
      };

      beforeAll(async () => {
        started = await startCluster({ vendor });
        const { person, models, waitFor, waitForEvent } = started;
        run = await started.step(async () => {
          const [task] = await person.createTasks([TASK]);
          if (!task) throw new Error('the hub created no task');
          const a1 = attemptId(task.id, 1, 1);
          models.addPrograms({ [a1]: program(task.id) });
          await waitForEvent({ type: 'attempt.running', subject: task.id, attemptId: a1 });
          await waitAtGate(cluster(), a1, BACKED_UP, {});
          const clone = (await cluster().runnerOf(a1)).clonePath(a1);
          await waitFor(`a.txt in ${a1}'s clone`, async () => cloneFile(clone, 'a.txt') !== null);
          const branch = (await person.task(task.id)).task.branch;
          if (branch === null) throw new Error(`${task.id} has no branch`);
          return { taskId: task.id, a1, ref: wipRef(DEFAULT_WIP_REF_PREFIX, a1), branch };
        });
      });

      afterAll(async () => {
        await started?.close();
      });

      test('after the restore GET /api/status has epoch 2, and a system.restored event is recorded', () =>
        cluster().step(async () => {
          const { hub, person, origin, models, waitFor, waitForEvent } = cluster();
          const a1 = ran('a1');
          const taskId = ran('taskId');
          // A restart, so that the hub's start backup knows a1 as it runs; a hub restart keeps a1's fence.
          const backupsBefore = hub.backups('start').length;
          await hub.restart();
          const backups = hub.backups('start');
          expect(backups.length).toBeGreaterThan(backupsBefore);
          const backup = backups.at(-1) as string;
          run.backupFence = (await person.attempt(a1)).attempt.fence;
          const afterRestart = await newestEventId(cluster());
          // A runner restart, so that the hub resumes a1 at a fence the backup does not know (X-1). The suspend must
          // find the gate running in the clone: it interrupts the gate, and the resumed agent counts it as run. This is
          // the one runner-restart resume within resumeWindowMs; the restore's own resume does not count.
          const runner = await cluster().runnerOf(a1);
          const clone = runner.clonePath(a1);
          const gateFile = `${GATE_DIR}/${BACKED_UP}`;
          await waitFor(`${a1}'s gate command in its clone`, async () =>
            (await processesInDir(clone)).some((row) => row.command.includes(gateFile)),
          );
          await runner.stop();
          await runner.start();
          const refenced = await waitForEvent(
            { type: 'attempt.resumed', subject: taskId, attemptId: a1 },
            { after: afterRestart },
          );
          const fence = refenced.data.fence as Fence;
          expect(fence.epoch).toBe(1);
          expect(compareFence(fence, run.backupFence)).toBeGreaterThan(0);
          // Only a safeguard for a CLI that runs the interrupted gate again.
          await cluster().openGate(a1, BACKED_UP);
          // At the newer fence, a1 writes b.txt, and the hub records the WIP that holds it.
          const wip = await waitFor(`a WIP of ${a1} with b.txt after its resume`, async () => {
            const events = await person.events({ after: refenced.id, subject: taskId, limit: 1000 });
            const pushed = events.filter((event) => event.type === 'attempt.wip' && event.data.attemptId === a1);
            for (const event of pushed.reverse()) {
              if ((await fileAt(origin.path, String(event.data.sha), 'b.txt')) === 'b\n') return event;
            }
            return null;
          });
          run.afterBackupSha = String(wip.data.sha);
          await waitAtGate(cluster(), a1, RESTORED, {});
          const { attempt } = await person.attempt(a1);
          expect(attempt.wipSha).toBe(run.afterBackupSha);
          expect(attempt.fence).toEqual(fence);
          run.fence = attempt.fence;
          run.agent = await runner.agentOf(a1);
          const last = models.requestsFor(a1).at(-1);
          const session = last ? sessionOf(last) : null;
          // The resume checks for the same session or thread: without an id to compare, that check would prove nothing.
          if (session === null) throw new Error(`${a1}'s model requests carry no session or thread id`);
          run.session = session;
          // The rollback.
          await hub.stop();
          await hub.restore(backup);
          await hub.start();
          expect((await person.status()).epoch).toBe(2);
          run.restored = await waitForEvent({ type: 'system.restored', data: { epoch: 2 } });
        }));

      test("the WIP pushed at the newer fence is applied before the re-fence, and it is a1's work position", () =>
        cluster().step(async () => {
          const { person, origin, waitForEvent } = cluster();
          const a1 = ran('a1');
          const taskId = ran('taskId');
          const restored = ran('restored');
          const afterBackupSha = ran('afterBackupSha');
          const resumedMatch = { type: 'attempt.resumed', subject: taskId, attemptId: a1 };
          run.resumed = await waitForEvent(resumedMatch, { after: restored.id });
          const replayed = await waitForEvent(
            { type: 'attempt.wip', subject: taskId, attemptId: a1, data: { sha: afterBackupSha } },
            { after: restored.id },
          );
          expect(replayed.id).toBeLessThan(run.resumed.id);
          // Its fence is newer than the one the restored hub holds, and the replay took it as current, not late work.
          expect(compareFence(ran('fence'), ran('backupFence'))).toBeGreaterThan(0);
          const since = await person.events({ after: restored.id, subject: taskId, limit: 1000 });
          expect(since.filter((event) => event.type === 'attempt.late_work')).toEqual([]);
          // The resumed agent waits at its gate, so nothing newer than the replayed WIP exists.
          await waitAtGate(cluster(), a1, RESUMED, {});
          expect(await refSha(origin.path, ran('ref'))).toBe(afterBackupSha);
          expect(await fileAt(origin.path, afterBackupSha, 'b.txt')).toBe('b\n');
          expect((await person.attempt(a1)).attempt.wipSha).toBe(afterBackupSha);
          expect((await person.task(taskId)).task.workSha).toBe(afterBackupSha);
        }));

      test('resume_attempt re-fences a1 at epoch 2: its agent is stopped without a handoff turn, its session goes on, its bridge calls work and it does not end', () =>
        cluster().step(async () => {
          const { person, models, waitFor } = cluster();
          const a1 = ran('a1');
          const fence = ran('resumed').data.fence as Fence;
          expect(ran('fence').epoch).toBe(1);
          expect(fence.epoch).toBe(2);
          expect((await person.attempt(a1)).attempt.fence.epoch).toBe(2);
          // The agent's own session goes on. Its first request after the restore is the one its program answered with
          // the RESUMED gate; its history holds the earlier steps and the resume prompts of the runner restart and the
          // restore.
          await waitAtGate(cluster(), a1, RESUMED, {});
          const resumed = models
            .requestsFor(a1)
            .find(
              ({ answer }) => answer?.kind === 'step' && answer.step.kind === 'shell' && answer.step.gate === RESUMED,
            );
          if (!resumed) throw new Error(`no request of ${a1} was answered with the gate ${RESUMED}`);
          expect(resumed.text.split(RESTART_PROMPT).length - 1).toBe(2);
          expect(callIdsIn(resumed)).toContain(stepCallId(2));
          expect(sessionOf(resumed)).toBe(ran('session'));
          expect(models.requestsFor(a1).some((request) => request.text.includes(HANDOFF_TURN))).toBe(false);
          // The process that waited at the gate is gone: the runner stopped it and started the resumed one.
          const old = ran('agent');
          const now = await processIdentity(old.pid);
          expect(now !== null && sameProcess(now, old)).toBe(false);
          // Through the gate, the resumed agent's report_progress works with the token of the new fence.
          await cluster().openGate(a1, RESUMED);
          const note = await waitFor(`${a1}'s progress note`, async () => {
            const { notes } = await person.task(ran('taskId'));
            return notes.find((entry) => entry.kind === 'progress' && entry.body === PROGRESS_NOTE);
          });
          const { attempt } = await person.attempt(a1);
          expect(note.author).toBe(`agent:${attempt.agentId}`);
          expect(attempt.status).not.toBe('ended');
          expect((await cluster().attemptsOf(ran('taskId'))).map((entry) => entry.id)).toEqual([a1]);
        }));

      test('a1 submits on the branch its attempt started with, and the submission id is above S-1000', () =>
        cluster().step(async () => {
          const { origin, waitForEvent } = cluster();
          const a1 = ran('a1');
          const submitted = await waitForEvent({ type: 'submission.recorded', subject: ran('taskId'), attemptId: a1 });
          expect(submitted.data.branch).toBe(ran('branch'));
          expect(ran('branch')).toBe(taskBranchName(ran('taskId'), TASK.title, 1));
          expect(idNumber(String(submitted.data.submissionId))).toBeGreaterThan(ADVANCED);
          const head = await refSha(origin.path, `refs/heads/${ran('branch')}`);
          expect(head).toBe(String(submitted.data.headSha));
          const files = ['a.txt', 'b.txt', 'c.txt'].map((file) => fileAt(origin.path, head ?? '', file));
          expect(await Promise.all(files)).toEqual(['a\n', 'b\n', 'c\n']);
        }));

      test('a task created after the restore gets an id above T-1000, and its attempt id, WIP ref and branch embed e2', () =>
        cluster().step(async () => {
          const { person, origin, models, waitForEvent } = cluster();
          const [task] = await person.createTasks([LATER_TASK]);
          if (!task) throw new Error('the hub created no task');
          expect(idNumber(task.id)).toBeGreaterThan(ADVANCED);
          const first = attemptId(task.id, 1, 2);
          expect(first).toBe(`${task.id}-e2-a1`);
          models.addPrograms({ [first]: laterProgram(task.id) });
          const submitted = await waitForEvent({ type: 'submission.recorded', subject: task.id, attemptId: first });
          expect((await cluster().attemptsOf(task.id)).map((attempt) => attempt.id)).toEqual([first]);
          const { attempt } = await person.attempt(first);
          const ref = `refs/agflow/${task.id}/e2-a1`;
          expect(wipRef(DEFAULT_WIP_REF_PREFIX, first)).toBe(ref);
          expect(attempt.wipRef).toBe(ref);
          expect(await refSha(origin.path, ref)).not.toBeNull();
          const branch = taskBranchName(task.id, LATER_TASK.title, 2);
          expect(branch.startsWith(`agflow/${task.id}-e2-`)).toBe(true);
          expect((await person.task(task.id)).task.branch).toBe(branch);
          expect(submitted.data.branch).toBe(branch);
          expect(await fileAt(origin.path, String(submitted.data.headSha), 'd.txt')).toBe('d\n');
        }));
    });
  }
});
```

- [ ] **Step 2: Check it**

Run: `bun test packages/testkit/e2e/hub-restore.e2e.test.ts && AGFLOW_E2E=1 caffeinate -i bun test --timeout 600000 packages/testkit/e2e/hub-restore.e2e.test.ts && bun run typecheck`
Expected: all selected tests pass (0 fail); tsc exits 0; the gated cases run for both vendors against scripted servers.

Tests-only task: the initial gated run passed (10 checks, both vendors), and no parent implementation is missing. The final file loads with 14 gated skips when the gate is unset. A review mutation removing the newer-fence restore-replay exception made the corrected test time out waiting for the replayed attempt.wip; the mutation was reverted in the prototype and is not part of this plan. Restart the runner after taking the backup to prove that exception, then use the RESUMED gate to hold the replayed position before later work. Dev sessions and CLI tokens predate this backup. See Decisions 53–54.

- [ ] **Step 3: Commit**

```bash
git add -A 'packages/testkit/e2e/hub-restore.e2e.test.ts'
git commit -m 'M2G Task 12: Hub restore from a backup' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

### Task 13: Delivery to a mid-turn agent

People steer agents while they work. A person sends a message to a worker that is inside a long tool call. The hub pushes it as a deliver command, and the vendor takes it into the running turn: Claude at the next tool boundary, Codex through turn/steer. The runner reports the message delivered, then acknowledged once the turn ends. The message is injected once, with person authority and M1's quoting, and check_inbox never returns it as well. This task adds only scenario tests over behavior already provided by the preceding plans; apply the file and run it, without inventing a failing implementation step.

**Files:**
- Test: `packages/testkit/e2e/mid-turn-delivery.e2e.test.ts`

- [ ] **Step 1: Make the change**

**File:** `packages/testkit/e2e/mid-turn-delivery.e2e.test.ts` (new)

```ts
// People steer agents while they work (design 6.7, 8.3, 9.2), per vendor. A person sends a message to a worker that is
// inside a long tool call. The hub pushes it in a deliver command, and the vendor takes it into the running turn:
// Claude at the next tool boundary, Codex through turn/steer. The runner reports it delivered when the vendor accepts
// it, and acknowledged once the turn that consumed it ends. It is injected once, with person authority and M1's
// quoting, and check_inbox never returns it as well. Runs only with AGFLOW_E2E=1.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { attemptId, formatMessage, type Message, type MessageView, type NewTaskInput } from '@agflow/core';
import { claudeProjectDir } from '@agflow/runner/src/adapters/claude/paths';
import { fileAt, refSha } from '../src/git-fixtures';
import { type Cluster, startCluster } from '../src/harness/cluster';
import { describeE2e, E2E_TEST_TIMEOUT_MS, e2eVendors } from '../src/harness/env';
import type { RecordedRequest } from '../src/harness/models';
import { GATE_DIR, gate, type Program, react, say, shell, stepCallId, tool } from '../src/harness/playbook';
import { processesInDir } from '../src/harness/proc';
import type { RunnerProcess } from '../src/harness/runner-process';
import { newestEventId, waitAtGate } from '../src/scenarios/result';

setDefaultTimeout(E2E_TEST_TIMEOUT_MS);

const TASK: NewTaskInput = {
  title: 'Run the long check and follow what alice says meanwhile',
  objective: 'Run the long check, do what a person asks while it runs, commit that work and submit.',
  acceptance: [{ id: 'asked', assertion: 'the work a person asked for is committed' }],
};

/** The gate a1 waits in when alice writes: the long tool call the message arrives during. */
const MID_TURN = 'mid-turn';
/**
 * The gate that holds a1's turn open after it acted on the message: until the test opens it, the turn that consumed
 * the message has not ended, so the message cannot be acknowledged yet.
 */
const HELD = 'held';

/** What alice asks while a1 is inside its long tool call; one line, so M1's quoting keeps it whole. */
const MESSAGE = 'While that check runs: also create d.txt holding the line "d" and commit it. (mid-turn message)';

/**
 * a1 waits in its long tool call. When alice's message comes in, it adds d.txt, checks its inbox and waits at HELD;
 * then it submits.
 */
function program(taskId: string): Program {
  return {
    steps: [
      say('I run the long check.', gate(MID_TURN)),
      say('I submit the task.', tool('submit', { task_id: taskId, summary: 'd.txt is in, as alice asked.' })),
    ],
    reactions: [
      react(MESSAGE, [
        say(
          'alice asks for d.txt: I add it and commit it.',
          shell("printf 'd\\n' > d.txt && git add d.txt && git commit -q -m 'Add d.txt'"),
        ),
        say('I check my inbox.', tool('check_inbox')),
        say('I wait for the rest of the check.', gate(HELD)),
      ]),
    ],
  };
}

type Item = Record<string, unknown>;

/** Text of a message's content or a tool output: a string, or parts with text. */
function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .map((part) => (part !== null && typeof part === 'object' ? (part as Item).text : undefined))
    .filter((part): part is string => typeof part === 'string')
    .join('\n');
}

/**
 * What a request adds after the model's last reply, kept apart by authority: the tool results it answers (and any other
 * tool output, such as an agent message the runner hands in as one) and the input injected as the user's, which is how
 * a person's message reaches the running turn.
 */
interface NewInput {
  /** The results of the model's own calls, by call id. */
  results: { callId: string; text: string }[];
  /** Every tool output's text, the results included. */
  outputs: string[];
  /** The user input injected into the turn: Claude Code's user and system entries, Codex's user messages. */
  injected: string[];
}

function newInput(request: RecordedRequest): NewInput {
  if (request.vendor === 'claude') {
    const { toolResults, userTexts } = request.request;
    const results = toolResults.map((result) => ({ callId: result.toolUseId, text: result.text }));
    return { results, outputs: results.map((result) => result.text), injected: [...userTexts] };
  }
  const raw = Array.isArray(request.request.body.input) ? (request.request.body.input as unknown[]) : [];
  const items = raw.filter((item): item is Item => item !== null && typeof item === 'object');
  // The model's own items: its calls, its messages and its reasoning.
  const ownItem = (item: Item) => {
    const type = typeof item.type === 'string' ? item.type : '';
    return type.endsWith('_call') || type === 'reasoning' || (type === 'message' && item.role === 'assistant');
  };
  let start = 0;
  for (const [position, item] of items.entries()) if (ownItem(item)) start = position + 1;
  const input: NewInput = { results: [], outputs: [], injected: [] };
  for (const item of items.slice(start)) {
    const type = typeof item.type === 'string' ? item.type : '';
    if (type.endsWith('_call_output')) {
      const output = textOf(item.output);
      if (typeof item.call_id === 'string') input.results.push({ callId: item.call_id, text: output });
      input.outputs.push(output);
    } else if (type === 'message' && item.role === 'user') {
      input.injected.push(textOf(item.content));
    }
  }
  return input;
}

/** Whether any tool output of any request carries the text: a person's message must never arrive as one. */
function inOutputs(requests: readonly RecordedRequest[], text: string): boolean {
  return requests.some((request) => newInput(request).outputs.some((output) => output.includes(text)));
}

/** The text of the tool result that answers the call, and whether the CLI marked it an error (Claude only). */
function resultOf(requests: readonly RecordedRequest[], callId: string): { text: string; isError: boolean } | null {
  for (const request of requests) {
    if (request.vendor === 'claude') {
      const found = request.request.toolResults.find((result) => result.toolUseId === callId);
      if (found !== undefined) return { text: found.text, isError: found.isError };
    } else {
      const found = newInput(request).results.find((result) => result.callId === callId);
      if (found !== undefined) return { text: found.text, isError: false };
    }
  }
  return null;
}

/** How often the marker occurs in the text. */
function occurrences(text: string, marker: string): number {
  return text.split(marker).length - 1;
}

/**
 * Whether Claude Code read the text from its input and queued it: 2.1.285 then writes a queue-operation enqueue line
 * with it into the session's transcript, under the runner's Claude home.
 */
function claudeQueued(runner: RunnerProcess, clone: string, text: string): boolean {
  const dir = claudeProjectDir(runner.home.paths.homes.claude, clone);
  if (!existsSync(dir)) return false;
  const queued = (line: string) => {
    try {
      const entry = JSON.parse(line) as Item;
      return (
        entry.type === 'queue-operation' &&
        entry.operation === 'enqueue' &&
        typeof entry.content === 'string' &&
        entry.content.includes(text)
      );
    } catch {
      // The line the CLI is still writing.
      return false;
    }
  };
  return readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .some((name) => readFileSync(join(dir, name), 'utf8').split('\n').some(queued));
}

/** What the tests share. */
interface Run {
  taskId: string;
  a1: string;
  agentId: string;
  runner: RunnerProcess;
  clone: string;
  /** The newest event before alice wrote. */
  before: number;
  message: Message;
  /** The message as the hub formats it for agents, with M1's quoting. */
  formatted: string;
}

describeE2e('delivery to a mid-turn agent', () => {
  for (const vendor of e2eVendors()) {
    describe(vendor, () => {
      let started: Cluster | null = null;
      let run: Partial<Run> = {};
      const cluster = (): Cluster => {
        if (started === null) throw new Error('the cluster did not start');
        return started;
      };
      const ran = <K extends keyof Run>(key: K): Run[K] => {
        const value = run[key];
        if (value === undefined) throw new Error(`an earlier test did not get as far as ${key}`);
        return value as Run[K];
      };

      /** Waits until the attempt's program answered with the gate and its command runs in the clone. */
      const waitInGate = async (a1: string, clone: string, name: string) => {
        await waitAtGate(cluster(), a1, name, {});
        const file = `${GATE_DIR}/${name}`;
        await cluster().waitFor(`${a1}'s gate command ${name} in its clone`, async () =>
          (await processesInDir(clone)).some((row) => row.command.includes(file)),
        );
      };

      /** The message with its deliveries, as GET /api/messages shows it. */
      const view = async (): Promise<MessageView | undefined> => {
        const { id } = ran('message');
        return (await cluster().person.messages({ taskId: ran('taskId') })).find((entry) => entry.id === id);
      };

      /** The message.delivered or message.acknowledged events that name the message. */
      const eventsNaming = async (type: string): Promise<number[]> => {
        const { id } = ran('message');
        const events = await cluster().person.events({ after: ran('before'), limit: 1000 });
        return events
          .filter((event) => event.type === type && Array.isArray(event.data.ids) && event.data.ids.includes(id))
          .map((event) => event.id);
      };

      beforeAll(async () => {
        started = await startCluster({ vendor });
        const { person, models, waitForEvent } = started;
        run = await started.step(async () => {
          const [task] = await person.createTasks([TASK]);
          if (!task) throw new Error('the hub created no task');
          const a1 = attemptId(task.id, 1, 1);
          models.addPrograms({ [a1]: program(task.id) });
          await waitForEvent({ type: 'attempt.running', subject: task.id, attemptId: a1 });
          const runner = await cluster().runnerOf(a1);
          const clone = runner.clonePath(a1);
          await waitInGate(a1, clone, MID_TURN);
          const { attempt } = await person.attempt(a1);
          return { taskId: task.id, a1, agentId: attempt.agentId, runner, clone, before: await newestEventId(cluster()) };
        });
      });

      afterAll(async () => {
        await started?.close();
      });

      test('a message sent inside a gated tool call goes out once; it is delivered once the vendor takes it, and acknowledged after the turn that consumed it ends', () =>
        cluster().step(async () => {
          const { person, waitFor } = cluster();
          const a1 = ran('a1');
          const agentId = ran('agentId');
          const clone = ran('clone');
          const message = await person.send({ to: `agent:${agentId}`, body: MESSAGE, taskId: ran('taskId') });
          run.message = message;
          run.formatted = formatMessage(message);
          if (vendor === 'codex') {
            // turn/steer is the vendor taking it: delivered while the tool call still runs.
            await waitFor(`the delivery of #${message.id} to ${agentId} during the tool call`, async () =>
              (await view())?.deliveries.some((delivery) => delivery.agentId === agentId),
            );
          } else {
            // Claude Code queues it and takes it in at the next tool boundary: not delivered while the tool call runs.
            await waitFor(`Claude Code to queue #${message.id}`, async () =>
              claudeQueued(ran('runner'), clone, MESSAGE),
            );
            expect((await view())?.deliveries).toEqual([]);
          }
          await cluster().openGate(a1, MID_TURN);
          // a1 acted on the message and waits at HELD, inside the turn that consumed it.
          await waitInGate(a1, clone, HELD);
          const delivered = await waitFor(`the delivery of #${message.id} to ${agentId}`, async () => {
            const found = await view();
            return found !== undefined && found.deliveries.length > 0 ? found : null;
          });
          expect(delivered.deliveries).toHaveLength(1);
          const [delivery] = delivered.deliveries;
          expect(delivery?.agentId).toBe(agentId);
          expect(delivery?.deliveredAt).toBeGreaterThan(0);
          expect(delivery?.ackedAt).toBeNull();
          expect(await eventsNaming('message.delivered')).toHaveLength(1);
          // The turn ends once HELD opens: then, and only then, the message is acknowledged.
          await cluster().openGate(a1, HELD);
          const acked = await waitFor(`the acknowledgement of #${message.id}`, async () => {
            const found = await view();
            return found?.deliveries[0]?.ackedAt != null ? found : null;
          });
          expect(acked.deliveries).toHaveLength(1);
          expect(acked.deliveries[0]?.ackedAt).toBeGreaterThanOrEqual(delivery?.deliveredAt ?? 0);
          expect(await eventsNaming('message.acknowledged')).toHaveLength(1);
          const { log } = await person.attempt(a1);
          expect(log.some((entry) => entry.kind === 'turn')).toBe(true);
        }));

      test("the first model request with the message is in the same turn: it carries the gated tool's result too", () =>
        cluster().step(async () => {
          const { person, models } = cluster();
          const a1 = ran('a1');
          const formatted = ran('formatted');
          const requests = models.requestsFor(a1);
          const first = requests.find((request) => request.text.includes(formatted));
          if (first === undefined) throw new Error(`no model request of ${a1} carries the message`);
          const input = newInput(first);
          // Injected as the user's input, with person authority: not a tool output, as an agent's message would be.
          expect(input.injected.join('\n')).toContain(formatted);
          expect(inOutputs(requests, formatted)).toBe(false);
          expect(input.results.map((result) => result.callId)).toContain(stepCallId(0));
          // The program answered it with the message's first step, not with a fresh turn's.
          expect(first.answer).toMatchObject({ kind: 'step', callId: stepCallId(0, 0) });
          // No turn ended before a1 waited at HELD: the gate, the message and the work it asked for are one turn.
          const { log } = await person.attempt(a1);
          const held = log.findIndex((entry) => entry.kind === 'tool' && entry.summary.includes(`${GATE_DIR}/${HELD}`));
          expect(held).toBeGreaterThan(-1);
          expect(log.slice(0, held).filter((entry) => entry.kind === 'turn')).toEqual([]);
        }));

      test("the message is new input of exactly one request, from user:alice, and the agent's check_inbox returns no copy", () =>
        cluster().step(async () => {
          const { models } = cluster();
          const a1 = ran('a1');
          const { id } = ran('message');
          const formatted = ran('formatted');
          expect(formatted.startsWith(`[agflow message #${id} from user:alice about ${ran('taskId')}]\n> `)).toBe(true);
          const requests = models.requestsFor(a1);
          // Injected as user input into exactly one request, and never handed in as a tool output.
          const carrying = requests.filter((request) =>
            newInput(request).injected.some((entry) => entry.includes(formatted)),
          );
          expect(carrying).toHaveLength(1);
          expect(inOutputs(requests, formatted)).toBe(false);
          // check_inbox, the reaction's second step, answered, and without the message: it has no other unread one.
          const inbox = resultOf(requests, stepCallId(1, 0));
          if (inbox === null) throw new Error(`${a1}'s check_inbox never returned`);
          expect(inbox.isError).toBe(false);
          expect(inbox.text).toContain('No new messages.');
          expect(inbox.text).not.toContain(MESSAGE);
          // The whole conversation holds the message once.
          expect(occurrences(requests.at(-1)?.text ?? '', MESSAGE)).toBe(1);
        }));

      test('the agent does what the message asks: the submitted branch holds d.txt', () =>
        cluster().step(async () => {
          const { origin, waitForEvent } = cluster();
          const taskId = ran('taskId');
          const a1 = ran('a1');
          const submitted = await waitForEvent({ type: 'submission.recorded', subject: taskId, attemptId: a1 });
          const head = await refSha(origin.path, `refs/heads/${String(submitted.data.branch)}`);
          expect(head).toBe(String(submitted.data.headSha));
          expect(await fileAt(origin.path, head ?? '', 'd.txt')).toBe('d\n');
          expect((await cluster().attemptsOf(taskId)).map((attempt) => attempt.id)).toEqual([a1]);
        }));
    });
  }
});
```

- [ ] **Step 2: Check it**

Run: `bun test packages/testkit/e2e/mid-turn-delivery.e2e.test.ts && AGFLOW_E2E=1 caffeinate -i bun test --timeout 600000 packages/testkit/e2e/mid-turn-delivery.e2e.test.ts && bun run typecheck`
Expected: all selected tests pass (0 fail); tsc exits 0; the gated cases run for both vendors against scripted servers.

Tests-only task: the first gated run passed; “no tests found” before creating the file was not a test-first failure. The exact final file loads with 12 gated skips when disabled. The later authority mutation (forcing an agent message) fails the injected-user-input and exactly-once assertions; the mutation is not part of the plan. Keep every tool output separate from injected text, and require a normal “No new messages.” check_inbox result. HELD makes delivered-before-acknowledged observable for both vendors. See Decisions 55–56.

- [ ] **Step 3: Commit**

```bash
git add -A 'packages/testkit/e2e/mid-turn-delivery.e2e.test.ts'
git commit -m 'M2G Task 13: Delivery to a mid-turn agent' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

### Task 14: Take-over and hand-back

In the live run a person runs the take-over commands in a terminal; this task checks everything around that step automatically. A person takes over a running attempt. The runner gets a handoff note, stops the agent, pushes the WIP, restores protected paths, replaces the clone's .git, and reports the commands, which the runner core builds for the attempt's CLI version (X-5, X-13). The person then either works in the clone with plain git and hands back from the clone, or uses the 'anywhere' commands in another clone and hands back by ref. Either way the next attempt starts from the person's commit. A clone hand-back while a process still runs in the clone is refused with process_running (X-37). The checks live in a driver module, so the live run's TTY check reuses them.

**Files:**
- Test: `packages/testkit/e2e/takeover.e2e.test.ts`
- Create: `packages/testkit/src/scenarios/takeover.ts`

- [ ] **Step 1: Write the failing test**

**File:** `packages/testkit/e2e/takeover.e2e.test.ts` (new)

```ts
// Take-over and hand-back (design 6.4, 6.12, 7.3, 8.4, 9.4), per vendor in one cluster. alice takes over T-1 while its
// agent runs a long command, checks what the runner handed her, and is refused a hand-back from the clone while a
// process still runs there; she then commits in the clone and hands back from it. She takes over a second task, runs
// the "anywhere" commands in a clone of her own, pushes to her take-over ref and hands back by ref. Either way the next
// attempt starts from her commit and submits. The checks are takeover.ts's, which the live run's TTY check reuses.
// Runs only with AGFLOW_E2E=1.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cloneTo, gitIn } from '../src/git-fixtures';
import { type Cluster, startCluster } from '../src/harness/cluster';
import { describeE2e, E2E_TEST_TIMEOUT_MS, e2eVendors } from '../src/harness/env';
import { HubCallError } from '../src/harness/person';
import { expectPassed, RAN_TO_END, type ScenarioResult } from '../src/scenarios/result';
import { handbackChecks, readyForTakeover, TAKEOVER, takeoverChecks } from '../src/scenarios/takeover';

setDefaultTimeout(E2E_TEST_TIMEOUT_MS);

const named = TAKEOVER.checks;

/** Every take-over check: a ref hand-back's task is checked as a whole. */
const TAKEOVER_CHECKS = [
  named.blocked,
  named.handoff,
  named.ended,
  named.local,
  named.anywhere,
  named.ref,
  named.gitReplaced,
  named.uncommitted,
  named.forensics,
  RAN_TO_END,
];

/**
 * Runs one line of the "anywhere" commands as a person's shell would, in their clone, with no global or system git
 * configuration: the clone's own config holds the fixture identity, and origin is its remote.
 */
async function runLine(dir: string, line: string): Promise<void> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !name.startsWith('GIT_')) env[name] = value;
  }
  const proc = Bun.spawn(['/bin/sh', '-c', line], {
    cwd: dir,
    env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`${line} exited ${code} in ${dir}: ${stderr.trim()}`);
}

describeE2e('take-over and hand-back', () => {
  for (const vendor of e2eVendors()) {
    describe(vendor, () => {
      let started: Cluster | null = null;
      let taken: { taskId: string; attemptId: string } | null = null;
      let checked: ScenarioResult | null = null;
      const cluster = (): Cluster => {
        if (started === null) throw new Error('the cluster did not start');
        return started;
      };
      const takenOver = () => {
        if (taken === null) throw new Error('the first test took nothing over');
        return taken;
      };
      const result = (): ScenarioResult => {
        if (checked === null) throw new Error('the take-over was not checked');
        return checked;
      };

      beforeAll(async () => {
        started = await startCluster({ vendor });
        const cluster = started;
        taken = await cluster.step(() => readyForTakeover(cluster));
      });

      afterAll(async () => {
        await started?.close();
      });

      test('POST /api/tasks/:id/takeover answers 202, the task is blocked as a take-over, and a1 writes a handoff note before it stops', () =>
        cluster().step(async () => {
          const { person } = cluster();
          const { taskId, attemptId } = takenOver();
          expect(await person.takeover(taskId)).toBe(attemptId);
          const { task } = await person.task(taskId);
          expect([task.status, task.blockedKind]).toEqual(['blocked', 'takeover']);
          checked = await takeoverChecks(cluster(), { taskId, attemptId, login: person.login });
          expectPassed(result(), [named.blocked, named.handoff]);
        }));

      test("a1 ends taken_over; the commands resume its session with its CLI version's binary, fetch its WIP ref, and push to alice's take-over ref", () =>
        cluster().step(async () => expectPassed(result(), [named.ended, named.local, named.anywhere, named.ref])));

      test("the clone's .git is a new repository at the harvested head, and the agent's old .git is in forensics/<attempt>/", () =>
        cluster().step(async () =>
          expectPassed(result(), [named.gitReplaced, named.uncommitted, named.forensics, RAN_TO_END]),
        ));

      test("unblocking the taken-over task answers 409 'hand it back instead'", () =>
        cluster().step(async () => {
          const { taskId } = takenOver();
          const refused = await cluster()
            .person.unblock(taskId)
            .then(
              () => null,
              (error: unknown) => error,
            );
          expect(refused).toBeInstanceOf(HubCallError);
          expect((refused as HubCallError).status).toBe(409);
          expect((refused as HubCallError).body).toContain('hand it back instead');
        }));

      test('a clone hand-back while a process runs in the clone is refused with process_running; after it exits and alice commits, a clone hand-back makes the task ready from late work, and a2 starts from it and submits', () =>
        cluster().step(async () => {
          const { person, waitFor } = cluster();
          const { taskId, attemptId } = takenOver();
          const clone = (await cluster().runnerOf(attemptId)).clonePath(attemptId);
          // alice's own process, still running in the clone.
          const running = Bun.spawn(['sleep', '600'], {
            cwd: clone,
            stdin: 'ignore',
            stdout: 'ignore',
            stderr: 'ignore',
          });
          try {
            expect(await person.handback(taskId, 'clone')).toBe(attemptId);
            const refused = await waitFor(`the refused hand-back of ${attemptId}`, async () => {
              const { attempt } = await person.attempt(attemptId);
              return attempt.takeover?.error?.startsWith('process_running') ? attempt : null;
            });
            expect(refused.takeover?.error).toContain(String(running.pid));
            expect(refused.takeover?.handingBack).toBeNull();
            const { task } = await person.task(taskId);
            expect([task.status, task.blockedKind]).toEqual(['blocked', 'takeover']);
          } finally {
            running.kill('SIGKILL');
            await running.exited;
          }
          // alice commits a1's uncommitted b.txt with plain git, and hands back from the clone again.
          await gitIn(clone, ['add', 'b.txt']);
          await gitIn(clone, ['commit', '-q', '-m', 'Add b.txt']);
          const commit = await gitIn(clone, ['rev-parse', 'HEAD']);
          expect(await person.handback(taskId, 'clone')).toBe(attemptId);
          expectPassed(await handbackChecks(cluster(), { taskId, attemptId, source: 'clone', commit }));
        }));

      test("a hand-back by ref, after the anywhere commands in alice's own clone and a push to her take-over ref, makes that sha the work position; a2 starts from it and submits", () =>
        cluster().step(async () => {
          const { person, origin } = cluster();
          const { taskId, attemptId } = await readyForTakeover(cluster());
          expect(await person.takeover(taskId)).toBe(attemptId);
          expectPassed(await takeoverChecks(cluster(), { taskId, attemptId, login: person.login }), TAKEOVER_CHECKS);
          const { takeover } = (await person.attempt(attemptId)).attempt;
          if (takeover === null) throw new Error(`${attemptId} has no take-over record`);
          const [fetch, push] = takeover.anywhere.split('\n');
          if (fetch === undefined || push === undefined) throw new Error(`not two commands: ${takeover.anywhere}`);
          const own = await cloneTo(origin.path, join(cluster().dir, 'alice-anywhere'));
          await runLine(own, fetch);
          writeFileSync(join(own, 'alice.txt'), 'alice\n');
          await gitIn(own, ['add', 'alice.txt']);
          await gitIn(own, ['commit', '-q', '-m', 'Add alice.txt']);
          await runLine(own, push);
          const sha = await gitIn(own, ['rev-parse', 'HEAD']);
          expect(await person.handback(taskId, { ref: takeover.ref, sha })).toBe(attemptId);
          const source = { ref: takeover.ref, sha };
          expectPassed(await handbackChecks(cluster(), { taskId, attemptId, source, commit: sha }));
        }));
    });
  }
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `bun test packages/testkit/e2e/takeover.e2e.test.ts`
Expected: FAIL — `error: Cannot find module '../src/scenarios/takeover' from '.../packages/testkit/e2e/takeover.e2e.test.ts'` (0 pass, 1 fail; parent-tree check, 2026-11-11).

- [ ] **Step 3: Implement**

**File:** `packages/testkit/src/scenarios/takeover.ts` (new)

```ts
// Take-over and hand-back (design 6.4, 6.12, 7.3, 8.4, 9.4). A person takes over a running attempt: the runner gets
// a handoff note, stops the agent, pushes the WIP, restores the protected paths, replaces the clone's .git and reports
// the commands, which the runner core builds for the attempt's CLI version (X-5, X-13). The person works in the clone with
// plain git and hands back from it, or runs the "anywhere" commands in another clone and hands back by ref; either way
// the next attempt starts from the person's commit. The checks live here, so the e2e test and the live run's TTY
// check, where a real person takes over in the browser and resumes in a terminal, read the same verdicts.
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import {
  attemptId,
  DEFAULT_WIP_REF_PREFIX,
  type HubEvent,
  type NewTaskInput,
  parseAttemptId,
  takeoverRef,
} from '@agflow/core';
import { handoffPrompt } from '@agflow/runner/src/attempt/stop';
import { TAKEOVER_STOP_REASON } from '@agflow/runner/src/attempt/takeover';
import { vendorHomes } from '@agflow/runner/src/config';
import { VENDOR_PINS, vendorBinary } from '@agflow/runner/src/vendor/pins';
import { fileAt, gitIn, isAncestor, refSha } from '../git-fixtures';
import type { Cluster } from '../harness/cluster';
import { E2E_PLATFORM } from '../harness/env';
import { sessionOf } from '../harness/models';
import type { HandbackSource } from '../harness/person';
import { BASH_MAX_TIMEOUT_MS, type Programs, react, say, shell, tool } from '../harness/playbook';
import { type ProcessInfo, processesInDir } from '../harness/proc';
import {
  checks,
  cloneFile,
  type Recorder,
  type ScenarioOptions,
  type ScenarioResult,
  SNAPSHOT_SUBJECT,
  shown,
} from './result';

/** The command a1 is inside when the person takes over; it would run for 10 minutes. */
const LONG_COMMAND = 'sleep 600';

/** What a1's handoff note says, word for word in a scripted run. */
const HANDOFF = 'a.txt is committed. b.txt is written but not committed yet. Next: commit b.txt, add c.txt and submit.';

/** The runner's take-over handoff turn: a scripted a1 writes its note when it is shown it. */
const HANDOFF_TURN = handoffPrompt(TAKEOVER_STOP_REASON);

const TASK: NewTaskInput = {
  title: 'Add a.txt, b.txt and c.txt around a take-over',
  objective: [
    "This task tests agflow's take-over. Follow these steps exactly, in your task branch.",
    'If your brief has no handoff note from a previous attempt:',
    '1. Create a.txt holding the line "a" and commit it.',
    '2. Create b.txt holding the line "b". Do not commit it.',
    `3. Run \`${LONG_COMMAND}\` in the foreground with a 10-minute timeout and wait for it. A person takes the task ` +
      'over during it.',
    `4. When agflow asks you for a handoff note, call write_handoff with this task's id and the note: ${HANDOFF}`,
    'If your brief has a handoff note: create c.txt holding the line "c", commit it, and submit.',
  ].join('\n'),
  acceptance: [{ id: 'files', assertion: 'c.txt holds the line c, on top of the work handed back' }],
};

/** The checks takeoverChecks and handbackChecks make, by name; the e2e test reads them in groups. */
const CHECKS = {
  blocked: 'the task stays blocked as taken over by the person',
  handoff: 'a1 writes a handoff note before it stops',
  ended: 'a1 ends taken_over, with no take-over error',
  local:
    "attempt.takeover.local resumes a1's session with the runner's pinned binary of a1's CLI version and its vendor home",
  anywhere: 'attempt.takeover.anywhere fetches the WIP ref onto the task branch and pushes to the take-over ref',
  ref: "attempt.takeover.ref is the person's take-over ref",
  gitReplaced:
    "the clone's .git is a new repository, a shared clone of the vault, at the harvested head on the task branch",
  uncommitted:
    "the clone shows a1's uncommitted b.txt as a change, and none of a1's committed files as changed",
  forensics: "a1's old .git is in the runner's forensics/<attempt>/ directory",
  handedBack: 'the hand-back makes the task ready from the source it names',
  position: "the work position holds the person's commit, and no late work is recorded for a1",
  startSha: 'the next attempt starts from the work position',
  submitted: "the next attempt submits a branch holding the person's commit",
} as const;

function programs(taskId: string): Programs {
  return {
    [attemptId(taskId, 1, 1)]: {
      steps: [
        say(
          'I add a.txt and commit it.',
          shell("printf 'a\\n' > a.txt && git add a.txt && git commit -q -m 'Add a.txt'"),
        ),
        say('I start b.txt and leave it uncommitted for now.', shell("printf 'b\\n' > b.txt")),
        say('I run the long command.', shell(LONG_COMMAND, { timeoutMs: BASH_MAX_TIMEOUT_MS })),
      ],
      reactions: [
        react(HANDOFF_TURN, [
          say('I write my handoff note.', tool('write_handoff', { task_id: taskId, note: HANDOFF })),
        ]),
      ],
    },
    [attemptId(taskId, 2, 1)]: {
      steps: [
        say(
          'I add c.txt and commit it.',
          shell("printf 'c\\n' > c.txt && git add c.txt && git commit -q -m 'Add c.txt'"),
        ),
        say(
          'I submit the task.',
          tool('submit', { task_id: taskId, summary: 'c.txt is in, on the work handed back.' }),
        ),
      ],
    },
  };
}

/** The task for live runs, the programs for scripted runs, and the names of the checks. */
export const TAKEOVER = {
  scenario: 'take-over',
  task: TASK,
  handoff: HANDOFF,
  longCommand: LONG_COMMAND,
  programs,
  checks: CHECKS,
} as const;

/** The attempt a person takes over, and who. */
export interface TakeoverInput {
  taskId: string;
  attemptId: string;
  /** The login of the person who took it over. */
  login: string;
}

/** A hand-back of a taken-over attempt, and the commit the person made before it. */
export interface HandbackInput {
  taskId: string;
  /** The attempt that was taken over. */
  attemptId: string;
  source: HandbackSource;
  /** The person's commit, which the work position and the next attempt's branch must hold. */
  commit: string;
}

/** How readyForTakeover runs: a scenario's options, and how it finds the processes in a1's clone. */
export interface TakeoverOptions extends ScenarioOptions {
  /** processesInDir (lsof) by default; a unit test with a stand-in cluster passes its own. */
  processesIn?: (dir: string) => Promise<ProcessInfo[]>;
}

/**
 * Creates the task and waits until a1 committed a.txt, left b.txt uncommitted and runs its long command: a person can
 * take it over now. With scripted models it registers both attempts' programs first.
 */
export async function readyForTakeover(
  cluster: Cluster,
  options: TakeoverOptions = {},
): Promise<{ taskId: string; attemptId: string }> {
  const processesIn = options.processesIn ?? processesInDir;
  const { person, models, waitFor, waitForEvent } = cluster;
  const [task] = await person.createTasks([TASK]);
  if (!task) throw new Error('the hub created no task');
  const a1 = attemptId(task.id, 1, 1);
  if (options.scripted !== false) models.addPrograms(programs(task.id));
  await waitForEvent({ type: 'attempt.running', subject: task.id, attemptId: a1 });
  const clone = (await cluster.runnerOf(a1)).clonePath(a1);
  await waitFor(`b.txt in ${a1}'s clone`, async () => cloneFile(clone, 'b.txt') !== null);
  await waitFor(`${LONG_COMMAND} in ${a1}'s clone`, async () =>
    (await processesIn(clone)).some((row) => row.command.includes(LONG_COMMAND)),
  );
  return { taskId: task.id, attemptId: a1 };
}

/**
 * Checks a take-over once the person asked for it and before they change the clone: it waits for the attempt to end,
 * then reads the hub, origin, the runner's files and the clone's new .git.
 */
export function takeoverChecks(
  cluster: Cluster,
  input: TakeoverInput,
  options: ScenarioOptions = {},
): Promise<ScenarioResult> {
  return checks(
    TAKEOVER.scenario,
    cluster.vendor,
    (record) => checkTakeover(cluster, input, options, record),
    cluster.dump,
  );
}

/**
 * Checks a hand-back once the person asked for it: the task goes ready from the source, the next attempt starts from
 * the work position, and submits a branch holding the person's commit and c.txt. Live and scripted runs check alike.
 */
export function handbackChecks(cluster: Cluster, input: HandbackInput): Promise<ScenarioResult> {
  const scenario = `hand-back ${input.source === 'clone' ? 'from the clone' : 'by ref'}`;
  return checks(scenario, cluster.vendor, (record) => checkHandback(cluster, input, record), cluster.dump);
}

async function checkTakeover(
  cluster: Cluster,
  input: TakeoverInput,
  options: ScenarioOptions,
  record: Recorder,
): Promise<void> {
  const { person, origin, models, waitForEvent } = cluster;
  const scripted = options.scripted !== false;
  const { taskId, attemptId: a1, login } = input;
  await waitForEvent({ type: 'attempt.ended', subject: taskId, attemptId: a1 });
  const { attempt } = await person.attempt(a1);
  const { task, notes } = await person.task(taskId);
  record.equal(
    CHECKS.blocked,
    [task.status, task.blockedKind, task.blockedReason],
    ['blocked', 'takeover', `taken over by ${login}`],
  );
  const note = notes.find((entry) => entry.kind === 'handoff' && entry.attemptId === a1);
  record.check(
    CHECKS.handoff,
    note !== undefined &&
      note.author === `agent:${attempt.agentId}` &&
      note.createdAt <= (attempt.endedAt ?? 0) &&
      (scripted ? note.body === HANDOFF : note.body !== ''),
    note === undefined
      ? `${a1} wrote no handoff note`
      : `${note.author} at ${note.createdAt}, ended at ${attempt.endedAt}: ${shown(note.body)}`,
  );
  record.equal(
    CHECKS.ended,
    [attempt.status, attempt.endReason, attempt.takeover?.error ?? null],
    ['ended', 'taken_over', null],
  );

  // The commands: the pinned binary of a1's CLI version under the runner's home, with its vendor home and a1's session.
  const runner = await cluster.runnerOf(a1);
  const { paths, config } = runner.home;
  const clone = runner.clonePath(a1);
  const pins = VENDOR_PINS[E2E_PLATFORM];
  if (!pins) throw new Error(`VENDOR_PINS has no ${E2E_PLATFORM} entry`);
  const binary = join(paths.runner, vendorBinary(attempt.vendor, pins[attempt.vendor].version));
  const home = vendorHomes(config, paths)[attempt.vendor];
  const session = attempt.sessionRef;
  const resume =
    attempt.vendor === 'claude'
      ? `CLAUDE_CONFIG_DIR=${home} ${binary} --resume ${session}`
      : `CODEX_HOME=${home} ${binary} resume --no-daemon ${session}`;
  const local = `cd ${clone} && ${resume}`;
  // With scripted models, the session is the one a1's requests carried; real models record none.
  const seen = scripted ? [...new Set(models.requestsFor(a1).map(sessionOf))] : [];
  record.check(
    CHECKS.local,
    session !== null && attempt.takeover?.local === local && (!scripted || seen.includes(session)),
    `got ${shown(attempt.takeover?.local)}, expected ${shown(local)}; sessions seen ${shown(seen)}`,
  );
  const ref = takeoverRef(DEFAULT_WIP_REF_PREFIX, taskId, login);
  const anywhere =
    `git fetch origin ${attempt.wipRef} && git switch -c ${task.branch} FETCH_HEAD\n` + `git push origin HEAD:${ref}`;
  record.equal(CHECKS.anywhere, attempt.takeover?.anywhere, anywhere);
  record.equal(CHECKS.ref, attempt.takeover?.ref, ref);

  // The clone's .git: the runner's own, at the head it harvested, which the final WIP holds (under its snapshot).
  const wip = attempt.wipRef === null ? null : await refSha(origin.path, attempt.wipRef);
  let head: string | null = null;
  if (wip !== null) {
    const subject = await gitIn(origin.path, ['log', '-1', '--format=%s', wip]);
    head = subject.startsWith(SNAPSHOT_SUBJECT) ? await gitIn(origin.path, ['rev-parse', `${wip}^`]) : wip;
  }
  const moved = join(paths.forensics(a1), 'git');
  const isDir = lstatSync(moved, { throwIfNoEntry: false })?.isDirectory() === true;
  const hasHead = lstatSync(join(moved, 'HEAD'), { throwIfNoEntry: false })?.isFile() === true;
  // git in the clone reads the repository's config, which runs programs (core.fsmonitor, clean filters) with the
  // owner's rights. Until the runner has moved the agent's .git aside and built its own, the agent's is still there.
  const dotGit = lstatSync(join(clone, '.git'), { throwIfNoEntry: false });
  const replaced =
    isDir &&
    hasHead &&
    dotGit?.isDirectory() === true &&
    attempt.takeover?.local != null &&
    attempt.takeover.error === null;
  if (replaced) {
    const cloneHead = await gitIn(clone, ['rev-parse', 'HEAD'], { allowFailure: true });
    const branch = await gitIn(clone, ['symbolic-ref', 'HEAD'], { allowFailure: true });
    const alternates = cloneFile(clone, '.git/objects/info/alternates') ?? '';
    record.check(
      CHECKS.gitReplaced,
      wip === attempt.wipSha &&
        head !== null &&
        cloneHead === head &&
        branch === `refs/heads/${task.branch}` &&
        alternates.includes(paths.vaults),
      `WIP ${wip} (hub ${attempt.wipSha}), harvested head ${head}; the clone's HEAD ${cloneHead} on ${branch}; ` +
        `alternates ${shown(alternates.trim())}`,
    );
    const status = await gitIn(
      clone,
      ['-c', 'core.fsmonitor=false', '--no-optional-locks', 'status', '--porcelain'],
      { allowFailure: true },
    );
    // A rebuilt index shows only b.txt: an index left empty would show every committed file as deleted and untracked.
    const lines = status.split('\n').filter((line) => line !== '');
    const tracked = new Set(
      (await gitIn(clone, ['ls-tree', '-r', '--name-only', 'HEAD'], { allowFailure: true })).split('\n'),
    );
    record.check(
      CHECKS.uncommitted,
      lines.includes('?? b.txt') && lines.every((line) => !tracked.has(line.slice(3))),
      `git status: ${shown(status)}`,
    );
  } else {
    const kind = dotGit === undefined ? 'missing' : dotGit.isDirectory() ? 'a directory' : 'not a directory';
    const why =
      `not run: the runner did not replace the clone's .git (.git ${kind}, moved .git ${isDir && hasHead}; ` +
      `local ${shown(attempt.takeover?.local ?? null)}, error ${shown(attempt.takeover?.error ?? null)})`;
    record.check(CHECKS.gitReplaced, false, why);
    record.check(CHECKS.uncommitted, false, why);
  }
  record.check(CHECKS.forensics, isDir && hasHead, `${moved}: directory ${isDir}, HEAD ${hasHead}`);
}

async function checkHandback(cluster: Cluster, input: HandbackInput, record: Recorder): Promise<void> {
  const { person, origin, waitFor, waitForEvent } = cluster;
  const { taskId, attemptId: a1, source, commit } = input;
  const parsed = parseAttemptId(a1);
  if (parsed === null) throw new Error(`not an attempt id: ${a1}`);
  const kind = source === 'clone' ? 'clone' : 'ref';
  const handed = await waitForEvent({ type: 'task.handed_back', subject: taskId, data: { attemptId: a1 } });
  // The same transaction moves the task to ready, just before task.handed_back.
  const ready = await waitForEvent({ type: 'task.ready', subject: taskId, data: { from: 'blocked', attemptId: a1 } });
  const ref = String(handed.data.ref);
  const sha = String(handed.data.sha);
  record.check(
    CHECKS.handedBack,
    handed.data.source === kind && ready.id <= handed.id,
    `task.handed_back #${handed.id} ${shown(handed.data)}; task.ready #${ready.id}`,
  );
  const { attempt } = await person.attempt(a1);
  const lateWork = (await person.events({ subject: taskId, limit: 1000 })).filter(
    (event: HubEvent) => event.type === 'attempt.late_work' && event.data.attemptId === a1,
  );
  const onOrigin = await refSha(origin.path, ref);
  const holds = onOrigin === sha && (await isAncestor(origin.path, commit, sha));
  const where =
    source === 'clone'
      ? ref.startsWith(`${attempt.wipRef}-late-`)
      : ref === source.ref && sha === source.sha && sha === commit;
  record.check(
    CHECKS.position,
    holds && where && lateWork.length === 0,
    `${ref} at ${sha} (origin ${onOrigin}), person's commit ${commit}; ` +
      `late work ${lateWork.map((event) => `#${event.id}`).join(', ') || 'none'}`,
  );

  // The next attempt starts from that position and submits on top of it.
  const next = attemptId(taskId, parsed.number + 1, parsed.epoch);
  const started = await waitFor(`${next}'s start`, async () => {
    const found = await person.attempt(next).catch(() => null);
    return found?.attempt.startSha ? found.attempt : null;
  });
  record.equal(CHECKS.startSha, started.startSha, sha);
  const submitted = await waitForEvent({ type: 'submission.recorded', subject: taskId, attemptId: next });
  const head = await refSha(origin.path, `refs/heads/${String(submitted.data.branch)}`);
  // The next attempt adds c.txt, as its program or the task's steps say.
  const added = head === null ? null : await fileAt(origin.path, head, 'c.txt');
  record.check(
    CHECKS.submitted,
    head !== null &&
      head === submitted.data.headSha &&
      (await isAncestor(origin.path, commit, head)) &&
      added === 'c\n',
    `branch ${String(submitted.data.branch)} at ${head} (submitted ${String(submitted.data.headSha)}); ` +
      `c.txt ${shown(added)}`,
  );
}
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `bun test packages/testkit/e2e/takeover.e2e.test.ts && AGFLOW_E2E=1 caffeinate -i bun test --timeout 600000 packages/testkit/e2e/takeover.e2e.test.ts && bun run typecheck`
Expected: all selected tests pass (0 fail); tsc exits 0; the gated cases run for both vendors against scripted servers.

The final tests-only parent copy fails on the missing takeover driver. The original report’s “no tests found” was not sufficient red evidence. Review removed git read-tree temporarily and proved that the strengthened index check fails; the base implementation was restored. takeoverChecks runs before person edits and never runs git until successful handover and replacement .git are proven. TakeoverOptions.processesIn is an injectable lookup seam for Task 16’s portable refusal unit test; real e2e still uses lsof and a real process_running refusal. See Decisions 57–59.

- [ ] **Step 5: Commit**

```bash
git add -A 'packages/testkit/e2e/takeover.e2e.test.ts' 'packages/testkit/src/scenarios/takeover.ts'
git commit -m 'M2G Task 14: Take-over and hand-back' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

### Task 15: Live run: clusters with real models

Design sections 1 and 15 require the exit scenarios to pass once with real subscriptions. The harness gains a real-model mode: ClusterOptions.models (RealModels) starts no scripted servers and no refusing proxy, and prepareRunnerHome then writes a test block with only allowShortTimings and points every runner at the person's logged-in runner vendor homes, pinned binaries and recorded connectivity variables from one `agflow runner setup` (X-43: one Mac, three AGFLOW_HOMEs); the runner process gets those variables, as its LaunchAgent would. checkVendorHome confirms a login with M2c's claudeLoginStatus and codexLoginStatus, which never send a prompt. The scenario drivers run unchanged, with task texts that tell a real model what the scripted programs do. formatResults renders the checks as a markdown table and as results.json.

**Files:**
- Modify: `packages/testkit/src/harness/cluster.ts`
- Modify: `packages/testkit/src/harness/runner-process.ts`
- Create: `packages/testkit/src/live.ts`
- Test: `packages/testkit/test/live.test.ts`

- [ ] **Step 1: Write the failing test**

**File:** `packages/testkit/test/live.test.ts` (new)

```ts
import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Vendor } from '@agflow/core';
import { loadRunnerConfig, saveRunnerConfig } from '@agflow/runner/src/config';
import { runnerPaths } from '@agflow/runner/src/paths';
import { createRunnerConfig } from '@agflow/runner/src/service/runner-json';
import { VENDOR_PINS, vendorBinary } from '@agflow/runner/src/vendor/pins';
import { cloneTo, commitFiles, fileAt, gitIn, originRepo, refSha } from '../src/git-fixtures';
import { noScriptedModels, REMOTE_MAIN_SUBJECT, remoteOrigin } from '../src/harness/cluster';
import { E2E_PLATFORM } from '../src/harness/env';
import { prepareRunnerHome, type RunnerHome } from '../src/harness/runner-process';
import {
  checkVendorHome,
  formatResults,
  LIVE_GOAL,
  LIVE_OPTIONS,
  LIVE_SCENARIOS,
  LIVE_WAIT_MS,
  type LiveDefaults,
  liveClusterOptions,
  liveDefaults,
  liveUsage,
  parseLiveArgs,
  toyRepoFiles,
} from '../src/live';
import { CLOSED_LAPTOP } from '../src/scenarios/closed-laptop';
import { KILLED_AGENT } from '../src/scenarios/killed-agent';
import { LOST_LEAD } from '../src/scenarios/lost-lead';
import type { ScenarioResult } from '../src/scenarios/result';
import { TAKEOVER } from '../src/scenarios/takeover';

const dirs: string[] = [];
const homes: RunnerHome[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) home.remove();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A temporary directory at its real path: vendor homes must be real paths. */
function tmpDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join('/tmp', prefix)));
  dirs.push(dir);
  return dir;
}

/** For tests that run git, bun or a fake CLI several times: a loaded machine takes longer than bun's 5 s. */
const SPAWNS_MS = 30_000;

const PINS = VENDOR_PINS[E2E_PLATFORM];
if (!PINS) throw new Error(`no ${E2E_PLATFORM} pins`);

const DEFAULTS: LiveDefaults = {
  agflowHome: '/Users/alice/.agflow',
  claudeHome: '/Users/alice/.agflow/runner/homes/claude',
  codexHome: '/Users/alice/.agflow/runner/homes/codex',
  connectivity: {},
};

describe('parseLiveArgs', () => {
  test('gives the defaults without options: both vendors, every scenario, a local origin', () => {
    expect(parseLiveArgs([], DEFAULTS)).toEqual({
      help: false,
      ...DEFAULTS,
      runners: ['claude', 'codex'],
      scenarios: [...LIVE_SCENARIOS],
      repo: null,
      takeover: [],
      keep: false,
    });
    expect(LIVE_SCENARIOS).toEqual(['killed-agent', 'closed-laptop', 'lost-lead']);
  });

  test('reads --claude-home, --codex-home, --runners, --scenarios, --repo, --takeover and --keep', () => {
    const argv = [
      '--claude-home',
      '/Users/alice/homes/claude',
      '--codex-home=/Users/alice/homes/codex',
      '--runners',
      'codex',
      '--scenarios',
      'lost-lead,killed-agent,lost-lead',
      '--repo',
      'git@github.com:alice/agflow-toy.git',
      '--takeover',
      'claude,codex',
      '--keep',
    ];
    expect(parseLiveArgs(argv, DEFAULTS)).toEqual({
      help: false,
      agflowHome: DEFAULTS.agflowHome,
      claudeHome: '/Users/alice/homes/claude',
      codexHome: '/Users/alice/homes/codex',
      connectivity: {},
      runners: ['codex'],
      scenarios: ['lost-lead', 'killed-agent'],
      repo: 'git@github.com:alice/agflow-toy.git',
      takeover: ['claude', 'codex'],
      keep: true,
    });
    expect(parseLiveArgs(['--takeover=codex'], DEFAULTS).takeover).toEqual(['codex']);
    expect(parseLiveArgs(['--help'], DEFAULTS).help).toBe(true);
  });

  test('refuses unknown scenarios, vendors and options, and an option without its value', () => {
    expect(() => parseLiveArgs(['--scenarios', 'killed-agent,lost-laptop'], DEFAULTS)).toThrow(
      "unknown scenario 'lost-laptop'",
    );
    expect(() => parseLiveArgs(['--scenarios', ''], DEFAULTS)).toThrow('--scenarios names no scenario');
    expect(() => parseLiveArgs(['--runners', 'claude,gemini'], DEFAULTS)).toThrow("unknown vendor 'gemini'");
    expect(() => parseLiveArgs(['--takeover', 'claude,gemini'], DEFAULTS)).toThrow("unknown vendor 'gemini'");
    expect(() => parseLiveArgs(['--takeover', ','], DEFAULTS)).toThrow('--takeover names no vendor');
    expect(() => parseLiveArgs(['--bogus'], DEFAULTS)).toThrow('unknown option --bogus');
    expect(() => parseLiveArgs(['--repo'], DEFAULTS)).toThrow('--repo needs a value');
    expect(() => parseLiveArgs(['--keep=yes'], DEFAULTS)).toThrow('--keep takes no value');
    expect(() => parseLiveArgs(['killed-agent'], DEFAULTS)).toThrow("unexpected argument 'killed-agent'");
  });

  test('the usage names every option', () => {
    const usage = liveUsage();
    expect(LIVE_OPTIONS.map((option) => option.flag)).toEqual([
      '--claude-home',
      '--codex-home',
      '--runners',
      '--scenarios',
      '--repo',
      '--takeover',
      '--keep',
      '--help',
    ]);
    for (const option of LIVE_OPTIONS) expect(usage).toContain(option.flag);
  });
});

describe('liveDefaults', () => {
  test("come from the AGFLOW_HOME's runner directory: the layout's vendor homes without a runner.json", () => {
    const home = tmpDir('agf-live-');
    expect(liveDefaults(home)).toEqual({
      agflowHome: home,
      claudeHome: join(home, 'runner', 'homes', 'claude'),
      codexHome: join(home, 'runner', 'homes', 'codex'),
      connectivity: {},
    });
  });

  test("and runner.json's vendor homes and connectivity variables once setup recorded them", () => {
    const home = tmpDir('agf-live-');
    const recorded = { claude: join(tmpDir('agf-ch-'), 'claude'), codex: join(tmpDir('agf-xh-'), 'codex') };
    for (const path of Object.values(recorded)) mkdirSync(path);
    const config = createRunnerConfig({
      machineId: 'machine',
      name: 'alice-mac',
      capturedPath: '/usr/bin:/bin',
      connectivity: { HTTPS_PROXY: 'http://proxy.corp:3128', NODE_EXTRA_CA_CERTS: '/etc/corp-ca.pem' },
      commitIdentity: null,
      homes: recorded,
    });
    saveRunnerConfig(runnerPaths(home).config, config);
    expect(liveDefaults(home)).toEqual({
      agflowHome: home,
      claudeHome: recorded.claude,
      codexHome: recorded.codex,
      connectivity: { HTTPS_PROXY: 'http://proxy.corp:3128', NODE_EXTRA_CA_CERTS: '/etc/corp-ca.pem' },
    });
  });
});

describe('liveClusterOptions', () => {
  test("real models on the person's vendor homes, HOME, connectivity and pinned binaries, the toy repository and long waits", () => {
    const connectivity = { NODE_EXTRA_CA_CERTS: '/etc/corp-ca.pem' };
    const args = parseLiveArgs(['--repo', 'git@github.com:alice/agflow-toy.git'], { ...DEFAULTS, connectivity });
    const binaries = {
      claude: join(DEFAULTS.agflowHome, 'runner', vendorBinary('claude', PINS.claude.version)),
      codex: join(DEFAULTS.agflowHome, 'runner', vendorBinary('codex', PINS.codex.version)),
    };
    expect(liveClusterOptions(args, 'codex', 'killed-agent')).toEqual({
      vendor: 'codex',
      models: {
        kind: 'real',
        homes: { claude: DEFAULTS.claudeHome, codex: DEFAULTS.codexHome },
        home: homedir(),
        connectivity,
      },
      binaries,
      files: toyRepoFiles(),
      repo: 'git@github.com:alice/agflow-toy.git',
      runnerLeads: false,
      goal: LIVE_GOAL,
      waitMs: LIVE_WAIT_MS,
    });
    // The lost lead needs a runner lead that follows its goal.
    expect(liveClusterOptions(args, 'claude', 'lost-lead')).toMatchObject({ runnerLeads: true, goal: LOST_LEAD.goal });
    expect(liveClusterOptions(parseLiveArgs([], DEFAULTS), 'claude', 'closed-laptop').repo).toBeUndefined();
  });
});

describe('prepareRunnerHome with real models', () => {
  test("writes a test block with only allowShortTimings, uses the given homes and binaries, and the person's connectivity but no proxy", async () => {
    const person = tmpDir('agf-person-');
    const vendorHomes = { claude: join(person, 'homes', 'claude'), codex: join(person, 'homes', 'codex') };
    for (const path of Object.values(vendorHomes)) mkdirSync(path, { recursive: true });
    // The person's pinned binaries, as setup installs them.
    const binaries = {
      claude: join(person, 'runner', vendorBinary('claude', PINS.claude.version)),
      codex: join(person, 'runner', vendorBinary('codex', PINS.codex.version)),
    };
    for (const file of Object.values(binaries)) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, '#!/bin/sh\nexit 0\n');
      chmodSync(file, 0o755);
    }
    // The person's setup recorded a CA bundle and no proxy.
    const ca = join(person, 'corp-ca.pem');
    const saved = process.env.SSH_AUTH_SOCK;
    process.env.SSH_AUTH_SOCK = '/private/tmp/ssh-agent.sock';
    let home: RunnerHome;
    try {
      home = await prepareRunnerHome({
        dir: join(tmpDir('agf-rh-'), 'alice'),
        name: 'alice-mac',
        credentials: { hubUrl: 'http://127.0.0.1:4000', token: 'agf_cli_token', user: 'alice' },
        vendors: ['claude', 'codex'],
        binaries,
        models: { kind: 'real', homes: vendorHomes, home: person, connectivity: { NODE_EXTRA_CA_CERTS: ca } },
      });
    } finally {
      if (saved === undefined) delete process.env.SSH_AUTH_SOCK;
      else process.env.SSH_AUTH_SOCK = saved;
    }
    homes.push(home);
    const config = loadRunnerConfig(home.paths.config, { AGFLOW_TEST: '1' });
    expect(config.test).toEqual({ claudeEnv: {}, codexConfig: {}, skipAuthChecks: false, allowShortTimings: true });
    const written = JSON.parse(readFileSync(home.paths.config, 'utf8')) as { test: Record<string, unknown> };
    expect(written.test.allowShortTimings).toBe(true);
    expect(written.test.skipAuthChecks).toBe(false);
    expect(config.homes).toEqual(vendorHomes);
    expect(config.connectivity).toEqual({ NODE_EXTRA_CA_CERTS: ca });
    for (const vendor of ['claude', 'codex'] as const) {
      const linked = join(home.paths.runner, vendorBinary(vendor, PINS[vendor].version));
      expect(realpathSync(linked)).toBe(realpathSync(binaries[vendor]));
    }
    // The person's HOME and SSH agent, as in production; still a runner home and CLI config of its own.
    expect(home.home).toBe(person);
    expect(home.env).toMatchObject({
      HOME: person,
      SSH_AUTH_SOCK: '/private/tmp/ssh-agent.sock',
      NODE_EXTRA_CA_CERTS: ca,
      AGFLOW_TEST: '1',
    });
    expect(home.agflowHome.startsWith(`${home.dir}/`)).toBe(true);
    for (const name of ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY']) expect(home.env[name]).toBeUndefined();
    home.remove();
    homes.splice(0);
    // Removing the runner home leaves the person's HOME and vendor homes alone.
    expect(realpathSync(vendorHomes.claude)).toBe(vendorHomes.claude);
  }, SPAWNS_MS);
});

/** A fake vendor CLI at the version's place under the AGFLOW_HOME: it logs its arguments and prints the output. */
function fakeCli(agflowHome: string, vendor: Vendor, output: string, code = 0): string {
  const file = join(agflowHome, 'runner', vendorBinary(vendor, '9.9.9'));
  const log = join(agflowHome, `${vendor}-args.log`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `#!/bin/sh\necho "$@" >> '${log}'\ncat <<'EOF'\n${output}\nEOF\nexit ${code}\n`);
  chmodSync(file, 0o755);
  return log;
}

describe('checkVendorHome', () => {
  const OPTIONS = { version: '9.9.9' };

  function person(): LiveDefaults {
    const agflowHome = tmpDir('agf-live-');
    const claudeHome = join(agflowHome, 'runner', 'homes', 'claude');
    const codexHome = join(agflowHome, 'runner', 'homes', 'codex');
    for (const path of [claudeHome, codexHome]) mkdirSync(path, { recursive: true });
    return { agflowHome, claudeHome, codexHome, connectivity: {} };
  }

  test('reports a missing vendor home, and a missing binary, without running anything', async () => {
    const live = person();
    const missing = { ...live, claudeHome: join(live.agflowHome, 'nowhere') };
    expect(await checkVendorHome('claude', missing, OPTIONS)).toEqual({
      vendor: 'claude',
      home: missing.claudeHome,
      ok: false,
      detail: `${missing.claudeHome} does not exist`,
    });
    const unbuilt = await checkVendorHome('codex', live, OPTIONS);
    expect(unbuilt.ok).toBe(false);
    expect(unbuilt.detail).toContain('binary missing');
  }, SPAWNS_MS);

  test('reports a logged-out or logged-in home through claudeLoginStatus, which only asks for its status', async () => {
    const live = person();
    const log = fakeCli(live.agflowHome, 'claude', '{"loggedIn": false}', 1);
    expect(await checkVendorHome('claude', live, OPTIONS)).toEqual({
      vendor: 'claude',
      home: live.claudeHome,
      ok: false,
      detail: 'not logged in to Claude',
    });
    fakeCli(live.agflowHome, 'claude', '{"loggedIn": true, "authMethod": "claude.ai", "subscriptionType": "max"}');
    expect(await checkVendorHome('claude', live, OPTIONS)).toEqual({
      vendor: 'claude',
      home: live.claudeHome,
      ok: true,
      detail: 'logged in, plan max',
    });
    // No prompt: the binary only ever ran `auth status --json`.
    expect(readFileSync(log, 'utf8')).toBe('auth status --json\nauth status --json\n');
  }, SPAWNS_MS);

  test('reports a logged-out or logged-in home through codexLoginStatus, which only asks for its status', async () => {
    const live = person();
    const log = fakeCli(live.agflowHome, 'codex', 'Not logged in', 1);
    const loggedOut = await checkVendorHome('codex', live, OPTIONS);
    expect(loggedOut).toMatchObject({ ok: false, detail: 'not logged in to Codex' });
    fakeCli(live.agflowHome, 'codex', 'Logged in using ChatGPT');
    expect(await checkVendorHome('codex', live, OPTIONS)).toEqual({
      vendor: 'codex',
      home: live.codexHome,
      ok: true,
      detail: 'logged in',
    });
    expect(readFileSync(log, 'utf8')).toBe('login status\nlogin status\n');
  }, SPAWNS_MS);
});

describe('toyRepoFiles', () => {
  test('is a small CLI with a test and one research note, committed on main of the created origin', async () => {
    const files = toyRepoFiles();
    expect(Object.keys(files).sort()).toEqual([
      'README.md',
      'notes/research.md',
      'package.json',
      'src/cli.ts',
      'src/count.ts',
      'test/count.test.ts',
    ]);
    const origin = await originRepo(files);
    try {
      for (const [path, content] of Object.entries(files)) {
        expect(await fileAt(origin.path, 'main', path)).toBe(content);
      }
      // The CLI works and its test passes, so a live run's agents start from a green repository.
      const work = await cloneTo(origin.path, join(tmpDir('agf-toy-'), 'toy'));
      writeFileSync(join(work, 'words.txt'), 'one two  three\nfour\n');
      const spawn = { cwd: work, env: { PATH: '/usr/bin:/bin' } };
      const cli = Bun.spawnSync([process.execPath, 'src/cli.ts', 'words.txt'], spawn);
      expect(cli.stdout.toString()).toBe('4\n');
      expect(cli.exitCode).toBe(0);
      const tested = Bun.spawnSync([process.execPath, 'test'], spawn);
      expect(tested.exitCode).toBe(0);
    } finally {
      origin.remove();
    }
  }, SPAWNS_MS);
});

describe('the task texts of a live run', () => {
  test('KILLED_AGENT, CLOSED_LAPTOP, LOST_LEAD and TAKEOVER name every file and command their drivers wait for', () => {
    const killed = KILLED_AGENT.task.objective;
    for (const named of ['a.txt', 'b.txt', 'c.txt', 'write_handoff', KILLED_AGENT.handoff, KILLED_AGENT.longCommand]) {
      expect(killed).toContain(named);
    }
    const closed = CLOSED_LAPTOP.task.objective;
    for (const named of ['a.txt', 'tick.txt', 'c.txt', CLOSED_LAPTOP.tickCommand]) expect(closed).toContain(named);
    for (const named of ['write_handoff', LOST_LEAD.handoff, 'accept_task']) expect(LOST_LEAD.goal).toContain(named);
    expect(LOST_LEAD.task.objective).toContain('review.txt');
    // readyForTakeover waits for b.txt and the long command; the next attempt adds c.txt.
    const takeover = TAKEOVER.task.objective;
    for (const named of ['a.txt', 'b.txt', 'c.txt', 'write_handoff', TAKEOVER.handoff, TAKEOVER.longCommand]) {
      expect(takeover).toContain(named);
    }
  });
});

describe('formatResults', () => {
  const RESULTS: ScenarioResult[] = [
    {
      scenario: 'killed agent',
      vendor: 'claude',
      checks: [
        { name: 'a1 ends crashed, class infra', passed: true, detail: '["crashed","infra"]' },
        { name: 'the scenario ran to its end', passed: true, detail: '2 checks made' },
      ],
      passed: true,
      dump: null,
    },
    {
      scenario: 'lost lead',
      vendor: 'codex',
      checks: [{ name: 'lead-a2 takes the seat', passed: false, detail: 'a | b\nsecond line' }],
      passed: false,
      dump: '=== cluster',
    },
  ];

  test('renders a markdown table of scenario, check, result and detail; results.json holds the same data', () => {
    const { markdown, json } = formatResults(RESULTS);
    expect(markdown.split('\n').slice(0, 2)).toEqual([
      '| Scenario | Check | Result | Detail |',
      '| --- | --- | --- | --- |',
    ]);
    expect(markdown).toContain(
      '| killed agent (claude) | a1 ends crashed, class infra | passed | ["crashed","infra"] |',
    );
    // A cell keeps the table intact: pipes are escaped and lines joined.
    expect(markdown).toContain('| lost lead (codex) | lead-a2 takes the seat | FAILED | a \\| b<br>second line |');
    expect(json).toEqual({
      passed: false,
      rows: [
        {
          scenario: 'killed agent',
          vendor: 'claude',
          check: 'a1 ends crashed, class infra',
          passed: true,
          detail: '["crashed","infra"]',
        },
        {
          scenario: 'killed agent',
          vendor: 'claude',
          check: 'the scenario ran to its end',
          passed: true,
          detail: '2 checks made',
        },
        {
          scenario: 'lost lead',
          vendor: 'codex',
          check: 'lead-a2 takes the seat',
          passed: false,
          detail: 'a | b\nsecond line',
        },
      ],
    });
    expect(markdown.trim().split('\n')).toHaveLength(2 + json.rows.length);
    expect(formatResults([]).json.passed).toBe(false);
  });
});

describe('noScriptedModels', () => {
  test('records nothing and refuses programs: a live run has no scripted servers', async () => {
    const models = noScriptedModels();
    expect([models.requests(), models.requestsFor('T-1-a1'), models.unmatched(), models.externalAttempts()]).toEqual([
      [],
      [],
      [],
      [],
    ]);
    expect(models.sawText('T-1-a1', 'anything')).toBe(false);
    expect(() => models.addPrograms({})).toThrow('real models');
    expect(() => models.anthropic).toThrow('real models');
    await models.close();
  });
});

describe('remoteOrigin', () => {
  const FILES = { 'README.md': '# toy\n' };

  /** Every ref of the repository with its sha: what a mirror push would change. */
  const refsOf = (repo: string) => gitIn(repo, ['for-each-ref', '--format=%(refname) %(objectname)']);

  test('resets an empty remote to main holding the files, and its mirror follows the remote on refresh', async () => {
    const remote = await originRepo({});
    dirs.push(remote.root);
    // An empty remote: no main yet.
    await gitIn(remote.path, ['update-ref', '-d', 'refs/heads/main']);
    const mirrored = await remoteOrigin(remote.path, FILES, join(tmpDir('agf-mirror-'), 'origin'));
    const { origin } = mirrored;
    expect(await refSha(remote.path, 'refs/heads/main')).toBe(origin.mainSha);
    expect(await fileAt(origin.path, origin.mainSha, 'README.md')).toBe('# toy\n');
    expect((await gitIn(origin.path, ['log', '-1', '--format=%s', 'main'])).trim()).toBe(REMOTE_MAIN_SUBJECT);
    const pushed = await commitFiles(remote.path, { branch: 'agflow/T-1-toy', files: { 'a.txt': 'a\n' } });
    expect(await refSha(origin.path, 'refs/heads/agflow/T-1-toy')).toBeNull();
    await mirrored.refresh();
    expect(await refSha(origin.path, 'refs/heads/agflow/T-1-toy')).toBe(pushed);
  }, SPAWNS_MS);

  test('resets a remote an earlier run used, deleting its refs, and refuses one with refs no run made', async () => {
    const remote = await originRepo({});
    dirs.push(remote.root);
    await gitIn(remote.path, ['update-ref', '-d', 'refs/heads/main']);
    await remoteOrigin(remote.path, FILES, join(tmpDir('agf-mirror-'), 'origin'));
    await commitFiles(remote.path, { branch: 'agflow/T-1-toy', files: { 'a.txt': 'a\n' } });
    const wip = await commitFiles(remote.path, { branch: 'wip', files: { 'b.txt': 'b\n' } });
    await gitIn(remote.path, ['update-ref', 'refs/agflow/T-1/a1', wip]);
    await gitIn(remote.path, ['update-ref', '-d', 'refs/heads/wip']);
    const second = await remoteOrigin(remote.path, FILES, join(tmpDir('agf-mirror-'), 'origin'));
    // A new main of the same files: within the same second it is even the same commit.
    expect(await refSha(remote.path, 'refs/heads/main')).toBe(second.origin.mainSha);
    expect(await fileAt(second.origin.path, 'main', 'README.md')).toBe('# toy\n');
    const refs = (await gitIn(remote.path, ['for-each-ref', '--format=%(refname)'])).split('\n').filter(Boolean);
    expect(refs).toEqual(['refs/heads/main']);
    // A ref outside main and agflow's own refs: not a throwaway repository of a live run, and left as it was.
    await commitFiles(remote.path, { branch: 'feature', files: { 'c.txt': 'c\n' } });
    const before = await refsOf(remote.path);
    await expect(remoteOrigin(remote.path, FILES, join(tmpDir('agf-mirror-'), 'origin'))).rejects.toThrow(
      'refs/heads/feature',
    );
    expect(await refsOf(remote.path)).toBe(before);
    // A main that no live run made.
    const other = await originRepo({ 'README.md': '# a real project\n' });
    dirs.push(other.root);
    const untouched = await refsOf(other.path);
    await expect(remoteOrigin(other.path, FILES, join(tmpDir('agf-mirror-'), 'origin'))).rejects.toThrow(
      'not a throwaway repository',
    );
    expect(await refsOf(other.path)).toBe(untouched);
  }, SPAWNS_MS);
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `bun test packages/testkit/test/live.test.ts`
Expected: FAIL — error: Cannot find module '../src/live' from '.../packages/testkit/test/live.test.ts'

- [ ] **Step 3: Implement**

**File:** `packages/testkit/src/harness/cluster.ts` (change)

```diff
diff --git a/packages/testkit/src/harness/cluster.ts b/packages/testkit/src/harness/cluster.ts
index 81757b4e..3313262b 100644
--- a/packages/testkit/src/harness/cluster.ts
+++ b/packages/testkit/src/harness/cluster.ts
@@ -1,18 +1,25 @@
 // A cluster for the e2e scenarios (design 1, 15): one hub process, a local bare origin, the scripted models and three
 // runners owned by alice, bob and carol. Every runner offers the cluster's vendor only (X-10), so placement and lead
 // seating are deterministic. Scenarios wait on what the hub shows; a wait that times out fails with a dump of
-// everything a reader needs to see why.
+// everything a reader needs to see why. A live run's cluster uses real models instead, and may use a throwaway remote
+// as its origin (X-43).
 import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
 import { dirname, join } from 'node:path';
 import type { Attempt, HubEvent, Vendor } from '@agflow/core';
-import { type OriginRepo, originRepo } from '../git-fixtures';
+import { gitIn, type OriginRepo, originRepo } from '../git-fixtures';
 import { requireE2e } from './env';
 import { E2E_USERS, type HubProcess, type HubTimings, startHubProcess } from './hub-process';
 import { type Models, startModels } from './models';
 import { cliToken, type Person, signIn } from './person';
 import { GATE_DIR, type Programs } from './playbook';
 import { processesInDir } from './proc';
-import { prepareRunnerHome, type RunnerHome, type RunnerProcess, startRunnerProcess } from './runner-process';
+import {
+  prepareRunnerHome,
+  type RealModels,
+  type RunnerHome,
+  type RunnerProcess,
+  startRunnerProcess,
+} from './runner-process';
 
 export interface ClusterOptions {
   /** Every runner offers this vendor only. */
@@ -27,10 +34,28 @@ export interface ClusterOptions {
   programs?: Programs;
   /** The hub's timings; E2E_HUB_TIMINGS by default. */
   hubTimings?: HubTimings;
+  /**
+   * The scripted servers behind the refusing proxy (the default), or a live run's real models through the person's
+   * logged-in vendor homes. With real models no scripted server starts, and Cluster.models records nothing.
+   */
+  models?: 'scripted' | RealModels;
+  /**
+   * The pinned binaries the runners link; by default requireE2e's located ones, or none with real models, which bring
+   * the person's.
+   */
+  binaries?: Partial<Record<Vendor, string>>;
+  /**
+   * A throwaway remote to use as the project's repository instead of a new local bare origin (a live run's --repo).
+   * The cluster resets it to main holding the files (remoteOrigin), and Cluster.origin is a local mirror of it that
+   * every wait fetches again before it returns, so the reads after a wait see what the hub saw.
+   */
+  repo?: string;
+  /** How long waitFor and waitForEvent wait by default; 120 s. A live run waits longer for real models. */
+  waitMs?: number;
 }
 
 export interface ClusterWaitOptions {
-  /** 120 s by default. */
+  /** ClusterOptions.waitMs by default. */
   timeoutMs?: number;
   /** 250 ms by default. */
   intervalMs?: number;
@@ -54,7 +79,9 @@ export interface Cluster {
   readonly dir: string;
   readonly vendor: Vendor;
   readonly hub: HubProcess;
+  /** The project's repository: a local bare origin, or the local mirror of a throwaway remote. */
   readonly origin: OriginRepo;
+  /** The scripted models; with real models, noScriptedModels(). */
   readonly models: Models;
   /** alice, signed in: she set the goal and the runner-leads switch, and accepts work. */
   readonly person: Person;
@@ -101,6 +128,119 @@ const DEFAULT_INTERVAL_MS = 250;
 const DEFAULT_GOAL = 'Keep the e2e repository tidy, one small task at a time.';
 const DEFAULT_FILES = { 'README.md': '# e2e\n\nA repository for agflow end-to-end tests.\n' };
 
+/** The subject of main's commit after remoteOrigin's reset: only a remote whose main has it may be reset again. */
+export const REMOTE_MAIN_SUBJECT = 'agflow: the toy repository of a live run';
+
+/** The refs a live run's cluster leaves on its remote, which a later reset may delete. */
+const RUN_REFS = [/^HEAD$/, /^refs\/heads\/main$/, /^refs\/heads\/agflow\//, /^refs\/agflow\//];
+
+/** A throwaway remote's local mirror, and how to fetch it again. */
+export interface RemoteOrigin {
+  origin: OriginRepo;
+  refresh(): Promise<void>;
+}
+
+/**
+ * git with the person's own environment and configuration, so their credentials reach the remote; no hooks run and
+ * nothing prompts.
+ */
+async function personGit(dir: string, args: string[]): Promise<string> {
+  const env: Record<string, string> = {};
+  for (const [name, value] of Object.entries(process.env)) {
+    if (value !== undefined && !name.startsWith('GIT_')) env[name] = value;
+  }
+  const proc = Bun.spawn(['git', '-c', 'core.hooksPath=/dev/null', ...args], {
+    cwd: dir,
+    env: { ...env, GIT_TERMINAL_PROMPT: '0' },
+    stdin: 'ignore',
+    stdout: 'pipe',
+    stderr: 'pipe',
+  });
+  const [stdout, stderr, code] = await Promise.all([
+    new Response(proc.stdout).text(),
+    new Response(proc.stderr).text(),
+    proc.exited,
+  ]);
+  if (code !== 0) throw new Error(`git ${args.join(' ')} failed (exit ${code}): ${stderr.trim()}`);
+  return stdout.trim();
+}
+
+/**
+ * Resets a throwaway remote for a live cluster and mirrors it into dir: main becomes one new commit holding the files,
+ * and every other ref is deleted, so task ids starting again at T-1 meet no ref of an earlier run. It refuses a
+ * remote with a ref outside main and agflow's own refs, or whose main is not one a reset made: that is no throwaway.
+ */
+export async function remoteOrigin(url: string, files: Record<string, string>, dir: string): Promise<RemoteOrigin> {
+  mkdirSync(dirname(dir), { recursive: true });
+  await personGit(dirname(dir), ['clone', '--quiet', '--mirror', url, dir]);
+  const refs = (await personGit(dir, ['for-each-ref', '--format=%(refname)'])).split('\n').filter(Boolean);
+  const foreign = refs.filter((ref) => !RUN_REFS.some((pattern) => pattern.test(ref)));
+  const subject = refs.includes('refs/heads/main') ? await personGit(dir, ['log', '-1', '--format=%s', 'main']) : null;
+  if (foreign.length > 0 || (subject !== null && subject !== REMOTE_MAIN_SUBJECT)) {
+    const why = foreign.length > 0 ? `it has ${foreign.join(', ')}` : `its main is ${JSON.stringify(subject)}`;
+    throw new Error(`${url} is not a throwaway repository of the live run (${why}); give an empty repository`);
+  }
+  for (const ref of refs) await gitIn(dir, ['update-ref', '-d', ref]);
+  // The new main, committed in a scratch repository with the fixture identity and fetched into the mirror.
+  const scratch = mkdtempSync(join(dirname(dir), 'toy-'));
+  try {
+    await gitIn(scratch, ['init', '--quiet']);
+    for (const [path, content] of Object.entries(files)) {
+      mkdirSync(dirname(join(scratch, path)), { recursive: true });
+      writeFileSync(join(scratch, path), content);
+    }
+    await gitIn(scratch, ['add', '--all']);
+    await gitIn(scratch, ['commit', '--quiet', '-m', REMOTE_MAIN_SUBJECT]);
+    await gitIn(dir, ['fetch', '--quiet', scratch, '+HEAD:refs/heads/main']);
+  } finally {
+    rmSync(scratch, { recursive: true, force: true });
+  }
+  await gitIn(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
+  // The remote becomes the mirror: main is replaced, and every ref the mirror no longer has is deleted.
+  await personGit(dir, ['push', '--quiet', '--mirror', url]);
+  const mainSha = await gitIn(dir, ['rev-parse', 'refs/heads/main']);
+  return {
+    origin: { root: dir, path: dir, mainSha, remove: () => rmSync(dir, { recursive: true, force: true }) },
+    refresh: async () => {
+      await personGit(dir, ['fetch', '--quiet', '--prune', url, '+refs/*:refs/*']);
+    },
+  };
+}
+
+/** Cluster.models with real models: nothing is recorded, and nothing can be programmed or reached. */
+export function noScriptedModels(): Models {
+  const refuse = (what: string): never => {
+    throw new Error(`the cluster runs real models: it has no ${what}`);
+  };
+  return {
+    get anthropic() {
+      return refuse('scripted Anthropic server');
+    },
+    get responses() {
+      return refuse('scripted Responses provider');
+    },
+    get proxy() {
+      return refuse('refusing proxy');
+    },
+    get proxyUrl() {
+      return refuse('refusing proxy');
+    },
+    get claudeEnv() {
+      return refuse('scripted Anthropic server');
+    },
+    get codexConfig() {
+      return refuse('scripted Responses provider');
+    },
+    addPrograms: () => refuse('scripted programs'),
+    requests: () => [],
+    requestsFor: () => [],
+    sawText: () => false,
+    unmatched: () => [],
+    externalAttempts: () => [],
+    close: async () => {},
+  };
+}
+
 /** How much of the cluster the dump shows. */
 const DUMP = { attemptLog: 20, events: 40, logLines: 30, requests: 6, requestChars: 1_500 };
 
@@ -123,13 +263,17 @@ function matches(event: HubEvent, match: EventMatch): boolean {
 
 /** Starts a cluster; a start that fails stops every process it started and keeps its files for a look. */
 export async function startCluster(options: ClusterOptions): Promise<Cluster> {
-  const { binaries } = await requireE2e();
+  const real = options.models === undefined || options.models === 'scripted' ? null : options.models;
+  // A scripted cluster is e2e-gated whatever binaries it is given; a live run needs no gate, as it brings the person's.
+  const located = real === null ? (await requireE2e()).binaries : {};
+  const binaries = options.binaries ?? located;
   // Short and real: runner.sock must fit in 104 bytes, and lsof reports real paths.
   const dir = realpathSync(mkdtempSync('/tmp/agf-e2e-'));
   const started: {
     origin?: OriginRepo;
     models?: Models;
     hub?: HubProcess;
+    refreshOrigin?: () => Promise<void>;
     homes: RunnerHome[];
     runners: RunnerProcess[];
   } = { homes: [], runners: [] };
@@ -147,9 +291,16 @@ export async function startCluster(options: ClusterOptions): Promise<Cluster> {
     }
   };
   try {
-    started.origin = await originRepo(options.files ?? DEFAULT_FILES);
-    started.models = await startModels({ programs: options.programs });
-    const repo = started.origin.path;
+    const files = options.files ?? DEFAULT_FILES;
+    if (options.repo === undefined) {
+      started.origin = await originRepo(files);
+    } else {
+      const remote = await remoteOrigin(options.repo, files, join(dir, 'origin.git'));
+      started.origin = remote.origin;
+      started.refreshOrigin = remote.refresh;
+    }
+    started.models = real === null ? await startModels({ programs: options.programs }) : noScriptedModels();
+    const repo = options.repo ?? started.origin.path;
     const hub = await startHubProcess({ dir: join(dir, 'hub'), repo, timings: options.hubTimings });
     started.hub = hub;
     const people = await Promise.all(E2E_USERS.map((login) => signIn(hub.url, login)));
@@ -167,7 +318,7 @@ export async function startCluster(options: ClusterOptions): Promise<Cluster> {
           credentials: { hubUrl: hub.url, token: await cliToken(owner), user: owner.login },
           vendors: [options.vendor],
           binaries,
-          models,
+          models: real ?? models,
         }),
       );
     }
@@ -181,6 +332,8 @@ export async function startCluster(options: ClusterOptions): Promise<Cluster> {
       person,
       homes: started.homes,
       runners: started.runners,
+      waitMs: options.waitMs ?? DEFAULT_WAIT_MS,
+      refreshOrigin: started.refreshOrigin ?? null,
     });
   } catch (error) {
     await stopAll();
@@ -197,10 +350,13 @@ interface ClusterParts {
   person: Person;
   homes: RunnerHome[];
   runners: RunnerProcess[];
+  waitMs: number;
+  /** Fetches a remote origin's mirror again; null for a local origin. */
+  refreshOrigin: (() => Promise<void>) | null;
 }
 
 function createCluster(parts: ClusterParts): Cluster {
-  const { dir, vendor, hub, origin, models, person, homes, runners } = parts;
+  const { dir, vendor, hub, origin, models, person, homes, runners, waitMs, refreshOrigin } = parts;
   let failed = false;
   let inFlight = 0;
   let closing: Promise<void> | null = null;
@@ -293,14 +449,18 @@ function createCluster(parts: ClusterParts): Cluster {
     check: () => Promise<T | null | undefined | false>,
     options: ClusterWaitOptions = {},
   ): Promise<T> {
-    const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_MS;
+    const timeoutMs = options.timeoutMs ?? waitMs;
     const deadline = Date.now() + timeoutMs;
     let lastError: unknown = null;
     for (;;) {
       requireOpen(`wait for ${what}`);
       try {
         const value = await check();
-        if (value !== null && value !== undefined && value !== false) return value;
+        if (value !== null && value !== undefined && value !== false) {
+          // A remote's pushes come before the hub records them, so the mirror is fetched once the wait is over.
+          if (refreshOrigin !== null) await refreshOrigin();
+          return value;
+        }
         lastError = null;
       } catch (error) {
         lastError = error;
```

**File:** `packages/testkit/src/harness/runner-process.ts` (change)

```diff
diff --git a/packages/testkit/src/harness/runner-process.ts b/packages/testkit/src/harness/runner-process.ts
index 52280a8c..6aefb7aa 100644
--- a/packages/testkit/src/harness/runner-process.ts
+++ b/packages/testkit/src/harness/runner-process.ts
@@ -17,7 +17,12 @@ import {
 } from 'node:fs';
 import { basename, dirname, join } from 'node:path';
 import { CREDENTIALS_FILE, type Credentials, CredentialsSchema, type Vendor } from '@agflow/core';
-import { type RunnerConfig, type RunnerTimings, saveRunnerConfig } from '@agflow/runner/src/config';
+import {
+  CONNECTIVITY_VARS,
+  type RunnerConfig,
+  type RunnerTimings,
+  saveRunnerConfig,
+} from '@agflow/runner/src/config';
 import { projectKey, type RunnerPaths, runnerPaths } from '@agflow/runner/src/paths';
 import { type ProcessIdentity, processIdentity, sameProcess } from '@agflow/runner/src/processes';
 import { removeAgentTools } from '@agflow/runner/src/run-dir';
@@ -78,6 +83,24 @@ function runnerPath(path = process.env.PATH ?? ''): string {
 /** What prepareRunnerHome needs of the scripted models: Models, or stand-ins in a test. */
 export type RunnerModels = Pick<Models, 'claudeEnv' | 'codexConfig' | 'proxyUrl'>;
 
+/**
+ * A live run's models (design 1, 15, X-43): the vendors' own services, reached through the person's runner vendor homes
+ * that one `agflow runner setup` logged in. Every runner of the run shares them, and none goes through the refusing
+ * proxy: they reach the network as the person's runner does.
+ */
+export interface RealModels {
+  readonly kind: 'real';
+  /** CLAUDE_CONFIG_DIR and CODEX_HOME exactly as setup created them: Claude's keychain item depends on the string. */
+  readonly homes: Readonly<Record<Vendor, string>>;
+  /** The person's HOME, which the runners get as in production: their remote git uses the person's credentials. */
+  readonly home: string;
+  /**
+   * The proxy and certificate variables setup recorded in the person's runner.json (design 7.1); empty without one.
+   * Each runner records them too, and its process gets them, as the LaunchAgent sets them.
+   */
+  readonly connectivity: RunnerConfig['connectivity'];
+}
+
 export interface RunnerHomeOptions {
   /** The runner's directory; created, and used at its real path. Keep it short: runner.sock must fit in 104 bytes. */
   dir: string;
@@ -87,9 +110,9 @@ export interface RunnerHomeOptions {
   credentials: Credentials;
   /** The vendors the runner offers; any other lacks its binary, and preflight reports 'binary missing' (X-10). */
   vendors: readonly Vendor[];
-  /** The located pinned binaries, from requireE2e. */
+  /** The located pinned binaries, from requireE2e; with real models, the person's from setup. */
   binaries: Partial<Record<Vendor, string>>;
-  models: RunnerModels;
+  models: RunnerModels | RealModels;
   /** The hub's project name, which names the runner's vault and clone directories; 'e2e' by default. */
   projectName?: string;
 }
@@ -103,7 +126,10 @@ export interface RunnerHome {
   readonly binaries: Partial<Record<Vendor, string>>;
   /** The runner's directory, at its real path; everything below lives in it. */
   readonly dir: string;
-  /** HOME: a scratch home, so no CLI ever reads or writes the developer's own. */
+  /**
+   * HOME: a scratch home, so no CLI ever reads or writes the developer's own; with real models, the person's HOME, as
+   * in production.
+   */
   readonly home: string;
   /** AGFLOW_HOME. */
   readonly agflowHome: string;
@@ -123,13 +149,27 @@ export interface RunnerHome {
   remove(): void;
 }
 
-/** The runner process's environment: only what the runner and its agents read, never a developer's own settings. */
-function runnerEnv(home: { home: string; agflowHome: string; configDir: string }): Record<string, string> {
+/**
+ * The runner process's environment: only what the runner and its agents read, never a developer's own settings. With
+ * real models the runner also gets the person's SSH agent, which its remote git uses for a remote origin, and the
+ * recorded connectivity variables, as the LaunchAgent gives them (design 7.1).
+ */
+function runnerEnv(
+  home: { home: string; agflowHome: string; configDir: string },
+  real: RealModels | null,
+): Record<string, string> {
   const env: Record<string, string> = { PATH: runnerPath() };
+  if (real !== null) {
+    for (const name of CONNECTIVITY_VARS) {
+      const value = real.connectivity[name];
+      if (value !== undefined) env[name] = value;
+    }
+  }
+  const passed = ['TMPDIR', 'USER', 'LOGNAME', 'LANG', 'SHELL', ...(real !== null ? ['SSH_AUTH_SOCK'] : [])];
   // The user variables agents inherit (buildAgentEnv), and the temporary directory Bun and the sandbox use.
   for (const [name, value] of Object.entries(process.env)) {
     if (value === undefined) continue;
-    if (['TMPDIR', 'USER', 'LOGNAME', 'LANG', 'SHELL'].includes(name) || name.startsWith('LC_')) env[name] = value;
+    if (passed.includes(name) || name.startsWith('LC_')) env[name] = value;
   }
   return {
     ...env,
@@ -168,6 +208,8 @@ function linkBinaries(
 /**
  * Creates a runner home: runner.json from createRunnerConfig with readMachineId's id and the e2e overrides (X-42), the
  * vendor homes inside it, the offered vendors' binaries linked into its vendor/, and the owner's credentials.json.
+ * With real models, runner.json's test block holds only allowShortTimings (X-30), so preflight checks the logins; it
+ * points at the person's vendor homes and records the person's connectivity variables, never the refusing proxy.
  */
 export async function prepareRunnerHome(options: RunnerHomeOptions): Promise<RunnerHome> {
   mkdirSync(options.dir, { recursive: true });
@@ -175,28 +217,46 @@ export async function prepareRunnerHome(options: RunnerHomeOptions): Promise<Run
   const dir = realpathSync(options.dir);
   const owner = options.credentials.user;
   const projectName = options.projectName ?? 'e2e';
-  const home = join(dir, 'home');
+  const models = options.models;
+  const real = 'kind' in models ? models : null;
+  const home = real === null ? join(dir, 'home') : real.home;
   const agflowHome = join(dir, 'agflow');
   const configDir = join(dir, 'config');
-  for (const path of [home, agflowHome, configDir]) mkdirSync(path, { recursive: true, mode: 0o700 });
+  for (const path of [agflowHome, configDir, ...(real === null ? [home] : [])]) {
+    mkdirSync(path, { recursive: true, mode: 0o700 });
+  }
   const paths = runnerPaths(agflowHome);
   linkBinaries(paths, options.vendors, options.binaries);
-  const { claudeEnv, codexConfig, proxyUrl } = options.models;
+  const scripted = 'kind' in models ? null : models;
   const config = createRunnerConfig(
     {
       machineId: await readMachineId(),
       name: options.name,
       capturedPath: runnerPath(),
-      connectivity: { HTTPS_PROXY: proxyUrl, HTTP_PROXY: proxyUrl, ALL_PROXY: proxyUrl, NO_PROXY },
+      connectivity:
+        scripted === null
+          ? { ...real?.connectivity }
+          : { HTTPS_PROXY: scripted.proxyUrl, HTTP_PROXY: scripted.proxyUrl, ALL_PROXY: scripted.proxyUrl, NO_PROXY },
       commitIdentity: { name: owner, email: `${owner}@agflow.invalid` },
-      homes: { claude: canonicalHome(paths.homes.claude), codex: canonicalHome(paths.homes.codex) },
+      homes:
+        real === null
+          ? { claude: canonicalHome(paths.homes.claude), codex: canonicalHome(paths.homes.codex) }
+          : { ...real.homes },
     },
     {
       capacity: 2,
       keepAwake: 'off',
       minFreeGb: E2E_MIN_FREE_GB,
       timings: { ...E2E_RUNNER_TIMINGS },
-      test: { claudeEnv, codexConfig, skipAuthChecks: true, allowShortTimings: true },
+      test:
+        scripted === null
+          ? { allowShortTimings: true }
+          : {
+              claudeEnv: scripted.claudeEnv,
+              codexConfig: scripted.codexConfig,
+              skipAuthChecks: true,
+              allowShortTimings: true,
+            },
     },
   );
   saveRunnerConfig(paths.config, config);
@@ -216,7 +276,7 @@ export async function prepareRunnerHome(options: RunnerHomeOptions): Promise<Run
     config,
     hubUrl: credentials.hubUrl,
     projectName,
-    env: runnerEnv({ home, agflowHome, configDir }),
+    env: runnerEnv({ home, agflowHome, configDir }, real),
     logPath: join(dir, 'runner-process.log'),
     clonePath: (attemptId) => paths.clone(project, attemptId),
     remove() {
```

**File:** `packages/testkit/src/live.ts` (new)

```ts
// The live run (design 1, 15, X-43): the exit scenarios once with real subscriptions. One Mac runs one hub and three
// runners, each with its own AGFLOW_HOME, whose runner.json points at the person's runner vendor homes that one
// `agflow runner setup` logged in, and at the pinned binaries it installed. The scenario drivers run unchanged, with
// task texts that tell a real model what the scripted programs do; their checks become a results table and
// results.json. Nothing here sends a prompt: checkVendorHome asks the vendor CLIs only for their login status.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { type Vendor, VendorSchema } from '@agflow/core';
import { loadRunnerConfig, type RunnerConfig, vendorHomes } from '@agflow/runner/src/config';
import { agflowHome as defaultAgflowHome, runnerPaths } from '@agflow/runner/src/paths';
import { createRunnerConfig } from '@agflow/runner/src/service/runner-json';
import {
  claudeLoginStatus,
  codexLoginStatus,
  type VendorLoginOptions,
  type VendorLoginStatus,
} from '@agflow/runner/src/vendor/login';
import { VENDOR_PINS, vendorBinary } from '@agflow/runner/src/vendor/pins';
import type { ClusterOptions } from './harness/cluster';
import { E2E_PLATFORM } from './harness/env';
import { LOST_LEAD } from './scenarios/lost-lead';
import type { ScenarioResult } from './scenarios/result';

const VENDORS: readonly Vendor[] = VendorSchema.options;

/** The exit scenarios a live run can run, in the order it runs them. */
export const LIVE_SCENARIOS = ['killed-agent', 'closed-laptop', 'lost-lead'] as const;
export type LiveScenario = (typeof LIVE_SCENARIOS)[number];

/** The options of `bun run live-run`; the runbook names each. */
export const LIVE_OPTIONS = [
  {
    flag: '--claude-home',
    value: '<dir>',
    help: "The runners' Claude home (CLAUDE_CONFIG_DIR) that `agflow runner setup` logged in; runner.json's by " +
      'default.',
  },
  {
    flag: '--codex-home',
    value: '<dir>',
    help: "The runners' Codex home (CODEX_HOME) that `agflow runner setup` logged in; runner.json's by default.",
  },
  {
    flag: '--runners',
    value: '<vendors>',
    help:
      'claude, codex or claude,codex (the default): the vendor every runner of a cluster offers. Each scenario runs ' +
      'once per vendor, in a cluster of its own.',
  },
  {
    flag: '--scenarios',
    value: '<names>',
    help: `Some of ${LIVE_SCENARIOS.join(',')} (the default: all three).`,
  },
  {
    flag: '--repo',
    value: '<url>',
    help:
      'A throwaway remote to use instead of a local bare origin. Each cluster resets it to main holding the toy ' +
      'repository, so it must be empty or used only by earlier live runs.',
  },
  {
    flag: '--takeover',
    value: '<vendors>',
    help:
      'claude, codex or claude,codex: after the scenarios, walk through the TTY check of the take-over commands, ' +
      'once per vendor, in a cluster each. Off by default; the exit run checks both.',
  },
  { flag: '--keep', value: null, help: "Keep every cluster's files; a failed cluster's are always kept." },
  { flag: '--help', value: null, help: 'Print this and exit.' },
] as const;

/** Where a live run finds the person's runner: an AGFLOW_HOME, its vendor homes and its network settings. */
export interface LiveDefaults {
  /** The person's AGFLOW_HOME, whose runner/vendor/ holds the pinned binaries. */
  agflowHome: string;
  claudeHome: string;
  codexHome: string;
  /** The proxy and certificate variables setup recorded in runner.json (design 7.1); empty without a runner.json. */
  connectivity: RunnerConfig['connectivity'];
}

export interface LiveArgs extends LiveDefaults {
  help: boolean;
  /** The vendors to run the scenarios with, a cluster each. */
  runners: Vendor[];
  scenarios: LiveScenario[];
  /** A throwaway remote, or null for a local bare origin. */
  repo: string | null;
  /** The vendors of the take-over TTY check, a cluster each; empty to skip it. */
  takeover: Vendor[];
  keep: boolean;
}

/** How long a live cluster's waits last: a real model may take minutes over what a scripted one answers at once. */
export const LIVE_WAIT_MS = 20 * 60_000;

/** The goal of a live cluster without a runner lead. */
export const LIVE_GOAL = 'Keep the toy word-count CLI tidy and its test green, one small task at a time.';

/**
 * The defaults: the person's AGFLOW_HOME (~/.agflow unless AGFLOW_HOME says otherwise), and the vendor homes and
 * connectivity variables its runner.json records, or the layout's homes and none before setup wrote one.
 */
export function liveDefaults(agflowHome: string = defaultAgflowHome()): LiveDefaults {
  const home = resolve(agflowHome);
  const paths = runnerPaths(home);
  if (!existsSync(paths.config)) {
    return { agflowHome: home, claudeHome: paths.homes.claude, codexHome: paths.homes.codex, connectivity: {} };
  }
  const config = loadRunnerConfig(paths.config);
  const homes = vendorHomes(config, paths);
  const connectivity = { ...config.connectivity };
  return { agflowHome: home, claudeHome: homes.claude, codexHome: homes.codex, connectivity };
}

function vendorOf(value: string): Vendor {
  const vendor = VENDORS.find((candidate) => candidate === value);
  if (vendor === undefined) throw new Error(`unknown vendor '${value}'; use ${VENDORS.join(' or ')}`);
  return vendor;
}

function scenarioOf(value: string): LiveScenario {
  const scenario = LIVE_SCENARIOS.find((candidate) => candidate === value);
  if (scenario === undefined) throw new Error(`unknown scenario '${value}'; use ${LIVE_SCENARIOS.join(', ')}`);
  return scenario;
}

/** A comma-separated list of what (vendor or scenario), each entry once, in the order given. */
function listOf<T>(flag: string, what: string, value: string, parse: (entry: string) => T): T[] {
  const entries = [...new Set(value.split(',').map((entry) => entry.trim()).filter((entry) => entry !== ''))];
  if (entries.length === 0) throw new Error(`${flag} names no ${what}`);
  return entries.map(parse);
}

/** Reads the live run's command line; an unknown option, scenario or vendor throws with what to use instead. */
export function parseLiveArgs(argv: readonly string[], defaults: LiveDefaults = liveDefaults()): LiveArgs {
  const args: LiveArgs = {
    help: false,
    ...defaults,
    runners: [...VENDORS],
    scenarios: [...LIVE_SCENARIOS],
    repo: null,
    takeover: [],
    keep: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (!arg.startsWith('--')) throw new Error(`unexpected argument '${arg}'; see --help`);
    const equals = arg.indexOf('=');
    const flag = equals === -1 ? arg : arg.slice(0, equals);
    const option = LIVE_OPTIONS.find((candidate) => candidate.flag === flag);
    if (option === undefined) throw new Error(`unknown option ${flag}; see --help`);
    if (option.value === null) {
      if (equals !== -1) throw new Error(`${flag} takes no value`);
      if (flag === '--help') args.help = true;
      else args.keep = true;
      continue;
    }
    let value: string;
    if (equals !== -1) {
      value = arg.slice(equals + 1);
    } else {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`${flag} needs a value: ${option.value}`);
      value = next;
      index += 1;
    }
    switch (flag) {
      case '--claude-home':
        args.claudeHome = resolve(value);
        break;
      case '--codex-home':
        args.codexHome = resolve(value);
        break;
      case '--runners':
        args.runners = listOf(flag, 'vendor', value, vendorOf);
        break;
      case '--scenarios':
        args.scenarios = listOf(flag, 'scenario', value, scenarioOf);
        break;
      case '--repo':
        args.repo = value;
        break;
      case '--takeover':
        args.takeover = listOf(flag, 'vendor', value, vendorOf);
        break;
    }
  }
  return args;
}

/** The live run's usage text. */
export function liveUsage(): string {
  const lines = [
    'Usage: bun run live-run [options]',
    '',
    "Runs M2's exit scenarios once with real subscriptions (design 1, 15): a local hub with the web UI, a toy",
    "repository and three runners on the person's logged-in runner vendor homes. Prints a results table and writes",
    'results.json. See docs/m2-live-run.md.',
    '',
    'Options:',
  ];
  for (const option of LIVE_OPTIONS) {
    lines.push(`  ${option.flag}${option.value === null ? '' : ` ${option.value}`}`, `      ${option.help}`);
  }
  return `${lines.join('\n')}\n`;
}

/** The person's pinned binaries under the AGFLOW_HOME, as setup or `bun run vendor:install` put them. */
export function liveBinaries(agflowHome: string): Record<Vendor, string> {
  const pins = VENDOR_PINS[E2E_PLATFORM];
  if (!pins) throw new Error(`VENDOR_PINS has no ${E2E_PLATFORM} entry`);
  const runner = runnerPaths(agflowHome).runner;
  return {
    claude: join(runner, vendorBinary('claude', pins.claude.version)),
    codex: join(runner, vendorBinary('codex', pins.codex.version)),
  };
}

/**
 * A live cluster: real models through the person's vendor homes, HOME and pinned binaries; the toy repository, on a
 * local bare origin or the throwaway remote; long waits. The lost lead also needs a runner lead that follows its goal.
 */
export function liveClusterOptions(
  args: LiveArgs,
  vendor: Vendor,
  scenario: LiveScenario | 'takeover',
): ClusterOptions {
  const lead = scenario === 'lost-lead';
  return {
    vendor,
    models: {
      kind: 'real',
      homes: { claude: args.claudeHome, codex: args.codexHome },
      home: homedir(),
      connectivity: { ...args.connectivity },
    },
    binaries: liveBinaries(args.agflowHome),
    files: toyRepoFiles(),
    repo: args.repo ?? undefined,
    runnerLeads: lead,
    goal: lead ? LOST_LEAD.goal : LIVE_GOAL,
    waitMs: LIVE_WAIT_MS,
  };
}

/** Whether a vendor home is logged in, as checkVendorHome found it. */
export interface VendorHomeCheck {
  vendor: Vendor;
  home: string;
  ok: boolean;
  /** "logged in", with Claude's plan; otherwise what is wrong. */
  detail: string;
}

/**
 * Confirms that the vendor home is logged in, with M2c's claudeLoginStatus or codexLoginStatus: they run the person's
 * pinned binary for `auth status --json` or `login status` only, so no prompt is ever sent.
 */
export async function checkVendorHome(
  vendor: Vendor,
  args: Pick<LiveArgs, 'agflowHome' | 'claudeHome' | 'codexHome' | 'connectivity'>,
  options: VendorLoginOptions = {},
): Promise<VendorHomeCheck> {
  const home = vendor === 'claude' ? args.claudeHome : args.codexHome;
  if (!existsSync(home)) return { vendor, home, ok: false, detail: `${home} does not exist` };
  const paths = runnerPaths(args.agflowHome);
  // Only the facts the status commands read: the homes, the PATH and the recorded connectivity, as the runners get it.
  const config = createRunnerConfig({
    machineId: 'live-run',
    name: 'live-run',
    capturedPath: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
    connectivity: { ...args.connectivity },
    commitIdentity: null,
    homes: { claude: args.claudeHome, codex: args.codexHome },
  });
  const status: VendorLoginStatus =
    vendor === 'claude'
      ? await claudeLoginStatus(config, paths, options)
      : await codexLoginStatus(config, paths, options);
  if (!status.ok) return { vendor, home, ok: false, detail: status.reason };
  return { vendor, home, ok: true, detail: status.plan === null ? 'logged in' : `logged in, plan ${status.plan}` };
}

const TOY_PACKAGE = { name: 'toy', private: true, type: 'module', scripts: { test: 'bun test' } };

/** The toy repository (M1's "small CLI with tests plus one research note"): a word-count CLI, its test and a note. */
export function toyRepoFiles(): Record<string, string> {
  return {
    'README.md': [
      '# toy',
      '',
      "A small word-count CLI: the repository of agflow's M2 live run.",
      '',
      '- `bun src/cli.ts <file>` prints the number of words in the file.',
      '- `bun test` runs its test.',
      '- `notes/research.md` records what counts as a word.',
      '',
    ].join('\n'),
    'package.json': `${JSON.stringify(TOY_PACKAGE, null, 2)}\n`,
    'src/count.ts': [
      '/** The number of words in the text: runs of characters other than whitespace (notes/research.md). */',
      'export function countWords(text: string): number {',
      '  return text.split(/\\s+/).filter((word) => word !== "").length;',
      '}',
      '',
    ].join('\n'),
    'src/cli.ts': [
      "import { readFileSync } from 'node:fs';",
      "import { countWords } from './count';",
      '',
      'const file = process.argv[2];',
      'if (file === undefined) {',
      "  console.error('usage: bun src/cli.ts <file>');",
      '  process.exit(2);',
      '}',
      "console.log(countWords(readFileSync(file, 'utf8')));",
      '',
    ].join('\n'),
    'test/count.test.ts': [
      "import { expect, test } from 'bun:test';",
      "import { countWords } from '../src/count';",
      '',
      "test('counts runs of non-whitespace', () => {",
      "  expect(countWords('one two  three\\nfour\\n')).toBe(4);",
      "  expect(countWords('')).toBe(0);",
      '});',
      '',
    ].join('\n'),
    'notes/research.md': [
      '# What counts as a word',
      '',
      '`wc -w` counts maximal runs of non-whitespace characters, so "co-op" is one word and "a  b" two. The CLI',
      'follows it: words are split on any whitespace, and empty strings between separators are not words.',
      'Punctuation stays part of its word; a later task may decide otherwise and record why here.',
      '',
    ].join('\n'),
  };
}

/** One row of the results: a check of a scenario run. */
export interface ResultRow {
  scenario: string;
  vendor: Vendor;
  check: string;
  passed: boolean;
  detail: string;
}

/** What results.json holds: whether every check of every run passed, and the table's rows. */
export interface LiveResults {
  passed: boolean;
  rows: ResultRow[];
}

/** A table cell: pipes escaped and lines joined, so the cell keeps the table intact. */
function cell(text: string): string {
  return text.replaceAll('|', '\\|').replaceAll('\r', '').replaceAll('\n', '<br>');
}

/**
 * The results as a markdown table of scenario, check, result and detail, for the runbook and the PR, and as
 * results.json with the same rows. A run without results did not pass.
 */
export function formatResults(results: readonly ScenarioResult[]): { markdown: string; json: LiveResults } {
  const rows = results.flatMap((result) =>
    result.checks.map((check) => ({
      scenario: result.scenario,
      vendor: result.vendor,
      check: check.name,
      passed: check.passed,
      detail: check.detail,
    })),
  );
  const lines = ['| Scenario | Check | Result | Detail |', '| --- | --- | --- | --- |'];
  for (const row of rows) {
    const scenario = `${row.scenario} (${row.vendor})`;
    const result = row.passed ? 'passed' : 'FAILED';
    lines.push(`| ${cell(scenario)} | ${cell(row.check)} | ${result} | ${cell(row.detail)} |`);
  }
  const passed = results.length > 0 && results.every((result) => result.passed);
  return { markdown: `${lines.join('\n')}\n`, json: { passed, rows } };
}
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `bun test packages/testkit/test/live.test.ts && bun run typecheck`
Expected: all selected tests pass (0 fail); tsc exits 0.

This task implements real-model configuration but must not start a real-model cluster during development. Its tests use temporary vendor homes, fake status CLIs and local bare remotes. Pass the recorded connectivity unchanged; noScriptedModels refuses programs. --takeover is a vendor list, not a boolean. A remote is reset only after its refs and main marker are accepted; tests prove refused remotes unchanged. Some later connectivity/vendor-list assertions were added with the review fix, without a preceding red run; the original missing-live-module failure remains valid. Slow git/Bun/fake-CLI cases have their recorded 30 s timeout. See Decisions 60–64.

- [ ] **Step 5: Commit**

```bash
git add -A 'packages/testkit/src/harness/cluster.ts' 'packages/testkit/src/harness/runner-process.ts' 'packages/testkit/src/live.ts' 'packages/testkit/test/live.test.ts'
git commit -m 'M2G Task 15: Live run: clusters with real models' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

### Task 16: Live run: the script, the take-over check and the runbook

scripts/live-run.ts starts a local dev hub that serves the web UI (AGFLOW_WEB_DIST) with short test timings, a toy repository (a local bare origin, or a throwaway remote given with --repo), and three runners on the person's logged-in vendor homes. It runs the chosen exit scenarios, prints a results table and writes results.json. With --takeover claude,codex (the exit run checks both vendors' commands, a cluster each) it walks the person through the TTY check: take over in the browser, run the local command in a terminal, commit from the resumed session, exit, leave the clone, hand back in the browser; runTakeoverCheck then applies the take-over scenario's checks, and hands the person the clone only once the runner replaced its .git. inLiveCluster never throws, so one cluster's start, body or close failure becomes a failed row and the run goes on. docs/m2-live-run.md is the runbook, with a results section the run fills in; the PR reports the results too (X-43). The run itself happens after the plans land, because prototypes may not use models.

**Files:**
- Create: `docs/m2-live-run.md`
- Modify: `package.json`
- Test: `packages/testkit/e2e/live-takeover.e2e.test.ts`
- Modify: `packages/testkit/src/harness/cluster.ts`
- Modify: `packages/testkit/src/harness/hub-process.ts`
- Modify: `packages/testkit/src/live.ts`
- Test: `packages/testkit/test/hub-process.test.ts`
- Test: `packages/testkit/test/live-run-script.test.ts`
- Create: `scripts/live-run.ts`

- [ ] **Step 1: Write the failing tests**

**File:** `packages/testkit/e2e/live-takeover.e2e.test.ts` (new)

```ts
// The live run's take-over check (design 6.12, 15), per vendor on a scripted cluster. In a live run a person takes the
// task over in the browser, resumes the session with the local command in a terminal, commits and hands back in the
// browser. Here a stand-in person commits in the clone and hands back through the API, so runTakeoverCheck's own
// steps and verdicts are checked without a terminal, a browser or a model. The cluster uses a throwaway "remote" (a
// local bare repository) as a live run's --repo does, so every origin read goes through the mirror and its refresh.
// Runs only with AGFLOW_E2E=1.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { gitIn, type OriginRepo, originRepo, refSha } from '../src/git-fixtures';
import { type Cluster, startCluster } from '../src/harness/cluster';
import { describeE2e, E2E_TEST_TIMEOUT_MS, e2eVendors } from '../src/harness/env';
import { runTakeoverCheck, TAKEOVER_CHECK, type TakeoverPerson } from '../src/live';
import { expectPassed } from '../src/scenarios/result';
import { TAKEOVER } from '../src/scenarios/takeover';

setDefaultTimeout(E2E_TEST_TIMEOUT_MS);

/** The person's steps through the API: take over, then commit a1's uncommitted b.txt and hand back from the clone. */
const STAND_IN: TakeoverPerson = {
  async takeOver({ cluster, taskId }) {
    await cluster.person.takeover(taskId);
  },
  async handBack({ cluster, taskId, clone }) {
    await gitIn(clone, ['add', 'b.txt']);
    await gitIn(clone, ['commit', '-q', '-m', 'Add b.txt']);
    await cluster.person.handback(taskId, 'clone');
    return { resumed: null };
  },
};

describeE2e('the live run take-over check', () => {
  for (const vendor of e2eVendors()) {
    describe(vendor, () => {
      let started: Cluster | null = null;
      let remote: OriginRepo | null = null;
      const cluster = (): Cluster => {
        if (started === null) throw new Error('the cluster did not start');
        return started;
      };

      beforeAll(async () => {
        // An empty throwaway remote, as --repo names one.
        remote = await originRepo({});
        await gitIn(remote.path, ['update-ref', '-d', 'refs/heads/main']);
        started = await startCluster({ vendor, repo: remote.path });
      });

      afterAll(async () => {
        await started?.close();
        remote?.remove();
      });

      test('the cluster resets the remote, and its origin is a local mirror of it', () =>
        cluster().step(async () => {
          const { origin } = cluster();
          if (remote === null) throw new Error('no remote');
          expect(origin.path).not.toBe(remote.path);
          expect(await refSha(remote.path, 'refs/heads/main')).toBe(origin.mainSha);
        }));

      test('runTakeoverCheck with a stand-in person reports every check passed', () =>
        cluster().step(async () => {
          const results = await runTakeoverCheck(cluster(), STAND_IN);
          expect(results.map((result) => result.scenario)).toEqual([
            TAKEOVER_CHECK.scenario,
            TAKEOVER.scenario,
            'hand-back from the clone',
          ]);
          for (const result of results) expectPassed(result);
          // Without a terminal, nobody saw the session resume: that check is left out, not passed.
          const own = results[0]?.checks.map((check) => check.name) ?? [];
          expect(own).toContain(TAKEOVER_CHECK.checks.committed);
          expect(own).not.toContain(TAKEOVER_CHECK.checks.resumed);
        }));
    });
  }
});
```

**File:** `packages/testkit/test/hub-process.test.ts` (change)

```diff
diff --git a/packages/testkit/test/hub-process.test.ts b/packages/testkit/test/hub-process.test.ts
index 6f601a52..34c5a338 100644
--- a/packages/testkit/test/hub-process.test.ts
+++ b/packages/testkit/test/hub-process.test.ts
@@ -1,5 +1,5 @@
 import { afterEach, describe, expect, test } from 'bun:test';
-import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
+import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
 import { basename, join } from 'node:path';
 import { type HubStatus, WhoamiResponseSchema } from '@agflow/core';
 import { loadConfig } from '../../hub/src/config';
@@ -101,6 +101,24 @@ describe('startHubProcess', () => {
     expect((await (await signIn(hub.url, 'alice')).status()).epoch).toBe(1);
   }, 30_000);
 
+  test('with webDist, the hub serves the built web UI; without it, none', async () => {
+    const web = mkdtempSync('/tmp/agf-web-');
+    dirs.push(web);
+    writeFileSync(join(web, 'index.html'), '<!doctype html><title>agflow</title>\n');
+    const origin = await originRepo({ 'README.md': 'hub process test\n' });
+    dirs.push(origin.root);
+    const dir = mkdtempSync('/tmp/agf-hub-');
+    dirs.push(dir);
+    const hub = await startHubProcess({ dir, repo: origin.path, webDist: web });
+    hubs.push(hub);
+    expect(hub.env.AGFLOW_WEB_DIST).toBe(web);
+    const page = await fetch(`${hub.url}/`);
+    expect(await page.text()).toContain('<title>agflow</title>');
+    const { hub: plain } = await startHubWithOrigin();
+    expect(plain.env.AGFLOW_WEB_DIST).toBeUndefined();
+    expect((await fetch(`${plain.url}/`)).status).toBe(404);
+  }, 30_000);
+
   test('GET /api/status shows no lead seat, epoch 1 and the project', async () => {
     const hub = await startHub();
     const status: HubStatus = await (await signIn(hub.url, 'alice')).status();
```

**File:** `packages/testkit/test/live-run-script.test.ts` (new)

```ts
import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { Attempt, Task } from '@agflow/core';
import { runnerPaths } from '@agflow/runner/src/paths';
import { createRunnerConfig } from '@agflow/runner/src/service/runner-json';
import { VENDOR_PINS, vendorBinary } from '@agflow/runner/src/vendor/pins';
import { gitIn } from '../src/git-fixtures';
import type { Cluster } from '../src/harness/cluster';
import type { ProcessInfo } from '../src/harness/proc';
import { E2E_PLATFORM } from '../src/harness/env';
import { CLUSTER_CLOSED, inLiveCluster, LIVE_OPTIONS, runTakeoverCheck, type TakeoverPerson } from '../src/live';
import { RAN_TO_END, type ScenarioResult } from '../src/scenarios/result';
import { TAKEOVER } from '../src/scenarios/takeover';

const ROOT = join(import.meta.dir, '../../..');
const SCRIPT = join(ROOT, 'scripts/live-run.ts');
const RUNBOOK = join(ROOT, 'docs/m2-live-run.md');

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmpDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join('/tmp', prefix)));
  dirs.push(dir);
  return dir;
}

/** The script run as `bun run live-run` runs it, with a scratch HOME and AGFLOW_HOME. */
async function liveRun(args: string[], agflowHome: string): Promise<{ code: number; output: string }> {
  const proc = Bun.spawn([process.execPath, '--no-env-file', SCRIPT, ...args], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: tmpDir('agf-home-'), AGFLOW_HOME: agflowHome },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, output: `${stdout}${stderr}` };
}

describe('scripts/live-run.ts', () => {
  test('--help prints the options and exits 0 without starting anything', async () => {
    const agflowHome = tmpDir('agf-live-');
    const { code, output } = await liveRun(['--help'], agflowHome);
    expect(code).toBe(0);
    for (const option of LIVE_OPTIONS) expect(output).toContain(option.flag);
    expect(output).not.toContain('Checking');
    expect(existsSync(join(agflowHome, 'runner'))).toBe(false);
  }, 30_000);

  test('an unknown option exits 2 with the usage', async () => {
    const { code, output } = await liveRun(['--scenarios', 'lost-laptop'], tmpDir('agf-live-'));
    expect(code).toBe(2);
    expect(output).toContain("unknown scenario 'lost-laptop'");
    expect(output).toContain('Usage: bun run live-run');
  }, 30_000);

  test('with a logged-out vendor home, it stops before the hub starts and names the vendor and setup', async () => {
    const agflowHome = tmpDir('agf-live-');
    mkdirSync(join(agflowHome, 'runner', 'homes', 'claude'), { recursive: true });
    // The pinned claude a setup installed, stood in for by a script that reports no login.
    const pins = VENDOR_PINS[E2E_PLATFORM];
    if (!pins) throw new Error(`no ${E2E_PLATFORM} pins`);
    const claude = join(agflowHome, 'runner', vendorBinary('claude', pins.claude.version));
    mkdirSync(dirname(claude), { recursive: true });
    writeFileSync(claude, '#!/bin/sh\necho \'{"loggedIn": false}\'\nexit 1\n');
    chmodSync(claude, 0o755);
    const { code, output } = await liveRun(['--runners', 'claude', '--scenarios', 'killed-agent'], agflowHome);
    expect(code).toBe(1);
    expect(output).toContain('claude: not logged in to Claude');
    expect(output).toContain('`agflow runner setup`');
    expect(output).not.toContain('The hub is at');
  }, 30_000);
});

/** A cluster stand-in with what inLiveCluster reads of it, whose close does what it is given. */
function closingCluster(close: () => Promise<void>): { cluster: Cluster; closes: { keep?: boolean }[] } {
  const closes: { keep?: boolean }[] = [];
  const cluster = {
    hub: { url: 'http://127.0.0.1:1' },
    dir: '/tmp/agf-e2e-fake',
    close: (options: { keep?: boolean } = {}) => {
      closes.push(options);
      return close();
    },
  } as unknown as Cluster;
  return { cluster, closes };
}

const PASSED: ScenarioResult = {
  scenario: 'killed agent',
  vendor: 'claude',
  checks: [{ name: RAN_TO_END, passed: true, detail: '1 checks made' }],
  passed: true,
  dump: null,
};

describe('inLiveCluster', () => {
  test("gives the body's results and closes the cluster, keeping its files only when asked", async () => {
    const { cluster, closes } = closingCluster(async () => {});
    const results = await inLiveCluster('killed-agent', 'claude', async () => cluster, false, async () => [PASSED]);
    expect(results).toEqual([PASSED]);
    expect(closes).toEqual([{ keep: false }]);
  });

  test('never throws: a failed close, a body that throws and a cluster that does not start each add a failed result', async () => {
    const lines: string[] = [];
    const log = (line = '') => lines.push(line);
    const failing = closingCluster(() => Promise.reject(new Error('closing the cluster:\nprocess 42 still ran')));
    const run = async () => [PASSED];
    const closed = await inLiveCluster('killed-agent', 'codex', async () => failing.cluster, false, run, log);
    expect(closed.map((result) => [result.scenario, result.passed])).toEqual([
      ['killed agent', true],
      ['killed-agent: the cluster', false],
    ]);
    expect(closed[1]?.checks.map((check) => check.name)).toEqual([CLUSTER_CLOSED]);
    expect(closed[1]?.checks[0]?.detail).toContain('process 42 still ran');
    // close() keeps its first outcome: it is not called again.
    expect(failing.closes).toEqual([{ keep: false }]);
    expect(lines).toContain('FAILED: closing the cluster: closing the cluster:\nprocess 42 still ran');

    const thrown = closingCluster(async () => {});
    const stopped = await inLiveCluster('lost-lead', 'claude', async () => thrown.cluster, false, async () => {
      throw new Error('the hub went away');
    });
    expect(stopped).toHaveLength(1);
    expect(stopped[0]).toMatchObject({ scenario: 'lost-lead', passed: false });
    expect(stopped[0]?.checks[0]).toMatchObject({ name: RAN_TO_END, passed: false });
    expect(stopped[0]?.checks[0]?.detail).toContain('the hub went away');
    // A failed cluster keeps its files.
    expect(thrown.closes).toEqual([{ keep: true }]);

    const unstartable = () => Promise.reject(new Error('no port'));
    const unstarted = await inLiveCluster('closed-laptop', 'claude', unstartable, false, run);
    expect(unstarted).toHaveLength(1);
    expect(unstarted[0]).toMatchObject({ scenario: 'closed-laptop: the cluster', passed: false });
  });
});

describe('runTakeoverCheck', () => {
  test("after a take-over that failed, it never calls the person's hand-back nor runs git in the clone", async () => {
    const root = tmpDir('agf-takeover-');
    // The agent's own .git, still in the clone: its fsmonitor leaves a mark whenever git status runs there.
    const clone = join(root, 'clone');
    mkdirSync(clone);
    await gitIn(clone, ['init', '--quiet']);
    const mark = join(root, 'fsmonitor-ran');
    const monitor = join(root, 'fsmonitor.sh');
    writeFileSync(monitor, `#!/bin/sh\ntouch '${mark}'\n`);
    chmodSync(monitor, 0o755);
    await gitIn(clone, ['config', 'core.fsmonitor', monitor]);
    writeFileSync(join(clone, 'b.txt'), 'b\n');
    // The trap works: git status in the clone runs it.
    await gitIn(clone, ['status', '--porcelain']);
    expect(existsSync(mark)).toBe(true);
    rmSync(mark);

    const homes = { claude: join(root, 'claude'), codex: join(root, 'codex') };
    for (const home of Object.values(homes)) mkdirSync(home);
    const paths = runnerPaths(join(root, 'agflow'));
    const config = createRunnerConfig({
      machineId: 'machine',
      name: 'alice-mac',
      capturedPath: '/usr/bin:/bin',
      connectivity: {},
      commitIdentity: null,
      homes,
    });
    const taskId = 'T-1';
    const a1 = 'T-1-a1';
    // The runner reported the take-over with an error, before it replaced the clone's .git (design 6.12).
    const attempt = {
      id: a1,
      agentId: 'A-1',
      vendor: 'claude',
      status: 'ended',
      endReason: 'taken_over',
      endedAt: 2,
      sessionRef: 'session-1',
      wipRef: null,
      wipSha: null,
      takeover: {
        local: null,
        anywhere: '',
        ref: 'refs/agflow/T-1/takeover/alice',
        error: 'restore failed: .claude/settings.json',
        handingBack: null,
      },
    } as unknown as Attempt;
    const task = {
      id: taskId,
      status: 'blocked',
      blockedKind: 'takeover',
      blockedReason: 'taken over by alice',
      branch: 'agflow/T-1-files',
    } as unknown as Task;
    // The long command a1 runs in its clone when the person takes over, as the process lookup reports it: a stand-in
    // for lsof, which a Linux CI may lack.
    const looked: string[] = [];
    const processesIn = async (dir: string): Promise<ProcessInfo[]> => {
      looked.push(dir);
      const lstart = 'Thu Jan  1 00:00:00 2026';
      return [{ pid: 4242, ppid: 1, pgid: 4242, stat: 'S', lstart, command: TAKEOVER.longCommand }];
    };
    const cluster = {
      vendor: 'claude',
      origin: { path: join(root, 'origin.git') },
      person: {
        login: 'alice',
        createTasks: async () => [task],
        attempt: async () => ({ attempt, log: [] }),
        task: async () => ({ task, notes: [] }),
      },
      runnerOf: async () => ({ home: { paths, config }, clonePath: () => clone }),
      waitForEvent: async () => ({ id: 1, type: 'attempt.ended', subject: taskId, data: { attemptId: a1 } }),
      async waitFor<T>(what: string, check: () => Promise<T | null | undefined | false>): Promise<T> {
        const deadline = Date.now() + 20_000;
        for (;;) {
          const value = await check();
          if (value !== null && value !== undefined && value !== false) return value;
          if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
          await Bun.sleep(50);
        }
      },
      dump: async () => 'the dump',
    } as unknown as Cluster;
    let handedBack = false;
    const person: TakeoverPerson = {
      takeOver: async () => {},
      handBack: async () => {
        handedBack = true;
        return { resumed: true };
      },
    };
    const results = await runTakeoverCheck(cluster, person, { scripted: false, processesIn });
    expect(looked).toEqual([clone]);
    expect(handedBack).toBe(false);
    expect(existsSync(mark)).toBe(false);
    const [own, takeover] = results;
    expect(own?.checks.map((check) => [check.name, check.passed])).toEqual([[RAN_TO_END, false]]);
    expect(own?.checks[0]?.detail).toContain('the take-over did not hand the clone over');
    expect(own?.checks[0]?.detail).toContain('restore failed: .claude/settings.json');
    // The take-over's own checks say why they ran no git in the clone.
    const replaced = takeover?.checks.find((check) => check.name === TAKEOVER.checks.gitReplaced);
    expect(replaced?.passed).toBe(false);
    expect(replaced?.detail).toContain('not run');
  }, 30_000);
});

describe('the runbook', () => {
  test('names every option parseLiveArgs accepts and has a Results section', () => {
    const runbook = readFileSync(RUNBOOK, 'utf8');
    for (const option of LIVE_OPTIONS) expect(runbook).toContain(`\`${option.flag}`);
    expect(runbook).toMatch(/^## Results$/m);
  });
});

describe('package.json', () => {
  test('the root script `bun run live-run` runs scripts/live-run.ts, kept awake', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['live-run']).toBe('caffeinate -i bun scripts/live-run.ts');
  });
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `bun test packages/testkit/test/hub-process.test.ts packages/testkit/test/live-run-script.test.ts packages/testkit/e2e/live-takeover.e2e.test.ts`
Expected: FAIL — `(fail) startHubProcess > with webDist, the hub serves the built web UI; without it, none`: `error: expect(received).toBe(expected)` — expected the fixture webDist path, received `undefined`. The other files report missing `inLiveCluster` and `TAKEOVER_CHECK` exports (15 pass, 3 fail; final-parent check, 2026-11-11).

- [ ] **Step 3: Implement**

**File:** `docs/m2-live-run.md` (new)

````markdown
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
````

**File:** `package.json` (change)

```diff
diff --git a/package.json b/package.json
index baf7611f..dbdcb5af 100644
--- a/package.json
+++ b/package.json
@@ -24,7 +24,8 @@
     "gen:codex-protocol": "bun packages/runner/scripts/gen-codex-protocol.ts",
     "smoke:codex": "AGFLOW_SMOKE=1 bun test packages/runner/test/codex",
     "check:codex-sandbox": "AGFLOW_SMOKE=1 AGFLOW_SANDBOX_CHECKS=1 bun test packages/runner/test/codex/real/sandbox.test.ts",
-    "e2e": "AGFLOW_E2E=1 caffeinate -i bun test --timeout 600000 packages/testkit/e2e"
+    "e2e": "AGFLOW_E2E=1 caffeinate -i bun test --timeout 600000 packages/testkit/e2e",
+    "live-run": "caffeinate -i bun scripts/live-run.ts"
   },
   "devDependencies": {
     "@types/bun": "1.3.14",
```

**File:** `packages/testkit/src/harness/cluster.ts` (change)

```diff
diff --git a/packages/testkit/src/harness/cluster.ts b/packages/testkit/src/harness/cluster.ts
index 3313262b..d28acc90 100644
--- a/packages/testkit/src/harness/cluster.ts
+++ b/packages/testkit/src/harness/cluster.ts
@@ -52,6 +52,8 @@ export interface ClusterOptions {
   repo?: string;
   /** How long waitFor and waitForEvent wait by default; 120 s. A live run waits longer for real models. */
   waitMs?: number;
+  /** The built web UI for the hub to serve (HubProcessOptions.webDist); none by default. */
+  webDist?: string;
 }
 
 export interface ClusterWaitOptions {
@@ -301,7 +303,12 @@ export async function startCluster(options: ClusterOptions): Promise<Cluster> {
     }
     started.models = real === null ? await startModels({ programs: options.programs }) : noScriptedModels();
     const repo = options.repo ?? started.origin.path;
-    const hub = await startHubProcess({ dir: join(dir, 'hub'), repo, timings: options.hubTimings });
+    const hub = await startHubProcess({
+      dir: join(dir, 'hub'),
+      repo,
+      timings: options.hubTimings,
+      webDist: options.webDist,
+    });
     started.hub = hub;
     const people = await Promise.all(E2E_USERS.map((login) => signIn(hub.url, login)));
     const [person] = people;
```

**File:** `packages/testkit/src/harness/hub-process.ts` (change)

```diff
diff --git a/packages/testkit/src/harness/hub-process.ts b/packages/testkit/src/harness/hub-process.ts
index 115781f7..5b7924d8 100644
--- a/packages/testkit/src/harness/hub-process.ts
+++ b/packages/testkit/src/harness/hub-process.ts
@@ -57,6 +57,8 @@ export interface HubProcessOptions {
   timings?: HubTimings;
   /** How long a start may take to answer /api/auth-config; 30 s by default. */
   startTimeoutMs?: number;
+  /** AGFLOW_WEB_DIST: the built web UI, which the hub then serves (a live run's take-over check uses it). */
+  webDist?: string;
 }
 
 export interface HubProcess {
@@ -150,6 +152,7 @@ function createHubProcess(options: HubProcessOptions, port: number): HubProcess
     AGFLOW_BACKUP_DIR: backupDir,
     AGFLOW_TEST: '1',
     AGFLOW_TEST_CONFIG: JSON.stringify(options.timings ?? E2E_HUB_TIMINGS),
+    ...(options.webDist === undefined ? {} : { AGFLOW_WEB_DIST: options.webDist }),
   };
   let proc: Bun.Subprocess | null = null;
 
```

**File:** `packages/testkit/src/live.ts` (change)

```diff
diff --git a/packages/testkit/src/live.ts b/packages/testkit/src/live.ts
index 391729dd..22773e5a 100644
--- a/packages/testkit/src/live.ts
+++ b/packages/testkit/src/live.ts
@@ -2,8 +2,9 @@
 // runners, each with its own AGFLOW_HOME, whose runner.json points at the person's runner vendor homes that one
 // `agflow runner setup` logged in, and at the pinned binaries it installed. The scenario drivers run unchanged, with
 // task texts that tell a real model what the scripted programs do; their checks become a results table and
-// results.json. Nothing here sends a prompt: checkVendorHome asks the vendor CLIs only for their login status.
-import { existsSync } from 'node:fs';
+// results.json. The take-over check (design 6.12) adds a person at a browser and a terminal, or a stand-in for one.
+// Nothing here sends a prompt: checkVendorHome asks the vendor CLIs only for their login status.
+import { existsSync, lstatSync } from 'node:fs';
 import { homedir } from 'node:os';
 import { join, resolve } from 'node:path';
 import { type Vendor, VendorSchema } from '@agflow/core';
@@ -17,10 +18,21 @@ import {
   type VendorLoginStatus,
 } from '@agflow/runner/src/vendor/login';
 import { VENDOR_PINS, vendorBinary } from '@agflow/runner/src/vendor/pins';
-import type { ClusterOptions } from './harness/cluster';
+import { gitIn, isAncestor } from './git-fixtures';
+import type { Cluster, ClusterOptions } from './harness/cluster';
 import { E2E_PLATFORM } from './harness/env';
-import { LOST_LEAD } from './scenarios/lost-lead';
-import type { ScenarioResult } from './scenarios/result';
+import { closedLaptop } from './scenarios/closed-laptop';
+import { killedAgent } from './scenarios/killed-agent';
+import { LOST_LEAD, lostLead } from './scenarios/lost-lead';
+import {
+  checks,
+  cloneFile,
+  type ScenarioOptions,
+  type ScenarioResult,
+  SNAPSHOT_SUBJECT,
+  shown,
+} from './scenarios/result';
+import { handbackChecks, readyForTakeover, type TakeoverOptions, takeoverChecks } from './scenarios/takeover';
 
 const VENDORS: readonly Vendor[] = VendorSchema.options;
 
@@ -383,3 +395,186 @@ export function formatResults(results: readonly ScenarioResult[]): { markdown: s
   const passed = results.length > 0 && results.every((result) => result.passed);
   return { markdown: `${lines.join('\n')}\n`, json: { passed, rows } };
 }
+
+/** Runs one exit scenario's driver in a live cluster: real models have no programs and no gates. */
+export function runLiveScenario(cluster: Cluster, scenario: LiveScenario): Promise<ScenarioResult> {
+  const options: ScenarioOptions = { scripted: false };
+  switch (scenario) {
+    case 'killed-agent':
+      return killedAgent(cluster, options);
+    case 'closed-laptop':
+      return closedLaptop(cluster, options);
+    case 'lost-lead':
+      return lostLead(cluster, options);
+  }
+}
+
+/** The check a live cluster whose close failed fails. */
+export const CLUSTER_CLOSED = 'the cluster closed cleanly';
+
+/** Where a live run tells the person how it goes: a line at a time, an empty one by default. */
+export type LiveLog = (line?: string) => void;
+
+/**
+ * Runs body in the cluster start gives, then closes it, keeping its files when asked or when a check failed. It never
+ * throws, so one cluster's trouble never ends a run that spends real quota: a cluster that does not start, a body that
+ * throws and a close that fails each add a failed result, and the run goes on with the next cluster.
+ */
+export async function inLiveCluster(
+  what: string,
+  vendor: Vendor,
+  start: () => Promise<Cluster>,
+  keep: boolean,
+  body: (cluster: Cluster) => Promise<ScenarioResult[]>,
+  log: LiveLog = () => {},
+): Promise<ScenarioResult[]> {
+  log();
+  log(`== ${what} (${vendor})`);
+  const holder: { cluster?: Cluster } = {};
+  const started = await checks(`${what}: the cluster`, vendor, async () => {
+    holder.cluster = await start();
+  });
+  const cluster = holder.cluster;
+  if (cluster === undefined) return [started];
+  log(`The hub is at ${cluster.hub.url}; the cluster's files are in ${cluster.dir}.`);
+  let results: ScenarioResult[];
+  try {
+    results = await body(cluster);
+  } catch (error) {
+    // The drivers record their own failures; whatever else stops the body still becomes a row of the table.
+    results = [await checks(what, vendor, () => Promise.reject(error))];
+  }
+  for (const result of results) log(`${result.passed ? 'passed' : 'FAILED'}: ${result.scenario} (${vendor})`);
+  const kept = keep || !results.every((result) => result.passed);
+  try {
+    await cluster.close({ keep: kept });
+  } catch (error) {
+    // close() keeps its first outcome, so a second call would only fail again.
+    const why = error instanceof Error ? error.message : String(error);
+    const detail = `${why}\n${kept ? `its files are in ${cluster.dir}` : 'its files were removed'}`;
+    log(`FAILED: closing the cluster: ${why}`);
+    const checked = [{ name: CLUSTER_CLOSED, passed: false, detail }];
+    results.push({ scenario: `${what}: the cluster`, vendor, checks: checked, passed: false, dump: null });
+  }
+  return results;
+}
+
+/** What a person's step of the take-over check is about. */
+export interface TakeoverStep {
+  cluster: Cluster;
+  taskId: string;
+  /** The attempt the person takes over. */
+  attemptId: string;
+}
+
+export interface HandbackStep extends TakeoverStep {
+  /** The taken-over clone, where the person works: the runner has replaced its .git with its own. */
+  clone: string;
+  /** The command that resumes the session on the runner's laptop. */
+  local: string;
+}
+
+/**
+ * The person of the take-over check: in a live run someone at a browser and a terminal (scripts/live-run.ts), in a
+ * test a stand-in that uses the API and plain git.
+ */
+export interface TakeoverPerson {
+  /** Takes the task over, as the task page's Take over does; resolves once the hub was asked. */
+  takeOver(step: TakeoverStep): Promise<void>;
+  /**
+   * Resumes the session with the local command if they can, commits in the clone, and hands back from the clone;
+   * resolves once the hand-back was done. resumed: whether the person saw the local command resume the session and
+   * committed from it, or null when they did not run it.
+   */
+  handBack(step: HandbackStep): Promise<{ resumed: boolean | null }>;
+}
+
+/** The take-over check's own result: the person's part, and the run as a whole. */
+export const TAKEOVER_CHECK = {
+  scenario: 'take-over check',
+  checks: {
+    committed: "the person's commit in the clone is on top of the head the runner harvested",
+    resumed: "the person resumed the agent's session with the local command in a terminal and committed from it",
+  },
+} as const;
+
+/**
+ * The taken-over clone and its local command, once the runner handed it over (design 6.12): a1 ended taken over with no
+ * take-over error, and the clone's .git is a directory sharing the runner's vault. Otherwise the agent's own .git may
+ * still be in the clone, and git there would run what the agent planted in it (hooks, core.fsmonitor, filters) with the
+ * owner's rights, so this throws before anyone runs git in it.
+ */
+async function handedOver(
+  cluster: Cluster,
+  taskId: string,
+  attemptId: string,
+): Promise<{ clone: string; local: string }> {
+  await cluster.waitForEvent({ type: 'attempt.ended', subject: taskId, attemptId });
+  const { attempt } = await cluster.person.attempt(attemptId);
+  const runner = await cluster.runnerOf(attemptId);
+  const clone = runner.clonePath(attemptId);
+  const takeover = attempt.takeover;
+  const local = takeover?.local ?? null;
+  const refuse = (why: string): never => {
+    throw new Error(`the take-over did not hand the clone over (${why}): nothing runs git in ${clone}`);
+  };
+  if (takeover === null || takeover.error !== null || local === null) {
+    return refuse(takeover === null ? 'no take-over record' : (takeover.error ?? 'no local command'));
+  }
+  if (lstatSync(join(clone, '.git'), { throwIfNoEntry: false })?.isDirectory() !== true) {
+    return refuse("the clone's .git is not a directory");
+  }
+  // Read as a file, never through git: the runner's .git is a shared clone of its vault.
+  const alternates = cloneFile(clone, '.git/objects/info/alternates') ?? '';
+  const { vaults } = runner.home.paths;
+  if (!alternates.includes(vaults)) {
+    return refuse(`the clone's .git does not share ${vaults}: alternates ${shown(alternates.trim())}`);
+  }
+  return { clone, local };
+}
+
+/**
+ * The TTY check of a take-over (design 6.12, 15): the person takes over the take-over scenario's task, works in the
+ * clone and hands back from it; the take-over scenario's takeoverChecks and handbackChecks then give their verdicts.
+ * Its own result comes first: the person's commit, whether the session resumed (when the person could tell), and
+ * whether the check ran to its end.
+ */
+export async function runTakeoverCheck(
+  cluster: Cluster,
+  person: TakeoverPerson,
+  options: TakeoverOptions = {},
+): Promise<ScenarioResult[]> {
+  const verdicts: ScenarioResult[] = [];
+  const own = await checks(
+    TAKEOVER_CHECK.scenario,
+    cluster.vendor,
+    async (record) => {
+      const { origin, waitForEvent } = cluster;
+      const { taskId, attemptId } = await readyForTakeover(cluster, options);
+      const login = cluster.person.login;
+      await person.takeOver({ cluster, taskId, attemptId });
+      // takeoverChecks runs git in the clone only once the runner replaced its .git; it records why otherwise.
+      verdicts.push(await takeoverChecks(cluster, { taskId, attemptId, login }, options));
+      // Neither the check nor the person goes on in a clone the runner did not hand over.
+      const { clone, local } = await handedOver(cluster, taskId, attemptId);
+      const harvested = await gitIn(clone, ['rev-parse', 'HEAD'], { allowFailure: true });
+      const { resumed } = await person.handBack({ cluster, taskId, attemptId, clone, local });
+      if (resumed !== null) record.check(TAKEOVER_CHECK.checks.resumed, resumed, `${shown(local)}: ${resumed}`);
+      // The person's commit: the hand-back's head, under the snapshot of anything they left uncommitted.
+      const handed = await waitForEvent({ type: 'task.handed_back', subject: taskId, data: { attemptId } });
+      const sha = String(handed.data.sha);
+      const subject = await gitIn(origin.path, ['log', '-1', '--format=%s', sha]);
+      const commit = subject.startsWith(SNAPSHOT_SUBJECT) ? await gitIn(origin.path, ['rev-parse', `${sha}^`]) : sha;
+      const onTop = harvested !== '' && commit !== harvested && (await isAncestor(origin.path, harvested, commit));
+      record.check(
+        TAKEOVER_CHECK.checks.committed,
+        onTop,
+        `handed back ${sha} (${shown(subject)}); the person's commit ${commit}; ` +
+          `harvested head ${harvested || 'unknown'}`,
+      );
+      verdicts.push(await handbackChecks(cluster, { taskId, attemptId, source: 'clone', commit }));
+    },
+    cluster.dump,
+  );
+  return [own, ...verdicts];
+}
```

**File:** `scripts/live-run.ts` (new)

```ts
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
  const vendors = [...new Set<Vendor>([...args.runners, ...args.takeover])];
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
    results.push(...(await inLiveCluster('take-over check', vendor, () => startCluster(options), args.keep, run, say)));
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
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `bun test packages/testkit/test/hub-process.test.ts packages/testkit/test/live-run-script.test.ts && bun test packages/testkit/e2e/live-takeover.e2e.test.ts && AGFLOW_E2E=1 caffeinate -i bun test --timeout 600000 packages/testkit/e2e/live-takeover.e2e.test.ts && bun run typecheck`
Expected: all selected tests pass (0 fail); tsc exits 0; the gated cases run for both vendors against scripted servers.

Do not execute bun run live-run as a task check. The pass command uses unit tests and the gated scripted stand-in only. This commit adds webDist to the hub and cluster and tests serving it. runTakeoverCheck refuses failed handover before git or person.handBack; its process lookup is injected in the unit test and verified against the clone. inLiveCluster records start/body/close failures and the script saves both tables after each cluster. Some review assertions were not run red before their fixes; the Linux process-seam regression was run red and then green. Leave the runbook Results table empty for the owner. See Decisions 65–68. The final-parent check quotes the webDist assertion first; the original report’s missing script/runbook failure predates these final test additions.

- [ ] **Step 5: Commit**

```bash
git add -A 'docs/m2-live-run.md' 'package.json' 'packages/testkit/e2e/live-takeover.e2e.test.ts' 'packages/testkit/src/harness/cluster.ts' 'packages/testkit/src/harness/hub-process.ts' 'packages/testkit/src/live.ts' 'packages/testkit/test/hub-process.test.ts' 'packages/testkit/test/live-run-script.test.ts' 'scripts/live-run.ts'
git commit -m 'M2G Task 16: Live run: the script, the take-over check and the runbook' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

### Task 17: README for M2

The README still describes M1, and only M2g edits it (X-44). It gains:
- the M2 status;
- setting up and running a runner (setup, start, install, status, drain and undrain, restart, stop, uninstall) and what setup checks;
- what runner agents can and cannot do: the four boundaries, approvals relayed to the owner, managed devices, and the residual risks in brief;
- the new web views: Runners, Approvals with its badge, the agent actions, attempts and take-over on the task page, and the runner-leads switch;
- take-over and hand-back;
- dependency preparation through .agflow/config.json;
- protected paths;
- the new hub settings, hub test mode and the restore command;
- the development commands of every M2 plan and the test gates.
A test keeps the README true to the code.

**Files:**
- Modify: `README.md`
- Test: `packages/testkit/test/docs-readme.test.ts`

- [ ] **Step 1: Write the failing test**

**File:** `packages/testkit/test/docs-readme.test.ts` (new)

````ts
import { describe, expect, test } from 'bun:test';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { HELP } from '../../cli/src/main';
import { loadConfig } from '../../hub/src/config';

const ROOT = resolve(import.meta.dir, '../../..');
const readme = readFileSync(resolve(ROOT, 'README.md'), 'utf8');
const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

function section(title: string): string {
  const heading = `## ${title}\n`;
  expect(readme, `README needs a ${title} section`).toContain(heading);
  return readme.split(heading)[1]!.split(/\n## /)[0]!;
}

describe('README contracts', () => {
  test('the configuration table lists exactly the production AGFLOW variables read by the hub', () => {
    const reads = new Set<string>();
    // Observe actual lookups, including the data-driven runner settings, without starting a hub.
    const env = new Proxy<Record<string, string | undefined>>({
      AGFLOW_ALLOWED_USERS: 'docs',
      AGFLOW_PROJECT_NAME: 'docs',
      AGFLOW_PROJECT_REPO: 'https://example.invalid/docs',
      GITHUB_CLIENT_ID: 'docs',
      GITHUB_CLIENT_SECRET: 'docs',
    }, {
      get(target, key: string) {
        if (key.startsWith('AGFLOW_')) reads.add(key);
        return target[key];
      },
    });
    loadConfig(env);
    reads.delete('AGFLOW_TEST');
    reads.delete('AGFLOW_TEST_CONFIG');
    const rows = section('Configuration').split('\n').filter((line) => line.startsWith('|'));
    const documented = rows.flatMap((row) => [...(row.split('|')[1] ?? '').matchAll(/\bAGFLOW_[A-Z_]+\b/g)].map(([name]) => name));
    expect(documented.sort()).toEqual([...reads].sort());
  });

  test('documents every runner subcommand in CLI HELP', () => {
    const commands = [...HELP.matchAll(/^\s+agflow runner ([a-z-]+)\b/gm)].map((match) => match[1]!);
    expect(commands.length).toBeGreaterThan(0);
    const documented = new Set([...readme.matchAll(/\bagflow runner ([a-z-]+)\b/g)].map((match) => match[1]));
    expect(commands.filter((command) => !documented.has(command))).toEqual([]);
  });

  test('the development block lists every root script and the test gates', () => {
    const development = section('Development');
    const blocks = [...development.matchAll(/```(?:bash|sh)\n([\s\S]*?)```/g)].map((match) => match[1]).join('\n');
    const commands = new Set([...blocks.matchAll(/\bbun run ([\w:-]+)\b/g)].map((match) => match[1]));
    if (/\bbun test\b/.test(blocks)) commands.add('test');
    expect(Object.keys(pkg.scripts).filter((script) => !commands.has(script))).toEqual([]);
    for (const gate of ['AGFLOW_SMOKE', 'AGFLOW_SANDBOX_CHECKS', 'AGFLOW_E2E', 'AGFLOW_TEST', 'AGFLOW_TEST_CONFIG']) {
      expect(development).toContain(gate);
    }
    expect(development).toContain(pkg.scripts['live-run']!);
    expect(development).toContain('bun run live-run --takeover claude,codex');
    expect(readme).toContain('](docs/m2-live-run.md)');
  });

  test('every relative Markdown link points to an existing file', () => {
    // Inline links/images and reference definitions; ignore code fences and URL fragments.
    const prose = readme.replace(/```[\s\S]*?```/g, '');
    const targets = [
      ...[...prose.matchAll(/!?\[[^\]\n]*\]\(<?([^\s)>]+)>?(?:\s+"[^"]*")?\)/g)].map((match) => match[1]!),
      ...[...prose.matchAll(/^\s*\[[^\]]+\]:\s*<?([^\s>]+)>?/gm)].map((match) => match[1]!),
    ];
    const relative = targets.filter((target) => !/^(?:[a-z][\w+.-]*:|\/\/|#)/i.test(target));
    expect(relative.length).toBeGreaterThan(0);
    for (const target of relative) {
      const path = decodeURIComponent(target.split(/[?#]/)[0]!);
      expect(statSync(resolve(ROOT, path), { throwIfNoEntry: false })?.isFile(), target).toBe(true);
    }
  });
});
````

- [ ] **Step 2: Run the tests and see them fail**

Run: `bun test packages/testkit/test/docs-readme.test.ts`
Expected: FAIL — error: expect(received).toEqual(expected) — configuration table omitted 19 production AGFLOW_* variables.

- [ ] **Step 3: Implement**

**File:** `README.md` (change)

````diff
diff --git a/README.md b/README.md
index a91090aa..cd64d83c 100644
--- a/README.md
+++ b/README.md
@@ -2,11 +2,13 @@
 
 agflow connects many Claude Code and Codex agents, including teammates' own live chats, into one project with one goal. A lead manager agent turns the goal into tasks, agents on teammates' laptops do the work, and a web UI shows everything and lets people edit the goal and steer.
 
-The design is in [docs/superpowers/specs/2026-10-26-agflow-design.md](docs/superpowers/specs/2026-10-26-agflow-design.md). Implementation plans are in [docs/superpowers/plans/](docs/superpowers/plans/).
+See the [project design](docs/superpowers/specs/2026-10-26-agflow-design.md) and the [M2 runner design](docs/superpowers/specs/2026-10-28-m2-runners-design.md), which takes precedence for runners.
 
 ## Status
 
-Milestone M1 ("project brain") is built: the hub (shared state, the REST API and the live event stream), the web UI, and the `agflow` CLI with its hooks and MCP bridge for Claude Code and Codex chats. Next is M1's end-to-end check with real chats, then M2 (runners that start agents on teammates' laptops).
+M1's hub, web UI and live-chat bridge are built. M2 adds runners that start and supervise Claude Code and Codex agents on teammates' laptops: scheduling, WIP recovery, lead failover, approvals, dependency preparation and take-over. The prototype includes automated tests with scripted model servers; the [live exit run](docs/m2-live-run.md) with real subscriptions is still pending.
+
+M2 runners support **macOS on Apple silicon (`darwin-arm64`) only**. The hub and ordinary unit tests also run on Linux. The lead still accepts or rejects submissions, and people mark tasks merged. Verification clones, reviewers, PRs and the merge queue belong to M3; usage dashboards and repository-derived context belong to M4.
 
 ## Run the hub locally
 
@@ -34,12 +36,15 @@ AGFLOW_PROJECT_NAME=demo AGFLOW_PROJECT_REPO=https://github.com/you/demo bun run
 ```
 
 Open `http://localhost:8787` and sign in. Its pages:
+
 - **Board.** Tasks by status, and a form for new tasks.
-- **Task page.** A task's contract, submission, notes, thread and history, plus the actions people can take: accept, reject, mark merged, unblock, release a claim and cancel.
-- **Goal.** Edit the goal with a preview of the changes, see the lead's notes, read the messages agents sent to people, and pause or resume all work.
-- **Agents.** Who is connected and what each agent works on.
+- **Task page.** Contract, submissions and their outcomes, notes, thread and history; accept, reject, mark merged, unblock and cancel. Runner tasks add attempts (vendor/model, runner, status, end reason, WIP ref/SHA and times), attempt logs, handoff/restatement/late-work notes, and Take over / Hand back with commands. Protected tasks are marked "live chat only".
+- **Goal.** Edit the goal, read lead notes and messages, pause or resume work, and toggle **Runner leads**. The lead seat shows whether a live chat or a runner holds it, with wake-ups since rotation.
+- **Agents.** Runner, attempt and phase, with Interrupt, Stop, Stop and hold, Replace and Take over where applicable. Stop replaces Release for runner work. A runner lead offers Interrupt, Stop and Replace; it has no Hold or Take over action.
+- **Runners.** Owner, state and why, capacity/free slots, power, disk, keep-awake, git readiness and last push. Vendor details show readiness, binary versions, plan, managed policy, quota windows, ceilings, paid usage and owner-away state; profiles show weakened items. Only the owner can edit capacity, keep-awake, drain, ceilings and paid usage, or retire a runner.
+- **Approvals** (`#/approvals`). Your pending requests, with a badge in the navigation, full command, working directory, reason, any manifest diff and time left. Read the escalation warning before approving or declining.
 - **Messages.** Steer the lead and the agents; mark a message as a standing rule.
-- **Timeline.** Everything that happened, live.
+- **Timeline.** Everything that happened, live, including runner and attempt events and filters.
 - **Knowledge.** Standing rules, and search across tasks, messages and the goal.
 
 To try the UI without agents, run the demo hub. It keeps a made-up project in memory, and one of its agents reports progress every few seconds:
@@ -76,6 +81,80 @@ agflow join --role worker --vendor both
 
 Each chat calls `hello` with the code from its brief, then works with `list_tasks`, `claim_task` and `submit`. A claimed task gets its own branch in `.worktrees/agflow/<task>`. `agflow leave` undoes `join`, and `agflow status` shows the hub, your account and the joined repositories.
 
+## Set up and run a runner
+
+Build and install the CLI as above, then sign in to the hub and set up the laptop:
+
+```bash
+agflow login --hub https://agflow.example.com
+agflow runner setup
+agflow runner status
+```
+
+Setup records the machine identity, login-shell PATH, proxy/certificate settings and git commit identity in `~/.agflow/runner/runner.json` (mode 0600). Defaults include capacity 2, keep-awake on AC and paid usage off. It installs pinned vendor binaries into its own vendor directory, logs in to separate runner vendor homes, and installs the macOS LaunchAgent. It leaves your own vendor installations alone. `--relogin` repeats vendor logins; `--no-service` omits service installation; `--yes` accepts setup defaults.
+
+Checks run **inside the service**: hub identity, repository access (`git ls-remote`), a fenced create/delete push to a probe ref, both vendor preflights (including the expected MCP surface), the dependency sandbox, and sleep settings. The runner needs your git credentials for vault fetches and pushes. It captures connectivity settings because a LaunchAgent does not inherit an interactive shell. A missing pinned binary at start is a preflight failure; start never downloads one.
+
+| Command | Effect |
+|---|---|
+| `agflow runner setup` | Interactive setup and checks; rerun after moving to another machine or retiring the runner. |
+| `agflow runner start` | Run in the foreground, with terminal and file logs; Ctrl-C suspends attempts and saves WIP. Only one instance runs. |
+| `agflow runner install` | Install/enable/start `~/Library/LaunchAgents/dev.agflow.runner.plist` in the logged-in macOS desktop session; also installs missing pins. |
+| `agflow runner status` | Query the running runner; without its socket, report best-effort service state, last exit and log tail. `--json` includes attempts and process identities. |
+| `agflow runner drain` | Take no new attempts; current work continues. Offline changes are sent at reconnect. |
+| `agflow runner undrain` | Accept work again and clear the crash-loop guard. |
+| `agflow runner restart` | Suspend attempts, save WIP and restart under launchd. |
+| `agflow runner stop` | Drain, hand off and stop agents, push WIP, then stop and disable the service until install/start. |
+| `agflow runner uninstall` | Stop, log out of runner vendor homes, retire on the hub and remove the service. `--purge` also removes runner data, vaults and work only after checking for unpushed WIP. |
+
+`AGFLOW_HOME` relocates runner storage (default `~/.agflow`). Logs are under `runner/logs/`. If status says `needs_login`, run `agflow login` again; the runner reconnects itself. Three unclean exits in ten minutes cause a self-drain until `undrain`. Keep-awake on AC prevents idle sleep, not a closed lid; after a lost runner's lease expires, another attempt can continue from pushed WIP, and later recovered work is recorded separately.
+
+## Runner permissions and risks
+
+Agents run as the laptop owner's user. Four boundaries apply to their tools:
+
+1. **Network:** Claude commands reach only allowlisted package registries; Codex commands have no network. Web search, account apps/connectors and extra MCP servers are disabled or refused at startup. Tools cannot reach the hub or git host directly.
+2. **Writes:** tools write only inside the attempt clone and its private temporary directory. Claude's Edit/Write tools also have guards.
+3. **Authority:** only the agflow bridge carries a scoped agent token to allowed hub routes. Lead authority requires the lead seat; an owner's CLI token cannot impersonate a runner agent.
+4. **Git:** agents have no push credentials or route to the host. The runner alone fetches and pushes through its protected vault, with fenced updates, and never trusts the clone's git configuration during harvest.
+
+The runner never auto-approves an escalation: requests go to the owner. Approving a Codex escalation runs that command **outside the sandbox**, with network and the owner's full write access. M2 has no mid-turn Claude approval relay; a refused operation needs human intervention. Managed device policies remain in force: agflow does not bypass MDM or weaken the vendor's policy. The `auto` Claude profile can classify Bash commands within its sandbox; that is not permission to escape it.
+
+These boundaries do not provide complete read isolation. Codex can read most owner-readable files; both sandboxes allow same-user process arguments/environment to be read, so attempts on one laptop trust each other. Claude denies credential paths and other runner data, and sandbox checks cover keychain access. Registry requests remain an exfiltration risk. Trusted base/project hooks and configuration can execute outside the sandbox; review agent configuration on main. Claude's shell snapshot can source the owner's profile outside the sandbox, and its CLI makes some cache/config writes into the owner's HOME despite a separate config directory. Lifecycle scripts can execute code from manifests agents edit. See [the security model](docs/superpowers/specs/2026-10-28-m2-runners-design.md#5-security-model-for-runner-agents) for the full boundaries and residual risks.
+
+## Take over and hand back
+
+On a task page, **Take over** is available for a running or quota-waiting attempt on an online runner, with no pending submission or stop. Otherwise use **Stop and hold** to pause work at its last WIP. Take-over blocks the task and keeps its path ownership; the lead cannot unblock it.
+
+The runner asks for a handoff, stops the agent, saves WIP, restores protected paths and replaces the clone's `.git` with a fresh runner-built one. Wait for success before entering the clone: a failed take-over shows its error and no local command. The page supplies a local resume command using the attempt's pinned CLI version and runner vendor home, or an anywhere fetch/branch command and a ref to push your work to.
+
+When finished, exit the resumed chat and every terminal/editor process in the clone, then choose **Hand back**. The clone option harvests your commits and uncommitted work; `process_running` names processes to close before retrying. The pushed-ref option needs the ref and its full 40-hex commit SHA and does not need the runner. The task becomes ready for a new attempt. If a clone hand-back loses the runner or times out, work resumes from the last recorded position and a later push becomes late work. Use Hand back, not Unblock, for a taken-over task.
+
+## Dependencies and protected paths
+
+People configure preparation in a committed `.agflow/config.json`:
+
+```json
+{
+  "dependencies": [
+    {
+      "run": ["bun", "install", "--frozen-lockfile", "--ignore-scripts"],
+      "when": ["package.json", "bun.lock"]
+    }
+  ]
+}
+```
+
+Without the file, nothing is prepared. The runner reads it from the vault at the protected restore base, never from agent-edited working files. Worker starts/resumes prepare when the listed files change; workers can also request `prepare_dependencies`. Leads get no preparation. Commands run in a sandbox with registry-only network, no owner credentials and writes confined to the clone and preparation cache, with a 15-minute timeout. Private registries are outside M2. Lifecycle scripts are disabled by default; an entry that needs them declares `"scripts": true` and uses a per-attempt cache (remove `--ignore-scripts` from that command). Go and Cargo always use per-attempt caches. If the sandbox check fails, preparation is unavailable on that runner.
+
+Protected paths are matched case-insensitively. The runner restores them before starts, resumes, preparation and take-over, strips unauthorized changes from WIP, and refuses a submission containing them:
+
+| Class | Paths | Exception |
+|---|---|---|
+| Agent configuration | `.claude/**`, `.codex/**`, `.mcp.json`, `.agents/**`, `.agflow/**` (except untracked `.agflow/run/`), `.husky/**`, `.pre-commit-config.yaml`, `lefthook.yml`, `.envrc`, `.devcontainer/**`, `.vscode/**`, `.idea/**`, `.npmrc`, `.yarnrc*`, `bunfig.toml`, `.tool-versions` | None for runner agents; tasks owning these paths are for people/live chats. |
+| People only | `.github/workflows/**`, `.gitlab-ci.yml`, `.gitlab/**`, `.env*`, `*.pem`, `*.key`, `.gitmodules`, `.gitattributes` | A person created the task and its owned paths explicitly include them. |
+| Curators only | `AGENTS.md`, `CLAUDE.md` at any depth | A task of kind `curation`. |
+
 ## Configuration
 
 | Variable | Default | Meaning |
@@ -88,28 +167,88 @@ Each chat calls `hello` with the code from its brief, then works with `list_task
 | `AGFLOW_HOST` | `127.0.0.1` with `AGFLOW_AUTH=dev`, otherwise `0.0.0.0` | Listening address; `::` accepts IPv6 as well as IPv4 |
 | `AGFLOW_PORT` | `8787` | Listening port, 1 to 65535 |
 | `AGFLOW_DB` | `data/agflow.db` | SQLite database file |
-| `AGFLOW_BACKUP_DIR` | `data/backups` | Database snapshots: one a day (the newest 7 are kept) and one at every start (the newest 3 are kept) |
+| `AGFLOW_BACKUP_DIR` | `data/backups` | Hourly snapshots (24 hours), daily snapshots (newest 7) and start snapshots (newest 3) |
 | `AGFLOW_WEB_DIST` | (unset) | Folder with the built web UI |
 | `AGFLOW_LEASE_MINUTES` | `120` | How long a claim survives without agent activity |
 | `AGFLOW_REMINDER_MINUTES` | `30` | Minimum time between "you hold a task" reminders |
 | `AGFLOW_MAX_OPEN_TASKS` | `200` | Guard: refuse new tasks beyond this many open tasks |
 | `AGFLOW_MAX_TASKS_PER_HOUR` | `60` | Guard: refuse new tasks beyond this hourly rate |
+| `AGFLOW_RUNNER_LEASE_MINUTES` | `15` | Runner silence before an attempt is lost |
+| `AGFLOW_TICK_SECONDS` | `15` | Hub scheduling/reconciliation interval |
+| `AGFLOW_STALL_MINUTES` | `10` | Stall detection window |
+| `AGFLOW_TOOL_CAP_MINUTES` | `30` | Ordinary tool runtime cap |
+| `AGFLOW_LONG_TOOL_CAP_MINUTES` | `90` | Long-running tool cap |
+| `AGFLOW_RECOVERY_SECONDS` | `120` | Reconnect/replay window after hub downtime |
+| `AGFLOW_APPROVAL_MINUTES` | `15` | Time to answer an approval |
+| `AGFLOW_LEAD_REVIEW_MINUTES` | `45` | Lead review deadline |
+| `AGFLOW_LIVE_LEAD_GRACE_MINUTES` | `120` | Live lead absence grace |
+| `AGFLOW_QUOTA_WAIT_MINUTES` | `45` | Maximum quota wait before replacement |
+| `AGFLOW_QUOTA_UNKNOWN_MINUTES` | `30` | Wait when the quota reset time is unknown |
+| `AGFLOW_ACTIVE_BUDGET_MINUTES` | `240` | Active-time budget per attempt |
+| `AGFLOW_SUBMIT_TIMEOUT_MINUTES` | `15` | Runner submission timeout |
+| `AGFLOW_MAX_WORKERS` | `4` | Project worker limit |
+| `AGFLOW_MAX_ATTEMPTS` | `3` | Attempt limit for the retry ladder |
+| `AGFLOW_LEAD_ROTATE_WAKEUPS` | `20` | Wake-ups before rotating a runner lead |
+| `AGFLOW_MAX_PLAN_CHANGES_PER_HOUR` | `60` | Churn guard: pause dispatch above this rate |
+| `AGFLOW_WIP_REF_PREFIX` | `refs/agflow/` | Work-ref namespace under `refs/`, ending in `/` |
+| `AGFLOW_MAIN_BRANCH` | `main` | Project main branch |
 | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | (unset) | OAuth app credentials, required when `AGFLOW_AUTH=github` |
 
 Behind a proxy, set `AGFLOW_PUBLIC_URL` to the address people open in the browser, with `https://` if the proxy terminates TLS. A signed-in browser can change things only from the hub's own pages, which the hub recognises by this address or by the request's Host header.
 
+Durations use the units in their variable names. Production minimums are tick 5 seconds, recovery 30 seconds, and runner lease, stall, approval and submit timeout 5 minutes each. Runner profiles/models and local settings live in `runner.json`; M2 shows profiles in the UI but does not edit them there.
+
 ### GitHub sign-in
 
 Create an OAuth app under GitHub → Settings → Developer settings → OAuth Apps. Set the callback URL to `<AGFLOW_PUBLIC_URL>/auth/github/callback`, then set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`. The hub asks GitHub for no scopes, reads only the person's GitHub login and keeps no GitHub token. Open the hub at `AGFLOW_PUBLIC_URL` to sign in: a short-lived cookie for that address ties each sign-in to the browser that started it.
 
+### Backups, restore and Known limits
+
+The first hourly backup is one hour after start; hourly housekeeping also writes a daily backup once per UTC day. Stop the hub before restoring, and use its database path:
+
+```bash
+AGFLOW_DB=data/agflow.db bun run restore data/backups/<backup-file>
+```
+
+The restore command validates the backup, keeps the replaced database aside and advances the hub epoch/counters. Restart the hub with its normal configuration; runners reconnect and replay retained events. The recovery window pauses dispatch, lease expiry and stall judgments while they reconcile.
+
+**Known limits — settings sync after a restore.** M2 keeps the runner-only, content-matched echo rule. A local edit can be lost if an equal owner echo answered it before it reached the old hub, or if the restored hub's newer settings prevent adoption of the runner's snapshot. Equal versions from different histories can also leave settings divergent; old pending echoes/probes can temporarily apply or revert settings during recovery. After restoring, check drain, capacity and other settings on both sides and reapply intended changes. Exact echo identity and restore replay selection need a protocol change in a later milestone.
+
 ## Development
 
 ```bash
-bun test            # all tests
-bun run typecheck   # TypeScript
-bun run smoke:hub   # start a real hub, check it is off the network, sign in, save a goal
-bun run smoke:cli   # real hub + CLI: login, join, hooks, MCP bridge, claim, submit
-bun run build:web   # build the web UI into packages/web/dist
-bun run demo        # a hub with a made-up project and the UI, on port 8790
-bun run check:ui    # drive the UI in headless Chromium against the demo hub
+bun test                       # ordinary unit/integration suite (also bun run test)
+bun run typecheck              # TypeScript for packages and web
+bun run hub                    # hub; set the required configuration above
+bun run restore <backup>       # restore while the hub is stopped
+bun run build:cli              # compiled CLI in dist/agflow
+bun run build:web              # web UI in packages/web/dist
+bun run smoke:hub              # local hub, sign-in and goal persistence
+bun run smoke:cli              # hub + CLI login/join/hooks/bridge/claim/submit
+bun run demo                   # made-up project on port 8790
+bun run check:ui               # headless Chromium UI checks
+bun run vendor:install         # install the pinned runner CLIs without setup
+bun run verify:prep            # macOS: real registry installs in the prep sandbox
+bun run verify:service         # macOS desktop: temporary LaunchAgent lifecycle check
+bun run record:claude          # regenerate recordings with scripted model replies
+bun run smoke:claude           # AGFLOW_SMOKE=1; pinned Claude adapter checks
+bun run check:claude-sandbox   # AGFLOW_SMOKE=1 + AGFLOW_SANDBOX_CHECKS=1
+bun run gen:codex-protocol     # regenerate protocol types from the pinned Codex
+bun run smoke:codex            # AGFLOW_SMOKE=1; pinned Codex adapter checks
+bun run check:codex-sandbox    # AGFLOW_SMOKE=1 + AGFLOW_SANDBOX_CHECKS=1
+bun run e2e                    # AGFLOW_E2E=1; scripted models, both vendors, kept awake
 ```
+
+`bun test` and `bun run typecheck` are the baseline CI gate; UI changes also need `bun run check:ui`. Adapter smoke tests use `AGFLOW_SMOKE=1`; sandbox checks additionally use `AGFLOW_SANDBOX_CHECKS=1`. Run both vendors' smoke and sandbox checks on a supported Mac. Platform-specific tests skip on Linux because **the runner supports darwin-arm64 only; design 7.1**. The E2E gate (`AGFLOW_E2E=1 bun run e2e`) uses a local hub, three scratch runner homes, a bare origin and scripted servers on loopback; once enabled, missing prerequisites fail instead of silently skipping. It covers killed agents, closed laptops, lost leads, runner/hub restarts, hub restore, mid-turn delivery and take-over/hand-back. These scripted checks spend no model quota; vendor processes use isolated homes and a refusing external proxy.
+
+`AGFLOW_TEST=1` enables hub test mode. `AGFLOW_TEST_CONFIG` is a JSON object of recognized `HubConfig` millisecond fields (including `infraBackoffMs`, an array), for example `'{"runnerLeaseMs":30000,"tickMs":100}'`. Unknown fields and non-positive values are refused; setting it without test mode is an error. Runner test mode can redirect vendors to scripted servers, skip auth checks and allow short timings through the `test` block in `runner.json`. It posts no notifications and refuses service installation.
+
+The following commands are **manual real-model runs**, outside the zero-model test gates. They use vendor logins and subscription quota. `record:claude --live` also uses real quota; its default above is scripted.
+
+```bash
+bun run verify:real-clis                  # M1 live-chat bridge check with real vendor logins
+bun run live-run                          # caffeinate -i bun scripts/live-run.ts
+bun run live-run --takeover claude,codex  # M2 exit run, including both TTY resume checks
+```
+
+Follow the [M2 live-run runbook](docs/m2-live-run.md) for prerequisites, the throwaway repository, options and the Results table. The live exit gate remains pending until those results are recorded.
````

- [ ] **Step 4: Run the tests and see them pass**

Run: `bun test packages/testkit/test/docs-readme.test.ts && bun run typecheck`
Expected: all selected tests pass (0 fail); tsc exits 0.

The README test derives its config table from hub source, command coverage from CLI HELP and script coverage from package.json, and validates relative links. Distinguish scripted gates from real-model commands and show bun run live-run --takeover claude,codex. Do not edit smoke-hub.ts for its separate temporary-directory leak. Recorded result: 4 pass and clean typecheck; the full suite was handed to the coordinator. See Decision 69.

- [ ] **Step 5: Commit**

```bash
git add -A 'README.md' 'packages/testkit/test/docs-readme.test.ts'
git commit -m 'M2G Task 17: README for M2' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

### Task 18: Spec updates, part 1: domain model and runners (§5, §6)

Design section 17 lists the spec changes; the M2 design wins where the two disagree. Superseded spec text becomes a short statement of the M2 behaviour with a link to its M2 design section, the one source of truth; no M2 text is copied (X-43). This task covers:
- §5.3: rejected → blocked, ready → failed and blocked → failed;
- §5.4: runner files in a clone live in .agflow/run/, and attempts and runners are in the hub database;
- §6.1-§6.10: per-attempt clones and the vault with WIP refs and dependency preparation (checks move to M3); the Claude and Codex adapters, without the exec fallback; runner-side continuation; delivery; the runner lease versus stall decisions, and the trigger table; scheduling with quota per account; profiles (acceptEdits with the sandbox, auto mode opt-in, no approvals answered by the runner); quota and approvals.
It also updates the M2 design itself in §5, §6.1 and §6.12: the implemented shell-profile mitigation retains only the once-per-process zshrc snapshot risk; `Attempt.takeover.handingBack` records a pending clone hand-back; and hand-back completion is distinguished from fallback without returned clone work. Two new documentation regressions pin those M2 contracts.

**Files:**
- Modify: `docs/superpowers/specs/2026-10-26-agflow-design.md`
- Modify: `docs/superpowers/specs/2026-10-28-m2-runners-design.md`
- Test: `packages/testkit/test/docs-spec.test.ts`

- [ ] **Step 1: Write the failing test**

**File:** `packages/testkit/test/docs-spec.test.ts` (new)

```ts
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { canTransition } from '../../core/src/task-state';

const SPEC_DIR = resolve(import.meta.dir, '../../../docs/superpowers/specs');
const M2_FILE = '2026-10-28-m2-runners-design.md';
const spec = readFileSync(resolve(SPEC_DIR, '2026-10-26-agflow-design.md'), 'utf8');
const m2 = readFileSync(resolve(SPEC_DIR, M2_FILE), 'utf8');

function section(number: string): string {
  const heading = `### ${number} `;
  expect(spec, `spec needs §${number}`).toContain(heading);
  return spec.split(heading)[1]!.split(/\n#{1,3} /)[0]!;
}

function withoutFences(markdown: string): string {
  return markdown.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\s*$/gm, '');
}

function linkTargets(markdown: string): string[] {
  const prose = withoutFences(markdown);
  return [
    ...[...prose.matchAll(/\[[^\]\n]*\]\(<?([^\s)>]+)>?(?:\s+"[^"]*")?\)/g)].map((match) => match[1]!),
    ...[...prose.matchAll(/^\s*\[[^\]]+\]:\s*<?([^\s>]+)>?/gm)].map((match) => match[1]!),
  ];
}

// The design uses ATX headings with plain text and inline code. GitHub removes
// punctuation, lowercases, replaces spaces with hyphens, and suffixes duplicates.
function headingAnchors(markdown: string): Set<string> {
  const anchors = new Set<string>();
  for (const match of withoutFences(markdown).matchAll(/^#{1,6}\s+(.+?)(?:\s+#+)?\s*$/gm)) {
    const base = match[1]!.toLowerCase().replace(/[^\p{L}\p{M}\p{N}_\- ]/gu, '').replace(/ /g, '-');
    let anchor = base;
    for (let suffix = 1; anchors.has(anchor); suffix++) anchor = `${base}-${suffix}`;
    anchors.add(anchor);
  }
  return anchors;
}

describe('spec M2 domain and runner contracts', () => {
  test('M2 §5 retains only the mitigated shell snapshot risk', () => {
    const security = m2.split('## 5. ')[1]!.split('## 6. ')[0]!;
    expect(security).toContain('ZDOTDIR=<claudeHome>/agflow-empty');
    expect(security).toContain('CLAUDE_CODE_SHELL=/bin/zsh');
    expect(security).toMatch(/snapshot[^\n]*~\/\.zshrc[^\n]*once per (?:Claude )?process/);
    expect(security).not.toContain('`~/.zshrc` or `~/.bashrc`');
  });

  test('M2 §6 records pending hand-backs and distinguishes fallback events', () => {
    const domain = m2.split('### 6.1 ')[1]!.split('### 6.2 ')[0]!;
    expect(domain).toContain('handingBack: { by: string; at: number } | null');
    const handback = m2.split('### 6.12 ')[1]!.split('### 6.13 ')[0]!;
    for (const term of ['Attempt.takeover.handingBack', 'user:<login>', 'epoch milliseconds',
      '409 handback_pending', 'Completion, refusal or timeout clears', 'no link',
      'task.ready', '{ from, attemptId, reason }', 'task.handed_back']) {
      expect(handback).toContain(term);
    }
  });

  test.each([
    ['rejected', 'blocked'],
    ['ready', 'failed'],
    ['blocked', 'failed'],
  ] as const)('§5.3 documents %s → %s, allowed by core', (from, to) => {
    expect(section('5.3').replace(/`/g, ''), `§5.3 must name ${from} → ${to}`).toContain(`${from} → ${to}`);
    expect(canTransition(from, to)).toBe(true);
  });

  test('§5.4 keeps attempts and runners in the hub and runner files under the clone’s .agflow/run/', () => {
    const storage = section('5.4');
    expect(storage).toMatch(/\| Hub database[^\n]*\battempts\b[^\n]*\brunners\b/);
    expect(storage).toMatch(/\|[^\n]*clone[^\n]*\.agflow\/run\//i);
    expect(storage).not.toMatch(/`\.agflow\/(?:task|brief)\.md`/);
  });

  test('§6.1 uses per-attempt clones, a vault and WIP refs, with checks deferred to M3', () => {
    const runner = section('6.1');
    expect(runner).not.toMatch(/one mirror|worktree per task|linked worktrees/i);
    for (const term of [/per-attempt clones/i, /vault/i, /WIP[^\n]*refs/i, /dependency preparation/i, /checks[^\n]*M3/i]) {
      expect(runner).toMatch(term);
    }
  });

  test('the adapters and profiles remove the obsolete fallback and automatic approval decisions', () => {
    expect(section('6.2')).toContain('Claude Agent SDK');
    expect(section('6.3')).toContain('codex app-server');
    expect(section('6.3')).not.toContain('codex exec');
    const profiles = section('6.9');
    expect(profiles).toMatch(/acceptEdits[^\n]*sandbox/);
    expect(profiles).toMatch(/auto[^\n]*opt-in/);
    expect(profiles).toMatch(/runner[^\n]*never[^\n]*approval/i);
    expect(profiles).not.toMatch(/approvals are answered by an allowlist/i);
  });

  test.each([
    ['5.3', '69-retry-ladder-the-m2-part-of-spec-95'],
    ['5.4', '72-layout'],
    ['6.1', '73-git'],
    ['6.1', '77-dependency-preparation'],
    ['6.2', '8-claude-code-adapter'],
    ['6.3', '9-codex-adapter'],
    ['6.4', '68-stall-detection-continuation-replacement-and-handoff'],
    ['6.6', '67-message-delivery-to-runner-agents'],
    ['6.7', '64-attempts-fencing-and-leases'],
    ['6.7', '68-stall-detection-continuation-replacement-and-handoff'],
    ['6.8', '66-scheduler'],
    ['6.9', '76-agent-environment-and-profile'],
    ['6.10', '610-quota-and-approvals'],
  ])('§%s delegates its contract to M2 #%s', (number, anchor) => {
    expect(linkTargets(section(number))).toContain(`${M2_FILE}#${anchor}`);
  });

  test('every spec link into the M2 design resolves to a GitHub heading anchor', () => {
    const targets = linkTargets(spec).filter((target) => target.split('#')[0]?.endsWith(M2_FILE));
    expect(targets.length, 'the spec must link to the M2 source of truth').toBeGreaterThan(0);
    const anchors = headingAnchors(m2);
    for (const target of targets) {
      const [path, fragment] = target.split('#');
      expect(resolve(SPEC_DIR, path!), target).toBe(resolve(SPEC_DIR, M2_FILE));
      expect(fragment, `${target} needs a heading fragment`).toBeTruthy();
      expect(anchors.has(decodeURIComponent(fragment!)), `${target} has no matching heading`).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `bun test packages/testkit/test/docs-spec.test.ts`
Expected: FAIL — The first failure is `spec M2 domain and runner contracts > M2 §5 retains only the mitigated shell snapshot risk`: expected `ZDOTDIR=<claudeHome>/agflow-empty` in M2 §5. Current parent replay: 0 pass, 22 fail, 46 assertions. Log: `/tmp/agflow-plan-refresh-checks/m2g-18-parent.log`.

- [ ] **Step 3: Implement**

**File:** `docs/superpowers/specs/2026-10-26-agflow-design.md` (change)

```diff
diff --git a/docs/superpowers/specs/2026-10-26-agflow-design.md b/docs/superpowers/specs/2026-10-26-agflow-design.md
index aedd7872..47bf001c 100644
--- a/docs/superpowers/specs/2026-10-26-agflow-design.md
+++ b/docs/superpowers/specs/2026-10-26-agflow-design.md
@@ -147,13 +147,15 @@ retry ladder exhausted → failed (people are notified)
 - `ready`: plan checks passed, dependencies merged, and no running task owns an overlapping path.
 - Only the hub moves a task between states.
 
+M2 adds `rejected → blocked`, `ready → failed` and `blocked → failed` for re-planning and exhausted retries. The [M2 retry ladder](2026-10-28-m2-runners-design.md#69-retry-ladder-the-m2-part-of-spec-95) defines when these transitions apply; runner-attempt endings follow the [M2 trigger table](2026-10-28-m2-runners-design.md#64-attempts-fencing-and-leases).
+
 ### 5.4 Where state lives
 
 | Store | Contents |
 |---|---|
 | Hub database (SQLite) | Tasks, attempts, leases, agents, runners, messages, budgets and the append-only event log. Backed up daily; exportable. |
 | Repository | Durable shared knowledge: `AGENTS.md`, `CLAUDE.md` (a single line, `@AGENTS.md`), `docs/goal.md` (mirror of the current goal), `docs/decisions/`, `docs/research/`, `docs/architecture.md`, skills. |
-| Each worktree (untracked) | `.agflow/task.md` (the task pack) and `.agflow/brief.md`. Rewritten by the runner; never committed. |
+| Each attempt clone (untracked) | Runner files live in `.agflow/run/`, including `task.md` and `brief.md`; never committed. See the [M2 runner layout](2026-10-28-m2-runners-design.md#72-layout). |
 
 From M3, the merge queue (§9.6) commits `docs/goal.md` whenever the goal version changes. Until then the goal lives only in the hub.
 
@@ -161,37 +163,21 @@ From M3, the merge queue (§9.6) commits `docs/goal.md` whenever the goal versio
 
 ### 6.1 Runner
 
-`agflow runner start` runs in the foreground or as a launchd service. It:
+The runner supervises agents in standalone per-attempt clones, backed by a runner-owned vault. WIP goes to per-attempt refs; only the runner pushes. See [M2 git isolation and WIP](2026-10-28-m2-runners-design.md#73-git) and [sandboxed dependency preparation](2026-10-28-m2-runners-design.md#77-dependency-preparation).
 
-- connects to the hub over an outbound WebSocket (works behind NAT; the hub never connects to laptops) and registers its owner (from `agflow login`), logged-in vendors and CLI versions, capacity (default 2 agents), permission profile and keep-awake setting;
-- keeps one mirror clone per project and creates a worktree per task on branch `agflow/T-042-<slug>`;
-- pushes work-in-progress commits to the task branch every 10 minutes and before any handoff;
-- runs checks in a separate, clean verification worktree that no agent writes to;
-- performs pushes, PR creation and merges with the owner's existing git login (`gh`, `glab` or a git credential helper);
-- holds a macOS `caffeinate` assertion while its agents work, if the owner enabled keep-awake;
-- keeps agents working through hub outages, buffering events and replaying them after reconnecting.
+Foreground operation and the macOS service follow the [M2 runner lifecycle](2026-10-28-m2-runners-design.md#71-setup-service-and-lifecycle). Verification checks, PRs and merging move to M3; see [M2 scope](2026-10-28-m2-runners-design.md#2-scope).
 
 ### 6.2 Claude Code adapter
 
-- **Drive:** the Claude Agent SDK (TypeScript, on Bun) in streaming-input mode: one long-lived `claude` process per agent; `streamInput()` sends messages at any time and `interrupt()` stops a turn. Fallback: `claude -p --input-format stream-json --output-format stream-json --verbose`.
-- **Login:** the person's subscription. Never `--bare`. The runner removes `ANTHROPIC_API_KEY` from the agent's environment because it would silently replace the subscription login in print mode.
-- **Session:** the session ID is set up front with `--session-id` and stored on the attempt. Crash recovery uses `--resume`. A person takes over with `claude --resume <id>` in the task's worktree.
-- **Context:** `AGENTS.md` through `CLAUDE.md`; the task pack; the brief through an SDK `SessionStart` hook callback, which runs again after resume and compaction. Nothing dynamic goes into `--append-system-prompt`, because the system prompt is frozen at the first request.
-- **Tools and permissions:** the agflow MCP bridge via `--mcp-config … --strict-mcp-config`; `--permission-mode auto` with the runner profile's allow rules; `--permission-prompts none`, so anything that would prompt is denied instead of waiting.
+The Claude Agent SDK drives a long-lived session with a persistent message inbox, the runner's subscription home and a command hook for the brief. Drive, session, context, permissions and recovery follow the [M2 Claude Code adapter](2026-10-28-m2-runners-design.md#8-claude-code-adapter).
 
 ### 6.3 Codex adapter
 
-- **Drive:** one private `codex app-server` process per agent over stdio JSON-RPC. `thread/start` takes `cwd`, `model`, `sandbox: workspace-write`, `approvalPolicy`, `developerInstructions` and config overrides. `turn/start` starts a turn, `turn/steer` adds input to a running turn, and `turn/interrupt` stops it. The runner answers approval requests according to the permission profile. Fallback: `codex exec --json` plus `codex exec resume` (no steering mid-turn).
-- **Protocol types:** generated with `codex app-server generate-ts` for the pinned CLI version, and regenerated whenever the pin changes.
-- **Login:** the ChatGPT login stored in `CODEX_HOME`. No API key.
-- **Session:** the thread ID is stored on the attempt and used for resume and take-over (`codex resume <id>`).
-- **Context:** `AGENTS.md` loads only in trusted projects, so the runner marks each worktree as trusted through a config override. The task pack and brief are also passed as `developerInstructions`. After compaction or resume, the runner sends the brief again.
-- **Tools:** the agflow MCP bridge configured through `mcp_servers` config overrides.
-- **Quota:** read from `account/rateLimits/*` notifications.
+Each attempt uses a private `codex app-server` process. There is no exec fallback. Thread setup, project trust, context, messages, quota, approvals and recovery follow the [M2 Codex adapter](2026-10-28-m2-runners-design.md#9-codex-adapter).
 
 ### 6.4 Continuation without hooks
 
-Agents started by runners do not depend on hooks. When a turn ends and the agent has called none of `submit`, `declare_blocked` or `declare_impossible`, the runner sends a continuation prompt containing the task's remaining acceptance IDs. It does this up to `max_turns`, then marks the attempt stalled.
+The runner continues workers after eligible completed turns; leads receive no continuation. The hub decides stalls from the runner's facts. Eligibility, outage handling and budgets follow [M2 continuation and stall detection](2026-10-28-m2-runners-design.md#68-stall-detection-continuation-replacement-and-handoff).
 
 ### 6.5 Live chats (`agflow join`)
 
@@ -219,7 +205,7 @@ When a live chat claims a task, the bridge creates the task branch `agflow/T-<id
 
 | Target | Path |
 |---|---|
-| Agent started by a runner | Injected immediately: Claude `streamInput()`; Codex `turn/steer` if a turn is running, otherwise `turn/start`. |
+| Agent started by a runner | Pushed through the runner with delivery and acknowledgement tracking; see [M2 message delivery](2026-10-28-m2-runners-design.md#67-message-delivery-to-runner-agents) for batching, backlog and authority rules. |
 | Live Claude chat | `Stop` and `UserPromptSubmit` hooks. Best-effort immediate delivery to an idle chat through its session inbox socket (works, but the message format is undocumented). |
 | Live Codex chat | Hooks. Best-effort immediate delivery through the shared Codex daemon (not yet verified live). |
 
@@ -228,53 +214,21 @@ When a live chat claims a task, the bridge creates the task branch `agflow/T-<id
 
 ### 6.7 Leases, liveness and replacement
 
-- **Lease.** A claim is a lease `{task, attempt, agent, fencing_token, expires_at}`. Leases are renewed by activity the runner observes — agent events, file changes, commits — never by the agent's own report. Hub time is authoritative.
-- **Stall.** An attempt is stalled when any of these hold: no events for `stall_timeout` (default 10 minutes, longer while a known long command runs); several turns without tool calls or diff changes; repeated identical actions; budget exhausted; the process exited; the runner went offline.
-- **Who kills.** Only hub code stops or replaces agents, never an agent, and every kill is logged with its reason.
-- **Handoff.** The hub first asks the agent to write a handoff note and then stops it. If that fails, the hub assembles the note itself from:
-  - the task pack;
-  - the progress reports;
-  - `git log --stat base..HEAD` of the pushed branch;
-  - decisions;
-  - the last messages;
-  - the last turns of the transcript, uploaded by the runner.
-- **Handoff note fields:** done; remaining; commands run with their results; files touched; decisions and reasons; failed approaches with exact errors; blockers; next step; verification command and its last result.
-- **Successor.** The successor, from either vendor, continues on the same branch. Its first output must restate the current state and next step; the hub records it next to the handoff note so the manager can spot a mismatch.
-- **Fencing.** Submissions and pushes carrying an outdated fencing token are rejected.
-- **Fresh context per attempt.** Each attempt is a fresh agent, so context does not rot across tasks.
-- **Manager rotation.** Managers are long-lived but rotated with a handoff when their context grows large or after a fixed number of wake-ups.
+A runner lease measures laptop presence and is renewed by heartbeats. Stall decisions belong to the hub and use fresh attempt facts. Attempt endings, fencing and task moves follow the [M2 trigger table and lease rules](2026-10-28-m2-runners-design.md#64-attempts-fencing-and-leases); replacement, crashes, handoffs and successor context follow [M2 stall detection and handoff](2026-10-28-m2-runners-design.md#68-stall-detection-continuation-replacement-and-handoff).
+
+Live chats retain their M1 task leases, as distinguished in the same lease rules.
 
 ### 6.8 Scheduling and requesting agents
 
-- **Tick.** Every 15 seconds and on relevant events, the scheduler:
-  1. reconciles hub state with what runners actually report;
-  2. computes the ready set;
-  3. orders it by priority, then age;
-  4. claims tasks atomically;
-  5. dispatches each to a runner that has a free slot, the right vendor login and remaining quota.
-- **Caps:** concurrent code-writing agents per project (default 4); per-runner capacity; per-area share, set by the lead (M4); per vendor.
-- **`request_agents(role, count, vendor?, model?, reason)`** starts whatever the caps allow and replies with what actually started.
-- **Auto-fill.** If ready tasks are waiting and slots are free, the scheduler starts workers without asking a manager.
-- **Vendor choice, in order:**
-  1. a reviewer always differs from the author's vendor;
-  2. then the task's `vendor_hint`;
-  3. then the vendor with more remaining quota.
+The hub reconciles attempts and auto-fills ready work within the worker target and runner capacity. Placement uses quota per account, shared across that owner's runners. Ordering, eligibility, vendor preferences and `request_agents` follow the [M2 scheduler](2026-10-28-m2-runners-design.md#66-scheduler).
 
 ### 6.9 Permission profiles
 
-- **Default laptop profile:**
-  - Codex runs with `sandbox = workspace-write`. Command approvals are answered by an allowlist; everything else is declined.
-  - Claude Code runs with `--permission-mode auto`, the same allowlist as allow rules, and `--permission-prompts none`.
-- **Write access** is limited to the task's worktree.
-- **Network access** follows the profile, which defaults to package registries plus the git host.
-- **The owner** can tighten or loosen the profile per project.
+Claude defaults to `acceptEdits` with the sandbox; `auto` mode is opt-in. Codex uses `workspace-write`. The runner never decides an approval itself. Profiles, filesystem and network limits, and the agent environment follow [M2 profiles](2026-10-28-m2-runners-design.md#76-agent-environment-and-profile); requests that need an owner follow the [M2 approvals relay](2026-10-28-m2-runners-design.md#610-quota-and-approvals).
 
 ### 6.10 Accounts and usage limits
 
-- A runner uses only its owner's own logins. Credentials never leave the laptop and are never shared.
-- All of one person's parallel sessions share that account's 5-hour and weekly allowances, for both vendors.
-- When a runner sees a limit signal (Codex rate-limit notifications; Claude limit errors or results), it marks that vendor exhausted until the reset time, and the scheduler routes work elsewhere.
-- Plans' fair-use terms assume individual use. Heavy autonomous use may call for team or business plans. The UI shows usage per person so the team can judge.
+Runners use their owner's subscription logins in runner-specific vendor homes; credentials stay on the laptop. Quota is shared per owner, vendor and account, with per-runner ceilings and paid usage disabled by default. Quota waits, reset handling and owner-only approval decisions follow [M2 quota and approvals](2026-10-28-m2-runners-design.md#610-quota-and-approvals).
 
 ## 7. Managers, steering and the goal
 
```

**File:** `docs/superpowers/specs/2026-10-28-m2-runners-design.md` (change)

```diff
diff --git a/docs/superpowers/specs/2026-10-28-m2-runners-design.md b/docs/superpowers/specs/2026-10-28-m2-runners-design.md
index 6ebbdd65..589c4220 100644
--- a/docs/superpowers/specs/2026-10-28-m2-runners-design.md
+++ b/docs/superpowers/specs/2026-10-28-m2-runners-design.md
@@ -127,7 +127,7 @@ Both sandboxes also let agent commands read the argv and environment of every pr
 **Device policy.** agflow never works around an organisation's policy. On a device whose Codex policy is managed, nothing changes, because the runner already answers no approval.
 
 **Residual risks:**
-- **Shell profile.** Claude Code sources the owner's shell profile (`~/.zshrc` or `~/.bashrc`) outside the sandbox once per Claude process, with the agent's environment, to build its shell snapshot.
+- **Shell profile.** The mitigation is implemented: the adapter sets `ZDOTDIR=<claudeHome>/agflow-empty`, drops any incoming `CLAUDE_CODE_SHELL`, and sets `CLAUDE_CODE_SHELL=/bin/zsh` unless the basename of `SHELL` is already `zsh`. Only the snapshot sources the owner's `~/.zshrc` outside the sandbox, once per Claude process, with the agent's environment. `~/.zshenv`, `~/.zprofile`, `~/.zlogin` and `~/.bashrc` do not run around agent commands. The snapshot remains an accepted residual risk.
 - **Package registries.** They are allowed hosts for Claude, so a determined agent could encode data in registry requests.
 - **Base checkout.** Hooks and settings from the base checkout of `main` run outside the sandbox. Agent-config paths on `main` change only through people (section 7.3).
 - **The `auto` profile.** Claude's classifier decides Bash commands that would otherwise prompt, within the sandbox. The guard still confines `Edit` and `Write`.
@@ -184,7 +184,7 @@ export interface Attempt {
   phase: AttemptPhase | null;
   facts: AttemptFacts | null;
   stopRequested: { cause: StopCause; reason: string; by: string; handoff: boolean; deferred: boolean; at: number } | null;
-  takeover: { local: string | null; anywhere: string; ref: string; error: string | null } | null;
+  takeover: { local: string | null; anywhere: string; ref: string; error: string | null; handingBack: { by: string; at: number } | null } | null;
                               // commands shown to the person; ref: the take-over ref they push to (section 6.12)
   leaseExpiresAt: number | null;
   quotaResetsAt: number | null;
@@ -1275,15 +1275,16 @@ Messages that the ended lead received but never acknowledged become unread again
   - anywhere: `git fetch origin <work ref> && git switch -c agflow/T-42-<slug> FETCH_HEAD`, and when done, `git push origin HEAD:<wipRefPrefix>T-42/takeover-<login>`. The hub keeps that take-over ref in `Attempt.takeover.ref`, so the page can offer it for a hand-back.
 
 **Hand back** (the same person, or anyone if the runner is gone, which means not `online`; `POST /api/tasks/:id/handback { source }`).
+- **Pending clone hand-back.** `Attempt.takeover.handingBack` records `{ by, at }`, with `by=user:<login>` and `at` in epoch milliseconds, while the hub waits for clone work. Another otherwise-authorized hand-back receives `409 handback_pending`, including one from a ref. Completion, refusal or timeout clears it.
 - **Clone source** (`'clone'`, the runner's clone). The hub sends `hand_back` to the attempt's runner, which:
   - stops the runner-home Codex daemon (`CODEX_HOME=<runner codex home> <runner codex> app-server daemon stop`, errors ignored);
   - refuses if a process still runs in the clone: the command answers `{ ok: false, error: 'process_running' }`, naming the pids, and the runner logs an `attempt.activity` note. The hub keeps the task `blocked` (`takeover`), shows the error in `Attempt.takeover.error`, and stops the hand-back timer; the person may hand back again;
   - harvests the clone (the person's commits and uncommitted changes), and strips and checks it like a WIP;
   - pushes the result to a new late-work ref, reports `attempt.handed_back`, and then cleans the attempt up.
 
-  The task stays `blocked` until `attempt.handed_back` arrives. Then the hub records the sha as the work position (not late work) and moves the task to `ready`. If the runner is offline, or nothing arrives within `handbackTimeoutMs` (10 minutes), the task becomes `ready` from the last recorded position, and a later push is late work.
+  The task stays `blocked` until `attempt.handed_back` arrives. Then the hub records the sha as the work position (not late work), moves the task to `ready`, and emits `task.handed_back`. If the runner has no link, or nothing arrives within `handbackTimeoutMs` (10 minutes), the task becomes `ready` from the last recorded position, and a later push is late work. A connected runner reporting `disk_low` or `crash_loop` still gets time to return the clone. This fallback without returned clone work emits `task.ready` with `{ from, attemptId, reason }`, not `task.handed_back`.
 - **Ref source** (`{ ref, sha }`, for example the take-over ref; `sha` is a full 40-hex sha, because the next runner may fetch it by SHA). It needs no runner.
-  - In the request transaction, the hub records `{ ref, sha }` as the work position (not late work), moves the task to `ready`, queues `cleanup_attempt` for the taken-over attempt, and sends nothing else.
+  - In the request transaction, the hub records `{ ref, sha }` as the work position (not late work), moves the task to `ready`, emits `task.handed_back`, queues `cleanup_attempt` for the taken-over attempt, and sends nothing else.
   - The next attempt's runner fetches the ref with its `<wipRefPrefix><task>/*` refspec, or by SHA. Before starting, it restores and strips it like a WIP, and reports `attempt.violation` for stripped paths.
 - **Unblock.** Unblock on a `takeover` task answers 409, "hand it back instead".
 
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `bun test packages/testkit/test/docs-spec.test.ts && bun run typecheck`
Expected: 22 pass, 0 fail, no skips at Task 18; tsc exits 0.

This task changes both the original spec and the M2 design, with `docs-spec.test.ts`. Preserve live-chat §6.5, replace superseded rules with summaries and actual M2 links, and check the three transitions against existing core. For the new M2 changes, Task 18 owns §§5–6: `ZDOTDIR=<claudeHome>/agflow-empty`, removal of incoming `CLAUDE_CODE_SHELL`, and the `/bin/zsh` override unless `basename(SHELL) === 'zsh'`; only the snapshot sources ~/.zshrc, and that remains a residual risk. The takeover declaration includes `handingBack: { by: string; at: number } | null`. Pending clone work records `user:<login>` and epoch milliseconds; another otherwise-authorized hand-back gets `409 handback_pending`, and completion/refusal/timeout clears it. A runner with no link or a timeout falls back with `task.ready { from, attemptId, reason }`; a connected disk_low/crash_loop runner still has time to return work. Returned clone/ref work emits `task.handed_back`. Two added tests bring this task's suite to 22 tests; Task 19 adds the other two new regressions. See Decision 70. Current owning-commit archive check: 22 pass, 0 fail, 123 assertions (`/tmp/agflow-plan-refresh-checks/m2g-18-head.log`); the scratch archive was removed.

- [ ] **Step 5: Commit**

```bash
git add -A 'docs/superpowers/specs/2026-10-26-agflow-design.md' 'docs/superpowers/specs/2026-10-28-m2-runners-design.md' 'packages/testkit/test/docs-spec.test.ts'
git commit -m 'M2G Task 18: Spec updates, part 1: domain model and runners (§5, §6)' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

### Task 19: Spec updates, part 2: managers, interfaces, security, failures and milestones (§7, §11-§18)

This task completes design section 17 the same way:
- §7.1 and §7.6: the lead-seat record, and leads on runners;
- §11.1: the agent-token route allowlist;
- §11.2: the runner link of M2 design 6.3;
- §12: the security model of M2 design 5 and 6.5;
- §13: the recovery window, clock jumps, epochs and late work;
- §14: testing as in M2 design 15;
- §15: packages/runner and packages/testkit;
- §16: the M2 scope as in M2 design 2;
- §17: question 3 answered with the nested projects.<path>.trust_level override;
- §18: a new status column. #1-#4, #5 (except rebut_review, moved to M3), #6, #7, #11, #12 and #14-#16 are resolved by M2, #2 with dependency preparation; the other rows stay open for M3 or M4.
The M2 design's status line names the plans that implemented it. There is no implementation-notes section: later contract changes go to the M2 design's section 18 (X-43).
This task carries the implemented shell mitigation through M2 §§3, 7.6, 8.2, 15 and 18, and records the complete X-49 facts in §18. Task 18 already owns the new shell-risk and hand-back edits in M2 §§5–6. Two additional documentation regressions check the remaining shell sections and full X-49 contract, bringing the final suite to 46 tests.

**Files:**
- Modify: `docs/superpowers/specs/2026-10-26-agflow-design.md`
- Modify: `docs/superpowers/specs/2026-10-28-m2-runners-design.md`
- Test: `packages/testkit/test/docs-spec.test.ts`

- [ ] **Step 1: Write the failing test**

**File:** `packages/testkit/test/docs-spec.test.ts` (change)

````diff
diff --git a/packages/testkit/test/docs-spec.test.ts b/packages/testkit/test/docs-spec.test.ts
index 9f074a52..4ec4f455 100644
--- a/packages/testkit/test/docs-spec.test.ts
+++ b/packages/testkit/test/docs-spec.test.ts
@@ -1,5 +1,5 @@
 import { describe, expect, test } from 'bun:test';
-import { readFileSync } from 'node:fs';
+import { readFileSync, readdirSync } from 'node:fs';
 import { resolve } from 'node:path';
 import { canTransition } from '../../core/src/task-state';
 
@@ -9,11 +9,16 @@ const spec = readFileSync(resolve(SPEC_DIR, '2026-10-26-agflow-design.md'), 'utf
 const m2 = readFileSync(resolve(SPEC_DIR, M2_FILE), 'utf8');
 
 function section(number: string): string {
-  const heading = `### ${number} `;
+  const heading = number.includes('.') ? `### ${number} ` : `## ${number}. `;
   expect(spec, `spec needs §${number}`).toContain(heading);
   return spec.split(heading)[1]!.split(/\n#{1,3} /)[0]!;
 }
 
+function tableRows(markdown: string): string[][] {
+  return markdown.split('\n').filter((line) => line.startsWith('|'))
+    .map((line) => line.slice(1, -1).split('|').map((cell) => cell.trim()));
+}
+
 function withoutFences(markdown: string): string {
   return markdown.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\s*$/gm, '');
 }
@@ -124,3 +129,155 @@ describe('spec M2 domain and runner contracts', () => {
     }
   });
 });
+
+describe('spec M2 managers, security and milestones', () => {
+  test('M2 carries the implemented shell mitigation through verification, environment and snapshot rules', () => {
+    for (const number of ['3', '7.6', '8.2', '15', '18']) {
+      const heading = number.includes('.') ? `### ${number} ` : `## ${number}. `;
+      const text = m2.split(heading)[1]!.split(/\n#{1,3} /)[0]!;
+      expect(text, `M2 §${number}`).toContain('~/.zshrc');
+      if (number !== '15') {
+        expect(text, `M2 §${number}`).toContain('ZDOTDIR');
+        expect(text, `M2 §${number}`).toContain('CLAUDE_CODE_SHELL');
+      }
+    }
+    const checks = m2.split('## 15. ')[1]!.split('## 16. ')[0]!;
+    expect(checks).toContain("With either zsh or bash as the owner's `SHELL`");
+    expect(checks).toContain('their functions and PATH changes do not reach agent commands');
+    expect(m2).not.toContain('shell-profile proposal in the review notes remains undecided');
+    expect(m2).not.toContain('(or `.bashrc`)');
+  });
+
+  test('M2 §18 records the full X-49 contract', () => {
+    const changes = m2.split('## 18. ')[1]!;
+    for (const term of ['X-49', 'Runner.stateDetail', 'refused a start: <code>', 'next heartbeat',
+      'Attempt.stopRequested.by', 'user:<login>', 'agent:<id>', 'system', 'handingBack',
+      'epoch milliseconds', '409 handback_pending', 'Completion, refusal or timeout clears',
+      'task.ready', '{ from, attemptId, reason }', 'task.handed_back', 'reportHolds', 'utilization']) {
+      expect(changes).toContain(term);
+    }
+  });
+
+  test('§18 assigns every finding its M2 resolution or deferred milestone', () => {
+    const [header, , ...rows] = tableRows(section('18'));
+    expect(header, '§18 needs a Status column').toContain('Status');
+    const statusColumn = header!.indexOf('Status');
+    expect(rows.map((row) => Number(row[0]))).toEqual(Array.from({ length: 17 }, (_, i) => i + 1));
+    for (const row of rows) {
+      const id = Number(row[0]);
+      const expected = id === 5 ? 'Resolved in M2 except `rebut_review` (M3)'
+        : id === 2 ? 'Resolved in M2 with sandboxed dependency preparation; checks in M3'
+        : id === 17 ? 'Open for M4'
+        : [8, 9, 10, 13].includes(id) ? 'Open for M3' : 'Resolved in M2';
+      expect(row[statusColumn], `finding #${id}`).toBe(expected);
+    }
+  });
+
+  test('§17 question 3 answers trust with the nested projects.<path>.trust_level override', () => {
+    const question = section('17').split(/\n3\. /)[1]!.split(/\n4\. /)[0]!;
+    expect(question).toMatch(/answered/i);
+    expect(question).toContain('projects.<path>.trust_level');
+    expect(question).toMatch(/projects:\s*\{\s*\[realpath\(clone\)\]:\s*\{\s*trust_level:/);
+    expect(question).toContain("'trusted'");
+    expect(question).toContain("'untrusted'");
+    expect(linkTargets(question)).toContain(`${M2_FILE}#92-threads-and-turns`);
+  });
+
+  test('§15 layout lists exactly the package directories, once each', () => {
+    const layout = section('15').match(/```[^\n]*\n([\s\S]*?)```/)![1]!;
+    const listed = [...layout.matchAll(/^packages\/([^\s/]+)/gm)].map((match) => match[1]!).sort();
+    const actual = readdirSync(resolve(SPEC_DIR, '../../../packages'), { withFileTypes: true })
+      .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
+    expect(listed).toEqual(actual);
+    expect(layout).toMatch(/packages\/runner[^\n]*clones[^\n]*vault/);
+    expect(layout).toMatch(/packages\/testkit[^\n]*scripted model servers/);
+  });
+
+  test('§16 M2 scope delegates to the M2 scope section', () => {
+    const row = tableRows(section('16')).find((cells) => cells[0]?.includes('M2:'))!;
+    expect(linkTargets(row[1]!)).toContain(`${M2_FILE}#2-scope`);
+    expect(row[1]).not.toContain('worktrees');
+  });
+
+  test('the M2 status names all seven implementing plans', () => {
+    const status = m2.match(/^- \*\*Status:\*\* (.+)$/m)![1]!;
+    expect(status).toMatch(/implemented/i);
+    expect(status.match(/\bM2[a-g]\b/g)).toEqual(['M2a', 'M2b', 'M2c', 'M2d', 'M2e', 'M2f', 'M2g']);
+    expect(m2).not.toMatch(/^#{1,6} .*implementation notes/im);
+  });
+
+  test.each([
+    ['7.1', '611-the-lead-on-runners'],
+    ['7.6', '611-the-lead-on-runners'],
+    ['7.6', '615-guards'],
+    ['11.1', '65-agent-tokens-and-principals'],
+    ['11.2', '63-runner-link'],
+    ['12', '5-security-model-for-runner-agents'],
+    ['12', '65-agent-tokens-and-principals'],
+    ['13', '614-restarts-clock-jumps-restores-and-backups'],
+    ['13', '63-runner-link'],
+    ['14', '15-testing'],
+    ['15', '13-packages-and-interfaces'],
+  ])('§%s delegates its contract to M2 #%s', (number, anchor) => {
+    expect(linkTargets(section(number))).toContain(`${M2_FILE}#${anchor}`);
+  });
+
+  test('superseded manager, link, security and failure rules are removed', () => {
+    expect(section('7.1')).toContain('lead seat');
+    expect(section('7.6')).not.toMatch(/4 re-plans|Hitting any limit/);
+    expect(section('11.1')).toMatch(/403[^\n]*agent_not_allowed/);
+    expect(section('11.2')).not.toMatch(/command_result|start_agent|run_checks|update_profile/);
+    expect(section('12')).not.toMatch(/stored in the OS keychain/);
+    expect(section('13')).not.toMatch(/hub unavailable, keep working|Restore from the daily backup/);
+    for (const term of [/recovery window/i, /clock jump/i, /epoch/i, /late work/i]) {
+      expect(section('13')).toMatch(term);
+    }
+    expect(section('14')).toMatch(/scripted model servers/i);
+    expect(section('14')).toMatch(/tamper[^\n]*M3/i);
+  });
+
+  test('settings-sync keeps the runner-only rule and records its limits and later protocol fix', () => {
+    const sync = m2.split('**Settings sync.**')[1]!.split('**Link behaviour:**')[0]!;
+    expect(sync).toContain('oldest unanswered edit');
+    expect(sync).toContain('Known limits');
+    expect(sync).toMatch(/After a restore[^\n]*equal echo[^\n]*lost/);
+    expect(sync).toContain('same versions');
+    const changes = m2.split('## 18. ')[1]!;
+    expect(changes).toMatch(/settings sync/i);
+    expect(changes).toMatch(/later milestone/i);
+    expect(changes).toContain('answers {seq, refused?}');
+  });
+
+  test('the M2 design records accepted late-work and backup clarifications', () => {
+    expect(m2).toContain('AttemptRecord.lateWorkSha');
+    expect(m2).toMatch(/cleanup pushes pending late work first, even with the clone gone/);
+    expect(m2).toMatch(/daily[^\n]*once per UTC day/);
+    expect(m2.split('## 18. ')[1]).toMatch(/submitted.head[^\n]*Known limit/i);
+  });
+
+  test('the M2 design records bridge startup isolation and persistent Codex tool discovery', () => {
+    const bridge = m2.split('## 10. Bridge and hooks')[1]!.split('## 11.')[0]!;
+    for (const flag of ['--no-compile-autoload-bunfig', '--no-compile-autoload-dotenv', '--no-env-file', '--config=/dev/null']) {
+      expect(bridge).toContain(flag);
+    }
+    expect(m2).toMatch(/bridge: \{[^\n]*tools: readonly string\[\]/);
+    expect(m2).toMatch(/developerInstructions[^\n]*launch.bridge.tools/);
+    expect(m2).toMatch(/cwd: codexUserHome/);
+  });
+
+  test('the M2 design distinguishes untrusted project config from skills and MCP startup', () => {
+    const threads = m2.split('### 9.2 Threads and turns')[1]!.split('### 9.3')[0]!;
+    expect(threads).toMatch(/untrusted[^\n]*still loads[^\n]*\.codex\/skills/);
+    expect(threads).toContain('mcpServer/startupStatus/updated');
+    expect(threads).toMatch(/trusted[^\n]*MCP servers[^\n]*outside the sandbox[^\n]*before/i);
+  });
+
+  test('the M2 design records Claude screening and resume clarifications', () => {
+    expect(m2).toContain("preset: 'claude_code'");
+    expect(m2).toContain('CLAUDE_BASH_NOTE');
+    expect(m2).toMatch(/resumed[^\n]*mismatch[^\n]*attempt.exited/);
+    expect(m2).toMatch(/computed Git subcommands/);
+    expect(m2).toContain('~/.agflow/work/*/*');
+    expect(m2).not.toMatch(/`~\/\.agflow\/work` (?:goes only|, with `allowRead`)/);
+  });
+});
````

- [ ] **Step 2: Run the tests and see them fail**

Run: `bun test packages/testkit/test/docs-spec.test.ts`
Expected: FAIL — The first failure is `spec M2 managers, security and milestones > M2 carries the implemented shell mitigation through verification, environment and snapshot rules`: `error: M2 §3`, expected `~/.zshrc`. Current parent replay: 22 pass, 24 fail, 164 assertions. Log: `/tmp/agflow-plan-refresh-checks/m2g-19-parent.log`.

- [ ] **Step 3: Implement**

**File:** `docs/superpowers/specs/2026-10-26-agflow-design.md` (change)

````diff
diff --git a/docs/superpowers/specs/2026-10-26-agflow-design.md b/docs/superpowers/specs/2026-10-26-agflow-design.md
index 47bf001c..dabcea47 100644
--- a/docs/superpowers/specs/2026-10-26-agflow-design.md
+++ b/docs/superpowers/specs/2026-10-26-agflow-design.md
@@ -234,7 +234,7 @@ Runners use their owner's subscription logins in runner-specific vendor homes; c
 
 ### 7.1 Roles
 
-| | Lead manager (exactly one, held by a lease) | Area manager (zero or more, one per area; M4) |
+| | Lead manager (exactly one, holding the lead seat) | Area manager (zero or more, one per area; M4) |
 |---|---|---|
 | Plans | How the goal is read, milestones, which areas exist and their scopes | Tasks inside its area |
 | Staffing | Splits agent slots between areas and rebalances them | Requests agents within its share; asks the lead for more |
@@ -245,6 +245,8 @@ Runners use their owner's subscription logins in runner-specific vendor homes; c
 - Until areas exist, the lead plans tasks directly.
 - Work that crosses areas is a task created by the lead.
 
+The **lead seat** is an explicit hub record (`lead_agent_id`, `lead_kind`, `lead_since`); holding it grants lead authority, never the agent's role column. Both live and runner leads use it. Runner leads idle between wake-ups, rotate with a handoff and fail over on another runner; see [M2 §6.11](2026-10-28-m2-runners-design.md#611-the-lead-on-runners) for seat ownership and lifecycle.
+
 ### 7.2 Wake-ups
 
 Managers run on events, not in a loop. The hub wakes a manager when:
@@ -302,9 +304,9 @@ Enforced by hub code, not by prompts:
 
 ### 7.6 Guards
 
-- At most one lead at a time, held by a lease. If the lead's laptop goes offline, a new lead starts on another runner from the handoff.
-- Default limits: 4 re-plans per hour, 20 tasks per re-plan, 3 attempts per task, 200 open tasks. Hitting any limit pauses new dispatches and notifies people.
-- **Pause everything** and **pause area** controls in the UI.
+At most one lead holds the [lead seat](2026-10-28-m2-runners-design.md#611-the-lead-on-runners). The M1 creation limits remain; M2 adds a churn budget for mutating planning calls. Exhausting one task's attempt limit triggers that task's re-plan, rather than a project-wide pause. The counted calls, limits and dispatch pause are defined in [M2 §6.15](2026-10-28-m2-runners-design.md#615-guards).
+
+People can pause the project; area controls arrive with area managers in M4.
 
 ## 8. Context system
 
@@ -469,16 +471,11 @@ Human authority is never inferred from a CLI login, because agents on the same l
 | Reviewer | `get_review_packet`, `submit_review(verdict, findings[], criteria[])` |
 | Manager | Worker tools plus the tools in §7.3 |
 
-Calls are authorized by role, task and fencing token. For example, a worker can submit only its own current attempt.
+Runner-agent credentials are accepted only on the explicit [agent-token route allowlist in M2 §6.5](2026-10-28-m2-runners-design.md#65-agent-tokens-and-principals); every other route returns 403 `agent_not_allowed`. Holder, fence and lead-seat checks apply in addition to the allowlist. A runner agent cannot use the owner's CLI token to impersonate its identity. The table above spans milestones; it does not grant access to unimplemented tools or routes.
 
 ### 11.2 Hub–runner link
 
-A WebSocket opened by the runner, carrying JSON messages.
-
-- **Runner → hub:** `hello` (identity, vendors, versions, capacity, profile), `heartbeat`, `events` (batched, with sequence numbers, replayed after reconnecting), `command_result`.
-- **Hub → runner:** `start_agent`, `send_message`, `interrupt`, `stop`, `prepare_takeover`, `run_checks`, `run_review_packet`, `merge`, `update_profile`.
-
-Commands carry IDs and are idempotent. Delivery is at-least-once.
+The runner opens the authenticated protocol-1 WebSocket at `/api/runner/ws`. Durable sequenced events, cumulative acknowledgements, journalled commands, reconnect replay and settings sync follow [M2 §6.3](2026-10-28-m2-runners-design.md#63-runner-link), the source of truth for message shapes and reconciliation. Settings sync retains the M2 runner-side rule and its documented Known limits after a restore; the exact-echo protocol change is deferred.
 
 ### 11.3 Event types
 
@@ -486,44 +483,25 @@ Commands carry IDs and are idempotent. Delivery is at-least-once.
 
 ## 12. Security
 
-- **Login.** People sign in to the hub with GitHub or GitLab OAuth. Access is an allowlist of usernames configured on the hub.
-- **Human authority** comes only from browser sessions. CLI tokens can act only as agents, call hook endpoints, or read (§11.1).
-- **Runner identity.** A runner acts as its owner, using the login from `agflow login` (stored in the OS keychain).
-- **Agent identity.** Each agent gets a short-lived credential scoped to its agent ID, attempt, role and fencing token.
-- **What the hub stores.** Only the OAuth application settings and its own data. No AI credentials and no git credentials.
-- **Injection hygiene.**
-  - Task text, messages and repository content are presented to agents as quoted data.
-  - Messages from agents never authorize anything.
-  - Agents cannot approve permission requests.
-  - agflow never answers a live chat's approval prompts.
-- **Agent environment.** The runner starts agents with a minimal environment: no unrelated secrets, no `ANTHROPIC_API_KEY`, no `OPENAI_API_KEY`.
-- **Protected paths.** See §9.7.
+People sign in through GitHub or GitLab OAuth; the hub checks an allowlist of usernames. Browser sessions authorize people's controls. The hub stores its own state and OAuth application settings, never AI or git credentials.
+
+Runner agents are contained by network, write, authority and git boundaries. Only the runner pushes, from its agent-inaccessible vault. Every approval goes to the owner; agflow never grants one itself or bypasses device policy. Agent-authored text stays quoted. The boundaries, owner-approved escalation and residual risks (including same-user reads and shell profiles) are defined in [M2 §5](2026-10-28-m2-runners-design.md#5-security-model-for-runner-agents).
+
+The runner authenticates using `agflow login`'s CLI credential; keychain storage for that token is deferred to M3. Each runner agent uses an attempt- and fence-scoped token. Its route allowlist, revocation, epoch checks and lead-seat authority are defined in [M2 §6.5](2026-10-28-m2-runners-design.md#65-agent-tokens-and-principals). Live chats keep their M1 identity path and approvals remain with the person.
 
 ## 13. Failure handling
 
-| Failure | Behaviour |
-|---|---|
-| Hub down | Agents keep working. Runners buffer events and reconnect with backoff. MCP calls answer "hub unavailable, keep working". Nothing new is dispatched until the hub returns, then a reconcile pass runs. |
-| Laptop asleep or offline | Leases expire. Tasks go back to `ready` with a handoff note. Work in progress is already pushed. |
-| Agent process crashes | The runner reports the exit; the attempt ends; the retry ladder continues. |
-| Usage limit reached | That vendor on that runner is marked exhausted until reset; work moves to other runners or the other vendor. |
-| Superseded agent returns | Its fencing token is outdated, so its submissions and pushes are rejected. |
-| State drift | The reconcile pass compares hub state with runner reports and git, then fixes orphaned claims, zombie sessions and merged-but-unmarked tasks. |
-| Lead lost | The lead lease expires and a new lead starts from the handoff on another runner. |
-| Hub database loss | Restore from the daily backup. The repository still holds goal, decisions and research. |
+The hub remains the authority for attempts and work positions. Runner outages and crashes follow the [attempt trigger table](2026-10-28-m2-runners-design.md#64-attempts-fencing-and-leases) and [replacement and handoff rules](2026-10-28-m2-runners-design.md#68-stall-detection-continuation-replacement-and-handoff); quota waits follow [M2 §6.10](2026-10-28-m2-runners-design.md#610-quota-and-approvals). Lead loss follows the [lead-seat failover rules](2026-10-28-m2-runners-design.md#611-the-lead-on-runners).
+
+After hub downtime or a forward clock jump, a recovery window lets runners reconnect and replay before lease expiry, stall decisions or dispatch resume. Backward clock steps never shorten leases. Backup restores advance the epoch, replay retained work, then re-fence surviving attempts; unknown attempts stop. Hourly, daily and start backups and the offline restore procedure are defined in [M2 §6.14](2026-10-28-m2-runners-design.md#614-restarts-clock-jumps-restores-and-backups).
+
+During an outage runners buffer events, and failed bridge calls receive a retry nudge after reconnection. Reconciliation uses the [runner link protocol](2026-10-28-m2-runners-design.md#63-runner-link). WIP pushes have a bounded grace period; fenced or otherwise ineligible work is preserved as late work on separate refs, with durable retries, rather than overwriting a successor. See [M2 §7.3](2026-10-28-m2-runners-design.md#73-git) and [§7.4](2026-10-28-m2-runners-design.md#74-processes).
 
 ## 14. Testing
 
-- **Unit tests** for the deterministic core: task state machine, scheduler, admission by owned paths, leases and fencing, retry ladder, caps and guards.
-- **Fake CLIs** that replay recorded Claude stream-json and Codex app-server sessions, so runners are tested without using anyone's subscription.
-- **Smoke suite against the real CLIs** for every pinned-version change: start, message, interrupt, resume, submit. Both CLIs change weekly, and the Codex app-server is experimental.
-- **End-to-end runs on a toy repository** ("small CLI with tests plus one research note") with 2–3 real agents and injected faults:
-  - kill an agent mid-task;
-  - disconnect a runner;
-  - plant an agent that weakens tests.
+M2 combines deterministic core and hub tests, runner tests with a fake adapter and local bare origins, security contract tests, and real pinned CLIs driven by scripted model servers with scratch homes and zero subscription use. The local suites cover sandbox boundaries and multi-runner recovery (killed agent, closed laptop, lost lead, restarts, restore, delivery and take-over with hand-back). Gates, fixtures and the separately invoked manual live run are defined in [M2 §15](2026-10-28-m2-runners-design.md#15-testing).
 
-  Expected: tasks recover from handoff notes, the tampering is caught, and main stays green.
-- **Dogfooding.** From M2 on, agflow develops agflow.
+Validation and tamper-detection scenarios belong to M3, alongside checks, reviewers and the merge queue. From M2 on, agflow can dogfood on its own repository.
 
 ## 15. Stack and layout
 
@@ -536,18 +514,20 @@ Commands carry IDs and are idempotent. Delivery is at-least-once.
 ```
 packages/core      domain model, state machine, scheduler, policies (pure; unit-tested)
 packages/hub       HTTP API, SSE, runner gateway, auth, storage
-packages/runner    runner daemon, worktrees, git operations, checks, adapters/claude, adapters/codex
+packages/runner    daemon and service, per-attempt clones and vault, dependency preparation, vendor adapters
 packages/cli       agflow login | runner | join | mcp | brief | hook entry points
 packages/web       React UI
-packages/testkit   fake CLIs, recorded sessions, end-to-end harness
+packages/testkit   git fixtures, refusing proxy, scripted model servers, recorded-stream fake CLI, end-to-end harness
 ```
 
+Package dependencies and the shared runner/adapter interfaces are defined in [M2 §13](2026-10-28-m2-runners-design.md#13-packages-and-interfaces). Checks and verification clones arrive in M3.
+
 ## 16. Milestones
 
 | Milestone | Scope | Exit criteria |
 |---|---|---|
 | **M1: Project brain** | Hub (login, state, events, API, SSE); the task contract with structural checks (unknown or batch-local dependencies, cycles, owned-path overlap at claim time); guards (open-task and hourly creation limits); pause and resume; standing rules; daily backups with an integrity check; MCP bridge with worker and lead tools; web UI (goal editor, board with people's task actions, agents, timeline, steering chat, knowledge); `agflow join` for both CLIs, with a task branch per claim; the lead runs as a live chat started by a person, so it wakes when its turn ends or its person prompts it (immediate wake-ups arrive with runners in M2); tasks are accepted by the lead and marked merged by people. | On a toy repo, a person starts a Claude lead and two workers (one Claude, one Codex) with `agflow join`. The lead plans from the goal, workers claim and submit, a goal edit produces a visible re-plan, and a steering message reaches a worker through its `Stop` hook. |
-| **M2: Runners** | Runner daemon; Claude and Codex adapters; worktrees and WIP pushes; leases, stall detection, replacement and handoff; `request_agents` and auto-fill; quota-aware routing; permission profiles; keep-awake; take-over; lead failover. | Killing an agent and closing a laptop mid-task both end with the task finished on another runner from the handoff note; the lead survives losing its laptop. |
+| **M2: Runners** | Runner execution, isolation, recovery and operations as defined in [M2 design §2](2026-10-28-m2-runners-design.md#2-scope), including sandboxed dependency preparation, lead failover and the runner/attempt/approval UI. The lead accepts or rejects submissions; people mark tasks merged. | Killing an agent and closing a laptop mid-task both end with the task finished on another runner from the handoff note; the lead survives losing its laptop. |
 | **M3: Validation and merge** | Task contracts and plan checks; checks in verification worktrees; tamper and scope checks; cross-vendor review; research review; evidence log; retry ladder; PR per task; merge queue; protected paths. | A planted test-weakening agent is caught. A 10-task toy project goes from goal to merged main with no human action, and main stays green throughout. |
 | **M4: Scale and knowledge** | Area managers; learnings curation and curator tasks; context linter; hidden checks; plan critic; usage dashboards. | A two-area project runs with a lead and two area managers. A proposed learning reaches `AGENTS.md` through a curation task. |
 
@@ -567,32 +547,32 @@ Open questions to settle during implementation:
 
 1. Will Anthropic document the session inbox socket's message format (anthropics/claude-code issue #103048)?
 2. Can an external client steer threads in the shared Codex daemon in practice (not verified live)?
-3. What is the exact config override that marks a Codex worktree as trusted?
+3. What is the exact config override that marks a Codex clone as trusted? **Answered in M2:** `projects.<path>.trust_level` is a nested object in the thread config, never a dotted key: `config: { projects: { [realpath(clone)]: { trust_level: projectConfigVerified ? 'trusted' : 'untrusted' } } }`. The runner verifies `.codex/` against the restore base before start and resume; see [M2 §9.2](2026-10-28-m2-runners-design.md#92-threads-and-turns).
 4. How much quota does a typical task consume per vendor and plan? Measure during M2 and adjust the default caps.
 
 ## 18. Review findings to resolve before the M2 and M3 plans
 
-A four-reviewer adversarial review of this spec (2026-10-26) found the issues below. M1 already absorbs the ones that affect it. The ones listed here must be designed into the M2 and M3 plans; until then the matching sections above are incomplete.
-
-| # | Area | Problem | Required direction |
-|---|---|---|---|
-| 1 | Git credentials | Agents run as the laptop owner and can reach the owner's git login, so they could push to `main` and bypass the merge queue, fencing and the tamper scan. | Start agents with a credential-free git setup (own `GIT_CONFIG_GLOBAL` without credential helpers, empty `GH_CONFIG_DIR`, `GIT_TERMINAL_PROMPT=0`). Keep the git host off the agents' network allowlist. Deny `git push`, `gh` and `glab` in both CLIs. Only the runner pushes. |
-| 2 | Sandboxing | Allow rules decide which commands start, not what they do. Checks run agent-written code outside any sandbox. | One OS-level sandbox profile for every agent tool call and every runner-run check. Claude: the Bash sandbox via `--settings` with the unsandboxed fallback off. Codex: `network_access = false`, with the runner installing dependencies first. Checks: a macOS sandbox profile with no keychain or credential access. |
-| 3 | Repo-controlled config | Both CLIs load hooks, MCP servers and settings from the task branch at every start, so a tampered branch runs code on the next laptop before any scan. | Before every agent start, the runner restores people-only paths from the base. It strips them from work-in-progress commits and runs git with its own git directory and hooks disabled. |
-| 4 | Fencing on pushes | The git host knows nothing about fencing tokens, so a cut-off runner can keep pushing to a branch its successor uses. | Push work in progress to per-attempt refs (`agflow/T-42/a3`). The PR branch moves only after a fenced `submit`, via `--force-with-lease` against the commit the hub recorded. |
-| 5 | Leases after submit | An author waiting for checks and review looks stalled. | Only `claimed` and `working` hold leases. At `submit`, the hub keeps a hold instead. The process stops but its session id is kept, and it is resumed for step-1 fixes. Add `rebut_review`. |
-| 6 | Hub restarts | After an outage longer than the lease, every lease looks expired. | On start, a recovery window extends leases by the downtime and waits for runners to reconnect and replay before reconciling. A claim, its attempt and the start command are written in one transaction. |
-| 7 | Quota and long builds | Usage limits and long builds look like stalls and burn attempts. | A `quota_wait` attempt state freezes the lease, the stall timer and the budget. Stall windows are set per command. |
-| 8 | Merge queue | Merge jobs have no lease or fencing, and the git host cannot enforce the hub's verdict. | A short-lived merge permit bound to (task, head SHA, main SHA). Merges are conditional on the expected head SHA. A hub-signed acceptance attestation is checked by a required CI status. |
-| 9 | Validation inputs | Diffs use the frozen `base_commit` although branches are rebased. | Compute every diff as `merge-base(origin/main, HEAD)..HEAD`, and restore protected paths from the rebase target. |
-| 10 | Review blind spots | Some defects (data exfiltration, new dependencies, leaked secrets) cannot be shown by a failing test, so they would merge automatically. | Security-class findings block without a reproduction and go to a person. Add deterministic tamper rules for new outbound hosts and new dependencies. |
-| 11 | Per-role lifecycles | Continuation and stall rules assume workers, so managers would loop. | Managers are idle between wake-ups and hold a role lease. Reviewers end with `submit_review`. |
-| 12 | Guards | "Re-plan" is undefined, create-and-cancel loops evade the limits, and one hard task should not pause everything. | Count every mutating planning call and add a churn budget. Reaching the attempt limit triggers only a re-plan (§9.5 step 4). |
-| 13 | Vendor rules | §6.8 and §9.3 disagree about same-vendor review. | A reviewer uses the other vendor when it is available, otherwise the §9.3 fallback after a stated wait. |
-| 14 | Claude adapter | The SDK bundles a different Claude version than the installed CLI, auto mode may be unavailable, and API-key variables silently override the subscription. | Pin the binary and check its version at start. Fall back to `acceptEdits` plus the sandbox when auto mode is off. Build the agent environment from an allowlist and verify subscription auth before dispatch. |
-| 15 | Codex adapter | Codex forwards only allowlisted environment variables to stdio MCP servers, and `turn/steer` carries user authority. | Declare `mcp_servers.agflow.env_vars`. Send agent messages as tool-output items, and keep `turn/steer` for human steering. |
-| 16 | Restore | Restoring a daily backup rolls back counters and fencing tokens. | Continuous WAL replication or hourly snapshots, plus a hub epoch embedded in tokens and bumped on restore. |
-| 17 | Repo-derived context | The hub cannot read the repository, so it cannot build repo maps, pitfalls or the research index. | Runners and bridges build that context from the worktree and upload a derived index keyed by commit. |
+A four-reviewer adversarial review of this spec (2026-10-26) found the issues below. M1 absorbed the ones that affect it. The status column follows [M2 §17](2026-10-28-m2-runners-design.md#17-spec-changes). Resolved rows link to the current contract; open rows retain their required direction for M3 or M4. Resolution here covers M2 scope: reviewers and validation remain M3, and area managers remain M4.
+
+| # | Area | Problem | Required direction | Status |
+|---|---|---|---|---|
+| 1 | Git credentials | Agents run as the laptop owner and can reach the owner's git login, so they could push to `main` and bypass the merge queue, fencing and the tamper scan. | Network and credential isolation; only the runner pushes from its vault. [M2 contract](2026-10-28-m2-runners-design.md#5-security-model-for-runner-agents). | Resolved in M2 |
+| 2 | Sandboxing | Allow rules decide which commands start, not what they do. Checks run agent-written code outside any sandbox. | Sandboxed agent tools and dependency preparation are in M2; verification checks arrive in M3. [M2 contract](2026-10-28-m2-runners-design.md#77-dependency-preparation). | Resolved in M2 with sandboxed dependency preparation; checks in M3 |
+| 3 | Repo-controlled config | Both CLIs load hooks, MCP servers and settings from the task branch at every start, so a tampered branch runs code on the next laptop before any scan. | Restore and strip protected paths, and isolate runner git from agent-writable config. [M2 contract](2026-10-28-m2-runners-design.md#73-git). | Resolved in M2 |
+| 4 | Fencing on pushes | The git host knows nothing about fencing tokens, so a cut-off runner can keep pushing to a branch its successor uses. | Per-attempt WIP refs; fenced submission moves the task branch conditionally. [M2 contract](2026-10-28-m2-runners-design.md#613-submissions-from-runner-agents). | Resolved in M2 |
+| 5 | Leases after submit | An author waiting for checks and review looks stalled. | Submitted workers enter a hold, retaining the session for fixes; `rebut_review` waits for M3 reviewers. [M2 contract](2026-10-28-m2-runners-design.md#64-attempts-fencing-and-leases). | Resolved in M2 except `rebut_review` (M3) |
+| 6 | Hub restarts | After an outage longer than the lease, every lease looks expired. | Recovery windows extend leases and allow replay before reconciliation. [M2 contract](2026-10-28-m2-runners-design.md#614-restarts-clock-jumps-restores-and-backups). | Resolved in M2 |
+| 7 | Quota and long builds | Usage limits and long builds look like stalls and burn attempts. | Quota waits suspend stall and budget decisions; long tools have command-specific caps, while the runner lease still detects a lost laptop. [M2 contract](2026-10-28-m2-runners-design.md#68-stall-detection-continuation-replacement-and-handoff). | Resolved in M2 |
+| 8 | Merge queue | Merge jobs have no lease or fencing, and the git host cannot enforce the hub's verdict. | A short-lived merge permit bound to (task, head SHA, main SHA). Merges are conditional on the expected head SHA. A hub-signed acceptance attestation is checked by a required CI status. | Open for M3 |
+| 9 | Validation inputs | Diffs use the frozen `base_commit` although branches are rebased. | Compute every diff as `merge-base(origin/main, HEAD)..HEAD`, and restore protected paths from the rebase target. | Open for M3 |
+| 10 | Review blind spots | Some defects (data exfiltration, new dependencies, leaked secrets) cannot be shown by a failing test, so they would merge automatically. | Security-class findings block without a reproduction and go to a person. Add deterministic tamper rules for new outbound hosts and new dependencies. | Open for M3 |
+| 11 | Per-role lifecycles | Continuation and stall rules assume workers, so managers would loop. | Runner leads idle between wake-ups and hold the lead seat. Reviewers and area managers remain deferred. [M2 contract](2026-10-28-m2-runners-design.md#611-the-lead-on-runners). | Resolved in M2 |
+| 12 | Guards | "Re-plan" is undefined, create-and-cancel loops evade the limits, and one hard task should not pause everything. | Count mutating planning calls with a churn budget; one task reaching its attempt limit triggers its own re-plan. [M2 contract](2026-10-28-m2-runners-design.md#615-guards). | Resolved in M2 |
+| 13 | Vendor rules | §6.8 and §9.3 disagree about same-vendor review. | A reviewer uses the other vendor when it is available, otherwise the §9.3 fallback after a stated wait. | Open for M3 |
+| 14 | Claude adapter | The SDK bundles a different Claude version than the installed CLI, auto mode may be unavailable, and API-key variables silently override the subscription. | Pin and verify the binary, use a minimal environment and subscription preflight; standard is acceptEdits plus sandbox, auto is opt-in. [M2 contract](2026-10-28-m2-runners-design.md#8-claude-code-adapter). | Resolved in M2 |
+| 15 | Codex adapter | Codex forwards only allowlisted environment variables to stdio MCP servers, and `turn/steer` carries user authority. | Explicit bridge environment forwarding and tool-authority agent messages. [M2 contract](2026-10-28-m2-runners-design.md#9-codex-adapter). | Resolved in M2 |
+| 16 | Restore | Restoring a daily backup rolls back counters and fencing tokens. | Hourly snapshots, a restore epoch and replay before re-fencing. [M2 contract](2026-10-28-m2-runners-design.md#614-restarts-clock-jumps-restores-and-backups). | Resolved in M2 |
+| 17 | Repo-derived context | The hub cannot read the repository, so it cannot build repo maps, pitfalls or the research index. | Runners and bridges build that context from the worktree and upload a derived index keyed by commit. | Open for M4 |
 
 ## 19. References
 
````

**File:** `docs/superpowers/specs/2026-10-28-m2-runners-design.md` (change)

````diff
diff --git a/docs/superpowers/specs/2026-10-28-m2-runners-design.md b/docs/superpowers/specs/2026-10-28-m2-runners-design.md
index 589c4220..f68e2e59 100644
--- a/docs/superpowers/specs/2026-10-28-m2-runners-design.md
+++ b/docs/superpowers/specs/2026-10-28-m2-runners-design.md
@@ -1,7 +1,7 @@
 # agflow M2 design — runners
 
 - **Date:** 2026-10-28, revision 4 (after the design review, a re-check of revision 2, and the cross-plan questions of the seven plan outlines)
-- **Status:** design for the M2 implementation plans
+- **Status:** implemented by plans M2a (hub), M2b (runner core and bridge), M2c (runner service and operations), M2d (Claude adapter), M2e (Codex adapter), M2f (web UI) and M2g (end-to-end and documentation); manual live-run results are recorded separately in [the runbook](../../m2-live-run.md).
 - **Extends:** [the agflow design spec](2026-10-26-agflow-design.md), sections 6, 9.5, 9.7 and 11–14, and the open items of section 18
 - **Evidence:**
   - A live verification of both CLIs, git isolation and process supervision on 2026-10-28 (Claude Code 2.1.285 with Agent SDK 0.3.285, Codex 0.159.2 under this Mac's MDM policy, git 2.50, Bun 1.3.11, macOS 26.6).
@@ -62,7 +62,7 @@ As in M1, the lead accepts or rejects submissions and people mark tasks merged.
 | A per-agent `CLAUDE_CONFIG_DIR` loses the login (earlier research) | The 2.1.285 binary names the keychain item `Claude Code-credentials-<first 8 hex of sha256(configDir)>` whenever `CLAUDE_CONFIG_DIR` is set. `.claude.json`, transcripts and memory stay inside the directory. | Each runner has its own Claude config directory and its own Codex home, each logged in once by the owner. Agents never load the owner's hooks, skills, MCP servers or global instructions, and the runner's login cannot disturb the owner's. |
 | Codex's managed policy shows as a mismatch on `thread/start` (revision 1) | On this Mac, `thread/start` returns the policy that was requested. `configRequirements/read` and `config/read {includeLayers: true}` show the requirements and the MDM layer. | Detection uses those two calls and fails closed. The runner never answers approvals itself anyway (section 6.10). |
 | Codex agents are isolated by their own `CODEX_HOME` | The built-in `codex_apps` MCP server exposes the account's ChatGPT apps. Their read-only tools (web search) run without approval. Personal skills load from `$HOME/.agents/skills`. | `--disable apps --disable plugins`. App-server runs with a runner-owned empty `HOME`. Every start checks that the agflow bridge is the only MCP server and that no user skills load. |
-| `ZDOTDIR` keeps the owner's shell profile away from Claude agents | Before its first Bash call, Claude Code runs `$SHELL -c -l` outside the sandbox and sources `$HOME/.zshrc` (or `.bashrc`) to build a shell snapshot. `ZDOTDIR` does not change that. | Accepted as a residual risk (section 5). The snapshot file lives in the runner's Claude home, which sandboxed commands cannot read. |
+| `ZDOTDIR` keeps the owner's shell profile away from Claude agents | The implemented mitigation sets `ZDOTDIR=<claudeHome>/agflow-empty`, drops incoming `CLAUDE_CODE_SHELL`, and sets `CLAUDE_CODE_SHELL=/bin/zsh` unless `SHELL` already names zsh. Only the snapshot sources `~/.zshrc` outside the sandbox, once per Claude process; `~/.zshenv`, `~/.zprofile`, `~/.zlogin` and `~/.bashrc` do not run around agent commands. | The snapshot remains an accepted residual risk (section 5). Its file lives in the runner's Claude home, which sandboxed commands cannot read. |
 | A per-attempt `TMPDIR` | Claude's sandbox always lets commands write `/tmp/claude`, and gives them `TMPDIR=/tmp/claude-<uid>`, which every Claude session of the user shares. With `CLAUDE_CODE_TMPDIR=<dir>` they get `<dir>/claude-<uid>`, but only while that path is at most 44 bytes; beyond that the CLI silently falls back to the shared directory. | Each Claude attempt gets a short private directory `/tmp/agf/<id>` as `CLAUDE_CODE_TMPDIR`, and `/tmp/claude` goes into `denyWrite`. |
 | Leases renewed by runner-observed activity (§6.7) | Claude is silent for a whole foreground tool call. A polling, hung tool looks busy to CPU and process signals. | **Runner lease** = the laptop is there. **Stall** = a hub decision from fresh facts, with a hard cap on tool time (section 6.8). |
 | Kill the agent's process group | Both CLIs put tool processes in their own sessions and groups. Claude ignores stdin EOF in the middle of a turn. SIGINT ends Codex but leaves its command running. | A stop ladder: interrupt, then close, then SIGTERM, then SIGKILL of every recorded group, with identity checks against PID reuse (section 7.4). |
@@ -644,16 +644,32 @@ export type HubMessage =
 
   `draining` is a separate flag. `RunnerVendor.degraded` and the hub's not-ready marks come from `runners.vendor_holds` and are never taken from runner messages. A vendor report whose `preflightAt` is later than the mark's `notReadySince` clears it.
 
-**Settings sync.** `runner.json` holds the settings and a snapshot of the last ones the hub confirmed, with their version.
-- `hello.settings` carries that snapshot and never a local edit.
+**Settings sync.** `runner.json` holds the settings, plus a snapshot of the last settings the hub confirmed, with their version.
+- `hello.settings` carries that snapshot, never a local edit.
 - On `hello`, the hub compares versions:
-  - a new runner: the hub stores the reported values at version 1 and echoes them with `update_settings`;
+  - a runner it does not know (a new runner, or a hub restored from a backup older than the runner): the hub stores the reported values at version 1 and echoes them with `update_settings`;
   - an equal version: nothing;
-  - an older version (the owner changed settings in the browser meanwhile): the hub sends its settings with `update_settings`;
-  - a newer version (a restored hub): the hub adopts the reported values and version.
-- Local edits (`drain`, `undrain`, a hand edit, the crash-loop self-drain) travel only as `runner.settings`, after `welcome`. After each `welcome` the runner sends every field where `runner.json` differs from the snapshot.
-- An `update_settings` echo replaces the snapshot. It also updates `runner.json`, except pending local edits (fields that differed from the old snapshot and differ from the echo): they keep their value and are sent again.
+  - an older version (the owner changed settings in the browser meanwhile): the hub sends all of its settings with `update_settings`;
+  - a newer version (a restored hub): the hub adopts the reported values and version, and cancels its pending `update_settings`.
+- Local edits (`drain`, `undrain`, a hand edit, the crash-loop self-drain) travel only as `runner.settings`, after `welcome`. The hub applies them in seq order, whatever their base, each at a new version. It echoes each one verbatim with `update_settings`, as it echoes the owner's edits. A local edit that cannot be written to `runner.json`, or whose `runner.settings` cannot be stored, changes nothing, and the error is thrown.
+- An edit is in flight until an echo answers it and the snapshot reaches that echo's version. `runner.json` holds the view: the snapshot with the edits in flight laid over it. A local edit counts as a change when it differs from `runner.json`, so an edit back to an earlier value is sent. After each `welcome`, the runner sends every field where `runner.json` differs from the view: a hand edit made while it was down.
+- An echo answers the oldest unanswered edit with the same settings among the edits the outbox held when the echo arrived. The runner keeps that answer in `runner.db` with the echo's version, and writes it before `runner.json`.
+- The snapshot moves one version at a time. An echo at the snapshot's version + 1 becomes the snapshot. `runner.json` takes the new view, except a field that differed from the view before the echo (an edit made by other means): that field keeps its value and is sent again. An echo at or below the snapshot's version only marks the edit it answers. The hub's whole settings (every field, with each per-vendor record naming every vendor the snapshot's record holds) become the snapshot at any version not below the snapshot's.
+- Each `hello` starts a new lineage of commands. An `update_settings` the runner took before its latest `hello` gets no result and does not run. The hub keeps a command with no result pending and sends it again after the next `welcome`, if it still has it.
+- These `update_settings` wait: one that would skip a version, one that fails (a `runner.db` error), and one whose journal row cannot be written. A failure is retried after 1 s, then after a wait that doubles up to 60 s. The waiting echoes run in version order, once the ones before them have run or the hub's whole settings cover them. Each gets its result on the same link. The next `hello` leaves the ones still waiting without a result. Any other command whose journal row cannot be written is answered with the failure.
+- When `runner.json` cannot be written, the runner logs it and keeps the new settings in memory; the next successful write catches the file up. If the runner restarts before then, it reads the older version, and its `hello` brings the hub's whole settings.
+- Refusals: the hub acknowledges an edit it refuses and never echoes it. After an acknowledgement, once the commands received before it have run, an acknowledged edit with no echo gets a probe. A probe is a `runner.settings` with no fields: the hub applies it at a new version and echoes it as `update_settings {}`, which nothing else sends. At the probe's echo, every older unanswered edit was refused. The runner logs a warning, `runner.json` takes the hub's value, and the edit is never sent again.
+- A restored hub: a `welcome` whose hub epoch differs from the last one's. The runner records the events it holds, then the new epoch (a death between the two records the events again). Then it says `hello` again at once, before it runs a command or sends an event. The hub reconciled the first `hello` against what its backup knew of the runner, perhaps nothing. The second `hello` finds the runner's snapshot there, at its version or adopted, and what the first one made the hub send is cancelled or gets no result. A write that fails while the runner handles a `welcome` or an `ack` is logged and handling continues. Failed restore bookkeeping is the exception: recording the held events and then the epoch share one guarded block; if either fails, the runner drops the link with normal backoff and returns before commands or replay. The epoch remains unrecorded and the next `welcome` retries the bookkeeping. Successful restore bookkeeping still reconnects immediately.
+- Replays: the replays to a restored hub leave out the edits held at its first `welcome` whose answer the snapshot holds, because the restored hub would apply them twice. Every other replay sends every event above `welcome.ackedSeq`, since the hub acknowledges an event in the transaction that applies it. The hub permits omissions within replay up to `hello.lastSeq`, and its cumulative acknowledgement covers them; gaps after `hello.lastSeq` close the link. Restored-hub omissions are bounded by `restoredThrough` and covered by the replacement `hello`. When the newest event held is one the replay leaves out, a probe follows it, so the acknowledgement reaches `hello.lastSeq`.
+- An events message the hub cannot apply as a whole receives no acknowledgement and closes the link with 1011. The runner reconnects through normal backoff and replays from the acknowledged position.
+- Retention never prunes an edit still in flight for the snapshot `runner.json` was last written with, and keeps no probe.
 - So a drain made while offline and a capacity change made in the browser meanwhile both survive.
+- Known limits. An echo does not name the edit it answers, and a version does not name the hub that gave it. The exact fix is a protocol change for a later milestone. `update_settings` would name the `runner.settings` it answers, refusals would be answered explicitly, and `hello` would name the edits its snapshot holds. Until then:
+  - After a restore, an edit that an equal echo answered before the edit reached the hub can be lost.
+  - After a restore, when the owner's edits took the hub past the runner's version before the runner's `hello`, the hub does not adopt the runner's snapshot. The edits the old hub echoed after the backup are then not delivered.
+  - When the owner's edits bring a restored hub exactly to the runner's version before its `hello`, the hub finds the versions equal. The two sides then keep different settings at the same versions.
+  - A restored hub ahead of the runner with another history (a backup older than an earlier restore) has its pending echoes applied on the runner's snapshot until its whole settings come.
+  - A probe's echo settles the oldest open probe. After a probe the hub refused, later refusals are settled one probe late, and new probes wait for the next `welcome`. When retention drops an acknowledged probe before its echo runs, that echo settles a newer probe and marks the edits before it as refused. `runner.json` reverts them until their own echoes come.
 
 **Link behaviour:**
 - The runner sends a heartbeat every 15 s. The hub answers each one with `heartbeat_ack`.
@@ -902,7 +918,7 @@ The runner applies `welcome.stop` before any command, and answers later commands
 - **(e) Holder fields.** A move at request time keeps `tasks.assignee`, `tasks.current_attempt` and the agent's `current_task`. The transaction that ends the attempt clears `current_task`. It also clears `assignee`, unless the task is `submitted` or `accepted`.
 
 **Cleanup.** The transaction that ends any attempt queues `cleanup_attempt` for it, except for `taken_over` attempts, whose cleanup follows hand-back.
-- The runner runs it once the attempt's final WIP is confirmed; for `lost` attempts, that is after the late-work push that `welcome.stop` triggers.
+- The runner runs it once the attempt's final WIP is confirmed; for `lost` attempts, that is after the late-work push that `welcome.stop` triggers. Before deleting anything, it pushes pending late work (the exit's harvest), then any newer clone work, each to a new late-work ref. A failed push keeps the clone and records the work for the durable retries in section 7.4; the hub does not resend a failed cleanup.
 - If the agent's process is still alive (an accept or reject during `hold_attempt`), `cleanup_attempt` first runs the stop ladder.
 - It uploads the transcript tail, then removes the clone, the pins, the private temporary directory and the transcript.
 
@@ -1353,7 +1369,7 @@ Runner agents cannot push, so `submit` has two phases.
   - The hub detects a restore from `hello.lastHubEpoch` being lower than its epoch. It first applies the events the runner replays (so WIP pushed after the backup still updates work positions). Then every attempt that the runner reports, and that the restored hub knows and has not ended, gets a new fence through `resume_attempt` (class `infra`; section 6.3). If its task no longer names it, it ends `superseded`.
   - Attempts the hub does not know go to `welcome.stop`. Their late work becomes a note on the task if the task exists, and goes to people otherwise.
   - Recorded branch heads are treated as unknown; the first `push_submission` of each task adopts the remote head under section 6.13's rule.
-- **Backups.** An `hourly` kind (kept 24 hours) joins `daily` (7) and `start` (3). The first hourly snapshot comes an hour after start, so a start still writes only `start` (and a missing `daily`). `VACUUM INTO` runs outside the tick, and its duration is logged.
+- **Backups.** An `hourly` kind (kept 24 hours) joins `daily` (7) and `start` (3). The first hourly snapshot comes an hour after start, so a start still writes only `start` (and a missing `daily`). The daily backup is written once per UTC day by hourly housekeeping. `VACUUM INTO` runs outside the tick, and its duration is logged.
 
 ### 6.15 Guards
 
@@ -1627,6 +1643,7 @@ Lead attempts have no WIP refs.
 - **Unrequested exits.** When an agent exits without a request (a worker or a lead), the runner first runs ladder steps 3 and 4: SIGKILL every recorded group that passes the identity check, then the clone sweep. Only then does the final work start, so an orphaned tool cannot write during or after the harvest.
 - **Final work before `attempt.exited`.** For every exit, requested or not, the runner first finishes the final harvest, strip and push, with retries for up to `finalPush` (60 s). Only then does it emit `attempt.exited`, with `finalSha` and `finalWip`, or `pushError`. After `prepare_takeover`, `attempt.taken_over` takes its place (section 6.12). After reporting a `pushError`, the runner keeps retrying that push with backoff to a late-work ref, and reports `attempt.late_work` when it lands.
 - **CLI version.** The runner records the CLI version each attempt started with. Every resume of the attempt runs that version's binary (`AgentLaunch.cliVersion`), and so do its take-over commands; new attempts use the current pin.
+- **Durable late work.** When a final push fails or `canPushWip` refuses it, the runner records `AttemptRecord.lateWorkSha` before reporting `attempt.exited`, even when a known-ended attempt reports `pushError: null`. It retries to a late-work ref with backoff until the push lands and `attempt.late_work` is reported. After a restart, retries resume at the first `welcome`. A cleanup pushes pending late work first, even with the clone gone. If either that push or the push of newer clone work fails, the clone is kept, the work stays pending and retries continue. A hand-back's push settles pending late work because the person's work includes the agent's.
 - **Resume failures.**
   - A session or thread that never ran a turn cannot be resumed ("No conversation found", "no rollout found"). The adapter then starts a fresh session in the same clone with the attempt's brief and first prompt, and reports the new `sessionRef`.
   - Any other resume failure is harvested and pushed, then reported as `attempt.failed_to_start` (infra).
@@ -1670,7 +1687,7 @@ export interface PermissionProfile {
 - **Claude's sandbox `filesystem.denyRead`** (Bash commands):
   - `~/.ssh`, `~/.netrc`, `~/.git-credentials`, `~/.config/gh`, `~/.config/glab-cli`, `~/.config/agflow`;
   - `~/.agflow/runner`, all of it, with `allowRead` for `<CLAUDE_CONFIG_DIR>/projects/<slug of the clone>/`, because Claude Code saves oversized tool output there and tells the model to read it;
-  - `~/.agflow/work`, with `allowRead` for the attempt's own clone;
+  - `~/.agflow/work/*/*`, with `allowRead` for the attempt's own clone; the work root and project parents stay readable for package-script resolution;
   - `~/.claude`, `~/.claude.json`, `~/.codex`;
   - `~/Library/Keychains`;
   - `~/.aws`, `~/.config/gcloud`, `~/.kube`, `~/.docker/config.json`.
@@ -1687,15 +1704,18 @@ export interface PermissionProfile {
 - **Sandbox `denyWrite`:** `/tmp/claude`, `/private/tmp/claude` and `~/.npm/_logs`. The sandbox runtime otherwise always lets commands write them.
 
 **Other attempts' clones and transcripts.** No permission rule ever names `~/.agflow/work`. Deny rules cannot be re-allowed, and `Edit` deny rules also become sandbox `denyWrite` paths, so such a rule would deny every Read, Edit and Write, and every sandboxed write, in the attempt's own clone. Instead:
-- `~/.agflow/work` goes only into the sandbox's `denyRead`, with `allowRead: [clone]`;
+- `~/.agflow/work/*/*` goes only into the sandbox's `denyRead`, with `allowRead: [clone]`; the work root and project parents stay readable for package-script resolution;
 - sandboxed writes are already limited to the clone and the temporary directory;
 - the guard (section 8.2) refuses:
   - any `Read`, `Glob`, `Grep`, `Edit`, `Write` or `NotebookEdit` whose real path, or search root, is under `~/.agflow/work` but outside the clone;
   - any `Read`, `Glob` or `Grep` under `<CLAUDE_CONFIG_DIR>/projects/` outside the attempt's own project directory;
   - any `Edit`, `Write` or `NotebookEdit` outside the clone and its temporary directory.
 
+**Bash screening.** Claude's command screening can refuse shell shapes before the sandbox runs them. Keep the production permission rules; for a complex legitimate operation, write a script inside the clone with Edit or Write and run it. The script still runs under the sandbox, including sibling-clone read denials. `CLAUDE_BASH_NOTE` explains this fallback and the refused computed Git subcommands.
+
 **Agent environment.** It is built from an allowlist, never by removing variables from the runner's own environment.
 - **User and system:** `USER`, `LOGNAME`, `LANG`, `LC_*`, `TERM=dumb`, `SHELL`, and `NODE_USE_SYSTEM_CA=1`.
+- **Claude shell:** the adapter sets `ZDOTDIR=<claudeHome>/agflow-empty` (an empty runner-owned directory), drops any incoming `CLAUDE_CODE_SHELL`, and sets `CLAUDE_CODE_SHELL=/bin/zsh` unless the basename of `SHELL` is already `zsh`. Only the snapshot sources `~/.zshrc` outside the sandbox, once per Claude process; `~/.zshenv`, `~/.zprofile`, `~/.zlogin` and `~/.bashrc` do not run around agent commands. The snapshot remains an accepted residual risk (section 5).
 - **Connectivity:** the variables captured at setup.
 - **Home and temporary directories:**
   - Claude: the owner's `HOME`, because the CLI process needs it for its login. `CLAUDE_CODE_TMPDIR=/tmp/agf/<id>`, a short private directory (mode 0700, removed at cleanup), also in the sandbox's `allowWrite`. The CLI creates `claude-<uid>/` (the commands' `TMPDIR`) and `cc-socks/` inside it. The runner refuses a temporary path whose `<dir>/claude-<uid>` exceeds 44 bytes, because beyond that the CLI silently falls back to the shared `/tmp/claude-<uid>`.
@@ -1775,7 +1795,7 @@ Agents need dependencies, but Codex agents have no network, and Claude's sandbox
 - **Quota and extra usage.** On the same query, preflight calls the SDK's experimental `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()`, which the pin fixes. Its `rate_limits` give the 5-hour and weekly utilization (percent / 100) and reset times; `extra_usage.is_enabled` gives `paidUsage` `enabled` or `disabled`. If the call fails or its shape differs, `paidUsage` is `unknown` and the quota stays unknown until the first `rate_limit_event`.
 - **The account** gives `accountId` (a hash of the account email) and `plan`. `managedPolicy` is always false for Claude.
 - **Weakened items.** Preflight's `weakened` list names what cannot be enforced: the `auto` profile, and the shared `/tmp/claude` if the local sandbox checks (section 15) find its `denyWrite` unenforced on the pin. The list is fixed per pin from those checks; nothing is probed at run time.
-- **First turn.** The first turn of every session checks `system/init` again, expecting the attempt's CLI version. A mismatch fails the start (`attempt.failed_to_start`, infra); the hub's two-failed-starts rule then marks the vendor not ready.
+- **First turn.** The first turn of every session checks `system/init` again, expecting the attempt's CLI version. A new session's mismatch fails the start (`attempt.failed_to_start`, infra); the hub's two-failed-starts rule then marks the vendor not ready. A resumed session's first-turn mismatch is reported as `attempt.exited`, rather than as a new failed start.
 
 ### 8.2 Session options
 
@@ -1788,6 +1808,7 @@ query({
     sessionId: newUuid /* new sessions */, resume: sessionRef /* resumed ones */,
     model,                                                    // AgentLaunch.model: a full id, never an alias
     settingSources: ['project'], projectConfigRoot: baseCheckout,
+    systemPrompt: { type: 'preset', preset: 'claude_code', append: CLAUDE_BASH_NOTE },
     strictMcpConfig: true,
     mcpServers: { agflow: { type: 'stdio', command, args: ['mcp', '--vendor', 'claude', '--runner'], env: bridgeEnv } },
     tools: ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Task',
@@ -1811,17 +1832,18 @@ query({
 });
 ```
 
+- **System prompt.** The `claude_code` preset is explicit; otherwise the SDK sends an empty system prompt. The appended `CLAUDE_BASH_NOTE` explains the runner's Bash restrictions.
 - **Sandbox placement.** The sandbox is a top-level option, never also inside `settings`, so the SDK passes `failIfUnavailable` and Bash never runs unsandboxed.
 - **Bridge tools.** `permissions.allow` lists `mcp__agflow`; without it, every bridge call would be denied under `permissionPrompts: 'none'`. The flag-settings layer honours allow rules.
-- **Brief.** The brief arrives through the `SessionStart` command hook. That hook runs with `pwd` set to the base checkout, so `agflow hook brief --runner` identifies the attempt from `AGFLOW_AGENT_TOKEN`.
+- **Brief.** The brief arrives through the `SessionStart` command hook. The hook command changes to `<claudeHome>/agflow-empty` before starting agflow (section 10); `agflow hook brief --runner` identifies the attempt from `AGFLOW_AGENT_TOKEN`.
 - **The guard,** a `PreToolUse` callback in both profiles, refuses:
   - Bash commands that run `git push` (including `git -C … push`), `git credential`, `git config --global`, `gh`, `glab` or `security`, or that write into `.git/hooks` or `.git/config`;
   - `Edit`, `Write` and `NotebookEdit` whose real path is outside the clone and its temporary directory, or is `<clone>/.git/config` or under `<clone>/.git/hooks/`;
   - `Read`, `Glob` and `Grep` whose real path is in another attempt's clone, or under `<CLAUDE_CONFIG_DIR>/projects/` outside the attempt's own project directory (section 7.6).
 
-  A command the guard cannot parse is refused.
+  A command the guard cannot parse is refused. This includes computed Git subcommands through substitutions, backticks or variables, and eval/sh wrappers that could hide a push. Production Bash permissions stay restrictive; the script fallback in section 7.6 supports legitimate commands.
 - **Tools.** The explicit built-in tools list removes `SendMessage`, `ListAgents`, cron and wake-up tools, `RemoteTrigger`, `Workflow`, `EnterWorktree` and `ToolSearch`.
-- **Shell snapshot.** Claude Code sources the owner's shell profile outside the sandbox once per process (section 5). The snapshot is written to the runner's Claude home, which sandboxed commands cannot read. The owner's functions therefore do not reach agent commands, and the agent's `PATH` comes from its environment.
+- **Shell snapshot.** The mitigation is implemented: the adapter sets `ZDOTDIR=<claudeHome>/agflow-empty`, drops any incoming `CLAUDE_CODE_SHELL`, and sets `CLAUDE_CODE_SHELL=/bin/zsh` unless the basename of `SHELL` is already `zsh`. Only the snapshot sources the owner's `~/.zshrc` outside the sandbox, once per Claude process; `~/.zshenv`, `~/.zprofile`, `~/.zlogin` and `~/.bashrc` do not run around agent commands. The snapshot remains an accepted residual risk (section 5). It is written to the runner's Claude home, which sandboxed commands cannot read. The owner's functions therefore do not reach agent commands, and the agent's `PATH` comes from its environment.
 
 ### 8.3 Messages, turns and events
 
@@ -1893,6 +1915,7 @@ query({
     shell_environment_policy: { inherit: 'all', exclude: ['AGFLOW_*'],
                                 set: { HOME: `${clone}/.agflow/run/home`, TMPDIR: `${clone}/.agflow/run/tmp` } },
     mcp_servers: { agflow: { command, args: ['mcp', '--vendor', 'codex', '--runner'],
+                             cwd: codexUserHome,                 // never the clone; bridge runs outside the sandbox
                              env_vars: Object.keys(launch.bridge.env),   // every bridge variable of section 7.6:
                                        // the AGFLOW_* ones, the poll settings, NODE_USE_SYSTEM_CA, connectivity
                              default_tools_approval_mode: 'approve', required: true } },
@@ -1901,11 +1924,12 @@ query({
 }
 ```
 
-- **Trust.** Before `thread/start` and `thread/resume`, the runner checks that the clone's `.codex/` equals the restore base's, through the vault, after restoring the agent-config paths. It passes the answer as `AgentLaunch.projectConfigVerified`. The trust entry is always explicit: without one, Codex would trust the clone automatically and write a trust entry, which now lands in the runner's own Codex home. When the check fails, the thread runs `untrusted`, without the project's `.codex/` layer, and the runner logs a note.
+- **Trust.** Before `thread/start` and `thread/resume`, the runner checks that the clone's `.codex/` equals the restore base's, through the vault, after restoring the agent-config paths. It passes the answer as `AgentLaunch.projectConfigVerified`. The trust entry is always explicit: without one, Codex would trust the clone automatically and write a trust entry, which now lands in the runner's own Codex home. When the check fails, the thread runs `untrusted`: project config, hooks and exec policies are skipped, but it still loads `<clone>/.codex/skills`. The runner's warning says so.
 - **Checks after every `thread/start`.**
-  - `mcpServerStatus/list` must list only `agflow`.
+  - `mcpServerStatus/list` must list only `agflow`. The list omits servers still starting or failed, so any `mcpServer/startupStatus/updated` naming another server also refuses the start. A trusted project's MCP servers can run outside the sandbox before these checks refuse the thread: trusting a verified `.codex/` means trusting its commands.
   - `skills/list` must list no user or plugin skills.
   - A `configWarning` naming an unrecognised or disallowed setting fails the start (`failed_to_start`, infra).
+- **Tool discovery.** Code Mode defers MCP tools. `developerInstructions` also name `launch.bridge.tools` and the `tools.mcp__agflow__<name>` calling form, so tool discovery survives compaction; a first-prompt note alone would not.
 - **Naming.** The thread is named `agflow T-42-a3` (`thread/name/set`).
 - **Turns.** `turn/start` returns the active turn id; use it, because `turn/started` arrives later. `turn/completed` reports `completed`, `interrupted` or `failed`.
 - **Child threads.** All threads on the attempt's app-server belong to the attempt, including collaboration sub-agents. Turn tracking, continuation and acknowledgements follow only the main thread id. Approvals from child threads are relayed under the same attempt.
@@ -1947,6 +1971,8 @@ query({
 
 ## 10. Bridge and hooks
 
+**Startup isolation.** The bridge and Claude's brief hook run outside the vendor sandbox. They load no `bunfig.toml` or `.env` from their working directory: the compiled binary uses `--no-compile-autoload-bunfig` and `--no-compile-autoload-dotenv`; the source form runs `bun --no-env-file --config=/dev/null <repo>/packages/cli/src/main.ts`. Claude's bridge and brief hook start in `<claudeHome>/agflow-empty`. Codex's bridge MCP config sets its cwd to the runner's Codex user home, because stdio MCP servers otherwise start in the thread's cwd.
+
 **Runner mode** of `agflow mcp`. An explicit flag selects it, `agflow mcp --vendor <v> --runner`; it is never inferred.
 - At startup the bridge exits non-zero if `AGFLOW_AGENT_TOKEN`, `AGFLOW_HUB_URL`, `AGFLOW_ATTEMPT_ID`, `AGFLOW_ROLE` or `AGFLOW_CONFIG_DIR` is missing. With Codex's `required: true`, `thread/start` then fails.
 - It uses the token as its bearer, sends no `X-Agflow-Agent`, and reads no credentials file. It does not call the hub at startup.
@@ -2140,12 +2166,14 @@ export interface AgentLaunch {
   role: AgentRole;
   model: string;                 // resolved by the runner
   cliVersion: string;            // the pin at start; the attempt's recorded version on every resume (section 7.4)
-  clone: string;                 // real path; the agent's cwd
+  clone: string;                 // real path; tool commands run here; Codex app-server starts in codexUserHome
   baseCheckout: string | null;   // Claude's project config root; null for Codex
   projectConfigVerified: boolean;  // the clone's .codex/ equals the restore base's (section 9.2)
   tmpDir: string;                // CLAUDE_CODE_TMPDIR or the Codex TMPDIR
   env: Record<string, string>;   // the agent environment (section 7.6)
-  bridge: { command: string; args: string[]; env: Record<string, string> };
+  bridge: { command: string; args: string[]; env: Record<string, string>; tools: readonly string[] };
+                                 // unprefixed agflow tools for AGFLOW_ROLE; BRIDGE_TOOL_NAMES in packages/runner,
+                                 // checked against the CLI tool lists
   profile: PermissionProfile;
   brief: string;                 // spec.brief plus "Your working directory: <clone>" (section 10)
   firstPrompt: string;
@@ -2242,9 +2270,11 @@ Parallel plans avoid editing the same files: the runner core pre-declares the sh
   - `Edit` and `Write` to the base checkout and to `~/.zshrc` are refused in both profiles;
   - a bridge call succeeds without a permission denial;
   - a Codex attempt lists no `codex_apps` tools;
+  - the keychain lookup inside the sandbox uses the real HOME, so the check exercises the sandbox rather than HOME isolation;
+  - Bun package scripts succeed, script-based sibling-clone reads are refused, and expansion-based Git pushes remain refused;
   - a fixture `bun install` and `pip install` succeed from an empty cache through dependency preparation;
   - in both profiles, these succeed: Read, Edit and Write of a clone file; a Bash write and a git commit in the clone; a Read of a persisted oversized Bash output. If the last fails under the `~/.agflow/runner` read deny, the runner's files are denied one by one instead, and the runner's Claude home is left to the sandbox's `denyRead`;
-  - a marker `~/.zshrc` (and `~/.bashrc` with `SHELL=/bin/bash`) runs once per Claude process outside the sandbox, and its functions do not reach agent commands.
+  - With either zsh or bash as the owner's `SHELL`, the snapshot sources `~/.zshrc` once per Claude process outside the sandbox; the other startup files (`~/.zshenv`, `~/.zprofile`, `~/.zlogin` and `~/.bashrc`) do not run, and their functions and PATH changes do not reach agent commands.
 - **End-to-end (local).** M2g's harness: one hub, three runners with separate `AGFLOW_HOME`s, a local bare origin, scripted model servers, and short timings in test mode. It runs the three exit scenarios plus a runner restart, a hub restart, a hub restore, a delivery to a mid-turn agent, and a take-over with hand-back. It runs with `AGFLOW_E2E=1`, and then fails, instead of skipping, when a prerequisite is missing.
 - **Pinned binaries in tests.** `findClaudeBinary` (testkit) and `findCodexBinary` (`packages/runner`) look at `AGFLOW_CLAUDE_BIN` and `AGFLOW_CODEX_BIN`, then at the runner's vendor directory under `~/.agflow`; `bun run vendor:install` puts the pins there without a full setup. A test runner home links the located version directory into its own `vendor/`. A test runner without one vendor just lacks its binary, and preflight reports "binary missing".
 - **Live run (manual).** The exit scenarios with real subscriptions on a toy repository, like M1's, plus a TTY check of both take-over commands on the runner's laptop.
@@ -2367,4 +2397,13 @@ Revision 2 applies the review's upheld findings. The main changes:
 - **Plans.** A staged, parallel execution order (section 14).
 - **Test mode and the web bundle.** Codex tests pass `test.codexConfig` as `-c` flags and write no `config.toml` (15.1). `packages/web` imports values only from zod-free core modules and checks the zod modules' values in its tests, so zod stays out of the browser bundle.
 
+**Accepted plan-review clarification (2026-11-11): settings sync.** Section 6.3 records the runner-only rule retained for M2: content-matched echoes, versioned answers, refusal probes, command lineages and restore replay filtering. Its Known limits include settings lost or diverging after a restore; a person may need to redo a local setting. The exact fix belongs to a later milestone: `update_settings` carries `answers {seq, refused?}`, refusals are explicit, `hello` names the highest answered `runner.settings` seq, and a restored hub adopting the snapshot skips those edits. That requires coordinated core and hub changes; it is not an M2 protocol promise.
+
+**Other accepted plan-review clarifications (2026-11-11).**
+- **X-49 (§6.1, §6.12).** A refused start sets `Runner.stateDetail` to `refused a start: <code>` until the next heartbeat. `Attempt.stopRequested.by` is `user:<login>`, `agent:<id>`, or `system`. A pending clone hand-back records `handingBack` with `by=user:<login>` and `at` in epoch milliseconds; another otherwise-authorized hand-back receives `409 handback_pending`. Completion, refusal or timeout clears it. A fallback without returned clone work emits `task.ready` with `{ from, attemptId, reason }`, not `task.handed_back`. Core exports `reportHolds` and `utilization` for the runner card.
+- **Recovery and late work (§6.4, §6.14, §7.4).** Daily backups run once per UTC day. Pending late work is durable before the exit event, retried after restart and pushed before cleanup, even without a clone. A failed cleanup retains its work for retries. A push of the submitted head after the attempt ended creates no late-work note or merge message; on a non-WIP ref it still emits `attempt.late_work` for retention. **Known limit:** the timeline labels this submitted-head event as late work even though there is nothing new; a distinguishing event flag is deferred.
+- **Bridge and Codex (§9.2, §10, §13).** The bridge and brief hook cannot autoload Bun config or dotenv from a clone. MCP cwd is explicit. `AgentLaunch.bridge.tools` supplies persistent Code Mode tool discovery. Untrusted Codex skips project config, hooks and exec policies but still loads project skills. MCP startup notifications cover servers omitted from the status list; verified project config remains trusted code running outside the sandbox.
+- **Claude (§3, §5, §7.6, §8.1–§8.2, §15).** The system-prompt preset is explicit, with `CLAUDE_BASH_NOTE`. A resumed first-turn mismatch is an exit. Read denials target individual clones so package scripts can resolve their parents; computed Git subcommands fail closed, and legitimate complex shell operations use the sandboxed script fallback. The shell-profile mitigation is implemented: the adapter sets `ZDOTDIR=<claudeHome>/agflow-empty`, drops any incoming `CLAUDE_CODE_SHELL`, and sets `CLAUDE_CODE_SHELL=/bin/zsh` unless the basename of `SHELL` is already `zsh`. Only the snapshot sources `~/.zshrc` outside the sandbox, once per Claude process; `~/.zshenv`, `~/.zprofile`, `~/.zlogin` and `~/.bashrc` do not run around agent commands. The snapshot remains an accepted residual risk. Carrying a resume's first message in `AgentLaunch` is future work.
+- **Deferred cleanup.** The web's fixable-submit flags keep their parity test; moving the core re-export to avoid bundling zod is a later-milestone change, with no M2 contract change.
+
 Later contract changes are recorded here the same way.
````

- [ ] **Step 4: Run the tests and see them pass**

Run: `bun test packages/testkit/test/docs-spec.test.ts && bun run typecheck`
Expected: 46 pass, 0 fail, no skips; tsc exits 0.

Complete the original spec's remaining sections and status column; the M2 design names the implementing plans and records accepted refinements in §18. Use plan names/§14 attribution rather than broken links to absent plan files. The shell mitigation is implemented: the adapter sets `ZDOTDIR=<claudeHome>/agflow-empty`, drops incoming `CLAUDE_CODE_SHELL`, and adds `CLAUDE_CODE_SHELL=/bin/zsh` unless `basename(SHELL) === 'zsh'`. With an existing zsh SHELL the override stays absent. Only the snapshot sources ~/.zshrc outside the sandbox once per Claude process; ~/.zshenv, ~/.zprofile, ~/.zlogin and ~/.bashrc do not run around agent commands. The snapshot remains an accepted residual risk. Task 19 records this in M2 §§3, 7.6, 8.2, 15 and 18; §15 requires testing both zsh and bash owner SHELL values, including that startup functions and PATH changes do not reach commands. Task 18 owns the corresponding new §§5–6 changes.

M2 §18 records X-49: a refused start sets `Runner.stateDetail` to `refused a start: <code>` until the next heartbeat; `Attempt.stopRequested.by` is `user:<login>`, `agent:<id>`, or `system`; pending clone hand-back records `handingBack` with the actor and epoch milliseconds, rejects another otherwise-authorized request with `409 handback_pending`, and clears on completion, refusal or timeout. Fallback without returned clone work emits `task.ready { from, attemptId, reason }`, not `task.handed_back`. Core exports `reportHolds` and `utilization`. Two new tests here and two in Task 18 cover the shell and X-49 documentation, for 46 passing tests at the final head. Settings exact-echo/lineage protocol work stays deferred and restore-only Known limits remain visible. No full-suite or Linux result is inferred. See Decisions 70–71. Current-head check: 46 pass, 0 fail, 363 assertions; `bun run typecheck` exits 0.

- [ ] **Step 5: Commit**

```bash
git add -A 'docs/superpowers/specs/2026-10-26-agflow-design.md' 'docs/superpowers/specs/2026-10-28-m2-runners-design.md' 'packages/testkit/test/docs-spec.test.ts'
git commit -m 'M2G Task 19: Spec updates, part 2: managers, interfaces, security, failures and milestones (§7, §11-§18)' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

---

## After the last task

### What works now

- **A real multi-runner harness.** One hub process, three foreground runner processes with separate homes, a local bare origin and both real vendor CLIs driven only by loopback scripted servers. The harness starts, stops, freezes, thaws, kills, restarts and restores through real boundaries, with process cleanup and retained failure diagnostics.
- **The three exit scenarios**, for each vendor: a killed worker's final committed and uncommitted work reaches its successor; a frozen runner loses its lease and later contributes late work that the successor merges; a frozen lead is replaced from its handoff, its person's message moves to the new seat, and the successor accepts a new submission.
- **Recovery checks.** Runner suspend and crash preserve the attempt and vendor session. Hub crash preserves the fence and token through replay and a recovery window, with one retry nudge. A restored hub applies post-backup WIP with a newer fence before re-fencing, preserves the session and advances epoch/counter names.
- **Delivery and take-over checks.** A person's mid-turn message enters the same turn once, with person authority, and is acknowledged after that turn. Take-over replaces `.git` and rebuilds the index before person-side git runs; both clone and ref hand-backs start the successor from the person's work. A process still in the clone blocks hand-back and can be retried.
- **Owner live-run tooling.** The same exit drivers can use real subscriptions. The script checks vendor logins before startup, serves the UI, records every check in Markdown and JSON, and walks a person through the terminal take-over check once for each requested vendor. Its orchestration is tested with fake logins and a scripted stand-in person, including a disposable remote read through a mirror.
- **Documentation kept against the code.** The README covers M2 operations, boundaries, views, configuration and all development scripts. The original spec uses short summaries and valid M2 links, with transitions, package layout, review statuses and implementation attribution checked by tests. Accepted contract clarifications and remaining limits are in the M2 design.

### How to run it

- Install dependencies once: `bun install --frozen-lockfile`. Use Bun 1.3.11.
- Ordinary checks: `bun test && bun run typecheck`. The enabled real-CLI cases are deliberately absent from this run; their ungated helper/root-script tests still run. In the restricted sandbox, use the targeted commands in each task and leave the full suite and Linux CI to the coordinator.
- Scripted end-to-end, outside nested sandboxes: on an Apple-silicon Mac on AC power, provide the pinned Claude and Codex binaries, git and lsof, then run `bun run e2e`. It expands to `AGFLOW_E2E=1 caffeinate -i bun test --timeout 600000 packages/testkit/e2e`. Both vendors run by default. For implementation and verification, use existing pinned executables through `AGFLOW_CLAUDE_BIN` and `AGFLOW_CODEX_BIN`, or install into a newly created scratch directory using `AGFLOW_HOME=<scratch-home> bun run vendor:install`. Then explicitly set `AGFLOW_CLAUDE_BIN=<scratch-home>/runner/vendor/claude/2.1.285/claude` and `AGFLOW_CODEX_BIN=<scratch-home>/runner/vendor/codex/0.159.2/bin/codex`; the locators do not follow AGFLOW_HOME. Remove the scratch installation after all children exit. Do not run the installer without a scratch AGFLOW_HOME or install globally during implementation or verification. Use the scratch provisioning commands in the gated rules and export both binary paths before `bun run e2e`; the binary locators do not read AGFLOW_HOME. An enabled suite fails with remedies if a prerequisite is missing. It never needs the owner's vendor login.
- A single scripted case: `AGFLOW_E2E=1 AGFLOW_E2E_VENDORS=claude caffeinate -i bun test --timeout 600000 packages/testkit/e2e/killed-agent.e2e.test.ts`. Select Codex the same way. Do not use a one-vendor diagnosis as the final two-vendor gate.
- Failure evidence: `KEEP_E2E=1 bun run e2e` retains every cluster, and failed or still-running steps retain theirs automatically. Inspect the printed dump and `/tmp/agf-e2e-*` logs before cleanup. Stop/thaw the run's processes first; the harness removes read-only agent tools before deleting successful runs. For a retained directory, use the runbook's path-specific `chmod -R u+w` and removal instructions. Killed Claude attempts may also leave their own `/tmp/agf/<id>` directory.
- **Owner only, after landing:** follow `docs/m2-live-run.md`. Run `agflow runner setup` once to install pins and log into the runner vendor homes; build the UI with `bun run build:web`; then run **`bun run live-run --takeover claude,codex`**. This is the real-subscription exit gate and consumes quota. It runs all three exit scenarios for both vendors, followed by both terminal take-over checks. During each, use the browser's Take over, the printed local resume command, an in-session commit, then exit/leave the clone and use Hand back. Record whether the earlier conversation resumed. Do not run this during implementation or automated verification.
- Live-run options: `--runners` selects scenario vendors; `--scenarios` selects the three named exit cases; `--takeover` selects its own vendor list; `--claude-home` and `--codex-home` override exact logged-in paths; `--keep` retains files. `--repo` must name a disposable repository: every cluster resets its main and deletes earlier run refs. The default local bare origin is sufficient. `--help` starts nothing.
- The owner script writes `results.md` and `results.json` after every cluster under its printed `/tmp/agflow-live-*` directory and exits 0 only when all checks pass. Copy the results into the PR and fill `docs/m2-live-run.md`'s Results table. The optional real lid-close check needs a second Mac; SIGSTOP on one machine does not test real network/power suspension.

### What is left

- **The owner's subscription run and both terminal resumes remain unrun.** The finished prototype and this generated plan do not claim that manual gate passed. The runbook deliberately has an empty Results table.
- **Final outside checks.** Historical reports establish the prototype's scripted results, not a new full-suite/Linux/gated run at the final SHA. The coordinator runs the full suite, Ubuntu CI and the complete `bun run e2e` with both vendors outside this sandbox. Nested vendor sandboxes and this Mac's MDM policy must remain intact; no workaround or weakened assertion is part of this plan.
- **Restore-only settings limitations remain.** Without an echo naming the exact edit and a version naming its lineage, settings can be lost or diverge after a restore. The late-echo, ahead/equal restored-version, older-history and probe cases remain documented Known limits. Their protocol fix belongs to a later milestone; Task 12's WIP replay does not claim to solve them.
- **Known test limits.** One-vendor clusters do not cover cross-vendor placement. No public API exposes the closed-laptop transcript upload. Keep-awake, disk guards, credential isolation and production shell profiles are covered by their owning plans' tests. Playbooks assume short, uncompacted histories. Lost-lead lacks the optional dump callback for a completed failed check; waits still include dumps. These are stated boundaries of the evidence.
- **Separate follow-up:** M1's `scripts/smoke-hub.ts` leaves `agflow-smoke-*` temporary directories. It was outside this plan's edits and remains an owner follow-up. A refused or failed test must be investigated in its owning plan, never hidden by extending this plan's scope.
- **Later milestones:** M3 brings checks, tamper/scope scans, reviewers, PRs, merge queue, attestation and CLI-token keychain hardening; M4 brings usage accounting and repository-derived context. Linux service files, profile editing UI, per-attempt approval grants, Claude mid-turn approval relay and hand-back to a person's live chat remain deferred as the design says.
