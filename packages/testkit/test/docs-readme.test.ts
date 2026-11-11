import { describe, expect, test } from 'bun:test';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { HELP } from '../../cli/src/main';
import { loadConfig } from '../../hub/src/config';

const ROOT = resolve(import.meta.dir, '../../..');
const readme = readFileSync(resolve(ROOT, 'README.md'), 'utf8');
const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

function section(title: string): string {
  const heading = `## ${title}\n`;
  expect(readme, `README needs a ${title} section`).toContain(heading);
  return readme.split(heading)[1]!.split(/\n## /)[0]!;
}

describe('README contracts', () => {
  test('the configuration table lists exactly the production AGFLOW variables read by the hub', () => {
    const reads = new Set<string>();
    // Observe actual lookups, including the data-driven runner settings, without starting a hub.
    const env = new Proxy<Record<string, string | undefined>>({
      AGFLOW_ALLOWED_USERS: 'docs',
      AGFLOW_PROJECT_NAME: 'docs',
      AGFLOW_PROJECT_REPO: 'https://example.invalid/docs',
      GITHUB_CLIENT_ID: 'docs',
      GITHUB_CLIENT_SECRET: 'docs',
    }, {
      get(target, key: string) {
        if (key.startsWith('AGFLOW_')) reads.add(key);
        return target[key];
      },
    });
    loadConfig(env);
    reads.delete('AGFLOW_TEST');
    reads.delete('AGFLOW_TEST_CONFIG');
    const rows = section('Configuration').split('\n').filter((line) => line.startsWith('|'));
    const documented = rows.flatMap((row) => [...(row.split('|')[1] ?? '').matchAll(/\bAGFLOW_[A-Z_]+\b/g)].map(([name]) => name));
    expect(documented.sort()).toEqual([...reads].sort());
  });

  test('documents every runner subcommand in CLI HELP', () => {
    const commands = [...HELP.matchAll(/^\s+agflow runner ([a-z-]+)\b/gm)].map((match) => match[1]!);
    expect(commands.length).toBeGreaterThan(0);
    const documented = new Set([...readme.matchAll(/\bagflow runner ([a-z-]+)\b/g)].map((match) => match[1]));
    expect(commands.filter((command) => !documented.has(command))).toEqual([]);
  });

  test('the development block lists every root script and the test gates', () => {
    const development = section('Development');
    const blocks = [...development.matchAll(/```(?:bash|sh)\n([\s\S]*?)```/g)].map((match) => match[1]).join('\n');
    const commands = new Set([...blocks.matchAll(/\bbun run ([\w:-]+)\b/g)].map((match) => match[1]));
    if (/\bbun test\b/.test(blocks)) commands.add('test');
    expect(Object.keys(pkg.scripts).filter((script) => !commands.has(script))).toEqual([]);
    for (const gate of ['AGFLOW_SMOKE', 'AGFLOW_SANDBOX_CHECKS', 'AGFLOW_E2E', 'AGFLOW_TEST', 'AGFLOW_TEST_CONFIG']) {
      expect(development).toContain(gate);
    }
    expect(development).toContain(pkg.scripts['live-run']!);
    expect(development).toContain('bun run live-run --takeover claude,codex');
    expect(readme).toContain('](docs/m2-live-run.md)');
  });

  test('every relative Markdown link points to an existing file', () => {
    // Inline links/images and reference definitions; ignore code fences and URL fragments.
    const prose = readme.replace(/```[\s\S]*?```/g, '');
    const targets = [
      ...[...prose.matchAll(/!?\[[^\]\n]*\]\(<?([^\s)>]+)>?(?:\s+"[^"]*")?\)/g)].map((match) => match[1]!),
      ...[...prose.matchAll(/^\s*\[[^\]]+\]:\s*<?([^\s>]+)>?/gm)].map((match) => match[1]!),
    ];
    const relative = targets.filter((target) => !/^(?:[a-z][\w+.-]*:|\/\/|#)/i.test(target));
    expect(relative.length).toBeGreaterThan(0);
    for (const target of relative) {
      const path = decodeURIComponent(target.split(/[?#]/)[0]!);
      expect(statSync(resolve(ROOT, path), { throwIfNoEntry: false })?.isFile(), target).toBe(true);
    }
  });
});
