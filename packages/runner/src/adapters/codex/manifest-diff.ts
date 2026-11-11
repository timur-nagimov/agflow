// Approval context comes from the vault and plain files, never the agent's git configuration (design 6.10, 7.3).
import { matchesProtectedPattern, type Approval } from '@agflow/core';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, readlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { type GitEnvironment, runGit } from '../../git/run';
import type { VendorAdapter } from '../types';

// The design's list, with .yarnrc* found per directory, then the manifests and lockfiles of the other managers that
// isPackageManagerCommand recognises: a missing diff must never read as "unchanged".
const MANIFESTS = [
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
  '.npmrc',
  '.yarnrc*',
  'bunfig.toml',
  'pyproject.toml',
  'requirements.txt',
  'poetry.lock',
  'uv.lock',
  'Pipfile',
  'Pipfile.lock',
  'Cargo.toml',
  'Cargo.lock',
  'go.mod',
  'go.sum',
];
/** Yarn reads any rc file YARN_RC_FILENAME names, so every name core's .yarnrc* pattern covers is listed. */
const YARNRC = '.yarnrc*';
/** Files a pip command names with -r or -c, beyond the fixed list. */
const EXTRA_MAX = 16;
const FILE_MAX = 256 * 1024;
/** Larger lockfiles are common; they are still hashed, so an unchanged one is not reported. */
const HASH_MAX = 64 * 1024 * 1024;
const HASH_CHUNK = 1024 * 1024;
const TEXT_MAX = 64 * 1024;
const TRUNCATED = '\n[manifest diff truncated]\n';

const NPM_INSTALL = [
  'install',
  'i',
  'in',
  'ins',
  'inst',
  'insta',
  'instal',
  'isnt',
  'isnta',
  'isntal',
  'isntall',
  'add',
  'ci',
  'clean-install',
  'ic',
  'install-clean',
  'isntall-clean',
  'install-test',
  'it',
  'install-ci-test',
  'cit',
  'update',
  'up',
  'upgrade',
  'udpate',
  'rebuild',
  'rb',
];
const INSTALL_COMMANDS: Record<string, readonly string[]> = {
  npm: NPM_INSTALL,
  bun: ['add', 'install', 'i', 'update'],
  pnpm: ['add', 'install', 'i', 'update', 'up', 'upgrade', 'rebuild', 'rb'],
  yarn: ['add', 'install', 'upgrade', 'up', 'upgrade-interactive'],
  pip: ['install'],
  uv: ['add', 'sync'],
  poetry: ['add', 'install', 'update'],
  cargo: ['add', 'update'],
  go: ['get'],
};
/** Words that run the command after them. */
const WRAPPERS = new Set(['env', 'command', 'time', 'nohup', 'exec']);
/** Options before a subcommand that take the next word as their value. */
const OPTION_VALUES = new Set(['--prefix', '-C', '--dir', '--cwd', '--filter', '-F', '--workspace']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);

/** Shell words and chains, without evaluating expansions or mistaking quoted command text for a command. */
function commandSegments(command: string): string[][] {
  const segments: string[][] = [];
  let words: string[] = [];
  let word = '';
  let started = false;
  let quote = '';
  const endWord = () => {
    if (started) words.push(word);
    word = '';
    started = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length) segments.push(words);
    words = [];
  };
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if (char === '\\' && quote !== "'") {
      const next = command[i + 1];
      if (next !== undefined && (quote === '' || ['$', '`', '"', '\\', '\n'].includes(next))) {
        if (next !== '\n') word += next;
        started = true;
        i++;
        continue;
      }
    }
    if (quote !== '') {
      if (char === quote) quote = '';
      else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (';&|\n()'.includes(char) || ('{}'.includes(char) && !started)) {
      // Subshells and groups start commands of their own; a brace inside a word, as in ${HOME}, does not.
      endSegment();
    } else if (/\s/.test(char)) {
      endWord();
    } else if (char === '#' && !started) {
      while (i < command.length && command[i] !== '\n') i++;
      i--;
    } else {
      word += char;
      started = true;
    }
  }
  endSegment();
  return segments;
}

