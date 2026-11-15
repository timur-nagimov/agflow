// The hub's operator token on the owner's laptop, for agflow start, which resets the hub's project through the
// operator routes. It is looked up in AGFLOW_OPERATOR_TOKEN, then in the macOS Keychain item agflow-operator, then in
// ~/.agflow/operator-token (mode 600). `agflow operator-token set` puts it in the Keychain.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type ParsedArgs, UsageError } from './args';
import type { Io } from './io';
import { type RunCommand, runCommand } from './run';

/** The Keychain item's service name. */
export const KEYCHAIN_SERVICE = 'agflow-operator';

export interface OperatorTokenDeps {
  env: Record<string, string | undefined>;
  /** The owner's home directory, where ~/.agflow is. */
  home: string;
  run: RunCommand;
}

export const defaultTokenDeps = (): OperatorTokenDeps => ({ env: process.env, home: homedir(), run: runCommand });

/** The token and where it was found, or null when none of the three places has one. */
export function findOperatorToken(deps: OperatorTokenDeps): { token: string; source: string } | null {
  const fromEnv = deps.env.AGFLOW_OPERATOR_TOKEN?.trim();
  if (fromEnv) return { token: fromEnv, source: 'AGFLOW_OPERATOR_TOKEN' };
  const keychain = deps.run(['security', 'find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], { env: deps.env });
  if (keychain.code === 0 && keychain.stdout.trim() !== '') {
    return { token: keychain.stdout.trim(), source: `the Keychain item ${KEYCHAIN_SERVICE}` };
  }
  const file = join(deps.home, '.agflow', 'operator-token');
  try {
    const token = readFileSync(file, 'utf8').trim();
    if (token !== '') return { token, source: file };
  } catch {
    // No file: no token here.
  }
  return null;
}

async function readStdin(): Promise<string> {
  return await new Response(Bun.stdin.stream()).text();
}

export const OPERATOR_TOKEN_HELP = `  agflow operator-token set     Keep the hub's operator token, read from standard input, in the Keychain
`;

/** `agflow operator-token set`: the token from standard input goes to the Keychain item, replacing an older one. */
export async function operatorTokenCommand(
  args: ParsedArgs,
  io: Io,
  deps: OperatorTokenDeps & { stdin?: () => Promise<string> } = defaultTokenDeps(),
): Promise<number> {
  if (args.positional[1] !== 'set' || args.positional.length > 2) {
    throw new UsageError('usage: agflow operator-token set < token-file');
  }
  const token = (await (deps.stdin ?? readStdin)()).trim();
  if (token.length < 32 || /\s/.test(token)) {
    throw new UsageError('give the operator token on standard input: one line, at least 32 characters');
  }
  const add = ['security', 'add-generic-password', '-U', '-a', 'agflow', '-s', KEYCHAIN_SERVICE, '-w', token];
  const stored = deps.run(add, { env: deps.env });
  if (stored.code !== 0) {
    io.err(`agflow: the Keychain refused the token: ${stored.stderr.trim() || `exit code ${stored.code}`}\n`);
    return 1;
  }
  io.out(`Stored the operator token in the Keychain item ${KEYCHAIN_SERVICE}.\n`);
  return 0;
}
