// A seeded model of settings sync (design 6.3, "Settings sync"; X-12). The runner side is real: the Outbox on a
// temporary runner.db, the command executor's update_settings path, SettingsSync and config.ts, wired as the runtime
// wires them (runner.ts: the welcome and its hub epoch, exact answers, runner.json's version at
// start). The link is a pair of queues, and the hub a small model of M2a's rules (runners.ts, events-in.ts,
// gateway.ts, commands.ts): runner.settings applied in seq order whatever their base, each at the next version, and
// echoed verbatim; the owner's edits echoed the same way; an update_settings echo flushed before the ack of the events
// message that carried its edit; hello's version comparison (a runner it does not know: hello's settings stored at
// version 1 and echoed; equal: nothing; older: the hub's whole settings; newer: adopted, pending echoes cancelled);
// commands resent after each welcome until answered, and a failed result never; refusals explicitly answered; a restore from a backup, or from one taken before the runner was set up, with a new hub epoch, whose first
// welcome the runner answers with a new hello.
//
// Random steps: local edits of one field, several, or per-vendor entries; the owner's edits, some naming every field
// but not every vendor; the hub taking events; command and ack delivery, several at once, the welcome among them, so
// work held from before a hello may run before its welcome; link drops and reconnects with the replay; pauses; a long
// preflight that holds the runner's queue; crashes between an echo's mark and runner.json's write, after the write,
// before the journal's finish, inside a local edit, and at a restored hub's welcome; a write of runner.json that fails
// while the runner lives on; an echo's run, or a command's journal row, that fails while it lives on, and the retry
// timers that run it again as time passes; hand edits while the runner is down; pruning at 48 h and 14 days, by the
// runtime's Outbox or one built as M2c's retention builds it; backups and restores, while paused or busy too.
//
// Invariants: the hub never applies a runner edit already covered by an adopted snapshot; every runner.settings the runner
// appends carries only fields a user changed since they last went out (so no stale edit reverts a newer owner change);
// runner.json always holds the snapshot with the edits in flight laid over it; settingsEchoed stays within the outbox;
// an echo that moves the snapshot moves it to the settings the hub had at that version; on a link that stays up, every
// command it carried gets its result; at quiescence runner.json, its snapshot and the
// hub agree on every field and version, with nothing in flight and nothing unsent; and there, a field whose last change
// was the person's has that value, unless the hub refused an edit of it, a 14-day prune dropped one undelivered, or a
// restore came since.
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunnerSettings } from '@agflow/core';
import type { PreflightResult, VendorAdapter } from '../src/adapters/types';
import type { AttemptController } from '../src/attempt/controller';
import {
  localSettingsOf,
  type RunnerConfig,
  RunnerConfigSchema,
  type SettingsEdits,
  type SettingsValues,
  settingsAfterEdits,
} from '../src/config';
import { openRunnerDb, type RunnerDb } from '../src/db';
import { CommandExecutor } from '../src/executor';
import type { GitEnvironment } from '../src/git/run';
import type { Vault } from '../src/git/vault';
import { type CommandResult, Journal } from '../src/journal';
import type { CommandMessage } from '../src/link';
import { memoryLogger } from '../src/log';
import { Outbox, type SettingsEvent, type StoredEvent } from '../src/outbox';

// Each run's directory goes when it ends; a run that throws leaves its own to the afterAll.
const dirs = new Set<string>();
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** mulberry32: a small deterministic PRNG. */
function rng(seed: number) {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  const int = (n: number): number => Math.floor(next() * n);
  const pick = <T>(list: readonly T[]): T => list[int(list.length)] as T;
  return { next, int, pick, chance: (p: number) => next() < p };
}
type Rng = ReturnType<typeof rng>;

// Each scalar field and each vendor's entry of the per-vendor records is a key of its own, as on both sides.
const KEYS = [
  'capacity',
  'keepAwake',
  'draining',
  'ceilings.claude',
  'ceilings.codex',
  'allowPaidUsage.claude',
  'allowPaidUsage.codex',
] as const;
type Key = (typeof KEYS)[number];
const LOW = { fiveHour: 0.5, weekly: 0.6 };
const HIGH = { fiveHour: 0.85, weekly: 0.85 };
const VALUES: Record<Key, readonly unknown[]> = {
  capacity: [1, 2, 3],
  keepAwake: ['off', 'ac', 'always'],
  draining: [false, true],
  'ceilings.claude': [LOW, HIGH],
  'ceilings.codex': [LOW, HIGH],
  'allowPaidUsage.claude': [false, true],
  'allowPaidUsage.codex': [false, true],
};

function valueAt(settings: SettingsEdits, key: Key): unknown {
  const [field, vendor] = key.split('.') as [keyof SettingsEdits, string | undefined];
  const value = settings[field];
  return vendor === undefined ? value : (value as Record<string, unknown> | undefined)?.[vendor];
}

function keysOf(settings: SettingsEdits): Key[] {
  return KEYS.filter((key) => valueAt(settings, key) !== undefined);
}

function patchOf(entries: [Key, unknown][]): SettingsEdits {
  const patch: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    const [field, vendor] = key.split('.') as [string, string | undefined];
    if (vendor === undefined) patch[field] = structuredClone(value);
    else patch[field] = { ...(patch[field] as object | undefined), [vendor]: structuredClone(value) };
  }
  return patch as SettingsEdits;
}

