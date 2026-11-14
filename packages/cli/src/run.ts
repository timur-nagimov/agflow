// Runs the tools agflow start needs (git, gh, curl, pdftotext, textutil, security) with an environment the caller
// gives, so tests can name their own tools and git configuration.

/** What a command run gives back. */
export interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  env?: Record<string, string | undefined>;
  input?: string;
  cwd?: string;
}

/** Runs a command with the given environment and standard input; a program that cannot start gives code 127. */
export type RunCommand = (argv: string[], options?: RunOptions) => Ran;

export const runCommand: RunCommand = (argv, options = {}) => {
  try {
    const env = options.env ?? process.env;
    const result = Bun.spawnSync(argv, {
      env: env as Record<string, string>,
      cwd: options.cwd,
      stdin: options.input === undefined ? 'ignore' : new TextEncoder().encode(options.input),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return { code: result.exitCode ?? 1, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  } catch (error) {
    return { code: 127, stdout: '', stderr: error instanceof Error ? error.message : String(error) };
  }
};
