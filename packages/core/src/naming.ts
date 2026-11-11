// Names the hub, runners and live chats must agree on: attempt ids, the refs under the WIP ref prefix,
// runners' local pins and task branches. From epoch 2 (after a restore) attempt ids, WIP refs and task
// branches carry the epoch, so nothing collides with what existed before the restore.

export interface AttemptIdParts {
  /** Null for a lead attempt. */
  taskId: string | null;
  number: number;
  epoch: number;
}

/** M1's task id grammar (TaskIdSchema), repeated so this module, which the web UI imports, needs no zod. */
const TASK_ID = /^T-\d+$/;

function requireTaskId(taskId: string): string {
  if (!TASK_ID.test(taskId)) throw new Error(`not a task id: ${JSON.stringify(taskId)}`);
  return taskId;
}

function requireCount(value: number, what: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${what} must be a positive whole number, not ${value}`);
  return value;
}

/** What follows the task id or "lead-" in an attempt id. */
function suffix(number: number, epoch: number): string {
  requireCount(number, 'an attempt number');
  return requireCount(epoch, 'an epoch') === 1 ? `a${number}` : `e${epoch}-a${number}`;
}

/** 'T-42-a3'; from epoch 2 'T-42-e2-a3'. */
export function attemptId(taskId: string, number: number, epoch: number): string {
  return `${requireTaskId(taskId)}-${suffix(number, epoch)}`;
}

/** 'lead-a5'; from epoch 2 'lead-e2-a5'. Lead attempts are numbered per lead seat. */
export function leadAttemptId(number: number, epoch: number): string {
  return `lead-${suffix(number, epoch)}`;
}

// Epoch 1 has no marker and numbers have no leading zeros, so each attempt has exactly one id.
const ATTEMPT_ID = /^(T-\d+|lead)-(?:e([1-9]\d*)-)?a([1-9]\d*)$/;

/** The task (null for a lead), number and epoch of an attempt id; null for anything else. */
export function parseAttemptId(id: string): AttemptIdParts | null {
  const match = id.match(ATTEMPT_ID);
  if (!match) return null;
  const [, owner, epochText, numberText] = match;
  const epoch = epochText === undefined ? 1 : Number(epochText);
  const number = Number(numberText);
  if (epochText === '1' || !Number.isSafeInteger(epoch) || !Number.isSafeInteger(number)) return null;
  return { taskId: owner === 'lead' ? null : owner, number, epoch };
}

function requireAttemptId(id: string): AttemptIdParts {
  const parts = parseAttemptId(id);
  if (!parts) throw new Error(`not an attempt id: ${JSON.stringify(id)}`);
  return parts;
}

/** The part of an attempt id after its task id or "lead-": 'a3', or 'e2-a3' from epoch 2. */
export function attemptSuffix(id: string): string {
  const { number, epoch } = requireAttemptId(id);
  return suffix(number, epoch);
}

// ---------------------------------------------------------------------------
// Refs
// ---------------------------------------------------------------------------

export const DEFAULT_WIP_REF_PREFIX = 'refs/agflow/';

/** A runner's own pins in its vault, never pushed or fetched. */
const LOCAL_PINS = 'refs/agflow-local/';

/** A ref path component git accepts, from a cautious alphabet: no leading ".", no "..", no trailing "." or ".lock". */
function isRefComponent(part: string): boolean {
  return (
    /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(part) && !part.includes('..') && !part.endsWith('.') && !part.endsWith('.lock')
  );
}

/**
 * A WIP ref prefix names a namespace under refs/ and ends with "/": refs/agflow/ by default, or
 * refs/heads/agflow-wip/ for hosts that refuse custom namespaces. Runners' local pins keep theirs.
 */
export function isValidWipRefPrefix(prefix: string): boolean {
  return (
    prefix.startsWith('refs/') &&
    prefix.endsWith('/') &&
    !prefix.startsWith(LOCAL_PINS) &&
    prefix.slice('refs/'.length, -1).split('/').every(isRefComponent)
  );
}

function requirePrefix(prefix: string): string {
  if (!isValidWipRefPrefix(prefix)) throw new Error(`not a WIP ref prefix: ${JSON.stringify(prefix)}`);
  return prefix;
}

/** An attempt's work in progress: 'refs/agflow/T-42/a3', or 'refs/agflow/T-42/e2-a3' from epoch 2. */
export function wipRef(prefix: string, id: string): string {
  const { taskId, number, epoch } = requireAttemptId(id);
  if (!taskId) throw new Error(`lead attempts have no WIP refs: ${id}`);
  return `${requirePrefix(prefix)}${taskId}/${suffix(number, epoch)}`;
}

/**
 * Work an attempt pushes after it ended, and hand-backs: new refs beside its WIP ref, with n from 1, so
 * an ended attempt's WIP ref is never rewritten.
 */
export function lateWorkRef(prefix: string, id: string, n: number): string {
  return `${wipRef(prefix, id)}-late-${requireCount(n, 'a late-work number')}`;
}

/** Where a person who took the task over pushes their work. */
export function takeoverRef(prefix: string, taskId: string, login: string): string {
  if (!isRefComponent(login)) throw new Error(`the login ${JSON.stringify(login)} cannot name a ref`);
  return `${requirePrefix(prefix)}${requireTaskId(taskId)}/takeover-${login}`;
}

/** Every ref of a task under the prefix, as a refspec glob: WIP, late work and take-overs. */
export function taskRefGlob(prefix: string, taskId: string): string {
  return `${requirePrefix(prefix)}${requireTaskId(taskId)}/*`;
}

/** A runner's pins of the objects an attempt's clone borrows from its vault. Only cleanup removes them. */
export function localPinRefs(id: string): { start: string; head: string } {
  requireAttemptId(id);
  return { start: `${LOCAL_PINS}${id}/start`, head: `${LOCAL_PINS}${id}/head` };
}

// ---------------------------------------------------------------------------
// Task branches
// ---------------------------------------------------------------------------

const SLUG_LENGTH = 40;

/**
 * After the task id, "e2-…" marks a branch named in epoch 2, so no slug may start that way. Slugs that only
 * look like a marker ("e1-…", "e02-…", a bare "e2") get the prefix too, so no branch name misleads a person.
 */
const EPOCH_MARKER = /^e\d+(?:-|$)/;

/** A short, branch-safe name for a title; one that would read as an epoch marker starts with "t-". */
export function slugify(text: string): string {
  const cut = (value: string) => value.slice(0, SLUG_LENGTH).replace(/-+$/g, '');
  const slug = cut(
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, ''),
  );
  if (!slug) return 'task';
  return EPOCH_MARKER.test(slug) ? cut(`t-${slug}`) : slug;
}

