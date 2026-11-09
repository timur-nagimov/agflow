// record:claude (design 15, 15.1, 8.1, 8.3): drives the pinned claude through the Agent SDK with buildQueryOptions for
// a scratch launch, and turns what it printed into the fake claude's recordings. By default it runs against the
// scripted Messages API behind the refusing proxy, with a stub agflow (claude-stub-bridge.ts) as the bridge and the
// brief hook, so no model is used; it then rewrites the API-key account into a synthetic subscription. --live records
// from the runner's own Claude login instead, for what only a subscription produces. Either way it drops the Mac's
// managed policy and redacts emails, organisation ids, home paths and session ids before anything is written.
//
//   bun run record:claude [--only turn-basic,interrupt] [--live] [--model <id>] [--bin <claude>]
import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import type { Vendor } from '@agflow/core';
import { startRefusingProxy } from '@agflow/testkit';
import {
  type AnthropicHandler,
  agflowTool,
  afterToolResult,
  bashTool,
  claudeTestEnv,
  fail,
  findClaudeBinary,
  isCompaction,
  refusal,
  reply,
  rules,
  startScriptedAnthropic,
  text,
  userSays,
} from '@agflow/testkit/src/anthropic';
import {
  CLAUDE_FIXTURES_DIR,
  type ClaudeRecording,
  type ControlAnswer,
  type RecordingHeader,
  type RecordingStep,
  SYNTHETIC_ACCOUNT,
  writeRecording,
} from '@agflow/testkit/src/fake-claude';
import {
  type HookCallback,
  query,
  type SDKUserMessage,
  type SpawnedProcess,
  type SpawnOptions,
} from '@anthropic-ai/claude-agent-sdk';
import { buildQueryOptions, effectivePermissionMode, ensureClaudeEmptyDir } from '../src/adapters/claude/options';
import { claudeProjectDir } from '../src/adapters/claude/paths';
import { CLAUDE_CLI_VERSION, readClaudeVersion } from '../src/adapters/claude/pin';
import type { AgentLaunch, AgflowCommand } from '../src/adapters/types';
import { loadRunnerConfig, vendorHomes } from '../src/config';
import { agflowHome, makeAttemptTmpDir, type RunnerPaths, runnerPaths } from '../src/paths';
import { type PermissionProfile, standardProfile } from '../src/profile';
import { vendorBinary } from '../src/vendor/pins';
import { STUB_BRIDGE_TOOLS, stubBrief } from './claude-stub-bridge';

// Frames are untyped JSON, as the CLI printed them.
type Json = Record<string, any>;

/** The stub agflow: `<bun> claude-stub-bridge.ts`, which the bridge args and the brief hook follow. */
export const STUB_AGFLOW: AgflowCommand = {
  command: process.execPath,
  args: [join(import.meta.dir, 'claude-stub-bridge.ts')],
};

/** Where record:claude writes transcripts for the runner's tests (readTranscriptTail). */
export const CLAUDE_TRANSCRIPT_FIXTURES_DIR = join(import.meta.dir, '..', 'test', 'fixtures', 'claude');

/** The session id a committed transcript carries instead of the recorded one. */
export const TRANSCRIPT_SESSION_ID = '00000000-0000-4000-8000-000000000000';

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..');
const WAIT_MS = 60_000;
const EXIT_WAIT_MS = 10_000;

// ---------------------------------------------------------------------------------------------------------------
// The scratch launch

export interface ScratchLaunchOptions {
  /**
   * The claude to run; it is linked where vendorBinary puts the pin in the scratch layout, so buildQueryOptions
   * finds it. A live launch runs the runner's own pinned binary instead.
   */
  bin: string;
  model: string;
  /** Added to the launch environment: the test environment, or the fake's. */
  env: Record<string, string>;
  profile?: PermissionProfile;
  /**
   * The owner's HOME and the runner's own layout and Claude home, whose login --live records from. The rules, the
   * sandbox and the guard then confine the agent to the real runner tree and work root, as for the runner's agents.
   */
  live?: boolean;
  /** The runner's AGFLOW_HOME for a live launch; agflowHome() by default. */
  runnerHome?: string;
  agflow?: AgflowCommand;
}

export interface ScratchLaunch {
  /** The scratch directory that cleanup removes. */
  root: string;
  /** The layout the options are built from: the scratch one, or the runner's own for a live launch. */
  paths: RunnerPaths;
  vendorHomes: Record<Vendor, string>;
  clone: string;
  agflow: AgflowCommand;
  launch: AgentLaunch;
  cleanup(): void;
}

/**
 * A launch like the runner's: a git clone, a base checkout and a private tmpDir in a scratch directory. Its layout
 * is a scratch AGFLOW_HOME, or for a live launch the runner's own, while the clone stays outside the real work root.
 */