/** One field, several, or per-vendor entries, with values from small sets, so equal edits come often. */
function randomPatch(r: Rng): SettingsEdits {
  const count = r.pick([1, 1, 1, 2, 3]);
  const keys = new Set<Key>();
  while (keys.size < count) keys.add(r.pick(KEYS));
  return patchOf([...keys].map((key) => [key, r.pick(VALUES[key])]));
}

/** An owner's PATCH that names every field, but in each per-vendor record one vendor only: not the whole settings. */
function everyFieldPatch(r: Rng): SettingsEdits {
  const scalars: Key[] = ['capacity', 'keepAwake', 'draining'];
  const vendors: Key[] = [
    r.pick(['ceilings.claude', 'ceilings.codex']),
    r.pick(['allowPaidUsage.claude', 'allowPaidUsage.codex']),
  ];
  return patchOf([...scalars, ...vendors].map((key) => [key, r.pick(VALUES[key])]));
}

/** Lays changes over settings as both sides do: per-vendor records vendor by vendor. */
function merged(settings: SettingsValues, changes: SettingsEdits): SettingsValues {
  const next = structuredClone(settings);
  for (const key of keysOf(changes)) {
    const [field, vendor] = key.split('.') as [keyof SettingsValues, string | undefined];
    const value = structuredClone(valueAt(changes, key));
    if (vendor === undefined) Object.assign(next, { [field]: value });
    else Object.assign(next, { [field]: { ...(next[field] as object), [vendor]: value } });
  }
  return next;
}

function valuesOf(settings: RunnerSettings): SettingsValues {
  const { version: _version, ...values } = settings;
  return values;
}

function differences(a: SettingsEdits, b: SettingsEdits): Key[] {
  return KEYS.filter((key) => !Bun.deepEquals(valueAt(a, key), valueAt(b, key)));
}

/** The process died here: nothing more of it runs. */
class Crash extends Error {}

/** runner.json's write failed, and the process lives on. */
class WriteFailure extends Error {}

const DAY = 24 * 60 * 60_000;
/**
 * A failure names its seed. MODEL_SEED runs from that one, MODEL_SEEDS sets how many run (160), and MODEL_LOG how many
 * steps of a failing run's log show (60).
 */
const FIRST_SEED = Number(process.env.MODEL_SEED ?? 1);
const SEED_COUNT = Number(process.env.MODEL_SEEDS ?? 160);
const LOG_TAIL = Number(process.env.MODEL_LOG ?? 60);

interface HubCommand {
  id: string;
  settings: SettingsEdits;
  version: number;
  status: 'pending' | 'done' | 'cancelled';
  /** The runner.settings seq it echoes; null for the owner's and hello's. */
  source: number | null;
  refused?: true;
}

/** M2a's settings rules, for one runner with one outbox epoch. */
class HubModel {
  settings: SettingsValues;
  version: number;
  acked = 0;
  adoptedThrough = 0;
  epoch = 1;
  nextSeq = 1;
  commands: HubCommand[] = [];
  /** The settings at each version this hub's history holds: a restore takes the backup's, an adopted hello adds one. */
  history = new Map<number, SettingsValues>();
  /**
   * No owner edit between a restore and the runner's hello that the restored hub's welcome answers: the first one
   * after the restore, or the runner's next after that welcome (an M2a limitation, out of scope here).
   */
  awaitingHello = false;
  private backupState: string | null = null;

  constructor(
    initial: RunnerSettings,
    private readonly refuse: (event: SettingsEvent) => boolean,
    private readonly applying: (event: SettingsEvent) => void,
    private readonly refused: (event: SettingsEvent) => void,
  ) {
    this.settings = valuesOf(initial);
    this.version = initial.version;
    this.history.set(this.version, structuredClone(this.settings));
  }

  private enqueue(settings: SettingsEdits, version: number, source: number | null): void {
    this.commands.push({ id: `${this.epoch}-R-${this.nextSeq++}`, settings, version, status: 'pending', source });
  }

  /** changeSettings: the hub's version + 1, written field by field, and echoed verbatim. */
  private change(changes: SettingsEdits, source: number | null): void {
    this.version += 1;
    this.settings = merged(this.settings, changes);
    this.history.set(this.version, structuredClone(this.settings));
    this.enqueue(structuredClone(changes), this.version, source);
  }

  /**
   * applyRunnerEvents: in seq order past the acknowledged position, gaps allowed; a refusal is acknowledged all the
   * same.
   */
  receive(events: StoredEvent[]): number {
    for (const event of events) {
      if (event.seq <= this.acked) continue;
      if (event.type === 'runner.settings' && event.seq > this.adoptedThrough) {
        if (this.refuse(event)) {
          this.refused(event);
          this.enqueue({}, this.version, event.seq);
          this.commands.at(-1)!.refused = true;
        } else {
          this.applying(event);
          this.change(event.data.settings, event.seq);
        }
      }
      this.acked = event.seq;
    }
    return this.acked;
  }

  owner(patch: SettingsEdits): void {
    this.change(patch, null);
  }

