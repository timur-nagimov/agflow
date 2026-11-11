// The CLI's credentials file (design 13): the CLI writes it at login, and the runner re-reads it to reconnect after
// one. Both parse it with this schema. Reading the file is theirs, so core stays free of file access.
import { z } from 'zod';

/** The file's name in the CLI's config directory. */
export const CREDENTIALS_FILE = 'credentials.json';

/**
 * A missing or empty field fails the parse, and readers take that as signed out. Keys it does not know are dropped,
 * not refused, so a file a newer CLI wrote still signs an older reader in.
 */
export const CredentialsSchema = z.object({
  hubUrl: z.string().min(1),
  token: z.string().min(1),
  user: z.string().min(1),
});
export type Credentials = z.output<typeof CredentialsSchema>;
