import type { Message } from './types';

export function formatMessage(message: Message): string {
  const about = message.taskId ? ` about ${message.taskId}` : '';
  const rule = message.standingRule ? ' (standing rule)' : '';
  return `[agflow message #${message.id} from ${message.from}${about}${rule}]\n${message.body}`;
}

export function formatMessages(messages: Message[]): string {
  return messages.map(formatMessage).join('\n\n');
}
