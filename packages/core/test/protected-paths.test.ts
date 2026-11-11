import { describe, expect, test } from 'bun:test';
import {
  PROTECTED_CLASSES,
  type ProtectedClass,
  classifyPath,
  liveChatOnly,
  matchesProtectedPattern,
  protectedViolations,
  restoreSet,
  runnerForbiddenPaths,
} from '../src/protected-paths';
import type { Task } from '../src/types';

type TaskScope = Pick<Task, 'ownedPaths' | 'kind' | 'createdBy'>;

function task(ownedPaths: string[], overrides: Partial<TaskScope> = {}): TaskScope {
  return { ownedPaths, kind: 'code', createdBy: 'agent:A-1', ...overrides };
}

const CLASSES = Object.keys(PROTECTED_CLASSES) as ProtectedClass[];
const ALL_PATTERNS = CLASSES.flatMap((name) => PROTECTED_CLASSES[name]);

/** A path each pattern covers, built from the pattern: "**" becomes two directories and "*" a name. */
function examplePath(pattern: string): string {
  const path = pattern.replaceAll('**', 'deep/er').replaceAll('*', 'x');
  return pattern.includes('/') ? path : `nested/dir/${path}`;
}

describe('the protected classes', () => {
  test('hold the patterns of design 7.3, strictest class first', () => {
    expect(CLASSES).toEqual(['agent_config', 'people_only', 'curators_only']);
    expect(PROTECTED_CLASSES.agent_config).toEqual([
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
    ]);
    expect(PROTECTED_CLASSES.people_only).toEqual([
      '.github/workflows/**',
      '.gitlab-ci.yml',
      '.gitlab/**',
      '.env*',
      '*.pem',
      '*.key',
      '.gitmodules',
      '.gitattributes',
    ]);
    expect(PROTECTED_CLASSES.curators_only).toEqual(['AGENTS.md', 'CLAUDE.md']);
  });
});