/** The files a pip command reads requirements or constraints from. */
function requirementFiles(args: string[]): string[] {
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const flag = ['-r', '--requirement', '-c', '--constraint'].find(
      (name) => arg === name || arg.startsWith(name.startsWith('--') ? `${name}=` : name),
    );
    if (flag === undefined) continue;
    const value = arg === flag ? args[++i] : arg.slice(flag.length).replace(/^=/, '');
    if (value) files.push(value);
  }
  return files;
}

/**
 * Null for a command that installs nothing; otherwise the requirement files it names. A display heuristic, not a shell
 * interpreter or an approval policy.
 */
function packageManagerFiles(command: string): string[] | null {
  let found = false;
  const files: string[] = [];
  const visit = (text: string, depth: number): void => {
    if (depth > 8) return;
    for (const words of commandSegments(text)) {
      let index = 0;
      for (;;) {
        while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] ?? '')) index++;
        if (!WRAPPERS.has(basename(words[index] ?? ''))) break;
        index++;
        while ((words[index] ?? '').startsWith('-')) index++;
      }
      let program = basename(words[index] ?? '');
      let args = words.slice(index + 1);
      if (SHELLS.has(program)) {
        const flag = args.findIndex((arg) => /^-[a-z]*c[a-z]*$/.test(arg));
        if (flag !== -1) visit(args[flag + 1] ?? '', depth + 1);
        continue;
      }
      if (/^python[0-9.]*$/.test(program) && args[0] === '-m') {
        program = args[1] ?? '';
        args = args.slice(2);
      }
      if (/^pip[0-9.]*$/.test(program)) program = 'pip';
      let sub = 0;
      while ((args[sub] ?? '').startsWith('-')) sub += OPTION_VALUES.has(args[sub]!) ? 2 : 1;
      const subcommand = args[sub];
      if (program === 'uv' && subcommand === 'pip') {
        if (!['install', 'sync'].includes(args[sub + 1] ?? '')) continue;
        program = 'pip';
        args = args.slice(sub + 2);
      } else if (program === 'yarn' && subcommand === undefined) {
        found = true;
        continue;
      } else if (!Object.hasOwn(INSTALL_COMMANDS, program) || !INSTALL_COMMANDS[program]!.includes(subcommand ?? '')) {
        continue;
      }
      found = true;
      if (program === 'pip') files.push(...requirementFiles(args));
    }
  };
  visit(command, 0);
  return found ? files : null;
}

export function isPackageManagerCommand(command: string): boolean {
  return packageManagerFiles(command) !== null;
}

interface ManifestInput {
  clone: string;
  vault: string;
  startSha: string;
  cwd?: string;
  /** More files to compare, relative to cwd (or the clone): those a pip command names with -r or -c. */
  files?: string[];
  local: GitEnvironment;
}

type FileState = {
  kind: 'absent' | 'file' | 'symlink' | 'directory' | 'non-regular file';
  size: number;
  text?: string;
  oid?: string;
};

function missing(error: unknown): boolean {
  return ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '');
}

async function safeDirectory(clone: string, directory: string): Promise<boolean> {
  if (directory !== clone && !directory.startsWith(clone + sep)) return false;
  const path = directory.slice(clone.length);
  let current = clone;
  for (const part of ['', ...path.split(sep).filter(Boolean)]) {
    if (part === '..' && current === clone) return false;
    current = join(current, part);
    try {
      if (!(await lstat(current)).isDirectory()) return false;
    } catch (error) {
      if (missing(error)) return false;
      throw error;
    }
  }
  return true;
}

