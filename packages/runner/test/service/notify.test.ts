import { describe, expect, test } from 'bun:test';
import { APPROVALS_ROUTE } from '@agflow/core';
import { isTestMode, RunnerConfigSchema } from '../../src/config';
import { memoryLogger } from '../../src/log';
import { createMacNotifier, NOTIFY_REPEAT_MS } from '../../src/service/notify';
import { defaultExec, type Exec, type ExecResult } from '../../src/service/system';
import { recordingExec } from '../service-helpers';

const script = [
  'osascript',
  '-e',
  'on run argv',
  '-e',
  'display notification (item 1 of argv) with title (item 2 of argv)',
  '-e',
  'end run',
  '--',
];
const injection = 'x" & (do shell script "touch /tmp/pwned") & "';
const notification = { key: 'approval-1', title: 'agflow: attempt asks for your approval', body: 'Approve this?' };
const options = { testMode: false, platform: 'darwin' as const };

describe('createMacNotifier', () => {
  test.each([injection, '-e'])('passes untrusted text only as argv: %s', async (text) => {
    const exec = recordingExec();
    await createMacNotifier(exec, options).notify({ ...notification, body: text, title: text });
    expect(exec.calls).toEqual([{ argv: [...script, text, text], options: { timeoutMs: 10_000 } }]);
  });

  test('caps title and body at 200 characters without splitting Unicode code points', async () => {
    const exec = recordingExec();
    const notifier = createMacNotifier(exec, options);
    await notifier.notify({ key: 'long', title: '😀'.repeat(201), body: 'x'.repeat(201) });
    expect(exec.calls[0].argv.slice(-2)).toEqual(['x'.repeat(199) + '…', '😀'.repeat(199) + '…']);
    await notifier.notify({ key: 'exact', title: 't'.repeat(200), body: 'b'.repeat(200) });
    expect(exec.calls[1].argv.slice(-2)).toEqual(['b'.repeat(200), 't'.repeat(200)]);
  });

  test('keeps the Approvals address on the last line when shortening a summary', async () => {
    const exec = recordingExec();
    const address = `https://hub.example.test${APPROVALS_ROUTE}`;
    await createMacNotifier(exec, options).notify({ ...notification, body: `${'s'.repeat(300)}\n${address}` });
    expect(exec.calls[0].argv.at(-2)).toBe(`${'s'.repeat(198 - address.length)}…\n${address}`);
  });

  test.each([198, 199, 200, 201])('handles a final line of %s characters within the cap', async (length) => {
    const exec = recordingExec();
    const lastLine = 'u'.repeat(length);
    await createMacNotifier(exec, options).notify({ ...notification, body: `summary\n${lastLine}` });
    const body = exec.calls[0].argv.at(-2)!;
    expect(Array.from(body).length).toBeLessThanOrEqual(200);
    if (length <= 200) expect(body.endsWith(lastLine)).toBe(true);
    else expect(body.endsWith('…')).toBe(true);
  });

  test('keeps agent text on one line above the address, so it cannot forge another address line', async () => {
    const exec = recordingExec();
    const address = `https://hub.example.test${APPROVALS_ROUTE}`;
    for (const breaks of ['\n', '\u2028', '\u2029']) {
      const forged = `cmd${breaks}https://evil.test/#/approvals${breaks.repeat(3)}`;
      await createMacNotifier(exec, options).notify({ ...notification, body: `${forged}\n${address}` });
      const body = exec.calls.at(-1)!.argv.at(-2)!;
      expect(body).toBe(`cmd https://evil.test/#/approvals   \n${address}`);
      expect(body.split('\n')).toHaveLength(2);
    }
    await createMacNotifier(exec, options).notify({ ...notification, title: 'a\u2028b\u2029c' });
    expect(exec.calls.at(-1)!.argv.at(-1)).toBe('a b c');
  });

  test('replaces control characters with spaces while preserving newlines', async () => {
    const exec = recordingExec();
    const text = 'a\0b\t\r\u001b\u007f\u0085\nc';
    await createMacNotifier(exec, options).notify({ ...notification, body: text, title: text });
    expect(exec.calls[0].argv.slice(-2)).toEqual(['a b     \nc', 'a b     \nc']);
  });

  test('limits each key from its last post, not its last suppressed call', async () => {
    let now = 0;
    const exec = recordingExec();
    const notifier = createMacNotifier(exec, { ...options, now: () => now });
    expect(NOTIFY_REPEAT_MS).toBe(5 * 60_000);
    await notifier.notify(notification);
    now = NOTIFY_REPEAT_MS - 1;
    await notifier.notify(notification);
    await notifier.notify({ ...notification, key: 'needs_login' });
    expect(exec.calls).toHaveLength(2);
    now = NOTIFY_REPEAT_MS;
    await notifier.notify(notification);
    await notifier.notify({ ...notification, key: 'needs_login' });
    expect(exec.calls).toHaveLength(3);
    now += NOTIFY_REPEAT_MS;
    await notifier.notify({ ...notification, key: 'new-key' });
    await notifier.notify(notification);
    expect(exec.calls).toHaveLength(5);
  });

  test('reserves the key before awaiting exec and awaits the post', async () => {
    const calls = recordingExec();
    let finish!: (result: ExecResult) => void;
    const pending = new Promise<ExecResult>((resolve) => {
      finish = resolve;
    });
    const exec: Exec = async (argv, opts) => {
      await calls(argv, opts);
      return pending;
    };
    const notifier = createMacNotifier(exec, options);
    let settled = false;
    const first = Promise.resolve(notifier.notify(notification)).then(() => {
      settled = true;
    });
    await notifier.notify(notification);
    expect(calls.calls).toHaveLength(1);
    expect(settled).toBe(false);
    finish({ exitCode: 0, stdout: '', stderr: '', timedOut: false });
    await first;
    expect(settled).toBe(true);
  });

  test('posts nothing in M2b test mode or off macOS', async () => {
    const config = RunnerConfigSchema.parse({ runnerKey: 'rk_test', machineId: 'MACHINE-1', name: 'mac', test: {} });
    const exec = recordingExec();
    const testMode = isTestMode(config, { AGFLOW_TEST: '1' });
    expect(testMode).toBe(true);
    await createMacNotifier(exec, { ...options, testMode }).notify(notification);
    await createMacNotifier(exec, { ...options, platform: 'linux' }).notify(notification);
    await createMacNotifier(exec, { ...options, platform: 'win32' }).notify(notification);
    expect(exec.calls).toHaveLength(0);
  });

  test('defaults to the current platform with an explicit test-mode decision', async () => {
    const exec = recordingExec();
    await createMacNotifier(exec, { testMode: false }).notify(notification);
    expect(exec.calls).toHaveLength(process.platform === 'darwin' ? 1 : 0);
  });

  test.each([
    { exitCode: 1, stderr: 'permission denied\nprivate details', timedOut: false },
    { exitCode: 0, stderr: 'timeout\nprivate details', timedOut: true },
  ])('warns and resolves on an unsuccessful post: %j', async (result) => {
    const exec = recordingExec([], result);
    const logger = memoryLogger();
    const notifier = createMacNotifier(exec, { ...options, logger });
    await notifier.notify(notification);
    await notifier.notify(notification);
    expect(exec.calls).toHaveLength(1);
    expect(logger.entries).toEqual([
      {
        level: 'warn',
        message: 'cannot post macOS notification',
        fields: {
          key: notification.key,
          exitCode: result.exitCode,
          stderr: result.stderr.split('\n')[0],
          timedOut: result.timedOut,
        },
      },
    ]);
    expect(JSON.stringify(logger.entries)).not.toContain(notification.body);
  });

  test('catches a thrown exec and counts the failure toward the repeat limit', async () => {
    const logger = memoryLogger();
    let calls = 0;
    const exec: Exec = async () => {
      calls++;
      throw new Error(`spawn failed: ${notification.body}`);
    };
    const notifier = createMacNotifier(exec, { ...options, logger });
    await notifier.notify(notification);
    await notifier.notify(notification);
    expect(calls).toBe(1);
    expect(logger.entries).toHaveLength(1);
    expect(logger.entries[0]).toMatchObject({ level: 'warn', fields: { key: notification.key, exitCode: null } });
    expect(JSON.stringify(logger.entries)).not.toContain(notification.body);
  });

  test.skipIf(process.platform !== 'darwin')('real osascript returns injection text verbatim without posting', async () => {
    const exec = recordingExec();
    const body = `-e ${injection}`;
    await createMacNotifier(exec, options).notify({ ...notification, body, title: injection });
    const argv = exec.calls[0].argv.slice();
    argv[4] = 'return (item 1 of argv) & "|" & (item 2 of argv)';
    const result = await defaultExec(argv, { timeoutMs: 10_000 });
    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
    expect(result.stdout).toBe(`${body}|${injection}\n`);
  });
});
