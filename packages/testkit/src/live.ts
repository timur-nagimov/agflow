// The live run (design 1, 15, X-43): the exit scenarios once with real subscriptions. One Mac runs one hub and three
// runners, each with its own AGFLOW_HOME, whose runner.json points at the person's runner vendor homes that one
// `agflow runner setup` logged in, and at the pinned binaries it installed. The scenario drivers run unchanged, with
// task texts that tell a real model what the scripted programs do; their checks become a results table and
// results.json. Nothing here sends a prompt: checkVendorHome asks the vendor CLIs only for their login status.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { type Vendor, VendorSchema } from '@agflow/core';
import { loadRunnerConfig, type RunnerConfig, vendorHomes } from '@agflow/runner/src/config';
import { agflowHome as defaultAgflowHome, runnerPaths } from '@agflow/runner/src/paths';
import { createRunnerConfig } from '@agflow/runner/src/service/runner-json';
import {
  claudeLoginStatus,
  codexLoginStatus,
  type VendorLoginOptions,
  type VendorLoginStatus,
} from '@agflow/runner/src/vendor/login';
import { VENDOR_PINS, vendorBinary } from '@agflow/runner/src/vendor/pins';
import type { ClusterOptions } from './harness/cluster';
import { E2E_PLATFORM } from './harness/env';
import { LOST_LEAD } from './scenarios/lost-lead';
import type { ScenarioResult } from './scenarios/result';

const VENDORS: readonly Vendor[] = VendorSchema.options;

/** The exit scenarios a live run can run, in the order it runs them. */
export const LIVE_SCENARIOS = ['killed-agent', 'closed-laptop', 'lost-lead'] as const;
export type LiveScenario = (typeof LIVE_SCENARIOS)[number];

/** The options of `bun run live-run`; the runbook names each. */
export const LIVE_OPTIONS = [
  {
    flag: '--claude-home',
    value: '<dir>',
    help: "The runners' Claude home (CLAUDE_CONFIG_DIR) that `agflow runner setup` logged in; runner.json's by " +
      'default.',
  },
  {
    flag: '--codex-home',
    value: '<dir>',
    help: "The runners' Codex home (CODEX_HOME) that `agflow runner setup` logged in; runner.json's by default.",
  },
  {
    flag: '--runners',
    value: '<vendors>',
    help:
      'claude, codex or claude,codex (the default): the vendor every runner of a cluster offers. Each scenario runs ' +
      'once per vendor, in a cluster of its own.',
  },
  {
    flag: '--scenarios',
    value: '<names>',
    help: `Some of ${LIVE_SCENARIOS.join(',')} (the default: all three).`,
  },
  {
    flag: '--repo',
    value: '<url>',
    help:
      'A throwaway remote to use instead of a local bare origin. Each cluster resets it to main holding the toy ' +
      'repository, so it must be empty or used only by earlier live runs.',
  },
  {
    flag: '--takeover',
    value: '<vendors>',
    help:
      'claude, codex or claude,codex: after the scenarios, walk through the TTY check of the take-over commands, ' +
      'once per vendor, in a cluster each. Off by default; the exit run checks both.',
  },
  { flag: '--keep', value: null, help: "Keep every cluster's files; a failed cluster's are always kept." },
  { flag: '--help', value: null, help: 'Print this and exit.' },
] as const;

/** Where a live run finds the person's runner: an AGFLOW_HOME, its vendor homes and its network settings. */
export interface LiveDefaults {
  /** The person's AGFLOW_HOME, whose runner/vendor/ holds the pinned binaries. */
  agflowHome: string;
  claudeHome: string;
  codexHome: string;
  /** The proxy and certificate variables setup recorded in runner.json (design 7.1); empty without a runner.json. */
  connectivity: RunnerConfig['connectivity'];
}