export function scratchLaunch(options: ScratchLaunchOptions): ScratchLaunch {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agflow-record-')));
  const scratchPaths = runnerPaths(join(root, 'agflow'));
  const home = options.live ? homedir() : join(root, 'home');
  let paths = scratchPaths;
  let homes: Record<Vendor, string> = { claude: scratchPaths.homes.claude, codex: scratchPaths.homes.codex };
  if (options.live) {
    // The runner's Claude home as M2b gives it: the CLI finds its login by that exact CLAUDE_CONFIG_DIR string.
    paths = runnerPaths(options.runnerHome ?? agflowHome());
    homes = vendorHomes(loadRunnerConfig(paths.config), paths);
    liveClaudeBinary(paths);
  }
  const clone = scratchPaths.clone('p', 'T-1-a1');
  const baseCheckout = scratchPaths.baseCheckout('p', '000000000000');
  for (const dir of [home, clone, baseCheckout, homes.claude]) mkdirSync(dir, { recursive: true });
  ensureClaudeEmptyDir(homes.claude);
  const git = Bun.spawnSync(['git', 'init', '-q', clone], { env: { PATH: '/usr/bin:/bin', HOME: home } });
  if (git.exitCode !== 0) throw new Error(`git init failed: ${git.stderr.toString()}`);
  writeFileSync(join(clone, 'README.md'), '# Scratch project\n');
  if (!options.live) {
    const link = join(paths.runner, vendorBinary('claude', CLAUDE_CLI_VERSION));
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(resolve(options.bin), link);
  }
  const claudeHome = homes.claude;
  const tmpDir = makeAttemptTmpDir();
  const agflow = options.agflow ?? STUB_AGFLOW;
  const env: Record<string, string> = {
    HOME: home,
    USER: process.env.USER ?? 'agent',
    LOGNAME: process.env.LOGNAME ?? process.env.USER ?? 'agent',
    LANG: 'en_US.UTF-8',
    SHELL: process.env.SHELL ?? '/bin/zsh',
    TERM: 'dumb',
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    NODE_USE_SYSTEM_CA: '1',
    CLAUDE_CONFIG_DIR: claudeHome,
    CLAUDE_CODE_TMPDIR: tmpDir,
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
    DISABLE_AUTOUPDATER: '1',
    AGFLOW_CLONE: clone,
    ...options.env,
  };
  const launch: AgentLaunch = {
    attemptId: 'T-1-a1',
    role: 'worker',
    model: options.model,
    cliVersion: CLAUDE_CLI_VERSION,
    clone,
    baseCheckout,
    projectConfigVerified: true,
    tmpDir,
    env,
    bridge: {
      command: agflow.command,
      args: [...agflow.args, 'mcp', '--vendor', 'claude', '--runner'],
      env: { AGFLOW_CLONE: clone },
      tools: STUB_BRIDGE_TOOLS,
    },
    profile: options.profile ?? standardProfile,
    brief: stubBrief(clone),
    firstPrompt: '',
    resume: null,
    logFile: join(root, 'attempt.log'),
    registerProcess: () => {},
  };
  return {
    root,
    paths,
    vendorHomes: homes,
    clone,
    agflow,
    launch,
    cleanup: () => {
      // A live run leaves its scratch project directory in the runner's real Claude home; nothing else is there.
      if (options.live) rmSync(claudeProjectDir(claudeHome, clone), { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

/**
 * The runner's own pinned claude, which a live launch runs: buildQueryOptions takes the binary from the layout, and
 * nothing is linked into the real runner tree.
 */
export function liveClaudeBinary(paths: Pick<RunnerPaths, 'runner'>): string {
  const bin = join(paths.runner, vendorBinary('claude', CLAUDE_CLI_VERSION));
  if (!existsSync(bin)) throw new Error(`${bin} is missing; run bun run vendor:install`);
  return bin;
}

// ---------------------------------------------------------------------------------------------------------------
// Running a scenario

/** One JSON line between the SDK and the CLI: in goes to the CLI's stdin, out came from its stdout. */
export interface TeeEvent {
  dir: 'in' | 'out';
  frame: Json;
}

export interface ScenarioSession {
  /** Pushes a user message; gives its uuid. */
  send(text: string): string;
  /** The next frame from the CLI that matches, after the previous one this returned. */
  frame(match: (frame: Json) => boolean): Promise<Json>;
  /** The next session_state_changed idle: the turn and its trailing frames are done. */
  idle(): Promise<void>;
  interrupt(cancelQueued: boolean): Promise<void>;
}

export interface ClaudeScenario {
  name: string;
  /** The recording it writes under packages/testkit/fixtures/claude/. */
  fixture?: string;
  /** The transcript it writes under packages/runner/test/fixtures/claude/. */
  transcript?: string;
  /** The scripted server's answers; --live leaves them to the model, which the prompts instruct the same way. */
  handler: AnthropicHandler;
  /** The session the launch resumes, instead of starting a new one. */
  resume?: string;
  /**
   * The CLI ends before it answers initialize: drive is not run, no transcript is expected, and the recording's
   * startup ends with the CLI's stderr and exit code.
   */
  failsToStart?: boolean;
  /** CLAUDE_CODE_MAX_RETRIES for the capture; 0 by default. */
  maxRetries?: number;
  /** Only the scripted server's answers produce it, so --live skips it. */
  scripted?: boolean;
  /**
   * A recording no capture against the scripted server can produce (outline Q3), derived from what the capture
   * printed; its header says synthesised. --live records the real thing instead, when the account shows it.
   */
  synthesise?(recording: ClaudeRecording): ClaudeRecording;
  drive(session: ScenarioSession): Promise<void>;
}

export interface ScenarioRun {
  /** The id the session was started with, or the one it resumed. */
  sessionId: string;
  /** The id the last result named: /clear starts a new conversation. */
  finalSessionId: string;
  events: TeeEvent[];
  /** The uuids and texts of the user messages, in order. */
  sent: string[];
  sentTexts: string[];
  /** What the SDK answered to the CLI's hook_callback requests. */
  hookAnswers: Json[];
  /** The inputs the PreCompact and PostCompact callbacks got. */
  compactions: Json[];
  initialization: Json;
  settings: Json | null;
  exit: { code: number | null; signal: string | null } | null;
  stderr: string;
  /** Why the session never started, for a scenario that fails to start; null otherwise. */
  startError: string | null;
}

/** Runs one scenario through the SDK with buildQueryOptions and records every line both ways. */
export async function runScenario(scenario: ClaudeScenario, scratch: ScratchLaunch): Promise<ScenarioRun> {
  const events: TeeEvent[] = [];
  const waiters = new Set<() => void>();
  const notify = () => {
    for (const wake of [...waiters]) wake();
  };
  let stderr = '';
  let child: ChildProcess | null = null;
  const exited = Promise.withResolvers<{ code: number | null; signal: string | null }>();

  const tee = (dir: TeeEvent['dir'], text: string) => {
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      try {
        events.push({ dir, frame: JSON.parse(line) });
      } catch {
        events.push({ dir, frame: { type: 'unparsed', line } });
      }
    }
    notify();
  };

  const spawnClaudeCodeProcess = (options: SpawnOptions): SpawnedProcess => {
    const proc = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    child = proc;
    let pending = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      pending += chunk.toString('utf8');
      const end = pending.lastIndexOf('\n');
      if (end < 0) return;
      tee('out', pending.slice(0, end));
      pending = pending.slice(end + 1);
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-64_000);
    });
    const stdin = proc.stdin;
    if (stdin) {
      const write = stdin.write.bind(stdin) as (chunk: unknown, ...rest: unknown[]) => boolean;
      stdin.write = ((chunk: unknown, ...rest: unknown[]) => {
        tee('in', String(chunk));
        return write(chunk, ...rest);
      }) as typeof stdin.write;
    }
    proc.on('exit', (code, signal) => exited.resolve({ code, signal }));
    options.signal?.addEventListener('abort', () => killGroup(proc, 'SIGTERM'), { once: true });
    return proc as unknown as SpawnedProcess;
  };

  const compactions: Json[] = [];
  const compactionHook: HookCallback = async (input) => {
    compactions.push(input as Json);
    return {};
  };
  const launch: AgentLaunch =
    scenario.resume === undefined ? scratch.launch : { ...scratch.launch, resume: { sessionRef: scenario.resume } };
  const options = buildQueryOptions(launch, {
    agflow: scratch.agflow,
    paths: scratch.paths,
    vendorHomes: scratch.vendorHomes,
    autoOffered: false,
    spawnClaudeCodeProcess,
    compaction: { preCompact: compactionHook, postCompact: compactionHook },
  });
  const sessionId = (options.resume ?? options.sessionId) as string;

  const queue: SDKUserMessage[] = [];
  const inboxState: { wake: (() => void) | null; ended: boolean } = { wake: null, ended: false };
  async function* inbox(): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      const next = queue.shift();
      if (next) {
        yield next;
        continue;
      }
      if (inboxState.ended) return;
      await new Promise<void>((resolve) => {
        inboxState.wake = resolve;
      });
      inboxState.wake = null;
    }
  }

  const q = query({ prompt: inbox(), options });
  const pump = (async () => {
    for await (const _message of q) {
      // The frames are read from the tee; the SDK only has to keep reading.
    }
  })();

  const sent: string[] = [];
  const sentTexts: string[] = [];
  let cursor = 0;
  const frame = async (match: (frame: Json) => boolean): Promise<Json> => {
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
      const index = events.findIndex((event, at) => at >= cursor && event.dir === 'out' && match(event.frame));
      if (index >= 0) {
        cursor = index + 1;
        return (events[index] as TeeEvent).frame;
      }
      if (Date.now() > deadline) {
        throw new Error(`${scenario.name}: no matching frame within ${WAIT_MS} ms; stderr: ${stderr.slice(-2000)}`);
      }
      await new Promise<void>((resolve) => {
        const wake = () => {
          waiters.delete(wake);
          resolve();
        };
        waiters.add(wake);
        setTimeout(wake, 200);
      });
    }
  };
  const session: ScenarioSession = {
    send(value) {
      const uuid = randomUUID();
      sent.push(uuid);
      sentTexts.push(value);
      queue.push({ type: 'user', message: { role: 'user', content: value }, parent_tool_use_id: null, uuid });
      inboxState.wake?.();
      return uuid;
    },
    frame,
    idle: async () => {
      await frame((f) => f.type === 'system' && f.subtype === 'session_state_changed' && f.state === 'idle');
    },
    interrupt: async (cancelQueued) => {
      // cancelQueued is untyped in sdk.d.ts 0.3.285 (design 8.3).
      const interrupt = q.interrupt as (options?: { cancelQueued?: boolean }) => Promise<unknown>;
      await interrupt.call(q, cancelQueued ? { cancelQueued: true } : undefined);
    },
  };

  let initialization: Json = {};
  let settings: Json | null = null;
  let startError: string | null = null;
  try {
    try {
      initialization = (await q.initializationResult()) as Json;
    } catch (error) {
      if (!scenario.failsToStart) throw error;
      startError = (error as Error).message;
    }
    if (scenario.failsToStart && startError === null) throw new Error(`${scenario.name}: the session started`);
    if (startError === null) {
      // Untyped in sdk.d.ts, like cancelQueued; preflight reads the same answer.
      settings = await (q as unknown as { getSettings(): Promise<Json> }).getSettings().catch(() => null);
      await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }).catch(() => null);
      await scenario.drive(session);
    }
  } finally {
    inboxState.ended = true;
    inboxState.wake?.();
    q.close();
    const exit = await Promise.race([exited.promise, Bun.sleep(EXIT_WAIT_MS).then(() => null)]);
    if (exit === null && child) killGroup(child, 'SIGKILL');
    await pump.catch(() => {});
  }
  const exit = await Promise.race([exited.promise, Bun.sleep(1000).then(() => null)]);
  const hookRequests = new Set(
    events
      .filter((event) => event.dir === 'out' && event.frame.type === 'control_request')
      .map((event) => event.frame.request_id),
  );
  const hookAnswers = events
    .filter((event) => event.dir === 'in' && event.frame.type === 'control_response')
    .map((event) => event.frame.response as Json)
    .filter((response) => hookRequests.has(response.request_id));
  const results = events.filter((event) => event.dir === 'out' && event.frame.type === 'result');
  return {
    sessionId,
    finalSessionId: (results.at(-1)?.frame.session_id as string | undefined) ?? sessionId,
    events,
    sent,
    sentTexts,
    hookAnswers,
    compactions,
    initialization,
    settings,
    exit,
    stderr,
    startError,
  };
}

