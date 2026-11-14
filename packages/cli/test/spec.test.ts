import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from '../src/run';
import { type SpecDeps, type SpecFile, readSpec, specMarkdown, uniqueNames } from '../src/spec';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agflow-spec-'));
  dirs.push(dir);
  return dir;
}

/** Stand-ins for pdftotext, textutil and curl, which say what they were asked; a scan yields no text. */
const FAKES: Record<string, string> = {
  pdftotext: `#!/bin/sh
[ "$1" = "-layout" ] && [ "$3" = "-" ] || exit 2
case "$2" in *scan*) exit 0;; esac
echo "pdftotext read $(basename "$2")"
`,
  textutil: `#!/bin/sh
[ "$1 $2 $3" = "-convert txt -stdout" ] || exit 2
echo "textutil read $(basename "$4")"
`,
  curl: `#!/bin/sh
out=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2;;
    -w|--max-time) shift 2;;
    -*) shift;;
    *) url="$1"; shift;;
  esac
done
case "$url" in
  *missing*) echo "curl: (22) The requested URL returned error: 404" >&2; exit 22;;
  *.md) printf '# Remote spec\\n' > "$out"; printf 'text/markdown';;
  *export*) printf '%%PDF-1.4 fake' > "$out"; printf 'application/pdf';;
  *) printf '<p>page</p>' > "$out"; printf 'text/html; charset=utf-8';;
esac
`,
};

/** A PATH with the fakes named first, and the system's tools after them. */
function fakeTools(names: string[] = Object.keys(FAKES)): SpecDeps {
  const bin = join(tempDir(), 'bin');
  mkdirSync(bin);
  for (const name of names) {
    writeFileSync(join(bin, name), FAKES[name] as string);
    chmodSync(join(bin, name), 0o755);
  }
  return { env: { PATH: `${bin}:/usr/bin:/bin` }, run: runCommand, tmp: tempDir() };
}

function specFile(name: string, content = 'x'): string {
  const path = join(tempDir(), name);
  writeFileSync(path, content);
  return path;
}

describe('reading a spec', () => {
  test('Markdown and plain text are taken as they are', () => {
    const deps = fakeTools();
    for (const name of ['brief.md', 'brief.markdown', 'notes.txt']) {
      const spec = readSpec(specFile(name, '# Brief\nBuild it.\n'), 0, deps);
      expect(spec).toEqual({ name, bytes: new TextEncoder().encode('# Brief\nBuild it.\n'), text: '# Brief\nBuild it.\n' });
    }
  });

  test('a PDF goes through pdftotext -layout; a scanned one, or one without pdftotext, yields no text', () => {
    const deps = fakeTools();
    expect(readSpec(specFile('brief.pdf'), 0, deps).text).toBe('pdftotext read brief.pdf\n');
    expect(readSpec(specFile('scan.pdf'), 0, deps).text).toBeNull();
    expect(readSpec(specFile('brief.pdf'), 0, { ...deps, env: { PATH: '/nonexistent' } }).text).toBeNull();
  });

  test('Word, RTF, OpenDocument and HTML go through textutil; without it they yield no text', () => {
    const deps = fakeTools();
    for (const name of ['brief.docx', 'brief.doc', 'brief.rtf', 'brief.odt', 'brief.html', 'brief.htm']) {
      expect([name, readSpec(specFile(name), 0, deps).text]).toEqual([name, `textutil read ${name}\n`]);
    }
    expect(readSpec(specFile('brief.docx'), 0, { ...deps, env: { PATH: '/nonexistent' } }).text).toBeNull();
  });

  test('a name in another script keeps its type, so its text is read; the original is kept under a plain name', () => {
    const deps = fakeTools();
    expect(readSpec(specFile('ТЗ.md', '# ТЗ\n'), 0, deps)).toMatchObject({ name: 'spec.md', text: '# ТЗ\n' });
    expect(readSpec(specFile('Техническое задание.txt', 'Сделать.\n'), 0, deps)).toMatchObject({
      name: 'spec.txt',
      text: 'Сделать.\n',
    });
    expect(readSpec(specFile('ТЗ.pdf'), 0, deps)).toMatchObject({ name: 'spec.pdf', text: 'pdftotext read ТЗ.pdf\n' });
    expect(readSpec(specFile('Задание (v2).docx'), 0, deps)).toMatchObject({
      name: 'v2.docx',
      text: 'textutil read Задание (v2).docx\n',
    });
    expect(readSpec('https://example.com/files/%D0%A2%D0%97.md', 1, deps)).toMatchObject({
      name: 'spec.md',
      text: '# Remote spec\n',
    });
  });

  test('an image yields no text, and its original is kept', () => {
    const spec = readSpec(specFile('mockup.png', 'PNG'), 0, fakeTools());
    expect(spec).toEqual({ name: 'mockup.png', bytes: new TextEncoder().encode('PNG'), text: null });
  });

  test('a URL is downloaded with curl and read by its name, or by its Content-Type when the name has no type', () => {
    const deps = fakeTools();
    expect(readSpec('https://example.com/specs/brief.md', 0, deps)).toMatchObject({
      name: 'brief.md',
      text: '# Remote spec\n',
    });
    expect(readSpec('https://docs.example.com/document/d/abc/export?format=pdf', 1, deps)).toMatchObject({
      name: 'export.pdf',
      text: 'pdftotext read download-1\n',
    });
    expect(readSpec('https://example.com/hackathon', 2, deps)).toMatchObject({
      name: 'hackathon.html',
      text: 'textutil read download-2\n',
    });
    expect(() => readSpec('https://example.com/missing.md', 3, deps)).toThrow(/cannot download .*404/);
  });
});

describe('SPEC.md', () => {
  const file = (name: string, text: string | null): SpecFile => ({ name, bytes: new Uint8Array(), text });

  test('one Markdown spec is SPEC.md as it is', () => {
    expect(specMarkdown([file('brief.md', '# Brief\nBuild it.')])).toBe('# Brief\nBuild it.\n');
  });

  test('anything else has a section per original, and one without text is left for the first task to transcribe', () => {
    expect(specMarkdown([file('brief.pdf', 'Build it.\n'), file('mockup.png', null)])).toBe(
      '# Specification\n\nThis file holds the text of the originals in docs/spec/.\n\n' +
        '## brief.pdf\n\nBuild it.\n\n' +
        '## mockup.png\n\nThe spec is in docs/spec/mockup.png, and the first task transcribes it into this file ' +
        '(Claude reads PDF and image files).\n',
    );
  });

  test('originals of the same name each keep a file of their own', () => {
    const names = uniqueNames([file('brief.md', 'a'), file('brief.md', 'b'), file('brief.md', 'c')]).map((f) => f.name);
    expect(names).toEqual(['brief.md', 'brief-2.md', 'brief-3.md']);
  });
});
