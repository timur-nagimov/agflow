// The fake adapter (design 15): a VendorAdapter whose agent is a real child process, fake-agent.ts run with Bun in
// its own process group, so runner tests exercise real signals, groups, pipes and git. The agent follows a script
// of turns and speaks JSON lines: AgentEvents on stdout, inputs on stdin. The basic fake keeps no transcript and
// raises no approvals.
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { TEST_ACCOUNT_ID, type Vendor, type VendorQuota } from '@agflow/core';
import type {
  AgentEvent,
  AgentLaunch,
  AgentSession,
  ExitInfo,
  PreflightResult,
  TerminalTool,
  VendorAdapter,
} from '@agflow/runner';

/** The agent program; it runs with the Bun that runs the tests. */
export const FAKE_AGENT_PATH = join(import.meta.dir, 'fake-agent.ts');

/** One step of a turn. Every step but text, sleep, log and exit is a tool call. */
export type FakeStep =
  /** Writes a file under the clone, or deletes it (null). */
  | { do: 'write'; path: string; content: string | null }
  /** `git add -A` and `git commit` in the clone, with the agent's environment and so its git identity. */
  | { do: 'commit'; message: string }
  /**
   * A shell command run in its own process group in the clone, as a vendor CLI runs its tools. wait false reports
   * the tool done at once and leaves the command running, even after the agent exits. inheritPipes gives the command
   * the agent's stdout and stderr, so it keeps them open after the agent exits, as an escaped grandchild does.
   */
  | { do: 'tool'; command: string; wait?: boolean; inheritPipes?: boolean }
  /** A bridge tool that ends or hands over the work; the answer is scripted: ok by default. */
  | { do: 'terminal'; tool: TerminalTool; answer?: 'ok' | 'refused' | 'hub_unreachable' }
  | { do: 'text'; text: string }
  /** Interrupt cuts it short. */
  | { do: 'sleep'; ms: number }
  /** A line on stderr, which the adapter drains into the attempt log. */
  | { do: 'log'; text: string }
  /** Ends the process at once with this code. */
  | { do: 'exit'; code: number };

export interface FakeScript {
  /**
   * The turns in order: the first prompt starts the first, and each later input taken while idle starts the next.
   * Inputs that arrive mid-turn are taken at the next step boundary, as Claude folds them in. A turn past the end
   * of the list has no steps.
   */
  turns: FakeStep[][];
  /** Keep running the current turn when stdin ends mid-turn, and exit after it (Claude); by default EOF ends it. */
  ignoreEofMidTurn?: boolean;
  /** An interrupt neither ends the turn nor cuts its running step short; cancelQueued still drops queued inputs. */
  ignoreInterrupt?: boolean;
  /** SIGTERM is ignored; by default the agent exits 143 on it, as a SIGTERMed claude does. */
  ignoreSigterm?: boolean;
  /** Reported in started; 'acceptEdits' by default. */
  permissionMode?: string | null;
}

/** What the adapter hands the agent, in a file its one argument names. */
export interface FakeAgentConfig {
  script: FakeScript;
  sessionRef: string;
  model: string;
  cliVersion: string;
  /** null on a resume: the agent waits for a message. */
  firstPrompt: string | null;
}

/** A line on the agent's stdin. */
export type FakeAgentInput =
  | { t: 'message'; id: string; text: string; authority: 'person' | 'agent' | 'system' }
  | { t: 'interrupt'; cancelQueued: boolean };

export interface FakeAdapterOptions {
  /** 'claude' by default. */
  vendor?: Vendor;
  /** The version preflight reports; '0.0.0-fake' by default. */
  cliVersion?: string;
  /** What preflight reports over the defaults: ready, no problem, no account, no owner install. */
  facts?: Partial<Omit<PreflightResult['facts'], 'vendor' | 'cliVersion'>>;
  quota?: VendorQuota | null;
  /** Section 15.1: ready, problem and plan 'test mode', TEST_ACCOUNT_ID. */
  skipAuthChecks?: boolean;
  /** One script for every launch, or one per launch. */
  script: FakeScript | ((launch: AgentLaunch) => FakeScript);
}

export class FakeAdapter implements VendorAdapter {
  readonly vendor: Vendor;
  /** Every launch started, in order. */
  readonly launches: AgentLaunch[] = [];

  constructor(private readonly options: FakeAdapterOptions) {
    this.vendor = options.vendor ?? 'claude';
  }

  async preflight(): Promise<PreflightResult> {
    const base = {
      vendor: this.vendor,
      cliVersion: this.options.cliVersion ?? '0.0.0-fake',
      ownerCliVersion: null,
      ready: true,
      problem: null,
      accountId: null,
      plan: null,
      managedPolicy: false,
      ...this.options.facts,
    };
    const facts = this.options.skipAuthChecks
      ? { ...base, ready: true, problem: 'test mode', plan: 'test mode', accountId: TEST_ACCOUNT_ID }
      : base;
    return { facts, quota: this.options.quota ?? null, weakened: [] };
  }

