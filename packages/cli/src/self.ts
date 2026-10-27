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
