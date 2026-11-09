// Claude's preflight (design 8.1, 6.1, 6.10, 7.6, 15.1, X-5, X-29): the pin's platform and binary, then a zero-model
// handshake whose only input is the local /clear command, run with the full session options in a scratch clone and
// base checkout, with a bridge whose hub URL refuses connections. On the same query it reads the account, the
// untyped getSettings() and the experimental usage call. It fails closed and gives facts only, with the quota and the
// weakened items; the runtime adds models, ceilings, allowPaidUsage, preflightAt and degraded.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Vendor, VendorQuota } from '@agflow/core';
import {
  type AccountInfo,
  type HookCallback,
  query,
  type SDKSystemMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { bridgeOf } from '../../attempt/launch';
import type { RunnerConfig } from '../../config';
import { buildAgentEnv } from '../../env';
import { makeAttemptTmpDir, type RunnerPaths } from '../../paths';
import { boundedWait } from '../../processes';
import { profileOf } from '../../profile';
import { runDirOf } from '../../run-dir';
import type { AgentLaunch, AgflowCommand, PreflightResult } from '../types';
import { checkAccount, checkEffectiveSettings, checkSystemInit } from './checks';
import { ClaudeInbox } from './inbox';
import { isRecord } from './json';
import { buildQueryOptions, claudeBinary, claudeTools, ensureClaudeEmptyDir } from './options';
import { claudeProjectDir } from './paths';
import { claudePin, readClaudeVersion, TMP_CLAUDE_DENYWRITE_ENFORCED } from './pin';
import { type QuotaBook, quotaFromUsage } from './quota';
import { createDetachedSpawn, type SpawnedClaude } from './spawn';

/** The weakened item of the auto profile: agents run in auto mode, which the account offers (7.6, X-29). */
export const CLAUDE_WEAKENED_AUTO = 'auto';

/** The weakened item of a pin whose sandbox does not enforce the denyWrite of the shared /tmp/claude (8.1, X-29). */
export const CLAUDE_WEAKENED_TMP = '/tmp/claude';

/**
 * The hub URL of the handshake's bridge: nothing listens on the discard port, so the connection is refused at once
 * and no hub ever sees the handshake.
 */
export const PREFLIGHT_HUB_URL = 'http://127.0.0.1:9';

/**
 * How long the handshake gets: a cold exec of the CLI, its sandbox and the bridge starting, and the usage call's round
 * trip. Its own bound, not runner.json's link handshake timing, which bounds the hub's hello and welcome (6.3).
 */
export const CLAUDE_PREFLIGHT_TIMEOUT_MS = 60_000;

/** How long the handshake waits for the CLI to exit once it is closed. */
const EXIT_WAIT_MS = 5_000;

/** How long a failed handshake waits for the rest of the CLI's stderr: an escaped child may hold it open. */
const STDERR_WAIT_MS = 1_000;

export interface ClaudePreflightInput {
  agflow: AgflowCommand;
  config: RunnerConfig;
  paths: RunnerPaths;
  /** vendorHomes(config, paths): the Claude home is the handshake's CLAUDE_CONFIG_DIR. */
  vendorHomes: Record<Vendor, string>;
  /** `<os>-<arch>`; the pin decides whether the platform is supported. */
  platform: string;
  /** The adapter's last quota per account: preflight's quota falls back to it, and updates it. */
  quota: QuotaBook;
  /** Test mode (15.1): ready with test mode's identity, the scripted server's API key accepted. */
  skipAuthChecks: boolean;
  /** CLAUDE_PREFLIGHT_TIMEOUT_MS by default. */
  timeoutMs?: number;
  /** TMP_CLAUDE_DENYWRITE_ENFORCED by default. */
  tmpClaudeDenyWriteEnforced?: boolean;
  /** The runner's environment, for buildAgentEnv's user variables and test mode; process.env by default. */
  env?: Record<string, string | undefined>;
  now?: () => number;
}

export interface ClaudePreflightOutcome extends PreflightResult {
  /** Whether the account offered auto mode to an auto-profile handshake; later starts run auto only then. */
  autoOffered: boolean;
}

type Facts = PreflightResult['facts'];

/** Preflight; it never throws: anything that goes wrong is a vendor that is not ready, with the reason. */
export async function claudePreflight(input: ClaudePreflightInput): Promise<ClaudePreflightOutcome> {
  const weakened = (input.tmpClaudeDenyWriteEnforced ?? TMP_CLAUDE_DENYWRITE_ENFORCED) ? [] : [CLAUDE_WEAKENED_TMP];
  const ownerCliVersion = await ownerClaudeVersion(input.config.capturedPath);
  const base: Facts = {
    vendor: 'claude',
    cliVersion: null,
    ownerCliVersion,
    ready: false,
    problem: null,
    accountId: null,
    plan: null,
    managedPolicy: false,
  };
  const notReady = (problem: string, cliVersion: string | null = null): ClaudePreflightOutcome => ({
    facts: { ...base, cliVersion, problem },
    quota: null,
    weakened,
    autoOffered: false,
  });

  const pin = claudePin(input.platform);
  if (pin === null) return notReady('unsupported platform');
  const version = await readClaudeVersion(claudeBinary(input.paths, pin.version), pin.version, {
    env: { PATH: input.config.capturedPath },
  });
  if (!version.ok) return notReady(version.problem, version.version);

  const facts = { ...base, cliVersion: pin.version };
  if (profileOf(input.config).name === 'auto') {
    // Auto first; when the account does not offer it, or that handshake fails, the standard one decides.
    const auto = await handshake(input, pin.version, true);
    if (auto.facts.ready) return outcome(input, facts, auto, [...weakened, CLAUDE_WEAKENED_AUTO]);
  }
  return outcome(input, facts, await handshake(input, pin.version, false), weakened);
}

interface HandshakeResult {
  facts: Pick<Facts, 'ready' | 'problem' | 'accountId' | 'plan'>;
  usage: unknown;
  autoOffered: boolean;
}

function outcome(
  input: ClaudePreflightInput,
  facts: Facts,
  result: HandshakeResult,
  weakened: string[],
): ClaudePreflightOutcome {
  const accountId = result.facts.accountId;
  // The usage call's quota; a failure or another shape leaves the last one the adapter knows for the account.
  const fresh = quotaFromUsage(result.usage, (input.now ?? Date.now)());
  const quota: VendorQuota | null = fresh !== null ? input.quota.update(accountId, fresh) : input.quota.last(accountId);
  return { facts: { ...facts, ...result.facts }, quota, weakened, autoOffered: result.autoOffered };
}

/**
 * One handshake in a scratch clone; a crash, a timeout or a scratch directory that cannot be made is a problem, never
 * an exception. A scratch directory that cannot be removed is left behind: it holds no secret.
 */
async function handshake(input: ClaudePreflightInput, cliVersion: string, auto: boolean): Promise<HandshakeResult> {
  let root: string | null = null;
  let tmpDir: string | null = null;
  try {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'agflow-preflight-')));
    const clone = join(root, 'clone');
    const baseCheckout = join(root, 'base');
    const tools = join(root, 'tools');
    tmpDir = makeAttemptTmpDir();
    for (const dir of [clone, baseCheckout, tools, runDirOf(clone, tools).config]) mkdirSync(dir, { recursive: true });
    ensureClaudeEmptyDir(input.vendorHomes.claude);
    const launch = handshakeLaunch(input, { clone, baseCheckout, tools, tmpDir, cliVersion, logDir: root });
    return await runHandshake(input, launch, auto);
  } catch (error) {
    return failed(`the handshake failed: ${(error as Error).message}`);
  } finally {
    const scratch = root;
    const tmp = tmpDir;
    // /clear leaves a transcript in the scratch clone's project directory; nothing else of it is kept.
    if (scratch !== null) removeQuietly(() => claudeProjectDir(input.vendorHomes.claude, join(scratch, 'clone')));
    if (tmp !== null) removeQuietly(() => tmp);
    if (scratch !== null) removeQuietly(() => scratch);
  }
}

