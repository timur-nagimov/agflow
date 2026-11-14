// The spec of agflow start: each file or URL the person gives is kept as it is under docs/spec/, and its text, where
// one can be had, goes into SPEC.md. Markdown and plain text are taken as they are; a PDF goes through pdftotext
// -layout when it is installed; Word, RTF, OpenDocument and HTML files through macOS textutil. A URL is downloaded with
// curl first and read by its type. A file that yields no text (an image, a scanned PDF) is left for the first task to
// transcribe.
import { readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { RunCommand } from './run';

/** One original and what it says. */
export interface SpecFile {
  /** Its file name, under docs/spec/. */
  name: string;
  bytes: Uint8Array;
  /** Its text; null when it yields none. */
  text: string | null;
}

export interface SpecDeps {
  env: Record<string, string | undefined>;
  run: RunCommand;
  /** A directory for downloads. */
  tmp: string;
}

const AS_TEXT = new Set(['.md', '.markdown', '.txt']);
const VIA_TEXTUTIL = new Set(['.docx', '.doc', '.rtf', '.odt', '.html', '.htm']);

/** The extension a download takes from its Content-Type when its URL names none the reader knows. */
const BY_TYPE: Record<string, string> = {
  'text/markdown': '.md',
  'text/x-markdown': '.md',
  'text/plain': '.txt',
  'text/html': '.html',
  'application/pdf': '.pdf',
  'application/rtf': '.rtf',
  'text/rtf': '.rtf',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.oasis.opendocument.text': '.odt',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

const KNOWN = new Set([...AS_TEXT, ...VIA_TEXTUTIL, ...Object.values(BY_TYPE)]);

export const isUrl = (source: string): boolean => /^https?:\/\//i.test(source);

/** A file name git and every shell take without quoting trouble. */
function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+/, '') || 'spec';
}

/** Downloads a URL with curl; its file is named after the URL, with an extension from the Content-Type if needed. */
function download(url: string, index: number, deps: SpecDeps): { path: string; name: string } {
  const segment = new URL(url).pathname.split('/').filter(Boolean).at(-1) ?? '';
  let name = safeName(decodeURIComponent(segment) || 'spec');
  const path = join(deps.tmp, `download-${index}`);
  const ran = deps.run(['curl', '-fsSL', '--max-time', '120', '-o', path, '-w', '%{content_type}', url], {
    env: deps.env,
  });
  if (ran.code !== 0) throw new Error(`cannot download ${url}: ${ran.stderr.trim() || `curl exit code ${ran.code}`}`);
  const type = ran.stdout.split(';')[0]?.trim().toLowerCase() ?? '';
  const extension = BY_TYPE[type];
  if (!KNOWN.has(extname(name).toLowerCase()) && extension) name += extension;
  return { path, name };
}

/** A tool's text output; null when the tool is missing, fails or says nothing. */
function toolText(argv: string[], deps: SpecDeps): string | null {
  const ran = deps.run(argv, { env: deps.env });
  return ran.code === 0 ? ran.stdout : null;
}

/** The text of a file, by its extension. */
function textOf(path: string, extension: string, deps: SpecDeps): string | null {
  if (AS_TEXT.has(extension)) return readFileSync(path, 'utf8');
  if (extension === '.pdf') return toolText(['pdftotext', '-layout', path, '-'], deps);
  if (VIA_TEXTUTIL.has(extension)) return toolText(['textutil', '-convert', 'txt', '-stdout', path], deps);
  return null;
}

/** Reads one spec, a file or a URL; index tells downloads apart. */
export function readSpec(source: string, index: number, deps: SpecDeps): SpecFile {
  const local = { path: source, name: safeName(basename(source)) };
  const { path, name } = isUrl(source) ? download(source, index, deps) : local;
  const bytes = new Uint8Array(readFileSync(path));
  const text = textOf(path, extname(name).toLowerCase(), deps);
  return { name, bytes, text: text === null || text.trim() === '' ? null : text };
}

/** Gives later files of the same name a number, so each original keeps its own file under docs/spec/. */
export function uniqueNames(files: SpecFile[]): SpecFile[] {
  const taken = new Set<string>();
  return files.map((file) => {
    const extension = extname(file.name);
    const stem = file.name.slice(0, file.name.length - extension.length);
    let name = file.name;
    for (let n = 2; taken.has(name); n++) name = `${stem}-${n}${extension}`;
    taken.add(name);
    return { ...file, name };
  });
}

const transcribe = (name: string): string =>
  `The spec is in docs/spec/${name}, and the first task transcribes it into this file (Claude reads PDF and image files).`;

/**
 * SPEC.md: one Markdown or text spec as it is; otherwise a section for each original, with its text or with what the
 * first task must transcribe.
 */
export function specMarkdown(files: readonly SpecFile[]): string {
  const [only] = files;
  if (files.length === 1 && only && only.text !== null && AS_TEXT.has(extname(only.name).toLowerCase())) {
    return only.text.endsWith('\n') ? only.text : `${only.text}\n`;
  }
  const sections = files.map((file) => {
    const body = file.text === null ? transcribe(file.name) : file.text.trim();
    return `## ${file.name}\n\n${body}\n`;
  });
  return `# Specification\n\nThis file holds the text of the originals in docs/spec/.\n\n${sections.join('\n')}`;
}
