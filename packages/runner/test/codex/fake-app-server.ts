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
