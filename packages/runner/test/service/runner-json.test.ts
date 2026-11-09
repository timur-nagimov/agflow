import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRunnerConfig, type RunnerConfigInput, RunnerConfigSchema, saveRunnerConfig } from '../../src/config';
import { runnerPaths } from '../../src/paths';
import { canonicalHome } from '../../src/service/machine';
import { createRunnerConfig, newRunnerKey, type RunnerFacts } from '../../src/service/runner-json';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const facts: RunnerFacts = {
  machineId: 'MACHINE-1',
  name: 'Owner’s Mac',
  capturedPath: '/owner/bin:/usr/bin',
  connectivity: { HTTPS_PROXY: 'http://localhost:9000' },
  commitIdentity: { name: 'Owner', email: 'owner@example.test' },
  homes: { claude: '/runner/homes/claude', codex: '/runner/homes/codex' },
};

describe('createRunnerConfig', () => {
  test('uses facts, generates a fresh key and leaves other fields to the schema defaults', () => {
    expect(newRunnerKey()).toMatch(/^rk_[0-9a-f]{32}$/);
    const config = createRunnerConfig(facts);
    expect(config.runnerKey).toMatch(/^rk_[0-9a-f]{32}$/);
    expect(createRunnerConfig(facts).runnerKey).not.toBe(config.runnerKey);
    expect(config).toEqual(RunnerConfigSchema.parse({ ...facts, runnerKey: config.runnerKey }));
    expect(config).toMatchObject(facts);
    expect(createRunnerConfig({ ...facts, commitIdentity: null }).commitIdentity).toEqual({
      name: 'agflow agent',
      email: 'agent@agflow.invalid',
    });
  });

  test('accepts schema input overrides for the harness, including nested defaults and a retained key', () => {
    const overrides: Partial<RunnerConfigInput> = {
      runnerKey: 'rk_retained',
      machineId: 'MACHINE-2',
      name: 'harness',
      minFreeGb: 1,
      capacity: 1,
      keepAwake: 'off',
      timings: { heartbeat: 10 },
      test: { allowShortTimings: true },
      capturedPath: '/harness/bin',
      connectivity: {},
      commitIdentity: { name: 'Test', email: 'test@example.test' },
      homes: { claude: '/test/claude', codex: '/test/codex' },
    };
    const config = createRunnerConfig(facts, overrides);
    expect(config).toMatchObject(overrides);
    expect(config.confirmedSettings.capacity).toBe(1);
    expect(config.timings.deadLink).toBe(45_000);
    expect(config.test?.skipAuthChecks).toBe(false);
    // A complete config is also a valid override; no field is selected out by the builder.
    expect(createRunnerConfig(facts, config)).toEqual(config);
  });

  test('invalid overrides name the field, including unknown credential fields', () => {
    expect(() => createRunnerConfig(facts, { capacity: 0 })).toThrow('runner.json: capacity:');
    expect(() => createRunnerConfig(facts, { timings: { heartbeat: -1 } })).toThrow('runner.json: timings.heartbeat:');
    expect(() => createRunnerConfig(facts, { token: 'secret' } as Partial<RunnerConfigInput>)).toThrow(
      'runner.json: token:',
    );
  });

  test.each(['claude', 'codex'] as const)(
    'refuses symlinked %s homes, including missing descendants',
    (vendor) => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'agf-json-')));
      dirs.push(root);
      const real = join(root, 'real');
      const link = join(root, 'link');
      mkdirSync(real);
      symlinkSync(real, link);
      for (const suffix of ['', 'not/created']) {
        const home = join(link, suffix);
        const homes = { ...facts.homes, [vendor]: home };
        const message = `runner.json: homes.${vendor}: must be a real path (${join(real, suffix)})`;
        expect(() => createRunnerConfig({ ...facts, homes })).toThrow(message);
        expect(() => createRunnerConfig(facts, { homes })).toThrow(message);
        expect(createRunnerConfig(facts, { homes: { [vendor]: join(real, suffix) } }).homes[vendor]).toBe(join(real, suffix));
      }
      expect(createRunnerConfig(facts, { homes: { [vendor]: null } }).homes[vendor]).toBeNull();
    },
  );

  test('writes canonical homes and a secret-free runner.json at mode 0600 using saveRunnerConfig', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agf-json-'));
    dirs.push(dir);
    const paths = runnerPaths(dir);
    const homes = { claude: canonicalHome(paths.homes.claude), codex: canonicalHome(paths.homes.codex) };
    canonicalHome(paths.homes.codexUser);
    const config = createRunnerConfig({ ...facts, homes });
    saveRunnerConfig(paths.config, config);
    expect(statSync(paths.config).mode & 0o777).toBe(0o600);
    expect(loadRunnerConfig(paths.config, {})).toEqual(config);
    const written = readFileSync(paths.config, 'utf8');
    expect(written).not.toMatch(/"[^"\n]*(?:token|credential)[^"\n]*"\s*:/i);
    expect(written.endsWith('\n')).toBe(true);
  });
});
