// Settings sync on the runner (design 6.3, "Settings sync"; X-12). runner.json holds the settings and the snapshot
// the hub confirmed last; local edits go out as runner.settings, which the hub applies in seq order whatever their
// base, each at a new version, and echoes verbatim with update_settings, as it echoes the owner's edits.
// - In flight: a runner.settings is in flight until an echo answers it (Outbox.markSettingsEcho) and runner.json's
//   snapshot has that echo's version. runner.json holds the snapshot with the edits in flight laid over it (the
//   view), so a local edit back to an earlier value differs from it and is sent.
// - An echo becomes the snapshot. runner.json takes the new view, but where it differs from the view before the echo
//   (an edit made by other means), which is kept and sent again. An echo answers only edits made before it came.
// - Versions: the snapshot moves one version at a time, or to the hub's whole settings; an echo that would skip a
//   version waits for the ones before it (CommandExecutor), and one the snapshot already covers only marks. A failed
//   write of runner.json leaves the echo in the settings the runner holds.
// - Refusals: the hub acknowledges an edit it refuses and never echoes it. A probe (isSettingsProbe) settles which
//   acknowledged edits will get no echo: at its echo, every older edit still unanswered was refused, and runner.json
//   falls back to the hub's value for it. Nothing is ever sent again for a refused edit.
import type { RunnerSettings } from '@agflow/core';
import {
  applySettingsEcho,
  isWholeSettings,
  type RunnerConfig,
  type SettingsEdits,
  settingsAfterEdits,
} from './config';
import type { Logger } from './log';
import { isSettingsProbe, type Outbox, type SettingsEvent } from './outbox';

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
  echo(update: { settings: SettingsEdits; version: number }, arrivedAfter = Number.MAX_SAFE_INTEGER): boolean {
    const { outbox, logger } = this.options;
    const config = this.options.config();
    const current = config.confirmedSettings.version;
    const whole = isWholeSettings(update.settings, config.confirmedSettings);
    if (!whole && update.version > current + 1) {
      logger.warn('an update_settings skips a version; it waits for the ones before it', {
        version: update.version,
        snapshot: current,
      });
      return false;
    }
    const stale = whole ? update.version < current : update.version <= current;
    const before = settingsOfEvents(outbox.settingsInFlight(current));
    const { refused } = outbox.markSettingsEcho(update.settings, update.version, arrivedAfter);
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

  /**
   * Sends a probe when the hub has acknowledged a settings edit no echo has answered, once the commands that came
   * before the acknowledgement have run (CommandExecutor.settingsAcknowledged). The hub had applied or refused it,
   * and M2a sends an applied edit's echo before the ack of the events message that carried it, so after an ack only a
   * refused edit is left; at a welcome the echoes the hub still holds come after it, and a probe for one of those
   * costs one version. None goes while a probe newer than the edits still waits for its acknowledgement; nor while
   * one the hub acknowledged waits for its echo, except at a welcome, so a refused probe is followed by one probe per
   * welcome at most.
   */
  probeUnanswered(options: { welcome: boolean }): void {
    const { outbox } = this.options;
    const acked = outbox.ackedSeq();
    const unanswered = outbox.settingsUnanswered();
    const waiting = unanswered.filter((event) => !isSettingsProbe(event) && event.seq <= acked).at(-1);
    if (waiting === undefined) return;
    const probes = unanswered.filter((event) => isSettingsProbe(event) && event.seq > waiting.seq);
    if (probes.some((probe) => probe.seq > acked)) return;
    if (probes.length > 0 && !options.welcome) return;
    const baseVersion = this.options.config().confirmedSettings.version;
    outbox.append({ type: 'runner.settings', data: { settings: {}, baseVersion } });
  }
}
