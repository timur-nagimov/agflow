// Owner notifications (design 6.10, 7.1, 15.1): agent text reaches osascript only as arguments, never as script.
import { type Logger, noopLogger } from '../log';
import type { Notifier } from '../seams';
import type { Exec } from './system';

export const NOTIFY_REPEAT_MS = 5 * 60_000;
const NOTIFY_MAX_CHARS = 200;

export interface MacNotifierOptions {
  /** The host supplies M2b's isTestMode(config) result. */
  testMode: boolean;
  logger?: Logger;
  platform?: NodeJS.Platform;
  now?: () => number;
}

function notificationText(text: string, preserveLastLine = false): string {
  // U+2028 and U+2029 render as line breaks too.
  let clean = text.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/g, ' ');
  if (preserveLastLine) {
    // Agent text is one line, so it cannot lay out a line that passes for the relay's address below it.
    const last = clean.lastIndexOf('\n');
    if (last !== -1) clean = `${clean.slice(0, last).replace(/\n/g, ' ')}${clean.slice(last)}`;
  }
  const chars = Array.from(clean);
  if (chars.length <= NOTIFY_MAX_CHARS) return chars.join('');
  const newline = chars.lastIndexOf('\n');
  if (preserveLastLine && newline !== -1) {
    const lastLine = chars.slice(newline + 1);
    if (lastLine.length <= NOTIFY_MAX_CHARS) {
      // The approval relay puts the hub address here; prefer it when there is no room for a summary.
      const room = NOTIFY_MAX_CHARS - lastLine.length - 2;
      if (room < 0) return lastLine.join('');
      return `${chars.slice(0, room).join('')}…\n${lastLine.join('')}`;
    }
  }
  return `${chars.slice(0, NOTIFY_MAX_CHARS - 1).join('')}…`;
}

/**
 * M2b's Notifier on macOS: approvals and needs_login, silent in test mode and on other platforms. osascript cannot
 * replace a posted notification, so a repeated key within NOTIFY_REPEAT_MS is dropped, not replaced.
 */
export function createMacNotifier(exec: Exec, options: MacNotifierOptions): Notifier {
  const { testMode, logger = noopLogger, platform = process.platform, now = Date.now } = options;
  const posted = new Map<string, number>();
  return {
    async notify({ key, title, body }) {
      if (testMode || platform !== 'darwin') return;
      const time = now();
      const last = posted.get(key);
      if (last !== undefined && time - last < NOTIFY_REPEAT_MS) return;
      for (const [oldKey, at] of posted) {
        if (time - at >= NOTIFY_REPEAT_MS) posted.delete(oldKey);
      }
      // Reserve before awaiting, including failed posts, so concurrent calls and failures cannot flood the desktop.
      posted.set(key, time);
      try {
        const result = await exec(
          [
            'osascript',
            '-e',
            'on run argv',
            '-e',
            'display notification (item 1 of argv) with title (item 2 of argv)',
            '-e',
            'end run',
            '--',
            notificationText(body, true),
            notificationText(title),
          ],
          { timeoutMs: 10_000 },
        );
        if (result.exitCode !== 0 || result.timedOut) {
          logger.warn('cannot post macOS notification', {
            key,
            exitCode: result.exitCode,
            stderr: result.stderr.split(/\r?\n/, 1)[0],
            timedOut: result.timedOut,
          });
        }
      } catch {
        // Exec exceptions can include argv, which contains private agent text.
        logger.warn('cannot post macOS notification: exec threw', { key, exitCode: null, stderr: '' });
      }
    },
  };
}