/** 'agflow/T-42-<slug>'; from epoch 2 'agflow/T-42-e2-<slug>'. */
export function taskBranchName(taskId: string, title: string, epoch: number): string {
  const marker = requireCount(epoch, 'an epoch') === 1 ? '' : `e${epoch}-`;
  return `agflow/${requireTaskId(taskId)}-${marker}${slugify(title)}`;
}

/**
 * True for a branch in the task's own namespace: agflow/T-42-<slug>, or agflow/T-42-e2-<slug> from
 * epoch 2. The hub keeps whatever branch name a claim last gave it, and any agent may give it any valid
 * name, so a name from the hub is trusted for a push only when it is one of these.
 */
export function isTaskBranch(taskId: string, branch: string | null | undefined): branch is string {
  return typeof branch === 'string' && branch.startsWith(`agflow/${taskId}-`);
}

// Epoch 1 has no marker, epochs have no leading zeros and a slug always follows, as taskBranchName writes them.
const TASK_BRANCH = /^agflow\/T-\d+-(?:e([2-9]|[1-9]\d+)-)?/;

/**
 * The epoch a task branch was named in, 1 when it has no marker; null for any other branch. Only names
 * taskBranchName made are unambiguous: a branch recorded before M2 can carry an "e<n>-" slug from a title
 * like "E2: parser", which reads as epoch 2. At epoch 1 every recorded branch is current, so callers need
 * this only from epoch 2.
 */
export function branchEpoch(branch: string): number | null {
  const match = branch.match(TASK_BRANCH);
  if (!match) return null;
  const epoch = match[1] === undefined ? 1 : Number(match[1]);
  // taskBranchName writes no epoch that large, so those digits are part of the slug.
  return Number.isSafeInteger(epoch) ? epoch : 1;
}

// ---------------------------------------------------------------------------
// Take-over
// ---------------------------------------------------------------------------

/** Quotes one argument for the POSIX shell a person pastes the command into. */
function shellArg(arg: string): string {
  // No quoting stops git from reading it as an option.
  if (arg.startsWith('-')) throw new Error(`${JSON.stringify(arg)} would be read as an option`);
  return /^[A-Za-z0-9_\/.:=@%+-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * The take-over command for any clone of the repository: fetch the work onto the task branch and, when
 * done, push it to the person's take-over ref. The hub (at lease expiry or the stop timeout) and the
 * runner (prepare_takeover) both build it here.
 */
export function takeoverAnywhereCommand(input: { ref: string; branch: string; takeoverRef: string }): string {
  return [
    `git fetch origin ${shellArg(input.ref)} && git switch -c ${shellArg(input.branch)} FETCH_HEAD`,
    `git push origin ${shellArg(`HEAD:${input.takeoverRef}`)}`,
  ].join('\n');
}