function killGroup(proc: ChildProcess, signal: NodeJS.Signals): void {
  if (proc.pid === undefined || proc.exitCode !== null) return;
  try {
    process.kill(-proc.pid, signal);
  } catch {
    proc.kill(signal);
  }
}

/**
 * The transcript of a session lies in the clone's project directory as the runner computes it (claudeProjectDir).
 * A pin that forms project directories differently would loosen the guard's transcript rule, so it fails here.
 */
export function assertTranscriptPlacement(claudeHome: string, clone: string, sessionId: string): string {
  const expected = join(claudeProjectDir(claudeHome, clone), `${sessionId}.jsonl`);
  if (existsSync(expected)) return expected;
  const projects = join(claudeHome, 'projects');
  const found = existsSync(projects)
    ? readdirSync(projects)
        .map((dir) => join(projects, dir, `${sessionId}.jsonl`))
        .filter((path) => existsSync(path))
    : [];
  throw new Error(
    `the transcript of session ${sessionId} is not under ${relative(claudeHome, expected)}` +
      `${found.length > 0 ? `; it is at ${found.map((path) => relative(claudeHome, path)).join(', ')}` : ''}. ` +
      'This looks like a pin that renames project directories: check claudeProjectSlug against the new CLI.',
  );
}

// ---------------------------------------------------------------------------------------------------------------
// From a run to a recording

