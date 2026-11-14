/**
 * Reading a command the way the shell would, for code that must judge one it did not write (design 6.10, Rules).
 * Both the runner, which shows the owner what an agent asked to run, and the hub, which judges that request against
 * its rules, read the same string the same way: two readers that drift are two different answers to one question.
 */

/**
 * The words of a command as shlex quotes them: unquoted runs, '...' chunks, and "..." chunks in which a backslash
 * escapes $ ` " and itself; adjacent chunks form one word. Null for anything shlex would not write, such as an
 * operator, an expansion or an unterminated quote.
 */
export function shellWords(command: string): string[] | null {
  const words: string[] = [];
  let word: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if (char === ' ') {
      if (word !== null) words.push(word);
      word = null;
    } else if (char === "'") {
      const end = command.indexOf("'", i + 1);
      if (end === -1) return null;
      word = (word ?? '') + command.slice(i + 1, end);
      i = end;
    } else if (char === '"') {
      let chunk = '';
      for (i++; command[i] !== '"'; i++) {
        const inner = command[i];
        if (inner === undefined || inner === '$' || inner === '`') return null;
        if (inner === '\\' && ['$', '`', '"', '\\'].includes(command[i + 1] ?? '')) i++;
        chunk += command[i];
      }
      word = (word ?? '') + chunk;
    } else if (/[\s|&;<>()$`\\*?[\]{}#~!]/.test(char)) {
      return null;
    } else {
      word = (word ?? '') + char;
    }
  }
  if (word !== null) words.push(word);
  return words;
}

/**
 * Codex runs every command as `<shell> -c <script>` (or -lc), joined with shlex; the agent wrote only the script.
 * Anything that is not exactly those three words stays as it is.
 */
export function innerCommand(command: string): string {
  const words = shellWords(command);
  if (words?.length !== 3 || !/^(?:\S*\/)?[a-z]*sh$/.test(words[0]!) || !['-c', '-lc'].includes(words[1]!)) {
    return command;
  }
  return words[2]!;
}
