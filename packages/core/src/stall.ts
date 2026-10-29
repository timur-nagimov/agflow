// The stall rules of design 6.8 and the tool caps of AttemptSpec.toolCaps. The hub computes an attempt's caps and
// judges the facts its runner reports; the runner reports the cap it applied to the tool call in flight
// (AttemptFacts.tool.capMs) from capForCommand, so both read commands the same way (X-18). Pure, with no zod at run
// time.
import type { AttemptSpec } from './runner-protocol';
import type { AgentRole, AttemptFacts, AttemptPhase, StopCause, TaskCheck } from './types';

type ToolCaps = AttemptSpec['toolCaps'];

/**
 * Build and test commands, by their first words: a shell command with a segment that starts with one of them gets
 * the long cap. The first word is compared without its directory (./gradlew, /usr/bin/make), and VAR=value
 * assignments, "env" and "time" in front of it are skipped.
 */
export const longPatterns: readonly string[] = [
  // JavaScript and TypeScript
  'bun test',
  'bun build',
  'bun run build',
  'bun run test',
  'bun run typecheck',
  'npm test',
  'npm run build',
  'npm run test',
  'npm run typecheck',
  'pnpm test',
  'pnpm build',
  'pnpm run build',
  'pnpm run test',
  'yarn test',
  'yarn build',
  'yarn run build',
  'yarn run test',
  'tsc',
  'npx tsc',
  'bunx tsc',
  'jest',
  'npx jest',
  'vitest',
  'npx vitest',
  'bunx vitest',
  'playwright test',
  'npx playwright test',
  'bunx playwright test',
  'webpack',
  'vite build',
  'next build',
  'turbo run',
  // Python
  'pytest',
  'python -m pytest',
  'python3 -m pytest',
  'uv run pytest',
  'tox',
  'mypy',
  // Rust and Go
  'cargo build',
  'cargo test',
  'cargo check',
  'cargo clippy',
  'cargo nextest',
  'go build',
  'go test',
  'go vet',
  // Make and other build systems
  'make',
  'cmake',
  'ctest',
  'ninja',
  'bazel',
  'gradle',
  'gradlew',
  'mvn',
  'mvnw',
  'xcodebuild',
  'swift build',
  'swift test',
  'dotnet build',
  'dotnet test',
  'rake',
  'rspec',
  'bundle exec rake',
  'bundle exec rspec',
  'docker build',
];

const LONG_WORDS = longPatterns.map((pattern) => pattern.split(' '));

