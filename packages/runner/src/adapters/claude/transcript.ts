// A Claude session's transcript under the runner's Claude home (design 8.3, 6.8, 7.8, 8.4): the tail the hub's handoff
// note quotes, read without a live session, whether a resume has a conversation to resume, and the deletion
// cleanup_attempt and retention run. Both look in the
// clone's project directory first, then for the session id under any project directory. The SDK's own session helpers
// are not used: they resolve the projects directory from the runner's environment, not from the Claude home.
import { createReadStream } from 'node:fs';
import { open, readdir, rm, rmdir, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { isRecord } from './json';
import { claudeProjectDir } from './paths';

export interface ClaudeTranscriptRef {
  sessionRef: string;
  /** The attempt's clone; its project directory is searched first. */
  clone: string;
}

/** The assistant turns the tail keeps (design 6.8). */
const TAIL_TURNS = 3;
/** Only the end of a long transcript is read: three turns of text never need more, tool results included. */
const TAIL_READ_BYTES = 8 * 1024 * 1024;
const TURN_SEPARATOR = '\n\n';
const CUT_MARK = '…';

// Session ids are UUIDs; anything that could leave the projects directory, or name another file, is refused.
const SESSION_REF = /^[A-Za-z0-9_-]{1,128}$/;

function checkSessionRef(sessionRef: string): void {
  if (!SESSION_REF.test(sessionRef)) throw new Error(`the session id ${JSON.stringify(sessionRef)} is not valid`);
}

/** The session's transcript file, or null when no project directory holds one. */
export async function findClaudeTranscript(claudeHome: string, ref: ClaudeTranscriptRef): Promise<string | null> {
  checkSessionRef(ref.sessionRef);
  const file = `${ref.sessionRef}.jsonl`;
  const own = ownProjectDir(claudeHome, ref.clone);
  if (own !== null && (await isFile(join(own, file)))) return join(own, file);
  for (const dir of await projectDirs(claudeHome)) {
    if (dir !== own && (await isFile(join(dir, file)))) return join(dir, file);
  }
  return null;
}

/**
 * The last three main-thread assistant turns, oldest first, a blank line between turns: a turn's text, or the names of
 * the tools it called when it wrote none. Older turns are left out whole once they would pass maxChars; the newest is
 * always kept, cut to its end when it alone is longer. Null without a transcript or any assistant turn.
 */
export async function readClaudeTranscriptTail(
  claudeHome: string,
  input: ClaudeTranscriptRef & { maxChars: number },
): Promise<string | null> {
  const path = await findClaudeTranscript(claudeHome, input);
  if (path === null) return null;
  const turns = assistantTurns(await readEnd(path, TAIL_READ_BYTES)).slice(-TAIL_TURNS);
  const newest = turns.pop();
  if (newest === undefined) return null;
  const kept = [cutToEnd(newest, input.maxChars)];
  let length = kept[0]?.length ?? 0;
  for (const turn of turns.reverse()) {
    length += TURN_SEPARATOR.length + turn.length;
    if (length > input.maxChars) break;
    kept.unshift(turn);
  }
  return kept.join(TURN_SEPARATOR);
}

/**
 * Whether the clone's project directory, where the CLI resumes from, holds the session's transcript with a message of
 * the main thread in it. A session that never ran a turn has none, and 2.1.285 refuses to resume it ('No conversation
 * found'); the adapter then starts a fresh session instead of spawning a resume that fails (8.4, 7.4).
 */
export async function hasClaudeConversation(claudeHome: string, ref: ClaudeTranscriptRef): Promise<boolean> {
  checkSessionRef(ref.sessionRef);
  const own = ownProjectDir(claudeHome, ref.clone);
  if (own === null) return false;
  const path = join(own, `${ref.sessionRef}.jsonl`);
  if (!(await isFile(path))) return false;
  // Line by line, up to the first message: a long transcript is not read whole.
  const input = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  try {
    for await (const line of lines) {
      const entry = parseEntry(line);
      if (entry !== null && entry.isSidechain !== true && (entry.type === 'user' || entry.type === 'assistant')) {
        return true;
      }
    }
    return false;
  } finally {
    lines.close();
    input.destroy();
  }
}

/**
 * Removes the session's transcript and its directory of persisted tool output from every project directory, then the
 * clone's project directory if nothing else is left in it. Idempotent.
 */
export async function deleteClaudeTranscript(claudeHome: string, ref: ClaudeTranscriptRef): Promise<void> {
  checkSessionRef(ref.sessionRef);
  const own = ownProjectDir(claudeHome, ref.clone);
  const dirs = new Set(await projectDirs(claudeHome));
  if (own !== null) dirs.add(own);
  for (const dir of dirs) {
    await rm(join(dir, `${ref.sessionRef}.jsonl`), { force: true });
    await rm(join(dir, ref.sessionRef), { recursive: true, force: true });
  }
  if (own === null) return;
  try {
    await rmdir(own);
  } catch {
    // Missing, or it still holds another session's files.
  }
}

/** The clone's project directory, or null for a clone whose slug the CLI would hash (no transcript can be there). */
function ownProjectDir(claudeHome: string, clone: string): string | null {
  try {
    return claudeProjectDir(claudeHome, clone);
  } catch {
    return null;
  }
}

async function projectDirs(claudeHome: string): Promise<string[]> {
  const projects = join(claudeHome, 'projects');
  try {
    const entries = await readdir(projects, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => join(projects, entry.name));
  } catch {
    return [];
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** The last maxBytes of a file, from its first whole line. */
async function readEnd(path: string, maxBytes: number): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    return start === 0 ? text : text.slice(text.indexOf('\n') + 1);
  } finally {
    await handle.close();
  }
}

interface Turn {
  texts: string[];
  tools: string[];
}

/**
 * The rendered main-thread assistant turns of a transcript, oldest first. A user prompt starts a turn; a tool result is
 * a user entry too, but continues the turn. Sidechain entries, malformed lines and empty turns are skipped.
 */
function assistantTurns(transcript: string): string[] {
  const turns: Turn[] = [];
  let current: Turn | null = null;
  for (const line of transcript.split('\n')) {
    const entry = parseEntry(line);
    if (entry === null || entry.isSidechain === true) continue;
    const content = isRecord(entry.message) ? entry.message.content : undefined;
    if (entry.type === 'user') {
      if (!isToolResults(content)) {
        current = { texts: [], tools: [] };
        turns.push(current);
      }
      continue;
    }
    if (entry.type !== 'assistant' || !Array.isArray(content)) continue;
    if (current === null) {
      // The read began inside a turn.
      current = { texts: [], tools: [] };
      turns.push(current);
    }
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
        current.texts.push(block.text.trim());
      } else if (block.type === 'tool_use' && typeof block.name === 'string' && !current.tools.includes(block.name)) {
        current.tools.push(block.name);
      }
    }
  }
  return turns.flatMap((turn) => {
    if (turn.texts.length > 0) return [turn.texts.join('\n')];
    if (turn.tools.length > 0) return [`[tools: ${turn.tools.join(', ')}]`];
    return [];
  });
}

function parseEntry(line: string): Record<string, unknown> | null {
  if (line.trim() === '') return null;
  try {
    const value: unknown = JSON.parse(line);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function isToolResults(content: unknown): boolean {
  return Array.isArray(content) && content.some((block) => isRecord(block) && block.type === 'tool_result');
}

/** The end of text in at most maxChars, marked as cut, without half a surrogate pair at the cut. */
function cutToEnd(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  let end = text.slice(text.length - Math.max(0, maxChars - CUT_MARK.length));
  const first = end.charCodeAt(0);
  if (first >= 0xdc00 && first <= 0xdfff) end = end.slice(1);
  return `${CUT_MARK}${end}`;
}
