import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { canTransition } from '../../core/src/task-state';

const SPEC_DIR = resolve(import.meta.dir, '../../../docs/superpowers/specs');
const M2_FILE = '2026-10-28-m2-runners-design.md';
const spec = readFileSync(resolve(SPEC_DIR, '2026-10-26-agflow-design.md'), 'utf8');
const m2 = readFileSync(resolve(SPEC_DIR, M2_FILE), 'utf8');

function section(number: string): string {
  const heading = `### ${number} `;
  expect(spec, `spec needs §${number}`).toContain(heading);
  return spec.split(heading)[1]!.split(/\n#{1,3} /)[0]!;
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
