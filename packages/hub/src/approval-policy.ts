// The rules that answer an approval request without a person (design 6.10, Who may answer; section 5, Unattended
// options). The agent holding the lead seat sends the answer, but the answer is not the lead's reading of the
// request: a request is written by an agent that may have read repository content an attacker wrote, so only the
// parsed shape of the command or of the diff decides here. Nothing in the text can argue its way to an approval,
// and `summary` and `detail.reason`, the two free-text fields, are never read.
//
// Three verdicts. 'approve' and 'decline' are answers the caller may send; 'undecided' means the rules recognise
// nothing they can stand behind, so the request is left to the owner, who still answers in the browser. Every
// branch names the rule that fired, so a decision can be read back from the event log.
//
// The module weakens no part of a managed device configuration: the sandbox mode, remote control, computer use and
// the external browser are settled by that profile and not here, and what the runner detects about it is reported
// as it is. These rules only answer single escalations, and they decline every path such a profile denies (~/.ssh,
// ~/.aws, ~/.gnupg, ~/.config/containers/auth.json, the keychains, /etc/shadow) together with the rest of the
// credentials an agent could carry off a laptop.
//
// Pure: no database, no hub context, no clock, no file system, no network. Core's reader takes the wrapping shell
// off a command, the same way the runner does when it shows the owner what was asked; past that the rules need a
// reader that keeps going across operators and redirections, which core's refuses outright, so it is below.
import { posix } from 'node:path';
import { type Approval, innerCommand } from '@agflow/core';
import { clip, oneLine } from './text';

export type ApprovalJudgement = {
  verdict: 'approve' | 'decline' | 'undecided';
  /** The rule that fired, as a stable kebab-case id. */
  rule: string;
  /** One sentence the asking agent reads; a decline says what to do instead. */
  reason: string;
};

/** What the rules read from a request. `summary` is part of the shape and deliberately never read. */
type Request = Pick<Approval, 'kind' | 'summary' | 'detail'>;

const approved = (rule: string, reason: string): ApprovalJudgement => ({ verdict: 'approve', rule, reason });
const declined = (rule: string, reason: string): ApprovalJudgement => ({ verdict: 'decline', rule, reason });
const undecided = (rule: string, reason: string): ApprovalJudgement => ({ verdict: 'undecided', rule, reason });

/** Worst wins when a command runs several things: a decline beats an undecided, which beats an approve. */
const RANK: Record<ApprovalJudgement['verdict'], number> = { approve: 0, undecided: 1, decline: 2 };
const worst = (a: ApprovalJudgement, b: ApprovalJudgement): ApprovalJudgement =>
  RANK[b.verdict] > RANK[a.verdict] ? b : a;

/** Text someone else wrote, inside a reason: one line, clipped and quoted, so it cannot read as an instruction. */
const show = (text: string): string => `"${oneLine(clip(text, 80))}"`;

/**
 * The verdict for one request. `cloneRoot` is the clone the attempt works in on the runner; without it nothing can
 * be checked for containment, so every request is left to the owner.
 */
export function judgeApproval(approval: Request, options: { cloneRoot: string | null }): ApprovalJudgement {
  const clone = cloneOf(options.cloneRoot);
  // 1. Fail closed: no clone root, no containment check.
  if (clone === null) {
    return undecided(
      'unknown-clone',
      'the hub does not know which clone this attempt works in, so no path can be checked for containment; the owner answers this one',
    );
  }
  // 2. A request of kind 'other' (a permission profile, an elicitation) has no shape these rules read.
  if (approval.kind === 'other') {
    return undecided(
      'unknown-kind',
      'this request asks for something other than a command or a file change, which these rules do not cover; the owner answers this one',
    );
  }
  return approval.kind === 'file_change'
    ? judgeFileChange(approval.detail, clone)
    : judgeCommand(approval.detail, clone);
}

// ---------------------------------------------------------------------------------------------------------------
// Paths

/** A name as case-insensitive macOS volumes compare it, folded the way core's protected paths fold one. */
function fold(text: string): string {
  return text.normalize('NFD').toLowerCase().toUpperCase().toLowerCase();
}

/** The segments of a path with "." and ".." resolved; containment compares these, case included. */
function pathSegments(path: string): string[] {
  return posix
    .normalize(path)
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.');
}

/** The same segments folded: the patterns (secrets, caches, tool directories) match case-insensitively. */
const foldedSegments = (path: string): string[] => pathSegments(path).map(fold);

/** Whether a path is the other one or sits under it, segment by segment: /x/clone-evil is not inside /x/clone. */
function inside(child: readonly string[], parent: readonly string[]): boolean {
  return child.length >= parent.length && parent.every((segment, at) => child[at] === segment);
}

/** Whether the segments repeat the sequence somewhere, so .git/hooks is found wherever a path holds it. */
function holds(segments: readonly string[], sequence: readonly string[]): boolean {
  return segments.some((_, at) => sequence.every((name, step) => segments[at + step] === name));
}

const under = (segments: readonly string[], prefixes: readonly (readonly string[])[]): boolean =>
  prefixes.some((prefix) => inside(segments, prefix));

const asPrefixes = (paths: readonly string[]): string[][] => paths.map((path) => foldedSegments(path));

/** The directories a home sits in, so that /Users/me and /home/me are read as homes. */
const HOME_PARENTS = new Set(['users', 'home']);

interface Clone {
  /** The clone root as the reasons spell it. */
  text: string;
  /** Its segments, as containment compares them. */
  root: string[];
  /** The home the clone sits in, when it sits in one: what "~" expands to. */
  home: string[] | null;
}

function cloneOf(cloneRoot: string | null): Clone | null {
  if (cloneRoot === null || !cloneRoot.startsWith('/')) return null;
  const root = pathSegments(cloneRoot);
  // "/" is no clone root: everything would count as inside it.
  if (root.length === 0) return null;
  const home = root.length >= 2 && HOME_PARENTS.has(fold(root[0])) ? root.slice(0, 2) : null;
  return { text: posix.normalize(cloneRoot), root, home };
}

/** Where a path sits, as rule 8 sorts places. */
type Place = 'inside' | 'temp' | 'benign' | 'outside' | 'unknown';

/**
 * The macOS temporary directories, with the /private twins the system resolves them to, and the device files a
 * write throws away: `2>/dev/null` names a place outside the clone that holds nothing.
 */
