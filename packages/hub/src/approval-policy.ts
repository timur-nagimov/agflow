// The rules that answer an approval request without a person (design 6.10, Who may answer; section 5, Unattended
// options). The agent holding the lead seat sends the answer, but the answer is not the lead's reading of the
// request: a request is written by an agent that may have read repository content an attacker wrote, so only the
// parsed shape of the command or of the diff decides here. Nothing in the text can argue its way to an approval,
// and `summary` and `detail.reason`, the two free-text fields, are never read.
//
// The rules hold one boundary: the clone of the attempt. Inside it, the agent's own files are trusted. An approved
// `npm test` runs whatever the repository's tests say, and the agent may have written them, so these rules cannot
// stop an agent that is determined to run code outside the sandbox; that is inherent, and the documentation says
// so. What the rules do hold is the boundary itself. They never approve a request that reaches outside the clone:
// a program, a file, a directory, a registry or a configuration from anywhere else. They never approve a
// re-spelling of a request they refuse, so `find . -exec sh -c X` fares no better than `sh -c X`. And they never
// judge a part of a request as if it were the whole: a field the runner cut short, or the arguments a program reads
// from its input. Containment is textual. The rules are pure and cannot stat, so every path is judged as it is
// written, and a link inside the clone is clone content, like any other file the agent wrote.
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
import { type Approval, approvalFieldCut, innerCommand } from '@agflow/core';
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

/** The fields of a request a verdict rests on. The free text is never read, so a cut summary or reason is no matter. */
const JUDGED_FIELDS = ['command', 'cwd', 'diff', 'grantRoot'] as const;

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
  // 2. The runner cuts a long field and marks the cut. What is left is only the part that fit, and the runner hands
  // the vendor the whole request once it is approved, so a verdict on the part would be a verdict on something else.
  const cut = JUDGED_FIELDS.find((field) => {
    const value = approval.detail[field];
    return value !== undefined && approvalFieldCut(value);
  });
  if (cut !== undefined) {
    return undecided(
      'cut-request',
      `the request was too long to judge whole: the runner cut its ${cut} short, and a verdict on the part shown would not hold for the rest; the owner answers this one`,
    );
  }
  // 3. A request of kind 'other' (a permission profile, an elicitation) has no shape these rules read.
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
  /** The home the clone sits in, when it sits in one: the owner's, and what "~" expands to. */
  home: string[] | null;
}

function cloneOf(cloneRoot: string | null): Clone | null {
  if (cloneRoot === null || !cloneRoot.startsWith('/') || approvalFieldCut(cloneRoot)) return null;
  const root = pathSegments(cloneRoot);
  // "/" is no clone root: everything would count as inside it.
  if (root.length === 0) return null;
  const home = root.length >= 2 && HOME_PARENTS.has(fold(root[0])) ? root.slice(0, 2) : null;
  return { text: posix.normalize(cloneRoot), root, home };
}

/** Where a path sits, as rule 8 sorts places. */
type Place = 'inside' | 'device' | 'stream' | 'temp' | 'system' | 'cache' | 'outside' | 'unknown';

/** Device files that hold nothing and run nothing: `2>/dev/null` names a place outside the clone that keeps nothing. */
const DEVICE_PREFIXES = asPrefixes(['/dev/null', '/dev/zero', '/dev/random', '/dev/urandom', '/dev/tty']);
/** The streams of the command itself: a program read from /dev/stdin is a program the text does not show. */
const STREAM_PREFIXES = asPrefixes(['/dev/stdin', '/dev/stdout', '/dev/stderr', '/dev/fd']);
/** The temporary directories, with the /private twins macOS resolves them to. */
const TEMP_PREFIXES = asPrefixes(['/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp']);
/** Read-only places of the system and its toolchains: reaching into them is no way out of the clone. */
const SYSTEM_PREFIXES = asPrefixes(['/usr', '/bin', '/sbin', '/opt/homebrew', '/Library/Developer', '/System']);
/** The tool caches under the owner's home that a build legitimately reads and fills. */
const CACHE_PREFIXES = asPrefixes([
  '.cache', '.bun/install', '.npm/_cacache', 'Library/Caches', '.cargo/registry', '.rustup', 'go/pkg', '.m2',
  '.gradle/caches', '.pyenv', '.local/share/uv', '.local/share/virtualenvs',
]);

/**
 * The per-user directories of macOS, /var/folders/<xx>/<yy>/, hold the user's temporary directory under T and the
 * user's caches under C. Only T is temporary.
 */
function perUserTemp(folded: readonly string[]): boolean {
  const at = folded[0] === 'private' ? 1 : 0;
  return folded[at] === 'var' && folded[at + 1] === 'folders' && folded.length > at + 4 && folded[at + 4] === 't';
}

interface PathToken {
  /** The word as it was written, for the reason. */
  text: string;
  /** The absolute path it names; null when a value the rules cannot expand stands in the way. */
  path: string | null;
  /**
   * Its place below the owner's home, the one the clone sits in: "~/.cache/x" and "/Users/me/.cache/x" both leave
   * ".cache/x". Null below any other home.
   */
  ownHome: string[] | null;
}

function place(token: PathToken, clone: Clone): Place {
  if (token.path !== null) {
    const segments = pathSegments(token.path);
    const folded = segments.map(fold);
    if (inside(segments, clone.root)) return 'inside';
    if (under(folded, DEVICE_PREFIXES)) return 'device';
    if (under(folded, STREAM_PREFIXES)) return 'stream';
    if (under(folded, TEMP_PREFIXES) || perUserTemp(folded)) return 'temp';
    if (under(folded, SYSTEM_PREFIXES)) return 'system';
  }
  // Only the owner's own home has caches: another account's .cache is that account's business, not a build's.
  if (token.ownHome !== null && under(token.ownHome.map(fold), CACHE_PREFIXES)) return 'cache';
  // A home-rooted path whose home the rules cannot locate is outside all the same: the clone sits in no home.
  if (token.path !== null || token.ownHome !== null) return 'outside';
  return 'unknown';
}

/**
 * A word that names a site, not a path: no containment check can hold it. "//host/x" is one with its scheme left
 * off.
 */
const isUrl = (text: string): boolean =>
  /^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^[^\s/]+@[^\s/]+:/.test(text) || /^\/\/[^/]/.test(text);

/**
 * Where a word points from a directory. A "~" or "$HOME" start roots it at the owner's home (the lexer strips both,
 * and a value written after an "=" keeps its own "~"), anything else absolute stands on its own, and the rest is
 * read from the directory.
 */
function resolve(word: Word, dir: string | null, clone: Clone): PathToken {
  // ~name: the account's home sits beside the owner's, as homes do; only the owner's own name lands in the
  // owner's home. The word stays unresolved, so a path this guess puts inside the clone is still not approved.
  if (word.user !== undefined && clone.home !== null && !word.text.includes('$')) {
    const part = pathSegments(`/${word.text}`);
    const segments = [clone.home[0], word.user, ...part];
    const ownHome = word.user === clone.home[1] ? part : null;
    return { text: word.source, path: `/${segments.join('/')}`, ownHome };
  }
  if (word.unresolved) return { text: word.source, path: null, ownHome: null };
  let text = word.text;
  let home = word.home;
  if (!home && (text === '~' || text.startsWith('~/'))) {
    home = true;
    text = text.slice(2);
  }
  if (home) {
    const part = pathSegments(`/${text}`);
    const root = clone.home;
    return { text: word.source, path: root === null ? null : `/${[...root, ...part].join('/')}`, ownHome: part };
  }
  const absolute = text.startsWith('/') ? text : dir === null ? null : `${dir}/${text}`;
  if (absolute === null) return { text: word.source, path: null, ownHome: null };
  const segments = pathSegments(absolute);
  const ownHome = clone.home !== null && inside(segments, clone.home) ? segments.slice(clone.home.length) : null;
  return { text: word.source, path: `/${segments.join('/')}`, ownHome };
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
  /** The word is rooted at the home of the account of this name: "~other/x" leaves "x" in text. */
  user?: string;
}

interface Redirect {
  /**
   * What the redirection does with its target: writes it, reads it, hands the word itself over as input (a
   * here-string), or duplicates a descriptor (2>&1), which names no file at all.
   */
  kind: 'write' | 'read' | 'text' | 'dup';
  target: Word;
}

interface Segment {
  words: Word[];
  redirects: Redirect[];
  /** The segment reads the output of the one before it through a pipe. */
  piped: boolean;
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

/** What a redirection does, by its operator and its target: `>&file` writes the file, `>&2` only duplicates. */
function redirectKind(op: string, target: Word): Redirect['kind'] {
  if (op === '<<<') return 'text';
  if (WRITING_OPS.has(op)) return 'write';
  if (op === '>&' || op === '<&') {
    if (!target.unresolved && /^\d*-?$/.test(target.text)) return 'dup';
    return op === '>&' ? 'write' : 'read';
  }
  return 'read';
}

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
  let pending: string | null = null;
  let piped = false;
  let at = 0;
  const end = (pipe: boolean): void => {
    if (words.length > 0 || redirects.length > 0) segments.push({ words, redirects, piped });
    words = [];
    redirects = [];
    pending = null;
    piped = pipe;
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
        end(false);
        continue;
      }
      // `|&` pipes the error output too: it is a pipe all the same.
      if (c === '|' && command[at + 1] === '&') {
        at += 2;
        end(true);
        continue;
      }
      if (c === '&' || c === '|') {
        const doubled = command[at + 1] === c;
        at += doubled ? 2 : 1;
        end(c === '|' && !doubled);
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
        pending = op;
        continue;
      }
      const read = readWord(command, at);
      at = read.at;
      if (pending === null) words.push(read.word);
      else {
        redirects.push({ kind: redirectKind(pending, read.word), target: read.word });
        pending = null;
      }
    }
  } catch (error) {
    if (error instanceof HiddenText) return { ok: false, hidden: true, problem: error.message };
    if (error instanceof Unreadable) return { ok: false, hidden: false, problem: error.message };
    throw error;
  }
  end(false);
  return { ok: true, segments };
}

/** One word from `from`, with its quotes removed and its expansions read as far as they can be. */
function readWord(src: string, from: number): { word: Word; at: number } {
  let at = from;
  let text = '';
  let unresolved = false;
  let home = false;
  let user: string | undefined;
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
      const next = src[at + 1];
      if (next === undefined || next === '/' || WORD_END.has(next)) {
        home = true;
        at += next === '/' ? 2 : 1;
        continue;
      }
      // ~name is the home of the account of that name, which the rules can place only by guessing; ~+, ~- and
      // the rest name a directory only the shell knows. Neither is approved on a guess.
      unresolved = true;
      const named = src.slice(at).match(/^~([A-Za-z0-9_][A-Za-z0-9_.-]*)(?=$|\/|[\s;&|()<>])/);
      if (named !== null) {
        user = named[1];
        at += named[0].length + (src[at + named[0].length] === '/' ? 1 : 0);
        continue;
      }
    }
    text += c;
    at += 1;
  }
  return { word: { text, source: src.slice(from, at), unresolved, home, ...(user === undefined ? {} : { user }) }, at };
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

interface Wrapper {
  /** The options of the wrapper that take their value in the next word. */
  valued: ReadonlySet<string>;
  /** The words after the options that belong to the wrapper, before the program it runs. */
  positionals: number;
}

