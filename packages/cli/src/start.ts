// agflow start: a hackathon project in minutes. It makes SPEC.md from the spec files, commits the seed (the spec, the
// agents' instructions and the project's scripts) to the repository, creating it with gh when asked, and resets the
// hub's project to it through the operator route. The runners follow the hub to the new project by themselves. A hub
// project that has tasks is replaced only once a person says yes, or with --yes.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { DeadlineInputSchema, type OperatorProject, type ProjectResetResult } from '@agflow/core';
import { type ParsedArgs, UsageError, listFlag, stringFlag } from './args';
import { loadCredentials } from './credentials';
import type { FetchFn } from './hub-client';
import type { Io } from './io';
import { type OperatorTokenDeps, defaultTokenDeps, findOperatorToken } from './operator-token';
import { configDir } from './paths';
import { type SeedFile, describeStack, seedFiles } from './seed';
import { type SpecFile, isUrl, readSpec, uniqueNames } from './spec';

/** A deadline as the hub takes it: an ISO 8601 date and time with a zone. */
const DEADLINE_EXAMPLE = '2026-11-16T18:00:00+03:00';

export const START_HELP = `  agflow start --spec <file or URL> [--spec ...] --repo <owner/name or URL> [--create]
               [--collaborator <login>] [--name <project>] [--stack python|typescript|<any text>]
               [--deadline <ISO 8601 with a zone, e.g. ${DEADLINE_EXAMPLE}, or +36h>] [--hub <url>] [--yes]
                                Seed a repository with the spec and make it the hub's project; --yes replaces
                                a hub project that has tasks without asking
`;

export interface StartDeps extends OperatorTokenDeps {
  fetch: FetchFn;
  /** The CLI's configuration directory, with the saved login whose hub is used unless --hub is given. */
  configDir: string;
  now: () => number;
  /** Asks the person at the terminal and gives the line they answer; null without a terminal. */
  ask: ((question: string) => Promise<string>) | null;
}

/**
 * One question on output (standard error), and the line typed after it on input (standard input). Ctrl-C or Ctrl-D at
 * the question closes the reader before a line comes, which answers '', a no.
 */
export function askTerminal(
  question: string,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stderr,
): Promise<string> {
  return new Promise((resolve) => {
    const reader = createInterface({ input, output });
    reader.once('close', () => resolve(''));
    reader.question(question, (answer) => {
      resolve(answer);
      reader.close();
    });
  });
}

export const defaultStartDeps = (): StartDeps => ({
  ...defaultTokenDeps(),
  fetch: (input, init) => fetch(input, init),
  configDir: configDir(),
  now: () => Date.now(),
  ask: process.stdin.isTTY ? askTerminal : null,
});

/** The repository as given: owner/name on GitHub, or a URL (or path) git can clone. */
export interface RepoRef {
  url: string;
  /** owner/name, for gh; null for a repository outside GitHub. */
  slug: string | null;
  /** Its name, the project's name by default. */
  name: string;
}

const SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function repoOf(given: string): RepoRef {
  if (SLUG.test(given)) {
    const slug = given.replace(/\.git$/, '');
    return { url: `https://github.com/${slug}`, slug, name: slug.split('/')[1] as string };
  }
  const github = given.match(/github\.com[:/]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  const name = given.replace(/\/+$/, '').split(/[/:]/).at(-1)?.replace(/\.git$/, '') || 'project';
  return { url: given, slug: github?.[1] ?? null, name };
}

const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

/**
 * --deadline as an ISO 8601 time in UTC: a date and time with a zone, checked by the hub's rule (DeadlineInputSchema)
 * with the seconds optional, or +36h (also +90m, +2d) from now; null without one. A time without a zone is refused, as
 * the hub refuses it.
 */
export function parseDeadline(value: string | undefined, now: number): string | null {
  if (value === undefined) return null;
  const relative = value.match(/^\+(\d+(?:\.\d+)?)([mhd])$/);
  if (relative) return new Date(now + Number(relative[1]) * (UNIT_MS[relative[2] as string] as number)).toISOString();
  const iso = value.replace(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?=Z|[+-])/, '$1:00');
  if (!DeadlineInputSchema.shape.deadline.safeParse(iso).success) {
    throw new UsageError(
      `--deadline must be an ISO 8601 date and time with a zone, such as ${DEADLINE_EXAMPLE}, or +36h`,
    );
  }
  return new Date(iso).toISOString();
}

const readable = (deadline: string | null): string =>
  deadline === null ? 'none' : `${deadline.slice(0, 16).replace('T', ' ')} UTC`;

/** The goal agflow start sets: all of SPEC.md first, then better work until the deadline. */
export function startGoal(stack: string | null, deadline: string | null): string {
  return (
    `Implement SPEC.md completely (it is in the repository root). Stack: ${describeStack(stack)}. ` +
    `Deadline: ${readable(deadline)}. When SPEC.md is covered, keep improving the product (defects, tests, demo ` +
    'polish, new features) until the deadline.'
  );
}

