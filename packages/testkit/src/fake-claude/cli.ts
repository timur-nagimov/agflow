// The fake claude's program (bin/fake-claude runs it). It speaks the stream-json control protocol of 2.1.285 on
// stdin and stdout: it answers control requests from the recording, replays one recorded turn per user message that
// finds it idle, and reacts to interrupts, hook answers, stdin EOF and SIGTERM as the real CLI does. Everything it
// receives goes to FAKE_CLAUDE_LOG for the tests to check.
import { randomUUID } from 'node:crypto';
import { appendFileSync, realpathSync } from 'node:fs';
import { CLAUDE_CLI_VERSION } from '@agflow/runner/src/adapters/claude/pin';
import type { FakeClaudeLogRecord } from './index';
import { type ClaudeRecording, loadRecording, type RecordingStep } from './recording';

type Json = Record<string, unknown>;

interface UserMessage {
  uuid: string;
}

class Aborted extends Error {}

/** --flag value and --flag=value. */
function flag(argv: string[], name: string): string | null {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    if (arg === name) return argv[index + 1] ?? null;
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  }
  return null;
}

const PLACEHOLDER = /\$(SESSION|LAST_USER_UUID|USER_UUID_(\d+)|UUID|CWD|MODEL|PERMISSION_MODE)\b/g;

class FakeClaude {
  private readonly session: string;
  private readonly model: string;
  private readonly permissionMode: string;
  private readonly cwd = realpathSync(process.cwd());
  /** The callback ids the SDK registered at initialize, by hook event: the first of each event's first matcher. */
  private readonly callbacks = new Map<string, string>();
  private readonly queue: UserMessage[] = [];
  private readonly pendingHooks = new Map<string, (answer: Json) => void>();
  private nextTurn = 0;
  private running = false;
  /** The user messages the running turn has taken, in order. */
  private turnUsers: UserMessage[] = [];
  private turnAbort: AbortController | null = null;
  private userWaiter: ((message: UserMessage) => void) | null = null;
  private interruptWaiter: (() => void) | null = null;
  private ignoreEof = false;
  private eof = false;

  constructor(
    private readonly recording: ClaudeRecording,
    private readonly logPath: string | null,
    argv: string[],
  ) {
    this.session = flag(argv, '--session-id') ?? flag(argv, '--resume') ?? randomUUID();
    this.model = flag(argv, '--model') ?? recording.header.model;
    this.permissionMode = flag(argv, '--permission-mode') ?? recording.header.permissionMode;
  }

  log(entry: FakeClaudeLogRecord): void {
    if (this.logPath) appendFileSync(this.logPath, `${JSON.stringify({ at: Date.now(), ...entry })}\n`);
  }

  async exit(code: number): Promise<never> {
    this.log({ kind: 'exit', code });
    await new Promise<void>((resolve) => process.stdout.write('', () => resolve()));
    process.exit(code);
  }

  private write(frame: Json): void {
    process.stdout.write(`${JSON.stringify(frame)}\n`);
  }

