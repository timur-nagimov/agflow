// The guard's verdict on Bash commands (design 8.2, boundaries 1 and 4 of section 5). The network boundary is the
// control: agents have no route to the git host and no credentials. This layer refuses the commands that would only
// make sense if one of those failed, so a refusal tells the agent at once instead of after a network timeout.
import { posix } from 'node:path';
import { type ShellRedirect, splitShellCommands } from './shell-words';

export type Verdict = { allow: true } | { allow: false; reason: string };

const ALLOW: Verdict = { allow: true };

/** sh -c inside eval inside sh -c …: past this depth the command is refused as unparseable. */
const MAX_DEPTH = 16;

class Unparseable extends Error {}

export function bashVerdict(command: string): Verdict {
  try {
    const reason = judgeScript(command, 0);
    return reason === null ? ALLOW : { allow: false, reason };
  } catch (error) {
    if (error instanceof Unparseable) {
      return { allow: false, reason: `the command cannot be parsed (${error.message}), so it is refused` };
    }
    throw error;
  }
}

const GIT_WRITE_REFUSED = 'writing into .git/hooks or .git/config is refused';

/**
 * A name as macOS's case-insensitive volumes compare it, the fold core's protected paths use: `GIT` runs git and
 * `.GIT/Hooks` is .git/hooks there. Decomposing turns the Kelvin sign into K, and upper-casing between two
 * lower-casings folds ſ to s and ı to i.
 */
export function foldCase(text: string): string {
  return text.normalize('NFD').toLowerCase().toUpperCase().toLowerCase();
}

function judgeScript(source: string, depth: number): string | null {
  if (depth > MAX_DEPTH) throw new Unparseable('shells nested too deeply');
  const split = splitShellCommands(source);
  if (!split.ok) throw new Unparseable(split.problem);
  for (const command of split.commands) {
    const reason = judgeRedirects(command.redirects) ?? judgeWords(command.words, command.redirects, depth);
    if (reason !== null) return reason;
  }
  return null;
}

const WRITING_REDIRECTS = new Set(['>', '>>', '>|', '&>', '&>>', '<>']);

function judgeRedirects(redirects: ShellRedirect[]): string | null {
  for (const { op, target } of redirects) {
    // >&2 duplicates a descriptor; >&file (any other word) writes the file.
    const writes = WRITING_REDIRECTS.has(op) || (op === '>&' && !/^(\d+|-)$/.test(target));
    if (writes && writesGitFile(target)) return GIT_WRITE_REFUSED;
  }
  return null;
}

/** Keywords that may precede a command name in a simple command as the lexer splits it. */
const RESERVED = new Set(['!', '{', '}', 'if', 'then', 'elif', 'else', 'while', 'until', 'do']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;

function judgeWords(words: string[], redirects: ShellRedirect[], depth: number): string | null {
  let start = 0;
  for (;;) {
    const word = words[start];
    // `function f { …; }`, zsh's `repeat 3 …` and bash's `coproc NAME { …; }` put one word before the command.
    if (word === 'function' || word === 'repeat' || (word === 'coproc' && RESERVED.has(words[start + 2] ?? ''))) {
      start += 2;
    } else if (word !== undefined && (RESERVED.has(word) || word === 'coproc')) start += 1;
    else break;
  }
  return judgeArgv(words.slice(start), redirects, depth);
}

/**
 * Commands that run their arguments as a command, with the options that take a value. Anything else that starts with
 * a dash is a flag. `positionals` counts the arguments between the options and the command (timeout's duration).
 */
const WRAPPERS: Record<string, { valued: string[]; positionals?: number }> = {
  // zsh's precommand modifiers; zsh is the default shell the Bash tool runs commands in on macOS.
  '-': { valued: [] },
  noglob: { valued: [] },
  nocorrect: { valued: [] },
  builtin: { valued: [] },
  exec: { valued: ['-a'] },
  nohup: { valued: [] },
  time: { valued: [] },
  nice: { valued: ['-n', '--adjustment'] },
  timeout: { valued: ['-s', '-k', '--signal', '--kill-after'], positionals: 1 },
  gtimeout: { valued: ['-s', '-k', '--signal', '--kill-after'], positionals: 1 },
  sudo: {
    valued: ['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-U', '-T', '--user', '--group', '--host', '--prompt'],
  },
  doas: { valued: ['-u', '-C'] },
  xargs: {
    valued: ['-I', '-J', '-L', '-n', '-P', '-s', '-E', '-d', '-R', '-S', '-a', '--arg-file', '--delimiter'],
  },
  stdbuf: { valued: ['-i', '-o', '-e', '--input', '--output', '--error'] },
  caffeinate: { valued: ['-t', '-w'] },
  setsid: { valued: [] },
  arch: { valued: [] },
};

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'fish']);