  /** reconcileHelloSettings and acknowledgePosition; lastHubEpoch is the hello's. */
  hello(reported: RunnerSettings, firstSeq: number, lastHubEpoch: number | null, answeredSeq: number): number {
    this.acked = Math.max(this.acked, firstSeq - 1);
    // A runner that has had a welcome of an older epoch says hello again at this one's.
    if (lastHubEpoch === null || lastHubEpoch === this.epoch) this.awaitingHello = false;
    if (this.version === 0) {
      // A runner the hub does not know: hello's settings stored at version 1, and echoed.
      this.settings = valuesOf(reported);
      this.version = Math.max(1, reported.version);
      this.adoptedThrough = answeredSeq;
      this.history.set(this.version, structuredClone(this.settings));
      this.enqueue(structuredClone(this.settings), this.version, null);
    } else if (reported.version > this.version) {
      this.settings = valuesOf(reported);
      this.version = reported.version;
      this.adoptedThrough = answeredSeq;
      this.history.set(this.version, structuredClone(this.settings));
      for (const command of this.commands) if (command.status === 'pending') command.status = 'cancelled';
    } else if (reported.version < this.version) {
      this.enqueue(structuredClone(this.settings), this.version, null);
    }
    return this.acked;
  }

  pending(): HubCommand[] {
    return this.commands.filter((command) => command.status === 'pending');
  }

  answered(id: string): void {
    const command = this.commands.find((entry) => entry.id === id);
    if (command?.status === 'pending') command.status = 'done';
  }

  backup(): void {
    this.backupState = JSON.stringify({
      settings: this.settings,
      version: this.version,
      acked: this.acked,
      adoptedThrough: this.adoptedThrough,
      commands: this.commands,
      history: [...this.history],
    });
  }

  get hasBackup(): boolean {
    return this.backupState !== null;
  }

  /**
   * A restore from the backup, or (early) from one taken before the runner was set up, which knows nothing of it: a
   * new hub epoch, so new command ids never meet the backup's.
   */
  restore(early: boolean): void {
    type State = Pick<HubModel, 'settings' | 'version' | 'acked' | 'commands' | 'adoptedThrough'> & {
      history: [number, SettingsValues][];
    };
    const unknown: State = { settings: this.settings, version: 0, acked: 0, adoptedThrough: 0, commands: [], history: [] };
    const { history, ...state } = early ? unknown : (JSON.parse(this.backupState as string) as State);
    Object.assign(this, structuredClone(state));
    this.history = new Map(history);
    // A backup older than that one counts its versions in another history: a restore to it is the known limit of a
    // restored hub ahead of the runner (design 6.3), which this model leaves out.
    if (early) this.backupState = null;
    this.epoch += 1;
    this.nextSeq = 1;
    this.awaitingHello = true;
  }
}

type ToRunner = CommandMessage | { t: 'ack'; seq: number } | { t: 'welcome'; ackedSeq: number; hubEpoch: number };

interface Link {
  /** The welcome first, then the commands and acks, in the order the hub sent them. */
  toRunner: ToRunner[];
  toHub: StoredEvent[][];
  /** The welcome came: events go out. */
  online: boolean;
  /** The link's own: the last event sent or left out. */
  sentSeq: number;
  /** Commands sent on this link. */
  sent: Set<string>;
}

/** A retry timer the executor set; the model fires it as time passes. */
interface Timer {
  run: () => void;
  done: boolean;
}

interface Life {
  db: RunnerDb;
  outbox: Outbox;
  executor: CommandExecutor;
  /** runner.json as this process holds it. */
  config: RunnerConfig;
  dead: boolean;
  welcomed: boolean;
  recovered: boolean;
  paused: boolean;
  timers: Timer[];
}

/**
 * Where the process dies, or (failSave) where runner.json's write fails while it lives on. welcome: at a restored hub's
 * welcome, before or after its epoch is written.
 */
type CrashPoint = 'beforeSave' | 'afterSave' | 'finish' | 'change' | 'failSave' | 'welcome';

class Model {
  readonly log: string[] = [];
  readonly hub: HubModel;
  private readonly r: Rng;
  readonly dir: string;
  private readonly dbPath: string;
  private readonly logger = memoryLogger();
  private disk: RunnerConfig;
  private life: Life | null = null;
  private link: Link | null = null;
  private readonly clock = { t: 1_000_000_000 };
  private crashAt: CrashPoint | null = null;
  /** How many of the next echo runs fail while the process lives on, as SQLITE_BUSY would. */
  private echoFailures = 0;
  /** How many of the next journal rows cannot be written while the process lives on, as SQLITE_FULL would. */
  private journalFailures = 0;
  private changing = false;
  /** Keys a user changed in runner.json since they last went out as runner.settings. */
  private readonly fresh = new Set<Key>();
  private scanned = 0;
  private readonly refuseRate: number;
  private refusing = true;
  /** The value of each key whose last change was the person's, while nothing has excused its loss since. */
  private readonly lastLocal = new Map<Key, unknown>();
  /** A long preflight holding the runner's queue, until a step ends it. */
  private preflight: PromiseWithResolvers<PreflightResult> | null = null;
  private preflights = 0;