describe('classifyPath', () => {
  test('catches case tricks, because macOS file names ignore case', () => {
    expect(classifyPath('.CLAUDE/settings.json')).toBe('agent_config');
    expect(classifyPath('.Codex/config.toml')).toBe('agent_config');
    expect(classifyPath('.MCP.json')).toBe('agent_config');
    expect(classifyPath('Agents.MD')).toBe('curators_only');
    expect(classifyPath('docs/claude.md')).toBe('curators_only');
    expect(classifyPath('.GITHUB/workflows/ci.yml')).toBe('people_only');
    expect(classifyPath('.github/Workflows/release.yml')).toBe('people_only');
    expect(classifyPath('deploy/server.Key')).toBe('people_only');
    // The Kelvin sign lower-cases to "k", as a case-insensitive file system folds it.
    expect(classifyPath('deploy/server.\u212Aey')).toBe('people_only');
  });

  test('catches names that APFS takes for protected ones', () => {
    // A case-insensitive APFS volume reads the long s (U+017F) as s and the ligatures fi and fl (U+FB01, U+FB02) as
    // their letters: in a checkout on a Mac, bun runs the preload of bunfig.toml spelt with the fi ligature.
    expect(classifyPath('bun\uFB01g.toml')).toBe('agent_config');
    expect(classifyPath('.v\u017Fcode/settings.json')).toBe('agent_config');
    expect(classifyPath('.hu\u017Fky/pre-commit')).toBe('agent_config');
    expect(classifyPath('.ag\uFB02ow/config.json')).toBe('agent_config');
    expect(classifyPath('.mcp.j\u017Fon')).toBe('agent_config');
    expect(classifyPath('.pre-commit-con\uFB01g.yaml')).toBe('agent_config');
    expect(classifyPath('.tool-ver\u017Fions')).toBe('agent_config');
    expect(classifyPath('.github/work\uFB02ows/ci.yml')).toBe('people_only');
    expect(classifyPath('.gitattribute\u017F')).toBe('people_only');
    expect(classifyPath('docs/AGENT\u017F.md')).toBe('curators_only');
    expect(classifyPath('.ag\uFB02ow/run/brief.md')).toBeNull();
  });

  test('returns null for ordinary files', () => {
    const ordinary = [
      'src/index.ts',
      'README.md',
      'package.json',
      '.gitignore',
      '.github/dependabot.yml',
      '.github/CODEOWNERS',
      'docs/AGENTS.md.bak',
      'docs/my-agents.md',
      '.npmrc.example',
      'lefthook-local.yml',
      'scripts/claude/run.ts',
      'src/keys.ts',
      'certs/README.md',
      'app/(tabs)/index.tsx',
    ];
    for (const path of ordinary) expect([path, classifyPath(path)]).toEqual([path, null]);
  });

  test('.agflow/run/ is not protected, the rest of .agflow/ is agent config', () => {
    expect(classifyPath('.agflow/run/brief.md')).toBeNull();
    expect(classifyPath('.agflow/run/home/cache/x')).toBeNull();
    expect(classifyPath('.AGFLOW/Run/task.md')).toBeNull();
    expect(classifyPath('.agflow/config.json')).toBe('agent_config');
    // The directory itself, as a file or symlink, would stand in for the runner's own directory.
    expect(classifyPath('.agflow/run')).toBe('agent_config');
    expect(classifyPath('.agflow/runner/x')).toBe('agent_config');
    // Other classes still cover what sits inside it.
    expect(classifyPath('.agflow/run/CLAUDE.md')).toBe('curators_only');
  });

  test('names without a slash match at any depth, like .gitignore patterns', () => {
    expect(classifyPath('.yarnrc')).toBe('agent_config');
    expect(classifyPath('.yarnrc.yml')).toBe('agent_config');
    expect(classifyPath('packages/app/.npmrc')).toBe('agent_config');
    expect(classifyPath('packages/app/bunfig.toml')).toBe('agent_config');
    expect(classifyPath('.env')).toBe('people_only');
    expect(classifyPath('.env.local')).toBe('people_only');
    expect(classifyPath('services/api/.env.production')).toBe('people_only');
    expect(classifyPath('certs/dev/server.pem')).toBe('people_only');
    expect(classifyPath('deploy/keys/id.key')).toBe('people_only');
    expect(classifyPath('AGENTS.md')).toBe('curators_only');
    expect(classifyPath('CLAUDE.md')).toBe('curators_only');
    expect(classifyPath('packages/core/AGENTS.md')).toBe('curators_only');
    expect(classifyPath('a/b/c/d/CLAUDE.md')).toBe('curators_only');
  });

  test('a directory with a protected name covers what is inside it', () => {
    expect(classifyPath('.envs/.production/.django')).toBe('people_only');
    expect(classifyPath('slides/talk.key/Index.zip')).toBe('people_only');
  });

  test('a file or symlink where a protected directory belongs is protected too', () => {
    expect(classifyPath('.claude')).toBe('agent_config');
    expect(classifyPath('.codex')).toBe('agent_config');
    expect(classifyPath('.github/workflows')).toBe('people_only');
    expect(classifyPath('.github')).toBe('people_only');
    expect(classifyPath('.gitlab')).toBe('people_only');
  });

  test('rooted patterns start at the repository root', () => {
    expect(classifyPath('docs/.claude/settings.json')).toBeNull();
    expect(classifyPath('vendor/x/.github/workflows/ci.yml')).toBeNull();
  });

  test('a path two classes cover belongs to the stricter one', () => {
    expect(classifyPath('.claude/CLAUDE.md')).toBe('agent_config');
    expect(classifyPath('.envrc')).toBe('agent_config');
    expect(classifyPath('.github/workflows/.env')).toBe('people_only');
  });

  test('ignores "./", repeated slashes and a trailing slash', () => {
    expect(classifyPath('./.claude//settings.json')).toBe('agent_config');
    expect(classifyPath('.vscode/')).toBe('agent_config');
    expect(classifyPath('')).toBeNull();
    expect(classifyPath('.')).toBeNull();
  });
});

