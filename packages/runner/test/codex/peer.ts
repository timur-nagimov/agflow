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
 * and only a group kill ends it; { detached: true } starts it in a group of its own, as an escaped process, so not
 * even that ends it. Its notify lines are written to that stdout 100 ms after it starts, so a crash step right after
 * it delivers them after the peer's exit.
 */
export type ScriptedStep =
  | { notify: ServerNotification }
  | { request: ScriptedServerRequest; afterAnswer?: ScriptedStep[] }
  | { delayMs: number }
  | { stderr: string }
  | { spawnPipeHolder: true | { detached?: true; notify?: ServerNotification[] } }
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
