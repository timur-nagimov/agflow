// Everything app-server receives, built without a process (design 9.1, 9.2, 7.6, 15.1): the flags, the process
// environment and the thread overrides that thread/start and thread/resume both get. Test mode's codexConfig reaches
// Codex as -c flags; no Codex home's config.toml is ever written.
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { RunnerTestBlock } from '../../config';
import type { AgentLaunch } from '../types';
import type { ParamsOf } from './methods';
import type { JsonValue } from './protocol/serde_json/JsonValue';

// Disable ambient extensions and shell startup: commands must not source the owner's shell profile.
const APP_SERVER_ARGS = [
  'app-server',
  '--disable', 'hooks',
  '--disable', 'apps',
  '--disable', 'plugins',
  '--disable', 'remote_plugin',
  '-c', 'features.shell_snapshot=false',
  '-c', 'allow_login_shell=false',
];

// CLI keys cannot be quoted: Codex splits them on dots before parsing the TOML value.
const BARE_KEY = /^[A-Za-z0-9_-]+$/;

function basicString(value: string): string {
  const escaped = value.replace(/["\\\x00-\x1f\x7f]/g, (character) => {
    if (character === '"') return '\\"';
    if (character === '\\') return '\\\\';
    return `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`;
  });
  return `"${escaped}"`;
}

/** A TOML value, never a string fallback: invalid values must fail before starting Codex. */
export function tomlInline(value: JsonValue): string {
  if (value === null) throw new Error('TOML cannot represent null');
  switch (typeof value) {
    case 'string':
      return basicString(value);
    case 'boolean':
      return String(value);
    case 'number':
      if (!Number.isFinite(value)) throw new Error('TOML configuration requires finite numbers');
      return String(value);
    case 'object':
      if (Array.isArray(value)) return `[${value.map(tomlInline).join(', ')}]`;
      return `{ ${Object.entries(value)
        .filter(([, member]) => member !== undefined)
        .map(([key, member]) => `${BARE_KEY.test(key) ? key : basicString(key)} = ${tomlInline(member!)}`)
        .join(', ')} }`;
  }
}

/**
 * The arguments after the binary. testConfig is runner.json's test.codexConfig, which the caller passes only in test
 * mode (isTestMode); each top-level key becomes one -c flag.
 */
export function appServerArgs(testConfig?: RunnerTestBlock['codexConfig'] | null): string[] {
  const args = [...APP_SERVER_ARGS];
  for (const [key, value] of Object.entries(testConfig ?? {})) {
    if (!BARE_KEY.test(key)) throw new Error(`Codex configuration key must be a TOML bare key: ${JSON.stringify(key)}`);
    args.push('-c', `${key}=${tomlInline(value)}`);
  }
  return args;
}

