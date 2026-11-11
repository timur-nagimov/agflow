// hand_back (design 6.12 Hand back, 7.3 Late work, X-37, X-2). With the clone source, the runner first stops the
// runner-home Codex daemon a person's `codex resume` may have left (errors ignored), and refuses while any process
// still runs in the clone: { ok: false, error: 'process_running' } with the pids, and an attempt.activity note, so
// the person can end it and hand back again; when it cannot look (no lsof), it refuses too. Otherwise it harvests
// the clone, the person's commits and uncommitted work, strips and checks it like a WIP (violations report phase
// wip), pushes it to a new late-work ref, reports attempt.handed_back and cleans the attempt up. A ref source, which
// protocol-1 hubs never send, only fetches the ref into the vault and answers ok, with no event.
import { boundedWait } from '../processes';

/** How long the Codex daemon's stop may take before it is killed. */
export const DAEMON_STOP_MS = 10_000;

export type HandBackSource = { kind: 'clone' } | { kind: 'ref'; ref: string; sha: string };

/**
 * What hand_back gives: the late-work ref the clone's work went to (null for a ref source); a process still in the
 * clone, with its pids; or why the hand-back failed, with the clone kept.
 */
export type HandBackOutcome =
  | { ok: true; handedBack: { ref: string; sha: string } | null }
  | { ok: false; error: 'process_running'; pids: number[] }
  | { ok: false; error: string };

/** The activity note of a hand-back refused for processes still running in the clone. */
export function processRunningNote(pids: readonly number[]): string {
  return `hand-back refused: processes still run in the clone (pids ${pids.join(', ')}); end them and hand back again`;
}

/**
 * Stops the Codex daemon of the runner's Codex home: `CODEX_HOME=<home> <codex> app-server daemon stop`, bounded by
 * DAEMON_STOP_MS. Whatever happens, a missing binary or a failed stop, is no error: there may be no daemon at all.
 */
export async function stopCodexDaemon(input: {
  binary: string;
  home: string;
  /** The rest of the environment: the runner's captured PATH and the codex-user HOME. */
  env: Record<string, string>;
  timeoutMs?: number;
}): Promise<void> {
  let proc: Bun.Subprocess;
  try {
    proc = Bun.spawn([input.binary, 'app-server', 'daemon', 'stop'], {
      env: { ...input.env, CODEX_HOME: input.home },
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    });
  } catch {
    return;
  }
  const exited = await boundedWait(proc.exited, input.timeoutMs ?? DAEMON_STOP_MS);
  if (!exited.done) proc.kill('SIGKILL');
}
