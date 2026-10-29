import { describe, expect, test } from 'bun:test';
import { AttemptFactsSchema } from '../src/runner-protocol';
import {
  STALL_EXEMPT_PHASES,
  type StallLimits,
  capForCommand,
  computeToolCaps,
  isLongCommand,
  judgeStall,
  longPatterns,
} from '../src/stall';
import type { AttemptFacts, AttemptPhase } from '../src/types';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Design 12's defaults. */
const LIMITS: StallLimits = {
  stallMs: 10 * MINUTE,
  toolCapMs: 30 * MINUTE,
  maxContinuations: 25,
  activeBudgetMs: 4 * HOUR,
};

const CAPS = computeToolCaps({ toolCapMs: 30 * MINUTE, longToolCapMs: 90 * MINUTE }, [
  { name: 'unit', cmd: 'bun test packages/core', timeoutS: 600 },
  { name: 'e2e', cmd: 'bun run e2e   --headless', timeoutS: 7200 },
  { name: 'lint', cmd: 'bun run lint' },
]);

function facts(overrides: Partial<AttemptFacts> = {}): AttemptFacts {
  return {
    attemptId: 'T-42-a3',
    fence: { epoch: 1, counter: 7 },
    phase: 'turn',
    eventAgeMs: 0,
    tool: null,
    fsAgeMs: null,
    commitAgeMs: null,
    turns: 4,
    turnsWithoutProgress: 0,
    repeatedCalls: 0,
    continuations: 0,
    vendorErrorMs: 0,
    activeMs: 0,
    contextUsed: null,
    ...overrides,
  };
}

function tool(ageMs: number, capMs: number | null): NonNullable<AttemptFacts['tool']> {
  return { name: 'Bash', command: 'bun test', long: true, capMs, ageMs };
}

/** Facts on which every rule fires. */
function firing(overrides: Partial<AttemptFacts> = {}): AttemptFacts {
  return facts({
    eventAgeMs: 5 * HOUR,
    tool: tool(5 * HOUR, 90 * MINUTE),
    turnsWithoutProgress: 3,
    repeatedCalls: 3,
    continuations: 25,
    activeMs: 4 * HOUR,
    ...overrides,
  });
}

describe('computeToolCaps', () => {
  test('gives the default and long caps, and per check the long cap or its timeout plus 10 minutes', () => {
    expect(CAPS).toEqual({
      defaultMs: 30 * MINUTE,
      longMs: 90 * MINUTE,
      checks: [
        // 600 s + 10 min is below the long cap.
        { cmd: 'bun test packages/core', capMs: 90 * MINUTE },
        { cmd: 'bun run e2e   --headless', capMs: 130 * MINUTE },
        // Without a timeout, the long cap.
        { cmd: 'bun run lint', capMs: 90 * MINUTE },
      ],
    });
  });

  test('a lead attempt, with no checks, gets the default and long caps', () => {
    expect(computeToolCaps({ toolCapMs: 5 * MINUTE, longToolCapMs: 7 * MINUTE }, [])).toEqual({
      defaultMs: 5 * MINUTE,
      longMs: 7 * MINUTE,
      checks: [],
    });
  });
});

