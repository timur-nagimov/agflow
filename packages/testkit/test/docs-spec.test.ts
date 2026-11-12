import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { canTransition } from '../../core/src/task-state';

const SPEC_DIR = resolve(import.meta.dir, '../../../docs/superpowers/specs');
const M2_FILE = '2026-10-28-m2-runners-design.md';
const spec = readFileSync(resolve(SPEC_DIR, '2026-10-26-agflow-design.md'), 'utf8');
const m2 = readFileSync(resolve(SPEC_DIR, M2_FILE), 'utf8');

function section(number: string): string {
  const heading = number.includes('.') ? `### ${number} ` : `## ${number}. `;
  expect(spec, `spec needs §${number}`).toContain(heading);
  return spec.split(heading)[1]!.split(/\n#{1,3} /)[0]!;
}

function tableRows(markdown: string): string[][] {
  return markdown.split('\n').filter((line) => line.startsWith('|'))
    .map((line) => line.slice(1, -1).split('|').map((cell) => cell.trim()));
}

function withoutFences(markdown: string): string {
  return markdown.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\s*$/gm, '');
}

function linkTargets(markdown: string): string[] {
  const prose = withoutFences(markdown);
  return [
    ...[...prose.matchAll(/\[[^\]\n]*\]\(<?([^\s)>]+)>?(?:\s+"[^"]*")?\)/g)].map((match) => match[1]!),
    ...[...prose.matchAll(/^\s*\[[^\]]+\]:\s*<?([^\s>]+)>?/gm)].map((match) => match[1]!),
  ];
}

