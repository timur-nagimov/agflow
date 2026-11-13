// Exact settings answers (design 6.3). Marks precede runner.json writes; local edits overlay the snapshot.
import { RunnerSettingsChangesSchema, type RunnerSettings, type SettingsAnswer } from '@agflow/core';
import {
  applySettingsEcho,
  editLocalSettings,
  isWholeSettings,
  localSettingsEdits,
  type RunnerConfig,
  type SettingsEdits,
  settingsAfterEdits,
} from './config';
import type { Logger } from './log';
import type { Outbox, SettingsEvent } from './outbox';

export interface SettingsSyncOptions {
  config(): RunnerConfig;
  /**
   * Makes config() give the new settings, then writes runner.json. config() gives them even when the write throws:
   * the runner goes on with what it holds, and the next write that succeeds brings runner.json up to it.
   */
  saveConfig(config: RunnerConfig): void;
  outbox: Outbox;
  logger: Logger;
}

const settingsOfEvents = (events: readonly SettingsEvent[]) => events.map((event) => event.data.settings);

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class SettingsSync {
  constructor(private readonly options: SettingsSyncOptions) {}

  /** The confirmed snapshot with the edits in flight laid over it: what the hub holds once it has applied them. */
  view(config: RunnerConfig = this.options.config()): RunnerSettings {
    const inFlight = this.options.outbox.settingsInFlight(config.confirmedSettings.version);
    return settingsAfterEdits(config.confirmedSettings, settingsOfEvents(inFlight));
  }

  /**
   * An update_settings echo, run one at a time in arrival order; gives false when it waits. It may answer the edits up
   * to arrivedAfter, the outbox's newest seq when it came (Outbox.markSettingsEcho).
   * - The snapshot moves one version at a time: an echo of the snapshot's version + 1 becomes it. One further ahead
   *   waits, changing nothing: a version before it has not run here yet, and the executor runs it again once that one
   *   has (CommandExecutor). One at or below the snapshot's version (the same command run again, or one that the hub's
   *   whole settings covered) only marks the edit it answers, and the snapshot stays. The hub's whole settings
   *   (hello's echoes, isWholeSettings) become the snapshot at any version not below it.
   * - The marks go first, at the echo's version, and count once the snapshot has that version: a run cut short leaves
   *   the edits in flight, and runs again when the hub sends the command again, without marking more.
   * - When runner.json's write fails, the runner holds the new settings all the same (SettingsSyncOptions.saveConfig);
   *   should it stop before a write succeeds, its next hello reports the older version and the hub sends its whole
   *   settings.
   */
  echo(
    update: { settings: SettingsEdits; version: number; answers?: SettingsAnswer },
    arrivedAfter = Number.MAX_SAFE_INTEGER,
  ): boolean {
    const { outbox, logger } = this.options;
    const config = this.options.config();
    const current = config.confirmedSettings.version;
    const whole = isWholeSettings(update.settings, config.confirmedSettings);
    // An empty refusal confirms no settings values: it cannot fill even a single missing snapshot version.
    if (!whole && update.version > current + (update.answers?.refused ? 0 : 1)) {
      logger.warn('an update_settings skips a version; it waits for the ones before it', {
        version: update.version,
        snapshot: current,
      });
      return false;
    }
    const stale = whole ? update.version < current : update.version <= current;
    const before = settingsOfEvents(outbox.settingsInFlight(current));
    const { refused } = outbox.markSettingsEcho(update.answers, update.version, arrivedAfter);
    const echo = stale ? { settings: {}, version: current } : update;
    const after = settingsOfEvents(outbox.settingsInFlight(echo.version));
    const { config: next, pending } = applySettingsEcho(config, echo, { before, after });
    this.save(next);
    for (const event of refused) {
      logger.warn("the hub refused a settings edit; runner.json takes the hub's settings", {
        seq: event.seq,
        settings: event.data.settings,
      });
    }
    if (Object.keys(pending).length > 0) {
      outbox.append({ type: 'runner.settings', data: { settings: pending, baseVersion: echo.version } });
    }
    return true;
  }

  /** saveConfig, with a failed write logged; the runner goes on with the settings config() gives. */
  private save(config: RunnerConfig): void {
    try {
      this.options.saveConfig(config);
    } catch (error) {
      this.options.logger.error('cannot write runner.json; the runner goes on with the settings it holds', {
        error: describe(error),
      });
      return;
    }
    this.options.outbox.settingsSaved(config.confirmedSettings.version);
  }

  /** Send hand edits after welcome; every retained event is replayed and the hub decides what its snapshot covers. */
  welcomed(): void {
    const { outbox } = this.options;
    const config = this.options.config();
    const settings = localSettingsEdits({ ...config, confirmedSettings: this.view(config) });
    if (Object.keys(settings).length > 0) {
      outbox.append({ type: 'runner.settings', data: { settings, baseVersion: config.confirmedSettings.version } });
    }
  }

  /**
   * A local edit (drain, undrain, the crash-loop self-drain): runner.json takes the patch, and the fields it changed
   * go out as runner.settings on the confirmed snapshot's version. runner.json holds the view, so an edit back to the
   * value an older edit in flight changed is a change, and is sent. Gives that event's seq, or null when the patch
   * changed nothing. When runner.json cannot be written, or the runner.settings cannot be stored, nothing changes and
   * the error is thrown.
   */
  change(patch: SettingsEdits): number | null {
    const current = this.options.config();
    const { config, changed } = editLocalSettings(current, RunnerSettingsChangesSchema.parse(patch));
    if (Object.keys(changed).length === 0) return null;
    try {
      this.options.saveConfig(config);
    } catch (error) {
      this.restore(current);
      throw error;
    }
    // Retention reads it, and an older one only keeps more: a failure is logged.
    try {
      this.options.outbox.settingsSaved(config.confirmedSettings.version);
    } catch (error) {
      this.options.logger.error('cannot note the version runner.json was written with', { error: describe(error) });
    }
    const baseVersion = config.confirmedSettings.version;
    try {
      return this.options.outbox.append({ type: 'runner.settings', data: { settings: changed, baseVersion } }).seq;
    } catch (error) {
      // An edit runner.json kept with no event would apply here and never reach the hub but as a hand edit.
      this.restore(current);
      throw error;
    }
  }

  /** The settings before a local edit that failed, back in config() and runner.json. */
  private restore(current: RunnerConfig): void {
    try {
      this.options.saveConfig(current);
    } catch (error) {
      // config() gives them again; runner.json keeps whatever it had, and the next write that succeeds catches it up.
      this.options.logger.warn('cannot write runner.json back after a failed edit', { error: describe(error) });
    }
  }
}
