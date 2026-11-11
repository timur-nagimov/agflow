// A small POSIX shell lexer for the guard's Bash verdict (design 8.2). It finds every simple command a command line
// would run, including those inside subshells, command and process substitutions, backticks and unquoted
// here-documents, and the redirections each one makes. It never expands anything: a word keeps the source text of its
// expansions, so `$(git push)` is both a command of its own and the literal text of the word that holds it.

export interface ShellRedirect {
  /** One of < > >> >| <> <& >& &> &>> << <<- <<<. */
  op: string;
  /** The explicit file descriptor (`2>`), or null. */
  fd: number | null;
  /** The target word without quotes; for here-documents, the delimiter. */
  target: string;
  /** A here-document's body (with <<-, its leading tabs removed): a shell given no script reads it as one. */
  body?: string;
}

export interface ShellCommand {
  words: string[];
  redirects: ShellRedirect[];
}

export type ShellSplit = { ok: true; commands: ShellCommand[] } | { ok: false; problem: string };

class ShellSyntaxError extends Error {}

/** Deeper nesting than this is no command a person or an agent writes; it is refused rather than recursed into. */
const MAX_NESTING = 64;

const REDIRECT_OPS = ['&>>', '&>', '<<<', '<<-', '<<', '<>', '<&', '>>', '>&', '>|', '<', '>'];
const CONTROL_OPS = ['&&', '||', '|&', '|', ';', '&'];
/** Operators that need a command on their left. */
const BINARY_OPS = new Set(['&&', '||', '|&', '|']);
const WORD_END = new Set([' ', '\t', '\n', ';', '&', '|', '(', ')', '<', '>']);
/** The digits after \x, \u and \U in $'…'; octal escapes take up to two more after their first. */
const ANSI_C_DIGITS: Record<string, RegExp> = {
  x: /^[0-9A-Fa-f]{1,2}/,
  u: /^[0-9A-Fa-f]{1,4}/,
  U: /^[0-9A-Fa-f]{1,8}/,
};

/**
 * Splits a command line into the simple commands it runs, in the order their parsing completes: a substitution's
 * commands come before the command whose word holds it. A line that is not valid shell gives the problem instead.
 */
export function splitShellCommands(source: string): ShellSplit {
  const commands: ShellCommand[] = [];
  try {
    new Parser(source, commands, 0).script();
  } catch (error) {
    if (error instanceof ShellSyntaxError) return { ok: false, problem: error.message };
    throw error;
  }
  return { ok: true, commands };
}

interface PendingHereDoc {
  /** The << or <<- redirection whose body this is. */
  redirect: ShellRedirect;
  delimiter: string;
  stripTabs: boolean;
  /** Unquoted delimiters leave expansions, and so command substitutions, live in the body. */
  expand: boolean;
}

interface Word {
  value: string;
  /** No quotes, escapes or expansions: only such a word of digits can be a redirection's file descriptor. */
  plain: boolean;
  quoted: boolean;
}

class Parser {
  private pos = 0;
  private readonly pending: PendingHereDoc[] = [];

  constructor(
    private readonly src: string,
    private readonly out: ShellCommand[],
    /** Lists, expansions and nested parsers this one sits in; nest() counts and bounds it. */
    private depth: number,
  ) {}

  script(): void {
    this.list(null);
    this.requireNoPendingHereDocs();
  }

  /** Scans an unquoted here-document body: only its substitutions run. */
  hereDocBody(): void {
    while (this.pos < this.src.length) {
      const c = this.src[this.pos];
      if (c === '\\') this.pos += 2;
      else if (c === '$') {
        if (this.dollar(true) === null) this.pos += 1;
      } else if (c === '`') this.backtick();
      else this.pos += 1;
    }
  }