export interface LiveArgs extends LiveDefaults {
  help: boolean;
  /** The vendors to run the scenarios with, a cluster each. */
  runners: Vendor[];
  scenarios: LiveScenario[];
  /** A throwaway remote, or null for a local bare origin. */
  repo: string | null;
  /** The vendors of the take-over TTY check, a cluster each; empty to skip it. */
  takeover: Vendor[];
  keep: boolean;
}

/** How long a live cluster's waits last: a real model may take minutes over what a scripted one answers at once. */
export const LIVE_WAIT_MS = 20 * 60_000;

/** The goal of a live cluster without a runner lead. */
export const LIVE_GOAL = 'Keep the toy word-count CLI tidy and its test green, one small task at a time.';

/**
 * The defaults: the person's AGFLOW_HOME (~/.agflow unless AGFLOW_HOME says otherwise), and the vendor homes and
 * connectivity variables its runner.json records, or the layout's homes and none before setup wrote one.
 */
export function liveDefaults(agflowHome: string = defaultAgflowHome()): LiveDefaults {
  const home = resolve(agflowHome);
  const paths = runnerPaths(home);
  if (!existsSync(paths.config)) {
    return { agflowHome: home, claudeHome: paths.homes.claude, codexHome: paths.homes.codex, connectivity: {} };
  }
  const config = loadRunnerConfig(paths.config);
  const homes = vendorHomes(config, paths);
  const connectivity = { ...config.connectivity };
  return { agflowHome: home, claudeHome: homes.claude, codexHome: homes.codex, connectivity };
}

function vendorOf(value: string): Vendor {
  const vendor = VENDORS.find((candidate) => candidate === value);
  if (vendor === undefined) throw new Error(`unknown vendor '${value}'; use ${VENDORS.join(' or ')}`);
  return vendor;
}

function scenarioOf(value: string): LiveScenario {
  const scenario = LIVE_SCENARIOS.find((candidate) => candidate === value);
  if (scenario === undefined) throw new Error(`unknown scenario '${value}'; use ${LIVE_SCENARIOS.join(', ')}`);
  return scenario;
}

/** A comma-separated list of what (vendor or scenario), each entry once, in the order given. */
function listOf<T>(flag: string, what: string, value: string, parse: (entry: string) => T): T[] {
  const entries = [...new Set(value.split(',').map((entry) => entry.trim()).filter((entry) => entry !== ''))];
  if (entries.length === 0) throw new Error(`${flag} names no ${what}`);
  return entries.map(parse);
}

/** Reads the live run's command line; an unknown option, scenario or vendor throws with what to use instead. */
export function parseLiveArgs(argv: readonly string[], defaults: LiveDefaults = liveDefaults()): LiveArgs {
  const args: LiveArgs = {
    help: false,
    ...defaults,
    runners: [...VENDORS],
    scenarios: [...LIVE_SCENARIOS],
    repo: null,
    takeover: [],
    keep: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (!arg.startsWith('--')) throw new Error(`unexpected argument '${arg}'; see --help`);
    const equals = arg.indexOf('=');
    const flag = equals === -1 ? arg : arg.slice(0, equals);
    const option = LIVE_OPTIONS.find((candidate) => candidate.flag === flag);
    if (option === undefined) throw new Error(`unknown option ${flag}; see --help`);
    if (option.value === null) {
      if (equals !== -1) throw new Error(`${flag} takes no value`);
      if (flag === '--help') args.help = true;
      else args.keep = true;
      continue;
    }
    let value: string;
    if (equals !== -1) {
      value = arg.slice(equals + 1);
    } else {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`${flag} needs a value: ${option.value}`);
      value = next;
      index += 1;
    }
    switch (flag) {
      case '--claude-home':
        args.claudeHome = resolve(value);
        break;
      case '--codex-home':
        args.codexHome = resolve(value);
        break;
      case '--runners':
        args.runners = listOf(flag, 'vendor', value, vendorOf);
        break;
      case '--scenarios':
        args.scenarios = listOf(flag, 'scenario', value, scenarioOf);
        break;
      case '--repo':
        args.repo = value;
        break;
      case '--takeover':
        args.takeover = listOf(flag, 'vendor', value, vendorOf);
        break;
    }
  }
  return args;
}

