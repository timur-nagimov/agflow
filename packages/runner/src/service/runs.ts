// Service history (design 7.1, X-41). Only the runner.lock holder may call the mutating methods;
// status readers need no lock because every update replaces a complete file atomically.
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { RunnerPaths } from '../paths';
import type { RunnerMode } from './lock';

const Time = z.number().int().nonnegative();
const RunningSchema = z.strictObject({
  id: z.string().min(1),
  pid: z.number().int().positive(),
  mode: z.enum(['foreground', 'service']),
  startedAt: Time,
});
const FinishedSchema = RunningSchema.extend({
  endedAt: Time,
  clean: z.boolean(),
  code: z.number().int().nullable(),
  reason: z.string().refine((reason) => !/[\r\n]/.test(reason), { error: 'reason must be one line' }),
  uncleanForgotten: z.boolean().optional(),
});
const ServiceRunSchema = z.union([RunningSchema, FinishedSchema]);
const CrashLoopSchema = z.strictObject({ at: Time, lastError: z.string().nullable() });
const HistorySchema = z.strictObject({
  runs: z.array(ServiceRunSchema).max(50),
  /** Set when the guard trips; it outlives the window and clean runs, until undrain (X-41). */
  crashLoop: CrashLoopSchema.optional(),
});

/** All timestamps are wall-clock epoch milliseconds. */
export type ServiceRun = z.output<typeof ServiceRunSchema>;
type FinishedRun = z.output<typeof FinishedSchema>;
type History = z.output<typeof HistorySchema>;

/** The last exit status reports while the runner is down. */
export interface LastExit {
  reason: string;
  /** null when an abrupt exit was detected later, without an observed exit code. */
  code: number | null;
  /** For a run that died without an exit record, its start: the exit time is unknown. */
  at: number;
  clean: boolean;
}

function finished(run: ServiceRun): run is FinishedRun {
  return 'endedAt' in run;
}

function newest(runs: readonly FinishedRun[]): FinishedRun | undefined {
  return runs.reduce<FinishedRun | undefined>(
    (last, run) => (!last || run.endedAt >= last.endedAt ? run : last),
    undefined,
  );
}

const ABANDONED = 'exited without a clean shutdown';

/** A run with no exit record whose process is gone: SIGKILL, OOM or power loss leave no time or exit code. */
function abandoned(run: ServiceRun, at: number): FinishedRun {
  return finished(run) ? run : { ...run, endedAt: at, clean: false, code: null, reason: ABANDONED };
}

export class ServiceRuns {
  readonly path: string;
  private readonly now: () => number;
  /** The run this process started; every other run without an exit record belongs to a dead process. */
  private current: string | undefined;

  constructor(
    private readonly paths: RunnerPaths,
    options: { now?: () => number } = {},
  ) {
    this.path = join(paths.logs, 'service-runs.json');
    this.now = options.now ?? Date.now;
  }

  /** Read afresh so a status reader also works across service restarts and undrain. */
  records(): ServiceRun[] {
    return this.history().runs;
  }

  /** The crash loop the guard recorded, if undrain has not cleared it yet. */
  crashLoop(): { at: number; lastError: string | null } | null {
    return this.history().crashLoop ?? null;
  }

