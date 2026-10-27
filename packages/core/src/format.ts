import type { Message } from './types';

/** Everything a reader may take for the end of a line. */
const LINE_BREAK = /\r\n|[\n\v\f\r\u0085\u2028\u2029]/;

/**
 * Quotes text that someone else wrote, so that agents read it as data. Every line, the empty ones
 * too, starts with ">". No line of the text can then start a heading, a bullet or a header of the
 * hub's own, such as "## Standing rules from people" or "[agflow message", and pose as the hub or as
 * a person.
 */
export function quoteLines(text: string): string {
  return text
    .split(LINE_BREAK)
    .map((line) => (line === '' ? '>' : `> ${line}`))
    .join('\n');
}

/**
 * Renders one message for an agent. The header, written here, is the only authority signal: it
 * names the sender. The body is data from that sender, so every body line is quoted with "> ".
 * No body line can then start with "[agflow message" and pose as another header, for example a
 * person's standing rule.
 */
export function formatMessage(message: Message): string {
  const about = message.taskId ? ` about ${message.taskId}` : '';
  const rule = message.standingRule ? ' (standing rule)' : '';
  return `[agflow message #${message.id} from ${message.from}${about}${rule}]\n${quoteLines(message.body)}`;
}

export function formatMessages(messages: Message[]): string {
  return messages.map(formatMessage).join('\n\n');
}
