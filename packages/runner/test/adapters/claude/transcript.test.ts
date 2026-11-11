import { afterEach, describe, expect, test } from 'bun:test';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeProjectDir } from '../../../src/adapters/claude/paths';
import {
  deleteClaudeTranscript,
  findClaudeTranscript,
  hasClaudeConversation,
  readClaudeTranscriptTail,
} from '../../../src/adapters/claude/transcript';

const FIXTURE = join(import.meta.dir, '..', '..', 'fixtures', 'claude', 'session.jsonl');
const SESSION = '0a1b2c3d-4e5f-4061-8728-394a5b6c7d8e';
/** Longer than the 8 MiB the tail reads from the end of a transcript. */
const OVER_READ_WINDOW = 8.5 * 1024 * 1024;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A Claude home and a clone, both real directories, in a fresh temporary root. */
function setup(): { home: string; clone: string; projectDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'agflow-transcript-'));
  dirs.push(root);
  const home = join(root, 'homes', 'claude');
  const clone = join(root, 'work', 'p-1', 'T-1-a1');
  mkdirSync(join(home, 'projects'), { recursive: true });
  mkdirSync(clone, { recursive: true });
  return { home, clone, projectDir: claudeProjectDir(home, clone) };
}

function writeSession(dir: string, sessionRef: string, lines: string[]): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionRef}.jsonl`);
  writeFileSync(path, `${lines.join('\n')}\n`);
  return path;
}

const prompt = (text: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'user', isSidechain: false, message: { role: 'user', content: text }, ...extra });
const said = (blocks: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'assistant', isSidechain: false, message: { role: 'assistant', content: blocks }, ...extra });
const text = (value: string) => ({ type: 'text', text: value });
const toolUse = (name: string) => ({ type: 'tool_use', id: `toolu_${name}`, name, input: {} });
const toolResult = (name: string) =>
  JSON.stringify({
    type: 'user',
    isSidechain: false,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${name}`, content: 'ok' }] },
  });

describe('findClaudeTranscript', () => {
  test("finds <claudeHome>/projects/<slug>/<sessionRef>.jsonl in the clone's project directory first", async () => {
    const { home, clone, projectDir } = setup();
    writeSession(join(home, 'projects', '-elsewhere'), SESSION, [prompt('x')]);
    const own = writeSession(projectDir, SESSION, [prompt('x')]);
    expect(await findClaudeTranscript(home, { sessionRef: SESSION, clone })).toBe(own);
  });

  test('falls back to the session under any project directory, and gives null when there is none', async () => {
    const { home, clone } = setup();
    expect(await findClaudeTranscript(home, { sessionRef: SESSION, clone })).toBeNull();
    const other = writeSession(join(home, 'projects', '-somewhere-else'), SESSION, [prompt('x')]);
    expect(await findClaudeTranscript(home, { sessionRef: SESSION, clone })).toBe(other);
    expect(await findClaudeTranscript(home, { sessionRef: 'f'.repeat(8), clone })).toBeNull();
  });

  test('a Claude home without a projects directory has no transcripts', async () => {
    const { home, clone } = setup();
    rmSync(join(home, 'projects'), { recursive: true });
    expect(await findClaudeTranscript(home, { sessionRef: SESSION, clone })).toBeNull();
  });

  test('a session id containing path characters is refused', async () => {
    const { home, clone } = setup();
    for (const sessionRef of ['', '../x', 'a/b', 'a\\b', '..', 'x.jsonl', 'a\0b']) {
      await expect(findClaudeTranscript(home, { sessionRef, clone })).rejects.toThrow(/session id/);
      await expect(readClaudeTranscriptTail(home, { sessionRef, clone, maxChars: 100 })).rejects.toThrow(/session id/);
      await expect(deleteClaudeTranscript(home, { sessionRef, clone })).rejects.toThrow(/session id/);
    }
  });
});

