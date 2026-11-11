// Initial runner.json (design 7.1 and 12): setup and the harness share the schema's defaults and validation.
import { randomBytes } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { type RunnerConfig, type RunnerConfigInput, RunnerConfigSchema } from '../config';

export interface RunnerFacts {
  machineId: string;
  name: string;
  capturedPath: string;
  connectivity: RunnerConfig['connectivity'];
  commitIdentity: RunnerConfig['commitIdentity'] | null;
  /** Created with canonicalHome by the caller. */
  homes: { claude: string; codex: string };
}

export function newRunnerKey(): string {
  return `rk_${randomBytes(16).toString('hex')}`;
}

/** Synchronous construction over gathered facts; setup and the harness share the schema's defaults. */
export function createRunnerConfig(facts: RunnerFacts, overrides: Partial<RunnerConfigInput> = {}): RunnerConfig {
  const parsed = RunnerConfigSchema.safeParse({
    runnerKey: newRunnerKey(),
    machineId: facts.machineId,
    name: facts.name,
    capturedPath: facts.capturedPath,
    connectivity: facts.connectivity,
    commitIdentity: facts.commitIdentity ?? undefined,
    homes: facts.homes,
    ...overrides,
  });
  if (!parsed.success) {
    // Match loadRunnerConfig's messages; its describeIssues helper is private to config.ts.
    throw new Error(
      parsed.error.issues
        .flatMap((issue) => {
          if (issue.code === 'unrecognized_keys') {
            return issue.keys.map((key) => `runner.json: ${[...issue.path, key].join('.')}: unknown field`);
          }
          return [`runner.json: ${issue.path.join('.') || '(root)'}: ${issue.message}`];
        })
        .join('\n'),
    );
  }
  for (const [vendor, home] of Object.entries(parsed.data.homes)) {
    if (home === null) continue;
    // A not-yet-created home must also resolve through real ancestors for Claude's guard.
    const missing: string[] = [];
    let existing = home;
    while (!existsSync(existing)) {
      missing.unshift(basename(existing));
      existing = dirname(existing);
    }
    const real = join(realpathSync(existing), ...missing);
    if (real !== home) throw new Error(`runner.json: homes.${vendor}: must be a real path (${real})`);
  }
  return parsed.data;
}
