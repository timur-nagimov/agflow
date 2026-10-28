import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_WIP_REF_PREFIX,
  attemptId,
  attemptSuffix,
  branchEpoch,
  isTaskBranch,
  isValidWipRefPrefix,
  lateWorkRef,
  leadAttemptId,
  localPinRefs,
  parseAttemptId,
  slugify,
  takeoverAnywhereCommand,
  takeoverRef,
  taskBranchName,
  taskRefGlob,
  wipRef,
} from '../src/naming';

describe('attempt ids', () => {
  test('name the task and the attempt number, and the epoch from epoch 2', () => {
    expect(attemptId('T-42', 3, 1)).toBe('T-42-a3');
    expect(attemptId('T-42', 3, 2)).toBe('T-42-e2-a3');
    expect(leadAttemptId(5, 1)).toBe('lead-a5');
    expect(leadAttemptId(5, 2)).toBe('lead-e2-a5');
  });

  test('parseAttemptId round-trips every form', () => {
    expect(parseAttemptId('T-42-a3')).toEqual({ taskId: 'T-42', number: 3, epoch: 1 });
    expect(parseAttemptId('T-42-e2-a3')).toEqual({ taskId: 'T-42', number: 3, epoch: 2 });
    expect(parseAttemptId('lead-a5')).toEqual({ taskId: null, number: 5, epoch: 1 });
    expect(parseAttemptId('lead-e2-a5')).toEqual({ taskId: null, number: 5, epoch: 2 });
    for (const id of ['T-42-a3', 'T-42-e2-a3', 'lead-a5', 'lead-e2-a5', 'T-1043-e12-a10']) {
      const parts = parseAttemptId(id);
      if (!parts) throw new Error(`${id} did not parse`);
      const again = parts.taskId ? attemptId(parts.taskId, parts.number, parts.epoch) : leadAttemptId(parts.number, parts.epoch);
      expect(again).toBe(id);
    }
  });

  test('parseAttemptId refuses anything else', () => {
    const others = [
      '',
      'T-42',
      'T-42-',
      'T-42-a',
      'T-42-a0',
      'T-42-a03',
      'T-42-A3',
      'T-42-e2',
      // Epoch 1 has no marker, so each attempt has exactly one id.
      'T-42-e1-a3',
      'T-42-e0-a3',
      'T-42-e02-a3',
      'T-42-a3-late-1',
      'T-42/a3',
      'T42-a3',
      'x-a3',
      ' T-42-a3',
      'T-42-a3\n',
      'T-42-a99999999999999999999',
      'lead',
      'lead-5',
      'Lead-a5',
      'lead-e1-a5',
    ];
    for (const id of others) expect([id, parseAttemptId(id)]).toEqual([id, null]);
  });

  test('attemptSuffix is the part after the task id or "lead-"', () => {
    expect(attemptSuffix('T-42-a3')).toBe('a3');
    expect(attemptSuffix('T-42-e2-a3')).toBe('e2-a3');
    expect(attemptSuffix('lead-e2-a5')).toBe('e2-a5');
  });

  test('come only from task ids and positive whole numbers', () => {
    expect(() => attemptId('T-42', 0, 1)).toThrow('positive whole number');
    expect(() => attemptId('T-42', 3, 0)).toThrow('positive whole number');
    expect(() => attemptId('T-42', 1.5, 1)).toThrow('positive whole number');
    expect(() => leadAttemptId(-1, 1)).toThrow('positive whole number');
    expect(() => attemptId('42', 3, 1)).toThrow('not a task id');
    expect(() => attemptSuffix('T-42')).toThrow('not an attempt id');
  });
});

