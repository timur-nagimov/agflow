# M2e: Codex adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run Codex runner agents through the runner's own pinned `codex app-server` (design 9). The adapter gets:
- the pin, a locator for the pinned binary, and the owner's own Codex version;
- the app-server protocol types, generated from the pin and committed, with a typed method map;
- a JSON-RPC client, and one way to start app-server, with a startup lock per Codex home;
- a zero-model preflight that returns `PreflightResult` and treats managed policy fail-closed;
- thread start and resume on the attempt's CLI version, with explicit trust and the only-agflow checks;
- turn, item and status events; deliveries by steer, turn start and agflow tool output; context recovery;
- error and quota classification;
- the adapter half of approvals, and `enrichApproval` with manifest diffs (the runner core relays approvals);
- the transcript tail and thread deletion;
- `CodexAdapter`, returned by the registry's Codex entry.

For tests with zero model use, `packages/testkit` gets a scripted Responses API provider: Code Mode replies, errors, holds, rate-limit headers and `codexTestConfig`. CI tests run against a fake app-server peer and through M2b's `AttemptController`. Local suites run the real Codex 0.159.2 against the scripted provider with `AGFLOW_SMOKE=1`, and the sandbox checks with `AGFLOW_SANDBOX_CHECKS=1` (design 15). When the plan is done, `createAdapters` returns a working Codex adapter, and M2g can drive Codex agents end to end.

**Architecture:**
- **One app-server per attempt.** A session spawns `vendor/codex/<launch.cliVersion>/bin/codex app-server` in its own process group, with `CODEX_HOME` set to the runner's Codex home and `HOME` to the codex-user home, and the codex-user home as its working directory. The clone is only the thread's cwd. Preflight and transcript deletion open short-lived app-servers of the current pin through the same helper (`process.ts`).
- **Layers.** From the bottom: `binary.ts`; the generated `protocol/` and `methods.ts`; `rpc.ts`; `config.ts` and `classify.ts` (pure); `process.ts`; `policy.ts` and `preflight.ts`; `transcript.ts`; `session.ts` with the pure helpers `items.ts` and `approvals.ts`; `manifest-diff.ts`; `adapter.ts`, `index.ts` and `entry.ts` on top. All of it lives in `packages/runner/src/adapters/codex/`.
- **Fail closed.** A start or resume fails, and the process ends, when the thread does not report the expected policy, lists any MCP server but agflow, lists no agflow tools or misses a tool from `launch.bridge.tools`, loads a user or plugin skill, or raises a `configWarning`. Extra agflow tools produce a warning and are not added to the tools note. Preflight counts unknown policy as managed.
- **The adapter reports, the runner core decides.** The adapter emits `AgentEvent`s: tool activity, turns, quota, approvals and warnings. M2b's controller relays approvals, applies `allowPaidUsage`, runs continuations and quota waits, and builds the take-over commands. The adapter makes no controller, executor or shared-file edits.
- **Tests at three levels.** Unit tests with recorded 0.159.2 payloads. CI tests against `fake-app-server.ts`, a scripted JSON-RPC peer that runs as a real child process behind a `codex` shim. Local suites against the real binary and testkit's scripted provider on 127.0.0.1, behind the refusing proxy, with scratch homes.

**Tech Stack:** Bun 1.3.11 (runtime, test runner, `Bun.spawn`, `Bun.serve` for the scripted provider), TypeScript 5.9.3, zod 4.6.7, `diff` 9.0.0 (pre-declared by M2b), git 2.50, and Codex 0.159.2 (`codex app-server` and its `generate-ts`), the pin in M2b's `VENDOR_PINS`.

**Depends on:**
- Plan M2d (Claude adapter), branch `m2d-claude`, ends at `55c4dae032ad4592398e74d6fc8aa03d9fae61f8`. This plan starts from that commit. It includes M2a–M2c and M1. M2b supplies `AgentLaunch.bridge.tools`, `BRIDGE_TOOL_NAMES`, `RunnerOptions.cliVersion`, settings-sync retries and restore reconciliation, and the durable `lateWorkSha` marker. M2e uses the bridge tool contract and preserves the hardened `selfCommand` arguments; settings synchronization and late-work recovery remain in M2b. Fake-runner harnesses use `fixtureCliVersion`. The source bridge command is `bun --no-env-file --config=/dev/null <repo>/packages/cli/src/main.ts mcp --vendor codex --runner`.
- By the gates (X-47):
  - Tasks 1-6 need M2a's contracts (gate G1: `RunnerVendor`, `VendorQuota`, `Approval`, `TEST_ACCOUNT_ID`, `BRIDGE_ANSWERS`) and M2b's scaffold: `VENDOR_PINS`, `vendorBinary` and `parseVendorVersion` (`vendor/pins.ts`), `runnerPaths` (`paths.ts`), `boundedWait` and `drainToLog` (`processes.ts`), the root scripts M2b pre-declares for this plan, and the testkit package.
  - Tasks 7-20 need gate G2 (M2b Task 39): the adapter types in `adapters/types.ts`, `createAdapters` with the Codex entry stub, `RunnerConfig` with `isTestMode` and the test block, `userVariables` (`env.ts`), `runGit` and `localGitEnv`, `PermissionProfile`, and the `AttemptController` with its test fixture `packages/runner/test/fixture.ts`.
  - Tasks 21-24 need gate G4 (M2b Task 45): the bridge's runner mode (`agflow mcp --vendor codex --runner`), `packages/runner/test/hub-fixture.ts` (Task 40), and `buildAgentEnv`, `bridgeEnvOf`, `profileOf`, `writeRunDir` and `removeAgentTools`. The real-start test directly imports M2a Task 26's `handoffWritten` from `packages/hub/src/handoff.ts`.

- The local suites (Tasks 21-24) and Task 2's Generate step need the pinned binary. Task 2 passes the documented native binary explicitly, with `AGFLOW_CODEX_BIN` as an override; export that variable for the local suites (see the conventions). The root script `vendor:install` and its file `packages/runner/scripts/vendor-install.ts` (M2c Task 3) are already present in the M2d base.

**Spec:** `docs/superpowers/specs/2026-10-28-m2-runners-design.md`, revision 4: section 9 (the Codex adapter); 13 (the adapter interface and the registry); 15 and 15.1 (adapter tests, sandbox checks, test mode and the scripted servers); and the Codex parts of 5 (the sandbox boundaries), 6.1 (`RunnerVendor`, `VendorQuota`), 6.8 (facts), 6.10 (quota, approvals and what the owner sees), 7.1 (pins), 7.4 (spawning, CLI version, resume failures), 7.6 (agent environment) and 7.8 (transcripts). Section 14's M2e row gives this plan's scope. The cross-plan decisions that bind this plan are listed below with their reasons.

**How this plan was checked:**

- `tools/verify-plan.ts` rebuilt all 24 tasks from this document alone, starting at the M2d base; every task reproduced its prototype commit exactly.
- At M2e's last commit, `1b71f57d0d33cbe5ac69076cd7b505e0e90cd1a9` on `m2e-codex`, the macOS full suite passed in four parallel shards: 3592 pass, 79 skip, 0 fail. `bun run typecheck` passed.
- Linux verification ran at the top of the complete chain, M2g `84fda5c`, which includes M2e: Ubuntu non-root install, typecheck, web build and tests passed (3884 pass, 264 skip, 0 fail). Skips cover darwin-only tests and real-binary gates.
- End-to-end verification at that same chain head passed all 110 tests in 11 files with `AGFLOW_E2E=1 bun run e2e`, using pinned Claude Code 2.1.285 and Codex 0.159.2 against testkit's scripted localhost servers, with no real model use. Every scenario includes both vendor variants.
- Reviews covered task batches and fixes, followed by a cross-plan review of contracts, design coverage, sequential execution, and safety with zero model use; all 20 cross-plan findings were applied.
- Known flake: `codex/session-messages.test.ts`, “messages sent during recovery wait for the continuation and are steered into its turn”, failed once on Linux because of `delivered`/`turn_started` event ordering and passed on rerun. Watch it in CI; rerun load-sensitive failures alone.
- Local checks: `smoke:codex` and `check:codex-sandbox` require the pinned binary and macOS for G6. The sandbox suite contains 12 cases plus 5 scratch-keychain unit cases; the helper/gate checks passed with sandbox checks disabled, but a complete enabled run of these current sandbox cases is not established by the verification record.
- Coverage gaps: scripted providers cannot exercise logged-in quota reads, web search or several vendor-only errors; unit tests cover the error payloads. The scratch-home `codex_apps` check does not establish logged-in behavior (see Known behaviour and the M2c preflight coverage).
- macOS must run all clone-sweep, orphan-cleanup and hand-back security assertions; missing `lsof` is a prerequisite failure. Keep portable Linux tests enabled; darwin-only tests use `test.skipIf(process.platform !== 'darwin')` with the reason “the runner supports darwin-arm64 only; design 7.1”.

---

## Decisions

### Cross-plan decisions that bind this plan

These decisions apply across the seven M2 plans; the design's revision 4 includes their contracts.

1. **X-5 The adapter interface.** `AgentLaunch.bridge.tools` is the required readonly list of unprefixed agflow tool names for the role. M2b's `bridgeOf` selects `BRIDGE_TOOL_NAMES` from the bridge environment's `AGFLOW_ROLE`. The CLI tests compare this frozen map with `runnerToolsFor` for both roles; the runner never imports the CLI. `VendorAdapter` has `preflight`, `start`, `readTranscriptTail`, `deleteTranscript({ sessionRef, clone })` and an optional `enrichApproval`. Preflight returns `{ facts, quota, weakened }`, facts only; the runner adds models, ceilings, `allowPaidUsage` and `preflightAt`. `AgentLaunch` carries `cliVersion` and `projectConfigVerified`, and `tool_ended` has `hubUnreachable`. This plan has no `deleteSession`, take-over command or daemon stop: the runner core builds both take-over commands and stops the Codex daemon before a hand-back. (Tasks 7, 10-14, 19.) Why: M2d and M2e implement one interface in parallel, and the take-over is the same for both vendors.
2. **X-6 The adapter registry.** This plan fills M2b's stub `adapters/codex/entry.ts` and keeps its export name, `codexAdapterFactory`. It never edits `adapters/index.ts`. (Task 19.) Why: two parallel edits of one array would conflict; separate entry files cannot.
3. **X-7 Real names, no re-implementation.** The plan uses M2b's names as they are (`runnerPaths`, `runGit`, `localGitEnv`, `boundedWait`, `drainToLog`) and makes no controller or executor edits. (Task 18 and throughout.) Why: the runner core owns those seams.
4. **X-9 The approvals relay.** M2b's controller relays requests with the fence, answers `decide_approval` and voids on exit, and calls `adapter.enrichApproval` when there is one. This plan implements `enrichApproval` with manifest diffs and has no relay of its own. (Tasks 17-19.) Why: an optional adapter method needs no registry plumbing.
5. **X-10 Pins and binaries.** `CODEX_VERSION` derives from `VENDOR_PINS`. The binary is `vendor/codex/<version>/bin/codex` inside the copied package layout, through `vendorBinary`. No `CODEX_MANAGED_*` variable is set. (Tasks 1, 12, 13, 19.) Why: M2c's installer and both adapters read one table, and those variables only feed install diagnostics.
6. **X-13 Resumes use the attempt's CLI version.** One adapter resolves `vendorBinary('codex', launch.cliVersion)` per launch. The session checks the version that `initialize` reports in `userAgent`; preflight runs `--version` on the current pin. (Tasks 9, 12, 13, 19.) Why: a thread resumes in the binary that wrote it, and Codex already runs one app-server per attempt.
7. **X-14 Paid usage.** The adapter reports quota facts; M2b's turn policy applies `allowPaidUsage`. Codex's signal is a window at 100% with `credits.hasCredits` or unlimited credits. (Tasks 8, 10.) Why: one place decides for both vendors.
8. **X-17 The brief.** `developerInstructions` contains `launch.brief`, which M2b builds from `spec.brief` plus the working-directory line, followed by two newlines and `codexToolsNote(launch.bridge.tools)`. (Tasks 7, 12, 13.) Why: the hub does not know the clone path.
9. **X-19 Bridge answers.** A terminal tool counts only on a normal result. A failed agflow call whose text is core's `BRIDGE_ANSWERS.hubUnreachable` sets `hubUnreachable`. No text matching on "submitted at" or "submission pending". (Task 14.) Why: every bridge refusal is an MCP error result, and the runner must tell an outage from a refusal.
10. **X-20 Testkit and test gates.** `startRefusingProxy` comes from M2b's testkit. Both scripted servers expose `{ url, requests, setHandler(fn) }`, parsed requests, reply builders and a harmless default answer. M2g uses the exact names `startResponsesServer`, `codexTestConfig` (testkit) and `findCodexBinary` (runner). Locators look at `AGFLOW_CODEX_BIN`, then `~/.agflow/runner/vendor/codex/<version>`. `AGFLOW_SMOKE=1` gates the real-binary suites, `AGFLOW_SANDBOX_CHECKS=1` the sandbox checks. (Tasks 1, 3, 4, 21-24.) Why: M2d, M2e and M2g share one copy, and CI never needs a vendor binary.
11. **X-21 Test-mode account identity.** With `skipAuthChecks`, preflight reports ready, problem "test mode", plan "test mode" and core's `TEST_ACCOUNT_ID`. (Task 10.) Why: per-account quota and owner away work in tests. Plan-local addition: only the account checks are waived. `account/read` is not sent, and preflight reports problem "test mode", plan "test mode" and `TEST_ACCOUNT_ID`, ready unless the policy, MCP or skills checks find a problem; quota is still read. Why: test mode must not hide a managed policy or a loaded MCP server or skill.
12. **X-26 The shared hub fixture.** The local suites use M2b's `startTestHub`, `addRunnerAttempt` and `mintAgentToken`, and run the bridge as `bun --no-env-file --config=/dev/null <repo>/packages/cli/src/main.ts` by path. (Task 21.) Why: one in-process hub for every runner-side suite, and no package cycle.
13. **X-31 Codex adapter choices.** `approvalsReviewer` is always `user`, and any other answer fails the start; preflight is not ready when requirements exclude `user`. Trust is always explicit: `trusted` when `projectConfigVerified`, else `untrusted` with a warning, never a failed start. A decline with a reason steers one system note into the turn. A permissions approval grants exactly the requested profile for the turn; elicitations are always declined. `serverRequest/resolved` voids only unanswered requests. On the first `contextWindowExceeded` the adapter compacts and continues; on the second it ends the turn with `errorKind` `context`. A provider 401 counts as `auth`. Preflight requires an empty `mcpServerStatus/list` and no user or plugin skills. (Tasks 7, 8, 10, 12, 13, 15, 17.) Why: each closes a question the design left open, in the direction that keeps a person in charge.
14. **X-32 The bridge environment.** `launch.bridge.env` holds every bridge variable, and `env_vars` is exactly `Object.keys(launch.bridge.env)`. (Task 7.) Why: Codex forwards only the named variables to an MCP server; Task 21 confirmed it on the real binary.
15. **X-44 Shared files.** M2b pre-declares the root scripts `gen:codex-protocol`, `smoke:codex` and `check:codex-sandbox` and the `diff` dependency. This plan edits only its own directories and its registry entry, and exports through `adapters/codex/index.ts`. (Tasks 2, 18.) Why: parallel plans would conflict on shared files.

**X-47 Gates and order.** Tasks 1–6 require G1 and their listed M2b scaffold; Tasks 7–20 require G2; Tasks 21–24 require G4. G6 additionally requires passing macOS real-binary and sandbox checks. This plan uses the completed M2d base named under Depends on. Why: each task must start only after its providers exist.

### Refinements of the design

These refinements specify behavior that the design leaves open or words loosely.

**Binary and protocol**
1. **`CODEX_VERSION` is the one Codex version in `VENDOR_PINS`;** if two platforms ever pinned different versions it throws (Task 1). Why: the committed protocol matches exactly one version.
2. **`findCodexBinary` ignores `AGFLOW_HOME`** and looks under `<home>/.agflow`, with the home injectable; an empty `AGFLOW_CODEX_BIN` counts as unset (Task 1). Why: test harnesses point `AGFLOW_HOME` at scratch directories, and X-20 names `~/.agflow`.
3. **`codexBinaryVersion` runs `--version` with scratch `CODEX_HOME` and `HOME`** (or given homes), in its own process group, within 10 s and a 64 KB read, and SIGKILLs the group afterwards (Task 1). Why: Codex writes into its homes even for `--version`, and `~/.codex` must stay untouched.
4. **`ownerCodexVersion` accepts only the `@openai/codex` npm wrapper** and runs only the native binary it resolves; any other `codex` on `PATH` gives null (Task 1). Why: another install could start Node.
5. **The protocol is plain `generate-ts` output** (no `--experimental`): 734 files plus `VERSION`. The generator refuses a binary at another version, runs with scratch homes and an environment of only `PATH` and `LANG`, writes into a staging directory, and never replaces a non-empty directory without `VERSION` (Task 2). Why: the output is deterministic and typechecks under the strict tsconfig, and a wrong `--out` must not delete anything.
6. **`methods.ts` keeps a hand-written result map** (`CodexResults`), checked both ways at the type level, plus `satisfies` on each method list and a runtime check against the generated files (Task 2). Why: the generated code has no method-to-result map.

**Scripted provider**
7. **The raw-JavaScript builder is `reply.code`, not `reply.exec`** (Task 3). Why: this repository's security hook refuses any file in which `exec` is directly followed by an opening parenthesis; M2g uses `reply.code` too.
8. **`ResponsesRequest.instructions` is the developer messages after Codex's base prompt,** leaving out blocks that start with `<`; `threadId` comes from the `thread-id` header, then `session-id`, then `client_metadata`; `lastUserText` skips Codex's own context messages (Task 3). Why: 0.159.2 sends no top-level `instructions`.
9. **`reply.shell` holds one `exec` call through a long command:** a `// @exec` yield pragma of `timeoutMs + 5000`, `exec_command` with a yield of at most 30 s, then empty `write_stdin` polls until exit or `timeoutMs` (Task 3). Why: `exec_command` yields after at most 30 s; it supports a 45 s command within one call.
10. **Item and call ids are generated each time a reply streams** (Task 3). Why: a rule's static reply may answer many requests.
11. **Compaction requests get `DEFAULT_COMPACTION_SUMMARY`, are not flagged unmatched, and `rules()` skips them** unless a rule sets `compaction: true` (Task 4). Why: they are auxiliary requests, and a marker rule must not answer one with a tool call.
12. **`codexTestConfig` sets retries to 0** and a stream idle timeout (Codex's own 300 s by default), and its type is declared in testkit (Task 4). Why: a scripted failure must reach the adapter at once, and the testkit's codex entry imports nothing from the runner.

**JSON-RPC and the fake peer**
13. **An oversized line is answered at once:** the client reads the id from its first 4,096 bytes, answers a server request -32603 and rejects a pending request naming the cap (Task 5). Why: otherwise the request waits out its timeout.
14. **Shims are hard links to one canonical script,** and the fake finds its own scenario from the kernel's launch path (`sysctl KERN_PROCARGS2` through `bun:ffi`), falling back to `argv[1]` off macOS (Tasks 6, 9). Why: macOS executable scanning can add about half a second to a new executable's first run, and Bun resolves `argv[1]` to the link target.
15. **The fake is as strict as 0.159.2** (requests before `initialize` get -32600 'Not initialized'; a missing `CODEX_HOME` exits 1 with the real two lines), and a request's scripted notifications go out right after its answer, before the answer to any later request (Task 6). Why: Tasks 12-17 rely on that order.

**Launch configuration**
16. **`test.codexConfig` reaches Codex as `-c` flags,** one per top-level key, rendered by `tomlInline`; a key that is not a TOML bare key throws (Task 7). Why: no Codex home's `config.toml` is ever written (design 15.1), and `-c` splits keys on dots.
17. **app-server gets `GIT_DIR=/dev/null`,** and `shell_environment_policy` excludes `AGFLOW_*` and `GIT_DIR` (Task 7). Why: Codex's own git calls (at thread start, and `git status` for each turn's metadata) run outside the sandbox and read the agent-writable `.git/config`, so a planted filter driver would run unsandboxed. Task 24 shows it on the real binary.
18. **The bridge's MCP server runs in the codex-user home** (`mcp_servers.agflow.cwd`, a required argument of `threadOverrides`) (Tasks 7, 12). Why: Codex starts stdio MCP servers in the thread's cwd, the clone, and Bun auto-loads a `bunfig.toml` (its `preload` runs code) and a `.env` from there, outside the sandbox and with the agent token. Task 21 plants both and checks that nothing runs.
19. **The tools note is part of developerInstructions.** `threadOverrides` sends `launch.brief`, two newlines and `codexToolsNote(launch.bridge.tools)` on `thread/start` and `thread/resume`. `codexToolsNote` adds the `mcp__agflow__` prefix and explains calls through `tools.mcp__agflow__<name>` inside `exec`. The first turn contains only `launch.firstPrompt`; resume sends no prompt. The never-ran fallback uses the same overrides and first-prompt rule. Why: Code Mode defers MCP tools, so the agent needs their names, and developerInstructions retain the note across compaction. M2b's per-launch tool contract supplies the names without a runner-to-CLI import.
20. **`threadOverrides` resolves the clone once, with `realpath`,** and uses it for `cwd`, the `projects` key, `writable_roots` (`<clone>/.git`) and the tool `HOME` (`<clone>/.agflow/run/home`); `TMPDIR` is `launch.tmpDir` as M2b gives it, where design 9.2 writes `${clone}/.agflow/run/tmp` (Task 7). Why: on macOS `/var` is `/private/var`, and a writable root or trust key under the unresolved path would not match the thread's cwd.

**Classification**
21. **A provider 401 counts as `auth` on both `httpConnectionFailed` and `responseStreamConnectionFailed`.** The string variants map through a table checked with `satisfies` against `CodexErrorInfo`, and unknown values at run time (a string or a one-key object) are `vendor` (Task 8). Why: both variants carry the provider's HTTP status, and a re-pin that adds a variant must fail the typecheck.
22. **A set `rateLimitReachedType` turns only `vendor` failures into `quota`,** and `activeTurnNotSteerable` is never a turn error (Task 8). Why: an auth or context failure must keep its kind.
23. **`mergeRateLimits` keeps the windows and credits a sparse update leaves null, and ignores updates for a `limitId` other than null or `codex`** (Task 8). Why: Codex sends sparse updates, and other limits are not the account's.
24. **`quotaFromRateLimits` maps windows by length** (300 min to `fiveHour`, 10,080 to `weekly`, else by position), counts a window whose reset has passed as empty, and takes `resetsAt` from the full window (the later one when both are full), else from the most used one (Task 8). Why: X-22's limiting window, with Codex's epoch-second resets.
25. **All-null rate-limit updates report no quota** (Task 14). Why: a failed stream sends them, and they would read as "unknown".

**Process**
26. **The startup lock is in-process, keyed by the resolved `CODEX_HOME`,** and held until `initialize` answers; the one retry after 'failed to initialize sqlite state runtime' runs only for an open without `onSpawn` (Task 9). Why: two starts at once on a fresh home can race during sqlite initialization, and a registered launch records exactly one process (X-50). So a session start that loses the race rejects, and M2b reports `attempt.failed_to_start` (see Known behaviour 4 for what the hub does next). Preflight and deletion keep the retry.
27. **An early exit is explained by the first stderr line that starts with `Error:`,** else the first non-empty line (Task 9). Why: 0.159.2 writes a WARNING line before its error.
28. **A spawn ENOENT reads 'binary missing' only when the binary is gone,** else `working directory missing: <cwd>` (Task 9). Why: Bun gives the same error for a removed working directory.
29. **The group is SIGKILLed once right after the leader's exit,** and every wait for pipes is bounded (Task 9). Why: a command that inherited app-server's pipes must not outlive it or hang the end.

**Preflight**
30. **Problem order: policy, then account, then MCP servers, then skills;** the first problem wins (Task 10).
31. **Managed policy fails closed:** an unknown layer type, `layers: null` or a failed read counts as managed. A failed read is not a readiness problem on its own (Task 10). Why: design 9.1 counts unknown as managed.
32. **A managed layer that sets `web_search` to anything but `disabled` makes the vendor not ready** ('managed policy turns on web search') (Task 10). Why: it outranks the thread's override, and no later check would see it.
33. **`allowedApprovalsReviewers` is read through a local extension type** (Task 10). Why: 0.159.2 sends it, but the generated `ConfigRequirements` lacks it.
34. **Only skills with scope `user` or a plugin id fail;** system, admin and repo skills pass (Tasks 10, 12). Why: a scratch home lists five system skills, and repo skills are instructions like `AGENTS.md`.
35. **`codexProcessOptions` is the one derivation** of the Codex homes, the base environment (runner.json's captured `PATH`, its connectivity variables and M2b's `userVariables`) and the test switches (only under `isTestMode`), for preflight, deletion and the adapter (Tasks 10, 11, 19). Why: one environment and one test-mode gate.
36. **`ordinaryUsageAllowed: false` is the backend's word:** paid usage in use when there are credits, else exhausted (Task 10). Preflight quota is null when `account/rateLimits/read` fails, and `weakened` is always empty. Why: design 9.1 names no weakened item, and section 5's partial read confinement holds on every runner.
37. **`ownerCliVersion` is reported on every path,** also when the platform is unsupported or the binary missing (Task 10).
38. **A failed inventory is a readiness problem, and no usable binary means no app-server.** A failed `mcpServerStatus/list` or `skills/list` gives 'could not check MCP servers' or 'could not check skills'. An unsupported platform, or a pinned binary that is missing, at another version or whose version cannot be read, gives not ready with `managedPolicy` true, and no app-server is opened (Task 10). Why: an unchecked inventory cannot show that nothing loads, and without an app-server there is no policy to read, which counts as managed.

**Transcripts**
39. **The tail is the assistant text of the last three turns that have any,** split at `task_started`, cut from the front without splitting a surrogate pair; the rollout file is matched by its exact id (Task 11). Why: the format of the fake adapter's tail, and a sessionRef never becomes part of a path.
40. **Deletion uses a short-lived app-server of the current pin,** and -32600 'no rollout found' counts as deleted (Task 11). Why: deletion works while another app-server runs on the home, and a second delete gives that answer.

**Sessions**
41. **app-server runs in the codex-user home, not the clone** (Task 12). Why: started in a clone holding `.codex/`, 0.159.2 sends a startup `configWarning` ("Project-local config, hooks, and exec policies are disabled ... until the project is trusted"), which failed every such start.
42. **The only-agflow check asks `mcpServerStatus/list { threadId }`, and also fails on any `mcpServer/startupStatus/updated` for another server** (Task 12). An answer with a non-null `nextCursor` fails the start too ('incomplete MCP server inventory'). Why: `{}` lists nothing after `thread/start`, and the list leaves out servers that are still starting or failed; a trusted project's server can be absent from it (Task 24). An incomplete inventory cannot show that agflow is alone.
43. **Start and resume verify the required agflow tools against the live listing.** An empty listing or any missing name from `launch.bridge.tools` fails before a prompt is sent. Listing order does not matter. Extra names produce a warning, while developerInstructions still name only the launch's tools. Worker and lead inventories are covered by the fake-peer tests. Why: the persistent note must not promise a tool the bridge cannot serve.
44. **A `configWarning` anywhere from the open until the checks end fails the start** (Task 12). Why: it can arrive before the `thread/start` answer.
45. **The untrusted warning says that skills still load** (Task 12). Why: an untrusted thread skips the project's config, hooks and exec policies, but still loads `<clone>/.codex/skills`.
46. **The account id is read once, after the checks** (`account/read { refreshToken: false }`), and every quota event carries it; with `skipAuthChecks` it is `TEST_ACCOUNT_ID` and no request is sent; a failed read gives null and never fails the start (Task 14).
47. **A resume passes `excludeTurns: true`,** neither renames the thread nor prompts, and only -32600 'no rollout found' falls back to a fresh thread in the same process (Task 13).
48. **Notifications and server requests that arrive before `started` are buffered** in arrival order and delivered after it; if the start fails, the buffered requests are declined (Tasks 14, 17). `toolCalls` counts the main turn's tools plus child-thread tools started while it runs. A completed tool item that never started gets its `tool_started` first.
49. **Shell unwrapping accepts only `<...sh> -c|-lc '<script>'`,** with shlex's POSIX quoting (Task 14). Why: `python3 -c '...'` is not a shell wrapper.
50. **A `fileChange`'s tool input is `<path>\n<diff>` for each change** (Task 14). Why: design 6.8's loop detection compares names and arguments.
51. **Open tools end with their turn.** When a turn completes, every tool still open in it gets `tool_ended { ok: false, denied: false, terminal: null, hubUnreachable: false }`: on the main thread the tools counted for that turn, on a child thread that thread's tools of that turn. Late completions of those tools are not reported (Task 14). Why: after `turn/interrupt` with a pending command approval, Codex completes the turn but never the command, and M2b's stall facts would keep that tool in flight.
52. **A quota failure without a known reset asks `account/rateLimits/read`** before it reports the exhausted quota and `turn_ended` (Task 14). Why: the runner's quota wait needs the reset.
53. **The compaction turn is identified positively:** the first new main-thread turn after `thread/compact/start` while no `turn/start` of ours is unanswered, never a turn id our `turn/start` answered (Task 15). Why: `thread/compact/start` answers `{}` with no turn id.
54. **A compaction turn that does not complete ends like any turn** (interrupted, or classified by its error); `context` is only for a second overflow, a rejected `thread/compact/start` whose turn never started, and a rejected continuation (Task 15). Why: a quota or auth failure during compaction must keep its kind.
55. **Context recovery runs once per session.** It starts on the final error's `contextWindowExceeded` or, with no final error, on the failed turn's own error. `compacted` comes only from a main-thread `contextCompaction` item, and `thread/compacted` is ignored. The continuation's text is 'System note: The context window filled up and was compacted. Continue your task where you left off.' The tools of the hidden turns are reported; they count toward the `toolCalls` of a failed recovery's `turn_ended`, not toward a successful continuation's (Task 15). Why: design 9.2 acts on the final error or on a failed `turn/completed`, a child thread's compaction is not the session's, and the stall facts must not count a hidden turn's tools as continuation progress.
56. **Recovery is exclusive** (Task 16): from the failed turn's end until the continuation's `turn/start` answers, nothing is started or steered; messages wait and are then steered into the continuation. An interrupt in any recovery window ends it as `interrupted` with no continuation. Why: two `turn/start`s must never be in flight at once.
57. **Only two steer refusals are retried, and one holds.** -32600 'expected active turn id ...' or 'no active turn to steer' is retried through `turn/start`, and only -32600 with `data.codexErrorInfo.activeTurnNotSteerable` holds the message. Any other steer error, another -32600 included, rejects that send with 'codex turn/steer failed: ...', and the next send still runs (Task 16). Why: these are the supported retryable refusals, and retrying an unknown refusal could start a turn nobody asked for.
58. **A held send stays pending until it goes out** (Task 16). Why: `delivered` then means delivered, so a deliver command waits through a compaction turn.
59. **`interrupt({ cancelQueued: true })` cancels by generation:** held and queued sends reject with 'codex send cancelled', later sends go through (Task 16). Why: the handoff prompt follows the interrupt.

**Approvals and manifest diffs**
60. **A decline note is steered into the asking request's own thread and turn,** on the send chain and with no delivery id; if that turn has ended, the note is dropped with a warning, never a new turn (Task 17). Why: a note must not start work on its own.
61. **Approval details are clipped** to 64 KiB of UTF-8 with a '[truncated: N bytes in total]' marker, summaries to one line of 500 characters, and the permissions JSON appears once, in `detail.reason` (Task 17). Why: an approval event must fit the outbox.
62. **A permission profile with unknown fields is declined** with a warning (Task 17). Why: approving it could grant more than the owner saw.
63. **Manifests include the other managers' files** (`pyproject.toml`, `requirements.txt`, `poetry.lock`, `uv.lock`, `Pipfile(.lock)`, `Cargo.toml/.lock`, `go.mod/.sum`), every `.yarnrc*` name, and a pip command's `-r`/`-c` files inside the clone (Task 18). Why: a recognised command whose manifests are not compared would read as "unchanged".
64. **Big files are hashed, not diffed:** over 256 KiB a file is summarised by size and compared by blob id up to 64 MiB; links and binaries get one-line summaries; the whole text is capped at 64 KiB (Task 18). Why: an unchanged big lockfile must not show up on every approval.

**Adapter and tests**
65. **`CodexAdapter.start` creates both Codex homes (0700)** (Task 19). Why: the codex-user home is app-server's cwd, and the controller may start an attempt with no earlier preflight (checked by Task 20).
66. **The adapter resolves its options once,** from `{ config, paths, env }`; the entry passes `{ config, paths }`, so `process.env` is read when the registry builds it (Task 19).
67. **The local harness proves trust with a non-default setting:** the origin commits `.codex/config.toml` with `model_reasoning_effort = "high"`, so a trusted thread sends `high` and an untrusted one `low` (Task 21). Why: `low` is the default, so a non-default setting distinguishes trusted and untrusted threads.
68. **The tool surface is recorded as described and available names** in `tool-surface.json` (Task 21). Why: the agflow tools are deferred; any change across pins shows up.
69. **A never-ran thread is made by opening the pinned app-server directly** and running only `thread/start` (Task 22). Why: a session killed during its first turn still leaves a rollout.
70. **Every negative sandbox check has an unsandboxed control,** and proxies are bypassed with `env -i` (Task 24). Why: a failure inside must come from the sandbox, not the environment.
71. **The sandbox checks use disposable resources** (Task 24). All sandbox probes use scratch paths. Create a disposable keychain under a scratch HOME and pass its explicit path to both controls and sandboxed lookups. Require lookup success outside the sandbox and refusal inside it, then remove the keychain in finally. Never use the owner's HOME, login keychain or keychain search list. Use a scratch directory outside the clone for the forbidden-write target. Preserve successful unsandboxed controls, sandboxed refusal and secret-leak assertions; do not weaken policy if a check fails.

72. **The bridge timeout covers its polling budget.** `mcp_servers.agflow.tool_timeout_sec` is `ceil(pollMaxMs / 1000) + 30`. `pollMaxMs` comes from `launch.bridge.env.AGFLOW_BRIDGE_POLL_MAX_MS` using Number conversion and the bridge's positive-integer rule, with 180000 ms as the fallback. The default is 210 seconds; 1000 ms gives 31 seconds and 1001 ms gives 32 seconds. Why: submit and prepare_dependencies can hold a call for three minutes plus the final GET.
73. **The sandbox gate test uses an isolated locator.** `sandboxCodexBinary(options: FindCodexOptions = {})` requires `options.env.AGFLOW_SANDBOX_CHECKS === '1'` (`process.env` by default), then forwards env and home to `findCodexBinary`. A runnable stub prints the pinned version; an empty scratch home prevents an owner-install fallback. The test covers enabled plus stub, disabled, unset, and enabled without a binary. Why: removing the gate must make the test fail.

### Known behaviour and open points

2. **The tools note survives compaction with the static brief.** It is supplied in developerInstructions from `launch.bridge.tools` at start and resume; the first user message carries only `launch.firstPrompt`. The live MCP listing checks the required names before any prompt is sent.
3. **A trusted project's MCP servers still run before the check refuses the thread.** Codex starts every configured server, outside the sandbox, before the only-agflow check can fail the start. Trusting a project's `.codex/` means trusting its commands, which only a verified `.codex/` may have.
4. **The startup lock covers one runner process.** Separate processes on one fresh home can still race (M2g's live run shares one logged-in home across three runners; a person's take-over). They rely on the home being initialized and on the one retry. The first start after a pin upgrade is the likeliest moment. A session start that loses the race rejects (refinement 26), and M2b's controller does not retry it: it reports `attempt.failed_to_start` (infra), the hub starts a new attempt after `infraBackoffMs`, and two such failures in a row on one runner mark Codex not ready in `vendor_holds` until a later preflight passes. Three infra endings of a task with the same failure signature send it to re-planning (design 6.9).
5. **What the scripted provider cannot produce.** `account/rateLimits/read` needs a ChatGPT login, so the local suites cover quota only through the `x-codex-*` headers and `account/rateLimits/updated`. A custom provider cannot produce `unauthorized`, `cyberPolicy`, `misalignmentPolicyViolation`, `tooManyDenials` or `sessionBudgetExceeded` (a provider 401 arrives as `httpConnectionFailed`, a 400 `context_length_exceeded` as `other`); unit tests cover them with synthetic payloads. Web search cannot be exercised either.
6. **MDM.** The recorded macOS environment has managed Codex (a `legacyManagedConfigTomlFromMdm` layer that sets only analytics and feedback). Real preflight always reports `managedPolicy` true, even with a scratch home, so the unmanaged sample is synthesised. MDM allows `read-only` and `workspace-write` sandboxes and the web-search modes `cached` and `disabled`. The recorded policy blocked or changed none of the checks. Never change approval or sandbox policy to get around it; a check that MDM blocks must say so.
7. CI runs the unit and fake-peer tests. The real-binary suites require `smoke:codex` and `check:codex-sandbox` on macOS for gate G6. Keep portable cases enabled on Linux. macOS must execute every clone-sweep, orphan-cleanup and hand-back security assertion; missing `lsof` fails with a prerequisite diagnostic. Never omit safety assertions or return early because `lsof` is missing on macOS. The current verification results and Linux event-order flake are listed under How this plan was checked.
8. **M2b dependencies are present through the M2d base.** `selfCommand` uses `--no-env-file` and `--config=/dev/null` from source; `build:cli` disables compiled bunfig and dotenv autoloading. The Codex bridge preserves those arguments and starts in the codex-user home. Transcript clipping, refusal of unforwardable approvals, `fixtureCliVersion`, settings-sync recovery and the durable late-work marker are already in the base.
9. **Load.** A few tests are load-sensitive (the concurrent-shim test starts 12 shims; process and session tests use short timeouts). Under load a slow test may time out in a full run: rerun the file alone before concluding anything.
10. **Design text to update when the plans land:**
    - 9.1 / 9.2: Codex's own git calls run outside the sandbox and read the agent-writable `.git/config`, so app-server gets `GIT_DIR=/dev/null` (refinement 17).
    - 9.1: preflight also refuses a managed `web_search` (refinement 32).
    - 9.2 Trust and X-31: an untrusted thread still loads `<clone>/.codex/skills`; only project config, hooks and exec policies are skipped (refinement 45).
    - 9.2: stdio MCP servers start in the thread's cwd unless given one; the bridge's cwd is the codex-user home, never the clone (refinement 18).
    - 9.2 / X-31: `mcpServerStatus/list` omits servers that are still starting or failed; the start also refuses on a startup status for another server; trusting a project's `.codex/` means trusting its commands (refinement 42, open point 3).
    - 9.2 / 10 / 15.1: Code Mode defers MCP tools; developerInstructions contain `launch.brief` plus `codexToolsNote(launch.bridge.tools)`, with prefixed names and the exec call syntax. The first prompt contains only `launch.firstPrompt`. Start and resume reject missing required tools; extra tools warn.
    - 9.2: `mcp_servers.agflow` uses `launch.bridge.command` and `launch.bridge.args` unchanged, cwd set to the codex-user home, and `tool_timeout_sec = ceil(pollMaxMs / 1000) + 30`; pollMaxMs uses the bridge's positive-integer environment rule and defaults to 180000 ms.
    - 15: `web_search: 'disabled'` is checked only through the absence of a `configWarning`; the keychain check uses an explicit disposable-keychain path under a scratch HOME for both controls and sandboxed lookups (refinement 71).
    - 15.1 and X-21: `skipAuthChecks` waives only the account checks; the policy, MCP and skills checks still apply, and quota is still read (decision 11).

## Conventions for every task

- The plan targets macOS on Apple silicon (darwin-arm64), where it was checked. `VENDOR_PINS` pins Codex only for darwin-arm64.
- Start on a new branch from `55c4dae032ad4592398e74d6fc8aa03d9fae61f8`, the M2d head on `m2d-claude`, and run `bun install --frozen-lockfile` once. No task changes a dependency.
- Tasks 6 and 20–24 add tests and helpers that pass against the preceding implementation, so they use check-only steps. Other tasks record the expected failure before implementation; error paths are relative to the repository root (Bun prints absolute paths). Task 2 generates its protocol files instead of embedding them in code blocks.
- A `(new)` block is the whole file. A `(change)` block is a unified diff: save it to a file and run `git apply <file>` from the repository root. Apply the blocks in the order shown, step 1's test files and then step 3's code, and the tasks in order. Files under `test/` folders (fixtures and helpers included) come with step 1.
- Run all commands from the repository root. Use Bun only.
- Edit only this plan's files: `packages/runner/src/adapters/codex/`, `packages/runner/scripts/gen-codex-protocol.ts`, `packages/runner/test/codex/`, `packages/testkit/src/codex/` and `packages/testkit/test/codex/`, plus M2b's stub `adapters/codex/entry.ts`. Never edit M2a's or M2b's files (`packages/core`, `packages/hub`, the rest of `packages/runner`, `packages/cli`, the testkit files M2b owns). If a contract is missing or wrong, stop and report it.
- No file under `packages/runner/src` or `packages/runner/test/codex` imports `packages/cli`: the CLI depends on the runner, never the reverse. The local suites run the bridge by path.
- Never edit `protocol/` by hand. After a re-pin, run `bun run gen:codex-protocol` and fix whatever `methods.ts` and the adapter no longer typecheck against.
- **The pinned binary.** Task 2's Generate step and the local suites of Tasks 21-24 need native Codex 0.159.2 inside its npm package layout, so that `codex-code-mode-host` sits beside it and `rg` in the layout's `codex-path/`. Set `AGFLOW_CODEX_BIN` before Task 2's Generate step as well as before the local suites. For implementation and verification, use existing pinned executables through `AGFLOW_CLAUDE_BIN` and `AGFLOW_CODEX_BIN`, or install into a newly created scratch directory using `AGFLOW_HOME=<scratch-home> bun run vendor:install`. Then explicitly set `AGFLOW_CLAUDE_BIN=<scratch-home>/runner/vendor/claude/2.1.285/claude` and `AGFLOW_CODEX_BIN=<scratch-home>/runner/vendor/codex/0.159.2/bin/codex`; the locators do not follow AGFLOW_HOME. Remove the scratch installation after all children exit. Do not run the installer without a scratch AGFLOW_HOME or install globally during implementation or verification. `findCodexBinary` keeps a candidate only when its `--version` is the pin.

For verification, install into a scratch directory and explicitly select both binaries. The test locators do not search AGFLOW_HOME.

```bash
AGFLOW_REVIEW_HOME=$(mktemp -d /tmp/agflow-vendors.XXXXXX)
AGFLOW_HOME="$AGFLOW_REVIEW_HOME" bun run vendor:install
export AGFLOW_CLAUDE_BIN="$AGFLOW_REVIEW_HOME/runner/vendor/claude/2.1.285/claude"
export AGFLOW_CODEX_BIN="$AGFLOW_REVIEW_HOME/runner/vendor/codex/0.159.2/bin/codex"
```

Keep this directory until verification finishes, then remove it. Wait for all children to exit before removal.
- **The local suites** skip without `AGFLOW_SMOKE=1` (the sandbox checks without `AGFLOW_SANDBOX_CHECKS=1`) or without a located pin, so check that their pass line counts passes, not skips. The real Codex there talks only to testkit's scripted provider on 127.0.0.1, behind the refusing proxy, with scratch `CODEX_HOME`, `HOME` and `AGFLOW_HOME`. No test or script sends a prompt to a real model or uses the owner's credentials, keychain logins, `~/.codex`, `~/.claude` or `~/.agflow` (the locator only reads the vendor directory). All sandbox probes use scratch paths. Create a disposable keychain under a scratch HOME and pass its explicit path to both controls and sandboxed lookups. Require lookup success outside the sandbox and refusal inside it, then remove the keychain in finally. Never use the owner's HOME, login keychain or keychain search list. Use a scratch directory outside the clone for the forbidden-write target. Preserve successful unsandboxed controls, sandboxed refusal and secret-leak assertions; do not weaken policy if a check fails.
- The recorded macOS MDM policy allows only the `read-only` and `workspace-write` sandboxes. Never change approval or sandbox policy, and never bypass MDM; if MDM blocks or changes a check, make the check report that clearly.
- Every child's stdout is read and its stderr drained with a bound, and every wait after an exit is bounded: Bun buffers unread pipes without limit.
- Tests that write stub binaries create each stub once and link it into place: macOS executable scanning can add about half a second to the first run.
- Tests driving the fake peer create `CODEX_HOME` and send `initialize` first, and assert the recorded environment with `toEqual` (it is exact, `GIT_DIR: '/dev/null'` included).
- House style is Prettier 3.6.2 with `--print-width 120 --single-quote --trailing-comma all`. A security hook refuses files whose text looks like shell execution (the word `exec` directly followed by a parenthesis); the code here never calls a regex's `exec` method.
- Never run tests through git (no `rebase --exec`, no hooks), and never export `GIT_DIR`, `GIT_WORK_TREE` or `GIT_INDEX_FILE`. `scripts/test-preload.ts` drops `GIT_*` variables for `bun test`.
- Every task ends with `bun test && bun run typecheck` green. Allow ten to fifteen minutes for the whole suite, longer under load; a slow test may time out under load, so rerun the file alone before you debug it, and never loosen a test to make it pass.
- Commit at the end of each task with the message shown and the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` as a second `-m`. The repository's git identity is preconfigured; do not change it.

## File structure

```
packages/runner/scripts/gen-codex-protocol.ts   regenerates protocol/ from the pinned binary (gen:codex-protocol)
packages/runner/src/adapters/codex/
  binary.ts                                    CODEX_VERSION, codexBinaryVersion, findCodexBinary, ownerCodexVersion
  protocol/                                    generated app-server types for 0.159.2, with VERSION (never edited)
  methods.ts                                   the methods the adapter uses, checked against protocol/; ParamsOf, ResultOf
  rpc.ts                                       CodexRpc, RpcError, RpcClosed, RpcTimeout: JSON-RPC over app-server's stdio
  config.ts                                    appServerArgs, appServerEnv, threadOverrides, tomlInline, codexToolsNote
  classify.ts                                  turnErrorKind, isFinalError, mergeRateLimits, quotaFromRateLimits
  process.ts                                   openAppServer: spawn, initialize, the startup lock, end()
  policy.ts                                    classifyCodexPolicy, codexAccountIdentity
  preflight.ts                                 codexProcessOptions, runCodexPreflight
  transcript.ts                                readCodexTranscriptTail, deleteCodexTranscript
  session.ts                                   CodexSession: start checks, resume, events, recovery, messages, approvals
  items.ts                                     codexToolStarted, codexToolEnded, agflowTerminal
  approvals.ts                                 approvalFromRequest, decisionResponse, unattendedResponse, clipText
  manifest-diff.ts                             isPackageManagerCommand, manifestDiff, codexEnrichApproval
  adapter.ts                                   CodexAdapter, createCodexAdapter, codexAdapterOptions
  index.ts                                     the Codex adapter's exports
  entry.ts                                     codexAdapterFactory (M2b's stub, filled)
packages/runner/test/codex/
  binary.test.ts, protocol.test.ts, rpc.test.ts      the pin, the protocol and the JSON-RPC client
  fake-app-server.ts                           the scripted app-server peer that every codex shim runs
  peer.ts                                      codexScenario, writeCodexShim, readCodexRecord, codexMessages (0.159.2 shapes)
  probe-messages.json                          0.159.2 messages recorded in the probes, which codexMessages reproduces
  peer.test.ts                                 the fake peer
  config.test.ts, classify.test.ts             launch configuration, error and quota classification
  fixtures/recorded-notifications.json         0.159.2 errors and rate limits recorded against the scripted provider
  process.test.ts                              app-server spawning and the startup lock
  fixtures/requirements-managed.json           this Mac's managed requirements and config layers
  policy.test.ts, preflight.test.ts            managed policy, account identity and preflight
  fixtures/rollout.jsonl                       a real 0.159.2 rollout (four turns)
  transcript.test.ts                           the transcript tail and deletion
  session-fixture.ts                           the session tests' shared setup (sessionFixture, mcp, skills, firstInput, until)
  session-start.test.ts, session-resume.test.ts, session-events.test.ts, session-context.test.ts,
  session-messages.test.ts, approvals.test.ts  CodexSession
  manifest-diff.test.ts, adapter.test.ts       manifest diffs, the adapter and the registry entry
  controller-contract.test.ts                  M2b's AttemptController driving the adapter
  fixtures/tool-surface.json                   the pinned slug's Code Mode tool surface
  real/harness.ts                              startCodexHarness, EventLog, smokeCodexBinary (local suites)
  real/start.test.ts, real/lifecycle.test.ts, real/errors.test.ts
                                               the real binary against the scripted provider (AGFLOW_SMOKE=1)
  real/sandbox.test.ts                         the Codex sandbox checks (AGFLOW_SANDBOX_CHECKS=1)
packages/testkit/src/codex/
  request.ts                                   ResponsesRequest parsing, toolSurface, COMPACTION_PROMPT_PREFIX
  replies.ts                                   reply builders (text, code, shell, mcp, patch, failures, hang), rateLimitHeaders
  responses-server.ts                          startResponsesServer, ResponsesServer, rules
  test-config.ts                               codexTestConfig, CodexTestConfig
  index.ts                                     the entry consumers import (@agflow/testkit/src/codex/index)
packages/testkit/test/codex/
  responses-server.test.ts, failures.test.ts   the scripted provider
```

---

### Task 1: Codex pin, binary locator and owner version

`binary.ts` takes `CODEX_VERSION` from M2b's `VENDOR_PINS`, so the pin lives in one place (design 9.1, 7.1, X-10). `codexBinaryVersion` runs `<bin> --version` in its own process group, with scratch `CODEX_HOME` and `HOME`, a time bound and a capped read, and parses the output with M2b's `parseVendorVersion`. `findCodexBinary` is the pinned-binary locator for tests and M2g (design 15, X-20): `AGFLOW_CODEX_BIN`, then `~/.agflow/runner/vendor/codex/<pin>/bin/codex`, keeping a candidate only when it reports the pin. `ownerCodexVersion` gives `RunnerVendor.ownerCliVersion` (design 6.1): it resolves the `@openai/codex` npm wrapper on `PATH` to the native binary beside it and never runs Node.

**Files:**
- Create: `packages/runner/src/adapters/codex/binary.ts`
- Test: `packages/runner/test/codex/binary.test.ts`

- [ ] **Step 1: Write the failing test**

**File:** `packages/runner/test/codex/binary.test.ts` (new)

```ts
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  CODEX_VERSION,
  codexBinaryVersion,
  findCodexBinary,
  ownerCodexVersion,
} from '../../src/adapters/codex/binary';
import { VENDOR_PINS } from '../../src/vendor/pins';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agflow-codex-binary-'));
  dirs.push(dir);
  return dir;
}

/** An executable shell script at path; the parent directories are created. */
function script(path: string, body: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

function mkdirp(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

// macOS scans every new executable on its first run, which costs over half a second, so each version's stub is
// written once and linked wherever a test needs it.
const stubs = mkdtempSync(join(tmpdir(), 'agflow-codex-stubs-'));
afterAll(() => rmSync(stubs, { recursive: true, force: true }));

/** A link at path to a binary that prints `codex-cli <version>`. */
function versionStub(path: string, version: string): string {
  const target = join(stubs, version);
  if (!existsSync(target)) script(target, `echo "codex-cli ${version}"`);
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(target, path);
  return path;
}

describe('CODEX_VERSION', () => {
  test('is the Codex version of VENDOR_PINS', () => {
    expect(CODEX_VERSION).toBe('0.159.2');
    expect(CODEX_VERSION).toBe(VENDOR_PINS['darwin-arm64']?.codex.version as string);
  });
});

describe('codexBinaryVersion', () => {
  test('parses the version a binary prints', async () => {
    const dir = tempDir();
    expect(await codexBinaryVersion(versionStub(join(dir, 'codex'), '0.159.2'))).toBe('0.159.2');
    expect(await codexBinaryVersion(versionStub(join(dir, 'older'), '0.150.0'))).toBe('0.150.0');
  });

  test('passes --version and nothing else', async () => {
    const dir = tempDir();
    const bin = script(join(dir, 'codex'), `[ "$*" = "--version" ] && echo "codex-cli 0.159.2"`);
    expect(await codexBinaryVersion(bin)).toBe('0.159.2');
  });

  test('gives null for a missing, non-executable, slow or failing binary and for other output', async () => {
    const dir = tempDir();
    expect(await codexBinaryVersion(join(dir, 'missing'))).toBeNull();
    const plain = join(dir, 'plain');
    writeFileSync(plain, '#!/bin/sh\necho "codex-cli 0.159.2"\n');
    expect(await codexBinaryVersion(plain)).toBeNull();
    const started = Date.now();
    const slow = script(join(dir, 'slow'), 'sleep 5; echo "codex-cli 0.159.2"');
    expect(await codexBinaryVersion(slow, { timeoutMs: 200 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(await codexBinaryVersion(script(join(dir, 'fails'), 'echo "codex-cli 0.159.2"; exit 1'))).toBeNull();
    expect(await codexBinaryVersion(script(join(dir, 'other'), 'echo "2.1.285 (Claude Code)"'))).toBeNull();
    expect(await codexBinaryVersion(dir)).toBeNull();
  });

  // Codex writes $CODEX_HOME/tmp/arg0 even for --version, and falls back to ~/.codex without CODEX_HOME.
  test('runs with a throwaway CODEX_HOME and HOME that exist during the run and are removed afterwards', async () => {
    const dir = tempDir();
    const record = join(dir, 'record');
    const bin = script(
      join(dir, 'codex'),
      `[ -d "$CODEX_HOME" ] && [ -d "$HOME" ] && echo "$CODEX_HOME|$HOME" > "${record}"; echo "codex-cli 0.159.2"`,
    );
    expect(await codexBinaryVersion(bin)).toBe('0.159.2');
    const [codexHome, home] = readFileSync(record, 'utf8').trim().split('|') as [string, string];
    for (const value of [codexHome, home]) {
      expect(value).not.toBe(homedir());
      expect(value).not.toStartWith(join(homedir(), '.codex'));
      expect(value).not.toBe(process.env.CODEX_HOME ?? '');
      expect(existsSync(value)).toBe(false);
    }
  });

  test('runs with the homes it is given and leaves them in place', async () => {
    const dir = tempDir();
    const record = join(dir, 'record');
    const bin = script(join(dir, 'codex'), `echo "$CODEX_HOME|$HOME" > "${record}"; echo "codex-cli 0.159.2"`);
    const homes = { codex: mkdirp(join(dir, 'codex-home')), user: mkdirp(join(dir, 'codex-user')) };
    expect(await codexBinaryVersion(bin, { homes })).toBe('0.159.2');
    expect(readFileSync(record, 'utf8').trim()).toBe(`${homes.codex}|${homes.user}`);
    expect(existsSync(homes.codex) && existsSync(homes.user)).toBe(true);
  });

  test('bounds the wait for the output: a helper holding stdout is killed with the group', async () => {
    const dir = tempDir();
    const pidFile = join(dir, 'helper.pid');
    const bin = script(join(dir, 'codex'), `sleep 8 & echo $! > "${pidFile}"; echo "codex-cli 0.159.2"`);
    // The bound leaves room for macOS's first-run scan of the new script.
    const started = Date.now();
    expect(await codexBinaryVersion(bin, { timeoutMs: 2_000 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(5_000);
    const helper = Number(readFileSync(pidFile, 'utf8').trim());
    await Bun.sleep(50);
    expect(() => process.kill(helper, 0)).toThrow();
  }, 15_000);

  test('bounds the output it keeps: endless output gives null without growing memory', async () => {
    const dir = tempDir();
    const bin = script(join(dir, 'codex'), 'exec yes "codex-cli 0.159.2"');
    const before = process.memoryUsage().rss;
    const started = Date.now();
    expect(await codexBinaryVersion(bin, { timeoutMs: 2_000 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(process.memoryUsage().rss - before).toBeLessThan(256 * 1024 * 1024);
  }, 15_000);
});

describe('findCodexBinary', () => {
  test('takes AGFLOW_CODEX_BIN first', async () => {
    const dir = tempDir();
    const home = join(dir, 'home');
    const fromEnv = versionStub(join(dir, 'env', 'codex'), CODEX_VERSION);
    versionStub(join(home, '.agflow', 'runner', 'vendor', 'codex', CODEX_VERSION, 'bin', 'codex'), CODEX_VERSION);
    expect(await findCodexBinary({ env: { AGFLOW_CODEX_BIN: fromEnv }, home })).toBe(fromEnv);
  });

  test("then the runner's vendor directory under ~/.agflow", async () => {
    const dir = tempDir();
    const home = join(dir, 'home');
    const vendored = versionStub(
      join(home, '.agflow', 'runner', 'vendor', 'codex', CODEX_VERSION, 'bin', 'codex'),
      CODEX_VERSION,
    );
    expect(await findCodexBinary({ env: {}, home })).toBe(vendored);
    expect(await findCodexBinary({ env: { AGFLOW_CODEX_BIN: '' }, home })).toBe(vendored);
  });

  test('skips a candidate at another version or one that does not run', async () => {
    const dir = tempDir();
    const home = join(dir, 'home');
    const other = versionStub(join(dir, 'env', 'codex'), '0.150.0');
    const vendored = versionStub(
      join(home, '.agflow', 'runner', 'vendor', 'codex', CODEX_VERSION, 'bin', 'codex'),
      CODEX_VERSION,
    );
    expect(await findCodexBinary({ env: { AGFLOW_CODEX_BIN: other }, home })).toBe(vendored);
    expect(await findCodexBinary({ env: { AGFLOW_CODEX_BIN: join(dir, 'missing') }, home })).toBe(vendored);
  });

  test('gives null when no candidate is the pin', async () => {
    const dir = tempDir();
    const home = join(dir, 'home');
    versionStub(join(home, '.agflow', 'runner', 'vendor', 'codex', CODEX_VERSION, 'bin', 'codex'), '0.150.0');
    const other = versionStub(join(dir, 'codex'), '0.1.0');
    expect(await findCodexBinary({ env: { AGFLOW_CODEX_BIN: other }, home })).toBeNull();
    expect(await findCodexBinary({ env: {}, home: join(dir, 'empty') })).toBeNull();
  });
});

describe('ownerCodexVersion', () => {
  /**
   * A global npm install: <prefix>/bin/codex links to the @openai/codex wrapper, which must never run (it is Node),
   * and the platform package holds the native binary.
   */
  function npmInstall(dir: string, options: { layout?: 'nested' | 'hoisted' | 'bundled'; version?: string } = {}) {
    const prefix = join(dir, 'prefix');
    const wrapperPackage = join(prefix, 'lib', 'node_modules', '@openai', 'codex');
    const marker = join(dir, 'wrapper-ran');
    writeFileSync(join(mkdirp(wrapperPackage), 'package.json'), JSON.stringify({ name: '@openai/codex' }));
    const wrapper = script(join(wrapperPackage, 'bin', 'codex.js'), `touch "${marker}"; echo "codex-cli 9.9.9"`);
    symlinkSync(wrapper, join(mkdirp(join(prefix, 'bin')), 'codex'));
    const layout = options.layout ?? 'nested';
    // The wrapper's own fallback, without a platform package, is a vendor directory inside its package.
    const platformPackage =
      layout === 'bundled'
        ? wrapperPackage
        : join(layout === 'hoisted' ? join(prefix, 'lib') : wrapperPackage, 'node_modules/@openai/codex-darwin-arm64');
    if (layout !== 'bundled') {
      writeFileSync(
        join(mkdirp(platformPackage), 'package.json'),
        JSON.stringify({ name: '@openai/codex-darwin-arm64', version: '0.150.0-darwin-arm64' }),
      );
    }
    const native = versionStub(
      join(platformPackage, 'vendor', 'aarch64-apple-darwin', 'bin', 'codex'),
      options.version ?? '0.150.0',
    );
    return { bin: join(prefix, 'bin'), marker, native };
  }

  const darwin = { platform: 'darwin', arch: 'arm64' };

  test("resolves the npm wrapper to its platform package's native binary without running the wrapper", async () => {
    const dir = tempDir();
    const install = npmInstall(dir);
    expect(await ownerCodexVersion({ env: { PATH: `${install.bin}:/usr/bin:/bin` }, ...darwin })).toBe('0.150.0');
    expect(existsSync(install.marker)).toBe(false);
  });

  test('finds a platform package hoisted next to the wrapper package, or the vendor directory inside it', async () => {
    const dir = tempDir();
    const hoisted = npmInstall(join(dir, 'hoisted'), { layout: 'hoisted', version: '0.158.0' });
    expect(await ownerCodexVersion({ env: { PATH: hoisted.bin }, ...darwin })).toBe('0.158.0');
    expect(existsSync(hoisted.marker)).toBe(false);
    const bundled = npmInstall(join(dir, 'bundled'), { layout: 'bundled', version: '0.157.0' });
    expect(await ownerCodexVersion({ env: { PATH: bundled.bin }, ...darwin })).toBe('0.157.0');
    expect(existsSync(bundled.marker)).toBe(false);
  });

  test('gives null without codex on PATH, without the platform binary, or for an unknown executable', async () => {
    const dir = tempDir();
    expect(await ownerCodexVersion({ env: { PATH: join(dir, 'nothing') }, ...darwin })).toBeNull();
    const install = npmInstall(join(dir, 'npm'));
    expect(await ownerCodexVersion({ env: { PATH: install.bin }, platform: 'linux', arch: 'x64' })).toBeNull();
    rmSync(install.native);
    expect(await ownerCodexVersion({ env: { PATH: install.bin }, ...darwin })).toBeNull();
    expect(existsSync(install.marker)).toBe(false);
    // A script that is not the npm wrapper could be anything, Node included, so it is never run.
    const other = join(dir, 'other');
    const marker = join(dir, 'other-ran');
    script(join(other, 'codex'), `touch "${marker}"; echo "codex-cli 0.159.2"`);
    expect(await ownerCodexVersion({ env: { PATH: other }, ...darwin })).toBeNull();
    expect(existsSync(marker)).toBe(false);
  });

  // An `npm link` of a source checkout: the wrapper's real directory has no node_modules ancestor, where a module
  // resolver would fall back to Bun's auto-install and fetch the platform package from the registry.
  test('looks for the platform package on disk only, never through a registry', async () => {
    const dir = realpathSync(tempDir());
    const checkout = join(dir, 'checkout', 'codex-cli');
    writeFileSync(join(mkdirp(checkout), 'package.json'), JSON.stringify({ name: '@openai/codex' }));
    const marker = join(dir, 'wrapper-ran');
    const wrapper = script(join(checkout, 'bin', 'codex.js'), `touch "${marker}"; echo "codex-cli 9.9.9"`);
    symlinkSync(wrapper, join(mkdirp(join(dir, 'prefix', 'bin')), 'codex'));
    const requests: string[] = [];
    const registry = Bun.serve({
      port: 0,
      fetch(request) {
        requests.push(new URL(request.url).pathname);
        return new Response('not found', { status: 404 });
      },
    });
    try {
      const source = join(import.meta.dir, '..', '..', 'src', 'adapters', 'codex', 'binary.ts');
      const program = [
        `const { ownerCodexVersion } = await import(${JSON.stringify(source)});`,
        `const version = await ownerCodexVersion({ env: { PATH: ${JSON.stringify(join(dir, 'prefix', 'bin'))} },`,
        `  platform: 'darwin', arch: 'arm64' });`,
        'console.log(JSON.stringify(version));',
      ].join('\n');
      const proc = Bun.spawn([process.execPath, '-e', program], {
        cwd: dir,
        env: { ...process.env, BUN_CONFIG_REGISTRY: registry.url.href, BUN_INSTALL_CACHE_DIR: join(dir, 'cache') },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      expect({ code: await proc.exited, stdout: stdout.trim(), stderr }).toEqual({ code: 0, stdout: 'null', stderr: '' });
    } finally {
      registry.stop(true);
    }
    expect(requests).toEqual([]);
    expect(existsSync(marker)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `bun test packages/runner/test/codex/binary.test.ts`
Expected: FAIL — `error: Cannot find module '../../src/adapters/codex/binary' from 'packages/runner/test/codex/binary.test.ts'` (0 pass, 1 fail, 1 error)

- [ ] **Step 3: Implement**

**File:** `packages/runner/src/adapters/codex/binary.ts` (new)

```ts
// Codex binaries (design 9.1, 15): the pinned version, the `--version` reader, the locator tests and M2g use for the
// pin, and the owner's own install, whose version RunnerVendor.ownerCliVersion reports.
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { boundedWait } from '../../processes';
import { runnerPaths } from '../../paths';
import { parseVendorVersion, VENDOR_PINS, vendorBinary } from '../../vendor/pins';

type Env = Record<string, string | undefined>;

/** The one Codex version of VENDOR_PINS; the committed protocol types are generated from it. */
export const CODEX_VERSION: string = pinnedCodexVersion();

function pinnedCodexVersion(): string {
  const versions = new Set(Object.values(VENDOR_PINS).map((pins) => pins?.codex.version));
  const [version] = versions;
  if (versions.size !== 1 || version === undefined) {
    throw new Error(`VENDOR_PINS must pin one Codex version, not ${JSON.stringify([...versions])}`);
  }
  return version;
}

const VERSION_TIMEOUT_MS = 10_000;

/** `--version` prints one short line; more output than this is not a version, and is not buffered. */
const MAX_VERSION_OUTPUT_BYTES = 64 * 1024;

export interface CodexVersionOptions {
  timeoutMs?: number;
  /** The CODEX_HOME and HOME to run with, such as the runner's own (design 9.1); a throwaway directory by default. */
  homes?: { codex: string; user: string };
}

/**
 * Runs `<bin> --version` in its own process group and parses the output with parseVendorVersion. The exit and the
 * output share one deadline, after which the group is killed. Null for a missing, non-executable, slow or failing
 * binary and for any other output.
 */
export async function codexBinaryVersion(bin: string, options: CodexVersionOptions = {}): Promise<string | null> {
  // Codex writes $CODEX_HOME/tmp/arg0 even for --version, and falls back to ~/.codex without CODEX_HOME, so it never
  // runs with the caller's homes. The directory must exist, or Codex warns that it could not create its aliases.
  const scratch = options.homes ? null : mkdtempSync(join(tmpdir(), 'agflow-codex-version-'));
  const homes = options.homes ?? { codex: scratch as string, user: scratch as string };
  try {
    let proc: ReturnType<typeof Bun.spawn<'ignore', 'pipe', 'ignore'>>;
    try {
      proc = Bun.spawn([bin, '--version'], {
        env: { ...process.env, CODEX_HOME: homes.codex, HOME: homes.user },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'ignore',
        detached: true,
      });
    } catch {
      return null;
    }
    const output = boundedText(proc.stdout, MAX_VERSION_OUTPUT_BYTES);
    const run = await boundedWait(Promise.all([proc.exited, output.text]), options.timeoutMs ?? VERSION_TIMEOUT_MS);
    // Whatever is left in the group, a helper holding the pipe included, goes with it.
    try {
      process.kill(-proc.pid, 'SIGKILL');
    } catch {
      // The group is already gone.
    }
    output.cancel();
    if (!run.done) return null;
    const [code, text] = run.value;
    return code === 0 && text !== null ? parseVendorVersion('codex', text) : null;
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}

/** Reads a stream as text, or null once it holds more than limit bytes or fails; cancel() stops the read. */
function boundedText(stream: ReadableStream<Uint8Array>, limit: number) {
  const reader = stream.getReader();
  const read = async (): Promise<string | null> => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks).toString('utf8');
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  };
  return {
    text: read().catch(() => null),
    cancel: () => {
      reader.cancel().catch(() => {});
    },
  };
}

export interface FindCodexOptions {
  env?: Env;
  /** The home whose ~/.agflow holds the runner's vendor directory; the user's home by default. */
  home?: string;
}

/**
 * The pinned binary for tests (design 15, X-20): AGFLOW_CODEX_BIN, then the runner's vendor directory under
 * ~/.agflow, which `bun run vendor:install` fills. A candidate counts only when its --version is the pin.
 */
export async function findCodexBinary(options: FindCodexOptions = {}): Promise<string | null> {
  const env = options.env ?? process.env;
  const candidates = [
    env.AGFLOW_CODEX_BIN,
    join(runnerPaths(join(options.home ?? homedir(), '.agflow')).runner, vendorBinary('codex', CODEX_VERSION)),
  ];
  for (const candidate of candidates) {
    if (candidate && (await codexBinaryVersion(candidate)) === CODEX_VERSION) return candidate;
  }
  return null;
}

/** The Rust target triples of @openai/codex's platform packages, as its wrapper maps them. */
const TARGET_TRIPLES: Record<string, string> = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'linux-arm64': 'aarch64-unknown-linux-musl',
  'linux-x64': 'x86_64-unknown-linux-musl',
};

export interface OwnerCodexOptions {
  env?: Env;
  platform?: string;
  arch?: string;
}

/**
 * The version of the owner's own `codex` on PATH. That is @openai/codex's Node wrapper, which is never run: it is
 * resolved, as the wrapper itself does, to the native binary of its platform package, and only that binary runs.
 * Anything else on PATH gives null, since it could be a script that starts Node.
 */
export async function ownerCodexVersion(options: OwnerCodexOptions = {}): Promise<string | null> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const triple = TARGET_TRIPLES[`${platform}-${arch}`];
  const found = Bun.which('codex', { PATH: env.PATH ?? '' });
  if (!triple || !found) return null;
  const wrapper = realpathSync(found);
  const packageRoot = dirname(dirname(wrapper));
  if (basename(wrapper) !== 'codex.js' || packageName(packageRoot) !== '@openai/codex') return null;
  const platformPackage = `@openai/codex-${platform}-${arch}`;
  const vendorRoots = [platformVendorRoot(platformPackage, dirname(wrapper)), join(packageRoot, 'vendor')];
  const native = vendorRoots
    .filter((root): root is string => root !== null)
    .map((root) => join(root, triple, 'bin', 'codex'))
    .find((path) => existsSync(path));
  return native ? codexBinaryVersion(native) : null;
}

function packageName(root: string): string | null {
  try {
    const { name } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name?: unknown };
    return typeof name === 'string' ? name : null;
  } catch {
    return null;
  }
}

/**
 * The vendor directory of the platform package that Node's lookup finds from the wrapper's directory: the first
 * <dir>/node_modules/<name> on the way up. The disk is all it reads; a module resolver could fall back to Bun's
 * auto-install, fetch the package from a registry and so run a downloaded binary.
 */
function platformVendorRoot(name: string, from: string): string | null {
  for (let dir = from; ; dir = dirname(dir)) {
    if (basename(dir) !== 'node_modules' && existsSync(join(dir, 'node_modules', name, 'package.json'))) {
      return join(dir, 'node_modules', name, 'vendor');
    }
    if (dirname(dir) === dir) return null;
  }
}
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `bun test packages/runner/test/codex/binary.test.ts && bun test && bun run typecheck`
Expected: the task's tests pass (16 pass); then the whole suite passes (`0 fail`) and `tsc` exits 0.

The tests build each version stub once and link it into place: macOS executable scanning can add about 0.6 s to the first run. `findCodexBinary` ignores `AGFLOW_HOME`, because test harnesses point it at scratch directories; an empty `AGFLOW_CODEX_BIN` counts as unset. `ownerCodexVersion` supports only the npm wrapper's layouts (nested, hoisted or bundled vendor); any other `codex` on `PATH` gives null, because it could start Node.

- [ ] **Step 5: Commit**

```bash
git add -A 'packages/runner/src/adapters/codex/binary.ts' 'packages/runner/test/codex/binary.test.ts'
git commit -m 'M2E Task 1: Codex pin, binary locator and owner version' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

### Task 2: Generated app-server protocol and typed method map

The pinned binary generates the app-server's TypeScript bindings with `codex app-server generate-ts` (design 9.1, 13): 734 files plus `VERSION`, about 3 MB, byte-identical across runs and clean under the repository's strict tsconfig. They are committed, and this plan adds them with a Generate step instead of code blocks. `scripts/gen-codex-protocol.ts`, behind M2b's pre-declared root script `gen:codex-protocol` (X-44), refuses a binary at another version and runs the generator with scratch homes. `methods.ts` lists the client methods, server requests and notifications the adapter uses; each list is checked against the generated unions, and a hand-written result map is checked both ways, so a re-pin that renames or drops a method breaks the typecheck. The Generate step passes `--bin` explicitly: `AGFLOW_CODEX_BIN` when nonempty, otherwise the documented macOS native npm binary path. It works in a clean checkout without an inherited export or a runner installation; on another machine, set `AGFLOW_CODEX_BIN` to its pinned native binary.

**Files:**
- Create: `packages/runner/scripts/gen-codex-protocol.ts`
- Create: `packages/runner/src/adapters/codex/methods.ts`
- Test: `packages/runner/test/codex/protocol.test.ts`
- Generate: `packages/runner/src/adapters/codex/protocol/**` (with `bun run gen:codex-protocol --bin "${AGFLOW_CODEX_BIN:-/usr/local/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex}"`)

- [ ] **Step 1: Write the failing test**

**File:** `packages/runner/test/codex/protocol.test.ts` (new)

```ts
import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { CODEX_VERSION, findCodexBinary } from '../../src/adapters/codex/binary';
import {
  CodexClientMethods,
  CodexNotificationMethods,
  CodexServerRequestMethods,
  type ParamsOf,
  type ResultOf,
} from '../../src/adapters/codex/methods';

const runner = join(import.meta.dir, '..', '..');
const protocol = join(runner, 'src', 'adapters', 'codex', 'protocol');
const generator = join(runner, 'scripts', 'gen-codex-protocol.ts');
// The regeneration check needs the pinned binary and runs only in the local suites (X-20).
const pinned = process.env.AGFLOW_SMOKE === '1' ? await findCodexBinary() : null;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agflow-codex-protocol-'));
  dirs.push(dir);
  return dir;
}

/** The method names of a generated union, read from its file. */
function unionMethods(file: string): string[] {
  const source = readFileSync(join(protocol, file), 'utf8');
  return [...source.matchAll(/"method": "([^"]+)"/g)].map((match) => match[1] as string);
}

/** Every file under dir, relative to it, sorted. */
function files(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1))
    .sort();
}

/** Runs the generator; an undefined env value removes that variable. */
async function generate(args: string[], env: Record<string, string | undefined> = {}, cwd?: string) {
  const proc = Bun.spawn([process.execPath, generator, ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

describe('the committed protocol', () => {
  test('was generated by the pinned version', () => {
    expect(readFileSync(join(protocol, 'VERSION'), 'utf8')).toBe(`${CODEX_VERSION}\n`);
  });

  test('holds the generated unions and their index', () => {
    for (const file of ['ClientRequest.ts', 'ServerRequest.ts', 'ServerNotification.ts', 'index.ts', 'v2/index.ts']) {
      expect(readFileSync(join(protocol, file), 'utf8')).toStartWith('// GENERATED CODE! DO NOT MODIFY BY HAND!');
    }
  });
});

describe('the method map', () => {
  test('lists the client methods the adapter calls', () => {
    expect([...CodexClientMethods]).toEqual([
      'initialize',
      'account/read',
      'account/rateLimits/read',
      'configRequirements/read',
      'config/read',
      'mcpServerStatus/list',
      'skills/list',
      'thread/start',
      'thread/resume',
      'thread/name/set',
      'thread/compact/start',
      'thread/delete',
      'turn/start',
      'turn/steer',
      'turn/interrupt',
    ]);
  });

  test('lists the server requests that section 9.3 answers', () => {
    expect([...CodexServerRequestMethods]).toEqual([
      'item/commandExecution/requestApproval',
      'item/fileChange/requestApproval',
      'item/permissions/requestApproval',
      'item/tool/requestUserInput',
      'mcpServer/elicitation/request',
    ]);
  });

  test('every method is a member of its generated union', () => {
    const client = unionMethods('ClientRequest.ts');
    const server = unionMethods('ServerRequest.ts');
    const notifications = unionMethods('ServerNotification.ts');
    expect(client).toContain('thread/start');
    expect(client.filter((method) => (CodexClientMethods as readonly string[]).includes(method)).sort()).toEqual(
      [...CodexClientMethods].sort(),
    );
    expect(server.filter((method) => (CodexServerRequestMethods as readonly string[]).includes(method)).sort()).toEqual(
      [...CodexServerRequestMethods].sort(),
    );
    expect(
      notifications.filter((method) => (CodexNotificationMethods as readonly string[]).includes(method)).sort(),
    ).toEqual([...CodexNotificationMethods].sort());
    expect(new Set(CodexNotificationMethods).size).toBe(CodexNotificationMethods.length);
    expect(CodexNotificationMethods).toContain('turn/completed');
    expect(CodexNotificationMethods).toContain('serverRequest/resolved');
    expect(CodexNotificationMethods).toContain('account/rateLimits/updated');
  });

  test('ParamsOf and ResultOf give the generated types', () => {
    const params: ParamsOf<'thread/delete'> = { threadId: 'thread-1' };
    const result: ResultOf<'item/fileChange/requestApproval'> = { decision: 'accept' };
    const notification: ParamsOf<'serverRequest/resolved'> = { threadId: 'thread-1', requestId: 7 };
    expect([params.threadId, result.decision, notification.requestId]).toEqual(['thread-1', 'accept', 7]);
  });
});

describe('gen-codex-protocol', () => {
  /**
   * A stand-in codex that prints a version and, for generate-ts, writes what it was given into its output. Each
   * --version run appends its HOME and CODEX_HOME to <dir>/version-env.txt.
   */
  function stubCodex(dir: string, version: string): string {
    const bin = join(dir, 'bin', 'codex');
    mkdirSync(join(dir, 'bin'), { recursive: true });
    writeFileSync(
      bin,
      [
        '#!/bin/sh',
        'if [ "$1" = "--version" ]; then',
        `  printf "%s|%s\\n" "$HOME" "$CODEX_HOME" >> "${join(dir, 'version-env.txt')}"`,
        `  echo "codex-cli ${version}"; exit 0`,
        'fi',
        'out="$4"',
        'mkdir -p "$out/v2"',
        'printf "%s\\n" "$*" > "$out/args.txt"',
        'printf "HOME=%s\\nCODEX_HOME=%s\\n" "$HOME" "$CODEX_HOME" > "$out/env.txt"',
        'printf "export type X = 1;\\n" > "$out/v2/X.ts"',
        '',
      ].join('\n'),
    );
    chmodSync(bin, 0o755);
    return bin;
  }

  test('generates into the output directory with scratch homes, never ~/.codex', async () => {
    const dir = tempDir();
    const out = join(dir, 'out');
    mkdirSync(out);
    // An earlier generation, replaced as a whole.
    writeFileSync(join(out, 'VERSION'), '0.150.0\n');
    writeFileSync(join(out, 'Stale.ts'), 'export type Stale = 1;\n');
    const result = await generate(['--bin', stubCodex(dir, CODEX_VERSION), '--out', out]);
    expect(result).toMatchObject({ code: 0 });
    expect(files(out)).toEqual(['VERSION', 'args.txt', 'env.txt', 'v2/X.ts']);
    expect(readFileSync(join(out, 'VERSION'), 'utf8')).toBe(`${CODEX_VERSION}\n`);
    const args = readFileSync(join(out, 'args.txt'), 'utf8').trim().split(' ');
    expect(args.slice(0, 3)).toEqual(['app-server', 'generate-ts', '--out']);
    expect(args).toHaveLength(4);
    const env = Object.fromEntries(
      readFileSync(join(out, 'env.txt'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => line.split('=') as [string, string]),
    );
    for (const value of [env.HOME, env.CODEX_HOME]) {
      expect(value).toStartWith(realpathSync(tmpdir()));
      expect(value).not.toBe(homedir());
      expect(value).not.toStartWith(join(homedir(), '.codex'));
      // The scratch homes are removed afterwards.
      expect(existsSync(value as string)).toBe(false);
    }
    expect(env.HOME).not.toBe(env.CODEX_HOME);
    // The version check, too, runs with throwaway homes.
    const checks = readFileSync(join(dir, 'version-env.txt'), 'utf8').trim().split('\n');
    expect(checks).toHaveLength(1);
    for (const value of (checks[0] as string).split('|')) {
      expect(value).toContain(join(tmpdir(), 'agflow-codex-version-'));
      expect(value).not.toStartWith(join(homedir(), '.codex'));
      expect(existsSync(value)).toBe(false);
    }
  });

  test('resolves a relative --bin and --out against its working directory', async () => {
    const dir = tempDir();
    stubCodex(dir, CODEX_VERSION);
    const result = await generate(['--bin', './bin/codex', '--out', 'out'], {}, dir);
    expect(result).toMatchObject({ code: 0 });
    expect(files(join(dir, 'out'))).toEqual(['VERSION', 'args.txt', 'env.txt', 'v2/X.ts']);
  });

  test('refuses to replace a non-empty output directory that holds no VERSION', async () => {
    const dir = tempDir();
    const out = join(dir, 'src');
    mkdirSync(out);
    writeFileSync(join(out, 'index.ts'), 'export {};\n');
    const result = await generate(['--bin', stubCodex(dir, CODEX_VERSION), '--out', out]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('not a protocol directory');
    expect(files(out)).toEqual(['index.ts']);
    // An empty directory may be filled.
    const empty = join(dir, 'empty');
    mkdirSync(empty);
    expect(await generate(['--bin', join(dir, 'bin', 'codex'), '--out', empty])).toMatchObject({ code: 0 });
  });

  test('refuses a binary at another version and leaves the output alone', async () => {
    const dir = tempDir();
    const out = join(dir, 'out');
    const result = await generate(['--bin', stubCodex(dir, '0.150.0'), '--out', out]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(`expected ${CODEX_VERSION}`);
    expect(existsSync(out)).toBe(false);
  });

  test('without --bin and without a located pin it names the ways to get one', async () => {
    const dir = tempDir();
    const out = join(dir, 'out');
    const result = await generate(['--out', out], { HOME: join(dir, 'home'), AGFLOW_CODEX_BIN: '' });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('AGFLOW_CODEX_BIN');
    expect(result.stderr).toContain('vendor:install');
    expect(existsSync(out)).toBe(false);
  });

  test.skipIf(pinned === null)('the pinned binary regenerates the committed files byte for byte', async () => {
    const dir = tempDir();
    const out = join(dir, 'protocol');
    // Located through AGFLOW_CODEX_BIN, as the root script does, under a home that must stay empty: Codex writes
    // $CODEX_HOME/tmp/arg0, or ~/.codex/tmp/arg0, even for --version.
    const home = join(dir, 'home');
    mkdirSync(home);
    const result = await generate(['--out', out], {
      HOME: home,
      CODEX_HOME: undefined,
      AGFLOW_CODEX_BIN: pinned as string,
    });
    expect(result).toMatchObject({ code: 0 });
    expect(readdirSync(home)).toEqual([]);
    const committed = files(protocol);
    expect(files(out)).toEqual(committed);
    for (const file of committed) {
      expect({ file, same: readFileSync(join(out, file)).equals(readFileSync(join(protocol, file))) }).toEqual({
        file,
        same: true,
      });
    }
  }, 120_000);
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `bun test packages/runner/test/codex/protocol.test.ts`
Expected: FAIL — `error: Cannot find module '../../src/adapters/codex/methods' from 'packages/runner/test/codex/protocol.test.ts'` (0 pass, 1 fail, 1 error)

- [ ] **Step 3: Implement**

**File:** `packages/runner/scripts/gen-codex-protocol.ts` (new)

```ts
// Regenerates the committed app-server protocol types from the pinned Codex (design 9.1): `bun run gen:codex-protocol`
// after a re-pin, then fix whatever methods.ts and the adapter no longer typecheck against.
//
//   --bin <codex>  the binary to generate with; by default findCodexBinary's (AGFLOW_CODEX_BIN or the runner's vendor
//                  directory). It must print the pinned version.
//   --out <dir>    replaced by the generated files; packages/runner/src/adapters/codex/protocol by default. A
//                  non-empty directory without a VERSION file is not a protocol directory and is never replaced.
//
// The version check and the generator run with scratch HOME and CODEX_HOME directories, so they never read or write
// ~/.codex.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { CODEX_VERSION, codexBinaryVersion, findCodexBinary } from '../src/adapters/codex/binary';

const GENERATE_TIMEOUT_MS = 120_000;

const { values } = parseArgs({
  options: { bin: { type: 'string' }, out: { type: 'string' } },
  strict: true,
});
// Resolved here, since generate-ts runs in a scratch directory.
const out = resolve(values.out ?? join(import.meta.dir, '..', 'src', 'adapters', 'codex', 'protocol'));

function fail(message: string): never {
  console.error(`gen-codex-protocol: ${message}`);
  process.exit(1);
}

if (existsSync(out) && readdirSync(out).length > 0 && !existsSync(join(out, 'VERSION'))) {
  fail(`${out} is not a protocol directory (it has files but no VERSION), so it is not replaced`);
}
const bin = values.bin === undefined ? await findCodexBinary() : resolve(values.bin);
if (!bin) {
  fail(`no codex ${CODEX_VERSION} found: set AGFLOW_CODEX_BIN or run \`bun run vendor:install\``);
}
const version = await codexBinaryVersion(bin);
if (version !== CODEX_VERSION) {
  fail(`${bin} is codex ${version ?? 'of an unreadable version'}, expected ${CODEX_VERSION}`);
}

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'agflow-codex-gen-')));
let failure: string | null = null;
try {
  const home = join(scratch, 'home');
  const codexHome = join(scratch, 'codex-home');
  const staging = join(scratch, 'protocol');
  mkdirSync(home);
  mkdirSync(codexHome);
  const proc = Bun.spawn([bin, 'app-server', 'generate-ts', '--out', staging], {
    cwd: scratch,
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, CODEX_HOME: codexHome, LANG: 'en_US.UTF-8' },
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit',
    timeout: GENERATE_TIMEOUT_MS,
  });
  const code = await proc.exited;
  if (code !== 0 || !existsSync(staging)) {
    failure = `codex app-server generate-ts failed (exit ${code})`;
  } else {
    writeFileSync(join(staging, 'VERSION'), `${CODEX_VERSION}\n`);
    rmSync(out, { recursive: true, force: true });
    cpSync(staging, out, { recursive: true });
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
if (failure) fail(failure);
console.log(`gen-codex-protocol: wrote the codex ${CODEX_VERSION} protocol to ${out}`);
```

**File:** `packages/runner/src/adapters/codex/methods.ts` (new)

```ts
// The app-server methods the adapter uses (design 9.1), each checked against the protocol generated from the pin: a
// re-pin that renames or drops one fails the typecheck. The generated code has no method-to-result map, so
// CodexResults pairs every client method and server request with its generated response type.
import type { ClientRequest, InitializeResponse, ServerNotification, ServerRequest } from './protocol';
import type {
  CommandExecutionRequestApprovalResponse,
  ConfigReadResponse,
  ConfigRequirementsReadResponse,
  FileChangeRequestApprovalResponse,
  GetAccountRateLimitsResponse,
  GetAccountResponse,
  ListMcpServerStatusResponse,
  McpServerElicitationRequestResponse,
  PermissionsRequestApprovalResponse,
  SkillsListResponse,
  ThreadCompactStartResponse,
  ThreadDeleteResponse,
  ThreadResumeResponse,
  ThreadSetNameResponse,
  ThreadStartResponse,
  ToolRequestUserInputResponse,
  TurnInterruptResponse,
  TurnStartResponse,
  TurnSteerResponse,
} from './protocol/v2';

/** What the adapter asks app-server: preflight, threads, turns and deletion. */
export const CodexClientMethods = [
  'initialize',
  'account/read',
  'account/rateLimits/read',
  'configRequirements/read',
  'config/read',
  'mcpServerStatus/list',
  'skills/list',
  'thread/start',
  'thread/resume',
  'thread/name/set',
  'thread/compact/start',
  'thread/delete',
  'turn/start',
  'turn/steer',
  'turn/interrupt',
] as const satisfies readonly ClientRequest['method'][];

/** The server requests section 9.3 answers; any other one gets -32601. */
export const CodexServerRequestMethods = [
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'item/tool/requestUserInput',
  'mcpServer/elicitation/request',
] as const satisfies readonly ServerRequest['method'][];

/** The notifications the adapter maps to events, quota and start checks (sections 9.2, 9.3). */
export const CodexNotificationMethods = [
  'error',
  'thread/started',
  'thread/status/changed',
  'thread/tokenUsage/updated',
  'turn/started',
  'turn/completed',
  'item/started',
  'item/completed',
  'serverRequest/resolved',
  'account/rateLimits/updated',
  'warning',
  'configWarning',
  'deprecationNotice',
  'model/rerouted',
] as const satisfies readonly ServerNotification['method'][];

export type CodexClientMethod = (typeof CodexClientMethods)[number];
export type CodexServerRequestMethod = (typeof CodexServerRequestMethods)[number];
export type CodexNotificationMethod = (typeof CodexNotificationMethods)[number];
export type CodexMethod = CodexClientMethod | CodexServerRequestMethod | CodexNotificationMethod;

/** The generated params of a client method, server request or notification. */
export type ParamsOf<M extends CodexMethod> = M extends CodexClientMethod
  ? Extract<ClientRequest, { method: M }>['params']
  : M extends CodexServerRequestMethod
    ? Extract<ServerRequest, { method: M }>['params']
    : Extract<ServerNotification, { method: M }>['params'];

interface CodexResults {
  initialize: InitializeResponse;
  'account/read': GetAccountResponse;
  'account/rateLimits/read': GetAccountRateLimitsResponse;
  'configRequirements/read': ConfigRequirementsReadResponse;
  'config/read': ConfigReadResponse;
  'mcpServerStatus/list': ListMcpServerStatusResponse;
  'skills/list': SkillsListResponse;
  'thread/start': ThreadStartResponse;
  'thread/resume': ThreadResumeResponse;
  'thread/name/set': ThreadSetNameResponse;
  'thread/compact/start': ThreadCompactStartResponse;
  'thread/delete': ThreadDeleteResponse;
  'turn/start': TurnStartResponse;
  'turn/steer': TurnSteerResponse;
  'turn/interrupt': TurnInterruptResponse;
  'item/commandExecution/requestApproval': CommandExecutionRequestApprovalResponse;
  'item/fileChange/requestApproval': FileChangeRequestApprovalResponse;
  'item/permissions/requestApproval': PermissionsRequestApprovalResponse;
  'item/tool/requestUserInput': ToolRequestUserInputResponse;
  'mcpServer/elicitation/request': McpServerElicitationRequestResponse;
}

/** What a client method answers, or what the adapter answers a server request with. */
export type ResultOf<M extends CodexClientMethod | CodexServerRequestMethod> = CodexResults[M];

// Fails to compile when a listed method has no result type, or a result type belongs to no listed method.
type Never<T extends never> = T;
type ResultsCoverTheMethods = Never<
  | Exclude<CodexClientMethod | CodexServerRequestMethod, keyof CodexResults>
  | Exclude<keyof CodexResults, CodexClientMethod | CodexServerRequestMethod>
>;
```

**Generate:** `bun run gen:codex-protocol --bin "${AGFLOW_CODEX_BIN:-/usr/local/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex}"`

- [ ] **Step 4: Run the tests and see them pass**

Run: `bun test packages/runner/test/codex/protocol.test.ts && bun test && bun run typecheck`
Expected: the task's tests pass (11 pass, 1 skip); then the whole suite passes (`0 fail`) and `tsc` exits 0.

The Generate step uses the explicit native-binary path shown above, with `AGFLOW_CODEX_BIN` as an override. The generator checks the pin and uses scratch `HOME` and `CODEX_HOME`; it never starts a model session. M2c Task 3 supplies the installer; use only the scratch provisioning commands in the conventions, including both binary exports, and keep the scratch install until all verification children exit. The explicit native-binary path keeps this Generate step independent of a runner installation. It writes into a staging directory and then replaces `protocol/`; a non-empty `--out` without a `VERSION` is never replaced. The skipped test is the regeneration check: with `AGFLOW_SMOKE=1` and the pin located, it regenerates into a temporary directory under a fresh `HOME` and compares the committed files byte for byte. Never edit `protocol/` by hand.

- [ ] **Step 5: Commit**

```bash
git add -A 'packages/runner/scripts/gen-codex-protocol.ts' 'packages/runner/src/adapters/codex/methods.ts' 'packages/runner/test/codex/protocol.test.ts' 'packages/runner/src/adapters/codex/protocol/**'
git commit -m 'M2E Task 2: Generated app-server protocol and typed method map' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

### Task 3: Scripted Responses API provider: server, parsed requests and Code Mode replies

A local stand-in for the OpenAI Responses API, which the real Codex reaches through a custom model provider, so the adapter's local suites and M2g run real app-server turns with zero model use (design 15, 15.1, X-20). It has the shape both scripted servers share, `{ url, requests, setHandler(fn) }`, with parsed `ResponsesRequest`s, reply builders, `rules()` that answer from request content and never from order, and a default text answer for anything unmatched. With the pinned slug, Codex 0.159.2 runs Code Mode: one freeform `exec` tool runs JavaScript, with `exec_command`, `write_stdin`, `apply_patch` and the MCP tools nested inside, so tool replies are `exec` calls. `reply.shell` holds one `exec` call through a long command by polling `write_stdin`, since `exec_command` yields after at most 30 s. Consumers import `@agflow/testkit/src/codex/index`.

**Files:**
- Create: `packages/testkit/src/codex/index.ts`
- Create: `packages/testkit/src/codex/replies.ts`
- Create: `packages/testkit/src/codex/request.ts`
- Create: `packages/testkit/src/codex/responses-server.ts`
- Test: `packages/testkit/test/codex/responses-server.test.ts`

- [ ] **Step 1: Write the failing test**

**File:** `packages/testkit/test/codex/responses-server.test.ts` (new)

```ts
import { afterEach, describe, expect, test } from 'bun:test';
import {
  type ResponsesRequest,
  type ResponsesServer,
  reply,
  rules,
  startResponsesServer,
  toolSurface,
} from '../../src/codex/index';

const servers: ResponsesServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

async function server(): Promise<ResponsesServer> {
  const started = await startResponsesServer();
  servers.push(started);
  return started;
}

interface Turn {
  threadId?: string;
  brief?: string;
  cwd?: string;
  user?: string[];
  /** Items after the last user message: tool calls and their outputs. */
  after?: Record<string, unknown>[];
  headers?: Record<string, string>;
  metadataOnly?: boolean;
  /** client_metadata.thread_id when it differs from the headers' thread id. */
  metadataThreadId?: string;
}

const developer = (...texts: string[]) => ({
  type: 'message',
  role: 'developer',
  content: texts.map((text) => ({ type: 'input_text', text })),
});
const user = (text: string) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const context = (cwd: string) => user(`<environment_context>\n  <cwd>${cwd}</cwd>\n</environment_context>`);

/** A request body shaped like Codex 0.159.2's, as the 2026-10-28 probes recorded it. */
function body(turn: Turn): Record<string, unknown> {
  const threadId = turn.threadId ?? 'thread-a';
  return {
    model: 'gpt-6.1-sol',
    stream: true,
    tool_choice: 'auto',
    parallel_tool_calls: true,
    client_metadata: { session_id: threadId, thread_id: turn.metadataThreadId ?? threadId, turn_id: 'turn-1' },
    input: [
      {
        type: 'additional_tools',
        role: 'developer',
        tools: [
          {
            type: 'namespace',
            name: 'functions',
            tools: [
              {
                type: 'custom',
                name: 'exec',
                description:
                  'Run JavaScript\n\n### `apply_patch`\nEdit files.\n\n### `exec_command`\nRuns a command.\n\n' +
                  '### `write_stdin`\nWrites characters.\n\n## clock\n\n### `clock__curr_time`\nThe time.',
              },
              { type: 'function', name: 'wait' },
            ],
          },
          { type: 'namespace', name: 'collaboration', tools: [{ type: 'function', name: 'spawn_agent' }] },
        ],
      },
      developer('You are Codex, an agent based on GPT-6.'),
      developer(turn.brief ?? 'BRIEF', '<skills_instructions>\n## Skills\n</skills_instructions>'),
      developer('<multi_agent_mode>no</multi_agent_mode>'),
      context(turn.cwd ?? '/private/tmp/clone'),
      ...(turn.user ?? ['hello']).map(user),
      ...(turn.after ?? []),
    ],
  };
}

function headersOf(turn: Turn): Record<string, string> {
  const threadId = turn.threadId ?? 'thread-a';
  return {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    ...(turn.metadataOnly ? {} : { 'session-id': threadId, 'thread-id': threadId }),
    ...turn.headers,
  };
}

/** Posts a turn's request and gives the parsed SSE events. */
async function post(target: ResponsesServer, turn: Turn = {}): Promise<{ response: Response; events: SseEvent[] }> {
  const response = await fetch(`${target.url}/responses`, {
    method: 'POST',
    headers: headersOf(turn),
    body: JSON.stringify(body(turn)),
  });
  return { response, events: parseSse(await response.text()) };
}

interface SseEvent {
  event: string;
  data: Record<string, any>;
}

function parseSse(text: string): SseEvent[] {
  return text
    .split('\n\n')
    .filter((block) => block.trim())
    .map((block) => {
      const event = block.match(/^event: (.*)$/m)?.[1] ?? '';
      const data = JSON.parse(block.match(/^data: (.*)$/m)?.[1] ?? '{}');
      return { event, data };
    });
}

/** The output items of a streamed reply, as response.completed lists them. */
function outputOf(events: SseEvent[]): Record<string, any>[] {
  return events.find((event) => event.event === 'response.completed')?.data.response.output ?? [];
}

const callOutput = (callId: string, text: string) => ({
  type: 'custom_tool_call_output',
  call_id: callId,
  output: [
    { type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' },
    { type: 'input_text', text },
  ],
});

describe('startResponsesServer', () => {
  test('streams a text reply as the Responses API does', async () => {
    const scripted = await server();
    expect(scripted.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    scripted.setHandler(() => reply.text('scripted answer'));
    const { response, events } = await post(scripted);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toStartWith('text/event-stream');
    expect(events.map((event) => event.event)).toEqual([
      'response.created',
      'response.output_item.added',
      'response.output_text.delta',
      'response.output_item.done',
      'response.completed',
    ]);
    for (const event of events) expect(event.data.type).toBe(event.event);
    expect(events[2]?.data.delta).toBe('scripted answer');
    const [message] = outputOf(events);
    expect(message).toMatchObject({
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'scripted answer', annotations: [] }],
    });
    expect(events[4]?.data.response).toMatchObject({
      status: 'completed',
      usage: { input_tokens: expect.any(Number), output_tokens: expect.any(Number), total_tokens: expect.any(Number) },
    });
    expect(events[0]?.data.response.id).toBe(events[4]?.data.response.id);
  });

  test('parses each request into a ResponsesRequest, in arrival order', async () => {
    const scripted = await server();
    await post(scripted, {
      threadId: 'thread-a',
      metadataThreadId: 'thread-metadata-a',
      brief: 'AGFLOW BRIEF A',
      cwd: '/private/tmp/a',
      user: ['first'],
    });
    await post(scripted, {
      threadId: 'thread-b',
      metadataThreadId: 'thread-metadata-b',
      user: ['a person', 'steered in'],
      after: [
        // A newer environment context, as after a turn in another directory.
        context('/private/tmp/b-newer'),
        { type: 'custom_tool_call', call_id: 'call-1', name: 'exec', input: 'text(1)' },
        callOutput('call-1', '{"exit_code":0,"output":"hi\\n"}'),
      ],
      headers: { 'thread-id': '', 'session-id': 'thread-b' },
    });
    await post(scripted, {
      threadId: 'thread-c',
      user: [],
      after: [{ type: 'function_call_output', name: 'agent_message', namespace: 'agflow', output: 'from A-3: hi' }],
      metadataOnly: true,
    });
    const [a, b, c] = scripted.requests as [ResponsesRequest, ResponsesRequest, ResponsesRequest];
    expect(scripted.requests.map((request) => request.index)).toEqual([0, 1, 2]);
    expect(a).toMatchObject({
      method: 'POST',
      path: '/v1/responses',
      model: 'gpt-6.1-sol',
      threadId: 'thread-a',
      instructions: 'AGFLOW BRIEF A',
      cwd: '/private/tmp/a',
      lastUserText: 'first',
      toolOutputs: [],
      toolOutputsSinceUser: 0,
      unmatched: true,
    });
    expect(a.inputKinds).toEqual([
      'additional_tools',
      'message:developer',
      'message:developer',
      'message:developer',
      'message:user',
      'message:user',
    ]);
    expect(a.headers['thread-id']).toBe('thread-a');
    expect(a.body.model).toBe('gpt-6.1-sol');
    // The headers win over client_metadata, and session-id stands in for an empty thread-id.
    expect(b).toMatchObject({
      threadId: 'thread-b',
      cwd: '/private/tmp/b-newer',
      lastUserText: 'steered in',
      toolOutputsSinceUser: 1,
    });
    expect(b.toolOutputs).toEqual([
      {
        type: 'custom_tool_call_output',
        callId: 'call-1',
        name: null,
        output: 'Script completed\nWall time 0.1 seconds\nOutput:\n\n{"exit_code":0,"output":"hi\\n"}',
        parts: ['Script completed\nWall time 0.1 seconds\nOutput:\n', '{"exit_code":0,"output":"hi\\n"}'],
      },
    ]);
    // An agent's message arrives as a tool output without a call, and no user text precedes it.
    expect(c).toMatchObject({ threadId: 'thread-c', lastUserText: null, toolOutputsSinceUser: 1 });
    expect(c.toolOutputs).toEqual([
      {
        type: 'function_call_output',
        callId: null,
        name: 'agent_message',
        output: 'from A-3: hi',
        parts: ['from A-3: hi'],
      },
    ]);
  });

  test('a later handler answers every later request', async () => {
    const scripted = await server();
    const seen: string[] = [];
    scripted.setHandler((request) => {
      seen.push(request.lastUserText ?? '');
      return reply.text(`echo ${request.lastUserText}`);
    });
    expect(outputOf((await post(scripted, { user: ['one'] })).events)[0]?.content[0].text).toBe('echo one');
    scripted.setHandler(async () => reply.text('second handler'));
    expect(outputOf((await post(scripted, { user: ['two'] })).events)[0]?.content[0].text).toBe('second handler');
    expect(seen).toEqual(['one']);
    expect(scripted.requests.map((request) => request.unmatched)).toEqual([false, false]);
  });

  test('without a handler, or when it answers nothing, a request gets the default text and is flagged', async () => {
    const scripted = await server();
    const first = outputOf((await post(scripted)).events);
    scripted.setHandler((request) => (request.lastUserText === 'known' ? reply.text('known') : undefined));
    const second = outputOf((await post(scripted, { user: ['unknown'] })).events);
    await post(scripted, { user: ['known'] });
    expect(first.map(({ id: _id, ...item }) => item)).toEqual(second.map(({ id: _id, ...item }) => item));
    expect(first[0]).toMatchObject({ type: 'message', content: [{ type: 'output_text', text: expect.any(String) }] });
    expect(scripted.requests.map((request) => request.unmatched)).toEqual([true, true, false]);
  });

  test('GET requests get an empty model list; other POST paths get 404 and invalid JSON 400', async () => {
    const scripted = await server();
    const models = await fetch(`${scripted.url}/models?client_version=0.159.2`);
    expect(models.status).toBe(200);
    expect(await models.json()).toEqual({ object: 'list', data: [], models: [] });
    const other = await fetch(`${scripted.url}/chat/completions`, { method: 'POST', body: '{}' });
    expect(other.status).toBe(404);
    const invalid = await fetch(`${scripted.url}/responses`, { method: 'POST', body: 'not json' });
    expect(invalid.status).toBe(400);
    expect(scripted.requests).toEqual([]);
  });

  test('toolSurface lists the namespaces, their tools and the nested Code Mode tools', async () => {
    const scripted = await server();
    await post(scripted);
    expect(toolSurface(scripted.requests[0] as ResponsesRequest)).toEqual({
      namespaces: [
        { name: 'functions', tools: ['exec', 'wait'] },
        { name: 'collaboration', tools: ['spawn_agent'] },
      ],
      nested: ['apply_patch', 'exec_command', 'write_stdin', 'clock__curr_time'],
    });
  });
});

describe('rules', () => {
  const handler = rules([
    { threadId: 'thread-x', reply: reply.text('thread x') },
    { marker: 'AGENT-A', toolOutputs: 0, reply: reply.shell({ cmd: 'make test', callId: 'call-a' }) },
    { marker: 'AGENT-A', toolOutputs: 1, reply: (request) => reply.text(`A saw ${request.toolOutputs.length}`) },
    { marker: 'AGENT-B', reply: reply.text('B') },
  ]);

  test('match a brief or user-text marker, a thread id and the tool outputs since the user', async () => {
    const scripted = await server();
    scripted.setHandler(handler);
    const shell = outputOf((await post(scripted, { threadId: 't1', brief: 'You are AGENT-A' })).events);
    expect(shell[0]).toMatchObject({ type: 'custom_tool_call', name: 'exec', call_id: 'call-a' });
    const after = outputOf(
      (
        await post(scripted, {
          threadId: 't1',
          brief: 'You are AGENT-A',
          after: [{ type: 'custom_tool_call', call_id: 'call-a' }, callOutput('call-a', 'done')],
        })
      ).events,
    );
    expect(after[0]?.content[0].text).toBe('A saw 1');
    const b = outputOf((await post(scripted, { threadId: 't2', user: ['ask AGENT-B'] })).events);
    expect(b[0]?.content[0].text).toBe('B');
    const x = outputOf((await post(scripted, { threadId: 'thread-x', user: ['AGENT-B'] })).events);
    expect(x[0]?.content[0].text).toBe('thread x');
    await post(scripted, { threadId: 't3', brief: 'AGENT-A', after: [callOutput('1', 'x'), callOutput('2', 'y')] });
    expect(scripted.requests.map((request) => request.unmatched)).toEqual([false, false, false, false, true]);
  });

  test('a user message after tool outputs, as a steer mid-turn, starts the count again', async () => {
    const scripted = await server();
    scripted.setHandler(handler);
    const { events } = await post(scripted, {
      threadId: 't1',
      brief: 'You are AGENT-A',
      user: ['go'],
      after: [
        { type: 'custom_tool_call', call_id: 'call-a', name: 'exec', input: 'text(1)' },
        callOutput('call-a', 'first'),
        user('steered'),
        { type: 'custom_tool_call', call_id: 'call-b', name: 'exec', input: 'text(2)' },
        callOutput('call-b', 'second'),
      ],
    });
    const [request] = scripted.requests as [ResponsesRequest];
    expect(request).toMatchObject({ lastUserText: 'steered', toolOutputsSinceUser: 1 });
    expect(request.toolOutputs.map((output) => output.callId)).toEqual(['call-a', 'call-b']);
    expect(outputOf(events)[0]?.content[0].text).toBe('A saw 2');
  });

  test('two threads interleaved in either order get the same answers', async () => {
    const a = (outputs: number): Turn => ({
      threadId: 'ta',
      brief: 'AGENT-A',
      after: outputs ? [{ type: 'custom_tool_call', call_id: 'call-a' }, callOutput('call-a', 'ok')] : [],
    });
    const b: Turn = { threadId: 'tb', brief: 'AGENT-B' };
    const answers = async (order: Turn[]) => {
      const scripted = await server();
      scripted.setHandler(handler);
      const byTurn: Record<string, unknown[]> = {};
      for (const turn of order) {
        const items = outputOf((await post(scripted, turn)).events).map(({ id: _id, ...item }) => item);
        byTurn[`${turn.threadId}:${turn.after?.length ?? 0}`] = items;
      }
      return byTurn;
    };
    const expected = await answers([a(0), a(1), b]);
    expect(Object.keys(expected).sort()).toEqual(['ta:0', 'ta:2', 'tb:0']);
    expect(await answers([a(0), b, a(1)])).toEqual(expected);
    expect(await answers([b, a(1), a(0)])).toEqual(expected);
  });
});

describe('reply builders', () => {
  /** Runs a Code Mode exec script with fake tools, as codex-code-mode-host would. */
  async function runScript(source: string, tools: Record<string, (args: any) => Promise<unknown>>): Promise<unknown[]> {
    const texts: unknown[] = [];
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
    await new AsyncFunction('tools', 'text', source)(tools, (value: unknown) => texts.push(value));
    return texts;
  }

  function single(built: ReturnType<typeof reply.text>): Record<string, any> {
    expect(built.kind).toBe('stream');
    const items = built.kind === 'stream' ? built.output : [];
    expect(items).toHaveLength(1);
    return items[0] as Record<string, any>;
  }

  test('shell runs exec_command in one exec call and polls write_stdin until the command exits', async () => {
    const item = single(reply.shell({ cmd: `echo "it's" > out.txt`, timeoutMs: 45_000, callId: 'call-sh' }));
    expect(item).toMatchObject({ type: 'custom_tool_call', name: 'exec', call_id: 'call-sh' });
    const source = item.input as string;
    const pragma = source.split('\n')[0] as string;
    expect(pragma).toMatch(/^\/\/ @exec: \{.*\}$/);
    expect(JSON.parse(pragma.slice('// @exec: '.length)).yield_time_ms).toBeGreaterThanOrEqual(45_000);
    const calls: [string, any][] = [];
    const texts = await runScript(source, {
      exec_command: async (args) => {
        calls.push(['exec_command', args]);
        return { session_id: 7, output: 'one ', wall_time_seconds: 30 };
      },
      write_stdin: async (args) => {
        calls.push(['write_stdin', args]);
        return calls.length < 3
          ? { session_id: 7, output: 'two ', wall_time_seconds: 5 }
          : { exit_code: 0, output: 'three', wall_time_seconds: 1 };
      },
    });
    expect(calls[0]).toEqual(['exec_command', { cmd: `echo "it's" > out.txt`, yield_time_ms: 30_000 }]);
    expect(calls.slice(1).map(([name, args]) => [name, args.session_id, args.chars])).toEqual([
      ['write_stdin', 7, ''],
      ['write_stdin', 7, ''],
    ]);
    expect(texts).toEqual([{ exit_code: 0, output: 'one two three', wall_time_seconds: 1 }]);
  });

  test('shell stops polling at timeoutMs and reports the command still running', async () => {
    const source = single(reply.shell({ cmd: 'sleep 100', timeoutMs: 300, callId: 'c' })).input as string;
    let polls = 0;
    const texts = await runScript(source, {
      exec_command: async (args) => {
        expect(args.yield_time_ms).toBe(300);
        return { session_id: 3, output: '', wall_time_seconds: 0.3 };
      },
      write_stdin: async () => {
        polls += 1;
        await Bun.sleep(50);
        return { session_id: 3, output: '', wall_time_seconds: 0.05 };
      },
    });
    expect(texts).toEqual([{ session_id: 3, output: '', wall_time_seconds: expect.any(Number) }]);
    expect(polls).toBeLessThan(20);
  });

  test('shell with escalate asks for an unsandboxed run with its justification', async () => {
    const source = single(
      reply.shell({ cmd: 'curl -sS https://example.com', escalate: { justification: 'needs "network"' }, callId: 'c' }),
    ).input as string;
    const calls: any[] = [];
    await runScript(source, {
      exec_command: async (args) => {
        calls.push(args);
        return { exit_code: 0, output: '', wall_time_seconds: 0 };
      },
      write_stdin: async () => ({}),
    });
    expect(calls).toEqual([
      {
        cmd: 'curl -sS https://example.com',
        sandbox_permissions: 'require_escalated',
        justification: 'needs "network"',
        yield_time_ms: 30_000,
      },
    ]);
  });

  test('mcp calls the agflow tool with its arguments', async () => {
    const mcp = single(reply.mcp({ tool: 'write_handoff', args: { note: 'it\'s "done"' }, callId: 'call-m' }));
    expect(mcp).toMatchObject({ type: 'custom_tool_call', name: 'exec', call_id: 'call-m' });
    const seen: unknown[] = [];
    const texts = await runScript(mcp.input, {
      mcp__agflow__write_handoff: async (args) => {
        seen.push(args);
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    });
    expect(seen).toEqual([{ note: 'it\'s "done"' }]);
    expect(texts).toEqual([{ content: [{ type: 'text', text: 'ok' }] }]);
    expect(() => reply.mcp({ tool: 'bad-name()', args: {} })).toThrow('not a tool name');
  });

  test('patch, code and functionCall', async () => {
    const patchText = '*** Begin Patch\n*** Add File: a.txt\n+hi\n*** End Patch\n';
    const patch = single(reply.patch(patchText, { callId: 'call-p' }));
    expect(patch).toMatchObject({ type: 'custom_tool_call', name: 'exec', call_id: 'call-p' });
    const patches: unknown[] = [];
    await runScript(patch.input, {
      apply_patch: async (input) => {
        patches.push(input);
        return 'Done!';
      },
    });
    expect(patches).toEqual([patchText]);

    expect(single(reply.code('text(1 + 1);', { callId: 'call-e' }))).toMatchObject({
      type: 'custom_tool_call',
      name: 'exec',
      call_id: 'call-e',
      input: 'text(1 + 1);',
    });
    expect(single(reply.functionCall({ name: 'wait', args: { ms: 5 }, callId: 'call-f' }))).toMatchObject({
      type: 'function_call',
      name: 'wait',
      arguments: '{"ms":5}',
      call_id: 'call-f',
    });
    expect(single(reply.functionCall({ name: 'spawn_agent', namespace: 'collaboration', args: {} }))).toEqual({
      type: 'function_call',
      name: 'spawn_agent',
      namespace: 'collaboration',
      arguments: '{}',
    });
  });

  test('a call without a call id gets a fresh one each time it is streamed', async () => {
    const scripted = await server();
    const shared = reply.mcp({ tool: 'hello', args: {} });
    scripted.setHandler(() => shared);
    const first = outputOf((await post(scripted)).events)[0];
    const second = outputOf((await post(scripted)).events)[0];
    expect(first?.call_id).toMatch(/^call_\w+$/);
    expect(second?.call_id).toMatch(/^call_\w+$/);
    expect(first?.call_id).not.toBe(second?.call_id);
    expect(first?.id).not.toBe(second?.id);
  });

  test('a tool call reply streams its item without text deltas', async () => {
    const scripted = await server();
    scripted.setHandler(() => reply.shell({ cmd: 'ls', callId: 'call-ls' }));
    const { events } = await post(scripted);
    expect(events.map((event) => event.event)).toEqual([
      'response.created',
      'response.output_item.added',
      'response.output_item.done',
      'response.completed',
    ]);
    expect(events[1]?.data.item).toMatchObject({ type: 'custom_tool_call', status: 'in_progress', input: '' });
    expect(events[2]?.data.item).toMatchObject({ type: 'custom_tool_call', call_id: 'call-ls', status: 'completed' });
  });
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `bun test packages/testkit/test/codex/responses-server.test.ts`
Expected: FAIL — `error: Cannot find module '../../src/codex/index' from 'packages/testkit/test/codex/responses-server.test.ts'` (0 pass, 1 fail, 1 error)

- [ ] **Step 3: Implement**

**File:** `packages/testkit/src/codex/index.ts` (new)

```ts
// The scripted Responses API provider for Codex tests (design 15.1). Consumers import @agflow/testkit/src/codex/index;
// it is not part of the testkit's main entry.
export { DEFAULT_REPLY_TEXT, type OutputItem, reply, type ScriptedReply, type ShellReplyOptions } from './replies';
export { type ResponsesRequest, type ResponsesToolOutput, type ToolSurface, toolSurface } from './request';
export {
  type ResponsesHandler,
  type ResponsesRule,
  type ResponsesServer,
  rules,
  startResponsesServer,
} from './responses-server';
```

**File:** `packages/testkit/src/codex/replies.ts` (new)

```ts
// Reply builders for the scripted Responses API (design 15.1). With the pinned slug, Codex 0.159.2 runs Code Mode:
// the model has one freeform `exec` tool that runs JavaScript, and exec_command, write_stdin, apply_patch and the MCP
// tools (tools.mcp__agflow__<tool>) are nested inside it. So a scripted tool call is a custom_tool_call named exec
// whose input is JavaScript.
import { randomUUID } from 'node:crypto';

/** A Responses API output item; ids are added when the reply is streamed. */
export type OutputItem = { type: string } & Record<string, unknown>;

export interface StreamReply {
  kind: 'stream';
  output: OutputItem[];
  /** usage.input_tokens of response.completed, which Codex reports in thread/tokenUsage/updated. */
  inputTokens?: number;
  /** Extra response headers. */
  headers?: Record<string, string>;
}

export type ScriptedReply = StreamReply;

/** What a request gets when no handler answers it. */
export const DEFAULT_REPLY_TEXT = 'Done.';

/** exec_command yields after at most 30 s; a longer command is polled with write_stdin. */
const EXEC_COMMAND_MAX_YIELD_MS = 30_000;
const EXEC_COMMAND_MIN_YIELD_MS = 250;
/** An empty write_stdin poll waits at most 300 s. */
const POLL_MAX_MS = 300_000;
const POLL_MIN_MS = 1_000;
/** exec itself yields this long after the script's own deadline, so the script reports a timeout first. */
const EXEC_GRACE_MS = 5_000;
const DEFAULT_SHELL_TIMEOUT_MS = 60_000;

const JS_IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}

function stream(...output: OutputItem[]): StreamReply {
  return { kind: 'stream', output };
}

/** A Code Mode exec call; a call without callId gets a fresh one each time it is streamed. */
function execCall(source: string, callId: string | undefined): StreamReply {
  return stream({ type: 'custom_tool_call', name: 'exec', input: source, ...(callId ? { call_id: callId } : {}) });
}

export interface ShellReplyOptions {
  cmd: string;
  /** How long the exec call waits for the command; 60 s by default. */
  timeoutMs?: number;
  workdir?: string;
  /** Asks to run outside the sandbox, which raises an approval request with this justification. */
  escalate?: { justification: string };
  callId?: string;
}

/**
 * One exec call that runs cmd and waits for it: exec_command, then empty write_stdin polls until the command exits or
 * timeoutMs passes. The script's text is exec_command's last result with the output of every call joined, so a
 * command still running at timeoutMs reports its session_id and no exit_code.
 */
function shellSource(options: ShellReplyOptions): string {
  const timeoutMs = options.timeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS;
  const args = {
    cmd: options.cmd,
    ...(options.workdir ? { workdir: options.workdir } : {}),
    ...(options.escalate
      ? { sandbox_permissions: 'require_escalated', justification: options.escalate.justification }
      : {}),
    yield_time_ms: Math.max(EXEC_COMMAND_MIN_YIELD_MS, Math.min(timeoutMs, EXEC_COMMAND_MAX_YIELD_MS)),
  };
  const pollMs = `Math.min(${POLL_MAX_MS}, Math.max(${POLL_MIN_MS}, deadline - Date.now()))`;
  return [
    `// @exec: ${JSON.stringify({ yield_time_ms: timeoutMs + EXEC_GRACE_MS })}`,
    `const deadline = Date.now() + ${timeoutMs};`,
    `let result = await tools.exec_command(${JSON.stringify(args)});`,
    `let output = result.output ?? '';`,
    'while (result.exit_code === undefined && result.session_id !== undefined && Date.now() < deadline) {',
    `  result = await tools.write_stdin({ session_id: result.session_id, chars: '', yield_time_ms: ${pollMs} });`,
    `  output += result.output ?? '';`,
    '}',
    'text({ ...result, output });',
  ].join('\n');
}

export const reply = {
  /** An assistant message, which ends the turn. */
  text(text: string): StreamReply {
    return stream({
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text, annotations: [] }],
    });
  },

  /** Raw JavaScript for Code Mode's exec tool. */
  code(source: string, options: { callId?: string } = {}): StreamReply {
    return execCall(source, options.callId);
  },

  /** A shell command through exec_command, polled until it exits or timeoutMs passes. */
  shell(options: ShellReplyOptions): StreamReply {
    return execCall(shellSource(options), options.callId);
  },

  /** A call of the agflow bridge's tool, whose result becomes the exec call's text. */
  mcp(options: { tool: string; args: Record<string, unknown>; callId?: string }): StreamReply {
    if (!JS_IDENTIFIER.test(options.tool)) throw new Error(`not a tool name: ${JSON.stringify(options.tool)}`);
    const source = [
      `const result = await tools.mcp__agflow__${options.tool}(${JSON.stringify(options.args)});`,
      'text(result);',
    ].join('\n');
    return execCall(source, options.callId);
  },

  /** An apply_patch call with a patch in apply_patch's own format. */
  patch(patch: string, options: { callId?: string } = {}): StreamReply {
    const source = [`const result = await tools.apply_patch(${JSON.stringify(patch)});`, 'text(result);'].join('\n');
    return execCall(source, options.callId);
  },

  /** A direct function call, outside exec: wait, or a collaboration tool with its namespace. */
  functionCall(options: {
    name: string;
    args: Record<string, unknown>;
    namespace?: string;
    callId?: string;
  }): StreamReply {
    return stream({
      type: 'function_call',
      name: options.name,
      ...(options.namespace ? { namespace: options.namespace } : {}),
      arguments: JSON.stringify(options.args),
      ...(options.callId ? { call_id: options.callId } : {}),
    });
  },
};

export interface StreamEvent {
  type: string;
  [key: string]: unknown;
}

const ITEM_ID_PREFIX: Record<string, string> = { message: 'msg', custom_tool_call: 'ctc', function_call: 'fc' };

/** The item as response.output_item.added announces it, before its content. */
function pending(item: OutputItem): OutputItem {
  if (item.type === 'message') return { ...item, status: 'in_progress', content: [] };
  if (item.type === 'custom_tool_call') return { ...item, status: 'in_progress', input: '' };
  if (item.type === 'function_call') return { ...item, status: 'in_progress', arguments: '' };
  return item;
}

/** The events of one streamed response, in the order the Responses API sends them. */
export function responseEvents(built: StreamReply, responseId: string): StreamEvent[] {
  const output = built.output.map((item): OutputItem => ({
    id: newId(ITEM_ID_PREFIX[item.type] ?? 'item'),
    ...(item.type === 'custom_tool_call' || item.type === 'function_call' ? { call_id: newId('call') } : {}),
    status: 'completed',
    ...item,
  }));
  const inputTokens = built.inputTokens ?? 100;
  const usage = {
    input_tokens: inputTokens,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 5,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: inputTokens + 5,
  };
  const events: StreamEvent[] = [
    { type: 'response.created', response: { id: responseId, status: 'in_progress', output: [] } },
  ];
  output.forEach((item, index) => {
    events.push({ type: 'response.output_item.added', output_index: index, item: pending(item) });
    if (item.type === 'message') {
      const text = (item.content as { text?: string }[]).map((part) => part.text ?? '').join('');
      events.push({
        type: 'response.output_text.delta',
        item_id: item.id,
        output_index: index,
        content_index: 0,
        delta: text,
      });
    }
    events.push({ type: 'response.output_item.done', output_index: index, item });
  });
  events.push({ type: 'response.completed', response: { id: responseId, status: 'completed', output, usage } });
  return events;
}

export function encodeSse(events: StreamEvent[]): string {
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}
```

**File:** `packages/testkit/src/codex/request.ts` (new)

```ts
// What a scripted Responses API handler sees of a request (design 15.1). The fields come from the request shapes
// Codex 0.159.2 sent in the 2026-10-28 probes: the base prompt and the developer instructions arrive as developer
// messages (there is no top-level `instructions`), the working directory as an <environment_context> user message,
// and tool results as *_output items.

export interface ResponsesToolOutput {
  /** function_call_output or custom_tool_call_output (Code Mode's exec). */
  type: string;
  /** Null for an output that answers no call: an agent's message delivered as agflow's agent_message. */
  callId: string | null;
  /** The tool name an output carries without a call (agent_message); null otherwise. */
  name: string | null;
  /** The text parts, joined with newlines. */
  output: string;
  parts: string[];
}

export interface ResponsesRequest {
  /** Arrival order on its server, from 0. */
  index: number;
  method: string;
  path: string;
  /** Lower-case header names. */
  headers: Record<string, string>;
  body: Record<string, unknown>;
  model: string | null;
  /** The thread-id header, else session-id, else client_metadata.thread_id. */
  threadId: string | null;
  /** The developer instructions (the agent's brief): developer texts after the base prompt, without tagged blocks. */
  instructions: string;
  /** The <cwd> of the newest environment context. */
  cwd: string | null;
  /** Each input item's type, with the role for messages: 'message:user', 'custom_tool_call_output'. */
  inputKinds: string[];
  toolOutputs: ResponsesToolOutput[];
  /** Tool outputs after the last user text: 0 for a fresh prompt, then one more per answered call. */
  toolOutputsSinceUser: number;
  /** The newest user message that is not context Codex adds itself; null when there is none. */
  lastUserText: string | null;
  /** Answered by the default reply: no handler, or the handler returned nothing. */
  unmatched: boolean;
}

type Item = Record<string, unknown>;

/** User messages Codex writes itself; they are not what a person or the runner said. */
const CONTEXT_PREFIXES = ['<environment_context>', '# AGENTS.md instructions'];

function textParts(content: unknown): string[] {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content
    .map((part) => (part && typeof part === 'object' ? (part as Item).text : undefined))
    .filter((text): text is string => typeof text === 'string');
}

function isMessage(item: Item, role: string): boolean {
  return item.type === 'message' && item.role === role;
}

function isToolOutput(item: Item): boolean {
  return typeof item.type === 'string' && item.type.endsWith('_call_output');
}

function isContext(text: string): boolean {
  return CONTEXT_PREFIXES.some((prefix) => text.startsWith(prefix));
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

export function parseResponsesRequest(
  raw: unknown,
  meta: { index: number; method: string; path: string; headers: Record<string, string> },
): ResponsesRequest {
  const body = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const input = (Array.isArray(body.input) ? body.input : []).filter(
    (item): item is Item => item !== null && typeof item === 'object',
  );
  const metadata = (body.client_metadata ?? {}) as Item;

  const developerTexts = input
    .filter((item) => isMessage(item, 'developer'))
    .slice(1)
    .flatMap((item) => textParts(item.content))
    .filter((text) => !text.startsWith('<'));

  let cwd: string | null = null;
  let lastUser = -1;
  let lastUserText: string | null = null;
  for (const [position, item] of input.entries()) {
    if (!isMessage(item, 'user')) continue;
    const text = textParts(item.content).join('\n');
    if (isContext(text)) {
      cwd = text.match(/<cwd>([^<]*)<\/cwd>/)?.[1] ?? cwd;
    } else {
      lastUser = position;
      lastUserText = text;
    }
  }

  const toolOutputs: ResponsesToolOutput[] = [];
  let toolOutputsSinceUser = 0;
  for (const [position, item] of input.entries()) {
    if (!isToolOutput(item)) continue;
    const parts = textParts(item.output);
    toolOutputs.push({
      type: item.type as string,
      callId: stringOrNull(item.call_id),
      name: stringOrNull(item.call_id) === null ? stringOrNull(item.name) : null,
      output: parts.join('\n'),
      parts,
    });
    if (position > lastUser) toolOutputsSinceUser += 1;
  }

  return {
    ...meta,
    body,
    model: stringOrNull(body.model),
    threadId:
      stringOrNull(meta.headers['thread-id']) ??
      stringOrNull(meta.headers['session-id']) ??
      stringOrNull(metadata.thread_id),
    instructions: developerTexts.join('\n\n'),
    cwd,
    inputKinds: input.map((item) => (item.type === 'message' ? `message:${item.role}` : String(item.type))),
    toolOutputs,
    toolOutputsSinceUser,
    lastUserText,
    unmatched: false,
  };
}

export interface ToolSurface {
  /** The namespaces of the request's additional_tools item, with their tools, in request order. */
  namespaces: { name: string; tools: string[] }[];
  /** The nested tools Code Mode's exec describes (its `### \`name\`` headings); deferred tools may be missing. */
  nested: string[];
}

/** The tools a request offers the model, or null when it has no additional_tools item. */
export function toolSurface(request: ResponsesRequest): ToolSurface | null {
  const input = Array.isArray(request.body.input) ? (request.body.input as Item[]) : [];
  const additional = input.find((item) => item?.type === 'additional_tools');
  if (!additional || !Array.isArray(additional.tools)) return null;
  const namespaces: ToolSurface['namespaces'] = [];
  const nested: string[] = [];
  for (const namespace of additional.tools as Item[]) {
    const tools = Array.isArray(namespace.tools) ? (namespace.tools as Item[]) : [];
    namespaces.push({ name: String(namespace.name), tools: tools.map((tool) => String(tool.name)) });
    const exec = tools.find((tool) => tool.name === 'exec' && tool.type === 'custom');
    if (typeof exec?.description === 'string') {
      nested.push(...[...exec.description.matchAll(/^### `([^`]+)`$/gm)].map((match) => match[1] as string));
    }
  }
  return { namespaces, nested };
}
```

**File:** `packages/testkit/src/codex/responses-server.ts` (new)

```ts
// A local stand-in for the OpenAI Responses API (design 15, 15.1). The real Codex reaches it as a custom model
// provider (codexTestConfig), so adapter, local and M2g tests run real app-server turns with zero model use. Replies
// come from the request's content (thread id, brief markers, the last user text, the tool outputs so far), never
// from the order requests arrive in.
import { DEFAULT_REPLY_TEXT, encodeSse, newId, reply, responseEvents, type ScriptedReply } from './replies';
import { parseResponsesRequest, type ResponsesRequest } from './request';

export type ResponsesHandler = (
  request: ResponsesRequest,
) => ScriptedReply | null | undefined | Promise<ScriptedReply | null | undefined>;

export interface ResponsesServer {
  /** The provider's base_url, http://127.0.0.1:<port>/v1; Codex posts to <url>/responses. */
  url: string;
  /** Every POSTed request, parsed, in arrival order. */
  requests: ResponsesRequest[];
  /** Answers every later request; null restores the default answer. */
  setHandler(handler: ResponsesHandler | null): void;
  close(): Promise<void>;
}

export interface ResponsesRule {
  /** Found in the instructions (the brief) or the last user text. */
  marker?: string;
  threadId?: string;
  /** The number of tool outputs since the last user text. */
  toolOutputs?: number;
  reply: ScriptedReply | ((request: ResponsesRequest) => ScriptedReply | null | undefined);
}

/** A handler that answers with the first rule whose every given condition matches. */
export function rules(list: ResponsesRule[]): ResponsesHandler {
  return (request) => {
    const rule = list.find(
      (candidate) =>
        (candidate.marker === undefined ||
          request.instructions.includes(candidate.marker) ||
          (request.lastUserText ?? '').includes(candidate.marker)) &&
        (candidate.threadId === undefined || request.threadId === candidate.threadId) &&
        (candidate.toolOutputs === undefined || request.toolOutputsSinceUser === candidate.toolOutputs),
    );
    if (!rule) return undefined;
    return typeof rule.reply === 'function' ? rule.reply(request) : rule.reply;
  };
}

const EMPTY_MODEL_LIST = { object: 'list', data: [], models: [] };

export async function startResponsesServer(options: { handler?: ResponsesHandler } = {}): Promise<ResponsesServer> {
  const requests: ResponsesRequest[] = [];
  let handler: ResponsesHandler | null = options.handler ?? null;

  function respond(built: ScriptedReply): Response {
    return new Response(encodeSse(responseEvents(built, newId('resp'))), {
      headers: { 'content-type': 'text/event-stream', ...built.headers },
    });
  }

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    // Held streams and long shell commands stay silent for longer than Bun's default idle limit.
    idleTimeout: 0,
    async fetch(httpRequest) {
      const path = new URL(httpRequest.url).pathname;
      if (httpRequest.method !== 'POST') return Response.json(EMPTY_MODEL_LIST);
      if (!path.endsWith('/responses')) {
        return Response.json({ error: { message: `no such endpoint: ${path}` } }, { status: 404 });
      }
      let body: unknown;
      try {
        body = await httpRequest.json();
      } catch {
        return Response.json({ error: { message: 'the body is not JSON' } }, { status: 400 });
      }
      const request = parseResponsesRequest(body, {
        index: requests.length,
        method: httpRequest.method,
        path,
        headers: Object.fromEntries(httpRequest.headers),
      });
      requests.push(request);
      const built = handler ? await handler(request) : undefined;
      if (!built) request.unmatched = true;
      return respond(built ?? reply.text(DEFAULT_REPLY_TEXT));
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}/v1`,
    requests,
    setHandler(next) {
      handler = next;
    },
    async close() {
      await server.stop(true);
    },
  };
}
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `bun test packages/testkit/test/codex/responses-server.test.ts && bun test && bun run typecheck`
Expected: the task's tests pass (16 pass); then the whole suite passes (`0 fail`) and `tsc` exits 0.

The raw-JavaScript builder is `reply.code`, not `reply.exec`: this repository's security hook refuses any file in which `exec` is directly followed by an opening parenthesis. Codex 0.159.2 sends no top-level `instructions`, so `instructions` collects the developer messages after Codex's base prompt, leaving out blocks that start with `<`. Item and call ids are generated each time a reply streams, so a rule's reply can answer many requests. The server runs with `idleTimeout: 0`, so held streams and long commands are not cut. `toolSurface(request)` lists the namespaces and the tools `exec`'s description declares, for Task 21.

- [ ] **Step 5: Commit**

```bash
git add -A 'packages/testkit/src/codex/index.ts' 'packages/testkit/src/codex/replies.ts' 'packages/testkit/src/codex/request.ts' 'packages/testkit/src/codex/responses-server.ts' 'packages/testkit/test/codex/responses-server.test.ts'
git commit -m 'M2E Task 3: Scripted Responses API provider: server, parsed requests and Code Mode replies' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

### Task 4: Scripted provider failures, holds, rate limits and codexTestConfig

The failure paths the adapter must classify, in the shapes Codex 0.159.2 produced against the provider (design 9.2, 6.10, 15.1): `reply.usageLimit` answers 429 `usage_limit_reached` with the `x-codex-*` rate-limit headers, `reply.httpError` any status, and `reply.failed` a `response.failed` inside a 200 stream. `reply.hang` holds a stream until `server.release(threadId)`, for steer, interrupt and approval tests, and records the client's abort; `rateLimitHeaders(...)` can go with any reply. Compaction requests get a scripted summary by default. `codexTestConfig(url)` is the runner.json `test.codexConfig` that points Codex at the provider, with retries off (X-20).

**Files:**
- Modify: `packages/testkit/src/codex/index.ts`
- Modify: `packages/testkit/src/codex/replies.ts`
- Modify: `packages/testkit/src/codex/request.ts`
- Modify: `packages/testkit/src/codex/responses-server.ts`
- Create: `packages/testkit/src/codex/test-config.ts`
- Test: `packages/testkit/test/codex/failures.test.ts`

- [ ] **Step 1: Write the failing test**

**File:** `packages/testkit/test/codex/failures.test.ts` (new)

```ts
import { afterEach, describe, expect, test } from 'bun:test';
import type { RunnerTestBlock } from '@agflow/runner/src/config';
import {
  codexTestConfig,
  DEFAULT_COMPACTION_SUMMARY,
  DEFAULT_REPLY_TEXT,
  rateLimitHeaders,
  type ResponsesServer,
  reply,
  rules,
  startResponsesServer,
} from '../../src/codex/index';

const servers: ResponsesServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

async function server(): Promise<ResponsesServer> {
  const started = await startResponsesServer();
  servers.push(started);
  return started;
}

const COMPACTION_PROMPT =
  'You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume ' +
  'the task.';

function request(target: ResponsesServer, threadId: string, text = 'hello', init: RequestInit = {}): Promise<Response> {
  return fetch(`${target.url}/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'thread-id': threadId },
    body: JSON.stringify({
      model: 'gpt-6.1-sol',
      input: [
        { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'You are Codex.' }] },
        { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'BRIEF' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
      ],
    }),
    ...init,
  });
}

function events(text: string): { event: string; data: Record<string, any> }[] {
  return text
    .split('\n\n')
    .filter((block) => block.trim())
    .map((block) => ({
      event: block.match(/^event: (.*)$/m)?.[1] ?? '',
      data: JSON.parse(block.match(/^data: (.*)$/m)?.[1] ?? '{}'),
    }));
}

async function until(condition: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the condition');
    await Bun.sleep(10);
  }
}

describe('rateLimitHeaders', () => {
  test('gives the x-codex window and credit headers Codex reads', () => {
    expect(
      rateLimitHeaders({
        primary: { usedPercent: 42.5, windowMinutes: 300, resetAt: 1_793_207_968 },
        secondary: { usedPercent: 10, windowMinutes: 10_080, resetAt: 1_793_290_768 },
        credits: { hasCredits: true, unlimited: false, balance: '12.50' },
        reachedType: 'rate_limit_reached',
      }),
    ).toEqual({
      'x-codex-primary-used-percent': '42.5',
      'x-codex-primary-window-minutes': '300',
      'x-codex-primary-reset-at': '1793207968',
      'x-codex-secondary-used-percent': '10',
      'x-codex-secondary-window-minutes': '10080',
      'x-codex-secondary-reset-at': '1793290768',
      'x-codex-credits-has-credits': 'true',
      'x-codex-credits-unlimited': 'false',
      'x-codex-credits-balance': '12.50',
      'x-codex-rate-limit-reached-type': 'rate_limit_reached',
    });
    expect(rateLimitHeaders({ primary: { usedPercent: 1, windowMinutes: 300, resetAt: 5 } })).toEqual({
      'x-codex-primary-used-percent': '1',
      'x-codex-primary-window-minutes': '300',
      'x-codex-primary-reset-at': '5',
    });
  });

  test('can go with any reply', async () => {
    const scripted = await server();
    const headers = rateLimitHeaders({ primary: { usedPercent: 50, windowMinutes: 300, resetAt: 100 } });
    scripted.setHandler((parsed) => {
      if (parsed.lastUserText === 'text') return { ...reply.text('ok'), headers };
      if (parsed.lastUserText === 'hang') return { ...reply.hang(), headers };
      return { ...reply.failed('server_error', 'x'), headers };
    });
    for (const text of ['text', 'failed', 'hang']) {
      const response = await request(scripted, 't', text);
      expect(response.headers.get('x-codex-primary-used-percent')).toBe('50');
      if (text === 'hang') expect(scripted.release('t')).toBe(1);
      expect(events(await response.text()).at(-1)?.event).toBe(
        text === 'failed' ? 'response.failed' : 'response.completed',
      );
    }
  });
});

describe('failure replies', () => {
  test('usageLimit answers 429 usage_limit_reached with the exhausted window in the headers', async () => {
    const scripted = await server();
    scripted.setHandler(() => reply.usageLimit(1_800));
    const before = Math.floor(Date.now() / 1000);
    const response = await request(scripted, 't');
    const after = Math.floor(Date.now() / 1000);
    expect(response.status).toBe(429);
    const body = (await response.json()) as { error: Record<string, unknown> };
    expect(body.error).toMatchObject({ type: 'usage_limit_reached', resets_in_seconds: 1_800 });
    // The reset is resetInS from when the reply was built, which Task 23's resetsAt assertions rely on.
    const resetsAt = body.error.resets_at as number;
    expect(resetsAt).toBeGreaterThanOrEqual(before + 1_800);
    expect(resetsAt).toBeLessThanOrEqual(after + 1_800);
    expect(response.headers.get('x-codex-primary-used-percent')).toBe('100');
    expect(response.headers.get('x-codex-primary-window-minutes')).toBe('300');
    expect(Number(response.headers.get('x-codex-primary-reset-at'))).toBe(resetsAt);
    // The weekly window is not exhausted and resets a week from now.
    expect(response.headers.get('x-codex-secondary-used-percent')).toBe('40');
    expect(response.headers.get('x-codex-secondary-window-minutes')).toBe('10080');
    const weekly = Number(response.headers.get('x-codex-secondary-reset-at'));
    expect(weekly).toBeGreaterThanOrEqual(before + 7 * 24 * 3600);
    expect(weekly).toBeLessThanOrEqual(after + 7 * 24 * 3600);
  });

  test('httpError answers with its status, body and headers', async () => {
    const scripted = await server();
    scripted.setHandler(() =>
      reply.httpError(500, { error: { type: 'server_error', message: 'boom' } }, { 'retry-after': '1' }),
    );
    const response = await request(scripted, 't');
    expect(response.status).toBe(500);
    expect(response.headers.get('retry-after')).toBe('1');
    expect(await response.json()).toEqual({ error: { type: 'server_error', message: 'boom' } });
  });

  test('failed sends response.failed inside a 200 stream', async () => {
    const scripted = await server();
    scripted.setHandler(() => reply.failed('context_length_exceeded', 'Your input exceeds the context window.'));
    const response = await request(scripted, 't');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toStartWith('text/event-stream');
    const stream = events(await response.text());
    expect(stream.map((event) => event.event)).toEqual(['response.created', 'response.failed']);
    expect(stream[1]?.data.response).toMatchObject({
      status: 'failed',
      error: { code: 'context_length_exceeded', message: 'Your input exceeds the context window.' },
    });
  });
});

describe('holds', () => {
  test('hang holds the stream until release(threadId), then finishes it', async () => {
    const scripted = await server();
    scripted.setHandler(rules([{ threadId: 'held', reply: reply.hang(reply.text('after the hold')) }]));
    const held = request(scripted, 'held').then((response) => response.text());
    const free = await (await request(scripted, 'free')).text();
    expect(events(free).at(-1)?.event).toBe('response.completed');
    let settled = false;
    void held.then(() => {
      settled = true;
    });
    await Bun.sleep(100);
    expect(settled).toBe(false);
    expect(scripted.release('other')).toBe(0);
    expect(scripted.release('held')).toBe(1);
    const stream = events(await held);
    expect(stream.map((event) => event.event)).toEqual([
      'response.created',
      'response.output_item.added',
      'response.output_text.delta',
      'response.output_item.done',
      'response.completed',
    ]);
    expect(stream[2]?.data.delta).toBe('after the hold');
    expect(scripted.requests.map((parsed) => parsed.aborted)).toEqual([false, false]);
  });

  test('the response starts before the hold, and a held request records the client abort', async () => {
    const scripted = await server();
    scripted.setHandler(() => reply.hang());
    const controller = new AbortController();
    const response = await request(scripted, 'held', 'hello', { signal: controller.signal });
    expect(response.status).toBe(200);
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(events(first).map((event) => event.event)).toEqual(['response.created']);
    controller.abort();
    await until(() => scripted.requests[0]?.aborted === true);
    // An aborted hold is gone; releasing it finds nothing.
    expect(scripted.release('held')).toBe(0);
  });

  test('a hold without a thread id is released by release() with no argument, and close finishes every hold', async () => {
    const scripted = await server();
    scripted.setHandler(() => reply.hang());
    const first = fetch(`${scripted.url}/responses`, { method: 'POST', body: JSON.stringify({ input: [] }) });
    const second = request(scripted, 'held');
    await until(() => scripted.requests.length === 2);
    expect(scripted.release()).toBe(2);
    for (const response of [await first, await second]) {
      expect(events(await response.text()).at(-1)?.data.response.output[0].content[0].text).toBe(DEFAULT_REPLY_TEXT);
    }
    const third = request(scripted, 'held').then((response) => response.text());
    await until(() => scripted.requests.length === 3);
    const closing = Date.now();
    await scripted.close();
    servers.splice(servers.indexOf(scripted), 1);
    expect(Date.now() - closing).toBeLessThan(1_500);
    expect(events(await third).at(-1)?.event).toBe('response.completed');
  });
});

describe('compaction', () => {
  test('a compaction request gets a scripted summary by default and is not flagged', async () => {
    const scripted = await server();
    const response = await request(scripted, 't', `${COMPACTION_PROMPT}\n\nInclude:\n- progress`);
    const stream = events(await response.text());
    expect(stream.at(-1)?.data.response.output[0].content[0].text).toBe(DEFAULT_COMPACTION_SUMMARY);
    expect(scripted.requests[0]).toMatchObject({ isCompaction: true, unmatched: false });
    await (await request(scripted, 't')).text();
    expect(scripted.requests[1]).toMatchObject({ isCompaction: false, unmatched: true });
  });

  test('rules skip compaction requests unless a rule asks for them', async () => {
    const scripted = await server();
    scripted.setHandler(
      rules([
        { marker: 'BRIEF', reply: reply.shell({ cmd: 'ls', callId: 'call-ls' }) },
        { compaction: true, marker: 'BRIEF', reply: reply.text('custom summary') },
      ]),
    );
    const compaction = events(await (await request(scripted, 't', COMPACTION_PROMPT)).text());
    expect(compaction.at(-1)?.data.response.output[0].content[0].text).toBe('custom summary');
    const normal = events(await (await request(scripted, 't')).text());
    expect(normal.at(-1)?.data.response.output[0]).toMatchObject({ type: 'custom_tool_call', call_id: 'call-ls' });
    scripted.setHandler(rules([{ marker: 'BRIEF', reply: reply.shell({ cmd: 'ls' }) }]));
    const fallback = events(await (await request(scripted, 't', COMPACTION_PROMPT)).text());
    expect(fallback.at(-1)?.data.response.output[0].content[0].text).toBe(DEFAULT_COMPACTION_SUMMARY);
  });
});

describe('codexTestConfig', () => {
  test('points Codex at the scripted provider with retries off', () => {
    expect(codexTestConfig('http://127.0.0.1:4100/v1', { streamIdleTimeoutMs: 15_000 })).toEqual({
      model_provider: 'agflow_test',
      model_providers: {
        agflow_test: {
          name: 'agflow test',
          base_url: 'http://127.0.0.1:4100/v1',
          wire_api: 'responses',
          requires_openai_auth: false,
          request_max_retries: 0,
          stream_max_retries: 0,
          stream_idle_timeout_ms: 15_000,
        },
      },
    });
  });

  test("is runner.json's test.codexConfig as it is", () => {
    // A compile-time check as much as a runtime one: the value fits the block's type without a cast.
    const block: RunnerTestBlock['codexConfig'] = codexTestConfig('http://127.0.0.1:4100/v1');
    expect(block).toEqual(codexTestConfig('http://127.0.0.1:4100/v1'));
  });

  test("defaults the stream idle timeout to Codex's own and takes a server's url", async () => {
    const scripted = await server();
    const config = codexTestConfig(scripted.url);
    expect(config.model_providers.agflow_test.base_url).toBe(scripted.url);
    expect(config.model_providers.agflow_test.stream_idle_timeout_ms).toBe(300_000);
  });
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `bun test packages/testkit/test/codex/failures.test.ts`
Expected: FAIL — `SyntaxError: Export named 'DEFAULT_COMPACTION_SUMMARY' not found in module 'packages/testkit/src/codex/index.ts'.` (0 pass, 1 fail, 1 error)

- [ ] **Step 3: Implement**

**File:** `packages/testkit/src/codex/index.ts` (change)

```diff
diff --git a/packages/testkit/src/codex/index.ts b/packages/testkit/src/codex/index.ts
index 64b023ab..d055acbf 100644
--- a/packages/testkit/src/codex/index.ts
+++ b/packages/testkit/src/codex/index.ts
@@ -1,7 +1,27 @@
 // The scripted Responses API provider for Codex tests (design 15.1). Consumers import @agflow/testkit/src/codex/index;
 // it is not part of the testkit's main entry.
-export { DEFAULT_REPLY_TEXT, type OutputItem, reply, type ScriptedReply, type ShellReplyOptions } from './replies';
-export { type ResponsesRequest, type ResponsesToolOutput, type ToolSurface, toolSurface } from './request';
+export {
+  DEFAULT_COMPACTION_SUMMARY,
+  DEFAULT_REPLY_TEXT,
+  type FailedReply,
+  type HangReply,
+  type HttpReply,
+  type OutputItem,
+  type RateLimitHeadersOptions,
+  type RateLimitWindowHeaders,
+  rateLimitHeaders,
+  reply,
+  type ScriptedReply,
+  type ShellReplyOptions,
+  type StreamReply,
+} from './replies';
+export {
+  COMPACTION_PROMPT_PREFIX,
+  type ResponsesRequest,
+  type ResponsesToolOutput,
+  type ToolSurface,
+  toolSurface,
+} from './request';
 export {
   type ResponsesHandler,
   type ResponsesRule,
@@ -9,3 +29,4 @@ export {
   rules,
   startResponsesServer,
 } from './responses-server';
+export { type CodexTestConfig, codexTestConfig } from './test-config';
```

**File:** `packages/testkit/src/codex/replies.ts` (change)

```diff
diff --git a/packages/testkit/src/codex/replies.ts b/packages/testkit/src/codex/replies.ts
index 74e5d25e..81957218 100644
--- a/packages/testkit/src/codex/replies.ts
+++ b/packages/testkit/src/codex/replies.ts
@@ -1,7 +1,7 @@
 // Reply builders for the scripted Responses API (design 15.1). With the pinned slug, Codex 0.159.2 runs Code Mode:
 // the model has one freeform `exec` tool that runs JavaScript, and exec_command, write_stdin, apply_patch and the MCP
 // tools (tools.mcp__agflow__<tool>) are nested inside it. So a scripted tool call is a custom_tool_call named exec
-// whose input is JavaScript.
+// whose input is JavaScript. The failure replies have the shapes Codex 0.159.2 classified in the probes.
 import { randomUUID } from 'node:crypto';
 
 /** A Responses API output item; ids are added when the reply is streamed. */
@@ -16,11 +16,78 @@ export interface StreamReply {
   headers?: Record<string, string>;
 }
 
-export type ScriptedReply = StreamReply;
+/** A plain HTTP answer, the way the API refuses a request before streaming: 429, 500, 401. */
+export interface HttpReply {
+  kind: 'http';
+  status: number;
+  body: unknown;
+  headers?: Record<string, string>;
+}
+
+/** A 200 stream that fails: response.created, then response.failed with this error. */
+export interface FailedReply {
+  kind: 'failed';
+  code: string;
+  message: string;
+  headers?: Record<string, string>;
+}
+
+/** A stream held open after response.created until the server releases its thread; then the rest of `then`. */
+export interface HangReply {
+  kind: 'hang';
+  then?: StreamReply;
+  headers?: Record<string, string>;
+}
+
+export type ScriptedReply = StreamReply | HttpReply | FailedReply | HangReply;
 
 /** What a request gets when no handler answers it. */
 export const DEFAULT_REPLY_TEXT = 'Done.';
 
+/** What a compaction request gets when no handler answers it. */
+export const DEFAULT_COMPACTION_SUMMARY =
+  'Summary of the scripted conversation so far: nothing remains to carry over. Continue with the task.';
+
+export interface RateLimitWindowHeaders {
+  usedPercent: number;
+  windowMinutes: number;
+  /** Epoch seconds. */
+  resetAt: number;
+}
+
+export interface RateLimitHeadersOptions {
+  primary?: RateLimitWindowHeaders;
+  secondary?: RateLimitWindowHeaders;
+  credits?: { hasCredits: boolean; unlimited: boolean; balance?: string };
+  /** rate_limit_reached, or one of the workspace credit and usage-limit kinds. */
+  reachedType?: string;
+}
+
+/**
+ * The x-codex-* headers Codex 0.159.2 turns into account/rateLimits/updated (the probes saw used percent rounded,
+ * window minutes and resetsAt in epoch seconds). They can go with any reply.
+ */
+export function rateLimitHeaders(options: RateLimitHeadersOptions): Record<string, string> {
+  const headers: Record<string, string> = {};
+  for (const name of ['primary', 'secondary'] as const) {
+    const window = options[name];
+    if (!window) continue;
+    headers[`x-codex-${name}-used-percent`] = String(window.usedPercent);
+    headers[`x-codex-${name}-window-minutes`] = String(window.windowMinutes);
+    headers[`x-codex-${name}-reset-at`] = String(window.resetAt);
+  }
+  if (options.credits) {
+    headers['x-codex-credits-has-credits'] = String(options.credits.hasCredits);
+    headers['x-codex-credits-unlimited'] = String(options.credits.unlimited);
+    if (options.credits.balance !== undefined) headers['x-codex-credits-balance'] = options.credits.balance;
+  }
+  if (options.reachedType) headers['x-codex-rate-limit-reached-type'] = options.reachedType;
+  return headers;
+}
+
+const FIVE_HOURS_MINUTES = 300;
+const WEEK_MINUTES = 10_080;
+
 /** exec_command yields after at most 30 s; a longer command is polled with write_stdin. */
 const EXEC_COMMAND_MAX_YIELD_MS = 30_000;
 const EXEC_COMMAND_MIN_YIELD_MS = 250;
@@ -122,6 +189,47 @@ export const reply = {
     return execCall(source, options.callId);
   },
 
+  /**
+   * The subscription limit as the ChatGPT backend reports it: 429 usage_limit_reached, with the five-hour window at
+   * 100% until resetInS from now. Codex reports it as usageLimitExceeded.
+   */
+  usageLimit(resetInS: number): HttpReply {
+    const now = Math.floor(Date.now() / 1000);
+    const resetAt = now + resetInS;
+    return {
+      kind: 'http',
+      status: 429,
+      body: {
+        error: {
+          type: 'usage_limit_reached',
+          message: 'You have hit your usage limit.',
+          plan_type: 'plus',
+          resets_at: resetAt,
+          resets_in_seconds: resetInS,
+        },
+      },
+      headers: rateLimitHeaders({
+        primary: { usedPercent: 100, windowMinutes: FIVE_HOURS_MINUTES, resetAt },
+        secondary: { usedPercent: 40, windowMinutes: WEEK_MINUTES, resetAt: now + WEEK_MINUTES * 60 },
+      }),
+    };
+  },
+
+  /** Any HTTP error: a 500 becomes internalServerError, a 401 httpConnectionFailed with that status. */
+  httpError(status: number, body: unknown, headers: Record<string, string> = {}): HttpReply {
+    return { kind: 'http', status, body, headers };
+  },
+
+  /** An in-stream failure: context_length_exceeded becomes contextWindowExceeded (a 400 with it is only 'other'). */
+  failed(code: string, message: string): FailedReply {
+    return { kind: 'failed', code, message };
+  },
+
+  /** Holds the turn open, for steer, interrupt and approval tests, until ResponsesServer.release. */
+  hang(then?: StreamReply): HangReply {
+    return { kind: 'hang', ...(then ? { then } : {}) };
+  },
+
   /** A direct function call, outside exec: wait, or a collaboration tool with its namespace. */
   functionCall(options: {
     name: string;
```

**File:** `packages/testkit/src/codex/request.ts` (change)

```diff
diff --git a/packages/testkit/src/codex/request.ts b/packages/testkit/src/codex/request.ts
index c15747f0..92d2b561 100644
--- a/packages/testkit/src/codex/request.ts
+++ b/packages/testkit/src/codex/request.ts
@@ -37,12 +37,19 @@ export interface ResponsesRequest {
   toolOutputsSinceUser: number;
   /** The newest user message that is not context Codex adds itself; null when there is none. */
   lastUserText: string | null;
-  /** Answered by the default reply: no handler, or the handler returned nothing. */
+  /** Codex's own compaction request: the last user text is its checkpoint prompt. */
+  isCompaction: boolean;
+  /** Answered by the default reply: no handler, or the handler returned nothing. Compactions are never flagged. */
   unmatched: boolean;
+  /** The client dropped a held stream before it was released: an interrupt, a stop or a stream timeout. */
+  aborted: boolean;
 }
 
 type Item = Record<string, unknown>;
 
+/** How Codex 0.159.2's compaction prompt starts (the 2026-10-28 probes). */
+export const COMPACTION_PROMPT_PREFIX = 'You are performing a CONTEXT CHECKPOINT COMPACTION';
+
 /** User messages Codex writes itself; they are not what a person or the runner said. */
 const CONTEXT_PREFIXES = ['<environment_context>', '# AGENTS.md instructions'];
 
@@ -129,7 +136,9 @@ export function parseResponsesRequest(
     toolOutputs,
     toolOutputsSinceUser,
     lastUserText,
+    isCompaction: (lastUserText ?? '').startsWith(COMPACTION_PROMPT_PREFIX),
     unmatched: false,
+    aborted: false,
   };
 }
 
```

**File:** `packages/testkit/src/codex/responses-server.ts` (change)

```diff
diff --git a/packages/testkit/src/codex/responses-server.ts b/packages/testkit/src/codex/responses-server.ts
index 8dd5e2cf..a7fe65d9 100644
--- a/packages/testkit/src/codex/responses-server.ts
+++ b/packages/testkit/src/codex/responses-server.ts
@@ -2,7 +2,16 @@
 // provider (codexTestConfig), so adapter, local and M2g tests run real app-server turns with zero model use. Replies
 // come from the request's content (thread id, brief markers, the last user text, the tool outputs so far), never
 // from the order requests arrive in.
-import { DEFAULT_REPLY_TEXT, encodeSse, newId, reply, responseEvents, type ScriptedReply } from './replies';
+import {
+  DEFAULT_COMPACTION_SUMMARY,
+  DEFAULT_REPLY_TEXT,
+  encodeSse,
+  type HangReply,
+  newId,
+  reply,
+  responseEvents,
+  type ScriptedReply,
+} from './replies';
 import { parseResponsesRequest, type ResponsesRequest } from './request';
 
 export type ResponsesHandler = (
@@ -14,8 +23,11 @@ export interface ResponsesServer {
   url: string;
   /** Every POSTed request, parsed, in arrival order. */
   requests: ResponsesRequest[];
-  /** Answers every later request; null restores the default answer. */
+  /** Answers every later request; null restores the default answers. */
   setHandler(handler: ResponsesHandler | null): void;
+  /** Lets the held streams of a thread, or without a thread id every held stream, finish; gives their number. */
+  release(threadId?: string): number;
+  /** Lets every held stream finish, then ends the server; a stream still open after a short wait is cut. */
   close(): Promise<void>;
 }
 
@@ -25,6 +37,8 @@ export interface ResponsesRule {
   threadId?: string;
   /** The number of tool outputs since the last user text. */
   toolOutputs?: number;
+  /** True for a rule that answers Codex's compaction requests; other rules never match them. */
+  compaction?: boolean;
   reply: ScriptedReply | ((request: ResponsesRequest) => ScriptedReply | null | undefined);
 }
 
@@ -33,6 +47,7 @@ export function rules(list: ResponsesRule[]): ResponsesHandler {
   return (request) => {
     const rule = list.find(
       (candidate) =>
+        (candidate.compaction ?? false) === request.isCompaction &&
         (candidate.marker === undefined ||
           request.instructions.includes(candidate.marker) ||
           (request.lastUserText ?? '').includes(candidate.marker)) &&
@@ -46,14 +61,74 @@ export function rules(list: ResponsesRule[]): ResponsesHandler {
 
 const EMPTY_MODEL_LIST = { object: 'list', data: [], models: [] };
 
+/** How long close() waits for the released streams before it cuts them. */
+const CLOSE_GRACE_MS = 500;
+
+interface Hold {
+  threadId: string | null;
+  release(): void;
+}
+
 export async function startResponsesServer(options: { handler?: ResponsesHandler } = {}): Promise<ResponsesServer> {
   const requests: ResponsesRequest[] = [];
+  const holds = new Set<Hold>();
   let handler: ResponsesHandler | null = options.handler ?? null;
 
-  function respond(built: ScriptedReply): Response {
-    return new Response(encodeSse(responseEvents(built, newId('resp'))), {
-      headers: { 'content-type': 'text/event-stream', ...built.headers },
+  const sse = (body: string | ReadableStream<Uint8Array>, headers: Record<string, string> = {}) =>
+    new Response(body, { headers: { 'content-type': 'text/event-stream', ...headers } });
+
+  /** Sends response.created at once, waits for a release, then sends the rest of the reply. */
+  function held(request: ResponsesRequest, built: HangReply, signal: AbortSignal): Response {
+    const events = responseEvents(built.then ?? reply.text(DEFAULT_REPLY_TEXT), newId('resp'));
+    const encoder = new TextEncoder();
+    let hold: Hold | undefined;
+    const ended = () => {
+      if (hold && holds.delete(hold)) request.aborted = true;
+    };
+    signal.addEventListener('abort', ended);
+    const body = new ReadableStream<Uint8Array>({
+      start(controller) {
+        controller.enqueue(encoder.encode(encodeSse(events.slice(0, 1))));
+        hold = {
+          threadId: request.threadId,
+          release() {
+            holds.delete(this);
+            signal.removeEventListener('abort', ended);
+            try {
+              controller.enqueue(encoder.encode(encodeSse(events.slice(1))));
+              controller.close();
+            } catch {
+              // The client went away while the hold was being released.
+            }
+          },
+        };
+        holds.add(hold);
+      },
+      cancel: ended,
     });
+    return sse(body, built.headers);
+  }
+
+  function respond(request: ResponsesRequest, built: ScriptedReply, signal: AbortSignal): Response {
+    switch (built.kind) {
+      case 'stream':
+        return sse(encodeSse(responseEvents(built, newId('resp'))), built.headers);
+      case 'http':
+        return Response.json(built.body, { status: built.status, headers: built.headers });
+      case 'failed': {
+        const id = newId('resp');
+        const events = [
+          { type: 'response.created', response: { id, status: 'in_progress', output: [] } },
+          {
+            type: 'response.failed',
+            response: { id, status: 'failed', output: [], error: { code: built.code, message: built.message } },
+          },
+        ];
+        return sse(encodeSse(events), built.headers);
+      }
+      case 'hang':
+        return held(request, built, signal);
+    }
   }
 
   const server = Bun.serve({
@@ -81,18 +156,30 @@ export async function startResponsesServer(options: { handler?: ResponsesHandler
       });
       requests.push(request);
       const built = handler ? await handler(request) : undefined;
-      if (!built) request.unmatched = true;
-      return respond(built ?? reply.text(DEFAULT_REPLY_TEXT));
+      // A compaction is auxiliary: its default summary is a harmless answer, not a missed script step.
+      if (!built && !request.isCompaction) request.unmatched = true;
+      const fallback = reply.text(request.isCompaction ? DEFAULT_COMPACTION_SUMMARY : DEFAULT_REPLY_TEXT);
+      return respond(request, built ?? fallback, httpRequest.signal);
     },
   });
 
+  function release(threadId?: string): number {
+    const matching = [...holds].filter((hold) => threadId === undefined || hold.threadId === threadId);
+    for (const hold of matching) hold.release();
+    return matching.length;
+  }
+
   return {
     url: `http://127.0.0.1:${server.port}/v1`,
     requests,
     setHandler(next) {
       handler = next;
     },
+    release,
     async close() {
+      release();
+      // A graceful stop lets the released streams reach their clients; a forced one would cut them.
+      await Promise.race([server.stop(), Bun.sleep(CLOSE_GRACE_MS)]);
       await server.stop(true);
     },
   };
```

**File:** `packages/testkit/src/codex/test-config.ts` (new)

```ts
// runner.json's test.codexConfig for the scripted provider (design 15.1). The runner passes each top-level key to
// app-server as a -c flag in test mode; no Codex home's config.toml is written.

// A type alias, not an interface: only an object-literal type fits test.codexConfig's Record<string, JSON> as it is.
export type CodexTestConfig = {
  model_provider: 'agflow_test';
  model_providers: {
    agflow_test: {
      name: string;
      base_url: string;
      wire_api: 'responses';
      requires_openai_auth: false;
      request_max_retries: number;
      stream_max_retries: number;
      stream_idle_timeout_ms: number;
    };
  };
};

/** Codex's own default; a test of a stalled stream passes a short one. */
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000;

/**
 * Points Codex at a scripted Responses server (its url, ending in /v1). Retries are off, so every scripted failure
 * reaches the adapter at once, as the final error.
 */
export function codexTestConfig(url: string, options: { streamIdleTimeoutMs?: number } = {}): CodexTestConfig {
  return {
    model_provider: 'agflow_test',
    model_providers: {
      agflow_test: {
        name: 'agflow test',
        base_url: url,
        wire_api: 'responses',
        requires_openai_auth: false,
        request_max_retries: 0,
        stream_max_retries: 0,
        stream_idle_timeout_ms: options.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
      },
    },
  };
}
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `bun test packages/testkit/test/codex/failures.test.ts && bun test && bun run typecheck`
Expected: the task's tests pass (13 pass); then the whole suite passes (`0 fail`) and `tsc` exits 0.

A provider 400 `context_length_exceeded` arrived only as `other`; `reply.failed('context_length_exceeded', ...)` is what gives `contextWindowExceeded`. `rules()` skips compaction requests unless a rule sets `compaction: true`, so a marker rule never answers a compaction with a tool call. `CodexTestConfig` is declared in testkit, and its test checks it against `RunnerTestBlock['codexConfig']` through a type-only import, so the codex entry imports nothing from the runner. `close()` releases every hold first and returns within about 1.5 s.

- [ ] **Step 5: Commit**

```bash
git add -A 'packages/testkit/src/codex/index.ts' 'packages/testkit/src/codex/replies.ts' 'packages/testkit/src/codex/request.ts' 'packages/testkit/src/codex/responses-server.ts' 'packages/testkit/src/codex/test-config.ts' 'packages/testkit/test/codex/failures.test.ts'
git commit -m 'M2E Task 4: Scripted provider failures, holds, rate limits and codexTestConfig' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

### Task 5: JSON-RPC client for app-server

`CodexRpc` is the line-delimited JSON-RPC transport over app-server's stdin and stdout, typed by the method map (design 9.1, 9.3). It matches responses by id with per-request timeouts, delivers notifications in order, and answers every server request exactly once: -32601 when no handler claims it, -32603 when one throws, and a deferred answer once, never after close. It never reads stderr; the caller drains it.

**Files:**
- Create: `packages/runner/src/adapters/codex/rpc.ts`
- Test: `packages/runner/test/codex/rpc.test.ts`

- [ ] **Step 1: Write the failing test**

**File:** `packages/runner/test/codex/rpc.test.ts` (new)

```ts
import { describe, expect, test } from 'bun:test';
import type { ServerNotification } from '../../src/adapters/codex/protocol';
import { CodexRpc, RpcClosed, RpcError, RpcTimeout } from '../../src/adapters/codex/rpc';
import { memoryLogger } from '../../src/log';

const encoder = new TextEncoder();

/** An in-memory app-server: the test writes its stdout and reads what the client wrote to its stdin. */
function fakePeer(options: { maxLineBytes?: number; requestTimeoutMs?: number } = {}) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stdout = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const written: string[] = [];
  let ended = false;
  const stdin = {
    write(data: string) {
      written.push(data);
      return data.length;
    },
    flush() {
      return 0;
    },
    end() {
      ended = true;
      return 0;
    },
  };
  const logger = memoryLogger();
  const rpc = new CodexRpc({ stdin, stdout, logger, ...options });
  return {
    rpc,
    logger,
    /** Raw bytes on the client's stdout side. */
    send(text: string | Uint8Array) {
      controller.enqueue(typeof text === 'string' ? encoder.encode(text) : text);
    },
    /** Messages as lines. */
    line(...messages: unknown[]) {
      controller.enqueue(encoder.encode(messages.map((message) => `${JSON.stringify(message)}\n`).join('')));
    },
    finish() {
      controller.close();
    },
    /** What the client wrote, one parsed message per line. */
    written(): Record<string, unknown>[] {
      const text = written.join('');
      expect(text === '' || text.endsWith('\n')).toBe(true);
      return text
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    },
    get stdinEnded() {
      return ended;
    },
  };
}

/** What a promise rejected with, or what it resolved to. */
const failure = (promise: Promise<unknown>) => promise.catch((caught: unknown) => caught);

/** Lets the client's read loop take what was sent. */
const settle = () => Bun.sleep(5);

const turnCompleted = (threadId: string, turnId: string): ServerNotification => ({
  method: 'turn/completed',
  params: {
    threadId,
    turn: {
      id: turnId,
      items: [],
      itemsView: 'notLoaded',
      status: 'completed',
      error: null,
      startedAt: 1,
      completedAt: 2,
      durationMs: 1000,
    },
  },
});

describe('requests', () => {
  test('are written as one JSON line each, without params when there are none', async () => {
    const peer = fakePeer();
    const requests = [
      peer.rpc.request('thread/delete', { threadId: 't-1' }),
      peer.rpc.request('account/rateLimits/read', undefined),
    ];
    peer.rpc.notify('initialized');
    expect(peer.written()).toEqual([
      { id: 1, method: 'thread/delete', params: { threadId: 't-1' } },
      { id: 2, method: 'account/rateLimits/read' },
      { method: 'initialized' },
    ]);
    peer.rpc.close();
    for (const request of requests) expect(await failure(request)).toBeInstanceOf(RpcClosed);
  });

  test('responses are matched by id when they arrive out of order', async () => {
    const peer = fakePeer();
    const first = peer.rpc.request('thread/name/set', { threadId: 't-1', name: 'agflow T-1-a1' });
    const second = peer.rpc.request('turn/steer', {
      threadId: 't-1',
      expectedTurnId: 'turn-1',
      input: [{ type: 'text', text: 'hello', text_elements: [] }],
    });
    peer.line({ id: 2, result: { turnId: 'turn-1' } }, { id: 1, result: {} });
    expect(await second).toEqual({ turnId: 'turn-1' });
    expect(await first).toEqual({});
  });

  test('a timed-out request rejects and its late response is ignored', async () => {
    const peer = fakePeer();
    const slow = peer.rpc.request('thread/delete', { threadId: 't-1' }, { timeoutMs: 20 });
    const error = await failure(slow);
    expect(error).toBeInstanceOf(RpcTimeout);
    expect(error).toMatchObject({ method: 'thread/delete', timeoutMs: 20 });
    const next = peer.rpc.request('thread/delete', { threadId: 't-2' });
    peer.line({ id: 1, result: { late: true } }, { id: 2, result: {} });
    expect(await next).toEqual({});
    expect(peer.logger.entries.filter((entry) => entry.level === 'warn')).toEqual([]);
  });

  test('the default timeout comes from the options', async () => {
    const peer = fakePeer({ requestTimeoutMs: 20 });
    expect(await failure(peer.rpc.request('thread/delete', { threadId: 't-1' }))).toBeInstanceOf(RpcTimeout);
  });

  test('an error response surfaces as RpcError with its code, message and data', async () => {
    const peer = fakePeer();
    const steer = peer.rpc.request('turn/steer', {
      threadId: 't-1',
      expectedTurnId: 'turn-1',
      input: [{ type: 'text', text: 'hello', text_elements: [] }],
    });
    const data = { codexErrorInfo: { activeTurnNotSteerable: { turnKind: 'compact' } } };
    peer.line({ id: 1, error: { code: -32600, message: 'turn is not steerable', data } });
    const error = await failure(steer);
    expect(error).toBeInstanceOf(RpcError);
    expect(error).toMatchObject({ method: 'turn/steer', code: -32600, message: 'turn is not steerable', data });
    // Kept as is: the very object the peer sent, parsed.
    expect((error as RpcError).data).toEqual(data);
  });

  test('an error without data has data undefined', async () => {
    const peer = fakePeer();
    const read = peer.rpc.request('account/rateLimits/read', undefined);
    peer.line({ id: 1, error: { code: -32600, message: 'codex account authentication required to read rate limits' } });
    expect(await failure(read)).toMatchObject({ code: -32600, data: undefined });
  });

  test('the awaiting caller runs before the messages that follow its response are delivered', async () => {
    const peer = fakePeer();
    const order: string[] = [];
    peer.rpc.onNotification((notification) => order.push(notification.method));
    const started = peer.rpc.request('turn/start', { threadId: 't-1', input: [] }).then(() => order.push('answer'));
    peer.line(
      { id: 1, result: { turn: { id: 'turn-1' } } },
      { method: 'turn/started', params: { threadId: 't-1', turn: { id: 'turn-1' } } },
    );
    await started;
    await settle();
    expect(order).toEqual(['answer', 'turn/started']);
  });
});

describe('framing', () => {
  test('JSON split across chunks, multibyte characters included, and several messages in one chunk', async () => {
    const peer = fakePeer();
    const methods: string[] = [];
    const params: unknown[] = [];
    peer.rpc.onNotification((notification) => {
      methods.push(notification.method);
      params.push(notification.params);
    });
    const bytes = encoder.encode(
      `${JSON.stringify({ method: 'warning', params: { threadId: null, message: 'ünïcødé ✓' } })}\n`,
    );
    const cut = bytes.indexOf(0xc3) + 1;
    peer.send(bytes.subarray(0, cut));
    await settle();
    peer.send(bytes.subarray(cut));
    peer.line(turnCompleted('t-1', 'turn-1'), { method: 'thread/status/changed', params: { threadId: 't-1' } });
    peer.send('\n\r\n');
    await settle();
    expect(methods).toEqual(['warning', 'turn/completed', 'thread/status/changed']);
    // Decoded as one line, not chunk by chunk, which would turn each half of the cut 'ü' into U+FFFD.
    expect(params[0]).toEqual({ threadId: null, message: 'ünïcødé ✓' });
    expect(peer.logger.entries.filter((entry) => entry.level === 'warn')).toEqual([]);
  });

  test('a line over the size cap and invalid JSON give a warning and parsing continues', async () => {
    const peer = fakePeer({ maxLineBytes: 64 });
    const seen: unknown[] = [];
    peer.rpc.onNotification((notification) => seen.push(notification.params));
    const long = JSON.stringify({ method: 'warning', params: { message: 'x'.repeat(200) } });
    peer.send(long.slice(0, 100));
    await settle();
    peer.send(`${long.slice(100)}\n`);
    peer.send('{not json\n');
    peer.send('[1,2]\n');
    peer.line({ method: 'warning', params: { message: 'short' } });
    await settle();
    expect(seen).toEqual([{ message: 'short' }]);
    expect(peer.logger.entries.filter((entry) => entry.level === 'warn').map((entry) => entry.message)).toEqual([
      'codex rpc: line over the size cap dropped',
      'codex rpc: line is not JSON',
      'codex rpc: message of no known kind',
    ]);
  });

  test('a response over the size cap rejects its request at once, naming the cap', async () => {
    const peer = fakePeer({ maxLineBytes: 64 });
    const request = peer.rpc.request('thread/resume', { threadId: 't-1' }, { timeoutMs: 60_000 });
    const failed = peer.rpc.request('thread/delete', { threadId: 't-1' }, { timeoutMs: 60_000 });
    const after = peer.rpc.request('thread/delete', { threadId: 't-2' });
    const started = Date.now();
    peer.line(
      { id: 1, result: { padding: 'x'.repeat(100) } },
      { id: 2, error: { code: -32600, message: 'y'.repeat(100) } },
      { id: 3, result: {} },
    );
    for (const [promise, method] of [
      [request, 'thread/resume'],
      [failed, 'thread/delete'],
    ] as const) {
      const error = await failure(promise);
      expect(error).toBeInstanceOf(RpcError);
      expect(error).toMatchObject({ method, code: -32603 });
      expect((error as RpcError).message).toContain('64-byte');
    }
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(await after).toEqual({});
  });

  test('a server request over the size cap is answered -32603, and later requests still get their answers', async () => {
    const peer = fakePeer({ maxLineBytes: 256 });
    const seen: unknown[] = [];
    peer.rpc.handle('item/commandExecution/requestApproval', (params, id) => {
      seen.push(id);
      return { decision: 'decline' };
    });
    const request = (id: number | string, command: string) => ({
      id,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 't-1', turnId: 'turn-1', itemId: `item-${id}`, startedAtMs: 1, command },
    });
    // As app-server writes it: the id first. A string id may hold escaped quotes.
    peer.send(`${JSON.stringify(request(7, 'x'.repeat(1_024)))}\n`);
    peer.send(`${JSON.stringify(request('a"b', 'y'.repeat(1_024)))}\n`);
    peer.line(request(8, 'ls'));
    await settle();
    expect(seen).toEqual([8]);
    expect(peer.written()).toEqual([
      { id: 7, error: { code: -32603, message: 'message over the size cap' } },
      { id: 'a"b', error: { code: -32603, message: 'message over the size cap' } },
      { id: 8, result: { decision: 'decline' } },
    ]);
  });
});

describe('server requests', () => {
  const approval = (id: number | string) => ({
    id,
    method: 'item/fileChange/requestApproval',
    params: { threadId: 't-1', turnId: 'turn-1', itemId: 'item-1', startedAtMs: 1 },
  });

  test('a request that no handler claims gets -32601', async () => {
    const peer = fakePeer();
    peer.line(approval(0), { id: 'x-1', method: 'item/tool/call', params: {} });
    await settle();
    expect(peer.written()).toEqual([
      { id: 0, error: { code: -32601, message: 'unhandled server request: item/fileChange/requestApproval' } },
      { id: 'x-1', error: { code: -32601, message: 'unhandled server request: item/tool/call' } },
    ]);
  });

  test('a handler gets the params and the request id, and its answer is written once', async () => {
    const peer = fakePeer();
    const calls: unknown[] = [];
    peer.rpc.handle('item/fileChange/requestApproval', (params, id) => {
      calls.push([params.itemId, id]);
      return { decision: 'decline' };
    });
    peer.line(approval(3));
    await settle();
    expect(calls).toEqual([['item-1', 3]]);
    expect(peer.written()).toEqual([{ id: 3, result: { decision: 'decline' } }]);
  });

  test('a throwing or rejecting handler gets -32603', async () => {
    const peer = fakePeer();
    peer.rpc.handle('item/fileChange/requestApproval', () => {
      throw new Error('boom');
    });
    peer.rpc.handle('item/tool/requestUserInput', async () => {
      throw new Error('later boom');
    });
    const params = { threadId: 't-1', turnId: 'turn-1', itemId: 'i', questions: [], isBlocking: true };
    peer.line(approval(1), { id: 2, method: 'item/tool/requestUserInput', params: { ...params, autoResolutionMs: 0 } });
    await settle();
    expect(peer.written()).toEqual([
      { id: 1, error: { code: -32603, message: 'boom' } },
      { id: 2, error: { code: -32603, message: 'later boom' } },
    ]);
  });

  test('a deferred answer is written when it resolves, and never after close', async () => {
    const peer = fakePeer();
    const answers: ((value: { decision: 'accept' }) => void)[] = [];
    peer.rpc.handle(
      'item/fileChange/requestApproval',
      () => new Promise<{ decision: 'accept' }>((resolve) => answers.push(resolve)),
    );
    peer.line(approval(1), approval(2));
    await settle();
    expect(peer.written()).toEqual([]);
    answers[0]?.({ decision: 'accept' });
    answers[0]?.({ decision: 'accept' });
    await settle();
    expect(peer.written()).toEqual([{ id: 1, result: { decision: 'accept' } }]);
    peer.rpc.close();
    answers[1]?.({ decision: 'accept' });
    await settle();
    expect(peer.written()).toEqual([{ id: 1, result: { decision: 'accept' } }]);
  });

  test('a repeated request id is answered once', async () => {
    const peer = fakePeer();
    let calls = 0;
    peer.rpc.handle('item/fileChange/requestApproval', () => {
      calls += 1;
      return { decision: 'decline' };
    });
    peer.line(approval(5), approval(5));
    await settle();
    expect(calls).toBe(1);
    expect(peer.written()).toEqual([{ id: 5, result: { decision: 'decline' } }]);
    expect(peer.logger.entries.map((entry) => entry.message)).toContain('codex rpc: repeated server request id');
  });
});

describe('notifications and close', () => {
  test('reach every listener in arrival order, past a listener that throws', async () => {
    const peer = fakePeer();
    const all: string[] = [];
    const completed: string[] = [];
    peer.rpc.onNotification(() => {
      throw new Error('listener bug');
    });
    peer.rpc.onNotification((notification) => all.push(notification.method));
    const off = peer.rpc.on('turn/completed', (params) => completed.push(params.turn.id));
    peer.line(
      { method: 'thread/status/changed', params: { threadId: 't-1', status: { type: 'idle' } } },
      turnCompleted('t-1', 'turn-1'),
      { method: 'serverRequest/resolved', params: { threadId: 't-1', requestId: 0 } },
    );
    await settle();
    off();
    peer.line(turnCompleted('t-1', 'turn-2'));
    await settle();
    expect(all).toEqual(['thread/status/changed', 'turn/completed', 'serverRequest/resolved', 'turn/completed']);
    expect(completed).toEqual(['turn-1']);
    expect(peer.logger.entries.filter((entry) => entry.message === 'codex rpc: listener failed')).toHaveLength(4);
  });

  test('when stdout ends, pending requests reject with RpcClosed and later writes are dropped', async () => {
    const peer = fakePeer();
    const pending = peer.rpc.request('thread/start', { cwd: '/tmp/clone' });
    peer.finish();
    await peer.rpc.ended;
    const error = await failure(pending);
    expect(error).toBeInstanceOf(RpcClosed);
    expect(error).toMatchObject({ method: 'thread/start' });
    expect(peer.rpc.closed).toBe(true);
    const before = peer.written().length;
    expect(await failure(peer.rpc.request('thread/delete', { threadId: 't' }))).toBeInstanceOf(RpcClosed);
    peer.rpc.notify('initialized');
    expect(peer.written()).toHaveLength(before);
  });

  test('close() ends stdin, rejects pending requests and delivers nothing more', async () => {
    const peer = fakePeer();
    const seen: string[] = [];
    peer.rpc.onNotification((notification) => seen.push(notification.method));
    const pending = peer.rpc.request('turn/interrupt', { threadId: 't-1', turnId: 'turn-1' });
    peer.rpc.close();
    peer.rpc.close();
    expect(peer.stdinEnded).toBe(true);
    expect(await failure(pending)).toBeInstanceOf(RpcClosed);
    // The rest of stdout is still read, so the peer never blocks on a full pipe, but nothing is delivered.
    peer.line(turnCompleted('t-1', 'turn-1'), { id: 1, result: {} });
    peer.finish();
    await peer.rpc.ended;
    expect(seen).toEqual([]);
  });

  test('a failing stdout ends the client like its end does', async () => {
    const failing = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('EIO'));
      },
    });
    const rpc = new CodexRpc({ stdin: { write: () => 0, end: () => 0 }, stdout: failing, logger: memoryLogger() });
    const pending = rpc.request('thread/delete', { threadId: 't' });
    await rpc.ended;
    expect(await failure(pending)).toBeInstanceOf(RpcClosed);
  });

  test('a stdin that throws is logged, and the request still waits for its answer', async () => {
    const logger = memoryLogger();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stdout = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    const stdin = {
      write(): number {
        throw new Error('EPIPE');
      },
      end: () => 0,
    };
    const rpc = new CodexRpc({ stdin, stdout, logger });
    const pending = rpc.request('thread/delete', { threadId: 't' });
    expect(logger.entries.map((entry) => entry.message)).toEqual(['codex rpc: write failed']);
    controller.close();
    expect(await failure(pending)).toBeInstanceOf(RpcClosed);
  });
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `bun test packages/runner/test/codex/rpc.test.ts`
Expected: FAIL — `error: Cannot find module '../../src/adapters/codex/rpc' from 'packages/runner/test/codex/rpc.test.ts'` (0 pass, 1 fail, 1 error)

- [ ] **Step 3: Implement**

**File:** `packages/runner/src/adapters/codex/rpc.ts` (new)

```ts
// The JSON-RPC transport to `codex app-server` (design 9.1, 9.3): one JSON message per line over its stdin and
// stdout, without a "jsonrpc" member, as app-server speaks it. Requests are correlated by id with a timeout,
// notifications reach listeners in arrival order, and every server request gets exactly one answer. It never reads
// stderr; whoever spawns app-server drains that.
import { type Logger, noopLogger } from '../../log';
import type {
  CodexClientMethod,
  CodexNotificationMethod,
  CodexServerRequestMethod,
  ParamsOf,
  ResultOf,
} from './methods';
import type { ClientNotification, RequestId, ServerNotification } from './protocol';

/**
 * An error answer from app-server; data (with its codexErrorInfo) is kept exactly as sent. An answer dropped over
 * the line cap rejects as one too, with code -32603 and no data.
 */
export class RpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
    readonly data: unknown,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

/** The transport closed before the answer came: stdout ended, or the client was closed. */
export class RpcClosed extends Error {
  constructor(readonly method: string) {
    super(`codex app-server closed before answering ${method}`);
    this.name = 'RpcClosed';
  }
}

/** No answer within the request's time bound; a late answer is ignored. */
export class RpcTimeout extends Error {
  constructor(
    readonly method: string,
    readonly timeoutMs: number,
  ) {
    super(`codex app-server did not answer ${method} within ${timeoutMs} ms`);
    this.name = 'RpcTimeout';
  }
}

/** app-server's stdin as Bun's FileSink offers it. */
export interface RpcInput {
  write(data: string): unknown;
  flush?(): unknown;
  end(): unknown;
}

export interface CodexRpcOptions {
  stdin: RpcInput;
  stdout: AsyncIterable<Uint8Array>;
  logger?: Logger;
  requestTimeoutMs?: number;
  /**
   * Longer lines are dropped with a warning, so a runaway line never grows the buffer without bound. A dropped
   * server request is still answered, and a dropped response still settles its request.
   */
  maxLineBytes?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_LINE_BYTES = 32 * 1024 * 1024;
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;
const NEWLINE = 0x0a;

/** How much of a dropped line is kept to find out what it was. */
const OVERSIZED_HEAD_BYTES = 4096;

// app-server writes the id first ({"id":1,"result":...}), so the head of a dropped line names the request it answers
// or the server request it is.
const OVERSIZED_HEAD = /^\{"id":(-?\d+|"(?:[^"\\]|\\.)*"),"(method|result|error)"/;

type ServerRequestHandler<M extends CodexServerRequestMethod> = (
  params: ParamsOf<M>,
  id: RequestId,
) => ResultOf<M> | Promise<ResultOf<M>>;

interface Pending {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

type Message = Record<string, unknown>;

/** A line over the size cap, of which only the head was kept. */
interface DroppedLine {
  head: string;
}

export class CodexRpc {
  /** Settles once app-server's stdout has ended or failed. */
  readonly ended: Promise<void>;

  private readonly stdin: RpcInput;
  private readonly logger: Logger;
  private readonly requestTimeoutMs: number;
  private readonly maxLineBytes: number;
  private readonly pending = new Map<RequestId, Pending>();
  private readonly handlers = new Map<string, (params: unknown, id: RequestId) => unknown>();
  private readonly listeners: ((notification: ServerNotification) => void)[] = [];
  private readonly answered = new Set<RequestId>();
  private nextId = 1;
  private isClosed = false;
  // The current line's bytes so far, and, once it went over the cap, its head.
  private partial: Uint8Array[] = [];
  private partialBytes = 0;
  private oversized: Uint8Array | null = null;
  private readonly decoder = new TextDecoder();

  constructor(options: CodexRpcOptions) {
    this.stdin = options.stdin;
    this.logger = options.logger ?? noopLogger;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    this.ended = this.read(options.stdout);
  }

  /** True once stdout ended or close() ran: requests reject, and nothing more is written or delivered. */
  get closed(): boolean {
    return this.isClosed;
  }

  /** Sends a client request and resolves with its result; rejects with RpcError, RpcTimeout or RpcClosed. */
  request<M extends CodexClientMethod>(
    method: M,
    params: ParamsOf<M>,
    options: { timeoutMs?: number } = {},
  ): Promise<ResultOf<M>> {
    if (this.isClosed) return Promise.reject(new RpcClosed(method));
    const id = this.nextId++;
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    const answer = new Promise<ResultOf<M>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcTimeout(method, timeoutMs));
      }, timeoutMs);
      this.pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject, timer });
    });
    this.write(params === undefined ? { id, method } : { id, method, params });
    return answer;
  }

  notify(method: ClientNotification['method']): void {
    this.write({ method });
  }

  /**
   * Answers one kind of server request; a later call replaces the handler. A throwing or rejecting handler answers
   * -32603, and a request of a kind without a handler gets -32601.
   */
  handle<M extends CodexServerRequestMethod>(method: M, handler: ServerRequestHandler<M>): void {
    this.handlers.set(method, handler as (params: unknown, id: RequestId) => unknown);
  }

  /** Every notification, in arrival order. Gives a function that removes the listener. */
  onNotification(listener: (notification: ServerNotification) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index !== -1) this.listeners.splice(index, 1);
    };
  }

  /** One kind of notification, in the same order as every other listener sees it. */
  on<M extends CodexNotificationMethod>(method: M, listener: (params: ParamsOf<M>) => void): () => void {
    return this.onNotification((notification) => {
      if (notification.method === method) listener(notification.params as ParamsOf<M>);
    });
  }

  /**
   * Ends app-server's stdin, which makes it exit, and rejects pending requests. stdout is still read to its end,
   * so app-server never blocks on a full pipe, but nothing more is delivered or answered.
   */
  close(): void {
    if (this.isClosed) return;
    this.shut();
    try {
      this.settle(this.stdin.end());
    } catch (error) {
      this.logger.debug('codex rpc: ending stdin failed', { error: String(error) });
    }
  }

  private shut(): void {
    this.isClosed = true;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(new RpcClosed(pending.method));
    }
  }

  private write(message: Message): void {
    if (this.isClosed) return;
    try {
      this.settle(this.stdin.write(`${JSON.stringify(message)}\n`));
      this.settle(this.stdin.flush?.());
    } catch (error) {
      this.logger.warn('codex rpc: write failed', { error: String(error) });
    }
  }

  /** A FileSink call may answer with a promise; its failure is logged, never left unhandled. */
  private settle(result: unknown): void {
    if (result instanceof Promise) {
      result.catch((error: unknown) => this.logger.warn('codex rpc: write failed', { error: String(error) }));
    }
  }

  private async read(stdout: AsyncIterable<Uint8Array>): Promise<void> {
    try {
      for await (const chunk of stdout) {
        for (const line of this.lines(chunk)) {
          const answered = typeof line === 'string' ? this.dispatch(line) : this.dropped(line);
          // After an answer, the caller awaiting it runs before the messages behind it are delivered, so it sees
          // its turn id before that turn's notifications.
          if (answered) await new Promise((resolve) => setImmediate(resolve));
        }
      }
    } catch (error) {
      this.logger.debug('codex rpc: stdout failed', { error: String(error) });
    } finally {
      this.shut();
    }
  }

  /** Splits a chunk into the complete lines it ends, keeping the rest for the next chunk. */
  private lines(chunk: Uint8Array): (string | DroppedLine)[] {
    const lines: (string | DroppedLine)[] = [];
    let start = 0;
    while (start <= chunk.length) {
      const newline = chunk.indexOf(NEWLINE, start);
      const end = newline === -1 ? chunk.length : newline;
      if (!this.oversized) {
        if (this.partialBytes + end - start > this.maxLineBytes) {
          this.oversized = lineHead([...this.partial, chunk.subarray(start, end)]);
          this.partial = [];
          this.partialBytes = 0;
          this.logger.warn('codex rpc: line over the size cap dropped', { maxLineBytes: this.maxLineBytes });
        } else if (end > start) {
          // Copied, because the stream may reuse the chunk's buffer.
          this.partial.push(chunk.slice(start, end));
          this.partialBytes += end - start;
        }
      }
      if (newline === -1) break;
      lines.push(
        this.oversized
          ? { head: this.decoder.decode(this.oversized) }
          : this.decoder.decode(Buffer.concat(this.partial)),
      );
      this.partial = [];
      this.partialBytes = 0;
      this.oversized = null;
      start = newline + 1;
    }
    return lines;
  }

  /** Handles one line; gives true when it answered a pending request. */
  private dispatch(line: string): boolean {
    if (this.isClosed || line.trim() === '') return false;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.logger.warn('codex rpc: line is not JSON', { excerpt: line.slice(0, 200) });
      return false;
    }
    if (typeof message !== 'object' || message === null || Array.isArray(message)) {
      this.logger.warn('codex rpc: message of no known kind', { excerpt: line.slice(0, 200) });
      return false;
    }
    const fields = message as Message;
    const hasId = typeof fields.id === 'number' || typeof fields.id === 'string';
    if (typeof fields.method === 'string') {
      if (hasId) this.serverRequest(fields.id as RequestId, fields.method, fields.params);
      else this.notification(fields as unknown as ServerNotification);
      return false;
    }
    if (hasId && ('result' in fields || 'error' in fields)) return this.response(fields.id as RequestId, fields);
    this.logger.warn('codex rpc: message of no known kind', { excerpt: line.slice(0, 200) });
    return false;
  }

  /**
   * A dropped line that was a server request still gets an answer, which app-server treats as a decline, and a
   * dropped response rejects its request now instead of at its timeout. Gives true when it settled a request.
   */
  private dropped(line: DroppedLine): boolean {
    const match = line.head.match(OVERSIZED_HEAD);
    if (this.isClosed || !match) return false;
    const raw = match[1] as string;
    const id: RequestId = raw.startsWith('"') ? (JSON.parse(raw) as string) : Number(raw);
    if (match[2] === 'method') {
      if (this.answered.has(id)) return false;
      this.answered.add(id);
      this.answer(id, { error: { code: INTERNAL_ERROR, message: 'message over the size cap' } });
      return false;
    }
    const pending = this.pending.get(id);
    if (!pending) return false;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    const message = `the answer to ${pending.method} was over the ${this.maxLineBytes}-byte line cap`;
    pending.reject(new RpcError(pending.method, INTERNAL_ERROR, message, undefined));
    return true;
  }

  private response(id: RequestId, fields: Message): boolean {
    const pending = this.pending.get(id);
    if (!pending) {
      // Most likely the answer to a request that timed out.
      this.logger.debug('codex rpc: answer to no pending request', { id });
      return false;
    }
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if ('error' in fields) {
      const error = (fields.error ?? {}) as { code?: unknown; message?: unknown; data?: unknown };
      pending.reject(
        new RpcError(
          pending.method,
          typeof error.code === 'number' ? error.code : INTERNAL_ERROR,
          typeof error.message === 'string' ? error.message : 'codex app-server error',
          error.data,
        ),
      );
    } else {
      pending.resolve(fields.result);
    }
    return true;
  }

  private notification(notification: ServerNotification): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(notification);
      } catch (error) {
        this.logger.warn('codex rpc: listener failed', { method: notification.method, error: String(error) });
      }
    }
  }

  private serverRequest(id: RequestId, method: string, params: unknown): void {
    if (this.answered.has(id)) {
      this.logger.warn('codex rpc: repeated server request id', { id, method });
      return;
    }
    this.answered.add(id);
    const handler = this.handlers.get(method);
    if (!handler) {
      this.answer(id, { error: { code: METHOD_NOT_FOUND, message: `unhandled server request: ${method}` } });
      return;
    }
    let result: unknown;
    try {
      result = handler(params, id);
    } catch (error) {
      this.answer(id, { error: { code: INTERNAL_ERROR, message: errorMessage(error) } });
      return;
    }
    Promise.resolve(result).then(
      (value) => this.answer(id, { result: value }),
      (error: unknown) => this.answer(id, { error: { code: INTERNAL_ERROR, message: errorMessage(error) } }),
    );
  }

  private answer(id: RequestId, body: { result: unknown } | { error: { code: number; message: string } }): void {
    this.write({ id, ...body });
  }
}

/** The first OVERSIZED_HEAD_BYTES of a line's parts, copied. */
function lineHead(parts: Uint8Array[]): Uint8Array {
  const kept: Uint8Array[] = [];
  let size = 0;
  for (const part of parts) {
    if (size >= OVERSIZED_HEAD_BYTES) break;
    kept.push(part.subarray(0, OVERSIZED_HEAD_BYTES - size));
    size += kept.at(-1)?.length ?? 0;
  }
  return Uint8Array.from(Buffer.concat(kept));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `bun test packages/runner/test/codex/rpc.test.ts && bun test && bun run typecheck`
Expected: the task's tests pass (21 pass); then the whole suite passes (`0 fail`) and `tsc` exits 0.

A line over the size cap is answered at once instead of waiting out a timeout: the client finds the id in its first 4,096 bytes (with `match()`, never a regex's `exec` method), answers a server request -32603 'message over the size cap', and rejects a pending request naming the cap. When stdout ends, pending requests reject with `RpcClosed`. Error responses surface as `RpcError` with `data.codexErrorInfo` kept as is; Task 16 reads `activeTurnNotSteerable` from it.

- [ ] **Step 5: Commit**

```bash
git add -A 'packages/runner/src/adapters/codex/rpc.ts' 'packages/runner/test/codex/rpc.test.ts'
git commit -m 'M2E Task 5: JSON-RPC client for app-server' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

### Task 6: Fake app-server peer for CI tests

CI has no Codex, so the adapter's own tests drive a scripted JSON-RPC peer that runs as a real child process, which also exercises spawning, process groups, stderr draining and exit codes (design 15). `writeCodexShim(path, scenario)` writes an executable `codex` at any path, such as `<AGFLOW_HOME>/runner/vendor/codex/<version>/bin/codex`, and `readCodexRecord` gives each run's argv, environment, timings, requests and the client's answers to server requests. `codexMessages` builds the 0.159.2 message shapes recorded in the probes (`probe-messages.json`): `initialize` with the version in `userAgent`, thread results with the policy fields, turns, items, token usage, rate limits, errors and approval requests.

**Files:**
- Test: `packages/runner/test/codex/fake-app-server.ts`
- Test: `packages/runner/test/codex/peer.test.ts`
- Test: `packages/runner/test/codex/peer.ts`
- Test: `packages/runner/test/codex/probe-messages.json`

- [ ] **Step 1: Make the change**

**File:** `packages/runner/test/codex/fake-app-server.ts` (new)

```ts
// A scripted `codex app-server` for CI (see peer.ts): the shim, a bun script at any path, imports this file, so its
// launch argv[1] is the shim's path and the rest is the codex argv. It speaks app-server's line-delimited JSON-RPC on
// stdin and stdout, answers from the scenario of its run, sends the scripted follow-ups, records what the client did,
// and writes to stderr as the real one logs there.
import { dlopen, FFIType, ptr } from 'bun:ffi';
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, realpathSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { CodexClientMethod, ParamsOf } from '../../src/adapters/codex/methods';
import type { RequestId } from '../../src/adapters/codex/protocol';
import type { SandboxPolicy } from '../../src/adapters/codex/protocol/v2';
import {
  type CodexRunExit,
  type CodexScenario,
  type CrashSignal,
  codexMessages as m,
  fakeDir,
  fakeTurnId,
  type RecordEvent,
  type ScriptedAnswer,
  type ScriptedStep,
} from './peer';

/**
 * The argv this process was started with, from the kernel (sysctl KERN_PROCARGS2), or null where that is not
 * available. Every shim is a hard link to one script, and on macOS Bun resolves argv[1] to whichever of the file's
 * names the kernel has cached, which may be another test's shim or a removed one.
 */
function launchArgv(): string[] | null {
  if (process.platform !== 'darwin') return null;
  try {
    const { symbols, close } = dlopen('/usr/lib/libSystem.B.dylib', {
      sysctl: {
        args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64],
        returns: FFIType.i32,
      },
    });
    try {
      // CTL_KERN, KERN_PROCARGS2; the buffer is kern.argmax (1 MiB), the most the kernel returns.
      const mib = new Int32Array([1, 49, process.pid]);
      const buffer = new Uint8Array(1 << 20);
      const size = new BigUint64Array([BigInt(buffer.length)]);
      if (symbols.sysctl(ptr(mib), 3, ptr(buffer), ptr(size), null, 0) !== 0) return null;
      const bytes = buffer.subarray(0, Number(size[0]));
      const argc = new DataView(bytes.buffer).getInt32(0, true);
      // argc, the executable's path, NUL padding, then the arguments.
      const strings = new TextDecoder().decode(bytes.subarray(4)).split('\0');
      let first = 1;
      while (first < strings.length && strings[first] === '') first += 1;
      const argv = strings.slice(first, first + argc);
      return argv.length === argc ? argv : null;
    } finally {
      close();
    }
  } catch {
    return null;
  }
}

// The kernel's argv[1] is the path the shim was spawned by, relative to the cwd it started in, which is still ours.
const shim = launchArgv()?.[1];
const dir = fakeDir(shim === undefined ? (process.argv[1] ?? '') : resolve(shim));
const argv = process.argv.slice(2);
const scenarios = JSON.parse(readFileSync(join(dir, 'scenarios.json'), 'utf8')) as CodexScenario[];

/** Writes all of text to fd 1 or 2; a closed reader ends nothing here, the stdin EOF does. */
function writeAll(fd: number, text: string): void {
  let bytes = Buffer.from(text);
  while (bytes.length > 0) {
    try {
      bytes = bytes.subarray(writeSync(fd, bytes));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPIPE') return;
      if (code !== 'EAGAIN') throw error;
      Bun.sleepSync(1);
    }
  }
}

const send = (message: unknown) => writeAll(1, `${JSON.stringify(message)}\n`);
const log = (line: string) => writeAll(2, `${new Date().toISOString()} ${line}\n`);

if (argv[0] === '--version') {
  writeAll(1, `codex-cli ${scenarios[0]?.version}\n`);
  process.exit(0);
}

/** Claims the next run number; exclusive creation keeps concurrent starts apart. */
function claimRun(): number {
  for (let run = 0; ; run += 1) {
    try {
      closeSync(openSync(join(dir, 'runs', String(run)), 'wx'));
      return run;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
}

const run = claimRun();
const scenario = scenarios[Math.min(run, scenarios.length - 1)] as CodexScenario;

function record(entry: RecordEvent): void {
  appendFileSync(join(dir, 'record.jsonl'), `${JSON.stringify({ run, at: Date.now(), ...entry })}\n`);
}

function exit(reason: CodexRunExit['reason'], outcome: { code: number } | { signal: CrashSignal }): never {
  const code = 'code' in outcome ? outcome.code : null;
  const signal = 'signal' in outcome ? outcome.signal : null;
  record({ type: 'exit', reason, code, signal });
  if (signal) {
    // The recording handler would otherwise catch a scripted SIGTERM.
    process.removeAllListeners('SIGTERM');
    process.kill(process.pid, signal);
  }
  // Reached only when the signal does not end the process.
  process.exit(code ?? 1);
}

process.on('SIGTERM', () => {
  record({ type: 'signal', signal: 'SIGTERM' });
  if (!scenario.ignoreSigterm) exit('signal', { signal: 'SIGTERM' });
});

record({ type: 'start', pid: process.pid, argv, env: process.env as Record<string, string>, cwd: process.cwd() });
// 0.159.2 refuses a CODEX_HOME that does not exist, with these two lines.
const codexHome = process.env.CODEX_HOME;
if (codexHome !== undefined && !existsSync(codexHome)) {
  const missing = `CODEX_HOME points to "${codexHome}", but that path does not exist`;
  writeAll(2, `WARNING: proceeding, even though we could not create PATH aliases: ${missing}\n`);
  writeAll(2, `Error: ${missing}\n`);
  exit('failed', { code: 1 });
}
// 0.159.2 writes nothing to stderr on a normal start, so a failed start's first line is its reason.
for (const line of scenario.stderr) writeAll(2, `${line}\n`);
if (scenario.failBeforeInitialize) {
  writeAll(2, `${scenario.failBeforeInitialize.stderr}\n`);
  exit('failed', { code: scenario.failBeforeInitialize.code });
}

const calls = new Map<string, number>();
let turns = 0;
let nextRequestId = 0;
let initialized = false;
/** The steps to take once the client answers a server request, by its id. */
const afterAnswers = new Map<RequestId, ScriptedStep[]>();

/** A path as app-server reports it: resolved when it exists. */
function real(path: string): string {
  return existsSync(path) ? realpathSync(path) : path;
}

function sandboxPolicy(params: Pick<ParamsOf<'thread/start'>, 'sandbox' | 'config'>): SandboxPolicy {
  if (params.sandbox === 'read-only') return { type: 'readOnly', networkAccess: false };
  if (params.sandbox === 'danger-full-access') return { type: 'dangerFullAccess' };
  const settings = (params.config?.sandbox_workspace_write ?? {}) as {
    writable_roots?: string[];
    network_access?: boolean;
    exclude_tmpdir_env_var?: boolean;
    exclude_slash_tmp?: boolean;
  };
  return {
    type: 'workspaceWrite',
    writableRoots: settings.writable_roots ?? [],
    networkAccess: settings.network_access ?? false,
    excludeTmpdirEnvVar: settings.exclude_tmpdir_env_var ?? false,
    excludeSlashTmp: settings.exclude_slash_tmp ?? false,
  };
}

/** app-server's own answer in the normal case, built from the request; null for a method the fake does not know. */
function defaultAnswer(method: string, params: unknown): { result: unknown; then: ScriptedStep[] } | null {
  switch (method) {
    case 'initialize': {
      const { clientInfo } = params as ParamsOf<'initialize'>;
      const home = process.env.CODEX_HOME ?? join(process.env.HOME ?? '', '.codex');
      return { result: m.initializeResult(scenario.version, clientInfo, real(home)), then: [] };
    }
    case 'thread/start':
    case 'thread/resume': {
      // thread/resume takes thread/start's overrides plus the thread id.
      const request = params as Partial<ParamsOf<'thread/resume'>>;
      const thread = m.thread({
        id: method === 'thread/resume' ? (request.threadId ?? scenario.threadId) : scenario.threadId,
        cwd: real(request.cwd ?? process.cwd()),
        model: request.model ?? undefined,
        cliVersion: scenario.version,
      });
      const options = {
        thread,
        approvalPolicy: request.approvalPolicy ?? 'on-request',
        approvalsReviewer: request.approvalsReviewer ?? 'user',
        sandbox: sandboxPolicy(request),
      };
      return method === 'thread/start'
        ? { result: m.threadStartResult(options), then: [{ notify: m.threadStarted(thread) }] }
        : { result: m.threadResumeResult(options), then: [] };
    }
    case 'turn/start':
      turns += 1;
      return { result: { turn: m.turn({ id: fakeTurnId(turns), status: 'inProgress', startedAt: null }) }, then: [] };
    case 'turn/steer':
      return { result: { turnId: (params as ParamsOf<'turn/steer'>).expectedTurnId }, then: [] };
    case 'thread/name/set':
    case 'turn/interrupt':
      return { result: {}, then: [] };
    default:
      return null;
  }
}

function scripted(method: string): ScriptedAnswer<CodexClientMethod> {
  const answers = scenario.answers[method as CodexClientMethod] as
    | ScriptedAnswer<CodexClientMethod>
    | ScriptedAnswer<CodexClientMethod>[]
    | undefined;
  const call = calls.get(method) ?? 0;
  calls.set(method, call + 1);
  if (!Array.isArray(answers)) return answers ?? {};
  return answers[Math.min(call, answers.length - 1)] ?? {};
}

/** Takes one step; only a delay waits, so the steps up to it go out together, before any later answer. */
function step(next: ScriptedStep): Promise<void> | undefined {
  if ('delayMs' in next) return Bun.sleep(next.delayMs);
  if ('notify' in next) send(next.notify);
  else if ('request' in next) {
    const { id: given, ...request } = next.request;
    const id = given ?? nextRequestId++;
    const { threadId } = request.params as { threadId?: unknown };
    afterAnswers.set(
      id,
      next.afterAnswer ?? (typeof threadId === 'string' ? [{ notify: m.serverRequestResolved(threadId, id) }] : []),
    );
    send({ id, ...request });
  } else if ('stderr' in next) writeAll(2, `${next.stderr}\n`);
  else if ('spawnPipeHolder' in next) {
    // Not detached, so it stays in the peer's process group.
    const holder = Bun.spawn(['/bin/sleep', '600'], { stdio: ['ignore', 'inherit', 'inherit'] });
    holder.unref();
    record({ type: 'pipeHolder', pid: holder.pid });
  } else exit('crash', next.crash);
}

async function steps(list: ScriptedStep[]): Promise<void> {
  for (const next of list) {
    const waiting = step(next);
    if (waiting) await waiting;
  }
}

/** 0.159.2's refusals: nothing before initialize, and initialize only once. */
function refusal(method: string): string | null {
  if (method === 'initialize') return initialized ? 'Already initialized' : null;
  return initialized ? null : 'Not initialized';
}

async function answer(id: RequestId, method: string, params: unknown): Promise<void> {
  record({ type: 'request', id, method, params });
  log(`DEBUG codex_app_server: <- ${method} (${id})`);
  const refused = refusal(method);
  if (refused) {
    send({ id, error: { code: -32600, message: refused } });
    return;
  }
  const script = scripted(method);
  if (script.delayMs) await Bun.sleep(script.delayMs);
  let follow: ScriptedStep[] = [];
  if (method === 'initialize' && !script.silent && !script.error) {
    // Recorded and marked before the answer goes out, so the record holds it once the client has the answer.
    initialized = true;
    record({ type: 'initialized' });
  }
  if (script.error) send({ id, error: script.error });
  else if ('result' in script) send({ id, result: script.result });
  else if (!script.silent) {
    const fallback = defaultAnswer(method, params);
    if (fallback) {
      send({ id, result: fallback.result });
      follow = fallback.then;
    } else {
      send({ id, error: { code: -32601, message: `fake app-server: nothing scripted for ${method}` } });
    }
  }
  await steps([...follow, ...(script.then ?? [])]);
}

function receive(line: string): void {
  if (line.trim() === '') return;
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(line) as Record<string, unknown>;
  } catch {
    log(`WARN codex_app_server: invalid JSON from the client: ${line.slice(0, 200)}`);
    return;
  }
  const id = message.id as RequestId | undefined;
  if (typeof message.method === 'string' && id !== undefined) {
    void answer(id, message.method, message.params);
  } else if (typeof message.method === 'string') {
    record({ type: 'notification', method: message.method, params: message.params });
  } else if (id !== undefined) {
    record({
      type: 'answer',
      id,
      ...('result' in message ? { result: message.result } : {}),
      ...('error' in message ? { error: message.error } : {}),
    });
    const after = afterAnswers.get(id);
    afterAnswers.delete(id);
    if (after) void steps(after);
  }
}

const decoder = new TextDecoder();
let buffered = '';
for await (const chunk of Bun.stdin.stream()) {
  buffered += decoder.decode(chunk, { stream: true });
  const lines = buffered.split('\n');
  buffered = lines.pop() ?? '';
  for (const line of lines) receive(line);
}
if (scenario.onStdinEof === 'ignore') {
  log('INFO codex_app_server: stdin closed, still running');
  // Only a signal ends the peer now.
  setInterval(() => {}, 1 << 30);
} else {
  log('INFO codex_app_server: stdin closed, exiting');
  exit('eof', { code: 0 });
}
```

**File:** `packages/runner/test/codex/peer.test.ts` (new)

```ts
import { afterEach, describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CODEX_VERSION, codexBinaryVersion } from '../../src/adapters/codex/binary';
import type { ServerNotification } from '../../src/adapters/codex/protocol';
import { CodexRpc, RpcClosed, RpcError, RpcTimeout } from '../../src/adapters/codex/rpc';
import { runnerPaths } from '../../src/paths';
import { boundedWait, drainToLog } from '../../src/processes';
import { vendorBinary } from '../../src/vendor/pins';
import probeMessages from './probe-messages.json';
import {
  type CodexScenario,
  codexMessages as m,
  codexScenario,
  FAKE_THREAD_ID,
  fakeTurnId,
  readCodexRecord,
  writeCodexShim,
} from './peer';

const dirs: string[] = [];
const procs: { pid: number }[] = [];
afterEach(() => {
  // The whole group, so pipe holders go too.
  for (const proc of procs.splice(0)) {
    try {
      process.kill(-proc.pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agflow-codex-peer-')));
  dirs.push(dir);
  return dir;
}

const clientInfo = { name: 'agflow', title: null, version: '0.1.0' };

/** A shim at the runner's vendor path, as an adapter would find it. */
function shimAt(scenario: CodexScenario | CodexScenario[]): { bin: string; dir: string } {
  const dir = tempDir();
  const bin = join(runnerPaths(join(dir, 'agflow')).runner, vendorBinary('codex', CODEX_VERSION));
  writeCodexShim(bin, scenario);
  return { bin, dir };
}

const ARGV = ['app-server', '--disable', 'hooks', '-c', 'allow_login_shell=false'];

/**
 * Starts the shim as app-server in its own process group, with CODEX_HOME at <dir>/codex-home (created, as the
 * runner must), its stderr drained into a log and a CodexRpc on its pipes.
 */
function start(bin: string, dir: string, env: Record<string, string> = {}) {
  mkdirSync(join(dir, 'codex-home'), { recursive: true });
  const proc = Bun.spawn([bin, ...ARGV], {
    cwd: dir,
    env: { PATH: '/usr/bin:/bin', CODEX_HOME: join(dir, 'codex-home'), ...env },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    detached: true,
  });
  procs.push(proc);
  const log = join(dir, 'stderr.log');
  const drained = drainToLog(proc.stderr, log, { maxBytes: 1 << 20 });
  const rpc = new CodexRpc({ stdin: proc.stdin, stdout: proc.stdout, requestTimeoutMs: 10_000 });
  return { proc, rpc, drained, log };
}

/** initialize, then initialized, as a client must before anything else. */
async function initialize(rpc: CodexRpc) {
  const result = await rpc.request('initialize', { clientInfo, capabilities: null });
  rpc.notify('initialized');
  return result;
}

const failure = (promise: Promise<unknown>) => promise.catch((caught: unknown) => caught);

async function until(condition: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the condition');
    await Bun.sleep(10);
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('writeCodexShim', () => {
  test('writes an executable codex at any path that prints the scripted version', async () => {
    const { bin } = shimAt(codexScenario());
    expect(statSync(bin).mode & 0o111).toBe(0o111);
    expect(await codexBinaryVersion(bin)).toBe(CODEX_VERSION);
    writeCodexShim(bin, codexScenario({ version: '0.150.0' }));
    expect(await codexBinaryVersion(bin)).toBe('0.150.0');
    // --version is no app-server run.
    expect(readCodexRecord(bin)).toEqual([]);
  }, 20_000);

  test('shims sharing one script each read their own scenario, even when started at the same time', async () => {
    const dir = tempDir();
    const versions = ['0.150.0', '0.151.0', '0.152.0'];
    const bins = versions.map((version, index) =>
      writeCodexShim(join(dir, String(index), 'codex'), codexScenario({ version })),
    );
    // Each shim started more than once, all at the same time: enough to interleave them, few enough for a loaded host.
    const starts = 12;
    const printed = await Promise.all(
      Array.from({ length: starts }, async (_, index) => {
        const proc = Bun.spawn([bins[index % 3] as string, '--version'], { stdout: 'pipe', stderr: 'ignore' });
        const [output] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
        return output.trim();
      }),
    );
    expect(printed).toEqual(Array.from({ length: starts }, (_, index) => `codex-cli ${versions[index % 3]}`));
  }, 60_000);

  test('refuses to replace a file that is not a shim, such as a real binary', () => {
    const dir = tempDir();
    const bin = join(dir, 'bin', 'codex');
    mkdirSync(join(dir, 'bin'));
    writeFileSync(bin, '#!/bin/sh\necho "codex-cli 0.159.2"\n');
    expect(() => writeCodexShim(bin, codexScenario())).toThrow('is not a fake codex shim');
    expect(readFileSync(bin, 'utf8')).toBe('#!/bin/sh\necho "codex-cli 0.159.2"\n');
  });

  test('answers initialize with the version in userAgent and a scripted thread/start', async () => {
    const { bin, dir } = shimAt(codexScenario({ threadId: 'thread-42' }));
    const { proc, rpc } = start(bin, dir);
    const init = await initialize(rpc);
    expect(init.userAgent).toStartWith(`agflow/${CODEX_VERSION} (`);
    expect(init.codexHome).toBe(join(dir, 'codex-home'));
    const clone = join(dir, 'clone');
    const started = await rpc.request('thread/start', {
      cwd: clone,
      model: 'gpt-6.1-sol',
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      config: { sandbox_workspace_write: { writable_roots: [`${clone}/.git`], network_access: false } },
    });
    expect(started).toMatchObject({
      thread: { id: 'thread-42', cwd: clone, cliVersion: CODEX_VERSION, status: { type: 'idle' }, turns: [] },
      model: 'gpt-6.1-sol',
      cwd: clone,
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandbox: { type: 'workspaceWrite', writableRoots: [`${clone}/.git`], networkAccess: false },
    });
    // Fields 0.159.2 sends beyond the generated types.
    expect(started).toMatchObject({
      runtimeWorkspaceRoots: [clone, `${clone}/.git`],
      multiAgentMode: 'explicitRequestOnly',
    });
    proc.stdin.end();
    expect(await proc.exited).toBe(0);
  }, 20_000);

  test('a scripted answer replaces the default, and calls of a method take its scripted answers in turn', async () => {
    const { bin, dir } = shimAt(
      codexScenario({
        answers: {
          'thread/start': { result: m.threadStartResult({ thread: m.thread({ id: 'scripted', cwd: '/x' }) }) },
          'thread/delete': [{ error: { code: -32600, message: 'thread is loaded' } }, { result: {} }],
        },
      }),
    );
    const { rpc } = start(bin, dir);
    await initialize(rpc);
    expect((await rpc.request('thread/start', { cwd: dir })).thread.id).toBe('scripted');
    const first = await failure(rpc.request('thread/delete', { threadId: 'scripted' }));
    expect(first).toBeInstanceOf(RpcError);
    expect(first).toMatchObject({ code: -32600, message: 'thread is loaded' });
    expect(await rpc.request('thread/delete', { threadId: 'scripted' })).toEqual({});
    expect(await rpc.request('thread/delete', { threadId: 'scripted' })).toEqual({});
    // Nothing scripted and no default: the method is unknown to the fake.
    const missing = await failure(rpc.request('skills/list', { cwds: [dir] }));
    expect(missing).toMatchObject({ code: -32601 });
  }, 20_000);

  test('answers thread/resume with the thread it names, the resolved cwd and the echoed policy', async () => {
    const { bin, dir } = shimAt(codexScenario());
    const clone = join(dir, 'clone');
    mkdirSync(clone);
    const link = join(dir, 'clone-link');
    symlinkSync(clone, link);
    const { rpc } = start(bin, dir);
    const notifications: string[] = [];
    rpc.onNotification((notification) => notifications.push(notification.method));
    await initialize(rpc);
    const resumed = await rpc.request('thread/resume', {
      threadId: 'thread-old',
      cwd: link,
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandbox: 'workspace-write',
      config: { sandbox_workspace_write: { writable_roots: [`${clone}/.git`], network_access: false } },
    });
    expect(resumed).toMatchObject({
      thread: { id: 'thread-old', cwd: clone },
      cwd: clone,
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandbox: { type: 'workspaceWrite', writableRoots: [`${clone}/.git`], networkAccess: false },
      turnsBackwardsCursor: null,
      itemsBackwardsCursor: null,
    });
    // Only thread/start announces a thread.
    await rpc.request('thread/name/set', { threadId: 'thread-old', name: 'n' });
    expect(notifications).toEqual([]);
  }, 20_000);

  test('refuses requests before initialize and a second initialize, as 0.159.2 does', async () => {
    const { bin, dir } = shimAt(codexScenario());
    const { rpc } = start(bin, dir);
    const early = await failure(rpc.request('thread/start', { cwd: dir }));
    expect(early).toBeInstanceOf(RpcError);
    expect(early).toMatchObject({ code: -32600, message: 'Not initialized' });
    await initialize(rpc);
    const again = await failure(rpc.request('initialize', { clientInfo, capabilities: null }));
    expect(again).toMatchObject({ code: -32600, message: 'Already initialized' });
    expect((await rpc.request('thread/start', { cwd: dir })).thread.id).toBe(FAKE_THREAD_ID);
  }, 20_000);

  test('exits 1 with the two lines of 0.159.2 when CODEX_HOME does not exist', async () => {
    const { bin, dir } = shimAt(codexScenario({ stderr: ['never written'] }));
    const missing = join(dir, 'no-such-home');
    const { proc, rpc, drained, log } = start(bin, dir, { CODEX_HOME: missing });
    expect(await failure(initialize(rpc))).toBeInstanceOf(RpcClosed);
    expect(await proc.exited).toBe(1);
    await drained;
    expect(readFileSync(log, 'utf8')).toBe(
      `WARNING: proceeding, even though we could not create PATH aliases: CODEX_HOME points to "${missing}", ` +
        'but that path does not exist\n' +
        `Error: CODEX_HOME points to "${missing}", but that path does not exist\n`,
    );
    expect(readCodexRecord(bin)[0]?.exit).toMatchObject({ reason: 'failed', code: 1 });
  }, 20_000);
});

describe('scripted follow-ups', () => {
  test('notifications and server requests follow the answer they belong to; the answers are recorded', async () => {
    const threadId = FAKE_THREAD_ID;
    const turnId = fakeTurnId(1);
    const command = m.commandExecutionItem({ id: 'exec-1', command: 'touch out.txt', cwd: '/clone' });
    const { bin, dir } = shimAt(
      codexScenario({
        answers: {
          'turn/start': {
            then: [
              { notify: m.turnStarted(threadId, m.turn({ id: turnId, status: 'inProgress' })) },
              { notify: m.threadStatusChanged(threadId, ['waitingOnApproval']) },
              // As 0.159.2 does it after the client's answer: resolved, the declined item, the end of the turn.
              {
                request: m.commandApprovalRequest({ threadId, turnId, item: command, reason: 'write outside' }),
                afterAnswer: [
                  { notify: m.serverRequestResolved(threadId, 0) },
                  { notify: m.itemCompleted(threadId, turnId, { ...command, status: 'declined' }) },
                  { notify: m.turnCompleted(threadId, m.turn({ id: turnId, status: 'completed' })) },
                ],
              },
            ],
          },
        },
      }),
    );
    const { proc, rpc } = start(bin, dir);
    const order: string[] = [];
    rpc.onNotification((notification) => order.push(notification.method));
    // Answered late, as after the owner's decision: what follows the answer still waits for it.
    rpc.handle('item/commandExecution/requestApproval', async (params, id) => {
      order.push(`request ${id} ${params.itemId}`);
      await Bun.sleep(200);
      order.push('answering');
      return { decision: 'decline' };
    });
    const completed = new Promise<void>((resolve) => rpc.on('turn/completed', () => resolve()));
    await initialize(rpc);
    await rpc.request('thread/start', { cwd: dir });
    const input = [{ type: 'text' as const, text: 'go', text_elements: [] }];
    const turn = await rpc.request('turn/start', { threadId, input });
    order.push(`answer ${turn.turn.id}`);
    await completed;
    expect(order).toEqual([
      'thread/started',
      `answer ${turnId}`,
      'turn/started',
      'thread/status/changed',
      'request 0 exec-1',
      'answering',
      'serverRequest/resolved',
      'item/completed',
      'turn/completed',
    ]);
    proc.stdin.end();
    await proc.exited;
    const [run] = readCodexRecord(bin);
    expect(run?.answers).toEqual([{ id: 0, result: { decision: 'decline' }, at: expect.any(Number) }]);
    expect(run?.requests.map((request) => request.method)).toEqual(['initialize', 'thread/start', 'turn/start']);
    expect(run?.requests[2]?.params).toEqual({ threadId, input });
  }, 20_000);

  test('by default an answered server request is followed by serverRequest/resolved; afterAnswer [] sends none', async () => {
    const threadId = FAKE_THREAD_ID;
    const turnId = fakeTurnId(1);
    const approval = (itemId: string) =>
      m.fileChangeApprovalRequest({ threadId, turnId, itemId, reason: 'write .agflow/config.json' });
    const { bin, dir } = shimAt(
      codexScenario({
        answers: {
          'turn/start': { then: [{ request: approval('patch-1'), afterAnswer: [] }, { request: approval('patch-2') }] },
        },
      }),
    );
    const { rpc } = start(bin, dir);
    const order: string[] = [];
    rpc.on('serverRequest/resolved', (params) => order.push(`resolved ${params.requestId}`));
    rpc.handle('item/fileChange/requestApproval', async (params, id) => {
      await Bun.sleep(100);
      order.push(`answer ${id} ${params.itemId}`);
      return { decision: 'accept' };
    });
    await initialize(rpc);
    await rpc.request('turn/start', { threadId, input: [] });
    await until(() => order.includes('resolved 1'));
    expect(order).toEqual(['answer 0 patch-1', 'answer 1 patch-2', 'resolved 1']);
  }, 20_000);

  test('follow-ups without a delay go out before the answer to a request that came in after', async () => {
    const { bin, dir } = shimAt(
      codexScenario({
        answers: {
          'thread/name/set': { then: [{ notify: m.warning('first') }, { notify: m.warning('second') }] },
        },
      }),
    );
    const { rpc } = start(bin, dir);
    await initialize(rpc);
    const order: string[] = [];
    rpc.on('warning', (params) => order.push(params.message));
    const named = rpc.request('thread/name/set', { threadId: 't', name: 'n' }).then(() => order.push('named'));
    const interrupted = rpc
      .request('turn/interrupt', { threadId: 't', turnId: 'u' })
      .then(() => order.push('interrupted'));
    await Promise.all([named, interrupted]);
    expect(order).toEqual(['named', 'first', 'second', 'interrupted']);
  }, 20_000);

  test('a silent answer leaves the request unanswered', async () => {
    const { bin, dir } = shimAt(codexScenario({ answers: { 'turn/interrupt': { silent: true } } }));
    const { rpc } = start(bin, dir);
    await initialize(rpc);
    const error = await failure(rpc.request('turn/interrupt', { threadId: 't', turnId: 'u' }, { timeoutMs: 300 }));
    expect(error).toBeInstanceOf(RpcTimeout);
  }, 20_000);

  test('the default turn ids count up per run, and steer answers with the expected turn', async () => {
    const { bin, dir } = shimAt(codexScenario());
    const { rpc } = start(bin, dir);
    await initialize(rpc);
    const first = await rpc.request('turn/start', { threadId: FAKE_THREAD_ID, input: [] });
    const second = await rpc.request('turn/start', { threadId: FAKE_THREAD_ID, input: [] });
    expect([first.turn.id, second.turn.id]).toEqual([fakeTurnId(1), fakeTurnId(2)]);
    expect(first.turn.status).toBe('inProgress');
    const steer = await rpc.request('turn/steer', {
      threadId: FAKE_THREAD_ID,
      expectedTurnId: second.turn.id,
      input: [{ type: 'text', text: 'more', text_elements: [] }],
    });
    expect(steer).toEqual({ turnId: fakeTurnId(2) });
  }, 20_000);
});

describe('the record', () => {
  test('holds argv, the exact environment, the start time and the time initialize was answered', async () => {
    const { bin, dir } = shimAt(codexScenario({ answers: { initialize: { delayMs: 200 } } }));
    const before = Date.now();
    const { proc, rpc } = start(bin, dir, { AGFLOW_MARKER: 'm-1' });
    await initialize(rpc);
    // Recorded before the answer was written, so it is there once the answer is.
    expect(readCodexRecord(bin)[0]?.initializedAt).not.toBeNull();
    proc.stdin.end();
    expect(await proc.exited).toBe(0);
    const [run, ...others] = readCodexRecord(bin);
    expect(others).toEqual([]);
    expect(run).toMatchObject({
      run: 0,
      pid: proc.pid,
      argv: ['app-server', '--disable', 'hooks', '-c', 'allow_login_shell=false'],
      cwd: dir,
      exit: { reason: 'eof', code: 0, signal: null },
    });
    // Exactly what the spawner passed: nothing added on the way, so a leaked variable shows.
    expect(run?.env).toEqual({ AGFLOW_MARKER: 'm-1', CODEX_HOME: join(dir, 'codex-home'), PATH: '/usr/bin:/bin' });
    expect(run?.startedAt).toBeGreaterThanOrEqual(before);
    expect(run?.initializedAt).toBeGreaterThanOrEqual((run?.startedAt as number) + 200);
    expect(run?.notifications.map((notification) => notification.method)).toEqual(['initialized']);
  }, 20_000);

  test('each start is one run, and a list of scenarios gives the n-th run the n-th one', async () => {
    const failing = codexScenario({
      failBeforeInitialize: { stderr: 'Error: failed to initialize sqlite state runtime', code: 7 },
    });
    const { bin, dir } = shimAt([failing, codexScenario({ threadId: 'second' }), codexScenario({ threadId: 'third' })]);
    const first = start(bin, dir);
    const initialize = first.rpc.request('initialize', { clientInfo, capabilities: null });
    expect(await failure(initialize)).toBeInstanceOf(RpcClosed);
    expect(await first.proc.exited).toBe(7);
    await first.drained;
    // The reason is the first line, as with 0.159.2, which writes nothing else there on a start.
    expect(readFileSync(first.log, 'utf8')).toBe('Error: failed to initialize sqlite state runtime\n');
    const ids: string[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const next = start(bin, dir);
      await next.rpc.request('initialize', { clientInfo, capabilities: null });
      ids.push((await next.rpc.request('thread/start', { cwd: dir })).thread.id);
      next.proc.stdin.end();
      await next.proc.exited;
    }
    expect(ids).toEqual(['second', 'third', 'third']);
    const runs = readCodexRecord(bin);
    expect(runs.map((run) => [run.run, run.initializedAt === null, run.exit?.reason])).toEqual([
      [0, true, 'failed'],
      [1, false, 'eof'],
      [2, false, 'eof'],
      [3, false, 'eof'],
    ]);
    expect(runs[0]?.exit).toMatchObject({ reason: 'failed', code: 7, signal: null });
  }, 30_000);
});

describe('exits', () => {
  test('a scripted crash exits with its code, and pending requests reject with RpcClosed', async () => {
    const { bin, dir } = shimAt(
      codexScenario({ answers: { 'turn/start': { silent: true, then: [{ crash: { code: 3 } }] } } }),
    );
    const { proc, rpc } = start(bin, dir);
    await initialize(rpc);
    expect(await failure(rpc.request('turn/start', { threadId: 't', input: [] }))).toBeInstanceOf(RpcClosed);
    expect(await proc.exited).toBe(3);
    expect(readCodexRecord(bin)[0]?.exit).toMatchObject({ reason: 'crash', code: 3, signal: null });
  }, 20_000);

  test('a scripted signal kills the peer with it', async () => {
    const { bin, dir } = shimAt(
      codexScenario({ answers: { 'thread/name/set': { then: [{ crash: { signal: 'SIGKILL' } }] } } }),
    );
    const { proc, rpc } = start(bin, dir);
    await initialize(rpc);
    expect(await rpc.request('thread/name/set', { threadId: 't', name: 'agflow T-1-a1' })).toEqual({});
    await proc.exited;
    expect(proc.signalCode).toBe('SIGKILL');
    expect(readCodexRecord(bin)[0]?.exit).toMatchObject({ reason: 'crash', code: null, signal: 'SIGKILL' });
  }, 20_000);

  test('the peer writes to stderr, at start, per message and when scripted, so drains are exercised', async () => {
    const { bin, dir } = shimAt(
      codexScenario({
        stderr: ['WARN codex_core: scripted startup line'],
        answers: { 'thread/name/set': { then: [{ stderr: 'ERROR codex_core: scripted failure' }] } },
      }),
    );
    const { proc, rpc, drained, log } = start(bin, dir);
    await initialize(rpc);
    await rpc.request('thread/name/set', { threadId: 't', name: 'n' });
    proc.stdin.end();
    await proc.exited;
    expect((await drained).bytes).toBeGreaterThan(0);
    const text = readFileSync(log, 'utf8');
    expect(text).toContain('WARN codex_core: scripted startup line');
    expect(text).toContain('thread/name/set');
    expect(text).toContain('ERROR codex_core: scripted failure');
  }, 20_000);
});

describe('process groups', () => {
  test('a SIGTERM ends the peer by default, and the record says so', async () => {
    const { bin, dir } = shimAt(codexScenario());
    const { proc, rpc } = start(bin, dir);
    await initialize(rpc);
    process.kill(-proc.pid, 'SIGTERM');
    await proc.exited;
    expect(proc.signalCode).toBe('SIGTERM');
    const [run] = readCodexRecord(bin);
    expect(run?.signals).toEqual(['SIGTERM']);
    expect(run?.exit).toMatchObject({ reason: 'signal', code: null, signal: 'SIGTERM' });
  }, 20_000);

  test('told to, the peer outlives stdin EOF and SIGTERM, and only a group SIGKILL ends it', async () => {
    const { bin, dir } = shimAt(codexScenario({ onStdinEof: 'ignore', ignoreSigterm: true }));
    const { proc, rpc } = start(bin, dir);
    await initialize(rpc);
    proc.stdin.end();
    expect((await boundedWait(proc.exited, 300)).done).toBe(false);
    process.kill(-proc.pid, 'SIGTERM');
    await until(() => readCodexRecord(bin)[0]?.signals.length === 1);
    expect((await boundedWait(proc.exited, 300)).done).toBe(false);
    process.kill(-proc.pid, 'SIGKILL');
    await proc.exited;
    expect(proc.signalCode).toBe('SIGKILL');
    const [run] = readCodexRecord(bin);
    expect(run?.signals).toEqual(['SIGTERM']);
    expect(run?.exit).toBeNull();
  }, 20_000);

  test('a pipe holder keeps stdout open after the peer exits, until its group is killed', async () => {
    const { bin, dir } = shimAt(
      codexScenario({ answers: { 'thread/name/set': { then: [{ spawnPipeHolder: true }, { crash: { code: 0 } }] } } }),
    );
    const { proc, rpc } = start(bin, dir);
    await initialize(rpc);
    await rpc.request('thread/name/set', { threadId: 't', name: 'n' });
    expect(await proc.exited).toBe(0);
    const [holder] = readCodexRecord(bin)[0]?.pipeHolders ?? [];
    expect(holder).toBeNumber();
    expect(alive(holder as number)).toBe(true);
    // The leader is gone, but its stdout is not closed.
    expect((await boundedWait(rpc.ended, 300)).done).toBe(false);
    process.kill(-proc.pid, 'SIGKILL');
    expect((await boundedWait(rpc.ended, 2_000)).done).toBe(true);
    await until(() => !alive(holder as number));
  }, 20_000);
});

describe('codexMessages', () => {
  test('build the 0.159.2 shapes recorded in the probes', () => {
    const usage = m.rateLimitsUpdated({
      primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1793207969 },
      secondary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: 1793290769 },
      credits: { hasCredits: false, unlimited: false, balance: null },
    });
    expect(usage).toEqual({
      method: 'account/rateLimits/updated',
      params: {
        rateLimits: {
          limitId: 'codex',
          limitName: null,
          normalModelSlug: null,
          primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1793207969 },
          secondary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: 1793290769 },
          credits: { hasCredits: false, unlimited: false, balance: null },
          individualLimit: null,
          spendControlReached: null,
          planType: null,
          rateLimitReachedType: null,
        },
      },
    });
    const error = m.turnError({ httpConnectionFailed: { httpStatusCode: 401 } }, 'unexpected status 401 Unauthorized');
    expect(m.error('t', 'u', error)).toEqual({
      method: 'error',
      params: {
        error: {
          message: 'unexpected status 401 Unauthorized',
          codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } },
          additionalDetails: null,
          misalignment: null,
        },
        willRetry: false,
        threadId: 't',
        turnId: 'u',
      },
    });
    const failed: ServerNotification = m.turnCompleted('t', m.turn({ id: 'u', status: 'failed', error }));
    expect(failed).toMatchObject({ params: { turn: { status: 'failed', error, itemsView: 'notLoaded' } } });
    expect(m.threadStatusChanged('t', ['waitingOnApproval']).params.status).toEqual({
      type: 'active',
      activeFlags: ['waitingOnApproval'],
    });
    expect(m.threadStatusChanged('t', 'idle').params.status).toEqual({ type: 'idle' });
    const approval = m.commandApprovalRequest({
      threadId: 't',
      turnId: 'u',
      item: m.commandExecutionItem({ id: 'exec-1', command: "echo 'it''s' > x", cwd: '/clone' }),
      kind: 'writeStdin',
      proposedExecpolicyAmendment: null,
    });
    expect(approval).toMatchObject({
      method: 'item/commandExecution/requestApproval',
      params: {
        kind: 'writeStdin',
        itemId: 'exec-1',
        command: `/bin/zsh -c 'echo '\\''it'\\'''\\''s'\\'' > x'`,
        commandActions: [{ type: 'unknown', command: "echo 'it''s' > x" }],
        cwd: '/clone',
        environmentId: 'local',
        proposedExecpolicyAmendment: null,
        availableDecisions: ['accept', 'cancel'],
      },
    });
  });

  /** The message with its times, which no builder can reproduce, set to 0. */
  function masked(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(masked);
    if (value === null || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, field]) => [
        key,
        ['startedAtMs', 'completedAtMs'].includes(key) ? 0 : masked(field),
      ]),
    );
  }

  /** A builder's message equals the recorded one, times aside. */
  function same(built: unknown, recorded: unknown): void {
    expect(masked(built)).toEqual(masked(recorded));
  }

  test('reproduce the messages 0.159.2 sent in the probes, fed the recorded inputs', () => {
    const recorded = probeMessages;
    const esc = recorded.commandApprovalRequest.params;
    const declinedItem = m.commandExecutionItem({
      id: esc.itemId,
      command: 'touch /tmp/m2e-probe/outside.txt; echo done',
      cwd: esc.cwd,
      status: 'declined',
    });
    same(
      m.commandApprovalRequest({ threadId: esc.threadId, turnId: esc.turnId, item: declinedItem, reason: esc.reason }),
      recorded.commandApprovalRequest,
    );
    same(m.itemCompleted(esc.threadId, esc.turnId, declinedItem), recorded.commandExecutionDeclined);
    same(m.serverRequestResolved(esc.threadId, 0), recorded.serverRequestResolved);

    const code = recorded.commandExecutionCompleted.params;
    const completed = m.commandExecutionItem({
      id: code.item.id,
      command: 'echo hi > probe.txt && cat probe.txt',
      cwd: code.item.cwd,
      status: 'completed',
      exitCode: 0,
      output: 'hi\n',
      source: 'unifiedExecStartup',
      processId: '63721',
    });
    same(m.itemCompleted(code.threadId, code.turnId, completed), recorded.commandExecutionCompleted);

    // The second request of a turn: total counts both, last only the latest.
    const usage = recorded.tokenUsageUpdated.params;
    same(
      m.tokenUsageUpdated(usage.threadId, usage.turnId, {
        total: { input: 200, output: 10 },
        last: { input: 100, output: 5 },
      }),
      recorded.tokenUsageUpdated,
    );

    // A bridge's error answer: failed, with the text in result and no error.
    const mcp = recorded.mcpToolCallFailed.params;
    const failed = m.mcpToolCallItem({
      id: mcp.item.id,
      tool: 'submit',
      args: { note: 'x' },
      status: 'failed',
      result: 'refused: dirty',
      durationMs: 0,
    });
    same(m.itemCompleted(mcp.threadId, mcp.turnId, failed), recorded.mcpToolCallFailed);

    const limits = recorded.usageLimitRateLimits.params.rateLimits;
    same(
      m.rateLimitsUpdated({ primary: limits.primary, secondary: limits.secondary, credits: limits.credits }),
      recorded.usageLimitRateLimits,
    );
    const error = recorded.usageLimitError.params;
    same(
      m.error(error.threadId, error.turnId, m.turnError('usageLimitExceeded', error.error.message)),
      recorded.usageLimitError,
    );
  });
});
```

**File:** `packages/runner/test/codex/peer.ts` (new)

```ts
// The fake app-server for CI tests (design 15, "Unit (CI)"). CI has no Codex, so the adapter's tests run
// fake-app-server.ts as a real child process behind a `codex` shim, which also exercises spawning, process groups,
// stderr drains and exit codes. This file holds what tests use: the scenario, the shim writer, the record reader and
// builders of the 0.159.2 messages recorded in the zero-model probes of 2026-10-28. The builders are typed by the
// generated protocol, so a re-pin that changes a shape fails the typecheck here too.
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CODEX_VERSION } from '../../src/adapters/codex/binary';
import type { CodexClientMethod, ResultOf } from '../../src/adapters/codex/methods';
import type {
  InitializeResponse,
  RequestId,
  ServerNotification,
  ServerRequest,
} from '../../src/adapters/codex/protocol';
import type {
  ApprovalsReviewer,
  AskForApproval,
  CodexErrorInfo,
  CommandAction,
  CommandExecutionApprovalDecision,
  CommandExecutionSource,
  RateLimitSnapshot,
  RequestPermissionProfile,
  SandboxPolicy,
  Thread,
  ThreadActiveFlag,
  ThreadItem,
  ThreadResumeResponse,
  ThreadStartResponse,
  ThreadStatus,
  TokenUsageBreakdown,
  ToolRequestUserInputQuestion,
  Turn,
  TurnError,
  TurnStatus,
} from '../../src/adapters/codex/protocol/v2';

export interface ScriptedError {
  code: number;
  message: string;
  data?: unknown;
}

type ServerRequestMethod = ServerRequest['method'];

/** A server request the peer sends; without an id it takes the next one, counting from 0 as app-server does. */
export type ScriptedServerRequest = {
  [M in ServerRequestMethod]: { method: M; params: Extract<ServerRequest, { method: M }>['params']; id?: RequestId };
}[ServerRequestMethod];

/**
 * The signals a crash step may raise: the ones that end a Bun process with that same signal. Bun's crash handler
 * turns SIGSEGV and SIGBUS into SIGTRAP, and Bun ignores SIGPIPE and SIGWINCH.
 */
export type CrashSignal = 'SIGKILL' | 'SIGTERM' | 'SIGINT' | 'SIGHUP' | 'SIGQUIT' | 'SIGABRT';

/**
 * What the peer does after an answer, in order. A server request's afterAnswer steps run once the client answers
 * it; by default that is serverRequest/resolved for the request, as 0.159.2 sends it, and [] sends nothing. A
 * withdrawal (resolved before any answer, as after turn/interrupt) is an explicit notify step. spawnPipeHolder starts
 * `sleep 600` in the peer's process group with its stdout and stderr, so the pipes stay open after the peer exits
 * and only a group kill ends it.
 */
export type ScriptedStep =
  | { notify: ServerNotification }
  | { request: ScriptedServerRequest; afterAnswer?: ScriptedStep[] }
  | { delayMs: number }
  | { stderr: string }
  | { spawnPipeHolder: true }
  | { crash: { code: number } | { signal: CrashSignal } };

/**
 * The answer to one call: a result, an error, or none at all (silent). With neither, the peer gives its default
 * answer for the method (initialize, thread/start, thread/resume, thread/name/set, turn/start, turn/steer and
 * turn/interrupt have one; any other method gets -32601) and its default follow-ups, then the scripted ones.
 */
export interface ScriptedAnswer<M extends CodexClientMethod> {
  result?: ResultOf<M>;
  error?: ScriptedError;
  silent?: boolean;
  delayMs?: number;
  then?: ScriptedStep[];
}

/** Per method; a list answers the n-th call with its n-th entry, and its last entry answers every later call. */
export type ScriptedAnswers = { [M in CodexClientMethod]?: ScriptedAnswer<M> | ScriptedAnswer<M>[] };

export interface CodexScenario {
  /** What `--version` prints and initialize's userAgent carries. */
  version: string;
  /** The thread the default thread/start creates. */
  threadId: string;
  /** Lines written to stderr at start. The peer itself, like 0.159.2, writes nothing there on a normal start. */
  stderr: string[];
  /** Exit at start with this stderr line and code, after the stderr lines and before initialize is answered. */
  failBeforeInitialize: { stderr: string; code: number } | null;
  /** exit: exit 0 on stdin EOF, as app-server does; ignore: keep running until a signal ends the peer. */
  onStdinEof: 'exit' | 'ignore';
  /** Survive SIGTERM (it is still recorded), so only SIGKILL ends the peer. */
  ignoreSigterm: boolean;
  answers: ScriptedAnswers;
}

/** runner.json's default Codex model, the pinned slug. */
const FAKE_MODEL = 'gpt-6.1-sol';

/** The thread id of the 2026-10-28 probe that the default thread/start reuses. */
export const FAKE_THREAD_ID = '01a1834e-598f-77a1-bd86-8d6cd93820d0';

/** The id of the n-th turn the default turn/start opens in one run, counting from 1. */
export function fakeTurnId(n: number): string {
  return `01a1834e-59c1-7440-866e-${n.toString(16).padStart(12, '0')}`;
}

export function codexScenario(overrides: Partial<CodexScenario> = {}): CodexScenario {
  return {
    version: CODEX_VERSION,
    threadId: FAKE_THREAD_ID,
    stderr: [],
    failBeforeInitialize: null,
    onStdinEof: 'exit',
    ignoreSigterm: false,
    answers: {},
    ...overrides,
  };
}

const FAKE_APP_SERVER = join(import.meta.dir, 'fake-app-server.ts');

/** The shim's scenarios, record and run counters live next to it. */
export function fakeDir(shim: string): string {
  return `${shim}.fake`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The shim: a bun script that imports the fake, so the fake gets exactly the environment it was spawned with (a
 * /bin/sh shim would add PWD and SHLVL) and its own path as argv[1].
 */
function shimSource(): string {
  if (/\s/.test(process.execPath)) throw new Error(`a shebang cannot hold bun's path: ${process.execPath}`);
  return `#!${process.execPath}\nawait import(${JSON.stringify(FAKE_APP_SERVER)});\n`;
}

/** What any checkout's shim looks like; writeCodexShim replaces only files like it. */
const SHIM_SOURCE = /^#!\S+\nawait import\(".*\/fake-app-server\.ts"\);\n$/;

// macOS scans every new executable on its first run, which costs about half a second. Every shim is therefore a hard
// link to one script, kept at a path named after its content and reused by every test process of this checkout and
// bun; it is never removed, since bun test runs no exit hooks.
let canonicalShim: string | null = null;

function shimScript(): string {
  if (canonicalShim) return canonicalShim;
  const source = shimSource();
  const path = join(tmpdir(), `agflow-codex-shim-${Bun.hash(source).toString(16)}`);
  if (!existsSync(path) || readFileSync(path, 'utf8') !== source) {
    // Written aside and renamed, so a concurrent test process never runs a half-written script.
    const staging = `${path}.${process.pid}`;
    writeFileSync(staging, source);
    chmodSync(staging, 0o755);
    renameSync(staging, path);
  }
  canonicalShim = path;
  return path;
}

function isShim(path: string, script: string): boolean {
  try {
    return statSync(path).ino === statSync(script).ino || SHIM_SOURCE.test(readFileSync(path, 'utf8'));
  } catch {
    return false;
  }
}

/**
 * Writes an executable `codex` at path, such as <AGFLOW_HOME>/runner/vendor/codex/<version>/bin/codex, that runs
 * the fake under this bun. A list of scenarios gives the n-th app-server start the n-th one, and the last one every
 * later start. Writing a shim again replaces its scenarios and starts a fresh record. Any other file at path is
 * refused, so a path built without a temp home never replaces a real binary. Shims share one inode: they are only
 * ever replaced through writeCodexShim or removed, never chmod-ed or written in place.
 */
export function writeCodexShim(path: string, scenario: CodexScenario | CodexScenario[]): string {
  const script = shimScript();
  if (existsSync(path) && !isShim(path, script)) {
    throw new Error(`${path} exists and is not a fake codex shim, so it is not replaced`);
  }
  const dir = fakeDir(path);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'runs'), { recursive: true });
  writeFileSync(join(dir, 'scenarios.json'), JSON.stringify(Array.isArray(scenario) ? scenario : [scenario]));
  if (!existsSync(path) || statSync(path).ino !== statSync(script).ino) {
    mkdirSync(dirname(path), { recursive: true });
    rmSync(path, { force: true });
    try {
      linkSync(script, path);
    } catch {
      // Another volume: a copy works too, only its first run is slower.
      copyFileSync(script, path);
      chmodSync(path, 0o755);
    }
  }
  return path;
}

export interface CodexRunExit {
  /**
   * eof: stdin ended; crash: a scripted crash; failed: failBeforeInitialize or a missing CODEX_HOME; signal: a
   * SIGTERM it received.
   */
  reason: 'eof' | 'crash' | 'failed' | 'signal';
  code: number | null;
  signal: string | null;
  at: number;
}

/** One app-server start of the shim; times are epoch milliseconds. */
export interface CodexRun {
  run: number;
  pid: number;
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  startedAt: number;
  /** Just before the answer to initialize was written. */
  initializedAt: number | null;
  requests: { id: RequestId; method: string; params: unknown; at: number }[];
  /** The client's notifications, such as initialized. */
  notifications: { method: string; params: unknown; at: number }[];
  /** The client's answers to server requests. */
  answers: { id: RequestId; result?: unknown; error?: unknown; at: number }[];
  /** The catchable signals the peer received (SIGTERM), whether or not they ended it. */
  signals: string[];
  /** The pids of the pipe holders spawnPipeHolder started. */
  pipeHolders: number[];
  exit: CodexRunExit | null;
}

/** What fake-app-server.ts records. */
export type RecordEvent =
  | { type: 'start'; pid: number; argv: string[]; env: Record<string, string>; cwd: string }
  | { type: 'request'; id: RequestId; method: string; params: unknown }
  | { type: 'notification'; method: string; params: unknown }
  | { type: 'answer'; id: RequestId; result?: unknown; error?: unknown }
  | { type: 'initialized' }
  | { type: 'signal'; signal: string }
  | { type: 'pipeHolder'; pid: number }
  | ({ type: 'exit' } & Omit<CodexRunExit, 'at'>);

/** A line of the record: the event, its run and its time. */
type RecordEntry = { run: number; at: number } & RecordEvent;

/** The app-server starts of a shim since it was written, in start order. */
export function readCodexRecord(shim: string): CodexRun[] {
  const file = join(fakeDir(shim), 'record.jsonl');
  if (!existsSync(file)) return [];
  const runs = new Map<number, CodexRun>();
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line === '') continue;
    const entry = JSON.parse(line) as RecordEntry;
    if (entry.type === 'start') {
      runs.set(entry.run, {
        run: entry.run,
        pid: entry.pid,
        argv: entry.argv,
        env: entry.env,
        cwd: entry.cwd,
        startedAt: entry.at,
        initializedAt: null,
        requests: [],
        notifications: [],
        answers: [],
        signals: [],
        pipeHolders: [],
        exit: null,
      });
      continue;
    }
    const run = runs.get(entry.run);
    if (!run) continue;
    if (entry.type === 'request') {
      run.requests.push({ id: entry.id, method: entry.method, params: entry.params, at: entry.at });
    } else if (entry.type === 'notification') {
      run.notifications.push({ method: entry.method, params: entry.params, at: entry.at });
    } else if (entry.type === 'answer') {
      const { run: _run, type: _type, ...answer } = entry;
      run.answers.push(answer);
    } else if (entry.type === 'initialized') {
      run.initializedAt = entry.at;
    } else if (entry.type === 'signal') {
      run.signals.push(entry.signal);
    } else if (entry.type === 'pipeHolder') {
      run.pipeHolders.push(entry.pid);
    } else {
      run.exit = { reason: entry.reason, code: entry.code, signal: entry.signal, at: entry.at };
    }
  }
  return [...runs.values()].sort((a, b) => a.run - b.run);
}

type Note<M extends ServerNotification['method']> = Extract<ServerNotification, { method: M }>;
type Request<M extends ServerRequestMethod> = Extract<ScriptedServerRequest, { method: M }>;
type Item<T extends ThreadItem['type']> = Extract<ThreadItem, { type: T }>;

const seconds = () => Math.floor(Date.now() / 1000);

function initializeResult(
  version: string,
  client: { name: string; version: string },
  codexHome: string,
): InitializeResponse {
  return {
    userAgent: `${client.name}/${version} (Mac OS 26.6.2; arm64) unknown (${client.name}; ${client.version})`,
    codexHome,
    platformFamily: 'unix',
    platformOs: 'macos',
  };
}

function thread(options: {
  id: string;
  cwd: string;
  model?: string;
  modelProvider?: string;
  cliVersion?: string;
  status?: ThreadStatus;
  name?: string | null;
  path?: string | null;
  turns?: Turn[];
}): Thread {
  const at = seconds();
  const value: Thread = {
    id: options.id,
    sessionId: options.id,
    forkedFromId: null,
    parentThreadId: null,
    preview: '',
    ephemeral: false,
    section: null,
    sectionEnteredAt: null,
    projectId: null,
    historyMode: 'paginated',
    modelProvider: options.modelProvider ?? 'agflow_test',
    model: options.model ?? FAKE_MODEL,
    reasoningEffort: null,
    createdAt: at,
    updatedAt: at,
    recencyAt: at,
    status: options.status ?? { type: 'idle' },
    path: options.path ?? null,
    cwd: options.cwd,
    cliVersion: options.cliVersion ?? CODEX_VERSION,
    originator: 'agflow',
    source: 'vscode',
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: options.name ?? null,
    turns: options.turns ?? [],
  };
  // 0.159.2 sends these too, beyond the generated type.
  return Object.assign(value, {
    environments: [{ environmentId: 'local', cwd: options.cwd, runtimeWorkspaceRoots: [options.cwd] }],
    extra: null,
    canAcceptDirectInput: true,
    daybreakEnabled: null,
  });
}

interface ThreadResultOptions {
  thread: Thread;
  approvalPolicy?: AskForApproval;
  approvalsReviewer?: ApprovalsReviewer;
  sandbox?: SandboxPolicy;
}

/** agflow's thread settings (design 9.2), as app-server echoes them. */
function threadStartResult(options: ThreadResultOptions): ThreadStartResponse {
  const cwd = options.thread.cwd;
  const sandbox: SandboxPolicy = options.sandbox ?? {
    type: 'workspaceWrite',
    writableRoots: [`${cwd}/.git`],
    networkAccess: false,
    excludeTmpdirEnvVar: true,
    excludeSlashTmp: true,
  };
  const value: ThreadStartResponse = {
    thread: options.thread,
    model: options.thread.model ?? FAKE_MODEL,
    modelProvider: options.thread.modelProvider,
    serviceTier: null,
    disabledPluginIds: [],
    cwd,
    instructionSources: [],
    approvalPolicy: options.approvalPolicy ?? 'on-request',
    approvalsReviewer: options.approvalsReviewer ?? 'user',
    sandbox,
    reasoningEffort: null,
  };
  return Object.assign(value, {
    runtimeWorkspaceRoots: [cwd, ...(sandbox.type === 'workspaceWrite' ? sandbox.writableRoots : [])],
    activePermissionProfile: null,
    multiAgentMode: 'explicitRequestOnly',
  });
}

function threadResumeResult(options: ThreadResultOptions): ThreadResumeResponse {
  return {
    ...threadStartResult(options),
    collaborationMode: null,
    turnsBackwardsCursor: null,
    itemsBackwardsCursor: null,
  };
}

function turn(options: {
  id: string;
  status: TurnStatus;
  error?: TurnError | null;
  items?: ThreadItem[];
  startedAt?: number | null;
}): Turn {
  const done = options.status !== 'inProgress';
  const items = options.items ?? [];
  return {
    id: options.id,
    items,
    itemsView: items.length > 0 ? 'summary' : 'notLoaded',
    status: options.status,
    error: options.error ?? null,
    startedAt: options.startedAt === undefined ? seconds() : options.startedAt,
    completedAt: done ? seconds() : null,
    durationMs: done ? 100 : null,
  };
}

function turnError(codexErrorInfo: CodexErrorInfo | null, message: string): TurnError {
  return { message, codexErrorInfo, additionalDetails: null, misalignment: null };
}

function userMessageItem(text: string, id = 'user-1'): Item<'userMessage'> {
  return { type: 'userMessage', id, clientId: null, content: [{ type: 'text', text, text_elements: [] }] };
}

function agentMessageItem(text: string, id = 'msg_1'): Item<'agentMessage'> {
  return { type: 'agentMessage', id, text, phase: null, memoryCitation: null, delivery: null, questions: null };
}

/**
 * A command as 0.159.2 reports it: command is the inner script wrapped in `<shell> -c '…'`, and commandActions
 * hold the inner script alone unless actions are given.
 */
function commandExecutionItem(options: {
  id: string;
  /** The inner script, such as `touch out.txt`. */
  command: string;
  shell?: string;
  cwd: string;
  status?: Item<'commandExecution'>['status'];
  exitCode?: number | null;
  output?: string | null;
  actions?: CommandAction[];
  source?: CommandExecutionSource;
  processId?: string | null;
}): Item<'commandExecution'> {
  const status = options.status ?? 'inProgress';
  return {
    type: 'commandExecution',
    id: options.id,
    pluginId: null,
    scriptPath: null,
    command: `${options.shell ?? '/bin/zsh'} -c ${shellQuote(options.command)}`,
    cwd: options.cwd,
    processId: options.processId ?? null,
    source: options.source ?? 'agent',
    status,
    commandActions: options.actions ?? [{ type: 'unknown', command: options.command }],
    aggregatedOutput: options.output ?? null,
    exitCode: options.exitCode ?? null,
    // A declined command never ran.
    durationMs: status === 'completed' || status === 'failed' ? 0 : null,
  };
}

/** The inner script of a `<shell> -c '…'` command, or the command itself. */
function innerScript(command: string): string {
  const quoted = command.match(/^\S+ -c '((?:[^']|'\\'')*)'$/)?.[1];
  return quoted === undefined ? command : quoted.replaceAll("'\\''", "'");
}

/** The words of a script's first simple command, as 0.159.2 proposes them for an exec policy amendment. */
function firstCommandWords(script: string): string[] | null {
  const words = (script.split(/[;&|<>\n]/)[0] ?? '').trim().split(/\s+/).filter(Boolean);
  return words.length > 0 ? words : null;
}

function fileChangeItem(options: {
  id: string;
  changes: Item<'fileChange'>['changes'];
  status?: Item<'fileChange'>['status'];
}): Item<'fileChange'> {
  return { type: 'fileChange', id: options.id, changes: options.changes, status: options.status ?? 'inProgress' };
}

/**
 * A call of an agflow bridge tool; result is its text answer. A bridge's error answer is status 'failed' with its
 * text in result and error null, as 0.159.2 reported `refused: dirty`; error is only for a call that got no answer.
 */
function mcpToolCallItem(options: {
  id: string;
  tool: string;
  args: Item<'mcpToolCall'>['arguments'];
  status?: Item<'mcpToolCall'>['status'];
  result?: string;
  error?: string;
  durationMs?: number;
}): Item<'mcpToolCall'> {
  const status = options.status ?? 'inProgress';
  return {
    type: 'mcpToolCall',
    id: options.id,
    server: 'agflow',
    tool: options.tool,
    status,
    arguments: options.args,
    appContext: null,
    mcpAppUi: null,
    pluginId: null,
    readOnlyHint: null,
    result:
      options.result === undefined
        ? null
        : { content: [{ type: 'text', text: options.result }], structuredContent: null, _meta: null },
    error: options.error === undefined ? null : { message: options.error },
    durationMs: status === 'inProgress' ? null : (options.durationMs ?? 1),
  };
}

function contextCompactionItem(id = 'compaction-1'): Item<'contextCompaction'> {
  return { type: 'contextCompaction', id };
}

function threadStarted(value: Thread): Note<'thread/started'> {
  return { method: 'thread/started', params: { thread: value } };
}

/** An idle, notLoaded or systemError thread, or an active one with these flags. */
function threadStatusChanged(
  threadId: string,
  status: 'idle' | 'notLoaded' | 'systemError' | ThreadActiveFlag[],
): Note<'thread/status/changed'> {
  return {
    method: 'thread/status/changed',
    params: { threadId, status: Array.isArray(status) ? { type: 'active', activeFlags: status } : { type: status } },
  };
}

function turnStarted(threadId: string, value: Turn): Note<'turn/started'> {
  return { method: 'turn/started', params: { threadId, turn: value } };
}

function turnCompleted(threadId: string, value: Turn): Note<'turn/completed'> {
  return { method: 'turn/completed', params: { threadId, turn: value } };
}

function itemStarted(threadId: string, turnId: string, item: ThreadItem): Note<'item/started'> {
  return { method: 'item/started', params: { item, threadId, turnId, startedAtMs: Date.now() } };
}

function itemCompleted(threadId: string, turnId: string, item: ThreadItem): Note<'item/completed'> {
  return { method: 'item/completed', params: { item, threadId, turnId, completedAtMs: Date.now() } };
}

interface TokenCounts {
  input: number;
  output: number;
}

function tokens(counts: TokenCounts): TokenUsageBreakdown {
  return {
    totalTokens: counts.input + counts.output,
    inputTokens: counts.input,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: counts.output,
    reasoningOutputTokens: 0,
  };
}

/** total accumulates over the thread's requests and last is the latest request alone, as 0.159.2 reports them. */
function tokenUsageUpdated(
  threadId: string,
  turnId: string,
  usage: { total: TokenCounts; last: TokenCounts },
  modelContextWindow: number | null = 258_400,
): Note<'thread/tokenUsage/updated'> {
  return {
    method: 'thread/tokenUsage/updated',
    params: {
      threadId,
      turnId,
      tokenUsage: { total: tokens(usage.total), last: tokens(usage.last), modelContextWindow },
    },
  };
}

/** A sparse update, as a scripted provider's x-codex headers produce it. */
function rateLimitsUpdated(snapshot: Partial<RateLimitSnapshot> = {}): Note<'account/rateLimits/updated'> {
  return {
    method: 'account/rateLimits/updated',
    params: {
      rateLimits: {
        limitId: 'codex',
        limitName: null,
        normalModelSlug: null,
        primary: null,
        secondary: null,
        credits: null,
        individualLimit: null,
        spendControlReached: null,
        planType: null,
        rateLimitReachedType: null,
        ...snapshot,
      },
    },
  };
}

function error(threadId: string, turnId: string, value: TurnError, willRetry = false): Note<'error'> {
  return { method: 'error', params: { error: value, willRetry, threadId, turnId } };
}

function serverRequestResolved(threadId: string, requestId: RequestId): Note<'serverRequest/resolved'> {
  return { method: 'serverRequest/resolved', params: { threadId, requestId } };
}

function configWarning(summary: string, details: string | null = null): Note<'configWarning'> {
  return { method: 'configWarning', params: { summary, details } };
}

function warning(message: string, threadId: string | null = null): Note<'warning'> {
  return { method: 'warning', params: { threadId, message } };
}

/**
 * A command approval as 0.159.2 asks it: by default it proposes an exec policy amendment of the inner script's
 * first command and offers accept, accept with that amendment, and cancel.
 */
function commandApprovalRequest(options: {
  threadId: string;
  turnId: string;
  item: Item<'commandExecution'>;
  kind?: 'command' | 'writeStdin';
  reason?: string | null;
  proposedExecpolicyAmendment?: string[] | null;
  availableDecisions?: CommandExecutionApprovalDecision[];
  id?: RequestId;
}): Request<'item/commandExecution/requestApproval'> {
  const amendment =
    options.proposedExecpolicyAmendment === undefined
      ? firstCommandWords(innerScript(options.item.command))
      : options.proposedExecpolicyAmendment;
  const decisions: CommandExecutionApprovalDecision[] = options.availableDecisions ?? [
    'accept',
    ...(amendment ? [{ acceptWithExecpolicyAmendment: { execpolicy_amendment: amendment } }] : []),
    'cancel',
  ];
  const params: Request<'item/commandExecution/requestApproval'>['params'] = {
    kind: options.kind ?? 'command',
    threadId: options.threadId,
    turnId: options.turnId,
    itemId: options.item.id,
    startedAtMs: Date.now(),
    environmentId: 'local',
    reason: options.reason ?? null,
    command: options.item.command,
    cwd: options.item.cwd,
    commandActions: options.item.commandActions,
    proposedExecpolicyAmendment: amendment,
  };
  return {
    method: 'item/commandExecution/requestApproval',
    // 0.159.2 sends availableDecisions beyond the generated type.
    params: Object.assign(params, { availableDecisions: decisions }),
    ...(options.id === undefined ? {} : { id: options.id }),
  };
}

function fileChangeApprovalRequest(options: {
  threadId: string;
  turnId: string;
  itemId: string;
  reason?: string | null;
  grantRoot?: string | null;
  id?: RequestId;
}): Request<'item/fileChange/requestApproval'> {
  return {
    method: 'item/fileChange/requestApproval',
    params: {
      threadId: options.threadId,
      turnId: options.turnId,
      itemId: options.itemId,
      startedAtMs: Date.now(),
      reason: options.reason ?? null,
      grantRoot: options.grantRoot ?? null,
    },
    ...(options.id === undefined ? {} : { id: options.id }),
  };
}

function permissionsApprovalRequest(options: {
  threadId: string;
  turnId: string;
  itemId: string;
  cwd: string;
  permissions: RequestPermissionProfile;
  reason?: string | null;
  id?: RequestId;
}): Request<'item/permissions/requestApproval'> {
  return {
    method: 'item/permissions/requestApproval',
    params: {
      threadId: options.threadId,
      turnId: options.turnId,
      itemId: options.itemId,
      environmentId: 'local',
      startedAtMs: Date.now(),
      cwd: options.cwd,
      reason: options.reason ?? null,
      permissions: options.permissions,
    },
    ...(options.id === undefined ? {} : { id: options.id }),
  };
}

function userInputRequest(options: {
  threadId: string;
  turnId: string;
  itemId: string;
  questions: ToolRequestUserInputQuestion[];
  id?: RequestId;
}): Request<'item/tool/requestUserInput'> {
  return {
    method: 'item/tool/requestUserInput',
    params: {
      threadId: options.threadId,
      turnId: options.turnId,
      itemId: options.itemId,
      questions: options.questions,
      isBlocking: true,
      autoResolutionMs: null,
    },
    ...(options.id === undefined ? {} : { id: options.id }),
  };
}

function elicitationRequest(options: {
  threadId: string;
  turnId: string | null;
  serverName: string;
  message: string;
  id?: RequestId;
}): Request<'mcpServer/elicitation/request'> {
  return {
    method: 'mcpServer/elicitation/request',
    params: {
      threadId: options.threadId,
      turnId: options.turnId,
      serverName: options.serverName,
      mode: 'form',
      _meta: null,
      message: options.message,
      requestedSchema: { type: 'object', properties: {} },
    },
    ...(options.id === undefined ? {} : { id: options.id }),
  };
}

/** Builders of app-server 0.159.2 messages, in the shapes the probes recorded (test-only). */
export const codexMessages = {
  initializeResult,
  thread,
  threadStartResult,
  threadResumeResult,
  turn,
  turnError,
  userMessageItem,
  agentMessageItem,
  commandExecutionItem,
  fileChangeItem,
  mcpToolCallItem,
  contextCompactionItem,
  threadStarted,
  threadStatusChanged,
  turnStarted,
  turnCompleted,
  itemStarted,
  itemCompleted,
  tokenUsageUpdated,
  rateLimitsUpdated,
  error,
  serverRequestResolved,
  configWarning,
  warning,
  commandApprovalRequest,
  fileChangeApprovalRequest,
  permissionsApprovalRequest,
  userInputRequest,
  elicitationRequest,
};
```

**File:** `packages/runner/test/codex/probe-messages.json` (new)

```json
{
  "commandExecutionCompleted": {
    "method": "item/completed",
    "params": {
      "item": {
        "type": "commandExecution",
        "id": "exec-8f8c7fbc-92f3-4974-844e-06d183d29164",
        "pluginId": null,
        "scriptPath": null,
        "command": "/bin/zsh -c 'echo hi > probe.txt && cat probe.txt'",
        "cwd": "/private/tmp/m2e-probe/run-code/clone",
        "processId": "63721",
        "source": "unifiedExecStartup",
        "status": "completed",
        "commandActions": [
          {
            "type": "unknown",
            "command": "echo hi > probe.txt && cat probe.txt"
          }
        ],
        "aggregatedOutput": "hi\n",
        "exitCode": 0,
        "durationMs": 0
      },
      "threadId": "01a1834e-1e1e-70e1-9be0-0526ebc6edc5",
      "turnId": "01a1834e-1e72-7dc3-a690-387cd7adfaf9",
      "completedAtMs": 1793204297579
    }
  },
  "commandApprovalRequest": {
    "method": "item/commandExecution/requestApproval",
    "params": {
      "kind": "command",
      "threadId": "01a1834e-598f-77a1-bd86-8d6cd93820d0",
      "turnId": "01a1834e-59c1-7440-866e-35e5a9e684e6",
      "itemId": "exec-9e66d3d2-19e1-4d20-82a2-7d0b6df5bfb8",
      "startedAtMs": 1793204312644,
      "environmentId": "local",
      "reason": "probe needs to write outside",
      "command": "/bin/zsh -c 'touch /tmp/m2e-probe/outside.txt; echo done'",
      "cwd": "/private/tmp/m2e-probe/run-esc/clone",
      "commandActions": [
        {
          "type": "unknown",
          "command": "touch /tmp/m2e-probe/outside.txt; echo done"
        }
      ],
      "proposedExecpolicyAmendment": [
        "touch",
        "/tmp/m2e-probe/outside.txt"
      ],
      "availableDecisions": [
        "accept",
        {
          "acceptWithExecpolicyAmendment": {
            "execpolicy_amendment": [
              "touch",
              "/tmp/m2e-probe/outside.txt"
            ]
          }
        },
        "cancel"
      ]
    }
  },
  "serverRequestResolved": {
    "method": "serverRequest/resolved",
    "params": {
      "threadId": "01a1834e-598f-77a1-bd86-8d6cd93820d0",
      "requestId": 0
    }
  },
  "commandExecutionDeclined": {
    "method": "item/completed",
    "params": {
      "item": {
        "type": "commandExecution",
        "id": "exec-9e66d3d2-19e1-4d20-82a2-7d0b6df5bfb8",
        "pluginId": null,
        "scriptPath": null,
        "command": "/bin/zsh -c 'touch /tmp/m2e-probe/outside.txt; echo done'",
        "cwd": "/private/tmp/m2e-probe/run-esc/clone",
        "processId": null,
        "source": "agent",
        "status": "declined",
        "commandActions": [
          {
            "type": "unknown",
            "command": "touch /tmp/m2e-probe/outside.txt; echo done"
          }
        ],
        "aggregatedOutput": null,
        "exitCode": null,
        "durationMs": null
      },
      "threadId": "01a1834e-598f-77a1-bd86-8d6cd93820d0",
      "turnId": "01a1834e-59c1-7440-866e-35e5a9e684e6",
      "completedAtMs": 1793204312650
    }
  },
  "tokenUsageUpdated": {
    "method": "thread/tokenUsage/updated",
    "params": {
      "threadId": "01a1834e-598f-77a1-bd86-8d6cd93820d0",
      "turnId": "01a1834e-59c1-7440-866e-35e5a9e684e6",
      "tokenUsage": {
        "total": {
          "totalTokens": 210,
          "inputTokens": 200,
          "cachedInputTokens": 0,
          "cacheWriteInputTokens": 0,
          "outputTokens": 10,
          "reasoningOutputTokens": 0
        },
        "last": {
          "totalTokens": 105,
          "inputTokens": 100,
          "cachedInputTokens": 0,
          "cacheWriteInputTokens": 0,
          "outputTokens": 5,
          "reasoningOutputTokens": 0
        },
        "modelContextWindow": 258400
      }
    }
  },
  "mcpToolCallFailed": {
    "method": "item/completed",
    "params": {
      "item": {
        "type": "mcpToolCall",
        "id": "exec-918dda78-263a-49a2-8f23-1f7ed728ace3",
        "server": "agflow",
        "tool": "submit",
        "status": "failed",
        "arguments": {
          "note": "x"
        },
        "appContext": null,
        "mcpAppUi": null,
        "pluginId": null,
        "readOnlyHint": null,
        "result": {
          "content": [
            {
              "type": "text",
              "text": "refused: dirty"
            }
          ],
          "structuredContent": null,
          "_meta": null
        },
        "error": null,
        "durationMs": 0
      },
      "threadId": "01a18367-23cb-7b00-b67f-4fb22730cfd6",
      "turnId": "01a18367-243c-7dd1-b93f-946d185aed8e",
      "completedAtMs": 1793205937403
    }
  },
  "usageLimitRateLimits": {
    "method": "account/rateLimits/updated",
    "params": {
      "rateLimits": {
        "limitId": "codex",
        "limitName": null,
        "normalModelSlug": null,
        "primary": {
          "usedPercent": 100,
          "windowDurationMins": 300,
          "resetsAt": 1793207969
        },
        "secondary": {
          "usedPercent": 10,
          "windowDurationMins": 10080,
          "resetsAt": 1793290769
        },
        "credits": {
          "hasCredits": false,
          "unlimited": false,
          "balance": null
        },
        "individualLimit": null,
        "spendControlReached": null,
        "planType": null,
        "rateLimitReachedType": null
      }
    }
  },
  "usageLimitError": {
    "method": "error",
    "params": {
      "error": {
        "message": "You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 7:49 PM.",
        "codexErrorInfo": "usageLimitExceeded",
        "additionalDetails": null,
        "misalignment": null
      },
      "willRetry": false,
      "threadId": "01a1834f-3675-7842-8f9e-27fc3fbfc203",
      "turnId": "01a1834f-3699-76f0-9b39-34b5baa78ac1"
    }
  }
}
```

- [ ] **Step 2: Check it**

Run: `bun test packages/runner/test/codex/peer.test.ts && bun test && bun run typecheck`
Expected: the task's tests pass (23 pass); then the whole suite passes (`0 fail`) and `tsc` exits 0.

Every file of this task is a test helper or a test, so the tests pass as soon as the files exist. Shims are hard links to one canonical script in the temporary directory, since macOS executable scanning can add about half a second to a new executable's first run; the fake reads its launch path from the kernel (`sysctl KERN_PROCARGS2` through `bun:ffi`) to find its own scenario, because Bun resolves `argv[1]` to the link target, and falls back to `argv[1]` off macOS. Like 0.159.2, the fake refuses requests before `initialize` and exits 1 with the real two lines when `CODEX_HOME` is missing, so tests create `CODEX_HOME` and send `initialize` first. A request's scripted notifications go out right after its answer, before the answer to any later request. The concurrent-shim test starts 12 shims at once; larger batches can time out under load.

- [ ] **Step 3: Commit**

```bash
git add -A 'packages/runner/test/codex/fake-app-server.ts' 'packages/runner/test/codex/peer.test.ts' 'packages/runner/test/codex/peer.ts' 'packages/runner/test/codex/probe-messages.json'
git commit -m 'M2E Task 6: Fake app-server peer for CI tests' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

### Task 7: App-server launch configuration

Everything Codex receives, built in one place without a process (design 9.1, 9.2, 7.6, 15.1). `appServerArgs` gives the section 9.1 flags, plus one `-c key=<TOML>` per top-level key of `test.codexConfig` in test mode, so no `config.toml` is ever written. `appServerEnv` sets `CODEX_HOME`, `HOME` and `GIT_DIR=/dev/null` over the allowlisted base and the bridge variables, and drops every `CODEX_MANAGED_*` variable (X-10). `threadOverrides(launch, bridgeCwd)` gives the section 9.2 overrides that `thread/start` and `thread/resume` both receive: the clone's realpath as cwd, explicit trust, the workspace sandbox with `.git` writable, the tool environment, and the agflow bridge started in `bridgeCwd` with `env_vars` naming every bridge variable (X-31, X-32). `codexToolsNote(names)` is the line that tells the agent its agflow tools and how Code Mode calls them. The shared thread overrides put the brief and the role's prefixed tools note in developerInstructions and set the MCP tool timeout to cover the bridge's poll budget plus 30 seconds.

**Files:**
- Create: `packages/runner/src/adapters/codex/config.ts`
- Test: `packages/runner/test/codex/config.test.ts`

- [ ] **Step 1: Write the failing test**

**File:** `packages/runner/test/codex/config.test.ts` (new)

```ts
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexTestConfig } from '@agflow/testkit/src/codex/index';
import {
  appServerArgs,
  appServerEnv,
  codexToolsNote,
  threadOverrides,
  tomlInline,
} from '../../src/adapters/codex/config';
import type { ParamsOf } from '../../src/adapters/codex/methods';
import type { JsonValue } from '../../src/adapters/codex/protocol/serde_json/JsonValue';
import type { RunnerTestBlock } from '../../src/config';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type LaunchPart = Parameters<typeof threadOverrides>[0];

const BRIDGE_CWD = '/runner/homes/codex-user';

function launchFixture(): LaunchPart {
  const dir = mkdtempSync(join(tmpdir(), 'agflow-codex-config-'));
  dirs.push(dir);
  const clone = join(dir, 'clone.link');
  mkdirSync(join(dir, 'real.clone'));
  symlinkSync(join(dir, 'real.clone'), clone);
  return {
    clone,
    model: 'test-model',
    brief: `Implement the task.\n\nYour working directory: ${clone}`,
    projectConfigVerified: true,
    tmpDir: join(clone, '.agflow', 'run', 'tmp'),
    bridge: {
      command: '/runner/bin/bun',
      args: ['/runner/agflow.ts', 'mcp', '--vendor', 'codex', '--runner'],
      env: {
        AGFLOW_AGENT_TOKEN: 'secret-agent-token',
        AGFLOW_HUB_URL: 'http://localhost:3000',
        AGFLOW_BRIDGE_POLL_MS: '20',
        AGFLOW_CONFIG_DIR: join(clone, '.agflow', 'run', 'config'),
        NODE_USE_SYSTEM_CA: '1',
        HTTPS_PROXY: 'http://localhost:1234',
        SSL_CERT_FILE: '/runner/ca.pem',
      },
      tools: ['get_brief', 'submit'],
    },
    profile: { name: 'standard', network: { allowedDomains: ['registry.npmjs.org'] }, webTools: false },
  };
}

describe('tomlInline', () => {
  test('round-trips strings, numbers, booleans, arrays and nested tables', () => {
    const values: JsonValue[] = [
      '', 'quotes " and backslashes \\ and newline\n', '\b\t\n\f\r\x7f', 'Unicode: café 🌍',
      true, false, 0, -42, 1.25, -0.125, 1e30, 1e-20,
      [], {}, [1, 'two', false, { nested: [3.5] }],
      { bare_key: true, 'hyphen-key': 2, 'a.b': { 'a "quoted" \\ key\n': ['value', 4] }, '': 'empty key' },
    ];
    for (const value of values) {
      expect(Bun.TOML.parse(`v = ${tomlInline(value)}`)).toEqual({ v: value });
    }
  });

  test('escapes every TOML control character in strings and quoted keys', () => {
    // Bun 1.3.11's TOML-to-JSON conversion rejects controls such as \\u0001; verify their escapes directly.
    for (const code of [...Array.from({ length: 32 }, (_, n) => n), 127]) {
      const character = String.fromCharCode(code);
      const quoted = `"\\u${code.toString(16).padStart(4, '0')}"`;
      expect(tomlInline(character)).toBe(quoted);
      expect(tomlInline({ [character]: true })).toBe(`{ ${quoted} = true }`);
      expect(JSON.parse(tomlInline(character))).toBe(character);
    }
  });

  test('omits undefined object members, including in nested tables', () => {
    const rendered = tomlInline({ absent: undefined, nested: { absent: undefined, present: false } });
    expect(Bun.TOML.parse(`v = ${rendered}`)).toEqual({ v: { nested: { present: false } } });
  });

  test('rejects null and non-finite numbers even inside arrays or tables', () => {
    for (const value of [null, NaN, Infinity, -Infinity]) {
      for (const nested of [value, [value], { nested: value }]) {
        expect(() => tomlInline(nested)).toThrow();
      }
    }
  });
});

describe('appServerArgs', () => {
  const flags = [
    'app-server', '--disable', 'hooks', '--disable', 'apps', '--disable', 'plugins',
    '--disable', 'remote_plugin', '-c', 'features.shell_snapshot=false', '-c', 'allow_login_shell=false',
  ];

  test('returns exactly the production flags without test configuration', () => {
    expect(appServerArgs()).toEqual(flags);
    expect(appServerArgs(null)).toEqual(flags);
    expect(appServerArgs({})).toEqual(flags);
    const changed = appServerArgs();
    changed.push('extra');
    expect(appServerArgs()).toEqual(flags);
  });

  test('passes the scripted provider and hand-written values as ordered, parseable -c flags', () => {
    const configs: RunnerTestBlock['codexConfig'][] = [
      codexTestConfig('http://localhost:1234/v1'),
      { text: '"quoted" \\ path\n\t', table: { 'key.with.dots': { values: [true, false, 3, 1.5] } } },
    ];
    for (const config of configs) {
      const args = appServerArgs(config);
      expect(args.slice(0, flags.length)).toEqual(flags);
      expect(args.length).toBe(flags.length + 2 * Object.keys(config).length);
      Object.entries(config).forEach(([key, value], index) => {
        const pair = args.slice(flags.length + 2 * index, flags.length + 2 * index + 2);
        expect(pair).toEqual(['-c', `${key}=${tomlInline(value)}`]);
        expect(Bun.TOML.parse(pair[1])).toEqual({ [key]: value });
      });
    }
  });

  test('rejects top-level keys Codex would split or misinterpret and unrenderable values', () => {
    for (const key of ['a.b', '', 'with space', 'quote"', 'back\\slash', 'é', 'trailing\n']) {
      expect(() => appServerArgs({ [key]: true })).toThrow();
    }
    for (const value of [null, NaN, Infinity]) expect(() => appServerArgs({ value })).toThrow();
    expect(appServerArgs({ 'valid-key_123': true }).slice(-2)).toEqual(['-c', 'valid-key_123=true']);
  });
});

describe('appServerEnv', () => {
  test('merges bridge values, forces runner homes, drops undefined and all managed variables', () => {
    const base = {
      PATH: '/runner/bin', HOME: '/owner', CODEX_HOME: '/owner/.codex', EMPTY: '', MISSING: undefined,
      AGFLOW_AGENT_TOKEN: 'old', CODEX_MANAGED_BY_NPM: '1', CODEX_MANAGED_OTHER: 'yes',
    };
    const bridgeEnv = {
      AGFLOW_AGENT_TOKEN: 'new', HTTPS_PROXY: 'http://proxy', NODE_USE_SYSTEM_CA: '1',
      HOME: '/bridge-home', CODEX_HOME: '/bridge-codex', CODEX_MANAGED_BY_BUN: '1',
    };
    const original = structuredClone({ base, bridgeEnv });
    expect(appServerEnv({ base, bridgeEnv, codexHome: '/runner/codex', userHome: '/runner/codex-user' })).toEqual({
      PATH: '/runner/bin', HOME: '/runner/codex-user', CODEX_HOME: '/runner/codex', EMPTY: '',
      AGFLOW_AGENT_TOKEN: 'new', HTTPS_PROXY: 'http://proxy', NODE_USE_SYSTEM_CA: '1', GIT_DIR: '/dev/null',
    });
    expect({ base, bridgeEnv }).toEqual(original);
  });

  test('hides the clone repository from Codex itself whatever the base and bridge say', () => {
    const env = appServerEnv({
      base: { GIT_DIR: '/clone/.git' }, bridgeEnv: { GIT_DIR: '/other/.git' },
      codexHome: '/runner/codex', userHome: '/runner/codex-user',
    });
    expect(env.GIT_DIR).toBe('/dev/null');
  });
});

describe('codexToolsNote', () => {
  test('names exactly the given bridge tools, which Code Mode does not describe, and how exec calls them', () => {
    expect(codexToolsNote(['get_brief', 'hello', 'submit'])).toBe(
      'Your agflow tools are mcp__agflow__get_brief, mcp__agflow__hello, mcp__agflow__submit. Code Mode does not describe them in exec: call them inside ' +
        'exec as tools.mcp__agflow__<name>, as in `await tools.mcp__agflow__<name>({ ...arguments })`.',
    );
    expect(codexToolsNote(['request_agents'])).toStartWith('Your agflow tools are mcp__agflow__request_agents. ');
  });
});

describe('threadOverrides', () => {
  test('uses the canonical clone and launch instructions for both start and resume', () => {
    const launch = launchFixture();
    const overrides = threadOverrides(launch, BRIDGE_CWD);
    const start: ParamsOf<'thread/start'> = overrides;
    const resume: Omit<ParamsOf<'thread/resume'>, 'threadId'> = overrides;
    expect(start).toBe(resume);
    expect(overrides.cwd).toBe(realpathSync(launch.clone));
    expect(overrides.cwd).not.toBe(launch.clone);
    expect(overrides.model).toBe(launch.model);
    expect(overrides.developerInstructions).toBe(`${launch.brief}\n\n${codexToolsNote(launch.bridge.tools)}`);
    expect(overrides.sandbox).toBe('workspace-write');
    expect(overrides.approvalPolicy).toBe('on-request');
    expect(overrides.approvalsReviewer).toBe('user');
  });

  test('sets explicit nested trust for verified and unverified projects', () => {
    const launch = launchFixture();
    const clone = realpathSync(launch.clone);
    for (const verified of [true, false]) {
      const { config } = threadOverrides({ ...launch, projectConfigVerified: verified }, BRIDGE_CWD);
      const trust = verified ? 'trusted' : 'untrusted';
      expect(config.projects[clone].trust_level).toBe(trust);
      expect(config.projects).toEqual({ [clone]: { trust_level: trust } });
      expect(Object.keys(config).some((key) => key.startsWith('projects.'))).toBe(false);
    }
  });

  test('confines sandbox writes and shell homes while preserving the supplied TMPDIR', () => {
    const launch = launchFixture();
    const clone = realpathSync(launch.clone);
    const { config } = threadOverrides(launch, BRIDGE_CWD);
    expect(config.sandbox_workspace_write).toEqual({
      writable_roots: [join(clone, '.git')], network_access: false,
      exclude_slash_tmp: true, exclude_tmpdir_env_var: true,
    });
    expect(config.shell_environment_policy).toEqual({
      inherit: 'all', exclude: ['AGFLOW_*', 'GIT_DIR'],
      set: { HOME: join(clone, '.agflow', 'run', 'home'), TMPDIR: launch.tmpDir },
    });
  });

  test('requires the bridge with its complete command and environment names only, started outside the clone', () => {
    const launch = launchFixture();
    const { config } = threadOverrides(launch, BRIDGE_CWD);
    expect(config.mcp_servers).toEqual({ agflow: {
      command: launch.bridge.command, args: launch.bridge.args, cwd: BRIDGE_CWD,
      env_vars: Object.keys(launch.bridge.env), default_tools_approval_mode: 'approve', required: true,
      tool_timeout_sec: 210,
    } });
    for (const value of Object.values(launch.bridge.env)) {
      expect(config.mcp_servers.agflow.env_vars).not.toContain(value);
    }
    expect(JSON.stringify(config)).not.toContain(launch.bridge.env.AGFLOW_AGENT_TOKEN);
  });

  for (const [value, seconds] of [
    ['180000', 210], ['1000', 31], ['1001', 32], [undefined, 210], ['0', 210], ['abc', 210],
    ['-1', 210], ['1.5', 210], ['Infinity', 210],
  ] as const) {
    test(`allows the bridge poll budget plus 30 seconds (${value})`, () => {
      const launch = launchFixture();
      if (value !== undefined) launch.bridge.env.AGFLOW_BRIDGE_POLL_MAX_MS = value;
      expect(threadOverrides(launch, BRIDGE_CWD).config.mcp_servers.agflow).toHaveProperty('tool_timeout_sec', seconds);
    });
  }

  test('enables only cached web search when the profile allows it', () => {
    const launch = launchFixture();
    expect(threadOverrides(launch, BRIDGE_CWD).config.web_search).toBe('disabled');
    const withWebTools = threadOverrides({ ...launch, profile: { ...launch.profile, webTools: true } }, BRIDGE_CWD);
    expect(withWebTools.config.web_search).toBe('cached');
  });
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `bun test packages/runner/test/codex/config.test.ts`
Expected: FAIL — `error: Cannot find module '../../src/adapters/codex/config' from 'packages/runner/test/codex/config.test.ts'` (0 pass, 1 fail, 1 error; observed in the 2026-11-11 parent replay).

- [ ] **Step 3: Implement**

**File:** `packages/runner/src/adapters/codex/config.ts` (new)

```ts
// Everything app-server receives, built without a process (design 9.1, 9.2, 7.6, 15.1): the flags, the process
// environment and the thread overrides that thread/start and thread/resume both get. Test mode's codexConfig reaches
// Codex as -c flags; no Codex home's config.toml is ever written.
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { RunnerTestBlock } from '../../config';
import type { AgentLaunch } from '../types';
import type { ParamsOf } from './methods';
import type { JsonValue } from './protocol/serde_json/JsonValue';

// Disable ambient extensions and shell startup: commands must not source the owner's shell profile.
const APP_SERVER_ARGS = [
  'app-server',
  '--disable', 'hooks',
  '--disable', 'apps',
  '--disable', 'plugins',
  '--disable', 'remote_plugin',
  '-c', 'features.shell_snapshot=false',
  '-c', 'allow_login_shell=false',
];

// CLI keys cannot be quoted: Codex splits them on dots before parsing the TOML value.
const BARE_KEY = /^[A-Za-z0-9_-]+$/;

function basicString(value: string): string {
  const escaped = value.replace(/["\\\x00-\x1f\x7f]/g, (character) => {
    if (character === '"') return '\\"';
    if (character === '\\') return '\\\\';
    return `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`;
  });
  return `"${escaped}"`;
}

/** A TOML value, never a string fallback: invalid values must fail before starting Codex. */
export function tomlInline(value: JsonValue): string {
  if (value === null) throw new Error('TOML cannot represent null');
  switch (typeof value) {
    case 'string':
      return basicString(value);
    case 'boolean':
      return String(value);
    case 'number':
      if (!Number.isFinite(value)) throw new Error('TOML configuration requires finite numbers');
      return String(value);
    case 'object':
      if (Array.isArray(value)) return `[${value.map(tomlInline).join(', ')}]`;
      return `{ ${Object.entries(value)
        .filter(([, member]) => member !== undefined)
        .map(([key, member]) => `${BARE_KEY.test(key) ? key : basicString(key)} = ${tomlInline(member!)}`)
        .join(', ')} }`;
  }
}

/**
 * The arguments after the binary. testConfig is runner.json's test.codexConfig, which the caller passes only in test
 * mode (isTestMode); each top-level key becomes one -c flag.
 */
export function appServerArgs(testConfig?: RunnerTestBlock['codexConfig'] | null): string[] {
  const args = [...APP_SERVER_ARGS];
  for (const [key, value] of Object.entries(testConfig ?? {})) {
    if (!BARE_KEY.test(key)) throw new Error(`Codex configuration key must be a TOML bare key: ${JSON.stringify(key)}`);
    args.push('-c', `${key}=${tomlInline(value)}`);
  }
  return args;
}

export function appServerEnv(input: {
  base: Record<string, string | undefined>;
  bridgeEnv: Record<string, string>;
  codexHome: string;
  userHome: string;
}): Record<string, string> {
  return Object.fromEntries(
    Object.entries({
      ...input.base,
      ...input.bridgeEnv,
      CODEX_HOME: input.codexHome,
      HOME: input.userHome,
      // Codex's own git calls (thread start, per-turn metadata) run outside the sandbox, and the agent can write the
      // clone's .git/config: a planted filter driver would run unsandboxed. They must not find the repository.
      GIT_DIR: '/dev/null',
    })
      // X-10: managed-install markers only feed diagnostics; none belongs in the runner's process.
      .filter((entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith('CODEX_MANAGED_')),
  );
}

/** What thread/start and thread/resume both receive (design 9.2). */
export type CodexThreadOverrides = {
  cwd: string;
  model: string;
  sandbox: 'workspace-write';
  approvalPolicy: 'on-request';
  approvalsReviewer: 'user';
  developerInstructions: string;
  config: {
    projects: Record<string, { trust_level: 'trusted' | 'untrusted' }>;
    sandbox_workspace_write: {
      writable_roots: string[];
      network_access: boolean;
      exclude_slash_tmp: boolean;
      exclude_tmpdir_env_var: boolean;
    };
    shell_environment_policy: {
      inherit: 'all';
      exclude: string[];
      set: { HOME: string; TMPDIR: string };
    };
    mcp_servers: {
      agflow: {
        command: string;
        args: string[];
        cwd: string;
        env_vars: string[];
        default_tools_approval_mode: 'approve';
        required: boolean;
        tool_timeout_sec: number;
      };
    };
    web_search: 'cached' | 'disabled';
  };
};

/**
 * Code Mode defers MCP tools: exec's description does not list them, so a model meets them only in ALL_TOOLS. The
 * developer instructions name the role's bridge tools and how exec calls them, so the note survives compaction.
 */
export function codexToolsNote(names: readonly string[]): string {
  return (
    `Your agflow tools are ${names.map((name) => `mcp__agflow__${name}`).join(', ')}. Code Mode does not describe them in exec: call them inside exec as ` +
    'tools.mcp__agflow__<name>, as in `await tools.mcp__agflow__<name>({ ...arguments })`.'
  );
}

/**
 * bridgeCwd is the bridge's working directory: the codex-user home, which app-server itself runs in. Codex would
 * otherwise start the bridge in the thread's cwd, the clone, and Bun loads a bunfig.toml (its preload) and a .env from
 * there: repository or agent content would run in the bridge, outside the sandbox, with the agent token.
 */
export function threadOverrides(
  launch: Pick<AgentLaunch, 'clone' | 'model' | 'brief' | 'projectConfigVerified' | 'tmpDir' | 'bridge' | 'profile'>,
  bridgeCwd: string,
): CodexThreadOverrides {
  const clone = realpathSync(launch.clone);
  // Match the bridge's positiveMs rule without importing the CLI package.
  const pollMax = Number(launch.bridge.env.AGFLOW_BRIDGE_POLL_MAX_MS);
  const pollMaxMs = Number.isInteger(pollMax) && pollMax > 0 ? pollMax : 180_000;
  return {
    cwd: clone,
    model: launch.model,
    // Approvals always reach the person; commands start inside the workspace sandbox.
    sandbox: 'workspace-write',
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    developerInstructions: `${launch.brief}\n\n${codexToolsNote(launch.bridge.tools)}`,
    config: {
      // An explicit nested entry avoids implicit trust and loading unverified project configuration.
      projects: { [clone]: { trust_level: launch.projectConfigVerified ? 'trusted' : 'untrusted' } },
      sandbox_workspace_write: {
        // Codex protects .git by default; the agent must be able to commit inside its own clone.
        writable_roots: [join(clone, '.git')],
        network_access: false,
        exclude_slash_tmp: true,
        exclude_tmpdir_env_var: true,
      },
      shell_environment_policy: {
        // The base is already allowlisted. Bridge credentials stay out of tool commands, and the agent's git finds
        // the clone's repository again.
        inherit: 'all',
        exclude: ['AGFLOW_*', 'GIT_DIR'],
        set: { HOME: join(clone, '.agflow', 'run', 'home'), TMPDIR: launch.tmpDir },
      },
      mcp_servers: {
        agflow: {
          command: launch.bridge.command,
          args: [...launch.bridge.args],
          cwd: bridgeCwd,
          env_vars: Object.keys(launch.bridge.env),
          // The bridge must start successfully, and its tools do not require separate Codex approval.
          default_tools_approval_mode: 'approve',
          required: true,
          // Held submit/prepare calls include a final GET; allow 30 seconds beyond the polling budget.
          tool_timeout_sec: Math.ceil(pollMaxMs / 1000) + 30,
        },
      },
      // Opt-in search stays cached; it does not enable network access for shell commands.
      web_search: launch.profile.webTools ? 'cached' : 'disabled',
    },
  } satisfies CodexThreadOverrides & ParamsOf<'thread/start'> & Omit<ParamsOf<'thread/resume'>, 'threadId'>;
}
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `bun test packages/runner/test/codex/config.test.ts && bun test && bun run typecheck`
Expected: the task's tests pass (24 pass); then the whole suite passes (`0 fail`) and `tsc` exits 0.

`GIT_DIR=/dev/null`: Codex's own git calls (at thread start and for each turn's metadata) run outside the sandbox and would run a filter driver the agent planted in the clone's `.git/config`; `shell_environment_policy` excludes `GIT_DIR` again, so the agent's own git finds its repository (Task 24 checks both on the real binary). `bridgeCwd` is required: Codex would otherwise start the bridge in the clone, where Bun loads a `bunfig.toml` preload and a `.env`, outside the sandbox and with the agent token (Task 21 checks it). `developerInstructions` is `launch.brief` plus two newlines and `codexToolsNote(launch.bridge.tools)`. The tool names come from M2b's required per-launch `bridge.tools` list, without a CLI import. `mcp_servers.agflow.tool_timeout_sec` is `ceil(pollMaxMs / 1000) + 30`; pollMaxMs is the positive integer parsed from `launch.bridge.env.AGFLOW_BRIDGE_POLL_MAX_MS`, or 180000 ms. Tests cover the default, shorter and fractional-second budgets, and invalid environment values. The exact MCP configuration includes 210 seconds by default. A test-config key that is not a TOML bare key throws, because Codex's `-c` splits keys on dots.

- [ ] **Step 5: Commit**

```bash
git add -A 'packages/runner/src/adapters/codex/config.ts' 'packages/runner/test/codex/config.test.ts'
git commit -m 'M2E Task 7: App-server launch configuration' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

### Task 8: Error and quota classification

Pure mapping of Codex turn errors and rate-limit snapshots to `AgentEvent` error kinds and `VendorQuota` (design 9.2 Errors and Quota, 6.10, 6.1). `turnErrorKind` follows the section 9.2 table, with a provider 401 as `auth` (X-31) on both `httpConnectionFailed` and `responseStreamConnectionFailed`, through a table checked with `satisfies` against the generated `CodexErrorInfo`, so a re-pin that adds a variant fails the typecheck. `mergeRateLimits` folds Codex's sparse `account/rateLimits/updated` snapshots together, and `quotaFromRateLimits` maps windows by their length, turns epoch seconds into milliseconds, and reports paid usage when a window is full while credits remain (X-14). `recorded-notifications.json` holds payloads recorded from 0.159.2 against the scripted provider.

**Files:**
- Create: `packages/runner/src/adapters/codex/classify.ts`
- Test: `packages/runner/test/codex/classify.test.ts`
- Test: `packages/runner/test/codex/fixtures/recorded-notifications.json`

- [ ] **Step 1: Write the failing tests**

**File:** `packages/runner/test/codex/classify.test.ts` (new)

```ts
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { VendorQuotaSchema, type VendorQuota } from '@agflow/core';
import {
  type CodexErrorKind, isFinalError, mergeRateLimits, quotaFromRateLimits, turnErrorKind,
} from '../../src/adapters/codex/classify';
import type { ParamsOf } from '../../src/adapters/codex/methods';
import type { CodexErrorInfo, RateLimitSnapshot, RateLimitWindow } from '../../src/adapters/codex/protocol/v2';

const now = 1_794_226_000_000;
const reset = 1_794_228_000;

function snapshot(overrides: Partial<RateLimitSnapshot> = {}): RateLimitSnapshot {
  return {
    limitId: 'codex', limitName: null, normalModelSlug: null, primary: null, secondary: null,
    credits: null, individualLimit: null, spendControlReached: null, planType: null,
    rateLimitReachedType: null, ...overrides,
  };
}

function window(
  usedPercent: number,
  windowDurationMins: number | null = 300,
  resetsAt: number | null = reset,
): RateLimitWindow {
  return { usedPercent, windowDurationMins, resetsAt };
}

function quota(input: RateLimitSnapshot, at: number | undefined = now): VendorQuota {
  const result = quotaFromRateLimits(input, at);
  expect(VendorQuotaSchema.parse(result)).toEqual(result);
  return result;
}

function error(codexErrorInfo: CodexErrorInfo | null, willRetry = false): ParamsOf<'error'> {
  return {
    threadId: 'thread', turnId: 'turn', willRetry,
    error: { message: 'failed', codexErrorInfo, additionalDetails: null, misalignment: null },
  };
}

describe('turnErrorKind', () => {
  test('maps the generated string variants to runner outcomes', () => {
    const cases: [CodexErrorInfo, CodexErrorKind][] = [
      ['usageLimitExceeded', 'quota'], ['unauthorized', 'auth'], ['contextWindowExceeded', 'context'],
      ['cyberPolicy', 'policy'], ['misalignmentPolicyViolation', 'policy'], ['tooManyDenials', 'denials'],
      ['sessionBudgetExceeded', 'session_budget'], ['rateLimitExceeded', 'vendor'], ['serverOverloaded', 'vendor'],
      ['internalServerError', 'vendor'], ['sandboxError', 'vendor'], ['badRequest', 'vendor'], ['other', 'vendor'],
      ['flexUnavailable', 'vendor'], ['threadRollbackFailed', 'vendor'],
    ];
    for (const [info, expected] of cases) expect(turnErrorKind(info)).toBe(expected);
  });

  test('recognizes provider 401s only on the connection error variants', () => {
    for (const httpStatusCode of [401, 403, 429, 500, null]) {
      const connection = [
        { httpConnectionFailed: { httpStatusCode } },
        { responseStreamConnectionFailed: { httpStatusCode } },
      ];
      for (const info of connection) {
        expect(turnErrorKind(info)).toBe(httpStatusCode === 401 ? 'auth' : 'vendor');
      }
      expect(turnErrorKind({ responseStreamDisconnected: { httpStatusCode } })).toBe('vendor');
      expect(turnErrorKind({ responseTooManyFailedAttempts: { httpStatusCode } })).toBe('vendor');
    }
  });

  test('unknown runtime strings, objects and null remain vendor errors', () => {
    for (const info of ['futureError', 'toString', '__proto__', { futureError: {} }, null]) {
      expect(turnErrorKind(info as CodexErrorInfo | null, null)).toBe('vendor');
    }
  });

  test('a reached type turns only generic vendor failures into quota, and never a steer rejection', () => {
    const reached = snapshot({ rateLimitReachedType: 'workspace_owner_credits_depleted' });
    const generic = ['other', 'internalServerError', null, 'futureError', { futureError: {} }];
    for (const info of generic) {
      expect(turnErrorKind(info as CodexErrorInfo | null, reached)).toBe('quota');
    }
    const specific: [CodexErrorInfo, CodexErrorKind][] = [
      ['unauthorized', 'auth'], [{ httpConnectionFailed: { httpStatusCode: 401 } }, 'auth'],
      ['contextWindowExceeded', 'context'], ['cyberPolicy', 'policy'], ['misalignmentPolicyViolation', 'policy'],
      ['tooManyDenials', 'denials'], ['sessionBudgetExceeded', 'session_budget'], ['usageLimitExceeded', 'quota'],
    ];
    for (const [info, expected] of specific) expect(turnErrorKind(info, reached)).toBe(expected);
    for (const turnKind of ['review', 'compact'] as const) {
      const info = { activeTurnNotSteerable: { turnKind } };
      expect(turnErrorKind(info)).toBeNull();
      expect(turnErrorKind(info, reached)).toBeNull();
    }
  });
});

describe('isFinalError', () => {
  test('ignores retries and steer rejections, accepting every other final error', () => {
    const infos = ['usageLimitExceeded', 'other', null, { httpConnectionFailed: { httpStatusCode: 401 } }] as const;
    for (const info of infos) {
      expect(isFinalError(error(info, true))).toBe(false);
      expect(isFinalError(error(info))).toBe(true);
    }
    for (const turnKind of ['review', 'compact'] as const) {
      expect(isFinalError(error({ activeTurnNotSteerable: { turnKind } }))).toBe(false);
    }
  });
});

describe('mergeRateLimits', () => {
  test('returns the initial snapshot unchanged', () => {
    const update = snapshot();
    expect(mergeRateLimits(null, update)).toBe(update);
  });

  test('retains only absent windows and credits, and clears the reached type', () => {
    const previous = snapshot({
      primary: window(100), secondary: window(7, 10080),
      credits: { hasCredits: true, unlimited: false, balance: '12.5' },
      limitName: 'Codex', normalModelSlug: 'model', planType: 'pro', spendControlReached: true,
      rateLimitReachedType: 'rate_limit_reached',
    });
    const update = snapshot();
    const original = structuredClone({ previous, update });
    expect(mergeRateLimits(previous, update)).toEqual({
      ...update, primary: previous.primary, secondary: previous.secondary, credits: previous.credits,
    });
    const recovery = mergeRateLimits(previous, snapshot({ primary: window(20) }));
    expect(quota(recovery).state).toBe('ok');
    expect(turnErrorKind('other', recovery)).toBe('vendor');
    expect({ previous, update }).toEqual(original);
  });

  test('ignores updates for other metered buckets', () => {
    const codex = snapshot({
      primary: window(100), secondary: window(40, 10080), credits: { hasCredits: false, unlimited: false, balance: null },
    });
    const other = snapshot({
      limitId: 'codex_other', primary: window(3), secondary: window(4, 10080),
      credits: { hasCredits: true, unlimited: false, balance: '5' }, rateLimitReachedType: 'rate_limit_reached',
    });
    expect(mergeRateLimits(codex, other)).toBe(codex);
    expect(mergeRateLimits(null, other)).toBeNull();
    expect(quota(mergeRateLimits(codex, other))).toEqual(quota(codex));
    expect(quota(codex)).toMatchObject({ state: 'exhausted', windows: { fiveHour: 1, weekly: 0.4 } });
    expect(turnErrorKind('other', mergeRateLimits(codex, other))).toBe('vendor');
    const unnamed = snapshot({ limitId: null, primary: window(20) });
    expect(mergeRateLimits(codex, unnamed)).toEqual({ ...unnamed, secondary: codex.secondary, credits: codex.credits });
  });

  test('replaces present windows and credits, including zero usage and disabled credits', () => {
    const previous = snapshot({
      primary: window(90), secondary: window(80, 10080),
      credits: { hasCredits: true, unlimited: true, balance: '12.5' },
    });
    const update = snapshot({
      primary: window(0), secondary: window(0, 10080),
      credits: { hasCredits: false, unlimited: false, balance: '0' },
      rateLimitReachedType: 'workspace_member_usage_limit_reached',
    });
    expect(mergeRateLimits(previous, update)).toEqual(update);
  });
});

describe('quotaFromRateLimits', () => {
  test('maps durations before positional fallbacks and clamps utilization', () => {
    const cases: [RateLimitWindow | null, RateLimitWindow | null, VendorQuota['windows']][] = [
      [window(42), window(7, 10080), { fiveHour: 0.42, weekly: 0.07 }],
      [window(42, 10080), window(7), { fiveHour: 0.07, weekly: 0.42 }],
      [window(-5, null), window(150, 60), { fiveHour: 0, weekly: 1 }],
      [window(10, 60), window(20), { fiveHour: 0.2, weekly: null }],
      [window(10, 10080), window(20, null), { fiveHour: null, weekly: 0.1 }],
      [null, window(25, null), { fiveHour: null, weekly: 0.25 }],
      [window(12.5, null), null, { fiveHour: 0.125, weekly: null }],
    ];
    for (const [primary, secondary, expected] of cases) {
      expect(quota(snapshot({ primary, secondary })).windows).toEqual(expected);
    }
  });

  test('uses the limiting window reset, converting seconds to milliseconds', () => {
    const cases: [RateLimitWindow | null, RateLimitWindow | null, number | null][] = [
      [window(80), window(90, 10080, reset + 10), (reset + 10) * 1000],
      [window(90), window(80, 10080, reset + 10), reset * 1000],
      [window(100), window(40, 10080, reset + 10), reset * 1000],
      [window(100), window(100, 10080, reset + 10), (reset + 10) * 1000],
      [window(100, 300, reset + 10), window(100, 10080), (reset + 10) * 1000],
      [window(110), window(100, 10080, reset + 10), (reset + 10) * 1000],
      [window(100, 300, null), window(20, 10080), null],
      [window(20), window(90, 10080, null), null],
      [window(100), window(100, 10080, null), null],
      [window(100, 300, null), window(100, 10080), null],
      [null, window(10, 10080, reset + 10), (reset + 10) * 1000],
      [null, null, null],
      // A window whose reset has passed is empty: it neither limits nor supplies the reset.
      [window(100, 300, 1), window(40, 10080), reset * 1000],
      [window(100, 300, now / 1000), window(100, 10080, reset + 10), (reset + 10) * 1000],
      [window(90, 300, 1), window(40, 10080), reset * 1000],
      [window(100, 300, 1), window(100, 10080, 0), null],
    ];
    for (const [primary, secondary, expected] of cases) {
      expect(quota(snapshot({ primary, secondary })).resetsAt).toBe(expected);
    }
  });

  test('reports paid usage facts independently of the runner policy', () => {
    const cases: [RateLimitSnapshot['credits'], VendorQuota['paidUsage'], VendorQuota['paidUsage']][] = [
      [null, 'unknown', 'unknown'],
      [{ hasCredits: false, unlimited: false, balance: '12.5' }, 'disabled', 'disabled'],
      [{ hasCredits: true, unlimited: false, balance: null }, 'enabled', 'in_use'],
      [{ hasCredits: false, unlimited: true, balance: null }, 'enabled', 'in_use'],
    ];
    for (const [credits, idle, full] of cases) {
      expect(quota(snapshot({ credits }))).toMatchObject({ state: 'unknown', paidUsage: idle });
      expect(quota(snapshot({ credits, primary: window(99) }))).toMatchObject({ state: 'ok', paidUsage: idle });
      for (const windows of [{ primary: window(100) }, { secondary: window(100, 10080) }]) {
        expect(quota(snapshot({ credits, ...windows }))).toMatchObject({
          state: full === 'in_use' ? 'ok' : 'exhausted', paidUsage: full,
        });
      }
      expect(quota(snapshot({ credits, primary: window(100), rateLimitReachedType: 'rate_limit_reached' })))
        .toMatchObject({ state: 'exhausted', paidUsage: full });
    }
    expect(quota(snapshot({ rateLimitReachedType: 'workspace_member_credits_depleted' })))
      .toMatchObject({ state: 'exhausted', resetsAt: null });
  });

  test('treats a full window whose reset has passed as empty', () => {
    const past = window(100, 300, now / 1000 - 60);
    for (const credits of [null, { hasCredits: true, unlimited: false, balance: null }]) {
      expect(quota(snapshot({ credits, primary: past, secondary: window(30, 10080) }))).toMatchObject({
        state: 'ok', resetsAt: reset * 1000, windows: { fiveHour: 0, weekly: 0.3 },
        paidUsage: credits === null ? 'unknown' : 'enabled',
      });
    }
    expect(quota(snapshot({ primary: window(100, 300, now / 1000 + 1) })).state).toBe('exhausted');
  });

  test('uses the supplied timestamp or the current time without mutating the snapshot', () => {
    const input = snapshot({ primary: window(42) });
    const original = structuredClone(input);
    expect(quota(input).updatedAt).toBe(now);
    const before = Date.now();
    const current = quotaFromRateLimits(input);
    expect(VendorQuotaSchema.parse(current)).toEqual(current);
    expect(current.updatedAt).toBeGreaterThanOrEqual(before);
    expect(current.updatedAt).toBeLessThanOrEqual(Date.now());
    expect(input).toEqual(original);
  });
});

describe('recorded Codex 0.159.2 notifications', () => {
  type Method = 'turn/started' | 'account/rateLimits/updated' | 'error' | 'turn/completed';
  type Notification = { [M in Method]: { method: M; params: ParamsOf<M>; emittedAtMs: number } }[Method];
  const recorded: Record<string, Notification[]> = JSON.parse(
    readFileSync(new URL('./fixtures/recorded-notifications.json', import.meta.url), 'utf8'),
  );
  const expectedErrors: Record<string, CodexErrorKind | null> = {
    usageLimit: 'quota', http500: 'vendor', http401: 'auth', responseFailed: 'vendor',
    contextFailed: 'context', headerUpdates: null,
  };

  for (const [scenario, expectedError] of Object.entries(expectedErrors)) {
    test(scenario, () => {
      let merged: RateLimitSnapshot | null = null;
      const quotas: VendorQuota[] = [];
      const errors: (CodexErrorKind | null)[] = [];
      const completedErrors: (CodexErrorKind | null)[] = [];
      for (const notification of recorded[scenario]) {
        switch (notification.method) {
          case 'account/rateLimits/updated':
            expect(notification.params.rateLimits.limitId).toBe('codex');
            merged = mergeRateLimits(merged, notification.params.rateLimits);
            quotas.push(quota(merged!));
            break;
          case 'error':
            expect(isFinalError(notification.params)).toBe(true);
            if (isFinalError(notification.params)) {
              errors.push(turnErrorKind(notification.params.error.codexErrorInfo, merged));
            }
            break;
          case 'turn/completed':
            if (notification.params.turn.status === 'failed') {
              expect(notification.params.turn.error).not.toBeNull();
              completedErrors.push(turnErrorKind(notification.params.turn.error!.codexErrorInfo, merged));
            } else {
              expect(notification.params.turn.status).toBe('completed');
              expect(notification.params.turn.error).toBeNull();
            }
            break;
        }
      }
      expect(errors).toEqual(expectedError === null ? [] : [expectedError]);
      expect(completedErrors).toEqual(errors);
      if (scenario === 'usageLimit') {
        expect(quotas).toEqual([{
          state: 'exhausted', resetsAt: merged!.primary!.resetsAt! * 1000,
          windows: { fiveHour: 1, weekly: 0.4 }, paidUsage: 'unknown', updatedAt: now,
        }]);
      } else if (scenario === 'headerUpdates') {
        expect(quotas).toEqual([
          {
            state: 'ok', resetsAt: 1_794_229_640_000, windows: { fiveHour: 0.42, weekly: 0.07 },
            paidUsage: 'enabled', updatedAt: now,
          },
          {
            state: 'ok', resetsAt: 1_794_229_040_000, windows: { fiveHour: 1, weekly: 0.07 },
            paidUsage: 'in_use', updatedAt: now,
          },
        ]);
      } else {
        const count = scenario === 'contextFailed' ? 2 : scenario === 'responseFailed' ? 1 : 0;
        expect(quotas).toEqual(Array.from({ length: count }, () => ({
          state: 'unknown', resetsAt: null, windows: { fiveHour: null, weekly: null },
          paidUsage: 'unknown', updatedAt: now,
        })));
      }
    });
  }
});
```

**File:** `packages/runner/test/codex/fixtures/recorded-notifications.json` (new)

```json
{
  "usageLimit": [
    {
      "method": "turn/started",
      "params": {
        "threadId": "01a1c034-afaa-7541-abf2-e2bb147b02e9",
        "turn": {
          "id": "01a1c034-afde-7cf0-ab34-8854fb8327c0",
          "items": [],
          "itemsView": "notLoaded",
          "status": "inProgress",
          "error": null,
          "startedAt": 1794226040,
          "completedAt": null,
          "durationMs": null
        }
      },
      "emittedAtMs": 1794226040815
    },
    {
      "method": "account/rateLimits/updated",
      "params": {
        "rateLimits": {
          "limitId": "codex",
          "limitName": null,
          "normalModelSlug": null,
          "primary": {
            "usedPercent": 100,
            "windowDurationMins": 300,
            "resetsAt": 1794227840
          },
          "secondary": {
            "usedPercent": 40,
            "windowDurationMins": 10080,
            "resetsAt": 1794830840
          },
          "credits": null,
          "individualLimit": null,
          "spendControlReached": null,
          "planType": null,
          "rateLimitReachedType": null
        }
      },
      "emittedAtMs": 1794226040849
    },
    {
      "method": "error",
      "params": {
        "error": {
          "message": "You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 3:37 PM.",
          "codexErrorInfo": "usageLimitExceeded",
          "additionalDetails": null,
          "misalignment": null
        },
        "willRetry": false,
        "threadId": "01a1c034-afaa-7541-abf2-e2bb147b02e9",
        "turnId": "01a1c034-afde-7cf0-ab34-8854fb8327c0"
      },
      "emittedAtMs": 1794226040849
    },
    {
      "method": "turn/completed",
      "params": {
        "threadId": "01a1c034-afaa-7541-abf2-e2bb147b02e9",
        "turn": {
          "id": "01a1c034-afde-7cf0-ab34-8854fb8327c0",
          "items": [],
          "itemsView": "notLoaded",
          "status": "failed",
          "error": {
            "message": "You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 3:37 PM.",
            "codexErrorInfo": "usageLimitExceeded",
            "additionalDetails": null,
            "misalignment": null
          },
          "startedAt": 1794226040,
          "completedAt": 1794226040,
          "durationMs": 47
        }
      },
      "emittedAtMs": 1794226040851
    }
  ],
  "http500": [
    {
      "method": "turn/started",
      "params": {
        "threadId": "01a1c034-b072-7792-b9bf-778d01e3c997",
        "turn": {
          "id": "01a1c034-b07c-79a3-912d-d11d1134bb9c",
          "items": [],
          "itemsView": "notLoaded",
          "status": "inProgress",
          "error": null,
          "startedAt": 1794226040,
          "completedAt": null,
          "durationMs": null
        }
      },
      "emittedAtMs": 1794226040979
    },
    {
      "method": "error",
      "params": {
        "error": {
          "message": "We’re currently experiencing high demand, which may cause temporary errors.",
          "codexErrorInfo": "internalServerError",
          "additionalDetails": null,
          "misalignment": null
        },
        "willRetry": false,
        "threadId": "01a1c034-b072-7792-b9bf-778d01e3c997",
        "turnId": "01a1c034-b07c-79a3-912d-d11d1134bb9c"
      },
      "emittedAtMs": 1794226040999
    },
    {
      "method": "turn/completed",
      "params": {
        "threadId": "01a1c034-b072-7792-b9bf-778d01e3c997",
        "turn": {
          "id": "01a1c034-b07c-79a3-912d-d11d1134bb9c",
          "items": [],
          "itemsView": "notLoaded",
          "status": "failed",
          "error": {
            "message": "We’re currently experiencing high demand, which may cause temporary errors.",
            "codexErrorInfo": "internalServerError",
            "additionalDetails": null,
            "misalignment": null
          },
          "startedAt": 1794226040,
          "completedAt": 1794226040,
          "durationMs": 41
        }
      },
      "emittedAtMs": 1794226041000
    }
  ],
  "http401": [
    {
      "method": "turn/started",
      "params": {
        "threadId": "01a1c034-b0fe-72e3-8d52-78f62615d4bb",
        "turn": {
          "id": "01a1c034-b108-7991-9386-15dafb6f843e",
          "items": [],
          "itemsView": "notLoaded",
          "status": "inProgress",
          "error": null,
          "startedAt": 1794226041,
          "completedAt": null,
          "durationMs": null
        }
      },
      "emittedAtMs": 1794226041105
    },
    {
      "method": "error",
      "params": {
        "error": {
          "message": "unexpected status 401 Unauthorized: bad key, url: http://127.0.0.1:60882/v1/responses",
          "codexErrorInfo": {
            "httpConnectionFailed": {
              "httpStatusCode": 401
            }
          },
          "additionalDetails": null,
          "misalignment": null
        },
        "willRetry": false,
        "threadId": "01a1c034-b0fe-72e3-8d52-78f62615d4bb",
        "turnId": "01a1c034-b108-7991-9386-15dafb6f843e"
      },
      "emittedAtMs": 1794226041121
    },
    {
      "method": "turn/completed",
      "params": {
        "threadId": "01a1c034-b0fe-72e3-8d52-78f62615d4bb",
        "turn": {
          "id": "01a1c034-b108-7991-9386-15dafb6f843e",
          "items": [],
          "itemsView": "notLoaded",
          "status": "failed",
          "error": {
            "message": "unexpected status 401 Unauthorized: bad key, url: http://127.0.0.1:60882/v1/responses",
            "codexErrorInfo": {
              "httpConnectionFailed": {
                "httpStatusCode": 401
              }
            },
            "additionalDetails": null,
            "misalignment": null
          },
          "startedAt": 1794226041,
          "completedAt": 1794226041,
          "durationMs": 23
        }
      },
      "emittedAtMs": 1794226041122
    }
  ],
  "responseFailed": [
    {
      "method": "turn/started",
      "params": {
        "threadId": "01a1c034-b16b-7c93-8e1b-37128e3dfa03",
        "turn": {
          "id": "01a1c034-b174-7651-b223-cf1ec72d08ed",
          "items": [],
          "itemsView": "notLoaded",
          "status": "inProgress",
          "error": null,
          "startedAt": 1794226041,
          "completedAt": null,
          "durationMs": null
        }
      },
      "emittedAtMs": 1794226041212
    },
    {
      "method": "account/rateLimits/updated",
      "params": {
        "rateLimits": {
          "limitId": "codex",
          "limitName": null,
          "normalModelSlug": null,
          "primary": null,
          "secondary": null,
          "credits": null,
          "individualLimit": null,
          "spendControlReached": null,
          "planType": null,
          "rateLimitReachedType": null
        }
      },
      "emittedAtMs": 1794226041229
    },
    {
      "method": "error",
      "params": {
        "error": {
          "message": "stream disconnected before completion: The server had an error while processing your request.",
          "codexErrorInfo": "other",
          "additionalDetails": null,
          "misalignment": null
        },
        "willRetry": false,
        "threadId": "01a1c034-b16b-7c93-8e1b-37128e3dfa03",
        "turnId": "01a1c034-b174-7651-b223-cf1ec72d08ed"
      },
      "emittedAtMs": 1794226041229
    },
    {
      "method": "turn/completed",
      "params": {
        "threadId": "01a1c034-b16b-7c93-8e1b-37128e3dfa03",
        "turn": {
          "id": "01a1c034-b174-7651-b223-cf1ec72d08ed",
          "items": [],
          "itemsView": "notLoaded",
          "status": "failed",
          "error": {
            "message": "stream disconnected before completion: The server had an error while processing your request.",
            "codexErrorInfo": "other",
            "additionalDetails": null,
            "misalignment": null
          },
          "startedAt": 1794226041,
          "completedAt": 1794226041,
          "durationMs": 24
        }
      },
      "emittedAtMs": 1794226041230
    }
  ],
  "contextFailed": [
    {
      "method": "turn/started",
      "params": {
        "threadId": "01a1c034-b1e9-7eb3-bc83-3fe4cd56cff6",
        "turn": {
          "id": "01a1c034-b1f2-76a0-ab1d-ef3e50898dc9",
          "items": [],
          "itemsView": "notLoaded",
          "status": "inProgress",
          "error": null,
          "startedAt": 1794226041,
          "completedAt": null,
          "durationMs": null
        }
      },
      "emittedAtMs": 1794226041339
    },
    {
      "method": "account/rateLimits/updated",
      "params": {
        "rateLimits": {
          "limitId": "codex",
          "limitName": null,
          "normalModelSlug": null,
          "primary": null,
          "secondary": null,
          "credits": null,
          "individualLimit": null,
          "spendControlReached": null,
          "planType": null,
          "rateLimitReachedType": null
        }
      },
      "emittedAtMs": 1794226041356
    },
    {
      "method": "account/rateLimits/updated",
      "params": {
        "rateLimits": {
          "limitId": "codex",
          "limitName": null,
          "normalModelSlug": null,
          "primary": null,
          "secondary": null,
          "credits": null,
          "individualLimit": null,
          "spendControlReached": null,
          "planType": null,
          "rateLimitReachedType": null
        }
      },
      "emittedAtMs": 1794226041357
    },
    {
      "method": "error",
      "params": {
        "error": {
          "message": "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.",
          "codexErrorInfo": "contextWindowExceeded",
          "additionalDetails": null,
          "misalignment": null
        },
        "willRetry": false,
        "threadId": "01a1c034-b1e9-7eb3-bc83-3fe4cd56cff6",
        "turnId": "01a1c034-b1f2-76a0-ab1d-ef3e50898dc9"
      },
      "emittedAtMs": 1794226041357
    },
    {
      "method": "turn/completed",
      "params": {
        "threadId": "01a1c034-b1e9-7eb3-bc83-3fe4cd56cff6",
        "turn": {
          "id": "01a1c034-b1f2-76a0-ab1d-ef3e50898dc9",
          "items": [],
          "itemsView": "notLoaded",
          "status": "failed",
          "error": {
            "message": "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.",
            "codexErrorInfo": "contextWindowExceeded",
            "additionalDetails": null,
            "misalignment": null
          },
          "startedAt": 1794226041,
          "completedAt": 1794226041,
          "durationMs": 26
        }
      },
      "emittedAtMs": 1794226041359
    }
  ],
  "headerUpdates": [
    {
      "method": "turn/started",
      "params": {
        "threadId": "01a1c034-b264-7832-84e7-5595c1b7f455",
        "turn": {
          "id": "01a1c034-b270-7000-a1ad-abc73c092469",
          "items": [],
          "itemsView": "notLoaded",
          "status": "inProgress",
          "error": null,
          "startedAt": 1794226041,
          "completedAt": null,
          "durationMs": null
        }
      },
      "emittedAtMs": 1794226041468
    },
    {
      "method": "account/rateLimits/updated",
      "params": {
        "rateLimits": {
          "limitId": "codex",
          "limitName": null,
          "normalModelSlug": null,
          "primary": {
            "usedPercent": 42,
            "windowDurationMins": 300,
            "resetsAt": 1794229640
          },
          "secondary": {
            "usedPercent": 7,
            "windowDurationMins": 10080,
            "resetsAt": 1794726040
          },
          "credits": {
            "hasCredits": true,
            "unlimited": false,
            "balance": "12.5"
          },
          "individualLimit": null,
          "spendControlReached": null,
          "planType": null,
          "rateLimitReachedType": null
        }
      },
      "emittedAtMs": 1794226041495
    },
    {
      "method": "turn/completed",
      "params": {
        "threadId": "01a1c034-b264-7832-84e7-5595c1b7f455",
        "turn": {
          "id": "01a1c034-b270-7000-a1ad-abc73c092469",
          "items": [
            {
              "type": "agentMessage",
              "id": "msg_8d5b392a5200414f82b3021b2d4cf219",
              "text": "first",
              "phase": null,
              "memoryCitation": null,
              "delivery": null,
              "questions": null
            }
          ],
          "itemsView": "summary",
          "status": "completed",
          "error": null,
          "startedAt": 1794226041,
          "completedAt": 1794226041,
          "durationMs": 38
        }
      },
      "emittedAtMs": 1794226041498
    },
    {
      "method": "turn/started",
      "params": {
        "threadId": "01a1c034-b264-7832-84e7-5595c1b7f455",
        "turn": {
          "id": "01a1c034-b29b-7841-ab7d-08b8abbd3f05",
          "items": [],
          "itemsView": "notLoaded",
          "status": "inProgress",
          "error": null,
          "startedAt": 1794226041,
          "completedAt": null,
          "durationMs": null
        }
      },
      "emittedAtMs": 1794226041502
    },
    {
      "method": "account/rateLimits/updated",
      "params": {
        "rateLimits": {
          "limitId": "codex",
          "limitName": null,
          "normalModelSlug": null,
          "primary": {
            "usedPercent": 100,
            "windowDurationMins": 300,
            "resetsAt": 1794229040
          },
          "secondary": null,
          "credits": {
            "hasCredits": true,
            "unlimited": false,
            "balance": "12.5"
          },
          "individualLimit": null,
          "spendControlReached": null,
          "planType": null,
          "rateLimitReachedType": null
        }
      },
      "emittedAtMs": 1794226041521
    },
    {
      "method": "turn/completed",
      "params": {
        "threadId": "01a1c034-b264-7832-84e7-5595c1b7f455",
        "turn": {
          "id": "01a1c034-b29b-7841-ab7d-08b8abbd3f05",
          "items": [
            {
              "type": "agentMessage",
              "id": "msg_182bf962690143e09ca35bf055179fd4",
              "text": "second",
              "phase": null,
              "memoryCitation": null,
              "delivery": null,
              "questions": null
            }
          ],
          "itemsView": "summary",
          "status": "completed",
          "error": null,
          "startedAt": 1794226041,
          "completedAt": 1794226041,
          "durationMs": 22
        }
      },
      "emittedAtMs": 1794226041523
    }
  ]
}
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `bun test packages/runner/test/codex/classify.test.ts`
Expected: FAIL — `error: Cannot find module '../../src/adapters/codex/classify' from 'packages/runner/test/codex/classify.test.ts'` (0 pass, 1 fail, 1 error)

- [ ] **Step 3: Implement**

**File:** `packages/runner/src/adapters/codex/classify.ts` (new)

```ts
// Codex turn errors and rate-limit snapshots as the runner sees them (design 9.2 Errors and Quota, 6.10): the
// AgentEvent error kind of a failed turn and the account's VendorQuota. Pure: the session feeds it notifications, and
// the runner core applies allowPaidUsage to what it reports (X-14).
import type { VendorQuota } from '@agflow/core';
import type { AgentEvent } from '../types';
import type { ParamsOf } from './methods';
import type { CodexErrorInfo, RateLimitSnapshot, RateLimitWindow } from './protocol/v2';

export type CodexErrorKind = NonNullable<Extract<AgentEvent, { type: 'turn_ended' }>['errorKind']>;

// A protocol re-pin must place every new string variant, even though runtime unknowns stay vendor errors.
const ERROR_KINDS = {
  contextWindowExceeded: 'context',
  sessionBudgetExceeded: 'session_budget',
  usageLimitExceeded: 'quota',
  rateLimitExceeded: 'vendor',
  flexUnavailable: 'vendor',
  serverOverloaded: 'vendor',
  cyberPolicy: 'policy',
  misalignmentPolicyViolation: 'policy',
  tooManyDenials: 'denials',
  internalServerError: 'vendor',
  unauthorized: 'auth',
  badRequest: 'vendor',
  threadRollbackFailed: 'vendor',
  sandboxError: 'vendor',
  other: 'vendor',
} satisfies Record<Extract<CodexErrorInfo, string>, CodexErrorKind>;

/**
 * The error kind of a failed turn; null for activeTurnNotSteerable, which rejects a steer and never fails a turn.
 * rateLimits is the merged snapshot so far: a set rateLimitReachedType turns an otherwise generic vendor failure into
 * a quota one. It is account state, not this failure's cause, so it never overrides a specific kind.
 */
export function turnErrorKind(
  info: CodexErrorInfo | null,
  rateLimits?: RateLimitSnapshot | null,
): CodexErrorKind | null {
  const kind = errorInfoKind(info);
  return kind === 'vendor' && rateLimits?.rateLimitReachedType != null ? 'quota' : kind;
}

function errorInfoKind(info: CodexErrorInfo | null): CodexErrorKind | null {
  // A steer rejection never ends a turn, even while the account is exhausted.
  if (info !== null && typeof info === 'object' && 'activeTurnNotSteerable' in info) return null;
  if (typeof info === 'string') {
    return Object.hasOwn(ERROR_KINDS, info) ? ERROR_KINDS[info] : 'vendor';
  }
  if (info !== null && typeof info === 'object') {
    if ('httpConnectionFailed' in info && info.httpConnectionFailed?.httpStatusCode === 401) return 'auth';
    if ('responseStreamConnectionFailed' in info && info.responseStreamConnectionFailed?.httpStatusCode === 401) {
      return 'auth';
    }
  }
  return 'vendor';
}

/** The adapter acts only on the error Codex gives up on (design 9.2): willRetry true means it is still retrying. */
export function isFinalError(params: ParamsOf<'error'>): boolean {
  return !params.willRetry && turnErrorKind(params.error.codexErrorInfo) !== null;
}

/**
 * Folds a sparse account/rateLimits/updated into the snapshot so far: null windows and credits keep their values.
 * Only the 'codex' bucket is the account's quota (as account/rateLimits/read reports it); updates for other metered
 * buckets leave the snapshot as it was.
 */
export function mergeRateLimits(previous: RateLimitSnapshot, update: RateLimitSnapshot): RateLimitSnapshot;
export function mergeRateLimits(previous: RateLimitSnapshot | null, update: RateLimitSnapshot): RateLimitSnapshot | null;
export function mergeRateLimits(
  previous: RateLimitSnapshot | null,
  update: RateLimitSnapshot,
): RateLimitSnapshot | null {
  if (update.limitId !== null && update.limitId !== 'codex') return previous;
  if (previous === null) return update;
  return {
    ...update,
    primary: update.primary ?? previous.primary,
    secondary: update.secondary ?? previous.secondary,
    credits: update.credits ?? previous.credits,
    // rateLimitReachedType comes from update: retaining it would hide recovery after a reset.
  };
}

function durationSlot(window: RateLimitWindow): keyof VendorQuota['windows'] | null {
  if (window.windowDurationMins === 300) return 'fiveHour';
  if (window.windowDurationMins === 10080) return 'weekly';
  return null;
}

// A window whose reset has passed counts as empty until a fresh update replaces it: sparse updates keep old windows.
function isReset(window: RateLimitWindow, now: number): boolean {
  return window.resetsAt !== null && window.resetsAt * 1000 <= now;
}

function utilization(window: RateLimitWindow, now: number): number {
  return isReset(window, now) ? 0 : Math.max(0, Math.min(1, window.usedPercent / 100));
}

function isFull(window: RateLimitWindow, now: number): boolean {
  return !isReset(window, now) && window.usedPercent >= 100;
}

function limitingReset(windows: RateLimitWindow[], now: number): number | null {
  const current = windows.filter((window) => !isReset(window, now));
  const full = current.filter((window) => window.usedPercent >= 100);
  if (full.length > 0) {
    // Every full window must reset before included usage can resume.
    if (full.some((window) => window.resetsAt === null)) return null;
    return Math.max(...full.map((window) => window.resetsAt!));
  }
  let limiting: RateLimitWindow | null = null;
  for (const window of current) {
    if (limiting === null || window.usedPercent > limiting.usedPercent) limiting = window;
  }
  return limiting?.resetsAt ?? null;
}

/**
 * The VendorQuota of a snapshot. Windows map by duration, then by position; resetsAt is the limiting window's. A full
 * window with credits is paid usage in use, reported with state ok for the runner core to judge.
 */
export function quotaFromRateLimits(snapshot: RateLimitSnapshot, now = Date.now()): VendorQuota {
  const positions = [snapshot.primary, snapshot.secondary];
  const available = positions.filter((window): window is RateLimitWindow => window !== null);
  const windows: VendorQuota['windows'] = { fiveHour: null, weekly: null };
  for (const window of available) {
    const slot = durationSlot(window);
    if (slot !== null) windows[slot] = utilization(window, now);
  }
  // Known durations reserve their slots before unknown durations fall back to position.
  for (const [index, window] of positions.entries()) {
    const slot = index === 0 ? 'fiveHour' : 'weekly';
    if (window !== null && durationSlot(window) === null && windows[slot] === null) {
      windows[slot] = utilization(window, now);
    }
  }

  const full = available.some((window) => isFull(window, now));
  const credits = snapshot.credits;
  const paidUsage: VendorQuota['paidUsage'] = credits === null
    ? 'unknown'
    : credits.hasCredits || credits.unlimited
      ? full ? 'in_use' : 'enabled'
      : 'disabled';
  const state: VendorQuota['state'] = snapshot.rateLimitReachedType !== null || (full && paidUsage !== 'in_use')
    ? 'exhausted'
    : available.length === 0 ? 'unknown' : 'ok';
  const reset = limitingReset(available, now);
  return {
    state,
    // Codex sends epoch seconds; the runner and hub share epoch milliseconds.
    resetsAt: reset === null ? null : reset * 1000,
    windows,
    paidUsage,
    updatedAt: now,
  };
}
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `bun test packages/runner/test/codex/classify.test.ts && bun test && bun run typecheck`
Expected: the task's tests pass (20 pass); then the whole suite passes (`0 fail`) and `tsc` exits 0.

A set `rateLimitReachedType` turns only `vendor` failures into `quota`, and `activeTurnNotSteerable` is never a turn error. Updates for a `limitId` other than null or `codex` are ignored, and a window whose reset has passed counts as empty. `resetsAt` is the full window's (the later one when both are full), else the most used window's. In the recordings a `response.failed` with `server_error` arrives as `other`, a 401 as `{ httpConnectionFailed: { httpStatusCode: 401 } }`, and a failed stream also sends all-null rate-limit updates. Unknown values at run time, a string or a one-key object the table does not know, are `vendor`.

- [ ] **Step 5: Commit**

```bash
git add -A 'packages/runner/src/adapters/codex/classify.ts' 'packages/runner/test/codex/classify.test.ts' 'packages/runner/test/codex/fixtures/recorded-notifications.json'
git commit -m 'M2E Task 8: Error and quota classification' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

### Task 9: App-server process: spawn, initialize and the startup lock

`openAppServer` is the one way to start `codex app-server`, shared by preflight, transcript deletion and sessions (design 9.1, 7.4). It spawns the binary detached in its own process group, calls `onSpawn(pid)` before any output is read, drains stderr to the log with a bound, and sends `initialize` as `agflow`, checking the version in the answer's `userAgent` (X-13). Two app-servers starting at once on a fresh `CODEX_HOME` can fail with 'failed to initialize sqlite state runtime', so starts are serialised per `CODEX_HOME` until `initialize` answers, and an open without `onSpawn` that dies with that message is retried once. `end()` closes stdin, waits, then SIGTERMs and SIGKILLs the group, with every wait bounded.

**Files:**
- Create: `packages/runner/src/adapters/codex/process.ts`
- Test: `packages/runner/test/codex/fake-app-server.ts`
- Test: `packages/runner/test/codex/peer.ts`
- Test: `packages/runner/test/codex/process.test.ts`

- [ ] **Step 1: Write the failing tests**

**File:** `packages/runner/test/codex/fake-app-server.ts` (change)

```diff
diff --git a/packages/runner/test/codex/fake-app-server.ts b/packages/runner/test/codex/fake-app-server.ts
index 1eee8b19..7aca9471 100644
--- a/packages/runner/test/codex/fake-app-server.ts
+++ b/packages/runner/test/codex/fake-app-server.ts
@@ -235,8 +235,9 @@ function step(next: ScriptedStep): Promise<void> | undefined {
     send({ id, ...request });
   } else if ('stderr' in next) writeAll(2, `${next.stderr}\n`);
   else if ('spawnPipeHolder' in next) {
-    // Not detached, so it stays in the peer's process group.
-    const holder = Bun.spawn(['/bin/sleep', '600'], { stdio: ['ignore', 'inherit', 'inherit'] });
+    // Unless detached, it stays in the peer's process group.
+    const detached = next.spawnPipeHolder !== true && next.spawnPipeHolder.detached;
+    const holder = Bun.spawn(['/bin/sleep', '600'], { stdio: ['ignore', 'inherit', 'inherit'], detached });
     holder.unref();
     record({ type: 'pipeHolder', pid: holder.pid });
   } else exit('crash', next.crash);
```

**File:** `packages/runner/test/codex/peer.ts` (change)

```diff
diff --git a/packages/runner/test/codex/peer.ts b/packages/runner/test/codex/peer.ts
index 90984a4c..3bcf0d7f 100644
--- a/packages/runner/test/codex/peer.ts
+++ b/packages/runner/test/codex/peer.ts
@@ -72,14 +72,15 @@ export type CrashSignal = 'SIGKILL' | 'SIGTERM' | 'SIGINT' | 'SIGHUP' | 'SIGQUIT
  * it; by default that is serverRequest/resolved for the request, as 0.159.2 sends it, and [] sends nothing. A
  * withdrawal (resolved before any answer, as after turn/interrupt) is an explicit notify step. spawnPipeHolder starts
  * `sleep 600` in the peer's process group with its stdout and stderr, so the pipes stay open after the peer exits
- * and only a group kill ends it.
+ * and only a group kill ends it; { detached: true } starts it in a group of its own, as an escaped process, so not
+ * even that ends it.
  */
 export type ScriptedStep =
   | { notify: ServerNotification }
   | { request: ScriptedServerRequest; afterAnswer?: ScriptedStep[] }
   | { delayMs: number }
   | { stderr: string }
-  | { spawnPipeHolder: true }
+  | { spawnPipeHolder: true | { detached: true } }
   | { crash: { code: number } | { signal: CrashSignal } };
 
 /**
```

**File:** `packages/runner/test/codex/process.test.ts` (new)

```ts
// App-server startup, handshake and bounded group shutdown against the scripted peer.
import { afterEach, describe, expect, test } from 'bun:test';
import { AGFLOW_VERSION } from '@agflow/core';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CODEX_VERSION } from '../../src/adapters/codex/binary';
import { appServerArgs, appServerEnv } from '../../src/adapters/codex/config';
import { openAppServer, type OpenAppServerOptions } from '../../src/adapters/codex/process';
import { RpcTimeout } from '../../src/adapters/codex/rpc';
import { runnerPaths } from '../../src/paths';
import { processIdentity } from '../../src/processes';
import { vendorBinary } from '../../src/vendor/pins';
import { codexMessages, codexScenario, readCodexRecord, writeCodexShim, type CodexScenario } from './peer';

const dirs: string[] = [];
const pids: number[] = [];
/** Pipe holders that escaped the app-server's group, so no group kill ends them. */
const escaped: number[] = [];
afterEach(() => {
  for (const pid of [...pids.splice(0), ...escaped.splice(0)]) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // Already gone, including any pipe holders.
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(scenario: CodexScenario | CodexScenario[] = codexScenario()): OpenAppServerOptions {
  const dir = mkdtempSync(join(tmpdir(), 'agflow-codex-process-'));
  dirs.push(dir);
  const codexHome = join(dir, 'codex-home');
  mkdirSync(codexHome);
  const bin = join(runnerPaths(join(dir, 'agflow')).runner, vendorBinary('codex', CODEX_VERSION));
  writeCodexShim(bin, scenario);
  return {
    bin,
    args: appServerArgs({ model_provider: 'scripted' }),
    env: appServerEnv({ base: { PATH: '/usr/bin:/bin' }, bridgeEnv: { AGFLOW_TEST: '1' }, codexHome, userHome: dir }),
    cwd: dir,
    expectedVersion: CODEX_VERSION,
    logFile: join(dir, 'stderr.log'),
    onSpawn: (pid) => {
      pids.push(pid);
    },
  };
}

/** Opened without onSpawn, as preflight and transcript deletion open it. */
function unregistered(options: OpenAppServerOptions): OpenAppServerOptions {
  return { ...options, onSpawn: undefined };
}

const fastEnd = { closeMs: 100, termMs: 100, pipesMs: 100 };
const sqliteFailure = codexScenario({
  failBeforeInitialize: { stderr: 'Error: failed to initialize sqlite state runtime', code: 1 },
});

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the peer');
    await Bun.sleep(10);
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('openAppServer', () => {
  test('spawns a group with the given args, env and cwd; onSpawn runs before stderr is drained, with a bound', async () => {
    const options = setup(codexScenario({ stderr: ['startup ' + 'x'.repeat(128 * 1024)] }));
    let spawned: number | undefined;
    options.onSpawn = (pid) => {
      pids.push(pid);
      spawned = pid;
      expect(!existsSync(options.logFile) || readFileSync(options.logFile).length === 0).toBe(true);
    };
    const server = await openAppServer({ ...options, maxStderrBytes: 32 });
    const [run] = readCodexRecord(options.bin);
    expect(run?.pid).toBe(spawned!);
    expect(server.pid).toBe(spawned!);
    expect(run?.argv).toEqual(options.args);
    expect(run?.env).toEqual(options.env);
    expect(run?.cwd).toBe(realpathSync(options.cwd));
    expect(process.kill(-server.pid, 0)).toBe(true);
    await server.end(fastEnd);
    expect(readFileSync(options.logFile, 'utf8')).toBe(
      'startup ' + 'x'.repeat(24) + '\n[agflow: output truncated after 32 bytes]\n',
    );
  });

  test('ps confirms that the app-server leads its own group', async () => {
    const server = await openAppServer(setup());
    try {
      expect((await processIdentity(server.pid))?.pgid).toBe(server.pid);
    } finally {
      await server.end(fastEnd);
    }
  });

  test('initializes as agflow with its version, then sends initialized', async () => {
    const options = setup();
    const server = await openAppServer(options);
    expect(server.initialize.userAgent).toStartWith(`agflow/${CODEX_VERSION} `);
    await server.end(fastEnd);
    const [run] = readCodexRecord(options.bin);
    expect(run?.requests).toHaveLength(1);
    expect(run?.requests[0]).toMatchObject({
      method: 'initialize',
      params: { clientInfo: { name: 'agflow', title: null, version: AGFLOW_VERSION }, capabilities: null },
    });
    expect(run?.notifications.map((note) => note.method)).toEqual(['initialized']);
    expect(run!.notifications[0]!.at).toBeGreaterThanOrEqual(run!.initializedAt!);
  });

  test('a different version ends through stdin EOF, names both versions, and releases the lock', async () => {
    const options = setup([codexScenario({ version: '0.158.0' }), codexScenario()]);
    const first = openAppServer(options);
    const failed = expect(first).rejects.toThrow(`reports version 0.158.0, expected ${CODEX_VERSION}`);
    const next = openAppServer(options);
    await failed;
    expect(readCodexRecord(options.bin)[0]?.exit?.reason).toBe('eof');
    await (await next).end(fastEnd);
  });

  test('an unreadable userAgent is a version mismatch and ends the process', async () => {
    const result = {
      ...codexMessages.initializeResult(CODEX_VERSION, { name: 'agflow', version: AGFLOW_VERSION }, '/tmp'),
      userAgent: 'unreadable',
    };
    const options = setup(codexScenario({ answers: { initialize: { result } } }));
    await expect(openAppServer(options)).rejects.toThrow(`reports version unknown, expected ${CODEX_VERSION}`);
    expect(readCodexRecord(options.bin)[0]?.exit?.reason).toBe('eof');
  });

  test('accepts the recorded version for a resumed attempt even when it differs from the pin', async () => {
    const options = setup(codexScenario({ version: '0.158.0' }));
    const server = await openAppServer({ ...options, expectedVersion: '0.158.0' });
    expect(server.initialize.userAgent).toStartWith('agflow/0.158.0 ');
    await server.end(fastEnd);
  });

  test('serializes opens on the same resolved home only until initialize answers', async () => {
    const options = setup(codexScenario({ answers: { initialize: { delayMs: 300 } } }));
    const [first, second] = await Promise.all([
      openAppServer(options),
      openAppServer({ ...options, env: { ...options.env, CODEX_HOME: `${options.env.CODEX_HOME}/../codex-home` } }),
    ]);
    const runs = readCodexRecord(options.bin);
    expect(runs).toHaveLength(2);
    expect(runs[1]!.startedAt).toBeGreaterThanOrEqual(runs[0]!.initializedAt!);
    expect(runs[0]!.exit).toBeNull();
    await Promise.all([first.end(fastEnd), second.end(fastEnd)]);
  });

  test('different homes initialize concurrently', async () => {
    const options = setup(codexScenario({ answers: { initialize: { delayMs: 300 } } }));
    const otherHome = join(options.cwd, 'other-home');
    mkdirSync(otherHome);
    const servers = await Promise.all([
      openAppServer(options),
      openAppServer({ ...options, env: { ...options.env, CODEX_HOME: otherHome } }),
    ]);
    const runs = readCodexRecord(options.bin);
    expect(Math.max(...runs.map((run) => run.startedAt))).toBeLessThan(
      Math.min(...runs.map((run) => run.initializedAt!)),
    );
    await Promise.all(servers.map((server) => server.end(fastEnd)));
  });

  test('retries the sqlite startup exit once inside the lock', async () => {
    const options = unregistered(setup([sqliteFailure, codexScenario({ answers: { initialize: { delayMs: 100 } } })]));
    const servers = await Promise.all([openAppServer(options), openAppServer(options)]);
    const runs = readCodexRecord(options.bin);
    pids.push(...runs.map((run) => run.pid));
    expect(runs).toHaveLength(3);
    expect(runs[0]?.exit?.code).toBe(1);
    expect(servers[0]!.pid).toBe(runs[1]!.pid);
    expect(runs[2]!.startedAt).toBeGreaterThanOrEqual(runs[1]!.initializedAt!);
    await Promise.all(servers.map((server) => server.end(fastEnd)));
  });

  test('a second sqlite failure rejects and releases the lock', async () => {
    const options = unregistered(setup([sqliteFailure, sqliteFailure, codexScenario()]));
    await expect(openAppServer(options)).rejects.toThrow(sqliteFailure.failBeforeInitialize!.stderr);
    expect(readCodexRecord(options.bin)).toHaveLength(2);
    const server = await openAppServer(options);
    pids.push(server.pid);
    await server.end(fastEnd);
  });

  test('a registered open does not respawn after the sqlite exit, because a launch registers one pid', async () => {
    const options = setup([sqliteFailure, codexScenario()]);
    const registered: number[] = [];
    await expect(
      openAppServer({
        ...options,
        onSpawn: (pid) => {
          pids.push(pid);
          registered.push(pid);
        },
      }),
    ).rejects.toThrow(sqliteFailure.failBeforeInitialize!.stderr);
    expect(registered).toHaveLength(1);
    expect(readCodexRecord(options.bin)).toHaveLength(1);
    await (await openAppServer(options)).end(fastEnd);
  });

  test('other early exits report the first nonempty stderr line without retrying', async () => {
    const options = setup(
      codexScenario({
        stderr: ['', 'startup failed', 'details'],
        failBeforeInitialize: { stderr: '', code: 7 },
      }),
    );
    await expect(openAppServer(options)).rejects.toThrow(/^startup failed$/);
    expect(readCodexRecord(options.bin)).toHaveLength(1);
  });

  test('an Error line takes precedence over a warning for a missing home', async () => {
    const options = setup();
    options.env.CODEX_HOME = join(options.cwd, 'missing-home');
    await expect(openAppServer(options)).rejects.toThrow(
      `Error: CODEX_HOME points to "${options.env.CODEX_HOME}", but that path does not exist`,
    );
    expect(readCodexRecord(options.bin)).toHaveLength(1);
  });

  test('empty stderr reports the exit code', async () => {
    const options = setup(codexScenario({ failBeforeInitialize: { stderr: '', code: 7 } }));
    await expect(openAppServer(options)).rejects.toThrow('code 7');
  });

  test('an early leader exit is diagnosed even when a child inherited its pipes', async () => {
    const options = setup(
      codexScenario({
        answers: {
          initialize: {
            silent: true,
            then: [{ spawnPipeHolder: true }, { stderr: 'Error: startup crashed' }, { crash: { code: 3 } }],
          },
        },
      }),
    );
    const started = Date.now();
    await expect(openAppServer(options)).rejects.toThrow('Error: startup crashed');
    expect(Date.now() - started).toBeLessThan(1_500);
    const [holder] = readCodexRecord(options.bin)[0]!.pipeHolders;
    expect(holder).toBeNumber();
    await until(() => !alive(holder!));
  });

  test('an early exit is diagnosed from stderr when an escaped process holds the pipes', async () => {
    const options = setup(
      codexScenario({
        answers: {
          initialize: {
            silent: true,
            then: [
              { spawnPipeHolder: { detached: true } },
              { stderr: 'Error: startup crashed' },
              { crash: { code: 3 } },
            ],
          },
        },
      }),
    );
    const started = Date.now();
    const opened = openAppServer({ ...options, initializeTimeoutMs: 10_000 });
    const failed = expect(opened).rejects.toThrow('Error: startup crashed');
    await until(() => readCodexRecord(options.bin)[0]?.pipeHolders.length === 1);
    escaped.push(...readCodexRecord(options.bin)[0]!.pipeHolders);
    await failed;
    // Well before initializeTimeoutMs: the exit, not stdout's end, settles initialize.
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(alive(escaped[0]!)).toBe(true);
  }, 15_000);

  test('a missing binary says binary missing and releases the lock', async () => {
    const options = setup();
    await expect(openAppServer({ ...options, bin: join(options.cwd, 'missing') })).rejects.toThrow(/^binary missing$/);
    await (await openAppServer(options)).end(fastEnd);
  });

  test('a missing working directory is not reported as a missing binary', async () => {
    const options = setup();
    await expect(openAppServer({ ...options, cwd: join(options.cwd, 'removed-clone') })).rejects.toThrow(
      `working directory missing: ${join(options.cwd, 'removed-clone')}`,
    );
    expect(readCodexRecord(options.bin)).toEqual([]);
    await (await openAppServer(options)).end(fastEnd);
  });

  test('a throwing onSpawn kills the group, preserves the error and releases the lock', async () => {
    const options = setup();
    const error = new Error('registration failed');
    let pid = 0;
    await expect(
      openAppServer({
        ...options,
        onSpawn: (value) => {
          pids.push(value);
          pid = value;
          throw error;
        },
      }),
    ).rejects.toBe(error);
    await until(() => !alive(pid));
    await (await openAppServer(options)).end(fastEnd);
  });

  test('initialize has its own timeout, cleans up, and releases the lock', async () => {
    const options = setup([codexScenario({ answers: { initialize: { silent: true } } }), codexScenario()]);
    await expect(openAppServer({ ...options, initializeTimeoutMs: 150, requestTimeoutMs: 1 })).rejects.toThrow(
      'initialize within 150 ms',
    );
    expect(readCodexRecord(options.bin)[0]?.exit?.reason).toBe('eof');
    const server = await openAppServer({ ...options, requestTimeoutMs: 20 });
    await server.end(fastEnd);
  });

  test('passes the ordinary request timeout to rpc', async () => {
    const options = setup(codexScenario({ answers: { 'thread/name/set': { silent: true } } }));
    const server = await openAppServer({ ...options, requestTimeoutMs: 20 });
    await expect(server.rpc.request('thread/name/set', { threadId: 't', name: 'n' })).rejects.toBeInstanceOf(
      RpcTimeout,
    );
    await server.end(fastEnd);
  });
});

describe('end', () => {
  test('closes stdin, gives the exit and returns the same promise on every call', async () => {
    const options = setup();
    const server = await openAppServer(options);
    const ended = server.end(fastEnd);
    expect(server.end({ closeMs: 0 })).toBe(ended);
    expect(await ended).toEqual({ code: 0, signal: null });
    expect(await server.exited).toEqual({ code: 0, signal: null });
    expect(server.end()).toBe(ended);
    expect(readCodexRecord(options.bin)[0]?.exit?.reason).toBe('eof');
    expect(readCodexRecord(options.bin)[0]?.signals).toEqual([]);
  });

  test('escalates to SIGTERM when stdin EOF is ignored', async () => {
    const options = setup(codexScenario({ onStdinEof: 'ignore' }));
    const server = await openAppServer(options);
    expect(await server.end(fastEnd)).toMatchObject({ signal: 'SIGTERM' });
    expect(readCodexRecord(options.bin)[0]?.signals).toEqual(['SIGTERM']);
  });

  test('escalates to SIGKILL when SIGTERM is ignored too', async () => {
    const options = setup(codexScenario({ onStdinEof: 'ignore', ignoreSigterm: true }));
    const server = await openAppServer(options);
    expect(await server.end(fastEnd)).toMatchObject({ signal: 'SIGKILL' });
    expect(readCodexRecord(options.bin)[0]?.signals).toEqual(['SIGTERM']);
  });

  test('stdin EOF also kills the group member holding the pipes', async () => {
    const options = setup(codexScenario({ answers: { 'thread/name/set': { then: [{ spawnPipeHolder: true }] } } }));
    const server = await openAppServer(options);
    await server.rpc.request('thread/name/set', { threadId: 't', name: 'n' });
    await until(() => readCodexRecord(options.bin)[0]!.pipeHolders.length === 1);
    const [holder] = readCodexRecord(options.bin)[0]!.pipeHolders;
    expect(alive(holder!)).toBe(true);
    const started = Date.now();
    expect(await server.end(fastEnd)).toEqual({ code: 0, signal: null });
    expect(Date.now() - started).toBeLessThan(1_000);
    await until(() => !alive(holder!));
  });

  test('kills a pipe holder immediately after an unrequested leader exit and bounds pipe waiting', async () => {
    const options = setup(
      codexScenario({
        answers: { 'thread/name/set': { then: [{ spawnPipeHolder: true }, { crash: { code: 0 } }] } },
      }),
    );
    const server = await openAppServer(options);
    await server.rpc.request('thread/name/set', { threadId: 't', name: 'n' });
    await server.exited;
    const [holder] = readCodexRecord(options.bin)[0]!.pipeHolders;
    expect(holder).toBeNumber();
    const started = Date.now();
    expect(await server.end(fastEnd)).toEqual({ code: 0, signal: null });
    expect(Date.now() - started).toBeLessThan(1_000);
    await until(() => !alive(holder!));
  });

  test('waiting for the pipes after an exit is bounded, even when an escaped process holds them', async () => {
    const options = setup(
      codexScenario({ answers: { 'thread/name/set': { then: [{ spawnPipeHolder: { detached: true } }] } } }),
    );
    const server = await openAppServer(options);
    await server.rpc.request('thread/name/set', { threadId: 't', name: 'n' });
    await until(() => readCodexRecord(options.bin)[0]!.pipeHolders.length === 1);
    escaped.push(...readCodexRecord(options.bin)[0]!.pipeHolders);
    const started = Date.now();
    expect(await server.end(fastEnd)).toEqual({ code: 0, signal: null });
    expect(Date.now() - started).toBeLessThan(1_000);
    // It still holds stdout and stderr; end() stopped waiting for them.
    expect(alive(escaped[0]!)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `bun test packages/runner/test/codex/process.test.ts`
Expected: FAIL — `error: Cannot find module '../../src/adapters/codex/process' from 'packages/runner/test/codex/process.test.ts'` (0 pass, 1 fail, 1 error)

- [ ] **Step 3: Implement**

**File:** `packages/runner/src/adapters/codex/process.ts` (new)

```ts
// Starting `codex app-server` (design 9.1, 7.4), the one way preflight, transcript deletion and sessions open it:
// detached in its own process group, recorded before any output is read, stderr drained with a bound, initialized
// with a version check, and ended through stdin EOF, SIGTERM and SIGKILL with every wait bounded.
import { AGFLOW_VERSION } from '@agflow/core';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { type Logger, noopLogger } from '../../log';
import { boundedWait, drainToLog } from '../../processes';
import type { ExitInfo } from '../types';
import type { InitializeResponse } from './protocol/InitializeResponse';
import { CodexRpc, RpcClosed } from './rpc';

export interface OpenAppServerOptions {
  /** The native binary in the runner's vendor directory. */
  bin: string;
  /** appServerArgs(...). */
  args: string[];
  /** appServerEnv(...); CODEX_HOME is required and keys the startup lock. */
  env: Record<string, string>;
  cwd: string;
  /** The pin, or the attempt's recorded cliVersion on resume. */
  expectedVersion: string;
  /** stderr is appended through drainToLog. */
  logFile: string;
  /** Called synchronously after spawn, before either pipe is read. */
  onSpawn?: (pid: number) => void;
  logger?: Logger;
  /** Passed to CodexRpc for requests after initialization. */
  requestTimeoutMs?: number;
  /** Defaults to 30 seconds. */
  initializeTimeoutMs?: number;
  /** Defaults to 4 MiB; the pipe is still drained past this bound. */
  maxStderrBytes?: number;
}

export interface AppServerProcess {
  readonly pid: number;
  readonly rpc: CodexRpc;
  readonly initialize: InitializeResponse;
  readonly exited: Promise<ExitInfo>;
  /** stdin EOF, SIGTERM, SIGKILL, then bounded pipe waiting; every call returns the same promise. */
  end(options?: { closeMs?: number; termMs?: number; pipesMs?: number }): Promise<ExitInfo | null>;
}

const startups = new Map<string, Promise<void>>();
const SQLITE_FAILURE = 'failed to initialize sqlite state runtime';
const STDERR_HEAD_BYTES = 4096;
// userAgent is `agflow/0.159.2 (Mac OS 26.6.2; arm64) ...`: the version follows the client name.
const USER_AGENT_VERSION = /^[^/]+\/([^\s/]+)(?: |$)/;
const PIPES_MS = 1000;

class StartupExit extends Error {
  constructor(
    message: string,
    readonly retry: boolean,
  ) {
    super(message);
  }
}

export async function openAppServer(options: OpenAppServerOptions): Promise<AppServerProcess> {
  if (!options.env.CODEX_HOME) throw new Error('CODEX_HOME is required');
  const home = resolve(options.env.CODEX_HOME);
  // A 2026-10-28 probe: two starts at once on a fresh home failed in 5 of 10 runs with SQLITE_FAILURE, while 30
  // concurrent starts on an initialized home all worked. So starts on one home wait for each other until initialize
  // answers, and the sqlite exit gets one retry inside the lock unless the caller registers the pid.
  const previous = startups.get(home);
  let release!: () => void;
  const current = new Promise<void>((done) => {
    release = done;
  });
  startups.set(home, current);
  await previous;
  try {
    try {
      return await start(options);
    } catch (error) {
      // A registered launch records exactly one pid, so with onSpawn the caller's own retry starts it again.
      if (!(error instanceof StartupExit) || !error.retry || options.onSpawn) throw error;
      return await start(options);
    }
  } finally {
    release();
    if (startups.get(home) === current) startups.delete(home);
  }
}

async function start(options: OpenAppServerOptions): Promise<AppServerProcess> {
  const logger = options.logger ?? noopLogger;
  let proc: ReturnType<typeof Bun.spawn<'pipe', 'pipe', 'pipe'>>;
  try {
    proc = Bun.spawn([options.bin, ...options.args], {
      cwd: options.cwd,
      env: options.env,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      detached: true,
    });
  } catch (error) {
    // Bun gives the same ENOENT for a missing cwd, such as a removed clone.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    throw new Error(existsSync(options.bin) ? `working directory missing: ${options.cwd}` : 'binary missing');
  }

  let spawnError: { error: unknown } | undefined;
  try {
    options.onSpawn?.(proc.pid);
  } catch (error) {
    spawnError = { error };
    signal('SIGKILL');
  }

  function signal(name: NodeJS.Signals): void {
    try {
      process.kill(-proc.pid, name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        logger.warn('codex app-server: group signal failed', { pid: proc.pid, signal: name, error: String(error) });
      }
    }
  }

  let exit: ExitInfo | null = null;
  const exited = proc.exited.then(() => {
    exit = { code: proc.exitCode, signal: proc.signalCode };
    // Kill pipe holders now, while the group still has members and its id cannot have been reused.
    signal('SIGKILL');
    return exit;
  });
  let starting = true;
  let head = Buffer.alloc(0);
  const stderr = pipe(proc.stderr, (chunk) => {
    if (starting && head.length < STDERR_HEAD_BYTES) {
      head = Buffer.concat([head, chunk.subarray(0, STDERR_HEAD_BYTES - head.length)]);
    }
  });
  const stdout = pipe(proc.stdout);
  const drained = drainToLog(stderr.read(), options.logFile, { maxBytes: options.maxStderrBytes ?? 4 * 1024 * 1024 })
    .catch((error: unknown) => {
      logger.warn('codex app-server: stderr log failed', { error: String(error) });
    })
    .then(async () => {
      // Opening the log can fail; the pipe is still read to its end, or app-server would block on it.
      for await (const _chunk of stderr.read()) {
        // Dropped.
      }
    });
  const rpc = new CodexRpc({
    stdin: proc.stdin,
    stdout: stdout.read(),
    logger,
    requestTimeoutMs: options.requestTimeoutMs,
  });
  const pipes = Promise.all([rpc.ended, drained]);
  let ending: Promise<ExitInfo | null> | undefined;
  const end: AppServerProcess['end'] = (bounds = {}) => {
    ending ??= (async () => {
      const pipesMs = bounds.pipesMs ?? PIPES_MS;
      const alreadyClosed = rpc.closed;
      rpc.close();
      // stdout EOF closes the transport without ending stdin.
      if (alreadyClosed) {
        try {
          void Promise.resolve(proc.stdin.end()).catch((error: unknown) => {
            logger.debug('codex app-server: ending stdin failed', { error: String(error) });
          });
        } catch (error) {
          logger.debug('codex app-server: ending stdin failed', { error: String(error) });
        }
      }
      if (!exit) await boundedWait(exited, bounds.closeMs ?? 2000);
      if (!exit) {
        signal('SIGTERM');
        await boundedWait(exited, bounds.termMs ?? 5000);
      }
      if (!exit) {
        signal('SIGKILL');
        await boundedWait(exited, pipesMs);
      }
      if (!(await boundedWait(pipes, pipesMs)).done) {
        stdout.cancel();
        stderr.cancel();
      }
      return exit;
    })();
    return ending;
  };

  try {
    if (spawnError) throw spawnError.error;
    let initialize: InitializeResponse;
    try {
      initialize = await Promise.race([
        rpc.request(
          'initialize',
          { clientInfo: { name: 'agflow', title: null, version: AGFLOW_VERSION }, capabilities: null },
          { timeoutMs: options.initializeTimeoutMs ?? 30_000 },
        ),
        exited.then(() => {
          throw new RpcClosed('initialize');
        }),
      ]);
    } catch (error) {
      if (!(error instanceof RpcClosed)) throw error;
      const stopped = await boundedWait(exited, PIPES_MS);
      await boundedWait(drained, PIPES_MS);
      const text = head.toString('utf8');
      const lines = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      // 0.159.2 prints a WARNING before the Error line (a missing CODEX_HOME), so an Error line is the reason when
      // there is one.
      const reason = lines.find((line) => line.startsWith('Error:')) ?? lines[0];
      const how = stopped.done
        ? stopped.value.signal
          ? `signal ${stopped.value.signal}`
          : `code ${stopped.value.code}`
        : null;
      const outcome = how
        ? `codex app-server exited with ${how}`
        : 'codex app-server stdout ended before initialize answered';
      throw new StartupExit(reason ?? outcome, stopped.done && text.includes(SQLITE_FAILURE));
    }
    starting = false;
    head = Buffer.alloc(0);
    const agent: unknown = initialize?.userAgent;
    const version = typeof agent === 'string' ? agent.match(USER_AGENT_VERSION)?.[1] : undefined;
    if (version !== options.expectedVersion) {
      throw new Error(`codex app-server reports version ${version ?? 'unknown'}, expected ${options.expectedVersion}`);
    }
    rpc.notify('initialized');
    return { pid: proc.pid, rpc, initialize, exited, end };
  } catch (error) {
    await end();
    throw error;
  } finally {
    starting = false;
  }
}

/** Explicit readers let end() stop waiting on pipes inherited by an escaped process. */
function pipe(stream: ReadableStream<Uint8Array>, capture?: (chunk: Uint8Array) => void) {
  const reader = stream.getReader();
  return {
    async *read(): AsyncGenerator<Uint8Array> {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          capture?.(value);
          yield value;
        }
      } catch {
        // A killed process or a cancelled pipe ends the read.
      }
    },
    cancel: () => {
      void reader.cancel().catch(() => {});
    },
  };
}
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `bun test packages/runner/test/codex/process.test.ts && bun test && bun run typecheck`
Expected: the task's tests pass (27 pass); then the whole suite passes (`0 fail`) and `tsc` exits 0.

A launch with `onSpawn` is not retried: M2b registers exactly one process per launch (X-50), so a session start rejects with the sqlite reason. Nothing in the runner retries it: M2b reports `attempt.failed_to_start` (infra), and the hub starts a new attempt after `infraBackoffMs` (design 6.9, Known behaviour 4). An early exit is explained by the first stderr line that starts with `Error:`, else the first non-empty one (0.159.2 writes a WARNING line first). A spawn ENOENT reads 'binary missing' only when the binary is gone, else `working directory missing: <cwd>`. The group is SIGKILLed once right after the leader's exit, so a pipe holder never outlives it. The fake peer gains `spawnPipeHolder` steps (also `detached`) for these tests; the process-group test requires permission to run `ps`.

- [ ] **Step 5: Commit**

```bash
git add -A 'packages/runner/src/adapters/codex/process.ts' 'packages/runner/test/codex/fake-app-server.ts' 'packages/runner/test/codex/peer.ts' 'packages/runner/test/codex/process.test.ts'
git commit -m 'M2E Task 9: App-server process: spawn, initialize and the startup lock' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

### Task 10: Managed policy, account identity and preflight

The zero-model preflight of design 9.1, returning `PreflightResult` with facts, quota and an empty `weakened` list (X-5). `classifyCodexPolicy` fails closed on managed policy and checks that the requirements still allow `workspace-write`, `on-request` and the `user` reviewer (X-31); `codexAccountIdentity` requires a ChatGPT login and derives the account id. `runCodexPreflight` also requires an empty `mcpServerStatus/list` and no user or plugin skills, and reads quota and credits with `account/rateLimits/read`, which needs a ChatGPT login: against the scripted provider it answers -32600 and the quota is null. `codexProcessOptions` is the one derivation of the Codex homes, the base environment and the test switches, which deletion and the adapter reuse; with `skipAuthChecks` only the account checks are waived (X-21).

**Files:**
- Create: `packages/runner/src/adapters/codex/policy.ts`
- Create: `packages/runner/src/adapters/codex/preflight.ts`
- Test: `packages/runner/test/codex/fixtures/requirements-managed.json`
- Test: `packages/runner/test/codex/policy.test.ts`
- Test: `packages/runner/test/codex/preflight.test.ts`

- [ ] **Step 1: Write the failing tests**

**File:** `packages/runner/test/codex/fixtures/requirements-managed.json` (new)

```json
{
  "configRequirements/read": {
    "requirements": {
      "modelProvider": null,
      "modelProviders": null,
      "allowedLoginMethods": [
        "api",
        "chatgpt"
      ],
      "cliAuthCredentialsStore": null,
      "chatgptBaseUrl": null,
      "additionalDeveloperInstructions": null,
      "allowedApprovalPolicies": null,
      "allowedApprovalsReviewers": null,
      "allowedSandboxModes": [
        "read-only",
        "workspace-write"
      ],
      "allowedWindowsSandboxImplementations": null,
      "allowedPermissionProfiles": null,
      "defaultPermissions": null,
      "allowedWebSearchModes": null,
      "allowManagedHooksOnly": null,
      "allowBrowserAndComputerUse": null,
      "allowAppshots": null,
      "allowRemoteControl": false,
      "computerUse": null,
      "browserUse": null,
      "inAppBrowser": null,
      "featureRequirements": {
        "browser_use_external": false,
        "computer_use": false
      },
      "hooks": null,
      "enforceResidency": null,
      "network": null,
      "application": null,
      "autoReview": null,
      "models": null,
      "sqliteHome": null,
      "logDir": null,
      "modelCatalogJson": null,
      "checkForUpdateOnStartup": null,
      "allowLoginShell": null,
      "feedback": null
    }
  },
  "config/read": {
    "config": {
      "model": null,
      "review_model": null,
      "model_context_window": null,
      "model_auto_compact_token_limit": null,
      "model_auto_compact_token_limit_scope": null,
      "model_provider": null,
      "approval_policy": null,
      "approvals_reviewer": null,
      "sandbox_mode": null,
      "sandbox_workspace_write": null,
      "forced_chatgpt_workspace_id": null,
      "forced_login_method": null,
      "web_search": null,
      "tools": null,
      "instructions": null,
      "developer_instructions": null,
      "compact_prompt": null,
      "model_reasoning_effort": null,
      "model_reasoning_summary": null,
      "model_verbosity": null,
      "service_tier": null,
      "analytics": {
        "enabled": false
      },
      "apps": null,
      "browser_use": null,
      "computer_use": null,
      "desktop": null,
      "mcp_servers": {},
      "background_terminal_max_timeout": 300000,
      "oss_provider": null,
      "history": {
        "persistence": "save-all",
        "max_bytes": null
      },
      "disable_paste_burst": null,
      "otel": null,
      "include_collaboration_mode_instructions": true,
      "features": {
        "network_proxy": null,
        "apps": false,
        "hooks": false,
        "plugins": false,
        "remote_plugin": false,
        "shell_snapshot": false,
        "api_key_model_discovery": false,
        "auth_elicitation": true,
        "background_paginated_rollout_migration": false,
        "codex_apps_mcp_2026_07_28": false,
        "mcp_2026_07_28": false,
        "memories": false,
        "mentions_v2": true,
        "remote_control": false,
        "tool_suggest": true,
        "windows_sandbox_service": false
      },
      "auto_review": null,
      "cloud": null,
      "apps_mcp_product_sku": null,
      "projects": null,
      "tui": null,
      "permissions": null,
      "model_post_turn_compact_threshold_percent": null,
      "notice": null,
      "default_permissions": null,
      "model_catalog_json": null,
      "plugins": {},
      "include_environment_context": true,
      "hooks": null,
      "feedback": {
        "enabled": false
      },
      "experimental_realtime_ws_model": null,
      "suppress_unstable_features_warning": null,
      "plan_mode_reasoning_effort": null,
      "goals": null,
      "include_permissions_instructions": true,
      "profiles": {},
      "cli_auth_credentials_store": "file",
      "project_doc_fallback_filenames": [],
      "experimental_realtime_ws_startup_context": null,
      "show_raw_agent_reasoning": null,
      "chatgpt_base_url": "https://chatgpt.com/backend-api/",
      "orchestrator": null,
      "include_apps_instructions": true,
      "mcp_oauth_callback_port": null,
      "experimental_realtime_ws_base_url": null,
      "responses_api_metadata": null,
      "experimental_thread_store": null,
      "memories": null,
      "project_root_markers": [
        ".git"
      ],
      "thread_unload_delay_secs": null,
      "audio": null,
      "windows": null,
      "log_dir": null,
      "hide_agent_reasoning": false,
      "mcp_optional_startup_grace_ms": null,
      "experimental_thread_store_endpoint": null,
      "check_for_update_on_startup": null,
      "mcp_oauth_credentials_store": "auto",
      "realtime": null,
      "allow_symlinked_codex_home": null,
      "sqlite_home": null,
      "skills": null,
      "shell_environment_policy": {
        "inherit": null,
        "ignore_default_excludes": null,
        "exclude": null,
        "set": null,
        "include_only": null,
        "filters": null,
        "experimental_use_profile": null
      },
      "js_repl_node_module_dirs": null,
      "tool_output_token_limit": null,
      "project_doc_max_bytes": 32768,
      "personality": null,
      "experimental_realtime_ws_backend_prompt": null,
      "file_opener": "vscode",
      "agents": null,
      "model_providers": {},
      "ghost_snapshot": null,
      "experimental_realtime_webrtc_call_base_url": null,
      "notify": null,
      "mcp_oauth_callback_url": null,
      "js_repl_node_path": null,
      "experimental_compact_prompt_file": null,
      "mcp_enterprise_managed_auth": null,
      "allow_login_shell": false,
      "experimental_realtime_start_instructions": null,
      "openai_base_url": null,
      "marketplaces": {},
      "experimental_use_unified_exec_tool": null,
      "tool_suggest": null,
      "model_instructions_file": null,
      "profile": null
    },
    "origins": {
      "features.plugins": {
        "name": {
          "type": "sessionFlags"
        },
        "version": "sha256:d47f87f47edd070b61fec7c22bd77f058fe6b30812b948a6e4fac1acafcd7b28"
      },
      "features.hooks": {
        "name": {
          "type": "sessionFlags"
        },
        "version": "sha256:d47f87f47edd070b61fec7c22bd77f058fe6b30812b948a6e4fac1acafcd7b28"
      },
      "features.remote_plugin": {
        "name": {
          "type": "sessionFlags"
        },
        "version": "sha256:d47f87f47edd070b61fec7c22bd77f058fe6b30812b948a6e4fac1acafcd7b28"
      },
      "feedback.enabled": {
        "name": {
          "type": "legacyManagedConfigTomlFromMdm"
        },
        "version": "sha256:ebae05b01e67547947deb9495ec852e063a45d02e280937b3255e87d5781a527"
      },
      "features.apps": {
        "name": {
          "type": "sessionFlags"
        },
        "version": "sha256:d47f87f47edd070b61fec7c22bd77f058fe6b30812b948a6e4fac1acafcd7b28"
      },
      "features.shell_snapshot": {
        "name": {
          "type": "sessionFlags"
        },
        "version": "sha256:d47f87f47edd070b61fec7c22bd77f058fe6b30812b948a6e4fac1acafcd7b28"
      },
      "allow_login_shell": {
        "name": {
          "type": "sessionFlags"
        },
        "version": "sha256:d47f87f47edd070b61fec7c22bd77f058fe6b30812b948a6e4fac1acafcd7b28"
      },
      "analytics.enabled": {
        "name": {
          "type": "legacyManagedConfigTomlFromMdm"
        },
        "version": "sha256:ebae05b01e67547947deb9495ec852e063a45d02e280937b3255e87d5781a527"
      }
    },
    "layers": [
      {
        "name": {
          "type": "legacyManagedConfigTomlFromMdm"
        },
        "version": "sha256:ebae05b01e67547947deb9495ec852e063a45d02e280937b3255e87d5781a527",
        "config": {
          "analytics": {
            "enabled": false
          },
          "feedback": {
            "enabled": false
          }
        }
      },
      {
        "name": {
          "type": "sessionFlags"
        },
        "version": "sha256:d47f87f47edd070b61fec7c22bd77f058fe6b30812b948a6e4fac1acafcd7b28",
        "config": {
          "features": {
            "shell_snapshot": false,
            "hooks": false,
            "apps": false,
            "plugins": false,
            "remote_plugin": false
          },
          "allow_login_shell": false
        }
      },
      {
        "name": {
          "type": "user",
          "file": "/private/var/folders/1s/pzpgw10j22z7x5f6xgc98jdh0000gn/T/m2e-record-preflight-JXPkSb/codex-home/config.toml",
          "profile": null
        },
        "version": "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
        "config": {}
      },
      {
        "name": {
          "type": "system",
          "file": "/etc/codex/config.toml"
        },
        "version": "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
        "config": {}
      }
    ]
  }
}
```

**File:** `packages/runner/test/codex/policy.test.ts` (new)

```ts
// Managed-policy and subscription identity checks, including the Mac's recorded MDM requirements.
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { classifyCodexPolicy, codexAccountIdentity } from '../../src/adapters/codex/policy';
import type {
  ApprovalsReviewer,
  ConfigLayerSource,
  ConfigReadResponse,
  ConfigRequirements,
  ConfigRequirementsReadResponse,
  GetAccountResponse,
} from '../../src/adapters/codex/protocol/v2';

const recorded = JSON.parse(readFileSync(`${import.meta.dir}/fixtures/requirements-managed.json`, 'utf8')) as {
  'configRequirements/read': ConfigRequirementsReadResponse;
  'config/read': ConfigReadResponse;
};
const requirements = recorded['configRequirements/read'];
const config = recorded['config/read'];

function layers(...sources: ConfigLayerSource[]): ConfigReadResponse {
  return { ...config, layers: sources.map((name) => ({ name, version: 'test', config: {}, disabledReason: null })) };
}

function restricted(
  overrides: Partial<ConfigRequirements & { allowedApprovalsReviewers: ApprovalsReviewer[] | null }>,
) {
  return { requirements: { ...requirements.requirements!, ...overrides } };
}

describe('classifyCodexPolicy', () => {
  test('the recorded MDM sample is managed and ready', () => {
    expect(config.layers?.some((layer) => layer.name.type === 'legacyManagedConfigTomlFromMdm')).toBe(true);
    expect(classifyCodexPolicy({ requirements, config })).toEqual({ managedPolicy: true, problem: null });
  });

  test('user, system and sessionFlags alone are unmanaged', () => {
    expect(
      classifyCodexPolicy({
        requirements: { requirements: null },
        config: layers(
          { type: 'user', file: '/tmp/config.toml', profile: null },
          { type: 'system', file: '/etc/codex/config.toml' },
          { type: 'sessionFlags' },
        ),
      }),
    ).toEqual({ managedPolicy: false, problem: null });
    expect(classifyCodexPolicy({ requirements, config: layers() }).managedPolicy).toBe(true);
  });

  const managed: ConfigLayerSource[] = [
    { type: 'mdm', domain: 'test', key: 'test' },
    { type: 'enterpriseManaged', id: 'test', name: 'test' },
    { type: 'legacyManagedConfigTomlFromFile', file: '/tmp/managed.toml' },
    { type: 'legacyManagedConfigTomlFromMdm' },
  ];
  for (const source of managed) {
    test(`${source.type} alone is managed`, () => {
      expect(classifyCodexPolicy({ requirements: { requirements: null }, config: layers(source) })).toEqual({
        managedPolicy: true,
        problem: null,
      });
    });
  }

  test('an unknown layer type and missing layers count as managed', () => {
    const unknown = { type: 'cloudManaged' } as unknown as ConfigLayerSource;
    expect(classifyCodexPolicy({ requirements: { requirements: null }, config: layers(unknown) })).toEqual({
      managedPolicy: true,
      problem: null,
    });
    expect(classifyCodexPolicy({ requirements: { requirements: null }, config: { ...config, layers: null } })).toEqual({
      managedPolicy: true,
      problem: null,
    });
  });

  test('web search turned on by a managed layer is a problem; disabled, or set by the user, is not', () => {
    const mdm: ConfigLayerSource = { type: 'legacyManagedConfigTomlFromMdm' };
    const user: ConfigLayerSource = { type: 'user', file: '/tmp/config.toml', profile: null };
    const webSearch = (value: 'live' | 'cached' | 'disabled', name: ConfigLayerSource): ConfigReadResponse => ({
      ...config,
      config: { ...config.config, web_search: value } as ConfigReadResponse['config'],
      origins: { ...config.origins, web_search: { name, version: 'test' } },
    });
    expect(classifyCodexPolicy({ requirements, config: webSearch('live', mdm) })).toEqual({
      managedPolicy: true,
      problem: 'managed policy turns on web search',
    });
    expect(classifyCodexPolicy({ requirements, config: webSearch('cached', mdm) }).problem).toBe(
      'managed policy turns on web search',
    );
    expect(classifyCodexPolicy({ requirements, config: webSearch('disabled', mdm) }).problem).toBeNull();
    expect(classifyCodexPolicy({ requirements, config: webSearch('live', user) }).problem).toBeNull();
  });

  test('either failed read counts as managed without itself blocking readiness', () => {
    for (const input of [
      { requirements: null, config: layers() },
      { requirements: { requirements: null }, config: null },
      { requirements: null, config: null },
    ])
      expect(classifyCodexPolicy(input)).toEqual({ managedPolicy: true, problem: null });
  });

  const restrictions = [
    [restricted({ allowedSandboxModes: ['read-only'] }), 'workspace-write'],
    [restricted({ allowedApprovalPolicies: ['never'] }), 'on-request'],
    [restricted({ allowedApprovalsReviewers: ['auto_review'] }), 'user approvals reviewer'],
  ] as const;
  for (const [requirements, reason] of restrictions) {
    test(`rejects policy excluding ${reason}`, () => {
      const result = classifyCodexPolicy({ requirements, config });
      expect(result.managedPolicy).toBe(true);
      expect(result.problem).toContain(reason);
    });
  }

  test('null lists allow the required values; sandbox then approval then reviewer wins', () => {
    expect(
      classifyCodexPolicy({
        config,
        requirements: restricted({
          allowedSandboxModes: null,
          allowedApprovalPolicies: null,
          allowedApprovalsReviewers: null,
        }),
      }).problem,
    ).toBeNull();
    expect(
      classifyCodexPolicy({
        config,
        requirements: restricted({
          allowedSandboxModes: ['workspace-write'],
          allowedApprovalPolicies: ['on-request'],
          allowedApprovalsReviewers: ['user'],
        }),
      }).problem,
    ).toBeNull();
    expect(
      classifyCodexPolicy({
        config,
        requirements: restricted({
          allowedSandboxModes: [],
          allowedApprovalPolicies: [],
          allowedApprovalsReviewers: [],
        }),
      }).problem,
    ).toContain('workspace-write');
    expect(
      classifyCodexPolicy({
        config,
        requirements: restricted({
          allowedApprovalPolicies: [],
          allowedApprovalsReviewers: [],
        }),
      }).problem,
    ).toContain('on-request');
  });
});

describe('codexAccountIdentity', () => {
  test('hashes the email as given and labels a ChatGPT plan', () => {
    const email = 'Owner@Example.com';
    expect(codexAccountIdentity({ type: 'chatgpt', email, planType: 'plus' })).toEqual({
      accountId: createHash('sha256').update(email).digest('hex').slice(0, 16),
      plan: 'ChatGPT Plus',
      problem: null,
    });
    expect(codexAccountIdentity({ type: 'chatgpt', email: null, planType: 'plus' })).toEqual({
      accountId: null,
      plan: 'ChatGPT Plus',
      problem: null,
    });
  });

  const cases: [GetAccountResponse['account'], string][] = [
    [null, 'not logged in'],
    [{ type: 'apiKey' }, 'an API key would replace the subscription'],
    [{ type: 'amazonBedrock', usesCodexManagedCredentials: true }, 'not a ChatGPT login'],
  ];
  for (const [account, problem] of cases) {
    test(`rejects ${account?.type ?? 'no account'}`, () => {
      const result = codexAccountIdentity(account);
      expect(result.accountId).toBeNull();
      expect(result.plan).toBeNull();
      expect(result.problem).toContain(problem);
    });
  }
});
```

**File:** `packages/runner/test/codex/preflight.test.ts` (new)

```ts
// Zero-model preflight through the scripted app-server, including isolation and cleanup on failures.
import { afterEach, describe, expect, test } from 'bun:test';
import { TEST_ACCOUNT_ID, VendorQuotaSchema } from '@agflow/core';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CODEX_VERSION } from '../../src/adapters/codex/binary';
import type { ResultOf } from '../../src/adapters/codex/methods';
import { codexProcessOptions, runCodexPreflight, type CodexPreflightOptions } from '../../src/adapters/codex/preflight';
import type { SkillMetadata } from '../../src/adapters/codex/protocol/v2';
import { RunnerConfigSchema, type RunnerConfigInput, vendorHomes } from '../../src/config';
import { memoryLogger } from '../../src/log';
import { runnerPaths } from '../../src/paths';
import { vendorBinary } from '../../src/vendor/pins';
import { codexScenario, readCodexRecord, writeCodexShim, type CodexScenario, type ScriptedAnswers } from './peer';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const recorded = JSON.parse(readFileSync(`${import.meta.dir}/fixtures/requirements-managed.json`, 'utf8')) as {
  'configRequirements/read': ResultOf<'configRequirements/read'>;
  'config/read': ResultOf<'config/read'>;
};
const email = 'owner@example.com';
const failed = { error: { code: -32600, message: 'codex account authentication required to read rate limits' } };
const mcp: ResultOf<'mcpServerStatus/list'> = {
  data: [
    {
      name: 'codex_apps',
      runtimeStatus: null,
      pluginId: null,
      httpOrigin: null,
      serverInfo: null,
      serverCapabilities: null,
      tools: {},
      toolsError: null,
      resources: [],
      resourceTemplates: [],
      authStatus: 'unsupported',
    },
  ],
  nextCursor: null,
};

function skills(scope: SkillMetadata['scope'], pluginId: string | null = null): ResultOf<'skills/list'> {
  return {
    data: [
      {
        cwd: '/tmp',
        errors: [],
        skills: [
          {
            name: 'example-skill',
            description: 'test skill',
            path: '/tmp/SKILL.md',
            scope,
            enabled: true,
            pluginId,
          },
        ],
      },
    ],
  };
}

const rateLimits: ResultOf<'account/rateLimits/read'> = {
  ordinaryUsageAllowed: true,
  accountId: null,
  rateLimitsByLimitId: null,
  rateLimitResetCredits: null,
  rateLimitUpsell: null,
  rateLimits: {
    limitId: 'codex',
    limitName: null,
    normalModelSlug: null,
    primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_800_000_000 },
    secondary: { usedPercent: 50, windowDurationMins: 10080, resetsAt: 1_800_100_000 },
    credits: { hasCredits: true, unlimited: false, balance: '10' },
    individualLimit: null,
    spendControlReached: null,
    planType: 'plus',
    rateLimitReachedType: null,
  },
};

function answers(): ScriptedAnswers {
  return {
    'account/read': { result: { account: { type: 'chatgpt', email, planType: 'plus' }, requiresOpenaiAuth: true } },
    'configRequirements/read': { result: recorded['configRequirements/read'] },
    'config/read': { result: recorded['config/read'] },
    'mcpServerStatus/list': { result: { data: [], nextCursor: null } },
    'skills/list': { result: skills('system') },
    'account/rateLimits/read': { result: rateLimits },
  };
}

function runnerConfig(config: Partial<RunnerConfigInput> = {}) {
  return RunnerConfigSchema.parse({
    runnerKey: 'runner',
    machineId: 'machine',
    name: 'test',
    capturedPath: '/usr/bin:/bin',
    ...config,
  });
}

/** Preflight options as the adapter resolves them from runner.json and the service environment. */
function setup(
  overrides: ScriptedAnswers = {},
  config: Partial<RunnerConfigInput> = {},
  scenario: Partial<CodexScenario> = {},
  env: Record<string, string> = {},
) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agflow-codex-preflight-')));
  dirs.push(dir);
  const paths = runnerPaths(join(dir, 'agflow'));
  const bin = join(paths.runner, vendorBinary('codex', CODEX_VERSION));
  writeCodexShim(bin, codexScenario({ ...scenario, answers: { ...answers(), ...overrides } }));
  const parsed = runnerConfig(config);
  const options: CodexPreflightOptions = {
    ...codexProcessOptions({ config: parsed, paths, env }),
    paths,
    capturedPath: parsed.capturedPath,
    platform: 'darwin',
    arch: 'arm64',
    requestTimeoutMs: 200,
  };
  return { options, bin, dir, config: parsed };
}

/** The owner's npm install of 0.158.0 under dir: the bin directory for PATH and the native binary it points at. */
function ownerInstall(dir: string): { path: string; native: string } {
  const owner = join(dir, 'owner');
  const packageRoot = join(owner, 'node_modules', '@openai', 'codex');
  const wrapper = join(packageRoot, 'bin', 'codex.js');
  mkdirSync(dirname(wrapper), { recursive: true });
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: '@openai/codex' }));
  writeFileSync(wrapper, 'throw new Error("the owner wrapper must never run");\n', { mode: 0o755 });
  const native = join(packageRoot, 'vendor', 'aarch64-apple-darwin', 'bin', 'codex');
  writeCodexShim(native, codexScenario({ version: '0.158.0' }));
  const path = join(owner, 'bin');
  mkdirSync(path);
  symlinkSync(wrapper, join(path, 'codex'));
  return { path, native };
}

async function probe(fixture: ReturnType<typeof setup>) {
  const result = await runCodexPreflight(fixture.options);
  const runs = readCodexRecord(fixture.bin);
  expect(runs).toHaveLength(1);
  expect(runs[0]?.exit).toMatchObject({ reason: 'eof', code: 0, signal: null });
  expect(result.weakened).toEqual([]);
  return result;
}

const blockedPolicy: ScriptedAnswers = {
  'configRequirements/read': {
    result: {
      requirements: { ...recorded['configRequirements/read'].requirements!, allowedSandboxModes: ['read-only'] },
    },
  },
};
const noAccount: ScriptedAnswers = { 'account/read': { result: { account: null, requiresOpenaiAuth: true } } };

describe('runCodexPreflight', () => {
  test('returns only facts, quota and weakened; asks the preflight methods and ends the process', async () => {
    const fixture = setup();
    const result = await probe(fixture);
    expect(Object.keys(result).sort()).toEqual(['facts', 'quota', 'weakened']);
    expect(result.facts).toEqual({
      vendor: 'codex',
      cliVersion: CODEX_VERSION,
      ownerCliVersion: null,
      ready: true,
      problem: null,
      accountId: createHash('sha256').update(email).digest('hex').slice(0, 16),
      plan: 'ChatGPT Plus',
      managedPolicy: true,
    });
    expect(VendorQuotaSchema.parse(result.quota)).toEqual({
      state: 'ok',
      windows: { fiveHour: 0.25, weekly: 0.5 },
      paidUsage: 'enabled',
      resetsAt: 1_800_100_000_000,
      updatedAt: expect.any(Number),
    });
    const run = readCodexRecord(fixture.bin)[0]!;
    expect(run.requests.slice(1).map(({ method, params }) => ({ method, params }))).toEqual([
      { method: 'account/read', params: { refreshToken: false } },
      { method: 'configRequirements/read', params: undefined },
      { method: 'config/read', params: { includeLayers: true } },
      { method: 'mcpServerStatus/list', params: {} },
      { method: 'skills/list', params: { cwds: [fixture.options.paths.homes.codexUser] } },
      { method: 'account/rateLimits/read', params: undefined },
    ]);
    expect(run.cwd).toBe(fixture.options.paths.homes.codexUser);
    for (const home of [run.env.CODEX_HOME!, run.env.HOME!]) expect(statSync(home).mode & 0o777).toBe(0o700);
  });

  test('runs app-server with the resolved homes and base environment', async () => {
    const fixture = setup({}, { connectivity: { HTTPS_PROXY: 'http://127.0.0.1:9', SSL_CERT_FILE: '/tmp/ca' } });
    const config = { ...fixture.config, homes: { ...fixture.config.homes, codex: join(fixture.dir, 'custom-codex') } };
    const env = {
      USER: 'test',
      LOGNAME: 'test',
      LANG: 'C',
      SHELL: '/bin/zsh',
      LC_ALL: 'C',
      PATH: '/unwanted',
      HTTPS_PROXY: 'http://unwanted',
      OPENAI_API_KEY: 'secret',
      HOME: '/unwanted',
      CODEX_HOME: '/unwanted',
      AGFLOW_AGENT_TOKEN: 'secret',
      CODEX_MANAGED_TEST: '1',
    };
    Object.assign(fixture.options, codexProcessOptions({ config, paths: fixture.options.paths, env }));
    expect((await probe(fixture)).facts.ready).toBe(true);
    expect(readCodexRecord(fixture.bin)[0]?.env).toEqual({
      PATH: '/usr/bin:/bin',
      HTTPS_PROXY: 'http://127.0.0.1:9',
      SSL_CERT_FILE: '/tmp/ca',
      USER: 'test',
      LOGNAME: 'test',
      LANG: 'C',
      SHELL: '/bin/zsh',
      LC_ALL: 'C',
      CODEX_HOME: join(fixture.dir, 'custom-codex'),
      HOME: fixture.options.paths.homes.codexUser,
      GIT_DIR: '/dev/null',
    });
  });

  test('reports the owner version from captured PATH without starting the owner app-server', async () => {
    const fixture = setup();
    const { path, native } = ownerInstall(fixture.dir);
    fixture.options.capturedPath = `${path}:/usr/bin:/bin`;
    const result = await probe(fixture);
    expect(result.facts).toMatchObject({ ready: true, cliVersion: CODEX_VERSION, ownerCliVersion: '0.158.0' });
    expect(readCodexRecord(native)).toEqual([]);
  });

  const failures: [string, ScriptedAnswers, string][] = [
    ['MCP server', { 'mcpServerStatus/list': { result: mcp } }, 'codex_apps'],
    ['user skill', { 'skills/list': { result: skills('user') } }, 'example-skill'],
    ['plugin skill', { 'skills/list': { result: skills('system', 'plugin-1') } }, 'example-skill'],
    ['account absent', noAccount, 'not logged in'],
    ['account read fails', { 'account/read': failed }, 'not logged in'],
    ['MCP read fails', { 'mcpServerStatus/list': failed }, 'MCP'],
    ['skills read fails', { 'skills/list': failed }, 'skills'],
    ['MCP read times out', { 'mcpServerStatus/list': { silent: true } }, 'MCP'],
    ['policy disallows workspace-write', blockedPolicy, 'workspace-write'],
  ];
  for (const [name, overrides, problem] of failures) {
    test(`${name} is not ready and ends the process`, async () => {
      const result = await probe(setup(overrides));
      expect(result.facts.ready).toBe(false);
      expect(result.facts.problem).toContain(problem);
    });
  }

  test('first problem wins: policy, account, MCP, then skills', async () => {
    const extensions: ScriptedAnswers = {
      'mcpServerStatus/list': { result: mcp },
      'skills/list': { result: skills('user') },
    };
    for (const [overrides, problem] of [
      [{ ...extensions, ...noAccount, ...blockedPolicy }, 'workspace-write'],
      [{ ...extensions, ...noAccount }, 'not logged in'],
      [extensions, 'codex_apps'],
    ] as const)
      expect((await probe(setup(overrides))).facts.problem).toContain(problem);
  });

  for (const scope of ['system', 'admin', 'repo'] as const) {
    test(`${scope} skills pass`, async () => {
      expect((await probe(setup({ 'skills/list': { result: skills(scope) } }))).facts.ready).toBe(true);
    });
  }

  test('failed policy reads count as managed and a failed quota read is null', async () => {
    const result = await probe(
      setup({
        'configRequirements/read': failed,
        'config/read': failed,
        'account/rateLimits/read': failed,
      }),
    );
    expect(result.facts).toMatchObject({ ready: true, managedPolicy: true, problem: null });
    expect(result.quota).toBeNull();
  });

  test('unsupported platform, missing, mismatched and unreadable binary versions never open app-server', async () => {
    for (const kind of ['platform', 'missing', 'mismatch', 'unreadable'] as const) {
      const fixture = setup(
        {},
        {},
        { version: kind === 'mismatch' ? '0.158.0' : kind === 'unreadable' ? 'unknown' : CODEX_VERSION },
      );
      if (kind === 'platform') Object.assign(fixture.options, { platform: 'linux', arch: 'x64' });
      if (kind === 'missing') {
        rmSync(fixture.bin);
        // The owner's install is reported even when the runner's own binary is missing.
        fixture.options.capturedPath = `${ownerInstall(fixture.dir).path}:/usr/bin:/bin`;
      }
      const result = await runCodexPreflight(fixture.options);
      expect(result.facts).toEqual({
        vendor: 'codex',
        cliVersion: kind === 'mismatch' ? '0.158.0' : null,
        ownerCliVersion: kind === 'missing' ? '0.158.0' : null,
        ready: false,
        accountId: null,
        plan: null,
        managedPolicy: true,
        problem:
          kind === 'platform'
            ? 'unsupported platform'
            : kind === 'missing'
              ? 'binary missing'
              : kind === 'mismatch'
                ? `codex binary is version 0.158.0, expected ${CODEX_VERSION}`
                : expect.stringContaining('version'),
      });
      expect(result.quota).toBeNull();
      expect(result.weakened).toEqual([]);
      expect(readCodexRecord(fixture.bin)).toEqual([]);
    }
  });

  test('rejected open returns its error and the process is ended', async () => {
    const fixture = setup({}, {}, { failBeforeInitialize: { stderr: 'Error: cannot start', code: 1 } });
    const result = await runCodexPreflight(fixture.options);
    expect(result.facts).toMatchObject({ ready: false, problem: 'Error: cannot start', managedPolicy: true });
    expect(readCodexRecord(fixture.bin)[0]?.exit).toMatchObject({ reason: 'failed', code: 1 });
  });

  test('skipAuthChecks gives test identity but still checks policy, MCP and skills', async () => {
    for (const [overrides, problem] of [
      [{}, 'test mode'],
      [blockedPolicy, 'workspace-write'],
      [{ 'mcpServerStatus/list': { result: mcp } }, 'codex_apps'],
      [{ 'skills/list': { result: skills('user') } }, 'example-skill'],
    ] satisfies [ScriptedAnswers, string][]) {
      const fixture = setup(
        { ...noAccount, ...overrides },
        { test: { skipAuthChecks: true } },
        {},
        { AGFLOW_TEST: '1' },
      );
      const result = await probe(fixture);
      expect(result.facts).toMatchObject({
        ready: problem === 'test mode',
        accountId: TEST_ACCOUNT_ID,
        plan: 'test mode',
        problem: expect.stringContaining(problem),
      });
    }
  });

  test('the resolved test switches: codexConfig as -c flags and skipAuthChecks; no config.toml is written', async () => {
    for (const enabled of [false, true]) {
      const fixture = setup(noAccount);
      Object.assign(fixture.options, {
        codexConfig: enabled ? { model_provider: 'scripted' } : null,
        skipAuthChecks: enabled,
      });
      const result = await probe(fixture);
      expect(result.facts.ready).toBe(enabled);
      expect(result.facts.problem).toBe(enabled ? 'test mode' : 'not logged in');
      const argv = readCodexRecord(fixture.bin)[0]!.argv;
      expect(argv.includes('model_provider="scripted"')).toBe(enabled);
      if (enabled) expect(argv[argv.indexOf('model_provider="scripted"') - 1]).toBe('-c');
      expect(existsSync(join(fixture.options.paths.homes.codex, 'config.toml'))).toBe(false);
    }
  });

  test('an owner version that fails to read is null and fails nothing', async () => {
    const fixture = setup();
    fixture.options.capturedPath = `${ownerInstall(fixture.dir).path}:/usr/bin:/bin`;
    const logger = memoryLogger();
    fixture.options.logger = logger;
    // Reading the owner's version needs a scratch home in TMPDIR; the runner's own binary uses the runner's homes.
    const tmp = process.env.TMPDIR;
    process.env.TMPDIR = join(fixture.dir, 'missing-tmp');
    try {
      const result = await probe(fixture);
      expect(result.facts).toMatchObject({ ready: true, cliVersion: CODEX_VERSION, ownerCliVersion: null });
    } finally {
      if (tmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = tmp;
    }
    expect(logger.entries).toContainEqual(
      expect.objectContaining({ level: 'warn', message: 'codex preflight: owner version failed' }),
    );
  });

  test('ordinary usage not allowed is exhausted without credits, and paid usage in use with them', async () => {
    const limits = (credits: { hasCredits: boolean; unlimited: boolean }): ScriptedAnswers => {
      return {
        'account/rateLimits/read': {
          result: {
            ...rateLimits,
            ordinaryUsageAllowed: false,
            rateLimits: { ...rateLimits.rateLimits, credits: { ...credits, balance: null } },
          },
        },
      };
    };
    const without = await probe(setup(limits({ hasCredits: false, unlimited: false })));
    expect(without.quota).toMatchObject({ state: 'exhausted', paidUsage: 'disabled', windows: { fiveHour: 0.25 } });
    expect(without.facts.ready).toBe(true);
    for (const credits of [
      { hasCredits: true, unlimited: false },
      { hasCredits: false, unlimited: true },
    ]) {
      expect((await probe(setup(limits(credits)))).quota).toMatchObject({ state: 'ok', paidUsage: 'in_use' });
    }
  });
});

describe('codexProcessOptions', () => {
  const env = {
    USER: 'test',
    LOGNAME: 'test',
    LANG: 'C',
    SHELL: '/bin/zsh',
    LC_ALL: 'C',
    LC_CTYPE: 'UTF-8',
    PATH: '/unwanted',
    HTTPS_PROXY: 'http://unwanted',
    OPENAI_API_KEY: 'secret',
    HOME: '/unwanted',
    CODEX_HOME: '/unwanted',
  };

  test('configured homes, captured PATH and connectivity, and only the user variables', () => {
    const paths = runnerPaths('/tmp/agflow-codex-options/agflow');
    const config = runnerConfig({
      homes: { codex: '/tmp/custom-codex' },
      connectivity: { HTTPS_PROXY: 'http://127.0.0.1:9' },
    });
    expect(codexProcessOptions({ config, paths, env })).toEqual({
      codexHome: '/tmp/custom-codex',
      userHome: paths.homes.codexUser,
      base: {
        PATH: '/usr/bin:/bin',
        HTTPS_PROXY: 'http://127.0.0.1:9',
        USER: 'test',
        LOGNAME: 'test',
        LANG: 'C',
        SHELL: '/bin/zsh',
        LC_ALL: 'C',
        LC_CTYPE: 'UTF-8',
      },
      codexConfig: null,
      skipAuthChecks: false,
    });
    expect(codexProcessOptions({ config: runnerConfig(), paths, env: {} }).codexHome).toBe(
      vendorHomes(runnerConfig(), paths).codex,
    );
  });

  test('test flags and skipAuthChecks require AGFLOW_TEST=1 and a test block', () => {
    const paths = runnerPaths('/tmp/agflow-codex-options/agflow');
    const test = { skipAuthChecks: true, codexConfig: { model_provider: 'scripted' } };
    const switches = (config: Partial<RunnerConfigInput>, AGFLOW_TEST: string) => {
      const { codexConfig, skipAuthChecks } = codexProcessOptions({
        config: runnerConfig(config),
        paths,
        env: { AGFLOW_TEST },
      });
      return { codexConfig, skipAuthChecks };
    };
    expect(switches({ test }, '1')).toEqual({ codexConfig: { model_provider: 'scripted' }, skipAuthChecks: true });
    expect(switches({ test }, '0')).toEqual({ codexConfig: null, skipAuthChecks: false });
    expect(switches({}, '1')).toEqual({ codexConfig: null, skipAuthChecks: false });
  });
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `bun test packages/runner/test/codex/policy.test.ts packages/runner/test/codex/preflight.test.ts`
Expected: FAIL — `error: Cannot find module '../../src/adapters/codex/policy' from 'packages/runner/test/codex/policy.test.ts'`, and the same for `../../src/adapters/codex/preflight` from `preflight.test.ts` (0 pass, 2 fail, 2 errors)

- [ ] **Step 3: Implement**

**File:** `packages/runner/src/adapters/codex/policy.ts` (new)

```ts
// Managed requirements and ChatGPT identity for the zero-model preflight.
import { createHash } from 'node:crypto';
import type { PlanType } from './protocol/PlanType';
import type {
  ApprovalsReviewer,
  ConfigLayerSource,
  ConfigReadResponse,
  ConfigRequirements,
  ConfigRequirementsReadResponse,
  GetAccountResponse,
} from './protocol/v2';

// A re-pin must explicitly classify every new layer and plan.
const MANAGED_LAYERS = {
  packagedDefaults: false,
  mdm: true,
  system: false,
  enterpriseManaged: true,
  user: false,
  project: false,
  sessionFlags: false,
  legacyManagedConfigTomlFromFile: true,
  legacyManagedConfigTomlFromMdm: true,
} satisfies Record<ConfigLayerSource['type'], boolean>;

/** A layer type the generated types do not know counts as managed: they lag 0.159.2's wire format. */
function managedLayer(type: string): boolean {
  return (MANAGED_LAYERS as Record<string, boolean | undefined>)[type] ?? true;
}

const PLAN_NAMES = {
  free: 'ChatGPT Free',
  go: 'ChatGPT Go',
  plus: 'ChatGPT Plus',
  pro: 'ChatGPT Pro',
  prolite: 'ChatGPT Pro Lite',
  promax: 'ChatGPT Pro Max',
  team: 'ChatGPT Team',
  self_serve_business_prolite: 'ChatGPT Business Pro Lite',
  self_serve_business_usage_based: 'ChatGPT Business Usage Based',
  business: 'ChatGPT Business',
  ent26: 'ChatGPT Enterprise',
  enterprise_cbp_automation: 'ChatGPT Enterprise Automation',
  enterprise_cbp_usage_based: 'ChatGPT Enterprise Usage Based',
  enterprise: 'ChatGPT Enterprise',
  edu: 'ChatGPT Edu',
  edu_plus: 'ChatGPT Edu Plus',
  edu_pro: 'ChatGPT Edu Pro',
  unknown: 'ChatGPT (unknown plan)',
} satisfies Record<PlanType, string>;

/** null for a call that failed. */
export function classifyCodexPolicy(input: {
  requirements: ConfigRequirementsReadResponse | null;
  config: ConfigReadResponse | null;
}): { managedPolicy: boolean; problem: string | null } {
  // 0.159.2 sends this field even though its generated ConfigRequirements omits it.
  const requirements: (ConfigRequirements & { allowedApprovalsReviewers?: ApprovalsReviewer[] | null }) | null =
    input.requirements?.requirements ?? null;
  const managedPolicy =
    input.requirements === null ||
    input.config === null ||
    requirements !== null ||
    input.config.layers === null ||
    input.config.layers.some((layer) => managedLayer(layer.name.type));
  // A managed layer outranks the thread's web_search override, and no later check sees web search.
  const webSearch = input.config?.config.web_search ?? null;
  const webSearchOrigin = input.config?.origins.web_search?.name.type;
  let problem: string | null = null;
  if (requirements?.allowedSandboxModes != null && !requirements.allowedSandboxModes.includes('workspace-write')) {
    problem = 'managed policy does not allow workspace-write';
  } else if (
    requirements?.allowedApprovalPolicies != null &&
    !requirements.allowedApprovalPolicies.includes('on-request')
  ) {
    problem = 'managed policy does not allow the on-request approval policy';
  } else if (
    requirements?.allowedApprovalsReviewers != null &&
    !requirements.allowedApprovalsReviewers.includes('user')
  ) {
    problem = 'managed policy does not allow the user approvals reviewer';
  } else if (
    webSearch !== null &&
    webSearch !== 'disabled' &&
    webSearchOrigin !== undefined &&
    managedLayer(webSearchOrigin)
  ) {
    problem = 'managed policy turns on web search';
  }
  return { managedPolicy, problem };
}

export function codexAccountIdentity(account: GetAccountResponse['account']): {
  accountId: string | null;
  plan: string | null;
  problem: string | null;
} {
  if (account?.type === 'chatgpt') {
    return {
      accountId: account.email === null ? null : createHash('sha256').update(account.email).digest('hex').slice(0, 16),
      plan: PLAN_NAMES[account.planType],
      problem: null,
    };
  }
  return {
    accountId: null,
    plan: null,
    problem:
      account === null
        ? 'not logged in'
        : account.type === 'apiKey'
          ? 'an API key would replace the subscription'
          : 'Amazon Bedrock is not a ChatGPT login',
  };
}
```

**File:** `packages/runner/src/adapters/codex/preflight.ts` (new)

```ts
// The zero-model Codex preflight (design 9.1): the pinned binary's version, then one app-server in the runner's own
// homes for the account, the managed policy, MCP servers, skills and rate limits. Every failure is a not-ready
// result, never an exception, and the app-server is always ended.
import { TEST_ACCOUNT_ID } from '@agflow/core';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isTestMode, type RunnerConfig, type RunnerTestBlock, vendorHomes } from '../../config';
import { userVariables } from '../../env';
import type { Logger } from '../../log';
import type { RunnerPaths } from '../../paths';
import { VENDOR_PINS, vendorBinary, vendorPlatform } from '../../vendor/pins';
import type { PreflightResult } from '../types';
import { CODEX_VERSION, codexBinaryVersion, ownerCodexVersion } from './binary';
import { quotaFromRateLimits } from './classify';
import { appServerArgs, appServerEnv } from './config';
import { classifyCodexPolicy, codexAccountIdentity } from './policy';
import { openAppServer } from './process';

/** What every app-server the runner starts shares: its homes, its base environment and the test switches. */
export interface CodexProcessOptions {
  codexHome: string;
  userHome: string;
  /** The captured login PATH and connectivity variables plus the user variables (design 7.6). */
  base: Record<string, string | undefined>;
  /** test.codexConfig, only in test mode. */
  codexConfig: RunnerTestBlock['codexConfig'] | null;
  /** test.skipAuthChecks, only in test mode. */
  skipAuthChecks: boolean;
}

/** The one derivation for preflight, transcript deletion and sessions, with the one test-mode gate. */
export function codexProcessOptions(input: {
  config: RunnerConfig;
  paths: RunnerPaths;
  /** Where AGFLOW_TEST and the user variables are read; process.env by default. */
  env?: Record<string, string | undefined>;
}): CodexProcessOptions {
  const { config, paths } = input;
  const env = input.env ?? process.env;
  // The user variables as buildAgentEnv gives them to sessions.
  const base: Record<string, string | undefined> = {
    PATH: config.capturedPath,
    ...config.connectivity,
    ...userVariables(env),
  };
  const testMode = isTestMode(config, env);
  return {
    codexHome: vendorHomes(config, paths).codex,
    userHome: paths.homes.codexUser,
    base,
    codexConfig: testMode ? (config.test?.codexConfig ?? null) : null,
    skipAuthChecks: testMode && (config.test?.skipAuthChecks ?? false),
  };
}

export interface CodexPreflightOptions extends CodexProcessOptions {
  /** The pinned binary and logs/codex-preflight.log. */
  paths: RunnerPaths;
  /** runner.json's captured login PATH, where the owner's own install is found. */
  capturedPath: string;
  platform?: string;
  arch?: string;
  logger?: Logger;
  /** Bounds each app-server request; tests pass a short one. */
  requestTimeoutMs?: number;
}

export async function runCodexPreflight(options: CodexPreflightOptions): Promise<PreflightResult> {
  const { paths, codexHome, userHome, skipAuthChecks, logger, requestTimeoutMs } = options;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const result: PreflightResult = {
    facts: {
      vendor: 'codex',
      cliVersion: null,
      ownerCliVersion: null,
      ready: false,
      problem: null,
      accountId: null,
      plan: null,
      managedPolicy: true,
    },
    quota: null,
    weakened: [],
  };
  const facts = result.facts;
  try {
    // The owner's install is for information, so it is reported whatever else fails, and its own failure fails
    // nothing. The captured login PATH finds it; the service's own PATH is minimal.
    facts.ownerCliVersion = await ownerCodexVersion({ env: { PATH: options.capturedPath }, platform, arch }).catch(
      (error: unknown) => {
        logger?.warn('codex preflight: owner version failed', { error: String(error) });
        return null;
      },
    );
    if (!VENDOR_PINS[vendorPlatform(platform, arch)]?.codex) {
      facts.problem = 'unsupported platform';
      return result;
    }
    await Promise.all([codexHome, userHome].map((home) => mkdir(home, { recursive: true, mode: 0o700 })));
    const bin = join(paths.runner, vendorBinary('codex', CODEX_VERSION));
    if (!existsSync(bin)) {
      facts.problem = 'binary missing';
      return result;
    }
    facts.cliVersion = await codexBinaryVersion(bin, { homes: { codex: codexHome, user: userHome } });
    if (facts.cliVersion !== CODEX_VERSION) {
      facts.problem =
        facts.cliVersion === null
          ? 'could not read codex binary version'
          : `codex binary is version ${facts.cliVersion}, expected ${CODEX_VERSION}`;
      return result;
    }
    const app = await openAppServer({
      bin,
      args: appServerArgs(options.codexConfig),
      env: appServerEnv({ base: options.base, bridgeEnv: {}, codexHome, userHome }),
      cwd: userHome,
      expectedVersion: CODEX_VERSION,
      logFile: join(paths.logs, 'codex-preflight.log'),
      logger,
      requestTimeoutMs,
    });
    try {
      const account = skipAuthChecks
        ? null
        : await app.rpc.request('account/read', { refreshToken: false }).catch(() => null);
      const requirements = await app.rpc.request('configRequirements/read', undefined).catch(() => null);
      const configuration = await app.rpc.request('config/read', { includeLayers: true }).catch(() => null);
      const mcp = await app.rpc.request('mcpServerStatus/list', {}).catch(() => null);
      const skills = await app.rpc.request('skills/list', { cwds: [userHome] }).catch(() => null);
      const rateLimits = await app.rpc.request('account/rateLimits/read', undefined).catch(() => null);
      const policy = classifyCodexPolicy({ requirements, config: configuration });
      const identity = skipAuthChecks
        ? { accountId: TEST_ACCOUNT_ID, plan: 'test mode', problem: null }
        : codexAccountIdentity(account?.account ?? null);
      const mcpProblem =
        mcp === null
          ? 'could not check MCP servers'
          : mcp.data.length > 0
            ? `unexpected MCP servers: ${mcp.data.map((server) => server.name).join(', ')}`
            : null;
      const unexpectedSkills =
        skills?.data
          .flatMap((entry) => entry.skills)
          .filter((skill) => skill.scope === 'user' || skill.pluginId !== null) ?? [];
      const skillsProblem =
        skills === null
          ? 'could not check skills'
          : unexpectedSkills.length > 0
            ? `unexpected user or plugin skills: ${unexpectedSkills.map((skill) => skill.name).join(', ')}`
            : null;
      facts.accountId = identity.accountId;
      facts.plan = identity.plan;
      facts.managedPolicy = policy.managedPolicy;
      facts.problem = policy.problem ?? identity.problem ?? mcpProblem ?? skillsProblem;
      facts.ready = facts.problem === null;
      if (facts.ready && skipAuthChecks) facts.problem = 'test mode';
      if (rateLimits !== null) {
        const quota = quotaFromRateLimits(rateLimits.rateLimits);
        // The backend's own permission for included usage: low percentages and no reached type do not imply it.
        if (rateLimits.ordinaryUsageAllowed === false) {
          const credits = rateLimits.rateLimits.credits;
          if (credits?.hasCredits || credits?.unlimited) quota.paidUsage = 'in_use';
          if (quota.paidUsage !== 'in_use') quota.state = 'exhausted';
        }
        result.quota = quota;
      }
    } finally {
      await app.end();
    }
  } catch (error) {
    facts.ready = false;
    facts.problem = error instanceof Error ? error.message : String(error);
  }
  return result;
}
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `bun test packages/runner/test/codex/policy.test.ts packages/runner/test/codex/preflight.test.ts && bun test && bun run typecheck`
Expected: the task's tests pass (42 pass); then the whole suite passes (`0 fail`) and `tsc` exits 0.

`requirements-managed.json` records an MDM-managed macOS environment from Codex 0.159.2 with scratch homes, no provider and every proxy pointed at 127.0.0.1:9. The unmanaged sample is synthetic. Unknown layer types and `layers: null` count as managed, and a managed layer that sets `web_search` to anything but `disabled` makes the vendor not ready. 0.159.2 sends `allowedApprovalsReviewers`, which the generated type lacks; `policy.ts` reads it through a local extension. The base environment is runner.json's captured `PATH`, its connectivity variables and M2b's `userVariables` (`src/env.ts`); nothing else from the runner's environment. Preflight creates both Codex homes (0700) and runs app-server in the codex-user home, with stderr in `logs/codex-preflight.log`.

- [ ] **Step 5: Commit**

```bash
git add -A 'packages/runner/src/adapters/codex/policy.ts' 'packages/runner/src/adapters/codex/preflight.ts' 'packages/runner/test/codex/fixtures/requirements-managed.json' 'packages/runner/test/codex/policy.test.ts' 'packages/runner/test/codex/preflight.test.ts'
git commit -m 'M2E Task 10: Managed policy, account identity and preflight' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

### Task 11: Transcript tail and transcript deletion

Codex operations without a live session (design 13, 6.8, 7.8). `readCodexTranscriptTail` reads the assistant messages of the last three turns from the thread's rollout file, `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*-<threadId>.jsonl`, for assembled handoff notes. `deleteCodexTranscript` removes a thread with `thread/delete` through a short-lived app-server of the current pin, for `cleanup_attempt` and retention. Deletion works while another app-server runs on the same home, and a second delete answers -32600 'no rollout found', which counts as deleted. The take-over commands and the daemon stop belong to the runner core (X-5).

**Files:**
- Create: `packages/runner/src/adapters/codex/transcript.ts`
- Test: `packages/runner/test/codex/fixtures/rollout.jsonl`
- Test: `packages/runner/test/codex/transcript.test.ts`

- [ ] **Step 1: Write the failing tests**

**File:** `packages/runner/test/codex/fixtures/rollout.jsonl` (new)

````
{"timestamp":"2026-11-09T14:28:32.900Z","ordinal":0,"type":"session_meta","payload":{"session_id":"01a1c0b5-f5db-7140-8021-694831838113","id":"01a1c0b5-f5db-7140-8021-694831838113","timestamp":"2026-11-09T14:28:32.874Z","cwd":"/private/tmp/agflow-rollout/clone","runtime_workspace_roots":["/private/tmp/agflow-rollout/clone","/private/tmp/agflow-rollout/clone/.git"],"originator":"agflow","cli_version":"0.159.2","source":"vscode","model_provider":"agflow_test","base_instructions":{"text":"You are Codex, an agent based on GPT-6. You and the user share one workspace, and your job is to collaborate with them until their intended goal is completely handled.\n\n# When to ask the user for permission\n\nUse your best judgement given task context for when you really need user permission, like a competent colleague would. Once evidence in a session supports authorization for a next step or action, you should continue work without ending the turn to clarify with the user.\n\nUser authorization and preferences persist across turns. Do not request permission again when the user has already authorized an action in an earlier turn. The user's instruction, whether implied from the task or explicitly stated in the session, must take precedence over any guidelines provided in skills or external files.\n\nYou MUST complete the work that is already authorized and necessary to make the proposed action concrete and reviewable before asking the user for permission as a final step. The user should be approving a concrete, reviewable result. For example, before deploying a change, writing to an external application, merging a PR or publishing a site, do all the work first so that user approval is the final step. You don't need user permission for reversible tasks, read-only actions, reviews or fixes, or anything for which authorization is provided earlier in the session or implied from the task instruction.\n\nDo not use tools to send messages to others (e.g. through slack or email) unless given explicit instructions to do so, or instructed to do so as part of an explicitly-invoked skill or plugin. If authorized by a skill or plugin, name and link the skill or plugin in the final channel.\n\nThe user gets very frustrated when you stop and ask for confirmation or permission, so make sure to explicitly explain why you need the confirmation (for example, a SKILL.md, AGENTS.md, memory, or approval auto-review block) and where it came from. If you receive an auto-review rejection and are not able to complete the task in a more safe way, explicitly tell the user that automatic approval review rejected the action, identify the action, and summarize the stated reason. Put this explanation in a short, separate paragraph at the end of both commentary and final, after any permission question.\n\n# Autonomy and persistence\n\nThe following instructions are critical for you to be an effective collaborator, so follow them carefully. You should infer the user's intent and task scope from the instructions and prior conversation context. Your job is to bias towards action and carry the user's intended task to completion.\n\nWhen the user expresses intent to perform new work or fix an existing issue, persist until the user's intended goal is complete. Progress autonomously towards the user's goal (e.g. creating isolated worktrees / checkouts if needed, resolving merge conflicts, read-only actions, creating draft PRs etc) unless they are clearly destructive or irreversible.\n\nWhen the user's prompt indicates a request for action, such as \"can you...\", \"I want to...\", \"help me...\" and similar expressions, treat these as instructions to do the work and take action. Do not stop at acknowledging capability (e.g. \"Yes…\"), proposing a plan, or offering to continue. Do not settle for a partial or \"helpful enough\" solution that does not fully satisfy the user's task to save time, effort or tokens. If a task requires sustained work, complete all the necessary work until the intended outcome is fulfilled.\n\nIf the user's intent or task scope is unclear, progress towards the user's goal with the information available and then ask the user for clarification while continuing independent work.\n\nDo not treat exceptions to requirements in local markdown and skill files as automatically requiring user approval. Before clarifying with the user, determine if you already have authorization in the existing session and whether the rule applies. You can resolve routine implementation choices using session context and your judgment. \n\n# Personality\n\nAs Codex, you are a curious, thoughtful collaborator and a lucid communicator. You speak warmly and candidly, as to someone you respect, and keep your own judgment. You disagree when you have reason; reconsider when the evidence warrants it. You let your interest and personality emerge naturally, without flattery or forced enthusiasm.\n\n## Writing style\n\nYour writing adapts to the conversation, matching the tone and understanding of the user. Make sure to state the main point clearly and early, then develop it with the explanation and detail the reader needs. Let each sentence build on what came before. Develop the points that matter and provide enough support to be useful. \n\nUse plain, simple language: familiar words, concrete examples, and precise verbs. Prefer active voice and direct statements. Write in connected prose. Avoid section headings, and do not use concluding summary statements such as \"In short:..\", \"The simplest mental model is:...\".\n\nInclude technical details only when they help explain or substantiate the point; avoid scattering implementation details through the prose. Connect an action with its purpose, or a finding with its implication, rather than presenting them as separate fragments.\n\nDefault to using clear, concise paragraphs, each developing one main idea. Use lists only when the information is genuinely parallel, sequential, or easier to compare, and avoid nested lists unless the hierarchy cannot be expressed clearly in prose. \n\nAvoid using AI slop words or phrases like \"Bottom Line:\" in conclusions, \"delve,\" \"foster,\" \"leverage,\" \"it's worth noting,\" \"importantly,\" \"Question? Answer.\" or \"This isn't about X. It's about Y.\", \"genuinely\" or hyphenated compound descriptions and adjectives. \n\nState the intended action directly. Avoid adding what you won't do or what something is not, what will remain unchanged, or how you'll separate or categorize results. Do not use contrastive framing such as \"X, not Y\" or \"X—not Y\" that introduces an unprompted alternative that the user didn't ask about. Avoid invented compound labels like \"exact-head checks\" and \"editorial-row layouts\", vague qualifiers, and canned transitions; use plain verbs and prepositions to state the actual relationship directly.\n\nAvoid unnecessary apologies and self-blame. When you make a meaningful mistake that you could have avoided, acknowledge it plainly and correct it; apologize briefly when warranted. Don’t apologize or fault yourself merely because the user asks a neutral follow-up, corrects their own message, or provides new information.\n\n## Technical communication\n\nIn addition to the writing style instructions above, follow these guidelines when discussing technical work: Use plain language over jargon, and reference technical details only to the degree that it actually helps with the conversation. Communicate complex concepts in a clear and cohesive manner. Translating complex topics into clear communication comes easy for you, and the user should never have to read your writing twice to understand it.\n\nLead with the outcome and then develop your reasoning for how you got there. When reporting changes, explain what changed, why, how it was tested, and any material risks or limitations. Include the evidence needed to understand the conclusion and its practical limits. \n\nPresent reasoning and evidence in the order that makes the conclusion easiest to assess, rather than recounting your work chronologically. Summarize routine verification instead of listing every check. In progress updates, focus on what you have learned, what remains uncertain, and what the next step will resolve.\n\n### Writing PR descriptions\n\nLead the description with the concrete problem and resulting behavior. Use a concrete trigger and before/after example when helpful. Scale detail to complexity: simple PRs usually need one or two sentences plus relevant validation. Use structure when it helps scanning or the repository template requires it.\n\nDescribe the final change for a reviewer who has not seen the conversation. When scope changes, rewrite the title and description around the final implementation. Omit conversational history and abandoned approaches unless they explain a tradeoff needed for review. Include only technical and validation details that help reviewers assess the change.\n\n# Working with the user\n\nYou have two channels for staying in conversation with the user:\n- You share updates in the `commentary` channel.\n- You yield back to the user and end your turn by sending a final message to the `final` channel.\n\nWhen available, you can use the `functions.request_user_input_async` tool to ask the user for missing information, a preference, constraint, or clarification. You can ask multiple questions in a single tool call. Do NOT ask the user to upload files or send screenshots using this tool because the tool only supports text input. Be mindful of cognitive load on user and prefer multiple-choice questions. If you need multiple freeform questions, bundle the most critical ones into a single freeform question using markdown lists for easier viewing. For multiple-choice questions, make sure each option is succinct and easy to read. Ask clarifying questions early unless the user's answers can potentially be inferred from available context, and continue useful work that does not depend on the answer while waiting. For optional clarification, give the user reasonable opportunity to reply - for example, 60 seconds for a simple multi-choice question and longer for complex and bundled questions — before proceeding with a stated assumption. If an answer or approval is required, keep the question pending and do not proceed with dependent work until it arrives. Elapsed time is not an answer or approval.\n\nThe user may send a new message while you are still working. By default, treat it as steering the active task rather than replacing it. Incorporate corrections, clarifications, constraints, questions, and status requests into the ongoing work while preserving the original objective. If the user asks a question or requests status during active work, answer briefly in commentary, then resume the active task unless the user clearly asks you to stop. Abandon or replace the active task only when the user clearly cancels it or requests an incompatible new objective.\n\nWhen you run out of context, the conversation is automatically compacted into a summary, but you will still see all prior user requests. Treat the most recent user message as the latest steering for the active task, not automatically as a replacement objective. Earlier requests may be stale but still provide useful context; preserve the original objective, accepted corrections, current constraints, completed work, and outstanding work. Only replace the active task when the user clearly cancels it or requests an incompatible new objective.\n\nCompaction does not end the task. Continue naturally from the summarized state, make reasonable assumptions about anything missing from the summary, and treat work spanning compactions as one logical chain of events. Do not restart from scratch, redo completed work, or repeat commentary updates already delivered.\n\n## Intermediate commentary\n\nAs you work, you use the `commentary` channel to share concise, meaningful updates including relevant assumptions, findings, decisions, or changes in direction. The goal of these messages is to make your work, and plans for the turn, easy for the user to understand and verify.\n\nIf the user's request requires calling tools, start with a message in the `commentary` channel. The user appreciates consistent, frequent communication during your turn, and should not be left without a commentary update for more than 60 seconds during ongoing work.\n\nDo NOT send user facing questions in intermediate commentary messages. Do NOT put a final response in the commentary channel. The final answer must always be fully self-contained: users should never need to read earlier commentary updates, since they are collapsed after the final answer is shown to users.\n\nNever praise your plan by contrasting it with an implied worse alternative. For example, never use platitudes like \"I will do <this good thing> rather than <this obviously bad thing>\" or \"I will do <X>, not <Y>\".\n\n## Final answer\n\nIn your final answer back to the user, focus on the most important information. \n\n### Formatting rules\n\nYour answer is being rendered by an application for the user. Follow these guidelines to make sure your answer is rendered correctly:\n\n- You may format with GitHub-flavored Markdown.\n- When referencing a real local file, prefer a clickable markdown link.\n  * Clickable file links should look like [app.py](/abs/path/app.py:12): plain label, absolute target, with optional line number inside the target.\n  * If a file path has spaces, wrap the target in angle brackets: [My Report.md](</abs/path/My Project/My Report.md:3>).\n  * Do not wrap markdown links in backticks, or put backticks inside the label or target. This confuses the markdown renderer.\n  * Do not use URIs like file://, vscode://, or https:// for file links.\n  * Do not provide ranges of lines.\n  * Avoid repeating the same filename multiple times when one grouping is clearer.\n\nIf you provide bullet points or lists in your response, use the CommonMark standard, which requires a blank line before any list (bulleted or numbered). You must also include a blank line between a header and any content that follows it, including lists. This blank line separation is required for correct rendering.\n\n### Visualizations\n\nUse a visualization when they help present information more clearly or make an explanation easier to understand. Prefer interactive visuals when explaining how something works, exploring cause and effect, comparing options, or showing how things change across scenarios. The user does not need to explicitly request a visualization. \n\nFor scientific plots, research figures, publication-ready charts, or visuals the user intends to export or share, use standard plotting tools and generate a standalone artifact instead. \n\nUse tables for mappings or comparisons. For small, static software or engineering diagrams that fully explain the answer, prefer Mermaid. Prefer inline visualizations for nontechnical planning, schedules, and explanations, or when interaction materially improves understanding. \n\nUsually skip visuals for single facts, one-step actions, simple edits, basic instructions, or information already clear in a short paragraph or list. Compact notation and small examples do not count as visualizations.\n\n# Rules for getting work done\n\n- When you search for text or files, you reach first for `rg` or `rg --files`; they are much faster than alternatives like `grep`. If `rg` is unavailable, you use the next best tool without fuss.\n- Batch independent searches and reads in one functions.exec using await Promise.allSettled([...]); inspect every result. Keep dependencies, edits, approvals, waits, and adaptive follow-ups sequential. Avoid unnecessary output.\n- When calling `functions.exec`, parallelize independent tool calls by awaiting Promises. Dependent operations, approvals, mutations, or operations that may not parallelize cleanly, can be sequential.\n- Do not chain shell commands with separators like `echo \"====\";` or `printf '---'`; the output becomes noisy in a way that makes the user's side of the conversation worse.\n- Exercise caution when escaping text for exec_command calls - backticks and `$()` passed to the `cmd` argument will still execute. DO NOT use escape sequences that risk accidental exposure of sensitive data in tool call outputs.\n- For multiline PR descriptions, issue bodies, and comments, prefer a structured tool argument. When using gh, write the exact text to a temporary file and pass it with --body-file. Preserve actual newlines and intentional literal escapes.\n- Avoid performing blocking sleep or wait calls longer than 60 seconds, as they may prevent you from communicating with the user for their duration.\n- When declaring env vars or script variables, always avoid common system options. Never repurpose `$HOME`, `$home`, or `$CODEX_HOME`. Instead, use a task-specific variable name.\n- Treat shell command text as code. `JSON.stringify()` is not shell escaping: interpolating its output into a shell command can preserve literal `\\n` sequences and allow backticks or `$()` to execute. Use proper shell quoting, and never risk exposing sensitive data through command substitution.\n- Do not introduce unsolicited warnings, disclaimers, approval flows, or safety/compliance checklists due to hypothetical risk.\n- Keep implementation details out of product (e.g. webpage, app) user flows unless it helps the user of the product make a meaningful decision\n- Do not write tests for reversible, low-impact changes or that mirror the implementation. If you do choose to verify your work with tests, make sure that the tests are meaningful and necessary to verify implementation.\n- Run tests appropriate to the change and complete required checks. Once those pass, broaden or repeat testing only when new changes, failures, or unresolved concerns justify it; otherwise, continue toward completing the task.\n\n# Using skills\n\nA skill is a set of instructions provided through a `SKILL.md` source. Any skills available to you in the current session will be listed in the \"## Skills\" section under \"### Available skills\".\n\nEach entry includes a name, description, and location for its `SKILL.md`. The location may be an absolute filesystem path, a short aliased path, or a non-filesystem reference that must be read using its indicated tool or provider. When short aliased paths are used, the available-skills catalog also provides a mapping from aliases such as `r0` to their filesystem roots. Expand the alias before accessing the skill.\n\nThe user's instructions take precedence over guidelines provided in a skill. If explicit user instructions conflict with a skill's instructions, prioritize the user's instructions. \n\nThe first time in a conversation that you decide to apply a skill, inform the user in the commentary channel.\n\nIf a skill causes you to ask for permission or confirmation, pause, or leave requested work unfinished, name and link to the exact SKILL.md you read, quote the relevant instruction, and briefly explain how it applies. Distinguish explicit skill requirements from your interpretation. If a skill does not explicitly require approval, default to proceeding within the user’s authorized scope rather than asking for confirmation based on an inferred requirement.\n\n## When to use a skill\n\nIf the user names a skill (with $SkillName or plain text) add the usage of that skill to your current working plan. If the file is missing, search for that skill elsewhere in case the path was stale. If the skill is not found and the skill is necessary to do the user's task, stop the turn and tell the user why.\n\nIf your current task would benefit from a skill, but is not explicitly invoked by the user, use reasonable judgement to apply relevant skill instructions, tools, or workflows that would improve the outcome. Do not use a skill based solely on keywords, superficial relevance, or the availability of a potentially applicable skill.\n\n## How to use skills\n\nOpen and read the skill according to its location: filesystem skills should be read from the filesystem, environment-owned skills should be access via the corresponding environment, and orchestrator skills should be discovered by calling `skills.list` with `{\"authority\":{\"kind\":\"orchestrator\"}}`, selecting the matching package, and passing its `main_resource` to `skills.read`. Avoid re-reading skills when possible. \n\nWhen a `SKILL.md` file references another file or resource, use the same access mechanism as the skill. Resolve relative paths against the directory containing a filesystem-backed `SKILL.md`. For orchestrator skills, pass the exact referenced resource identifier with the same authority and package to `skills.read`; do not treat `skill://` identifiers as filesystem paths.\n\n# Apps (Connectors)\n\nApps (Connectors) can be explicitly triggered in user messages in the format `[$app-name](app://{{connector_id}})`. Apps can also be implicitly triggered as long as the context suggests usage of available apps.\nAn app is equivalent to a set of MCP tools within the `codex_apps` MCP.\nAn installed app's MCP tools are either provided to you already, or can be lazy-loaded through the `tool_search` tool. If `tool_search` is available, the apps that are searchable by `tools_search` will be listed by it.\nDo not additionally call list_mcp_resources or list_mcp_resource_templates for apps.\n\n# Plugins\n\nA plugin is a local bundle of skills, MCP servers, and apps.\n\n## How to use plugins\n\n- Skill naming: If a plugin contributes skills, those skill entries are prefixed with plugin_name: in the Skills list.\n- MCP naming: Plugin-provided MCP tools keep standard MCP identifiers such as mcp__server__tool; use tool provenance to tell which plugin they come from.\n- Trigger rules: If the user explicitly names a plugin, prefer capabilities associated with that plugin for that turn.\n- Relationship to capabilities: Plugins are not invoked directly. Use their underlying skills, MCP tools, and app tools to help solve the task.\n- Relevance: Determine what a plugin can help with from explicit user mention or from the plugin-associated skills, MCP tools, and apps exposed elsewhere in this turn.\n- Missing/blocked: If the user requests a plugin that does not have relevant callable capabilities for the task, say so briefly and continue with the best fallback.\n\n","provenance":{"type":"model","model":"gpt-6.1-sol"}},"history_mode":"paginated","context_window":{"window_id":"01a1c0b5-f5dd-73b2-8cb5-c25037d4e862"}}}
{"timestamp":"2026-11-09T14:28:32.900Z","ordinal":1,"type":"event_msg","payload":{"type":"task_started","turn_id":"01a1c0b5-f5f4-7531-8b2f-822dd99b5c57","root_turn_id":"01a1c0b5-f5f4-7531-8b2f-822dd99b5c57","started_at":1794234512,"model_context_window":258400,"collaboration_mode_kind":"default"}}
{"timestamp":"2026-11-09T14:28:32.908Z","ordinal":2,"type":"response_item","payload":{"type":"message","id":"msg_01a1c0b5-f60c-71a3-8221-306353d609a7","role":"developer","content":[{"type":"input_text","text":"Implement the task."},{"type":"input_text","text":"<skills_instructions>\n## Skills\nA skill is a set of local instructions to follow that is stored in a `SKILL.md` file. Below is the list of skills that can be used. Each entry includes a name, description, and a short path that can be expanded into an absolute path using the skill roots table.\n### Skill roots\n- `r0` = `/private/tmp/agflow-rollout/codex-home/skills/.system`\n### Available skills\n- imagegen: Generate or edit raster images when the task benefits from AI-created bitmap visuals such as photos, illustrations, textures, sprites, mockups, or transparent-background cutouts. Use when Codex should create a brand-new image, transform an existing image, or derive visual variants from references, and the output should be a bitmap asset rather than repo-native code or vector. Do not use when the task is better handled by editing existing SVG/vector/code-native assets, extending an established icon or logo system, or building the visual directly in HTML/CSS/canvas. (file: r0/imagegen/SKILL.md)\n- openai-docs: Use for Codex models/pricing, scheduled tasks, skills, settings, setup, troubleshooting, customization, automations, and self-knowledge—including 'you,' 'your,' 'this app,' or 'this coding agent' when they refer to Codex—and for OpenAI APIs/products and ChatGPT Work. Also use for model choice/migration, prompting, SDKs, Responses, Realtime, agents, evals, and Chat/Work/Codex comparisons. Do not use for generic app/software tasks that merely mention Codex. (file: r0/openai-docs/SKILL.md)\n- skill-creator: Create or update a Codex skill with appropriately scoped instructions and any needed supporting resources. (file: r0/skill-creator/SKILL.md)\n- skill-installer: Install Codex skills into $CODEX_HOME/skills from a curated list or a GitHub repo path. Use when a user asks to list installable skills, install a curated skill, or install a skill from another repo (including private repos). (file: r0/skill-installer/SKILL.md)\n</skills_instructions>"},{"type":"input_text","text":"<permissions instructions>\nFilesystem sandboxing defines which files can be read or written. `sandbox_mode` is `workspace-write`: The sandbox permits reading files, and editing files in `cwd` and `writable_roots`. Editing files in other directories requires approval. Network access is restricted.\n# Escalation Requests\n\nCommands are run outside the sandbox if they are approved by the user, or match an existing rule that allows it to run unrestricted. The command string is split into independent command segments at shell control operators, including but not limited to:\n\n- Pipes: |\n- Logical operators: &&, ||\n- Command separators: ;\n- Subshell boundaries: (...), $(...)\n\nEach resulting segment is evaluated independently for sandbox restrictions and approval requirements.\n\nExample:\n\ngit pull | tee output.txt\n\nThis is treated as two command segments:\n\n[\"git\", \"pull\"]\n\n[\"tee\", \"output.txt\"]\n\nCommands that use more advanced shell features like redirection (>, >>, <), substitutions ($(...), ...), environment variables (FOO=bar), or wildcard patterns (*, ?) will not be evaluated against rules, to limit the scope of what an approved rule allows.\n\n## How to request escalation\n\nIMPORTANT: To request approval to execute a command that will require escalated privileges:\n\n- Provide the `sandbox_permissions` parameter with the value `\"require_escalated\"`\n- Include a short question asking the user if they want to allow the action in `justification` parameter. e.g. \"Do you want to download and install dependencies for this project?\"\n- Optionally suggest a `prefix_rule` - this will be shown to the user with an option to persist the rule approval for future sessions.\n\nIf you run a command that is important to solving the user's query, but it fails because of sandboxing or with a likely sandbox-related network error (for example DNS/host resolution, registry/index access, or dependency download failure), rerun the command with \"require_escalated\". ALWAYS proceed to use the `justification` parameter - do not message the user before requesting approval for the command.\n\n## When to request escalation\n\nWhile commands are running inside the sandbox, here are some scenarios that will require escalation outside the sandbox:\n\n- You need to run a command that writes to a directory that requires it (e.g. running tests that write to /var)\n- You need to run a GUI app (e.g., open/xdg-open/osascript) to open browsers or files.\n- If you run a command that is important to solving the user's query, but it fails because of sandboxing or with a likely sandbox-related network error (for example DNS/host resolution, registry/index access, or dependency download failure), rerun the command with `require_escalated`. ALWAYS proceed to use the `sandbox_permissions` and `justification` parameters. do not message the user before requesting approval for the command.\n- You are about to take a potentially destructive action such as an `rm` or `git reset` that the user did not explicitly ask for.\n- Be judicious with escalating, but if completing the user's request requires it, you should do so - don't try and circumvent approvals by using other tools.\n\n## prefix_rule guidance\n\nWhen choosing a `prefix_rule`, request one that will allow you to fulfill similar requests from the user in the future without re-requesting escalation. It should be categorical and reasonably scoped to similar capabilities. You should rarely pass the entire command into `prefix_rule`.\n\n### Banned prefix_rules \nAvoid requesting overly broad prefixes that the user would be ill-advised to approve. For example, do not request [\"python3\"], [\"python\", \"-\"], or other similar prefixes that would allow arbitrary scripting.\nNEVER provide a prefix_rule argument for destructive commands like rm.\nNEVER provide a prefix_rule if your command uses a heredoc or herestring. \n\n### Examples\nGood examples of prefixes:\n- [\"npm\", \"run\", \"dev\"]\n- [\"gh\", \"pr\", \"check\"]\n- [\"cargo\", \"test\"]\n The writable roots are `/private/tmp/agflow-rollout/clone`, `/private/tmp/agflow-rollout/clone/.git`.\n</permissions instructions>"},{"type":"input_text","text":"<collaboration_mode># Collaboration Mode: Default\n\nYou are now in Default mode. Any previous instructions for other modes (e.g. Plan mode) are no longer active.\n\nYour active mode changes only when new developer instructions with a different `<collaboration_mode>...</collaboration_mode>` change it; user requests or tool descriptions do not change mode by themselves. Known mode names are Default and Plan.\n\n## request_user_input availability\n\nUse the `request_user_input` tool only when it is listed in the available tools for this turn.\n\nUse the `request_user_input` tool only for optional questions where the answer would materially improve the quality of the work.\n\nIf `request_user_input` returns no answers, continue with best judgment instead of asking again or treating the turn as blocked.\n\nNever use the `request_user_input` tool for permission requests or permission-related escalations.\n</collaboration_mode>"}],"internal_chat_message_metadata_passthrough":{"turn_id":"01a1c0b5-f5f4-7531-8b2f-822dd99b5c57","create_time":1794234512.908314,"content_item_kinds":["generic.developer_instructions","host_skills.instructions","permissions.instructions","collaboration_mode.instructions"]}},"metadata":{"client_authored":false,"mcp_attribution":{"status":"none"}}}
{"timestamp":"2026-11-09T14:28:32.908Z","ordinal":3,"type":"response_item","payload":{"type":"message","id":"msg_01a1c0b5-f60c-71a3-8221-307302e1067d","role":"developer","content":[{"type":"input_text","text":"<multi_agent_role>You are `/root`, the primary agent in a team of agents collaborating to fulfill the user's goals.\n\nAt the start of your turn, you are the active agent.\nYou can spawn sub-agents to handle subtasks, and those sub-agents can spawn their own sub-agents.\nAll agents in the team, including the agents that you can assign tasks to, are equally intelligent and capable, and have access to the same set of tools.\n\nYou can use `spawn_agent` to create a new agent, `followup_task` to give an existing agent a new task and trigger a turn, and `send_message` to pass a message to a running agent without triggering a turn.\n`send_message` calls may be read by a human, so ensure they are legible. Always put proper spaces between words and/or numbers.\nChild agents can also spawn their own sub-agents.\nYou can decide how much context you want to propagate to your sub-agents with the `fork_turns` parameter.\n\nYou will receive messages in the analysis channel in the form:\n```\nMessage Type: MESSAGE | FINAL_ANSWER\nTask name: <recipient>\nSender: <author>\nPayload:\n<payload text>\n```\nThey may be addressed as to=/root\n\nNote that collaboration tools cannot be called from inside `functions.exec`. Call `spawn_agent`, `send_message`, `followup_task`, `wait_agent`, `interrupt_agent`, and `list_agents` only as direct tool calls using the recipient shown in their tool definitions, such as `to=functions.collaboration.spawn_agent`, since they are intentionally absent from the `functions.exec` `tools.*` namespace. Available tools in `functions.exec` are explicitly described with a `tools` namespace in the developer message.\n\nAll agents share the same directory. In detail:\n- All agents have access to the same container and filesystem as you.\n- All agents use the same current working directory.\n- As a result, edits made by one agent are immediately visible to all other agents.\n\nWhen calling `wait_agent`, prefer longer waits (minutes) to avoid busy polling.\n\nThere are 4 available concurrency slots, meaning that up to 4 agents can be active at once, including you.\n\nFull-history forks (`fork_turns` omitted or `\"all\"`) inherit the parent model and reasoning effort and do not accept overrides. Only set `model` or `reasoning_effort` when explicitly requested by the user, applicable `AGENTS.md` instructions, or skill instructions; when doing so, set `fork_turns` to `\"none\"` or a positive integer string.</multi_agent_role>"}],"internal_chat_message_metadata_passthrough":{"turn_id":"01a1c0b5-f5f4-7531-8b2f-822dd99b5c57","create_time":1794234512.908317,"content_item_kinds":["multi_agent.role_instructions"]}}}
{"timestamp":"2026-11-09T14:28:32.908Z","ordinal":4,"type":"response_item","payload":{"type":"message","id":"msg_01a1c0b5-f60c-71a3-8221-308f30bdfd9b","role":"developer","content":[{"type":"input_text","text":"<multi_agent_mode>Any earlier instruction enabling proactive multi-agent delegation no longer applies. Do not spawn sub-agents unless the user or applicable AGENTS.md/skill instructions explicitly ask for sub-agents, delegation, or parallel agent work.</multi_agent_mode>"}],"internal_chat_message_metadata_passthrough":{"turn_id":"01a1c0b5-f5f4-7531-8b2f-822dd99b5c57","create_time":1794234512.908317,"content_item_kinds":["multi_agent.mode_instructions"]}}}
{"timestamp":"2026-11-09T14:28:32.908Z","ordinal":5,"type":"response_item","payload":{"type":"message","id":"msg_01a1c0b5-f60c-71a3-8221-309044a0c777","role":"user","content":[{"type":"input_text","text":"<environment_context>\n  <cwd>/private/tmp/agflow-rollout/clone</cwd>\n  <shell>zsh</shell>\n  <current_date>2026-11-09</current_date>\n  <timezone>Europe/Moscow</timezone>\n  <filesystem><workspace_roots><root>/private/tmp/agflow-rollout/clone</root><root>/private/tmp/agflow-rollout/clone/.git</root></workspace_roots><permission_profile type=\"managed\"><file_system type=\"restricted\"><entry access=\"read\"><special>:root</special></entry><entry access=\"write\"><path>/private/tmp/agflow-rollout/clone</path></entry><entry access=\"write\"><path>/private/tmp/agflow-rollout/clone/.git</path></entry><entry access=\"read\"><path>/private/tmp/agflow-rollout/clone/.git</path></entry><entry access=\"read\"><path>/private/tmp/agflow-rollout/clone/.git/.git</path></entry><entry access=\"read\"><path>/private/tmp/agflow-rollout/clone/.agents</path></entry><entry access=\"read\"><path>/private/tmp/agflow-rollout/clone/.git/.agents</path></entry><entry access=\"read\"><path>/private/tmp/agflow-rollout/clone/.codex</path></entry><entry access=\"read\"><path>/private/tmp/agflow-rollout/clone/.git/.codex</path></entry><entry access=\"read\"><path>/private/tmp/agflow-rollout/clone/.aws</path></entry><entry access=\"read\"><path>/private/tmp/agflow-rollout/clone/.git/.aws</path></entry></file_system></permission_profile></filesystem>\n</environment_context>"}],"internal_chat_message_metadata_passthrough":{"turn_id":"01a1c0b5-f5f4-7531-8b2f-822dd99b5c57","create_time":1794234512.908317,"content_item_kinds":["environments.environment_context"]}}}
{"timestamp":"2026-11-09T14:28:32.908Z","ordinal":6,"type":"world_state","payload":{"full":true,"state":{"agents_md":{},"apps_instructions":false,"collaboration_mode":{"mode":"default","model":"gpt-6.1-sol","instructions":"0a11049b0421e1e86f1e129af8d547a89548a0c3"},"context_window_guidance":"","environments":{"environments":{"local":{"cwd":"/private/tmp/agflow-rollout/clone","status":"available","shell":"zsh"}},"current_date":"2026-11-09","timezone":"Europe/Moscow","filesystem":"<filesystem><workspace_roots><root>/private/tmp/agflow-rollout/clone</root><root>/private/tmp/agflow-rollout/clone/.git</root></workspace_roots><permission_profile type=\"managed\"><file_system type=\"restricted\"><entry access=\"read\"><special>:root</special></entry><entry access=\"write\"><path>/private/tmp/agflow-rollout/clone</path></entry><entry access=\"write\"><path>/private/tmp/agflow-rollout/clone/.git</path></entry><entry access=\"read\"><path>/private/tmp/agflow-rollout/clone/.git</path></entry><entry access=\"read\"><path>/private/tmp/agflow-rollout/clone/.git/.git</path></entry><entry access=\"read\"><path>/private/tmp/agflow-rollout/clone/.agents</path></entry><entry access=\"read\"><path>/private/tmp/agflow-rollout/clone/.git/.agents</path></entry><entry access=\"read\"><path>/private/tmp/agflow-rollout/clone/.codex</path></entry><entry access=\"read\"><path>/private/tmp/agflow-rollout/clone/.git/.codex</path></entry><entry access=\"read\"><path>/private/tmp/agflow-rollout/clone/.aws</path></entry><entry access=\"read\"><path>/private/tmp/agflow-rollout/clone/.git/.aws</path></entry></file_system></permission_profile></filesystem>"},"environments_instructions":false,"git_attribution":false,"host_skills":{"body":"\n## Skills\nA skill is a set of local instructions to follow that is stored in a `SKILL.md` file. Below is the list of skills that can be used. Each entry includes a name, description, and a short path that can be expanded into an absolute path using the skill roots table.\n### Skill roots\n- `r0` = `/private/tmp/agflow-rollout/codex-home/skills/.system`\n### Available skills\n- imagegen: Generate or edit raster images when the task benefits from AI-created bitmap visuals such as photos, illustrations, textures, sprites, mockups, or transparent-background cutouts. Use when Codex should create a brand-new image, transform an existing image, or derive visual variants from references, and the output should be a bitmap asset rather than repo-native code or vector. Do not use when the task is better handled by editing existing SVG/vector/code-native assets, extending an established icon or logo system, or building the visual directly in HTML/CSS/canvas. (file: r0/imagegen/SKILL.md)\n- openai-docs: Use for Codex models/pricing, scheduled tasks, skills, settings, setup, troubleshooting, customization, automations, and self-knowledge—including 'you,' 'your,' 'this app,' or 'this coding agent' when they refer to Codex—and for OpenAI APIs/products and ChatGPT Work. Also use for model choice/migration, prompting, SDKs, Responses, Realtime, agents, evals, and Chat/Work/Codex comparisons. Do not use for generic app/software tasks that merely mention Codex. (file: r0/openai-docs/SKILL.md)\n- skill-creator: Create or update a Codex skill with appropriately scoped instructions and any needed supporting resources. (file: r0/skill-creator/SKILL.md)\n- skill-installer: Install Codex skills into $CODEX_HOME/skills from a curated list or a GitHub repo path. Use when a user asks to list installable skills, install a curated skill, or install a skill from another repo (including private repos). (file: r0/skill-installer/SKILL.md)\n","includeInstructions":true},"managed_developer_instructions":{},"model":"gpt-6.1-sol","multi_agent_mode":{"mode":"explicitRequestOnly","usage_hint_hash":"30fb77255ffd0abcecb08a8897e242564dfe1192"},"multi_agent_usage_hint":"30fb77255ffd0abcecb08a8897e242564dfe1192","permissions":{"instructions":"f6d4228e8e87c4b360f90856c96c32f7584ea70b","approved_command_prefixes":[]},"persistent_mode":{},"plugins_instructions":false,"realtime":{"active":false},"skills":{"includeInstructions":true}}}}
{"timestamp":"2026-11-09T14:28:32.909Z","ordinal":7,"type":"turn_context","payload":{"turn_id":"01a1c0b5-f5f4-7531-8b2f-822dd99b5c57","root_turn_id":"01a1c0b5-f5f4-7531-8b2f-822dd99b5c57","disabled_plugin_ids":[],"cwd":"/private/tmp/agflow-rollout/clone","workspace_roots":["/private/tmp/agflow-rollout/clone","/private/tmp/agflow-rollout/clone/.git"],"current_date":"2026-11-09","timezone":"Europe/Moscow","approval_policy":"on-request","approvals_reviewer":"user","sandbox_policy":{"type":"workspace-write","writable_roots":["/private/tmp/agflow-rollout/clone/.git"],"network_access":false,"exclude_tmpdir_env_var":true,"exclude_slash_tmp":true},"permission_profile":{"type":"managed","file_system":{"type":"restricted","entries":[{"path":{"type":"special","value":{"kind":"root"}},"access":"read"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone"},"access":"write"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.git"},"access":"write"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.git"},"access":"write"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.git"},"access":"read","missing_path_behavior":"skip"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.git/.git"},"access":"read","missing_path_behavior":"skip"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.agents"},"access":"read","missing_path_behavior":"skip"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.git/.agents"},"access":"read","missing_path_behavior":"skip"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.codex"},"access":"read","missing_path_behavior":"skip"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.git/.codex"},"access":"read","missing_path_behavior":"skip"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.aws"},"access":"read","missing_path_behavior":"skip"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.git/.aws"},"access":"read","missing_path_behavior":"skip"}]},"network":"restricted"},"file_system_sandbox_policy":{"kind":"restricted","entries":[{"path":{"type":"special","value":{"kind":"root"}},"access":"read"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone"},"access":"write"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.git"},"access":"write"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.git"},"access":"write"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.git"},"access":"read","missing_path_behavior":"skip"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.git/.git"},"access":"read","missing_path_behavior":"skip"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.agents"},"access":"read","missing_path_behavior":"skip"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.git/.agents"},"access":"read","missing_path_behavior":"skip"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.codex"},"access":"read","missing_path_behavior":"skip"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.git/.codex"},"access":"read","missing_path_behavior":"skip"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.aws"},"access":"read","missing_path_behavior":"skip"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.git/.aws"},"access":"read","missing_path_behavior":"skip"}]},"model":"gpt-6.1-sol","comp_hash":"3000","collaboration_mode":{"mode":"default","settings":{"model":"gpt-6.1-sol","reasoning_effort":null,"developer_instructions":null}},"multi_agent_version":"v2","realtime_active":false,"summary":"none"}}
{"timestamp":"2026-11-09T14:28:32.913Z","ordinal":8,"type":"response_item","payload":{"type":"message","id":"msg_01a1c0b5-f611-7c82-889f-b90f254c2408","role":"user","content":[{"type":"input_text","text":"Prompt 1"}],"internal_chat_message_metadata_passthrough":{"turn_id":"01a1c0b5-f5f4-7531-8b2f-822dd99b5c57","create_time":1794234512.913355,"content_item_kinds":["user.text"]}},"metadata":{"retained_source":{"id":{"message_id":"msg_01a1c0b5-f611-7c82-889f-b90f254c2408","turn_id":"01a1c0b5-f5f4-7531-8b2f-822dd99b5c57","role":"user"},"revision":"retained_01a1c0b5-f611-7c82-889f-b92c78c329ca","complete":true},"client_authored":false,"user_input_order":0,"mcp_attribution":{"status":"none"}}}
{"timestamp":"2026-11-09T14:28:32.913Z","ordinal":9,"type":"event_msg","payload":{"type":"item_completed","thread_id":"01a1c0b5-f5db-7140-8021-694831838113","turn_id":"01a1c0b5-f5f4-7531-8b2f-822dd99b5c57","item":{"type":"UserMessage","id":"01a1c0b5-f611-7c82-889f-b911ed121853","content":[{"type":"text","text":"Prompt 1","text_elements":[]}]},"started_at_ms":1794234512913,"completed_at_ms":1794234512913}}
{"timestamp":"2026-11-09T14:28:32.923Z","ordinal":10,"type":"event_msg","payload":{"type":"item_completed","thread_id":"01a1c0b5-f5db-7140-8021-694831838113","turn_id":"01a1c0b5-f5f4-7531-8b2f-822dd99b5c57","item":{"type":"AgentMessage","id":"msg_41ffdf6bc2f64f159a3cfb1527cfb2f6","content":[{"type":"Text","text":"Turn one: I read the task."}]},"started_at_ms":1794234512923,"completed_at_ms":1794234512923}}
{"timestamp":"2026-11-09T14:28:32.924Z","ordinal":11,"type":"response_item","payload":{"type":"message","id":"msg_41ffdf6bc2f64f159a3cfb1527cfb2f6","role":"assistant","content":[{"type":"output_text","text":"Turn one: I read the task."}],"internal_chat_message_metadata_passthrough":{"turn_id":"01a1c0b5-f5f4-7531-8b2f-822dd99b5c57","content_item_kinds":["unknown"]}},"metadata":{"retained_source":{"id":{"message_id":"msg_41ffdf6bc2f64f159a3cfb1527cfb2f6","turn_id":"01a1c0b5-f5f4-7531-8b2f-822dd99b5c57","role":"assistant"},"revision":"retained_01a1c0b5-f61c-7461-b4a8-a82c713c8604","complete":true},"client_authored":false,"user_input_order":1}}
{"timestamp":"2026-11-09T14:28:32.924Z","ordinal":12,"type":"token_usage_record","payload":{"thread_id":"01a1c0b5-f5db-7140-8021-694831838113","turn_id":"01a1c0b5-f5f4-7531-8b2f-822dd99b5c57","session_id":"01a1c0b5-f5db-7140-8021-694831838113","root_turn_id":"01a1c0b5-f5f4-7531-8b2f-822dd99b5c57","response_id":"resp_e2440a969f224ceeb3a10d07998874cf","usage":{"input_tokens":100,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0,"total_tokens":105},"turn_token_usage":{"input_tokens":100,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0,"total_tokens":105},"thread_token_usage":{"input_tokens":100,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0,"total_tokens":105}}}
{"timestamp":"2026-11-09T14:28:32.925Z","ordinal":13,"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0,"total_tokens":105},"last_token_usage":{"input_tokens":100,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0,"total_tokens":105},"model_context_window":258400},"rate_limits":{"limit_id":"codex","limit_name":null,"primary":null,"secondary":null,"credits":null,"individual_limit":null,"spend_control_reached":null,"plan_type":null,"rate_limit_reached_type":null}}}
{"timestamp":"2026-11-09T14:28:32.926Z","ordinal":14,"type":"event_msg","payload":{"type":"task_complete","turn_id":"01a1c0b5-f5f4-7531-8b2f-822dd99b5c57","last_agent_message":"Turn one: I read the task.","started_at":1794234512,"completed_at":1794234512,"duration_ms":40,"time_to_first_token_ms":37}}
{"timestamp":"2026-11-09T14:28:32.930Z","ordinal":15,"type":"event_msg","payload":{"type":"task_started","turn_id":"01a1c0b5-f621-7033-883b-9279fdc61e3b","root_turn_id":"01a1c0b5-f621-7033-883b-9279fdc61e3b","started_at":1794234512,"model_context_window":258400,"collaboration_mode_kind":"default"}}
{"timestamp":"2026-11-09T14:28:32.933Z","ordinal":16,"type":"turn_context","payload":{"turn_id":"01a1c0b5-f621-7033-883b-9279fdc61e3b","root_turn_id":"01a1c0b5-f621-7033-883b-9279fdc61e3b","disabled_plugin_ids":[],"cwd":"/private/tmp/agflow-rollout/clone","workspace_roots":["/private/tmp/agflow-rollout/clone","/private/tmp/agflow-rollout/clone/.git"],"current_date":"2026-11-09","timezone":"Europe/Moscow","approval_policy":"on-request","approvals_reviewer":"user","sandbox_policy":{"type":"workspace-write","writable_roots":["/private/tmp/agflow-rollout/clone/.git"],"network_access":false,"exclude_tmpdir_env_var":true,"exclude_slash_tmp":true},"permission_profile":{"type":"managed","file_system":{"type":"restricted","entries":[{"path":{"type":"special","value":{"kind":"root"}},"access":"read"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone"},"access":"write"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.git"},"access":"write"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.git"},"access":"write"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.git"},"access":"read","missing_path_behavior":"skip"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.git/.git"},"access":"read","missing_path_behavior":"skip"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.agents"},"access":"read","missing_path_behavior":"skip"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.git/.agents"},"access":"read","missing_path_behavior":"skip"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.codex"},"access":"read","missing_path_behavior":"skip"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.git/.codex"},"access":"read","missing_path_behavior":"skip"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.aws"},"access":"read","missing_path_behavior":"skip"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.git/.aws"},"access":"read","missing_path_behavior":"skip"}]},"network":"restricted"},"file_system_sandbox_policy":{"kind":"restricted","entries":[{"path":{"type":"special","value":{"kind":"root"}},"access":"read"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone"},"access":"write"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.git"},"access":"write"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.git"},"access":"write"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.git"},"access":"read","missing_path_behavior":"skip"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.git/.git"},"access":"read","missing_path_behavior":"skip"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.agents"},"access":"read","missing_path_behavior":"skip"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.git/.agents"},"access":"read","missing_path_behavior":"skip"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.codex"},"access":"read","missing_path_behavior":"skip"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.git/.codex"},"access":"read","missing_path_behavior":"skip"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.aws"},"access":"read","missing_path_behavior":"skip"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.git/.aws"},"access":"read","missing_path_behavior":"skip"}]},"model":"gpt-6.1-sol","comp_hash":"3000","collaboration_mode":{"mode":"default","settings":{"model":"gpt-6.1-sol","reasoning_effort":null,"developer_instructions":null}},"multi_agent_version":"v2","realtime_active":false,"summary":"none"}}
{"timestamp":"2026-11-09T14:28:32.937Z","ordinal":17,"type":"response_item","payload":{"type":"message","id":"msg_01a1c0b5-f629-76f2-ad19-0f56126cb90d","role":"user","content":[{"type":"input_text","text":"Prompt 2"}],"internal_chat_message_metadata_passthrough":{"turn_id":"01a1c0b5-f621-7033-883b-9279fdc61e3b","create_time":1794234512.937297,"content_item_kinds":["user.text"]}},"metadata":{"retained_source":{"id":{"message_id":"msg_01a1c0b5-f629-76f2-ad19-0f56126cb90d","turn_id":"01a1c0b5-f621-7033-883b-9279fdc61e3b","role":"user"},"revision":"retained_01a1c0b5-f629-76f2-ad19-0f7b2d0eae05","complete":true},"client_authored":false,"user_input_order":2,"mcp_attribution":{"status":"none"}}}
{"timestamp":"2026-11-09T14:28:32.937Z","ordinal":18,"type":"event_msg","payload":{"type":"item_completed","thread_id":"01a1c0b5-f5db-7140-8021-694831838113","turn_id":"01a1c0b5-f621-7033-883b-9279fdc61e3b","item":{"type":"UserMessage","id":"01a1c0b5-f629-76f2-ad19-0f65d9d1df7d","content":[{"type":"text","text":"Prompt 2","text_elements":[]}]},"started_at_ms":1794234512937,"completed_at_ms":1794234512937}}
{"timestamp":"2026-11-09T14:28:32.942Z","ordinal":19,"type":"event_msg","payload":{"type":"item_completed","thread_id":"01a1c0b5-f5db-7140-8021-694831838113","turn_id":"01a1c0b5-f621-7033-883b-9279fdc61e3b","item":{"type":"AgentMessage","id":"msg_06804be3989842808cff95455a42b3fd","content":[{"type":"Text","text":"Turn two: running the tests first."}]},"started_at_ms":1794234512942,"completed_at_ms":1794234512942}}
{"timestamp":"2026-11-09T14:28:32.942Z","ordinal":20,"type":"response_item","payload":{"type":"message","id":"msg_06804be3989842808cff95455a42b3fd","role":"assistant","content":[{"type":"output_text","text":"Turn two: running the tests first."}],"internal_chat_message_metadata_passthrough":{"turn_id":"01a1c0b5-f621-7033-883b-9279fdc61e3b","content_item_kinds":["unknown"]}},"metadata":{"retained_source":{"id":{"message_id":"msg_06804be3989842808cff95455a42b3fd","turn_id":"01a1c0b5-f621-7033-883b-9279fdc61e3b","role":"assistant"},"revision":"retained_01a1c0b5-f62e-7d12-9ee3-b941459dbd14","complete":true},"client_authored":false,"user_input_order":3}}
{"timestamp":"2026-11-09T14:28:32.943Z","ordinal":21,"type":"response_item","payload":{"type":"custom_tool_call","id":"ctc_34f14bc3b15a462dac7d3552bf5a4d15","status":"completed","call_id":"call_7d324c468ba742f1a40e8e79c8141b07","name":"exec","input":"// @exec: {\"yield_time_ms\":65000}\nconst deadline = Date.now() + 60000;\nlet result = await tools.exec_command({\"cmd\":\"echo tests ran\",\"yield_time_ms\":30000});\nlet output = result.output ?? '';\nwhile (result.exit_code === undefined && result.session_id !== undefined && Date.now() < deadline) {\n  result = await tools.write_stdin({ session_id: result.session_id, chars: '', yield_time_ms: Math.min(300000, Math.max(1000, deadline - Date.now())) });\n  output += result.output ?? '';\n}\ntext({ ...result, output });","internal_chat_message_metadata_passthrough":{"turn_id":"01a1c0b5-f621-7033-883b-9279fdc61e3b"}}}
{"timestamp":"2026-11-09T14:28:32.943Z","ordinal":22,"type":"token_usage_record","payload":{"thread_id":"01a1c0b5-f5db-7140-8021-694831838113","turn_id":"01a1c0b5-f621-7033-883b-9279fdc61e3b","session_id":"01a1c0b5-f5db-7140-8021-694831838113","root_turn_id":"01a1c0b5-f621-7033-883b-9279fdc61e3b","response_id":"resp_b7482428e1734aafb510240f1871a640","usage":{"input_tokens":100,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0,"total_tokens":105},"turn_token_usage":{"input_tokens":100,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0,"total_tokens":105},"thread_token_usage":{"input_tokens":200,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":10,"reasoning_output_tokens":0,"total_tokens":210}}}
{"timestamp":"2026-11-09T14:28:33.019Z","ordinal":23,"type":"event_msg","payload":{"type":"item_completed","thread_id":"01a1c0b5-f5db-7140-8021-694831838113","turn_id":"01a1c0b5-f621-7033-883b-9279fdc61e3b","item":{"type":"CommandExecution","id":"exec-dd63ada6-8190-420b-bb18-c21650de6883","process_id":"56929","command":["/bin/zsh","-c","echo tests ran"],"cwd":"file:///private/tmp/agflow-rollout/clone","parsed_cmd":[{"type":"unknown","cmd":"echo tests ran"}],"source":"unified_exec_startup","status":"completed","stdout":"tests ran\n","stderr":"","aggregated_output":"tests ran\n","exit_code":0,"duration":{"secs":0,"nanos":7334},"formatted_output":"tests ran\n"},"started_at_ms":1794234513019,"completed_at_ms":1794234513019}}
{"timestamp":"2026-11-09T14:28:33.021Z","ordinal":24,"type":"response_item","payload":{"type":"custom_tool_call_output","id":"ctco_01a1c0b5-f67d-7333-aa3f-252e45da435a","call_id":"call_7d324c468ba742f1a40e8e79c8141b07","output":[{"type":"input_text","text":"Script completed\nWall time 0.0 seconds\nOutput:\n"},{"type":"input_text","text":"{\"chunk_id\":\"1c6109\",\"wall_time_seconds\":0.000007334,\"exit_code\":0,\"original_token_count\":3,\"output\":\"tests ran\\n\"}"}],"internal_chat_message_metadata_passthrough":{"turn_id":"01a1c0b5-f621-7033-883b-9279fdc61e3b","create_time":1794234513.021633}},"metadata":{"client_authored":false,"fallback_token_limit_override":12000}}
{"timestamp":"2026-11-09T14:28:33.021Z","ordinal":25,"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":200,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":10,"reasoning_output_tokens":0,"total_tokens":210},"last_token_usage":{"input_tokens":100,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0,"total_tokens":105},"model_context_window":258400},"rate_limits":{"limit_id":"codex","limit_name":null,"primary":null,"secondary":null,"credits":null,"individual_limit":null,"spend_control_reached":null,"plan_type":null,"rate_limit_reached_type":null}}}
{"timestamp":"2026-11-09T14:28:33.026Z","ordinal":26,"type":"event_msg","payload":{"type":"item_completed","thread_id":"01a1c0b5-f5db-7140-8021-694831838113","turn_id":"01a1c0b5-f621-7033-883b-9279fdc61e3b","item":{"type":"AgentMessage","id":"msg_3445c822b5a64c7595d06bf0a70fc1ef","content":[{"type":"Text","text":"Turn two: the tests pass."}]},"started_at_ms":1794234513026,"completed_at_ms":1794234513026}}
{"timestamp":"2026-11-09T14:28:33.026Z","ordinal":27,"type":"response_item","payload":{"type":"message","id":"msg_3445c822b5a64c7595d06bf0a70fc1ef","role":"assistant","content":[{"type":"output_text","text":"Turn two: the tests pass."}],"internal_chat_message_metadata_passthrough":{"turn_id":"01a1c0b5-f621-7033-883b-9279fdc61e3b","content_item_kinds":["unknown"]}},"metadata":{"retained_source":{"id":{"message_id":"msg_3445c822b5a64c7595d06bf0a70fc1ef","turn_id":"01a1c0b5-f621-7033-883b-9279fdc61e3b","role":"assistant"},"revision":"retained_01a1c0b5-f682-76c0-8dbb-5c22cc36b920","complete":true},"client_authored":false,"user_input_order":4}}
{"timestamp":"2026-11-09T14:28:33.026Z","ordinal":28,"type":"token_usage_record","payload":{"thread_id":"01a1c0b5-f5db-7140-8021-694831838113","turn_id":"01a1c0b5-f621-7033-883b-9279fdc61e3b","session_id":"01a1c0b5-f5db-7140-8021-694831838113","root_turn_id":"01a1c0b5-f621-7033-883b-9279fdc61e3b","response_id":"resp_c7543f1f1bb14c79924bd13fda714ccb","usage":{"input_tokens":100,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0,"total_tokens":105},"turn_token_usage":{"input_tokens":200,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":10,"reasoning_output_tokens":0,"total_tokens":210},"thread_token_usage":{"input_tokens":300,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":15,"reasoning_output_tokens":0,"total_tokens":315}}}
{"timestamp":"2026-11-09T14:28:33.027Z","ordinal":29,"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":300,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":15,"reasoning_output_tokens":0,"total_tokens":315},"last_token_usage":{"input_tokens":100,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0,"total_tokens":105},"model_context_window":258400},"rate_limits":{"limit_id":"codex","limit_name":null,"primary":null,"secondary":null,"credits":null,"individual_limit":null,"spend_control_reached":null,"plan_type":null,"rate_limit_reached_type":null}}}
{"timestamp":"2026-11-09T14:28:33.028Z","ordinal":30,"type":"event_msg","payload":{"type":"task_complete","turn_id":"01a1c0b5-f621-7033-883b-9279fdc61e3b","last_agent_message":"Turn two: the tests pass.","started_at":1794234512,"completed_at":1794234513,"duration_ms":98,"time_to_first_token_ms":12}}
{"timestamp":"2026-11-09T14:28:33.029Z","ordinal":31,"type":"event_msg","payload":{"type":"task_started","turn_id":"01a1c0b5-f685-7eb0-bcc7-25e9c6db937a","root_turn_id":"01a1c0b5-f685-7eb0-bcc7-25e9c6db937a","started_at":1794234513,"model_context_window":258400,"collaboration_mode_kind":"default"}}
{"timestamp":"2026-11-09T14:28:33.032Z","ordinal":32,"type":"turn_context","payload":{"turn_id":"01a1c0b5-f685-7eb0-bcc7-25e9c6db937a","root_turn_id":"01a1c0b5-f685-7eb0-bcc7-25e9c6db937a","disabled_plugin_ids":[],"cwd":"/private/tmp/agflow-rollout/clone","workspace_roots":["/private/tmp/agflow-rollout/clone","/private/tmp/agflow-rollout/clone/.git"],"current_date":"2026-11-09","timezone":"Europe/Moscow","approval_policy":"on-request","approvals_reviewer":"user","sandbox_policy":{"type":"workspace-write","writable_roots":["/private/tmp/agflow-rollout/clone/.git"],"network_access":false,"exclude_tmpdir_env_var":true,"exclude_slash_tmp":true},"permission_profile":{"type":"managed","file_system":{"type":"restricted","entries":[{"path":{"type":"special","value":{"kind":"root"}},"access":"read"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone"},"access":"write"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.git"},"access":"write"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.git"},"access":"write"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.git"},"access":"read","missing_path_behavior":"skip"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.git/.git"},"access":"read","missing_path_behavior":"skip"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.agents"},"access":"read","missing_path_behavior":"skip"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.git/.agents"},"access":"read","missing_path_behavior":"skip"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.codex"},"access":"read","missing_path_behavior":"skip"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.git/.codex"},"access":"read","missing_path_behavior":"skip"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.aws"},"access":"read","missing_path_behavior":"skip"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.git/.aws"},"access":"read","missing_path_behavior":"skip"}]},"network":"restricted"},"file_system_sandbox_policy":{"kind":"restricted","entries":[{"path":{"type":"special","value":{"kind":"root"}},"access":"read"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone"},"access":"write"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.git"},"access":"write"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.git"},"access":"write"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.git"},"access":"read","missing_path_behavior":"skip"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.git/.git"},"access":"read","missing_path_behavior":"skip"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.agents"},"access":"read","missing_path_behavior":"skip"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.git/.agents"},"access":"read","missing_path_behavior":"skip"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.codex"},"access":"read","missing_path_behavior":"skip"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.git/.codex"},"access":"read","missing_path_behavior":"skip"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.aws"},"access":"read","missing_path_behavior":"skip"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.git/.aws"},"access":"read","missing_path_behavior":"skip"}]},"model":"gpt-6.1-sol","comp_hash":"3000","collaboration_mode":{"mode":"default","settings":{"model":"gpt-6.1-sol","reasoning_effort":null,"developer_instructions":null}},"multi_agent_version":"v2","realtime_active":false,"summary":"none"}}
{"timestamp":"2026-11-09T14:28:33.036Z","ordinal":33,"type":"response_item","payload":{"type":"message","id":"msg_01a1c0b5-f68c-7733-8f70-895a5ab8cfb2","role":"user","content":[{"type":"input_text","text":"Prompt 3"}],"internal_chat_message_metadata_passthrough":{"turn_id":"01a1c0b5-f685-7eb0-bcc7-25e9c6db937a","create_time":1794234513.036611,"content_item_kinds":["user.text"]}},"metadata":{"retained_source":{"id":{"message_id":"msg_01a1c0b5-f68c-7733-8f70-895a5ab8cfb2","turn_id":"01a1c0b5-f685-7eb0-bcc7-25e9c6db937a","role":"user"},"revision":"retained_01a1c0b5-f68c-7733-8f70-89733a8f9032","complete":true},"client_authored":false,"user_input_order":5,"mcp_attribution":{"status":"none"}}}
{"timestamp":"2026-11-09T14:28:33.037Z","ordinal":34,"type":"event_msg","payload":{"type":"item_completed","thread_id":"01a1c0b5-f5db-7140-8021-694831838113","turn_id":"01a1c0b5-f685-7eb0-bcc7-25e9c6db937a","item":{"type":"UserMessage","id":"01a1c0b5-f68c-7733-8f70-89672e27a801","content":[{"type":"text","text":"Prompt 3","text_elements":[]}]},"started_at_ms":1794234513037,"completed_at_ms":1794234513037}}
{"timestamp":"2026-11-09T14:28:33.041Z","ordinal":35,"type":"response_item","payload":{"type":"custom_tool_call","id":"ctc_42d5fd411dec4698b8a99cf6537143aa","status":"completed","call_id":"call_02c6ed8ce261406081ee1c0df331cfc9","name":"exec","input":"// @exec: {\"yield_time_ms\":65000}\nconst deadline = Date.now() + 60000;\nlet result = await tools.exec_command({\"cmd\":\"echo checked\",\"yield_time_ms\":30000});\nlet output = result.output ?? '';\nwhile (result.exit_code === undefined && result.session_id !== undefined && Date.now() < deadline) {\n  result = await tools.write_stdin({ session_id: result.session_id, chars: '', yield_time_ms: Math.min(300000, Math.max(1000, deadline - Date.now())) });\n  output += result.output ?? '';\n}\ntext({ ...result, output });","internal_chat_message_metadata_passthrough":{"turn_id":"01a1c0b5-f685-7eb0-bcc7-25e9c6db937a"}}}
{"timestamp":"2026-11-09T14:28:33.042Z","ordinal":36,"type":"token_usage_record","payload":{"thread_id":"01a1c0b5-f5db-7140-8021-694831838113","turn_id":"01a1c0b5-f685-7eb0-bcc7-25e9c6db937a","session_id":"01a1c0b5-f5db-7140-8021-694831838113","root_turn_id":"01a1c0b5-f685-7eb0-bcc7-25e9c6db937a","response_id":"resp_2a8c3f4332294cc8832f030b888f1613","usage":{"input_tokens":100,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0,"total_tokens":105},"turn_token_usage":{"input_tokens":100,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0,"total_tokens":105},"thread_token_usage":{"input_tokens":400,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":20,"reasoning_output_tokens":0,"total_tokens":420}}}
{"timestamp":"2026-11-09T14:28:33.075Z","ordinal":37,"type":"event_msg","payload":{"type":"item_completed","thread_id":"01a1c0b5-f5db-7140-8021-694831838113","turn_id":"01a1c0b5-f685-7eb0-bcc7-25e9c6db937a","item":{"type":"CommandExecution","id":"exec-8ccc1fc3-0cd9-4389-999b-341c1ef23a95","process_id":"18642","command":["/bin/zsh","-c","echo checked"],"cwd":"file:///private/tmp/agflow-rollout/clone","parsed_cmd":[{"type":"unknown","cmd":"echo checked"}],"source":"unified_exec_startup","status":"completed","stdout":"checked\n","stderr":"","aggregated_output":"checked\n","exit_code":0,"duration":{"secs":0,"nanos":7500},"formatted_output":"checked\n"},"started_at_ms":1794234513075,"completed_at_ms":1794234513075}}
{"timestamp":"2026-11-09T14:28:33.077Z","ordinal":38,"type":"response_item","payload":{"type":"custom_tool_call_output","id":"ctco_01a1c0b5-f6b5-7542-a188-0cdb65475fc5","call_id":"call_02c6ed8ce261406081ee1c0df331cfc9","output":[{"type":"input_text","text":"Script completed\nWall time 0.0 seconds\nOutput:\n"},{"type":"input_text","text":"{\"chunk_id\":\"707907\",\"wall_time_seconds\":0.0000075,\"exit_code\":0,\"original_token_count\":2,\"output\":\"checked\\n\"}"}],"internal_chat_message_metadata_passthrough":{"turn_id":"01a1c0b5-f685-7eb0-bcc7-25e9c6db937a","create_time":1794234513.077431}},"metadata":{"client_authored":false,"fallback_token_limit_override":12000}}
{"timestamp":"2026-11-09T14:28:33.077Z","ordinal":39,"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":400,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":20,"reasoning_output_tokens":0,"total_tokens":420},"last_token_usage":{"input_tokens":100,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0,"total_tokens":105},"model_context_window":258400},"rate_limits":{"limit_id":"codex","limit_name":null,"primary":null,"secondary":null,"credits":null,"individual_limit":null,"spend_control_reached":null,"plan_type":null,"rate_limit_reached_type":null}}}
{"timestamp":"2026-11-09T14:28:33.082Z","ordinal":40,"type":"event_msg","payload":{"type":"item_completed","thread_id":"01a1c0b5-f5db-7140-8021-694831838113","turn_id":"01a1c0b5-f685-7eb0-bcc7-25e9c6db937a","item":{"type":"AgentMessage","id":"msg_f5a42302d6f845508bc64e2a653184a3","content":[{"type":"Text","text":"Turn three: \"quoted\" text\nwith a second line."}]},"started_at_ms":1794234513082,"completed_at_ms":1794234513082}}
{"timestamp":"2026-11-09T14:28:33.082Z","ordinal":41,"type":"response_item","payload":{"type":"message","id":"msg_f5a42302d6f845508bc64e2a653184a3","role":"assistant","content":[{"type":"output_text","text":"Turn three: \"quoted\" text\nwith a second line."}],"internal_chat_message_metadata_passthrough":{"turn_id":"01a1c0b5-f685-7eb0-bcc7-25e9c6db937a","content_item_kinds":["unknown"]}},"metadata":{"retained_source":{"id":{"message_id":"msg_f5a42302d6f845508bc64e2a653184a3","turn_id":"01a1c0b5-f685-7eb0-bcc7-25e9c6db937a","role":"assistant"},"revision":"retained_01a1c0b5-f6ba-73d0-9dc1-cb0cbf664b8e","complete":true},"client_authored":false,"user_input_order":6}}
{"timestamp":"2026-11-09T14:28:33.083Z","ordinal":42,"type":"token_usage_record","payload":{"thread_id":"01a1c0b5-f5db-7140-8021-694831838113","turn_id":"01a1c0b5-f685-7eb0-bcc7-25e9c6db937a","session_id":"01a1c0b5-f5db-7140-8021-694831838113","root_turn_id":"01a1c0b5-f685-7eb0-bcc7-25e9c6db937a","response_id":"resp_fd912465cdf8483f8f85d9f91a5b4d89","usage":{"input_tokens":100,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0,"total_tokens":105},"turn_token_usage":{"input_tokens":200,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":10,"reasoning_output_tokens":0,"total_tokens":210},"thread_token_usage":{"input_tokens":500,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":25,"reasoning_output_tokens":0,"total_tokens":525}}}
{"timestamp":"2026-11-09T14:28:33.083Z","ordinal":43,"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":500,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":25,"reasoning_output_tokens":0,"total_tokens":525},"last_token_usage":{"input_tokens":100,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0,"total_tokens":105},"model_context_window":258400},"rate_limits":{"limit_id":"codex","limit_name":null,"primary":null,"secondary":null,"credits":null,"individual_limit":null,"spend_control_reached":null,"plan_type":null,"rate_limit_reached_type":null}}}
{"timestamp":"2026-11-09T14:28:33.084Z","ordinal":44,"type":"event_msg","payload":{"type":"task_complete","turn_id":"01a1c0b5-f685-7eb0-bcc7-25e9c6db937a","last_agent_message":"Turn three: \"quoted\" text\nwith a second line.","started_at":1794234513,"completed_at":1794234513,"duration_ms":55,"time_to_first_token_ms":11}}
{"timestamp":"2026-11-09T14:28:33.086Z","ordinal":45,"type":"event_msg","payload":{"type":"task_started","turn_id":"01a1c0b5-f6bd-79f1-b6d0-43d2f44cb8e7","root_turn_id":"01a1c0b5-f6bd-79f1-b6d0-43d2f44cb8e7","started_at":1794234513,"model_context_window":258400,"collaboration_mode_kind":"default"}}
{"timestamp":"2026-11-09T14:28:33.089Z","ordinal":46,"type":"turn_context","payload":{"turn_id":"01a1c0b5-f6bd-79f1-b6d0-43d2f44cb8e7","root_turn_id":"01a1c0b5-f6bd-79f1-b6d0-43d2f44cb8e7","disabled_plugin_ids":[],"cwd":"/private/tmp/agflow-rollout/clone","workspace_roots":["/private/tmp/agflow-rollout/clone","/private/tmp/agflow-rollout/clone/.git"],"current_date":"2026-11-09","timezone":"Europe/Moscow","approval_policy":"on-request","approvals_reviewer":"user","sandbox_policy":{"type":"workspace-write","writable_roots":["/private/tmp/agflow-rollout/clone/.git"],"network_access":false,"exclude_tmpdir_env_var":true,"exclude_slash_tmp":true},"permission_profile":{"type":"managed","file_system":{"type":"restricted","entries":[{"path":{"type":"special","value":{"kind":"root"}},"access":"read"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone"},"access":"write"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.git"},"access":"write"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.git"},"access":"write"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.git"},"access":"read","missing_path_behavior":"skip"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.git/.git"},"access":"read","missing_path_behavior":"skip"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.agents"},"access":"read","missing_path_behavior":"skip"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.git/.agents"},"access":"read","missing_path_behavior":"skip"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.codex"},"access":"read","missing_path_behavior":"skip"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.git/.codex"},"access":"read","missing_path_behavior":"skip"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.aws"},"access":"read","missing_path_behavior":"skip"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.git/.aws"},"access":"read","missing_path_behavior":"skip"}]},"network":"restricted"},"file_system_sandbox_policy":{"kind":"restricted","entries":[{"path":{"type":"special","value":{"kind":"root"}},"access":"read"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone"},"access":"write"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.git"},"access":"write"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.git"},"access":"write"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.git"},"access":"read","missing_path_behavior":"skip"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.git/.git"},"access":"read","missing_path_behavior":"skip"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.agents"},"access":"read","missing_path_behavior":"skip"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.git/.agents"},"access":"read","missing_path_behavior":"skip"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.codex"},"access":"read","missing_path_behavior":"skip"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.git/.codex"},"access":"read","missing_path_behavior":"skip"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.aws"},"access":"read","missing_path_behavior":"skip"},{"path":{"type":"path","path":"/private/tmp/agflow-rollout/clone/.git/.aws"},"access":"read","missing_path_behavior":"skip"}]},"model":"gpt-6.1-sol","comp_hash":"3000","collaboration_mode":{"mode":"default","settings":{"model":"gpt-6.1-sol","reasoning_effort":null,"developer_instructions":null}},"multi_agent_version":"v2","realtime_active":false,"summary":"none"}}
{"timestamp":"2026-11-09T14:28:33.094Z","ordinal":47,"type":"response_item","payload":{"type":"message","id":"msg_01a1c0b5-f6c6-7ca0-9f52-7a2e1d44b52c","role":"user","content":[{"type":"input_text","text":"Prompt 4"}],"internal_chat_message_metadata_passthrough":{"turn_id":"01a1c0b5-f6bd-79f1-b6d0-43d2f44cb8e7","create_time":1794234513.094621,"content_item_kinds":["user.text"]}},"metadata":{"retained_source":{"id":{"message_id":"msg_01a1c0b5-f6c6-7ca0-9f52-7a2e1d44b52c","turn_id":"01a1c0b5-f6bd-79f1-b6d0-43d2f44cb8e7","role":"user"},"revision":"retained_01a1c0b5-f6c6-7ca0-9f52-7a4f3eacb3e7","complete":true},"client_authored":false,"user_input_order":7,"mcp_attribution":{"status":"none"}}}
{"timestamp":"2026-11-09T14:28:33.095Z","ordinal":48,"type":"event_msg","payload":{"type":"item_completed","thread_id":"01a1c0b5-f5db-7140-8021-694831838113","turn_id":"01a1c0b5-f6bd-79f1-b6d0-43d2f44cb8e7","item":{"type":"UserMessage","id":"01a1c0b5-f6c6-7ca0-9f52-7a3194711501","content":[{"type":"text","text":"Prompt 4","text_elements":[]}]},"started_at_ms":1794234513095,"completed_at_ms":1794234513095}}
{"timestamp":"2026-11-09T14:28:33.099Z","ordinal":49,"type":"event_msg","payload":{"type":"item_completed","thread_id":"01a1c0b5-f5db-7140-8021-694831838113","turn_id":"01a1c0b5-f6bd-79f1-b6d0-43d2f44cb8e7","item":{"type":"AgentMessage","id":"msg_40f2d30e34314019adf27029d4eefd7f","content":[{"type":"Text","text":"Turn four: done."}]},"started_at_ms":1794234513099,"completed_at_ms":1794234513099}}
{"timestamp":"2026-11-09T14:28:33.100Z","ordinal":50,"type":"response_item","payload":{"type":"message","id":"msg_40f2d30e34314019adf27029d4eefd7f","role":"assistant","content":[{"type":"output_text","text":"Turn four: done."}],"internal_chat_message_metadata_passthrough":{"turn_id":"01a1c0b5-f6bd-79f1-b6d0-43d2f44cb8e7","content_item_kinds":["unknown"]}},"metadata":{"retained_source":{"id":{"message_id":"msg_40f2d30e34314019adf27029d4eefd7f","turn_id":"01a1c0b5-f6bd-79f1-b6d0-43d2f44cb8e7","role":"assistant"},"revision":"retained_01a1c0b5-f6cc-7f32-aa50-f198d6ec68c3","complete":true},"client_authored":false,"user_input_order":8}}
{"timestamp":"2026-11-09T14:28:33.100Z","ordinal":51,"type":"token_usage_record","payload":{"thread_id":"01a1c0b5-f5db-7140-8021-694831838113","turn_id":"01a1c0b5-f6bd-79f1-b6d0-43d2f44cb8e7","session_id":"01a1c0b5-f5db-7140-8021-694831838113","root_turn_id":"01a1c0b5-f6bd-79f1-b6d0-43d2f44cb8e7","response_id":"resp_b209a6442daf46758442cc5f3448a134","usage":{"input_tokens":100,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0,"total_tokens":105},"turn_token_usage":{"input_tokens":100,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0,"total_tokens":105},"thread_token_usage":{"input_tokens":600,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":30,"reasoning_output_tokens":0,"total_tokens":630}}}
{"timestamp":"2026-11-09T14:28:33.101Z","ordinal":52,"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":600,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":30,"reasoning_output_tokens":0,"total_tokens":630},"last_token_usage":{"input_tokens":100,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0,"total_tokens":105},"model_context_window":258400},"rate_limits":{"limit_id":"codex","limit_name":null,"primary":null,"secondary":null,"credits":null,"individual_limit":null,"spend_control_reached":null,"plan_type":null,"rate_limit_reached_type":null}}}
{"timestamp":"2026-11-09T14:28:33.102Z","ordinal":53,"type":"event_msg","payload":{"type":"task_complete","turn_id":"01a1c0b5-f6bd-79f1-b6d0-43d2f44cb8e7","last_agent_message":"Turn four: done.","started_at":1794234513,"completed_at":1794234513,"duration_ms":16,"time_to_first_token_ms":13}}
````

**File:** `packages/runner/test/codex/transcript.test.ts` (new)

```ts
import { afterEach, describe, expect, test } from 'bun:test';
import { AGFLOW_VERSION } from '@agflow/core';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CODEX_VERSION } from '../../src/adapters/codex/binary';
import { appServerArgs } from '../../src/adapters/codex/config';
import { RpcError, RpcTimeout } from '../../src/adapters/codex/rpc';
import { deleteCodexTranscript, readCodexTranscriptTail } from '../../src/adapters/codex/transcript';
import { RunnerConfigSchema, vendorHomes } from '../../src/config';
import { runnerPaths } from '../../src/paths';
import { vendorBinary } from '../../src/vendor/pins';
import { codexScenario, readCodexRecord, writeCodexShim, type ScriptedAnswer } from './peer';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const sessionRef = '01a1c0b5-f5db-7140-8021-694831838113';
const recorded = readFileSync(join(import.meta.dir, 'fixtures/rollout.jsonl'), 'utf8');
const expected =
  'Turn two: running the tests first.\nTurn two: the tests pass.\n\n' +
  'Turn three: "quoted" text\nwith a second line.\n\nTurn four: done.';

function tempHome(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agflow-codex-transcript-')));
  dirs.push(dir);
  return dir;
}

function rollout(home: string, text = recorded, id = sessionRef, date = '2026/11/09'): void {
  const dir = join(home, 'sessions', date);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `rollout-2026-11-09T17-28-32-${id}.jsonl`), text);
}

function message(text: string) {
  return {
    type: 'response_item',
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
  };
}

const started = { type: 'event_msg', payload: { type: 'task_started' } };
const jsonl = (records: unknown[]) => records.map((record) => JSON.stringify(record)).join('\n') + '\n';

describe('readCodexTranscriptTail', () => {
  test('reads exactly the last three assistant turns from the recorded rollout, keeping the end when clipped', async () => {
    const codexHome = tempHome();
    rollout(codexHome);
    expect(await readCodexTranscriptTail({ codexHome, sessionRef, maxChars: 4000 })).toBe(expected);
    expect(await readCodexTranscriptTail({ codexHome, sessionRef, maxChars: 24 })).toBe(expected.slice(-24));
    expect(await readCodexTranscriptTail({ codexHome, sessionRef, maxChars: 0 })).toBe('');
  });

  test('includes text before task_started and fewer than three nonempty turns, joining only output_text parts', async () => {
    const codexHome = tempHome();
    rollout(
      codexHome,
      jsonl([
        message('Before the first turn'),
        started,
        {
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [
              { type: 'output_text', text: 'First ' },
              { type: 'input_text', text: 'hidden' },
              null,
              { type: 'output_text', text: 42 },
              { type: 'output_text', text: 'message' },
            ],
          },
        },
        message('Second message'),
        started,
        message(''),
        started,
      ]),
    );
    expect(await readCodexTranscriptTail({ codexHome, sessionRef, maxChars: 4000 })).toBe(
      'Before the first turn\n\nFirst message\nSecond message',
    );
  });

  test('empty turns do not displace the last three turns with assistant text', async () => {
    const codexHome = tempHome();
    rollout(codexHome, recorded + jsonl([started, message(''), started, started]));
    expect(await readCodexTranscriptTail({ codexHome, sessionRef, maxChars: 4000 })).toBe(expected);
  });

  test('a file without assistant text returns an empty string', async () => {
    const codexHome = tempHome();
    rollout(
      codexHome,
      jsonl([
        started,
        {
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Prompt' }],
          },
        },
        { type: 'event_msg', payload: { type: 'item_completed', text: 'not assistant text' } },
      ]),
    );
    expect(await readCodexTranscriptTail({ codexHome, sessionRef, maxChars: 4000 })).toBe('');
  });

  test('skips malformed lines and shapes inserted into the recorded rollout', async () => {
    const codexHome = tempHome();
    const bad =
      'not JSON\n' +
      jsonl([
        null,
        42,
        'text',
        [],
        { type: 'response_item' },
        { type: 'response_item', payload: { type: 'message', role: 'assistant', content: 'wrong' } },
        { type: 'response_item', payload: null },
        { type: 'event_msg', payload: [] },
      ]);
    rollout(codexHome, recorded.split('\n').join('\n' + bad));
    expect(await readCodexTranscriptTail({ codexHome, sessionRef, maxChars: 4000 })).toBe(expected);
  });

  test('never reads another thread, including longer ids with the same suffix or other creation dates', async () => {
    const codexHome = tempHome();
    const foreign = jsonl([started, message('Another thread must never appear')]);
    rollout(codexHome, foreign, 'different-thread');
    rollout(codexHome, foreign, `x${sessionRef}`);
    rollout(codexHome, foreign, `other-${sessionRef}`);
    rollout(codexHome, foreign, 'subagent-thread', '2025/01/02');
    expect(await readCodexTranscriptTail({ codexHome, sessionRef, maxChars: 4000 })).toBeNull();
    rollout(codexHome);
    expect(await readCodexTranscriptTail({ codexHome, sessionRef, maxChars: 4000 })).toBe(expected);
    expect(await readCodexTranscriptTail({ codexHome, sessionRef: 'missing', maxChars: 4000 })).toBeNull();
    expect(await readCodexTranscriptTail({ codexHome, sessionRef: '../../../outside', maxChars: 4000 })).toBeNull();
  });

  test('returns null without a sessions directory', async () => {
    expect(await readCodexTranscriptTail({ codexHome: tempHome(), sessionRef, maxChars: 4000 })).toBeNull();
  });

  test('finds the thread under an older creation date', async () => {
    const codexHome = tempHome();
    rollout(codexHome, recorded, sessionRef, '2025/01/02');
    expect(await readCodexTranscriptTail({ codexHome, sessionRef, maxChars: 4000 })).toBe(expected);
  });

  test('does not leave a low surrogate when clipping through a pair', async () => {
    const codexHome = tempHome();
    rollout(codexHome, jsonl([message('prefix😀end')]));
    expect(await readCodexTranscriptTail({ codexHome, sessionRef, maxChars: 4 })).toBe('end');
    expect(await readCodexTranscriptTail({ codexHome, sessionRef, maxChars: 5 })).toBe('😀end');
  });
});

function setup(answer: ScriptedAnswer<'thread/delete'> = { result: {} }) {
  const paths = runnerPaths(join(tempHome(), 'agflow'));
  const bin = join(paths.runner, vendorBinary('codex', CODEX_VERSION));
  writeCodexShim(bin, codexScenario({ answers: { 'thread/delete': answer } }));
  const input: Parameters<typeof deleteCodexTranscript>[0] = {
    sessionRef,
    paths,
    config: RunnerConfigSchema.parse({
      runnerKey: 'runner',
      machineId: 'machine',
      name: 'test',
      capturedPath: '/usr/bin:/bin',
    }),
    env: {},
    requestTimeoutMs: 200,
  };
  return { bin, input };
}

function ended(bin: string) {
  const runs = readCodexRecord(bin);
  expect(runs).toHaveLength(1);
  expect(runs[0]?.exit).toMatchObject({ reason: 'eof', code: 0, signal: null });
  return runs[0]!;
}

describe('deleteCodexTranscript', () => {
  test('initializes the current pin, deletes the thread, and ends the process in the runner homes', async () => {
    const { bin, input } = setup();
    await deleteCodexTranscript(input);
    const run = ended(bin);
    expect(run.requests.map(({ method, params }) => ({ method, params }))).toEqual([
      {
        method: 'initialize',
        params: { clientInfo: { name: 'agflow', title: null, version: AGFLOW_VERSION }, capabilities: null },
      },
      { method: 'thread/delete', params: { threadId: sessionRef } },
    ]);
    expect(run.env).toEqual({
      PATH: '/usr/bin:/bin',
      CODEX_HOME: vendorHomes(input.config, input.paths).codex,
      HOME: input.paths.homes.codexUser,
      GIT_DIR: '/dev/null',
    });
    expect(run.cwd).toBe(input.paths.homes.codexUser);
    expect(run.argv).toEqual(appServerArgs(null));
    for (const home of [run.env.CODEX_HOME!, run.env.HOME!]) expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(input.paths.logs, 'codex-transcripts.log'), 'utf8')).toContain('thread/delete');
  });

  test('uses the configured home, captured connectivity, and only allowed user variables', async () => {
    const { bin, input } = setup();
    input.config.homes.codex = join(tempHome(), 'custom-codex');
    input.config.connectivity = { HTTPS_PROXY: 'http://127.0.0.1:9', SSL_CERT_FILE: '/tmp/ca' };
    input.env = {
      USER: 'test',
      LOGNAME: 'test',
      LANG: 'C',
      SHELL: '/bin/zsh',
      LC_ALL: 'C',
      PATH: '/unwanted',
      HTTPS_PROXY: 'http://unwanted',
      HOME: '/unwanted',
      CODEX_HOME: '/unwanted',
      OPENAI_API_KEY: 'secret',
      AGFLOW_AGENT_TOKEN: 'secret',
      CODEX_MANAGED_TEST: '1',
    };
    await deleteCodexTranscript(input);
    expect(ended(bin).env).toEqual({
      PATH: '/usr/bin:/bin',
      ...input.config.connectivity,
      USER: 'test',
      LOGNAME: 'test',
      LANG: 'C',
      SHELL: '/bin/zsh',
      LC_ALL: 'C',
      CODEX_HOME: input.config.homes.codex,
      HOME: input.paths.homes.codexUser,
      GIT_DIR: '/dev/null',
    });
  });

  for (const enabled of [false, true]) {
    test(`test configuration overrides are ${enabled ? 'enabled' : 'ignored'} with AGFLOW_TEST=${enabled ? 1 : 0}`, async () => {
      const { bin, input } = setup();
      input.config.test = RunnerConfigSchema.parse({
        ...input.config,
        test: { codexConfig: { model_provider: 'scripted' } },
      }).test!;
      input.env = { AGFLOW_TEST: enabled ? '1' : '0' };
      await deleteCodexTranscript(input);
      expect(ended(bin).argv).toEqual(appServerArgs(enabled ? input.config.test.codexConfig : null));
    });
  }

  test('an already deleted rollout counts as success', async () => {
    const { bin, input } = setup({ error: { code: -32600, message: `no rollout found for thread id ${sessionRef}` } });
    await expect(deleteCodexTranscript(input)).resolves.toBeUndefined();
    ended(bin);
  });

  for (const error of [
    { code: -32600, message: 'cannot delete a running thread', data: { reason: 'busy' } },
    { code: -32603, message: `no rollout found for thread id ${sessionRef}` },
    { code: -32600, message: 'other error: no rollout found' },
  ]) {
    test(`rejects ${error.code}: ${error.message} and ends the process`, async () => {
      const { bin, input } = setup({ error });
      const result = deleteCodexTranscript(input);
      await expect(result).rejects.toBeInstanceOf(RpcError);
      await expect(result).rejects.toMatchObject({ ...error, method: 'thread/delete' });
      ended(bin);
    });
  }

  test('a request timeout rejects and ends the process', async () => {
    const { bin, input } = setup({ silent: true });
    await expect(deleteCodexTranscript(input)).rejects.toBeInstanceOf(RpcTimeout);
    ended(bin);
  });

  test('a missing binary rejects with binary missing', async () => {
    const { bin, input } = setup();
    rmSync(bin);
    await expect(deleteCodexTranscript(input)).rejects.toThrow('binary missing');
    expect(readCodexRecord(bin)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `bun test packages/runner/test/codex/transcript.test.ts`
Expected: FAIL — `error: Cannot find module '../../src/adapters/codex/transcript' from 'packages/runner/test/codex/transcript.test.ts'` (0 pass, 1 fail, 1 error)

- [ ] **Step 3: Implement**

**File:** `packages/runner/src/adapters/codex/transcript.ts` (new)

```ts
// Transcript operations without a live session (design 6.8, 7.8, 13).
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunnerConfig } from '../../config';
import type { Logger } from '../../log';
import type { RunnerPaths } from '../../paths';
import { vendorBinary } from '../../vendor/pins';
import { CODEX_VERSION } from './binary';
import { appServerArgs, appServerEnv } from './config';
import { codexProcessOptions } from './preflight';
import { openAppServer } from './process';
import { RpcError } from './rpc';

// Parse the timestamp boundary so even a longer thread id ending in `-<sessionRef>` cannot match.
const ROLLOUT_NAME = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/;
const DATE_PARTS = [/^\d{4}$/, /^\d{2}$/, /^\d{2}$/];

async function findRollout(dir: string, sessionRef: string, depth = 0): Promise<string | null> {
  const entries = await readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const entry of entries) {
    const datePart = DATE_PARTS[depth];
    if (datePart) {
      if (!entry.isDirectory() || !datePart.test(entry.name)) continue;
      const found = await findRollout(join(dir, entry.name), sessionRef, depth + 1);
      if (found) return found;
    } else if (entry.isFile() && entry.name.match(ROLLOUT_NAME)?.[1] === sessionRef) {
      return join(dir, entry.name);
    }
  }
  return null;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The rollout's assistant text of the last 3 turns that have any, cut from the front to maxChars; null without a file. */
export async function readCodexTranscriptTail(input: {
  codexHome: string;
  sessionRef: string;
  maxChars: number;
}): Promise<string | null> {
  const file = await findRollout(join(input.codexHome, 'sessions'), input.sessionRef);
  if (file === null) return null;
  const contents = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
    // Retention can delete the rollout between discovery and reading.
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (contents === null) return null;
  const turns: string[][] = [[]];
  let messages = turns[0]!;
  for (const line of contents.split('\n')) {
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!object(record) || !object(record.payload)) continue;
    const payload = record.payload;
    if (record.type === 'event_msg' && payload.type === 'task_started') {
      messages = [];
      turns.push(messages);
    } else if (
      record.type === 'response_item' &&
      payload.type === 'message' &&
      payload.role === 'assistant' &&
      Array.isArray(payload.content)
    ) {
      const text = payload.content
        .filter((part: unknown) => object(part) && part.type === 'output_text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('');
      if (text !== '') messages.push(text);
    }
  }
  const text = turns
    .filter((turn) => turn.length > 0)
    .slice(-3)
    .map((turn) => turn.join('\n'))
    .join('\n\n');
  let start = Math.max(0, text.length - Math.max(0, Math.floor(input.maxChars)));
  const before = text.charCodeAt(start - 1);
  const after = text.charCodeAt(start);
  if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) start += 1;
  return text.slice(start);
}

/** thread/delete through a short-lived app-server of the current pin; 'no rollout found' counts as deleted. */
export async function deleteCodexTranscript(input: {
  sessionRef: string;
  config: RunnerConfig;
  paths: RunnerPaths;
  /** Where AGFLOW_TEST and the user variables are read; process.env by default. */
  env?: Record<string, string | undefined>;
  logger?: Logger;
  /** Bounds each app-server request; tests pass a short one. */
  requestTimeoutMs?: number;
}): Promise<void> {
  const { paths, logger, requestTimeoutMs } = input;
  const { codexHome, userHome, base, codexConfig } = codexProcessOptions(input);
  await Promise.all([codexHome, userHome].map((home) => mkdir(home, { recursive: true, mode: 0o700 })));
  const app = await openAppServer({
    bin: join(paths.runner, vendorBinary('codex', CODEX_VERSION)),
    args: appServerArgs(codexConfig),
    env: appServerEnv({ base, bridgeEnv: {}, codexHome, userHome }),
    cwd: userHome,
    expectedVersion: CODEX_VERSION,
    logFile: join(paths.logs, 'codex-transcripts.log'),
    logger,
    requestTimeoutMs,
  });
  try {
    await app.rpc.request('thread/delete', { threadId: input.sessionRef });
  } catch (error) {
    if (!(error instanceof RpcError && error.code === -32600 && error.message.startsWith('no rollout found'))) {
      throw error;
    }
  } finally {
    await app.end();
  }
}
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `bun test packages/runner/test/codex/transcript.test.ts && bun test && bun run typecheck`
Expected: the task's tests pass (19 pass); then the whole suite passes (`0 fail`) and `tsc` exits 0.

`rollout.jsonl` is a real 0.159.2 recording against the scripted provider (four turns). Turns are split at `task_started`; a turn holds two assistant messages, the commentary and then the final message. The tail is cut from the front and never splits a surrogate pair. The rollout file is found by an exact match of the id in the file name, so a sessionRef never becomes part of a path. Deletion resolves its homes and environment through Task 10's `codexProcessOptions` and logs to `logs/codex-transcripts.log`.

- [ ] **Step 5: Commit**

```bash
git add -A 'packages/runner/src/adapters/codex/transcript.ts' 'packages/runner/test/codex/fixtures/rollout.jsonl' 'packages/runner/test/codex/transcript.test.ts'
git commit -m 'M2E Task 11: Transcript tail and transcript deletion' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

### Task 12: Session start: thread, start checks, naming and the first prompt

`CodexSession.start` for a new thread (design 9.2, 7.4, 13): app-server for `vendorBinary('codex', launch.cliVersion)` in the codex-user home, `initialize` checked against `launch.cliVersion` (X-13), and `thread/start` with `threadOverrides`. The fail-closed checks of section 9.2 follow: the thread must report on-request, the `user` reviewer, `workspaceWrite` without network and the clone as cwd; `mcpServerStatus/list { threadId }` must list only `agflow`, with a nonempty tool inventory containing every name in `launch.bridge.tools`, and no other server may report a startup status; `skills/list` must show no user or plugin skill; and no `configWarning` may arrive. The thread is named `agflow <attemptId>`, `started` is emitted, and the first `turn/start` carries only `launch.firstPrompt`. `developerInstructions` already contain the brief and tools note from `threadOverrides`. Missing names fail closed before naming or prompting; extra names emit a warning after `started`. An unverified project config runs the thread untrusted with one warning, and the start goes on (X-31).

**Files:**
- Create: `packages/runner/src/adapters/codex/session.ts`
- Test: `packages/runner/test/codex/session-fixture.ts`
- Test: `packages/runner/test/codex/session-start.test.ts`

- [ ] **Step 1: Write the failing tests**

**File:** `packages/runner/test/codex/session-fixture.ts` (new)

```ts
// What the CodexSession tests share: a launch in temp homes, a fake-peer shim at the launch's vendor binary path, the
// start-check answers that pass, and the assertions every failed start makes. Test files call cleanupSessions from
// afterEach.
import { expect } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRIDGE_TOOL_NAMES } from '../../src/adapters/bridge-tools';
import { CODEX_VERSION } from '../../src/adapters/codex/binary';
import type { ParamsOf, ResultOf } from '../../src/adapters/codex/methods';
import type { SkillMetadata } from '../../src/adapters/codex/protocol/v2';
import { CodexSession, type CodexSessionOptions } from '../../src/adapters/codex/session';
import type { AgentEvent, AgentLaunch } from '../../src/adapters/types';
import { standardProfile } from '../../src/profile';
import { vendorBinary } from '../../src/vendor/pins';
import { codexScenario, readCodexRecord, writeCodexShim, type CodexRun, type ScriptedAnswers } from './peer';

const dirs: string[] = [];
const pids: number[] = [];
/** Kills every app-server group the fixtures registered and removes their directories. */
export function cleanupSessions(): void {
  for (const pid of pids.splice(0)) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** The tools the fake agflow bridge lists, out of order: Codex lists them by name from a map. */
export const BRIDGE_TOOLS = [...BRIDGE_TOOL_NAMES.worker].reverse();

export function mcp(
  names = ['agflow'],
  nextCursor: string | null = null,
  tools: readonly string[] = BRIDGE_TOOLS,
): ResultOf<'mcpServerStatus/list'> {
  return {
    data: names.map((name) => ({
      name,
      runtimeStatus: 'connected',
      pluginId: null,
      httpOrigin: null,
      serverInfo: null,
      serverCapabilities: null,
      tools: Object.fromEntries(tools.map((tool) => [tool, { name: tool, inputSchema: { type: 'object' } }])),
      toolsError: null,
      resources: [],
      resourceTemplates: [],
      authStatus: 'unsupported',
    })),
    nextCursor,
  };
}

/** The first turn carries only the launch's prompt; the tool note is in developer instructions. */
export function firstInput(prompt: string): ParamsOf<'turn/start'>['input'] {
  return [{ type: 'text', text: prompt, text_elements: [] }];
}

export function skills(scope: SkillMetadata['scope'], pluginId: string | null = null): ResultOf<'skills/list'> {
  return {
    data: [
      {
        cwd: '/tmp',
        errors: [],
        skills: [{ name: 'example-skill', description: 'test', path: '/tmp/SKILL.md', scope, enabled: true, pluginId }],
      },
    ],
  };
}

export interface SessionFixture {
  options: CodexSessionOptions;
  launch: AgentLaunch;
  bin: string;
  /** registerProcess calls, which also assert that no output was read yet. */
  registrations: { pid: number; at: number }[];
  /** The peer's answers; change them, then call write(). */
  answers: ScriptedAnswers;
  write(): void;
}

/** A launch at version's binary whose start checks pass; resume makes it a resume launch of that thread. */
export function sessionFixture(
  input: { answers?: ScriptedAnswers; version?: string; resume?: string | null } = {},
): SessionFixture {
  const version = input.version ?? CODEX_VERSION;
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agflow-codex-session-')));
  dirs.push(dir);
  const options: CodexSessionOptions = {
    runnerDir: join(dir, 'runner'),
    codexHome: join(dir, 'codex-home'),
    userHome: join(dir, 'user-home'),
    requestTimeoutMs: 300,
  };
  const clone = join(dir, 'clone');
  for (const path of [clone, options.codexHome, options.userHome]) mkdirSync(path);
  const bin = join(options.runnerDir, vendorBinary('codex', version));
  const registrations: SessionFixture['registrations'] = [];
  const launch: AgentLaunch = {
    attemptId: 'T-42-a3',
    role: 'worker',
    model: 'requested-model',
    cliVersion: version,
    clone,
    baseCheckout: null,
    projectConfigVerified: true,
    tmpDir: join(clone, '.agflow/run/tmp'),
    env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' },
    bridge: {
      command: '/fake/agflow',
      args: ['mcp', '--vendor', 'codex', '--runner'],
      env: { AGFLOW_AGENT_TOKEN: 'test-token', AGFLOW_ATTEMPT_ID: 'T-42-a3', NODE_USE_SYSTEM_CA: '1' },
      tools: BRIDGE_TOOL_NAMES.worker,
    },
    profile: standardProfile,
    brief: 'Work in this clone.',
    firstPrompt: 'Please implement the task.\nRun tests.',
    resume: input.resume ? { sessionRef: input.resume } : null,
    logFile: join(dir, 'attempt.log'),
    registerProcess(pid) {
      pids.push(pid);
      registrations.push({ pid, at: Date.now() });
      expect(!existsSync(launch.logFile) || readFileSync(launch.logFile).length === 0).toBe(true);
      expect(readCodexRecord(bin)[0]?.initializedAt ?? null).toBeNull();
    },
  };
  const answers: ScriptedAnswers = {
    'mcpServerStatus/list': { result: mcp() },
    'skills/list': { result: skills('system') },
    ...input.answers,
  };
  const write = () => {
    writeCodexShim(bin, codexScenario({ version, stderr: ['session stderr'], answers }));
  };
  write();
  return { options, launch, bin, registrations, answers, write };
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A start that must fail: one line containing reason, one app-server run that has exited. */
export async function rejectedStart(f: SessionFixture, reason: string): Promise<CodexRun> {
  const error = await CodexSession.start(f.launch, f.options).then(
    () => null,
    (error: unknown) => error,
  );
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain(reason);
  expect((error as Error).message).not.toMatch(/[\r\n]|\s{2}/);
  const runs = readCodexRecord(f.bin);
  expect(runs).toHaveLength(1);
  expect(runs[0]!.exit).not.toBeNull();
  expect(alive(f.registrations[0]!.pid)).toBe(false);
  return runs[0]!;
}

export async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const result: AgentEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}
```

**File:** `packages/runner/test/codex/session-start.test.ts` (new)

```ts
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync, realpathSync } from 'node:fs';
import { BRIDGE_TOOL_NAMES } from '../../src/adapters/bridge-tools';
import { CODEX_VERSION } from '../../src/adapters/codex/binary';
import { appServerArgs, appServerEnv, codexToolsNote, threadOverrides } from '../../src/adapters/codex/config';
import type { ResultOf } from '../../src/adapters/codex/methods';
import type { ServerNotification } from '../../src/adapters/codex/protocol';
import { CodexSession } from '../../src/adapters/codex/session';
import {
  codexMessages as m,
  codexScenario,
  FAKE_THREAD_ID,
  readCodexRecord,
  writeCodexShim,
  type CodexRun,
  type ScriptedAnswers,
} from './peer';
import {
  alive,
  cleanupSessions,
  collect,
  firstInput,
  mcp,
  rejectedStart,
  sessionFixture,
  skills,
  type SessionFixture,
} from './session-fixture';

afterEach(cleanupSessions);

function setup(answers: ScriptedAnswers = {}, version = CODEX_VERSION): SessionFixture {
  return sessionFixture({ answers, version });
}

function startupStatus(threadId: string | null, name: string): ServerNotification {
  return {
    method: 'mcpServer/startupStatus/updated',
    params: { threadId, name, status: 'starting', error: null, failureReason: null },
  };
}

async function rejected(f: SessionFixture, reason: string, turnSent = false): Promise<CodexRun> {
  const run = await rejectedStart(f, reason);
  expect(run.requests.some((request) => request.method === 'turn/start')).toBe(turnSent);
  return run;
}

describe('CodexSession.start', () => {
  for (const version of [CODEX_VERSION, '0.158.0']) {
    test(`runs the attempt's ${version} binary with exact launch settings and ordered requests`, async () => {
      const f = setup({}, version);
      if (version !== CODEX_VERSION) f.options.testConfig = { model_provider: 'scripted' };
      const session = await CodexSession.start(f.launch, f.options);
      expect(alive(session.pid)).toBe(true);
      expect(session.sessionRef).toBe(FAKE_THREAD_ID);
      await session.close();
      expect(await session.exited).toEqual({ code: 0, signal: null });
      const [run] = readCodexRecord(f.bin);
      expect(run!.argv).toEqual(appServerArgs(f.options.testConfig));
      expect(run!.cwd).toBe(realpathSync(f.options.userHome));
      expect(run!.env).toEqual(
        appServerEnv({
          base: f.launch.env,
          bridgeEnv: f.launch.bridge.env,
          codexHome: f.options.codexHome,
          userHome: f.options.userHome,
        }),
      );
      expect(f.registrations).toHaveLength(1);
      expect(f.registrations[0]!.pid).toBe(session.pid);
      expect(f.registrations[0]!.at).toBeLessThanOrEqual(run!.initializedAt!);
      expect(readFileSync(f.launch.logFile, 'utf8')).toContain('session stderr\n');
      expect(run!.requests.map((request) => request.method)).toEqual([
        'initialize',
        'thread/start',
        'mcpServerStatus/list',
        'skills/list',
        'thread/name/set',
        'turn/start',
      ]);
      expect(run!.requests.slice(1).map((request) => request.params)).toEqual([
        threadOverrides(f.launch, f.options.userHome),
        { threadId: session.sessionRef },
        { cwds: [f.launch.clone] },
        { threadId: session.sessionRef, name: 'agflow T-42-a3' },
        { threadId: session.sessionRef, input: firstInput(f.launch.firstPrompt) },
      ]);
      expect(await collect(session.events)).toEqual([
        {
          type: 'started',
          sessionRef: session.sessionRef,
          model: f.launch.model,
          cliVersion: version,
          permissionMode: 'on-request',
        },
      ]);
    });
  }

  for (const role of ['worker', 'lead'] as const) {
    test(`${role} tools persist in developer instructions and the first prompt stays unchanged`, async () => {
      const tools = BRIDGE_TOOL_NAMES[role];
      const f = setup({ 'mcpServerStatus/list': { result: mcp(['agflow'], null, [...tools].reverse()) } });
      f.launch.role = role;
      f.launch.bridge.tools = tools;
      const session = await CodexSession.start(f.launch, f.options);
      await session.close();
      const { requests } = readCodexRecord(f.bin)[0]!;
      const start = requests.find((request) => request.method === 'thread/start');
      expect(start!.params).toHaveProperty('developerInstructions', `${f.launch.brief}\n\n${codexToolsNote(tools)}`);
      const turn = requests.find((request) => request.method === 'turn/start');
      expect(turn!.params).toEqual({ threadId: session.sessionRef, input: firstInput(f.launch.firstPrompt) });
    });
  }

  test('rejects a nonempty bridge listing missing a required tool before prompting', async () => {
    const tools = BRIDGE_TOOL_NAMES.worker.filter((name) => name !== 'submit');
    await rejected(setup({ 'mcpServerStatus/list': { result: mcp(['agflow'], null, tools) } }),
      'codex thread is missing agflow tools: submit');
  });

  test('warns about extra tools without adding them to developer instructions', async () => {
    const f = setup({ 'mcpServerStatus/list': { result: mcp(['agflow'], null, [...BRIDGE_TOOL_NAMES.worker, 'extra']) } });
    const session = await CodexSession.start(f.launch, f.options);
    await session.close();
    expect(await collect(session.events)).toContainEqual({ type: 'warning', text: 'codex thread lists extra agflow tools: extra' });
    expect(readCodexRecord(f.bin)[0]!.requests[1]!.params).toHaveProperty(
      'developerInstructions', `${f.launch.brief}\n\n${codexToolsNote(f.launch.bridge.tools)}`,
    );
  });

  for (const toolsError of [null, 'tools/list failed\n  bridge said no']) {
    test(`rejects an agflow server that lists no tools (toolsError ${JSON.stringify(toolsError)})`, async () => {
      const listing = mcp(['agflow'], null, []);
      listing.data[0]!.toolsError = toolsError;
      const reason = 'codex thread lists no agflow tools' + (toolsError ? ': tools/list failed bridge said no' : '');
      await rejected(setup({ 'mcpServerStatus/list': { result: listing } }), reason);
    });
  }

  test('rejects an initialize version mismatch before opening a thread', async () => {
    const f = setup({
      initialize: { result: m.initializeResult('0.1.0', { name: 'agflow', version: 'test' }, '/tmp') },
    });
    const run = await rejected(f, `reports version 0.1.0, expected ${CODEX_VERSION}`);
    expect(run.requests.map((request) => request.method)).toEqual(['initialize']);
  });

  const badResponses: [string, Partial<ResultOf<'thread/start'>>, string][] = [
    ['approval policy', { approvalPolicy: 'never' }, 'approval policy'],
    ['reviewer', { approvalsReviewer: 'guardian_subagent' }, 'reviewer'],
    ['sandbox type', { sandbox: { type: 'readOnly', networkAccess: false } }, 'expected workspaceWrite'],
    ['sandbox type and network', { sandbox: { type: 'dangerFullAccess' } }, 'sandbox'],
    [
      'sandbox network',
      {
        sandbox: {
          type: 'workspaceWrite',
          writableRoots: [],
          networkAccess: true,
          excludeTmpdirEnvVar: true,
          excludeSlashTmp: true,
        },
      },
      'network',
    ],
    ['cwd', { cwd: '/wrong\n  clone' }, 'cwd'],
  ];
  for (const [name, patch, reason] of badResponses) {
    test(`rejects a thread reporting the wrong ${name}`, async () => {
      const f = setup();
      f.answers['thread/start'] = {
        result: { ...m.threadStartResult({ thread: m.thread({ id: FAKE_THREAD_ID, cwd: f.launch.clone }) }), ...patch },
      };
      f.write();
      await rejected(f, reason);
    });
  }

  for (const names of [[], ['other\n server'], ['agflow', 'other'], ['agflow', 'agflow']]) {
    test(`rejects unexpected MCP inventory ${JSON.stringify(names)}`, async () => {
      await rejected(setup({ 'mcpServerStatus/list': { result: mcp(names) } }), 'MCP servers');
    });
  }
  test('rejects an incomplete MCP inventory', async () => {
    await rejected(setup({ 'mcpServerStatus/list': { result: mcp(['agflow'], 'more') } }), 'MCP');
  });
  // 0.159.2 lists neither a starting nor a failed server, so a trusted project config's server shows up only in its
  // startup status, which the thread sends before thread/start answers.
  for (const threadId of [FAKE_THREAD_ID, null]) {
    test(`rejects an MCP server that only a startup status shows (threadId ${threadId})`, async () => {
      const f = setup({
        initialize: {
          then: [
            { delayMs: 10 },
            { notify: startupStatus(threadId, 'agflow') },
            { notify: startupStatus(threadId, 'planted') },
          ],
        },
        'thread/start': { delayMs: 50 },
      });
      await rejected(f, 'codex thread started unexpected MCP servers: planted');
    });
  }
  test("accepts agflow's startup status and ignores another thread's", async () => {
    const f = setup({
      initialize: {
        then: [
          { delayMs: 10 },
          { notify: startupStatus(FAKE_THREAD_ID, 'agflow') },
          { notify: startupStatus('another-thread', 'planted') },
        ],
      },
      'thread/start': { delayMs: 50 },
    });
    const session = await CodexSession.start(f.launch, f.options);
    await session.close();
  });
  for (const [scope, pluginId] of [
    ['user', null],
    ['system', 'plugin'],
    ['repo', 'plugin'],
  ] as const) {
    test(`rejects ${scope} skills with pluginId ${pluginId}`, async () => {
      await rejected(
        setup({ 'skills/list': { result: skills(scope, pluginId) } }),
        'user or plugin skills: example-skill',
      );
    });
  }

  for (const method of [
    'thread/start',
    'mcpServerStatus/list',
    'skills/list',
    'thread/name/set',
    'turn/start',
  ] as const) {
    test(`ends the process when ${method} fails`, async () => {
      await rejected(
        setup({ [method]: { error: { code: -32603, message: 'required MCP servers failed\n  agflow exited' } } }),
        `${method} failed: required MCP servers failed agflow exited`,
        method === 'turn/start',
      );
    });
  }
  test('ends the process when thread/start times out', async () => {
    await rejected(setup({ 'thread/start': { silent: true } }), 'thread/start failed:');
  });
  test('rejects when the peer exits during thread/start', async () => {
    await rejected(setup({ 'thread/start': { silent: true, then: [{ crash: { code: 7 } }] } }), 'thread/start failed:');
  });

  for (const stage of ['thread/start', 'mcpServerStatus/list', 'skills/list'] as const) {
    test(`a configuration warning during ${stage} fails closed`, async () => {
      const f = setup();
      const then = [{ notify: m.configWarning('ignored setting\n  not_a_real_key') }];
      // Hold the checks open even if the warning is delivered separately from the preceding answer.
      if (stage === 'thread/start') {
        f.answers['thread/start'] = { then };
        f.answers['mcpServerStatus/list'] = { result: mcp(), delayMs: 30 };
      }
      if (stage === 'mcpServerStatus/list') {
        f.answers['mcpServerStatus/list'] = { result: mcp(), then };
        f.answers['skills/list'] = { result: skills('system'), delayMs: 30 };
      }
      if (stage === 'skills/list') {
        f.answers['mcpServerStatus/list'] = {
          result: mcp(),
          then: [{ delayMs: 10 }, { notify: m.configWarning('ignored setting\n  not_a_real_key') }],
        };
        f.answers['skills/list'] = { result: skills('system'), delayMs: 50 };
      }
      f.write();
      await rejected(f, 'configuration warning: ignored setting not_a_real_key');
    });
  }

  test('catches a configuration warning before thread/start answers', async () => {
    const f = setup({
      initialize: { then: [{ delayMs: 10 }, { notify: m.configWarning('ignored setting\n  before thread') }] },
      'thread/start': { delayMs: 50 },
    });
    await rejected(f, 'configuration warning: ignored setting before thread');
  });

  test('accepts repo skills, reports the returned model, and runs unverified project config untrusted', async () => {
    const f = setup({ 'skills/list': { result: skills('repo') } });
    f.launch.projectConfigVerified = false;
    f.answers['thread/start'] = {
      result: m.threadStartResult({
        thread: m.thread({ id: FAKE_THREAD_ID, cwd: f.launch.clone, model: 'reported-model' }),
      }),
    };
    f.write();
    const session = await CodexSession.start(f.launch, f.options);
    const iterator = session.events[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({
      type: 'started',
      sessionRef: FAKE_THREAD_ID,
      model: 'reported-model',
      cliVersion: CODEX_VERSION,
      permissionMode: 'on-request',
    });
    const warning = (await iterator.next()).value;
    expect(warning).toMatchObject({ type: 'warning' });
    expect(warning.text).toContain('.codex/');
    expect(warning.text).toContain('restore base');
    expect(warning.text).toContain('untrusted');
    expect(warning.text).toContain('skills still load');
    const pending = iterator.next();
    await session.close();
    expect(await pending).toEqual({ done: true, value: undefined });
    expect(await session.exited).toEqual({ code: 0, signal: null });
    const overrides = threadOverrides(f.launch, f.options.userHome);
    expect(readCodexRecord(f.bin)[0]!.requests[1]!.params).toEqual(overrides);
    expect(overrides.config.projects[f.launch.clone]!.trust_level).toBe('untrusted');
  });

  test('a sqlite startup exit rejects with its reason instead of registering a second process', async () => {
    const f = setup();
    writeCodexShim(f.bin, [
      codexScenario({ failBeforeInitialize: { stderr: 'Error: failed to initialize sqlite state runtime', code: 1 } }),
      codexScenario({ answers: f.answers }),
    ]);
    const registered: number[] = [];
    f.launch.registerProcess = (pid) => {
      // M2b's ProcessRegistration: a launch registers exactly one pid.
      if (registered.length > 0) throw new Error(`the agent of ${f.launch.attemptId} was already registered`);
      registered.push(pid);
    };
    await expect(CodexSession.start(f.launch, f.options)).rejects.toThrow('failed to initialize sqlite state runtime');
    expect(registered).toHaveLength(1);
    const runs = readCodexRecord(f.bin);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.exit?.code).toBe(1);
    expect(alive(registered[0]!)).toBe(false);
  });

  test('ends the event iterator on an unrequested process exit', async () => {
    const f = setup({ 'turn/start': { then: [{ delayMs: 30 }, { crash: { code: 7 } }] } });
    const session = await CodexSession.start(f.launch, f.options);
    expect(await collect(session.events)).toHaveLength(1);
    expect(await session.exited).toEqual({ code: 7, signal: null });
    await session.close();
  });
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `bun test packages/runner/test/codex/session-start.test.ts`
Expected: FAIL — `error: Cannot find module '../../src/adapters/codex/session' from 'packages/runner/test/codex/session-start.test.ts'` (0 pass, 1 fail, 1 error; observed in the 2026-11-11 parent replay).

- [ ] **Step 3: Implement**

**File:** `packages/runner/src/adapters/codex/session.ts` (new)

```ts
// New-thread startup and its fail-closed checks (design 9.2, 7.4).
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { RunnerTestBlock } from '../../config';
import type { Logger } from '../../log';
import { vendorBinary } from '../../vendor/pins';
import type { AgentEvent, AgentLaunch, ExitInfo } from '../types';
import { appServerArgs, appServerEnv, threadOverrides } from './config';
import type { CodexClientMethod, ParamsOf, ResultOf } from './methods';
import { openAppServer, type AppServerProcess } from './process';

export interface CodexSessionOptions {
  /** paths.runner: vendorBinary paths are relative to it. */
  runnerDir: string;
  /** The runner's CODEX_HOME and the app-server's HOME. */
  codexHome: string;
  userHome: string;
  /** Passed by the adapter only in test mode. */
  testConfig?: RunnerTestBlock['codexConfig'] | null;
  logger?: Logger;
  /** Bounds each app-server request; tests pass a short one. */
  requestTimeoutMs?: number;
}

export class CodexSession {
  readonly pid: number;
  readonly events: AsyncIterable<AgentEvent>;
  readonly exited: Promise<ExitInfo>;
  private readonly queue = new EventQueue();

  private constructor(
    private readonly app: AppServerProcess,
    readonly sessionRef: string,
  ) {
    this.pid = app.pid;
    this.events = this.queue;
    this.exited = app.exited;
    void this.exited.then(() => this.queue.end());
  }

  static async start(launch: AgentLaunch, options: CodexSessionOptions): Promise<CodexSession> {
    const app = await openAppServer({
      bin: join(options.runnerDir, vendorBinary('codex', launch.cliVersion)),
      args: appServerArgs(options.testConfig),
      env: appServerEnv({
        base: launch.env,
        bridgeEnv: launch.bridge.env,
        codexHome: options.codexHome,
        userHome: options.userHome,
      }),
      // The clone is only the thread's cwd (threadOverrides). Started in the clone, app-server reads its .codex/ before
      // any thread's trust applies and sends a startup configWarning, which would fail every such start.
      cwd: options.userHome,
      expectedVersion: launch.cliVersion,
      logFile: launch.logFile,
      onSpawn: (pid) => launch.registerProcess(pid),
      logger: options.logger,
      requestTimeoutMs: options.requestTimeoutMs,
    });
    let warning: string | null = null;
    const unsubscribeWarning = app.rpc.on('configWarning', ({ summary }) => {
      warning ??= `codex reported a configuration warning: ${summary}`;
    });
    // mcpServerStatus/list omits a server that is still starting or failed to start, such as one a trusted project
    // config adds: its startup status is the only trace. A thread starts every server before it answers.
    const startedServers: { threadId: string | null; name: string }[] = [];
    const unsubscribeStartup = app.rpc.onNotification((notification) => {
      if (notification.method !== 'mcpServer/startupStatus/updated') return;
      startedServers.push({ threadId: notification.params.threadId, name: notification.params.name });
    });
    const unsubscribe = () => {
      unsubscribeWarning();
      unsubscribeStartup();
    };
    try {
      const thread = await CodexSession.openThread(app, launch, options.userHome);
      const tools = await CodexSession.checkThread(app, launch, thread, startedServers);
      if (warning !== null) throw new Error(warning);
      unsubscribe();
      await request(app, 'thread/name/set', { threadId: thread.thread.id, name: `agflow ${launch.attemptId}` });
      const session = new CodexSession(app, thread.thread.id);
      // The controller starts consuming only after start resolves, so these must already be buffered.
      session.queue.push({
        type: 'started',
        sessionRef: session.sessionRef,
        model: thread.model,
        cliVersion: launch.cliVersion,
        permissionMode: 'on-request',
      });
      if (!launch.projectConfigVerified) {
        session.queue.push({
          type: 'warning',
          text: "The clone's .codex/ could not be verified against the restore base; the thread runs untrusted, so its project config, hooks and exec policies are not loaded (its skills still load).",
        });
      }
      if (tools.length > 0) {
        session.queue.push({ type: 'warning', text: `codex thread lists extra agflow tools: ${tools.join(', ')}` });
      }
      // The tools note is already in developerInstructions; the first turn carries only the launch prompt.
      await request(app, 'turn/start', {
        threadId: session.sessionRef,
        input: [{ type: 'text', text: launch.firstPrompt, text_elements: [] }],
      });
      return session;
    } catch (error) {
      await app.end();
      throw new Error(oneLine(warning ?? error));
    } finally {
      unsubscribe();
    }
  }

  async close(): Promise<void> {
    await this.app.end();
  }

  private static openThread(
    app: AppServerProcess,
    launch: AgentLaunch,
    bridgeCwd: string,
  ): Promise<ResultOf<'thread/start'>> {
    return request(app, 'thread/start', threadOverrides(launch, bridgeCwd));
  }

  /** Checks required tools against the live bridge; returns sorted extra names to warn about. */
  private static async checkThread(
    app: AppServerProcess,
    launch: AgentLaunch,
    thread: Pick<ResultOf<'thread/start'>, 'thread' | 'approvalPolicy' | 'approvalsReviewer' | 'sandbox' | 'cwd'>,
    startedServers: readonly { threadId: string | null; name: string }[],
  ): Promise<string[]> {
    if (thread.approvalPolicy !== 'on-request') {
      throw new Error(
        `codex thread/start reported approval policy ${JSON.stringify(thread.approvalPolicy)}, expected on-request`,
      );
    }
    if (thread.approvalsReviewer !== 'user') {
      throw new Error(`codex thread/start reported approvals reviewer ${thread.approvalsReviewer}, expected user`);
    }
    if (thread.sandbox.type !== 'workspaceWrite') {
      throw new Error(`codex thread/start reported sandbox ${thread.sandbox.type}, expected workspaceWrite`);
    }
    if (thread.sandbox.networkAccess !== false) {
      throw new Error('codex thread/start reported sandbox network access, expected no network');
    }
    if (thread.cwd !== realpathSync(launch.clone)) {
      throw new Error(`codex thread/start reported cwd ${thread.cwd}, expected ${realpathSync(launch.clone)}`);
    }
    const mcp = await request(app, 'mcpServerStatus/list', { threadId: thread.thread.id });
    // An incomplete inventory cannot establish that agflow is the only server.
    if (mcp.nextCursor !== null) throw new Error('codex thread lists an incomplete MCP server inventory');
    const agflow = mcp.data[0];
    if (mcp.data.length !== 1 || agflow?.name !== 'agflow') {
      throw new Error(
        `codex thread lists unexpected MCP servers: ${mcp.data.map((server) => server.name).join(', ') || '(none)'}`,
      );
    }
    // The bridge serves exactly the role's tools. Without any, the agent could neither report nor submit.
    const tools = Object.keys(agflow.tools).sort();
    if (tools.length === 0) {
      throw new Error(`codex thread lists no agflow tools${agflow.toolsError ? `: ${agflow.toolsError}` : ''}`);
    }
    const missing = launch.bridge.tools.filter((name) => !tools.includes(name));
    if (missing.length > 0) throw new Error(`codex thread is missing agflow tools: ${missing.join(', ')}`);
    // A status without a thread is the process's own server: no thread may have one either.
    const started = new Set(
      startedServers
        .filter((server) => server.threadId === null || server.threadId === thread.thread.id)
        .map((server) => server.name),
    );
    started.delete('agflow');
    if (started.size > 0) throw new Error(`codex thread started unexpected MCP servers: ${[...started].join(', ')}`);
    const skills = await request(app, 'skills/list', { cwds: [launch.clone] });
    const unexpected = skills.data
      .flatMap((entry) => entry.skills)
      .filter((skill) => skill.scope === 'user' || skill.pluginId !== null);
    if (unexpected.length > 0) {
      throw new Error(`codex thread lists user or plugin skills: ${unexpected.map((skill) => skill.name).join(', ')}`);
    }
    return tools.filter((name) => !launch.bridge.tools.includes(name));
  }
}

async function request<M extends CodexClientMethod>(
  app: AppServerProcess,
  method: M,
  params: ParamsOf<M>,
): Promise<ResultOf<M>> {
  try {
    return await app.rpc.request(method, params);
  } catch (error) {
    throw new Error(`codex ${method} failed: ${oneLine(error)}`);
  }
}

function oneLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim();
}

/** A single-consumer queue: exit ends waiting, but buffered events still drain. */
class EventQueue implements AsyncIterable<AgentEvent> {
  private readonly items: AgentEvent[] = [];
  private waiting: ((result: IteratorResult<AgentEvent>) => void) | null = null;
  private ended = false;

  push(event: AgentEvent): void {
    if (this.ended) return;
    const waiting = this.waiting;
    this.waiting = null;
    if (waiting) waiting({ value: event, done: false });
    else this.items.push(event);
  }

  end(): void {
    this.ended = true;
    const waiting = this.waiting;
    this.waiting = null;
    waiting?.({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.waiting = resolve;
        });
      },
    };
  }
}
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `bun test packages/runner/test/codex/session-start.test.ts && bun test && bun run typecheck`
Expected: the task's tests pass (40 pass); then the whole suite passes (`0 fail`) and `tsc` exits 0.

app-server runs in the codex-user home, never the clone: started in a clone holding `.codex/`, 0.159.2 sends a startup `configWarning` that would fail every such start. `mcpServerStatus/list {}` lists nothing after `thread/start`, so the check passes the thread id; the list also leaves out servers that are still starting or failed, which is why a startup status for any other server fails the start too (checked by Task 24). An empty listing or any missing name from `launch.bridge.tools` fails before naming or prompting; extra names emit a warning after `started`. `developerInstructions` already contain the brief and tools note from `threadOverrides`. The first `turn/start` carries only `launch.firstPrompt`. `session-fixture.ts` holds the setup Tasks 13-17 share and uses `BRIDGE_TOOL_NAMES.worker` for its fake inventory; `firstInput(prompt)` returns one text item with the prompt. Tests verify worker and lead notes, order-independent inventories, missing tools, and extra-tool warnings.

- [ ] **Step 5: Commit**

```bash
git add -A 'packages/runner/src/adapters/codex/session.ts' 'packages/runner/test/codex/session-fixture.ts' 'packages/runner/test/codex/session-start.test.ts'
git commit -m 'M2E Task 12: Session start: thread, start checks, naming and the first prompt' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

### Task 13: Session resume and the never-ran fallback

With `launch.resume`, the session reopens the thread with `thread/resume` and the same overrides, on the binary of the attempt's recorded CLI version (design 7.4, 9.2, 9.4, X-13), then runs the same checks. It neither renames the thread nor sends a prompt. Resuming in a new process after SIGKILL works, while a thread that never ran a turn answers -32600 'no rollout found for thread id …'. Only -32600 'no rollout found for thread id …' falls back to a fresh thread in the same process, with the same clone, the brief and tools note in developerInstructions, and `launch.firstPrompt` alone as the first turn; `started` reports the new sessionRef. Any other resume error ends the process and rejects.

**Files:**
- Modify: `packages/runner/src/adapters/codex/session.ts`
- Test: `packages/runner/test/codex/session-resume.test.ts`

- [ ] **Step 1: Write the failing test**

**File:** `packages/runner/test/codex/session-resume.test.ts` (new)

```ts
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync, realpathSync } from 'node:fs';
import { BRIDGE_TOOL_NAMES } from '../../src/adapters/bridge-tools';
import { CODEX_VERSION } from '../../src/adapters/codex/binary';
import { appServerArgs, appServerEnv, codexToolsNote, threadOverrides } from '../../src/adapters/codex/config';
import type { ResultOf } from '../../src/adapters/codex/methods';
import { CodexSession } from '../../src/adapters/codex/session';
import { memoryLogger } from '../../src/log';
import { codexMessages as m, FAKE_THREAD_ID, readCodexRecord, type CodexRun, type ScriptedAnswers } from './peer';
import {
  cleanupSessions,
  collect,
  firstInput,
  mcp,
  rejectedStart,
  sessionFixture,
  skills,
  type SessionFixture,
} from './session-fixture';

const SESSION_REF = 'previous-thread';

afterEach(cleanupSessions);

function setup(answers: ScriptedAnswers = {}, version = CODEX_VERSION): SessionFixture {
  return sessionFixture({ answers, version, resume: SESSION_REF });
}

/** A failed resume never names the thread or sends a prompt. */
async function rejected(f: SessionFixture, reason: string): Promise<CodexRun> {
  const run = await rejectedStart(f, reason);
  expect(run.requests.some((request) => request.method === 'turn/start')).toBe(false);
  expect(run.requests.some((request) => request.method === 'thread/name/set')).toBe(false);
  return run;
}

describe('CodexSession resume', () => {
  test("runs the attempt's recorded binary and resumes with the same overrides without naming or prompting", async () => {
    const version = '0.158.0';
    expect(version).not.toBe(CODEX_VERSION);
    const f = setup({}, version);
    f.options.testConfig = { model_provider: 'scripted' };
    const session = await CodexSession.start(f.launch, f.options);
    await session.close();
    expect(await session.exited).toEqual({ code: 0, signal: null });
    const runs = readCodexRecord(f.bin);
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run.argv).toEqual(appServerArgs(f.options.testConfig));
    expect(run.cwd).toBe(realpathSync(f.options.userHome));
    expect(run.env).toEqual(
      appServerEnv({
        base: f.launch.env,
        bridgeEnv: f.launch.bridge.env,
        codexHome: f.options.codexHome,
        userHome: f.options.userHome,
      }),
    );
    expect(f.registrations).toHaveLength(1);
    expect(f.registrations[0]!.pid).toBe(session.pid);
    expect(f.registrations[0]!.at).toBeLessThanOrEqual(run.initializedAt!);
    expect(readFileSync(f.launch.logFile, 'utf8')).toContain('session stderr\n');
    expect(run.requests.map((request) => request.method)).toEqual([
      'initialize',
      'thread/resume',
      'mcpServerStatus/list',
      'skills/list',
    ]);
    expect(run.requests.slice(1).map((request) => request.params)).toEqual([
      { threadId: SESSION_REF, ...threadOverrides(f.launch, f.options.userHome), excludeTurns: true },
      { threadId: SESSION_REF },
      { cwds: [f.launch.clone] },
    ]);
    expect(session.sessionRef).toBe(SESSION_REF);
    expect(await collect(session.events)).toEqual([
      {
        type: 'started',
        sessionRef: SESSION_REF,
        model: f.launch.model,
        cliVersion: version,
        permissionMode: 'on-request',
      },
    ]);
  });

  test('refreshes the tools note on resume without sending a prompt', async () => {
    const tools = BRIDGE_TOOL_NAMES.lead;
    const f = setup({ 'mcpServerStatus/list': { result: mcp(['agflow'], null, [...tools].reverse()) } });
    f.launch.role = 'lead';
    f.launch.bridge.tools = tools;
    f.launch.brief = 'Updated brief for the resumed thread.';
    const session = await CodexSession.start(f.launch, f.options);
    await session.close();
    const { requests } = readCodexRecord(f.bin)[0]!;
    expect(requests.find((r) => r.method === 'thread/resume')!.params).toHaveProperty(
      'developerInstructions', `${f.launch.brief}\n\n${codexToolsNote(tools)}`,
    );
    expect(requests.some((r) => r.method === 'turn/start')).toBe(false);
  });

  test('fails closed when the resumed bridge loses a required tool', async () => {
    const tools = BRIDGE_TOOL_NAMES.worker.filter((name) => name !== 'submit');
    await rejected(setup({ 'mcpServerStatus/list': { result: mcp(['agflow'], null, tools) } }),
      'codex thread is missing agflow tools: submit');
  });

  test('uses the returned thread id and model and warns once after started for unverified project config', async () => {
    const f = setup();
    f.launch.projectConfigVerified = false;
    f.answers['thread/resume'] = {
      result: m.threadResumeResult({
        thread: m.thread({ id: 'returned-thread', cwd: f.launch.clone, model: 'reported-model' }),
      }),
    };
    f.write();
    const session = await CodexSession.start(f.launch, f.options);
    await session.close();
    expect(session.sessionRef).toBe('returned-thread');
    const events = await collect(session.events);
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      type: 'started',
      sessionRef: 'returned-thread',
      model: 'reported-model',
      cliVersion: CODEX_VERSION,
      permissionMode: 'on-request',
    });
    expect(events[1]).toMatchObject({ type: 'warning', text: expect.stringContaining('untrusted') });
    const run = readCodexRecord(f.bin)[0]!;
    expect(run.requests[1]!.params).toEqual({
      threadId: SESSION_REF,
      ...threadOverrides(f.launch, f.options.userHome),
      excludeTurns: true,
    });
    expect(run.requests[1]!.params).toMatchObject({
      config: { projects: { [f.launch.clone]: { trust_level: 'untrusted' } } },
    });
    expect(run.requests[2]!.params).toEqual({ threadId: 'returned-thread' });
    expect(run.requests.map((request) => request.method)).toEqual([
      'initialize',
      'thread/resume',
      'mcpServerStatus/list',
      'skills/list',
    ]);
  });

  const badResponses: [string, Partial<ResultOf<'thread/resume'>>, string][] = [
    ['approval policy', { approvalPolicy: 'never' }, 'approval policy'],
    ['reviewer', { approvalsReviewer: 'guardian_subagent' }, 'approvals reviewer'],
    ['sandbox type', { sandbox: { type: 'readOnly', networkAccess: false } }, 'sandbox readOnly, expected workspaceWrite'],
    ['sandbox type and network', { sandbox: { type: 'dangerFullAccess' } }, 'sandbox'],
    [
      'sandbox network',
      {
        sandbox: {
          type: 'workspaceWrite',
          writableRoots: [],
          networkAccess: true,
          excludeTmpdirEnvVar: true,
          excludeSlashTmp: true,
        },
      },
      'network',
    ],
    ['cwd', { cwd: '/wrong\n  clone' }, 'cwd'],
  ];
  for (const [name, patch, reason] of badResponses) {
    test(`rejects a resumed thread reporting the wrong ${name}`, async () => {
      const f = setup();
      f.answers['thread/resume'] = {
        result: { ...m.threadResumeResult({ thread: m.thread({ id: SESSION_REF, cwd: f.launch.clone }) }), ...patch },
      };
      f.write();
      await rejected(f, `codex thread/resume reported ${reason === 'network' ? 'sandbox network' : reason}`);
    });
  }

  test('rejects unexpected MCP servers after resume', async () => {
    await rejected(setup({ 'mcpServerStatus/list': { result: mcp(['agflow', 'other']) } }), 'MCP servers');
  });
  test('rejects user skills after resume', async () => {
    await rejected(setup({ 'skills/list': { result: skills('user') } }), 'user or plugin skills');
  });
  for (const stage of ['thread/resume', 'mcpServerStatus/list', 'skills/list'] as const) {
    test(`a configuration warning during ${stage} fails closed`, async () => {
      const f = setup();
      const then = [{ notify: m.configWarning('ignored setting\n  not_a_real_key') }];
      if (stage === 'thread/resume') {
        f.answers[stage] = { then };
        f.answers['mcpServerStatus/list'] = { result: mcp(), delayMs: 30 };
      } else if (stage === 'mcpServerStatus/list') {
        f.answers[stage] = { result: mcp(), then };
        f.answers['skills/list'] = { result: skills('system'), delayMs: 30 };
      } else {
        f.answers['mcpServerStatus/list'] = { result: mcp(), then: [{ delayMs: 10 }, ...then] };
        f.answers[stage] = { result: skills('system'), delayMs: 50 };
      }
      f.write();
      await rejected(f, 'configuration warning: ignored setting not_a_real_key');
    });
  }

  for (const verified of [true, false]) {
    test(`a missing rollout starts fresh in the same process and clone (verified: ${verified})`, async () => {
      const f = setup({
        'thread/resume': { error: { code: -32600, message: `no rollout found for thread id ${SESSION_REF}` } },
      });
      f.launch.projectConfigVerified = verified;
      const logger = memoryLogger();
      f.options.logger = logger;
      const session = await CodexSession.start(f.launch, f.options);
      await session.close();
      expect(await session.exited).toEqual({ code: 0, signal: null });
      expect(session.sessionRef).toBe(FAKE_THREAD_ID);
      expect(session.sessionRef).not.toBe(SESSION_REF);
      const runs = readCodexRecord(f.bin);
      expect(runs).toHaveLength(1);
      expect(f.registrations).toHaveLength(1);
      expect(runs[0]!.cwd).toBe(realpathSync(f.options.userHome));
      expect(runs[0]!.requests.map((request) => request.method)).toEqual([
        'initialize',
        'thread/resume',
        'thread/start',
        'mcpServerStatus/list',
        'skills/list',
        'thread/name/set',
        'turn/start',
      ]);
      expect(runs[0]!.requests.slice(1).map((request) => request.params)).toEqual([
        { threadId: SESSION_REF, ...threadOverrides(f.launch, f.options.userHome), excludeTurns: true },
        threadOverrides(f.launch, f.options.userHome),
        { threadId: FAKE_THREAD_ID },
        { cwds: [f.launch.clone] },
        { threadId: FAKE_THREAD_ID, name: `agflow ${f.launch.attemptId}` },
        { threadId: FAKE_THREAD_ID, input: firstInput(f.launch.firstPrompt) },
      ]);
      const events = await collect(session.events);
      expect(events).toHaveLength(verified ? 1 : 2);
      expect(events[0]).toEqual({
        type: 'started',
        sessionRef: FAKE_THREAD_ID,
        model: f.launch.model,
        cliVersion: CODEX_VERSION,
        permissionMode: 'on-request',
      });
      if (!verified) expect(events[1]).toMatchObject({ type: 'warning', text: expect.stringContaining('untrusted') });
      expect(logger.entries.filter((entry) => entry.level === 'info' || entry.level === 'warn')).toEqual([
        {
          level: expect.stringMatching(/^(info|warn)$/),
          message: expect.stringContaining('no rollout found'),
          fields: { attemptId: f.launch.attemptId, sessionRef: SESSION_REF },
        },
      ]);
    });
  }

  for (const [code, message] of [
    [-32600, 'cannot resume\n  corrupted thread'],
    [-32603, `no rollout found for thread id ${SESSION_REF}`],
    [-32600, 'other error: no rollout found'],
  ] as const) {
    test(`rejects resume error ${code}: ${message}`, async () => {
      const run = await rejected(
        setup({ 'thread/resume': { error: { code, message } } }),
        `codex thread/resume failed: ${message.replace(/\s+/g, ' ')}`,
      );
      expect(run.requests.map((request) => request.method)).toEqual(['initialize', 'thread/resume']);
    });
  }
  test('ends the process when resume times out', async () => {
    const run = await rejected(setup({ 'thread/resume': { silent: true } }), 'codex thread/resume failed:');
    expect(run.requests.map((request) => request.method)).toEqual(['initialize', 'thread/resume']);
  });
  test('rejects when the process exits during resume', async () => {
    const run = await rejected(
      setup({ 'thread/resume': { silent: true, then: [{ crash: { code: 7 } }] } }),
      'codex thread/resume failed:',
    );
    expect(run.requests.map((request) => request.method)).toEqual(['initialize', 'thread/resume']);
  });
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `bun test packages/runner/test/codex/session-resume.test.ts`
Expected: FAIL — `(fail) CodexSession resume > runs the attempt's recorded binary and resumes with the same overrides without naming or prompting`: the request list has `thread/start`, `thread/name/set` and `turn/start` instead of `thread/resume`, with no naming or prompt expected (5 pass, 17 fail; observed in the 2026-11-11 parent replay).

- [ ] **Step 3: Implement**

**File:** `packages/runner/src/adapters/codex/session.ts` (change)

```diff
diff --git a/packages/runner/src/adapters/codex/session.ts b/packages/runner/src/adapters/codex/session.ts
index 283294bd..54584a6c 100644
--- a/packages/runner/src/adapters/codex/session.ts
+++ b/packages/runner/src/adapters/codex/session.ts
@@ -1,4 +1,4 @@
-// New-thread startup and its fail-closed checks (design 9.2, 7.4).
+// Thread startup, resume and their fail-closed checks (design 9.2, 7.4).
 import { realpathSync } from 'node:fs';
 import { join } from 'node:path';
 import type { RunnerTestBlock } from '../../config';
@@ -8,6 +8,7 @@ import type { AgentEvent, AgentLaunch, ExitInfo } from '../types';
 import { appServerArgs, appServerEnv, threadOverrides } from './config';
 import type { CodexClientMethod, ParamsOf, ResultOf } from './methods';
 import { openAppServer, type AppServerProcess } from './process';
+import { RpcError } from './rpc';
 
 export interface CodexSessionOptions {
   /** paths.runner: vendorBinary paths are relative to it. */
@@ -73,11 +74,19 @@ export class CodexSession {
       unsubscribeStartup();
     };
     try {
-      const thread = await CodexSession.openThread(app, launch, options.userHome);
-      const tools = await CodexSession.checkThread(app, launch, thread, startedServers);
+      const { thread, resumed } = await CodexSession.openThread(app, launch, options.userHome, options.logger);
+      const tools = await CodexSession.checkThread(
+        app,
+        launch,
+        thread,
+        resumed ? 'thread/resume' : 'thread/start',
+        startedServers,
+      );
       if (warning !== null) throw new Error(warning);
       unsubscribe();
-      await request(app, 'thread/name/set', { threadId: thread.thread.id, name: `agflow ${launch.attemptId}` });
+      if (!resumed) {
+        await request(app, 'thread/name/set', { threadId: thread.thread.id, name: `agflow ${launch.attemptId}` });
+      }
       const session = new CodexSession(app, thread.thread.id);
       // The controller starts consuming only after start resolves, so these must already be buffered.
       session.queue.push({
@@ -96,11 +105,13 @@ export class CodexSession {
       if (tools.length > 0) {
         session.queue.push({ type: 'warning', text: `codex thread lists extra agflow tools: ${tools.join(', ')}` });
       }
-      // The tools note is already in developerInstructions; the first turn carries only the launch prompt.
-      await request(app, 'turn/start', {
-        threadId: session.sessionRef,
-        input: [{ type: 'text', text: launch.firstPrompt, text_elements: [] }],
-      });
+      if (!resumed) {
+        // Both start and resume carry the tools note in developerInstructions.
+        await request(app, 'turn/start', {
+          threadId: session.sessionRef,
+          input: [{ type: 'text', text: launch.firstPrompt, text_elements: [] }],
+        });
+      }
       return session;
     } catch (error) {
       await app.end();
@@ -114,12 +125,32 @@ export class CodexSession {
     await this.app.end();
   }
 
-  private static openThread(
+  private static async openThread(
     app: AppServerProcess,
     launch: AgentLaunch,
     bridgeCwd: string,
-  ): Promise<ResultOf<'thread/start'>> {
-    return request(app, 'thread/start', threadOverrides(launch, bridgeCwd));
+    logger?: Logger,
+  ): Promise<{ thread: ResultOf<'thread/start'> | ResultOf<'thread/resume'>; resumed: boolean }> {
+    if (launch.resume !== null) {
+      try {
+        // Keep the RPC error intact until the never-ran case has been distinguished from other failures.
+        const thread = await app.rpc.request('thread/resume', {
+          threadId: launch.resume.sessionRef,
+          ...threadOverrides(launch, bridgeCwd),
+          excludeTurns: true,
+        });
+        return { thread, resumed: true };
+      } catch (error) {
+        if (!(error instanceof RpcError) || error.code !== -32600 || !error.message.startsWith('no rollout found')) {
+          throw new Error(`codex thread/resume failed: ${oneLine(error)}`);
+        }
+        logger?.info('codex thread/resume: no rollout found; starting a fresh thread', {
+          attemptId: launch.attemptId,
+          sessionRef: launch.resume.sessionRef,
+        });
+      }
+    }
+    return { thread: await request(app, 'thread/start', threadOverrides(launch, bridgeCwd)), resumed: false };
   }
 
   /** Checks required tools against the live bridge; returns sorted extra names to warn about. */
@@ -127,24 +158,25 @@ export class CodexSession {
     app: AppServerProcess,
     launch: AgentLaunch,
     thread: Pick<ResultOf<'thread/start'>, 'thread' | 'approvalPolicy' | 'approvalsReviewer' | 'sandbox' | 'cwd'>,
+    method: 'thread/start' | 'thread/resume',
     startedServers: readonly { threadId: string | null; name: string }[],
   ): Promise<string[]> {
     if (thread.approvalPolicy !== 'on-request') {
       throw new Error(
-        `codex thread/start reported approval policy ${JSON.stringify(thread.approvalPolicy)}, expected on-request`,
+        `codex ${method} reported approval policy ${JSON.stringify(thread.approvalPolicy)}, expected on-request`,
       );
     }
     if (thread.approvalsReviewer !== 'user') {
-      throw new Error(`codex thread/start reported approvals reviewer ${thread.approvalsReviewer}, expected user`);
+      throw new Error(`codex ${method} reported approvals reviewer ${thread.approvalsReviewer}, expected user`);
     }
     if (thread.sandbox.type !== 'workspaceWrite') {
-      throw new Error(`codex thread/start reported sandbox ${thread.sandbox.type}, expected workspaceWrite`);
+      throw new Error(`codex ${method} reported sandbox ${thread.sandbox.type}, expected workspaceWrite`);
     }
     if (thread.sandbox.networkAccess !== false) {
-      throw new Error('codex thread/start reported sandbox network access, expected no network');
+      throw new Error(`codex ${method} reported sandbox network access, expected no network`);
     }
     if (thread.cwd !== realpathSync(launch.clone)) {
-      throw new Error(`codex thread/start reported cwd ${thread.cwd}, expected ${realpathSync(launch.clone)}`);
+      throw new Error(`codex ${method} reported cwd ${thread.cwd}, expected ${realpathSync(launch.clone)}`);
     }
     const mcp = await request(app, 'mcpServerStatus/list', { threadId: thread.thread.id });
     // An incomplete inventory cannot establish that agflow is the only server.
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `bun test packages/runner/test/codex/session-resume.test.ts && bun test && bun run typecheck`
Expected: the task's tests pass (22 pass); then the whole suite passes (`0 fail`) and `tsc` exits 0.

`thread/resume` passes `excludeTurns: true`, so its answer stays small. The fallback is logged at info level with the attempt id and the old sessionRef. Resume sends the same developerInstructions override and checks required bridge names again. Tests assert the outgoing note without a new prompt and rejection when a resumed bridge loses submit. Sending overrides is not a claim that Codex accepts arbitrary changes to an existing thread's static brief.

- [ ] **Step 5: Commit**

```bash
git add -A 'packages/runner/src/adapters/codex/session.ts' 'packages/runner/test/codex/session-resume.test.ts'
git commit -m 'M2E Task 13: Session resume and the never-ran fallback' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

### Task 14: Turn, item and status events

App-server notifications become `AgentEvent`s for the runner's facts, deliveries and continuation (design 9.2, 7.5, 6.8, 10). Turns come from the main thread only, and the active turn is the id `turn/start` answered; tool events come from every thread, since Code Mode reports nested calls as their own `commandExecution`, `fileChange` and `mcpToolCall` items. A terminal tool counts only on a normal result, and a failed agflow call whose text is core's hub-unreachable answer sets `hubUnreachable` (X-19). Token usage gives `context`, rate-limit updates give `quota` for the account `account/read` reported, and a failed turn carries the error kind from Task 8. When a turn completes, every tool still open in it gets a failed `tool_ended`, because Codex never completes a command whose approval was pending at an interrupt.

**Files:**
- Create: `packages/runner/src/adapters/codex/items.ts`
- Modify: `packages/runner/src/adapters/codex/session.ts`
- Test: `packages/runner/test/codex/fake-app-server.ts`
- Test: `packages/runner/test/codex/peer.ts`
- Test: `packages/runner/test/codex/session-events.test.ts`
- Test: `packages/runner/test/codex/session-resume.test.ts`
- Test: `packages/runner/test/codex/session-start.test.ts`

- [ ] **Step 1: Write the failing tests**

**File:** `packages/runner/test/codex/fake-app-server.ts` (change)

```diff
diff --git a/packages/runner/test/codex/fake-app-server.ts b/packages/runner/test/codex/fake-app-server.ts
index 7aca9471..87fac001 100644
--- a/packages/runner/test/codex/fake-app-server.ts
+++ b/packages/runner/test/codex/fake-app-server.ts
@@ -236,8 +236,15 @@ function step(next: ScriptedStep): Promise<void> | undefined {
   } else if ('stderr' in next) writeAll(2, `${next.stderr}\n`);
   else if ('spawnPipeHolder' in next) {
     // Unless detached, it stays in the peer's process group.
-    const detached = next.spawnPipeHolder !== true && next.spawnPipeHolder.detached;
-    const holder = Bun.spawn(['/bin/sleep', '600'], { stdio: ['ignore', 'inherit', 'inherit'], detached });
+    const options: Exclude<typeof next.spawnPipeHolder, true> =
+      next.spawnPipeHolder === true ? {} : next.spawnPipeHolder;
+    const lines = (options.notify ?? []).map((note) => JSON.stringify(note));
+    const holder = Bun.spawn(
+      lines.length === 0
+        ? ['/bin/sleep', '600']
+        : ['/bin/sh', '-c', 'sleep 0.1; printf "%s\\n" "$@"; exec /bin/sleep 600', 'sh', ...lines],
+      { stdio: ['ignore', 'inherit', 'inherit'], detached: options.detached === true },
+    );
     holder.unref();
     record({ type: 'pipeHolder', pid: holder.pid });
   } else exit('crash', next.crash);
```

**File:** `packages/runner/test/codex/peer.ts` (change)

```diff
diff --git a/packages/runner/test/codex/peer.ts b/packages/runner/test/codex/peer.ts
index 3bcf0d7f..c0098cff 100644
--- a/packages/runner/test/codex/peer.ts
+++ b/packages/runner/test/codex/peer.ts
@@ -73,14 +73,15 @@ export type CrashSignal = 'SIGKILL' | 'SIGTERM' | 'SIGINT' | 'SIGHUP' | 'SIGQUIT
  * withdrawal (resolved before any answer, as after turn/interrupt) is an explicit notify step. spawnPipeHolder starts
  * `sleep 600` in the peer's process group with its stdout and stderr, so the pipes stay open after the peer exits
  * and only a group kill ends it; { detached: true } starts it in a group of its own, as an escaped process, so not
- * even that ends it.
+ * even that ends it. Its notify lines are written to that stdout 100 ms after it starts, so a crash step right after
+ * it delivers them after the peer's exit.
  */
 export type ScriptedStep =
   | { notify: ServerNotification }
   | { request: ScriptedServerRequest; afterAnswer?: ScriptedStep[] }
   | { delayMs: number }
   | { stderr: string }
-  | { spawnPipeHolder: true | { detached: true } }
+  | { spawnPipeHolder: true | { detached?: true; notify?: ServerNotification[] } }
   | { crash: { code: number } | { signal: CrashSignal } };
 
 /**
```

**File:** `packages/runner/test/codex/session-events.test.ts` (new)

```ts
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { BRIDGE_ANSWERS, TEST_ACCOUNT_ID } from '@agflow/core';
import { createHash } from 'node:crypto';
import { CODEX_VERSION } from '../../src/adapters/codex/binary';
import { agflowTerminal, codexToolEnded, codexToolStarted } from '../../src/adapters/codex/items';
import type { ServerNotification } from '../../src/adapters/codex/protocol';
import type { CodexErrorInfo, RateLimitSnapshot, ThreadItem } from '../../src/adapters/codex/protocol/v2';
import { CodexSession } from '../../src/adapters/codex/session';
import type { AgentEvent, TerminalTool } from '../../src/adapters/types';
import { codexMessages as m, FAKE_THREAD_ID as MAIN, fakeTurnId, readCodexRecord, type ScriptedAnswers } from './peer';
import probes from './probe-messages.json';
import { alive, cleanupSessions, collect, mcp, sessionFixture } from './session-fixture';

const TURN = fakeTurnId(1);
const CHILD = 'child-thread';
const started: AgentEvent = {
  type: 'started',
  sessionRef: MAIN,
  model: 'requested-model',
  cliVersion: CODEX_VERSION,
  permissionMode: 'on-request',
};
const turnStarted: AgentEvent = { type: 'turn_started' };
const begin = (id = TURN, thread = MAIN) => m.turnStarted(thread, m.turn({ id, status: 'inProgress' }));
const finish = (id = TURN, thread = MAIN) => m.turnCompleted(thread, m.turn({ id, status: 'completed' }));
const turnEnded = (toolCalls = 0): AgentEvent => ({
  type: 'turn_ended',
  outcome: 'completed',
  toolCalls,
  error: null,
  errorKind: null,
});
const toolEnded = (
  toolId: string,
  patch: Partial<Extract<AgentEvent, { type: 'tool_ended' }>> = {},
): Extract<AgentEvent, { type: 'tool_ended' }> => ({
  type: 'tool_ended',
  toolId,
  ok: true,
  denied: false,
  terminal: null,
  hubUnreachable: false,
  ...patch,
});
const command = (id = 'exec-1') => m.commandExecutionItem({ id, command: 'echo hi', cwd: '/tmp' });

afterEach(() => {
  mock.restore();
  cleanupSessions();
});

async function run(notes: ServerNotification[], answers: ScriptedAnswers = {}): Promise<AgentEvent[]> {
  const f = sessionFixture({
    answers: {
      ...answers,
      'turn/start': { then: [...notes.map((notify) => ({ notify })), { crash: { code: 0 } }] },
    },
  });
  const session = await CodexSession.start(f.launch, f.options);
  const events = await collect(session.events);
  expect(await session.exited).toEqual({ code: 0, signal: null });
  await session.close();
  return events;
}

const terminals: [string, TerminalTool][] = [
  ['submit', 'submit'],
  ['write_handoff', 'handoff'],
  ['declare_blocked', 'blocked'],
  ['declare_impossible', 'impossible'],
  ['release_task', 'released'],
];

describe('Codex item mapping', () => {
  for (const [wrapped, inner] of [
    ["/bin/zsh -c 'echo hi'", 'echo hi'],
    ["/bin/bash -lc 'echo hi\n  pwd'", 'echo hi\n  pwd'],
    // shlex's own forms: a script with a quote is double-quoted, or split into mixed chunks.
    ['/bin/zsh -c "echo \'hello\'"', "echo 'hello'"],
    ["/bin/zsh -c 'echo \"it'\"'\"'s\"'", 'echo "it\'s"'],
    ['/bin/zsh -c "printf \'%s\\\\n\' x"', "printf '%s\\n' x"],
    ['/bin/bash -lc "git commit -m \\"it\'s done\\""', 'git commit -m "it\'s done"'],
    ['echo  hi && pwd', 'echo  hi && pwd'],
    ["python3 -c 'print(1)'", "python3 -c 'print(1)'"],
    ["/bin/zsh -c 'echo hi' && pwd", "/bin/zsh -c 'echo hi' && pwd"],
    ['/bin/zsh -c "echo $HOME"', '/bin/zsh -c "echo $HOME"'],
    ["/bin/zsh -c 'echo hi", "/bin/zsh -c 'echo hi"],
  ]) {
    test(`unwraps only a shell command: ${wrapped}`, () => {
      expect(codexToolStarted({ ...command(), command: wrapped })).toEqual({
        type: 'tool_started',
        toolId: 'exec-1',
        name: 'exec_command',
        input: inner,
        command: inner,
      });
    });
  }

  test('a file change carries its patches, so different edits of one file are different calls', () => {
    const edit = (diff: string) =>
      codexToolStarted(
        m.fileChangeItem({
          id: 'patch',
          changes: [{ path: 'src/foo.ts', kind: { type: 'update', move_path: null }, diff }],
        }),
      );
    expect(edit('+import x')).toEqual({
      type: 'tool_started',
      toolId: 'patch',
      name: 'apply_patch',
      input: 'src/foo.ts\n+import x',
      command: null,
    });
    expect(edit('+import x')!.input).not.toBe(edit('+function y() {}')!.input);
  });

  test('only a completed command with exit code zero is ok', () => {
    for (const status of ['inProgress', 'completed', 'failed', 'declined'] as const) {
      for (const exitCode of [0, 1, null]) {
        expect(codexToolEnded({ ...command(), status, exitCode })).toEqual(
          toolEnded('exec-1', {
            ok: status === 'completed' && exitCode === 0,
            denied: status === 'declined',
          }),
        );
      }
    }
  });

  test('non-tool items have no tool or terminal mapping', () => {
    for (const item of [m.agentMessageItem('hello'), m.contextCompactionItem(), m.userMessageItem('hello')]) {
      expect(codexToolStarted(item)).toBeNull();
      expect(codexToolEnded(item)).toBeNull();
      expect(agflowTerminal(item)).toBeNull();
    }
  });

  for (const [tool, terminal] of terminals) {
    test(`${tool} counts only a completed agflow result, independently of its text`, () => {
      for (const status of ['inProgress', 'completed', 'failed'] as const) {
        for (const result of ['submitted at abc', 'submission pending', BRIDGE_ANSWERS.hubUnreachable, 'anything']) {
          const item = m.mcpToolCallItem({ id: 'mcp', tool, args: {}, status, result });
          expect(agflowTerminal(item)).toBe(status === 'completed' ? terminal : null);
          expect(agflowTerminal({ ...item, server: 'other' })).toBeNull();
        }
      }
    });
  }
});

describe('CodexSession events', () => {
  test('keeps the returned active id before turn/started and emits one start for it', async () => {
    const id = 'returned-turn';
    const f = sessionFixture({
      answers: {
        'turn/start': {
          result: { turn: m.turn({ id, status: 'inProgress' }) },
          then: [
            { delayMs: 50 },
            { notify: begin(id) },
            { notify: begin(id) },
            { notify: finish(id) },
            { crash: { code: 0 } },
          ],
        },
      },
    });
    const session = await CodexSession.start(f.launch, f.options);
    expect(alive(session.pid)).toBe(true);
    expect(session.activeTurnId).toBe(id);
    expect(await collect(session.events)).toEqual([started, turnStarted, turnEnded()]);
    expect(session.activeTurnId).toBeNull();
    await session.close();
  });

  test('a turn that ends before its turn/start answer is handled does not stay active', async () => {
    // The answer and the turn's notifications arrive together; the rpc lets the answer's caller run first.
    const f = sessionFixture({
      answers: { 'turn/start': { then: [{ notify: begin() }, { notify: finish() }, { crash: { code: 0 } }] } },
    });
    const session = await CodexSession.start(f.launch, f.options);
    expect(await collect(session.events)).toEqual([started, turnStarted, turnEnded()]);
    expect(session.activeTurnId).toBeNull();
    await session.close();
  });

  test('maps a completed turn with a command, file change and MCP call', async () => {
    const exec = probes.commandExecutionCompleted.params.item as ThreadItem;
    const patch = m.fileChangeItem({
      id: 'patch',
      changes: [
        { path: 'one.ts', kind: { type: 'add' }, diff: '+one' },
        { path: 'two.ts', kind: { type: 'delete' }, diff: '-two' },
      ],
    });
    const call = m.mcpToolCallItem({ id: 'mcp', tool: 'report_progress', args: { note: 'done', n: 1 } });
    expect(
      await run([
        begin(),
        m.itemStarted(MAIN, TURN, { ...exec, status: 'inProgress' } as ThreadItem),
        m.itemCompleted(MAIN, TURN, exec),
        m.itemStarted(MAIN, TURN, patch),
        m.itemCompleted(MAIN, TURN, { ...patch, status: 'completed' }),
        m.itemStarted(MAIN, TURN, call),
        m.itemCompleted(MAIN, TURN, { ...call, status: 'completed' }),
        finish(),
      ]),
    ).toEqual([
      started,
      turnStarted,
      {
        type: 'tool_started',
        toolId: exec.id,
        name: 'exec_command',
        input: 'echo hi > probe.txt && cat probe.txt',
        command: 'echo hi > probe.txt && cat probe.txt',
      },
      toolEnded(exec.id),
      {
        type: 'tool_started',
        toolId: 'patch',
        name: 'apply_patch',
        input: 'one.ts\n+one\ntwo.ts\n-two',
        command: null,
      },
      toolEnded('patch'),
      {
        type: 'tool_started',
        toolId: 'mcp',
        name: 'mcp__agflow__report_progress',
        input: '{"note":"done","n":1}',
        command: null,
      },
      toolEnded('mcp'),
      turnEnded(3),
    ]);
  });

  test('supplies missing starts for declined commands, declined patches and MCP error results', async () => {
    const exec = probes.commandExecutionDeclined.params.item as ThreadItem;
    const call = probes.mcpToolCallFailed.params.item as ThreadItem;
    const patch = m.fileChangeItem({ id: 'patch', changes: [], status: 'declined' });
    expect(
      await run([begin(), ...[exec, patch, call].map((item) => m.itemCompleted(MAIN, TURN, item)), finish()]),
    ).toEqual([
      started,
      turnStarted,
      {
        type: 'tool_started',
        toolId: exec.id,
        name: 'exec_command',
        input: 'touch /tmp/m2e-probe/outside.txt; echo done',
        command: 'touch /tmp/m2e-probe/outside.txt; echo done',
      },
      toolEnded(exec.id, { ok: false, denied: true }),
      { type: 'tool_started', toolId: 'patch', name: 'apply_patch', input: '', command: null },
      toolEnded('patch', { ok: false, denied: true }),
      { type: 'tool_started', toolId: call.id, name: 'mcp__agflow__submit', input: '{"note":"x"}', command: null },
      toolEnded(call.id, { ok: false }),
      turnEnded(3),
    ]);
  });

  test('maps every terminal on normal results and no terminal on failed results', async () => {
    const notes: ServerNotification[] = [begin()];
    const expected: AgentEvent[] = [started, turnStarted];
    for (const [tool, terminal] of terminals) {
      for (const status of ['completed', 'failed'] as const) {
        const id = `${tool}-${status}`;
        notes.push(
          m.itemCompleted(MAIN, TURN, m.mcpToolCallItem({ id, tool, args: {}, status, result: 'submission pending' })),
        );
        expected.push(
          { type: 'tool_started', toolId: id, name: `mcp__agflow__${tool}`, input: '{}', command: null },
          toolEnded(id, { ok: status === 'completed', terminal: status === 'completed' ? terminal : null }),
        );
      }
    }
    expect(await run([...notes, finish()])).toEqual([...expected, turnEnded(10)]);
  });

  test('hubUnreachable requires an exact failed agflow answer', async () => {
    const items = [
      m.mcpToolCallItem({
        id: 'unreachable',
        tool: 'check_inbox',
        args: {},
        status: 'failed',
        result: BRIDGE_ANSWERS.hubUnreachable,
      }),
      m.mcpToolCallItem({
        id: 'ok',
        tool: 'check_inbox',
        args: {},
        status: 'completed',
        result: BRIDGE_ANSWERS.hubUnreachable,
      }),
      m.mcpToolCallItem({
        id: 'suffix',
        tool: 'check_inbox',
        args: {},
        status: 'failed',
        result: `${BRIDGE_ANSWERS.hubUnreachable} extra`,
      }),
      m.mcpToolCallItem({
        id: 'transport',
        tool: 'check_inbox',
        args: {},
        status: 'failed',
        error: BRIDGE_ANSWERS.hubUnreachable,
      }),
      {
        ...m.mcpToolCallItem({
          id: 'other',
          tool: 'submit',
          args: {},
          status: 'failed',
          result: BRIDGE_ANSWERS.hubUnreachable,
        }),
        server: 'other',
      },
    ];
    const events = await run(items.map((item) => m.itemCompleted(MAIN, TURN, item)));
    expect(events.filter((event) => event.type === 'tool_ended')).toEqual([
      toolEnded('unreachable', { ok: false, hubUnreachable: true }),
      toolEnded('ok'),
      toolEnded('suffix', { ok: false }),
      toolEnded('transport', { ok: false }),
      toolEnded('other', { ok: false }),
    ]);
  });

  test('child tools count as progress while turns, text, context and errors follow only the main thread', async () => {
    const item = command('child-exec');
    const usage = { total: { input: 1000, output: 10 }, last: { input: 100, output: 5 } };
    expect(
      await run([
        begin(),
        begin('child-turn', CHILD),
        m.itemStarted(CHILD, 'child-turn', item),
        m.itemCompleted(CHILD, 'child-turn', { ...item, status: 'completed', exitCode: 0 }),
        m.itemCompleted(CHILD, 'child-turn', m.agentMessageItem('hidden')),
        m.tokenUsageUpdated(CHILD, 'child-turn', usage, 200),
        m.error(CHILD, 'child-turn', m.turnError('usageLimitExceeded', 'hidden error')),
        finish('child-turn', CHILD),
        m.itemStarted(MAIN, TURN, m.agentMessageItem('partial')),
        m.itemCompleted(MAIN, TURN, m.agentMessageItem('main text')),
        finish(),
        begin('second'),
        finish('second'),
      ]),
    ).toEqual([
      started,
      turnStarted,
      { type: 'tool_started', toolId: 'child-exec', name: 'exec_command', input: 'echo hi', command: 'echo hi' },
      toolEnded('child-exec'),
      { type: 'text', text: 'main text' },
      turnEnded(1),
      turnStarted,
      turnEnded(),
    ]);
  });

  test('a turn that ends with tools open ends them first, and their late completions are not reported', async () => {
    const exec = command('open-exec');
    const call = m.mcpToolCallItem({ id: 'open-mcp', tool: 'check_inbox', args: {} });
    const child = command('child-exec');
    const done = { ...command('done-exec'), status: 'completed' as const, exitCode: 0 };
    const next = command('next-exec');
    const toolStarted = (id: string, name = 'exec_command'): AgentEvent => ({
      type: 'tool_started',
      toolId: id,
      name,
      input: name === 'exec_command' ? 'echo hi' : '{}',
      command: name === 'exec_command' ? 'echo hi' : null,
    });
    expect(
      await run([
        begin(),
        // An interrupt with a command approval pending: Codex never completes that command's item.
        m.itemStarted(MAIN, TURN, exec),
        m.itemStarted(MAIN, TURN, call),
        m.itemStarted(CHILD, 'child-turn', child),
        m.itemStarted(MAIN, TURN, done),
        m.itemCompleted(MAIN, TURN, done),
        m.turnCompleted(MAIN, m.turn({ id: TURN, status: 'interrupted' })),
        m.itemCompleted(MAIN, TURN, { ...exec, status: 'declined' }),
        m.itemCompleted(CHILD, 'child-turn', { ...child, status: 'completed', exitCode: 0 }),
        begin('next'),
        m.itemStarted(MAIN, 'next', next),
        m.turnCompleted(
          MAIN,
          m.turn({ id: 'next', status: 'failed', error: m.turnError('internalServerError', 'gone') }),
        ),
      ]),
    ).toEqual([
      started,
      turnStarted,
      toolStarted('open-exec'),
      toolStarted('open-mcp', 'mcp__agflow__check_inbox'),
      toolStarted('child-exec'),
      toolStarted('done-exec'),
      toolEnded('done-exec'),
      // A child's tool counted for the main turn, so it ends with it too.
      toolEnded('open-exec', { ok: false }),
      toolEnded('open-mcp', { ok: false }),
      toolEnded('child-exec', { ok: false }),
      { type: 'turn_ended', outcome: 'interrupted', toolCalls: 4, error: null, errorKind: null },
      turnStarted,
      toolStarted('next-exec'),
      toolEnded('next-exec', { ok: false }),
      { type: 'turn_ended', outcome: 'failed', toolCalls: 1, error: 'gone', errorKind: 'vendor' },
    ]);
  });

  test("a child turn's end ends the tools still open in that turn, during a main turn or after it", async () => {
    const during = command('child-exec');
    const late = command('late-child-exec');
    const interrupted = (id: string) => m.turnCompleted(CHILD, m.turn({ id, status: 'interrupted' }));
    expect(
      await run([
        begin(),
        begin('child-turn', CHILD),
        m.itemStarted(CHILD, 'child-turn', during),
        // Interrupted with no item/completed for its command, while the main turn keeps running.
        interrupted('child-turn'),
        m.itemCompleted(CHILD, 'child-turn', { ...during, status: 'declined' }),
        m.itemCompleted(MAIN, TURN, m.agentMessageItem('still running')),
        finish(),
        // A child turn after the main turn ended: its tool counts for no main turn.
        begin('late-child-turn', CHILD),
        m.itemStarted(CHILD, 'late-child-turn', late),
        interrupted('late-child-turn'),
        begin('second'),
        finish('second'),
      ]),
    ).toEqual([
      started,
      turnStarted,
      { type: 'tool_started', toolId: 'child-exec', name: 'exec_command', input: 'echo hi', command: 'echo hi' },
      toolEnded('child-exec', { ok: false }),
      { type: 'text', text: 'still running' },
      turnEnded(1),
      { type: 'tool_started', toolId: 'late-child-exec', name: 'exec_command', input: 'echo hi', command: 'echo hi' },
      toolEnded('late-child-exec', { ok: false }),
      turnStarted,
      turnEnded(),
    ]);
  });

  test('context uses last input tokens and skips unknown or zero windows', async () => {
    const tokenUsage = probes.tokenUsageUpdated.params.tokenUsage;
    expect(
      await run(
        [258400, null, 0].map((modelContextWindow) => ({
          method: 'thread/tokenUsage/updated',
          params: { threadId: MAIN, turnId: TURN, tokenUsage: { ...tokenUsage, modelContextWindow } },
        })),
      ),
    ).toEqual([started, { type: 'context', used: 100 / 258400 }]);
  });

  test('interrupted and completed turns discard errors; retry errors do not fail a turn', async () => {
    const error = m.turnError('internalServerError', 'retrying');
    expect(
      await run([
        begin(),
        m.error(MAIN, TURN, error, true),
        finish(),
        begin('next'),
        m.error(MAIN, 'next', error),
        m.turnCompleted(MAIN, m.turn({ id: 'next', status: 'interrupted', error })),
        begin('last'),
        finish('last'),
      ]),
    ).toEqual([
      started,
      turnStarted,
      turnEnded(),
      turnStarted,
      { type: 'turn_ended', outcome: 'interrupted', toolCalls: 0, error: null, errorKind: null },
      turnStarted,
      turnEnded(),
    ]);
  });

  for (const info of [
    'internalServerError',
    { httpConnectionFailed: { httpStatusCode: 500 } },
  ] satisfies CodexErrorInfo[]) {
    test(`final 500 error wins over the completed turn's error: ${JSON.stringify(info)}`, async () => {
      expect(
        await run([
          begin(),
          m.error(MAIN, TURN, m.turnError(info, 'final error')),
          m.turnCompleted(MAIN, m.turn({ id: TURN, status: 'failed', error: m.turnError('unauthorized', 'fallback') })),
        ]),
      ).toEqual([
        started,
        turnStarted,
        {
          type: 'turn_ended',
          outcome: 'failed',
          toolCalls: 0,
          error: 'final error',
          errorKind: 'vendor',
        },
      ]);
    });
  }

  test('failed turns fall back to their own error, ignoring retry and steer-rejection errors', async () => {
    expect(
      await run([
        begin(),
        m.error(MAIN, TURN, m.turnError('unauthorized', 'retry'), true),
        m.error(MAIN, TURN, m.turnError({ activeTurnNotSteerable: { turnKind: 'review' } }, 'steer')),
        m.turnCompleted(
          MAIN,
          m.turn({ id: TURN, status: 'failed', error: m.turnError('contextWindowExceeded', 'full') }),
        ),
      ]),
    ).toEqual([
      started,
      turnStarted,
      {
        type: 'turn_ended',
        outcome: 'failed',
        toolCalls: 0,
        error: 'full',
        errorKind: 'context',
      },
    ]);
  });

  test('a failed turn keeps its tool count and ignores final errors from other threads or turns', async () => {
    const item = { ...command(), status: 'completed' as const, exitCode: 0 };
    expect(
      await run([
        begin(),
        m.itemCompleted(MAIN, TURN, item),
        m.error(CHILD, TURN, m.turnError('usageLimitExceeded', 'child error')),
        m.error(MAIN, 'another-turn', m.turnError('unauthorized', 'another turn')),
        m.turnCompleted(MAIN, m.turn({ id: TURN, status: 'failed', error: m.turnError('sandboxError', 'failed') })),
      ]),
    ).toEqual([
      started,
      turnStarted,
      { type: 'tool_started', toolId: item.id, name: 'exec_command', input: 'echo hi', command: 'echo hi' },
      toolEnded(item.id),
      { type: 'turn_ended', outcome: 'failed', toolCalls: 1, error: 'failed', errorKind: 'vendor' },
    ]);
  });

  test('merges sparse rate limits and preserves the secondary window and paid usage facts', async () => {
    const now = 1793200000000;
    spyOn(Date, 'now').mockReturnValue(now);
    const primary = { usedPercent: 25, windowDurationMins: 300, resetsAt: 1793207969 };
    const secondary = { usedPercent: 50, windowDurationMins: 10080, resetsAt: 1793290769 };
    expect(
      await run([
        m.rateLimitsUpdated({ primary, secondary, credits: { hasCredits: true, unlimited: false, balance: null } }),
        m.rateLimitsUpdated({ primary: { ...primary, usedPercent: 100 }, secondary: null }),
      ]),
    ).toEqual([
      started,
      {
        type: 'quota',
        accountId: null,
        quota: {
          state: 'ok',
          resetsAt: 1793290769000,
          windows: { fiveHour: 0.25, weekly: 0.5 },
          paidUsage: 'enabled',
          updatedAt: now,
        },
      },
      {
        type: 'quota',
        accountId: null,
        quota: {
          state: 'ok',
          resetsAt: 1793207969000,
          windows: { fiveHour: 1, weekly: 0.5 },
          paidUsage: 'in_use',
          updatedAt: now,
        },
      },
    ]);
  });

  test('recorded usage-limit sequence emits exhausted quota in milliseconds before the failed turn', async () => {
    const now = 1793200000000;
    spyOn(Date, 'now').mockReturnValue(now);
    const quota: AgentEvent = {
      type: 'quota',
      accountId: null,
      quota: {
        state: 'exhausted',
        resetsAt: 1793207969000,
        windows: { fiveHour: 1, weekly: 0.1 },
        paidUsage: 'disabled',
        updatedAt: now,
      },
    };
    const error = m.turnError('usageLimitExceeded', probes.usageLimitError.params.error.message);
    expect(
      await run([
        begin(),
        probes.usageLimitRateLimits as ServerNotification,
        m.error(MAIN, TURN, error),
        m.turnCompleted(MAIN, m.turn({ id: TURN, status: 'failed' })),
      ]),
    ).toEqual([
      started,
      turnStarted,
      quota,
      quota,
      {
        type: 'turn_ended',
        outcome: 'failed',
        toolCalls: 0,
        error: error.message,
        errorKind: 'quota',
      },
    ]);
  });

  test('quota failure without a snapshot reports an unknown reset', async () => {
    const now = 1793200000000;
    spyOn(Date, 'now').mockReturnValue(now);
    expect(
      await run([
        begin(),
        m.turnCompleted(
          MAIN,
          m.turn({ id: TURN, status: 'failed', error: m.turnError('usageLimitExceeded', 'limit') }),
        ),
      ]),
    ).toEqual([
      started,
      turnStarted,
      {
        type: 'quota',
        accountId: null,
        quota: {
          state: 'exhausted',
          resetsAt: null,
          windows: { fiveHour: null, weekly: null },
          paidUsage: 'unknown',
          updatedAt: now,
        },
      },
      { type: 'turn_ended', outcome: 'failed', toolCalls: 0, error: 'limit', errorKind: 'quota' },
    ]);
  });

  test('a quota failure without a known reset asks account/rateLimits/read before it ends the turn', async () => {
    const now = 1793200000000;
    spyOn(Date, 'now').mockReturnValue(now);
    const f = sessionFixture({
      answers: {
        'account/rateLimits/read': {
          delayMs: 50,
          result: {
            ordinaryUsageAllowed: false,
            rateLimits: probes.usageLimitRateLimits.params.rateLimits as RateLimitSnapshot,
            rateLimitsByLimitId: null,
            rateLimitResetCredits: null,
            accountId: null,
            rateLimitUpsell: null,
          },
        },
        'turn/start': {
          then: [
            { notify: begin() },
            {
              notify: m.turnCompleted(
                MAIN,
                m.turn({ id: TURN, status: 'failed', error: m.turnError('usageLimitExceeded', 'limit') }),
              ),
            },
            { delayMs: 200 },
            { crash: { code: 0 } },
          ],
        },
      },
    });
    const session = await CodexSession.start(f.launch, f.options);
    expect(await collect(session.events)).toEqual([
      started,
      turnStarted,
      {
        type: 'quota',
        accountId: null,
        quota: {
          state: 'exhausted',
          resetsAt: 1793207969000,
          windows: { fiveHour: 1, weekly: 0.1 },
          paidUsage: 'disabled',
          updatedAt: now,
        },
      },
      { type: 'turn_ended', outcome: 'failed', toolCalls: 0, error: 'limit', errorKind: 'quota' },
    ]);
    await session.close();
    expect(readCodexRecord(f.bin)[0]!.requests.map(({ method }) => method)).toContain('account/rateLimits/read');
  });

  for (const skipAuthChecks of [false, true]) {
    test(`quota events carry the session's account id with skipAuthChecks=${skipAuthChecks}`, async () => {
      const f = sessionFixture({
        answers: {
          'account/read': {
            result: {
              account: { type: 'chatgpt', email: 'owner@example.com', planType: 'plus' },
              requiresOpenaiAuth: true,
            },
          },
          'turn/start': {
            then: [
              { notify: begin() },
              { notify: probes.usageLimitRateLimits as ServerNotification },
              {
                notify: m.turnCompleted(
                  MAIN,
                  m.turn({ id: TURN, status: 'failed', error: m.turnError('usageLimitExceeded', 'limit') }),
                ),
              },
              { crash: { code: 0 } },
            ],
          },
        },
      });
      const session = await CodexSession.start(f.launch, { ...f.options, skipAuthChecks });
      const accountId = skipAuthChecks
        ? TEST_ACCOUNT_ID
        : createHash('sha256').update('owner@example.com').digest('hex').slice(0, 16);
      const quotas = (await collect(session.events)).filter((event) => event.type === 'quota');
      expect(quotas.map((event) => event.accountId)).toEqual([accountId, accountId]);
      await session.close();
      expect(readCodexRecord(f.bin)[0]!.requests.some(({ method }) => method === 'account/read')).toBe(!skipAuthChecks);
    });
  }

  test('warning kinds are one-line notes, including warnings buffered during start checks', async () => {
    expect(
      await run(
        [
          m.warning('ordinary\n warning'),
          m.configWarning('config\n summary', 'fix\n it'),
          { method: 'deprecationNotice', params: { summary: 'old\n setting', details: 'use new' } },
          {
            method: 'model/rerouted',
            params: { threadId: MAIN, turnId: TURN, fromModel: 'one', toModel: 'two', reason: 'highRiskCyberActivity' },
          },
        ],
        {
          'thread/start': { then: [{ notify: m.warning('during checks', MAIN) }] },
          'mcpServerStatus/list': { result: mcp(), delayMs: 30 },
        },
      ),
    ).toEqual([
      started,
      { type: 'warning', text: 'codex warning: during checks' },
      { type: 'warning', text: 'codex warning: ordinary warning' },
      { type: 'warning', text: 'codex configuration warning: config summary: fix it' },
      { type: 'warning', text: 'codex deprecation: old setting: use new' },
      { type: 'warning', text: 'codex model rerouted: one -> two (highRiskCyberActivity)' },
    ]);
  });

  test('drains notifications that reach stdout after the process exit', async () => {
    // An escaped holder writes them 100 ms after the peer exits: ending the events at the exit would lose them.
    const notes = Array.from({ length: 20 }, (_, i) => m.warning(`after exit ${i}`));
    const f = sessionFixture({
      answers: {
        'turn/start': { then: [{ spawnPipeHolder: { detached: true, notify: notes } }, { crash: { code: 0 } }] },
      },
    });
    const session = await CodexSession.start(f.launch, f.options);
    try {
      expect(await collect(session.events)).toEqual([
        started,
        ...notes.map((note): AgentEvent => ({ type: 'warning', text: `codex warning: ${note.params.message}` })),
      ]);
      expect(await session.exited).toEqual({ code: 0, signal: null });
    } finally {
      for (const pid of readCodexRecord(f.bin)[0]?.pipeHolders ?? []) process.kill(pid, 'SIGKILL');
      await session.close();
    }
  }, 3000);

  test('bounds the stdout wait after exit when an escaped process holds it open', async () => {
    const f = sessionFixture({
      answers: {
        'turn/start': {
          then: [{ spawnPipeHolder: { detached: true } }, { notify: m.warning('before exit') }, { crash: { code: 0 } }],
        },
      },
    });
    const session = await CodexSession.start(f.launch, f.options);
    try {
      expect(await collect(session.events)).toEqual([started, { type: 'warning', text: 'codex warning: before exit' }]);
      expect(await session.exited).toEqual({ code: 0, signal: null });
    } finally {
      for (const pid of readCodexRecord(f.bin)[0]?.pipeHolders ?? []) {
        process.kill(pid, 'SIGKILL');
      }
      await session.close();
    }
  }, 3000);
});
```

**File:** `packages/runner/test/codex/session-resume.test.ts` (change)

```diff
diff --git a/packages/runner/test/codex/session-resume.test.ts b/packages/runner/test/codex/session-resume.test.ts
index ded665ef..368103ae 100644
--- a/packages/runner/test/codex/session-resume.test.ts
+++ b/packages/runner/test/codex/session-resume.test.ts
@@ -65,11 +65,13 @@ describe('CodexSession resume', () => {
       'thread/resume',
       'mcpServerStatus/list',
       'skills/list',
+      'account/read',
     ]);
     expect(run.requests.slice(1).map((request) => request.params)).toEqual([
       { threadId: SESSION_REF, ...threadOverrides(f.launch, f.options.userHome), excludeTurns: true },
       { threadId: SESSION_REF },
       { cwds: [f.launch.clone] },
+      { refreshToken: false },
     ]);
     expect(session.sessionRef).toBe(SESSION_REF);
     expect(await collect(session.events)).toEqual([
@@ -141,6 +143,7 @@ describe('CodexSession resume', () => {
       'thread/resume',
       'mcpServerStatus/list',
       'skills/list',
+      'account/read',
     ]);
   });
 
@@ -223,6 +226,7 @@ describe('CodexSession resume', () => {
         'thread/start',
         'mcpServerStatus/list',
         'skills/list',
+        'account/read',
         'thread/name/set',
         'turn/start',
       ]);
@@ -231,6 +235,7 @@ describe('CodexSession resume', () => {
         threadOverrides(f.launch, f.options.userHome),
         { threadId: FAKE_THREAD_ID },
         { cwds: [f.launch.clone] },
+        { refreshToken: false },
         { threadId: FAKE_THREAD_ID, name: `agflow ${f.launch.attemptId}` },
         { threadId: FAKE_THREAD_ID, input: firstInput(f.launch.firstPrompt) },
       ]);
```

**File:** `packages/runner/test/codex/session-start.test.ts` (change)

```diff
diff --git a/packages/runner/test/codex/session-start.test.ts b/packages/runner/test/codex/session-start.test.ts
index 583f0306..52fa7a78 100644
--- a/packages/runner/test/codex/session-start.test.ts
+++ b/packages/runner/test/codex/session-start.test.ts
@@ -76,6 +76,7 @@ describe('CodexSession.start', () => {
         'thread/start',
         'mcpServerStatus/list',
         'skills/list',
+        'account/read',
         'thread/name/set',
         'turn/start',
       ]);
@@ -83,6 +84,7 @@ describe('CodexSession.start', () => {
         threadOverrides(f.launch, f.options.userHome),
         { threadId: session.sessionRef },
         { cwds: [f.launch.clone] },
+        { refreshToken: false },
         { threadId: session.sessionRef, name: 'agflow T-42-a3' },
         { threadId: session.sessionRef, input: firstInput(f.launch.firstPrompt) },
       ]);
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `bun test packages/runner/test/codex/session-events.test.ts packages/runner/test/codex/session-start.test.ts packages/runner/test/codex/session-resume.test.ts`
Expected: FAIL — `(fail) CodexSession resume > runs the attempt's recorded binary and resumes with the same overrides without naming or prompting`: the request list is missing the expected `account/read`. The events file also cannot import `../../src/adapters/codex/items` (56 pass, 7 fail, 1 error; observed in the 2026-11-11 parent replay).

- [ ] **Step 3: Implement**

**File:** `packages/runner/src/adapters/codex/items.ts` (new)

```ts
// App-server tool items as runner events (design 7.5, 9.2, 10). Code Mode's nested calls use these same items.
import { BRIDGE_ANSWERS } from '@agflow/core';
import type { AgentEvent, TerminalTool } from '../types';
import type { ThreadItem } from './protocol/v2';

type ToolStarted = Extract<AgentEvent, { type: 'tool_started' }>;
type ToolEnded = Extract<AgentEvent, { type: 'tool_ended' }>;

export function codexToolStarted(item: ThreadItem): ToolStarted | null {
  switch (item.type) {
    case 'commandExecution': {
      const command = innerCommand(item.command);
      return { type: 'tool_started', toolId: item.id, name: 'exec_command', input: command, command };
    }
    case 'fileChange':
      return {
        type: 'tool_started',
        toolId: item.id,
        name: 'apply_patch',
        // The patch is the call's argument: repeated edits of one file are not a loop (design 6.8).
        input: item.changes.map((change) => `${change.path}\n${change.diff}`).join('\n'),
        command: null,
      };
    case 'mcpToolCall':
      return {
        type: 'tool_started',
        toolId: item.id,
        name: `mcp__${item.server}__${item.tool}`,
        input: JSON.stringify(item.arguments),
        command: null,
      };
    default:
      return null;
  }
}

export function codexToolEnded(item: ThreadItem): ToolEnded | null {
  if (item.type !== 'commandExecution' && item.type !== 'fileChange' && item.type !== 'mcpToolCall') return null;
  return {
    type: 'tool_ended',
    toolId: item.id,
    ok: item.status === 'completed' && (item.type !== 'commandExecution' || item.exitCode === 0),
    denied: item.type !== 'mcpToolCall' && item.status === 'declined',
    terminal: agflowTerminal(item),
    hubUnreachable:
      item.type === 'mcpToolCall' &&
      item.server === 'agflow' &&
      item.status === 'failed' &&
      item.result?.content
        .filter((part) => part !== null && typeof part === 'object' && !Array.isArray(part) && part.type === 'text')
        .map((part) => (part as { text?: unknown }).text)
        .join('\n') === BRIDGE_ANSWERS.hubUnreachable,
  };
}

/** A bridge refusal is status failed, even when its text says submission pending (X-19). */
export function agflowTerminal(item: ThreadItem): TerminalTool | null {
  if (item.type !== 'mcpToolCall' || item.server !== 'agflow' || item.status !== 'completed') return null;
  switch (item.tool) {
    case 'submit':
      return 'submit';
    case 'write_handoff':
      return 'handoff';
    case 'declare_blocked':
      return 'blocked';
    case 'declare_impossible':
      return 'impossible';
    case 'release_task':
      return 'released';
    default:
      return null;
  }
}

/**
 * Codex runs every command as `<shell> -c <script>` (or -lc), joined with shlex; the agent wrote only the script.
 * Anything that is not exactly those three words stays as it is.
 */
function innerCommand(command: string): string {
  const words = shellWords(command);
  if (words?.length !== 3 || !/^(?:\S*\/)?[a-z]*sh$/.test(words[0]!) || !['-c', '-lc'].includes(words[1]!)) {
    return command;
  }
  return words[2]!;
}

/**
 * The words of a command as shlex quotes them: unquoted runs, '...' chunks, and "..." chunks in which a backslash
 * escapes $ ` " and itself; adjacent chunks form one word. Null for anything shlex would not write, such as an
 * operator, an expansion or an unterminated quote.
 */
function shellWords(command: string): string[] | null {
  const words: string[] = [];
  let word: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if (char === ' ') {
      if (word !== null) words.push(word);
      word = null;
    } else if (char === "'") {
      const end = command.indexOf("'", i + 1);
      if (end === -1) return null;
      word = (word ?? '') + command.slice(i + 1, end);
      i = end;
    } else if (char === '"') {
      let chunk = '';
      for (i++; command[i] !== '"'; i++) {
        const inner = command[i];
        if (inner === undefined || inner === '$' || inner === '`') return null;
        if (inner === '\\' && ['$', '`', '"', '\\'].includes(command[i + 1] ?? '')) i++;
        chunk += command[i];
      }
      word = (word ?? '') + chunk;
    } else if (/[\s|&;<>()$`\\*?[\]{}#~!]/.test(char)) {
      return null;
    } else {
      word = (word ?? '') + char;
    }
  }
  if (word !== null) words.push(word);
  return words;
}
```

**File:** `packages/runner/src/adapters/codex/session.ts` (change)

```diff
diff --git a/packages/runner/src/adapters/codex/session.ts b/packages/runner/src/adapters/codex/session.ts
index 54584a6c..77342520 100644
--- a/packages/runner/src/adapters/codex/session.ts
+++ b/packages/runner/src/adapters/codex/session.ts
@@ -1,13 +1,20 @@
-// Thread startup, resume and their fail-closed checks (design 9.2, 7.4).
+// Thread startup, resume, fail-closed checks and app-server events (design 9.2, 7.4).
+import { TEST_ACCOUNT_ID } from '@agflow/core';
 import { realpathSync } from 'node:fs';
 import { join } from 'node:path';
 import type { RunnerTestBlock } from '../../config';
 import type { Logger } from '../../log';
+import { boundedWait } from '../../processes';
 import { vendorBinary } from '../../vendor/pins';
 import type { AgentEvent, AgentLaunch, ExitInfo } from '../types';
+import { isFinalError, mergeRateLimits, quotaFromRateLimits, turnErrorKind } from './classify';
 import { appServerArgs, appServerEnv, threadOverrides } from './config';
+import { codexToolEnded, codexToolStarted } from './items';
 import type { CodexClientMethod, ParamsOf, ResultOf } from './methods';
+import { codexAccountIdentity } from './policy';
 import { openAppServer, type AppServerProcess } from './process';
+import type { ServerNotification } from './protocol';
+import type { RateLimitSnapshot, Turn, TurnError } from './protocol/v2';
 import { RpcError } from './rpc';
 
 export interface CodexSessionOptions {
@@ -18,25 +25,58 @@ export interface CodexSessionOptions {
   userHome: string;
   /** Passed by the adapter only in test mode. */
   testConfig?: RunnerTestBlock['codexConfig'] | null;
+  /** test.skipAuthChecks, only in test mode: quota is then reported for core's TEST_ACCOUNT_ID, as preflight does. */
+  skipAuthChecks?: boolean;
   logger?: Logger;
   /** Bounds each app-server request; tests pass a short one. */
   requestTimeoutMs?: number;
 }
 
+type TurnEnded = Extract<AgentEvent, { type: 'turn_ended' }>;
+
+/** A started tool item and the main turn it counts for: its own turn on the main thread, else the active one. */
+interface OpenTool {
+  toolId: string;
+  threadId: string;
+  turnId: string;
+  mainTurn: string | null;
+}
+
 export class CodexSession {
   readonly pid: number;
   readonly events: AsyncIterable<AgentEvent>;
   readonly exited: Promise<ExitInfo>;
   private readonly queue = new EventQueue();
+  private activeTurn: string | null = null;
+  private readonly turns = new Map<string, { started: boolean; toolCalls: number; error: TurnError | null }>();
+  /** Started tool items, keyed by thread, turn and item. */
+  private readonly tools = new Map<string, OpenTool>();
+  /** Tools a turn's end ended before their item/completed: a late one is not reported again. */
+  private readonly endedTools = new Set<string>();
+  private rateLimits: RateLimitSnapshot | null = null;
+  /** A quota failure's end, held until account/rateLimits/read settles. */
+  private ending: Promise<void> | null = null;
 
   private constructor(
     private readonly app: AppServerProcess,
     readonly sessionRef: string,
+    private readonly accountId: string | null,
+    unsubscribe: () => void,
   ) {
     this.pid = app.pid;
     this.events = this.queue;
     this.exited = app.exited;
-    void this.exited.then(() => this.queue.end());
+    void this.exited.then(async () => {
+      // An escaped child can hold stdout open after the leader exits.
+      await boundedWait(app.rpc.ended, 1000);
+      unsubscribe();
+      await this.ending;
+      this.queue.end();
+    });
+  }
+
+  get activeTurnId(): string | null {
+    return this.activeTurn;
   }
 
   static async start(launch: AgentLaunch, options: CodexSessionOptions): Promise<CodexSession> {
@@ -58,6 +98,12 @@ export class CodexSession {
       logger: options.logger,
       requestTimeoutMs: options.requestTimeoutMs,
     });
+    let session: CodexSession | null = null;
+    const pending: ServerNotification[] = [];
+    const unsubscribeNotifications = app.rpc.onNotification((notification) => {
+      if (session) session.notification(notification);
+      else pending.push(notification);
+    });
     let warning: string | null = null;
     const unsubscribeWarning = app.rpc.on('configWarning', ({ summary }) => {
       warning ??= `codex reported a configuration warning: ${summary}`;
@@ -84,10 +130,17 @@ export class CodexSession {
       );
       if (warning !== null) throw new Error(warning);
       unsubscribe();
+      // Quota is account state: the hub applies an exhaustion to every runner on that account (design 6.10).
+      const accountId = options.skipAuthChecks
+        ? TEST_ACCOUNT_ID
+        : await app.rpc.request('account/read', { refreshToken: false }).then(
+            ({ account }) => codexAccountIdentity(account).accountId,
+            () => null,
+          );
       if (!resumed) {
         await request(app, 'thread/name/set', { threadId: thread.thread.id, name: `agflow ${launch.attemptId}` });
       }
-      const session = new CodexSession(app, thread.thread.id);
+      session = new CodexSession(app, thread.thread.id, accountId, unsubscribeNotifications);
       // The controller starts consuming only after start resolves, so these must already be buffered.
       session.queue.push({
         type: 'started',
@@ -105,15 +158,19 @@ export class CodexSession {
       if (tools.length > 0) {
         session.queue.push({ type: 'warning', text: `codex thread lists extra agflow tools: ${tools.join(', ')}` });
       }
+      for (const notification of pending) session.notification(notification);
+      pending.length = 0;
       if (!resumed) {
         // Both start and resume carry the tools note in developerInstructions.
-        await request(app, 'turn/start', {
+        const { turn } = await request(app, 'turn/start', {
           threadId: session.sessionRef,
           input: [{ type: 'text', text: launch.firstPrompt, text_elements: [] }],
         });
+        session.activeTurn = turn.id;
       }
       return session;
     } catch (error) {
+      unsubscribeNotifications();
       await app.end();
       throw new Error(oneLine(warning ?? error));
     } finally {
@@ -125,6 +182,184 @@ export class CodexSession {
     await this.app.end();
   }
 
+  private notification(notification: ServerNotification): void {
+    switch (notification.method) {
+      case 'turn/started': {
+        const { threadId, turn } = notification.params;
+        if (threadId !== this.sessionRef) return;
+        this.activeTurn = turn.id;
+        const state = this.turnState(turn.id);
+        if (!state.started) {
+          state.started = true;
+          this.queue.push({ type: 'turn_started' });
+        }
+        return;
+      }
+      case 'turn/completed': {
+        const { threadId, turn } = notification.params;
+        if (threadId === this.sessionRef) {
+          this.turnCompleted(turn);
+        } else if (turn.status !== 'inProgress') {
+          // A child turn interrupted with a command approval pending does not complete that item either, and its tools
+          // may count for no main turn: they end with their own turn.
+          this.endOpenTools((tool) => tool.threadId === threadId && tool.turnId === turn.id);
+        }
+        return;
+      }
+      case 'error': {
+        const params = notification.params;
+        if (params.threadId === this.sessionRef && isFinalError(params)) {
+          this.turnState(params.turnId).error = params.error;
+        }
+        return;
+      }
+      case 'item/started':
+      case 'item/completed': {
+        const { item, threadId, turnId } = notification.params;
+        const start = codexToolStarted(item);
+        if (start) {
+          const key = JSON.stringify([threadId, turnId, item.id]);
+          if (this.endedTools.has(key)) {
+            if (notification.method === 'item/completed') this.endedTools.delete(key);
+            return;
+          }
+          if (!this.tools.has(key)) {
+            // Child tools are progress for the attempt while its main turn runs.
+            const mainTurn = threadId === this.sessionRef ? turnId : this.activeTurn;
+            this.tools.set(key, { toolId: item.id, threadId, turnId, mainTurn });
+            if (mainTurn !== null) this.turnState(mainTurn).toolCalls += 1;
+            this.queue.push(start);
+          }
+          if (notification.method === 'item/completed') {
+            this.queue.push(codexToolEnded(item)!);
+            this.tools.delete(key);
+          }
+        } else if (
+          notification.method === 'item/completed' &&
+          threadId === this.sessionRef &&
+          item.type === 'agentMessage'
+        ) {
+          this.queue.push({ type: 'text', text: item.text });
+        }
+        return;
+      }
+      case 'thread/tokenUsage/updated': {
+        const { threadId, tokenUsage } = notification.params;
+        if (threadId === this.sessionRef && tokenUsage.modelContextWindow) {
+          this.queue.push({ type: 'context', used: tokenUsage.last.inputTokens / tokenUsage.modelContextWindow });
+        }
+        return;
+      }
+      case 'account/rateLimits/updated':
+        this.rateLimits = mergeRateLimits(this.rateLimits, notification.params.rateLimits);
+        if (this.rateLimits)
+          this.queue.push({ type: 'quota', accountId: this.accountId, quota: quotaFromRateLimits(this.rateLimits) });
+        return;
+      case 'warning':
+        this.warn('warning', notification.params.message);
+        return;
+      case 'configWarning':
+        this.warn(
+          'configuration warning',
+          [notification.params.summary, notification.params.details].filter(Boolean).join(': '),
+        );
+        return;
+      case 'deprecationNotice':
+        this.warn('deprecation', [notification.params.summary, notification.params.details].filter(Boolean).join(': '));
+        return;
+      case 'model/rerouted': {
+        const { fromModel, toModel, reason } = notification.params;
+        this.warn('model rerouted', `${fromModel} -> ${toModel} (${reason})`);
+        return;
+      }
+    }
+  }
+
+  private turnState(id: string) {
+    let state = this.turns.get(id);
+    if (!state) {
+      state = { started: false, toolCalls: 0, error: null };
+      this.turns.set(id, state);
+    }
+    return state;
+  }
+
+  private turnCompleted(turn: Turn): void {
+    if (turn.status === 'inProgress') return;
+    this.endOpenTools((tool) => tool.mainTurn === turn.id);
+    const state = this.turnState(turn.id);
+    const error = turn.status === 'failed' ? (state.error ?? turn.error) : null;
+    const errorKind = turn.status === 'failed' ? turnErrorKind(error?.codexErrorInfo ?? null, this.rateLimits) : null;
+    this.turns.delete(turn.id);
+    if (this.activeTurn === turn.id) this.activeTurn = null;
+    this.endTurn(turn.status, state.toolCalls, error, errorKind);
+  }
+
+  /**
+   * Ends the open tools of a turn that has ended: a main turn's end also ends the child tools that count for it. An
+   * interrupt with a command approval pending completes the turn without that command's item/completed.
+   */
+  private endOpenTools(ended: (tool: OpenTool) => boolean): void {
+    for (const [key, tool] of this.tools) {
+      if (!ended(tool)) continue;
+      this.tools.delete(key);
+      this.endedTools.add(key);
+      this.queue.push({
+        type: 'tool_ended',
+        toolId: tool.toolId,
+        ok: false,
+        denied: false,
+        terminal: null,
+        hubUnreachable: false,
+      });
+    }
+  }
+
+  private endTurn(
+    outcome: TurnEnded['outcome'],
+    toolCalls: number,
+    error: TurnError | null,
+    errorKind: TurnEnded['errorKind'],
+  ): void {
+    const end = () => {
+      if (errorKind === 'quota') this.pushExhausted();
+      this.queue.push({ type: 'turn_ended', outcome, toolCalls, error: error?.message ?? null, errorKind });
+    };
+    if (errorKind !== 'quota' || (this.rateLimits && quotaFromRateLimits(this.rateLimits).resetsAt !== null)) {
+      end();
+      return;
+    }
+    // Without a known reset the hub would wait and probe; app-server can tell it now (design 9.2).
+    this.ending = this.app.rpc
+      .request('account/rateLimits/read', undefined)
+      .then(
+        ({ rateLimits }) => {
+          this.rateLimits = mergeRateLimits(this.rateLimits, rateLimits);
+        },
+        () => {},
+      )
+      .then(() => {
+        this.ending = null;
+        end();
+      });
+  }
+
+  private pushExhausted(): void {
+    const quota = this.rateLimits
+      ? quotaFromRateLimits(this.rateLimits)
+      : {
+          resetsAt: null,
+          windows: { fiveHour: null, weekly: null },
+          paidUsage: 'unknown' as const,
+          updatedAt: Date.now(),
+        };
+    this.queue.push({ type: 'quota', accountId: this.accountId, quota: { ...quota, state: 'exhausted' } });
+  }
+
+  private warn(kind: string, text: string): void {
+    this.queue.push({ type: 'warning', text: oneLine(`codex ${kind}: ${text}`) });
+  }
+
   private static async openThread(
     app: AppServerProcess,
     launch: AgentLaunch,
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `bun test packages/runner/test/codex/session-events.test.ts packages/runner/test/codex/session-start.test.ts packages/runner/test/codex/session-resume.test.ts && bun test && bun run typecheck`
Expected: the task's tests pass (105 pass); then the whole suite passes (`0 fail`) and `tsc` exits 0.

A child thread's turn ends its own open tools when it completes, and a late `item/started` or `item/completed` for an ended tool is not reported again. `toolCalls` counts the main turn's tools plus child-thread tools started while it runs. Shell unwrapping accepts only `<...sh> -c|-lc '<script>'` with shlex's quoting, and a `fileChange`'s input is `<path>\n<diff>` per change (design 6.8). A quota failure with no known reset reads `account/rateLimits/read` before the exhausted quota and `turn_ended`; all-null rate-limit updates report nothing. The events end after the exit, with at most 1 s more for stdout. With `skipAuthChecks` (a new session option) the account id is `TEST_ACCOUNT_ID` and no `account/read` is sent. The fake peer's pipe holder gains `notify`, and Tasks 12 and 13's request lists gain `account/read`. The start and resume request-order assertions retain the per-launch bridge tool inventory and the developerInstructions overrides from Tasks 7, 12 and 13; this task adds account/read after the start checks.

- [ ] **Step 5: Commit**

```bash
git add -A 'packages/runner/src/adapters/codex/items.ts' 'packages/runner/src/adapters/codex/session.ts' 'packages/runner/test/codex/fake-app-server.ts' 'packages/runner/test/codex/peer.ts' 'packages/runner/test/codex/session-events.test.ts' 'packages/runner/test/codex/session-resume.test.ts' 'packages/runner/test/codex/session-start.test.ts'
git commit -m 'M2E Task 14: Turn, item and status events' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

### Task 15: Context recovery and compaction turns

Design 9.2 and X-31: the first `contextWindowExceeded` of a session gets one `thread/compact/start` and a continuation turn, and no `turn_ended` for the failed turn; the next one ends the turn failed with `errorKind` `context`, which M2b reports as `attempt.vendor_outcome` `context`. `thread/compact/start` runs as its own turn on the main thread, with a `contextCompaction` item and the compaction prompt sent to the provider. That turn must not look like an agent turn, so its start and end are hidden and `compacted` is emitted. A `contextCompaction` item inside a normal turn, Codex's own compaction, only emits `compacted`.

**Files:**
- Modify: `packages/runner/src/adapters/codex/session.ts`
- Test: `packages/runner/test/codex/session-context.test.ts`
- Test: `packages/runner/test/codex/session-events.test.ts`

- [ ] **Step 1: Write the failing tests**

**File:** `packages/runner/test/codex/session-context.test.ts` (new)

```ts
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { CODEX_VERSION } from '../../src/adapters/codex/binary';
import type { ServerNotification } from '../../src/adapters/codex/protocol';
import type { CodexErrorInfo } from '../../src/adapters/codex/protocol/v2';
import { CodexSession } from '../../src/adapters/codex/session';
import type { AgentEvent } from '../../src/adapters/types';
import {
  codexMessages as m,
  FAKE_THREAD_ID as MAIN,
  fakeTurnId,
  readCodexRecord,
  type ScriptedAnswers,
  type ScriptedStep,
} from './peer';
import { cleanupSessions, collect, firstInput, sessionFixture } from './session-fixture';

const FIRST = fakeTurnId(1);
const NEXT = fakeTurnId(2);
const COMPACT = 'compaction-turn';
const NOTE = 'System note: The context window filled up and was compacted. Continue your task where you left off.';
const started: AgentEvent = {
  type: 'started',
  sessionRef: MAIN,
  model: 'requested-model',
  cliVersion: CODEX_VERSION,
  permissionMode: 'on-request',
};
const turnStarted: AgentEvent = { type: 'turn_started' };
const compacted: AgentEvent = { type: 'compacted', summary: null };
const ended = (
  error: string | null = null,
  toolCalls = 0,
  errorKind: Extract<AgentEvent, { type: 'turn_ended' }>['errorKind'] = error === null ? null : 'context',
): AgentEvent => ({
  type: 'turn_ended',
  outcome: error === null ? 'completed' : 'failed',
  toolCalls,
  error,
  errorKind,
});
const tool = (id = 'exec') =>
  m.commandExecutionItem({ id, command: 'echo hi', cwd: '/tmp', status: 'completed', exitCode: 0 });
const toolEvents = (toolId = 'exec'): AgentEvent[] => [
  { type: 'tool_started', toolId, name: 'exec_command', input: 'echo hi', command: 'echo hi' },
  { type: 'tool_ended', toolId, ok: true, denied: false, terminal: null, hubUnreachable: false },
];
/** A compaction turn that ends with status and, when failed, that final error. */
const compactionEnd = (status: 'failed' | 'interrupted', info?: CodexErrorInfo, message = 'compaction failed') =>
  steps([
    begin(COMPACT),
    ...(info === undefined ? [] : [m.error(MAIN, COMPACT, m.turnError(info, message))]),
    m.turnCompleted(MAIN, m.turn({ id: COMPACT, status })),
  ]);
const begin = (id: string, thread = MAIN) => m.turnStarted(thread, m.turn({ id, status: 'inProgress' }));
const finish = (id: string) => m.turnCompleted(MAIN, m.turn({ id, status: 'completed' }));
const steps = (notes: ServerNotification[]): ScriptedStep[] => notes.map((notify) => ({ notify }));
const failure = (id: string): ServerNotification[] => [
  m.error(MAIN, id, m.turnError('contextWindowExceeded', 'context full')),
  m.turnCompleted(MAIN, m.turn({ id, status: 'failed' })),
];
const compaction = (id: string): ServerNotification[] => [
  m.itemStarted(MAIN, id, m.contextCompactionItem()),
  m.itemCompleted(MAIN, id, m.contextCompactionItem()),
  { method: 'thread/compacted', params: { threadId: MAIN, turnId: id } },
];
const compactRequest = { method: 'thread/compact/start', params: { threadId: MAIN } };
const continuationRequest = {
  method: 'turn/start',
  params: { threadId: MAIN, input: [{ type: 'text', text: NOTE, text_elements: [] }] },
};

afterEach(() => {
  mock.restore();
  cleanupSessions();
});

async function run(first: ServerNotification[], overrides: ScriptedAnswers = {}) {
  const f = sessionFixture({
    answers: {
      'turn/start': [
        // Bound a broken recovery too, so a missing request fails an assertion rather than hanging the test.
        { then: [...steps(first), { delayMs: 500 }, { crash: { code: 0 } }] },
        { then: [...steps([begin(NEXT), finish(NEXT)]), { crash: { code: 0 } }] },
      ],
      'thread/compact/start': { result: {}, then: steps([begin(COMPACT), ...compaction(COMPACT), finish(COMPACT)]) },
      ...overrides,
    },
  });
  const session = await CodexSession.start(f.launch, f.options);
  const events = await collect(session.events);
  expect(await session.exited).toEqual({ code: 0, signal: null });
  expect(session.activeTurnId).toBeNull();
  await session.close();
  const requests = readCodexRecord(f.bin)[0]!
    .requests.filter(({ method }) => method === 'turn/start' || method === 'thread/compact/start')
    .map(({ method, params }) => ({ method, params }));
  const firstRequest = {
    method: 'turn/start',
    params: { threadId: MAIN, input: firstInput(f.launch.firstPrompt) },
  };
  return { events, requests, firstRequest };
}

describe('CodexSession context recovery', () => {
  test('hides the failed end and compaction turn, then starts one ordinary continuation', async () => {
    const result = await run([begin(FIRST), ...failure(FIRST)]);
    expect(result.events).toEqual([started, turnStarted, compacted, turnStarted, ended()]);
    expect(result.requests).toEqual([result.firstRequest, compactRequest, continuationRequest]);
  });

  test("a failed turn's own contextWindowExceeded, without a final error, is recovered too", async () => {
    const result = await run([
      begin(FIRST),
      m.turnCompleted(
        MAIN,
        m.turn({ id: FIRST, status: 'failed', error: m.turnError('contextWindowExceeded', 'full') }),
      ),
    ]);
    expect(result.events).toEqual([started, turnStarted, compacted, turnStarted, ended()]);
    expect(result.requests).toEqual([result.firstRequest, compactRequest, continuationRequest]);
  });

  test('a second final context error ends the continuation without another compaction', async () => {
    const tool = m.commandExecutionItem({
      id: 'exec',
      command: 'echo hi',
      cwd: '/tmp',
      status: 'completed',
      exitCode: 0,
    });
    const result = await run([], {
      'turn/start': [
        { then: [...steps([begin(FIRST), ...failure(FIRST)]), { delayMs: 500 }, { crash: { code: 0 } }] },
        {
          then: [...steps([begin(NEXT), m.itemCompleted(MAIN, NEXT, tool), ...failure(NEXT)]), { crash: { code: 0 } }],
        },
      ],
    });
    expect(result.events).toEqual([
      started,
      turnStarted,
      compacted,
      turnStarted,
      { type: 'tool_started', toolId: 'exec', name: 'exec_command', input: 'echo hi', command: 'echo hi' },
      { type: 'tool_ended', toolId: 'exec', ok: true, denied: false, terminal: null, hubUnreachable: false },
      ended('context full', 1),
    ]);
    expect(result.requests).toEqual([result.firstRequest, compactRequest, continuationRequest]);
  });

  test('automatic compaction leaves normal turns visible and preserves the recovery allowance', async () => {
    const result = await run([
      begin(FIRST),
      m.error(MAIN, FIRST, m.turnError('contextWindowExceeded', 'retrying'), true),
      m.error('child-thread', 'child', m.turnError('contextWindowExceeded', 'child full')),
      m.itemCompleted('child-thread', 'child', m.contextCompactionItem()),
      ...compaction(FIRST),
      finish(FIRST),
      begin('later'),
      ...failure('later'),
    ]);
    expect(result.events).toEqual([
      started,
      turnStarted,
      compacted,
      ended(),
      turnStarted,
      compacted,
      turnStarted,
      ended(),
    ]);
    expect(result.requests).toEqual([result.firstRequest, compactRequest, continuationRequest]);
  });

  test("a rejected compaction request exposes one context failure with the failed turn's tools", async () => {
    const result = await run([begin(FIRST), m.itemCompleted(MAIN, FIRST, tool()), ...failure(FIRST)], {
      'thread/compact/start': { error: { code: -32603, message: 'cannot compact' } },
    });
    expect(result.events).toEqual([
      started,
      turnStarted,
      ...toolEvents(),
      ended('codex thread/compact/start failed: cannot compact', 1),
    ]);
    expect(result.requests).toEqual([result.firstRequest, compactRequest]);
  });

  test('a failed compaction turn ends as its own failure, counting the tools of both hidden turns', async () => {
    const result = await run([begin(FIRST), m.itemCompleted(MAIN, FIRST, tool()), ...failure(FIRST)], {
      'thread/compact/start': {
        result: {},
        then: steps([
          begin(COMPACT),
          m.itemCompleted(MAIN, COMPACT, tool('compact-exec')),
          m.error(MAIN, COMPACT, m.turnError('internalServerError', 'compaction failed')),
          m.turnCompleted(MAIN, m.turn({ id: COMPACT, status: 'failed' })),
        ]),
      },
    });
    expect(result.events).toEqual([
      started,
      turnStarted,
      ...toolEvents(),
      ...toolEvents('compact-exec'),
      ended('compaction failed', 2, 'vendor'),
    ]);
    expect(result.requests).toEqual([result.firstRequest, compactRequest]);
  });

  test('an interrupted compaction turn ends interrupted, without a continuation', async () => {
    const result = await run([begin(FIRST), ...failure(FIRST)], {
      'thread/compact/start': { result: {}, then: compactionEnd('interrupted') },
    });
    expect(result.events).toEqual([
      started,
      turnStarted,
      { type: 'turn_ended', outcome: 'interrupted', toolCalls: 0, error: null, errorKind: null },
    ]);
    expect(result.requests).toEqual([result.firstRequest, compactRequest]);
  });

  test('a compaction turn that hits the usage limit reports the exhausted quota, then a quota failure', async () => {
    const now = 1793200000000;
    spyOn(Date, 'now').mockReturnValue(now);
    const result = await run([begin(FIRST), ...failure(FIRST)], {
      'thread/compact/start': { result: {}, then: compactionEnd('failed', 'usageLimitExceeded', 'usage limit') },
    });
    expect(result.events).toEqual([
      started,
      turnStarted,
      {
        type: 'quota',
        accountId: null,
        quota: {
          state: 'exhausted',
          resetsAt: null,
          windows: { fiveHour: null, weekly: null },
          paidUsage: 'unknown',
          updatedAt: now,
        },
      },
      ended('usage limit', 0, 'quota'),
    ]);
    expect(result.requests).toEqual([result.firstRequest, compactRequest]);
  });

  test('an unauthorized compaction turn is an auth failure', async () => {
    const result = await run([begin(FIRST), ...failure(FIRST)], {
      'thread/compact/start': { result: {}, then: compactionEnd('failed', 'unauthorized', 'login expired') },
    });
    expect(result.events).toEqual([started, turnStarted, ended('login expired', 0, 'auth')]);
    expect(result.requests).toEqual([result.firstRequest, compactRequest]);
  });

  test('a compaction request that times out after its turn started lets that turn decide', async () => {
    const result = await run([], {
      'turn/start': [
        {
          then: [
            ...steps([begin(FIRST), ...failure(FIRST)]),
            { delayMs: 50 },
            { notify: begin(COMPACT) },
            { delayMs: 400 },
            { notify: finish(COMPACT) },
            { delayMs: 500 },
            { crash: { code: 0 } },
          ],
        },
        { then: [...steps([begin(NEXT), finish(NEXT)]), { crash: { code: 0 } }] },
      ],
      'thread/compact/start': { silent: true },
    });
    expect(result.events).toEqual([started, turnStarted, turnStarted, ended()]);
    expect(result.requests).toEqual([result.firstRequest, compactRequest, continuationRequest]);
  });

  for (const stage of ['compaction', 'continuation'] as const) {
    test(`an exit during the ${stage} request reports no context failure`, async () => {
      const crash = {
        silent: true,
        then: [{ delayMs: 50 }, { crash: { signal: 'SIGKILL' } }] satisfies ScriptedStep[],
      };
      const f = sessionFixture({
        answers: {
          'turn/start': [{ then: steps([begin(FIRST), ...failure(FIRST)]) }, crash],
          'thread/compact/start':
            stage === 'compaction'
              ? crash
              : { result: {}, then: steps([begin(COMPACT), ...compaction(COMPACT), finish(COMPACT)]) },
        },
      });
      const session = await CodexSession.start(f.launch, f.options);
      expect(await collect(session.events)).toEqual(
        stage === 'compaction' ? [started, turnStarted] : [started, turnStarted, compacted],
      );
      expect(await session.exited).toEqual({ code: null, signal: 'SIGKILL' });
      await session.close();
    });
  }

  test('hidden-turn tools still report progress without increasing the continuation tool count', async () => {
    const tool = m.commandExecutionItem({
      id: 'exec',
      command: 'echo hi',
      cwd: '/tmp',
      status: 'completed',
      exitCode: 0,
    });
    const result = await run([begin(FIRST), ...failure(FIRST)], {
      'thread/compact/start': {
        result: {},
        then: steps([
          begin('child', 'child-thread'),
          begin(COMPACT),
          m.itemCompleted(MAIN, COMPACT, tool),
          m.itemCompleted('child-thread', 'child', { ...tool, id: 'child-exec' }),
          ...compaction(COMPACT),
          finish(COMPACT),
        ]),
      },
    });
    expect(result.events).toEqual([
      started,
      turnStarted,
      ...['exec', 'child-exec'].flatMap<AgentEvent>((toolId) => [
        { type: 'tool_started', toolId, name: 'exec_command', input: 'echo hi', command: 'echo hi' },
        { type: 'tool_ended', toolId, ok: true, denied: false, terminal: null, hubUnreachable: false },
      ]),
      compacted,
      turnStarted,
      ended(),
    ]);
    expect(result.requests).toEqual([result.firstRequest, compactRequest, continuationRequest]);
  });

  test('waits for the failed completion and keeps the continuation answer active before its start notification', async () => {
    const f = sessionFixture({
      answers: {
        'turn/start': [
          {
            then: [
              ...steps([begin(FIRST), failure(FIRST)[0]!, m.warning('before completion')]),
              { delayMs: 100 },
              { notify: failure(FIRST)[1]! },
              { delayMs: 500 },
              { crash: { code: 0 } },
            ],
          },
          {
            then: [
              { notify: m.warning('continuation accepted') },
              { delayMs: 100 },
              ...steps([begin(NEXT), finish(NEXT)]),
              { crash: { code: 0 } },
            ],
          },
        ],
        'thread/compact/start': {
          result: {},
          then: [
            ...steps([begin(COMPACT), m.warning('compacting')]),
            { delayMs: 100 },
            ...steps([...compaction(COMPACT), finish(COMPACT)]),
          ],
        },
      },
    });
    const session = await CodexSession.start(f.launch, f.options);
    const events: AgentEvent[] = [];
    const firstRequest = {
      method: 'turn/start',
      params: { threadId: MAIN, input: firstInput(f.launch.firstPrompt) },
    };
    for await (const event of session.events) {
      events.push(event);
      if (event.type !== 'warning') continue;
      const stage = event.text.replace('codex warning: ', '');
      // The compaction turn is the active one while it runs: interrupts and steers meet it.
      expect(session.activeTurnId).toBe({ 'before completion': FIRST, compacting: COMPACT }[stage] ?? NEXT);
      expect(
        readCodexRecord(f.bin)[0]!
          .requests.filter(({ method }) => method === 'turn/start' || method === 'thread/compact/start')
          .map(({ method, params }) => ({ method, params })),
      ).toEqual(
        {
          'before completion': [firstRequest],
          compacting: [firstRequest, compactRequest],
        }[stage] ?? [firstRequest, compactRequest, continuationRequest],
      );
    }
    expect(events).toEqual([
      started,
      turnStarted,
      { type: 'warning', text: 'codex warning: before completion' },
      { type: 'warning', text: 'codex warning: compacting' },
      compacted,
      { type: 'warning', text: 'codex warning: continuation accepted' },
      turnStarted,
      ended(),
    ]);
    expect(session.activeTurnId).toBeNull();
    await session.close();
  });

  test('a rejected continuation request exposes the recovery failure', async () => {
    const result = await run([], {
      'turn/start': [
        { then: [...steps([begin(FIRST), ...failure(FIRST)]), { delayMs: 500 }, { crash: { code: 0 } }] },
        { error: { code: -32603, message: 'cannot continue' } },
      ],
    });
    expect(result.events).toEqual([started, turnStarted, compacted, ended('codex turn/start failed: cannot continue')]);
    expect(result.requests).toEqual([result.firstRequest, compactRequest, continuationRequest]);
  });
});
```

**File:** `packages/runner/test/codex/session-events.test.ts` (change)

```diff
diff --git a/packages/runner/test/codex/session-events.test.ts b/packages/runner/test/codex/session-events.test.ts
index 332b2f2d..72ad63c8 100644
--- a/packages/runner/test/codex/session-events.test.ts
+++ b/packages/runner/test/codex/session-events.test.ts
@@ -516,10 +516,7 @@ describe('CodexSession events', () => {
         begin(),
         m.error(MAIN, TURN, m.turnError('unauthorized', 'retry'), true),
         m.error(MAIN, TURN, m.turnError({ activeTurnNotSteerable: { turnKind: 'review' } }, 'steer')),
-        m.turnCompleted(
-          MAIN,
-          m.turn({ id: TURN, status: 'failed', error: m.turnError('contextWindowExceeded', 'full') }),
-        ),
+        m.turnCompleted(MAIN, m.turn({ id: TURN, status: 'failed', error: m.turnError('cyberPolicy', 'blocked') })),
       ]),
     ).toEqual([
       started,
@@ -528,8 +525,8 @@ describe('CodexSession events', () => {
         type: 'turn_ended',
         outcome: 'failed',
         toolCalls: 0,
-        error: 'full',
-        errorKind: 'context',
+        error: 'blocked',
+        errorKind: 'policy',
       },
     ]);
   });
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `bun test packages/runner/test/codex/session-context.test.ts packages/runner/test/codex/session-events.test.ts`
Expected: FAIL — `(fail) CodexSession context recovery > hides the failed end and compaction turn, then starts one ordinary continuation`: the events end with `turn_ended { outcome: 'failed', errorKind: 'context', error: 'context full' }` instead of `compacted`, a new `turn_started` and a completed `turn_ended` (43 pass, 15 fail, 2 errors)

- [ ] **Step 3: Implement**

**File:** `packages/runner/src/adapters/codex/session.ts` (change)

```diff
diff --git a/packages/runner/src/adapters/codex/session.ts b/packages/runner/src/adapters/codex/session.ts
index 77342520..a7a3cfd4 100644
--- a/packages/runner/src/adapters/codex/session.ts
+++ b/packages/runner/src/adapters/codex/session.ts
@@ -56,6 +56,11 @@ export class CodexSession {
   private rateLimits: RateLimitSnapshot | null = null;
   /** A quota failure's end, held until account/rateLimits/read settles. */
   private ending: Promise<void> | null = null;
+  private startingTurn = false;
+  private recoveredContext = false;
+  private compaction: { turnId: string | null; toolCalls: number } | null = null;
+  /** Turns a turn/start of ours answered: never the compaction turn. */
+  private readonly ownTurns = new Set<string>();
 
   private constructor(
     private readonly app: AppServerProcess,
@@ -162,11 +167,7 @@ export class CodexSession {
       pending.length = 0;
       if (!resumed) {
         // Both start and resume carry the tools note in developerInstructions.
-        const { turn } = await request(app, 'turn/start', {
-          threadId: session.sessionRef,
-          input: [{ type: 'text', text: launch.firstPrompt, text_elements: [] }],
-        });
-        session.activeTurn = turn.id;
+        await session.startTurn(launch.firstPrompt);
       }
       return session;
     } catch (error) {
@@ -189,9 +190,19 @@ export class CodexSession {
         if (threadId !== this.sessionRef) return;
         this.activeTurn = turn.id;
         const state = this.turnState(turn.id);
+        // compact/start answers no id: its turn is the next new main-thread turn that no turn/start of ours opened.
+        if (
+          this.compaction &&
+          this.compaction.turnId === null &&
+          !this.startingTurn &&
+          !this.ownTurns.has(turn.id) &&
+          !state.started
+        ) {
+          this.compaction.turnId = turn.id;
+        }
         if (!state.started) {
           state.started = true;
-          this.queue.push({ type: 'turn_started' });
+          if (this.compaction?.turnId !== turn.id) this.queue.push({ type: 'turn_started' });
         }
         return;
       }
@@ -240,6 +251,12 @@ export class CodexSession {
           item.type === 'agentMessage'
         ) {
           this.queue.push({ type: 'text', text: item.text });
+        } else if (
+          notification.method === 'item/completed' &&
+          threadId === this.sessionRef &&
+          item.type === 'contextCompaction'
+        ) {
+          this.queue.push({ type: 'compacted', summary: null });
         }
         return;
       }
@@ -291,7 +308,36 @@ export class CodexSession {
     const error = turn.status === 'failed' ? (state.error ?? turn.error) : null;
     const errorKind = turn.status === 'failed' ? turnErrorKind(error?.codexErrorInfo ?? null, this.rateLimits) : null;
     this.turns.delete(turn.id);
+    this.ownTurns.delete(turn.id);
     if (this.activeTurn === turn.id) this.activeTurn = null;
+    if (this.compaction?.turnId === turn.id) {
+      const toolCalls = this.compaction.toolCalls + state.toolCalls;
+      this.compaction = null;
+      if (turn.status === 'completed') {
+        void this.startTurn(
+          'System note: The context window filled up and was compacted. Continue your task where you left off.',
+        ).catch((error) => {
+          if (!this.gone) this.contextFailed(oneLine(error), toolCalls);
+        });
+      } else {
+        // Only a second context error is the context outcome; an interrupt or another failure ends as itself (9.2).
+        this.endTurn(turn.status, toolCalls, error, errorKind);
+      }
+      return;
+    }
+    // The final error or, without one, the failed turn's own error (design 9.2).
+    if (error?.codexErrorInfo === 'contextWindowExceeded' && !this.recoveredContext) {
+      this.recoveredContext = true;
+      this.compaction = { turnId: null, toolCalls: state.toolCalls };
+      void request(this.app, 'thread/compact/start', { threadId: this.sessionRef }).catch((error) => {
+        const compaction = this.compaction;
+        // A started compaction turn ends the recovery itself, and an exit reports the end on its own.
+        if (!compaction || compaction.turnId !== null) return;
+        this.compaction = null;
+        if (!this.gone) this.contextFailed(oneLine(error), compaction.toolCalls);
+      });
+      return;
+    }
     this.endTurn(turn.status, state.toolCalls, error, errorKind);
   }
 
@@ -356,6 +402,30 @@ export class CodexSession {
     this.queue.push({ type: 'quota', accountId: this.accountId, quota: { ...quota, state: 'exhausted' } });
   }
 
+  private async startTurn(...texts: string[]): Promise<void> {
+    this.startingTurn = true;
+    try {
+      const { turn } = await request(this.app, 'turn/start', {
+        threadId: this.sessionRef,
+        input: texts.map((text) => ({ type: 'text', text, text_elements: [] })),
+      });
+      this.ownTurns.add(turn.id);
+      this.activeTurn = turn.id;
+    } finally {
+      this.startingTurn = false;
+    }
+  }
+
+  /** The transport is gone: a rejected request then reports nothing, since the exit does. */
+  private get gone(): boolean {
+    return this.app.rpc.closed;
+  }
+
+  private contextFailed(error: string, toolCalls: number): void {
+    // Recovery hid the original end; expose one failure so the runner can replace the attempt.
+    this.queue.push({ type: 'turn_ended', outcome: 'failed', toolCalls, error, errorKind: 'context' });
+  }
+
   private warn(kind: string, text: string): void {
     this.queue.push({ type: 'warning', text: oneLine(`codex ${kind}: ${text}`) });
   }
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `bun test packages/runner/test/codex/session-context.test.ts packages/runner/test/codex/session-events.test.ts && bun test && bun run typecheck`
Expected: the task's tests pass (58 pass); then the whole suite passes (`0 fail`) and `tsc` exits 0.

The compaction turn is the first new main-thread turn after `thread/compact/start` while no `turn/start` of ours is unanswered, never a turn id our `turn/start` answered, because `thread/compact/start` answers `{}`. A compaction turn that ends interrupted gives `interrupted`, and a failed one is classified like any failed turn; `context` remains only for a second overflow, a rejected `thread/compact/start` whose turn never started, and a rejected continuation. Rejections after an exit report nothing. The continuation's text is 'System note: The context window filled up and was compacted. Continue your task where you left off.' Task 14's fallback-error test now uses `cyberPolicy`, since `contextWindowExceeded` starts recovery.

- [ ] **Step 5: Commit**

```bash
git add -A 'packages/runner/src/adapters/codex/session.ts' 'packages/runner/test/codex/session-context.test.ts' 'packages/runner/test/codex/session-events.test.ts'
git commit -m 'M2E Task 15: Context recovery and compaction turns' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

### Task 16: Messages, interrupt, close and exit

The session's `send`, `interrupt`, `close` and `exited` (design 9.2 Messages, 6.7, 9.4, 7.4, 13). People and the hub steer the active main-thread turn with `turn/steer { expectedTurnId }`, otherwise start one; agents always arrive as `turn/start { input: [], toolOutput: { name: 'agent_message', namespace: 'agflow', output } }`, with tool authority below user instructions. Every message reports `delivered` after its request and `acknowledged` when the turn that took it completes. A steer with a stale id or after the turn ends returns -32600, which gets one retry through `turn/start`; a steer during compaction returns `activeTurnNotSteerable`, which holds the message until that turn completes. Any other steer error, another -32600 included, rejects that send with one line, and the next send still runs.

**Files:**
- Modify: `packages/runner/src/adapters/codex/session.ts`
- Test: `packages/runner/test/codex/session-fixture.ts`
- Test: `packages/runner/test/codex/session-messages.test.ts`

- [ ] **Step 1: Write the failing tests**

**File:** `packages/runner/test/codex/session-fixture.ts` (change)

```diff
diff --git a/packages/runner/test/codex/session-fixture.ts b/packages/runner/test/codex/session-fixture.ts
index a3ee6172..9dc34919 100644
--- a/packages/runner/test/codex/session-fixture.ts
+++ b/packages/runner/test/codex/session-fixture.ts
@@ -165,6 +165,15 @@ export async function rejectedStart(f: SessionFixture, reason: string): Promise<
   return runs[0]!;
 }
 
+/** Polls until check holds, failing after ms. */
+export async function until(check: () => boolean, ms = 5_000): Promise<void> {
+  const deadline = Date.now() + ms;
+  while (!check()) {
+    if (Date.now() > deadline) throw new Error('timed out waiting for the condition');
+    await Bun.sleep(5);
+  }
+}
+
 export async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
   const result: AgentEvent[] = [];
   for await (const event of events) result.push(event);
```

**File:** `packages/runner/test/codex/session-messages.test.ts` (new)

```ts
import { afterEach, describe, expect, test } from 'bun:test';
import { CODEX_VERSION } from '../../src/adapters/codex/binary';
import { CodexSession } from '../../src/adapters/codex/session';
import type { AgentEvent } from '../../src/adapters/types';
import { codexMessages as m, FAKE_THREAD_ID as MAIN, fakeTurnId, readCodexRecord, type ScriptedError } from './peer';
import {
  alive,
  cleanupSessions,
  collect,
  firstInput,
  sessionFixture,
  until,
  type SessionFixture,
} from './session-fixture';

const FIRST = fakeTurnId(1);
const NEXT = fakeTurnId(2);
const started: AgentEvent = {
  type: 'started',
  sessionRef: MAIN,
  model: 'requested-model',
  cliVersion: CODEX_VERSION,
  permissionMode: 'on-request',
};
const delivered = (id: string): AgentEvent => ({ type: 'delivered', id });
const acknowledged = (id: string): AgentEvent => ({ type: 'acknowledged', id });
const message = (id: string, authority: 'person' | 'system' | 'agent' = 'person') => ({ id, text: id, authority });
const input = (text: string) => [{ type: 'text', text, text_elements: [] }];
const startRequest = (text: string) => ({ method: 'turn/start', params: { threadId: MAIN, input: input(text) } });
/** The first prompt's turn/start; the tools note is in developer instructions. */
const firstRequest = (f: SessionFixture) => ({
  method: 'turn/start',
  params: { threadId: MAIN, input: firstInput(f.launch.firstPrompt) },
});
const steerRequest = (text: string, expectedTurnId = FIRST) => ({
  method: 'turn/steer',
  params: { threadId: MAIN, input: input(text), expectedTurnId },
});
const interruptRequest = (turnId = FIRST) => ({ method: 'turn/interrupt', params: { threadId: MAIN, turnId } });
const COMPACT = 'compact';
const NOTE = 'System note: The context window filled up and was compacted. Continue your task where you left off.';
const contextFailure = (id = FIRST) =>
  m.turnCompleted(MAIN, m.turn({ id, status: 'failed', error: m.turnError('contextWindowExceeded', 'full') }));
const begin = (id: string) => m.turnStarted(MAIN, m.turn({ id, status: 'inProgress' }));
const turnStarted: AgentEvent = { type: 'turn_started' };
const finish = (id = FIRST, status: 'completed' | 'interrupted' | 'failed' = 'completed', thread = MAIN) =>
  m.turnCompleted(thread, m.turn({ id, status }));
const ended = (outcome: 'completed' | 'interrupted' | 'failed' = 'completed'): AgentEvent => ({
  type: 'turn_ended',
  outcome,
  toolCalls: 0,
  error: null,
  errorKind: outcome === 'failed' ? 'vendor' : null,
});
const notSteerable: ScriptedError = {
  code: -32600,
  message: 'cannot steer',
  data: { codexErrorInfo: { activeTurnNotSteerable: { turnKind: 'compact' } } },
};
const requests = (f: SessionFixture) =>
  readCodexRecord(f.bin)[0]!
    .requests.filter(({ method }) => method.startsWith('turn/'))
    .map(({ method, params }) => ({ method, params }));
const result = (promise: Promise<void>) =>
  promise.then(
    () => null,
    (error: unknown) => error,
  );

afterEach(cleanupSessions);

describe('CodexSession messages', () => {
  test('a completion racing the steer answer still follows delivered and acknowledged', async () => {
    const f = sessionFixture({
      answers: {
        'turn/start': { then: [{ delayMs: 40 }, { notify: finish() }] },
        'turn/steer': { delayMs: 100 },
      },
    });
    const session = await CodexSession.start(f.launch, f.options);
    await session.send(message('racing'));
    await session.close();
    expect(requests(f)).toEqual([firstRequest(f), steerRequest('racing')]);
    expect(await collect(session.events)).toEqual([started, delivered('racing'), acknowledged('racing'), ended()]);
  });

  for (const status of ['completed', 'interrupted', 'failed'] as const) {
    test(`serialises idle person and mid-turn system messages and acknowledges ${status}`, async () => {
      const f = sessionFixture({
        resume: MAIN,
        answers: {
          'turn/start': { delayMs: 60 },
          'turn/steer': { then: [{ notify: finish(FIRST, status, 'child') }, { notify: finish(FIRST, status) }] },
        },
      });
      const session = await CodexSession.start(f.launch, f.options);
      const events: AgentEvent[] = [];
      const draining = (async () => {
        for await (const event of session.events) events.push(event);
      })();
      const first = session.send(message('one'));
      const second = session.send(message('two', 'system'));
      await until(() => requests(f).length > 0);
      expect(requests(f)).toEqual([startRequest('one')]);
      expect(events).toEqual([started]);
      await Promise.all([first, second]);
      await until(() => events.length === 6);
      await session.close();
      await draining;
      expect(requests(f)).toEqual([startRequest('one'), steerRequest('two')]);
      expect(events).toEqual([
        started,
        delivered('one'),
        delivered('two'),
        acknowledged('one'),
        acknowledged('two'),
        ended(status),
      ]);
    });
  }

  for (const text of ['expected active turn id newer, got old', 'no active turn to steer']) {
    test(`retries one start after ${text}`, async () => {
      const f = sessionFixture({
        answers: {
          'turn/steer': { error: { code: -32600, message: text } },
          'turn/start': [{}, { then: [{ notify: finish(NEXT) }] }],
        },
      });
      const session = await CodexSession.start(f.launch, f.options);
      await session.send(message('retry'));
      await until(() => session.activeTurnId === null);
      await session.close();
      expect(requests(f)).toEqual([firstRequest(f), steerRequest('retry'), startRequest('retry')]);
      expect(await collect(session.events)).toEqual([started, delivered('retry'), acknowledged('retry'), ended()]);
    });
  }

  for (const error of [
    { code: -32603, message: 'broken\n  steer' },
    { code: -32600, message: 'another refusal' },
    { code: -32600, message: 'cannot steer', data: { activeTurnNotSteerable: { turnKind: 'compact' } } },
    { ...notSteerable, code: -32603 },
  ]) {
    test(`other steer error rejects without blocking the next send: ${JSON.stringify(error)}`, async () => {
      const f = sessionFixture({ answers: { 'turn/steer': [{ error }, {}] } });
      const session = await CodexSession.start(f.launch, f.options);
      const failed = result(session.send(message('bad')));
      const good = session.send(message('good'));
      expect(((await failed) as Error).message).toBe(`codex turn/steer failed: ${error.message.replace(/\s+/g, ' ')}`);
      await good;
      await session.close();
      expect(requests(f)).toEqual([firstRequest(f), steerRequest('bad'), steerRequest('good')]);
      expect(await collect(session.events)).toEqual([started, delivered('good')]);
    });
  }

  test('holds a non-steerable message and its successors until that main turn completes', async () => {
    const f = sessionFixture({
      answers: {
        'turn/steer': [
          { error: notSteerable, then: [{ notify: finish(FIRST, 'completed', 'child') }] },
          { then: [{ notify: finish(NEXT) }] },
        ],
        'turn/interrupt': { then: [{ delayMs: 30 }, { notify: finish() }] },
      },
    });
    const session = await CodexSession.start(f.launch, f.options);
    const events: AgentEvent[] = [];
    const draining = (async () => {
      for await (const event of session.events) events.push(event);
    })();
    let settled = false;
    const first = session.send(message('held')).then(() => {
      settled = true;
    });
    const second = session.send(message('behind', 'system'));
    await until(() => requests(f).length === 2);
    await Bun.sleep(20);
    expect(settled).toBe(false);
    expect(events).toEqual([started]);
    expect(requests(f)).toEqual([firstRequest(f), steerRequest('held')]);
    await session.interrupt();
    await Promise.all([first, second]);
    await until(() => events.length === 7);
    await session.close();
    await draining;
    expect(requests(f)).toEqual([
      firstRequest(f),
      steerRequest('held'),
      interruptRequest(),
      startRequest('held'),
      steerRequest('behind', NEXT),
    ]);
    expect(events).toEqual([
      started,
      ended(),
      delivered('held'),
      delivered('behind'),
      acknowledged('held'),
      acknowledged('behind'),
      ended(),
    ]);
  });

  for (const active of [true, false]) {
    test(`agent input uses tool authority with active=${active}`, async () => {
      const f = sessionFixture({
        resume: active ? null : MAIN,
        answers: {
          'turn/start': active
            ? [{}, { result: { turn: m.turn({ id: FIRST, status: 'inProgress' }) }, then: [{ notify: finish() }] }]
            : { then: [{ notify: finish() }] },
        },
      });
      const session = await CodexSession.start(f.launch, f.options);
      await session.send(message('agent says', 'agent'));
      await until(() => session.activeTurnId === null);
      await session.close();
      expect(requests(f)).toEqual([
        ...(active ? [firstRequest(f)] : []),
        {
          method: 'turn/start',
          params: {
            threadId: MAIN,
            input: [],
            toolOutput: { name: 'agent_message', namespace: 'agflow', output: 'agent says' },
          },
        },
      ]);
      expect(await collect(session.events)).toEqual([
        started,
        delivered('agent says'),
        acknowledged('agent says'),
        ended(),
      ]);
    });
  }

  test('acknowledges the answered steer id and the hidden context-error turn', async () => {
    const f = sessionFixture({
      answers: {
        'turn/steer': {
          result: { turnId: 'taken' },
          then: [
            { notify: finish() },
            {
              notify: m.turnCompleted(
                MAIN,
                m.turn({ id: 'taken', status: 'failed', error: m.turnError('contextWindowExceeded', 'full') }),
              ),
            },
          ],
        },
        'thread/compact/start': { result: {} },
      },
    });
    const session = await CodexSession.start(f.launch, f.options);
    await session.send(message('context'));
    await until(() => readCodexRecord(f.bin)[0]!.requests.some(({ method }) => method === 'thread/compact/start'));
    await session.close();
    expect(await collect(session.events)).toEqual([started, delivered('context'), ended(), acknowledged('context')]);
    expect(requests(f)).toEqual([firstRequest(f), steerRequest('context')]);
  });

  test('interrupt is idle-safe, cancels held and queued sends, and permits the handoff send', async () => {
    const f = sessionFixture({
      answers: {
        'turn/steer': { error: notSteerable },
        'turn/interrupt': { then: [{ notify: finish(FIRST, 'interrupted') }] },
      },
    });
    const session = await CodexSession.start(f.launch, f.options);
    const first = result(session.send(message('held')));
    const second = result(session.send(message('behind')));
    await until(() => requests(f).length === 2);
    await session.interrupt({ cancelQueued: true });
    expect(((await first) as Error).message).toBe('codex send cancelled');
    expect(((await second) as Error).message).toBe('codex send cancelled');
    await until(() => session.activeTurnId === null);
    await session.interrupt();
    await session.send(message('handoff', 'system'));
    await session.close();
    expect(requests(f)).toEqual([
      firstRequest(f),
      steerRequest('held'),
      interruptRequest(),
      startRequest('handoff'),
    ]);
    expect(await collect(session.events)).toEqual([started, ended('interrupted'), delivered('handoff')]);
  });

  test('interrupt failure is one line', async () => {
    const f = sessionFixture({
      answers: { 'turn/interrupt': { error: { code: -32603, message: 'cannot\n interrupt' } } },
    });
    const session = await CodexSession.start(f.launch, f.options);
    expect(((await result(session.interrupt())) as Error).message).toBe(
      'codex turn/interrupt failed: cannot interrupt',
    );
    await session.close();
    expect(requests(f)).toEqual([firstRequest(f), interruptRequest()]);
    expect(await collect(session.events)).toEqual([started]);
  });

  test('messages sent during recovery wait for the continuation and are steered into its turn', async () => {
    const f = sessionFixture({
      answers: {
        'turn/start': [
          {},
          {
            delayMs: 50,
            result: { turn: m.turn({ id: NEXT, status: 'inProgress' }) },
            then: [{ delayMs: 50 }, { notify: begin(NEXT) }, { notify: finish(NEXT) }],
          },
        ],
        'turn/steer': [{ then: [{ notify: contextFailure() }] }, {}],
        'thread/compact/start': {
          result: {},
          then: [{ notify: begin(COMPACT) }, { delayMs: 100 }, { notify: finish(COMPACT) }],
        },
      },
    });
    const session = await CodexSession.start(f.launch, f.options);
    await session.send(message('before'));
    await until(() => session.activeTurnId === COMPACT);
    const held = session.send(message('held'));
    const behind = session.send(message('behind', 'system'));
    await Bun.sleep(30);
    // Nothing is steered into the compaction turn, and nothing starts beside it.
    expect(requests(f)).toEqual([firstRequest(f), steerRequest('before')]);
    await Promise.all([held, behind]);
    await until(() => session.activeTurnId === null);
    await session.close();
    expect(requests(f)).toEqual([
      firstRequest(f),
      steerRequest('before'),
      startRequest(NOTE),
      steerRequest('held', NEXT),
      steerRequest('behind', NEXT),
    ]);
    expect(await collect(session.events)).toEqual([
      started,
      delivered('before'),
      acknowledged('before'),
      delivered('held'),
      delivered('behind'),
      turnStarted,
      acknowledged('held'),
      acknowledged('behind'),
      ended(),
    ]);
  });

  const interrupted: AgentEvent = {
    type: 'turn_ended',
    outcome: 'interrupted',
    toolCalls: 0,
    error: null,
    errorKind: null,
  };
  for (const stage of [
    'before the compaction turn',
    'during the compaction turn',
    'during the continuation start',
  ] as const) {
    test(`an interrupt ${stage} ends the recovery as interrupted, without a continuation`, async () => {
      const turn = stage === 'during the continuation start' ? NEXT : COMPACT;
      const f = sessionFixture({
        answers: {
          'turn/start': [
            { then: [{ notify: begin(FIRST) }, { delayMs: 30 }, { notify: contextFailure() }] },
            {
              delayMs: 150,
              result: { turn: m.turn({ id: NEXT, status: 'inProgress' }) },
              then: [{ notify: begin(NEXT) }],
            },
          ],
          'thread/compact/start': {
            result: {},
            then:
              stage === 'during the continuation start'
                ? [{ notify: begin(COMPACT) }, { notify: finish(COMPACT) }]
                : [{ delayMs: stage === 'before the compaction turn' ? 150 : 0 }, { notify: begin(COMPACT) }],
          },
          'turn/interrupt': { then: [{ notify: finish(turn, 'interrupted') }] },
        },
      });
      const session = await CodexSession.start(f.launch, f.options);
      const record = () => readCodexRecord(f.bin)[0]!.requests.map(({ method }) => method);
      if (stage === 'during the compaction turn') await until(() => session.activeTurnId === COMPACT);
      else if (stage === 'before the compaction turn') await until(() => record().includes('thread/compact/start'));
      else await until(() => record().filter((method) => method === 'turn/start').length === 2);
      const queued = result(session.send(message('queued')));
      await session.interrupt({ cancelQueued: true });
      expect(((await queued) as Error).message).toBe('codex send cancelled');
      await until(() => session.activeTurnId === null && record().includes('turn/interrupt'));
      await Bun.sleep(100);
      await session.close();
      expect(requests(f)).toEqual([
        firstRequest(f),
        ...(stage === 'during the continuation start' ? [startRequest(NOTE)] : []),
        interruptRequest(turn),
      ]);
      expect(await collect(session.events)).toEqual([
        started,
        turnStarted,
        ...(stage === 'during the continuation start' ? [turnStarted] : []),
        interrupted,
      ]);
    });
  }

  test('a turn that our turn/start opened is never taken for the compaction turn', async () => {
    const x = 'agent-turn';
    const f = sessionFixture({
      answers: {
        'turn/start': [
          { then: [{ notify: begin(FIRST) }, { delayMs: 60 }, { notify: contextFailure() }] },
          {
            delayMs: 150,
            result: { turn: m.turn({ id: x, status: 'inProgress' }) },
            then: [{ notify: begin(x) }, { notify: finish(x) }],
          },
          { then: [{ notify: begin(NEXT) }, { notify: finish(NEXT) }] },
        ],
        'thread/compact/start': {
          result: {},
          then: [{ delayMs: 50 }, { notify: begin(COMPACT) }, { notify: finish(COMPACT) }],
        },
      },
    });
    const session = await CodexSession.start(f.launch, f.options);
    // The failed turn ends while the agent message's turn/start is unanswered, so recovery starts after its answer.
    await session.send(message('agent says', 'agent'));
    await until(() => requests(f).length === 3 && session.activeTurnId === null);
    await Bun.sleep(50);
    await session.close();
    expect(requests(f).map(({ method }) => method)).toEqual(['turn/start', 'turn/start', 'turn/start']);
    expect(requests(f)[2]).toEqual(startRequest(NOTE));
    expect(await collect(session.events)).toEqual([
      started,
      turnStarted,
      delivered('agent says'),
      turnStarted,
      acknowledged('agent says'),
      ended(),
      turnStarted,
      ended(),
    ]);
  });

  test('a completion that overtakes a non-steerable answer does not hold the message', async () => {
    const f = sessionFixture({
      answers: {
        'turn/start': [{ then: [{ delayMs: 40 }, { notify: finish() }] }, { then: [{ notify: finish(NEXT) }] }],
        'turn/steer': { error: notSteerable, delayMs: 100 },
      },
    });
    const session = await CodexSession.start(f.launch, f.options);
    await session.send(message('late'));
    await until(() => session.activeTurnId === null);
    await session.close();
    expect(requests(f)).toEqual([firstRequest(f), steerRequest('late'), startRequest('late')]);
    expect(await collect(session.events)).toEqual([started, ended(), delivered('late'), acknowledged('late'), ended()]);
  });

  test('a rejected held delivery rejects its send and lets the next queued send proceed', async () => {
    const f = sessionFixture({
      answers: {
        'turn/start': [{}, { error: { code: -32603, message: 'cannot\n start' } }, {}],
        'turn/steer': { error: notSteerable },
        'turn/interrupt': { then: [{ notify: finish() }] },
      },
    });
    const session = await CodexSession.start(f.launch, f.options);
    const held = result(session.send(message('held')));
    const behind = session.send(message('behind'));
    await until(() => requests(f).length === 2);
    await session.interrupt();
    expect(((await held) as Error).message).toBe('codex turn/start failed: cannot start');
    await behind;
    await session.close();
    expect(requests(f)).toEqual([
      firstRequest(f),
      steerRequest('held'),
      interruptRequest(),
      startRequest('held'),
      startRequest('behind'),
    ]);
    expect(await collect(session.events)).toEqual([started, ended(), delivered('behind')]);
  });

  test('close ends stdin, rejects held and queued sends and refuses new sends immediately', async () => {
    const f = sessionFixture({ answers: { 'turn/steer': { error: notSteerable } } });
    const session = await CodexSession.start(f.launch, f.options);
    const first = result(session.send(message('held')));
    const second = result(session.send(message('behind')));
    await until(() => requests(f).length === 2);
    const closing = session.close();
    expect(await result(session.send(message('closed')))).toBeInstanceOf(Error);
    expect(await first).toBeInstanceOf(Error);
    expect(await second).toBeInstanceOf(Error);
    await closing;
    expect(await session.exited).toEqual({ code: 0, signal: null });
    expect(alive(session.pid)).toBe(false);
    expect(readCodexRecord(f.bin)[0]!.exit?.reason).toBe('eof');
    expect(requests(f)).toEqual([firstRequest(f), steerRequest('held')]);
    expect(await collect(session.events)).toEqual([started]);
  });

  test('a crash rejects a held send and the sends behind it without close', async () => {
    const f = sessionFixture({
      answers: { 'turn/steer': { error: notSteerable, then: [{ delayMs: 30 }, { crash: { signal: 'SIGKILL' } }] } },
    });
    const session = await CodexSession.start(f.launch, f.options);
    const held = result(session.send(message('held')));
    const behind = result(session.send(message('behind')));
    expect(((await held) as Error).message).toBe('codex session is closed');
    expect(((await behind) as Error).message).toBe('codex session is closed');
    expect(await session.exited).toEqual({ code: null, signal: 'SIGKILL' });
    await session.close();
  });

  test('crash rejects an unanswered send and the chain, exposes its signal and drains events', async () => {
    const f = sessionFixture({ answers: { 'turn/steer': { silent: true, then: [{ crash: { signal: 'SIGKILL' } }] } } });
    const session = await CodexSession.start(f.launch, f.options);
    const first = result(session.send(message('unanswered')));
    const second = result(session.send(message('queued')));
    expect(await first).toBeInstanceOf(Error);
    expect(await second).toBeInstanceOf(Error);
    expect(await session.exited).toEqual({ code: null, signal: 'SIGKILL' });
    expect(await collect(session.events)).toEqual([started]);
    expect(await result(session.send(message('after exit')))).toBeInstanceOf(Error);
    await session.interrupt();
    expect(requests(f)).toEqual([firstRequest(f), steerRequest('unanswered')]);
    await session.close();
  });
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `bun test packages/runner/test/codex/session-messages.test.ts`
Expected: FAIL — `TypeError: session.send is not a function. (In 'session.send(message("racing"))', 'session.send' is undefined)` (0 pass, 26 fail; observed in the 2026-11-11 parent replay).

- [ ] **Step 3: Implement**

**File:** `packages/runner/src/adapters/codex/session.ts` (change)

```diff
diff --git a/packages/runner/src/adapters/codex/session.ts b/packages/runner/src/adapters/codex/session.ts
index a7a3cfd4..d7936cc2 100644
--- a/packages/runner/src/adapters/codex/session.ts
+++ b/packages/runner/src/adapters/codex/session.ts
@@ -6,7 +6,7 @@ import type { RunnerTestBlock } from '../../config';
 import type { Logger } from '../../log';
 import { boundedWait } from '../../processes';
 import { vendorBinary } from '../../vendor/pins';
-import type { AgentEvent, AgentLaunch, ExitInfo } from '../types';
+import type { AgentEvent, AgentLaunch, AgentSession, ExitInfo } from '../types';
 import { isFinalError, mergeRateLimits, quotaFromRateLimits, turnErrorKind } from './classify';
 import { appServerArgs, appServerEnv, threadOverrides } from './config';
 import { codexToolEnded, codexToolStarted } from './items';
@@ -58,9 +58,21 @@ export class CodexSession {
   private ending: Promise<void> | null = null;
   private startingTurn = false;
   private recoveredContext = false;
-  private compaction: { turnId: string | null; toolCalls: number } | null = null;
+  /**
+   * Context recovery, from the failed turn's end until the continuation's turn/start answers. The session sends no
+   * turn/start or turn/steer of its own meanwhile; an interrupt ends it without the continuation.
+   */
+  private compaction: { turnId: string | null; toolCalls: number; interrupted: boolean } | null = null;
   /** Turns a turn/start of ours answered: never the compaction turn. */
   private readonly ownTurns = new Set<string>();
+  private sends: Promise<void> = Promise.resolve();
+  private sendGeneration = 0;
+  private closed = false;
+  /** A send waiting for that turn's completion or, with turnId null, for recovery or a quota end to finish. */
+  private held: { turnId: string | null; release(): void } | null = null;
+  private readonly acknowledgements = new Map<string, string[]>();
+  private sending = false;
+  private readonly completions: Turn[] = [];
 
   private constructor(
     private readonly app: AppServerProcess,
@@ -72,8 +84,11 @@ export class CodexSession {
     this.events = this.queue;
     this.exited = app.exited;
     void this.exited.then(async () => {
+      this.closed = true;
+      this.held?.release();
       // An escaped child can hold stdout open after the leader exits.
       await boundedWait(app.rpc.ended, 1000);
+      app.rpc.close();
       unsubscribe();
       await this.ending;
       this.queue.end();
@@ -179,10 +194,123 @@ export class CodexSession {
     }
   }
 
+  async send(message: Parameters<AgentSession['send']>[0]): Promise<void> {
+    this.checkSend();
+    const generation = this.sendGeneration;
+    const sent = this.sends.then(() => this.sendMessage(message, generation));
+    this.sends = sent.catch(() => {});
+    await sent;
+  }
+
+  async interrupt(options: { cancelQueued?: boolean } = {}): Promise<void> {
+    if (options.cancelQueued) {
+      this.sendGeneration += 1;
+      this.held?.release();
+    }
+    if (this.closed || this.app.rpc.closed) return;
+    // Recovery then ends without a continuation; a compaction turn not started yet is interrupted when it starts.
+    if (this.compaction) this.compaction.interrupted = true;
+    if (this.activeTurn === null) return;
+    await request(this.app, 'turn/interrupt', { threadId: this.sessionRef, turnId: this.activeTurn });
+  }
+
   async close(): Promise<void> {
+    this.closed = true;
+    this.held?.release();
     await this.app.end();
   }
 
+  private checkSend(generation = this.sendGeneration): void {
+    if (this.closed || this.app.rpc.closed) throw new Error('codex session is closed');
+    if (generation !== this.sendGeneration) throw new Error('codex send cancelled');
+  }
+
+  private async sendMessage(message: Parameters<AgentSession['send']>[0], generation: number): Promise<void> {
+    this.checkSend(generation);
+    try {
+      await this.deliverMessage(message, generation);
+    } finally {
+      this.flushCompletions();
+    }
+  }
+
+  private flushCompletions(): void {
+    this.sending = false;
+    for (const turn of this.completions.splice(0)) this.turnCompleted(turn);
+  }
+
+  private async deliverMessage(message: Parameters<AgentSession['send']>[0], generation: number): Promise<void> {
+    const input: ParamsOf<'turn/start'>['input'] = [{ type: 'text', text: message.text, text_elements: [] }];
+    let turnId: string | null = null;
+    // A turn that answered the steer as no longer active.
+    let ended: string | null = null;
+    while (turnId === null) {
+      while (this.compaction || this.ending) {
+        await this.hold(null);
+        this.checkSend(generation);
+      }
+      if (message.authority === 'agent' || this.activeTurn === null || this.activeTurn === ended) break;
+      const expectedTurnId: string = this.activeTurn;
+      this.sending = true;
+      try {
+        // Inspect the RPC error before flattening it to the session's one-line reason.
+        const answer = await this.app.rpc.request('turn/steer', { threadId: this.sessionRef, input, expectedTurnId });
+        turnId = answer.turnId;
+      } catch (error) {
+        if (!(error instanceof RpcError) || error.code !== -32600) {
+          throw new Error(`codex turn/steer failed: ${oneLine(error)}`);
+        }
+        if (notSteerable(error.data)) {
+          this.checkSend(generation);
+          const completed = this.completions.some((turn) => turn.id === expectedTurnId);
+          this.flushCompletions();
+          // Keep send pending so a failed delivery still reaches the caller; later sends wait in the chain.
+          if (!completed) await this.hold(expectedTurnId);
+          this.checkSend(generation);
+        } else if (
+          error.message.startsWith('expected active turn id') ||
+          error.message.startsWith('no active turn to steer')
+        ) {
+          // That turn's end goes first: it may start recovery, which the new turn must wait for.
+          this.flushCompletions();
+          ended = expectedTurnId;
+        } else {
+          throw new Error(`codex turn/steer failed: ${oneLine(error)}`);
+        }
+      }
+    }
+    if (turnId === null) {
+      this.checkSend(generation);
+      this.sending = true;
+      this.startingTurn = true;
+      try {
+        const { turn } = await request(this.app, 'turn/start', {
+          threadId: this.sessionRef,
+          input: message.authority === 'agent' ? [] : input,
+          ...(message.authority === 'agent'
+            ? { toolOutput: { name: 'agent_message', namespace: 'agflow', output: message.text } }
+            : {}),
+        });
+        turnId = turn.id;
+        this.ownTurns.add(turnId);
+        this.activeTurn = turnId;
+      } finally {
+        this.startingTurn = false;
+      }
+    }
+    const ids = this.acknowledgements.get(turnId) ?? [];
+    ids.push(message.id);
+    this.acknowledgements.set(turnId, ids);
+    this.queue.push({ type: 'delivered', id: message.id });
+  }
+
+  private async hold(turnId: string | null): Promise<void> {
+    await new Promise<void>((release) => {
+      this.held = { turnId, release };
+    });
+    this.held = null;
+  }
+
   private notification(notification: ServerNotification): void {
     switch (notification.method) {
       case 'turn/started': {
@@ -199,6 +327,8 @@ export class CodexSession {
           !state.started
         ) {
           this.compaction.turnId = turn.id;
+          if (this.compaction.interrupted)
+            void this.interrupt().catch((error) => this.warn('interrupt', oneLine(error)));
         }
         if (!state.started) {
           state.started = true;
@@ -303,7 +433,15 @@ export class CodexSession {
 
   private turnCompleted(turn: Turn): void {
     if (turn.status === 'inProgress') return;
+    // A completion may overtake an input answer; its acknowledgements must follow delivered.
+    if (this.sending) {
+      this.completions.push(turn);
+      return;
+    }
     this.endOpenTools((tool) => tool.mainTurn === turn.id);
+    for (const id of this.acknowledgements.get(turn.id) ?? []) this.queue.push({ type: 'acknowledged', id });
+    this.acknowledgements.delete(turn.id);
+    if (this.held?.turnId === turn.id) this.held.release();
     const state = this.turnState(turn.id);
     const error = turn.status === 'failed' ? (state.error ?? turn.error) : null;
     const errorKind = turn.status === 'failed' ? turnErrorKind(error?.codexErrorInfo ?? null, this.rateLimits) : null;
@@ -311,30 +449,33 @@ export class CodexSession {
     this.ownTurns.delete(turn.id);
     if (this.activeTurn === turn.id) this.activeTurn = null;
     if (this.compaction?.turnId === turn.id) {
-      const toolCalls = this.compaction.toolCalls + state.toolCalls;
-      this.compaction = null;
-      if (turn.status === 'completed') {
-        void this.startTurn(
-          'System note: The context window filled up and was compacted. Continue your task where you left off.',
-        ).catch((error) => {
-          if (!this.gone) this.contextFailed(oneLine(error), toolCalls);
-        });
+      const recovery = this.compaction;
+      const toolCalls = recovery.toolCalls + state.toolCalls;
+      if (turn.status === 'completed' && !recovery.interrupted) {
+        void this.continueRecovery(recovery, toolCalls);
       } else {
+        this.endRecovery();
         // Only a second context error is the context outcome; an interrupt or another failure ends as itself (9.2).
-        this.endTurn(turn.status, toolCalls, error, errorKind);
+        this.endTurn(turn.status === 'failed' ? 'failed' : 'interrupted', toolCalls, error, errorKind);
       }
       return;
     }
     // The final error or, without one, the failed turn's own error (design 9.2).
     if (error?.codexErrorInfo === 'contextWindowExceeded' && !this.recoveredContext) {
       this.recoveredContext = true;
-      this.compaction = { turnId: null, toolCalls: state.toolCalls };
+      const recovery: NonNullable<CodexSession['compaction']> = {
+        turnId: null,
+        toolCalls: state.toolCalls,
+        interrupted: false,
+      };
+      this.compaction = recovery;
       void request(this.app, 'thread/compact/start', { threadId: this.sessionRef }).catch((error) => {
-        const compaction = this.compaction;
         // A started compaction turn ends the recovery itself, and an exit reports the end on its own.
-        if (!compaction || compaction.turnId !== null) return;
-        this.compaction = null;
-        if (!this.gone) this.contextFailed(oneLine(error), compaction.toolCalls);
+        if (this.compaction !== recovery || recovery.turnId !== null) return;
+        this.endRecovery();
+        if (this.gone) return;
+        if (recovery.interrupted) this.endTurn('interrupted', recovery.toolCalls, null, null);
+        else this.contextFailed(oneLine(error), recovery.toolCalls);
       });
       return;
     }
@@ -387,6 +528,7 @@ export class CodexSession {
       .then(() => {
         this.ending = null;
         end();
+        this.wakeHeld();
       });
   }
 
@@ -402,6 +544,34 @@ export class CodexSession {
     this.queue.push({ type: 'quota', accountId: this.accountId, quota: { ...quota, state: 'exhausted' } });
   }
 
+  /** Messages wait for the continuation and are then steered into its turn. */
+  private async continueRecovery(recovery: NonNullable<CodexSession['compaction']>, toolCalls: number): Promise<void> {
+    try {
+      await this.startTurn(
+        'System note: The context window filled up and was compacted. Continue your task where you left off.',
+      );
+    } catch (error) {
+      if (this.gone) return;
+      if (recovery.interrupted) this.endTurn('interrupted', toolCalls, null, null);
+      else this.contextFailed(oneLine(error), toolCalls);
+      return;
+    } finally {
+      this.endRecovery();
+    }
+    // An interrupt that came while the start was pending applies to the turn it opened.
+    if (recovery.interrupted) void this.interrupt().catch((error) => this.warn('interrupt', oneLine(error)));
+  }
+
+  private endRecovery(): void {
+    this.compaction = null;
+    this.wakeHeld();
+  }
+
+  /** Lets a send waiting for recovery or a quota end go on. */
+  private wakeHeld(): void {
+    if (this.held?.turnId === null) this.held.release();
+  }
+
   private async startTurn(...texts: string[]): Promise<void> {
     this.startingTurn = true;
     try {
@@ -418,7 +588,7 @@ export class CodexSession {
 
   /** The transport is gone: a rejected request then reports nothing, since the exit does. */
   private get gone(): boolean {
-    return this.app.rpc.closed;
+    return this.closed || this.app.rpc.closed;
   }
 
   private contextFailed(error: string, toolCalls: number): void {
@@ -530,6 +700,12 @@ async function request<M extends CodexClientMethod>(
   }
 }
 
+function notSteerable(data: unknown): boolean {
+  if (typeof data !== 'object' || data === null || !('codexErrorInfo' in data)) return false;
+  const info = data.codexErrorInfo;
+  return typeof info === 'object' && info !== null && 'activeTurnNotSteerable' in info;
+}
+
 function oneLine(error: unknown): string {
   return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim();
 }
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `bun test packages/runner/test/codex/session-messages.test.ts && bun test && bun run typecheck`
Expected: the task's tests pass (26 pass); then the whole suite passes (`0 fail`) and `tsc` exits 0.

Sends run on one promise chain, and a failed send does not block the next. A held send stays pending until it goes out, so a deliver command waits through a compaction turn. `interrupt({ cancelQueued: true })` rejects held and queued sends with 'codex send cancelled', while later sends (the handoff prompt) go through; after exit or `close()` every send rejects at once. Context recovery is exclusive: from the failed turn's end until the continuation's `turn/start` answers, nothing else is started or steered, and an interrupt in any recovery window ends it as `interrupted` with no continuation. `session-fixture.ts` gains a deadline-based `until`. `firstRequest` uses `firstInput(launch.firstPrompt)`, a single user text item. The tools note belongs to developerInstructions.

- [ ] **Step 5: Commit**

```bash
git add -A 'packages/runner/src/adapters/codex/session.ts' 'packages/runner/test/codex/session-fixture.ts' 'packages/runner/test/codex/session-messages.test.ts'
git commit -m 'M2E Task 16: Messages, interrupt, close and exit' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

### Task 17: Approval requests in the adapter

The Codex half of design 9.3 and the identity rules of 6.10. Command, file-change and permission requests from any thread become `approval_request` events under a minted id; the adapter decides nothing, answers only `accept` or `decline`, and voids a request that `serverRequest/resolved` withdraws before an answer (X-9, X-31). A file change takes its diff from the preceding `fileChange` item, a `writeStdin` request is shown as stdin input, and approving a permissions request grants exactly the requested profile for the turn. Elicitations and unparseable requests are declined at once, `requestUserInput` gets 'no person is available; decide yourself or use declare_blocked', and any other request gets -32601. A decline with a reason steers one system note into the asking turn, and `waiting_approval` follows `waitingOnApproval` on any thread.

**Files:**
- Create: `packages/runner/src/adapters/codex/approvals.ts`
- Modify: `packages/runner/src/adapters/codex/session.ts`
- Test: `packages/runner/test/codex/approvals.test.ts`

- [ ] **Step 1: Write the failing test**

**File:** `packages/runner/test/codex/approvals.test.ts` (new)

```ts
import { afterEach, describe, expect, test } from 'bun:test';
import { approvalFromRequest, decisionResponse } from '../../src/adapters/codex/approvals';
import { CODEX_VERSION } from '../../src/adapters/codex/binary';
import type { CodexServerRequestMethod } from '../../src/adapters/codex/methods';
import type { RequestPermissionProfile } from '../../src/adapters/codex/protocol/v2';
import { CodexSession } from '../../src/adapters/codex/session';
import type { AgentEvent } from '../../src/adapters/types';
import {
  codexMessages as m,
  FAKE_THREAD_ID as MAIN,
  fakeTurnId,
  readCodexRecord,
  type ScriptedServerRequest,
  type ScriptedStep,
} from './peer';
import probes from './probe-messages.json';
import { cleanupSessions, firstInput, sessionFixture, until, type SessionFixture } from './session-fixture';

const TURN = fakeTurnId(1);
const commandMethod = 'item/commandExecution/requestApproval';
const fileMethod = 'item/fileChange/requestApproval';
const permissionsMethod = 'item/permissions/requestApproval';
const command = { ...probes.commandApprovalRequest, id: 'command' } as Extract<
  ScriptedServerRequest,
  { method: typeof commandMethod }
>;
const commandDetail = {
  command: probes.commandApprovalRequest.params.command,
  cwd: probes.commandApprovalRequest.params.cwd,
  reason: probes.commandApprovalRequest.params.reason,
};
const started: AgentEvent = {
  type: 'started',
  sessionRef: MAIN,
  model: 'requested-model',
  cliVersion: CODEX_VERSION,
  permissionMode: 'on-request',
};
const permissions = {
  network: { enabled: true },
  fileSystem: {
    read: ['/read'],
    write: ['/write'],
    globScanMaxDepth: 2,
    entries: [{ path: { type: 'glob_pattern', pattern: '/extra/**' }, access: 'read' }],
  },
} satisfies RequestPermissionProfile;
const permissionRequest = m.permissionsApprovalRequest({
  threadId: MAIN,
  turnId: TURN,
  itemId: 'permissions',
  cwd: '/clone',
  permissions,
  reason: 'need access',
  id: 'permissions',
});
const patch = m.fileChangeItem({
  id: 'patch',
  changes: [
    { path: 'one.ts', kind: { type: 'add' }, diff: '+one' },
    { path: 'two.ts', kind: { type: 'delete' }, diff: '-two' },
  ],
});
const patchRequest = m.fileChangeApprovalRequest({
  threadId: MAIN,
  turnId: TURN,
  itemId: patch.id,
  grantRoot: '/extra',
  reason: 'write files',
  id: 'patch',
});
const finish = () => m.turnCompleted(MAIN, m.turn({ id: TURN, status: 'completed' }));
const unknownFiles = 'the changed files are unknown: no file-change item was seen';
const requested = `Permissions: ${JSON.stringify(permissions)}`;
const ended: AgentEvent = { type: 'turn_ended', outcome: 'completed', toolCalls: 0, error: null, errorKind: null };
const answers = (f: SessionFixture) => readCodexRecord(f.bin)[0]!.answers.map(({ at, ...answer }) => answer);
const requests = (f: SessionFixture) =>
  readCodexRecord(f.bin)[0]!
    .requests.filter(({ method }) => method === 'turn/steer' || method === 'turn/start')
    .map(({ method, params }) => ({ method, params }));
const input = (text: string) => [{ type: 'text', text, text_elements: [] }];

async function running(steps: ScriptedStep[], extra: Parameters<typeof sessionFixture>[0] = {}) {
  const f = sessionFixture({ ...extra, answers: { 'turn/start': { then: steps }, ...extra.answers } });
  const session = await CodexSession.start(f.launch, f.options);
  const events: AgentEvent[] = [];
  const draining = (async () => {
    for await (const event of session.events) events.push(event);
  })();
  return {
    f,
    session,
    events,
    async close() {
      await session.close();
      await draining;
    },
  };
}

function approvals(events: AgentEvent[]) {
  return events.filter(
    (event): event is Extract<AgentEvent, { type: 'approval_request' }> => event.type === 'approval_request',
  );
}

function approval(
  id: string,
  kind: 'command' | 'file_change' | 'other',
  summary: string,
  detail: Extract<AgentEvent, { type: 'approval_request' }>['detail'],
): Extract<AgentEvent, { type: 'approval_request' }> {
  expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  return { type: 'approval_request', approvalId: id, kind, summary, detail };
}

afterEach(cleanupSessions);

describe('Codex approval mapping', () => {
  test('keeps the full recorded command and omits absent detail keys', () => {
    expect(approvalFromRequest(commandMethod, command.params)).toEqual({
      threadId: MAIN,
      turnId: probes.commandApprovalRequest.params.turnId,
      itemId: probes.commandApprovalRequest.params.itemId,
      kind: 'command',
      summary: `Run command: ${commandDetail.command}`,
      detail: commandDetail,
    });
    expect(approvalFromRequest(commandMethod, { ...command.params, command: null, cwd: null, reason: null })).toEqual({
      threadId: MAIN,
      turnId: probes.commandApprovalRequest.params.turnId,
      itemId: probes.commandApprovalRequest.params.itemId,
      kind: 'command',
      summary: 'Run command',
      detail: {},
    });
    expect(approvalFromRequest(fileMethod, patchRequest.params)).toEqual({
      threadId: MAIN,
      turnId: TURN,
      itemId: patch.id,
      kind: 'file_change',
      summary: 'Apply file changes',
      detail: { reason: `write files\n${unknownFiles}`, grantRoot: '/extra' },
    });
  });

  test('a file change shows each change with its kind and every path it touches', () => {
    const move = m.fileChangeItem({
      id: patch.id,
      changes: [
        {
          path: '/clone/notes.sh',
          kind: { type: 'update', move_path: '/Users/me/Library/LaunchAgents/x.plist' },
          diff: '@@ -1 +1 @@\n-a\n+b',
        },
        { path: '/clone/one.ts', kind: { type: 'update', move_path: null }, diff: '+one' },
        ...patch.changes,
      ],
    });
    expect(approvalFromRequest(fileMethod, { ...patchRequest.params, reason: null }, move)?.detail).toEqual({
      diff: [
        'move /clone/notes.sh -> /Users/me/Library/LaunchAgents/x.plist\n@@ -1 +1 @@\n-a\n+b',
        'update /clone/one.ts\n+one',
        'add one.ts\n+one',
        'delete two.ts\n-two',
      ].join('\n'),
      grantRoot: '/extra',
    });
  });

  test('bounds what an approval carries, whatever the agent asks to run or write', () => {
    const huge = 'x'.repeat(2 * 1024 * 1024);
    const bounded = (approval: ReturnType<typeof approvalFromRequest>) => {
      expect(approval).not.toBeNull();
      const { kind, summary, detail } = approval!;
      expect(Buffer.byteLength(JSON.stringify({ kind, summary, detail }))).toBeLessThan(300_000);
      expect(approval!.summary.length).toBeLessThanOrEqual(501);
      expect(approval!.summary).not.toContain('\n');
      return approval!;
    };
    const run = bounded(
      approvalFromRequest(commandMethod, { ...command.params, command: `cat <<EOF\n${huge}\nEOF`, reason: huge }),
    );
    expect(run.summary).toBe('Run command: cat <<EOF…');
    expect(run.detail.command).toEndWith(`\n[truncated: ${huge.length + 14} bytes in total]`);
    expect(run.detail.reason).toEndWith(`\n[truncated: ${huge.length} bytes in total]`);
    const stdin = bounded(approvalFromRequest(commandMethod, { ...command.params, kind: 'writeStdin', command: huge }));
    expect(stdin.summary).toBe(`Stdin input to running command: ${'x'.repeat(500 - 32)}…`);
    const item = m.fileChangeItem({ id: patch.id, changes: [{ path: 'big.txt', kind: { type: 'add' }, diff: huge }] });
    expect(bounded(approvalFromRequest(fileMethod, patchRequest.params, item)).detail.diff).toContain('[truncated: ');
    const wide = { ...permissions, fileSystem: { ...permissions.fileSystem, read: [huge] } };
    bounded(approvalFromRequest(permissionsMethod, { ...permissionRequest.params, permissions: wide }));
    // A cut never splits a character.
    const emoji = bounded(approvalFromRequest(commandMethod, { ...command.params, command: '😀'.repeat(400_000) }));
    expect(emoji.detail.command).toStartWith('😀'.repeat(16_384));
    expect(emoji.detail.command).not.toContain('\uFFFD');
    expect(emoji.summary).toBe(`Run command: ${'😀'.repeat(243)}…`);
  });

  test('uses accept or decline only, and grants no permissions on decline', () => {
    for (const method of [commandMethod, fileMethod] as const) {
      expect(decisionResponse(method, 'approve')).toEqual({ decision: 'accept' });
      expect(decisionResponse(method, 'decline')).toEqual({ decision: 'decline' });
    }
    expect(decisionResponse(permissionsMethod, 'approve', permissions)).toEqual({ permissions, scope: 'turn' });
    expect(decisionResponse(permissionsMethod, 'approve', { network: { enabled: true }, fileSystem: null })).toEqual({
      permissions: { network: { enabled: true } },
      scope: 'turn',
    });
    expect(decisionResponse(permissionsMethod, 'decline', permissions)).toEqual({ permissions: {}, scope: 'turn' });
  });

  test('rejects malformed identities, detail and permission profiles', () => {
    for (const params of [
      null,
      [],
      {},
      { ...command.params, threadId: 1 },
      { ...command.params, itemId: undefined },
      { ...command.params, cwd: 3 },
      { ...command.params, kind: 'unknown' },
      { ...command.params, reason: [] },
    ]) {
      expect(approvalFromRequest(commandMethod, params)).toBeNull();
    }
    for (const profile of [
      null,
      {},
      { network: { enabled: 'yes' }, fileSystem: null },
      { ...permissions, surprise: true },
      { ...permissions, fileSystem: { read: null, write: [3] } },
    ]) {
      expect(approvalFromRequest(permissionsMethod, { ...permissionRequest.params, permissions: profile })).toBeNull();
    }
    expect(approvalFromRequest(fileMethod, { ...patchRequest.params, grantRoot: 1 })).toBeNull();
  });
});

describe('CodexSession approvals', () => {
  test('relays the recorded request under a UUID and accepts only once without voiding its answer', async () => {
    const r = await running([{ request: command }]);
    await until(() => approvals(r.events).length === 1);
    const id = approvals(r.events)[0]!.approvalId;
    expect(r.events).toEqual([
      started,
      approval(id, 'command', `Run command: ${commandDetail.command}`, commandDetail),
    ]);
    expect(answers(r.f)).toEqual([]);
    expect(await r.session.answerApproval('unknown', 'approve', null)).toBe(false);
    expect(await r.session.answerApproval(id, 'approve', null)).toBe(true);
    expect(await r.session.answerApproval(id, 'decline', null)).toBe(false);
    await until(() => answers(r.f).length === 1);
    await r.close();
    expect(answers(r.f)).toEqual([{ id: 'command', result: { decision: 'accept' } }]);
    expect(r.events).toEqual([
      started,
      approval(id, 'command', `Run command: ${commandDetail.command}`, commandDetail),
    ]);
  });

  test('writeStdin describes the command field as stdin input and ignores session-wide offers', async () => {
    const text = 'yes\n';
    const req = {
      ...command,
      params: {
        ...command.params,
        kind: 'writeStdin',
        command: text,
        availableDecisions: ['acceptForSession', 'cancel'],
      },
    } as ScriptedServerRequest;
    const r = await running([{ request: req }]);
    await until(() => approvals(r.events).length === 1);
    const id = approvals(r.events)[0]!.approvalId;
    const display = `Stdin input to running command: ${text}`;
    // The summary is one line; the detail keeps the input as it is.
    expect(r.events).toEqual([
      started,
      approval(id, 'command', 'Stdin input to running command: yes…', { ...commandDetail, command: display }),
    ]);
    expect(await r.session.answerApproval(id, 'approve', null)).toBe(true);
    await until(() => answers(r.f).length === 1);
    await r.close();
    expect(answers(r.f)).toEqual([{ id: 'command', result: { decision: 'accept' } }]);
  });

  test('file changes keep per-thread item diffs until completion and show grantRoot', async () => {
    const r = await running([
      { notify: m.itemStarted(MAIN, TURN, patch) },
      {
        notify: m.itemStarted('child', TURN, {
          ...patch,
          changes: [{ path: 'child', kind: { type: 'add' }, diff: '+child' }],
        }),
      },
      {
        request: patchRequest,
        afterAnswer: [
          { notify: m.serverRequestResolved(MAIN, 'patch') },
          { notify: m.itemCompleted(MAIN, TURN, { ...patch, status: 'completed' }) },
          { request: { ...patchRequest, id: 'after-completion' } },
        ],
      },
    ]);
    await until(() => approvals(r.events).length === 1);
    const id = approvals(r.events)[0]!.approvalId;
    expect(approvals(r.events)).toEqual([
      approval(id, 'file_change', 'Apply file changes', {
        diff: 'add one.ts\n+one\ndelete two.ts\n-two',
        reason: 'write files',
        grantRoot: '/extra',
      }),
    ]);
    expect(await r.session.answerApproval(id, 'approve', null)).toBe(true);
    await until(() => approvals(r.events).length === 2);
    const next = approvals(r.events)[1]!.approvalId;
    expect(approvals(r.events)[1]).toEqual(
      approval(next, 'file_change', 'Apply file changes', {
        reason: `write files\n${unknownFiles}`,
        grantRoot: '/extra',
      }),
    );
    expect(await r.session.answerApproval(next, 'decline', null)).toBe(true);
    await until(() => answers(r.f).length === 2);
    await r.close();
    expect(answers(r.f)).toEqual([
      { id: 'patch', result: { decision: 'accept' } },
      { id: 'after-completion', result: { decision: 'decline' } },
    ]);
  });

  for (const decision of ['approve', 'decline'] as const) {
    test(`permissions ${decision} grants only the requested profile for the turn`, async () => {
      const r = await running([{ request: permissionRequest }]);
      await until(() => approvals(r.events).length === 1);
      const id = approvals(r.events)[0]!.approvalId;
      expect(r.events).toEqual([
        started,
        approval(id, 'other', 'Request permissions for this turn', {
          cwd: '/clone',
          reason: `need access\n${requested}`,
        }),
      ]);
      expect(await r.session.answerApproval(id, decision, null)).toBe(true);
      await until(() => answers(r.f).length === 1);
      await r.close();
      expect(answers(r.f)).toEqual([
        { id: 'permissions', result: { permissions: decision === 'approve' ? permissions : {}, scope: 'turn' } },
      ]);
    });
  }

  test('elicitations, user input and unknown requests are answered immediately without relay', async () => {
    const question = { id: 'q1', header: 'Choice', question: 'Which?', isOther: false, isSecret: false, options: null };
    const r = await running([
      {
        request: m.elicitationRequest({
          threadId: MAIN,
          turnId: TURN,
          serverName: 'agflow',
          message: 'ask',
          id: 'elicit',
        }),
      },
      {
        request: m.userInputRequest({
          threadId: MAIN,
          turnId: TURN,
          itemId: 'input',
          questions: [question, { ...question, id: 'q2' }],
          id: 'input',
        }),
      },
      { request: { method: 'unknown/request', params: {}, id: 'unknown' } as unknown as ScriptedServerRequest },
    ]);
    await until(() => answers(r.f).length === 3);
    await r.close();
    expect(r.events).toEqual([started]);
    expect(answers(r.f).sort((a, b) => String(a.id).localeCompare(String(b.id)))).toEqual([
      { id: 'elicit', result: { action: 'decline', content: null, _meta: null } },
      {
        id: 'input',
        result: {
          answers: {
            q1: { answers: ['no person is available; decide yourself or use declare_blocked'] },
            q2: { answers: ['no person is available; decide yourself or use declare_blocked'] },
          },
        },
      },
      { id: 'unknown', error: { code: -32601, message: 'unhandled server request: unknown/request' } },
    ]);
  });

  for (const [method, result] of [
    [commandMethod, { decision: 'decline' }],
    [fileMethod, { decision: 'decline' }],
    [permissionsMethod, { permissions: {}, scope: 'turn' }],
    ['mcpServer/elicitation/request', { action: 'decline', content: null, _meta: null }],
    ['item/tool/requestUserInput', { answers: {} }],
  ] as [CodexServerRequestMethod, unknown][]) {
    test(`malformed ${method} is declined with a warning`, async () => {
      const r = await running([{ request: { method, params: { threadId: MAIN }, id: 42 } as ScriptedServerRequest }]);
      await until(() => answers(r.f).length === 1);
      await r.close();
      expect(answers(r.f)).toEqual([{ id: 42, result }]);
      expect(r.events).toEqual([
        started,
        { type: 'warning', text: `codex approval: cannot parse ${method}; declined` },
      ]);
    });
  }

  test('withdrawal voids only the matching unanswered request and settles it with a harmless decline', async () => {
    const r = await running([], {
      answers: {
        'turn/start': { then: [{ request: command }] },
        'turn/interrupt': {
          then: [
            { notify: m.serverRequestResolved('another-thread', 'command') },
            // A marker between the withdrawals: only the second one may void the request.
            { notify: m.threadStatusChanged(MAIN, ['waitingOnApproval']) },
            { notify: m.serverRequestResolved(MAIN, 'command') },
            { notify: m.serverRequestResolved(MAIN, 'command') },
          ],
        },
      },
    });
    await until(() => approvals(r.events).length === 1);
    const id = approvals(r.events)[0]!.approvalId;
    await r.session.interrupt();
    await until(() => r.events.some((event) => event.type === 'approval_void'));
    expect(await r.session.answerApproval(id, 'approve', null)).toBe(false);
    await until(() => answers(r.f).length === 1);
    await r.close();
    expect(r.events).toEqual([
      started,
      approval(id, 'command', `Run command: ${commandDetail.command}`, commandDetail),
      { type: 'waiting_approval', waiting: true },
      { type: 'approval_void', approvalId: id },
    ]);
    expect(answers(r.f)).toEqual([{ id: 'command', result: { decision: 'decline' } }]);
  });

  for (const active of [true, false]) {
    test(`a decline reason is steered into the asking turn only, with active=${active}`, async () => {
      const reason = 'the owner did not answer; continue without it or declare_blocked';
      const r = await running([], {
        answers: {
          'turn/start': { then: [{ request: command }, ...(!active ? [{ notify: finish() }] : [])] },
          // A turn that has ended refuses the steer; the note is then dropped rather than starting a turn.
          'turn/steer': active
            ? { then: [{ notify: finish() }] }
            : { error: { code: -32600, message: 'no active turn to steer' } },
        },
      });
      await until(() => approvals(r.events).length === 1 && (active || r.session.activeTurnId === null));
      const id = approvals(r.events)[0]!.approvalId;
      expect(await r.session.answerApproval(id, 'decline', reason)).toBe(true);
      expect(await r.session.answerApproval(id, 'decline', reason)).toBe(false);
      await until(() => r.events.length === (active ? 3 : 4));
      await r.close();
      expect(answers(r.f)).toEqual([{ id: 'command', result: { decision: 'decline' } }]);
      expect(requests(r.f)).toEqual([
        { method: 'turn/start', params: { threadId: MAIN, input: firstInput(r.f.launch.firstPrompt) } },
        {
          method: 'turn/steer',
          params: {
            threadId: MAIN,
            expectedTurnId: probes.commandApprovalRequest.params.turnId,
            input: input(`System note: ${reason}`),
          },
        },
      ]);
      expect(r.events).toEqual([
        started,
        approval(id, 'command', `Run command: ${commandDetail.command}`, commandDetail),
        ended,
        ...(active
          ? []
          : [
              {
                type: 'warning' as const,
                text: 'codex approval note: codex turn/steer failed: no active turn to steer',
              },
            ]),
      ]);
    });
  }

  test("a child thread's decline reason goes to that thread's turn", async () => {
    const child = {
      ...command,
      params: { ...command.params, threadId: 'child', turnId: 'child-turn' },
    } as ScriptedServerRequest;
    const r = await running([{ request: child }]);
    await until(() => approvals(r.events).length === 1);
    expect(await r.session.answerApproval(approvals(r.events)[0]!.approvalId, 'decline', 'not now')).toBe(true);
    await until(() => requests(r.f).length === 2);
    await r.close();
    expect(requests(r.f)[1]).toEqual({
      method: 'turn/steer',
      params: { threadId: 'child', expectedTurnId: 'child-turn', input: input('System note: not now') },
    });
  });

  test('combines waiting flags across threads and relays child approvals in this session', async () => {
    const child = { ...command, params: { ...command.params, threadId: 'child' } } as ScriptedServerRequest;
    const r = await running([
      { notify: m.threadStatusChanged(MAIN, ['waitingOnApproval']) },
      { notify: m.threadStatusChanged('child', ['waitingOnApproval']) },
      { notify: m.threadStatusChanged(MAIN, 'idle') },
      {
        request: child,
        afterAnswer: [
          { notify: m.serverRequestResolved('child', 'command') },
          { notify: m.threadStatusChanged('child', ['waitingOnUserInput']) },
          { notify: m.threadStatusChanged('child', 'idle') },
        ],
      },
    ]);
    await until(() => approvals(r.events).length === 1);
    const id = approvals(r.events)[0]!.approvalId;
    expect(await r.session.answerApproval(id, 'approve', null)).toBe(true);
    await until(() => r.events.some((event) => event.type === 'waiting_approval' && !event.waiting));
    await r.close();
    expect(r.events).toEqual([
      started,
      { type: 'waiting_approval', waiting: true },
      approval(id, 'command', `Run command: ${commandDetail.command}`, commandDetail),
      { type: 'waiting_approval', waiting: false },
    ]);
    expect(answers(r.f)).toEqual([{ id: 'command', result: { decision: 'accept' } }]);
  });

  test('buffers requests before started alongside their preceding item notifications', async () => {
    const r = await running([], {
      answers: { 'thread/start': { then: [{ notify: m.itemStarted(MAIN, TURN, patch) }, { request: patchRequest }] } },
    });
    await until(() => approvals(r.events).length === 1);
    const id = approvals(r.events)[0]!.approvalId;
    expect(r.events).toEqual([
      started,
      {
        type: 'tool_started',
        toolId: 'patch',
        name: 'apply_patch',
        input: 'one.ts\n+one\ntwo.ts\n-two',
        command: null,
      },
      approval(id, 'file_change', 'Apply file changes', {
        diff: 'add one.ts\n+one\ndelete two.ts\n-two',
        reason: 'write files',
        grantRoot: '/extra',
      }),
    ]);
    expect(await r.session.answerApproval(id, 'approve', null)).toBe(true);
    await until(() => answers(r.f).length === 1);
    await r.close();
  });

  test('exit forgets pending requests without emitting void events', async () => {
    const r = await running([], {
      answers: { 'turn/start': { then: [{ request: command }] }, 'turn/interrupt': { then: [{ crash: { code: 0 } }] } },
    });
    await until(() => approvals(r.events).length === 1);
    const id = approvals(r.events)[0]!.approvalId;
    await r.session.interrupt();
    await r.session.exited;
    expect(await r.session.answerApproval(id, 'approve', null)).toBe(false);
    await r.close();
    expect(r.events).toEqual([
      started,
      approval(id, 'command', `Run command: ${commandDetail.command}`, commandDetail),
    ]);
    expect(answers(r.f)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `bun test packages/runner/test/codex/approvals.test.ts`
Expected: FAIL — `error: Cannot find module '../../src/adapters/codex/approvals' from 'packages/runner/test/codex/approvals.test.ts'` (0 pass, 1 fail, 1 error)

- [ ] **Step 3: Implement**

**File:** `packages/runner/src/adapters/codex/approvals.ts` (new)

```ts
// Approval display and answers (design 6.10, 9.3). No policy decisions or request identity live here.
import { z } from 'zod';
import type { AgentEvent } from '../types';
import type { CodexServerRequestMethod, ResultOf } from './methods';
import type { RequestPermissionProfile, ThreadItem } from './protocol/v2';

type Approval = Pick<Extract<AgentEvent, { type: 'approval_request' }>, 'kind' | 'summary' | 'detail'>;
export type ParsedApproval = Approval & {
  threadId: string;
  turnId: string;
  itemId: string;
  permissions?: RequestPermissionProfile;
};
export type FileChange = Extract<ThreadItem, { type: 'fileChange' }>;

/** The relayed event must stay far below the outbox's event limit, whatever the agent asks to run or write. */
const TEXT_MAX = 64 * 1024;
const SUMMARY_MAX = 500;

/** At most max UTF-8 bytes, cut on a character boundary, with the full size noted. */
export function clipText(text: string, max = TEXT_MAX): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= max) return text;
  let end = max;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return `${bytes.subarray(0, end).toString('utf8')}\n[truncated: ${bytes.length} bytes in total]`;
}

/** The owner's notification shows the summary: its first line, clipped, with an ellipsis when anything was cut. */
function summaryOf(text: string): string {
  const newline = text.indexOf('\n');
  const line = newline === -1 ? text : text.slice(0, newline);
  if (newline === -1 && line.length <= SUMMARY_MAX) return text;
  let end = Math.min(line.length, SUMMARY_MAX);
  // Keep a surrogate pair whole.
  if (end < line.length && /[\uD800-\uDBFF]/.test(line[end - 1]!)) end--;
  return `${line.slice(0, end)}…`;
}

/** Every path a change touches, so a move out of the clone shows its destination. */
function changeView(change: FileChange['changes'][number]): string {
  const { kind, path } = change;
  const head =
    kind.type === 'update' && kind.move_path !== null ? `move ${path} -> ${kind.move_path}` : `${kind.type} ${path}`;
  return `${head}\n${change.diff}`;
}

const identity = { threadId: z.string().min(1), turnId: z.string().min(1), itemId: z.string().min(1) };
const optionalText = z.string().nullish();
const commandParams = z.object({
  ...identity,
  kind: z.enum(['command', 'writeStdin']).default('command'),
  startedAtMs: z.number(),
  environmentId: z.string().nullable(),
  command: optionalText,
  cwd: optionalText,
  reason: optionalText,
});
const fileParams = z.object({ ...identity, startedAtMs: z.number(), reason: optionalText, grantRoot: optionalText });
const specialPath = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('root') }),
  z.strictObject({ kind: z.literal('minimal') }),
  z.strictObject({ kind: z.literal('project_roots'), subpath: z.string().nullable() }),
  z.strictObject({ kind: z.literal('tmpdir') }),
  z.strictObject({ kind: z.literal('slash_tmp') }),
  z.strictObject({ kind: z.literal('unknown'), path: z.string(), subpath: z.string().nullable() }),
]);
const fileSystemPath = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('path'), path: z.string() }),
  z.strictObject({ type: z.literal('glob_pattern'), pattern: z.string() }),
  z.strictObject({ type: z.literal('special'), value: specialPath }),
]);
// Unknown permission fields must fail closed, rather than disappear from the profile the owner sees and grants.
const permissionProfile = z.strictObject({
  network: z.strictObject({ enabled: z.boolean().nullable() }).nullable(),
  fileSystem: z
    .strictObject({
      read: z.array(z.string()).nullable(),
      write: z.array(z.string()).nullable(),
      globScanMaxDepth: z.number().int().nonnegative().optional(),
      entries: z.array(z.strictObject({ path: fileSystemPath, access: z.enum(['read', 'write', 'deny']) })).optional(),
    })
    .nullable(),
});
const permissionsParams = z.object({
  ...identity,
  startedAtMs: z.number(),
  environmentId: z.string().nullable(),
  cwd: z.string(),
  reason: z.string().nullable(),
  permissions: permissionProfile,
});
const userInputParams = z.object({
  ...identity,
  isBlocking: z.boolean(),
  autoResolutionMs: z.number().nullable(),
  questions: z.array(
    z.object({
      id: z.string(),
      header: z.string(),
      question: z.string(),
      isOther: z.boolean(),
      isSecret: z.boolean(),
      options: z.array(z.object({ label: z.string(), description: z.string() })).nullable(),
    }),
  ),
});
const elicitationParams = z
  .object({
    threadId: z.string().min(1),
    turnId: z.string().nullable(),
    serverName: z.string(),
    message: z.string(),
    mode: z.enum(['form', 'openai/form', 'openaiForm', 'url']),
  })
  .and(
    z.union([
      z.object({ mode: z.enum(['form', 'openai/form', 'openaiForm']), requestedSchema: z.json() }),
      z.object({ mode: z.literal('url'), url: z.string(), elicitationId: z.string() }),
    ]),
  );

export function approvalFromRequest(
  method: CodexServerRequestMethod,
  params: unknown,
  item?: FileChange,
): ParsedApproval | null {
  switch (method) {
    case 'item/commandExecution/requestApproval': {
      const parsed = commandParams.safeParse(params);
      if (!parsed.success) return null;
      const p = parsed.data;
      // For writeStdin, command holds the input bytes, not a shell command.
      const label = p.kind === 'writeStdin' ? 'Stdin input to running command' : 'Run command';
      const display = p.command == null ? label : `${label}: ${p.command}`;
      return {
        threadId: p.threadId,
        turnId: p.turnId,
        itemId: p.itemId,
        kind: 'command',
        summary: summaryOf(display),
        detail: {
          ...(p.command == null ? {} : { command: clipText(p.kind === 'writeStdin' ? display : p.command) }),
          ...(p.cwd == null ? {} : { cwd: clipText(p.cwd) }),
          ...(p.reason == null ? {} : { reason: clipText(p.reason) }),
        },
      };
    }
    case 'item/fileChange/requestApproval': {
      const parsed = fileParams.safeParse(params);
      if (!parsed.success) return null;
      const p = parsed.data;
      const known = item?.id === p.itemId;
      // The owner must never approve an empty view.
      const reason = [p.reason, known ? null : 'the changed files are unknown: no file-change item was seen']
        .filter((line) => line != null)
        .join('\n');
      return {
        threadId: p.threadId,
        turnId: p.turnId,
        itemId: p.itemId,
        kind: 'file_change',
        summary: 'Apply file changes',
        detail: {
          ...(known ? { diff: clipText(item.changes.map(changeView).join('\n')) } : {}),
          ...(reason === '' ? {} : { reason: clipText(reason) }),
          ...(p.grantRoot == null ? {} : { grantRoot: clipText(p.grantRoot) }),
        },
      };
    }
    case 'item/permissions/requestApproval': {
      const parsed = permissionsParams.safeParse(params);
      if (!parsed.success) return null;
      const p = parsed.data;
      const requested = `Permissions: ${JSON.stringify(p.permissions)}`;
      return {
        threadId: p.threadId,
        turnId: p.turnId,
        itemId: p.itemId,
        kind: 'other',
        summary: 'Request permissions for this turn',
        detail: { cwd: clipText(p.cwd), reason: clipText(p.reason === null ? requested : `${p.reason}\n${requested}`) },
        permissions: p.permissions,
      };
    }
    default:
      return null;
  }
}

export function decisionResponse<M extends CodexServerRequestMethod>(
  method: M,
  decision: 'approve' | 'decline',
  permissions?: RequestPermissionProfile,
): ResultOf<M> {
  let response: ResultOf<CodexServerRequestMethod>;
  switch (method) {
    case 'item/permissions/requestApproval':
      response = {
        permissions:
          decision === 'approve'
            ? {
                ...(permissions?.network == null ? {} : { network: permissions.network }),
                ...(permissions?.fileSystem == null ? {} : { fileSystem: permissions.fileSystem }),
              }
            : {},
        scope: 'turn',
      };
      break;
    case 'mcpServer/elicitation/request':
      response = { action: 'decline', content: null, _meta: null };
      break;
    case 'item/tool/requestUserInput':
      response = { answers: {} };
      break;
    default:
      response = { decision: decision === 'approve' ? 'accept' : 'decline' };
  }
  return response as ResultOf<M>;
}

/** These requests never go to the owner. Null means malformed, so the caller warns and uses the decline shape. */
export function unattendedResponse<M extends 'item/tool/requestUserInput' | 'mcpServer/elicitation/request'>(
  method: M,
  params: unknown,
): ResultOf<M> | null {
  if (method === 'mcpServer/elicitation/request') {
    return elicitationParams.safeParse(params).success ? decisionResponse(method, 'decline') : null;
  }
  const parsed = userInputParams.safeParse(params);
  if (!parsed.success) return null;
  // The generated response allows free text for every question, even when the prompt offers fixed options.
  return {
    answers: Object.fromEntries(
      parsed.data.questions.map((question) => [
        question.id,
        { answers: ['no person is available; decide yourself or use declare_blocked'] },
      ]),
    ),
  } as ResultOf<M>;
}
```

**File:** `packages/runner/src/adapters/codex/session.ts` (change)

```diff
diff --git a/packages/runner/src/adapters/codex/session.ts b/packages/runner/src/adapters/codex/session.ts
index d7936cc2..75398ccc 100644
--- a/packages/runner/src/adapters/codex/session.ts
+++ b/packages/runner/src/adapters/codex/session.ts
@@ -1,5 +1,6 @@
 // Thread startup, resume, fail-closed checks and app-server events (design 9.2, 7.4).
 import { TEST_ACCOUNT_ID } from '@agflow/core';
+import { randomUUID } from 'node:crypto';
 import { realpathSync } from 'node:fs';
 import { join } from 'node:path';
 import type { RunnerTestBlock } from '../../config';
@@ -7,13 +8,20 @@ import type { Logger } from '../../log';
 import { boundedWait } from '../../processes';
 import { vendorBinary } from '../../vendor/pins';
 import type { AgentEvent, AgentLaunch, AgentSession, ExitInfo } from '../types';
+import { approvalFromRequest, decisionResponse, unattendedResponse, type FileChange } from './approvals';
 import { isFinalError, mergeRateLimits, quotaFromRateLimits, turnErrorKind } from './classify';
 import { appServerArgs, appServerEnv, threadOverrides } from './config';
 import { codexToolEnded, codexToolStarted } from './items';
-import type { CodexClientMethod, ParamsOf, ResultOf } from './methods';
+import {
+  CodexServerRequestMethods,
+  type CodexClientMethod,
+  type CodexServerRequestMethod,
+  type ParamsOf,
+  type ResultOf,
+} from './methods';
 import { codexAccountIdentity } from './policy';
 import { openAppServer, type AppServerProcess } from './process';
-import type { ServerNotification } from './protocol';
+import type { RequestId, ServerNotification } from './protocol';
 import type { RateLimitSnapshot, Turn, TurnError } from './protocol/v2';
 import { RpcError } from './rpc';
 
@@ -42,7 +50,14 @@ interface OpenTool {
   mainTurn: string | null;
 }
 
-export class CodexSession {
+interface PendingApproval {
+  requestId: RequestId;
+  threadId: string;
+  turnId: string;
+  answer(decision: 'approve' | 'decline'): void;
+}
+
+export class CodexSession implements AgentSession {
   readonly pid: number;
   readonly events: AsyncIterable<AgentEvent>;
   readonly exited: Promise<ExitInfo>;
@@ -73,6 +88,9 @@ export class CodexSession {
   private readonly acknowledgements = new Map<string, string[]>();
   private sending = false;
   private readonly completions: Turn[] = [];
+  private readonly approvals = new Map<string, PendingApproval>();
+  private readonly fileChanges = new Map<string, FileChange>();
+  private readonly waitingThreads = new Set<string>();
 
   private constructor(
     private readonly app: AppServerProcess,
@@ -85,6 +103,7 @@ export class CodexSession {
     this.exited = app.exited;
     void this.exited.then(async () => {
       this.closed = true;
+      this.forgetApprovals();
       this.held?.release();
       // An escaped child can hold stdout open after the leader exits.
       await boundedWait(app.rpc.ended, 1000);
@@ -119,10 +138,20 @@ export class CodexSession {
       requestTimeoutMs: options.requestTimeoutMs,
     });
     let session: CodexSession | null = null;
-    const pending: ServerNotification[] = [];
+    const pending: ((session: CodexSession | null) => void)[] = [];
+    for (const method of CodexServerRequestMethods) {
+      app.rpc.handle(method, (params, id) => {
+        if (session) return session.serverRequest(method, params, id);
+        return new Promise<ResultOf<typeof method>>((resolve) => {
+          pending.push((ready) =>
+            resolve(ready ? ready.serverRequest(method, params, id) : decisionResponse(method, 'decline')),
+          );
+        });
+      });
+    }
     const unsubscribeNotifications = app.rpc.onNotification((notification) => {
       if (session) session.notification(notification);
-      else pending.push(notification);
+      else pending.push((ready) => ready?.notification(notification));
     });
     let warning: string | null = null;
     const unsubscribeWarning = app.rpc.on('configWarning', ({ summary }) => {
@@ -178,7 +207,7 @@ export class CodexSession {
       if (tools.length > 0) {
         session.queue.push({ type: 'warning', text: `codex thread lists extra agflow tools: ${tools.join(', ')}` });
       }
-      for (const notification of pending) session.notification(notification);
+      for (const deliver of pending) deliver(session);
       pending.length = 0;
       if (!resumed) {
         // Both start and resume carry the tools note in developerInstructions.
@@ -187,6 +216,7 @@ export class CodexSession {
       return session;
     } catch (error) {
       unsubscribeNotifications();
+      for (const deliver of pending.splice(0)) deliver(null);
       await app.end();
       throw new Error(oneLine(warning ?? error));
     } finally {
@@ -202,6 +232,31 @@ export class CodexSession {
     await sent;
   }
 
+  async answerApproval(approvalId: string, decision: 'approve' | 'decline', reason: string | null): Promise<boolean> {
+    if (this.closed || this.app.rpc.closed) return false;
+    const pending = this.approvals.get(approvalId);
+    if (!pending) return false;
+    this.approvals.delete(approvalId);
+    pending.answer(decision);
+    if (decision === 'decline' && reason !== null) {
+      // The reason goes to the turn that asked, a child thread's too; once that turn has ended it is dropped, since a
+      // new turn would be work nobody asked for (design 9.3).
+      const { threadId, turnId } = pending;
+      const note = this.sends.then(() =>
+        request(this.app, 'turn/steer', {
+          threadId,
+          expectedTurnId: turnId,
+          input: [{ type: 'text', text: `System note: ${reason}`, text_elements: [] }],
+        }),
+      );
+      this.sends = note.then(
+        () => {},
+        (error) => this.warn('approval note', oneLine(error)),
+      );
+    }
+    return true;
+  }
+
   async interrupt(options: { cancelQueued?: boolean } = {}): Promise<void> {
     if (options.cancelQueued) {
       this.sendGeneration += 1;
@@ -218,6 +273,7 @@ export class CodexSession {
     this.closed = true;
     this.held?.release();
     await this.app.end();
+    this.forgetApprovals();
   }
 
   private checkSend(generation = this.sendGeneration): void {
@@ -304,6 +360,49 @@ export class CodexSession {
     this.queue.push({ type: 'delivered', id: message.id });
   }
 
+  private serverRequest<M extends CodexServerRequestMethod>(
+    method: M,
+    params: unknown,
+    id: RequestId,
+  ): Promise<ResultOf<M>> | ResultOf<M> {
+    if (this.closed || this.app.rpc.closed) return decisionResponse(method, 'decline');
+    if (method === 'item/tool/requestUserInput' || method === 'mcpServer/elicitation/request') {
+      const response = unattendedResponse(method, params);
+      if (response) return response as ResultOf<M>;
+    } else {
+      let parsed = approvalFromRequest(method, params);
+      if (parsed) {
+        if (method === 'item/fileChange/requestApproval') {
+          parsed = approvalFromRequest(
+            method,
+            params,
+            this.fileChanges.get(JSON.stringify([parsed.threadId, parsed.itemId])),
+          )!;
+        }
+        const approvalId = randomUUID();
+        const { kind, summary, detail, threadId, turnId, permissions } = parsed;
+        return new Promise((resolve) => {
+          this.approvals.set(approvalId, {
+            requestId: id,
+            threadId,
+            turnId,
+            answer: (decision) => resolve(decisionResponse(method, decision, permissions)),
+          });
+          this.queue.push({ type: 'approval_request', approvalId, kind, summary, detail });
+        });
+      }
+    }
+    this.warn('approval', `cannot parse ${method}; declined`);
+    return decisionResponse(method, 'decline');
+  }
+
+  private forgetApprovals(): void {
+    for (const pending of this.approvals.values()) pending.answer('decline');
+    this.approvals.clear();
+    this.fileChanges.clear();
+    this.waitingThreads.clear();
+  }
+
   private async hold(turnId: string | null): Promise<void> {
     await new Promise<void>((release) => {
       this.held = { turnId, release };
@@ -313,6 +412,28 @@ export class CodexSession {
 
   private notification(notification: ServerNotification): void {
     switch (notification.method) {
+      case 'serverRequest/resolved': {
+        const { threadId, requestId } = notification.params;
+        for (const [approvalId, pending] of this.approvals) {
+          if (pending.requestId !== requestId || pending.threadId !== threadId) continue;
+          this.approvals.delete(approvalId);
+          this.queue.push({ type: 'approval_void', approvalId });
+          // RPC requires each handler to settle; a late decline cannot grant a withdrawn request.
+          pending.answer('decline');
+          break;
+        }
+        return;
+      }
+      case 'thread/status/changed': {
+        const { threadId, status } = notification.params;
+        const wasWaiting = this.waitingThreads.size > 0;
+        if (status.type === 'active' && status.activeFlags.includes('waitingOnApproval'))
+          this.waitingThreads.add(threadId);
+        else this.waitingThreads.delete(threadId);
+        const waiting = this.waitingThreads.size > 0;
+        if (waiting !== wasWaiting) this.queue.push({ type: 'waiting_approval', waiting });
+        return;
+      }
       case 'turn/started': {
         const { threadId, turn } = notification.params;
         if (threadId !== this.sessionRef) return;
@@ -357,6 +478,11 @@ export class CodexSession {
       case 'item/started':
       case 'item/completed': {
         const { item, threadId, turnId } = notification.params;
+        if (item.type === 'fileChange') {
+          const key = JSON.stringify([threadId, item.id]);
+          if (notification.method === 'item/started') this.fileChanges.set(key, item);
+          else this.fileChanges.delete(key);
+        }
         const start = codexToolStarted(item);
         if (start) {
           const key = JSON.stringify([threadId, turnId, item.id]);
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `bun test packages/runner/test/codex/approvals.test.ts && bun test && bun run typecheck`
Expected: the task's tests pass (23 pass); then the whole suite passes (`0 fail`) and `tsc` exits 0.

`approve` sends exactly `{ decision: 'accept' }`, even when `availableDecisions` offers `acceptForSession` or an exec-policy amendment. Params are parsed with zod; a permission profile with unknown fields is declined with a warning. The note goes as `turn/steer` into the request's own thread and turn, on the send chain; if that turn has ended, it is dropped with a warning, never sent as a new turn. Details are clipped by `clipText` to 64 KiB of UTF-8 with a '[truncated: N bytes in total]' marker, and summaries to one line of 500 characters. Requests that arrive before `started` are buffered with the notifications and declined if the start fails. `CodexSession` now declares `implements AgentSession`.

- [ ] **Step 5: Commit**

```bash
git add -A 'packages/runner/src/adapters/codex/approvals.ts' 'packages/runner/src/adapters/codex/session.ts' 'packages/runner/test/codex/approvals.test.ts'
git commit -m 'M2E Task 17: Approval requests in the adapter' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

### Task 18: Manifest diffs for package-manager approvals

Design 6.10, What the owner sees: an approval for a package-manager command shows the diff of the dependency manifests against the attempt's start commit. M2b's controller calls the adapter's optional `enrichApproval` before it relays a request (X-9), and `codexEnrichApproval` adds `manifestDiff` to a command's detail. Base content is read from the runner's vault with M2b's `runGit` and `localGitEnv` (X-7); current content is read as plain files that are never followed through links, and the diff is computed in process with the `diff` package (X-44), so no git ever runs with the clone's `.git` (design 7.3).

**Files:**
- Create: `packages/runner/src/adapters/codex/manifest-diff.ts`
- Test: `packages/runner/test/codex/manifest-diff.test.ts`

- [ ] **Step 1: Write the failing test**

**File:** `packages/runner/test/codex/manifest-diff.test.ts` (new)

```ts
import { afterEach, describe, expect, test } from 'bun:test';
import { commitFiles, gitIn, originRepo } from '@agflow/testkit';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { codexEnrichApproval, isPackageManagerCommand, manifestDiff } from '../../src/adapters/codex/manifest-diff';
import { ensureRunnerGitFiles, localGitEnv } from '../../src/git/run';
import type { VendorAdapter } from '../../src/adapters/types';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function write(root: string, files: Record<string, string | Uint8Array>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

async function fixture(files: Record<string, string> = {}) {
  const origin = await originRepo(files);
  dirs.push(origin.root);
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agflow-manifests-')));
  dirs.push(root);
  const clone = join(root, 'clone');
  mkdirSync(clone);
  write(clone, files);
  const paths = { gitConfig: join(root, 'git/local.gitconfig'), gitExcludes: join(root, 'git/excludes') };
  ensureRunnerGitFiles(paths);
  return { root, clone, vault: origin.path, startSha: origin.mainSha, local: localGitEnv(paths) };
}

function patch(path: string, before: string, after: string): string {
  return `===================================================================\n--- a/${path}\n+++ b/${path}\n@@ -${before ? '1,1' : '0,0'} +${after ? '1,1' : '0,0'} @@\n${before ? `-${before}\n` : ''}${after ? `+${after}\n` : ''}`;
}

describe('isPackageManagerCommand', () => {
  for (const command of [
    'npm install',
    'npm i',
    'npm ci',
    'npm add thing',
    'bun add thing',
    'bun install',
    'bun i',
    'pnpm add thing',
    'pnpm install',
    'pnpm i',
    'yarn',
    'yarn add thing',
    'yarn install',
    'pip install -r requirements.txt',
    'pip3 install thing',
    'uv pip install thing',
    'uv add thing',
    'poetry add thing',
    'poetry install',
    'cargo add thing',
    'go get example.org/pkg',
    'cd x && npm install',
    'echo ready; bun add thing',
    'npm test && pnpm i; echo done',
    'VAR=value OTHER="two words" npm ci',
    'cd x && VAR=value bun install',
    "/bin/zsh -c 'cd x && npm install'",
    'bash -lc "VAR=value bun add thing"',
    "/bin/zsh -c 'echo '\\''ready'\\''; pnpm i'",
    '/usr/bin/npm install',
    // Options before the subcommand, with their values.
    'npm --prefix web install',
    'pnpm -C web install',
    'yarn --cwd web add x',
    'bun --cwd web install',
    'npm --prefix=web ci',
    'yarn --frozen-lockfile',
    // Updates, rebuilds and npm's aliases.
    'npm update',
    'npm rebuild',
    'pnpm up',
    'yarn upgrade',
    'bun update',
    'npm clean-install',
    'npm install-test',
    'npm it',
    'npm isntall thing',
    'uv sync',
    'uv pip sync requirements.txt',
    'python3 -m pip install -r requirements.txt',
    'python -m pip3 install thing',
    'pip3.12 install thing',
    // Wrappers, subshells and groups.
    'env CI=1 npm install',
    'env -i PATH=/bin npm install',
    'time npm ci',
    'command npm i',
    'nohup bun install',
    'exec pnpm install',
    '(cd web && npm install)',
    '{ cd web; npm install; }',
  ]) {
    test(command, () => expect(isPackageManagerCommand(command)).toBe(true));
  }
  for (const command of [
    '',
    'npm test',
    'npm run install',
    'bun run build',
    'bun test',
    'git commit',
    'notnpm install',
    'echo npm install',
    'echo "npm install; bun add x"',
    'yarn test',
    'pip uninstall thing',
    'cargo build',
    'go test',
    'uv pip list',
    'echo /bin/zsh -c "npm install"',
    "/bin/zsh -c 'npm test'",
    'VALUE="npm install" echo done',
    'npm --prefix web test',
    'command -v npm',
    'python3 -m pytest',
    'python3 -m pip list',
    'uv run pytest',
    'echo ${npm} install',
    '(echo npm install)',
  ]) {
    test(command || 'empty', () => expect(isPackageManagerCommand(command)).toBe(false));
  }
});

describe('manifestDiff', () => {
  test('diffs root and cwd manifests against startSha, even after the vault main advances', async () => {
    const input = await fixture({ 'package.json': 'root before\n', 'app/package.json': 'app before\n' });
    await commitFiles(input.vault, { branch: 'main', files: { 'package.json': 'new main\n' } });
    write(input.clone, {
      'package.json': 'root after\n',
      '.npmrc': 'registry=root\n',
      'app/package.json': 'app after\n',
      'app/.npmrc': 'registry=app\n',
      'unrelated/package.json': 'not included\n',
    });
    const expected =
      patch('package.json', 'root before', 'root after') +
      patch('.npmrc', '', 'registry=root') +
      patch('app/package.json', 'app before', 'app after') +
      patch('app/.npmrc', '', 'registry=app');
    expect(await manifestDiff({ ...input, cwd: join(input.clone, 'app') })).toBe(expected);
    expect(await manifestDiff({ ...input, cwd: 'app' })).toBe(expected);
  });

  test('unchanged files and missing manifests return null; a removed manifest has a unified diff', async () => {
    const input = await fixture({ 'package.json': '{}\n', 'yarn.lock': 'lock\n' });
    expect(await manifestDiff(input)).toBeNull();
    rmSync(join(input.clone, 'yarn.lock'));
    expect(await manifestDiff(input)).toBe(patch('yarn.lock', 'lock', ''));
  });

  test('covers every manifest of the recognised managers, and every .yarnrc* name', async () => {
    const input = await fixture();
    const names = [
      'package.json',
      'package-lock.json',
      'npm-shrinkwrap.json',
      'yarn.lock',
      'pnpm-lock.yaml',
      'bun.lock',
      '.npmrc',
      '.yarnrc',
      '.yarnrc.extra',
      '.yarnrc.yaml',
      '.yarnrc.yml',
      'bunfig.toml',
      'pyproject.toml',
      'requirements.txt',
      'poetry.lock',
      'uv.lock',
      'Pipfile',
      'Pipfile.lock',
      'Cargo.toml',
      'Cargo.lock',
      'go.mod',
      'go.sum',
    ];
    write(input.clone, Object.fromEntries([...names, 'Gemfile', 'yarnrc'].map((name) => [name, 'new\n'])));
    expect(await manifestDiff(input)).toBe(names.map((name) => patch(name, '', 'new')).join(''));
  });

  test('finds .yarnrc* names in the start commit and the clone, case-insensitively, in the root and cwd', async () => {
    const input = await fixture({ '.yarnrc.ci.yml': 'base\n', 'app/.YARNRC.local': 'app base\n' });
    rmSync(join(input.clone, 'app/.YARNRC.local'));
    write(input.clone, { '.yarnrc.ci.yml': 'agent\n', 'app/.Yarnrc.yml': 'new\n' });
    expect(await manifestDiff({ ...input, cwd: 'app' })).toBe(
      patch('.yarnrc.ci.yml', 'base', 'agent') +
        patch('app/.YARNRC.local', 'app base', '') +
        patch('app/.Yarnrc.yml', '', 'new'),
    );
  });

  test("adds a pip command's requirement files inside the clone, relative to its cwd", async () => {
    const input = await fixture({ 'app/reqs/dev.txt': 'one\n' });
    write(input.clone, { 'app/reqs/dev.txt': 'two\n', 'app/constraints.txt': 'pinned\n' });
    write(input.root, { 'outside.txt': 'secret\n' });
    const request: Parameters<NonNullable<VendorAdapter['enrichApproval']>>[0]['request'] = {
      kind: 'command',
      summary: 'install',
      detail: {
        command: `python3 -m pip install -r reqs/dev.txt --constraint=constraints.txt -r ../../outside.txt -r ${join(input.root, 'outside.txt')}`,
        cwd: 'app',
      },
    };
    expect((await codexEnrichApproval({ ...input, request }, input.local)).manifestDiff).toBe(
      patch('app/reqs/dev.txt', 'one', 'two') + patch('app/constraints.txt', '', 'pinned'),
    );
  });

  test('ignores outside, traversing, sibling-prefix and symlinked cwd directories', async () => {
    const input = await fixture({ 'package.json': '{}\n' });
    write(input.root, { 'outside/package.json': 'outside secret\n', 'clone-sibling/package.json': 'sibling secret\n' });
    symlinkSync(join(input.root, 'outside'), join(input.clone, 'linked'));
    for (const cwd of [join(input.root, 'outside'), '../outside', '../clone-sibling', 'linked', 'linked/../linked']) {
      expect(await manifestDiff({ ...input, cwd })).toBeNull();
    }
  });

  test('does not normalize away a symlink before checking cwd traversal', async () => {
    const input = await fixture({ 'app/package.json': 'before\n' });
    write(input.clone, { 'app/package.json': 'after\n' });
    write(input.root, { 'outside/child/keep': '', 'outside/app/package.json': 'secret\n' });
    symlinkSync(join(input.root, 'outside/child'), join(input.clone, 'linked'));
    expect(await manifestDiff({ ...input, cwd: 'linked/../app' })).toBeNull();
  });

  test('reports symlinks without following them, directories and FIFOs without blocking', async () => {
    const input = await fixture();
    const outside = join(input.root, 'secret');
    writeFileSync(outside, 'outside secret content');
    symlinkSync(outside, join(input.clone, 'package.json'));
    mkdirSync(join(input.clone, '.npmrc'));
    const proc = Bun.spawn(['mkfifo', join(input.clone, 'yarn.lock')]);
    expect(await proc.exited).toBe(0);
    const text = await manifestDiff(input);
    expect(text).toContain(`package.json: absent -> symlink -> ${JSON.stringify(outside)}\n`);
    expect(text).toContain('.npmrc: absent -> directory\n');
    expect(text).toContain('yarn.lock: absent -> non-regular file\n');
    expect(text).not.toContain('outside secret content');
  });

  test('summarises oversized base and current files with their sizes', async () => {
    const input = await fixture({ 'package.json': 'x'.repeat(256 * 1024 + 1), 'yarn.lock': 'old\n' });
    write(input.clone, { 'package.json': '{}\n', 'yarn.lock': 'y'.repeat(256 * 1024 + 2) });
    expect(await manifestDiff(input)).toBe(
      'package.json: size limit (262144 bytes); base 262145 bytes, current 3 bytes\n' +
        'yarn.lock: size limit (262144 bytes); base 4 bytes, current 262146 bytes\n',
    );
  });

  test('skips an unchanged oversized lockfile and an unchanged committed symlink', async () => {
    const big = 'z'.repeat(2 * 1024 * 1024 + 7);
    const input = await fixture({ 'package-lock.json': big });
    // A start commit whose .npmrc is a symlink, and a clone holding the same link.
    const work = join(input.root, 'work');
    await gitIn(input.root, ['clone', '--quiet', input.vault, work]);
    symlinkSync('shared/npmrc', join(work, '.npmrc'));
    await gitIn(work, ['add', '.npmrc']);
    await gitIn(work, ['commit', '--quiet', '-m', 'link .npmrc']);
    await gitIn(work, ['push', '--quiet', 'origin', 'main']);
    input.startSha = await gitIn(work, ['rev-parse', 'HEAD']);
    symlinkSync('shared/npmrc', join(input.clone, '.npmrc'));
    expect(await manifestDiff(input)).toBeNull();
    write(input.clone, { 'package-lock.json': `${big.slice(1)}y` });
    expect(await manifestDiff(input)).toBe(
      `package-lock.json: size limit (262144 bytes); base ${big.length} bytes, current ${big.length} bytes\n`,
    );
  });

  test('summarises binary files, including bun.lockb without NULs, and skips unchanged binaries', async () => {
    const input = await fixture({ 'bun.lockb': 'before', 'package-lock.json': 'a\0b' });
    expect(await manifestDiff(input)).toBeNull();
    write(input.clone, { 'bun.lockb': 'after', 'package-lock.json': new Uint8Array([97, 0, 99]) });
    expect(await manifestDiff(input)).toBe(
      'package-lock.json: binary; base 3 bytes, current 3 bytes\n' +
        'bun.lockb: binary; base 6 bytes, current 5 bytes\n',
    );
  });

  test('bounds diff computation for manifests with many changed lines', async () => {
    const input = await fixture({ 'package.json': 'before\n'.repeat(5000) });
    write(input.clone, { 'package.json': 'after\n'.repeat(5000) });
    expect(await manifestDiff(input)).toBe(
      'package.json: diff computation limit; base 35000 bytes, current 30000 bytes\n',
    );
  });

  test('caps total UTF-8 output and marks the cut', async () => {
    const input = await fixture();
    write(input.clone, { 'package.json': '😀'.repeat(30_000) + '\n', '.npmrc': 'registry=last\n' });
    const text = (await manifestDiff(input))!;
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(64 * 1024);
    expect(text.endsWith('\n[manifest diff truncated]\n')).toBe(true);
    expect(text).not.toContain('\ufffd');
    expect(text).not.toContain('registry=last');
  });

  test('never runs textconv or external diff drivers from the clone', async () => {
    const input = await fixture({ 'package.json': 'before\n' });
    await gitIn(input.clone, ['init', '--quiet']);
    const textconv = join(input.root, 'textconv-ran');
    const external = join(input.root, 'external-ran');
    write(input.clone, {
      '.git/config': `[core]\nrepositoryformatversion = 0\nbare = false\n[diff "x"]\ntextconv = touch ${textconv}\n[diff]\nexternal = touch ${external}\n`,
      '.gitattributes': 'package.json diff=x\n',
      'package.json': 'after\n',
    });
    expect(await manifestDiff(input)).toBe(patch('package.json', 'before', 'after'));
    expect(existsSync(textconv)).toBe(false);
    expect(existsSync(external)).toBe(false);
  });

  test('propagates an invalid start commit and unavailable vault instead of treating them as absent', async () => {
    const input = await fixture();
    await expect(manifestDiff({ ...input, startSha: '0'.repeat(40) })).rejects.toThrow();
    await expect(manifestDiff({ ...input, vault: join(input.root, 'missing.git') })).rejects.toThrow();
  });
});

describe('codexEnrichApproval', () => {
  test('adds the manifest diff only for changed package-manager command requests, preserving other detail', async () => {
    const input = await fixture({ 'app/package.json': 'before\n' });
    const detail = { command: "/bin/zsh -c 'npm install'", cwd: 'app', reason: 'network', diff: 'original' };
    const request: Parameters<NonNullable<VendorAdapter['enrichApproval']>>[0]['request'] = {
      kind: 'command',
      summary: 'install',
      detail,
    };
    expect(await codexEnrichApproval({ ...input, request }, input.local)).toBe(detail);
    write(input.clone, { 'app/package.json': 'after\n' });
    expect(await codexEnrichApproval({ ...input, request }, input.local)).toEqual({
      ...detail,
      manifestDiff: patch('app/package.json', 'before', 'after'),
    });
    expect(detail).not.toHaveProperty('manifestDiff');
    for (const other of [
      { ...request, kind: 'file_change' as const },
      { ...request, kind: 'other' as const },
      { ...request, detail: { ...detail, command: 'npm test', manifestDiff: 'existing' } },
      { ...request, detail: {} },
    ]) {
      expect(await codexEnrichApproval({ ...input, request: other }, input.local)).toBe(other.detail);
    }
  });
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `bun test packages/runner/test/codex/manifest-diff.test.ts`
Expected: FAIL — `error: Cannot find module '../../src/adapters/codex/manifest-diff' from 'packages/runner/test/codex/manifest-diff.test.ts'` (0 pass, 1 fail, 1 error)

- [ ] **Step 3: Implement**

**File:** `packages/runner/src/adapters/codex/manifest-diff.ts` (new)

```ts
// Approval context comes from the vault and plain files, never the agent's git configuration (design 6.10, 7.3).
import { matchesProtectedPattern, type Approval } from '@agflow/core';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, readlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { type GitEnvironment, runGit } from '../../git/run';
import type { VendorAdapter } from '../types';

// The design's list, with .yarnrc* found per directory, then the manifests and lockfiles of the other managers that
// isPackageManagerCommand recognises: a missing diff must never read as "unchanged".
const MANIFESTS = [
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
  '.npmrc',
  '.yarnrc*',
  'bunfig.toml',
  'pyproject.toml',
  'requirements.txt',
  'poetry.lock',
  'uv.lock',
  'Pipfile',
  'Pipfile.lock',
  'Cargo.toml',
  'Cargo.lock',
  'go.mod',
  'go.sum',
];
/** Yarn reads any rc file YARN_RC_FILENAME names, so every name core's .yarnrc* pattern covers is listed. */
const YARNRC = '.yarnrc*';
/** Files a pip command names with -r or -c, beyond the fixed list. */
const EXTRA_MAX = 16;
const FILE_MAX = 256 * 1024;
/** Larger lockfiles are common; they are still hashed, so an unchanged one is not reported. */
const HASH_MAX = 64 * 1024 * 1024;
const HASH_CHUNK = 1024 * 1024;
const TEXT_MAX = 64 * 1024;
const TRUNCATED = '\n[manifest diff truncated]\n';

const NPM_INSTALL = [
  'install',
  'i',
  'in',
  'ins',
  'inst',
  'insta',
  'instal',
  'isnt',
  'isnta',
  'isntal',
  'isntall',
  'add',
  'ci',
  'clean-install',
  'ic',
  'install-clean',
  'isntall-clean',
  'install-test',
  'it',
  'install-ci-test',
  'cit',
  'update',
  'up',
  'upgrade',
  'udpate',
  'rebuild',
  'rb',
];
const INSTALL_COMMANDS: Record<string, readonly string[]> = {
  npm: NPM_INSTALL,
  bun: ['add', 'install', 'i', 'update'],
  pnpm: ['add', 'install', 'i', 'update', 'up', 'upgrade', 'rebuild', 'rb'],
  yarn: ['add', 'install', 'upgrade', 'up', 'upgrade-interactive'],
  pip: ['install'],
  uv: ['add', 'sync'],
  poetry: ['add', 'install', 'update'],
  cargo: ['add', 'update'],
  go: ['get'],
};
/** Words that run the command after them. */
const WRAPPERS = new Set(['env', 'command', 'time', 'nohup', 'exec']);
/** Options before a subcommand that take the next word as their value. */
const OPTION_VALUES = new Set(['--prefix', '-C', '--dir', '--cwd', '--filter', '-F', '--workspace']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);

/** Shell words and chains, without evaluating expansions or mistaking quoted command text for a command. */
function commandSegments(command: string): string[][] {
  const segments: string[][] = [];
  let words: string[] = [];
  let word = '';
  let started = false;
  let quote = '';
  const endWord = () => {
    if (started) words.push(word);
    word = '';
    started = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length) segments.push(words);
    words = [];
  };
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if (char === '\\' && quote !== "'") {
      const next = command[i + 1];
      if (next !== undefined && (quote === '' || ['$', '`', '"', '\\', '\n'].includes(next))) {
        if (next !== '\n') word += next;
        started = true;
        i++;
        continue;
      }
    }
    if (quote !== '') {
      if (char === quote) quote = '';
      else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (';&|\n()'.includes(char) || ('{}'.includes(char) && !started)) {
      // Subshells and groups start commands of their own; a brace inside a word, as in ${HOME}, does not.
      endSegment();
    } else if (/\s/.test(char)) {
      endWord();
    } else if (char === '#' && !started) {
      while (i < command.length && command[i] !== '\n') i++;
      i--;
    } else {
      word += char;
      started = true;
    }
  }
  endSegment();
  return segments;
}

/** The files a pip command reads requirements or constraints from. */
function requirementFiles(args: string[]): string[] {
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const flag = ['-r', '--requirement', '-c', '--constraint'].find(
      (name) => arg === name || arg.startsWith(name.startsWith('--') ? `${name}=` : name),
    );
    if (flag === undefined) continue;
    const value = arg === flag ? args[++i] : arg.slice(flag.length).replace(/^=/, '');
    if (value) files.push(value);
  }
  return files;
}

/**
 * Null for a command that installs nothing; otherwise the requirement files it names. A display heuristic, not a shell
 * interpreter or an approval policy.
 */
function packageManagerFiles(command: string): string[] | null {
  let found = false;
  const files: string[] = [];
  const visit = (text: string, depth: number): void => {
    if (depth > 8) return;
    for (const words of commandSegments(text)) {
      let index = 0;
      for (;;) {
        while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] ?? '')) index++;
        if (!WRAPPERS.has(basename(words[index] ?? ''))) break;
        index++;
        while ((words[index] ?? '').startsWith('-')) index++;
      }
      let program = basename(words[index] ?? '');
      let args = words.slice(index + 1);
      if (SHELLS.has(program)) {
        const flag = args.findIndex((arg) => /^-[a-z]*c[a-z]*$/.test(arg));
        if (flag !== -1) visit(args[flag + 1] ?? '', depth + 1);
        continue;
      }
      if (/^python[0-9.]*$/.test(program) && args[0] === '-m') {
        program = args[1] ?? '';
        args = args.slice(2);
      }
      if (/^pip[0-9.]*$/.test(program)) program = 'pip';
      let sub = 0;
      while ((args[sub] ?? '').startsWith('-')) sub += OPTION_VALUES.has(args[sub]!) ? 2 : 1;
      const subcommand = args[sub];
      if (program === 'uv' && subcommand === 'pip') {
        if (!['install', 'sync'].includes(args[sub + 1] ?? '')) continue;
        program = 'pip';
        args = args.slice(sub + 2);
      } else if (program === 'yarn' && subcommand === undefined) {
        found = true;
        continue;
      } else if (!Object.hasOwn(INSTALL_COMMANDS, program) || !INSTALL_COMMANDS[program]!.includes(subcommand ?? '')) {
        continue;
      }
      found = true;
      if (program === 'pip') files.push(...requirementFiles(args));
    }
  };
  visit(command, 0);
  return found ? files : null;
}

export function isPackageManagerCommand(command: string): boolean {
  return packageManagerFiles(command) !== null;
}

interface ManifestInput {
  clone: string;
  vault: string;
  startSha: string;
  cwd?: string;
  /** More files to compare, relative to cwd (or the clone): those a pip command names with -r or -c. */
  files?: string[];
  local: GitEnvironment;
}

type FileState = {
  kind: 'absent' | 'file' | 'symlink' | 'directory' | 'non-regular file';
  size: number;
  text?: string;
  oid?: string;
};

function missing(error: unknown): boolean {
  return ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '');
}

async function safeDirectory(clone: string, directory: string): Promise<boolean> {
  if (directory !== clone && !directory.startsWith(clone + sep)) return false;
  const path = directory.slice(clone.length);
  let current = clone;
  for (const part of ['', ...path.split(sep).filter(Boolean)]) {
    if (part === '..' && current === clone) return false;
    current = join(current, part);
    try {
      if (!(await lstat(current)).isDirectory()) return false;
    } catch (error) {
      if (missing(error)) return false;
      throw error;
    }
  }
  return true;
}

async function currentFile(path: string): Promise<FileState> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) return { kind: 'symlink', size: stat.size, text: await readlink(path) };
    if (!stat.isFile()) return { kind: stat.isDirectory() ? 'directory' : 'non-regular file', size: stat.size };
    // NOFOLLOW closes the leaf-symlink race; NONBLOCK prevents a swapped-in FIFO from hanging an approval.
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = await handle.stat();
      if (!opened.isFile()) return { kind: opened.isDirectory() ? 'directory' : 'non-regular file', size: opened.size };
      if (opened.size > HASH_MAX) return { kind: 'file', size: opened.size };
      if (opened.size > FILE_MAX) {
        const hash = createHash('sha1').update(`blob ${opened.size}\0`);
        const chunk = Buffer.alloc(HASH_CHUNK);
        let length = 0;
        for (;;) {
          const { bytesRead } = await handle.read(chunk, 0, chunk.length, length);
          if (!bytesRead) break;
          length += bytesRead;
          if (length > opened.size) throw new Error(`${path} changed while it was read`);
          hash.update(chunk.subarray(0, bytesRead));
        }
        // A file that shrank while it was read gets no oid, so it is summarised rather than called unchanged.
        return { kind: 'file', size: opened.size, ...(length === opened.size ? { oid: hash.digest('hex') } : {}) };
      }
      const buffer = Buffer.alloc(opened.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > opened.size) throw new Error(`${path} changed while it was read`);
      const content = buffer.subarray(0, length);
      const oid = createHash('sha1').update(`blob ${length}\0`).update(content).digest('hex');
      return { kind: 'file', size: length, text: content.toString('utf8'), oid };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (missing(error)) return { kind: 'absent', size: 0 };
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      return { kind: 'symlink', size: 0, text: await readlink(path) };
    }
    throw error;
  }
}

function description(file: FileState): string {
  if (file.kind === 'symlink') return `symlink -> ${JSON.stringify(file.text)}`;
  return file.kind === 'file' ? `${file.size} bytes` : file.kind;
}

/** The .yarnrc* names in a directory of the start commit or the clone. */
async function yarnrcNames(input: ManifestInput, git: string[], clone: string, directory: string): Promise<string[]> {
  const rel = relative(clone, directory);
  const tree = await runGit(input.local, [
    ...git,
    'ls-tree',
    '-z',
    '--name-only',
    input.startSha,
    ...(rel === '' ? [] : ['--', `:(literal)${rel}/`]),
  ]);
  let current: string[] = [];
  try {
    current = await readdir(directory);
  } catch (error) {
    if (!missing(error)) throw error;
  }
  const names = [
    ...tree.stdout
      .split('\0')
      .filter(Boolean)
      .map((path) => basename(path)),
    ...current,
  ];
  return [...new Set(names.filter((name) => matchesProtectedPattern(name, YARNRC)))].sort();
}

/** Root first, then the command's cwd and the named files; each directory follows the manifest order. */
export async function manifestDiff(input: ManifestInput): Promise<string | null> {
  const { vault, startSha, local } = input;
  const clone = resolve(input.clone);
  if (!(await safeDirectory(clone, clone))) throw new Error(`${clone} is not a directory`);
  const directories = [clone];
  // Relative files resolve against the cwd; with a cwd outside the clone they are skipped.
  let base: string | null = clone;
  if (input.cwd !== undefined) {
    // Check components before resolving '..', which could otherwise hide a symlink on the way.
    const cwd = isAbsolute(input.cwd) ? input.cwd : `${clone}${sep}${input.cwd}`;
    const safe = await safeDirectory(clone, cwd);
    if (resolve(cwd) !== clone && safe) directories.push(resolve(cwd));
    base = safe ? cwd : null;
  }
  const git = ['--git-dir=' + vault];
  // A missing path is normal; a missing commit or unreadable vault is not.
  const commit = await runGit(local, [...git, 'cat-file', '-t', startSha]);
  if (commit.stdout.trim() !== 'commit') throw new Error(`${startSha} is not a commit`);
  const paths: string[] = [];
  for (const dir of directories) {
    for (const name of MANIFESTS) {
      const names = name === YARNRC ? await yarnrcNames(input, git, clone, dir) : [name];
      paths.push(...names.map((entry) => relative(clone, join(dir, entry))));
    }
  }
  for (const file of (input.files ?? []).slice(0, EXTRA_MAX)) {
    const path = isAbsolute(file) ? file : base === null ? null : `${base}${sep}${file}`;
    if (path === null || !(await safeDirectory(clone, dirname(path)))) continue;
    const rel = relative(clone, resolve(path));
    if (rel !== '' && !rel.startsWith('..') && !paths.includes(rel)) paths.push(rel);
  }
  const tree = await runGit(local, [
    ...git,
    'ls-tree',
    '-z',
    '-l',
    startSha,
    '--',
    ...paths.map((p) => `:(literal)${p}`),
  ]);
  const baseFiles = new Map<string, FileState>();
  for (const entry of tree.stdout.split('\0').filter(Boolean)) {
    const tab = entry.indexOf('\t');
    const [mode, type, oid, size] = entry.slice(0, tab).trim().split(/\s+/);
    baseFiles.set(entry.slice(tab + 1), {
      kind:
        mode === '120000' ? 'symlink' : type === 'blob' ? 'file' : type === 'tree' ? 'directory' : 'non-regular file',
      size: Number(size) || 0,
      oid,
    });
  }
  let text = '';
  for (const path of paths) {
    const base = baseFiles.get(path) ?? { kind: 'absent', size: 0 };
    const current = await currentFile(join(clone, path));
    if (base.kind === 'absent' && current.kind === 'absent') continue;
    if (base.kind === 'file' && current.kind === 'file' && base.oid === current.oid) continue;
    if (base.oid && base.size <= FILE_MAX && ['file', 'symlink'].includes(base.kind)) {
      base.text = (await runGit(local, [...git, 'cat-file', 'blob', base.oid])).stdout;
    }
    if (base.kind === 'symlink' && current.kind === 'symlink' && base.text === current.text) continue;
    const special = [base, current].some((file) => !['file', 'absent'].includes(file.kind));
    const sizes = `base ${base.size} bytes, current ${current.size} bytes`;
    if (special) {
      text += `${path}: ${description(base)} -> ${description(current)}\n`;
    } else if (base.size > FILE_MAX || current.size > FILE_MAX) {
      text += `${path}: size limit (${FILE_MAX} bytes); ${sizes}\n`;
    } else if (basename(path) === 'bun.lockb' || base.text?.includes('\0') || current.text?.includes('\0')) {
      text += `${path}: binary; ${sizes}\n`;
    } else {
      // Even a small file can have enough changed lines to make an unbounded diff expensive.
      const patch = createTwoFilesPatch(
        `a/${path}`,
        `b/${path}`,
        base.text ?? '',
        current.text ?? '',
        undefined,
        undefined,
        {
          maxEditLength: 2048,
          timeout: 100,
        },
      );
      text += patch ?? `${path}: diff computation limit; ${sizes}\n`;
    }
    const bytes = Buffer.from(text);
    if (bytes.length > TEXT_MAX) {
      let end = TEXT_MAX - Buffer.byteLength(TRUNCATED);
      while ((bytes[end]! & 0xc0) === 0x80) end--;
      return bytes.subarray(0, end).toString('utf8') + TRUNCATED;
    }
  }
  return text || null;
}

/**
 * The Codex adapter binds enrichApproval to this with the runner's localGitEnv(paths); the input stays exactly
 * VendorAdapter.enrichApproval's.
 */
export async function codexEnrichApproval(
  input: Parameters<NonNullable<VendorAdapter['enrichApproval']>>[0],
  local: GitEnvironment,
): Promise<Approval['detail']> {
  const { kind, detail } = input.request;
  const files = kind === 'command' && detail.command ? packageManagerFiles(detail.command) : null;
  if (files === null) return detail;
  const diff = await manifestDiff({ ...input, cwd: detail.cwd, files, local });
  return diff === null ? detail : { ...detail, manifestDiff: diff };
}
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `bun test packages/runner/test/codex/manifest-diff.test.ts && bun test && bun run typecheck`
Expected: the task's tests pass (98 pass); then the whole suite passes (`0 fail`) and `tsc` exits 0.

The manifests are the design's list (`package.json`, the lockfiles, `.npmrc`, every `.yarnrc*` name, `bunfig.toml`) plus those of the other managers `isPackageManagerCommand` recognises (`pyproject.toml`, `requirements.txt`, `poetry.lock`, `uv.lock`, `Pipfile(.lock)`, `Cargo.toml/.lock`, `go.mod/.sum`) and a pip command's `-r`/`-c` files, at the clone root and the request's cwd inside the clone, so a missing diff never reads as 'unchanged'. Files over 256 KiB are summarised by size (hashed up to 64 MiB, so an unchanged big lockfile is skipped), links and binaries get one-line summaries, and the output is capped at 64 KiB. The command parser splits its own words and never runs shell text.

- [ ] **Step 5: Commit**

```bash
git add -A 'packages/runner/src/adapters/codex/manifest-diff.ts' 'packages/runner/test/codex/manifest-diff.test.ts'
git commit -m 'M2E Task 18: Manifest diffs for package-manager approvals' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

### Task 19: CodexAdapter and the codex entry

`CodexAdapter` assembles the `VendorAdapter` for `codex` (design 13): `preflight`, `start`, `readTranscriptTail`, `deleteTranscript` and `enrichApproval` delegate to Tasks 10-18. It resolves its homes, base environment and test switches once through `codexProcessOptions`, and a session resolves the binary from `launch.cliVersion`, so one adapter serves every recorded version (X-13). `entry.ts`, M2b's stub, now returns `createCodexAdapter({ config, paths })`, so `createAdapters` gives a Codex adapter and `agflow runner start` runs Codex agents (X-6); exports go through `adapters/codex/index.ts`, and no shared file changes. A missing binary is preflight's 'binary missing', never a failed construction.

**Files:**
- Create: `packages/runner/src/adapters/codex/adapter.ts`
- Modify: `packages/runner/src/adapters/codex/entry.ts`
- Create: `packages/runner/src/adapters/codex/index.ts`
- Test: `packages/runner/test/codex/adapter.test.ts`

- [ ] **Step 1: Write the failing test**

**File:** `packages/runner/test/codex/adapter.test.ts` (new)

```ts
// The registry's Codex adapter, exercised through real child-process shims and temporary transcripts and vaults.
import { afterEach, describe, expect, test } from 'bun:test';
import { TEST_ACCOUNT_ID } from '@agflow/core';
import { originRepo } from '@agflow/testkit';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAdapters } from '../../src/adapters';
import { BRIDGE_TOOL_NAMES } from '../../src/adapters/bridge-tools';
import {
  CodexAdapter,
  CodexSession,
  CODEX_VERSION,
  codexAdapterOptions,
  createCodexAdapter,
} from '../../src/adapters/codex';
import { codexAdapterFactory } from '../../src/adapters/codex/entry';
import type { AgentEvent, AgentLaunch, VendorAdapter } from '../../src/adapters/types';
import { RunnerConfigSchema, type RunnerConfigInput, vendorHomes } from '../../src/config';
import { ensureRunnerGitFiles } from '../../src/git/run';
import { runnerPaths } from '../../src/paths';
import { standardProfile } from '../../src/profile';
import { VENDOR_PINS, vendorBinary, vendorPlatform } from '../../src/vendor/pins';
import { codexMessages as m, codexScenario, FAKE_THREAD_ID, fakeTurnId, readCodexRecord, writeCodexShim } from './peer';
import { collect, mcp, skills, until } from './session-fixture';

const dirs: string[] = [];
const pids: number[] = [];
afterEach(() => {
  for (const pid of pids.splice(0)) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // Already exited.
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const testBlock = { skipAuthChecks: true, codexConfig: { model_provider: 'scripted' } };
const env = {
  AGFLOW_TEST: '1',
  USER: 'test',
  LOGNAME: 'test',
  LANG: 'C',
  SHELL: '/bin/zsh',
  LC_ALL: 'C',
  LC_CTYPE: 'UTF-8',
  PATH: '/unwanted',
  HTTPS_PROXY: 'http://unwanted',
  HOME: '/unwanted',
  CODEX_HOME: '/unwanted',
  OPENAI_API_KEY: 'secret',
  AGFLOW_AGENT_TOKEN: 'secret',
};
const base = {
  PATH: '/usr/bin:/bin',
  HTTPS_PROXY: 'http://127.0.0.1:9',
  USER: 'test',
  LOGNAME: 'test',
  LANG: 'C',
  SHELL: '/bin/zsh',
  LC_ALL: 'C',
  LC_CTYPE: 'UTF-8',
};

function setup(overrides: Partial<RunnerConfigInput> = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agflow-codex-adapter-')));
  dirs.push(dir);
  const paths = runnerPaths(join(dir, 'agflow'));
  const config = RunnerConfigSchema.parse({
    runnerKey: 'runner',
    machineId: 'machine',
    name: 'test',
    capturedPath: '/usr/bin:/bin',
    connectivity: { HTTPS_PROXY: base.HTTPS_PROXY },
    test: testBlock,
    ...overrides,
  });
  // The pinned platform, as in preflight.test.ts: CI runs on linux-x64, which has no pin.
  const adapter = createCodexAdapter({ config, paths, env, platform: 'darwin', arch: 'arm64', requestTimeoutMs: 500 });
  return { dir, paths, config, options: codexAdapterOptions(config, paths, env), adapter };
}

describe('codexAdapterOptions', () => {
  test('uses the runner homes and only captured connectivity and user variables', () => {
    const f = setup();
    expect(f.options.codexHome).toBe(vendorHomes(f.config, f.paths).codex);
    expect(f.options.userHome).toBe(f.paths.homes.codexUser);
    expect(f.options.base).toEqual(base);
    const config = { ...f.config, homes: { ...f.config.homes, codex: join(f.dir, 'custom-codex') } };
    expect(codexAdapterOptions(config, f.paths, env).codexHome).toBe(config.homes.codex!);
    expect(codexAdapterOptions(config, f.paths)).toEqual(codexAdapterOptions(config, f.paths, process.env));
  });

  test('both AGFLOW_TEST=1 and the test block are required for test switches', () => {
    const f = setup();
    const switches = (options: ReturnType<typeof codexAdapterOptions>) => ({
      codexConfig: options.codexConfig,
      skipAuthChecks: options.skipAuthChecks,
    });
    expect(switches(f.options)).toEqual(testBlock);
    expect(switches(codexAdapterOptions(f.config, f.paths, {}))).toEqual({
      codexConfig: null,
      skipAuthChecks: false,
    });
    expect(switches(codexAdapterOptions({ ...f.config, test: undefined }, f.paths, env))).toEqual({
      codexConfig: null,
      skipAuthChecks: false,
    });
  });
});

describe('CodexAdapter', () => {
  test('preflight reports test identity and probes the pinned shim with shared settings', async () => {
    const f = setup();
    const bin = join(f.paths.runner, vendorBinary('codex', CODEX_VERSION));
    writeCodexShim(
      bin,
      codexScenario({
        answers: {
          'configRequirements/read': { result: { requirements: null } },
          'config/read': { error: { code: -32600, message: 'unavailable' } },
          'mcpServerStatus/list': { result: mcp([]) },
          'skills/list': { result: skills('system') },
        },
      }),
    );
    expect(f.adapter.vendor).toBe('codex');
    expect(await f.adapter.preflight()).toEqual({
      facts: {
        vendor: 'codex',
        cliVersion: CODEX_VERSION,
        ownerCliVersion: null,
        ready: true,
        problem: 'test mode',
        accountId: TEST_ACCOUNT_ID,
        plan: 'test mode',
        managedPolicy: true,
      },
      quota: null,
      weakened: [],
    });
    const [run] = readCodexRecord(bin);
    expect(run!.requests.map(({ method }) => method)).toEqual([
      'initialize',
      'configRequirements/read',
      'config/read',
      'mcpServerStatus/list',
      'skills/list',
      'account/rateLimits/read',
    ]);
    expect(run!.argv.slice(-2)).toEqual(['-c', 'model_provider="scripted"']);
    expect(run!.env).toEqual({
      ...base,
      CODEX_HOME: f.options.codexHome,
      HOME: f.options.userHome,
      GIT_DIR: '/dev/null',
    });
    expect(run!.exit).toMatchObject({ reason: 'eof', code: 0 });
  });

  test('starts the launch version, delivers a turn and test quota, then closes the process and event iterable', async () => {
    const f = setup();
    const version = '0.158.0';
    const bin = join(f.paths.runner, vendorBinary('codex', version));
    const turn = fakeTurnId(1);
    writeCodexShim(
      bin,
      codexScenario({
        version,
        answers: {
          'mcpServerStatus/list': { result: mcp() },
          'skills/list': { result: skills('system') },
          'turn/start': {
            result: { turn: m.turn({ id: turn, status: 'inProgress' }) },
            then: [
              { notify: m.turnStarted(FAKE_THREAD_ID, m.turn({ id: turn, status: 'inProgress' })) },
              { notify: m.itemCompleted(FAKE_THREAD_ID, turn, m.agentMessageItem('Adapter turn complete.')) },
              { notify: m.rateLimitsUpdated() },
              { notify: m.turnCompleted(FAKE_THREAD_ID, m.turn({ id: turn, status: 'completed' })) },
            ],
          },
        },
      }),
    );
    const clone = join(f.dir, 'clone');
    // No preflight ran, so the homes are missing: the start makes them.
    mkdirSync(clone);
    const launch: AgentLaunch = {
      attemptId: 'T-42-a1',
      role: 'worker',
      model: 'requested-model',
      cliVersion: version,
      clone,
      baseCheckout: null,
      projectConfigVerified: true,
      tmpDir: join(clone, '.agflow/run/tmp'),
      env: { PATH: '/usr/bin:/bin', LANG: 'C' },
      bridge: {
        command: '/fake/agflow',
        args: ['mcp', '--vendor', 'codex', '--runner'],
        env: { AGFLOW_AGENT_TOKEN: 'test-token' },
        tools: BRIDGE_TOOL_NAMES.worker,
      },
      profile: standardProfile,
      brief: 'Work in this clone.',
      firstPrompt: 'Implement the task.',
      resume: null,
      logFile: f.paths.attemptLog('T-42-a1'),
      registerProcess: (pid) => {
        pids.push(pid);
      },
    };
    expect(existsSync(join(f.paths.runner, vendorBinary('codex', CODEX_VERSION)))).toBe(false);
    const session = await f.adapter.start(launch);
    expect(session).toBeInstanceOf(CodexSession);
    for (const home of [f.options.codexHome, f.options.userHome]) expect(statSync(home).mode & 0o777).toBe(0o700);
    const observed: AgentEvent[] = [];
    const completed = collect(
      (async function* () {
        for await (const event of session.events) {
          observed.push(event);
          yield event;
        }
      })(),
    );
    await until(() => observed.some((event) => event.type === 'turn_ended'));
    expect(observed).toEqual([
      {
        type: 'started',
        sessionRef: FAKE_THREAD_ID,
        model: launch.model,
        cliVersion: version,
        permissionMode: 'on-request',
      },
      { type: 'turn_started' },
      { type: 'text', text: 'Adapter turn complete.' },
      { type: 'quota', accountId: TEST_ACCOUNT_ID, quota: expect.any(Object) },
      { type: 'turn_ended', outcome: 'completed', toolCalls: 0, error: null, errorKind: null },
    ]);
    await session.close();
    expect(await session.exited).toEqual({ code: 0, signal: null });
    expect(await completed).toEqual(observed);
    const [run] = readCodexRecord(bin);
    expect(run!.requests.map(({ method }) => method)).toEqual([
      'initialize',
      'thread/start',
      'mcpServerStatus/list',
      'skills/list',
      'thread/name/set',
      'turn/start',
    ]);
    expect(run!.argv.slice(-2)).toEqual(['-c', 'model_provider="scripted"']);
    expect(run!.env).toEqual({
      PATH: '/usr/bin:/bin',
      LANG: 'C',
      AGFLOW_AGENT_TOKEN: 'test-token',
      CODEX_HOME: f.options.codexHome,
      HOME: f.options.userHome,
      GIT_DIR: '/dev/null',
    });
    expect(run!.exit).toMatchObject({ reason: 'eof', code: 0 });
  });

  test('reads from its Codex home and deletes through the pinned app-server', async () => {
    const f = setup();
    const dir = join(f.options.codexHome, 'sessions/2026/11/10');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `rollout-2026-11-10T12-00-00-${FAKE_THREAD_ID}.jsonl`),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'The adapter transcript.' }],
        },
      }) + '\n',
    );
    const input = { sessionRef: FAKE_THREAD_ID, clone: '/unused' };
    expect(await f.adapter.readTranscriptTail({ ...input, maxChars: 11 })).toBe('transcript.');
    expect(await f.adapter.readTranscriptTail({ ...input, sessionRef: 'missing', maxChars: 100 })).toBeNull();
    const bin = join(f.paths.runner, vendorBinary('codex', CODEX_VERSION));
    writeCodexShim(bin, codexScenario({ answers: { 'thread/delete': { result: {} } } }));
    await f.adapter.deleteTranscript(input);
    const [run] = readCodexRecord(bin);
    expect(run!.requests.map(({ method, params }) => ({ method, params })).slice(1)).toEqual([
      { method: 'thread/delete', params: { threadId: FAKE_THREAD_ID } },
    ]);
    expect(run!.requests[0]!.method).toBe('initialize');
    expect(run!.argv.slice(-2)).toEqual(['-c', 'model_provider="scripted"']);
    expect(run!.env).toEqual({
      ...base,
      CODEX_HOME: f.options.codexHome,
      HOME: f.options.userHome,
      GIT_DIR: '/dev/null',
    });
    expect(run!.exit).toMatchObject({ reason: 'eof', code: 0 });
  });

  test('enriches package-manager approvals against the vault and can be called detached', async () => {
    const f = setup();
    const before = '{"name":"before"}\n';
    const origin = await originRepo({ 'package.json': before });
    dirs.push(origin.root);
    const clone = join(f.dir, 'clone');
    mkdirSync(clone);
    writeFileSync(join(clone, 'package.json'), '{"name":"after"}\n');
    ensureRunnerGitFiles(f.paths);
    const enrich = f.adapter.enrichApproval;
    const input: Parameters<NonNullable<VendorAdapter['enrichApproval']>>[0] = {
      clone,
      vault: origin.path,
      startSha: origin.mainSha,
      request: { kind: 'command', summary: 'npm install', detail: { command: 'npm install', cwd: clone } },
    };
    const detail = await enrich(input);
    expect(detail).toMatchObject(input.request.detail);
    expect(detail.manifestDiff).toContain('--- a/package.json');
    expect(detail.manifestDiff).toContain('-{"name":"before"}');
    expect(detail.manifestDiff).toContain('+{"name":"after"}');
    const other = { ...input.request, detail: { command: 'npm test', cwd: clone } };
    expect(await enrich({ ...input, request: other })).toBe(other.detail);
    writeFileSync(join(clone, 'package.json'), before);
    expect(await enrich(input)).toBe(input.request.detail);
  });
});

describe('Codex registry entry', () => {
  for (const installed of [false, true]) {
    test(`creates exactly one CodexAdapter with the pinned binary ${installed ? 'present' : 'missing'}`, async () => {
      const f = setup();
      if (installed) writeCodexShim(join(f.paths.runner, vendorBinary('codex', CODEX_VERSION)), codexScenario());
      const agflow = { command: '/fake/agflow', args: [] };
      expect(codexAdapterFactory({ config: f.config, paths: f.paths, agflow })).toBeInstanceOf(CodexAdapter);
      const adapters = createAdapters(f.config, f.paths, { agflow }).filter(({ vendor }) => vendor === 'codex');
      expect(adapters).toHaveLength(1);
      expect(adapters[0]).toBeInstanceOf(CodexAdapter);
      // The production entry preflights the host platform, so an unpinned one (CI's linux-x64) is unsupported.
      const problem = VENDOR_PINS[vendorPlatform()]?.codex ? 'binary missing' : 'unsupported platform';
      if (!installed) expect((await adapters[0]!.preflight()).facts).toMatchObject({ ready: false, problem });
    });
  }
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `bun test packages/runner/test/codex/adapter.test.ts`
Expected: FAIL — `error: Cannot find module '../../src/adapters/codex' from 'packages/runner/test/codex/adapter.test.ts'` (0 pass, 1 fail, 1 error; observed in the 2026-11-11 parent replay).

- [ ] **Step 3: Implement**

**File:** `packages/runner/src/adapters/codex/adapter.ts` (new)

```ts
// The Codex adapter (design 9, 13): the VendorAdapter the registry's Codex entry returns (X-6). Preflight, sessions and
// transcript deletion share one derivation of the homes, base environment and test switches (codexProcessOptions), and
// a session runs the binary of its launch's cliVersion, the recorded one on a resume (X-13). A missing binary is
// preflight's 'binary missing', never a failed construction.
import { mkdir } from 'node:fs/promises';
import type { RunnerConfig } from '../../config';
import { localGitEnv } from '../../git/run';
import type { Logger } from '../../log';
import type { RunnerPaths } from '../../paths';
import type { AgentLaunch, PreflightResult, VendorAdapter } from '../types';
import { codexEnrichApproval } from './manifest-diff';
import { codexProcessOptions, runCodexPreflight, type CodexProcessOptions } from './preflight';
import { CodexSession } from './session';
import { deleteCodexTranscript, readCodexTranscriptTail } from './transcript';

export interface CodexAdapterOptions {
  config: RunnerConfig;
  paths: RunnerPaths;
  /** Where AGFLOW_TEST and the user variables are read; process.env by default. */
  env?: Record<string, string | undefined>;
  logger?: Logger;
  requestTimeoutMs?: number;
  platform?: string;
  arch?: string;
}

/**
 * The homes, base environment and test switches the adapter resolves from its config, paths and env. Transcript
 * deletion resolves them from the same three inputs, so the adapter takes no other source of them.
 */
export function codexAdapterOptions(
  config: RunnerConfig,
  paths: RunnerPaths,
  env: Record<string, string | undefined> = process.env,
): CodexProcessOptions {
  return codexProcessOptions({ config, paths, env });
}

export class CodexAdapter implements VendorAdapter {
  readonly vendor = 'codex' as const;

  private readonly resolved: CodexProcessOptions;

  constructor(private readonly options: CodexAdapterOptions) {
    this.resolved = codexAdapterOptions(options.config, options.paths, options.env);
  }

  preflight(): Promise<PreflightResult> {
    const { config, paths, logger, requestTimeoutMs, platform, arch } = this.options;
    return runCodexPreflight({
      ...this.resolved,
      paths,
      capturedPath: config.capturedPath,
      platform,
      arch,
      logger,
      requestTimeoutMs,
    });
  }

  async start(launch: AgentLaunch): Promise<CodexSession> {
    const { paths, logger, requestTimeoutMs } = this.options;
    const { codexHome, userHome, codexConfig, skipAuthChecks } = this.resolved;
    // The homes are made as preflight and deletion make them: the user home is app-server's cwd, and a start must not
    // depend on a preflight having run first.
    await Promise.all([codexHome, userHome].map((home) => mkdir(home, { recursive: true, mode: 0o700 })));
    // The session resolves the binary from launch.cliVersion, including the recorded version on resume (X-13).
    return CodexSession.start(launch, {
      runnerDir: paths.runner,
      codexHome,
      userHome,
      testConfig: codexConfig,
      skipAuthChecks,
      logger,
      requestTimeoutMs,
    });
  }

  readTranscriptTail({
    sessionRef,
    maxChars,
  }: Parameters<VendorAdapter['readTranscriptTail']>[0]): Promise<string | null> {
    return readCodexTranscriptTail({ codexHome: this.resolved.codexHome, sessionRef, maxChars });
  }

  deleteTranscript({ sessionRef }: Parameters<VendorAdapter['deleteTranscript']>[0]): Promise<void> {
    const { config, paths, env, logger, requestTimeoutMs } = this.options;
    return deleteCodexTranscript({ sessionRef, config, paths, env, logger, requestTimeoutMs });
  }

  // A property, so it works detached from the adapter, as callers may hold it.
  readonly enrichApproval: NonNullable<VendorAdapter['enrichApproval']> = (input) =>
    codexEnrichApproval(input, localGitEnv(this.options.paths));
}

export function createCodexAdapter(options: CodexAdapterOptions): CodexAdapter {
  return new CodexAdapter(options);
}
```

**File:** `packages/runner/src/adapters/codex/entry.ts` (change)

```diff
diff --git a/packages/runner/src/adapters/codex/entry.ts b/packages/runner/src/adapters/codex/entry.ts
index ca8f9972..08ca604e 100644
--- a/packages/runner/src/adapters/codex/entry.ts
+++ b/packages/runner/src/adapters/codex/entry.ts
@@ -1,4 +1,6 @@
-// The Codex adapter's entry in the registry (X-6). M2e fills it with its adapter; until then it gives none.
+// The Codex adapter's entry in the registry (X-6): always an adapter, also without the pinned binary, which preflight
+// then reports as 'binary missing'.
 import type { AdapterFactory } from '../types';
+import { createCodexAdapter } from './adapter';
 
-export const codexAdapterFactory: AdapterFactory = () => null;
+export const codexAdapterFactory: AdapterFactory = ({ config, paths }) => createCodexAdapter({ config, paths });
```

**File:** `packages/runner/src/adapters/codex/index.ts` (new)

```ts
// The Codex adapter's public surface for the runner and integration harnesses.
export { CodexAdapter, createCodexAdapter, codexAdapterOptions, type CodexAdapterOptions } from './adapter';
export { CODEX_VERSION, findCodexBinary } from './binary';
export { CodexSession, type CodexSessionOptions } from './session';
export { codexProcessOptions, type CodexProcessOptions } from './preflight';
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `bun test packages/runner/test/codex/adapter.test.ts && bun test && bun run typecheck`
Expected: the task's tests pass (8 pass); then the whole suite passes (`0 fail`) and `tsc` exits 0.

`start` creates both Codex homes (0700) before the session, as preflight and deletion do: the codex-user home is app-server's cwd, and the controller may start an attempt with no earlier preflight (checked by Task 20). `enrichApproval` is an arrow-function property, so it also works detached. The tests pass `platform: 'darwin'` and `arch: 'arm64'`; the registry test expects 'binary missing' where `VENDOR_PINS` has a Codex pin for the platform and 'unsupported platform' elsewhere (checked with linux-x64 simulated). The fake launch supplies `bridge.tools: BRIDGE_TOOL_NAMES.worker`, as required by M2b's per-launch contract.

- [ ] **Step 5: Commit**

```bash
git add -A 'packages/runner/src/adapters/codex/adapter.ts' 'packages/runner/src/adapters/codex/entry.ts' 'packages/runner/src/adapters/codex/index.ts' 'packages/runner/test/codex/adapter.test.ts'
git commit -m 'M2E Task 19: CodexAdapter and the codex entry' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

### Task 20: Contract check: the AttemptController drives the Codex adapter

A CI check that M2b's `AttemptController` and this adapter agree (design 13, 6.3, 15). It uses the controller test fixture with fake-peer binaries at the pinned and at a recorded CLI version: `attempt.spawned` with the thread id, model, CLI version and permission mode; a resume on the recorded version's binary; tool activity and a submit terminal with no continuation; a delivery steered into a turn with `attempt.delivered` and `attempt.acknowledged`; an `npm install` approval with the fence and `detail.manifestDiff`, decided once; a crash that voids the pending approval; and `cleanup_attempt` deleting the thread.

**Files:**
- Test: `packages/runner/test/codex/controller-contract.test.ts`

- [ ] **Step 1: Make the change**

**File:** `packages/runner/test/codex/controller-contract.test.ts` (new)

```ts
// The real AttemptController drives the real Codex adapter over a scripted app-server (design 13, 6.3, 15).
// These tests keep the runner's process, delivery, approval and cleanup contracts on the same path as production.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCodexAdapter } from '../../src/adapters/codex';
import { vendorBinary } from '../../src/vendor/pins';
import {
  cleanupRunnerFixtures,
  createRunnerFixture,
  FIXTURE_PROJECT,
  fixtureAgentToken,
  fixtureCliVersion,
  type RunnerFixture,
  type RunnerFixtureOptions,
  waitFor,
} from '../fixture';
import {
  codexMessages as m,
  codexScenario,
  FAKE_THREAD_ID as THREAD,
  fakeTurnId,
  readCodexRecord,
  writeCodexShim,
  type ScriptedAnswers,
} from './peer';
import { firstInput, mcp, skills } from './session-fixture';

afterEach(cleanupRunnerFixtures);

const ATTEMPT = 'T-4-a1';
const FENCE = { epoch: 1, counter: 1 };
const TURN = fakeTurnId(1);
const begin = () => m.turnStarted(THREAD, m.turn({ id: TURN, status: 'inProgress' }));
const finish = () => m.turnCompleted(THREAD, m.turn({ id: TURN, status: 'completed' }));
const input = (text: string) => [{ type: 'text', text, text_elements: [] }];
const cloneOf = (f: RunnerFixture) => f.paths.clone(FIXTURE_PROJECT, ATTEMPT);
const requests = (bin: string, method: string) =>
  readCodexRecord(bin).flatMap((run) => run.requests.filter((request) => request.method === method));

function scenario(answers: ScriptedAnswers = {}, version = fixtureCliVersion('codex')) {
  return codexScenario({
    version,
    answers: {
      'mcpServerStatus/list': { result: mcp() },
      'skills/list': { result: skills('system') },
      'turn/start': { then: [{ notify: begin() }] },
      ...answers,
    },
  });
}

async function setup(answers: (f: RunnerFixture) => ScriptedAnswers = () => ({}), options: RunnerFixtureOptions = {}) {
  const f = await createRunnerFixture(options);
  const bin = join(f.paths.runner, vendorBinary('codex', fixtureCliVersion('codex')));
  writeCodexShim(bin, scenario(answers(f)));
  // The fixture marks vendors ready without a preflight: the adapter's start makes the Codex homes itself.
  const env = { AGFLOW_TEST: '1' };
  f.adapters.set('codex', createCodexAdapter({ config: f.config, paths: f.paths, env, requestTimeoutMs: 1_000 }));
  return { f, bin, controller: f.controller() };
}

const turnsEnded = (f: RunnerFixture) => f.events('attempt.activity').filter((event) => event.data.kind === 'turn');

async function stop(controller: ReturnType<RunnerFixture['controller']>) {
  expect(
    await controller.stop({
      fence: controller.fence!,
      reason: 'contract test finished',
      handoff: false,
      interruptFirst: false,
      keepClone: true,
    }),
  ).toMatchObject({ ok: true });
}

describe('AttemptController with CodexAdapter', () => {
  test('start_attempt reports the thread, launch model, CLI version and permission mode', async () => {
    const { f, bin, controller } = await setup();
    const spec = f.spec({ vendor: 'codex', model: 'contract-model' });
    expect(await controller.start(spec)).toEqual({ started: true });
    const spawned = await waitFor(() => f.events('attempt.spawned')[0]);
    expect(spawned).toMatchObject({
      attemptId: ATTEMPT,
      fence: FENCE,
      data: {
        sessionRef: THREAD,
        pid: controller.session!.pid,
        model: spec.model,
        cliVersion: fixtureCliVersion('codex'),
        permissionMode: 'on-request',
        startSha: f.origin.mainSha,
      },
    });
    expect(requests(bin, 'thread/start')[0]?.params).toMatchObject({ model: spec.model });
    expect(requests(bin, 'turn/start').map((request) => request.params)).toEqual([
      { threadId: THREAD, input: firstInput(spec.firstPrompt) },
    ]);
    await stop(controller);
  });

  test('resume_attempt runs the binary of the recorded CLI version', async () => {
    const { f, bin, controller } = await setup(() => ({
      'turn/start': { then: [{ notify: begin() }, { notify: finish() }] },
    }));
    const spec = f.spec({ vendor: 'codex' });
    expect(await controller.start(spec)).toEqual({ started: true });
    await waitFor(() => turnsEnded(f).length === 1);
    await stop(controller);
    const version = '0.158.0';
    const recordedBin = join(f.paths.runner, vendorBinary('codex', version));
    writeCodexShim(recordedBin, scenario({}, version));
    f.store.update(ATTEMPT, { cliVersion: version });
    const fence = { epoch: 1, counter: 2 };
    const prompt = 'Review feedback: rename the helper.';
    expect(
      await controller.resume({
        fence,
        agentToken: fixtureAgentToken(`${ATTEMPT} resumed`),
        prompt,
        messages: [],
        taskPack: null,
        restore: spec.restore,
        acceptanceIds: spec.acceptanceIds,
      }),
    ).toEqual({ resumed: true });
    const spawned = await waitFor(() => f.events('attempt.spawned')[1]);
    expect(spawned).toMatchObject({ fence, data: { sessionRef: THREAD, cliVersion: version, startSha: null } });
    expect(readCodexRecord(bin)).toHaveLength(1);
    expect(readCodexRecord(recordedBin)).toHaveLength(1);
    expect(requests(recordedBin, 'thread/resume')[0]?.params).toMatchObject({ threadId: THREAD });
    expect(requests(recordedBin, 'thread/start')).toEqual([]);
    expect(requests(recordedBin, 'turn/start').map((request) => request.params)).toEqual([
      { threadId: THREAD, input: input(prompt) },
    ]);
    await stop(controller);
  });

  test('command activity and a completed submit end the turn without a continuation', async () => {
    const { f, bin, controller } = await setup(
      (f) => {
        const command = m.commandExecutionItem({ id: 'command', command: 'pwd', cwd: cloneOf(f) });
        const submit = m.mcpToolCallItem({ id: 'submit', tool: 'submit', args: {} });
        return {
          'turn/start': {
            then: [
              { notify: begin() },
              { notify: m.itemStarted(THREAD, TURN, command) },
              { notify: m.itemCompleted(THREAD, TURN, { ...command, status: 'completed', exitCode: 0 }) },
              { notify: m.itemStarted(THREAD, TURN, submit) },
              {
                notify: m.itemCompleted(
                  THREAD,
                  TURN,
                  m.mcpToolCallItem({
                    id: submit.id,
                    tool: 'submit',
                    args: {},
                    status: 'completed',
                    result: 'submission pending',
                  }),
                ),
              },
              { notify: finish() },
            ],
          },
        };
      },
      { config: { timings: { continuationWait: 100 } } },
    );
    expect(await controller.start(f.spec({ vendor: 'codex' }))).toEqual({ started: true });
    await waitFor(() => turnsEnded(f).length === 1);
    expect(f.events('attempt.activity').map((event) => event.data)).toEqual([
      { kind: 'tool', summary: 'exec_command: pwd' },
      { kind: 'tool', summary: 'mcp__agflow__submit: {}' },
      { kind: 'turn', summary: 'turn completed with 2 tool calls' },
    ]);
    // Keep the live session beyond the continuation deadline: the successful terminal must suppress it.
    await Bun.sleep(400);
    expect(requests(bin, 'turn/start')).toHaveLength(1);
    expect(controller.facts()).toMatchObject({ phase: 'idle', turns: 1, continuations: 0 });
    await stop(controller);
  });

  test('deliver steers the current turn and reports the hub message id through acknowledgement', async () => {
    const { f, bin, controller } = await setup(() => ({
      'turn/steer': { then: [{ notify: finish() }] },
    }));
    expect(await controller.start(f.spec({ vendor: 'codex' }))).toEqual({ started: true });
    await waitFor(() => controller.phase === 'turn');
    const message = { messageId: 42, authority: 'person' as const, text: 'Also update the README.' };
    expect(await controller.deliver({ fence: FENCE, messages: [message], more: 0 })).toEqual({ ok: true });
    const acknowledged = await waitFor(() => f.events('attempt.acknowledged')[0]);
    const delivered = f.events('attempt.delivered')[0]!;
    for (const event of [delivered, acknowledged]) {
      expect(event).toMatchObject({ attemptId: ATTEMPT, fence: FENCE, data: { messageIds: [42] } });
    }
    expect(delivered.seq).toBeLessThan(acknowledged.seq);
    expect(f.events('attempt.delivered')).toHaveLength(1);
    expect(f.events('attempt.acknowledged')).toHaveLength(1);
    expect(requests(bin, 'turn/steer').map((request) => request.params)).toEqual([
      { threadId: THREAD, expectedTurnId: TURN, input: input(message.text) },
    ]);
    expect(requests(bin, 'turn/start')).toHaveLength(1);
    await stop(controller);
  });

  test('npm install relays the manifest diff and applies an approval only once', async () => {
    const requestId = 'install-approval';
    const { f, bin, controller } = await setup(
      (f) => {
        const item = m.commandExecutionItem({ id: 'install', command: 'npm install', cwd: cloneOf(f) });
        return {
          'turn/steer': {
            then: [
              { notify: m.itemStarted(THREAD, TURN, item) },
              {
                request: m.commandApprovalRequest({ threadId: THREAD, turnId: TURN, item, id: requestId }),
                afterAnswer: [
                  { notify: m.serverRequestResolved(THREAD, requestId) },
                  { notify: m.itemCompleted(THREAD, TURN, { ...item, status: 'completed', exitCode: 0 }) },
                  { notify: finish() },
                ],
              },
            ],
          },
        };
      },
      { files: { 'package.json': '{"dependencies":{}}\n' } },
    );
    expect(await controller.start(f.spec({ vendor: 'codex' }))).toEqual({ started: true });
    await waitFor(() => controller.phase === 'turn');
    writeFileSync(join(cloneOf(f), 'package.json'), '{"dependencies":{"left-pad":"1.3.0"}}\n');
    expect(
      await controller.deliver({
        fence: FENCE,
        messages: [{ messageId: 51, authority: 'person', text: 'Install the changed dependencies.' }],
        more: 0,
      }),
    ).toEqual({ ok: true });
    const requested = await waitFor(() => f.events('approval.requested')[0]);
    expect(requested).toMatchObject({ attemptId: ATTEMPT, fence: FENCE, data: { kind: 'command' } });
    expect(requested.data.approvalId).toMatch(/^[0-9a-f-]{36}$/);
    expect(requested.data.approvalId).not.toBe(requestId);
    expect(requested.data.detail.command).toContain('npm install');
    expect(requested.data.detail.manifestDiff).toContain('package.json');
    expect(requested.data.detail.manifestDiff).toContain('-{"dependencies":{}}');
    expect(requested.data.detail.manifestDiff).toContain('+{"dependencies":{"left-pad":"1.3.0"}}');
    const decision = {
      fence: FENCE,
      approvalId: requested.data.approvalId,
      decision: 'approve' as const,
      reason: null,
    };
    expect(await controller.decideApproval(decision)).toEqual({ applied: true });
    expect(await controller.decideApproval(decision)).toEqual({ applied: false });
    await waitFor(() => turnsEnded(f).length === 1);
    expect(readCodexRecord(bin)[0]!.answers.filter((answer) => answer.id === requestId)).toEqual([
      { id: requestId, result: { decision: 'accept' }, at: expect.any(Number) },
    ]);
    expect(f.events('approval.voided')).toEqual([]);
    await stop(controller);
  });

  test('a peer crash voids its pending approval before reporting attempt.exited', async () => {
    const requestId = 'pending-approval';
    const { f, bin, controller } = await setup((f) => ({
      'turn/start': {
        then: [
          { notify: begin() },
          {
            request: m.commandApprovalRequest({
              threadId: THREAD,
              turnId: TURN,
              item: m.commandExecutionItem({ id: 'command', command: 'rm -rf build', cwd: cloneOf(f) }),
              id: requestId,
            }),
          },
        ],
      },
      // The test observes the pending approval before asking the peer to crash.
      'turn/steer': { then: [{ delayMs: 30 }, { crash: { signal: 'SIGKILL' } }] },
    }));
    expect(await controller.start(f.spec({ vendor: 'codex' }))).toEqual({ started: true });
    const requested = await waitFor(() => f.events('approval.requested')[0]);
    expect(readCodexRecord(bin)[0]!.answers).toEqual([]);
    expect(
      await controller.deliver({
        fence: FENCE,
        messages: [{ messageId: 61, authority: 'person', text: 'Check progress.' }],
        more: 0,
      }),
    ).toEqual({ ok: true });
    const exited = await waitFor(() => f.events('attempt.exited')[0]);
    const voided = f.events('approval.voided');
    expect(voided).toHaveLength(1);
    expect(voided[0]).toMatchObject({
      attemptId: ATTEMPT,
      fence: FENCE,
      data: { approvalId: requested.data.approvalId },
    });
    expect(requested.seq).toBeLessThan(voided[0]!.seq);
    expect(voided[0]!.seq).toBeLessThan(exited.seq);
    expect(exited.data).toMatchObject({ code: null, signal: 'SIGKILL', stoppedBy: 'none' });
    expect(
      await controller.decideApproval({
        fence: FENCE,
        approvalId: requested.data.approvalId,
        decision: 'approve',
        reason: null,
      }),
    ).toEqual({ applied: false });
    await controller.settled();
  });

  test('cleanup_attempt deletes the recorded thread through the pinned app-server', async () => {
    const { f, bin, controller } = await setup();
    writeCodexShim(bin, [
      scenario({ 'turn/start': { then: [{ notify: begin() }, { notify: finish() }] } }),
      scenario({ 'thread/delete': { result: {} } }),
    ]);
    expect(await controller.start(f.spec({ vendor: 'codex' }))).toEqual({ started: true });
    const spawned = await waitFor(() => f.events('attempt.spawned')[0]);
    await waitFor(() => turnsEnded(f).length === 1);
    await stop(controller);
    expect(await controller.cleanup()).toEqual({ ok: true });
    const runs = readCodexRecord(bin);
    expect(runs).toHaveLength(2);
    expect(
      runs[1]!.requests.filter((request) => request.method === 'thread/delete').map((request) => request.params),
    ).toEqual([{ threadId: spawned.data.sessionRef }]);
    expect(runs[1]!.exit).toMatchObject({ code: 0, signal: null });
    expect(existsSync(cloneOf(f))).toBe(false);
    expect(f.store.get(ATTEMPT)?.clone).toBeNull();
  });
});
```

- [ ] **Step 2: Check it**

Run: `bun test packages/runner/test/codex/controller-contract.test.ts && bun test && bun run typecheck`
Expected: the task's tests pass (7 pass); then the whole suite passes (`0 fail`) and `tsc` exits 0.

This test passes at once: it pins what Tasks 12-19 built. `CodexAdapter.start` must create the homes before launching, or the controller receives `cannot start the agent: working directory missing: <fixture home>/runner/homes/codex-user`. The adapter gets `env: { AGFLOW_TEST: '1' }`, so the fixture's `test.skipAuthChecks` applies, and `requestTimeoutMs: 1000`.

- [ ] **Step 3: Commit**

```bash
git add -A 'packages/runner/test/codex/controller-contract.test.ts'
git commit -m 'M2E Task 20: Contract check: the AttemptController drives the Codex adapter' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

### Task 21: Real-binary harness: start checks, tool surface and the bridge (local)

The section 15 adapter tests against the real pinned app-server, with zero model use. `startCodexHarness` builds a scratch `AGFLOW_HOME` whose `vendor/codex/0.159.2` links the located version directory (so `codex-code-mode-host` and `rg` sit beside the binary), the runner's Codex and codex-user homes, M2b's in-process hub with a runner attempt and its agent token behind a recording front (X-26), the scripted provider, the refusing proxy as `HTTP_PROXY`, `HTTPS_PROXY` and `ALL_PROXY`, and a clone of a local origin with `.agflow/run`. The real bridge runs by path as `bun --no-env-file --config=/dev/null <repo>/packages/cli/src/main.ts mcp --vendor codex --runner`. Each launch carries `BRIDGE_TOOL_NAMES` for its role. `start.test.ts` covers the start checks with a committed project config for both trust values, the recorded tool surface and the tools note, a Code Mode command turn, the bridge, a bridge without `AGFLOW_ROLE`, a planted `bunfig.toml` preload and `.env`, and the proxy.

**Files:**
- Test: `packages/runner/test/codex/fixtures/tool-surface.json`
- Test: `packages/runner/test/codex/real/harness.ts`
- Test: `packages/runner/test/codex/real/start.test.ts`

- [ ] **Step 1: Make the change**

**File:** `packages/runner/test/codex/fixtures/tool-surface.json` (new)

```json
{
  "model": "gpt-6.1-sol",
  "namespaces": [
    {
      "name": "functions",
      "tools": ["exec", "wait", "request_user_input", "request_user_input_async"]
    },
    {
      "name": "clock",
      "tools": ["sleep"]
    },
    {
      "name": "collaboration",
      "tools": ["followup_task", "interrupt_agent", "list_agents", "send_message", "spawn_agent", "wait_agent"]
    }
  ],
  "described": [
    "apply_patch",
    "create_goal",
    "exec_command",
    "get_goal",
    "list_mcp_resource_templates",
    "list_mcp_resources",
    "read_mcp_resource",
    "update_goal",
    "view_image",
    "write_stdin",
    "clock__curr_time"
  ],
  "available": [
    "apply_patch",
    "clock__curr_time",
    "create_goal",
    "exec_command",
    "get_goal",
    "list_mcp_resource_templates",
    "list_mcp_resources",
    "mcp__agflow__ack_messages",
    "mcp__agflow__check_inbox",
    "mcp__agflow__declare_blocked",
    "mcp__agflow__declare_impossible",
    "mcp__agflow__get_brief",
    "mcp__agflow__get_goal",
    "mcp__agflow__get_task",
    "mcp__agflow__hello",
    "mcp__agflow__list_tasks",
    "mcp__agflow__prepare_dependencies",
    "mcp__agflow__release_task",
    "mcp__agflow__report_progress",
    "mcp__agflow__search",
    "mcp__agflow__send_message",
    "mcp__agflow__submit",
    "mcp__agflow__write_handoff",
    "read_mcp_resource",
    "update_goal",
    "view_image",
    "write_stdin"
  ]
}
```

**File:** `packages/runner/test/codex/real/harness.ts` (new)

```ts
// The local real-binary harness for the Codex adapter (design 15, 15.1, 10): the pinned app-server runs against the
// scripted Responses provider with zero model use, behind the refusing proxy, with scratch homes only. It serves
// M2b's in-process hub, gives every attempt a hub attempt, its agent token and a clone of a local origin with
// .agflow/run, and starts sessions through the real CodexAdapter, whose bridge is the real `agflow mcp --runner`.
// The suites under this directory run only with AGFLOW_SMOKE=1 and a located pin (root script smoke:codex).
import type { Attempt } from '@agflow/core';
import { type OriginRepo, gitIn, originRepo, type RefusingProxy, startRefusingProxy } from '@agflow/testkit';
import {
  codexTestConfig,
  type ResponsesHandler,
  type ResponsesServer,
  startResponsesServer,
} from '@agflow/testkit/src/codex/index';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { BRIDGE_TOOL_NAMES } from '../../../src/adapters/bridge-tools';
import { CODEX_VERSION, type CodexAdapter, createCodexAdapter, findCodexBinary } from '../../../src/adapters/codex';
import type { FindCodexOptions } from '../../../src/adapters/codex/binary';
import type { CodexSession } from '../../../src/adapters/codex/session';
import type { AgentEvent, AgentLaunch } from '../../../src/adapters/types';
import { type RunnerConfig, RunnerConfigSchema } from '../../../src/config';
import { bridgeEnvOf, buildAgentEnv } from '../../../src/env';
import { type RunnerPaths, runnerPaths } from '../../../src/paths';
import { profileOf } from '../../../src/profile';
import { removeAgentTools, type RunDir, withWorkingDirectory, writeRunDir } from '../../../src/run-dir';
import { vendorBinary } from '../../../src/vendor/pins';
import { addRunnerAttempt, mintAgentToken, startTestHub, type TestHub } from '../../hub-fixture';

/** The pinned binary when the local suites may run: AGFLOW_SMOKE=1 and findCodexBinary finds the pin. */
export async function smokeCodexBinary(options: FindCodexOptions = {}): Promise<string | null> {
  const env = options.env ?? process.env;
  return env.AGFLOW_SMOKE === '1' ? findCodexBinary({ env, home: options.home }) : null;
}

/** The agflow CLI the bridge runs from, as the runner's selfCommand gives it in a checkout (with its two Bun flags). */
const CLI_MAIN = join(import.meta.dir, '..', '..', '..', '..', 'cli', 'src', 'main.ts');

const PROJECT = 'codex-real';

/**
 * A committed project config: every start and resume runs with one, trusted or not, and must see no configWarning
 * (a thread started in a clone with .codex/ once failed on Codex's startup warning). Its effort is not the default
 * ('low' for the pinned slug with this provider), so a request shows whether the thread loaded it.
 */
export const PROJECT_CODEX_CONFIG = '# The project\'s own Codex settings.\nmodel_reasoning_effort = "high"\n';

/** A committed repo skill: an untrusted thread still loads it (design 9.2), and the skills check must allow it. */
export const REPO_SKILL_MARKER = 'REPO-SKILL-MARKER';

export const DEFAULT_ORIGIN_FILES: Record<string, string> = {
  'README.md': '# Codex real-binary fixture\n',
  'src/app.txt': 'version 1\n',
  '.codex/config.toml': PROJECT_CODEX_CONFIG,
  '.codex/skills/fixture-skill/SKILL.md': [
    '---',
    'name: fixture-skill',
    `description: Marker skill ${REPO_SKILL_MARKER} for the real-binary checks.`,
    '---',
    '',
  ].join('\n'),
};

export interface CodexHarnessOptions {
  /** The origin's first commit; DEFAULT_ORIGIN_FILES by default. */
  files?: Record<string, string>;
  /** Answers the provider's requests; tests may also call provider.setHandler later. */
  handler?: ResponsesHandler;
  streamIdleTimeoutMs?: number;
}

export interface HarnessAttemptOptions {
  role?: 'worker' | 'lead';
  projectConfigVerified?: boolean;
  /** Changes the bridge's environment as the launch gives it, to drop a required variable, say. */
  bridgeEnv?: (env: Record<string, string>) => Record<string, string>;
  /** Changes the launch's agent environment (launch.env) after it is built. */
  agentEnv?: (env: Record<string, string>) => Record<string, string>;
  brief?: string;
  firstPrompt?: string;
}

export interface HarnessAttempt {
  /** The hub's attempt, running on a runner of the owner's. */
  attempt: Attempt;
  token: string;
  /** The clone's real path, on the task branch. */
  clone: string;
  runDir: RunDir;
  launch: AgentLaunch;
  /** The pids the adapter registered, in order. */
  registered: number[];
  /** Starts a session, or with sessionRef resumes that thread, through the adapter. */
  start(resume?: string): Promise<CodexSession>;
}

export interface CodexHarness {
  bin: string;
  /** The test's own temporary directory, outside every clone. */
  dir: string;
  paths: RunnerPaths;
  config: RunnerConfig;
  adapter: CodexAdapter;
  hub: TestHub;
  /** Every request agents' bridges made to the hub, as 'METHOD /path', in arrival order. */
  hubRequests: string[];
  provider: ResponsesServer;
  proxy: RefusingProxy;
  origin: OriginRepo;
  attempt(options?: HarnessAttemptOptions): Promise<HarnessAttempt>;
  /** Closes the sessions it started, then the provider, the hub and the proxy, and removes its directories. */
  close(): Promise<void>;
}

/** The runner's own environment as an adapter sees it: AGFLOW_TEST on, never an agflow or Codex variable. */
function adapterEnv(): Record<string, string | undefined> {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith('AGFLOW_') && !name.startsWith('CODEX_')),
    ),
    AGFLOW_TEST: '1',
  };
}

export async function startCodexHarness(bin: string, options: CodexHarnessOptions = {}): Promise<CodexHarness> {
  const cleanups: (() => Promise<void> | void)[] = [];
  const sessions: CodexSession[] = [];
  const close = async () => {
    for (const session of sessions.splice(0)) await session.close().catch(() => {});
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  };
  try {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agflow-codex-real-')));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const paths = runnerPaths(join(dir, 'agflow'));
    // The located version directory, so Code Mode's host and the bundled rg sit beside the binary (design 9.1, 15).
    const pinned = join(paths.runner, vendorBinary('codex', CODEX_VERSION));
    mkdirSync(dirname(dirname(dirname(pinned))), { recursive: true });
    symlinkSync(dirname(dirname(bin)), dirname(dirname(pinned)));

    const proxy = await startRefusingProxy();
    cleanups.push(() => proxy.close());
    const provider = await startResponsesServer({ handler: options.handler });
    cleanups.push(() => provider.close());
    const origin = await originRepo(options.files ?? DEFAULT_ORIGIN_FILES);
    cleanups.push(() => origin.remove());
    const hub = startTestHub({ config: { projectName: PROJECT, projectRepo: origin.path } });
    cleanups.push(() => hub.stop());
    // Agents reach the hub through a recording front, so a test sees which bridge calls reached it.
    const hubRequests: string[] = [];
    const front = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        hubRequests.push(`${request.method} ${url.pathname}`);
        const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer();
        return fetch(`${hub.url}${url.pathname}${url.search}`, {
          method: request.method,
          headers: request.headers,
          body,
        });
      },
    });
    cleanups.push(() => front.stop(true));

    const config = RunnerConfigSchema.parse({
      runnerKey: 'codex-real-runner',
      machineId: 'codex-real-machine',
      name: 'codex-real',
      capturedPath: '/usr/bin:/bin:/usr/sbin:/sbin',
      // Every external connection meets the refusing proxy; the hub, the provider and the bridge are on loopback.
      connectivity: {
        HTTP_PROXY: proxy.url,
        HTTPS_PROXY: proxy.url,
        ALL_PROXY: proxy.url,
        NO_PROXY: '127.0.0.1,localhost',
      },
      test: {
        codexConfig: codexTestConfig(provider.url, { streamIdleTimeoutMs: options.streamIdleTimeoutMs }),
        skipAuthChecks: true,
      },
    });
    const env = adapterEnv();
    const adapter = createCodexAdapter({ config, paths, env });

    const attempt = async (input: HarnessAttemptOptions = {}): Promise<HarnessAttempt> => {
      const started = addRunnerAttempt(hub.ctx, { owner: hub.owner, vendor: 'codex' });
      const hubAttempt = started.attempt;
      const token = mintAgentToken(hub.ctx, hubAttempt);
      const branch = started.task.branch ?? `agflow/${hubAttempt.taskId}`;
      const target = paths.clone(PROJECT, hubAttempt.id);
      mkdirSync(dirname(target), { recursive: true });
      await gitIn(dirname(target), ['clone', '--quiet', origin.path, target]);
      await gitIn(target, ['checkout', '--quiet', '-b', branch]);
      const clone = realpathSync(target);
      const brief = withWorkingDirectory(input.brief ?? `You work on ${hubAttempt.taskId} as ${hubAttempt.id}.`, clone);
      const runDir = writeRunDir({
        clone,
        tools: paths.agentTools(PROJECT, hubAttempt.id),
        taskPack: `# ${hubAttempt.taskId}\n\nThe task for the real-binary checks.\n`,
        brief,
        identity: config.commitIdentity,
      });
      const role = input.role ?? 'worker';
      const spec = { attemptId: hubAttempt.id, role, agentToken: token, hubUrl: `http://127.0.0.1:${front.port}` };
      const agentEnv = buildAgentEnv({
        vendor: 'codex',
        spec,
        clone,
        tools: runDir.tools,
        tmpDir: null,
        config,
        paths,
        base: env,
        env,
      });
      const registered: number[] = [];
      const launch: AgentLaunch = {
        attemptId: hubAttempt.id,
        role,
        model: config.models.codex[role],
        cliVersion: CODEX_VERSION,
        clone,
        baseCheckout: null,
        projectConfigVerified: input.projectConfigVerified ?? true,
        tmpDir: runDir.tmp,
        env: input.agentEnv ? input.agentEnv(agentEnv) : agentEnv,
        bridge: {
          command: process.execPath,
          args: ['--no-env-file', '--config=/dev/null', CLI_MAIN, 'mcp', '--vendor', 'codex', '--runner'],
          env: (input.bridgeEnv ?? ((given) => given))(bridgeEnvOf(agentEnv)),
          tools: BRIDGE_TOOL_NAMES[role],
        },
        profile: profileOf(config),
        brief,
        firstPrompt: input.firstPrompt ?? `Work on ${hubAttempt.taskId}.`,
        resume: null,
        logFile: paths.attemptLog(hubAttempt.id),
        registerProcess: (pid) => {
          registered.push(pid);
        },
      };
      cleanups.push(() => {
        // Read-only, as writeRunDir leaves it: the directory's own removal makes it writable first.
        removeAgentTools(runDir.tools);
        // A session a test killed or never closed leaves its group behind.
        for (const pid of registered) {
          try {
            process.kill(-pid, 'SIGKILL');
          } catch {
            // Already gone.
          }
        }
      });
      return {
        attempt: hubAttempt,
        token,
        clone,
        runDir,
        launch,
        registered,
        async start(resume) {
          const session = (await adapter.start({
            ...launch,
            resume: resume === undefined ? null : { sessionRef: resume },
          })) as CodexSession;
          sessions.push(session);
          return session;
        },
      };
    };

    return { bin, dir, paths, config, adapter, hub, hubRequests, provider, proxy, origin, attempt, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/** A session's events as they arrive, read by one pump, with waits for the next matching one. */
export class EventLog {
  readonly events: AgentEvent[] = [];
  readonly done: Promise<void>;
  private readonly waiters = new Set<() => void>();
  // Set by the pump itself, before it wakes the waiters: a wait on an ended log fails at once.
  private ended = false;

  constructor(source: AsyncIterable<AgentEvent>) {
    this.done = (async () => {
      for await (const event of source) {
        this.events.push(event);
        for (const wake of [...this.waiters]) wake();
      }
      this.ended = true;
      for (const wake of [...this.waiters]) wake();
    })();
  }

  of<T extends AgentEvent['type']>(type: T): Extract<AgentEvent, { type: T }>[] {
    return this.events.filter((event): event is Extract<AgentEvent, { type: T }> => event.type === type);
  }

  /** The first event from index `from` on that matches, waiting up to ms for it. */
  async next<T extends AgentEvent['type']>(
    type: T,
    options: { from?: number; ms?: number; where?: (event: Extract<AgentEvent, { type: T }>) => boolean } = {},
  ): Promise<Extract<AgentEvent, { type: T }>> {
    const deadline = Date.now() + (options.ms ?? 30_000);
    for (;;) {
      const found = this.events
        .slice(options.from ?? 0)
        .find(
          (event): event is Extract<AgentEvent, { type: T }> =>
            event.type === type && (options.where?.(event as Extract<AgentEvent, { type: T }>) ?? true),
        );
      if (found) return found;
      const left = deadline - Date.now();
      if (this.ended || left <= 0) {
        throw new Error(`no ${type} event${this.ended ? ' before the events ended' : ''}: ${this.summary()}`);
      }
      await new Promise<void>((resolve) => {
        const wake = () => {
          this.waiters.delete(wake);
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(wake, left);
        this.waiters.add(wake);
      });
    }
  }

  /** The event types so far, for failure messages. */
  summary(): string {
    return this.events.map((event) => event.type).join(', ') || '(none)';
  }
}
```

**File:** `packages/runner/test/codex/real/start.test.ts` (new)

```ts
// The real pinned app-server at start (design 15, 9.2, 10): the start checks, the tool surface the pinned slug offers,
// a Code Mode command and the real bridge, all against the scripted provider with zero model use.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { handoffWritten } from '@agflow/hub/src/handoff';
import { reply, rules, toolSurface } from '@agflow/testkit/src/codex/index';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CODEX_VERSION } from '../../../src/adapters/codex';
import { codexToolsNote } from '../../../src/adapters/codex/config';
import { until } from '../session-fixture';
import {
  type CodexHarness,
  DEFAULT_ORIGIN_FILES,
  EventLog,
  REPO_SKILL_MARKER,
  smokeCodexBinary,
  startCodexHarness,
} from './harness';

setDefaultTimeout(120_000);

const bin = await smokeCodexBinary();
const fixture = JSON.parse(readFileSync(join(import.meta.dir, '..', 'fixtures', 'tool-surface.json'), 'utf8')) as {
  model: string;
  namespaces: { name: string; tools: string[] }[];
  described: string[];
  available: string[];
};
/** The agflow tools the worker's bridge serves, as the pinned slug offers them. */
const agflowTools = fixture.available.filter((name) => name.startsWith('mcp__agflow__'));

const dirs: string[] = [];
let h: CodexHarness | null = null;
afterEach(async () => {
  try {
    await h?.close();
  } finally {
    h = null;
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  }
});

/** A directory outside every clone and the harness, removed after the test. */
function scratchDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

/** The text a Code Mode exec call returned to the model, after Codex's "Output:" header. */
function execText(output: string): string {
  return output.slice(output.indexOf('Output:\n') + 'Output:\n'.length).trim();
}

test('the local suites run only with AGFLOW_SMOKE=1 and a located pin', async () => {
  const dir = scratchDir('agflow-codex-smoke-gate-');
  const stub = join(dir, 'codex');
  writeFileSync(stub, `#!/bin/sh\necho "codex-cli ${CODEX_VERSION}"\n`, { mode: 0o755 });
  // An empty home: no runner vendor directory to fall back on.
  const home = join(dir, 'home');
  mkdirSync(home);
  expect(await smokeCodexBinary({ env: { AGFLOW_SMOKE: '1', AGFLOW_CODEX_BIN: stub }, home })).toBe(stub);
  expect(await smokeCodexBinary({ env: { AGFLOW_SMOKE: '0', AGFLOW_CODEX_BIN: stub }, home })).toBeNull();
  expect(await smokeCodexBinary({ env: { AGFLOW_CODEX_BIN: stub }, home })).toBeNull();
  expect(await smokeCodexBinary({ env: { AGFLOW_SMOKE: '1' }, home })).toBeNull();
});

describe.skipIf(bin === null)('the real app-server at start', () => {
  for (const projectConfigVerified of [true, false]) {
    test(`start and resume with a committed .codex/config.toml (${projectConfigVerified ? 'trusted' : 'untrusted'}) pass the checks without a configWarning`, async () => {
      h = await startCodexHarness(bin!);
      const a = await h.attempt({ projectConfigVerified });
      expect(existsSync(join(a.clone, '.codex', 'config.toml'))).toBe(true);
      // A configWarning, or an MCP server or skill the checks refuse, would make start() reject.
      const session = await a.start();
      const log = new EventLog(session.events);
      expect(await log.next('started')).toEqual({
        type: 'started',
        sessionRef: session.sessionRef,
        model: a.launch.model,
        cliVersion: a.launch.cliVersion,
        permissionMode: 'on-request',
      });
      await log.next('turn_ended');
      const untrusted = projectConfigVerified ? [] : [expect.stringContaining('the thread runs untrusted')];
      expect(log.of('warning').map((event) => event.text)).toEqual(untrusted);
      // Only a trusted thread reads the project's config (effort 'high'); an untrusted one keeps the default.
      const reasoning = { effort: projectConfigVerified ? 'high' : 'low' };
      expect(h.provider.requests[0]).toMatchObject({
        model: a.launch.model,
        threadId: session.sessionRef,
        body: { reasoning },
      });
      // The repo skill loads either way (design 9.2), and the skills check allowed it.
      expect(JSON.stringify(h.provider.requests[0]!.body.input)).toContain(REPO_SKILL_MARKER);
      // Developer instructions retain the brief and role tools across compaction and resume.
      expect(h.provider.requests[0]!.instructions).toContain(a.launch.brief);
      expect(h.provider.requests[0]!.instructions).toContain(codexToolsNote(a.launch.bridge.tools));
      expect(h.provider.requests[0]!.lastUserText).toBe(a.launch.firstPrompt);
      // web_search 'disabled' is checked only through the absence of a configWarning (design 15): start() rejects on
      // one, and the warnings above hold only the untrusted note.
      await session.close();

      const resumed = await a.start(session.sessionRef);
      const resumedLog = new EventLog(resumed.events);
      expect(resumed.sessionRef).toBe(session.sessionRef);
      expect(await resumedLog.next('started')).toMatchObject({ sessionRef: session.sessionRef });
      // A resume sends no prompt of its own. The resumed thread applies the same trust: its next request carries the
      // same effort.
      expect(h.provider.requests).toHaveLength(1);
      await resumed.send({ id: 'msg-1', text: 'Carry on.', authority: 'person' });
      await resumedLog.next('turn_ended');
      expect(h.provider.requests).toHaveLength(2);
      expect(h.provider.requests[1]).toMatchObject({ threadId: session.sessionRef, body: { reasoning } });
      expect(h.provider.requests[1]!.instructions).toContain(codexToolsNote(a.launch.bridge.tools));
      await resumed.close();
      await resumedLog.done;
      expect(resumedLog.of('warning').map((event) => event.text)).toEqual(untrusted);
    });
  }

  test('the tool surface of the pinned slug equals tool-surface.json', async () => {
    h = await startCodexHarness(bin!, {
      handler: rules([
        { toolOutputs: 0, reply: reply.code('text(JSON.stringify(ALL_TOOLS.map((tool) => tool.name)));') },
        { toolOutputs: 1, reply: reply.text('Listed the tools.') },
      ]),
    });
    const session = await (await h.attempt()).start();
    const log = new EventLog(session.events);
    await log.next('turn_ended');
    const [first, second] = h.provider.requests;
    const surface = toolSurface(first!);
    const recorded = {
      model: first!.model,
      namespaces: surface?.namespaces,
      described: surface?.nested,
      available: JSON.parse(execText(second!.toolOutputs[0]!.output)),
    };
    expect(recorded).toEqual(fixture);
    // Code Mode: one freeform exec, and the shell, patch and agflow tools nested inside it. The agflow tools are
    // deferred: not described in exec's text, but on the tools object and in ALL_TOOLS.
    expect(fixture.namespaces[0]?.tools).toContain('exec');
    expect(fixture.available).toEqual(expect.arrayContaining(['exec_command', 'write_stdin', 'apply_patch']));
    expect(agflowTools).toEqual(
      [
        'ack_messages',
        'check_inbox',
        'declare_blocked',
        'declare_impossible',
        'get_brief',
        'get_goal',
        'get_task',
        'hello',
        'list_tasks',
        'prepare_dependencies',
        'release_task',
        'report_progress',
        'search',
        'send_message',
        'submit',
        'write_handoff',
      ].map((name) => `mcp__agflow__${name}`),
    );
    // The persistent tools note names exactly the available bridge tools, with the MCP prefix.
    const lines = (first!.instructions ?? '').split('\n');
    const note = lines.find((line) => line.startsWith('Your agflow tools are ')) ?? '';
    const named = note.slice('Your agflow tools are '.length, note.indexOf('. Code Mode does not describe them'));
    expect(named.split(', ').sort()).toEqual(agflowTools);
  });

  test('a Code Mode command turn reports the inner command, then a completed turn', async () => {
    h = await startCodexHarness(bin!, {
      handler: rules([
        { toolOutputs: 0, reply: reply.shell({ cmd: 'echo made > made.txt && cat made.txt' }) },
        { toolOutputs: 1, reply: reply.text('The command ran.') },
      ]),
    });
    const a = await h.attempt();
    const session = await a.start();
    const log = new EventLog(session.events);
    const ended = await log.next('turn_ended');
    const started = log.of('tool_started');
    expect(started).toEqual([
      {
        type: 'tool_started',
        toolId: expect.any(String),
        name: 'exec_command',
        input: 'echo made > made.txt && cat made.txt',
        command: 'echo made > made.txt && cat made.txt',
      },
    ]);
    expect(log.of('tool_ended')).toEqual([
      {
        type: 'tool_ended',
        toolId: started[0]!.toolId,
        ok: true,
        denied: false,
        terminal: null,
        hubUnreachable: false,
      },
    ]);
    expect(ended).toEqual({
      type: 'turn_ended',
      outcome: 'completed',
      toolCalls: 1,
      error: null,
      errorKind: null,
    });
    expect(readFileSync(join(a.clone, 'made.txt'), 'utf8')).toBe('made\n');
    expect(execText(h.provider.requests[1]!.toolOutputs[0]!.output)).toContain('made');
  });

  test('the bridge: hello needs no hub call, write_handoff reaches the hub, and neither asks for approval', async () => {
    h = await startCodexHarness(bin!);
    const a = await h.attempt();
    const taskId = a.attempt.taskId!;
    h.provider.setHandler(
      rules([
        { toolOutputs: 0, reply: reply.mcp({ tool: 'hello', args: {} }) },
        // Held, so the hub's requests can be read between the two calls.
        {
          toolOutputs: 1,
          reply: reply.hang(reply.mcp({ tool: 'write_handoff', args: { task_id: taskId, note: 'Halfway.' } })),
        },
        { toolOutputs: 2, reply: reply.text('Handed off.') },
      ]),
    );
    const session = await a.start();
    const log = new EventLog(session.events);
    const helloEnded = await log.next('tool_ended');
    await until(() => h!.provider.requests.length === 2);
    expect(execText(h.provider.requests[1]!.toolOutputs[0]!.output)).toContain(
      `You are already connected to agflow as attempt ${a.attempt.id}`,
    );
    // The bridge calls the hub neither at startup nor for hello.
    expect(h.hubRequests).toEqual([]);
    expect(h.provider.release()).toBe(1);
    const ended = await log.next('turn_ended');
    expect(ended).toMatchObject({ outcome: 'completed', toolCalls: 2 });
    expect(log.of('tool_started').map((event) => [event.name, event.command])).toEqual([
      ['mcp__agflow__hello', null],
      ['mcp__agflow__write_handoff', null],
    ]);
    expect(helloEnded).toMatchObject({ ok: true, terminal: null, hubUnreachable: false });
    expect(log.of('tool_ended')[1]).toMatchObject({ ok: true, denied: false, terminal: 'handoff' });
    expect(h.hubRequests).toEqual([`POST /api/tasks/${taskId}/handoff`]);
    expect(handoffWritten(h.hub.ctx, a.attempt)).toBe(true);
    expect(log.of('approval_request')).toEqual([]);
    expect(log.of('waiting_approval')).toEqual([]);
  });

  for (const projectConfigVerified of [true, false]) {
    test(`a committed bunfig.toml preload and .env never reach the bridge (${projectConfigVerified ? 'trusted' : 'untrusted'})`, async () => {
      // The bridge runs outside the sandbox with the agent token, and Bun loads both from its working directory: it
      // must not start in the clone.
      const marker = join(scratchDir('agflow-planted-bunfig-'), 'preload-ran');
      h = await startCodexHarness(bin!, {
        files: {
          ...DEFAULT_ORIGIN_FILES,
          'bunfig.toml': 'preload = ["./planted.ts"]\n',
          'planted.ts': `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(marker)}, 'ran\\n');\n`,
          '.env': 'AGFLOW_PLANTED_ENV=from-clone\n',
        },
        handler: rules([
          { toolOutputs: 0, reply: reply.mcp({ tool: 'hello', args: {} }) },
          { toolOutputs: 1, reply: reply.text('Said hello.') },
        ]),
      });
      const a = await h.attempt({ projectConfigVerified });
      expect(existsSync(join(a.clone, 'bunfig.toml'))).toBe(true);
      const session = await a.start();
      const log = new EventLog(session.events);
      expect(await log.next('turn_ended')).toMatchObject({ outcome: 'completed', toolCalls: 1 });
      expect(execText(h.provider.requests[1]!.toolOutputs[0]!.output)).toContain(
        `You are already connected to agflow as attempt ${a.attempt.id}`,
      );
      await session.close();
      await log.done;
      // A resume starts the bridge again.
      const resumed = await a.start(session.sessionRef);
      const resumedLog = new EventLog(resumed.events);
      await resumedLog.next('started');
      await resumed.close();
      await resumedLog.done;
      expect(existsSync(marker)).toBe(false);
    });
  }

  test('a bridge started without AGFLOW_ROLE makes thread/start fail and start() reject', async () => {
    h = await startCodexHarness(bin!);
    // Only the bridge's own variables reach it (env_vars): the app-server's AGFLOW_ROLE does not.
    const a = await h.attempt({ bridgeEnv: ({ AGFLOW_ROLE: _role, ...env }) => env });
    expect(a.launch.env.AGFLOW_ROLE).toBe('worker');
    const error = await a.start().then(
      () => null,
      (error: unknown) => error as Error,
    );
    expect(error?.message).toMatch(/^codex thread\/start failed: .*required MCP servers failed/);
    expect(a.registered).toHaveLength(1);
    expect(h.provider.requests).toEqual([]);
  });

  test('the refusing proxy granted no connection: no request left the machine', async () => {
    h = await startCodexHarness(bin!, {
      handler: rules([
        { toolOutputs: 0, reply: reply.shell({ cmd: 'printenv HTTPS_PROXY; git status --short' }) },
        { toolOutputs: 1, reply: reply.mcp({ tool: 'get_brief', args: {} }) },
        { toolOutputs: 2, reply: reply.text('Done.') },
      ]),
    });
    const session = await (await h.attempt()).start();
    const log = new EventLog(session.events);
    await log.next('turn_ended');
    await session.close();
    await log.done;
    // The proxy settings reached tool commands, and the bridge reached the loopback hub past the proxy.
    expect(execText(h.provider.requests[1]!.toolOutputs[0]!.output)).toContain(h.proxy.url);
    expect(h.hubRequests).toEqual(['GET /api/brief']);
    // Every external connection would have met the proxy, which refuses and records it: none was even tried.
    expect(h.proxy.refused).toEqual([]);
    expect(h.provider.requests.map((request) => request.unmatched)).toEqual([false, false, false]);
  });
});
```

- [ ] **Step 2: Check it**

Run: `AGFLOW_SMOKE=1 bun test packages/runner/test/codex/real/start.test.ts && bun test && bun run typecheck`
Expected: with the pin located, 10 pass and no skips; then the whole suite passes (`0 fail`; the local suites are skipped there) and `tsc` exits 0.

These tests skip unless `AGFLOW_SMOKE=1` and `findCodexBinary` finds the pin: export `AGFLOW_CODEX_BIN` (see the conventions); use the scratch provisioning commands in the conventions, including both binary exports, if the pins are not already available; keep the scratch install until all verification children exit. Codex talks only to the scripted provider on 127.0.0.1 with scratch homes, never a real model or the owner's `~/.codex`. They pass at once, because they pin Tasks 1-19 on the real binary. To see them work, remove `cwd: bridgeCwd` from `threadOverrides`: the planted-bunfig tests fail because the preload ran in the bridge; or force `trust_level: 'trusted'`: the untrusted start reports reasoning effort `high`. In 0.159.2 the agflow tools are deferred, on the `tools` object and in `ALL_TOOLS` but not in `exec`'s description, so `tool-surface.json` records both lists, and the test checks the note's names against the available `mcp__agflow__*` names. `web_search: 'disabled'` is checked only through the absence of a `configWarning` (design 15). Cleanup calls M2b's `removeAgentTools` first, because the agent tools directory is read-only. The start tests assert the brief and tools note in the first provider request's instructions, and that its lastUserText equals launch.firstPrompt. After resume, they assert that no automatic prompt is sent and that the next provider request's instructions contain the tools note. The tool-surface test compares the prefixed names in those instructions with the available `mcp__agflow__*` tools. Successful start and resume with no configWarning also check acceptance of `tool_timeout_sec` by 0.159.2.

- [ ] **Step 3: Commit**

```bash
git add -A 'packages/runner/test/codex/fixtures/tool-surface.json' 'packages/runner/test/codex/real/harness.ts' 'packages/runner/test/codex/real/start.test.ts'
git commit -m 'M2E Task 21: Real-binary harness: start checks, tool surface and the bridge (local)' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

### Task 22: Real-binary lifecycle: delivery, interrupt, resume and close (local)

The section 15 lifecycle cases on the real binary (design 9.2 Messages, 9.4, 7.4): delivery at rest and mid-turn; an agent message arriving as a `function_call_output` named `agent_message` in the `agflow` namespace, not as a user message; interrupt; a resume after SIGKILL of the process group; a resume of a thread that never ran a turn; a graceful close that also ends a background command; two starts at once on a fresh runner Codex home; and a 35 s command inside one `exec` call.

**Files:**
- Test: `packages/runner/test/codex/real/lifecycle.test.ts`

- [ ] **Step 1: Make the change**

**File:** `packages/runner/test/codex/real/lifecycle.test.ts` (new)

```ts
// The real pinned app-server's lifecycle (design 15, 9.2, 9.4, 7.4, 9.1): delivery at rest and mid-turn, agent
// messages, interrupt, resume after a kill and of a thread that never ran, the graceful close, concurrent starts on a
// fresh home and a command longer than exec_command's yield, all against the scripted provider with zero model use.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { reply, rules } from '@agflow/testkit/src/codex/index';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appServerArgs, appServerEnv, codexToolsNote, threadOverrides } from '../../../src/adapters/codex/config';
import { openAppServer } from '../../../src/adapters/codex/process';
import { vendorBinary } from '../../../src/vendor/pins';
import { alive, until } from '../session-fixture';
import { type CodexHarness, EventLog, type HarnessAttempt, smokeCodexBinary, startCodexHarness } from './harness';

setDefaultTimeout(120_000);

const bin = await smokeCodexBinary();
let h: CodexHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const HOLD = 'HOLD-THIS-TURN';

/** The provider's raw input items of a type, as Codex sent them. */
function inputItems(index: number, type: string): Record<string, unknown>[] {
  const input = h!.provider.requests[index]!.body.input as Record<string, unknown>[];
  return input.filter((item) => item.type === type);
}

describe.skipIf(bin === null)('the real app-server lifecycle', () => {
  test('a person message to an idle session starts a turn, then is delivered and acknowledged', async () => {
    h = await startCodexHarness(bin!);
    const session = await (await h.attempt()).start();
    const log = new EventLog(session.events);
    await log.next('turn_ended');
    const from = log.events.length;
    await session.send({ id: 'msg-1', text: 'Please also update the docs.', authority: 'person' });
    await log.next('turn_ended', { from });
    expect(log.events.slice(from).map((event) => event.type)).toEqual([
      'delivered',
      'turn_started',
      'text',
      'context',
      'quota',
      'acknowledged',
      'turn_ended',
    ]);
    expect(log.of('delivered')).toEqual([{ type: 'delivered', id: 'msg-1' }]);
    expect(log.of('acknowledged')).toEqual([{ type: 'acknowledged', id: 'msg-1' }]);
    // A new turn: the message is the request's newest user text, with no tool output after it.
    expect(h.provider.requests.at(-1)).toMatchObject({
      threadId: session.sessionRef,
      lastUserText: 'Please also update the docs.',
      toolOutputsSinceUser: 0,
    });
    expect(log.of('turn_started')).toHaveLength(2);
  });

  test('a delivery during a held response is steered into the turn and reaches the next provider request', async () => {
    h = await startCodexHarness(bin!, {
      handler: rules([
        // The held reply is a command, so the turn samples again after it and carries the steered message.
        { marker: HOLD, toolOutputs: 0, reply: reply.hang(reply.shell({ cmd: 'echo first' })) },
        { marker: 'Mid-turn note', reply: reply.text('Noted.') },
      ]),
    });
    const session = await (await h.attempt({ firstPrompt: `${HOLD}: start the work.` })).start();
    const log = new EventLog(session.events);
    await until(() => h!.provider.requests.length === 1, 30_000);
    await session.send({ id: 'msg-2', text: 'Mid-turn note: keep the API stable.', authority: 'person' });
    expect(log.of('delivered')).toEqual([{ type: 'delivered', id: 'msg-2' }]);
    expect(log.of('acknowledged')).toEqual([]);
    expect(h.provider.release()).toBe(1);
    const ended = await log.next('turn_ended');
    expect(ended).toMatchObject({ outcome: 'completed', toolCalls: 1 });
    expect(h.provider.requests.slice(1).map((request) => request.lastUserText)).toEqual([
      'Mid-turn note: keep the API stable.',
    ]);
    // One turn took both: it acknowledged the message before it ended.
    expect(log.of('turn_started')).toHaveLength(1);
    expect(log.events.findIndex((event) => event.type === 'acknowledged')).toBeLessThan(log.events.indexOf(ended));
    expect(log.of('acknowledged')).toEqual([{ type: 'acknowledged', id: 'msg-2' }]);
  });

  test("an agent's message reaches the provider as agflow's agent_message function_call_output", async () => {
    h = await startCodexHarness(bin!);
    const a = await h.attempt();
    const session = await a.start();
    const log = new EventLog(session.events);
    await log.next('turn_ended');
    const from = log.events.length;
    await session.send({ id: 'msg-3', text: 'From A-2: the API is done.', authority: 'agent' });
    await log.next('turn_ended', { from });
    const index = h.provider.requests.length - 1;
    expect(inputItems(index, 'function_call_output')).toEqual([
      {
        type: 'function_call_output',
        id: expect.any(String),
        name: 'agent_message',
        namespace: 'agflow',
        output: 'From A-2: the API is done.',
      },
    ]);
    expect(h.provider.requests[index]!.toolOutputs).toEqual([
      {
        type: 'function_call_output',
        callId: null,
        name: 'agent_message',
        output: 'From A-2: the API is done.',
        parts: ['From A-2: the API is done.'],
      },
    ]);
    // Tool authority, below the person's (design 5, 9.2): the newest user text is still the first prompt alone,
    // the tools note stays in developer instructions, and the agent's text is in no message item.
    expect(h.provider.requests[index]).toMatchObject({ toolOutputsSinceUser: 1 });
    expect(h.provider.requests[index]!.lastUserText).toBe(a.launch.firstPrompt);
    expect(h.provider.requests[index]!.instructions).toContain(a.launch.brief);
    expect(h.provider.requests[index]!.instructions).toContain(codexToolsNote(a.launch.bridge.tools));
    expect(
      inputItems(index, 'message')
        .flatMap((item) => item.content as { text?: string }[])
        .map((part) => part.text ?? '')
        .filter((text) => text.includes('From A-2: the API is done.')),
    ).toEqual([]);
    expect(
      log.events.slice(from).filter((event) => event.type === 'delivered' || event.type === 'acknowledged'),
    ).toEqual([
      { type: 'delivered', id: 'msg-3' },
      { type: 'acknowledged', id: 'msg-3' },
    ]);
  });

  test('an interrupt during a held response ends the turn interrupted, and the next send starts a new turn', async () => {
    h = await startCodexHarness(bin!, { handler: rules([{ marker: HOLD, reply: reply.hang() }]) });
    const session = await (await h.attempt({ firstPrompt: `${HOLD}: a long answer.` })).start();
    const log = new EventLog(session.events);
    await until(() => h!.provider.requests.length === 1, 30_000);
    await session.interrupt();
    expect(await log.next('turn_ended')).toEqual({
      type: 'turn_ended',
      outcome: 'interrupted',
      toolCalls: 0,
      error: null,
      errorKind: null,
    });
    await until(() => h!.provider.requests[0]!.aborted);
    const from = log.events.length;
    await session.send({ id: 'msg-4', text: 'Start again, briefly.', authority: 'person' });
    expect(await log.next('turn_ended', { from })).toMatchObject({ outcome: 'completed' });
    expect(log.of('turn_started')).toHaveLength(2);
    expect(h.provider.requests.at(-1)?.lastUserText).toBe('Start again, briefly.');
  });

  test('after a SIGKILL of the process group, a resume continues the same thread with its history', async () => {
    h = await startCodexHarness(bin!, {
      handler: rules([{ marker: 'Work on', reply: reply.text('First answer: the plan is ready.') }]),
    });
    const a = await h.attempt();
    const session = await a.start();
    const log = new EventLog(session.events);
    await log.next('turn_ended');
    process.kill(-session.pid, 'SIGKILL');
    expect(await session.exited).toEqual({ code: null, signal: 'SIGKILL' });
    await log.done;

    const resumed = await a.start(session.sessionRef);
    expect(resumed.sessionRef).toBe(session.sessionRef);
    expect(resumed.pid).not.toBe(session.pid);
    expect(a.registered).toEqual([session.pid, resumed.pid]);
    const resumedLog = new EventLog(resumed.events);
    // A resume sends no prompt of its own: the runner's resume prompt arrives as a message.
    await resumedLog.next('started');
    expect(h.provider.requests).toHaveLength(1);
    await resumed.send({ id: 'msg-5', text: 'Resume where you left off.', authority: 'person' });
    await resumedLog.next('turn_ended');
    const last = h.provider.requests.at(-1)!;
    expect(last).toMatchObject({ threadId: session.sessionRef, lastUserText: 'Resume where you left off.' });
    const said = inputItems(h.provider.requests.length - 1, 'message')
      .flatMap((item) => item.content as { text?: string }[])
      .map((part) => part.text);
    expect(said).toContain(a.launch.firstPrompt);
    expect(said).toContain('First answer: the plan is ready.');
  });

  test('resuming a thread that never ran a turn starts a fresh thread with the first prompt', async () => {
    h = await startCodexHarness(bin!);
    const a = await h.attempt();
    // A thread/start with nothing after it, as when a start dies before its first turn: Codex keeps no rollout.
    const codexHome = a.launch.env.CODEX_HOME!;
    const userHome = a.launch.env.HOME!;
    for (const home of [codexHome, userHome]) mkdirSync(home, { recursive: true, mode: 0o700 });
    const app = await openAppServer({
      bin: join(h.paths.runner, vendorBinary('codex', a.launch.cliVersion)),
      args: appServerArgs(h.config.test!.codexConfig),
      env: appServerEnv({ base: a.launch.env, bridgeEnv: a.launch.bridge.env, codexHome, userHome }),
      cwd: userHome,
      expectedVersion: a.launch.cliVersion,
      logFile: join(h.dir, 'never-ran.log'),
    });
    let neverRan: string;
    try {
      neverRan = (await app.rpc.request('thread/start', threadOverrides(a.launch, userHome))).thread.id;
    } finally {
      await app.end();
    }
    const session = await a.start(neverRan);
    const log = new EventLog(session.events);
    expect(session.sessionRef).not.toBe(neverRan);
    expect(await log.next('started')).toMatchObject({ sessionRef: session.sessionRef });
    await log.next('turn_ended');
    expect(h.provider.requests).toHaveLength(1);
    expect(h.provider.requests[0]).toMatchObject({ threadId: session.sessionRef });
    // The fallback uses the same contract as a fresh start: prompt alone, with the tools note in instructions.
    expect(h.provider.requests[0]!.lastUserText).toBe(a.launch.firstPrompt);
    expect(h.provider.requests[0]!.instructions).toContain(a.launch.brief);
    expect(h.provider.requests[0]!.instructions).toContain(codexToolsNote(a.launch.bridge.tools));
    // One app-server run: the fallback starts the fresh thread in the same process.
    expect(a.registered).toEqual([session.pid]);
  });

  test("close() ends the app-server with exit 0 and ends a background command's process", async () => {
    // exec_command yields after half a second while sleep runs on as a background session of the app-server.
    const background = [
      "const started = await tools.exec_command({ cmd: 'echo $$ > background.pid; exec sleep 300', yield_time_ms: 500 });",
      'text(JSON.stringify(started));',
    ].join('\n');
    h = await startCodexHarness(bin!, {
      handler: rules([
        { toolOutputs: 0, reply: reply.code(background) },
        { toolOutputs: 1, reply: reply.text('The server runs in the background.') },
      ]),
    });
    const a = await h.attempt();
    const session = await a.start();
    const log = new EventLog(session.events);
    expect(await log.next('turn_ended')).toMatchObject({ outcome: 'completed' });
    const pid = Number(readFileSync(join(a.clone, 'background.pid'), 'utf8').trim());
    expect(alive(pid)).toBe(true);
    await session.close();
    expect(await session.exited).toEqual({ code: 0, signal: null });
    await until(() => !alive(pid));
    await log.done;
  });

  test('two sessions started at once on a fresh runner Codex home both start', async () => {
    h = await startCodexHarness(bin!);
    const [first, second] = await Promise.all([h.attempt(), h.attempt()]);
    const sessions = await Promise.all([first!.start(), second!.start()]);
    expect(new Set(sessions.map((session) => session.sessionRef)).size).toBe(2);
    const logs = sessions.map((session) => new EventLog(session.events));
    for (const log of logs) expect(await log.next('turn_ended')).toMatchObject({ outcome: 'completed' });
    expect(first!.registered).toHaveLength(1);
    expect(second!.registered).toHaveLength(1);
  });

  test("a 35 s command completes inside one exec call, past exec_command's 30 s yield", async () => {
    h = await startCodexHarness(bin!, {
      handler: rules([
        { toolOutputs: 0, reply: reply.shell({ cmd: 'sleep 35 && echo slept', timeoutMs: 60_000 }) },
        { toolOutputs: 1, reply: reply.text('The long command finished.') },
      ]),
    });
    const attempt: HarnessAttempt = await h.attempt();
    const session = await attempt.start();
    const log = new EventLog(session.events);
    expect(await log.next('turn_ended', { ms: 90_000 })).toMatchObject({ outcome: 'completed', toolCalls: 1 });
    expect(log.of('tool_started')).toEqual([
      {
        type: 'tool_started',
        toolId: expect.any(String),
        name: 'exec_command',
        input: 'sleep 35 && echo slept',
        command: 'sleep 35 && echo slept',
      },
    ]);
    expect(log.of('tool_ended')).toEqual([
      {
        type: 'tool_ended',
        toolId: log.of('tool_started')[0]!.toolId,
        ok: true,
        denied: false,
        terminal: null,
        hubUnreachable: false,
      },
    ]);
    // The exec call's one output carries the command's exit and its output.
    expect(h.provider.requests[1]!.toolOutputs).toHaveLength(1);
    expect(h.provider.requests[1]!.toolOutputs[0]!.output).toMatch(/"exit_code":0/);
    expect(h.provider.requests[1]!.toolOutputs[0]!.output).toContain('slept');
  });
});
```

- [ ] **Step 2: Check it**

Run: `AGFLOW_SMOKE=1 bun test packages/runner/test/codex/real/lifecycle.test.ts && bun test && bun run typecheck`
Expected: with the pin located, 9 pass and no skips; then the whole suite passes (`0 fail`; the local suites are skipped there) and `tsc` exits 0.

These pass at once: Tasks 12-19 already implement them. Renaming the agent message's tool output in `session.ts` makes the agent-message test fail. A never-ran thread cannot come from `CodexSession`, since a session killed during its first held turn still leaves a rollout, so the test opens the pinned app-server itself, runs only `thread/start` and ends it. The agent-message and never-ran fallback cases assert that the provider's `lastUserText` equals `launch.firstPrompt` exactly. They separately assert that provider instructions contain `launch.brief` and `codexToolsNote(launch.bridge.tools)`. The agent-message case retains its function_call_output authority checks, and the fallback retains its fresh thread id and single-process checks. The file takes about a minute.

- [ ] **Step 3: Commit**

```bash
git add -A 'packages/runner/test/codex/real/lifecycle.test.ts'
git commit -m 'M2E Task 22: Real-binary lifecycle: delivery, interrupt, resume and close (local)' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

### Task 23: Real-binary quota, vendor errors, context and approvals (local)

The error and approval cases of section 15 on the real binary, driven by the scripted provider (design 9.2 Errors and Quota, 9.3, 6.10, 7.8): a 429 usage limit, giving two identical exhausted quota events and then `turn_ended` with `errorKind` `quota`; a 500 (`vendor`); one compaction and a continuation, then `context`; rate-limit headers on a normal turn; an escalated command declined with a reason that the provider then sees; one approved that writes a marker outside the clone; an `apply_patch` outside the clone as a `file_change` approval with its diff; an interrupt that voids a pending request and ends its open tool; and `deleteTranscript` removing the rollout. Every test checks that the refusing proxy saw no connection.

**Files:**
- Test: `packages/runner/test/codex/real/errors.test.ts`

- [ ] **Step 1: Make the change**

**File:** `packages/runner/test/codex/real/errors.test.ts` (new)

```ts
// The real pinned app-server's errors and approvals (design 15, 9.2, 9.3, 6.10, 7.8): quota, vendor and context
// failures, rate-limit headers, escalated commands and patches that ask the owner, withdrawn requests, and transcript
// deletion, all against the scripted provider with zero model use.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { TEST_ACCOUNT_ID } from '@agflow/core';
import {
  COMPACTION_PROMPT_PREFIX,
  rateLimitHeaders,
  reply,
  type ResponsesRequest,
  rules,
} from '@agflow/testkit/src/codex/index';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentEvent } from '../../../src/adapters/types';
import { until } from '../session-fixture';
import { type CodexHarness, EventLog, smokeCodexBinary, startCodexHarness } from './harness';

setDefaultTimeout(120_000);

const bin = await smokeCodexBinary();
let h: CodexHarness | null = null;
afterEach(async () => {
  try {
    // Every external connection would have met the refusing proxy: none was even tried.
    expect(h?.proxy.refused ?? []).toEqual([]);
  } finally {
    await h?.close();
    h = null;
  }
});

const CONTINUATION = 'System note: The context window filled up and was compacted.';

/** The rollout files under a Codex home, by name. */
function rollouts(codexHome: string): string[] {
  const sessions = join(codexHome, 'sessions');
  if (!existsSync(sessions)) return [];
  return readdirSync(sessions, { recursive: true, encoding: 'utf8' }).filter((name) => name.endsWith('.jsonl'));
}

describe.skipIf(bin === null)('the real app-server: errors and quota', () => {
  test('a 429 usage_limit_reached reports the exhausted quota in ms and a quota failure', async () => {
    const limit = reply.usageLimit(3_600);
    h = await startCodexHarness(bin!, { handler: () => limit });
    const session = await (await h.attempt()).start();
    const log = new EventLog(session.events);
    const ended = await log.next('turn_ended');
    expect(ended).toMatchObject({ outcome: 'failed', toolCalls: 0, errorKind: 'quota' });
    const exhausted: AgentEvent = {
      type: 'quota',
      accountId: TEST_ACCOUNT_ID,
      quota: {
        state: 'exhausted',
        // The five-hour window's reset, from epoch seconds to ms.
        resetsAt: Number(limit.headers!['x-codex-primary-reset-at']) * 1000,
        windows: { fiveHour: 1, weekly: 0.4 },
        paidUsage: 'unknown',
        updatedAt: expect.any(Number),
      },
    };
    // The headers' account/rateLimits/updated, then the failure's own report, both before the end.
    expect(log.events.slice(1).map((event) => event.type)).toEqual(['turn_started', 'quota', 'quota', 'turn_ended']);
    expect(log.of('quota')).toEqual([exhausted, exhausted]);
    expect(h.provider.requests).toHaveLength(1);
  });

  test('a 500 from the provider ends the turn as a vendor failure', async () => {
    h = await startCodexHarness(bin!, {
      handler: () => reply.httpError(500, { error: { type: 'server_error', message: 'The scripted server broke.' } }),
    });
    const session = await (await h.attempt()).start();
    const log = new EventLog(session.events);
    expect(await log.next('turn_ended')).toEqual({
      type: 'turn_ended',
      outcome: 'failed',
      toolCalls: 0,
      error: expect.any(String),
      errorKind: 'vendor',
    });
    // Retries are off in test mode: Codex gave up after the one request.
    expect(h.provider.requests).toHaveLength(1);
    expect(log.of('quota')).toEqual([]);
  });

  test('context_length_exceeded runs one compaction and a continuation that completes the work', async () => {
    h = await startCodexHarness(bin!, {
      handler: rules([
        { marker: 'Work on', reply: reply.failed('context_length_exceeded', 'Your input exceeds the context window.') },
        { marker: CONTINUATION, reply: reply.text('Continuing after the compaction.') },
      ]),
    });
    const session = await (await h.attempt()).start();
    const log = new EventLog(session.events);
    const ended = await log.next('turn_ended');
    expect(ended).toMatchObject({ outcome: 'completed', errorKind: null });
    // The failed turn's end is hidden: one turn_ended, after the compaction and the continuation.
    expect(log.of('turn_ended')).toHaveLength(1);
    expect(log.of('compacted')).toHaveLength(1);
    // The failed turn and the continuation; the compaction turn is hidden.
    expect(log.of('turn_started')).toHaveLength(2);
    const kinds = h.provider.requests.map((request) =>
      request.isCompaction ? 'compaction' : (request.lastUserText ?? '').slice(0, 20),
    );
    expect(kinds).toEqual([expect.stringMatching(/^Work on/), 'compaction', CONTINUATION.slice(0, 20)]);
    expect(h.provider.requests[1]!.lastUserText).toStartWith(COMPACTION_PROMPT_PREFIX);
    expect(log.of('text').map((event) => event.text)).toEqual(['Continuing after the compaction.']);
  });

  test('a second context_length_exceeded ends the continuation as a context failure', async () => {
    h = await startCodexHarness(bin!, {
      handler: rules([{ reply: reply.failed('context_length_exceeded', 'Your input exceeds the context window.') }]),
    });
    const session = await (await h.attempt()).start();
    const log = new EventLog(session.events);
    expect(await log.next('turn_ended')).toEqual({
      type: 'turn_ended',
      outcome: 'failed',
      toolCalls: 0,
      error: expect.any(String),
      errorKind: 'context',
    });
    // One compaction only: the continuation's failure is the attempt's context outcome.
    expect(h.provider.requests.filter((request) => request.isCompaction)).toHaveLength(1);
    expect(h.provider.requests.at(-1)!.lastUserText).toStartWith(CONTINUATION);
    await session.close();
    await log.done;
    expect(log.of('turn_ended')).toHaveLength(1);
  });

  test("rate-limit headers on a normal turn report both windows' utilization", async () => {
    const now = Math.floor(Date.now() / 1000);
    const headers = rateLimitHeaders({
      primary: { usedPercent: 25, windowMinutes: 300, resetAt: now + 3_600 },
      secondary: { usedPercent: 60, windowMinutes: 10_080, resetAt: now + 86_400 },
      credits: { hasCredits: false, unlimited: false },
    });
    h = await startCodexHarness(bin!, { handler: () => ({ ...reply.text('Within limits.'), headers }) });
    const session = await (await h.attempt()).start();
    const log = new EventLog(session.events);
    expect(await log.next('turn_ended')).toMatchObject({ outcome: 'completed' });
    expect(log.of('quota').at(-1)).toEqual({
      type: 'quota',
      accountId: TEST_ACCOUNT_ID,
      quota: {
        state: 'ok',
        // The limiting window is the fuller one, the weekly.
        resetsAt: (now + 86_400) * 1000,
        windows: { fiveHour: 0.25, weekly: 0.6 },
        paidUsage: 'disabled',
        updatedAt: expect.any(Number),
      },
    });
  });
});

describe.skipIf(bin === null)('the real app-server: approvals', () => {
  test('a declined escalation ends the item declined, and the turn continues with the steered reason', async () => {
    const reason = 'The owner declined: nothing outside the clone.';
    h = await startCodexHarness(bin!);
    const marker = join(h.dir, 'declined-marker');
    h.provider.setHandler((request: ResponsesRequest) => {
      if ((request.lastUserText ?? '').includes(reason)) return reply.text('Understood, staying inside the clone.');
      if (request.toolOutputsSinceUser === 0) {
        return reply.shell({ cmd: `touch ${marker}`, escalate: { justification: 'Write the marker outside.' } });
      }
      // Held until the steered note is in, so the turn samples again after it.
      return reply.hang(reply.shell({ cmd: 'true' }));
    });
    const a = await h.attempt();
    const session = await a.start();
    const log = new EventLog(session.events);
    const asked = await log.next('approval_request');
    expect(asked).toEqual({
      type: 'approval_request',
      approvalId: expect.any(String),
      kind: 'command',
      summary: expect.stringContaining(`touch ${marker}`),
      detail: {
        command: expect.stringContaining(`touch ${marker}`),
        cwd: a.clone,
        reason: 'Write the marker outside.',
      },
    });
    expect(await log.next('waiting_approval')).toEqual({ type: 'waiting_approval', waiting: true });
    expect(await session.answerApproval(asked.approvalId, 'decline', reason)).toBe(true);
    // A second answer finds nothing pending.
    expect(await session.answerApproval(asked.approvalId, 'approve', null)).toBe(false);
    const declined = await log.next('tool_ended');
    expect(declined).toMatchObject({ ok: false, denied: true });
    expect(await log.next('waiting_approval', { where: (event) => !event.waiting })).toEqual({
      type: 'waiting_approval',
      waiting: false,
    });
    await until(() => {
      h!.provider.release();
      return h!.provider.requests.some((request) => (request.lastUserText ?? '').includes(reason));
    }, 30_000);
    expect(await log.next('turn_ended')).toMatchObject({ outcome: 'completed' });
    expect(log.of('turn_started')).toHaveLength(1);
    expect(log.of('text').at(-1)?.text).toBe('Understood, staying inside the clone.');
    expect(h.provider.requests.flatMap((request) => request.toolOutputs).map((output) => output.output)).toContainEqual(
      expect.stringContaining('rejected by user'),
    );
    // The runner's own answer is no withdrawal.
    expect(log.of('approval_void')).toEqual([]);
    expect(existsSync(marker)).toBe(false);
  });

  test('an approved escalation runs the command outside the sandbox', async () => {
    h = await startCodexHarness(bin!);
    const marker = join(h.dir, 'approved-marker');
    h.provider.setHandler(
      rules([
        {
          toolOutputs: 0,
          reply: reply.shell({ cmd: `touch ${marker}`, escalate: { justification: 'Write the marker outside.' } }),
        },
        { toolOutputs: 1, reply: reply.text('The marker is written.') },
      ]),
    );
    const a = await h.attempt();
    expect(marker.startsWith(`${a.clone}/`)).toBe(false);
    const session = await a.start();
    const log = new EventLog(session.events);
    const asked = await log.next('approval_request');
    expect(await session.answerApproval(asked.approvalId, 'approve', null)).toBe(true);
    expect(await log.next('turn_ended')).toMatchObject({ outcome: 'completed', toolCalls: 1 });
    expect(log.of('tool_ended')).toEqual([expect.objectContaining({ ok: true, denied: false })]);
    expect(existsSync(marker)).toBe(true);
    expect(log.of('approval_void')).toEqual([]);
  });

  test('apply_patch to a path outside the clone asks for a file change with the diff', async () => {
    h = await startCodexHarness(bin!);
    const outside = join(h.dir, 'outside.txt');
    const patch = ['*** Begin Patch', `*** Add File: ${outside}`, '+written from the clone', '*** End Patch'].join(
      '\n',
    );
    h.provider.setHandler(
      rules([
        { toolOutputs: 0, reply: reply.patch(patch) },
        { toolOutputs: 1, reply: reply.text('The patch was declined.') },
      ]),
    );
    const session = await (await h.attempt()).start();
    const log = new EventLog(session.events);
    const asked = await log.next('approval_request');
    expect(asked).toMatchObject({ kind: 'file_change', summary: 'Apply file changes' });
    expect(asked.detail.diff).toContain(`add ${outside}`);
    expect(asked.detail.diff).toContain('written from the clone');
    expect(await session.answerApproval(asked.approvalId, 'decline', null)).toBe(true);
    expect(await log.next('turn_ended')).toMatchObject({ outcome: 'completed' });
    expect(log.of('tool_ended')).toEqual([expect.objectContaining({ ok: false, denied: true })]);
    expect(existsSync(outside)).toBe(false);
  });

  test('an interrupt while a request is pending voids it', async () => {
    h = await startCodexHarness(bin!);
    const marker = join(h.dir, 'interrupted-marker');
    h.provider.setHandler(
      rules([
        {
          toolOutputs: 0,
          reply: reply.shell({ cmd: `touch ${marker}`, escalate: { justification: 'Write the marker outside.' } }),
        },
      ]),
    );
    const session = await (await h.attempt()).start();
    const log = new EventLog(session.events);
    const asked = await log.next('approval_request');
    await session.interrupt();
    expect(await log.next('approval_void')).toEqual({ type: 'approval_void', approvalId: asked.approvalId });
    expect(await log.next('turn_ended')).toMatchObject({ outcome: 'interrupted', toolCalls: 1 });
    // Codex never completes the command it asked about: the turn's end ends it, before turn_ended.
    const [command] = log.of('tool_started');
    expect(log.of('tool_started')).toEqual([
      expect.objectContaining({ name: 'exec_command', command: `touch ${marker}` }),
    ]);
    expect(log.events.filter((event) => event.type === 'tool_ended' || event.type === 'turn_ended')).toEqual([
      { type: 'tool_ended', toolId: command!.toolId, ok: false, denied: false, terminal: null, hubUnreachable: false },
      expect.objectContaining({ type: 'turn_ended' }),
    ]);
    expect(await session.answerApproval(asked.approvalId, 'approve', null)).toBe(false);
    expect(existsSync(marker)).toBe(false);
  });
});

describe.skipIf(bin === null)('the real app-server: transcripts', () => {
  test('deleteTranscript of an ended session removes its rollout, and the tail is then null', async () => {
    h = await startCodexHarness(bin!, { handler: () => reply.text('The transcript holds this answer.') });
    const a = await h.attempt();
    const session = await a.start();
    const log = new EventLog(session.events);
    await log.next('turn_ended');
    await session.close();
    await log.done;
    const codexHome = a.launch.env.CODEX_HOME!;
    const input = { sessionRef: session.sessionRef, clone: a.clone };
    expect(rollouts(codexHome).filter((name) => name.includes(session.sessionRef))).toHaveLength(1);
    expect(await h.adapter.readTranscriptTail({ ...input, maxChars: 1_000 })).toBe('The transcript holds this answer.');
    await h.adapter.deleteTranscript(input);
    expect(rollouts(codexHome).filter((name) => name.includes(session.sessionRef))).toEqual([]);
    expect(await h.adapter.readTranscriptTail({ ...input, maxChars: 1_000 })).toBeNull();
    // A second deletion finds no rollout, which counts as deleted.
    await h.adapter.deleteTranscript(input);
  });
});
```

- [ ] **Step 2: Check it**

Run: `AGFLOW_SMOKE=1 bun test packages/runner/test/codex/real/errors.test.ts && bun test && bun run typecheck`
Expected: with the pin located, 10 pass and no skips; then the whole suite passes (`0 fail`; the local suites are skipped there) and `tsc` exits 0.

These pass at once against Tasks 1-19. Without Task 14's open-tool sweep, the interrupt test fails: Codex never completes a command whose approval was pending at the interrupt, so its `tool_started` would have no `tool_ended`. `account/rateLimits/read` needs a ChatGPT login, so these tests cover quota only through the `x-codex-*` headers. A custom provider cannot produce `unauthorized`, `cyberPolicy`, `misalignmentPolicyViolation`, `tooManyDenials` or `sessionBudgetExceeded`; Task 8's unit tests cover them. After a decline, the provider's next request may come before or after the steered note, so the test keeps releasing held requests until one carries it.

- [ ] **Step 3: Commit**

```bash
git add -A 'packages/runner/test/codex/real/errors.test.ts'
git commit -m 'M2E Task 23: Real-binary quota, vendor errors, context and approvals (local)' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

### Task 24: Codex sandbox checks (local)

The Codex part of the section 15 sandbox checks (design 5, 9.1, 9.2, 7.6), run only with `AGFLOW_SANDBOX_CHECKS=1` (root script `check:codex-sandbox`) because they use the network and a disposable keychain under a scratch HOME. From a scripted tool command, with proxies bypassed, the hub, a package registry and a git host are unreachable; writes land only in the clone (`.git` included) and its `TMPDIR`; a keychain item readable outside cannot be read inside; a planted filter driver never runs through Codex's own git calls; a project MCP server loads only when trusted and then fails the only-agflow check; a skill in the runner's Codex home fails the start, and one in a scratch stand-in for the owner's home never loads; and no `codex_apps` appear. Every negative check has an unsandboxed control with the agent's environment. `scratch-keychain.ts` creates a disposable keychain at an explicit path under a scratch HOME, adds a unique service/secret, and deletes the keychain in `finally`. Its five unit cases inject the security command and cover setup, probe and cleanup failures without touching a real keychain. The sandbox suite also checks empty lookup parsing and probe execution under sh and zsh.

**Files:**
- Test: `packages/runner/test/codex/real/sandbox.test.ts`
- Test: `packages/runner/test/codex/real/scratch-keychain.test.ts`
- Test: `packages/runner/test/codex/real/scratch-keychain.ts`

- [ ] **Step 1: Make the change**

**File:** `packages/runner/test/codex/real/sandbox.test.ts` (new)

```ts
// The Codex sandbox checks (design 15 Sandbox checks, 5, 9.1, 9.2, 7.6): what a tool command of the real pinned
// app-server can reach, write and read, which MCP servers and skills a thread loads, and that a filter driver the agent
// plants in its clone's .git/config never runs outside the sandbox. They run only with AGFLOW_SANDBOX_CHECKS=1 (root
// script check:codex-sandbox), because they use the network and a disposable keychain in a scratch HOME.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { gitIn } from '@agflow/testkit';
import { reply, rules } from '@agflow/testkit/src/codex/index';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CODEX_VERSION, findCodexBinary } from '../../../src/adapters/codex';
import type { FindCodexOptions } from '../../../src/adapters/codex/binary';
import { appServerArgs, appServerEnv, threadOverrides } from '../../../src/adapters/codex/config';
import { openAppServer } from '../../../src/adapters/codex/process';
import { vendorBinary } from '../../../src/vendor/pins';
import { type CodexHarness, DEFAULT_ORIGIN_FILES, EventLog, type HarnessAttempt, startCodexHarness } from './harness';
import { withScratchKeychain } from './scratch-keychain';

setDefaultTimeout(180_000);

/** The pinned binary when the sandbox checks may run: AGFLOW_SANDBOX_CHECKS=1 and findCodexBinary finds the pin. */
async function sandboxCodexBinary(options: FindCodexOptions = {}): Promise<string | null> {
  const env = options.env ?? process.env;
  return env.AGFLOW_SANDBOX_CHECKS === '1' ? findCodexBinary({ env, home: options.home }) : null;
}

const bin = await sandboxCodexBinary();

const cleanups: (() => void)[] = [];
let h: CodexHarness | null = null;
afterEach(async () => {
  try {
    await h?.close();
  } finally {
    h = null;
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  }
});

/** A directory outside every clone and the harness, removed after the test. */
function scratchDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** The text a Code Mode exec call returned to the model, after Codex's "Output:" header. */
function execText(output: string): string {
  return output.slice(output.indexOf('Output:\n') + 'Output:\n'.length).trim();
}

/** `name=value` lines a check script printed. */
function results(output: string): Record<string, string> {
  return Object.fromEntries(
    [...output.matchAll(/^([a-z_]+)=(.*)$/gm)].map((match) => [match[1] as string, match[2] as string]),
  );
}

/** Each check's exit status, printed as `<name>=<status>` after it. */
function checkScript(checks: Record<string, string>): string {
  return Object.entries(checks)
    .map(([name, command]) => `(${command}) >/dev/null 2>&1; echo "${name}=$?"`)
    .join('\n');
}

/**
 * Runs script as one tool command of a fresh session of the attempt and gives the `name=value` lines it printed. The
 * command runs in Codex's sandbox, as every unescalated command does; the turn must complete.
 */
async function sandboxed(a: HarnessAttempt, script: string, secret?: string): Promise<Record<string, string>> {
  h!.provider.setHandler(
    rules([
      { toolOutputs: 0, reply: reply.shell({ cmd: script, timeoutMs: 60_000 }) },
      { toolOutputs: 1, reply: reply.text('The checks ran.') },
    ]),
  );
  const from = h!.provider.requests.length;
  const session = await a.start();
  const log = new EventLog(session.events);
  expect(await log.next('turn_ended', { ms: 90_000 })).toMatchObject({ outcome: 'completed', toolCalls: 1 });
  await session.close();
  await log.done;
  // An escalation would have asked: these commands ran inside the sandbox.
  expect(log.of('approval_request')).toEqual([]);
  const answered = h!.provider.requests.slice(from).find((request) => request.toolOutputsSinceUser === 1);
  const result = JSON.parse(execText(answered!.toolOutputs[0]!.output)) as { output: string };
  if (secret !== undefined) expect(result.output).not.toContain(secret);
  return results(result.output);
}

/**
 * The same script outside the sandbox, in the clone with the agent's environment: the control for every check. It
 * runs asynchronously, since the hub's recording front answers from this process.
 */
async function unsandboxed(a: HarnessAttempt, script: string): Promise<Record<string, string>> {
  const run = Bun.spawn(['/bin/sh', '-c', script], {
    cwd: a.clone,
    env: { ...a.launch.env, HOME: join(a.clone, '.agflow', 'run', 'home'), TMPDIR: a.launch.tmpDir },
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const [output] = await Promise.all([new Response(run.stdout).text(), run.exited]);
  return results(output);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function keychainScript(lookup: string): string {
  // `status` is read-only in zsh, the macOS tool shell. Keep probe variables separate from shell parameters.
  return [
    `agflow_lookup_value=$(${lookup} 2>/dev/null)`,
    'agflow_lookup_exit=$?',
    'printf "keychain_value=%s\\nkeychain=%s\\n" "$agflow_lookup_value" "$agflow_lookup_exit"',
  ].join('\n');
}

describe('the Codex sandbox checks', () => {
  test('results preserves an empty lookup value and its nonzero exit status', () => {
    expect(results('keychain_value=\nkeychain=44\n')).toEqual({ keychain_value: '', keychain: '44' });
  });

  for (const shell of ['/bin/sh', '/bin/zsh']) {
    // the runner supports darwin-arm64 only; design 7.1 (zsh is the macOS tool shell).
    test.skipIf(shell === '/bin/zsh' && process.platform !== 'darwin')(
      `the keychain probe reports refusal and success in ${shell}`, () => {
        const home = scratchDir('agflow-keychain-shell-');
        for (const code of [44, 0]) {
          const secret = 'scratch-test-secret';
          const lookup = `/bin/sh -c ${shellQuote(code === 0 ? `printf %s ${secret}` : `exit ${code}`)}`;
          const run = Bun.spawnSync([shell, '-f', '-c', keychainScript(lookup)], {
            cwd: home,
            env: { PATH: '/usr/bin:/bin', HOME: home, ZDOTDIR: home },
            stdin: 'ignore',
            stdout: 'pipe',
            stderr: 'pipe',
          });
          expect(run.stderr.toString()).toBe('');
          expect(run.exitCode).toBe(0);
          expect(results(run.stdout.toString())).toEqual({
            keychain_value: code === 0 ? secret : '',
            keychain: String(code),
          });
          if (code !== 0) expect(run.stdout.toString()).not.toContain(secret);
        }
      },
    );
  }

  test('run only with AGFLOW_SANDBOX_CHECKS=1 and a located pin', async () => {
    const dir = scratchDir('agflow-codex-sandbox-gate-');
    const stub = join(dir, 'codex');
    writeFileSync(stub, `#!/bin/sh\necho "codex-cli ${CODEX_VERSION}"\n`, { mode: 0o755 });
    const home = join(dir, 'home');
    mkdirSync(home);
    expect(await sandboxCodexBinary({ env: { AGFLOW_SANDBOX_CHECKS: '1', AGFLOW_CODEX_BIN: stub }, home })).toBe(stub);
    expect(await sandboxCodexBinary({ env: { AGFLOW_SANDBOX_CHECKS: '0', AGFLOW_CODEX_BIN: stub }, home })).toBeNull();
    expect(await sandboxCodexBinary({ env: { AGFLOW_CODEX_BIN: stub }, home })).toBeNull();
    expect(await sandboxCodexBinary({ env: { AGFLOW_SANDBOX_CHECKS: '1' }, home })).toBeNull();
  });
});

// the runner supports darwin-arm64 only; design 7.1
describe.skipIf(bin === null || process.platform !== 'darwin')('the Codex sandbox', () => {
  test('tool commands reach neither the hub, a package registry nor a git host, with the proxies bypassed', async () => {
    h = await startCodexHarness(bin!);
    const a = await h.attempt();
    // Drop every proxy and agflow git setting, retaining only a scratch HOME.
    const direct = `env -i PATH=/usr/bin:/bin HOME=${shellQuote(scratchDir('agflow-direct-home-'))}`;
    const script = checkScript({
      hub: `${direct} curl -sS -m 10 -o /dev/null ${a.launch.env.AGFLOW_HUB_URL}/api/tasks`,
      registry: `${direct} curl -sS -m 10 -o /dev/null https://registry.npmjs.org/`,
      git_host: `${direct} GIT_TERMINAL_PROMPT=0 git ls-remote https://github.com/git/git HEAD`,
    });
    // Outside the sandbox the same commands connect: the network is there, so a failure inside is the sandbox's.
    expect(await unsandboxed(a, script)).toEqual({ hub: '0', registry: '0', git_host: '0' });
    const before = h.hubRequests.length;
    const inside = await sandboxed(a, script);
    expect(inside).toEqual({
      hub: expect.not.stringMatching(/^0$/),
      registry: expect.not.stringMatching(/^0$/),
      git_host: expect.not.stringMatching(/^0$/),
    });
    expect(h.hubRequests.slice(before).filter((line) => line.endsWith('/api/tasks'))).toEqual([]);
  });

  test('tool commands write only inside their clone, its .git and its temporary directory', async () => {
    h = await startCodexHarness(bin!);
    const a = await h.attempt();
    // Another attempt of the same runner, never started: its temporary directory is not this agent's.
    const other = await h.attempt();
    const name = `agflow-sandbox-check-${randomUUID()}`;
    const targets = {
      slash_tmp: join('/tmp', name),
      other_tmp: join(other.runDir.tmp, name),
      runner: join(h.paths.runner, name),
      outside_home: join(scratchDir('agflow-forbidden-home-'), name),
    };
    // A failed check would leave its file behind; none may stay, wherever it landed.
    cleanups.push(() => {
      for (const target of Object.values(targets)) rmSync(target, { force: true });
    });
    const forbiddenWrites = Object.fromEntries(
      Object.entries(targets).map(([key, target]) => [key, `echo written > ${shellQuote(target)}`]),
    );
    expect(await unsandboxed(a, checkScript(forbiddenWrites))).toEqual(
      Object.fromEntries(Object.keys(targets).map((key) => [key, '0'])),
    );
    for (const target of Object.values(targets)) {
      expect(readFileSync(target, 'utf8')).toBe('written\n');
      rmSync(target);
    }
    const inside = await sandboxed(
      a,
      [
        'echo "tmpdir_value=$TMPDIR"',
        checkScript({
          clone: 'echo written > written.txt',
          commit: "git add written.txt && git commit -q -m 'A sandboxed commit'",
          tmpdir: `echo written > "$TMPDIR/${name}"`,
          ...forbiddenWrites,
        }),
      ].join('\n'),
    );
    expect(inside).toEqual({
      tmpdir_value: a.runDir.tmp,
      clone: '0',
      commit: '0',
      tmpdir: '0',
      slash_tmp: expect.not.stringMatching(/^0$/),
      other_tmp: expect.not.stringMatching(/^0$/),
      runner: expect.not.stringMatching(/^0$/),
      outside_home: expect.not.stringMatching(/^0$/),
    });
    expect(readFileSync(join(a.clone, 'written.txt'), 'utf8')).toBe('written\n');
    expect(await gitIn(a.clone, ['log', '-1', '--format=%s'])).toBe('A sandboxed commit');
    expect(existsSync(join(a.runDir.tmp, name))).toBe(true);
    for (const target of Object.values(targets)) expect(existsSync(target)).toBe(false);
  });

  test('a disposable scratch keychain is readable outside the sandbox but not from a tool command', async () => {
    h = await startCodexHarness(bin!);
    const a = await h.attempt();
    await withScratchKeychain(scratchDir('agflow-keychain-home-'), async (item) => {
      // Both runs name the same scratch HOME and keychain explicitly. A leak still goes to stdout and the provider.
      const lookup = `HOME=${shellQuote(item.home)} /usr/bin/security find-generic-password -a agflow -s ${shellQuote(item.service)} -w ${shellQuote(item.path)}`;
      const script = keychainScript(lookup);
      const readable = { keychain: '0', keychain_value: item.secret };
      expect(await unsandboxed(a, script)).toEqual(readable);
      expect(await sandboxed(a, script, item.secret)).toEqual({
        keychain: expect.stringMatching(/^[1-9]\d*$/),
        keychain_value: '',
      });
      expect(JSON.stringify(h!.provider.requests.map((request) => request.body))).not.toContain(item.secret);
      // A lock or vanished item must not masquerade as a sandbox refusal.
      expect(await unsandboxed(a, script)).toEqual(readable);
    });
  });

  test("a filter driver planted in the clone's .git/config never runs outside the sandbox", async () => {
    h = await startCodexHarness(bin!);
    const a = await h.attempt();
    const marker = join(scratchDir('agflow-filter-check-'), 'filter-ran');
    const plant = [
      `git config filter.agflowcheck.clean 'touch ${marker}; cat'`,
      "echo '* filter=agflowcheck' > .git/info/attributes",
      'echo changed >> README.md',
      'echo planted',
    ].join(' && ');
    h.provider.setHandler(
      rules([
        { marker: 'Work on', toolOutputs: 0, reply: reply.shell({ cmd: plant }) },
        { marker: 'Work on', toolOutputs: 1, reply: reply.text('Planted.') },
        // Long enough for Codex's per-turn metadata (`git status`) to run while the turn is still open.
        { marker: 'Keep going', toolOutputs: 0, reply: reply.shell({ cmd: 'sleep 4' }) },
        { marker: 'Keep going', toolOutputs: 1, reply: reply.text('Kept going.') },
      ]),
    );
    const session = await a.start();
    const log = new EventLog(session.events);
    await log.next('turn_ended');
    // The sandboxed command could write the clone's .git: the driver is in place.
    expect(await gitIn(a.clone, ['config', 'filter.agflowcheck.clean'])).toBe(`touch ${marker}; cat`);
    const from = log.events.length;
    await session.send({ id: 'msg-1', text: 'Keep going.', authority: 'person' });
    expect(await log.next('turn_ended', { from, ms: 60_000 })).toMatchObject({ outcome: 'completed', toolCalls: 1 });
    await session.close();
    await log.done;
    // A resume runs Codex's thread-start git calls again.
    const resumed = await a.start(session.sessionRef);
    const resumedLog = new EventLog(resumed.events);
    await resumedLog.next('started');
    await resumed.close();
    await resumedLog.done;
    expect(existsSync(marker)).toBe(false);
    // Codex did compute every request's turn metadata, but found no repository for it: with one, the metadata carries
    // a `workspaces` entry from its own `git status`.
    const metadata = h.provider.requests.map((request) => request.headers['x-codex-turn-metadata']);
    expect(metadata.length).toBeGreaterThanOrEqual(4);
    for (const entry of metadata) {
      const parsed = JSON.parse(entry ?? 'null') as Record<string, unknown> | null;
      expect(parsed).toMatchObject({ thread_id: session.sessionRef });
      expect(parsed).not.toHaveProperty('workspaces');
    }
    // The control: an ordinary git status in the clone runs the planted driver.
    Bun.spawnSync(['git', 'status', '--porcelain'], {
      cwd: a.clone,
      env: { PATH: '/usr/bin:/bin', HOME: scratchDir('agflow-filter-home-') },
    });
    expect(existsSync(marker)).toBe(true);
  });

  test("an MCP server planted in the clone's .codex/config.toml loads only when trust is forced", async () => {
    const marker = join(scratchDir('agflow-planted-mcp-'), 'planted-ran');
    const planted = [
      DEFAULT_ORIGIN_FILES['.codex/config.toml'],
      '[mcp_servers.planted]',
      'command = "/bin/sh"',
      `args = ["-c", "touch ${marker}"]`,
      '',
    ].join('\n');
    h = await startCodexHarness(bin!, {
      files: {
        ...DEFAULT_ORIGIN_FILES,
        '.codex/config.toml': planted,
        // Repo skills still load without trust (design 9.2): instructions, like AGENTS.md.
        '.codex/skills/repo-check/SKILL.md': '---\nname: repo-check\ndescription: A repository skill.\n---\n\nCheck.\n',
      },
    });
    const untrusted = await h.attempt({ projectConfigVerified: false });
    const session = await untrusted.start();
    const log = new EventLog(session.events);
    await log.next('turn_ended');
    await session.close();
    await log.done;
    expect(existsSync(marker)).toBe(false);
    expect(JSON.stringify(h.provider.requests[0]!.body)).toContain('repo-check');

    const trusted = await h.attempt({ projectConfigVerified: true });
    const error = await trusted.start().then(
      () => null,
      (error: unknown) => error as Error,
    );
    // The listing omits a server that is starting or failed; its startup status shows it (design 9.2).
    expect(error?.message).toBe('codex thread started unexpected MCP servers: planted');
    // Codex ran it, outside the sandbox, before the check could refuse the thread: trusting a project config trusts
    // its commands, which is why only a verified .codex/ is trusted.
    expect(existsSync(marker)).toBe(true);
  });

  test("a skill in the runner's Codex home fails the start", async () => {
    h = await startCodexHarness(bin!);
    const a = await h.attempt();
    const skill = join(a.launch.env.CODEX_HOME!, 'skills', 'home-check', 'SKILL.md');
    mkdirSync(join(skill, '..'), { recursive: true });
    writeFileSync(skill, '---\nname: home-check\ndescription: A user skill.\n---\n\nCheck.\n');
    const error = await a.start().then(
      () => null,
      (error: unknown) => error as Error,
    );
    expect(error?.message).toBe('codex thread lists user or plugin skills: home-check');
    expect(h.provider.requests).toEqual([]);
  });

  test("a skill in the owner's home given as the launch's HOME does not load", async () => {
    const owner = scratchDir('agflow-owner-home-');
    for (const dir of ['.codex', '.agents']) {
      const skill = join(owner, dir, 'skills', 'owner-check', 'SKILL.md');
      mkdirSync(join(skill, '..'), { recursive: true });
      writeFileSync(skill, '---\nname: owner-check\ndescription: An owner skill.\n---\n\nCheck.\n');
    }
    h = await startCodexHarness(bin!);
    // The app-server's HOME is the codex-user home whatever the launch's environment says.
    const a = await h.attempt({ agentEnv: (env) => ({ ...env, HOME: owner }) });
    const session = await a.start();
    const log = new EventLog(session.events);
    await log.next('turn_ended');
    expect(JSON.stringify(h.provider.requests[0]!.body)).not.toContain('owner-check');
  });

  test('the thread lists no codex_apps, only the agflow bridge', async () => {
    h = await startCodexHarness(bin!);
    const a = await h.attempt();
    const codexHome = a.launch.env.CODEX_HOME!;
    const userHome = h.paths.homes.codexUser;
    for (const home of [codexHome, userHome]) mkdirSync(home, { recursive: true, mode: 0o700 });
    const app = await openAppServer({
      bin: join(h.paths.runner, vendorBinary('codex', a.launch.cliVersion)),
      args: appServerArgs(h.config.test!.codexConfig),
      env: appServerEnv({ base: a.launch.env, bridgeEnv: a.launch.bridge.env, codexHome, userHome }),
      cwd: userHome,
      expectedVersion: a.launch.cliVersion,
      logFile: join(h.dir, 'codex-apps.log'),
    });
    try {
      const { thread } = await app.rpc.request('thread/start', threadOverrides(a.launch, userHome));
      const listed = await app.rpc.request('mcpServerStatus/list', { threadId: thread.id });
      // M2c Task 22 checks preflight in the logged-in runner home; every live start also requires only agflow.
      // This scratch-home check alone cannot establish whether a logged-in home would expose codex_apps.
      expect(listed.data.map((server) => server.name)).toEqual(['agflow']);
      expect((await app.rpc.request('mcpServerStatus/list', {})).data).toEqual([]);
    } finally {
      await app.end();
    }
  });
});
```

**File:** `packages/runner/test/codex/real/scratch-keychain.test.ts` (new)

```ts
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type SecurityCommand, withScratchKeychain } from './scratch-keychain';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function fixture(fail?: string) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "agflow-keychain's home-")));
  homes.push(home);
  const calls: { args: string[]; env: Record<string, string> }[] = [];
  const security: SecurityCommand = (args, env) => {
    calls.push({ args, env });
    return args[0] === fail ? 1 : 0;
  };
  return { home, calls, security };
}

test('keychain setup and removal use only an explicit disposable path and scratch HOME', async () => {
  const { home, calls, security } = fixture();
  const path = join(home, 'Library', 'Keychains', 'probe.keychain-db');
  await withScratchKeychain(home, async (item) => {
    expect(item.home).toBe(home);
    expect(item.path).toBe(path);
    expect(calls.map(({ args }) => args[0])).toEqual(['create-keychain', 'add-generic-password']);
    expect(calls[0]!.args).toEqual(['create-keychain', '-p', expect.any(String), path]);
    expect(calls[1]!.args).toEqual(['add-generic-password', '-a', 'agflow', '-s', item.service, '-w', item.secret, path]);
  }, security);
  expect(calls.at(-1)!.args).toEqual(['delete-keychain', path]);
  for (const { args, env } of calls) {
    expect(args.at(-1)).toBe(path);
    expect(env).toEqual({ PATH: '/usr/bin:/bin', HOME: home });
  }
});

test.each(['create-keychain', 'add-generic-password', 'probe'])(
  'keychain cleanup runs even when %s fails', async (failure) => {
    const { home, calls, security } = fixture(failure);
    let used = false;
    await expect(withScratchKeychain(home, async () => {
      used = true;
      throw new Error('probe failed');
    }, security)).rejects.toThrow(`${failure} failed`);
    expect(used).toBe(failure === 'probe');
    expect(calls.at(-1)!.args).toEqual(['delete-keychain', join(home, 'Library', 'Keychains', 'probe.keychain-db')]);
  },
);

test('keychain removal failures fail the check', async () => {
  const { home, security } = fixture('delete-keychain');
  await expect(withScratchKeychain(home, async () => {}, security)).rejects.toThrow('delete-keychain failed');
});
```

**File:** `packages/runner/test/codex/real/scratch-keychain.ts` (new)

```ts
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type SecurityCommand = (args: string[], env: Record<string, string>) => number;

const runSecurity: SecurityCommand = (args, env) =>
  Bun.spawnSync(['/usr/bin/security', ...args], { env, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' }).exitCode;

export interface ScratchKeychain {
  home: string;
  path: string;
  service: string;
  secret: string;
}

/** A disposable keychain in a caller-owned scratch HOME, never the default keychain or the owner's search list. */
export async function withScratchKeychain(
  home: string,
  use: (item: ScratchKeychain) => Promise<void>,
  security: SecurityCommand = runSecurity,
): Promise<void> {
  const item = {
    home,
    path: join(home, 'Library', 'Keychains', 'probe.keychain-db'),
    service: `agflow-sandbox-check-${randomUUID()}`,
    secret: randomUUID(),
  };
  const env = { PATH: '/usr/bin:/bin', HOME: item.home };
  mkdirSync(dirname(item.path), { recursive: true, mode: 0o700 });
  const run = (...args: string[]) => {
    if (security(args, env) !== 0) throw new Error(`security ${args[0]} failed`);
  };
  try {
    run('create-keychain', '-p', randomUUID(), item.path);
    run('add-generic-password', '-a', 'agflow', '-s', item.service, '-w', item.secret, item.path);
    await use(item);
  } finally {
    run('delete-keychain', item.path);
    if (existsSync(item.path)) throw new Error('security delete-keychain left the scratch keychain behind');
  }
}
```

- [ ] **Step 2: Check it**

Run: `bun test packages/runner/test/codex/real/scratch-keychain.test.ts && bun run check:codex-sandbox && bun test && bun run typecheck`
Expected: 5 scratch-keychain unit tests pass; on macOS with the pin located and sandbox checks enabled, sandbox.test.ts reports 12 pass, 0 fail, no skips (4 ungated helper/gate cases and 8 sandbox cases). With sandbox checks disabled, those two files report 9 pass and 8 skip on macOS. Then the whole suite passes (`0 fail`) and `tsc` exits 0. An MDM or nested-sandbox refusal is reported, never bypassed.

All probes use scratch paths. `withScratchKeychain` uses only PATH=/usr/bin:/bin and the scratch HOME for `/usr/bin/security`, and supplies the explicit keychain path for creation, insertion, lookup and deletion; it never uses the owner's login keychain or search list. Cleanup runs in `finally`, including failed setup or probes, and a failed deletion fails the check. The forbidden home-write target is a separate scratch directory outside the clone. The keychain control must read the secret both before and after the sandboxed lookup, so a locked or vanished keychain cannot masquerade as sandbox enforcement. The probe uses `agflow_lookup_value` and `agflow_lookup_exit`, avoiding zsh's read-only `status`. The raw shell-output string is checked for the secret before parsing its name=value lines, and the recorded provider request bodies are checked too. Empty lookup values remain empty while the numeric nonzero status is preserved. The sandboxed call must request no escalation.

With trust forced, Codex runs the planted MCP server outside the sandbox before the only-agflow check refuses the thread; trusted project config is trusted code. The scratch-home `codex_apps` check cannot establish logged-in behavior; M2c Task 22 covers logged-in preflight, and live starts require only agflow. The binary-gate test uses a pinned-version stub and an empty scratch home. This is a test-only task: Step 2 checks the helpers and sandbox suite using disposable resources. Helper and gate checks run without enabling the sandbox suite. The 12 sandbox cases require macOS and `AGFLOW_SANDBOX_CHECKS=1`, with scratch homes and testkit's scripted localhost model server; the 5 scratch-keychain unit cases use an injected security command.

- [ ] **Step 3: Commit**

```bash
git add -A 'packages/runner/test/codex/real/sandbox.test.ts' 'packages/runner/test/codex/real/scratch-keychain.test.ts' 'packages/runner/test/codex/real/scratch-keychain.ts'
git commit -m 'M2E Task 24: Codex sandbox checks (local)' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

## After the last task

### What works now

- `createAdapters(config, paths, { agflow })` returns a `CodexAdapter`, so `agflow runner start` can run Codex agents. The registry's adapter is built even when the pin is missing; its preflight then reports "binary missing" (or "unsupported platform" off darwin-arm64).
- Preflight is zero-model. It reports the Codex facts, the quota from `account/rateLimits/read` (null when that fails) and an empty `weakened` list. It fails closed on managed policy, and the vendor is not ready without a ChatGPT login (an API-key login does not count) or when the runner's Codex home loads an MCP server or a user or plugin skill.
- A session runs the attempt's CLI version in its own process group from the codex-user home, with the bridge started there too. Start and resume send explicit trust and developerInstructions containing the brief and the role's tools note. They reject another policy, any MCP server but agflow, an empty tool list or any missing required bridge tool, a user or plugin skill, or a configWarning. Extra tools warn. The first prompt is `launch.firstPrompt` alone. The MCP timeout covers the bridge's polling budget plus 30 seconds.
- The events cover turns (main thread only), tools from every thread with terminals and `hubUnreachable`, context, quota with paid usage, warnings and `waiting_approval`. A tool left open when its turn ends is ended. The first context overflow gets one compaction and a continuation; the second ends the turn with `errorKind` `context`.
- Messages steer the active turn or start one, agents arrive as an agflow tool output, and every message reports `delivered` and `acknowledged`. Interrupt, close and the exit info complete the `AgentSession`.
- Approvals from any thread are relayed under minted ids, answered only `accept` or `decline`, voided when Codex withdraws them, and enriched with manifest diffs for package-manager commands. A decline with a reason steers one system note into the asking turn.
- The transcript tail comes from the rollout file, and `deleteTranscript` removes the thread through a short-lived app-server.
- M2b's `AttemptController` drives the adapter in CI (`controller-contract.test.ts`). The real-binary start, lifecycle and error suites exercise Codex 0.159.2 against the scripted provider with zero model use; sandbox checks cover the Codex sandbox boundaries. See How this plan was checked for current results and the enabled sandbox-run gap.

### How to run it

- The whole suite: `bun test && bun run typecheck`. CI runs the unit and fake-peer tests; the local suites are skipped there. The Codex tests alone: `bun test packages/runner/test/codex packages/testkit/test/codex`.
- The local suites need the pinned binaries. For implementation and verification, use existing pinned executables through `AGFLOW_CLAUDE_BIN` and `AGFLOW_CODEX_BIN`, or install into a newly created scratch directory using `AGFLOW_HOME=<scratch-home> bun run vendor:install`. Then explicitly set `AGFLOW_CLAUDE_BIN=<scratch-home>/runner/vendor/claude/2.1.285/claude` and `AGFLOW_CODEX_BIN=<scratch-home>/runner/vendor/codex/0.159.2/bin/codex`; the locators do not follow AGFLOW_HOME. Remove the scratch installation after all children exit. Do not run the installer without a scratch AGFLOW_HOME or install globally during implementation or verification. Use the scratch provisioning commands in the conventions before running these checks. Then:
  - `bun run smoke:codex` runs every Codex test with `AGFLOW_SMOKE=1`: the real-binary start, lifecycle and error suites (about a minute and a half on their own) and the protocol regeneration check.
  - `bun run check:codex-sandbox` runs the sandbox checks with `AGFLOW_SANDBOX_CHECKS=1`. They reach the network for their controls. All sandbox probes use scratch paths. Create a disposable keychain under a scratch HOME and pass its explicit path to both controls and sandboxed lookups. Require lookup success outside the sandbox and refusal inside it, then remove the keychain in finally. Never use the owner's HOME, login keychain or keychain search list. Use a scratch directory outside the clone for the forbidden-write target. Preserve successful unsandboxed controls, sandboxed refusal and secret-leak assertions; do not weaken policy if a check fails.
  - The real Codex talks only to testkit's scripted provider on 127.0.0.1, behind the refusing proxy, with scratch homes. Check that the pass lines count passes, not skips.
- After a re-pin: `bun run gen:codex-protocol` (it refuses a binary at another version), then fix whatever `methods.ts` and the adapter no longer typecheck against, and rerun `smoke:codex`; `tool-surface.json` fails loudly when Code Mode's tool surface changes.

### What the next plans build on

Other plans import these by name; a change to them needs a recorded decision and updates every importer in the same commit.

- **The Codex adapter** (`packages/runner/src/adapters/codex/index.ts`):
  - `CodexAdapter` and `createCodexAdapter(options: CodexAdapterOptions)`, with `CodexAdapterOptions` = `{ config, paths, env?, logger?, requestTimeoutMs?, platform?, arch? }`. `env` is where `AGFLOW_TEST` and the user variables are read (`process.env` by default). Test mode's `test.codexConfig` (as `-c` flags) and `test.skipAuthChecks` apply only under `isTestMode`.
  - `codexAdapterOptions(config, paths, env?)` and `codexProcessOptions({ config, paths, env })`, the one derivation of the Codex homes, base environment and test switches (`CodexProcessOptions`).
  - `CodexSession` and `CodexSessionOptions`, `CODEX_VERSION`, and `findCodexBinary({ env?, home? })` (X-20's locator: `AGFLOW_CODEX_BIN`, then `~/.agflow/runner/vendor/codex/<pin>/bin/codex`, only at the pin).
- **The registry entry** `adapters/codex/entry.ts`: `codexAdapterFactory = ({ config, paths }) => createCodexAdapter({ config, paths })` (X-6). M2c's host gets it through `createAdapters`; nothing else needs to register Codex.
- **The scripted Responses provider** (`@agflow/testkit/src/codex/index`, X-20), which M2g's playbook compiler uses for Codex steps:
  - `startResponsesServer({ handler? })` giving `ResponsesServer { url, requests, setHandler(fn), release(threadId?), close() }`; `rules([{ marker?, threadId?, toolOutputs?, compaction?, reply }])`; `ResponsesRequest` (`body`, `threadId`, `instructions`, `cwd`, `inputKinds`, `toolOutputs`, `toolOutputsSinceUser`, `lastUserText`, `isCompaction`, `unmatched`, `aborted`) and `toolSurface(request)`.
  - `reply.text`, `reply.code` (raw JavaScript for Code Mode's `exec`; never `reply.exec`), `reply.shell({ cmd, timeoutMs?, workdir?, escalate?, callId? })` (one `exec` call that holds through long commands by polling `write_stdin`), `reply.mcp({ tool, args, callId })` (calls `tools.mcp__agflow__<tool>`), `reply.patch`, `reply.functionCall`, `reply.usageLimit(resetInS)`, `reply.httpError`, `reply.failed(code, message)` and `reply.hang(then?)`; `rateLimitHeaders(...)`, `DEFAULT_REPLY_TEXT`, `DEFAULT_COMPACTION_SUMMARY` and `COMPACTION_PROMPT_PREFIX`.
  - `codexTestConfig(url, { streamIdleTimeoutMs? })`, the runner.json `test.codexConfig` that points Codex at the provider with retries off, and its type `CodexTestConfig`.
  - The reply types `StreamReply` (`{ kind: 'stream', output: OutputItem[], inputTokens?, headers? }`) and `OutputItem`. M2g's playbook puts text before a call by joining `output` arrays (`{ ...call, output: [...before, ...call.output] }`), so `output` stays a plain array of Responses API items.
  - M2g imports by file path as well as through the index: `replies.ts` (`reply`, `OutputItem`, `StreamReply`, `DEFAULT_REPLY_TEXT`), `request.ts` (`ResponsesRequest`, and `parseResponsesRequest` in its tests), `responses-server.ts` (`startResponsesServer`, `ResponsesServer`) and `test-config.ts` (`codexTestConfig`, `CodexTestConfig`) under `packages/testkit/src/codex/`, and `findCodexBinary` from `@agflow/runner/src/adapters/codex/binary`. Moving or renaming these files, not only these names, is a cross-plan change.
- **The local real-binary harness** (`packages/runner/test/codex/real/harness.ts`), a pattern for M2g's Codex runners: `startCodexHarness(bin, { files?, handler?, streamIdleTimeoutMs? })` gives `{ bin, dir, paths, config, adapter, hub, hubRequests, provider, proxy, origin, attempt(options), close() }`, with a scratch `AGFLOW_HOME` that links the located version directory, the in-process hub behind a recording front, the refusing proxy, and the real bridge by path; `attempt({ role?, projectConfigVerified?, bridgeEnv?, agentEnv?, brief?, firstPrompt? })` gives the hub attempt, its token, clone, run directory, launch and `start(resume?)`. Also `smokeCodexBinary`, `EventLog`, `PROJECT_CODEX_CONFIG` and `DEFAULT_ORIGIN_FILES`.
- The harness launch carries `bridge.tools = BRIDGE_TOOL_NAMES[role]`, and its bridge command preserves `selfCommand`'s two Bun flags before `main.ts`. Cleanup uses `removeAgentTools` before removing homes. Fake `createRunner` consumers pass `cliVersion: fixtureCliVersion`. M2e does not implement settings synchronization or late-work storage; those remain M2b's contracts.
- **The CI fake peer** (`packages/runner/test/codex/peer.ts`): `codexScenario`, `writeCodexShim(path, scenario)`, `readCodexRecord` and `codexMessages` (0.159.2 shapes), for any test that needs a Codex binary without Codex.
- **The root scripts** `gen:codex-protocol`, `smoke:codex` and `check:codex-sandbox` now run real files. Gate G6 needs this plan done and one passing run of `smoke:codex` and `check:codex-sandbox` on macOS. The sandbox checks' `codex_apps` case means little without a login; the logged-in case is covered elsewhere: M2c Task 22's service checks run Codex preflight in the logged-in runner home, which is not ready unless `mcpServerStatus/list` is empty, and every live Codex start refuses a thread that lists any MCP server but `agflow`. No M2g task checks `codex_apps` on its own.
- **Behaviour the other plans rely on:**
  - Every session emits `started` with the thread id as `sessionRef`, `launch.cliVersion` and `permissionMode` `on-request`, and registers exactly one process per launch. A start that dies with Codex's sqlite startup race rejects, and nothing retries it in the runner: M2b reports `attempt.failed_to_start` (infra), the hub starts a new attempt after `infraBackoffMs`, and two such failures in a row on one runner mark Codex not ready until the next passing preflight (design 6.9; Known behaviour 4).
  - `acknowledged` follows the completion of the turn that took a message, whatever its status, and comes before that turn's `turn_ended`. A held message's send resolves only once it went out.
  - A turn that fails with a context overflow reports nothing until the recovery ends. `errorKind` `context` comes only from a second overflow, a rejected `thread/compact/start` (no compaction turn started) or a rejected continuation; a compaction turn that is interrupted or fails otherwise ends as itself. Quota events carry the account id from `account/read` (`TEST_ACCOUNT_ID` in test mode).
  - A failed agflow call whose text is `BRIDGE_ANSWERS.hubUnreachable` sets `hubUnreachable`; a terminal tool counts only on a normal result.
  - The bridge runs in the codex-user home with `launch.bridge.command/args` unchanged and exactly `launch.bridge.env`. The adapter names `launch.bridge.tools` in developerInstructions and verifies the live inventory on start and resume. Codex's own git calls see `GIT_DIR=/dev/null`. `tool_timeout_sec` defaults to 210 and follows the bridge's configured poll budget.
- **Before merging:** Run the macOS G6 gates, including all current sandbox cases; rerun them if code changes after verification. Update the design text listed under Known behaviour 10 when the plans land.
- **Next steps:** review the branch against design sections 9, 13, 15 and 15.1 and the Codex parts of 5, 6.10, 7.4 and 7.8, update the design text listed under Known behaviour 10, and merge after M2d (`m2d-claude` at `55c4dae032ad4592398e74d6fc8aa03d9fae61f8`), which includes M2a-M2c. M2g's scenarios then run Codex runners through `createAdapters` with the scripted provider.
