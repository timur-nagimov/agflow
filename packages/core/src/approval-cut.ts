/**
 * How the runner marks a field of an approval's detail that it cut short, and how the hub recognises one (design
 * 6.10, Rules). The runner cuts what an agent asks to run or write so that one request cannot fill its outbox; the
 * hub's rules must then never judge the part they were shown as if it were the whole, because the runner relays the
 * whole request to the vendor once it is approved. Both sides read the marks from here, so a change to one is a
 * change to both.
 */

/** The mark the vendor adapter appends when it cuts a field: the full size in bytes. */
export function approvalTruncatedMark(totalBytes: number): string {
  return `\n[truncated: ${totalBytes} bytes in total]`;
}

/** The mark the runner's event pump appends when a field's JSON is still over its limit. */
export const APPROVAL_CLIPPED_MARK = '\n[clipped]';

const TRUNCATED_TAIL = /\n\[truncated: \d+ bytes in total\]$/;

/**
 * Whether a field of an approval's detail ends in one of the runner's cut marks. A mark is only ever appended at the
 * end, and an agent that writes one itself only makes its own request count as cut: the reading fails closed.
 */
export function approvalFieldCut(text: string): boolean {
  return text.endsWith(APPROVAL_CLIPPED_MARK) || TRUNCATED_TAIL.test(text);
}