/** The live run's usage text. */
export function liveUsage(): string {
  const lines = [
    'Usage: bun run live-run [options]',
    '',
    "Runs M2's exit scenarios once with real subscriptions (design 1, 15): a local hub with the web UI, a toy",
    "repository and three runners on the person's logged-in runner vendor homes. Prints a results table and writes",
    'results.json. See docs/m2-live-run.md.',
    '',
    'Options:',
  ];
  for (const option of LIVE_OPTIONS) {
    lines.push(`  ${option.flag}${option.value === null ? '' : ` ${option.value}`}`, `      ${option.help}`);
  }
  return `${lines.join('\n')}\n`;
}

/** The person's pinned binaries under the AGFLOW_HOME, as setup or `bun run vendor:install` put them. */
export function liveBinaries(agflowHome: string): Record<Vendor, string> {
  const pins = VENDOR_PINS[E2E_PLATFORM];
  if (!pins) throw new Error(`VENDOR_PINS has no ${E2E_PLATFORM} entry`);
  const runner = runnerPaths(agflowHome).runner;
  return {
    claude: join(runner, vendorBinary('claude', pins.claude.version)),
    codex: join(runner, vendorBinary('codex', pins.codex.version)),
  };
}

/**
 * A live cluster: real models through the person's vendor homes, HOME and pinned binaries; the toy repository, on a
 * local bare origin or the throwaway remote; long waits. The lost lead also needs a runner lead that follows its goal.
 */
export function liveClusterOptions(
  args: LiveArgs,
  vendor: Vendor,
  scenario: LiveScenario | 'takeover',
): ClusterOptions {
  const lead = scenario === 'lost-lead';
  return {
    vendor,
    models: {
      kind: 'real',
      homes: { claude: args.claudeHome, codex: args.codexHome },
      home: homedir(),
      connectivity: { ...args.connectivity },
    },
    binaries: liveBinaries(args.agflowHome),
    files: toyRepoFiles(),
    repo: args.repo ?? undefined,
    runnerLeads: lead,
    goal: lead ? LOST_LEAD.goal : LIVE_GOAL,
    waitMs: LIVE_WAIT_MS,
  };
}

/** Whether a vendor home is logged in, as checkVendorHome found it. */
export interface VendorHomeCheck {
  vendor: Vendor;
  home: string;
  ok: boolean;
  /** "logged in", with Claude's plan; otherwise what is wrong. */
  detail: string;
}

/**
 * Confirms that the vendor home is logged in, with M2c's claudeLoginStatus or codexLoginStatus: they run the person's
 * pinned binary for `auth status --json` or `login status` only, so no prompt is ever sent.
 */
export async function checkVendorHome(
  vendor: Vendor,
  args: Pick<LiveArgs, 'agflowHome' | 'claudeHome' | 'codexHome' | 'connectivity'>,
  options: VendorLoginOptions = {},
): Promise<VendorHomeCheck> {
  const home = vendor === 'claude' ? args.claudeHome : args.codexHome;
  if (!existsSync(home)) return { vendor, home, ok: false, detail: `${home} does not exist` };
  const paths = runnerPaths(args.agflowHome);
  // Only the facts the status commands read: the homes, the PATH and the recorded connectivity, as the runners get it.
  const config = createRunnerConfig({
    machineId: 'live-run',
    name: 'live-run',
    capturedPath: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
    connectivity: { ...args.connectivity },
    commitIdentity: null,
    homes: { claude: args.claudeHome, codex: args.codexHome },
  });
  const status: VendorLoginStatus =
    vendor === 'claude'
      ? await claudeLoginStatus(config, paths, options)
      : await codexLoginStatus(config, paths, options);
  if (!status.ok) return { vendor, home, ok: false, detail: status.reason };
  return { vendor, home, ok: true, detail: status.plan === null ? 'logged in' : `logged in, plan ${status.plan}` };
}

