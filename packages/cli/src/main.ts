#!/usr/bin/env bun
import { AGFLOW_VERSION } from '@agflow/core';
import { type ParsedArgs, UsageError, parseArgs } from './args';
import { hookCommand } from './hooks';
import { type Io, stdio } from './io';
import { joinCommand, leaveCommand } from './join';
import { loginCommand, logoutCommand, statusCommand } from './login';
import { mcpCommand } from './mcp/server';

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

const commands: Record<string, Command> = {
  login: loginCommand,
  logout: logoutCommand,
  status: statusCommand,
  join: joinCommand,
  leave: leaveCommand,
  hook: hookCommand,
  mcp: mcpCommand,
};

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
