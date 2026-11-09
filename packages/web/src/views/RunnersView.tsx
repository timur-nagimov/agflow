import type { AccountQuota, Runner, RunnerVendor } from '@agflow/core';
import { type FormEvent, useState } from 'react';
import { api } from '../api';
import { Empty, ErrorBox, Fact, Field, Loading, Meter, PageHead } from '../components';
import { VENDOR_NAMES } from '../format';
import { useAction, useNow } from '../hooks';
import { useHub } from '../hub';
import {
  KEEP_AWAKE_LABELS,
  type QuotaMeter,
  RUNNER_STATE_LABELS,
  type SettingsDraft,
  acceptingText,
  accountOf,
  diskText,
  draftFromRunner,
  gitText,
  isOwner,
  paidUsageText,
  powerText,
  profileLines,
  quotaMeters,
  runnerTone,
  runnerWhy,
  settingsPatch,
  settingsProblem,
  slotsText,
  sortRunners,
  vendorView,
} from '../runners';

/** Design 11's Runners page: one card per runner, the signed-in person's first. */
export function RunnersView() {
  const { me, runners } = useHub();
  const now = useNow();
  if (!runners.data) return runners.error ? <ErrorBox error={runners.error} onRetry={runners.reload} /> : <Loading />;
  const { accounts } = runners.data;
  const list = sortRunners(runners.data.runners, me);
  const online = list.filter((runner) => runner.state === 'online').length;

  return (
    <div className="page">
      <PageHead title="Runners" meta={`${online} online · ${list.length} in all`} />
      {list.length === 0 ? (
        <Empty title="No runners yet">
          On a Mac that should run agents, run <code>agflow runner setup</code>. The runner shows up here once it
          connects.
        </Empty>
      ) : (
        <div className="runner-grid">
          {list.map((runner) => (
            <RunnerCard
              key={runner.id}
              runner={runner}
              accounts={accounts}
              owner={isOwner(runner, me)}
              onChanged={runners.reload}
              now={now}
            />
          ))}
        </div>
      )}
      <p className="hint">
        Quota belongs to the account: an owner's runners logged in to the same account share it. Each runner stops
        taking work of a vendor at its own ceilings.
      </p>
    </div>
  );
}

function RunnerCard({
  runner,
  accounts,
  owner,
  onChanged,
  now,
}: {
  runner: Runner;
  accounts: AccountQuota[];
  /** Only the owner changes the settings or retires the runner; the hub checks too. */
  owner: boolean;
  onChanged: () => void;
  now: number;
}) {
  const tone = runnerTone(runner);
  const why = runnerWhy(runner, now);
  const accepting = acceptingText(runner, now);
  return (
    <article className={`card runner-card tone-${tone}`}>
      <header className="runner-head">
        <span className={`lamp tone-${tone}${tone === 'done' ? ' pulse' : ''}`} />
        <span className="runner-id">{runner.id}</span>
        <h2 className="runner-name">{runner.name}</h2>
        <span className={`chip tone-${tone}`}>{RUNNER_STATE_LABELS[runner.state]}</span>
      </header>
      {why ? <p className="runner-why">{why}</p> : null}
      {accepting ? <p className="runner-why warn-text">It {accepting}</p> : null}
      <dl className="facts">
        <Fact label="Owner">{runner.owner}</Fact>
        <Fact label="Slots">{slotsText(runner)}</Fact>
        <Fact label="Power">{powerText(runner.power)}</Fact>
        <Fact label="Disk">{diskText(runner.disk)}</Fact>
        <Fact label="Keep-awake">{KEEP_AWAKE_LABELS[runner.keepAwake]}</Fact>
        <Fact label="Git">{gitText(runner.git, now)}</Fact>
      </dl>
      <ul className="profile">
        {profileLines(runner.profile).map((line) => (
          <li key={line.text} className={`tone-${line.tone}`}>
            {line.text}
          </li>
        ))}
      </ul>
      {runner.vendors.map((vendor) => (
        <VendorPanel key={vendor.vendor} runner={runner} vendor={vendor} accounts={accounts} now={now} />
      ))}
      {owner ? <OwnerControls runner={runner} onChanged={onChanged} /> : null}
    </article>
  );
}

