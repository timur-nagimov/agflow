// The scripted Responses API provider for Codex tests (design 15.1). Consumers import @agflow/testkit/src/codex/index;
// it is not part of the testkit's main entry.
export { DEFAULT_REPLY_TEXT, type OutputItem, reply, type ScriptedReply, type ShellReplyOptions } from './replies';
export { type ResponsesRequest, type ResponsesToolOutput, type ToolSurface, toolSurface } from './request';
export {
  type ResponsesHandler,
  type ResponsesRule,
  type ResponsesServer,
  rules,
  startResponsesServer,
} from './responses-server';
