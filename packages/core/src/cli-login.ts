/** A short code shown both in the terminal and on the approval page, so people approve only their own sign-in. */
export function verificationCode(code: string): string {
  const head = code.slice(0, 8).toUpperCase();
  return `${head.slice(0, 4)}-${head.slice(4, 8)}`;
}
