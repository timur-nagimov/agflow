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
