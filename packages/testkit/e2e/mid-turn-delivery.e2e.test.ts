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
