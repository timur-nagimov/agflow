// The fake agent: the process FakeAdapter starts, in its own group with the agent environment and the clone as its
// cwd. It reads its FakeAgentConfig from the file its one argument names, plays its script (FakeScript) one turn per
// input, writes AgentEvents to stdout as JSON lines and reads FakeAgentInputs from stdin. Its tools are real: files,
// git with the agent's own environment, and shell commands in process groups of their own.
import { mkdirSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AgentEvent, TerminalTool } from '@agflow/runner';
import type { FakeAgentConfig, FakeAgentInput, FakeStep } from './fake-adapter';

const config = JSON.parse(readFileSync(process.argv[2] ?? '', 'utf8')) as FakeAgentConfig;
const { script } = config;

// A SIGTERMed claude exits 143, not by signal (design 7.4); a script may ignore the signal instead.
process.on('SIGTERM', () => {
  if (!script.ignoreSigterm) process.exit(143);
});

/** The bridge tool behind each terminal kind. */
const TERMINAL_TOOLS: Record<TerminalTool, string> = {
  submit: 'submit',
  blocked: 'declare_blocked',
  impossible: 'declare_impossible',
  released: 'release_task',
  handoff: 'write_handoff',
};

// Synchronous writes, so nothing is lost when a step exits the process right after.
function emit(event: AgentEvent): void {
  writeSync(1, `${JSON.stringify(event)}\n`);
}

interface Input {
  /** null for the first prompt, which the hub never sent. */
  id: string | null;
  text: string;
}

const queue: Input[] = [];
let stdinClosed = false;
let inTurn = false;
let interrupted = false;
/** Wakes the idle loop. */
let wake: (() => void) | null = null;
/** Cuts the running sleep or tool wait short. */
let abortStep: (() => void) | null = null;

function notify(): void {
  const waiting = wake;
  wake = null;
  waiting?.();
}

function receive(input: FakeAgentInput): void {
  if (input.t === 'message') {
    queue.push({ id: input.id, text: input.text });
    notify();
    return;
  }
  if (input.cancelQueued) queue.length = 0;
  if (inTurn && !script.ignoreInterrupt) {
    interrupted = true;
    abortStep?.();
  }
}

async function readStdin(): Promise<void> {
  const decoder = new TextDecoder();
  let buffered = '';
  for await (const chunk of Bun.stdin.stream()) {
    buffered += decoder.decode(chunk, { stream: true });
    const lines = buffered.split('\n');
    buffered = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim() !== '') receive(JSON.parse(line) as FakeAgentInput);
    }
  }
  stdinClosed = true;
  // Mid-turn EOF ends the process unless the script carries on like Claude; an idle agent ends in the loop.
  if (inTurn && !script.ignoreEofMidTurn) process.exit(0);
  notify();
}

/** The next input, or null once stdin has ended. */
async function nextInput(): Promise<Input | null> {
  for (;;) {
    const input = queue.shift();
    if (input) return input;
    if (stdinClosed) return null;
    await new Promise<void>((resolve) => {
      wake = resolve;
    });
  }
}

/** Waits for the promise, or gives onAbort at once when the turn is interrupted. */
function interruptible<T>(promise: Promise<T>, onAbort: T): Promise<T> {
  return new Promise<T>((resolve) => {
    abortStep = () => resolve(onAbort);
    promise.then(resolve);
  }).finally(() => {
    abortStep = null;
  });
}

let toolCount = 0;

async function tool(name: string, input: string, command: string | null, run: () => Promise<boolean>) {
  toolCount += 1;
  const toolId = `toolu_${toolCount}`;
  emit({ type: 'tool_started', toolId, name, input, command });
  const ok = await run();
  emit({ type: 'tool_ended', toolId, ok, denied: false, terminal: null, hubUnreachable: false });
}

async function exitsZero(argv: string[]): Promise<boolean> {
  const proc = Bun.spawn(argv, { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
  return (await proc.exited) === 0;
}

function quote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/** Runs one step; gives whether it was a tool call. */
async function runStep(step: FakeStep): Promise<boolean> {
  switch (step.do) {
    case 'write':
      await tool('Write', step.path, null, async () => {
        const target = join(process.cwd(), step.path);
        if (step.content === null) {
          rmSync(target, { force: true });
        } else {
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, step.content);
        }
        return true;
      });
      return true;
    case 'commit': {
      const command = `git add -A && git commit -q -m ${quote(step.message)}`;
      await tool('Bash', command, command, async () => {
        return (await exitsZero(['git', 'add', '-A'])) && exitsZero(['git', 'commit', '-q', '-m', step.message]);
      });
      return true;
    }
    case 'tool':
      await tool('Bash', step.command, step.command, async () => {
        // A group of its own, as vendor CLIs run their tools. One that inherits the agent's pipes holds them open
        // after the agent exits, as an escaped grandchild would.
        const output = step.inheritPipes ? 'inherit' : 'ignore';
        const child = Bun.spawn(['sh', '-c', step.command], {
          detached: true,
          stdin: 'ignore',
          stdout: output,
          stderr: output,
        });
        if (step.wait === false) {
          child.unref();
          return true;
        }
        return (await interruptible(child.exited, -1)) === 0;
      });
      return true;
    case 'terminal': {
      toolCount += 1;
      const toolId = `toolu_${toolCount}`;
      const answer = step.answer ?? 'ok';
      const name = `mcp__agflow__${TERMINAL_TOOLS[step.tool]}`;
      emit({ type: 'tool_started', toolId, name, input: '{}', command: null });
      emit({
        type: 'tool_ended',
        toolId,
        ok: answer === 'ok',
        denied: false,
        // Counted only on a normal result (design 10).
        terminal: answer === 'ok' ? step.tool : null,
        hubUnreachable: answer === 'hub_unreachable',
      });
      return true;
    }
    case 'text':
      emit({ type: 'text', text: step.text });
      return false;
    case 'sleep':
      await interruptible(Bun.sleep(step.ms), undefined);
      return false;
    case 'log':
      writeSync(2, `${step.text}\n`);
      return false;
    case 'exit':
      process.exit(step.code);
  }
}

let turnIndex = 0;

async function runTurn(first: Input): Promise<void> {
  inTurn = true;
  interrupted = false;
  const taken: string[] = [];
  const take = (input: Input) => {
    if (input.id === null) return;
    taken.push(input.id);
    emit({ type: 'delivered', id: input.id });
  };
  take(first);
  emit({ type: 'turn_started' });
  let toolCalls = 0;
  for (const step of script.turns[turnIndex] ?? []) {
    if (interrupted) break;
    for (let input = queue.shift(); input; input = queue.shift()) take(input);
    if (await runStep(step)) toolCalls += 1;
  }
  turnIndex += 1;
  emit({
    type: 'turn_ended',
    outcome: interrupted ? 'interrupted' : 'completed',
    toolCalls,
    error: null,
    errorKind: null,
  });
  for (const id of taken) emit({ type: 'acknowledged', id });
  inTurn = false;
  interrupted = false;
}

emit({
  type: 'started',
  sessionRef: config.sessionRef,
  model: config.model,
  cliVersion: config.cliVersion,
  permissionMode: script.permissionMode === undefined ? 'acceptEdits' : script.permissionMode,
});
if (config.firstPrompt !== null) queue.push({ id: null, text: config.firstPrompt });
void readStdin();
for (let input = await nextInput(); input; input = stdinClosed ? null : await nextInput()) {
  await runTurn(input);
}
process.exit(0);
