// Approval display and answers (design 6.10, 9.3). No policy decisions or request identity live here.
import { z } from 'zod';
import type { AgentEvent } from '../types';
import type { CodexServerRequestMethod, ResultOf } from './methods';
import type { RequestPermissionProfile, ThreadItem } from './protocol/v2';

type Approval = Pick<Extract<AgentEvent, { type: 'approval_request' }>, 'kind' | 'summary' | 'detail'>;
export type ParsedApproval = Approval & {
  threadId: string;
  turnId: string;
  itemId: string;
  permissions?: RequestPermissionProfile;
};
export type FileChange = Extract<ThreadItem, { type: 'fileChange' }>;

/** The relayed event must stay far below the outbox's event limit, whatever the agent asks to run or write. */
const TEXT_MAX = 64 * 1024;
const SUMMARY_MAX = 500;

/** At most max UTF-8 bytes, cut on a character boundary, with the full size noted. */
export function clipText(text: string, max = TEXT_MAX): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= max) return text;
  let end = max;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return `${bytes.subarray(0, end).toString('utf8')}\n[truncated: ${bytes.length} bytes in total]`;
}

/** The owner's notification shows the summary: its first line, clipped, with an ellipsis when anything was cut. */
function summaryOf(text: string): string {
  const newline = text.indexOf('\n');
  const line = newline === -1 ? text : text.slice(0, newline);
  if (newline === -1 && line.length <= SUMMARY_MAX) return text;
  let end = Math.min(line.length, SUMMARY_MAX);
  // Keep a surrogate pair whole.
  if (end < line.length && /[\uD800-\uDBFF]/.test(line[end - 1]!)) end--;
  return `${line.slice(0, end)}…`;
}

/** Every path a change touches, so a move out of the clone shows its destination. */
function changeView(change: FileChange['changes'][number]): string {
  const { kind, path } = change;
  const head =
    kind.type === 'update' && kind.move_path !== null ? `move ${path} -> ${kind.move_path}` : `${kind.type} ${path}`;
  return `${head}\n${change.diff}`;
}

const identity = { threadId: z.string().min(1), turnId: z.string().min(1), itemId: z.string().min(1) };
const optionalText = z.string().nullish();
const commandParams = z.object({
  ...identity,
  kind: z.enum(['command', 'writeStdin']).default('command'),
  startedAtMs: z.number(),
  environmentId: z.string().nullable(),
  command: optionalText,
  cwd: optionalText,
  reason: optionalText,
});
const fileParams = z.object({ ...identity, startedAtMs: z.number(), reason: optionalText, grantRoot: optionalText });
const specialPath = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('root') }),
  z.strictObject({ kind: z.literal('minimal') }),
  z.strictObject({ kind: z.literal('project_roots'), subpath: z.string().nullable() }),
  z.strictObject({ kind: z.literal('tmpdir') }),
  z.strictObject({ kind: z.literal('slash_tmp') }),
  z.strictObject({ kind: z.literal('unknown'), path: z.string(), subpath: z.string().nullable() }),
]);
const fileSystemPath = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('path'), path: z.string() }),
  z.strictObject({ type: z.literal('glob_pattern'), pattern: z.string() }),
  z.strictObject({ type: z.literal('special'), value: specialPath }),
]);
// Unknown permission fields must fail closed, rather than disappear from the profile the owner sees and grants.
const permissionProfile = z.strictObject({
  network: z.strictObject({ enabled: z.boolean().nullable() }).nullable(),
  fileSystem: z
    .strictObject({
      read: z.array(z.string()).nullable(),
      write: z.array(z.string()).nullable(),
      globScanMaxDepth: z.number().int().nonnegative().optional(),
      entries: z.array(z.strictObject({ path: fileSystemPath, access: z.enum(['read', 'write', 'deny']) })).optional(),
    })
    .nullable(),
});
const permissionsParams = z.object({
  ...identity,
  startedAtMs: z.number(),
  environmentId: z.string().nullable(),
  cwd: z.string(),
  reason: z.string().nullable(),
  permissions: permissionProfile,
});
const userInputParams = z.object({
  ...identity,
  isBlocking: z.boolean(),
  autoResolutionMs: z.number().nullable(),
  questions: z.array(
    z.object({
      id: z.string(),
      header: z.string(),
      question: z.string(),
      isOther: z.boolean(),
      isSecret: z.boolean(),
      options: z.array(z.object({ label: z.string(), description: z.string() })).nullable(),
    }),
  ),
});
const elicitationParams = z
  .object({
    threadId: z.string().min(1),
    turnId: z.string().nullable(),
    serverName: z.string(),
    message: z.string(),
    mode: z.enum(['form', 'openai/form', 'openaiForm', 'url']),
  })
  .and(
    z.union([
      z.object({ mode: z.enum(['form', 'openai/form', 'openaiForm']), requestedSchema: z.json() }),
      z.object({ mode: z.literal('url'), url: z.string(), elicitationId: z.string() }),
    ]),
  );

