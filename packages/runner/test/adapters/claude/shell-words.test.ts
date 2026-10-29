import { describe, expect, test } from 'bun:test';
import { type ShellCommand, splitShellCommands } from '../../../src/adapters/claude/shell-words';

/** The commands of a line that must parse, as their words. */
function words(line: string): string[][] {
  return commands(line).map((command) => command.words);
}

function commands(line: string): ShellCommand[] {
  const split = splitShellCommands(line);
  if (!split.ok) throw new Error(`expected ${JSON.stringify(line)} to parse: ${split.problem}`);
  return split.commands;
}

function problem(line: string): string {
  const split = splitShellCommands(line);
  if (split.ok) throw new Error(`expected ${JSON.stringify(line)} not to parse`);
  return split.problem;
}

describe('splitShellCommands', () => {
  test('words lose their quotes and escapes', () => {
    expect(words(`git commit -m "push later" 'it''s' a\\ b \\git ""`)).toEqual([
      ['git', 'commit', '-m', 'push later', 'its', 'a b', 'git', ''],
    ]);
    expect(words(`echo "a \\"b\\" \\$c \\x" $'tab\\tq\\'s'`)).toEqual([['echo', 'a "b" $c \\x', "tab\tq's"]]);
    expect(words('echo one\\\ntwo')).toEqual([['echo', 'onetwo']]);
  });

  test('operators and newlines separate commands', () => {
    expect(words('a 1; b 2 && c || d | e & f\ng |& h')).toEqual([
      ['a', '1'],
      ['b', '2'],
      ['c'],
      ['d'],
      ['e'],
      ['f'],
      ['g'],
      ['h'],
    ]);
    expect(words('a;b&&c')).toEqual([['a'], ['b'], ['c']]);
    expect(words('  ;; \n')).toEqual([]);
  });

  test('comments end at the line end, but # inside a word is kept', () => {
    expect(words('a # git push\nb c#d')).toEqual([['a'], ['b', 'c#d']]);
  });

  test('subshells, groups and function bodies contribute their commands', () => {
    expect(words('(cd x && git push) | cat')).toEqual([['cd', 'x'], ['git', 'push'], ['cat']]);
    expect(words('{ a; b; }')).toEqual([['{', 'a'], ['b'], ['}']]);
    expect(words('f() { git push; }; f')).toEqual([['f'], ['{', 'git', 'push'], ['}'], ['f']]);
  });

  test('command substitutions and backticks are parsed as commands of their own', () => {
    expect(words('echo $(git push) done')).toEqual([['git', 'push'], ['echo', '$(git push)', 'done']]);
    expect(words('echo "x $(a "q" | b) y"')).toEqual([['a', 'q'], ['b'], ['echo', 'x $(a "q" | b) y']]);
    expect(words('echo `git push` "`b`"')).toEqual([['git', 'push'], ['b'], ['echo', '`git push`', '`b`']]);
    expect(words('echo $(a $(b) `c`)')).toEqual([['b'], ['c'], ['a', '$(b)', '`c`'], ['echo', '$(a $(b) `c`)']]);
    expect(words('diff <(git show x) >(tee y)')).toEqual([
      ['git', 'show', 'x'],
      ['tee', 'y'],
      ['diff', '<(git show x)', '>(tee y)'],
    ]);
  });

  test('parameter and arithmetic expansions stay inside their word, with the substitutions they hold', () => {
    expect(words('echo ${A:-"x y"} $((1 + (2))) $HOME/b')).toEqual([
      ['echo', '${A:-"x y"}', '$((1 + (2)))', '$HOME/b'],
    ]);
    expect(words('echo ${A:-$(git push)} $(( $(b) + 1 ))')).toEqual([
      ['git', 'push'],
      ['b'],
      ['echo', '${A:-$(git push)}', '$(( $(b) + 1 ))'],
    ]);
  });

  test('redirections are collected with their targets', () => {
    expect(commands('a > out 2>&1 >>log <in 2> err &>all 3<>rw b >|clobber')).toEqual([
      {
        words: ['a', 'b'],
        redirects: [
          { op: '>', fd: null, target: 'out' },
          { op: '>&', fd: 2, target: '1' },
          { op: '>>', fd: null, target: 'log' },
          { op: '<', fd: null, target: 'in' },
          { op: '>', fd: 2, target: 'err' },
          { op: '&>', fd: null, target: 'all' },
          { op: '<>', fd: 3, target: 'rw' },
          { op: '>|', fd: null, target: 'clobber' },
        ],
      },
    ]);
    expect(commands('echo x>".git/con"fig')[0]?.redirects).toEqual([{ op: '>', fd: null, target: '.git/config' }]);
  });

  test('here-documents are bodies, not commands', () => {
    const commit = `git commit -m "$(cat <<'EOF'\nDon't push (yet)\ngh is \`fine\` here\nEOF\n)" && git status`;
    expect(words(commit)).toEqual([
      ['cat'],
      ['git', 'commit', '-m', `$(cat <<'EOF'\nDon't push (yet)\ngh is \`fine\` here\nEOF\n)`],
      ['git', 'status'],
    ]);
    expect(commands('cat <<-"END" > notes\n\tgit push\n\tEND\nls')).toEqual([
      {
        words: ['cat'],
        redirects: [
          { op: '<<-', fd: null, target: 'END', body: 'git push\n' },
          { op: '>', fd: null, target: 'notes' },
        ],
      },
      { words: ['ls'], redirects: [] },
    ]);
    expect(words('a <<A; b <<B\nbody a\nA\nbody b\nB\nc <<<"here string"')).toEqual([['a'], ['b'], ['c']]);
  });

  test('an unquoted here-document still runs its command substitutions', () => {
    expect(words('cat <<EOF\nnow $(git push) and `gh pr list`\nEOF')).toEqual([
      ['cat'],
      ['git', 'push'],
      ['gh', 'pr', 'list'],
    ]);
  });

  test('broken input is reported', () => {
    expect(problem('echo "push')).toBe('unterminated double quote');
    expect(problem("echo 'push")).toBe('unterminated single quote');
    expect(problem('echo $(git push')).toBe('unterminated $(');
    expect(problem('echo `git push')).toBe('unterminated backtick');
    expect(problem('echo ${A')).toBe('unterminated ${');
    expect(problem('cat <<EOF\ngit push')).toBe('unterminated here-document EOF');
    expect(problem('a )')).toBe('unexpected )');
    expect(problem('a >')).toBe('a redirection without a target');
    expect(problem('a && && b')).toBe('unexpected &&');
    expect(problem('echo \\')).toBe('a trailing backslash');
    expect(problem(`echo ${'$('.repeat(100)}x${')'.repeat(100)}`)).toBe('nested too deeply');
    const nestings: [string, string][] = [
      ['${', '}'],
      ['$((', '))'],
      ['"${', '}"'],
      ['${"', '"}'],
    ];
    for (const [open, close] of nestings) {
      expect(problem(`echo ${open.repeat(100)}x${close.repeat(100)}`)).toBe('nested too deeply');
      // Far past the bound, the depth check still answers before the stack runs out.
      expect(problem(`echo ${open.repeat(20_000)}x${close.repeat(20_000)}`)).toBe('nested too deeply');
    }
  });

  test("$'…' escapes are decoded", () => {
    expect(words("$'\\x67it' $'\\147' $'\\u00e9' $'\\cA'")).toEqual([['git', 'g', 'é', '\x01']]);
  });
});