const TEMP_PREFIXES = asPrefixes([
  '/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp', '/var/folders', '/private/var/folders', '/dev/null',
  '/dev/zero', '/dev/random', '/dev/urandom', '/dev/stdin', '/dev/stdout', '/dev/stderr', '/dev/tty', '/dev/fd',
]);
/** Read-only system and toolchain places: reaching into them is no way out of the clone. */
const BENIGN_PREFIXES = asPrefixes(['/usr', '/bin', '/sbin', '/opt/homebrew', '/Library/Developer', '/System']);
/** The tool caches under the home of the owner that a build legitimately reads and fills. */
const BENIGN_HOME_PREFIXES = asPrefixes([
  '.cache', '.bun/install', '.npm/_cacache', 'Library/Caches', '.cargo/registry', '.rustup', 'go/pkg', '.m2',
  '.gradle/caches', '.pyenv', '.local/share/uv', '.local/share/virtualenvs',
]);

interface PathToken {
  /** The word as it was written, for the reason. */
  text: string;
  /** The absolute path it names; null when a value the rules cannot expand stands in the way. */
  path: string | null;
  /** Its place below a home: "~/.cache/x" and "/Users/me/.cache/x" both leave ".cache/x". */
  home: string[] | null;
}

function place(token: PathToken, clone: Clone): Place {
  if (token.path !== null) {
    const segments = pathSegments(token.path);
    const folded = segments.map(fold);
    if (inside(segments, clone.root)) return 'inside';
    if (under(folded, TEMP_PREFIXES)) return 'temp';
    if (under(folded, BENIGN_PREFIXES)) return 'benign';
  }
  if (token.home !== null && under(token.home.map(fold), BENIGN_HOME_PREFIXES)) return 'benign';
  // A home-rooted path whose home the rules cannot locate is outside all the same: the clone sits in no home.
  if (token.path !== null || token.home !== null) return 'outside';
  return 'unknown';
}

/** The part of an absolute path below a home directory, when it has one. */
function homePart(segments: readonly string[]): string[] | null {
  return segments.length >= 2 && HOME_PARENTS.has(fold(segments[0])) ? segments.slice(2) : null;
}

/** A word that names a site, not a path: no containment check can hold it. */
const isUrl = (text: string): boolean => /^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^[^\s/]+@[^\s/]+:/.test(text);

/**
 * Where a word points. A "~" or "$HOME" start roots it at the home directory (the lexer strips both, and a value
 * written after an "=" keeps its own "~"), anything else absolute stands on its own, and the rest is read from the
 * working directory.
 */
function resolve(word: Word, cwd: string | null, clone: Clone): PathToken {
  if (word.unresolved) return { text: word.source, path: null, home: null };
  let text = word.text;
  let home = word.home;
  if (!home && (text === '~' || text.startsWith('~/'))) {
    home = true;
    text = text.slice(2);
  }
  if (home) {
    const part = pathSegments(`/${text}`);
    const root = clone.home;
    return { text: word.source, path: root === null ? null : `/${[...root, ...part].join('/')}`, home: part };
  }
  const absolute = text.startsWith('/') ? text : cwd === null ? null : `${cwd}/${text}`;
  if (absolute === null) return { text: word.source, path: null, home: null };
  const segments = pathSegments(absolute);
  return { text: word.source, path: `/${segments.join('/')}`, home: homePart(segments) };
}

// ---------------------------------------------------------------------------------------------------------------
// The shell lexer: quotes, operators, redirections, and the expansions that hide what would run

interface Word {
  /** The word with its quotes removed; a part the rules cannot expand stays as it was written. */
  text: string;
  /** The word as the command spells it, for the reasons. */
  source: string;
  /** An expansion only the shell knows the value of ($NAME, $((…))): no path can be read out of this word. */
  unresolved: boolean;
  /** The word is rooted at the home directory: "~/x" and "$HOME/x" both leave "x" in text. */
  home: boolean;
}

interface Redirect {
  /** The redirection writes its target instead of reading it. */
  write: boolean;
  target: Word;
}

interface Segment {
  words: Word[];
  redirects: Redirect[];
}

type Tokenised = { ok: true; segments: Segment[] } | { ok: false; hidden: boolean; problem: string };

/** The command builds part of itself where the rules cannot look: a substitution of any shape. */
class HiddenText extends Error {}
/** The text is not a shell command these rules can read at all. */
class Unreadable extends Error {}

const WORD_END = new Set([' ', '\t', '\n', ';', '&', '|', '(', ')', '<', '>']);
/** Longest first, so ">>" is never read as ">". */
const REDIRECT_OPS = ['&>>', '&>', '<<<', '<<-', '<<', '>>', '>|', '>&', '<>', '<&', '<', '>'];
const WRITING_OPS = new Set(['&>>', '&>', '>>', '>|', '>', '<>']);

/**
 * Splits a command line into the segments a shell would run one after another, at &&, ||, ;, |, &, a newline and
 * the parentheses of a subshell. Quotes are removed, "~", "$HOME" and "$PWD" are expanded as far as a clone root
 * allows, and every other expansion marks its word unresolved. A substitution gives up at once: the command that
 * would run is not in the text.
 */
function tokenise(command: string): Tokenised {
  const segments: Segment[] = [];
  let words: Word[] = [];
  let redirects: Redirect[] = [];
  let pending: boolean | null = null;
  let at = 0;
  const end = (): void => {
    if (words.length > 0 || redirects.length > 0) segments.push({ words, redirects });
    words = [];
    redirects = [];
    pending = null;
  };
  try {
    while (at < command.length) {
      const c = command[at];
      if (c === ' ' || c === '\t') {
        at += 1;
        continue;
      }
      if (c === '\\' && command[at + 1] === '\n') {
        at += 2;
        continue;
      }
      // A comment starts at a word boundary and runs to the end of its line.
      if (c === '#' && (at === 0 || /[\s;&|()]/.test(command[at - 1]))) {
        const line = command.indexOf('\n', at);
        at = line < 0 ? command.length : line;
        continue;
      }
      if (c === '\n' || c === ';' || c === '(' || c === ')') {
        at += 1;
        end();
        continue;
      }
      if (c === '&' || c === '|') {
        at += command[at + 1] === c ? 2 : 1;
        end();
        continue;
      }
      // A process substitution runs a command of its own, which the text does not show.
      if (command.startsWith('<(', at) || command.startsWith('>(', at)) throw new HiddenText('a process substitution');
      const fd = command.slice(at).match(/^\d+(?=[<>])/);
      const digits = fd === null ? 0 : fd[0].length;
      const op = REDIRECT_OPS.find((candidate) => command.startsWith(candidate, at + digits));
      if (op !== undefined) {
        // A here-document keeps its body on the lines below, where this lexer would read it as commands of its own
        // and where the rest of the line (`cat <<EOF > out`) would be hidden. It is left to the owner instead.
        if (op === '<<' || op === '<<-') throw new Unreadable('a here-document');
        at += digits + op.length;
        // 2>&1 duplicates a descriptor instead of naming a file.
        pending = WRITING_OPS.has(op);
        continue;
      }
      const read = readWord(command, at);
      at = read.at;
      if (pending === null) words.push(read.word);
      else {
        redirects.push({ write: pending, target: read.word });
        pending = null;
      }
    }
  } catch (error) {
    if (error instanceof HiddenText) return { ok: false, hidden: true, problem: error.message };
    if (error instanceof Unreadable) return { ok: false, hidden: false, problem: error.message };
    throw error;
  }
  end();
  return { ok: true, segments };
}

