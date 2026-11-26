import { expect, test } from 'bun:test';
import { withoutTestProcessEnv } from '../src/process-cleanup';

test('exact environment checks omit only the two process-tracker markers', () => {
  const env = {
    AGFLOW_TEST_PROCESS_SCOPE: 'scope',
    AGFLOW_TEST_PROCESS_GROUP_REGISTRY: '/tmp/registry',
    AGFLOW_TEST: '1',
    AGFLOW_TEST_PROCESS_UNEXPECTED: 'must remain visible',
    CODEX_HOME: '/tmp/codex',
    OPENAI_API_KEY: 'unexpected-test-value',
    PATH: '/usr/bin:/bin',
  };
  expect(withoutTestProcessEnv(env)).toEqual({
    AGFLOW_TEST: '1',
    AGFLOW_TEST_PROCESS_UNEXPECTED: 'must remain visible',
    CODEX_HOME: '/tmp/codex',
    OPENAI_API_KEY: 'unexpected-test-value',
    PATH: '/usr/bin:/bin',
  });
  expect(env.AGFLOW_TEST_PROCESS_SCOPE).toBe('scope');
  expect(env.AGFLOW_TEST_PROCESS_GROUP_REGISTRY).toBe('/tmp/registry');
  expect(withoutTestProcessEnv({})).toEqual({});
});