export function appServerEnv(input: {
  base: Record<string, string | undefined>;
  bridgeEnv: Record<string, string>;
  codexHome: string;
  userHome: string;
}): Record<string, string> {
  return Object.fromEntries(
    Object.entries({
      ...input.base,
      ...input.bridgeEnv,
      CODEX_HOME: input.codexHome,
      HOME: input.userHome,
      // Codex's own git calls (thread start, per-turn metadata) run outside the sandbox, and the agent can write the
      // clone's .git/config: a planted filter driver would run unsandboxed. They must not find the repository.
      GIT_DIR: '/dev/null',
    })
      // X-10: managed-install markers only feed diagnostics; none belongs in the runner's process.
      .filter((entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith('CODEX_MANAGED_')),
  );
}

/** What thread/start and thread/resume both receive (design 9.2). */
export type CodexThreadOverrides = {
  cwd: string;
  model: string;
  sandbox: 'workspace-write';
  approvalPolicy: 'on-request';
  approvalsReviewer: 'user';
  developerInstructions: string;
  config: {
    projects: Record<string, { trust_level: 'trusted' | 'untrusted' }>;
    sandbox_workspace_write: {
      writable_roots: string[];
      network_access: boolean;
      exclude_slash_tmp: boolean;
      exclude_tmpdir_env_var: boolean;
    };
    shell_environment_policy: {
      inherit: 'all';
      exclude: string[];
      set: { HOME: string; TMPDIR: string };
    };
    mcp_servers: {
      agflow: {
        command: string;
        args: string[];
        cwd: string;
        env_vars: string[];
        default_tools_approval_mode: 'approve';
        required: boolean;
        tool_timeout_sec: number;
      };
    };
    web_search: 'cached' | 'disabled';
  };
};

/**
 * Code Mode defers MCP tools: exec's description does not list them, so a model meets them only in ALL_TOOLS. The
 * developer instructions name the role's bridge tools and how exec calls them, so the note survives compaction.
 */
export function codexToolsNote(names: readonly string[]): string {
  return (
    `Your agflow tools are ${names.map((name) => `mcp__agflow__${name}`).join(', ')}. Code Mode does not describe them in exec: call them inside exec as ` +
    'tools.mcp__agflow__<name>, as in `await tools.mcp__agflow__<name>({ ...arguments })`.'
  );
}

/**
 * bridgeCwd is the bridge's working directory: the codex-user home, which app-server itself runs in. Codex would
 * otherwise start the bridge in the thread's cwd, the clone, and Bun loads a bunfig.toml (its preload) and a .env from
 * there: repository or agent content would run in the bridge, outside the sandbox, with the agent token.
 */
export function threadOverrides(
  launch: Pick<AgentLaunch, 'clone' | 'model' | 'brief' | 'projectConfigVerified' | 'tmpDir' | 'bridge' | 'profile'>,
  bridgeCwd: string,
): CodexThreadOverrides {
  const clone = realpathSync(launch.clone);
  // Match the bridge's positiveMs rule without importing the CLI package.
  const pollMax = Number(launch.bridge.env.AGFLOW_BRIDGE_POLL_MAX_MS);
  const pollMaxMs = Number.isInteger(pollMax) && pollMax > 0 ? pollMax : 180_000;
  return {
    cwd: clone,
    model: launch.model,
    // Approvals always reach the person; commands start inside the workspace sandbox.
    sandbox: 'workspace-write',
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    developerInstructions: `${launch.brief}\n\n${codexToolsNote(launch.bridge.tools)}`,
    config: {
      // An explicit nested entry avoids implicit trust and loading unverified project configuration.
      projects: { [clone]: { trust_level: launch.projectConfigVerified ? 'trusted' : 'untrusted' } },
      sandbox_workspace_write: {
        // Codex protects .git by default; the agent must be able to commit inside its own clone.
        writable_roots: [join(clone, '.git')],
        network_access: false,
        exclude_slash_tmp: true,
        exclude_tmpdir_env_var: true,
      },
      shell_environment_policy: {
        // The base is already allowlisted. Bridge credentials stay out of tool commands, and the agent's git finds
        // the clone's repository again.
        inherit: 'all',
        exclude: ['AGFLOW_*', 'GIT_DIR'],
        set: { HOME: join(clone, '.agflow', 'run', 'home'), TMPDIR: launch.tmpDir },
      },
      mcp_servers: {
        agflow: {
          command: launch.bridge.command,
          args: [...launch.bridge.args],
          cwd: bridgeCwd,
          env_vars: Object.keys(launch.bridge.env),
          // The bridge must start successfully, and its tools do not require separate Codex approval.
          default_tools_approval_mode: 'approve',
          required: true,
          // Held submit/prepare calls include a final GET; allow 30 seconds beyond the polling budget.
          tool_timeout_sec: Math.ceil(pollMaxMs / 1000) + 30,
        },
      },
      // Opt-in search stays cached; it does not enable network access for shell commands.
      web_search: launch.profile.webTools ? 'cached' : 'disabled',
    },
  } satisfies CodexThreadOverrides & ParamsOf<'thread/start'> & Omit<ParamsOf<'thread/resume'>, 'threadId'>;
}