  /** Commands up to the end of the input, or up to the `)` that closes `opening`. */
  private list(opening: string | null): void {
    this.nest();
    let words: string[] = [];
    let redirects: ShellRedirect[] = [];
    let seen = false;
    const finish = (): boolean => {
      if (words.length > 0 || redirects.length > 0) this.out.push({ words, redirects });
      const had = seen;
      words = [];
      redirects = [];
      seen = false;
      return had;
    };
    for (;;) {
      this.skipBlanks();
      if (this.pos >= this.src.length) {
        finish();
        if (opening !== null) throw new ShellSyntaxError(`unterminated ${opening}`);
        break;
      }
      const c = this.src[this.pos];
      if (c === '#') {
        const end = this.src.indexOf('\n', this.pos);
        this.pos = end < 0 ? this.src.length : end;
        continue;
      }
      if (c === '\n') {
        this.pos += 1;
        finish();
        this.readHereDocs();
        continue;
      }
      if (c === ')') {
        if (opening === null) throw new ShellSyntaxError('unexpected )');
        this.pos += 1;
        finish();
        break;
      }
      if (c === '(') {
        if (words.length === 0 && redirects.length === 0 && !seen) {
          this.pos += 1;
          this.list('(');
          seen = true;
          continue;
        }
        // `name()` starts a function definition; its body follows as ordinary commands.
        const definition = words.length === 1 ? this.src.slice(this.pos).match(/^\([ \t]*\)/) : null;
        if (!definition) throw new ShellSyntaxError('unexpected (');
        this.pos += definition[0].length;
        finish();
        continue;
      }
      if (this.redirect(null, redirects)) {
        seen = true;
        continue;
      }
      const op = CONTROL_OPS.find((candidate) => this.src.startsWith(candidate, this.pos));
      if (op) {
        this.pos += op.length;
        if (!finish() && BINARY_OPS.has(op)) throw new ShellSyntaxError(`unexpected ${op}`);
        continue;
      }
      const word = this.word();
      const next = this.src[this.pos];
      if (word.plain && /^\d+$/.test(word.value) && (next === '<' || next === '>')) {
        if (this.redirect(Number(word.value), redirects)) {
          seen = true;
          continue;
        }
      }
      words.push(word.value);
      seen = true;
    }
    this.depth -= 1;
  }

  /** Parses a redirection at the current position, if there is one. */
  private redirect(fd: number | null, redirects: ShellRedirect[]): boolean {
    const op = REDIRECT_OPS.find((candidate) => this.src.startsWith(candidate, this.pos));
    if (!op || (fd !== null && op.startsWith('&'))) return false;
    // <( and >( are process substitutions, which are words.
    if ((op === '<' || op === '>') && this.src[this.pos + 1] === '(') return false;
    this.pos += op.length;
    this.skipBlanks();
    const start = this.pos;
    const target = this.word();
    if (this.pos === start) throw new ShellSyntaxError('a redirection without a target');
    const parsed: ShellRedirect = { op, fd, target: target.value };
    redirects.push(parsed);
    if (op === '<<' || op === '<<-') {
      this.pending.push({ redirect: parsed, delimiter: target.value, stripTabs: op === '<<-', expand: !target.quoted });
    }
    return true;
  }

  private word(): Word {
    let value = '';
    let plain = true;
    let quoted = false;
    while (this.pos < this.src.length) {
      const c = this.src[this.pos] as string;
      if (WORD_END.has(c)) {
        if ((c === '<' || c === '>') && this.src[this.pos + 1] === '(' && value === '' && plain) {
          value += this.substitution(`${c}(`);
          plain = false;
          continue;
        }
        break;
      }
      if (c === '\\') {
        const next = this.src[this.pos + 1];
        if (next === undefined) throw new ShellSyntaxError('a trailing backslash');
        this.pos += 2;
        if (next !== '\n') value += next;
        plain = false;
        quoted = true;
      } else if (c === "'") {
        const end = this.src.indexOf("'", this.pos + 1);
        if (end < 0) throw new ShellSyntaxError('unterminated single quote');
        value += this.src.slice(this.pos + 1, end);
        this.pos = end + 1;
        plain = false;
        quoted = true;
      } else if (c === '"') {
        value += this.doubleQuoted();
        plain = false;
        quoted = true;
      } else if (c === '`') {
        value += this.backtick();
        plain = false;
      } else {
        // $'…' and $"…" quote like their plain forms, which matters for here-document delimiters.
        const quoting = this.src[this.pos + 1] === "'" || this.src[this.pos + 1] === '"';
        const expansion = c === '$' ? this.dollar(false) : null;
        if (expansion === null) {
          value += c;
          this.pos += 1;
        } else {
          value += expansion;
          plain = false;
          quoted ||= quoting;
        }
      }
    }
    return { value, plain, quoted };
  }

