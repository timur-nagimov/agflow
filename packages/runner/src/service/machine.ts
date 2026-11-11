// Machine facts and canonical homes (design 7.1, 7.2, 7.6): setup captures what the service and its agents inherit.
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { CONNECTIVITY_VARS, type RunnerConfig } from '../config';
import { defaultExec, type Exec } from './system';

export function parseIoregPlatformUuid(output: string): string {
  const uuid = output.match(
    /"IOPlatformUUID"\s*=\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/i,
  )?.[1];
  if (!uuid) throw new Error('ioreg output has no IOPlatformUUID');
  return uuid;
}

/** The id runner.json is bound to, so a copied home folder is refused at start. */
export async function readMachineId(
  options: { exec?: Exec; platform?: NodeJS.Platform; machineIdFile?: string } = {},
): Promise<string> {
  if ((options.platform ?? process.platform) === 'darwin') {
    const result = await (options.exec ?? defaultExec)(['ioreg', '-rd1', '-c', 'IOPlatformExpertDevice']);
    if (result.exitCode !== 0 || result.timedOut) throw new Error(`ioreg failed: ${result.stderr.trim()}`);
    return parseIoregPlatformUuid(result.stdout);
  }
  const file = options.machineIdFile ?? '/etc/machine-id';
  const id = readFileSync(file, 'utf8').trim();
  if (!id) throw new Error(`${file} has no machine id`);
  return id;
}

/** Uses the owner's macOS display name, or the host name when scutil is unavailable. */
export async function readComputerName(exec: Exec = defaultExec): Promise<string> {
  const result = await exec(['scutil', '--get', 'ComputerName']);
  return result.exitCode === 0 && !result.timedOut && result.stdout.trim() ? result.stdout.trim() : hostname();
}

type Env = Record<string, string | undefined>;
export interface LoginShellEnv {
  path: string;
  connectivity: RunnerConfig['connectivity'];
}

function selectedEnv(env: Env): LoginShellEnv {
  const connectivity: RunnerConfig['connectivity'] = {};
  for (const name of CONNECTIVITY_VARS) {
    if (env[name] !== undefined) connectivity[name] = env[name];
  }
  // Vendor CLIs run in a clone; relative entries could execute an agent-written binary.
  const entries = (env.PATH ?? '').split(':').filter((entry) => entry.startsWith('/'));
  const path = [...new Set(entries)].join(':') || '/usr/bin:/bin:/usr/sbin:/sbin';
  return { path, connectivity };
}

/** A login shell captures the owner's setup; fallback keeps setup usable if their shell fails or hangs. */
export async function captureLoginShellEnv(
  options: { env?: Env; exec?: Exec; timeoutMs?: number } = {},
): Promise<LoginShellEnv> {
  const env = options.env ?? process.env;
  const start = `AGFLOW_ENV_START_${randomUUID()}`;
  const end = `AGFLOW_ENV_END_${randomUUID()}`;
  const names = ['PATH', ...CONNECTIVITY_VARS];
  // Markers exclude profile chatter; NUL records preserve newlines and equals signs in values.
  // Print only set variables, so an unset proxy stays distinct from an explicitly empty one.
  const script = [
    `printf '%s\\0' '${start}'`,
    ...names.map((name) => `if [ "\${${name}+set}" = set ]; then printf '%s\\0' "${name}=$${name}"; fi`),
    `printf '%s\\0' '${end}'`,
  ].join('\n');
  const childEnv = Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const result = await (options.exec ?? defaultExec)([env.SHELL || '/bin/zsh', '-l', '-i', '-c', script], {
    env: childEnv,
    cwd: env.HOME ?? homedir(),
    timeoutMs: options.timeoutMs ?? 10_000,
  });
  if (result.exitCode !== 0 || result.timedOut) return selectedEnv(env);
  const from = result.stdout.indexOf(`${start}\0`);
  const to = result.stdout.indexOf(`${end}\0`, from + start.length + 1);
  if (from < 0 || to < 0) return selectedEnv(env);
  const captured: Env = {};
  for (const record of result.stdout.slice(from + start.length + 1, to).split('\0')) {
    const separator = record.indexOf('=');
    if (separator > 0) captured[record.slice(0, separator)] = record.slice(separator + 1);
  }
  if (captured.PATH === undefined) return selectedEnv(env);
  return selectedEnv(captured);
}

/** Reads only global git settings; an incomplete identity leaves runner.json's default in place. */
export async function readGitIdentity(exec: Exec = defaultExec): Promise<RunnerConfig['commitIdentity'] | null> {
  const [name, email] = await Promise.all([
    exec(['git', 'config', '--global', 'user.name']),
    exec(['git', 'config', '--global', 'user.email']),
  ]);
  if ([name, email].some((result) => result.exitCode !== 0 || result.timedOut || !result.stdout.trim())) return null;
  return { name: name.stdout.trim(), email: email.stdout.trim() };
}

/** Creates a private home at its real path because Claude's guard compares canonical paths. */
export function canonicalHome(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  return realpathSync(path);
}

export function machineMismatch(config: Pick<RunnerConfig, 'machineId'>, machineId: string): string | null {
  return config.machineId === machineId ? null : 'this runner.json belongs to another Mac; run agflow runner setup';
}