/** One word from `from`, with its quotes removed and its expansions read as far as they can be. */
function readWord(src: string, from: number): { word: Word; at: number } {
  let at = from;
  let text = '';
  let unresolved = false;
  let home = false;
  /** Nothing of the word has been read yet, so "~" and "$HOME" still root it at the home directory. */
  const fresh = (): boolean => text === '' && !home && !unresolved;
  while (at < src.length) {
    const c = src[at];
    if (WORD_END.has(c)) break;
    if (c === '\\') {
      const next = src[at + 1];
      if (next === undefined) throw new Unreadable('a trailing backslash');
      at += 2;
      if (next !== '\n') text += next;
      continue;
    }
    if (c === "'") {
      const close = src.indexOf("'", at + 1);
      if (close < 0) throw new Unreadable('an unterminated single quote');
      text += src.slice(at + 1, close);
      at = close + 1;
      continue;
    }
    if (c === '"') {
      at += 1;
      while (at < src.length && src[at] !== '"') {
        const inner = src[at];
        if (inner === '\\') {
          const next = src[at + 1];
          if (next === undefined) throw new Unreadable('a trailing backslash');
          at += 2;
          if (next !== '\n') text += '$`"\\'.includes(next) ? next : `\\${next}`;
          continue;
        }
        if (inner === '`') throw new HiddenText('a backtick substitution');
        if (inner === '$') {
          const read = readDollar(src, at, fresh());
          at = read.at;
          text += read.text;
          unresolved ||= read.unresolved;
          home ||= read.home;
          continue;
        }
        text += inner;
        at += 1;
      }
      if (at >= src.length) throw new Unreadable('an unterminated double quote');
      at += 1;
      continue;
    }
    if (c === '`') throw new HiddenText('a backtick substitution');
    if (c === '$') {
      const read = readDollar(src, at, fresh());
      at = read.at;
      text += read.text;
      unresolved ||= read.unresolved;
      home ||= read.home;
      continue;
    }
    if (c === '~' && fresh()) {
      home = true;
      at += src[at + 1] === '/' ? 2 : 1;
      continue;
    }
    text += c;
    at += 1;
  }
  return { word: { text, source: src.slice(from, at), unresolved, home }, at };
}

interface Expansion {
  text: string;
  at: number;
  unresolved: boolean;
  home: boolean;
}

/**
 * An expansion that starts with "$". `rooting` says whether it still stands at the start of its word. The quoting
 * forms $'…' and $"…" are left as they were written, so a program named $'\x67it' is not recognised as git and its
 * request waits for the owner rather than being approved.
 */
function readDollar(src: string, at: number, rooting: boolean): Expansion {
  if (src.startsWith('$((', at)) {
    const close = src.indexOf('))', at);
    if (close < 0) throw new Unreadable('an unterminated arithmetic expansion');
    return { text: src.slice(at, close + 2), at: close + 2, unresolved: true, home: false };
  }
  if (src.startsWith('$(', at)) throw new HiddenText('a command substitution');
  const rest = src.slice(at);
  const found = rest.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}/) ?? rest.match(/^\$([A-Za-z_][A-Za-z0-9_]*)/);
  if (found === null) {
    if (src.startsWith('${', at)) {
      const close = src.indexOf('}', at);
      if (close < 0) throw new Unreadable('an unterminated parameter expansion');
      return { text: src.slice(at, close + 1), at: close + 1, unresolved: true, home: false };
    }
    return { text: '$', at: at + 1, unresolved: false, home: false };
  }
  const next = at + found[0].length;
  const slash = src[next] === '/';
  // $HOME and $PWD are the two variables whose value the rules know: the home the clone sits in, and the working
  // directory a relative path is read from anyway. Both only at the start of a word, where they root a path.
  if (rooting && found[1] === 'HOME') return { text: '', at: slash ? next + 1 : next, unresolved: false, home: true };
  if (rooting && found[1] === 'PWD') {
    return { text: slash ? '' : '.', at: slash ? next + 1 : next, unresolved: false, home: false };
  }
  return { text: found[0], at: next, unresolved: true, home: false };
}

// ---------------------------------------------------------------------------------------------------------------
// The programs a segment runs

