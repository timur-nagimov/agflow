/**
 * The value for `codex -c` that trusts one repository for a single run.
 *
 * Codex splits the key of `-c key=value` on dots and keeps quote characters as part of a segment, so the usual
 * `projects."<repo>".trust_level="trusted"` names a project that does not exist. The repository then stays
 * untrusted and Codex ignores its `.codex/config.toml` and `.codex/hooks.json`. Here the key is the plain word
 * `projects` and the quoted path goes into the value, which Codex parses as TOML (checked with codex-cli 0.159.2).
 * The override replaces the `projects` table for that one run only.
 */
export function codexTrustOverride(repo: string): string {
  // A JSON string is a valid TOML basic string for any path.
  return `projects={${JSON.stringify(repo)}={trust_level="trusted"}}`;
}