  private fill(value: unknown): unknown {
    if (typeof value === 'string') return this.fillText(value);
    if (Array.isArray(value)) return value.map((item) => this.fill(item));
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [this.fillText(key), this.fill(item)]));
    }
    return value;
  }

  private fillText(text: string): string {
    return text.replace(PLACEHOLDER, (whole, name: string, nth: string | undefined) => {
      if (nth !== undefined) return this.turnUsers[Number(nth) - 1]?.uuid ?? whole;
      switch (name) {
        case 'SESSION':
          return this.session;
        case 'LAST_USER_UUID':
          return this.turnUsers.at(-1)?.uuid ?? whole;
        case 'UUID':
          return randomUUID();
        case 'CWD':
          return this.cwd;
        case 'MODEL':
          return this.model;
        default:
          return this.permissionMode;
      }
    });
  }

  async onLine(message: Json): Promise<void> {
    switch (message.type) {
      case 'control_request':
        return this.onControl(String(message.request_id), (message.request ?? {}) as Json);
      case 'control_response': {
        const response = (message.response ?? {}) as Json;
        this.pendingHooks.get(String(response.request_id))?.(response);
        return;
      }
      case 'user': {
        this.log({ kind: 'user', message });
        const user = { uuid: typeof message.uuid === 'string' ? message.uuid : randomUUID() };
        if (this.userWaiter) {
          const wake = this.userWaiter;
          this.userWaiter = null;
          wake(user);
        } else {
          this.queue.push(user);
          if (!this.running) void this.runNextTurn();
        }
        return;
      }
      default:
        // keep_alive, control_cancel_request and frames the fake has no use for.
        return;
    }
  }

  private async onControl(requestId: string, request: Json): Promise<void> {
    this.log({ kind: 'control', requestId, request });
    const subtype = String(request.subtype);
    if (subtype === 'initialize') this.registerHooks(request.hooks);
    if (subtype === 'interrupt') return this.onInterrupt(requestId, request.cancel_queued === true);
    if (subtype === 'initialize') await this.runSteps(this.recording.startup, null);
    const answer = this.recording.answers[subtype];
    if (answer === undefined) {
      this.write({
        type: 'control_response',
        response: { subtype: 'error', request_id: requestId, error: `fake-claude has no answer for ${subtype}` },
      });
    } else if ('error' in answer) {
      this.write({
        type: 'control_response',
        response: { subtype: 'error', request_id: requestId, error: answer.error },
      });
    } else {
      this.write({
        type: 'control_response',
        response: { subtype: 'success', request_id: requestId, response: this.fill(answer.response) },
      });
    }
  }

  private registerHooks(hooks: unknown): void {
    if (typeof hooks !== 'object' || hooks === null) return;
    for (const [event, matchers] of Object.entries(hooks)) {
      const id = (matchers as { hookCallbackIds?: string[] }[] | undefined)?.[0]?.hookCallbackIds?.[0];
      if (id) this.callbacks.set(event, id);
    }
  }

  private onInterrupt(requestId: string, cancelQueued: boolean): void {
    const cancelled = cancelQueued ? this.queue.splice(0).map((user) => user.uuid) : [];
    const stillQueued = this.queue.map((user) => user.uuid);
    this.write({
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response: { still_queued: stillQueued, cancelled } },
    });
    if (!this.running) return;
    if (this.interruptWaiter) {
      // The recording holds what the CLI printed after this interrupt.
      const wake = this.interruptWaiter;
      this.interruptWaiter = null;
      wake();
    } else {
      this.turnAbort?.abort();
    }
  }

  async onEof(): Promise<void> {
    this.eof = true;
    this.log({ kind: 'eof', midTurn: this.running, ignored: this.running && this.ignoreEof });
    if (this.running && this.ignoreEof) return;
    await this.exit(0);
  }

  private async runNextTurn(): Promise<void> {
    const user = this.queue.shift();
    if (!user) return;
    this.running = true;
    this.turnUsers = [user];
    this.ignoreEof = false;
    this.turnAbort = new AbortController();
    const steps = this.recording.turns[this.nextTurn];
    this.nextTurn += 1;
    try {
      if (steps === undefined) {
        this.log({ kind: 'note', text: `the recording has no turn ${this.nextTurn}` });
        this.write(this.endFrame('error_during_execution', `fake-claude: the recording has no turn ${this.nextTurn}`));
      } else {
        await this.runSteps(steps, this.turnAbort.signal);
      }
    } catch (error) {
      if (!(error instanceof Aborted)) throw error;
      this.writeAborted();
    }
    this.running = false;
    this.turnAbort = null;
    this.userWaiter = null;
    this.interruptWaiter = null;
    if (this.eof) await this.exit(0);
    if (this.queue.length > 0) void this.runNextTurn();
  }

  private async runSteps(steps: RecordingStep[], signal: AbortSignal | null): Promise<void> {
    for (const step of steps) {
      if (signal?.aborted) throw new Aborted();
      if ('frame' in step) {
        this.write(this.fill(step.frame) as Json);
      } else if ('wait' in step) {
        if (step.wait === 'user') {
          const queued = this.queue.shift();
          const user = queued ?? (await this.until<UserMessage>(signal, (wake) => (this.userWaiter = wake)));
          this.turnUsers.push(user);
        } else {
          await this.until<void>(signal, (wake) => (this.interruptWaiter = wake));
        }
      } else if ('sleep' in step) {
        await this.until<void>(signal, (wake) => setTimeout(wake, step.sleep));
      } else if ('hook' in step) {
        await this.fireHook(step.hook, signal);
      } else if ('stderr' in step) {
        const text = this.fillText(step.stderr);
        await new Promise<void>((resolve) => process.stderr.write(text, () => resolve()));
      } else if ('exit' in step) {
        await this.exit(step.exit);
      } else {
        this.ignoreEof = true;
      }
    }
  }

  /** Resolves when `arm`'s callback is called, or rejects with Aborted when the turn is interrupted. */
  private until<T>(signal: AbortSignal | null, arm: (wake: (value: T) => void) => void): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(new Aborted());
      signal?.addEventListener('abort', abort, { once: true });
      arm((value) => {
        signal?.removeEventListener('abort', abort);
        resolve(value);
      });
    });
  }

  private async fireHook(
    hook: { event: string; input: Record<string, unknown>; toolUseId?: string },
    signal: AbortSignal | null,
  ): Promise<void> {
    const callbackId = this.callbacks.get(hook.event);
    if (callbackId === undefined) {
      this.log({ kind: 'note', text: `no ${hook.event} callback was registered at initialize; the hook is skipped` });
      return;
    }
    const requestId = randomUUID();
    const answer = this.until<Json>(signal, (wake) => this.pendingHooks.set(requestId, wake));
    this.write({
      type: 'control_request',
      request_id: requestId,
      request: {
        subtype: 'hook_callback',
        callback_id: callbackId,
        input: this.fill(hook.input),
        ...(hook.toolUseId === undefined ? {} : { tool_use_id: this.fillText(hook.toolUseId) }),
      },
    });
    try {
      this.log({ kind: 'hook_answer', event: hook.event, callbackId, answer: await answer });
    } finally {
      this.pendingHooks.delete(requestId);
    }
  }

  /** What 2.1.285 prints when an interrupt stops a turn that was running a tool. */
  private writeAborted(): void {
    this.write({ ...this.endFrame('error_during_execution', null), terminal_reason: 'aborted_tools' });
    for (const user of this.turnUsers) {
      this.write({
        type: 'command_lifecycle',
        command_uuid: user.uuid,
        state: 'cancelled',
        uuid: randomUUID(),
        session_id: this.session,
      });
    }
    // The SDK ends a run on idle after a result; without it, closing the input would wait for a run that never ends.
    this.write({
      type: 'system',
      subtype: 'session_state_changed',
      state: 'idle',
      sdk_host_only: true,
      uuid: randomUUID(),
      session_id: this.session,
    });
  }

  private endFrame(subtype: string, error: string | null): Json {
    return {
      type: 'result',
      subtype,
      is_error: true,
      duration_ms: 0,
      duration_api_ms: 0,
      num_turns: 0,
      result: null,
      stop_reason: null,
      session_id: this.session,
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      modelUsage: {},
      permission_denials: [],
      errors: error === null ? [] : [error],
      terminal_reason: null,
      uuid: randomUUID(),
      user_message_uuid: this.turnUsers[0]?.uuid ?? null,
      user_message_uuids: this.turnUsers.map((user) => user.uuid),
    };
  }
}

