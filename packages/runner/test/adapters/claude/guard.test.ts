import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HookInput, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import { createGuardHook, type GuardScope, guardDecision } from '../../../src/adapters/claude/guard';
import { claudeProjectDir } from '../../../src/adapters/claude/paths';

interface Fixture {
  /** What afterEach removes. */
  base: string;
  /** The symlinked directory everything in the scope is reached through. */
  root: string;
  scope: GuardScope;
  /** Another attempt's clone of the same project. */
  other: string;
  /** Another attempt of the same task, whose name starts with the clone's. */
  sibling: string;
  ownProject: string;
  otherProject: string;
  siblingProject: string;
}

let fx: Fixture;

beforeEach(() => {
  // The scope reaches everything through a symlink, as macOS's /tmp -> /private/tmp does, on every platform.
  const base = mkdtempSync(join(tmpdir(), 'agflow-guard-'));
  mkdirSync(join(base, 'real'));
  symlinkSync(join(base, 'real'), join(base, 'link'));
  const root = join(base, 'link');
  const home = join(root, 'home');
  const workRoot = join(home, '.agflow', 'work');
  const clone = join(workRoot, 'p', 'T-1-a1');
  const other = join(workRoot, 'p', 'T-2-b2');
  const sibling = join(workRoot, 'p', 'T-1-a10');
  const claudeHome = join(home, '.agflow', 'runner', 'homes', 'claude');
  const tmpDir = join(root, 'tmp', 'agf', 'abc123');
  // Like M2b's createTaskClone, which clones with --template=: the clone has no .git/hooks.
  for (const dir of [join(clone, '.git'), join(clone, 'src'), join(clone, 'a', 'b'), other, sibling, tmpDir]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(clone, '.git', 'config'), '[core]\n');
  writeFileSync(join(other, 'secret.txt'), 'x');
  writeFileSync(join(sibling, 'secret.txt'), 'x');
  const ownProject = claudeProjectDir(claudeHome, clone);
  const otherProject = claudeProjectDir(claudeHome, other);
  const siblingProject = claudeProjectDir(claudeHome, sibling);
  mkdirSync(join(ownProject, 'tool-results'), { recursive: true });
  mkdirSync(otherProject, { recursive: true });
  mkdirSync(siblingProject, { recursive: true });
  fx = {
    base,
    root,
    scope: { clone, tmpDir, workRoot, claudeHome, home },
    other,
    sibling,
    ownProject,
    otherProject,
    siblingProject,
  };
});

afterEach(() => {
  rmSync(fx.base, { recursive: true, force: true });
});

function decide(tool: string, input: Record<string, unknown>, cwd?: string) {
  return guardDecision(fx.scope, tool, input, cwd);
}

function refusal(tool: string, input: Record<string, unknown>, cwd?: string): string {
  const verdict = decide(tool, input, cwd);
  if (verdict.allow) throw new Error(`expected ${tool} ${JSON.stringify(input)} to be refused`);
  return verdict.reason;
}

const EDITORS = [
  ['Edit', 'file_path'],
  ['Write', 'file_path'],
  ['NotebookEdit', 'notebook_path'],
] as const;

