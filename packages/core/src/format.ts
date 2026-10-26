import type { Message } from './types';

/** Everything a reader may take for the end of a line. */
const LINE_BREAK = /\r\n|[\n\v\f\r\u0085\u2028\u2029]/;

/**
 * Renders one message for an agent. The header, written here, is the only authority signal: it
 * names the sender. The body is data from that sender, so every body line is quoted with "> ".
 * No body line can then start with "[agflow message" and pose as another header, for example a
 * person's standing rule.
 */
export function formatMessage(message: Message): string {
  const about = message.taskId ? ` about ${message.taskId}` : '';
  const rule = message.standingRule ? ' (standing rule)' : '';
  const quoted = message.body
    .split(LINE_BREAK)
    .map((line) => (line === '' ? '>' : `> ${line}`))
    .join('\n');
  return `[agflow message #${message.id} from ${message.from}${about}${rule}]\n${quoted}`;
}

export function formatMessages(messages: Message[]): string {
  return messages.map(formatMessage).join('\n\n');
}