describe('readClaudeTranscriptTail', () => {
  test("the recorded session's tail is its last 3 assistant turns; the tool-only turn is named by its tools", async () => {
    const { home, clone, projectDir } = setup();
    mkdirSync(projectDir, { recursive: true });
    copyFileSync(FIXTURE, join(projectDir, `${SESSION}.jsonl`));
    expect(await readClaudeTranscriptTail(home, { sessionRef: SESSION, clone, maxChars: 10_000 })).toBe(
      ['Counting.\nThere is one file.', 'The handoff is written.', '[tools: Bash]'].join('\n\n'),
    );
  });

  test('sidechain entries, malformed lines and thinking blocks are skipped', async () => {
    const { home, clone, projectDir } = setup();
    writeSession(projectDir, SESSION, [
      prompt('first'),
      said([text('one')]),
      '{"type":"assistant","message":',
      'not json at all',
      JSON.stringify(['an', 'array']),
      said([text('from a sub-agent')], { isSidechain: true }),
      prompt('a sub-agent prompt', { isSidechain: true }),
      said([{ type: 'thinking', thinking: 'hidden' }, text('two')]),
      said([toolUse('Read')]),
      toolResult('Read'),
      said([toolUse('Read'), toolUse('mcp__agflow__submit'), toolUse('Read')]),
      toolResult('mcp__agflow__submit'),
      prompt('second'),
      said([toolUse('Grep')]),
      toolResult('Grep'),
      said([toolUse('Edit')]),
      prompt('third'),
      said([toolUse('Read'), toolUse('Read')]),
    ]);
    expect(await readClaudeTranscriptTail(home, { sessionRef: SESSION, clone, maxChars: 1000 })).toBe(
      'one\ntwo\n\n[tools: Grep, Edit]\n\n[tools: Read]',
    );
  });

  test('only the last 3 turns count, a tool result does not start a turn, and prompts without replies are dropped', async () => {
    const { home, clone, projectDir } = setup();
    writeSession(projectDir, SESSION, [
      prompt('1'),
      said([text('a')]),
      prompt('2'),
      said([text('b')]),
      said([toolUse('Bash')]),
      toolResult('Bash'),
      said([text('c')]),
      prompt('3'),
      said([text('d')]),
      JSON.stringify({
        type: 'user',
        isSidechain: false,
        message: { role: 'user', content: [text('[Request interrupted]')] },
      }),
      prompt('4'),
      said([text('e')]),
      prompt('5 (no reply yet)'),
    ]);
    expect(await readClaudeTranscriptTail(home, { sessionRef: SESSION, clone, maxChars: 1000 })).toBe('b\nc\n\nd\n\ne');
  });

  test('maxChars cuts at a turn boundary and always keeps the newest turn, cut to its end', async () => {
    const { home, clone, projectDir } = setup();
    writeSession(projectDir, SESSION, [
      prompt('1'),
      said([text('x'.repeat(30))]),
      prompt('2'),
      said([text('y'.repeat(20))]),
      prompt('3'),
      said([text('z'.repeat(10))]),
    ]);
    const tail = (maxChars: number) => readClaudeTranscriptTail(home, { sessionRef: SESSION, clone, maxChars });
    expect(await tail(64)).toBe(`${'x'.repeat(30)}\n\n${'y'.repeat(20)}\n\n${'z'.repeat(10)}`);
    expect(await tail(63)).toBe(`${'y'.repeat(20)}\n\n${'z'.repeat(10)}`);
    expect(await tail(31)).toBe('z'.repeat(10));
    expect(await tail(6)).toBe(`…${'z'.repeat(5)}`);
  });

  test('a cut never leaves half a surrogate pair', async () => {
    const { home, clone, projectDir } = setup();
    writeSession(projectDir, SESSION, [prompt('1'), said([text(`${'😀'.repeat(5)}`)])]);
    const tail = await readClaudeTranscriptTail(home, { sessionRef: SESSION, clone, maxChars: 4 });
    expect(tail).toBe('…😀');
  });

  test('a transcript over 8 MiB is read from its end: a turn cut by the read window is left out', async () => {
    const { home, clone, projectDir } = setup();
    writeSession(projectDir, SESSION, [
      prompt('1'),
      said([text('x'.repeat(OVER_READ_WINDOW))]),
      prompt('2'),
      said([text('b')]),
      prompt('3'),
      said([text('c')]),
    ]);
    expect(await readClaudeTranscriptTail(home, { sessionRef: SESSION, clone, maxChars: 2 * OVER_READ_WINDOW })).toBe(
      'b\n\nc',
    );
  });

  test('when the read window starts inside a prompt, the reply after it is still a turn', async () => {
    const { home, clone, projectDir } = setup();
    writeSession(projectDir, SESSION, [
      prompt('p'.repeat(OVER_READ_WINDOW)),
      said([text('kept')]),
      prompt('2'),
      said([text('last')]),
    ]);
    expect(await readClaudeTranscriptTail(home, { sessionRef: SESSION, clone, maxChars: 1000 })).toBe('kept\n\nlast');
  });

  test('no transcript, or one without assistant turns, gives null', async () => {
    const { home, clone, projectDir } = setup();
    expect(await readClaudeTranscriptTail(home, { sessionRef: SESSION, clone, maxChars: 100 })).toBeNull();
    writeSession(projectDir, SESSION, [prompt('only a prompt')]);
    expect(await readClaudeTranscriptTail(home, { sessionRef: SESSION, clone, maxChars: 100 })).toBeNull();
  });

  test("a transcript elsewhere is read when the clone's project directory has none", async () => {
    const { home, clone } = setup();
    writeSession(join(home, 'projects', '-moved'), SESSION, [prompt('1'), said([text('found')])]);
    expect(await readClaudeTranscriptTail(home, { sessionRef: SESSION, clone, maxChars: 100 })).toBe('found');
  });
});