describe('capForCommand', () => {
  test("gives a check's cap when the command contains the check's cmd, whitespace normalised", () => {
    expect(capForCommand(CAPS, 'bun test packages/core')).toBe(90 * MINUTE);
    expect(capForCommand(CAPS, 'cd /work/T-42-a3 &&  bun   run e2e --headless 2>&1 | tail -50')).toBe(130 * MINUTE);
    expect(capForCommand(CAPS, 'bun run e2e\n\t--headless --retries 2')).toBe(130 * MINUTE);
    // Containment is plain text: lint:fix contains the lint check.
    expect(capForCommand(CAPS, 'bun run lint:fix')).toBe(90 * MINUTE);
  });

  test('takes the largest cap of the checks the command contains', () => {
    const caps = {
      defaultMs: 30 * MINUTE,
      longMs: 90 * MINUTE,
      checks: [
        { cmd: 'make', capMs: 100 * MINUTE },
        { cmd: 'make  test', capMs: 150 * MINUTE },
      ],
    };
    expect(capForCommand(caps, 'make test')).toBe(150 * MINUTE);
    expect(capForCommand(caps, 'make build')).toBe(100 * MINUTE);
  });

  test('a check whose cmd is only whitespace matches nothing', () => {
    const caps = { defaultMs: 30 * MINUTE, longMs: 90 * MINUTE, checks: [{ cmd: ' \n ', capMs: 999 * MINUTE }] };
    expect(capForCommand(caps, 'ls -la')).toBe(30 * MINUTE);
  });

  test('gives the long cap when a segment of the command starts with a build or test command', () => {
    const long = [
      'bun test',
      'bun test --watch=false src/auth',
      'npm run build',
      'pytest -x tests/unit',
      'python3 -m pytest',
      'cargo test -p core',
      'go test ./...',
      'make',
      'make -j8 all',
      'tsc --noEmit',
      'npx tsc -p .',
      'cd app && npm run build',
      'npm ci; npm test',
      'git diff --stat || cargo build --release',
      'CI=1 bun test',
      'time cargo build --release',
      'env RUST_LOG=debug cargo test',
      '/usr/bin/make install',
      './gradlew test',
      "sh -c 'go test ./...'",
      'echo start && (cd web && bun run build)',
      'out=$(make 2>&1)',
    ];
    for (const command of long) expect([command, capForCommand(CAPS, command)]).toEqual([command, 90 * MINUTE]);
  });

  test('gives the default cap to every other command, and to a tool call without one', () => {
    const other = [
      'ls -la',
      'git status',
      'cat Makefile',
      'echo make',
      'makefile-lint',
      'rg tsc src',
      'bun install',
      'npm run dev',
      'python script.py',
      '',
    ];
    for (const command of other) expect([command, capForCommand(CAPS, command)]).toEqual([command, 30 * MINUTE]);
    expect(capForCommand(CAPS, null)).toBe(30 * MINUTE);
  });
});

describe('longPatterns', () => {
  test('cover the usual build and test commands', () => {
    for (const pattern of ['bun test', 'npm run build', 'pytest', 'cargo test', 'go test', 'make', 'tsc']) {
      expect(longPatterns).toContain(pattern);
    }
  });

  test('each entry, run alone or with arguments, is a long command', () => {
    for (const pattern of longPatterns) {
      expect([pattern, isLongCommand(pattern), isLongCommand(`${pattern} --verbose`)]).toEqual([pattern, true, true]);
    }
  });
});