async function main(argv: string[]): Promise<void> {
  if (argv.includes('--version')) {
    process.stdout.write(`${process.env.FAKE_CLAUDE_VERSION || CLAUDE_CLI_VERSION} (Claude Code)\n`);
    return;
  }
  const recordingPath = process.env.FAKE_CLAUDE_RECORDING;
  if (!recordingPath) {
    process.stderr.write('fake-claude: FAKE_CLAUDE_RECORDING is not set\n');
    process.exit(2);
  }
  const fake = new FakeClaude(loadRecording(recordingPath), process.env.FAKE_CLAUDE_LOG || null, argv);
  // Names only: the values may hold secrets, and the tests ask only what reached the process.
  fake.log({ kind: 'argv', argv, env: Object.keys(process.env).sort() });
  process.on('SIGTERM', () => void fake.exit(143));
  // One line at a time, in order: an answer can depend on what an earlier line set up.
  let buffer = '';
  let chain = Promise.resolve();
  const decoder = new TextDecoder();
  for await (const chunk of process.stdin) {
    buffer += decoder.decode(chunk as Uint8Array, { stream: true });
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf('\n');
      if (line === '') continue;
      const message = JSON.parse(line) as Json;
      chain = chain.then(() => fake.onLine(message));
    }
  }
  await chain;
  await fake.onEof();
}

await main(process.argv.slice(2));