describe('hasClaudeConversation', () => {
  test("a transcript in the clone's project directory with a main-thread message has a conversation", async () => {
    const { home, clone, projectDir } = setup();
    writeSession(projectDir, SESSION, [JSON.stringify({ type: 'summary', summary: 'x' }), prompt('go')]);
    expect(await hasClaudeConversation(home, { sessionRef: SESSION, clone })).toBe(true);
  });

  test('no transcript, one without messages, or one elsewhere has none: what the CLI cannot resume', async () => {
    const { home, clone, projectDir } = setup();
    expect(await hasClaudeConversation(home, { sessionRef: SESSION, clone })).toBe(false);
    writeSession(join(home, 'projects', '-moved'), SESSION, [prompt('1'), said([text('elsewhere')])]);
    expect(await hasClaudeConversation(home, { sessionRef: SESSION, clone })).toBe(false);
    const queued = JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: 'go' });
    writeSession(projectDir, SESSION, ['not json', queued, prompt('a sub-agent', { isSidechain: true }), '']);
    expect(await hasClaudeConversation(home, { sessionRef: SESSION, clone })).toBe(false);
  });

  test('a session id containing path characters is refused', async () => {
    const { home, clone } = setup();
    await expect(hasClaudeConversation(home, { sessionRef: '../x', clone })).rejects.toThrow(/is not valid/);
  });
});

describe('deleteClaudeTranscript', () => {
  test('removes <sessionRef>.jsonl and the <sessionRef>/ directory with its tool results, wherever they are', async () => {
    const { home, clone, projectDir } = setup();
    const other = join(home, 'projects', '-elsewhere');
    for (const dir of [projectDir, other]) {
      writeSession(dir, SESSION, [prompt('x')]);
      mkdirSync(join(dir, SESSION, 'tool-results'), { recursive: true });
      writeFileSync(join(dir, SESSION, 'tool-results', 'toolu_1.txt'), 'output');
    }
    writeSession(projectDir, 'another-session', [prompt('y')]);
    await deleteClaudeTranscript(home, { sessionRef: SESSION, clone });
    expect(readdirSync(projectDir)).toEqual(['another-session.jsonl']);
    expect(readdirSync(other)).toEqual([]);
    expect(await findClaudeTranscript(home, { sessionRef: SESSION, clone })).toBeNull();
  });

  test("the clone's project directory goes once it is empty, and a second delete changes nothing", async () => {
    const { home, clone, projectDir } = setup();
    writeSession(projectDir, SESSION, [prompt('x')]);
    mkdirSync(join(projectDir, SESSION, 'tool-results'), { recursive: true });
    await deleteClaudeTranscript(home, { sessionRef: SESSION, clone });
    expect(existsSync(projectDir)).toBe(false);
    await deleteClaudeTranscript(home, { sessionRef: SESSION, clone });
    rmSync(join(home, 'projects'), { recursive: true });
    await deleteClaudeTranscript(home, { sessionRef: SESSION, clone });
  });
});