/** The standing rule that names the stack. */
export function stackRule(stack: string | null): string {
  return (
    `Stack: ${describeStack(stack)}. Build everything with it; another language or framework needs a person's word. ` +
    'AGENTS.md says where things go, and scripts/check.sh must pass before you submit.'
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Runs a command and gives its output; a failure throws with what the command said. */
function must(deps: StartDeps, argv: string[], cwd?: string): string {
  const ran = deps.run(argv, { env: { ...deps.env, GIT_TERMINAL_PROMPT: '0' }, cwd });
  if (ran.code !== 0) {
    throw new Error(`${argv.slice(0, 2).join(' ')} failed: ${(ran.stderr || ran.stdout).trim() || `exit code ${ran.code}`}`);
  }
  return ran.stdout.trim();
}

/** gh repo create, private, unless the repository is there already; then the collaborators get write access. */
function prepareGithub(deps: StartDeps, repo: RepoRef, create: boolean, collaborators: string[], io: Io): void {
  if (!repo.slug && (create || collaborators.length > 0)) {
    throw new UsageError('--create and --collaborator need a GitHub repository: --repo owner/name');
  }
  const slug = repo.slug as string;
  if (create) {
    const exists = deps.run(['gh', 'repo', 'view', slug, '--json', 'name'], { env: deps.env }).code === 0;
    if (exists) io.out(`${slug} exists already; using it.\n`);
    else {
      must(deps, ['gh', 'repo', 'create', slug, '--private']);
      io.out(`Created the private repository ${slug}.\n`);
    }
  }
  for (const login of collaborators) {
    // GitHub answers with an invitation, which the person must accept, or with nothing when they have access already.
    const path = `repos/${slug}/collaborators/${login}`;
    const invitation = must(deps, ['gh', 'api', '-X', 'PUT', path, '-f', 'permission=push']);
    io.out(
      invitation
        ? `Invited ${login} to ${slug} with write access. Their runner can fetch it once they accept at ` +
            `https://github.com/${slug}/invitations.\n`
        : `${login} has write access to ${slug}.\n`,
    );
  }
}

/** What the seed commit came to. */
interface Seeded {
  branch: string;
  sha: string;
  /** False when the repository held these files already. */
  committed: boolean;
}

/**
 * Clones the repository and commits the seed on the hub's main branch, the one its attempts start from: the first
 * commit of an empty repository, a new commit on top of that branch, or, where the repository has no such branch, a
 * new branch from its default one. The push never forces.
 */
function seedRepository(
  deps: StartDeps,
  repo: { url: string; branch: string },
  files: SeedFile[],
  work: string,
  message: string,
): Seeded {
  const { url, branch } = repo;
  must(deps, ['git', 'clone', '--quiet', url, work]);
  const git = (...args: string[]) => must(deps, ['git', ...args], work);
  const has = (ref: string) =>
    deps.run(['git', 'rev-parse', '--verify', '--quiet', ref], { env: deps.env, cwd: work }).code === 0;
  const onOrigin = has(`refs/remotes/origin/${branch}`);
  if (onOrigin) git('checkout', '--quiet', '-B', branch, `origin/${branch}`);
  else if (has('HEAD')) git('checkout', '--quiet', '-b', branch);
  else git('symbolic-ref', 'HEAD', `refs/heads/${branch}`);
  for (const file of files) {
    const path = join(work, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.content);
    if (file.executable) chmodSync(path, 0o755);
  }
  git('add', '--', ...files.map((file) => file.path));
  // Executable whatever core.fileMode says.
  git('update-index', '--chmod=+x', '--', ...files.filter((file) => file.executable).map((file) => file.path));
  const staged = deps.run(['git', 'diff', '--cached', '--quiet'], { env: deps.env, cwd: work }).code !== 0;
  if (staged) git('commit', '--quiet', '-m', message);
  if (staged || !onOrigin) git('push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`);
  return { branch, sha: git('rev-parse', 'HEAD'), committed: staged };
}

/**
 * Whether the hub's project may be replaced: at once when it has no task or --yes was given; otherwise only when the
 * person at the terminal says yes, since the reset archives its database and empties it. Without a terminal it throws.
 */
async function mayReplace(current: OperatorProject, yes: boolean, deps: StartDeps): Promise<boolean> {
  // A hub of an older release does not count its tasks, so its project may have some.
  const tasks: number | undefined = current.tasks;
  if (yes || tasks === 0) return true;
  const count = tasks === undefined ? '' : ` (${tasks} task${tasks === 1 ? '' : 's'})`;
  const project = `the hub's project ${current.project.name}${count}`;
  if (deps.ask === null) throw new Error(`this replaces ${project}, and there is no terminal to ask: give --yes to go on`);
  const answer = await deps.ask(`This replaces ${project}; its database is archived. Continue? [y/N] `);
  return /^y(es)?$/i.test(answer.trim());
}

/** An operator route with the operator token: a GET, or a POST of the body. */
async function operatorCall<T>(
  deps: StartDeps,
  hub: string,
  token: { token: string; source: string },
  path: string,
  body?: object,
): Promise<T> {
  let response: Response;
  try {
    response = await deps.fetch(`${hub}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', 'x-agflow-operator': token.token },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    throw new Error(`cannot reach the hub at ${hub}: ${describe(error)}`);
  }
  const json = (await response.json().catch(() => null)) as { message?: string } | null;
  if (response.ok) return json as T;
  if (response.status === 404) {
    throw new Error(`the hub at ${hub} has no operator routes: set AGFLOW_OPERATOR_TOKEN and AGFLOW_OPERATOR_USER there`);
  }
  if (response.status === 401) throw new Error(`the hub refused the operator token from ${token.source}`);
  throw new Error(`the hub refused ${path} (HTTP ${response.status}): ${json?.message ?? 'no reason given'}`);
}

export async function startCommand(args: ParsedArgs, io: Io, deps: StartDeps = defaultStartDeps()): Promise<number> {
  const sources = listFlag(args, 'spec');
  const given = stringFlag(args, 'repo');
  if (args.positional.length > 1 || sources.length === 0 || !given) {
    throw new UsageError('agflow start needs --spec <file or URL> and --repo <owner/name or URL>');
  }
  for (const source of sources) {
    if (!isUrl(source) && !existsSync(source)) throw new UsageError(`no spec file at ${source}`);
  }
  const repo = repoOf(given);
  const hub = (stringFlag(args, 'hub') ?? loadCredentials(deps.configDir)?.hubUrl)?.replace(/\/+$/, '');
  if (!hub) throw new UsageError('no hub: sign in with agflow login --hub <url>, or give --hub <url>');
  const token = findOperatorToken(deps);
  if (token === null) {
    throw new Error(
      'no operator token: set AGFLOW_OPERATOR_TOKEN, store it with agflow operator-token set, or write it to ' +
        '~/.agflow/operator-token (mode 600)',
    );
  }
  const deadline = parseDeadline(stringFlag(args, 'deadline'), deps.now());
  const stack = stringFlag(args, 'stack')?.trim() || null;
  const name = stringFlag(args, 'name')?.trim() || repo.name;
  // Asked before anything is made: the seed goes on the branch the hub's attempts start from (AGFLOW_MAIN_BRANCH), and
  // a project with tasks is replaced only with a person's yes.
  const current = await operatorCall<OperatorProject>(deps, hub, token, '/api/operator/project');
  if (!(await mayReplace(current, args.flags.yes === true, deps))) {
    io.out(`Stopped: the hub's project is still ${current.project.name}.\n`);
    return 1;
  }
  const { mainBranch } = current;

  const tmp = mkdtempSync(join(tmpdir(), 'agflow-start-'));
  try {
    const specs: SpecFile[] = uniqueNames(
      sources.map((source, index) => readSpec(source, index, { env: deps.env, run: deps.run, tmp })),
    );
    prepareGithub(deps, repo, args.flags.create === true, listFlag(args, 'collaborator'), io);
    const files = seedFiles({ name, stack, specs });
    const message = `Start ${name}: the spec, AGENTS.md and the scripts`;
    const seeded = seedRepository(deps, { url: repo.url, branch: mainBranch }, files, join(tmp, 'repo'), message);
    const at = `${seeded.branch} at ${seeded.sha.slice(0, 7)}`;
    if (seeded.committed) io.out(`Committed ${files.map((file) => file.path).join(', ')} to ${repo.url} (${at}).\n`);
    else io.out(`${repo.url} holds these files already (${at}).\n`);
    const untranscribed = specs.filter((spec) => spec.text === null).map((spec) => `docs/spec/${spec.name}`);
    if (untranscribed.length > 0) {
      io.out(`No text in ${untranscribed.join(', ')}: SPEC.md asks the first task to transcribe it.\n`);
    }
    const goal = startGoal(stack, deadline);
    const body = { name, repo: repo.url, deadline, goal, rules: [stackRule(stack)] };
    const reset = await operatorCall<ProjectResetResult>(deps, hub, token, '/api/operator/project/reset', body);
    io.out(
      `The hub's project is now "${reset.project.name}" (${reset.project.repo}), epoch ${reset.epoch}, with goal ` +
        `v${reset.goalVersion}, a standing rule for the stack and deadline ${readable(deadline)}.\n`,
    );
    if (reset.archive) io.out(`The old project's database is archived on the hub's server at ${reset.archive}.\n`);
    io.out(`Runners move to the new project by themselves. Follow it at ${hub}\n`);
    return 0;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
