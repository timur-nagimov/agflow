import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { claudeProjectDir } from '../../../src/adapters/claude/paths';
import {
  CLAUDE_PUSH_DENY_RULES,
  CLAUDE_RUNNER_READ_PARTS,
  type ClaudeRulesInput,
  claudePermissionRules,
  claudeSandboxSettings,
} from '../../../src/adapters/claude/rules';
import { runnerPaths } from '../../../src/paths';
import { standardProfile } from '../../../src/profile';

// Paths that exist nowhere, so the rules come only from what the input says.
const HOME = '/Users/owner';
const AGFLOW_HOME = '/Users/owner/.agflow';
const paths = runnerPaths(AGFLOW_HOME);
const CLONE = join(paths.work, 'p-1234567890', 'T-1-a1');
const TMP = '/tmp/agf/abc123';

function input(overrides: Partial<ClaudeRulesInput> = {}): ClaudeRulesInput {
  return {
    home: HOME,
    paths,
    vendorHomes: { claude: paths.homes.claude, codex: paths.homes.codex },
    profile: standardProfile,
    clone: CLONE,
    tmpDir: TMP,
    ...overrides,
  };
}

const reads = (rules: string[]) => rules.filter((rule) => rule.startsWith('Read('));
const edits = (rules: string[]) => rules.filter((rule) => rule.startsWith('Edit('));

