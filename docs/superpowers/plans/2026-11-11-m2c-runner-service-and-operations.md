# M2c: runner service and operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn M2b's runner core into a laptop service that an owner sets up once and can then leave alone. The plan adds:
- `agflow runner setup`, `start`, `install`, `status`, `drain`, `undrain`, `restart`, `stop` and `uninstall`;
- the pinned vendor binaries (the installer behind M2b's `VENDOR_PINS`, and `bun run vendor:install`) and the vendor logins in the runner's own homes;
- a launchd LaunchAgent, with setup's checks run inside it;
- one instance per runner home, through `runner.lock` and the control socket `runner.sock`;
- SIGTERM as suspend, the side effects of `needs_login`, and a crash-loop guard;
- the macOS notifier;
- dependency preparation in Anthropic's sandbox runtime;
- retention and the disk guard, the battery guard, and keep-awake.

M2c fills M2b's seams (`Logger`, `RunnerHealth`, `DependencyPreparer`, `Notifier` and the credentials provider) and drives `RunnerHandle` and `RunnerEvents`. In `packages/runner` it edits only M2b's `vendor/pins.ts`. In `packages/cli` it adds `runner-command.ts`, `runner-setup.ts` and `runner-uninstall.ts`, and edits `main.ts` (HELP and the command table) and `hub-client.ts` (`runnerWhoami`, `retireRunner`), which M2b also edits, as well as `packages/cli/package.json` and the root `bun.lock` (M2b's Tasks 1, 2 and 40 also change `bun.lock`). It does not change the hub. When the plan is done, `agflow runner setup` takes a signed-in laptop to a running LaunchAgent whose checks pass, and M2g can start runners with `agflow runner start` and find their agents through `agflow runner status --json`.

**Architecture:**
- **The service wraps M2b's runtime.** `startRunnerService` (`service/host.ts`) is the one process that runs a runner. It takes `runner.lock`, opens the log and the run record, loads runner.json, checks the machine binding, binds `runner.sock`, reads the credentials, opens runner.db, builds the operations and calls M2b's `createRunner`. It has one exit path, `finish()`: it ends the agents (a suspend, a stop with or without a handoff turn, or nothing after an uncaught error), kills the registered groups, closes everything, records the exit and releases the lock last.
- **Seams, not edits** (X-7, X-8). `RotatingLog` is the `Logger`, `createServiceHealth` the `RunnerHealth`, `createDependencyPreparer` the `DependencyPreparer`, `createMacNotifier` the `Notifier`, and `readCliCredentials` the credentials provider. `RunnerEvents` feed the health (`gap`), keep-awake (`attemptState`), needs_login (`needsLogin`, `welcome`) and the checks (`welcome`). Suspend, stop, drain and the guards act only through `RunnerHandle`.
- **The control socket.** Commands inspect and control the running service over `runner.sock`: JSON over HTTP on a Unix socket, mode 0600, with `GET /health`, `GET /status`, `POST /checks`, `/drain`, `/undrain`, `/stop` and `/suspend`. When no service answers, the commands work on files under the lock: drain edits runner.json, status reads the run records and the log, uninstall kills the registered groups.
- **Layers.** From the bottom: `service/system.ts` (`Exec`); machine facts, runner.json and credentials; vendor logins and the installer; the lock and the control socket; the log and the run records; power and disk facts; the notifier; the health and keep-awake; dependency preparation (`prep/config.ts`, `plan.ts`, `sandbox.ts`, `preparer.ts`); retention; then the host and what runs in it (suspend, needs_login, drain, status, checks, stop), the LaunchAgent, and the CLI commands (`runner-command.ts`, `runner-setup.ts`, `runner-uninstall.ts`).
- **macOS through one seam.** Every macOS command (`ioreg`, `scutil`, `pmset`, `osascript`, `launchctl`, `plutil`, `tar`, `du`) goes through an injected `Exec` and is tested with recorded outputs; checks against the real binaries skip off macOS. Only caffeinate and the sandboxed preparation runs are spawned directly, because they outlive a command.
- **Package direction.** `packages/cli` depends on `@agflow/runner` and imports its service modules by deep path, only when a subcommand runs. The runner never imports the CLI, which passes it `configDir()` and `selfCommand()` (X-8, X-44).
- **Tests.** Service tests run M2b's in-process hub (`startTestHub`) and fake adapter through `setupTestService` and `startTestService`, with short `/tmp/agf-*` homes and fake operations, so no service test touches the sandbox runtime, osascript, caffeinate or launchd. Signal and exit-code tests run the service and the CLI as child processes.

**Tech Stack:** Bun 1.3.11 (runtime, test runner, `bun:ffi` for flock, `Bun.serve` on a Unix socket, `Bun.spawn`), TypeScript 5.9.3, zod 4.6.7, git 2.50, and two dependencies M2b pre-declared: `@anthropic-ai/sandbox-runtime` 0.0.81 (dependency preparation) and `@anthropic-ai/claude-agent-sdk` 0.3.285 (only its `manifest.json`, for the pin check). macOS tools: launchctl, plutil, pmset, ioreg, scutil, caffeinate, osascript, du and tar.

**Depends on:**
- Plan M2b (runner core and bridge), branch `m2b-runner`, at base `1a0804110b5e189dea851be2306fcadc638909f4` (its Task 45). This is the preceding plan in the final chain and includes everything below it: M2a (`m2a-fix`, `806fa57fdcc6443de1a7ad8de7cca5b1c5e83035`), M1 (`9f58fa2` on `main`) and the M2 design, revision 4. M2c is branch `m2c-ops`, head `a0202a2f06b26bde6947efcb936ef6aff344a782`, with exactly 25 task commits.
- By the gates (X-47):
  - Tasks 1-13 need gate G2 (M2b Task 39): `runnerPaths`; `RunnerConfig` with `loadRunnerConfig`, `saveRunnerConfig`, `editLocalSettings`, `isTestMode`, `CONNECTIVITY_VARS` and every runner timing; `VENDOR_PINS`, `vendorBinary` and `parseVendorVersion`; `Logger`; runner.db with `Outbox.pruneAcked` and `pruneBefore`, `Journal.pruneBefore` and `AttemptStore`; `Vault` with `consolidate`; `restoreProtected` and `removeInClone` (M2c does not call `resolveRestoreBase`: M2b's controller resolves the restore base with it and passes it in `PrepareInput.baseSha`); `removeAgentTools` and `removeTree`; `buildAgentEnv`, `userVariables` and `deniedReadPaths`; `killRegisteredGroups`; the `RunnerHealth`, `DependencyPreparer` and `Notifier` seams; `createRunner`, `RunnerHandle` and `RunnerEvents` (M2b Task 38); `createAdapters`; and M2b's test fixtures and fake adapter.
  - Tasks 14-25 need gate G4 (M2b Task 45): `packages/runner/test/hub-fixture.ts` (`startTestHub`, M2b Task 40); M2b's edits to `packages/cli` (`main.ts`, `hub-client.ts`); and, through M2a, the gateway's refusals (4403 for another machine or a retired runner, 4409, 4426), `GET /api/runner/whoami`, `POST /api/runner/retire`, the preparation routes and the reconciliation of suspended attempts.
- This plan builds on M2b `m2b-runner` at `1a0804110b5e189dea851be2306fcadc638909f4`. The base includes hardened selfCommand/build:cli flags, RunnerOptions.cliVersion and fixtureCliVersion, AttemptRecord/AttemptStatus.lateWorkSha with startup retries, safe settings pruning and the settings retry/restore fixes. RunnerServiceOptions forwards cliVersion; fake service harnesses supply fixtureCliVersion. AgentLaunch.bridge.tools is filled by bridgeOf from BRIDGE_TOOL_NAMES, so M2c needs no runnerToolsFor callback and adds no runner-to-CLI dependency. The base now also supplies durable `AttemptRecord.finalizedAt`: null for new/migrated records, reset before start/resume work, recorded only after the final-work outcome, and never manufactured by recovery. Successful hand-back or cleanup work resolution clears `pushError`. Task 25 consumes this contract and its recovery regression is a normal test.
- Not M2d or M2e: the tests run on M2b's fake adapter, and the real adapters arrive through `createAdapters`' entry files.

**Spec:** `docs/superpowers/specs/2026-10-28-m2-runners-design.md`, revision 4: sections 7.1 (setup, service and lifecycle), 7.7 (dependency preparation), 7.8 (retention and disk) and 7.9 (power and keep-awake); and the service's parts of 6.3 (heartbeat facts, `runner.state`, the settings sync that drain uses), 6.4 (suspend and `runner_stop` exits), 6.10 (notifications), 6.16 (whoami and retire), 7.2 (runner.lock, runner.sock, logs, vendor and prep), 12 (runner.json and the runner timings), 13 (the registry and `agflow runner start`), 15 and 15.1 (`vendor:install`, the preparation check, no notifications in test mode). Section 14's M2c row gives this plan's scope. The cross-plan decisions that bind this plan are listed below with their reasons.

**How this plan was checked:**

- Current commit refresh (2026-11-11): all task subjects and linear parents match the refreshed prototype, exactly one commit per task. SHA references now name this chain. Earlier rebase comparisons and test totals below describe their recorded runs; they do not establish unchanged patches or new full-suite/Linux results after the latest fixups. Generated code comes from the current task commits.
- Every task was first built on a prototype branch, `m2c-ops`, one commit per task, test first, and reviewed in batches of two or three tasks. Codex wrote most first drafts under a supervising agent, which ran the full suite, the typecheck, the real-sandbox tests and the launchd check outside Codex's sandbox (where `ps` and a nested `sandbox-exec` fail). Review fixes were folded into the commit of the task they belong to, and each commit typechecked on its own.
- Tasks 10-13 were built before Tasks 8 and 9, which needed M2b Task 38's `RunnerEvents`, and the commits were then put back in plan order. Tasks 8 and 9 use nothing from Tasks 10-13, and the reordered tree was identical to the one before.
- The branch was built on M2b before M2b's last fix round and then rebased onto `f1d572d` with no conflicts. Two tasks were adapted: Task 2's `vendorCliEnv` now calls M2b's new `userVariables`, and Task 25 gained a test that purges the read-only tools directory a real attempt leaves.
- The code of every task below is generated from the current commits listed in plan.json: new files in full, changed files as unified diffs that apply in order.
- On 2026-11-10, `tools/verify-plan.ts` rebuilt the branch from this document alone, task by task from `f1d572d`. It checked that each task reproduces its commit exactly, and it ran `bun test && bun run typecheck` after the last task: 2606 pass, 2 skip, 0 fail across 2608 tests in 186 files, and `tsc` exits 0. The two skips are the Linux-only missing-dependency test of the preparation sandbox and the preparation check that runs only with `AGFLOW_SANDBOX_CHECKS=1`.
- Before the previous refresh, the expected failure in step 2 of each task was what its test command printed on 2026-11-10 with only that task's test files (the `test/` folders and `*.test.ts`) added to the tree before the task's code. For 20 tasks it is the failure the prototype's report recorded. For Tasks 17, 18, 20, 23 and 24 the reports named only the missing module, or the test files changed after the report, so the text is from that run. Those historical quotes used repository-relative paths; the final-chain Task 25 quote keeps the observed absolute scratch path.
- Local checks that `verify-plan.ts` does not run: `bun run verify:prep` passed after Task 12 (bun and pip installed from empty caches, no shared inode), and `bun run verify:service` passed after Task 24 in this Mac's desktop session, before the last review fixes of Tasks 20-25. One real `bun run vendor:install` into a scratch `AGFLOW_HOME` confirmed both pins' integrity, Claude's sha256 and the Codex tree. Tasks 12 and 24 say when to run them and what they touch.
- No step sends a prompt to a real model. Vendor CLIs in the tests are fake shell scripts, and no test runs a real login: never the owner's credentials, keychain logins, `~/.claude`, `~/.codex` or `~/.agflow`.
- Earlier heads were also checked on Ubuntu by the coordinator; see Known behaviour 9 for their historical results. The original verification above was on macOS on Apple silicon (darwin-arm64).

- Round 2 rebased onto `4862a5b`: all 25 task patches survived unchanged, with the Task 21 `lateWorkSha` projection fixup retained. Runs 1–5 added test-mode lifecycle isolation, forwarded `fixtureCliVersion` through the fake service harnesses, selected darwin-arm64 retention pins for fake operations, hardened `verify:service` compilation and environment forwarding, resolved host/run-service rebase conflicts, and injected vendor responses in Task 23's startup-retry test. Regression tests were run before their fixes. The checks-only round made no new Codex runs or commits; the subsequent purge-review fix was folded into Task 25, leaving exactly 25 task commits at `c8fef4c0a8b2af70c3ed2626e2fc1114d0da28b6`.
- Historical verification at `27890c67`: macOS 2666 pass, 2 skip, 0 fail; typecheck clean; Ubuntu 2641 pass, 27 skip, 0 fail. Those results predate the purge-review changes. At `c8fef4c0`, the coordinator reports macOS 2668 pass, 2 skip, 0 fail and clean typecheck; Ubuntu 2642 pass, 27 skip, 1 fail in M2b's controller-stop timing test (passes alone). At that historical head the recovery regression was still `test.failing`; the final chain now enables it after the M2b contract and Task 25 consumer landed.
- The previous refresh ran the test commands for Tasks 13, 14, 16, 17, 18, 21, 23, 24 and 25 on scratch archives of each task's current parent, copying only that task's test files from its commit. All nine commands exited 1 with a relevant first failure, recorded in place of the older expected failures. Later process-identity assertions in these intentionally failing parent runs are subject to the sandbox ps restriction; they are not evidence of a current-head regression. The coordinator's supplied macOS run at that earlier head covered process identity outside the sandbox. Logs and a manifest are in `m2c/parent-failures/`; all nine scratch archives were removed. `bun run typecheck` passed locally during that previous refresh. For tasks outside that list, the owned test files were unchanged from the preceding plan. That refresh claimed no new full-suite or reconstruction verification.

- Final-chain refresh (2026-11-11): `chain.md` records a conflict-free move onto M2b `1a0804110b5e189dea851be2306fcadc638909f4` with the Task 25 follow-up folded into `a0202a2f06b26bde6947efcb936ef6aff344a782`. The coordinator reports clean typechecks at each plan and no fixes needed in the final checks; later M2g Tasks 17–19 do not alter M2c. Comparing every task's owned test files with the previous plan found only Task 25's `packages/cli/test/runner-uninstall.test.ts` changed. Its expected failure was rerun on an archive of its new parent with only its test files copied in; the first failure is quoted in Task 25. `final-chain-checks/test-comparison.json` records all 25 comparisons. A clean archive of the final M2c head passed `bun run typecheck`, including every M2c AttemptRecord fixture; no missing-field adaptation is needed. The Task 25 test command on that archive ran 23 tests: 22 passed (including recovery and finalization regressions); only the offline process-identity test failed because the sandbox denies spawning `ps` (`EPERM`). The coordinator reran `bun test packages/cli/test/runner-uninstall.test.ts` from the worktree outside the sandbox: 23 pass, 0 fail, 212 expect() calls across 1 file. This resolves the sandbox-only failure; no test was changed or weakened and no verification remains outstanding for this refresh. Logs are in `final-chain-checks/task-25-head.log` and `final-chain-checks/head-typecheck.log`; both scratch archives were removed afterwards. This refresh makes no new full-suite or Linux claim.

---

## Decisions

### Cross-plan decisions that bind this plan

These were settled across the seven M2 plans before prototyping; the design's revision 4 carries their contract parts. `decisions.md` cites this plan's old task numbers in its text; the numbers here are the current ones.

1. **X-3 Closed code lists.** M2c refuses starts only with `START_REFUSALS`' `needs_login`, `waking`, `battery_low` and `disk_low`; `draining`, `at_capacity` and `vendor_not_ready` stay M2b's. A preparation before a start or resume reports `requestId` null. (Tasks 8, 12, 18.) Why: the hub never meets a code it does not know.
2. **X-6 The adapter registry.** The host calls `createAdapters(config, paths, { agflow })` unless adapters are injected, and a test checks it with a stub factory. (Tasks 14, 15.) Why: `agflow runner start` runs whatever adapters M2d and M2e fill in, and the tests inject the fake adapter.
3. **X-7 Runner seams and real names.** M2c uses M2b's names and re-implements nothing. `RotatingLog` implements `Logger` and `createServiceHealth` implements `RunnerHealth`; suspend wraps `pause()` and `stopAgents('suspend', { handoff: false })`; needs_login adds only side effects to M2b's detection; preparation restores with `restoreProtected` at `PrepareInput.baseSha`, the base M2b's controller resolves with `resolveRestoreBase` (X-7 names both; M2c calls only `restoreProtected`); retention calls `Outbox.pruneAcked`, `Outbox.pruneBefore` and `Journal.pruneBefore` and schedules `Vault.consolidate` daily; stop uses `waitAcked` and `stopAgents('runner_stop', { handoff: true })`; uninstall uses `killRegisteredGroups`; `installRefusal` (`service/launchd.ts`) complements M2b's `isTestMode`. There is no controller, executor, `config.ts`, `db.ts`, `runner.ts` or barrel edit. (Tasks 1, 3, 4, 5, 6, 8, 9, 10, 12, 13, 17, 18, 20, 24, 25.) Why: each seam has one implementation, in the plan that owns it. Finalization completion and resolution of final-work errors belong to M2b; `finalizedAt` distinguishes a recovered stopped attempt from completed finalization, and Task 25 consumes it.
4. **X-8 Credentials from a provider.** `readCliCredentials(configDir)` parses with core's `CredentialsSchema` and is `createRunner`'s credentials provider, read again on each call. The runner never imports `packages/cli`; the CLI passes `configDir()`. (Tasks 1, 14, 15, 18, 23, 25.) Why: the CLI depends on the runner, never the reverse, and a new `agflow login` must reach a running service.
5. **X-9 Notifications.** `createMacNotifier(exec): Notifier` posts M2b's approval notices and the needs_login notice. M2c has no outbox observer and no `Notifier` type of its own, and posts nothing in test mode. (Tasks 7, 18.) Why: M2b's controller owns the approvals relay, and osascript cannot open links, so the text carries the hub URL and core's `APPROVALS_ROUTE`.
6. **X-10 Vendor pins and binaries.** M2c fills `VENDOR_PINS`' integrity (each tarball's sha512, and Claude's binary sha256 from the SDK's `manifest.json`, with a test that it still matches) and adds the installer. `setup`, `install` and `vendor:install` install missing pins; `start` never downloads. `AGFLOW_NPM_REGISTRY` may name a mirror or a test registry, and only darwin-arm64 is pinned. (Tasks 3, 13, 20, 23.) Why: the installer and both adapters read one table.
7. **X-11 `canPushWip`.** needs_login pushes WIP only through M2b's `pushWipNow`, which `canPushWip` gates; M2c has no rule of its own. (Task 18.) Why: one predicate keeps every push inside the hub's grace.
8. **X-12 Settings sync.** drain, undrain and the crash-loop self-drain go through `changeSettings`, or edit runner.json under the lock while the runner is down; M2b sends the edit after the next welcome. (Task 19.) Why: M2b owns the whole protocol, and a drain made offline survives a browser change made meanwhile. M2c delegates settings reconciliation and pruning to M2b. Outbox's default settingsSavedVersion guard preserves edits whose echo has not been saved to runner.json. Every hello starts a new settings lineage; failures and version gaps retry locally until a new hello or close. A restored hub's first welcome is internal to M2b's immediate reconnect. If runner.json gains a vendor by migration, introduce it through runner.settings rather than modifying confirmedSettings directly. Finalization completion and resolution of final-work errors also belong to M2b; M2c must not infer completion from a stopped state.
9. **X-13 Resumes use the attempt's CLI version.** Retention keeps every vendor version that an attempt record still names. (Task 13.) Why: a session resumes in the CLI that wrote it.
10. **X-16 Restore base.** Preparation reads `.agflow/config.json` from the vault at the restore base, `PrepareInput.baseSha` (which M2b's controller resolves with `resolveRestoreBase`), and restores the protected paths there before it runs. (Tasks 10, 12.) Why: an agent's edits to its clone must never steer its own preparation.
11. **X-20 Pinned binaries for the smoke suites.** For implementation and verification, use existing pinned executables through `AGFLOW_CLAUDE_BIN` and `AGFLOW_CODEX_BIN`, or install into a newly created scratch directory using `AGFLOW_HOME=<scratch-home> bun run vendor:install`. Then explicitly set `AGFLOW_CLAUDE_BIN=<scratch-home>/runner/vendor/claude/2.1.285/claude` and `AGFLOW_CODEX_BIN=<scratch-home>/runner/vendor/codex/0.159.2/bin/codex`; the locators do not follow AGFLOW_HOME. Remove the scratch installation after all children exit. Do not run the installer without a scratch AGFLOW_HOME or install globally during implementation or verification. (Task 3.) Why: M2d's and M2e's real-CLI suites and M2g need pins discoverable without using the owner's runner installation.
12. **X-26 The shared hub fixture.** The host and service tests use M2b's `startTestHub`. (Tasks 14 and 16-25.) Why: the runner meets the same hub that `main.ts` starts.
13. **X-30 Runner timings.** A preparation run times out after `prep` (15 minutes). Tests use short timings only with `AGFLOW_TEST=1` and the test block's `allowShortTimings`. (Tasks 11, 12.) Why: production must never get test timings by mistake.
14. **X-36 A retired runner.** The hub answers a retired runner's hello with 4403, and the service treats it like any 4403. (Task 14.) Why: a retired runner needs `agflow runner setup`, which is a person's job.
15. **X-38 One nudge after an outage.** needs_login's interrupt marks the attempts for M2b's one reconnect message, and M2c sends no message of its own. (Task 18.) Why: the agent gets one message telling it to retry the tool that failed.
16. **X-40 Dependency preparation.** The request id is the `prepare_dependencies` command id; a preparation before a start or resume reports `requestId` null, and its failure then ends the start. Workers only. Each run times out after `prep`. An entry may say `"scripts": true`; `HOME` is `<clone>/.agflow/run/home`; Go and Cargo always use per-attempt caches. Without a working sandbox, `profile.dependencyPrep` is false and a request fails with "not available on this runner". (Tasks 10, 11, 12.) Why: no new table, and one record of what the runner was asked.
17. **X-41 Runner lifecycle.** 4403, 4426 and a machine mismatch record the reason as the last exit and exit 0 under launchd, 1 in the foreground (a missing or invalid runner.json too: refinement 34). SIGINT in the foreground suspends (under `--service` too: refinement 35). `crash_loop` stays, drained, until `agflow runner undrain`. The disk and battery guards stop agents without a handoff turn, once per crossing (refined by refinement 15); `runner stop` and `uninstall` stop them with one. `runner stop` waits up to 60 s for the drain's ack, then for the exits' acks, then boots out and disables the LaunchAgent. `agflow runner status --json` lists each attempt's pid, pgid and lstart. (Tasks 5, 8, 14, 17, 19, 20, 21, 24, 25.) Why: launchd's `KeepAlive` must not loop on a refusal that a person must fix, and M2g finds agent groups through the status report. With the injected environment's AGFLOW_TEST='1', status, stop, restart and uninstall make no launchctl call; status ignores the installed plist, stop leaves it alone, restart refuses and uninstall leaves it in place.
18. **X-42 M2g uses the real names.** M2g builds its runner homes with `readMachineId` and `createRunnerConfig` with overrides, and finds agent groups through `agflow runner status --json`, never by reading runner.db. No notifications in test mode. (Tasks 1, 7, 21.) Why: one copy of each.
19. **X-44 Shared files.** M2b pre-declared this plan's dependencies and the root scripts `vendor:install`, `verify:prep` and `verify:service`, which point at `packages/runner/scripts/`. M2c alone adds the CLI's dependency on `@agflow/runner`, and the runner barrel stays M2b's. (Tasks 3, 11, 12, 15, 24.) Why: parallel plans would conflict on shared files.
20. **X-47 The parallel schedule.** Tasks 1-13 need no hub and ran after gate G2 (lane C1); Tasks 14-25 ran after gate G4 (lane C2). Gate G6 waits for this plan and for one macOS run of its local checks. Why: the hub-free tasks start early, which shortens the critical path.
21. **Plan-local, recorded in decisions.md (M2c Q18, Q22).** The LaunchAgent's `ProgramArguments` keep the running agflow command (`selfCommand()`, `process.execPath`), with a warning when it lies under ~/Desktop, ~/Documents or ~/Downloads (Task 20). The login-shell capture runs `$SHELL -l -i -c` with markers, stdin closed and a 10 s timeout, and the sleep warning covers timers of 1-30 minutes (Tasks 1, 22). Why: the binary may live anywhere, and macOS asks privacy questions for those folders.

### Refinements of the design

The outline, the prototype and its reviews settled these points, which the design leaves open or words loosely.

**Machine facts, runner.json and logins**
1. **`Exec` resolves, never throws.** A command that cannot start gives exit code 127 and the error text; a timeout SIGKILLs the process and cancels the pipe readers; stdin is closed unless the call is interactive (Task 1). Why: every caller falls back the same way, and a shell's child that holds the pipes cannot outlast the deadline.
2. **`createRunnerConfig(facts, overrides)` runs no command.** It builds runner.json from gathered facts and M2b's defaults, validates any `RunnerConfig` override with M2b's schema in `loadRunnerConfig`'s error format, and makes a new `rk_` key of 32 hex characters (Task 1). Why: setup and M2g's harness gather facts differently but must build the same file.
3. **The login-shell capture** prints NUL-separated records between random markers, runs from `HOME`, and keeps only absolute, distinct `PATH` entries; it falls back to the current environment, then to M2b's default `PATH` (Task 1). Why: shell profiles print noise, and runner.json refuses an empty `capturedPath`.
4. **Vendor homes must be real paths**, checked through the nearest existing ancestor (Task 1). Why: Claude names its keychain item after the home string, so a linked path would split one login into two.
5. **`readCliCredentials` gives null for a missing file and for JSON that fails the schema**, and throws for an unreadable file or invalid JSON, naming the file but never its contents (Task 1). Why: the CLI treats both as signed out, and the runner must never copy a token into its log.
6. **Vendor logins run from a new empty temporary directory** with an allowlisted environment: M2b's `userVariables` plus `TERM`, the captured `PATH` and connectivity variables, `NODE_USE_SYSTEM_CA=1` and `DISABLE_AUTOUPDATER=1`. Codex's status refuses any API-key login without echoing the key and reads both stdout and stderr (Task 2). Why: a caller's API key must never replace the subscription login, and the real Codex writes its status to stderr.

**Pins and the installer**
7. **`pins.ts` gains `integrity` on every pin, `sha256` on Claude's, and a `CodexPin` with the package-relative `tree`**, so pins.ts stays the one place for each vendor's version, package and integrity; M2b's pins test passes unchanged. A test checks Claude's sha256 against the installed SDK 0.3.285 and each integrity against bun.lock, with no network (Task 3). Why: a pin that drifts fails CI, not a laptop's setup.
8. **The installer stages everything in `vendor/<vendor>/`** (with a private `HOME`, `TMPDIR`, `CLAUDE_CONFIG_DIR` and `CODEX_HOME` for the `--version` check), keeps an old tree until its replacement verifies, and sweeps only the staging of dead processes (Task 3). Each tarball is read whole into memory, not streamed, before its sha512 is checked; a review accepted that for setup, `install` and `vendor:install`, which run rarely. Why: an interrupted install never leaves half a tree, and nothing is written outside `vendor/`.

**The lock, the socket, the log and the run records**
9. **runner.lock is opened with `O_CLOEXEC`**, and a foreground start retries for up to 50 ms while only a status probe holds the lock shared (Task 4). Why: setting `FD_CLOEXEC` through `bun:ffi`'s variadic `fcntl` did nothing on darwin-arm64, so an agent could inherit the lock and hold it after the runner died; and a status probe must never make a start refuse.
10. **runner.lock holds `{ pid, mode, startedAt }` and is never deleted.** The socket is bound under umask 0177, paths over 103 bytes are refused, a handler that returns undefined answers null, and `stop()` unlinks the socket only if it is still its own inode (Task 4). Why: a late stop must not remove a newer owner's socket.
11. **`RotatingLog` never throws**, escapes newlines, and keeps 10 MiB per file and five older files; service-runs.json keeps the newest 50 runs and is written atomically, by the lock holder only (Task 5). Why: logging must not take a runner down, and status reads the records without the lock.
12. **`forgetUnclean` marks runs instead of deleting them**, first closes dead runs that wrote no exit, and takes the live run's id; the crash-loop mark lives in service-runs.json until `forgetUnclean`; `lastExit` takes `{ running }` (Task 5). Why: an undrain while the runner is down must also forget a SIGKILLed crash, and pid reuse after a reboot makes `pid === process.pid` unreliable.

**Power, disk, notifications, health and keep-awake**
13. **A UPS counts as battery power**; UPS lines carry product names, and the internal battery's line wins. Usage comes from `du -skH`, and `AgflowUsage.current()` is 0 until the first du finishes (Task 6). Why: the battery guard must apply on a UPS, and core's `agflowBytes` is a number.
14. **The notifier cuts title and body to 200 code points and keeps the body's last line whole**, turns earlier newlines, U+2028 and U+2029 into spaces, drops a repeated key within 5 minutes (failed posts count), and logs failures without the body (Task 7). Why: the relay puts the address on the last line, agent text must not forge another one, and a broken osascript must not be retried in a loop.
15. **Guard stops repeat while a guard stays tripped.** The warning is logged once per crossing, and each evaluation calls `stopAgents('runner_stop', { handoff: false })` again when no such call is in flight (Task 8). This refines X-41 and design 7.8/7.9 ("once per crossing"), and the outline's "the callback fires once": the warning is still once per crossing and each agent is stopped once, but the `stopAgents` call repeats while the guard stays tripped. Why: a failed call, a call before the handle exists, or a resume that skipped admission (M2b's `resume_attempt` does) would otherwise leave agents running below the threshold. Each agent is still stopped once, because a stopped controller holds no slot.
16. **Below 8% battery is always a hold too** (`percent < max(batteryDrainPercent, 8)`); the wake hold is clamped to `now + wakeHold` on each evaluation; the `disk_low` detail is the fixed text "free space below <minFreeGb> GB", and free space counts in decimal GB (Task 8). Why: a stop level must never admit; a backward clock step must not stretch the hold; a changing detail would send a persisted `runner.state` on every heartbeat.
17. **One order for holds and states.** `admit` refuses with `needs_login`, then `waking`, then `battery_low`, then `disk_low`; `state()` reports `crash_loop`, then `disk_low`, then `ok`. A hold with no end (battery or disk) goes out in the heartbeat's `acceptingUntil` as two heartbeat intervals and is renewed on each heartbeat; a wake hold goes out as the time left. Only power source `battery` (a UPS included) can be low: AC, an unknown source and a failed sample never hold, and unknown free space is not low (Task 8). Why: the hub needs a finite `acceptingUntil`, which design 7.8 and 7.9 leave open, and a sample that cannot be read must not stop work.
18. **`KeepAwake` reads `{ role, phase }` attempts**, spawns caffeinate with `Bun.spawn` in the runner's group (not through `Exec`), tracks a released child until it exits, and retries from 1 s doubling to 60 s (Task 9). Why: an idle lead must be told apart from a worker between turns, and a quick off and on must never run two assertions.

**Dependency preparation**
19. **Preparation runs in the runner process through one `PrepSandbox`**: `SandboxManager.initialize` once with the profile's domains, then `wrapWithSandboxArgv` per command with that run's whole policy as `customConfig`. The outline's earlier `agflow runner prep-exec` child is dropped (Tasks 11, 12, 16). A probe on this Mac (2026-10-28, sandbox-runtime 0.0.81, Bun 1.3.11) confirmed it, from source and from a compiled binary. Why: design 7.7 says so, and two per-call policies for two clones stayed separate.
20. **The global config is strict**: `strictAllowlist`, no local binding, a filesystem fallback that denies everything, and a run whose domains differ from the global ones is refused; one initialisation is shared per backend (Task 11). Why: the runtime is process-global, and its proxy filters against the global list only.
21. **Only known installs share the cache**: `bun install|i`, `npm ci|install|i` and `pnpm install|i|fetch`, run as a bare name or an absolute path, with scripts off (`sharesCache`). pip, uv, poetry, yarn, shells and every `"scripts": true` entry get per-attempt caches (Task 10). This refines design 7.7 and X-40. Why: those can run agent-edited code (build backends, `.yarn/releases`, pnpmfiles), which must never reach a cache that other clones read.
22. **Scripts are switched off through a runner-owned `XDG_CONFIG_HOME`** (`prep/<project>/config/{noscripts,scripts}`; the noscripts `.bunfig.toml` sets `ignoreScripts = true`), together with `npm_config_ignore_scripts`, `npm_config_ignore_pnpmfile` and `YARN_ENABLE_SCRIPTS=false` (Task 10). Why: Bun 1.3.11 ignores `npm_config_ignore_scripts`, and the setting also stops Bun reading the agent-writable `$HOME/.bunfig.toml`.
23. **The preparation environment is not a vendor's.** It drops `AGFLOW_*`, `CLAUDE_CODE_*`, `CODEX_*`, `CLAUDE_CONFIG_DIR`, `DISABLE_AUTOUPDATER`, `SSH_AUTH_SOCK` and `SSH_ASKPASS`; sets `npm_config_userconfig` and `PIP_CONFIG_FILE` to /dev/null, `npm_config_package_import_method=clone-or-copy` and `UV_LINK_MODE=clone`; and relies on Bun's macOS clonefile default (Task 10). Why: `HOME` is agent-writable, packages must be copies (design 7.7), and Bun 1.3.11 has no variable for its install backend.
24. **The policy denies reads of `work/*/*`** (each clone) instead of the work root (Task 10). Why: Bun's script runner reads the clone's parent directories and otherwise fails with `CouldntReadCurrentDirectory`; only project and attempt names become listable.
25. **No pip certificate option in the environment.** A project entry for pip 24.2 or newer passes `--use-deprecated=legacy-certs` itself (Tasks 10, 12). Why: pip 24.2+ on Python 3.10+ verifies TLS through macOS's trustd, which the sandbox denies; older pips exit 3 on `PIP_USE_DEPRECATED`; and allowing trustd (`enableWeakerNetworkIsolation`) would open an exfiltration path.
26. **Each run is spawned detached in the clone**; its group gets SIGKILL at the timeout and is killed after a normal exit too; its pipes get 1 s after the exit; the log tail is 16 KiB (Task 11). Why: nothing a preparation starts outlives it, and an escaped grandchild cannot hold the run open.
27. **`readPrepConfig` takes a full restore-base sha** and accepts only a regular blob of at most 1 MiB under a strict runner-local schema with normalised relative `when` paths; an empty `when` list runs once per attempt and entry; a `when` file over 64 MiB fails the preparation (Task 10). Why: core may not change, and a link, a directory or a huge file in the base must not steer or stall a preparation.
28. **The preparer reads the role and the restore set from the attempt record**, refuses a clone that is not a real directory, restores again before each entry that follows one that ran, removes package managers' user config files through M2b's `removeInClone`, runs every entry for an agent's request, stops at the first failure, and serialises one attempt's preparations (Task 12). Why: `PrepareInput` carries neither field; `restoreProtected` writes through a linked clone (Known behaviour 3); a command may plant config for the next one; and design 7.7 gives a request no condition.

**Retention**
29. **The sweep throttles itself through logs/retention.json**, stamped with the start time of the sweep, and the host asks every hour (`RETENTION.checkIntervalMs`); an aborted sweep keeps its consolidations and stays due (Tasks 13, 16). Why: a long consolidation must not push the sweep to every other day, and a restart must not add sweeps.
30. Transcripts once each removes the record too. A record ended over 14 days ago is eligible only when its clone is gone and lateWorkSha is null. Pending work keeps the record and its vendor-version reference, because the vault can still hold the work after its clone disappears.
31. **Vendor versions go only when no record names them and they are older than the running pin**; staging directories and files stay (Task 13). Why: a newer version installed ahead of an upgrade must not vanish before the pin moves.

**The service**
32. **Start order:** lock, log, run record, runner.json, machine check, control socket, credentials, runner.db, operations, a first power sample, `createRunner` (Tasks 14, 16). Why: only the lock holder writes files, every refusal is recorded, and the first admission already sees the battery.
33. **A link end or a refusal stops the agents without a handoff**, bounded by `timings.suspend`, and `killRegisteredGroups` runs on every exit as a backstop; an uncaught error skips the stop (Task 14). Why: `runner.close` leaves agents running, and under launchd nothing restarts this runner to recover them.
34. **A missing or invalid runner.json is also a refusal that needs a person**: recorded clean as the last exit, exit 0 under `--service` and 1 in the foreground (Task 14). Until Task 18, missing credentials are treated the same way. Design 7.1 and X-41 name only 4403, 4426 and a machine mismatch. Why: `KeepAlive` must not loop on a home that needs `agflow runner setup`.
35. **SIGINT also suspends under `--service`, and SIGHUP suspends a foreground runner** (Task 17). Both are plan-local: design 7.1 and X-41 name SIGINT for the foreground only, and SIGHUP not at all. Why: a SIGINT to the service is as much a request to end as a SIGTERM, and closing a terminal tab hangs up the runner, while its agents run in their own sessions.
36. **The CLI loads runner modules only inside a subcommand**, through dynamic imports (Tasks 15, 19-25). Why: the hooks Claude Code and Codex run on every prompt loaded 68 runner modules before; now they load none.
37. **needs_login does not await its notification.** Under `--service`, missing or unreadable credentials put the service in needs_login while it holds the lock and the socket and reads the file again every `loginProbe`; the foreground refuses an unreadable file with exit 1 (Task 18). Why: a slow osascript must not use up the WIP grace, and `KeepAlive` must not loop.
38. **Drain and undrain try the socket first**; only an unavailable socket allows the offline edit under the lock. While the service waits for credentials, its own routes edit runner.json; undrain also cancels the pending self-drain (Task 19). Why: a running service owns runner.json.
39. **The crash-loop guard runs before `createRunner`**, so the first hello already says `crash_loop`, and its mark keeps `crash_loop` through clean runs until undrain (Tasks 5, 19). Why: design 7.1 keeps it "until `agflow runner undrain`".

**The LaunchAgent and the commands**
40. **The plist has no `RunAtLoad`** (`KeepAlive { SuccessfulExit: false }` implies it), sorted environment keys, and `AGFLOW_HOME` and `AGFLOW_CONFIG_DIR` only when they are set; nothing else comes from the installing shell (Task 20). Why: the plist holds exactly the keys design 7.1 lists.
41. **`installRefusal` refuses when either `AGFLOW_TEST=1` or a test block is present**, unlike `isTestMode`, which needs both (Task 20). Why: a test runner.json must never become a login item.
42. **Install waits for a service lock holder** (up to 90 s) and for `launchctl print` to show the old job gone before it enables and bootstraps; bootout is bounded by 75 s and kickstart by 120 s (Tasks 20, 24). Why: launchd holds back a job that started recently for about a minute, which `verify:service` found.
43. The status report is a union on running, with flat pid, pgid and lstart and lateWorkSha per attempt. Kept clones are ended/stopped records with an existing clone and a pushError or pending lateWorkSha. Outside test mode the Login Items warning names both runner stop and the Login Items switch; test mode never queries launchd.
44. **The WIP probe is a parentless empty commit** with a fixed agflow identity, pushed with an exact lease and removed with a fenced delete under the vault lock, after any leftover probe is deleted (Task 22). Why: it works on an empty vault without the owner's identity, and it never moves a ref someone else holds.
45. **Setup writes nothing before the sign-in passes.** It writes runner.json under the lock without waiting, leaves a running runner's runner.json alone, and treats another Mac's runner.json like a fresh setup: a new key, this Mac's name and capacity 2. It keeps an existing subscription login in a runner home and runs that vendor's login only when the status check fails or `--relogin` is given; design 7.1 steps 4 and 5 always run the logins (Task 23). Why: a copied runner.json names another live runner, and a re-run of setup must not ask the owner to log in again.
46. **The stop's drain is temporary.** After `runner stop`, runner.json gets `draining: false` back unless the owner had drained the runner before (Task 24). This is plan-local: design 7.1 does not say. Why: a later `start` or `install` must take work again.
47. **`stopRunner` waits only for the pid that `GET /health` named**, for at most `stopWaitMs`, and disables an installed plist that is not loaded; `restartRunner` refuses without a loaded service (Task 24). Why: a LaunchAgent waiting behind a stopped foreground runner is left to bootout instead of a 10-minute stall. Under AGFLOW_TEST=1, stop performs only the socket stop and lock wait and reports bootedOut:false, disabled:false; restart refuses before any socket suspension or launchctl call.
48. **Uninstall's purge refuses with unpushed work or with unacknowledged events**, before any logout or retirement (Task 25). A runner.json from another Mac is not retired, and a failed retirement under `--purge` keeps every directory. The logouts use the pinned binary, or the newest installed version when the pin moved; with none installed, uninstall says the logout could not run and that Claude's login stays in the login keychain. Why: runner.db is the only copy of the exits the hub has not heard of, and retiring another Mac's live runner would end its work. Purge reads lateWorkSha, retained-clone errors and live or unfinalized worker clone/WIP state independently of event retention. An unresolved error with a retained clone blocks purge even when no SHA was harvested. The worker guard includes `finalizedAt === null` regardless of stopped state, preserving work after recovery. Uninstall leaves launchd and its plist untouched under AGFLOW_TEST=1.

### Known behaviour and open points

1. Durable late work. M2b records lateWorkSha before reporting pending final work, resumes retries at the first welcome after startup, and clears it after a late push or cleanup/hand-back resolution. Task 25 reads the marker even without a clone, and Task 13 preserves marked records. No outbox history is required to detect that pending SHA. A null marker alone does not establish purge safety: harvesting may have failed before producing a SHA, or recovery may have stopped an attempt without finalizing it.
2. Unchanged final work. With no work since the start, finalWip is null and finalSha is the start sha. With no new tree since the last WIP push, finalWip names that push. Both leave no lateWorkSha; stale unequal WIP shas after completed finalization do not imply pending work. A stopped state alone cannot establish that finalization completed. `AttemptRecord.finalizedAt` supplies durable completion; the normal failed-start recovery regression verifies that a recovered stopped worker remains protected with a null marker.
3. **M2b's `restoreProtected` expects a real directory.** It resolves a link at the clone path and writes in the target; M2b documents this as a caller contract, which its controller meets with `assertCloneDirectory`. The preparer checks first and refuses a clone that is not a real directory.
4. **Bun's CouldntReadCurrentDirectory under a policy that denies the work root.** Denying the whole work root prevents Bun package scripts from resolving their project parents. M2c's preparation policy and M2d's Claude policy deny individual attempts with work/*/* instead. M2d Task 29 checks successful Bun package-script execution and denied reads of sibling clones. No M2d fix remains queued.
5. **`resume_attempt` and ladder step 1 skip `health.admit`.** A guard stops such a resume at its next evaluation, within a heartbeat or a power sample (refinement 15); the hub could also respect the battery hold for resumes.
6. **A final push still running at the suspend deadline** keeps running until the process exits. The hub then sees the attempt stopped with its clone and resumes it.
7. **osascript notifications from a LaunchAgent** may be dropped silently until the owner allows them; no test can check this.
8. **`verify:service` leaves an `enabled` entry** for each scratch label in launchd's disabled-services database. launchctl cannot remove it, and it does no harm.
9. Linux verification at c8fef4c0 (Ubuntu: 2642 pass, 27 macOS-only skips, 1 fail in M2b's controller-stop test, a 200 ms timing race that passes alone). The macOS full suite at the same head passed 2668 tests with 2 skips and 0 failures, including the process-identity tests that need ps. Fake service starts inject fixtureCliVersion and fake operations select the darwin-arm64 retention pin table; production uses native pinned versions.
10. **Design text to update when the plans land:** SIGINT suspends under `--service` too, and SIGHUP suspends a foreground runner (7.1; refinement 35); a missing or invalid runner.json is a refusal that needs a person (7.1; refinement 34); setup keeps an existing subscription login unless `--relogin` (7.1 steps 4 and 5; refinement 45); the stop's drain is restored afterwards (7.1; refinement 46); guard stops repeat while a guard stays tripped, which refines X-41's "once per crossing", and 8% battery is also a hold (7.8, 7.9; refinements 15, 16); an open-ended hold goes out as two heartbeat intervals (7.8, 7.9; refinement 17); the shared cache only for known installs, scripts off through `XDG_CONFIG_HOME`, the `work/*/*` read deny, and pip's `legacy-certs` (7.7; refinements 21-25); retention removes old ended attempt records (7.8; refinement 30); and the purge also waits for unacknowledged events (7.1; refinement 48). Test-mode status/stop/restart/uninstall make no launchctl call or plist access; retention preserves pending late-work records even after the clone is gone; final-work purge checks use the durable late-work marker and retained-clone errors. The design must also require durable finalization completion rather than inferring it from stopped state; M2b and Task 25 now implement that contract.
11. **Slow tests under load.** M2b's controller, runtime, vault and integration tests, core's protected-paths timing test and testkit's fake-adapter failures test have each timed out once in a full run on a heavily loaded Mac; each passes when its file runs alone. Once, a run of the CLI and service tests (`bun test packages/cli packages/runner/test/service`) had 2 failures that could not be identified and did not recur in 5 more runs or in the full suite; a load-sensitive timing in the service tests is the likely cause.
12. Test-mode command isolation. runnerCommand, stopRunner and uninstallRunner use their injected env, defaulting to process.env. With AGFLOW_TEST='1', status, stop, restart and uninstall make no launchctl call and never touch the installed plist. Offline status reports disabled:null and plistInstalled:false; running status adds no Login Items warning. Stop returns bootedOut:false and disabled:false after its normal socket shutdown; restart reports that no service is loaded. M2g stops runners with SIGTERM.


## Conventions for every task

- The plan targets macOS on Apple silicon (darwin-arm64), where it was checked, with git 2.50 and the system `launchctl`, `plutil`, `pmset`, `ioreg`, `scutil`, `caffeinate`, `osascript`, `du`, `tar`, `ps` and `lsof`. Tests that need a real macOS tool or the real sandbox runtime skip elsewhere (Known behaviour 9).
- Start on a new branch from `1a0804110b5e189dea851be2306fcadc638909f4`, the end of M2b on `m2b-runner` (not on `main`, `m2b-runner` or the prototype's `m2c-ops`), and run `bun install --frozen-lockfile` once.
- A `(new)` block is the whole file. A `(change)` block is a unified diff: save it to a file and run `git apply <file>` from the repository root. Apply the blocks in the order shown, step 1's test files and then step 3's code, and the tasks in order. Files under `test/` folders (fixtures and helpers included) come with step 1.
- Run all commands from the repository root. Use Bun only; Node on this machine is v16.
- Edit only this plan's files. In `packages/runner` the one M2b file it changes is `packages/runner/src/vendor/pins.ts`. In `packages/cli` it adds `runner-command.ts`, `runner-setup.ts` and `runner-uninstall.ts`, and edits `main.ts` (HELP and the command table) and `hub-client.ts` (`runnerWhoami`, `retireRunner`), which M2b also edits, as well as `packages/cli/package.json` and the root `bun.lock` (which M2b also changes); these shared files are where a rebase onto M2b's final head can conflict. The runner barrel (`packages/runner/src/index.ts`), the controller, the executor, `config.ts`, `db.ts` and `runner.ts` stay M2b's, and the hub does not change. The CLI imports the runner by deep path, and the runner never imports the CLI.
- Every macOS command goes through an injected `Exec`. Tests never install a LaunchAgent in `~/Library/LaunchAgents`, never call launchctl on the real `gui/<uid>` domain, never write the real `~/.agflow`, never post a notification, and never start caffeinate or the sandbox runtime from a service test: they use scratch homes, a recording `Exec` and `fakeServiceOperations`.
- Test homes live under short roots (`/tmp/agf-*`), because macOS limits Unix socket paths to 104 bytes. A test that deletes a runner home after an attempt ran uses `setupTestService`, `startTestService` or M2b's fixtures, which remove the read-only agent tools directories first.
- No secret on disk or on the socket: runner.json is mode 0600 with no token, and the control socket answers no credential, token or attempt spec.
- No step sends a prompt to a real model. Vendor CLIs in tests are fake shell scripts; real logins happen only when a person runs `agflow runner setup`.
- Never run tests through git (no `rebase --exec`, no hooks), and never export `GIT_DIR`, `GIT_WORK_TREE` or `GIT_INDEX_FILE`. `scripts/test-preload.ts` drops `GIT_*` variables for `bun test`.
- Every task requires targeted tests and `bun run typecheck`; the coordinator runs the full `bun test` outside the sandbox. A base-plan failure is reported with ownership, not fixed in this plan. The whole suite takes about fifteen minutes on this machine, longer under load. If a test times out in a full run (Known behaviour 11), run its file alone before you debug it, and never loosen a test to make it pass.
- An implementer in a sandbox cannot run `ps` or a nested `sandbox-exec` there: report required outside test commands to the coordinator. Run typecheck locally. Never install a real LaunchAgent, call launchctl on the real user domain, send a real-model prompt or use the owner's vendor homes or credentials in this run; do not execute `verify:service` here.
- The coordinator commits each task with the shown `M2C Task <n>: <title>` subject; do not run Git writes inside this sandbox. The generated examples include the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` as a second `-m`. The repository's git identity is preconfigured; do not change it.

## File structure

```
packages/cli/package.json                     depends on @agflow/runner (Task 15)
bun.lock                                      the CLI's new workspace dependency (Task 15)
packages/cli/src/
  main.ts                                     the runner command, and RUNNER_HELP under "Runners:" in HELP
  hub-client.ts                               runnerWhoami (GET /api/runner/whoami) and retireRunner
  runner-command.ts                           agflow runner: the subcommands and RUNNER_HELP
  runner-setup.ts                             runnerSetup and Prompt: the interactive setup
  runner-uninstall.ts                         uninstallRunner and unpushedWork
packages/cli/test/
  runner-command.test.ts                      every runner subcommand through the CLI
  run-runner-start.ts                         a child process running agflow runner start, for the signal tests
  runner-setup.test.ts, runner-uninstall.test.ts
packages/runner/src/vendor/
  pins.ts                                     (M2b's) gains integrity, Claude's sha256 and the Codex tree
  login.ts                                    login status, logins and logouts with the runner's pinned CLIs and homes
  install.ts                                  downloads, verifies and installs the pinned binaries
packages/runner/src/service/
  system.ts                                   Exec and defaultExec
  machine.ts                                  machine id, computer name, login-shell capture, git identity, homes, machineMismatch
  runner-json.ts                              newRunnerKey and createRunnerConfig
  credentials.ts                              readCliCredentials
  lock.ts                                     runner.lock: flock through bun:ffi, readLockOwner
  control.ts                                  runner.sock: the control server and controlRequest
  log.ts                                      RotatingLog, tailLines, the launchd log files
  runs.ts                                     ServiceRuns (logs/service-runs.json) and crashLoopVerdict
  notify.ts                                   createMacNotifier
  host.ts                                     startRunnerService: the service process, its routes and its one exit path
  suspend.ts                                  suspendRunner
  needs-login.ts                              NeedsLogin: the service's side effects of needs_login
  drain.ts                                    drainRunner, undrainRunner and applyCrashLoopGuard
  launchd.ts                                  the plist, installService and the launchctl calls
  status.ts                                   RunnerStatusReport, offlineStatus and formatStatus
  checks.ts                                   runServiceChecks and formatChecks
  stop.ts                                     drainAndStopAgents, stopRunner and restartRunner
packages/runner/src/ops/
  power.ts                                    pmset parsers and samplePower
  disk.ts                                     diskFreeBytes and AgflowUsage
  health.ts                                   createServiceHealth: holds, refusals and guard stops
  keep-awake.ts                               KeepAwake
  retention.ts                                sweepRetention and RETENTION
packages/runner/src/prep/
  config.ts                                   PrepConfigSchema and readPrepConfig
  plan.ts                                     when-fingerprints, PrepState, prepEnv, prepPolicy and the tool config
  sandbox.ts                                  PrepSandbox and checkPrepSandbox
  preparer.ts                                 createDependencyPreparer
packages/runner/scripts/
  vendor-install.ts                           bun run vendor:install
  verify-prep.ts                              bun run verify:prep
  verify-service.ts                           bun run verify:service
packages/runner/test/
  service-helpers.ts                          recordingExec, fakeVendorCli, localRegistry, packTarball, setupTestService,
                                              startTestService, startOriginHub and the fake operations and adapters
  service/run-service.ts                      a child process running the service, for the signal and exit tests
  service/machine.test.ts, runner-json.test.ts, credentials.test.ts, lock.test.ts, control.test.ts, log.test.ts,
  runs.test.ts, notify.test.ts                the service's building blocks
  service/host.test.ts, operations.test.ts, suspend.test.ts, needs-login.test.ts, drain.test.ts
                                              the service against the in-process hub
  service/launchd.test.ts, status.test.ts, checks.test.ts, stop.test.ts
                                              the LaunchAgent and the commands that run in the service
  vendor/login.test.ts, vendor/install.test.ts
                                              logins and the installer
  ops/power.test.ts, disk.test.ts, health.test.ts, keep-awake.test.ts, retention.test.ts
                                              operations
  prep/config.test.ts, plan.test.ts, sandbox.test.ts, preparer.test.ts
                                              dependency preparation
```

---

### Task 1: Machine facts, CLI credentials and the initial runner.json

Setup's configuration step (design 7.1 step 2) as plain functions that setup and M2g's harness share (X-42). `service/system.ts` defines `Exec`, the one way M2c runs a command: stdin closed, a timeout that kills, and exit code 127 instead of a throw when a command cannot start. `machine.ts` reads the Mac's `IOPlatformUUID` and computer name, captures the owner's login-shell `PATH` and connectivity variables, reads the git identity, makes canonical vendor homes and checks the machine binding. `runner-json.ts` builds a new runner.json over M2b's `RunnerConfigSchema` with a fresh `rk_` key and any override, and `credentials.ts` is the runner's own reader of the CLI's credentials.json, parsed with core's `CredentialsSchema` (design 13, X-8).

**Files:**
- Create: `packages/runner/src/service/credentials.ts`
- Create: `packages/runner/src/service/machine.ts`
- Create: `packages/runner/src/service/runner-json.ts`
- Create: `packages/runner/src/service/system.ts`
- Test: `packages/runner/test/service-helpers.ts`
- Test: `packages/runner/test/service/credentials.test.ts`
- Test: `packages/runner/test/service/machine.test.ts`
- Test: `packages/runner/test/service/runner-json.test.ts`

- [ ] **Step 1: Write the failing tests**

**File:** `packages/runner/test/service-helpers.ts` (new)

```ts
// Shared service test helpers: recorded commands now, with vendor and service fixtures added by tasks 2 and 3.
import type { Exec, ExecOptions, ExecResult } from '../src/service/system';

export interface ExecCall {
  argv: string[];
  options?: ExecOptions;
}

/** Scripted command outputs, with every invocation retained for assertions. */
export function recordingExec(
  scripts: { argv: string[]; result: Partial<ExecResult> }[] = [],
  fallback: Partial<ExecResult> = {},
): Exec & { calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const exec: Exec = async (argv, options) => {
    calls.push(structuredClone({ argv, options }));
    const result = scripts.find((script) => Bun.deepEquals(script.argv, argv))?.result ?? fallback;
    return { exitCode: 0, stdout: '', stderr: '', timedOut: false, ...result };
  };
  return Object.assign(exec, { calls });
}
```

**File:** `packages/runner/test/service/credentials.test.ts` (new)

```ts
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CREDENTIALS_FILE, CredentialsSchema } from '@agflow/core';
import { readCliCredentials } from '../../src/service/credentials';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function directory(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agf-creds-'));
  dirs.push(dir);
  return dir;
}

describe('readCliCredentials', () => {
  test('parses with the core schema and rereads the file after login', () => {
    const dir = directory();
    const credentials = { hubUrl: 'http://localhost:9000', token: 'test-token', user: 'owner', future: true };
    writeFileSync(join(dir, CREDENTIALS_FILE), JSON.stringify(credentials));
    expect(readCliCredentials(dir)).toEqual(CredentialsSchema.parse(credentials));
    credentials.token = 'new-test-token';
    writeFileSync(join(dir, CREDENTIALS_FILE), JSON.stringify(credentials));
    expect(readCliCredentials(dir)?.token).toBe('new-test-token');
  });

  test('returns null for a missing file and names unreadable files', () => {
    const dir = directory();
    expect(readCliCredentials(dir)).toBeNull();
    expect(readCliCredentials(join(dir, 'absent'))).toBeNull();
    mkdirSync(join(dir, CREDENTIALS_FILE));
    expect(() => readCliCredentials(dir)).toThrow(`cannot read ${join(dir, CREDENTIALS_FILE)}`);
  });

  test.each(['{}', 'null', '{"hubUrl":"hub","token":"","user":"owner"}'])(
    'treats invalid credentials as signed out: %s',
    (content) => {
      const dir = directory();
      writeFileSync(join(dir, CREDENTIALS_FILE), content);
      expect(readCliCredentials(dir)).toBeNull();
    },
  );

  test('names a file that is not valid JSON', () => {
    const dir = directory();
    const path = join(dir, CREDENTIALS_FILE);
    writeFileSync(path, '{ broken');
    expect(() => readCliCredentials(dir)).toThrow(`${path} is not valid JSON; run agflow login`);
  });
});
```

**File:** `packages/runner/test/service/machine.test.ts` (new)

```ts
import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONNECTIVITY_VARS } from '../../src/config';
import { agflowHome, runnerPaths } from '../../src/paths';
import {
  canonicalHome,
  captureLoginShellEnv,
  machineMismatch,
  parseIoregPlatformUuid,
  readComputerName,
  readGitIdentity,
  readMachineId,
} from '../../src/service/machine';
import { defaultExec } from '../../src/service/system';
import { recordingExec } from '../service-helpers';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agf-machine-'));
  dirs.push(dir);
  return dir;
}
function shell(body: string): string {
  const path = join(scratch(), 'shell');
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
  return path;
}

const uuid = 'A28F9E10-1234-5678-ABCD-0123456789AB';
const ioreg =
  '+-o MacBookPro18,3  <class IOPlatformExpertDevice, id 0x100000100, registered, matched, ' +
  `active, busy 0 (0 ms), retain 42>
    {
      "IOPlatformSerialNumber" = "TESTSERIAL"
      "IOPlatformUUID" = "${uuid}"
      "model" = <"MacBookPro18,3">
    }
`;

describe('machine facts', () => {
  test('parses a recorded ioreg UUID and refuses missing or malformed UUIDs', () => {
    expect(parseIoregPlatformUuid(ioreg)).toBe(uuid);
    expect(() => parseIoregPlatformUuid('no UUID')).toThrow('IOPlatformUUID');
    expect(() => parseIoregPlatformUuid('"IOPlatformUUID" = ""')).toThrow('IOPlatformUUID');
  });

  test('reads ioreg on macOS and a trimmed machine-id file elsewhere', async () => {
    const exec = recordingExec([
      { argv: ['ioreg', '-rd1', '-c', 'IOPlatformExpertDevice'], result: { stdout: ioreg } },
    ]);
    expect(await readMachineId({ platform: 'darwin', exec })).toBe(uuid);
    expect(exec.calls.map((call) => call.argv)).toEqual([['ioreg', '-rd1', '-c', 'IOPlatformExpertDevice']]);
    const file = join(scratch(), 'machine-id');
    writeFileSync(file, '0123456789abcdef0123456789abcdef\n');
    expect(await readMachineId({ platform: 'linux', machineIdFile: file, exec })).toBe(
      '0123456789abcdef0123456789abcdef',
    );
    expect(exec.calls).toHaveLength(1);
    writeFileSync(file, '\n');
    await expect(readMachineId({ platform: 'linux', machineIdFile: file })).rejects.toThrow(file);
  });

  test('reports a failed ioreg instead of binding an empty machine identity', async () => {
    await expect(
      readMachineId({ platform: 'darwin', exec: recordingExec([], { exitCode: 127, stderr: 'missing' }) }),
    ).rejects.toThrow('ioreg');
  });

  test('uses ComputerName and falls back to hostname on failure or empty output', async () => {
    const exec = recordingExec([], { stdout: '  Owner’s Mac\n' });
    expect(await readComputerName(exec)).toBe('Owner’s Mac');
    expect(exec.calls[0].argv).toEqual(['scutil', '--get', 'ComputerName']);
    for (const result of [{ exitCode: 1 }, { stdout: '\n' }, { timedOut: true, stdout: 'partial' }]) {
      expect(await readComputerName(recordingExec([], result))).toBe(hostname());
    }
  });

  test('reads both global git identity fields and returns null when either is unset', async () => {
    const exec = recordingExec(
      [
        { argv: ['git', 'config', '--global', 'user.name'], result: { stdout: 'Owner Name\n' } },
        { argv: ['git', 'config', '--global', 'user.email'], result: { stdout: 'owner@example.test\n' } },
      ],
      { exitCode: 1 },
    );
    expect(await readGitIdentity(exec)).toEqual({ name: 'Owner Name', email: 'owner@example.test' });
    expect(exec.calls.map((call) => call.argv)).toEqual([
      ['git', 'config', '--global', 'user.name'],
      ['git', 'config', '--global', 'user.email'],
    ]);
    for (const missing of ['user.name', 'user.email']) {
      expect(
        await readGitIdentity(
          recordingExec(
            [{ argv: ['git', 'config', '--global', missing], result: { exitCode: 1 } }],
            { stdout: 'present\n' },
          ),
        ),
      ).toBeNull();
    }
    expect(await readGitIdentity(recordingExec([], { stdout: '\n' }))).toBeNull();
  });

  test('creates private canonical vendor homes through a symlinked AGFLOW_HOME', () => {
    const root = scratch();
    mkdirSync(join(root, 'real'));
    symlinkSync(join(root, 'real'), join(root, 'link'));
    const paths = runnerPaths(agflowHome({ AGFLOW_HOME: join(root, 'link') }));
    for (const path of Object.values(paths.homes)) {
      const home = canonicalHome(`${path}/`);
      expect(home).toBe(realpathSync(path));
      expect(home.endsWith('/')).toBe(false);
      expect(statSync(home).mode & 0o777).toBe(0o700);
      chmodSync(home, 0o755);
      expect(canonicalHome(path)).toBe(home);
      expect(statSync(home).mode & 0o777).toBe(0o700);
    }
  });

  test('refuses a runner.json from another machine with the setup instruction', () => {
    expect(machineMismatch({ machineId: uuid }, uuid)).toBeNull();
    expect(machineMismatch({ machineId: uuid }, 'another')).toBe(
      'this runner.json belongs to another Mac; run agflow runner setup',
    );
  });
});

describe('captureLoginShellEnv', () => {
  test('captures only PATH and allowed connectivity, preserving values inside markers', async () => {
    const fake = shell(`
if read -r input; then exit 9; fi
printf 'profile noise PATH=wrong\\n'
export PATH=':./bin:node_modules/.bin:/login/bin::/usr/bin:.:/login/bin'
unset ALL_PROXY
export NO_PROXY=''
export HTTPS_PROXY='http://proxy.test/?a=b'
export SSL_CERT_FILE='cert path
second line'
/bin/sh -c "$4"
printf '\\nlogout noise PATH=wrong\\n'
`);
    const connectivity = Object.fromEntries(CONNECTIVITY_VARS.map((name) => [name, `value-${name}`]));
    const env = {
      ...connectivity,
      SHELL: fake,
      PATH: '/original/bin',
      OPENAI_API_KEY: 'secret',
      AGFLOW_TOKEN: 'secret',
    };
    const calls = recordingExec();
    const captured = await captureLoginShellEnv({
      env,
      exec: async (argv, options) => {
        await calls(argv, options);
        return defaultExec(argv, options);
      },
    });
    const { ALL_PROXY: _unset, ...remaining } = connectivity;
    expect(captured.connectivity).not.toHaveProperty('ALL_PROXY');
    expect(captured.connectivity).toHaveProperty('NO_PROXY', '');
    expect(captured).toStrictEqual({
      path: '/login/bin:/usr/bin',
      connectivity: {
        ...remaining,
        NO_PROXY: '',
        HTTPS_PROXY: 'http://proxy.test/?a=b',
        SSL_CERT_FILE: 'cert path\nsecond line',
      },
    });
    expect(calls.calls[0].argv.slice(0, 4)).toEqual([fake, '-l', '-i', '-c']);
    expect(calls.calls[0].options).toMatchObject({ env, cwd: homedir(), timeoutMs: 10_000 });
    expect(calls.calls[0].options?.interactive).not.toBe(true);
  });

  test('uses /bin/zsh when SHELL is unset and falls back on malformed capture', async () => {
    const exec = recordingExec([], { stdout: 'noise only' });
    expect(
      await captureLoginShellEnv({ env: { PATH: '/fallback', ALL_PROXY: 'proxy', TOKEN: 'secret' }, exec }),
    ).toEqual({ path: '/fallback', connectivity: { ALL_PROXY: 'proxy' } });
    expect(exec.calls[0].argv.slice(0, 4)).toEqual(['/bin/zsh', '-l', '-i', '-c']);
    expect(await captureLoginShellEnv({ env: { ALL_PROXY: 'proxy' }, exec })).toEqual({
      path: '/usr/bin:/bin:/usr/sbin:/sbin',
      connectivity: { ALL_PROXY: 'proxy' },
    });
  });

  test.each([
    [':./bin:node_modules/.bin:/login/bin::/usr/bin:.:/login/bin', '/login/bin:/usr/bin'],
    [':.:./bin:node_modules/.bin', '/usr/bin:/bin:/usr/sbin:/sbin'],
  ])('filters fallback PATH %s', async (path, expected) => {
    expect(await captureLoginShellEnv({ env: { PATH: path }, exec: recordingExec() })).toEqual({
      path: expected,
      connectivity: {},
    });
  });

  test('uses the default for an all-relative captured PATH and runs the shell in HOME', async () => {
    const home = realpathSync(scratch());
    const fake = shell(`
export PATH=':.:./bin'
export SSL_CERT_DIR="$(pwd)"
/bin/sh -c "$4"
`);
    expect(await captureLoginShellEnv({ env: { HOME: home, SHELL: fake, PATH: '/caller/bin' } })).toStrictEqual({
      path: '/usr/bin:/bin:/usr/sbin:/sbin',
      connectivity: { SSL_CERT_DIR: home },
    });
  }, 20_000);

  test('falls back to the given environment when the shell fails, is missing or times out', async () => {
    const failed = shell('export PATH=/failed-shell; eval "$4"; exit 3');
    const missing = join(scratch(), 'missing');
    const hanging = shell('exec /bin/sleep 30');
    for (const fake of [failed, missing, hanging]) {
      expect(
        await captureLoginShellEnv({
          env: { SHELL: fake, PATH: '/fallback', HTTP_PROXY: 'proxy', TOKEN: 'secret' },
          timeoutMs: fake === hanging ? 50 : 5_000,
          exec: async (argv, options) => {
            const result = await defaultExec(argv, options);
            if (fake === failed) {
              expect(result).toMatchObject({ timedOut: false, exitCode: 3 });
              expect(result.stdout).toContain('PATH=/failed-shell');
              expect(result.stdout).toContain('AGFLOW_ENV_END_');
            }
            return result;
          },
        }),
      ).toEqual({ path: '/fallback', connectivity: { HTTP_PROXY: 'proxy' } });
    }
  }, 20_000);
});

describe('defaultExec', () => {
  test('closes stdin, captures both streams, and applies cwd and the whole environment', async () => {
    const cwd = realpathSync(scratch());
    const script = [
      'read -r input && exit 9',
      'printf "%s|%s|%s" "$PWD" "$CUSTOM" "${HOME-unset}"',
      'printf error >&2',
      'exit 7',
    ].join('\n');
    const result = await defaultExec(['/bin/sh', '-c', script], { cwd, env: { CUSTOM: 'value' } });
    expect(result).toEqual({ exitCode: 7, stdout: `${cwd}|value|unset`, stderr: 'error', timedOut: false });
  });

  test('returns 127 for a missing executable and kills a timed-out command', async () => {
    const missing = await defaultExec([join(scratch(), 'missing')]);
    expect(missing.exitCode).toBe(127);
    expect(missing.stderr.length).toBeGreaterThan(0);
    expect(missing.timedOut).toBe(false);
    const timeout = await defaultExec(['/bin/sleep', '30'], { timeoutMs: 50 });
    expect(timeout.timedOut).toBe(true);
    expect(timeout.exitCode).not.toBe(0);
  });

  test('interactive commands return empty captured streams', async () => {
    expect(await defaultExec(['/usr/bin/true'], { interactive: true })).toEqual({
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
    });
  });

  test('a timeout does not wait for a shell child still holding the output pipes', async () => {
    const started = Date.now();
    const result = await defaultExec(['/bin/sh', '-c', 'printf started; /bin/sleep 2; printf late'], {
      timeoutMs: 100,
    });
    expect(result).toMatchObject({ timedOut: true, stdout: 'started' });
    expect(Date.now() - started).toBeLessThan(1_500);
  });
});
```

**File:** `packages/runner/test/service/runner-json.test.ts` (new)

```ts
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRunnerConfig, type RunnerConfigInput, RunnerConfigSchema, saveRunnerConfig } from '../../src/config';
import { runnerPaths } from '../../src/paths';
import { canonicalHome } from '../../src/service/machine';
import { createRunnerConfig, newRunnerKey, type RunnerFacts } from '../../src/service/runner-json';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const facts: RunnerFacts = {
  machineId: 'MACHINE-1',
  name: 'Owner’s Mac',
  capturedPath: '/owner/bin:/usr/bin',
  connectivity: { HTTPS_PROXY: 'http://localhost:9000' },
  commitIdentity: { name: 'Owner', email: 'owner@example.test' },
  homes: { claude: '/runner/homes/claude', codex: '/runner/homes/codex' },
};

describe('createRunnerConfig', () => {
  test('uses facts, generates a fresh key and leaves other fields to the schema defaults', () => {
    expect(newRunnerKey()).toMatch(/^rk_[0-9a-f]{32}$/);
    const config = createRunnerConfig(facts);
    expect(config.runnerKey).toMatch(/^rk_[0-9a-f]{32}$/);
    expect(createRunnerConfig(facts).runnerKey).not.toBe(config.runnerKey);
    expect(config).toEqual(RunnerConfigSchema.parse({ ...facts, runnerKey: config.runnerKey }));
    expect(config).toMatchObject(facts);
    expect(createRunnerConfig({ ...facts, commitIdentity: null }).commitIdentity).toEqual({
      name: 'agflow agent',
      email: 'agent@agflow.invalid',
    });
  });

  test('accepts schema input overrides for the harness, including nested defaults and a retained key', () => {
    const overrides: Partial<RunnerConfigInput> = {
      runnerKey: 'rk_retained',
      machineId: 'MACHINE-2',
      name: 'harness',
      minFreeGb: 1,
      capacity: 1,
      keepAwake: 'off',
      timings: { heartbeat: 10 },
      test: { allowShortTimings: true },
      capturedPath: '/harness/bin',
      connectivity: {},
      commitIdentity: { name: 'Test', email: 'test@example.test' },
      homes: { claude: '/test/claude', codex: '/test/codex' },
    };
    const config = createRunnerConfig(facts, overrides);
    expect(config).toMatchObject(overrides);
    expect(config.confirmedSettings.capacity).toBe(1);
    expect(config.timings.deadLink).toBe(45_000);
    expect(config.test?.skipAuthChecks).toBe(false);
    // A complete config is also a valid override; no field is selected out by the builder.
    expect(createRunnerConfig(facts, config)).toEqual(config);
  });

  test('invalid overrides name the field, including unknown credential fields', () => {
    expect(() => createRunnerConfig(facts, { capacity: 0 })).toThrow('runner.json: capacity:');
    expect(() => createRunnerConfig(facts, { timings: { heartbeat: -1 } })).toThrow('runner.json: timings.heartbeat:');
    expect(() => createRunnerConfig(facts, { token: 'secret' } as Partial<RunnerConfigInput>)).toThrow(
      'runner.json: token:',
    );
  });

  test.each(['claude', 'codex'] as const)(
    'refuses symlinked %s homes, including missing descendants',
    (vendor) => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'agf-json-')));
      dirs.push(root);
      const real = join(root, 'real');
      const link = join(root, 'link');
      mkdirSync(real);
      symlinkSync(real, link);
      for (const suffix of ['', 'not/created']) {
        const home = join(link, suffix);
        const homes = { ...facts.homes, [vendor]: home };
        const message = `runner.json: homes.${vendor}: must be a real path (${join(real, suffix)})`;
        expect(() => createRunnerConfig({ ...facts, homes })).toThrow(message);
        expect(() => createRunnerConfig(facts, { homes })).toThrow(message);
        expect(createRunnerConfig(facts, { homes: { [vendor]: join(real, suffix) } }).homes[vendor]).toBe(join(real, suffix));
      }
      expect(createRunnerConfig(facts, { homes: { [vendor]: null } }).homes[vendor]).toBeNull();
    },
  );

  test('writes canonical homes and a secret-free runner.json at mode 0600 using saveRunnerConfig', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agf-json-'));
    dirs.push(dir);
    const paths = runnerPaths(dir);
    const homes = { claude: canonicalHome(paths.homes.claude), codex: canonicalHome(paths.homes.codex) };
    canonicalHome(paths.homes.codexUser);
    const config = createRunnerConfig({ ...facts, homes });
    saveRunnerConfig(paths.config, config);
    expect(statSync(paths.config).mode & 0o777).toBe(0o600);
    expect(loadRunnerConfig(paths.config, {})).toEqual(config);
    const written = readFileSync(paths.config, 'utf8');
    expect(written).not.toMatch(/"[^"\n]*(?:token|credential)[^"\n]*"\s*:/i);
    expect(written.endsWith('\n')).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `bun test packages/runner/test/service/machine.test.ts packages/runner/test/service/runner-json.test.ts packages/runner/test/service/credentials.test.ts`
Expected: FAIL — `error: Cannot find module '../../src/service/machine' from 'packages/runner/test/service/runner-json.test.ts'`; `machine.test.ts` fails the same way, and `credentials.test.ts` on `'../../src/service/credentials'` (0 pass, 3 fail, 3 errors)

- [ ] **Step 3: Implement**

**File:** `packages/runner/src/service/credentials.ts` (new)

```ts
// CLI credentials for the runner (design 7.1 and 13): share core's schema without importing the CLI package.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CREDENTIALS_FILE, type Credentials, CredentialsSchema } from '@agflow/core';

/**
 * Re-read on each call so a new CLI login can reconnect the service. Missing or invalid credentials mean signed out;
 * unreadable files and invalid JSON report the file to repair.
 */
export function readCliCredentials(configDir: string): Credentials | null {
  const path = join(configDir, CREDENTIALS_FILE);
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`cannot read ${path}: ${(error as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    throw new Error(`${path} is not valid JSON; run agflow login`);
  }
  const parsed = CredentialsSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
```

**File:** `packages/runner/src/service/machine.ts` (new)

```ts
// Machine facts and canonical homes (design 7.1, 7.2, 7.6): setup captures what the service and its agents inherit.
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { CONNECTIVITY_VARS, type RunnerConfig } from '../config';
import { defaultExec, type Exec } from './system';

export function parseIoregPlatformUuid(output: string): string {
  const uuid = output.match(
    /"IOPlatformUUID"\s*=\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/i,
  )?.[1];
  if (!uuid) throw new Error('ioreg output has no IOPlatformUUID');
  return uuid;
}

/** The id runner.json is bound to, so a copied home folder is refused at start. */
export async function readMachineId(
  options: { exec?: Exec; platform?: NodeJS.Platform; machineIdFile?: string } = {},
): Promise<string> {
  if ((options.platform ?? process.platform) === 'darwin') {
    const result = await (options.exec ?? defaultExec)(['ioreg', '-rd1', '-c', 'IOPlatformExpertDevice']);
    if (result.exitCode !== 0 || result.timedOut) throw new Error(`ioreg failed: ${result.stderr.trim()}`);
    return parseIoregPlatformUuid(result.stdout);
  }
  const file = options.machineIdFile ?? '/etc/machine-id';
  const id = readFileSync(file, 'utf8').trim();
  if (!id) throw new Error(`${file} has no machine id`);
  return id;
}

/** Uses the owner's macOS display name, or the host name when scutil is unavailable. */
export async function readComputerName(exec: Exec = defaultExec): Promise<string> {
  const result = await exec(['scutil', '--get', 'ComputerName']);
  return result.exitCode === 0 && !result.timedOut && result.stdout.trim() ? result.stdout.trim() : hostname();
}

type Env = Record<string, string | undefined>;
export interface LoginShellEnv {
  path: string;
  connectivity: RunnerConfig['connectivity'];
}

function selectedEnv(env: Env): LoginShellEnv {
  const connectivity: RunnerConfig['connectivity'] = {};
  for (const name of CONNECTIVITY_VARS) {
    if (env[name] !== undefined) connectivity[name] = env[name];
  }
  // Vendor CLIs run in a clone; relative entries could execute an agent-written binary.
  const entries = (env.PATH ?? '').split(':').filter((entry) => entry.startsWith('/'));
  const path = [...new Set(entries)].join(':') || '/usr/bin:/bin:/usr/sbin:/sbin';
  return { path, connectivity };
}

/** A login shell captures the owner's setup; fallback keeps setup usable if their shell fails or hangs. */
export async function captureLoginShellEnv(
  options: { env?: Env; exec?: Exec; timeoutMs?: number } = {},
): Promise<LoginShellEnv> {
  const env = options.env ?? process.env;
  const start = `AGFLOW_ENV_START_${randomUUID()}`;
  const end = `AGFLOW_ENV_END_${randomUUID()}`;
  const names = ['PATH', ...CONNECTIVITY_VARS];
  // Markers exclude profile chatter; NUL records preserve newlines and equals signs in values.
  // Print only set variables, so an unset proxy stays distinct from an explicitly empty one.
  const script = [
    `printf '%s\\0' '${start}'`,
    ...names.map((name) => `if [ "\${${name}+set}" = set ]; then printf '%s\\0' "${name}=$${name}"; fi`),
    `printf '%s\\0' '${end}'`,
  ].join('\n');
  const childEnv = Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const result = await (options.exec ?? defaultExec)([env.SHELL || '/bin/zsh', '-l', '-i', '-c', script], {
    env: childEnv,
    cwd: env.HOME ?? homedir(),
    timeoutMs: options.timeoutMs ?? 10_000,
  });
  if (result.exitCode !== 0 || result.timedOut) return selectedEnv(env);
  const from = result.stdout.indexOf(`${start}\0`);
  const to = result.stdout.indexOf(`${end}\0`, from + start.length + 1);
  if (from < 0 || to < 0) return selectedEnv(env);
  const captured: Env = {};
  for (const record of result.stdout.slice(from + start.length + 1, to).split('\0')) {
    const separator = record.indexOf('=');
    if (separator > 0) captured[record.slice(0, separator)] = record.slice(separator + 1);
  }
  if (captured.PATH === undefined) return selectedEnv(env);
  return selectedEnv(captured);
}

/** Reads only global git settings; an incomplete identity leaves runner.json's default in place. */
export async function readGitIdentity(exec: Exec = defaultExec): Promise<RunnerConfig['commitIdentity'] | null> {
  const [name, email] = await Promise.all([
    exec(['git', 'config', '--global', 'user.name']),
    exec(['git', 'config', '--global', 'user.email']),
  ]);
  if ([name, email].some((result) => result.exitCode !== 0 || result.timedOut || !result.stdout.trim())) return null;
  return { name: name.stdout.trim(), email: email.stdout.trim() };
}

/** Creates a private home at its real path because Claude's guard compares canonical paths. */
export function canonicalHome(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  return realpathSync(path);
}

export function machineMismatch(config: Pick<RunnerConfig, 'machineId'>, machineId: string): string | null {
  return config.machineId === machineId ? null : 'this runner.json belongs to another Mac; run agflow runner setup';
}
```

**File:** `packages/runner/src/service/runner-json.ts` (new)

```ts
// Initial runner.json (design 7.1 and 12): setup and the harness share the schema's defaults and validation.
import { randomBytes } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { type RunnerConfig, type RunnerConfigInput, RunnerConfigSchema } from '../config';

export interface RunnerFacts {
  machineId: string;
  name: string;
  capturedPath: string;
  connectivity: RunnerConfig['connectivity'];
  commitIdentity: RunnerConfig['commitIdentity'] | null;
  /** Created with canonicalHome by the caller. */
  homes: { claude: string; codex: string };
}

export function newRunnerKey(): string {
  return `rk_${randomBytes(16).toString('hex')}`;
}

/** Synchronous construction over gathered facts; setup and the harness share the schema's defaults. */
export function createRunnerConfig(facts: RunnerFacts, overrides: Partial<RunnerConfigInput> = {}): RunnerConfig {
  const parsed = RunnerConfigSchema.safeParse({
    runnerKey: newRunnerKey(),
    machineId: facts.machineId,
    name: facts.name,
    capturedPath: facts.capturedPath,
    connectivity: facts.connectivity,
    commitIdentity: facts.commitIdentity ?? undefined,
    homes: facts.homes,
    ...overrides,
  });
  if (!parsed.success) {
    // Match loadRunnerConfig's messages; its describeIssues helper is private to config.ts.
    throw new Error(
      parsed.error.issues
        .flatMap((issue) => {
          if (issue.code === 'unrecognized_keys') {
            return issue.keys.map((key) => `runner.json: ${[...issue.path, key].join('.')}: unknown field`);
          }
          return [`runner.json: ${issue.path.join('.') || '(root)'}: ${issue.message}`];
        })
        .join('\n'),
    );
  }
  for (const [vendor, home] of Object.entries(parsed.data.homes)) {
    if (home === null) continue;
    // A not-yet-created home must also resolve through real ancestors for Claude's guard.
    const missing: string[] = [];
    let existing = home;
    while (!existsSync(existing)) {
      missing.unshift(basename(existing));
      existing = dirname(existing);
    }
    const real = join(realpathSync(existing), ...missing);
    if (real !== home) throw new Error(`runner.json: homes.${vendor}: must be a real path (${real})`);
  }
  return parsed.data;
}
```

**File:** `packages/runner/src/service/system.ts` (new)

```ts
// Service commands (design 7.1): injected execution keeps macOS operations testable without running real vendor CLIs.
import type { Subprocess } from 'bun';
import type { ReadableStreamDefaultReader } from 'node:stream/web';

export interface ExecOptions {
  cwd?: string;
  /** The child's whole environment; process.env when omitted. */
  env?: Record<string, string>;
  /** Killed with SIGKILL after this many ms. */
  timeoutMs?: number;
  /** Inherit the terminal for vendor logins; captured output is then empty. */
  interactive?: boolean;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type Exec = (argv: string[], options?: ExecOptions) => Promise<ExecResult>;

async function readText(reader?: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  if (!reader) return '';
  const decoder = new TextDecoder();
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

/** Commands that cannot start use the same failure path as commands that exit unsuccessfully. */
export const defaultExec: Exec = async (argv, options = {}) => {
  let proc: Subprocess<'ignore' | 'inherit', 'pipe' | 'inherit', 'pipe' | 'inherit'>;
  try {
    proc = Bun.spawn(argv, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdin: options.interactive ? 'inherit' : 'ignore',
      stdout: options.interactive ? 'inherit' : 'pipe',
      stderr: options.interactive ? 'inherit' : 'pipe',
    });
  } catch (error) {
    return { exitCode: 127, stdout: '', stderr: String(error), timedOut: false };
  }
  const stdoutReader = proc.stdout?.getReader();
  const stderrReader = proc.stderr?.getReader();
  let timedOut = false;
  const timer =
    options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          proc.kill('SIGKILL');
          // A shell child may still hold the pipes after the shell dies; it must not extend the deadline.
          void stdoutReader?.cancel().catch(() => {});
          void stderrReader?.cancel().catch(() => {});
        }, options.timeoutMs);
  try {
    // Drain both pipes while the command runs, including commands with large stderr output.
    const [exitCode, stdout, stderr] = await Promise.all([proc.exited, readText(stdoutReader), readText(stderrReader)]);
    return { exitCode, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
  }
};
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `bun test packages/runner/test/service/machine.test.ts packages/runner/test/service/runner-json.test.ts packages/runner/test/service/credentials.test.ts && bun test && bun run typecheck`
Expected: the task's tests pass; then the whole suite passes (`0 fail`) and `tsc` exits 0.

`readCliCredentials` returns null for a missing file and for valid JSON that fails the schema, which the CLI also treats as signed out. An unreadable file or invalid JSON throws an error that names the file, never its contents. The login shell runs as `$SHELL -l -i -c` from `HOME`, with stdin closed and a 10 s timeout; only absolute `PATH` entries are kept, and a failed capture falls back to the current environment, then to M2b's default `PATH`. `createRunnerConfig` runs no command: setup and M2g gather the facts and pass them in.

- [ ] **Step 5: Commit**

```bash
git add -A 'packages/runner/src/service/credentials.ts' 'packages/runner/src/service/machine.ts' 'packages/runner/src/service/runner-json.ts' 'packages/runner/src/service/system.ts' 'packages/runner/test/service-helpers.ts' 'packages/runner/test/service/credentials.test.ts' 'packages/runner/test/service/machine.test.ts' 'packages/runner/test/service/runner-json.test.ts'
git commit -m 'M2C Task 1: Machine facts, CLI credentials and the initial runner.json' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

### Task 2: Vendor logins and logouts

Setup steps 4 and 5 and uninstall's logouts (design 7.1). They run the runner's own pinned CLI (M2b's `vendorBinary` at the current pin) against the runner's own homes, from a new empty temporary directory, with an allowlisted environment built on M2b's `userVariables` (design 7.6). Claude must report a claude.ai login with a subscription type, and Codex a ChatGPT login; an API key login is refused and never echoed. The home strings come verbatim from runner.json, because Claude names its keychain item after them. The test helper `fakeVendorCli` writes a scripted shell CLI at the pin path, so no real login runs.

**Files:**
- Create: `packages/runner/src/vendor/login.ts`
- Test: `packages/runner/test/service-helpers.ts`
- Test: `packages/runner/test/vendor/login.test.ts`

- [ ] **Step 1: Write the failing tests**

**File:** `packages/runner/test/service-helpers.ts` (change)

```diff
diff --git a/packages/runner/test/service-helpers.ts b/packages/runner/test/service-helpers.ts
index 04251fb8..228dea25 100644
--- a/packages/runner/test/service-helpers.ts
+++ b/packages/runner/test/service-helpers.ts
@@ -1,5 +1,10 @@
-// Shared service test helpers: recorded commands now, with vendor and service fixtures added by tasks 2 and 3.
+// Shared service test helpers: recorded commands and isolated vendor CLIs.
+import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
+import { dirname, join } from 'node:path';
+import type { Vendor } from '@agflow/core';
+import type { RunnerPaths } from '../src/paths';
 import type { Exec, ExecOptions, ExecResult } from '../src/service/system';
+import { vendorBinary } from '../src/vendor/pins';
 
 export interface ExecCall {
   argv: string[];
@@ -19,3 +24,46 @@ export function recordingExec(
   };
   return Object.assign(exec, { calls });
 }
+
+export interface VendorCliCall {
+  argv: string[];
+  cwd: string;
+  entries: string[];
+  env: Record<string, string>;
+}
+
+/** A shell entrypoint at the real pin path; Bun records structured data without shell escaping losses. */
+export function fakeVendorCli(
+  paths: RunnerPaths,
+  vendor: Vendor,
+  version: string,
+  scripts: { argv: string[]; result: Partial<ExecResult> }[],
+): { binary: string; calls: () => VendorCliCall[] } {
+  const binary = join(paths.runner, vendorBinary(vendor, version));
+  const log = join(paths.runner, `${vendor}-calls.jsonl`);
+  mkdirSync(dirname(binary), { recursive: true });
+  writeFileSync(log, '');
+  const source = `
+const fs = require('node:fs');
+const argv = process.argv.slice(1);
+fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({
+  argv, cwd: process.cwd(), entries: fs.readdirSync('.'), env: process.env,
+}) + '\\n');
+const script = ${JSON.stringify(scripts)}.find(s => JSON.stringify(s.argv) === JSON.stringify(argv));
+if (!script) process.exit(99);
+process.stdout.write(script.result.stdout ?? '');
+process.stderr.write(script.result.stderr ?? '');
+process.exit(script.result.exitCode ?? 0);
+`;
+  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
+  writeFileSync(binary, `#!/bin/sh\nexec ${quote(process.execPath)} -e ${quote(source)} -- "$@"\n`, { mode: 0o700 });
+  return {
+    binary,
+    calls: () =>
+      readFileSync(log, 'utf8')
+        .trim()
+        .split('\n')
+        .filter(Boolean)
+        .map((line) => JSON.parse(line)),
+  };
+}
```

**File:** `packages/runner/test/vendor/login.test.ts` (new)

```ts
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONNECTIVITY_VARS, RunnerConfigSchema, vendorHomes } from '../../src/config';
import { runnerPaths } from '../../src/paths';
import {
  claudeLoginStatus,
  codexLoginStatus,
  loginClaude,
  loginCodex,
  logoutClaude,
  logoutCodex,
  vendorCliEnv,
} from '../../src/vendor/login';
import { VENDOR_PINS, vendorBinary } from '../../src/vendor/pins';
import { fakeVendorCli, recordingExec, type VendorCliCall } from '../service-helpers';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const version = '1.2.3';
const subscription = { loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' };
const claudeStatus = ['auth', 'status', '--json'];
const codexStatus = ['login', 'status'];

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agf-login-')));
  dirs.push(root);
  const paths = runnerPaths(root);
  const config = RunnerConfigSchema.parse({
    runnerKey: 'rk_test',
    machineId: 'machine',
    name: 'laptop',
    homes: { claude: join(root, 'saved-claude'), codex: join(root, 'saved-codex') },
    capturedPath: '/captured/bin:/usr/bin:/bin',
    connectivity: Object.fromEntries(CONNECTIVITY_VARS.map((name) => [name, `saved-${name}`])),
  });
  const base = {
    HOME: join(root, 'owner'),
    USER: 'owner',
    LOGNAME: 'owner',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'C',
    TERM: 'xterm-256color',
    SHELL: '/bin/sh',
    PATH: '/wrong',
    HTTPS_PROXY: 'wrong',
    ANTHROPIC_API_KEY: 'secret',
    OPENAI_API_KEY: 'secret',
    CLAUDE_CODE_OAUTH_TOKEN: 'secret',
    CLAUDE_CODE_TMPDIR: '/wrong',
    CLAUDE_CONFIG_DIR: '/wrong',
    CODEX_HOME: '/wrong',
    CODEX_MANAGED_BY_NPM: '1',
    NODE_OPTIONS: '--wrong',
    NODE_USE_SYSTEM_CA: '0',
    SSH_AUTH_SOCK: '/secret',
    AGFLOW_AGENT_TOKEN: 'secret',
  };
  return { root, paths, config, base, options: { version, base } };
}

function isolated(calls: VendorCliCall[]) {
  expect(new Set(calls.map((call) => call.cwd)).size).toBe(calls.length);
  for (const call of calls) {
    expect(call.cwd).not.toBe(process.cwd());
    expect(call.entries).toEqual([]);
    expect(existsSync(call.cwd)).toBe(false);
  }
}

function environment(call: VendorCliCall, expected: Record<string, string>) {
  // The shell may add PWD, SHLVL and _; every supplied variable still has to match.
  expect(call.env).toMatchObject(expected);
  for (const name of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'NODE_OPTIONS', 'SSH_AUTH_SOCK', 'AGFLOW_AGENT_TOKEN']) {
    expect(call.env[name]).toBeUndefined();
  }
  expect(Object.keys(call.env).filter((name) => name.startsWith('CLAUDE_CODE_'))).toEqual([]);
  expect(Object.keys(call.env).filter((name) => name.startsWith('CODEX_'))).toEqual(
    expected.CODEX_HOME ? ['CODEX_HOME'] : [],
  );
}

describe('vendorCliEnv', () => {
  test('builds only the allowlist, with stored homes and captured connectivity', () => {
    const { config, paths, base } = fixture();
    const common = {
      USER: base.USER,
      LOGNAME: base.LOGNAME,
      LANG: base.LANG,
      LC_ALL: base.LC_ALL,
      TERM: base.TERM,
      SHELL: base.SHELL,
      PATH: config.capturedPath,
      ...config.connectivity,
      NODE_USE_SYSTEM_CA: '1',
      DISABLE_AUTOUPDATER: '1',
    };
    expect(vendorCliEnv('claude', config, paths, base)).toEqual({
      ...common,
      HOME: base.HOME,
      CLAUDE_CONFIG_DIR: config.homes.claude!,
    });
    expect(vendorCliEnv('codex', config, paths, base)).toEqual({
      ...common,
      HOME: paths.homes.codexUser,
      CODEX_HOME: config.homes.codex!,
    });
    expect(base.PATH).toBe('/wrong');
  });

  test('preserves stored path spelling and uses canonical layout homes when none were stored', () => {
    const { root, paths, config, base } = fixture();
    mkdirSync(join(root, 'actual'));
    symlinkSync(join(root, 'actual'), config.homes.claude!);
    expect(vendorCliEnv('claude', config, paths, base).CLAUDE_CONFIG_DIR).toBe(config.homes.claude!);
    config.homes = { claude: null, codex: null };
    const homes = vendorHomes(config, paths);
    expect(vendorCliEnv('claude', config, paths, base).CLAUDE_CONFIG_DIR).toBe(homes.claude);
    expect(vendorCliEnv('codex', config, paths, base).CODEX_HOME).toBe(homes.codex);
  });
});

describe('vendor logins', () => {
  test('Claude logs into claude.ai, then checks the subscription, in fresh empty directories', async () => {
    const { config, paths, options } = fixture();
    const fake = fakeVendorCli(paths, 'claude', version, [
      { argv: ['auth', 'login', '--claudeai'], result: {} },
      { argv: claudeStatus, result: { stdout: JSON.stringify(subscription) } },
    ]);
    await loginClaude(config, paths, options);
    expect(await claudeLoginStatus(config, paths, options)).toEqual({ ok: true, plan: 'max' });
    const calls = fake.calls();
    expect(calls.map((call) => call.argv)).toEqual([['auth', 'login', '--claudeai'], claudeStatus, claudeStatus]);
    isolated(calls);
    for (const call of calls) environment(call, vendorCliEnv('claude', config, paths, options.base));
  }, 20_000);

  test.each(['stdout', 'stderr'])(
    'Codex logs in and reads ChatGPT status from either stream with its own HOME: %s',
    async (stream) => {
      const { config, paths, options } = fixture();
      const fake = fakeVendorCli(paths, 'codex', version, [
        { argv: ['login'], result: {} },
        { argv: codexStatus, result: { [stream]: 'Logged in using ChatGPT\n' } },
      ]);
      await loginCodex(config, paths, options);
      expect(await codexLoginStatus(config, paths, options)).toEqual({ ok: true, plan: null });
      const calls = fake.calls();
      expect(calls.map((call) => call.argv)).toEqual([['login'], codexStatus, codexStatus]);
      isolated(calls);
      for (const call of calls) environment(call, vendorCliEnv('codex', config, paths, options.base));
    },
    20_000,
  );

  test.each(['claude', 'codex'] as const)(
    'interactive logins inherit stdio without a timeout; the status check captures output: %s',
    async (vendor) => {
      const { config, paths, options } = fixture();
      const fake = fakeVendorCli(paths, vendor, version, []);
      const args = vendor === 'claude' ? claudeStatus : codexStatus;
      const exec = recordingExec([
        {
          argv: [fake.binary, ...args],
          result: {
            stdout: vendor === 'claude' ? JSON.stringify(subscription) : 'Logged in using ChatGPT',
          },
        },
      ]);
      await (vendor === 'claude' ? loginClaude : loginCodex)(config, paths, { ...options, exec });
      expect(exec.calls[0].argv).toEqual([
        fake.binary,
        ...(vendor === 'claude' ? ['auth', 'login', '--claudeai'] : ['login']),
      ]);
      expect(exec.calls[0].options?.interactive).toBe(true);
      expect(exec.calls[0].options?.timeoutMs).toBeUndefined();
      expect(exec.calls[1].options?.interactive).not.toBe(true);
      for (const call of exec.calls) expect(existsSync(call.options!.cwd!)).toBe(false);
    },
    20_000,
  );

  test.each([
    [{ loggedIn: false, authMethod: 'none' }, 1, 'not logged in'],
    [{ loggedIn: true, authMethod: 'console' }, 0, 'Console (API) login'],
    [{ loggedIn: true, authMethod: 'api_key' }, 0, 'Console (API) login'],
    [{ ...subscription, subscriptionType: '' }, 0, 'subscription'],
    [{ ...subscription, subscriptionType: '  ' }, 0, 'subscription'],
    [{ ...subscription, subscriptionType: 123 }, 0, 'subscription'],
    [{ loggedIn: true, authMethod: 'claude.ai' }, 0, 'subscription'],
    [subscription, 2, 'exit code 2'],
  ] as const)('Claude refuses invalid status %j (exit %i): %s', async (data, exitCode, reason) => {
    const { config, paths, options } = fixture();
    const fake = fakeVendorCli(paths, 'claude', version, [
      { argv: ['auth', 'login', '--claudeai'], result: {} },
      { argv: claudeStatus, result: { stdout: JSON.stringify(data), exitCode } },
    ]);
    expect(await claudeLoginStatus(config, paths, options)).toMatchObject({
      ok: false,
      reason: expect.stringContaining(reason),
    });
    await expect(loginClaude(config, paths, options)).rejects.toThrow(reason);
    isolated(fake.calls());
  }, 20_000);

  test.each(['bad json\nsecond line', 'null', '[]', '"text"'])(
    'malformed Claude status is a failure with only the first output line: %s',
    async (output) => {
      const { config, paths, options } = fixture();
      fakeVendorCli(paths, 'claude', version, [{ argv: claudeStatus, result: { stdout: output } }]);
      const status = await claudeLoginStatus(config, paths, options);
      expect(status).toMatchObject({ ok: false, reason: expect.stringContaining(output.split('\n')[0]) });
      expect(JSON.stringify(status)).not.toContain('second line');
    },
    20_000,
  );

  test.each([
    ['Not logged in', 1, 'not logged in'],
    ['Logged in using an API key - sk-secret', 0, 'an API key login; agflow needs a ChatGPT login'],
    ['Logged in using ChatGPT', 2, 'exit code 2'],
    ['unexpected', 0, 'ChatGPT'],
  ] as const)('Codex rejects status %s (exit %i): %s', async (output, exitCode, reason) => {
    const { config, paths, options } = fixture();
    fakeVendorCli(paths, 'codex', version, [
      { argv: ['login'], result: {} },
      { argv: codexStatus, result: { stderr: output, exitCode } },
    ]);
    const status = await codexLoginStatus(config, paths, options);
    expect(status).toMatchObject({ ok: false, reason: expect.stringContaining(reason) });
    expect(JSON.stringify(status)).not.toContain('sk-secret');
    await expect(loginCodex(config, paths, options)).rejects.toThrow(reason);
  }, 20_000);

  test.each(['claude', 'codex'] as const)(
    'failed login commands report the exit code and do not probe status: %s',
    async (vendor) => {
      const { config, paths, options } = fixture();
      const fake = fakeVendorCli(paths, vendor, version, [
        {
          argv: vendor === 'claude' ? ['auth', 'login', '--claudeai'] : ['login'],
          result: { exitCode: 7 },
        },
      ]);
      await expect((vendor === 'claude' ? loginClaude : loginCodex)(config, paths, options)).rejects.toThrow(
        'exit code 7',
      );
      expect(fake.calls()).toHaveLength(1);
      isolated(fake.calls());
    },
    20_000,
  );

  test.each(['claude', 'codex'] as const)(
    'a missing binary names its path and directs setup; status reports the same reason: %s',
    async (vendor) => {
      const { config, paths, options } = fixture();
      const binary = join(paths.runner, vendorBinary(vendor, version));
      for (const reason of ['binary missing', binary, 'agflow runner setup']) {
        await expect((vendor === 'claude' ? loginClaude : loginCodex)(config, paths, options)).rejects.toThrow(reason);
        expect(
          await (vendor === 'claude' ? claudeLoginStatus : codexLoginStatus)(config, paths, options),
        ).toMatchObject({ ok: false, reason: expect.stringContaining(reason) });
      }
    },
    20_000,
  );

  test('reports unsupported platforms with the installer wording', async () => {
    const { config, paths, base } = fixture();
    expect(await claudeLoginStatus(config, paths, { base, platform: 'linux-x64' })).toEqual({
      ok: false,
      reason: 'unsupported platform linux-x64',
    });
  }, 20_000);

  test('defaults to the selected platform pin version', async () => {
    const { config, paths, base } = fixture();
    const pin = VENDOR_PINS['darwin-arm64']!;
    const fake = fakeVendorCli(paths, 'claude', pin.claude.version, [
      { argv: claudeStatus, result: { stdout: JSON.stringify(subscription) } },
    ]);
    expect(await claudeLoginStatus(config, paths, { base, platform: 'darwin-arm64' })).toEqual({
      ok: true, plan: 'max',
    });
    expect(fake.calls()).toHaveLength(1);
  }, 20_000);
});

describe('vendor logouts', () => {
  test.each(['claude', 'codex'] as const)(
    'uses the same isolated homes and directories and ignores failed commands: %s',
    async (vendor) => {
      const { config, paths, options } = fixture();
      const args = vendor === 'claude' ? ['auth', 'logout'] : ['logout'];
      const fake = fakeVendorCli(paths, vendor, version, [{ argv: args, result: { exitCode: 3 } }]);
      await (vendor === 'claude' ? logoutClaude : logoutCodex)(config, paths, options);
      const calls = fake.calls();
      expect(calls.map((call) => call.argv)).toEqual([args]);
      environment(calls[0], vendorCliEnv(vendor, config, paths, options.base));
      isolated(calls);
    },
    20_000,
  );

  test.each(['claude', 'codex'] as const)(
    'never throws, including missing binaries and execution exceptions, and cleans up: %s',
    async (vendor) => {
      const { config, paths, options } = fixture();
      const logout = vendor === 'claude' ? logoutClaude : logoutCodex;
      await logout(config, paths, options);
      fakeVendorCli(paths, vendor, version, []);
      let cwd = '';
      await logout(config, paths, {
        ...options,
        exec: async (_argv, opts) => {
          cwd = opts!.cwd!;
          throw new Error('cannot start');
        },
      });
      expect(cwd).not.toBe('');
      expect(existsSync(cwd)).toBe(false);
    },
    20_000,
  );
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `bun test packages/runner/test/vendor/login.test.ts`
Expected: FAIL — `error: Cannot find module '../../src/vendor/login' from 'packages/runner/test/vendor/login.test.ts'` (0 pass, 1 fail, 1 error)

- [ ] **Step 3: Implement**

**File:** `packages/runner/src/vendor/login.ts` (new)

```ts
// Setup and uninstall use the runner's pinned CLIs and homes, never a project's settings (design 7.1, 7.6).
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Vendor } from '@agflow/core';
import { CONNECTIVITY_VARS, type RunnerConfig, vendorHomes } from '../config';
import { userVariables } from '../env';
import type { RunnerPaths } from '../paths';
import { defaultExec, type Exec, type ExecResult } from '../service/system';
import { VENDOR_PINS, vendorBinary, vendorPlatform } from './pins';

/** A subscription login with its plan (Claude's subscriptionType; Codex reports none), or why there is none. */
export type VendorLoginStatus = { ok: true; plan: string | null } | { ok: false; reason: string };

type Env = Record<string, string | undefined>;

export interface VendorLoginOptions {
  exec?: Exec;
  /** Override the current platform's pin for scripted CLIs, including on Linux CI. */
  version?: string;
  /** The pins' platform key; vendorPlatform() when omitted. */
  platform?: string;
  /** The caller's environment, read only for the user and system variables and the owner's HOME. */
  base?: Env;
}

/**
 * The vendor CLI's environment, built from an allowlist like the agents' (7.6), so a caller's API key or vendor
 * variable never replaces the subscription login. TERM stays: the logins are interactive.
 */
export function vendorCliEnv(
  vendor: Vendor,
  config: RunnerConfig,
  paths: RunnerPaths,
  base: Env = process.env,
): Record<string, string> {
  // The agents' user variables (USER, LOGNAME, LANG, SHELL and LC_*), then TERM.
  const env = userVariables(base);
  if (base.TERM !== undefined) env.TERM = base.TERM;
  env.PATH = config.capturedPath;
  for (const name of CONNECTIVITY_VARS) {
    const value = config.connectivity[name];
    if (value !== undefined) env[name] = value;
  }
  env.NODE_USE_SYSTEM_CA = '1';
  env.DISABLE_AUTOUPDATER = '1';
  const homes = vendorHomes(config, paths);
  if (vendor === 'claude') {
    // Claude's login keychain item depends on this exact config-directory string.
    env.HOME = base.HOME ?? homedir();
    env.CLAUDE_CONFIG_DIR = homes.claude;
  } else {
    env.HOME = paths.homes.codexUser;
    env.CODEX_HOME = homes.codex;
  }
  return env;
}

async function run(
  vendor: Vendor,
  args: string[],
  config: RunnerConfig,
  paths: RunnerPaths,
  options: VendorLoginOptions,
  interactive = false,
): Promise<ExecResult> {
  const platform = options.platform ?? vendorPlatform();
  const version = options.version ?? VENDOR_PINS[platform]?.[vendor].version;
  if (!version) throw new Error(`unsupported platform ${platform}`);
  const binary = join(paths.runner, vendorBinary(vendor, version));
  if (!existsSync(binary)) {
    throw new Error(`the runner's ${vendor} binary is missing (binary missing: ${binary}); run agflow runner setup`);
  }
  const env = vendorCliEnv(vendor, config, paths, options.base);
  const cwd = await mkdtemp(join(tmpdir(), 'agf-login-'));
  try {
    return await (options.exec ?? defaultExec)([binary, ...args], { cwd, env, interactive });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

function failure(reason: string): VendorLoginStatus {
  return { ok: false, reason };
}

function commandFailure(vendor: Vendor, command: string, result: ExecResult): string {
  return `${vendor} ${command} ${result.timedOut ? 'timed out' : `failed with exit code ${result.exitCode}`}`;
}

/** `auth status --json` must show a claude.ai login with a subscription; setup skips the login when it does. */
export async function claudeLoginStatus(
  config: RunnerConfig,
  paths: RunnerPaths,
  options: VendorLoginOptions = {},
): Promise<VendorLoginStatus> {
  try {
    const result = await run('claude', ['auth', 'status', '--json'], config, paths, options);
    if (result.timedOut) return failure(commandFailure('claude', 'auth status', result));
    let status: unknown;
    try {
      status = JSON.parse(result.stdout);
    } catch {
      const firstLine = (result.stdout.trim() || result.stderr.trim()).split(/\r?\n/)[0];
      return failure(`invalid Claude auth status: ${firstLine || '(empty output)'}`);
    }
    if (!status || typeof status !== 'object' || Array.isArray(status)) {
      return failure(`invalid Claude auth status: ${result.stdout.trim().split(/\r?\n/)[0]}`);
    }
    const auth = status as Record<string, unknown>;
    // Logged-out Claude exits 1 but still prints structured status.
    if (auth.loggedIn !== true) return failure('not logged in to Claude');
    if (result.exitCode !== 0) return failure(commandFailure('claude', 'auth status', result));
    if (auth.authMethod !== 'claude.ai') {
      return failure('a Console (API) login; agflow needs a Claude subscription login');
    }
    if (typeof auth.subscriptionType !== 'string' || !auth.subscriptionType.trim()) {
      return failure('no subscriptionType; agflow needs a Claude subscription login');
    }
    return { ok: true, plan: auth.subscriptionType };
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }
}

/** `login status` must exit 0 and name ChatGPT; an API key login is refused. */
export async function codexLoginStatus(
  config: RunnerConfig,
  paths: RunnerPaths,
  options: VendorLoginOptions = {},
): Promise<VendorLoginStatus> {
  try {
    const result = await run('codex', ['login', 'status'], config, paths, options);
    const output = `${result.stdout}\n${result.stderr}`;
    if (result.timedOut) return failure(commandFailure('codex', 'login status', result));
    // Never include the raw output: API-key status contains the key itself.
    if (/API[ -]key/i.test(output)) return failure('an API key login; agflow needs a ChatGPT login');
    if (/not logged in/i.test(output)) return failure('not logged in to Codex');
    if (result.exitCode !== 0) return failure(commandFailure('codex', 'login status', result));
    if (!/\bChatGPT\b/i.test(output)) return failure('agflow needs a ChatGPT login');
    return { ok: true, plan: null };
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }
}

async function login(
  vendor: Vendor,
  config: RunnerConfig,
  paths: RunnerPaths,
  options: VendorLoginOptions,
): Promise<void> {
  const args = vendor === 'claude' ? ['auth', 'login', '--claudeai'] : ['login'];
  const result = await run(vendor, args, config, paths, options, true);
  if (result.exitCode !== 0 || result.timedOut) throw new Error(commandFailure(vendor, 'login', result));
  const status = await (vendor === 'claude' ? claudeLoginStatus : codexLoginStatus)(config, paths, options);
  if (!status.ok) throw new Error(status.reason);
}

/** Setup step 4: the owner signs in on the terminal, then the status must show a subscription. */
export function loginClaude(config: RunnerConfig, paths: RunnerPaths, options: VendorLoginOptions = {}): Promise<void> {
  return login('claude', config, paths, options);
}

/** Setup step 5: the owner signs in on the terminal, then the status must name ChatGPT. */
export function loginCodex(config: RunnerConfig, paths: RunnerPaths, options: VendorLoginOptions = {}): Promise<void> {
  return login('codex', config, paths, options);
}

async function logout(
  vendor: Vendor,
  config: RunnerConfig,
  paths: RunnerPaths,
  options: VendorLoginOptions,
): Promise<void> {
  try {
    await run(vendor, vendor === 'claude' ? ['auth', 'logout'] : ['logout'], config, paths, options);
  } catch {
    // Uninstall continues even when a pin is missing or a vendor cannot log out.
  }
}

/** Uninstall's logouts are best effort: they never throw. */
export function logoutClaude(
  config: RunnerConfig,
  paths: RunnerPaths,
  options: VendorLoginOptions = {},
): Promise<void> {
  return logout('claude', config, paths, options);
}

export function logoutCodex(config: RunnerConfig, paths: RunnerPaths, options: VendorLoginOptions = {}): Promise<void> {
  return logout('codex', config, paths, options);
}
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `bun test packages/runner/test/vendor/login.test.ts && bun test && bun run typecheck`
Expected: the task's tests pass; then the whole suite passes (`0 fail`) and `tsc` exits 0.

`vendorCliEnv` starts from M2b's `userVariables(base)` and adds `TERM` when it is set, because the logins are interactive; it also sets the captured `PATH`, the connectivity variables, `NODE_USE_SYSTEM_CA=1` and `DISABLE_AUTOUPDATER=1`. Claude gets the owner's `HOME` and `CLAUDE_CONFIG_DIR`; Codex gets `HOME=homes/codex-user` and `CODEX_HOME`. The status functions never throw (a missing binary or another platform becomes the reason), the logins throw, and the logouts never throw. The interactive logins have no timeout. The real Codex writes its login status to stderr, so both streams are read.

- [ ] **Step 5: Commit**

```bash
git add -A 'packages/runner/src/vendor/login.ts' 'packages/runner/test/service-helpers.ts' 'packages/runner/test/vendor/login.test.ts'
git commit -m 'M2C Task 2: Vendor logins and logouts' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

### Task 3: Vendor pins: integrity and the installer

The runner owns its vendor binaries (design 7.1 step 3, X-10). This task fills the integrity fields of M2b's `VENDOR_PINS` in `pins.ts`, the only file of M2b's runner package that M2c edits: each npm tarball's sha512, and the Claude binary's sha256 from the SDK's `manifest.json`, with a test that both still match. The installer downloads the pinned tarball from the npm registry (or `AGFLOW_NPM_REGISTRY`), checks its sha512, unpacks it in a staging directory, checks Claude's sha256 and `--version`, and swaps the result into `vendor/<vendor>/<version>/`. `scripts/vendor-install.ts` is the file behind M2b's root script `vendor:install` (X-20, X-44), which M2d's and M2e's local suites use to get the pins without a full setup. The tests serve packed fake tarballs from a local registry; nothing is downloaded.

**Files:**
- Create: `packages/runner/scripts/vendor-install.ts`
- Create: `packages/runner/src/vendor/install.ts`
- Modify: `packages/runner/src/vendor/pins.ts`
- Test: `packages/runner/test/service-helpers.ts`
- Test: `packages/runner/test/vendor/install.test.ts`

- [ ] **Step 1: Write the failing tests**

**File:** `packages/runner/test/service-helpers.ts` (change)

```diff
diff --git a/packages/runner/test/service-helpers.ts b/packages/runner/test/service-helpers.ts
index 228dea25..31a16c41 100644
--- a/packages/runner/test/service-helpers.ts
+++ b/packages/runner/test/service-helpers.ts
@@ -1,5 +1,7 @@
 // Shared service test helpers: recorded commands and isolated vendor CLIs.
-import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
+import { createHash } from 'node:crypto';
+import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
+import { tmpdir } from 'node:os';
 import { dirname, join } from 'node:path';
 import type { Vendor } from '@agflow/core';
 import type { RunnerPaths } from '../src/paths';
@@ -67,3 +69,62 @@ process.exit(script.result.exitCode ?? 0);
         .map((line) => JSON.parse(line)),
   };
 }
+
+/** Builds an npm tarball from package-relative files, keeping executable modes. */
+export async function packTarball(
+  files: Record<string, { content: string; mode?: number }>,
+): Promise<{ bytes: Buffer; integrity: string }> {
+  const root = mkdtempSync(join(tmpdir(), 'agf-pack-'));
+  try {
+    mkdirSync(join(root, 'package'));
+    for (const [name, file] of Object.entries(files)) {
+      const path = join(root, 'package', name);
+      mkdirSync(dirname(path), { recursive: true });
+      writeFileSync(path, file.content);
+      chmodSync(path, file.mode ?? 0o644);
+    }
+    const proc = Bun.spawn(['tar', '-czf', join(root, 'package.tgz'), '-C', root, 'package'], {
+      env: { ...process.env, COPYFILE_DISABLE: '1' },
+      stdout: 'pipe',
+      stderr: 'pipe',
+    });
+    const [code, , stderr] = await Promise.all([
+      proc.exited,
+      new Response(proc.stdout).text(),
+      new Response(proc.stderr).text(),
+    ]);
+    if (code !== 0) throw new Error(`packing tarball failed: ${stderr}`);
+    const bytes = readFileSync(join(root, 'package.tgz'));
+    return { bytes, integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` };
+  } finally {
+    rmSync(root, { recursive: true, force: true });
+  }
+}
+
+/** A local npm registry with a request log; unknown packages return 404. */
+export function localRegistry(packages: { package: string; packageVersion: string; bytes: Buffer }[]): {
+  url: string;
+  requests: string[];
+  stop(): void;
+} {
+  const requests: string[] = [];
+  const server = Bun.serve({
+    hostname: '127.0.0.1',
+    port: 0,
+    fetch(request) {
+      const path = new URL(request.url).pathname;
+      requests.push(path);
+      const entry = packages.find(
+        (item) => path === `/${item.package}/-/${item.package.split('/').at(-1)}-${item.packageVersion}.tgz`,
+      );
+      return entry ? new Response(entry.bytes) : new Response('not found', { status: 404 });
+    },
+  });
+  return {
+    url: server.url.origin,
+    requests,
+    stop: () => {
+      server.stop(true);
+    },
+  };
+}
```

**File:** `packages/runner/test/vendor/install.test.ts` (new)

```ts
// Pinned vendor installation and integrity checks (design 7.1, 8.1, 9.1).
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runnerPaths } from '../../src/paths';
import { defaultExec } from '../../src/service/system';
import {
  ensurePinnedVendors,
  ensureVendorBinary,
  VendorInstallError,
  vendorInstallMain,
} from '../../src/vendor/install';
import { type ClaudePin, type PlatformPins, VENDOR_PINS, vendorBinary } from '../../src/vendor/pins';
import { localRegistry, packTarball, recordingExec } from '../service-helpers';

const roots: string[] = [];
const servers: ReturnType<typeof localRegistry>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const sha256 = (content: string) => createHash('sha256').update(content).digest('hex');
const cli = (output: string) => `#!/bin/sh\n[ "$1" = --version ] || exit 99\nprintf '%s\\n' '${output}'\n`;

async function fixture(output = '2.1.285 (Claude Code)') {
  const root = mkdtempSync(join(tmpdir(), 'agf-vi-'));
  roots.push(root);
  const paths = runnerPaths(join(root, 'home'));
  const claude = cli(output);
  const claudeTar = await packTarball({ claude: { content: claude }, 'package.json': { content: '{}' } });
  const tree = 'vendor/aarch64-apple-darwin';
  const codexTar = await packTarball({
    [`${tree}/bin/codex`]: { content: cli('codex-cli 0.159.2'), mode: 0o755 },
    [`${tree}/bin/codex-code-mode-host`]: { content: 'host', mode: 0o755 },
    [`${tree}/codex-path/rg`]: { content: 'rg', mode: 0o755 },
    [`${tree}/codex-resources/resource`]: { content: 'resource' },
    [`${tree}/codex-package.json`]: { content: '{}' },
  });
  const pins: PlatformPins = {
    claude: { ...VENDOR_PINS['darwin-arm64']!.claude, integrity: claudeTar.integrity, sha256: sha256(claude) },
    codex: { ...VENDOR_PINS['darwin-arm64']!.codex, integrity: codexTar.integrity },
  };
  const server = localRegistry([
    { ...pins.claude, bytes: claudeTar.bytes },
    { ...pins.codex, bytes: codexTar.bytes },
  ]);
  servers.push(server);
  mkdirSync(join(root, 'tmp'));
  const env = { AGFLOW_HOME: paths.home, AGFLOW_NPM_REGISTRY: `${server.url}/`, TMPDIR: join(root, 'tmp') };
  return { root, paths, pins, server, env, claude };
}

function emptyVendor(paths: ReturnType<typeof runnerPaths>, vendor = 'claude') {
  expect(readdirSync(join(paths.vendor, vendor))).toEqual([]);
}

describe('vendor installer', () => {
  test('installs only the verified Claude executable at mode 0755, then reuses it without a download', async () => {
    const f = await fixture();
    const binary = await ensureVendorBinary('claude', f.pins.claude, f.paths, { env: f.env });
    expect(binary).toBe(join(f.paths.runner, vendorBinary('claude', f.pins.claude.version)));
    expect(readFileSync(binary, 'utf8')).toBe(f.claude);
    expect(statSync(binary).mode & 0o777).toBe(0o755);
    expect(readdirSync(dirname(binary))).toEqual(['claude']);
    expect(await ensureVendorBinary('claude', f.pins.claude, f.paths, { env: f.env })).toBe(binary);
    expect(f.server.requests).toEqual([
      '/@anthropic-ai/claude-agent-sdk-darwin-arm64/-/claude-agent-sdk-darwin-arm64-0.3.285.tgz',
    ]);
    expect(readdirSync(f.root).sort()).toEqual(['home', 'tmp']);
    expect(readdirSync(f.paths.home)).toEqual(['runner']);
    expect(readdirSync(f.paths.runner)).toEqual(['vendor']);
    expect(readdirSync(join(f.root, 'tmp'))).toEqual([]);
  });

  test('keeps the whole Codex platform tree and reuses a valid executable', async () => {
    const f = await fixture();
    const binary = await ensureVendorBinary('codex', f.pins.codex, f.paths, { env: f.env });
    expect(binary).toBe(join(f.paths.runner, vendorBinary('codex', f.pins.codex.version)));
    const dir = dirname(dirname(binary));
    expect(readFileSync(join(dir, 'codex-path/rg'), 'utf8')).toBe('rg');
    expect(readFileSync(join(dir, 'codex-resources/resource'), 'utf8')).toBe('resource');
    expect(readFileSync(join(dir, 'bin/codex-code-mode-host'), 'utf8')).toBe('host');
    expect(readFileSync(join(dir, 'codex-package.json'), 'utf8')).toBe('{}');
    await ensureVendorBinary('codex', f.pins.codex, f.paths, { env: f.env });
    expect(f.server.requests).toHaveLength(1);
    chmodSync(binary, 0o644);
    await ensureVendorBinary('codex', f.pins.codex, f.paths, { env: f.env });
    expect(f.server.requests).toHaveLength(2);
    expect(statSync(binary).mode & 0o111).not.toBe(0);
  });

  test('publishes only after verification and gives commands private homes inside vendor', async () => {
    const f = await fixture();
    const destination = join(f.paths.vendor, 'claude', f.pins.claude.version);
    const commands: string[] = [];
    await ensureVendorBinary('claude', f.pins.claude, f.paths, {
      env: { ...f.env, HOME: '/unused-owner-home', ANTHROPIC_API_KEY: 'unused-key', CODEX_HOME: '/unused-codex' },
      exec: async (argv, options) => {
        expect(existsSync(destination)).toBe(false);
        expect(options!.cwd!.startsWith(`${f.paths.vendor}/`)).toBe(true);
        for (const name of ['HOME', 'TMPDIR', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME']) {
          expect(options!.env![name]!.startsWith(`${f.paths.vendor}/`)).toBe(true);
        }
        expect(options!.env!.ANTHROPIC_API_KEY).toBeUndefined();
        commands.push(argv[0] === 'tar' ? 'tar' : argv[1]!);
        return defaultExec(argv, options);
      },
    });
    expect(commands).toEqual(['tar', '--version']);
    expect(readdirSync(join(f.paths.vendor, 'claude'))).toEqual([f.pins.claude.version]);
  });

  test('refuses a tarball sha512 mismatch before extraction and removes staging', async () => {
    const f = await fixture();
    const pin = { ...f.pins.claude, integrity: 'sha512-wrong' };
    const exec = recordingExec();
    await expect(ensureVendorBinary('claude', pin, f.paths, { env: f.env, exec })).rejects.toThrow(
      `sha512 mismatch for ${pin.package}: expected sha512-wrong, actual ${f.pins.claude.integrity}`,
    );
    expect(exec.calls).toEqual([]);
    emptyVendor(f.paths);
  });

  test('refuses a Claude sha256 mismatch before executing it', async () => {
    const f = await fixture();
    const calls: string[][] = [];
    await expect(
      ensureVendorBinary('claude', { ...f.pins.claude, sha256: 'bad' }, f.paths, {
        env: f.env,
        exec: async (argv, options) => {
          calls.push(argv);
          return defaultExec(argv, options);
        },
      }),
    ).rejects.toThrow(`sha256 mismatch for ${f.pins.claude.package}: expected bad, actual ${f.pins.claude.sha256}`);
    expect(calls.every((argv) => argv[0] === 'tar')).toBe(true);
    emptyVendor(f.paths);
  });

  test('refuses the wrong --version output even when the hashes match', async () => {
    const f = await fixture('9.9.9 (Claude Code)');
    await expect(ensureVendorBinary('claude', f.pins.claude, f.paths, { env: f.env })).rejects.toThrow(
      '--version mismatch for claude: expected 2.1.285, actual "9.9.9 (Claude Code)"',
    );
    emptyVendor(f.paths);
  });

  test('replaces partial or corrupted installs and removes interrupted staging, retaining other versions', async () => {
    const f = await fixture();
    const parent = join(f.paths.vendor, 'claude');
    mkdirSync(join(parent, f.pins.claude.version), { recursive: true });
    mkdirSync(join(parent, '.staging-interrupted'));
    mkdirSync(join(parent, '1.0.0'));
    writeFileSync(join(parent, '1.0.0/claude'), 'old binary');
    const binary = await ensureVendorBinary('claude', f.pins.claude, f.paths, { env: f.env });
    expect(existsSync(join(parent, '.staging-interrupted'))).toBe(false);
    writeFileSync(binary, 'corrupted');
    await ensureVendorBinary('claude', f.pins.claude, f.paths, { env: f.env });
    expect(f.server.requests).toHaveLength(2);
    expect(readFileSync(binary, 'utf8')).toBe(f.claude);
    expect(readFileSync(join(parent, '1.0.0/claude'), 'utf8')).toBe('old binary');
  });

  test.each(['corrupted', 'transient timeout'] as const)(
    'keeps the previous binary after a %s and registry HTTP failure',
    async (failure) => {
      const f = await fixture();
      const binary = await ensureVendorBinary('claude', f.pins.claude, f.paths, { env: f.env });
      if (failure === 'corrupted') writeFileSync(binary, 'corrupted');
      const before = readFileSync(binary, 'utf8');
      let checks = 0;
      await expect(ensureVendorBinary('claude', f.pins.claude, f.paths, {
        env: f.env,
        registry: `${f.server.url}/missing`,
        exec: async (argv, options) => {
          if (argv[1] === '--version' && ++checks === 1) {
            return { exitCode: 137, timedOut: true, stdout: '', stderr: '' };
          }
          return defaultExec(argv, options);
        },
      })).rejects.toThrow('HTTP 404');
      expect(checks).toBe(failure === 'corrupted' ? 0 : 1);
      expect(readFileSync(binary, 'utf8')).toBe(before);
      expect(readdirSync(join(f.paths.vendor, 'claude'))).toEqual([f.pins.claude.version]);
    },
    20_000,
  );

  test('concurrent installers preserve each other’s staging and both publish successfully', async () => {
    const f = await fixture();
    let started!: () => void;
    const extracting = new Promise<void>((resolve) => { started = resolve; });
    let release!: () => void;
    const secondExtracting = new Promise<void>((resolve) => { release = resolve; });
    const first = ensureVendorBinary('claude', f.pins.claude, f.paths, {
      env: f.env,
      exec: async (argv, options) => {
        if (argv[0] === 'tar') {
          started();
          await secondExtracting;
        }
        return defaultExec(argv, options);
      },
    });
    await extracting;
    const second = ensureVendorBinary('claude', f.pins.claude, f.paths, {
      env: f.env,
      exec: async (argv, options) => {
        if (argv[0] === 'tar') release();
        return defaultExec(argv, options);
      },
    });
    const results = await Promise.allSettled([first, second]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
    const binary = join(f.paths.runner, vendorBinary('claude', f.pins.claude.version));
    expect(readFileSync(binary, 'utf8')).toBe(f.claude);
    expect(await ensureVendorBinary('claude', f.pins.claude, f.paths, { env: f.env })).toBe(binary);
    expect(readdirSync(join(f.paths.vendor, 'claude'))).toEqual([f.pins.claude.version]);
  }, 20_000);

  test('restores the previous tree when publishing the verified replacement fails', async () => {
    const f = await fixture();
    const binary = await ensureVendorBinary('claude', f.pins.claude, f.paths, { env: f.env });
    const destination = dirname(binary);
    const rename = fs.rename;
    const publish = spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(from).endsWith('/ready') && to === destination) {
        throw Object.assign(new Error('publish failed'), { code: 'EIO' });
      }
      return rename(from, to);
    });
    let checks = 0;
    try {
      await expect(ensureVendorBinary('claude', f.pins.claude, f.paths, {
        env: f.env,
        exec: async (argv, options) => {
          if (argv[1] === '--version' && ++checks === 1) {
            return { exitCode: 137, timedOut: true, stdout: '', stderr: '' };
          }
          return defaultExec(argv, options);
        },
      })).rejects.toThrow('publish failed');
    } finally {
      publish.mockRestore();
    }
    expect(readFileSync(binary, 'utf8')).toBe(f.claude);
    expect(readdirSync(join(f.paths.vendor, 'claude'))).toEqual([f.pins.claude.version]);
  }, 20_000);

  test.each(['EEXIST', 'ENOTEMPTY'])('verifies and reuses a competing publish after %s', async (code) => {
    const f = await fixture();
    const binary = join(f.paths.runner, vendorBinary('claude', f.pins.claude.version));
    const destination = dirname(binary);
    const rename = fs.rename;
    const publish = spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(from).endsWith('/ready') && to === destination) {
        cpSync(String(from), destination, { recursive: true });
        throw Object.assign(new Error('competing publish'), { code });
      }
      return rename(from, to);
    });
    const checked: string[] = [];
    try {
      expect(await ensureVendorBinary('claude', f.pins.claude, f.paths, {
        env: f.env,
        exec: async (argv, options) => {
          if (argv[1] === '--version') checked.push(argv[0]!);
          return defaultExec(argv, options);
        },
      })).toBe(binary);
    } finally {
      publish.mockRestore();
    }
    expect(checked).toHaveLength(2);
    expect(checked[1]).toBe(binary);
    expect(readFileSync(binary, 'utf8')).toBe(f.claude);
    expect(readdirSync(join(f.paths.vendor, 'claude'))).toEqual([f.pins.claude.version]);
  }, 20_000);

  test('sweeps dead-pid staging and retains staging owned by a live pid', async () => {
    const f = await fixture();
    const child = Bun.spawn(['/bin/sleep', '30']);
    child.kill();
    await child.exited;
    const parent = join(f.paths.vendor, 'claude');
    const dead = join(parent, `.staging-${child.pid}-dead`);
    const live = join(parent, `.staging-${process.pid}-live`);
    mkdirSync(dead, { recursive: true });
    mkdirSync(live);
    writeFileSync(join(live, 'in-progress'), 'keep');
    await ensureVendorBinary('claude', f.pins.claude, f.paths, { env: f.env });
    expect(existsSync(dead)).toBe(false);
    expect(readFileSync(join(live, 'in-progress'), 'utf8')).toBe('keep');
    expect(readdirSync(parent).sort()).toEqual([`.staging-${process.pid}-live`, f.pins.claude.version].sort());
  }, 20_000);

  test.each(['bin/codex-code-mode-host', 'codex-path/rg'])(
    'replaces a Codex tree missing %s',
    async (file) => {
      const f = await fixture();
      const binary = await ensureVendorBinary('codex', f.pins.codex, f.paths, { env: f.env });
      const companion = join(dirname(dirname(binary)), file);
      rmSync(companion);
      expect(await ensureVendorBinary('codex', f.pins.codex, f.paths, { env: f.env })).toBe(binary);
      expect(statSync(companion).isFile()).toBe(true);
      expect(f.server.requests).toHaveLength(2);
    },
    20_000,
  );

  test.each(['bin/codex-code-mode-host', 'codex-path/rg'])(
    'refuses a staged Codex tree missing %s',
    async (file) => {
      const f = await fixture();
      await expect(ensureVendorBinary('codex', f.pins.codex, f.paths, {
        env: f.env,
        exec: async (argv, options) => {
          const result = await defaultExec(argv, options);
          if (argv[0] === 'tar') rmSync(join(argv[4]!, 'package', f.pins.codex.tree, file));
          return result;
        },
      })).rejects.toThrow(file);
      emptyVendor(f.paths, 'codex');
    },
    20_000,
  );

  test('reports HTTP URL and status and cleans staging', async () => {
    const f = await fixture();
    const pin: ClaudePin = { ...f.pins.claude, package: '@test/missing' };
    await expect(ensureVendorBinary('claude', pin, f.paths, { env: f.env })).rejects.toThrow(
      `${f.server.url}/@test/missing/-/missing-${pin.packageVersion}.tgz: HTTP 404`,
    );
    emptyVendor(f.paths);
  });

  test('cleans staging after tar or version command failure', async () => {
    const f = await fixture();
    for (const failure of ['tar', '--version']) {
      await expect(
        ensureVendorBinary('claude', f.pins.claude, f.paths, {
          env: f.env,
          exec: (argv, options) =>
            argv.includes(failure)
              ? Promise.resolve({ exitCode: 1, stdout: '', stderr: 'failed', timedOut: false })
              : defaultExec(argv, options),
        }),
      ).rejects.toBeInstanceOf(VendorInstallError);
      emptyVendor(f.paths);
    }
  });

  test('Claude sha256 equals the installed SDK manifest checksum without network', () => {
    const sdk = Bun.resolveSync('@anthropic-ai/claude-agent-sdk/package.json', join(import.meta.dir, '../..'));
    const pin = VENDOR_PINS['darwin-arm64']!.claude;
    expect(JSON.parse(readFileSync(sdk, 'utf8')).version).toBe(pin.sdkVersion);
    expect(pin.packageVersion).toBe(pin.sdkVersion);
    const manifest = JSON.parse(readFileSync(join(dirname(sdk), 'manifest.json'), 'utf8'));
    expect(pin.sha256).toBe(manifest.platforms['darwin-arm64'].checksum);
    const lock = readFileSync(join(import.meta.dir, '../../../../bun.lock'), 'utf8');
    const entry = lock.split('\n').find((line) => line.includes(`"${pin.package}@${pin.packageVersion}"`));
    expect(entry).toBeDefined();
    expect(entry!.match(/"sha512-[^"]+"/)?.[0]).toBe(JSON.stringify(pin.integrity));
  });

  test('unsupported platforms fail before writing or requesting anything', async () => {
    const f = await fixture();
    await expect(ensurePinnedVendors(f.paths, { platform: 'linux-x64', env: f.env })).rejects.toThrow(
      'unsupported platform linux-x64',
    );
    expect(existsSync(f.paths.home)).toBe(false);
    expect(f.server.requests).toEqual([]);
  });

  test('main installs every supplied pin under AGFLOW_HOME and prints its path', async () => {
    const f = await fixture();
    const lines: string[] = [];
    const errors: string[] = [];
    expect(
      await vendorInstallMain([], f.env, {
        pins: f.pins,
        log: (line) => lines.push(line),
        error: (line) => errors.push(line),
      }),
    ).toBe(0);
    expect(lines).toEqual([
      join(f.paths.runner, vendorBinary('claude', f.pins.claude.version)),
      join(f.paths.runner, vendorBinary('codex', f.pins.codex.version)),
    ]);
    expect(lines.every(existsSync)).toBe(true);
    expect(statSync(f.paths.runner).mode & 0o777).toBe(0o700);
    expect(statSync(f.paths.home).mode & 0o777).toBe(0o700);
    expect(errors).toEqual([]);
    expect(f.server.requests).toHaveLength(2);
  });

  test('main reports an installation failure with a nonzero exit code', async () => {
    const f = await fixture();
    const errors: string[] = [];
    expect(await vendorInstallMain([], f.env, { platform: 'linux-x64', error: (line) => errors.push(line) })).toBe(1);
    expect(errors).toEqual(['unsupported platform linux-x64']);
  });
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `bun test packages/runner/test/vendor/install.test.ts`
Expected: FAIL — `error: Cannot find module '../../src/vendor/install' from 'packages/runner/test/vendor/install.test.ts'` (0 pass, 1 fail, 1 error)

- [ ] **Step 3: Implement**

**File:** `packages/runner/scripts/vendor-install.ts` (new)

```ts
// Standalone pinned vendor installation for smoke suites (design 7.1, 15).
import { vendorInstallMain } from '../src/vendor/install';

if (import.meta.main) process.exitCode = await vendorInstallMain(process.argv.slice(2), process.env);
```

**File:** `packages/runner/src/vendor/install.ts` (new)

```ts
// Install and verify runner-owned vendor pins atomically (design 7.1, 7.8, 8.1, 9.1).
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import type { Vendor } from '@agflow/core';
import { agflowHome, type RunnerPaths, runnerPaths } from '../paths';
import { defaultExec, type Exec } from '../service/system';
import {
  type ClaudePin,
  type CodexPin,
  parseVendorVersion,
  type PlatformPins,
  VENDOR_PINS,
  vendorBinary,
  vendorPlatform,
} from './pins';

type Env = Record<string, string | undefined>;
type Pin = ClaudePin | CodexPin;

// The real tarballs unpack to 224 and 332 MB, so the bound only catches a stalled download on a slow network.
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;

export class VendorInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VendorInstallError';
  }
}

export interface VendorInstallOptions {
  env?: Env;
  registry?: string;
  exec?: Exec;
}

export interface PinnedVendorsOptions extends VendorInstallOptions {
  /** Gets each installed binary's path, as it is ready. */
  log?: (line: string) => void;
  platform?: string;
  /** Test packages can replace the platform's real pins without a real download. */
  pins?: PlatformPins;
}

async function checkBinary(
  vendor: Vendor,
  pin: Pin,
  binary: string,
  exec: Exec,
  env: Record<string, string>,
  cwd: string,
): Promise<void> {
  const stat = await lstat(binary);
  if (!stat.isFile() || !(stat.mode & 0o111)) {
    throw new VendorInstallError(`not an executable file: ${binary}`);
  }
  if (vendor === 'claude') {
    if (!('sha256' in pin)) throw new VendorInstallError('Claude pin has no sha256');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(binary)) hash.update(chunk);
    const actual = hash.digest('hex');
    if (actual !== pin.sha256) {
      throw new VendorInstallError(`sha256 mismatch for ${pin.package}: expected ${pin.sha256}, actual ${actual}`);
    }
    if ((stat.mode & 0o777) !== 0o755) throw new VendorInstallError(`expected mode 0755: ${binary}`);
  }
  if (vendor === 'codex') {
    const tree = dirname(dirname(binary));
    for (const file of ['bin/codex-code-mode-host', 'codex-path/rg']) {
      const companion = join(tree, file);
      const stat = await lstat(companion);
      if (!stat.isFile() || !(stat.mode & 0o111)) {
        throw new VendorInstallError(`not an executable file: ${companion}`);
      }
    }
  }
  const result = await exec([binary, '--version'], { env, cwd, timeoutMs: 10_000 });
  if (result.exitCode !== 0 || result.timedOut || parseVendorVersion(vendor, result.stdout) !== pin.version) {
    const actual = JSON.stringify(result.stdout.trim() || result.stderr.trim());
    throw new VendorInstallError(
      `--version mismatch for ${vendor}: expected ${pin.version}, actual ${actual}` +
        (result.timedOut ? ' (timed out)' : result.exitCode !== 0 ? ` (exit ${result.exitCode})` : ''),
    );
  }
}

async function download(url: string): Promise<Buffer> {
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (response.ok) return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    throw new VendorInstallError(`${url}: ${error instanceof Error ? error.message : String(error)}`);
  }
  throw new VendorInstallError(`${url}: HTTP ${response.status}`);
}

/** Only reap abandoned staging; another installer may still be downloading or checking its binary. */
function abandonedStaging(name: string): boolean {
  const pid = name.match(/^\.staging-([1-9][0-9]*)-/)?.[1];
  if (!pid) return true;
  try {
    process.kill(Number(pid), 0);
    return false;
  } catch (error) {
    // EPERM also means the owner is alive.
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/** Reuses a verified install, or stages and verifies the pinned package before publishing its version directory. */
export async function ensureVendorBinary(
  vendor: Vendor,
  pin: Pin,
  paths: RunnerPaths,
  options: VendorInstallOptions = {},
): Promise<string> {
  const env = options.env ?? process.env;
  const exec = options.exec ?? defaultExec;
  const binary = resolve(paths.runner, vendorBinary(vendor, pin.version));
  const parent = resolve(paths.vendor, vendor);
  const destination = join(parent, pin.version);
  const binaryRelative = relative(destination, binary);
  let staging: string | undefined;
  try {
    await mkdir(paths.runner, { recursive: true, mode: 0o700 });
    await mkdir(parent, { recursive: true });
    for (const entry of await readdir(parent)) {
      if (entry.startsWith('.staging-') && abandonedStaging(entry)) {
        await rm(join(parent, entry), { recursive: true, force: true });
      }
    }
    staging = await mkdtemp(join(parent, `.staging-${process.pid}-`));
    const checkHome = join(staging, 'check');
    await mkdir(checkHome);
    // Even --version gets a private home and tmp, and no caller's vendor settings or credentials.
    const commandEnv = {
      PATH: env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: checkHome,
      TMPDIR: checkHome,
      CLAUDE_CONFIG_DIR: checkHome,
      CODEX_HOME: checkHome,
      COPYFILE_DISABLE: '1',
    };
    try {
      await checkBinary(vendor, pin, binary, exec, commandEnv, checkHome);
      return binary;
    } catch {
      // Keep the old tree available until its replacement has passed every check.
    }
    const registry = (options.registry ?? env.AGFLOW_NPM_REGISTRY ?? 'https://registry.npmjs.org').replace(/\/+$/, '');
    const name = pin.package.split('/').at(-1);
    const url = `${registry}/${pin.package}/-/${name}-${pin.packageVersion}.tgz`;
    const bytes = await download(url);
    const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
    if (integrity !== pin.integrity) {
      throw new VendorInstallError(
        `sha512 mismatch for ${pin.package}: expected ${pin.integrity}, actual ${integrity}`,
      );
    }
    const archive = join(staging, 'package.tgz');
    const unpacked = join(staging, 'unpacked');
    await writeFile(archive, bytes);
    await mkdir(unpacked);
    const extraction = await exec(['tar', '-xzf', archive, '-C', unpacked], {
      env: commandEnv,
      cwd: staging,
      timeoutMs: 120_000,
    });
    if (extraction.exitCode !== 0 || extraction.timedOut) {
      throw new VendorInstallError(`tar failed for ${pin.package}: ${extraction.stderr.trim() || 'extraction failed'}`);
    }
    const ready = join(staging, 'ready');
    if (vendor === 'claude') {
      await mkdir(ready);
      const source = join(unpacked, 'package', 'claude');
      if (!(await lstat(source)).isFile()) throw new VendorInstallError(`not a regular file: ${source}`);
      await rename(source, join(ready, 'claude'));
      await chmod(join(ready, 'claude'), 0o755);
    } else {
      if (!('tree' in pin) || !/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(pin.tree)) {
        throw new VendorInstallError('Codex pin has no safe package tree');
      }
      const source = join(unpacked, 'package', pin.tree);
      if (!(await lstat(source)).isDirectory()) throw new VendorInstallError(`not a directory: ${source}`);
      await rename(source, ready);
    }
    await checkBinary(vendor, pin, join(ready, binaryRelative), exec, commandEnv, checkHome);
    const previous = join(staging, 'previous');
    let replaced = false;
    try {
      await rename(destination, previous);
      replaced = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    try {
      await rename(ready, destination);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST' || code === 'ENOTEMPTY') {
        try {
          await checkBinary(vendor, pin, binary, exec, commandEnv, checkHome);
          return binary;
        } catch {
          // A competing publish only wins if it is a complete, verified install.
        }
      }
      if (replaced) {
        try {
          await rename(previous, destination);
        } catch (restoreError) {
          // Preserve the backup if the filesystem prevents rollback.
          staging = undefined;
          throw new VendorInstallError(
            `cannot restore ${previous}: ${String(restoreError)}; publish failed: ${String(error)}`,
          );
        }
      }
      throw error;
    }
    return binary;
  } catch (error) {
    if (error instanceof VendorInstallError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new VendorInstallError(`installing ${pin.package}: ${message}`);
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
  }
}

/** Setup and install share this platform gate; service start never calls the installer. */
export async function ensurePinnedVendors(
  paths: RunnerPaths,
  options: PinnedVendorsOptions = {},
): Promise<Record<Vendor, string>> {
  const platform = options.platform ?? vendorPlatform();
  const pins = options.pins ?? VENDOR_PINS[platform];
  if (!pins) throw new VendorInstallError(`unsupported platform ${platform}`);
  const claude = await ensureVendorBinary('claude', pins.claude, paths, options);
  options.log?.(claude);
  const codex = await ensureVendorBinary('codex', pins.codex, paths, options);
  options.log?.(codex);
  return { claude, codex };
}

/** Fills AGFLOW_HOME's vendor directory without setup, for the smoke suites and standalone installation. */
export async function vendorInstallMain(
  argv: string[] = [],
  env: Env = process.env,
  options: Omit<PinnedVendorsOptions, 'env'> & { error?: (line: string) => void } = {},
): Promise<number> {
  try {
    if (argv.length) throw new VendorInstallError('usage: bun run vendor:install');
    await ensurePinnedVendors(runnerPaths(agflowHome(env)), { ...options, env, log: options.log ?? console.log });
    return 0;
  } catch (error) {
    (options.error ?? console.error)(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
```

**File:** `packages/runner/src/vendor/pins.ts` (change)

```diff
diff --git a/packages/runner/src/vendor/pins.ts b/packages/runner/src/vendor/pins.ts
index 2d2cf37c..8a9765d3 100644
--- a/packages/runner/src/vendor/pins.ts
+++ b/packages/runner/src/vendor/pins.ts
@@ -9,16 +9,25 @@ export interface VendorPin {
   /** The npm package the binary comes from, at packageVersion. */
   package: string;
   packageVersion: string;
+  /** The whole npm tarball's sha512 SRI. */
+  integrity: string;
 }
 
 export interface ClaudePin extends VendorPin {
   /** The @anthropic-ai/claude-agent-sdk version that bundles this CLI; packages/runner depends on it. */
   sdkVersion: string;
+  /** The platform checksum in the SDK's manifest.json. */
+  sha256: string;
+}
+
+export interface CodexPin extends VendorPin {
+  /** Package-relative tree containing bin/, codex-path/ and codex-resources/. */
+  tree: string;
 }
 
 export interface PlatformPins {
   claude: ClaudePin;
-  codex: VendorPin;
+  codex: CodexPin;
 }
 
 /** Keyed by `<process.platform>-<process.arch>`. M2 pins darwin-arm64 only; elsewhere preflight reports it. */
@@ -30,9 +39,17 @@ export const VENDOR_PINS: Partial<Record<string, PlatformPins>> = {
       sdkVersion: '0.3.285',
       package: '@anthropic-ai/claude-agent-sdk-darwin-arm64',
       packageVersion: '0.3.285',
+      integrity: 'sha512-2h6iCTH5uPYKA9jBXB7Of0dXZ5hUdu88VnXq9u50AFfMnusy+w83dKgpu+TD+mWiO+mbvMdi1ZsGaoI8HPFTXQ==',
+      sha256: '51f09bd1e021d9fa8a1864c179799bd37cb39962a937935c5cf6823398e86db4',
     },
     // Codex has no separate platform package; the platform build of @openai/codex carries the whole vendor tree.
-    codex: { version: '0.159.2', package: '@openai/codex', packageVersion: '0.159.2-darwin-arm64' },
+    codex: {
+      version: '0.159.2',
+      package: '@openai/codex',
+      packageVersion: '0.159.2-darwin-arm64',
+      integrity: 'sha512-7SPaPFU0tdqapQ5VEgrF+wb+p9dxfWfLMXMKZMRKoWPn/tLMajlMjYBBnu8o6VtaVH2DHQ6kpnp5TMkv5bqvrg==',
+      tree: 'vendor/aarch64-apple-darwin',
+    },
   },
 };
 
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `bun test packages/runner/test/vendor/install.test.ts packages/runner/test/pins.test.ts && bun test && bun run typecheck`
Expected: the task's tests pass; then the whole suite passes (`0 fail`) and `tsc` exits 0.

The integrity values come from registry.npmjs.org (`dist.integrity`, fetched 2026-11-09). One real `vendor:install` into a scratch `AGFLOW_HOME` confirmed them, Claude's sha256, the Codex tree (`bin/`, `codex-path/`, `codex-resources/`) and both `--version` checks; a second run with an unreachable registry reused both installs. An installed version that passes the checks is reused with no request; one that fails is replaced only after its replacement verifies. Codex's reuse check also needs `bin/codex-code-mode-host` and `codex-path/rg`. Staging directories are named by pid, and only those of dead processes are swept. The download is bounded by 30 minutes: the packages unpack to about 224 MB (Claude) and 332 MB (Codex).

For implementation and verification, use existing pinned executables through `AGFLOW_CLAUDE_BIN` and `AGFLOW_CODEX_BIN`, or install into a newly created scratch directory using `AGFLOW_HOME=<scratch-home> bun run vendor:install`. Then explicitly set `AGFLOW_CLAUDE_BIN=<scratch-home>/runner/vendor/claude/2.1.285/claude` and `AGFLOW_CODEX_BIN=<scratch-home>/runner/vendor/codex/0.159.2/bin/codex`; the locators do not follow AGFLOW_HOME. Remove the scratch installation after all children exit. Do not run the installer without a scratch AGFLOW_HOME or install globally during implementation or verification.

- [ ] **Step 5: Commit**

```bash
git add -A 'packages/runner/scripts/vendor-install.ts' 'packages/runner/src/vendor/install.ts' 'packages/runner/src/vendor/pins.ts' 'packages/runner/test/service-helpers.ts' 'packages/runner/test/vendor/install.test.ts'
git commit -m 'M2C Task 3: Vendor pins: integrity and the installer' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

### Task 4: Single instance: runner.lock and the control socket

One runner per runner home (design 7.1, 7.2). Before it touches runner.db, the runner takes an exclusive flock on runner.lock through `bun:ffi` (libSystem on macOS, libc.so.6 on Linux), opened with `O_CLOEXEC` so no agent inherits it, and writes its pid, mode and start time into it. It then binds runner.sock, the control socket every `agflow runner` command talks to: JSON over HTTP on a Unix socket, mode 0600. A second foreground start fails at once with design 7.1's message; the launchd service waits for the lock instead, so `KeepAlive` does not loop.

**Files:**
- Create: `packages/runner/src/service/control.ts`
- Create: `packages/runner/src/service/lock.ts`
- Test: `packages/runner/test/service/control.test.ts`
- Test: `packages/runner/test/service/lock.test.ts`

- [ ] **Step 1: Write the failing tests**

**File:** `packages/runner/test/service/control.test.ts` (new)

```ts
import { afterEach, describe, expect, test } from 'bun:test';
import type { Subprocess } from 'bun';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runnerPaths } from '../../src/paths';
import { acquireRunnerLock, type RunnerLock } from '../../src/service/lock';
import {
  checkSocketPath,
  controlRequest,
  ControlUnavailableError,
  startControlServer,
  type ControlRoutes,
  type ControlServer,
} from '../../src/service/control';

const dirs: string[] = [];
const locks: RunnerLock[] = [];
const servers: ControlServer[] = [];
const children: Subprocess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill('SIGKILL');
    await child.exited;
  }
  for (const server of servers.splice(0)) await server.stop();
  for (const lock of locks.splice(0)) lock.release();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch() {
  const dir = mkdtempSync('/tmp/agf-ctl-');
  dirs.push(dir);
  return runnerPaths(dir);
}

async function serve(routes: ControlRoutes = {}) {
  const paths = scratch();
  const lock = await acquireRunnerLock(paths, { mode: 'foreground' });
  locks.push(lock);
  const server = startControlServer({ paths, lock, routes });
  servers.push(server);
  return { paths, lock, server };
}

describe('runner.sock', () => {
  test('serves GET and POST JSON, query parameters and empty bodies, with private socket permissions', async () => {
    const { paths, lock, server } = await serve({
      'GET /health': (_body, query) => ({ ok: true, values: query.getAll('a') }),
      'POST /drain': async (body, query) => ({ body: body ?? null, reason: query.get('reason') }),
      'POST /stop': () => undefined,
    });
    expect(server.path).toBe(paths.socket);
    expect(statSync(paths.socket).isSocket()).toBe(true);
    expect(statSync(paths.socket).mode & 0o777).toBe(0o600);
    expect(await controlRequest<unknown>(paths, 'GET', '/health?a=one&a=two')).toEqual({
      ok: true,
      values: ['one', 'two'],
    });
    expect(await controlRequest<unknown>(paths, 'POST', '/drain?reason=owner', { draining: true })).toEqual({
      body: { draining: true },
      reason: 'owner',
    });
    expect(await controlRequest<unknown>(paths, 'POST', '/drain')).toEqual({ body: null, reason: null });
    expect(await controlRequest<unknown>(paths, 'POST', '/stop')).toBeNull();
    await server.stop();
    await server.stop();
    expect(existsSync(paths.socket)).toBe(false);
    expect(lock.held).toBe(true);
  });

  test('uses JSON errors for unknown routes, wrong methods, malformed JSON and thrown handlers', async () => {
    const { paths } = await serve({
      'POST /drain': () => true,
      'GET /broken': () => {
        throw new Error('cannot drain now');
      },
    });
    for (const [method, path, body, status] of [
      ['GET', '/absent', undefined, 404],
      ['GET', '/drain', undefined, 404],
      ['POST', '/drain', '{broken', 400],
      ['GET', '/broken', undefined, 500],
    ] as const) {
      const response = await fetch(`http://localhost${path}`, { unix: paths.socket, method, body });
      expect(response.status).toBe(status);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(await response.json()).toMatchObject({ error: expect.any(String) });
    }
    await expect(controlRequest<unknown>(paths, 'GET', '/broken')).rejects.toThrow('cannot drain now');
    const error = await controlRequest<unknown>(paths, 'GET', '/absent').catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ControlUnavailableError);
  });

  test('only the matching live lock can replace a real socket left by a SIGKILLed process', async () => {
    const paths = scratch();
    const ready = join(paths.home, 'ready');
    const script = join(paths.home, 'socket.ts');
    writeFileSync(script, `
import { mkdirSync, writeFileSync } from 'node:fs';
mkdirSync(${JSON.stringify(paths.runner)});
Bun.serve({ unix: ${JSON.stringify(paths.socket)}, fetch: () => Response.json({ ok: true }) });
writeFileSync(${JSON.stringify(ready)}, 'ready');
`);
    const child = Bun.spawn([process.execPath, script], { stdout: 'ignore', stderr: 'inherit' });
    children.push(child);
    const deadline = Date.now() + 3_000;
    while (!existsSync(ready)) {
      if (child.exitCode !== null || Date.now() > deadline) throw new Error('socket child did not become ready');
      await Bun.sleep(10);
    }
    child.kill('SIGKILL');
    await child.exited;
    expect(statSync(paths.socket).isSocket()).toBe(true);
    await expect(controlRequest<unknown>(paths, 'GET', '/health')).rejects.toBeInstanceOf(ControlUnavailableError);
    const other = await acquireRunnerLock(scratch(), { mode: 'foreground' });
    locks.push(other);
    expect(() => startControlServer({ paths, lock: other, routes: {} })).toThrow('lock');
    const lock = await acquireRunnerLock(paths, { mode: 'foreground' });
    locks.push(lock);
    lock.release();
    expect(() => startControlServer({ paths, lock, routes: {} })).toThrow('lock');
    expect(statSync(paths.socket).isSocket()).toBe(true);
    const live = await acquireRunnerLock(paths, { mode: 'foreground' });
    locks.push(live);
    servers.push(startControlServer({ paths, lock: live, routes: { 'GET /health': () => ({ ok: true }) } }));
    expect(await controlRequest<unknown>(paths, 'GET', '/health')).toEqual({ ok: true });
    expect(statSync(paths.socket).mode & 0o777).toBe(0o600);
  });

  test('a second server cannot unlink the first server socket', async () => {
    const { paths, lock } = await serve({ 'GET /health': () => true });
    expect(() => startControlServer({ paths, lock, routes: {} })).toThrow();
    expect(await controlRequest<unknown>(paths, 'GET', '/health')).toBe(true);
  });

  test('a late stop leaves a new owner’s socket intact', async () => {
    const { paths, lock, server } = await serve();
    lock.release();
    const next = await acquireRunnerLock(paths, { mode: 'service' });
    locks.push(next);
    servers.push(startControlServer({ paths, lock: next, routes: { 'GET /health': () => 'new owner' } }));
    await server.stop();
    expect(statSync(paths.socket).isSocket()).toBe(true);
    expect(await controlRequest<unknown>(paths, 'GET', '/health')).toBe('new owner');
  });

  test('missing listeners and a request deadline are ControlUnavailableError', async () => {
    await expect(controlRequest<unknown>(scratch(), 'GET', '/status')).rejects.toBeInstanceOf(ControlUnavailableError);
    const { paths } = await serve({ 'GET /status': () => new Promise(() => {}) });
    const started = Date.now();
    const error = await controlRequest<unknown>(paths, 'GET', '/status', undefined, { timeoutMs: 40 }).catch(
      (error: unknown) => error,
    );
    expect(error).toBeInstanceOf(ControlUnavailableError);
    expect((error as Error).message).toContain('40 ms');
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test('refuses paths over 103 bytes on both sides and names AGFLOW_HOME', async () => {
    expect(() => checkSocketPath('/' + 'a'.repeat(102))).not.toThrow();
    const { paths, lock } = await serve();
    for (const socket of ['/' + 'a'.repeat(103), '/' + 'é'.repeat(52)]) {
      expect(() => checkSocketPath(socket)).toThrow(socket);
      expect(() => startControlServer({ paths: { ...paths, socket }, lock, routes: {} })).toThrow('AGFLOW_HOME');
      await expect(controlRequest<unknown>({ ...paths, socket }, 'GET', '/health')).rejects.toThrow('AGFLOW_HOME');
    }
  });
});
```

**File:** `packages/runner/test/service/lock.test.ts` (new)

```ts
import { afterEach, describe, expect, test } from 'bun:test';
import type { Subprocess } from 'bun';
import { dlopen, FFIType } from 'bun:ffi';
import { existsSync, fstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runnerPaths } from '../../src/paths';
import { acquireRunnerLock, AlreadyRunningError, readLockOwner, type RunnerLock } from '../../src/service/lock';

const dirs: string[] = [];
const locks: RunnerLock[] = [];
const children: Subprocess[] = [];
const descendants: number[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill('SIGKILL');
    await child.exited;
  }
  for (const pid of descendants.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
  for (const lock of locks.splice(0)) lock.release();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch() {
  const dir = mkdtempSync('/tmp/agf-lock-');
  dirs.push(dir);
  return runnerPaths(dir);
}

// F_GETFD reads no variadic argument, so a two-argument declaration is exact on every ABI.
const libc = dlopen(process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
  fcntl: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
});
const F_GETFD = 1;
const FD_CLOEXEC = 1;

/** This process's descriptors open on the lock file. */
function lockFds(paths: ReturnType<typeof runnerPaths>): number[] {
  const { dev, ino } = statSync(paths.lock);
  return readdirSync('/dev/fd')
    .map(Number)
    .filter((fd) => {
      try {
        const stat = fstatSync(fd);
        return stat.dev === dev && stat.ino === ino;
      } catch {
        // The descriptor readdir used for /dev/fd itself is closed by now.
        return false;
      }
    });
}

async function holder(paths: ReturnType<typeof runnerPaths>, spawnChild = false) {
  const ready = join(paths.home, 'ready.json');
  const script = join(paths.home, 'holder.ts');
  writeFileSync(script, `
import { acquireRunnerLock } from ${JSON.stringify(join(import.meta.dir, '../../src/service/lock.ts'))};
import { runnerPaths } from ${JSON.stringify(join(import.meta.dir, '../../src/paths.ts'))};
import { writeFileSync } from 'node:fs';
const lock = await acquireRunnerLock(runnerPaths(${JSON.stringify(paths.home)}), { mode: 'foreground' });
const child = ${spawnChild}
  ? Bun.spawn(['/bin/sleep', '30'], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
  : null;
process.on('SIGTERM', () => { lock.release(); process.exit(0); });
writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ pid: process.pid, childPid: child?.pid }));
console.log(process.pid);
setInterval(() => {}, 1000);
`);
  const child = Bun.spawn([process.execPath, script], { stdout: 'ignore', stderr: 'inherit' });
  children.push(child);
  const deadline = Date.now() + 3_000;
  while (!existsSync(ready)) {
    if (child.exitCode !== null || Date.now() > deadline) throw new Error('lock holder did not become ready');
    await Bun.sleep(10);
  }
  const identity = JSON.parse(readFileSync(ready, 'utf8')) as { pid: number; childPid?: number };
  if (identity.childPid) descendants.push(identity.childPid);
  return { child, ...identity };
}

describe('runner.lock', () => {
  test('creates private state, records its owner, and releases without deleting or replacing the inode', async () => {
    const paths = scratch();
    expect(readLockOwner(paths)).toBeNull();
    const lock = await acquireRunnerLock(paths, { mode: 'service' });
    locks.push(lock);
    expect(lock.path).toBe(paths.lock);
    expect(lock.held).toBe(true);
    expect(lock.owner).toMatchObject({ pid: process.pid, mode: 'service' });
    expect(Number.isFinite(Date.parse(lock.owner.startedAt))).toBe(true);
    expect(readLockOwner(paths)).toEqual(lock.owner);
    expect(JSON.parse(readFileSync(paths.lock, 'utf8'))).toEqual(lock.owner);
    expect(statSync(paths.runner).mode & 0o777).toBe(0o700);
    expect(statSync(paths.lock).mode & 0o777).toBe(0o600);
    const [fd, ...others] = lockFds(paths);
    expect(others).toEqual([]);
    expect(libc.symbols.fcntl(fd!, F_GETFD) & FD_CLOEXEC).toBe(FD_CLOEXEC);
    const inode = statSync(paths.lock).ino;
    lock.release();
    lock.release();
    expect(lock.held).toBe(false);
    expect(readLockOwner(paths)).toBeNull();
    const next = await acquireRunnerLock(paths, { mode: 'foreground' });
    locks.push(next);
    expect(statSync(paths.lock).ino).toBe(inode);
    expect(readLockOwner(paths)).toEqual(next.owner);
  });

  test('a second process fails immediately with the holder pid and mode', async () => {
    const paths = scratch();
    const { pid } = await holder(paths);
    expect(lockFds(paths)).toEqual([]);
    const started = Date.now();
    const error = await acquireRunnerLock(paths, { mode: 'foreground' }).catch((error: unknown) => error);
    expect(lockFds(paths)).toEqual([]);
    expect(error).toBeInstanceOf(AlreadyRunningError);
    expect(error).toMatchObject({
      pid,
      mode: 'foreground',
      holder: { pid, mode: 'foreground' },
      message: `the runner is already running (pid ${pid}); use agflow runner status`,
    });
    expect(Date.now() - started).toBeLessThan(500);
    expect(readLockOwner(paths)).toMatchObject({ pid, mode: 'foreground' });
  });

  test('service waiting keeps the event loop alive, reports the holder once, and acquires after release', async () => {
    const paths = scratch();
    const { child, pid } = await holder(paths);
    const seen: unknown[] = [];
    let acquired = false;
    const waiting = acquireRunnerLock(paths, {
      mode: 'service',
      wait: true,
      pollMs: 10,
      onWait: (owner) => {
        seen.push(owner);
      },
    }).then((lock) => {
      locks.push(lock);
      acquired = true;
      return lock;
    });
    await Bun.sleep(60);
    expect(acquired).toBe(false);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ pid, mode: 'foreground' });
    child.kill('SIGTERM');
    await child.exited;
    const lock = await waiting;
    expect(lock.owner.mode).toBe('service');
    expect(readLockOwner(paths)).toEqual(lock.owner);
    expect(seen).toHaveLength(1);
  });

  // FD_CLOEXEC keeps the child from inheriting the lock; Bun.spawn also closes non-stdio descriptors.
  test('SIGKILL frees the lock even while a long-lived child survives', async () => {
    const paths = scratch();
    const { child, childPid } = await holder(paths, true);
    expect(childPid).toBeNumber();
    child.kill('SIGKILL');
    await child.exited;
    expect(() => process.kill(childPid!, 0)).not.toThrow();
    expect(readLockOwner(paths)).toBeNull();
    locks.push(await acquireRunnerLock(paths, { mode: 'foreground' }));
  });

  test('malformed or incomplete identity reads as held with unknown fields, never as unlocked', async () => {
    const paths = scratch();
    locks.push(await acquireRunnerLock(paths, { mode: 'foreground' }));
    for (const text of ['', '{broken', '{"pid":-1,"mode":"wrong"}', 'null']) {
      writeFileSync(paths.lock, text);
      expect(readLockOwner(paths)).toEqual({ pid: null, mode: null, startedAt: null });
      await expect(acquireRunnerLock(paths, { mode: 'foreground' })).rejects.toThrow('pid unknown');
    }
    locks[0].release();
    expect(readLockOwner(paths)).toBeNull();
  });

  test('an aborted waiter closes its fd and can be followed by another acquisition', async () => {
    const paths = scratch();
    const lock = await acquireRunnerLock(paths, { mode: 'foreground' });
    locks.push(lock);
    const held = lockFds(paths);
    const abort = new AbortController();
    const waiting = acquireRunnerLock(paths, { mode: 'service', wait: true, signal: abort.signal });
    abort.abort();
    await expect(waiting).rejects.toThrow();
    expect(lockFds(paths)).toEqual(held);
    lock.release();
    locks.push(await acquireRunnerLock(paths, { mode: 'foreground' }));
  });

  test('a passing status probe never makes a foreground start refuse', async () => {
    const paths = scratch();
    locks.push(await acquireRunnerLock(paths, { mode: 'foreground' }));
    locks.pop()!.release();
    const stop = join(paths.home, 'stop');
    const script = join(paths.home, 'probe.ts');
    writeFileSync(script, `
import { readLockOwner } from ${JSON.stringify(join(import.meta.dir, '../../src/service/lock.ts'))};
import { runnerPaths } from ${JSON.stringify(join(import.meta.dir, '../../src/paths.ts'))};
import { existsSync } from 'node:fs';
const paths = runnerPaths(${JSON.stringify(paths.home)});
console.log('probing');
while (!existsSync(${JSON.stringify(stop)})) readLockOwner(paths);
`);
    const probe = Bun.spawn([process.execPath, script], { stdout: 'pipe', stderr: 'inherit' });
    children.push(probe);
    await probe.stdout.getReader().read();
    try {
      for (let i = 0; i < 2_000; i++) (await acquireRunnerLock(paths, { mode: 'foreground' })).release();
    } finally {
      writeFileSync(stop, '');
    }
    expect(await probe.exited).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `bun test packages/runner/test/service/lock.test.ts packages/runner/test/service/control.test.ts`
Expected: FAIL — `error: Cannot find module '../../src/service/lock' from 'packages/runner/test/service/control.test.ts'`, and the same from `lock.test.ts` (0 pass, 2 fail, 2 errors)

- [ ] **Step 3: Implement**

**File:** `packages/runner/src/service/control.ts` (new)

```ts
// JSON over a private Unix socket; the service owns it only while holding runner.lock (design 7.1–7.2).
import { chmodSync, lstatSync, unlinkSync } from 'node:fs';
import type { RunnerPaths } from '../paths';
import { assertRunnerLock, type RunnerLock } from './lock';

/** Keys are 'METHOD /path'; handlers receive parsed POST JSON (undefined if empty) and the query. */
export type ControlRoutes = Record<string, (body: unknown, query: URLSearchParams) => unknown | Promise<unknown>>;

export interface ControlServer {
  readonly path: string;
  /** Closes active connections too, including requests whose handlers never resolved. */
  stop(): void;
}

export class ControlUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ControlUnavailableError';
  }
}

/** macOS sun_path has 104 bytes including its trailing NUL. Use the same limit on Linux. */
export function checkSocketPath(path: string): void {
  if (Buffer.byteLength(path) > 103) {
    throw new Error(`control socket path ${path} exceeds 103 bytes; choose a shorter AGFLOW_HOME`);
  }
}

function removeSocket(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

const serving = new WeakSet<RunnerLock>();

/** Binds runner.sock (mode 0600) for the lock holder, replacing a stale socket a crashed runner left behind. */
export function startControlServer(options: {
  lock: RunnerLock;
  paths: RunnerPaths;
  routes: ControlRoutes;
}): ControlServer {
  const { lock, paths, routes } = options;
  const path = paths.socket;
  checkSocketPath(path);
  assertRunnerLock(lock, paths);
  if (serving.has(lock)) throw new Error('this runner lock already has a control server');
  removeSocket(path);
  const previousUmask = process.umask(0o177);
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      unix: path,
      async fetch(request, server) {
        // Checks and graceful stops can run for longer than Bun's default idle timeout.
        server.timeout(request, 0);
        const url = new URL(request.url);
        const key = `${request.method} ${url.pathname}`;
        const handler = Object.hasOwn(routes, key) ? routes[key] : undefined;
        if (!handler) return Response.json({ error: `unknown control route: ${key}` }, { status: 404 });
        let body: unknown;
        if (request.method === 'POST') {
          try {
            const text = await request.text();
            body = text === '' ? undefined : JSON.parse(text);
          } catch {
            return Response.json({ error: 'request body is not valid JSON' }, { status: 400 });
          }
        }
        try {
          // Routes that only act (drain, stop) return nothing; JSON has no undefined.
          return Response.json((await handler(body, url.searchParams)) ?? null);
        } catch (error) {
          return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
        }
      },
    });
  } finally {
    process.umask(previousUmask);
  }
  let identity: ReturnType<typeof lstatSync>;
  try {
    chmodSync(path, 0o600);
    identity = lstatSync(path);
  } catch (error) {
    void server.stop(true);
    removeSocket(path);
    throw error;
  }
  serving.add(lock);
  let stopped = false;
  return {
    path,
    stop() {
      if (stopped) return;
      stopped = true;
      // Bun's promise waits for handlers too; an unresponsive handler must not delay shutdown.
      void server.stop(true);
      // A late stop must not remove a replacement socket after the lock was released.
      try {
        const current = lstatSync(path);
        if (current.dev === identity.dev && current.ino === identity.ino) removeSocket(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      } finally {
        serving.delete(lock);
      }
    },
  };
}

/** One JSON request to the running runner; no listener, or no answer in time, is ControlUnavailableError. */
export async function controlRequest<T = unknown>(
  paths: RunnerPaths,
  method: string,
  path: string,
  body?: unknown,
  options: { timeoutMs?: number } = {},
): Promise<T> {
  checkSocketPath(paths.socket);
  const timeoutMs = options.timeoutMs ?? 3_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('control timeoutMs must be positive');
  const signal = AbortSignal.timeout(timeoutMs);
  let response: Response;
  let result: unknown;
  try {
    response = await fetch(`http://localhost${path}`, {
      unix: paths.socket,
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    result = await response.json();
  } catch (error) {
    if (signal.aborted) {
      throw new ControlUnavailableError(`runner control request timed out after ${timeoutMs} ms`, { cause: error });
    }
    const code = (error as NodeJS.ErrnoException).code;
    // Bun 1.3.11 reports failed Unix connects as FailedToOpenSocket on macOS.
    if (code === 'ENOENT' || code === 'ECONNREFUSED' || code === 'FailedToOpenSocket') {
      throw new ControlUnavailableError(`no runner is listening on ${paths.socket}`, { cause: error });
    }
    throw error;
  }
  if (!response.ok) {
    const message =
      result && typeof result === 'object' && 'error' in result ? String(result.error) : response.statusText;
    throw new Error(message);
  }
  return result as T;
}
```

**File:** `packages/runner/src/service/lock.ts` (new)

```ts
// One instance per runner home (design 7.1). Keep the inode: unlinking a locked file defeats flock.
import { dlopen, FFIType, read, type Pointer } from 'bun:ffi';
import { closeSync, constants, fchmodSync, ftruncateSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import type { RunnerPaths } from '../paths';

export type RunnerMode = 'foreground' | 'service';
export interface LockOwner {
  pid: number | null;
  mode: RunnerMode | null;
  startedAt: string | null;
}

export interface RunnerLock {
  readonly path: string;
  readonly owner: Readonly<{ pid: number; mode: RunnerMode; startedAt: string }>;
  readonly held: boolean;
  release(): void;
}

export class AlreadyRunningError extends Error {
  readonly pid: number | null;
  readonly mode: RunnerMode | null;

  constructor(readonly holder: LockOwner) {
    super(`the runner is already running (pid ${holder.pid ?? 'unknown'}); use agflow runner status`);
    this.name = 'AlreadyRunningError';
    this.pid = holder.pid;
    this.mode = holder.mode;
  }
}

const LOCK_SH = 1;
const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;
const EINTR = 4;
// fs.constants has no O_CLOEXEC; openSync passes the raw flag through.
const O_CLOEXEC = process.platform === 'darwin' ? 0x1000000 : 0o2000000;
// A status probe holds LOCK_SH for a moment; that is not a running runner.
const PROBE_GRACE_MS = 50;

function loadNative() {
  const mac = process.platform === 'darwin';
  if (!mac && process.platform !== 'linux') {
    throw new Error(`runner locks are unsupported on ${process.platform}; expected macOS or Linux`);
  }
  const library = dlopen(mac ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    [mac ? '__error' : '__errno_location']: { args: [], returns: FFIType.ptr },
  });
  return {
    flock: library.symbols.flock,
    errno: () => read.i32(library.symbols[mac ? '__error' : '__errno_location']() as Pointer),
    wouldBlock: mac ? 35 : 11,
  };
}

let native: ReturnType<typeof loadNative> | undefined;
function api() {
  return (native ??= loadNative());
}

function flock(fd: number, operation: number): boolean {
  const lib = api();
  while (lib.flock(fd, operation) !== 0) {
    const errno = lib.errno();
    if (errno === EINTR) continue;
    if (errno === lib.wouldBlock) return false;
    throw new Error(`flock failed (errno ${errno})`);
  }
  return true;
}

function openLock(path: string, create: boolean): number {
  // Agents must never keep the runner's lock alive after the runner crashes. Set at open: fcntl is variadic,
  // and on Apple arm64 a fixed-argument FFI call never delivers F_SETFD's argument.
  const flags = create ? constants.O_RDWR | constants.O_CREAT : constants.O_RDONLY;
  return openSync(path, flags | O_CLOEXEC, 0o600);
}

function ownerFromFd(fd: number): LockOwner {
  try {
    const owner = JSON.parse(readFileSync(fd, 'utf8'));
    if (
      owner &&
      Number.isSafeInteger(owner.pid) &&
      owner.pid > 0 &&
      (owner.mode === 'foreground' || owner.mode === 'service') &&
      typeof owner.startedAt === 'string' &&
      Number.isFinite(Date.parse(owner.startedAt))
    ) {
      return { pid: owner.pid, mode: owner.mode, startedAt: owner.startedAt };
    }
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  // flock is authoritative, including the brief window before the owner writes its identity.
  return { pid: null, mode: null, startedAt: null };
}

/** null means unlocked; unknown fields mean held but its identity is not readable yet. */
export function readLockOwner(paths: RunnerPaths): LockOwner | null {
  let fd: number;
  try {
    fd = openLock(paths.lock, false);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    if (flock(fd, LOCK_SH | LOCK_NB)) {
      flock(fd, LOCK_UN);
      return null;
    }
    return ownerFromFd(fd);
  } finally {
    closeSync(fd);
  }
}

const heldLocks = new WeakSet<RunnerLock>();

/** The control server requires a real acquisition in this process for this home. */
export function assertRunnerLock(lock: RunnerLock, paths: RunnerPaths): void {
  if (!heldLocks.has(lock) || !lock.held || lock.owner.pid !== process.pid || lock.path !== paths.lock) {
    throw new Error(`a held runner lock for ${paths.lock} is required to bind the control socket`);
  }
}

export interface AcquireRunnerLockOptions {
  mode: RunnerMode;
  wait?: boolean;
  onWait?: (holder: LockOwner) => void;
  pollMs?: number;
  signal?: AbortSignal;
}

/**
 * Takes runner.lock before anything touches runner.db. A foreground start fails at once with AlreadyRunningError;
 * the service waits (wait: true) so launchd's KeepAlive does not loop.
 */
export async function acquireRunnerLock(paths: RunnerPaths, options: AcquireRunnerLockOptions): Promise<RunnerLock> {
  const pollMs = options.pollMs ?? 100;
  if (!Number.isFinite(pollMs) || pollMs <= 0) throw new Error('lock pollMs must be positive');
  options.signal?.throwIfAborted();
  mkdirSync(paths.runner, { recursive: true, mode: 0o700 });
  const fd = openLock(paths.lock, true);
  try {
    let notified = false;
    let probeDeadline: number | undefined;
    while (!flock(fd, LOCK_EX | LOCK_NB)) {
      if (!notified) {
        const holder = readLockOwner(paths);
        if (holder === null) {
          // Only shared probes (status, install, stop) hold it: retry briefly instead of refusing.
          probeDeadline ??= Date.now() + PROBE_GRACE_MS;
          if (Date.now() < probeDeadline) {
            await delay(1, undefined, { signal: options.signal });
            continue;
          }
        }
        const owner = holder ?? { pid: null, mode: null, startedAt: null };
        if (!options.wait) throw new AlreadyRunningError(owner);
        notified = true;
        options.onWait?.(owner);
      }
      await delay(pollMs, undefined, { signal: options.signal });
    }
    options.signal?.throwIfAborted();
    const owner = Object.freeze({ pid: process.pid, mode: options.mode, startedAt: new Date().toISOString() });
    fchmodSync(fd, 0o600);
    ftruncateSync(fd, 0);
    const bytes = Buffer.from(`${JSON.stringify(owner)}\n`);
    for (let offset = 0; offset < bytes.length; ) {
      offset += writeSync(fd, bytes, offset, bytes.length - offset, offset);
    }
    let held = true;
    const lock: RunnerLock = Object.freeze({
      path: paths.lock,
      owner,
      get held() {
        return held;
      },
      release() {
        if (!held) return;
        held = false;
        heldLocks.delete(lock);
        try {
          flock(fd, LOCK_UN);
        } finally {
          closeSync(fd);
        }
      },
    });
    heldLocks.add(lock);
    return lock;
  } catch (error) {
    // Closing also releases flock if recording the identity failed after acquisition.
    closeSync(fd);
    throw error;
  }
}
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `bun test packages/runner/test/service/lock.test.ts packages/runner/test/service/control.test.ts && bun test && bun run typecheck`
Expected: the task's tests pass; then the whole suite passes (`0 fail`) and `tsc` exits 0.

`O_CLOEXEC` is passed to `open` (0x1000000 on darwin, 0o2000000 on Linux): setting `FD_CLOEXEC` through `bun:ffi`'s variadic `fcntl` did nothing on darwin-arm64, and the test checks the flag on the real descriptor. A status probe takes the lock shared for an instant, so a foreground start retries for up to 50 ms before it reports a holder. A held lock whose identity is not written yet reads `(pid unknown)`. A handler that returns undefined answers null (action routes such as `POST /stop`), and `stop()` unlinks the socket only if it is still the same inode. Socket paths over 103 bytes are refused on both sides, so tests use short `/tmp/agf-*` roots.

- [ ] **Step 5: Commit**

```bash
git add -A 'packages/runner/src/service/control.ts' 'packages/runner/src/service/lock.ts' 'packages/runner/test/service/control.test.ts' 'packages/runner/test/service/lock.test.ts'
git commit -m 'M2C Task 4: Single instance: runner.lock and the control socket' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

### Task 5: The runner log and the service-run records

launchd does not rotate logs, so the runner writes logs/runner.log itself (design 7.1). `RotatingLog` is M2c's `Logger` (X-7): 10 MiB per file and five older files, a log call never throws, and the foreground tees every line to the terminal. `ServiceRuns` records each start and exit in logs/service-runs.json, which only the lock holder writes. `runner status` reads the last exit from it when the runner is down, and the crash-loop guard counts unclean exits in it: three within `crashLoopWindow` (10 minutes, design 12). `forgetUnclean` is undrain's part of X-41.

**Files:**
- Create: `packages/runner/src/service/log.ts`
- Create: `packages/runner/src/service/runs.ts`
- Test: `packages/runner/test/service/log.test.ts`
- Test: `packages/runner/test/service/runs.test.ts`

- [ ] **Step 1: Write the failing tests**

**File:** `packages/runner/test/service/log.test.ts` (new)

```ts
import { afterEach, describe, expect, test } from 'bun:test';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '../../src/log';
import { runnerPaths } from '../../src/paths';
import { launchdLogPaths, RotatingLog, tailLines, trimLaunchdLogs } from '../../src/service/log';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'agf-log-'));
  dirs.push(dir);
  return runnerPaths(dir);
}
const now = () => Date.parse('2026-10-28T12:00:00.000Z');

describe('RotatingLog', () => {
  test('implements Logger, writes private synchronous lines and tees only in the foreground', () => {
    const paths = scratch();
    const terminal: string[] = [];
    const logger: Logger = new RotatingLog(paths, { foreground: true, now, terminal: (line) => terminal.push(line) });
    logger.debug('debug');
    logger.info('ready', { pid: 42 });
    logger.warn('warning');
    logger.error('failure');
    const lines = readFileSync(paths.runnerLog, 'utf8').trimEnd().split('\n');
    expect(lines).toEqual([
      '2026-10-28T12:00:00.000Z debug debug',
      '2026-10-28T12:00:00.000Z info ready {"pid":42}',
      '2026-10-28T12:00:00.000Z warn warning',
      '2026-10-28T12:00:00.000Z error failure',
    ]);
    expect(terminal).toEqual(lines.map((line) => `${line}\n`));
    expect(statSync(paths.logs).mode & 0o777).toBe(0o700);
    expect(statSync(paths.runnerLog).mode & 0o777).toBe(0o600);
    new RotatingLog(paths, { foreground: false, now, terminal: (line) => terminal.push(line) }).info('service');
    expect(terminal).toHaveLength(4);
    expect(tailLines(paths, 1)[0]).toEndWith('info service');
  });

  test('rotates by bytes only above the limit, reopens at the existing size and keeps five older files', () => {
    const paths = scratch();
    const line = '2026-10-28T12:00:00.000Z info é\n';
    const options = { foreground: false, now, maxBytes: Buffer.byteLength(line) * 2 };
    const log = new RotatingLog(paths, options);
    log.info('é');
    log.info('é');
    expect(existsSync(`${paths.runnerLog}.1`)).toBe(false);
    const reopened = new RotatingLog(paths, options);
    reopened.info('new');
    expect(readFileSync(`${paths.runnerLog}.1`, 'utf8')).toBe(line.repeat(2));
    for (let i = 0; i < 7; i++) reopened.info(`oversized ${i} ${'x'.repeat(100)}`);
    expect(readFileSync(paths.runnerLog, 'utf8')).toContain('oversized 6');
    for (let i = 1; i <= 5; i++) {
      expect(readFileSync(`${paths.runnerLog}.${i}`, 'utf8')).toContain(`oversized ${6 - i}`);
    }
    expect(existsSync(`${paths.runnerLog}.6`)).toBe(false);
  });

  test('supports an injected keep count including zero', () => {
    const paths = scratch();
    const log = new RotatingLog(paths, { foreground: false, now, maxBytes: 1, keep: 1 });
    log.info('first');
    expect(existsSync(`${paths.runnerLog}.1`)).toBe(false);
    log.info('second');
    log.info('third');
    expect(tailLines(paths)).toHaveLength(2);
    expect(existsSync(`${paths.runnerLog}.2`)).toBe(false);
    const none = scratch();
    const noHistory = new RotatingLog(none, { foreground: false, maxBytes: 1, keep: 0 });
    noHistory.info('first');
    noHistory.info('second');
    expect(existsSync(`${none.runnerLog}.1`)).toBe(false);
    expect(tailLines(none)).toHaveLength(1);
  });

  test('an oversized first entry in an empty or missing runner.log does not shift the older files', () => {
    for (const empty of [true, false]) {
      const paths = scratch();
      mkdirSync(paths.logs, { recursive: true });
      writeFileSync(`${paths.runnerLog}.1`, 'older\n');
      if (empty) writeFileSync(paths.runnerLog, '');
      new RotatingLog(paths, { foreground: false, now, maxBytes: 10 }).info('an entry longer than the limit');
      expect(readFileSync(`${paths.runnerLog}.1`, 'utf8')).toBe('older\n');
      expect(existsSync(`${paths.runnerLog}.2`)).toBe(false);
      expect(tailLines(paths, 1)).toEqual(['2026-10-28T12:00:00.000Z info an entry longer than the limit']);
    }
  });

    test('serializes rich fields and keeps multiline messages on one line; hostile fields never throw', () => {
    const paths = scratch();
    const log = new RotatingLog(paths, { foreground: false, now });
    log.info('one\ntwo\rthree', { nested: { error: new Error('bad'), big: 12n, absent: undefined } });
    const lines = tailLines(paths);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('one\\ntwo\\rthree');
    expect(lines[0]).toContain('"error":"bad"');
    expect(lines[0]).toContain('"big":"12"');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const throwingGetter = {
      get broken() {
        throw new Error('getter');
      },
    };
    const throwingJson = {
      bad: {
        toJSON() {
          throw new Error('json');
        },
      },
    };
    for (const fields of [circular, throwingGetter, throwingJson, { toJSON: () => undefined }]) {
      expect(() => log.error('still logged', fields)).not.toThrow();
    }
    expect(tailLines(paths)).toHaveLength(5);
    expect(tailLines(paths, 1)[0]).toEndWith('{"serializationError":"unserializable fields"}');
  });

  test('write failures and throwing terminal writers cannot escape a log call', () => {
    const paths = scratch();
    mkdirSync(paths.logs, { recursive: true });
    mkdirSync(paths.runnerLog);
    const terminal: string[] = [];
    const log = new RotatingLog(paths, { foreground: true, terminal: (line) => terminal.push(line) });
    expect(() => log.error('disk failure')).not.toThrow();
    expect(terminal.join('')).toContain('disk failure');
    expect(terminal.join('')).toContain('could not write runner log');
    const broken = new RotatingLog(scratch(), {
      foreground: true,
      terminal: () => {
        throw new Error('terminal');
      },
    });
    expect(() => broken.info('survives')).not.toThrow();
    const silent: string[] = [];
    const quiet = new RotatingLog(paths, { foreground: false, terminal: (line) => silent.push(line) });
    expect(() => quiet.error('failed')).not.toThrow();
    expect(silent).toEqual([]);
  });
});

describe('tailLines', () => {
  test('returns the last twenty oldest first across rotations, and handles missing and partial files', () => {
    const paths = scratch();
    expect(tailLines(paths)).toEqual([]);
    mkdirSync(paths.logs, { recursive: true });
    writeFileSync(`${paths.runnerLog}.2`, 'old\n');
    writeFileSync(`${paths.runnerLog}.1`, Array.from({ length: 25 }, (_, i) => `line ${i}\n`).join(''));
    writeFileSync(paths.runnerLog, 'line 25\nline 26\n');
    expect(tailLines(paths)).toEqual(Array.from({ length: 20 }, (_, i) => `line ${i + 7}`));
    expect(tailLines(paths.runnerLog, 30)).toHaveLength(28);
    expect(tailLines(paths, 0)).toEqual([]);
    // 10007 bytes: the 4096-byte reads start at odd offsets, inside a two-byte 'é'.
    writeFileSync(paths.runnerLog, `${'é'.repeat(5000)}\n\nlast!`);
    expect(tailLines(paths, 3)).toEqual(['é'.repeat(5000), '', 'last!']);
    rmSync(paths.runnerLog);
    expect(tailLines(paths, 1)).toEqual(['line 24']);
  });
});

describe('trimLaunchdLogs', () => {
  test('truncates only oversized files in place, preserving an open append descriptor', () => {
    const paths = scratch();
    const logs = launchdLogPaths(paths);
    expect(logs).toEqual({ stdout: join(paths.logs, 'launchd.out.log'), stderr: join(paths.logs, 'launchd.err.log') });
    expect(trimLaunchdLogs(paths, 10)).toEqual([]);
    mkdirSync(paths.logs, { recursive: true });
    writeFileSync(logs.stdout, 'x'.repeat(11));
    writeFileSync(logs.stderr, 'x'.repeat(10));
    const inode = statSync(logs.stdout).ino;
    const fd = openSync(logs.stdout, 'a');
    try {
      expect(trimLaunchdLogs(paths, 10)).toEqual([logs.stdout]);
      expect(statSync(logs.stdout).ino).toBe(inode);
      expect(statSync(logs.stdout).size).toBe(0);
      expect(statSync(logs.stderr).size).toBe(10);
      writeSync(fd, 'new');
      expect(readFileSync(logs.stdout, 'utf8')).toBe('new');
      writeFileSync(logs.stderr, 'x'.repeat(12));
      expect(trimLaunchdLogs(paths, 10)).toEqual([logs.stderr]);
    } finally {
      closeSync(fd);
    }
  });
});
```

**File:** `packages/runner/test/service/runs.test.ts` (new)

```ts
import { afterEach, describe, expect, test } from 'bun:test';
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_TIMINGS } from '../../src/config';
import { runnerPaths } from '../../src/paths';
import { CRASH_LOOP_EXITS, crashLoopVerdict, ServiceRuns } from '../../src/service/runs';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'agf-runs-'));
  dirs.push(dir);
  const paths = runnerPaths(dir);
  let time = 1_000_000;
  const runs = new ServiceRuns(paths, { now: () => time });
  return {
    paths,
    runs,
    file: join(paths.logs, 'service-runs.json'),
    now: () => time,
    advance: (ms = 1) => {
      time += ms;
    },
  };
}

describe('ServiceRuns', () => {
  test('starts empty and atomically replaces private, complete JSON without leaving temporary files', () => {
    const { paths, runs, file, advance } = fixture();
    expect(runs.records()).toEqual([]);
    expect(runs.lastExit({ running: false })).toBeNull();
    const id = runs.start({ pid: 123, mode: 'foreground' });
    expect(runs.records()).toEqual([{ id, pid: 123, mode: 'foreground', startedAt: 1_000_000 }]);
    const before = readFileSync(file, 'utf8');
    const fd = openSync(file, 'r');
    try {
      advance();
      runs.finish(id, { clean: true, code: 0, reason: 'suspend' });
      // An already open reader still sees the complete old inode, not an in-place rewrite.
      expect(readFileSync(fd, 'utf8')).toBe(before);
      expect(JSON.parse(readFileSync(file, 'utf8')).runs[0].reason).toBe('suspend');
    } finally {
      closeSync(fd);
    }
    expect(readdirSync(paths.logs)).toEqual(['service-runs.json']);
    expect(statSync(paths.logs).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(new ServiceRuns(paths).lastExit({ running: false })).toEqual({ reason: 'suspend', code: 0, at: 1_000_001, clean: true });
  });

  test('the next start closes an abandoned run at detection time as unclean with an unknown code', () => {
    const f = fixture();
    const abandoned = f.runs.start({ pid: 123, mode: 'service' });
    f.advance(100);
    const reopened = new ServiceRuns(f.paths, { now: f.now });
    const current = reopened.start({ pid: 456, mode: 'foreground' });
    expect(current).not.toBe(abandoned);
    expect(reopened.records()[0]).toMatchObject({
      endedAt: f.now(),
      clean: false,
      code: null,
      reason: 'exited without a clean shutdown',
    });
    expect(crashLoopVerdict(reopened, { now: f.now(), window: 1000 }).unclean).toBe(1);
    reopened.finish(current, { clean: false, code: 1, reason: 'uncaught\nerror' });
    expect(reopened.lastExit({ running: false })).toEqual({ reason: 'uncaught error', code: 1, at: f.now(), clean: false });
  });

  test('invalid JSON and invalid records are empty history and do not prevent a new start', () => {
    const f = fixture();
    mkdirSync(f.paths.logs, { recursive: true });
    const corrupt = [
      '{',
      '{}',
      JSON.stringify({ runs: [{ id: 'bad', pid: '123' }] }),
      JSON.stringify({ runs: [{ id: 'bad', pid: 123, mode: 'service', startedAt: 1, endedAt: 2 }] }),
    ];
    for (const content of corrupt) {
      writeFileSync(f.file, content);
      expect(f.runs.records()).toEqual([]);
      expect(f.runs.lastExit({ running: false })).toBeNull();
      expect(() => f.runs.start({ pid: 123, mode: 'service' })).not.toThrow();
      expect(f.runs.records()).toHaveLength(1);
    }
  });

  test('keeps the newest fifty runs and reports the newest finished one while another is running', () => {
    const f = fixture();
    const ids: string[] = [];
    for (let i = 0; i < 55; i++) {
      ids.push(f.runs.start({ pid: 123, mode: 'service' }));
      f.runs.finish(ids[i]!, { clean: true, code: i % 2, reason: `exit ${i}` });
      f.advance();
    }
    expect(f.runs.records().map((run) => run.id)).toEqual(ids.slice(-50));
    f.runs.start({ pid: 123, mode: 'service' });
    expect(f.runs.records()).toHaveLength(50);
    expect(f.runs.lastExit({ running: true })).toEqual({ reason: 'exit 54', code: 0, at: 1_000_054, clean: true });
  });

  test('while the runner is down, a newest run without an exit record is the last exit, at its start', () => {
    const f = fixture();
    const clean = f.runs.start({ pid: 123, mode: 'service' });
    f.advance();
    f.runs.finish(clean, { clean: true, code: 0, reason: 'suspend' });
    f.advance(100);
    const killed = new ServiceRuns(f.paths, { now: f.now });
    killed.start({ pid: 456, mode: 'foreground' });
    f.advance(100);
    const status = new ServiceRuns(f.paths, { now: f.now });
    expect(status.lastExit({ running: false })).toEqual({
      reason: 'exited without a clean shutdown',
      code: null,
      at: 1_000_101,
      clean: false,
    });
    expect(status.lastExit({ running: true })).toEqual({ reason: 'suspend', code: 0, at: 1_000_001, clean: true });
  });

  test('lastExit and lastError use exit time even after the wall clock steps backward', () => {
    const f = fixture();
    const first = f.runs.start({ pid: 123, mode: 'service' });
    f.runs.finish(first, { clean: false, code: 1, reason: 'newest error' });
    f.advance(-100);
    const second = f.runs.start({ pid: 123, mode: 'service' });
    f.runs.finish(second, { clean: false, code: 2, reason: 'earlier time' });
    expect(f.runs.lastExit({ running: false })).toEqual({ reason: 'newest error', code: 1, at: 1_000_000, clean: false });
    expect(crashLoopVerdict(f.runs, { now: 1_000_000, window: 1000 }).lastError).toBe('newest error');
  });
});

describe('crashLoopVerdict', () => {
  test('requires three unclean exits in (now - window, now], reporting the newest error', () => {
    const f = fixture();
    const window = DEFAULT_TIMINGS.crashLoopWindow;
    expect(CRASH_LOOP_EXITS).toBe(3);
    for (let i = 0; i < 3; i++) {
      const id = f.runs.start({ pid: 123, mode: 'service' });
      f.runs.finish(id, { clean: false, code: 1, reason: `crash ${i}` });
      expect(crashLoopVerdict(f.runs, { now: f.now(), window })).toEqual({
        crashLoop: i === 2,
        unclean: i + 1,
        lastError: `crash ${i}`,
      });
      f.advance();
    }
    expect(crashLoopVerdict(f.runs.records(), { now: 999_999, window }).unclean).toBe(0);
    expect(crashLoopVerdict(f.runs, { now: 1_000_000 + window, window }).unclean).toBe(2);
    f.advance(window);
    expect(crashLoopVerdict(f.runs, { now: f.now(), window })).toEqual({
      crashLoop: false,
      unclean: 0,
      lastError: null,
    });
  });

  test('clean exits, including foreground refusals with code 1, never count as crashes', () => {
    const f = fixture();
    const reasons = ['suspend', 'stop', '4409 replacement', '4403 retired', '4426 incompatible', 'machine mismatch'];
    for (const reason of reasons) {
      const id = f.runs.start({ pid: 123, mode: 'foreground' });
      f.runs.finish(id, { clean: true, code: 1, reason });
    }
    expect(crashLoopVerdict(f.runs, { now: f.now(), window: 1000 })).toEqual({
      crashLoop: false,
      unclean: 0,
      lastError: null,
    });
    expect(f.runs.lastExit({ running: false })?.reason).toBe('machine mismatch');
  });

  test('forgetUnclean persists without deleting history or forgetting later crashes in the same millisecond', () => {
    const f = fixture();
    for (let i = 0; i < 3; i++) {
      const id = f.runs.start({ pid: 123, mode: 'service' });
      f.runs.finish(id, { clean: false, code: 1, reason: `crash ${i}` });
    }
    const last = f.runs.lastExit({ running: false });
    f.runs.forgetUnclean({ at: f.now() - 1 });
    expect(crashLoopVerdict(f.runs, { now: f.now(), window: 1000 }).crashLoop).toBe(true);
    f.runs.forgetUnclean();
    const reopened = new ServiceRuns(f.paths, { now: f.now });
    expect(reopened.lastExit({ running: false })).toEqual(last);
    expect(reopened.records()).toHaveLength(3);
    expect(crashLoopVerdict(reopened, { now: f.now(), window: 1000 }).unclean).toBe(0);
    const id = reopened.start({ pid: 123, mode: 'service' });
    reopened.finish(id, { clean: false, code: 1, reason: 'new crash' });
    expect(reopened.crashLoop()).toBeNull();
    expect(crashLoopVerdict(reopened.records(), { now: f.now(), window: 1000 })).toEqual({
      crashLoop: false,
      unclean: 1,
      lastError: 'new crash',
    });
  });

  test('forgetUnclean also forgets a dead run without an exit record, but never the run of the calling process', () => {
    const f = fixture();
    for (let i = 0; i < 2; i++) {
      const id = f.runs.start({ pid: 123, mode: 'service' });
      f.runs.finish(id, { clean: false, code: 1, reason: `crash ${i}` });
    }
    f.runs.start({ pid: 123, mode: 'service' });
    f.advance();
    // undrain while the runner is down: a new instance under the lock, after a SIGKILLed third run.
    const down = new ServiceRuns(f.paths, { now: f.now });
    down.forgetUnclean();
    expect(down.records().at(-1)).toMatchObject({ reason: 'exited without a clean shutdown', uncleanForgotten: true });
    const next = new ServiceRuns(f.paths, { now: f.now });
    const running = next.start({ pid: 456, mode: 'service' });
    expect(crashLoopVerdict(next, { now: f.now(), window: 1000 }).unclean).toBe(0);
    // undrain inside the running service keeps its own run open, so a later crash still counts.
    next.forgetUnclean();
    expect(next.records().at(-1)).toEqual({ id: running, pid: 456, mode: 'service', startedAt: f.now() });
    f.advance();
    next.finish(running, { clean: false, code: 1, reason: 'later crash' });
    expect(crashLoopVerdict(next, { now: f.now(), window: 1000 })).toMatchObject({
      unclean: 1,
      lastError: 'later crash',
    });
  });

  test('another instance forgetting unclean exits keeps the live run it is told about open', () => {
    const f = fixture();
    const live = f.runs.start({ pid: 123, mode: 'service' });
    f.advance();
    // The undrain handler of the running service, with its own instance.
    new ServiceRuns(f.paths, { now: f.now }).forgetUnclean({ current: live });
    expect(f.runs.records()).toEqual([{ id: live, pid: 123, mode: 'service', startedAt: 1_000_000 }]);
    f.runs.finish(live, { clean: true, code: 0, reason: 'suspend' });
    expect(f.runs.lastExit({ running: false })).toEqual({ reason: 'suspend', code: 0, at: 1_000_001, clean: true });
  });

  test('a recorded crash loop outlives the window and clean runs until forgetUnclean clears it', () => {
    const f = fixture();
    const window = DEFAULT_TIMINGS.crashLoopWindow;
    for (let i = 0; i < 3; i++) {
      const id = f.runs.start({ pid: 123, mode: 'service' });
      f.runs.finish(id, { clean: false, code: 1, reason: `crash ${i}` });
    }
    const guard = f.runs.start({ pid: 123, mode: 'service' });
    const verdict = crashLoopVerdict(f.runs, { now: f.now(), window });
    expect(verdict).toEqual({ crashLoop: true, unclean: 3, lastError: 'crash 2' });
    f.runs.markCrashLoop(verdict);
    f.advance();
    f.runs.finish(guard, { clean: true, code: 0, reason: 'suspend' });
    f.advance(60 * 60 * 1000);
    const later = new ServiceRuns(f.paths, { now: f.now });
    const next = later.start({ pid: 456, mode: 'service' });
    expect(later.crashLoop()).toEqual({ at: 1_000_000, lastError: 'crash 2' });
    expect(crashLoopVerdict(later, { now: f.now(), window })).toEqual({
      crashLoop: true,
      unclean: 0,
      lastError: 'crash 2',
    });
    later.forgetUnclean();
    expect(later.crashLoop()).toBeNull();
    expect(crashLoopVerdict(later, { now: f.now(), window })).toEqual({
      crashLoop: false,
      unclean: 0,
      lastError: null,
    });
    expect(later.records().at(-1)).toEqual({ id: next, pid: 456, mode: 'service', startedAt: f.now() });
  });
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `bun test packages/runner/test/service/log.test.ts packages/runner/test/service/runs.test.ts`
Expected: FAIL — `error: Cannot find module '../../src/service/log' from 'packages/runner/test/service/log.test.ts'`, and `runs.test.ts` on `'../../src/service/runs'` (0 pass, 2 fail, 2 errors)

- [ ] **Step 3: Implement**

**File:** `packages/runner/src/service/log.ts` (new)

```ts
// The service's Logger (X-7): synchronous writes leave the last messages available after a crash.
import {
  appendFileSync,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { LogFields, Logger, LogLevel } from '../log';
import type { RunnerPaths } from '../paths';

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

export interface RotatingLogOptions {
  foreground: boolean;
  maxBytes?: number;
  keep?: number;
  now?: () => number;
  /** Receives a complete line including its newline. All levels default to stderr. */
  terminal?: (line: string) => void;
}

function fieldsJson(fields: LogFields): string {
  try {
    if (Object.keys(fields).length === 0) return '';
    const seen = new WeakSet<object>();
    const json = JSON.stringify(fields, (_key, value: unknown) => {
      if (value instanceof Error) return value.message;
      if (typeof value === 'bigint') return value.toString();
      if (value && typeof value === 'object') {
        if (seen.has(value)) return '[Circular]';
        seen.add(value);
      }
      return value;
    });
    return ` ${json ?? '{"serializationError":"unserializable fields"}'}`;
  } catch {
    // Getters and toJSON can throw too; never let diagnostic data take down the runner.
    return ' {"serializationError":"unserializable fields"}';
  }
}

/** runner.log with size-based rotation, teed to the terminal in the foreground; launchd rotates nothing (7.1). */
export class RotatingLog implements Logger {
  private readonly maxBytes: number;
  private readonly keep: number;
  private readonly now: () => number;
  private readonly terminal: (line: string) => void;

  constructor(
    private readonly paths: RunnerPaths,
    private readonly options: RotatingLogOptions,
  ) {
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.keep = options.keep ?? 5;
    this.now = options.now ?? Date.now;
    this.terminal =
      options.terminal ??
      ((line) => {
        process.stderr.write(line);
      });
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes <= 0) throw new Error('log maxBytes must be positive');
    if (!Number.isSafeInteger(this.keep) || this.keep < 0) throw new Error('log keep must be nonnegative');
  }

  debug(message: string, fields?: LogFields): void {
    this.write('debug', message, fields);
  }

  info(message: string, fields?: LogFields): void {
    this.write('info', message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.write('warn', message, fields);
  }

  error(message: string, fields?: LogFields): void {
    this.write('error', message, fields);
  }

  private tee(line: string): void {
    if (!this.options.foreground) return;
    try {
      this.terminal(line);
    } catch {
      // A broken terminal must not stop file logging.
    }
  }

  private write(level: LogLevel, message: string, fields?: LogFields): void {
    try {
      const text = message.replace(/\r/g, '\\r').replace(/\n/g, '\\n');
      const line = `${new Date(this.now()).toISOString()} ${level} ${text}${fields ? fieldsJson(fields) : ''}\n`;
      this.tee(line);
      mkdirSync(this.paths.logs, { recursive: true, mode: 0o700 });
      let size = 0;
      try {
        size = statSync(this.paths.runnerLog).size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      // An oversized entry is written whole; don't rotate an empty file before it.
      if (size > 0 && size + Buffer.byteLength(line) > this.maxBytes) this.rotate();
      appendFileSync(this.paths.runnerLog, line, { mode: 0o600 });
    } catch {
      this.tee('agflow: could not write runner log\n');
    }
  }

  private rotate(): void {
    const path = this.paths.runnerLog;
    if (this.keep === 0) {
      rmSync(path, { force: true });
      return;
    }
    rmSync(`${path}.${this.keep}`, { force: true });
    for (let i = this.keep - 1; i >= 0; i--) {
      try {
        renameSync(i === 0 ? path : `${path}.${i}`, `${path}.${i + 1}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
}

function fileTail(path: string, count: number): string[] {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  try {
    let position = fstatSync(fd).size;
    let newlines = 0;
    const chunks: Buffer[] = [];
    while (position > 0 && newlines <= count) {
      const length = Math.min(position, 4096);
      position -= length;
      const buffer = Buffer.alloc(length);
      const bytes = readSync(fd, buffer, 0, length, position);
      const chunk = buffer.subarray(0, bytes);
      chunks.push(chunk);
      for (const byte of chunk) if (byte === 10) newlines++;
    }
    // Decode after joining: a multibyte character can straddle a read boundary.
    const text = Buffer.concat(chunks.reverse()).toString('utf8');
    if (!text) return [];
    const lines = text.split('\n');
    if (lines.at(-1) === '') lines.pop();
    return lines.slice(-count);
  } finally {
    closeSync(fd);
  }
}

/** Best-effort status reads need no lock; rotations may disappear while we read them. */
export function tailLines(paths: RunnerPaths | string, count = 20): string[] {
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('tail count must be nonnegative');
  if (count === 0) return [];
  const path = typeof paths === 'string' ? paths : paths.runnerLog;
  let lines = fileTail(path, count);
  if (lines.length >= count) return lines;
  let names: string[];
  try {
    names = readdirSync(dirname(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return lines;
    throw error;
  }
  const prefix = `${basename(path)}.`;
  const rotations = names
    .filter((name) => name.startsWith(prefix) && /^[1-9][0-9]*$/.test(name.slice(prefix.length)))
    .sort((a, b) => Number(a.slice(prefix.length)) - Number(b.slice(prefix.length)));
  for (const name of rotations) {
    lines = [...fileTail(join(dirname(path), name), count - lines.length), ...lines];
    if (lines.length >= count) break;
  }
  return lines;
}

/** The plist's StandardOutPath and StandardErrorPath. */
export function launchdLogPaths(paths: RunnerPaths): { stdout: string; stderr: string } {
  return { stdout: join(paths.logs, 'launchd.out.log'), stderr: join(paths.logs, 'launchd.err.log') };
}

/** Keep launchd's open O_APPEND descriptors valid: truncate in place, never rotate these files. */
export function trimLaunchdLogs(paths: RunnerPaths, limitBytes = DEFAULT_MAX_BYTES): string[] {
  if (!Number.isSafeInteger(limitBytes) || limitBytes < 0) throw new Error('launchd log limit must be nonnegative');
  const trimmed: string[] = [];
  for (const path of Object.values(launchdLogPaths(paths))) {
    try {
      if (statSync(path).size > limitBytes) {
        truncateSync(path, 0);
        trimmed.push(path);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return trimmed;
}
```

**File:** `packages/runner/src/service/runs.ts` (new)

```ts
// Service history (design 7.1, X-41). Only the runner.lock holder may call the mutating methods;
// status readers need no lock because every update replaces a complete file atomically.
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { RunnerPaths } from '../paths';
import type { RunnerMode } from './lock';

const Time = z.number().int().nonnegative();
const RunningSchema = z.strictObject({
  id: z.string().min(1),
  pid: z.number().int().positive(),
  mode: z.enum(['foreground', 'service']),
  startedAt: Time,
});
const FinishedSchema = RunningSchema.extend({
  endedAt: Time,
  clean: z.boolean(),
  code: z.number().int().nullable(),
  reason: z.string().refine((reason) => !/[\r\n]/.test(reason), { error: 'reason must be one line' }),
  uncleanForgotten: z.boolean().optional(),
});
const ServiceRunSchema = z.union([RunningSchema, FinishedSchema]);
const CrashLoopSchema = z.strictObject({ at: Time, lastError: z.string().nullable() });
const HistorySchema = z.strictObject({
  runs: z.array(ServiceRunSchema).max(50),
  /** Set when the guard trips; it outlives the window and clean runs, until undrain (X-41). */
  crashLoop: CrashLoopSchema.optional(),
});

/** All timestamps are wall-clock epoch milliseconds. */
export type ServiceRun = z.output<typeof ServiceRunSchema>;
type FinishedRun = z.output<typeof FinishedSchema>;
type History = z.output<typeof HistorySchema>;

/** The last exit status reports while the runner is down. */
export interface LastExit {
  reason: string;
  /** null when an abrupt exit was detected later, without an observed exit code. */
  code: number | null;
  /** For a run that died without an exit record, its start: the exit time is unknown. */
  at: number;
  clean: boolean;
}

function finished(run: ServiceRun): run is FinishedRun {
  return 'endedAt' in run;
}

function newest(runs: readonly FinishedRun[]): FinishedRun | undefined {
  return runs.reduce<FinishedRun | undefined>(
    (last, run) => (!last || run.endedAt >= last.endedAt ? run : last),
    undefined,
  );
}

const ABANDONED = 'exited without a clean shutdown';

/** A run with no exit record whose process is gone: SIGKILL, OOM or power loss leave no time or exit code. */
function abandoned(run: ServiceRun, at: number): FinishedRun {
  return finished(run) ? run : { ...run, endedAt: at, clean: false, code: null, reason: ABANDONED };
}

export class ServiceRuns {
  readonly path: string;
  private readonly now: () => number;
  /** The run this process started; every other run without an exit record belongs to a dead process. */
  private current: string | undefined;

  constructor(
    private readonly paths: RunnerPaths,
    options: { now?: () => number } = {},
  ) {
    this.path = join(paths.logs, 'service-runs.json');
    this.now = options.now ?? Date.now;
  }

  /** Read afresh so a status reader also works across service restarts and undrain. */
  records(): ServiceRun[] {
    return this.history().runs;
  }

  /** The crash loop the guard recorded, if undrain has not cleared it yet. */
  crashLoop(): { at: number; lastError: string | null } | null {
    return this.history().crashLoop ?? null;
  }

  private history(): History {
    let text: string;
    try {
      text = readFileSync(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { runs: [] };
      throw error;
    }
    try {
      return HistorySchema.parse(JSON.parse(text));
    } catch {
      // Corrupt history must not prevent a start; the next writer replaces it with fresh history.
      return { runs: [] };
    }
  }

  /** Records this process's run; an earlier run without an exit record counts as unclean from now on. */
  start(input: { pid: number; mode: RunnerMode }): string {
    const at = this.now();
    const run = RunningSchema.parse({ ...input, id: randomUUID(), startedAt: at });
    const history = this.history();
    // The exit time is the detection time, the earliest moment it is known.
    const runs = history.runs.map((previous) => abandoned(previous, at));
    this.save({ ...history, runs: [...runs, run] });
    this.current = run.id;
    return run.id;
  }

  finish(id: string, exit: { clean: boolean; code: number; reason: string }): void {
    const history = this.history();
    const runs = history.runs;
    const index = runs.findIndex((run) => run.id === id);
    const run = runs[index];
    if (!run) throw new Error(`unknown service run: ${id}`);
    if (finished(run)) throw new Error(`service run already finished: ${id}`);
    runs[index] = FinishedSchema.parse({
      ...run,
      ...exit,
      reason: exit.reason.replace(/[\r\n]+/g, ' '),
      endedAt: this.now(),
    });
    this.save(history);
  }

  /** The guard tripped: crash_loop now lasts until undrain, even through clean runs and past the window. */
  markCrashLoop(verdict: { lastError: string | null }): void {
    const history = this.history();
    this.save({ ...history, crashLoop: { at: this.now(), lastError: verdict.lastError } });
  }

  /**
   * undrain (X-41): the earlier unclean exits stop counting and the recorded crash loop clears. A dead run without an
   * exit record is closed first, so an undrain while the runner is down also forgets a crash the next start would
   * otherwise detect. `current` is the live run's id; an instance other than the one that started it must pass it.
   */
  forgetUnclean(options: { at?: number; current?: string } = {}): void {
    const at = Time.parse(options.at ?? this.now());
    const current = options.current ?? this.current;
    const runs = this.records().map((run) => (run.id === current ? run : abandoned(run, at)));
    // Mark existing exits, so a later crash in the same millisecond still counts after undrain.
    this.save({
      runs: runs.map((run) =>
        finished(run) && !run.clean && run.endedAt <= at ? { ...run, uncleanForgotten: true } : run,
      ),
    });
  }

  /**
   * The newest exit. While the runner is down (`running` false, from readLockOwner) a newest run without an exit
   * record died without a clean shutdown, and it is newer than every recorded exit.
   */
  lastExit(options: { running: boolean }): LastExit | null {
    const runs = this.records();
    const latest = runs.at(-1);
    if (!options.running && latest && !finished(latest)) {
      return { reason: ABANDONED, code: null, at: latest.startedAt, clean: false };
    }
    const run = newest(runs.filter(finished));
    return run ? { reason: run.reason, code: run.code, at: run.endedAt, clean: run.clean } : null;
  }

  private save(input: History): void {
    const history = HistorySchema.parse({ ...input, runs: input.runs.slice(-50) });
    mkdirSync(this.paths.logs, { recursive: true, mode: 0o700 });
    const temporary = join(this.paths.logs, `.service-runs.json.${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, `${JSON.stringify(history, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      chmodSync(temporary, 0o600);
      renameSync(temporary, this.path);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}

export const CRASH_LOOP_EXITS = 3;

/**
 * The crash-loop guard (design 7.1): 3 unclean exits within crashLoopWindow, unless undrain forgot them. A crash loop
 * recorded with markCrashLoop holds whatever the window says; a bare array of runs carries no such record.
 */
export function crashLoopVerdict(
  runs: ServiceRuns | readonly ServiceRun[],
  options: { now: number; window: number },
): { crashLoop: boolean; unclean: number; lastError: string | null } {
  const records = runs instanceof ServiceRuns ? runs.records() : runs;
  const marked = runs instanceof ServiceRuns ? runs.crashLoop() : null;
  const unclean = records
    .filter(finished)
    .filter(
      (run) =>
        !run.clean && !run.uncleanForgotten && run.endedAt > options.now - options.window && run.endedAt <= options.now,
    );
  return {
    crashLoop: marked !== null || unclean.length >= CRASH_LOOP_EXITS,
    unclean: unclean.length,
    lastError: newest(unclean)?.reason ?? marked?.lastError ?? null,
  };
}
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `bun test packages/runner/test/service/log.test.ts packages/runner/test/service/runs.test.ts && bun test && bun run typecheck`
Expected: the task's tests pass; then the whole suite passes (`0 fail`) and `tsc` exits 0.

A run with no exit record is closed as unclean ('exited without a clean shutdown') when the next start or an undrain finds it. `forgetUnclean` marks runs instead of deleting them, so `lastExit` still shows them, and it takes `{ current }`: the live run id, which a caller other than the instance that started the run must pass (Task 19's route does). `markCrashLoop` stores the guard's verdict, which stays until `forgetUnclean`. `lastExit({ running })` reports an open run as unclean only when the runner is not running (Task 21 reads `running` from `readLockOwner`). The launchd log files are logs/launchd.out.log and logs/launchd.err.log (`launchdLogPaths`), which Task 20's plist names and Task 13 trims.

- [ ] **Step 5: Commit**

```bash
git add -A 'packages/runner/src/service/log.ts' 'packages/runner/src/service/runs.ts' 'packages/runner/test/service/log.test.ts' 'packages/runner/test/service/runs.test.ts'
git commit -m 'M2C Task 5: The runner log and the service-run records' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

### Task 6: Power and disk facts

The facts heartbeats carry (design 6.3, 7.8, 7.9). `power.ts` parses `pmset -g batt` and `pmset -g` into core's `Runner['power']` (`source`, `batteryPercent`, `lowPowerMode`) and the sleep timer that setup checks. `disk.ts` reads free space with `statfs` and agflow's own usage with `du -skH`, run in the background at most every 10 minutes and cached, so a heartbeat never waits for it. Both are tested with recorded outputs and give null on any failure.

**Files:**
- Create: `packages/runner/src/ops/disk.ts`
- Create: `packages/runner/src/ops/power.ts`
- Test: `packages/runner/test/ops/disk.test.ts`
- Test: `packages/runner/test/ops/power.test.ts`

- [ ] **Step 1: Write the failing tests**

**File:** `packages/runner/test/ops/disk.test.ts` (new)

```ts
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, statfsSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunnerDiskSchema } from '@agflow/core';
import { AgflowUsage, diskFreeBytes } from '../../src/ops/disk';
import { agflowHome } from '../../src/paths';
import type { Exec, ExecResult } from '../../src/service/system';
import { recordingExec } from '../service-helpers';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agf-disk-'));
  dirs.push(dir);
  return dir;
}

describe('diskFreeBytes', () => {
  test('reads user-available bytes on AGFLOW_HOME and produces a valid disk sample', () => {
    const root = agflowHome({ AGFLOW_HOME: scratch() });
    const before = statfsSync(root);
    const freeBytes = diskFreeBytes(root)!;
    const after = statfsSync(root);
    expect(freeBytes).toBeGreaterThan(0);
    // Other processes can allocate between statfs calls.
    expect(Math.abs(freeBytes - before.bavail * before.bsize)).toBeLessThan(64 * 1024 * 1024);
    expect(Math.abs(freeBytes - after.bavail * after.bsize)).toBeLessThan(64 * 1024 * 1024);
    expect(RunnerDiskSchema.parse({ freeBytes, agflowBytes: 0 })).toEqual({ freeBytes, agflowBytes: 0 });
  });

  test('returns null when AGFLOW_HOME does not exist yet', () => {
    expect(diskFreeBytes(join(scratch(), 'missing'))).toBeNull();
  });
});

describe('AgflowUsage', () => {
  test('returns immediately, shares in-flight work and runs at most once per interval', async () => {
    let now = 0;
    const pending: ((result: ExecResult) => void)[] = [];
    const calls = recordingExec();
    const exec: Exec = (argv, options) => {
      void calls(argv, options);
      return new Promise((resolve) => pending.push(resolve));
    };
    const usage = new AgflowUsage({ root: '/agflow home', exec, now: () => now, intervalMs: 100, timeoutMs: 17 });
    expect(usage.current()).toBe(0);
    const first = usage.refresh();
    await Promise.resolve();
    expect(calls.calls).toEqual([{ argv: ['du', '-skH', '/agflow home'], options: { timeoutMs: 17 } }]);
    now = 101;
    for (let i = 0; i < 10; i++) expect(usage.current()).toBe(0);
    expect(usage.refresh()).toBe(first);
    expect(pending).toHaveLength(1);
    pending[0]({ exitCode: 0, stdout: '12\t/agflow home\n', stderr: '', timedOut: false });
    await first;
    expect(usage.current()).toBe(12 * 1024);
    const second = usage.refresh();
    await Promise.resolve();
    expect(pending).toHaveLength(2);
    pending[1]({ exitCode: 0, stdout: '24\t/agflow home\n', stderr: '', timedOut: false });
    await second;
    now = 200;
    expect(usage.current()).toBe(24 * 1024);
    await usage.refresh();
    expect(pending).toHaveLength(2);
  });

  test('defaults to ten minutes and a two-minute timeout, including refresh calls', async () => {
    let now = 0;
    const exec = recordingExec([], { stdout: '1\t/root\n' });
    const usage = new AgflowUsage({ root: '/root', exec, now: () => now });
    await usage.refresh();
    expect(usage.current()).toBe(1024);
    now = 599_999;
    await usage.refresh();
    expect(exec.calls).toHaveLength(1);
    now = 600_000;
    await usage.refresh();
    expect(exec.calls).toHaveLength(2);
    expect(exec.calls[0].options?.timeoutMs).toBe(120_000);
  });

  test('keeps the last value after timeouts, bad output and exceptions, then retries', async () => {
    let now = 0;
    let result: Partial<ExecResult> | Error = { stdout: '5\t/root\n' };
    let calls = 0;
    const exec: Exec = async () => {
      calls++;
      if (result instanceof Error) throw result;
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false, ...result };
    };
    const usage = new AgflowUsage({ root: '/root', exec, now: () => now, intervalMs: 10 });
    await usage.refresh();
    for (const failure of [
      { timedOut: true, stdout: '99\t/root\n' }, { exitCode: 1 },
      { stdout: 'garbage' }, { stdout: '-1\t/root\n' }, { stdout: '1.5\t/root\n' },
      { stdout: '999999999999999999999\t/root\n' }, new Error('spawn failed'),
    ]) {
      result = failure;
      now += 10;
      await usage.refresh();
      expect(usage.current()).toBe(5 * 1024);
      const count = calls;
      await usage.refresh();
      expect(calls).toBe(count);
    }
    result = { stdout: '0\t/root\n' };
    now += 10;
    await usage.refresh();
    expect(usage.current()).toBe(0);
  });

  test('uses a total printed despite unreadable files and a nonzero exit', async () => {
    const usage = new AgflowUsage({
      root: '/root',
      exec: recordingExec([], { exitCode: 1, stdout: '42\t/root\n', stderr: 'Permission denied' }),
    });
    await usage.refresh();
    expect(usage.current()).toBe(42 * 1024);
    expect(RunnerDiskSchema.parse({ freeBytes: 1, agflowBytes: usage.current() }).agflowBytes).toBe(42 * 1024);
  });

  test('measures a real temporary directory with du on macOS and Linux', async () => {
    const root = scratch();
    const file = join(root, 'known');
    writeFileSync(file, Buffer.alloc(128 * 1024, 97));
    const usage = new AgflowUsage({ root });
    await usage.refresh();
    expect(usage.current()).toBeGreaterThanOrEqual(statSync(file).blocks * 512);
    expect(usage.current()).toBeGreaterThan(0);
    expect(usage.current() % 1024).toBe(0);
  });

  test('measures the target of a symlinked root', async () => {
    const dir = scratch();
    const target = join(dir, 'target');
    mkdirSync(target);
    const file = join(target, 'known');
    writeFileSync(file, Buffer.alloc(1024 * 1024, 97));
    const root = join(dir, 'home');
    symlinkSync(target, root);
    const usage = new AgflowUsage({ root });
    await usage.refresh();
    expect(usage.current()).toBeGreaterThanOrEqual(statSync(file).blocks * 512);
  });
});
```

**File:** `packages/runner/test/ops/power.test.ts` (new)

```ts
import { describe, expect, test } from 'bun:test';
import { RunnerPowerSchema } from '@agflow/core';
import { parsePmsetBatt, parsePmsetSettings, samplePower } from '../../src/ops/power';
import type { Exec, ExecResult } from '../../src/service/system';
import { recordingExec } from '../service-helpers';

const ac = `Now drawing from 'AC Power'
 -InternalBattery-0 (id=22741091)\t100%; charged; 0:00 remaining present: true
`;
const battery = `Now drawing from 'Battery Power'
 -InternalBattery-0 (id=22741091)\t18%; discharging; 0:52 remaining present: true
`;
// pmset prints a UPS under its USB product name.
const ups = `Now drawing from 'UPS Power'
 -Back-UPS ES 700G FW:871.O3 .I USB FW:O3  (id=4456448)\t85%; discharging; (no estimate) present: true
`;
const cyberPower = `Now drawing from 'UPS Power'
 -CP1500PFCLCDa (id=7536640)\t96%; discharging; (no estimate) present: true
`;
const desktop = "Now drawing from 'AC Power'\n";
const settings = `System-wide power settings:
Currently in use:
 standby              1
 Sleep On Power Button 1
 hibernatefile        /var/vm/sleepimage
 powernap             1
 networkoversleep     0
 disksleep            10
 sleep                1 (sleep prevented by powerd)
 hibernatemode        3
 ttyskeepawake        1
 displaysleep         0 (display sleep prevented by Yandex)
 tcpkeepalive         1
 lowpowermode         0
 womp                 1
`;
const cases = [
  { output: ac, source: 'ac', batteryPercent: 100 },
  { output: battery, source: 'battery', batteryPercent: 18 },
  { output: ups, source: 'battery', batteryPercent: 85 },
  { output: cyberPower, source: 'battery', batteryPercent: 96 },
  { output: desktop, source: 'ac', batteryPercent: null },
] as const;

function pmset(batt = ac, general = settings) {
  return recordingExec([
    { argv: ['pmset', '-g', 'batt'], result: { stdout: batt } },
    { argv: ['pmset', '-g'], result: { stdout: general } },
  ]);
}

describe('pmset parsers', () => {
  test('reads recorded AC, battery, UPS and desktop output', () => {
    for (const { output, source, batteryPercent } of cases) {
      expect(parsePmsetBatt(output)).toEqual({ source, batteryPercent });
    }
    expect(parsePmsetBatt(ac.replace('charged;', 'AC attached; not charging;'))).toEqual({
      source: 'ac', batteryPercent: 100,
    });
  });

  test('prefers an internal battery, falls back to UPS, and validates percentages', () => {
    expect(parsePmsetBatt(ups + battery.split('\n')[1]).batteryPercent).toBe(18);
    for (const percent of ['101', '-1', '18.5', 'unknown']) {
      expect(parsePmsetBatt(battery.replace('18%', `${percent}%`)).batteryPercent).toBeNull();
    }
    expect(parsePmsetBatt(battery.replace('18%', '0%')).batteryPercent).toBe(0);
    expect(parsePmsetBatt("Now drawing from 'Other Power'\n")).toEqual({
      source: 'unknown', batteryPercent: null,
    });
  });

  test('reads exact sleep and lowpowermode keys, ignoring prevention annotations', () => {
    expect(parsePmsetSettings(settings)).toEqual({ lowPowerMode: false, sleepMinutes: 1 });
    expect(parsePmsetSettings(' sleep 0\n lowpowermode 1\n')).toEqual({ lowPowerMode: true, sleepMinutes: 0 });
    expect(parsePmsetSettings('disksleep 10\ndisplaysleep 5\nSleep On Power Button 1\n')).toEqual({
      lowPowerMode: false, sleepMinutes: null,
    });
    expect(parsePmsetSettings('')).toEqual({ lowPowerMode: false, sleepMinutes: null });
    expect(parsePmsetSettings(' sleep -1\n')).toEqual({ lowPowerMode: false, sleepMinutes: null });
  });

  test('accepts powermode as a fallback, with lowpowermode taking precedence', () => {
    expect(parsePmsetSettings('powermode 1').lowPowerMode).toBe(true);
    expect(parsePmsetSettings('powermode 2').lowPowerMode).toBe(false);
    expect(parsePmsetSettings('lowpowermode 0\npowermode 1').lowPowerMode).toBe(false);
  });
});

describe('samplePower', () => {
  test('combines schema-valid samples and passes a bounded timeout to both commands', async () => {
    for (const { output, source, batteryPercent } of cases) {
      const exec = pmset(output);
      const sample = await samplePower({ platform: 'darwin', exec });
      expect(sample).toEqual({ source, batteryPercent, lowPowerMode: false });
      expect(RunnerPowerSchema.parse(sample)).toEqual({ source, batteryPercent, lowPowerMode: false });
      expect(exec.calls.map((call) => call.options?.timeoutMs)).toEqual([5_000, 5_000]);
    }
    const sample = await samplePower({ platform: 'darwin', exec: pmset(battery, 'lowpowermode 1') });
    expect(RunnerPowerSchema.parse(sample).lowPowerMode).toBe(true);
  });

  test('starts both commands before waiting for either', async () => {
    const pending: ((result: ExecResult) => void)[] = [];
    const exec: Exec = () => new Promise((resolve) => pending.push(resolve));
    const sample = samplePower({ platform: 'darwin', exec });
    expect(pending).toHaveLength(2);
    pending[0]({ exitCode: 0, stdout: ac, stderr: '', timedOut: false });
    pending[1]({ exitCode: 0, stdout: settings, stderr: '', timedOut: false });
    expect((await sample)?.source).toBe('ac');
  });

  test('returns null off macOS without executing commands', async () => {
    const exec = pmset();
    expect(await samplePower({ platform: 'linux', exec })).toBeNull();
    expect(exec.calls).toEqual([]);
  });

  test('returns null for either failed, timed-out or malformed command, and never throws', async () => {
    for (const argv of [['pmset', '-g', 'batt'], ['pmset', '-g']]) {
      // Failures carry valid output, so only the exit code or the timeout can make the sample null.
      const valid = Bun.deepEquals(argv, ['pmset', '-g', 'batt']) ? ac : settings;
      for (const result of [
        { exitCode: 1, stdout: valid },
        { timedOut: true, stdout: valid },
        { stdout: '' },
        { stdout: 'garbage' },
      ]) {
        const success = pmset();
        const exec: Exec = (args, options) => Bun.deepEquals(args, argv)
          ? recordingExec([], result)(args, options) : success(args, options);
        expect(await samplePower({ platform: 'darwin', exec })).toBeNull();
      }
    }
    const exec = pmset();
    await samplePower({ platform: 'darwin', exec, timeoutMs: 42 });
    expect(exec.calls.map((call) => call.options?.timeoutMs)).toEqual([42, 42]);
    expect(await samplePower({ platform: 'darwin', exec: () => { throw new Error('spawn'); } })).toBeNull();
    expect(await samplePower({ platform: 'darwin', exec: async () => { throw new Error('read'); } })).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `bun test packages/runner/test/ops/power.test.ts packages/runner/test/ops/disk.test.ts`
Expected: FAIL — `error: Cannot find module '../../src/ops/disk' from 'packages/runner/test/ops/disk.test.ts'`, and `power.test.ts` on `'../../src/ops/power'` (0 pass, 2 fail, 2 errors)

- [ ] **Step 3: Implement**

**File:** `packages/runner/src/ops/disk.ts` (new)

```ts
// Disk facts (design 6.3, 7.8): free space is cheap; walking agflow's files stays outside the heartbeat.
import { statfsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defaultExec, type Exec } from '../service/system';

/** Available to this user, or unknown when AGFLOW_HOME is missing or inaccessible. */
export function diskFreeBytes(path: string): number | null {
  try {
    const { bavail, bsize } = statfsSync(path);
    const bytes = bavail * bsize;
    return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null;
  } catch {
    return null;
  }
}

export interface AgflowUsageOptions {
  root: string;
  exec?: Exec;
  /** Ten minutes between starts, including failed measurements. */
  intervalMs?: number;
  /** Two minutes by default. */
  timeoutMs?: number;
  now?: () => number;
}

export class AgflowUsage {
  private readonly root: string;
  private readonly exec: Exec;
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private bytes = 0;
  private lastStarted: number | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(options: AgflowUsageOptions) {
    this.root = resolve(options.root);
    this.exec = options.exec ?? defaultExec;
    this.intervalMs = options.intervalMs ?? 10 * 60_000;
    this.timeoutMs = options.timeoutMs ?? 2 * 60_000;
    this.now = options.now ?? Date.now;
  }

  /** Last measured bytes (0 until the first success); starts due work without waiting for it. */
  current(): number {
    void this.refresh();
    return this.bytes;
  }

  /** Await due or in-flight work; this never bypasses the interval. */
  refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const now = this.now();
    if (this.lastStarted !== null && now - this.lastStarted < this.intervalMs) return Promise.resolve();
    this.lastStarted = now;
    this.inFlight = Promise.resolve()
      .then(() => this.measure())
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  private async measure(): Promise<void> {
    try {
      // -H follows a symlinked AGFLOW_HOME given as the operand (BSD and GNU default to -P), never links inside it.
      const result = await this.exec(['du', '-skH', this.root], { timeoutMs: this.timeoutMs });
      if (result.timedOut) return;
      // du can print its total but exit nonzero for unreadable files within a clone.
      const total = result.stdout.trim().match(/^(\d+)\s+[^\r\n]+$/);
      if (!total) return;
      const bytes = Number(total[1]) * 1024;
      if (Number.isSafeInteger(bytes) && bytes >= 0) this.bytes = bytes;
    } catch {
      // A failed measurement leaves the last value intact until the next interval.
    }
  }
}
```

**File:** `packages/runner/src/ops/power.ts` (new)

```ts
// Machine power facts for heartbeats and the idle-sleep setup check (design 6.3, 7.1, 7.9).
import type { Runner } from '@agflow/core';
import { defaultExec, type Exec } from '../service/system';

export type PowerSample = NonNullable<Runner['power']>;

const DRAWING_FROM = /^Now drawing from '([^'\r\n]+)'\s*$/m;
const SETTING = /^\s*(lowpowermode|powermode|sleep)\s+(\d+)(?:\s+\([^\r\n]*\))?\s*$/gm;

export function parsePmsetBatt(output: string): Pick<PowerSample, 'source' | 'batteryPercent'> {
  const name = output.match(DRAWING_FROM)?.[1];
  // A UPS is stored energy too, so the battery guard applies to it.
  const source =
    name === 'AC Power' ? 'ac' : name === 'Battery Power' || name === 'UPS Power' ? 'battery' : 'unknown';
  const percentages = new Map<string, number>();
  for (const line of output.split('\n')) {
    // pmset names a UPS after its USB product string (e.g. 'Back-UPS ES 700G ...'), so any other source is a UPS.
    const match = line.match(/^\s*-(.+?)\s+\(id=[^)]+\)\s+(\d+)%;/);
    if (!match) continue;
    const percent = Number(match[2]);
    const kind = match[1].startsWith('InternalBattery') ? 'internal' : 'ups';
    if (Number.isInteger(percent) && percent <= 100 && !percentages.has(kind)) percentages.set(kind, percent);
  }
  return { source, batteryPercent: percentages.get('internal') ?? percentages.get('ups') ?? null };
}

export function parsePmsetSettings(output: string): { lowPowerMode: boolean; sleepMinutes: number | null } {
  const values = new Map<string, number>();
  for (const match of output.matchAll(SETTING)) {
    const value = Number(match[2]);
    if (Number.isSafeInteger(value)) values.set(match[1], value);
  }
  return {
    lowPowerMode: (values.get('lowpowermode') ?? values.get('powermode')) === 1,
    sleepMinutes: values.get('sleep') ?? null,
  };
}

export async function samplePower(
  options: { exec?: Exec; platform?: NodeJS.Platform; timeoutMs?: number } = {},
): Promise<PowerSample | null> {
  if ((options.platform ?? process.platform) !== 'darwin') return null;
  const exec = options.exec ?? defaultExec;
  const timeoutMs = options.timeoutMs ?? 5_000;
  try {
    const run = async (argv: string[]) => exec(argv, { timeoutMs });
    const [batt, settings] = await Promise.all([run(['pmset', '-g', 'batt']), run(['pmset', '-g'])]);
    if (batt.exitCode !== 0 || settings.exitCode !== 0 || batt.timedOut || settings.timedOut) return null;
    if (!DRAWING_FROM.test(batt.stdout)) return null;
    // Missing keys are normal on some Macs; empty or unrelated output is not a power sample.
    if (
      !/^\s*(?:System-wide power settings:|Currently in use:)\s*$/m.test(settings.stdout) &&
      !settings.stdout.match(SETTING)
    ) {
      return null;
    }
    return { ...parsePmsetBatt(batt.stdout), lowPowerMode: parsePmsetSettings(settings.stdout).lowPowerMode };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `bun test packages/runner/test/ops/power.test.ts packages/runner/test/ops/disk.test.ts && bun test && bun run typecheck`
Expected: the task's tests pass; then the whole suite passes (`0 fail`) and `tsc` exits 0.

A UPS counts as battery power, so the battery guard applies; UPS lines carry product names, and the internal battery's line wins. `du -H` follows only a symlinked root and exists in both BSD and GNU du; a du that exits non-zero but prints a total (unreadable files in a clone) is accepted. `AgflowUsage.current()` is 0 until the first du finishes, and `diskFreeBytes` gives null for unknown space, which Task 8 treats as unknown, not low.

- [ ] **Step 5: Commit**

```bash
git add -A 'packages/runner/src/ops/disk.ts' 'packages/runner/src/ops/power.ts' 'packages/runner/test/ops/disk.test.ts' 'packages/runner/test/ops/power.test.ts'
git commit -m 'M2C Task 6: Power and disk facts' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

### Task 7: The macOS notifier

`createMacNotifier(exec)` implements M2b's `Notifier` seam (design 6.10, X-9). M2b's approvals relay calls it with the hub URL and core's `APPROVALS_ROUTE` on the last line, and Task 18 calls it for needs_login. Text an agent influences never enters AppleScript source: osascript runs a fixed `on run argv` script that reads the title and body from argv. A key posts at most once per 5 minutes, and nothing is posted in test mode or off macOS (design 15.1, X-42).

**Files:**
- Create: `packages/runner/src/service/notify.ts`
- Test: `packages/runner/test/service/notify.test.ts`

- [ ] **Step 1: Write the failing test**

**File:** `packages/runner/test/service/notify.test.ts` (new)

```ts
import { describe, expect, test } from 'bun:test';
import { APPROVALS_ROUTE } from '@agflow/core';
import { isTestMode, RunnerConfigSchema } from '../../src/config';
import { memoryLogger } from '../../src/log';
import { createMacNotifier, NOTIFY_REPEAT_MS } from '../../src/service/notify';
import { defaultExec, type Exec, type ExecResult } from '../../src/service/system';
import { recordingExec } from '../service-helpers';

const script = [
  'osascript',
  '-e',
  'on run argv',
  '-e',
  'display notification (item 1 of argv) with title (item 2 of argv)',
  '-e',
  'end run',
  '--',
];
const injection = 'x" & (do shell script "touch /tmp/pwned") & "';
const notification = { key: 'approval-1', title: 'agflow: attempt asks for your approval', body: 'Approve this?' };
const options = { testMode: false, platform: 'darwin' as const };

describe('createMacNotifier', () => {
  test.each([injection, '-e'])('passes untrusted text only as argv: %s', async (text) => {
    const exec = recordingExec();
    await createMacNotifier(exec, options).notify({ ...notification, body: text, title: text });
    expect(exec.calls).toEqual([{ argv: [...script, text, text], options: { timeoutMs: 10_000 } }]);
  });

  test('caps title and body at 200 characters without splitting Unicode code points', async () => {
    const exec = recordingExec();
    const notifier = createMacNotifier(exec, options);
    await notifier.notify({ key: 'long', title: '😀'.repeat(201), body: 'x'.repeat(201) });
    expect(exec.calls[0].argv.slice(-2)).toEqual(['x'.repeat(199) + '…', '😀'.repeat(199) + '…']);
    await notifier.notify({ key: 'exact', title: 't'.repeat(200), body: 'b'.repeat(200) });
    expect(exec.calls[1].argv.slice(-2)).toEqual(['b'.repeat(200), 't'.repeat(200)]);
  });

  test('keeps the Approvals address on the last line when shortening a summary', async () => {
    const exec = recordingExec();
    const address = `https://hub.example.test${APPROVALS_ROUTE}`;
    await createMacNotifier(exec, options).notify({ ...notification, body: `${'s'.repeat(300)}\n${address}` });
    expect(exec.calls[0].argv.at(-2)).toBe(`${'s'.repeat(198 - address.length)}…\n${address}`);
  });

  test.each([198, 199, 200, 201])('handles a final line of %s characters within the cap', async (length) => {
    const exec = recordingExec();
    const lastLine = 'u'.repeat(length);
    await createMacNotifier(exec, options).notify({ ...notification, body: `summary\n${lastLine}` });
    const body = exec.calls[0].argv.at(-2)!;
    expect(Array.from(body).length).toBeLessThanOrEqual(200);
    if (length <= 200) expect(body.endsWith(lastLine)).toBe(true);
    else expect(body.endsWith('…')).toBe(true);
  });

  test('keeps agent text on one line above the address, so it cannot forge another address line', async () => {
    const exec = recordingExec();
    const address = `https://hub.example.test${APPROVALS_ROUTE}`;
    for (const breaks of ['\n', '\u2028', '\u2029']) {
      const forged = `cmd${breaks}https://evil.test/#/approvals${breaks.repeat(3)}`;
      await createMacNotifier(exec, options).notify({ ...notification, body: `${forged}\n${address}` });
      const body = exec.calls.at(-1)!.argv.at(-2)!;
      expect(body).toBe(`cmd https://evil.test/#/approvals   \n${address}`);
      expect(body.split('\n')).toHaveLength(2);
    }
    await createMacNotifier(exec, options).notify({ ...notification, title: 'a\u2028b\u2029c' });
    expect(exec.calls.at(-1)!.argv.at(-1)).toBe('a b c');
  });

  test('replaces control characters with spaces while preserving newlines', async () => {
    const exec = recordingExec();
    const text = 'a\0b\t\r\u001b\u007f\u0085\nc';
    await createMacNotifier(exec, options).notify({ ...notification, body: text, title: text });
    expect(exec.calls[0].argv.slice(-2)).toEqual(['a b     \nc', 'a b     \nc']);
  });

  test('limits each key from its last post, not its last suppressed call', async () => {
    let now = 0;
    const exec = recordingExec();
    const notifier = createMacNotifier(exec, { ...options, now: () => now });
    expect(NOTIFY_REPEAT_MS).toBe(5 * 60_000);
    await notifier.notify(notification);
    now = NOTIFY_REPEAT_MS - 1;
    await notifier.notify(notification);
    await notifier.notify({ ...notification, key: 'needs_login' });
    expect(exec.calls).toHaveLength(2);
    now = NOTIFY_REPEAT_MS;
    await notifier.notify(notification);
    await notifier.notify({ ...notification, key: 'needs_login' });
    expect(exec.calls).toHaveLength(3);
    now += NOTIFY_REPEAT_MS;
    await notifier.notify({ ...notification, key: 'new-key' });
    await notifier.notify(notification);
    expect(exec.calls).toHaveLength(5);
  });

  test('reserves the key before awaiting exec and awaits the post', async () => {
    const calls = recordingExec();
    let finish!: (result: ExecResult) => void;
    const pending = new Promise<ExecResult>((resolve) => {
      finish = resolve;
    });
    const exec: Exec = async (argv, opts) => {
      await calls(argv, opts);
      return pending;
    };
    const notifier = createMacNotifier(exec, options);
    let settled = false;
    const first = Promise.resolve(notifier.notify(notification)).then(() => {
      settled = true;
    });
    await notifier.notify(notification);
    expect(calls.calls).toHaveLength(1);
    expect(settled).toBe(false);
    finish({ exitCode: 0, stdout: '', stderr: '', timedOut: false });
    await first;
    expect(settled).toBe(true);
  });

  test('posts nothing in M2b test mode or off macOS', async () => {
    const config = RunnerConfigSchema.parse({ runnerKey: 'rk_test', machineId: 'MACHINE-1', name: 'mac', test: {} });
    const exec = recordingExec();
    const testMode = isTestMode(config, { AGFLOW_TEST: '1' });
    expect(testMode).toBe(true);
    await createMacNotifier(exec, { ...options, testMode }).notify(notification);
    await createMacNotifier(exec, { ...options, platform: 'linux' }).notify(notification);
    await createMacNotifier(exec, { ...options, platform: 'win32' }).notify(notification);
    expect(exec.calls).toHaveLength(0);
  });

  test('defaults to the current platform with an explicit test-mode decision', async () => {
    const exec = recordingExec();
    await createMacNotifier(exec, { testMode: false }).notify(notification);
    expect(exec.calls).toHaveLength(process.platform === 'darwin' ? 1 : 0);
  });

  test.each([
    { exitCode: 1, stderr: 'permission denied\nprivate details', timedOut: false },
    { exitCode: 0, stderr: 'timeout\nprivate details', timedOut: true },
  ])('warns and resolves on an unsuccessful post: %j', async (result) => {
    const exec = recordingExec([], result);
    const logger = memoryLogger();
    const notifier = createMacNotifier(exec, { ...options, logger });
    await notifier.notify(notification);
    await notifier.notify(notification);
    expect(exec.calls).toHaveLength(1);
    expect(logger.entries).toEqual([
      {
        level: 'warn',
        message: 'cannot post macOS notification',
        fields: {
          key: notification.key,
          exitCode: result.exitCode,
          stderr: result.stderr.split('\n')[0],
          timedOut: result.timedOut,
        },
      },
    ]);
    expect(JSON.stringify(logger.entries)).not.toContain(notification.body);
  });

  test('catches a thrown exec and counts the failure toward the repeat limit', async () => {
    const logger = memoryLogger();
    let calls = 0;
    const exec: Exec = async () => {
      calls++;
      throw new Error(`spawn failed: ${notification.body}`);
    };
    const notifier = createMacNotifier(exec, { ...options, logger });
    await notifier.notify(notification);
    await notifier.notify(notification);
    expect(calls).toBe(1);
    expect(logger.entries).toHaveLength(1);
    expect(logger.entries[0]).toMatchObject({ level: 'warn', fields: { key: notification.key, exitCode: null } });
    expect(JSON.stringify(logger.entries)).not.toContain(notification.body);
  });

  test.skipIf(process.platform !== 'darwin')('real osascript returns injection text verbatim without posting', async () => {
    const exec = recordingExec();
    const body = `-e ${injection}`;
    await createMacNotifier(exec, options).notify({ ...notification, body, title: injection });
    const argv = exec.calls[0].argv.slice();
    argv[4] = 'return (item 1 of argv) & "|" & (item 2 of argv)';
    const result = await defaultExec(argv, { timeoutMs: 10_000 });
    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
    expect(result.stdout).toBe(`${body}|${injection}\n`);
  });
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `bun test packages/runner/test/service/notify.test.ts`
Expected: FAIL — `error: Cannot find module '../../src/service/notify' from 'packages/runner/test/service/notify.test.ts'` (0 pass, 1 fail, 1 error)

- [ ] **Step 3: Implement**

**File:** `packages/runner/src/service/notify.ts` (new)

```ts
// Owner notifications (design 6.10, 7.1, 15.1): agent text reaches osascript only as arguments, never as script.
import { type Logger, noopLogger } from '../log';
import type { Notifier } from '../seams';
import type { Exec } from './system';

export const NOTIFY_REPEAT_MS = 5 * 60_000;
const NOTIFY_MAX_CHARS = 200;

export interface MacNotifierOptions {
  /** The host supplies M2b's isTestMode(config) result. */
  testMode: boolean;
  logger?: Logger;
  platform?: NodeJS.Platform;
  now?: () => number;
}

function notificationText(text: string, preserveLastLine = false): string {
  // U+2028 and U+2029 render as line breaks too.
  let clean = text.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/g, ' ');
  if (preserveLastLine) {
    // Agent text is one line, so it cannot lay out a line that passes for the relay's address below it.
    const last = clean.lastIndexOf('\n');
    if (last !== -1) clean = `${clean.slice(0, last).replace(/\n/g, ' ')}${clean.slice(last)}`;
  }
  const chars = Array.from(clean);
  if (chars.length <= NOTIFY_MAX_CHARS) return chars.join('');
  const newline = chars.lastIndexOf('\n');
  if (preserveLastLine && newline !== -1) {
    const lastLine = chars.slice(newline + 1);
    if (lastLine.length <= NOTIFY_MAX_CHARS) {
      // The approval relay puts the hub address here; prefer it when there is no room for a summary.
      const room = NOTIFY_MAX_CHARS - lastLine.length - 2;
      if (room < 0) return lastLine.join('');
      return `${chars.slice(0, room).join('')}…\n${lastLine.join('')}`;
    }
  }
  return `${chars.slice(0, NOTIFY_MAX_CHARS - 1).join('')}…`;
}

/**
 * M2b's Notifier on macOS: approvals and needs_login, silent in test mode and on other platforms. osascript cannot
 * replace a posted notification, so a repeated key within NOTIFY_REPEAT_MS is dropped, not replaced.
 */
export function createMacNotifier(exec: Exec, options: MacNotifierOptions): Notifier {
  const { testMode, logger = noopLogger, platform = process.platform, now = Date.now } = options;
  const posted = new Map<string, number>();
  return {
    async notify({ key, title, body }) {
      if (testMode || platform !== 'darwin') return;
      const time = now();
      const last = posted.get(key);
      if (last !== undefined && time - last < NOTIFY_REPEAT_MS) return;
      for (const [oldKey, at] of posted) {
        if (time - at >= NOTIFY_REPEAT_MS) posted.delete(oldKey);
      }
      // Reserve before awaiting, including failed posts, so concurrent calls and failures cannot flood the desktop.
      posted.set(key, time);
      try {
        const result = await exec(
          [
            'osascript',
            '-e',
            'on run argv',
            '-e',
            'display notification (item 1 of argv) with title (item 2 of argv)',
            '-e',
            'end run',
            '--',
            notificationText(body, true),
            notificationText(title),
          ],
          { timeoutMs: 10_000 },
        );
        if (result.exitCode !== 0 || result.timedOut) {
          logger.warn('cannot post macOS notification', {
            key,
            exitCode: result.exitCode,
            stderr: result.stderr.split(/\r?\n/, 1)[0],
            timedOut: result.timedOut,
          });
        }
      } catch {
        // Exec exceptions can include argv, which contains private agent text.
        logger.warn('cannot post macOS notification: exec threw', { key, exitCode: null, stderr: '' });
      }
    },
  };
}
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `bun test packages/runner/test/service/notify.test.ts && bun test && bun run typecheck`
Expected: the task's tests pass; then the whole suite passes (`0 fail`) and `tsc` exits 0.

Title and body are cut to 200 code points. A long body keeps its last line whole, because the relay puts the address there, and earlier newlines, U+2028 and U+2029 become spaces, so agent text cannot forge a second address line. A repeated key is dropped, not replaced (osascript cannot replace a notification), and failed posts count too, so a broken osascript is not retried in a loop. Failures are logged without the body. The real-osascript test swaps the script for `return` and checks that the injection text comes back verbatim; it posts nothing.

- [ ] **Step 5: Commit**

```bash
git add -A 'packages/runner/src/service/notify.ts' 'packages/runner/test/service/notify.test.ts'
git commit -m 'M2C Task 7: The macOS notifier' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

### Task 8: Service health: holds, refusals and guard stops

One place decides whether the runner takes new attempts and when it stops its agents (design 7.8, 7.9). `createServiceHealth` implements M2b's `RunnerHealth` seam (X-7). `admit` refuses with core's `START_REFUSALS` codes `needs_login`, `waking`, `battery_low` and `disk_low`, in that order (X-3); `heartbeat` reports power, disk and `acceptingUntil`; `state` reports `crash_loop`, `disk_low` or `ok`. Below half of `minFreeGb`, or below 8% battery, it stops the agents as a runner stop without a handoff turn (X-41). Tasks 18 and 19 set the needs_login and crash_loop holds.

**Files:**
- Create: `packages/runner/src/ops/health.ts`
- Test: `packages/runner/test/ops/health.test.ts`

- [ ] **Step 1: Write the failing test**

**File:** `packages/runner/test/ops/health.test.ts` (new)

```ts
import { afterEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AttemptSpec, START_REFUSALS } from '@agflow/core';
import type { ClockSource } from '../../src/clock';
import { DEFAULT_TIMINGS } from '../../src/config';
import { memoryLogger } from '../../src/log';
import {
  admissionDecision,
  BATTERY_STOP_PERCENT,
  createServiceHealth,
  GB,
  type ServiceHealthOptions,
} from '../../src/ops/health';
import type { PowerSample } from '../../src/ops/power';
import { runnerPaths } from '../../src/paths';
import { cleanupRunnerFixtures, createRunnerFixture, waitFor } from '../fixture';

afterEach(cleanupRunnerFixtures);

const power = (batteryPercent: number | null, source: PowerSample['source'] = 'battery'): PowerSample => ({
  source,
  batteryPercent,
  lowPowerMode: false,
});
// Service health does not inspect the attempt; the integration test below supplies the full fixture spec.
const spec = {} as AttemptSpec;
/** Lets a guard's stop call settle. */
const settle = () => Bun.sleep(0);
const facts = {
  now: 1_000,
  wakingUntil: null,
  power: null,
  freeBytes: null,
  needsLogin: false,
  minFreeGb: 10,
  batteryDrainPercent: 20,
};

function fixture(overrides: Partial<Parameters<typeof createServiceHealth>[0]> = {}) {
  const data = {
    now: 1_000,
    power: null as PowerSample | null,
    freeBytes: (20 * GB) as number | null,
    heartbeatMs: 15_000,
    /** Attempts that hold a slot: the fake handle stops each of them, as RunnerHandle.stopAgents does. */
    agents: 0,
  };
  const config = {
    minFreeGb: 10,
    batteryDrainPercent: 20,
    timings: { ...DEFAULT_TIMINGS },
  };
  const timers = new Map<unknown, { fn: () => void; ms: number }>();
  const clock: ClockSource = {
    now: () => data.now,
    setInterval: (fn, ms) => {
      const handle = {};
      timers.set(handle, { fn, ms });
      return handle;
    },
    clearInterval: (handle) => {
      timers.delete(handle);
    },
    setTimeout: () => {
      throw new Error('unexpected timeout');
    },
    clearTimeout: () => {
      throw new Error('unexpected timeout');
    },
  };
  const stops: unknown[][] = [];
  let stopped = 0;
  const stopAgents: ServiceHealthOptions['stopAgents'] = async (...args) => {
    stops.push(args);
    const exits = Array.from({ length: data.agents }, (_, index) => stopped + index + 1);
    stopped += data.agents;
    data.agents = 0;
    return exits;
  };
  const logger = memoryLogger();
  let samples = 0;
  let notifications = 0;
  const health = createServiceHealth({
    paths: runnerPaths('/tmp/agflow-health-unused'),
    config: () => config,
    heartbeatMs: () => data.heartbeatMs,
    now: () => data.now,
    clock,
    samplePower: async () => {
      samples++;
      return data.power;
    },
    freeBytes: () => data.freeBytes,
    usage: { current: () => 1234 },
    stopAgents,
    onSample: () => {
      notifications++;
    },
    logger,
    ...overrides,
  });
  return {
    health,
    data,
    config,
    timers,
    stops,
    stopAgents,
    logger,
    stopped: () => stopped,
    warnings: () => logger.entries.filter((entry) => entry.level === 'warn'),
    samples: () => samples,
    notifications: () => notifications,
  };
}

describe('admissionDecision', () => {
  test('decides holds and guard thresholds, including unknown facts and exact boundaries', () => {
    expect(GB).toBe(1_000_000_000);
    expect(BATTERY_STOP_PERCENT).toBe(8);
    const clear = {
      refusal: null,
      waking: false,
      batteryLow: false,
      batteryStop: false,
      diskLow: false,
      diskStop: false,
    };
    const cases: [Partial<Parameters<typeof admissionDecision>[0]>, Partial<ReturnType<typeof admissionDecision>>][] = [
      [{}, {}],
      [{ wakingUntil: 2_000 }, { refusal: 'waking', waking: true }],
      [{ wakingUntil: 1_000 }, {}],
      [{ power: power(15) }, { refusal: 'battery_low', batteryLow: true }],
      [{ power: power(7) }, { refusal: 'battery_low', batteryLow: true, batteryStop: true }],
      [{ power: power(8) }, { refusal: 'battery_low', batteryLow: true }],
      [{ power: power(20) }, {}],
      [{ power: power(5, 'ac') }, {}],
      [{ power: power(5, 'unknown') }, {}],
      [{ power: power(null) }, {}],
      [{ freeBytes: 8 * GB }, { refusal: 'disk_low', diskLow: true }],
      [{ freeBytes: 4 * GB }, { refusal: 'disk_low', diskLow: true, diskStop: true }],
      [{ freeBytes: 5 * GB }, { refusal: 'disk_low', diskLow: true }],
      [{ freeBytes: 10 * GB }, {}],
      [{ minFreeGb: 0, freeBytes: 0 }, {}],
      // The stop level holds even when batteryDrainPercent sits below it.
      [
        { power: power(7), batteryDrainPercent: 0 },
        { refusal: 'battery_low', batteryLow: true, batteryStop: true },
      ],
      [{ power: power(8), batteryDrainPercent: 0 }, {}],
    ];
    for (const [input, expected] of cases)
      expect(admissionDecision({ ...facts, ...input })).toEqual({
        ...clear,
        ...expected,
      });
  });

  test('orders refusals needs_login, waking, battery_low, disk_low, all from START_REFUSALS', () => {
    const input = {
      ...facts,
      needsLogin: true,
      wakingUntil: 2_000 as number | null,
      power: power(7),
      freeBytes: 4 * GB,
    };
    for (const refusal of ['needs_login', 'waking', 'battery_low', 'disk_low'] as const) {
      const decision = admissionDecision(input);
      expect(decision.refusal).toBe(refusal);
      expect(START_REFUSALS).toContain(decision.refusal!);
      if (refusal === 'needs_login') input.needsLogin = false;
      if (refusal === 'waking') input.wakingUntil = null;
      if (refusal === 'battery_low') input.power = power(100);
    }
  });
});

describe('createServiceHealth', () => {
  test('reports a shrinking wake hold, extends later gaps, and never shortens an existing end', () => {
    const f = fixture();
    f.health.gap({ at: f.data.now, ms: 30_000 });
    expect(f.health.heartbeat().acceptingUntil).toBe(f.config.timings.wakeHold);
    expect(f.health.admit(spec)).toBe('waking');
    f.data.now += 10_000;
    expect(f.health.heartbeat().acceptingUntil).toBe(f.config.timings.wakeHold - 10_000);
    f.health.gap({ at: f.data.now, ms: 30_000 });
    f.config.timings.wakeHold = 1_000;
    f.health.gap({ at: f.data.now - 1_000, ms: 30_000 });
    expect(f.health.heartbeat().acceptingUntil).toBe(DEFAULT_TIMINGS.wakeHold);
    f.data.now += DEFAULT_TIMINGS.wakeHold;
    expect(f.health.heartbeat().acceptingUntil).toBeNull();
    expect(f.health.admit(spec)).toBeNull();
  });

  test('a wall clock stepping back after a gap never stretches the hold past wakeHold', () => {
    const f = fixture();
    f.health.gap({ at: f.data.now, ms: 30_000 });
    f.data.now -= 3_600_000;
    expect(f.health.heartbeat().acceptingUntil).toBe(DEFAULT_TIMINGS.wakeHold);
    expect(f.health.admit(spec)).toBe('waking');
    f.data.now += DEFAULT_TIMINGS.wakeHold;
    expect(f.health.admit(spec)).toBeNull();
    expect(f.health.heartbeat().acceptingUntil).toBeNull();
  });

  test('renews battery holds and stops each agent once per crossing, without a handoff', async () => {
    const f = fixture();
    expect(f.health.power()).toBeNull();
    f.data.power = power(15);
    expect(f.health.admit(spec)).toBeNull();
    expect(f.samples()).toBe(0);
    await f.health.sample();
    expect(f.health.power()).toEqual(power(15));
    expect(f.health.admit(spec)).toBe('battery_low');
    expect(f.health.heartbeat().acceptingUntil).toBe(30_000);
    f.data.now += 60_000;
    f.data.heartbeatMs = 5_000;
    expect(f.health.heartbeat().acceptingUntil).toBe(10_000);
    expect(f.stops).toEqual([]);
    f.data.agents = 2;
    f.data.power = power(7);
    for (let i = 0; i < 3; i++) {
      await f.health.sample();
      f.health.heartbeat();
      f.health.state();
      f.health.admit(spec);
    }
    await settle();
    expect(f.stopped()).toBe(2);
    expect(f.stops.length).toBeGreaterThan(0);
    for (const args of f.stops) expect(args).toEqual(['runner_stop', { handoff: false }]);
    expect(f.warnings()).toHaveLength(1);
    expect(JSON.stringify(f.logger.entries)).toContain('battery');
    expect(JSON.stringify(f.logger.entries)).toContain('7');
    // A resume_attempt skips admit; the tripped guard stops it at the next evaluation, without a second warning.
    f.data.agents = 1;
    await f.health.sample();
    await settle();
    expect(f.stopped()).toBe(3);
    expect(f.warnings()).toHaveLength(1);
    f.data.power = power(9);
    await f.health.sample();
    f.data.agents = 1;
    f.data.power = power(7);
    await f.health.sample();
    await settle();
    expect(f.stopped()).toBe(4);
    expect(f.warnings()).toHaveLength(2);
    for (const recovered of [power(8), power(5, 'ac')]) {
      f.data.power = recovered;
      await f.health.sample();
      f.data.agents = 1;
      f.data.power = power(7);
      await f.health.sample();
      await settle();
    }
    expect(f.stopped()).toBe(6);
    expect(f.warnings()).toHaveLength(4);
    f.data.power = power(5, 'ac');
    await f.health.sample();
    await settle();
    const calls = f.stops.length;
    expect(f.health.admit(spec)).toBeNull();
    expect(f.health.heartbeat().acceptingUntil).toBeNull();
    expect(f.stops).toHaveLength(calls);
  });

  test('after a stop that threw, reached no agent or is under way, the guard stops later agents', async () => {
    const host: { handle?: { stopAgents: ServiceHealthOptions['stopAgents'] } } = {};
    let release = () => {};
    const f = fixture({
      // As the host binds it: the handle does not exist yet, so the call throws a TypeError.
      stopAgents: (cause, options) =>
        (host.handle as { stopAgents: ServiceHealthOptions['stopAgents'] }).stopAgents(cause, options),
    });
    f.data.power = power(7);
    await f.health.sample();
    expect(JSON.stringify(f.logger.entries)).toContain('guard stop failed');
    expect(f.health.state()).toEqual({ state: 'ok', detail: null });
    expect(f.health.admit(spec)).toBe('battery_low');
    host.handle = { stopAgents: f.stopAgents };
    f.health.heartbeat();
    await settle();
    expect(f.stops).toHaveLength(1);
    expect(f.stopped()).toBe(0);
    // A suspended attempt resumed after the guard tripped: the next heartbeat stops it.
    f.data.agents = 1;
    f.health.heartbeat();
    await settle();
    expect(f.stopped()).toBe(1);
    // One call at a time: evaluations during a slow stop (WIP pushes) start no second one.
    host.handle = {
      stopAgents: (...args) => {
        f.stops.push(args);
        return new Promise((done) => {
          release = () => done([]);
        });
      },
    };
    const before = f.stops.length;
    await f.health.sample();
    f.health.heartbeat();
    f.health.admit(spec);
    expect(f.stops).toHaveLength(before + 1);
    release();
    await settle();
    host.handle = { stopAgents: f.stopAgents };
    f.data.agents = 1;
    f.health.state();
    await settle();
    expect(f.stopped()).toBe(2);
    expect(f.warnings()).toHaveLength(1);
  });

  test('reads disk afresh, reports usage, and clears disk holds after recovery', async () => {
    const f = fixture();
    f.data.freeBytes = 8 * GB;
    expect(f.health.state()).toEqual({ state: 'disk_low', detail: 'free space below 10 GB' });
    // A changed detail goes out as a runner.state event: it must not follow the live number.
    f.data.freeBytes = 7.9 * GB;
    expect(f.health.state()).toEqual({ state: 'disk_low', detail: 'free space below 10 GB' });
    f.data.freeBytes = 8 * GB;
    expect(f.health.admit(spec)).toBe('disk_low');
    expect(f.health.heartbeat()).toEqual({
      power: null,
      disk: { freeBytes: 8 * GB, agflowBytes: 1234 },
      acceptingUntil: 30_000,
    });
    f.data.agents = 1;
    f.data.freeBytes = 4 * GB;
    f.health.state();
    f.health.heartbeat();
    f.health.admit(spec);
    await settle();
    expect(f.stopped()).toBe(1);
    for (const args of f.stops) expect(args).toEqual(['runner_stop', { handoff: false }]);
    expect(f.warnings()).toHaveLength(1);
    expect(JSON.stringify(f.logger.entries)).toContain('disk');
    expect(JSON.stringify(f.logger.entries)).toContain(String(4 * GB));
    f.data.freeBytes = 5 * GB;
    f.health.admit(spec);
    f.data.agents = 1;
    f.data.freeBytes = 4 * GB;
    f.health.admit(spec);
    await settle();
    expect(f.stopped()).toBe(2);
    expect(f.warnings()).toHaveLength(2);
    f.data.freeBytes = 11 * GB;
    expect(f.health.state()).toEqual({ state: 'ok', detail: null });
    expect(f.health.admit(spec)).toBeNull();
    expect(f.health.heartbeat().acceptingUntil).toBeNull();
    f.data.freeBytes = null;
    expect(f.health.heartbeat().disk).toBeNull();
  });

  test('prioritizes crash_loop state and needs_login admission without adding a heartbeat hold', async () => {
    const f = fixture();
    f.health.setCrashLoop('last service error');
    f.health.setNeedsLogin(true);
    expect(f.health.state()).toEqual({
      state: 'crash_loop',
      detail: 'last service error',
    });
    expect(f.health.admit(spec)).toBe('needs_login');
    expect(f.health.heartbeat().acceptingUntil).toBeNull();
    f.data.freeBytes = 8 * GB;
    f.data.power = power(15);
    await f.health.sample();
    f.health.gap({ at: f.data.now, ms: 30_000 });
    expect(f.health.admit(spec)).toBe('needs_login');
    expect(f.health.state().state).toBe('crash_loop');
    f.health.setCrashLoop(null);
    expect(f.health.state().state).toBe('disk_low');
    f.health.setNeedsLogin(false);
    expect(f.health.admit(spec)).toBe('waking');
    f.data.freeBytes = 20 * GB;
    expect(f.health.state()).toEqual({ state: 'ok', detail: null });
  });

  test('uses the longest hold, reads live thresholds, and arms guards independently', async () => {
    const f = fixture();
    f.data.agents = 1;
    f.data.power = power(7);
    f.data.freeBytes = 4 * GB;
    await f.health.sample();
    await settle();
    // Both guards trip and warn; one stop call covers them.
    expect(f.stopped()).toBe(1);
    expect(f.warnings().map((entry) => entry.fields.guard)).toEqual(['battery', 'disk']);
    f.health.gap({ at: f.data.now, ms: 30_000 });
    expect(f.health.heartbeat().acceptingUntil).toBe(DEFAULT_TIMINGS.wakeHold);
    f.data.now += DEFAULT_TIMINGS.wakeHold - 1;
    expect(f.health.heartbeat().acceptingUntil).toBe(30_000);
    f.data.freeBytes = 5 * GB;
    f.health.heartbeat();
    f.data.freeBytes = 4 * GB;
    f.health.heartbeat();
    expect(f.warnings().map((entry) => entry.fields.guard)).toEqual(['battery', 'disk', 'disk']);
    f.data.now++;
    f.data.power = power(9);
    await f.health.sample();
    f.config.batteryDrainPercent = 5;
    expect(f.health.admit(spec)).toBe('disk_low');
    f.config.minFreeGb = 3;
    await settle();
    const calls = f.stops.length;
    expect(f.health.admit(spec)).toBeNull();
    expect(f.health.state().state).toBe('ok');
    expect(f.health.heartbeat().acceptingUntil).toBeNull();
    expect(f.stops).toHaveLength(calls);
    expect(f.warnings()).toHaveLength(3);
  });

  test('shares overlapping samples and notifies only after the sample and each heartbeat', async () => {
    let resolve!: (sample: PowerSample | null) => void;
    let calls = 0;
    const f = fixture({
      samplePower: () => {
        calls++;
        return new Promise((done) => {
          resolve = done;
        });
      },
    });
    const first = f.health.sample();
    expect(f.health.sample()).toBe(first);
    await Promise.resolve();
    expect(calls).toBe(1);
    expect(f.notifications()).toBe(0);
    resolve(power(15));
    await first;
    expect(f.notifications()).toBe(1);
    f.health.admit(spec);
    f.health.state();
    expect(f.notifications()).toBe(1);
    expect(f.health.heartbeat().power).toEqual(power(15));
    expect(f.notifications()).toBe(2);
  });

  test('samples at start and on its timer even without heartbeats; close clears the timer', async () => {
    for (const sampleEveryMs of [undefined, 123]) {
      const f = fixture({ sampleEveryMs });
      f.health.start();
      f.health.start();
      await f.health.sample();
      expect(f.samples()).toBe(1);
      expect(f.timers.size).toBe(1);
      expect([...f.timers.values()][0].ms).toBe(sampleEveryMs ?? 60_000);
      f.data.agents = 1;
      f.data.power = power(7);
      for (const timer of f.timers.values()) timer.fn();
      await f.health.sample();
      await settle();
      expect(f.samples()).toBe(2);
      expect(f.stopped()).toBe(1);
      f.health.close();
      f.health.close();
      expect(f.timers.size).toBe(0);
    }
  });

  test('logs rejected stops and throwing observers without failing health reads; stops again', async () => {
    let stops = 0;
    const f = fixture({
      stopAgents: async () => {
        stops++;
        throw new Error('stop failed');
      },
      onSample: () => {
        throw new Error('observer failed');
      },
    });
    f.data.power = power(7);
    await f.health.sample();
    await settle();
    expect(stops).toBe(1);
    expect(f.health.heartbeat().acceptingUntil).toBe(30_000);
    await settle();
    expect(stops).toBe(2);
    expect(JSON.stringify(f.logger.entries)).toContain('stop failed');
    expect(JSON.stringify(f.logger.entries)).toContain('observer failed');
    expect(f.warnings()).toHaveLength(1);
  });

  test('a config read that throws during a timer sample is logged instead of rejecting', async () => {
    let broken = false;
    const f = fixture({
      config: () => {
        if (broken) throw new Error('runner.json is malformed');
        return f.config;
      },
    });
    f.health.start();
    await f.health.sample();
    broken = true;
    for (const timer of f.timers.values()) timer.fn();
    await f.health.sample();
    expect(await f.health.sample()).toBeUndefined();
    expect(JSON.stringify(f.logger.entries)).toContain('runner.json is malformed');
    broken = false;
    f.data.power = power(15);
    await f.health.sample();
    expect(f.health.admit(spec)).toBe('battery_low');
    f.health.close();
  });

  test('a failed power sample becomes unknown, is logged, and permits another sample', async () => {
    let fail = false;
    const f = fixture({
      samplePower: async () => {
        if (fail) throw new Error('power unavailable');
        return power(15);
      },
    });
    await f.health.sample();
    expect(f.health.admit(spec)).toBe('battery_low');
    fail = true;
    await f.health.sample();
    expect(f.health.power()).toBeNull();
    expect(f.health.admit(spec)).toBeNull();
    expect(JSON.stringify(f.logger.entries)).toContain('power unavailable');
    fail = false;
    await f.health.sample();
    expect(f.health.admit(spec)).toBe('battery_low');
  });

  test('measures free space and agflow usage at AGFLOW_HOME by default', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agflow-health-'));
    try {
      writeFileSync(join(home, 'runner.db'), randomBytes(64 * 1024));
      const f = fixture({ paths: runnerPaths(home), freeBytes: undefined, usage: undefined });
      // Above any real disk: the default free space must be read, and be below it.
      f.config.minFreeGb = 1e9;
      expect(f.health.admit(spec)).toBe('disk_low');
      expect(f.health.state().state).toBe('disk_low');
      expect(f.health.heartbeat().disk?.freeBytes ?? 0).toBeGreaterThan(0);
      // AgflowUsage measures in the background; the file is inside AGFLOW_HOME, so its size shows up.
      await waitFor(() => (f.health.heartbeat().disk?.agflowBytes ?? 0) >= 64 * 1024);
      await settle();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('reports a sampled battery hold through the controller without launching an agent', async () => {
    const runner = await createRunnerFixture();
    const f = fixture({ paths: runner.paths, config: () => runner.config });
    f.data.power = power(15);
    await f.health.sample();
    const controller = runner.controller('T-4-a1', { health: f.health });
    expect(await controller.start(runner.spec())).toMatchObject({
      started: false,
      refused: 'battery_low',
    });
    expect(runner.events('attempt.failed_to_start').map((event) => event.data.refused)).toEqual(['battery_low']);
    expect(runner.fakes.claude?.launches).toEqual([]);
    expect(runner.fakes.codex?.launches).toEqual([]);
    expect(runner.store.list()).toEqual([]);
    expect(controller.holdsSlot).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `bun test packages/runner/test/ops/health.test.ts`
Expected: FAIL — `error: Cannot find module '../../src/ops/health' from 'packages/runner/test/ops/health.test.ts'` (0 pass, 1 fail, 1 error)

- [ ] **Step 3: Implement**

**File:** `packages/runner/src/ops/health.ts` (new)

```ts
// The service's RunnerHealth (design 7.8, 7.9, X-41): admission holds for waking, battery, disk and needs_login, the
// state hello and runner.state report, the heartbeat's machine facts, and the guards that stop the agents below 8%
// battery or half of minFreeGb. Power is sampled on a timer so the battery guard also works with the link down; free
// space is read on use. A guard warns once per crossing but, while it stays tripped, stops whatever holds a slot again
// at each evaluation: a resume skips admit, and a stop can reach no agent (the handle not bound yet), so one call per
// crossing could leave agents running. Each agent is still stopped once: a stopped one holds no slot.
import type { StartRefusal } from '@agflow/core';
import { type ClockGap, type ClockSource, systemClock } from '../clock';
import type { RunnerConfig } from '../config';
import { type Logger, noopLogger } from '../log';
import type { RunnerPaths } from '../paths';
import type { HealthReport, RunnerHealth } from '../seams';
import { AgflowUsage, diskFreeBytes } from './disk';
import { type PowerSample, samplePower } from './power';

/** Below this battery percentage on battery power, the runner stops its agents (design 7.9). */
export const BATTERY_STOP_PERCENT = 8;
/** minFreeGb counts decimal gigabytes, as macOS reports free space. */
export const GB = 1_000_000_000;

export interface AdmissionInput {
  now: number;
  /** Epoch ms when the wake hold ends; null without one. */
  wakingUntil: number | null;
  power: PowerSample | null;
  freeBytes: number | null;
  needsLogin: boolean;
  minFreeGb: number;
  batteryDrainPercent: number;
}

export interface AdmissionDecision {
  /** The first of needs_login, waking, battery_low and disk_low that applies. */
  refusal: StartRefusal | null;
  waking: boolean;
  batteryLow: boolean;
  batteryStop: boolean;
  diskLow: boolean;
  diskStop: boolean;
}

/**
 * Unknown power or free space holds nothing; only battery power (a UPS included) can be low. The battery stop level is
 * a hold too, whatever batteryDrainPercent says, so the hub places nothing on a runner that would stop it at once.
 */
export function admissionDecision(input: AdmissionInput): AdmissionDecision {
  const { now, wakingUntil, power, freeBytes, needsLogin, minFreeGb, batteryDrainPercent } = input;
  const waking = wakingUntil !== null && now < wakingUntil;
  const percent = power?.source === 'battery' ? power.batteryPercent : null;
  const batteryLow = percent !== null && percent < Math.max(batteryDrainPercent, BATTERY_STOP_PERCENT);
  const batteryStop = percent !== null && percent < BATTERY_STOP_PERCENT;
  const diskLow = freeBytes !== null && freeBytes < minFreeGb * GB;
  const diskStop = freeBytes !== null && freeBytes < (minFreeGb * GB) / 2;
  const refusal = needsLogin
    ? 'needs_login'
    : waking
      ? 'waking'
      : batteryLow
        ? 'battery_low'
        : diskLow
          ? 'disk_low'
          : null;
  return { refusal, waking, batteryLow, batteryStop, diskLow, diskStop };
}

export interface ServiceHealth extends RunnerHealth {
  /**
   * RunnerEvents.gap: no new attempts until wakeHold after it; a later end is never shortened, and the hold never
   * reaches further than that gap's wakeHold from now, even after the wall clock steps back.
   */
  gap(gap: ClockGap): void;
  setNeedsLogin(on: boolean): void;
  /** The crash-loop guard's last error; null clears it (undrain). */
  setCrashLoop(detail: string | null): void;
  /** The last power sample; null before the first or when it failed. */
  power(): PowerSample | null;
  /** Samples power now and runs the guards; overlapping calls share the sample under way. */
  sample(): Promise<void>;
  /** Samples at once and then every sampleEveryMs. */
  start(): void;
  close(): void;
}

export interface ServiceHealthOptions {
  paths: RunnerPaths;
  /** runner.json's values, read on every use so an edit applies at once. */
  config: () => Pick<RunnerConfig, 'minFreeGb' | 'batteryDrainPercent' | 'timings'>;
  /** The interval heartbeats go at now: welcome's override, or timings.heartbeat. */
  heartbeatMs: () => number;
  /** RunnerHandle.stopAgents, bound by the host once the handle exists; it may throw until then. */
  stopAgents: (cause: 'runner_stop', options: { handoff: false }) => Promise<unknown>;
  samplePower?: () => Promise<PowerSample | null>;
  /** diskFreeBytes(AGFLOW_HOME) by default. */
  freeBytes?: () => number | null;
  /** agflow's own disk usage: an AgflowUsage over AGFLOW_HOME by default. */
  usage?: { current(): number };
  now?: () => number;
  clock?: ClockSource;
  /** 60 s. */
  sampleEveryMs?: number;
  /** Called after each power sample and each heartbeat: the host re-evaluates keep-awake there. */
  onSample?: () => void;
  logger?: Logger;
}

export function createServiceHealth(options: ServiceHealthOptions): ServiceHealth {
  const clock = options.clock ?? systemClock;
  const now = options.now ?? (() => clock.now());
  const logger = options.logger ?? noopLogger;
  const readPower = options.samplePower ?? samplePower;
  const readFreeBytes = options.freeBytes ?? (() => diskFreeBytes(options.paths.home));
  const usage = options.usage ?? new AgflowUsage({ root: options.paths.home, now });
  let power: PowerSample | null = null;
  let wakingUntil: number | null = null;
  /** The wakeHold of the gap that set wakingUntil. */
  let wakingFor = 0;
  let needsLogin = false;
  let crashLoop: string | null = null;
  let batteryTripped = false;
  let diskTripped = false;
  let stopping = false;
  let inFlight: Promise<void> | null = null;
  let timer: unknown = null;

  /** One stop call at a time; a stop with no agent to reach returns at once, so repeating it costs little. */
  function stop(): void {
    stopping = true;
    const failed = (error: unknown) => logger.error('guard stop failed', { error: String(error) });
    const done = () => {
      stopping = false;
    };
    try {
      options.stopAgents('runner_stop', { handoff: false }).catch(failed).finally(done);
    } catch (error) {
      failed(error);
      done();
    }
  }

  function evaluate() {
    const config = options.config();
    const at = now();
    if (wakingUntil !== null && wakingUntil - at > wakingFor) wakingUntil = at + wakingFor;
    const freeBytes = readFreeBytes();
    const decision = admissionDecision({
      ...config,
      now: at,
      wakingUntil,
      power,
      freeBytes,
      needsLogin,
    });
    if (decision.batteryStop && !batteryTripped) {
      logger.warn('battery guard stopping agents', { guard: 'battery', value: power?.batteryPercent ?? null });
    }
    if (decision.diskStop && !diskTripped) {
      logger.warn('disk guard stopping agents', { guard: 'disk', value: freeBytes });
    }
    batteryTripped = decision.batteryStop;
    diskTripped = decision.diskStop;
    // stopping is set before the host runs, so a reentrant health read starts no second call.
    if ((batteryTripped || diskTripped) && !stopping) stop();
    return { decision, at, freeBytes, minFreeGb: config.minFreeGb };
  }

  function notify(): void {
    try {
      options.onSample?.();
    } catch (error) {
      logger.error('health sample observer failed', { error: String(error) });
    }
  }

  function sample(): Promise<void> {
    if (inFlight) return inFlight;
    inFlight = Promise.resolve()
      .then(async () => {
        try {
          power = await readPower();
        } catch (error) {
          power = null;
          logger.error('power sample failed', { error: String(error) });
        }
        evaluate();
        notify();
      })
      // The timer does not await this: a throwing config read must not become an unhandled rejection.
      .catch((error) => logger.error('health evaluation failed', { error: String(error) }))
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  return {
    gap(gap) {
      const hold = options.config().timings.wakeHold;
      const end = gap.at + hold;
      if (wakingUntil === null || end > wakingUntil) {
        wakingUntil = end;
        wakingFor = hold;
      }
    },
    setNeedsLogin(on) {
      needsLogin = on;
    },
    setCrashLoop(detail) {
      crashLoop = detail;
    },
    power: () => power,
    sample,
    start() {
      if (timer !== null) return;
      timer = clock.setInterval(() => void sample(), options.sampleEveryMs ?? 60_000);
      void sample();
    },
    close() {
      if (timer !== null) clock.clearInterval(timer);
      timer = null;
    },
    admit: () => evaluate().decision.refusal,
    heartbeat() {
      const { decision, at, freeBytes } = evaluate();
      // A hold with no end goes out as two heartbeat intervals; the next heartbeat renews it.
      const hold = Math.max(
        decision.waking && wakingUntil !== null ? wakingUntil - at : 0,
        decision.batteryLow || decision.diskLow ? 2 * options.heartbeatMs() : 0,
      );
      const report: HealthReport = {
        power,
        disk: freeBytes === null ? null : { freeBytes, agflowBytes: usage.current() },
        acceptingUntil: hold > 0 ? hold : null,
      };
      notify();
      return report;
    },
    state() {
      const { decision, minFreeGb } = evaluate();
      if (crashLoop !== null) return { state: 'crash_loop', detail: crashLoop };
      // The detail stays fixed for a threshold: a change of it goes out as a persisted runner.state event, and the
      // heartbeat's disk.freeBytes already carries the live number.
      if (decision.diskLow) return { state: 'disk_low', detail: `free space below ${minFreeGb} GB` };
      return { state: 'ok', detail: null };
    },
  };
}
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `bun test packages/runner/test/ops/health.test.ts && bun test && bun run typecheck`
Expected: the task's tests pass; then the whole suite passes (`0 fail`) and `tsc` exits 0.

The guards warn once per crossing. While a guard stays tripped, each evaluation (admit, state, heartbeat, sample) calls `stopAgents('runner_stop', { handoff: false })` again when no such call is in flight, so a resume that skipped admission is stopped at the next evaluation; `RunnerHandle.stopAgents` with no slot holder returns at once. `stopAgents` may throw until the host binds the handle; that is logged and retried. Power is sampled at start and every 60 s, also with the link down; free space is read on each evaluation, in decimal GB as macOS reports it. A hold with no end goes out as two heartbeat intervals and is renewed on each heartbeat.

- [ ] **Step 5: Commit**

```bash
git add -A 'packages/runner/src/ops/health.ts' 'packages/runner/test/ops/health.test.ts'
git commit -m 'M2C Task 8: Service health: holds, refusals and guard stops' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

### Task 9: Keep-awake

`keepAwake` is `off`, `ac` or `always` (design 7.9). `KeepAwake` holds one `caffeinate -i -w <runner pid>`, in the runner's own process group, while an attempt is starting, running or in quota_wait; an idle lead holds it only on AC power. After each spawn it checks that caffeinate is still alive, because a bad pid makes it exit 0 at once, and it restarts caffeinate if something kills it. It reads the mode, the power and the attempts on every evaluation, so an `update_settings` change applies within a heartbeat.

**Files:**
- Create: `packages/runner/src/ops/keep-awake.ts`
- Test: `packages/runner/test/ops/keep-awake.test.ts`

- [ ] **Step 1: Write the failing test**

**File:** `packages/runner/test/ops/keep-awake.test.ts` (new)

```ts
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentRole, AttemptPhase } from '@agflow/core';
import type { ClockSource } from '../../src/clock';
import { memoryLogger } from '../../src/log';
import { KeepAwake, type KeepAwakeAttempt, type KeepAwakeMode, wantsKeepAwake } from '../../src/ops/keep-awake';
import type { PowerSample } from '../../src/ops/power';
import { waitFor } from '../fixture';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const power = (source: PowerSample['source']): PowerSample => ({
  source,
  batteryPercent: 50,
  lowPowerMode: false,
});

function fakeClock() {
  let now = 0;
  const timers = new Map<unknown, { at: number; fn: () => void }>();
  const clock: ClockSource = {
    now: () => now,
    setTimeout(fn, ms) {
      const handle = {};
      timers.set(handle, { at: now + ms, fn });
      return handle;
    },
    clearTimeout: (handle) => {
      timers.delete(handle);
    },
    setInterval: () => {
      throw new Error('unexpected interval');
    },
    clearInterval: () => {
      throw new Error('unexpected interval');
    },
  };
  return {
    clock,
    pending: () => timers.size,
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].fn();
      }
      now = end;
    },
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function fixture(exits = false, overrides: Partial<ConstructorParameters<typeof KeepAwake>[0]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'agflow-keep-awake-'));
  const command = join(dir, 'caffeinate');
  const record = join(dir, 'calls');
  const exitFlag = join(dir, 'exit');
  if (exits) writeFileSync(exitFlag, '');
  writeFileSync(
    command,
    `#!/bin/sh
printf '%s %s %s %s\\n' "$$" "$1" "$2" "$3" >> '${record}'
if [ -f '${exitFlag}' ]; then exit 0; fi
while kill -0 "$3" 2>/dev/null; do sleep 0.01; done
`,
    { mode: 0o755 },
  );
  const calls = () =>
    existsSync(record)
      ? readFileSync(record, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const [pid, ...argv] = line.split(' ');
            return { pid: Number(pid), argv };
          })
      : [];
  const state = {
    mode: 'ac' as KeepAwakeMode,
    power: power('ac') as PowerSample | null,
    attempts: [{ role: 'worker', phase: 'turn' }] as KeepAwakeAttempt[],
  };
  const time = fakeClock();
  const logger = memoryLogger();
  const keep = new KeepAwake({
    mode: () => state.mode,
    power: () => state.power,
    attempts: () => state.attempts,
    command,
    platform: 'linux',
    aliveCheckMs: 20,
    retryBaseMs: 30,
    retryCapMs: 100,
    clock: time.clock,
    logger,
    ...overrides,
  });
  cleanups.push(async () => {
    const closing = keep.close();
    for (const { pid } of calls()) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* Already reaped. */
      }
    }
    await closing;
    rmSync(dir, { recursive: true, force: true });
  });
  return { keep, state, time, logger, calls, exitFlag };
}

describe('wantsKeepAwake', () => {
  test('covers every phase, role, mode and power source', () => {
    const phases: (AttemptPhase | null)[] = [
      'starting',
      'preparing',
      'turn',
      'waiting_approval',
      'quota_wait',
      'idle',
      'vendor_error',
      'stopping',
      null,
    ];
    for (const mode of ['off', 'ac', 'always'] as const) {
      for (const sample of [power('ac'), power('battery'), power('unknown'), null]) {
        expect(wantsKeepAwake({ mode, power: sample, attempts: [] })).toBe(false);
        for (const role of ['worker', 'lead'] as AgentRole[]) {
          for (const phase of phases) {
            const active = phase !== null && !(role === 'lead' && phase === 'idle');
            const expected =
              mode !== 'off' && phase !== null && (sample?.source === 'ac' || (mode === 'always' && active));
            expect(
              wantsKeepAwake({
                mode,
                power: sample,
                attempts: [{ role, phase }],
              }),
            ).toBe(expected);
          }
        }
      }
    }
    expect(
      wantsKeepAwake({
        mode: 'always',
        power: null,
        attempts: [
          { role: 'lead', phase: 'idle' },
          { role: 'worker', phase: 'turn' },
        ],
      }),
    ).toBe(true);
  });
});

describe('KeepAwake', () => {
  test('two attempts share one process with the runner pid until the last ends', async () => {
    const f = fixture();
    f.state.attempts.push({ role: 'worker', phase: 'starting' });
    expect(f.keep.isHeld()).toBe(false);
    f.keep.evaluate();
    await waitFor(() => f.calls().length === 1);
    const first = f.calls()[0];
    expect(first.argv).toEqual(['-i', '-w', String(process.pid)]);
    // In the runner's own process group (7.9), so the assertion goes with the runner's group.
    const pgid = (pid: number) => Bun.spawnSync(['ps', '-o', 'pgid=', '-p', String(pid)]).stdout.toString().trim();
    expect(pgid(first.pid)).toBe(pgid(process.pid));
    f.time.advance(20);
    expect(f.keep.isHeld()).toBe(true);
    f.state.attempts[0].phase = null;
    for (let i = 0; i < 10; i++) f.keep.evaluate();
    expect(f.calls()).toHaveLength(1);
    expect(alive(first.pid)).toBe(true);
    f.state.attempts[1].phase = null;
    f.keep.evaluate();
    expect(f.keep.isHeld()).toBe(false);
    await waitFor(() => !alive(first.pid));
    expect(f.logger.entries.filter((entry) => entry.level === 'info').map((entry) => entry.fields.pid)).toEqual([
      first.pid,
      first.pid,
    ]);
    expect(f.time.pending()).toBe(0);
  });

  test('an outside kill after the alive check restarts immediately', async () => {
    const f = fixture();
    f.keep.evaluate();
    await waitFor(() => f.calls().length === 1);
    f.time.advance(20);
    process.kill(f.calls()[0].pid, 'SIGKILL');
    await waitFor(() => f.calls().length === 2);
    expect(f.calls()[1].pid).not.toBe(f.calls()[0].pid);
    expect(f.keep.isHeld()).toBe(true);
    expect(f.logger.entries.some((entry) => entry.level === 'warn' && entry.fields.pid === f.calls()[0].pid)).toBe(
      true,
    );
  });

  test('immediate exits warn with code 0, back off to the cap, and cancel when attempts end', async () => {
    const f = fixture(true);
    f.keep.evaluate();
    for (const [index, delay] of [30, 60, 100, 100].entries()) {
      await waitFor(() => f.logger.entries.filter((entry) => entry.level === 'warn').length === index + 1);
      expect(f.keep.isHeld()).toBe(false);
      expect(f.logger.entries.filter((entry) => entry.level === 'warn')[index].fields.exitCode).toBe(0);
      for (let i = 0; i < 10; i++) f.keep.evaluate();
      f.time.advance(delay - 1);
      expect(f.calls()).toHaveLength(index + 1);
      f.time.advance(1);
      await waitFor(() => f.calls().length === index + 2);
    }
    await waitFor(() => f.logger.entries.filter((entry) => entry.level === 'warn').length === 5);
    f.state.attempts[0].phase = null;
    f.keep.evaluate();
    expect(f.time.pending()).toBe(0);
    f.time.advance(10_000);
    expect(f.calls()).toHaveLength(5);
  });

  test('passing the alive check resets backoff for the next immediate exit', async () => {
    const f = fixture(true);
    f.keep.evaluate();
    await waitFor(() => f.logger.entries.some((entry) => entry.level === 'warn'));
    rmSync(f.exitFlag);
    f.time.advance(30);
    await waitFor(() => f.calls().length === 2);
    f.time.advance(20);
    writeFileSync(f.exitFlag, '');
    process.kill(f.calls()[1].pid, 'SIGKILL');
    await waitFor(() => f.logger.entries.filter((entry) => entry.level === 'warn').length === 3);
    f.time.advance(29);
    expect(f.calls()).toHaveLength(3);
    f.time.advance(1);
    await waitFor(() => f.calls().length === 4);
  });

  test('settings and power changes apply at evaluation, including rapid off/on', async () => {
    const f = fixture();
    f.keep.evaluate();
    await waitFor(() => f.calls().length === 1);
    f.state.mode = 'off';
    f.keep.evaluate();
    expect(f.keep.isHeld()).toBe(false);
    f.state.mode = 'always';
    f.keep.evaluate();
    await waitFor(() => f.calls().length === 2 && f.keep.isHeld());
    expect(alive(f.calls()[0].pid)).toBe(false);
    f.state.mode = 'ac';
    f.state.power = power('battery');
    f.keep.evaluate();
    expect(f.keep.isHeld()).toBe(false);
    await waitFor(() => !alive(f.calls()[1].pid));
    f.state.power = power('ac');
    f.keep.evaluate();
    await waitFor(() => f.calls().length === 3 && f.keep.isHeld());
  });

  test('close releases, cancels the alive check, and permanently disables evaluate', async () => {
    const f = fixture();
    f.keep.evaluate();
    await waitFor(() => f.calls().length === 1);
    await Promise.all([f.keep.close(), f.keep.close()]);
    expect(alive(f.calls()[0].pid)).toBe(false);
    expect(f.keep.isHeld()).toBe(false);
    expect(f.time.pending()).toBe(0);
    f.keep.evaluate();
    f.time.advance(10_000);
    expect(f.calls()).toHaveLength(1);
  });

  test('spawn failures back off without throwing, and close cancels retries', async () => {
    const f = fixture(false, { command: '/nonexistent/agflow-caffeinate' });
    expect(() => f.keep.evaluate()).not.toThrow();
    expect(f.keep.isHeld()).toBe(false);
    expect(f.logger.entries.filter((entry) => entry.level === 'warn')).toHaveLength(1);
    f.time.advance(29);
    f.keep.evaluate();
    expect(f.logger.entries.filter((entry) => entry.level === 'warn')).toHaveLength(1);
    f.time.advance(1);
    expect(f.logger.entries.filter((entry) => entry.level === 'warn')).toHaveLength(2);
    await f.keep.close();
    expect(f.time.pending()).toBe(0);
    f.time.advance(10_000);
    expect(f.logger.entries.filter((entry) => entry.level === 'warn')).toHaveLength(2);
  });

  test('off macOS the default command never spawns', async () => {
    const f = fixture(false, { command: undefined, platform: 'linux' });
    f.keep.evaluate();
    expect(f.keep.isHeld()).toBe(false);
    expect(f.time.pending()).toBe(0);
    expect(f.logger.entries).toEqual([]);
  });

  test('source and logger exceptions cannot escape evaluate', () => {
    const fail = () => {
      throw new Error('host callback failed');
    };
    const f = fixture(false, {
      mode: fail,
      logger: { debug: fail, info: fail, warn: fail, error: fail },
    });
    expect(() => f.keep.evaluate()).not.toThrow();
    expect(f.keep.isHeld()).toBe(false);
  });

  test.skipIf(process.platform !== 'darwin')('real caffeinate survives its check and close ends it', async () => {
    const f = fixture(false, { command: undefined, platform: 'darwin' });
    f.keep.evaluate();
    const pid = f.logger.entries.find((entry) => entry.level === 'info')?.fields.pid as number;
    expect(pid).toBeGreaterThan(0);
    // Give the real command time to reject a bad watch pid before driving the check.
    await Bun.sleep(100);
    f.time.advance(20);
    expect(alive(pid)).toBe(true);
    expect(f.keep.isHeld()).toBe(true);
    await f.keep.close();
    expect(alive(pid)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `bun test packages/runner/test/ops/keep-awake.test.ts`
Expected: FAIL — `error: Cannot find module '../../src/ops/keep-awake' from 'packages/runner/test/ops/keep-awake.test.ts'` (0 pass, 1 fail, 1 error)

- [ ] **Step 3: Implement**

**File:** `packages/runner/src/ops/keep-awake.ts` (new)

```ts
// Keep-awake (design 7.9): one `caffeinate -i -w <runner pid>` while attempts need the Mac awake, ref-counted over
// them and re-evaluated on every attempt-state change, power sample and heartbeat, so a keepAwake change from
// update_settings applies within one heartbeat. A bad pid makes caffeinate exit 0 at once, so each spawn is checked.
import type { AgentRole, AttemptPhase, RunnerSettings } from '@agflow/core';
import type { Subprocess } from 'bun';
import { type ClockSource, systemClock } from '../clock';
import { type LogFields, type Logger, noopLogger } from '../log';
import type { PowerSample } from './power';

export type KeepAwakeMode = RunnerSettings['keepAwake'];
/** RunnerStatus's attempts fit it; phase null means holding, stopped or ended. */
export type KeepAwakeAttempt = { role: AgentRole; phase: AttemptPhase | null };

/**
 * Off never holds. On AC any attempt with a phase holds; otherwise only always holds, and only for an active attempt:
 * a lead idle between wake-ups holds on AC alone (a worker's idle between turns is active).
 */
export function wantsKeepAwake(input: {
  mode: KeepAwakeMode;
  power: PowerSample | null;
  attempts: readonly KeepAwakeAttempt[];
}): boolean {
  if (input.mode === 'off') return false;
  const ac = input.power?.source === 'ac';
  if (!ac && input.mode === 'ac') return false;
  return input.attempts.some(({ role, phase }) => phase !== null && (ac || role !== 'lead' || phase !== 'idle'));
}

export interface KeepAwakeOptions {
  /** runner.json's current keepAwake, read on every evaluation. */
  mode: () => KeepAwakeMode;
  /** The last power sample: ServiceHealth.power(). */
  power: () => PowerSample | null;
  /** The runner's attempts: RunnerHandle.status().attempts. */
  attempts: () => readonly KeepAwakeAttempt[];
  /** The runner's pid, process.pid by default. */
  pid?: number;
  /** /usr/bin/caffeinate; an injected command also runs off macOS. */
  command?: string;
  platform?: NodeJS.Platform;
  /** 1 s. */
  aliveCheckMs?: number;
  /** 1 s, doubling up to retryCapMs (60 s). */
  retryBaseMs?: number;
  retryCapMs?: number;
  clock?: ClockSource;
  logger?: Logger;
}

interface Assertion {
  process: Subprocess<'ignore', 'ignore', 'ignore'>;
  checked: boolean;
  stopping: boolean;
}

/** Holds at most one assertion; never throws from evaluate, so any event may call it. */
export class KeepAwake {
  private readonly clock: ClockSource;
  private readonly logger: Logger;
  private readonly enabled: boolean;
  private readonly retryBaseMs: number;
  private readonly retryCapMs: number;
  private retryMs: number;
  private child: Assertion | null = null;
  private checkTimer: unknown = null;
  private retryTimer: unknown = null;
  private closed = false;

  constructor(private readonly options: KeepAwakeOptions) {
    this.clock = options.clock ?? systemClock;
    this.logger = options.logger ?? noopLogger;
    this.enabled = options.command !== undefined || (options.platform ?? process.platform) === 'darwin';
    this.retryBaseMs = options.retryBaseMs ?? 1_000;
    this.retryCapMs = options.retryCapMs ?? 60_000;
    this.retryMs = Math.min(this.retryBaseMs, this.retryCapMs);
  }

  /** Called by the host on attempt changes, power samples and heartbeats. */
  evaluate(): void {
    if (this.closed) return;
    try {
      if (!this.wanted()) {
        this.cancelRetry();
        this.retryMs = Math.min(this.retryBaseMs, this.retryCapMs);
        this.release();
      } else if (this.child === null && this.retryTimer === null) {
        this.spawn();
      }
    } catch (error) {
      this.log('warn', 'keep-awake evaluation failed', {
        error: String(error),
      });
    }
  }

  isHeld(): boolean {
    try {
      return this.child !== null && !this.child.stopping && this.running(this.child) && this.wanted();
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.cancelRetry();
    this.release();
    await this.child?.process.exited;
  }

  private wanted(): boolean {
    return (
      !this.closed &&
      this.enabled &&
      wantsKeepAwake({
        mode: this.options.mode(),
        power: this.options.power(),
        attempts: this.options.attempts(),
      })
    );
  }

  private running(child: Assertion): boolean {
    return child.process.exitCode === null && child.process.signalCode === null;
  }

  private spawn(): void {
    let proc: Assertion['process'];
    try {
      // No detached flag: the assertion belongs to the runner's own process group.
      proc = Bun.spawn(
        [this.options.command ?? '/usr/bin/caffeinate', '-i', '-w', String(this.options.pid ?? process.pid)],
        {
          stdin: 'ignore',
          stdout: 'ignore',
          stderr: 'ignore',
        },
      );
    } catch (error) {
      this.log('warn', 'keep-awake command could not start', {
        error: String(error),
        exitCode: null,
      });
      this.retry();
      return;
    }
    const child: Assertion = { process: proc, checked: false, stopping: false };
    this.child = child;
    void proc.exited.then(() => this.exited(child));
    this.checkTimer = this.clock.setTimeout(() => {
      this.checkTimer = null;
      if (this.child !== child || child.stopping) return;
      if (!this.running(child)) {
        this.exited(child);
        return;
      }
      child.checked = true;
      this.retryMs = Math.min(this.retryBaseMs, this.retryCapMs);
      this.evaluate();
    }, this.options.aliveCheckMs ?? 1_000);
    this.log('info', 'keep-awake assertion taken', { pid: proc.pid });
  }

  private exited(child: Assertion): void {
    // The alive check and the exit promise may both observe the same exit.
    if (this.child !== child) return;
    this.cancelCheck();
    this.child = null;
    if (child.stopping) {
      this.evaluate();
      return;
    }
    this.log('warn', child.checked ? 'keep-awake command exited unexpectedly' : 'keep-awake command exited at once', {
      pid: child.process.pid,
      exitCode: child.process.exitCode,
      signal: child.process.signalCode,
    });
    if (child.checked) this.evaluate();
    else this.retry();
  }

  private retry(): void {
    try {
      if (!this.wanted()) {
        this.evaluate();
        return;
      }
      const delay = this.retryMs;
      this.retryMs = Math.min(this.retryCapMs, delay * 2);
      this.retryTimer = this.clock.setTimeout(() => {
        this.retryTimer = null;
        this.evaluate();
      }, delay);
    } catch (error) {
      this.log('warn', 'keep-awake retry failed', { error: String(error) });
    }
  }

  private release(): void {
    this.cancelCheck();
    const child = this.child;
    if (child === null || child.stopping) return;
    // Keep tracking it until reaped: a quick off/on must not spawn a second assertion.
    child.stopping = true;
    try {
      child.process.kill('SIGTERM');
    } catch (error) {
      this.log('warn', 'keep-awake release failed', {
        pid: child.process.pid,
        error: String(error),
      });
    }
    this.log('info', 'keep-awake assertion released', {
      pid: child.process.pid,
    });
  }

  private cancelCheck(): void {
    if (this.checkTimer !== null) this.clock.clearTimeout(this.checkTimer);
    this.checkTimer = null;
  }

  private cancelRetry(): void {
    if (this.retryTimer !== null) this.clock.clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private log(level: 'info' | 'warn', message: string, fields: LogFields): void {
    try {
      this.logger[level](message, fields);
    } catch {
      // Logging must not break an event callback or leave a child untracked.
    }
  }
}
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `bun test packages/runner/test/ops/keep-awake.test.ts && bun test && bun run typecheck`
Expected: the task's tests pass; then the whole suite passes (`0 fail`) and `tsc` exits 0.

`Exec` runs a command to completion, so keep-awake uses `Bun.spawn` directly, without `detached`, so caffeinate stays in the runner's group (a test checks the pgid). An immediate exit is retried with a delay that doubles from 1 s to 60 s; an exit after the alive check restarts at once. Attempts are `{ role, phase }`, the shape of `RunnerHandle.status().attempts`, so an idle lead is told apart from a worker's short idle between turns. Off macOS nothing is spawned unless a command is injected.

- [ ] **Step 5: Commit**

```bash
git add -A 'packages/runner/src/ops/keep-awake.ts' 'packages/runner/test/ops/keep-awake.test.ts'
git commit -m 'M2C Task 9: Keep-awake' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

### Task 10: Dependency preparation: config, change detection, environment and policy

What to prepare, and with what (design 7.7, X-40). `prep/config.ts` reads `.agflow/config.json` from the vault at the restore base (X-16), never from the clone's working tree. `prep/plan.ts` fingerprints each entry's `when` files in the clone and keeps the fingerprints per attempt under `prep/<project>/state/`. It builds one run's environment: the agent allowlist without vendor or bridge variables, `HOME` in the clone, a private `TMPDIR`, scripts off by default, and the shared cache only for known installs. It also builds that run's sandbox policy: writes only to the clone, the cache and the `TMPDIR`; reads denied for the credential paths, the runner tree and other clones; network only to the profile's domains.

**Files:**
- Create: `packages/runner/src/prep/config.ts`
- Create: `packages/runner/src/prep/plan.ts`
- Test: `packages/runner/test/prep/config.test.ts`
- Test: `packages/runner/test/prep/plan.test.ts`

- [ ] **Step 1: Write the failing tests**

**File:** `packages/runner/test/prep/config.test.ts` (new)

```ts
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitFiles, gitIn, originRepo } from '@agflow/testkit';
import { ensureRunnerGitFiles, runGit } from '../../src/git/run';
import { Vault } from '../../src/git/vault';
import { runnerPaths } from '../../src/paths';
import { PrepConfigSchema, readPrepConfig } from '../../src/prep/config';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function directory(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agflow-prep-config-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const entry = { run: ['bun', 'install', '--frozen-lockfile', '--ignore-scripts'], when: ['package.json', 'bun.lock'] };
const config = { dependencies: [entry] };

async function fixture(files: Record<string, string>) {
  const repo = await originRepo(files);
  cleanups.push(() => repo.remove());
  const paths = runnerPaths(directory());
  ensureRunnerGitFiles(paths);
  const vault = new Vault({ paths, project: 'demo', repo: { url: repo.path, mainBranch: 'main' } });
  await vault.ensure();
  const fetch = () =>
    runGit(vault.local, ['--git-dir', vault.path, 'fetch', repo.path, 'refs/heads/main:refs/heads/main']);
  await fetch();
  return { repo, vault, fetch };
}

describe('PrepConfigSchema', () => {
  test('accepts the design example, scripts and empty dependency/when lists', () => {
    expect(PrepConfigSchema.parse(config)).toEqual({ dependencies: [{ ...entry, scripts: false }] });
    expect(PrepConfigSchema.parse({ dependencies: [{ ...entry, scripts: true }] }).dependencies[0]?.scripts).toBe(true);
    expect(PrepConfigSchema.parse({ dependencies: [] })).toEqual({ dependencies: [] });
    expect(PrepConfigSchema.safeParse({ dependencies: [{ ...entry, when: [] }] }).success).toBe(true);
  });

  test.each(['bun install', [], [''], ['bun', ''], ['bun', '\0']].map((run) => ({ run })))(
    'rejects invalid argv %j',
    ({ run }) => {
      expect(PrepConfigSchema.safeParse({ dependencies: [{ ...entry, run }] }).success).toBe(false);
    },
  );

  test.each(['', '/package.json', '../a', 'a/../b', 'a/..', '.', './a', 'a/./b', 'a//b', 'a/', 'a\0b', 'C:\\a'])(
    'rejects unsafe or non-normalized when path %j',
    (path) => expect(PrepConfigSchema.safeParse({ dependencies: [{ ...entry, when: [path] }] }).success).toBe(false),
  );

  test('uses strict objects and boolean scripts', () => {
    for (const value of [
      { ...config, extra: true },
      { dependencies: [{ ...entry, extra: true }] },
      { dependencies: [{ ...entry, scripts: 'true' }] },
    ])
      expect(PrepConfigSchema.safeParse(value).success).toBe(false);
  });
});

describe('readPrepConfig', () => {
  test('reads the specified vault commit, ignoring the clone and later commits; absence is null', async () => {
    const { repo, vault, fetch } = await fixture({ 'README.md': 'demo' });
    const base = await commitFiles(repo.path, {
      branch: 'main',
      files: { '.agflow/config.json': JSON.stringify(config) },
    });
    await fetch();
    const clone = join(directory(), 'clone');
    await runGit(vault.local, ['clone', vault.path, clone]);
    mkdirSync(join(clone, '.agflow'), { recursive: true });
    writeFileSync(join(clone, '.agflow/config.json'), '{"dependencies":[]}');
    await commitFiles(repo.path, { branch: 'main', files: { '.agflow/config.json': '{"dependencies":[]}' } });
    await fetch();
    expect(await readPrepConfig(vault, base)).toEqual(PrepConfigSchema.parse(config));
    expect(await readPrepConfig(vault, repo.mainSha)).toBeNull();
    await expect(readPrepConfig(vault, 'f'.repeat(40))).rejects.toThrow('.agflow/config.json');
  });

  test.each(['{', '{"dependencies":[{"run":"bun install","when":[]}]}', ' '.repeat(1024 * 1024 + 1)])(
    'rejects malformed, invalid or oversized config (%#)',
    async (content) => {
      const { vault, repo } = await fixture({ '.agflow/config.json': content });
      await expect(readPrepConfig(vault, repo.mainSha)).rejects.toThrow('.agflow/config.json');
      if (content.length > 1024 * 1024) {
        await expect(readPrepConfig(vault, repo.mainSha)).rejects.toThrow('size limit');
      }
    },
  );

  test.each(['symlink', 'directory'])('rejects a %s named config.json', async (kind) => {
    const { repo, vault, fetch } = await fixture({ 'README.md': 'demo' });
    const clone = join(directory(), 'edit');
    await runGit(vault.local, ['clone', repo.path, clone]);
    mkdirSync(join(clone, '.agflow'));
    if (kind === 'symlink') symlinkSync('../README.md', join(clone, '.agflow/config.json'));
    else {
      mkdirSync(join(clone, '.agflow/config.json'));
      writeFileSync(join(clone, '.agflow/config.json/child'), '{}');
    }
    await gitIn(clone, ['add', '.agflow']);
    await gitIn(clone, ['commit', '-m', 'invalid config type']);
    await gitIn(clone, ['push', 'origin', 'main']);
    await fetch();
    const sha = await gitIn(clone, ['rev-parse', 'HEAD']);
    await expect(readPrepConfig(vault, sha)).rejects.toThrow('regular file');
  });
});
```

**File:** `packages/runner/test/prep/plan.test.ts` (new)

```ts
import { afterEach, describe, expect, test } from 'bun:test';
import {
  closeSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import { RunnerConfigSchema, vendorHomes } from '../../src/config';
import { buildAgentEnv } from '../../src/env';
import { projectKey, runnerPaths } from '../../src/paths';
import { PrepConfigSchema } from '../../src/prep/config';
import {
  prepEntryKey,
  prepEnv,
  prepLayout,
  prepPolicy,
  PrepState,
  prepToolConfig,
  sharesCache,
  whenFingerprint,
  writePrepToolConfig,
} from '../../src/prep/plan';
import { deniedReadPaths, profileOf } from '../../src/profile';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function directory(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agflow-prep-plan-'));
  dirs.push(dir);
  return dir;
}

describe('whenFingerprint', () => {
  test('tracks bytes, names and order; missing is distinct from an empty file', () => {
    const clone = directory();
    const missing = whenFingerprint(clone, ['package.json']);
    writeFileSync(join(clone, 'package.json'), '');
    const empty = whenFingerprint(clone, ['package.json']);
    expect(empty).not.toBe(missing);
    writeFileSync(join(clone, 'package.json'), '{}');
    const present = whenFingerprint(clone, ['package.json']);
    expect(present).toMatch(/^[a-f0-9]{64}$/);
    expect(present).not.toBe(empty);
    expect(whenFingerprint(clone, ['package.json'])).toBe(present);
    expect(whenFingerprint(clone, ['a', 'b'])).not.toBe(whenFingerprint(clone, ['b', 'a']));
    expect(whenFingerprint(clone, ['a'])).not.toBe(whenFingerprint(clone, ['b']));
    expect(whenFingerprint(clone, [])).toBe(whenFingerprint(clone, []));
  });

  test('hashes link target strings, never their contents or symlinked parents', () => {
    const clone = directory();
    const outside = directory();
    writeFileSync(join(outside, 'lock'), 'secret one');
    symlinkSync(join(outside, 'lock'), join(clone, 'lock'));
    symlinkSync(outside, join(clone, 'parent'));
    const link = whenFingerprint(clone, ['lock']);
    const parent = whenFingerprint(clone, ['parent/lock']);
    writeFileSync(join(outside, 'lock'), 'secret two');
    expect(whenFingerprint(clone, ['lock'])).toBe(link);
    expect(whenFingerprint(clone, ['parent/lock'])).toBe(parent);
    rmSync(join(clone, 'lock'));
    symlinkSync('missing-target', join(clone, 'lock'));
    expect(whenFingerprint(clone, ['lock'])).not.toBe(link);
  });

  test('tells one path apart as missing, a directory and a FIFO, without reading them', () => {
    const clone = directory();
    const missing = whenFingerprint(clone, ['lock']);
    mkdirSync(join(clone, 'lock'));
    const dir = whenFingerprint(clone, ['lock']);
    writeFileSync(join(clone, 'lock/child'), 'ignored');
    expect(whenFingerprint(clone, ['lock'])).toBe(dir);
    rmSync(join(clone, 'lock'), { recursive: true });
    expect(Bun.spawnSync(['mkfifo', join(clone, 'lock')]).exitCode).toBe(0);
    const fifo = whenFingerprint(clone, ['lock']);
    expect(new Set([missing, dir, fifo]).size).toBe(3);
    expect(() => whenFingerprint(clone, ['../secret'])).toThrow();
  });

  test('tells one parent apart as missing, a file and a linked directory', () => {
    const clone = directory();
    const outside = directory();
    writeFileSync(join(outside, 'lock'), 'content');
    const missing = whenFingerprint(clone, ['x/lock']);
    writeFileSync(join(clone, 'x'), '');
    const file = whenFingerprint(clone, ['x/lock']);
    rmSync(join(clone, 'x'));
    symlinkSync(outside, join(clone, 'x'));
    const linked = whenFingerprint(clone, ['x/lock']);
    expect(new Set([missing, file, linked]).size).toBe(3);
  });

  test('refuses an oversized when-file without reading it', () => {
    const clone = directory();
    const fd = openSync(join(clone, 'bun.lock'), 'w');
    try {
      // Sparse: 8 GiB of size, almost no disk.
      ftruncateSync(fd, 8 * 1024 ** 3);
    } finally {
      closeSync(fd);
    }
    expect(statSync(join(clone, 'bun.lock')).size).toBe(8 * 1024 ** 3);
    expect(() => whenFingerprint(clone, ['bun.lock'])).toThrow('when-file bun.lock exceeds 64 MiB');
  });
});

describe('PrepState', () => {
  test('persists fingerprints per attempt and entry under the project state directory', () => {
    const paths = runnerPaths(directory());
    const prep = paths.prep(projectKey('https://hub.example', 'demo'));
    const state = new PrepState(prep);
    expect(state.attempts()).toEqual([]);
    expect(state.needs('T-1-a1', 'entry', 'one')).toBe(true);
    state.record('T-1-a1', 'entry', 'one');
    state.record('T-1-a1', 'second', 'two');
    expect(new PrepState(prep).needs('T-1-a1', 'entry', 'one')).toBe(false);
    expect(state.needs('T-1-a1', 'second', 'two')).toBe(false);
    expect(state.needs('T-1-a1', 'entry', 'changed')).toBe(true);
    expect(state.needs('T-1-a2', 'entry', 'one')).toBe(true);
    expect(JSON.parse(readFileSync(join(prep, 'state/T-1-a1.json'), 'utf8'))).toEqual({ entry: 'one', second: 'two' });
    expect(readdirSync(join(prep, 'state'))).toEqual(['T-1-a1.json']);
    expect(state.attempts()).toEqual(['T-1-a1']);
    state.forget('T-1-a1');
    state.forget('T-1-a1');
    expect(state.needs('T-1-a1', 'entry', 'one')).toBe(true);
    expect(state.attempts()).toEqual([]);
  });

  test('corrupt state reruns preparation and unsafe attempt ids are refused', () => {
    const prep = directory();
    const state = new PrepState(prep);
    state.record('a', 'entry', 'one');
    for (const invalid of ['{', 'null', '[]', '{"entry":12}']) {
      writeFileSync(join(prep, 'state/a.json'), invalid);
      expect(state.needs('a', 'entry', 'one')).toBe(true);
    }
    state.record('a', '__proto__', 'fingerprint');
    expect(state.needs('a', '__proto__', 'fingerprint')).toBe(false);
    for (const id of ['../a', '.', '..', '/a', 'a/b', '']) {
      expect(() => state.needs(id, 'entry', 'one')).toThrow();
      expect(() => state.record(id, 'entry', 'one')).toThrow();
      expect(() => state.forget(id)).toThrow();
    }
  });

  test('entry keys change with argv, when or scripts', () => {
    const entry = PrepConfigSchema.parse({
      dependencies: [{ run: ['bun', 'install'], when: ['bun.lock'] }],
    }).dependencies[0]!;
    const key = prepEntryKey(entry);
    expect(prepEntryKey({ ...entry })).toBe(key);
    for (const changed of [{ run: ['npm', 'ci'] }, { when: ['package.json'] }, { scripts: true }]) {
      expect(prepEntryKey({ ...entry, ...changed })).not.toBe(key);
    }
  });
});

function environment(vendor: 'claude' | 'codex') {
  const home = directory();
  const paths = runnerPaths(join(home, '.agflow'));
  const clone = paths.clone('demo', 'a1');
  const prep = paths.prep('demo');
  const config = RunnerConfigSchema.parse({
    runnerKey: 'runner',
    machineId: 'machine',
    name: 'laptop',
    connectivity: { HTTPS_PROXY: 'http://proxy:3128' },
  });
  const secrets = {
    ANTHROPIC_API_KEY: 'secret',
    OPENAI_API_KEY: 'secret',
    AWS_SECRET_ACCESS_KEY: 'secret',
    NPM_TOKEN: 'secret',
    AGFLOW_HOME: 'secret',
    AGFLOW_TEST: '1',
    CLAUDE_CODE_SECRET: 'secret',
    CODEX_SECRET: 'secret',
    SSH_AUTH_SOCK: '/ssh',
    SSH_ASKPASS: '/ask',
    GIT_CONFIG_PARAMETERS: 'secret',
    RUNNER_PRIVATE: 'secret',
  };
  const agentEnv = buildAgentEnv({
    vendor,
    clone,
    paths,
    config,
    tools: paths.agentTools('demo', 'a1'),
    tmpDir: '/tmp/agf/abcdef',
    spec: {
      attemptId: 'a1',
      role: 'worker',
      agentToken: 'agt_secret',
      hubUrl: 'https://hub',
    },
    base: { HOME: home, USER: 'owner', LANG: 'en_US.UTF-8', ...secrets },
    env: {},
  });
  return {
    home,
    paths,
    clone,
    prep,
    config,
    agentEnv,
    secrets,
    tmpDir: join(prep, 'tmp/a1'),
  };
}

const bunInstall = { run: ['bun', 'install', '--frozen-lockfile'] };

describe('sharesCache', () => {
  test('only known installs with scripts off share the cache', () => {
    for (const run of [
      ['bun', 'install'],
      ['bun', 'i', '--frozen-lockfile'],
      ['/opt/homebrew/bin/bun', 'install'],
      ['npm', 'ci'],
      ['npm', 'install'],
      ['npm', 'i'],
      ['pnpm', 'install'],
      ['pnpm', 'i'],
      ['pnpm', 'fetch'],
    ]) {
      expect(sharesCache({ run })).toBe(true);
      expect(sharesCache({ run, scripts: true })).toBe(false);
    }
    for (const run of [
      ['bun'],
      ['bun', 'add', 'left-pad'],
      ['bun', 'run', 'install'],
      ['./bun', 'install'],
      ['node_modules/.bin/pnpm', 'install'],
      ['npm', '--prefix', 'app', 'ci'],
      ['yarn', 'install'],
      ['python3', '-m', 'pip', 'install', '-r', 'requirements.txt'],
      ['pip', 'install'],
      ['uv', 'sync'],
      ['poetry', 'install'],
      ['sh', '-c', 'bun install'],
    ]) {
      expect(sharesCache({ run })).toBe(false);
    }
  });
});

describe('prepEnv', () => {
  test.each(['claude', 'codex'] as const)(
    'removes bridge, SSH and vendor variables from %s, preserving the allowlist',
    (vendor) => {
      const input = environment(vendor);
      const before = { ...input.agentEnv };
      const env = prepEnv({ ...input, entry: bunInstall });
      for (const key of Object.keys(input.secrets)) expect(env[key]).toBeUndefined();
      expect(Object.keys(env).filter((key) => /^(AGFLOW_|CLAUDE_|CODEX_)/.test(key))).toEqual([]);
      expect(env.DISABLE_AUTOUPDATER).toBeUndefined();
      for (const key of ['PATH', 'USER', 'LANG', 'HTTPS_PROXY', 'GIT_CONFIG_GLOBAL', 'GIT_SSH_COMMAND', 'GH_TOKEN']) {
        expect(env[key]).toBe(input.agentEnv[key]!);
      }
      expect(env.HOME).toBe(join(input.clone, '.agflow/run/home'));
      expect(env.TMPDIR).toBe(input.tmpDir);
      expect(env.npm_config_ignore_scripts).toBe('true');
      expect(input.agentEnv).toEqual(before);
      const defensive = prepEnv({
        ...input,
        entry: bunInstall,
        agentEnv: {
          ...input.agentEnv,
          SSH_AUTH_SOCK: '/ssh',
          SSH_ASKPASS: '/ask',
        },
      });
      expect(defensive.SSH_AUTH_SOCK).toBeUndefined();
      expect(defensive.SSH_ASKPASS).toBeUndefined();
    },
  );

  test.each([
    ['a known install', bunInstall, true],
    ['an install with scripts', { ...bunInstall, scripts: true }, false],
    ['pip', { run: ['python3', '-m', 'pip', 'install', '-r', 'requirements.txt'] }, false],
  ] as const)('cache isolation, script switches and copy/clone settings for %s', (_, entry, shared) => {
    const input = environment('claude');
    Object.assign(input.agentEnv, {
      npm_config_ignore_scripts: 'true',
      npm_config_ignore_pnpmfile: 'true',
      YARN_ENABLE_SCRIPTS: 'false',
      XDG_CONFIG_HOME: join(input.home, '.config'),
    });
    const env = prepEnv({ ...input, entry });
    const perAttempt = join(input.clone, '.agflow/run/cache');
    const cache = shared ? join(input.prep, 'cache') : perAttempt;
    for (const [key, name] of Object.entries({
      BUN_INSTALL_CACHE_DIR: 'bun',
      npm_config_cache: 'npm',
      PIP_CACHE_DIR: 'pip',
      UV_CACHE_DIR: 'uv',
      npm_config_store_dir: 'pnpm',
    }))
      expect(env[key]).toBe(join(cache, name));
    expect(env.GOMODCACHE).toBe(join(perAttempt, 'go-mod'));
    expect(env.CARGO_HOME).toBe(join(perAttempt, 'cargo'));
    const scripts = 'scripts' in entry && entry.scripts;
    const switches = {
      npm_config_ignore_scripts: 'true',
      npm_config_ignore_pnpmfile: 'true',
      YARN_ENABLE_SCRIPTS: 'false',
    };
    for (const [key, value] of Object.entries(switches)) {
      if (scripts) expect(env[key]).toBeUndefined();
      else expect(env[key]).toBe(value);
    }
    // Runner-owned, never the agent-writable HOME: Bun reads its global bunfig there instead of $HOME/.bunfig.toml.
    expect(env.XDG_CONFIG_HOME).toBe(join(input.prep, 'config', scripts ? 'scripts' : 'noscripts'));
    expect(env.XDG_CONFIG_HOME).toBe(prepToolConfig(input.prep, scripts));
    expect(env.npm_config_package_import_method).toBe('clone-or-copy');
    expect(env.UV_LINK_MODE).toBe('clone');
    expect(env.PIP_CONFIG_FILE).toBe('/dev/null');
    expect(env.npm_config_userconfig).toBe('/dev/null');
  });

  test('writes the no-scripts bunfig and an empty scripts directory, replacing a stale file', () => {
    const prep = directory();
    writePrepToolConfig(prep);
    const noScripts = prepToolConfig(prep, false);
    writeFileSync(join(noScripts, '.bunfig.toml'), '[install]\nignoreScripts = false\n');
    writePrepToolConfig(prep);
    expect(readFileSync(join(noScripts, '.bunfig.toml'), 'utf8')).toBe('[install]\nignoreScripts = true\n');
    expect(readdirSync(noScripts)).toEqual(['.bunfig.toml']);
    expect(readdirSync(prepToolConfig(prep, true))).toEqual([]);
    expect(statSync(noScripts).mode & 0o777).toBe(0o700);
  });
});

describe('prepPolicy', () => {
  test.each([
    ['a known install', bunInstall, true],
    ['an install with scripts', { ...bunInstall, scripts: true }, false],
    ['pip', { run: ['python3', '-m', 'pip', 'install', '.'] }, false],
  ] as const)('supplies complete per-call lists for %s', (_, entry, shared) => {
    const input = environment('claude');
    const layout = prepLayout(input.prep);
    expect(layout).toEqual({
      cache: join(input.prep, 'cache'),
      tmp: join(input.prep, 'tmp'),
      state: join(input.prep, 'state'),
      config: join(input.prep, 'config'),
    });
    const homes = {
      ...vendorHomes(input.config, input.paths),
      claude: join(input.home, 'outside-claude'),
    };
    const profile = profileOf(input.config);
    profile.network.allowedDomains = ['registry.npmjs.org', 'custom.example'];
    const policy = prepPolicy({ ...input, vendorHomes: homes, entry, profile });
    const runtimeConfig: Partial<SandboxRuntimeConfig> = policy;
    expect(runtimeConfig).toBe(policy);
    const allowed = shared ? [input.clone, layout.cache, input.tmpDir] : [input.clone, input.tmpDir];
    const scripts = 'scripts' in entry && entry.scripts;
    expect(policy.filesystem).toEqual({
      allowWrite: allowed,
      denyWrite: ['/tmp/claude', '/private/tmp/claude', join(input.home, '.npm/_logs')],
      denyRead: [
        ...deniedReadPaths({ ...input, vendorHomes: homes }).map(({ path }) => path),
        join(input.paths.work, '*', '*'),
      ],
      allowRead: [...allowed, prepToolConfig(input.prep, scripts)],
    });
    // The section 7.6 credential paths, the runner tree, a vendor home outside it and every clone, by name.
    for (const denied of [
      join(input.home, '.ssh'),
      join(input.home, '.config/agflow'),
      join(input.home, '.claude'),
      join(input.home, 'Library/Keychains'),
      input.paths.runner,
      homes.claude,
      join(input.paths.work, '*', '*'),
    ]) {
      expect(policy.filesystem.denyRead).toContain(denied);
    }
    for (const forbidden of [input.prep, layout.state, layout.config]) {
      expect(policy.filesystem.allowWrite).not.toContain(forbidden);
    }
    expect(policy.network).toEqual({
      allowedDomains: ['registry.npmjs.org', 'custom.example'],
      deniedDomains: [],
    });
    profile.network.allowedDomains.push('later.example');
    expect(policy.network.allowedDomains).toEqual(['registry.npmjs.org', 'custom.example']);
  });
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `bun test packages/runner/test/prep/config.test.ts packages/runner/test/prep/plan.test.ts`
Expected: FAIL — `error: Cannot find module '../../src/prep/config' from 'packages/runner/test/prep/plan.test.ts'`, and the same from `config.test.ts` (0 pass, 2 fail, 2 errors)

- [ ] **Step 3: Implement**

**File:** `packages/runner/src/prep/config.ts` (new)

```ts
// The project's dependency-preparation config (design 7.7): `.agflow/config.json`, a people-only file, read from the
// vault at the restore base (X-16) and never from the clone, whose working tree the agent controls.
import { z } from 'zod';
import { runGit } from '../git/run';
import type { Vault } from '../git/vault';

const CONFIG_PATH = '.agflow/config.json';
const MAX_CONFIG_BYTES = 1024 * 1024;
const WhenPath = z
  .string()
  .refine(
    (path) =>
      !/[\\\0]/.test(path) &&
      !/^[A-Za-z]:/.test(path) &&
      path.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
    { error: 'when paths must be normalized relative POSIX paths' },
  );

export const PrepConfigSchema = z.strictObject({
  dependencies: z.array(
    z.strictObject({
      run: z
        .array(
          z
            .string()
            .min(1)
            .refine((arg) => !arg.includes('\0'), { error: 'argv must not contain NUL' }),
        )
        .min(1),
      // Empty means once per attempt and entry configuration.
      when: z.array(WhenPath),
      scripts: z.boolean().default(false),
    }),
  ),
});

export type PrepConfig = z.output<typeof PrepConfigSchema>;

/** Read only the restore base in the vault; no config in an agent's work tree is authoritative. */
export async function readPrepConfig(vault: Vault, baseSha: string): Promise<PrepConfig | null> {
  try {
    if (!/^[a-f0-9]{40}$/.test(baseSha)) throw new Error('expected a full restore-base commit sha');
    const git = async (args: string[]) => (await runGit(vault.local, ['--git-dir', vault.path, ...args])).stdout;
    const entry = await git(['ls-tree', '-z', baseSha, '--', CONFIG_PATH]);
    if (entry === '') return null;
    const match = entry.match(/^(100644|100755) blob ([a-f0-9]{40})\t\.agflow\/config\.json\0$/);
    if (!match) throw new Error('must be a regular file');
    const oid = match[2]!;
    const size = Number((await git(['cat-file', '-s', oid])).trim());
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_CONFIG_BYTES) {
      throw new Error(`exceeds the ${MAX_CONFIG_BYTES}-byte size limit`);
    }
    const parsed = PrepConfigSchema.safeParse(JSON.parse(await git(['cat-file', 'blob', oid])));
    if (!parsed.success) {
      throw new Error(
        parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; '),
      );
    }
    return parsed.data;
  } catch (error) {
    throw new Error(`${CONFIG_PATH}: ${(error as Error).message}`, { cause: error });
  }
}
```

**File:** `packages/runner/src/prep/plan.ts` (new)

```ts
// What a dependency preparation runs with (design 7.7, X-40): the when-file fingerprints that decide whether an entry
// runs again, kept per attempt under prep/<project>/state/; the environment, the agent's allowlist with the
// preparation's own HOME, TMPDIR and caches; and the sandbox runtime's per-call policy. Nothing here runs a command.
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  readSync,
  renameSync,
  rmSync,
  type Stats,
  writeFileSync,
} from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import { deniedReadPaths, type DeniedPathsInput, type PermissionProfile } from '../profile';
import { runDirOf } from '../run-dir';
import { type PrepConfig, PrepConfigSchema } from './config';

const WhenPath = PrepConfigSchema.shape.dependencies.element.shape.when.element;
const SAFE_NAME = /^(?!\.\.?$)[A-Za-z0-9._-]+$/;
// Agents control when-files; a sparse multi-gigabyte lockfile must not stall the runner's event loop.
const MAX_WHEN_FILE_BYTES = 64 * 1024 * 1024;

function statOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function kind(stat: Stats): number {
  return stat.mode & constants.S_IFMT;
}

function fingerprintFile(clone: string, relative: string): unknown[] {
  let path = clone;
  const parts = relative.split('/');
  // Parents inside the agent's tree must be real directories, including the clone root.
  for (let i = 0; i < parts.length; i++) {
    const parent = statOrNull(path);
    if (!parent) return ['missing-parent', i];
    if (!parent.isDirectory()) return ['blocked-parent', i, kind(parent)];
    path = join(path, parts[i]!);
  }
  const stat = statOrNull(path);
  if (!stat) return ['missing'];
  if (stat.isSymbolicLink()) return ['symlink', readlinkSync(path, { encoding: 'buffer' }).toString('hex')];
  if (!stat.isFile()) return ['kind', kind(stat)];
  // Refuse a final symlink swapped in since lstat; O_NONBLOCK also prevents a replacement FIFO from hanging.
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) return ['kind', kind(opened)];
    if (opened.size > MAX_WHEN_FILE_BYTES) {
      throw new Error(`when-file ${relative} exceeds ${MAX_WHEN_FILE_BYTES / (1024 * 1024)} MiB`);
    }
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
    }
    return ['file', hash.digest('hex')];
  } finally {
    closeSync(fd);
  }
}

/** Ordered, framed records distinguish absent files, empty files, links and special files without following links. */
export function whenFingerprint(clone: string, when: readonly string[]): string {
  const hash = createHash('sha256');
  for (const relative of when) {
    WhenPath.parse(relative);
    hash.update(`${JSON.stringify([relative, ...fingerprintFile(clone, relative)])}\n`);
  }
  return hash.digest('hex');
}

/** A config edit reruns an entry even if its watched files are unchanged. */
export function prepEntryKey(entry: PrepConfig['dependencies'][number]): string {
  return createHash('sha256')
    .update(JSON.stringify([entry.run, entry.when, entry.scripts]))
    .digest('hex');
}

export function prepLayout(prepRoot: string): {
  cache: string;
  tmp: string;
  state: string;
  config: string;
} {
  return {
    cache: join(prepRoot, 'cache'),
    tmp: join(prepRoot, 'tmp'),
    state: join(prepRoot, 'state'),
    config: join(prepRoot, 'config'),
  };
}

export interface PrepCommand {
  run: readonly string[];
  scripts?: boolean;
}

const SHARED_INSTALLS: Record<string, readonly string[]> = {
  bun: ['install', 'i'],
  npm: ['ci', 'install', 'i'],
  pnpm: ['install', 'i', 'fetch'],
};

/**
 * Only these installs run no repository code with scripts off, so only they may write the shared cache. Anything
 * else can (pip and uv build agent-edited local packages, yarn runs .yarn/releases and plugins, a shell runs
 * anything), so like "scripts": true it gets per-attempt caches. A relative argv[0] is the agent's own file.
 */
export function sharesCache(command: PrepCommand): boolean {
  const [program, subcommand] = command.run;
  if (command.scripts || !program || subcommand === undefined) return false;
  if (program.includes('/') && !isAbsolute(program)) return false;
  return SHARED_INSTALLS[basename(program)]?.includes(subcommand) ?? false;
}

/** XDG_CONFIG_HOME for a preparation: runner-owned, outside the clone, and never writable from the sandbox. */
export function prepToolConfig(prep: string, scripts?: boolean): string {
  return join(prepLayout(prep).config, scripts ? 'scripts' : 'noscripts');
}

/**
 * Writes the preparations' tool config. Bun 1.3.11 ignores npm_config_ignore_scripts, so with scripts off its
 * global bunfig turns them off; that bunfig is read from XDG_CONFIG_HOME, which also stops Bun reading
 * $HOME/.bunfig.toml in the agent-writable HOME. The scripts variant stays empty.
 */
export function writePrepToolConfig(prep: string): void {
  const config = prepLayout(prep).config;
  for (const dir of [config, prepToolConfig(prep, false), prepToolConfig(prep, true)]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const path = join(prepToolConfig(prep, false), '.bunfig.toml');
  const temporary = join(prepToolConfig(prep, false), `.bunfig.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, '[install]\nignoreScripts = true\n', {
      flag: 'wx',
      mode: 0o600,
    });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** State is runner-owned and outside the sandbox's cache and tmp allowances. */
export class PrepState {
  private readonly state: string;

  constructor(prepRoot: string) {
    this.state = prepLayout(prepRoot).state;
  }

  private path(attemptId: string): string {
    if (!SAFE_NAME.test(attemptId)) throw new Error(`not a safe attempt id: ${JSON.stringify(attemptId)}`);
    return join(this.state, `${attemptId}.json`);
  }

  private read(attemptId: string): Record<string, string> {
    const path = this.path(attemptId);
    let content: string;
    try {
      content = readFileSync(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Object.create(null);
      throw error;
    }
    try {
      const entries: unknown = JSON.parse(content);
      if (
        !entries ||
        typeof entries !== 'object' ||
        Array.isArray(entries) ||
        Object.values(entries).some((value) => typeof value !== 'string')
      )
        return Object.create(null);
      return entries as Record<string, string>;
    } catch {
      return Object.create(null);
    }
  }

  needs(attemptId: string, entryKey: string, fingerprint: string): boolean {
    const entries = this.read(attemptId);
    return !Object.hasOwn(entries, entryKey) || entries[entryKey] !== fingerprint;
  }

  record(attemptId: string, entryKey: string, fingerprint: string): void {
    const path = this.path(attemptId);
    const entries = { ...this.read(attemptId), [entryKey]: fingerprint };
    mkdirSync(this.state, { recursive: true, mode: 0o700 });
    const temporary = join(this.state, `.${attemptId}.${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, `${JSON.stringify(entries)}\n`, {
        flag: 'wx',
        mode: 0o600,
      });
      renameSync(temporary, path);
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  forget(attemptId: string): void {
    rmSync(this.path(attemptId), { force: true });
  }

  attempts(): string[] {
    try {
      return readdirSync(this.state, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json') && SAFE_NAME.test(entry.name.slice(0, -5)))
        .map((entry) => entry.name.slice(0, -5))
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
}

export interface PrepEnvInput {
  /** PrepareInput.env, already built from M2b's agent allowlist. Never pass the runner's process.env. */
  agentEnv: Record<string, string>;
  clone: string;
  /** paths.prep(project). */
  prep: string;
  /**
   * A private directory (mode 0700) under prepLayout(prep).tmp; the preparer (createDependencyPreparer) creates one
   * for each preparation and removes it afterwards.
   */
  tmpDir: string;
  /** The config entry: scripts decides the no-scripts switches, sharesCache the caches. */
  entry: PrepCommand;
}

export function prepEnv(input: PrepEnvInput): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(input.agentEnv).filter(
      ([name]) =>
        !name.startsWith('AGFLOW_') &&
        !name.startsWith('CLAUDE_CODE_') &&
        !name.startsWith('CODEX_') &&
        !['CLAUDE_CONFIG_DIR', 'DISABLE_AUTOUPDATER', 'SSH_AUTH_SOCK', 'SSH_ASKPASS'].includes(name),
    ),
  );
  // Only home and cache are needed; tools and the agent git environment stay as the controller supplied them.
  const run = runDirOf(input.clone, '');
  const cache = sharesCache(input.entry) ? prepLayout(input.prep).cache : run.cache;
  Object.assign(env, {
    HOME: run.home,
    TMPDIR: input.tmpDir,
    BUN_INSTALL_CACHE_DIR: join(cache, 'bun'),
    npm_config_cache: join(cache, 'npm'),
    npm_config_store_dir: join(cache, 'pnpm'),
    PIP_CACHE_DIR: join(cache, 'pip'),
    UV_CACHE_DIR: join(cache, 'uv'),
    GOMODCACHE: join(run.cache, 'go-mod'),
    CARGO_HOME: join(run.cache, 'cargo'),
    npm_config_package_import_method: 'clone-or-copy',
    UV_LINK_MODE: 'clone',
    npm_config_userconfig: '/dev/null',
    PIP_CONFIG_FILE: '/dev/null',
    XDG_CONFIG_HOME: prepToolConfig(input.prep, input.entry.scripts),
  });
  // Bun 1.3.11 has no backend env switch; on the supported macOS runner it defaults to clonefile.
  const noScripts = {
    npm_config_ignore_scripts: 'true',
    npm_config_ignore_pnpmfile: 'true',
    YARN_ENABLE_SCRIPTS: 'false',
  };
  for (const [name, value] of Object.entries(noScripts)) {
    if (input.entry.scripts) delete env[name];
    else env[name] = value;
  }
  return env;
}

export type PrepPolicy = Pick<SandboxRuntimeConfig, 'filesystem' | 'network'>;

export interface PrepPolicyInput extends DeniedPathsInput {
  clone: string;
  /** paths.prep(project). */
  prep: string;
  tmpDir: string;
  entry: PrepCommand;
  profile: PermissionProfile;
}

/** Complete per-call lists: the runtime replaces its global filesystem lists with these. */
export function prepPolicy(input: PrepPolicyInput): PrepPolicy {
  // Agent-controlled code (lifecycle scripts, build backends) must not reach the shared cache at all.
  const allowed = sharesCache(input.entry)
    ? [input.clone, prepLayout(input.prep).cache, input.tmpDir]
    : [input.clone, input.tmpDir];
  return {
    filesystem: {
      allowWrite: [...allowed],
      denyWrite: ['/tmp/claude', '/private/tmp/claude', join(input.home, '.npm', '_logs')],
      // Each clone, not the work root: Bun's script runner fails when it cannot read the clone's parents.
      denyRead: [...deniedReadPaths(input).map(({ path }) => path), join(input.paths.work, '*', '*')],
      allowRead: [...allowed, prepToolConfig(input.prep, input.entry.scripts)],
    },
    network: {
      allowedDomains: [...input.profile.network.allowedDomains],
      deniedDomains: [],
    },
  };
}
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `bun test packages/runner/test/prep/config.test.ts packages/runner/test/prep/plan.test.ts && bun test && bun run typecheck`
Expected: the task's tests pass; then the whole suite passes (`0 fail`) and `tsc` exits 0.

Bun 1.3.11 ignores `npm_config_ignore_scripts`, so scripts are switched off through a runner-owned `XDG_CONFIG_HOME` (`prep/<project>/config/noscripts`, whose `.bunfig.toml` sets `ignoreScripts = true`), which also stops Bun reading the agent-writable `$HOME/.bunfig.toml`. The sandbox can read that directory but never write it. The policy denies `work/*/*` (each clone) rather than `work/`: Bun's script runner must read the clone's parent directories. `whenFingerprint` follows no link and opens files with `O_NOFOLLOW|O_NONBLOCK`, so a FIFO cannot hang it; a `when` file over 64 MiB fails the preparation.

- [ ] **Step 5: Commit**

```bash
git add -A 'packages/runner/src/prep/config.ts' 'packages/runner/src/prep/plan.ts' 'packages/runner/test/prep/config.test.ts' 'packages/runner/test/prep/plan.test.ts'
git commit -m 'M2C Task 10: Dependency preparation: config, change detection, environment and policy' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

### Task 11: Dependency preparation: the sandboxed run

One preparation command runs inside Anthropic's sandbox runtime (`@anthropic-ai/sandbox-runtime` 0.0.81), in the runner process, as design 7.7 says. `PrepSandbox` initialises the process-global `SandboxManager` once and wraps each command with that run's policy as its per-call config, then spawns it asynchronously in its own process group: `spawnSync` would deadlock on the runtime's in-process proxies. It keeps a bounded log tail and kills the group after M2b's `prep` timing, 15 minutes (X-30). `checkPrepSandbox` is the self-check behind `ProfileSummary.dependencyPrep` and setup's check.

**Files:**
- Create: `packages/runner/src/prep/sandbox.ts`
- Test: `packages/runner/test/prep/sandbox.test.ts`

- [ ] **Step 1: Write the failing test**

**File:** `packages/runner/test/prep/sandbox.test.ts` (new)

```ts
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SandboxManager, type SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import { memoryLogger } from '../../src/log';
import { runnerPaths } from '../../src/paths';
import { type PrepCommand, prepEnv, prepLayout, prepPolicy, writePrepToolConfig } from '../../src/prep/plan';
import { checkPrepSandbox, PrepSandbox, type SandboxBackend } from '../../src/prep/sandbox';
import { standardProfile } from '../../src/profile';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agflow-prep-sandbox-')));
  dirs.push(root);
  const home = join(root, 'owner');
  const paths = runnerPaths(join(home, '.agflow'));
  const prep = paths.prep('project');
  const layout = prepLayout(prep);
  const clones = [paths.clone('project', 'one'), paths.clone('project', 'two')];
  const otherProject = paths.clone('other', 'three');
  const outside = join(root, 'outside');
  for (const path of [...clones, otherProject, ...Object.values(layout), outside, join(home, '.ssh')]) {
    mkdirSync(path, { recursive: true });
  }
  writePrepToolConfig(prep);
  const secret = 'secret-that-must-not-reach-the-tail';
  const denied = join(home, '.ssh/id_test');
  writeFileSync(denied, secret);
  // The shared cache; scripts and unknown commands get the per-attempt one.
  const install: PrepCommand = { run: ['bun', 'install'] };
  const spec = (argv: string[], index = 0, entry: PrepCommand = install) => {
    const clone = clones[index]!;
    const tmpDir = join(layout.tmp, `private space's-${index}`);
    mkdirSync(tmpDir, { recursive: true });
    const env = prepEnv({ agentEnv: { PATH: '/usr/bin:/bin' }, clone, prep, tmpDir, entry });
    mkdirSync(env.HOME!, { recursive: true });
    return {
      argv,
      cwd: clone,
      env,
      policy: prepPolicy({
        home,
        paths,
        clone,
        prep,
        tmpDir,
        entry,
        profile: standardProfile,
        vendorHomes: { claude: paths.homes.claude, codex: paths.homes.codex },
      }),
    };
  };
  return { root, home, paths, layout, clones, otherProject, outside, secret, denied, spec };
}

function backend(overrides: Partial<SandboxBackend> = {}): SandboxBackend {
  return {
    initialize: async () => {},
    isSupportedPlatform: () => true,
    checkDependencies: () => ({ errors: [], warnings: [] }),
    wrapWithSandboxArgv: async (command) => ({ argv: ['/bin/sh', '-c', command], env: process.env }),
    cleanupAfterCommand: () => {},
    ...overrides,
  };
}

const options = { allowedDomains: standardProfile.network.allowedDomains };
// One process-global runtime, also shared by the self-check; never reset another test file's manager.
const real = new PrepSandbox(options);

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    // An orphan can briefly be a zombie in Linux CI, pending its reaper.
    if (process.platform === 'linux' && /\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8'))) return false;
    return true;
  } catch (error) {
    if (['ESRCH', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
    throw error;
  }
}

for (const mode of ['pass-through', 'real sandbox'] as const) {
  describe.skipIf(mode === 'real sandbox' && process.platform !== 'darwin')(mode, () => {
    const sandbox = mode === 'real sandbox' ? real : new PrepSandbox({ ...options, manager: backend() });

    test('reports a non-zero exit and both output pipes', async () => {
      const f = fixture();
      const result = await sandbox.run(f.spec(['/bin/sh', '-c', 'echo stdout; echo stderr >&2; exit 3']));
      expect(result.code).toBe(3);
      expect(result.signal).toBeNull();
      expect(result.timedOut).toBe(false);
      expect(result.logTail).toContain('stdout');
      expect(result.logTail).toContain('stderr');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    }, 20_000);

    test('drains large output and caps the UTF-8 tail including its marker', async () => {
      const f = fixture();
      const capped = new PrepSandbox({
        ...options,
        tailBytes: 257,
        ...(mode === 'pass-through' ? { manager: backend() } : {}),
      });
      const result = await capped.run(
        f.spec([
          '/bin/sh',
          '-c',
          'i=0; while [ "$i" -lt 12000 ]; do printf "€🙂abcdefghijk"; i=$((i+1)); done; printf "THE-END"',
        ]),
      );
      expect(result.code).toBe(0);
      expect(Buffer.byteLength(result.logTail)).toBeLessThanOrEqual(257);
      expect(result.logTail).toContain('truncated');
      expect(result.logTail).not.toContain('\uFFFD');
      expect(result.logTail.endsWith('THE-END')).toBe(true);
    }, 20_000);

    test('a timeout kills the whole process group', async () => {
      const f = fixture();
      const pidFile = join(f.clones[0]!, 'child.pid');
      let pid: number | undefined;
      try {
        const result = await sandbox.run({
          ...f.spec(['/bin/sh', '-c', 'sleep 30 & echo $! > child.pid; wait']),
          timeoutMs: 3000,
        });
        expect(result.timedOut).toBe(true);
        expect(result.signal).toBe('SIGKILL');
        pid = Number(readFileSync(pidFile, 'utf8').trim());
        expect(pid).toBeGreaterThan(1);
        const deadline = Date.now() + 2000;
        while (running(pid) && Date.now() < deadline) await Bun.sleep(20);
        expect(running(pid)).toBe(false);
      } finally {
        if (pid && running(pid)) process.kill(pid, 'SIGKILL');
      }
    }, 20_000);

    test('a normal exit kills what the command left running in its group', async () => {
      const f = fixture();
      const late = join(f.layout.cache, 'late');
      let pid: number | undefined;
      try {
        const result = await sandbox.run(
          f.spec(['/bin/sh', '-c', 'sleep 30 & echo $! > child.pid; (sleep 1; echo late > "$1") & exit 0', 'sh', late]),
        );
        expect(result.code).toBe(0);
        pid = Number(readFileSync(join(f.clones[0]!, 'child.pid'), 'utf8').trim());
        const deadline = Date.now() + 2000;
        while (running(pid) && Date.now() < deadline) await Bun.sleep(20);
        expect(running(pid)).toBe(false);
        await Bun.sleep(1500);
        expect(existsSync(late)).toBe(false);
      } finally {
        if (pid && running(pid)) process.kill(pid, 'SIGKILL');
      }
    }, 20_000);
  });
}

describe('PrepSandbox backend contract', () => {
  test('shares initialization, denies incompatible global domains, and passes each policy and cwd', async () => {
    let count = 0;
    let config: SandboxRuntimeConfig | undefined;
    const calls: unknown[][] = [];
    let cleanups = 0;
    const manager = backend({
      initialize: async (value, ask, monitor) => {
        count++;
        config = value;
        expect(ask).toBeUndefined();
        expect(monitor).toBe(false);
      },
      wrapWithSandboxArgv: async (...args) => {
        calls.push(args);
        return { argv: ['/bin/sh', '-c', args[0]], env: process.env };
      },
      cleanupAfterCommand: () => {
        cleanups++;
      },
    });
    const a = new PrepSandbox({ ...options, manager });
    const b = new PrepSandbox({ allowedDomains: [...options.allowedDomains].reverse(), manager });
    expect(a.init()).toBe(a.init());
    await Promise.all([a.init(), b.init()]);
    expect(count).toBe(1);
    expect(config?.network).toMatchObject({ strictAllowlist: true, allowLocalBinding: false, deniedDomains: [] });
    expect(config?.filesystem).toEqual({ allowWrite: [], denyWrite: ['/'], denyRead: ['/'], allowRead: [] });
    await expect(new PrepSandbox({ allowedDomains: ['different.example'], manager }).init()).rejects.toThrow('domains');
    const f = fixture();
    const specs = [f.spec(['/usr/bin/true']), f.spec(['/usr/bin/true'], 1)];
    await Promise.all([a.run(specs[0]!), b.run(specs[1]!)]);
    expect(calls.map((call) => call[2])).toEqual(specs.map((spec) => spec.policy));
    expect(calls.map((call) => call[4])).toEqual(specs.map((spec) => spec.cwd));
    expect(cleanups).toBe(2);
    const wrong = f.spec(['/usr/bin/true']);
    wrong.policy.network.allowedDomains = [];
    await expect(a.run(wrong)).rejects.toThrow('domains');
  });

  test('failed initialization is retained without retrying a partly started global runtime', async () => {
    let calls = 0;
    const sandbox = new PrepSandbox({
      ...options,
      manager: backend({
        initialize: async () => {
          calls++;
          throw new Error('cannot start proxies');
        },
      }),
    });
    await expect(sandbox.init()).rejects.toThrow('cannot start proxies');
    await expect(sandbox.init()).rejects.toThrow('cannot start proxies');
    expect(calls).toBe(1);
  });

  test('quotes argv and TMPDIR, keeps only runtime env differences, and logs no environment', async () => {
    const f = fixture();
    const logger = memoryLogger();
    const manager = backend({
      wrapWithSandboxArgv: async (command) => ({
        argv: ['/bin/sh', '-c', `export TMPDIR=/wrong; ${command}`],
        env: { ...process.env, PREP_RUNTIME_TEST: 'runtime' },
      }),
    });
    const sandbox = new PrepSandbox({ ...options, manager, logger });
    const values = ['', "a'b", '$(touch injected)', 'a\nb', '; touch injected', '`touch injected`'];
    const spec = f.spec([
      '/bin/sh',
      '-c',
      'printf "%s\\n" "$@"; printf "%s\\n" "$TMPDIR" "$PREP_RUNTIME_TEST" "${USER-unset}"; touch "$TMPDIR/ok"',
      'sh',
      ...values,
    ]);
    spec.env.PRIVATE_VALUE = 'do-not-log-this';
    const before = { ...process.env };
    const result = await sandbox.run(spec);
    expect(result.code).toBe(0);
    expect(result.logTail).toBe(`${values.join('\n')}\n${spec.env.TMPDIR}\nruntime\nunset\n`);
    expect(existsSync(join(spec.env.TMPDIR!, 'ok'))).toBe(true);
    expect(existsSync(join(spec.cwd, 'injected'))).toBe(false);
    expect(process.env).toEqual(before);
    expect(logger.entries.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(logger.entries)).not.toContain('do-not-log-this');
  });

  test('abort kills a running command and a pre-aborted signal never wraps', async () => {
    const f = fixture();
    let wraps = 0;
    let cleanups = 0;
    const sandbox = new PrepSandbox({
      ...options,
      manager: backend({
        wrapWithSandboxArgv: async (command) => {
          wraps++;
          return { argv: ['/bin/sh', '-c', command], env: process.env };
        },
        cleanupAfterCommand: () => {
          cleanups++;
        },
      }),
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 100);
    try {
      const result = await sandbox.run({ ...f.spec(['/bin/sleep', '30']), signal: controller.signal });
      expect(result.signal).toBe('SIGKILL');
      expect(result.timedOut).toBe(false);
      await expect(sandbox.run({ ...f.spec(['/usr/bin/true']), signal: controller.signal })).rejects.toThrow();
      expect(wraps).toBe(1);
      expect(cleanups).toBe(1);
    } finally {
      clearTimeout(timer);
    }
  });

  test('cleans up a successful wrap even when spawning fails', async () => {
    const f = fixture();
    let cleanups = 0;
    const sandbox = new PrepSandbox({
      ...options,
      manager: backend({
        wrapWithSandboxArgv: async () => ({ argv: ['/no-such-agflow-command'], env: process.env }),
        cleanupAfterCommand: () => {
          cleanups++;
        },
      }),
    });
    await expect(sandbox.run(f.spec(['/usr/bin/true']))).rejects.toThrow();
    expect(cleanups).toBe(1);
  });

  test('bounds the pipe wait when an escaped grandchild keeps stdout open', async () => {
    const f = fixture();
    const sandbox = new PrepSandbox({ ...options, manager: backend() });
    const pidFile = join(f.clones[0]!, 'escaped.pid');
    let pid: number | undefined;
    try {
      // setsid takes the sleeper out of the group the normal-exit kill reaches; it inherits both pipes.
      const result = await sandbox.run(
        f.spec([
          '/usr/bin/perl',
          '-MPOSIX',
          '-e',
          'my $pid = fork() // die; if (!$pid) { POSIX::setsid(); exec "/bin/sleep", "30" } ' +
            'open my $f, ">", "escaped.pid" or die; print $f $pid; close $f; print "parent done\\n"; exit 0',
        ]),
      );
      pid = Number(readFileSync(pidFile, 'utf8'));
      expect(result.code).toBe(0);
      expect(result.logTail).toContain('parent done');
      // Only proves it did not wait for the 30 s sleeper.
      expect(result.durationMs).toBeLessThan(15_000);
      expect(running(pid)).toBe(true);
    } finally {
      if (pid === undefined && existsSync(pidFile)) pid = Number(readFileSync(pidFile, 'utf8'));
      if (pid && running(pid)) process.kill(pid, 'SIGKILL');
    }
  }, 20_000);
});

describe.skipIf(process.platform !== 'darwin')('real sandbox boundaries', () => {
  test('reads and writes the clone, cache and private TMPDIR, and captures output', async () => {
    const f = fixture();
    writeFileSync(join(f.clones[0]!, 'package.json'), 'clone-manifest-content\n');
    writeFileSync(join(f.layout.cache, 'entry'), 'cache-entry-content\n');
    const spec = f.spec([
      '/bin/sh',
      '-c',
      'cat package.json "$2" && echo clone > local && echo cache > "$1" && echo temp > "$TMPDIR/temp" && ' +
        'printf "%s\\n" "$TMPDIR" && echo output',
      'sh',
      join(f.layout.cache, 'cached'),
      join(f.layout.cache, 'entry'),
    ]);
    const result = await real.run(spec);
    expect(result.code).toBe(0);
    expect(result.logTail).toContain('clone-manifest-content\ncache-entry-content\n');
    expect(readFileSync(join(spec.cwd, 'local'), 'utf8')).toBe('clone\n');
    expect(readFileSync(join(f.layout.cache, 'cached'), 'utf8')).toBe('cache\n');
    expect(readFileSync(join(spec.env.TMPDIR!, 'temp'), 'utf8')).toBe('temp\n');
    expect(result.logTail).toContain(`${spec.env.TMPDIR}\noutput`);
  }, 20_000);

  test('denies outside, state and other-clone writes, and credential, state and other-clone reads', async () => {
    const f = fixture();
    // First prove the runtime can execute; sandbox startup failure is not evidence of isolation.
    expect((await real.run(f.spec(['/usr/bin/true']))).code).toBe(0);
    for (const dir of [f.outside, f.layout.state, f.clones[1]!]) {
      const target = join(dir, 'forbidden');
      const result = await real.run(f.spec(['/bin/sh', '-c', 'echo bad > "$1"', 'sh', target]));
      expect(result.code).not.toBe(0);
      expect(existsSync(target)).toBe(false);
    }
    const unreadable: [string, string][] = [
      [f.denied, f.secret],
      [join(f.clones[1]!, 'sibling'), 'sibling-clone-content'],
      [join(f.otherProject, 'other'), 'other-project-content'],
      [join(f.layout.state, 'one.json'), 'prep-state-content'],
    ];
    for (const [path, content] of unreadable) {
      if (path !== f.denied) writeFileSync(path, content);
      const result = await real.run(f.spec(['/bin/cat', path]));
      expect(result.code).not.toBe(0);
      expect(result.logTail).not.toContain(content);
    }
    // Only the names of projects and attempts can be listed; a sibling clone's contents cannot.
    expect((await real.run(f.spec(['/bin/ls', f.clones[1]!]))).code).not.toBe(0);
  }, 20_000);

  test('a scripts-off bun install skips lifecycle scripts, even with an agent-written HOME bunfig', async () => {
    const f = fixture();
    const clone = f.clones[0]!;
    const poison = join(f.layout.cache, 'bun', 'POISON');
    writeFileSync(
      join(clone, 'package.json'),
      `${JSON.stringify({
        name: 'prep-scripts',
        private: true,
        scripts: { preinstall: 'touch PRE', postinstall: `touch POST "${poison}"` },
      })}\n`,
    );
    const spec = f.spec([process.execPath, 'install'], 0, { run: ['bun', 'install'] });
    writeFileSync(join(spec.env.HOME!, '.bunfig.toml'), '[install]\nignoreScripts = false\n');
    const result = await real.run(spec);
    expect(result.code).toBe(0);
    for (const marker of [join(clone, 'PRE'), join(clone, 'POST'), poison]) expect(existsSync(marker)).toBe(false);
  }, 30_000);

  test('a scripts-on bun install runs its postinstall but cannot read another clone', async () => {
    const f = fixture();
    const clone = f.clones[0]!;
    writeFileSync(join(f.clones[1]!, 'secret'), 'sibling-secret-content');
    writeFileSync(
      join(clone, 'post.sh'),
      `touch POST; cat "${join(f.clones[1]!, 'secret')}" > leaked 2>/dev/null; exit 0\n`,
    );
    writeFileSync(
      join(clone, 'package.json'),
      `${JSON.stringify({ name: 'prep-scripts', private: true, scripts: { postinstall: 'sh post.sh' } })}\n`,
    );
    const result = await real.run(f.spec([process.execPath, 'install'], 0, { run: ['bun', 'install'], scripts: true }));
    expect(result.code).toBe(0);
    expect(existsSync(join(clone, 'POST'))).toBe(true);
    expect(readFileSync(join(clone, 'leaked'), 'utf8')).not.toContain('sibling-secret-content');
  }, 30_000);

  test('cannot reach a local HTTP server that answers outside the sandbox', async () => {
    const f = fixture();
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('outside-server') });
    try {
      const url = `http://127.0.0.1:${server.port}/`;
      expect(await (await fetch(url)).text()).toBe('outside-server');
      expect((await real.run(f.spec(['/usr/bin/true']))).code).toBe(0);
      for (const args of [[], ['--noproxy', '*']]) {
        const result = await real.run(f.spec(['/usr/bin/curl', '--fail', '--max-time', '2', ...args, url]));
        expect(result.code).not.toBe(0);
        expect(result.logTail).not.toContain('outside-server');
      }
    } finally {
      server.stop(true);
    }
  }, 20_000);

  test('concurrent per-call policies each allow only their own clone', async () => {
    const f = fixture();
    const results = await Promise.all(
      [0, 1].map((index) =>
        real.run(
          f.spec(
            [
              '/bin/sh',
              '-c',
              'sleep 0.1; echo own > own; if echo bad > "$1"; then exit 9; fi',
              'sh',
              join(f.clones[1 - index]!, 'foreign'),
            ],
            index,
          ),
        ),
      ),
    );
    expect(results.map((result) => result.code)).toEqual([0, 0]);
    for (const clone of f.clones) {
      expect(readFileSync(join(clone, 'own'), 'utf8')).toBe('own\n');
      expect(existsSync(join(clone, 'foreign'))).toBe(false);
    }
  }, 20_000);

  test('self-check reports works on macOS', async () => {
    expect(await checkPrepSandbox({ sandbox: real })).toEqual({ works: true, reason: null });
  }, 20_000);
});

describe('checkPrepSandbox', () => {
  const linuxErrors = process.platform === 'linux' ? SandboxManager.checkDependencies().errors : [];
  test.skipIf(linuxErrors.length === 0)('reports the actual missing Linux sandbox dependencies', async () => {
    const result = await checkPrepSandbox({ sandbox: real });
    expect(result.works).toBe(false);
    for (const error of linuxErrors) expect(result.reason).toContain(error);
  });

  test('reports unsupported platforms, missing Linux dependencies, and initialization errors', async () => {
    for (const [manager, reason] of [
      [backend({ isSupportedPlatform: () => false }), 'unsupported'],
      [
        backend({
          checkDependencies: () => ({
            errors: ['bubblewrap (bwrap) not installed', 'socat not installed'],
            warnings: [],
          }),
        }),
        'bubblewrap',
      ],
      [
        backend({
          initialize: async () => {
            throw new Error('cannot start runtime');
          },
        }),
        'cannot start runtime',
      ],
    ] as const) {
      const result = await checkPrepSandbox({ manager });
      expect(result.works).toBe(false);
      expect(result.reason).toContain(reason);
    }
  });

  test('verifies the probe file, reports command failure, and never throws', async () => {
    expect(await checkPrepSandbox({ manager: backend() })).toEqual({ works: true, reason: null });
    for (const command of ['exit 0', 'echo probe-failed >&2; exit 7']) {
      const result = await checkPrepSandbox({
        manager: backend({
          wrapWithSandboxArgv: async () => ({ argv: ['/bin/sh', '-c', command], env: process.env }),
        }),
      });
      expect(result.works).toBe(false);
      expect(result.reason).toBeTruthy();
    }
  });
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `bun test packages/runner/test/prep/sandbox.test.ts`
Expected: FAIL — `error: Cannot find module '../../src/prep/sandbox' from 'packages/runner/test/prep/sandbox.test.ts'` (0 pass, 1 fail, 1 error)

- [ ] **Step 3: Implement**

**File:** `packages/runner/src/prep/sandbox.ts` (new)

```ts
// One dependency-preparation command inside Anthropic's sandbox runtime (design 7.7), in the runner process:
// SandboxManager is initialised once with the profile's domains, and each command is wrapped with its attempt's
// prepPolicy. Commands are always spawned asynchronously, because the runtime's proxies run on this process's event
// loop and spawnSync would deadlock on them. checkPrepSandbox is the self-check behind profile.dependencyPrep.
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReadableStreamDefaultReader } from 'node:stream/web';
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { DEFAULT_TIMINGS } from '../config';
import { type Logger, noopLogger } from '../log';
import { boundedWait } from '../processes';
import { standardProfile } from '../profile';
import type { PrepPolicy } from './plan';

export type SandboxBackend = Pick<
  typeof SandboxManager,
  'initialize' | 'isSupportedPlatform' | 'checkDependencies' | 'wrapWithSandboxArgv' | 'cleanupAfterCommand'
>;

export interface PrepSandboxOptions {
  allowedDomains: readonly string[];
  timeoutMs?: number;
  logger?: Logger;
  /** Maximum UTF-8 bytes, including the truncation marker. Defaults to 16 KiB. */
  tailBytes?: number;
  manager?: SandboxBackend;
}

export interface PrepRunSpec {
  argv: string[];
  cwd: string;
  /** Task 10's prepEnv, never the runner's environment. */
  env: Record<string, string>;
  policy: PrepPolicy;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface PrepRunResult {
  code: number | null;
  signal: string | null;
  timedOut: boolean;
  logTail: string;
  durationMs: number;
}

const initializations = new WeakMap<SandboxBackend, { domains: string; promise: Promise<void> }>();
const TRUNCATED = '[agflow: output truncated]\n';
const PIPE_WAIT_MS = 1000;

function domainKey(domains: readonly string[]): string {
  return JSON.stringify([...new Set(domains)].sort());
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function shellWord(value: string): string {
  if (value.includes('\0')) throw new Error('preparation arguments must not contain NUL');
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Keeps reading after the bound; a full pipe must never stop a package manager. */
class LogTail {
  private bytes: Buffer = Buffer.alloc(0);
  private truncated = false;

  constructor(private readonly limit: number) {}

  append(text: string): void {
    const next = Buffer.from(text);
    this.truncated ||= this.bytes.length + next.length > this.limit;
    this.bytes =
      next.length >= this.limit
        ? Buffer.from(next.subarray(next.length - this.limit))
        : Buffer.concat([this.bytes.subarray(Math.max(0, this.bytes.length + next.length - this.limit)), next]);
  }

  text(): string {
    const marker = this.truncated ? TRUNCATED.slice(0, this.limit) : '';
    let start = Math.max(0, this.bytes.length - (this.limit - Buffer.byteLength(marker)));
    // The cap can land inside a codepoint; each pipe's streaming decoder preserves its other boundaries.
    while (start < this.bytes.length && (this.bytes[start]! & 0xc0) === 0x80) start++;
    return marker + this.bytes.subarray(start).toString('utf8');
  }
}

async function drain(reader: ReadableStreamDefaultReader<Uint8Array>, tail: LogTail): Promise<void> {
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      tail.append(decoder.decode(value, { stream: true }));
    }
    tail.append(decoder.decode());
  } catch {
    // A pipe closed mid-write by a kill is the end of its log.
  } finally {
    reader.releaseLock();
  }
}

export class PrepSandbox {
  readonly allowedDomains: readonly string[];
  private readonly manager: SandboxBackend;
  private readonly timeoutMs: number;
  private readonly tailBytes: number;
  private readonly logger: Logger;

  constructor(options: PrepSandboxOptions) {
    this.allowedDomains = Object.freeze([...new Set(options.allowedDomains)].sort());
    this.manager = options.manager ?? SandboxManager;
    this.timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMINGS.prep, 'timeoutMs');
    this.tailBytes = positiveInteger(options.tailBytes ?? 16 * 1024, 'tailBytes');
    this.logger = options.logger ?? noopLogger;
  }

  /** The manager is process-global. A failure is sticky; restart the runner before trying initialization again. */
  init(): Promise<void> {
    const domains = domainKey(this.allowedDomains);
    const existing = initializations.get(this.manager);
    if (existing) {
      return existing.domains === domains
        ? existing.promise
        : Promise.reject(new Error('preparation sandbox already initialized with different allowed domains'));
    }
    const promise = Promise.resolve().then(async () => {
      if (!this.manager.isSupportedPlatform()) throw new Error('preparation sandbox: unsupported platform');
      const { errors } = this.manager.checkDependencies();
      if (errors.length) throw new Error(`preparation sandbox: ${errors.join('; ')}`);
      await this.manager.initialize(
        {
          network: {
            allowedDomains: [...this.allowedDomains],
            deniedDomains: [],
            strictAllowlist: true,
            allowLocalBinding: false,
          },
          // No command may rely on the fallback. Task 10 supplies complete per-call filesystem lists.
          filesystem: { allowWrite: [], denyWrite: ['/'], denyRead: ['/'], allowRead: [] },
        },
        undefined,
        false,
      );
    });
    initializations.set(this.manager, { domains, promise });
    return promise;
  }

  /** Setup/wrap/spawn errors throw; command failures and termination are returned for attempt.prepared. */
  async run(spec: PrepRunSpec): Promise<PrepRunResult> {
    const started = performance.now();
    const timeoutMs = positiveInteger(spec.timeoutMs ?? this.timeoutMs, 'timeoutMs');
    if (!spec.argv.length) throw new Error('preparation argv must not be empty');
    if (!spec.env.TMPDIR) throw new Error('preparation needs a private TMPDIR');
    if (domainKey(spec.policy.network.allowedDomains) !== domainKey(this.allowedDomains)) {
      throw new Error('preparation policy domains must match the global sandbox domains');
    }
    spec.signal?.throwIfAborted();
    // The runtime's wrapper overrides TMPDIR. Restore it INSIDE that wrapper, without changing process.env.
    const command = `export TMPDIR=${shellWord(spec.env.TMPDIR)}; exec ${spec.argv.map(shellWord).join(' ')}`;
    await this.init();
    spec.signal?.throwIfAborted();
    this.logger.info('preparation started', { argv: spec.argv, cwd: spec.cwd });
    const wrapped = await this.manager.wrapWithSandboxArgv(command, '/bin/sh', spec.policy, spec.signal, spec.cwd);
    try {
      spec.signal?.throwIfAborted();
      const env = { ...spec.env };
      // 0.0.81 returns process.env on macOS/Linux; only runtime additions/changes may cross the allowlist.
      for (const [name, value] of Object.entries(wrapped.env)) {
        if (value !== undefined && value !== process.env[name]) env[name] = value;
      }
      const proc = Bun.spawn(wrapped.argv, {
        cwd: spec.cwd,
        env,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        detached: true,
      });
      let timedOut = false;
      const kill = () => {
        try {
          process.kill(-proc.pid, 'SIGKILL');
        } catch {
          proc.kill('SIGKILL');
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, timeoutMs);
      spec.signal?.addEventListener('abort', kill, { once: true });
      if (spec.signal?.aborted) kill();
      const tail = new LogTail(this.tailBytes);
      const readers = [proc.stdout.getReader(), proc.stderr.getReader()];
      const output = Promise.all(readers.map((reader) => drain(reader, tail)));
      try {
        const code = await proc.exited;
        clearTimeout(timer);
        spec.signal?.removeEventListener('abort', kill);
        // Leftovers in the group could still write the clone or the cache after the preparation is recorded.
        try {
          process.kill(-proc.pid, 'SIGKILL');
        } catch {
          // ESRCH: the group is already empty.
        }
        // A process that left the group (setsid) can still hold the pipes open.
        if (!(await boundedWait(output, PIPE_WAIT_MS)).done) {
          for (const reader of readers) void reader.cancel().catch(() => {});
        }
        const result: PrepRunResult = {
          code: proc.signalCode ? null : code,
          signal: proc.signalCode ?? null,
          timedOut,
          logTail: tail.text(),
          durationMs: performance.now() - started,
        };
        this.logger.info('preparation finished', {
          code: result.code,
          signal: result.signal,
          timedOut,
          durationMs: result.durationMs,
        });
        return result;
      } finally {
        clearTimeout(timer);
        spec.signal?.removeEventListener('abort', kill);
      }
    } finally {
      // Each successful wrap owns one runtime cleanup, including when spawn fails.
      this.manager.cleanupAfterCommand();
    }
  }
}

export interface CheckPrepSandboxOptions extends Partial<PrepSandboxOptions> {
  sandbox?: PrepSandbox;
}

/** A real filesystem operation, not just a dependency check; setup and ProfileSummary use the same answer. */
export async function checkPrepSandbox(
  options: CheckPrepSandboxOptions = {},
): Promise<{ works: boolean; reason: string | null }> {
  let directory: string | undefined;
  try {
    const sandbox =
      options.sandbox ??
      new PrepSandbox({
        ...options,
        allowedDomains: options.allowedDomains ?? standardProfile.network.allowedDomains,
      });
    await sandbox.init();
    directory = realpathSync(mkdtempSync(join(tmpdir(), 'agflow-prep-check-')));
    const result = await sandbox.run({
      argv: ['/bin/sh', '-c', 'printf agflow-prep-ok > probe'],
      cwd: directory,
      env: { PATH: '/usr/bin:/bin', HOME: directory, TMPDIR: directory },
      policy: {
        filesystem: {
          allowWrite: [directory],
          denyWrite: ['/tmp/claude', '/private/tmp/claude'],
          denyRead: [],
          allowRead: [directory],
        },
        network: { allowedDomains: [...sandbox.allowedDomains], deniedDomains: [] },
      },
      timeoutMs: options.timeoutMs ?? 10_000,
    });
    if (result.code !== 0 || result.signal || result.timedOut) {
      throw new Error(
        `preparation sandbox probe failed (exit ${result.code}, signal ${result.signal}, ` +
          `timedOut ${result.timedOut}): ${result.logTail.trim()}`,
      );
    }
    if (readFileSync(join(directory, 'probe'), 'utf8') !== 'agflow-prep-ok') {
      throw new Error('preparation sandbox probe did not write the expected file');
    }
    return { works: true, reason: null };
  } catch (error) {
    return { works: false, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    if (directory) {
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch {
        // A self-check never throws.
      }
    }
  }
}
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `bun test packages/runner/test/prep/sandbox.test.ts && bun test && bun run typecheck`
Expected: the task's tests pass; then the whole suite passes (`0 fail`) and `tsc` exits 0.

The real-sandbox tests run on macOS. On Linux the runtime needs bubblewrap and socat, so they skip there, and the backend is injectable, so the exit-code, tail and timeout tests still run with a pass-through backend. Nested `sandbox-exec` fails inside another sandbox (Codex's, for one): run these tests outside it. macOS has no `/bin/true`; the tests use `/usr/bin/true`. The wrapper re-exports the run's private `TMPDIR`, because the runtime sets its own from the runner's environment. After a normal exit the whole group is killed too, and the escaped-process test uses `perl` with `setsid`.

- [ ] **Step 5: Commit**

```bash
git add -A 'packages/runner/src/prep/sandbox.ts' 'packages/runner/test/prep/sandbox.test.ts'
git commit -m 'M2C Task 11: Dependency preparation: the sandboxed run' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

### Task 12: Dependency preparation: the DependencyPreparer

`createDependencyPreparer` implements M2b's `DependencyPreparer` seam (X-7, X-40). Its `available` comes from `checkPrepSandbox` at start. For worker attempts it restores the protected paths at the restore base (M2b's `restoreProtected`), reads the config there, runs each entry whose `when` files changed (an agent's request runs them all) and records the fingerprints after a success; M2b's controller reports `attempt.prepared` and, at a start, `attempt.failed_to_start` from its result. `scripts/verify-prep.ts` is design 15's check behind `verify:prep` (X-44): a real `bun install` and `pip install` from empty caches, after which no installed file shares an inode with the cache.

**Files:**
- Create: `packages/runner/scripts/verify-prep.ts`
- Create: `packages/runner/src/prep/preparer.ts`
- Test: `packages/runner/test/prep/preparer.test.ts`

- [ ] **Step 1: Write the failing test**

**File:** `packages/runner/test/prep/preparer.test.ts` (new)

```ts
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { verifyPrepMain } from '../../scripts/verify-prep';
import { prepareWorkspace } from '../../src/attempt/workspace';
import { memoryLogger } from '../../src/log';
import { createDependencyPreparer } from '../../src/prep/preparer';
import { prepLayout, prepToolConfig } from '../../src/prep/plan';
import { PrepSandbox, type PrepRunSpec, type SandboxBackend } from '../../src/prep/sandbox';
import { standardProfile } from '../../src/profile';
import type { PrepareInput } from '../../src/seams';
import { cleanupRunnerFixtures, createRunnerFixture, fixtureAgentToken, type RunnerFixture, waitFor } from '../fixture';

afterEach(cleanupRunnerFixtures);

const entry = (command = 'echo run >> runs; echo prepared', when = ['deps.lock'], scripts = false) => ({
  run: ['/bin/sh', '-c', command],
  when,
  scripts,
});
const files = (entries = [entry()]) => ({
  '.agflow/config.json': JSON.stringify({ dependencies: entries }),
  'deps.lock': 'original\n',
  '.npmrc': 'registry=https://registry.npmjs.org/\n',
});
const noRun = { ran: false, ok: true, error: null, logTail: null };

function manager(overrides: Partial<SandboxBackend> = {}): SandboxBackend {
  return {
    initialize: async () => {},
    isSupportedPlatform: () => true,
    checkDependencies: () => ({ errors: [], warnings: [] }),
    wrapWithSandboxArgv: async (command) => ({ argv: ['/bin/sh', '-c', command], env: {} }),
    cleanupAfterCommand: () => {},
    ...overrides,
  };
}

function runner() {
  const calls: PrepRunSpec[] = [];
  const sandbox = new PrepSandbox({ allowedDomains: standardProfile.network.allowedDomains, manager: manager() });
  return {
    calls,
    run: async (spec: PrepRunSpec) => {
      calls.push(spec);
      return sandbox.run(spec);
    },
  };
}

function options(f: RunnerFixture) {
  return { paths: f.paths, store: f.store, config: () => f.config, ownerHome: join(f.home, 'owner') };
}

async function direct(origin: Record<string, string> = files(), role: 'worker' | 'lead' = 'worker') {
  const f = await createRunnerFixture({ files: origin });
  const spec = f.spec({
    vendor: 'codex',
    role,
    ...(role === 'lead' ? { taskId: null, branch: null, wipRef: null } : {}),
  });
  const workspace = await prepareWorkspace(f.deps(), spec);
  f.store.create(spec, { clone: workspace.clone, tmpDir: null, cliVersion: null });
  const input: PrepareInput = {
    attemptId: spec.attemptId,
    vendor: spec.vendor,
    clone: workspace.clone,
    vault: f.vault,
    baseSha: workspace.base,
    env: { PATH: '/usr/bin:/bin' },
    requestId: null,
  };
  const command = runner();
  const preparer = await createDependencyPreparer({ ...options(f), run: command.run });
  return { f, input, command, preparer, clone: workspace.clone };
}

describe('DependencyPreparer seam', () => {
  test('runs once, persists the post-command fingerprint, and reruns a changed lockfile', async () => {
    const d = await direct(files([entry('echo rewritten > deps.lock; echo run >> runs; echo prepared')]));
    expect(await d.preparer.prepare(d.input)).toEqual({ ran: true, ok: true, error: null, logTail: 'prepared\n' });
    const restarted = await createDependencyPreparer({ ...options(d.f), run: d.command.run });
    expect(await restarted.prepare(d.input)).toEqual(noRun);
    writeFileSync(join(d.clone, 'deps.lock'), 'changed\n');
    expect((await restarted.prepare(d.input)).ran).toBe(true);
    expect(readFileSync(join(d.clone, 'runs'), 'utf8')).toBe('run\nrun\n');
    expect(d.command.calls.map((call) => call.cwd)).toEqual([d.clone, d.clone]);
    for (const call of d.command.calls) {
      expect(call.timeoutMs).toBe(d.f.config.timings.prep);
      expect(existsSync(call.env.TMPDIR!)).toBe(false);
    }
  }, 30_000);

  test('a command request runs every entry, restores .npmrc, and carries the last tail', async () => {
    const d = await direct(files([entry(), entry('cat .npmrc; echo second >> runs')]));
    await d.preparer.prepare(d.input);
    writeFileSync(join(d.clone, '.npmrc'), 'agent override\n');
    const result = await d.preparer.prepare({ ...d.input, requestId: 'cmd-123' });
    expect(result).toEqual({ ran: true, ok: true, error: null, logTail: files()['.npmrc'] });
    expect(d.command.calls).toHaveLength(4);
    expect(readFileSync(join(d.clone, 'runs'), 'utf8')).toBe('run\nsecond\nrun\nsecond\n');
  }, 30_000);

  test('protected paths are restored again before an entry that follows one that ran', async () => {
    const d = await direct(files([entry('echo agent override > .npmrc; echo first'), entry('cat .npmrc')]));
    expect(await d.preparer.prepare(d.input)).toEqual({
      ran: true,
      ok: true,
      error: null,
      logTail: files()['.npmrc'],
    });
  }, 30_000);

  test('removes user package config without following parent or final links, before each entry', async () => {
    const check =
      'test ! -e "$HOME/.bunfig.toml" && test ! -e "$HOME/.config/.bunfig.toml" && test ! -e "$CARGO_HOME/config.toml" || exit 9; echo clean';
    const d = await direct(
      files([
        entry(`${check}; echo bad > "$HOME/.bunfig.toml"`),
        entry('test ! -e "$HOME/.bunfig.toml" || exit 9; echo second'),
      ]),
    );
    const home = join(d.clone, '.agflow/run/home');
    const outside = join(d.f.home, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, '.bunfig.toml'), 'precious');
    writeFileSync(join(home, '.bunfig.toml'), '[install]\nbackend="hardlink"\n');
    symlinkSync(outside, join(home, '.config'));
    const cargo = join(d.clone, '.agflow/run/cache/cargo');
    mkdirSync(cargo);
    writeFileSync(join(outside, 'config.toml'), 'precious cargo');
    symlinkSync(join(outside, 'config.toml'), join(cargo, 'config.toml'));
    expect(await d.preparer.prepare(d.input)).toMatchObject({ ok: true, logTail: 'second\n' });
    expect(readFileSync(join(outside, '.bunfig.toml'), 'utf8')).toBe('precious');
    expect(readFileSync(join(outside, 'config.toml'), 'utf8')).toBe('precious cargo');
    expect(d.command.calls).toHaveLength(2);
  }, 30_000);

  test('replaces linked HOME and cache directories without touching their targets', async () => {
    const d = await direct(files([entry('test ! -e "$HOME/.bunfig.toml" || exit 8; echo safe')]));
    const outside = join(d.f.home, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, '.bunfig.toml'), 'precious');
    for (const name of ['home', 'cache']) {
      const path = join(d.clone, '.agflow/run', name);
      rmSync(path, { recursive: true });
      symlinkSync(outside, path);
    }
    expect((await d.preparer.prepare(d.input)).ok).toBe(true);
    expect(readdirSync(outside)).toEqual(['.bunfig.toml']);
  }, 30_000);

  test('links an earlier entry plants never redirect the next cleanup outside the clone', async () => {
    // The first entry runs agent-controlled code: it swaps HOME and the cargo root for links to the owner's files.
    const plant = [
      'rm -rf .agflow/run/home .agflow/run/cache/cargo',
      'ln -s "$OUTSIDE" .agflow/run/home',
      'ln -s "$OUTSIDE" .agflow/run/cache/cargo',
      'echo planted',
    ].join(' && ');
    const check = 'test -d "$HOME" && test ! -L "$HOME" && test ! -L "$CARGO_HOME" || exit 9; echo clean';
    const d = await direct(files([entry(plant), entry(check)]));
    const outside = join(d.f.home, 'outside');
    const owner: Record<string, string> = {
      Library: 'a file where the cleanup expects a directory',
      '.bunfig.toml': 'precious bunfig',
      '.npmrc': 'precious npmrc',
      'config.toml': 'precious cargo',
      '.config/pip/pip.conf': 'precious pip',
    };
    for (const [name, content] of Object.entries(owner)) {
      mkdirSync(dirname(join(outside, name)), { recursive: true });
      writeFileSync(join(outside, name), content);
    }
    expect(await d.preparer.prepare({ ...d.input, env: { ...d.input.env, OUTSIDE: outside } })).toMatchObject({
      ran: true,
      ok: true,
      logTail: 'clean\n',
    });
    for (const [name, content] of Object.entries(owner))
      expect(readFileSync(join(outside, name), 'utf8')).toBe(content);
  }, 30_000);

  test('serializes preparations of one attempt, including a forced request', async () => {
    const d = await direct();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let active = 0;
    let maximum = 0;
    const p = await createDependencyPreparer({
      ...options(d.f),
      run: async (spec) => {
        active++;
        maximum = Math.max(maximum, active);
        entered();
        await gate;
        try {
          return await d.command.run(spec);
        } finally {
          active--;
        }
      },
    });
    const first = p.prepare(d.input);
    await started;
    const second = p.prepare(d.input);
    const requested = p.prepare({ ...d.input, requestId: 'cmd-parallel' });
    release();
    expect((await Promise.all([first, second, requested])).map((outcome) => outcome.ran)).toEqual([true, false, true]);
    expect(maximum).toBe(1);
    expect(d.command.calls).toHaveLength(2);
  }, 30_000);

  test('a failed entry stops the sequence, retains its tail, and is retried', async () => {
    const d = await direct(files([entry('echo install-error; exit 3'), entry('touch must-not-run')]));
    for (let i = 0; i < 2; i++) {
      expect(await d.preparer.prepare(d.input)).toEqual({
        ran: true,
        ok: false,
        error: expect.stringContaining('exited with code 3'),
        logTail: 'install-error\n',
      });
    }
    expect(d.command.calls).toHaveLength(2);
    expect(existsSync(join(d.clone, 'must-not-run'))).toBe(false);
    expect(readdirSync(prepLayout(d.f.paths.prep(d.f.vault.project)).tmp)).toEqual([]);
  }, 30_000);

  test('timeouts, signals, spawn errors and missing records become failed outcomes', async () => {
    const d = await direct();
    for (const [result, error] of [
      [{ code: null, signal: 'SIGKILL', timedOut: true }, 'timed out after 15 min'],
      [{ code: null, signal: 'SIGTERM', timedOut: false }, 'SIGTERM'],
    ] as const) {
      const p = await createDependencyPreparer({
        ...options(d.f),
        run: async () => ({ ...result, logTail: 'tail', durationMs: 1 }),
      });
      expect(await p.prepare(d.input)).toMatchObject({
        ran: true,
        ok: false,
        error: expect.stringContaining(error),
        logTail: 'tail',
      });
    }
    const p = await createDependencyPreparer({
      ...options(d.f),
      run: async () => {
        throw new Error('spawn failed');
      },
    });
    expect(await p.prepare(d.input)).toMatchObject({ ran: true, ok: false, error: 'spawn failed' });
    expect(await p.prepare({ ...d.input, attemptId: 'missing' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('missing'),
    });
    expect(readdirSync(prepLayout(d.f.paths.prep(d.f.vault.project)).tmp)).toEqual([]);
  }, 30_000);

  test('no config, empty entries and leads do nothing; working-tree config has no authority', async () => {
    for (const [origin, role] of [
      [{ 'README.md': 'demo' }, 'worker'],
      [files([]), 'worker'],
      [files(), 'lead'],
    ] as const) {
      const d = await direct(origin, role);
      writeFileSync(join(d.clone, '.agflow/config.json'), JSON.stringify({ dependencies: [entry('touch rogue')] }));
      expect(await d.preparer.prepare(d.input)).toEqual(noRun);
      expect(d.command.calls).toHaveLength(0);
      expect(existsSync(join(d.clone, 'rogue'))).toBe(false);
    }
  }, 30_000);

  test('unavailable requests fail without invoking the runner', async () => {
    const d = await direct();
    const p = await createDependencyPreparer({ ...options(d.f), run: d.command.run, available: false });
    expect(p.available).toBe(false);
    expect(await p.prepare({ ...d.input, requestId: 'cmd-unavailable' })).toEqual({
      ran: false,
      ok: false,
      error: 'not available on this runner',
      logTail: null,
    });
    expect(d.command.calls).toHaveLength(0);
  }, 30_000);

  test('invalid base config and restore failures are reported', async () => {
    const d = await direct({ ...files(), '.agflow/config.json': '{bad json' });
    expect(await d.preparer.prepare(d.input)).toMatchObject({
      ran: true,
      ok: false,
      error: expect.stringContaining('.agflow/config.json'),
    });
    const valid = await direct();
    rmSync(valid.clone, { recursive: true });
    symlinkSync(valid.f.home, valid.clone);
    const before = readdirSync(valid.f.home).sort();
    expect(await valid.preparer.prepare(valid.input)).toMatchObject({
      ran: true,
      ok: false,
      error: `${valid.clone} is not a directory`,
    });
    // Refused before the restore, which would otherwise write the base's files through the link.
    expect(readdirSync(valid.f.home).sort()).toEqual(before);
    expect(valid.command.calls).toHaveLength(0);
  }, 30_000);

  test('only known installs with scripts off get the shared cache and the no-scripts bunfig', async () => {
    const pip = ['python3', '-m', 'pip', 'install', '-r', 'requirements.txt'];
    const d = await direct(
      files([
        { run: ['bun', 'install'], when: [], scripts: false },
        { run: ['bun', 'install'], when: [], scripts: true },
        { run: pip, when: [], scripts: false },
      ]),
    );
    const calls: PrepRunSpec[] = [];
    const p = await createDependencyPreparer({
      ...options(d.f),
      run: async (spec) => {
        calls.push(spec);
        return { code: 0, signal: null, timedOut: false, logTail: '', durationMs: 1 };
      },
    });
    expect((await p.prepare(d.input)).ok).toBe(true);
    const prep = d.f.paths.prep(d.f.vault.project);
    const shared = prepLayout(prep).cache;
    const perAttempt = join(d.clone, '.agflow/run/cache');
    const [normal, scripts, python] = calls;
    expect(normal?.env.BUN_INSTALL_CACHE_DIR).toBe(join(shared, 'bun'));
    expect(normal?.policy.filesystem.allowWrite).toContain(shared);
    expect(normal?.env.npm_config_ignore_scripts).toBe('true');
    expect(normal?.env.XDG_CONFIG_HOME).toBe(prepToolConfig(prep, false));
    expect(readFileSync(join(prepToolConfig(prep, false), '.bunfig.toml'), 'utf8')).toBe(
      '[install]\nignoreScripts = true\n',
    );
    for (const call of [scripts, python]) {
      expect(call?.env.BUN_INSTALL_CACHE_DIR).toBe(join(perAttempt, 'bun'));
      expect(call?.env.PIP_CACHE_DIR).toBe(join(perAttempt, 'pip'));
      expect(call?.policy.filesystem.allowWrite).not.toContain(shared);
      expect(call?.policy.filesystem.allowRead).not.toContain(shared);
    }
    expect(scripts?.env.npm_config_ignore_scripts).toBeUndefined();
    expect(scripts?.env.XDG_CONFIG_HOME).toBe(prepToolConfig(prep, true));
    expect(python?.env.npm_config_ignore_scripts).toBe('true');
  }, 30_000);

  test('availability comes from the sandbox self-check at start', async () => {
    const d = await direct();
    const logger = memoryLogger();
    const broken = new PrepSandbox({
      allowedDomains: standardProfile.network.allowedDomains,
      manager: manager({
        initialize: async () => {
          throw new Error('cannot start proxies');
        },
      }),
    });
    const unavailable = await createDependencyPreparer({ ...options(d.f), sandbox: broken, logger });
    expect(unavailable.available).toBe(false);
    expect(logger.entries).toContainEqual({
      level: 'warn',
      message: 'dependency preparation unavailable',
      fields: { reason: expect.stringContaining('cannot start proxies') },
    });
    expect(await unavailable.prepare({ ...d.input, requestId: 'cmd-x' })).toEqual({
      ran: false,
      ok: false,
      error: 'not available on this runner',
      logTail: null,
    });
    expect(existsSync(join(d.clone, 'runs'))).toBe(false);
    const wraps: string[] = [];
    const working = new PrepSandbox({
      allowedDomains: standardProfile.network.allowedDomains,
      manager: manager({
        wrapWithSandboxArgv: async (command) => {
          wraps.push(command);
          return { argv: ['/bin/sh', '-c', command], env: {} };
        },
      }),
    });
    const available = await createDependencyPreparer({ ...options(d.f), sandbox: working });
    expect(available.available).toBe(true);
    expect(await available.prepare(d.input)).toEqual({ ran: true, ok: true, error: null, logTail: 'prepared\n' });
    // The self-check's probe, then the entry.
    expect(wraps).toHaveLength(2);
    expect(wraps[1]).toContain('echo run >> runs');
    expect(readFileSync(join(d.clone, 'runs'), 'utf8')).toBe('run\n');
  }, 30_000);
});

describe('DependencyPreparer with the controller and fake adapter', () => {
  test('start prepares in the clone during preparing, then resumes only for changed when-files', async () => {
    const f = await createRunnerFixture({ files: files(), script: { turns: [[], [], []] } });
    const command = runner();
    const phases: unknown[] = [];
    const p = await createDependencyPreparer({
      ...options(f),
      run: async (spec) => {
        phases.push(controller.phase);
        return command.run(spec);
      },
    });
    const controller = f.controller('T-4-a1', { preparer: p });
    expect(await controller.start(f.spec())).toEqual({ started: true });
    await waitFor(() => f.events('attempt.activity').length > 0);
    expect(phases).toEqual(['preparing']);
    expect(f.events('attempt.prepared')[0]?.data).toEqual({
      requestId: null,
      ok: true,
      error: null,
      logTail: 'prepared\n',
    });
    expect(f.fakes.claude?.launches).toHaveLength(1);
    const clone = controller.workspace!.clone;
    expect(command.calls[0]?.cwd).toBe(clone);
    for (const counter of [2, 3]) {
      await controller.stop({
        fence: { epoch: 1, counter: counter - 1 },
        reason: 'paused',
        handoff: false,
        interruptFirst: false,
        keepClone: true,
      });
      if (counter === 3) writeFileSync(join(clone, 'deps.lock'), 'changed\n');
      expect(
        await controller.resume({
          fence: { epoch: 1, counter },
          agentToken: fixtureAgentToken(`resume-${counter}`),
          prompt: 'Continue',
          messages: [],
          taskPack: f.spec().taskPack,
          restore: f.spec().restore,
          acceptanceIds: ['A1'],
        }),
      ).toEqual({ resumed: true });
      await waitFor(() => f.events('attempt.activity').length >= counter);
      expect(f.events('attempt.prepared')).toHaveLength(counter === 2 ? 1 : 2);
    }
    expect(phases).toEqual(['preparing', 'preparing']);
    expect(readFileSync(join(clone, 'runs'), 'utf8')).toBe('run\nrun\n');
  }, 60_000);

  test('a failing preparation reports prepared then failed_to_start and never starts an agent', async () => {
    const f = await createRunnerFixture({ files: files([entry('echo failure-tail; exit 3')]) });
    const command = runner();
    const p = await createDependencyPreparer({ ...options(f), run: command.run });
    expect(await f.controller('T-4-a1', { preparer: p }).start(f.spec())).toMatchObject({
      started: false,
      refused: null,
    });
    expect(f.events().map((event) => event.type)).toEqual(['attempt.prepared', 'attempt.failed_to_start']);
    expect(f.events('attempt.prepared')[0]?.data).toMatchObject({
      requestId: null,
      ok: false,
      logTail: 'failure-tail\n',
      error: expect.stringContaining('exited with code 3'),
    });
    expect(f.events('attempt.failed_to_start')[0]?.data).toMatchObject({
      refused: null,
      error: expect.stringContaining('exited with code 3'),
    });
    expect(f.fakes.claude?.launches).toHaveLength(0);
  }, 30_000);

  test('prepare_dependencies runs every entry after restoring .npmrc and reports the command id', async () => {
    const f = await createRunnerFixture({ files: files([entry(), entry('cat .npmrc; echo second >> runs')]) });
    const command = runner();
    const p = await createDependencyPreparer({ ...options(f), run: command.run });
    const controller = f.controller('T-4-a1', { preparer: p });
    expect(await controller.start(f.spec())).toEqual({ started: true });
    await waitFor(() => f.events('attempt.activity').length > 0);
    const clone = controller.workspace!.clone;
    writeFileSync(join(clone, '.npmrc'), 'agent override\n');
    const requestId = '1-R-1-7';
    expect(await controller.prepareRequested({ fence: f.spec().fence, requestId })).toMatchObject({ ok: true });
    const prepared = { requestId, ok: true, error: null, logTail: files()['.npmrc'] };
    const reported = f.events('attempt.prepared').map((event) => event.data);
    expect(reported).toEqual([{ ...prepared, requestId: null }, prepared]);
    // The when-files did not change, and the request still ran both entries again.
    expect(command.calls).toHaveLength(4);
    expect(readFileSync(join(clone, 'runs'), 'utf8')).toBe('run\nsecond\nrun\nsecond\n');
    expect(readFileSync(join(clone, '.npmrc'), 'utf8')).toBe(files()['.npmrc']);
  }, 30_000);

  test('a start without config reports no preparation', async () => {
    const f = await createRunnerFixture();
    const command = runner();
    const p = await createDependencyPreparer({ ...options(f), run: command.run });
    expect(await f.controller('T-4-a1', { preparer: p }).start(f.spec())).toEqual({ started: true });
    expect(f.events('attempt.prepared')).toHaveLength(0);
    expect(command.calls).toHaveLength(0);
  }, 30_000);
});

test('verify-prep rejects extra arguments before doing work', async () => {
  const errors: string[] = [];
  expect(await verifyPrepMain(['extra'], {}, { error: (line) => errors.push(line) })).toBe(1);
  expect(errors).toEqual(['usage: bun run verify:prep']);
});

test.skipIf(process.platform !== 'darwin' || process.env.AGFLOW_SANDBOX_CHECKS !== '1')(
  'verify-prep installs bun and pip fixtures from empty caches without hard links',
  async () => {
    expect(await verifyPrepMain()).toBe(0);
  },
  300_000,
);
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `bun test packages/runner/test/prep/preparer.test.ts`
Expected: FAIL — `error: Cannot find module '../../scripts/verify-prep' from 'packages/runner/test/prep/preparer.test.ts'` (0 pass, 1 fail, 1 error)

- [ ] **Step 3: Implement**

**File:** `packages/runner/scripts/verify-prep.ts` (new)

```ts
// Design 15's real registry check: fresh caches, sandboxed installs, and no cache inode shared with a clone.
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_TIMINGS } from '../src/config';
import { runnerPaths } from '../src/paths';
import { prepEnv, prepLayout, prepPolicy, writePrepToolConfig } from '../src/prep/plan';
import { checkPrepSandbox, PrepSandbox } from '../src/prep/sandbox';
import { standardProfile } from '../src/profile';

type Env = Record<string, string | undefined>;

interface VerifyPrepOptions {
  log?: (line: string) => void;
  error?: (line: string) => void;
}

/** Do not follow package symlinks; compare every regular file with exact device and inode values. */
function regularFiles(root: string): { path: string; identity: string }[] {
  const files: { path: string; identity: string }[] = [];
  const visit = (path: string) => {
    const stat = lstatSync(path, { bigint: true });
    if (stat.isDirectory()) for (const name of readdirSync(path)) visit(join(path, name));
    else if (stat.isFile()) files.push({ path, identity: `${stat.dev}:${stat.ino}` });
  };
  visit(root);
  return files;
}

async function pythonExecutable(env: Env): Promise<string> {
  const python = Bun.which('python3', { PATH: env.PATH });
  if (!python) throw new Error('verify-prep needs python3 with pip on PATH');
  // Resolve a pyenv shim before replacing HOME; -I ignores Python's user site and environment configuration.
  const proc = Bun.spawn([python, '-I', '-c', 'import sys; print(sys.executable)'], {
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0 || !stdout.trim()) throw new Error(`cannot resolve python3: ${stderr.trim()}`);
  return realpathSync(stdout.trim());
}

export async function verifyPrepMain(
  argv: string[] = [],
  env: Env = process.env,
  options: VerifyPrepOptions = {},
): Promise<number> {
  const log = options.log ?? console.log;
  let root: string | undefined;
  try {
    if (argv.length) throw new Error('usage: bun run verify:prep');
    if (process.platform !== 'darwin') throw new Error('verify-prep requires macOS');
    root = realpathSync(mkdtempSync(join(tmpdir(), 'agflow-verify-prep-')));
    const paths = runnerPaths(root);
    const sandbox = new PrepSandbox({ allowedDomains: standardProfile.network.allowedDomains });
    const checked = await checkPrepSandbox({ sandbox });
    if (!checked.works) throw new Error(`preparation sandbox unavailable: ${checked.reason}`);
    const python = await pythonExecutable(env);
    const fixtures = [
      {
        name: 'bun',
        argv: [process.execPath, 'install', '--ignore-scripts'],
        installed: 'node_modules',
        expected: 'is-number/index.js',
      },
      {
        name: 'pip',
        argv: [
          python,
          '-I',
          '-m',
          'pip',
          '--disable-pip-version-check',
          // pip 24.2+ verifies TLS through macOS's trustd, which the sandbox denies; older pips reject this flag, so
          // it belongs in the entry of a project that runs a newer pip, never in prepEnv.
          '--use-deprecated=legacy-certs',
          'install',
          '--no-input',
          '--index-url',
          'https://pypi.org/simple',
          '--only-binary=:all:',
          '--no-deps',
          '--target',
          'installed',
          'six==1.17.0',
        ],
        installed: 'installed',
        expected: 'six.py',
      },
    ];
    for (const fixture of fixtures) {
      const clone = paths.clone(fixture.name, 'fixture');
      const prep = paths.prep(fixture.name);
      const layout = prepLayout(prep);
      for (const path of [clone, layout.cache, layout.tmp]) mkdirSync(path, { recursive: true, mode: 0o700 });
      writePrepToolConfig(prep);
      const entry = { run: fixture.argv };
      if (fixture.name === 'bun') {
        writeFileSync(
          join(clone, 'package.json'),
          `${JSON.stringify({ name: 'prep-fixture', private: true, dependencies: { 'is-number': '7.0.0' } })}\n`,
        );
      }
      const tmpDir = mkdtempSync(join(layout.tmp, 'install-'));
      // Only the executable search path and system CA setting cross from the calling environment.
      const runEnv = prepEnv({
        agentEnv: { PATH: env.PATH ?? '/usr/bin:/bin', NODE_USE_SYSTEM_CA: '1' },
        clone,
        prep,
        tmpDir,
        entry,
      });
      // bun install shares the project cache; pip may build agent-edited packages, so its cache is per attempt.
      const cache = fixture.name === 'bun' ? runEnv.BUN_INSTALL_CACHE_DIR! : runEnv.PIP_CACHE_DIR!;
      for (const path of [runEnv.HOME!, cache]) mkdirSync(path, { recursive: true, mode: 0o700 });
      if (readdirSync(cache).length) throw new Error(`${fixture.name}: cache was not empty`);
      const result = await sandbox.run({
        // pip runs with the preparation's environment, as a project's entry would: its cache and no config.
        argv: fixture.argv,
        cwd: clone,
        env: runEnv,
        policy: prepPolicy({
          home: homedir(),
          paths,
          clone,
          prep,
          tmpDir,
          entry,
          profile: standardProfile,
          vendorHomes: { claude: paths.homes.claude, codex: paths.homes.codex },
        }),
        timeoutMs: DEFAULT_TIMINGS.prep,
      });
      if (result.code !== 0 || result.signal || result.timedOut) {
        throw new Error(
          `${fixture.name} install failed (exit ${result.code}, signal ${result.signal}, timedOut ${result.timedOut}): ${result.logTail}`,
        );
      }
      const installedRoot = join(clone, fixture.installed);
      if (!lstatSync(join(installedRoot, fixture.expected)).isFile())
        throw new Error(`${fixture.name}: package was not installed`);
      const installed = regularFiles(installedRoot);
      const cached = regularFiles(cache);
      if (!installed.length || !cached.length) throw new Error(`${fixture.name}: installed files or cache is empty`);
      const identities = new Set(cached.map((file) => file.identity));
      for (const file of installed) {
        if (identities.has(file.identity))
          throw new Error(`${fixture.name}: installed file shares a cache inode: ${file.path}`);
      }
      log(
        `${fixture.name}: installed from an empty cache; ${installed.length} installed files, ${cached.length} cache files; no shared inodes`,
      );
    }
    return 0;
  } catch (error) {
    (options.error ?? console.error)(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    if (root) rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) process.exitCode = await verifyPrepMain(process.argv.slice(2), process.env);
```

**File:** `packages/runner/src/prep/preparer.ts` (new)

```ts
// DependencyPreparer (design 7.7, X-40): trusted config, restored protected paths, and serialized per-attempt runs.
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import type { AttemptStore } from '../attempt-store';
import { type RunnerConfig, vendorHomes } from '../config';
import { removeInClone, restoreProtected } from '../git/protect';
import { type Logger, noopLogger } from '../log';
import type { RunnerPaths } from '../paths';
import { profileOf } from '../profile';
import { runDirOf } from '../run-dir';
import type { DependencyPreparer, PrepareInput, PrepareOutcome } from '../seams';
import { readPrepConfig } from './config';
import { prepEntryKey, prepEnv, prepLayout, prepPolicy, PrepState, whenFingerprint, writePrepToolConfig } from './plan';
import { checkPrepSandbox, PrepSandbox, type PrepRunResult, type PrepRunSpec } from './sandbox';

export interface DependencyPreparerOptions {
  paths: RunnerPaths;
  store: AttemptStore;
  config: () => RunnerConfig;
  logger?: Logger;
  ownerHome?: string;
  run?: (spec: PrepRunSpec) => Promise<PrepRunResult>;
  /** Only overrides availability with an injected runner. */
  available?: boolean;
  /** Checked at start and runs the commands when no runner is injected; defaults to one with the profile's domains. */
  sandbox?: PrepSandbox;
}

// Agents can write HOME and CARGO_HOME; their user configs must never steer a later preparation.
const USER_CONFIGS = {
  home: [
    '.bunfig.toml',
    '.config/.bunfig.toml',
    '.npmrc',
    '.yarnrc',
    '.yarnrc.yml',
    '.pip',
    '.config/pip',
    '.pydistutils.cfg',
    '.config/uv',
    'Library/Application Support/go/env',
    '.config/go/env',
  ],
  cargo: ['config', 'config.toml'],
} as const;

function statOrNull(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function realDirectory(path: string): void {
  if (!lstatSync(path).isDirectory()) throw new Error(`${path} is not a directory`);
}

function inside(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

/**
 * Makes path a real directory below root while the agent may still be running. A link or file in the way is removed
 * with removeInClone, which never deletes through a parent swapped for a link; a swap that redirects a mkdir is
 * caught by the final check, which fails the preparation before anything runs there.
 */
async function directory(root: string, path: string): Promise<void> {
  realDirectory(root);
  const real = realpathSync(root);
  const parts = relative(root, path).split('/').filter(Boolean);
  if (parts.some((part) => part === '..')) throw new Error(`${path} is outside ${root}`);
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]!);
    const stat = statOrNull(current);
    if (stat?.isDirectory()) continue;
    if (stat) await removeInClone(real, root, parts.slice(0, i + 1).join('/'));
    try {
      mkdirSync(current, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  if (!inside(realpathSync(path), real)) throw new Error(`${path} is not inside ${root}`);
}

async function cleanUserConfig(clone: string): Promise<void> {
  const real = realpathSync(clone);
  const run = runDirOf(clone, '');
  for (const [root, configs] of [
    [run.home, USER_CONFIGS.home],
    [join(run.cache, 'cargo'), USER_CONFIGS.cargo],
  ] as const) {
    for (const name of configs) {
      const path = join(root, name);
      // A linked or non-directory ancestor is itself unsafe config; it is replaced, never traversed.
      await directory(clone, dirname(path));
      await removeInClone(real, clone, relative(clone, path));
    }
  }
}

async function makeRunDirectories(clone: string, prep: string, env: Record<string, string>): Promise<void> {
  const cache = prepLayout(prep).cache;
  mkdirSync(cache, { recursive: true, mode: 0o700 });
  for (const name of [
    'HOME',
    'BUN_INSTALL_CACHE_DIR',
    'npm_config_cache',
    'npm_config_store_dir',
    'PIP_CACHE_DIR',
    'UV_CACHE_DIR',
    'GOMODCACHE',
    'CARGO_HOME',
  ]) {
    const path = env[name]!;
    await directory(path.startsWith(`${cache}/`) ? cache : clone, path);
  }
}

function runError(argv: string[], result: PrepRunResult, timeoutMs: number): string | null {
  const command = argv.join(' ');
  if (result.timedOut) {
    const duration = timeoutMs % 60_000 === 0 ? `${timeoutMs / 60_000} min` : `${timeoutMs} ms`;
    return `${command} timed out after ${duration}`;
  }
  if (result.signal) return `${command} terminated by ${result.signal}`;
  if (result.code !== 0) return `${command} exited with code ${result.code ?? 'unknown'}`;
  return null;
}

export async function createDependencyPreparer(options: DependencyPreparerOptions): Promise<DependencyPreparer> {
  const logger = options.logger ?? noopLogger;
  const ownerHome = options.ownerHome ?? homedir();
  let run = options.run;
  let available: boolean;
  if (run) {
    available = options.available ?? true;
  } else {
    const sandbox =
      options.sandbox ??
      new PrepSandbox({ allowedDomains: profileOf(options.config()).network.allowedDomains, logger });
    const checked = await checkPrepSandbox({ sandbox });
    available = checked.works;
    if (!available) logger.warn('dependency preparation unavailable', { reason: checked.reason });
    run = (spec) => sandbox.run(spec);
  }
  const commandRun = run;
  const pending = new Map<string, Promise<void>>();

  async function prepare(input: PrepareInput): Promise<PrepareOutcome> {
    if (!available) return { ran: false, ok: false, error: 'not available on this runner', logTail: null };
    let logTail: string | null = null;
    let ran = false;
    try {
      const record = options.store.get(input.attemptId);
      if (!record) throw new Error(`no attempt record for ${input.attemptId}`);
      if (record.spec.role !== 'worker') return { ran, ok: true, error: null, logTail };
      const config = await readPrepConfig(input.vault, input.baseSha);
      if (!config?.dependencies.length) return { ran, ok: true, error: null, logTail };
      // restoreProtected resolves a linked clone and would write through it.
      realDirectory(input.clone);
      const restore = () =>
        restoreProtected(
          { vault: input.vault, local: input.vault.local },
          { clone: input.clone, base: input.baseSha, paths: record.spec.restore.paths },
        );
      const prep = options.paths.prep(input.vault.project);
      const layout = prepLayout(prep);
      const state = new PrepState(prep);
      writePrepToolConfig(prep);
      let restored = false;
      for (const entry of config.dependencies) {
        // An entry that ran may have run agent-controlled code that rewrote .npmrc or bunfig.toml for the next one.
        if (!restored) {
          await restore();
          restored = true;
        }
        const key = prepEntryKey(entry);
        if (input.requestId === null && !state.needs(input.attemptId, key, whenFingerprint(input.clone, entry.when)))
          continue;
        ran = true;
        restored = false;
        const settings = options.config();
        mkdirSync(layout.tmp, { recursive: true, mode: 0o700 });
        const tmpDir = mkdtempSync(join(layout.tmp, 'run-'));
        try {
          await cleanUserConfig(input.clone);
          const env = prepEnv({ agentEnv: input.env, clone: input.clone, prep, tmpDir, entry });
          await makeRunDirectories(input.clone, prep, env);
          const result = await commandRun({
            argv: entry.run,
            cwd: input.clone,
            env,
            policy: prepPolicy({
              clone: input.clone,
              prep,
              tmpDir,
              entry,
              home: ownerHome,
              paths: options.paths,
              profile: profileOf(settings),
              vendorHomes: vendorHomes(settings, options.paths),
            }),
            timeoutMs: settings.timings.prep,
          });
          logTail = result.logTail;
          const error = runError(entry.run, result, settings.timings.prep);
          if (error) return { ran, ok: false, error, logTail };
          state.record(input.attemptId, key, whenFingerprint(input.clone, entry.when));
        } finally {
          rmSync(tmpDir, { recursive: true, force: true });
        }
      }
      return { ran, ok: true, error: null, logTail };
    } catch (error) {
      return { ran: true, ok: false, error: error instanceof Error ? error.message : String(error), logTail };
    }
  }

  return Object.freeze({
    available,
    prepare(input: PrepareInput): Promise<PrepareOutcome> {
      const result = (pending.get(input.attemptId) ?? Promise.resolve()).then(() => prepare(input));
      const settled = result.then(
        () => {},
        () => {},
      );
      pending.set(input.attemptId, settled);
      void settled.then(() => {
        if (pending.get(input.attemptId) === settled) pending.delete(input.attemptId);
      });
      return result;
    },
  });
}
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `bun test packages/runner/test/prep/preparer.test.ts && bun test && bun run typecheck`
Expected: the task's tests pass; then the whole suite passes (`0 fail`) and `tsc` exits 0.

The preparer reads the role and the restore set from the attempt record, because `PrepareInput` carries neither, so the host must pass the `AttemptStore` the controller uses. The clone must be a real directory before anything is restored, and the restore runs again before every entry that follows one that ran. Package managers' user config files are removed from the agent-writable `HOME` and the per-attempt `CARGO_HOME` before each entry. Run `bun run verify:prep` once after this task, on macOS with the network. It uses the real sandbox runtime, the npm registry (`is-number` 7.0.0, through `bun install`) and PyPI (`six` 1.17.0, through `pip install --target`), in a scratch `AGFLOW_HOME` under the temporary directory, and needs a `python3` on PATH whose pip is 24.2 or newer, such as Homebrew's or pyenv's. The Command Line Tools' /usr/bin/python3 ships pip 21.2.4, which rejects the fixture's `--use-deprecated=legacy-certs`. `AGFLOW_SANDBOX_CHECKS=1 bun test packages/runner/test/prep/preparer.test.ts` runs the same check as a test. pip 24.2 and newer verify TLS through macOS's trustd, which the sandbox denies, so a project entry for such a pip passes `--use-deprecated=legacy-certs` itself, as verify-prep's pip fixture does.

- [ ] **Step 5: Commit**

```bash
git add -A 'packages/runner/scripts/verify-prep.ts' 'packages/runner/src/prep/preparer.ts' 'packages/runner/test/prep/preparer.test.ts'
git commit -m 'M2C Task 12: Dependency preparation: the DependencyPreparer' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

### Task 13: Retention on the laptop

sweepRetention prunes acknowledged events after eventRetention and other outbox events and journal rows after 14 days through M2b's prune methods. Both outbox prunes preserve runner.settings edits still in flight for the snapshot last written to runner.json. Ended attempt records and transcripts become eligible after 14 days only when their clone is gone and lateWorkSha is null. Pending late work keeps the record, its transcript and referenced vendor version even when the clone is missing. Clones are never deleted here.

**Files:**
- Create: `packages/runner/src/ops/retention.ts`
- Test: `packages/runner/test/ops/retention.test.ts`

- [ ] **Step 1: Write the failing test**

**File:** `packages/runner/test/ops/retention.test.ts` (new)

```ts
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import {
  existsSync,
  lstatSync,
  lutimesSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AttemptSpecSchema, type Vendor } from '@agflow/core';
import { FakeAdapter } from '@agflow/testkit';
import type { VendorAdapter } from '../../src/adapters/types';
import { AttemptStore, type AttemptPatch } from '../../src/attempt-store';
import { RunnerConfigSchema } from '../../src/config';
import { openRunnerDb } from '../../src/db';
import { Journal } from '../../src/journal';
import { memoryLogger } from '../../src/log';
import { RETENTION, sweepRetention } from '../../src/ops/retention';
import { Outbox } from '../../src/outbox';
import { runnerPaths } from '../../src/paths';
import { PrepState } from '../../src/prep/plan';
import { launchdLogPaths } from '../../src/service/log';
import { VENDOR_PINS } from '../../src/vendor/pins';

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-11-09T12:00:00Z');
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function file(path: string, at = NOW, content = 'kept') {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  utimesSync(path, new Date(at), new Date(at));
}

function directory(path: string, at = NOW) {
  mkdirSync(path, { recursive: true });
  utimesSync(path, new Date(at), new Date(at));
}

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'agf-ret-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const paths = runnerPaths(home);
  mkdirSync(paths.runner, { recursive: true });
  const db = openRunnerDb(paths.db);
  cleanups.push(() => db.close());
  const clock = { at: NOW, now: () => clock.at };
  const store = new AttemptStore(db, { now: clock.now });
  const outbox = new Outbox(db, { now: clock.now });
  const journal = new Journal(db, { now: clock.now });
  const logger = memoryLogger();
  const deleted: { sessionRef: string; clone: string }[] = [];
  const transcriptDir = join(home, 'transcripts');
  const fake = new FakeAdapter({ script: { turns: [] }, transcriptDir });
  const adapters = new Map<Vendor, Pick<VendorAdapter, 'deleteTranscript'>>([
    [
      'claude',
      {
        deleteTranscript: async (input) => {
          deleted.push(input);
          await fake.deleteTranscript(input);
        },
      },
    ],
  ]);
  const consolidated: string[] = [];
  const vaults = ['one', 'two'].map((project) => ({
    project,
    consolidate: async () => {
      consolidated.push(project);
      return { pruned: false };
    },
  }));
  const input = {
    paths,
    store,
    outbox,
    journal,
    logger,
    adapters,
    vaults,
    now: clock.now,
    eventRetentionMs: RunnerConfigSchema.parse({ runnerKey: 'key', machineId: 'machine', name: 'test' }).timings
      .eventRetention,
    // The real pin lookup on any CI: darwin-arm64 is the platform M2 pins.
    platform: 'darwin-arm64',
  };
  function attempt(id: string, patch: AttemptPatch = {}, vendor: Vendor = 'claude') {
    const spec = AttemptSpecSchema.parse({
      attemptId: id,
      taskId: 'T-4',
      role: 'worker',
      vendor,
      model: null,
      fence: { epoch: 1, counter: 1 },
      agentToken: `agt_${'Q'.repeat(43)}`,
      hubUrl: 'http://127.0.0.1:7000',
      repo: { url: '/tmp/origin.git', mainBranch: 'main' },
      start: { ref: 'refs/heads/main', sha: null },
      branch: 'agflow/T-4-tidy',
      wipRef: 'refs/agflow/T-4/a1',
      restore: { paths: [], base: 'refs/heads/main' },
      acceptanceIds: [],
      toolCaps: { defaultMs: 600_000, longMs: 1_800_000, checks: [] },
      taskPack: '# T-4',
      brief: 'brief',
      firstPrompt: 'start',
      successor: false,
    });
    store.create(spec, { clone: paths.clone('one', id), tmpDir: null, cliVersion: '1.0.0' });
    return store.update(id, { state: 'ended', endedAt: NOW - 15 * DAY, sessionRef: id, ...patch });
  }
  return { ...input, input, home, clock, db, attempt, deleted, transcriptDir, consolidated };
}

describe('sweepRetention', () => {
  test('uses 48 hours for acknowledged events and 14 days for all events and journal rows', async () => {
    const f = fixture();
    const event = () => f.outbox.append({ type: 'runner.state', data: { state: 'ok', detail: null } });
    f.clock.at = NOW - 3 * DAY;
    event();
    f.outbox.ack(f.outbox.epoch, 1);
    // A clock correction lets the oldest unacknowledged row follow the acknowledged one.
    f.clock.at = NOW - 15 * DAY;
    event();
    f.journal.begin('old', 1, { kind: 'preflight', vendor: 'claude' });
    f.clock.at = NOW - 14 * DAY;
    event();
    f.journal.begin('boundary', 2, { kind: 'preflight', vendor: 'claude' });
    f.clock.at = NOW - 3 * DAY;
    event();
    f.clock.at = NOW;
    const result = await sweepRetention(f.input);
    expect(result).toMatchObject({ ran: true, ackedEvents: 1, outboxEvents: 1, journalRows: 1 });
    expect(f.outbox.firstSeq()).toBe(3);
    expect(f.outbox.eventsAfter(0).map((event) => event.seq)).toEqual([3, 4]);
    expect(f.journal.get('old')).toBeNull();
    expect(f.journal.get('boundary')).not.toBeNull();

    const recent = fixture();
    for (const age of [48 * HOUR + 1, 48 * HOUR, 24 * HOUR]) {
      recent.clock.at = NOW - age;
      recent.outbox.append({ type: 'runner.state', data: { state: 'ok', detail: null } });
    }
    recent.outbox.ack(recent.outbox.epoch, 3);
    recent.clock.at = NOW;
    expect((await sweepRetention(recent.input)).ackedEvents).toBe(1);
    expect(recent.outbox.firstSeq()).toBe(2);
  });

  test('removes only regular attempt log files older than 14 days', async () => {
    const f = fixture();
    const old = f.paths.attemptLog('old');
    const boundary = f.paths.attemptLog('boundary');
    const fresh = f.paths.attemptLog('fresh');
    file(old, NOW - 15 * DAY);
    file(boundary, NOW - 14 * DAY);
    file(fresh, NOW - 13 * DAY);
    directory(f.paths.attemptLog('directory'), NOW - 15 * DAY);
    const target = join(f.home, 'target');
    file(target, NOW - 15 * DAY);
    symlinkSync(target, f.paths.attemptLog('link'));
    expect((await sweepRetention(f.input)).attemptLogs).toBe(1);
    expect(existsSync(old)).toBe(false);
    for (const path of [boundary, fresh, target, f.paths.attemptLog('link'), f.paths.attemptLog('directory')]) {
      expect(existsSync(path)).toBe(true);
    }
  });

  test('deletes a missing clone transcript once, then frees its record, version and preparation state', async () => {
    const f = fixture();
    const record = f.attempt('T-4-a1');
    file(join(f.transcriptDir, 'T-4-a1.jsonl'));
    const version = join(f.paths.vendor, 'claude', '1.0.0');
    directory(version);
    const prep = new PrepState(f.paths.prep('one'));
    prep.record(record.attemptId, 'entry', 'fingerprint');
    const result = await sweepRetention(f.input);
    expect(result).toMatchObject({ attempts: 1, transcripts: 1, vendorVersions: 1, prepStates: 1 });
    expect(f.deleted).toEqual([{ sessionRef: record.sessionRef!, clone: record.clone! }]);
    expect(existsSync(join(f.transcriptDir, 'T-4-a1.jsonl'))).toBe(false);
    expect(f.store.get(record.attemptId)).toBeNull();
    expect(existsSync(version)).toBe(false);
    expect(prep.attempts()).toEqual([]);
    f.clock.at += DAY;
    await sweepRetention(f.input);
    expect(f.deleted).toHaveLength(1);
  });

  test('preserves holding, taken-over and push-failing clones, recent and unended attempts', async () => {
    const f = fixture();
    for (const [index, patch] of [
      { state: 'idle' },
      { state: 'stopped' },
      { pushError: 'remote unavailable' },
    ].entries()) {
      const record = f.attempt(`T-4-a${index + 1}`, patch as AttemptPatch);
      file(join(record.clone!, 'work.txt'), NOW - 20 * DAY);
    }
    f.attempt('T-4-a4', { endedAt: NOW - 13 * DAY });
    f.attempt('T-4-a5', { endedAt: null });
    f.attempt('T-4-a6', { endedAt: NOW - 14 * DAY });
    f.attempt('T-4-a7', { clone: null });
    expect((await sweepRetention(f.input)).attempts).toBe(1);
    expect(f.deleted).toEqual([]);
    expect(f.store.list()).toHaveLength(6);
    for (let i = 1; i <= 3; i++) {
      expect(readFileSync(join(f.paths.clone('one', `T-4-a${i}`), 'work.txt'), 'utf8')).toBe('kept');
    }
  });

  test('a failed transcript deletion keeps the record and version and does not stop other attempts', async () => {
    const f = fixture();
    f.attempt('T-4-a1');
    f.attempt('T-4-a2', { clone: null });
    const version = join(f.paths.vendor, 'claude', '1.0.0');
    directory(version);
    f.adapters.set('claude', {
      deleteTranscript: async () => {
        throw new Error('thread busy');
      },
    });
    const result = await sweepRetention(f.input);
    expect(result.attempts).toBe(1);
    expect(f.store.get('T-4-a1')).not.toBeNull();
    expect(f.store.get('T-4-a2')).toBeNull();
    expect(existsSync(version)).toBe(true);
    expect(f.consolidated).toEqual(['one', 'two']);
    expect(f.logger.entries).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        fields: expect.objectContaining({ step: 'endedAttempts', error: expect.anything() }),
      }),
    );
    f.adapters.set('claude', { deleteTranscript: async () => {} });
    f.clock.at += DAY;
    await sweepRetention(f.input);
    expect(f.store.get('T-4-a1')).toBeNull();
    expect(existsSync(version)).toBe(false);
  });

  test('keeps pins, newer versions and every referenced version, leaving staging and linked targets alone', async () => {
    const f = fixture();
    const pins = VENDOR_PINS['darwin-arm64']!;
    expect([pins.claude.version, pins.codex.version]).toEqual(['2.1.285', '0.159.2']);
    f.attempt('T-4-a1', { endedAt: null });
    f.attempt('T-4-a2', { endedAt: null, cliVersion: '0.100.0' }, 'codex');
    const version = (vendor: Vendor, name: string) => join(f.paths.vendor, vendor, name);
    // 2.1.300 and 0.160.0 stand for pins an upgrade installed before this runner restarted.
    for (const [vendor, names] of [
      ['claude', [pins.claude.version, '1.0.0', '2.1.284', '2.1.300', '10.0.0', '.staging-123-abcd', 'unknown']],
      ['codex', [pins.codex.version, '0.100.0', '1.0.0', '0.150.0', '0.160.0']],
    ] as const)
      for (const name of names) directory(version(vendor, name));
    file(version('claude', '0.9.0'));
    const target = join(f.home, 'linked-version');
    file(join(target, 'binary'));
    symlinkSync(target, version('claude', '2.0.0'));
    // codex 1.0.0 is newer than its pin and claude 1.0.0 is a record's; claude 2.1.284, the link and codex 0.150.0 go.
    expect((await sweepRetention(f.input)).vendorVersions).toBe(3);
    expect(readdirSync(join(f.paths.vendor, 'claude')).sort()).toEqual([
      '.staging-123-abcd',
      '0.9.0',
      '1.0.0',
      '10.0.0',
      '2.1.285',
      '2.1.300',
      'unknown',
    ]);
    expect(readdirSync(join(f.paths.vendor, 'codex')).sort()).toEqual(['0.100.0', '0.159.2', '0.160.0', '1.0.0']);
    expect(readFileSync(join(target, 'binary'), 'utf8')).toBe('kept');
  });

  test('a platform without pins keeps only referenced vendor versions', async () => {
    const f = fixture();
    expect(VENDOR_PINS['linux-x64']).toBeUndefined();
    f.attempt('T-4-a1', { endedAt: null });
    for (const name of ['1.0.0', '2.1.285', '9.0.0']) directory(join(f.paths.vendor, 'claude', name));
    expect((await sweepRetention({ ...f.input, platform: 'linux-x64' })).vendorVersions).toBe(2);
    expect(readdirSync(join(f.paths.vendor, 'claude'))).toEqual(['1.0.0']);
  });

  test('removes hour-old quarantines and orphan preparation state across projects', async () => {
    const f = fixture();
    f.attempt('T-4-a1', { endedAt: null });
    const old = f.paths.quarantine('one', 'old');
    const boundary = f.paths.quarantine('one', 'boundary');
    const fresh = f.paths.quarantine('two', 'fresh');
    directory(old, NOW - HOUR - 1);
    directory(boundary, NOW - HOUR);
    directory(fresh, NOW - 30 * 60_000);
    const target = join(f.home, 'quarantine-target');
    file(join(target, 'work'));
    const link = f.paths.quarantine('one', 'link');
    symlinkSync(target, link);
    lutimesSync(link, new Date(NOW - 2 * HOUR), new Date(NOW - 2 * HOUR));
    for (const project of ['one', 'two']) {
      const prep = new PrepState(f.paths.prep(project));
      prep.record('T-4-a1', 'entry', 'keep');
      prep.record('T-4-a2', 'entry', 'remove');
      file(join(f.paths.prep(project), 'cache', 'keep'));
    }
    expect(await sweepRetention(f.input)).toMatchObject({ quarantines: 2, prepStates: 2 });
    expect(existsSync(old)).toBe(false);
    expect(existsSync(link)).toBe(false);
    for (const path of [boundary, fresh, join(target, 'work')]) expect(existsSync(path)).toBe(true);
    for (const project of ['one', 'two']) {
      expect(new PrepState(f.paths.prep(project)).attempts()).toEqual(['T-4-a1']);
      expect(existsSync(join(f.paths.prep(project), 'cache', 'keep'))).toBe(true);
    }
  });

  test('persists daily scheduling privately and honors each vault timestamp', async () => {
    const f = fixture();
    expect(Object.isFrozen(RETENTION)).toBe(true);
    const state = join(f.paths.logs, 'retention.json');
    file(state, NOW, JSON.stringify({ sweptAt: NOW - DAY, consolidatedAt: { one: NOW - HOUR } }));
    expect((await sweepRetention(f.input)).consolidatedVaults).toEqual(['two']);
    expect(JSON.parse(readFileSync(state, 'utf8'))).toEqual({
      sweptAt: NOW,
      consolidatedAt: { one: NOW - HOUR, two: NOW },
    });
    expect(statSync(state).mode & 0o777).toBe(0o600);
    expect(readdirSync(f.paths.logs)).toEqual(['retention.json']);
    f.clock.at += DAY - 1;
    expect((await sweepRetention({ ...f.input, paths: runnerPaths(f.home) })).ran).toBe(false);
    f.clock.at++;
    expect((await sweepRetention(f.input)).ran).toBe(true);
    expect(f.consolidated).toEqual(['two', 'one', 'two']);
  });

  test('stamps the sweep with its start, so a long consolidation does not delay the next day', async () => {
    const f = fixture();
    for (const vault of f.vaults) {
      vault.consolidate = async () => {
        f.clock.at += HOUR;
        return { pruned: false };
      };
    }
    expect((await sweepRetention(f.input)).consolidatedVaults).toEqual(['one', 'two']);
    const state = JSON.parse(readFileSync(join(f.paths.logs, 'retention.json'), 'utf8'));
    expect(state).toEqual({ sweptAt: NOW, consolidatedAt: { one: NOW, two: NOW } });
    f.clock.at = NOW + DAY;
    expect((await sweepRetention(f.input)).consolidatedVaults).toEqual(['one', 'two']);
  });

  test('an aborted sweep finishes its step under way, skips the rest and stays due', async () => {
    const f = fixture();
    const state = join(f.paths.logs, 'retention.json');
    file(state, NOW, JSON.stringify({ sweptAt: NOW - 2 * DAY, consolidatedAt: {} }));
    const shutdown = new AbortController();
    f.vaults[0]!.consolidate = async () => {
      shutdown.abort();
      f.consolidated.push('one');
      return { pruned: false };
    };
    const result = await sweepRetention({ ...f.input, signal: shutdown.signal });
    expect(result).toMatchObject({ ran: true, consolidatedVaults: ['one'], failedSteps: [] });
    expect(f.consolidated).toEqual(['one']);
    expect(JSON.parse(readFileSync(state, 'utf8'))).toEqual({ sweptAt: NOW - 2 * DAY, consolidatedAt: { one: NOW } });
    const stopped = expect.objectContaining({ message: 'retention sweep stopped by shutdown' });
    expect(f.logger.entries).toContainEqual(stopped);
    const next = await sweepRetention(f.input);
    expect(next).toMatchObject({ ran: true, consolidatedVaults: ['two'] });
    expect(f.consolidated).toEqual(['one', 'two']);
  });

  test('an aborted signal skips every step before the first', async () => {
    const f = fixture();
    file(f.paths.attemptLog('old'), NOW - 15 * DAY);
    const shutdown = new AbortController();
    shutdown.abort();
    const result = await sweepRetention({ ...f.input, signal: shutdown.signal });
    expect(result).toMatchObject({ ran: true, attemptLogs: 0, consolidatedVaults: [] });
    expect(existsSync(f.paths.attemptLog('old'))).toBe(true);
    expect(f.consolidated).toEqual([]);
  });

  test('unreadable state and a clock moved backwards allow a sweep', async () => {
    const f = fixture();
    const state = join(f.paths.logs, 'retention.json');
    for (const content of [
      '{broken',
      '{"sweptAt":"today"}',
      JSON.stringify({ sweptAt: NOW + DAY, consolidatedAt: { one: NOW + DAY } }),
    ]) {
      file(state, NOW, content);
      expect((await sweepRetention(f.input)).ran).toBe(true);
    }
    expect(f.consolidated).toEqual(['one', 'two', 'one', 'two', 'one', 'two']);
  });

  test('shares overlapping sweeps for one home without blocking another home', async () => {
    const f = fixture();
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.vaults[0]!.consolidate = async () => {
      await waiting;
      return { pruned: false };
    };
    const first = sweepRetention(f.input);
    const second = sweepRetention({ ...f.input, paths: runnerPaths(f.home) });
    expect(second).toBe(first);
    try {
      expect((await sweepRetention(fixture().input)).ran).toBe(true);
    } finally {
      release();
    }
    expect(await second).toBe(await first);
    expect((await sweepRetention(f.input)).ran).toBe(false);
  });

  test('a failed prune or vault does not stop later steps and only successful vaults are stamped', async () => {
    const f = fixture();
    const prune = spyOn(f.outbox, 'pruneAcked').mockImplementation(() => {
      throw new Error('busy');
    });
    cleanups.push(() => prune.mockRestore());
    const journal = spyOn(f.journal, 'pruneBefore');
    cleanups.push(() => journal.mockRestore());
    f.vaults[0]!.consolidate = async () => {
      throw new Error('repack failed');
    };
    file(f.paths.attemptLog('old'), NOW - 15 * DAY);
    const result = await sweepRetention(f.input);
    expect(result).toMatchObject({ ran: true, attemptLogs: 1, consolidatedVaults: ['two'] });
    expect(journal).toHaveBeenCalledWith(NOW - 14 * DAY);
    expect(f.logger.entries.filter((entry) => entry.level === 'warn')).toHaveLength(2);
    expect(JSON.parse(readFileSync(join(f.paths.logs, 'retention.json'), 'utf8')).consolidatedAt).toEqual({ two: NOW });
  });

  test('trims launchd excess in place', async () => {
    const f = fixture();
    const logs = launchdLogPaths(f.paths);
    file(logs.stdout);
    file(logs.stderr);
    truncateSync(logs.stdout, 10 * 1024 * 1024 + 1);
    const inode = statSync(logs.stdout).ino;
    expect((await sweepRetention(f.input)).launchdLogs).toEqual([logs.stdout]);
    expect(statSync(logs.stdout).size).toBe(0);
    expect(statSync(logs.stdout).ino).toBe(inode);
    expect(readFileSync(logs.stderr, 'utf8')).toBe('kept');
  });

  test('a state write failure is logged without losing the completed cleanup result', async () => {
    const f = fixture();
    directory(join(f.paths.logs, 'retention.json'));
    file(f.paths.attemptLog('old'), NOW - 15 * DAY);
    const result = await sweepRetention(f.input);
    expect(result).toMatchObject({
      ran: true,
      attemptLogs: 1,
      consolidatedVaults: ['one', 'two'],
      failedSteps: ['saveState'],
    });
    expect(readdirSync(f.paths.logs).sort()).toEqual(['attempts', 'retention.json']);
    expect(f.logger.entries).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        fields: expect.objectContaining({ step: 'saveState', error: expect.anything() }),
      }),
    );
  });

  test('forgets eligible records without session metadata or an adapter, but preserves dangling clone links', async () => {
    const f = fixture();
    f.attempt('T-4-a1', { sessionRef: null });
    f.attempt('T-4-a2', {}, 'codex');
    const linked = f.attempt('T-4-a3');
    directory(dirname(linked.clone!));
    symlinkSync(join(f.home, 'missing'), linked.clone!);
    const result = await sweepRetention(f.input);
    expect(result).toMatchObject({ attempts: 2, transcripts: 0 });
    expect(f.deleted).toEqual([]);
    expect(f.store.list().map((record) => record.attemptId)).toEqual(['T-4-a3']);
    expect(lstatSync(linked.clone!).isSymbolicLink()).toBe(true);
  });

  test('sweeps through an AGFLOW_HOME that is itself a link', async () => {
    const f = fixture();
    const linked = join(dirname(f.home), `${f.home.split('/').pop()}-link`);
    symlinkSync(f.home, linked);
    cleanups.push(() => rmSync(linked, { force: true }));
    file(f.paths.attemptLog('old'), NOW - 15 * DAY);
    const result = await sweepRetention({ ...f.input, paths: runnerPaths(linked) });
    expect(result).toMatchObject({ ran: true, attemptLogs: 1, failedSteps: [] });
    expect(existsSync(f.paths.attemptLog('old'))).toBe(false);
  });

  test('never traverses symlinked cleanup containers or launchd files into clones', async () => {
    const f = fixture();
    const clone = f.paths.clone('one', 'T-4-a1');
    const precious = join(clone, 'T-4-a1.json');
    file(precious, NOW - 20 * DAY);
    directory(join(clone, '1.0.0'), NOW - 20 * DAY);
    directory(f.paths.logs);
    symlinkSync(clone, join(f.paths.logs, 'attempts'));
    directory(f.paths.vendor);
    symlinkSync(clone, join(f.paths.vendor, 'claude'));
    directory(f.paths.vaults);
    symlinkSync(clone, join(f.paths.vaults, 'one.quarantine'));
    directory(f.paths.prep('one'));
    symlinkSync(clone, join(f.paths.prep('one'), 'state'));
    const huge = join(clone, 'huge');
    file(huge);
    truncateSync(huge, 10 * 1024 * 1024 + 1);
    symlinkSync(huge, launchdLogPaths(f.paths).stdout);
    await sweepRetention(f.input);
    expect(readFileSync(precious, 'utf8')).toBe('kept');
    expect(existsSync(join(clone, '1.0.0'))).toBe(true);
    expect(statSync(huge).size).toBe(10 * 1024 * 1024 + 1);
    expect(lstatSync(join(f.paths.logs, 'attempts')).isSymbolicLink()).toBe(true);
  });
});

test('retention keeps durable late work even when the ended attempt has no clone left', async () => {
  const f = fixture();
  for (const clone of [null, '/missing-agflow-clone']) {
    const id = clone === null ? 'T-4-a1' : 'T-4-a2';
    f.attempt(id, { clone, state: 'ended', endedAt: NOW - 15 * DAY, lateWorkSha: 'pending-sha' });
  }
  await sweepRetention(f.input);
  expect(f.store.list().map((record) => record.attemptId)).toEqual(['T-4-a1', 'T-4-a2']);
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `bun test packages/runner/test/ops/retention.test.ts`
Expected: FAIL — `error: Cannot find module '../../src/ops/retention' from 'packages/runner/test/ops/retention.test.ts'` (0 pass, 1 fail, 1 error). Observed on the current task parent with only this task's test files copied in (2026-11-11).

- [ ] **Step 3: Implement**

**File:** `packages/runner/src/ops/retention.ts` (new)

```ts
// Laptop retention (design 7.8). The service's runner.lock holder calls this; clones belong to cleanup_attempt.
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Vendor } from '@agflow/core';
import { z } from 'zod';
import type { VendorAdapter } from '../adapters/types';
import type { AttemptStore } from '../attempt-store';
import type { Vault } from '../git/vault';
import type { Journal } from '../journal';
import { type Logger, noopLogger } from '../log';
import type { Outbox } from '../outbox';
import type { RunnerPaths } from '../paths';
import { prepLayout, PrepState } from '../prep/plan';
import { launchdLogPaths, trimLaunchdLogs } from '../service/log';
import { VENDOR_PINS, vendorPlatform } from '../vendor/pins';

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

export const RETENTION = Object.freeze({
  journalMs: 14 * DAY,
  outboxMs: 14 * DAY,
  attemptLogMs: 14 * DAY,
  endedAttemptMs: 14 * DAY,
  sweepIntervalMs: DAY,
  /** How often the service asks; logs/retention.json keeps the sweep daily, from the start of the last one. */
  checkIntervalMs: HOUR,
  consolidationIntervalMs: DAY,
  quarantineMs: HOUR,
});

export interface RetentionInput {
  paths: RunnerPaths;
  outbox: Pick<Outbox, 'pruneAcked' | 'pruneBefore'>;
  journal: Pick<Journal, 'pruneBefore'>;
  store: Pick<AttemptStore, 'list' | 'remove'>;
  vaults: readonly Pick<Vault, 'project' | 'consolidate'>[];
  adapters: ReadonlyMap<Vendor, Pick<VendorAdapter, 'deleteTranscript'>>;
  eventRetentionMs: number;
  now?: () => number;
  logger?: Logger;
  /** vendorPlatform() by default; its VENDOR_PINS are the running pins. */
  platform?: string;
  /** The service's shutdown: the sweep stops before its next step, and the step under way finishes. */
  signal?: AbortSignal;
}

/** Counts are successful removals; failed steps are logged and can retry on the next daily sweep. */
export interface RetentionResult {
  ran: boolean;
  ackedEvents: number;
  outboxEvents: number;
  journalRows: number;
  attemptLogs: number;
  attempts: number;
  transcripts: number;
  vendorVersions: number;
  quarantines: number;
  prepStates: number;
  launchdLogs: string[];
  consolidatedVaults: string[];
  failedSteps: string[];
}

const Time = z.number().int().nonnegative();
const StateSchema = z.strictObject({
  sweptAt: Time,
  consolidatedAt: z.record(z.string(), Time),
});
type State = z.output<typeof StateSchema>;

/** Numeric major.minor.patch order; both are VERSION-shaped directory names or pins. */
function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function statOrNull(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Check containers too: unlinking a child through a directory symlink would delete in its target. AGFLOW_HOME itself
 * is the owner's choice and may be a link.
 */
function directoryExists(paths: RunnerPaths, path: string): boolean {
  const tail = relative(paths.home, path);
  if (isAbsolute(tail) || tail === '..' || tail.startsWith(`..${sep}`)) {
    throw new Error(`retention path outside AGFLOW_HOME: ${path}`);
  }
  if (!existsSync(paths.home)) return false;
  if (!statSync(paths.home).isDirectory()) throw new Error(`AGFLOW_HOME is not a directory: ${paths.home}`);
  let current = paths.home;
  for (const part of tail.split(sep).filter(Boolean)) {
    current = join(current, part);
    const stat = statOrNull(current);
    if (!stat) return false;
    if (!stat.isDirectory()) throw new Error(`retention needs a real directory: ${current}`);
  }
  return true;
}

function entries(paths: RunnerPaths, path: string) {
  return directoryExists(paths, path) ? readdirSync(path, { withFileTypes: true }) : [];
}

function readState(paths: RunnerPaths): State | null {
  try {
    if (!directoryExists(paths, paths.logs)) return null;
    const path = join(paths.logs, 'retention.json');
    if (!statOrNull(path)?.isFile()) return null;
    return StateSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    // Missing, unreadable or corrupt state must not prevent retention after a restart.
    return null;
  }
}

function saveState(paths: RunnerPaths, state: State): void {
  directoryExists(paths, paths.logs);
  mkdirSync(paths.logs, { recursive: true, mode: 0o700 });
  const temporary = join(paths.logs, `.retention.json.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, join(paths.logs, 'retention.json'));
  } finally {
    rmSync(temporary, { force: true });
  }
}

function due(previous: number | undefined, at: number, interval: number): boolean {
  return previous === undefined || previous > at || at - previous >= interval;
}

const underway = new Map<string, Promise<RetentionResult>>();

/** Only the lock holder may call this. Calls for the same home share the sweep already underway. */
export function sweepRetention(input: RetentionInput): Promise<RetentionResult> {
  const key = resolve(input.paths.home);
  const existing = underway.get(key);
  if (existing) return existing;
  const pending = sweep(input).finally(() => underway.delete(key));
  underway.set(key, pending);
  return pending;
}

async function sweep(input: RetentionInput): Promise<RetentionResult> {
  const { paths, outbox, journal, store } = input;
  const now = input.now ?? Date.now;
  const at = now();
  const logger = input.logger ?? noopLogger;
  const state = readState(paths);
  const result: RetentionResult = {
    ran: false,
    ackedEvents: 0,
    outboxEvents: 0,
    journalRows: 0,
    attemptLogs: 0,
    attempts: 0,
    transcripts: 0,
    vendorVersions: 0,
    quarantines: 0,
    prepStates: 0,
    launchdLogs: [],
    consolidatedVaults: [],
    failedSteps: [],
  };
  if (!due(state?.sweptAt, at, RETENTION.sweepIntervalMs)) return result;
  result.ran = true;

  const attempt = async (name: string, run: () => void | Promise<void>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      if (!result.failedSteps.includes(name)) result.failedSteps.push(name);
      logger.warn('retention step failed', {
        step: name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const step = async (name: string, run: () => void | Promise<void>): Promise<void> => {
    if (!input.signal?.aborted) await attempt(name, run);
  };

  await step('pruneAcked', () => {
    result.ackedEvents = outbox.pruneAcked(input.eventRetentionMs);
  });
  await step('pruneOutbox', () => {
    result.outboxEvents = outbox.pruneBefore(at - RETENTION.outboxMs);
  });
  await step('pruneJournal', () => {
    result.journalRows = journal.pruneBefore(at - RETENTION.journalMs);
  });

  await step('attemptLogs', async () => {
    const root = join(paths.logs, 'attempts');
    for (const entry of entries(paths, root)) {
      await step('attemptLogs', () => {
        const path = join(root, entry.name);
        const stat = statOrNull(path);
        if (stat?.isFile() && stat.mtimeMs < at - RETENTION.attemptLogMs) {
          rmSync(path);
          result.attemptLogs++;
        }
      });
    }
  });

  await step('endedAttempts', async () => {
    for (const record of store.list()) {
      await step('endedAttempts', async () => {
        if (record.lateWorkSha !== null) return;
        if (record.endedAt === null || record.endedAt >= at - RETENTION.endedAttemptMs) return;
        // lstat preserves even a dangling clone link; only an absent path is known to be gone.
        if (record.clone !== null && statOrNull(record.clone) !== null) return;
        const adapter = input.adapters.get(record.spec.vendor);
        if (record.clone !== null && record.sessionRef !== null && adapter) {
          await adapter.deleteTranscript({ sessionRef: record.sessionRef, clone: record.clone });
          result.transcripts++;
        }
        // A null clone was already cleaned up, including its transcript, by cleanup_attempt.
        store.remove(record.attemptId);
        result.attempts++;
      });
    }
  });

  await step('vendorVersions', async () => {
    const platformPins = VENDOR_PINS[input.platform ?? vendorPlatform()];
    const pins = { claude: platformPins?.claude.version, codex: platformPins?.codex.version };
    const records = store.list();
    for (const vendor of ['claude', 'codex'] as const) {
      await step('vendorVersions', async () => {
        const used = new Set(
          records.filter((record) => record.spec.vendor === vendor).map((record) => record.cliVersion),
        );
        const root = join(paths.vendor, vendor);
        for (const entry of entries(paths, root)) {
          if (!/^\d+\.\d+\.\d+$/.test(entry.name) || used.has(entry.name)) continue;
          // An upgrade can install its pin before this older runner restarts; only versions below the running pin go.
          const pin = pins[vendor];
          if (pin !== undefined && compareVersions(entry.name, pin) >= 0) continue;
          await step('vendorVersions', () => {
            const path = join(root, entry.name);
            const stat = statOrNull(path);
            if (!stat?.isDirectory() && !stat?.isSymbolicLink()) return;
            rmSync(path, { recursive: true, force: true });
            result.vendorVersions++;
          });
        }
      });
    }
  });

  await step('quarantines', async () => {
    for (const project of entries(paths, paths.vaults)) {
      if (!project.isDirectory() || !project.name.endsWith('.quarantine')) continue;
      const root = join(paths.vaults, project.name);
      await step('quarantines', async () => {
        for (const entry of entries(paths, root)) {
          await step('quarantines', () => {
            const path = join(root, entry.name);
            const stat = statOrNull(path);
            if (stat && stat.mtimeMs < at - RETENTION.quarantineMs) {
              rmSync(path, { recursive: true, force: true });
              result.quarantines++;
            }
          });
        }
      });
    }
  });

  await step('prepStates', async () => {
    const kept = new Set(store.list().map((record) => record.attemptId));
    for (const project of entries(paths, join(paths.runner, 'prep'))) {
      if (!project.isDirectory()) continue;
      await step('prepStates', async () => {
        const root = paths.prep(project.name);
        if (!directoryExists(paths, prepLayout(root).state)) return;
        const prep = new PrepState(root);
        for (const attemptId of prep.attempts()) {
          if (kept.has(attemptId)) continue;
          await step('prepStates', () => {
            prep.forget(attemptId);
            result.prepStates++;
          });
        }
      });
    }
  });

  await step('launchdLogs', () => {
    if (!directoryExists(paths, paths.logs)) return;
    // trimLaunchdLogs truncates in place, so refuse links before handing it these paths.
    for (const path of Object.values(launchdLogPaths(paths))) {
      const stat = statOrNull(path);
      if (stat && !stat.isFile()) throw new Error(`launchd log is not a regular file: ${path}`);
    }
    result.launchdLogs = trimLaunchdLogs(paths);
  });

  // No prototype: a project key is a name, never an inherited property.
  const consolidatedAt: Record<string, number> = Object.assign(Object.create(null), state?.consolidatedAt);
  for (const vault of input.vaults) {
    const previous = Object.hasOwn(consolidatedAt, vault.project) ? consolidatedAt[vault.project] : undefined;
    if (!due(previous, at, RETENTION.consolidationIntervalMs)) continue;
    await step('consolidate', async () => {
      await vault.consolidate();
      // Stamped with the sweep's start, as sweptAt is, so a long repack does not push the next one past a day.
      consolidatedAt[vault.project] = at;
      result.consolidatedVaults.push(vault.project);
    });
  }
  // A stopped sweep keeps its consolidations and stays due, so the next start finishes it.
  const stopped = input.signal?.aborted === true;
  if (stopped) logger.info('retention sweep stopped by shutdown');
  await attempt('saveState', () => saveState(paths, { sweptAt: stopped ? (state?.sweptAt ?? 0) : at, consolidatedAt }));
  return result;
}
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `bun test packages/runner/test/ops/retention.test.ts && bun test && bun run typecheck`
Expected: the task's tests pass; then the whole suite passes (`0 fail`) and `tsc` exits 0.

A sweep is due a day after the start of the last one; each vault gets its own daily stamp, set only after a successful consolidation. Each step is independent: a failure is logged and recorded in `failedSteps`, and the next steps still run. An `AbortSignal` stops the sweep before its next step and keeps it due. `deleteTranscript` is called only when a recorded clone is gone; a null clone means `cleanup_attempt` already deleted the transcript (M2b). A failed deletion keeps the record for the next sweep. The sweep never follows links in the directories it deletes from and never touches `work/`; `AGFLOW_HOME` itself may be a link. The host may continue constructing new Outbox(db): its safe default reads settingsSavedVersion. Pruning uses the lower of confirmedVersion and settingsSavedVersion, keeps no probe merely because it is unanswered, and deletes marks with their events. M2c does not duplicate this settings logic. The sweep also removes attempt logs after 14 days, quarantine leftovers after an hour, stale preparation state and oversized launchd logs, and consolidates each vault daily. It removes unreferenced vendor versions only below the current pin; an unknown pin table has no version floor.

- [ ] **Step 5: Commit**

```bash
git add -A 'packages/runner/src/ops/retention.ts' 'packages/runner/test/ops/retention.test.ts'
git commit -m 'M2C Task 13: Retention on the laptop' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

### Task 14: The service host

The process that runs a runner (design 7.1): `startRunnerService`, behind `agflow runner start` and `--service`. It takes the lock (waiting under launchd), opens the log and the run record, loads runner.json, checks the machine binding, binds the control socket, opens runner.db, and calls M2b's `createRunner` with `readCliCredentials` as the credentials provider (X-8) and `createAdapters`' adapters unless some are injected (X-6). It owns the exit policy (X-41, X-36): a refusal that needs a person (a missing runner.json, another Mac, 4403 including a retired runner, 4426, and, until Task 18, no credentials) exits 0 under launchd and 1 in the foreground, 4409 exits 0, and an uncaught error is recorded unclean and exits 1. The test helpers `setupTestService` and `startTestService` run it against M2b's in-process hub (X-26).

**Files:**
- Create: `packages/runner/src/service/host.ts`
- Test: `packages/runner/test/service-helpers.ts`
- Test: `packages/runner/test/service/host.test.ts`
- Test: `packages/runner/test/service/run-service.ts`

- [ ] **Step 1: Write the failing tests**

**File:** `packages/runner/test/service-helpers.ts` (change)

```diff
diff --git a/packages/runner/test/service-helpers.ts b/packages/runner/test/service-helpers.ts
index 31a16c41..d0c658a2 100644
--- a/packages/runner/test/service-helpers.ts
+++ b/packages/runner/test/service-helpers.ts
@@ -1,12 +1,132 @@
-// Shared service test helpers: recorded commands and isolated vendor CLIs.
+// Shared service test helpers: recorded commands, isolated vendor CLIs, and the service host against the in-process
+// hub.
 import { createHash } from 'node:crypto';
-import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
+import {
+  chmodSync,
+  existsSync,
+  mkdirSync,
+  mkdtempSync,
+  readdirSync,
+  readFileSync,
+  rmSync,
+  writeFileSync,
+} from 'node:fs';
 import { tmpdir } from 'node:os';
 import { dirname, join } from 'node:path';
-import type { Vendor } from '@agflow/core';
-import type { RunnerPaths } from '../src/paths';
+import { CREDENTIALS_FILE, type Vendor } from '@agflow/core';
+import { FakeAdapter, originRepo } from '@agflow/testkit';
+import { AttemptStore } from '../src/attempt-store';
+import { type RunnerConfigInput, RunnerConfigSchema, saveRunnerConfig } from '../src/config';
+import { openRunnerDb } from '../src/db';
+import { type RunnerPaths, runnerPaths } from '../src/paths';
+import { killGroup } from '../src/processes';
+import { removeAgentTools } from '../src/run-dir';
+import { type RunnerServiceOptions, startRunnerService } from '../src/service/host';
 import type { Exec, ExecOptions, ExecResult } from '../src/service/system';
 import { vendorBinary } from '../src/vendor/pins';
+import { FIXTURE_AGFLOW, fixtureCliVersion } from './fixture';
+import { startTestHub, type TestHub } from './hub-fixture';
+import { afterThisTest, tempDir } from './runner-setup';
+
+export interface TestServiceOptions {
+  /** A hub another service of the test already uses; a new one over a local bare origin by default. */
+  hub?: TestHub;
+  /** runner.json fields over the test runner's. */
+  config?: Partial<RunnerConfigInput>;
+  /** Leaves credentials.json out of the CLI's config directory. */
+  noCredentials?: boolean;
+  /** The foreground by default. */
+  mode?: RunnerServiceOptions['mode'];
+  /** Host options over the helper's: the fake adapters, MACHINE-1 and a capturing terminal. */
+  host?: Partial<RunnerServiceOptions>;
+}
+
+/**
+ * A short AGFLOW_HOME (runner.sock must fit in 104 bytes) with a test runner.json, and a CLI config directory signed in
+ * to the hub: the same files for an in-process host (start) and for run-service.ts in a child. Everything is removed
+ * after the test.
+ */
+export async function setupTestService(options: TestServiceOptions = {}) {
+  let hub = options.hub;
+  if (!hub) {
+    const origin = await originRepo({ 'README.md': '# demo\n', 'src/app.ts': 'app\n' });
+    afterThisTest(() => origin.remove());
+    hub = startTestHub({ config: { projectName: 'demo', projectRepo: origin.path } });
+    const ownedHub = hub;
+    afterThisTest(() => ownedHub.stop());
+  }
+  const home = mkdtempSync('/tmp/agf-');
+  afterThisTest(() => rmSync(home, { recursive: true, force: true }));
+  const paths = runnerPaths(home);
+  afterThisTest(() => {
+    if (!existsSync(paths.vaults)) return;
+    for (const entry of readdirSync(paths.vaults).filter((name) => name.endsWith('.agent'))) {
+      for (const attempt of readdirSync(join(paths.vaults, entry))) {
+        removeAgentTools(join(paths.vaults, entry, attempt));
+      }
+    }
+  });
+  const configDir = tempDir('agf-cli-');
+  if (!options.noCredentials) {
+    writeFileSync(join(configDir, CREDENTIALS_FILE), JSON.stringify(hub.credentials), { mode: 0o600 });
+  }
+  const config = RunnerConfigSchema.parse({
+    runnerKey: `rk_${crypto.randomUUID()}`,
+    machineId: 'MACHINE-1',
+    name: 'laptop',
+    test: { skipAuthChecks: true, allowShortTimings: true },
+    ...options.config,
+  });
+  saveRunnerConfig(paths.config, config);
+  const tmpRoot = mkdtempSync('/tmp/ag');
+  afterThisTest(() => rmSync(tmpRoot, { recursive: true, force: true }));
+  const terminal: string[] = [];
+  const start = async (overrides: Partial<RunnerServiceOptions> = {}) => {
+    const host = { ...options.host, ...overrides };
+    const service = await startRunnerService({
+      paths,
+      configDir,
+      mode: options.mode ?? 'foreground',
+      machineId: async () => 'MACHINE-1',
+      agflow: FIXTURE_AGFLOW,
+      cliVersion: fixtureCliVersion,
+      terminal: (line) => terminal.push(line),
+      tmpRoot,
+      adapters: host.createAdapters ? undefined : fakeServiceAdapters(),
+      ...host,
+    });
+    afterThisTest(async () => {
+      try {
+        // The host owns its db, so cleanup uses a separate reader even after the host has ended.
+        if (existsSync(paths.db)) {
+          const db = openRunnerDb(paths.db);
+          try {
+            for (const group of new AttemptStore(db).processes()) await killGroup(group, 'SIGKILL');
+          } finally {
+            db.close();
+          }
+        }
+      } finally {
+        await service.stop('test cleanup');
+      }
+    });
+    return service;
+  };
+  return { hub, paths, configDir, config, terminal, tmpRoot, start };
+}
+
+/** A fake adapter per vendor whose agents play one empty turn. */
+export function fakeServiceAdapters() {
+  return (['claude', 'codex'] as const).map(
+    (vendor) => new FakeAdapter({ vendor, skipAuthChecks: true, script: { turns: [[]] } }),
+  );
+}
+
+/** The files of setupTestService and a service started on them. */
+export async function startTestService(options: TestServiceOptions = {}) {
+  const setup = await setupTestService(options);
+  return { ...setup, service: await setup.start() };
+}
 
 export interface ExecCall {
   argv: string[];
```

**File:** `packages/runner/test/service/host.test.ts` (new)

```ts
// The service host (design 7.1, X-41) against the in-process hub: one lock holder, the control socket, the run
// record, and the exit policy for refusals, replacements, stops, signals and errors.
import { afterEach, describe, expect, mock, setDefaultTimeout, test } from 'bun:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CREDENTIALS_FILE, PROTOCOL_VERSION } from '@agflow/core';
import { getAttempt } from '@agflow/hub/src/attempt-store';
import { createSession, sessionHashOf } from '@agflow/hub/src/auth';
import { findRunnerByKey, getRunner } from '@agflow/hub/src/runners';
import { createTasks } from '@agflow/hub/src/tasks';
import { newTask } from '@agflow/hub/test/helpers';
import { connectFakeRunnerWs } from '@agflow/hub/test/fake-runner';
import { FakeAdapter } from '@agflow/testkit';
import { AttemptStore } from '../../src/attempt-store';
import { loadRunnerConfig } from '../../src/config';
import { openRunnerDb } from '../../src/db';
import { Outbox } from '../../src/outbox';
import { controlRequest } from '../../src/service/control';
import type { RunnerService } from '../../src/service/host';
import { readLockOwner } from '../../src/service/lock';
import { ServiceRuns } from '../../src/service/runs';
import { FIXTURE_AGFLOW, waitFor } from '../fixture';
import { startRunnerAttempt } from '../hub-fixture';
import { afterThisTest, cleanupRunnerSetups } from '../runner-setup';
import { setupTestService, startTestService } from '../service-helpers';

afterEach(cleanupRunnerSetups);
setDefaultTimeout(60_000);

async function online(service: RunnerService) {
  await waitFor(() => service.runner?.status().link === 'online');
  return service.runner!.status().runnerId!;
}

function lastExit(paths: RunnerService['paths']) {
  return new ServiceRuns(paths).lastExit({ running: false });
}

/** Reads runner.db beside the host's own connection. */
function readDb<T>(paths: RunnerService['paths'], read: (db: ReturnType<typeof openRunnerDb>) => T): T {
  const db = openRunnerDb(paths.db);
  try {
    return read(db);
  } finally {
    db.close();
  }
}

/** The agent groups runner.db registers. */
function registeredGroups(paths: RunnerService['paths']) {
  return readDb(paths, (db) => new AttemptStore(db).processes());
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function register(s: Awaited<ReturnType<typeof setupTestService>>, machineId = s.config.machineId) {
  const fake = await connectFakeRunnerWs(s.hub.url, { runnerKey: s.config.runnerKey, machineId, token: s.hub.token });
  afterThisTest(() => fake.disconnect());
  expect(fake.welcome).not.toBeNull();
  return fake;
}

describe('startRunnerService', () => {
  test('says hello, serves health, and releases everything on an idempotent stop', async () => {
    const s = await startTestService();
    const runnerId = await online(s.service);
    expect(getRunner(s.hub.ctx, runnerId)).toMatchObject({ state: 'online', name: 'laptop' });
    expect(findRunnerByKey(s.hub.ctx, s.config.runnerKey)?.machine_id).toBe('MACHINE-1');
    const health = await controlRequest(s.paths, 'GET', '/health');
    const startedAt = expect.any(String);
    expect(health).toEqual({ pid: process.pid, mode: 'foreground', startedAt, runnerId, link: 'online' });
    const exit = await s.service.stop('finished');
    expect(exit).toEqual({ code: 0, clean: true, reason: 'finished' });
    expect(await s.service.stop('again')).toEqual(exit);
    expect(await s.service.exited).toEqual(exit);
    expect(readLockOwner(s.paths)).toBeNull();
    expect(existsSync(s.paths.socket)).toBe(false);
    expect(lastExit(s.paths)).toMatchObject(exit);
    expect(readFileSync(s.paths.runnerLog, 'utf8')).toContain('info finished');
  });

  test('a second foreground start reports the holder without writing its log or history', async () => {
    const s = await startTestService();
    await online(s.service);
    const runs = new ServiceRuns(s.paths);
    const before = readFileSync(runs.path, 'utf8');
    const log = readFileSync(s.paths.runnerLog, 'utf8');
    const second = await s.start();
    const reason = `the runner is already running (pid ${process.pid}); use agflow runner status`;
    expect(second.runner).toBeNull();
    expect(await second.exited).toMatchObject({ code: 1, reason });
    expect(s.terminal.join('')).toContain(reason);
    expect(readFileSync(runs.path, 'utf8')).toBe(before);
    expect(readFileSync(s.paths.runnerLog, 'utf8')).toBe(log);
  });

  test('a service start waits for the lock and starts after the holder stops', async () => {
    const s = await startTestService();
    await online(s.service);
    let started = false;
    const waiting = s.start({ mode: 'service', lockPollMs: 10 }).then((service) => {
      started = true;
      return service;
    });
    await Bun.sleep(70);
    expect(started).toBe(false);
    expect(s.terminal.join('')).toContain(`pid ${process.pid}`);
    await s.service.stop('handover');
    const second = await waiting;
    await online(second);
    expect(second.mode).toBe('service');
    expect(new ServiceRuns(s.paths).records()).toHaveLength(2);
  });

  test('missing credentials are a clean refusal in foreground', async () => {
    const s = await startTestService({ noCredentials: true });
    const exit = await s.service.exited;
    const reason = 'not signed in; run agflow login --hub <url>';
    expect(exit).toEqual({ code: 1, clean: true, reason });
    expect(lastExit(s.paths)).toMatchObject(exit);
    expect(s.terminal.join('')).toContain(exit.reason);
    expect(existsSync(s.paths.socket)).toBe(false);
  });

  for (const mode of ['foreground', 'service'] as const) {
    test(`a machine mismatch is a clean refusal in ${mode}`, async () => {
      const s = await startTestService({ mode, config: { machineId: 'OTHER' } });
      const exit = await s.service.exited;
      expect(exit).toMatchObject({ code: mode === 'service' ? 0 : 1, clean: true });
      expect(exit.reason.endsWith('run agflow runner setup')).toBe(true);
      expect(lastExit(s.paths)).toMatchObject(exit);
      expect(s.service.runner).toBeNull();
      expect(findRunnerByKey(s.hub.ctx, s.config.runnerKey)).toBeNull();
      expect(readLockOwner(s.paths)).toBeNull();
    });

    for (const invalid of ['missing', 'invalid'] as const) {
      test(`${invalid} runner.json is a clean refusal in ${mode}`, async () => {
        const s = await setupTestService({ mode });
        if (invalid === 'missing') rmSync(s.paths.config);
        else writeFileSync(s.paths.config, '{"capacity":0}');
        const service = await s.start();
        const exit = await service.exited;
        expect(exit).toMatchObject({ code: mode === 'service' ? 0 : 1, clean: true });
        expect(service.runner).toBeNull();
        expect(lastExit(s.paths)).toMatchObject(exit);
        expect(readLockOwner(s.paths)).toBeNull();
      });
    }

    for (const refusal of ['another machine', 'retired'] as const) {
      test(`4403 for ${refusal} keeps the hub reason in ${mode}`, async () => {
        const s = await setupTestService({ mode });
        const fake = await register(s, refusal === 'another machine' ? 'OTHER' : 'MACHINE-1');
        fake.disconnect();
        if (refusal === 'retired') {
          const response = await fetch(`${s.hub.url}/api/runner/retire`, {
            method: 'POST',
            headers: { authorization: `Bearer ${s.hub.token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ runnerKey: s.config.runnerKey }),
          });
          expect(response.ok).toBe(true);
        }
        const service = await s.start();
        const exit = await service.exited;
        const reason =
          refusal === 'retired'
            ? 'this runner was retired; run agflow runner setup'
            : 'this runner belongs to alice on another machine; run agflow runner setup';
        expect(exit).toEqual({ code: mode === 'service' ? 0 : 1, clean: true, reason });
        expect(lastExit(s.paths)).toMatchObject(exit);
        const log = readFileSync(s.paths.runnerLog, 'utf8');
        expect(log).toContain('4403');
        expect(log).toContain(`error ${reason}`);
      });
    }

    test(`4426 is a clean refusal in ${mode}`, async () => {
      const s = await setupTestService({ mode });
      s.hub.ctx.config.minProtocol = PROTOCOL_VERSION + 1;
      const service = await s.start();
      const exit = await service.exited;
      const reason =
        `runner protocol ${PROTOCOL_VERSION} is not supported: ` +
        `this hub accepts protocol ${PROTOCOL_VERSION + 1} to ${PROTOCOL_VERSION}`;
      expect(exit).toEqual({ code: mode === 'service' ? 0 : 1, clean: true, reason });
      expect(lastExit(s.paths)).toMatchObject(exit);
      expect(readFileSync(s.paths.runnerLog, 'utf8')).toContain('4426');
    });
  }

  test('4409 from a replacement connection records a clean exit with code zero', async () => {
    const s = await startTestService();
    await online(s.service);
    await register(s);
    const exit = await s.service.exited;
    expect(exit).toEqual({ code: 0, clean: true, reason: 'another connection replaced this one' });
    expect(lastExit(s.paths)).toMatchObject(exit);
    expect(readFileSync(s.paths.runnerLog, 'utf8')).toContain('4409');
    expect(readLockOwner(s.paths)).toBeNull();
  });

  for (const end of ['4409', 'retire'] as const) {
    test(`after ${end} no agent outlives the service`, async () => {
      // Mid-turn, the agent ignores the end of its input, as Claude does: closing the runner alone would leave it.
      const adapter = new FakeAdapter({
        vendor: 'codex',
        skipAuthChecks: true,
        script: { turns: [[{ do: 'sleep', ms: 120_000 }]], ignoreEofMidTurn: true },
      });
      const s = await startTestService({ mode: 'service', host: { adapters: [adapter] } });
      const runnerId = await online(s.service);
      const [task] = createTasks(s.hub.ctx, [newTask()], 'user:alice');
      const spec = { runnerId, taskId: task!.id, role: 'worker', vendor: 'codex' } as const;
      const { attempt } = startRunnerAttempt(s.hub.ctx, spec);
      await waitFor(() => getAttempt(s.hub.ctx, attempt.id).status === 'running');
      await waitFor(() => s.service.runner!.status().attempts.some((a) => a.phase === 'turn'));
      const groups = await waitFor(() => {
        const groups = registeredGroups(s.paths);
        return groups.length > 0 ? groups : null;
      });
      if (end === '4409') {
        await register(s);
      } else {
        const response = await fetch(`${s.hub.url}/api/runner/retire`, {
          method: 'POST',
          headers: { authorization: `Bearer ${s.hub.token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ runnerKey: s.config.runnerKey }),
        });
        expect(response.ok).toBe(true);
      }
      expect(await s.service.exited).toMatchObject({ code: 0, clean: true });
      expect(registeredGroups(s.paths)).toEqual([]);
      expect(groups.filter((group) => alive(group.pid))).toEqual([]);
      // Stopped, not only killed: one exit for the hub's next welcome (a retire's own stop may come first).
      const exits = readDb(s.paths, (db) => new Outbox(db).eventsAfter(0)).filter((e) => e.type === 'attempt.exited');
      expect(exits).toEqual([expect.objectContaining({ attemptId: attempt.id })]);
      if (end === '4409') expect(exits[0]?.data).toMatchObject({ cause: 'runner_stop', handoffWritten: false });
    });
  }

  test('constructs adapters with the config, paths and agflow command when none are injected', async () => {
    const adapter = new FakeAdapter({ vendor: 'codex', skipAuthChecks: true, script: { turns: [[]] } });
    const factory = mock(() => [adapter]);
    const s = await setupTestService({ host: { createAdapters: factory } });
    const config = loadRunnerConfig(s.paths.config);
    const service = await s.start();
    const runnerId = await online(service);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith(config, s.paths, { agflow: FIXTURE_AGFLOW });
    expect(getRunner(s.hub.ctx, runnerId)?.vendors.map((v) => v.vendor)).toEqual(['codex']);
  });

  test('injected adapters bypass the factory', async () => {
    const factory = mock(() => {
      throw new Error('must not be called');
    });
    const s = await startTestService({ host: { adapters: [], createAdapters: factory } });
    await online(s.service);
    expect(factory).not.toHaveBeenCalled();
  });

  test('a createRunner failure records an unclean exit and releases the socket, db and lock', async () => {
    const fetch = async () => {
      throw new Error('project unavailable\ntry later');
    };
    const s = await startTestService({ host: { fetch } });
    const exit = await s.service.exited;
    expect(exit).toMatchObject({ code: 1, clean: false });
    expect(exit.reason).toContain('cannot read the project from the hub');
    expect(exit.reason).not.toContain('\n');
    expect(lastExit(s.paths)).toMatchObject(exit);
    expect(s.service.runner).toBeNull();
    expect(existsSync(s.paths.socket)).toBe(false);
    expect(readLockOwner(s.paths)).toBeNull();
    const restarted = await s.start({ fetch: undefined });
    await online(restarted);
  });

  test('a failed close still releases later resources and records an unclean exit', async () => {
    const s = await startTestService();
    await online(s.service);
    const close = s.service.runner!.close;
    s.service.runner!.close = async () => {
      await close();
      throw new Error('close failed');
    };
    expect(await s.service.stop('done')).toEqual({ code: 1, clean: false, reason: 'close failed' });
    expect(lastExit(s.paths)).toMatchObject({ code: 1, clean: false, reason: 'close failed' });
    expect(readLockOwner(s.paths)).toBeNull();
    expect(existsSync(s.paths.socket)).toBe(false);
  });

  test('health is available before hello, which re-reads credentials changed during startup', async () => {
    const s = await setupTestService();
    const token = createSession(s.hub.ctx, s.hub.owner, 'cli');
    const requested = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const starting = s.start({
      fetch: async (input, init) => {
        requested.resolve();
        await resume.promise;
        return fetch(input, init);
      },
    });
    try {
      await requested.promise;
      const health = await controlRequest(s.paths, 'GET', '/health');
      expect(health).toMatchObject({ pid: process.pid, mode: 'foreground', runnerId: null, link: 'idle' });
      writeFileSync(join(s.configDir, CREDENTIALS_FILE), JSON.stringify({ ...s.hub.credentials, token }));
    } finally {
      resume.resolve();
      await starting;
    }
    await online(await starting);
    expect(findRunnerByKey(s.hub.ctx, s.config.runnerKey)?.session_hash).toBe(sessionHashOf(token));
  });

  test('process handlers are opt-in and are removed when the service ends', async () => {
    const names = ['SIGTERM', 'SIGINT', 'uncaughtException', 'unhandledRejection'] as const;
    const before = names.map((name) => process.listeners(name));
    const s = await startTestService();
    expect(names.map((name) => process.listeners(name))).toEqual(before);
    await s.service.stop('restart with signals');
    const service = await s.start({ signals: true });
    for (const [index, name] of names.entries()) {
      expect(process.listeners(name)).toHaveLength(before[index]!.length + 1);
    }
    await service.stop('done');
    expect(names.map((name) => process.listeners(name))).toEqual(before);
  });

  for (const cause of ['SIGTERM', 'SIGINT', 'exception', 'rejection'] as const) {
    test(`${cause} records the exit and releases a child service`, async () => {
      const s = await setupTestService();
      const child = Bun.spawn([process.execPath, join(import.meta.dir, 'run-service.ts')], {
        env: { ...process.env, AGFLOW_HOME: s.paths.home, AGFLOW_CONFIG_DIR: s.configDir, AGFLOW_TEST_FAILURE: cause },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      afterThisTest(async () => {
        if (child.exitCode === null) child.kill('SIGKILL');
        await child.exited;
      });
      const stderr = new Response(child.stderr).text();
      const reader = child.stdout.getReader();
      let output = '';
      while (!output.includes('online\n')) {
        const { done, value } = await reader.read();
        if (done) throw new Error(`child ended before online: ${await stderr}`);
        output += new TextDecoder().decode(value);
      }
      reader.releaseLock();
      const clean = cause === 'SIGTERM' || cause === 'SIGINT';
      if (clean) child.kill(cause);
      expect(await child.exited).toBe(clean ? 0 : 1);
      const reason = clean ? `received ${cause}` : `child ${cause === 'exception' ? 'uncaught' : 'unhandled'} ${cause}`;
      expect(lastExit(s.paths)).toMatchObject({ code: clean ? 0 : 1, clean, reason });
      expect(readLockOwner(s.paths)).toBeNull();
      expect(existsSync(s.paths.socket)).toBe(false);
    });
  }
});

test('the host forwards the injected CLI version to launches, durable records and spawned events', async () => {
  const adapter = new FakeAdapter({ vendor: 'codex', skipAuthChecks: true, script: { turns: [[]] } });
  const s = await startTestService({ host: { adapters: [adapter], cliVersion: (vendor) => `fixture-${vendor}` } });
  const runnerId = await online(s.service);
  const [task] = createTasks(s.hub.ctx, [newTask()], 'user:alice');
  const { attempt } = startRunnerAttempt(s.hub.ctx, { runnerId, taskId: task!.id, role: 'worker', vendor: 'codex' });
  await waitFor(() => readDb(s.paths, (db) => new Outbox(db).eventsAfter(0).some(
    (event) => event.type === 'attempt.spawned' && event.attemptId === attempt.id,
  )));
  expect(adapter.launches[0]!.cliVersion).toBe('fixture-codex');
  expect(readDb(s.paths, (db) => new AttemptStore(db).get(attempt.id)!.cliVersion)).toBe('fixture-codex');
  expect(readDb(s.paths, (db) => new Outbox(db).eventsAfter(0))).toContainEqual(expect.objectContaining({
    type: 'attempt.spawned', attemptId: attempt.id, data: expect.objectContaining({ cliVersion: 'fixture-codex' }),
  }));
});
```

**File:** `packages/runner/test/service/run-service.ts` (new)

```ts
// A child-process service for tests (host.test.ts, and task 17's suspend): the fake adapters on the AGFLOW_HOME and
// AGFLOW_CONFIG_DIR its parent prepared, with the process handlers on. It prints 'online' once the hub has it, and
// AGFLOW_TEST_FAILURE=exception|rejection then throws, so the parent can check the unclean exit.
import { loadRunnerConfig } from '../../src/config';
import { runnerPaths } from '../../src/paths';
import { startRunnerService } from '../../src/service/host';
import { FIXTURE_AGFLOW, fixtureCliVersion } from '../fixture';
import { fakeServiceAdapters } from '../service-helpers';

const paths = runnerPaths();
const configDir = process.env.AGFLOW_CONFIG_DIR;
if (!configDir) throw new Error('AGFLOW_CONFIG_DIR is required');
const mode = process.env.AGFLOW_SERVICE_MODE ?? 'foreground';
if (mode !== 'foreground' && mode !== 'service') throw new Error(`invalid service mode: ${mode}`);
const service = await startRunnerService({
  paths,
  configDir,
  mode,
  machineId: async () => loadRunnerConfig(paths.config).machineId,
  adapters: fakeServiceAdapters(),
  agflow: FIXTURE_AGFLOW,
  cliVersion: fixtureCliVersion,
  signals: true,
});
let ended = false;
void service.exited.then(() => {
  ended = true;
});
while (!ended && service.runner?.status().link !== 'online') await Bun.sleep(10);
if (!ended) {
  console.log('online');
  if (process.env.AGFLOW_TEST_FAILURE === 'exception') {
    setTimeout(() => {
      throw new Error('child uncaught exception');
    }, 0);
  } else if (process.env.AGFLOW_TEST_FAILURE === 'rejection') {
    void Promise.reject(new Error('child unhandled rejection'));
  }
}
process.exit((await service.exited).code);
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `bun test packages/runner/test/service/host.test.ts`
Expected: FAIL — `error: Cannot find module '../src/service/host' from 'packages/runner/test/service-helpers.ts'` (0 pass, 1 fail, 1 error). Observed on the current task parent with only this task's test files copied in (2026-11-11).

- [ ] **Step 3: Implement**

**File:** `packages/runner/src/service/host.ts` (new)

```ts
// The process that runs a runner (design 7.1, X-41): `agflow runner start` in the foreground and `--service` under
// launchd. One lock holder, one run record, and one exit path for every end: a refusal that needs a person, the hub
// replacing the link, a stop, or an error.
import { createAdapters } from '../adapters';
import type { AgflowCommand, VendorAdapter } from '../adapters/types';
import { AttemptStore } from '../attempt-store';
import { loadRunnerConfig, type RunnerConfig } from '../config';
import { openRunnerDb, type RunnerDb } from '../db';
import type { FetchFn } from '../hub-http';
import { type RunnerPaths, runnerPaths } from '../paths';
import { killRegisteredGroups } from '../recovery';
import { createRunner, type RunnerEvents, type RunnerHandle, type RunnerOptions } from '../runner';
import { type ControlRoutes, type ControlServer, startControlServer } from './control';
import { readCliCredentials } from './credentials';
import { AlreadyRunningError, acquireRunnerLock, type RunnerLock, type RunnerMode } from './lock';
import { RotatingLog } from './log';
import { machineMismatch, readMachineId } from './machine';
import { ServiceRuns } from './runs';

/** How the service ended: the process exit code, whether the run counts as clean (task 19's guard), and why. */
export interface ServiceExit {
  code: number;
  clean: boolean;
  reason: string;
}

export interface RunnerServiceOptions {
  mode: RunnerMode;
  /** The CLI's configuration directory: credentials.json is read from it on each use (X-8). */
  configDir: string;
  /** How the runner runs agflow itself (the CLI's selfCommand()). */
  agflow: AgflowCommand;
  /** runnerPaths(agflowHome()) by default. */
  paths?: RunnerPaths;
  /** The adapters to run; createAdapters' otherwise (X-6). */
  adapters?: VendorAdapter[];
  /** Test adapters may supply a platform-neutral version; production uses M2b's pinned version. */
  cliVersion?: RunnerOptions['cliVersion'];
  /** createAdapters by default; used only without injected adapters. */
  createAdapters?: typeof createAdapters;
  /** readMachineId by default. */
  machineId?: () => Promise<string>;
  /** The foreground's terminal, and where lines go before the log exists; stderr by default. */
  terminal?: (line: string) => void;
  /**
   * The CLI owns its process: SIGTERM and SIGINT stop the service, and an uncaught error ends it unclean. Off for a
   * host embedded in another process, such as a test.
   */
  signals?: boolean;
  lockPollMs?: number;
  fetch?: FetchFn;
  tmpRoot?: string;
}

export interface RunnerService {
  readonly paths: RunnerPaths;
  readonly mode: RunnerMode;
  /** The running runner; null when the service ended before it started. */
  readonly runner: RunnerHandle | null;
  /** Resolves after teardown, once runner.lock, released last, is free. */
  readonly exited: Promise<ServiceExit>;
  /**
   * Stops the agents with no handoff within timings.suspend, then exits cleanly, as SIGTERM and SIGINT do; a second
   * call gets the same exit.
   */
  stop(reason: string): Promise<ServiceExit>;
}

/** A start refused for a reason a person must fix (X-41). */
class Refusal extends Error {}

/**
 * How teardown ends the agents: a stop without a handoff (a link that ended for good, a refusal, a stop, a signal), or
 * only the kill after an uncaught error.
 */
type AgentsEnd = 'stop' | 'kill';

/** Waits for work up to ms; past that, teardown goes on and the work finishes unobserved. */
async function within(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.max(0, ms));
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Reasons are one line: service-runs.json and runner status show them so. */
function describe(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, ' ');
}

/**
 * Starts the runner; resolves once it runs, or once the service already ended (runner null). It never rejects: a
 * refusal or an error becomes the ServiceExit.
 */
export async function startRunnerService(options: RunnerServiceOptions): Promise<RunnerService> {
  const paths = options.paths ?? runnerPaths();
  const { mode, configDir, agflow } = options;
  const terminal =
    options.terminal ??
    ((line: string) => {
      process.stderr.write(line);
    });
  const print = (line: string) => {
    try {
      terminal(`${line}\n`);
    } catch {
      // A closed terminal must not keep the lock held.
    }
  };
  const exited = Promise.withResolvers<ServiceExit>();
  const initialized = Promise.withResolvers<void>();
  const waiting = new AbortController();
  let lock: RunnerLock | null = null;
  let logger: RotatingLog | null = null;
  let runs: ServiceRuns | null = null;
  let runId: string | null = null;
  let control: ControlServer | null = null;
  let db: RunnerDb | null = null;
  let store: AttemptStore | null = null;
  let runner: RunnerHandle | null = null;
  let ending = false;
  let suspendMs = 0;

  // A person must act: exit 0 under launchd so KeepAlive does not loop, 1 in the foreground.
  const refusal = (reason: string): ServiceExit => ({ code: mode === 'service' ? 0 : 1, clean: true, reason });
  const failure = (error: unknown): ServiceExit => ({ code: 1, clean: false, reason: describe(error) });

  function finish(input: ServiceExit, level: 'info' | 'error', agents: AgentsEnd = 'stop'): Promise<ServiceExit> {
    if (ending) return exited.promise;
    ending = true;
    const deadline = performance.now() + suspendMs;
    waiting.abort();
    void (async () => {
      // A signal can arrive while the lock is awaited or createRunner runs: nothing is released beneath startup.
      await initialized.promise;
      let exit = { ...input, reason: describe(input.reason) };
      const step = async (action: () => unknown) => {
        try {
          await action();
        } catch (error) {
          const failed = failure(error);
          if (exit.clean) exit = failed;
          if (logger) logger.error(failed.reason);
          else print(failed.reason);
        }
      };
      // Every step runs; the lock goes last, so no second runner starts while this one still holds anything.
      const active = runner;
      if (agents === 'stop' && active !== null) {
        // runner.close leaves agents running, and under launchd nothing restarts this runner after a link end or a
        // refusal to recover them (X-41). The hub resends commands held meanwhile after a later welcome.
        await step(async () => {
          active.pause();
          await within(active.stopAgents('runner_stop', { handoff: false }), deadline - performance.now());
        });
      }
      // The backstop: no registered group outlives the lock, whatever a deadline or an error left running.
      await step(async () => {
        if (store !== null) await killRegisteredGroups(store, logger ?? undefined);
      });
      if (logger) logger[level](exit.reason);
      else print(exit.reason);
      await step(() => runner?.close());
      await step(() => control?.stop());
      await step(() => db?.close());
      await step(() => {
        if (runs !== null && runId !== null) runs.finish(runId, exit);
      });
      removeHandlers();
      await step(() => lock?.release());
      exited.resolve(exit);
    })();
    return exited.promise;
  }

  const service: RunnerService = {
    paths,
    mode,
    get runner() {
      return runner;
    },
    exited: exited.promise,
    stop: (reason) => finish({ code: 0, clean: true, reason }, 'info'),
  };

  const onTerm = () => void service.stop('received SIGTERM');
  const onInt = () => void service.stop('received SIGINT');
  // The runner's state is unknown after an uncaught error: its agents are killed, not stopped.
  const onError = (error: unknown) => void finish(failure(error), 'error', 'kill');
  function removeHandlers() {
    if (!options.signals) return;
    process.off('SIGTERM', onTerm);
    process.off('SIGINT', onInt);
    process.off('uncaughtException', onError);
    process.off('unhandledRejection', onError);
  }
  if (options.signals) {
    process.on('SIGTERM', onTerm);
    process.on('SIGINT', onInt);
    process.on('uncaughtException', onError);
    process.on('unhandledRejection', onError);
  }

  // The control socket's routes; the commands of later tasks add theirs here.
  const routes: ControlRoutes = {
    'GET /health': () => {
      const status = runner?.status();
      return {
        pid: process.pid,
        mode,
        startedAt: lock?.owner.startedAt ?? null,
        runnerId: status?.runnerId ?? null,
        link: status?.link ?? 'idle',
      };
    },
  };
  // What the host hears from the runner; the operations of later tasks listen here.
  const events: RunnerEvents = {
    link: (state, detail) => {
      logger?.info('runner link', { state, code: detail.code, reason: detail.reason });
    },
  };

  // Each await may meet a stop: startup then ends early, and finish releases what it made.
  async function start(): Promise<void> {
    lock = await acquireRunnerLock(paths, {
      mode,
      wait: mode === 'service',
      pollMs: options.lockPollMs,
      signal: waiting.signal,
      onWait: (holder) => print(`waiting for runner.lock held by pid ${holder.pid ?? 'unknown'}`),
    });
    if (ending) return;
    logger = new RotatingLog(paths, { foreground: mode === 'foreground', terminal });
    logger.info('runner service starting', { pid: process.pid, mode });
    runs = new ServiceRuns(paths);
    runId = runs.start({ pid: process.pid, mode });
    let config: RunnerConfig;
    try {
      config = loadRunnerConfig(paths.config);
      suspendMs = config.timings.suspend;
    } catch (error) {
      // A missing runner.json already says 'run agflow runner setup'.
      throw new Refusal(describe(error));
    }
    const mismatch = machineMismatch(config, await (options.machineId ?? readMachineId)());
    if (mismatch !== null) throw new Refusal(mismatch);
    if (ending) return;
    control = startControlServer({ paths, lock, routes });
    if (readCliCredentials(configDir) === null) throw new Refusal('not signed in; run agflow login --hub <url>');
    db = openRunnerDb(paths.db);
    store = new AttemptStore(db);
    const adapters = options.adapters ?? (options.createAdapters ?? createAdapters)(config, paths, { agflow });
    runner = await createRunner({
      paths,
      config,
      db,
      credentials: () => readCliCredentials(configDir),
      adapters,
      cliVersion: options.cliVersion,
      agflow,
      logger,
      events,
      fetch: options.fetch,
      tmpRoot: options.tmpRoot,
    });
    void runner.done.then((end) => {
      if (end.kind === 'refused' || end.kind === 'incompatible') return finish(refusal(end.reason), 'error');
      // 4409: another process with this key took over, which is no fault of this one.
      return finish({ code: 0, clean: true, reason: end.reason || 'runner closed' }, 'info');
    }, onError);
  }

  try {
    await start();
  } catch (error) {
    if (error instanceof Refusal) void finish(refusal(error.message), 'error');
    // Nothing recorded: only the lock holder writes the log and service-runs.json.
    else if (error instanceof AlreadyRunningError) void finish({ ...failure(error), clean: true }, 'error');
    else void finish(failure(error), 'error');
  } finally {
    initialized.resolve();
  }
  if (ending) await exited.promise;
  return service;
}
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `bun test packages/runner/test/service/host.test.ts && bun test && bun run typecheck`
Expected: the task's tests pass; then the whole suite passes (`0 fail`) and `tsc` exits 0.

`finish()` is the one exit path. It ends the agents (after a link end or a refusal, `stopAgents('runner_stop', { handoff: false })` bounded by `timings.suspend`; after an uncaught error, none), runs M2b's `killRegisteredGroups` as a backstop, closes the runner, the control socket and runner.db, records the exit and releases the lock last. Every step runs even if one throws. A foreground start that finds the lock held exits 1 and records nothing, because only the lock holder writes the log and service-runs.json. `test/service/run-service.ts` runs the service as a child process for the signal and unclean-exit tests; it reads `AGFLOW_HOME`, `AGFLOW_CONFIG_DIR` and `AGFLOW_SERVICE_MODE`. RunnerServiceOptions.cliVersion is optional and is forwarded unchanged to createRunner. Production leaves it unset and uses M2b's pinnedCliVersion. setupTestService and test/service/run-service.ts pass fixtureCliVersion, so fake-adapter attempts run on Linux too. The host test checks the injected value in AgentLaunch, AttemptRecord and attempt.spawned. M2b suppresses RunnerEvents.welcome for the first welcome of a restored hub and reconnects immediately; the host waits for the next reported welcome and does not count welcomes.

- [ ] **Step 5: Commit**

```bash
git add -A 'packages/runner/src/service/host.ts' 'packages/runner/test/service-helpers.ts' 'packages/runner/test/service/host.test.ts' 'packages/runner/test/service/run-service.ts'
git commit -m 'M2C Task 14: The service host' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

### Task 15: `agflow runner` in the CLI and `start`

Adds `agflow runner` to the CLI, and the CLI's dependency on `@agflow/runner`, which M2c alone adds (design 13, X-44). `runner-command.ts` dispatches the subcommands and holds `RUNNER_HELP`, which main.ts's HELP includes, so later tasks edit only this file. `agflow runner start [--service]` calls `startRunnerService` with `configDir()` and `selfCommand()` and exits with its code. The CLI imports the runner by deep path (`@agflow/runner/src/service/...`) and only when a subcommand runs, so the runner barrel stays M2b's and other commands, the hooks above all, do not load the runner.

**Files:**
- Modify: `packages/cli/package.json`
- Modify: `packages/cli/src/main.ts`
- Create: `packages/cli/src/runner-command.ts`
- Test: `packages/cli/test/runner-command.test.ts`
- Update: `bun.lock` (with `bun install`)

- [ ] **Step 1: Write the failing test**

**File:** `packages/cli/test/runner-command.test.ts` (new)

```ts
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findRunnerByKey } from '@agflow/hub/src/runners';
import { runnerPaths } from '@agflow/runner/src/paths';
import type { RunnerServiceOptions } from '@agflow/runner/src/service/host';
import { readLockOwner } from '@agflow/runner/src/service/lock';
import { readMachineId } from '@agflow/runner/src/service/machine';
import { ServiceRuns } from '@agflow/runner/src/service/runs';
import { waitFor } from '@agflow/runner/test/fixture';
import { afterThisTest, cleanupRunnerSetups, tempDir } from '@agflow/runner/test/runner-setup';
import { setupTestService } from '@agflow/runner/test/service-helpers';
import { parseArgs } from '../src/args';
import { main } from '../src/main';
import { configDir } from '../src/paths';
import { RUNNER_HELP, runnerCommand } from '../src/runner-command';
import { selfCommand } from '../src/self';

const MAIN = join(import.meta.dir, '..', 'src', 'main.ts');

beforeEach(() => {
  for (const name of ['AGFLOW_HOME', 'AGFLOW_CONFIG_DIR']) {
    const previous = process.env[name];
    process.env[name] = tempDir('agflow-cli-');
    afterThisTest(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
  }
});
afterEach(cleanupRunnerSetups);

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (text: string) => void out.push(text), err: (text: string) => void err.push(text) }, out, err };
}

describe('agflow runner', () => {
  for (const argv of [['runner'], ['runner', 'fly'], ['runner', 'constructor']]) {
    test(`${argv.join(' ')} is a usage error listing subcommands`, async () => {
      const { io, out, err } = capture();
      expect(await main(argv, io)).toBe(2);
      expect(err.join('').split('\n')[0]).toContain('start');
      expect(err.join('')).toContain(RUNNER_HELP);
      expect(out).toEqual([]);
    });
  }

  test('help includes the runner commands', async () => {
    const { io, out, err } = capture();
    expect(await main(['help'], io)).toBe(0);
    expect(RUNNER_HELP).toContain('agflow runner start [--service]');
    expect(out.join('')).toContain(RUNNER_HELP);
    expect(err).toEqual([]);
  });

  test('the CLI loads no runner module until a runner subcommand runs', async () => {
    // Every hook call starts the CLI: only `agflow runner` may pay for the runner's module graph.
    const script = `await import(${JSON.stringify(MAIN)});
console.log(JSON.stringify(Object.keys(require.cache).filter((path) => path.includes('/packages/runner/'))));`;
    const child = Bun.spawn([process.execPath, '-e', script], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
    expect(JSON.parse(stdout)).toEqual([]);
  });

  test('start rejects extra positional arguments', async () => {
    const { io, err } = capture();
    expect(await main(['runner', 'start', 'extra'], io)).toBe(2);
    expect(err.join('')).toContain('agflow runner start');
  });

  for (const mode of ['foreground', 'service'] as const) {
    test(`start passes CLI paths, terminal and signals in ${mode} and returns the host exit code`, async () => {
      const { io, out, err } = capture();
      const exit = { code: 3, clean: true, reason: 'x' };
      const startRunnerService = mock(async (options: RunnerServiceOptions) => ({
        paths: runnerPaths(),
        mode: options.mode,
        runner: null,
        exited: Promise.resolve(exit),
        stop: async () => exit,
      }));
      const argv = ['runner', 'start', ...(mode === 'service' ? ['--service'] : [])];
      expect(await runnerCommand(parseArgs(argv), io, { startRunnerService })).toBe(3);
      expect(startRunnerService).toHaveBeenCalledTimes(1);
      expect(startRunnerService).toHaveBeenCalledWith({
        mode,
        configDir: configDir(),
        agflow: selfCommand(),
        terminal: io.err,
        signals: true,
      });
      expect(out).toEqual([]);
      expect(err).toEqual([]);
    });
  }

  test('start says hello to the hub and exits cleanly on SIGTERM', async () => {
    const s = await setupTestService({ config: { machineId: await readMachineId() } });
    const child = Bun.spawn([process.execPath, MAIN, 'runner', 'start'], {
      env: { ...process.env, AGFLOW_HOME: s.paths.home, AGFLOW_CONFIG_DIR: s.configDir },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    afterThisTest(async () => {
      if (child.exitCode === null) child.kill('SIGKILL');
      await child.exited;
    });
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    await waitFor(() => {
      if (child.exitCode !== null) throw new Error(`runner exited before hello (code ${child.exitCode})`);
      return findRunnerByKey(s.hub.ctx, s.config.runnerKey)?.state === 'online';
    });
    expect(readLockOwner(s.paths)).toMatchObject({ pid: child.pid, mode: 'foreground' });
    child.kill('SIGTERM');
    expect(await child.exited).toBe(0);
    expect(new ServiceRuns(s.paths).lastExit({ running: false })).toMatchObject({
      code: 0,
      clean: true,
      reason: 'received SIGTERM',
    });
    expect(readLockOwner(s.paths)).toBeNull();
    expect(existsSync(s.paths.socket)).toBe(false);
    expect(await stdout).toBe('');
    expect(await stderr).toContain('received SIGTERM');
    expect(readFileSync(s.paths.runnerLog, 'utf8')).toContain('received SIGTERM');
  }, 30_000);
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `bun test packages/cli/test/runner-command.test.ts`
Expected: FAIL — `error: Cannot find module '@agflow/runner/src/paths' from 'packages/cli/test/runner-command.test.ts'`: the CLI does not depend on `@agflow/runner` yet (0 pass, 1 fail, 1 error)

- [ ] **Step 3: Implement**

**File:** `packages/cli/package.json` (change)

```diff
diff --git a/packages/cli/package.json b/packages/cli/package.json
index fd7418f8..afb0de18 100644
--- a/packages/cli/package.json
+++ b/packages/cli/package.json
@@ -6,6 +6,7 @@
   "bin": { "agflow": "./src/main.ts" },
   "dependencies": {
     "@agflow/core": "workspace:*",
+    "@agflow/runner": "workspace:*",
     "@modelcontextprotocol/sdk": "1.32.2",
     "zod": "4.6.7"
   },
```

**File:** `packages/cli/src/main.ts` (change)

```diff
diff --git a/packages/cli/src/main.ts b/packages/cli/src/main.ts
index bbe8233f..e7d1b5f2 100644
--- a/packages/cli/src/main.ts
+++ b/packages/cli/src/main.ts
@@ -6,6 +6,7 @@ import { type Io, stdio } from './io';
 import { joinCommand, leaveCommand } from './join';
 import { loginCommand, logoutCommand, statusCommand } from './login';
 import { mcpCommand } from './mcp/server';
+import { RUNNER_HELP, runnerCommand } from './runner-command';
 
 export const HELP = `agflow ${AGFLOW_VERSION}
 
@@ -17,6 +18,8 @@ Usage:
                                 Connect Claude Code and/or Codex chats in this repository
   agflow leave                  Undo agflow join in this repository
 
+Runners:
+${RUNNER_HELP}
 Run by Claude Code and Codex, not by people:
   agflow mcp --vendor claude|codex
   agflow mcp --vendor claude|codex --runner
@@ -34,6 +37,7 @@ const commands: Record<string, Command> = {
   leave: leaveCommand,
   hook: hookCommand,
   mcp: mcpCommand,
+  runner: runnerCommand,
 };
 
 export async function main(argv: string[], io: Io = stdio): Promise<number> {
```

**File:** `packages/cli/src/runner-command.ts` (new)

```ts
// agflow runner … (design 7.1, 13): the runner's commands. The CLI depends on @agflow/runner and imports its service
// modules by deep path, so the runner barrel stays M2b's; the runner never imports the CLI, which passes it the
// agflow command (selfCommand) and the directory of its credentials (configDir). Each subcommand loads its modules
// when it runs: every other command, the hooks Claude Code and Codex run on each prompt above all, must not pay for
// the runner's module graph. A static-string import() is still bundled by `bun build --compile`.
import type { startRunnerService } from '@agflow/runner/src/service/host';
import { type ParsedArgs, UsageError } from './args';
import type { Io } from './io';
import type { Command } from './main';
import { configDir } from './paths';
import { selfCommand } from './self';

/** The runner subcommands' lines in main.ts's HELP; each subcommand adds its own. */
export const RUNNER_HELP = `  agflow runner start [--service]
                                Run this laptop's runner in the foreground (--service for launchd)
`;

export async function runnerCommand(
  args: ParsedArgs,
  io: Io,
  deps: { startRunnerService?: typeof startRunnerService } = {},
): Promise<number> {
  const commands: Record<string, Command> = {
    // The host logs and prints every reason; the exit code is the ServiceExit's.
    start: async (args, io) => {
      if (args.positional.length > 2) throw new UsageError('usage: agflow runner start [--service]');
      const start = deps.startRunnerService ?? (await import('@agflow/runner/src/service/host')).startRunnerService;
      const service = await start({
        mode: args.flags.service === true ? 'service' : 'foreground',
        configDir: configDir(),
        agflow: selfCommand(),
        terminal: io.err,
        signals: true,
      });
      return (await service.exited).code;
    },
  };
  const name = args.positional[1];
  const command = name !== undefined && Object.hasOwn(commands, name) ? commands[name] : undefined;
  if (!command) {
    const reason = name === undefined ? 'agflow runner needs a subcommand' : `unknown runner subcommand "${name}"`;
    throw new UsageError(`${reason}; subcommands: ${Object.keys(commands).join(', ')}`);
  }
  return command(args, io);
}
```

**Install:** run `bun install` from the repository root.

- [ ] **Step 4: Run the tests and see them pass**

Run: `bun test packages/cli/test/runner-command.test.ts && bun test && bun run typecheck`
Expected: the task's tests pass; then the whole suite passes (`0 fail`) and `tsc` exits 0.

A test asserts that loading main.ts pulls in no `packages/runner` module. The child-process test writes runner.json with `readMachineId()`, because the real CLI checks the real machine id; it does not depend on which adapters `createAdapters` returns. Pass selfCommand() unchanged, including all args. Its source form is bun --no-env-file --config=/dev/null <repo>/packages/cli/src/main.ts; its compiled form has no prefix args. The root build:cli disables compile-time bunfig and dotenv autoload.

- [ ] **Step 5: Commit**

```bash
git add -A 'packages/cli/package.json' 'packages/cli/src/main.ts' 'packages/cli/src/runner-command.ts' 'packages/cli/test/runner-command.test.ts' 'bun.lock'
git commit -m 'M2C Task 15: `agflow runner` in the CLI and `start`' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

### Task 16: Operations in the running service

Wires the operations of Tasks 6-13 into the host and checks them against the in-process hub (design 6.10, 7.7, 7.8, 7.9). The host passes `createServiceHealth` as the runner's health (fed by `RunnerEvents.gap`, with guard stops through `stopAgents`), `createMacNotifier` as the notifier, and `createDependencyPreparer` with one shared `PrepSandbox` as the preparer. It drives `KeepAwake` from attempt-state changes and power samples, samples power before the first admission, and runs the retention sweep at start and on an hourly check. The tests inject fake operations (`fakeServiceOperations`), so no service test touches the sandbox runtime, osascript or caffeinate.

**Files:**
- Test: `packages/cli/test/runner-command.test.ts`
- Modify: `packages/runner/src/service/host.ts`
- Test: `packages/runner/test/service-helpers.ts`
- Test: `packages/runner/test/service/operations.test.ts`
- Test: `packages/runner/test/service/run-service.ts`

- [ ] **Step 1: Write the failing tests**

**File:** `packages/cli/test/runner-command.test.ts` (change)

```diff
diff --git a/packages/cli/test/runner-command.test.ts b/packages/cli/test/runner-command.test.ts
index 2bd39ca8..55acba85 100644
--- a/packages/cli/test/runner-command.test.ts
+++ b/packages/cli/test/runner-command.test.ts
@@ -102,9 +102,10 @@ console.log(JSON.stringify(Object.keys(require.cache).filter((path) => path.incl
   }
 
   test('start says hello to the hub and exits cleanly on SIGTERM', async () => {
-    const s = await setupTestService({ config: { machineId: await readMachineId() } });
+    // The real host reads this Mac's free space for its disk guard; test mode keeps its notifier silent.
+    const s = await setupTestService({ config: { machineId: await readMachineId(), minFreeGb: 0 } });
     const child = Bun.spawn([process.execPath, MAIN, 'runner', 'start'], {
-      env: { ...process.env, AGFLOW_HOME: s.paths.home, AGFLOW_CONFIG_DIR: s.configDir },
+      env: { ...process.env, AGFLOW_HOME: s.paths.home, AGFLOW_CONFIG_DIR: s.configDir, AGFLOW_TEST: '1' },
       stdin: 'ignore',
       stdout: 'pipe',
       stderr: 'pipe',
```

**File:** `packages/runner/test/service-helpers.ts` (change)

```diff
diff --git a/packages/runner/test/service-helpers.ts b/packages/runner/test/service-helpers.ts
index d0c658a2..309c78f3 100644
--- a/packages/runner/test/service-helpers.ts
+++ b/packages/runner/test/service-helpers.ts
@@ -19,7 +19,9 @@ import { AttemptStore } from '../src/attempt-store';
 import { type RunnerConfigInput, RunnerConfigSchema, saveRunnerConfig } from '../src/config';
 import { openRunnerDb } from '../src/db';
 import { type RunnerPaths, runnerPaths } from '../src/paths';
+import { PrepSandbox, type SandboxBackend } from '../src/prep/sandbox';
 import { killGroup } from '../src/processes';
+import { standardProfile } from '../src/profile';
 import { removeAgentTools } from '../src/run-dir';
 import { type RunnerServiceOptions, startRunnerService } from '../src/service/host';
 import type { Exec, ExecOptions, ExecResult } from '../src/service/system';
@@ -93,6 +95,7 @@ export async function setupTestService(options: TestServiceOptions = {}) {
       terminal: (line) => terminal.push(line),
       tmpRoot,
       adapters: host.createAdapters ? undefined : fakeServiceAdapters(),
+      ...fakeServiceOperations(),
       ...host,
     });
     afterThisTest(async () => {
@@ -122,6 +125,35 @@ export function fakeServiceAdapters() {
   );
 }
 
+/** Each service gets a fresh manager: sandbox initialization is cached by manager identity. */
+export function fakePrepSandbox(overrides: Partial<SandboxBackend> = {}): PrepSandbox {
+  return new PrepSandbox({
+    allowedDomains: standardProfile.network.allowedDomains,
+    manager: {
+      initialize: async () => {},
+      isSupportedPlatform: () => true,
+      checkDependencies: () => ({ errors: [], warnings: [] }),
+      wrapWithSandboxArgv: async (command) => ({ argv: ['/bin/sh', '-c', command], env: {} }),
+      cleanupAfterCommand: () => {},
+      ...overrides,
+    },
+  });
+}
+
+/** Safe machine operations for both in-process services and the child-process host fixture. */
+export function fakeServiceOperations(): Partial<RunnerServiceOptions> {
+  return {
+    prepSandbox: fakePrepSandbox(),
+    power: async () => ({ source: 'ac', batteryPercent: 100, lowPowerMode: false }),
+    freeBytes: () => 100_000_000_000,
+    usage: { current: () => 1_000_000 },
+    exec: recordingExec(),
+    platform: 'linux',
+    // Fake CLIs use the darwin pin versions on every test host.
+    retentionPlatform: 'darwin-arm64',
+  };
+}
+
 /** The files of setupTestService and a service started on them. */
 export async function startTestService(options: TestServiceOptions = {}) {
   const setup = await setupTestService(options);
```

**File:** `packages/runner/test/service/operations.test.ts` (new)

```ts
// Service operations across the real runner link: machine facts, guards, settings, approvals and daily retention.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { APPROVALS_ROUTE } from '@agflow/core';
import { getAttempt } from '@agflow/hub/src/attempt-store';
import { tx } from '@agflow/hub/src/context';
import { getRunner, patchRunnerSettings } from '@agflow/hub/src/runners';
import { getTask } from '@agflow/hub/src/task-store';
import { createTasks } from '@agflow/hub/src/tasks';
import { newTask } from '@agflow/hub/test/helpers';
import { FakeAdapter, type FakeScript, originRepo } from '@agflow/testkit';
import type { ClockSource } from '../../src/clock';
import { openRunnerDb } from '../../src/db';
import { GB } from '../../src/ops/health';
import type { PowerSample } from '../../src/ops/power';
import { Outbox } from '../../src/outbox';
import { VENDOR_PINS } from '../../src/vendor/pins';
import { waitFor } from '../fixture';
import { startRunnerAttempt, startTestHub } from '../hub-fixture';
import { afterThisTest, cleanupRunnerSetups, tempDir } from '../runner-setup';
import { fakePrepSandbox, recordingExec, setupTestService, startTestService } from '../service-helpers';

afterEach(cleanupRunnerSetups);
setDefaultTimeout(60_000);

type Service = Awaited<ReturnType<typeof startTestService>>;
const ac: PowerSample = { source: 'ac', batteryPercent: 100, lowPowerMode: false };
const waiting: FakeScript = { turns: [[{ do: 'sleep', ms: 120_000 }], [{ do: 'text', text: 'handoff turn' }]] };
const HOUR = 60 * 60_000;

function fakeClock() {
  let now = Date.now();
  const timers = new Map<object, { at: number; ms: number | null; fn: () => void }>();
  const add = (fn: () => void, ms: number, repeat: boolean) => {
    const id = {};
    timers.set(id, { at: now + ms, ms: repeat ? ms : null, fn });
    return id;
  };
  const clear = (id: unknown) => {
    timers.delete(id as object);
  };
  const clock: ClockSource = {
    now: () => now,
    setTimeout: (fn, ms) => add(fn, ms, false),
    setInterval: (fn, ms) => add(fn, ms, true),
    clearTimeout: clear,
    clearInterval: clear,
  };
  return {
    clock,
    pending: () => timers.size,
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        const [id, timer] = next;
        now = timer.at;
        if (timer.ms === null) timers.delete(id);
        else timer.at += timer.ms;
        timer.fn();
      }
      now = end;
    },
  };
}

/** Moves the fake clock an hour at a time, letting each hourly retention check settle. */
async function hours(time: ReturnType<typeof fakeClock>, count: number) {
  for (let i = 0; i < count; i++) {
    time.advance(HOUR);
    await Bun.sleep(5);
  }
}

/** Turns on AGFLOW_TEST=1 for this test: test mode, with the test block, allows short timings. */
function agflowTestEnv() {
  const previous = process.env.AGFLOW_TEST;
  process.env.AGFLOW_TEST = '1';
  afterThisTest(() => {
    if (previous === undefined) delete process.env.AGFLOW_TEST;
    else process.env.AGFLOW_TEST = previous;
  });
}

/** A fake caffeinate that records its pid and holds while the pid it watches lives. */
function fakeCaffeinate() {
  const dir = tempDir('agf-caffeinate-');
  const command = join(dir, 'caffeinate');
  const record = join(dir, 'pids');
  writeFileSync(command, `#!/bin/sh\necho $$ >> '${record}'\nwhile kill -0 "$3" 2>/dev/null; do sleep 0.01; done\n`, {
    mode: 0o755,
  });
  const pids = () => (existsSync(record) ? readFileSync(record, 'utf8').trim().split('\n').map(Number) : []);
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const live = () => pids().filter(alive);
  afterThisTest(() => {
    for (const pid of live()) process.kill(pid, 'SIGKILL');
  });
  return { command, pids, live };
}

async function online(s: Service) {
  await waitFor(() => s.service.runner?.status().link === 'online');
  return s.service.runner!.status().runnerId!;
}

function events(s: Service) {
  const db = openRunnerDb(s.paths.db);
  try {
    return new Outbox(db).eventsAfter(0);
  } finally {
    db.close();
  }
}

function startAttempt(s: Service, runnerId: string) {
  const [task] = createTasks(s.hub.ctx, [newTask()], 'user:alice');
  return startRunnerAttempt(s.hub.ctx, { runnerId, taskId: task!.id, role: 'worker', vendor: 'codex' }).attempt;
}

async function refused(s: Service, runnerId: string, reason: 'disk_low' | 'battery_low' | 'waking') {
  const attempt = startAttempt(s, runnerId);
  await waitFor(() => getAttempt(s.hub.ctx, attempt.id).status === 'ended');
  expect(getAttempt(s.hub.ctx, attempt.id)).toMatchObject({ endReason: 'failed_to_start', failureClass: null });
  expect(events(s)).toContainEqual(expect.objectContaining({
    type: 'attempt.failed_to_start',
    attemptId: attempt.id,
    data: expect.objectContaining({ refused: reason }),
  }));
}

async function stopped(s: Service, ids: string[], messages: string[]) {
  await waitFor(() => ids.every((id) => getAttempt(s.hub.ctx, id).status === 'ended'), 30_000);
  for (const id of ids) {
    const attempt = getAttempt(s.hub.ctx, id);
    expect(attempt).toMatchObject({ endReason: 'stopped', failureClass: 'infra', failureSignature: null });
    expect(getTask(s.hub.ctx, attempt.taskId!)).toMatchObject({ status: 'ready', nextDispatchAt: null });
    expect(events(s).filter((event) => event.type === 'attempt.exited' && event.attemptId === id)).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ cause: 'runner_stop', handoffWritten: false }) }),
    ]);
  }
  // A handoff turn requires a new input to the live session.
  expect(messages).toEqual([]);
}

function waitingAdapter() {
  const messages: string[] = [];
  const adapter = new FakeAdapter({ vendor: 'codex', skipAuthChecks: true, script: waiting });
  const start = adapter.start.bind(adapter);
  adapter.start = async (launch) => {
    const session = await start(launch);
    const send = session.send.bind(session);
    session.send = async (message) => {
      messages.push(message.text);
      await send(message);
    };
    return session;
  };
  return { adapter, messages };
}

test('heartbeats put injected power and disk facts on the hub card', async () => {
  const power: PowerSample = { source: 'battery', batteryPercent: 55, lowPowerMode: true };
  const s = await startTestService({
    host: { power: async () => power, freeBytes: () => 42 * GB, usage: { current: () => 123_456 } },
  });
  const id = await online(s);
  await waitFor(() => getRunner(s.hub.ctx, id).power !== null);
  expect(getRunner(s.hub.ctx, id)).toMatchObject({
    power,
    disk: { freeBytes: 42 * GB, agflowBytes: 123_456 },
    acceptingUntil: null,
  });
});

test('power is sampled before the runner starts, so the first start already sees a low battery', async () => {
  const low: PowerSample = { source: 'battery', batteryPercent: 15, lowPowerMode: false };
  const s = await startTestService({
    host: {
      power: async () => {
        // A slow pmset: a start right after the first welcome must still wait for its answer.
        await Bun.sleep(300);
        return low;
      },
    },
  });
  const id = await online(s);
  await refused(s, id, 'battery_low');
});

test('disk holds refuse starts, stop every attempt without a handoff once, and recover', async () => {
  let free = 20 * GB;
  const { adapter, messages } = waitingAdapter();
  const s = await startTestService({
    config: { capacity: 2, minFreeGb: 10 },
    host: { freeBytes: () => free, adapters: [adapter] },
  });
  const id = await online(s);
  free = 7 * GB;
  await waitFor(() => getRunner(s.hub.ctx, id).state === 'disk_low');
  expect(getRunner(s.hub.ctx, id).acceptingUntil).toBe(s.hub.clock.now() + 2_000);
  expect(events(s)).toContainEqual(expect.objectContaining({
    type: 'runner.state',
    data: expect.objectContaining({ state: 'disk_low' }),
  }));
  await refused(s, id, 'disk_low');
  free = 20 * GB;
  await waitFor(() => getRunner(s.hub.ctx, id).state === 'online');
  const attempts = [startAttempt(s, id), startAttempt(s, id)];
  await waitFor(() => attempts.every((attempt) => getAttempt(s.hub.ctx, attempt.id).status === 'running'));
  await waitFor(() => s.service.runner!.status().attempts.filter((a) => a.phase === 'turn').length === 2);
  free = 4 * GB;
  await stopped(s, attempts.map((attempt) => attempt.id), messages);
  await Bun.sleep(2_100);
  await stopped(s, attempts.map((attempt) => attempt.id), messages);
  expect(s.terminal.filter((line) => line.includes('disk guard stopping agents'))).toHaveLength(1);
  free = 20 * GB;
  await waitFor(() => getRunner(s.hub.ctx, id).state === 'online');
  expect(events(s).filter((event) => event.type === 'runner.state').at(-1)?.data).toEqual({
    state: 'ok',
    detail: null,
  });
});

test('battery at seven percent stops once without a handoff; fifteen percent refuses a start', async () => {
  const time = fakeClock();
  let power = ac;
  const { adapter, messages } = waitingAdapter();
  const s = await startTestService({ host: { clock: time.clock, power: async () => power, adapters: [adapter] } });
  const id = await online(s);
  const attempt = startAttempt(s, id);
  await waitFor(() => getAttempt(s.hub.ctx, attempt.id).status === 'running');
  await waitFor(() => s.service.runner!.status().attempts.some((a) => a.phase === 'turn'));
  power = { source: 'battery', batteryPercent: 7, lowPowerMode: true };
  time.advance(60_000);
  await stopped(s, [attempt.id], messages);
  time.advance(60_000);
  await Bun.sleep(1_100);
  await stopped(s, [attempt.id], messages);
  expect(s.terminal.filter((line) => line.includes('battery guard stopping agents'))).toHaveLength(1);
  power = { ...power, batteryPercent: 15 };
  time.advance(60_000);
  await waitFor(() => getRunner(s.hub.ctx, id).power?.batteryPercent === 15);
  await refused(s, id, 'battery_low');
});

test('one fake caffeinate holds a running attempt and hub settings release it within a heartbeat', async () => {
  const caffeinate = fakeCaffeinate();
  const s = await startTestService({
    host: {
      caffeinate: caffeinate.command,
      adapters: [new FakeAdapter({ vendor: 'codex', skipAuthChecks: true, script: waiting })],
    },
  });
  const id = await online(s);
  const attempt = startAttempt(s, id);
  await waitFor(() => getAttempt(s.hub.ctx, attempt.id).status === 'running' && caffeinate.live().length === 1);
  await Bun.sleep(1_100);
  expect(caffeinate.pids()).toHaveLength(1);
  tx(s.hub.ctx, (emit) => patchRunnerSettings(s.hub.ctx, emit, id, { keepAwake: 'off' }, 'user:alice'));
  await waitFor(() => s.service.runner!.status().settings.keepAwake === 'off');
  await waitFor(() => caffeinate.live().length === 0, 1_200);
  expect(caffeinate.pids()).toHaveLength(1);
});

test('keep-awake follows attempt changes between heartbeats and ends with the service', async () => {
  const caffeinate = fakeCaffeinate();
  const origin = await originRepo({ 'README.md': '# demo\n' });
  afterThisTest(() => origin.remove());
  // Heartbeats 30 s apart and power samples 60 s apart: only the attempt-state events move keep-awake sooner.
  const hub = startTestHub({
    config: { projectName: 'demo', projectRepo: origin.path, heartbeatMs: 30_000, deadLinkMs: 120_000 },
  });
  afterThisTest(() => hub.stop());
  const s = await startTestService({
    hub,
    host: {
      caffeinate: caffeinate.command,
      adapters: [new FakeAdapter({ vendor: 'codex', skipAuthChecks: true, script: waiting })],
    },
  });
  const id = await online(s);
  const first = startAttempt(s, id);
  await waitFor(() => getAttempt(s.hub.ctx, first.id).status === 'running');
  await waitFor(() => caffeinate.live().length === 1, 5_000);
  await s.service.runner!.stopAgents('runner_stop', { handoff: false });
  await waitFor(() => caffeinate.live().length === 0, 5_000);
  const second = startAttempt(s, id);
  await waitFor(() => getAttempt(s.hub.ctx, second.id).status === 'running');
  await waitFor(() => caffeinate.live().length === 1, 5_000);
  await s.service.stop('done');
  expect(caffeinate.live()).toEqual([]);
  expect(caffeinate.pids()).toHaveLength(2);
});

test('a clock gap holds new attempts for wakeHold', async () => {
  agflowTestEnv();
  const s = await startTestService({ config: { timings: { tickGap: 2_000 } } });
  const id = await online(s);
  // A freeze longer than tickGap, as a sleeping Mac gives.
  Bun.sleepSync(3_500);
  await online(s);
  await waitFor(() => getRunner(s.hub.ctx, id).acceptingUntil !== null);
  expect(getRunner(s.hub.ctx, id).acceptingUntil!).toBeLessThanOrEqual(s.hub.clock.now() + s.config.timings.wakeHold);
  await refused(s, id, 'waking');
});

for (const testMode of [false, true]) {
  const name = testMode ? 'is silent in test mode' : 'includes the summary and hub approvals URL';
  test(`approval notification ${name}`, async () => {
    agflowTestEnv();
    const exec = recordingExec();
    const summary = 'Allow the release command';
    const adapter = new FakeAdapter({
      vendor: 'codex',
      skipAuthChecks: true,
      script: { turns: [[{ do: 'approval', kind: 'command', summary }]] },
    });
    const s = await startTestService({
      config: { test: testMode ? { skipAuthChecks: true } : undefined, keepAwake: 'off' },
      host: { exec, platform: 'darwin', adapters: [adapter] },
    });
    const id = await online(s);
    const attempt = startAttempt(s, id);
    await waitFor(() => events(s).some((event) => event.type === 'approval.requested'));
    if (testMode) {
      await Bun.sleep(100);
      expect(exec.calls).toEqual([]);
    } else {
      await waitFor(() => exec.calls.length === 1);
      expect(exec.calls[0]?.argv[0]).toBe('osascript');
      expect(exec.calls[0]?.argv).toContain(`${summary}\n${s.hub.url}${APPROVALS_ROUTE}`);
    }
    await waitFor(() => getAttempt(s.hub.ctx, attempt.id).status === 'running');
  });
}

for (const works of [true, false]) {
  test(`hello dependencyPrep is ${works} after the sandbox self-check`, async () => {
    const s = await startTestService({ host: { prepSandbox: fakePrepSandbox({ isSupportedPlatform: () => works }) } });
    const id = await online(s);
    expect(getRunner(s.hub.ctx, id).profile.dependencyPrep).toBe(works);
  });
}

test('retention sweeps at start and daily however long a sweep takes, and restarts add no sweep', async () => {
  const time = fakeClock();
  const s = await startTestService({ host: { clock: time.clock, now: time.clock.now } });
  await online(s);
  const state = join(s.paths.logs, 'retention.json');
  const sweptAt = () => JSON.parse(readFileSync(state, 'utf8')).sweptAt as number;
  const sweeps = () => s.terminal.filter((line) => line.includes('retention sweep finished')).length;
  await waitFor(() => sweeps() === 1);
  const first = sweptAt();
  expect(first).toBe(time.clock.now());
  const vault = s.service.runner!.vault;
  const consolidate = vault.consolidate.bind(vault);
  vault.consolidate = async (...args) => {
    // A long repack: the clock moves on while the sweep runs.
    time.advance(HOUR / 2);
    return consolidate(...args);
  };
  for (let day = 1; day <= 3; day++) {
    await hours(time, 23);
    expect(sweeps()).toBe(day);
    await hours(time, 1);
    await waitFor(() => sweeps() === day + 1);
    expect(sweptAt()).toBe(first + day * 24 * HOUR);
  }
  await s.service.stop('restart');
  expect(time.pending()).toBe(0);
  // A restart within the day does not sweep; the hourly check sweeps soon after the day is up.
  time.advance(20 * HOUR);
  const restarted = await s.start();
  await waitFor(() => restarted.runner?.status().link === 'online');
  await hours(time, 3);
  expect(sweeps()).toBe(4);
  await hours(time, 1);
  await waitFor(() => sweeps() === 5);
  await restarted.stop('done');
  expect(time.pending()).toBe(0);
});

test('shutdown stops a retention sweep after its step under way, before closing runner.db', async () => {
  const time = fakeClock();
  const s = await startTestService({ host: { clock: time.clock, now: time.clock.now } });
  await online(s);
  await waitFor(() => s.terminal.some((line) => line.includes('retention sweep finished')));
  const state = join(s.paths.logs, 'retention.json');
  const first = JSON.parse(readFileSync(state, 'utf8')).sweptAt;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const vault = s.service.runner!.vault;
  const consolidate = vault.consolidate.bind(vault);
  vault.consolidate = async (...args) => {
    entered.resolve();
    await release.promise;
    return consolidate(...args);
  };
  await hours(time, 24);
  await entered.promise;
  let ended = false;
  const stopping = s.service.stop('during sweep').then((exit) => {
    ended = true;
    return exit;
  });
  try {
    await Bun.sleep(20);
    expect(ended).toBe(false);
    // status reads the host's database, not a separate connection.
    expect(s.service.runner!.status().runnerId).not.toBeNull();
  } finally {
    release.resolve();
    await stopping;
  }
  expect(time.pending()).toBe(0);
  expect(() => s.service.runner!.status()).toThrow();
  // The stopped sweep stays due: the next start finishes it.
  expect(s.terminal.some((line) => line.includes('retention sweep stopped by shutdown'))).toBe(true);
  expect(JSON.parse(readFileSync(state, 'utf8')).sweptAt).toBe(first);
});

test('a retention failure is logged, leaves the service online, and retries at the next hourly check', async () => {
  const time = fakeClock();
  let fail = false;
  const s = await startTestService({
    host: {
      clock: time.clock,
      now: () => {
        if (fail) throw new Error('retention clock unavailable');
        return time.clock.now();
      },
    },
  });
  const id = await online(s);
  await waitFor(() => s.terminal.some((line) => line.includes('retention sweep finished')));
  const state = join(s.paths.logs, 'retention.json');
  const first = JSON.parse(readFileSync(state, 'utf8')).sweptAt;
  fail = true;
  await hours(time, 24);
  await waitFor(() => s.terminal.some((line) => line.includes('retention sweep failed')));
  expect(getRunner(s.hub.ctx, id).state).toBe('online');
  expect(s.service.runner!.status().link).toBe('online');
  fail = false;
  await hours(time, 1);
  await waitFor(() => JSON.parse(readFileSync(state, 'utf8')).sweptAt > first);
  expect(JSON.parse(readFileSync(state, 'utf8')).sweptAt).toBe(time.clock.now());
});


test('the host passes the retention platform independently of the machine operations platform', async () => {
  const s = await setupTestService({ host: { retentionPlatform: 'unpublished-test-platform' } });
  const installed = join(s.paths.vendor, 'codex', VENDOR_PINS['darwin-arm64']!.codex.version);
  mkdirSync(installed, { recursive: true });
  writeFileSync(join(installed, 'codex'), 'fake binary');
  await s.start();
  await waitFor(() => s.terminal.some((line) => line.includes('retention sweep finished')));
  // Retention's existing no-pins rule removes unreferenced installs; native darwin would keep this pin.
  expect(existsSync(installed)).toBe(false);
});
```

**File:** `packages/runner/test/service/run-service.ts` (change)

```diff
diff --git a/packages/runner/test/service/run-service.ts b/packages/runner/test/service/run-service.ts
index 9c89d8b2..0c6338b9 100644
--- a/packages/runner/test/service/run-service.ts
+++ b/packages/runner/test/service/run-service.ts
@@ -5,7 +5,7 @@ import { loadRunnerConfig } from '../../src/config';
 import { runnerPaths } from '../../src/paths';
 import { startRunnerService } from '../../src/service/host';
 import { FIXTURE_AGFLOW, fixtureCliVersion } from '../fixture';
-import { fakeServiceAdapters } from '../service-helpers';
+import { fakeServiceAdapters, fakeServiceOperations } from '../service-helpers';
 
 const paths = runnerPaths();
 const configDir = process.env.AGFLOW_CONFIG_DIR;
@@ -18,6 +18,7 @@ const service = await startRunnerService({
   mode,
   machineId: async () => loadRunnerConfig(paths.config).machineId,
   adapters: fakeServiceAdapters(),
+  ...fakeServiceOperations(),
   agflow: FIXTURE_AGFLOW,
   cliVersion: fixtureCliVersion,
   signals: true,
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `bun test packages/runner/test/service/operations.test.ts packages/cli/test/runner-command.test.ts`
Expected: FAIL — `heartbeats put injected power and disk facts on the hub card`: `error: waited 15000 ms in vain` at `packages/runner/test/service/operations.test.ts:177`; the parent host has not wired the injected operations into the heartbeat. Observed on the current task parent with only this task's test files copied in (2026-11-11).

- [ ] **Step 3: Implement**

**File:** `packages/runner/src/service/host.ts` (change)

```diff
diff --git a/packages/runner/src/service/host.ts b/packages/runner/src/service/host.ts
index 2d4c0496..0d127c7e 100644
--- a/packages/runner/src/service/host.ts
+++ b/packages/runner/src/service/host.ts
@@ -4,18 +4,31 @@
 import { createAdapters } from '../adapters';
 import type { AgflowCommand, VendorAdapter } from '../adapters/types';
 import { AttemptStore } from '../attempt-store';
-import { loadRunnerConfig, type RunnerConfig } from '../config';
+import { type ClockSource, systemClock } from '../clock';
+import { isTestMode, loadRunnerConfig, type RunnerConfig } from '../config';
 import { openRunnerDb, type RunnerDb } from '../db';
 import type { FetchFn } from '../hub-http';
+import { Journal } from '../journal';
+import { createServiceHealth, type ServiceHealth } from '../ops/health';
+import { KeepAwake } from '../ops/keep-awake';
+import type { PowerSample } from '../ops/power';
+import { RETENTION, sweepRetention } from '../ops/retention';
+import { Outbox } from '../outbox';
 import { type RunnerPaths, runnerPaths } from '../paths';
+import { createDependencyPreparer } from '../prep/preparer';
+import { PrepSandbox } from '../prep/sandbox';
+import { standardProfile } from '../profile';
 import { killRegisteredGroups } from '../recovery';
 import { createRunner, type RunnerEvents, type RunnerHandle, type RunnerOptions } from '../runner';
+import type { DependencyPreparer, Notifier } from '../seams';
 import { type ControlRoutes, type ControlServer, startControlServer } from './control';
 import { readCliCredentials } from './credentials';
 import { AlreadyRunningError, acquireRunnerLock, type RunnerLock, type RunnerMode } from './lock';
 import { RotatingLog } from './log';
 import { machineMismatch, readMachineId } from './machine';
+import { createMacNotifier } from './notify';
 import { ServiceRuns } from './runs';
+import { defaultExec, type Exec } from './system';
 
 /** How the service ended: the process exit code, whether the run counts as clean (task 19's guard), and why. */
 export interface ServiceExit {
@@ -50,6 +63,24 @@ export interface RunnerServiceOptions {
   lockPollMs?: number;
   fetch?: FetchFn;
   tmpRoot?: string;
+  /** Operations' timers; runner heartbeats retain their own clock. */
+  clock?: ClockSource;
+  /** Retention's age checks; Date.now by default. */
+  now?: () => number;
+  /** Retention pin table; native vendorPlatform() by default. Tests may install another platform's fake pins. */
+  retentionPlatform?: string;
+  /** Notification command runner; defaultExec by default. */
+  exec?: Exec;
+  /** Notification and keep-awake platform; process.platform by default. */
+  platform?: NodeJS.Platform;
+  /** Machine samplers; pmset, diskFreeBytes and AgflowUsage by default. */
+  power?: () => Promise<PowerSample | null>;
+  freeBytes?: () => number | null;
+  usage?: { current(): number };
+  /** Keep-awake command; /usr/bin/caffeinate on macOS by default. */
+  caffeinate?: string;
+  /** Shared preparation sandbox; checked once at service start. */
+  prepSandbox?: PrepSandbox;
 }
 
 export interface RunnerService {
@@ -125,6 +156,16 @@ export async function startRunnerService(options: RunnerServiceOptions): Promise
   let db: RunnerDb | null = null;
   let store: AttemptStore | null = null;
   let runner: RunnerHandle | null = null;
+  const clock = options.clock ?? systemClock;
+  let health: ServiceHealth | null = null;
+  let keepAwake: KeepAwake | null = null;
+  let notifier: Notifier | null = null;
+  let preparer: DependencyPreparer | null = null;
+  let sandbox: PrepSandbox | null = null;
+  let heartbeatMs: number | null = null;
+  let retentionTimer: unknown = null;
+  let retention: Promise<void> | null = null;
+  const sweeping = new AbortController();
   let ending = false;
   let suspendMs = 0;
 
@@ -137,6 +178,8 @@ export async function startRunnerService(options: RunnerServiceOptions): Promise
     ending = true;
     const deadline = performance.now() + suspendMs;
     waiting.abort();
+    // A retention sweep under way stops before its next step, so teardown waits only for the step it is in.
+    sweeping.abort();
     void (async () => {
       // A signal can arrive while the lock is awaited or createRunner runs: nothing is released beneath startup.
       await initialized.promise;
@@ -152,6 +195,10 @@ export async function startRunnerService(options: RunnerServiceOptions): Promise
         }
       };
       // Every step runs; the lock goes last, so no second runner starts while this one still holds anything.
+      await step(() => {
+        if (retentionTimer !== null) clock.clearInterval(retentionTimer);
+        retentionTimer = null;
+      });
       const active = runner;
       if (agents === 'stop' && active !== null) {
         // runner.close leaves agents running, and under launchd nothing restarts this runner after a link end or a
@@ -168,6 +215,9 @@ export async function startRunnerService(options: RunnerServiceOptions): Promise
       if (logger) logger[level](exit.reason);
       else print(exit.reason);
       await step(() => runner?.close());
+      await step(() => health?.close());
+      await step(() => keepAwake?.close());
+      await step(() => retention);
       await step(() => control?.stop());
       await step(() => db?.close());
       await step(() => {
@@ -221,11 +271,16 @@ export async function startRunnerService(options: RunnerServiceOptions): Promise
       };
     },
   };
-  // What the host hears from the runner; the operations of later tasks listen here.
+  // One observer object keeps operations attached across reconnects.
   const events: RunnerEvents = {
     link: (state, detail) => {
       logger?.info('runner link', { state, code: detail.code, reason: detail.reason });
     },
+    gap: (gap) => health?.gap(gap),
+    welcome: (welcome) => {
+      heartbeatMs = welcome.timings.heartbeatMs;
+    },
+    attemptState: () => keepAwake?.evaluate(),
   };
 
   // Each await may meet a stop: startup then ends early, and finish releases what it made.
@@ -258,6 +313,41 @@ export async function startRunnerService(options: RunnerServiceOptions): Promise
     db = openRunnerDb(paths.db);
     store = new AttemptStore(db);
     const adapters = options.adapters ?? (options.createAdapters ?? createAdapters)(config, paths, { agflow });
+    health = createServiceHealth({
+      paths,
+      config: () => config,
+      heartbeatMs: () => heartbeatMs ?? config.timings.heartbeat,
+      stopAgents: (cause, options) => {
+        if (runner === null) throw new Error('the runner is not running yet');
+        return runner.stopAgents(cause, options);
+      },
+      onSample: () => keepAwake?.evaluate(),
+      samplePower: options.power,
+      freeBytes: options.freeBytes,
+      usage: options.usage,
+      clock,
+      logger,
+    });
+    keepAwake = new KeepAwake({
+      mode: () => runner?.status().settings.keepAwake ?? config.keepAwake,
+      power: () => health?.power() ?? null,
+      attempts: () => runner?.status().attempts ?? [],
+      command: options.caffeinate,
+      platform: options.platform,
+      clock,
+      logger,
+    });
+    notifier = createMacNotifier(options.exec ?? defaultExec, {
+      testMode: isTestMode(config),
+      logger,
+      platform: options.platform,
+    });
+    sandbox =
+      options.prepSandbox ?? new PrepSandbox({ allowedDomains: standardProfile.network.allowedDomains, logger });
+    preparer = await createDependencyPreparer({ paths, store, config: () => config, logger, sandbox });
+    // A sample before the runner starts: the first admission and the first heartbeat already see the battery.
+    await health.sample();
+    if (ending) return;
     runner = await createRunner({
       paths,
       config,
@@ -266,11 +356,42 @@ export async function startRunnerService(options: RunnerServiceOptions): Promise
       adapters,
       cliVersion: options.cliVersion,
       agflow,
+      health,
+      notifier,
+      preparer,
       logger,
       events,
       fetch: options.fetch,
       tmpRoot: options.tmpRoot,
     });
+    health.start();
+    keepAwake.evaluate();
+    const retentionInput = {
+      paths,
+      outbox: new Outbox(db),
+      journal: new Journal(db),
+      store,
+      vaults: [runner.vault],
+      adapters: new Map(adapters.map((adapter) => [adapter.vendor, adapter])),
+      eventRetentionMs: config.timings.eventRetention,
+      now: options.now,
+      platform: options.retentionPlatform,
+      logger,
+      signal: sweeping.signal,
+    };
+    const sweep = () => {
+      if (ending || retention !== null) return;
+      retention = sweepRetention(retentionInput)
+        .then((result) => {
+          if (result.ran) logger?.info('retention sweep finished', { ...result });
+        })
+        .catch((error) => logger?.error('retention sweep failed', { error: describe(error) }))
+        .finally(() => {
+          retention = null;
+        });
+    };
+    sweep();
+    retentionTimer = clock.setInterval(sweep, RETENTION.checkIntervalMs);
     void runner.done.then((end) => {
       if (end.kind === 'refused' || end.kind === 'incompatible') return finish(refusal(end.reason), 'error');
       // 4409: another process with this key took over, which is no fault of this one.
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `bun test packages/runner/test/service/operations.test.ts packages/cli/test/runner-command.test.ts packages/runner/test/service/host.test.ts && bun test && bun run typecheck`
Expected: the task's tests pass; then the whole suite passes (`0 fail`) and `tsc` exits 0.

Teardown clears the retention timer, aborts a sweep under way before its next step, and waits for the step it is in before runner.db closes. The health's `stopAgents` does nothing once the service is ending. The fake `PrepSandbox` gets a new manager each time, because initialisation is cached per manager. RunnerServiceOptions.retentionPlatform selects the retention pin table and defaults to vendorPlatform() inside sweepRetention. It is independent of the notification/keep-awake platform. fakeServiceOperations uses darwin-arm64 for retention because its fake CLIs use those pin versions on every host. This keeps setup and uninstall tests platform-neutral while preserving all existing retention rules. The host passes the option to every sweep.

- [ ] **Step 5: Commit**

```bash
git add -A 'packages/cli/test/runner-command.test.ts' 'packages/runner/src/service/host.ts' 'packages/runner/test/service-helpers.ts' 'packages/runner/test/service/operations.test.ts' 'packages/runner/test/service/run-service.ts'
git commit -m 'M2C Task 16: Operations in the running service' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

### Task 17: SIGTERM means suspend

launchd restarts, logout and upgrades send SIGTERM, and SIGTERM means suspend (design 7.1, 6.4, X-41); so does SIGINT, and SIGHUP in the foreground. `suspendRunner` pauses M2b's command executor, runs `stopAgents('suspend', { handoff: false })` (oldest unpushed work first) and waits for the ack of the last `attempt.exited`, all within `timings.suspend` (45 s); then the service exits 0 with a clean run. The hub keeps the attempts open and resumes them on the next hello. `POST /suspend` starts the same path, which `restart` uses.

**Files:**
- Test: `packages/cli/test/run-runner-start.ts`
- Test: `packages/cli/test/runner-command.test.ts`
- Modify: `packages/runner/src/service/host.ts`
- Create: `packages/runner/src/service/suspend.ts`
- Test: `packages/runner/test/service-helpers.ts`
- Test: `packages/runner/test/service/run-service.ts`
- Test: `packages/runner/test/service/suspend.test.ts`

- [ ] **Step 1: Write the failing tests**

**File:** `packages/cli/test/run-runner-start.ts` (new)

```ts
// A child `agflow runner start` for signal tests: the CLI's command path with the process handlers on, over a fake
// agent that sleeps and the safe machine operations, so the child never touches the real machine.
import { loadRunnerConfig } from '@agflow/runner/src/config';
import { runnerPaths } from '@agflow/runner/src/paths';
import { startRunnerService } from '@agflow/runner/src/service/host';
import { FIXTURE_AGFLOW, fixtureCliVersion } from '@agflow/runner/test/fixture';
import { fakeServiceOperations, sleepingServiceAdapter } from '@agflow/runner/test/service-helpers';
import { parseArgs } from '../src/args';
import { stdio } from '../src/io';
import { runnerCommand } from '../src/runner-command';

const code = await runnerCommand(parseArgs(['runner', 'start', ...process.argv.slice(2)]), stdio, {
  startRunnerService: (options) =>
    startRunnerService({
      ...options,
      ...fakeServiceOperations(),
      machineId: async () => loadRunnerConfig(runnerPaths().config).machineId,
      agflow: FIXTURE_AGFLOW,
      cliVersion: fixtureCliVersion,
      adapters: [sleepingServiceAdapter()],
    }),
});
process.exit(code);
```

**File:** `packages/cli/test/runner-command.test.ts` (change)

```diff
diff --git a/packages/cli/test/runner-command.test.ts b/packages/cli/test/runner-command.test.ts
index 55acba85..34312269 100644
--- a/packages/cli/test/runner-command.test.ts
+++ b/packages/cli/test/runner-command.test.ts
@@ -1,13 +1,19 @@
 import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
 import { existsSync, readFileSync } from 'node:fs';
 import { join } from 'node:path';
+import { getAttempt } from '@agflow/hub/src/attempt-store';
 import { findRunnerByKey } from '@agflow/hub/src/runners';
+import { createTasks } from '@agflow/hub/src/tasks';
+import { newTask } from '@agflow/hub/test/helpers';
+import { openRunnerDb } from '@agflow/runner/src/db';
+import { Outbox } from '@agflow/runner/src/outbox';
 import { runnerPaths } from '@agflow/runner/src/paths';
 import type { RunnerServiceOptions } from '@agflow/runner/src/service/host';
 import { readLockOwner } from '@agflow/runner/src/service/lock';
 import { readMachineId } from '@agflow/runner/src/service/machine';
 import { ServiceRuns } from '@agflow/runner/src/service/runs';
 import { waitFor } from '@agflow/runner/test/fixture';
+import { startRunnerAttempt } from '@agflow/runner/test/hub-fixture';
 import { afterThisTest, cleanupRunnerSetups, tempDir } from '@agflow/runner/test/runner-setup';
 import { setupTestService } from '@agflow/runner/test/service-helpers';
 import { parseArgs } from '../src/args';
@@ -84,6 +90,7 @@ console.log(JSON.stringify(Object.keys(require.cache).filter((path) => path.incl
         mode: options.mode,
         runner: null,
         exited: Promise.resolve(exit),
+        suspend: async () => exit,
         stop: async () => exit,
       }));
       const argv = ['runner', 'start', ...(mode === 'service' ? ['--service'] : [])];
@@ -134,4 +141,67 @@ console.log(JSON.stringify(Object.keys(require.cache).filter((path) => path.incl
     expect(await stderr).toContain('received SIGTERM');
     expect(readFileSync(s.paths.runnerLog, 'utf8')).toContain('received SIGTERM');
   }, 30_000);
+
+  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
+    for (const mode of ['foreground', 'service'] as const) {
+      // Only a foreground runner has a terminal to close.
+      if (signal === 'SIGHUP' && mode === 'service') continue;
+      test(`start suspends a running attempt on ${signal} in ${mode} and exits 0 with a clean run`, async () => {
+        const s = await setupTestService();
+        const flags = mode === 'service' ? ['--service'] : [];
+        const child = Bun.spawn([process.execPath, join(import.meta.dir, 'run-runner-start.ts'), ...flags], {
+          env: { ...process.env, AGFLOW_HOME: s.paths.home, AGFLOW_CONFIG_DIR: s.configDir },
+          stdin: 'ignore',
+          stdout: 'pipe',
+          stderr: 'pipe',
+        });
+        afterThisTest(async () => {
+          if (child.exitCode === null) child.kill('SIGKILL');
+          await child.exited;
+        });
+        const stdout = new Response(child.stdout).text();
+        const stderr = new Response(child.stderr).text();
+        const row = await waitFor(() => {
+          if (child.exitCode !== null) throw new Error(`runner exited before hello (code ${child.exitCode})`);
+          const row = findRunnerByKey(s.hub.ctx, s.config.runnerKey);
+          return row?.state === 'online' ? row : null;
+        });
+        const [task] = createTasks(s.hub.ctx, [newTask()], 'user:alice');
+        const { attempt } = startRunnerAttempt(s.hub.ctx, {
+          runnerId: row.id,
+          taskId: task!.id,
+          role: 'worker',
+          vendor: 'codex',
+        });
+        await waitFor(() => getAttempt(s.hub.ctx, attempt.id).status === 'running');
+        child.kill(signal);
+        expect(await child.exited).toBe(0);
+        const db = openRunnerDb(s.paths.db);
+        const exits = (() => {
+          try {
+            return new Outbox(db).eventsAfter(0).filter((event) => event.type === 'attempt.exited');
+          } finally {
+            db.close();
+          }
+        })();
+        expect(exits).toEqual([
+          expect.objectContaining({
+            attemptId: attempt.id,
+            data: expect.objectContaining({ cause: 'suspend', handoffWritten: false }),
+          }),
+        ]);
+        expect(new ServiceRuns(s.paths).lastExit({ running: false })).toMatchObject({
+          code: 0,
+          clean: true,
+          reason: `received ${signal}`,
+        });
+        expect(readLockOwner(s.paths)).toBeNull();
+        expect(existsSync(s.paths.socket)).toBe(false);
+        const log = readFileSync(s.paths.runnerLog, 'utf8');
+        expect(log.indexOf('runner suspend finished')).toBeLessThan(log.indexOf(`info received ${signal}`));
+        expect(await stdout).toBe('');
+        await stderr;
+      }, 60_000);
+    }
+  }
 });
```

**File:** `packages/runner/test/service-helpers.ts` (change)

```diff
diff --git a/packages/runner/test/service-helpers.ts b/packages/runner/test/service-helpers.ts
index 309c78f3..2631ef02 100644
--- a/packages/runner/test/service-helpers.ts
+++ b/packages/runner/test/service-helpers.ts
@@ -125,6 +125,15 @@ export function fakeServiceAdapters() {
   );
 }
 
+/** A fake Codex agent whose turn sleeps for two minutes: an attempt that runs until something stops it. */
+export function sleepingServiceAdapter() {
+  return new FakeAdapter({
+    vendor: 'codex',
+    skipAuthChecks: true,
+    script: { turns: [[{ do: 'sleep', ms: 120_000 }]] },
+  });
+}
+
 /** Each service gets a fresh manager: sandbox initialization is cached by manager identity. */
 export function fakePrepSandbox(overrides: Partial<SandboxBackend> = {}): PrepSandbox {
   return new PrepSandbox({
```

**File:** `packages/runner/test/service/run-service.ts` (change)

```diff
diff --git a/packages/runner/test/service/run-service.ts b/packages/runner/test/service/run-service.ts
index 0c6338b9..37cec840 100644
--- a/packages/runner/test/service/run-service.ts
+++ b/packages/runner/test/service/run-service.ts
@@ -1,6 +1,7 @@
-// A child-process service for tests (host.test.ts, and task 17's suspend): the fake adapters on the AGFLOW_HOME and
-// AGFLOW_CONFIG_DIR its parent prepared, with the process handlers on. It prints 'online' once the hub has it, and
-// AGFLOW_TEST_FAILURE=exception|rejection then throws, so the parent can check the unclean exit.
+// A child-process service for host.test.ts (the CLI's signal tests use packages/cli/test/run-runner-start.ts): the
+// fake adapters on the AGFLOW_HOME and AGFLOW_CONFIG_DIR its parent prepared, with the process handlers on. It prints
+// 'online' once the hub has it, and AGFLOW_TEST_FAILURE=exception|rejection then throws, so the parent can check the
+// unclean exit.
 import { loadRunnerConfig } from '../../src/config';
 import { runnerPaths } from '../../src/paths';
 import { startRunnerService } from '../../src/service/host';
```

**File:** `packages/runner/test/service/suspend.test.ts` (new)

```ts
// Suspend owns the deadline and command pause; M2b owns each agent's stop and final work.
import { afterEach, beforeEach, expect, mock, setDefaultTimeout, spyOn, test } from 'bun:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunnerMessage } from '@agflow/core';
import { getAttempt } from '@agflow/hub/src/attempt-store';
import { findCommand, pendingCommands } from '@agflow/hub/src/commands';
import { tx } from '@agflow/hub/src/context';
import { patchRunnerSettings } from '@agflow/hub/src/runners';
import { createTasks } from '@agflow/hub/src/tasks';
import { newTask } from '@agflow/hub/test/helpers';
import { FakeAdapter, gitIn } from '@agflow/testkit';
import { systemClock } from '../../src/clock';
import { openRunnerDb, type RunnerDb } from '../../src/db';
import { Journal } from '../../src/journal';
import { memoryLogger } from '../../src/log';
import { RETENTION } from '../../src/ops/retention';
import { Outbox } from '../../src/outbox';
import type { RunnerHandle, RunnerStatus } from '../../src/runner';
import { controlRequest } from '../../src/service/control';
import type { RunnerService } from '../../src/service/host';
import { readLockOwner } from '../../src/service/lock';
import { ServiceRuns } from '../../src/service/runs';
import { suspendRunner } from '../../src/service/suspend';
import { waitFor } from '../fixture';
import { startRunnerAttempt } from '../hub-fixture';
import { afterThisTest, cleanupRunnerSetups, tempDir } from '../runner-setup';
import { setupTestService, startTestService } from '../service-helpers';

afterEach(cleanupRunnerSetups);
setDefaultTimeout(60_000);
beforeEach(() => {
  const previous = process.env.AGFLOW_TEST;
  process.env.AGFLOW_TEST = '1';
  afterThisTest(() => {
    if (previous === undefined) delete process.env.AGFLOW_TEST;
    else process.env.AGFLOW_TEST = previous;
  });
});

type Setup = Awaited<ReturnType<typeof setupTestService>>;
type SuspendHandle = Pick<RunnerHandle, 'pause' | 'stopAgents' | 'waitAcked' | 'status'>;

function handle() {
  const status: RunnerStatus = {
    runnerId: 'R-1',
    link: 'online',
    state: { state: 'ok', detail: null },
    settings: { capacity: 2, keepAwake: 'off', draining: false, ceilings: {}, allowPaidUsage: {} },
    vendors: [],
    git: { ready: true, problem: null, lastPushAt: null },
    attempts: [],
  };
  return {
    pause: mock(() => {}),
    stopAgents: mock(async () => [3, 7]),
    waitAcked: mock(async (_seq: number, _ms: number) => true),
    status: () => status,
  } satisfies SuspendHandle;
}

function readDb<T>(s: Setup, read: (db: RunnerDb) => T): T {
  const db = openRunnerDb(s.paths.db);
  try {
    return read(db);
  } finally {
    db.close();
  }
}

const events = (s: Setup) => readDb(s, (db) => new Outbox(db).eventsAfter(0));
const exits = (s: Setup) => events(s).filter((event) => event.type === 'attempt.exited');
const lastExit = (s: Setup) => new ServiceRuns(s.paths).lastExit({ running: false });

async function online(service: RunnerService) {
  if (service.runner === null) throw new Error(`service did not start: ${(await service.exited).reason}`);
  await waitFor(() => service.runner?.status().link === 'online');
  return service.runner!.status().runnerId!;
}

function waitingAdapter() {
  return new FakeAdapter({
    vendor: 'codex',
    skipAuthChecks: true,
    script: { turns: [[{ do: 'sleep', ms: 120_000 }], [{ do: 'text', text: 'unexpected handoff' }]] },
  });
}

function startAttempt(s: Setup, runnerId: string) {
  const [task] = createTasks(s.hub.ctx, [newTask()], 'user:alice');
  return startRunnerAttempt(s.hub.ctx, { runnerId, taskId: task!.id, role: 'worker', vendor: 'codex' }).attempt;
}

function observeHellos() {
  const hellos: Extract<RunnerMessage, { t: 'hello' }>[] = [];
  const send = WebSocket.prototype.send;
  const observer = spyOn(WebSocket.prototype, 'send').mockImplementation(function (this: WebSocket, data) {
    if (typeof data === 'string') {
      const message = JSON.parse(data) as RunnerMessage;
      if (message.t === 'hello') hellos.push(message);
    }
    return send.call(this, data);
  });
  afterThisTest(() => observer.mockRestore());
  return hellos;
}

test('pauses before stopping without a handoff, then acks the final exit with the remaining budget', async () => {
  const runner = handle();
  let now = 100;
  runner.stopAgents.mockImplementation(async () => {
    expect(runner.pause).toHaveBeenCalledTimes(1);
    now += 30;
    return [3, 7];
  });
  const result = await suspendRunner(runner, { deadlineMs: 80, logger: memoryLogger(), now: () => now });
  expect(runner.stopAgents).toHaveBeenCalledWith('suspend', { handoff: false });
  expect(runner.waitAcked).toHaveBeenCalledWith(7, 50);
  expect(result).toMatchObject({ seqs: [3, 7], acked: true, deadlinePassed: false });
});

test('does not wait for acks while offline or when no attempt exited', async () => {
  for (const offline of [true, false]) {
    const runner = handle();
    if (offline) runner.status().link = 'backoff';
    else runner.stopAgents.mockResolvedValue([]);
    expect(await suspendRunner(runner, { deadlineMs: 100, logger: memoryLogger() })).toMatchObject({
      acked: null,
      deadlinePassed: false,
    });
    expect(runner.waitAcked).not.toHaveBeenCalled();
  }
});

test('a lost link releases an ack wait without spending the rest of the deadline', async () => {
  const runner = handle();
  runner.waitAcked.mockImplementation(async () => {
    runner.status().link = 'backoff';
    return false;
  });
  const result = await suspendRunner(runner, { deadlineMs: 5_000, logger: memoryLogger() });
  expect(result).toMatchObject({ acked: false, deadlinePassed: false });
  expect(runner.waitAcked).toHaveBeenCalledTimes(1);
});

test('bounds both a hanging stop and a hanging ack, and consumes a late rejection', async () => {
  for (const stage of ['stop', 'ack'] as const) {
    const runner = handle();
    const pending = Promise.withResolvers<never>();
    if (stage === 'stop') runner.stopAgents.mockImplementation(() => pending.promise);
    else runner.waitAcked.mockImplementation(() => pending.promise);
    const logger = memoryLogger();
    const start = performance.now();
    const result = await suspendRunner(runner, { deadlineMs: 40, logger });
    expect(result.deadlinePassed).toBe(true);
    expect(performance.now() - start).toBeGreaterThanOrEqual(30);
    expect(performance.now() - start).toBeLessThan(500);
    expect(logger.entries.some((entry) => entry.message.includes('deadline'))).toBe(true);
    pending.reject(new Error('late failure'));
    await Bun.sleep(10);
  }
});

test('logs failures and never rejects', async () => {
  for (const stage of ['pause', 'stopAgents', 'status', 'waitAcked'] as const) {
    const runner: SuspendHandle = handle();
    runner[stage] = () => {
      throw new Error(`${stage} failed`);
    };
    const logger = memoryLogger();
    const result = await suspendRunner(runner, { deadlineMs: 100, logger });
    expect(result.deadlinePassed).toBe(false);
    expect(logger.entries.some((entry) => entry.fields.error === `${stage} failed`)).toBe(true);
  }
});

test('suspends two attempts after their pushes, oldest WIP first, then reports and resumes both on hello', async () => {
  const adapter = waitingAdapter();
  const s = await startTestService({ config: { capacity: 2 }, host: { adapters: [adapter] } });
  const runner = s.service.runner!;
  const id = await online(s.service);
  const first = startAttempt(s, id);
  await waitFor(() => runner.status().attempts.some((a) => a.attemptId === first.id && a.phase === 'turn'));
  const second = startAttempt(s, id);
  await waitFor(() => runner.status().attempts.filter((a) => a.phase === 'turn').length === 2);
  for (const launch of adapter.launches) writeFileSync(join(launch.clone, 'initial.txt'), 'initial WIP\n');
  await runner.pushWipNow();
  const firstClone = adapter.launches.find((launch) => launch.attemptId === first.id)!.clone;
  writeFileSync(join(firstClone, 'recent.txt'), 'new WIP\n');
  await runner.pushWipNow();
  const pushed = runner.status().attempts;
  expect(pushed.find((a) => a.attemptId === first.id)!.lastPushAt!).toBeGreaterThan(
    pushed.find((a) => a.attemptId === second.id)!.lastPushAt!,
  );
  for (const launch of adapter.launches) writeFileSync(join(launch.clone, 'final.txt'), `${launch.attemptId}\n`);
  const exit = await s.service.suspend('upgrade');
  expect(exit).toEqual({ code: 0, clean: true, reason: 'upgrade' });
  expect(lastExit(s)).toMatchObject(exit);
  expect(exits(s).map((event) => event.attemptId)).toEqual([second.id, first.id]);
  for (const event of exits(s)) {
    expect(event.data).toMatchObject({ cause: 'suspend', handoffWritten: false, pushError: null });
    expect(event.data.finalWip).not.toBeNull();
    const final = event.data.finalWip!;
    expect((await gitIn(s.hub.ctx.config.projectRepo, ['rev-parse', final.ref])).trim()).toBe(final.sha);
    expect(
      events(s).some(
        (e) =>
          e.type === 'attempt.wip' && e.attemptId === event.attemptId && e.seq < event.seq && e.data.sha === final.sha,
      ),
    ).toBe(true);
    expect(getAttempt(s.hub.ctx, event.attemptId!)).toMatchObject({ status: 'running', wipSha: final.sha });
  }
  expect(readDb(s, (db) => new Outbox(db).ackedSeq())).toBeGreaterThanOrEqual(exits(s).at(-1)!.seq);
  const hellos = observeHellos();
  const resumed = waitingAdapter();
  const next = await s.start({ adapters: [resumed] });
  await online(next);
  for (const attempt of [first, second]) {
    expect(hellos[0]!.attempts).toContainEqual(
      expect.objectContaining({
        attemptId: attempt.id,
        state: 'suspended',
        clone: true,
      }),
    );
    await waitFor(() => getAttempt(s.hub.ctx, attempt.id).status === 'running');
    expect(getAttempt(s.hub.ctx, attempt.id).fence.counter).toBeGreaterThan(attempt.fence.counter);
  }
  await waitFor(() => resumed.launches.length === 2);
  expect(resumed.launches.every((launch) => launch.resume !== null)).toBe(true);
  await next.suspend('done');
});

test('control suspend answers at once; concurrent stops join it and arriving commands stay unjournaled', async () => {
  let free = 100_000_000_000;
  const s = await startTestService({ host: { freeBytes: () => free } });
  const runner = s.service.runner!;
  const id = await online(s.service);
  const release = Promise.withResolvers<number[]>();
  const stopping = mock(() => release.promise);
  runner.stopAgents = stopping;
  try {
    expect(await controlRequest(s.paths, 'POST', '/suspend')).toBeNull();
    expect(stopping).toHaveBeenCalledWith('suspend', { handoff: false });
    expect(readLockOwner(s.paths)).not.toBeNull();
    const joined = s.service.stop('too late');
    expect(s.service.suspend('also too late')).toBe(joined);
    free = 0;
    runner.status();
    await Bun.sleep(20);
    expect(stopping).toHaveBeenCalledTimes(1);
    tx(s.hub.ctx, (emit) => patchRunnerSettings(s.hub.ctx, emit, id, { capacity: 3 }, 'user:alice'));
    const command = pendingCommands(s.hub.ctx, id, 1).find((c) => c.kind === 'update_settings')!;
    await waitFor(() => findCommand(s.hub.ctx, command.id)?.sentAt !== null);
    await Bun.sleep(100);
    expect(readDb(s, (db) => new Journal(db).get(command.id))).toBeNull();
    expect(runner.status().settings.capacity).toBe(s.config.capacity);
    release.resolve([]);
    expect(await joined).toEqual({ code: 0, clean: true, reason: 'suspend requested' });
    free = 100_000_000_000;
    const next = await s.start();
    await online(next);
    await waitFor(() => findCommand(s.hub.ctx, command.id)?.status === 'done');
    expect(readDb(s, (db) => new Journal(db).get(command.id))?.state).toBe('done');
    expect(next.runner!.status().settings.capacity).toBe(3);
  } finally {
    release.resolve([]);
  }
});

test('a final push that hangs past the deadline does not delay the exit; the hub resumes the attempt in its clone', async () => {
  const adapter = waitingAdapter();
  // The stop reaches the push after the agent's interrupt and group signal, about a second in.
  const suspend = 3_000;
  const s = await startTestService({ config: { timings: { suspend } }, host: { adapters: [adapter] } });
  const id = await online(s.service);
  const attempt = startAttempt(s, id);
  await waitFor(() => s.service.runner!.status().attempts.some((a) => a.phase === 'turn'));
  const clone = adapter.launches[0]!.clone;
  writeFileSync(join(clone, 'final.txt'), 'unpushed\n');
  // M2b's real stop path runs; the origin holds its final WIP push until the test releases it, then refuses it.
  const gate = tempDir('agf-hook-');
  const hook = join(s.hub.ctx.config.projectRepo, 'hooks', 'pre-receive');
  writeFileSync(
    hook,
    `#!/bin/sh\ntouch '${gate}/entered'\nwhile [ ! -e '${gate}/release' ]; do sleep 0.05; done\nexit 1\n`,
    { mode: 0o755 },
  );
  const release = () => {
    rmSync(hook, { force: true });
    writeFileSync(join(gate, 'release'), '');
  };
  afterThisTest(release);
  const runner = s.service.runner!;
  const stopAgents = runner.stopAgents.bind(runner);
  let stopping: Promise<unknown> = Promise.resolve();
  runner.stopAgents = (cause, options) => {
    const stop = stopAgents(cause, options);
    stopping = stop.catch(() => {});
    return stop;
  };
  const start = performance.now();
  expect(await s.service.suspend('deadline')).toEqual({
    code: 0,
    clean: true,
    reason: 'deadline',
  });
  expect(performance.now() - start).toBeLessThan(suspend + 1_500);
  expect(existsSync(join(gate, 'entered'))).toBe(true);
  expect(lastExit(s)).toMatchObject({ code: 0, clean: true });
  expect(readLockOwner(s.paths)).toBeNull();
  expect(readFileSync(s.paths.runnerLog, 'utf8')).toContain('"deadlinePassed":true');
  expect(exits(s)).toEqual([]);
  // The leftover stop ends against a closed runner before the next start opens the same clone.
  release();
  await stopping;
  const hellos = observeHellos();
  const resumed = waitingAdapter();
  const next = await s.start({ adapters: [resumed] });
  await online(next);
  expect(hellos[0]!.attempts).toContainEqual(
    expect.objectContaining({
      attemptId: attempt.id,
      state: 'stopped',
      clone: true,
    }),
  );
  await waitFor(() => resumed.launches.length === 1 && getAttempt(s.hub.ctx, attempt.id).status === 'running');
  expect(resumed.launches[0]!.clone).toBe(clone);
  expect(readFileSync(join(clone, 'final.txt'), 'utf8')).toBe('unpushed\n');
  expect(getAttempt(s.hub.ctx, attempt.id).fence.counter).toBeGreaterThan(attempt.fence.counter);
});

test('an empty suspend still answers the control request; a prior stop retains its reason', async () => {
  const s = await startTestService();
  await online(s.service);
  expect(await controlRequest(s.paths, 'POST', '/suspend')).toBeNull();
  expect(await s.service.exited).toEqual({ code: 0, clean: true, reason: 'suspend requested' });
  const next = await s.start();
  await online(next);
  const stop = next.stop('plain stop');
  expect(next.suspend('too late')).toBe(stop);
  expect(await stop).toEqual({ code: 0, clean: true, reason: 'plain stop' });
});

test('teardown does not wait past the suspend budget for an in-flight retention consolidation', async () => {
  let now = Date.now();
  let sweep = () => {};
  const s = await startTestService({
    config: { timings: { suspend: 60 } },
    host: {
      now: () => now,
      clock: {
        ...systemClock,
        setInterval: (fn, ms) => {
          if (ms === RETENTION.checkIntervalMs) sweep = fn;
          return systemClock.setInterval(fn, ms);
        },
      },
    },
  });
  await online(s.service);
  await waitFor(() => s.terminal.some((line) => line.includes('retention sweep finished')));
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<{ pruned: boolean }>();
  s.service.runner!.vault.consolidate = () => {
    entered.resolve();
    return release.promise;
  };
  now += RETENTION.sweepIntervalMs;
  sweep();
  try {
    await entered.promise;
    const start = performance.now();
    expect(await s.service.suspend('retention busy')).toMatchObject({ code: 0, clean: true });
    expect(performance.now() - start).toBeLessThan(600);
    expect(readLockOwner(s.paths)).toBeNull();
  } finally {
    release.resolve({ pruned: false });
    await waitFor(() => s.terminal.filter((line) => line.includes('retention sweep finished')).length === 2);
  }
});

test('suspend during startup is a plain clean stop, and a prior refusal retains its exit', async () => {
  const s = await setupTestService();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const starting = s.start({
    fetch: async (input, init) => {
      entered.resolve();
      await release.promise;
      return fetch(input, init);
    },
  });
  try {
    await entered.promise;
    expect(await controlRequest(s.paths, 'POST', '/suspend')).toBeNull();
  } finally {
    release.resolve();
  }
  const service = await starting;
  expect(await service.exited).toEqual({ code: 0, clean: true, reason: 'suspend requested' });
  const refused = await startTestService({ noCredentials: true });
  expect(await refused.service.suspend('late')).toEqual(await refused.service.exited);
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `bun test packages/runner/test/service/suspend.test.ts packages/cli/test/runner-command.test.ts`
Expected: FAIL — `agflow runner > start suspends a running attempt on SIGTERM in foreground and exits 0 with a clean run`: at `packages/cli/test/runner-command.test.ts:187`, `expect(exits).toEqual(...)` expected `cause: 'suspend'`, received `cause: 'runner_stop'`. The missing `../../src/service/suspend` error follows later. Observed on the current task parent with only this task's test files copied in (2026-11-11).

- [ ] **Step 3: Implement**

**File:** `packages/runner/src/service/host.ts` (change)

```diff
diff --git a/packages/runner/src/service/host.ts b/packages/runner/src/service/host.ts
index 0d127c7e..519355ca 100644
--- a/packages/runner/src/service/host.ts
+++ b/packages/runner/src/service/host.ts
@@ -28,6 +28,7 @@ import { RotatingLog } from './log';
 import { machineMismatch, readMachineId } from './machine';
 import { createMacNotifier } from './notify';
 import { ServiceRuns } from './runs';
+import { suspendRunner } from './suspend';
 import { defaultExec, type Exec } from './system';
 
 /** How the service ended: the process exit code, whether the run counts as clean (task 19's guard), and why. */
@@ -56,8 +57,8 @@ export interface RunnerServiceOptions {
   /** The foreground's terminal, and where lines go before the log exists; stderr by default. */
   terminal?: (line: string) => void;
   /**
-   * The CLI owns its process: SIGTERM and SIGINT stop the service, and an uncaught error ends it unclean. Off for a
-   * host embedded in another process, such as a test.
+   * The CLI owns its process: SIGTERM and SIGINT suspend the service, as SIGHUP does in the foreground, and an uncaught
+   * error ends it unclean. Off for a host embedded in another process, such as a test.
    */
   signals?: boolean;
   lockPollMs?: number;
@@ -90,10 +91,9 @@ export interface RunnerService {
   readonly runner: RunnerHandle | null;
   /** Resolves after teardown, once runner.lock, released last, is free. */
   readonly exited: Promise<ServiceExit>;
-  /**
-   * Stops the agents with no handoff within timings.suspend, then exits cleanly, as SIGTERM and SIGINT do; a second
-   * call gets the same exit.
-   */
+  /** Suspends agents within timings.suspend, then exits cleanly; concurrent shutdowns get the same exit. */
+  suspend(reason: string): Promise<ServiceExit>;
+  /** Stops the agents with no handoff within timings.suspend, then exits cleanly; a second call gets the same exit. */
   stop(reason: string): Promise<ServiceExit>;
 }
 
@@ -101,10 +101,10 @@ export interface RunnerService {
 class Refusal extends Error {}
 
 /**
- * How teardown ends the agents: a stop without a handoff (a link that ended for good, a refusal, a stop, a signal), or
- * only the kill after an uncaught error.
+ * How teardown ends the agents: a suspend (SIGTERM, SIGINT, POST /suspend), a stop without a handoff (a link that
+ * ended for good, a refusal, a stop), or only the kill after an uncaught error.
  */
-type AgentsEnd = 'stop' | 'kill';
+type AgentsEnd = 'suspend' | 'stop' | 'kill';
 
 /** Waits for work up to ms; past that, teardown goes on and the work finishes unobserved. */
 async function within(work: Promise<unknown>, ms: number): Promise<void> {
@@ -200,7 +200,13 @@ export async function startRunnerService(options: RunnerServiceOptions): Promise
         retentionTimer = null;
       });
       const active = runner;
-      if (agents === 'stop' && active !== null) {
+      if (agents === 'suspend' && active !== null && logger !== null) {
+        const result = await suspendRunner(active, {
+          deadlineMs: Math.max(0, deadline - performance.now()),
+          logger,
+        });
+        logger.info('runner suspend finished', { ...result });
+      } else if (agents === 'stop' && active !== null) {
         // runner.close leaves agents running, and under launchd nothing restarts this runner after a link end or a
         // refusal to recover them (X-41). The hub resends commands held meanwhile after a later welcome.
         await step(async () => {
@@ -217,7 +223,11 @@ export async function startRunnerService(options: RunnerServiceOptions): Promise
       await step(() => runner?.close());
       await step(() => health?.close());
       await step(() => keepAwake?.close());
-      await step(() => retention);
+      await step(() => {
+        if (retention === null) return;
+        // A suspend bounds the step under way, such as a repack, by its deadline (launchd's ExitTimeOut follows).
+        return agents === 'suspend' ? within(retention, deadline - performance.now()) : retention;
+      });
       await step(() => control?.stop());
       await step(() => db?.close());
       await step(() => {
@@ -237,29 +247,38 @@ export async function startRunnerService(options: RunnerServiceOptions): Promise
       return runner;
     },
     exited: exited.promise,
+    suspend: (reason) => finish({ code: 0, clean: true, reason }, 'info', runner !== null ? 'suspend' : 'stop'),
     stop: (reason) => finish({ code: 0, clean: true, reason }, 'info'),
   };
 
-  const onTerm = () => void service.stop('received SIGTERM');
-  const onInt = () => void service.stop('received SIGINT');
+  const onTerm = () => void service.suspend('received SIGTERM');
+  const onInt = () => void service.suspend('received SIGINT');
+  // A closed terminal tab hangs up a foreground runner; its agents run in their own sessions and never see it.
+  const onHup = () => void service.suspend('received SIGHUP');
+  const hangup = options.signals === true && mode === 'foreground';
   // The runner's state is unknown after an uncaught error: its agents are killed, not stopped.
   const onError = (error: unknown) => void finish(failure(error), 'error', 'kill');
   function removeHandlers() {
     if (!options.signals) return;
     process.off('SIGTERM', onTerm);
     process.off('SIGINT', onInt);
+    if (hangup) process.off('SIGHUP', onHup);
     process.off('uncaughtException', onError);
     process.off('unhandledRejection', onError);
   }
   if (options.signals) {
     process.on('SIGTERM', onTerm);
     process.on('SIGINT', onInt);
+    if (hangup) process.on('SIGHUP', onHup);
     process.on('uncaughtException', onError);
     process.on('unhandledRejection', onError);
   }
 
   // The control socket's routes; the commands of later tasks add theirs here.
   const routes: ControlRoutes = {
+    'POST /suspend': () => {
+      void service.suspend('suspend requested');
+    },
     'GET /health': () => {
       const status = runner?.status();
       return {
@@ -318,6 +337,8 @@ export async function startRunnerService(options: RunnerServiceOptions): Promise
       config: () => config,
       heartbeatMs: () => heartbeatMs ?? config.timings.heartbeat,
       stopAgents: (cause, options) => {
+        // health.close stops its timer; status/heartbeat reads and an in-flight sample can still evaluate guards.
+        if (ending) return Promise.resolve([]);
         if (runner === null) throw new Error('the runner is not running yet');
         return runner.stopAgents(cause, options);
       },
```

**File:** `packages/runner/src/service/suspend.ts` (new)

```ts
// The service's suspend budget (design 7.1, X-7). The runner owns stopping, final WIP and suspended records.
import type { Logger } from '../log';
import type { RunnerHandle } from '../runner';

type SuspendHandle = Pick<RunnerHandle, 'pause' | 'stopAgents' | 'waitAcked' | 'status'>;

export interface SuspendOptions {
  deadlineMs: number;
  logger: Logger;
  /** Monotonic milliseconds by default, so a wall-clock correction cannot extend a suspend. */
  now?: () => number;
}

export interface SuspendResult {
  /** Completed stopAgents' exits, in final-push order; empty when that operation did not finish. */
  seqs: number[];
  /** null when no acknowledgement was needed or the link was already down. */
  acked: boolean | null;
  deadlinePassed: boolean;
  error: string | null;
}

/** Pauses permanently, stops without a handoff, and waits for the last exit's cumulative ack within one budget. */
export async function suspendRunner(runner: SuspendHandle, options: SuspendOptions): Promise<SuspendResult> {
  const result: SuspendResult = { seqs: [], acked: null, deadlinePassed: false, error: null };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  const log = (message: string, error?: string) => {
    try {
      options.logger.warn(message, error === undefined ? undefined : { error });
    } catch {
      // Logging must not hold shutdown open or make it reject.
    }
  };
  try {
    const now = options.now ?? (() => performance.now());
    const deadline = now() + options.deadlineMs;
    const expired = () => {
      result.deadlinePassed = true;
      log('runner suspend deadline passed');
    };
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(
        () => {
          expired();
          resolve();
        },
        Math.max(0, options.deadlineMs),
      );
    });
    // The catch stays attached after the deadline: a late push failure must never become an unhandled rejection.
    const work = (async () => {
      runner.pause();
      const seqs = await runner.stopAgents('suspend', { handoff: false });
      if (finished) return;
      result.seqs = seqs;
      const last = seqs.at(-1);
      if (last === undefined) return;
      while (!finished && runner.status().link === 'online') {
        const remaining = deadline - now();
        if (remaining <= 0) {
          expired();
          return;
        }
        // Poll the link between bounded ack waits: a disconnect should not cost the rest of the budget.
        const acked = await runner.waitAcked(last, Math.min(remaining, 100));
        if (finished) return;
        result.acked = acked;
        if (acked) return;
      }
    })().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!finished) result.error = message;
      log('runner suspend failed', message);
    });
    await Promise.race([work, timeout]);
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    log('runner suspend failed', result.error);
  } finally {
    finished = true;
    if (timer !== undefined) clearTimeout(timer);
  }
  return result;
}
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `bun test packages/runner/test/service/suspend.test.ts packages/cli/test/runner-command.test.ts packages/runner/test/service/host.test.ts && bun test && bun run typecheck`
Expected: the task's tests pass; then the whole suite passes (`0 fail`) and `tsc` exits 0.

The stalled-suspend test holds the final push with a blocking pre-receive hook in the origin, checks the clean exit within the budget, then releases the hook; it does not sleep. A final push still running at the deadline keeps running until the process exits; the hub sees the attempt stopped with its clone and resumes it. `packages/cli/test/run-runner-start.ts` is the child process of the CLI signal tests, which take up to 60 s each. A suspend before the runner exists is a plain clean stop. The child CLI fixture run-runner-start.ts passes fixtureCliVersion through RunnerServiceOptions, so its fake attempts and signal tests run on Linux.

- [ ] **Step 5: Commit**

```bash
git add -A 'packages/cli/test/run-runner-start.ts' 'packages/cli/test/runner-command.test.ts' 'packages/runner/src/service/host.ts' 'packages/runner/src/service/suspend.ts' 'packages/runner/test/service-helpers.ts' 'packages/runner/test/service/run-service.ts' 'packages/runner/test/service/suspend.test.ts'
git commit -m 'M2C Task 17: SIGTERM means suspend' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

### Task 18: needs_login

Adds the service's side effects of needs_login (design 7.1); M2b's link detects it and probes whoami (X-7). From `RunnerEvents.needsLogin` until the next welcome, the health refuses starts with `needs_login`, every turn is interrupted without a handoff turn (which marks the attempts for M2b's one reconnect message, X-38), WIP is pushed where `canPushWip` allows (X-11), one notification is posted, and the log and `runner status` say why. A `--service` start without credentials, or with an unreadable credentials.json, waits for the file in the same state instead of exiting, so `KeepAlive` does not loop; the foreground refuses.

**Files:**
- Test: `packages/cli/test/runner-command.test.ts`
- Modify: `packages/runner/src/service/host.ts`
- Create: `packages/runner/src/service/needs-login.ts`
- Test: `packages/runner/test/service/host.test.ts`
- Test: `packages/runner/test/service/needs-login.test.ts`

- [ ] **Step 1: Write the failing tests**

**File:** `packages/cli/test/runner-command.test.ts` (change)

```diff
diff --git a/packages/cli/test/runner-command.test.ts b/packages/cli/test/runner-command.test.ts
index 34312269..dbcd106f 100644
--- a/packages/cli/test/runner-command.test.ts
+++ b/packages/cli/test/runner-command.test.ts
@@ -89,6 +89,7 @@ console.log(JSON.stringify(Object.keys(require.cache).filter((path) => path.incl
         paths: runnerPaths(),
         mode: options.mode,
         runner: null,
+        needsLogin: null,
         exited: Promise.resolve(exit),
         suspend: async () => exit,
         stop: async () => exit,
```

**File:** `packages/runner/test/service/host.test.ts` (change)

```diff
diff --git a/packages/runner/test/service/host.test.ts b/packages/runner/test/service/host.test.ts
index 854a753e..a6e79596 100644
--- a/packages/runner/test/service/host.test.ts
+++ b/packages/runner/test/service/host.test.ts
@@ -129,6 +129,17 @@ describe('startRunnerService', () => {
     expect(existsSync(s.paths.socket)).toBe(false);
   });
 
+  test('an unreadable credentials.json is a clean refusal in foreground', async () => {
+    const s = await setupTestService({ noCredentials: true });
+    writeFileSync(join(s.configDir, CREDENTIALS_FILE), '{');
+    const service = await s.start();
+    const exit = await service.exited;
+    expect(exit).toMatchObject({ code: 1, clean: true });
+    expect(exit.reason).toContain('is not valid JSON; run agflow login');
+    expect(lastExit(s.paths)).toMatchObject(exit);
+    expect(existsSync(s.paths.socket)).toBe(false);
+  });
+
   for (const mode of ['foreground', 'service'] as const) {
     test(`a machine mismatch is a clean refusal in ${mode}`, async () => {
       const s = await startTestService({ mode, config: { machineId: 'OTHER' } });
```

**File:** `packages/runner/test/service/needs-login.test.ts` (new)

```ts
// Login expiry keeps the service alive; M2b owns the probe, WIP gate and reconnect nudge.
import { afterEach, beforeEach, expect, mock, setDefaultTimeout, spyOn, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CREDENTIALS_FILE } from '@agflow/core';
import { getAttempt } from '@agflow/hub/src/attempt-store';
import { createSession, deleteSession } from '@agflow/hub/src/auth';
import { getRunner } from '@agflow/hub/src/runners';
import { getTask } from '@agflow/hub/src/task-store';
import { createTasks } from '@agflow/hub/src/tasks';
import { newTask } from '@agflow/hub/test/helpers';
import { FakeAdapter, gitIn, originRepo } from '@agflow/testkit';
import { AttemptStore } from '../../src/attempt-store';
import { systemClock } from '../../src/clock';
import { openRunnerDb } from '../../src/db';
import { memoryLogger } from '../../src/log';
import * as healthModule from '../../src/ops/health';
import { Outbox } from '../../src/outbox';
import type { RunnerHandle } from '../../src/runner';
import { controlRequest } from '../../src/service/control';
import type { RunnerService } from '../../src/service/host';
import { readLockOwner } from '../../src/service/lock';
import { NeedsLogin } from '../../src/service/needs-login';
import { fixtureAgentToken, waitFor } from '../fixture';
import { startRunnerAttempt, startTestHub } from '../hub-fixture';
import { afterThisTest, cleanupRunnerSetups } from '../runner-setup';
import { recordingExec, setupTestService, startTestService } from '../service-helpers';

afterEach(cleanupRunnerSetups);
setDefaultTimeout(60_000);
beforeEach(() => {
  const previous = process.env.AGFLOW_TEST;
  process.env.AGFLOW_TEST = '1';
  afterThisTest(() => {
    if (previous === undefined) delete process.env.AGFLOW_TEST;
    else process.env.AGFLOW_TEST = previous;
  });
});

type Setup = Awaited<ReturnType<typeof setupTestService>>;
const nudge = 'the agflow hub is reachable again; retry the tool that failed';

async function online(service: RunnerService) {
  if (service.runner === null) throw new Error(`service did not start: ${(await service.exited).reason}`);
  await waitFor(() => service.runner?.status().link === 'online');
  return service.runner!.status().runnerId!;
}

function readDb<T>(s: Setup, read: (db: ReturnType<typeof openRunnerDb>) => T): T {
  const db = openRunnerDb(s.paths.db);
  try {
    return read(db);
  } finally {
    db.close();
  }
}

function waitingAdapter() {
  const messages = new Map<string, string[]>();
  const interrupts = new Map<string, number>();
  const adapter = new FakeAdapter({
    vendor: 'codex',
    skipAuthChecks: true,
    script: { turns: [[{ do: 'sleep', ms: 120_000 }], [{ do: 'sleep', ms: 120_000 }]] },
  });
  const start = adapter.start.bind(adapter);
  adapter.start = async (launch) => {
    const session = await start(launch);
    messages.set(launch.attemptId, []);
    interrupts.set(launch.attemptId, 0);
    const send = session.send.bind(session);
    session.send = async (message) => {
      messages.get(launch.attemptId)!.push(message.text);
      await send(message);
    };
    const interrupt = session.interrupt.bind(session);
    session.interrupt = async () => {
      interrupts.set(launch.attemptId, interrupts.get(launch.attemptId)! + 1);
      await interrupt();
    };
    return session;
  };
  return { adapter, messages, interrupts };
}

// Real notification mode forbids short runner.json timings; shorten only the probe timer at its clock seam.
function fastLoginProbes() {
  const schedule = systemClock.setTimeout;
  const timer = spyOn(systemClock, 'setTimeout').mockImplementation((fn, ms) => schedule(fn, ms === 60_000 ? 30 : ms));
  afterThisTest(() => timer.mockRestore());
}

function observeHealth() {
  let health: healthModule.ServiceHealth;
  const create = healthModule.createServiceHealth;
  const observer = spyOn(healthModule, 'createServiceHealth').mockImplementation((options) => {
    health = create(options);
    return health;
  });
  afterThisTest(() => observer.mockRestore());
  return () => health;
}

for (const withinGrace of [true, false]) {
  test(`revoked login interrupts all turns; WIP ${withinGrace ? 'pushes in grace' : 'waits for welcome'}`, async () => {
    const origin = await originRepo({ 'README.md': '# demo\n', 'src/app.ts': 'app\n' });
    afterThisTest(() => origin.remove());
    const hub = startTestHub({
      config: { projectName: 'demo', projectRepo: origin.path, wipGraceMs: withinGrace ? 30_000 : 1_500 },
    });
    afterThisTest(() => hub.stop());
    fastLoginProbes();
    const health = observeHealth();
    const { adapter, messages, interrupts } = waitingAdapter();
    const exec = recordingExec();
    let probes = 0;
    let delayProbe = false;
    const s = await startTestService({
      hub,
      config: {
        test: undefined,
        keepAwake: 'off',
        capacity: 2,
      },
      host: {
        adapters: [adapter],
        exec,
        platform: 'darwin',
        fetch: async (input, init) => {
          if (String(input).endsWith('/api/runner/whoami')) {
            probes++;
            // No ack arrives after the link closes. Real time ages the runner's ack, not the hub's fake clock.
            if (delayProbe) {
              delayProbe = false;
              await Bun.sleep(1_650);
            }
          }
          return fetch(input, init);
        },
      },
    });
    const id = await online(s.service);
    const attempts = [0, 1].map(() => {
      const [task] = createTasks(hub.ctx, [newTask()], 'user:alice');
      return startRunnerAttempt(hub.ctx, { runnerId: id, taskId: task!.id, role: 'worker', vendor: 'codex' }).attempt;
    });
    await waitFor(() => s.service.runner!.status().attempts.filter((a) => a.phase === 'turn').length === 2);
    for (const launch of adapter.launches) writeFileSync(join(launch.clone, 'saved.txt'), `${launch.attemptId}\n`);
    const spec = {
      ...readDb(s, (db) => new AttemptStore(db).get(attempts[0]!.id)!.spec),
      agentToken: fixtureAgentToken(attempts[0]!.id),
    };
    expect(await health().admit(spec)).toBeNull();
    delayProbe = !withinGrace;
    deleteSession(hub.ctx, hub.token);
    hub.ctx.link.closeRunner(id, 1012, 'reconnect after revocation');
    await waitFor(() => s.service.runner!.status().link === 'needs_login');
    expect(s.service.needsLogin!.state()).toMatchObject({
      on: true,
      since: expect.any(Number),
      reason: 'the hub refused the CLI token',
    });
    const firstState = s.service.needsLogin!.state();
    expect(getRunner(hub.ctx, id).state).toBe('needs_login');
    expect(await health().admit(spec)).toBe('needs_login');
    await waitFor(() => attempts.every((a) => interrupts.get(a.id) === 1));
    await waitFor(() => s.service.runner!.status().attempts.every((a) => a.wipSha !== null));
    await waitFor(() => probes >= 5);
    expect(s.service.needsLogin!.state()).toEqual(firstState);
    expect(exec.calls).toHaveLength(1);
    expect(exec.calls[0]!.argv.join(' ')).toContain(`agflow login --hub ${hub.url}`);
    const log = readFileSync(s.paths.runnerLog, 'utf8');
    expect(log).toContain('sign-in expired or was revoked');
    expect(log).toContain(`agflow login --hub ${hub.url}`);
    for (const attempt of attempts) {
      expect(messages.get(attempt.id)).toEqual([]);
      expect(interrupts.get(attempt.id)).toBe(1);
      const status = s.service.runner!.status().attempts.find((a) => a.attemptId === attempt.id)!;
      if (withinGrace) {
        await waitFor(
          () => s.service.runner!.status().attempts.find((a) => a.attemptId === attempt.id)!.pushedSha !== null,
        );
        expect((await gitIn(origin.path, ['rev-parse', attempt.wipRef!])).trim()).toBe(status.wipSha!);
      } else {
        expect(status.pushedSha).toBeNull();
        expect((await gitIn(origin.path, ['show-ref'])).includes(attempt.wipRef!)).toBe(false);
      }
      // The offline event is queued; the hub learns the SHA only after the next welcome.
      expect(getTask(hub.ctx, attempt.taskId!).workSha).toBeNull();
    }
    expect(readDb(s, (db) => new Outbox(db).eventsAfter(0)).some((e) => e.type === 'attempt.exited')).toBe(false);
    const token = createSession(hub.ctx, hub.owner, 'cli');
    writeFileSync(join(s.configDir, CREDENTIALS_FILE), JSON.stringify({ ...hub.credentials, token }));
    await online(s.service);
    expect(s.service.needsLogin!.state()).toEqual({ on: false, since: null, reason: null });
    expect(await health().admit(spec)).toBeNull();
    expect(getRunner(hub.ctx, id).state).toBe('online');
    for (const attempt of attempts) {
      await waitFor(() => messages.get(attempt.id)!.length === 1);
      await waitFor(() => getTask(hub.ctx, attempt.taskId!).workSha !== null);
      const sha = getTask(hub.ctx, attempt.taskId!).workSha!;
      expect((await gitIn(origin.path, ['show', `${sha}:saved.txt`])).trim()).toBe(attempt.id);
      expect(getAttempt(hub.ctx, attempt.id)).toMatchObject({ status: 'running', wipSha: sha });
    }
    const welcomes = () => readFileSync(s.paths.runnerLog, 'utf8').split('runner link {"state":"online"').length;
    const before = welcomes();
    hub.ctx.link.closeRunner(id, 1012, 'one more welcome');
    await waitFor(() => welcomes() > before);
    await online(s.service);
    await Bun.sleep(100);
    for (const attempt of attempts) expect(messages.get(attempt.id)).toEqual([nudge]);
    expect(exec.calls).toHaveLength(1);
  });
}

test('a service without credentials waits, notifies once, and connects when the file appears', async () => {
  fastLoginProbes();
  const exec = recordingExec();
  const s = await setupTestService({
    mode: 'service',
    noCredentials: true,
    config: { test: undefined, keepAwake: 'off' },
    host: { exec, platform: 'darwin' },
  });
  let returned = false;
  const starting = s.start().then((service) => {
    returned = true;
    return service;
  });
  try {
    await waitFor(
      () => existsSync(s.paths.runnerLog) && readFileSync(s.paths.runnerLog, 'utf8').includes('agflow login'),
    );
    await Bun.sleep(150);
    expect(returned).toBe(false);
    expect(readLockOwner(s.paths)).toMatchObject({ pid: process.pid, mode: 'service' });
    expect(await controlRequest(s.paths, 'GET', '/health')).toMatchObject({ link: 'needs_login', runnerId: null });
    expect(exec.calls).toHaveLength(1);
    expect(exec.calls[0]!.argv.join(' ')).toContain('not signed in');
    expect(readFileSync(s.paths.runnerLog, 'utf8')).toContain('waiting');
  } finally {
    writeFileSync(join(s.configDir, CREDENTIALS_FILE), JSON.stringify(s.hub.credentials));
    await starting;
  }
  const service = await starting;
  await online(service);
  expect(service.needsLogin!.state().on).toBe(false);
  expect(exec.calls).toHaveLength(1);
});

test('a service whose credentials.json is not valid JSON waits in needs_login and connects once it is', async () => {
  fastLoginProbes();
  const exec = recordingExec();
  const s = await setupTestService({
    mode: 'service',
    noCredentials: true,
    config: { test: undefined, keepAwake: 'off' },
    host: { exec, platform: 'darwin' },
  });
  // agflow login truncates before it writes: a probe can read an empty or partial file.
  writeFileSync(join(s.configDir, CREDENTIALS_FILE), '{');
  const starting = s.start();
  try {
    await waitFor(
      () => existsSync(s.paths.runnerLog) && readFileSync(s.paths.runnerLog, 'utf8').includes('run agflow login'),
    );
    await Bun.sleep(150);
    expect(readLockOwner(s.paths)).toMatchObject({ pid: process.pid, mode: 'service' });
    expect(await controlRequest(s.paths, 'GET', '/health')).toMatchObject({ link: 'needs_login', runnerId: null });
    expect(exec.calls).toHaveLength(1);
    expect(exec.calls[0]!.argv.join(' ')).toContain('is not valid JSON');
    const log = readFileSync(s.paths.runnerLog, 'utf8');
    expect(log).toContain('cannot read the CLI credentials');
    expect(log).toContain('is not valid JSON; run agflow login --hub <url>');
  } finally {
    writeFileSync(join(s.configDir, CREDENTIALS_FILE), JSON.stringify(s.hub.credentials));
  }
  const service = await starting;
  await online(service);
  expect(service.needsLogin!.state().on).toBe(false);
  expect(exec.calls).toHaveLength(1);
  await service.stop('done');
  expect(await service.exited).toMatchObject({ code: 0, clean: true });
});

test('suspend cancels the credential wait on the host clock and releases the lock cleanly', async () => {
  const timers = new Map<object, () => void>();
  const s = await setupTestService({
    mode: 'service',
    noCredentials: true,
    host: {
      clock: {
        ...systemClock,
        setTimeout: (fn) => {
          const id = {};
          timers.set(id, fn);
          return id;
        },
        clearTimeout: (id) => {
          timers.delete(id as object);
        },
      },
    },
  });
  // A previous run's hub is still useful in the sign-in instructions without credentials.json.
  const db = openRunnerDb(s.paths.db);
  db.setMeta('project', { hubUrl: s.hub.url, name: 'demo', repo: s.hub.ctx.config.projectRepo });
  db.close();
  const starting = s.start();
  await waitFor(() => timers.size === 1);
  expect(readFileSync(s.paths.runnerLog, 'utf8')).toContain(`agflow login --hub ${s.hub.url}`);
  expect(await controlRequest(s.paths, 'POST', '/suspend')).toBeNull();
  const service = await starting;
  expect(await service.exited).toEqual({ code: 0, clean: true, reason: 'suspend requested' });
  expect(service.runner).toBeNull();
  expect(timers.size).toBe(0);
  expect(readLockOwner(s.paths)).toBeNull();
  expect(existsSync(s.paths.socket)).toBe(false);
});

test('needs_login is once per stretch, survives failed side effects, and does not wait for notifications', async () => {
  let now = 100;
  const logger = memoryLogger();
  const health = { setNeedsLogin: mock((_on: boolean) => {}) };
  const notice = Promise.withResolvers<void>();
  const notifier = { notify: mock(() => notice.promise) };
  const runner = {
    interruptAgents: mock(async (_options: { outage: boolean }) => {
      throw new Error('interrupt failed');
    }),
    pushWipNow: mock(async () => {
      throw new Error('push failed');
    }),
  } satisfies Pick<RunnerHandle, 'interruptAgents' | 'pushWipNow'>;
  let current: typeof runner | null = null;
  const state = new NeedsLogin({
    health,
    notifier,
    logger,
    runner: () => current,
    hubUrl: () => 'https://hub',
    now: () => now,
  });
  state.leave();
  state.enter('not signed in');
  expect(state.state()).toEqual({ on: true, since: 100, reason: 'not signed in' });
  state.leave();
  current = runner;
  state.enter('expired');
  await waitFor(() => runner.pushWipNow.mock.calls.length === 1);
  now += 600_000;
  state.enter('repeated');
  expect(state.state()).toEqual({ on: true, since: 100, reason: 'expired' });
  expect(runner.interruptAgents).toHaveBeenCalledTimes(1);
  expect(runner.interruptAgents).toHaveBeenCalledWith({ outage: true });
  expect(notifier.notify).toHaveBeenCalledTimes(2);
  expect(logger.entries.some((e) => e.fields.error === 'interrupt failed')).toBe(true);
  expect(logger.entries.some((e) => e.fields.error === 'push failed')).toBe(true);
  notice.reject(new Error('notification failed'));
  await waitFor(() => logger.entries.some((e) => e.fields.error === 'notification failed'));
  state.leave();
  expect(health.setNeedsLogin.mock.calls.map(([on]) => on)).toEqual([true, false, true, false]);
  expect(state.state()).toEqual({ on: false, since: null, reason: null });
});

test('the log and the notification say why from the reason', async () => {
  for (const [reason, why] of [
    ['the hub refused the CLI token', 'the sign-in expired or was revoked'],
    ['the CLI has no credentials for this hub', 'the CLI has no credentials for this hub'],
    ['not signed in', 'not signed in; waiting for credentials.json'],
  ]) {
    const logger = memoryLogger();
    const notifier = { notify: mock(async (_notice: { body: string }) => {}) };
    const state = new NeedsLogin({
      health: { setNeedsLogin: () => {} },
      notifier,
      logger,
      runner: () => null,
      hubUrl: () => 'https://hub',
    });
    state.enter(reason!);
    const body = `${why}; run agflow login --hub https://hub`;
    expect(logger.entries.find((entry) => entry.level === 'warn')?.message).toEndWith(body);
    expect(notifier.notify.mock.calls[0]![0].body).toEndWith(body);
    if (reason !== 'the hub refused the CLI token') {
      expect(logger.entries.some((entry) => entry.message.includes('expired or was revoked'))).toBe(false);
    }
  }
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `bun test packages/runner/test/service/needs-login.test.ts packages/runner/test/service/host.test.ts packages/cli/test/runner-command.test.ts`
Expected: FAIL — `error: Cannot find module '../../src/service/needs-login' from 'packages/runner/test/service/needs-login.test.ts'`; this precedes the host assertions and CLI failures. Observed on the current task parent with only this task's test files copied in (2026-11-11).

- [ ] **Step 3: Implement**

**File:** `packages/runner/src/service/host.ts` (change)

```diff
diff --git a/packages/runner/src/service/host.ts b/packages/runner/src/service/host.ts
index 519355ca..417068b1 100644
--- a/packages/runner/src/service/host.ts
+++ b/packages/runner/src/service/host.ts
@@ -1,6 +1,7 @@
 // The process that runs a runner (design 7.1, X-41): `agflow runner start` in the foreground and `--service` under
 // launchd. One lock holder, one run record, and one exit path for every end: a refusal that needs a person, the hub
 // replacing the link, a stop, or an error.
+import type { Credentials } from '@agflow/core';
 import { createAdapters } from '../adapters';
 import type { AgflowCommand, VendorAdapter } from '../adapters/types';
 import { AttemptStore } from '../attempt-store';
@@ -26,6 +27,7 @@ import { readCliCredentials } from './credentials';
 import { AlreadyRunningError, acquireRunnerLock, type RunnerLock, type RunnerMode } from './lock';
 import { RotatingLog } from './log';
 import { machineMismatch, readMachineId } from './machine';
+import { NeedsLogin } from './needs-login';
 import { createMacNotifier } from './notify';
 import { ServiceRuns } from './runs';
 import { suspendRunner } from './suspend';
@@ -89,6 +91,8 @@ export interface RunnerService {
   readonly mode: RunnerMode;
   /** The running runner; null when the service ended before it started. */
   readonly runner: RunnerHandle | null;
+  /** Login hold and its reason, including the service's initial wait for credentials. */
+  readonly needsLogin: NeedsLogin | null;
   /** Resolves after teardown, once runner.lock, released last, is free. */
   readonly exited: Promise<ServiceExit>;
   /** Suspends agents within timings.suspend, then exits cleanly; concurrent shutdowns get the same exit. */
@@ -160,6 +164,8 @@ export async function startRunnerService(options: RunnerServiceOptions): Promise
   let health: ServiceHealth | null = null;
   let keepAwake: KeepAwake | null = null;
   let notifier: Notifier | null = null;
+  let needsLogin: NeedsLogin | null = null;
+  let loginReason = 'the hub refused the CLI token';
   let preparer: DependencyPreparer | null = null;
   let sandbox: PrepSandbox | null = null;
   let heartbeatMs: number | null = null;
@@ -228,7 +234,11 @@ export async function startRunnerService(options: RunnerServiceOptions): Promise
         // A suspend bounds the step under way, such as a repack, by its deadline (launchd's ExitTimeOut follows).
         return agents === 'suspend' ? within(retention, deadline - performance.now()) : retention;
       });
-      await step(() => control?.stop());
+      await step(async () => {
+        // With no runner yet, teardown can outrun the control request that cancelled the credential wait.
+        await new Promise<void>((resolve) => setImmediate(resolve));
+        control?.stop();
+      });
       await step(() => db?.close());
       await step(() => {
         if (runs !== null && runId !== null) runs.finish(runId, exit);
@@ -246,6 +256,9 @@ export async function startRunnerService(options: RunnerServiceOptions): Promise
     get runner() {
       return runner;
     },
+    get needsLogin() {
+      return needsLogin;
+    },
     exited: exited.promise,
     suspend: (reason) => finish({ code: 0, clean: true, reason }, 'info', runner !== null ? 'suspend' : 'stop'),
     stop: (reason) => finish({ code: 0, clean: true, reason }, 'info'),
@@ -286,7 +299,7 @@ export async function startRunnerService(options: RunnerServiceOptions): Promise
         mode,
         startedAt: lock?.owner.startedAt ?? null,
         runnerId: status?.runnerId ?? null,
-        link: status?.link ?? 'idle',
+        link: status?.link ?? (needsLogin?.state().on ? 'needs_login' : 'idle'),
       };
     },
   };
@@ -294,14 +307,30 @@ export async function startRunnerService(options: RunnerServiceOptions): Promise
   const events: RunnerEvents = {
     link: (state, detail) => {
       logger?.info('runner link', { state, code: detail.code, reason: detail.reason });
+      if (state === 'needs_login') loginReason = detail.reason;
     },
     gap: (gap) => health?.gap(gap),
     welcome: (welcome) => {
       heartbeatMs = welcome.timings.heartbeatMs;
+      needsLogin?.leave();
     },
+    needsLogin: () => needsLogin?.enter(loginReason),
     attemptState: () => keepAwake?.evaluate(),
   };
 
+  // A credentials.json the service cannot read, or catches half-written by agflow login, is waited out like a missing
+  // one, as M2b's link does; the foreground refuses, so a person repairs it without it counting as a crash.
+  function readCredentials(): { credentials: Credentials | null; problem: string | null } {
+    try {
+      return { credentials: readCliCredentials(configDir), problem: null };
+    } catch (error) {
+      if (mode === 'foreground') throw new Refusal(describe(error));
+      logger?.warn('cannot read the CLI credentials', { error: describe(error) });
+      // needs_login adds the sign-in command with the hub's URL.
+      return { credentials: null, problem: describe(error).replace(/; run agflow login$/, '') };
+    }
+  }
+
   // Each await may meet a stop: startup then ends early, and finish releases what it made.
   async function start(): Promise<void> {
     lock = await acquireRunnerLock(paths, {
@@ -328,10 +357,14 @@ export async function startRunnerService(options: RunnerServiceOptions): Promise
     if (mismatch !== null) throw new Refusal(mismatch);
     if (ending) return;
     control = startControlServer({ paths, lock, routes });
-    if (readCliCredentials(configDir) === null) throw new Refusal('not signed in; run agflow login --hub <url>');
+    const read = readCredentials();
+    let credentials = read.credentials;
+    if (credentials === null && mode === 'foreground') {
+      throw new Refusal('not signed in; run agflow login --hub <url>');
+    }
     db = openRunnerDb(paths.db);
     store = new AttemptStore(db);
-    const adapters = options.adapters ?? (options.createAdapters ?? createAdapters)(config, paths, { agflow });
+    let hubUrl = credentials?.hubUrl ?? db.meta('project')?.hubUrl ?? null;
     health = createServiceHealth({
       paths,
       config: () => config,
@@ -363,6 +396,34 @@ export async function startRunnerService(options: RunnerServiceOptions): Promise
       logger,
       platform: options.platform,
     });
+    needsLogin = new NeedsLogin({
+      health,
+      notifier,
+      logger,
+      runner: () => runner,
+      hubUrl: () => hubUrl,
+      now: () => clock.now(),
+    });
+    if (credentials === null) {
+      needsLogin.enter(read.problem ?? 'not signed in');
+      while (!ending && credentials === null) {
+        await new Promise<void>((resolve) => {
+          const done = () => {
+            clock.clearTimeout(timer);
+            waiting.signal.removeEventListener('abort', done);
+            resolve();
+          };
+          const timer = clock.setTimeout(done, config.timings.loginProbe);
+          waiting.signal.addEventListener('abort', done, { once: true });
+          if (waiting.signal.aborted) done();
+        });
+        if (ending) return;
+        credentials = readCredentials().credentials;
+      }
+      if (ending) return;
+      hubUrl = credentials!.hubUrl;
+    }
+    const adapters = options.adapters ?? (options.createAdapters ?? createAdapters)(config, paths, { agflow });
     sandbox =
       options.prepSandbox ?? new PrepSandbox({ allowedDomains: standardProfile.network.allowedDomains, logger });
     preparer = await createDependencyPreparer({ paths, store, config: () => config, logger, sandbox });
```

**File:** `packages/runner/src/service/needs-login.ts` (new)

```ts
// Service side effects for a refused CLI sign-in (design 7.1, X-7, X-11, X-38). The link owns probing and recovery.
import type { Logger } from '../log';
import type { ServiceHealth } from '../ops/health';
import type { RunnerHandle } from '../runner';
import type { Notifier } from '../seams';

export interface NeedsLoginState {
  on: boolean;
  since: number | null;
  reason: string | null;
}

export interface NeedsLoginOptions {
  health: Pick<ServiceHealth, 'setNeedsLogin'>;
  notifier: Notifier;
  logger: Logger;
  /** The handle may not exist yet, including while the service waits for credentials.json. */
  runner: () => Pick<RunnerHandle, 'interruptAgents' | 'pushWipNow'> | null;
  hubUrl: () => string | null;
  now?: () => number;
}

/** The person's reading of a reason: the service's own credential wait, M2b's refused token, or the reason itself. */
function explain(reason: string): string {
  if (reason === 'not signed in') return 'not signed in; waiting for credentials.json';
  if (reason === 'the hub refused the CLI token') {
    return "the hub refused the CLI's sign-in; the sign-in expired or was revoked";
  }
  return reason;
}

export class NeedsLogin {
  private current: NeedsLoginState = { on: false, since: null, reason: null };

  constructor(private readonly options: NeedsLoginOptions) {}

  state(): NeedsLoginState {
    return { ...this.current };
  }

  enter(reason: string): void {
    if (this.current.on) return;
    this.current = { on: true, since: (this.options.now ?? Date.now)(), reason };
    this.options.health.setNeedsLogin(true);
    const login = `agflow login --hub ${this.options.hubUrl() ?? '<url>'}`;
    const body = `${explain(reason)}; run ${login}`;
    this.options.logger.warn(body, { reason });
    // A slow desktop notification must not delay interrupting the agents or spend their WIP grace.
    void this.attempt('notification', () =>
      this.options.notifier.notify({
        key: 'needs_login',
        title: 'agflow needs login',
        body,
      }),
    );
    void this.interruptAndPush();
  }

  leave(): void {
    if (!this.current.on) return;
    this.current = { on: false, since: null, reason: null };
    this.options.health.setNeedsLogin(false);
    this.options.logger.info('runner left needs_login; the hub accepted the CLI sign-in');
  }

  private async interruptAndPush(): Promise<void> {
    await this.attempt('agents', async () => {
      const runner = this.options.runner();
      if (runner === null) return;
      await this.attempt('interrupt', () => runner.interruptAgents({ outage: true }));
      await this.attempt('WIP push', () => runner.pushWipNow());
    });
  }

  private async attempt(action: string, run: () => unknown): Promise<void> {
    try {
      await run();
    } catch (error) {
      this.options.logger.warn(`needs_login ${action} failed`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `bun test packages/runner/test/service/needs-login.test.ts packages/runner/test/service/host.test.ts packages/cli/test/runner-command.test.ts && bun test && bun run typecheck`
Expected: the task's tests pass; then the whole suite passes (`0 fail`) and `tsc` exits 0.

The notification is not awaited, so a slow osascript cannot use up the WIP grace. Its text comes from the reason: "the hub refused the CLI's sign-in; the sign-in expired or was revoked" for a refused token, "not signed in; waiting for credentials.json" for the service's own wait, each followed by `; run agflow login --hub <url>`. While the service waits for credentials it holds the lock and the socket, and `GET /health` shows the link as `needs_login`; a stop or a suspend cancels the wait. The notification tests run without the test block, so runner.json refuses short timings: they shorten only the 60 s probe timer through a spy on `systemClock.setTimeout`.

- [ ] **Step 5: Commit**

```bash
git add -A 'packages/cli/test/runner-command.test.ts' 'packages/runner/src/service/host.ts' 'packages/runner/src/service/needs-login.ts' 'packages/runner/test/service/host.test.ts' 'packages/runner/test/service/needs-login.test.ts'
git commit -m 'M2C Task 18: needs_login' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

### Task 19: `drain`, `undrain` and the crash-loop guard

`agflow runner drain` and `undrain` (design 7.1, 6.3, X-12). While the runner runs they go through the socket to M2b's `changeSettings`; while it is down they edit runner.json under the lock, and M2b sends the edit after the next welcome. The crash-loop guard (X-41): after three unclean exits within `crashLoopWindow`, the service reports `crash_loop` with the last error on every hello and drains itself through `changeSettings`. It stays so until `undrain`, which forgets the unclean exits and returns the state to ok, so M2b sends `runner.state` ok.

**Files:**
- Modify: `packages/cli/src/runner-command.ts`
- Test: `packages/cli/test/runner-command.test.ts`
- Create: `packages/runner/src/service/drain.ts`
- Modify: `packages/runner/src/service/host.ts`
- Test: `packages/runner/test/service/drain.test.ts`

- [ ] **Step 1: Write the failing tests**

**File:** `packages/cli/test/runner-command.test.ts` (change)

```diff
diff --git a/packages/cli/test/runner-command.test.ts b/packages/cli/test/runner-command.test.ts
index dbcd106f..58678b95 100644
--- a/packages/cli/test/runner-command.test.ts
+++ b/packages/cli/test/runner-command.test.ts
@@ -1,15 +1,16 @@
-import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
+import { afterEach, beforeEach, describe, expect, mock, setDefaultTimeout, test } from 'bun:test';
 import { existsSync, readFileSync } from 'node:fs';
 import { join } from 'node:path';
 import { getAttempt } from '@agflow/hub/src/attempt-store';
-import { findRunnerByKey } from '@agflow/hub/src/runners';
+import { findRunnerByKey, getRunner } from '@agflow/hub/src/runners';
 import { createTasks } from '@agflow/hub/src/tasks';
 import { newTask } from '@agflow/hub/test/helpers';
+import { loadRunnerConfig } from '@agflow/runner/src/config';
 import { openRunnerDb } from '@agflow/runner/src/db';
 import { Outbox } from '@agflow/runner/src/outbox';
 import { runnerPaths } from '@agflow/runner/src/paths';
 import type { RunnerServiceOptions } from '@agflow/runner/src/service/host';
-import { readLockOwner } from '@agflow/runner/src/service/lock';
+import { acquireRunnerLock, readLockOwner } from '@agflow/runner/src/service/lock';
 import { readMachineId } from '@agflow/runner/src/service/machine';
 import { ServiceRuns } from '@agflow/runner/src/service/runs';
 import { waitFor } from '@agflow/runner/test/fixture';
@@ -35,6 +36,7 @@ beforeEach(() => {
   }
 });
 afterEach(cleanupRunnerSetups);
+setDefaultTimeout(60_000);
 
 function capture() {
   const out: string[] = [];
@@ -57,6 +59,8 @@ describe('agflow runner', () => {
     const { io, out, err } = capture();
     expect(await main(['help'], io)).toBe(0);
     expect(RUNNER_HELP).toContain('agflow runner start [--service]');
+    expect(RUNNER_HELP).toContain('agflow runner drain');
+    expect(RUNNER_HELP).toContain('agflow runner undrain');
     expect(out.join('')).toContain(RUNNER_HELP);
     expect(err).toEqual([]);
   });
@@ -81,6 +85,54 @@ console.log(JSON.stringify(Object.keys(require.cache).filter((path) => path.incl
     expect(err.join('')).toContain('agflow runner start');
   });
 
+  test('drain and undrain reach the running service and print one line each', async () => {
+    const s = await setupTestService();
+    process.env.AGFLOW_HOME = s.paths.home;
+    const service = await s.start();
+    await waitFor(() => service.runner?.status().link === 'online');
+    const id = service.runner!.status().runnerId!;
+    for (const command of ['drain', 'undrain']) {
+      const { io, out, err } = capture();
+      expect(await runnerCommand(parseArgs(['runner', command]), io)).toBe(0);
+      expect(loadRunnerConfig(s.paths.config).draining).toBe(command === 'drain');
+      await waitFor(() => getRunner(s.hub.ctx, id).draining === (command === 'drain'));
+      expect(out).toEqual([command === 'drain' ? 'the runner is draining\n' : 'the runner is undrained\n']);
+      expect(err).toEqual([]);
+    }
+  });
+
+  for (const command of ['drain', 'undrain']) {
+    test(`${command} while stopped prints where it saved the edit`, async () => {
+      const s = await setupTestService({ config: { draining: command === 'undrain' } });
+      process.env.AGFLOW_HOME = s.paths.home;
+      const { io, out, err } = capture();
+      expect(await runnerCommand(parseArgs(['runner', command]), io)).toBe(0);
+      expect(loadRunnerConfig(s.paths.config).draining).toBe(command === 'drain');
+      expect(out).toEqual([`${command}ed in runner.json; the hub hears it after the next start\n`]);
+      expect(err).toEqual([]);
+      expect(readLockOwner(s.paths)).toBeNull();
+    });
+
+    test(`${command} rejects extra positional arguments`, async () => {
+      const { io, out, err } = capture();
+      expect(await main(['runner', command, 'extra'], io)).toBe(2);
+      expect(err.join('')).toContain(`usage: agflow runner ${command}`);
+      expect(out).toEqual([]);
+    });
+
+    test(`${command} reports an unreachable lock holder and exits 1`, async () => {
+      const s = await setupTestService();
+      process.env.AGFLOW_HOME = s.paths.home;
+      const lock = await acquireRunnerLock(s.paths, { mode: 'foreground' });
+      afterThisTest(() => lock.release());
+      const { io, out, err } = capture();
+      expect(await main(['runner', command], io)).toBe(1);
+      expect(out).toEqual([]);
+      expect(err.join('')).toStartWith(`agflow: runner.lock is held by pid ${process.pid}`);
+      expect(err.join('')).toContain('agflow runner status');
+    });
+  }
+
   for (const mode of ['foreground', 'service'] as const) {
     test(`start passes CLI paths, terminal and signals in ${mode} and returns the host exit code`, async () => {
       const { io, out, err } = capture();
```

**File:** `packages/runner/test/service/drain.test.ts` (new)

```ts
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CREDENTIALS_FILE } from '@agflow/core';
import { tx } from '@agflow/hub/src/context';
import { getRunner, patchRunnerSettings } from '@agflow/hub/src/runners';
import { systemClock } from '../../src/clock';
import { loadRunnerConfig } from '../../src/config';
import { openRunnerDb } from '../../src/db';
import { memoryLogger } from '../../src/log';
import { Outbox } from '../../src/outbox';
import { controlRequest, startControlServer } from '../../src/service/control';
import { applyCrashLoopGuard, drainRunner, undrainRunner } from '../../src/service/drain';
import type { RunnerService } from '../../src/service/host';
import { acquireRunnerLock, readLockOwner } from '../../src/service/lock';
import { crashLoopVerdict, ServiceRuns } from '../../src/service/runs';
import { waitFor } from '../fixture';
import { afterThisTest, cleanupRunnerSetups } from '../runner-setup';
import { setupTestService, startTestService } from '../service-helpers';

afterEach(cleanupRunnerSetups);
setDefaultTimeout(60_000);

async function online(service: RunnerService) {
  await waitFor(() => service.runner?.status().link === 'online');
  return service.runner!.status().runnerId!;
}

function crashes(runs: ServiceRuns, count = 3) {
  for (let i = 1; i <= count; i++) {
    const id = runs.start({ pid: process.pid, mode: 'service' });
    runs.finish(id, { clean: false, code: 1, reason: `crash ${i}` });
  }
}

test('live drain and undrain persist locally and reach the hub through settings events', async () => {
  const s = await startTestService();
  const id = await online(s.service);
  expect(await drainRunner({ paths: s.paths })).toEqual({ via: 'runner', draining: true });
  expect(loadRunnerConfig(s.paths.config).draining).toBe(true);
  expect(s.service.runner!.status().settings.draining).toBe(true);
  await waitFor(() => getRunner(s.hub.ctx, id).draining);
  expect(await undrainRunner({ paths: s.paths })).toEqual({ via: 'runner', draining: false });
  expect(loadRunnerConfig(s.paths.config).draining).toBe(false);
  await waitFor(() => !getRunner(s.hub.ctx, id).draining);
});

test('offline drain releases the lock and merges with a hub capacity edit on the next welcome', async () => {
  const s = await startTestService();
  const id = await online(s.service);
  await waitFor(() => loadRunnerConfig(s.paths.config).confirmedSettings.version > 0);
  await s.service.stop('offline edit');
  const snapshot = loadRunnerConfig(s.paths.config).confirmedSettings;
  expect(await drainRunner({ paths: s.paths })).toEqual({ via: 'config', draining: true });
  expect(readLockOwner(s.paths)).toBeNull();
  expect(loadRunnerConfig(s.paths.config).confirmedSettings).toEqual(snapshot);
  tx(s.hub.ctx, (emit) => patchRunnerSettings(s.hub.ctx, emit, id, { capacity: 7 }, 'user:alice'));
  await online(await s.start());
  await waitFor(() => {
    const config = loadRunnerConfig(s.paths.config);
    return config.draining && config.capacity === 7 && config.confirmedSettings.draining;
  });
  expect(getRunner(s.hub.ctx, id)).toMatchObject({ draining: true, capacity: 7 });
});

test('three crashes drain before hello; undrain sends state ok and forgets crashes across restart', async () => {
  const s = await setupTestService();
  const runs = new ServiceRuns(s.paths);
  crashes(runs);
  const service = await s.start();
  expect(loadRunnerConfig(s.paths.config).draining).toBe(true);
  const id = await online(service);
  expect(getRunner(s.hub.ctx, id)).toMatchObject({
    state: 'crash_loop',
    lastError: expect.stringContaining('crash 3'),
  });
  await waitFor(() => getRunner(s.hub.ctx, id).draining);
  expect(runs.crashLoop()).toMatchObject({ lastError: 'crash 3' });
  expect(
    readFileSync(s.paths.runnerLog, 'utf8')
      .split('\n')
      .filter((line) => line.includes('error crash_loop')),
  ).toHaveLength(1);
  await undrainRunner({ paths: s.paths });
  await waitFor(() => getRunner(s.hub.ctx, id).state === 'online' && !getRunner(s.hub.ctx, id).draining);
  const db = openRunnerDb(s.paths.db);
  try {
    expect(new Outbox(db).eventsAfter(0)).toContainEqual(
      expect.objectContaining({
        type: 'runner.state',
        data: { state: 'ok', detail: null },
      }),
    );
  } finally {
    db.close();
  }
  expect(loadRunnerConfig(s.paths.config).draining).toBe(false);
  expect(runs.records().at(-1)).not.toHaveProperty('endedAt');
  expect(crashLoopVerdict(runs, { now: Date.now(), window: s.config.timings.crashLoopWindow })).toMatchObject({
    crashLoop: false,
    unclean: 0,
  });
  expect(await service.stop('restart')).toMatchObject({ clean: true });
  await online(await s.start());
  expect(getRunner(s.hub.ctx, id)).toMatchObject({ state: 'online', draining: false });
});

test('a recorded crash loop survives the window and clean restarts until offline undrain', async () => {
  const s = await setupTestService();
  const runs = new ServiceRuns(s.paths, { now: () => Date.now() - 3_600_000 });
  crashes(runs);
  runs.markCrashLoop({ lastError: 'crash 3' });
  const marker = runs.crashLoop();
  for (let i = 0; i < 2; i++) {
    const service = await s.start();
    const id = await online(service);
    expect(getRunner(s.hub.ctx, id)).toMatchObject({
      state: 'crash_loop',
      lastError: expect.stringContaining('crash 3'),
    });
    await waitFor(() => getRunner(s.hub.ctx, id).draining);
    await service.stop('clean stop');
    expect(runs.crashLoop()).toEqual(marker);
  }
  // A last crash without an exit record must also be forgotten while down.
  runs.start({ pid: process.pid, mode: 'service' });
  expect(await undrainRunner({ paths: s.paths })).toEqual({ via: 'config', draining: false });
  expect(readLockOwner(s.paths)).toBeNull();
  expect(runs.crashLoop()).toBeNull();
  expect(runs.records().at(-1)).toMatchObject({ uncleanForgotten: true });
  const id = await online(await s.start());
  await waitFor(() => !getRunner(s.hub.ctx, id).draining);
  expect(getRunner(s.hub.ctx, id)).toMatchObject({ state: 'online', draining: false });
});

test('a service waiting for credentials edits runner.json; once signed in the hub shows the edit', async () => {
  for (const command of [drainRunner, undrainRunner]) {
    const draining = command === drainRunner;
    const s = await setupTestService({
      mode: 'service',
      noCredentials: true,
      // runner.json's loginProbe has a 60 s floor even in test mode; the host's clock shortens the wait.
      host: { clock: { ...systemClock, setTimeout: (fn, ms) => systemClock.setTimeout(fn, ms === 60_000 ? 30 : ms) } },
    });
    const runs = new ServiceRuns(s.paths);
    // An undrain also clears the crash loop, so createRunner does not drain again.
    if (!draining) crashes(runs);
    const starting = s.start();
    await waitFor(async () => {
      try {
        return (await controlRequest<{ link: string }>(s.paths, 'GET', '/health')).link === 'needs_login';
      } catch {
        return false;
      }
    });
    expect(await command({ paths: s.paths })).toEqual({ via: 'runner', draining });
    expect(loadRunnerConfig(s.paths.config).draining).toBe(draining);
    expect(runs.crashLoop()).toBeNull();
    writeFileSync(join(s.configDir, CREDENTIALS_FILE), JSON.stringify(s.hub.credentials));
    const service = await starting;
    const id = await online(service);
    await waitFor(() => getRunner(s.hub.ctx, id).draining === draining);
    expect(getRunner(s.hub.ctx, id)).toMatchObject({ state: 'online', draining });
    // The hub's echo confirms the edit in runner.json after the hub has applied it.
    await waitFor(() => loadRunnerConfig(s.paths.config).confirmedSettings.draining === draining);
    expect(loadRunnerConfig(s.paths.config).draining).toBe(draining);
    await service.stop('done');
  }
});

test('the guard uses the configured window and logs only when it reports a crash loop', async () => {
  const s = await setupTestService({ config: { timings: { crashLoopWindow: 100 } } });
  const runs = new ServiceRuns(s.paths, { now: () => 1_000 });
  crashes(runs);
  const logger = memoryLogger();
  const report: { detail: string | null } = { detail: null };
  const health = {
    setCrashLoop: (value: string | null) => {
      report.detail = value;
    },
  };
  expect(applyCrashLoopGuard({ runs, config: s.config, health, now: 1_100, logger })).toBe(false);
  expect(report.detail).toBeNull();
  expect(logger.entries).toEqual([]);
  expect(applyCrashLoopGuard({ runs, config: s.config, health, now: 1_099, logger })).toBe(true);
  expect(report.detail).toContain('crash 3');
  expect(logger.entries).toHaveLength(1);
  expect(logger.entries[0]?.level).toBe('error');
  expect(runs.crashLoop()).not.toBeNull();
});

for (const command of [drainRunner, undrainRunner]) {
  test(`${command.name} reports the lock holder when no socket answers, without editing files`, async () => {
    const s = await setupTestService();
    const runs = new ServiceRuns(s.paths);
    crashes(runs);
    const before = readFileSync(s.paths.config, 'utf8');
    const history = readFileSync(runs.path, 'utf8');
    const lock = await acquireRunnerLock(s.paths, { mode: 'foreground' });
    afterThisTest(() => lock.release());
    await expect(command({ paths: s.paths })).rejects.toThrow(`pid ${process.pid}`);
    await expect(command({ paths: s.paths })).rejects.toThrow('agflow runner status');
    expect(readFileSync(s.paths.config, 'utf8')).toBe(before);
    expect(readFileSync(runs.path, 'utf8')).toBe(history);
  });

  test(`${command.name} preserves a starting service's error instead of falling back to runner.json`, async () => {
    const s = await setupTestService();
    const requested = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const starting = s.start({
      fetch: async (input, init) => {
        requested.resolve();
        await resume.promise;
        return fetch(input, init);
      },
    });
    try {
      await requested.promise;
      await expect(command({ paths: s.paths })).rejects.toThrow('the runner is starting');
      expect(loadRunnerConfig(s.paths.config).draining).toBe(false);
    } finally {
      resume.resolve();
      await starting;
    }
  });

  test(`${command.name} reports the holder when its socket accepts but never answers`, async () => {
    const s = await setupTestService();
    const before = readFileSync(s.paths.config, 'utf8');
    const lock = await acquireRunnerLock(s.paths, { mode: 'foreground' });
    afterThisTest(() => lock.release());
    const pending = Promise.withResolvers<void>();
    const server = startControlServer({
      paths: s.paths,
      lock,
      routes: { 'POST /drain': () => pending.promise, 'POST /undrain': () => pending.promise },
    });
    afterThisTest(() => {
      pending.resolve();
      server.stop();
    });
    await expect(command({ paths: s.paths, timeoutMs: 20 })).rejects.toThrow(`pid ${process.pid}`);
    expect(readFileSync(s.paths.config, 'utf8')).toBe(before);
  });

  test(`${command.name} releases its offline lock if runner.json cannot be loaded`, async () => {
    const s = await setupTestService();
    rmSync(s.paths.config);
    await expect(command({ paths: s.paths })).rejects.toThrow('agflow runner setup');
    expect(readLockOwner(s.paths)).toBeNull();
  });
}
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `bun test packages/runner/test/service/drain.test.ts packages/cli/test/runner-command.test.ts`
Expected: FAIL — `(fail) agflow runner > help includes the runner commands` with `Expected to contain: "agflow runner drain"`; the other new drain and undrain CLI tests fail too, and `drain.test.ts` fails on `error: Cannot find module '../../src/service/drain' from 'packages/runner/test/service/drain.test.ts'` (13 pass, 9 fail, 1 error)

- [ ] **Step 3: Implement**

**File:** `packages/cli/src/runner-command.ts` (change)

```diff
diff --git a/packages/cli/src/runner-command.ts b/packages/cli/src/runner-command.ts
index 32b51f81..b401440c 100644
--- a/packages/cli/src/runner-command.ts
+++ b/packages/cli/src/runner-command.ts
@@ -13,6 +13,8 @@ import { selfCommand } from './self';
 /** The runner subcommands' lines in main.ts's HELP; each subcommand adds its own. */
 export const RUNNER_HELP = `  agflow runner start [--service]
                                 Run this laptop's runner in the foreground (--service for launchd)
+  agflow runner drain            Stop accepting new attempts
+  agflow runner undrain          Accept new attempts and clear the crash-loop guard
 `;
 
 export async function runnerCommand(
@@ -20,6 +22,20 @@ export async function runnerCommand(
   io: Io,
   deps: { startRunnerService?: typeof startRunnerService } = {},
 ): Promise<number> {
+  const drainingCommand =
+    (draining: boolean): Command =>
+    async (args, io) => {
+      const name = draining ? 'drain' : 'undrain';
+      if (args.positional.length > 2) throw new UsageError(`usage: agflow runner ${name}`);
+      const { drainRunner, undrainRunner } = await import('@agflow/runner/src/service/drain');
+      const result = await (draining ? drainRunner : undrainRunner)();
+      io.out(
+        result.via === 'runner'
+          ? `the runner is ${draining ? 'draining' : 'undrained'}\n`
+          : `${name}ed in runner.json; the hub hears it after the next start\n`,
+      );
+      return 0;
+    };
   const commands: Record<string, Command> = {
     // The host logs and prints every reason; the exit code is the ServiceExit's.
     start: async (args, io) => {
@@ -34,6 +50,8 @@ export async function runnerCommand(
       });
       return (await service.exited).code;
     },
+    drain: drainingCommand(true),
+    undrain: drainingCommand(false),
   };
   const name = args.positional[1];
   const command = name !== undefined && Object.hasOwn(commands, name) ? commands[name] : undefined;
```

**File:** `packages/runner/src/service/drain.ts` (new)

```ts
// Local draining (design 6.3, 7.1, X-12, X-41): the live runner owns settings edits; offline edits hold its lock.
import { editLocalSettings, loadRunnerConfig, type RunnerConfig, saveRunnerConfig } from '../config';
import { type Logger, noopLogger } from '../log';
import type { ServiceHealth } from '../ops/health';
import { type RunnerPaths, runnerPaths } from '../paths';
import { controlRequest, ControlUnavailableError } from './control';
import { AlreadyRunningError, acquireRunnerLock, type RunnerLock } from './lock';
import { crashLoopVerdict, ServiceRuns } from './runs';

export interface DrainOptions {
  paths?: RunnerPaths;
  /** Bounds the control request before trying the lock; controlRequest's default otherwise. */
  timeoutMs?: number;
}

export interface DrainResult {
  via: 'runner' | 'config';
  draining: boolean;
}

async function changeDraining(options: DrainOptions, draining: boolean): Promise<DrainResult> {
  const paths = options.paths ?? runnerPaths();
  try {
    await controlRequest(paths, 'POST', draining ? '/drain' : '/undrain', undefined, {
      timeoutMs: options.timeoutMs,
    });
    return { via: 'runner', draining };
  } catch (error) {
    // A route error belongs to the running service; only an unavailable socket permits an offline edit.
    if (!(error instanceof ControlUnavailableError)) throw error;
  }
  let lock: RunnerLock;
  try {
    lock = await acquireRunnerLock(paths, { mode: 'foreground', wait: false });
  } catch (error) {
    if (!(error instanceof AlreadyRunningError)) throw error;
    // A runner still starting, or one that stopped answering: runner.json is its to write.
    throw new Error(
      `runner.lock is held by pid ${error.pid ?? 'unknown'}, but no runner answers on its control socket; ` +
        'try again in a moment, or check agflow runner status',
    );
  }
  try {
    const config = loadRunnerConfig(paths.config);
    saveRunnerConfig(paths.config, editLocalSettings(config, { draining }).config);
    if (!draining) new ServiceRuns(paths).forgetUnclean();
    return { via: 'config', draining };
  } finally {
    lock.release();
  }
}

export function drainRunner(options: DrainOptions = {}): Promise<DrainResult> {
  return changeDraining(options, true);
}

export function undrainRunner(options: DrainOptions = {}): Promise<DrainResult> {
  return changeDraining(options, false);
}

/** Set hello's health before createRunner; the host then self-drains through RunnerHandle.changeSettings. */
export function applyCrashLoopGuard(options: {
  runs: ServiceRuns;
  config: Pick<RunnerConfig, 'timings'>;
  health: Pick<ServiceHealth, 'setCrashLoop'>;
  now?: number;
  logger?: Logger;
}): boolean {
  const { runs, config, health } = options;
  const verdict = crashLoopVerdict(runs, { now: options.now ?? Date.now(), window: config.timings.crashLoopWindow });
  if (!verdict.crashLoop) return false;
  if (runs.crashLoop() === null) runs.markCrashLoop(verdict);
  const detail = (verdict.lastError ?? 'repeated unclean exits').replace(/[\r\n]+/g, ' ');
  health.setCrashLoop(detail);
  (options.logger ?? noopLogger).error(`crash_loop: ${detail}; run agflow runner undrain to clear`);
  return true;
}
```

**File:** `packages/runner/src/service/host.ts` (change)

```diff
diff --git a/packages/runner/src/service/host.ts b/packages/runner/src/service/host.ts
index 417068b1..45e8e916 100644
--- a/packages/runner/src/service/host.ts
+++ b/packages/runner/src/service/host.ts
@@ -6,7 +6,7 @@ import { createAdapters } from '../adapters';
 import type { AgflowCommand, VendorAdapter } from '../adapters/types';
 import { AttemptStore } from '../attempt-store';
 import { type ClockSource, systemClock } from '../clock';
-import { isTestMode, loadRunnerConfig, type RunnerConfig } from '../config';
+import { editLocalSettings, isTestMode, loadRunnerConfig, type RunnerConfig, saveRunnerConfig } from '../config';
 import { openRunnerDb, type RunnerDb } from '../db';
 import type { FetchFn } from '../hub-http';
 import { Journal } from '../journal';
@@ -24,6 +24,7 @@ import { createRunner, type RunnerEvents, type RunnerHandle, type RunnerOptions
 import type { DependencyPreparer, Notifier } from '../seams';
 import { type ControlRoutes, type ControlServer, startControlServer } from './control';
 import { readCliCredentials } from './credentials';
+import { applyCrashLoopGuard } from './drain';
 import { AlreadyRunningError, acquireRunnerLock, type RunnerLock, type RunnerMode } from './lock';
 import { RotatingLog } from './log';
 import { machineMismatch, readMachineId } from './machine';
@@ -160,6 +161,7 @@ export async function startRunnerService(options: RunnerServiceOptions): Promise
   let db: RunnerDb | null = null;
   let store: AttemptStore | null = null;
   let runner: RunnerHandle | null = null;
+  let config: RunnerConfig;
   const clock = options.clock ?? systemClock;
   let health: ServiceHealth | null = null;
   let keepAwake: KeepAwake | null = null;
@@ -174,6 +176,10 @@ export async function startRunnerService(options: RunnerServiceOptions): Promise
   const sweeping = new AbortController();
   let ending = false;
   let suspendMs = 0;
+  // The guard's verdict at start: createRunner then drains through changeSettings unless an undrain came first.
+  let crashLoop = false;
+  // While a --service start waits for credentials.json it holds the lock and runner.json, but has no runner yet.
+  let awaitingCredentials = false;
 
   // A person must act: exit 0 under launchd so KeepAlive does not loop, 1 in the foreground.
   const refusal = (reason: string): ServiceExit => ({ code: mode === 'service' ? 0 : 1, clean: true, reason });
@@ -289,6 +295,8 @@ export async function startRunnerService(options: RunnerServiceOptions): Promise
 
   // The control socket's routes; the commands of later tasks add theirs here.
   const routes: ControlRoutes = {
+    'POST /drain': () => changeDraining(true),
+    'POST /undrain': () => changeDraining(false),
     'POST /suspend': () => {
       void service.suspend('suspend requested');
     },
@@ -303,6 +311,20 @@ export async function startRunnerService(options: RunnerServiceOptions): Promise
       };
     },
   };
+  async function changeDraining(draining: boolean): Promise<void> {
+    if (runner !== null) await runner.changeSettings({ draining });
+    else if (awaitingCredentials) {
+      // The wait can last until the owner signs in: runner.json takes the edit, which createRunner then starts from,
+      // and M2b sends it after the first welcome.
+      config = editLocalSettings(config, { draining }).config;
+      saveRunnerConfig(paths.config, config);
+    } else throw new Error('the runner is starting; try again');
+    if (draining) return;
+    runs!.forgetUnclean({ current: runId! });
+    health!.setCrashLoop(null);
+    crashLoop = false;
+  }
+
   // One observer object keeps operations attached across reconnects.
   const events: RunnerEvents = {
     link: (state, detail) => {
@@ -345,7 +367,6 @@ export async function startRunnerService(options: RunnerServiceOptions): Promise
     logger.info('runner service starting', { pid: process.pid, mode });
     runs = new ServiceRuns(paths);
     runId = runs.start({ pid: process.pid, mode });
-    let config: RunnerConfig;
     try {
       config = loadRunnerConfig(paths.config);
       suspendMs = config.timings.suspend;
@@ -382,6 +403,7 @@ export async function startRunnerService(options: RunnerServiceOptions): Promise
       clock,
       logger,
     });
+    crashLoop = applyCrashLoopGuard({ runs, config, health, logger });
     keepAwake = new KeepAwake({
       mode: () => runner?.status().settings.keepAwake ?? config.keepAwake,
       power: () => health?.power() ?? null,
@@ -406,6 +428,7 @@ export async function startRunnerService(options: RunnerServiceOptions): Promise
     });
     if (credentials === null) {
       needsLogin.enter(read.problem ?? 'not signed in');
+      awaitingCredentials = true;
       while (!ending && credentials === null) {
         await new Promise<void>((resolve) => {
           const done = () => {
@@ -420,6 +443,7 @@ export async function startRunnerService(options: RunnerServiceOptions): Promise
         if (ending) return;
         credentials = readCredentials().credentials;
       }
+      awaitingCredentials = false;
       if (ending) return;
       hubUrl = credentials!.hubUrl;
     }
@@ -446,6 +470,7 @@ export async function startRunnerService(options: RunnerServiceOptions): Promise
       fetch: options.fetch,
       tmpRoot: options.tmpRoot,
     });
+    if (crashLoop) await runner.changeSettings({ draining: true });
     health.start();
     keepAwake.evaluate();
     const retentionInput = {
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `bun test packages/runner/test/service/drain.test.ts packages/cli/test/runner-command.test.ts packages/runner/test/service/host.test.ts && bun test && bun run typecheck`
Expected: the task's tests pass; then the whole suite passes (`0 fail`) and `tsc` exits 0.

Only a `ControlUnavailableError` (nothing listening, or no answer in time) allows the offline edit; a route error such as "the runner is starting; try again" is passed on. While the service waits for credentials, its routes edit runner.json under its own lock. The guard runs after the run is recorded and before `createRunner`, so the first hello already reports `crash_loop`; the self-drain follows right after `createRunner`, unless an undrain came first. `runner-command.test.ts` sets `setDefaultTimeout(60_000)` from here on, because its tests start services.

- [ ] **Step 5: Commit**

```bash
git add -A 'packages/cli/src/runner-command.ts' 'packages/cli/test/runner-command.test.ts' 'packages/runner/src/service/drain.ts' 'packages/runner/src/service/host.ts' 'packages/runner/test/service/drain.test.ts'
git commit -m 'M2C Task 19: `drain`, `undrain` and the crash-loop guard' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

### Task 20: The LaunchAgent and `agflow runner install`

Writes `~/Library/LaunchAgents/dev.agflow.runner.plist` and bootstraps it in `gui/<uid>` (design 7.1). The plist runs the absolute agflow command with `runner start --service` in the Aqua session, with the captured `PATH`, the connectivity variables and `NODE_USE_SYSTEM_CA=1`, `KeepAlive { SuccessfulExit: false }`, `ExitTimeOut 60`, `ThrottleInterval 30`, 65536 files, `ProcessType Interactive` and its logs under logs/. Install first installs missing pins, which is the upgrade path, then boots out the old job, waits for its lock and for launchd to drop it, and enables and bootstraps the new one. `installRefusal` refuses it in test mode (X-7, design 15.1), and a binary under ~/Desktop, ~/Documents or ~/Downloads gets a warning (Q18).

**Files:**
- Modify: `packages/cli/src/runner-command.ts`
- Test: `packages/cli/test/runner-command.test.ts`
- Create: `packages/runner/src/service/launchd.ts`
- Test: `packages/runner/test/service/launchd.test.ts`

- [ ] **Step 1: Write the failing tests**

**File:** `packages/cli/test/runner-command.test.ts` (change)

```diff
diff --git a/packages/cli/test/runner-command.test.ts b/packages/cli/test/runner-command.test.ts
index 58678b95..4fadda9e 100644
--- a/packages/cli/test/runner-command.test.ts
+++ b/packages/cli/test/runner-command.test.ts
@@ -1,22 +1,27 @@
 import { afterEach, beforeEach, describe, expect, mock, setDefaultTimeout, test } from 'bun:test';
 import { existsSync, readFileSync } from 'node:fs';
-import { join } from 'node:path';
+import { isAbsolute, join } from 'node:path';
 import { getAttempt } from '@agflow/hub/src/attempt-store';
 import { findRunnerByKey, getRunner } from '@agflow/hub/src/runners';
 import { createTasks } from '@agflow/hub/src/tasks';
 import { newTask } from '@agflow/hub/test/helpers';
-import { loadRunnerConfig } from '@agflow/runner/src/config';
+import { loadRunnerConfig, RunnerConfigSchema, saveRunnerConfig } from '@agflow/runner/src/config';
 import { openRunnerDb } from '@agflow/runner/src/db';
 import { Outbox } from '@agflow/runner/src/outbox';
 import { runnerPaths } from '@agflow/runner/src/paths';
 import type { RunnerServiceOptions } from '@agflow/runner/src/service/host';
+import {
+  installRefusal,
+  type installService as installRunnerService,
+  installService as realInstallService,
+} from '@agflow/runner/src/service/launchd';
 import { acquireRunnerLock, readLockOwner } from '@agflow/runner/src/service/lock';
 import { readMachineId } from '@agflow/runner/src/service/machine';
 import { ServiceRuns } from '@agflow/runner/src/service/runs';
 import { waitFor } from '@agflow/runner/test/fixture';
 import { startRunnerAttempt } from '@agflow/runner/test/hub-fixture';
 import { afterThisTest, cleanupRunnerSetups, tempDir } from '@agflow/runner/test/runner-setup';
-import { setupTestService } from '@agflow/runner/test/service-helpers';
+import { recordingExec, setupTestService } from '@agflow/runner/test/service-helpers';
 import { parseArgs } from '../src/args';
 import { main } from '../src/main';
 import { configDir } from '../src/paths';
@@ -61,6 +66,7 @@ describe('agflow runner', () => {
     expect(RUNNER_HELP).toContain('agflow runner start [--service]');
     expect(RUNNER_HELP).toContain('agflow runner drain');
     expect(RUNNER_HELP).toContain('agflow runner undrain');
+    expect(RUNNER_HELP).toContain('agflow runner install');
     expect(out.join('')).toContain(RUNNER_HELP);
     expect(err).toEqual([]);
   });
@@ -85,6 +91,70 @@ console.log(JSON.stringify(Object.keys(require.cache).filter((path) => path.incl
     expect(err.join('')).toContain('agflow runner start');
   });
 
+  test('install rejects extra positional arguments', async () => {
+    const { io, out, err } = capture();
+    expect(await main(['runner', 'install', 'extra'], io)).toBe(2);
+    expect(err.join('')).toContain('usage: agflow runner install');
+    expect(out).toEqual([]);
+  });
+
+  test('install passes runner paths, the absolute source command and environment, and prints its result', async () => {
+    const { io, out, err } = capture();
+    const result = { plistPath: '/scratch/agent.plist', target: 'gui/501/dev.agflow.runner', warnings: ['warning'] };
+    const installService = mock(async (options: Parameters<typeof installRunnerService>[0]) => {
+      expect(options.paths.home).toBe(process.env.AGFLOW_HOME!);
+      expect(options.agflow).toEqual(selfCommand());
+      expect(isAbsolute(options.agflow.command)).toBe(true);
+      // The source form may put Bun options before main.ts; the installer checks its own paths.
+      expect(options.agflow.args.at(-1)).toBe(MAIN);
+      expect(options.env).toBe(process.env);
+      options.log?.('pins ready');
+      options.log?.('warning');
+      return result;
+    });
+    expect(await runnerCommand(parseArgs(['runner', 'install']), io, { installService })).toBe(0);
+    expect(installService).toHaveBeenCalledTimes(1);
+    expect(err).toEqual(['pins ready\n', 'warning\n']);
+    expect(out).toEqual(['installed /scratch/agent.plist; the runner starts as gui/501/dev.agflow.runner\n']);
+  });
+
+  test('install reports failures on stderr and exits 1', async () => {
+    const { io, out, err } = capture();
+    const installService = async () => {
+      throw new Error('bootstrap failed');
+    };
+    expect(await runnerCommand(parseArgs(['runner', 'install']), io, { installService })).toBe(1);
+    expect(out).toEqual([]);
+    expect(err).toEqual(['agflow: bootstrap failed\n']);
+  });
+
+  test('install refuses test mode through the real installer before touching launchd', async () => {
+    const paths = runnerPaths();
+    saveRunnerConfig(
+      paths.config,
+      RunnerConfigSchema.parse({
+        runnerKey: 'rk_install',
+        machineId: 'MACHINE-1',
+        name: 'laptop',
+        test: {},
+      }),
+    );
+    const message = installRefusal(loadRunnerConfig(paths.config));
+    // The real installer, with launchd, the LaunchAgents folder and the pins kept to scratch should it ever pass.
+    const exec = recordingExec();
+    const installPins = mock(async () => ({ claude: '/fake/claude', codex: '/fake/codex' }));
+    const home = tempDir('agf-home-');
+    const installService = (options: Parameters<typeof installRunnerService>[0]) =>
+      realInstallService({ ...options, exec, home, uid: 501, installPins });
+    const { io, out, err } = capture();
+    expect(await runnerCommand(parseArgs(['runner', 'install']), io, { installService })).toBe(1);
+    expect(out).toEqual([]);
+    expect(err).toEqual([`agflow: ${message}\n`]);
+    expect(exec.calls).toEqual([]);
+    expect(installPins).not.toHaveBeenCalled();
+    expect(existsSync(join(home, 'Library'))).toBe(false);
+  });
+
   test('drain and undrain reach the running service and print one line each', async () => {
     const s = await setupTestService();
     process.env.AGFLOW_HOME = s.paths.home;
```

**File:** `packages/runner/test/service/launchd.test.ts` (new)

```ts
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { CONNECTIVITY_VARS, RunnerConfigSchema, saveRunnerConfig } from '../../src/config';
import { runnerPaths } from '../../src/paths';
import {
  bootoutService,
  disableService,
  installRefusal,
  installService,
  kickstartService,
  LAUNCHD_LABEL,
  plistPath,
  programPaths,
  renderPlist,
  serviceLoaded,
  serviceTarget,
} from '../../src/service/launchd';
import { acquireRunnerLock } from '../../src/service/lock';
import { defaultExec, type Exec } from '../../src/service/system';
import { afterThisTest, cleanupRunnerSetups, tempDir } from '../runner-setup';
import { recordingExec } from '../service-helpers';

beforeEach(() => {
  const previous = process.env.AGFLOW_TEST;
  delete process.env.AGFLOW_TEST;
  afterThisTest(() => {
    if (previous === undefined) delete process.env.AGFLOW_TEST;
    else process.env.AGFLOW_TEST = previous;
  });
});
afterEach(cleanupRunnerSetups);

const special = `&<>"'`;
const escaped = '&amp;&lt;&gt;&quot;&apos;';
const input = {
  label: 'dev.agflow.runner',
  programArguments: ['/opt/agflow', 'runner', 'start', '--service'],
  environment: { Z: special, A: 'first' },
  stdout: '/tmp/logs/out',
  stderr: '/tmp/logs/err',
};

/** launchctl as installService meets it: print finds no job once bootout has run. */
function launchd(scripts: Parameters<typeof recordingExec>[0] = []) {
  const gone = ['dev.agflow.runner', 'dev.agflow.scratch'].map((label) => ({
    argv: ['launchctl', 'print', `gui/501/${label}`],
    result: { exitCode: 113, stderr: 'Could not find service' },
  }));
  return recordingExec([...scripts, ...gone]);
}

function setup() {
  const home = tempDir('agf-launchd-');
  const paths = runnerPaths(join(home, '.agflow'));
  const config = RunnerConfigSchema.parse({
    runnerKey: 'rk_launchd',
    machineId: 'MACHINE-1',
    name: 'laptop',
    capturedPath: '/captured/bin:/usr/bin',
    connectivity: Object.fromEntries(CONNECTIVITY_VARS.map((key) => [key, special])),
  });
  saveRunnerConfig(paths.config, config);
  const exec = launchd();
  const installPins = mock(async () => ({ claude: '/fake/claude', codex: '/fake/codex' }));
  return {
    home,
    paths,
    config,
    exec,
    installPins,
    options: { paths, home, uid: 501, exec, installPins, agflow: { command: '/opt/agflow', args: [] }, env: {} },
  };
}

describe('LaunchAgent plist', () => {
  test('paths and targets default to the owner and accept a scratch label and home', () => {
    expect(LAUNCHD_LABEL).toBe('dev.agflow.runner');
    expect(plistPath()).toBe(join(homedir(), 'Library/LaunchAgents/dev.agflow.runner.plist'));
    expect(plistPath({ home: '/tmp/owner', label: 'dev.agflow.scratch' })).toBe(
      '/tmp/owner/Library/LaunchAgents/dev.agflow.scratch.plist',
    );
    expect(serviceTarget()).toBe(`gui/${process.getuid!()}/dev.agflow.runner`);
    expect(serviceTarget('dev.agflow.scratch', 123)).toBe('gui/123/dev.agflow.scratch');
  });

  test('renders every required key with its plist type and escapes every string', () => {
    const xml = renderPlist(input);
    expect(xml).toStartWith('<?xml version="1.0" encoding="UTF-8"?>\n');
    expect(xml).toContain(
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ' + '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    );
    expect(xml).toContain('<plist version="1.0">\n<dict>');
    for (const [key, value] of [
      ['Label', '<string>dev.agflow.runner</string>'],
      [
        'ProgramArguments',
        '<array>\n<string>/opt/agflow</string>\n<string>runner</string>\n' +
          '<string>start</string>\n<string>--service</string>\n</array>',
      ],
      [
        'EnvironmentVariables',
        `<dict>\n<key>A</key>\n<string>first</string>\n<key>Z</key>\n` + `<string>${escaped}</string>\n</dict>`,
      ],
      ['KeepAlive', '<dict>\n<key>SuccessfulExit</key>\n<false/>\n</dict>'],
      ['ExitTimeOut', '<integer>60</integer>'],
      ['ThrottleInterval', '<integer>30</integer>'],
      ['HardResourceLimits', '<dict>\n<key>NumberOfFiles</key>\n<integer>65536</integer>\n</dict>'],
      ['ProcessType', '<string>Interactive</string>'],
      ['LimitLoadToSessionType', '<string>Aqua</string>'],
      ['StandardOutPath', '<string>/tmp/logs/out</string>'],
      ['StandardErrorPath', '<string>/tmp/logs/err</string>'],
    ]) {
      expect(xml).toContain(`<key>${key}</key>\n${value}`);
    }
    expect(xml).toEndWith('</dict>\n</plist>\n');
    const all = renderPlist({
      label: special,
      programArguments: [special],
      environment: { [special]: special },
      stdout: special,
      stderr: special,
    });
    expect(all.match(new RegExp(escaped, 'g'))).toHaveLength(6);
  });

  test.skipIf(process.platform !== 'darwin')('plutil accepts the plist and round trips its values', async () => {
    const path = join(tempDir('agf-plist-'), 'test.plist');
    writeFileSync(path, renderPlist(input));
    const lint = await defaultExec(['plutil', '-lint', path], { timeoutMs: 10_000 });
    expect(lint.exitCode).toBe(0);
    const json = await defaultExec(['plutil', '-convert', 'json', '-o', '-', path], { timeoutMs: 10_000 });
    expect(json.exitCode).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({
      EnvironmentVariables: input.environment,
      ProgramArguments: input.programArguments,
      KeepAlive: { SuccessfulExit: false },
      HardResourceLimits: { NumberOfFiles: 65536 },
    });
  });
});

describe('installService', () => {
  test('installs pins before publishing, then bootout, enable and bootstrap despite failed bootout', async () => {
    const s = setup();
    const path = plistPath({ home: s.home });
    const exec = launchd([
      { argv: ['launchctl', 'bootout', serviceTarget(undefined, 501)], result: { exitCode: 3, stderr: 'not loaded' } },
    ]);
    const installPins = mock(async (paths, options) => {
      expect(paths).toBe(s.paths);
      expect(existsSync(path)).toBe(false);
      expect(existsSync(s.paths.logs)).toBe(false);
      expect(exec.calls).toHaveLength(0);
      options.log('pins ready');
      return { claude: '/fake/claude', codex: '/fake/codex' };
    });
    const log = mock(() => {});
    const result = await installService({ ...s.options, exec, installPins, log });
    expect(result).toEqual({ plistPath: path, target: 'gui/501/dev.agflow.runner', warnings: [] });
    expect(installPins).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('pins ready');
    expect(exec.calls.map((call) => call.argv)).toEqual([
      ['launchctl', 'bootout', result.target],
      ['launchctl', 'print', result.target],
      ['launchctl', 'enable', result.target],
      ['launchctl', 'bootstrap', 'gui/501', path],
    ]);
    // bootout waits out the old service's suspend under launchd's ExitTimeOut.
    expect(exec.calls.map((call) => call.options?.timeoutMs)).toEqual([75_000, 30_000, 30_000, 30_000]);
    expect(statSync(path).mode & 0o777).toBe(0o644);
    expect(statSync(s.paths.logs).mode & 0o777).toBe(0o700);
    expect(readdirSync(join(s.home, 'Library/LaunchAgents'))).toEqual(['dev.agflow.runner.plist']);
    const xml = readFileSync(path, 'utf8');
    expect(xml).toContain(`<string>${s.paths.logs}/launchd.out.log</string>`);
    expect(xml).toContain(`<string>${s.paths.logs}/launchd.err.log</string>`);
    expect(xml).toContain('<key>PATH</key>\n<string>/captured/bin:/usr/bin</string>');
    expect(xml).toContain('<key>NODE_USE_SYSTEM_CA</key>\n<string>1</string>');
    for (const key of CONNECTIVITY_VARS) expect(xml).toContain(`<key>${key}</key>\n<string>${escaped}</string>`);
    expect(xml).not.toContain('<key>AGFLOW_HOME</key>');
    expect(xml).not.toContain('<key>AGFLOW_CONFIG_DIR</key>');
  });

  test('scratch label, homes and source program paths follow the service without leaking shell variables', async () => {
    const s = setup();
    const main = resolve(import.meta.dir, '../../../cli/src/main.ts');
    const result = await installService({
      ...s.options,
      label: 'dev.agflow.scratch',
      agflow: { command: process.execPath, args: [main] },
      env: { AGFLOW_HOME: s.paths.home, AGFLOW_CONFIG_DIR: 'scratch-config', SECRET: 'do-not-copy', PATH: '/wrong' },
    });
    expect(result.plistPath).toBe(plistPath({ home: s.home, label: 'dev.agflow.scratch' }));
    expect(result.target).toBe('gui/501/dev.agflow.scratch');
    const xml = readFileSync(result.plistPath, 'utf8');
    expect(xml).toContain('<key>Label</key>\n<string>dev.agflow.scratch</string>');
    expect(xml).toContain(
      `<string>${process.execPath}</string>\n<string>${main}</string>\n` +
        '<string>runner</string>\n<string>start</string>\n<string>--service</string>',
    );
    expect(xml).toContain(`<key>AGFLOW_HOME</key>\n<string>${s.paths.home}</string>`);
    expect(xml).toContain(`<key>AGFLOW_CONFIG_DIR</key>\n<string>${resolve('scratch-config')}</string>`);
    expect(xml).not.toContain('SECRET');
    expect(xml).not.toContain('/wrong');
    expect(s.exec.calls.map((call) => call.argv)).toEqual([
      ['launchctl', 'bootout', result.target],
      ['launchctl', 'print', result.target],
      ['launchctl', 'enable', result.target],
      ['launchctl', 'bootstrap', 'gui/501', result.plistPath],
    ]);
  });

  test('a hardened source command keeps its options in order and checks only its paths', async () => {
    const s = setup();
    const agflow = { command: '/opt/bun', args: ['--no-env-file', '--config=/abs/bunfig.toml', '/abs/main.ts'] };
    const result = await installService({ ...s.options, agflow });
    expect(result.warnings).toEqual([]);
    expect(readFileSync(result.plistPath, 'utf8')).toContain(
      '<key>ProgramArguments</key>\n<array>\n<string>/opt/bun</string>\n<string>--no-env-file</string>\n' +
        '<string>--config=/abs/bunfig.toml</string>\n<string>/abs/main.ts</string>\n' +
        '<string>runner</string>\n<string>start</string>\n<string>--service</string>\n</array>',
    );
    expect(programPaths(agflow)).toEqual(['/opt/bun', '/abs/bunfig.toml', '/abs/main.ts']);
    const separate = { command: '/opt/bun', args: ['--config', '/abs/bunfig.toml', '/abs/main.ts'] };
    expect(programPaths(separate)).toEqual(['/opt/bun', '/abs/bunfig.toml', '/abs/main.ts']);
  });
  test.each(['Desktop', 'Documents', 'Downloads'])('warns for a program path under %s', async (folder) => {
    const s = setup();
    const log = mock(() => {});
    const result = await installService({
      ...s.options,
      agflow: { command: '/opt/bun', args: ['--no-env-file', join(s.home, folder, 'agflow/main.ts')] },
      log,
    });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain(join(s.home, folder, 'agflow/main.ts'));
    expect(result.warnings[0]).toContain('folder access');
    expect(result.warnings[0]).toContain('~/.local/bin');
    expect(result.warnings[0]).toContain('install again');
    expect(log).toHaveBeenCalledWith(result.warnings[0]);
  });

  test.each([
    { command: 'agflow', args: [] },
    { command: '/opt/bun', args: ['main.ts'] },
    { command: '/opt/bun', args: ['--config=bunfig.toml', '/abs/main.ts'] },
  ])('refuses relative executable or source paths before side effects', async (agflow) => {
    const s = setup();
    await expect(
      installService({ ...s.options, agflow: { command: agflow.command, args: [...agflow.args] } }),
    ).rejects.toThrow('absolute');
    expect(s.installPins).not.toHaveBeenCalled();
    expect(s.exec.calls).toEqual([]);
  });

  test('waits for a service lock after bootout and before enable or bootstrap', async () => {
    const s = setup();
    const lock = await acquireRunnerLock(s.paths, { mode: 'service' });
    afterThisTest(() => lock.release());
    let bootedOut!: () => void;
    const bootout = new Promise<void>((resolve) => {
      bootedOut = resolve;
    });
    const exec: Exec = async (argv, options) => {
      const result = await s.exec(argv, options);
      if (argv[1] === 'bootout') bootedOut();
      else expect(lock.held).toBe(false);
      return result;
    };
    const installing = installService({ ...s.options, exec, lockPollMs: 5, lockWaitMs: 1_000 });
    await bootout;
    await Bun.sleep(25);
    expect(s.exec.calls.map((call) => call.argv[1])).toEqual(['bootout']);
    lock.release();
    await installing;
    expect(s.exec.calls.map((call) => call.argv[1])).toEqual(['bootout', 'print', 'enable', 'bootstrap']);
  });

  test('bootstraps only once launchd has removed the job a timed out bootout left', async () => {
    const s = setup();
    const calls: string[] = [];
    let prints = 0;
    const exec: Exec = async (argv, options) => {
      calls.push(argv[1]!);
      if (argv[1] === 'bootout') {
        expect(options).toEqual({ timeoutMs: 75_000 });
        return { exitCode: 1, stdout: '', stderr: '', timedOut: true };
      }
      // print finds the job once, then launchd has removed it.
      const exitCode = argv[1] === 'print' && prints++ > 0 ? 113 : 0;
      return { exitCode, stdout: '', stderr: '', timedOut: false };
    };
    await installService({ ...s.options, exec, lockPollMs: 5, lockWaitMs: 1_000 });
    expect(calls).toEqual(['bootout', 'print', 'print', 'enable', 'bootstrap']);
  });

  test('a job launchd never removes aborts the install before bootstrap', async () => {
    const s = setup();
    const exec = recordingExec();
    await expect(installService({ ...s.options, exec, lockPollMs: 2, lockWaitMs: 20 })).rejects.toThrow(
      'launchd still has gui/501/dev.agflow.runner loaded',
    );
    expect(exec.calls.map((call) => call.argv[1]).filter((command) => command !== 'print')).toEqual(['bootout']);
  });

  test('times out naming a service pid and never bootstraps', async () => {
    const s = setup();
    const lock = await acquireRunnerLock(s.paths, { mode: 'service' });
    afterThisTest(() => lock.release());
    await expect(installService({ ...s.options, lockPollMs: 2, lockWaitMs: 10 })).rejects.toThrow(`pid ${process.pid}`);
    expect(s.exec.calls.map((call) => call.argv[1])).toEqual(['bootout']);
  });

  test('leaves a foreground runner alone and explains that the service waits for it', async () => {
    const s = setup();
    const lock = await acquireRunnerLock(s.paths, { mode: 'foreground' });
    afterThisTest(() => lock.release());
    const result = await installService({ ...s.options, lockWaitMs: 0 });
    expect(lock.held).toBe(true);
    expect(result.warnings.join(' ')).toContain(`pid ${process.pid}`);
    expect(result.warnings.join(' ')).toContain('service waits');
    expect(s.exec.calls).toHaveLength(4);
  });

  test.each(['env', 'config', 'both'])('refuses test mode from %s before any side effect', async (source) => {
    const s = setup();
    const env = source !== 'config' ? { AGFLOW_TEST: '1' } : {};
    const config = RunnerConfigSchema.parse({ ...s.config, ...(source !== 'env' ? { test: {} } : {}) });
    saveRunnerConfig(s.paths.config, config);
    const refusal = installRefusal(config, env);
    expect(refusal).toBeString();
    expect(refusal).toContain('test');
    expect(refusal).not.toContain('\n');
    await expect(installService({ ...s.options, env })).rejects.toThrow(refusal!);
    expect(s.installPins).not.toHaveBeenCalled();
    expect(s.exec.calls).toEqual([]);
    expect(existsSync(join(s.home, 'Library'))).toBe(false);
    expect(existsSync(s.paths.logs)).toBe(false);
  });

  test('installRefusal defaults to process.env and otherwise allows production', () => {
    const s = setup();
    expect(installRefusal(s.config)).toBeNull();
    process.env.AGFLOW_TEST = '1';
    expect(installRefusal(s.config)).toContain('test');
  });

  test('missing config points to setup without installing pins', async () => {
    const s = setup();
    rmSync(s.paths.config);
    await expect(installService(s.options)).rejects.toThrow('agflow runner setup');
    expect(s.installPins).not.toHaveBeenCalled();
    expect(s.exec.calls).toEqual([]);
  });

  test('pin failure leaves the existing plist and running service alone', async () => {
    const s = setup();
    const first = await installService(s.options);
    const original = readFileSync(first.plistPath, 'utf8');
    s.exec.calls.length = 0;
    await expect(
      installService({
        ...s.options,
        installPins: async () => {
          throw new Error('pin download failed');
        },
      }),
    ).rejects.toThrow('pin download failed');
    expect(readFileSync(first.plistPath, 'utf8')).toBe(original);
    expect(s.exec.calls).toEqual([]);
  });

  test.each(['enable', 'bootstrap'])('reports %s stderr and stops installation', async (command) => {
    const s = setup();
    const target = serviceTarget(undefined, 501);
    const argv =
      command === 'enable'
        ? ['launchctl', command, target]
        : ['launchctl', command, 'gui/501', plistPath({ home: s.home })];
    const exec = launchd([{ argv, result: { exitCode: 5, stderr: 'launchctl denied' } }]);
    const pending = installService({ ...s.options, exec });
    await expect(pending).rejects.toThrow('launchctl denied');
    if (command === 'bootstrap') await expect(pending).rejects.toThrow('logged-in desktop session');
    expect(exec.calls.at(-1)!.argv).toEqual(argv);
  });
});

describe('launchctl wrappers', () => {
  test('share target overrides and bound every command', async () => {
    const exec = recordingExec();
    const options = { exec, label: 'dev.agflow.scratch', uid: 123 };
    expect(await bootoutService(options)).toBe(true);
    await disableService(options);
    await kickstartService(options);
    expect(await serviceLoaded(options)).toBe(true);
    expect(exec.calls).toEqual(
      [
        ['launchctl', 'bootout', 'gui/123/dev.agflow.scratch'],
        ['launchctl', 'disable', 'gui/123/dev.agflow.scratch'],
        ['launchctl', 'kickstart', '-k', 'gui/123/dev.agflow.scratch'],
        ['launchctl', 'print', 'gui/123/dev.agflow.scratch'],
      ].map((argv) => ({
        argv,
        options: { timeoutMs: argv[1] === 'kickstart' ? 120_000 : argv[1] === 'bootout' ? 75_000 : 30_000 },
      })),
    );
  });

  test.each([
    { exitCode: 5, stderr: 'not loaded' },
    { timedOut: true, stderr: 'timed out' },
  ])('bootout and print tolerate failure; disable and kickstart report it', async (failure) => {
    const exec = recordingExec([], failure);
    expect(await bootoutService({ exec })).toBe(false);
    expect(await serviceLoaded({ exec })).toBe(false);
    await expect(disableService({ exec })).rejects.toThrow(failure.stderr);
    await expect(kickstartService({ exec })).rejects.toThrow(failure.stderr);
  });
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `bun test packages/runner/test/service/launchd.test.ts packages/cli/test/runner-command.test.ts`
Expected: FAIL — `error: Cannot find module '@agflow/runner/src/service/launchd' from 'packages/cli/test/runner-command.test.ts'`, and `launchd.test.ts` on `'../../src/service/launchd'` (0 pass, 2 fail, 2 errors)

- [ ] **Step 3: Implement**

**File:** `packages/cli/src/runner-command.ts` (change)

```diff
diff --git a/packages/cli/src/runner-command.ts b/packages/cli/src/runner-command.ts
index b401440c..00130946 100644
--- a/packages/cli/src/runner-command.ts
+++ b/packages/cli/src/runner-command.ts
@@ -4,6 +4,7 @@
 // when it runs: every other command, the hooks Claude Code and Codex run on each prompt above all, must not pay for
 // the runner's module graph. A static-string import() is still bundled by `bun build --compile`.
 import type { startRunnerService } from '@agflow/runner/src/service/host';
+import type { installService } from '@agflow/runner/src/service/launchd';
 import { type ParsedArgs, UsageError } from './args';
 import type { Io } from './io';
 import type { Command } from './main';
@@ -15,12 +16,13 @@ export const RUNNER_HELP = `  agflow runner start [--service]
                                 Run this laptop's runner in the foreground (--service for launchd)
   agflow runner drain            Stop accepting new attempts
   agflow runner undrain          Accept new attempts and clear the crash-loop guard
+  agflow runner install          Install and start the LaunchAgent that runs the runner at login
 `;
 
 export async function runnerCommand(
   args: ParsedArgs,
   io: Io,
-  deps: { startRunnerService?: typeof startRunnerService } = {},
+  deps: { startRunnerService?: typeof startRunnerService; installService?: typeof installService } = {},
 ): Promise<number> {
   const drainingCommand =
     (draining: boolean): Command =>
@@ -52,6 +54,24 @@ export async function runnerCommand(
     },
     drain: drainingCommand(true),
     undrain: drainingCommand(false),
+    install: async (args, io) => {
+      if (args.positional.length > 2) throw new UsageError('usage: agflow runner install');
+      try {
+        const install = deps.installService ?? (await import('@agflow/runner/src/service/launchd')).installService;
+        const { runnerPaths } = await import('@agflow/runner/src/paths');
+        const result = await install({
+          paths: runnerPaths(),
+          agflow: selfCommand(),
+          env: process.env,
+          log: (line) => io.err(`${line}\n`),
+        });
+        io.out(`installed ${result.plistPath}; the runner starts as ${result.target}\n`);
+        return 0;
+      } catch (error) {
+        io.err(`agflow: ${error instanceof Error ? error.message : String(error)}\n`);
+        return 1;
+      }
+    },
   };
   const name = args.positional[1];
   const command = name !== undefined && Object.hasOwn(commands, name) ? commands[name] : undefined;
```

**File:** `packages/runner/src/service/launchd.ts` (new)

```ts
// The per-user LaunchAgent (design 7.1): install upgrades pins, replaces the plist, and waits out the old service.
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { AgflowCommand } from '../adapters/types';
import { CONNECTIVITY_VARS, loadRunnerConfig, type RunnerConfig } from '../config';
import type { RunnerPaths } from '../paths';
import { ensurePinnedVendors } from '../vendor/install';
import { readLockOwner } from './lock';
import { launchdLogPaths } from './log';
import { defaultExec, type Exec, type ExecResult } from './system';

export const LAUNCHD_LABEL = 'dev.agflow.runner';

type Env = Record<string, string | undefined>;

interface LaunchctlOptions {
  exec?: Exec;
  label?: string;
  uid?: number;
}

interface PlistOptions {
  /** The user's home, not AGFLOW_HOME. */
  home?: string;
  label?: string;
}

interface PlistInput {
  label: string;
  programArguments: string[];
  environment: Record<string, string>;
  stdout: string;
  stderr: string;
}

interface InstallOptions extends LaunchctlOptions, PlistOptions {
  paths: RunnerPaths;
  agflow: AgflowCommand;
  env?: Env;
  installPins?: typeof ensurePinnedVendors;
  lockPollMs?: number;
  /** 90 s allows suspension (45 s), launchd's ExitTimeOut (60 s), and a margin. */
  lockWaitMs?: number;
  /** Progress and warnings, without a trailing newline. */
  log?: (line: string) => void;
}

export function plistPath(options: PlistOptions = {}): string {
  return join(options.home ?? homedir(), 'Library', 'LaunchAgents', `${options.label ?? LAUNCHD_LABEL}.plist`);
}

export function serviceTarget(label = LAUNCHD_LABEL, uid = process.getuid!()): string {
  return `gui/${uid}/${label}`;
}

function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/** Pure, stable XML; KeepAlive.SuccessfulExit implies RunAtLoad. */
export function renderPlist(input: PlistInput): string {
  const string = (value: string) => `<string>${xmlEscape(value)}</string>`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '<key>Label</key>',
    string(input.label),
    '<key>ProgramArguments</key>',
    '<array>',
    ...input.programArguments.map(string),
    '</array>',
    '<key>EnvironmentVariables</key>',
    '<dict>',
    ...Object.keys(input.environment)
      .sort()
      .flatMap((key) => [`<key>${xmlEscape(key)}</key>`, string(input.environment[key])]),
    '</dict>',
    '<key>KeepAlive</key>',
    '<dict>',
    '<key>SuccessfulExit</key>',
    '<false/>',
    '</dict>',
    '<key>ExitTimeOut</key>',
    '<integer>60</integer>',
    '<key>ThrottleInterval</key>',
    '<integer>30</integer>',
    '<key>HardResourceLimits</key>',
    '<dict>',
    '<key>NumberOfFiles</key>',
    '<integer>65536</integer>',
    '</dict>',
    '<key>ProcessType</key>',
    string('Interactive'),
    '<key>LimitLoadToSessionType</key>',
    string('Aqua'),
    '<key>StandardOutPath</key>',
    string(input.stdout),
    '<key>StandardErrorPath</key>',
    string(input.stderr),
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

/** Installation refuses either test switch alone, unlike runtime isTestMode which requires both. */
export function installRefusal(config: Pick<RunnerConfig, 'test'>, env: Env = process.env): string | null {
  return env.AGFLOW_TEST === '1' || config.test !== undefined
    ? 'cannot install the runner in test mode; unset AGFLOW_TEST and remove the test block from runner.json'
    : null;
}

function succeeded(result: ExecResult): boolean {
  return result.exitCode === 0 && !result.timedOut;
}

/** bootout waits for the process to exit, which launchd allows ExitTimeOut (60 s) after a suspend; plus a margin. */
const BOOTOUT_TIMEOUT_MS = 75_000;

function launchctl(args: string[], options: LaunchctlOptions, timeoutMs = 30_000): Promise<ExecResult> {
  return (options.exec ?? defaultExec)(['launchctl', ...args], { timeoutMs });
}

function requireSuccess(command: string, result: ExecResult, hint = ''): void {
  if (succeeded(result)) return;
  const detail = result.stderr.trim() || (result.timedOut ? 'timed out' : `exit ${result.exitCode}`);
  throw new Error(`launchctl ${command} failed: ${detail}${hint}`);
}

/** False means nothing was unloaded; an already absent job is normal. */
export async function bootoutService(options: LaunchctlOptions = {}): Promise<boolean> {
  try {
    const target = serviceTarget(options.label, options.uid);
    return succeeded(await launchctl(['bootout', target], options, BOOTOUT_TIMEOUT_MS));
  } catch {
    return false;
  }
}

export async function disableService(options: LaunchctlOptions = {}): Promise<void> {
  requireSuccess('disable', await launchctl(['disable', serviceTarget(options.label, options.uid)], options));
}

/** kickstart returns once the job runs, and launchd holds a job that started within its throttle for up to a minute. */
export async function kickstartService(options: LaunchctlOptions = {}): Promise<void> {
  const target = serviceTarget(options.label, options.uid);
  requireSuccess('kickstart', await launchctl(['kickstart', '-k', target], options, 120_000));
}

export async function serviceLoaded(options: LaunchctlOptions = {}): Promise<boolean> {
  return succeeded(await launchctl(['print', serviceTarget(options.label, options.uid)], options));
}

/**
 * The files ProgramArguments names: the command, every argument that is not an option (the source main.ts, or the
 * value of a separate `--config <path>`), and the value of `--config=<path>`. Options such as --no-env-file are not.
 */
export function programPaths(agflow: AgflowCommand): string[] {
  const paths = [agflow.command];
  for (const argument of agflow.args) {
    if (!argument.startsWith('-')) paths.push(argument);
    else if (argument.startsWith('--config=')) paths.push(argument.slice('--config='.length));
  }
  return paths;
}

export async function installService(
  options: InstallOptions,
): Promise<{ plistPath: string; target: string; warnings: string[] }> {
  const { paths, agflow } = options;
  const env = options.env ?? process.env;
  const config = loadRunnerConfig(paths.config, env);
  const refusal = installRefusal(config, env);
  if (refusal) throw new Error(refusal);
  const program = [agflow.command, ...agflow.args];
  const files = programPaths(agflow);
  for (const path of files) {
    if (!isAbsolute(path)) throw new Error(`LaunchAgent program paths must be absolute: ${path}`);
  }
  if (!isAbsolute(paths.home)) throw new Error('LaunchAgent AGFLOW_HOME must be absolute');
  const pollMs = options.lockPollMs ?? 100;
  const waitMs = options.lockWaitMs ?? 90_000;
  if (!Number.isFinite(pollMs) || pollMs <= 0) throw new Error('lockPollMs must be positive');
  if (!Number.isFinite(waitMs) || waitMs < 0) throw new Error('lockWaitMs must be nonnegative');
  const home = resolve(options.home ?? homedir());
  const label = options.label ?? LAUNCHD_LABEL;
  const uid = options.uid ?? process.getuid!();
  const target = serviceTarget(label, uid);
  const path = plistPath({ home, label });
  const warnings: string[] = [];
  const warn = (line: string) => {
    warnings.push(line);
    options.log?.(line);
  };

  await (options.installPins ?? ensurePinnedVendors)(paths, { env, exec: options.exec, log: options.log });
  for (const argument of files) {
    if (
      ['Desktop', 'Documents', 'Downloads'].some((folder) => {
        const protectedPath = join(home, folder);
        const absolute = resolve(argument);
        return absolute === protectedPath || absolute.startsWith(protectedPath + sep);
      })
    ) {
      warn(
        `warning: ${argument} is in a privacy-protected folder; ` +
          'macOS asks for folder access for a LaunchAgent there. ' +
          'Move the binary or source to ~/.local/bin or /usr/local/bin and run install again.',
      );
    }
  }

  const environment: Record<string, string> = { PATH: config.capturedPath, NODE_USE_SYSTEM_CA: '1' };
  for (const key of CONNECTIVITY_VARS) {
    const value = config.connectivity[key];
    if (value !== undefined) environment[key] = value;
  }
  if (env.AGFLOW_HOME !== undefined) environment.AGFLOW_HOME = paths.home;
  if (env.AGFLOW_CONFIG_DIR !== undefined) environment.AGFLOW_CONFIG_DIR = resolve(env.AGFLOW_CONFIG_DIR);
  const plist = renderPlist({
    label,
    programArguments: [...program, 'runner', 'start', '--service'],
    environment,
    ...launchdLogPaths(paths),
  });
  mkdirSync(paths.logs, { recursive: true, mode: 0o700 });
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${label}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, plist, { mode: 0o644, flag: 'wx' });
    chmodSync(temporary, 0o644);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }

  await bootoutService({ ...options, label, uid });
  const deadline = performance.now() + waitMs;
  let owner = readLockOwner(paths);
  while (owner !== null) {
    if (owner.mode === 'foreground') {
      warn(`warning: the service waits for the foreground runner (pid ${owner.pid ?? 'unknown'}) to stop`);
      break;
    }
    // An unknown owner can be a service still writing its identity; wait rather than racing its teardown.
    if (performance.now() >= deadline) {
      throw new Error(`runner.lock is still held by pid ${owner.pid ?? 'unknown'} after ${waitMs} ms; install aborted`);
    }
    await delay(Math.min(pollMs, Math.max(0, deadline - performance.now())));
    owner = readLockOwner(paths);
  }
  // The lock is free once the old process exits, which can precede launchd removing the job (or a bootout that timed
  // out); bootstrap fails with an input/output error while the label is still loaded.
  while (await serviceLoaded({ ...options, label, uid })) {
    if (performance.now() >= deadline) {
      throw new Error(`launchd still has ${target} loaded after ${waitMs} ms; install aborted`);
    }
    await delay(Math.min(pollMs, Math.max(0, deadline - performance.now())));
  }
  requireSuccess('enable', await launchctl(['enable', target], options));
  requireSuccess(
    'bootstrap',
    await launchctl(['bootstrap', `gui/${uid}`, path], options),
    '; this needs the logged-in desktop session: LimitLoadToSessionType Aqua fails over SSH',
  );
  return { plistPath: path, target, warnings };
}
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `bun test packages/runner/test/service/launchd.test.ts packages/cli/test/runner-command.test.ts && bun test && bun run typecheck`
Expected: the task's tests pass; then the whole suite passes (`0 fail`) and `tsc` exits 0.

Every launchctl call goes through the injected `Exec`, and the tests use scratch homes and a recording `Exec`: they never touch the real `gui/<uid>` domain or `~/Library/LaunchAgents`. Bootout gets 75 s (`ExitTimeOut` 60 plus a margin) and kickstart 120 s: `launchctl kickstart -k` blocks while launchd holds back a job that started recently, about a minute (found by `verify:service`). programPaths accepts --no-env-file and validates the absolute value /dev/null in --config=/dev/null; ProgramArguments preserves both flags before main.ts. A foreground lock holder is not waited for: the service waits for it itself.

- [ ] **Step 5: Commit**

```bash
git add -A 'packages/cli/src/runner-command.ts' 'packages/cli/test/runner-command.test.ts' 'packages/runner/src/service/launchd.ts' 'packages/runner/test/service/launchd.test.ts'
git commit -m 'M2C Task 20: The LaunchAgent and `agflow runner install`' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

### Task 21: `agflow runner status`

`agflow runner status` (design 7.1, 7.8) asks the running service over runner.sock for a `RunnerStatusReport`: identity, hub and link, the service state with its one-line reason, draining, capacity and free slots, power, disk, keep-awake, dependency preparation, vendors, each attempt with lateWorkSha and its pid, pgid and lstart (X-41), and existing clones kept for a failed or pending final push. `--json` prints the report as it is; M2g finds agent groups through it (X-42). Without a socket it reports, labelled best effort, whether the plist is installed, launchd's disabled state, the last exit and the last 20 log lines, and exits 1. Outside AGFLOW_TEST=1, both running and offline reports warn when launchd has disabled the agent. Under AGFLOW_TEST=1, neither mode consults launchd or the installed plist.

**Files:**
- Modify: `packages/cli/src/runner-command.ts`
- Test: `packages/cli/test/runner-command.test.ts`
- Modify: `packages/runner/src/service/host.ts`
- Create: `packages/runner/src/service/status.ts`
- Test: `packages/runner/test/service/status.test.ts`

- [ ] **Step 1: Write the failing tests**

**File:** `packages/cli/test/runner-command.test.ts` (change)

```diff
diff --git a/packages/cli/test/runner-command.test.ts b/packages/cli/test/runner-command.test.ts
index 4fadda9e..746599dc 100644
--- a/packages/cli/test/runner-command.test.ts
+++ b/packages/cli/test/runner-command.test.ts
@@ -1,10 +1,11 @@
 import { afterEach, beforeEach, describe, expect, mock, setDefaultTimeout, test } from 'bun:test';
-import { existsSync, readFileSync } from 'node:fs';
-import { isAbsolute, join } from 'node:path';
+import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
+import { dirname, isAbsolute, join } from 'node:path';
 import { getAttempt } from '@agflow/hub/src/attempt-store';
 import { findRunnerByKey, getRunner } from '@agflow/hub/src/runners';
 import { createTasks } from '@agflow/hub/src/tasks';
 import { newTask } from '@agflow/hub/test/helpers';
+import { AttemptStore } from '@agflow/runner/src/attempt-store';
 import { loadRunnerConfig, RunnerConfigSchema, saveRunnerConfig } from '@agflow/runner/src/config';
 import { openRunnerDb } from '@agflow/runner/src/db';
 import { Outbox } from '@agflow/runner/src/outbox';
@@ -13,6 +14,7 @@ import type { RunnerServiceOptions } from '@agflow/runner/src/service/host';
 import {
   installRefusal,
   type installService as installRunnerService,
+  plistPath,
   installService as realInstallService,
 } from '@agflow/runner/src/service/launchd';
 import { acquireRunnerLock, readLockOwner } from '@agflow/runner/src/service/lock';
@@ -21,7 +23,7 @@ import { ServiceRuns } from '@agflow/runner/src/service/runs';
 import { waitFor } from '@agflow/runner/test/fixture';
 import { startRunnerAttempt } from '@agflow/runner/test/hub-fixture';
 import { afterThisTest, cleanupRunnerSetups, tempDir } from '@agflow/runner/test/runner-setup';
-import { recordingExec, setupTestService } from '@agflow/runner/test/service-helpers';
+import { recordingExec, setupTestService, sleepingServiceAdapter } from '@agflow/runner/test/service-helpers';
 import { parseArgs } from '../src/args';
 import { main } from '../src/main';
 import { configDir } from '../src/paths';
@@ -67,6 +69,7 @@ describe('agflow runner', () => {
     expect(RUNNER_HELP).toContain('agflow runner drain');
     expect(RUNNER_HELP).toContain('agflow runner undrain');
     expect(RUNNER_HELP).toContain('agflow runner install');
+    expect(RUNNER_HELP).toContain('agflow runner status [--json]');
     expect(out.join('')).toContain(RUNNER_HELP);
     expect(err).toEqual([]);
   });
@@ -328,3 +331,163 @@ console.log(JSON.stringify(Object.keys(require.cache).filter((path) => path.incl
     }
   }
 });
+
+for (const running of [false, true]) {
+  test(`status in injected test mode never consults launchd (running: ${running})`, async () => {
+    const s = await setupTestService();
+    process.env.AGFLOW_HOME = s.paths.home;
+    if (running) await s.start();
+    const exec = recordingExec([], { stdout: '"dev.agflow.runner" => disabled' });
+    const home = tempDir('agf-home-');
+    const plist = plistPath({ home });
+    mkdirSync(dirname(plist), { recursive: true });
+    writeFileSync(plist, 'installed');
+    const { io, out } = capture();
+    expect(await runnerCommand(parseArgs(['runner', 'status', '--json']), io, {
+      env: { AGFLOW_TEST: '1' }, exec, home, uid: 501,
+    })).toBe(running ? 0 : 1);
+    const report = JSON.parse(out.join(''));
+    expect(report.warnings).toEqual([]);
+    if (!running) expect(report).toMatchObject({ disabled: null, plistInstalled: false });
+    expect(exec.calls).toEqual([]);
+  });
+}
+
+describe('agflow runner status', () => {
+  test('rejects extra arguments and non-boolean --json', async () => {
+    for (const argv of [
+      ['runner', 'status', 'extra'],
+      ['runner', 'status', '--json', 'extra'],
+    ]) {
+      const { io, err } = capture();
+      expect(await main(argv, io)).toBe(2);
+      expect(err.join('')).toContain('usage: agflow runner status [--json]');
+    }
+  });
+
+  test('reports a live attempt, recorded group, kept clone and Login Items without exposing tokens', async () => {
+    const adapter = sleepingServiceAdapter();
+    let agentToken = '';
+    const start = adapter.start.bind(adapter);
+    adapter.start = async (launch) => {
+      agentToken = launch.env.AGFLOW_AGENT_TOKEN!;
+      return start(launch);
+    };
+    const s = await setupTestService({ config: { capacity: 2 }, host: { adapters: [adapter] } });
+    process.env.AGFLOW_HOME = s.paths.home;
+    const service = await s.start();
+    await waitFor(() => service.runner?.status().link === 'online');
+    const runnerId = service.runner!.status().runnerId!;
+    const [task] = createTasks(s.hub.ctx, [newTask()], 'user:alice');
+    const started = startRunnerAttempt(s.hub.ctx, {
+      runnerId,
+      taskId: task!.id,
+      role: 'worker',
+      vendor: 'codex',
+    });
+    await waitFor(() =>
+      service.runner!.status().attempts.some((a) => a.attemptId === started.attempt.id && a.phase === 'turn'),
+    );
+    await service.runner!.changeSettings({ draining: true });
+    const db = openRunnerDb(s.paths.db);
+    try {
+      const store = new AttemptStore(db);
+      // A running attempt with a stale pushError still works in its clone; only the ended one keeps a clone.
+      const stale = store.update(started.attempt.id, { pushError: 'stale push error' });
+      expect(existsSync(stale.clone!)).toBe(true);
+      const kept = tempDir('agf-kept-');
+      const ended = store.create(
+        { ...stale.spec, attemptId: `${stale.attemptId}-kept` },
+        { clone: kept, tmpDir: null, cliVersion: null },
+      );
+      store.update(ended.attemptId, { state: 'ended', endedAt: Date.now(), pushError: 'final push refused' });
+      const group = store.processes(started.attempt.id)[0]!;
+      const exec = recordingExec([
+        {
+          argv: ['launchctl', 'print-disabled', 'gui/501'],
+          result: { stdout: 'disabled services = {\n  "dev.agflow.runner" => disabled\n}' },
+        },
+      ]);
+      const deps = { env: {}, exec, uid: 501, home: tempDir('agf-home-') };
+      const human = capture();
+      expect(await runnerCommand(parseArgs(['runner', 'status']), human.io, deps)).toBe(0);
+      const text = human.out.join('');
+      expect(text).toMatch(/^State\s+ok$/m);
+      expect(text).toMatch(/^Draining\s+true$/m);
+      expect(text).toMatch(/^Capacity\s+2, free slots: 1$/m);
+      expect(text).toContain(`Kept clone     ${ended.attemptId} ${kept}: final push refused`);
+      expect(text).not.toContain('stale push error');
+      for (const value of [runnerId, started.attempt.id, task!.id, 'worker', 'codex', 'turn', 'Login Items']) {
+        expect(text).toContain(value);
+      }
+      const json = capture();
+      expect(await runnerCommand(parseArgs(['runner', 'status', '--json']), json.io, deps)).toBe(0);
+      const report = JSON.parse(json.out.join(''));
+      expect(report).toMatchObject({ running: true, runnerId, state: 'ok', capacity: 2, freeSlots: 1, draining: true });
+      expect(report.keptClones).toEqual([{ attemptId: ended.attemptId, clone: kept, error: 'final push refused' }]);
+      expect(report.warnings).toHaveLength(1);
+      expect(agentToken).toStartWith('agt_');
+      expect(json.out.join('')).not.toContain(agentToken);
+      expect(json.out.join('')).not.toContain(s.hub.token);
+      expect(json.out.join('')).not.toContain('agt_');
+      expect(json.out.join('')).not.toContain('agentToken');
+      expect(human.err).toEqual([]);
+      expect(json.err).toEqual([]);
+      store.update(started.attempt.id, { pushError: null });
+      expect(group).toBeDefined();
+      expect(report.attempts[0]).toMatchObject({
+        attemptId: started.attempt.id,
+        pid: group.pid,
+        pgid: group.pgid,
+        lstart: group.lstart,
+        ageMs: expect.any(Number),
+      });
+    } finally {
+      db.close();
+    }
+  });
+
+  test('without a socket prints best effort, installation, exit time and 20 log lines and exits 1', async () => {
+    const s = await setupTestService();
+    process.env.AGFLOW_HOME = s.paths.home;
+    const home = tempDir('agf-home-');
+    const plist = plistPath({ home });
+    mkdirSync(dirname(plist), { recursive: true });
+    writeFileSync(plist, 'installed');
+    const at = 1_700_000_000_000;
+    const runs = new ServiceRuns(s.paths, { now: () => at });
+    const id = runs.start({ pid: 42, mode: 'service' });
+    runs.finish(id, { code: 0, clean: true, reason: 'incompatible protocol' });
+    writeFileSync(s.paths.runnerLog, Array.from({ length: 30 }, (_, i) => `log-line-${i}\n`).join(''));
+    const exec = recordingExec([
+      { argv: ['launchctl', 'print-disabled', 'gui/501'], result: { stdout: '"dev.agflow.runner" => true' } },
+    ]);
+    for (const flags of [[], ['--json']]) {
+      const { io, out, err } = capture();
+      expect(await runnerCommand(parseArgs(['runner', 'status', ...flags]), io, { env: {}, exec, uid: 501, home })).toBe(1);
+      const text = out.join('');
+      expect(text).toContain('incompatible protocol');
+      expect(text).toContain('Login Items');
+      expect(text).toContain('log-line-10');
+      expect(text).toContain('log-line-29');
+      expect(text).not.toContain('log-line-9');
+      if (flags.length) {
+        expect(JSON.parse(text)).toMatchObject({
+          running: false,
+          bestEffort: true,
+          plistInstalled: true,
+          disabled: true,
+          lastExit: { at, reason: 'incompatible protocol' },
+          warnings: [expect.any(String)],
+        });
+        expect(JSON.parse(text).logLines).toHaveLength(20);
+      } else {
+        expect(text).toContain('best effort');
+        expect(text).toContain('installed');
+        expect(text).toContain(new Date(at).toISOString());
+      }
+      expect(err).toEqual([]);
+    }
+    expect(exec.calls).toHaveLength(2);
+  });
+});
```

**File:** `packages/runner/test/service/status.test.ts` (new)

```ts
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createTasks } from '@agflow/hub/src/tasks';
import { newTask } from '@agflow/hub/test/helpers';
import { AttemptStore } from '../../src/attempt-store';
import { openRunnerDb } from '../../src/db';
import { GB } from '../../src/ops/health';
import type { RunnerStatus } from '../../src/runner';
import { controlRequest } from '../../src/service/control';
import { plistPath } from '../../src/service/launchd';
import { acquireRunnerLock } from '../../src/service/lock';
import { ServiceRuns } from '../../src/service/runs';
import {
  buildStatusReport,
  formatStatus,
  offlineStatus,
  parseLaunchdDisabled,
  type RunnerStatusReport,
} from '../../src/service/status';
import { waitFor } from '../fixture';
import { startRunnerAttempt } from '../hub-fixture';
import { afterThisTest, cleanupRunnerSetups, tempDir } from '../runner-setup';
import { recordingExec, setupTestService, startTestService } from '../service-helpers';

afterEach(cleanupRunnerSetups);
setDefaultTimeout(60_000);

const disabledOutput = (value: string) => `disabled services = {
  "com.apple.SafariLaunchAgent" => enabled
  "dev.agflow.runner.extra" => disabled
  "dev.agflow.runner"   => ${value}
  "com.example.other" => true
}`;

for (const [value, expected] of [
  ['disabled', true],
  ['true', true],
  ['enabled', false],
  ['false', false],
] as const) {
  test(`parseLaunchdDisabled reads ${value} from recorded launchctl output`, () => {
    expect(parseLaunchdDisabled(disabledOutput(value))).toBe(expected);
  });
}

test('disabled parsing matches a whole label, including custom labels', () => {
  expect(parseLaunchdDisabled('"dev.agflow.runner.extra" => disabled')).toBeNull();
  expect(parseLaunchdDisabled('"devXagflowXrunner" => true')).toBeNull();
  expect(parseLaunchdDisabled('  "scratch.runner" => true', 'scratch.runner')).toBe(true);
  expect(parseLaunchdDisabled('')).toBeNull();
});

test('buildStatusReport uses phases for slots, projects safe fields and keeps process identities flat', async () => {
  const s = await setupTestService();
  const attempts: RunnerStatus['attempts'] = ['turn', 'idle', null].map((phase, i) => ({
    attemptId: `attempt-${i}`,
    taskId: `task-${i}`,
    role: 'worker',
    vendor: 'codex',
    state: 'running',
    phase: phase as 'turn' | 'idle' | null,
    wipSha: 'abc',
    pushedSha: 'def',
    lastPushAt: 8_000,
    pushError: i === 2 ? 'push refused' : null,
    lateWorkSha: i === 2 ? 'abc' : null,
    process: i === 0 ? { pid: 123, pgid: 123, lstart: 'Tue Nov 10 12:00:00 2026' } : null,
    agentToken: 'agent-secret',
  }));
  const status: RunnerStatus = {
    runnerId: 'runner-1',
    link: 'online',
    state: { state: 'ok', detail: null },
    settings: { ...s.config, capacity: 4 },
    vendors: [],
    git: { ready: true, problem: null, lastPushAt: null },
    attempts,
  };
  // attempt-1 runs again after a resume with its old pushError; only the ended attempt-2 keeps its clone.
  const records = attempts.map((a, i) => ({
    attemptId: a.attemptId,
    createdAt: 5_000,
    state: i === 2 ? ('ended' as const) : ('running' as const),
    clone: `/clones/${a.attemptId}`,
    pushError: i === 1 ? 'stale push error' : a.pushError,
    lateWorkSha: a.lateWorkSha,
    spec: { agentToken: 'agent-secret' },
  }));
  const report = buildStatusReport({
    status,
    config: s.config,
    hubUrl: s.hub.url,
    owner: { pid: 42, mode: 'foreground', startedAt: new Date(1_000).toISOString() },
    health: status.state,
    heartbeat: { power: null, disk: null, acceptingUntil: 2_000 },
    needsLogin: { on: false, reason: null, since: null },
    keepAwakeHeld: true,
    dependencyPrep: true,
    records,
    existingClones: ['/clones/attempt-1', '/clones/attempt-2'],
    now: 10_000,
  });
  // 'turn' and 'idle' hold slots and the null phase does not, with no clamping at zero.
  expect(report).toMatchObject({ running: true, startedAt: 1_000, capacity: 4, freeSlots: 2, acceptingUntil: 12_000 });
  expect(report.attempts[0]).toMatchObject({ ageMs: 5_000, pid: 123, pgid: 123, lstart: attempts[0]!.process!.lstart });
  expect(report.attempts[1]).toMatchObject({ pid: null, pgid: null, lstart: null });
  expect(report.attempts.map((a) => a.lateWorkSha)).toEqual([null, null, 'abc']);
  expect(report.keptClones).toEqual([{ attemptId: 'attempt-2', clone: '/clones/attempt-2', error: 'push refused' }]);
  expect(JSON.stringify(report)).not.toContain('agent-secret');
  expect(formatStatus(report)).toContain('push refused');
});

test('GET /status shows health, power, disk, preparation and current settings', async () => {
  const s = await startTestService({ config: { minFreeGb: 10 }, host: { freeBytes: () => 7 * GB } });
  await waitFor(() => s.service.runner?.status().link === 'online');
  await s.service.runner!.changeSettings({ capacity: 4, draining: true, keepAwake: 'off' });
  const report = await controlRequest<RunnerStatusReport>(s.paths, 'GET', '/status');
  expect(report).toMatchObject({
    running: true,
    runnerId: s.service.runner!.status().runnerId,
    name: 'laptop',
    hubUrl: s.hub.url,
    state: 'disk_low',
    draining: true,
    capacity: 4,
    freeSlots: 4,
    power: { source: 'ac', batteryPercent: 100, lowPowerMode: false },
    disk: { freeBytes: 7 * GB, agflowBytes: 1_000_000 },
    keepAwake: { mode: 'off', held: false },
    dependencyPrep: true,
  });
  const text = formatStatus(report);
  expect(text).toContain('disk_low: 7.0 GB free, below the 10 GB minimum');
  for (const value of ['Power', 'Disk', 'Keep-awake', 'codex', 'claude']) {
    expect(text).toContain(value);
  }
});

test('GET /status shows the persistent crash-loop reason', async () => {
  const s = await setupTestService();
  const runs = new ServiceRuns(s.paths);
  for (let i = 0; i < 3; i++) {
    const id = runs.start({ pid: process.pid, mode: 'service' });
    runs.finish(id, { clean: false, code: 1, reason: `crash ${i}` });
  }
  await s.start();
  const report = await controlRequest<RunnerStatusReport>(s.paths, 'GET', '/status');
  expect(report).toMatchObject({ state: 'crash_loop', draining: true });
  expect(formatStatus(report)).toContain('crash 2');
});

test('GET /status answers while the service waits for credentials', async () => {
  const s = await setupTestService({ mode: 'service', noCredentials: true });
  const starting = s.start();
  try {
    await waitFor(() => existsSync(s.paths.socket));
    const report = await controlRequest<RunnerStatusReport>(s.paths, 'GET', '/status');
    expect(formatStatus(report)).toContain('not signed in; run agflow login');
    expect(report).toMatchObject({
      running: true,
      pid: process.pid,
      mode: 'service',
      link: 'needs_login',
      attempts: [],
      needsLogin: { on: true, reason: 'not signed in', since: expect.any(Number) },
    });
  } finally {
    await controlRequest(s.paths, 'POST', '/suspend');
    await starting;
  }
});

test('offline status reads installed plist, finished exit, last 20 lines and Login Items without writes', async () => {
  const s = await setupTestService();
  const home = tempDir('agf-home-');
  const plist = plistPath({ home });
  mkdirSync(dirname(plist), { recursive: true });
  writeFileSync(plist, 'installed');
  const runs = new ServiceRuns(s.paths, { now: () => 1_700_000_000_000 });
  const id = runs.start({ pid: 42, mode: 'service' });
  runs.finish(id, { reason: 'machine mismatch', code: 0, clean: true });
  writeFileSync(s.paths.runnerLog, Array.from({ length: 25 }, (_, i) => `line ${i}\n`).join(''));
  const history = readFileSync(runs.path, 'utf8');
  const exec = recordingExec([
    { argv: ['launchctl', 'print-disabled', 'gui/501'], result: { stdout: disabledOutput('disabled') } },
  ]);
  const report = await offlineStatus({ paths: s.paths, home, uid: 501, exec });
  expect(report).toMatchObject({
    running: false,
    bestEffort: true,
    plistInstalled: true,
    disabled: true,
    lockHolder: null,
    lastExit: { reason: 'machine mismatch', at: 1_700_000_000_000, code: 0, clean: true },
  });
  expect(report.logLines).toEqual(Array.from({ length: 20 }, (_, i) => `line ${i + 5}`));
  expect(report.warnings).toHaveLength(1);
  expect(formatStatus(report)).toContain('best effort');
  expect(formatStatus(report)).toContain(new Date(1_700_000_000_000).toISOString());
  expect(formatStatus(report)).toContain('Login Items');
  expect(exec.calls[0]?.options?.timeoutMs).toBeGreaterThan(0);
  expect(readFileSync(runs.path, 'utf8')).toBe(history);
});

test('offline status distinguishes an unanswered lock holder from an abandoned run and unknown launchd', async () => {
  const s = await setupTestService();
  const runs = new ServiceRuns(s.paths, { now: () => 1_000 });
  runs.start({ pid: process.pid, mode: 'service' });
  const lock = await acquireRunnerLock(s.paths, { mode: 'service' });
  afterThisTest(() => lock.release());
  const options = { paths: s.paths, home: tempDir('agf-home-'), exec: recordingExec([], { exitCode: 1 }) };
  expect(await offlineStatus(options)).toMatchObject({
    disabled: null,
    plistInstalled: false,
    lastExit: null,
    lockHolder: { pid: process.pid, mode: 'service' },
    logLines: [],
  });
  lock.release();
  expect(await offlineStatus(options)).toMatchObject({
    lockHolder: null,
    lastExit: { at: 1_000, clean: false, reason: 'exited without a clean shutdown' },
  });
});

test('GET /status lists a retained failed-push clone only while it exists', async () => {
  const s = await startTestService();
  await waitFor(() => s.service.runner?.status().link === 'online');
  // Leave the queued start untouched: this test supplies an ended record whose final push failed.
  s.service.runner!.pause();
  const [task] = createTasks(s.hub.ctx, [newTask()], 'user:alice');
  const { command } = startRunnerAttempt(s.hub.ctx, {
    runnerId: s.service.runner!.status().runnerId!,
    taskId: task!.id,
    role: 'worker',
    vendor: 'codex',
  });
  if (command.command.kind !== 'start_attempt') throw new Error('expected start_attempt');
  const clone = tempDir('agf-kept-');
  const db = openRunnerDb(s.paths.db);
  try {
    const store = new AttemptStore(db);
    const record = store.create(command.command.attempt, { clone, tmpDir: null, cliVersion: null });
    store.update(record.attemptId, { state: 'ended', endedAt: Date.now(), pushError: 'remote refused final push' });
    const report = await controlRequest<RunnerStatusReport>(s.paths, 'GET', '/status');
    if (!report.running) throw new Error('expected a running service');
    expect(report.keptClones).toEqual([{ attemptId: record.attemptId, clone, error: 'remote refused final push' }]);
    expect(report.freeSlots).toBe(report.capacity);
    expect(report.attempts[0]).toMatchObject({ pid: null, pgid: null, lstart: null, phase: null, state: 'ended' });
    store.update(record.attemptId, { pushError: null, lateWorkSha: 'pending-sha' });
    expect(await controlRequest(s.paths, 'GET', '/status')).toMatchObject({
      keptClones: [{ attemptId: record.attemptId, clone, error: 'final work pending-sha has not reached a late-work ref yet' }],
    });
    rmSync(clone, { recursive: true });
    expect(await controlRequest(s.paths, 'GET', '/status')).toMatchObject({ keptClones: [] });
  } finally {
    db.close();
  }
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `bun test packages/runner/test/service/status.test.ts packages/cli/test/runner-command.test.ts`
Expected: FAIL — `agflow runner > help includes the runner commands`: at `packages/cli/test/runner-command.test.ts:72`, `expect(RUNNER_HELP).toContain('agflow runner status [--json]')` fails because the parent help only lists start, drain, undrain and install. Observed on the current task parent with only this task's test files copied in (2026-11-11).

- [ ] **Step 3: Implement**

**File:** `packages/cli/src/runner-command.ts` (change)

```diff
diff --git a/packages/cli/src/runner-command.ts b/packages/cli/src/runner-command.ts
index 00130946..75ee9e56 100644
--- a/packages/cli/src/runner-command.ts
+++ b/packages/cli/src/runner-command.ts
@@ -5,6 +5,8 @@
 // the runner's module graph. A static-string import() is still bundled by `bun build --compile`.
 import type { startRunnerService } from '@agflow/runner/src/service/host';
 import type { installService } from '@agflow/runner/src/service/launchd';
+import type { RunnerStatusReport } from '@agflow/runner/src/service/status';
+import type { Exec } from '@agflow/runner/src/service/system';
 import { type ParsedArgs, UsageError } from './args';
 import type { Io } from './io';
 import type { Command } from './main';
@@ -17,13 +19,22 @@ export const RUNNER_HELP = `  agflow runner start [--service]
   agflow runner drain            Stop accepting new attempts
   agflow runner undrain          Accept new attempts and clear the crash-loop guard
   agflow runner install          Install and start the LaunchAgent that runs the runner at login
+  agflow runner status [--json]  Show the runner's status and attempts
 `;
 
 export async function runnerCommand(
   args: ParsedArgs,
   io: Io,
-  deps: { startRunnerService?: typeof startRunnerService; installService?: typeof installService } = {},
+  deps: {
+    startRunnerService?: typeof startRunnerService;
+    installService?: typeof installService;
+    env?: Record<string, string | undefined>;
+    exec?: Exec;
+    uid?: number;
+    home?: string;
+  } = {},
 ): Promise<number> {
+  const env = deps.env ?? process.env;
   const drainingCommand =
     (draining: boolean): Command =>
     async (args, io) => {
@@ -52,6 +63,44 @@ export async function runnerCommand(
       });
       return (await service.exited).code;
     },
+    status: async (args, io) => {
+      if (args.positional.length > 2 || (args.flags.json !== undefined && args.flags.json !== true)) {
+        throw new UsageError('usage: agflow runner status [--json]');
+      }
+      try {
+        const { offlineStatus, formatStatus, launchdDisabled, LOGIN_ITEMS_WARNING } = await import(
+          '@agflow/runner/src/service/status'
+        );
+        const { LAUNCHD_LABEL } = await import('@agflow/runner/src/service/launchd');
+        const { controlRequest, ControlUnavailableError } = await import('@agflow/runner/src/service/control');
+        const { runnerPaths } = await import('@agflow/runner/src/paths');
+        const paths = runnerPaths();
+        const options = {
+          paths, exec: deps.exec, uid: deps.uid, home: deps.home, label: LAUNCHD_LABEL,
+          launchd: env.AGFLOW_TEST !== '1',
+        };
+        let report: RunnerStatusReport;
+        try {
+          report = await controlRequest<RunnerStatusReport>(paths, 'GET', '/status', undefined, { timeoutMs: 3_000 });
+        } catch (error) {
+          if (!(error instanceof ControlUnavailableError)) throw error;
+          report = await offlineStatus(options);
+        }
+        if (
+          options.launchd &&
+          report.running &&
+          (await launchdDisabled(options)) === true &&
+          !report.warnings.includes(LOGIN_ITEMS_WARNING)
+        ) {
+          report.warnings.push(LOGIN_ITEMS_WARNING);
+        }
+        io.out(args.flags.json === true ? `${JSON.stringify(report, null, 2)}\n` : formatStatus(report));
+        return report.running ? 0 : 1;
+      } catch (error) {
+        io.err(`agflow: ${error instanceof Error ? error.message : String(error)}\n`);
+        return 1;
+      }
+    },
     drain: drainingCommand(true),
     undrain: drainingCommand(false),
     install: async (args, io) => {
```

**File:** `packages/runner/src/service/host.ts` (change)

```diff
diff --git a/packages/runner/src/service/host.ts b/packages/runner/src/service/host.ts
index 45e8e916..8a969a99 100644
--- a/packages/runner/src/service/host.ts
+++ b/packages/runner/src/service/host.ts
@@ -1,6 +1,7 @@
 // The process that runs a runner (design 7.1, X-41): `agflow runner start` in the foreground and `--service` under
 // launchd. One lock holder, one run record, and one exit path for every end: a refusal that needs a person, the hub
 // replacing the link, a stop, or an error.
+import { existsSync } from 'node:fs';
 import type { Credentials } from '@agflow/core';
 import { createAdapters } from '../adapters';
 import type { AgflowCommand, VendorAdapter } from '../adapters/types';
@@ -31,6 +32,7 @@ import { machineMismatch, readMachineId } from './machine';
 import { NeedsLogin } from './needs-login';
 import { createMacNotifier } from './notify';
 import { ServiceRuns } from './runs';
+import { buildStatusReport } from './status';
 import { suspendRunner } from './suspend';
 import { defaultExec, type Exec } from './system';
 
@@ -162,6 +164,7 @@ export async function startRunnerService(options: RunnerServiceOptions): Promise
   let store: AttemptStore | null = null;
   let runner: RunnerHandle | null = null;
   let config: RunnerConfig;
+  let hubUrl: string | null = null;
   const clock = options.clock ?? systemClock;
   let health: ServiceHealth | null = null;
   let keepAwake: KeepAwake | null = null;
@@ -295,6 +298,28 @@ export async function startRunnerService(options: RunnerServiceOptions): Promise
 
   // The control socket's routes; the commands of later tasks add theirs here.
   const routes: ControlRoutes = {
+    'GET /status': () => {
+      const status = runner?.status() ?? null;
+      const records = store?.list() ?? [];
+      return buildStatusReport({
+        status,
+        owner: lock!.owner,
+        config,
+        hubUrl,
+        health: status?.state ?? health?.state() ?? { state: 'ok', detail: null },
+        heartbeat: health?.heartbeat() ?? { power: null, disk: null, acceptingUntil: null },
+        needsLogin: needsLogin?.state() ?? { on: false, reason: null, since: null },
+        keepAwakeHeld: keepAwake?.isHeld() ?? false,
+        dependencyPrep: preparer?.available ?? false,
+        records,
+        existingClones: records.flatMap((record) =>
+          record.clone !== null && (record.pushError !== null || record.lateWorkSha !== null) && existsSync(record.clone)
+            ? [record.clone]
+            : [],
+        ),
+        now: clock.now(),
+      });
+    },
     'POST /drain': () => changeDraining(true),
     'POST /undrain': () => changeDraining(false),
     'POST /suspend': () => {
@@ -385,7 +410,7 @@ export async function startRunnerService(options: RunnerServiceOptions): Promise
     }
     db = openRunnerDb(paths.db);
     store = new AttemptStore(db);
-    let hubUrl = credentials?.hubUrl ?? db.meta('project')?.hubUrl ?? null;
+    hubUrl = credentials?.hubUrl ?? db.meta('project')?.hubUrl ?? null;
     health = createServiceHealth({
       paths,
       config: () => config,
```

**File:** `packages/runner/src/service/status.ts` (new)

```ts
// The control socket's public status contract (design 7.1, 7.8, X-41, X-42). Project fields explicitly: neither
// credentials nor an attempt spec belongs on a socket reachable by every process running as this user.
import { existsSync } from 'node:fs';
import type { RunnerVendor } from '@agflow/core';
import type { AttemptRecord } from '../attempt-store';
import type { RunnerConfig } from '../config';
import type { RunnerPaths } from '../paths';
import type { AttemptStatus, RunnerStatus } from '../runner';
import type { HealthReport, HealthState } from '../seams';
import { LAUNCHD_LABEL, plistPath } from './launchd';
import { type LockOwner, readLockOwner, type RunnerLock, type RunnerMode } from './lock';
import { tailLines } from './log';
import type { NeedsLoginState } from './needs-login';
import { type LastExit, ServiceRuns } from './runs';
import { defaultExec, type Exec } from './system';

/** Decimal gigabytes, as minFreeGb counts them. */
const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;

type StatusAttempt = Omit<AttemptStatus, 'process'> & {
  ageMs: number | null;
  pid: number | null;
  pgid: number | null;
  /** ps's identity string, preserved verbatim for process-group identity checks. */
  lstart: string | null;
};

interface RunningStatus {
  running: true;
  pid: number;
  mode: RunnerMode;
  startedAt: number;
  runnerId: string | null;
  name: string;
  hubUrl: string | null;
  link: RunnerStatus['link'];
  state: HealthState['state'];
  reason: string | null;
  needsLogin: NeedsLoginState;
  draining: boolean;
  capacity: number;
  freeSlots: number;
  power: HealthReport['power'];
  disk: HealthReport['disk'];
  /** Epoch milliseconds, converted from the heartbeat's duration. */
  acceptingUntil: number | null;
  keepAwake: { mode: RunnerConfig['keepAwake']; held: boolean };
  dependencyPrep: boolean;
  vendors: RunnerVendor[];
  attempts: StatusAttempt[];
  keptClones: { attemptId: string; clone: string; error: string }[];
  warnings: string[];
}

interface OfflineStatus {
  running: false;
  bestEffort: true;
  plistInstalled: boolean;
  disabled: boolean | null;
  lastExit: LastExit | null;
  lockHolder: Pick<LockOwner, 'pid' | 'mode'> | null;
  logLines: string[];
  warnings: string[];
}

export type RunnerStatusReport = RunningStatus | OfflineStatus;

interface StatusInput {
  status: RunnerStatus | null;
  owner: RunnerLock['owner'];
  config: Pick<RunnerConfig, 'name' | 'capacity' | 'draining' | 'keepAwake' | 'minFreeGb'>;
  hubUrl: string | null;
  health: HealthState;
  heartbeat: HealthReport;
  needsLogin: NeedsLoginState;
  keepAwakeHeld: boolean;
  dependencyPrep: boolean;
  records: readonly Pick<AttemptRecord, 'attemptId' | 'createdAt' | 'state' | 'clone' | 'pushError' | 'lateWorkSha'>[];
  /** The host checks existence; building a report itself performs no I/O. */
  existingClones: readonly string[];
  now: number;
}

export function buildStatusReport(input: StatusInput): RunningStatus {
  const { status, config, heartbeat, needsLogin } = input;
  const settings = status?.settings ?? config;
  const records = new Map(input.records.map((record) => [record.attemptId, record]));
  const attempts = (status?.attempts ?? []).map((attempt): StatusAttempt => {
    const record = records.get(attempt.attemptId);
    return {
      attemptId: attempt.attemptId,
      taskId: attempt.taskId,
      role: attempt.role,
      vendor: attempt.vendor,
      state: attempt.state,
      phase: attempt.phase,
      ageMs: record ? Math.max(0, input.now - record.createdAt) : null,
      lastPushAt: attempt.lastPushAt,
      wipSha: attempt.wipSha,
      pushedSha: attempt.pushedSha,
      pushError: attempt.pushError,
      lateWorkSha: attempt.lateWorkSha,
      pid: attempt.process?.pid ?? null,
      pgid: attempt.process?.pgid ?? null,
      lstart: attempt.process?.lstart ?? null,
    };
  });
  const clones = new Set(input.existingClones);
  const reason =
    input.health.state === 'disk_low' && heartbeat.disk !== null
      ? `${gb(heartbeat.disk.freeBytes)} free, below the ${config.minFreeGb} GB minimum`
      : input.health.detail;
  return {
    running: true,
    pid: input.owner.pid,
    mode: input.owner.mode,
    startedAt: Date.parse(input.owner.startedAt),
    runnerId: status?.runnerId ?? null,
    name: config.name,
    hubUrl: input.hubUrl,
    link: status?.link ?? (needsLogin.on ? 'needs_login' : 'idle'),
    state: input.health.state,
    reason,
    needsLogin: { on: needsLogin.on, reason: needsLogin.reason, since: needsLogin.since },
    draining: settings.draining,
    capacity: settings.capacity,
    freeSlots: Math.max(0, settings.capacity - attempts.filter((attempt) => attempt.phase !== null).length),
    power:
      heartbeat.power === null
        ? null
        : {
            source: heartbeat.power.source,
            batteryPercent: heartbeat.power.batteryPercent,
            lowPowerMode: heartbeat.power.lowPowerMode,
          },
    disk:
      heartbeat.disk === null
        ? null
        : {
            freeBytes: heartbeat.disk.freeBytes,
            agflowBytes: heartbeat.disk.agflowBytes,
          },
    acceptingUntil: heartbeat.acceptingUntil === null ? null : input.now + heartbeat.acceptingUntil,
    keepAwake: { mode: settings.keepAwake, held: input.keepAwakeHeld },
    dependencyPrep: input.dependencyPrep,
    vendors: (status?.vendors ?? []).map((vendor) => ({
      vendor: vendor.vendor,
      ready: vendor.ready,
      problem: vendor.problem,
      cliVersion: vendor.cliVersion,
      ownerCliVersion: vendor.ownerCliVersion,
      accountId: vendor.accountId,
      plan: vendor.plan,
      managedPolicy: vendor.managedPolicy,
      models: { lead: vendor.models.lead, worker: vendor.models.worker },
      ceilings: { fiveHour: vendor.ceilings.fiveHour, weekly: vendor.ceilings.weekly },
      allowPaidUsage: vendor.allowPaidUsage,
      degraded: vendor.degraded,
      preflightAt: vendor.preflightAt,
    })),
    attempts,
    // Only an exited attempt keeps its clone for a failed or pending push; a resumed one can carry a stale error.
    keptClones: input.records.flatMap((record) =>
      (record.state === 'ended' || record.state === 'stopped') &&
      record.clone !== null &&
      (record.pushError !== null || record.lateWorkSha !== null) &&
      clones.has(record.clone)
        ? [{
            attemptId: record.attemptId,
            clone: record.clone,
            error: record.pushError ?? `final work ${record.lateWorkSha} has not reached a late-work ref yet`,
          }]
        : [],
    ),
    warnings: [],
  };
}

// agflow runner stop disables the job too, so the warning names both causes rather than blaming macOS.
export const LOGIN_ITEMS_WARNING =
  'launchd has the runner disabled: agflow runner stop does this, and so does switching agflow off in ' +
  'System Settings > General > Login Items; run agflow runner install to enable it again ' +
  '(allow agflow in Login Items first if macOS disabled it)';

export function parseLaunchdDisabled(output: string, label = LAUNCHD_LABEL): boolean | null {
  for (const line of output.split('\n')) {
    const match = line.match(/^\s*"([^"]+)"\s*=>\s*(disabled|enabled|true|false)\s*[,;]?\s*$/);
    if (match?.[1] === label) return match[2] === 'disabled' || match[2] === 'true';
  }
  return null;
}

interface LaunchdStatusOptions {
  exec?: Exec;
  label?: string;
  uid?: number;
}

/** A missing command, unavailable GUI session or timeout leaves launchd's state unknown. */
export async function launchdDisabled(options: LaunchdStatusOptions = {}): Promise<boolean | null> {
  try {
    const result = await (options.exec ?? defaultExec)(
      ['launchctl', 'print-disabled', `gui/${options.uid ?? process.getuid!()}`],
      { timeoutMs: 3_000 },
    );
    return result.exitCode === 0 && !result.timedOut ? parseLaunchdDisabled(result.stdout, options.label) : null;
  } catch {
    return null;
  }
}

export async function offlineStatus(
  options: LaunchdStatusOptions & { paths: RunnerPaths; home?: string; launchd?: boolean },
): Promise<OfflineStatus> {
  const disabled = options.launchd === false ? null : await launchdDisabled(options);
  const owner = readLockOwner(options.paths);
  return {
    running: false,
    bestEffort: true,
    plistInstalled: options.launchd !== false && existsSync(plistPath({ home: options.home, label: options.label })),
    disabled,
    lastExit: new ServiceRuns(options.paths).lastExit({ running: owner !== null }),
    lockHolder: owner === null ? null : { pid: owner.pid, mode: owner.mode },
    logLines: tailLines(options.paths, 20),
    warnings: disabled ? [LOGIN_ITEMS_WARNING] : [],
  };
}

const time = (at: number | null) => (at === null ? 'unknown' : new Date(at).toISOString());
const line = (label: string, value: string) => `${label.padEnd(14)} ${value}`;

export function formatStatus(report: RunnerStatusReport): string {
  const lines: string[] = [];
  if (report.running) {
    lines.push(
      line('Runner', `${report.runnerId ?? 'pending'} (${report.name})`),
      line('Service', `pid ${report.pid}, ${report.mode}, started ${time(report.startedAt)}`),
      line('Hub', report.hubUrl ?? 'unknown'),
      line('Link', report.link),
      line('State', `${report.state}${report.reason ? `: ${report.reason}` : ''}`),
    );
    if (report.needsLogin.on) {
      lines.push(
        line(
          'Needs login',
          `needs_login: ${report.needsLogin.reason}; run agflow login (since ${time(report.needsLogin.since)})`,
        ),
      );
    }
    lines.push(
      line('Draining', String(report.draining)),
      line('Capacity', `${report.capacity}, free slots: ${report.freeSlots}`),
      line(
        'Power',
        report.power === null
          ? 'unknown'
          : `${report.power.source}, battery ${report.power.batteryPercent ?? 'unknown'}%, ` +
              `low power ${report.power.lowPowerMode}`,
      ),
      line(
        'Disk',
        report.disk === null
          ? 'unknown'
          : `${gb(report.disk.freeBytes)} free, agflow uses ${gb(report.disk.agflowBytes)}`,
      ),
      line('Accepting', report.acceptingUntil === null ? 'no timed hold' : `held until ${time(report.acceptingUntil)}`),
      line('Keep-awake', `${report.keepAwake.mode}, held: ${report.keepAwake.held}`),
      line('Dependencies', report.dependencyPrep ? 'available' : 'unavailable'),
    );
    for (const vendor of report.vendors) {
      lines.push(
        line(
          vendor.vendor,
          `${vendor.ready ? 'ready' : (vendor.problem ?? 'not ready')}; CLI ${vendor.cliVersion ?? 'unknown'}, ` +
            `owner CLI ${vendor.ownerCliVersion ?? 'unknown'}, plan ${vendor.plan ?? 'unknown'}`,
        ),
      );
    }
    for (const attempt of report.attempts) {
      lines.push(
        line(
          'Attempt',
          `${attempt.attemptId} task ${attempt.taskId ?? '-'} ${attempt.role} ${attempt.vendor} ` +
            `${attempt.state}/${attempt.phase ?? '-'} ` +
            `age ${attempt.ageMs === null ? 'unknown' : `${Math.floor(attempt.ageMs / 1_000)}s`} ` +
            `last push ${time(attempt.lastPushAt)} pid/pgid ${attempt.pid ?? '-'}/${attempt.pgid ?? '-'}`,
        ),
      );
    }
    for (const clone of report.keptClones)
      lines.push(line('Kept clone', `${clone.attemptId} ${clone.clone}: ${clone.error}`));
  } else {
    lines.push(
      'Runner is not running or not answering; best effort status.',
      line('Plist', report.plistInstalled ? 'installed' : 'not installed'),
      line('Launchd', report.disabled === null ? 'disabled state unknown' : report.disabled ? 'disabled' : 'enabled'),
      line(
        'Last exit',
        report.lastExit === null
          ? 'unknown'
          : `${report.lastExit.reason} at ${time(report.lastExit.at)} ` +
              `(code ${report.lastExit.code ?? 'unknown'}, clean: ${report.lastExit.clean})`,
      ),
    );
    if (report.lockHolder !== null)
      lines.push(
        line('Lock holder', `pid ${report.lockHolder.pid ?? 'unknown'}, ${report.lockHolder.mode ?? 'unknown'}`),
      );
    lines.push('Last log lines:', ...report.logLines);
  }
  for (const warning of report.warnings) lines.push(`Warning: ${warning}`);
  return `${lines.join('\n')}\n`;
}
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `bun test packages/runner/test/service/status.test.ts packages/cli/test/runner-command.test.ts packages/runner/test/service/host.test.ts && bun test && bun run typecheck`
Expected: the task's tests pass; then the whole suite passes (`0 fail`) and `tsc` exits 0.

buildStatusReport projects safe fields explicitly, including AttemptStatus.lateWorkSha and flat pid, pgid and lstart. Kept clones are ended or stopped records whose clone exists and whose pushError or lateWorkSha is non-null; a pending marker without a pushError supplies a pending-final-work explanation. freeSlots is capacity minus attempts holding a phase, clamped at zero, and acceptingUntil is epoch milliseconds. The CLI exits 0 when the runner answered and 1 otherwise. runnerCommand accepts deps.env, defaulting to process.env. With that environment's AGFLOW_TEST equal to '1', running status skips launchdDisabled; offlineStatus receives launchd:false, runs no Exec and reports disabled:null, plistInstalled:false and no Login Items warning. Tests use recordingExec for both modes and explicitly pass env:{} when testing launchd behaviour.

- [ ] **Step 5: Commit**

```bash
git add -A 'packages/cli/src/runner-command.ts' 'packages/cli/test/runner-command.test.ts' 'packages/runner/src/service/host.ts' 'packages/runner/src/service/status.ts' 'packages/runner/test/service/status.test.ts'
git commit -m 'M2C Task 21: `agflow runner status`' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

### Task 22: Service checks

Setup runs every check inside the running service, over runner.sock (`POST /checks`), so the checks see the service's environment: its proxies, CA trust and git credentials (design 7.1 step 6). The checks are hub whoami; `git ls-remote origin` with M2b's remote git environment; a fenced create-and-delete push of `<wipRefPrefix>_probe/<runner id>`; each adapter's preflight, in the runner's logged-in homes; the dependency-preparation sandbox; and the Mac's sleep timer, with a warning for 1-30 minutes. The route waits for the hub's welcome, which supplies the runner id and the prefix.

**Files:**
- Create: `packages/runner/src/service/checks.ts`
- Modify: `packages/runner/src/service/host.ts`
- Test: `packages/runner/test/service/checks.test.ts`

- [ ] **Step 1: Write the failing test**

**File:** `packages/runner/test/service/checks.test.ts` (new)

```ts
import { afterEach, expect, setDefaultTimeout, spyOn, test } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CREDENTIALS_FILE } from '@agflow/core';
import { gitIn, originRepo } from '@agflow/testkit';
import * as git from '../../src/git/run';
import { LinkClient } from '../../src/link';
import { parsePmsetSettings } from '../../src/ops/power';
import { type CheckResult, formatChecks, runServiceChecks } from '../../src/service/checks';
import { controlRequest } from '../../src/service/control';
import { readCliCredentials } from '../../src/service/credentials';
import { waitFor } from '../fixture';
import { startTestHub } from '../hub-fixture';
import { afterThisTest, cleanupRunnerSetups } from '../runner-setup';
import {
  fakePrepSandbox,
  fakeServiceAdapters,
  recordingExec,
  setupTestService,
  startTestService,
} from '../service-helpers';

afterEach(cleanupRunnerSetups);
setDefaultTimeout(60_000);

const names = ['hub', 'git ls-remote', 'wip push', 'claude', 'codex', 'dependency preparation', 'sleep'];
const pmset = (sleep: number) =>
  recordingExec([{ argv: ['pmset', '-g'], result: { stdout: `Currently in use:\n sleep ${sleep}\n` } }]);
const checks = (paths: Parameters<typeof controlRequest>[0]) =>
  controlRequest<CheckResult[]>(paths, 'POST', '/checks', undefined, { timeoutMs: 50_000 });
const result = (results: CheckResult[], name: string) => results.find((entry) => entry.name === name)!;

async function localService() {
  const origin = await originRepo({ 'README.md': '# checks\n' });
  afterThisTest(() => origin.remove());
  const hub = startTestHub({
    config: { projectName: 'checks', projectRepo: origin.path, wipRefPrefix: 'refs/checks/' },
  });
  afterThisTest(() => hub.stop());
  const exec = pmset(0);
  let initialized = 0;
  const sandbox = fakePrepSandbox({
    initialize: async () => {
      initialized++;
    },
  });
  const s = await startTestService({ hub, host: { exec, platform: 'darwin', prepSandbox: sandbox } });
  await waitFor(() => s.service.runner?.status().link === 'online');
  return { ...s, origin, exec, initialized: () => initialized };
}

test('POST /checks passes every check, reuses the sandbox, and removes the probe from a local origin', async () => {
  const s = await localService();
  const results = await checks(s.paths);
  expect(results.map((entry) => entry.name)).toEqual(names);
  expect(results.every((entry) => entry.status === 'pass')).toBe(true);
  expect(result(results, 'hub').detail).toContain('alice');
  const ref = `refs/checks/_probe/${s.service.runner!.status().runnerId}`;
  expect(result(results, 'wip push').detail).toContain(ref);
  expect(await gitIn(s.origin.path, ['for-each-ref', '--format=%(refname)', 'refs/checks/'])).toBe('');
  expect(s.initialized()).toBe(1);
  expect(s.exec.calls).toContainEqual({ argv: ['pmset', '-g'], options: { timeoutMs: 5_000 } });
  expect(formatChecks(results)).toContain('all passed');
  for (const entry of results) expect(entry.detail).not.toMatch(/[\r\n]/);
  expect(JSON.stringify(results)).not.toContain(s.hub.token);
});

test('a leftover probe is deleted on its current sha before a fenced creation and deletion', async () => {
  const s = await localService();
  const ref = `refs/checks/_probe/${s.service.runner!.status().runnerId}`;
  await gitIn(s.origin.path, ['update-ref', ref, s.origin.mainSha]);
  const run = git.runGit;
  const calls: { environment: git.GitEnvironment; args: string[] }[] = [];
  const observer = spyOn(git, 'runGit').mockImplementation(async (environment, args, options) => {
    calls.push({ environment, args });
    return run(environment, args, options);
  });
  afterThisTest(() => observer.mockRestore());
  expect(result(await checks(s.paths), 'wip push').status).toBe('pass');
  const pushes = calls.filter((call) => call.args.includes('push'));
  expect(pushes).toHaveLength(3);
  expect(pushes[0]!.args).toContain(`--force-with-lease=${ref}:${s.origin.mainSha}`);
  expect(pushes[0]!.args.at(-1)).toBe(`:${ref}`);
  expect(pushes[1]!.args).toContain(`--force-with-lease=${ref}:`);
  const sha = pushes[1]!.args.at(-1)!.split(':')[0]!;
  expect(pushes[2]!.args).toContain(`--force-with-lease=${ref}:${sha}`);
  expect(pushes[2]!.args.at(-1)).toBe(`:${ref}`);
  for (const call of pushes) {
    expect(call.environment.name).toBe('remote');
    expect(call.environment.env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(call.args[0]).toBe(`--git-dir=${s.service.runner!.vault.path}`);
    expect(call.args).toContain('--atomic');
  }
  expect(await gitIn(s.origin.path, ['for-each-ref', '--format=%(refname)', ref])).toBe('');
  expect(await gitIn(s.service.runner!.vault.path, ['show', '-s', '--format=%P', sha])).toBe('');
});

test('an unreachable origin fails both git checks with git stderr and still runs later checks', async () => {
  const s = await localService();
  s.origin.remove();
  const results = await checks(s.paths);
  const remote = result(results, 'git ls-remote');
  expect(remote.status).toBe('fail');
  expect(remote.detail).toContain('does not appear to be a git repository');
  expect(remote.detail).not.toMatch(/[\r\n]/);
  expect(result(results, 'wip push')).toEqual({ ...remote, name: 'wip push' });
  expect(result(results, 'sleep').status).toBe('pass');
});

test('a probe ref moved before deletion is preserved and the check fails', async () => {
  const s = await localService();
  const ref = `refs/checks/_probe/${s.service.runner!.status().runnerId}`;
  const run = git.runGit;
  let moved = false;
  const observer = spyOn(git, 'runGit').mockImplementation(async (environment, args, options) => {
    if (!moved && args.includes('push') && args.at(-1) === `:${ref}`) {
      moved = true;
      await gitIn(s.origin.path, ['update-ref', ref, s.origin.mainSha]);
    }
    return run(environment, args, options);
  });
  afterThisTest(() => observer.mockRestore());
  const results = await checks(s.paths);
  expect(moved).toBe(true);
  expect(result(results, 'wip push').status).toBe('fail');
  expect(result(results, 'wip push').detail).toContain('moved');
  expect(await gitIn(s.origin.path, ['rev-parse', ref])).toBe(s.origin.mainSha);
  expect(result(results, 'sleep').status).toBe('pass');
});

test('a remote that refuses probe creation reports its message and still runs later checks', async () => {
  const s = await localService();
  // Local receive policy refuses probe updates; keep the test entirely on the scratch origin.
  await gitIn(s.origin.path, ['config', 'receive.hideRefs', 'refs/checks/']);
  const results = await checks(s.paths);
  expect(result(results, 'git ls-remote').status).toBe('pass');
  expect(result(results, 'wip push').status).toBe('fail');
  expect(result(results, 'wip push').detail).toContain('hidden ref');
  expect(result(results, 'sleep').status).toBe('pass');
  expect(await gitIn(s.origin.path, ['for-each-ref', '--format=%(refname)', 'refs/checks/'])).toBe('');
});

test('concurrent check requests serialize their probes under the vault lock', async () => {
  const s = await localService();
  const results = await Promise.all([checks(s.paths), checks(s.paths)]);
  expect(results.every((entries) => entries.every((entry) => entry.status === 'pass'))).toBe(true);
  expect(await gitIn(s.origin.path, ['for-each-ref', '--format=%(refname)', 'refs/checks/'])).toBe('');
});

test('a refused CLI token is re-read and reports the login hint', async () => {
  const s = await localService();
  writeFileSync(join(s.configDir, CREDENTIALS_FILE), JSON.stringify({ ...s.hub.credentials, token: 'revoked-token' }));
  const results = await checks(s.paths);
  expect(result(results, 'hub')).toEqual({
    name: 'hub',
    status: 'fail',
    detail: `the hub refused the CLI sign-in; run agflow login --hub ${s.hub.url}`,
  });
  expect(result(results, 'wip push').status).toBe('pass');
});

test('a sign-in to another hub fails the hub check and names the runner hub', async () => {
  const s = await localService();
  const other = { ...s.hub.credentials, hubUrl: 'http://127.0.0.1:9' };
  writeFileSync(join(s.configDir, CREDENTIALS_FILE), JSON.stringify(other));
  const results = await checks(s.paths);
  expect(result(results, 'hub')).toEqual({
    name: 'hub',
    status: 'fail',
    detail: `the CLI is not signed in to the runner's hub; run agflow login --hub ${s.hub.url}`,
  });
});

test('unreachable whoami, failed preflights and a broken sandbox are isolated', async () => {
  const adapters = fakeServiceAdapters();
  const preflight = adapters[1]!.preflight.bind(adapters[1]);
  adapters[0]!.preflight = async () => {
    throw new Error('CLI crashed\ntry again');
  };
  adapters[1]!.preflight = async () => {
    const ready = await preflight();
    return { ...ready, facts: { ...ready.facts, ready: false, problem: 'codex_apps is enabled' } };
  };
  const s = await startTestService({
    host: {
      adapters,
      platform: 'darwin',
      exec: pmset(0),
      prepSandbox: fakePrepSandbox({
        initialize: async () => {
          throw new Error('sandbox unavailable');
        },
      }),
      fetch: async (input, init) => {
        if (String(input).endsWith('/api/runner/whoami')) throw new Error('connection refused');
        return fetch(input, init);
      },
    },
  });
  const results = await checks(s.paths);
  expect(result(results, 'hub')).toMatchObject({
    status: 'fail',
    detail: expect.stringContaining('connection refused'),
  });
  expect(result(results, 'claude')).toMatchObject({ status: 'fail', detail: 'CLI crashed try again' });
  expect(result(results, 'codex')).toMatchObject({ status: 'fail', detail: 'codex_apps is enabled' });
  expect(result(results, 'dependency preparation')).toMatchObject({ status: 'fail', detail: 'sandbox unavailable' });
  expect(result(results, 'sleep').status).toBe('pass');
});

for (const [minutes, status] of [
  [0, 'pass'],
  [1, 'warn'],
  [30, 'warn'],
  [31, 'pass'],
] as const) {
  test(`sleep ${minutes} is ${status}`, async () => {
    expect(parsePmsetSettings(` sleep ${minutes}\n`).sleepMinutes).toBe(minutes);
    const s = await startTestService();
    const results = await runServiceChecks({
      runner: s.service.runner!,
      welcome: Promise.resolve({ runnerId: 'sleep-test', wipRefPrefix: 'refs/checks/' }),
      credentials: () => readCliCredentials(s.configDir),
      hubUrl: s.hub.url,
      adapters: [],
      sandbox: fakePrepSandbox(),
      exec: pmset(minutes),
      platform: 'darwin',
    });
    const sleep = result(results, 'sleep');
    expect(sleep.status).toBe(status);
    if (status === 'warn') {
      expect(sleep.detail).toContain(`${minutes} minutes of idle`);
      expect(sleep.detail).toContain('agents stop');
      expect(sleep.detail).toContain('sudo pmset -c sleep 0');
    }
  });
}

for (const platform of ['darwin', 'linux'] as const) {
  test(`unknown sleep timer warns on ${platform}`, async () => {
    const exec = recordingExec([], { exitCode: 127, stderr: 'pmset missing' });
    const s = await startTestService({ host: { exec, platform } });
    expect(result(await checks(s.paths), 'sleep')).toMatchObject({
      status: 'warn',
      detail: expect.stringContaining('sleep timer could not be read'),
    });
    if (platform === 'linux') expect(exec.calls).toHaveLength(0);
  });
}

// Hold link startup, leaving the real host and HTTP hub running before their first welcome.
function holdLink() {
  const start = LinkClient.prototype.start;
  let link: LinkClient;
  const gate = spyOn(LinkClient.prototype, 'start').mockImplementation(function (this: LinkClient) {
    link = this;
  });
  afterThisTest(() => gate.mockRestore());
  return () => {
    gate.mockRestore();
    start.call(link);
  };
}

test('POST /checks waits for the first welcome and then probes the welcome ref', async () => {
  const release = holdLink();
  const s = await startTestService({ host: { exec: pmset(0), platform: 'darwin', checksWelcomeTimeoutMs: 5_000 } });
  expect(s.service.runner!.status().runnerId).toBeNull();
  let answered = false;
  const pending = checks(s.paths).then((results) => {
    answered = true;
    return results;
  });
  try {
    await Bun.sleep(100);
    expect(answered).toBe(false);
  } finally {
    release();
  }
  const results = await pending;
  expect(results.every((entry) => entry.status === 'pass')).toBe(true);
  expect(result(results, 'wip push').detail).toContain(s.service.runner!.status().runnerId!);
});

test('POST /checks times out without welcome but runs all independent checks', async () => {
  holdLink();
  const s = await startTestService({ host: { exec: pmset(0), platform: 'darwin', checksWelcomeTimeoutMs: 40 } });
  const results = await checks(s.paths);
  expect(results.map((entry) => entry.name)).toEqual(names);
  expect(result(results, 'hub').status).toBe('fail');
  expect(result(results, 'hub').detail).toContain('no welcome from the hub within 0.04 s');
  expect(result(results, 'hub').detail).toContain('idle');
  expect(result(results, 'wip push').status).toBe('fail');
  expect(result(results, 'wip push').detail).toContain('skipped');
  expect(result(results, 'wip push').detail).toContain('runner id');
  expect(results.slice(3).every((entry) => entry.status === 'pass')).toBe(true);
});

test('POST /checks before the runner exists waits for startup and then runs the checks', async () => {
  // A short credentials probe needs test mode's short timings.
  const previous = process.env.AGFLOW_TEST;
  process.env.AGFLOW_TEST = '1';
  afterThisTest(() => {
    if (previous === undefined) delete process.env.AGFLOW_TEST;
    else process.env.AGFLOW_TEST = previous;
  });
  const s = await setupTestService({
    noCredentials: true,
    mode: 'service',
    config: { timings: { loginProbe: 50 } },
    host: { exec: pmset(0), platform: 'darwin', checksWelcomeTimeoutMs: 20_000 },
  });
  const starting = s.start();
  let answered = false;
  const pending = (async () => {
    await waitFor(() => existsSync(s.paths.socket));
    const results = await checks(s.paths);
    answered = true;
    return results;
  })();
  await Bun.sleep(200);
  expect(answered).toBe(false);
  writeFileSync(join(s.configDir, CREDENTIALS_FILE), JSON.stringify(s.hub.credentials), { mode: 0o600 });
  const results = await pending;
  expect(results.map((entry) => entry.name)).toEqual(names);
  expect(results.every((entry) => entry.status === 'pass')).toBe(true);
  expect((await starting).runner).not.toBeNull();
});

test('POST /checks names the login hold when the runner does not start within the budget', async () => {
  const s = await setupTestService({ noCredentials: true, mode: 'service', host: { checksWelcomeTimeoutMs: 50 } });
  const starting = s.start();
  try {
    await waitFor(() => existsSync(s.paths.socket));
    await expect(checks(s.paths)).rejects.toThrow(
      'the runner did not start within 0.05 s (needs_login: not signed in; run agflow login)',
    );
  } finally {
    await controlRequest(s.paths, 'POST', '/suspend');
    await starting;
  }
});

test('formatChecks keeps one line per check and summarizes failures and warnings', () => {
  const results: CheckResult[] = [
    { name: 'hub', status: 'pass', detail: 'alice' },
    { name: 'codex', status: 'fail', detail: 'login required' },
    { name: 'sleep', status: 'warn', detail: 'unknown' },
  ];
  const text = formatChecks(results);
  expect(text.split('\n')).toHaveLength(4);
  expect(text).toContain('ok hub: alice');
  expect(text).toContain('FAIL codex: login required');
  expect(text).toContain('warn sleep: unknown');
  expect(text).toContain('1 failed');
  expect(text).toContain('1 warnings');
  expect(formatChecks(results.slice(2))).toContain('1 warnings');
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `bun test packages/runner/test/service/checks.test.ts`
Expected: FAIL — `error: Cannot find module '../../src/service/checks' from 'packages/runner/test/service/checks.test.ts'` (0 pass, 1 fail, 1 error)

- [ ] **Step 3: Implement**

**File:** `packages/runner/src/service/checks.ts` (new)

```ts
// Setup checks run in the service, with its credentials, remote git environment and shared sandbox (design 7.1).
import type { VendorAdapter } from '../adapters/types';
import { deleteRefsFenced, lsRemote, type PushGit, pushRefs } from '../git/push';
import { remoteGitEnv, runGit } from '../git/run';
import { type FetchFn, RunnerHttpError, RunnerHubHttp } from '../hub-http';
import type { CredentialsProvider, WelcomeMessage } from '../link';
import { parsePmsetSettings } from '../ops/power';
import { checkPrepSandbox, type PrepSandbox } from '../prep/sandbox';
import type { RunnerHandle } from '../runner';
import type { Exec } from './system';

export interface CheckResult {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
}

export interface ServiceChecksInput {
  runner: Pick<RunnerHandle, 'vault' | 'status'>;
  welcome: Promise<Pick<WelcomeMessage, 'runnerId' | 'wipRefPrefix'>>;
  /** Gives null for credentials of another hub than the runner's, as createRunner's provider does. */
  credentials: CredentialsProvider;
  /** The runner's hub, which a sign-in hint names. */
  hubUrl: string | null;
  adapters: readonly VendorAdapter[];
  sandbox: PrepSandbox;
  fetch?: FetchFn;
  exec: Exec;
  platform: NodeJS.Platform;
  /** The first welcome can lag startup; 30 s by default. */
  welcomeTimeoutMs?: number;
}

function describe(value: unknown): string {
  return (value instanceof Error ? value.message : String(value)).replace(/[\r\n]+/g, ' ').trim();
}

async function check(name: string, run: () => Promise<Omit<CheckResult, 'name'>>): Promise<CheckResult> {
  try {
    const result = await run();
    return { name, ...result, detail: describe(result.detail) };
  } catch (error) {
    return { name, status: 'fail', detail: describe(error) };
  }
}

async function waitForWelcome(input: ServiceChecksInput) {
  const ms = input.welcomeTimeoutMs ?? 30_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const welcome = await Promise.race([
      input.welcome,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
    if (welcome === null) {
      throw new Error(`no welcome from the hub within ${ms / 1000} s (link: ${input.runner.status().link})`);
    }
    return welcome;
  } finally {
    clearTimeout(timer);
  }
}

async function deleteProbe(git: PushGit, ref: string, expectedSha: string): Promise<void> {
  const [deleted] = await deleteRefsFenced({ ...git, refs: [{ ref, expectedSha }] });
  if (deleted?.status !== 'deleted') {
    throw new Error(deleted?.detail ?? `${ref}: fenced deletion ${deleted?.status ?? 'failed'}`);
  }
}

async function probe(git: PushGit, welcome: Pick<WelcomeMessage, 'runnerId' | 'wipRefPrefix'>): Promise<string> {
  const ref = `${welcome.wipRefPrefix}_probe/${welcome.runnerId}`;
  return git.vault.withLock(async () => {
    const leftover = (await lsRemote(git, [ref])).get(ref);
    if (leftover !== undefined) await deleteProbe(git, ref, leftover);
    // The vault may hold no commits yet. This parentless probe needs neither a fetch nor an owner's identity.
    const repository = `--git-dir=${git.vault.path}`;
    const tree = await runGit(git.local, [repository, 'mktree'], { input: '' });
    const commit = await runGit(
      git.local,
      [repository, 'commit-tree', tree.stdout.trim(), '-m', 'agflow: setup probe'],
      {
        env: {
          GIT_AUTHOR_NAME: 'agflow',
          GIT_AUTHOR_EMAIL: 'agflow@agflow.invalid',
          GIT_COMMITTER_NAME: 'agflow',
          GIT_COMMITTER_EMAIL: 'agflow@agflow.invalid',
        },
      },
    );
    const sha = commit.stdout.trim();
    const pushed = await pushRefs({ ...git, updates: [{ ref, sha, expected: null }] });
    if (!pushed.ok) throw new Error(pushed.detail);
    await deleteProbe(git, ref, sha);
    if ((await lsRemote(git, [ref])).has(ref)) throw new Error(`${ref} still exists after the probe`);
    return `created and deleted ${ref} with exact leases`;
  });
}

/** Each failure is a result, so setup still sees every independent check, in a stable order. */
export async function runServiceChecks(input: ServiceChecksInput): Promise<CheckResult[]> {
  const http = new RunnerHubHttp({ credentials: input.credentials, fetch: input.fetch });
  const [hub, arrival] = await Promise.all([
    check('hub', async () => {
      try {
        const { user } = await http.whoami();
        return { status: 'pass', detail: `signed in as ${user}` };
      } catch (error) {
        const hub = input.hubUrl ?? '<url>';
        if (error instanceof RunnerHttpError && error.status === 401) {
          throw new Error(`the hub refused the CLI sign-in; run agflow login --hub ${hub}`);
        }
        if (error instanceof RunnerHttpError && error.code === 'signed_out') {
          throw new Error(`the CLI is not signed in to the runner's hub; run agflow login --hub ${hub}`);
        }
        throw error;
      }
    }),
    waitForWelcome(input).then(
      (welcome) => ({ welcome, error: null }),
      (error: unknown) => ({ welcome: null, error: describe(error) }),
    ),
  ]);
  if (arrival.error !== null) {
    hub.detail = hub.status === 'fail' ? `${hub.detail}; ${arrival.error}` : arrival.error;
    hub.status = 'fail';
  }
  let git: PushGit | null = null;
  const remote = await check('git ls-remote', async () => {
    const vault = input.runner.vault;
    await vault.ensure();
    git = { vault, local: vault.local, remote: await remoteGitEnv({ gitDir: vault.path }) };
    await runGit(git.remote, [`--git-dir=${vault.path}`, 'ls-remote', 'origin']);
    return { status: 'pass', detail: 'git ls-remote origin succeeded' };
  });
  const push = await check('wip push', async () => {
    if (arrival.welcome === null) throw new Error('skipped: no runner id or WIP prefix from the hub welcome');
    // Repeating an unreachable remote only delays the independent checks and gives the same diagnosis.
    if (remote.status === 'fail') throw new Error(remote.detail);
    return { status: 'pass', detail: await probe(git!, arrival.welcome) };
  });
  const results = [hub, remote, push];
  for (const adapter of input.adapters) {
    results.push(
      await check(adapter.vendor, async () => {
        const { facts } = await adapter.preflight();
        return facts.ready
          ? { status: 'pass', detail: `CLI ${facts.cliVersion ?? 'unknown'}; plan ${facts.plan ?? 'unknown'}` }
          : { status: 'fail', detail: facts.problem ?? 'preflight is not ready' };
      }),
    );
  }
  results.push(
    await check('dependency preparation', async () => {
      const checked = await checkPrepSandbox({ sandbox: input.sandbox });
      return checked.works
        ? { status: 'pass', detail: 'preparation sandbox works' }
        : { status: 'fail', detail: checked.reason ?? 'preparation sandbox failed' };
    }),
  );
  results.push(
    await check('sleep', async () => {
      let minutes: number | null = null;
      if (input.platform === 'darwin') {
        try {
          const settings = await input.exec(['pmset', '-g'], { timeoutMs: 5_000 });
          if (settings.exitCode === 0 && !settings.timedOut) {
            minutes = parsePmsetSettings(settings.stdout).sleepMinutes;
          }
        } catch {
          // Missing pmset and unreadable output are both an unknown timer, not a failed setup.
        }
      }
      if (minutes === null) return { status: 'warn', detail: 'the sleep timer could not be read' };
      if (minutes >= 1 && minutes <= 30) {
        return {
          status: 'warn',
          detail:
            `the Mac sleeps after ${minutes} minutes of idle and agents stop with it; ` +
            'use System Settings > Lock Screen / Battery or sudo pmset -c sleep 0',
        };
      }
      return {
        status: 'pass',
        detail: minutes === 0 ? 'idle sleep is disabled' : `idle sleep after ${minutes} minutes`,
      };
    }),
  );
  return results;
}

export function formatChecks(results: readonly CheckResult[]): string {
  const marks = { pass: 'ok', warn: 'warn', fail: 'FAIL' };
  const lines = results.map((result) => `${marks[result.status]} ${result.name}: ${describe(result.detail)}`);
  const failed = results.filter((result) => result.status === 'fail').length;
  const warnings = results.filter((result) => result.status === 'warn').length;
  const summary = [failed ? `${failed} failed` : '', warnings ? `${warnings} warnings` : ''].filter(Boolean);
  return [...lines, summary.join(', ') || 'all passed'].join('\n');
}
```

**File:** `packages/runner/src/service/host.ts` (change)

```diff
diff --git a/packages/runner/src/service/host.ts b/packages/runner/src/service/host.ts
index 8a969a99..10f5fd10 100644
--- a/packages/runner/src/service/host.ts
+++ b/packages/runner/src/service/host.ts
@@ -11,6 +11,7 @@ import { editLocalSettings, isTestMode, loadRunnerConfig, type RunnerConfig, sav
 import { openRunnerDb, type RunnerDb } from '../db';
 import type { FetchFn } from '../hub-http';
 import { Journal } from '../journal';
+import { sameHubUrl, type WelcomeMessage } from '../link';
 import { createServiceHealth, type ServiceHealth } from '../ops/health';
 import { KeepAwake } from '../ops/keep-awake';
 import type { PowerSample } from '../ops/power';
@@ -23,6 +24,7 @@ import { standardProfile } from '../profile';
 import { killRegisteredGroups } from '../recovery';
 import { createRunner, type RunnerEvents, type RunnerHandle, type RunnerOptions } from '../runner';
 import type { DependencyPreparer, Notifier } from '../seams';
+import { runServiceChecks } from './checks';
 import { type ControlRoutes, type ControlServer, startControlServer } from './control';
 import { readCliCredentials } from './credentials';
 import { applyCrashLoopGuard } from './drain';
@@ -87,6 +89,8 @@ export interface RunnerServiceOptions {
   caffeinate?: string;
   /** Shared preparation sandbox; checked once at service start. */
   prepSandbox?: PrepSandbox;
+  /** Setup checks wait up to 30 s for the first hub welcome. */
+  checksWelcomeTimeoutMs?: number;
 }
 
 export interface RunnerService {
@@ -140,6 +144,10 @@ function describe(error: unknown): string {
 export async function startRunnerService(options: RunnerServiceOptions): Promise<RunnerService> {
   const paths = options.paths ?? runnerPaths();
   const { mode, configDir, agflow } = options;
+  const credentialsProvider = () => readCliCredentials(configDir);
+  const firstWelcome = Promise.withResolvers<WelcomeMessage>();
+  let currentWelcome: WelcomeMessage | null = null;
+  let adapters: VendorAdapter[] = [];
   const terminal =
     options.terminal ??
     ((line: string) => {
@@ -154,6 +162,8 @@ export async function startRunnerService(options: RunnerServiceOptions): Promise
   };
   const exited = Promise.withResolvers<ServiceExit>();
   const initialized = Promise.withResolvers<void>();
+  // The runner once createRunner returns; null when the service ends before that.
+  const runnerUp = Promise.withResolvers<RunnerHandle | null>();
   const waiting = new AbortController();
   let lock: RunnerLock | null = null;
   let logger: RotatingLog | null = null;
@@ -191,6 +201,7 @@ export async function startRunnerService(options: RunnerServiceOptions): Promise
   function finish(input: ServiceExit, level: 'info' | 'error', agents: AgentsEnd = 'stop'): Promise<ServiceExit> {
     if (ending) return exited.promise;
     ending = true;
+    runnerUp.resolve(null);
     const deadline = performance.now() + suspendMs;
     waiting.abort();
     // A retention sweep under way stops before its next step, so teardown waits only for the step it is in.
@@ -298,6 +309,44 @@ export async function startRunnerService(options: RunnerServiceOptions): Promise
 
   // The control socket's routes; the commands of later tasks add theirs here.
   const routes: ControlRoutes = {
+    'POST /checks': async () => {
+      // Setup asks right after install, while the socket already answers but the runner may still be starting: the
+      // wait for it counts against the welcome's budget.
+      const budgetMs = options.checksWelcomeTimeoutMs ?? 30_000;
+      const startedAt = performance.now();
+      const waited = runner === null;
+      let timer: ReturnType<typeof setTimeout> | undefined;
+      const ready =
+        runner ??
+        (await Promise.race([
+          runnerUp.promise,
+          new Promise<'timeout'>((resolve) => {
+            timer = setTimeout(() => resolve('timeout'), budgetMs);
+          }),
+        ]).finally(() => clearTimeout(timer)));
+      if (ready === null) throw new Error('the runner service is stopping');
+      if (ready === 'timeout') {
+        const login = needsLogin?.state();
+        const state = login?.on ? `needs_login: ${login.reason}; run agflow login` : 'still starting';
+        throw new Error(`the runner did not start within ${budgetMs / 1000} s (${state})`);
+      }
+      return runServiceChecks({
+        runner: ready,
+        welcome: currentWelcome === null ? firstWelcome.promise : Promise.resolve(currentWelcome),
+        adapters,
+        sandbox: sandbox!,
+        // Pinned like createRunner's: a sign-in to another hub must not pass the checks of this runner's.
+        credentials: () => {
+          const current = credentialsProvider();
+          return current !== null && hubUrl !== null && sameHubUrl(current.hubUrl, hubUrl) ? current : null;
+        },
+        hubUrl,
+        fetch: options.fetch,
+        exec: options.exec ?? defaultExec,
+        platform: options.platform ?? process.platform,
+        welcomeTimeoutMs: waited ? Math.max(0, Math.round(budgetMs - (performance.now() - startedAt))) : budgetMs,
+      });
+    },
     'GET /status': () => {
       const status = runner?.status() ?? null;
       const records = store?.list() ?? [];
@@ -358,6 +407,8 @@ export async function startRunnerService(options: RunnerServiceOptions): Promise
     },
     gap: (gap) => health?.gap(gap),
     welcome: (welcome) => {
+      currentWelcome = welcome;
+      firstWelcome.resolve(welcome);
       heartbeatMs = welcome.timings.heartbeatMs;
       needsLogin?.leave();
     },
@@ -472,7 +523,7 @@ export async function startRunnerService(options: RunnerServiceOptions): Promise
       if (ending) return;
       hubUrl = credentials!.hubUrl;
     }
-    const adapters = options.adapters ?? (options.createAdapters ?? createAdapters)(config, paths, { agflow });
+    adapters = options.adapters ?? (options.createAdapters ?? createAdapters)(config, paths, { agflow });
     sandbox =
       options.prepSandbox ?? new PrepSandbox({ allowedDomains: standardProfile.network.allowedDomains, logger });
     preparer = await createDependencyPreparer({ paths, store, config: () => config, logger, sandbox });
@@ -483,7 +534,7 @@ export async function startRunnerService(options: RunnerServiceOptions): Promise
       paths,
       config,
       db,
-      credentials: () => readCliCredentials(configDir),
+      credentials: credentialsProvider,
       adapters,
       cliVersion: options.cliVersion,
       agflow,
@@ -495,6 +546,7 @@ export async function startRunnerService(options: RunnerServiceOptions): Promise
       fetch: options.fetch,
       tmpRoot: options.tmpRoot,
     });
+    runnerUp.resolve(runner);
     if (crashLoop) await runner.changeSettings({ draining: true });
     health.start();
     keepAwake.evaluate();
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `bun test packages/runner/test/service/checks.test.ts packages/runner/test/service/host.test.ts && bun test && bun run typecheck`
Expected: the task's tests pass; then the whole suite passes (`0 fail`) and `tsc` exits 0.

`POST /checks` waits for `createRunner` and then for the welcome within one budget of 30 s. If the welcome does not come, the hub check fails with the link state and the WIP push is reported as skipped. The probe is a parentless empty commit (made with a fixed agflow identity, so an empty vault works), pushed with an exact lease and deleted with a fenced delete; a probe ref someone else moved is left alone and the check fails. The checks' credentials are pinned to the runner's hub, like `createRunner`'s, and a refusal names `agflow login --hub <runner hub>`.

- [ ] **Step 5: Commit**

```bash
git add -A 'packages/runner/src/service/checks.ts' 'packages/runner/src/service/host.ts' 'packages/runner/test/service/checks.test.ts'
git commit -m 'M2C Task 22: Service checks' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

### Task 23: `agflow runner setup`

`agflow runner setup` (design 7.1), run once per laptop. It checks the sign-in (credentials, then `GET /api/runner/whoami` through the new `HubClient.runnerWhoami`), writes runner.json (a re-run on the same Mac keeps the key, and a copied one gets a new key), installs the pinned binaries, and logs Claude and Codex in to the runner's homes unless a subscription login exists or `--relogin` is given. Then it installs the service, waits for runner.sock and prints every check run inside it, and exits 1 if one fails. `--no-service` stops before the service, and test mode refuses that step with the reason.

**Files:**
- Modify: `packages/cli/src/hub-client.ts`
- Modify: `packages/cli/src/runner-command.ts`
- Create: `packages/cli/src/runner-setup.ts`
- Test: `packages/cli/test/runner-command.test.ts`
- Test: `packages/cli/test/runner-setup.test.ts`
- Test: `packages/runner/test/service-helpers.ts`

- [ ] **Step 1: Write the failing tests**

**File:** `packages/cli/test/runner-command.test.ts` (change)

```diff
diff --git a/packages/cli/test/runner-command.test.ts b/packages/cli/test/runner-command.test.ts
index 746599dc..2e3af65f 100644
--- a/packages/cli/test/runner-command.test.ts
+++ b/packages/cli/test/runner-command.test.ts
@@ -66,6 +66,7 @@ describe('agflow runner', () => {
     const { io, out, err } = capture();
     expect(await main(['help'], io)).toBe(0);
     expect(RUNNER_HELP).toContain('agflow runner start [--service]');
+    expect(RUNNER_HELP).toContain('agflow runner setup [--yes] [--relogin] [--no-service]');
     expect(RUNNER_HELP).toContain('agflow runner drain');
     expect(RUNNER_HELP).toContain('agflow runner undrain');
     expect(RUNNER_HELP).toContain('agflow runner install');
@@ -88,6 +89,13 @@ console.log(JSON.stringify(Object.keys(require.cache).filter((path) => path.incl
     expect(JSON.parse(stdout)).toEqual([]);
   });
 
+  test('setup rejects extra positional arguments', async () => {
+    const { io, out, err } = capture();
+    expect(await main(['runner', 'setup', 'extra'], io)).toBe(2);
+    expect(err.join('')).toContain('usage: agflow runner setup [--yes] [--relogin] [--no-service]');
+    expect(out).toEqual([]);
+  });
+
   test('start rejects extra positional arguments', async () => {
     const { io, err } = capture();
     expect(await main(['runner', 'start', 'extra'], io)).toBe(2);
```

**File:** `packages/cli/test/runner-setup.test.ts` (new)

```ts
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadRunnerConfig, saveRunnerConfig } from '@agflow/runner/src/config';
import { runnerPaths } from '@agflow/runner/src/paths';
import { startControlServer } from '@agflow/runner/src/service/control';
import { type RunnerService, startRunnerService } from '@agflow/runner/src/service/host';
import { installRefusal, plistPath } from '@agflow/runner/src/service/launchd';
import { acquireRunnerLock } from '@agflow/runner/src/service/lock';
import { defaultExec, type Exec } from '@agflow/runner/src/service/system';
import { type PlatformPins, VENDOR_PINS, vendorBinary } from '@agflow/runner/src/vendor/pins';
import { fixtureCliVersion } from '@agflow/runner/test/fixture';
import { afterThisTest, cleanupRunnerSetups, tempDir } from '@agflow/runner/test/runner-setup';
import {
  type ExecCall,
  fakePrepSandbox,
  fakeServiceAdapters,
  fakeServiceOperations,
  localRegistry,
  packTarball,
  startOriginHub,
} from '@agflow/runner/test/service-helpers';
import { parseArgs } from '../src/args';
import { deleteCredentials, saveCredentials } from '../src/credentials';
import { HubClient } from '../src/hub-client';
import { runnerCommand } from '../src/runner-command';
import { type Prompt, runnerSetup, type RunnerSetupDeps } from '../src/runner-setup';
import { shellQuote } from '../src/self';

setDefaultTimeout(60_000);
beforeEach(() => {
  for (const name of ['AGFLOW_HOME', 'AGFLOW_CONFIG_DIR']) {
    const previous = process.env[name];
    process.env[name] = tempDir('agf-setup-env-');
    afterThisTest(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
  }
});
afterEach(cleanupRunnerSetups);

const machineId = '12345678-1234-1234-1234-123456789abc';
const checkNames = ['hub', 'git ls-remote', 'wip push', 'claude', 'codex', 'dependency preparation', 'sleep'];
interface VendorCall {
  vendor: string;
  argv: string[];
  env: Record<string, string>;
}

async function fixture(options: { failCheck?: boolean; noBootstrap?: boolean } = {}) {
  const root = realpathSync(mkdtempSync('/tmp/agf-su-'));
  afterThisTest(() => rmSync(root, { recursive: true, force: true }));
  const paths = runnerPaths(join(root, 'agflow'));
  const dir = join(root, 'cli');
  const home = join(root, 'owner');
  mkdirSync(home);
  const hub = await startOriginHub();
  saveCredentials(hub.credentials, dir);
  const log = join(root, 'vendor-calls.jsonl');
  const cli = (vendor: 'claude' | 'codex') => {
    const source = `
const fs = require('node:fs');
const argv = process.argv.slice(1);
const vendor = ${JSON.stringify(vendor)};
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ vendor, argv, env: process.env }) + '\\n');
if (argv[0] === '--version') {
  console.log(vendor === 'claude' ? '2.1.285 (Claude Code)' : 'codex-cli 0.159.2');
  process.exit(0);
}
const home = vendor === 'claude' ? process.env.CLAUDE_CONFIG_DIR : process.env.CODEX_HOME;
const marker = home + '/signed-in';
if (JSON.stringify(argv) === JSON.stringify(vendor === 'claude' ? ['auth', 'login', '--claudeai'] : ['login'])) {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(marker, 'ok');
  process.exit(0);
}
if (JSON.stringify(argv) !== JSON.stringify(vendor === 'claude' ? ['auth', 'status', '--json'] : ['login', 'status'])) {
  process.exit(99);
}
const ok = fs.existsSync(marker);
console.log(vendor === 'claude' ? JSON.stringify({ loggedIn: ok, authMethod: 'claude.ai', subscriptionType: 'max' })
  : ok ? 'Logged in using ChatGPT' : 'Not logged in');
process.exit(ok ? 0 : 1);
`;
    return `#!/bin/sh\nexec ${shellQuote(process.execPath)} -e ${shellQuote(source)} -- "$@"\n`;
  };
  const claude = cli('claude');
  const claudeTar = await packTarball({ claude: { content: claude } });
  const tree = VENDOR_PINS['darwin-arm64']!.codex.tree;
  const codexTar = await packTarball({
    [`${tree}/bin/codex`]: { content: cli('codex'), mode: 0o755 },
    [`${tree}/bin/codex-code-mode-host`]: { content: 'fake host', mode: 0o755 },
    [`${tree}/codex-path/rg`]: { content: 'fake rg', mode: 0o755 },
  });
  const pins: PlatformPins = {
    claude: {
      ...VENDOR_PINS['darwin-arm64']!.claude,
      integrity: claudeTar.integrity,
      sha256: createHash('sha256').update(claude).digest('hex'),
    },
    codex: { ...VENDOR_PINS['darwin-arm64']!.codex, integrity: codexTar.integrity },
  };
  const registry = localRegistry([
    { ...pins.claude, bytes: claudeTar.bytes },
    { ...pins.codex, bytes: codexTar.bytes },
  ]);
  afterThisTest(() => registry.stop());
  const env = {
    HOME: home,
    PATH: '/usr/bin:/bin',
    SHELL: '/fake/shell',
    AGFLOW_HOME: paths.home,
    AGFLOW_CONFIG_DIR: dir,
    AGFLOW_NPM_REGISTRY: registry.url,
  };
  const calls: ExecCall[] = [];
  let service: RunnerService | undefined;
  afterThisTest(async () => {
    if (service) {
      await service.stop('test cleanup');
      await service.exited;
    }
  });
  const exec: Exec = async (argv, commandOptions) => {
    calls.push(structuredClone({ argv, options: commandOptions }));
    const ok = { exitCode: 0, stdout: '', stderr: '', timedOut: false };
    if (argv[0] === 'ioreg') return { ...ok, stdout: `"IOPlatformUUID" = "${machineId}"` };
    if (argv[0] === 'scutil') return { ...ok, stdout: 'Test Mac\n' };
    if (argv[0] === 'git') return { ...ok, stdout: argv.at(-1) === 'user.name' ? 'Owner' : 'owner@example.test' };
    if (argv[0] === env.SHELL) {
      const markers = argv.at(-1)!.match(/AGFLOW_ENV_(?:START|END)_[a-f0-9-]+/g)!;
      return {
        ...ok,
        stdout: `${markers[0]}\0PATH=/captured/bin:/usr/bin:/bin\0HTTPS_PROXY=http://proxy.test\0${markers[1]}\0`,
      };
    }
    if (argv[0] === 'launchctl') {
      if (argv[1] === 'print') return { ...ok, exitCode: service ? 0 : 1 };
      if (argv[1] === 'bootout' && service) {
        await service.stop('bootout');
        await service.exited;
        service = undefined;
      }
      if (argv[1] === 'bootstrap' && !options.noBootstrap) {
        service = await startRunnerService({
          ...fakeServiceOperations(),
          paths,
          configDir: dir,
          mode: 'service',
          agflow: { command: process.execPath, args: [] },
          machineId: async () => machineId,
          adapters: fakeServiceAdapters(),
          cliVersion: fixtureCliVersion,
          terminal: () => {},
          ...(options.failCheck
            ? {
                prepSandbox: fakePrepSandbox({
                  initialize: async () => {
                    throw new Error('sandbox broken');
                  },
                }),
              }
            : {}),
        });
      }
      return ok;
    }
    if (argv[0] === 'tar' || argv[0]!.startsWith(paths.vendor + '/')) return defaultExec(argv, commandOptions);
    throw new Error(`unexpected command: ${argv.join(' ')}`);
  };
  const out: string[] = [];
  const err: string[] = [];
  const io = { out: (text: string) => void out.push(text), err: (text: string) => void err.push(text) };
  const deps: Partial<RunnerSetupDeps> = {
    dir,
    paths,
    env,
    exec,
    pins,
    platform: 'darwin-arm64',
    machinePlatform: 'darwin',
    home,
    uid: 501,
    socketTimeoutMs: 5_000,
    checksTimeoutMs: 50_000,
    pollMs: 10,
    prompt: {
      ask: async () => {
        throw new Error('--yes must not prompt');
      },
    },
  };
  const run = (flags = ['--yes', '--no-service'], overrides: Partial<RunnerSetupDeps> = {}) =>
    runnerSetup(parseArgs(['runner', 'setup', ...flags]), io, { ...deps, ...overrides });
  const vendorCalls = (): VendorCall[] =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
      : [];
  const logins = () =>
    vendorCalls().filter((call) => call.argv.join(' ') === 'auth login --claudeai' || call.argv.join(' ') === 'login');
  return { root, paths, dir, home, hub, pins, registry, env, calls, out, err, io, deps, run, logins };
}

function answers(...values: string[]): Prompt {
  return { ask: async (_question, fallback) => values.shift() || fallback };
}

test('fresh setup installs pins, logs into the runner homes and prints every service check', async () => {
  const f = await fixture();
  expect(await runnerCommand(parseArgs(['runner', 'setup', '--yes']), f.io, { setup: f.deps })).toBe(0);
  const config = loadRunnerConfig(f.paths.config);
  expect(config.runnerKey).toMatch(/^rk_[a-f0-9]{32}$/);
  expect(config.machineId).toBe(machineId);
  expect(config.name).toBe('Test Mac');
  expect(config.capacity).toBe(2);
  expect(config.capturedPath).toBe('/captured/bin:/usr/bin:/bin');
  expect(config.connectivity.HTTPS_PROXY).toBe('http://proxy.test');
  expect(config.commitIdentity).toEqual({ name: 'Owner', email: 'owner@example.test' });
  expect(config.homes).toEqual({ claude: f.paths.homes.claude, codex: f.paths.homes.codex });
  expect(statSync(f.paths.config).mode & 0o777).toBe(0o600);
  for (const vendor of ['claude', 'codex'] as const) {
    const binary = join(f.paths.runner, vendorBinary(vendor, f.pins[vendor].version));
    expect(existsSync(binary)).toBe(true);
    expect(f.out.join('')).toContain(binary);
  }
  expect(f.registry.requests).toHaveLength(2);
  const [claude, codex] = f.logins();
  expect(claude!.env.CLAUDE_CONFIG_DIR).toBe(config.homes.claude!);
  expect(claude!.env.HOME).toBe(f.home);
  expect(codex!.env.CODEX_HOME).toBe(config.homes.codex!);
  expect(codex!.env.HOME).toBe(f.paths.homes.codexUser);
  expect(existsSync(join(f.home, '.claude'))).toBe(false);
  expect(existsSync(join(f.home, '.codex'))).toBe(false);
  expect(f.calls.filter((call) => call.options?.interactive)).toHaveLength(2);
  const plist = plistPath({ home: f.home });
  expect(readFileSync(plist, 'utf8')).toContain(f.paths.home);
  expect(f.calls.some((call) => call.argv.join(' ') === `launchctl bootstrap gui/501 ${plist}`)).toBe(true);
  expect(f.out.join('')).toContain('gui/501/dev.agflow.runner');
  expect(
    f.out
      .join('')
      .split('\n')
      .filter((line) => /^(ok|warn|FAIL) /.test(line))
      .map((line) => line.replace(/^(ok|warn|FAIL) /, '').split(':')[0]),
  ).toEqual(checkNames);
  expect(f.out.join('')).toContain(`signed in to ${f.hub.url} as alice`);
  expect(f.out.join('')).not.toContain(f.hub.token);
  expect(f.err).toEqual([]);
});

test('reruns preserve the key and unchanged file, skip valid logins, and honor --relogin', async () => {
  const f = await fixture();
  await f.run();
  const before = statSync(f.paths.config);
  const key = loadRunnerConfig(f.paths.config).runnerKey;
  await f.run();
  expect(loadRunnerConfig(f.paths.config).runnerKey).toBe(key);
  expect(statSync(f.paths.config).mtimeMs).toBe(before.mtimeMs);
  expect(f.logins()).toHaveLength(2);
  expect(f.out.join('')).toContain('claude: signed in (max)');
  expect(f.out.join('')).toContain('codex: signed in');
  await f.run(['--yes', '--relogin', '--no-service']);
  expect(f.logins()).toHaveLength(4);
  expect(f.registry.requests).toHaveLength(2);
});

test('a copied runner.json gets this machine facts, a new key, and the first setup name and capacity', async () => {
  const f = await fixture();
  await f.run();
  const old = loadRunnerConfig(f.paths.config);
  saveRunnerConfig(f.paths.config, { ...old, machineId: 'another-mac', name: 'Copied name', capacity: 4 });
  await f.run();
  const next = loadRunnerConfig(f.paths.config);
  expect(next.runnerKey).not.toBe(old.runnerKey);
  expect(next.machineId).toBe(machineId);
  expect(next.name).toBe('Test Mac');
  expect(next.capacity).toBe(2);
  expect(f.out.join('')).toContain('new runner key');
  expect(f.out.join('')).toContain('another Mac');
});

for (const kind of ['missing', 'refused', 'unreachable'] as const) {
  test(`${kind} credentials or hub stop at sign-in without runner writes`, async () => {
    const f = await fixture();
    if (kind === 'missing') deleteCredentials(f.dir);
    if (kind === 'refused') saveCredentials({ ...f.hub.credentials, token: 'unknown-token' }, f.dir);
    const overrides =
      kind === 'unreachable'
        ? {
            fetch: async () => {
              throw new Error('offline');
            },
          }
        : {};
    await expect(f.run(undefined, overrides)).rejects.toThrow(
      kind === 'unreachable'
        ? 'cannot reach the agflow hub'
        : `run agflow login --hub ${kind === 'missing' ? '<url>' : f.hub.url}`,
    );
    expect(existsSync(f.paths.runner)).toBe(false);
    expect(f.calls).toEqual([]);
    expect(f.registry.requests).toEqual([]);
  });
}

test('a failing check exits 1 after printing all checks', async () => {
  const f = await fixture({ failCheck: true });
  expect(await f.run(['--yes'])).toBe(1);
  expect(
    f.out
      .join('')
      .split('\n')
      .filter((line) => /^(ok|warn|FAIL) /.test(line))
      .map((line) => line.replace(/^(ok|warn|FAIL) /, '').split(':')[0]),
  ).toEqual(checkNames);
  expect(f.out.join('')).toContain('sandbox broken');
});

test('--no-service stops after login with the foreground start instruction', async () => {
  const f = await fixture();
  expect(await f.run()).toBe(0);
  expect(f.logins()).toHaveLength(2);
  expect(f.out.join('')).toContain('agflow runner start');
  expect(f.calls.some((call) => call.argv[0] === 'launchctl')).toBe(false);
});

test('test mode refuses service installation and explains the foreground flow', async () => {
  const f = await fixture();
  const env = { ...f.env, AGFLOW_TEST: '1' };
  expect(await f.run(['--yes'], { env })).toBe(1);
  expect(f.out.join('')).toContain(installRefusal(loadRunnerConfig(f.paths.config), env)!);
  expect(f.out.join('')).toContain('agflow runner setup --no-service');
  expect(f.out.join('')).toContain('agflow runner start');
  expect(f.calls.some((call) => call.argv[0] === 'launchctl')).toBe(false);
});

test('interactive answers set name and capacity; later capacity edits preserve the confirmed snapshot', async () => {
  const f = await fixture();
  await f.run(['--no-service'], { prompt: answers('My laptop', '5') });
  const initial = loadRunnerConfig(f.paths.config);
  expect(initial.name).toBe('My laptop');
  expect(initial.capacity).toBe(5);
  await f.run(['--no-service'], { prompt: answers('New name', '7') });
  const edited = loadRunnerConfig(f.paths.config);
  expect(edited.runnerKey).toBe(initial.runnerKey);
  expect(edited.name).toBe('New name');
  expect(edited.capacity).toBe(7);
  expect(edited.confirmedSettings).toEqual(initial.confirmedSettings);
});

for (const capacity of ['0', '17', '2.5', 'many']) {
  test(`invalid capacity ${capacity} fails without writing runner.json`, async () => {
    const f = await fixture();
    await expect(f.run(['--no-service'], { prompt: answers('Name', capacity) })).rejects.toThrow(
      'whole number from 1 to 16',
    );
    expect(existsSync(f.paths.config)).toBe(false);
    expect(f.registry.requests).toEqual([]);
  });
}

test('a running runner keeps ownership of runner.json and setup asks nothing', async () => {
  const f = await fixture();
  await f.run();
  const before = readFileSync(f.paths.config, 'utf8');
  const lock = await acquireRunnerLock(f.paths, { mode: 'foreground' });
  afterThisTest(() => lock.release());
  expect(await f.run(['--no-service'])).toBe(0);
  expect(readFileSync(f.paths.config, 'utf8')).toBe(before);
  expect(f.out.join('')).toContain(`pid ${process.pid}`);
  expect(f.out.join('')).toContain('change capacity on the hub');
});

test('socket timeout points to status and the runner log', async () => {
  const f = await fixture({ noBootstrap: true });
  await expect(f.run(['--yes'], { socketTimeoutMs: 50 })).rejects.toThrow('agflow runner status');
  await expect(f.run(['--yes'], { socketTimeoutMs: 50 })).rejects.toThrow(f.paths.runnerLog);
});

test('checks retry startup route errors within the socket deadline', async () => {
  const f = await fixture({ noBootstrap: true });
  // This test exercises socket startup, so vendor checks stay in-process on every host platform.
  const exec: Exec = async (argv, options) => {
    if (!argv[0]!.startsWith(f.paths.vendor + '/')) return f.deps.exec!(argv, options);
    const vendor = argv[0]!.endsWith('/claude') ? 'claude' : 'codex';
    const command = argv.slice(1).join(' ');
    let stdout: string;
    if (command === '--version') {
      stdout =
        vendor === 'claude' ? `${f.pins.claude.version} (Claude Code)` : `codex-cli ${f.pins.codex.version}`;
    } else if (vendor === 'claude' && command === 'auth status --json') {
      stdout = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' });
    } else if (vendor === 'codex' && command === 'login status') {
      stdout = 'Logged in using ChatGPT';
    } else {
      throw new Error(`unexpected vendor command: ${argv.join(' ')}`);
    }
    return { exitCode: 0, stdout, stderr: '', timedOut: false };
  };
  await f.run(undefined, { exec });
  expect(f.logins()).toEqual([]);
  const lock = await acquireRunnerLock(f.paths, { mode: 'foreground' });
  afterThisTest(() => lock.release());
  let tries = 0;
  const server = startControlServer({
    lock,
    paths: f.paths,
    routes: {
      'GET /health': () => ({}),
      'POST /checks': () => {
        if (++tries < 3) throw new Error('the runner is starting; try again');
        return [{ name: 'ready', status: 'pass', detail: 'started' }];
      },
    },
  });
  afterThisTest(() => server.stop());
  expect(await f.run(['--yes'], { exec })).toBe(0);
  expect(tries).toBe(3);
  expect(f.out.join('')).toContain('started');
  expect(f.logins()).toEqual([]);
});

test('runnerWhoami validates the response schema', async () => {
  const client = new HubClient({ baseUrl: 'http://fake', fetch: async () => Response.json({ user: 42 }) });
  await expect(client.runnerWhoami()).rejects.toThrow();
});

for (const input of ['First\nSecond\n', '\n']) {
  test(`terminal prompt preserves piped answers and accepts EOF defaults (${JSON.stringify(input)})`, async () => {
    const module = join(import.meta.dir, '..', 'src', 'runner-setup.ts');
    const script = `
const { terminalPrompt } = await import(${JSON.stringify(module)});
const prompt = terminalPrompt();
try {
  const answers = [];
  for (const question of ['one', 'two', 'three']) answers.push(await prompt.ask(question, 'fallback'));
  console.log(JSON.stringify(answers));
} finally { prompt.close(); }
`;
    const child = Bun.spawn([process.execPath, '-e', script], {
      stdin: new Response(input),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual(
      input.startsWith('First') ? ['First', 'Second', 'fallback'] : ['fallback', 'fallback', 'fallback'],
    );
    expect(err).toContain('one [fallback]:');
    expect(err).toContain('three [fallback]:');
  });
}
```

**File:** `packages/runner/test/service-helpers.ts` (change)

```diff
diff --git a/packages/runner/test/service-helpers.ts b/packages/runner/test/service-helpers.ts
index 2631ef02..35718ef7 100644
--- a/packages/runner/test/service-helpers.ts
+++ b/packages/runner/test/service-helpers.ts
@@ -43,20 +43,22 @@ export interface TestServiceOptions {
   host?: Partial<RunnerServiceOptions>;
 }
 
+/** The in-process hub over a local bare origin, both removed after the test; packages without testkit use it too. */
+export async function startOriginHub(): Promise<TestHub> {
+  const origin = await originRepo({ 'README.md': '# demo\n', 'src/app.ts': 'app\n' });
+  afterThisTest(() => origin.remove());
+  const hub = startTestHub({ config: { projectName: 'demo', projectRepo: origin.path } });
+  afterThisTest(() => hub.stop());
+  return hub;
+}
+
 /**
  * A short AGFLOW_HOME (runner.sock must fit in 104 bytes) with a test runner.json, and a CLI config directory signed in
  * to the hub: the same files for an in-process host (start) and for run-service.ts in a child. Everything is removed
  * after the test.
  */
 export async function setupTestService(options: TestServiceOptions = {}) {
-  let hub = options.hub;
-  if (!hub) {
-    const origin = await originRepo({ 'README.md': '# demo\n', 'src/app.ts': 'app\n' });
-    afterThisTest(() => origin.remove());
-    hub = startTestHub({ config: { projectName: 'demo', projectRepo: origin.path } });
-    const ownedHub = hub;
-    afterThisTest(() => ownedHub.stop());
-  }
+  const hub = options.hub ?? (await startOriginHub());
   const home = mkdtempSync('/tmp/agf-');
   afterThisTest(() => rmSync(home, { recursive: true, force: true }));
   const paths = runnerPaths(home);
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `bun test packages/cli/test/runner-setup.test.ts packages/cli/test/runner-command.test.ts`
Expected: FAIL — `agflow runner > help includes the runner commands`: at `packages/cli/test/runner-command.test.ts:69`, `expect(RUNNER_HELP).toContain('agflow runner setup [--yes] [--relogin] [--no-service]')` fails because the parent help has no setup command. Observed on the current task parent with only this task's test files copied in (2026-11-11).

- [ ] **Step 3: Implement**

**File:** `packages/cli/src/hub-client.ts` (change)

```diff
diff --git a/packages/cli/src/hub-client.ts b/packages/cli/src/hub-client.ts
index 6cbae22d..89f2b678 100644
--- a/packages/cli/src/hub-client.ts
+++ b/packages/cli/src/hub-client.ts
@@ -4,6 +4,7 @@ import {
   BRIDGE_VERSION,
   type RunnerSubmitInputSchema,
   type StaffingInputSchema,
+  WhoamiResponseSchema,
 } from '@agflow/core';
 import type {
   Agent,
@@ -148,6 +149,11 @@ export class HubClient {
     return this.request<CliLoginPoll>('GET', `/api/cli-login/poll?code=${q(code)}`);
   }
 
+  // Runner
+  async runnerWhoami() {
+    return WhoamiResponseSchema.parse(await this.request('GET', '/api/runner/whoami'));
+  }
+
   // Live sessions (hooks)
   sessionStart(input: { vendor: Vendor; sessionId: string; role: AgentRole; label?: string | undefined }) {
     return this.request<{ agentId: string; role: AgentRole; brief: string }>('POST', '/api/live/session-start', input);
```

**File:** `packages/cli/src/runner-command.ts` (change)

```diff
diff --git a/packages/cli/src/runner-command.ts b/packages/cli/src/runner-command.ts
index 75ee9e56..43007226 100644
--- a/packages/cli/src/runner-command.ts
+++ b/packages/cli/src/runner-command.ts
@@ -11,10 +11,13 @@ import { type ParsedArgs, UsageError } from './args';
 import type { Io } from './io';
 import type { Command } from './main';
 import { configDir } from './paths';
+import type { RunnerSetupDeps } from './runner-setup';
 import { selfCommand } from './self';
 
 /** The runner subcommands' lines in main.ts's HELP; each subcommand adds its own. */
-export const RUNNER_HELP = `  agflow runner start [--service]
+export const RUNNER_HELP = `  agflow runner setup [--yes] [--relogin] [--no-service]
+                                Set up this laptop's runner: sign-in, runner.json, binaries, logins and the service
+  agflow runner start [--service]
                                 Run this laptop's runner in the foreground (--service for launchd)
   agflow runner drain            Stop accepting new attempts
   agflow runner undrain          Accept new attempts and clear the crash-loop guard
@@ -26,6 +29,7 @@ export async function runnerCommand(
   args: ParsedArgs,
   io: Io,
   deps: {
+    setup?: Partial<RunnerSetupDeps>;
     startRunnerService?: typeof startRunnerService;
     installService?: typeof installService;
     env?: Record<string, string | undefined>;
@@ -50,6 +54,13 @@ export async function runnerCommand(
       return 0;
     };
   const commands: Record<string, Command> = {
+    setup: async (args, io) => {
+      if (args.positional.length > 2) {
+        throw new UsageError('usage: agflow runner setup [--yes] [--relogin] [--no-service]');
+      }
+      const { runnerSetup } = await import('./runner-setup');
+      return runnerSetup(args, io, deps.setup);
+    },
     // The host logs and prints every reason; the exit code is the ServiceExit's.
     start: async (args, io) => {
       if (args.positional.length > 2) throw new UsageError('usage: agflow runner start [--service]');
```

**File:** `packages/cli/src/runner-setup.ts` (new)

```ts
// Laptop setup (design 7.1): verify sign-in before writes, then reuse the runner's config, pins, logins and service.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { createInterface, type Interface } from 'node:readline/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { editLocalSettings, loadRunnerConfig, type RunnerConfig, saveRunnerConfig } from '@agflow/runner/src/config';
import { agflowHome, type RunnerPaths, runnerPaths } from '@agflow/runner/src/paths';
import { type CheckResult, formatChecks } from '@agflow/runner/src/service/checks';
import { controlRequest } from '@agflow/runner/src/service/control';
import { installRefusal, installService } from '@agflow/runner/src/service/launchd';
import { AlreadyRunningError, acquireRunnerLock, type RunnerLock } from '@agflow/runner/src/service/lock';
import {
  canonicalHome,
  captureLoginShellEnv,
  machineMismatch,
  readComputerName,
  readGitIdentity,
  readMachineId,
} from '@agflow/runner/src/service/machine';
import { createRunnerConfig } from '@agflow/runner/src/service/runner-json';
import { defaultExec, type Exec } from '@agflow/runner/src/service/system';
import { ensurePinnedVendors } from '@agflow/runner/src/vendor/install';
import { claudeLoginStatus, codexLoginStatus, loginClaude, loginCodex } from '@agflow/runner/src/vendor/login';
import { type PlatformPins, VENDOR_PINS, vendorPlatform } from '@agflow/runner/src/vendor/pins';
import type { ParsedArgs } from './args';
import { loadCredentials } from './credentials';
import { type FetchFn, HubClient, HubClientError } from './hub-client';
import type { Io } from './io';
import { configDir } from './paths';
import { type SelfCommand, selfCommand } from './self';

export interface Prompt {
  ask(question: string, fallback: string): Promise<string>;
}

/** One reader retains piped lines between questions; EOF, like an empty line, accepts the default. */
export function terminalPrompt(): Prompt & { close(): void } {
  let reader: Interface | undefined;
  let lines: AsyncIterator<string> | undefined;
  return {
    async ask(question, fallback) {
      reader ??= createInterface({ input: process.stdin, output: process.stderr, terminal: process.stdin.isTTY });
      lines ??= reader[Symbol.asyncIterator]();
      process.stderr.write(`${question} [${fallback}]: `);
      const answer = await lines.next();
      return answer.done || !answer.value.trim() ? fallback : answer.value.trim();
    },
    close() {
      reader?.close();
    },
  };
}

export interface RunnerSetupDeps {
  dir: string;
  paths: RunnerPaths;
  env: Record<string, string | undefined>;
  fetch: FetchFn;
  exec: Exec;
  prompt: Prompt;
  pins: PlatformPins;
  /** The vendor platform key, including for login verification. */
  platform: string;
  machinePlatform: NodeJS.Platform;
  home: string;
  uid: number;
  agflow: SelfCommand;
  socketTimeoutMs: number;
  checksTimeoutMs: number;
  pollMs: number;
}

async function configure(
  paths: RunnerPaths,
  env: RunnerSetupDeps['env'],
  exec: Exec,
  platform: NodeJS.Platform,
  prompt: Prompt,
  log: (line: string) => void,
): Promise<RunnerConfig> {
  const machineId = await readMachineId({ exec, platform });
  let lock: RunnerLock;
  try {
    lock = await acquireRunnerLock(paths, { mode: 'foreground', wait: false });
  } catch (error) {
    if (!(error instanceof AlreadyRunningError)) throw error;
    log(
      `the runner (pid ${error.pid ?? 'unknown'}) is running, so runner.json stays as it is; ` +
        'change capacity on the hub, or stop the runner and run setup again',
    );
    return loadRunnerConfig(paths.config, env);
  }
  try {
    // Re-read under the lock: a service may have saved settings while setup checked sign-in.
    const previous = existsSync(paths.config) ? loadRunnerConfig(paths.config, env) : null;
    const mismatch = previous !== null && machineMismatch(previous, machineId) !== null;
    // A runner.json from another Mac names that Mac's runner, which still runs there: this one starts from the design's
    // defaults, as a first setup does.
    const kept = mismatch ? null : previous;
    const defaultName = kept?.name ?? (await readComputerName(exec));
    const defaultCapacity = kept?.capacity ?? 2;
    const name = (await prompt.ask('Runner name', defaultName)).trim() || defaultName;
    const answer = (await prompt.ask('Capacity', String(defaultCapacity))).trim();
    const capacity = Number(answer || defaultCapacity);
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 16) {
      throw new Error('capacity must be a whole number from 1 to 16');
    }
    if (kept) {
      if (name === kept.name && capacity === kept.capacity) return kept;
      const next = { ...editLocalSettings(kept, { capacity }).config, name };
      saveRunnerConfig(paths.config, next);
      return next;
    }
    const captured = await captureLoginShellEnv({ env, exec });
    const config = createRunnerConfig(
      {
        machineId,
        name: defaultName,
        capturedPath: captured.path,
        connectivity: captured.connectivity,
        commitIdentity: await readGitIdentity(exec),
        homes: { claude: canonicalHome(paths.homes.claude), codex: canonicalHome(paths.homes.codex) },
      },
      { name, capacity },
    );
    saveRunnerConfig(paths.config, config);
    if (mismatch) log('assigned a new runner key because runner.json came from another Mac');
    return config;
  } finally {
    lock.release();
  }
}

async function serviceChecks(paths: RunnerPaths, socketTimeoutMs: number, checksTimeoutMs: number, pollMs: number) {
  for (const [name, value] of Object.entries({ socketTimeoutMs, checksTimeoutMs, pollMs })) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
  }
  const deadline = performance.now() + socketTimeoutMs;
  let lastError: unknown;
  do {
    try {
      await controlRequest(paths, 'GET', '/health', undefined, {
        timeoutMs: Math.max(1, Math.ceil(Math.min(3_000, deadline - performance.now()))),
      });
      // A responsive socket can precede runner creation; route errors retry against the same startup deadline.
      return await controlRequest<CheckResult[]>(paths, 'POST', '/checks', undefined, { timeoutMs: checksTimeoutMs });
    } catch (error) {
      lastError = error;
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) break;
    await delay(Math.min(pollMs, remaining));
  } while (performance.now() < deadline);
  throw new Error(`timed out waiting for runner service checks; run agflow runner status and see ${paths.runnerLog}`, {
    cause: lastError,
  });
}

export async function runnerSetup(args: ParsedArgs, io: Io, deps: Partial<RunnerSetupDeps> = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const paths = deps.paths ?? runnerPaths(agflowHome(env));
  const credentials = loadCredentials(deps.dir ?? configDir());
  if (!credentials) throw new Error('not signed in; run agflow login --hub <url>');
  const client = new HubClient({ baseUrl: credentials.hubUrl, token: credentials.token, fetch: deps.fetch });
  let user: string;
  try {
    user = (await client.runnerWhoami()).user;
  } catch (error) {
    if (error instanceof HubClientError && error.status === 401) {
      throw new Error(`the hub refused the CLI sign-in; run agflow login --hub ${credentials.hubUrl}`);
    }
    throw error;
  }
  const log = (line: string) => io.out(`${line}\n`);
  log(`signed in to ${credentials.hubUrl} as ${user}`);
  const exec = deps.exec ?? defaultExec;
  const terminal = args.flags.yes !== true && !deps.prompt ? terminalPrompt() : undefined;
  let config: RunnerConfig;
  try {
    config = await configure(
      paths,
      env,
      exec,
      deps.machinePlatform ?? process.platform,
      args.flags.yes === true ? { ask: async (_question, fallback) => fallback } : (deps.prompt ?? terminal!),
      log,
    );
  } finally {
    terminal?.close();
  }
  const platform = deps.platform ?? vendorPlatform();
  const pins = deps.pins ?? VENDOR_PINS[platform];
  const pinOptions = { env, exec, platform, pins, log };
  log('installing the pinned Claude and Codex binaries; the first setup downloads about 550 MB');
  await ensurePinnedVendors(paths, pinOptions);
  for (const vendor of ['claude', 'codex'] as const) {
    const options = { version: pins?.[vendor].version, platform, exec, base: env };
    const status = await (vendor === 'claude' ? claudeLoginStatus : codexLoginStatus)(config, paths, options);
    if (status.ok && args.flags.relogin !== true) {
      log(`${vendor}: signed in${status.plan ? ` (${status.plan})` : ''}`);
    } else {
      log(`${vendor}: login opens now in the runner's own home`);
      await (vendor === 'claude' ? loginClaude : loginCodex)(config, paths, options);
    }
  }
  if (args.flags['no-service'] === true) {
    log('setup is done; run agflow runner start');
    return 0;
  }
  const refusal = installRefusal(config, env);
  if (refusal) {
    log(refusal);
    log('run agflow runner setup --no-service and then agflow runner start to run a test runner in the foreground');
    return 1;
  }
  const installed = await installService({
    paths,
    agflow: deps.agflow ?? selfCommand(),
    env,
    exec,
    uid: deps.uid,
    home: deps.home ?? homedir(),
    log,
    installPins: (paths) => ensurePinnedVendors(paths, pinOptions),
  });
  log(`installed ${installed.plistPath}; the runner starts as ${installed.target}`);
  const results = await serviceChecks(
    paths,
    deps.socketTimeoutMs ?? 120_000,
    deps.checksTimeoutMs ?? 180_000,
    deps.pollMs ?? 250,
  );
  io.out(`${formatChecks(results)}\n`);
  return results.some((check) => check.status === 'fail') ? 1 : 0;
}
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `bun test packages/cli/test/runner-setup.test.ts packages/cli/test/runner-command.test.ts && bun test && bun run typecheck`
Expected: the task's tests pass; then the whole suite passes (`0 fail`) and `tsc` exits 0.

Nothing is written before the sign-in passes. runner.json is written under runner.lock, taken without waiting: if a running runner holds it, runner.json stays as it is and setup says to change capacity on the hub. A capacity change goes through `editLocalSettings`, so the hub hears it after the next welcome. On another Mac's runner.json the prompts default to this Mac's computer name and capacity 2. `--yes` asks nothing. After `installService` setup polls `GET /health`, then `POST /checks`, retrying "the runner is starting" until a 120 s deadline. Every dependency is injectable (`RunnerSetupDeps`), and `startOriginHub` in the runner's test helpers gives the CLI tests a hub with an origin. The fake service bootstrapped by the setup fixture passes fixtureCliVersion and uses fakeServiceOperations' darwin-arm64 retention pin table. The fake pin-installation and file-existence assertions run on Linux unchanged. The startup-retry test injects in-process vendor version and authenticated-status responses, so no vendor login runs; it keeps its three-attempt and successful-output assertions and adds a check that no vendor login ran.

- [ ] **Step 5: Commit**

```bash
git add -A 'packages/cli/src/hub-client.ts' 'packages/cli/src/runner-command.ts' 'packages/cli/src/runner-setup.ts' 'packages/cli/test/runner-command.test.ts' 'packages/cli/test/runner-setup.test.ts' 'packages/runner/test/service-helpers.ts'
git commit -m 'M2C Task 23: `agflow runner setup`' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

### Task 24: `agflow runner stop` and `restart`

`agflow runner stop` (design 7.1, X-41) runs inside the service through `POST /stop`: it drains and waits up to 60 s for the ack, stops every agent with a handoff turn and a WIP push (`stopAgents('runner_stop', { handoff: true })`), waits a bounded time for the exits' acks, then exits 0. Outside AGFLOW_TEST=1, the CLI then boots out and disables the LaunchAgent, so the runner stays stopped until `install` or `start`. Outside AGFLOW_TEST=1, `restart` is the suspend path, a wait for the lock, then `launchctl kickstart -k`. `scripts/verify-service.ts`, behind M2b's root script `verify:service` (X-44), drives a scratch LaunchAgent through install, status, restart and stop.

**Files:**
- Modify: `packages/cli/src/runner-command.ts`
- Test: `packages/cli/test/runner-command.test.ts`
- Create: `packages/runner/scripts/verify-service.ts`
- Modify: `packages/runner/src/service/host.ts`
- Create: `packages/runner/src/service/stop.ts`
- Test: `packages/runner/test/service/stop.test.ts`

- [ ] **Step 1: Write the failing tests**

**File:** `packages/cli/test/runner-command.test.ts` (change)

```diff
diff --git a/packages/cli/test/runner-command.test.ts b/packages/cli/test/runner-command.test.ts
index 2e3af65f..0c580d01 100644
--- a/packages/cli/test/runner-command.test.ts
+++ b/packages/cli/test/runner-command.test.ts
@@ -67,6 +67,8 @@ describe('agflow runner', () => {
     expect(await main(['help'], io)).toBe(0);
     expect(RUNNER_HELP).toContain('agflow runner start [--service]');
     expect(RUNNER_HELP).toContain('agflow runner setup [--yes] [--relogin] [--no-service]');
+    expect(RUNNER_HELP).toContain('agflow runner stop');
+    expect(RUNNER_HELP).toContain('agflow runner restart');
     expect(RUNNER_HELP).toContain('agflow runner drain');
     expect(RUNNER_HELP).toContain('agflow runner undrain');
     expect(RUNNER_HELP).toContain('agflow runner install');
@@ -226,6 +228,7 @@ console.log(JSON.stringify(Object.keys(require.cache).filter((path) => path.incl
         exited: Promise.resolve(exit),
         suspend: async () => exit,
         stop: async () => exit,
+        runnerStop: async () => exit,
       }));
       const argv = ['runner', 'start', ...(mode === 'service' ? ['--service'] : [])];
       expect(await runnerCommand(parseArgs(argv), io, { startRunnerService })).toBe(3);
@@ -499,3 +502,92 @@ describe('agflow runner status', () => {
     expect(exec.calls).toHaveLength(2);
   });
 });
+
+for (const command of ['stop', 'restart']) {
+  test(`${command} rejects extra positional arguments`, async () => {
+    const { io, out, err } = capture();
+    expect(await main(['runner', command, 'extra'], io)).toBe(2);
+    expect(err.join('')).toContain(`usage: agflow runner ${command}`);
+    expect(out).toEqual([]);
+  });
+}
+
+test('runner stop reaches the service and boots out and disables its LaunchAgent', async () => {
+  const s = await setupTestService();
+  process.env.AGFLOW_HOME = s.paths.home;
+  const service = await s.start();
+  await waitFor(() => service.runner?.status().link === 'online');
+  const exec = recordingExec();
+  const { io, out, err } = capture();
+  expect(await runnerCommand(parseArgs(['runner', 'stop']), io, { env: {}, exec, uid: 501, home: tempDir('agf-home-') })).toBe(
+    0,
+  );
+  expect(await service.exited).toMatchObject({ code: 0, clean: true });
+  expect(out.join('')).toContain('the runner stopped');
+  expect(out.join('')).toContain('booted out and disabled');
+  expect(out.join('')).toContain('agflow runner install');
+  expect(out.join('')).toContain('agflow runner start');
+  expect(err.join('')).toContain('stopping the runner');
+  expect(err.join('')).toContain('the runner exited: runner stop requested');
+  expect(exec.calls.map((call) => call.argv)).toEqual([
+    ['launchctl', 'print', 'gui/501/dev.agflow.runner'],
+    ['launchctl', 'bootout', 'gui/501/dev.agflow.runner'],
+    ['launchctl', 'disable', 'gui/501/dev.agflow.runner'],
+  ]);
+});
+
+test('runner restart prints its result and kickstarts a loaded service with no live runner', async () => {
+  const exec = recordingExec();
+  const { io, out } = capture();
+  expect(await runnerCommand(parseArgs(['runner', 'restart']), io, { env: {}, exec, uid: 501 })).toBe(0);
+  expect(out).toEqual(['the runner restarted under launchd\n']);
+  expect(exec.calls.map((call) => call.argv)).toEqual([
+    ['launchctl', 'print', 'gui/501/dev.agflow.runner'],
+    ['launchctl', 'kickstart', '-k', 'gui/501/dev.agflow.runner'],
+  ]);
+});
+
+test('runner stop without a runner or loaded job explains how to bring it back', async () => {
+  const exec = recordingExec([], { exitCode: 1 });
+  const { io, out } = capture();
+  expect(await runnerCommand(parseArgs(['runner', 'stop']), io, { env: {}, exec, uid: 501, home: tempDir('agf-home-') })).toBe(
+    0,
+  );
+  expect(out.join('')).toContain('no runner was running; no LaunchAgent was loaded');
+  expect(out.join('')).toContain('agflow runner install or agflow runner start');
+  expect(exec.calls).toHaveLength(1);
+});
+
+test('runner stop disables an installed LaunchAgent that is not loaded', async () => {
+  const home = tempDir('agf-home-');
+  mkdirSync(dirname(plistPath({ home })), { recursive: true });
+  writeFileSync(plistPath({ home }), 'installed');
+  const exec = recordingExec([{ argv: ['launchctl', 'print', 'gui/501/dev.agflow.runner'], result: { exitCode: 1 } }]);
+  const { io, out } = capture();
+  expect(await runnerCommand(parseArgs(['runner', 'stop']), io, { env: {}, exec, uid: 501, home })).toBe(0);
+  expect(out.join('')).toContain('no runner was running; the installed LaunchAgent was not loaded and is now disabled');
+  expect(exec.calls.map((call) => call.argv[1])).toEqual(['print', 'disable']);
+});
+
+test('runner stop reports an unreachable lock holder without touching launchd', async () => {
+  const s = await setupTestService();
+  process.env.AGFLOW_HOME = s.paths.home;
+  const lock = await acquireRunnerLock(s.paths, { mode: 'foreground' });
+  afterThisTest(() => lock.release());
+  const exec = recordingExec();
+  const { io, out } = capture();
+  await expect(
+    runnerCommand(parseArgs(['runner', 'stop']), io, { env: {}, exec, uid: 501, home: tempDir('agf-home-') }),
+  ).rejects.toThrow(`runner.lock is held by pid ${process.pid}`);
+  expect(out).toEqual([]);
+  expect(exec.calls).toEqual([]);
+});
+
+test('stop and restart pass the injected test environment through to operations', async () => {
+  const exec = recordingExec();
+  const deps = { exec, env: { AGFLOW_TEST: '1' }, home: tempDir('agf-home-'), uid: 501 };
+  const { io } = capture();
+  expect(await runnerCommand(parseArgs(['runner', 'stop']), io, deps)).toBe(0);
+  await expect(runnerCommand(parseArgs(['runner', 'restart']), io, deps)).rejects.toThrow('no runner service is loaded');
+  expect(exec.calls).toEqual([]);
+});
```

**File:** `packages/runner/test/service/stop.test.ts` (new)

```ts
import { afterEach, beforeEach, expect, mock, setDefaultTimeout, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getAttempt } from '@agflow/hub/src/attempt-store';
import { getRunner } from '@agflow/hub/src/runners';
import { createTasks, getTask } from '@agflow/hub/src/tasks';
import { newTask } from '@agflow/hub/test/helpers';
import { FakeAdapter, gitIn } from '@agflow/testkit';
import { AttemptStore } from '../../src/attempt-store';
import { loadRunnerConfig, saveRunnerConfig } from '../../src/config';
import { openRunnerDb } from '../../src/db';
import { memoryLogger } from '../../src/log';
import { Outbox } from '../../src/outbox';
import type { RunnerHandle } from '../../src/runner';
import { controlRequest, startControlServer } from '../../src/service/control';
import { plistPath } from '../../src/service/launchd';
import { acquireRunnerLock, readLockOwner } from '../../src/service/lock';
import { drainAndStopAgents, restartRunner, stopReason, stopRunner, stopWaitMs } from '../../src/service/stop';
import { compileServiceCli, verifyServiceMain } from '../../scripts/verify-service';
import { waitFor } from '../fixture';
import { startRunnerAttempt } from '../hub-fixture';
import { afterThisTest, cleanupRunnerSetups, tempDir } from '../runner-setup';
import { recordingExec, setupTestService, startTestService } from '../service-helpers';

setDefaultTimeout(60_000);
afterEach(cleanupRunnerSetups);
beforeEach(() => {
  const previous = process.env.AGFLOW_TEST;
  process.env.AGFLOW_TEST = '1';
  afterThisTest(() => {
    if (previous === undefined) delete process.env.AGFLOW_TEST;
    else process.env.AGFLOW_TEST = previous;
  });
});

const target = 'gui/501/dev.agflow.runner';
function launchctl(loaded = true) {
  return recordingExec([{ argv: ['launchctl', 'print', target], result: { exitCode: loaded ? 0 : 1 } }]);
}

function handle() {
  let link = 'online';
  const calls: string[] = [];
  const runner = {
    changeSettings: mock(async () => {
      calls.push('drain');
      return 2;
    }),
    pause: mock(() => {
      calls.push('pause');
    }),
    stopAgents: mock(async () => {
      calls.push('stop');
      return [3, 7];
    }),
    waitAcked: mock(async (seq: number, _ms: number) => {
      calls.push(`ack ${seq}`);
      return true;
    }),
    status: () => ({ link }) as ReturnType<RunnerHandle['status']>,
  };
  return {
    runner,
    calls,
    offline: () => {
      link = 'backoff';
    },
  };
}

test('drain ack precedes pause and handoff; the final cumulative ack follows the exits', async () => {
  const { runner, calls } = handle();
  expect(await drainAndStopAgents(runner, { logger: memoryLogger() })).toEqual({
    drainAcked: true,
    seqs: [3, 7],
    exitsAcked: true,
    errors: [],
  });
  expect(calls).toEqual(['drain', 'ack 2', 'pause', 'stop', 'ack 7']);
  expect(runner.changeSettings).toHaveBeenCalledWith({ draining: true });
  expect(runner.stopAgents).toHaveBeenCalledWith('runner_stop', { handoff: true });
});

test('offline drain warns and still stops; disconnects end short ack waits', async () => {
  for (const initiallyOffline of [true, false]) {
    const { runner, offline } = handle();
    const logger = memoryLogger();
    if (initiallyOffline) offline();
    else
      runner.waitAcked.mockImplementation(async () => {
        offline();
        return false;
      });
    const result = await drainAndStopAgents(runner, { logger, drainAckMs: 50, exitsAckMs: 50 });
    expect(result.drainAcked).toBe(false);
    expect(result.seqs).toEqual([3, 7]);
    expect(logger.entries.some((entry) => entry.message.includes('acknowledge the drain'))).toBe(true);
    expect(runner.waitAcked.mock.calls.length).toBe(initiallyOffline ? 0 : 1);
  }
});

test('ack expiry and drain failures do not prevent stopping, even if logging fails', async () => {
  const { runner } = handle();
  runner.waitAcked.mockImplementation(async (_seq, ms) => {
    await Bun.sleep(ms);
    return false;
  });
  const result = await drainAndStopAgents(runner, { logger: memoryLogger(), drainAckMs: 10, exitsAckMs: 10 });
  expect(result).toMatchObject({ drainAcked: false, exitsAcked: false, seqs: [3, 7] });
  runner.changeSettings.mockRejectedValue(new Error('settings failed'));
  const logger = memoryLogger();
  logger.warn = () => {
    throw new Error('log failed');
  };
  expect((await drainAndStopAgents(runner, { logger, exitsAckMs: 0 })).errors).toContain('settings failed');
  expect(runner.stopAgents).toHaveBeenCalledTimes(2);
});

for (const drained of [false, true]) {
  test(`stop restores only its own drain (owner drained: ${drained})`, async () => {
    const s = await startTestService({ config: { draining: drained } });
    const runner = s.service.runner!;
    await waitFor(() => runner.status().link === 'online');
    // drainAndStopAgents catches what stopAgents throws, so the mock records and the test asserts afterwards.
    let hubDraining: boolean | undefined;
    runner.stopAgents = mock(async () => {
      hubDraining = getRunner(s.hub.ctx, runner.status().runnerId!).draining;
      return [];
    });
    expect(await controlRequest(s.paths, 'POST', '/stop')).toBeNull();
    expect(await s.service.exited).toEqual({ code: 0, clean: true, reason: 'runner stop requested' });
    expect(hubDraining).toBe(true);
    expect(loadRunnerConfig(s.paths.config).draining).toBe(drained);
    expect(readLockOwner(s.paths)).toBeNull();
  });
}

for (const offline of [false, true]) {
  test(`stop hands off a running agent and records its final work (offline: ${offline})`, async () => {
    const sends: string[] = [];
    const adapter = new FakeAdapter({
      vendor: 'codex',
      skipAuthChecks: true,
      script: { turns: [[], [{ do: 'text', text: 'handoff complete' }]] },
    });
    const start = adapter.start.bind(adapter);
    adapter.start = async (launch) => {
      const session = await start(launch);
      const send = session.send.bind(session);
      session.send = async (text) => {
        sends.push(JSON.stringify(text));
        return send(text);
      };
      return session;
    };
    const s = await startTestService({
      host: { adapters: [adapter], stopDrainAckMs: offline ? 30 : 1_000, stopExitsAckMs: offline ? 30 : 1_000 },
    });
    const runner = s.service.runner!;
    await waitFor(() => runner.status().link === 'online');
    const runnerId = runner.status().runnerId!;
    const [task] = createTasks(s.hub.ctx, [newTask()], 'user:alice');
    const { attempt } = startRunnerAttempt(s.hub.ctx, { runnerId, taskId: task!.id, role: 'worker', vendor: 'codex' });
    await waitFor(() => runner.status().attempts.some((a) => a.attemptId === attempt.id && a.phase === 'idle'));
    writeFileSync(join(adapter.launches[0]!.clone, 'final.txt'), 'final work\n');
    let hubDraining: boolean | undefined;
    if (offline) {
      await s.hub.stop();
      await waitFor(() => runner.status().link !== 'online');
    } else {
      const stop = runner.stopAgents.bind(runner);
      runner.stopAgents = async (cause, options) => {
        hubDraining = getRunner(s.hub.ctx, runnerId).draining;
        return stop(cause, options);
      };
    }
    // The CLI's stop: the drain warnings come back to the person who asked, not only to the runner's log.
    const log: string[] = [];
    await stopRunner({ env: {}, paths: s.paths, uid: 501, exec: launchctl(false), log: (line) => log.push(line), pollMs: 5 });
    expect(await s.service.exited).toMatchObject({ code: 0, clean: true });
    if (offline) {
      expect(log).toContain(
        'the runner exited: runner stop requested; the hub did not acknowledge the drain and may end the attempts as lost',
      );
    } else {
      expect(hubDraining).toBe(true);
      expect(log).toContain('the runner exited: runner stop requested');
    }
    expect(sends.some((text) => text.includes('agflow is stopping this attempt: the runner is stopping'))).toBe(true);
    const db = openRunnerDb(s.paths.db);
    try {
      const outbox = new Outbox(db);
      const events = outbox.eventsAfter(0);
      const exit = events.find((event) => event.type === 'attempt.exited')!;
      expect(exit.data.cause).toBe('runner_stop');
      if (offline) {
        expect(readFileSync(s.paths.runnerLog, 'utf8')).toContain('acknowledge the drain');
        const record = new AttemptStore(db).get(attempt.id)!;
        // This fresh disconnect is still inside canPushWip's grace: the local origin accepts the final WIP.
        expect(record.pushError).toBeNull();
        const final = exit.data.finalWip!;
        expect(final).not.toBeNull();
        expect((await gitIn(s.hub.ctx.config.projectRepo, ['show', `${final.ref}:final.txt`])).trim()).toBe(
          'final work',
        );
      } else {
        const final = exit.data.finalWip!;
        expect(final).not.toBeNull();
        expect(events.some((e) => e.type === 'attempt.wip' && e.seq < exit.seq && e.data.sha === final.sha)).toBe(true);
        expect((await gitIn(s.hub.ctx.config.projectRepo, ['rev-parse', final.ref])).trim()).toBe(final.sha);
        expect(outbox.ackedSeq()).toBeGreaterThanOrEqual(exit.seq);
        expect(getAttempt(s.hub.ctx, attempt.id)).toMatchObject({
          status: 'ended',
          endReason: 'stopped',
          failureClass: 'infra',
          failureSignature: null,
        });
        expect(getTask(s.hub.ctx, task!.id)).toMatchObject({ status: 'ready', nextDispatchAt: null });
      }
    } finally {
      db.close();
    }
    expect(loadRunnerConfig(s.paths.config).draining).toBe(false);
  });
}

for (const loaded of [false, true]) {
  for (const running of [false, true]) {
    test(`stop running=${running}, loaded=${loaded} only boots out a loaded job after the lock is free`, async () => {
      const s = await setupTestService();
      if (running) {
        const service = await s.start();
        await waitFor(() => service.runner?.status().link === 'online');
      }
      const exec = launchctl(loaded);
      const log: string[] = [];
      const result = await stopRunner({ env: {},
        paths: s.paths,
        uid: 501,
        exec: async (argv, options) => {
          expect(readLockOwner(s.paths)).toBeNull();
          return exec(argv, options);
        },
        log: (line) => log.push(line),
        pollMs: 5,
      });
      expect(result).toEqual({ wasRunning: running, bootedOut: loaded, disabled: loaded });
      expect(exec.calls.map((call) => call.argv)).toEqual([
        ['launchctl', 'print', target],
        ...(loaded
          ? [
              ['launchctl', 'bootout', target],
              ['launchctl', 'disable', target],
            ]
          : []),
      ]);
      if (!running) expect(log.join('')).toContain('no runner is running');
    });
  }
}

test('stop disables an installed plist that launchd has not loaded, so the next login does not start it', async () => {
  const s = await setupTestService();
  const home = tempDir('agf-home-');
  const exec = launchctl(false);
  expect(await stopRunner({ env: {}, paths: s.paths, uid: 501, exec, home })).toEqual({
    wasRunning: false,
    bootedOut: false,
    disabled: false,
  });
  mkdirSync(dirname(plistPath({ home })), { recursive: true });
  writeFileSync(plistPath({ home }), 'installed');
  expect(await stopRunner({ env: {}, paths: s.paths, uid: 501, exec, home })).toEqual({
    wasRunning: false,
    bootedOut: false,
    disabled: true,
  });
  expect(exec.calls.map((call) => call.argv)).toEqual([
    ['launchctl', 'print', target],
    ['launchctl', 'print', target],
    ['launchctl', 'disable', target],
  ]);
});

test('the stop wait covers the handoff and one final push per slot, and never drops below 10 minutes', async () => {
  const s = await setupTestService();
  expect(stopWaitMs(s.paths)).toBe(10 * 60_000);
  saveRunnerConfig(s.paths.config, { ...s.config, capacity: 16 });
  // 60 s drain ack + 3 min handoff + 16 × 60 s final pushes + 30 s exit acks + 2 min teardown.
  expect(stopWaitMs(s.paths)).toBe((60 + 180 + 16 * 60 + 30 + 120) * 1_000);
  writeFileSync(s.paths.config, 'not json');
  expect(stopWaitMs(s.paths)).toBe(10 * 60_000);
});

test('stopReason adds every warning the stop met to the reason', () => {
  const clean = { drainAcked: true, seqs: [], exitsAcked: null, errors: [] };
  expect(stopReason('runner stop requested', clean)).toBe('runner stop requested');
  expect(
    stopReason('runner stop requested', { drainAcked: false, seqs: [3], exitsAcked: false, errors: ['boom'] }),
  ).toBe(
    'runner stop requested; the hub did not acknowledge the drain and may end the attempts as lost; ' +
      'the hub did not acknowledge the exits; runner stop failed: boom',
  );
});

test('verify-service rejects extra arguments before doing work', async () => {
  const errors: string[] = [];
  const logs: string[] = [];
  const options = { log: (line: string) => logs.push(line), error: (line: string) => errors.push(line) };
  expect(await verifyServiceMain(['extra'], {}, options)).toBe(1);
  expect(errors).toEqual(['usage: bun run verify:service']);
  expect(logs).toEqual([]);
});

test('restart suspends, keeps the attempt open, and kickstarts only after lock release', async () => {
  const adapter = new FakeAdapter({ vendor: 'codex', skipAuthChecks: true, script: { turns: [[]] } });
  const s = await startTestService({ host: { adapters: [adapter] } });
  await waitFor(() => s.service.runner?.status().link === 'online');
  const [task] = createTasks(s.hub.ctx, [newTask()], 'user:alice');
  const { attempt } = startRunnerAttempt(s.hub.ctx, {
    runnerId: s.service.runner!.status().runnerId!,
    taskId: task!.id,
    role: 'worker',
    vendor: 'codex',
  });
  await waitFor(() => s.service.runner!.status().attempts.some((a) => a.phase === 'idle'));
  const exec = launchctl();
  await restartRunner({ env: {},
    paths: s.paths,
    uid: 501,
    pollMs: 5,
    exec: async (argv, options) => {
      if (argv[1] === 'kickstart') {
        expect(readLockOwner(s.paths)).toBeNull();
        expect(getAttempt(s.hub.ctx, attempt.id).status).toBe('running');
      }
      return exec(argv, options);
    },
  });
  expect(exec.calls.map((call) => call.argv)).toEqual([
    ['launchctl', 'print', target],
    ['launchctl', 'kickstart', '-k', target],
  ]);
  expect(await s.service.exited).toMatchObject({ reason: 'suspend requested' });
});

test('restart without a loaded service leaves a running runner alone and explains install/start', async () => {
  const s = await startTestService();
  const exec = launchctl(false);
  await expect(restartRunner({ env: {}, paths: s.paths, uid: 501, exec })).rejects.toThrow('agflow runner install');
  await expect(restartRunner({ env: {}, paths: s.paths, uid: 501, exec })).rejects.toThrow('agflow runner start');
  expect(readLockOwner(s.paths)).not.toBeNull();
  expect(await controlRequest(s.paths, 'GET', '/health')).toBeDefined();
});

test('unreachable lock holders and timed out stops name the pid without touching launchd', async () => {
  const s = await setupTestService();
  const lock = await acquireRunnerLock(s.paths, { mode: 'foreground' });
  afterThisTest(() => lock.release());
  const exec = launchctl();
  await expect(stopRunner({ env: {}, paths: s.paths, exec })).rejects.toThrow(`pid ${process.pid}`);
  const control = startControlServer({
    paths: s.paths,
    lock,
    routes: { 'GET /health': () => ({}), 'POST /stop': () => null },
  });
  afterThisTest(() => control.stop());
  await expect(stopRunner({ env: {}, paths: s.paths, exec, lockWaitMs: 10, pollMs: 2 })).rejects.toThrow(`pid ${process.pid}`);
  expect(exec.calls).toEqual([]);
});

test('POST /stop during startup is a plain clean stop', async () => {
  const s = await setupTestService();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const starting = s.start({
    fetch: async (input, init) => {
      entered.resolve();
      await release.promise;
      return fetch(input, init);
    },
  });
  try {
    await entered.promise;
    expect(await controlRequest(s.paths, 'POST', '/stop')).toBeNull();
  } finally {
    release.resolve();
  }
  expect(await (await starting).exited).toEqual({ code: 0, clean: true, reason: 'runner stop requested' });
});

test('a lost link during the exit ack ends the wait promptly', async () => {
  const { runner, offline } = handle();
  runner.waitAcked.mockImplementation(async (seq) => {
    if (seq === 2) return true;
    offline();
    return false;
  });
  expect(await drainAndStopAgents(runner, { logger: memoryLogger(), exitsAckMs: 30_000 })).toMatchObject({
    drainAcked: true,
    exitsAcked: false,
  });
  expect(runner.waitAcked).toHaveBeenCalledTimes(2);
});

test('POST /stop answers while the handoff is pending and concurrent stops share its exit', async () => {
  const s = await startTestService();
  const runner = s.service.runner!;
  await waitFor(() => runner.status().link === 'online');
  const release = Promise.withResolvers<number[]>();
  const stopping = mock(() => release.promise);
  runner.stopAgents = stopping;
  try {
    expect(await controlRequest(s.paths, 'POST', '/stop')).toBeNull();
    await waitFor(() => stopping.mock.calls.length === 1);
    expect(readLockOwner(s.paths)).not.toBeNull();
    const joined = s.service.stop('too late');
    expect(s.service.suspend('also too late')).toBe(joined);
    release.resolve([]);
    expect(await joined).toMatchObject({ code: 0, clean: true, reason: 'runner stop requested' });
  } finally {
    release.resolve([]);
  }
  const next = await s.start();
  await waitFor(() => next.runner?.status().link === 'online');
  await waitFor(() => !getRunner(s.hub.ctx, next.runner!.status().runnerId!).draining);
  expect(next.runner!.status().settings.draining).toBe(false);
});

test('restart kickstarts a loaded service with no running process, using its supplied label', async () => {
  const s = await setupTestService();
  const exec = recordingExec();
  await restartRunner({ env: {}, paths: s.paths, exec, uid: 123, label: 'dev.agflow.scratch' });
  expect(exec.calls.map((call) => call.argv)).toEqual([
    ['launchctl', 'print', 'gui/123/dev.agflow.scratch'],
    ['launchctl', 'kickstart', '-k', 'gui/123/dev.agflow.scratch'],
  ]);
});

test('stop reports a failed bootout rather than claiming the job stopped', async () => {
  const s = await setupTestService();
  const exec = recordingExec([{ argv: ['launchctl', 'bootout', target], result: { exitCode: 1 } }]);
  await expect(stopRunner({ env: {}, paths: s.paths, exec, uid: 501 })).rejects.toThrow('bootout failed');
  expect(exec.calls.some((call) => call.argv[1] === 'disable')).toBe(false);
});

test('stop waits only for the runner it stopped, not for a service that takes the lock after it', async () => {
  const s = await setupTestService();
  // The lock now belongs to this process, standing in for a LaunchAgent that was waiting behind the stopped runner.
  const lock = await acquireRunnerLock(s.paths, { mode: 'service' });
  afterThisTest(() => lock.release());
  const stops: unknown[] = [];
  const control = startControlServer({
    paths: s.paths,
    lock,
    routes: { 'GET /health': () => ({ pid: process.pid + 1 }), 'POST /stop': (body) => void stops.push(body) },
  });
  afterThisTest(() => control.stop());
  const exec = launchctl();
  expect(await stopRunner({ env: {}, paths: s.paths, exec, uid: 501, lockWaitMs: 50, pollMs: 2 })).toEqual({
    wasRunning: true,
    bootedOut: true,
    disabled: true,
  });
  expect(stops).toHaveLength(1);
  expect(exec.calls.map((call) => call.argv[1])).toEqual(['print', 'bootout', 'disable']);
});

for (const running of [false, true]) {
  test(`injected test mode stops without launchd or the installed plist (running: ${running})`, async () => {
    const s = await setupTestService();
    if (running) await s.start();
    const home = tempDir('agf-home-');
    const plist = plistPath({ home });
    mkdirSync(dirname(plist), { recursive: true });
    writeFileSync(plist, 'installed');
    const exec = launchctl();
    const options = { paths: s.paths, home, exec, uid: 501, env: { AGFLOW_TEST: '1' }, pollMs: 5 };
    await expect(restartRunner(options)).rejects.toThrow('no runner service is loaded');
    expect(readLockOwner(s.paths) !== null).toBe(running);
    expect(await stopRunner(options)).toEqual({ wasRunning: running, bootedOut: false, disabled: false });
    expect(exec.calls).toEqual([]);
    expect(readFileSync(plist, 'utf8')).toBe('installed');
  });
}


test('verify-service compiles with cwd autoload disabled, like build:cli', async () => {
  const exec = recordingExec();
  await compileServiceCli('/scratch/agflow', exec);
  expect(exec.calls).toHaveLength(1);
  expect(exec.calls[0]!.argv).toEqual([
    process.execPath, 'build', '--compile', '--no-compile-autoload-bunfig', '--no-compile-autoload-dotenv',
    'packages/cli/src/main.ts', '--outfile', '/scratch/agflow',
  ]);
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `bun test packages/runner/test/service/stop.test.ts packages/cli/test/runner-command.test.ts`
Expected: FAIL — `agflow runner > help includes the runner commands`: at `packages/cli/test/runner-command.test.ts:70`, `expect(RUNNER_HELP).toContain('agflow runner stop')` fails because the parent help has no stop command. Observed on the current task parent with only this task's test files copied in (2026-11-11).

- [ ] **Step 3: Implement**

**File:** `packages/cli/src/runner-command.ts` (change)

```diff
diff --git a/packages/cli/src/runner-command.ts b/packages/cli/src/runner-command.ts
index 43007226..88876610 100644
--- a/packages/cli/src/runner-command.ts
+++ b/packages/cli/src/runner-command.ts
@@ -3,6 +3,7 @@
 // agflow command (selfCommand) and the directory of its credentials (configDir). Each subcommand loads its modules
 // when it runs: every other command, the hooks Claude Code and Codex run on each prompt above all, must not pay for
 // the runner's module graph. A static-string import() is still bundled by `bun build --compile`.
+import { homedir } from 'node:os';
 import type { startRunnerService } from '@agflow/runner/src/service/host';
 import type { installService } from '@agflow/runner/src/service/launchd';
 import type { RunnerStatusReport } from '@agflow/runner/src/service/status';
@@ -19,6 +20,8 @@ export const RUNNER_HELP = `  agflow runner setup [--yes] [--relogin] [--no-serv
                                 Set up this laptop's runner: sign-in, runner.json, binaries, logins and the service
   agflow runner start [--service]
                                 Run this laptop's runner in the foreground (--service for launchd)
+  agflow runner stop             Hand off agents and stop and disable the LaunchAgent
+  agflow runner restart          Suspend agents and restart the runner under launchd
   agflow runner drain            Stop accepting new attempts
   agflow runner undrain          Accept new attempts and clear the crash-loop guard
   agflow runner install          Install and start the LaunchAgent that runs the runner at login
@@ -112,6 +115,32 @@ export async function runnerCommand(
         return 1;
       }
     },
+    stop: async (args, io) => {
+      if (args.positional.length > 2) throw new UsageError('usage: agflow runner stop');
+      const { stopRunner } = await import('@agflow/runner/src/service/stop');
+      const result = await stopRunner({
+        env,
+        exec: deps.exec,
+        uid: deps.uid,
+        home: deps.home ?? homedir(),
+        log: (line) => io.err(`${line}\n`),
+      });
+      const launchd = result.bootedOut
+        ? 'the LaunchAgent was booted out and disabled'
+        : result.disabled
+          ? 'the installed LaunchAgent was not loaded and is now disabled'
+          : 'no LaunchAgent was loaded';
+      io.out(`${result.wasRunning ? 'the runner stopped' : 'no runner was running'}; ${launchd}\n`);
+      io.out('run agflow runner install or agflow runner start to bring it back\n');
+      return 0;
+    },
+    restart: async (args, io) => {
+      if (args.positional.length > 2) throw new UsageError('usage: agflow runner restart');
+      const { restartRunner } = await import('@agflow/runner/src/service/stop');
+      await restartRunner({ env, exec: deps.exec, uid: deps.uid, log: (line) => io.err(`${line}\n`) });
+      io.out('the runner restarted under launchd\n');
+      return 0;
+    },
     drain: drainingCommand(true),
     undrain: drainingCommand(false),
     install: async (args, io) => {
```

**File:** `packages/runner/scripts/verify-service.ts` (new)

```ts
// A desktop-session check with a private label and homes: never operates on the owner's runner.
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CREDENTIALS_FILE } from '@agflow/core';
import { findRunnerByKey } from '@agflow/hub/src/runners';
import { originRepo } from '@agflow/testkit';
import { saveRunnerConfig } from '../src/config';
import { runnerPaths } from '../src/paths';
import { bootoutService, installService, plistPath, serviceLoaded, serviceTarget } from '../src/service/launchd';
import { readLockOwner } from '../src/service/lock';
import { canonicalHome, readMachineId } from '../src/service/machine';
import { createRunnerConfig } from '../src/service/runner-json';
import { restartRunner, stopRunner } from '../src/service/stop';
import { defaultExec, type Exec } from '../src/service/system';
import { VENDOR_PINS, vendorBinary } from '../src/vendor/pins';
import { startTestHub, type TestHub } from '../test/hub-fixture';

type Env = Record<string, string | undefined>;
interface VerifyServiceOptions {
  log?: (line: string) => void;
  error?: (line: string) => void;
}

async function until(check: () => boolean, description: string, ms = 60_000): Promise<void> {
  const deadline = performance.now() + ms;
  while (!check()) {
    if (performance.now() >= deadline) throw new Error(`timed out waiting for ${description}`);
    await Bun.sleep(100);
  }
}

/** The verification binary has the same cwd-autoload protection as build:cli. */
export async function compileServiceCli(binary: string, exec: Exec = defaultExec): Promise<void> {
  const build = await exec(
    [process.execPath, 'build', '--compile', '--no-compile-autoload-bunfig', '--no-compile-autoload-dotenv',
      'packages/cli/src/main.ts', '--outfile', binary],
    { cwd: resolve(import.meta.dir, '../../..'), timeoutMs: 120_000 },
  );
  if (build.exitCode !== 0 || build.timedOut) throw new Error(`CLI build failed: ${build.stderr}`);
}

export async function verifyServiceMain(
  argv: string[] = [],
  env: Env = process.env,
  options: VerifyServiceOptions = {},
): Promise<number> {
  const log = options.log ?? console.log;
  const error = options.error ?? console.error;
  const label = `dev.agflow.runner.verify-${randomUUID()}`;
  let root: string | undefined;
  let hub: TestHub | undefined;
  let origin: Awaited<ReturnType<typeof originRepo>> | undefined;
  let uid: number | undefined;
  let code = 0;
  try {
    if (argv.length) throw new Error('usage: bun run verify:service');
    if (process.platform !== 'darwin') throw new Error('verify-service requires a macOS desktop (Aqua) session');
    uid = process.getuid!();
    const session = await defaultExec(['launchctl', 'managername'], { timeoutMs: 5_000 });
    const domain = await defaultExec(['launchctl', 'print', `gui/${uid}`], { timeoutMs: 5_000 });
    if (
      session.exitCode !== 0 ||
      session.timedOut ||
      session.stdout.trim() !== 'Aqua' ||
      domain.exitCode !== 0 ||
      domain.timedOut
    ) {
      throw new Error(
        'verify-service requires the logged-in macOS desktop (Aqua) session; SSH without Aqua cannot run it',
      );
    }
    // A short path also keeps runner.sock within macOS's 104-byte Unix-socket limit.
    root = realpathSync(mkdtempSync('/tmp/agf-vs-'));
    const home = join(root, 'home');
    const paths = runnerPaths(join(root, 'agflow'));
    const configDir = join(root, 'config');
    mkdirSync(home, { recursive: true, mode: 0o700 });
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const scratchEnv = Object.fromEntries(
      Object.entries({
        ...env,
        HOME: home,
        AGFLOW_HOME: paths.home,
        AGFLOW_CONFIG_DIR: configDir,
        AGFLOW_TEST: undefined,
      }).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    const binary = join(root, 'agflow-bin');
    log('build: compiling the CLI into the temporary directory');
    await compileServiceCli(binary);

    log('hub: starting an isolated hub over a local bare origin');
    origin = await originRepo({ 'README.md': '# service verification\n' });
    hub = startTestHub({ config: { projectName: 'verify-service', projectRepo: origin.path } });
    writeFileSync(join(configDir, CREDENTIALS_FILE), `${JSON.stringify(hub.credentials)}\n`, { mode: 0o600 });
    const config = createRunnerConfig(
      {
        machineId: await readMachineId(),
        name: 'service verification',
        capturedPath: env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
        connectivity: {},
        commitIdentity: { name: 'Service verification', email: 'verify@agflow.invalid' },
        homes: { claude: canonicalHome(paths.homes.claude), codex: canonicalHome(paths.homes.codex) },
      },
      { keepAwake: 'off' },
    );
    saveRunnerConfig(paths.config, config);
    const row = () => findRunnerByKey(hub!.ctx, config.runnerKey);
    const launchd = { label, uid };
    const operations = { ...launchd, paths, home, log, env: scratchEnv };

    log('install: bootstrapping the scratch LaunchAgent without vendor downloads');
    await installService({
      ...launchd,
      paths,
      home,
      env: scratchEnv,
      agflow: { command: binary, args: [] },
      // No attempts run here; missing pins should simply make both vendors not ready.
      installPins: async () => {
        const pins = VENDOR_PINS['darwin-arm64']!;
        return {
          claude: join(paths.runner, vendorBinary('claude', pins.claude.version)),
          codex: join(paths.runner, vendorBinary('codex', pins.codex.version)),
        };
      },
    });
    await until(() => row()?.state === 'online', 'the runner to come online');
    const firstPid = readLockOwner(paths)?.pid;
    if (!firstPid) throw new Error('online runner has no lock owner');

    log('status: checking the compiled CLI reports a running runner');
    const status = await defaultExec([binary, 'runner', 'status', '--json'], { env: scratchEnv, timeoutMs: 10_000 });
    if (status.exitCode !== 0 || status.timedOut || JSON.parse(status.stdout).running !== true) {
      throw new Error(`runner status failed: ${status.stderr || status.stdout}`);
    }

    log('restart: suspending and waiting for a new runner pid online');
    await restartRunner(operations);
    await until(() => {
      const pid = readLockOwner(paths)?.pid;
      return pid != null && pid !== firstPid && row()?.state === 'online';
    }, 'a new runner pid online');

    log('stop: draining, stopping and disabling the scratch LaunchAgent');
    await stopRunner(operations);
    if (readLockOwner(paths) !== null) throw new Error('stop left runner.lock held');
    if (await serviceLoaded(launchd)) throw new Error('stop left the scratch LaunchAgent loaded');
    await until(() => row()?.state === 'offline', 'the hub to mark the runner offline');
    log('verify-service passed');
  } catch (caught) {
    error(caught instanceof Error ? caught.message : String(caught));
    code = 1;
  } finally {
    const cleanup = async (action: () => unknown) => {
      try {
        await action();
      } catch (caught) {
        error(`cleanup: ${caught instanceof Error ? caught.message : String(caught)}`);
        code = 1;
      }
    };
    if (root !== undefined && uid !== undefined) {
      log('cleanup: removing the scratch LaunchAgent and temporary homes');
      await bootoutService({ label, uid });
      // stop's disable persists in launchd's disabled-services database; leave the scratch label enabled there.
      await cleanup(async () => {
        const enabled = await defaultExec(['launchctl', 'enable', serviceTarget(label, uid)], { timeoutMs: 30_000 });
        if (enabled.exitCode !== 0 || enabled.timedOut) throw new Error(`launchctl enable failed: ${enabled.stderr}`);
      });
      await cleanup(() =>
        until(() => readLockOwner(runnerPaths(join(root!, 'agflow'))) === null, 'cleanup lock release', 90_000),
      );
      await cleanup(() => rmSync(plistPath({ home: join(root!, 'home'), label }), { force: true }));
      await cleanup(() => rmSync(root!, { recursive: true, force: true }));
    }
    await cleanup(() => hub?.stop());
    await cleanup(() => origin?.remove());
  }
  return code;
}

if (import.meta.main) process.exitCode = await verifyServiceMain(process.argv.slice(2), process.env);
```

**File:** `packages/runner/src/service/host.ts` (change)

```diff
diff --git a/packages/runner/src/service/host.ts b/packages/runner/src/service/host.ts
index 10f5fd10..00c784c4 100644
--- a/packages/runner/src/service/host.ts
+++ b/packages/runner/src/service/host.ts
@@ -35,6 +35,7 @@ import { NeedsLogin } from './needs-login';
 import { createMacNotifier } from './notify';
 import { ServiceRuns } from './runs';
 import { buildStatusReport } from './status';
+import { drainAndStopAgents, stopReason } from './stop';
 import { suspendRunner } from './suspend';
 import { defaultExec, type Exec } from './system';
 
@@ -91,6 +92,9 @@ export interface RunnerServiceOptions {
   prepSandbox?: PrepSandbox;
   /** Setup checks wait up to 30 s for the first hub welcome. */
   checksWelcomeTimeoutMs?: number;
+  /** Ack budgets for an explicit runner stop; 60 s for drain and 30 s for exits by default. */
+  stopDrainAckMs?: number;
+  stopExitsAckMs?: number;
 }
 
 export interface RunnerService {
@@ -106,6 +110,8 @@ export interface RunnerService {
   suspend(reason: string): Promise<ServiceExit>;
   /** Stops the agents with no handoff within timings.suspend, then exits cleanly; a second call gets the same exit. */
   stop(reason: string): Promise<ServiceExit>;
+  /** Drains, hands off and pushes agents, then exits cleanly (POST /stop). */
+  runnerStop(reason: string): Promise<ServiceExit>;
 }
 
 /** A start refused for a reason a person must fix (X-41). */
@@ -113,9 +119,9 @@ class Refusal extends Error {}
 
 /**
  * How teardown ends the agents: a suspend (SIGTERM, SIGINT, POST /suspend), a stop without a handoff (a link that
- * ended for good, a refusal, a stop), or only the kill after an uncaught error.
+ * ended for good, a refusal, a stop), an explicit runner stop with a handoff, or only the kill after an uncaught error.
  */
-type AgentsEnd = 'suspend' | 'stop' | 'kill';
+type AgentsEnd = 'suspend' | 'stop' | 'runner_stop' | 'kill';
 
 /** Waits for work up to ms; past that, teardown goes on and the work finishes unobserved. */
 async function within(work: Promise<unknown>, ms: number): Promise<void> {
@@ -226,7 +232,20 @@ export async function startRunnerService(options: RunnerServiceOptions): Promise
         retentionTimer = null;
       });
       const active = runner;
-      if (agents === 'suspend' && active !== null && logger !== null) {
+      let restoreDraining = false;
+      if (agents === 'runner_stop' && active !== null && logger !== null) {
+        const stopLogger = logger;
+        await step(async () => {
+          restoreDraining = !active.status().settings.draining;
+          const result = await drainAndStopAgents(active, {
+            logger: stopLogger,
+            drainAckMs: options.stopDrainAckMs,
+            exitsAckMs: options.stopExitsAckMs,
+          });
+          stopLogger.info('runner stop finished', { ...result });
+          exit = { ...exit, reason: describe(stopReason(exit.reason, result)) };
+        });
+      } else if (agents === 'suspend' && active !== null && logger !== null) {
         const result = await suspendRunner(active, {
           deadlineMs: Math.max(0, deadline - performance.now()),
           logger,
@@ -247,6 +266,12 @@ export async function startRunnerService(options: RunnerServiceOptions): Promise
       if (logger) logger[level](exit.reason);
       else print(exit.reason);
       await step(() => runner?.close());
+      await step(() => {
+        if (!restoreDraining) return;
+        // The stop's drain is temporary. Save an offline edit under our lock for the next welcome to send.
+        const saved = loadRunnerConfig(paths.config);
+        saveRunnerConfig(paths.config, editLocalSettings(saved, { draining: false }).config);
+      });
       await step(() => health?.close());
       await step(() => keepAwake?.close());
       await step(() => {
@@ -282,6 +307,7 @@ export async function startRunnerService(options: RunnerServiceOptions): Promise
     exited: exited.promise,
     suspend: (reason) => finish({ code: 0, clean: true, reason }, 'info', runner !== null ? 'suspend' : 'stop'),
     stop: (reason) => finish({ code: 0, clean: true, reason }, 'info'),
+    runnerStop: (reason) => finish({ code: 0, clean: true, reason }, 'info', runner !== null ? 'runner_stop' : 'stop'),
   };
 
   const onTerm = () => void service.suspend('received SIGTERM');
@@ -371,6 +397,9 @@ export async function startRunnerService(options: RunnerServiceOptions): Promise
     },
     'POST /drain': () => changeDraining(true),
     'POST /undrain': () => changeDraining(false),
+    'POST /stop': () => {
+      void service.runnerStop('runner stop requested');
+    },
     'POST /suspend': () => {
       void service.suspend('suspend requested');
     },
```

**File:** `packages/runner/src/service/stop.ts` (new)

```ts
// Stop drains before handing off; restart uses suspend so the hub keeps attempts open (design 7.1, X-41).
import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { loadRunnerConfig } from '../config';
import type { Logger } from '../log';
import { type RunnerPaths, runnerPaths } from '../paths';
import type { RunnerHandle } from '../runner';
import { controlRequest, ControlUnavailableError } from './control';
import { bootoutService, disableService, kickstartService, plistPath, serviceLoaded } from './launchd';
import { readLockOwner } from './lock';
import { ServiceRuns } from './runs';
import type { Exec } from './system';

type StopHandle = Pick<RunnerHandle, 'changeSettings' | 'pause' | 'stopAgents' | 'waitAcked' | 'status'>;

export interface StopAgentsOptions {
  logger: Logger;
  drainAckMs?: number;
  exitsAckMs?: number;
}

export interface StopAgentsResult {
  /** null means the settings did not change, so there was no drain event to acknowledge. */
  drainAcked: boolean | null;
  seqs: number[];
  /** null means there were no exits or the link was already down. */
  exitsAcked: boolean | null;
  errors: string[];
}

/** The runner owns the handoff and final pushes; failures here must not prevent the host's teardown. */
export async function drainAndStopAgents(runner: StopHandle, options: StopAgentsOptions): Promise<StopAgentsResult> {
  const result: StopAgentsResult = { drainAcked: null, seqs: [], exitsAcked: null, errors: [] };
  const warn = (message: string, error?: string) => {
    try {
      options.logger.warn(message, error === undefined ? undefined : { error });
    } catch {
      // A closed log cannot keep the runner alive.
    }
  };
  const failed = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    result.errors.push(message);
    warn('runner stop failed', message);
  };
  const ack = async (seq: number, ms: number): Promise<boolean> => {
    const deadline = performance.now() + ms;
    while (runner.status().link === 'online') {
      const remaining = deadline - performance.now();
      if (remaining <= 0) break;
      // Check the link between short waits, rather than spending the whole budget after a disconnect.
      if (await runner.waitAcked(seq, Math.min(remaining, 100))) return true;
    }
    return false;
  };
  try {
    const seq = await runner.changeSettings({ draining: true });
    if (runner.status().link !== 'online') result.drainAcked = false;
    else if (seq !== null) result.drainAcked = await ack(seq, options.drainAckMs ?? 60_000);
  } catch (error) {
    result.drainAcked = false;
    failed(error);
  }
  if (result.drainAcked === false) warn('the hub did not acknowledge the drain; stopping anyway');
  try {
    runner.pause();
  } catch (error) {
    failed(error);
  }
  try {
    result.seqs = await runner.stopAgents('runner_stop', { handoff: true });
    const last = result.seqs.at(-1);
    if (last !== undefined && runner.status().link === 'online') {
      result.exitsAcked = await ack(last, options.exitsAckMs ?? 30_000);
      if (!result.exitsAcked) warn('the hub did not acknowledge the exits; stopping anyway');
    }
  } catch (error) {
    failed(error);
  }
  return result;
}

/**
 * The exit reason of a runner stop, with what went wrong: the service's log is the only other place these warnings
 * appear, and agflow runner stop shows the reason to the person who asked.
 */
export function stopReason(reason: string, result: StopAgentsResult): string {
  const warnings = [
    ...(result.drainAcked === false ? ['the hub did not acknowledge the drain and may end the attempts as lost'] : []),
    ...(result.exitsAcked === false ? ['the hub did not acknowledge the exits'] : []),
    ...result.errors.map((error) => `runner stop failed: ${error}`),
  ];
  return [reason, ...warnings].join('; ');
}

/**
 * How long a stop may take: the drain ack (60 s), the handoff turn, the final pushes one attempt at a time, the exit
 * acks (30 s) and two minutes of teardown; 10 minutes at least, and when runner.json cannot be read.
 */
export function stopWaitMs(paths: RunnerPaths): number {
  const floor = 10 * 60_000;
  try {
    const config = loadRunnerConfig(paths.config);
    const { handoff, finalPush } = config.timings;
    return Math.max(floor, 60_000 + handoff + config.capacity * finalPush + 30_000 + 2 * 60_000);
  } catch {
    return floor;
  }
}

export interface StopRunnerOptions {
  /** Test mode never consults or mutates launchd or the installed plist. */
  env?: Record<string, string | undefined>;
  paths?: RunnerPaths;
  exec?: Exec;
  uid?: number;
  label?: string;
  /**
   * The user's home: an installed plist that launchd has not loaded is disabled too, or the next login would start
   * it. Uninstall, which removes the plist instead, leaves it out.
   */
  home?: string;
  /** stopWaitMs by default for a stop, two minutes for a restart. */
  lockWaitMs?: number;
  pollMs?: number;
  /** Progress lines, without trailing newlines. */
  log?: (line: string) => void;
}

function bounds(options: StopRunnerOptions, defaultMs: number) {
  const waitMs = options.lockWaitMs ?? defaultMs;
  const pollMs = options.pollMs ?? 100;
  if (!Number.isFinite(waitMs) || waitMs < 0) throw new Error('lockWaitMs must be nonnegative');
  if (!Number.isFinite(pollMs) || pollMs <= 0) throw new Error('pollMs must be positive');
  return { waitMs, pollMs };
}

async function requestExit(
  paths: RunnerPaths,
  route: '/stop' | '/suspend',
  options: StopRunnerOptions,
  budget: ReturnType<typeof bounds>,
): Promise<boolean> {
  let running = true;
  let pid: number | null = null;
  try {
    pid = (await controlRequest<{ pid?: number }>(paths, 'GET', '/health')).pid ?? null;
  } catch (error) {
    if (!(error instanceof ControlUnavailableError)) throw error;
    running = false;
  }
  if (!running) {
    const owner = readLockOwner(paths);
    if (owner !== null) {
      throw new Error(
        `runner.lock is held by pid ${owner.pid ?? 'unknown'}, but no runner answers on its control socket; ` +
          'try again in a moment, or check agflow runner status',
      );
    }
    options.log?.('no runner is running');
    return false;
  }
  options.log?.(
    route === '/stop' ? 'stopping the runner: draining, handing off and pushing final work' : 'suspending the runner',
  );
  await controlRequest(paths, 'POST', route);
  const deadline = performance.now() + budget.waitMs;
  let nextLog = 0;
  // A service waiting behind a foreground runner takes the lock next; it is launchd's to stop, not this request's.
  let owner = readLockOwner(paths);
  while (owner !== null && (pid === null || owner.pid === null || owner.pid === pid)) {
    const now = performance.now();
    if (now >= deadline) {
      throw new Error(`runner.lock is still held by pid ${owner.pid ?? 'unknown'} after ${budget.waitMs} ms`);
    }
    if (now >= nextLog) {
      options.log?.(`waiting for runner.lock held by pid ${owner.pid ?? 'unknown'}`);
      nextLog = now + 5_000;
    }
    await delay(Math.min(budget.pollMs, deadline - now));
    owner = readLockOwner(paths);
  }
  return true;
}

/** Stops through the live service, then leaves the LaunchAgent disabled until install. */
export async function stopRunner(
  options: StopRunnerOptions = {},
): Promise<{ wasRunning: boolean; bootedOut: boolean; disabled: boolean }> {
  const paths = options.paths ?? runnerPaths();
  const budget = bounds(options, options.lockWaitMs ?? stopWaitMs(paths));
  const wasRunning = await requestExit(paths, '/stop', options, budget);
  if (wasRunning) {
    // The stopped run's record, warnings included; a service waiting behind it may hold the lock by now.
    const exit = new ServiceRuns(paths).lastExit({ running: readLockOwner(paths) !== null });
    if (exit !== null) options.log?.(`the runner exited: ${exit.reason}`);
  }
  if ((options.env ?? process.env).AGFLOW_TEST === '1') return { wasRunning, bootedOut: false, disabled: false };
  let bootedOut = false;
  let disabled = false;
  if (await serviceLoaded(options)) {
    bootedOut = await bootoutService(options);
    // bootoutService tolerates an absent job; a still-loaded job is a real failure, not a successful stop.
    if (!bootedOut && (await serviceLoaded(options)))
      throw new Error('launchctl bootout failed; the service is still loaded');
    await disableService(options);
    bootedOut = true;
    disabled = true;
  } else if (options.home !== undefined && existsSync(plistPath({ home: options.home, label: options.label }))) {
    // launchctl disable also works on a label that is not loaded.
    await disableService(options);
    disabled = true;
  }
  return { wasRunning, bootedOut, disabled };
}

/** Checks launchd before touching a foreground runner; kickstart follows the suspend's lock release. */
export async function restartRunner(options: StopRunnerOptions = {}): Promise<void> {
  const budget = bounds(options, 120_000);
  if ((options.env ?? process.env).AGFLOW_TEST === '1' || !(await serviceLoaded(options))) {
    throw new Error(
      'no runner service is loaded; agflow runner install installs and starts the LaunchAgent; ' +
        'agflow runner start runs it in the foreground',
    );
  }
  await requestExit(options.paths ?? runnerPaths(), '/suspend', options, budget);
  options.log?.('starting the runner under launchd; launchd can hold a quick restart for up to a minute');
  await kickstartService(options);
}
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `bun test packages/runner/test/service/stop.test.ts packages/cli/test/runner-command.test.ts packages/runner/test/service/host.test.ts && bun test && bun run typecheck`
Expected: the task's tests pass; then the whole suite passes (`0 fail`) and `tsc` exits 0.

The stop's drain is temporary: if the runner was not drained before, `draining` is written back to false in runner.json after the runner closes, so a later start or install takes work again, while a runner the owner drained stays drained. The stop's warnings (no drain ack, no exit acks) become part of the exit reason, which the CLI prints. `stopRunner` waits for the lock of the pid that `GET /health` named, for at most `stopWaitMs` (60 s, the handoff, capacity times `finalPush`, 30 s and 2 minutes; 10 minutes at least), and disables an installed plist that is not loaded. `restartRunner` refuses without a loaded service. The G6 check is `bun run verify:service` in a desktop (Aqua) session, not over SSH; do not run it during this round because real LaunchAgents and the real user launchctl domain are prohibited. It compiles the CLI into `/tmp/agf-vs-*`, starts an in-process hub over a bare origin, and bootstraps a LaunchAgent with its own label `dev.agflow.runner.verify-<uuid>`, plist home and `AGFLOW_HOME` in the real `gui/<uid>` domain, without downloading pins. It checks install, `status --json`, restart (a new pid) and stop, then boots the job out and removes its files. It leaves an `enabled` entry for that label in launchd's disabled-services database, which launchctl cannot remove; it never touches `dev.agflow.runner`, ~/.agflow or ~/Library/LaunchAgents. StopRunnerOptions.env defaults to process.env; runnerCommand forwards its injected environment. With AGFLOW_TEST='1', stopRunner still stops through the control socket and waits for lock release, but skips serviceLoaded, bootout, disable and the plist check and returns bootedOut:false, disabled:false. restartRunner rejects with its existing no-service-loaded error before touching a running runner or launchd. The launchd tests explicitly inject env:{} and a recording Exec. compileServiceCli builds verify:service's scratch binary with --no-compile-autoload-bunfig and --no-compile-autoload-dotenv, matching build:cli. The verification script passes its scratch environment to stop/restart.

- [ ] **Step 5: Commit**

```bash
git add -A 'packages/cli/src/runner-command.ts' 'packages/cli/test/runner-command.test.ts' 'packages/runner/scripts/verify-service.ts' 'packages/runner/src/service/host.ts' 'packages/runner/src/service/stop.ts' 'packages/runner/test/service/stop.test.ts'
git commit -m 'M2C Task 24: `agflow runner stop` and `restart`' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

### Task 25: `agflow runner uninstall`

`agflow runner uninstall` (design 7.1, 6.16): it stops the runner (or, when none runs, kills its registered agent groups whose identity still matches, through M2b's `killRegisteredGroups`), logs out of both runner homes with the runner's own binaries, retires the runner on the hub (`POST /api/runner/retire`, through the new `HubClient.retireRunner`) and removes the plist outside AGFLOW_TEST=1. `--purge` also deletes `~/.agflow/runner`, `vaults` and `work`, after checking that no attempt has unpushed work and that the hub has every event; it deletes them with M2b's `removeTree`, which also removes the agents' read-only tools directories.

**Files:**
- Modify: `packages/cli/src/hub-client.ts`
- Modify: `packages/cli/src/runner-command.ts`
- Create: `packages/cli/src/runner-uninstall.ts`
- Test: `packages/cli/test/runner-uninstall.test.ts`

- [ ] **Step 1: Write the failing test**

**File:** `packages/cli/test/runner-uninstall.test.ts` (new)

```ts
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { getAttempt } from '@agflow/hub/src/attempt-store';
import { findRunnerByKey } from '@agflow/hub/src/runners';
import { createTasks } from '@agflow/hub/src/tasks';
import { newTask } from '@agflow/hub/test/helpers';
import { AttemptStore, type AttemptPatch } from '@agflow/runner/src/attempt-store';
import { saveRunnerConfig } from '@agflow/runner/src/config';
import { openRunnerDb } from '@agflow/runner/src/db';
import { Outbox } from '@agflow/runner/src/outbox';
import { processIdentity } from '@agflow/runner/src/processes';
import { removeAgentTools } from '@agflow/runner/src/run-dir';
import { plistPath } from '@agflow/runner/src/service/launchd';
import { acquireRunnerLock, readLockOwner } from '@agflow/runner/src/service/lock';
import { stopRunner } from '@agflow/runner/src/service/stop';
import { defaultExec, type Exec } from '@agflow/runner/src/service/system';
import { VENDOR_PINS } from '@agflow/runner/src/vendor/pins';
import { waitFor } from '@agflow/runner/test/fixture';
import { addRunnerAttempt, startRunnerAttempt } from '@agflow/runner/test/hub-fixture';
import { afterThisTest, cleanupRunnerSetups, setupRunner, tempDir } from '@agflow/runner/test/runner-setup';
import { fakeVendorCli, setupTestService, sleepingServiceAdapter } from '@agflow/runner/test/service-helpers';
import { parseArgs } from '../src/args';
import { credentialsPath } from '../src/credentials';
import { HubClient } from '../src/hub-client';
import { main } from '../src/main';
import { RUNNER_HELP, runnerCommand } from '../src/runner-command';
import { uninstallRunner, unpushedWork, type RunnerUninstallDeps } from '../src/runner-uninstall';

const MACHINE = '00000000-0000-4000-8000-000000000001';

setDefaultTimeout(60_000);
beforeEach(() => {
  for (const name of ['AGFLOW_HOME', 'AGFLOW_CONFIG_DIR', 'AGFLOW_TEST']) {
    const previous = process.env[name];
    process.env[name] = name === 'AGFLOW_TEST' ? '1' : tempDir('agf-uninstall-env-');
    afterThisTest(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
  }
});
afterEach(cleanupRunnerSetups);

function snapshot(path: string) {
  return { content: readFileSync(path, 'utf8'), mtime: statSync(path).mtimeMs, mode: statSync(path).mode };
}

async function fixture(currentPins = false) {
  const s = await setupTestService({
    config: { machineId: MACHINE },
    host: { adapters: [sleepingServiceAdapter()], machineId: async () => MACHINE },
  });
  process.env.AGFLOW_HOME = s.paths.home;
  process.env.AGFLOW_CONFIG_DIR = s.configDir;
  for (const vendor of ['claude', 'codex'] as const) {
    mkdirSync(s.paths.homes[vendor], { recursive: true });
    s.config.homes[vendor] = realpathSync(s.paths.homes[vendor]);
  }
  saveRunnerConfig(s.paths.config, s.config);
  const home = tempDir('agf-owner-');
  const owned = ['.claude/settings.json', '.codex/auth.json', '.claude.json'].map((file) => join(home, file));
  for (const path of owned) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `owner's credentials: ${path}`);
  }
  owned.push(credentialsPath(s.configDir));
  const before = owned.map(snapshot);
  const unchanged = () => expect(owned.map(snapshot)).toEqual(before);
  const plist = plistPath({ home });
  mkdirSync(dirname(plist), { recursive: true });
  writeFileSync(plist, 'installed');
  const pins = {
    claude: { ...VENDOR_PINS['darwin-arm64']!.claude, ...(!currentPins && { version: '0.0.1' }) },
    codex: { ...VENDOR_PINS['darwin-arm64']!.codex, ...(!currentPins && { version: '0.0.2' }) },
  };
  const claude = fakeVendorCli(s.paths, 'claude', pins.claude.version, [{ argv: ['auth', 'logout'], result: {} }]);
  const codex = fakeVendorCli(s.paths, 'codex', pins.codex.version, [{ argv: ['logout'], result: {} }]);
  let loaded = true;
  // ioreg's answer: this Mac, unless a test copies runner.json from another one.
  const machine = { id: MACHINE };
  const commands: string[][] = [];
  const exec: Exec = async (argv, options) => {
    commands.push(argv);
    if (argv[0] === 'ioreg') {
      return { exitCode: 0, stdout: `"IOPlatformUUID" = "${machine.id}"`, stderr: '', timedOut: false };
    }
    if (argv[0] !== 'launchctl') {
      expect([claude.binary, codex.binary]).toContain(argv[0]!);
      return defaultExec(argv, options);
    }
    const exitCode = argv[1] === 'print' && !loaded ? 1 : 0;
    if (argv[1] === 'bootout') loaded = false;
    return { exitCode, stdout: '', stderr: '', timedOut: false };
  };
  const out: string[] = [];
  const err: string[] = [];
  const io = { out: (line: string) => void out.push(line), err: (line: string) => void err.push(line) };
  const deps: Partial<RunnerUninstallDeps> = {
    paths: s.paths,
    dir: s.configDir,
    home,
    uid: 501,
    exec,
    pins,
    platform: 'darwin-arm64',
    machinePlatform: 'darwin',
    env: { HOME: home, AGFLOW_HOME: s.paths.home, AGFLOW_CONFIG_DIR: s.configDir },
    lockWaitMs: 10_000,
    pollMs: 10,
  };
  const run = (purge = false, overrides: Partial<RunnerUninstallDeps> = {}) =>
    uninstallRunner(parseArgs(['runner', 'uninstall', ...(purge ? ['--purge'] : [])]), io, { ...deps, ...overrides });
  const loggedOut = () => {
    expect(claude.calls()).toHaveLength(1);
    expect(codex.calls()).toHaveLength(1);
    expect(claude.calls()[0]).toMatchObject({
      argv: ['auth', 'logout'],
      env: {
        HOME: home,
        CLAUDE_CONFIG_DIR: s.config.homes.claude,
      },
    });
    expect(codex.calls()[0]).toMatchObject({
      argv: ['logout'],
      env: {
        HOME: s.paths.homes.codexUser,
        CODEX_HOME: s.config.homes.codex,
      },
    });
    unchanged();
  };
  return { ...s, deps, home, plist, claude, codex, io, out, err, commands, run, loggedOut, unchanged, machine };
}

function record(
  store: AttemptStore,
  id: string,
  clone: string | null,
  patch: AttemptPatch = {},
  role: 'worker' | 'lead' = 'worker',
) {
  store.create(
    {
      attemptId: id,
      taskId: 'T-4',
      role,
      vendor: 'codex',
      model: null,
      fence: { epoch: 1, counter: 1 },
      hubUrl: 'http://hub.test',
      repo: { url: '/origin', mainBranch: 'main' },
      start: { ref: 'refs/heads/main', sha: null },
      branch: 'agflow/T-4-task',
      wipRef: 'refs/agflow/T-4/a1',
      restore: { paths: [], base: 'refs/heads/main' },
      acceptanceIds: [],
      toolCaps: { defaultMs: 1000, longMs: 1000, checks: [] },
      taskPack: '',
      brief: '',
      firstPrompt: '',
      successor: false,
    },
    { clone, tmpDir: null, cliVersion: null },
  );
  return store.update(id, patch);
}

test('running uninstall hands off, logs out with pinned binaries, retires open attempts and removes the plist', async () => {
  // The service's retention sweep preserves current pins and removes old, unused versions.
  const s = await fixture(true);
  const service = await s.start();
  await waitFor(() => service.runner?.status().link === 'online');
  const runnerId = service.runner!.status().runnerId!;
  const [task] = createTasks(s.hub.ctx, [newTask()], 'user:alice');
  const { attempt } = startRunnerAttempt(s.hub.ctx, { runnerId, taskId: task!.id, role: 'worker', vendor: 'codex' });
  await waitFor(() => service.runner!.status().attempts.some((a) => a.attemptId === attempt.id && a.phase === 'turn'));
  const unknown = addRunnerAttempt(s.hub.ctx, { runnerId }).attempt;
  expect(await runnerCommand(parseArgs(['runner', 'uninstall']), s.io, { uninstall: s.deps })).toBe(0);
  expect(await service.exited).toMatchObject({ code: 0, clean: true });
  const db = openRunnerDb(s.paths.db);
  try {
    expect(new Outbox(db).eventsAfter(0)).toContainEqual(
      expect.objectContaining({
        type: 'attempt.exited',
        attemptId: attempt.id,
        data: expect.objectContaining({ cause: 'runner_stop' }),
      }),
    );
  } finally {
    db.close();
  }
  expect(getAttempt(s.hub.ctx, attempt.id).endedAt).not.toBeNull();
  expect(getAttempt(s.hub.ctx, unknown.id)).toMatchObject({ status: 'ended', endReason: 'lost' });
  expect(findRunnerByKey(s.hub.ctx, s.config.runnerKey)?.retired_at).not.toBeNull();
  s.loggedOut();
  expect(existsSync(s.plist)).toBe(false);
  expect(s.commands.slice(0, 3)).toEqual([
    ['launchctl', 'print', 'gui/501/dev.agflow.runner'],
    ['launchctl', 'bootout', 'gui/501/dev.agflow.runner'],
    ['launchctl', 'disable', 'gui/501/dev.agflow.runner'],
  ]);
  expect(s.out.join('')).toContain('retired');
  expect(s.err).toEqual([]);
  expect(await new HubClient({ baseUrl: s.hub.url, token: s.hub.token }).retireRunner(s.config.runnerKey)).toEqual({
    ok: true,
  });
});

test('purge after stopping a running attempt finds its work pushed and its events acknowledged', async () => {
  const s = await fixture(true);
  const service = await s.start();
  await waitFor(() => service.runner?.status().link === 'online');
  const runnerId = service.runner!.status().runnerId!;
  const [task] = createTasks(s.hub.ctx, [newTask()], 'user:alice');
  const { attempt } = startRunnerAttempt(s.hub.ctx, { runnerId, taskId: task!.id, role: 'worker', vendor: 'codex' });
  await waitFor(() => service.runner!.status().attempts.some((a) => a.attemptId === attempt.id && a.phase === 'turn'));
  expect(await s.run(true)).toBe(0);
  expect(await service.exited).toMatchObject({ code: 0, clean: true });
  expect(s.out.join('')).toContain('no attempt has unpushed work');
  for (const path of [s.paths.runner, s.paths.vaults, s.paths.work]) expect(existsSync(path)).toBe(false);
  expect(findRunnerByKey(s.hub.ctx, s.config.runnerKey)?.retired_at).not.toBeNull();
});

test('purge deletes the read-only agent tools directory an attempt left', async () => {
  const s = await fixture(true);
  const service = await s.start();
  await waitFor(() => service.runner?.status().link === 'online');
  const runnerId = service.runner!.status().runnerId!;
  const [task] = createTasks(s.hub.ctx, [newTask()], 'user:alice');
  const { attempt } = startRunnerAttempt(s.hub.ctx, { runnerId, taskId: task!.id, role: 'worker', vendor: 'codex' });
  await waitFor(() => service.runner!.status().attempts.some((a) => a.attemptId === attempt.id && a.phase === 'turn'));
  const tools = s.paths.agentTools(service.runner!.vault.project, attempt.id);
  const entries = ['', 'bin', 'bin/gh', 'bin/glab', 'gh-config', 'glab-config', 'gitconfig', 'ssh-refusal'];
  // The tree as purge finds it: the logouts run once the runner has stopped, before anything is removed.
  const left: Record<string, number>[] = [];
  const exec: Exec = async (argv, options) => {
    if (argv[0] === s.claude.binary) {
      left.push(Object.fromEntries(entries.map((entry) => [entry || '.', statSync(join(tools, entry)).mode & 0o777])));
    }
    return s.deps.exec!(argv, options);
  };
  expect(await s.run(true, { exec })).toBe(0);
  expect(await service.exited).toMatchObject({ code: 0, clean: true });
  // M2b's writeRunDir leaves it read-only, where a plain recursive rm fails with EACCES.
  expect(left).toEqual([
    {
      '.': 0o555,
      bin: 0o555,
      'bin/gh': 0o555,
      'bin/glab': 0o555,
      'gh-config': 0o555,
      'glab-config': 0o555,
      gitconfig: 0o444,
      'ssh-refusal': 0o555,
    },
  ]);
  for (const path of [s.paths.runner, s.paths.vaults, s.paths.work]) expect(existsSync(path)).toBe(false);
  expect(s.out.join('')).toContain(`removed ${s.paths.runner}, ${s.paths.vaults} and ${s.paths.work}`);
});

test('purge preserves unharvested work after startup recovery and a failed project lookup', async () => {
  const s = await setupRunner({ status: 503 });
  const store = new AttemptStore(s.db);
  const clone = s.paths.clone('demo', 'crashed');
  mkdirSync(clone, { recursive: true });
  const work = join(clone, 'unpublished.txt');
  writeFileSync(work, 'work left by the crashed worker');
  record(store, 'crashed', clone, { state: 'running' });
  await expect(s.start()).rejects.toThrow('GET /api/status failed with HTTP 503');
  // createRunner recovered before project lookup failed; no controller finalized this clone.
  expect(store.get('crashed')).toMatchObject({ state: 'stopped', finalizedAt: null, pushError: null, lateWorkSha: null });
  const outbox = new Outbox(s.db);
  expect(outbox.eventsAfter(outbox.ackedSeq())).toEqual([]);
  const out: string[] = [];
  let externalCalls = 0;
  const dir = tempDir('agf-uninstall-cli-');
  writeFileSync(credentialsPath(dir), JSON.stringify(s.credentials));
  const code = await uninstallRunner(parseArgs(['runner', 'uninstall', '--purge']), {
    out: (line) => void out.push(line), err: () => {},
  }, {
    paths: s.paths,
    dir,
    env: { AGFLOW_TEST: '1' },
    machinePlatform: 'darwin',
    platform: 'darwin-arm64',
    exec: async (argv) => {
      externalCalls++;
      expect(argv).toEqual(['ioreg', '-rd1', '-c', 'IOPlatformExpertDevice']);
      return { exitCode: 0, stdout: `"IOPlatformUUID" = "${MACHINE}"`, stderr: '', timedOut: false };
    },
    fetch: async () => { externalCalls++; return Response.json({ ok: true }); },
  });
  expect(code).toBe(1);
  expect(out.join('')).toContain('refusing to purge: attempts have unpushed work');
  expect(externalCalls).toBe(0);
  expect(readFileSync(work, 'utf8')).toBe('work left by the crashed worker');
  expect(existsSync(s.paths.db)).toBe(true);
});

test('purge preserves a stopped worker whose final harvest failed without producing a SHA', async () => {
  const s = await fixture(true);
  const service = await s.start();
  await waitFor(() => service.runner?.status().link === 'online');
  const runnerId = service.runner!.status().runnerId!;
  const [task] = createTasks(s.hub.ctx, [newTask()], 'user:alice');
  const { attempt } = startRunnerAttempt(s.hub.ctx, { runnerId, taskId: task!.id, role: 'worker', vendor: 'codex' });
  await waitFor(() => service.runner!.status().attempts.some((a) => a.attemptId === attempt.id && a.phase === 'turn'));
  const db = openRunnerDb(s.paths.db);
  afterThisTest(() => db.close());
  const store = new AttemptStore(db);
  const clone = store.get(attempt.id)!.clone!;
  const work = join(clone, 'unpublished.txt');
  writeFileSync(work, 'work that cannot be harvested');
  // Corrupt only the scratch worker's git metadata; no real vendor CLI or model is involved.
  rmSync(join(clone, '.git'), { recursive: true, force: true });
  writeFileSync(join(clone, '.git'), 'broken git metadata\n');
  await stopRunner({ paths: s.paths, env: { AGFLOW_TEST: '1' }, lockWaitMs: 10_000, pollMs: 10 });
  expect(await service.exited).toMatchObject({ code: 0, clean: true });
  expect(store.get(attempt.id)).toMatchObject({ state: 'stopped', lateWorkSha: null });
  expect(store.get(attempt.id)!.pushError).toContain('cannot harvest');
  const outbox = new Outbox(db);
  expect(outbox.eventsAfter(outbox.ackedSeq())).toEqual([]);
  let retired = false;
  expect(await s.run(true, {
    env: { ...s.deps.env, AGFLOW_TEST: '1' },
    fetch: async () => { retired = true; return Response.json({ ok: true }); },
  })).toBe(1);
  expect(retired).toBe(false);
  expect(s.claude.calls()).toEqual([]);
  expect(s.codex.calls()).toEqual([]);
  expect(readFileSync(work, 'utf8')).toBe('work that cannot be harvested');
  expect(existsSync(s.plist)).toBe(true);
  expect(s.out.join('')).toContain('cannot harvest');
  s.unchanged();
});

test('offline uninstall takes the lock, kills matching groups and preserves a reused pid', async () => {
  const s = await fixture();
  const db = openRunnerDb(s.paths.db);
  afterThisTest(() => db.close());
  const store = new AttemptStore(db);
  const children = [];
  for (const id of ['matching', 'reused']) {
    const child = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
      cwd: s.home,
    });
    afterThisTest(async () => {
      child.kill('SIGKILL');
      await child.exited;
    });
    let identity = await processIdentity(child.pid);
    for (let i = 0; !identity && i < 100; i++) {
      await Bun.sleep(10);
      identity = await processIdentity(child.pid);
    }
    expect(identity).not.toBeNull();
    record(store, id, null);
    store.recordProcess({
      ...identity!,
      attemptId: id,
      clone: null,
      lstart: id === 'reused' ? 'an earlier process' : identity!.lstart,
    });
    children.push(child);
  }
  expect(await s.run(false, { fetch: async () => Response.json({ ok: true }) })).toBe(0);
  await children[0]!.exited;
  expect(children[0]!.signalCode).toBe('SIGKILL');
  expect(children[1]!.signalCode).toBeNull();
  expect(store.processes()).toEqual([]);
  expect(readLockOwner(s.paths)).toBeNull();
  expect(s.out.join('')).toContain('killed 1 registered agent group');
  s.loggedOut();
});

test('an unanswered lock holder or a new lock owner after stop prevents offline recovery and removal', async () => {
  const s = await fixture();
  const lock = await acquireRunnerLock(s.paths, { mode: 'foreground', wait: false });
  try {
    await expect(s.run()).rejects.toThrow(`pid ${process.pid}`);
    expect(s.claude.calls()).toEqual([]);
  } finally {
    lock.release();
  }
  // Take the lock between stop's socket probe and recovery; recovery must refuse this race too.
  let racedLock: Awaited<ReturnType<typeof acquireRunnerLock>> | undefined;
  const exec: Exec = async (argv) => {
    if (!racedLock) racedLock = await acquireRunnerLock(s.paths, { mode: 'foreground', wait: false });
    return { exitCode: 1, stdout: '', stderr: '', timedOut: false };
  };
  try {
    await expect(s.run(false, { exec })).rejects.toThrow(`pid ${process.pid}`);
  } finally {
    racedLock?.release();
  }
  expect(s.claude.calls()).toEqual([]);
  expect(s.codex.calls()).toEqual([]);
  expect(existsSync(s.plist)).toBe(true);
  s.unchanged();
});

test('unpushedWork reads durable records even after exit, late-work and spawn events are pruned', () => {
  const db = openRunnerDb(':memory:');
  try {
    const store = new AttemptStore(db);
    const outbox = new Outbox(db);
    const [w, x] = ['a', 'b'].map((digit) => digit.repeat(40));
    const live = new Set(['/live', '/lead']);
    const unpushed = () =>
      unpushedWork(store, (path) => live.has(path)).map(({ record, reasons }) => [record.attemptId, reasons]);
    record(store, 'cleaned', null, { state: 'ended', finalizedAt: 1, endedAt: 1, wipSha: x, pushedSha: w });
    record(store, 'failed', '/error', { state: 'ended', finalizedAt: 1, endedAt: 1, pushError: 'denied', lateWorkSha: x });
    // A known-ended refusal has no pushError, even when its WIP shas agree.
    record(store, 'T-4-a6', '/retrying', { state: 'stopped', finalizedAt: 1, wipSha: w, pushedSha: w, lateWorkSha: x });
    // Pending work is in the vault even if the clone is absent or its path was lost.
    record(store, 'no-clone', null, { state: 'ended', finalizedAt: 1, endedAt: 1, lateWorkSha: x });
    record(store, 'stale-error', '/kept', { state: 'stopped', finalizedAt: 1, pushError: 'a push before hand-back', lateWorkSha: null });
    record(store, 'landed', '/held', { state: 'stopped', finalizedAt: 1, wipSha: x, pushedSha: w, lateWorkSha: null });
    record(store, 'unchanged-since-start', '/start', { state: 'stopped', finalizedAt: 1 });
    record(store, 'unchanged-since-push', '/same', { state: 'stopped', finalizedAt: 1, wipSha: x, pushedSha: w });
    record(store, 'live', '/live', { state: 'running', wipSha: w, pushedSha: w });
    record(store, 'held-wip', '/missing', { state: 'running', wipSha: x, pushedSha: w });
    record(store, 'lead', '/lead', { state: 'running', wipSha: x }, 'lead');
    expect(unpushed()).toEqual([
      ['failed', ['final push failed: denied']],
      ['T-4-a6', [`final work ${x} has not reached a late-work ref yet`]],
      ['no-clone', [`final work ${x} has not reached a late-work ref yet`]],
      ['live', ['the runner did not stop this attempt, so its clone was never harvested']],
      ['held-wip', [`unpushed WIP ${x} (last pushed: ${w})`]],
    ]);
    // Once the durable marker clears, retained stale events must not resurrect the pending work.
    store.update('T-4-a6', { lateWorkSha: null });
    outbox.append({ type: 'attempt.exited', attemptId: 'T-4-a6', fence: { epoch: 1, counter: 1 }, data: {
      code: 0, signal: null, stoppedBy: 'none', handoffWritten: false, cause: 'runner_stop',
      finalSha: x, finalWip: null, pushError: null,
    } });
    expect(unpushed().map(([id]) => id)).not.toContain('T-4-a6');
    outbox.pruneBefore(Date.now() + 1);
    expect(unpushed().map(([id]) => id)).toContain('no-clone');
  } finally {
    db.close();
  }
});

test('unpushedWork requires finalization before ignoring retained clones and unequal WIP SHAs', () => {
  const db = openRunnerDb(':memory:');
  try {
    const store = new AttemptStore(db);
    for (const state of ['stopped', 'suspended', 'ended'] as const) {
      record(store, `${state}-clone`, '/retained', { state, wipSha: 'same', pushedSha: 'same' });
      record(store, `${state}-wip`, '/missing', { state, wipSha: 'new', pushedSha: 'old' });
    }
    const pending = () => unpushedWork(store, (path) => path === '/retained');
    const ids = store.list().map((record) => record.attemptId);
    expect(pending().map(({ record }) => record.attemptId)).toEqual(ids);
    for (const id of ids) store.update(id, { finalizedAt: 1 });
    expect(pending()).toEqual([]);

    // Finalization records the outcome; it does not prove a failed harvest or push reached origin.
    store.update('stopped-clone', { pushError: 'cannot harvest' });
    store.update('ended-wip', { lateWorkSha: 'pending-final' });
    expect(pending().map(({ record }) => record.attemptId)).toEqual(['stopped-clone', 'ended-wip']);
    store.update('stopped-clone', { pushError: null });
    store.update('ended-wip', { lateWorkSha: null });
    expect(pending()).toEqual([]);

    // A live worker remains protected even if a previous completion timestamp survived.
    store.update('stopped-clone', { state: 'running' });
    expect(pending().map(({ record }) => record.attemptId)).toEqual(['stopped-clone']);
    // Cleaned records remain safe even without a completion timestamp.
    store.update('stopped-clone', { state: 'ended', clone: null, endedAt: 1, finalizedAt: null });
    expect(pending()).toEqual([]);
  } finally {
    db.close();
  }
});

test('purge refuses before logouts, retirement or removal and names work and recovery instructions', async () => {
  const s = await fixture();
  const db = openRunnerDb(s.paths.db);
  const store = new AttemptStore(db);
  const clones = ['push-error', 'wip', 'live'].map((id) => s.paths.clone('demo', id));
  for (const clone of clones) {
    mkdirSync(clone, { recursive: true });
    writeFileSync(join(clone, 'work'), 'keep');
  }
  record(store, 'push-error', clones[0]!, { pushError: 'remote denied', lateWorkSha: 'failed-sha', endedAt: 1, state: 'ended', finalizedAt: 1 });
  record(store, 'wip', clones[1]!, { wipSha: 'new-sha', pushedSha: 'old-sha', state: 'stopped', finalizedAt: 1, lateWorkSha: 'new-sha' });
  // Left running by a runner that crashed: up to one WIP interval of work was never harvested.
  record(store, 'live', clones[2]!, { state: 'running' });
  db.close();
  let retired = false;
  expect(
    await s.run(true, {
      fetch: async () => {
        retired = true;
        return Response.json({ ok: true });
      },
    }),
  ).toBe(1);
  expect(retired).toBe(false);
  expect(s.claude.calls()).toEqual([]);
  expect(s.codex.calls()).toEqual([]);
  expect(existsSync(s.paths.config)).toBe(true);
  expect(existsSync(s.plist)).toBe(true);
  for (const clone of clones) expect(readFileSync(join(clone, 'work'), 'utf8')).toBe('keep');
  for (const text of [
    ...clones,
    'push-error',
    'wip',
    'remote denied',
    'final work new-sha has not reached a late-work ref yet',
    'its clone was never harvested',
    'agflow runner start',
    'by hand',
    'agflow runner uninstall --purge',
  ])
    expect(s.out.join('')).toContain(text);
  s.unchanged();
});

test('purge deletes only runner, vaults and work, including read-only tools, without following symlinks', async () => {
  const s = await fixture();
  const tools = s.paths.agentTools('demo', 'attempt');
  mkdirSync(join(tools, 'bin'), { recursive: true });
  writeFileSync(join(tools, 'bin', 'tool'), 'tool');
  afterThisTest(() => removeAgentTools(tools));
  const outside = tempDir('agf-outside-');
  writeFileSync(join(outside, 'keep'), 'outside');
  const before = snapshot(join(outside, 'keep'));
  symlinkSync(outside, join(tools, 'outside'));
  chmodSync(join(tools, 'bin'), 0o555);
  chmodSync(tools, 0o555);
  symlinkSync(outside, join(s.paths.vaults, 'linked.agent'));
  symlinkSync(outside, s.paths.agentTools('demo', 'linked'));
  afterThisTest(() => {
    rmSync(join(s.paths.vaults, 'linked.agent'), { force: true });
    rmSync(s.paths.agentTools('demo', 'linked'), { force: true });
  });
  mkdirSync(s.paths.work, { recursive: true });
  symlinkSync(outside, join(s.paths.work, 'outside'));
  const other = join(s.paths.home, 'keep');
  writeFileSync(other, 'keep');
  expect(await s.run(true, { fetch: async () => Response.json({ ok: true }) })).toBe(0);
  for (const path of [s.paths.runner, s.paths.vaults, s.paths.work]) expect(existsSync(path)).toBe(false);
  expect(readFileSync(other, 'utf8')).toBe('keep');
  expect(snapshot(join(outside, 'keep'))).toEqual(before);
  s.unchanged();
});

test('purge removes read-only directories in clones and stays inside AGFLOW_HOME', async () => {
  const s = await fixture();
  const cache = join(s.paths.clone('demo', 'a1'), '.agflow/run/cache/go-mod/example.com/mod@v1');
  mkdirSync(cache, { recursive: true });
  writeFileSync(join(cache, 'go.mod'), 'module example.com/mod\n');
  chmodSync(join(cache, 'go.mod'), 0o444);
  chmodSync(cache, 0o555);
  chmodSync(dirname(cache), 0o555);
  const outside = tempDir('agf-outside-');
  writeFileSync(join(outside, 'keep'), 'outside');
  const before = snapshot(join(outside, 'keep'));
  symlinkSync(outside, join(s.paths.clone('demo', 'a1'), 'outside'));
  expect(await s.run(true, { fetch: async () => Response.json({ ok: true }) })).toBe(0);
  for (const path of [s.paths.runner, s.paths.vaults, s.paths.work]) expect(existsSync(path)).toBe(false);
  expect(snapshot(join(outside, 'keep'))).toEqual(before);
  s.unchanged();
});

test('purge refuses while runner.db holds events the hub has not acknowledged', async () => {
  const s = await fixture();
  const db = openRunnerDb(s.paths.db);
  new Outbox(db).append({ type: 'runner.state', data: { state: 'ok', detail: null } });
  db.close();
  let retired = false;
  const fetch: RunnerUninstallDeps['fetch'] = async () => {
    retired = true;
    return Response.json({ ok: true });
  };
  expect(await s.run(true, { fetch })).toBe(1);
  expect(retired).toBe(false);
  expect(s.claude.calls()).toEqual([]);
  expect(existsSync(s.paths.db)).toBe(true);
  expect(s.out.join('')).toContain('1 event the hub has not acknowledged');
  expect(s.out.join('')).toContain('run agflow runner start until the hub has them');
});

test('purge after a failed retirement keeps runner.json, runner.db and the clones for a rerun', async () => {
  const s = await fixture();
  mkdirSync(s.paths.clone('demo', 'a1'), { recursive: true });
  const db = openRunnerDb(s.paths.db);
  db.close();
  const fetch: RunnerUninstallDeps['fetch'] = async () => {
    throw new Error('network down');
  };
  expect(await s.run(true, { fetch })).toBe(1);
  for (const path of [s.paths.config, s.paths.db, s.paths.clone('demo', 'a1')]) expect(existsSync(path)).toBe(true);
  expect(existsSync(s.plist)).toBe(false);
  expect(s.out.join('')).toContain('run agflow runner uninstall --purge again once the hub is reachable');
  expect(await s.run(true, { fetch: async () => Response.json({ ok: true }) })).toBe(0);
  for (const path of [s.paths.runner, s.paths.vaults, s.paths.work]) expect(existsSync(path)).toBe(false);
});

test('a runner.json copied from another Mac is not retired from this one', async () => {
  const s = await fixture();
  s.machine.id = '00000000-0000-4000-8000-000000000002';
  let retired = false;
  const fetch: RunnerUninstallDeps['fetch'] = async () => {
    retired = true;
    return Response.json({ ok: true });
  };
  expect(await s.run(false, { fetch })).toBe(0);
  expect(retired).toBe(false);
  expect(findRunnerByKey(s.hub.ctx, s.config.runnerKey)?.retired_at ?? null).toBeNull();
  expect(s.out.join('')).toContain(
    `runner.json came from another Mac; its runner ${s.config.runnerKey} belongs to that Mac and is not retired here`,
  );
  s.loggedOut();
});

test('logouts use the newest installed binary when the pin moved, and say when none is installed', async () => {
  const s = await fixture();
  rmSync(join(s.paths.vendor, 'codex'), { recursive: true });
  const pins = {
    claude: { ...s.deps.pins!.claude, version: '9.9.9' },
    codex: { ...s.deps.pins!.codex, version: '9.9.8' },
  };
  expect(await s.run(false, { pins, fetch: async () => Response.json({ ok: true }) })).toBe(0);
  expect(s.claude.calls()).toHaveLength(1);
  expect(s.claude.calls()[0]!.argv).toEqual(['auth', 'logout']);
  expect(s.out.join('')).toContain("claude: requested logout from the runner's home");
  expect(s.out.join('')).toContain('codex: no runner binary is installed, so the logout could not run');
  expect(s.out.join('')).not.toContain('codex: requested logout');
});

for (const failure of ['unreachable', 'missing credentials', 'refused token']) {
  test(`${failure}: local steps finish and retirement failure returns 1`, async () => {
    const s = await fixture();
    if (failure === 'missing credentials') rmSync(credentialsPath(s.configDir));
    const fetch: RunnerUninstallDeps['fetch'] = async () => {
      if (failure === 'unreachable') throw new Error('network down');
      return Response.json({ error: 'unauthorized', message: 'refused' }, { status: 401 });
    };
    expect(await s.run(false, { fetch })).toBe(1);
    expect(s.claude.calls()).toHaveLength(1);
    expect(s.codex.calls()).toHaveLength(1);
    expect(existsSync(s.plist)).toBe(false);
    expect(existsSync(s.paths.config)).toBe(true);
    expect(s.out.join('')).toContain('retire');
    expect(s.out.join('')).toContain(failure === 'unreachable' ? 'network down' : 'run agflow login --hub');
    if (failure !== 'missing credentials') s.unchanged();
  });
}

test('missing runner.json skips logouts and retire but still removes the plist', async () => {
  const s = await fixture();
  rmSync(s.paths.config);
  expect(
    await s.run(false, {
      fetch: async () => {
        throw new Error('must not retire');
      },
    }),
  ).toBe(0);
  expect(s.out.join('')).toContain('runner.json is missing');
  expect(s.claude.calls()).toEqual([]);
  expect(s.codex.calls()).toEqual([]);
  expect(existsSync(s.paths.db)).toBe(false);
  expect(existsSync(s.plist)).toBe(false);
  s.unchanged();
});

test('uninstall help and usage reject extra arguments', async () => {
  const s = await fixture();
  expect(RUNNER_HELP).toContain('agflow runner uninstall [--purge]');
  for (const argv of [
    ['runner', 'uninstall', 'extra'],
    ['runner', 'uninstall', '--purge', 'extra'],
  ]) {
    expect(await main(argv, s.io)).toBe(2);
    expect(s.err.join('')).toContain('usage: agflow runner uninstall [--purge]');
  }
});

for (const running of [false, true]) {
  test(`uninstall in injected test mode leaves launchd and its plist alone (running: ${running})`, async () => {
    const s = await fixture();
    if (running) await s.start();
    process.env.AGFLOW_TEST = '0';
    expect(await runnerCommand(parseArgs(['runner', 'uninstall']), s.io, {
      env: { ...s.deps.env, AGFLOW_TEST: '1' },
      uninstall: { ...s.deps, env: undefined, fetch: async () => Response.json({ ok: true }) },
    })).toBe(0);
    expect(s.commands.filter((argv) => argv[0] === 'launchctl')).toEqual([]);
    expect(readFileSync(s.plist, 'utf8')).toBe('installed');
  });
}
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `bun test packages/cli/test/runner-uninstall.test.ts`
Expected: FAIL — `error: Cannot find module '../src/runner-uninstall' from '/private/tmp/agflow-m2c-final-parent/packages/cli/test/runner-uninstall.test.ts'` (0 pass, 1 fail, 1 error; exit 1). Observed on parent `889c1283c7b046690a0a00c1c7e9ff8b4406d423` with only Task 25's test files from `a0202a2f06b26bde6947efcb936ef6aff344a782` copied in (2026-11-11); log: `final-chain-checks/task-25-parent.log`.

- [ ] **Step 3: Implement**

**File:** `packages/cli/src/hub-client.ts` (change)

```diff
diff --git a/packages/cli/src/hub-client.ts b/packages/cli/src/hub-client.ts
index 89f2b678..1952a631 100644
--- a/packages/cli/src/hub-client.ts
+++ b/packages/cli/src/hub-client.ts
@@ -2,6 +2,7 @@ import {
   type AgentStopInputSchema,
   BRIDGE_HEADER,
   BRIDGE_VERSION,
+  type RunnerRetireInputSchema,
   type RunnerSubmitInputSchema,
   type StaffingInputSchema,
   WhoamiResponseSchema,
@@ -153,6 +154,10 @@ export class HubClient {
   async runnerWhoami() {
     return WhoamiResponseSchema.parse(await this.request('GET', '/api/runner/whoami'));
   }
+  retireRunner(runnerKey: string) {
+    const body: z.input<typeof RunnerRetireInputSchema> = { runnerKey };
+    return this.request<{ ok: boolean }>('POST', '/api/runner/retire', body);
+  }
 
   // Live sessions (hooks)
   sessionStart(input: { vendor: Vendor; sessionId: string; role: AgentRole; label?: string | undefined }) {
```

**File:** `packages/cli/src/runner-command.ts` (change)

```diff
diff --git a/packages/cli/src/runner-command.ts b/packages/cli/src/runner-command.ts
index 88876610..7e6afedb 100644
--- a/packages/cli/src/runner-command.ts
+++ b/packages/cli/src/runner-command.ts
@@ -13,6 +13,7 @@ import type { Io } from './io';
 import type { Command } from './main';
 import { configDir } from './paths';
 import type { RunnerSetupDeps } from './runner-setup';
+import type { RunnerUninstallDeps } from './runner-uninstall';
 import { selfCommand } from './self';
 
 /** The runner subcommands' lines in main.ts's HELP; each subcommand adds its own. */
@@ -25,6 +26,8 @@ export const RUNNER_HELP = `  agflow runner setup [--yes] [--relogin] [--no-serv
   agflow runner drain            Stop accepting new attempts
   agflow runner undrain          Accept new attempts and clear the crash-loop guard
   agflow runner install          Install and start the LaunchAgent that runs the runner at login
+  agflow runner uninstall [--purge]
+                                Stop, log out, retire and remove the LaunchAgent; --purge deletes local runner data
   agflow runner status [--json]  Show the runner's status and attempts
 `;
 
@@ -33,6 +36,7 @@ export async function runnerCommand(
   io: Io,
   deps: {
     setup?: Partial<RunnerSetupDeps>;
+    uninstall?: Partial<RunnerUninstallDeps>;
     startRunnerService?: typeof startRunnerService;
     installService?: typeof installService;
     env?: Record<string, string | undefined>;
@@ -161,6 +165,16 @@ export async function runnerCommand(
         return 1;
       }
     },
+    uninstall: async (args, io) => {
+      if (args.positional.length > 2 || (args.flags.purge !== undefined && args.flags.purge !== true)) {
+        throw new UsageError('usage: agflow runner uninstall [--purge]');
+      }
+      const { uninstallRunner } = await import('./runner-uninstall');
+      return uninstallRunner(args, io, {
+        exec: deps.exec, uid: deps.uid, home: deps.home, ...deps.uninstall,
+        env: deps.uninstall?.env ?? env,
+      });
+    },
   };
   const name = args.positional[1];
   const command = name !== undefined && Object.hasOwn(commands, name) ? commands[name] : undefined;
```

**File:** `packages/cli/src/runner-uninstall.ts` (new)

```ts
// Uninstall keeps unpushed work recoverable and leaves the owner's logins and CLI credentials alone (design 7.1).
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Vendor } from '@agflow/core';
import { isCleanedUp, removeTree } from '@agflow/runner/src/attempt/cleanup';
import { AttemptStore, type AttemptRecord } from '@agflow/runner/src/attempt-store';
import { loadRunnerConfig } from '@agflow/runner/src/config';
import { openRunnerDb } from '@agflow/runner/src/db';
import { Outbox } from '@agflow/runner/src/outbox';
import { agflowHome, type RunnerPaths, runnerPaths } from '@agflow/runner/src/paths';
import { killRegisteredGroups } from '@agflow/runner/src/recovery';
import { bootoutService, plistPath, serviceLoaded } from '@agflow/runner/src/service/launchd';
import { acquireRunnerLock } from '@agflow/runner/src/service/lock';
import { machineMismatch, readMachineId } from '@agflow/runner/src/service/machine';
import { stopRunner } from '@agflow/runner/src/service/stop';
import { defaultExec, type Exec } from '@agflow/runner/src/service/system';
import { logoutClaude, logoutCodex } from '@agflow/runner/src/vendor/login';
import { type PlatformPins, VENDOR_PINS, vendorBinary, vendorPlatform } from '@agflow/runner/src/vendor/pins';
import type { ParsedArgs } from './args';
import { loadCredentials } from './credentials';
import { type FetchFn, HubClient, HubClientError } from './hub-client';
import type { Io } from './io';
import { configDir } from './paths';

export interface RunnerUninstallDeps {
  dir: string;
  paths: RunnerPaths;
  env: Record<string, string | undefined>;
  fetch: FetchFn;
  exec: Exec;
  pins: PlatformPins;
  platform: string;
  /** The machine-id platform (ioreg on darwin). */
  machinePlatform: NodeJS.Platform;
  home: string;
  uid: number;
  lockWaitMs: number;
  pollMs: number;
}

export interface UnpushedAttempt {
  record: AttemptRecord;
  reasons: string[];
}

const LIVE_STATES: readonly AttemptRecord['state'][] = ['starting', 'running', 'idle'];

/**
 * Durable pending work survives event retention and a missing clone: the vault still holds lateWorkSha. Before
 * finalization, a worker's clone may also hold unharvested work, and unequal WIP shas name work still waiting to push.
 * Recovery can mark a worker stopped without finalizing it. After finalization, WIP shas can stay unequal even when
 * all final work reached the origin. Live workers remain protected regardless of a previous completion timestamp.
 * A failed harvest may produce no SHA at all: an unresolved final-work error still protects a retained clone.
 */
export function unpushedWork(
  store: AttemptStore,
  cloneExists: (path: string) => boolean = existsSync,
): UnpushedAttempt[] {
  return store.list().flatMap((record) => {
    const reasons: string[] = [];
    if (record.lateWorkSha !== null) {
      reasons.push(record.pushError !== null
        ? `final push failed: ${record.pushError}`
        : `final work ${record.lateWorkSha} has not reached a late-work ref yet`);
    } else if (isCleanedUp(record)) {
      return [];
    } else if (record.pushError !== null && record.clone !== null && cloneExists(record.clone)) {
      reasons.push(`final work failed: ${record.pushError}`);
    }
    if (record.spec.role === 'worker' && (LIVE_STATES.includes(record.state) || record.finalizedAt === null)) {
      if (record.clone !== null && cloneExists(record.clone)) {
        reasons.push('the runner did not stop this attempt, so its clone was never harvested');
      } else if (record.wipSha !== null && record.wipSha !== record.pushedSha) {
        reasons.push(`unpushed WIP ${record.wipSha} (last pushed: ${record.pushedSha ?? 'none'})`);
      }
    }
    return reasons.length ? [{ record, reasons }] : [];
  });
}

function versionOrder(a: string, b: string): number {
  const [x, y] = [a, b].map((version) => version.split('.').map(Number));
  for (let i = 0; i < 3; i++) if (x![i] !== y![i]) return x![i]! - y![i]!;
  return 0;
}

/** The pinned version when installed; after an upgrade bumped a pin that start never downloads, the newest one there. */
function installedVersion(paths: RunnerPaths, vendor: Vendor, pinned: string | undefined): string | null {
  const installed = (version: string) => {
    try {
      return existsSync(join(paths.runner, vendorBinary(vendor, version)));
    } catch {
      // Not a version directory.
      return false;
    }
  };
  if (pinned !== undefined && installed(pinned)) return pinned;
  const dir = join(paths.vendor, vendor);
  const versions = existsSync(dir) ? readdirSync(dir).filter(installed) : [];
  return versions.sort(versionOrder).at(-1) ?? null;
}

export async function uninstallRunner(
  args: ParsedArgs,
  io: Io,
  deps: Partial<RunnerUninstallDeps> = {},
): Promise<number> {
  const env = deps.env ?? process.env;
  const paths = deps.paths ?? runnerPaths(agflowHome(env));
  const exec = deps.exec ?? defaultExec;
  const launchctl = { exec, uid: deps.uid };
  const log = (line: string) => io.out(`${line}\n`);
  const stopped = await stopRunner({ paths, env, ...launchctl, lockWaitMs: deps.lockWaitMs, pollMs: deps.pollMs });
  log(stopped.wasRunning ? 'the runner stopped' : 'no runner was running');
  if (!stopped.wasRunning) {
    const lock = await acquireRunnerLock(paths, { mode: 'foreground', wait: false });
    try {
      let killed = 0;
      if (existsSync(paths.db)) {
        const db = openRunnerDb(paths.db);
        try {
          killed = (await killRegisteredGroups(new AttemptStore(db))).length;
        } finally {
          db.close();
        }
      }
      log(`killed ${killed} registered agent group${killed === 1 ? '' : 's'}`);
    } finally {
      lock.release();
    }
  }

  if (args.flags.purge === true) {
    let unpushed: UnpushedAttempt[] = [];
    let unacked = 0;
    if (existsSync(paths.db)) {
      const db = openRunnerDb(paths.db);
      try {
        const outbox = new Outbox(db);
        unpushed = unpushedWork(new AttemptStore(db));
        unacked = outbox.eventsAfter(outbox.ackedSeq()).length;
      } finally {
        db.close();
      }
    }
    if (unpushed.length) {
      log('refusing to purge: attempts have unpushed work');
      for (const { record, reasons } of unpushed) {
        log(`${record.attemptId}: ${record.clone ?? '(no clone path recorded)'}; ${reasons.join('; ')}`);
      }
      log(
        'run agflow runner start once to finish and retry these pushes, or push the work from the clone by hand; ' +
          'then run agflow runner uninstall --purge again',
      );
      return 1;
    }
    // Exits and final WIP shas the hub has not heard of would go with runner.db: a successor would start from older work.
    if (unacked > 0) {
      log(
        `refusing to purge: runner.db holds ${unacked} event${unacked === 1 ? '' : 's'} the hub has not acknowledged`,
      );
      log('run agflow runner start until the hub has them, then run agflow runner uninstall --purge again');
      return 1;
    }
    log('no attempt has unpushed work');
  }

  let retireFailed = false;
  if (!existsSync(paths.config)) {
    log('runner.json is missing; skipping vendor logouts and hub retirement');
  } else {
    const config = loadRunnerConfig(paths.config, env);
    // A runner.json copied from another Mac (a restore, Migration Assistant) names that Mac's live runner.
    const copied =
      machineMismatch(config, await readMachineId({ exec, platform: deps.machinePlatform ?? process.platform })) !==
      null;
    const platform = deps.platform ?? vendorPlatform();
    const pins = deps.pins ?? VENDOR_PINS[platform];
    for (const vendor of ['claude', 'codex'] as const) {
      const version = installedVersion(paths, vendor, pins?.[vendor].version);
      if (version === null) {
        const kept = vendor === 'claude' ? '; its login stays in the login keychain' : '';
        log(`${vendor}: no runner binary is installed, so the logout could not run${kept}`);
        continue;
      }
      await (vendor === 'claude' ? logoutClaude : logoutCodex)(config, paths, { version, platform, exec, base: env });
      // The vendor logout API is best effort and does not report success or failure.
      log(`${vendor}: requested logout from the runner's home`);
    }
    if (copied) {
      log(
        `runner.json came from another Mac; its runner ${config.runnerKey} belongs to that Mac and is not retired here`,
      );
    } else {
      try {
        const credentials = loadCredentials(deps.dir ?? configDir());
        if (!credentials) throw new Error('not signed in; run agflow login --hub <url>');
        const client = new HubClient({ baseUrl: credentials.hubUrl, token: credentials.token, fetch: deps.fetch });
        try {
          await client.retireRunner(config.runnerKey);
        } catch (error) {
          if (error instanceof HubClientError && error.status === 401) {
            throw new Error(`the hub refused the CLI sign-in; run agflow login --hub ${credentials.hubUrl}`);
          }
          throw error;
        }
        log(`retired runner ${config.runnerKey} on ${credentials.hubUrl}`);
      } catch (error) {
        retireFailed = true;
        log(`could not retire the runner: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  if (env.AGFLOW_TEST !== '1') {
    if (await serviceLoaded(launchctl)) {
      if (!(await bootoutService(launchctl)) && (await serviceLoaded(launchctl))) {
        throw new Error('launchctl bootout failed; the service is still loaded');
      }
    }
    const plist = plistPath({ home: deps.home ?? homedir() });
    rmSync(plist, { force: true });
    log(`removed ${plist}`);
  }
  if (args.flags.purge === true) {
    if (retireFailed) {
      // runner.json holds the key a later retirement needs, and runner.db the events the hub may still lack.
      log(`kept ${paths.runner}, ${paths.vaults} and ${paths.work}`);
      log('run agflow runner uninstall --purge again once the hub is reachable and the CLI is signed in');
      return 1;
    }
    // Clones hold read-only directories (Go's module cache, an agent's chmod), and tools are read-only. runner/ goes
    // last, so a failure leaves runner.json for a rerun.
    for (const path of [paths.work, paths.vaults, paths.runner]) await removeTree(path);
    log(`removed ${paths.runner}, ${paths.vaults} and ${paths.work}`);
  }
  return retireFailed ? 1 : 0;
}
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `bun test packages/cli/test/runner-uninstall.test.ts && bun test && bun run typecheck`
Expected: the task's tests pass; then the whole suite passes (`0 fail`) and `tsc` exits 0.

`unpushedWork(store, cloneExists?)` reads durable AttemptStore records, never retained outbox events. A non-null `lateWorkSha` blocks purge even without a clone; `pushError` supplies its diagnostic. With no pending late-work marker, cleaned records are skipped. Independently, a non-null `pushError` with an existing clone blocks purge, because a failed final harvest may produce no SHA; once the clone is gone, `pushError` alone does not block. The worker guard is `record.spec.role === 'worker' && (LIVE_STATES.includes(record.state) || record.finalizedAt === null)`: a live or unfinalized worker's existing clone may contain unharvested work; without an existing clone, a non-null `wipSha` unequal to `pushedSha` reports held WIP. Recovery changing state to stopped does not establish finalization. Only finalized non-live records with no pending late work and no unresolved retained-clone error may ignore stale unequal WIP SHAs. M2b persists `finalizedAt` only after the final-work outcome and pending work, resets it before start/resume, and leaves it unset during recovery. Successful hand-back or cleanup work resolution clears `pushError`; failed harvest/push resolution preserves it.

The failed-project-lookup regression is a normal test: startup recovery changes a crashed worker to stopped with `finalizedAt: null`, then project lookup fails. Purge must exit 1, make zero external calls, and preserve the unpublished file and runner.db. The finalization regression checks stopped, suspended and ended workers with retained clones or unequal WIP SHAs, then sets numeric completion timestamps and verifies that stale WIP no longer blocks. It also checks that pending late work or a retained-clone error still blocks after finalization, a live worker stays protected even with an old timestamp, and a cleaned record is safe without one. Finalized synthetic fixtures use numeric `finalizedAt`; crashed and unfinalized records keep null. The failed-harvest regression stops a fake worker with broken scratch .git metadata, verifies `pushError` with `lateWorkSha: null` and all events acknowledged, then requires purge refusal and preservation of its unpublished file, plist and credentials.

Cleared late-work markers remain cleared even if an old exit event remains, and pruning exit, spawn or late-work events does not change the answer. Unacknowledged events remain a separate purge refusal. Refusals happen before logouts, retirement and plist removal; a failed retirement under `--purge` keeps all three data directories. A runner.json copied from another Mac is not retired. Logouts use the pinned binary or newest installed one; missing binaries are reported. `uninstallRunner` forwards `deps.env` to `stopRunner` and, with `AGFLOW_TEST='1'`, never probes or boots out launchd and never removes the plist. Tests plant a scratch plist and require it to remain for both running and offline uninstall.

- [ ] **Step 5: Commit**

```bash
git add -A 'packages/cli/src/hub-client.ts' 'packages/cli/src/runner-command.ts' 'packages/cli/src/runner-uninstall.ts' 'packages/cli/test/runner-uninstall.test.ts'
git commit -m 'M2C Task 25: `agflow runner uninstall`' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

## After the last task

### What works now

- A laptop is set up once with `agflow runner setup`: it checks the CLI's sign-in against the hub, writes runner.json (0600, no secrets) with this Mac's facts, installs the pinned Claude and Codex binaries, logs both vendors in to the runner's own homes, installs the LaunchAgent, and prints the checks that ran inside the service. A failed check makes setup exit 1.
- `agflow runner start` runs the runner in the foreground; under launchd, `runner start --service` runs it at login in the Aqua session. One instance runs per runner home, guarded by `runner.lock`, and running-service status, drain, undrain, suspend and stop requests use `runner.sock`. The CLI also exposes `install`, `restart` and `uninstall [--purge]`, combining socket, filesystem and launchd operations as appropriate.
- The service fills M2b's seams. It logs to logs/runner.log with rotation, refuses starts while it is waking, short of battery or disk, or in needs_login, and stops its agents without a handoff turn below 8% battery or half of `minFreeGb`. It holds caffeinate while attempts run, prepares dependencies inside Anthropic's sandbox runtime, posts approval and needs_login notifications, and sweeps retention daily.
- Lifecycle: SIGTERM (and SIGINT, and SIGHUP in the foreground) suspends within 45 s and exits 0; the hub keeps the attempts and resumes them on the next hello. A refusal that needs a person (another Mac, 4403, 4426, no runner.json) exits 0 under launchd and 1 in the foreground. Three unclean exits within 10 minutes drain the runner and report `crash_loop` until `agflow runner undrain`. Without credentials the service waits in needs_login instead of exiting.
- The real adapters are not here yet: until M2d and M2e fill `createAdapters`' entry files, the service runs with no adapter, setup prints no vendor check, and no attempt can start on the runner.

### How to run it

- The whole suite (coordinator, outside the sandbox): `bun test && bun run typecheck` (about fifteen minutes). This plan's tests alone: `bun test packages/runner/test/service packages/runner/test/ops packages/runner/test/prep packages/runner/test/vendor packages/cli/test/runner-command.test.ts packages/cli/test/runner-setup.test.ts packages/cli/test/runner-uninstall.test.ts`.
- Owner-operated production usage, not commands to execute during this refresh: from source, `bun --no-env-file --config=/dev/null packages/cli/src/main.ts login --hub <url>`, then `bun --no-env-file --config=/dev/null packages/cli/src/main.ts runner setup` (`--yes` takes the defaults, `--relogin` repeats the vendor logins, `--no-service` stops before the LaunchAgent). Then `agflow runner status`, `drain`, `undrain`, `restart`, `stop` and `uninstall [--purge]` the same way. The LaunchAgent runs the agflow command that installed it, so a compiled `agflow` (`bun run build:cli`) outside ~/Desktop, ~/Documents and ~/Downloads makes the better login item.
- For verification, `AGFLOW_HOME=<scratch-home> bun run vendor:install` downloads the two pinned packages from `https://registry.npmjs.org` (or the registry named by `AGFLOW_NPM_REGISTRY`): `@anthropic-ai/claude-agent-sdk-darwin-arm64@0.3.285` (`<registry>/@anthropic-ai/claude-agent-sdk-darwin-arm64/-/claude-agent-sdk-darwin-arm64-0.3.285.tgz`), whose `claude` file goes to `$AGFLOW_HOME/runner/vendor/claude/2.1.285/claude` after its sha256 matches `VENDOR_PINS`' `sha256` (copied from the SDK's `manifest.json`; a test keeps them equal); and `@openai/codex@0.159.2-darwin-arm64` (`<registry>/@openai/codex/-/codex-0.159.2-darwin-arm64.tgz`), whose `vendor/aarch64-apple-darwin/` tree goes to `$AGFLOW_HOME/runner/vendor/codex/0.159.2/`. Each tarball's sha512 is checked against `VENDOR_PINS` before it is unpacked, and each binary's `--version` after. `AGFLOW_HOME` defaults to `~/.agflow`; an installed version that verifies is reused without a download. It needs darwin-arm64 and about 560 MB of disk. Before verification, export `AGFLOW_CLAUDE_BIN=<scratch-home>/runner/vendor/claude/2.1.285/claude` and `AGFLOW_CODEX_BIN=<scratch-home>/runner/vendor/codex/0.159.2/bin/codex`; the locators do not read `AGFLOW_HOME`. Remove the scratch installation after all children exit. Do not run the installer without a scratch `AGFLOW_HOME` or install globally during implementation or verification.
- `bun run verify:prep` (macOS, with the network and a `python3` on PATH whose pip is 24.2 or newer, such as Homebrew's or pyenv's; not the Command Line Tools' /usr/bin/python3, whose pip 21.2.4 rejects the fixture's `--use-deprecated=legacy-certs`): real sandboxed `bun install` and `pip install` from empty caches in a scratch `AGFLOW_HOME`, then a check that no installed file shares an inode with the cache. `AGFLOW_SANDBOX_CHECKS=1 bun test packages/runner/test/prep` runs it as a test.
- `bun run verify:service` (historical G6 procedure; prohibited in this run because it installs a real LaunchAgent and uses the real user domain; needs a desktop session, not SSH): it compiles the CLI with `--no-compile-autoload-bunfig` and `--no-compile-autoload-dotenv` into `/tmp/agf-vs-*` and drives a scratch LaunchAgent, with its own label, plist home and `AGFLOW_HOME`, through install, `status --json`, restart and stop against an in-process hub, then removes it. Stop and restart receive the scratch environment. It never touches `dev.agflow.runner`, `~/Library/LaunchAgents` or `~/.agflow`.

### What the next plans build on

Other plans import these by name. A change to them needs a recorded decision and updates every importer in the same commit.

- **For M2g (the end-to-end harness and the live run):**
  - `service/control.ts` exports `controlRequest<T = unknown>(paths: RunnerPaths, method: string, path: string, body?: unknown, options?: { timeoutMs?: number }): Promise<T>` and `ControlUnavailableError`. M2g polls `GET /health` with a 2,000 ms timeout; the response contains `pid`, `mode`, `startedAt`, `runnerId` and `link`. Startup requires the spawned pid and, unless `online: false`, an online link with a runner id. `ControlUnavailableError` means no listener or no answer before the timeout, and M2g retries it; other errors propagate. The control client defaults to 3,000 ms; 2,000 ms is M2g's explicit startup-poll timeout. `vendor/login.ts` also exports `VendorLoginOptions` and `VendorLoginStatus`, which M2g’s live-run module imports.
  - `readMachineId`, `canonicalHome` (`service/machine.ts`) and `createRunnerConfig(facts, overrides)` with `newRunnerKey` (`service/runner-json.ts`) build its runner homes (X-42); any `RunnerConfig` field can be overridden, and the result is validated with M2b's schema. `facts.homes` (and any `homes` override) must be real paths: `createRunnerConfig` throws "must be a real path" for a vendor home under a link such as /tmp or /var/folders, so make them with `canonicalHome`.
  - `agflow runner start` in the foreground, or `startRunnerService(RunnerServiceOptions)` (`service/host.ts`), which resolves with a `RunnerService` (`paths`, `mode`, `runner`, `needsLogin`, `exited`, `suspend`, `stop`, `runnerStop`); `exited` resolves with a `ServiceExit` (`code`, `clean`, `reason`). SIGTERM suspends and exits 0 with `attempt.exited` cause `suspend`. RunnerServiceOptions.cliVersion?: (vendor: Vendor) => string forwards to createRunner; omit it in production and pass fixtureCliVersion with fake adapters. retentionPlatform?: string selects the retention pin table independently of machine-operation platform overrides. M2b may consume a restored hub's first welcome internally before reporting the next welcome.
  - `agflow runner status --json` prints a `RunnerStatusReport` (`service/status.ts`), a union on `running`. A running runner (`running: true`) reports `pid`, `mode`, `startedAt`, `runnerId`, `name`, `hubUrl`, `link`, `state`, `reason`, `needsLogin`, `draining`, `capacity`, `freeSlots`, `power`, `disk`, `acceptingUntil`, `keepAwake`, `dependencyPrep`, `vendors`, `keptClones`, `warnings`, and `attempts`, each with `attemptId`, `taskId`, `role`, `vendor`, `state`, `phase`, `ageMs`, `lastPushAt`, `wipSha`, `pushedSha`, `pushError`, `lateWorkSha` and flat `pid`, `pgid` and `lstart` (null without a recorded group). `acceptingUntil` is in epoch milliseconds (the host converts the heartbeat's duration), or null when no timed hold is on. An offline report (`running: false`) has `bestEffort`, `plistInstalled`, `disabled`, `lastExit`, `lockHolder`, `logLines` and `warnings`. The command exits 0 when the runner answered, 1 otherwise. With AGFLOW_TEST=1 there is no launchctl call: running status adds no Login Items warning; offline status reports disabled:null and plistInstalled:false without probing the plist.
  - `claudeLoginStatus` and `codexLoginStatus` (`vendor/login.ts`) confirm a logged-in runner home without sending a prompt; the pinned binaries live under `$AGFLOW_HOME/runner/vendor/<vendor>/<version>/` (`~/.agflow` by default) after setup or `vendor:install`. During implementation and verification, use existing explicit binary paths or `AGFLOW_HOME=<scratch-home> bun run vendor:install`, then export `AGFLOW_CLAUDE_BIN=<scratch-home>/runner/vendor/claude/2.1.285/claude` and `AGFLOW_CODEX_BIN=<scratch-home>/runner/vendor/codex/0.159.2/bin/codex`; the test locators ignore `AGFLOW_HOME`. Remove the scratch install after all children exit; never install globally or into the owner's home for checks.
  - `runnerSetup(args, io, deps)` and `Prompt` (`ask(question, fallback)`, with `terminalPrompt()`) in `packages/cli/src/runner-setup.ts`, every dependency injectable through `RunnerSetupDeps`; `HubClient.runnerWhoami()` (parsed with `WhoamiResponseSchema`) and `HubClient.retireRunner(runnerKey)`.
  - stopRunner(options) resolves with { wasRunning, bootedOut, disabled }; restartRunner(options) suspends then kickstarts only outside test mode. Both accept env, defaulting to process.env. With AGFLOW_TEST=1 there is no launchctl call: stop returns bootedOut:false and disabled:false, and restart rejects before suspension. uninstallRunner(args, io, deps) forwards deps.env and leaves launchd and the plist alone in test mode. unpushedWork(store, cloneExists?) reads durable records without an Outbox argument; it detects late work even when the clone is absent and refuses an unresolved final-work error when the clone remains, including failures that produced no SHA. The worker guard is `record.spec.role === 'worker' && (LIVE_STATES.includes(record.state) || record.finalizedAt === null)`: check retained clones and, without a clone, non-null WIP unequal to pushedSha for live or unfinalized workers. Finalized non-live records may ignore stale unequal WIP SHAs, but lateWorkSha still blocks without a clone and pushError still blocks with one. Cleaned records with no lateWorkSha remain safe, even with null finalizedAt. New/migrated records start null; start/resume reset before work; finalization persists outcome and pending work before the timestamp; recovery never manufactures completion. Successful hand-back clears lateWorkSha and pushError before reporting and cleanup; successful cleanup work resolution clears pushError, while failed harvest/push resolution preserves it. M2g stops runners with SIGTERM. pushError with an existing clone blocks purge even when lateWorkSha is null. `verifyServiceMain(argv, env, options)` remains the service verification entry point, subject to the prohibition on real LaunchAgents and real user launchctl domains.
  - `RUNNER_HELP` (`packages/cli/src/runner-command.ts`), which main.ts's HELP shows under "Runners:", and the root scripts `vendor:install`, `verify:prep` and `verify:service`, for M2g's README.
  - Test helpers in `packages/runner/test/service-helpers.ts`: `setupTestService(options)` and `startTestService(options)` (a short `/tmp/agf-*` home, a test runner.json and a CLI config with the in-process hub's credentials, cleaned up after the test), `startOriginHub()`, `fakeServiceOperations()`, `fakeServiceAdapters()`, `sleepingServiceAdapter()`, `fakePrepSandbox()`, `recordingExec()`, `fakeVendorCli()`, `localRegistry()` and `packTarball()`. `test/service/run-service.ts` and `packages/cli/test/run-runner-start.ts` run the service and the CLI as child processes.
  - The e2e runners should set `keepAwake` off and a low `minFreeGb`, and run on AC power: on battery below `batteryDrainPercent` (20% by default) the runner refuses starts with `battery_low`, and below 8% the guard stops the agents.
  - How a real `agflow runner start` reacts to M2g's faults: a freeze longer than `tickGap` (5 s), as in a freeze and thaw or the closed-laptop scenario, fires `RunnerEvents.gap`, and the runner then refuses new starts with `waking` for `wakeHold` (2 minutes by default). A SIGKILLed runner counts as an unclean exit, and three within `crashLoopWindow` (10 minutes) in one home drain it with `crash_loop` until `agflow runner undrain`. So E2E_RUNNER_TIMINGS should shorten `wakeHold`, and `crashLoopWindow` when a home is SIGKILLed more than twice, under `test.allowShortTimings`.
  - What a real start does: `createRunner` runs M2b's `recoverOnStart` (the start-up kill, sweep and report) before the hello; the host initialises Anthropic's sandbox runtime and runs `checkPrepSandbox`'s probe, samples `pmset` every 60 s and runs `du` over `AGFLOW_HOME` at most every 10 minutes. runner.lock allows one instance per home: a second foreground start exits 1 with "the runner is already running (pid N); use agflow runner status".
  - Outbox.pruneAcked(olderThanMs) and pruneBefore(at) retain in-flight settings edits using settingsSavedVersion, drop deleted events' marks and do not pin probes. new Outbox(db) is sufficient. Retention never removes an attempt with lateWorkSha set.
- **For M2f (the web UI):**
  - What reaches the runner card through the hub (core's reported states are only `ok`, `crash_loop` and `disk_low`): `crash_loop` carries the last unclean exit's reason as its detail ("repeated unclean exits" when there is none), and `agflow runner undrain` clears it; `disk_low` carries "free space below <minFreeGb> GB".
  - What stays on the laptop: the hub derives needs_login itself, and the runner's needs_login log line and notification say "the hub refused the CLI's sign-in; the sign-in expired or was revoked; run agflow login --hub <url>"; approval notifications end with the hub URL followed by core's `APPROVALS_ROUTE` (`#/approvals`).
  - M2f's Runners page depends on this plan in turn: `views/RunnersView.tsx` names `agflow runner setup`, and `packages/web/src/runners.ts` names `agflow runner undrain` and says "It crashed three times in ten minutes", which is `CRASH_LOOP_EXITS` (`service/runs.ts`) and the default `crashLoopWindow`. No test catches a change: renaming those commands, or changing `CRASH_LOOP_EXITS` or the default `crashLoopWindow`, must update both web files.
- **For M2d and M2e (the adapters):**
  - `vendorInstallMain`, `ensurePinnedVendors` and `ensureVendorBinary` (`vendor/install.ts`) install under `AGFLOW_HOME`, while `findClaudeBinary` and `findCodexBinary` ignore that variable. For implementation and verification, use existing pins through `AGFLOW_CLAUDE_BIN` and `AGFLOW_CODEX_BIN`, or run `AGFLOW_HOME=<scratch-home> bun run vendor:install` and export `AGFLOW_CLAUDE_BIN=<scratch-home>/runner/vendor/claude/2.1.285/claude` and `AGFLOW_CODEX_BIN=<scratch-home>/runner/vendor/codex/0.159.2/bin/codex`. Remove the scratch installation after all children exit; never use an unset `AGFLOW_HOME`, the owner's runner home or a global install for verification.
  - Setup's per-vendor check (Task 22) calls each adapter's `preflight()` inside the running service, with the runner's logged-in homes from runner.json (the same strings the logins used) and the service's environment. A ready preflight prints `CLI <cliVersion>; plan <plan>`; otherwise the check fails with `facts.problem` and setup exits 1. Codex's preflight is where `codex_apps` must be absent (design 7.1 step 6).
  - The CLI passes selfCommand() unchanged to the service and adapter factory. Source launches preserve --no-env-file and --config=/dev/null before main.ts; compiled launches use the binary with no prefix args. bridgeOf supplies bridge.tools from BRIDGE_TOOL_NAMES without an M2c callback. The host calls `createAdapters(config, paths, { agflow })`.
- **Next steps:** The final-chain move and contract adaptations are complete. M2b supplies durable finalizedAt and clears resolved pushError; Task 25 consumes both and its recovery regression is enabled. No M2b contract work remains outstanding for this plan. Under AGFLOW_TEST=1 there is no launchctl call; M2g stops runners with SIGTERM. Existing G6 verification and design-update requirements remain, subject to the prohibition on real LaunchAgents and real user launchctl domains. Review design sections 7.1, 7.7, 7.8, 7.9 and the service's parts of 6.3, 6.4, 6.10, 6.16, 7.2, 12, 13, 15, 15.1 and section 14's M2c row. G6's existing checks are `AGFLOW_SANDBOX_CHECKS=1 bun test`, `bun run verify:prep` (python3 with pip 24.2 or newer) and `bun run verify:service` (Aqua session); the last cannot be run under this run's restrictions. Update the design text listed in Known behaviour 10 when the M2 plans land.
