import type { AccountLoad, HubLoad } from '@agflow/core';
import { Empty, ErrorBox, Fact, Loading, PageHead, Section } from '../components';
import { useHub } from '../hub';
import {
  accountName,
  accountStateText,
  accountTone,
  deadlineText,
  overCeiling,
  queueText,
  resetText,
  slotText,
  slotsText,
  windowText,
  workersText,
} from '../load';
import { clockTime } from '../runners';

/** How busy each account and the project are, and where work waits: the numbers a run is steered by. */
export function LoadView() {
  const { load } = useHub();
  if (!load.data) return load.error ? <ErrorBox error={load.error} onRetry={load.reload} /> : <Loading />;
  const { accounts, project, now } = load.data;
  return (
    <div className="page">
      <PageHead title="Load" meta={`As of ${clockTime(now, now)}; it reloads as work moves and every 30 seconds`} />
      <Section title="Accounts">
        {accounts.length === 0 ? (
          <Empty title="No runner reports an account yet">Accounts show up once a runner connects.</Empty>
        ) : (
          <div className="table-card">
            <table>
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Slots taken</th>
                  <th>5-hour window</th>
                  <th>Weekly window</th>
                  <th>Resets</th>
                  <th>State</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((account) => (
                  <AccountRow key={`${account.owner} ${account.vendor} ${account.accountId}`} account={account} now={now} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      <ProjectSection load={load.data} />
    </div>
  );
}

function AccountRow({ account, now }: { account: AccountLoad; now: number }) {
  const tone = accountTone(account.state);
  const quota = (used: number | null, ceiling: number) => (
    <span className={overCeiling(used, ceiling) ? 'warn-text' : undefined}>{windowText(used, ceiling)}</span>
  );
  return (
    <tr>
      <td>{accountName(account)}</td>
      <td className="mono">{slotText(account)}</td>
      <td>{quota(account.fiveHour, account.ceilings.fiveHour)}</td>
      <td>{quota(account.weekly, account.ceilings.weekly)}</td>
      <td>{resetText(account.resetsAt, now)}</td>
      <td>
        <span className={`chip tone-${tone}`}>{accountStateText(account.state)}</span>
      </td>
    </tr>
  );
}

function ProjectSection({ load }: { load: HubLoad }) {
  const { project, now } = load;
  const { tasks } = project;
  return (
    <Section title="Project">
      <dl className="facts">
        <Fact label="Workers">{workersText(project.workers)}</Fact>
        <Fact label="Runner slots">{slotsText(project.slots)}</Fact>
        <Fact label="Idle slot minutes, last hour">{project.idleSlotMinutes}</Fact>
        <Fact label="Ready">{`${tasks.ready}, ${tasks.dispatchable} of them can start now`}</Fact>
        <Fact label="Waiting on dependencies">{tasks.blockedOnDependencies}</Fact>
        <Fact label="Submitted">{queueText(tasks.submitted)}</Fact>
        <Fact label="Accepted, not merged">{queueText(tasks.acceptedNotMerged)}</Fact>
        <Fact label="Merged in the last hour">{tasks.mergedLastHour}</Fact>
        <Fact label="Deadline">{deadlineText(project.deadline, now)}</Fact>
      </dl>
      <p className="hint">
        A ready task that does not start says why on its board card. Runner slots count the runners that can take a
        worker, and a lead takes none. Idle slot minutes count their free slots after each scheduler tick, since the
        hub started. Accepted, not merged includes the tasks agflow is merging.
      </p>
    </Section>
  );
}
