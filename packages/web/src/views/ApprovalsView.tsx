import type { Approval, DiffLine, Runner } from '@agflow/core';
import { api } from '../api';
import { ConfirmButton, DiffView, Empty, ErrorBox, Fact, Linked, Loading, PageHead } from '../components';
import { useAction, useNow } from '../hooks';
import { useHub } from '../hub';
import {
  APPROVAL_KIND_LABELS,
  approvalPlace,
  approvalWarnings,
  parseUnifiedDiff,
  revealHidden,
  sortApprovals,
  timeLeft,
} from '../approvals';

/** Design 11's Approvals page: the signed-in person's pending requests, the soonest to expire first. */
export function ApprovalsView() {
  const { approvals, runners } = useHub();
  const now = useNow();
  if (!approvals.data) return approvals.error ? <ErrorBox error={approvals.error} onRetry={approvals.reload} /> : <Loading />;
  const list = sortApprovals(approvals.data);
  const runnerList = runners.data?.runners ?? [];

  return (
    <div className="page">
      <PageHead
        title="Approvals"
        meta={list.length === 0 ? 'Nothing waiting' : `${list.length} waiting for you · declining is the safe default`}
      />
      {list.length === 0 ? (
        <Empty title="No approvals waiting">
          When a Codex agent on one of your runners asks to run a command outside its sandbox, to write outside its
          clone, or for more permissions, the request comes here, and only you can answer it. A request nobody answers
          is declined when its time runs out.
        </Empty>
      ) : (
        <div className="approval-list">
          {list.map((approval) => (
            <ApprovalCard
              key={approval.id}
              approval={approval}
              runners={runnerList}
              now={now}
              onDecided={approvals.reload}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** The lines of a diff, with hidden characters made visible. */
const revealedDiff = (diff: string): DiffLine[] =>
  parseUnifiedDiff(diff).map((line) => ({ ...line, text: revealHidden(line.text) }));

function ApprovalCard({
  approval,
  runners,
  now,
  onDecided,
}: {
  approval: Approval;
  runners: Pick<Runner, 'id' | 'name'>[];
  now: number;
  onDecided: () => void;
}) {
  const action = useAction();
  const { command, cwd, reason, diff, manifestDiff } = approval.detail;
  const left = timeLeft(approval, now);
  const decline = async () => {
    if ((await action.run(() => api.decideApproval(approval.id, 'decline'))).ok) onDecided();
  };
  const approve = async () => {
    await api.decideApproval(approval.id, 'approve');
    onDecided();
  };
  return (
    <article className="card approval-card">
      <header className="approval-head">
        <span className="chip tone-wait">{APPROVAL_KIND_LABELS[approval.kind]}</span>
        <h2 className="approval-summary">{revealHidden(approval.summary)}</h2>
        <span className={`approval-left${left === 'expired' ? ' error' : ''}`}>{left}</span>
      </header>
      <p className="approval-place">
        <Linked text={approvalPlace(approval, runners)} />
      </p>
      {command !== undefined ? <pre className="approval-command">{revealHidden(command)}</pre> : null}
      <dl className="facts">
        {cwd !== undefined ? (
          <Fact label="Working directory">
            <span className="mono">{revealHidden(cwd)}</span>
          </Fact>
        ) : null}
        {reason !== undefined ? <Fact label="The agent's reason">{revealHidden(reason)}</Fact> : null}
      </dl>
      {/* The grant root inside a warning is the agent's text, so it is revealed like the rest of the card. */}
      <ul className="approval-warnings">
        {approvalWarnings(approval).map((warning) => (
          <li key={warning}>{revealHidden(warning)}</li>
        ))}
      </ul>
      {manifestDiff ? (
        <section className="approval-diff">
          <h3>Package files against the attempt's start</h3>
          <DiffView lines={revealedDiff(manifestDiff)} />
        </section>
      ) : null}
      {diff ? (
        <section className="approval-diff">
          <h3>The change</h3>
          <DiffView lines={revealedDiff(diff)} />
        </section>
      ) : null}
      <footer className="approval-actions">
        {/* Decline is the default, as an expiry is (design 6.10); approving lifts the sandbox, so it asks again. */}
        <button className="primary" disabled={action.busy} onClick={() => void decline()}>
          Decline
        </button>
        <ConfirmButton label="Approve…" confirm="Approve and let it run" onConfirm={approve} danger />
        {action.error ? <span className="error">{action.error}</span> : null}
      </footer>
    </article>
  );
}