async function currentFile(path: string): Promise<FileState> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) return { kind: 'symlink', size: stat.size, text: await readlink(path) };
    if (!stat.isFile()) return { kind: stat.isDirectory() ? 'directory' : 'non-regular file', size: stat.size };
    // NOFOLLOW closes the leaf-symlink race; NONBLOCK prevents a swapped-in FIFO from hanging an approval.
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = await handle.stat();
      if (!opened.isFile()) return { kind: opened.isDirectory() ? 'directory' : 'non-regular file', size: opened.size };
      if (opened.size > HASH_MAX) return { kind: 'file', size: opened.size };
      if (opened.size > FILE_MAX) {
        const hash = createHash('sha1').update(`blob ${opened.size}\0`);
        const chunk = Buffer.alloc(HASH_CHUNK);
        let length = 0;
        for (;;) {
          const { bytesRead } = await handle.read(chunk, 0, chunk.length, length);
          if (!bytesRead) break;
          length += bytesRead;
          if (length > opened.size) throw new Error(`${path} changed while it was read`);
          hash.update(chunk.subarray(0, bytesRead));
        }
        // A file that shrank while it was read gets no oid, so it is summarised rather than called unchanged.
        return { kind: 'file', size: opened.size, ...(length === opened.size ? { oid: hash.digest('hex') } : {}) };
      }
      const buffer = Buffer.alloc(opened.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > opened.size) throw new Error(`${path} changed while it was read`);
      const content = buffer.subarray(0, length);
      const oid = createHash('sha1').update(`blob ${length}\0`).update(content).digest('hex');
      return { kind: 'file', size: length, text: content.toString('utf8'), oid };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (missing(error)) return { kind: 'absent', size: 0 };
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      return { kind: 'symlink', size: 0, text: await readlink(path) };
    }
    throw error;
  }
}

function description(file: FileState): string {
  if (file.kind === 'symlink') return `symlink -> ${JSON.stringify(file.text)}`;
  return file.kind === 'file' ? `${file.size} bytes` : file.kind;
}

/** The .yarnrc* names in a directory of the start commit or the clone. */
async function yarnrcNames(input: ManifestInput, git: string[], clone: string, directory: string): Promise<string[]> {
  const rel = relative(clone, directory);
  const tree = await runGit(input.local, [
    ...git,
    'ls-tree',
    '-z',
    '--name-only',
    input.startSha,
    ...(rel === '' ? [] : ['--', `:(literal)${rel}/`]),
  ]);
  let current: string[] = [];
  try {
    current = await readdir(directory);
  } catch (error) {
    if (!missing(error)) throw error;
  }
  const names = [
    ...tree.stdout
      .split('\0')
      .filter(Boolean)
      .map((path) => basename(path)),
    ...current,
  ];
  return [...new Set(names.filter((name) => matchesProtectedPattern(name, YARNRC)))].sort();
}