describe('refs', () => {
  const prefix = DEFAULT_WIP_REF_PREFIX;

  test('the default prefix is refs/agflow/', () => {
    expect(prefix).toBe('refs/agflow/');
  });

  test('a WIP ref sits under its task, named by the attempt suffix', () => {
    expect(wipRef(prefix, 'T-42-a3')).toBe('refs/agflow/T-42/a3');
    expect(wipRef(prefix, 'T-42-e2-a3')).toBe('refs/agflow/T-42/e2-a3');
    expect(wipRef('refs/heads/agflow-wip/', 'T-42-a3')).toBe('refs/heads/agflow-wip/T-42/a3');
  });

  test('late work goes to new refs beside the WIP ref, numbered from 1', () => {
    expect(lateWorkRef(prefix, 'T-42-a3', 1)).toBe('refs/agflow/T-42/a3-late-1');
    expect(lateWorkRef(prefix, 'T-42-e2-a3', 2)).toBe('refs/agflow/T-42/e2-a3-late-2');
    expect(() => lateWorkRef(prefix, 'T-42-a3', 0)).toThrow('positive whole number');
  });

  test('a take-over ref is per task and person, and the task glob covers every ref of the task', () => {
    expect(takeoverRef(prefix, 'T-42', 'timur')).toBe('refs/agflow/T-42/takeover-timur');
    expect(taskRefGlob(prefix, 'T-42')).toBe('refs/agflow/T-42/*');
    const refs = [wipRef(prefix, 'T-42-e2-a3'), lateWorkRef(prefix, 'T-42-a3', 4), takeoverRef(prefix, 'T-42', 'timur')];
    for (const ref of refs) expect(ref.startsWith(taskRefGlob(prefix, 'T-42').slice(0, -1))).toBe(true);
    expect(wipRef(prefix, 'T-420-a1').startsWith(taskRefGlob(prefix, 'T-42').slice(0, -1))).toBe(false);
  });

  test('local pins are per attempt, outside the WIP prefix, for leads too', () => {
    expect(localPinRefs('T-42-a3')).toEqual({ start: 'refs/agflow-local/T-42-a3/start', head: 'refs/agflow-local/T-42-a3/head' });
    expect(localPinRefs('lead-e2-a5')).toEqual({
      start: 'refs/agflow-local/lead-e2-a5/start',
      head: 'refs/agflow-local/lead-e2-a5/head',
    });
  });

  test('are made only from well-formed parts', () => {
    expect(() => wipRef(prefix, 'lead-a5')).toThrow('lead attempts have no WIP refs');
    expect(() => wipRef(prefix, 'T-42-a3/../x')).toThrow('not an attempt id');
    expect(() => wipRef('refs/agflow', 'T-42-a3')).toThrow('not a WIP ref prefix');
    expect(() => taskRefGlob(prefix, 'T-42/*')).toThrow('not a task id');
    expect(() => localPinRefs('../T-42-a3')).toThrow('not an attempt id');
    for (const login of ['', 'a b', 'x..y', 'a/b', 'x.lock', 'x.', '~x']) {
      expect(() => takeoverRef(prefix, 'T-42', login)).toThrow('cannot name a ref');
    }
  });
});

describe('the WIP ref prefix', () => {
  test('accepts a namespace under refs/ that ends with a slash', () => {
    for (const prefix of ['refs/agflow/', 'refs/heads/agflow-wip/', 'refs/agflow/wip/']) {
      expect([prefix, isValidWipRefPrefix(prefix)]).toEqual([prefix, true]);
    }
  });

  test('refuses prefixes outside refs/, without a trailing slash, or with parts git refuses', () => {
    const refused = [
      '',
      'refs/agflow',
      'agflow/',
      'heads/agflow/',
      '/refs/agflow/',
      'refs/',
      'refs//',
      'refs/agflow//',
      'refs/../x/',
      'refs/.hidden/',
      'refs/a b/',
      'refs/a:b/',
      'refs/a*/',
      'refs/x.lock/',
      // A runner's local pins own this namespace.
      'refs/agflow-local/',
      'refs/agflow-local/wip/',
    ];
    for (const prefix of refused) expect([prefix, isValidWipRefPrefix(prefix)]).toEqual([prefix, false]);
  });
});