/** Programs that run another program: the one that does the work stands further along the words. */
const WRAPPERS = new Map<string, Wrapper>([
  ['env', { valued: new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string', '-P']), positionals: 0 }],
  ['command', { valued: new Set(), positionals: 0 }],
  ['builtin', { valued: new Set(), positionals: 0 }],
  ['exec', { valued: new Set(['-a']), positionals: 0 }],
  ['nohup', { valued: new Set(), positionals: 0 }],
  ['time', { valued: new Set(), positionals: 0 }],
  ['caffeinate', { valued: new Set(['-t', '-w']), positionals: 0 }],
  ['setsid', { valued: new Set(), positionals: 0 }],
  ['stdbuf', { valued: new Set(['-i', '-o', '-e']), positionals: 0 }],
  ['nice', { valued: new Set(['-n', '--adjustment']), positionals: 0 }],
  ['timeout', { valued: new Set(['-s', '-k', '--signal', '--kill-after']), positionals: 1 }],
  ['gtimeout', { valued: new Set(['-s', '-k', '--signal', '--kill-after']), positionals: 1 }],
  [
    'xargs',
    {
      valued: new Set(['-I', '-J', '-L', '-n', '-P', '-s', '-E', '-d', '-a', '--arg-file', '--delimiter']),
      positionals: 0,
    },
  ],
  [
    'nyc',
    {
      valued: new Set([
        '-r', '--reporter', '-i', '--require', '-n', '--include', '-x', '--exclude', '-e', '--extension', '-t',
        '--temp-dir', '--report-dir', '--cwd', '--nycrc-path',
      ]),
      positionals: 0,
    },
  ],
]);

/** One program of a segment and the words that belong to it. */
interface Part {
  /** The word that names it. */
  word: Word;
  /** Its base name, folded: what the rules recognise it by. */
  name: string;
  /** Its words, up to the next program of the segment. */
  args: Word[];
  /**
   * How the command names it: by a program word of its own, as a module python -m runs, or implied by a script a
   * project runner was given (`uv run x.py` runs python).
   */
  via: 'word' | 'module' | 'implied';
}

interface Call {
  /** Every program the segment runs, the wrappers and dispatchers first; the last one does the work. */
  parts: Part[];
  /** Their names. */
  programs: string[];
  /** The name of the last one. */
  program: string;
  /** Its words. */
  args: Word[];
  last: Part | undefined;
  /** The NAME=value words in front of the programs, those env sets included. */
  assignments: Word[];
  /** Why the program that would do the work cannot be told from the words: it is fetched, or not one the rules know. */
  hidden: ApprovalJudgement | null;
}

/** A program name as the shell would find it: without its directory, without the "=" of zsh, folded. */
const programName = (text: string): string => fold(posix.basename(text.replace(/^=/, '').replace(/\/+$/, '')));

function callOf(words: readonly Word[]): Call {
  const parts: Part[] = [];
  const assignments: Word[] = [];
  let at = 0;
  while (at < words.length) {
    const word = words[at];
    if (RESERVED.has(word.text) || ASSIGNMENT.test(word.text)) {
      if (!RESERVED.has(word.text)) assignments.push(word);
      at += 1;
      continue;
    }
    const name = programName(word.text);
    at += 1;
    const wrapper = WRAPPERS.get(name);
    const end =
      wrapper === undefined
        ? words.length
        : Math.min(words.length, skipOptions(words, at, wrapper.valued) + wrapper.positionals);
    parts.push({ word, name, args: words.slice(at, end), via: 'word' });
    at = end;
    if (wrapper === undefined) break;
  }
  // A dispatcher runs a program its arguments name: python -m pytest, uv run pytest, npx tsc. That program is judged
  // as the one doing the work, so `python -m pip install x` is the pip install it is.
  let hidden: ApprovalJudgement | null = null;
  for (let round = 0; round < 8; round += 1) {
    const last = parts.at(-1);
    const next = last === undefined ? null : dispatch(last);
    if (last === undefined || next === null) break;
    if ('problem' in next) {
      hidden = next.problem;
      break;
    }
    last.args = next.own;
    parts.push(next.part);
  }
  const last = parts.at(-1);
  return {
    parts,
    programs: parts.map((part) => part.name),
    program: last?.name ?? '',
    args: last?.args ?? [],
    last,
    assignments,
    hidden,
  };
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

const NO_OPTIONS: ReadonlySet<string> = new Set();

/** The index of the first word of `args` that is no option, skipping the values of the valued ones. */
function subcommandAt(args: readonly Word[], valued: ReadonlySet<string> = NO_OPTIONS): number {
  let at = 0;
  while (at < args.length) {
    const text = args[at].text;
    if (text === '--') return at + 1;
    if (!text.startsWith('-') || text === '-') return at;
    at += valued.has(text) ? 2 : 1;
  }
  return at;
}

const texts = (words: readonly Word[]): string[] => words.map((word) => word.text);
const positionals = (words: readonly Word[]): Word[] => words.filter((word) => !word.text.startsWith('-'));

type Dispatched = { own: Word[]; part: Part } | { problem: ApprovalJudgement } | null;

function dispatch(part: Part): Dispatched {
  switch (part.name) {
    case 'python':
    case 'python3':
      return pythonModule(part);
    case 'uv':
    case 'poetry':
    case 'pdm':
    case 'hatch':
    case 'pipenv':
      return projectRun(part);
    case 'coverage':
      return coverageRun(part);
    case 'npx':
    case 'bunx':
      return localTool(part, part.args, []);
    case 'bun': {
      const at = subcommandAt(part.args, BUN_VALUED);
      return part.args[at]?.text === 'x' ? localTool(part, part.args.slice(at + 1), part.args.slice(0, at + 1)) : null;
    }
    case 'pnpx':
    case 'uvx':
      return { problem: fetchedRunner(part.name) };
    case 'pnpm':
    case 'yarn': {
      const at = subcommandAt(part.args, PM_VALUED);
      return part.args[at]?.text === 'dlx' ? { problem: fetchedRunner(`${part.name} dlx`) } : null;
    }
    default:
      return null;
  }
}

/**
 * A runner that always fetches what it runs into a throwaway environment: nothing of the clone decides what that
 * is.
 */
const fetchedRunner = (runner: string): ApprovalJudgement =>
  undecided(
    'unrecognised',
    `${show(runner)} fetches the package it runs from a registry, which no manifest of the clone declares; add the tool to the manifest and run it from there, or say why the task needs it`,
  );

/**
 * The tools a project installs for itself, which npx, bunx and bun x run from the clone's node_modules. Any other
 * name is a package fetched from a registry on the spot, and so is one of these with a version, a scope or a source.
 */
const LOCAL_TOOLS = new Set([
  'tsc', 'eslint', 'prettier', 'vitest', 'jest', 'playwright', 'biome', 'tsx', 'vite', 'mocha', 'nyc', 'ruff',
]);
/** The options of npx and bunx that fetch a package, or run a command line instead of a tool. */
const FETCH_FLAGS = new Set(['-y', '--yes', '-p', '--package', '-c', '--call', '--ignore-existing']);
const NPX_VALUED = new Set(['-p', '--package', '-c', '--call', '-w', '--workspace']);

function localTool(part: Part, args: readonly Word[], before: readonly Word[]): Dispatched {
  let at = 0;
  while (at < args.length) {
    const text = args[at].text;
    if (text === '--') {
      at += 1;
      break;
    }
    if (!text.startsWith('-')) break;
    if (FETCH_FLAGS.has(text.split('=')[0])) {
      return { problem: fetchedRunner(`${part.name} ${text.split('=')[0]}`) };
    }
    at += NPX_VALUED.has(text) ? 2 : 1;
  }
  const tool = args[at];
  if (tool === undefined) return null;
  if (tool.unresolved || !LOCAL_TOOLS.has(tool.text)) {
    return {
      problem: undecided(
        'unrecognised',
        `${show(part.name)} would fetch and run ${show(tool.source)} from a registry, which no manifest of the clone declares; add it to the manifest and run it from there, or say why the task needs it`,
      ),
    };
  }
  return {
    own: [...before, ...args.slice(0, at)],
    part: { word: tool, name: tool.text, args: args.slice(at + 1), via: 'word' },
  };
}

/** The modules python -m may run, by the program each is judged as; any other module is unknown. */
const PYTHON_MODULES = new Map<string, string>([
  ['pip', 'pip'], ['pip3', 'pip'], ['pytest', 'pytest'], ['mypy', 'mypy'], ['black', 'black'], ['isort', 'isort'],
  ['flake8', 'flake8'], ['ruff', 'ruff'], ['tox', 'tox'], ['coverage', 'coverage'], ['nox', 'nox'],
  ['virtualenv', 'virtualenv'], ['poetry', 'poetry'], ['uv', 'uv'], ['pre_commit', 'pre-commit'],
  ['alembic', 'alembic'], ['django', 'django-admin'], ['venv', 'venv'], ['unittest', 'unittest'],
  ['doctest', 'doctest'], ['compileall', 'compileall'], ['py_compile', 'py_compile'], ['json.tool', 'json.tool'],
]);
/** Modules of the standard library that are development tools, but only as python -m runs them. */
const PYTHON_TOOLS = new Set(['venv', 'unittest', 'doctest', 'compileall', 'py_compile', 'json.tool']);

/**
 * `python -m <module> …` runs the module as a program, so it is judged as that program with the rest as its
 * arguments. The options before -m are read as python reads them: -W and -X take a value, and -c ends them with a
 * script.
 */
function pythonModule(part: Part): Dispatched {
  const args = part.args;
  for (let at = 0; at < args.length; at += 1) {
    const text = args[at].text;
    if (text === '--' || !text.startsWith('-') || text === '-') return null;
    if (text.startsWith('--')) {
      if (text === '--check-hash-based-pycs') at += 1;
      continue;
    }
    for (let letter = 1; letter < text.length; letter += 1) {
      const flag = text[letter];
      if (flag === 'c') return null;
      if (flag === 'W' || flag === 'X') {
        if (letter === text.length - 1) at += 1;
        break;
      }
      if (flag === 'm') {
        const attached = text.slice(letter + 1);
        const named = attached === '' ? args[at + 1] : { ...args[at], text: attached };
        if (named === undefined) return null;
        const next = attached === '' ? at + 2 : at + 1;
        return moduleCall(part, named, args.slice(0, next), args.slice(next));
      }
    }
  }
  return null;
}

function moduleCall(part: Part, named: Word, own: Word[], rest: Word[]): Dispatched {
  const tool = named.unresolved ? undefined : PYTHON_MODULES.get(named.text);
  if (tool === undefined) {
    return {
      problem: undecided(
        'unrecognised',
        `${show(`${part.name} -m ${named.source}`)} runs a module these rules do not know, from wherever python finds it; run a development tool they know, or say what the module does`,
      ),
    };
  }
  return { own, part: { word: named, name: tool, args: rest, via: 'module' } };
}

/** The options of a project runner that come before its subcommand and take a value. */
const RUNNER_VALUED = new Map<string, ReadonlySet<string>>([
  [
    'uv',
    new Set([
      '--directory', '--project', '--cache-dir', '--config-file', '--color', '--python-preference',
      '--allow-insecure-host',
    ]),
  ],
  ['poetry', new Set(['-C', '--directory', '-P', '--project'])],
  ['pdm', new Set(['-p', '--project', '-c', '--config'])],
  ['hatch', new Set(['-e', '--env', '-p', '--project', '--data-dir', '--cache-dir', '--config'])],
  ['pipenv', new Set(['--python'])],
]);
/** The options of `<runner> run` that take a value, before the program it runs. */
const RUN_VALUED = new Map<string, ReadonlySet<string>>([
  [
    'uv',
    new Set([
      '--with', '--with-editable', '--with-requirements', '--python', '-p', '--extra', '--group', '--only-group',
      '--no-group', '--package', '--directory', '--project', '--env-file', '--index', '--index-url',
      '--extra-index-url', '--default-index', '--find-links', '-f', '--config-file', '--cache-dir',
      '--python-preference', '--index-strategy', '--keyring-provider', '--resolution', '--prerelease',
      '--exclude-newer', '--link-mode', '--refresh-package', '--reinstall-package', '--upgrade-package', '-P',
      '--no-binary-package', '--no-build-package', '--config-setting', '-C', '--color', '--allow-insecure-host',
      '--no-extra',
    ]),
  ],
  ['poetry', new Set(['-C', '--directory', '-P', '--project'])],
  ['pdm', new Set(['-p', '--project'])],
  ['hatch', new Set()],
  ['pipenv', new Set()],
]);
/** The options of uv run that fetch what no manifest declares: a package, an index, an interpreter. */
const UV_RUN_FETCHES = new Set([
  '--with', '--with-editable', '--with-requirements', '--python', '-p', '--index', '--index-url',
  '--extra-index-url', '--default-index', '--find-links', '-f',
]);

/** `uv run X`, `poetry run X` and their kind run X in the project's environment: X is the program judged. */
function projectRun(part: Part): Dispatched {
  const args = part.args;
  const at = subcommandAt(args, RUNNER_VALUED.get(part.name));
  if (args[at]?.text !== 'run') return null;
  const valued = RUN_VALUED.get(part.name) ?? NO_OPTIONS;
  let next = at + 1;
  while (next < args.length) {
    const text = args[next].text;
    if (text === '--') {
      next += 1;
      break;
    }
    if (!text.startsWith('-')) break;
    const flag = text.split('=')[0];
    if (part.name === 'uv' && UV_RUN_FETCHES.has(flag)) {
      return {
        problem: undecided(
          'unrecognised',
          `${show(`uv run ${flag}`)} fetches a package, an index or an interpreter that no manifest of the clone declares; declare it in the project, or say why the task needs it`,
        ),
      };
    }
    next += valued.has(text) ? 2 : 1;
  }
  const target = args[next];
  if (target === undefined) return null;
  const own = args.slice(0, next);
  const rest = args.slice(next + 1);
  // A script is run with the project's python.
  if (/\.py$/i.test(target.text)) {
    return { own, part: { word: target, name: 'python', args: [target, ...rest], via: 'implied' } };
  }
  return { own, part: { word: target, name: programName(target.text), args: rest, via: 'word' } };
}

const COVERAGE_RUN_VALUED = new Set([
  '--rcfile', '--source', '--include', '--omit', '--context', '--data-file', '--concurrency',
]);

/** `coverage run -m X` runs the module X and `coverage run x.py` the script: either is what the command does. */
function coverageRun(part: Part): Dispatched {
  const args = part.args;
  const at = subcommandAt(args);
  if (args[at]?.text !== 'run') return null;
  let next = at + 1;
  while (next < args.length) {
    const text = args[next].text;
    if (text === '--') {
      next += 1;
      break;
    }
    if (text === '-m' || text === '--module') {
      const named = args[next + 1];
      return named === undefined ? null : moduleCall(part, named, args.slice(0, next + 2), args.slice(next + 2));
    }
    if (!text.startsWith('-')) break;
    next += COVERAGE_RUN_VALUED.has(text) ? 2 : 1;
  }
  const script = args[next];
  if (script === undefined) return null;
  return { own: args.slice(0, next), part: { word: script, name: 'python', args: args.slice(next), via: 'implied' } };
}

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
/** The tails of the env files a repository tracks as templates for the real one: they hold no secret. */
const ENV_TEMPLATES = ['.example', '.sample', '.template', '.dist'];

/**
 * Key material by file name: the private key spellings, the certificate suffixes, and every .env file, which is
 * .env itself, a .env.local beside it, and a secrets.env that holds the same thing under another name. A tracked
 * template (.env.example, .env.sample, .env.template, .env.dist) is the documentation of one, not one.
 */
const secretName = (name: string): boolean =>
  ((name === '.env' || name.startsWith('.env.') || name.endsWith('.env')) &&
    !ENV_TEMPLATES.some((tail) => name.endsWith(tail))) ||
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
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'python', 'python3', 'node', 'ruby', 'perl', 'eval', 'osascript', 'bun',
  'deno', 'tsx', 'source', '.', 'php',
]);

/** Variables that make the loader of the system load a library into every program: privilege by another name. */
const LOADER_VARIABLE = /^(DYLD_.*|LD_PRELOAD|LD_LIBRARY_PATH|LD_AUDIT)$/;

/** The name of an assignment, and the value after its first "=". */
function assignmentOf(word: Word): { name: string; value: string } {
  const split = word.text.indexOf('=');
  return { name: word.text.slice(0, split).replace(/\+$/, ''), value: word.text.slice(split + 1) };
}

/** The options of git itself that take their value in the next word, before the subcommand. */
const GIT_VALUED = new Set([
  '-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix', '--list-cmds',
  '--attr-source',
]);

interface GitCall {
  /** The keys set by -c and --config-env for this command. */
  settings: string[];
  /** --exec-path=… points git at a directory of programs to run. */
  execPath: boolean;
  subcommand: string;
  /** The words after the subcommand. */
  rest: Word[];
}

function gitCall(args: readonly Word[]): GitCall {
  const settings: string[] = [];
  let execPath = false;
  let at = 0;
  while (at < args.length) {
    const text = args[at].text;
    if (!text.startsWith('-')) break;
    if (text === '-c' || text === '--config-env') {
      settings.push((args[at + 1]?.text ?? '').split('=')[0]);
      at += 2;
      continue;
    }
    if (text.startsWith('--config-env=')) settings.push(text.slice('--config-env='.length).split('=')[0]);
    if (text.startsWith('--exec-path=')) execPath = true;
    at += GIT_VALUED.has(text) ? 2 : 1;
  }
  return { settings, execPath, subcommand: args[at]?.text ?? '', rest: args.slice(at + 1) };
}

/** The keys whose value git runs as a program, or reads as more configuration (the runner pins the same ones). */
const GIT_PROGRAM_KEYS = new Set([
  'core.hookspath', 'core.pager', 'core.editor', 'core.sshcommand', 'core.fsmonitor', 'core.askpass',
  'core.gitproxy', 'core.worktree', 'core.alternaterefscommand', 'sequence.editor', 'diff.external',
  'interactive.difffilter', 'uploadpack.packobjectshook', 'http.proxy', 'https.proxy', 'credential.helper',
  'include.path', 'gpg.program', 'web.browser', 'protocol.allow',
]);
/** The same for keys with a subsection, by section and variable: diff.<driver>.textconv. */
const GIT_PROGRAM_PATTERNS: readonly (readonly [string, string])[] = [
  ['diff', 'textconv'], ['diff', 'command'], ['merge', 'driver'], ['filter', 'clean'], ['filter', 'smudge'],
  ['filter', 'process'], ['remote', 'url'], ['remote', 'pushurl'], ['remote', 'uploadpack'],
  ['remote', 'receivepack'], ['remote', 'vcs'], ['remote', 'proxy'], ['url', 'insteadof'],
  ['url', 'pushinsteadof'], ['protocol', 'allow'], ['http', 'proxy'], ['credential', 'helper'],
  ['includeif', 'path'], ['gpg', 'program'], ['gpg', 'defaultkeycommand'], ['difftool', 'cmd'],
  ['difftool', 'path'], ['mergetool', 'cmd'], ['mergetool', 'path'], ['man', 'cmd'], ['man', 'path'],
  ['browser', 'cmd'], ['browser', 'path'], ['trailer', 'cmd'], ['trailer', 'command'], ['tar', 'command'],
  ['submodule', 'update'], ['submodule', 'url'],
];
/** Sections every key of which names a program: an alias may run a shell command, and so may a pager. */
const GIT_PROGRAM_SECTIONS = new Set(['alias', 'pager', 'sendemail']);

/** Whether git would run the value of a key, or read it as configuration from elsewhere; case is no matter to git. */
function gitProgramKey(key: string): boolean {
  const folded = key.toLowerCase();
  if (GIT_PROGRAM_KEYS.has(folded)) return true;
  const first = folded.indexOf('.');
  const last = folded.lastIndexOf('.');
  if (first < 0) return false;
  const section = folded.slice(0, first);
  if (GIT_PROGRAM_SECTIONS.has(section)) return true;
  if (first === last) return false;
  const variable = folded.slice(last + 1);
  return GIT_PROGRAM_PATTERNS.some(([s, v]) => s === section && v === variable);
}

/** The settings a task may change in its clone: who commits, how text and history look. */
const GIT_INERT_KEYS = new Set([
  'user.name', 'user.email', 'user.useconfigonly', 'init.defaultbranch', 'core.autocrlf', 'core.eol',
  'core.filemode', 'core.ignorecase', 'core.quotepath', 'core.safecrlf', 'core.whitespace',
  'core.precomposeunicode', 'push.default', 'push.autosetupremote', 'push.followtags', 'pull.rebase', 'pull.ff',
  'rebase.autostash', 'rebase.autosquash', 'rebase.updaterefs', 'merge.ff', 'merge.conflictstyle', 'diff.renames',
  'diff.algorithm', 'diff.colormoved', 'diff.mnemonicprefix', 'diff.noprefix', 'log.date', 'log.decorate',
  'log.abbrevcommit', 'branch.autosetupmerge', 'branch.autosetuprebase', 'fetch.prune', 'rerere.enabled',
  'rerere.autoupdate', 'commit.verbose', 'commit.gpgsign', 'tag.gpgsign', 'help.autocorrect',
  'status.showuntrackedfiles', 'status.short', 'status.branch',
]);
const GIT_INERT_SECTIONS = new Set(['color', 'column', 'advice', 'i18n']);
const gitInertKey = (key: string): boolean =>
  GIT_INERT_KEYS.has(key.toLowerCase()) || GIT_INERT_SECTIONS.has(key.toLowerCase().split('.')[0]);

/** The options of git config that take their value in the next word. */
const GIT_CONFIG_VALUED = new Set(['--file', '-f', '--blob', '--type', '--default', '--comment', '--value']);
const GIT_CONFIG_READS = new Set([
  '--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list', '-l', '--get-color', '--get-colorbool',
]);
const GIT_CONFIG_WRITES = new Set(['--add', '--replace-all', '--unset', '--unset-all']);
const GIT_CONFIG_ANYTHING = new Set(['--edit', '-e', '--rename-section', '--remove-section']);

/**
 * What git config would do: read, or set a key. Any scope counts, because the clone's own configuration is read by
 * every later git command, the runner's included.
 */
function gitConfig(rest: readonly Word[]): ApprovalJudgement | null {
  const flags: string[] = [];
  const given: string[] = [];
  for (let at = 0; at < rest.length; at += 1) {
    const text = rest[at].text;
    if (GIT_CONFIG_VALUED.has(text)) at += 1;
    else if (text.startsWith('-')) flags.push(text.split('=')[0]);
    else given.push(text);
  }
  if (flags.includes('--global') || flags.includes('--system')) {
    return declined(
      'git-danger',
      'declined: git config --global changes the settings of every repository on the laptop; the runner owns the pushing and the history, so change files and leave the rest to it',
    );
  }
  let mode = '';
  if (['get', 'set', 'unset', 'list', 'edit', 'rename-section', 'remove-section'].includes(given[0] ?? '')) {
    mode = given.shift() ?? '';
  }
  if (mode === 'get' || mode === 'list' || flags.some((flag) => GIT_CONFIG_READS.has(flag))) return null;
  if (mode === 'edit' || mode.endsWith('-section') || flags.some((flag) => GIT_CONFIG_ANYTHING.has(flag))) {
    return declined(
      'git-danger',
      'declined: the command edits the git configuration as a whole, which can point git at a program to run; set the one inert key you need instead',
    );
  }
  const writes =
    mode === 'set' || mode === 'unset' || given.length >= 2 || flags.some((flag) => GIT_CONFIG_WRITES.has(flag));
  const key = given[0];
  if (!writes || key === undefined) return null;
  if (gitProgramKey(key)) {
    return declined(
      'git-danger',
      `declined: git config ${show(key)} hands git a program to run, or a place to fetch and push from, outside what the task may change; change the files of the repository instead`,
    );
  }
  if (!gitInertKey(key)) {
    return undecided(
      'unrecognised',
      `git config ${show(key)} is not a setting these rules know to be inert; say why the task needs it, and the owner answers`,
    );
  }
  return null;
}

/** git push that replaces or deletes what the remote holds, in any spelling git accepts. */
function forcesPush(rest: readonly Word[]): boolean {
  const destructive = ['force', 'force-with-lease', 'force-if-includes', 'mirror', 'delete', 'prune'];
  let positional = 0;
  for (let at = 0; at < rest.length; at += 1) {
    const text = rest[at].text;
    if (text === '-o' || text === '--push-option' || text === '--repo') {
      at += 1;
      continue;
    }
    if (text.startsWith('--')) {
      const name = text.slice(2).split('=')[0];
      if (name !== '' && destructive.some((option) => option.startsWith(name))) return true;
      continue;
    }
    if (/^-[A-Za-z0-9]+$/.test(text)) {
      if (/[fd]/.test(text)) return true;
      continue;
    }
    // The remote, then refspecs: "+src:dst" forces, ":dst" deletes.
    if (positional > 0 && (text.startsWith('+') || text.startsWith(':'))) return true;
    positional += 1;
  }
  return false;
}

/** What a git command would give away: the pushing and the history the runner owns, or the laptop settings. */
function gitDanger(git: GitCall): ApprovalJudgement | null {
  const decline = (reason: string): ApprovalJudgement =>
    declined(
      'git-danger',
      `declined: ${reason}; the runner owns the pushing and the history, so change files and leave the rest to it`,
    );
  const setting = git.settings.find(gitProgramKey);
  if (setting !== undefined) {
    return declined(
      'git-danger',
      `declined: git -c ${show(setting)} hands git a program to run, or a place to fetch and push from, for this command; run it without the setting`,
    );
  }
  const rest = texts(git.rest);
  const first = rest.find((text) => !text.startsWith('-')) ?? '';
  switch (git.subcommand) {
    case 'push':
      return forcesPush(git.rest)
        ? decline('git push with a force, a mirror or a delete rewrites what the remote already holds')
        : null;
    case 'config':
      return gitConfig(git.rest);
    case 'remote':
      if (first === 'set-url' || first === 'add') {
        return decline(`git remote ${first} would send the work of this clone somewhere else`);
      }
      return null;
    case 'update-ref':
    case 'filter-branch':
    case 'filter-repo':
      return decline(`git ${git.subcommand} rewrites the history of the clone`);
    case 'reflog':
      return first === 'delete' || first === 'expire'
        ? decline(`git reflog ${first} removes the record a recovery needs`)
        : null;
    case 'clone': {
      const key = configValues(git.rest).find(gitProgramKey);
      return key === undefined
        ? null
        : decline(`git clone -c ${show(key)} hands git a program to run in the new clone`);
    }
    case 'lfs':
      return ['install', 'uninstall', 'update'].includes(first)
        ? decline(`git lfs ${first} writes git hooks and git configuration`)
        : null;
    default:
      return null;
  }
}

/** The keys git clone sets with -c and --config in the clone it makes. */
function configValues(rest: readonly Word[]): string[] {
  const keys: string[] = [];
  for (let at = 0; at < rest.length; at += 1) {
    const text = rest[at].text;
    if (text === '-c' || text === '--config') keys.push((rest[at + 1]?.text ?? '').split('=')[0]);
    else if (text.startsWith('--config=')) keys.push(text.slice('--config='.length).split('=')[0]);
    else if (/^-c./.test(text)) keys.push(text.slice(2).split('=')[0]);
  }
  return keys;
}

/** A long option as git, tar and their kind accept it: the full name, or any prefix of it. */
const abbreviates = (text: string, full: string): boolean => {
  if (!text.startsWith('--')) return false;
  const name = text.slice(2).split('=')[0];
  return name.length >= 2 && full.startsWith(name);
};

/** The git commands that hand git a program or a script to run, which no rule here can read. */
function gitRuns(git: GitCall): string | null {
  if (git.execPath) return 'git --exec-path points git at a directory of programs to run';
  const rest = texts(git.rest);
  const first = rest.find((text) => !text.startsWith('-')) ?? '';
  const sub = git.subcommand;
  if (rest.some((text) => abbreviates(text, 'upload-pack') || abbreviates(text, 'receive-pack'))) {
    return `git ${sub} is told which program to run on the other side`;
  }
  const remote = ['push', 'archive', 'send-pack', 'fetch-pack'].includes(sub);
  if (remote && rest.some((text) => abbreviates(text, 'exec'))) {
    return `git ${sub} --exec names a program to run on the other side`;
  }
  if ((sub === 'clone' || sub === 'ls-remote') && rest.some((text) => /^-u/.test(text))) {
    return `git ${sub} -u names a program to run on the other side`;
  }
  if ((sub === 'clone' || sub === 'init') && rest.some((text) => abbreviates(text, 'template'))) {
    return `git ${sub} --template copies hooks from a directory into the new repository`;
  }
  if (sub === 'rebase' && rest.some((text) => /^-x/.test(text) || abbreviates(text, 'exec'))) {
    return 'git rebase --exec runs a command after every commit';
  }
  if (sub === 'bisect' && first === 'run') return 'git bisect run runs a command';
  if (sub === 'submodule' && first === 'foreach') return 'git submodule foreach runs a command in every submodule';
  if (sub === 'grep' && rest.some((text) => /^-O/.test(text) || abbreviates(text, 'open-files-in-pager'))) {
    return 'git grep -O opens the files with a program it names';
  }
  if (GIT_PROGRAM_COMMANDS.has(sub)) return `git ${sub} runs a program, or serves or sends the repository`;
  return null;
}

/** The git commands that run a tool of their own, or hand the repository to the network. */
const GIT_PROGRAM_COMMANDS = new Set([
  'difftool', 'mergetool', 'send-email', 'daemon', 'instaweb', 'http-backend', 'web--browse', 'imap-send',
]);

/** git clean that takes the ignored files too: safe only where it is known to stay inside the clone. */
function cleansIgnored(call: Call): boolean {
  const args = texts(call.args);
  return args.includes('clean') && args.some((arg) => /^-[a-wyz]*[xX]/.test(arg) || arg === '--force-ignored');
}

// ---------------------------------------------------------------------------------------------------------------
// Rule 8: where every word of a segment points, and what the program would do there

/**
 * What a program does with a word. It reads it (an executing program may load what it reads), reads it as plain
 * data, writes it, loads and runs it, works in it, runs it as a program, or takes it as the value of an environment
 * variable; or the word is text that names no file at all.
 */
type Position = 'read' | 'data' | 'write' | 'load' | 'dir' | 'program' | 'env' | 'text';

/**
 * What kind of program a part is. A reader only reads, copies or lists what it is given, a writer changes it, and
 * an executing program may load what it reads and run it: an interpreter, a build, a package manager, git.
 */
type Kind = 'reader' | 'writer' | 'executing' | 'unknown';

/** The programs that read what they are given and run none of it (their options that would run something aside). */
const READERS = new Set([
  'cat', 'head', 'tail', 'less', 'more', 'grep', 'egrep', 'fgrep', 'rg', 'wc', 'ls', 'stat', 'file', 'diff', 'cmp',
  'jq', 'yq', 'sort', 'uniq', 'cut', 'tr', 'echo', 'printf', 'basename', 'dirname', 'pwd', 'which', 'test', 'true',
  'false', 'date', 'sleep', 'cd', 'find', 'fd', 'sed', 'tar', 'unzip', 'zip', 'gzip', 'gunzip',
]);
/** Programs whose arguments are places they change, not places they read. */
const WRITE_PROGRAMS = new Set(['rm', 'rmdir', 'truncate', 'mkdir', 'shred', 'srm', 'tee', 'chmod', 'touch']);
const COPY_PROGRAMS = new Set(['cp', 'mv', 'ln', 'install']);

function kindOf(part: Part): Kind {
  if (part.name === 'nyc') return 'executing';
  if (READERS.has(part.name) || WRAPPERS.has(part.name)) return 'reader';
  if (WRITE_PROGRAMS.has(part.name) || COPY_PROGRAMS.has(part.name)) return 'writer';
  if (DEV_TOOLS.has(part.name) || EXECUTORS.has(part.name) || SPECS.has(part.name) || part.via !== 'word') {
    return 'executing';
  }
  return 'unknown';
}

/** How a program reads its words, where it differs from the plain reading. */
interface Spec {
  /** Options that take a value, in the next word or after "=", and what the value is. */
  flags?: Record<string, Position>;
  /** What a word that is not an option is; 'read' when left out. */
  positionals?: Position;
  /** The first word that is not an option is a script the program loads and runs. */
  script?: boolean;
  /** The program's options mean their own things: the options every executing program is read with do not apply. */
  own?: boolean;
}

/**
 * The options of executing programs that mostly mean one thing: where the program works (which has to be the
 * clone, as the working directory has to be), what it loads and runs, and where it puts what it makes.
 */
const EXECUTING_FLAGS: Record<string, Position> = {
  '-C': 'dir', '--cwd': 'dir', '--chdir': 'dir', '--directory': 'dir', '--prefix': 'dir', '--git-dir': 'dir',
  '--work-tree': 'dir', '--root': 'dir', '--rootdir': 'dir', '--rootDir': 'dir',
  '-r': 'load', '--requirement': 'load', '--editable': 'load', '--constraint': 'load', '-f': 'load',
  '--file': 'load', '--require': 'load', '--import': 'load', '--loader': 'load', '--experimental-loader': 'load',
  '--config': 'load', '--config-file': 'load', '--rcfile': 'load', '-jar': 'load', '--preload': 'load',
  '--init-script': 'load', '--env-file': 'load', '--plugin': 'load', '--setupFiles': 'load',
  '-o': 'write', '--output': 'write', '--out-dir': 'write', '--outdir': 'write', '--outDir': 'write',
  '--outfile': 'write', '--outFile': 'write', '--out-file': 'write', '--output-file': 'write',
  '--target-dir': 'write', '--target-directory': 'write',
};
/** The options of a program the rules do not know that are its output, whatever else it does. */
const OUTPUT_FLAGS: Record<string, Position> = {
  '-o': 'write', '--output': 'write', '--out-dir': 'write', '--outdir': 'write', '--outfile': 'write',
  '--output-file': 'write', '--target-directory': 'write',
};
/** Options whose value is the path of a URL, not of a file: vite build --base=/app/. */
const URL_PATH_FLAGS = new Set([
  '--base', '--public-path', '--public-url', '--base-href', '--deploy-url', '--base-url',
]);

const NODE_FLAGS: Record<string, Position> = {
  '-r': 'load', '--require': 'load', '--import': 'load', '--loader': 'load', '--experimental-loader': 'load',
  '-e': 'text', '--eval': 'text', '-p': 'text', '--print': 'text', '--input-type': 'text', '-C': 'text',
  '--conditions': 'text', '--env-file': 'load', '--env-file-if-exists': 'load', '--watch-path': 'read',
  '--test-reporter': 'load', '--test-reporter-destination': 'write', '--test-name-pattern': 'text',
  '--test-skip-pattern': 'text', '--inspect-port': 'text', '--title': 'text', '--run': 'text',
};
const BUN_FLAGS: Record<string, Position> = {
  '-r': 'load', '--preload': 'load', '-c': 'load', '--config': 'load', '--cwd': 'dir', '-e': 'text',
  '--eval': 'text', '-p': 'text', '--print': 'text', '--env-file': 'load', '--tsconfig-override': 'load',
  '-t': 'text', '--test-name-pattern': 'text', '--timeout': 'text', '--outdir': 'write', '--outfile': 'write',
  '--filter': 'text',
};
const BUN_VALUED = new Set(Object.keys(BUN_FLAGS));
/**
 * The options of the JavaScript package managers: where they work, which configuration they load, and which shell
 * runs their scripts.
 */
const PM_FLAGS: Record<string, Position> = {
  '--prefix': 'dir', '-C': 'dir', '--dir': 'dir', '--cwd': 'dir', '-w': 'text', '--workspace': 'text',
  '--filter': 'text', '-F': 'text', '--userconfig': 'load', '--globalconfig': 'load', '--cache': 'load',
  '--script-shell': 'program', '--registry': 'read', '--loglevel': 'text', '--tag': 'text', '--otp': 'text',
  '--location': 'text', '--pack-destination': 'write',
};
const PM_VALUED = new Set(Object.keys(PM_FLAGS));
const PIP_FLAGS: Record<string, Position> = {
  '-r': 'load', '--requirement': 'load', '-c': 'load', '--constraint': 'load', '-e': 'load', '--editable': 'load',
  '-f': 'load', '--find-links': 'load', '-i': 'read', '--index-url': 'read', '--extra-index-url': 'read',
  '-t': 'write', '--target': 'write', '--prefix': 'dir', '--root': 'dir', '--src': 'write', '--cache-dir': 'load',
  '--python': 'load', '--log': 'write', '--report': 'write', '-d': 'write', '--dest': 'write',
  '--platform': 'text', '--python-version': 'text', '--implementation': 'text', '--abi': 'text',
};
const SH_FLAGS: Record<string, Position> = { '-c': 'text', '-o': 'text', '+o': 'text' };
/** cp, mv, ln and install: -t names the directory they write into. */
const COPY_FLAGS: Record<string, Position> = {
  '-t': 'write', '--target-directory': 'write', '-S': 'text', '--suffix': 'text',
};

const SPECS = new Map<string, Spec>([
  ['node', { flags: NODE_FLAGS, script: true, own: true }],
  ['tsx', { flags: NODE_FLAGS, script: true, own: true }],
  ['bun', { flags: BUN_FLAGS, own: true }],
  [
    'deno',
    {
      flags: {
        '-c': 'load', '--config': 'load', '--import-map': 'load', '--env-file': 'load', '--lock': 'read',
        '-e': 'text', '--eval': 'text', '-o': 'write', '--output': 'write',
      },
      own: true,
    },
  ],
  ['npm', { flags: PM_FLAGS, own: true }],
  ['pnpm', { flags: PM_FLAGS, own: true }],
  ['yarn', { flags: PM_FLAGS, own: true }],
  ['pip', { flags: PIP_FLAGS, own: true }],
  ['pip3', { flags: PIP_FLAGS, own: true }],
  [
    'uv',
    {
      flags: {
        '--directory': 'dir', '--project': 'dir', '--config-file': 'load', '--cache-dir': 'load', '-p': 'load',
        '--python': 'load', '--with-requirements': 'load', '--with-editable': 'load', '-r': 'load',
        '--requirements': 'load', '-c': 'load', '--constraints': 'load', '--overrides': 'load', '-f': 'load',
        '--find-links': 'load', '--env-file': 'load', '-o': 'write', '--output-file': 'write', '--with': 'text',
        '--extra': 'text', '--group': 'text', '--package': 'text', '--index': 'read', '--index-url': 'read',
        '--extra-index-url': 'read', '--default-index': 'read',
      },
      own: true,
    },
  ],
  [
    'pytest',
    {
      flags: {
        '-c': 'load', '--config-file': 'load', '--rootdir': 'dir', '-p': 'text', '-o': 'read',
        '--override-ini': 'read', '--basetemp': 'write', '--junitxml': 'write', '--junit-xml': 'write',
        '--confcutdir': 'read', '-k': 'text', '-m': 'text', '--deselect': 'text', '--cov-config': 'load',
        '--log-file': 'write',
      },
    },
  ],
  ['tox', { flags: { '-c': 'load', '--installpkg': 'load', '--workdir': 'dir', '-e': 'text' } }],
  ['nox', { flags: { '-f': 'load', '--noxfile': 'load', '-s': 'text', '--session': 'text', '-t': 'text' } }],
  [
    'coverage',
    { flags: { '--rcfile': 'load', '--data-file': 'write', '-o': 'write', '-d': 'write', '--directory': 'write' } },
  ],
  [
    'cargo',
    { flags: { '--manifest-path': 'load', '--target-dir': 'write', '-Z': 'text', '-p': 'text', '-F': 'text' } },
  ],
  [
    'go',
    {
      flags: {
        '-C': 'dir', '-modfile': 'load', '-overlay': 'load', '-pgo': 'load', '-o': 'write', '-coverprofile': 'write',
        '-cpuprofile': 'write', '-memprofile': 'write', '-blockprofile': 'write', '-mutexprofile': 'write',
        '-trace': 'write', '-outputdir': 'write', '-run': 'text', '-bench': 'text', '-count': 'text',
        '-timeout': 'text', '-tags': 'text', '-ldflags': 'read', '-gcflags': 'read', '-toolexec': 'text',
        '-exec': 'text', '-vettool': 'text',
      },
      own: true,
    },
  ],
  [
    'java',
    {
      flags: {
        '-jar': 'load', '-cp': 'load', '-classpath': 'load', '--class-path': 'load', '-p': 'load',
        '--module-path': 'load',
      },
      script: true,
      own: true,
    },
  ],
  [
    'mvn',
    {
      flags: {
        '-f': 'load', '--file': 'load', '-s': 'load', '--settings': 'load', '-gs': 'load',
        '--global-settings': 'load', '-t': 'load', '--toolchains': 'load', '-pl': 'text', '-P': 'text',
        '-l': 'write', '--log-file': 'write',
      },
    },
  ],
  [
    'gradle',
    {
      flags: {
        '-b': 'load', '--build-file': 'load', '-c': 'load', '--settings-file': 'load', '-I': 'load',
        '--init-script': 'load', '-p': 'dir', '--project-dir': 'dir', '-g': 'dir', '--gradle-user-home': 'dir',
        '--project-cache-dir': 'dir', '-x': 'text',
      },
    },
  ],
  [
    'make',
    {
      flags: {
        '-f': 'load', '--file': 'load', '--makefile': 'load', '-C': 'dir', '--directory': 'dir', '-I': 'load',
        '--include-dir': 'load', '-o': 'text', '--old-file': 'text', '--assume-old': 'text', '-W': 'text',
        '--what-if': 'text', '--new-file': 'text', '--assume-new': 'text', '-j': 'text', '--jobs': 'text',
        '-l': 'text', '--load-average': 'text', '-E': 'text', '--eval': 'text',
      },
      positionals: 'text',
      own: true,
    },
  ],
  [
    'cmake',
    {
      flags: {
        '-P': 'load', '-C': 'load', '-S': 'read', '-B': 'write', '--toolchain': 'load', '--install-prefix': 'dir',
        '--prefix': 'dir', '-G': 'text', '-E': 'text', '--build': 'read', '--install': 'read',
      },
      own: true,
    },
  ],
  ['ninja', { flags: { '-f': 'load', '-C': 'dir', '-t': 'text', '-j': 'text' }, own: true }],
  [
    'rustc',
    { flags: { '-o': 'write', '--out-dir': 'write', '-L': 'read', '--extern': 'read', '-C': 'read' }, own: true },
  ],
  [
    'tsc',
    {
      flags: {
        '-p': 'load', '--project': 'load', '--outDir': 'write', '--outFile': 'write', '--declarationDir': 'write',
        '--tsBuildInfoFile': 'write', '--rootDir': 'read', '--baseUrl': 'read', '-t': 'text', '--target': 'text',
        '-m': 'text', '--module': 'text', '--lib': 'text', '-b': 'read', '--build': 'read',
      },
    },
  ],
  [
    'eslint',
    {
      flags: {
        '-c': 'load', '--resolve-plugins-relative-to': 'load', '--rulesdir': 'load', '-o': 'write',
        '--output-file': 'write', '--cache-location': 'write', '--ignore-path': 'read', '-f': 'load',
      },
    },
  ],
  ['prettier', { flags: { '--ignore-path': 'read', '--cache-location': 'write' } }],
  ['vitest', { flags: { '-c': 'load', '--dir': 'dir', '--root': 'dir' } }],
  ['jest', { flags: { '-c': 'load' } }],
  ['playwright', { flags: { '-c': 'load' } }],
  ['vite', { flags: { '-c': 'load', '--root': 'dir' } }],
  ['mocha', { flags: { '-r': 'load', '--reporter': 'load' } }],
  [
    'patch',
    {
      flags: {
        '-i': 'read', '--input': 'read', '-o': 'write', '--output': 'write', '-d': 'dir', '--directory': 'dir',
        '-r': 'write', '--reject-file': 'write', '-B': 'write', '--prefix': 'write', '-p': 'text', '-F': 'text',
        '--fuzz': 'text', '-D': 'text', '-z': 'text', '--suffix': 'text', '-V': 'text',
      },
      own: true,
    },
  ],
  ['virtualenv', { flags: { '-p': 'load', '--python': 'load', '--prompt': 'text' }, positionals: 'write' }],
  ['venv', { flags: { '--prompt': 'text' }, positionals: 'write' }],
  ['alembic', { flags: { '-c': 'load', '--config': 'load', '-x': 'text', '-n': 'text', '--name': 'text' } }],
  ['django-admin', { flags: { '--settings': 'text', '--pythonpath': 'read', '-c': 'text', '--command': 'text' } }],
  ['pre-commit', { flags: { '-c': 'load', '--config': 'load', '--hook-stage': 'text' } }],
  ['sh', { flags: SH_FLAGS, script: true, own: true }],
  ['bash', { flags: SH_FLAGS, script: true, own: true }],
  ['zsh', { flags: SH_FLAGS, script: true, own: true }],
  ['dash', { flags: SH_FLAGS, script: true, own: true }],
  ['ksh', { flags: SH_FLAGS, script: true, own: true }],
  ['source', { script: true, own: true }],
  ['.', { script: true, own: true }],
  ['ruby', { flags: { '-e': 'text', '-r': 'load', '-I': 'load', '-C': 'dir' }, script: true, own: true }],
  [
    'perl',
    { flags: { '-e': 'text', '-E': 'text', '-I': 'load', '-M': 'text', '-m': 'text' }, script: true, own: true },
  ],
  ['osascript', { flags: { '-e': 'text', '-l': 'text', '-s': 'text' }, script: true, own: true }],
  ['php', { flags: { '-r': 'text', '-f': 'load', '-c': 'load', '-d': 'text' }, script: true, own: true }],
  [
    'env',
    {
      flags: {
        '-C': 'dir', '--chdir': 'dir', '-P': 'program', '-u': 'text', '--unset': 'text', '-S': 'text',
        '--split-string': 'text',
      },
      own: true,
    },
  ],
  [
    'nyc',
    {
      flags: {
        '-i': 'load', '--require': 'load', '--nycrc-path': 'load', '--cwd': 'dir', '--report-dir': 'write',
        '-t': 'write', '--temp-dir': 'write', '-r': 'text', '--reporter': 'text', '-n': 'text', '--include': 'text',
        '-x': 'text', '--exclude': 'text', '-e': 'text', '--extension': 'text',
      },
      own: true,
    },
  ],
  [
    'sort',
    {
      flags: {
        '-o': 'write', '--output': 'write', '-T': 'write', '--temporary-directory': 'write', '-k': 'text',
        '--key': 'text', '-t': 'text', '--field-separator': 'text', '-S': 'text', '--buffer-size': 'text',
      },
    },
  ],
  ['unzip', { flags: { '-d': 'write', '-x': 'text', '-P': 'text' } }],
  [
    'zip',
    {
      flags: {
        '-b': 'write', '-O': 'write', '--output-file': 'write', '-x': 'text', '-i': 'text', '-n': 'text',
        '-t': 'text', '-tt': 'text', '-P': 'text', '-Z': 'text',
      },
    },
  ],
  ['cp', { flags: COPY_FLAGS }],
  ['mv', { flags: COPY_FLAGS }],
  ['ln', { flags: COPY_FLAGS }],
  [
    'install',
    {
      flags: {
        ...COPY_FLAGS, '-m': 'text', '--mode': 'text', '-o': 'text', '--owner': 'text', '-g': 'text',
        '--group': 'text',
      },
    },
  ],
]);

/** One word, or a part of one, that a program would read, write, load, run or work in. */
interface Spot {
  /** The word as the command spells it, for the reasons. */
  word: Word;
  /** What is resolved as a path: the word itself, the value after its "=", or one of its ":"-separated parts. */
  path: Word;
  position: Position;
  part: Part;
  kind: Kind;
}

/**
 * A "~" the shell expands to some account's home or to a directory of its own, after an "=" or a ":" as well:
 * ~other/x.
 */
const tildeUser = (text: string): boolean => /^~[^/]/.test(text);

const pathShaped = (word: Word): boolean =>
  !isUrl(word.text) &&
  (word.home ||
    word.user !== undefined ||
    word.text.includes('/') ||
    word.text === '.' ||
    word.text === '..' ||
    word.text === '~' ||
    word.text.startsWith('~/'));

/**
 * The candidates for a path in a value: the value whole, and each of its parts split at "=", ":" and ",", so that
 * PYTHONPATH=src:tests is two paths and --require=/tmp/x.js names /tmp/x.js. A place a program works in, loads,
 * writes or runs is taken whatever its shape; elsewhere a bare name cannot leave the directory it is read from.
 */
function pathParts(word: Word, text: string, position: Position): Word[] {
  const same = text === word.text;
  const home = same && word.home;
  const user = same ? word.user : undefined;
  // "~" alone lexes to an empty word rooted at the home: it is the home itself, not nothing. So is "~name".
  const rooted = home || user !== undefined;
  if (position === 'text' || (text === '' && !rooted) || text === '-' || isUrl(text)) return [];
  const whole: Word = {
    ...word,
    text,
    home,
    user,
    unresolved: user !== undefined || (word.unresolved && text.includes('$')),
  };
  const pieces = text.split(/[=:,]/);
  const strict = position === 'write' || position === 'load' || position === 'dir' || position === 'program';
  const found = strict || pathShaped(whole) ? [whole] : [];
  if (pieces.length > 1) {
    pieces.forEach((piece, at) => {
      const first = at === 0 && same;
      const candidate: Word = {
        ...word,
        text: piece,
        home: first && word.home,
        user: first ? word.user : undefined,
        unresolved:
          (first && word.user !== undefined) || (word.unresolved && piece.includes('$')) || tildeUser(piece),
      };
      if (piece !== '' && pathShaped(candidate)) found.push(candidate);
    });
  }
  return found;
}

/** Every word of a part that names a place, with what the part would do with it. */
function spotsOf(part: Part): Spot[] {
  const kind = kindOf(part);
  const spots: Spot[] = [];
  const add = (word: Word, text: string, position: Position): void => {
    for (const path of pathParts(word, text, position)) spots.push({ word, path, position, part, kind });
  };
  // The program itself, when the command names it by a path.
  if (part.via === 'word') {
    const text = part.word.text.replace(/^=/, '');
    if (part.word.home || part.word.user !== undefined || text.includes('/')) {
      spots.push({ word: part.word, path: { ...part.word, text }, position: 'program', part, kind });
    }
  }
  switch (part.name) {
    case 'tar':
      tarSpots(part, add);
      return spots;
    case 'sed':
      sedSpots(part, add);
      return spots;
    case 'git':
      gitSpots(part, add);
      return spots;
    case 'find':
      findSpots(part, add);
      return spots;
    case 'python':
    case 'python3':
      pythonSpots(part, add);
      return spots;
    default:
      break;
  }
  const spec = SPECS.get(part.name);
  const flags: Record<string, Position> = {
    ...(kind === 'executing' && spec?.own !== true ? EXECUTING_FLAGS : kind === 'unknown' ? OUTPUT_FLAGS : {}),
    ...(spec?.flags ?? {}),
  };
  const values: { word: Word; position: Position }[] = [];
  let ended = false;
  for (let at = 0; at < part.args.length; at += 1) {
    const word = part.args[at];
    const text = word.text;
    if (!ended && text === '--') {
      ended = true;
      continue;
    }
    // An option: "-x", "--name", and the "+o" of a shell.
    const option = text.length > 1 && (text.startsWith('-') || (text.startsWith('+') && flags[text] !== undefined));
    if (!ended && option) {
      const split = text.indexOf('=');
      if (split > 0) {
        const flag = text.slice(0, split);
        if (!URL_PATH_FLAGS.has(flag)) add(word, text.slice(split + 1), flags[flag] ?? 'read');
        continue;
      }
      const position = flags[text];
      if (position !== undefined) {
        const next = part.args[at + 1];
        if (next !== undefined) {
          add(next, next.text, position);
          at += 1;
        }
        continue;
      }
      // An option with its value attached, as getopt allows: -f/tmp/Makefile, -I/usr/include.
      if (kind === 'executing' && /^-[A-Za-z]./.test(text) && !text.startsWith('--')) {
        add(word, text.slice(2), flags[text.slice(0, 2)] ?? 'read');
      }
      continue;
    }
    values.push({ word, position: spec?.positionals ?? (kind === 'writer' ? 'write' : 'read') });
  }
  positionalSpots(part, spec, values, add);
  return spots;
}

/** The words that are no options, by what the program makes of each. */
function positionalSpots(
  part: Part,
  spec: Spec | undefined,
  values: { word: Word; position: Position }[],
  add: (word: Word, text: string, position: Position) => void,
): void {
  const flagged = (...names: string[]): boolean =>
    part.args.some((word) => names.includes(word.text.split('=')[0]));
  const last = values.length - 1;
  values.forEach(({ word, position }, at) => {
    // After "--" an option is passed on to a script as it stands: npm run build -- --base=/app/.
    if (word.text.startsWith('-') && URL_PATH_FLAGS.has(word.text.split('=')[0])) return;
    let as = position;
    if (spec?.script === true && at === 0) as = 'load';
    if (COPY_PROGRAMS.has(part.name)) {
      // cp, mv, ln and install write their last argument and read the rest, unless -t names where they write.
      as = !flagged('-t', '--target-directory') && last >= 1 && at === last ? 'write' : 'read';
    }
    if (part.name === 'uniq' && at === 1) as = 'write';
    if (part.name === 'zip' && at === 0) as = 'write';
    if (part.name === 'patch') as = at === 0 ? 'write' : 'read';
    // gzip compresses a file where it lies, unless it writes to its output or only looks.
    const looks = flagged('-c', '--stdout', '-l', '--list', '-t', '--test');
    if ((part.name === 'gzip' || part.name === 'gunzip') && !looks) as = 'write';
    if (part.name === 'yq' && flagged('-i', '--inplace')) as = 'write';
    // make NAME=value sets a variable of the makefile, which steers it as an environment variable would.
    if ((part.name === 'make' || part.name === 'gmake') && ASSIGNMENT.test(word.text)) {
      for (const path of valuePaths(word, assignmentOf(word).value)) add(word, path.text, 'env');
      return;
    }
    if (part.name === 'dd' && word.text.startsWith('of=')) {
      add(word, word.text.slice(3), 'write');
      return;
    }
    add(word, word.text, as);
  });
}

/** python's own options: -W and -X take a value, -c and -m end them; the script is loaded and the rest is read. */
function pythonSpots(part: Part, add: (word: Word, text: string, position: Position) => void): void {
  const args = part.args;
  let at = 0;
  for (; at < args.length; at += 1) {
    const text = args[at].text;
    if (text === '--') {
      at += 1;
      break;
    }
    if (!text.startsWith('-') || text === '-') break;
    if (text.startsWith('--')) {
      if (text === '--check-hash-based-pycs') at += 1;
      continue;
    }
    let ends = false;
    for (let letter = 1; letter < text.length; letter += 1) {
      const flag = text[letter];
      if (flag === 'c' || flag === 'm') {
        ends = true;
        break;
      }
      if (flag === 'W' || flag === 'X') {
        if (letter === text.length - 1) at += 1;
        break;
      }
    }
    // After -c or -m the words are the argv of the script or the module.
    if (ends) {
      for (const word of args.slice(at + 2)) add(word, word.text, 'read');
      return;
    }
  }
  const script = args[at];
  if (script === undefined) return;
  add(script, script.text, 'load');
  for (const word of args.slice(at + 1)) add(word, word.text, 'read');
}

/** git's own options name where it works; commit messages and patches are data; the rest is read. */
function gitSpots(part: Part, add: (word: Word, text: string, position: Position) => void): void {
  const args = part.args;
  let at = 0;
  while (at < args.length && args[at].text.startsWith('-')) {
    const text = args[at].text;
    const split = text.indexOf('=');
    const flag = split < 0 ? text : text.slice(0, split);
    const position: Position | undefined = ['-C', '--git-dir', '--work-tree'].includes(flag)
      ? 'dir'
      : flag === '--exec-path'
        ? 'load'
        : undefined;
    if (split > 0) {
      if (position !== undefined) add(args[at], text.slice(split + 1), position);
      at += 1;
      continue;
    }
    if (GIT_VALUED.has(text)) {
      const next = args[at + 1];
      if (next !== undefined && position !== undefined) add(next, next.text, position);
      at += 2;
      continue;
    }
    at += 1;
  }
  const subcommand = args[at]?.text ?? '';
  const data = subcommand === 'apply' || subcommand === 'am';
  for (let next = at + 1; next < args.length; next += 1) {
    const word = args[next];
    const text = word.text;
    const split = text.indexOf('=');
    const flag = split < 0 ? text : text.slice(0, split);
    const position: Position | undefined =
      flag === '-F' || flag === '--file'
        ? 'data'
        : flag === '-o' || flag === '--output' || flag === '--output-directory'
          ? 'write'
          : undefined;
    if (text.startsWith('-')) {
      if (split > 0) add(word, text.slice(split + 1), position ?? 'read');
      else if (position !== undefined && args[next + 1] !== undefined) {
        add(args[next + 1], args[next + 1].text, position);
        next += 1;
      }
      continue;
    }
    add(word, text, data ? 'data' : 'read');
  }
}

/** find reads its starting points, and writes them with -delete; -fprint and its kind write the file they name. */
function findSpots(part: Part, add: (word: Word, text: string, position: Position) => void): void {
  const args = part.args;
  const deletes = args.some((word) => word.text === '-delete');
  let expression = false;
  for (let at = 0; at < args.length; at += 1) {
    const word = args[at];
    const text = word.text;
    if (!expression && (text.startsWith('-') || text === '(' || text === '!')) expression = true;
    if (!expression) {
      add(word, text, deletes ? 'write' : 'read');
      continue;
    }
    const next = args[at + 1];
    if (next === undefined) continue;
    if (['-fprint', '-fprint0', '-fprintf', '-fls'].includes(text)) {
      add(next, next.text, 'write');
      at += 1;
    } else if (['-newer', '-anewer', '-cnewer', '-samefile'].includes(text)) {
      add(next, next.text, 'read');
      at += 1;
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// tar and sed, which write as well as read, and can be told to run something

interface TarReading {
  /** The archive is made, appended to or updated, not read. */
  creates: boolean;
  archive: Word | null;
  /** The values of -C and --directory: where tar reads and extracts. */
  dirs: Word[];
  /** Other words: the files to archive, or the members to extract. */
  rest: Word[];
  /** -P or --absolute-names: member names may leave the directory. */
  absolute: boolean;
  /** An option that makes tar run a program, or read the list of its files from elsewhere. */
  runs: string | null;
  forceLocal: boolean;
}

/** The short options of tar that take a value: from the rest of their bundle, or from the next word. */
const TAR_VALUED = new Set(['f', 'C', 'T', 'X', 'I', 'F', 'b', 'L', 'g', 'K', 'N', 'V', 'H']);
/** The long options of tar these rules read, by what each does; any other is passed over. */
const TAR_LONG = new Map<string, 'runs' | 'lists' | 'absolute' | 'local' | 'creates' | 'archive' | 'dir' | 'none'>([
  ['use-compress-program', 'runs'], ['to-command', 'runs'], ['checkpoint-action', 'runs'], ['info-script', 'runs'],
  ['new-volume-script', 'runs'], ['rsh-command', 'runs'], ['rmt-command', 'runs'], ['files-from', 'lists'],
  ['absolute-names', 'absolute'], ['force-local', 'local'], ['create', 'creates'], ['append', 'creates'],
  ['update', 'creates'], ['catenate', 'creates'], ['concatenate', 'creates'], ['file', 'archive'],
  ['directory', 'dir'], ['one-top-level', 'dir'],
  // Options that begin like one of the above and do nothing of the kind.
  ['checkpoint', 'none'], ['to-stdout', 'none'], ['files', 'none'],
]);

/**
 * What a long option of tar does. getopt takes an exact name first, then a prefix of a name; a prefix of more than
 * one is read as the most dangerous of them, though tar itself would refuse it.
 */
function tarLong(name: string): 'runs' | 'lists' | 'absolute' | 'local' | 'creates' | 'archive' | 'dir' | 'none' {
  const exact = TAR_LONG.get(name);
  if (exact !== undefined) return exact;
  if (name.length < 2) return 'none';
  const found = [...TAR_LONG].filter(([full]) => full.startsWith(name)).map(([, what]) => what);
  const order = ['runs', 'lists', 'absolute', 'dir', 'archive', 'creates', 'local'] as const;
  return order.find((what) => found.includes(what)) ?? 'none';
}

function readTar(args: readonly Word[]): TarReading {
  const reading: TarReading = {
    creates: false,
    archive: null,
    dirs: [],
    rest: [],
    absolute: false,
    runs: null,
    forceLocal: false,
  };
  const take = (letter: string, value: Word | undefined): void => {
    if (value === undefined) return;
    if (letter === 'f') reading.archive = value;
    else if (letter === 'C') reading.dirs.push(value);
    else if (letter === 'I' || letter === 'F') reading.runs = `tar -${letter}`;
    else if (letter === 'T') reading.runs = 'tar -T';
  };
  const bundle = (word: Word, letters: string, at: number): number => {
    let next = at;
    for (let i = 0; i < letters.length; i += 1) {
      const letter = letters[i];
      if ('cruA'.includes(letter)) reading.creates = true;
      if (letter === 'P') reading.absolute = true;
      if (TAR_VALUED.has(letter)) {
        const attached = letters.slice(i + 1);
        if (attached !== '') take(letter, { ...word, text: attached });
        else {
          next += 1;
          take(letter, args[next]);
        }
        break;
      }
    }
    return next;
  };
  for (let at = 0; at < args.length; at += 1) {
    const word = args[at];
    const text = word.text;
    if (at === 0 && /^[A-Za-z]+$/.test(text)) {
      // The old style: a first word of letters without a dash, whose values follow it in order.
      let next = at;
      for (const letter of text) {
        if ('cruA'.includes(letter)) reading.creates = true;
        if (letter === 'P') reading.absolute = true;
        if (TAR_VALUED.has(letter)) {
          next += 1;
          take(letter, args[next]);
        }
      }
      at = next;
      continue;
    }
    if (text.startsWith('--')) {
      const split = text.indexOf('=');
      const name = text.slice(2, split < 0 ? undefined : split);
      const value = split < 0 ? undefined : { ...word, text: text.slice(split + 1) };
      const what = tarLong(name);
      if (what === 'runs') reading.runs = `tar --${name}`;
      else if (what === 'lists') reading.runs = 'tar --files-from';
      else if (what === 'absolute') reading.absolute = true;
      else if (what === 'local') reading.forceLocal = true;
      else if (what === 'creates') reading.creates = true;
      else if (what === 'archive' || what === 'dir') {
        // --one-top-level takes its directory only after an "=", --file and --directory in the next word as well.
        const optional = name.startsWith('o');
        const given = value ?? (optional ? undefined : args[at + 1]);
        if (value === undefined && !optional) at += 1;
        if (given !== undefined) {
          if (what === 'archive') reading.archive = given;
          else reading.dirs.push(given);
        }
      }
      continue;
    }
    if (text.startsWith('-') && text.length > 1) {
      at = bundle(word, text.slice(1), at);
      continue;
    }
    reading.rest.push(word);
  }
  return reading;
}

function tarSpots(part: Part, add: (word: Word, text: string, position: Position) => void): void {
  const tar = readTar(part.args);
  if (tar.archive !== null) add(tar.archive, tar.archive.text, tar.creates ? 'write' : 'read');
  for (const dir of tar.dirs) {
    add(dir, dir.text, 'dir');
    add(dir, dir.text, 'write');
  }
  for (const word of tar.rest) add(word, word.text, 'read');
}

interface SedReading {
  scripts: string[];
  scriptFiles: Word[];
  files: Word[];
  inPlace: boolean;
  /** A backup suffix that names a directory (GNU sed -i'bak/*'): a place the command writes. */
  suffix: Word | null;
  /** An option the rules cannot read. */
  unknown: boolean;
}

const SED_FLAGS = new Set([
  '-n', '-E', '-r', '-s', '-u', '-z', '-b', '--posix', '--debug', '--sandbox', '--quiet', '--silent',
  '--regexp-extended', '--separate', '--unbuffered', '--null-data', '--zero-terminated', '--follow-symlinks',
  '--binary', '--version', '--help',
]);

function readSed(args: readonly Word[]): SedReading {
  const sed: SedReading = { scripts: [], scriptFiles: [], files: [], inPlace: false, suffix: null, unknown: false };
  const given: Word[] = [];
  let ended = false;
  for (let at = 0; at < args.length; at += 1) {
    const word = args[at];
    const text = word.text;
    if (ended || !text.startsWith('-') || text === '-') {
      given.push(word);
      continue;
    }
    if (text === '--') ended = true;
    else if (SED_FLAGS.has(text) || /^-[nErsuzb]+$/.test(text)) continue;
    else if (text === '-e' || text === '--expression' || /^-[nErsuzb]+e$/.test(text)) {
      sed.scripts.push(args[at + 1]?.text ?? '');
      at += 1;
    } else if (text.startsWith('--expression=')) sed.scripts.push(text.slice('--expression='.length));
    else if (/^-e./.test(text)) sed.scripts.push(text.slice(2));
    else if (text === '-f' || text === '--file' || /^-[nErsuzb]+f$/.test(text)) {
      const file = args[at + 1];
      if (file !== undefined) sed.scriptFiles.push(file);
      at += 1;
    } else if (text.startsWith('--file=')) sed.scriptFiles.push({ ...word, text: text.slice('--file='.length) });
    else if (text === '-l' || text === '--line-length') at += 1;
    else if (text.startsWith('--line-length=')) continue;
    else if (text === '-i' || text === '--in-place') {
      sed.inPlace = true;
      // BSD sed takes the backup extension in the next word: '' or '.bak'.
      const next = args[at + 1];
      if (text === '-i' && next !== undefined && (next.text === '' || /^\.[^/]*$/.test(next.text))) at += 1;
    } else if (text.startsWith('--in-place=')) {
      sed.inPlace = true;
      const suffix = text.slice('--in-place='.length);
      if (suffix.includes('/')) sed.suffix = { ...word, text: suffix };
    } else {
      const inPlace = text.match(/^-[nErsuzb]*i(.*)$/);
      if (inPlace === null) sed.unknown = true;
      else {
        sed.inPlace = true;
        if (inPlace[1].includes('/')) sed.suffix = { ...word, text: inPlace[1] };
      }
    }
  }
  if (sed.scripts.length === 0 && sed.scriptFiles.length === 0) {
    const script = given.shift();
    if (script !== undefined) sed.scripts.push(script.text);
  }
  sed.files = given;
  return sed;
}

function sedSpots(part: Part, add: (word: Word, text: string, position: Position) => void): void {
  const sed = readSed(part.args);
  for (const file of sed.scriptFiles) add(file, file.text, 'load');
  for (const file of sed.files) add(file, file.text, sed.inPlace ? 'write' : 'read');
  if (sed.suffix !== null) add(sed.suffix, sed.suffix.text, 'write');
}

/**
 * Whether a sed script only prints, deletes, substitutes and moves between lines. The e command and the e flag run
 * the shell, and r, R, w and W read and write files the script names, so a script with any of them, or with
 * anything these rules cannot read, is not one they approve.
 */
function sedScriptSafe(script: string): boolean {
  let at = 0;
  const n = script.length;
  const spaces = (): void => {
    while (at < n && (script[at] === ' ' || script[at] === '\t')) at += 1;
  };
  /** Reads up to and past an unescaped `close`; false when the text ends first. */
  const through = (close: string): boolean => {
    while (at < n) {
      const c = script[at];
      if (c === '\\') {
        at += 2;
        continue;
      }
      if (c === '\n') return false;
      at += 1;
      if (c === close) return true;
    }
    return false;
  };
  const address = (): boolean => {
    const c = script[at];
    if (c === undefined) return true;
    if (/\d/.test(c)) {
      while (at < n && /[\d~]/.test(script[at])) at += 1;
      return true;
    }
    if (c === '$') {
      at += 1;
      return true;
    }
    if (c === '/' || c === '\\') {
      const close = c === '/' ? '/' : script[at + 1];
      if (close === undefined || close === '\n' || close === '\\') return false;
      at += c === '/' ? 1 : 2;
      if (!through(close)) return false;
      while (at < n && (script[at] === 'I' || script[at] === 'M')) at += 1;
    }
    return true;
  };
  while (at < n) {
    spaces();
    const c = script[at];
    if (c === undefined) break;
    if (c === ';' || c === '\n' || c === '}') {
      at += 1;
      continue;
    }
    if (c === '#') {
      while (at < n && script[at] !== '\n') at += 1;
      continue;
    }
    const before = at;
    if (!address()) return false;
    if (at > before) {
      spaces();
      if (script[at] === ',') {
        at += 1;
        spaces();
        if (script[at] === '+' || script[at] === '~') {
          at += 1;
          while (at < n && /\d/.test(script[at])) at += 1;
        } else if (!address()) return false;
      }
    }
    spaces();
    while (script[at] === '!') {
      at += 1;
      spaces();
    }
    const command = script[at];
    if (command === undefined) return false;
    at += 1;
    if (command === '{') continue;
    if ('=dDgGhHnNpPxzF'.includes(command)) {
      // no argument
    } else if ('lqQ'.includes(command)) {
      spaces();
      while (at < n && /\d/.test(script[at])) at += 1;
    } else if (':btT'.includes(command)) {
      while (at < n && script[at] !== ';' && script[at] !== '\n') at += 1;
    } else if ('aic'.includes(command)) {
      while (at < n && script[at] !== '\n') at += script[at] === '\\' ? 2 : 1;
    } else if (command === 's' || command === 'y') {
      const close = script[at];
      if (close === undefined || close === '\\' || close === '\n') return false;
      at += 1;
      if (!through(close) || !through(close)) return false;
      if (command === 's') while (at < n && /[gpiImM0-9]/.test(script[at])) at += 1;
    } else return false;
    spaces();
    if (at < n && !';\n}#'.includes(script[at])) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------------------------------------------
// What a program would run, fetch or read that its words do not show

/** The words before "--" that are no options. */
const beforeDashes = (args: readonly Word[]): string[] => {
  const end = args.findIndex((word) => word.text === '--');
  return texts(end < 0 ? args : args.slice(0, end));
};
const hasFlag = (args: readonly Word[], ...names: string[]): boolean =>
  beforeDashes(args).some((text) => names.includes(text.split('=')[0]));

/** Interpreters that read their program from their input when they are given no script. */
const STDIN_INTERPRETERS = new Set(['python', 'python3', 'node', 'tsx', 'deno']);
const VERSION_FLAGS = new Set(['--version', '-V', '-v', '--help', '-h']);

/**
 * Why a part cannot be approved even though every path it names is fine: it hands another program a command line
 * the rules cannot read, it fetches what no manifest declares, or it acts on what its words do not show.
 */
function runsUnseen(part: Part, segment: Segment, last: boolean): string | null {
  const args = part.args;
  const text = texts(args);
  switch (part.name) {
    case 'env':
      // -S in a bundle of options too: env -iS'sh -c …'.
      return text.some((arg) => /^-[^-]*S/.test(arg) || arg.startsWith('--split-string'))
        ? 'env -S splits a string into a command line these rules do not read'
        : null;
    case 'xargs':
      return 'xargs runs a program with arguments it reads from its input, which these rules cannot see';
    case 'find':
      return text.some((arg) => ['-exec', '-execdir', '-ok', '-okdir'].includes(arg))
        ? 'find -exec hands every file it finds to a command'
        : null;
    case 'fd':
      return text.some((arg) => /^-[a-zA-Z]*[xX]/.test(arg) || arg.startsWith('--exec'))
        ? 'fd -x hands every file it finds to a command'
        : null;
    case 'rg':
    case 'grep':
    case 'egrep':
    case 'fgrep':
      return text.some((arg) => /^--(pre|pre-glob|hostname-bin)(=|$)/.test(arg))
        ? `${part.name} --pre runs a program on every file it searches`
        : null;
    case 'awk':
    case 'gawk':
    case 'nawk':
    case 'mawk':
      return `${part.name} runs a program of its own, and an awk program can run commands`;
    case 'sed': {
      const sed = readSed(args);
      if (sed.unknown) return 'sed is given an option these rules cannot read';
      return sed.scripts.every(sedScriptSafe)
        ? null
        : 'the sed script runs a command, or reads or writes a file it names, or is one these rules cannot read';
    }
    case 'sort':
      return text.some((arg) => abbreviates(arg, 'compress-program') || abbreviates(arg, 'files0-from'))
        ? 'sort is told to run a program, or to read the names of its files from elsewhere'
        : null;
    case 'tar': {
      const tar = readTar(args);
      if (tar.runs !== null) return `${tar.runs} runs a program, or reads the list of its files from elsewhere`;
      return tar.archive !== null && !tar.forceLocal && /^[^/]*:/.test(tar.archive.text)
        ? 'tar would reach another host for an archive named host:path'
        : null;
    }
    case 'zip':
      return text.some((arg) => arg === '-TT' || arg.startsWith('--unzip-command') || /^-[^-]*@/.test(arg))
        ? 'zip is told to run a program, or to read the names of its files from its input'
        : null;
    case 'make':
    case 'gmake':
      if (text.some((arg) => /^-E/.test(arg) || abbreviates(arg, 'eval'))) {
        return 'make --eval runs make code written on the command line';
      }
      if (text.some((arg) => MAKE_STEERING.test(arg))) {
        return 'make is handed a shell, or more makefiles and options, on the command line';
      }
      return text.some((arg, at) => ['-f', '--file', '--makefile'].includes(arg) && text[at + 1] === '-')
        ? 'make reads its makefile from its input'
        : null;
    case 'cmake':
      return text.includes('-E') ? 'cmake -E runs a command of its own' : null;
    case 'java':
      return text.some((arg) => /^-XX:[+-]?On/i.test(arg) || arg.startsWith('@'))
        ? 'java is told to run a command on an error, or to read its options from a file'
        : null;
    case 'go': {
      if (text.some((arg) => /^--?(toolexec|exec|vettool)(=|$)/.test(arg))) {
        return 'go is told to run every tool through a program';
      }
      const given = positionals(args).map((word) => word.text);
      if (given[0] === 'env' && text.some((arg) => arg === '-w' || arg === '-u')) {
        return 'go env -w changes the settings of every project on the laptop';
      }
      return given.slice(1).some((arg) => arg.includes('@'))
        ? 'go fetches a module at a version no manifest of the clone declares'
        : null;
    }
    case 'cargo': {
      // --config takes a file or a key=value; a key can name a program (build.rustc-wrapper, target.*.runner).
      const sets = text.some(
        (arg, at) =>
          (arg === '--config' && (text[at + 1] ?? '').includes('=')) ||
          (arg.startsWith('--config=') && arg.slice('--config='.length).includes('=')),
      );
      return sets ? 'cargo --config sets a key on the command line, and a key can name a program to run' : null;
    }
    case 'deno': {
      const given = positionals(args).map((word) => word.text);
      if (['eval', 'upgrade', 'publish', 'repl', 'jupyter'].includes(given[0] ?? '')) {
        return `deno ${given[0]} runs code written on the command line, or fetches or publishes`;
      }
      return given.some((arg) => /^(npm|jsr|https?):/i.test(arg))
        ? 'deno would fetch a package or a module from a registry or a site'
        : null;
    }
    case 'pre-commit': {
      // Only `pre-commit run`, which runs the hooks the clone's own configuration declares.
      const given = positionals(args).map((word) => word.text);
      if (given[0] !== 'run') {
        return `${show(['pre-commit', ...given.slice(0, 1)].join(' '))} does more than run the hooks the clone declares`;
      }
      return text.some((arg) => arg.startsWith('--repo') || isUrl(arg))
        ? 'pre-commit is pointed at a repository outside the clone'
        : null;
    }
    case 'django-admin':
      return positionals(args)[0]?.text === 'shell' && hasFlag(args, '-c', '--command')
        ? 'django-admin shell -c runs code written on the command line'
        : null;
    case 'git':
      return gitRuns(gitCall(args));
    default:
      break;
  }
  // A data: URL is a module written on the command line: node --import 'data:text/javascript,…' runs it.
  if (['node', 'tsx', 'bun', 'deno'].includes(part.name) && text.some((arg) => /(^|=)data:/i.test(arg))) {
    return `${part.name} is handed code in a data: URL`;
  }
  if ((part.name === 'python' || part.name === 'python3') && last) {
    const given = positionals(args);
    if (given[0]?.text.endsWith('manage.py') && given[1]?.text === 'shell' && hasFlag(args, '-c', '--command')) {
      return 'manage.py shell -c runs code written on the command line';
    }
  }
  // An interpreter given no script reads its program from its input: the program is whatever comes down the pipe.
  if (last && STDIN_INTERPRETERS.has(part.name) && part.via !== 'implied') {
    const script = scriptGiven(part);
    const fed = segment.piped || segment.redirects.some((redirect) => ['read', 'text'].includes(redirect.kind));
    if (script === '-' || (script === null && fed)) {
      return `${part.name} reads its program from its input, which the command does not show`;
    }
  }
  return null;
}

/** The variables of make that hand it a shell, or more makefiles and options, from the command line. */
const MAKE_STEERING = /^(SHELL|\.SHELLFLAGS|MAKESHELL|MAKEFLAGS|MFLAGS|GNUMAKEFLAGS|MAKEFILES)\+?=/;

/** The script an interpreter is given: its word, "-" for its input, null for none, '' when it runs code otherwise. */
function scriptGiven(part: Part): string | null {
  const args = part.args;
  if (args.some((word) => VERSION_FLAGS.has(word.text))) return '';
  const flags = part.name === 'node' || part.name === 'tsx' ? NODE_FLAGS : {};
  for (let at = 0; at < args.length; at += 1) {
    const text = args[at].text;
    if (text === '-') return '-';
    if (!text.startsWith('-')) return text;
    if (part.name.startsWith('python') && /^-[A-Za-z]*[cm]/.test(text)) return '';
    if (['-e', '--eval', '-p', '--print', '--test', '--run'].includes(text.split('=')[0])) return '';
    if (flags[text] !== undefined) at += 1;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Rules 10 and 11: the work a sandbox would have done had the network not been in the way

/** The subcommands of the JavaScript package managers, by what they would do. */
const PM_SAFE = new Set([
  'run', 'run-script', 'rum', 'urn', 'test', 't', 'tst', 'start', 'stop', 'restart', 'ci', 'clean-install',
  'install-test', 'it', 'install-ci-test', 'cit', 'ls', 'list', 'll', 'la', 'why', 'explain', 'outdated', 'view',
  'info', 'show', 'pack', 'version', 'pkg', 'root', 'prefix', 'bin', 'help', 'doctor', 'prune', 'dedupe', 'ddp',
  'rebuild', 'rb', 'query', 'fund', 'sbom', 'build', 'remove', 'rm', 'uninstall', 'un', 'unlink', 'whoami',
  'licenses', 'workspaces', 'get', 'pm',
]);
/** Those that fetch what no manifest declares, or install for the whole laptop. */
const PM_FETCH = new Set([
  'install', 'i', 'in', 'ins', 'inst', 'insta', 'instal', 'isnt', 'isnta', 'isntal', 'isntall', 'add', 'update',
  'up', 'upgrade', 'udpate', 'exec', 'x', 'dlx', 'create', 'init', 'innit', 'link', 'ln', 'global', 'plugin',
  'set', 'upgrade-interactive', 'self-update', 'setup', 'env', 'policies', 'import',
]);
/** Those that act on the registry with the credentials of the owner. */
const PM_CREDENTIALS = new Set([
  'publish', 'unpublish', 'deprecate', 'undeprecate', 'dist-tag', 'dist-tags', 'owner', 'author', 'access',
  'team', 'org', 'token', 'adduser', 'add-user', 'login', 'logout', 'star', 'unstar', 'hook', 'profile', 'trust',
  'npm',
]);
/** Those that open a shell or an editor in a package. */
const PM_SHELLS = new Set(['explore', 'edit']);
/** Those whose verdict hangs on the word after them: config set, audit fix, cache add. */
const PM_DEPENDS = new Set(['config', 'c', 'audit', 'cache']);
const PM_VERBS = new Set([...PM_SAFE, ...PM_FETCH, ...PM_CREDENTIALS, ...PM_SHELLS, ...PM_DEPENDS]);

/**
 * The subcommand of a JavaScript package manager and what follows it. Script names (yarn build) and option values
 * (npm --loglevel silent install) stand among the words too, so the first word that is a subcommand the rules know
 * is the one; an unknown word is passed over.
 */
function pmVerb(args: readonly Word[]): { verb: string; after: string[] } | null {
  const given = beforeDashes(args).filter((text) => !text.startsWith('-'));
  const at = given.findIndex((verb) => PM_VERBS.has(verb));
  return at < 0 ? null : { verb: given[at], after: given.slice(at + 1) };
}

const GLOBAL_FLAGS = ['-g', '--global', '--location=global'];
/** An install for the whole laptop, into a prefix outside the clone. */
const installsGlobally = (args: readonly Word[]): boolean =>
  beforeDashes(args).some(
    (text, at, all) => GLOBAL_FLAGS.includes(text) || (text === '--location' && all[at + 1] === 'global'),
  );

/** Rule 10: the plain forms that install only what a manifest in the clone already declares. */
function installsDeclaredDependencies(call: Call, ctx: Context): boolean {
  const given = texts(positionals(call.args));
  const first = given[0] ?? '';
  const second = given[1] ?? '';
  const alone = given.length === 1;
  switch (call.program) {
    case 'npm':
    case 'pnpm':
      return alone && (first === 'ci' || first === 'install' || first === 'i') && !installsGlobally(call.args);
    case 'bun':
      return alone && (first === 'install' || first === 'i') && !installsGlobally(call.args);
    case 'yarn':
    case 'bundle':
    case 'poetry':
      return alone && first === 'install' && !installsGlobally(call.args);
    case 'pip':
    case 'pip3':
      return first === 'install' && installsFromClone(call.args, ctx);
    case 'uv': {
      // uv pip sync installs exactly what its requirements files say, which have to be the clone's own.
      const manifests = positionals(call.args).slice(2);
      const synced = first === 'pip' && second === 'sync' && manifests.every((word) => withinClone(word, ctx));
      return (alone && first === 'sync') || synced;
    }
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

/** Whether a word, read as a path from every directory the command may run in, is inside the clone. */
function withinClone(word: Word, ctx: Context): boolean {
  if (ctx.dirs.length === 0) return false;
  return ctx.dirs.every((dir) => place(resolve(word, dir, ctx.clone), ctx.clone) === 'inside');
}

/** The options of pip that take their value in the next word. */
const PIP_VALUED = new Set([
  '-r', '--requirement', '-e', '--editable', '-c', '--constraint', '-i', '--index-url', '--extra-index-url',
  '--find-links', '-t', '--target', '--prefix', '--python', '--cache-dir',
]);

/**
 * The two declared forms of pip: -r a requirements file of the clone, and -e . for the project itself. The
 * manifest is the clone's own, read from wherever the command may run: one anywhere else declares nothing here.
 */
function installsFromClone(args: readonly Word[], ctx: Context): boolean {
  let declared = false;
  let given = 0;
  let at = 0;
  const manifest = (word: Word | undefined): boolean =>
    word !== undefined && word.text !== '' && !isUrl(word.text) && withinClone(word, ctx);
  while (at < args.length) {
    const text = args[at].text;
    const inlined = text.match(/^--(?:requirement|editable)=(.*)$/);
    if (text === '-r' || text === '--requirement' || text === '-e' || text === '--editable') {
      if (!manifest(args[at + 1])) return false;
      declared = true;
      at += 2;
      continue;
    }
    if (inlined !== null) {
      if (!manifest({ ...args[at], text: inlined[1] })) return false;
      declared = true;
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
  'playwright', 'biome', 'tsx', 'vite', 'mocha', 'nyc',
  // Python.
  'python', 'python3', 'pip', 'pip3', 'uv', 'uvx', 'poetry', 'pytest', 'tox', 'ruff', 'mypy', 'black', 'isort',
  'flake8', 'coverage', 'nox', 'virtualenv', 'pre-commit', 'alembic', 'django-admin',
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
 * Whether a package manager would reach a registry for something no manifest declares, act on the registry with
 * the owner's credentials, or change its own configuration. Rule 10 has had its say by the time this is asked, so
 * what is left adds a dependency, publishes one, or runs a package fetched on the spot.
 */
function reachesRegistry(call: Call): boolean {
  const given = texts(positionals(call.args));
  const first = given[0] ?? '';
  const second = given[1] ?? '';
  switch (call.program) {
    case 'npm':
    case 'pnpm':
    case 'yarn':
    case 'bun': {
      if (installsGlobally(call.args)) return true;
      const found = pmVerb(call.args);
      if (found === null) return false;
      const { verb, after } = found;
      if (PM_FETCH.has(verb) || PM_CREDENTIALS.has(verb) || PM_SHELLS.has(verb)) return true;
      if (verb === 'config' || verb === 'c') return ['set', 'delete', 'rm', 'edit', 'fix'].includes(after[0] ?? '');
      if (verb === 'audit') return after.includes('fix');
      if (verb === 'cache') return after[0] === 'add';
      return false;
    }
    case 'pip':
    case 'pip3':
      // pip config set writes the index every later install reads; list and get only show it.
      return (
        ['install', 'download', 'wheel'].includes(first) || (first === 'config' && !['list', 'get'].includes(second))
      );
    case 'uv':
      return UV_REACHES.has(first);
    case 'poetry':
      return ['add', 'update', 'lock', 'publish', 'source', 'self', 'config'].includes(first);
    case 'cargo':
      return CARGO_REACHES.has(first);
    case 'go':
      return first === 'get' || first === 'install' || (first === 'mod' && !['download', 'verify'].includes(second));
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

/** uv subcommands that fetch: a package, a tool, an interpreter, uv itself, or the formatter it runs. */
const UV_REACHES = new Set(['add', 'pip', 'tool', 'init', 'build', 'publish', 'python', 'self', 'format']);
/** cargo subcommands that fetch, or act on the registry with the owner's token. */
const CARGO_REACHES = new Set([
  'add', 'install', 'update', 'publish', 'search', 'login', 'logout', 'owner', 'yank', 'uninstall',
]);

/** The flags that hand a program a script written on the command line, which no rule here can read. */
const INLINE_SCRIPT = new Map<string, readonly string[]>([
  ['python', ['-c']],
  ['python3', ['-c']],
  ['ruby', ['-e']],
  ['perl', ['-e', '-E']],
  ['node', ['-e', '--eval', '-p', '--print']],
  ['tsx', ['-e', '--eval', '-p', '--print']],
  ['deno', ['-e', '--eval']],
  ['bun', ['-e', '--eval', '-p', '--print']],
]);

const runsInlineScript = (call: Call): boolean => {
  const args = texts(call.args);
  if (call.program === 'python' || call.program === 'python3') {
    // python reads -c inside a bundle of options too: -Ic "…", -c"…".
    const end = args.findIndex((arg) => !arg.startsWith('-'));
    const options = end < 0 ? args : args.slice(0, end);
    if (options.some((arg) => /^-[A-Za-z]*c/.test(arg) && !arg.startsWith('--'))) return true;
  }
  const flags = INLINE_SCRIPT.get(call.program) ?? [];
  return flags.some((flag) => args.some((arg) => arg === flag || arg.startsWith(`${flag}=`)));
};

// ---------------------------------------------------------------------------------------------------------------
// Commands

interface Context {
  clone: Clone;
  /**
   * The directories the segment may run in: the request's working directory, and every directory an earlier cd
   * named. Empty when the request named no absolute directory.
   */
  dirs: string[];
}

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

/**
 * Rules 3 to 13 over a command. The segments are judged one by one and the worst verdict wins, except for rule 6,
 * which spans them: neither the download nor the shell that runs it says anything on its own.
 */
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
  // A cd moves the shell, but whether it took effect depends on the operator after it (a cd in a pipeline or after
  // || may not), so the shell is not modelled: a segment may run in any directory named so far, and its paths have
  // to hold from each of them.
  const dirs: string[] = cwd === null ? [] : [cwd];
  let moved: ApprovalJudgement | null = null;
  let verdict: ApprovalJudgement | null = null;
  for (const segment of tokenised.segments) {
    const one = judgeSegment(segment, { clone, dirs: [...dirs] });
    verdict = verdict === null ? one : worst(verdict, one);
    const cd = cdOf(segment, dirs, clone);
    if (cd === 'unknown') {
      moved ??= undecided(
        'unknown-cwd',
        'a cd in the command moves the shell somewhere the rules cannot follow (home, back, a variable, more than one place), so the paths after it cannot be checked; cd into a directory of the clone by its path',
      );
    } else if (cd !== null) {
      for (const dir of cd) if (!dirs.includes(dir)) dirs.push(dir);
    }
  }
  if (verdict !== null && moved !== null) verdict = worst(verdict, moved);
  return (
    verdict ??
    undecided('unparsed-command', 'the command text holds no command the rules can read; the owner answers this one')
  );
}

/**
 * Where a cd segment may move the shell: the directories its one literal argument names from every directory so
 * far, when each is inside the clone; 'unknown' for any other cd, and for pushd and popd; null for no cd at all.
 */
function cdOf(segment: Segment, dirs: readonly string[], clone: Clone): string[] | 'unknown' | null {
  const call = callOf(segment.words);
  if (call.program === 'pushd' || call.program === 'popd') return 'unknown';
  if (call.program !== 'cd') return null;
  const [arg, ...more] = call.args;
  if (arg === undefined || more.length > 0 || call.assignments.length > 0) return 'unknown';
  if (arg.unresolved || arg.text.startsWith('-')) return 'unknown';
  const found: string[] = [];
  for (const dir of dirs) {
    const token = resolve(arg, dir, clone);
    if (token.path === null || place(token, clone) !== 'inside') return 'unknown';
    found.push(token.path);
  }
  return found;
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

/**
 * Where each position may point. A program that only reads may read the system, a temporary directory and the
 * owner's caches; one that may load what it reads gets the clone and the system alone, because a temporary
 * directory and a cache hold what anyone wrote. What a program loads and the directory it works in have to be the
 * clone, and the programs it runs the clone or the system's own. Writing goes to the clone or a temporary directory.
 */
const ALLOWED: Record<Exclude<Position, 'text'>, ReadonlySet<Place>> = {
  read: new Set(['inside', 'device', 'stream', 'temp', 'system', 'cache']),
  data: new Set(['inside', 'device', 'stream', 'temp', 'system', 'cache']),
  write: new Set(['inside', 'device', 'stream', 'temp']),
  load: new Set(['inside', 'device']),
  dir: new Set(['inside']),
  program: new Set(['inside', 'system']),
  env: new Set(['inside', 'device', 'system']),
};
const EXECUTING_READS: ReadonlySet<Place> = new Set(['inside', 'device', 'system']);

/** Whether a position may point at a place, by the kind of program that would use it. */
function allowed(position: Position, kind: Kind, where: Place): boolean {
  if (where === 'unknown' || position === 'text') return true;
  return (position === 'read' && kind === 'executing' ? EXECUTING_READS : ALLOWED[position]).has(where);
}

/** The reason a spot is refused, by what the program would do with it. */
function refusal(spot: Spot, clone: Clone): ApprovalJudgement {
  const what = show(spot.word.source);
  const program = show(spot.part.name);
  const at = show(clone.text);
  const reasons: Record<Position, string> = {
    write: `the command writes ${what}, which is outside the clone ${at} and is no temporary directory; write inside the clone`,
    load: `${program} would load and run ${what}, which is not inside the clone ${at}; keep what it runs inside the clone`,
    dir: `${program} is told to work in ${what}, which is not inside the clone ${at}; work inside the clone`,
    program: `the command runs the program ${what}, which is neither inside the clone ${at} nor one of the system's own; call the tool by its name, or run one from the clone`,
    env: `${what} points the program at a place outside the clone ${at}; set it to a path inside the clone`,
    read:
      spot.kind === 'executing'
        ? `${what} is outside the clone ${at}, and ${program} may load what it is given; copy what it needs into the clone first`
        : `${what} is outside the clone ${at}; keep the work inside the clone`,
    data: `${what} is outside the clone ${at}; keep the work inside the clone`,
    text: '',
  };
  return declined('outside-clone', `declined: ${reasons[spot.position]}`);
}

/** The environment variables that change where a program finds its code, its registry or its configuration. */
const STEERING_VARIABLE = new RegExp(
  `^(${[
    'NODE_OPTIONS', 'PYTHONSTARTUP', 'PYTHONHOME', 'BASH_ENV', 'ENV', 'PERL5OPT', 'PERL5LIB', 'PERLLIB', 'PERL5DB',
    'RUBYOPT', 'RUBYLIB', 'SSH_ASKPASS', 'HOME', 'TMPDIR', 'RUSTC_WRAPPER', 'RUSTC_WORKSPACE_WRAPPER', 'RUSTC',
    'RUSTDOC', 'CARGO_HOME', 'CARGO_BUILD_RUSTC.*', 'CARGO_BUILD_RUSTDOC', 'CARGO_TARGET_.*_RUNNER',
    'CARGO_TARGET_.*_LINKER', 'NPM_CONFIG_.*', 'PIP_.*', 'UV_.*INDEX.*', 'UV_FIND_LINKS', 'UV_INSECURE_HOST',
    'POETRY_REPOSITORIES_.*', 'BUNDLE_MIRROR__.*', 'GOPROXY', 'GOFLAGS', 'GOINSECURE', 'GONOSUMDB', 'GONOSUMCHECK',
    'GOSUMDB', 'GOPRIVATE', 'GONOPROXY', 'SHELL', 'ZDOTDIR', 'PROMPT_COMMAND', 'CDPATH', 'MAKEFLAGS', 'MFLAGS',
    'GNUMAKEFLAGS', 'MAKEFILES', 'RIPGREP_CONFIG_PATH', 'XDG_CONFIG_HOME', 'XDG_CONFIG_DIRS', 'JAVA_TOOL_OPTIONS',
    '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS', 'JAVA_OPTS', 'MAVEN_OPTS', 'GRADLE_OPTS', 'LESSOPEN', 'LESSCLOSE',
  ].join('|')})$`,
);
/** The variables that name a program to show text with or to edit it in: harmless when they name a harmless one. */
const COMMAND_VARIABLE = /^(EDITOR|VISUAL|PAGER|MANPAGER|BROWSER|GIT_EDITOR|GIT_PAGER|GIT_SEQUENCE_EDITOR)$/;
const HARMLESS_COMMANDS = new Set(['', 'cat', 'less', 'more', 'true', 'false', ':']);
/** git's variables that say who commits and how much git tells: every other GIT_* steers git. */
const GIT_INERT_VARIABLE = new RegExp(
  `^GIT_(${[
    'AUTHOR_NAME', 'AUTHOR_EMAIL', 'AUTHOR_DATE', 'COMMITTER_NAME', 'COMMITTER_EMAIL', 'COMMITTER_DATE',
    'TERMINAL_PROMPT', 'TRACE.*', 'CURL_VERBOSE', 'PROGRESS_DELAY', 'OPTIONAL_LOCKS', 'FLUSH', 'MERGE_AUTOEDIT',
    'LFS_SKIP_SMUDGE', 'ADVICE',
  ].join('|')})$`,
);

/** Whether an assignment steers the program it is given to, whatever path or site its value names. */
function steers(word: Word): boolean {
  const { name, value } = assignmentOf(word);
  const upper = name.toUpperCase();
  if (COMMAND_VARIABLE.test(upper)) return !HARMLESS_COMMANDS.has(value.trim());
  if (upper.startsWith('GIT_')) return !GIT_INERT_VARIABLE.test(upper);
  return STEERING_VARIABLE.test(upper);
}

/** The parts of an assignment's value as a URL check reads them: "a b,c", and GOPROXY=https://x,direct. */
const valuePieces = (value: string): string[] =>
  value.split(/[\s,;]+/).flatMap((piece) => [piece, piece.slice(piece.indexOf('=') + 1)]);

/**
 * The paths an assignment's value names: its parts split at whitespace, ",", ";", "=" and ":", so that
 * PYTHONPATH=src:tests is two paths and NODE_OPTIONS=--require=/tmp/x.js names /tmp/x.js. A site is no path.
 */
function valuePaths(word: Word, value: string): Word[] {
  return value
    .split(/[\s,;]+/)
    .filter((piece) => piece !== '' && !isUrl(piece))
    .flatMap((piece) => piece.split(/[=:]/))
    .map((piece): Word => ({
      ...word,
      text: piece,
      home: false,
      user: undefined,
      unresolved: (word.unresolved && piece.includes('$')) || tildeUser(piece),
    }))
    .filter(pathShaped);
}

/** A part that stands for no program, for the assignments and redirections of a segment that runs none. */
const NO_PART: Part = {
  word: { text: '', source: '', unresolved: false, home: false },
  name: '',
  args: [],
  via: 'word',
};

/**
 * The spots of a segment's redirections: a write writes its target, a read hands it to the program as data. A
 * here-string is text and a duplicated descriptor names no file.
 */
function redirectSpots(segment: Segment, call: Call): Spot[] {
  const part = call.last ?? NO_PART;
  const kind = kindOf(part);
  return segment.redirects.flatMap((redirect): Spot[] => {
    if (redirect.kind === 'text' || redirect.kind === 'dup') return [];
    const position: Position = redirect.kind === 'write' ? 'write' : 'data';
    const word = redirect.target;
    return pathParts(word, word.text, position).map((path): Spot => ({ word, path, position, part, kind }));
  });
}

/** The spots of the assignments in front of the programs: each value is a place the program will be steered to. */
function assignmentSpots(call: Call): Spot[] {
  const part = call.last ?? NO_PART;
  const kind = kindOf(part);
  return call.assignments.flatMap((word) =>
    valuePaths(word, assignmentOf(word).value).map((path): Spot => ({ word, path, position: 'env', part, kind })),
  );
}

function judgeSegment(segment: Segment, ctx: Context): ApprovalJudgement {
  const { clone } = ctx;
  const call = callOf(segment.words);
  const words = [...segment.words, ...segment.redirects.map((redirect) => redirect.target)];

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
  const git = call.program === 'git' ? gitCall(call.args) : null;
  if (git !== null && git.subcommand.startsWith('credential')) {
    return declined(
      'secret-path',
      'declined: git credential reads or changes the credentials git keeps for the owner; work with the files of the clone instead',
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
  const loader = call.assignments.find((word) => LOADER_VARIABLE.test(assignmentOf(word).name.toUpperCase()));
  if (loader !== undefined) {
    return declined(
      'privilege',
      `declined: ${show(loader.source)} makes the system load a library into every program the command runs; build and run the tools as they are`,
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

  // Where every word points. A directory a program is told to work in (-C, --cwd) is one more place its relative
  // paths are read from, as a cd is for the segments after it.
  const spots: Spot[] = [...call.parts.flatMap(spotsOf), ...assignmentSpots(call), ...redirectSpots(segment, call)];
  const dirs = [...ctx.dirs];
  for (const spot of spots.filter((one) => one.position === 'dir')) {
    for (const dir of ctx.dirs) {
      const token = resolve(spot.path, dir, clone);
      if (token.path === null || place(token, clone) !== 'inside' || dirs.includes(token.path)) continue;
      dirs.push(token.path);
    }
  }
  /** The places a spot names from each directory; one place for an absolute path. */
  const placesOf = (spot: Spot, from: readonly string[]): { token: PathToken; where: Place }[] =>
    (from.length === 0 ? [null] : from).map((dir) => {
      const token = resolve(spot.path, dir, clone);
      return { token, where: place(token, clone) };
    });

  // 7. git hooks and the rest of .git, forced pushes, the settings of the laptop, rewritten history.
  for (const spot of spots.filter((one) => one.position === 'write')) {
    // The segments below the clone root where the path lands there, as written where it does not.
    const below = (token: PathToken): string[] => {
      const segments = token.path === null ? [] : pathSegments(token.path);
      return token.path !== null && inside(segments, clone.root)
        ? segments.slice(clone.root.length).map(fold)
        : foldedSegments(spot.path.text);
    };
    const found = placesOf(spot, dirs).map(({ token }) => below(token));
    // A write under .git is declined however it is spelled, as the diff rule declines one: a hook or a setting
    // written there acts on its own later. (.agflow is one of the credential names of rule 3.)
    if (found.some((segments) => segments.includes('.git')) || foldedSegments(spot.path.text).includes('.git')) {
      return declined(
        'git-danger',
        `declined: the command writes ${show(spot.word.source)} inside .git, where a hook or a setting would then act on its own; change the files of the repository instead`,
      );
    }
  }
  const gitVerdict = git === null ? null : gitDanger(git);
  if (gitVerdict?.verdict === 'decline') return gitVerdict;
  if (git !== null && cleansIgnored(call)) {
    const leaves = (spot: Spot): boolean =>
      spot.part.name === 'git' && placesOf(spot, dirs).some(({ where }) => where !== 'inside' && where !== 'unknown');
    if (dirs.length === 0 || spots.some(leaves)) {
      return declined(
        'git-danger',
        'declined: git clean -x deletes the ignored files, and the rules cannot see that this one would stay inside the clone; name the paths inside the clone instead',
      );
    }
  }
  const hooks = ['install', 'uninstall', 'init-templatedir'];
  if (call.program === 'pre-commit' && hooks.includes(positionals(call.args)[0]?.text ?? '')) {
    return declined(
      'git-danger',
      'declined: pre-commit install writes a git hook that would then run on its own; run the hooks with pre-commit run instead',
    );
  }

  // 8. Outside the clone. Reading the system, a temporary directory and the owner's caches is fine for a program
  // that only reads; one that may load what it reads gets the clone and the system alone, and what it loads, the
  // directory it works in and the programs it runs have to be the clone (the system's programs aside). Writing
  // anywhere but the clone and a temporary directory is refused.
  if (call.program === 'tar' && readTar(call.args).absolute) {
    return declined(
      'outside-clone',
      'declined: tar -P keeps the absolute and ".." names of an archive, so it writes wherever the archive says; extract without -P, inside the clone',
    );
  }
  if (call.program === 'unzip' && texts(call.args).some((arg) => /^-[^-]*:/.test(arg))) {
    return declined(
      'outside-clone',
      'declined: unzip -: keeps the ".." and absolute names of an archive, so it writes wherever the archive says; extract without it, inside the clone',
    );
  }
  if (git?.subcommand === 'apply' && texts(git.rest).includes('--unsafe-paths')) {
    return declined(
      'outside-clone',
      'declined: git apply --unsafe-paths writes wherever the patch says, outside the clone included; apply the patch to the clone alone',
    );
  }
  let mixed: Spot | null = null;
  for (const spot of spots) {
    const places = placesOf(spot, spot.position === 'dir' ? ctx.dirs : dirs);
    const fits = places.filter(({ where }) => allowed(spot.position, spot.kind, where));
    if (fits.length === 0) return refusal(spot, clone);
    if (fits.length < places.length) mixed ??= spot;
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
    const isRoot = (token: PathToken): boolean =>
      token.path !== null && pathSegments(token.path).join('/') === clone.root.join('/');
    const swept = spots.find(
      (spot) => spot.position === 'write' && placesOf(spot, dirs).some(({ token }) => isRoot(token)),
    );
    if (swept !== undefined) {
      return declined(
        'destructive',
        `declined: the command deletes ${show(swept.word.source)}, the clone itself, and the work of the attempt with it; remove only the files you created`,
      );
    }
  }

  // Nothing is decided on a path the rules cannot resolve.
  if (ctx.dirs.length === 0) {
    return undecided(
      'unknown-cwd',
      'the request does not say which directory the command runs in, so containment cannot be checked; the owner answers this one',
    );
  }
  if (call.program === 'pushd' || call.program === 'popd') {
    return undecided(
      'unknown-cwd',
      `${show(call.program)} moves the shell along a stack of directories the rules do not keep, so the paths after it cannot be checked; cd into a directory of the clone by its path`,
    );
  }
  if (mixed !== null) {
    return undecided(
      'unknown-cwd',
      `${show(mixed.word.source)} is inside the clone from one directory the command may run in and outside it from another, so containment cannot be settled; use a path from the clone root`,
    );
  }
  // Any word at all, not only the path-shaped ones: an expansion could stand for any path when the command runs.
  // A part of a word counts too: PYTHONPATH=src:~other/lib names a home only the shell can find.
  const vague = words.find((word) => word.unresolved) ?? spots.find((spot) => spot.path.unresolved)?.word;
  if (vague !== undefined) {
    return undecided(
      'unknown-path',
      `${show(vague.source)} holds a value only the shell can expand, so containment cannot be checked; write the paths out in full`,
    );
  }
  // A word that is a site, or whose value after an "=" is one (--registry=https://…); an assignment's value is read
  // in all its parts, because a program splits it.
  const site = (text: string): boolean =>
    isUrl(text) || (text.includes('=') && isUrl(text.slice(text.indexOf('=') + 1)));
  const url =
    words.find((word) => site(word.text)) ??
    call.assignments.find((word) => valuePieces(assignmentOf(word).value).some(isUrl));
  if (url !== undefined) {
    return undecided(
      'unrecognised',
      `${show(url.source)} names a site, and these rules allow only the fetches a manifest already declares; say what you need from it and why`,
    );
  }
  const steering = call.assignments.find(steers);
  if (steering !== undefined) {
    return undecided(
      'environment',
      `${show(steering.source)} changes where the program finds its code, its registry or its configuration, which these rules cannot follow; run the command without it, or say why the task needs it`,
    );
  }
  if (call.hidden !== null) return call.hidden;
  for (const [at, part] of call.parts.entries()) {
    const unseen = runsUnseen(part, segment, at === call.parts.length - 1);
    if (unseen !== null) {
      return undecided(
        'unrecognised',
        `${unseen}, and these rules judge only what the command shows; do the work in the clone with the tools they know, or say what it needs and why`,
      );
    }
  }
  // A git config key these rules do not know to be inert.
  if (gitVerdict !== null) return gitVerdict;

  // 10 and 11. The work a sandbox would have done had the network not been in the way.
  if (installsDeclaredDependencies(call, { clone, dirs })) {
    return approved(
      'declared-deps',
      `approved: ${show(call.program)} installs only what the manifests in the clone declare, and every path the command names was checked as written; a link inside the clone counts as clone content`,
    );
  }
  const tool = DEV_TOOLS.has(call.program) || (call.last?.via === 'module' && PYTHON_TOOLS.has(call.program));
  if (tool && !reachesRegistry(call) && !runsInlineScript(call)) {
    return approved(
      'dev-tool',
      `approved: ${show(call.program)} is a development tool, and every path the command names, as written, is inside the clone or is a system, temporary or cache path it may use; links are not followed`,
    );
  }

  // 13. Everything else waits for the owner, and the reason names what was not recognised.
  if (reachesRegistry(call)) {
    const asked = texts(positionals(call.args)).slice(1).join(' ');
    return undecided(
      'unrecognised',
      `${show(call.program)} would fetch ${asked === '' ? 'something' : show(asked)}, which no manifest of the clone declares, or act on a registry; declare it first, or say why the task needs it`,
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

/** rm that takes a whole tree, or takes it without asking. */
const sweeping = (args: readonly string[]): boolean =>
  args.some((arg) => /^-[^-]*[rRf]/.test(arg) || arg === '--recursive' || arg === '--force');

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
    'approved: every file the diff names is, as written, inside the clone and outside .git and .agflow, and no link it adds points out of the clone; links already in the clone are not followed',
  );
}
