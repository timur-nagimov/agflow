// The protected paths of design 7.3: three classes of paths that runner agents may not change, the exemptions a task
// earns, the restore set every attempt carries (AttemptSpec.restore.paths, X-16), and liveChatOnly, the rule that
// keeps a task for live chats, which the scheduler and the board share (X-24). Paths are classified here, in code,
// and never with git pathspecs. The module is pure and imports no zod, so the web UI can use it (X-48).
import { patternPrefix } from './paths';
import type { Task } from './types';

export type ProtectedClass = 'agent_config' | 'people_only' | 'curators_only';

/**
 * The patterns of each class, as design 7.3 lists them, strictest class first. matchesProtectedPattern says what
 * they cover: as in a .gitignore file, a pattern with a slash starts at the repository root, and one without names a
 * file or directory at any depth.
 */
export const PROTECTED_CLASSES: Readonly<Record<ProtectedClass, readonly string[]>> = {
  // Never changed by runner agents: a task that owns one is left to people and live chats.
  agent_config: [
    '.claude/**',
    '.codex/**',
    '.mcp.json',
    '.agents/**',
    '.agflow/**',
    '.husky/**',
    '.pre-commit-config.yaml',
    'lefthook.yml',
    '.envrc',
    '.devcontainer/**',
    '.vscode/**',
    '.idea/**',
    '.npmrc',
    '.yarnrc*',
    'bunfig.toml',
    '.tool-versions',
  ],
  // Changed by runner agents only in a task that a person created and whose owned paths include them.
  people_only: [
    '.github/workflows/**',
    '.gitlab-ci.yml',
    '.gitlab/**',
    '.env*',
    '*.pem',
    '*.key',
    '.gitmodules',
    '.gitattributes',
  ],
  // Changed by runner agents only in tasks of kind curation.
  curators_only: ['AGENTS.md', 'CLAUDE.md'],
};

/** Strictest first, as PROTECTED_CLASSES lists them: a path two classes cover belongs to the stricter one. */
const CLASSES = Object.keys(PROTECTED_CLASSES) as ProtectedClass[];

/** What a pattern leaves out although it covers it: the untracked .agflow/run/ that the runner writes into a clone. */
const LEFT_OUT = new Map<string, readonly string[]>([['.agflow/**', ['.agflow', 'run']]]);

/**
 * A name as a case-insensitive APFS volume compares it: decomposed (NFD turns the Kelvin sign into K) and fully
 * case-folded, so ſ is s, ß and ẞ are ss, and the ligatures ﬀ to ﬆ are their letters. Upper-casing expands those
 * (ß to SS, ﬁ to FI), and the first lower-casing lets ẞ through as ß. It also turns the dotless ı into i, which
 * APFS keeps apart, so a path with ı for the i of a protected name counts as protected too.
 */
function fold(text: string): string {
  return text.normalize('NFD').toLowerCase().toUpperCase().toLowerCase();
}

/** Folded segments, without empty and "." ones: macOS file systems ignore case, so classification does too. */
function segmentsOf(text: string): string[] {
  return fold(text)
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.');
}

/** One name against one pattern segment, where "*" stands for any run of characters. */
function nameMatches(pattern: string, name: string): boolean {
  const [first = '', ...rest] = pattern.split('*');
  const last = rest.pop();
  if (last === undefined) return name === first;
  const end = name.length - last.length;
  if (end < first.length || !name.startsWith(first) || !name.endsWith(last)) return false;
  let at = first.length;
  for (const part of rest) {
    const found = name.indexOf(part, at);
    if (found === -1 || found + part.length > end) return false;
    at = found + part.length;
  }
  return true;
}

/**
 * Whether the pattern segments match the path or a directory above it, from the root, where a "**" segment stands
 * for any number of segments. One pass covers every directory above the path: matching each of them anew made the
 * work quadratic in the depth of the paths an agent commits.
 */
function segmentsMatch(pattern: readonly string[], path: readonly string[], p = 0, s = 0): boolean {
  if (p === pattern.length) return true;
  if (pattern[p] === '**') {
    for (let next = s; next <= path.length; next++) if (segmentsMatch(pattern, path, p + 1, next)) return true;
    return false;
  }
  return s < path.length && nameMatches(pattern[p], path[s]) && segmentsMatch(pattern, path, p + 1, s + 1);
}

/**
 * Whether a protected pattern covers a path, case-insensitively as APFS folds names: .CLAUDE/settings.json is
 * .claude/settings.json. Patterns follow .gitignore's rules for where they match: a pattern with a slash before its
 * end starts at the repository root, one without names a file or directory at any depth, and a directory covers what
 * is inside it. "*" stands for any run of characters within a name and "**" for any number of directories; nothing
 * else is special. A file or symlink at a rooted pattern's directory, or at one of its parents, would stand in for
 * that directory, so it is covered too (.claude, and .github for .github/workflows/**). .agflow/** leaves out the
 * runner's untracked .agflow/run/. Runners match their restore set with this function alone (X-16).
 */
