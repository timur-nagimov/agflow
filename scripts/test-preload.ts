import { afterAll, afterEach, beforeEach } from 'bun:test';
import {
  beginTestProcessScope, cleanupTestProcesses, installProcessExitCleanup, installProcessTracking,
} from '../packages/testkit/src/process-cleanup';

// Tests create throwaway git repositories and run git in them. A GIT_DIR, GIT_WORK_TREE or similar variable inherited
// from the caller (a git hook, `git rebase --exec`) would point those commands at the real repository instead: they would
// commit to it, re-initialise it as bare and push it. So the test process drops every GIT_* variable before any test runs.
for (const name of Object.keys(process.env)) {
  if (name.startsWith('GIT_')) delete process.env[name];
}

// Covers every Bun spawn/serve in tests, including production helpers called by a test. Child Bun programs carry
// the ownership marker through deliberately clean environments; their normal exit/crash behavior stays intact.
installProcessTracking();
installProcessExitCleanup();
beforeEach(beginTestProcessScope);
afterEach(() => cleanupTestProcesses());
afterAll(() => cleanupTestProcesses(true));
