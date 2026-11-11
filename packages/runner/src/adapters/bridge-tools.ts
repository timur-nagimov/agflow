// The agflow tools a runner agent's bridge serves (design 10): `agflow mcp --vendor <v> --runner` lists them by the
// role AGFLOW_ROLE names, without the MCP prefix. The runner never imports packages/cli, so the names live here and
// reach the adapters as AgentLaunch.bridge.tools before the agent starts: Codex's Code Mode defers MCP tools, so M2e
// names them in the thread's developerInstructions, which survive compaction (design 9.2). packages/cli's
// runner-tools test checks that runnerToolsFor(role) serves exactly these names, so the two cannot drift.
import type { AgentRole } from '@agflow/core';

export const BRIDGE_TOOL_NAMES: Readonly<Record<AgentRole, readonly string[]>> = Object.freeze({
  worker: Object.freeze([
    'hello',
    'get_brief',
    'get_goal',
    'list_tasks',
    'get_task',
    'check_inbox',
    'ack_messages',
    'send_message',
    'search',
    'report_progress',
    'write_handoff',
    'declare_blocked',
    'declare_impossible',
    'release_task',
    'submit',
    'prepare_dependencies',
  ]),
  lead: Object.freeze([
    'hello',
    'get_brief',
    'get_goal',
    'list_tasks',
    'get_task',
    'check_inbox',
    'ack_messages',
    'send_message',
    'search',
    'get_status',
    'create_tasks',
    'update_task',
    'cancel_task',
    'accept_task',
    'reject_task',
    'unblock_task',
    'mark_merged',
    'add_goal_note',
    'get_events',
    'request_agents',
    'replace_agent',
    'stop_agent',
    'write_handoff',
    'get_lead_notes',
  ]),
});