describe('the guard on Edit, Write and NotebookEdit', () => {
  test('they are allowed inside the clone and the temporary directory, compared as real paths', () => {
    const { clone, tmpDir } = fx.scope;
    const realClone = realpathSync(clone);
    for (const [tool, key] of EDITORS) {
      for (const path of [
        join(clone, 'src', 'a.ts'),
        join(realClone, 'src', 'a.ts'),
        join(clone, 'new', 'deeper', 'file.ts'),
        join(tmpDir, 'scratch.txt'),
        join(realpathSync(tmpDir), 'scratch.txt'),
        'src/relative.ts',
        join(clone, '.git', 'info', 'exclude'),
      ]) {
        const verdict = decide(tool, { [key]: path });
        expect({ tool, path, verdict }).toEqual({ tool, path, verdict: { allow: true } });
      }
    }
  });

  test('they are refused outside, through a symlink that points out, through .., and without a path', () => {
    const { clone } = fx.scope;
    symlinkSync(fx.root, join(clone, 'out'));
    symlinkSync(join(fx.root, 'planted.txt'), join(clone, 'dangling'));
    for (const [tool, key] of EDITORS) {
      for (const path of [
        join(fx.root, 'outside.txt'),
        join(fx.other, 'secret.txt'),
        join(clone, '..', 'T-2-b2', 'x.ts'),
        '../T-2-b2/x.ts',
        join(clone, 'out', 'x.ts'),
        join(clone, 'dangling'),
        '~/.zshrc',
        '~/.agflow/work/p/T-2-b2/x.ts',
        fx.scope.workRoot,
        join(fx.sibling, 'x.ts'),
        ` ${join(fx.other, 'x.ts')}`,
      ]) {
        expect({ tool, path, reason: refusal(tool, { [key]: path }) }).toEqual({
          tool,
          path,
          reason: `${tool} outside the clone and its temporary directory is refused`,
        });
      }
      expect(refusal(tool, {})).toBe(`${tool} without a file path is refused`);
    }
  });

  test('.git/config and everything under .git/hooks are refused, also in another spelling', () => {
    const { clone } = fx.scope;
    const paths = [
      join(clone, '.git', 'config'),
      join(clone, '.git', 'hooks'),
      join(clone, '.git', 'hooks', 'pre-commit'),
      join(clone, '.git', 'hooks', 'new', 'x'),
      join(clone, 'src', '..', '.git', 'config'),
      '.git/hooks/pre-push',
      // A case-insensitive volume (macOS by default) reaches the same files in these spellings, the Kelvin sign
      // and ſ included, even where the clone has no hooks directory yet.
      join(clone, '.GIT', 'CONFIG'),
      join(clone, '.git', 'Hooks', 'pre-commit'),
      join(clone, '.git', 'HOOKS', 'x'),
      join(clone, '.git', 'hoo\u212As', 'x'),
      join(clone, '.git', 'hook\u017F', 'x'),
    ];
    for (const [tool, key] of EDITORS) {
      for (const path of paths) {
        expect({ tool, path, reason: refusal(tool, { [key]: path }) }).toEqual({
          tool,
          path,
          reason: `${tool} on .git/config or under .git/hooks is refused`,
        });
      }
    }
    // Once a hooks directory exists in another spelling, the real path takes that spelling.
    mkdirSync(join(clone, '.git', 'Hooks'));
    expect(refusal('Write', { file_path: join(clone, '.git', 'hooks', 'pre-commit') })).toBe(
      'Write on .git/config or under .git/hooks is refused',
    );
  });
});

