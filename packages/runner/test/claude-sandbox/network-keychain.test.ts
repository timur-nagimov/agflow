// Boundary 1 and the keychain with the real claude (design 5, 15, 7.6), gated by AGFLOW_SANDBOX_CHECKS=1 (X-20),
// macOS only. The model runs the probe scripts from the clone through real sandboxed Bash calls, so the guard never
// pre-empts the sandbox, and the same scripts run outside for comparison. Claude's sandbox proxy chains through the
// CLI's HTTPS_PROXY, so the network checks give the CLI a test proxy that tunnels only to the allowed registry and
// refuses and records every other target; the model still comes only from the scripted server.
import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { claudePin } from '../../src/adapters/claude/pin';
import { vendorPlatform } from '../../src/vendor/pins';
import { cleanupClaudeSmokes, smokeDescribe, startClaudeSmoke } from '../claude-real/harness';
import {
  type CheckRow,
  CheckTable,
  formatChecks,
  mismatches,
  outsideEnv,
  type ProbeResults,
  probeCommand,
  runAsAgent,
  runOutside,
  SANDBOX_GIT_HOST,
  SANDBOX_REGISTRY,
  sandboxGate,
  throwawayKeychain,
} from './checks';

// A cold start of the CLI, its sandbox, the bridge and the brief hook, plus probes that wait out unreachable hosts.
setDefaultTimeout(300_000);

const table = new CheckTable('Sandbox checks: network and keychain');
const keychains = new Set<() => void>();

afterEach(async () => {
  // The throwaway keychain goes even when a test failed before its own cleanup ran.
  for (const remove of [...keychains]) remove();
  keychains.clear();
  await cleanupClaudeSmokes();
});
afterAll(() => table.print());

const gate = sandboxGate();

/** The only target the network checks' test proxy tunnels to the real host. */
const EGRESS = [`${SANDBOX_REGISTRY}:443`];

describe('sandboxGate', () => {
  test('without AGFLOW_SANDBOX_CHECKS=1 the checks are skipped with the reason', () => {
    const result = sandboxGate({ env: { AGFLOW_SMOKE: '1' }, platform: 'darwin' });
    expect(result).toEqual({ run: false, bin: null, reason: 'AGFLOW_SANDBOX_CHECKS=1 not set' });
    expect(sandboxGate({ env: { AGFLOW_SMOKE: '1', AGFLOW_SANDBOX_CHECKS: '1' }, platform: 'linux' }).reason).toBe(
      'the sandbox checks need macOS, not linux',
    );
  });

  test('without the pinned binary the checks are skipped with the reason', () => {
    const missing = '/nonexistent/agflow-claude';
    const env = { AGFLOW_SMOKE: '1', AGFLOW_SANDBOX_CHECKS: '1', AGFLOW_CLAUDE_BIN: missing };
    const result = sandboxGate({ env, home: '/nonexistent', platform: 'darwin' });
    expect(result.run).toBe(false);
    // On a platform without a pin (CI's Linux) the gate stops there.
    if (claudePin(vendorPlatform()) === null) {
      expect(result.reason).toBe(`agflow pins no claude for ${vendorPlatform()}`);
    } else {
      expect(result.reason).toContain(`AGFLOW_CLAUDE_BIN ${missing} is missing`);
      expect(result.reason).toContain('bun run vendor:install');
    }
  });

  test('the check table lists each check with its expected and observed result', () => {
    const text = formatChecks('Checks', [
      { check: 'hub over HTTP', expected: 'blocked', observed: 'blocked', skipped: null },
      { check: 'registry over HTTPS', expected: 'reached', observed: 'blocked', skipped: null },
      { check: 'git host over SSH', expected: 'blocked', observed: '', skipped: 'unreachable outside' },
    ]);
    expect(text.split('\n')).toEqual([
      'Checks',
      '  check                expected  observed',
      '  hub over HTTP        blocked   blocked',
      '  registry over HTTPS  reached   blocked  MISMATCH',
      '  git host over SSH    blocked   skipped: unreachable outside',
    ]);
  });
});

