// App-server tool items as runner events (design 7.5, 9.2, 10). Code Mode's nested calls use these same items.
import { BRIDGE_ANSWERS, innerCommand } from '@agflow/core';
import type { AgentEvent, TerminalTool } from '../types';
import type { ThreadItem } from './protocol/v2';

type ToolStarted = Extract<AgentEvent, { type: 'tool_started' }>;
type ToolEnded = Extract<AgentEvent, { type: 'tool_ended' }>;

export function codexToolStarted(item: ThreadItem): ToolStarted | null {
  switch (item.type) {
    case 'commandExecution': {
      const command = innerCommand(item.command);
      return { type: 'tool_started', toolId: item.id, name: 'exec_command', input: command, command };
    }
    case 'fileChange':
      return {
        type: 'tool_started',
        toolId: item.id,
        name: 'apply_patch',
        // The patch is the call's argument: repeated edits of one file are not a loop (design 6.8).
        input: item.changes.map((change) => `${change.path}\n${change.diff}`).join('\n'),
        command: null,
      };
    case 'mcpToolCall':
      return {
        type: 'tool_started',
        toolId: item.id,
        name: `mcp__${item.server}__${item.tool}`,
        input: JSON.stringify(item.arguments),
        command: null,
      };
    default:
      return null;
  }
}

export function codexToolEnded(item: ThreadItem): ToolEnded | null {
  if (item.type !== 'commandExecution' && item.type !== 'fileChange' && item.type !== 'mcpToolCall') return null;
  return {
    type: 'tool_ended',
    toolId: item.id,
    ok: item.status === 'completed' && (item.type !== 'commandExecution' || item.exitCode === 0),
    denied: item.type !== 'mcpToolCall' && item.status === 'declined',
    terminal: agflowTerminal(item),
    hubUnreachable:
      item.type === 'mcpToolCall' &&
      item.server === 'agflow' &&
      item.status === 'failed' &&
      item.result?.content
        .filter((part) => part !== null && typeof part === 'object' && !Array.isArray(part) && part.type === 'text')
        .map((part) => (part as { text?: unknown }).text)
        .join('\n') === BRIDGE_ANSWERS.hubUnreachable,
  };
}

/** A bridge refusal is status failed, even when its text says submission pending (X-19). */
export function agflowTerminal(item: ThreadItem): TerminalTool | null {
  if (item.type !== 'mcpToolCall' || item.server !== 'agflow' || item.status !== 'completed') return null;
  switch (item.tool) {
    case 'submit':
      return 'submit';
    case 'write_handoff':
      return 'handoff';
    case 'declare_blocked':
      return 'blocked';
    case 'declare_impossible':
      return 'impossible';
    case 'release_task':
      return 'released';
    default:
      return null;
  }
}
