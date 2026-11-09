// Section 7.6's denied paths rendered for Claude Code 2.1.285 (design 7.6, 8.2, X-29): permission rules in the
// absolute //path form for the in-process tools, and the sandbox's filesystem and network settings for Bash. Every
// path comes from the given home and runner paths, never from the runner's own environment.
import { isAbsolute, join } from 'node:path';
import type { Vendor } from '@agflow/core';
import type { SandboxSettings } from '@anthropic-ai/claude-agent-sdk';
import type { RunnerPaths } from '../../paths';
import { type DeniedPath, deniedReadPaths, deniedWritePaths, type PermissionProfile } from '../../profile';
import { claudeProjectDir } from './paths';

/**
 * The parts of ~/.agflow/runner that Read rules name (7.6). The whole tree cannot be named: a Read rule has no
 * allowRead carve-out, and Claude Code tells the model to read oversized tool output in the attempt's project
 * directory under homes/claude/projects/.
 */
export const CLAUDE_RUNNER_READ_PARTS: readonly string[] = Object.freeze([
  'runner.*',
  'logs/**',
  'git/**',
  'prep/**',
  'forensics/**',
  'homes/codex/**',
  'homes/codex-user/**',
  'homes/claude/.claude.json',
  'homes/claude/backups/**',
  'homes/claude/shell-snapshots/**',
]);

/** The same Claude-home parts, named under a Claude home that runner.json puts outside the runner tree. */
const CLAUDE_HOME_READ_PARTS = ['.claude.json', 'backups/**', 'shell-snapshots/**'];

/**
 * Bash deny rules for the commands that reach the git host or credentials. The `:*` form also matches the bare
 * command. The guard refuses these and more, with real parsing; the rules are the CLI's own second line.
 */
export const CLAUDE_PUSH_DENY_RULES: readonly string[] = Object.freeze([
  'Bash(git push:*)',
  'Bash(git credential:*)',
  'Bash(gh:*)',
  'Bash(glab:*)',
  'Bash(security:*)',
]);

const BRIDGE_TOOLS = 'mcp__agflow';
const WEB_TOOLS = ['WebFetch', 'WebSearch'];

/** The sandbox runtime always lets commands write these unless they are denied by name (7.6, X-29). */
const SHARED_TMP = ['/tmp/claude', '/private/tmp/claude'];

// Rule contents and sandbox paths are glob patterns: a path holding one of these would match something else, or
// break the rule's parentheses, and a deny that silently matches nothing must not happen.
const PATTERN_CHARS = /[*?[\]{}()\\]/;

export interface ClaudeRulesInput {
  /** The agent's HOME (the owner's), given rather than read from the process. */
  home: string;
  /** From runnerPaths(AGFLOW_HOME). */
  paths: Pick<RunnerPaths, 'runner' | 'vaults' | 'work'>;
  /** vendorHomes(config, paths); the Claude home is CLAUDE_CONFIG_DIR. */
  vendorHomes: Record<Vendor, string>;
  profile: PermissionProfile;
  /** The attempt's clone. */
  clone: string;
  /** CLAUDE_CODE_TMPDIR. */
  tmpDir: string;
}

export interface ClaudePermissionRules {
  allow: string[];
  deny: string[];
}

/**
 * settings.permissions: the bridge (and the web tools with webTools) and the temporary directory allowed, 7.6's reads
 * and writes denied.
 */
export function claudePermissionRules(input: ClaudeRulesInput): ClaudePermissionRules {
  const { readable, writable } = deniedPaths(input);
  const claudeHome = input.vendorHomes.claude;
  const reads = new Set<string>();
  for (const denied of readable) {
    if (denied.path === input.paths.runner) {
      for (const part of CLAUDE_RUNNER_READ_PARTS) reads.add(rule('Read', join(input.paths.runner, part)));
    } else if (denied.path !== claudeHome) {
      reads.add(pathRule('Read', denied));
    }
  }
  // Wherever the Claude home lies, only its sensitive parts are named, so the project directory stays readable.
  for (const part of CLAUDE_HOME_READ_PARTS) reads.add(rule('Read', join(claudeHome, part)));
  // Edit rules cover Write and NotebookEdit too; 2.1.285 never matches path patterns in Write(...) rules.
  const edits = new Set(writable.map((denied) => pathRule('Edit', denied)));
  return {
    allow: [
      BRIDGE_TOOLS,
      ...(input.profile.webTools ? WEB_TOOLS : []),
      // Under acceptEdits and permissionPrompts 'none', 2.1.285 refuses in-process tools outside the cwd, so the
      // temporary directory the guard and the sandbox give the agent needs allow rules of its own. Not
      // additionalDirectories: --add-dir would also load skills and commands from there.
      rule('Read', join(input.tmpDir, '**')),
      rule('Edit', join(input.tmpDir, '**')),
    ],
    deny: [...reads, ...edits, ...CLAUDE_PUSH_DENY_RULES],
  };
}

/**
 * The top-level sandbox option. denyRead holds 7.6's list plus a two-level glob under work (each clone), with allowRead
 * for the clone and the attempt's project directory. Leaving the clone's parents readable lets Bun resolve package
 * scripts; 2.1.285 honours this generated glob through --settings. Writes go only to the clone (the CLI adds its cwd) and
 * the temporary directory. The CLI copies the Edit deny rules into denyWrite itself.
 */
export function claudeSandboxSettings(input: ClaudeRulesInput): SandboxSettings {
  const { readable } = deniedPaths(input);
  return {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    network: { allowedDomains: [...input.profile.network.allowedDomains], strictAllowlist: true },
    filesystem: {
      denyRead: [...new Set([...readable.map((denied) => denied.path), join(input.paths.work, '*', '*')])],
      allowRead: [input.clone, claudeProjectDir(input.vendorHomes.claude, input.clone)],
      allowWrite: [input.tmpDir],
      denyWrite: [...SHARED_TMP, join(input.home, '.npm', '_logs')],
    },
  };
}

/**
 * 7.6's lists for this input, after checking that every path is plain and that no denial covers the attempt's own
 * files: deny rules cannot be re-allowed, and Edit denials become sandbox denyWrite paths. (profile.ts already
 * refuses denials that cover the work root.)
 */
function deniedPaths(input: ClaudeRulesInput): { readable: DeniedPath[]; writable: DeniedPath[] } {
  const roots = [input.home, input.paths.runner, input.paths.vaults, input.paths.work, input.clone, input.tmpDir];
  for (const path of [...roots, ...Object.values(input.vendorHomes)]) plainPath(path);
  const readable = deniedReadPaths(input);
  const writable = deniedWritePaths(input);
  for (const denied of [...readable, ...writable]) {
    for (const own of [input.clone, input.tmpDir]) {
      if (own === denied.path || own.startsWith(`${denied.path}/`)) {
        throw new Error(`the denied path ${denied.path} would cover the attempt's ${own}`);
      }
    }
  }
  return { readable, writable };
}

function pathRule(tool: 'Read' | 'Edit', denied: DeniedPath): string {
  return rule(tool, denied.tree ? join(denied.path, '**') : denied.path);
}

/** `Tool(//abs)`: a leading // makes the pattern an absolute filesystem path. */
function rule(tool: 'Read' | 'Edit', path: string): string {
  return `${tool}(/${path})`;
}

function plainPath(path: string): void {
  if (!isAbsolute(path)) throw new Error(`a Claude permission path must be absolute, not ${path}`);
  if (PATTERN_CHARS.test(path)) {
    throw new Error(`the path ${path} holds characters Claude Code reads as a pattern; move it or AGFLOW_HOME`);
  }
}