// Where one command of a shell line ends and the next begins: operators, brackets, subshells and quotes, so that a
// command run through "sh -c '...'" or "$(...)" is found too.
const SEGMENT_BREAK = /[;&|(){}`'"\n\r]/;

/** Words in front of a command that do not name it: VAR=value assignments, "env" and "time". */
function isPrefixWord(word: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || word === 'env' || word === 'time';
}

/** Whether a segment of the shell command starts with a longPatterns entry. */
export function isLongCommand(command: string): boolean {
  return command.split(SEGMENT_BREAK).some((segment) => {
    const words = segment.trim().split(/\s+/);
    const start = words.findIndex((word) => !isPrefixWord(word));
    if (start === -1) return false;
    const first = words[start];
    const leading = [first.slice(first.lastIndexOf('/') + 1), ...words.slice(start + 1)];
    return LONG_WORDS.some((pattern) => pattern.every((word, i) => leading[i] === word));
  });
}

/** What a check's cap adds to its own timeout. */
const CHECK_MARGIN_MS = 10 * 60_000;

/**
 * AttemptSpec.toolCaps: toolCapMs by default, longToolCapMs for build and test commands, and for each task check the
 * larger of longToolCapMs and its timeout plus 10 minutes, or longToolCapMs for a check without a timeout. A lead
 * attempt has no checks.
 */
export function computeToolCaps(
  limits: { toolCapMs: number; longToolCapMs: number },
  checks: readonly TaskCheck[],
): ToolCaps {
  return {
    defaultMs: limits.toolCapMs,
    longMs: limits.longToolCapMs,
    checks: checks.map((check) => ({
      cmd: check.cmd,
      capMs: Math.max(limits.longToolCapMs, check.timeoutS === undefined ? 0 : check.timeoutS * 1000 + CHECK_MARGIN_MS),
    })),
  };
}

/** Text with each run of whitespace, line breaks included, as one space, and none at the ends. */
function normalizeSpace(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

/**
 * The cap of a tool call (X-18): for a command that contains a task check's cmd, both whitespace-normalised, the
 * largest such check's cap; else the long cap for a build or test command (isLongCommand); else the default cap,
 * which a tool call without a shell command also gets. The runner reports it in AttemptFacts.tool.capMs.
 */
export function capForCommand(caps: ToolCaps, command: string | null): number {
  if (command === null) return caps.defaultMs;
  const text = normalizeSpace(command);
  const checkCaps = caps.checks
    .filter((check) => {
      const cmd = normalizeSpace(check.cmd);
      return cmd !== '' && text.includes(cmd);
    })
    .map((check) => check.capMs);
  if (checkCaps.length > 0) return Math.max(...checkCaps);
  return isLongCommand(command) ? caps.longMs : caps.defaultMs;
}

/** The counts of design 6.8's no-progress and loop rules. */
const NO_PROGRESS_TURNS = 3;
const LOOP_CALLS = 3;

/** The settings design 6.8's rules read: HubConfig's fields of the same names (design 12). */
export interface StallLimits {
  /** silent: no agent event for this long, with no tool call in flight. */
  stallMs: number;
  /** hung tool: the cap of a tool call whose facts report none. */
  toolCapMs: number;
  /** budget: the continuations an attempt gets. */
  maxContinuations: number;
  /** budget: the active time an attempt gets (AttemptFacts.activeMs). */
  activeBudgetMs: number;
}

/** Phases in which an agent waits for a person, a quota reset, its vendor, a preparation or its stop: never a stall. */
export const STALL_EXEMPT_PHASES: readonly AttemptPhase[] = [
  'waiting_approval',
  'quota_wait',
  'vendor_error',
  'preparing',
  'stopping',
];

/** A rule that fired: the stop cause it maps to, and why. */
export interface StallVerdict {
  cause: Extract<StopCause, `stall_${string}`>;
  /** Hub text with no agent text in it (no tool name or command), so it may be shown unquoted. */
  reason: string;
}

/** A duration for people: seconds under a minute, minutes under two hours, then hours. */
function duration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  if (ms < 2 * 3_600_000) return `${Math.round(ms / 60_000)} min`;
  return `${Number((ms / 3_600_000).toFixed(1))} h`;
}

/**
 * Judges one attempt's facts by design 6.8's rules: silent, hung tool, no progress, loop and budget. The hub calls it
 * only for running attempts with fresh facts. A lead is judged only during a turn, and no agent in a phase of
 * STALL_EXEMPT_PHASES. When several rules fire, the first of hung tool, loop, no progress, silent and budget decides.
 * The budget rule reads activeMs, which counts only the phases starting and turn (X-35). Null when no rule fires.
 */
export function judgeStall(role: AgentRole, facts: AttemptFacts, limits: StallLimits): StallVerdict | null {
  if (STALL_EXEMPT_PHASES.includes(facts.phase) || (role === 'lead' && facts.phase !== 'turn')) return null;
  const { tool } = facts;
  if (tool !== null) {
    const capMs = tool.capMs ?? limits.toolCapMs;
    if (tool.ageMs > capMs) {
      return {
        cause: 'stall_hung_tool',
        reason: `a tool call has run for ${duration(tool.ageMs)}, past its cap of ${duration(capMs)}`,
      };
    }
  }
  if (facts.repeatedCalls >= LOOP_CALLS) {
    return { cause: 'stall_loop', reason: `${facts.repeatedCalls} identical tool calls in a row` };
  }
  if (facts.turnsWithoutProgress >= NO_PROGRESS_TURNS) {
    return {
      cause: 'stall_no_progress',
      reason: `${facts.turnsWithoutProgress} turns in a row without a tool call or a change to the files`,
    };
  }
  if (tool === null && facts.eventAgeMs >= limits.stallMs) {
    return {
      cause: 'stall_silent',
      reason: `no agent event for ${duration(facts.eventAgeMs)}, and no tool call in flight`,
    };
  }
  if (facts.continuations >= limits.maxContinuations) {
    return { cause: 'stall_budget', reason: `${facts.continuations} continuations sent, the most an attempt gets` };
  }
  if (facts.activeMs >= limits.activeBudgetMs) {
    return { cause: 'stall_budget', reason: `${duration(facts.activeMs)} of active time, the budget of an attempt` };
  }
  return null;
}
