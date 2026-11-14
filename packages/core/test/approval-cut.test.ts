import { describe, expect, test } from 'bun:test';
import { APPROVAL_CLIPPED_MARK, approvalFieldCut, approvalTruncatedMark } from '../src/approval-cut';

describe('approvalFieldCut', () => {
  test("recognises both of the runner's marks, at the end", () => {
    expect(approvalFieldCut(`add src/a.json\n+{}${approvalTruncatedMark(71805)}`)).toBe(true);
    expect(approvalFieldCut(`npm ci${APPROVAL_CLIPPED_MARK}`)).toBe(true);
    // The pump cuts after the adapter: whichever mark ends the field, it reads as cut.
    expect(approvalFieldCut(`x${approvalTruncatedMark(9)}`.slice(0, 5) + APPROVAL_CLIPPED_MARK)).toBe(true);
  });

  test('a whole field reads as whole, and a mark that is not at the end is only text', () => {
    expect(approvalFieldCut('npm ci')).toBe(false);
    expect(approvalFieldCut('')).toBe(false);
    expect(approvalFieldCut(`echo "${approvalTruncatedMark(5)}" && npm ci`)).toBe(false);
    expect(approvalFieldCut('see [clipped] below')).toBe(false);
  });
});
