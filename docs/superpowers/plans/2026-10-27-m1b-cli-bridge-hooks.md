# M1b: CLI, MCP Bridge and Hooks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `agflow` command that connects a person's live Claude Code and Codex chats to the hub. That means sign-in, `join`/`leave`, the MCP bridge with worker and lead tools, and the hooks that brief agents, deliver messages and wake idle chats.

**Architecture:**
- **New package.** `packages/cli` is a Bun program with no CLI framework.
- **Hub client.** A typed `HubClient` wraps the hub's REST API from plan M1a.
- **MCP bridge.** `agflow mcp` is a stdio MCP server built on the official TypeScript SDK. Each tool is a small function over `HubClient`, and claim and submit also run git.
- **Hooks.** `agflow hook <event>` reads the hook input JSON from stdin, calls the hub and prints the JSON reply. One command serves both vendors, because Claude Code and Codex use the same hook shapes for these events.
- **Join.** `agflow join` writes per-repository configuration that git never sees: Claude's local MCP scope plus `.claude/settings.local.json`, and Codex's `.codex/config.toml` plus `.codex/hooks.json`, listed in `.git/info/exclude`.
- **Hub additions.** The plan also adds two small things to the hub: a read-only inbox peek, and the browser page that approves a CLI sign-in.

**Tech Stack:** Bun 1.3.11, TypeScript 5.9.3, `@modelcontextprotocol/sdk` 1.32.2 (stdio server and client), zod 4.6.7, git 2.50, `bun test`.

**Depends on:** plan M1a, merged or present on the branch. All hub routes, types and schemas used here are defined in `packages/core` and `packages/hub` by M1a.

**Spec:** `docs/superpowers/specs/2026-10-26-agflow-design.md`, §6.5 (live chats), §6.6 (message delivery) and §11.1 (MCP tools); milestone M1 in §16.

---

## Conventions for every task

- Run all commands from the repository root.
- Use Bun only. Node on the developer machine is v16 and must not be used.
- External programs (`git`, `claude`, `open`) are started with argument arrays (`Bun.spawn`/`Bun.spawnSync`), never through a shell string.
- Hooks must never break a person's chat. On any error a hook prints `{}` (or, for `SessionStart`, a short explanation as context) and exits 0. Errors go to `<config dir>/hook.log`.
- Tests never touch the real `~/.config/agflow`. They set `AGFLOW_CONFIG_DIR` or pass a directory explicitly.
- Tests that need a hub use an in-process hub (`createContext` + `createApp` from `@agflow/hub`) through a `fetch` adapter. Only the end-to-end tests start real processes.
- Commit at the end of each task with the message shown. The repository's git identity is preconfigured; do not change it.

## Decisions for M1b

1. **Credentials file.** Credentials live in `<config dir>/credentials.json` with mode 0600, where the config dir defaults to `~/.config/agflow`. The spec's OS keychain is deferred: storing a token through `security add-generic-password` would put it on a process command line.
2. **CLI sign-in.** `agflow login` opens `<hub>/cli-login?code=…&label=<hostname>` and polls `/api/cli-login/poll`. The page shows a verification code derived from the login code, and so does the terminal. A person approves only when the two match. This protects against someone sending a ready-made approval link.
3. **Identity.** Identity follows M1a decision 2. The `SessionStart` hook registers the session and returns the brief with a hello code; the model calls `hello(code)`, and the bridge then sends `X-Agflow-Agent` on every call.
4. **Task branches.** `claim_task` creates the task branch in a worktree at `<repo>/.worktrees/agflow/<task id>`, starting from the task's existing branch on `origin` if there is one, otherwise from `origin/<default branch>`. `submit` refuses uncommitted changes, pushes the branch with the person's own git login, and sends the branch and head commit to the hub. `resume_claim` gives a chat that takes a claim over the same worktree in its own repository, and `submit` refuses unless the chat still holds the task and, for a task on an agflow branch, the worktree is in this repository (amended in the final review; see the notes under Tasks 6, 11 and 12).
5. **Waking idle chats.** For Claude Code, `join` also installs `agflow hook wait-inbox` as an `asyncRewake` hook on `SessionStart` and `Stop`. It polls the hub's read-only peek endpoint every 15 seconds. When messages arrive it exits 2, which wakes Claude with a short notice. Only one waiter runs per session, and it stops when its chat process ends. Codex has no equivalent, so Codex chats receive messages when a turn ends or a prompt is sent.
6. **Codex configuration** goes in `<repo>/.codex/config.toml` (a marked block) and `<repo>/.codex/hooks.json`. `join` refuses if git tracks either file. Codex loads project configuration only for trusted projects and runs new hooks only after `/hooks` review, so `join` prints both steps.
7. **Hook markers.** Every hook entry that `join` writes carries `"statusMessage": "agflow"`. That marker is how `leave` and a repeated `join` find agflow's entries without touching anyone else's.

## File structure

```
packages/core/src/cli-login.ts           verificationCode() shared by the CLI and the hub page
packages/core/src/types.ts               + LivePeek
packages/hub/src/live.ts                 + peekInbox()
packages/hub/src/http/agent-routes.ts    + GET /api/live/peek
packages/hub/src/http/cli-login-page.ts  GET /cli-login approval page
packages/hub/src/http/app.ts             mounts the page
packages/cli/
  package.json
  src/main.ts            command dispatch and help
  src/args.ts            argument parsing
  src/paths.ts           config directory
  src/credentials.ts     hub URL + token storage
  src/hub-client.ts      typed REST client
  src/login.ts           login / logout / status
  src/self.ts            how to run this CLI again (for configs)
  src/git.ts             git helpers
  src/join.ts            join / leave for Claude Code and Codex
  src/hooks.ts           hook handlers
  src/wait-inbox.ts      Claude wake-up waiter
  src/mcp/tools.ts       MCP tool definitions
  src/mcp/task-git.ts    worktree and push helpers for claim/submit
  src/mcp/server.ts      stdio MCP server
  test/fixture.ts        in-process hub fixture and temp git repos
  test/*.test.ts
scripts/smoke-cli.ts     end-to-end check with a real hub, real git and the real MCP transport
scripts/verify-real-clis.ts  optional check with the real claude and codex binaries
```

---

### Task 1: CLI package, argument parsing and help

**Files:**
- Create: `packages/cli/package.json`, `packages/cli/src/io.ts`, `packages/cli/src/args.ts`, `packages/cli/src/main.ts`
- Test: `packages/cli/test/args.test.ts`, `packages/cli/test/main.test.ts`

- [ ] **Step 1: Create `packages/cli/package.json`**

```json
{
  "name": "@agflow/cli",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": { "agflow": "./src/main.ts" },
  "dependencies": {
    "@agflow/core": "workspace:*",
    "@modelcontextprotocol/sdk": "1.32.2",
    "zod": "4.6.7"
  },
  "devDependencies": {
    "@agflow/hub": "workspace:*"
  }
}
```

- [ ] **Step 2: Install**

Run: `bun install`
Expected: exits 0; `bun.lock` now includes `@modelcontextprotocol/sdk`.

- [ ] **Step 3: Write the failing tests**

`packages/cli/test/args.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { UsageError, choiceFlag, parseArgs, stringFlag } from '../src/args';

describe('parseArgs', () => {
  test('splits positionals and flags', () => {
    expect(parseArgs(['hook', 'stop', '--vendor', 'codex', '--role=lead', '--verbose'])).toEqual({
      positional: ['hook', 'stop'],
      flags: { vendor: 'codex', role: 'lead', verbose: true },
    });
  });

  test('a flag followed by another flag is boolean', () => {
    expect(parseArgs(['--dry-run', '--hub', 'http://x']).flags).toEqual({ 'dry-run': true, hub: 'http://x' });
  });
});

describe('flag helpers', () => {
  test('stringFlag ignores boolean flags', () => {
    expect(stringFlag(parseArgs(['--hub']), 'hub')).toBeUndefined();
    expect(stringFlag(parseArgs(['--hub', 'u']), 'hub')).toBe('u');
  });

  test('choiceFlag validates and defaults', () => {
    expect(choiceFlag(parseArgs([]), 'role', ['worker', 'lead'], 'worker')).toBe('worker');
    expect(choiceFlag(parseArgs(['--role', 'lead']), 'role', ['worker', 'lead'], 'worker')).toBe('lead');
    expect(() => choiceFlag(parseArgs(['--role', 'boss']), 'role', ['worker', 'lead'], 'worker')).toThrow(UsageError);
  });
});
```

`packages/cli/test/main.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { AGFLOW_VERSION } from '@agflow/core';
import { main } from '../src/main';

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (text: string) => void out.push(text), err: (text: string) => void err.push(text) }, out, err };
}

describe('main', () => {
  test('prints the version', async () => {
    const { io, out } = capture();
    expect(await main(['version'], io)).toBe(0);
    expect(out.join('')).toBe(`${AGFLOW_VERSION}\n`);
  });

  test('prints help with no command', async () => {
    const { io, out } = capture();
    expect(await main([], io)).toBe(0);
    expect(out.join('')).toContain('agflow join');
  });

  test('an unknown command is a usage error', async () => {
    const { io, err } = capture();
    expect(await main(['fly'], io)).toBe(2);
    expect(err.join('')).toContain('unknown command "fly"');
  });
});
```

- [ ] **Step 4: Run them and watch them fail**

Run: `bun test packages/cli`
Expected: FAIL. `../src/args` and `../src/main` cannot be resolved.

- [ ] **Step 5: Create `packages/cli/src/io.ts`**

```ts
export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
}

export const stdio: Io = {
  out: (text) => {
    process.stdout.write(text);
  },
  err: (text) => {
    process.stderr.write(text);
  },
};
```

- [ ] **Step 6: Create `packages/cli/src/args.ts`**

```ts
export interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | true>;
}

export class UsageError extends Error {
  override name = 'UsageError';
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[arg.slice(2)] = next;
      i++;
    } else {
      flags[arg.slice(2)] = true;
    }
  }
  return { positional, flags };
}

export function stringFlag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags[name];
  return typeof value === 'string' ? value : undefined;
}

export function choiceFlag<T extends string>(args: ParsedArgs, name: string, choices: readonly T[], fallback: T): T {
  const value = stringFlag(args, name) ?? fallback;
  if (!(choices as readonly string[]).includes(value)) throw new UsageError(`--${name} must be one of: ${choices.join(', ')}`);
  return value as T;
}
```

- [ ] **Step 7: Create `packages/cli/src/main.ts`**

```ts
#!/usr/bin/env bun
import { AGFLOW_VERSION } from '@agflow/core';
import { type ParsedArgs, UsageError, parseArgs } from './args';
import { type Io, stdio } from './io';

export const HELP = `agflow ${AGFLOW_VERSION}

Usage:
  agflow login --hub <url>      Sign this computer in to an agflow hub
  agflow logout                 Forget this computer's sign-in
  agflow status                 Show the hub, your account and joined repositories
  agflow join [--role worker|lead] [--vendor claude|codex|both]
                                Connect Claude Code and/or Codex chats in this repository
  agflow leave                  Undo agflow join in this repository

Run by Claude Code and Codex, not by people:
  agflow mcp --vendor claude|codex
  agflow hook session-start|user-prompt-submit|stop|wait-inbox --vendor claude|codex [--role worker|lead]
`;

export type Command = (args: ParsedArgs, io: Io) => Promise<number>;

const commands: Record<string, Command> = {};

export async function main(argv: string[], io: Io = stdio): Promise<number> {
  const args = parseArgs(argv);
  const [name] = args.positional;
  try {
    if (name === undefined || name === 'help' || args.flags.help === true) {
      io.out(HELP);
      return 0;
    }
    if (name === 'version' || args.flags.version === true) {
      io.out(`${AGFLOW_VERSION}\n`);
      return 0;
    }
    const command = commands[name];
    if (!command) throw new UsageError(`unknown command "${name}"`);
    return await command(args, io);
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`agflow: ${error.message}\n\n${HELP}`);
      return 2;
    }
    io.err(`agflow: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
```

Later tasks add entries to `commands`.

- [ ] **Step 8: Run tests and the typecheck**

Run: `bun test packages/cli && bun run typecheck`
Expected: all tests pass; `tsc` exits 0.

- [ ] **Step 9: Commit**

```bash
git add packages/cli bun.lock
git commit -m "feat(cli): package scaffold, argument parsing and help" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Config directory and credentials

**Files:**
- Create: `packages/cli/src/paths.ts`, `packages/cli/src/credentials.ts`
- Test: `packages/cli/test/credentials.test.ts`

- [ ] **Step 1: Write the failing test `packages/cli/test/credentials.test.ts`**

```ts
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { credentialsPath, deleteCredentials, loadCredentials, saveCredentials } from '../src/credentials';
import { configDir } from '../src/paths';

const dir = () => mkdtempSync(join(tmpdir(), 'agflow-cfg-'));

describe('configDir', () => {
  test('defaults to ~/.config/agflow and honours AGFLOW_CONFIG_DIR', () => {
    expect(configDir({})).toBe(join(homedir(), '.config', 'agflow'));
    expect(configDir({ AGFLOW_CONFIG_DIR: '/tmp/x' })).toBe('/tmp/x');
  });
});

describe('credentials', () => {
  test('round-trip through a file only the owner can read', () => {
    const where = dir();
    saveCredentials({ hubUrl: 'https://hub.example', token: 't0ken', user: 'alice' }, where);
    expect(loadCredentials(where)).toEqual({ hubUrl: 'https://hub.example', token: 't0ken', user: 'alice' });
    expect(statSync(credentialsPath(where)).mode & 0o777).toBe(0o600);
  });

  test('missing or incomplete files mean signed out', () => {
    const where = dir();
    expect(loadCredentials(where)).toBeNull();
    saveCredentials({ hubUrl: 'h', token: '', user: 'alice' }, where);
    expect(loadCredentials(where)).toBeNull();
  });

  test('deleting signs out and is safe to repeat', () => {
    const where = dir();
    saveCredentials({ hubUrl: 'h', token: 't', user: 'alice' }, where);
    deleteCredentials(where);
    deleteCredentials(where);
    expect(loadCredentials(where)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test packages/cli/test/credentials.test.ts`
Expected: FAIL. `../src/credentials` cannot be resolved.

- [ ] **Step 3: Create `packages/cli/src/paths.ts`**

```ts
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Where the CLI keeps credentials, logs and state. AGFLOW_CONFIG_DIR overrides it (tests, multiple hubs). */
export function configDir(env: Record<string, string | undefined> = process.env): string {
  return env.AGFLOW_CONFIG_DIR ?? join(homedir(), '.config', 'agflow');
}
```

- [ ] **Step 4: Create `packages/cli/src/credentials.ts`**

```ts
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Credentials {
  hubUrl: string;
  token: string;
  user: string;
}

export function credentialsPath(dir: string): string {
  return join(dir, 'credentials.json');
}

export function saveCredentials(credentials: Credentials, dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = credentialsPath(dir);
  writeFileSync(path, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function loadCredentials(dir: string): Credentials | null {
  const path = credentialsPath(dir);
  if (!existsSync(path)) return null;
  const data = JSON.parse(readFileSync(path, 'utf8')) as Partial<Credentials>;
  if (!data.hubUrl || !data.token || !data.user) return null;
  return { hubUrl: data.hubUrl, token: data.token, user: data.user };
}

export function deleteCredentials(dir: string): void {
  rmSync(credentialsPath(dir), { force: true });
}
```

- [ ] **Step 5: Run tests and the typecheck**

Run: `bun test packages/cli && bun run typecheck`
Expected: all tests pass; `tsc` exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/cli
git commit -m "feat(cli): config directory and credentials file" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Hub additions: inbox peek and the CLI sign-in page

**Files:**
- Create: `packages/core/src/cli-login.ts`
- Modify: `packages/core/src/types.ts` (add `LivePeek`), `packages/core/src/index.ts`
- Modify: `packages/hub/src/live.ts` (add `peekInbox`), `packages/hub/src/http/agent-routes.ts` (add the route)
- Create: `packages/hub/src/http/cli-login-page.ts`
- Modify: `packages/hub/src/http/app.ts`
- Test: `packages/hub/test/peek.test.ts`, `packages/hub/test/http-cli-login-page.test.ts`

