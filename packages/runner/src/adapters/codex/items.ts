// App-server tool items as runner events (design 7.5, 9.2, 10). Code Mode's nested calls use these same items.
import { BRIDGE_ANSWERS } from '@agflow/core';
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

/**
 * Codex runs every command as `<shell> -c <script>` (or -lc), joined with shlex; the agent wrote only the script.
 * Anything that is not exactly those three words stays as it is.
 */
function innerCommand(command: string): string {
  const words = shellWords(command);
  if (words?.length !== 3 || !/^(?:\S*\/)?[a-z]*sh$/.test(words[0]!) || !['-c', '-lc'].includes(words[1]!)) {
    return command;
  }
  return words[2]!;
}

/**
 * The words of a command as shlex quotes them: unquoted runs, '...' chunks, and "..." chunks in which a backslash
 * escapes $ ` " and itself; adjacent chunks form one word. Null for anything shlex would not write, such as an
 * operator, an expansion or an unterminated quote.
 */
function shellWords(command: string): string[] | null {
  const words: string[] = [];
  let word: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if (char === ' ') {
      if (word !== null) words.push(word);
      word = null;
    } else if (char === "'") {
      const end = command.indexOf("'", i + 1);
      if (end === -1) return null;
      word = (word ?? '') + command.slice(i + 1, end);
      i = end;
    } else if (char === '"') {
      let chunk = '';
      for (i++; command[i] !== '"'; i++) {
        const inner = command[i];
        if (inner === undefined || inner === '$' || inner === '`') return null;
        if (inner === '\\' && ['$', '`', '"', '\\'].includes(command[i + 1] ?? '')) i++;
        chunk += command[i];
      }
      word = (word ?? '') + chunk;
    } else if (/[\s|&;<>()$`\\*?[\]{}#~!]/.test(char)) {
      return null;
    } else {
      word = (word ?? '') + char;
    }
  }
  if (word !== null) words.push(word);
  return words;
}
