// The project's dependency-preparation config (design 7.7): `.agflow/config.json`, a people-only file, read from the
// vault at the restore base (X-16) and never from the clone, whose working tree the agent controls.
import { z } from 'zod';
import { runGit } from '../git/run';
import type { Vault } from '../git/vault';

const CONFIG_PATH = '.agflow/config.json';
const MAX_CONFIG_BYTES = 1024 * 1024;
const WhenPath = z
  .string()
  .refine(
    (path) =>
      !/[\\\0]/.test(path) &&
      !/^[A-Za-z]:/.test(path) &&
      path.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
    { error: 'when paths must be normalized relative POSIX paths' },
  );

export const PrepConfigSchema = z.strictObject({
  dependencies: z.array(
    z.strictObject({
      run: z
        .array(
          z
            .string()
            .min(1)
            .refine((arg) => !arg.includes('\0'), { error: 'argv must not contain NUL' }),
        )
        .min(1),
      // Empty means once per attempt and entry configuration.
      when: z.array(WhenPath),
      scripts: z.boolean().default(false),
    }),
  ),
});

export type PrepConfig = z.output<typeof PrepConfigSchema>;

/** Read only the restore base in the vault; no config in an agent's work tree is authoritative. */
export async function readPrepConfig(vault: Vault, baseSha: string): Promise<PrepConfig | null> {
  try {
    if (!/^[a-f0-9]{40}$/.test(baseSha)) throw new Error('expected a full restore-base commit sha');
    const git = async (args: string[]) => (await runGit(vault.local, ['--git-dir', vault.path, ...args])).stdout;
    const entry = await git(['ls-tree', '-z', baseSha, '--', CONFIG_PATH]);
    if (entry === '') return null;
    const match = entry.match(/^(100644|100755) blob ([a-f0-9]{40})\t\.agflow\/config\.json\0$/);
    if (!match) throw new Error('must be a regular file');
    const oid = match[2]!;
    const size = Number((await git(['cat-file', '-s', oid])).trim());
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_CONFIG_BYTES) {
      throw new Error(`exceeds the ${MAX_CONFIG_BYTES}-byte size limit`);
    }
    const parsed = PrepConfigSchema.safeParse(JSON.parse(await git(['cat-file', 'blob', oid])));
    if (!parsed.success) {
      throw new Error(
        parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; '),
      );
    }
    return parsed.data;
  } catch (error) {
    throw new Error(`${CONFIG_PATH}: ${(error as Error).message}`, { cause: error });
  }
}