describe('the guard on Read, Glob and Grep', () => {
  test("another attempt's clone is refused, also through a symlink and as a search root", () => {
    const { clone, workRoot } = fx.scope;
    symlinkSync(fx.other, join(clone, 'peek'));
    const otherClone = "is in another attempt's clone, which is refused";
    expect(refusal('Read', { file_path: join(fx.other, 'secret.txt') })).toBe(`Read ${otherClone}`);
    expect(refusal('Read', { file_path: join(clone, 'peek', 'secret.txt') })).toBe(`Read ${otherClone}`);
    expect(refusal('Read', { file_path: '../T-2-b2/secret.txt' })).toBe(`Read ${otherClone}`);
    expect(refusal('Grep', { pattern: 'x', path: fx.other })).toBe(`Grep ${otherClone}`);
    expect(refusal('Glob', { pattern: '**/*.txt', path: join(clone, 'peek') })).toBe(`Glob ${otherClone}`);
    expect(refusal('Glob', { pattern: `${fx.other}/**/*.txt` })).toBe(`Glob ${otherClone}`);
    expect(refusal('Glob', { pattern: '../T-2-b2/*' })).toBe(`Glob ${otherClone}`);
    expect(refusal('Grep', { pattern: 'x', path: workRoot })).toBe(`Grep ${otherClone}`);
    expect(refusal('Grep', { pattern: 'x', path: join(fx.root, 'home') })).toBe(
      "Grep would search other attempts' clones, which is refused",
    );
    // T-1-a10 is another attempt, although its name starts with T-1-a1.
    expect(refusal('Read', { file_path: join(fx.sibling, 'secret.txt') })).toBe(`Read ${otherClone}`);
    // The CLI trims a search path before it resolves it.
    for (const space of [' ', '\t']) {
      expect(refusal('Grep', { pattern: 'x', path: `${space}${fx.other}` })).toBe(`Grep ${otherClone}`);
      expect(refusal('Glob', { pattern: '*', path: `${space}${fx.other}` })).toBe(`Glob ${otherClone}`);
    }
    // A pattern without a wildcard is searched for in its directory, here the whole ~/.agflow.
    expect(refusal('Glob', { pattern: join(fx.root, 'home', '.agflow', 'secret.txt') })).toBe(
      "Glob would search other attempts' clones, which is refused",
    );
    expect(refusal('Glob', { pattern: '/**/*.jsonl' })).toBe(
      "Glob would search other attempts' clones, which is refused",
    );
    expect(refusal('Read', { file_path: '~/.agflow/work/p/T-2-b2/secret.txt' })).toBe(`Read ${otherClone}`);
  });

  test('relative paths resolve against the current directory', () => {
    const { clone } = fx.scope;
    const otherClone = "is in another attempt's clone, which is refused";
    const deeper = join(clone, 'a', 'b');
    expect(refusal('Grep', { pattern: 'x', path: '../../../T-2-b2' }, deeper)).toBe(`Grep ${otherClone}`);
    expect(refusal('Glob', { pattern: '*', path: '../../../T-2-b2' }, deeper)).toBe(`Glob ${otherClone}`);
    expect(refusal('Read', { file_path: '../../../T-2-b2/secret.txt' }, deeper)).toBe(`Read ${otherClone}`);
    expect(decide('Glob', { pattern: '*.ts' }, join(clone, 'src'))).toEqual({ allow: true });
    expect(decide('Write', { file_path: 'x.ts' }, deeper)).toEqual({ allow: true });
  });

  test("other Claude project directories are refused; the attempt's own is allowed", () => {
    const { claudeHome } = fx.scope;
    const otherProject = "is in another session's Claude project directory, which is refused";
    expect(refusal('Read', { file_path: join(fx.otherProject, 's.jsonl') })).toBe(`Read ${otherProject}`);
    expect(refusal('Grep', { pattern: 'token', path: join(claudeHome, 'projects') })).toBe(`Grep ${otherProject}`);
    expect(refusal('Glob', { pattern: `${claudeHome}/projects/*/*.jsonl` })).toBe(`Glob ${otherProject}`);
    expect(refusal('Grep', { pattern: 'token', path: claudeHome })).toBe(
      "Grep would search other sessions' Claude project directories, which is refused",
    );
    expect(refusal('Read', { file_path: join(fx.siblingProject, 's.jsonl') })).toBe(`Read ${otherProject}`);
    expect(decide('Read', { file_path: join(fx.ownProject, 'tool-results', 'out.txt') })).toEqual({ allow: true });
    expect(decide('Grep', { pattern: 'x', path: fx.ownProject })).toEqual({ allow: true });
  });

  test('the own clone, places outside both roots and searches without a path are allowed', () => {
    const { clone, tmpDir } = fx.scope;
    for (const [tool, input] of [
      ['Read', { file_path: join(clone, 'src', 'a.ts') }],
      ['Read', { file_path: join(realpathSync(clone), '.git', 'config') }],
      ['Read', { file_path: join(tmpDir, 'out.log') }],
      ['Read', { file_path: '/etc/hosts' }],
      ['Read', { file_path: 'src/a.ts' }],
      ['Grep', { pattern: 'x' }],
      ['Grep', { pattern: 'x', path: '/usr/include' }],
      ['Glob', { pattern: '**/*.ts' }],
      ['Glob', { pattern: 'src/**/*.ts', path: clone }],
    ] as const) {
      expect({ tool, input, verdict: decide(tool, input) }).toEqual({ tool, input, verdict: { allow: true } });
    }
  });
});

