import type { AccountQuota, Runner, RunnerVendor } from '@agflow/core';
import { Empty, ErrorBox, Fact, Loading, Meter, PageHead } from '../components';
import { useNow } from '../hooks';
import { useHub } from '../hub';
import {
  KEEP_AWAKE_LABELS,
  type QuotaMeter,
  RUNNER_STATE_LABELS,
  acceptingText,
  accountOf,
  diskText,
  gitText,
  paidUsageText,
  powerText,
  profileLines,
  quotaMeters,
  runnerTone,
  runnerWhy,
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
            <RunnerCard key={runner.id} runner={runner} accounts={accounts} now={now} />
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

function RunnerCard({ runner, accounts, now }: { runner: Runner; accounts: AccountQuota[]; now: number }) {
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
