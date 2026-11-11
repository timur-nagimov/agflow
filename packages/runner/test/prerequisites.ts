/** Call before creating fixtures in macOS process-sweep and clone hand-back tests. */
export function requireLsofOnMacOS(
  platform: NodeJS.Platform = process.platform,
  which: (command: string) => string | null = Bun.which,
): void {
  if (platform === 'darwin' && which('lsof') === null) {
    throw new Error('macOS test prerequisite: lsof must be available on PATH (include /usr/sbin)');
  }
}