The waiter in Task 10 needs to know whether messages are waiting without marking them delivered, and without counting as agent activity (otherwise an idle chat's claim would never expire). The sign-in page is where a person approves `agflow login`.

- [ ] **Step 1: Write the failing tests**

`packages/hub/test/peek.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { getAgent, startLiveSession } from '../src/agents';
import { peekInbox } from '../src/live';
import { sendMessage, unreadFor } from '../src/messages';
import { createTestContext } from './helpers';
import { createTestHub } from './http-helpers';

describe('peekInbox', () => {
  test('counts unread messages without delivering them or touching the agent', () => {
    const { ctx, clock } = createTestContext();
    const { agent } = startLiveSession(ctx, 'alice', { vendor: 'claude', sessionId: 's1', role: 'worker' });
    sendMessage(ctx, { from: 'user:bob', to: `agent:${agent.id}`, body: 'Please also update the docs.' });
    clock.advance(5 * 60_000);
    expect(peekInbox(ctx, 'alice', 'claude', 's1')).toEqual({
      unread: 1,
      first: { from: 'user:bob' },
    });
    expect(unreadFor(ctx, getAgent(ctx, agent.id))).toHaveLength(1);
    expect(getAgent(ctx, agent.id).lastSeenAt).toBe(agent.lastSeenAt);
  });

  test('unknown sessions have nothing, and other people cannot peek', () => {
    const { ctx } = createTestContext();
    startLiveSession(ctx, 'alice', { vendor: 'claude', sessionId: 's1', role: 'worker' });
    expect(peekInbox(ctx, 'alice', 'codex', 'nope')).toEqual({ unread: 0, first: null });
    expect(() => peekInbox(ctx, 'bob', 'claude', 's1')).toThrow('another user');
  });

  test('is served at /api/live/peek', async () => {
    const hub = createTestHub();
    await hub.liveAgent('alice', 's1');
    const result = await hub.call('GET', '/api/live/peek?vendor=claude&sessionId=s1', { user: 'alice' });
    expect(result.json).toEqual({ unread: 0, first: null });
  });
});
```

`packages/hub/test/http-cli-login-page.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { verificationCode } from '@agflow/core';
import { createTestHub } from './http-helpers';

const code = 'AbCdEfGh12345678_-xyzXYZ0123456789';

describe('CLI sign-in page', () => {
  test('signed out in dev mode, it asks for a login and returns here afterwards', async () => {
    const hub = createTestHub();
    const result = await hub.call('GET', `/cli-login?code=${code}&label=laptop`);
    expect(result.status).toBe(200);
    expect(result.json).toContain('action="/auth/dev"');
    expect(result.json).toContain(`/cli-login?code=${code}&amp;label=laptop`);
  });

  test('signed out in GitHub mode, it sends people to GitHub sign-in', async () => {
    const hub = createTestHub({ auth: 'github', githubClientId: 'c', githubClientSecret: 's' });
    const result = await hub.call('GET', `/cli-login?code=${code}&label=laptop`);
    expect(result.status).toBe(302);
    expect(result.headers.get('location')).toStartWith('/auth/github?returnTo=');
  });

  test('signed in, it shows the verification code and escapes the label', async () => {
    const hub = createTestHub();
    const label = encodeURIComponent('<script>alert(1)</script>');
    const result = await hub.call('GET', `/cli-login?code=${code}&label=${label}`, { user: 'alice', via: 'web' });
    expect(result.json).toContain(verificationCode(code));
    expect(result.json).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(result.json).not.toContain('<script>alert(1)</script>');
    expect(result.json).toContain('/api/cli-login/approve');
  });

  test('malformed codes are rejected', async () => {
    const hub = createTestHub();
    expect((await hub.call('GET', '/cli-login?code=short')).status).toBe(400);
  });
});

describe('verificationCode', () => {
  test('is the first eight characters, upper-cased and grouped', () => {
    expect(verificationCode('abcd1234zzzz')).toBe('ABCD-1234');
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `bun test packages/hub/test/peek.test.ts packages/hub/test/http-cli-login-page.test.ts`
Expected: FAIL. `peekInbox` and `verificationCode` are not exported.

- [ ] **Step 3: Create `packages/core/src/cli-login.ts`**

```ts
/** A short code shown both in the terminal and on the approval page, so people approve only their own sign-in. */
export function verificationCode(code: string): string {
  const head = code.slice(0, 8).toUpperCase();
  return `${head.slice(0, 4)}-${head.slice(4, 8)}`;
}
```

- [ ] **Step 4: Add `LivePeek` to `packages/core/src/types.ts`** (append at the end of the file)

```ts
export interface LivePeek {
  unread: number;
  first: { from: string } | null;
}
```

- [ ] **Step 5: Export the new module from `packages/core/src/index.ts`** (add after the `format` export)

```ts
export * from './cli-login';
```

- [ ] **Step 6: Add `peekInbox` to `packages/hub/src/live.ts`**

Add `type LivePeek` to the existing `@agflow/core` import, then append:

```ts
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
```

- [ ] **Step 7: Serve it from `packages/hub/src/http/agent-routes.ts`**

Change the `../live` import to:

```ts
import { liveInbox, peekInbox, stopCheck } from '../live';
```

Add inside `mountAgentRoutes`, after the `/api/live/inbox` route:

```ts
  app.get('/api/live/peek', (c) => {
    const p = principal(c);
    const query = readQuery(c, LiveSessionQuerySchema);
    return c.json(peekInbox(ctx, p.user, query.vendor, query.sessionId));
  });
```

- [ ] **Step 8: Create `packages/hub/src/http/cli-login-page.ts`**

```ts
import { verificationCode } from '@agflow/core';
import type { HubContext } from '../context';
import { badRequest } from '../errors';
import type { App } from './app';

const CODE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export function escapeHtml(text: string): string {
  const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return text.replace(/[&<>"']/g, (char) => entities[char] as string);
}

/** JSON that is safe to place inside an inline script element. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)} · agflow</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem}code{font-size:1.4rem;letter-spacing:.1em}button,input{font:inherit;padding:.3rem .8rem}</style></head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`;
}

export function mountCliLoginPage(app: App, ctx: HubContext): void {
  app.get('/cli-login', (c) => {
    const code = c.req.query('code') ?? '';
    const label = (c.req.query('label') ?? 'a computer').slice(0, 200);
    if (!CODE_PATTERN.test(code)) throw badRequest('this sign-in link is malformed; run agflow login again');
    const self = `/cli-login?code=${encodeURIComponent(code)}&label=${encodeURIComponent(label)}`;
    const p = c.get('principal');
    if (!p || p.via !== 'web' || p.agent) {
      if (ctx.config.auth === 'github') return c.redirect(`/auth/github?returnTo=${encodeURIComponent(self)}`);
      return c.html(
        page(
          'Sign in to agflow',
          `<form method="get" action="/auth/dev"><input type="hidden" name="returnTo" value="${escapeHtml(self)}"><p><label>GitHub login <input name="user" required autofocus></label></p><button type="submit">Sign in</button></form>`,
        ),
      );
    }
    return c.html(
      page(
        'Approve CLI sign-in',
        `<p>Allow <b>${escapeHtml(label)}</b> to use agflow as <b>${escapeHtml(p.user)}</b>?</p>
<p>Approve only if your terminal shows this code:</p>
<p><code>${escapeHtml(verificationCode(code))}</code></p>
<button id="approve" type="button">Approve</button>
<p id="result" role="status"></p>
<script>
const code = ${scriptJson(code)};
const label = ${scriptJson(label)};
document.getElementById('approve').addEventListener('click', async () => {
  const result = document.getElementById('result');
  const response = await fetch('/api/cli-login/approve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, label }),
  });
  const data = await response.json().catch(() => ({}));
  result.textContent = response.ok
    ? 'Approved. You can close this tab and return to the terminal.'
    : 'Approval failed: ' + (data.message || response.status);
});
</script>`,
      ),
    );
  });
}
```

- [ ] **Step 9: Mount the page in `packages/hub/src/http/app.ts`**

Add the import:

```ts
import { mountCliLoginPage } from './cli-login-page';
```

Add right after `mountEventRoutes(app, ctx);` (before the static UI line):

```ts
  mountCliLoginPage(app, ctx);
```

- [ ] **Step 10: Run tests and the typecheck**

Run: `bun test && bun run typecheck`
Expected: all tests pass; `tsc` exits 0.

- [ ] **Step 11: Commit**

```bash
git add packages/core packages/hub
git commit -m "feat(hub): read-only inbox peek and the CLI sign-in approval page" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Typed hub client and the test fixture

**Files:**
- Create: `packages/cli/src/hub-client.ts`, `packages/cli/test/fixture.ts`
- Test: `packages/cli/test/hub-client.test.ts`

- [ ] **Step 1: Create the fixture `packages/cli/test/fixture.ts`**

```ts
import type { AgentRole, Vendor } from '@agflow/core';
import { startLiveSession } from '@agflow/hub/src/agents';
import { createSession } from '@agflow/hub/src/auth';
import { type HubConfig, type HubContext, createContext } from '@agflow/hub/src/context';
import { type App, createApp } from '@agflow/hub/src/http/app';
import { type FetchFn, HubClient } from '../src/hub-client';

export const HUB_URL = 'http://hub.test';

export interface LiveAgent {
  agentId: string;
  sessionId: string;
  helloCode: string;
  client: HubClient;
}

export interface HubFixture {
  ctx: HubContext;
  app: App;
  clock: { t: number };
  fetch: FetchFn;
  tokenFor(user: string, kind?: 'cli' | 'web'): string;
  client(user?: string, agentId?: string): HubClient;
  /** Registers a live session the way the SessionStart hook does; the returned client is already bound. */
  liveAgent(user?: string, role?: AgentRole, vendor?: Vendor): LiveAgent;
}

let sessions = 0;

export function hubFixture(overrides: Partial<HubConfig> = {}): HubFixture {
  const clock = { t: Date.UTC(2026, 9, 27, 12, 0, 0) };
  const config: HubConfig = {
    publicUrl: HUB_URL,
    auth: 'dev',
    allowedUsers: ['alice', 'bob'],
    projectName: 'demo',
    projectRepo: 'https://github.com/acme/demo',
    leaseMs: 2 * 60 * 60_000,
    reminderMs: 30 * 60_000,
    maxOpenTasks: 200,
    maxTasksPerHour: 60,
    secureCookies: false,
    ...overrides,
  };
  const ctx = createContext({ dbPath: ':memory:', config, now: () => clock.t });
  const app = createApp(ctx);
  const fetchFn: FetchFn = async (input, init) => app.request(input instanceof Request ? input : String(input), init);
  const tokens = new Map<string, string>();
  const tokenFor = (user: string, kind: 'cli' | 'web' = 'cli') => {
    const key = `${user}:${kind}`;
    let token = tokens.get(key);
    if (!token) {
      token = createSession(ctx, user, kind);
      tokens.set(key, token);
    }
    return token;
  };
  const client = (user = 'alice', agentId?: string) =>
    new HubClient({ baseUrl: HUB_URL, token: tokenFor(user), agentId, fetch: fetchFn });
  const liveAgent = (user = 'alice', role: AgentRole = 'worker', vendor: Vendor = 'claude'): LiveAgent => {
    sessions += 1;
    const sessionId = `session-${sessions}`;
    const started = startLiveSession(ctx, user, { vendor, sessionId, role });
    return { agentId: started.agent.id, sessionId, helloCode: started.helloCode, client: client(user, started.agent.id) };
  };
  return { ctx, app, clock, fetch: fetchFn, tokenFor, client, liveAgent };
}

/** Extracts the hello code from a brief. */
export function helloCodeIn(brief: string): string {
  return brief.match(/code "([A-Z2-9]{6})"/)?.[1] ?? '';
}
```

- [ ] **Step 2: Write the failing test `packages/cli/test/hub-client.test.ts`**

```ts
import { describe, expect, test } from 'bun:test';
import { NewTaskSchema } from '@agflow/core';
import { createTasks } from '@agflow/hub/src/tasks';
import { HubClient, HubClientError } from '../src/hub-client';
import { HUB_URL, helloCodeIn, hubFixture } from './fixture';

const task = (title: string) =>
  NewTaskSchema.parse({ title, objective: 'o', acceptance: [{ id: 'A1', assertion: 'works' }] });

describe('HubClient', () => {
  test('reads public and signed-in endpoints', async () => {
    const hub = hubFixture();
    const anonymous = new HubClient({ baseUrl: `${HUB_URL}/`, fetch: hub.fetch });
    expect(await anonymous.authConfig()).toEqual({ mode: 'dev', project: 'demo' });
    expect((await hub.client('alice').me()).user).toBe('alice');
  });

  test('turns hub errors into HubClientError with status and code', async () => {
    const hub = hubFixture();
    const anonymous = new HubClient({ baseUrl: HUB_URL, fetch: hub.fetch });
    const error = await anonymous.me().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HubClientError);
    expect(error).toMatchObject({ status: 401, code: 'unauthorized' });
  });

  test('an unreachable hub is reported clearly', async () => {
    const broken = new HubClient({
      baseUrl: 'http://hub.test',
      fetch: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    await expect(broken.authConfig()).rejects.toThrow('cannot reach the agflow hub at http://hub.test');
  });

  test('works as an agent once the agent id is set', async () => {
    const hub = hubFixture();
    createTasks(hub.ctx, [task('Parser')], 'user:alice');
    const started = await hub.client('alice').sessionStart({ vendor: 'claude', sessionId: 'abc', role: 'worker' });
    const client = hub.client('alice');
    const hello = await client.hello(helloCodeIn(started.brief));
    client.agentId = hello.agentId;
    expect((await client.claim('T-1', 'agflow/T-1-parser')).task).toMatchObject({ status: 'claimed', branch: 'agflow/T-1-parser' });
    expect((await client.progress('T-1', 'started')).task.status).toBe('working');
    expect((await client.submit('T-1', { summary: 'done', evidence: [] })).task.status).toBe('submitted');
    expect(await client.peek('claude', 'abc')).toEqual({ unread: 0, first: null });
  });

  test('lead calls are rejected for workers', async () => {
    const hub = hubFixture();
    const worker = hub.liveAgent('bob');
    const error = await worker.client.createTasks([task('x')]).catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 403 });
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `bun test packages/cli/test/hub-client.test.ts`
Expected: FAIL. `../src/hub-client` cannot be resolved.

- [ ] **Step 4: Create `packages/cli/src/hub-client.ts`**

```ts
import type {
  Agent,
  AgentRole,
  GoalNote,
  GoalVersion,
  HubEvent,
  HubStatus,
  LiveInbox,
  LivePeek,
  Message,
  NewTaskInput,
  SearchResult,
  StopCheckResult,
  Task,
  TaskDetail,
  TaskPatch,
  TaskStatus,
  Vendor,
} from '@agflow/core';

export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class HubClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HubClientError';
  }
}

export interface HubClientOptions {
  baseUrl: string;
  token?: string | undefined;
  agentId?: string | undefined;
  fetch?: FetchFn | undefined;
  timeoutMs?: number | undefined;
}

export type CliLoginPoll = { status: 'pending' } | { status: 'expired' } | { status: 'approved'; token: string; user: string };

export interface SubmitBody {
  summary: string;
  evidence: string[];
  branch?: string | undefined;
  headSha?: string | undefined;
}

export interface MessageBody {
  to: string;
  body: string;
  taskId?: string | undefined;
  replyTo?: number | undefined;
}

const q = encodeURIComponent;

export class HubClient {
  readonly baseUrl: string;
  agentId: string | undefined;
  private readonly token: string | undefined;
  private readonly fetchFn: FetchFn;
  private readonly timeoutMs: number;

  constructor(options: HubClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.agentId = options.agentId;
    this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (this.agentId) headers['x-agflow-agent'] = this.agentId;
    if (body !== undefined) headers['content-type'] = 'application/json';
    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new HubClientError(0, 'unreachable', `cannot reach the agflow hub at ${this.baseUrl}: ${reason}`);
    }
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!response.ok) {
      const error = (json ?? {}) as { error?: string; message?: string };
      throw new HubClientError(
        response.status,
        error.error ?? 'http_error',
        error.message ?? `${method} ${path} failed with HTTP ${response.status}`,
      );
    }
    return json as T;
  }

  // Sign-in
  authConfig() {
    return this.request<{ mode: 'github' | 'dev'; project: string }>('GET', '/api/auth-config');
  }
  me() {
    return this.request<{ user: string; via: 'web' | 'cli'; agent: Agent | null }>('GET', '/api/me');
  }
  pollCliLogin(code: string) {
    return this.request<CliLoginPoll>('GET', `/api/cli-login/poll?code=${q(code)}`);
  }

  // Live sessions (hooks)
  sessionStart(input: { vendor: Vendor; sessionId: string; role: AgentRole; label?: string | undefined }) {
    return this.request<{ agentId: string; role: AgentRole; brief: string }>('POST', '/api/live/session-start', input);
  }
  hello(code: string) {
    return this.request<{ agentId: string; role: AgentRole; vendor: Vendor }>('POST', '/api/live/hello', { code });
  }
  liveInbox(vendor: Vendor, sessionId: string) {
    return this.request<LiveInbox>('GET', `/api/live/inbox?vendor=${vendor}&sessionId=${q(sessionId)}`);
  }
  peek(vendor: Vendor, sessionId: string) {
    return this.request<LivePeek>('GET', `/api/live/peek?vendor=${vendor}&sessionId=${q(sessionId)}`);
  }
  stopCheck(input: { vendor: Vendor; sessionId: string; stopHookActive: boolean }) {
    return this.request<StopCheckResult>('POST', '/api/live/stop-check', input);
  }

  // Reading
  status() {
    return this.request<HubStatus>('GET', '/api/status');
  }
  goal() {
    return this.request<{ current: GoalVersion | null; notes: GoalNote[] }>('GET', '/api/goal');
  }
  tasks(status?: TaskStatus[]) {
    const query = status && status.length > 0 ? `?status=${status.join(',')}` : '';
    return this.request<{ tasks: Task[] }>('GET', `/api/tasks${query}`);
  }
  task(id: string) {
    return this.request<TaskDetail>('GET', `/api/tasks/${q(id)}`);
  }
  brief() {
    return this.request<{ brief: string }>('GET', '/api/brief');
  }
  search(query: string) {
    return this.request<SearchResult>('GET', `/api/search?q=${q(query)}`);
  }
  events(after = 0, limit = 50) {
    return this.request<{ events: HubEvent[] }>('GET', `/api/events?after=${after}&limit=${limit}`);
  }

  // Messages
  takeInbox() {
    return this.request<{ messages: Message[] }>('POST', '/api/inbox');
  }
  ack(ids: number[]) {
    return this.request<{ ok: true }>('POST', '/api/inbox/ack', { ids });
  }
  send(body: MessageBody) {
    return this.request<{ message: Message }>('POST', '/api/messages', body);
  }

  // Working on a task
  claim(id: string, branch?: string) {
    return this.request<{ task: Task }>('POST', `/api/tasks/${q(id)}/claim`, { branch });
  }
  resumeClaim(id: string) {
    return this.request<{ task: Task }>('POST', `/api/tasks/${q(id)}/resume-claim`);
  }
  progress(id: string, note: string) {
    return this.request<{ task: Task }>('POST', `/api/tasks/${q(id)}/progress`, { note });
  }
  handoff(id: string, note: string) {
    return this.request<{ ok: true }>('POST', `/api/tasks/${q(id)}/handoff`, { note });
  }
  submit(id: string, body: SubmitBody) {
    return this.request<{ task: Task }>('POST', `/api/tasks/${q(id)}/submit`, body);
  }
  block(id: string, reason: string) {
    return this.request<{ task: Task }>('POST', `/api/tasks/${q(id)}/block`, { reason });
  }
  impossible(id: string, evidence: string) {
    return this.request<{ task: Task }>('POST', `/api/tasks/${q(id)}/impossible`, { evidence });
  }
  release(id: string, reason: string) {
    return this.request<{ task: Task }>('POST', `/api/tasks/${q(id)}/release`, { reason });
  }

  // Lead
  createTasks(tasks: NewTaskInput[]) {
    return this.request<{ tasks: Task[] }>('POST', '/api/tasks', { tasks });
  }
  updateTask(id: string, patch: TaskPatch) {
    return this.request<{ task: Task }>('PATCH', `/api/tasks/${q(id)}`, patch);
  }
  cancel(id: string, reason: string) {
    return this.request<{ task: Task }>('POST', `/api/tasks/${q(id)}/cancel`, { reason });
  }
  accept(id: string, note?: string) {
    return this.request<{ task: Task }>('POST', `/api/tasks/${q(id)}/accept`, { note });
  }
  reject(id: string, feedback: string) {
    return this.request<{ task: Task }>('POST', `/api/tasks/${q(id)}/reject`, { feedback });
  }
  unblock(id: string, note?: string) {
    return this.request<{ task: Task }>('POST', `/api/tasks/${q(id)}/unblock`, { note });
  }
  markMerged(id: string, sha?: string) {
    return this.request<{ task: Task }>('POST', `/api/tasks/${q(id)}/merged`, { sha });
  }
  addGoalNote(text: string) {
    return this.request<GoalNote>('POST', '/api/goal/notes', { text });
  }
}
```

- [ ] **Step 5: Run tests and the typecheck**

Run: `bun test packages/cli && bun run typecheck`
Expected: all tests pass; `tsc` exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/cli
git commit -m "feat(cli): typed hub client and in-process hub test fixture" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `agflow login`, `logout` and `status`

**Files:**
- Create: `packages/cli/src/login.ts`
- Modify: `packages/cli/src/main.ts`
- Test: `packages/cli/test/login.test.ts`

- [ ] **Step 1: Write the failing test `packages/cli/test/login.test.ts`**

```ts
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verificationCode } from '@agflow/core';
import { approveCliLogin } from '@agflow/hub/src/auth';
import { loadCredentials, saveCredentials } from '../src/credentials';
import { login, statusReport } from '../src/login';
import { HUB_URL, hubFixture } from './fixture';

const tempDir = () => mkdtempSync(join(tmpdir(), 'agflow-cfg-'));
const silent = { out: () => {}, err: () => {} };

describe('login', () => {
  test('waits for approval in the browser and saves the credentials', async () => {
    const hub = hubFixture();
    const dir = tempDir();
    const printed: string[] = [];
    let opened = '';
    const credentials = await login(`${HUB_URL}/`, { out: (t) => void printed.push(t), err: () => {} }, {
      fetch: hub.fetch,
      dir,
      host: 'laptop',
      pollMs: 1,
      timeoutMs: 1000,
      openUrl: (url) => {
        opened = url;
      },
      sleep: async () => {
        const code = new URL(opened).searchParams.get('code') ?? '';
        approveCliLogin(hub.ctx, code, 'alice', 'laptop');
      },
    });
    const code = new URL(opened).searchParams.get('code') ?? '';
    expect(new URL(opened).pathname).toBe('/cli-login');
    expect(new URL(opened).searchParams.get('label')).toBe('laptop');
    expect(printed.join('')).toContain(verificationCode(code));
    expect(credentials).toMatchObject({ hubUrl: HUB_URL, user: 'alice' });
    expect(loadCredentials(dir)?.token).toBe(credentials.token);
  });

  test('an expired approval ends the login', async () => {
    const hub = hubFixture();
    let opened = '';
    const attempt = login(HUB_URL, silent, {
      fetch: hub.fetch,
      dir: tempDir(),
      host: 'laptop',
      pollMs: 1,
      timeoutMs: 1000,
      openUrl: (url) => {
        opened = url;
      },
      sleep: async () => {
        approveCliLogin(hub.ctx, new URL(opened).searchParams.get('code') ?? '', 'alice');
        hub.clock.t += 11 * 60_000;
      },
    });
    await expect(attempt).rejects.toThrow('expired');
  });

  test('gives up after the timeout', async () => {
    const hub = hubFixture();
    const attempt = login(HUB_URL, silent, {
      fetch: hub.fetch,
      dir: tempDir(),
      host: 'laptop',
      pollMs: 1,
      timeoutMs: 3,
      openUrl: () => {},
      sleep: async () => {},
    });
    await expect(attempt).rejects.toThrow('timed out');
  });
});

describe('status', () => {
  test('reports the hub, account and project', async () => {
    const hub = hubFixture();
    const dir = tempDir();
    saveCredentials({ hubUrl: HUB_URL, token: hub.tokenFor('alice'), user: 'alice' }, dir);
    const report = await statusReport(dir, hub.fetch);
    expect(report).toContain(`Hub: ${HUB_URL}`);
    expect(report).toContain('Signed in as: alice');
    expect(report).toContain('Project: demo');
  });

  test('says so when signed out', async () => {
    expect(await statusReport(tempDir())).toContain('Not signed in');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test packages/cli/test/login.test.ts`
Expected: FAIL. `../src/login` cannot be resolved.

- [ ] **Step 3: Create `packages/cli/src/login.ts`**

```ts
import { hostname } from 'node:os';
import { verificationCode } from '@agflow/core';
import { type ParsedArgs, UsageError, stringFlag } from './args';
import { type Credentials, deleteCredentials, loadCredentials, saveCredentials } from './credentials';
import { type FetchFn, HubClient } from './hub-client';
import type { Io } from './io';
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
  return `Hub: ${credentials.hubUrl}\nSigned in as: ${me.user}\nProject: ${project}\nGoal version: v${status.goalVersion}\nLead: ${lead}\n`;
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
```

- [ ] **Step 4: Register the commands in `packages/cli/src/main.ts`**

Add the import:

```ts
import { loginCommand, logoutCommand, statusCommand } from './login';
```

Replace `const commands: Record<string, Command> = {};` with:

```ts
const commands: Record<string, Command> = {
  login: loginCommand,
  logout: logoutCommand,
  status: statusCommand,
};
```

- [ ] **Step 5: Run tests and the typecheck**

Run: `bun test packages/cli && bun run typecheck`
Expected: all tests pass; `tsc` exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/cli
git commit -m "feat(cli): login with browser approval, logout and status" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Running this CLI again, and git helpers

**Files:**
- Create: `packages/cli/src/self.ts`, `packages/cli/src/git.ts`
- Modify: `packages/cli/test/fixture.ts` (add `run` and `tempRepo`)
- Test: `packages/cli/test/self-git.test.ts`

- [ ] **Step 1: Add git fixtures to `packages/cli/test/fixture.ts`**

Add these imports at the top:

```ts
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
```

Append:

```ts
export function run(cmd: string[], cwd: string): string {
  const result = Bun.spawnSync(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(`${cmd.join(' ')} failed: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

/** A bare "origin" repository and a clone with one commit on main, pushed. */
export function tempRepo(): { dir: string; origin: string; root: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agflow-git-')));
  const origin = join(dir, 'origin.git');
  const root = join(dir, 'work');
  run(['git', 'init', '--quiet', '--bare', '-b', 'main', origin], dir);
  run(['git', 'clone', '--quiet', origin, root], dir);
  run(['git', 'config', 'user.email', 'dev@example.com'], root);
  run(['git', 'config', 'user.name', 'Dev'], root);
  writeFileSync(join(root, 'README.md'), '# demo\n');
  run(['git', 'add', 'README.md'], root);
  run(['git', 'commit', '--quiet', '-m', 'init'], root);
  run(['git', 'push', '--quiet', '-u', 'origin', 'main'], root);
  return { dir, origin, root };
}
```

- [ ] **Step 2: Write the failing test `packages/cli/test/self-git.test.ts`**

```ts
import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { addExclude, defaultBranch, git, gitOk, isTracked, removeExclude, repoRoot, slugify } from '../src/git';
import { selfCommand, shellCommand, shellQuote } from '../src/self';
import { run, tempRepo } from './fixture';

describe('selfCommand', () => {
  test('runs main.ts with Bun when started from source', () => {
    expect(selfCommand('/repo/packages/cli/src/self.ts', '/usr/local/bin/bun')).toEqual({
      command: '/usr/local/bin/bun',
      args: ['/repo/packages/cli/src/main.ts'],
    });
  });

  test('runs the binary itself when compiled', () => {
    expect(selfCommand('/$bunfs/root/agflow', '/Users/a/.local/bin/agflow')).toEqual({
      command: '/Users/a/.local/bin/agflow',
      args: [],
    });
  });

  test('shell quoting leaves safe words alone and quotes the rest', () => {
    expect(shellQuote('/usr/bin/bun')).toBe('/usr/bin/bun');
    expect(shellQuote('/My Apps/agflow')).toBe("'/My Apps/agflow'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(shellCommand(['a b', 'c'])).toBe("'a b' c");
  });
});

describe('git helpers', () => {
  test('finds the repository root and the default branch', () => {
    const repo = tempRepo();
    mkdirSync(join(repo.root, 'src'));
    expect(repoRoot(join(repo.root, 'src'))).toBe(repo.root);
    expect(repoRoot(repo.dir)).toBeNull();
    expect(defaultBranch(repo.root)).toBe('main');
  });

  test('knows which files are tracked', () => {
    const repo = tempRepo();
    writeFileSync(join(repo.root, 'local.txt'), 'x');
    expect(isTracked(repo.root, 'README.md')).toBe(true);
    expect(isTracked(repo.root, 'local.txt')).toBe(false);
  });

  test('exclude entries are added once and can be removed', () => {
    const repo = tempRepo();
    addExclude(repo.root, '.worktrees/');
    addExclude(repo.root, '.worktrees/');
    const file = join(repo.root, '.git', 'info', 'exclude');
    expect(readFileSync(file, 'utf8').split('\n').filter((line) => line === '.worktrees/')).toHaveLength(1);
    removeExclude(repo.root, '.worktrees/');
    expect(readFileSync(file, 'utf8')).not.toContain('.worktrees/');
  });

  test('git returns failures and gitOk throws them', () => {
    const repo = tempRepo();
    expect(git(repo.root, ['rev-parse', '--verify', '--quiet', 'refs/heads/nope']).code).not.toBe(0);
    expect(() => gitOk(repo.root, ['checkout', 'nope'])).toThrow('git checkout nope failed');
    expect(gitOk(repo.root, ['rev-parse', 'HEAD'])).toBe(run(['git', 'rev-parse', 'HEAD'], repo.root));
  });

  test('slugify makes short branch-safe names', () => {
    expect(slugify('Add OAuth 2.0 login (GitHub)!')).toBe('add-oauth-2-0-login-github');
    expect(slugify('***')).toBe('task');
    expect(slugify('x'.repeat(80))).toHaveLength(40);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `bun test packages/cli/test/self-git.test.ts`
Expected: FAIL. `../src/git` and `../src/self` cannot be resolved.

- [ ] **Step 4: Create `packages/cli/src/self.ts`**

```ts
import { dirname, join } from 'node:path';

export interface SelfCommand {
  command: string;
  args: string[];
}

/** How to start this CLI again: the compiled binary itself, or Bun running main.ts from source. */
export function selfCommand(modulePath: string = import.meta.path, binary: string = process.execPath): SelfCommand {
  if (modulePath.startsWith('/$bunfs/') || modulePath.startsWith('B:/~BUN/')) return { command: binary, args: [] };
  return { command: binary, args: [join(dirname(modulePath), 'main.ts')] };
}

/** Quotes one argument for a POSIX shell (for configs that accept only a command string). */
export function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_\/.:=@%+-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function shellCommand(parts: string[]): string {
  return parts.map(shellQuote).join(' ');
}
```

- [ ] **Step 5: Create `packages/cli/src/git.ts`**

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class GitError extends Error {
  override name = 'GitError';
}

/** Runs git with an argument vector (no shell). Credential prompts are disabled so calls never hang. */
export function git(cwd: string, args: string[]): GitResult {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return { code: result.exitCode, stdout: result.stdout.toString().trim(), stderr: result.stderr.toString().trim() };
}

export function gitOk(cwd: string, args: string[]): string {
  const result = git(cwd, args);
  if (result.code !== 0) throw new GitError(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

export function repoRoot(cwd: string): string | null {
  const result = git(cwd, ['rev-parse', '--show-toplevel']);
  return result.code === 0 ? result.stdout : null;
}

export function defaultBranch(root: string): string {
  const result = git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  return result.code === 0 && result.stdout.startsWith('origin/') ? result.stdout.slice('origin/'.length) : 'main';
}

export function isTracked(root: string, path: string): boolean {
  return git(root, ['ls-files', '--error-unmatch', path]).code === 0;
}

function excludeFile(root: string): string {
  const path = gitOk(root, ['rev-parse', '--git-path', 'info/exclude']);
  return isAbsolute(path) ? path : join(root, path);
}

/** Adds a pattern to .git/info/exclude (local ignore rules that are never committed). */
export function addExclude(root: string, pattern: string): void {
  const file = excludeFile(root);
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (existing.split('\n').includes(pattern)) return;
  mkdirSync(dirname(file), { recursive: true });
  const separator = existing === '' || existing.endsWith('\n') ? '' : '\n';
  writeFileSync(file, `${existing}${separator}${pattern}\n`);
}

export function removeExclude(root: string, pattern: string): void {
  const file = excludeFile(root);
  if (!existsSync(file)) return;
  const kept = readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== pattern);
  writeFileSync(file, kept.join('\n'));
}

export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug || 'task';
}
```

> **Deviation from the snippet above (found in the final review):** `defaultBranch` does not stop at `origin/HEAD`. `git clone` sets it, but a repository made with `git init` and pushed does not have it, and with only that and the hard-coded `main`, `claim_task` could never succeed in such a repository when its branch is `master`. It returns the first usable name from `origin/HEAD`, then `git ls-remote --symref origin HEAD`, then the checked-out branch, and only then `main`. A name that starts with `-` or is not a valid ref name is skipped, because a remote reports its HEAD in its own words and the name is passed on to `git fetch origin <name>`. Tests: `defaultBranch` in `packages/cli/test/self-git.test.ts`, and `claim_task in a repository whose default branch is not main` in `packages/cli/test/tools-git.test.ts`.

- [ ] **Step 6: Run tests and the typecheck**

Run: `bun test packages/cli && bun run typecheck`
Expected: all tests pass; `tsc` exits 0.

- [ ] **Step 7: Commit**

```bash
git add packages/cli
git commit -m "feat(cli): self-invocation and git helpers" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: `join` and `leave` for Claude Code

**Files:**
- Create: `packages/cli/src/join.ts`
- Test: `packages/cli/test/join-claude.test.ts`

What `join` writes for Claude Code:
- **MCP server.** The agflow MCP server is added in Claude's private local scope, which is stored in `~/.claude.json` under this repository's path. It is added with `claude mcp add --scope local`.
- **Hooks.** Hooks go in `.claude/settings.local.json`, which `join` also lists in `.git/info/exclude`. Each hook uses Claude's no-shell form (`command` plus an `args` array), so paths need no quoting:
  - `SessionStart`: the session-start hook, plus the asynchronous waiter.
  - `UserPromptSubmit`: the user-prompt-submit hook.
  - `Stop`: the stop hook, plus the asynchronous waiter.
- **Marker.** Every handler `join` writes carries `"statusMessage": "agflow"`.

- [ ] **Step 1: Write the failing test `packages/cli/test/join-claude.test.ts`**

```ts
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLAUDE_SETTINGS, type Runner, claudeHooks, joinClaude, leaveClaude } from '../src/join';
import { run, tempRepo } from './fixture';

const self = { command: '/usr/local/bin/bun', args: ['/repo/packages/cli/src/main.ts'] };

function fakeClaude() {
  const calls: string[][] = [];
  const runner: Runner = (cmd) => {
    calls.push(cmd);
    return { code: 0, output: '' };
  };
  return { calls, runner };
}

const settingsOf = (root: string) => JSON.parse(readFileSync(join(root, CLAUDE_SETTINGS), 'utf8'));

describe('claudeHooks', () => {
  test('uses command plus args with the role, and an asynchronous waiter', () => {
    const hooks = claudeHooks(self, 'lead');
    const start = hooks.SessionStart?.[0]?.hooks ?? [];
    expect(start[0]).toMatchObject({
      type: 'command',
      command: '/usr/local/bin/bun',
      args: ['/repo/packages/cli/src/main.ts', 'hook', 'session-start', '--vendor', 'claude', '--role', 'lead'],
      statusMessage: 'agflow',
    });
    expect(start[1]).toMatchObject({ asyncRewake: true });
    expect(hooks.Stop?.[0]?.hooks.map((h) => (h.args as string[])[2])).toEqual(['stop', 'wait-inbox']);
  });
});

describe('joinClaude and leaveClaude', () => {
  test('adds the MCP server in local scope and the hooks, keeping other settings', () => {
    const repo = tempRepo();
    mkdirSync(join(repo.root, '.claude'));
    writeFileSync(
      join(repo.root, CLAUDE_SETTINGS),
      JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } }),
    );
    const claude = fakeClaude();
    joinClaude(repo.root, self, 'worker', claude.runner);
    expect(claude.calls).toEqual([
      ['claude', 'mcp', 'remove', '--scope', 'local', 'agflow'],
      ['claude', 'mcp', 'add', '--scope', 'local', 'agflow', '--', '/usr/local/bin/bun', '/repo/packages/cli/src/main.ts', 'mcp', '--vendor', 'claude'],
    ]);
    const settings = settingsOf(repo.root);
    expect(settings.model).toBe('opus');
    expect(settings.hooks.Stop).toHaveLength(2);
    expect(settings.hooks.Stop[0].hooks[0].command).toBe('say done');
    expect(readFileSync(join(repo.root, '.git', 'info', 'exclude'), 'utf8')).toContain(CLAUDE_SETTINGS);
    expect(run(['git', 'status', '--porcelain'], repo.root)).toBe('');
  });

  test('joining twice does not duplicate hooks', () => {
    const repo = tempRepo();
    const claude = fakeClaude();
    joinClaude(repo.root, self, 'worker', claude.runner);
    joinClaude(repo.root, self, 'lead', claude.runner);
    const hooks = settingsOf(repo.root).hooks;
    expect(hooks.SessionStart).toHaveLength(1);
    expect(hooks.SessionStart[0].hooks[0].args).toContain('lead');
  });

  test('leave removes only what agflow added', () => {
    const repo = tempRepo();
    mkdirSync(join(repo.root, '.claude'));
    writeFileSync(join(repo.root, CLAUDE_SETTINGS), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } }));
    const claude = fakeClaude();
    joinClaude(repo.root, self, 'worker', claude.runner);
    leaveClaude(repo.root, claude.runner);
    expect(settingsOf(repo.root)).toEqual({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } });
    expect(claude.calls.at(-1)).toEqual(['claude', 'mcp', 'remove', '--scope', 'local', 'agflow']);
  });

  test('leave deletes a settings file that only held agflow hooks', () => {
    const repo = tempRepo();
    const claude = fakeClaude();
    joinClaude(repo.root, self, 'worker', claude.runner);
    leaveClaude(repo.root, claude.runner);
    expect(existsSync(join(repo.root, CLAUDE_SETTINGS))).toBe(false);
  });

  test('refuses a tracked settings file and a failing claude command', () => {
    const repo = tempRepo();
    mkdirSync(join(repo.root, '.claude'));
    writeFileSync(join(repo.root, CLAUDE_SETTINGS), '{}');
    run(['git', 'add', CLAUDE_SETTINGS], repo.root);
    expect(() => joinClaude(repo.root, self, 'worker', fakeClaude().runner)).toThrow('tracked by git');
    const other = tempRepo();
    const failing: Runner = (cmd) => ({ code: cmd[2] === 'add' ? 1 : 0, output: 'not logged in' });
    expect(() => joinClaude(other.root, self, 'worker', failing)).toThrow('claude mcp add failed: not logged in');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test packages/cli/test/join-claude.test.ts`
Expected: FAIL. `../src/join` cannot be resolved.

- [ ] **Step 3: Create `packages/cli/src/join.ts`**

```ts
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AgentRole } from '@agflow/core';
import { addExclude, isTracked } from './git';
import type { SelfCommand } from './self';

/** Every hook handler agflow writes carries this statusMessage, so it can be found again. */
export const HOOK_MARK = 'agflow';

export type Runner = (cmd: string[], cwd: string) => { code: number; output: string };

export const defaultRunner: Runner = (cmd, cwd) => {
  const result = Bun.spawnSync(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' });
  return { code: result.exitCode, output: `${result.stdout.toString()}${result.stderr.toString()}`.trim() };
};

export type HookHandler = Record<string, unknown>;
export interface HookGroup {
  matcher?: string;
  hooks: HookHandler[];
}
export type HooksConfig = Record<string, HookGroup[]>;

export function withoutAgflowHooks(hooks: HooksConfig | undefined): HooksConfig {
  const result: HooksConfig = {};
  for (const [event, groups] of Object.entries(hooks ?? {})) {
    const kept = groups
      .map((group) => ({ ...group, hooks: group.hooks.filter((handler) => handler.statusMessage !== HOOK_MARK) }))
      .filter((group) => group.hooks.length > 0);
    if (kept.length > 0) result[event] = kept;
  }
  return result;
}

export function addHookGroups(hooks: HooksConfig, additions: HooksConfig): HooksConfig {
  const result: HooksConfig = { ...hooks };
  for (const [event, groups] of Object.entries(additions)) result[event] = [...(result[event] ?? []), ...groups];
  return result;
}

export function readJsonFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, 'utf8').trim();
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

export function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Writes the settings back without agflow's hooks, deleting the file if nothing else is left in it. */
export function stripAgflowHooksFile(path: string): void {
  if (!existsSync(path)) return;
  const settings = readJsonFile(path);
  const hooks = withoutAgflowHooks(settings.hooks as HooksConfig | undefined);
  const next: Record<string, unknown> = { ...settings };
  if (Object.keys(hooks).length > 0) next.hooks = hooks;
  else delete next.hooks;
  if (Object.keys(next).length === 0) rmSync(path);
  else writeJsonFile(path, next);
}

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

export const CLAUDE_SETTINGS = '.claude/settings.local.json';

export function claudeHooks(self: SelfCommand, role: AgentRole): HooksConfig {
  const handler = (event: string, extra: Record<string, unknown> = {}): HookHandler => ({
    type: 'command',
    command: self.command,
    args: [...self.args, 'hook', event, '--vendor', 'claude', '--role', role],
    statusMessage: HOOK_MARK,
    ...extra,
  });
  const waiter = handler('wait-inbox', { asyncRewake: true });
  return {
    SessionStart: [{ hooks: [handler('session-start', { timeout: 20 }), waiter] }],
    UserPromptSubmit: [{ hooks: [handler('user-prompt-submit', { timeout: 15 })] }],
    Stop: [{ hooks: [handler('stop', { timeout: 20 }), waiter] }],
  };
}

export function joinClaude(root: string, self: SelfCommand, role: AgentRole, run: Runner): void {
  if (isTracked(root, CLAUDE_SETTINGS)) {
    throw new Error(`${CLAUDE_SETTINGS} is tracked by git; agflow keeps its settings out of git and cannot use it`);
  }
  run(['claude', 'mcp', 'remove', '--scope', 'local', 'agflow'], root);
  const added = run(
    ['claude', 'mcp', 'add', '--scope', 'local', 'agflow', '--', self.command, ...self.args, 'mcp', '--vendor', 'claude'],
    root,
  );
  if (added.code !== 0) throw new Error(`claude mcp add failed: ${added.output}`);
  const path = join(root, CLAUDE_SETTINGS);
  const settings = readJsonFile(path);
  const hooks = addHookGroups(withoutAgflowHooks(settings.hooks as HooksConfig | undefined), claudeHooks(self, role));
  writeJsonFile(path, { ...settings, hooks });
  addExclude(root, CLAUDE_SETTINGS);
}

export function leaveClaude(root: string, run: Runner): void {
  run(['claude', 'mcp', 'remove', '--scope', 'local', 'agflow'], root);
  stripAgflowHooksFile(join(root, CLAUDE_SETTINGS));
}
```

- [ ] **Step 4: Run tests and the typecheck**

Run: `bun test packages/cli && bun run typecheck`
Expected: all tests pass; `tsc` exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/cli
git commit -m "feat(cli): join and leave for Claude Code (local MCP scope and hooks)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: `join` and `leave` for Codex, and the commands

**Files:**
- Modify: `packages/cli/src/join.ts` (append Codex support, the joined-repositories registry and the commands)
- Modify: `packages/cli/src/main.ts`, `packages/cli/src/login.ts` (status lists joined repositories)
- Test: `packages/cli/test/join-codex.test.ts`

What `join` writes for Codex:
- **MCP server.** A marked block in `<repo>/.codex/config.toml` adds the agflow MCP server, with `cwd` set to the repository.
- **Hooks.** `<repo>/.codex/hooks.json` gets the session-start, user-prompt-submit and stop hooks. They use quoted command strings, because Codex hooks take a command string. `additionalContextLimit: 4000` (tokens) keeps the brief from being cut to a file preview.
- **Exclude.** Both files are listed in `.git/info/exclude`.
- **Refusal.** `join` refuses if git tracks either file.

- [ ] **Step 1: Write the failing test `packages/cli/test/join-codex.test.ts`**

```ts
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveCredentials } from '../src/credentials';
import { CODEX_CONFIG, CODEX_HOOKS, type Runner, joinCodex, joinRepository, leaveCodex, leaveRepository, loadJoined } from '../src/join';
import { run, tempRepo } from './fixture';

const self = { command: '/Apps/My Tools/agflow', args: [] };

describe('joinCodex and leaveCodex', () => {
  test('adds a marked MCP block and quoted command hooks, keeping existing settings', () => {
    const repo = tempRepo();
    mkdirSync(join(repo.root, '.codex'));
    writeFileSync(join(repo.root, CODEX_CONFIG), 'model = "gpt-6"\n');
    joinCodex(repo.root, self, 'worker');
    const config = readFileSync(join(repo.root, CODEX_CONFIG), 'utf8');
    expect(config).toStartWith('model = "gpt-6"\n');
    expect(config).toContain('[mcp_servers.agflow]');
    expect(config).toContain('command = "/Apps/My Tools/agflow"');
    expect(config).toContain('args = ["mcp", "--vendor", "codex"]');
    expect(config).toContain(`cwd = ${JSON.stringify(repo.root)}`);
    const hooks = JSON.parse(readFileSync(join(repo.root, CODEX_HOOKS), 'utf8')).hooks;
    expect(hooks.SessionStart[0].hooks[0]).toMatchObject({
      command: "'/Apps/My Tools/agflow' hook session-start --vendor codex --role worker",
      additionalContextLimit: 4000,
      statusMessage: 'agflow',
    });
    expect(hooks.Stop[0].hooks[0].command).toContain('hook stop');
    expect(run(['git', 'status', '--porcelain'], repo.root)).toBe('');
  });

  test('joining twice keeps one block and one set of hooks', () => {
    const repo = tempRepo();
    joinCodex(repo.root, self, 'worker');
    joinCodex(repo.root, self, 'lead');
    const config = readFileSync(join(repo.root, CODEX_CONFIG), 'utf8');
    expect(config.match(/\[mcp_servers\.agflow\]/g)).toHaveLength(1);
    const hooks = JSON.parse(readFileSync(join(repo.root, CODEX_HOOKS), 'utf8')).hooks;
    expect(hooks.SessionStart).toHaveLength(1);
    expect(hooks.SessionStart[0].hooks[0].command).toContain('--role lead');
  });

  test('leave restores the previous files', () => {
    const repo = tempRepo();
    mkdirSync(join(repo.root, '.codex'));
    writeFileSync(join(repo.root, CODEX_CONFIG), 'model = "gpt-6"\n');
    joinCodex(repo.root, self, 'worker');
    leaveCodex(repo.root);
    expect(readFileSync(join(repo.root, CODEX_CONFIG), 'utf8')).toBe('model = "gpt-6"\n');
    expect(existsSync(join(repo.root, CODEX_HOOKS))).toBe(false);
  });

  test('refuses tracked Codex files', () => {
    const repo = tempRepo();
    mkdirSync(join(repo.root, '.codex'));
    writeFileSync(join(repo.root, CODEX_HOOKS), '{}');
    run(['git', 'add', CODEX_HOOKS], repo.root);
    expect(() => joinCodex(repo.root, self, 'worker')).toThrow('tracked by git');
  });
});

describe('joinRepository', () => {
  const noClaude: Runner = () => ({ code: 0, output: '' });

  test('needs a sign-in and a git repository, then records the join', () => {
    const repo = tempRepo();
    const dir = mkdtempSync(join(tmpdir(), 'agflow-cfg-'));
    expect(() => joinRepository({ cwd: repo.root, dir, role: 'worker', vendors: ['codex'], self, run: noClaude })).toThrow('not signed in');
    saveCredentials({ hubUrl: 'http://hub.test', token: 't', user: 'alice' }, dir);
    expect(() => joinRepository({ cwd: repo.dir, dir, role: 'worker', vendors: ['codex'], self, run: noClaude })).toThrow('git repository');
    const lines = joinRepository({ cwd: repo.root, dir, role: 'lead', vendors: ['codex'], self, run: noClaude });
    expect(lines.join('\n')).toContain('/hooks');
    expect(loadJoined(dir)).toEqual([expect.objectContaining({ root: repo.root, role: 'lead', vendors: ['codex'] })]);
    expect(readFileSync(join(repo.root, '.git', 'info', 'exclude'), 'utf8')).toContain('.worktrees/');
    leaveRepository({ cwd: repo.root, dir, run: noClaude });
    expect(loadJoined(dir)).toEqual([]);
    expect(existsSync(join(repo.root, CODEX_CONFIG))).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test packages/cli/test/join-codex.test.ts`
Expected: FAIL. `joinCodex` and the other functions are not exported.

- [ ] **Step 3: Extend `packages/cli/src/join.ts`**

Replace the import block at the top of the file with:

```ts
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AgentRole, Vendor } from '@agflow/core';
import { type ParsedArgs, choiceFlag } from './args';
import { loadCredentials } from './credentials';
import { addExclude, isTracked, repoRoot } from './git';
import type { Io } from './io';
import { configDir } from './paths';
import { type SelfCommand, selfCommand, shellCommand } from './self';
```

Then append:

```ts
// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

export const CODEX_CONFIG = '.codex/config.toml';
export const CODEX_HOOKS = '.codex/hooks.json';
const BLOCK_START = '# >>> agflow (managed by agflow join; do not edit) >>>';
const BLOCK_END = '# <<< agflow <<<';

const tomlString = (value: string) => JSON.stringify(value);

export function codexMcpBlock(self: SelfCommand, root: string): string {
  const args = [...self.args, 'mcp', '--vendor', 'codex'];
  return [
    BLOCK_START,
    '[mcp_servers.agflow]',
    `command = ${tomlString(self.command)}`,
    `args = [${args.map(tomlString).join(', ')}]`,
    `cwd = ${tomlString(root)}`,
    BLOCK_END,
  ].join('\n');
}

export function withoutAgflowBlock(text: string): string {
  const kept: string[] = [];
  let inside = false;
  for (const line of text.split('\n')) {
    if (line === BLOCK_START) {
      inside = true;
      continue;
    }
    if (inside) {
      if (line === BLOCK_END) inside = false;
      continue;
    }
    kept.push(line);
  }
  const result = kept.join('\n').replace(/\n+$/, '');
  return result ? `${result}\n` : '';
}

export function codexHooks(self: SelfCommand, role: AgentRole): HooksConfig {
  const handler = (event: string, extra: Record<string, unknown> = {}): HookHandler => ({
    type: 'command',
    command: shellCommand([self.command, ...self.args, 'hook', event, '--vendor', 'codex', '--role', role]),
    statusMessage: HOOK_MARK,
    timeout: 20,
    ...extra,
  });
  return {
    SessionStart: [{ hooks: [handler('session-start', { additionalContextLimit: 4000 })] }],
    UserPromptSubmit: [{ hooks: [handler('user-prompt-submit', { additionalContextLimit: 4000 })] }],
    Stop: [{ hooks: [handler('stop')] }],
  };
}

export function joinCodex(root: string, self: SelfCommand, role: AgentRole): void {
  for (const file of [CODEX_CONFIG, CODEX_HOOKS]) {
    if (isTracked(root, file)) throw new Error(`${file} is tracked by git; agflow keeps its settings out of git and cannot add to it`);
  }
  const configPath = join(root, CODEX_CONFIG);
  const base = withoutAgflowBlock(existsSync(configPath) ? readFileSync(configPath, 'utf8') : '');
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${base}${base ? '\n' : ''}${codexMcpBlock(self, root)}\n`);
  const hooksPath = join(root, CODEX_HOOKS);
  const hooksFile = readJsonFile(hooksPath);
  writeJsonFile(hooksPath, {
    ...hooksFile,
    hooks: addHookGroups(withoutAgflowHooks(hooksFile.hooks as HooksConfig | undefined), codexHooks(self, role)),
  });
  addExclude(root, CODEX_CONFIG);
  addExclude(root, CODEX_HOOKS);
}

export function leaveCodex(root: string): void {
  const configPath = join(root, CODEX_CONFIG);
  if (existsSync(configPath)) {
    const rest = withoutAgflowBlock(readFileSync(configPath, 'utf8'));
    if (rest) writeFileSync(configPath, rest);
    else rmSync(configPath);
  }
  stripAgflowHooksFile(join(root, CODEX_HOOKS));
}

// ---------------------------------------------------------------------------
// Joined repositories and the commands
// ---------------------------------------------------------------------------

export interface JoinedRepo {
  root: string;
  role: AgentRole;
  vendors: Vendor[];
  joinedAt: string;
}

const joinedPath = (dir: string) => join(dir, 'joined.json');

export function loadJoined(dir: string): JoinedRepo[] {
  const path = joinedPath(dir);
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as JoinedRepo[]) : [];
}

function saveJoined(dir: string, repos: JoinedRepo[]): void {
  writeJsonFile(joinedPath(dir), repos);
}

export interface JoinOptions {
  cwd: string;
  dir: string;
  role: AgentRole;
  vendors: Vendor[];
  self: SelfCommand;
  run: Runner;
}

/** Joins the repository containing cwd and returns lines to show the person. */
export function joinRepository(options: JoinOptions): string[] {
  const credentials = loadCredentials(options.dir);
  if (!credentials) throw new Error('not signed in; run agflow login --hub <url> first');
  const root = repoRoot(options.cwd);
  if (!root) throw new Error('run agflow join inside the project’s git repository');
  addExclude(root, '.worktrees/');
  if (options.vendors.includes('claude')) joinClaude(root, options.self, options.role, options.run);
  if (options.vendors.includes('codex')) joinCodex(root, options.self, options.role);
  const others = loadJoined(options.dir).filter((repo) => repo.root !== root);
  saveJoined(options.dir, [...others, { root, role: options.role, vendors: options.vendors, joinedAt: new Date().toISOString() }]);
  const lines = [`Joined ${root} to ${credentials.hubUrl} as ${options.role}.`];
  if (options.vendors.includes('claude')) {
    lines.push('Claude Code: start a new chat in this repository; it will receive an agflow brief and the agflow tools.');
  }
  if (options.vendors.includes('codex')) {
    lines.push('Codex: trust this project if Codex asks, then run /hooks once and trust the three agflow hooks. New chats here receive the agflow brief and tools.');
  }
  if (options.role === 'lead') lines.push('Lead: one lead is active per project; if another lead is active, this chat registers as a worker.');
  return lines;
}

export function leaveRepository(options: { cwd: string; dir: string; run: Runner }): string {
  const root = repoRoot(options.cwd);
  if (!root) throw new Error('run agflow leave inside the project’s git repository');
  leaveClaude(root, options.run);
  leaveCodex(root);
  saveJoined(options.dir, loadJoined(options.dir).filter((repo) => repo.root !== root));
  return `Removed agflow from ${root}.`;
}

export async function joinCommand(args: ParsedArgs, io: Io): Promise<number> {
  const role = choiceFlag(args, 'role', ['worker', 'lead'] as const, 'worker');
  const vendor = choiceFlag(args, 'vendor', ['claude', 'codex', 'both'] as const, 'both');
  const vendors: Vendor[] = vendor === 'both' ? ['claude', 'codex'] : [vendor];
  const lines = joinRepository({ cwd: process.cwd(), dir: configDir(), role, vendors, self: selfCommand(), run: defaultRunner });
  io.out(`${lines.join('\n')}\n`);
  return 0;
}

export async function leaveCommand(_args: ParsedArgs, io: Io): Promise<number> {
  io.out(`${leaveRepository({ cwd: process.cwd(), dir: configDir(), run: defaultRunner })}\n`);
  return 0;
}
```

- [ ] **Step 4: Register the commands in `packages/cli/src/main.ts`**

Add the import:

```ts
import { joinCommand, leaveCommand } from './join';
```

Add to the `commands` object:

```ts
  join: joinCommand,
  leave: leaveCommand,
```

- [ ] **Step 5: List joined repositories in `statusReport` (`packages/cli/src/login.ts`)**

Add the import:

```ts
import { loadJoined } from './join';
```

Replace the final `return` line of `statusReport` with:

```ts
  const joined = loadJoined(dir);
  const repos =
    joined.length > 0 ? joined.map((repo) => `  ${repo.root} (${repo.role}; ${repo.vendors.join(', ')})`).join('\n') : '  none';
  return `Hub: ${credentials.hubUrl}\nSigned in as: ${me.user}\nProject: ${project}\nGoal version: v${status.goalVersion}\nLead: ${lead}\nJoined repositories:\n${repos}\n`;
```

- [ ] **Step 6: Run tests and the typecheck**

Run: `bun test packages/cli && bun run typecheck`
Expected: all tests pass; `tsc` exits 0.

- [ ] **Step 7: Commit**

```bash
git add packages/cli
git commit -m "feat(cli): join and leave for Codex, joined-repository registry and commands" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Hook handlers

**Files:**
- Create: `packages/cli/src/hooks.ts`
- Modify: `packages/cli/src/main.ts`
- Test: `packages/cli/test/hooks.test.ts`

One handler serves both vendors. Claude Code and Codex send the same input fields (`session_id`, `cwd`, `stop_hook_active`) and accept the same replies (`hookSpecificOutput.additionalContext` and `decision: "block"`). A hook must never break the chat. On any failure it prints `{}`, or for `SessionStart` a short explanation, and exits 0. Exit code 2 would mean "block" to both CLIs.

- [ ] **Step 1: Write the failing test `packages/cli/test/hooks.test.ts`**

```ts
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listAgents } from '@agflow/hub/src/agents';
import { sendMessage } from '@agflow/hub/src/messages';
import { saveCredentials } from '../src/credentials';
import { handleHook, runHook } from '../src/hooks';
import { HUB_URL, helloCodeIn, hubFixture } from './fixture';

const contextOf = (output: Record<string, unknown>) =>
  (output.hookSpecificOutput as { additionalContext: string } | undefined)?.additionalContext ?? '';

describe('handleHook', () => {
  test('session start registers the chat and returns the brief as context', async () => {
    const hub = hubFixture();
    const output = await handleHook('session-start', { session_id: 's1', cwd: '/work/demo' }, { client: hub.client('alice'), vendor: 'codex', role: 'worker' });
    expect(output.hookSpecificOutput).toMatchObject({ hookEventName: 'SessionStart' });
    expect(helloCodeIn(contextOf(output))).toMatch(/^[A-Z2-9]{6}$/);
    expect(listAgents(hub.ctx)).toEqual([expect.objectContaining({ vendor: 'codex', sessionId: 's1', label: 'demo' })]);
  });

  test('a prompt brings new messages as context, once', async () => {
    const hub = hubFixture();
    const ctx = { client: hub.client('alice'), vendor: 'claude' as const, role: 'worker' as const };
    await handleHook('session-start', { session_id: 's1' }, ctx);
    const agentId = listAgents(hub.ctx)[0]?.id ?? '';
    sendMessage(hub.ctx, { from: 'user:bob', to: `agent:${agentId}`, body: 'Use pnpm.' });
    const first = await handleHook('user-prompt-submit', { session_id: 's1' }, ctx);
    expect(first.hookSpecificOutput).toMatchObject({ hookEventName: 'UserPromptSubmit' });
    expect(contextOf(first)).toContain('Use pnpm.');
    expect(await handleHook('user-prompt-submit', { session_id: 's1' }, ctx)).toEqual({});
  });

  test('stop continues the turn while messages wait, and allows it otherwise', async () => {
    const hub = hubFixture();
    const ctx = { client: hub.client('alice'), vendor: 'claude' as const, role: 'worker' as const };
    await handleHook('session-start', { session_id: 's1' }, ctx);
    expect(await handleHook('stop', { session_id: 's1', stop_hook_active: false }, ctx)).toEqual({});
    sendMessage(hub.ctx, { from: 'user:bob', to: `agent:${listAgents(hub.ctx)[0]?.id}`, body: 'One more thing.' });
    const blocked = await handleHook('stop', { session_id: 's1', stop_hook_active: false }, ctx);
    expect(blocked).toMatchObject({ decision: 'block' });
    expect(String(blocked.reason)).toContain('check_inbox');
    expect(await handleHook('stop', { session_id: 's1', stop_hook_active: true }, ctx)).toEqual({});
  });

  test('input without a session id produces no output', async () => {
    const hub = hubFixture();
    expect(await handleHook('stop', {}, { client: hub.client('alice'), vendor: 'claude', role: 'worker' })).toEqual({});
  });
});

describe('runHook', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'agflow-cfg-'));

  test('without a sign-in, session start explains what to do', async () => {
    const output = await runHook('session-start', 'claude', 'worker', { readStdin: async () => '{"session_id":"s1"}', dir: dir() });
    expect(contextOf(output)).toContain('agflow login');
    expect(await runHook('stop', 'claude', 'worker', { readStdin: async () => '{"session_id":"s1"}', dir: dir() })).toEqual({});
  });

  test('an unreachable hub never breaks the chat and is logged', async () => {
    const where = dir();
    saveCredentials({ hubUrl: HUB_URL, token: 't', user: 'alice' }, where);
    const failing = async () => {
      throw new Error('ECONNREFUSED');
    };
    const start = await runHook('session-start', 'claude', 'worker', { readStdin: async () => '{"session_id":"s1"}', dir: where, fetch: failing });
    expect(contextOf(start)).toContain('could not reach its hub');
    expect(await runHook('stop', 'codex', 'worker', { readStdin: async () => 'not json', dir: where, fetch: failing })).toEqual({});
    expect(readFileSync(join(where, 'hook.log'), 'utf8')).toContain('session-start: cannot reach the agflow hub');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test packages/cli/test/hooks.test.ts`
Expected: FAIL. `../src/hooks` cannot be resolved.

- [ ] **Step 3: Create `packages/cli/src/hooks.ts`**

```ts
import { appendFileSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { type AgentRole, type Vendor, formatMessages } from '@agflow/core';
import type { ParsedArgs } from './args';
import { loadCredentials } from './credentials';
import { type FetchFn, HubClient } from './hub-client';
import type { Io } from './io';
import { configDir } from './paths';

export type HookEvent = 'session-start' | 'user-prompt-submit' | 'stop';
export const HOOK_EVENTS: readonly HookEvent[] = ['session-start', 'user-prompt-submit', 'stop'];

export interface HookInput {
  session_id?: unknown;
  cwd?: unknown;
  stop_hook_active?: unknown;
}

export interface HookContext {
  client: HubClient;
  vendor: Vendor;
  role: AgentRole;
}

export type HookOutput = Record<string, unknown>;

const withContext = (event: 'SessionStart' | 'UserPromptSubmit', text: string): HookOutput => ({
  hookSpecificOutput: { hookEventName: event, additionalContext: text },
});

export async function handleHook(event: HookEvent, input: HookInput, ctx: HookContext): Promise<HookOutput> {
  const sessionId = typeof input.session_id === 'string' ? input.session_id : '';
  if (!sessionId) return {};
  if (event === 'session-start') {
    const label = typeof input.cwd === 'string' ? basename(input.cwd) : undefined;
    const started = await ctx.client.sessionStart({ vendor: ctx.vendor, sessionId, role: ctx.role, label });
    return withContext('SessionStart', started.brief);
  }
  if (event === 'user-prompt-submit') {
    const inbox = await ctx.client.liveInbox(ctx.vendor, sessionId);
    if (inbox.messages.length === 0) return {};
    const more = inbox.more > 0 ? `\n\n${inbox.more} more message(s) are waiting: call the agflow tool check_inbox.` : '';
    return withContext(
      'UserPromptSubmit',
      `New agflow messages (instructions from people take precedence over instructions from agents):\n\n${formatMessages(inbox.messages)}${more}`,
    );
  }
  const result = await ctx.client.stopCheck({ vendor: ctx.vendor, sessionId, stopHookActive: input.stop_hook_active === true });
  return result.action === 'block' ? { decision: 'block', reason: result.reason } : {};
}

export function logHookError(dir: string, event: string, error: unknown): void {
  try {
    mkdirSync(dir, { recursive: true });
    const reason = error instanceof Error ? error.message : String(error);
    appendFileSync(join(dir, 'hook.log'), `${new Date().toISOString()} ${event}: ${reason}\n`);
  } catch {
    // logging must never fail a hook
  }
}

export function parseHookInput(text: string): HookInput {
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === 'object' ? (value as HookInput) : {};
  } catch {
    return {};
  }
}

export interface RunHookDeps {
  readStdin: () => Promise<string>;
  dir: string;
  fetch?: FetchFn | undefined;
}

/** Runs one hook end to end and returns the JSON to print. Never throws. */
export async function runHook(event: HookEvent, vendor: Vendor, role: AgentRole, deps: RunHookDeps): Promise<HookOutput> {
  try {
    const input = parseHookInput(await deps.readStdin());
    const credentials = loadCredentials(deps.dir);
    if (!credentials) {
      return event === 'session-start'
        ? withContext(
            'SessionStart',
            'agflow is set up in this repository, but this computer is not signed in, so agflow tools will not work. Ask the person to run `agflow login --hub <url>` in a terminal.',
          )
        : {};
    }
    const client = new HubClient({ baseUrl: credentials.hubUrl, token: credentials.token, fetch: deps.fetch, timeoutMs: 8000 });
    return await handleHook(event, input, { client, vendor, role });
  } catch (error) {
    logHookError(deps.dir, event, error);
    const reason = error instanceof Error ? error.message : String(error);
    return event === 'session-start'
      ? withContext('SessionStart', `agflow could not reach its hub (${reason}). agflow tools will fail until it is reachable.`)
      : {};
  }
}

export async function hookCommand(args: ParsedArgs, io: Io): Promise<number> {
  const event = args.positional[1] ?? '';
  const vendor: Vendor = args.flags.vendor === 'codex' ? 'codex' : 'claude';
  const role: AgentRole = args.flags.role === 'lead' ? 'lead' : 'worker';
  if (!(HOOK_EVENTS as readonly string[]).includes(event)) {
    io.err(`agflow: unknown hook event "${event}"\n`);
    io.out('{}');
    return 0;
  }
  const output = await runHook(event as HookEvent, vendor, role, { readStdin: () => Bun.stdin.text(), dir: configDir() });
  io.out(JSON.stringify(output));
  return 0;
}
```

- [ ] **Step 4: Register the command in `packages/cli/src/main.ts`**

Add the import:

```ts
import { hookCommand } from './hooks';
```

Add to the `commands` object:

```ts
  hook: hookCommand,
```

- [ ] **Step 5: Run tests and the typecheck**

Run: `bun test packages/cli && bun run typecheck`
Expected: all tests pass; `tsc` exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/cli
git commit -m "feat(cli): session-start, prompt and stop hooks shared by Claude Code and Codex" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Waking an idle Claude chat

**Files:**
- Create: `packages/cli/src/wait-inbox.ts`
- Modify: `packages/cli/src/hooks.ts` (route `wait-inbox`)
- Test: `packages/cli/test/wait-inbox.test.ts`

Claude Code runs `asyncRewake` hooks in the background, and when such a hook exits with code 2 it wakes the session and shows the hook's stderr to Claude. The waiter works like this:
- It polls the hub's read-only peek endpoint every 15 seconds.
- When messages are waiting, it prints a short notice to stderr and exits 2.
- It stops after 8 hours, or as soon as the chat process that started it is gone.
- A lock file keeps it to one waiter per session.

- [ ] **Step 1: Write the failing test `packages/cli/test/wait-inbox.test.ts`**

```ts
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LivePeek } from '@agflow/core';
import { acquireWaiterLock, waitForMessages } from '../src/wait-inbox';

function fakeTime() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

const peeks = (...results: LivePeek[]) => {
  let call = 0;
  return { peek: async () => results[Math.min(call++, results.length - 1)] as LivePeek };
};

describe('waitForMessages', () => {
  test('returns a notice once messages are waiting', async () => {
    const time = fakeTime();
    const notice = await waitForMessages({
      client: peeks({ unread: 0, first: null }, { unread: 2, first: { from: 'user:bob' } }),
      vendor: 'claude',
      sessionId: 's1',
      pollMs: 1000,
      maxMs: 60_000,
      ...time,
      stillWanted: () => true,
    });
    expect(notice).toContain('2 new message(s)');
    expect(notice).toContain('user:bob');
    expect(notice).toContain('check_inbox');
    expect(time.now()).toBe(1000);
  });

  test('gives up at the deadline or when the chat is gone', async () => {
    const quiet = peeks({ unread: 0, first: null });
    expect(await waitForMessages({ client: quiet, vendor: 'claude', sessionId: 's1', pollMs: 1000, maxMs: 5000, ...fakeTime(), stillWanted: () => true })).toBeNull();
    expect(await waitForMessages({ client: quiet, vendor: 'claude', sessionId: 's1', pollMs: 1000, maxMs: 5000, ...fakeTime(), stillWanted: () => false })).toBeNull();
  });

  test('keeps waiting through hub errors', async () => {
    let call = 0;
    const flaky = {
      peek: async (): Promise<LivePeek> => {
        call += 1;
        if (call === 1) throw new Error('ECONNREFUSED');
        return { unread: 1, first: { from: 'system' } };
      },
    };
    expect(await waitForMessages({ client: flaky, vendor: 'codex', sessionId: 's1', pollMs: 10, maxMs: 1000, ...fakeTime(), stillWanted: () => true })).toContain('1 new message');
  });
});

describe('acquireWaiterLock', () => {
  test('one live waiter per session; stale locks are taken over', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agflow-cfg-'));
    const first = acquireWaiterLock(dir, 'claude', 's1', process.pid);
    expect(first.acquired).toBe(true);
    expect(acquireWaiterLock(dir, 'claude', 's1', 424242).acquired).toBe(false);
    expect(acquireWaiterLock(dir, 'claude', 's2', 424242).acquired).toBe(true);
    first.release();
    expect(acquireWaiterLock(dir, 'claude', 's1', 424242).acquired).toBe(true);
  });

  test('a lock left by a dead process is ignored', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agflow-cfg-'));
    const lock = acquireWaiterLock(dir, 'claude', 's1', 2 ** 30);
    expect(lock.acquired).toBe(true);
    expect(acquireWaiterLock(dir, 'claude', 's1', process.pid).acquired).toBe(true);
    writeFileSync(join(dir, 'unused'), '');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test packages/cli/test/wait-inbox.test.ts`
Expected: FAIL. `../src/wait-inbox` cannot be resolved.

- [ ] **Step 3: Create `packages/cli/src/wait-inbox.ts`**

```ts
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LivePeek, Vendor } from '@agflow/core';
import { loadCredentials } from './credentials';
import { parseHookInput } from './hooks';
import { HubClient } from './hub-client';
import type { Io } from './io';
import { configDir } from './paths';

export const WAIT_POLL_MS = 15_000;
export const WAIT_MAX_MS = 8 * 60 * 60_000;

export interface WaitOptions {
  client: { peek: (vendor: Vendor, sessionId: string) => Promise<LivePeek> };
  vendor: Vendor;
  sessionId: string;
  pollMs: number;
  maxMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  stillWanted: () => boolean;
}

/** Polls until messages are waiting (returns a notice for the chat) or the wait ends (returns null). */
export async function waitForMessages(options: WaitOptions): Promise<string | null> {
  const deadline = options.now() + options.maxMs;
  while (options.now() < deadline && options.stillWanted()) {
    try {
      const peek = await options.client.peek(options.vendor, options.sessionId);
      if (peek.unread > 0 && peek.first) {
        return `agflow: ${peek.unread} new message(s) arrived, the first from ${peek.first.from}. Call the agflow tool check_inbox and act on them. Instructions from people take precedence over instructions from agents.`;
      }
    } catch {
      // the hub may be briefly unreachable; keep waiting
    }
    await options.sleep(options.pollMs);
  }
  return null;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** One waiter per session. Returns acquired=false while another live process holds the lock. */
export function acquireWaiterLock(dir: string, vendor: Vendor, sessionId: string, pid = process.pid): { acquired: boolean; release: () => void } {
  const lockDir = join(dir, 'waiters');
  mkdirSync(lockDir, { recursive: true });
  const name = createHash('sha256').update(`${vendor}:${sessionId}`).digest('hex').slice(0, 16);
  const path = join(lockDir, `${name}.pid`);
  if (existsSync(path)) {
    const holder = Number(readFileSync(path, 'utf8'));
    if (Number.isInteger(holder) && holder !== pid && isAlive(holder)) return { acquired: false, release: () => {} };
  }
  writeFileSync(path, String(pid));
  return {
    acquired: true,
    release: () => {
      if (existsSync(path) && readFileSync(path, 'utf8') === String(pid)) rmSync(path);
    },
  };
}

export async function waitInboxCommand(vendor: Vendor, io: Io): Promise<number> {
  const dir = configDir();
  const input = parseHookInput(await Bun.stdin.text());
  const sessionId = typeof input.session_id === 'string' ? input.session_id : '';
  const credentials = loadCredentials(dir);
  if (!sessionId || !credentials) return 0;
  const lock = acquireWaiterLock(dir, vendor, sessionId);
  if (!lock.acquired) return 0;
  const parent = process.ppid;
  try {
    const notice = await waitForMessages({
      client: new HubClient({ baseUrl: credentials.hubUrl, token: credentials.token, timeoutMs: 10_000 }),
      vendor,
      sessionId,
      pollMs: WAIT_POLL_MS,
      maxMs: WAIT_MAX_MS,
      now: () => Date.now(),
      sleep: (ms) => Bun.sleep(ms),
      stillWanted: () => process.ppid === parent && isAlive(parent),
    });
    if (!notice) return 0;
    io.err(notice);
    return 2;
  } finally {
    lock.release();
  }
}
```

- [ ] **Step 4: Route `wait-inbox` in `packages/cli/src/hooks.ts`**

Add the import:

```ts
import { waitInboxCommand } from './wait-inbox';
```

In `hookCommand`, insert as the first line after `const role …`:

```ts
  if (event === 'wait-inbox') return waitInboxCommand(vendor, io);
```

- [ ] **Step 5: Run tests and the typecheck**

Run: `bun test packages/cli && bun run typecheck`
Expected: all tests pass; `tsc` exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/cli
git commit -m "feat(cli): background waiter that wakes an idle Claude chat when messages arrive" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: MCP tools, part 1: shared and worker tools

**Files:**
- Create: `packages/cli/src/mcp/tools.ts`
- Test: `packages/cli/test/tools-worker.test.ts`

Each tool is a plain async function from validated arguments to text for the model. Tools that act as the agent need `hello` first. Read-only tools work before it.

- [ ] **Step 1: Write the failing test `packages/cli/test/tools-worker.test.ts`**

```ts
import { describe, expect, test } from 'bun:test';
import { NewTaskSchema } from '@agflow/core';
import { updateGoal } from '@agflow/hub/src/goal';
import { sendMessage } from '@agflow/hub/src/messages';
import { claimTask, createTasks, getTask } from '@agflow/hub/src/tasks';
import { getAgent } from '@agflow/hub/src/agents';
import type { HubClient } from '../src/hub-client';
import { type ToolContext, allTools } from '../src/mcp/tools';
import { helloCodeIn, hubFixture } from './fixture';

const newTask = (title: string) => NewTaskSchema.parse({ title, objective: `Do ${title}`, acceptance: [{ id: 'A1', assertion: `${title} works` }] });
const tool = (name: string) => {
  const found = allTools.find((t) => t.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
};
const call = (name: string, args: Record<string, unknown>, ctx: ToolContext) => tool(name).run(args, ctx);
const contextFor = (client: HubClient | null, agentId: string | null = null): ToolContext => ({
  client,
  state: { agentId, role: agentId ? 'worker' : null },
  cwd: '/tmp',
});

describe('shared tools', () => {
  test('hello binds the chat to the agent registered by the SessionStart hook', async () => {
    const hub = hubFixture();
    const client = hub.client('alice');
    const brief = (await client.sessionStart({ vendor: 'claude', sessionId: 's1', role: 'worker' })).brief;
    const ctx = contextFor(client);
    await expect(call('check_inbox', {}, ctx)).rejects.toThrow('Call the agflow tool hello first');
    expect(await call('hello', { code: helloCodeIn(brief) }, ctx)).toContain('Connected as agflow agent A-1 (worker)');
    expect(ctx.state).toEqual({ agentId: 'A-1', role: 'worker' });
    expect(await call('check_inbox', {}, ctx)).toBe('No new messages.');
  });

  test('without a sign-in every tool explains how to sign in', async () => {
    await expect(call('list_tasks', {}, contextFor(null))).rejects.toThrow('agflow login');
  });

  test('reads the goal, tasks and one task in model-friendly text', async () => {
    const hub = hubFixture();
    updateGoal(hub.ctx, { text: 'Ship the parser.', baseVersion: 0 }, 'user:alice');
    createTasks(hub.ctx, [newTask('Parser'), newTask('Docs')], 'user:alice');
    const ctx = contextFor(hub.client('alice'));
    expect(await call('get_goal', {}, ctx)).toContain('Goal v1 (by user:alice):\nShip the parser.');
    expect(await call('list_tasks', { status: ['ready'] }, ctx)).toBe('T-1 [ready] p5 Parser\nT-2 [ready] p5 Docs');
    const detail = await call('get_task', { id: 'T-1' }, ctx);
    expect(detail).toContain('Objective: Do Parser');
    expect(detail).toContain('- A1: Parser works');
  });

  test('inbox, messages and search', async () => {
    const hub = hubFixture();
    const live = hub.liveAgent('alice');
    const ctx = contextFor(live.client, live.agentId);
    sendMessage(hub.ctx, { from: 'user:bob', to: `agent:${live.agentId}`, body: 'Use pnpm.' });
    expect(await call('check_inbox', {}, ctx)).toContain('[agflow message #');
    expect(await call('send_message', { to: 'humans', body: 'Need the API key.' }, ctx)).toMatch(/^Sent message #\d+ to humans\.$/);
    expect(await call('search', { query: 'API key' }, ctx)).toContain('Need the API key.');
    expect(await call('search', { query: 'nothing-like-this' }, ctx)).toBe('Nothing found.');
  });
});

describe('worker tools', () => {
  test('progress, handoff, block, release and resume', async () => {
    const hub = hubFixture();
    createTasks(hub.ctx, [newTask('Parser')], 'user:alice');
    const live = hub.liveAgent('alice');
    const ctx = contextFor(live.client, live.agentId);
    claimTask(hub.ctx, 'T-1', getAgent(hub.ctx, live.agentId));
    expect(await call('report_progress', { task_id: 'T-1', note: 'Tokenizer done' }, ctx)).toBe('Progress recorded; T-1 is working.');
    expect(await call('write_handoff', { task_id: 'T-1', note: 'Next: AST' }, ctx)).toBe('Handoff note saved on T-1.');
    expect(await call('release_task', { task_id: 'T-1', reason: 'out of time' }, ctx)).toBe('Released T-1; it is ready again.');
    claimTask(hub.ctx, 'T-1', getAgent(hub.ctx, live.agentId));
    expect(await call('declare_blocked', { task_id: 'T-1', reason: 'Need credentials' }, ctx)).toBe('T-1 is blocked; the lead has been told.');
    expect(getTask(hub.ctx, 'T-1').status).toBe('blocked');
    const again = hub.liveAgent('alice');
    createTasks(hub.ctx, [newTask('Docs')], 'user:alice');
    claimTask(hub.ctx, 'T-2', getAgent(hub.ctx, live.agentId));
    expect(await call('resume_claim', { id: 'T-2' }, contextFor(again.client, again.agentId))).toBe('You now hold T-2.');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test packages/cli/test/tools-worker.test.ts`
Expected: FAIL. `../src/mcp/tools` cannot be resolved.

- [ ] **Step 3: Create `packages/cli/src/mcp/tools.ts`**

```ts
import { type AgentRole, type Task, type TaskStatus, TargetSchema, TaskIdSchema, formatMessages } from '@agflow/core';
import { z } from 'zod';
import type { HubClient } from '../hub-client';

export interface ToolState {
  agentId: string | null;
  role: AgentRole | null;
}

export interface ToolContext {
  client: HubClient | null;
  state: ToolState;
  cwd: string;
}

export interface ToolDef {
  name: string;
  description: string;
  input: Record<string, z.ZodType>;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>;
}

export function defineTool<S extends Record<string, z.ZodType>>(
  name: string,
  description: string,
  input: S,
  run: (args: z.output<z.ZodObject<S>>, ctx: ToolContext) => Promise<string>,
): ToolDef {
  return { name, description, input, run: (args, ctx) => run(args as z.output<z.ZodObject<S>>, ctx) };
}

export class ToolError extends Error {
  override name = 'ToolError';
}

export function hub(ctx: ToolContext): HubClient {
  if (!ctx.client) throw new ToolError('This computer is not signed in to agflow. Ask the person to run `agflow login --hub <url>`.');
  return ctx.client;
}

/** The client acting as this chat's agent; requires hello first. */
export function asAgent(ctx: ToolContext): HubClient {
  const client = hub(ctx);
  if (!ctx.state.agentId) throw new ToolError('Call the agflow tool hello first, with the code from your agflow brief.');
  return client;
}

export function taskLine(task: Task): string {
  const owner = task.assignee ? ` · ${task.assignee}` : '';
  const blocked = task.status === 'blocked' && task.blockedReason ? ` · ${task.blockedReason}` : '';
  return `${task.id} [${task.status}] p${task.priority} ${task.title}${owner}${blocked}`;
}

export const lines = (parts: Array<string | false | null | undefined | 0>) => parts.filter(Boolean).join('\n');

export const sharedTools: ToolDef[] = [
  defineTool(
    'hello',
    'Connect this chat to agflow. Call it first, with the code from your agflow brief.',
    { code: z.string().min(4).max(20) },
    async ({ code }, ctx) => {
      const client = hub(ctx);
      const result = await client.hello(code);
      client.agentId = result.agentId;
      ctx.state.agentId = result.agentId;
      ctx.state.role = result.role;
      const next = result.role === 'lead' ? 'Use get_status and list_tasks to see the plan.' : 'Use list_tasks to find ready work and claim_task to take it.';
      return `Connected as agflow agent ${result.agentId} (${result.role}). ${next}`;
    },
  ),
  defineTool(
    'get_brief',
    'Your current agflow brief: goal, standing rules, your task or the situation report, and unread messages.',
    {},
    async (_args, ctx) => (await asAgent(ctx).brief()).brief,
  ),
  defineTool('get_goal', "The project's current goal and the lead's interpretation notes.", {}, async (_args, ctx) => {
    const { current, notes } = await hub(ctx).goal();
    if (!current) return 'No goal has been set yet.';
    return lines([
      `Goal v${current.version} (by ${current.author}):`,
      current.text,
      notes.length > 0 && `\nInterpretation notes:\n${notes.map((note) => `- ${note.text} (${note.author})`).join('\n')}`,
    ]);
  }),
  defineTool(
    'list_tasks',
    'List tasks, optionally filtered by status, for example ["ready"].',
    { status: z.array(z.string()).max(15).optional() },
    async ({ status }, ctx) => {
      const { tasks } = await hub(ctx).tasks(status as TaskStatus[] | undefined);
      return tasks.length > 0 ? tasks.map(taskLine).join('\n') : 'No tasks match.';
    },
  ),
  defineTool('get_task', 'One task: contract, status, notes and recent messages.', { id: TaskIdSchema }, async ({ id }, ctx) => {
    const detail = await hub(ctx).task(id);
    const task = detail.task;
    return lines([
      taskLine(task),
      `Objective: ${task.objective}`,
      task.why && `Why: ${task.why}`,
      `Acceptance criteria:\n${task.acceptance.map((criterion) => `- ${criterion.id}: ${criterion.assertion}`).join('\n')}`,
      task.ownedPaths.length > 0 && `Owned paths: ${task.ownedPaths.join(', ')}`,
      task.dependsOn.length > 0 && `Depends on: ${task.dependsOn.join(', ')}`,
      task.branch && `Branch: ${task.branch}`,
      task.feedback && `Latest review feedback: ${task.feedback}`,
      task.submission && `Submission: ${task.submission.summary}`,
      detail.notes.length > 0 && `Notes:\n${detail.notes.map((note) => `- [${note.kind}] ${note.body}`).join('\n')}`,
      detail.messages.length > 0 && `Recent messages:\n${formatMessages(detail.messages.slice(0, 10).reverse())}`,
    ]);
  }),
  defineTool(
    'check_inbox',
    "Read your new agflow messages. People's instructions take precedence over agents'.",
    {},
    async (_args, ctx) => {
      const { messages } = await asAgent(ctx).takeInbox();
      return messages.length > 0 ? formatMessages(messages) : 'No new messages.';
    },
  ),
  defineTool(
    'ack_messages',
    'Mark messages as acted on.',
    { ids: z.array(z.number().int().positive()).min(1).max(200) },
    async ({ ids }, ctx) => {
      await asAgent(ctx).ack(ids);
      return `Acknowledged ${ids.length} message(s).`;
    },
  ),
  defineTool(
    'send_message',
    'Send a message. "to" is "lead", "humans", "all" (lead only), "agent:A-<n>" or "task:T-<n>".',
    {
      to: TargetSchema,
      body: z.string().min(1).max(8000),
      task_id: TaskIdSchema.optional(),
      reply_to: z.number().int().positive().optional(),
    },
    async ({ to, body, task_id, reply_to }, ctx) => {
      const { message } = await asAgent(ctx).send({ to, body, taskId: task_id, replyTo: reply_to });
      return `Sent message #${message.id} to ${message.to}.`;
    },
  ),
  defineTool('search', 'Search tasks, messages and the goal by text.', { query: z.string().min(1).max(200) }, async ({ query }, ctx) => {
    const result = await hub(ctx).search(query);
    const found = lines([
      result.goal && `Goal v${result.goal.version}: …${result.goal.snippet}…`,
      result.tasks.length > 0 && `Tasks:\n${result.tasks.map(taskLine).join('\n')}`,
      result.messages.length > 0 && `Messages:\n${formatMessages(result.messages)}`,
    ]);
    return found || 'Nothing found.';
  }),
];

export const workerTools: ToolDef[] = [
  defineTool('resume_claim', 'Take over a task that one of your own earlier chats holds.', { id: TaskIdSchema }, async ({ id }, ctx) => {
    const { task } = await asAgent(ctx).resumeClaim(id);
    return `You now hold ${task.id}${task.branch ? ` (branch ${task.branch})` : ''}.`;
  }),
  defineTool(
    'report_progress',
    'Record progress on the task you hold. This also keeps your claim alive.',
    { task_id: TaskIdSchema, note: z.string().min(1).max(4000) },
    async ({ task_id, note }, ctx) => {
      const { task } = await asAgent(ctx).progress(task_id, note);
      return `Progress recorded; ${task.id} is ${task.status}.`;
    },
  ),
  defineTool(
    'write_handoff',
    'Leave a handoff note for whoever continues your task: what is done, what remains, commands run and results, decisions, failed approaches, the next step.',
    { task_id: TaskIdSchema, note: z.string().min(1).max(16_000) },
    async ({ task_id, note }, ctx) => {
      await asAgent(ctx).handoff(task_id, note);
      return `Handoff note saved on ${task_id}.`;
    },
  ),
  defineTool(
    'declare_blocked',
    'Stop work on your task because something outside it blocks you. The lead is told.',
    { task_id: TaskIdSchema, reason: z.string().min(1).max(4000) },
    async ({ task_id, reason }, ctx) => {
      const { task } = await asAgent(ctx).block(task_id, reason);
      return `${task.id} is blocked; the lead has been told.`;
    },
  ),
  defineTool(
    'declare_impossible',
    'Report that your task cannot be done as specified (for example, acceptance criteria contradict each other), with evidence.',
    { task_id: TaskIdSchema, evidence: z.string().min(1).max(8000) },
    async ({ task_id, evidence }, ctx) => {
      const { task } = await asAgent(ctx).impossible(task_id, evidence);
      return `${task.id} is marked impossible as specified; the lead will decide.`;
    },
  ),
  defineTool(
    'release_task',
    'Give your task back so someone else can take it.',
    { task_id: TaskIdSchema, reason: z.string().min(1).max(4000) },
    async ({ task_id, reason }, ctx) => {
      const { task } = await asAgent(ctx).release(task_id, reason);
      return `Released ${task.id}; it is ${task.status} again.`;
    },
  ),
];

export const allTools: ToolDef[] = [...sharedTools, ...workerTools];
```

> **Deviation from the snippet above (found in the final review):** for a task on an agflow branch (`isTaskBranch`), `resume_claim` also creates the task worktree in the repository the chat runs in, or reuses the one that is there, and ends with the same `Work only inside <path> (branch <b>)` line as `claim_task`. As in `claim_task`, the worktree is made before the hub call and removed again if the hub refuses, and outside a git repository the call is refused before anything changes. Without it, a chat that took a claim over from another clone, another computer or a chat outside the repository had no worktree and was never told where to work. Tests: `resume_claim and the task worktree` in `packages/cli/test/tools-git.test.ts`.

- [ ] **Step 4: Run tests and the typecheck**

Run: `bun test packages/cli && bun run typecheck`
Expected: all tests pass; `tsc` exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/cli
git commit -m "feat(cli): MCP tools for every agent and for workers" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: MCP tools, part 2: claim and submit with git

**Files:**
- Create: `packages/cli/src/mcp/task-git.ts`
- Modify: `packages/cli/src/mcp/tools.ts`
- Test: `packages/cli/test/tools-git.test.ts`

- [ ] **Step 1: Write the failing test `packages/cli/test/tools-git.test.ts`**

```ts
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NewTaskSchema } from '@agflow/core';
import { getAgent } from '@agflow/hub/src/agents';
import { claimTask, createTasks, getTask } from '@agflow/hub/src/tasks';
import { type ToolContext, allTools } from '../src/mcp/tools';
import { type LiveAgent, hubFixture, run, tempRepo } from './fixture';

const newTask = (title: string) => NewTaskSchema.parse({ title, objective: `Do ${title}`, acceptance: [{ id: 'A1', assertion: 'works' }] });
const call = (name: string, args: Record<string, unknown>, ctx: ToolContext) => {
  const found = allTools.find((t) => t.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found.run(args, ctx);
};
const as = (live: LiveAgent, cwd: string): ToolContext => ({ client: live.client, state: { agentId: live.agentId, role: 'worker' }, cwd });
const commitAll = (cwd: string, message: string) => {
  run(['git', 'add', '.'], cwd);
  run(['git', 'commit', '--quiet', '-m', message], cwd);
};

describe('claim_task and submit', () => {
  test('claim creates the task worktree; submit refuses uncommitted work, then pushes and records the commit', async () => {
    const hub = hubFixture();
    const repo = tempRepo();
    createTasks(hub.ctx, [newTask('Add parser')], 'user:alice');
    const ctx = as(hub.liveAgent('alice'), repo.root);
    const worktree = join(repo.root, '.worktrees', 'agflow', 'T-1');
    const claimed = await call('claim_task', { id: 'T-1' }, ctx);
    expect(claimed).toContain(`Work only inside ${worktree} (branch agflow/T-1-add-parser)`);
    expect(run(['git', 'branch', '--show-current'], worktree)).toBe('agflow/T-1-add-parser');
    expect(getTask(hub.ctx, 'T-1')).toMatchObject({ status: 'claimed', branch: 'agflow/T-1-add-parser' });
    writeFileSync(join(worktree, 'parser.ts'), 'export const parse = () => 1;\n');
    await expect(call('submit', { task_id: 'T-1', summary: 'Parser added' }, ctx)).rejects.toThrow('uncommitted changes');
    commitAll(worktree, 'parser');
    const head = run(['git', 'rev-parse', 'HEAD'], worktree);
    expect(await call('submit', { task_id: 'T-1', summary: 'Parser added', evidence: ['bun test: 3 pass'] }, ctx)).toContain(
      `at ${head.slice(0, 7)} on agflow/T-1-add-parser`,
    );
    expect(run(['git', 'rev-parse', 'refs/heads/agflow/T-1-add-parser'], repo.origin)).toBe(head);
    expect(getTask(hub.ctx, 'T-1').submission).toMatchObject({ branch: 'agflow/T-1-add-parser', headSha: head });
    expect(run(['git', 'status', '--porcelain'], repo.root)).toBe('');
  });

  test('a refused claim removes the worktree and branch it created', async () => {
    const hub = hubFixture();
    const repo = tempRepo();
    createTasks(hub.ctx, [newTask('Parser')], 'user:alice');
    const other = hub.liveAgent('bob');
    claimTask(hub.ctx, 'T-1', getAgent(hub.ctx, other.agentId), 'agflow/T-1-parser');
    await expect(call('claim_task', { id: 'T-1' }, as(hub.liveAgent('alice'), repo.root))).rejects.toThrow('not ready');
    expect(existsSync(join(repo.root, '.worktrees', 'agflow', 'T-1'))).toBe(false);
    expect(run(['git', 'branch', '--list', 'agflow/T-1-parser'], repo.root)).toBe('');
  });

  test('a successor in another clone continues from the branch the previous holder pushed', async () => {
    const hub = hubFixture();
    const repo = tempRepo();
    createTasks(hub.ctx, [newTask('Parser')], 'user:alice');
    const first = as(hub.liveAgent('alice'), repo.root);
    await call('claim_task', { id: 'T-1' }, first);
    const firstTree = join(repo.root, '.worktrees', 'agflow', 'T-1');
    writeFileSync(join(firstTree, 'progress.txt'), 'half done\n');
    commitAll(firstTree, 'half');
    run(['git', 'push', '--quiet', 'origin', 'HEAD:refs/heads/agflow/T-1-parser'], firstTree);
    await call('release_task', { task_id: 'T-1', reason: 'end of day' }, first);
    const second = join(repo.dir, 'second');
    run(['git', 'clone', '--quiet', repo.origin, second], repo.dir);
    await call('claim_task', { id: 'T-1' }, as(hub.liveAgent('bob'), second));
    expect(readFileSync(join(second, '.worktrees', 'agflow', 'T-1', 'progress.txt'), 'utf8')).toBe('half done\n');
  });

  test('claiming outside a git repository is refused before anything changes', async () => {
    const hub = hubFixture();
    createTasks(hub.ctx, [newTask('Parser')], 'user:alice');
    const repo = tempRepo();
    await expect(call('claim_task', { id: 'T-1' }, as(hub.liveAgent('alice'), repo.dir))).rejects.toThrow('not inside a git repository');
    expect(getTask(hub.ctx, 'T-1').status).toBe('ready');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test packages/cli/test/tools-git.test.ts`
Expected: FAIL. There is no `claim_task` tool yet ("no tool claim_task").

- [ ] **Step 3: Create `packages/cli/src/mcp/task-git.ts`**

```ts
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { addExclude, defaultBranch, git, gitOk, slugify } from '../git';

export function taskWorktreePath(root: string, taskId: string): string {
  return join(root, '.worktrees', 'agflow', taskId);
}

export function taskBranchName(taskId: string, title: string): string {
  return `agflow/${taskId}-${slugify(title)}`;
}

export interface TaskWorktree {
  path: string;
  created: boolean;
  branchCreated: boolean;
}

/**
 * Creates (or reuses) the task's worktree. A new branch starts from the same branch on origin when a
 * previous holder pushed it, otherwise from origin's default branch (or the local one when offline).
 */
export function prepareTaskWorktree(root: string, taskId: string, branch: string): TaskWorktree {
  const path = taskWorktreePath(root, taskId);
  if (existsSync(path)) return { path, created: false, branchCreated: false };
  addExclude(root, '.worktrees/');
  const base = defaultBranch(root);
  const baseFetched = git(root, ['fetch', '--quiet', 'origin', base]).code === 0;
  const remoteBranch = git(root, ['fetch', '--quiet', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]).code === 0;
  const localBranch = git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).code === 0;
  if (localBranch) {
    gitOk(root, ['worktree', 'add', '--quiet', path, branch]);
  } else {
    const start = remoteBranch ? `origin/${branch}` : baseFetched ? `origin/${base}` : base;
    gitOk(root, ['worktree', 'add', '--quiet', '-b', branch, path, start]);
  }
  return { path, created: true, branchCreated: !localBranch };
}

export function removeTaskWorktree(root: string, worktree: TaskWorktree, branch: string): void {
  if (!worktree.created) return;
  git(root, ['worktree', 'remove', '--force', worktree.path]);
  if (worktree.branchCreated) git(root, ['branch', '-D', branch]);
}

/** Pushes the task branch and returns its head commit. Refuses uncommitted changes. */
export function pushTaskBranch(path: string, branch: string): string {
  const dirty = gitOk(path, ['status', '--porcelain']);
  if (dirty) throw new Error(`The task worktree has uncommitted changes. Commit them in ${path} first:\n${dirty}`);
  gitOk(path, ['push', '--quiet', '-u', 'origin', `HEAD:refs/heads/${branch}`]);
  return gitOk(path, ['rev-parse', 'HEAD']);
}
```

- [ ] **Step 4: Add the git tools to `packages/cli/src/mcp/tools.ts`**

Add these imports:

```ts
import { existsSync } from 'node:fs';
import { repoRoot } from '../git';
import { prepareTaskWorktree, pushTaskBranch, removeTaskWorktree, taskBranchName, taskWorktreePath } from './task-git';
```

Add before `export const allTools`:

```ts
export const gitTools: ToolDef[] = [
  defineTool(
    'claim_task',
    'Claim a ready task. agflow creates its branch in a separate git worktree inside this repository; do all work for the task there.',
    { id: TaskIdSchema },
    async ({ id }, ctx) => {
      const client = asAgent(ctx);
      const root = repoRoot(ctx.cwd);
      if (!root) throw new ToolError(`${ctx.cwd} is not inside a git repository, so agflow cannot create the task branch.`);
      const { task } = await client.task(id);
      const branch = task.branch ?? taskBranchName(task.id, task.title);
      const worktree = prepareTaskWorktree(root, task.id, branch);
      let claimed: Task;
      try {
        claimed = (await client.claim(id, branch)).task;
      } catch (error) {
        removeTaskWorktree(root, worktree, branch);
        throw error;
      }
      return lines([
        `You hold ${claimed.id}: ${claimed.title}`,
        `Work only inside ${worktree.path} (branch ${branch}). Commit there; submit pushes the branch.`,
        `Objective: ${claimed.objective}`,
        `Acceptance criteria:\n${claimed.acceptance.map((criterion) => `- ${criterion.id}: ${criterion.assertion}`).join('\n')}`,
        claimed.ownedPaths.length > 0 && `Change only: ${claimed.ownedPaths.join(', ')}`,
        claimed.feedback && `Latest review feedback: ${claimed.feedback}`,
      ]);
    },
  ),
  defineTool(
    'submit',
    'Submit your task for review. Commit all changes in the task worktree first; this pushes the branch and records its head commit.',
    {
      task_id: TaskIdSchema,
      summary: z.string().min(1).max(8000),
      evidence: z.array(z.string().min(1).max(2000)).max(50).optional(),
    },
    async ({ task_id, summary, evidence }, ctx) => {
      const client = asAgent(ctx);
      const { task } = await client.task(task_id);
      const root = repoRoot(ctx.cwd);
      const worktree = root ? taskWorktreePath(root, task_id) : null;
      const headSha = worktree && task.branch && existsSync(worktree) ? pushTaskBranch(worktree, task.branch) : undefined;
      const submitted = (await client.submit(task_id, { summary, evidence: evidence ?? [], branch: task.branch ?? undefined, headSha })).task;
      const where = headSha ? ` at ${headSha.slice(0, 7)} on ${task.branch}` : '';
      return `${submitted.id} is ${submitted.status}${where}. The lead will review it; you may claim another task.`;
    },
  ),
];
```

Change the `allTools` line to:

```ts
export const allTools: ToolDef[] = [...sharedTools, ...workerTools, ...gitTools];
```

> **Deviation from the snippets above (found in the final review):** `submit` makes two checks before any git work. (1) It refuses unless the caller still holds the task: `task.assignee` is its agent and the status is `claimed` or `working`. The hub refuses a non-holder only after the push, and a push from a chat whose lease expired lands on the branch the new holder works on, so that holder's own push is rejected. (2) For a task that has a branch, it checks that the branch is an agflow task branch and refuses when this repository has no worktree for the task, naming `resume_claim`. The snippet's "no worktree, no push" recorded a submission with `headSha` null for a branch that was never pushed. A task with no branch is still submitted without a push. Tests: `submit without the right to push` in `packages/cli/test/tools-git.test.ts`.

- [ ] **Step 5: Run tests and the typecheck**

Run: `bun test packages/cli && bun run typecheck`
Expected: all tests pass; `tsc` exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/cli
git commit -m "feat(cli): claim_task and submit with task worktrees, branches and push" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: MCP tools, part 3: lead tools

**Files:**
- Modify: `packages/cli/src/mcp/tools.ts`
- Test: `packages/cli/test/tools-lead.test.ts`

- [ ] **Step 1: Write the failing test `packages/cli/test/tools-lead.test.ts`**

```ts
import { describe, expect, test } from 'bun:test';
import { NewTaskSchema } from '@agflow/core';
import { getAgent } from '@agflow/hub/src/agents';
import { listGoalNotes, updateGoal } from '@agflow/hub/src/goal';
import { blockTask, claimTask, createTasks, getTask, submitTask } from '@agflow/hub/src/tasks';
import { type ToolContext, allTools } from '../src/mcp/tools';
import { type LiveAgent, hubFixture } from './fixture';

const call = (name: string, args: Record<string, unknown>, ctx: ToolContext) => {
  const found = allTools.find((t) => t.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found.run(args, ctx);
};
const as = (live: LiveAgent, role: 'lead' | 'worker'): ToolContext => ({ client: live.client, state: { agentId: live.agentId, role }, cwd: '/tmp' });
const spec = (title: string, dependsOn: string[] = []) => ({ title, objective: `Do ${title}`, acceptance: [{ id: 'A1', assertion: 'works' }], dependsOn });

describe('lead tools', () => {
  test('the lead plans with batch references; workers cannot', async () => {
    const hub = hubFixture();
    const lead = as(hub.liveAgent('alice', 'lead'), 'lead');
    const created = await call('create_tasks', { tasks: [NewTaskSchema.parse(spec('Schema')), NewTaskSchema.parse(spec('API', ['#1']))] }, lead);
    expect(created).toBe('Created:\nT-1 [ready] p5 Schema\nT-2 [blocked] p5 API · waiting on T-1');
    const worker = as(hub.liveAgent('bob'), 'worker');
    await expect(call('create_tasks', { tasks: [NewTaskSchema.parse(spec('x'))] }, worker)).rejects.toThrow('only the lead');
  });

  test('review: accept, reject, mark merged', async () => {
    const hub = hubFixture();
    const lead = as(hub.liveAgent('alice', 'lead'), 'lead');
    const worker = hub.liveAgent('bob');
    createTasks(hub.ctx, [NewTaskSchema.parse(spec('One')), NewTaskSchema.parse(spec('Two'))], 'user:alice');
    const bob = getAgent(hub.ctx, worker.agentId);
    claimTask(hub.ctx, 'T-1', bob);
    submitTask(hub.ctx, 'T-1', bob, { summary: 'done', evidence: [] });
    expect(await call('accept_task', { id: 'T-1', note: 'Nice.' }, lead)).toBe('Accepted T-1.');
    expect(await call('mark_merged', { id: 'T-1', sha: 'abc1234' }, lead)).toBe('T-1 is merged (abc1234).');
    claimTask(hub.ctx, 'T-2', getAgent(hub.ctx, worker.agentId));
    submitTask(hub.ctx, 'T-2', getAgent(hub.ctx, worker.agentId), { summary: 'done', evidence: [] });
    expect(await call('reject_task', { id: 'T-2', feedback: 'Add tests.' }, lead)).toBe(`Rejected T-2; it is claimed by ${worker.agentId} with your feedback.`);
  });

  test('update, cancel, unblock, goal notes, status and events', async () => {
    const hub = hubFixture();
    updateGoal(hub.ctx, { text: 'Goal', baseVersion: 0 }, 'user:alice');
    const lead = as(hub.liveAgent('alice', 'lead'), 'lead');
    const worker = hub.liveAgent('bob');
    createTasks(hub.ctx, [NewTaskSchema.parse(spec('One')), NewTaskSchema.parse(spec('Two'))], 'user:alice');
    expect(await call('update_task', { id: 'T-1', patch: { priority: 1 } }, lead)).toBe('Updated T-1: T-1 [ready] p1 One');
    expect(await call('cancel_task', { id: 'T-2', reason: 'not needed' }, lead)).toBe('Cancelled T-2.');
    claimTask(hub.ctx, 'T-1', getAgent(hub.ctx, worker.agentId));
    blockTask(hub.ctx, 'T-1', getAgent(hub.ctx, worker.agentId), 'need access');
    expect(await call('unblock_task', { id: 'T-1', note: 'access granted' }, lead)).toBe('T-1 is ready.');
    expect(await call('add_goal_note', { text: 'Reading the goal as CLI only.' }, lead)).toBe('Note added to goal v1.');
    expect(listGoalNotes(hub.ctx, 1).map((note) => note.text)).toEqual(['Reading the goal as CLI only.']);
    const status = await call('get_status', {}, lead);
    expect(status).toContain('Goal: v1');
    expect(status).toContain('Lead: A-1 (alice)');
    expect(await call('get_events', { limit: 3 }, lead)).toMatch(/^#1 /);
    expect(getTask(hub.ctx, 'T-1').priority).toBe(1);
  });

  test('all 27 tools are registered with unique names', () => {
    const names = allTools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toHaveLength(27);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test packages/cli/test/tools-lead.test.ts`
Expected: FAIL. There is no `create_tasks` tool yet.

- [ ] **Step 3: Add the lead tools to `packages/cli/src/mcp/tools.ts`**

Add `NewTaskSchema` and `TaskPatchSchema` to the `@agflow/core` import, then add before `export const allTools`:

```ts
export const leadTools: ToolDef[] = [
  defineTool(
    'get_status',
    'Project status: goal version, lead, task counts, active agents and recent messages to people.',
    {},
    async (_args, ctx) => {
      const status = await hub(ctx).status();
      const counts = Object.entries(status.counts).map(([state, n]) => `${state} ${n}`).join(' · ') || 'none';
      return lines([
        `Project: ${status.project.name}${status.project.paused ? ' (PAUSED)' : ''}`,
        `Goal: v${status.goalVersion}`,
        `Lead: ${status.lead ? `${status.lead.id} (${status.lead.user})` : 'none'}`,
        `Tasks: ${counts}`,
        `Active agents: ${status.activeAgents}`,
        status.humansInbox.length > 0 && `Messages to people:\n${formatMessages(status.humansInbox.slice(0, 5))}`,
      ]);
    },
  ),
  defineTool(
    'create_tasks',
    'Lead: create tasks from the goal. Each needs a title, an objective and acceptance criteria. Use "#1" in dependsOn to refer to an earlier task in the same call.',
    { tasks: z.array(NewTaskSchema).min(1).max(20) },
    async ({ tasks }, ctx) => {
      const created = await asAgent(ctx).createTasks(tasks);
      return `Created:\n${created.tasks.map(taskLine).join('\n')}`;
    },
  ),
  defineTool(
    'update_task',
    'Lead: change fields of an open task (title, objective, why, acceptance, checks, ownedPaths, dependsOn, priority, nonGoals, kind).',
    { id: TaskIdSchema, patch: TaskPatchSchema },
    async ({ id, patch }, ctx) => {
      const { task } = await asAgent(ctx).updateTask(id, patch);
      return `Updated ${task.id}: ${taskLine(task)}`;
    },
  ),
  defineTool(
    'cancel_task',
    'Lead: cancel a task, giving the reason. Its holder is told to stop.',
    { id: TaskIdSchema, reason: z.string().min(1).max(4000) },
    async ({ id, reason }, ctx) => {
      await asAgent(ctx).cancel(id, reason);
      return `Cancelled ${id}.`;
    },
  ),
  defineTool(
    'accept_task',
    'Lead: accept a submitted task.',
    { id: TaskIdSchema, note: z.string().min(1).max(4000).optional() },
    async ({ id, note }, ctx) => {
      await asAgent(ctx).accept(id, note);
      return `Accepted ${id}.`;
    },
  ),
  defineTool(
    'reject_task',
    'Lead: reject a submitted task with concrete feedback. It goes back to its author when possible.',
    { id: TaskIdSchema, feedback: z.string().min(1).max(8000) },
    async ({ id, feedback }, ctx) => {
      const { task } = await asAgent(ctx).reject(id, feedback);
      return task.status === 'claimed' ? `Rejected ${id}; it is claimed by ${task.assignee} with your feedback.` : `Rejected ${id}; it is ready for anyone.`;
    },
  ),
  defineTool(
    'unblock_task',
    'Lead: return a blocked task to the pool once its blocker is resolved.',
    { id: TaskIdSchema, note: z.string().min(1).max(4000).optional() },
    async ({ id, note }, ctx) => {
      const { task } = await asAgent(ctx).unblock(id, note);
      return task.status === 'ready' ? `${id} is ready.` : `${id} is still blocked: ${task.blockedReason ?? 'unknown reason'}.`;
    },
  ),
  defineTool(
    'mark_merged',
    'Lead: record that an accepted task was merged, optionally with the merge commit.',
    { id: TaskIdSchema, sha: z.string().regex(/^[0-9a-f]{7,40}$/).optional() },
    async ({ id, sha }, ctx) => {
      await asAgent(ctx).markMerged(id, sha);
      return `${id} is merged${sha ? ` (${sha})` : ''}.`;
    },
  ),
  defineTool(
    'add_goal_note',
    'Lead: record how you interpret the goal. People see the note next to the goal.',
    { text: z.string().min(1).max(4000) },
    async ({ text }, ctx) => {
      const note = await asAgent(ctx).addGoalNote(text);
      return `Note added to goal v${note.goalVersion}.`;
    },
  ),
  defineTool(
    'get_events',
    'Recent project events, oldest first, after the given event id.',
    { after: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(200).optional() },
    async ({ after, limit }, ctx) => {
      const { events } = await hub(ctx).events(after ?? 0, limit ?? 50);
      return events.length > 0
        ? events.map((event) => `#${event.id} ${new Date(event.ts).toISOString()} ${event.type}${event.subject ? ` ${event.subject}` : ''} by ${event.actor}`).join('\n')
        : 'No events.';
    },
  ),
];
```

Change the `allTools` line to:

```ts
export const allTools: ToolDef[] = [...sharedTools, ...workerTools, ...gitTools, ...leadTools];
```

- [ ] **Step 4: Run tests and the typecheck**

Run: `bun test packages/cli && bun run typecheck`
Expected: all tests pass; `tsc` exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/cli
git commit -m "feat(cli): MCP tools for the lead" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: The stdio MCP server

**Files:**
- Create: `packages/cli/src/mcp/server.ts`
- Modify: `packages/cli/src/main.ts`
- Test: `packages/cli/test/mcp-stdio.test.ts`

- [ ] **Step 1: Write the failing test `packages/cli/test/mcp-stdio.test.ts`**

It starts the real `agflow mcp` process and talks to it with the official MCP client over stdio, against a hub served on a random local port.

```ts
import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { saveCredentials } from '../src/credentials';
import { hubFixture } from './fixture';

const cleanEnv = (extra: Record<string, string>) => ({
  ...(Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)) as Record<string, string>),
  ...extra,
});

test('agflow mcp speaks MCP over stdio and binds the chat with hello', async () => {
  const hub = hubFixture();
  const server = Bun.serve({ port: 0, fetch: hub.app.fetch });
  const dir = mkdtempSync(join(tmpdir(), 'agflow-cfg-'));
  saveCredentials({ hubUrl: `http://localhost:${server.port}`, token: hub.tokenFor('alice'), user: 'alice' }, dir);
  const live = hub.liveAgent('alice');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(import.meta.dir, '..', 'src', 'main.ts'), 'mcp', '--vendor', 'claude'],
    env: cleanEnv({ AGFLOW_CONFIG_DIR: dir }),
    stderr: 'inherit',
  });
  const client = new Client({ name: 'agflow-test', version: '0.0.0' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(27);
    expect(tools.find((t) => t.name === 'claim_task')?.inputSchema.properties).toHaveProperty('id');
    const before = await client.callTool({ name: 'check_inbox', arguments: {} });
    expect(before.isError).toBe(true);
    const hello = await client.callTool({ name: 'hello', arguments: { code: live.helloCode } });
    expect(JSON.stringify(hello.content)).toContain(live.agentId);
    const inbox = await client.callTool({ name: 'check_inbox', arguments: {} });
    expect(inbox.isError).toBeFalsy();
    expect(JSON.stringify(inbox.content)).toContain('No new messages.');
    const invalid = await client.callTool({ name: 'get_task', arguments: { id: 'not-a-task' } });
    expect(invalid.isError).toBe(true);
  } finally {
    await client.close();
    server.stop(true);
  }
}, 30_000);
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test packages/cli/test/mcp-stdio.test.ts`
Expected: FAIL. `agflow mcp` is an unknown command, so the client cannot connect.

- [ ] **Step 3: Create `packages/cli/src/mcp/server.ts`**

```ts
import { AGFLOW_VERSION } from '@agflow/core';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { type ParsedArgs, choiceFlag } from '../args';
import { loadCredentials } from '../credentials';
import { HubClient, HubClientError } from '../hub-client';
import type { Io } from '../io';
import { configDir } from '../paths';
import { type ToolContext, type ToolDef, allTools } from './tools';

export function errorText(error: unknown): string {
  if (error instanceof HubClientError) return `agflow hub: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

export function createMcpServer(ctx: ToolContext, tools: ToolDef[] = allTools): McpServer {
  const server = new McpServer({ name: 'agflow', version: AGFLOW_VERSION });
  for (const tool of tools) {
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.input }, async (args: Record<string, unknown>) => {
      try {
        return { content: [{ type: 'text' as const, text: await tool.run(args, ctx) }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: errorText(error) }], isError: true };
      }
    });
  }
  return server;
}

/** Runs the bridge until the CLI that started it closes stdin. */
export async function mcpCommand(args: ParsedArgs, _io: Io): Promise<number> {
  choiceFlag(args, 'vendor', ['claude', 'codex'] as const, 'claude');
  const credentials = loadCredentials(configDir());
  const client = credentials ? new HubClient({ baseUrl: credentials.hubUrl, token: credentials.token }) : null;
  const server = createMcpServer({ client, state: { agentId: null, role: null }, cwd: process.cwd() });
  const closed = new Promise<void>((resolve) => {
    server.server.onclose = () => resolve();
    process.stdin.on('end', () => resolve());
  });
  await server.connect(new StdioServerTransport());
  await closed;
  return 0;
}
```

- [ ] **Step 4: Register the command in `packages/cli/src/main.ts`**

Add the import:

```ts
import { mcpCommand } from './mcp/server';
```

Add to the `commands` object:

```ts
  mcp: mcpCommand,
```

- [ ] **Step 5: Run tests and the typecheck**

Run: `bun test packages/cli && bun run typecheck`
Expected: all tests pass; `tsc` exits 0. If `registerTool` rejects `tool.input` at the type level, cast it as `inputSchema: tool.input as Record<string, z.ZodType>` and note it in your report.

- [ ] **Step 6: Commit**

```bash
git add packages/cli
git commit -m "feat(cli): stdio MCP server for the agflow bridge" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: End-to-end smoke test, the compiled binary and the README

**Files:**
- Create: `packages/cli/scripts/smoke.ts`
- Modify: `package.json` (scripts), `README.md`

The smoke test runs a real hub process and the real CLI in these steps:
1. Sign in with `agflow login`, approved through the hub's API.
2. Run `agflow join --vendor codex` in a temporary repository. That writes files only inside it, so the developer's real Claude configuration is untouched.
3. Feed the `SessionStart` hook a session id and read the brief.
4. Drive `agflow mcp` with the official MCP client: hello, list, claim, commit, submit.
5. Check that the hub recorded the pushed commit and that the Stop hook allows the chat to stop.

- [ ] **Step 1: Create `packages/cli/scripts/smoke.ts`**

```ts
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'agflow-smoke-cli-')));
const port = 8797;
const hubUrl = `http://localhost:${port}`;
const cli = join(import.meta.dir, '..', 'src', 'main.ts');
const hubMain = join(import.meta.dir, '..', '..', 'hub', 'src', 'main.ts');
const env: Record<string, string> = {
  ...(Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)) as Record<string, string>),
  AGFLOW_CONFIG_DIR: join(base, 'config'),
  AGFLOW_NO_BROWSER: '1',
};

function check(condition: unknown, what: string): asserts condition {
  if (!condition) throw new Error(`smoke check failed: ${what}`);
}

function sh(cmd: string[], cwd: string, input?: string): string {
  const result = Bun.spawnSync(cmd, { cwd, env, stdin: input === undefined ? 'ignore' : new TextEncoder().encode(input), stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(`${cmd.join(' ')} failed: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

const hub = Bun.spawn(['bun', hubMain], {
  env: {
    ...env,
    AGFLOW_AUTH: 'dev',
    AGFLOW_ALLOWED_USERS: 'alice',
    AGFLOW_PROJECT_NAME: 'smoke',
    AGFLOW_PROJECT_REPO: 'https://example.com/smoke.git',
    AGFLOW_PORT: String(port),
    AGFLOW_DB: join(base, 'hub.db'),
    AGFLOW_BACKUP_DIR: join(base, 'backups'),
  },
  stdout: 'ignore',
  stderr: 'inherit',
});

try {
  for (let attempt = 0; ; attempt++) {
    try {
      if ((await fetch(`${hubUrl}/api/auth-config`)).ok) break;
    } catch {
      // not listening yet
    }
    if (attempt > 50) throw new Error('the hub did not start');
    await Bun.sleep(100);
  }

  // A person signs in to the web UI, sets the goal and creates a task.
  const signIn = await fetch(`${hubUrl}/auth/dev?user=alice`, { redirect: 'manual' });
  const cookie = (signIn.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const web = (method: string, path: string, body?: unknown) =>
    fetch(`${hubUrl}${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  check((await web('PUT', '/api/goal', { text: 'Smoke goal', baseVersion: 0 })).ok, 'goal saved');
  const taskBody = { tasks: [{ title: 'Add greeting', objective: 'Add greeting.txt', acceptance: [{ id: 'A1', assertion: 'greeting.txt exists' }] }] };
  check((await web('POST', '/api/tasks', taskBody)).ok, 'task created');

  // agflow login prints a link; the person approves it.
  const login = Bun.spawn(['bun', cli, 'login', '--hub', hubUrl], { env, stdout: 'pipe', stderr: 'inherit' });
  const reader = login.stdout.getReader();
  let printed = '';
  while (!printed.includes('code=')) {
    const chunk = await reader.read();
    if (chunk.done) break;
    printed += new TextDecoder().decode(chunk.value);
  }
  reader.releaseLock();
  const code = printed.match(/code=([A-Za-z0-9_-]+)/)?.[1] ?? '';
  check(code, 'login printed a sign-in link');
  check((await web('POST', '/api/cli-login/approve', { code, label: 'smoke' })).ok, 'login approved');
  check((await login.exited) === 0, 'agflow login finished');

  // A repository joined for Codex.
  const origin = join(base, 'origin.git');
  const work = join(base, 'work');
  sh(['git', 'init', '--quiet', '--bare', '-b', 'main', origin], base);
  sh(['git', 'clone', '--quiet', origin, work], base);
  sh(['git', 'config', 'user.email', 'smoke@example.com'], work);
  sh(['git', 'config', 'user.name', 'Smoke'], work);
  writeFileSync(join(work, 'README.md'), '# smoke\n');
  sh(['git', 'add', '.'], work);
  sh(['git', 'commit', '--quiet', '-m', 'init'], work);
  sh(['git', 'push', '--quiet', '-u', 'origin', 'main'], work);
  check(sh(['bun', cli, 'join', '--vendor', 'codex', '--role', 'worker'], work).includes('Joined'), 'agflow join');

  // The SessionStart hook registers the chat and returns the brief with the hello code.
  const hook = (event: string, input: unknown) => sh(['bun', cli, 'hook', event, '--vendor', 'codex', '--role', 'worker'], work, JSON.stringify(input));
  const brief = (JSON.parse(hook('session-start', { session_id: 'smoke-session', cwd: work })) as { hookSpecificOutput: { additionalContext: string } })
    .hookSpecificOutput.additionalContext;
  const helloCode = brief.match(/code "([A-Z2-9]{6})"/)?.[1] ?? '';
  check(helloCode, 'the brief contains a hello code');

  // The MCP bridge: hello, list, claim, commit, submit.
  const transport = new StdioClientTransport({ command: 'bun', args: [cli, 'mcp', '--vendor', 'codex'], cwd: work, env, stderr: 'inherit' });
  const mcp = new Client({ name: 'agflow-smoke', version: '0.0.0' });
  await mcp.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await mcp.callTool({ name, arguments: args });
    const text = (result.content as Array<{ text?: string }>).map((part) => part.text ?? '').join('\n');
    if (result.isError) throw new Error(`${name}: ${text}`);
    return text;
  };
  check((await call('hello', { code: helloCode })).includes('Connected'), 'hello');
  check((await call('list_tasks', { status: ['ready'] })).includes('T-1'), 'list_tasks shows T-1');
  const worktree = join(work, '.worktrees', 'agflow', 'T-1');
  check((await call('claim_task', { id: 'T-1' })).includes(worktree), 'claim created the task worktree');
  writeFileSync(join(worktree, 'greeting.txt'), 'hello\n');
  sh(['git', 'add', '.'], worktree);
  sh(['git', 'commit', '--quiet', '-m', 'greeting'], worktree);
  check((await call('submit', { task_id: 'T-1', summary: 'Added greeting.txt' })).includes('submitted'), 'submit');
  await mcp.close();

  // The hub has the submission with the pushed commit, and the Stop hook lets the chat stop.
  const detail = (await (await web('GET', '/api/tasks/T-1')).json()) as { task: { status: string; submission: { headSha: string } } };
  check(detail.task.status === 'submitted', 'the task is submitted');
  check(sh(['git', 'rev-parse', 'refs/heads/agflow/T-1-add-greeting'], origin) === detail.task.submission.headSha, 'origin has the submitted commit');
  check(JSON.parse(hook('stop', { session_id: 'smoke-session', stop_hook_active: false })).decision === undefined, 'the stop hook allows stopping');
  console.log('smoke test passed: login, join, hooks, the MCP bridge, claim, push and submit work end to end');
} finally {
  hub.kill();
}
```

- [ ] **Step 2: Add the scripts to the root `package.json`**

Add to `"scripts"`:

```json
    "smoke:cli": "bun packages/cli/scripts/smoke.ts",
    "build:cli": "bun build --compile packages/cli/src/main.ts --outfile dist/agflow"
```

- [ ] **Step 3: Run the smoke test**

Run: `bun run smoke:cli`
Expected: the last line is `smoke test passed: login, join, hooks, the MCP bridge, claim, push and submit work end to end`.

- [ ] **Step 4: Build and check the compiled binary**

Run: `bun run build:cli && ./dist/agflow version && printf '{}' | ./dist/agflow hook stop --vendor claude`
Expected: the version (`0.1.0`), then `{}`.

- [ ] **Step 5: Document the CLI in `README.md`**

Add this section after "Run the hub locally":

````markdown
## Connect your Claude Code and Codex chats

Build the `agflow` command once, and put it on your PATH:

```bash
bun run build:cli
cp dist/agflow ~/.local/bin/agflow
```

Sign this computer in to your team's hub. A browser page opens; approve it after checking that it shows the same code as your terminal:

```bash
agflow login --hub https://agflow.example.com
```

In the project's repository, connect your chats (the lead uses `--role lead`):

```bash
agflow join --role worker --vendor both
```

- **Claude Code.** Start a new chat in the repository. It receives an agflow brief and the agflow tools.
- **Codex.** Trust the project if Codex asks, then run `/hooks` once and trust the three agflow hooks.

Each chat calls `hello` with the code from its brief, then works with `list_tasks`, `claim_task` and `submit`. A claimed task gets its own branch in `.worktrees/agflow/<task>`. `agflow leave` undoes `join`, and `agflow status` shows the hub, your account and the joined repositories.
````

Then add `bun run smoke:cli` to the Development block, after `bun run smoke:hub`:

```bash
bun run smoke:cli   # real hub + CLI: login, join, hooks, MCP bridge, claim, submit
```

- [ ] **Step 6: Run everything**

Run: `bun run typecheck && bun test && bun run smoke:hub && bun run smoke:cli`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add packages/cli package.json README.md
git commit -m "feat(cli): end-to-end smoke test, compiled binary and README" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: Optional check with the real `claude` and `codex` binaries

**Files:**
- Create: `packages/cli/scripts/verify-real-clis.ts`
- Modify: `package.json` (script)

This check drives the installed CLIs through one real round trip each:
1. The `SessionStart` hook delivers the brief.
2. The model calls `hello` and `list_tasks` through the bridge.
3. The model answers with the ready task's id.

It uses the developer's own Claude and Codex subscriptions for two short runs. For Claude it adds and then removes a local-scope MCP entry in `~/.claude.json` for a temporary directory. Run it once and report the result. A failure here is a finding to report, not a reason to change other tasks.

- [ ] **Step 1: Create `packages/cli/scripts/verify-real-clis.ts`**

```ts
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveCredentials } from '../src/credentials';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'agflow-real-')));
const port = 8796;
const hubUrl = `http://localhost:${port}`;
const cli = join(import.meta.dir, '..', 'src', 'main.ts');
const hubMain = join(import.meta.dir, '..', '..', 'hub', 'src', 'main.ts');
const configDir = join(base, 'config');

// A nested Claude Code refuses to start while variables from the parent session are set.
const env: Record<string, string> = Object.fromEntries(
  Object.entries(process.env).filter(([key, value]) => value !== undefined && key !== 'CLAUDECODE' && !key.startsWith('CLAUDE_CODE_')),
) as Record<string, string>;
env.AGFLOW_CONFIG_DIR = configDir;

const PROMPT =
  'Call the agflow MCP tool hello with the code from your agflow brief. Then call the agflow tool list_tasks with status ["ready"]. Reply with only the id of the first ready task, for example T-1.';

function sh(cmd: string[], cwd: string, timeout = 60_000): { code: number; out: string } {
  const result = Bun.spawnSync(cmd, { cwd, env, stdout: 'pipe', stderr: 'pipe', timeout });
  return { code: result.exitCode ?? 1, out: `${result.stdout.toString()}\n${result.stderr.toString()}` };
}

const hub = Bun.spawn(['bun', hubMain], {
  env: {
    ...env,
    AGFLOW_AUTH: 'dev',
    AGFLOW_ALLOWED_USERS: 'alice',
    AGFLOW_PROJECT_NAME: 'real-cli-check',
    AGFLOW_PROJECT_REPO: 'https://example.com/check.git',
    AGFLOW_PORT: String(port),
    AGFLOW_DB: join(base, 'hub.db'),
    AGFLOW_BACKUP_DIR: join(base, 'backups'),
  },
  stdout: 'ignore',
  stderr: 'inherit',
});

const results: string[] = [];
const work = join(base, 'work');
try {
  for (let attempt = 0; ; attempt++) {
    try {
      if ((await fetch(`${hubUrl}/api/auth-config`)).ok) break;
    } catch {
      // not listening yet
    }
    if (attempt > 50) throw new Error('the hub did not start');
    await Bun.sleep(100);
  }
  const signIn = await fetch(`${hubUrl}/auth/dev?user=alice`, { redirect: 'manual' });
  const cookie = (signIn.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const web = (method: string, path: string, body?: unknown) =>
    fetch(`${hubUrl}${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  await web('PUT', '/api/goal', { text: 'Check the real CLIs.', baseVersion: 0 });
  await web('POST', '/api/tasks', { tasks: [{ title: 'Say hello', objective: 'Nothing to change', acceptance: [{ id: 'A1', assertion: 'none' }] }] });

  // Sign the CLI in without a browser: approve a code directly.
  const code = 'realcheck'.padEnd(32, 'x');
  await web('POST', '/api/cli-login/approve', { code, label: 'real-cli-check' });
  const poll = (await (await fetch(`${hubUrl}/api/cli-login/poll?code=${code}`)).json()) as { token: string };
  saveCredentials({ hubUrl, token: poll.token, user: 'alice' }, configDir);

  sh(['git', 'init', '--quiet', '-b', 'main', work], base);
  writeFileSync(join(work, 'README.md'), '# check\n');
  sh(['git', 'add', '.'], work);
  sh(['git', '-c', 'user.email=check@example.com', '-c', 'user.name=Check', 'commit', '--quiet', '-m', 'init'], work);
  const joined = sh(['bun', cli, 'join', '--vendor', 'both', '--role', 'worker'], work);
  results.push(`join: ${joined.code === 0 ? 'ok' : `failed\n${joined.out}`}`);

  const claude = sh(
    ['claude', '-p', PROMPT, '--output-format', 'json', '--max-turns', '8', '--permission-mode', 'acceptEdits', '--allowedTools', 'mcp__agflow'],
    work,
    300_000,
  );
  results.push(`claude: exit ${claude.code}; answered T-1: ${claude.out.includes('T-1')}`);

  const codex = sh(
    ['codex', 'exec', '--json', '--dangerously-bypass-hook-trust', '-c', `projects."${work}".trust_level="trusted"`, PROMPT],
    work,
    300_000,
  );
  results.push(`codex: exit ${codex.code}; answered T-1: ${codex.out.includes('T-1')}`);

  const agents = (await (await web('GET', '/api/agents')).json()) as { agents: Array<{ id: string; vendor: string; lastSeenAt: number }> };
  results.push(`agents registered by hooks: ${agents.agents.map((a) => `${a.id}/${a.vendor}`).join(', ') || 'none'}`);
  if (claude.code !== 0) results.push(`claude output (first 2000 chars):\n${claude.out.slice(0, 2000)}`);
  if (codex.code !== 0) results.push(`codex output (first 2000 chars):\n${codex.out.slice(0, 2000)}`);
} finally {
  sh(['bun', cli, 'leave'], work);
  hub.kill();
  console.log(results.join('\n'));
}
```

> **Deviation from the snippet above (found in the review of batch 6):** its Codex line does not work with codex-cli 0.159.2. Codex splits the `-c` key on dots and keeps the quote characters in it, so `projects."<work>".trust_level="trusted"` leaves the repository untrusted, and Codex then ignores its `.codex/config.toml` and `.codex/hooks.json`. The script passes the inline-table form instead, `-c 'projects={"<work>"={trust_level="trusted"}}'`, built by `codexTrustOverride()` in `packages/cli/scripts/codex-trust.ts` and tested in `packages/cli/test/codex-trust.test.ts`. It replaces the `projects` table for that one run only.

- [ ] **Step 2: Add the script to the root `package.json`**

Add to `"scripts"`:

```json
    "verify:real-clis": "bun packages/cli/scripts/verify-real-clis.ts"
```

- [ ] **Step 3: Run it once**

Run: `bun run verify:real-clis`
Expected:
- `join: ok`;
- for each CLI, `exit 0` and `answered T-1: true`;
- `agents registered by hooks` lists one Claude agent and one Codex agent.

Report the exact output either way. If a CLI fails, include its error, check whether the cause is the environment (login, trust, nested session) or agflow, and fix agflow only if agflow is at fault.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/scripts/verify-real-clis.ts package.json
git commit -m "test(cli): optional round-trip check against the real claude and codex binaries" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## After the last task

- Push the branch and open a pull request to `main` titled `M1b: CLI, MCP bridge and hooks`.
- CI must be green: typecheck and all tests. The smoke scripts run locally.
- Report the output of `bun run verify:real-clis` in the pull request description.
