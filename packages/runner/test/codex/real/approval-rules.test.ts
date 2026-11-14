// The hub's approval rules against the real pinned app-server (design 6.10, Rules; section 5, Approvals decided by
// rule): what Codex actually sends when it asks to leave its sandbox, judged by the rules the hub answers with, and the
// answer given back to Codex as the hub gives it. The model is the scripted provider, so no model is used; the binary,
// its sandbox, its approval flow and the device's managed configuration are real. Run with AGFLOW_SMOKE=1 (root script
// smoke:codex).
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import type { Approval } from '@agflow/core';
import { reply, type ResponsesRequest } from '@agflow/testkit/src/codex/index';
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { judgeApproval } from '../../../../hub/src/approval-policy';
import type { ScriptedReply } from '@agflow/testkit/src/codex/replies';
import { until } from '../session-fixture';
import { type CodexHarness, EventLog, type HarnessAttempt, smokeCodexBinary, startCodexHarness } from './harness';

setDefaultTimeout(120_000);

const bin = await smokeCodexBinary();
let h: CodexHarness | null = null;
const cleanups: (() => void)[] = [];
afterEach(async () => {
  try {
    // Every external connection would have met the refusing proxy: none was even tried.
    expect(h?.proxy.refused ?? []).toEqual([]);
  } finally {
    await h?.close();
    h = null;
    for (const cleanup of cleanups.splice(0)) cleanup();
  }
});

/** The rules' verdict on a request as the hub judges it, with the clone the runner's pump sends as cloneRoot. */
const judge = (asked: { kind: Approval['kind']; summary: string; detail: Approval['detail'] }, clone: string) =>
  judgeApproval({ kind: asked.kind, summary: asked.summary, detail: { ...asked.detail, cloneRoot: clone } }, {
    cloneRoot: clone,
  });

/**
 * Runs one turn in which the scripted model makes a single request outside the sandbox, the hub's rules judge it, and
 * the rules' answer goes back to Codex. A decline carries the rule's reason, which the runner steers into the turn as
 * the asking agent's next message; the scripted model then stops. Returns the request, the verdict and the events.
 */
async function answeredByRule(a: HarnessAttempt, first: ScriptedReply) {
  let steer: string | null = null;
  h!.provider.setHandler((request: ResponsesRequest) => {
    if (steer !== null && (request.lastUserText ?? '').includes(steer)) return reply.text('Understood.');
    if (request.toolOutputsSinceUser === 0) return first;
    if (steer === null) return reply.text('Done.');
    // Held until the steered reason is in, so the turn samples again after it.
    return reply.hang(reply.shell({ cmd: 'true' }));
  });
  const session = await a.start();
  const log = new EventLog(session.events);
  const asked = await log.next('approval_request');
  const judged = judge(asked, a.clone);
  if (judged.verdict === 'decline') {
    steer = judged.reason;
    expect(await session.answerApproval(asked.approvalId, 'decline', judged.reason)).toBe(true);
    expect(await log.next('tool_ended')).toMatchObject({ ok: false, denied: true });
    // The rule's reason reaches the asking agent: it is what the model is sent next.
    await until(() => {
      h!.provider.release();
      return h!.provider.requests.some((request) => (request.lastUserText ?? '').includes(steer as string));
    }, 30_000);
  } else if (judged.verdict === 'approve') {
    expect(await session.answerApproval(asked.approvalId, 'approve', null)).toBe(true);
  }
  expect(await log.next('turn_ended')).toMatchObject({ outcome: 'completed' });
  return { asked, judged, log };
}

const escalated = (cmd: string) => reply.shell({ cmd, escalate: { justification: 'The step needs it, trust me.' } });

describe.skipIf(bin === null)('the hub rules judge what the real app-server asks', () => {
  test('Codex wraps the command in a shell, and the rules judge what is inside it', async () => {
    h = await startCodexHarness(bin!);
    const a = await h.attempt();
    const { asked, judged } = await answeredByRule(a, escalated('npm ci'));
    // The shape the rules were built for, seen from the binary rather than assumed.
    expect(asked.kind).toBe('command');
    expect(asked.detail.command).toMatch(/^\S*sh -l?c /);
    expect(asked.detail.command).toContain('npm ci');
    expect(asked.detail.cwd).toBe(a.clone);
    expect(judged).toMatchObject({ verdict: 'approve', rule: 'declared-deps' });
  });

  test('an approved command really runs outside the sandbox', async () => {
    h = await startCodexHarness(bin!);
    const a = await h.attempt();
    const marker = join(a.clone, 'approved-by-rule');
    const { judged, log } = await answeredByRule(a, escalated(`touch ${marker}`));
    expect(judged).toMatchObject({ verdict: 'approve', rule: 'dev-tool' });
    expect(log.of('tool_ended')).toEqual([expect.objectContaining({ ok: true, denied: false })]);
    expect(existsSync(marker)).toBe(true);
  });

  test('a request for a credential is declined, and nothing runs', async () => {
    h = await startCodexHarness(bin!);
    const a = await h.attempt();
    const stolen = join(a.clone, 'stolen');
    const { asked, judged } = await answeredByRule(a, escalated(`cat ${homedir()}/.ssh/id_ed25519 > ${stolen}`));
    expect(judged).toMatchObject({ verdict: 'decline', rule: 'secret-path' });
    // Whatever the request says about itself.
    expect(asked.detail.reason).toContain('trust me');
    expect(existsSync(stolen)).toBe(false);
  });

  test('a write to the home directory is declined, and the file is never written', async () => {
    h = await startCodexHarness(bin!);
    const a = await h.attempt();
    // Outside the clone and outside every temporary directory: the rules let a command write scratch output only there.
    const outside = join(homedir(), `.agflow-rules-check-${randomUUID()}`);
    cleanups.push(() => rmSync(outside, { force: true }));
    const { judged } = await answeredByRule(a, escalated(`touch ${outside}`));
    expect(judged).toMatchObject({ verdict: 'decline', rule: 'outside-clone' });
    expect(existsSync(outside)).toBe(false);
  });

  test('a patch that leaves the clone is declined, and the file is never written', async () => {
    h = await startCodexHarness(bin!);
    const a = await h.attempt();
    const outside = join(homedir(), `.agflow-rules-check-${randomUUID()}.txt`);
    cleanups.push(() => rmSync(outside, { force: true }));
    const patch = ['*** Begin Patch', `*** Add File: ${outside}`, '+written from the clone', '*** End Patch'].join(
      '\n',
    );
    const { asked, judged } = await answeredByRule(a, reply.patch(patch));
    expect(asked.kind).toBe('file_change');
    expect(judged).toMatchObject({ verdict: 'decline', rule: 'outside-clone' });
    expect(existsSync(outside)).toBe(false);
  });
});