  constructor(seed: number) {
    this.r = rng(seed);
    this.dir = mkdtempSync(join(tmpdir(), 'agflow-settings-model-'));
    dirs.add(this.dir);
    this.dbPath = join(this.dir, 'runner.db');
    this.disk = RunnerConfigSchema.parse({ runnerKey: 'rk_model', machineId: 'MACHINE-1', name: 'model' });
    this.disk.confirmedSettings.version = 1;
    this.refuseRate = this.r.pick([0, 0.05, 0.15]);
    this.hub = new HubModel(
      this.disk.confirmedSettings,
      (event) =>
        this.refusing && this.r.chance(this.refuseRate),
      (event) => {
        // An adopted snapshot is the only reason to skip an answered edit after restore.
        if (event.seq <= this.hub.adoptedThrough) this.fail('applied an edit already included in the adopted snapshot');
      },
      (event) => {
        this.note(`hub refused #${event.seq}`);
        for (const key of keysOf(event.data.settings)) this.lastLocal.delete(key);
      },
    );
  }

  /** The first failure, kept: one thrown inside the runner's code (an echo's run, say) may be caught there. */
  private failure: Error | null = null;

  fail(message: string): never {
    this.failure ??= new Error(`${message}\n${this.log.slice(-LOG_TAIL).join('\n')}`);
    throw this.failure;
  }

  /** Throws the failure kept, if any. */
  private failed(): void {
    if (this.failure !== null) throw this.failure;
  }

  private note(entry: string): void {
    this.log.push(entry);
  }

  // The runner process.

  private start(): void {
    const db = openRunnerDb(this.dbPath);
    const life = { db, config: structuredClone(this.disk), dead: false, welcomed: false, recovered: false } as Life;
    life.paused = false;
    life.timers = [];
    life.outbox = new Outbox(db, {
      now: () => this.clock.t,
      confirmedVersion: () => life.config.confirmedSettings.version,
    });
    life.outbox.settingsSaved(life.config.confirmedSettings.version);
    const mark = life.outbox.markSettingsEcho.bind(life.outbox);
    life.outbox.markSettingsEcho = (...args) => {
      if (this.echoFailures > 0 && !life.dead) {
        this.echoFailures -= 1;
        this.note('an echo fails');
        throw new Error('SQLITE_BUSY: database is locked');
      }
      return mark(...args);
    };
    const journal = new Journal(db);
    const begin = journal.begin.bind(journal);
    journal.begin = (...args) => {
      if (this.journalFailures > 0 && !life.dead) {
        this.journalFailures -= 1;
        this.note(`a journal row of ${args[0]} cannot be written`);
        throw new Error('SQLITE_FULL: database or disk is full');
      }
      return begin(...args);
    };
    const finish = journal.finish.bind(journal);
    journal.finish = (commandId: string, result: CommandResult) => {
      if (this.crashAt === 'finish' && !life.dead) this.crash(life, 'at the journal finish');
      if (life.dead) throw new Crash('dead');
      finish(commandId, result);
    };
    const unused = () => {
      throw new Error('not in this model');
    };
    life.executor = new CommandExecutor({
      journal,
      controller: unused as unknown as (attemptId: string) => AttemptController,
      known: () => false,
      config: () => life.config,
      saveConfig: (config) => this.save(life, config),
      outbox: life.outbox,
      vault: {} as Vault,
      local: {} as GitEnvironment,
      remote: unused as unknown as () => Promise<GitEnvironment>,
      wipRefPrefix: () => 'refs/agflow/',
      // A preflight holds the runner's queue while a step's long one runs; one run again after a restart does not.
      adapters: new Map([
        [
          'claude',
          {
            vendor: 'claude',
            preflight: () => this.preflight?.promise ?? Promise.resolve({} as PreflightResult),
          } as unknown as VendorAdapter,
        ],
      ]),
      vendors: () => ({ vendors: [], quota: [] }),
      logger: this.logger,
      // Fired as the model's time passes (fireTimers); a dead process's never are.
      timers: {
        setTimeout: (run: () => void) => {
          const timer: Timer = { run, done: false };
          life.timers.push(timer);
          return timer;
        },
        clearTimeout: (handle: unknown) => {
          (handle as Timer).done = true;
        },
      },
    });
    // The log notes each echo run, with what it left in flight. An echo that moves the snapshot moves it to the
    // settings this hub had at that version.
    const echo = life.executor.settings.echo.bind(life.executor.settings);
    life.executor.settings.echo = (update, arrivedAfter) => {
      const before = structuredClone(life.config.confirmedSettings);
      const answered = echo(update, arrivedAfter);
      const open = life.outbox.settingsInFlight().map((event) => event.seq);
      const snapshot = life.config.confirmedSettings;
      const ran = `ran v${update.version}${answered ? '' : ', unanswered'}`;
      this.note(`${ran}: snapshot v${snapshot.version}, in flight ${open}`);
      if (!Bun.deepEquals(snapshot, before)) {
        const hub = this.hub.history.get(snapshot.version);
        const off = hub === undefined ? ['every field'] : differences(valuesOf(snapshot), hub);
        if (off.length > 0) {
          this.fail(`the snapshot at v${snapshot.version} differs from the hub's in ${off.join(', ')}`);
        }
      }
      return answered;
    };
    // runner.ts: each ack checks the settings edits in flight.
    this.life = life;
    this.note('start');
  }