describe('task branches', () => {
  test('a task branch carries the epoch from epoch 2', () => {
    expect(taskBranchName('T-42', 'Add the parser', 1)).toBe('agflow/T-42-add-the-parser');
    expect(taskBranchName('T-42', 'Add the parser', 2)).toBe('agflow/T-42-e2-add-the-parser');
    expect(() => taskBranchName('T-42', 'Add the parser', 0)).toThrow('positive whole number');
  });

  test('isTaskBranch accepts both forms for its task, and nothing else', () => {
    expect(isTaskBranch('T-42', 'agflow/T-42-add-the-parser')).toBe(true);
    expect(isTaskBranch('T-42', 'agflow/T-42-e2-add-the-parser')).toBe(true);
    for (const other of ['agflow/T-420-x', 'agflow/T-4-x', 'agflow/T-42', 'production', 'feature/T-42-x', 'T-42-x', null, undefined]) {
      expect([other, isTaskBranch('T-42', other)]).toEqual([other, false]);
    }
  });

  test('branchEpoch reads the epoch of a task branch', () => {
    expect(branchEpoch('agflow/T-42-e2-fix')).toBe(2);
    expect(branchEpoch('agflow/T-42-e12-fix')).toBe(12);
    expect(branchEpoch('agflow/T-42-fix')).toBe(1);
    expect(branchEpoch('main')).toBeNull();
    expect(branchEpoch('agflow/fix')).toBeNull();
  });

  test('branchEpoch reads only the markers taskBranchName writes', () => {
    // M1 named branches like these in epoch 1, from titles such as "E02: parser" or "E2".
    const unmarked = [
      'agflow/T-42-e2e-tests',
      'agflow/T-42-e0-x',
      'agflow/T-42-e1-x',
      'agflow/T-42-e02-x',
      'agflow/T-42-e2',
      'agflow/T-42-e99999999999999999999-x',
    ];
    for (const branch of unmarked) expect([branch, branchEpoch(branch)]).toEqual([branch, 1]);
  });

  test('a title that starts like an epoch marker gets a "t-" prefix, so its branch is never misread', () => {
    expect(slugify('E2 tests')).toBe('t-e2-tests');
    expect(slugify('e12')).toBe('t-e12');
    expect(slugify('E2E tests')).toBe('e2e-tests');
    expect(taskBranchName('T-42', 'E2 tests', 1)).toBe('agflow/T-42-t-e2-tests');
    expect(taskBranchName('T-42', 'E2 tests', 2)).toBe('agflow/T-42-e2-t-e2-tests');
    for (const title of ['E2 tests', 'e12', 'E7', 'E2E tests', 'Fix it']) {
      for (const epoch of [1, 2, 3]) {
        const branch = taskBranchName('T-42', title, epoch);
        expect([branch, branchEpoch(branch)]).toEqual([branch, epoch]);
      }
    }
  });

  test('slugify makes short branch-safe names', () => {
    expect(slugify('Add OAuth 2.0 login (GitHub)!')).toBe('add-oauth-2-0-login-github');
    expect(slugify('***')).toBe('task');
    expect(slugify('x'.repeat(80))).toHaveLength(40);
    expect(slugify(`E2 ${'x'.repeat(80)}`)).toHaveLength(40);
  });
});

describe('the take-over command for anywhere', () => {
  const refs = { ref: 'refs/agflow/T-42/a3', branch: 'agflow/T-42-x', takeoverRef: 'refs/agflow/T-42/takeover-timur' };

  test('fetches the work onto the task branch, then pushes to the take-over ref on its own line', () => {
    expect(takeoverAnywhereCommand(refs)).toBe(
      'git fetch origin refs/agflow/T-42/a3 && git switch -c agflow/T-42-x FETCH_HEAD\n' +
        'git push origin HEAD:refs/agflow/T-42/takeover-timur',
    );
  });

  test('quotes what a shell would read as syntax, and refuses what git would read as an option', () => {
    const quoted = takeoverAnywhereCommand({ ...refs, ref: "refs/agflow/T-42/a3;rm -rf ~'" });
    expect(quoted.split('\n')[0]).toBe(
      "git fetch origin 'refs/agflow/T-42/a3;rm -rf ~'\\''' && git switch -c agflow/T-42-x FETCH_HEAD",
    );
    expect(() => takeoverAnywhereCommand({ ...refs, ref: '--upload-pack=touch /tmp/x' })).toThrow('read as an option');
    expect(() => takeoverAnywhereCommand({ ...refs, branch: '-f' })).toThrow('read as an option');
  });
});