describe('matchesProtectedPattern', () => {
  test('agrees with classifyPath for every class pattern', () => {
    const paths = [
      ...ALL_PATTERNS.map(examplePath),
      ...ALL_PATTERNS.map((pattern) => examplePath(pattern).toUpperCase()),
      '.agflow/run/brief.md',
      '.agflow/run',
      '.github',
      'src/index.ts',
      'docs/guide.md',
    ];
    for (const path of paths) {
      const covering = CLASSES.find((name) =>
        PROTECTED_CLASSES[name].some((pattern) => matchesProtectedPattern(path, pattern)),
      );
      expect([path, classifyPath(path)]).toEqual([path, covering ?? null]);
    }
  });

  test('every pattern covers the paths it names, in any case', () => {
    for (const pattern of ALL_PATTERNS) {
      for (const path of [examplePath(pattern), examplePath(pattern).toUpperCase()]) {
        expect([pattern, path, matchesProtectedPattern(path, pattern)]).toEqual([pattern, path, true]);
      }
    }
  });

  test('"*" stays within one name and "**" spans directories', () => {
    expect(matchesProtectedPattern('.yarnrc.yml', '.yarnrc*')).toBe(true);
    expect(matchesProtectedPattern('.yarn/releases/yarn.cjs', '.yarnrc*')).toBe(false);
    expect(matchesProtectedPattern('.claude/agents/review/x.md', '.claude/**')).toBe(true);
    expect(matchesProtectedPattern('.claudex/settings.json', '.claude/**')).toBe(false);
    expect(matchesProtectedPattern('server.pem.txt', '*.pem')).toBe(false);
  });

  test('leaves .agflow/run/ out of .agflow/** only', () => {
    expect(matchesProtectedPattern('.agflow/run/brief.md', '.agflow/**')).toBe(false);
    expect(matchesProtectedPattern('.agflow/config.json', '.agflow/**')).toBe(true);
    expect(matchesProtectedPattern('.agflow/run/.env', '.env*')).toBe(true);
  });

  test('folds the code points that APFS maps onto ASCII', () => {
    // The 13 code points a case-insensitive APFS volume maps onto ASCII: three canonical decompositions (the Greek
    // question mark, the varia and the Kelvin sign) and the case folds of the long s, both sharp s and the ligatures.
    const apfs = [
      ['\u037E', ';'],
      ['\u1FEF', '`'],
      ['\u212A', 'k'],
      ['\u017F', 's'],
      ['\u00DF', 'ss'],
      ['\u1E9E', 'ss'],
      ['\uFB00', 'ff'],
      ['\uFB01', 'fi'],
      ['\uFB02', 'fl'],
      ['\uFB03', 'ffi'],
      ['\uFB04', 'ffl'],
      ['\uFB05', 'st'],
      ['\uFB06', 'st'],
    ];
    for (const [name, ascii] of apfs) {
      expect([name, matchesProtectedPattern(`docs/a${name}b`, `docs/a${ascii}b`)]).toEqual([name, true]);
      expect([name, matchesProtectedPattern(`a${name}b`, `A${ascii.toUpperCase()}B`)]).toEqual([name, true]);
    }
  });

  test('takes time linear in the depth of a path', () => {
    // Paths come from an agent's commits. Matching every directory above a path anew took 35 seconds for 2000
    // files at depth 2000.
    const deep = 'a/'.repeat(30_000);
    const paths = [`${deep}f`, `.claude/${deep}x`, `${deep}.env`];
    const started = performance.now();
    const covered = paths.filter((path) => ALL_PATTERNS.some((pattern) => matchesProtectedPattern(path, pattern)));
    expect(performance.now() - started).toBeLessThan(1000);
    expect(covered).toEqual([`.claude/${deep}x`, `${deep}.env`]);
  });
});

describe('restoreSet', () => {
  test('lists every class pattern for an agent-created code task and for a lead', () => {
    expect(restoreSet(task(['src/**']))).toEqual(ALL_PATTERNS);
    expect(restoreSet(task(['.github/workflows/**', 'certs/*.pem']))).toEqual(ALL_PATTERNS);
    expect(restoreSet(null)).toEqual(ALL_PATTERNS);
  });

  test('drops the people-only patterns a person-created task owns', () => {
    const owned = task(['.github/workflows/ci.yml', 'certs/*.pem', 'src/**'], { createdBy: 'user:alice' });
    const dropped = ['.github/workflows/**', '*.pem'];
    expect(restoreSet(owned)).toEqual(ALL_PATTERNS.filter((pattern) => !dropped.includes(pattern)));
    expect(restoreSet(task(['config/.env.example'], { createdBy: 'user:alice' }))).not.toContain('.env*');
    expect(restoreSet(task(['.github/**'], { createdBy: 'user:alice' }))).not.toContain('.github/workflows/**');
  });

  test('a broad owned path does not drop the protected names that may sit inside it', () => {
    const broad = task(['src/**', '*.md', 'docs/**', 'certs/**'], { createdBy: 'user:alice' });
    expect(restoreSet(broad)).toEqual(ALL_PATTERNS);
  });

  test('drops the curator patterns of a curation task', () => {
    const curation = task(['docs/**'], { kind: 'curation' });
    const curators: readonly string[] = PROTECTED_CLASSES.curators_only;
    expect(restoreSet(curation)).toEqual(ALL_PATTERNS.filter((pattern) => !curators.includes(pattern)));
  });

  test('never drops agent config', () => {
    const everything = task(['**', '.claude/**', '.agflow/**'], { createdBy: 'user:alice', kind: 'curation' });
    expect(restoreSet(everything)).toEqual([...PROTECTED_CLASSES.agent_config]);
  });
});