smokeDescribe(gate, 'sandbox checks: network', () => {
  test('a sandboxed command reaches neither the hub URL nor the git host, over HTTPS or SSH', async () => {
    const smoke = await startClaudeSmoke({ bin: gate.bin ?? undefined, egress: EGRESS });
    const hubUrl = smoke.launch().env.AGFLOW_HUB_URL;
    if (!hubUrl) throw new Error('the agent environment has no AGFLOW_HUB_URL');
    // The sandbox has no DNS, so the direct probes use the address resolved outside.
    const address = await resolveHost(SANDBOX_GIT_HOST);
    const gitHost = `https://${SANDBOX_GIT_HOST}/`;
    // A refusing proxy answers plain HTTP itself, so the hub counts as reached only when it saw the probe's own path.
    const hubPath = (side: string, route: string) => `/agflow-probe/${side}/${route}`;
    const probes = (side: string): Probe[] => [
      ['hub over HTTP through the sandbox proxy', 'http', `${hubUrl}${hubPath(side, 'proxy')}`, 'env', '-'],
      ['hub over HTTP directly', 'http', `${hubUrl}${hubPath(side, 'direct')}`, 'direct', '-'],
      ...(address === null
        ? []
        : ([
            ['git host over HTTPS through the sandbox proxy', 'http', gitHost, 'env', '-'],
            ['git host over HTTPS directly', 'http', gitHost, 'direct', `${SANDBOX_GIT_HOST}:443:${address}`],
            ['git host over SSH through the sandbox proxy', 'ssh', SANDBOX_GIT_HOST, 'env', '-'],
            ['git host over SSH directly', 'ssh', address, 'direct', '-'],
          ] satisfies Probe[])),
    ];
    const outside = await runOutside('net.sh', probes('outside').flat(), outsideEnv(smoke));
    const inside = await runAsAgent(smoke, [probeCommand('net.sh', probes('inside').flat())]);
    const hubSaw = (path: string) => smoke.hubRequests.some((request) => request.path === path);
    const rows: CheckRow[] = [];
    for (const [label, , target] of probes('outside')) {
      const route = target.startsWith(hubUrl) ? target.slice(target.lastIndexOf('/') + 1) : null;
      const reached = (side: string, results: ProbeResults) => {
        if (route === null) return results.get(label)?.result ?? 'no answer';
        return hubSaw(hubPath(side, route)) ? 'reached' : 'blocked';
      };
      const before = reached('outside', outside);
      if (route !== null && before !== 'reached') throw new Error(`the hub is unreachable outside the sandbox too`);
      rows.push({
        check: `sandboxed ${label}`,
        expected: 'blocked',
        observed: reached('inside', inside),
        skipped: before === 'reached' ? null : `unreachable outside: ${outside.get(label)?.detail ?? 'no answer'}`,
      });
    }
    if (address === null) {
      rows.push({
        check: `sandboxed ${SANDBOX_GIT_HOST}`,
        expected: 'blocked',
        observed: '',
        skipped: `${SANDBOX_GIT_HOST} does not resolve outside: offline`,
      });
    }
    expect(mismatches(table.add(...rows))).toEqual([]);
    expect(smoke.isolationProblems()).toEqual([]);
  });

  test(`an allowed registry (${SANDBOX_REGISTRY}) is reachable inside, through the HTTP and SOCKS proxy`, async () => {
    const smoke = await startClaudeSmoke({ bin: gate.bin ?? undefined, egress: EGRESS });
    const url = `https://${SANDBOX_REGISTRY}/`;
    // The SOCKS route is the git host's SSH probe's: reaching the registry shows that route works, so the git host's
    // refusal there comes from the allow list.
    const viaProxy: Probe = ['registry over HTTPS through the sandbox proxy', 'http', url, 'env', '-'];
    const viaSocks: Probe = ['registry over HTTPS through the sandbox SOCKS proxy', 'http', url, 'socks', '-'];
    const probes = [viaProxy, viaSocks];
    // Outside, without proxies, both routes are the same request.
    const outside = (await runOutside('net.sh', viaProxy, outsideEnv(smoke))).get(viaProxy[0]);
    if (outside?.result !== 'reached') {
      table.add(
        ...probes.map(([label]) => ({
          check: `sandboxed ${label}`,
          expected: 'reached',
          observed: '',
          skipped: `unreachable outside: ${outside?.detail ?? 'no answer'}`,
        })),
      );
      return;
    }
    const inside = await runAsAgent(smoke, [probeCommand('net.sh', probes.flat())]);
    const rows = probes.map(([label]) => ({
      check: `sandboxed ${label}`,
      expected: 'reached',
      observed: inside.get(label)?.result ?? 'no answer',
    }));
    expect(mismatches(table.add(...rows))).toEqual([]);
    expect(smoke.isolationProblems()).toEqual([]);
  });
});

smokeDescribe(gate, 'sandbox checks: keychain', () => {
  test('a throwaway generic-password item is readable outside the sandbox and not inside', async () => {
    const smoke = await startClaudeSmoke({ bin: gate.bin ?? undefined });
    // The deny list names <HOME>/Library/Keychains for the agent's HOME, so the item's keychain lies there. The CLI
    // never gets the owner's HOME in a test (it writes ~/.claude and caches into it), and the owner's login keychain
    // is never touched: a throwaway keychain file is read in-process, like the login keychain.
    const directory = join(smoke.home, 'Library', 'Keychains');
    mkdirSync(directory, { recursive: true });
    const item = throwawayKeychain(join(directory, 'agflow-probe.keychain-db'), smoke.home);
    keychains.add(item.remove);
    try {
      const args = ['keychain item', item.path, item.service, item.account];
      const outside = (await runOutside('keychain.sh', args, outsideEnv(smoke))).get('keychain item');
      const before = table.add({
        check: 'keychain item read outside the sandbox',
        expected: 'read',
        observed: outside?.detail === item.secret ? 'read' : (outside?.result ?? 'no answer'),
      });
      const inside = (await runAsAgent(smoke, [probeCommand('keychain.sh', args)])).get('keychain item');
      // Read outside again: a refusal inside counts only while the item was readable all along.
      const again = (await runOutside('keychain.sh', args, outsideEnv(smoke))).get('keychain item');
      const after = table.add(
        { check: 'sandboxed keychain item read', expected: 'refused', observed: inside?.result ?? 'no answer' },
        {
          check: 'keychain item read outside the sandbox afterwards',
          expected: 'read',
          observed: again?.detail === item.secret ? 'read' : (again?.result ?? 'no answer'),
        },
      );
      expect(mismatches([...before, ...after])).toEqual([]);
      expect(inside?.detail).not.toContain(item.secret);
      expect(smoke.isolationProblems()).toEqual([]);
    } finally {
      item.remove();
      keychains.delete(item.remove);
    }
    expect(existsSync(item.path)).toBe(false);
  });
});

/** A net.sh probe: its label, kind, target, way (env, socks or direct) and curl's --resolve entry, or '-'. */
type Probe = [label: string, kind: 'http' | 'ssh', target: string, via: 'env' | 'socks' | 'direct', resolve: string];

/** The host's IPv4 address, or null when it does not resolve: offline. */
async function resolveHost(host: string): Promise<string | null> {
  try {
    return (await Bun.dns.lookup(host, { family: 4 }))[0]?.address ?? null;
  } catch {
    return null;
  }
}