const TOY_PACKAGE = { name: 'toy', private: true, type: 'module', scripts: { test: 'bun test' } };

/** The toy repository (M1's "small CLI with tests plus one research note"): a word-count CLI, its test and a note. */
export function toyRepoFiles(): Record<string, string> {
  return {
    'README.md': [
      '# toy',
      '',
      "A small word-count CLI: the repository of agflow's M2 live run.",
      '',
      '- `bun src/cli.ts <file>` prints the number of words in the file.',
      '- `bun test` runs its test.',
      '- `notes/research.md` records what counts as a word.',
      '',
    ].join('\n'),
    'package.json': `${JSON.stringify(TOY_PACKAGE, null, 2)}\n`,
    'src/count.ts': [
      '/** The number of words in the text: runs of characters other than whitespace (notes/research.md). */',
      'export function countWords(text: string): number {',
      '  return text.split(/\\s+/).filter((word) => word !== "").length;',
      '}',
      '',
    ].join('\n'),
    'src/cli.ts': [
      "import { readFileSync } from 'node:fs';",
      "import { countWords } from './count';",
      '',
      'const file = process.argv[2];',
      'if (file === undefined) {',
      "  console.error('usage: bun src/cli.ts <file>');",
      '  process.exit(2);',
      '}',
      "console.log(countWords(readFileSync(file, 'utf8')));",
      '',
    ].join('\n'),
    'test/count.test.ts': [
      "import { expect, test } from 'bun:test';",
      "import { countWords } from '../src/count';",
      '',
      "test('counts runs of non-whitespace', () => {",
      "  expect(countWords('one two  three\\nfour\\n')).toBe(4);",
      "  expect(countWords('')).toBe(0);",
      '});',
      '',
    ].join('\n'),
    'notes/research.md': [
      '# What counts as a word',
      '',
      '`wc -w` counts maximal runs of non-whitespace characters, so "co-op" is one word and "a  b" two. The CLI',
      'follows it: words are split on any whitespace, and empty strings between separators are not words.',
      'Punctuation stays part of its word; a later task may decide otherwise and record why here.',
      '',
    ].join('\n'),
  };
}

/** One row of the results: a check of a scenario run. */
export interface ResultRow {
  scenario: string;
  vendor: Vendor;
  check: string;
  passed: boolean;
  detail: string;
}

/** What results.json holds: whether every check of every run passed, and the table's rows. */
export interface LiveResults {
  passed: boolean;
  rows: ResultRow[];
}

/** A table cell: pipes escaped and lines joined, so the cell keeps the table intact. */
function cell(text: string): string {
  return text.replaceAll('|', '\\|').replaceAll('\r', '').replaceAll('\n', '<br>');
}

/**
 * The results as a markdown table of scenario, check, result and detail, for the runbook and the PR, and as
 * results.json with the same rows. A run without results did not pass.
 */
export function formatResults(results: readonly ScenarioResult[]): { markdown: string; json: LiveResults } {
  const rows = results.flatMap((result) =>
    result.checks.map((check) => ({
      scenario: result.scenario,
      vendor: result.vendor,
      check: check.name,
      passed: check.passed,
      detail: check.detail,
    })),
  );
  const lines = ['| Scenario | Check | Result | Detail |', '| --- | --- | --- | --- |'];
  for (const row of rows) {
    const scenario = `${row.scenario} (${row.vendor})`;
    const result = row.passed ? 'passed' : 'FAILED';
    lines.push(`| ${cell(scenario)} | ${cell(row.check)} | ${result} | ${cell(row.detail)} |`);
  }
  const passed = results.length > 0 && results.every((result) => result.passed);
  return { markdown: `${lines.join('\n')}\n`, json: { passed, rows } };
}