  private history(): History {
    let text: string;
    try {
      text = readFileSync(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { runs: [] };
      throw error;
    }
    try {
      return HistorySchema.parse(JSON.parse(text));
    } catch {
      // Corrupt history must not prevent a start; the next writer replaces it with fresh history.
      return { runs: [] };
    }
  }

  /** Records this process's run; an earlier run without an exit record counts as unclean from now on. */
  start(input: { pid: number; mode: RunnerMode }): string {
    const at = this.now();
    const run = RunningSchema.parse({ ...input, id: randomUUID(), startedAt: at });
    const history = this.history();
    // The exit time is the detection time, the earliest moment it is known.
    const runs = history.runs.map((previous) => abandoned(previous, at));
    this.save({ ...history, runs: [...runs, run] });
    this.current = run.id;
    return run.id;
  }

  finish(id: string, exit: { clean: boolean; code: number; reason: string }): void {
    const history = this.history();
    const runs = history.runs;
    const index = runs.findIndex((run) => run.id === id);
    const run = runs[index];
    if (!run) throw new Error(`unknown service run: ${id}`);
    if (finished(run)) throw new Error(`service run already finished: ${id}`);
    runs[index] = FinishedSchema.parse({
      ...run,
      ...exit,
      reason: exit.reason.replace(/[\r\n]+/g, ' '),
      endedAt: this.now(),
    });
    this.save(history);
  }

  /** The guard tripped: crash_loop now lasts until undrain, even through clean runs and past the window. */
  markCrashLoop(verdict: { lastError: string | null }): void {
    const history = this.history();
    this.save({ ...history, crashLoop: { at: this.now(), lastError: verdict.lastError } });
  }

  /**
   * undrain (X-41): the earlier unclean exits stop counting and the recorded crash loop clears. A dead run without an
   * exit record is closed first, so an undrain while the runner is down also forgets a crash the next start would
   * otherwise detect. `current` is the live run's id; an instance other than the one that started it must pass it.
   */
  forgetUnclean(options: { at?: number; current?: string } = {}): void {
    const at = Time.parse(options.at ?? this.now());
    const current = options.current ?? this.current;
    const runs = this.records().map((run) => (run.id === current ? run : abandoned(run, at)));
    // Mark existing exits, so a later crash in the same millisecond still counts after undrain.
    this.save({
      runs: runs.map((run) =>
        finished(run) && !run.clean && run.endedAt <= at ? { ...run, uncleanForgotten: true } : run,
      ),
    });
  }

  /**
   * The newest exit. While the runner is down (`running` false, from readLockOwner) a newest run without an exit
   * record died without a clean shutdown, and it is newer than every recorded exit.
   */
  lastExit(options: { running: boolean }): LastExit | null {
    const runs = this.records();
    const latest = runs.at(-1);
    if (!options.running && latest && !finished(latest)) {
      return { reason: ABANDONED, code: null, at: latest.startedAt, clean: false };
    }
    const run = newest(runs.filter(finished));
    return run ? { reason: run.reason, code: run.code, at: run.endedAt, clean: run.clean } : null;
  }

  private save(input: History): void {
    const history = HistorySchema.parse({ ...input, runs: input.runs.slice(-50) });
    mkdirSync(this.paths.logs, { recursive: true, mode: 0o700 });
    const temporary = join(this.paths.logs, `.service-runs.json.${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, `${JSON.stringify(history, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      chmodSync(temporary, 0o600);
      renameSync(temporary, this.path);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}

export const CRASH_LOOP_EXITS = 3;

/**
 * The crash-loop guard (design 7.1): 3 unclean exits within crashLoopWindow, unless undrain forgot them. A crash loop
 * recorded with markCrashLoop holds whatever the window says; a bare array of runs carries no such record.
 */
export function crashLoopVerdict(
  runs: ServiceRuns | readonly ServiceRun[],
  options: { now: number; window: number },
): { crashLoop: boolean; unclean: number; lastError: string | null } {
  const records = runs instanceof ServiceRuns ? runs.records() : runs;
  const marked = runs instanceof ServiceRuns ? runs.crashLoop() : null;
  const unclean = records
    .filter(finished)
    .filter(
      (run) =>
        !run.clean && !run.uncleanForgotten && run.endedAt > options.now - options.window && run.endedAt <= options.now,
    );
  return {
    crashLoop: marked !== null || unclean.length >= CRASH_LOOP_EXITS,
    unclean: unclean.length,
    lastError: newest(unclean)?.reason ?? marked?.lastError ?? null,
  };
}