  /** The contents of a double-quoted string, with its escapes removed and its expansions kept as source text. */
  private doubleQuoted(): string {
    this.pos += 1;
    let value = '';
    while (this.pos < this.src.length) {
      const c = this.src[this.pos];
      if (c === '"') {
        this.pos += 1;
        return value;
      }
      if (c === '\\') {
        const next = this.src[this.pos + 1];
        if (next === undefined) break;
        if (next !== '\n') value += '$`"\\'.includes(next) ? next : `\\${next}`;
        this.pos += 2;
      } else if (c === '`') {
        value += this.backtick();
      } else {
        const expansion = c === '$' ? this.dollar(true) : null;
        if (expansion === null) {
          value += c;
          this.pos += 1;
        } else value += expansion;
      }
    }
    throw new ShellSyntaxError('unterminated double quote');
  }

  /**
   * An expansion starting with `$`: ANSI-C and locale strings, command substitutions, arithmetic and parameter
   * expansions. It returns the word text it contributes, or null for a plain `$` that the caller keeps.
   */
  private dollar(inDoubleQuotes: boolean): string | null {
    // Every nesting of ${, $(( and quotes inside them passes through here, so this bounds them as list() bounds $(.
    this.nest();
    try {
      const next = this.src[this.pos + 1];
      if (next === "'" && !inDoubleQuotes) return this.ansiC();
      if (next === '"' && !inDoubleQuotes) {
        this.pos += 1;
        return this.doubleQuoted();
      }
      if (next === '(' && this.src[this.pos + 2] === '(') return this.arithmetic();
      if (next === '(') return this.substitution('$(');
      if (next === '{') return this.braces();
      return null;
    } finally {
      this.depth -= 1;
    }
  }

  /** `$(…)`, `<(…)` or `>(…)`: its commands are parsed in place; the word keeps the source text. */
  private substitution(opening: string): string {
    const start = this.pos;
    this.pos += opening.length;
    this.list(opening);
    return this.src.slice(start, this.pos);
  }

  private backtick(): string {
    const start = this.pos;
    this.pos += 1;
    let inner = '';
    for (;;) {
      const c = this.src[this.pos];
      if (c === undefined) throw new ShellSyntaxError('unterminated backtick');
      if (c === '`') break;
      const next = this.src[this.pos + 1];
      if (c === '\\' && next !== undefined && '$`\\'.includes(next)) {
        inner += next;
        this.pos += 2;
      } else {
        inner += c;
        this.pos += 1;
      }
    }
    this.pos += 1;
    new Parser(inner, this.out, this.depth + 1).script();
    return this.src.slice(start, this.pos);
  }

  private arithmetic(): string {
    const start = this.pos;
    this.pos += 3;
    let depth = 0;
    for (;;) {
      const c = this.src[this.pos];
      if (c === undefined) throw new ShellSyntaxError('unterminated $((');
      if (c === ')' && depth === 0 && this.src[this.pos + 1] === ')') {
        this.pos += 2;
        return this.src.slice(start, this.pos);
      }
      if (c === '(') depth += 1;
      else if (c === ')') depth -= 1;
      if (c === '$' && this.dollar(true) !== null) continue;
      if (c === '`') {
        this.backtick();
        continue;
      }
      if (c === '"') {
        this.doubleQuoted();
        continue;
      }
      this.pos += 1;
    }
  }

