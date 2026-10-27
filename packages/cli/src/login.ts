import { hostname } from 'node:os';
import { verificationCode } from '@agflow/core';
import { type ParsedArgs, UsageError, stringFlag } from './args';
import { type Credentials, deleteCredentials, loadCredentials, saveCredentials } from './credentials';
import { type FetchFn, HubClient } from './hub-client';
import type { Io } from './io';
import { loadJoined } from './join';
import { configDir } from './paths';

export interface LoginDeps {
  fetch?: FetchFn | undefined;
  openUrl: (url: string) => void;
  sleep: (ms: number) => Promise<void>;
  host: string;
  dir: string;
  pollMs?: number;
  timeoutMs?: number;
}

export function randomLoginCode(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString('base64url');
}

/** Opens a URL in the default browser. Set AGFLOW_NO_BROWSER=1 to only print it. */
export function openInBrowser(url: string): void {
  if (process.env.AGFLOW_NO_BROWSER) return;
  try {
    Bun.spawn([process.platform === 'darwin' ? 'open' : 'xdg-open', url], { stdout: 'ignore', stderr: 'ignore' });
  } catch {
    // no browser available; the URL is printed anyway
  }
}

export async function login(hubUrl: string, io: Io, deps: LoginDeps): Promise<Credentials> {
  const baseUrl = hubUrl.replace(/\/+$/, '');
  const client = new HubClient({ baseUrl, fetch: deps.fetch });
  const config = await client.authConfig();
  const code = randomLoginCode();
  const url = `${baseUrl}/cli-login?code=${code}&label=${encodeURIComponent(deps.host)}`;
  io.out(
    `Approve this sign-in to the "${config.project}" hub in your browser:\n  ${url}\nThe page must show this code: ${verificationCode(code)}\n`,
  );
  deps.openUrl(url);
  const pollMs = deps.pollMs ?? 2000;
  const timeoutMs = deps.timeoutMs ?? 10 * 60_000;
  for (let waited = 0; waited <= timeoutMs; waited += pollMs) {
    const result = await client.pollCliLogin(code);
    if (result.status === 'approved') {
      const credentials: Credentials = { hubUrl: baseUrl, token: result.token, user: result.user };
      saveCredentials(credentials, deps.dir);
      io.out(`Signed in to ${baseUrl} as ${result.user}.\n`);
      return credentials;
    }
    if (result.status === 'expired') throw new Error('the approval expired; run agflow login again');
    await deps.sleep(pollMs);
  }
  throw new Error('timed out waiting for approval in the browser');
}

export async function statusReport(dir: string, fetchFn?: FetchFn): Promise<string> {
  const credentials = loadCredentials(dir);
  if (!credentials) return 'Not signed in. Run: agflow login --hub <url>\n';
  const client = new HubClient({ baseUrl: credentials.hubUrl, token: credentials.token, fetch: fetchFn });
  const [me, status] = await Promise.all([client.me(), client.status()]);
  const project = `${status.project.name} (${status.project.repo})${status.project.paused ? ' [paused]' : ''}`;
  const lead = status.lead ? `${status.lead.id} (${status.lead.user})` : 'none';
  const joined = loadJoined(dir);
  const repos =
    joined.length > 0 ? joined.map((repo) => `  ${repo.root} (${repo.role}; ${repo.vendors.join(', ')})`).join('\n') : '  none';
  return `Hub: ${credentials.hubUrl}\nSigned in as: ${me.user}\nProject: ${project}\nGoal version: v${status.goalVersion}\nLead: ${lead}\nJoined repositories:\n${repos}\n`;
}

export async function loginCommand(args: ParsedArgs, io: Io): Promise<number> {
  const hub = stringFlag(args, 'hub');
  if (!hub) throw new UsageError('agflow login needs --hub <url>');
  await login(hub, io, { openUrl: openInBrowser, sleep: (ms) => Bun.sleep(ms), host: hostname(), dir: configDir() });
  return 0;
}

export async function logoutCommand(_args: ParsedArgs, io: Io): Promise<number> {
  deleteCredentials(configDir());
  io.out('Signed out on this computer.\n');
  return 0;
}

export async function statusCommand(_args: ParsedArgs, io: Io): Promise<number> {
  const report = await statusReport(configDir());
  io.out(report);
  return report.startsWith('Not signed in') ? 1 : 0;
}
