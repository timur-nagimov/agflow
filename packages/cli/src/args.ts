export interface ParsedArgs {
  positional: string[];
  /** A flag given more than once with a value keeps every value, in order (listFlag); stringFlag reads the last. */
  flags: Record<string, string | true | string[]>;
}

export class UsageError extends Error {
  override name = 'UsageError';
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: ParsedArgs['flags'] = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      setFlag(flags, arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      setFlag(flags, arg.slice(2), next);
      i++;
    } else {
      flags[arg.slice(2)] = true;
    }
  }
  return { positional, flags };
}

/** A value of a flag given before joins the earlier ones. */
function setFlag(flags: ParsedArgs['flags'], name: string, value: string): void {
  const earlier = flags[name];
  if (earlier === undefined || earlier === true) flags[name] = value;
  else flags[name] = [...(Array.isArray(earlier) ? earlier : [earlier]), value];
}

export function stringFlag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags[name];
  if (Array.isArray(value)) return value.at(-1);
  return typeof value === 'string' ? value : undefined;
}

/** Every value of a flag that may be given more than once, in order. */
export function listFlag(args: ParsedArgs, name: string): string[] {
  const value = args.flags[name];
  if (Array.isArray(value)) return value;
  return typeof value === 'string' ? [value] : [];
}

export function choiceFlag<T extends string>(args: ParsedArgs, name: string, choices: readonly T[], fallback: T): T {
  const value = stringFlag(args, name) ?? fallback;
  if (!(choices as readonly string[]).includes(value)) throw new UsageError(`--${name} must be one of: ${choices.join(', ')}`);
  return value as T;
}