describe('Claude permission rules', () => {
  test('denied reads become Read(//<abs>) for files and Read(//<abs>/**) for trees', () => {
    const { deny } = claudePermissionRules(input());
    expect(reads(deny)).toEqual([
      'Read(//Users/owner/.ssh/**)',
      'Read(//Users/owner/.netrc)',
      'Read(//Users/owner/.git-credentials)',
      'Read(//Users/owner/.config/gh/**)',
      'Read(//Users/owner/.config/glab-cli/**)',
      'Read(//Users/owner/.config/agflow/**)',
      ...CLAUDE_RUNNER_READ_PARTS.map((part) => `Read(//Users/owner/.agflow/runner/${part})`),
      'Read(//Users/owner/.claude/**)',
      'Read(//Users/owner/.claude.json)',
      'Read(//Users/owner/.codex/**)',
      'Read(//Users/owner/Library/Keychains/**)',
      'Read(//Users/owner/.aws/**)',
      'Read(//Users/owner/.config/gcloud/**)',
      'Read(//Users/owner/.kube/**)',
      'Read(//Users/owner/.docker/config.json)',
    ]);
  });

  test('of ~/.agflow/runner only the sensitive parts are named, never the tree or the projects directory', () => {
    expect([...CLAUDE_RUNNER_READ_PARTS]).toEqual([
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
    const runnerReads = reads(claudePermissionRules(input()).deny).filter((rule) =>
      rule.startsWith('Read(//Users/owner/.agflow/runner'),
    );
    expect(runnerReads).toEqual(CLAUDE_RUNNER_READ_PARTS.map((part) => `Read(//Users/owner/.agflow/runner/${part})`));
    expect(runnerReads).not.toContain('Read(//Users/owner/.agflow/runner/**)');
    expect(runnerReads.some((rule) => rule.includes('/projects'))).toBe(false);
  });

  test('a Claude home outside the runner tree gets the same three parts, and a Codex home there is named whole', () => {
    const { deny } = claudePermissionRules(
      input({ vendorHomes: { claude: '/Users/owner/agents/claude', codex: '/Users/owner/agents/codex' } }),
    );
    expect(reads(deny)).toContain('Read(//Users/owner/agents/claude/.claude.json)');
    expect(reads(deny)).toContain('Read(//Users/owner/agents/claude/backups/**)');
    expect(reads(deny)).toContain('Read(//Users/owner/agents/claude/shell-snapshots/**)');
    expect(reads(deny)).not.toContain('Read(//Users/owner/agents/claude/**)');
    expect(reads(deny)).toContain('Read(//Users/owner/agents/codex/**)');
  });

  test('denied writes become Edit(//<abs>) and Edit(//<abs>/**), which also cover Write and NotebookEdit', () => {
    const { deny } = claudePermissionRules(input());
    expect(edits(deny)).toEqual([
      'Edit(//Users/owner/.agflow/runner/**)',
      'Edit(//Users/owner/.agflow/vaults/**)',
      'Edit(//Users/owner/.claude/**)',
      'Edit(//Users/owner/.claude.json)',
      'Edit(//Users/owner/.codex/**)',
      'Edit(//Users/owner/.config/agflow/**)',
      'Edit(//Users/owner/Library/LaunchAgents/**)',
      'Edit(//Users/owner/.zshrc)',
      'Edit(//Users/owner/.zprofile)',
      'Edit(//Users/owner/.zshenv)',
      'Edit(//Users/owner/.bashrc)',
      'Edit(//Users/owner/.bash_profile)',
      'Edit(//Users/owner/.profile)',
      'Edit(//Users/owner/.gitconfig)',
    ]);
    expect(deny.some((rule) => rule.startsWith('Write(') || rule.startsWith('NotebookEdit('))).toBe(false);
  });

  test('allow holds mcp__agflow and the tmpDir; WebFetch and WebSearch are allowed only with webTools', () => {
    const tmpRules = ['Read(//tmp/agf/abc123/**)', 'Edit(//tmp/agf/abc123/**)'];
    expect(claudePermissionRules(input()).allow).toEqual(['mcp__agflow', ...tmpRules]);
    const web = { ...standardProfile, webTools: true };
    expect(claudePermissionRules(input({ profile: web })).allow).toEqual([
      'mcp__agflow',
      'WebFetch',
      'WebSearch',
      ...tmpRules,
    ]);
  });

  test('Bash deny rules for git push, git credential, gh, glab and security are present', () => {
    const { deny } = claudePermissionRules(input());
    expect([...CLAUDE_PUSH_DENY_RULES]).toEqual([
      'Bash(git push:*)',
      'Bash(git credential:*)',
      'Bash(gh:*)',
      'Bash(glab:*)',
      'Bash(security:*)',
    ]);
    for (const rule of CLAUDE_PUSH_DENY_RULES) expect(deny).toContain(rule);
  });

  test('no deny rule names the work root, the clone or the tmpDir', () => {
    const { deny } = claudePermissionRules(input());
    for (const rule of deny) {
      expect(rule).not.toContain(paths.work);
      expect(rule).not.toContain(CLONE);
      expect(rule).not.toContain(TMP);
      expect(rule).not.toContain('/tmp/');
    }
  });

  test('a denial that would cover the temporary directory, or a path Claude reads as a pattern, is refused', () => {
    expect(() => claudePermissionRules(input({ tmpDir: join(paths.runner, 'tmp', 'x') }))).toThrow(
      /would cover the attempt's/,
    );
    expect(() => claudePermissionRules(input({ home: '/Users/o(wner)' }))).toThrow(/reads as a pattern/);
    expect(() => claudeSandboxSettings(input({ home: '/Users/o*' }))).toThrow(/reads as a pattern/);
    expect(() => claudePermissionRules(input({ home: 'Users/owner' }))).toThrow(/absolute/);
  });
});

describe('Claude sandbox settings', () => {
  test('they are enabled, fail if unavailable, never run commands unsandboxed, and allow only the profile hosts', () => {
    const sandbox = claudeSandboxSettings(input());
    expect(sandbox.enabled).toBe(true);
    expect(sandbox.failIfUnavailable).toBe(true);
    expect(sandbox.allowUnsandboxedCommands).toBe(false);
    expect(sandbox.network).toEqual({
      allowedDomains: [...standardProfile.network.allowedDomains],
      strictAllowlist: true,
    });
    const custom = { ...standardProfile, network: { allowedDomains: ['example.org'] } };
    expect(claudeSandboxSettings(input({ profile: custom })).network?.allowedDomains).toEqual(['example.org']);
  });

  test('denyRead holds work/*/* and the whole runner tree; allowRead the clone and its project directory', () => {
    const { filesystem } = claudeSandboxSettings(input());
    expect(filesystem?.denyRead).toEqual([
      '/Users/owner/.ssh',
      '/Users/owner/.netrc',
      '/Users/owner/.git-credentials',
      '/Users/owner/.config/gh',
      '/Users/owner/.config/glab-cli',
      '/Users/owner/.config/agflow',
      paths.runner,
      '/Users/owner/.claude',
      '/Users/owner/.claude.json',
      '/Users/owner/.codex',
      '/Users/owner/Library/Keychains',
      '/Users/owner/.aws',
      '/Users/owner/.config/gcloud',
      '/Users/owner/.kube',
      '/Users/owner/.docker/config.json',
      join(paths.work, '*', '*'),
    ]);
    expect(filesystem?.allowRead).toEqual([CLONE, claudeProjectDir(paths.homes.claude, CLONE)]);
    expect(filesystem?.allowRead?.[1]?.startsWith(join(paths.homes.claude, 'projects', '-'))).toBe(true);
    expect(filesystem?.allowWrite).toEqual([TMP]);
    expect(filesystem?.denyWrite).toEqual(['/tmp/claude', '/private/tmp/claude', '/Users/owner/.npm/_logs']);
  });

  test('only the generated work glob is allowed: caller-supplied pattern characters still fail closed', () => {
    expect(claudeSandboxSettings(input()).filesystem?.denyRead).not.toContain(paths.work);
    for (const work of ['/srv/work*', '/srv/work[1]', '/srv/work{a,b}', '/srv/work?']) {
      expect(() => claudeSandboxSettings(input({ paths: { ...paths, work } }))).toThrow(/reads as a pattern/);
    }
  });

  test("paths come from the given home and AGFLOW_HOME, never from the process's own HOME", () => {
    const other = runnerPaths('/srv/agflow-home');
    const given = input({
      home: '/home/someone',
      paths: other,
      vendorHomes: { claude: other.homes.claude, codex: other.homes.codex },
      clone: join(other.work, 'p', 'T-1-a1'),
    });
    const ownHome = process.env.HOME ?? '/nonexistent-home';
    const texts = JSON.stringify([claudePermissionRules(given), claudeSandboxSettings(given)]);
    expect(texts).not.toContain(ownHome);
    expect(texts).toContain('/home/someone/.ssh');
    expect(texts).toContain('/srv/agflow-home/runner/logs/**');
    expect(claudeSandboxSettings(given).filesystem?.denyWrite).toContain('/home/someone/.npm/_logs');
  });
});
