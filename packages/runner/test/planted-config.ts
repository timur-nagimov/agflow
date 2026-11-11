// Planted git configuration for the tests of runner operations on an agent's clone (design 7.3). The plants are
// keys the local environment does not pin, so they stay silent only if the runner never runs git with the clone's
// own .git: a filter driver that the repository's committed .gitattributes names (PLANTED_ATTRIBUTES) and only the
// clone's .git/config defines. The pinned keys (core.fsmonitor, core.hooksPath) are planted as well.
//
// Every planted program is a shell command, which git runs through sh: macOS checks each newly written executable
// on its first run, which takes about a second under load, so fresh scripts would make these tests slow and flaky.
// The hooks directory does hold fresh scripts, but they only run if the runner is wrong.
import { chmodSync, existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitIn } from '@agflow/testkit';

/** A .gitattributes for the clone's repository: every file goes through the planted filter. */
export const PLANTED_ATTRIBUTES = '* filter=planted\n';

export interface PlantedConfig {
  /** Every planted program appends a line to it. */
  marker: string;
  /** Whether any planted program has run. */
  fired(): boolean;
  /**
   * Proves the plants live: git run in the clone fires the fsmonitor and the filter's clean command. file is a
   * tracked file of the clone.
   */
  proveLive(file: string): Promise<void>;
}

/** Shell-quoted, for a command git runs through sh. */
function quoted(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

/** A config value in double quotes, as git's config syntax reads it. */
function configString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Plants program-valued keys in the clone's .git/config: the filter driver, an fsmonitor command and a hooks
 * directory. dir is a runner-unrelated directory for the marker and the hooks.
 */
export function plantCloneConfig(clone: string, dir: string): PlantedConfig {
  const marker = join(dir, 'fired');
  const record = (what: string) => configString(`echo ${what} >> ${quoted(marker)}`);
  const hooks = join(dir, 'hooks');
  mkdirSync(hooks, { recursive: true });
  for (const hook of ['pre-commit', 'post-checkout', 'post-index-change', 'reference-transaction', 'post-merge']) {
    writeFileSync(join(hooks, hook), `#!/bin/sh\necho ${hook} >> ${quoted(marker)}\n`);
    chmodSync(join(hooks, hook), 0o755);
  }
  const config = join(clone, '.git', 'config');
  writeFileSync(
    config,
    [
      readFileSync(config, 'utf8').trimEnd(),
      '[core]',
      `\tfsmonitor = ${record('fsmonitor')}`,
      `\thooksPath = ${configString(hooks)}`,
      '[filter "planted"]',
      `\tclean = ${configString(`cat; echo clean >> ${quoted(marker)}`)}`,
      `\tsmudge = ${configString(`cat; echo smudge >> ${quoted(marker)}`)}`,
      '',
    ].join('\n'),
  );
  return {
    marker,
    fired: () => existsSync(marker),
    async proveLive(file: string) {
      // No optional locks: status then writes no index, so no fresh hook script runs.
      await gitIn(clone, ['--no-optional-locks', 'status']);
      await gitIn(clone, ['hash-object', file]);
      const lines = readFileSync(marker, 'utf8');
      if (!lines.includes('fsmonitor') || !lines.includes('clean')) {
        throw new Error(`the planted programs did not run: ${JSON.stringify(lines)}`);
      }
    },
  };
}

/** Moves a file's mtime forward, content unchanged, so any refresh of an index must hash it again. */
export function touchLater(path: string): void {
  const later = new Date(Date.now() + 60_000);
  utimesSync(path, later, later);
}