describe('the guard on other tools', () => {
  test('Bash goes through bashVerdict', () => {
    expect(decide('Bash', { command: 'git status && bun test' })).toEqual({ allow: true });
    expect(refusal('Bash', { command: 'cd sub && git push' })).toBe('git push is refused: only the runner pushes');
    expect(refusal('Bash', {})).toBe('Bash without a command is refused');
  });

  test('other tools pass', () => {
    for (const tool of ['mcp__agflow__task_get', 'Task', 'TaskCreate', 'WebFetch']) {
      expect(decide(tool, { file_path: join(fx.other, 'secret.txt') })).toEqual({ allow: true });
    }
  });
});

describe('createGuardHook', () => {
  function input(tool: string, toolInput: unknown, cwd = fx.scope.clone): PreToolUseHookInput {
    return {
      hook_event_name: 'PreToolUse',
      session_id: 's',
      transcript_path: join(fx.ownProject, 's.jsonl'),
      cwd,
      tool_name: tool,
      tool_input: toolInput,
      tool_use_id: 'toolu_1',
    };
  }

  async function call(hookInput: HookInput): Promise<unknown> {
    const matcher = createGuardHook(fx.scope);
    expect(matcher.matcher).toBeUndefined();
    const [hook] = matcher.hooks;
    if (!hook) throw new Error('the guard matcher has no hook');
    return hook(hookInput, 'toolu_1', { signal: new AbortController().signal });
  }

  test('a refusal is a PreToolUse deny with the reason; anything else answers {}', async () => {
    expect(await call(input('Write', { file_path: join(fx.root, 'x'), content: 'x' }))).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'Write outside the clone and its temporary directory is refused',
      },
    });
    expect(await call(input('Write', { file_path: join(fx.scope.clone, 'x'), content: 'x' }))).toEqual({});
    expect(await call(input('Bash', { command: 'ls' }))).toEqual({});
    expect(await call({ ...input('Bash', { command: 'git push' }), hook_event_name: 'PostToolUse' } as never)).toEqual(
      {},
    );
  });

  test("relative paths resolve against the input's cwd", async () => {
    const deeper = join(fx.scope.clone, 'a', 'b');
    for (const tool of ['Grep', 'Glob']) {
      expect(await call(input(tool, { pattern: '*', path: '../../../T-2-b2' }, deeper))).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `${tool} is in another attempt's clone, which is refused`,
        },
      });
    }
    // An empty cwd falls back to the clone.
    expect(await call(input('Write', { file_path: 'x.ts', content: 'x' }, ''))).toEqual({});
  });

  test('a call the guard cannot judge is denied, never thrown', async () => {
    const throwing = {
      get command(): string {
        throw new Error('boom');
      },
    };
    expect(await call(input('Bash', throwing))).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: expect.stringMatching(/^the guard could not judge this call \(boom\)/),
      },
    });
    const deep = `git push; echo ${'"${'.repeat(16_408)}x${'}"'.repeat(16_408)}`;
    expect(await call(input('Bash', { command: deep }))).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
  });

  test('a path that cannot be resolved is refused, not thrown', async () => {
    symlinkSync('loop-b', join(fx.scope.clone, 'loop-a'));
    symlinkSync('loop-a', join(fx.scope.clone, 'loop-b'));
    expect(await call(input('Edit', { file_path: join(fx.scope.clone, 'loop-a', 'x') }))).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: 'deny',
        permissionDecisionReason: expect.stringMatching(/^Edit on a path that cannot be resolved/),
      },
    });
  });
});
