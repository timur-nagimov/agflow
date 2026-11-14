// The seed commit of agflow start: the spec, the agents' instructions, the dependency preparation and check the runner
// reads from .agflow/config.json, and three scripts that do nothing harmful in an empty project and the right thing
// once the stack's manifest exists.
import { type SpecFile, specMarkdown } from './spec';

/** A stack agflow start knows; any other text is a stack the first task sets up. */
export type KnownStack = 'python' | 'typescript';

function known(stack: string | null): KnownStack | null {
  const name = stack?.toLowerCase();
  return name === 'python' || name === 'typescript' ? name : null;
}

/** The stack as agents read it, in AGENTS.md, the goal and the standing rule. */
export function describeStack(stack: string | null): string {
  const kind = known(stack);
  if (kind === 'python') return 'Python 3, managed with uv (pyproject.toml); tests with pytest; ruff when configured';
  if (kind === 'typescript') return 'TypeScript on Bun (package.json); tests with bun test or the test script';
  return stack ?? 'not chosen yet: the first task picks one that fits SPEC.md';
}

/** One file of the seed commit; executable files get mode 755. */
export interface SeedFile {
  path: string;
  content: string | Uint8Array;
  executable?: boolean;
}

const LAYOUT: Record<KnownStack | 'other', string> = {
  python: `- \`src/<package>/\`: the application code; \`tests/\`: the pytest tests.
- \`pyproject.toml\`: the dependencies (\`uv add <package>\`) and the tools' settings; \`uv.lock\` is committed.
- A \`demo\` entry under \`[project.scripts]\` is what \`scripts/demo.sh\` runs.`,
  typescript: `- \`src/\`: the application code; tests beside it as \`*.test.ts\`.
- \`package.json\`: the dependencies and scripts; the lockfile is committed. \`tsconfig.json\` makes the check run tsc.
- A \`demo\` script in \`package.json\` is what \`scripts/demo.sh\` runs.`,
  other: `- The first task decides the layout, fills in \`scripts/install.sh\`, \`scripts/check.sh\` and \`scripts/demo.sh\`,
  and asks for a curation task to write the layout here.`,
};

function agentsMd(name: string, stack: string | null): string {
  return `# ${name}

SPEC.md is the source of truth: it says what to build. The originals it was made from are in docs/spec/.

## Stack

${describeStack(stack)}.

## Where things go

${LAYOUT[known(stack) ?? 'other']}
- \`scripts/\`: the three commands below. \`docs/\`: notes, and the spec's originals in \`docs/spec/\`.

## Commands

- \`bash scripts/install.sh\`: installs the dependencies. The runner runs it before agents start.
- \`bash scripts/check.sh\`: the linters and the tests. It must pass before you submit.
- \`bash scripts/demo.sh\`: shows the product as a person would see it.

## Definition of done

A task is done when \`bash scripts/check.sh\` passes and its acceptance criteria are met. When SPEC.md is covered,
keep improving the product until the deadline: fix defects, add tests, polish the demo, add features.

Keep this file current: when the layout, a command or a convention changes, a curation task changes it here.
`;
}

const HEADER = `#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
`;