/** Every git command that sends objects to a remote. */
const GIT_PUSHERS = new Set(['push', 'send-pack', 'http-push']);
/** git's own options before the subcommand that take a separate value. */
const GIT_VALUED = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--super-prefix',
  '--config-env',
  '--attr-source',
]);

const REFUSED_PROGRAMS: Record<string, string> = {
  gh: 'gh is refused: agents reach the hub only through the agflow tools',
  glab: 'glab is refused: agents reach the hub only through the agflow tools',
  security: 'security is refused: agents may not use the keychain',
};

/**
 * A simple command's words after the keywords. `redirects` are the command's own, which a shell started without a
 * script reads its script from.
 */
function judgeArgv(argv: string[], redirects: ShellRedirect[], depth: number): string | null {
  let start = 0;
  while (start < argv.length && ASSIGNMENT.test(argv[start] as string)) start += 1;
  const program = argv[start];
  if (program === undefined) return null;
  // zsh expands `=git` to git's path; case-insensitive volumes find `GIT` as git.
  const name = foldCase(posix.basename(program.replace(/^=/, '')));
  // `$g push` or `$(echo git) push` names its program only when it runs, so the guard cannot judge it.
  if (/[$`]/.test(name)) throw new Unparseable(`the command name ${program} is computed when it runs`);
  const args = argv.slice(start + 1);
  const refused = REFUSED_PROGRAMS[name];
  if (refused !== undefined) return refused;
  if (name === 'git') return judgeGit(args, depth);
  if (name.startsWith('git-')) return judgeGitSubcommand(name.slice(4), args, depth);
  if (name === 'env') return judgeEnv(args, redirects, depth);
  if (name === 'command') return judgeCommandBuiltin(args, redirects, depth);
  if (name === 'eval') return judgeScript(args.join(' '), depth + 1);
  if (SHELLS.has(name)) return judgeShell(name, args, redirects, depth);
  if (name === 'find') return judgeFind(args, depth);
  if (name === 'cp' || name === 'mv' || name === 'ln' || name === 'install') return judgeCopy(name, args);
  if (name === 'tee') return judgeTee(args);
  if (name === 'sed') return judgeSed(args);
  const wrapper = WRAPPERS[name];
  if (wrapper) {
    const index = skipOptions(args, wrapper.valued) + (wrapper.positionals ?? 0);
    return judgeArgv(args.slice(index), redirects, depth);
  }
  return null;
}

/** The index of the first argument after the options; `--` ends them. */
function skipOptions(args: string[], valued: string[]): number {
  let index = 0;
  while (index < args.length) {
    const arg = args[index] as string;
    if (arg === '--') return index + 1;
    if (!arg.startsWith('-') || arg === '-') return index;
    index += valued.includes(arg) ? 2 : 1;
  }
  return index;
}

function judgeGit(args: string[], depth: number): string | null {
  let index = 0;
  while (index < args.length) {
    const arg = args[index] as string;
    if (!arg.startsWith('-')) break;
    const value = GIT_VALUED.has(arg) ? args[index + 1] : arg.startsWith('--config-env=') ? arg.slice(13) : undefined;
    // An alias can name any command, push included.
    if ((arg === '-c' || arg.startsWith('--config-env')) && value !== undefined && isAliasKey(value)) {
      return 'git -c alias.* is refused: an alias could run git push';
    }
    index += GIT_VALUED.has(arg) ? 2 : 1;
  }
  const subcommand = args[index];
  return subcommand === undefined ? null : judgeGitSubcommand(subcommand, args.slice(index + 1), depth);
}

function isAliasKey(setting: string): boolean {
  return (setting.split('=')[0] as string).toLowerCase().startsWith('alias.');
}

function judgeGitSubcommand(subcommand: string, args: string[], depth: number): string | null {
  // Claude's own Bash deny rules miss `v=push; git "$v"` and `git "$(printf push)"`, even without a Bash allow
  // rule. As with a computed program name, do not guess which git operation an expansion will select.
  if (/[$`]/.test(subcommand)) throw new Unparseable(`the git subcommand ${subcommand} is computed when it runs`);
  if (GIT_PUSHERS.has(subcommand)) return `git ${subcommand} is refused: only the runner pushes`;
  if (subcommand === 'subtree' && args.includes('push')) return 'git subtree push is refused: only the runner pushes';
  if (subcommand === 'credential' || subcommand.startsWith('credential-')) {
    return 'git credential is refused: agents get no git credentials';
  }
  if (subcommand === 'config' && args.includes('--global')) {
    return "git config --global is refused: agents may not change the owner's git config";
  }
  // The lasting twin of `git -c alias.*`.
  if (subcommand === 'config' && args.some(isAliasKey)) {
    return 'git config alias.* is refused: an alias could run git push';
  }
  // Commands git runs itself.
  if (subcommand === 'bisect' && args[0] === 'run') return judgeArgv(args.slice(1), [], depth);
  if (subcommand === 'submodule') {
    const foreach = args.indexOf('foreach');
    if (foreach < 0) return null;
    const script = args.slice(foreach + 1).filter((arg) => !['--recursive', '-q', '--quiet'].includes(arg));
    return judgeScript(script.join(' '), depth + 1);
  }
  if (subcommand === 'rebase') {
    for (const script of rebaseExecs(args)) {
      const reason = judgeScript(script, depth + 1);
      if (reason !== null) return reason;
    }
  }
  return null;
}