/** Root first, then the command's cwd and the named files; each directory follows the manifest order. */
export async function manifestDiff(input: ManifestInput): Promise<string | null> {
  const { vault, startSha, local } = input;
  const clone = resolve(input.clone);
  if (!(await safeDirectory(clone, clone))) throw new Error(`${clone} is not a directory`);
  const directories = [clone];
  // Relative files resolve against the cwd; with a cwd outside the clone they are skipped.
  let base: string | null = clone;
  if (input.cwd !== undefined) {
    // Check components before resolving '..', which could otherwise hide a symlink on the way.
    const cwd = isAbsolute(input.cwd) ? input.cwd : `${clone}${sep}${input.cwd}`;
    const safe = await safeDirectory(clone, cwd);
    if (resolve(cwd) !== clone && safe) directories.push(resolve(cwd));
    base = safe ? cwd : null;
  }
  const git = ['--git-dir=' + vault];
  // A missing path is normal; a missing commit or unreadable vault is not.
  const commit = await runGit(local, [...git, 'cat-file', '-t', startSha]);
  if (commit.stdout.trim() !== 'commit') throw new Error(`${startSha} is not a commit`);
  const paths: string[] = [];
  for (const dir of directories) {
    for (const name of MANIFESTS) {
      const names = name === YARNRC ? await yarnrcNames(input, git, clone, dir) : [name];
      paths.push(...names.map((entry) => relative(clone, join(dir, entry))));
    }
  }
  for (const file of (input.files ?? []).slice(0, EXTRA_MAX)) {
    const path = isAbsolute(file) ? file : base === null ? null : `${base}${sep}${file}`;
    if (path === null || !(await safeDirectory(clone, dirname(path)))) continue;
    const rel = relative(clone, resolve(path));
    if (rel !== '' && !rel.startsWith('..') && !paths.includes(rel)) paths.push(rel);
  }
  const tree = await runGit(local, [
    ...git,
    'ls-tree',
    '-z',
    '-l',
    startSha,
    '--',
    ...paths.map((p) => `:(literal)${p}`),
  ]);
  const baseFiles = new Map<string, FileState>();
  for (const entry of tree.stdout.split('\0').filter(Boolean)) {
    const tab = entry.indexOf('\t');
    const [mode, type, oid, size] = entry.slice(0, tab).trim().split(/\s+/);
    baseFiles.set(entry.slice(tab + 1), {
      kind:
        mode === '120000' ? 'symlink' : type === 'blob' ? 'file' : type === 'tree' ? 'directory' : 'non-regular file',
      size: Number(size) || 0,
      oid,
    });
  }
  let text = '';
  for (const path of paths) {
    const base = baseFiles.get(path) ?? { kind: 'absent', size: 0 };
    const current = await currentFile(join(clone, path));
    if (base.kind === 'absent' && current.kind === 'absent') continue;
    if (base.kind === 'file' && current.kind === 'file' && base.oid === current.oid) continue;
    if (base.oid && base.size <= FILE_MAX && ['file', 'symlink'].includes(base.kind)) {
      base.text = (await runGit(local, [...git, 'cat-file', 'blob', base.oid])).stdout;
    }
    if (base.kind === 'symlink' && current.kind === 'symlink' && base.text === current.text) continue;
    const special = [base, current].some((file) => !['file', 'absent'].includes(file.kind));
    const sizes = `base ${base.size} bytes, current ${current.size} bytes`;
    if (special) {
      text += `${path}: ${description(base)} -> ${description(current)}\n`;
    } else if (base.size > FILE_MAX || current.size > FILE_MAX) {
      text += `${path}: size limit (${FILE_MAX} bytes); ${sizes}\n`;
    } else if (basename(path) === 'bun.lockb' || base.text?.includes('\0') || current.text?.includes('\0')) {
      text += `${path}: binary; ${sizes}\n`;
    } else {
      // Even a small file can have enough changed lines to make an unbounded diff expensive.
      const patch = createTwoFilesPatch(
        `a/${path}`,
        `b/${path}`,
        base.text ?? '',
        current.text ?? '',
        undefined,
        undefined,
        {
          maxEditLength: 2048,
          timeout: 100,
        },
      );
      text += patch ?? `${path}: diff computation limit; ${sizes}\n`;
    }
    const bytes = Buffer.from(text);
    if (bytes.length > TEXT_MAX) {
      let end = TEXT_MAX - Buffer.byteLength(TRUNCATED);
      while ((bytes[end]! & 0xc0) === 0x80) end--;
      return bytes.subarray(0, end).toString('utf8') + TRUNCATED;
    }
  }
  return text || null;
}

/**
 * The Codex adapter binds enrichApproval to this with the runner's localGitEnv(paths); the input stays exactly
 * VendorAdapter.enrichApproval's.
 */
export async function codexEnrichApproval(
  input: Parameters<NonNullable<VendorAdapter['enrichApproval']>>[0],
  local: GitEnvironment,
): Promise<Approval['detail']> {
  const { kind, detail } = input.request;
  const files = kind === 'command' && detail.command ? packageManagerFiles(detail.command) : null;
  if (files === null) return detail;
  const diff = await manifestDiff({ ...input, cwd: detail.cwd, files, local });
  return diff === null ? detail : { ...detail, manifestDiff: diff };
}