  async start(launch: AgentLaunch): Promise<AgentSession> {
    const script = typeof this.options.script === 'function' ? this.options.script(launch) : this.options.script;
    const config: FakeAgentConfig = {
      script,
      sessionRef: launch.resume?.sessionRef ?? randomUUID(),
      model: launch.model,
      cliVersion: launch.cliVersion,
      firstPrompt: launch.resume ? null : launch.firstPrompt,
    };
    // The config travels in a file: a large script would pass the argument size limit (1 MiB on macOS).
    const configDir = await mkdtemp(join(tmpdir(), 'agflow-fake-agent-'));
    const configFile = join(configDir, 'config.json');
    await writeFile(configFile, JSON.stringify(config));
    // Bun would otherwise load a .env file and a bunfig.toml from the clone, so the repository's content would
    // change the agent's environment or run code in it before the script starts.
    const argv = [process.execPath, '--no-env-file', '--config=/dev/null', FAKE_AGENT_PATH, configFile];
    let proc: FakeProcess;
    try {
      proc = Bun.spawn(argv, {
        cwd: launch.clone,
        env: launch.env,
        detached: true,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });
    } catch (error) {
      await rm(configDir, { recursive: true, force: true });
      throw error;
    }
    try {
      launch.registerProcess(proc.pid);
    } catch (error) {
      // Unregistered, nothing could ever stop it: it must not go on playing its script in the clone.
      try {
        process.kill(-proc.pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
      await proc.exited;
      await rm(configDir, { recursive: true, force: true });
      throw error;
    }
    this.launches.push(launch);
    const removeConfig = () => rm(configDir, { recursive: true, force: true });
    return new FakeSession(proc, config.sessionRef, launch.logFile, removeConfig);
  }

  async readTranscriptTail(_input: { sessionRef: string; clone: string; maxChars: number }): Promise<string | null> {
    return null;
  }

  async deleteTranscript(_input: { sessionRef: string; clone: string }): Promise<void> {}
}

/** A single-consumer queue that an async iterator drains. */
class EventQueue implements AsyncIterable<AgentEvent> {
  private readonly items: AgentEvent[] = [];
  private waiting: ((result: IteratorResult<AgentEvent>) => void) | null = null;
  private ended = false;

  push(event: AgentEvent): void {
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

type FakeProcess = Bun.Subprocess<'pipe', 'pipe', 'pipe'>;

class FakeSession implements AgentSession {
  readonly pid: number;
  readonly events: EventQueue = new EventQueue();
  readonly exited: Promise<ExitInfo>;

  constructor(
    private readonly proc: FakeProcess,
    readonly sessionRef: string,
    logFile: string,
    cleanup: () => Promise<void>,
  ) {
    this.pid = proc.pid;
    this.exited = proc.exited.then(async () => {
      await cleanup();
      return { code: proc.exitCode, signal: proc.signalCode ?? null };
    });
    // Both pipes are read at once and to their end, whoever iterates the events, so the agent never blocks on them.
    void this.readEvents();
    void this.drainStderr(logFile);
  }

  async send(message: { id: string; text: string; authority: 'person' | 'agent' | 'system' }): Promise<void> {
    await this.write({ t: 'message', ...message });
  }

  async interrupt(options: { cancelQueued?: boolean } = {}): Promise<void> {
    await this.write({ t: 'interrupt', cancelQueued: options.cancelQueued ?? false });
  }

  async answerApproval(
    _approvalId: string,
    _decision: 'approve' | 'decline',
    _reason: string | null,
  ): Promise<boolean> {
    return false;
  }

  async close(): Promise<void> {
    try {
      await this.proc.stdin.end();
    } catch {
      // Already closed, or the agent is gone: either way its input has ended.
    }
  }

  private async write(input: FakeAgentInput): Promise<void> {
    if (this.proc.exitCode !== null || this.proc.signalCode !== null) throw new Error('the fake agent has exited');
    this.proc.stdin.write(`${JSON.stringify(input)}\n`);
    await this.proc.stdin.flush();
  }

  private async readEvents(): Promise<void> {
    const decoder = new TextDecoder();
    let buffered = '';
    const take = (line: string) => {
      if (line.trim() === '') return;
      try {
        this.events.push(JSON.parse(line) as AgentEvent);
      } catch {
        this.events.push({ type: 'warning', text: `unreadable fake agent output: ${line.slice(0, 200)}` });
      }
    };
    try {
      for await (const chunk of this.proc.stdout) {
        buffered += decoder.decode(chunk, { stream: true });
        const lines = buffered.split('\n');
        buffered = lines.pop() ?? '';
        for (const line of lines) take(line);
      }
      take(buffered + decoder.decode());
    } finally {
      this.events.end();
    }
  }

  private async drainStderr(logFile: string): Promise<void> {
    await mkdir(dirname(logFile), { recursive: true });
    for await (const chunk of this.proc.stderr) await appendFile(logFile, chunk);
  }
}