  private braces(): string {
    const start = this.pos;
    this.pos += 2;
    let depth = 1;
    for (;;) {
      const c = this.src[this.pos];
      if (c === undefined) throw new ShellSyntaxError('unterminated ${');
      if (c === '\\') this.pos += 2;
      else if (c === "'") {
        const end = this.src.indexOf("'", this.pos + 1);
        if (end < 0) throw new ShellSyntaxError('unterminated single quote');
        this.pos = end + 1;
      } else if (c === '"') this.doubleQuoted();
      else if (c === '`') this.backtick();
      else if (c === '$' && this.dollar(true) !== null) continue;
      else {
        if (c === '{') depth += 1;
        if (c === '}') depth -= 1;
        this.pos += 1;
        if (depth === 0) return this.src.slice(start, this.pos);
      }
    }
  }

  /** `$'…'`, decoded: the guard must see `$'\x67it'` as git. */
  private ansiC(): string {
    this.pos += 2;
    let value = '';
    for (;;) {
      const c = this.src[this.pos];
      if (c === undefined) throw new ShellSyntaxError('unterminated single quote');
      this.pos += 1;
      if (c === "'") return value;
      if (c !== '\\') {
        value += c;
        continue;
      }
      const e = this.src[this.pos] ?? '';
      this.pos += 1;
      const simple: Record<string, string> = {
        n: '\n',
        t: '\t',
        r: '\r',
        a: '\x07',
        b: '\b',
        e: '\x1b',
        E: '\x1b',
        f: '\f',
        v: '\v',
        '\\': '\\',
        "'": "'",
        '"': '"',
        '?': '?',
      };
      if (e in simple) value += simple[e];
      else if (e === 'x' || e === 'u' || e === 'U' || /[0-7]/.test(e)) {
        const digits = this.src.slice(this.pos).match(ANSI_C_DIGITS[e] ?? /^[0-7]{0,2}/)?.[0] ?? '';
        this.pos += digits.length;
        const code = /[0-7]/.test(e) ? Number.parseInt(e + digits, 8) : Number.parseInt(digits || '0', 16);
        value += String.fromCodePoint(Math.min(code, 0x10ffff));
      } else if (e === 'c') {
        const control = this.src[this.pos] ?? '';
        this.pos += 1;
        value += String.fromCharCode(control.charCodeAt(0) & 0x1f);
      } else value += `\\${e}`;
    }
  }

  /** After a newline, the bodies of the here-documents that line opened, in order. */
  private readHereDocs(): void {
    for (const doc of this.pending.splice(0)) {
      let body = '';
      for (;;) {
        if (this.pos >= this.src.length) throw new ShellSyntaxError(`unterminated here-document ${doc.delimiter}`);
        const end = this.src.indexOf('\n', this.pos);
        const line = this.src.slice(this.pos, end < 0 ? this.src.length : end);
        this.pos = end < 0 ? this.src.length : end + 1;
        const content = doc.stripTabs ? line.replace(/^\t+/, '') : line;
        if (content === doc.delimiter) break;
        body += `${content}\n`;
      }
      doc.redirect.body = body;
      if (doc.expand) new Parser(body, this.out, this.depth + 1).hereDocBody();
    }
  }

  private requireNoPendingHereDocs(): void {
    const [doc] = this.pending;
    if (doc) throw new ShellSyntaxError(`unterminated here-document ${doc.delimiter}`);
  }

  private skipBlanks(): void {
    for (;;) {
      const c = this.src[this.pos];
      if (c === ' ' || c === '\t') this.pos += 1;
      else if (c === '\\' && this.src[this.pos + 1] === '\n') this.pos += 2;
      else return;
    }
  }

  private nest(): void {
    this.depth += 1;
    if (this.depth > MAX_NESTING) throw new ShellSyntaxError('nested too deeply');
  }
}
