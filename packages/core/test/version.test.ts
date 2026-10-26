import { expect, test } from 'bun:test';
import { AGFLOW_VERSION } from '../src/index';

test('core exposes a semver version', () => {
  expect(AGFLOW_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
});