/**
 * The recording of a run: the answers to the SDK's control requests, the frames, a $turn at each message that found
 * the CLI idle, $wait where a message or an interrupt arrived mid-turn, and $hook for each hook_callback. Each turn's
 * user message uuids become $USER_UUID_<n>, the model $MODEL and the permission mode $PERMISSION_MODE.
 */
export function assembleRecording(run: ScenarioRun, header: RecordingHeader): ClaudeRecording {
  const requests = new Map<string, string>();
  const callbacks = new Map<string, string>();
  const answers: Record<string, ControlAnswer> = {};
  const startup: RecordingStep[] = [];
  const turns: { steps: RecordingStep[]; users: string[] }[] = [];
  let current = startup;
  let idle = true;
  for (const { dir, frame } of run.events) {
    if (dir === 'in') {
      if (frame.type === 'control_request') {
        const subtype = String(frame.request?.subtype);
        requests.set(frame.request_id, subtype);
        if (subtype === 'initialize') {
          for (const [event, matchers] of Object.entries((frame.request.hooks ?? {}) as Json)) {
            for (const matcher of matchers as { hookCallbackIds: string[] }[]) {
              for (const id of matcher.hookCallbackIds) callbacks.set(id, event);
            }
          }
        }
        if (subtype === 'interrupt' && !idle) current.push({ wait: 'interrupt' });
      } else if (frame.type === 'user') {
        if (idle) {
          current = [];
          turns.push({ steps: current, users: [] });
          idle = false;
        } else {
          current.push({ wait: 'user' });
        }
        turns.at(-1)?.users.push(String(frame.uuid));
      }
      // The SDK's answers to hook callbacks are its own; the fake logs them.
      continue;
    }
    if (frame.type === 'control_response') {
      const subtype = requests.get(frame.response?.request_id);
      // The fake answers interrupts itself, from what it has queued.
      if (subtype !== undefined && subtype !== 'interrupt') {
        answers[subtype] =
          frame.response.subtype === 'success'
            ? { response: (frame.response.response ?? {}) as Json }
            : { error: String(frame.response.error) };
      }
      continue;
    }
    if (frame.type === 'control_request') {
      const request = frame.request as Json;
      const event = callbacks.get(request.callback_id);
      if (request.subtype !== 'hook_callback' || event === undefined) {
        throw new Error(`the CLI sent a ${request.subtype} control request the fake cannot replay`);
      }
      current.push({
        hook: {
          event,
          input: request.input as Json,
          ...(request.tool_use_id === undefined ? {} : { toolUseId: request.tool_use_id }),
        },
      });
      continue;
    }
    if (frame.type === 'keep_alive') continue;
    current.push({ frame });
    if (frame.type === 'system' && frame.subtype === 'session_state_changed' && frame.state === 'idle') idle = true;
  }
  if (run.startError !== null) {
    // The CLI ended by itself: what it wrote to stderr, then its exit.
    if (run.stderr !== '') startup.push({ stderr: run.stderr });
    if (run.exit?.code !== null && run.exit?.code !== undefined) startup.push({ exit: run.exit.code });
  }
  const template = (steps: RecordingStep[], users: string[]) =>
    steps.map((step) => mapStrings(step, (value, key) => templated(value, key, users, header)) as RecordingStep);
  return {
    header,
    answers,
    startup: template(startup, []),
    turns: turns.map((turn) => template(turn.steps, turn.users)),
  };
}

const MODE_KEYS = new Set(['permissionMode', 'permission_mode', 'current_permission_mode']);

function templated(value: string, key: string | null, users: string[], header: RecordingHeader): string {
  const user = users.indexOf(value);
  if (user >= 0) return `$USER_UUID_${user + 1}`;
  if (value === header.model) return '$MODEL';
  if (key !== null && MODE_KEYS.has(key) && value === header.permissionMode) return '$PERMISSION_MODE';
  return value;
}

/** Applies `change` to every string value and key; a value's key is passed along. */
function mapStrings(
  value: unknown,
  change: (value: string, key: string | null) => string,
  key: string | null = null,
): unknown {
  if (typeof value === 'string') return change(value, key);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, change, key));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [change(name, null), mapStrings(item, change, name)]),
    );
  }
  return value;
}

/**
 * A capture against the scripted server shows an API-key account. The fake's recordings show a subscription, as the
 * runner requires, with the synthetic account (the header says so).
 */
