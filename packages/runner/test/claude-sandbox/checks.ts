// Shared pieces of the local sandbox checks (design 5, 15, 7.6; X-20): their gate, the probe scripts the model runs
// through real sandboxed Bash calls, the same scripts run outside for comparison, a throwaway keychain, and the table
// of what each check expected and observed, which the suites print.
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterToolResult, bashTool, reply, rules, type ScriptRule, userSays } from '@agflow/testkit/src/anthropic';
import {
  type ClaudeSmoke,
  type ClaudeSmokeGate,
  type ClaudeSmokeGateOptions,
  claudeSmokeGate,
} from '../claude-real/harness';

/** check:claude-sandbox sets both: the checks are real-CLI suites too. */
const SANDBOX_SWITCHES = ['AGFLOW_SMOKE', 'AGFLOW_SANDBOX_CHECKS'];

/** The git host the network checks try, over HTTPS and SSH. */
export const SANDBOX_GIT_HOST = 'github.com';

/** An allowed registry of the standard profile (7.6). */
export const SANDBOX_REGISTRY = 'registry.npmjs.org';

const PROBES = join(import.meta.dir, 'probes');

const SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

/** Where the probe scripts lie in the clone, relative to it: the agent's commands run there. */
const CLONE_PROBES = 'agflow-probes';

/** A probe of slow hosts waits out several timeouts; the Bash tool's default of 2 minutes is too short. */
const PROBE_TOOL_TIMEOUT_MS = 300_000;

/**
 * Whether the sandbox checks run: only on macOS, whose Seatbelt sandbox they check, with AGFLOW_SMOKE=1 and
 * AGFLOW_SANDBOX_CHECKS=1 and the pinned claude. Otherwise the reason says what is missing.
 */
export function sandboxGate(options: ClaudeSmokeGateOptions & { platform?: string } = {}): ClaudeSmokeGate {
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin') return { run: false, bin: null, reason: `the sandbox checks need macOS, not ${platform}` };
  return claudeSmokeGate({ ...options, switches: SANDBOX_SWITCHES });
}

// ---------------------------------------------------------------------------------------------------------------
// Probes

/** What a probe script printed for one label: `PROBE <label words>: <result> <detail>`. */
export interface ProbeResult {
  result: string;
  detail: string;
}

export type ProbeResults = Map<string, ProbeResult>;

const PROBE_LINE = /^PROBE (.+?): (\S+) ?(.*)$/;

/** The PROBE lines of a script's output, by label; the last line of a label wins. */
export function parseProbes(output: string): ProbeResults {
  const results: ProbeResults = new Map();
  // ssh's log lines end in \r\n.
  for (const line of output.split(/\r?\n/)) {
    const found = line.match(PROBE_LINE);
    if (found?.[1] && found[2]) results.set(found[1], { result: found[2], detail: found[3] ?? '' });
  }
  return results;
}

/** The environment of an outside run: no proxy, no SSH agent, and the scratch HOME. */
export function outsideEnv(smoke: Pick<ClaudeSmoke, 'home'>): Record<string, string> {
  return { PATH: SYSTEM_PATH, HOME: smoke.home, LANG: 'C.UTF-8' };
}

/**
 * Runs a probe script outside the sandbox, as the test process. Asynchronously: the hub it may probe answers from
 * this process.
 */
export async function runOutside(script: string, args: string[], env: Record<string, string>): Promise<ProbeResults> {
  const proc = Bun.spawn(['/bin/sh', join(PROBES, script), ...args], {
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    // Piped, not ignored: ssh does not run its key exchange with a closed standard error.
    stderr: 'pipe',
  });
  const [output] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return parseProbes(output);
}

/** The Bash command that runs a probe script from the clone, its arguments quoted for the shell. */
export function probeCommand(script: string, args: string[]): string {
  return ['sh', `${CLONE_PROBES}/${script}`, ...args].map(shellQuote).join(' ');
}

