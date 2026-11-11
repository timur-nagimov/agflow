// The app-server methods the adapter uses (design 9.1), each checked against the protocol generated from the pin: a
// re-pin that renames or drops one fails the typecheck. The generated code has no method-to-result map, so
// CodexResults pairs every client method and server request with its generated response type.
import type { ClientRequest, InitializeResponse, ServerNotification, ServerRequest } from './protocol';
import type {
  CommandExecutionRequestApprovalResponse,
  ConfigReadResponse,
  ConfigRequirementsReadResponse,
  FileChangeRequestApprovalResponse,
  GetAccountRateLimitsResponse,
  GetAccountResponse,
  ListMcpServerStatusResponse,
  McpServerElicitationRequestResponse,
  PermissionsRequestApprovalResponse,
  SkillsListResponse,
  ThreadCompactStartResponse,
  ThreadDeleteResponse,
  ThreadResumeResponse,
  ThreadSetNameResponse,
  ThreadStartResponse,
  ToolRequestUserInputResponse,
  TurnInterruptResponse,
  TurnStartResponse,
  TurnSteerResponse,
} from './protocol/v2';

/** What the adapter asks app-server: preflight, threads, turns and deletion. */
export const CodexClientMethods = [
  'initialize',
  'account/read',
  'account/rateLimits/read',
  'configRequirements/read',
  'config/read',
  'mcpServerStatus/list',
  'skills/list',
  'thread/start',
  'thread/resume',
  'thread/name/set',
  'thread/compact/start',
  'thread/delete',
  'turn/start',
  'turn/steer',
  'turn/interrupt',
] as const satisfies readonly ClientRequest['method'][];

/** The server requests section 9.3 answers; any other one gets -32601. */
export const CodexServerRequestMethods = [
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'item/tool/requestUserInput',
  'mcpServer/elicitation/request',
] as const satisfies readonly ServerRequest['method'][];

/** The notifications the adapter maps to events, quota and start checks (sections 9.2, 9.3). */
export const CodexNotificationMethods = [
  'error',
  'thread/started',
  'thread/status/changed',
  'thread/tokenUsage/updated',
  'turn/started',
  'turn/completed',
  'item/started',
  'item/completed',
  'serverRequest/resolved',
  'account/rateLimits/updated',
  'warning',
  'configWarning',
  'deprecationNotice',
  'model/rerouted',
] as const satisfies readonly ServerNotification['method'][];

export type CodexClientMethod = (typeof CodexClientMethods)[number];
export type CodexServerRequestMethod = (typeof CodexServerRequestMethods)[number];
export type CodexNotificationMethod = (typeof CodexNotificationMethods)[number];
export type CodexMethod = CodexClientMethod | CodexServerRequestMethod | CodexNotificationMethod;

/** The generated params of a client method, server request or notification. */
export type ParamsOf<M extends CodexMethod> = M extends CodexClientMethod
  ? Extract<ClientRequest, { method: M }>['params']
  : M extends CodexServerRequestMethod
    ? Extract<ServerRequest, { method: M }>['params']
    : Extract<ServerNotification, { method: M }>['params'];

interface CodexResults {
  initialize: InitializeResponse;
  'account/read': GetAccountResponse;
  'account/rateLimits/read': GetAccountRateLimitsResponse;
  'configRequirements/read': ConfigRequirementsReadResponse;
  'config/read': ConfigReadResponse;
  'mcpServerStatus/list': ListMcpServerStatusResponse;
  'skills/list': SkillsListResponse;
  'thread/start': ThreadStartResponse;
  'thread/resume': ThreadResumeResponse;
  'thread/name/set': ThreadSetNameResponse;
  'thread/compact/start': ThreadCompactStartResponse;
  'thread/delete': ThreadDeleteResponse;
  'turn/start': TurnStartResponse;
  'turn/steer': TurnSteerResponse;
  'turn/interrupt': TurnInterruptResponse;
  'item/commandExecution/requestApproval': CommandExecutionRequestApprovalResponse;
  'item/fileChange/requestApproval': FileChangeRequestApprovalResponse;
  'item/permissions/requestApproval': PermissionsRequestApprovalResponse;
  'item/tool/requestUserInput': ToolRequestUserInputResponse;
  'mcpServer/elicitation/request': McpServerElicitationRequestResponse;
}

/** What a client method answers, or what the adapter answers a server request with. */
export type ResultOf<M extends CodexClientMethod | CodexServerRequestMethod> = CodexResults[M];

// Fails to compile when a listed method has no result type, or a result type belongs to no listed method.
type Never<T extends never> = T;
type ResultsCoverTheMethods = Never<
  | Exclude<CodexClientMethod | CodexServerRequestMethod, keyof CodexResults>
  | Exclude<keyof CodexResults, CodexClientMethod | CodexServerRequestMethod>
>;
