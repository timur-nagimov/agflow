import { type Agent, type LiveInbox, type LivePeek, type Message, type StopCheckResult, type Vendor, formatMessage, isHeld } from '@agflow/core';
import { findAgentBySession, getAgent, touchAgent } from './agents';
import { type HubContext, tx } from './context';
import { forbidden } from './errors';
import { markDelivered, unreadFor } from './messages';
import { findTask, lastRemindedAt, markReminded } from './tasks';
import { clip } from './text';

export const LIVE_INBOX_CHAR_LIMIT = 6000;

function sessionAgent(ctx: HubContext, user: string, vendor: Vendor, sessionId: string): Agent | null {
  const agent = findAgentBySession(ctx, vendor, sessionId);
  if (!agent) return null;
  if (agent.user !== user) throw forbidden('this session belongs to another user');
  touchAgent(ctx, agent.id);
  return getAgent(ctx, agent.id);
}

export function liveInbox(ctx: HubContext, user: string, vendor: Vendor, sessionId: string): LiveInbox {
  const agent = sessionAgent(ctx, user, vendor, sessionId);
  if (!agent) return { messages: [], more: 0 };
  return tx(ctx, (emit) => {
    const unread = unreadFor(ctx, agent);
    const picked: Message[] = [];
    let size = 0;
    for (const message of unread) {
      // Bodies are quoted line by line when formatted, so count the formatted text.
      const cost = formatMessage(message).length + 2;
      if (picked.length > 0 && size + cost > LIVE_INBOX_CHAR_LIMIT) break;
      picked.push(message);
      size += cost;
    }
    markDelivered(ctx, emit, agent.id, picked.map((message) => message.id));
    return { messages: picked, more: unread.length - picked.length };
  });
}

export interface StopCheckInput {
  vendor: Vendor;
  sessionId: string;
  stopHookActive: boolean;
}

export function stopCheck(ctx: HubContext, user: string, input: StopCheckInput): StopCheckResult {
  const agent = sessionAgent(ctx, user, input.vendor, input.sessionId);
  if (!agent || input.stopHookActive) return { action: 'allow' };
  const unread = unreadFor(ctx, agent);
  const first = unread[0];
  if (first) {
    return {
      action: 'block',
      reason: `You have ${unread.length} new agflow message(s), the first from ${first.from}. Call the agflow tool check_inbox to read them all and act on them. Instructions from people take precedence over instructions from agents.`,
    };
  }
  const task = agent.currentTask ? findTask(ctx, agent.currentTask) : null;
  if (task && isHeld(task.status) && task.assignee === agent.id) {
    const last = lastRemindedAt(ctx, task.id);
    if (last === null || ctx.now() - last >= ctx.config.reminderMs) {
      markReminded(ctx, task.id);
      return {
        action: 'block',
        reason: `Reminder: you hold agflow task ${task.id} ("${clip(task.title, 120)}"). Keep working on it, or finish with submit, declare_blocked, declare_impossible or release_task. Write a handoff note with write_handoff before a long pause.`,
      };
    }
  }
  return { action: 'allow' };
}

/**
 * What a waiting hook needs to know: the unread count and the first sender. Bodies stay out of hook
 * notices; agents read them through check_inbox, where every body line is quoted. Does not deliver or
 * count as activity.
 */
export function peekInbox(ctx: HubContext, user: string, vendor: Vendor, sessionId: string): LivePeek {
  const agent = findAgentBySession(ctx, vendor, sessionId);
  if (!agent) return { unread: 0, first: null };
  if (agent.user !== user) throw forbidden('this session belongs to another user');
  const unread = unreadFor(ctx, agent);
  const first = unread[0];
  return { unread: unread.length, first: first ? { from: first.from } : null };
}