/** A window over its ceiling waits for its reset; an unknown one is greyed. */
const meterTone = (meter: QuotaMeter) => (meter.over ? 'wait' : meter.used === null ? 'closed' : 'done');

function VendorPanel({
  runner,
  vendor,
  accounts,
  now,
}: {
  runner: Runner;
  vendor: RunnerVendor;
  accounts: AccountQuota[];
  now: number;
}) {
  const account = accountOf(runner, vendor, accounts);
  const view = vendorView(vendor, account);
  const quota = quotaMeters(vendor, account, now);
  const notes = [view.managed, view.degraded, view.ownerAway].filter((note): note is string => note !== null);
  return (
    <section className="vendor">
      <header className="vendor-head">
        <h3 className="vendor-name">{view.name}</h3>
        <span className={`chip tone-${view.tone}`}>{view.status}</span>
      </header>
      <p className="vendor-meta">
        Version <span className="mono">{view.version}</span>
        {view.plan ? ` · ${view.plan}` : null}
      </p>
      {notes.map((note) => (
        <p key={note} className="vendor-note warn-text">
          {note}
        </p>
      ))}
      <div className="meters">
        {quota.meters.map((meter) => (
          <Meter
            key={meter.window}
            label={meter.label}
            value={meter.used}
            mark={meter.ceiling}
            tone={meterTone(meter)}
            text={meter.text}
          />
        ))}
      </div>
      <p className="quota-line">
        <span className={`lamp tone-${quota.tone}`} />
        {quota.line}
      </p>
      <p className="vendor-meta">{paidUsageText(vendor, account, now)}</p>
    </section>
  );
}

/** The owner's controls: the settings form, drain or undrain, and retire, each asking the hub (design 6.16). */
function OwnerControls({ runner, onChanged }: { runner: Runner; onChanged: () => void }) {
  const [open, setOpen] = useState<'settings' | 'retire' | null>(null);
  const action = useAction();
  const drain = async () => {
    if ((await action.run(() => api.updateRunner(runner.id, { draining: !runner.draining }))).ok) onChanged();
  };
  const toggle = (form: 'settings' | 'retire') => {
    action.clearError();
    setOpen(open === form ? null : form);
  };
  return (
    <footer className="runner-actions">
      <div className="actions">
        <button aria-expanded={open === 'settings'} onClick={() => toggle('settings')}>
          Settings
        </button>
        <button disabled={action.busy} onClick={() => void drain()}>
          {runner.draining ? 'Undrain' : 'Drain'}
        </button>
        <button className="danger" aria-expanded={open === 'retire'} onClick={() => toggle('retire')}>
          Retire
        </button>
      </div>
      {action.error ? <p className="error">{action.error}</p> : null}
      {open === 'settings' ? (
        <SettingsForm
          runner={runner}
          onDone={(saved) => {
            setOpen(null);
            if (saved) onChanged();
          }}
        />
      ) : null}
      {open === 'retire' ? <RetireConfirm runner={runner} onKeep={() => setOpen(null)} onRetired={onChanged} /> : null}
    </footer>
  );
}

const PAID_USAGE_WARNING =
  "Paid usage spends money: past the plan's limits, agents on this runner keep working on usage billed to the account";