function shellQuote(word: string): string {
  return /^[\w./:@-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

/**
 * Has the model run the commands through the Bash tool, one call after another in one turn, from the clone with the
 * probe scripts copied in, and returns every PROBE line the results carried. A result without one (a permission
 * denial, say) fails with what the model saw.
 */
export async function runAsAgent(smoke: ClaudeSmoke, commands: string[]): Promise<ProbeResults> {
  const directory = join(smoke.clone, CLONE_PROBES);
  mkdirSync(directory, { recursive: true });
  for (const script of readdirSync(PROBES)) copyFileSync(join(PROBES, script), join(directory, script));
  const prompt = `Run the sandbox probes ${crypto.randomUUID().slice(0, 8)}.`;
  const ids = commands.map((_, index) => `toolu_probe_${index + 1}`);
  const call = (index: number) =>
    reply(bashTool({ command: commands[index] ?? '', id: ids[index], timeoutMs: PROBE_TOOL_TIMEOUT_MS }));
  // Each result asks for the next command; the last one ends the turn.
  const script: ScriptRule[] = ids.map((id, index) => ({
    when: afterToolResult(id),
    reply: index + 1 < ids.length ? call(index + 1) : reply('The probes ran.'),
  }));
  smoke.server.setHandler(rules(...script, { when: userSays(prompt), reply: call(0) }));
  const session = await smoke.start({ prompt });
  const ended = await session.next('turn_ended', () => true, { timeoutMs: PROBE_TOOL_TIMEOUT_MS * commands.length });
  await session.session.close();
  await session.ended;
  if (ended.outcome !== 'completed') throw new Error(`the probe turn ended ${ended.outcome}: ${ended.error}`);
  const results: ProbeResults = new Map();
  for (const [index, id] of ids.entries()) {
    const answered = smoke.server.requests.find((request) => afterToolResult(id)(request));
    const text = answered?.toolResults.find((result) => result.toolUseId === id)?.text;
    const parsed = parseProbes(text ?? '');
    if (parsed.size === 0) throw new Error(`\`${commands[index]}\` printed no probe line: ${text ?? 'no result'}`);
    for (const [label, result] of parsed) results.set(label, result);
  }
  return results;
}

// ---------------------------------------------------------------------------------------------------------------
// The throwaway keychain

export interface ThrowawayKeychain {
  path: string;
  service: string;
  account: string;
  secret: string;
  /** Deletes the keychain; safe to call more than once. */
  remove(): void;
}

/**
 * A new keychain file holding one generic-password item, made with `security` under the given (scratch) HOME. The
 * owner's login keychain and search list are left alone, which is checked.
 */
export function throwawayKeychain(path: string, home: string): ThrowawayKeychain {
  const security = (args: string[], env: Record<string, string> = { PATH: SYSTEM_PATH, HOME: home }) =>
    Bun.spawnSync(['/usr/bin/security', ...args], { env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const run = (...args: string[]) => {
    const result = security(args);
    if (result.exitCode !== 0) throw new Error(`security ${args[0]} failed: ${result.stderr.toString().trim()}`);
  };
  const tag = crypto.randomUUID().slice(0, 8);
  const keychain: ThrowawayKeychain = {
    path,
    service: `agflow-sandbox-probe-${tag}`,
    account: 'agflow-probe',
    secret: `agflow-probe-secret-${crypto.randomUUID()}`,
    remove() {
      if (!existsSync(path)) return;
      security(['delete-keychain', path]);
      rmSync(path, { force: true });
    },
  };
  try {
    run('create-keychain', '-p', crypto.randomUUID(), path);
    run('add-generic-password', '-s', keychain.service, '-a', keychain.account, '-w', keychain.secret, path);
    // A new keychain locks after 5 minutes and on sleep, and a locked one refuses the lookup inside for that reason
    // alone; with no options it never locks.
    run('set-keychain-settings', path);
    // show-keychain-info writes to standard error.
    const settings = security(['show-keychain-info', path]).stderr.toString().trim();
    if (!settings.includes('no-timeout') || settings.includes('lock-on-sleep')) {
      throw new Error(`${path} still locks itself: ${settings}`);
    }
    // The user's search list, as the owner's own processes see it.
    const owner = security(['list-keychains', '-d', 'user'], { PATH: SYSTEM_PATH, HOME: homedir() });
    if (owner.stdout.toString().includes(path)) throw new Error(`${path} joined the owner's keychain search list`);
  } catch (error) {
    keychain.remove();
    throw error;
  }
  return keychain;
}

// ---------------------------------------------------------------------------------------------------------------
// The table

export interface CheckRow {
  check: string;
  expected: string;
  observed: string;
  /** Why the check did not run (an unreachable host, say); a skipped row never mismatches. */
  skipped?: string | null;
}

/** The rows under a title, in aligned columns; a mismatching row is marked. */
export function formatChecks(title: string, rows: CheckRow[]): string {
  const header: CheckRow = { check: 'check', expected: 'expected', observed: 'observed' };
  const all = [header, ...rows];
  const checkWidth = Math.max(...all.map((row) => row.check.length));
  const expectedWidth = Math.max(...all.map((row) => row.expected.length));
  const lines = all.map((row) => {
    const observed = row.skipped ? `skipped: ${row.skipped}` : row.observed;
    const mark = row !== header && isMismatch(row) ? '  MISMATCH' : '';
    return `  ${row.check.padEnd(checkWidth)}  ${row.expected.padEnd(expectedWidth)}  ${observed}${mark}`.trimEnd();
  });
  return [title, ...lines].join('\n');
}

function isMismatch(row: CheckRow): boolean {
  return !row.skipped && row.expected !== row.observed;
}

/** The rows whose observed result is not the expected one. */
export function mismatches(rows: CheckRow[]): CheckRow[] {
  return rows.filter(isMismatch);
}

/** The checks one suite made, printed once it ends, so a run shows what held and what did not. */
export class CheckTable {
  readonly rows: CheckRow[] = [];

  constructor(readonly title: string) {}

  /** Adds the rows and returns them, for the test's own assertions. */
  add(...rows: CheckRow[]): CheckRow[] {
    this.rows.push(...rows);
    return rows;
  }

  print(): void {
    if (this.rows.length > 0) console.log(formatChecks(this.title, this.rows));
  }
}