/** Removes a directory, retrying while a CLI that outlived the handshake still writes in it; a failure is left be. */
function removeQuietly(path: () => string): void {
  try {
    rmSync(path(), { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // A slug the CLI would hash has no project directory; anything else stays behind in the temporary directory.
  }
}

function handshakeLaunch(
  input: ClaudePreflightInput,
  scratch: { clone: string; baseCheckout: string; tools: string; tmpDir: string; cliVersion: string; logDir: string },
): AgentLaunch {
  const spec = { attemptId: 'preflight', role: 'worker' as const, agentToken: 'preflight', hubUrl: PREFLIGHT_HUB_URL };
  const env = buildAgentEnv({
    vendor: 'claude',
    spec,
    clone: scratch.clone,
    tools: scratch.tools,
    tmpDir: scratch.tmpDir,
    config: input.config,
    paths: input.paths,
    base: input.env,
    env: input.env,
  });
  return {
    attemptId: spec.attemptId,
    role: spec.role,
    model: input.config.models.claude.worker,
    cliVersion: scratch.cliVersion,
    clone: scratch.clone,
    baseCheckout: scratch.baseCheckout,
    projectConfigVerified: true,
    tmpDir: scratch.tmpDir,
    env,
    bridge: bridgeOf(input.agflow, 'claude', env),
    profile: profileOf(input.config),
    brief: '',
    firstPrompt: '/clear',
    resume: null,
    logFile: join(scratch.logDir, 'handshake.log'),
    registerProcess: () => {},
  };
}

const noHook: HookCallback = async () => ({});

async function runHandshake(input: ClaudePreflightInput, launch: AgentLaunch, auto: boolean): Promise<HandshakeResult> {
  const inbox = new ClaudeInbox<SDKUserMessage>();
  let proc: SpawnedClaude | null = null;
  const spawn = createDetachedSpawn({
    registerProcess: launch.registerProcess,
    logFile: launch.logFile,
    onSpawn: (spawned) => {
      proc = spawned;
    },
  });
  const options = buildQueryOptions(launch, {
    agflow: input.agflow,
    paths: input.paths,
    vendorHomes: input.vendorHomes,
    autoOffered: auto,
    spawnClaudeCodeProcess: spawn,
    compaction: { preCompact: noHook, postCompact: noHook },
  });
  const abortController = new AbortController();
  const clear: SDKUserMessage = {
    type: 'user',
    message: { role: 'user', content: '/clear' },
    parent_tool_use_id: null,
    uuid: randomUUID(),
  };
  inbox.push(clear);
  const q = query({ prompt: inbox, options: { ...options, abortController } });
  const timeoutMs = input.timeoutMs ?? CLAUDE_PREFLIGHT_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs} ms`)), timeoutMs);
  });
  const answers = (async () => {
    const initialization = await q.initializationResult();
    // Untyped in sdk.d.ts 0.3.285, like cancelQueued (8.1).
    const settings = await (q as unknown as { getSettings(): Promise<unknown> }).getSettings();
    const usage = await q
      .usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })
      .catch(() => null);
    let init: SDKSystemMessage | null = null;
    for await (const frame of q) {
      if (frame.type === 'system' && frame.subtype === 'init') init = frame;
      if (frame.type === 'result') break;
    }
    return { account: initialization.account, settings, usage, init };
  })();
  // After a timeout nobody waits for the answers any more.
  answers.catch(() => {});
  try {
    return judge(input, launch, auto, await Promise.race([answers, timeout]));
  } catch (error) {
    // A CLI that hangs or ends early: its group ends now, without close()'s grace.
    abortController.abort();
    // Read to its end first, so the reason holds the CLI's last lines.
    const spawned = proc as SpawnedClaude | null;
    if (spawned !== null) await boundedWait(spawned.stderrRead, STDERR_WAIT_MS);
    const stderr = spawned?.stderrTail().trim() ?? '';
    const reason = [(error as Error).message, stderr].filter((part) => part !== '').join(': ');
    return failed(`the handshake failed: ${reason}`);
  } finally {
    clearTimeout(timer);
    // Stdin EOF ends the CLI once /clear is done.
    inbox.end();
    q.close();
    const exited = (proc as SpawnedClaude | null)?.exited;
    if (exited) await boundedWait(exited, EXIT_WAIT_MS);
  }
}

/** What the handshake found: the account, then system/init and the sandbox settings, as one list of problems. */
function judge(
  input: ClaudePreflightInput,
  launch: AgentLaunch,
  auto: boolean,
  found: { account: AccountInfo | undefined; settings: unknown; usage: unknown; init: SDKSystemMessage | null },
): HandshakeResult {
  const account = checkAccount(found.account, { skipAuthChecks: input.skipAuthChecks });
  const problems: string[] = [];
  if (!account.ready && account.problem !== null) problems.push(account.problem);
  if (found.init === null) {
    problems.push('the handshake gave no system/init');
  } else {
    problems.push(
      ...checkSystemInit(found.init, {
        cliVersion: launch.cliVersion,
        permissionMode: auto ? 'auto' : 'acceptEdits',
        tools: claudeTools(launch.profile),
        skipAuthChecks: input.skipAuthChecks,
      }),
    );
  }
  problems.push(...checkEffectiveSettings(isRecord(found.settings) ? found.settings.effective : undefined));
  const ready = problems.length === 0;
  return {
    facts: {
      ready,
      problem: ready ? account.problem : problems.join('; '),
      accountId: account.accountId,
      plan: account.plan,
    },
    usage: found.usage,
    autoOffered: auto && ready,
  };
}

function failed(problem: string): HandshakeResult {
  return { facts: { ready: false, problem, accountId: null, plan: null }, usage: null, autoOffered: false };
}

/** The version of the owner's own claude, the first on the captured login PATH; null without one. */
async function ownerClaudeVersion(capturedPath: string): Promise<string | null> {
  for (const dir of capturedPath.split(':')) {
    if (dir === '') continue;
    const bin = join(dir, 'claude');
    try {
      if (!existsSync(bin) || !statSync(bin).isFile()) continue;
    } catch {
      continue;
    }
    const found = await readClaudeVersion(bin, null, { env: { PATH: capturedPath } });
    return found.version;
  }
  return null;
}