export function approvalFromRequest(
  method: CodexServerRequestMethod,
  params: unknown,
  item?: FileChange,
): ParsedApproval | null {
  switch (method) {
    case 'item/commandExecution/requestApproval': {
      const parsed = commandParams.safeParse(params);
      if (!parsed.success) return null;
      const p = parsed.data;
      // For writeStdin, command holds the input bytes, not a shell command.
      const label = p.kind === 'writeStdin' ? 'Stdin input to running command' : 'Run command';
      const display = p.command == null ? label : `${label}: ${p.command}`;
      return {
        threadId: p.threadId,
        turnId: p.turnId,
        itemId: p.itemId,
        kind: 'command',
        summary: summaryOf(display),
        detail: {
          ...(p.command == null ? {} : { command: clipText(p.kind === 'writeStdin' ? display : p.command) }),
          ...(p.cwd == null ? {} : { cwd: clipText(p.cwd) }),
          ...(p.reason == null ? {} : { reason: clipText(p.reason) }),
        },
      };
    }
    case 'item/fileChange/requestApproval': {
      const parsed = fileParams.safeParse(params);
      if (!parsed.success) return null;
      const p = parsed.data;
      const known = item?.id === p.itemId;
      // The owner must never approve an empty view.
      const reason = [p.reason, known ? null : 'the changed files are unknown: no file-change item was seen']
        .filter((line) => line != null)
        .join('\n');
      return {
        threadId: p.threadId,
        turnId: p.turnId,
        itemId: p.itemId,
        kind: 'file_change',
        summary: 'Apply file changes',
        detail: {
          ...(known ? { diff: clipText(item.changes.map(changeView).join('\n')) } : {}),
          ...(reason === '' ? {} : { reason: clipText(reason) }),
          ...(p.grantRoot == null ? {} : { grantRoot: clipText(p.grantRoot) }),
        },
      };
    }
    case 'item/permissions/requestApproval': {
      const parsed = permissionsParams.safeParse(params);
      if (!parsed.success) return null;
      const p = parsed.data;
      const requested = `Permissions: ${JSON.stringify(p.permissions)}`;
      return {
        threadId: p.threadId,
        turnId: p.turnId,
        itemId: p.itemId,
        kind: 'other',
        summary: 'Request permissions for this turn',
        detail: { cwd: clipText(p.cwd), reason: clipText(p.reason === null ? requested : `${p.reason}\n${requested}`) },
        permissions: p.permissions,
      };
    }
    default:
      return null;
  }
}

export function decisionResponse<M extends CodexServerRequestMethod>(
  method: M,
  decision: 'approve' | 'decline',
  permissions?: RequestPermissionProfile,
): ResultOf<M> {
  let response: ResultOf<CodexServerRequestMethod>;
  switch (method) {
    case 'item/permissions/requestApproval':
      response = {
        permissions:
          decision === 'approve'
            ? {
                ...(permissions?.network == null ? {} : { network: permissions.network }),
                ...(permissions?.fileSystem == null ? {} : { fileSystem: permissions.fileSystem }),
              }
            : {},
        scope: 'turn',
      };
      break;
    case 'mcpServer/elicitation/request':
      response = { action: 'decline', content: null, _meta: null };
      break;
    case 'item/tool/requestUserInput':
      response = { answers: {} };
      break;
    default:
      response = { decision: decision === 'approve' ? 'accept' : 'decline' };
  }
  return response as ResultOf<M>;
}

/** These requests never go to the owner. Null means malformed, so the caller warns and uses the decline shape. */
export function unattendedResponse<M extends 'item/tool/requestUserInput' | 'mcpServer/elicitation/request'>(
  method: M,
  params: unknown,
): ResultOf<M> | null {
  if (method === 'mcpServer/elicitation/request') {
    return elicitationParams.safeParse(params).success ? decisionResponse(method, 'decline') : null;
  }
  const parsed = userInputParams.safeParse(params);
  if (!parsed.success) return null;
  // The generated response allows free text for every question, even when the prompt offers fixed options.
  return {
    answers: Object.fromEntries(
      parsed.data.questions.map((question) => [
        question.id,
        { answers: ['no person is available; decide yourself or use declare_blocked'] },
      ]),
    ),
  } as ResultOf<M>;
}