/** The three scripts per stack; an unknown stack's say what to fill in, and pass. */
const SCRIPTS: Record<KnownStack | 'other', Record<'install' | 'check' | 'demo', string>> = {
  python: {
    install: `# Installs the dependencies. The runner runs it before agents start (.agflow/config.json).
if [ ! -f pyproject.toml ]; then
  echo "no pyproject.toml yet: nothing to install"
  exit 0
fi
uv sync
`,
    check: `# The project's check: the linters and the tests. A task is done only when it passes.
if [ ! -f pyproject.toml ]; then
  echo "no pyproject.toml yet: nothing to check"
  exit 0
fi
if grep -q '^\\[tool\\.ruff' pyproject.toml || [ -f ruff.toml ] || [ -f .ruff.toml ]; then
  uv run ruff check .
fi
if [ -d tests ]; then
  uv run pytest
fi
`,
    demo: `# Shows the product: the demo entry under [project.scripts] in pyproject.toml.
if [ -f pyproject.toml ] && grep -Eq '^demo[[:space:]]*=' pyproject.toml; then
  exec uv run demo
fi
echo "no demo yet: add a demo entry under [project.scripts] in pyproject.toml"
`,
  },
  typescript: {
    install: `# Installs the dependencies. The runner runs it before agents start (.agflow/config.json).
if [ ! -f package.json ]; then
  echo "no package.json yet: nothing to install"
  exit 0
fi
if [ -f package-lock.json ]; then
  npm ci
else
  bun install
fi
`,
    check: `# The project's check: the type check and the tests. A task is done only when it passes.
if [ ! -f package.json ]; then
  echo "no package.json yet: nothing to check"
  exit 0
fi
if [ -f tsconfig.json ]; then
  bunx tsc --noEmit
fi
if grep -Eq '"test"[[:space:]]*:' package.json; then
  bun run test
elif [ -n "$(find . -name '*.test.ts' -not -path './node_modules/*' -print -quit)" ]; then
  bun test
fi
`,
    demo: `# Shows the product: the demo script in package.json.
if [ -f package.json ] && grep -Eq '"demo"[[:space:]]*:' package.json; then
  exec bun run demo
fi
echo "no demo yet: add a demo script to package.json"
`,
  },
  other: {
    install: `# Installs the dependencies. The runner runs it before agents start (.agflow/config.json).
echo "scripts/install.sh: fill in how to install the dependencies of the stack AGENTS.md names"
`,
    check: `# The project's check: the linters and the tests. A task is done only when it passes.
echo "scripts/check.sh: fill in the linters and the tests of the stack AGENTS.md names"
`,
    demo: `# Shows the product as a person would see it.
echo "scripts/demo.sh: fill in how to show the product"
`,
  },
};

/** The files whose changes make the runner prepare the dependencies again. */
const MANIFESTS: Record<KnownStack | 'other', string[]> = {
  python: ['pyproject.toml', 'uv.lock'],
  typescript: ['package.json', 'bun.lock', 'package-lock.json'],
  other: [],
};

const GITIGNORE: Record<KnownStack | 'other', string> = {
  python: '.venv/\n__pycache__/\n*.pyc\n.pytest_cache/\n.ruff_cache/\n.mypy_cache/\ndist/\nbuild/\n*.egg-info/\n',
  typescript: 'node_modules/\ndist/\nbuild/\ncoverage/\n*.tsbuildinfo\n*.log\n',
  other: '',
};

/**
 * Every file of the seed commit. .agflow/config.json runs scripts/install.sh to prepare dependencies, and names the
 * check (the merge lane's reader takes "check").
 */
export function seedFiles(input: { name: string; stack: string | null; specs: readonly SpecFile[] }): SeedFile[] {
  const kind = known(input.stack) ?? 'other';
  const scripts = SCRIPTS[kind];
  const config = {
    dependencies: [{ run: ['bash', 'scripts/install.sh'], when: ['scripts/install.sh', ...MANIFESTS[kind]] }],
    check: 'bash scripts/check.sh',
  };
  return [
    { path: 'SPEC.md', content: specMarkdown(input.specs) },
    ...input.specs.map((spec) => ({ path: `docs/spec/${spec.name}`, content: spec.bytes })),
    { path: 'AGENTS.md', content: agentsMd(input.name, input.stack) },
    { path: 'CLAUDE.md', content: '@AGENTS.md\n' },
    { path: '.agflow/config.json', content: `${JSON.stringify(config, null, 2)}\n` },
    { path: 'scripts/install.sh', content: HEADER + scripts.install, executable: true },
    { path: 'scripts/check.sh', content: HEADER + scripts.check, executable: true },
    { path: 'scripts/demo.sh', content: HEADER + scripts.demo, executable: true },
    { path: '.gitignore', content: `${GITIGNORE[kind]}.env\n.DS_Store\n` },
  ];
}