  /**
   * runner.ts's saveConfig, with the crash points around runner.json's write: the process holds the new settings
   * first, then writes them, which may fail while it lives on.
   */
  private save(life: Life, config: RunnerConfig): void {
    if (life.dead) throw new Crash('dead');
    const point = this.crashAt;
    if (!this.changing && point === 'beforeSave') this.crash(life, 'between the mark and runner.json');
    life.config = config;
    if (point === 'failSave') {
      this.crashAt = null;
      this.note('runner.json cannot be written');
      throw new WriteFailure('ENOSPC');
    }
    this.disk = structuredClone(RunnerConfigSchema.parse(structuredClone(config)));
    if ((!this.changing && point === 'afterSave') || (this.changing && point === 'change')) {
      this.crash(life, this.changing ? 'between a local edit and its event' : 'after runner.json');
    }
  }

  private crash(life: Life, where: string): never {
    this.die(life, `crash ${where}`);
    throw new Crash(where);
  }

  private die(life: Life, why: string): void {
    if (life.dead) return;
    life.dead = true;
    this.crashAt = null;
    // A preflight the dead process waited on never ends for it.
    this.preflight = null;
    life.db.close();
    this.link = null;
    this.note(why);
  }

  private track(promise: Promise<unknown>): void {
    promise.catch(() => {});
  }

  private alive(): Life | null {
    return this.life !== null && !this.life.dead ? this.life : null;
  }

  // The link.

  /**
   * hello, as the runtime builds it, and the gateway's attach: the hub reconciles the hello at once and sends the
   * welcome, then the pending commands. The runner reads the welcome later, as deliverToRunner gets to it; work held
   * from before the hello may run meanwhile.
   */
  private connect(life: Life): void {
    life.executor.helloSent();
    const reported = life.config.confirmedSettings;
    const ackedSeq = this.hub.hello(reported, life.outbox.firstSeq(), life.db.meta('lastHubEpoch'), life.outbox.settingsAnsweredSeq());
    const welcome: ToRunner = { t: 'welcome', ackedSeq, hubEpoch: this.hub.epoch };
    const link: Link = { toRunner: [welcome], toHub: [], online: false, sentSeq: ackedSeq, sent: new Set() };
    this.link = link;
    this.note(`hello v${reported.version}: hub v${this.hub.version}, acked ${ackedSeq}`);
    this.flush();
  }

  /**
   * The runtime's welcomed, as the link runs it. A restored hub's first welcome: what the outbox holds is recorded,
   * then the hub's epoch, and the runner says hello again at once (LinkClient.reconnectNow).
   */
  private welcomed(life: Life, link: Link, welcome: { ackedSeq: number; hubEpoch: number }): void {
    const { ackedSeq, hubEpoch } = welcome;
    this.note(`welcome acked ${ackedSeq}, epoch ${hubEpoch}, runner v${life.config.confirmedSettings.version}`);
    life.outbox.ack(life.outbox.epoch, ackedSeq);
    const lastHubEpoch = life.db.meta('lastHubEpoch');
    if (lastHubEpoch !== null && lastHubEpoch !== hubEpoch) {
      if (this.crashAt === 'welcome' && this.r.chance(0.5)) this.crash(life, 'at a restored welcome, before its epoch');
      life.db.setMeta('lastHubEpoch', hubEpoch);
      if (this.crashAt === 'welcome') this.crash(life, 'at a restored welcome, after its epoch');
      this.note('a restored hub: hello again');
      this.link = null;
      this.connect(life);
      return;
    }
    link.online = true;
    life.db.setMeta('lastHubEpoch', hubEpoch);
    void life.executor.onWelcome({ stop: [] });
    if (!life.recovered) {
      life.recovered = true;
      this.track(life.executor.recover());
    }
    life.executor.settings.welcomed();
    life.welcomed = true;
    this.scan();
    this.fresh.clear();
    this.pump();
  }

  /** link.ts's pump: every retained event goes to the hub. */
  private pump(): void {
    const life = this.alive();
    const link = this.link;
    if (life === null || link === null || !link.online) return;
    const events: StoredEvent[] = [];
    let through = link.sentSeq;
    for (const event of life.outbox.eventsAfter(link.sentSeq)) {
      through = event.seq;
      events.push(event);
    }
    if (events.length > 0) link.toHub.push(events);
    link.sentSeq = through;
  }

  /** The gateway's flush: the pending commands this link has not had, in order. */
  private flush(): void {
    const link = this.link;
    if (link === null) return;
    for (const command of this.hub.pending()) {
      if (link.sent.has(command.id)) continue;
      link.sent.add(command.id);
      const message: CommandMessage = {
        t: 'command',
        id: command.id,
        seq: Number(command.id.split('-').at(-1)),
        command: { kind: 'update_settings', settings: command.settings, version: command.version, ...(command.source === null ? {} : { answers: { seq: command.source, outboxEpoch: this.alive()!.outbox.epoch, ...(command.refused ? { refused: true as const } : {}) } }) },
      };
      link.toRunner.push(message);
    }
  }