/** Keywords and groupings that stand before a command name in a segment. */
const RESERVED = new Set([
  '!', '{', '}', 'if', 'then', 'elif', 'else', 'fi', 'while', 'until', 'do', 'done', 'for', 'in', 'case', 'esac',
  'function',
]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;

/** Programs that run another program: the one that does the work stands further along the words. */
const WRAPPERS: Record<string, { valued: Set<string>; positionals: number }> = {
  env: { valued: new Set(['-u', '--unset', '-C', '--chdir']), positionals: 0 },
  command: { valued: new Set(), positionals: 0 },
  builtin: { valued: new Set(), positionals: 0 },
  exec: { valued: new Set(['-a']), positionals: 0 },
  nohup: { valued: new Set(), positionals: 0 },
  time: { valued: new Set(), positionals: 0 },
  caffeinate: { valued: new Set(['-t', '-w']), positionals: 0 },
  setsid: { valued: new Set(), positionals: 0 },
  stdbuf: { valued: new Set(['-i', '-o', '-e']), positionals: 0 },
  nice: { valued: new Set(['-n', '--adjustment']), positionals: 0 },
  timeout: { valued: new Set(['-s', '-k', '--signal', '--kill-after']), positionals: 1 },
  gtimeout: { valued: new Set(['-s', '-k', '--signal', '--kill-after']), positionals: 1 },
  xargs: {
    valued: new Set(['-I', '-J', '-L', '-n', '-P', '-s', '-E', '-d', '-a', '--arg-file', '--delimiter']),
    positionals: 0,
  },
};

interface Call {
  /** Every program the segment runs, the wrappers first; the last one is the one that does the work. */
  programs: string[];
  /** The last of them, by its base name, folded. */
  program: string;
  /** Its arguments. */
  args: Word[];
}

/** A program name as the shell would find it: without its directory, without the "=" of zsh, folded. */
const programName = (text: string): string => fold(posix.basename(text.replace(/^=/, '').replace(/\/+$/, '')));

function callOf(words: readonly Word[]): Call {
  const programs: string[] = [];
  let at = 0;
  while (at < words.length) {
    const word = words[at];
    if (RESERVED.has(word.text) || ASSIGNMENT.test(word.text)) {
      at += 1;
      continue;
    }
    const name = programName(word.text);
    programs.push(name);
    at += 1;
    const wrapper = WRAPPERS[name];
    if (wrapper === undefined) break;
    at = skipOptions(words, at, wrapper.valued) + wrapper.positionals;
  }
  return { programs, program: programs.at(-1) ?? '', args: words.slice(at) };
}

/** The index of the first word after the options of a program; "--" ends them. */
function skipOptions(words: readonly Word[], from: number, valued: ReadonlySet<string>): number {
  let at = from;
  while (at < words.length) {
    const text = words[at].text;
    if (text === '--') return at + 1;
    if (!text.startsWith('-') || text === '-' || ASSIGNMENT.test(text)) return at;
    at += valued.has(text) ? 2 : 1;
  }
  return at;
}

const texts = (words: readonly Word[]): string[] => words.map((word) => word.text);
const positionals = (words: readonly Word[]): Word[] => words.filter((word) => !word.text.startsWith('-'));

// ---------------------------------------------------------------------------------------------------------------
// Rule 3: the credentials of the owner

/** Credential directories and files, wherever they sit: ~/.ssh, /Users/me/.ssh and $HOME/.ssh are one place. */
const SECRET_NAMES = new Set(
  ['.ssh', '.aws', '.gnupg', '.codex', '.claude', '.claude.json', '.agflow', '.netrc', '.npmrc', '.pypirc'].map(fold),
);
/** The credentials that take more than one segment to name. */
const SECRET_SEQUENCES = [
  ['.config', 'containers', 'auth.json'],
  ['.config', 'gh'],
  ['.docker', 'config.json'],
  ['Library', 'Keychains'],
  ['etc', 'shadow'],
  ['etc', 'sudoers'],
].map((sequence) => sequence.map(fold));
/** The keychain readers of the security command. */
const KEYCHAIN_COMMANDS = new Set(['find-generic-password', 'find-internet-password', 'dump-keychain']);

/**
 * Key material by file name: the private key spellings, the certificate suffixes, and every .env file, which is
 * .env itself, a .env.local beside it, and a secrets.env that holds the same thing under another name.
 */
const secretName = (name: string): boolean =>
  name === '.env' ||
  name.startsWith('.env.') ||
  name.endsWith('.env') ||
  /^id_(rsa|dsa|ecdsa|ed25519)/.test(name) ||
  /\.(pem|key|p12)$/.test(name);

/**
 * Whether a word reaches credentials. It is read as a path with "." and ".." resolved, so clone/../../.ssh is the
 * .ssh of the home, and the part after an "=" is read too, because dd writes of=/etc/shadow and pip reads
 * --requirement=… The names are matched wherever they sit, which covers the "~" and the /Users/<name>/ spellings
 * at once, and a .claude or .codex directory inside the clone with them: changing one is refused anyway (7.3).
 */
function touchesSecret(text: string): boolean {
  return text.split('=').some((part) => {
    if (part === '') return false;
    const segments = foldedSegments(part);
    return (
      segments.some((segment) => SECRET_NAMES.has(segment) || secretName(segment)) ||
      SECRET_SEQUENCES.some((sequence) => holds(segments, sequence))
    );
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Rules 4 to 7: privilege, containers, downloads that run, and git

const PRIVILEGE_PROGRAMS = new Set([
  'sudo', 'su', 'doas', 'launchctl', 'profiles', 'csrutil', 'spctl', 'systemextensionsctl', 'dscl', 'visudo', 'chown',
]);
/** A mode that sets the user or the group id of the file it is given: 4755, 2755, u+s, g+ws. */
const SETUID_MODE = /^[0-7]*[2467][0-7]{3}$|^[augo]*[-+=][rwxXt]*s/;

const CONTAINER_PROGRAMS = new Set(['podman', 'docker', 'nerdctl', 'colima', 'podman-machine', 'docker-compose']);

const DOWNLOADERS = new Set(['curl', 'wget', 'fetch', 'nc', 'ncat', 'netcat', 'scp', 'ftp', 'sftp']);
const EXECUTORS = new Set([
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'python', 'python3', 'node', 'ruby', 'perl', 'eval', 'osascript',
]);

/** The options of git itself that take their value in the next word, before the subcommand. */
const GIT_VALUED = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--exec-path']);

/** What a git subcommand would give away: the pushing and the history the runner owns, or the laptop settings. */
function gitDanger(call: Call): string | null {
  const args = texts(call.args);
  let at = 0;
  while (at < args.length && args[at].startsWith('-')) at += GIT_VALUED.has(args[at]) ? 2 : 1;
  const subcommand = args[at] ?? '';
  const rest = args.slice(at + 1);
  const forced = rest.some((arg) => arg === '-f' || arg === '--force' || arg.startsWith('--force-with-lease'));
  if (subcommand === 'push' && forced) return 'git push --force rewrites what the remote already holds';
  if (subcommand === 'config' && rest.some((arg) => arg === '--global' || arg === '--system')) {
    return 'git config --global changes the settings of every repository on the laptop';
  }
  if (subcommand === 'remote' && rest[0] === 'set-url') {
    return 'git remote set-url would send the work of this clone somewhere else';
  }
  if (subcommand === 'update-ref' || subcommand === 'filter-branch') {
    return `git ${subcommand} rewrites the history of the clone`;
  }
  if (subcommand === 'reflog' && rest[0] === 'delete') return 'git reflog delete removes the record a recovery needs';
  return null;
}

/** git clean that takes the ignored files too: safe only where it is known to stay inside the clone. */
function cleansIgnored(call: Call): boolean {
  const args = texts(call.args);
  return args.includes('clean') && args.some((arg) => /^-[a-wyz]*[xX]/.test(arg) || arg === '--force-ignored');
}

// ---------------------------------------------------------------------------------------------------------------
// Rules 8 and 9: where a command writes, and what it destroys

/** Programs whose arguments are places they change, not places they read. */
const WRITE_PROGRAMS = new Set(['rm', 'rmdir', 'truncate', 'mkdir', 'shred', 'srm', 'tee', 'chmod', 'touch']);
const COPY_PROGRAMS = new Set(['cp', 'mv', 'ln', 'install']);
/** Flags that say where a program puts what it produces: tar -C, curl -o, a build --out-dir. */
const WRITE_FLAGS = new Set([
  '-o', '--output', '--out-dir', '--outfile', '-C', '--directory', '--target-directory', '-t', '-d', '--prefix',
  '--root',
]);
/** rm that takes a whole tree, or takes it without asking. */
const sweeping = (args: readonly string[]): boolean =>
  args.some((arg) => /^-[^-]*[rRf]/.test(arg) || arg === '--recursive' || arg === '--force');

/** The words a segment would write to, its redirections included. */
function writeWords(call: Call, redirects: readonly Redirect[]): Word[] {
  const targets = redirects.filter((redirect) => redirect.write).map((redirect) => redirect.target);
  const given = positionals(call.args);
  if (WRITE_PROGRAMS.has(call.program)) targets.push(...given);
  // cp, mv, ln and install read every argument but the last one.
  const last = given.at(-1);
  if (COPY_PROGRAMS.has(call.program) && given.length >= 2 && last !== undefined) targets.push(last);
  for (let at = 0; at < call.args.length; at += 1) {
    const arg = call.args[at];
    const next = call.args[at + 1];
    if (WRITE_FLAGS.has(arg.text) && next !== undefined && !isUrl(next.text)) targets.push(next);
    const split = arg.text.indexOf('=');
    const value = split < 0 ? '' : arg.text.slice(split + 1);
    if (split > 0 && WRITE_FLAGS.has(arg.text.slice(0, split)) && value !== '' && !isUrl(value)) {
      targets.push({ ...arg, text: value });
    }
  }
  if (call.program === 'dd') {
    targets.push(
      ...call.args.filter((arg) => arg.text.startsWith('of=')).map((arg) => ({ ...arg, text: arg.text.slice(3) })),
    );
  }
  // find … -delete removes what it walks over.
  if (call.program === 'find' && texts(call.args).includes('-delete')) targets.push(...given);
  return targets;
}

/** Flags that carry a directory in the next word, so that -C build names a place as plainly as ./build does. */
const VALUE_FLAGS = new Set([
  '-C', '--cwd', '--chdir', '--directory', '--prefix', '--target-directory', '-t', '-o', '--output', '--out-dir',
  '--outfile', '--file', '--config', '--path', '--root', '-r', '--requirement', '-e', '--editable', '-f',
  '--find-links',
]);

const pathShaped = (word: Word): boolean =>
  !isUrl(word.text) && (word.home || word.text.includes('/') || word.text === '.' || word.text === '..');

/** Every word of a segment that names a place, the values of the flags above included. */
function pathWords(call: Call): Word[] {
  const found: Word[] = [];
  for (let at = 0; at < call.args.length; at += 1) {
    const word = call.args[at];
    const next = call.args[at + 1];
    if (VALUE_FLAGS.has(word.text)) {
      if (next !== undefined && !isUrl(next.text)) found.push(next);
      continue;
    }
    const split = word.text.indexOf('=');
    const flag = split < 0 ? '' : word.text.slice(0, split);
    const value = split < 0 ? '' : word.text.slice(split + 1);
    if (VALUE_FLAGS.has(flag) && value !== '' && !isUrl(value)) {
      found.push({ ...word, text: value });
      continue;
    }
    if (pathShaped(word)) found.push(word);
  }
  return found;
}

const GIT_HOOKS = ['.git', 'hooks'].map(fold);

// ---------------------------------------------------------------------------------------------------------------
// Rules 10 and 11: the work a sandbox would have done had the network not been in the way

/** Rule 10: the plain forms that install only what a manifest in the clone already declares. */
function installsDeclaredDependencies(call: Call): boolean {
  const given = texts(positionals(call.args));
  const first = given[0] ?? '';
  const second = given[1] ?? '';
  const alone = given.length === 1;
  switch (call.program) {
    case 'npm':
    case 'pnpm':
      return alone && (first === 'ci' || first === 'install' || first === 'i');
    case 'bun':
      return alone && (first === 'install' || first === 'i');
    case 'yarn':
    case 'bundle':
    case 'poetry':
      return alone && first === 'install';
    case 'pip':
    case 'pip3':
      return first === 'install' && installsFromClone(call.args);
    case 'uv':
      return (alone && first === 'sync') || (first === 'pip' && second === 'sync');
    case 'cargo':
      return first === 'fetch' || first === 'build' || first === 'test';
    case 'go':
      return first === 'build' || first === 'test' || (first === 'mod' && second === 'download');
    case 'mvn':
    case 'gradle':
      // A plugin goal (org.group:artifact:goal, :module:task) runs code no manifest of the clone pins.
      return !texts(call.args).some((arg) => arg.includes(':'));
    default:
      return false;
  }
}

/** The options of pip that take their value in the next word. */
const PIP_VALUED = new Set([
  '-r', '--requirement', '-e', '--editable', '-c', '--constraint', '-i', '--index-url', '--extra-index-url',
  '--find-links', '-t', '--target', '--prefix', '--python', '--cache-dir',
]);

/** The two declared forms of pip: -r a requirements file of the clone, and -e . for the project itself. */
function installsFromClone(args: readonly Word[]): boolean {
  let declared = false;
  let given = 0;
  let at = 0;
  while (at < args.length) {
    const text = args[at].text;
    const inlined = text.match(/^--(?:requirement|editable)=(.*)$/);
    if (text === '-r' || text === '--requirement' || text === '-e' || text === '--editable') {
      const value = args[at + 1]?.text ?? '';
      declared ||= value !== '' && !isUrl(value);
      at += 2;
      continue;
    }
    if (inlined !== null) {
      declared ||= inlined[1] !== '' && !isUrl(inlined[1]);
      at += 1;
      continue;
    }
    if (text.startsWith('-')) at += PIP_VALUED.has(text) ? 2 : 1;
    else {
      given += 1;
      at += 1;
    }
  }
  // Only "install" itself may stand among the positional words: anything else is a package being added.
  return declared && given === 1;
}

/** The programs of rule 11, the ones a task does its own work with, by the ecosystem each belongs to. */
const DEV_TOOLS = new Set([
  // JavaScript and TypeScript.
  'bun', 'bunx', 'node', 'npm', 'npx', 'pnpm', 'yarn', 'deno', 'tsc', 'eslint', 'prettier', 'jest', 'vitest',
  'playwright', 'biome',
  // Python.
  'python', 'python3', 'pip', 'pip3', 'uv', 'uvx', 'poetry', 'pytest', 'tox', 'ruff', 'mypy', 'black', 'isort',
  'flake8',
  // Compiled languages and their builds.
  'make', 'cmake', 'ninja', 'cargo', 'rustc', 'go', 'gofmt', 'golangci-lint', 'java', 'mvn', 'gradle', 'swift',
  // Reading and changing the files of the clone.
  'rg', 'grep', 'egrep', 'fgrep', 'ls', 'cat', 'head', 'tail', 'find', 'fd', 'sed', 'awk', 'sort', 'uniq', 'wc',
  'cut', 'tr', 'diff', 'patch', 'file', 'stat', 'mkdir', 'touch', 'cp', 'mv', 'rm', 'ln', 'chmod', 'tar', 'unzip',
  'zip', 'gzip', 'jq', 'yq',
  // The shell builtins and the small tools a command line is held together with.
  'echo', 'printf', 'true', 'false', 'test', 'env', 'pwd', 'cd', 'which', 'basename', 'dirname', 'xargs', 'tee',
  'date', 'sleep',
  // Every git subcommand rule 7 did not take.
  'git',
]);

/**
 * Whether a package manager would reach a registry for something no manifest declares. Rule 10 has had its say by
 * the time this is asked, so what is left adds a dependency, publishes one, or runs a package fetched on the spot.
 */
function reachesRegistry(call: Call): boolean {
  const given = texts(positionals(call.args));
  const first = given[0] ?? '';
  const second = given[1] ?? '';
  switch (call.program) {
    case 'npm':
    case 'pnpm':
    case 'yarn':
    case 'bun':
      return ['install', 'i', 'add', 'update', 'up', 'upgrade', 'exec', 'dlx', 'create', 'init', 'publish', 'link', 'x'].includes(
        first,
      );
    case 'pip':
    case 'pip3':
      return ['install', 'download', 'wheel'].includes(first);
    case 'uv':
      return ['add', 'pip', 'tool', 'init', 'build', 'publish'].includes(first);
    case 'poetry':
      return ['add', 'update', 'lock', 'publish', 'source', 'self'].includes(first);
    case 'cargo':
      return ['add', 'install', 'update', 'publish', 'search', 'login', 'yank'].includes(first);
    case 'go':
      return first === 'get' || first === 'install' || (first === 'mod' && second !== 'download' && second !== 'verify');
    case 'bundle':
      return ['add', 'update', 'lock'].includes(first);
    case 'mvn':
      // A goal spelled out (org.group:artifact:version:goal) fetches that plugin and runs it; a lifecycle phase
      // such as "test" uses what the pom already pins. A gradle ":module:task" is no download, so it is left out.
      return texts(call.args).some((arg) => arg.includes(':'));
    default:
      return false;
  }
}

/** The flags that hand a program a script written on the command line, which no rule here can read. */
const INLINE_SCRIPT: Record<string, readonly string[]> = {
  python: ['-c'],
  python3: ['-c'],
  ruby: ['-e'],
  perl: ['-e'],
  node: ['-e', '--eval', '-p', '--print'],
  deno: ['-e', '--eval'],
  bun: ['-e', '--eval'],
};

const runsInlineScript = (call: Call): boolean =>
  (INLINE_SCRIPT[call.program] ?? []).some((flag) =>
    texts(call.args).some((arg) => arg === flag || arg.startsWith(`${flag}=`)),
  );

// ---------------------------------------------------------------------------------------------------------------
// Commands

interface Context {
  clone: Clone;
  /** Where the command runs, normalised; null when the request named no absolute directory. */
  cwd: string | null;
}

/**
 * Rules 3 to 13 over a command. The segments are judged one by one and the worst verdict wins, except for rule 6,
 * which spans them: neither the download nor the shell that runs it says anything on its own.
 */
/**
 * Codex relays a command the way it runs it, wrapped in a login shell: `bash -lc "npm ci"`. These rules judge what
 * the agent asked for, so the wrapper comes off first, with core's reader. A script that wraps itself again is
 * unwrapped again, to a bound: a round can only uncover the command, never hide one, so `bash -lc "sudo rm -rf /"`
 * reaches the rule that declines it instead of reading as the program `bash`. A wrapper core's reader cannot read
 * (an expansion in the script, an unterminated quote) is left whole, which leaves the program `bash` and no
 * approval.
 */
function unwrapped(command: string): string {
  let text = command;
  for (let round = 0; round < 8; round++) {
    const inner = innerCommand(text);
    if (inner === text) break;
    text = inner;
  }
  return text;
}

function judgeCommand(detail: Approval['detail'], clone: Clone): ApprovalJudgement {
  const command = unwrapped(detail.command ?? '');
  if (command.trim() === '') {
    return undecided(
      'unparsed-command',
      'the request carries no command text, so there is nothing for the rules to read; the owner answers this one',
    );
  }
  const tokenised = tokenise(command);
  if (!tokenised.ok) {
    return tokenised.hidden
      ? declined(
          'hidden-command',
          `declined: the command builds itself with ${tokenised.problem}, so what would run is not in the text; write the command out in full`,
        )
      : undecided(
          'unparsed-command',
          `the command could not be read as shell (${tokenised.problem}), so the owner answers this one`,
        );
  }
  const cwd = detail.cwd !== undefined && detail.cwd.startsWith('/') ? `/${pathSegments(detail.cwd).join('/')}` : null;
  // The working directory and the write grant belong to the request as a whole, before any one segment. Unlike a
  // path a command reads, the directory it runs in has to be the clone: a tool cache is no place to work in.
  if (cwd !== null && !inside(pathSegments(cwd), clone.root)) {
    return declined(
      'outside-clone',
      `declined: the command runs in ${show(detail.cwd ?? '')}, which is outside the clone ${show(clone.text)}; run it inside the clone`,
    );
  }
  const grant = judgeGrantRoot(detail.grantRoot, clone);
  if (grant !== null) return grant;
  const chain = judgeChain(tokenised.segments);
  if (chain !== null) return chain;
  let verdict: ApprovalJudgement | null = null;
  for (const segment of tokenised.segments) {
    const one = judgeSegment(segment, { clone, cwd });
    verdict = verdict === null ? one : worst(verdict, one);
  }
  return (
    verdict ??
    undecided('unparsed-command', 'the command text holds no command the rules can read; the owner answers this one')
  );
}

/**
 * Rule 6 over the whole command: one part downloads and a later part runs what came down. It is judged before the
 * segments, because the halves are harmless apart and the pipe between them is the whole of it.
 */
function judgeChain(segments: readonly Segment[]): ApprovalJudgement | null {
  let downloader: string | null = null;
  for (const segment of segments) {
    const { programs } = callOf(segment.words);
    const executor = programs.find((name) => EXECUTORS.has(name));
    if (downloader !== null && executor !== undefined) {
      return declined(
        'fetch-and-run',
        `declined: the command downloads with ${show(downloader)} and runs what it downloads with ${show(executor)}; declare what you need in a manifest and install it instead`,
      );
    }
    const found = programs.find((name) => DOWNLOADERS.has(name));
    if (found !== undefined) downloader = found;
  }
  return null;
}

function judgeSegment(segment: Segment, ctx: Context): ApprovalJudgement {
  const { clone, cwd } = ctx;
  const call = callOf(segment.words);
  const words = [...segment.words, ...segment.redirects.map((redirect) => redirect.target)];
  const paths = pathWords(call).map((word) => resolve(word, cwd, clone));
  const writes = writeWords(call, segment.redirects).map((word) => resolve(word, cwd, clone));

  // 3. The credentials of the owner, by any spelling of their path.
  const secret = words.find((word) => touchesSecret(word.text));
  if (secret !== undefined) {
    return declined(
      'secret-path',
      `declined: the command reaches ${show(secret.source)}, which holds credentials no task needs; work with the files of the clone instead`,
    );
  }
  if (call.program === 'security' && texts(call.args).some((arg) => KEYCHAIN_COMMANDS.has(arg))) {
    return declined(
      'secret-path',
      'declined: the command reads the keychain of the owner; work with the files of the clone instead',
    );
  }

  // 4. Anything that changes the machine or runs as somebody else.
  const privileged = call.programs.find((name) => PRIVILEGE_PROGRAMS.has(name));
  if (privileged !== undefined) {
    return declined(
      'privilege',
      `declined: ${show(privileged)} changes the machine or runs as another user, which no task may do; do the work in the clone as yourself`,
    );
  }
  if (call.program === 'chmod' && texts(call.args).some((arg) => SETUID_MODE.test(arg))) {
    return declined(
      'privilege',
      'declined: the command sets a setuid or setgid bit, which leaves a program running as another user; use an ordinary mode',
    );
  }
  if (call.program === 'defaults' && texts(call.args).includes('write')) {
    return declined(
      'privilege',
      'declined: defaults write changes the settings of the laptop of the owner; keep the change inside the clone',
    );
  }

  // 5. The containers of the owner are running work of their own.
  const container = call.programs.find((name) => CONTAINER_PROGRAMS.has(name));
  if (container !== undefined) {
    return declined(
      'containers',
      `declined: ${show(container)} drives containers that agflow never touches; leave them alone and do the work in the clone`,
    );
  }

  // 6. The half of fetch-and-run that stands on its own: eval runs text no rule can read.
  if (call.programs.includes('eval')) {
    return declined(
      'fetch-and-run',
      'declined: eval runs text that the command itself does not show; write out the command you mean to run',
    );
  }

  // 7. git hooks, forced pushes, the settings of the laptop, rewritten history.
  const hook = writes.find((token) => holds(foldedSegments(token.text), GIT_HOOKS));
  if (hook !== undefined) {
    return declined(
      'git-danger',
      `declined: the command writes ${show(hook.text)}, a git hook that would then run on its own; change the files of the repository instead`,
    );
  }
  if (call.program === 'git') {
    const danger = gitDanger(call);
    if (danger !== null) {
      return declined(
        'git-danger',
        `declined: ${danger}; the runner owns the pushing and the history, so change files and leave the rest to it`,
      );
    }
    if (cleansIgnored(call) && (cwd === null || paths.some((token) => place(token, clone) !== 'inside'))) {
      return declined(
        'git-danger',
        'declined: git clean -x deletes the ignored files, and the rules cannot see that this one would stay inside the clone; name the paths inside the clone instead',
      );
    }
  }

  // 8. Outside the clone: reading the system and the caches is fine, writing anywhere but a temporary directory is
  // not. A write-shaped command is judged by its targets even where a read would have passed.
  const outside = paths.find((token) => place(token, clone) === 'outside');
  if (outside !== undefined) {
    return declined(
      'outside-clone',
      `declined: ${show(outside.text)} is outside the clone ${show(clone.text)}; keep the work inside the clone`,
    );
  }
  const written = writes.find((token) => !['inside', 'temp', 'unknown'].includes(place(token, clone)));
  if (written !== undefined) {
    return declined(
      'outside-clone',
      `declined: the command writes ${show(written.text)}, which is outside the clone ${show(clone.text)} and is no temporary directory; write inside the clone`,
    );
  }

  // 9. What cannot be undone. Rule 8 has already taken everything that points out of the clone, "/" and "~" with
  // it, so what is left here is the clone itself and the programs that destroy whatever they are given.
  if (call.program === 'shred' || call.program === 'srm') {
    return declined(
      'destructive',
      `declined: ${show(call.program)} destroys files beyond recovery; remove only the files you created, with rm, inside the clone`,
    );
  }
  if (call.program === 'rm' && sweeping(texts(call.args))) {
    const swept = writes.find(
      (token) => token.path !== null && pathSegments(token.path).join('/') === clone.root.join('/'),
    );
    if (swept !== undefined) {
      return declined(
        'destructive',
        `declined: the command deletes ${show(swept.text)}, the clone itself, and the work of the attempt with it; remove only the files you created`,
      );
    }
  }

  // Nothing is decided on a path the rules cannot resolve.
  if (cwd === null) {
    return undecided(
      'unknown-cwd',
      'the request does not say which directory the command runs in, so containment cannot be checked; the owner answers this one',
    );
  }
  // Any word at all, not only the path-shaped ones: an expansion could stand for any path when the command runs.
  const vague = words.find((word) => word.unresolved);
  if (vague !== undefined) {
    return undecided(
      'unknown-path',
      `${show(vague.source)} holds a value only the shell can expand, so containment cannot be checked; write the paths out in full`,
    );
  }
  const url = call.args.find((word) => isUrl(word.text));
  if (url !== undefined) {
    return undecided(
      'unrecognised',
      `${show(url.source)} names a site, and these rules allow only the fetches a manifest already declares; say what you need from it and why`,
    );
  }

  // 10 and 11. The work a sandbox would have done had the network not been in the way.
  if (installsDeclaredDependencies(call)) {
    return approved(
      'declared-deps',
      `approved: ${show(call.program)} installs the dependencies that the manifests in the clone already declare`,
    );
  }
  if (DEV_TOOLS.has(call.program) && !reachesRegistry(call) && !runsInlineScript(call)) {
    return approved(
      'dev-tool',
      `approved: ${show(call.program)} is a development tool and every path it names is inside the clone, a temporary directory or a tool cache`,
    );
  }

  // 13. Everything else waits for the owner, and the reason names what was not recognised.
  if (reachesRegistry(call)) {
    const asked = texts(positionals(call.args)).slice(1).join(' ');
    return undecided(
      'unrecognised',
      `${show(call.program)} would fetch ${asked === '' ? 'something' : show(asked)}, which no manifest of the clone declares; declare it first, or say why the task needs it`,
    );
  }
  if (runsInlineScript(call)) {
    return undecided(
      'unrecognised',
      `${show(call.program)} is handed a script on the command line, which these rules cannot read; put the script in a file in the clone, or say what it does`,
    );
  }
  const named = call.program === '' ? (segment.words[0]?.source ?? '') : call.program;
  return undecided(
    'unrecognised',
    `${show(named)} is not one of the tools these rules know; do the work inside the sandbox, or say which program you need and why`,
  );
}

// ---------------------------------------------------------------------------------------------------------------
// File changes

/** A write grant outlives the one patch it comes with, so it may never stand above the clone. */
function judgeGrantRoot(grantRoot: string | undefined, clone: Clone): ApprovalJudgement | null {
  if (grantRoot === undefined || grantRoot === '') return null;
  const path = grantRoot.startsWith('/') ? grantRoot : `/${clone.root.join('/')}/${grantRoot}`;
  if (inside(pathSegments(path), clone.root)) return null;
  return declined(
    'outside-clone',
    `declined: the request asks to write anywhere under ${show(grantRoot)}, which is not inside the clone ${show(clone.text)}; ask for the files of the clone alone`,
  );
}

interface DiffFile {
  path: string;
  /** The change makes the file a symlink; its target is the line the diff adds. */
  symlinkTarget: string | null;
}

/** The header the runner writes above each change of a file_change request (add, update, delete, move a -> b). */
const CHANGE_HEADER = /^(?:add|update|delete|move)\s+(.+)$/;
const MOVE = /^(.+?)\s+->\s+(.+)$/;
const GIT_HEADER = /^diff --git (.+?) (.+)$/;
const SIDE = /^(?:---|\+\+\+) (.+)$/;
const RENAME = /^rename (?:from|to) (.+)$/;
/** The mode git gives a symlink. */
const SYMLINK_MODE = /^(?:new file mode|new mode|old mode|deleted file mode|index .*)\s120000\s*$/;

/**
 * The files a diff changes, read from its headers: the runner writes one header per change ("add src/x", "move a
 * -> b") and the body below it may carry the usual unified headers as well. Null when no header can be read at
 * all, which is the only honest thing to say about a diff these rules do not understand.
 */
function diffFiles(diff: string): DiffFile[] | null {
  const files: DiffFile[] = [];
  let symlink = false;
  const add = (path: string): void => {
    const name = path
      .replace(/\t.*$/, '')
      .trim()
      .replace(/^"(.*)"$/, '$1')
      .replace(/^[ab]\//, '');
    if (name === '' || name === '/dev/null') return;
    files.push({ path: name, symlinkTarget: null });
  };
  for (const line of diff.split('\n')) {
    const change = line.match(CHANGE_HEADER);
    const git = line.match(GIT_HEADER);
    const side = line.match(SIDE);
    const rename = line.match(RENAME);
    if (change !== null) {
      symlink = false;
      const moved = change[1].match(MOVE);
      if (moved === null) add(change[1]);
      else {
        add(moved[1]);
        add(moved[2]);
      }
      continue;
    }
    if (git !== null) {
      symlink = false;
      add(git[1]);
      if (git[2] !== git[1]) add(git[2]);
      continue;
    }
    if (side !== null) {
      add(side[1]);
      continue;
    }
    if (rename !== null) {
      add(rename[1]);
      continue;
    }
    if (SYMLINK_MODE.test(line)) {
      symlink = true;
      continue;
    }
    const last = files.at(-1);
    if (symlink && last !== undefined && line.startsWith('+') && !line.startsWith('+++')) {
      last.symlinkTarget = line.slice(1).trim();
      symlink = false;
    }
  }
  return files.length === 0 ? null : files;
}

/** Rule 12: a patch that stays in the clone and leaves what git and the runner own alone. */
function judgeFileChange(detail: Approval['detail'], clone: Clone): ApprovalJudgement {
  const grant = judgeGrantRoot(detail.grantRoot, clone);
  if (grant !== null) return grant;
  const files = diffFiles(detail.diff ?? '');
  if (files === null) {
    return undecided(
      'unparsed-diff',
      'the request carries no diff whose file headers these rules can read, so the owner answers this one',
    );
  }
  for (const file of files) {
    const absolute = file.path.startsWith('/') ? file.path : `/${clone.root.join('/')}/${file.path}`;
    const segments = pathSegments(absolute);
    if (!inside(segments, clone.root)) {
      return declined(
        'outside-clone',
        `declined: the diff changes ${show(file.path)}, which is outside the clone ${show(clone.text)}; change the files of the clone only`,
      );
    }
    const folded = segments.slice(clone.root.length).map(fold);
    if (folded.includes(fold('.git'))) {
      return declined(
        'git-danger',
        `declined: the diff changes ${show(file.path)} inside .git, where a hook or a setting would then act on its own; change the files of the repository instead`,
      );
    }
    if (folded.includes(fold('.agflow'))) {
      return declined(
        'protected-path',
        `declined: the diff changes ${show(file.path)} inside .agflow, which belongs to the runner and not to the task; change the files of the repository instead`,
      );
    }
    if (file.symlinkTarget !== null) {
      const target = file.symlinkTarget.startsWith('/')
        ? file.symlinkTarget
        : `${posix.dirname(absolute)}/${file.symlinkTarget}`;
      if (!inside(pathSegments(target), clone.root)) {
        return declined(
          'escaping-symlink',
          `declined: the diff makes ${show(file.path)} a link to ${show(file.symlinkTarget)}, which leaves the clone; keep the links inside the clone`,
        );
      }
    }
  }
  return approved(
    'inside-clone',
    'approved: every file of the diff is inside the clone, none of them is under .git or .agflow, and no new link leaves the clone',
  );
}