/** The commands of `git rebase -x <cmd>`, `--exec <cmd>`, `--exec=<cmd>` and `-x<cmd>`. */
function rebaseExecs(args: string[]): string[] {
  const scripts: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === '--') break;
    if (arg === '-x' || arg === '--exec') {
      scripts.push(args[index + 1] ?? '');
      index += 1;
    } else if (arg.startsWith('--exec=')) scripts.push(arg.slice(7));
    else if (arg.startsWith('-x')) scripts.push(arg.slice(2));
  }
  return scripts;
}

const ENV_FLAGS = new Set(['-i', '-', '-0', '-v', '--ignore-environment', '--null', '--debug']);
const ENV_VALUED = new Set(['-u', '-P', '-C', '--unset', '--chdir']);

function judgeEnv(args: string[], redirects: ShellRedirect[], depth: number): string | null {
  let index = 0;
  while (index < args.length) {
    const arg = args[index] as string;
    if (arg === '--') {
      index += 1;
      break;
    }
    if (!arg.startsWith('-')) break;
    // -S splits its string into the command and its first arguments.
    const separate = arg === '-S' || arg === '--split-string';
    const joined = arg.startsWith('--split-string=') ? arg.slice(15) : /^-S./.test(arg) ? arg.slice(2) : undefined;
    const split = separate ? args[index + 1] : joined;
    if (split !== undefined) {
      const rest = args.slice(index + (separate ? 2 : 1));
      return judgeScript([split, ...rest.map(shellQuote)].join(' '), depth + 1);
    }
    if (ENV_FLAGS.has(arg) || /^--(unset|chdir)=/.test(arg) || /^-[uPC]./.test(arg)) index += 1;
    else if (ENV_VALUED.has(arg)) index += 2;
    else throw new Unparseable(`unknown env option ${arg}`);
  }
  return judgeArgv(args.slice(index), redirects, depth);
}

function judgeCommandBuiltin(args: string[], redirects: ShellRedirect[], depth: number): string | null {
  let index = 0;
  while (index < args.length && /^-[pvV]+$/.test(args[index] as string)) {
    // command -v and -V only look the name up.
    if (/[vV]/.test(args[index] as string)) return null;
    index += 1;
  }
  if (args[index] === '--') index += 1;
  return judgeArgv(args.slice(index), redirects, depth);
}