  private deliverToHub(): void {
    const link = this.link;
    const batch = link?.toHub.shift();
    if (link === null || batch === undefined) return;
    const acked = this.hub.receive(batch);
    this.note(`hub took ${batch.map((event) => event.seq).join(',')}: v${this.hub.version}, acked ${acked}`);
    // The echoes of the edits it applied go out before the ack.
    this.flush();
    link.toRunner.push({ t: 'ack', seq: acked });
  }

  private deliverToRunner(count: number): void {
    const life = this.alive();
    const link = this.link;
    if (life === null || link === null) return;
    for (let index = 0; index < count; index += 1) {
      // A connection the runner replaced (a restored hub's welcome) has nothing more to say.
      if (this.link !== link) return;
      const message = link.toRunner.shift();
      if (message === undefined) return;
      if (message.t === 'ack') {
        life.outbox.ack(life.outbox.epoch, message.seq);
        continue;
      }
      if (message.t === 'welcome') {
        this.welcomed(life, link, message);
        continue;
      }
      const command = this.hub.commands.find((entry) => entry.id === message.id) as HubCommand;
      this.note(`echo ${message.id} v${command.version} ${JSON.stringify(command.settings)}`);
      // As LinkClient.runCommand: a throw or a rejection answers ok false, which the hub records and never resends.
      let result: Promise<CommandResult | null>;
      try {
        result = life.executor.onCommand(message);
      } catch (error) {
        result = Promise.reject(error);
      }
      this.track(
        result
          .catch((error): CommandResult => {
            if (error instanceof Crash || life.dead) throw error;
            this.note(`echo ${message.id} failed: ${(error as Error).message}`);
            return { ok: false, error: (error as Error).message };
          })
          .then((answer) => {
            // No answer: the hub sends it again after the next welcome.
            if (life.dead || answer === null) return;
            if (this.link === link) this.hub.answered(message.id);
          }),
      );
    }
  }

  /** Time passes: the retry timers the executor set run. */
  private fireTimers(life: Life | null): void {
    if (life === null) return;
    for (const timer of life.timers.splice(0)) {
      if (timer.done) continue;
      timer.done = true;
      this.note('a retry timer fires');
      timer.run();
    }
  }

  // Checks.

  /** Every runner.settings appended since the last scan names only keys a user changed since they last went out. */
  private scan(): void {
    const life = this.alive();
    if (life === null) return;
    for (const event of life.outbox.eventsAfter(this.scanned)) {
      this.scanned = event.seq;
      if (event.type !== 'runner.settings') continue;
      this.note(`sent #${event.seq} ${JSON.stringify(event.data.settings)}`);
      for (const key of keysOf(event.data.settings)) {
        if (!this.fresh.has(key)) this.fail(`runner.settings #${event.seq} sent ${key} again, with no user change`);
        this.fresh.delete(key);
      }
    }
  }

  /** runner.json holds the snapshot with the edits in flight laid over it. */
  private checkView(): void {
    const life = this.alive();
    if (life === null || !life.welcomed) return;
    const local = localSettingsOf(life.config);
    const view = valuesOf(life.executor.settings.view(life.config));
    const off = differences(local, view);
    if (off.length > 0) this.fail(`runner.json differs from the view in ${off.join(', ')}`);
  }

  private checkMarks(life: Life): void {
    const settings = life.outbox.eventsAfter(0).filter((event) => event.type === 'runner.settings');
    const kept = new Set(settings.map((event) => event.seq));
    const marks = life.db.meta('settingsEchoed') ?? [];
    if (marks.some((mark) => !kept.has(mark.seq))) this.fail('a mark outlived its event');
    if (marks.length > kept.size) this.fail('more marks than settings events');
  }

  /** Lets the runner's queued work run: all of it is synchronous SQLite and promises, with no timers. */
  private async settle(): Promise<void> {
    for (let round = 0; round < 3; round += 1) await new Promise((resolve) => setImmediate(resolve));
  }

  // Steps.

  begin(): void {
    this.start();
    this.connect(this.alive() as Life);
  }

