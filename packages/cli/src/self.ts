import { dirname, join } from 'node:path';

export interface SelfCommand {
  command: string;
  args: string[];
}

/**
 * How to start this CLI again: the compiled binary itself, or Bun running main.ts from source. Either way Bun loads no
 * bunfig.toml (whose preload runs code) and no .env from the working directory, which can be a clone an agent writes:
 * the runner's bridge and brief hook run outside the vendor sandbox. The source form says so with --no-env-file and
 * --config=/dev/null; the binary was compiled with --no-compile-autoload-bunfig and --no-compile-autoload-dotenv
 * (the root build:cli script).
 */
export function selfCommand(modulePath: string = import.meta.path, binary: string = process.execPath): SelfCommand {
  if (modulePath.startsWith('/$bunfs/') || modulePath.startsWith('B:/~BUN/')) return { command: binary, args: [] };
  return { command: binary, args: ['--no-env-file', '--config=/dev/null', join(dirname(modulePath), 'main.ts')] };
}

/** Quotes one argument for a POSIX shell (for configs that accept only a command string). */
export function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_\/.:=@%+-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function shellCommand(parts: string[]): string {
  return parts.map(shellQuote).join(' ');
}