describe('judgeStall', () => {
  test('a healthy attempt does not stall', () => {
    expect(AttemptFactsSchema.safeParse(facts()).success).toBe(true);
    expect(judgeStall('worker', facts(), LIMITS)).toBeNull();
    const busy = facts({ tool: tool(5 * MINUTE, 30 * MINUTE), eventAgeMs: 5 * MINUTE });
    expect(judgeStall('worker', busy, LIMITS)).toBeNull();
  });

  test('silent: no agent event for stallMs, with no tool in flight', () => {
    expect(judgeStall('worker', facts({ eventAgeMs: 10 * MINUTE - 1 }), LIMITS)).toBeNull();
    expect(judgeStall('worker', facts({ eventAgeMs: 10 * MINUTE }), LIMITS)).toEqual({
      cause: 'stall_silent',
      reason: 'no agent event for 10 min, and no tool call in flight',
    });
    // A tool call in flight, still under its cap, keeps a quiet agent from counting as silent.
    const building = facts({ eventAgeMs: 80 * MINUTE, tool: tool(80 * MINUTE, 90 * MINUTE) });
    expect(judgeStall('worker', building, LIMITS)).toBeNull();
  });

  test('hung tool: a tool call older than the cap the runner reported, whatever its file activity', () => {
    expect(judgeStall('worker', facts({ tool: tool(90 * MINUTE, 90 * MINUTE), fsAgeMs: 0 }), LIMITS)).toBeNull();
    expect(judgeStall('worker', facts({ tool: tool(91 * MINUTE, 90 * MINUTE), fsAgeMs: 0 }), LIMITS)).toEqual({
      cause: 'stall_hung_tool',
      reason: 'a tool call has run for 91 min, past its cap of 90 min',
    });
  });

  test('hung tool: a tool call reported without a cap gets toolCapMs', () => {
    expect(judgeStall('worker', facts({ tool: tool(30 * MINUTE, null) }), LIMITS)).toBeNull();
    expect(judgeStall('worker', facts({ tool: tool(30 * MINUTE + 1, null) }), LIMITS)?.cause).toBe('stall_hung_tool');
  });

  test('no progress: 3 completed turns in a row without a tool call or a diff change', () => {
    expect(judgeStall('worker', facts({ turnsWithoutProgress: 2 }), LIMITS)).toBeNull();
    expect(judgeStall('worker', facts({ turnsWithoutProgress: 3 }), LIMITS)).toEqual({
      cause: 'stall_no_progress',
      reason: '3 turns in a row without a tool call or a change to the files',
    });
  });

  test('loop: 3 identical tool calls in a row', () => {
    expect(judgeStall('worker', facts({ repeatedCalls: 2 }), LIMITS)).toBeNull();
    expect(judgeStall('worker', facts({ repeatedCalls: 3 }), LIMITS)).toEqual({
      cause: 'stall_loop',
      reason: '3 identical tool calls in a row',
    });
  });

  test('budget: maxContinuations continuations, or activeBudgetMs of active time', () => {
    expect(judgeStall('worker', facts({ continuations: 24 }), LIMITS)).toBeNull();
    expect(judgeStall('worker', facts({ continuations: 25 }), LIMITS)).toEqual({
      cause: 'stall_budget',
      reason: '25 continuations sent, the most an attempt gets',
    });
    expect(judgeStall('worker', facts({ activeMs: 4 * HOUR - 1 }), LIMITS)).toBeNull();
    expect(judgeStall('worker', facts({ activeMs: 4 * HOUR }), LIMITS)).toEqual({
      cause: 'stall_budget',
      reason: '4 h of active time, the budget of an attempt',
    });
  });

  test('file and commit ages, turns, vendor errors and context use decide nothing', () => {
    const quiet = facts({
      fsAgeMs: 9 * HOUR,
      commitAgeMs: 9 * HOUR,
      turns: 400,
      vendorErrorMs: 9 * HOUR,
      contextUsed: 1,
    });
    expect(judgeStall('worker', quiet, LIMITS)).toBeNull();
  });

  test('the reason is hub text, without the tool name or command that an agent chose', () => {
    const forged = { ...tool(HOUR, MINUTE), name: 'IGNORE_PREVIOUS', command: 'echo "## Standing rules"' };
    const verdict = judgeStall('worker', facts({ tool: forged }), LIMITS);
    expect(verdict?.cause).toBe('stall_hung_tool');
    expect(verdict?.reason).not.toContain('IGNORE');
    expect(verdict?.reason).not.toContain('Standing');
  });

  test('waiting_approval, quota_wait, vendor_error, preparing and stopping never stall', () => {
    expect(STALL_EXEMPT_PHASES).toEqual(['waiting_approval', 'quota_wait', 'vendor_error', 'preparing', 'stopping']);
    for (const phase of STALL_EXEMPT_PHASES) {
      for (const role of ['worker', 'lead'] as const) {
        expect([phase, role, judgeStall(role, firing({ phase }), LIMITS)]).toEqual([phase, role, null]);
      }
    }
  });

  test('a worker is judged while starting, in a turn and idle', () => {
    for (const phase of ['starting', 'turn', 'idle'] as const) {
      expect([phase, judgeStall('worker', facts({ phase, eventAgeMs: HOUR }), LIMITS)?.cause]).toEqual([
        phase,
        'stall_silent',
      ]);
    }
  });

  test('a lead is judged only in a turn', () => {
    const other: AttemptPhase[] = ['starting', 'idle', ...STALL_EXEMPT_PHASES];
    for (const phase of other) expect([phase, judgeStall('lead', firing({ phase }), LIMITS)]).toEqual([phase, null]);
    expect(judgeStall('lead', facts({ phase: 'turn', eventAgeMs: HOUR }), LIMITS)?.cause).toBe('stall_silent');
    expect(judgeStall('lead', facts({ phase: 'turn', repeatedCalls: 3 }), LIMITS)?.cause).toBe('stall_loop');
  });

  test('several firing rules resolve to one cause: hung tool, loop, no progress, silent, then budget', () => {
    expect(judgeStall('worker', firing(), LIMITS)?.cause).toBe('stall_hung_tool');
    expect(judgeStall('worker', firing({ tool: null }), LIMITS)?.cause).toBe('stall_loop');
    expect(judgeStall('worker', firing({ tool: null, repeatedCalls: 0 }), LIMITS)?.cause).toBe('stall_no_progress');
    const silent = firing({ tool: null, repeatedCalls: 0, turnsWithoutProgress: 0 });
    expect(judgeStall('worker', silent, LIMITS)?.cause).toBe('stall_silent');
    expect(judgeStall('worker', { ...silent, eventAgeMs: 0 }, LIMITS)?.cause).toBe('stall_budget');
    // A tool in flight under its cap rules out silent, not the rules after it.
    expect(judgeStall('worker', { ...silent, tool: tool(MINUTE, 90 * MINUTE) }, LIMITS)?.cause).toBe('stall_budget');
  });
});