  async step(): Promise<void> {
    const r = this.r;
    const life = this.alive();
    const roll = r.int(100);
    try {
      if (roll < 14) {
        if (life === null) return;
        const patch = randomPatch(r);
        const before = localSettingsOf(life.config);
        const view = valuesOf(life.executor.settings.view(life.config));
        this.note(`local edit ${JSON.stringify(patch)}`);
        this.changing = true;
        try {
          life.executor.settings.change(patch);
        } catch (error) {
          // A failed write makes no edit.
          if (!(error instanceof WriteFailure)) throw error;
          const off = differences(before, localSettingsOf(life.config));
          if (off.length > 0) this.fail(`a local edit whose write failed changed ${off.join(', ')}`);
        } finally {
          // The settings the runner holds, which a crash inside the edit leaves in runner.json: the next welcome sends
          // the fields where they differ from the view, and a field back at its view's value is no change it can tell.
          this.changing = false;
          const after = localSettingsOf(life.config);
          for (const key of differences(before, after)) {
            this.fresh.add(key);
            if (life.dead && Bun.deepEquals(valueAt(after, key), valueAt(view, key))) this.lastLocal.delete(key);
            else this.lastLocal.set(key, valueAt(after, key));
          }
        }
      } else if (roll < 24) {
        if (this.hub.awaitingHello) return;
        const patch = r.chance(0.35) ? everyFieldPatch(r) : randomPatch(r);
        this.note(`owner edit ${JSON.stringify(patch)}`);
        this.hub.owner(patch);
        for (const key of keysOf(patch)) this.lastLocal.delete(key);
        this.flush();
      } else if (roll < 38) {
        this.deliverToHub();
      } else if (roll < 55) {
        this.deliverToRunner(1 + r.int(4));
      } else if (roll < 58) {
        if (this.link !== null) this.note('link drops');
        this.link = null;
      } else if (roll < 64) {
        if (life !== null && this.link === null) this.connect(life);
      } else if (roll < 67) {
        if (life === null) return;
        if (r.chance(0.3)) this.die(life, 'stop');
        else this.crashAt = r.pick(['beforeSave', 'afterSave', 'finish', 'change', 'failSave', 'welcome'] as const);
      } else if (roll < 73) {
        if (life !== null) return;
        if (r.chance(0.5)) this.handEdit();
        this.start();
      } else if (roll < 76) {
        if (life === null) return;
        if (life.paused) life.executor.resume();
        else life.executor.pause();
        life.paused = !life.paused;
        this.note(life.paused ? 'pause' : 'resume');
      } else if (roll < 79) {
        this.preflightStep(life);
      } else if (roll < 84) {
        this.clock.t += r.pick([1_000, 60_000, 6 * 60 * 60_000, DAY, 5 * DAY]);
        this.fireTimers(life);
      } else if (roll < 87) {
        this.echoFailures += r.pick([1, 1, 2]);
      } else if (roll < 89) {
        this.journalFailures += r.pick([1, 1, 2]);
      } else if (roll < 92) {
        if (life === null) return;
        this.prune(life);
      } else if (roll < 95) {
        this.hub.backup();
        this.note('backup');
      } else {
        const early = !this.hub.hasBackup || r.chance(0.25);
        this.note(early ? 'hub restored from before the runner was set up' : 'hub restored');
        this.hub.restore(early);
        // A restore may lose what the person changed last (design 6.3); runner and hub must still agree.
        this.lastLocal.clear();
        this.link = null;
        if (life !== null) this.connect(life);
      }
    } catch (error) {
      if (!(error instanceof Crash)) throw error;
    } finally {
      await this.settle();
      this.failed();
      this.scan();
      this.pump();
      this.checkView();
    }
  }

  /**
   * Edits runner.json while the runner is down. The next welcome sends the fields where it differs from the view the
   * runner reads at start; a field edited back to that view's value is no change it can tell.
   */
  private handEdit(): void {
    const patch = randomPatch(this.r);
    const before = localSettingsOf(this.disk);
    this.disk = RunnerConfigSchema.parse({ ...structuredClone(this.disk), ...merged(before, patch) });
    const disk = localSettingsOf(this.disk);
    const db = openRunnerDb(this.dbPath);
    let view: SettingsValues;
    try {
      const outbox = new Outbox(db, { confirmedVersion: () => this.disk.confirmedSettings.version });
      const edits = outbox.settingsInFlight().map((event) => event.data.settings);
      view = valuesOf(settingsAfterEdits(this.disk.confirmedSettings, edits));
    } finally {
      db.close();
    }
    for (const key of differences(before, disk)) {
      this.fresh.add(key);
      if (Bun.deepEquals(valueAt(disk, key), valueAt(view, key))) this.lastLocal.delete(key);
      else this.lastLocal.set(key, valueAt(disk, key));
    }
    this.note(`hand edit ${JSON.stringify(patch)}`);
  }

  /** A long preflight starts, holding the runner's queue, or the one running ends. */
  private preflightStep(life: Life | null): void {
    if (this.preflight !== null) {
      this.note('preflight ends');
      this.preflight.resolve({} as PreflightResult);
      this.preflight = null;
      return;
    }
    if (life === null) return;
    this.preflight = Promise.withResolvers<PreflightResult>();
    this.preflights += 1;
    this.note('preflight starts');
    const message: CommandMessage = {
      t: 'command',
      id: `P-${this.preflights}`,
      seq: 0,
      command: { kind: 'preflight', vendor: 'claude' },
    };
    this.track(life.executor.onCommand(message));
  }

  /**
   * M2c's retention: pruneAcked at 48 h or pruneBefore at 14 days, by the runtime's Outbox or by one built without
   * confirmedVersion, as M2c's host builds it. pruneBefore drops undelivered events too: the person's change one of
   * them carried may be lost.
   */
  private prune(life: Life): void {
    const outbox = this.r.chance(0.5) ? life.outbox : new Outbox(life.db, { now: () => this.clock.t });
    const acked = life.outbox.ackedSeq();
    const undelivered = life.outbox.eventsAfter(acked);
    const pruned = this.r.chance(0.5) ? outbox.pruneAcked(2 * DAY) : outbox.pruneBefore(this.clock.t - 14 * DAY);
    if (pruned > 0) this.note(`pruned ${pruned}${outbox === life.outbox ? '' : ' (retention)'}`);
    const kept = new Set(life.outbox.eventsAfter(acked).map((event) => event.seq));
    for (const event of undelivered) {
      if (kept.has(event.seq) || event.type !== 'runner.settings') continue;
      this.note(`pruned #${event.seq} undelivered`);
      for (const key of keysOf(event.data.settings)) this.lastLocal.delete(key);
    }
    this.checkMarks(life);
  }