export function asSubscription(recording: ClaudeRecording): ClaudeRecording {
  const answers = structuredClone(recording.answers);
  const initialize = answers.initialize;
  if (initialize && 'response' in initialize) initialize.response.account = { ...SYNTHETIC_ACCOUNT };
  const usage = answers.get_usage;
  if (usage && 'response' in usage) usage.response.subscription_type = SYNTHETIC_ACCOUNT.subscriptionType;
  const keyless = (steps: RecordingStep[]) =>
    steps.map((step) => mapStrings(step, (value, key) => (key === 'apiKeySource' ? 'none' : value)) as RecordingStep);
  return {
    header: { ...recording.header, account: 'synthetic-subscription' },
    answers,
    startup: keyless(recording.startup),
    turns: recording.turns.map(keyless),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The managed policy

/** The settings source a Mac's managed (MDM) Claude Code policy arrives through. */
const POLICY_SOURCE = 'policySettings';

/**
 * Drops the recording Mac's managed policy from the get_settings answer: its source, the remote-control lock reason
 * it causes, and what it merged into `effective`, which is rebuilt from the remaining sources. An organisation's
 * configuration must not reach committed recordings, and no other Mac or CI would reproduce it (8.1: managedPolicy is
 * always false). The recorder cannot avoid reading the policy without bypassing it, so it strips it afterwards.
 */
export function stripManagedPolicy(recording: ClaudeRecording): ClaudeRecording {
  const answer = recording.answers.get_settings;
  if (answer === undefined || !('response' in answer)) return recording;
  const { remote_control_policy_lock_reason: _lockReason, ...response } = answer.response as Json;
  if (Array.isArray(response.sources)) {
    const sources = response.sources as Json[];
    const kept = sources.filter((source) => source.source !== POLICY_SOURCE);
    if (kept.length < sources.length) {
      response.sources = kept;
      response.effective = kept.reduce<Json>((merged, source) => mergeSettings(merged, source.settings ?? {}), {});
    }
  }
  return { ...recording, answers: { ...recording.answers, get_settings: { response } } };
}

/**
 * One settings layer over another, as the CLI merges its sources: objects merge, arrays concatenate without
 * duplicates, and the later layer wins for anything else.
 */
function mergeSettings(base: Json, layer: Json): Json {
  const merged: Json = { ...base };
  for (const [key, value] of Object.entries(layer)) {
    const before = merged[key];
    if (Array.isArray(before) && Array.isArray(value)) {
      const seen = new Set(before.map((item) => JSON.stringify(item)));
      merged[key] = [...before, ...value.filter((item) => !seen.has(JSON.stringify(item)))];
    } else if (isObject(before) && isObject(value)) {
      merged[key] = mergeSettings(before, value);
    } else {
      merged[key] = structuredClone(value);
    }
  }
  return merged;
}

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The recording the recorder writes for a run: assembled, rewritten into the synthetic subscription unless live,
 * without the managed policy, and redacted.
 */
export function recordingOf(
  run: ScenarioRun,
  header: RecordingHeader,
  scratch: ScratchLaunch,
  options: { live: boolean },
): ClaudeRecording {
  const assembled = assembleRecording(run, header);
  return redactRecording(stripManagedPolicy(options.live ? assembled : asSubscription(assembled)), {
    sessionId: run.sessionId,
    sessionPlaceholder: '$SESSION',
    paths: redactionPaths(scratch, scratch.clone),
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Redaction

export interface RedactionContext {
  /** The recorded session's id. */
  sessionId: string;
  /** What it becomes: $SESSION in recordings, a fixed id in transcripts. Other session ids get synthetic ids. */
  sessionPlaceholder: string;
  /** Path prefixes and what they become. A path target's slug form (as in project directory names) is replaced too. */
  paths: [string, string][];
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const API_KEY = /sk-ant-[A-Za-z0-9_-]+/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_KEYS = new Set(['session_id', 'sessionId', 'new_conversation_id']);
const ORGANISATION_KEY = /^organi[sz]ation(?:[_-]?(?:id|uuid|name))?$/i;
const SYNTHETIC_SESSION_PREFIX = '00000000-0000-4000-8000-';

const slug = (path: string) => path.replace(/[^A-Za-z0-9]/g, '-');

/** Redacts any JSON value; the same input gives the same output, and redacting twice changes nothing. */
export function redactValue(value: unknown, context: RedactionContext): unknown {
  const others = new Map<string, string>();
  collectSessions(value, context, others);
  const replacements: [string, string][] = [
    [context.sessionId, context.sessionPlaceholder],
    ...others,
    ...[...context.paths].sort((a, b) => b[0].length - a[0].length),
    ...context.paths
      .filter(([, to]) => to.startsWith('/'))
      .map(([from, to]): [string, string] => [slug(from), slug(to)])
      .sort((a, b) => b[0].length - a[0].length),
  ];
  const redactText = (input: string): string => {
    let output = input;
    for (const [from, to] of replacements) output = output.split(from).join(to);
    return output.replace(EMAIL, SYNTHETIC_ACCOUNT.email).replace(API_KEY, 'sk-ant-redacted');
  };
  const walk = (item: unknown, key: string | null): unknown => {
    if (typeof item === 'string') {
      return key !== null && ORGANISATION_KEY.test(key) ? SYNTHETIC_ACCOUNT.organization : redactText(item);
    }
    if (Array.isArray(item)) return item.map((entry) => walk(entry, key));
    if (typeof item === 'object' && item !== null) {
      return Object.fromEntries(Object.entries(item).map(([name, entry]) => [redactText(name), walk(entry, name)]));
    }
    return item;
  };
  return walk(value, null);
}

function collectSessions(value: unknown, context: RedactionContext, others: Map<string, string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectSessions(item, context, others);
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      if (
        SESSION_KEYS.has(key) &&
        typeof item === 'string' &&
        UUID.test(item) &&
        item !== context.sessionId &&
        !item.startsWith(SYNTHETIC_SESSION_PREFIX) &&
        !others.has(item)
      ) {
        others.set(item, `${SYNTHETIC_SESSION_PREFIX}${String(others.size + 1).padStart(12, '0')}`);
      }
      collectSessions(item, context, others);
    }
  }
}

export function redactRecording(recording: ClaudeRecording, context: RedactionContext): ClaudeRecording {
  return redactValue(recording, context) as ClaudeRecording;
}

function redactTranscript(text: string, context: RedactionContext): string {
  const lines = text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as unknown);
  return `${(redactValue(lines, context) as unknown[]).map((line) => JSON.stringify(line)).join('\n')}\n`;
}

/** What a scratch run's paths become: the clone $CWD, the scratch root, the repository, the owner's home. */
function redactionPaths(scratch: ScratchLaunch, clone: string | null): [string, string][] {
  const paths: [string, string][] = [
    // The runner's own layout, for a live launch; the scratch one lies under the root anyway.
    [scratch.paths.home, '/redacted/agflow'],
    [scratch.root, '/redacted'],
    [scratch.launch.tmpDir, '/tmp/agf/000000'],
    [realpathSync(scratch.launch.tmpDir), '/private/tmp/agf/000000'],
    [process.execPath, '/usr/local/bin/bun'],
    [REPO_ROOT, '/agflow'],
    [homedir(), '/Users/redacted'],
  ];
  return clone === null ? paths : [[clone, '$CWD'], ...paths];
}

// ---------------------------------------------------------------------------------------------------------------
// The scenarios. Their prompts say what to do, so --live gets the same calls from a real model.

const PROMPTS = {
  basic:
    'Run `echo hi` with Bash, then run `git push origin HEAD`, then call the agflow report_progress tool, ' +
    'then the agflow submit tool, and finish with one sentence.',
  slow: 'Run `sleep 2; echo slow` with Bash, then finish with one sentence.',
  note: 'A note for you while that runs: keep going.',
  long: 'Run `sleep 30` with Bash.',
  hello: 'Say hello in one word.',
  describe: 'Describe this repository in one sentence, without tools.',
  count: 'Count the files here with `ls | wc -l` in Bash, then say how many there are.',
  handoff: 'Write a handoff with the agflow write_handoff tool, then say that you did.',
};

const COMPACTION_SUMMARY = 'Summary: the agent said hello; nothing else happened.';

/** One prompt and its turn, as the outcome scenarios drive it. */
async function oneTurn(session: ScenarioSession): Promise<void> {
  session.send(PROMPTS.hello);
  await session.idle();
}

/** The reset the synthesised quota recordings name: a fixed time, in the epoch seconds rate_limit_event carries. */
export const SYNTHESISED_RESET = 1_900_000_000;
/** A usage-limit message as 2.1.285 words it (USAGE_LIMIT_PREFIXES in quota.ts). */
export const SYNTHESISED_LIMIT_TEXT = "You've hit your limit · resets 5pm (UTC)";
/** A usage-transition notice as 2.1.285 words it (USAGE_TRANSITION_PREFIXES in quota.ts). */
export const SYNTHESISED_OVERAGE_TEXT = "You're now using extra usage · your limit resets 5pm (UTC)";

/** Inserts frames before the first frame of each turn that matches. */
function insertBefore(
  recording: ClaudeRecording,
  match: (frame: Json) => boolean,
  frames: Json[],
  change: (frame: Json) => Json = (frame) => frame,
): ClaudeRecording {
  const turns = recording.turns.map((turn) => {
    const at = turn.findIndex((step) => 'frame' in step && match(step.frame));
    if (at < 0) throw new Error(`${recording.header.scenario}: no frame to synthesise around`);
    const steps = turn.map((step) => ('frame' in step ? { frame: change(step.frame as Json) } : step));
    return [...steps.slice(0, at), ...frames.map((frame) => ({ frame })), ...steps.slice(at)];
  });
  return { ...recording, turns };
}

const isApiErrorMessage = (frame: Json) => frame.type === 'assistant' && frame.message?.model === '<synthetic>';

/**
 * A limit hit from a captured 429: the rejected rate_limit_event a subscription gets first, then the CLI's usage-limit
 * message in place of the API error.
 */
export function synthesiseLimitHit(recording: ClaudeRecording): ClaudeRecording {
  const event = {
    type: 'rate_limit_event',
    rate_limit_info: {
      status: 'rejected',
      resetsAt: SYNTHESISED_RESET,
      rateLimitType: 'five_hour',
      utilization: 1,
      overageStatus: 'rejected',
      overageDisabledReason: 'org_level_disabled',
      isUsingOverage: false,
    },
    uuid: randomUUID(),
    session_id: '$SESSION',
  };
  return insertBefore(recording, isApiErrorMessage, [event], (frame) => {
    if (isApiErrorMessage(frame)) {
      return {
        ...frame,
        error: 'rate_limit',
        message: { ...frame.message, content: [{ type: 'text', text: SYNTHESISED_LIMIT_TEXT }] },
      };
    }
    return frame.type === 'result' ? { ...frame, result: SYNTHESISED_LIMIT_TEXT } : frame;
  });
}

/**
 * Paid usage in use from a captured turn: the rate_limit_event of a five-hour window that is used up while extra
 * usage goes on, and the CLI's notice, before the model's answer. The turn itself completes.
 */
export function synthesiseOverageInUse(recording: ClaudeRecording): ClaudeRecording {
  const event = {
    type: 'rate_limit_event',
    rate_limit_info: {
      status: 'rejected',
      resetsAt: SYNTHESISED_RESET,
      rateLimitType: 'five_hour',
      utilization: 1,
      overageStatus: 'allowed',
      isUsingOverage: true,
    },
    uuid: randomUUID(),
    session_id: '$SESSION',
  };
  const notice = {
    type: 'system',
    subtype: 'notification',
    key: 'limit-reached',
    text: SYNTHESISED_OVERAGE_TEXT,
    priority: 'immediate',
    uuid: randomUUID(),
    session_id: '$SESSION',
  };
  return insertBefore(recording, (frame) => frame.type === 'assistant', [event, notice]);
}

/** Answers compaction requests with a summary and leaves every other request to `main`. */
function withSummary(main: AnthropicHandler): AnthropicHandler {
  return (request) => (isCompaction(request) ? reply(COMPACTION_SUMMARY) : main(request));
}

export const CLAUDE_SCENARIOS: ClaudeScenario[] = [
  {
    name: 'preflight-ok',
    fixture: 'preflight-ok',
    // /clear is a local command: no request reaches any model.
    handler: rules(),
    drive: async (session) => {
      session.send('/clear');
      await session.idle();
    },
  },
  {
    name: 'turn-basic',
    fixture: 'turn-basic',
    handler: rules(
      { when: afterToolResult('toolu_basic_4'), reply: reply('The check printed hi, and the work is submitted.') },
      {
        when: afterToolResult('toolu_basic_3'),
        reply: reply(agflowTool({ tool: 'submit', args: { summary: 'Checked.' }, id: 'toolu_basic_4' })),
      },
      {
        when: afterToolResult('toolu_basic_2'),
        reply: reply(agflowTool({ tool: 'report_progress', args: { note: 'Checked.' }, id: 'toolu_basic_3' })),
      },
      {
        when: afterToolResult('toolu_basic_1'),
        reply: reply(bashTool({ command: 'git push origin HEAD', id: 'toolu_basic_2' })),
      },
      {
        when: userSays('Run `echo hi`'),
        reply: reply([text('Running the check.'), bashTool({ command: 'echo hi', id: 'toolu_basic_1' })]),
      },
    ),
    drive: async (session) => {
      session.send(PROMPTS.basic);
      await session.idle();
    },
  },
  {
    name: 'turn-delivery',
    fixture: 'turn-delivery',
    handler: rules(
      { when: afterToolResult('toolu_delivery_1'), reply: reply('Done, and I saw your note.') },
      {
        when: userSays('Run `sleep 2; echo slow`'),
        reply: reply([text('Running it.'), bashTool({ command: 'sleep 2; echo slow', id: 'toolu_delivery_1' })]),
      },
    ),
    drive: async (session) => {
      session.send(PROMPTS.slow);
      await session.frame(
        (f) => f.type === 'assistant' && f.message?.content?.some((block: Json) => block.type === 'tool_use'),
      );
      session.send(PROMPTS.note);
      await session.idle();
    },
  },
  {
    name: 'interrupt',
    fixture: 'interrupt',
    handler: rules({
      when: userSays('Run `sleep 30`'),
      reply: reply([text('Running it.'), bashTool({ command: 'sleep 30', id: 'toolu_interrupt_1' })]),
    }),
    drive: async (session) => {
      session.send(PROMPTS.long);
      await session.frame(
        (f) => f.type === 'assistant' && f.message?.content?.some((block: Json) => block.type === 'tool_use'),
      );
      // Past the PreToolUse hook, while the command runs.
      await Bun.sleep(1500);
      await session.interrupt(true);
      await session.idle();
    },
  },
  {
    name: 'compaction',
    fixture: 'compaction',
    handler: withSummary(rules({ when: userSays(PROMPTS.hello), reply: reply('Hello.') })),
    drive: async (session) => {
      session.send(PROMPTS.hello);
      await session.idle();
      session.send('/compact');
      await session.idle();
    },
  },
  {
    // A session that never ran a turn has no transcript: 2.1.285 prints an error result and exits 1 before it
    // answers initialize (8.4, 7.4).
    name: 'resume-not-found',
    fixture: 'resume-not-found',
    handler: rules(),
    resume: randomUUID(),
    failsToStart: true,
    drive: async () => {},
  },
  {
    // Any other resume failure; a reference that is no session id is one the CLI refuses without a model.
    name: 'resume-failure',
    fixture: 'resume-failure',
    handler: rules(),
    resume: 'not-a-session',
    failsToStart: true,
    drive: async () => {},
  },
  // Vendor outcomes (8.3, 6.10), captured where the scripted server can produce them.
  {
    name: 'auth-expired',
    fixture: 'auth-expired',
    scripted: true,
    handler: rules({ when: userSays(PROMPTS.hello), reply: fail(401) }),
    drive: oneTurn,
  },
  {
    name: 'context-overflow',
    fixture: 'context-overflow',
    scripted: true,
    // 400 "prompt is too long".
    handler: rules({ when: userSays(PROMPTS.hello), reply: fail(400) }),
    drive: oneTurn,
  },
  {
    name: 'policy-refusal',
    fixture: 'policy-refusal',
    scripted: true,
    // Every request is refused: 2.1.285 retries a refusal once, then gives up.
    handler: rules({ when: [], reply: refusal('I cannot help with that.') }),
    drive: oneTurn,
  },
  {
    name: 'api-retry-429',
    fixture: 'api-retry-429',
    scripted: true,
    maxRetries: 1,
    handler: rules({ when: [], reply: fail(429) }),
    drive: oneTurn,
  },
  {
    name: 'vendor-error',
    fixture: 'vendor-error',
    scripted: true,
    maxRetries: 1,
    handler: rules({ when: [], reply: fail(529) }),
    drive: oneTurn,
  },
  {
    name: 'limit-hit',
    fixture: 'limit-hit',
    handler: rules({ when: userSays(PROMPTS.hello), reply: fail(429) }),
    synthesise: synthesiseLimitHit,
    drive: oneTurn,
  },
  {
    name: 'overage-in-use',
    fixture: 'overage-in-use',
    handler: rules({ when: userSays(PROMPTS.hello), reply: reply('Hello.') }),
    synthesise: synthesiseOverageInUse,
    drive: oneTurn,
  },
  {
    name: 'session',
    transcript: 'session',
    handler: rules(
      { when: afterToolResult('toolu_session_2'), reply: reply('The handoff is written.') },
      { when: afterToolResult('toolu_session_1'), reply: reply('There is one file.') },
      { when: userSays(PROMPTS.describe), reply: reply('The repository holds a README and nothing else.') },
      {
        when: userSays(PROMPTS.count),
        reply: reply([text('Counting.'), bashTool({ command: 'ls | wc -l', id: 'toolu_session_1' })]),
      },
      {
        when: userSays(PROMPTS.handoff),
        reply: reply(
          agflowTool({ tool: 'write_handoff', args: { note: 'The README is all there is.' }, id: 'toolu_session_2' }),
        ),
      },
      // The last turn is interrupted while its command runs, so the transcript ends with a tool-only turn.
      {
        when: userSays('Run `sleep 30`'),
        reply: reply(bashTool({ command: 'sleep 30', id: 'toolu_session_3' })),
      },
    ),
    drive: async (session) => {
      for (const prompt of [PROMPTS.describe, PROMPTS.count, PROMPTS.handoff]) {
        session.send(prompt);
        await session.idle();
      }
      session.send(PROMPTS.long);
      await session.frame(
        (f) => f.type === 'assistant' && f.message?.content?.some((block: Json) => block.type === 'tool_use'),
      );
      await Bun.sleep(1500);
      await session.interrupt(false);
      await session.idle();
    },
  },
];

// ---------------------------------------------------------------------------------------------------------------
// The recorder

export interface RecordClaudeStreamOptions {
  /** The pinned claude; findClaudeBinary's by default. */
  bin?: string;
  /** Scenario names; all by default. */
  only?: string[];
  live?: boolean;
  model?: string;
  fixturesDir?: string;
  transcriptsDir?: string;
  log?: (line: string) => void;
}

/** Records each scenario and writes its redacted recording or transcript; gives the files written. */
export async function recordClaudeStream(options: RecordClaudeStreamOptions = {}): Promise<string[]> {
  const log = options.log ?? ((line: string) => console.log(line));
  if (options.live && options.bin) throw new Error("--live runs the runner's own pinned claude; leave out --bin");
  const bin = options.live ? liveClaudeBinary(runnerPaths(agflowHome())) : (options.bin ?? locateClaude());
  const version = await readClaudeVersion(bin, CLAUDE_CLI_VERSION);
  if (!version.ok) throw new Error(`${bin}: ${version.problem}`);
  const model = options.model ?? 'claude-sonnet-5-5';
  const scenarios = CLAUDE_SCENARIOS.filter((scenario) => !options.only || options.only.includes(scenario.name));
  const unknown = (options.only ?? []).filter((name) => !CLAUDE_SCENARIOS.some((scenario) => scenario.name === name));
  if (unknown.length > 0) throw new Error(`no scenario named ${unknown.join(', ')}`);
  const written: string[] = [];
  for (const scenario of scenarios) {
    if (options.live && scenario.scripted) {
      log(`skipping ${scenario.name}: only the scripted server produces it`);
      continue;
    }
    log(`recording ${scenario.name}${options.live ? ' (live)' : ''}`);
    const server = options.live ? null : await startScriptedAnthropic({ handler: scenario.handler });
    const proxy = options.live ? null : await startRefusingProxy();
    const env =
      server && proxy
        ? claudeTestEnv({ baseUrl: server.url, proxyUrl: proxy.url, maxRetries: scenario.maxRetries })
        : {};
    const scratch = scratchLaunch({ bin, model, env, live: options.live });
    try {
      const run = await runScenario(scenario, scratch);
      const transcript = scenario.failsToStart
        ? null
        : assertTranscriptPlacement(scratch.vendorHomes.claude, scratch.clone, run.finalSessionId);
      if (scenario.fixture) {
        const header: RecordingHeader = {
          cliVersion: version.version,
          source: 'captured',
          scenario: scenario.name,
          account: options.live ? 'live' : 'synthetic-subscription',
          model,
          permissionMode: effectivePermissionMode(scratch.launch.profile, false),
        };
        const captured = recordingOf(run, header, scratch, { live: options.live === true });
        const recording =
          scenario.synthesise && !options.live
            ? scenario.synthesise({ ...captured, header: { ...captured.header, source: 'synthesised' } })
            : captured;
        const path = join(options.fixturesDir ?? CLAUDE_FIXTURES_DIR, `${scenario.fixture}.jsonl`);
        mkdirSync(dirname(path), { recursive: true });
        writeRecording(path, recording);
        written.push(path);
      }
      if (scenario.transcript && transcript !== null) {
        const path = join(options.transcriptsDir ?? CLAUDE_TRANSCRIPT_FIXTURES_DIR, `${scenario.transcript}.jsonl`);
        mkdirSync(dirname(path), { recursive: true });
        const context = {
          sessionId: run.finalSessionId,
          sessionPlaceholder: TRANSCRIPT_SESSION_ID,
          paths: redactionPaths(scratch, null),
        };
        writeFileSync(path, redactTranscript(readFileSync(transcript, 'utf8'), context));
        written.push(path);
      }
      for (const refused of proxy?.refused ?? []) {
        log(`  the refusing proxy refused ${refused.method} ${refused.target}`);
      }
      for (const request of server?.unmatched ?? []) {
        log(`  unscripted request: ${request.endpoint} ${request.userTexts.at(-1)?.slice(0, 80) ?? ''}`);
      }
    } finally {
      scratch.cleanup();
      await server?.close();
      await proxy?.close();
    }
  }
  return written;
}

function locateClaude(): string {
  const found = findClaudeBinary(CLAUDE_CLI_VERSION);
  if (found.path === null) throw new Error(found.reason);
  return found.path;
}

function flagValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const live = args.includes('--live');
  if (live) {
    console.log(
      "--live runs real turns on the runner's own Claude login and uses its subscription quota; " +
        'the prompts ask for the same calls the scripted server makes.',
    );
  }
  const written = await recordClaudeStream({
    live,
    only: flagValue(args, '--only')?.split(','),
    model: flagValue(args, '--model'),
    bin: flagValue(args, '--bin'),
  });
  for (const path of written) console.log(`wrote ${relative(process.cwd(), path)}`);
}