/** A shell runs the script after -c, else a script file, else (and with -s) its standard input. */
function judgeShell(name: string, args: string[], redirects: ShellRedirect[], depth: number): string | null {
  let index = 0;
  let command = false;
  let stdin = false;
  while (index < args.length) {
    const arg = args[index] as string;
    if (arg === '--' || arg === '-') {
      index += 1;
      break;
    }
    if (!arg.startsWith('-') && !arg.startsWith('+')) break;
    if (arg.startsWith('--')) {
      index += arg === '--rcfile' || arg === '--init-file' ? 2 : 1;
      continue;
    }
    const letters = arg.slice(1);
    if (letters.includes('c')) command = true;
    if (letters.includes('s')) stdin = true;
    // -o and +o name a shell option, as bash's -O and +O do.
    index += /[oO]/.test(letters) ? 2 : 1;
  }
  if (command) {
    const script = args[index];
    if (script === undefined) throw new Unparseable(`${name} -c without a command`);
    return judgeScript(script, depth + 1);
  }
  if (!stdin && index < args.length) return null;
  // The script on standard input, as far as the command line holds it: the last here-document or here-string.
  const input = redirects.findLast((redirect) => ['<<', '<<-', '<<<'].includes(redirect.op));
  if (input === undefined) return null;
  return judgeScript(input.op === '<<<' ? input.target : (input.body ?? ''), depth + 1);
}

function judgeFind(args: string[], depth: number): string | null {
  for (let index = 0; index < args.length; index += 1) {
    if (!['-exec', '-execdir', '-ok', '-okdir'].includes(args[index] as string)) continue;
    const end = args.findIndex((arg, at) => at > index && (arg === ';' || arg === '+'));
    const reason = judgeArgv(args.slice(index + 1, end < 0 ? args.length : end), [], depth);
    if (reason !== null) return reason;
  }
  return null;
}

const COPY_VALUED: Record<string, string[]> = {
  cp: ['-t', '-S', '--target-directory', '--suffix'],
  mv: ['-t', '-S', '--target-directory', '--suffix'],
  ln: ['-t', '-S', '--target-directory', '--suffix'],
  install: ['-t', '-S', '-B', '-m', '-o', '-g', '--target-directory', '--suffix', '--mode', '--owner', '--group'],
};

/** cp, mv, ln and install write to their target directory option or their last argument. */
function judgeCopy(name: string, args: string[]): string | null {
  const valued = COPY_VALUED[name] ?? [];
  const destinations: string[] = [];
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === '--') {
      positionals.push(...args.slice(index + 1));
      break;
    }
    if (!arg.startsWith('-') || arg === '-') positionals.push(arg);
    else if (arg === '-t' || arg === '--target-directory') destinations.push(args[index + 1] ?? '');
    else if (arg.startsWith('--target-directory=')) destinations.push(arg.slice(19));
    else if (arg.startsWith('-t') && !arg.startsWith('--')) destinations.push(arg.slice(2));
    if (valued.includes(arg)) index += 1;
  }
  if (positionals.length >= 2) destinations.push(positionals[positionals.length - 1] as string);
  const replacesGitDir = (path: string) => /(^|\/)\.git\/*$/.test(foldCase(posix.normalize(path)));
  return destinations.some((path) => writesGitFile(path) || replacesGitDir(path)) ? GIT_WRITE_REFUSED : null;
}

function judgeTee(args: string[]): string | null {
  const files = args.filter((arg) => !arg.startsWith('-') || arg === '-');
  return files.some(writesGitFile) ? GIT_WRITE_REFUSED : null;
}

/** sed -i rewrites its file arguments; without -i it only reads them. */
function judgeSed(args: string[]): string | null {
  const inPlace = args.some((arg) => /^-[nErsuz]*i/.test(arg) || arg === '--in-place' || arg.startsWith('--in-place='));
  if (!inPlace) return null;
  return args.some((arg) => !arg.startsWith('-') && writesGitFile(arg)) ? GIT_WRITE_REFUSED : null;
}

/**
 * Whether a path, as written, names .git/config or something under .git/hooks, or is a glob inside .git that could.
 * Paths are judged lexically: the lexer cannot know the working directory a command runs in. They are folded, as
 * macOS volumes find `.GIT/Hooks` as .git/hooks.
 */
function writesGitFile(path: string): boolean {
  const normal = foldCase(posix.normalize(path));
  if (/(^|\/)\.git\/+(hooks(\/|$)|config$)/.test(normal)) return true;
  const inside = normal.match(/(^|\/)\.git\/(.*)$/);
  return inside !== null && /[*?[]/.test(inside[2] as string);
}

function shellQuote(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`;
}