  /** Everything delivered, no refusal, no new edit: then runner.json, its snapshot and the hub agree. */
  async quiesce(): Promise<void> {
    this.refusing = false;
    this.crashAt = null;
    this.echoFailures = 0;
    this.journalFailures = 0;
    let life = this.alive();
    if (life === null) {
      this.start();
      life = this.alive() as Life;
    }
    if (life.paused) {
      life.executor.resume();
      life.paused = false;
    }
    this.preflight?.resolve({} as PreflightResult);
    this.preflight = null;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      if (this.link === null) this.connect(life);
      let link = this.link as Link;
      for (let round = 0; round < 200; round += 1) {
        await this.settle();
        this.failed();
        // A restored hub's welcome makes the runner say hello again: the new link goes on.
        if (this.link !== null) link = this.link;
        this.scan();
        this.pump();
        this.checkView();
        const timers = life.timers.some((timer) => !timer.done);
        if (link.toHub.length === 0 && link.toRunner.length === 0 && !timers) break;
        this.deliverToHub();
        this.deliverToRunner(link.toRunner.length);
        this.fireTimers(life);
      }
      await this.settle();
      this.failed();
      // A link that stays up needs no reconnect for its commands: each one it carried got its result.
      const stalled = this.hub.pending().filter((command) => link.sent.has(command.id));
      if (stalled.length > 0) {
        const ids = stalled.map((command) => command.id).join(', ');
        this.fail(`commands left unanswered on a link that stayed up: ${ids}`);
      }
      // A command left unanswered is sent again after welcome.
      const acked = life.outbox.ackedSeq();
      const waiting = life.outbox.settingsInFlight().some((event) => event.seq <= acked);
      if (!waiting && this.hub.pending().length === 0) break;
      this.note('reconnect to settle');
      this.link = null;
    }
    if (this.hub.pending().length > 0) {
      this.fail(`commands never answered: ${this.hub.pending().map((command) => command.id).join(', ')}`);
    }
    const unanswered = life.outbox.settingsInFlight();
    if (unanswered.length > 0) this.fail(`edits still unanswered: ${unanswered.map((event) => event.seq).join(',')}`);
    // Every retained event went out and was acknowledged.
    const unacked = life.outbox.eventsAfter(life.outbox.ackedSeq());
    const unsent = unacked;
    if (unsent.length > 0) this.fail(`events never acknowledged: ${unsent.map((event) => event.seq).join(',')}`);
    const local = localSettingsOf(life.config);
    const snapshot = life.config.confirmedSettings;
    const off = [
      ...differences(local, valuesOf(snapshot)).map((key) => `runner.json/snapshot ${key}`),
      ...differences(valuesOf(snapshot), this.hub.settings).map((key) => `snapshot/hub ${key}`),
    ];
    if (off.length > 0) this.fail(`at quiescence they differ: ${off.join(', ')}`);
    if (snapshot.version !== this.hub.version) this.fail(`snapshot v${snapshot.version}, hub v${this.hub.version}`);
    if (this.fresh.size > 0) this.fail(`changes never sent: ${[...this.fresh].join(', ')}`);
    const lost = [...this.lastLocal].filter(([key, value]) => !Bun.deepEquals(valueAt(this.hub.settings, key), value));
    if (lost.length > 0) this.fail(`the person's last change of ${lost.map(([key]) => key).join(', ')} was lost`);
    this.checkMarks(life);
    // With nothing in flight, retention keeps no runner.settings except the edits
    // whose echo runner.json, after a failed write, has not taken yet.
    this.clock.t += 3 * DAY;
    new Outbox(life.db, { now: () => this.clock.t }).pruneAcked(2 * DAY);
    const saved = life.db.meta('settingsSavedVersion') ?? 0;
    const marks = life.db.meta('settingsEchoed') ?? [];
    const unsaved = new Set(marks.flatMap((mark) => (mark.version > saved ? [mark.seq] : [])));
    const left = life.outbox
      .eventsAfter(0)
      .filter((event) => event.type === 'runner.settings' && !unsaved.has(event.seq));
    if (left.length > 0) this.fail(`retention kept runner.settings ${left.map((event) => event.seq).join(',')}`);
    this.die(life, 'end');
  }
}

describe('settings sync model', () => {
  test('random runs keep the invariants and end with runner.json, its snapshot and the hub in agreement', async () => {
    const SEEDS = FIRST_SEED - 1 + SEED_COUNT;
    const STEPS = 140;
    for (let seed = FIRST_SEED; seed <= SEEDS; seed += 1) {
      const model = new Model(seed);
      try {
        model.begin();
        for (let step = 0; step < STEPS; step += 1) await model.step();
        await model.quiesce();
      } catch (error) {
        throw new Error(`seed ${seed}: ${(error as Error).message}`);
      }
      rmSync(model.dir, { recursive: true, force: true });
      dirs.delete(model.dir);
    }
    expect(true).toBe(true);
  }, Math.max(60_000, SEED_COUNT * 200));
});