// The design uses ATX headings with plain text and inline code. GitHub removes
// punctuation, lowercases, replaces spaces with hyphens, and suffixes duplicates.
function headingAnchors(markdown: string): Set<string> {
  const anchors = new Set<string>();
  for (const match of withoutFences(markdown).matchAll(/^#{1,6}\s+(.+?)(?:\s+#+)?\s*$/gm)) {
    const base = match[1]!.toLowerCase().replace(/[^\p{L}\p{M}\p{N}_\- ]/gu, '').replace(/ /g, '-');
    let anchor = base;
    for (let suffix = 1; anchors.has(anchor); suffix++) anchor = `${base}-${suffix}`;
    anchors.add(anchor);
  }
  return anchors;
}

describe('spec M2 domain and runner contracts', () => {
  test('M2 §5 retains only the mitigated shell snapshot risk', () => {
    const security = m2.split('## 5. ')[1]!.split('## 6. ')[0]!;
    expect(security).toContain('ZDOTDIR=<claudeHome>/agflow-empty');
    expect(security).toContain('CLAUDE_CODE_SHELL=/bin/zsh');
    expect(security).toMatch(/snapshot[^\n]*~\/\.zshrc[^\n]*once per (?:Claude )?process/);
    expect(security).not.toContain('`~/.zshrc` or `~/.bashrc`');
  });

  test('M2 §6 records pending hand-backs and distinguishes fallback events', () => {
    const domain = m2.split('### 6.1 ')[1]!.split('### 6.2 ')[0]!;
    expect(domain).toContain('handingBack: { by: string; at: number } | null');
    const handback = m2.split('### 6.12 ')[1]!.split('### 6.13 ')[0]!;
    for (const term of ['Attempt.takeover.handingBack', 'user:<login>', 'epoch milliseconds',
      '409 handback_pending', 'Completion, refusal or timeout clears', 'no link',
      'task.ready', '{ from, attemptId, reason }', 'task.handed_back']) {
      expect(handback).toContain(term);
    }
  });

  test.each([
    ['rejected', 'blocked'],
    ['ready', 'failed'],
    ['blocked', 'failed'],
  ] as const)('§5.3 documents %s → %s, allowed by core', (from, to) => {
    expect(section('5.3').replace(/`/g, ''), `§5.3 must name ${from} → ${to}`).toContain(`${from} → ${to}`);
    expect(canTransition(from, to)).toBe(true);
  });

  test('§5.4 keeps attempts and runners in the hub and runner files under the clone’s .agflow/run/', () => {
    const storage = section('5.4');
    expect(storage).toMatch(/\| Hub database[^\n]*\battempts\b[^\n]*\brunners\b/);
    expect(storage).toMatch(/\|[^\n]*clone[^\n]*\.agflow\/run\//i);
    expect(storage).not.toMatch(/`\.agflow\/(?:task|brief)\.md`/);
  });

  test('§6.1 uses per-attempt clones, a vault and WIP refs, with checks deferred to M3', () => {
    const runner = section('6.1');
    expect(runner).not.toMatch(/one mirror|worktree per task|linked worktrees/i);
    for (const term of [/per-attempt clones/i, /vault/i, /WIP[^\n]*refs/i, /dependency preparation/i, /checks[^\n]*M3/i]) {
      expect(runner).toMatch(term);
    }
  });

  test('the adapters and profiles remove the obsolete fallback and automatic approval decisions', () => {
    expect(section('6.2')).toContain('Claude Agent SDK');
    expect(section('6.3')).toContain('codex app-server');
    expect(section('6.3')).not.toContain('codex exec');
    const profiles = section('6.9');
    expect(profiles).toMatch(/acceptEdits[^\n]*sandbox/);
    expect(profiles).toMatch(/auto[^\n]*opt-in/);
    expect(profiles).toMatch(/runner[^\n]*never[^\n]*approval/i);
    expect(profiles).not.toMatch(/approvals are answered by an allowlist/i);
  });

  test.each([
    ['5.3', '69-retry-ladder-the-m2-part-of-spec-95'],
    ['5.4', '72-layout'],
    ['6.1', '73-git'],
    ['6.1', '77-dependency-preparation'],
    ['6.2', '8-claude-code-adapter'],
    ['6.3', '9-codex-adapter'],
    ['6.4', '68-stall-detection-continuation-replacement-and-handoff'],
    ['6.6', '67-message-delivery-to-runner-agents'],
    ['6.7', '64-attempts-fencing-and-leases'],
    ['6.7', '68-stall-detection-continuation-replacement-and-handoff'],
    ['6.8', '66-scheduler'],
    ['6.9', '76-agent-environment-and-profile'],
    ['6.10', '610-quota-and-approvals'],
  ])('§%s delegates its contract to M2 #%s', (number, anchor) => {
    expect(linkTargets(section(number))).toContain(`${M2_FILE}#${anchor}`);
  });

  test('every spec link into the M2 design resolves to a GitHub heading anchor', () => {
    const targets = linkTargets(spec).filter((target) => target.split('#')[0]?.endsWith(M2_FILE));
    expect(targets.length, 'the spec must link to the M2 source of truth').toBeGreaterThan(0);
    const anchors = headingAnchors(m2);
    for (const target of targets) {
      const [path, fragment] = target.split('#');
      expect(resolve(SPEC_DIR, path!), target).toBe(resolve(SPEC_DIR, M2_FILE));
      expect(fragment, `${target} needs a heading fragment`).toBeTruthy();
      expect(anchors.has(decodeURIComponent(fragment!)), `${target} has no matching heading`).toBe(true);
    }
  });
});

describe('spec M2 managers, security and milestones', () => {
  test('M2 carries the implemented shell mitigation through verification, environment and snapshot rules', () => {
    for (const number of ['3', '7.6', '8.2', '15', '18']) {
      const heading = number.includes('.') ? `### ${number} ` : `## ${number}. `;
      const text = m2.split(heading)[1]!.split(/\n#{1,3} /)[0]!;
      expect(text, `M2 §${number}`).toContain('~/.zshrc');
      if (number !== '15') {
        expect(text, `M2 §${number}`).toContain('ZDOTDIR');
        expect(text, `M2 §${number}`).toContain('CLAUDE_CODE_SHELL');
      }
    }
    const checks = m2.split('## 15. ')[1]!.split('## 16. ')[0]!;
    expect(checks).toContain("With either zsh or bash as the owner's `SHELL`");
    expect(checks).toContain('their functions and PATH changes do not reach agent commands');
    expect(m2).not.toContain('shell-profile proposal in the review notes remains undecided');
    expect(m2).not.toContain('(or `.bashrc`)');
  });

  test('M2 §18 records the full X-49 contract', () => {
    const changes = m2.split('## 18. ')[1]!;
    for (const term of ['X-49', 'Runner.stateDetail', 'refused a start: <code>', 'next heartbeat',
      'Attempt.stopRequested.by', 'user:<login>', 'agent:<id>', 'system', 'handingBack',
      'epoch milliseconds', '409 handback_pending', 'Completion, refusal or timeout clears',
      'task.ready', '{ from, attemptId, reason }', 'task.handed_back', 'reportHolds', 'utilization']) {
      expect(changes).toContain(term);
    }
  });

  test('§18 assigns every finding its M2 resolution or deferred milestone', () => {
    const [header, , ...rows] = tableRows(section('18'));
    expect(header, '§18 needs a Status column').toContain('Status');
    const statusColumn = header!.indexOf('Status');
    expect(rows.map((row) => Number(row[0]))).toEqual(Array.from({ length: 17 }, (_, i) => i + 1));
    for (const row of rows) {
      const id = Number(row[0]);
      const expected = id === 5 ? 'Resolved in M2 except `rebut_review` (M3)'
        : id === 2 ? 'Resolved in M2 with sandboxed dependency preparation; checks in M3'
        : id === 17 ? 'Open for M4'
        : [8, 9, 10, 13].includes(id) ? 'Open for M3' : 'Resolved in M2';
      expect(row[statusColumn], `finding #${id}`).toBe(expected);
    }
  });

  test('§17 question 3 answers trust with the nested projects.<path>.trust_level override', () => {
    const question = section('17').split(/\n3\. /)[1]!.split(/\n4\. /)[0]!;
    expect(question).toMatch(/answered/i);
    expect(question).toContain('projects.<path>.trust_level');
    expect(question).toMatch(/projects:\s*\{\s*\[realpath\(clone\)\]:\s*\{\s*trust_level:/);
    expect(question).toContain("'trusted'");
    expect(question).toContain("'untrusted'");
    expect(linkTargets(question)).toContain(`${M2_FILE}#92-threads-and-turns`);
  });

  test('§15 layout lists exactly the package directories, once each', () => {
    const layout = section('15').match(/```[^\n]*\n([\s\S]*?)```/)![1]!;
    const listed = [...layout.matchAll(/^packages\/([^\s/]+)/gm)].map((match) => match[1]!).sort();
    const actual = readdirSync(resolve(SPEC_DIR, '../../../packages'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    expect(listed).toEqual(actual);
    expect(layout).toMatch(/packages\/runner[^\n]*clones[^\n]*vault/);
    expect(layout).toMatch(/packages\/testkit[^\n]*scripted model servers/);
  });

  test('§16 M2 scope delegates to the M2 scope section', () => {
    const row = tableRows(section('16')).find((cells) => cells[0]?.includes('M2:'))!;
    expect(linkTargets(row[1]!)).toContain(`${M2_FILE}#2-scope`);
    expect(row[1]).not.toContain('worktrees');
  });

  test('the M2 status names all seven implementing plans', () => {
    const status = m2.match(/^- \*\*Status:\*\* (.+)$/m)![1]!;
    expect(status).toMatch(/implemented/i);
    expect(status.match(/\bM2[a-g]\b/g)).toEqual(['M2a', 'M2b', 'M2c', 'M2d', 'M2e', 'M2f', 'M2g']);
    expect(m2).not.toMatch(/^#{1,6} .*implementation notes/im);
  });

  test.each([
    ['7.1', '611-the-lead-on-runners'],
    ['7.6', '611-the-lead-on-runners'],
    ['7.6', '615-guards'],
    ['11.1', '65-agent-tokens-and-principals'],
    ['11.2', '63-runner-link'],
    ['12', '5-security-model-for-runner-agents'],
    ['12', '65-agent-tokens-and-principals'],
    ['13', '614-restarts-clock-jumps-restores-and-backups'],
    ['13', '63-runner-link'],
    ['14', '15-testing'],
    ['15', '13-packages-and-interfaces'],
  ])('§%s delegates its contract to M2 #%s', (number, anchor) => {
    expect(linkTargets(section(number))).toContain(`${M2_FILE}#${anchor}`);
  });

  test('superseded manager, link, security and failure rules are removed', () => {
    expect(section('7.1')).toContain('lead seat');
    expect(section('7.6')).not.toMatch(/4 re-plans|Hitting any limit/);
    expect(section('11.1')).toMatch(/403[^\n]*agent_not_allowed/);
    expect(section('11.2')).not.toMatch(/command_result|start_agent|run_checks|update_profile/);
    expect(section('12')).not.toMatch(/stored in the OS keychain/);
    expect(section('13')).not.toMatch(/hub unavailable, keep working|Restore from the daily backup/);
    for (const term of [/recovery window/i, /clock jump/i, /epoch/i, /late work/i]) {
      expect(section('13')).toMatch(term);
    }
    expect(section('14')).toMatch(/scripted model servers/i);
    expect(section('14')).toMatch(/tamper[^\n]*M3/i);
  });

  test('settings-sync documents exact answers, hub replay filtering and the remaining lineage limits', () => {
    const sync = m2.split('**Settings sync.**')[1]!.split('**Link behaviour:**')[0]!;
    expect(sync).toContain('settingsAnsweredSeq');
    expect(sync).toContain('answers');
    expect(sync).toContain('outboxEpoch');
    expect(sync).toContain('refused: true');
    expect(sync).toContain('Known limits');
    expect(sync).toContain('same versions');
    expect(sync).not.toContain('oldest unanswered edit');
    expect(section('11.2')).toContain('protocol-2');
    expect(section('11.2')).not.toContain('deferred');
  });

  test('the M2 design records accepted late-work and backup clarifications', () => {
    expect(m2).toContain('AttemptRecord.lateWorkSha');
    expect(m2).toMatch(/cleanup pushes pending late work first, even with the clone gone/);
    expect(m2).toMatch(/daily[^\n]*once per UTC day/);
    expect(m2.split('## 18. ')[1]).toMatch(/submitted.head[^\n]*Known limit/i);
  });

  test('the M2 design records bridge startup isolation and persistent Codex tool discovery', () => {
    const bridge = m2.split('## 10. Bridge and hooks')[1]!.split('## 11.')[0]!;
    for (const flag of ['--no-compile-autoload-bunfig', '--no-compile-autoload-dotenv', '--no-env-file', '--config=/dev/null']) {
      expect(bridge).toContain(flag);
    }
    expect(m2).toMatch(/bridge: \{[^\n]*tools: readonly string\[\]/);
    expect(m2).toMatch(/developerInstructions[^\n]*launch.bridge.tools/);
    expect(m2).toMatch(/cwd: codexUserHome/);
  });

  test('the M2 design distinguishes untrusted project config from skills and MCP startup', () => {
    const threads = m2.split('### 9.2 Threads and turns')[1]!.split('### 9.3')[0]!;
    expect(threads).toMatch(/untrusted[^\n]*still loads[^\n]*\.codex\/skills/);
    expect(threads).toContain('mcpServer/startupStatus/updated');
    expect(threads).toMatch(/trusted[^\n]*MCP servers[^\n]*outside the sandbox[^\n]*before/i);
  });

  test('the M2 design records Claude screening and resume clarifications', () => {
    expect(m2).toContain("preset: 'claude_code'");
    expect(m2).toContain('CLAUDE_BASH_NOTE');
    expect(m2).toMatch(/resumed[^\n]*mismatch[^\n]*attempt.exited/);
    expect(m2).toMatch(/computed Git subcommands/);
    expect(m2).toContain('~/.agflow/work/*/*');
    expect(m2).not.toMatch(/`~\/\.agflow\/work` (?:goes only|, with `allowRead`)/);
  });
});