describe('runnerForbiddenPaths and liveChatOnly', () => {
  test('agent config is forbidden in every task, in any case', () => {
    for (const createdBy of ['agent:A-1', 'user:alice']) {
      for (const kind of ['code', 'curation'] as const) {
        const owned = ['src/**', '.Claude/settings.json', '.agflow/config.json', '.v\u017Fcode/**'];
        const owner = task(owned, { createdBy, kind });
        expect(runnerForbiddenPaths(owner)).toEqual([
          { path: '.Claude/settings.json', class: 'agent_config' },
          { path: '.agflow/config.json', class: 'agent_config' },
          { path: '.v\u017Fcode/**', class: 'agent_config' },
        ]);
        expect(liveChatOnly(owner)).toBe(true);
      }
    }
  });

  test('people-only paths are forbidden unless a person created the task', () => {
    const owned = ['.github/workflows/ci.yml', 'config/.env*', 'certs/*.pem'];
    expect(runnerForbiddenPaths(task(owned))).toEqual(owned.map((path) => ({ path, class: 'people_only' })));
    expect(liveChatOnly(task(owned))).toBe(true);
    expect(runnerForbiddenPaths(task(owned, { createdBy: 'user:alice' }))).toEqual([]);
    expect(liveChatOnly(task(owned, { createdBy: 'user:alice' }))).toBe(false);
    // Only "user:<login>" names a person.
    for (const createdBy of ['agent:A-3', 'system', 'user:']) {
      expect([createdBy, liveChatOnly(task(owned, { createdBy }))]).toEqual([createdBy, true]);
    }
  });

  test('curator paths are forbidden unless the task is a curation task', () => {
    const owned = ['docs/AGENTS.md', 'packages/*/CLAUDE.md'];
    expect(runnerForbiddenPaths(task(owned))).toEqual(owned.map((path) => ({ path, class: 'curators_only' })));
    expect(liveChatOnly(task(owned, { createdBy: 'user:alice' }))).toBe(true);
    expect(runnerForbiddenPaths(task(owned, { kind: 'curation' }))).toEqual([]);
    expect(liveChatOnly(task(owned, { kind: 'curation' }))).toBe(false);
  });

  test('an owned path includes a protected place when it takes in its whole directory', () => {
    expect(runnerForbiddenPaths(task(['**']))).toEqual([{ path: '**', class: 'agent_config' }]);
    expect(runnerForbiddenPaths(task(['.github/**']))).toEqual([{ path: '.github/**', class: 'people_only' }]);
    expect(runnerForbiddenPaths(task(['.github']))).toEqual([{ path: '.github', class: 'people_only' }]);
    expect(runnerForbiddenPaths(task(['./.vscode//**']))).toEqual([{ path: './.vscode//**', class: 'agent_config' }]);
  });

  test('ordinary and broad owned paths leave a task to runners', () => {
    const owners = [[], ['src/**'], ['*.md', 'docs/**', 'certs/**'], ['**/*.ts'], ['.github/*.yml']];
    for (const ownedPaths of [...owners, ['.agflow/run/**']]) {
      expect([ownedPaths, liveChatOnly(task(ownedPaths))]).toEqual([ownedPaths, false]);
    }
  });
});

describe('protectedViolations', () => {
  const changed = [
    'src/app.ts',
    '.claude/settings.json',
    '.GitHub/workflows/ci.yml',
    'docs/CLAUDE.md',
    'certs/server.pem',
    '.agflow/run/brief.md',
    '.claude/CLAUDE.md',
    '.v\u017Fcode/settings.json',
  ];

  test('lists the changed paths a task may not change, with their class', () => {
    expect(protectedViolations(changed, task(['src/**']))).toEqual([
      { path: '.claude/settings.json', class: 'agent_config' },
      { path: '.GitHub/workflows/ci.yml', class: 'people_only' },
      { path: 'docs/CLAUDE.md', class: 'curators_only' },
      { path: 'certs/server.pem', class: 'people_only' },
      { path: '.claude/CLAUDE.md', class: 'agent_config' },
      { path: '.v\u017Fcode/settings.json', class: 'agent_config' },
    ]);
  });

  test('leaves out the paths the task is exempt from', () => {
    const exempt = task(['.github/workflows/**'], { createdBy: 'user:alice', kind: 'curation' });
    expect(protectedViolations(changed, exempt)).toEqual([
      { path: '.claude/settings.json', class: 'agent_config' },
      { path: 'certs/server.pem', class: 'people_only' },
      { path: '.claude/CLAUDE.md', class: 'agent_config' },
      { path: '.v\u017Fcode/settings.json', class: 'agent_config' },
    ]);
  });

  test('agrees with the restore set the runner matches', () => {
    const tasks = [
      task(['src/**']),
      task(['.github/workflows/**', '.env*'], { createdBy: 'user:alice' }),
      task(['docs/**'], { kind: 'curation' }),
      null,
    ];
    const paths = [...changed, ...ALL_PATTERNS.map(examplePath)];
    for (const subject of tasks) {
      const patterns = restoreSet(subject);
      for (const path of paths) {
        const restored = patterns.some((pattern) => matchesProtectedPattern(path, pattern));
        expect([path, protectedViolations([path], subject).length > 0]).toEqual([path, restored]);
      }
    }
  });
});