function SettingsForm({ runner, onDone }: { runner: Runner; onDone: (saved: boolean) => void }) {
  // The settings as the form opened; only what the person changes is sent, whatever reloads meanwhile.
  const [base] = useState(runner);
  const [draft, setDraft] = useState<SettingsDraft>(() => draftFromRunner(runner));
  const action = useAction();
  const problem = settingsProblem(draft);
  const patch = problem === null ? settingsPatch(base, draft) : null;
  const vendorField = (index: number, change: Partial<SettingsDraft['vendors'][number]>) =>
    setDraft({
      ...draft,
      vendors: draft.vendors.map((entry, at) => (at === index ? { ...entry, ...change } : entry)),
    });

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!patch || action.busy) return;
    if ((await action.run(() => api.updateRunner(runner.id, patch))).ok) onDone(true);
  };

  return (
    <form className="runner-settings" onSubmit={save} noValidate>
      <div className="form-grid">
        <Field label="Capacity" note="agents at once, 1 to 16">
          <input
            type="number"
            min={1}
            max={16}
            step={1}
            value={draft.capacity}
            onChange={(event) => setDraft({ ...draft, capacity: event.target.value })}
          />
        </Field>
        <Field label="Keep-awake">
          <select
            value={draft.keepAwake}
            onChange={(event) => setDraft({ ...draft, keepAwake: event.target.value as SettingsDraft['keepAwake'] })}
          >
            {Object.entries(KEEP_AWAKE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <label className="check">
        <input
          type="checkbox"
          checked={draft.draining}
          onChange={(event) => setDraft({ ...draft, draining: event.target.checked })}
        />
        Draining: it finishes its work but starts nothing new
      </label>
      {draft.vendors.map((entry, index) => (
        <fieldset key={entry.vendor} className="vendor-settings">
          <legend>{VENDOR_NAMES[entry.vendor]}</legend>
          <div className="form-grid">
            <Field label="5-hour ceiling" note="%">
              <input
                type="number"
                min={0}
                max={100}
                value={entry.fiveHour}
                onChange={(event) => vendorField(index, { fiveHour: event.target.value })}
              />
            </Field>
            <Field label="Weekly ceiling" note="%">
              <input
                type="number"
                min={0}
                max={100}
                value={entry.weekly}
                onChange={(event) => vendorField(index, { weekly: event.target.value })}
              />
            </Field>
          </div>
          <label className="check">
            <input
              type="checkbox"
              checked={entry.allowPaidUsage}
              onChange={(event) => vendorField(index, { allowPaidUsage: event.target.checked })}
            />
            Allow paid usage
          </label>
          {entry.allowPaidUsage ? <p className="warn-text">{PAID_USAGE_WARNING}</p> : null}
        </fieldset>
      ))}
      <p className="hint">
        Above a ceiling, the vendor gets no new attempts on this runner, and the rest of the account stays for the
        owner. A ceiling of 0% keeps the vendor off this runner.
      </p>
      {problem ? <p className="error">{problem}</p> : null}
      <div className="row">
        <button className="primary" disabled={patch === null || action.busy}>
          Save settings
        </button>
        <button type="button" onClick={() => onDone(false)}>
          Never mind
        </button>
      </div>
      {action.error ? <p className="error">{action.error}</p> : null}
    </form>
  );
}

/** Retiring is for good, so it says what happens first (design 6.16's DELETE /api/runners/:id). */
function RetireConfirm({ runner, onKeep, onRetired }: { runner: Runner; onKeep: () => void; onRetired: () => void }) {
  const action = useAction();
  const retire = async () => {
    if ((await action.run(() => api.retireRunner(runner.id))).ok) onRetired();
  };
  return (
    <div className="retire-confirm" role="group" aria-label={`Retire ${runner.id}`}>
      <p>
        Retiring {runner.id} removes it from this hub for good. Its open attempts end lost: the tasks they held go back
        to ready, and submitted tasks keep their status. To use this laptop again, run <code>agflow runner setup</code>{' '}
        on it.
      </p>
      <div className="row">
        <button className="danger solid" disabled={action.busy} onClick={() => void retire()}>
          Retire {runner.id}
        </button>
        <button onClick={onKeep}>Keep it</button>
      </div>
      {action.error ? <p className="error">{action.error}</p> : null}
    </div>
  );
}
