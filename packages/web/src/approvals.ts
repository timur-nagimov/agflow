// What the Approvals page says about each request (design 6.10, 9.3, 11): its kind, its warnings, hidden characters
// made visible, the time before the hub declines it, its diff as lines for DiffView, the order and where it comes
// from. Free of the DOM so the rules are unit-tested.
import type { Approval, DiffLine, Runner } from '@agflow/core';
import { duration } from './format';

export const APPROVAL_KIND_LABELS: Record<Approval['kind'], string> = {
  command: 'Command',
  file_change: 'File change',
  other: 'Other request',
};

/** Design 6.10's words: a Codex command that asks runs outside the sandbox once approved. */
export const OUTSIDE_SANDBOX_WARNING =
  'Approving runs this command outside the sandbox, with network access and write access to all your files';

/** A file change with a grantRoot asks for the whole root, not just the change shown (6.10). */
export const GRANT_ROOT_WARNING = 'Approving may let the agent write anywhere under this root for the rest of the session';

/** Set when the agent's text holds characters a browser does not show as they are (see HIDDEN). */
export const HIDDEN_TEXT_WARNING =
  'This request contains invisible or direction-changing characters, so what you see may not be what runs; ' +
  'decline it unless you know why they are there';

/**
 * Characters that change what text looks like without showing themselves: bidi controls (U+061C, U+200E-200F,
 * U+202A-202E, U+2066-2069), invisible format characters (U+00AD, U+034F, U+115F-1160, U+180E, U+200B-200D,
 * U+2060-2064, U+206A-206F, U+3164, U+FEFF, U+FFA0), the line and paragraph separators U+0085, U+2028 and U+2029, and
 * tag characters (U+E0000-E007F). An agent steered by a repository file could use them to make a command read as
 * something else (Trojan Source, CVE-2021-42574), and approving lifts the sandbox.
 */
const HIDDEN =
  /[\u0085\u00AD\u034F\u061C\u115F\u1160\u180E\u200B-\u200F\u2028-\u202E\u2060-\u2064\u2066-\u206F\u3164\uFEFF\uFFA0\u{E0000}-\u{E007F}]/u;
const HIDDEN_ALL = new RegExp(HIDDEN.source, 'gu');

/** Each hidden character as a visible marker such as ⟨U+202E⟩, for showing the command, its cwd and diffs. */
export function revealHidden(text: string): string {
  return text.replace(HIDDEN_ALL, (char) => {
    const code = (char.codePointAt(0) ?? 0).toString(16).toUpperCase();
    return `⟨U+${code.padStart(4, '0')}⟩`;
  });
}

/** The text an approver judges the request by: what the agent wrote, and the diffs. */
function agentText(approval: Pick<Approval, 'summary' | 'detail'>): string[] {
  const { command, cwd, reason, grantRoot, diff, manifestDiff } = approval.detail;
  return [approval.summary, command, cwd, reason, grantRoot, diff, manifestDiff].filter(
    (text): text is string => text !== undefined,
  );
}

/**
 * What approving does, one line per warning; the view shows them beside Approve. Hidden characters, then a command
 * of several lines, come first: either means the command shown is not simply the one that runs.
 */
export function approvalWarnings(approval: Pick<Approval, 'kind' | 'summary' | 'detail'>): string[] {
  const warnings: string[] = [];
  if (agentText(approval).some((text) => HIDDEN.test(text))) warnings.push(HIDDEN_TEXT_WARNING);
  // A trailing line break hides nothing, so it does not count.
  const lines = approval.detail.command?.replace(/[\r\n]+$/, '').split(/\r\n|[\n\r]/).length ?? 1;
  if (lines > 1) warnings.push(`The command has ${lines} lines; read them all, since all of them run`);
  switch (approval.kind) {
    case 'command':
      warnings.push(OUTSIDE_SANDBOX_WARNING);
      break;
    case 'file_change':
      warnings.push(
        approval.detail.grantRoot
          ? `${GRANT_ROOT_WARNING}: ${approval.detail.grantRoot}`
          : 'Approving lets the agent write the change shown, outside its sandbox',
      );
      break;
    case 'other':
      // Codex's permission requests: approving grants exactly the requested profile, for that turn only (9.3).
      warnings.push('Approving grants exactly what the agent asks for, for this turn only');
      break;
  }
  return warnings;
}

/** The time before the hub declines the request on the owner's behalf. */
export function timeLeft(approval: Pick<Approval, 'expiresAt'>, now: number): string {
  const left = approval.expiresAt - now;
  if (left <= 0) return 'expired';
  return left < 60_000 ? 'less than a minute left' : `${duration(left)} left`;
}

// "@@ -1,4 +1,5 @@": a missing count means one line.
const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;

/**
 * A unified diff (the manifest diff of 6.10, or a file change's diff) as lines for DiffView. Inside a hunk its
 * header's line counts say where it ends, so a removed line that starts with "--" is not read as the next file's
 * header. File headers and hunk lines show as context, and "\ No newline at end of file" is left out.
 */
export function parseUnifiedDiff(diff: string): DiffLine[] {
  if (diff === '') return [];
  const lines: DiffLine[] = [];
  let oldLeft = 0;
  let newLeft = 0;
  for (const raw of diff.replace(/\r?\n$/, '').split(/\r?\n/)) {
    if (raw.startsWith('\\')) continue;
    if (oldLeft > 0 || newLeft > 0) {
      const op = raw[0];
      if (op === '-') {
        oldLeft -= 1;
        lines.push({ op: '-', text: raw.slice(1) });
      } else if (op === '+') {
        newLeft -= 1;
        lines.push({ op: '+', text: raw.slice(1) });
      } else {
        // Some tools drop the space of an empty context line.
        oldLeft -= 1;
        newLeft -= 1;
        lines.push({ op: ' ', text: raw.slice(1) });
      }
      continue;
    }
    const hunk = raw.match(HUNK_HEADER);
    if (hunk) {
      oldLeft = Number(hunk[1] ?? 1);
      newLeft = Number(hunk[2] ?? 1);
    }
    lines.push({ op: ' ', text: raw });
  }
  return lines;
}

/** The soonest expiry first, so nothing runs out unseen; then the oldest request. */
export function sortApprovals(approvals: Approval[]): Approval[] {
  return [...approvals].sort((a, b) => a.expiresAt - b.expiresAt || a.createdAt - b.createdAt);
}

/** Where a request comes from: "A-9 on T-8 · R-1, demo's MacBook Pro"; a lead's names no task. */
export function approvalPlace(
  approval: Pick<Approval, 'agentId' | 'taskId' | 'runnerId'>,
  runners: Pick<Runner, 'id' | 'name'>[],
): string {
  const agent = approval.taskId ? `${approval.agentId} on ${approval.taskId}` : `${approval.agentId}, the lead`;
  const runner = runners.find((candidate) => candidate.id === approval.runnerId);
  return `${agent} · ${approval.runnerId}${runner ? `, ${runner.name}` : ''}`;
}