export function matchesProtectedPattern(path: string, pattern: string): boolean {
  const segments = segmentsOf(path);
  const glob = segmentsOf(pattern);
  // A pattern of only slashes and dots names no path, although it is a prefix of every one.
  if (segments.length === 0 || glob.length === 0) return false;
  const leftOut = LEFT_OUT.get(fold(pattern));
  if (leftOut && segments.length > leftOut.length && leftOut.every((segment, i) => segments[i] === segment)) {
    return false;
  }
  if (!pattern.replace(/\/+$/, '').includes('/')) {
    return glob.length === 1 && segments.some((segment) => nameMatches(glob[0], segment));
  }
  if (segmentsMatch(glob, segments)) return true;
  const directory = segmentsOf(patternPrefix(pattern).replace(/[^/]*$/, ''));
  return segments.length <= directory.length && segments.every((segment, i) => segment === directory[i]);
}

/** A path's protected class: the strictest class with a pattern that covers it; null for ordinary files. */
export function classifyPath(path: string): ProtectedClass | null {
  return strictestClass(null, (pattern) => matchesProtectedPattern(path, pattern)) ?? null;
}

/** What the rules read from a task: its owned paths, its kind and who created it (X-24). */
type TaskScope = Pick<Task, 'ownedPaths' | 'kind' | 'createdBy'>;

/** A person created the task: its createdBy is 'user:<login>', where an agent's task has 'agent:<id>' (X-24). */
function createdByPerson(task: TaskScope): boolean {
  return /^user:./.test(task.createdBy);
}

/** For a pattern that takes in a whole directory ("src/**", or "**" for the whole repository), that directory. */
function wholeDirectory(owned: string): string | null {
  const segments = segmentsOf(owned);
  if (segments.at(-1) !== '**') return null;
  const directory = segments
    .slice(0, -1)
    .map((segment) => `${segment}/`)
    .join('');
  return fold(patternPrefix(owned)) === directory ? directory : null;
}

/**
 * Whether an owned-path pattern includes what a protected pattern covers: it names protected paths itself
 * (.github/workflows/ci.yml, certs/*.pem, docs/AGENTS.md, .claude), or it takes in a whole directory that holds the
 * protected place ("**" holds every one, .github/** holds .github/workflows/). A broad pattern such as src/** or
 * *.md does not include the protected names that might sit inside it: a task owns a protected path only by naming
 * it, so none earns an exemption, or is kept from runners, by accident. The runner still refuses changes to the
 * protected paths such a task does not own.
 */
function includes(owned: string, pattern: string): boolean {
  if (matchesProtectedPattern(owned, pattern)) return true;
  const directory = wholeDirectory(owned);
  return directory !== null && fold(patternPrefix(pattern)).startsWith(directory);
}

/**
 * Design 7.3's exemptions: a people-only pattern in a task that a person created and whose owned paths include it,
 * and the curator patterns in a curation task. Agent config has none, and neither has a lead attempt (no task).
 */
function exempt(task: TaskScope | null, name: ProtectedClass, pattern: string): boolean {
  if (task === null) return false;
  if (name === 'people_only') return createdByPerson(task) && task.ownedPaths.some((owned) => includes(owned, pattern));
  return name === 'curators_only' && task.kind === 'curation';
}

/** The strictest class with a pattern that passes the test and that the task is not exempt from. */
function strictestClass(task: TaskScope | null, test: (pattern: string) => boolean): ProtectedClass | undefined {
  return CLASSES.find((name) =>
    PROTECTED_CLASSES[name].some((pattern) => test(pattern) && !exempt(task, name, pattern)),
  );
}

/**
 * AttemptSpec.restore.paths: every protected pattern but the task's exemptions, strictest class first; all of them
 * for a lead attempt (no task). The runner restores, detects and strips what they cover (X-16).
 */
export function restoreSet(task: TaskScope | null): string[] {
  return CLASSES.flatMap((name) => PROTECTED_CLASSES[name].filter((pattern) => !exempt(task, name, pattern)));
}

/**
 * The owned paths that no runner agent may change in this task, each with the strictest class it includes: agent
 * config always, people-only paths unless a person created the task, curator paths unless its kind is curation.
 */
export function runnerForbiddenPaths(task: TaskScope): { path: string; class: ProtectedClass }[] {
  return task.ownedPaths.flatMap((path) => {
    const found = strictestClass(task, (pattern) => includes(path, pattern));
    return found === undefined ? [] : [{ path, class: found }];
  });
}

/**
 * The task owns a path that no runner agent may change, so the scheduler leaves it ready for live chats, and the
 * board marks it "live chat only" (design 6.6, step 3).
 */
export function liveChatOnly(task: TaskScope): boolean {
  return runnerForbiddenPaths(task).length > 0;
}

/**
 * The changed paths that the task's restore set covers, each with its strictest class: the changes a runner agent
 * may not make in this task (all protected paths for a lead attempt).
 */
export function protectedViolations(
  paths: readonly string[],
  task: TaskScope | null,
): { path: string; class: ProtectedClass }[] {
  return paths.flatMap((path) => {
    const found = strictestClass(task, (pattern) => matchesProtectedPattern(path, pattern));
    return found === undefined ? [] : [{ path, class: found }];
  });
}
