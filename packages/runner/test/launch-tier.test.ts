import { describe, expect, test } from 'bun:test';
import { resolveModel } from '../src/attempt/launch';
import { RunnerConfigSchema } from '../src/config';

const config = RunnerConfigSchema.parse({
  runnerKey: 'runner-key-test',
  machineId: 'machine-test',
  name: 'test runner',
  models: {
    claude: { lead: 'claude-lead-model', worker: 'claude-worker-model' },
    codex: { lead: 'codex-lead-model', worker: 'codex-worker-model' },
  },
});

describe("the runner's model choice", () => {
  test("a strong task runs on runner.json's lead model for its vendor", () => {
    const strong = { model: null, role: 'worker', tier: 'strong' } as const;
    expect(resolveModel({ ...strong, vendor: 'claude' }, config)).toBe('claude-lead-model');
    expect(resolveModel({ ...strong, vendor: 'codex' }, config)).toBe('codex-lead-model');
  });

  test("a standard task, or one from a hub that sends no tier, runs on its role's model", () => {
    expect(resolveModel({ model: null, vendor: 'claude', role: 'worker', tier: 'standard' }, config)).toBe(
      'claude-worker-model',
    );
    expect(resolveModel({ model: null, vendor: 'codex', role: 'worker' }, config)).toBe('codex-worker-model');
    expect(resolveModel({ model: null, vendor: 'claude', role: 'lead' }, config)).toBe('claude-lead-model');
  });

  test('a model the hub names is used as it is, whatever the tier', () => {
    expect(resolveModel({ model: 'gpt-test-model', vendor: 'codex', role: 'worker', tier: 'strong' }, config)).toBe(
      'gpt-test-model',
    );
  });
});
