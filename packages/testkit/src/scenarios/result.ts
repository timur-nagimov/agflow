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
