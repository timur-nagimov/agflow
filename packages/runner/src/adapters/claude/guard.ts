// The PreToolUse guard, in both profiles (design 8.2, 7.6, X-29). Claude Code's in-process tools do not run in the
// sandbox, and permission rules cannot name the work root without denying the attempt's own clone, so this callback
// confines them: Edit, Write and NotebookEdit to the clone and its temporary directory, minus the clone's .git/config
// and .git/hooks; Read, Glob and Grep away from other attempts' clones and other sessions' Claude project
// directories. Bash commands get bashVerdict. Every path compares as a real path, and tool paths resolve as Claude
// Code 2.1.285 resolves them: trimmed, ~ expanded, and relative to the CLI's current directory, the hook input's cwd
// (the clone at start; a Bash `cd` inside the clone persists).
import { isAbsolute, join, resolve, sep } from 'node:path';
import type { HookCallbackMatcher, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { bashVerdict, foldCase, type Verdict } from './bash-verdict';
import { claudeProjectDir, realPathOf } from './paths';

export interface GuardScope {
  /** The attempt's clone, the agent's working directory. */
  clone: string;
  /** CLAUDE_CODE_TMPDIR, the attempt's private temporary directory. */
  tmpDir: string;
  /** ~/.agflow/work, which holds every attempt's clone. */
  workRoot: string;
  /** CLAUDE_CONFIG_DIR, whose projects/ holds every session's transcripts. */
  claudeHome: string;
  /** The agent's HOME, which the CLI expands a leading ~ to; never the runner's own. */
  home: string;
}

const ALLOW: Verdict = { allow: true };
const EDITORS: Record<string, string> = { Edit: 'file_path', Write: 'file_path', NotebookEdit: 'notebook_path' };
const READERS = new Set(['Read', 'Glob', 'Grep']);
const GLOB_CHARS = /[*?[{]/;

/** The guard's verdict on one tool call; `cwd` is the CLI's current directory, which relative paths resolve against. */
export function guardDecision(
  scope: GuardScope,
  toolName: string,
  toolInput: unknown,
  cwd: string = scope.clone,
): Verdict {
  const input = (typeof toolInput === 'object' && toolInput !== null ? toolInput : {}) as Record<string, unknown>;
  if (toolName === 'Bash') {
    return typeof input.command === 'string'
      ? bashVerdict(input.command)
      : refuse('Bash without a command is refused');
  }
  const editorKey = EDITORS[toolName];
  if (editorKey === undefined && !READERS.has(toolName)) return ALLOW;
  try {
    if (editorKey !== undefined) {
      const path = input[editorKey];
      if (typeof path !== 'string' || path === '') return refuse(`${toolName} without a file path is refused`);
      return judgeEdit(toolName, realPathOf(toolPath(scope, cwd, path)), roots(scope));
    }
    return judgeRead(toolName, readTargets(scope, cwd, toolName, input), roots(scope));
  } catch (error) {
    return refuse(`${toolName} on a path that cannot be resolved (${(error as Error).message}) is refused`);
  }
}

/** The PreToolUse matcher for query()'s hooks: no `matcher`, so it sees every tool call. */
export function createGuardHook(scope: GuardScope): HookCallbackMatcher {
  return {
    hooks: [
      async (input): Promise<HookJSONOutput> => {
        if (input.hook_event_name !== 'PreToolUse') return {};
        let verdict: Verdict;
        try {
          verdict = guardDecision(scope, input.tool_name, input.tool_input, input.cwd || scope.clone);
        } catch (error) {
          // Claude Code runs the tool when a hook callback fails, so the guard refuses instead of throwing.
          verdict = refuse(`the guard could not judge this call (${(error as Error).message}), so it is refused`);
        }
        if (verdict.allow) return {};
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: verdict.reason,
          },
        };
      },
    ],
  };
}

interface Roots {
  clone: string;
  tmpDir: string;
  work: string;
  projects: string;
  ownProject: string;
}

function roots(scope: GuardScope): Roots {
  return {
    clone: realPathOf(scope.clone),
    tmpDir: realPathOf(scope.tmpDir),
    work: realPathOf(scope.workRoot),
    projects: realPathOf(join(scope.claudeHome, 'projects')),
    ownProject: realPathOf(claudeProjectDir(scope.claudeHome, scope.clone)),
  };
}

function judgeEdit(tool: string, path: string, root: Roots): Verdict {
  if (!within(path, root.clone) && !within(path, root.tmpDir)) {
    return refuse(`${tool} outside the clone and its temporary directory is refused`);
  }
  // Folded, as macOS volumes find .git/HOOKS as .git/hooks: a clone made with --template= has no hooks directory
  // whose real path would give the spelling.
  const gitDir = foldCase(join(root.clone, '.git'));
  const folded = foldCase(path);
  if (folded === join(gitDir, 'config') || within(folded, join(gitDir, 'hooks'))) {
    return refuse(`${tool} on .git/config or under .git/hooks is refused`);
  }
  return ALLOW;
}

/**
 * The real paths a read tool reaches: Read's file, and a search's root, which is its path (the current directory
 * when absent or blank) and, when the pattern starts with fixed directories, those directories too.
 */
function readTargets(scope: GuardScope, cwd: string, tool: string, input: Record<string, unknown>): string[] {
  if (tool === 'Read') {
    return typeof input.file_path === 'string' ? [realPathOf(toolPath(scope, cwd, input.file_path))] : [];
  }
  const given = typeof input.path === 'string' && input.path.trim() !== '';
  const base = given ? toolPath(scope, cwd, input.path as string) : resolve(cwd);
  const targets = [realPathOf(base)];
  if (tool === 'Glob' && typeof input.pattern === 'string') {
    const fixed = fixedPrefix(expandHome(scope, input.pattern.trim()));
    if (fixed !== '') targets.push(realPathOf(resolve(base, fixed)));
  }
  return targets;
}

function judgeRead(tool: string, targets: string[], root: Roots): Verdict {
  // Glob and Grep descend: a root above the work root or the projects directory would reach into them.
  const descends = tool !== 'Read';
  for (const target of targets) {
    if (within(target, root.work) && !within(target, root.clone)) {
      return refuse(`${tool} is in another attempt's clone, which is refused`);
    }
    if (descends && within(root.work, target) && target !== root.work) {
      return refuse(`${tool} would search other attempts' clones, which is refused`);
    }
    if (within(target, root.projects) && !within(target, root.ownProject)) {
      return refuse(`${tool} is in another session's Claude project directory, which is refused`);
    }
    if (descends && within(root.projects, target) && target !== root.projects) {
      return refuse(`${tool} would search other sessions' Claude project directories, which is refused`);
    }
  }
  return ALLOW;
}

/**
 * The leading directories of a glob pattern before its first wildcard. A pattern without one names a file, and the
 * CLI searches its directory for it.
 */
function fixedPrefix(pattern: string): string {
  const parts = pattern.split('/');
  const wild = parts.findIndex((part) => GLOB_CHARS.test(part));
  const fixed = wild < 0 ? parts.slice(0, -1) : parts.slice(0, wild);
  return fixed.length === 1 && fixed[0] === '' && isAbsolute(pattern) ? '/' : fixed.join('/');
}

/** A tool path as 2.1.285 resolves it: trimmed, ~ expanded, relative to the current directory, NFC-normalized. */
function toolPath(scope: GuardScope, cwd: string, path: string): string {
  return resolve(cwd, expandHome(scope, path.trim())).normalize('NFC');
}

function expandHome(scope: GuardScope, path: string): string {
  if (path === '~') return scope.home;
  return path.startsWith('~/') ? join(scope.home, path.slice(2)) : path;
}

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

function refuse(reason: string): Verdict {
  return { allow: false, reason };
}
